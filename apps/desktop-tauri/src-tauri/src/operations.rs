//! Queued operations: metadata writes against IMAP and sends against SMTP.
//!
//! Admission already applied metadata changes to the mirror and froze the draft
//! of a send, so this executor only owes the outside world the matching command.
//! A transient failure is retried a few times; a permanent one reverts the
//! optimistic write and fails the operation. Messages without a server
//! coordinate (the seeded demo profile) are local-only and succeed without a
//! round trip.

use std::time::Duration;

use mail_imap::{Credentials, ImapError, Role, WriteTarget};
use mail_smtp::SmtpError;
use mail_store::{
    MailStore, MetadataChange, OperationIntent, PendingOperation, RemoteMessage, SendIntent,
};
use mail_vault::CredentialVault;
use tauri::{AppHandle, Manager};

use crate::state::{AppState, LocalAccount};

const MAX_ATTEMPTS: i64 = 3;
/// Delay before attempt two and three.
const BACKOFF_MS: [i64; 2] = [2_000, 10_000];

pub fn spawn(app: AppHandle, account_id: String) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        run(&app, &state, &account_id).await;
    });
}

/// Replays commands left pending by an earlier run.
pub fn resume(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let account_ids: Vec<String> = match state.settings.lock() {
            Ok(settings) => settings
                .accounts
                .iter()
                .map(|account| account.id.clone())
                .collect(),
            Err(_) => return,
        };
        for account_id in account_ids {
            match lock_store(&state).and_then(|mut store| {
                store
                    .requeue_interrupted(&account_id)
                    .map_err(|error| error.to_string())
            }) {
                Ok(0) => {}
                Ok(_) => crate::push_snapshots(&app, &state),
                Err(message) => {
                    eprintln!("OneMail could not requeue interrupted operations: {message}")
                }
            }
            reconcile_uncertain(&app, &state, &account_id).await;
            run(&app, &state, &account_id).await;
        }
    });
}

/// A send may have reached the server before the client recorded the result.
/// If its deterministic Message-ID is already in Sent, treat it as delivered.
async fn reconcile_uncertain(app: &AppHandle, state: &AppState, account_id: &str) {
    let command_ids = match lock_store(state).and_then(|store| {
        store
            .uncertain_send_ids(account_id)
            .map_err(|error| error.to_string())
    }) {
        Ok(command_ids) => command_ids,
        Err(message) => {
            eprintln!("OneMail could not read uncertain sends: {message}");
            return;
        }
    };
    if command_ids.is_empty() {
        return;
    }
    let Some(account) = crate::sync::account(state, account_id) else {
        return;
    };
    let password = match state.vault.load(account_id) {
        Ok(Some(password)) => password,
        _ => return,
    };
    let credentials = crate::sync::credentials_for(&account, &password);

    let mut resolved = Vec::new();
    for command_id in command_ids {
        let message_id = mail_smtp::message_id(account_id, &command_id);
        match mail_imap::find_in_role(&credentials, Role::Sent, &message_id).await {
            Ok(true) => resolved.push(command_id),
            Ok(false) => {}
            Err(error) => {
                eprintln!("OneMail could not inspect an uncertain send: {error}");
                break;
            }
        }
    }
    if resolved.is_empty() {
        return;
    }
    let result = lock_store(state).and_then(|mut store| {
        for command_id in &resolved {
            store
                .succeed_operation(account_id, command_id)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    });
    match result {
        Ok(()) => crate::push_snapshots(app, state),
        Err(message) => eprintln!("OneMail could not settle an uncertain send: {message}"),
    }
}

async fn run(app: &AppHandle, state: &AppState, account_id: &str) {
    let account = match crate::sync::account(state, account_id) {
        Some(account) => account,
        None => return,
    };
    let password = match state.vault.load(account_id) {
        Ok(Some(password)) => password,
        Ok(None) => return,
        Err(error) => {
            eprintln!("OneMail could not read the mailbox credential: {error}");
            return;
        }
    };
    let credentials = crate::sync::credentials_for(&account, &password);

    loop {
        let operation = match next_pending(state, account_id) {
            Ok(Some(operation)) => operation,
            Ok(None) => break,
            Err(message) => {
                eprintln!("OneMail could not read pending operations: {message}");
                break;
            }
        };
        if operation.attempts >= MAX_ATTEMPTS {
            if let Err(message) = conclude(
                app,
                state,
                account_id,
                &operation.command_id,
                Err(("attempts", false)),
            ) {
                eprintln!("OneMail could not fail an operation: {message}");
            }
            continue;
        }
        if let Some(next) = operation.next_attempt_at_ms {
            let wait = next - now_ms();
            if wait > 0 {
                tokio::time::sleep(Duration::from_millis(wait as u64)).await;
            }
        }
        execute(app, state, account_id, &account, &credentials, operation).await;
    }
}

fn next_pending(state: &AppState, account_id: &str) -> Result<Option<PendingOperation>, String> {
    let store = lock_store(state)?;
    Ok(store
        .pending_operations(account_id)
        .map_err(|error| error.to_string())?
        .into_iter()
        .next())
}

async fn execute(
    app: &AppHandle,
    state: &AppState,
    account_id: &str,
    account: &LocalAccount,
    credentials: &Credentials,
    operation: PendingOperation,
) {
    let targets = match &operation.intent {
        OperationIntent::Metadata(_) => {
            match load_targets(state, account_id, &operation.command_id) {
                Ok(targets) => targets,
                Err(message) => {
                    eprintln!("OneMail could not load operation targets: {message}");
                    return;
                }
            }
        }
        OperationIntent::Send(_) => Vec::new(),
    };

    let claimed = match lock_store(state).and_then(|mut store| {
        store
            .begin_operation(account_id, &operation.command_id)
            .map_err(|error| error.to_string())
    }) {
        Ok(claimed) => claimed,
        Err(message) => {
            eprintln!("OneMail could not claim an operation: {message}");
            return;
        }
    };
    if !claimed {
        return;
    }

    let result = match &operation.intent {
        OperationIntent::Metadata(change) => perform(credentials, change, &targets)
            .await
            .map(|moved| (moved, false)),
        OperationIntent::Send(intent) => perform_send(
            account,
            credentials,
            intent,
            operation.created_at_ms,
            account_id,
            &operation.command_id,
        )
        .await
        .map(|rejected| (Vec::new(), !rejected.is_empty())),
    };

    match result {
        Ok((moved, uncertain)) if !uncertain => {
            if let Err(message) = finish_success(state, account_id, &operation.command_id, moved) {
                eprintln!("OneMail could not record an operation: {message}");
            }
        }
        Ok(_) => {
            if let Err(message) = lock_store(state).and_then(|mut store| {
                store
                    .uncertain_operation(account_id, &operation.command_id, "recipients")
                    .map_err(|error| error.to_string())
            }) {
                eprintln!("OneMail could not record an uncertain send: {message}");
            }
        }
        Err(error) => record_failure(app, state, account_id, &operation, error),
    }
    crate::push_snapshots(app, state);
}

fn load_targets(
    state: &AppState,
    account_id: &str,
    command_id: &str,
) -> Result<Vec<(String, Option<RemoteMessage>)>, String> {
    let store = lock_store(state)?;
    let targets = store
        .operation_targets(account_id, command_id)
        .map_err(|error| error.to_string())?;
    targets
        .into_iter()
        .map(|target| {
            let remote = store
                .remote_message(account_id, &target.message_id)
                .map_err(|error| error.to_string())?;
            Ok((target.message_id, remote))
        })
        .collect()
}

fn record_failure(
    app: &AppHandle,
    state: &AppState,
    account_id: &str,
    operation: &PendingOperation,
    error: PerformError,
) {
    let failure = classify(error);
    let next_attempt = operation.attempts + 1;
    let outcome = if failure.uncertain {
        lock_store(state).and_then(|mut store| {
            store
                .uncertain_operation(account_id, &operation.command_id, failure.code)
                .map_err(|error| error.to_string())
        })
    } else if failure.retryable && next_attempt < MAX_ATTEMPTS {
        let delay = BACKOFF_MS[(operation.attempts.max(0) as usize).min(BACKOFF_MS.len() - 1)];
        lock_store(state).and_then(|mut store| {
            store
                .retry_operation(
                    account_id,
                    &operation.command_id,
                    failure.code,
                    now_ms() + delay,
                )
                .map_err(|error| error.to_string())
        })
    } else {
        conclude(
            app,
            state,
            account_id,
            &operation.command_id,
            Err((failure.code, failure.retryable)),
        )
    };
    if let Err(message) = outcome {
        eprintln!("OneMail could not record an operation failure: {message}");
    }
}

/// A completed move leaves the message with a new server coordinate; every
/// other change leaves existing coordinates alone.
fn finish_success(
    state: &AppState,
    account_id: &str,
    command_id: &str,
    moved: Vec<(String, Option<RemoteMessage>)>,
) -> Result<(), String> {
    let mut store = lock_store(state)?;
    store
        .succeed_operation(account_id, command_id)
        .map_err(|error| error.to_string())?;
    for (message_id, remote) in moved {
        store
            .set_remote(account_id, &message_id, remote.as_ref())
            .map_err(|error| error.to_string())?;
        if let Some(remote) = remote {
            store
                .relocate_message(account_id, &message_id, &remote.folder)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn conclude(
    app: &AppHandle,
    state: &AppState,
    account_id: &str,
    command_id: &str,
    outcome: Result<(), (&'static str, bool)>,
) -> Result<(), String> {
    let result = lock_store(state).and_then(|mut store| {
        match outcome {
            Ok(()) => store.succeed_operation(account_id, command_id),
            Err((code, retryable)) => store.fail_operation(account_id, command_id, code, retryable),
        }
        .map_err(|error| error.to_string())
    });
    if result.is_ok() {
        crate::push_snapshots(app, state);
    }
    result
}

enum PerformError {
    Imap(ImapError),
    Smtp(SmtpError),
    NoDestination(Role),
    NoFolder(String),
}

#[derive(Debug, PartialEq, Eq)]
struct Failure {
    code: &'static str,
    retryable: bool,
    uncertain: bool,
}

fn classify(error: PerformError) -> Failure {
    let (code, retryable, uncertain) = match error {
        PerformError::NoDestination(Role::Archive) => ("no_archive", false, false),
        PerformError::NoDestination(Role::Trash) => ("no_trash", false, false),
        PerformError::NoDestination(_) => ("no_destination", false, false),
        PerformError::NoFolder(folder) => {
            eprintln!("OneMail could not find the move destination {folder}");
            ("no_destination", false, false)
        }
        PerformError::Imap(ImapError::Login(_)) => ("auth", false, false),
        PerformError::Imap(ImapError::Tls(_)) => ("tls", false, false),
        PerformError::Imap(ImapError::Config(_)) => ("config", false, false),
        PerformError::Imap(_) => ("network", true, false),
        PerformError::Smtp(SmtpError::Login(_)) => ("auth", false, false),
        PerformError::Smtp(SmtpError::Tls(_)) => ("tls", false, false),
        PerformError::Smtp(SmtpError::Config(_)) => ("config", false, false),
        PerformError::Smtp(SmtpError::Rejected(_)) => ("smtp", false, false),
        PerformError::Smtp(SmtpError::Connect { .. }) => ("network", true, false),
        PerformError::Smtp(SmtpError::Timeout(_)) => ("network", true, false),
        PerformError::Smtp(SmtpError::Network(_)) => ("network", true, false),
        PerformError::Smtp(SmtpError::Uncertain(_)) => ("uncertain", false, true),
    };
    Failure {
        code,
        retryable,
        uncertain,
    }
}

async fn perform_send(
    account: &LocalAccount,
    credentials: &Credentials,
    intent: &SendIntent,
    queued_at_ms: i64,
    account_id: &str,
    command_id: &str,
) -> Result<Vec<String>, PerformError> {
    let html = format!("{}{}", intent.html, intent.quoted_html);
    let message_id = mail_smtp::message_id(account_id, command_id);
    let message = mail_smtp::Message {
        from: intent.from.as_deref().unwrap_or(&account.email),
        from_name: &account.name,
        to: &intent.to,
        cc: &intent.cc,
        bcc: &intent.bcc,
        subject: &intent.subject,
        html: &html,
        message_id: &message_id,
        date_ms: queued_at_ms,
    };
    let smtp = crate::sync::smtp_credentials_for(account, &credentials.password);
    let sent = mail_smtp::send(&smtp, &message)
        .await
        .map_err(PerformError::Smtp)?;
    // SMTP acceptance is final; a missing or refused Sent folder must not turn a
    // delivered message into a failed operation.
    if let Err(error) = mail_imap::append_to_role(credentials, Role::Sent, &sent.raw).await {
        eprintln!("OneMail sent a message but could not save the Sent copy: {error}");
    }
    Ok(sent.rejected)
}

async fn perform(
    credentials: &Credentials,
    change: &MetadataChange,
    targets: &[(String, Option<RemoteMessage>)],
) -> Result<Vec<(String, Option<RemoteMessage>)>, PerformError> {
    let remote_targets: Vec<WriteTarget> = targets
        .iter()
        .filter_map(|(message_id, remote)| {
            remote.as_ref().map(|remote| WriteTarget {
                message_id: message_id.clone(),
                folder: remote.folder.clone(),
                uid_validity: remote.uid_validity,
                uid: remote.uid,
            })
        })
        .collect();
    if remote_targets.is_empty() {
        return Ok(Vec::new());
    }

    match change {
        MetadataChange::SetRead(read) => {
            let (add, remove): (&[&str], &[&str]) = if *read {
                (&["\\Seen"], &[])
            } else {
                (&[], &["\\Seen"])
            };
            flags(credentials, &remote_targets, add, remove).await?;
            Ok(Vec::new())
        }
        MetadataChange::SetStarred(starred) => {
            let (add, remove): (&[&str], &[&str]) = if *starred {
                (&["\\Flagged"], &[])
            } else {
                (&[], &["\\Flagged"])
            };
            flags(credentials, &remote_targets, add, remove).await?;
            Ok(Vec::new())
        }
        MetadataChange::Archive
        | MetadataChange::Unarchive
        | MetadataChange::Trash
        | MetadataChange::RestoreFromTrash => {
            let role = match change {
                MetadataChange::Archive => Role::Archive,
                MetadataChange::Trash => Role::Trash,
                _ => Role::Inbox,
            };
            move_to_role(credentials, &remote_targets, role).await
        }
        MetadataChange::SetSpam(spam) => {
            let role = if *spam { Role::Spam } else { Role::Inbox };
            move_to_role(credentials, &remote_targets, role).await
        }
        MetadataChange::Move(folder_id) => {
            let login = mail_imap::verify(credentials)
                .await
                .map_err(PerformError::Imap)?;
            if !login.folders.iter().any(|folder| &folder.path == folder_id) {
                return Err(PerformError::NoFolder(folder_id.clone()));
            }
            move_to(credentials, &remote_targets, folder_id).await
        }
    }
}

async fn move_to_role(
    credentials: &Credentials,
    targets: &[WriteTarget],
    role: Role,
) -> Result<Vec<(String, Option<RemoteMessage>)>, PerformError> {
    let login = mail_imap::verify(credentials)
        .await
        .map_err(PerformError::Imap)?;
    let destination = login
        .folders
        .iter()
        .find(|folder| folder.role == Some(role))
        .map(|folder| folder.path.clone())
        .ok_or(PerformError::NoDestination(role))?;
    move_to(credentials, targets, &destination).await
}

async fn move_to(
    credentials: &Credentials,
    targets: &[WriteTarget],
    destination: &str,
) -> Result<Vec<(String, Option<RemoteMessage>)>, PerformError> {
    let moved = mail_imap::move_messages(credentials, targets, destination)
        .await
        .map_err(PerformError::Imap)?;
    Ok(moved
        .into_iter()
        .map(|moved| {
            let remote = (moved.uid > 0).then_some(RemoteMessage {
                folder: moved.folder,
                uid_validity: moved.uid_validity,
                uid: moved.uid,
            });
            (moved.message_id, remote)
        })
        .collect())
}

async fn flags(
    credentials: &Credentials,
    targets: &[WriteTarget],
    add: &[&str],
    remove: &[&str],
) -> Result<(), PerformError> {
    let mut groups: Vec<(String, u32, Vec<u32>)> = Vec::new();
    for target in targets {
        match groups
            .iter_mut()
            .find(|(folder, _, _)| folder == &target.folder)
        {
            Some((_, _, uids)) => uids.push(target.uid),
            None => groups.push((target.folder.clone(), target.uid_validity, vec![target.uid])),
        }
    }
    for (folder, uid_validity, uids) in groups {
        mail_imap::set_flags(credentials, &folder, uid_validity, &uids, add, remove)
            .await
            .map_err(PerformError::Imap)?;
    }
    Ok(())
}

fn lock_store(state: &AppState) -> Result<std::sync::MutexGuard<'_, MailStore>, String> {
    state
        .store
        .lock()
        .map_err(|_| "mail store lock poisoned".to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_classification_separates_retryable_from_permanent() {
        let retryable = |error| classify(PerformError::Imap(error));
        assert_eq!(
            retryable(ImapError::Timeout("x".to_string())),
            Failure {
                code: "network",
                retryable: true,
                uncertain: false,
            }
        );
        assert_eq!(
            retryable(ImapError::Protocol("x".to_string())),
            Failure {
                code: "network",
                retryable: true,
                uncertain: false,
            }
        );
        assert_eq!(
            retryable(ImapError::Login("x".to_string())),
            Failure {
                code: "auth",
                retryable: false,
                uncertain: false,
            }
        );
        assert_eq!(
            retryable(ImapError::Tls("x".to_string())),
            Failure {
                code: "tls",
                retryable: false,
                uncertain: false,
            }
        );
        assert_eq!(
            retryable(ImapError::Config("x".to_string())),
            Failure {
                code: "config",
                retryable: false,
                uncertain: false,
            }
        );
        assert_eq!(
            classify(PerformError::NoDestination(Role::Archive)),
            Failure {
                code: "no_archive",
                retryable: false,
                uncertain: false,
            }
        );
        assert_eq!(
            classify(PerformError::NoDestination(Role::Trash)),
            Failure {
                code: "no_trash",
                retryable: false,
                uncertain: false,
            }
        );
        assert_eq!(
            classify(PerformError::Smtp(SmtpError::Uncertain("x".to_string()))),
            Failure {
                code: "uncertain",
                retryable: false,
                uncertain: true,
            }
        );
        assert_eq!(
            classify(PerformError::Smtp(SmtpError::Rejected("x".to_string()))),
            Failure {
                code: "smtp",
                retryable: false,
                uncertain: false,
            }
        );
    }
}
