//! IMAP → SQLite mirror sync for the Rust shell.
//!
//! The network work happens without holding any lock; the mirror is only touched
//! once a page is in hand, and `push_snapshots` tells the renderer afterwards.

use std::time::Duration;

use mail_imap::{Credentials, Folder, Role, SyncPage};
use mail_store::{FolderRole, FolderSync, MailStore, MailboxFilter, SyncedMessage};
use mail_vault::CredentialVault;
use serde_json::json;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::state::{AppState, LocalAccount};

/// How many messages of each folder the mirror pages. Bodies and paging are later
/// slices; this is enough for a usable conversation list.
const PAGE_LIMIT: u32 = 50;

/// Folders the shell mirrors today. `fetch_folders` skips ones the server lacks.
/// Gmail's All Mail is classified as `AllMail`, not Archive, so it is never
/// mirrored and never used as an archive destination.
const SYNCED_ROLES: [Role; 6] = [
    Role::Inbox,
    Role::Sent,
    Role::Drafts,
    Role::Archive,
    Role::Trash,
    Role::Spam,
];

/// How often accounts are refreshed in the background. IDLE is used when the
/// server advertises it; polling is the fallback.
const SYNC_INTERVAL: Duration = Duration::from_secs(60);
/// How quickly the IDLE supervisor notices new or removed accounts.
const IDLE_SUPERVISOR: Duration = Duration::from_secs(30);
/// Delay before retrying a failed IDLE connection.
const IDLE_RETRY: Duration = Duration::from_secs(30);

pub(crate) fn credentials_for(account: &LocalAccount, password: &str) -> Credentials {
    Credentials {
        host: account.imap.host.clone(),
        port: account.imap.port,
        secure: account.imap.secure,
        username: account.username.clone(),
        password: password.to_string(),
    }
}

pub(crate) fn smtp_credentials_for(
    account: &LocalAccount,
    password: &str,
) -> mail_smtp::Credentials {
    mail_smtp::Credentials {
        host: account.smtp.host.clone(),
        port: account.smtp.port,
        secure: account.smtp.secure,
        username: account.username.clone(),
        password: password.to_string(),
    }
}

/// Reads the mirrored folders for one account. Errors are user-facing: they land in
/// the settings dialog.
pub async fn fetch_account(
    account: &LocalAccount,
    password: &str,
) -> Result<Vec<FolderSync>, String> {
    let pages = mail_imap::fetch_folders(
        &credentials_for(account, password),
        &SYNCED_ROLES,
        PAGE_LIMIT,
    )
    .await
    .map_err(sync_error)?;
    Ok(pages
        .into_iter()
        .map(|page| folder_sync(&page.folder, page.page))
        .collect())
}

pub fn apply_pages(
    store: &mut MailStore,
    account_id: &str,
    pages: &[FolderSync],
) -> Result<(), String> {
    store
        .register_account(account_id)
        .map_err(|error| error.to_string())?;
    for page in pages {
        store
            .apply_sync(account_id, page)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Syncs in the background and pushes fresh snapshots when the mirror changed.
/// Used for the launch sync, which must not notify about existing mail.
pub fn spawn(app: AppHandle, account_ids: Vec<String>) {
    spawn_inner(app, account_ids, false);
}

/// Syncs in response to an explicit refresh, notifying about new unread mail.
pub fn spawn_notify(app: AppHandle, account_ids: Vec<String>) {
    spawn_inner(app, account_ids, true);
}

fn spawn_inner(app: AppHandle, account_ids: Vec<String>, notify: bool) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let outcome = sync_accounts(&state, &account_ids, notify).await;
        if outcome.changed {
            crate::push_snapshots(&app, &state);
        }
        notify_new_mail(&app, &outcome.new_unread);
    });
}

/// Refreshes every configured account on a timer. The first tick is consumed so
/// the launch sync is not immediately repeated.
pub fn start_periodic(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(SYNC_INTERVAL);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let state = app.state::<AppState>();
            let outcome = sync_accounts(&state, &[], true).await;
            if outcome.changed {
                crate::push_snapshots(&app, &state);
            }
            notify_new_mail(&app, &outcome.new_unread);
        }
    });
}

/// Keeps one INBOX IDLE watcher per configured account. Servers without IDLE
/// are left to the periodic poll.
pub fn start_idle(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let accounts: Vec<LocalAccount> = {
                let state = app.state::<AppState>();
                let Ok(settings) = state.settings.lock() else {
                    tokio::time::sleep(IDLE_SUPERVISOR).await;
                    continue;
                };
                settings.accounts.clone()
            };
            for account in accounts {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    let Some(_claim) = state.claim_idle(&account.id) else {
                        return;
                    };
                    watch_inbox(&app, &state, &account).await;
                });
            }
            tokio::time::sleep(IDLE_SUPERVISOR).await;
        }
    });
}

async fn watch_inbox(app: &AppHandle, state: &AppState, account: &LocalAccount) {
    loop {
        if !is_configured(state, &account.id) {
            return;
        }
        let password = match state.vault.load(&account.id) {
            Ok(Some(password)) => password,
            _ => {
                tokio::time::sleep(IDLE_RETRY).await;
                continue;
            }
        };
        let credentials = credentials_for(account, &password);
        match mail_imap::wait_for_inbox_change(&credentials).await {
            Ok(true) => spawn_notify(app.clone(), vec![account.id.clone()]),
            Ok(false) => {}
            Err(mail_imap::ImapError::Config(_)) => {
                state.mark_idle_unsupported(&account.id);
                return;
            }
            Err(_) => tokio::time::sleep(IDLE_RETRY).await,
        }
    }
}

#[derive(Default)]
struct SyncOutcome {
    changed: bool,
    new_unread: Vec<(String, i64)>,
}

/// `account_ids` empty means every configured account. One failing account is
/// logged and left alone; the rest still sync.
async fn sync_accounts(state: &AppState, account_ids: &[String], notify: bool) -> SyncOutcome {
    let accounts: Vec<LocalAccount> = {
        let Ok(settings) = state.settings.lock() else {
            eprintln!("OneMail sync skipped: settings lock poisoned");
            return SyncOutcome::default();
        };
        settings
            .accounts
            .iter()
            .filter(|account| account_ids.is_empty() || account_ids.contains(&account.id))
            .cloned()
            .collect()
    };

    let mut outcome = SyncOutcome::default();
    for account in accounts {
        let Some(_claim) = state.claim_sync(&account.id) else {
            continue;
        };
        match sync_one(state, &account, notify).await {
            Ok((changed, new_unread)) => {
                outcome.changed |= changed;
                if new_unread > 0 {
                    outcome.new_unread.push((account.email.clone(), new_unread));
                }
            }
            Err(message) => eprintln!("OneMail could not sync {}: {message}", account.email),
        }
    }
    outcome
}

/// Returns whether the mirror changed and how many additional unread Inbox
/// messages appeared. Accounts without a stored credential are skipped, not
/// treated as failures.
async fn sync_one(
    state: &AppState,
    account: &LocalAccount,
    notify: bool,
) -> Result<(bool, i64), String> {
    let password = state
        .vault
        .load(&account.id)
        .map_err(|error| error.to_string())?;
    let Some(password) = password else {
        return Ok((false, 0));
    };

    let pages = fetch_account(account, &password).await?;

    // The account may have been removed while this sync was on the wire; a late
    // page must not resurrect its rows.
    if !is_configured(state, &account.id) {
        return Ok((false, 0));
    }

    let inbox = MailboxFilter::from_predicate(&json!({
        "kind": "mailbox",
        "mailbox": "inbox",
    }));
    let mut store = state
        .store
        .lock()
        .map_err(|_| "mail store lock poisoned".to_string())?;
    let before = if notify {
        store
            .counts(std::slice::from_ref(&account.id), &inbox)
            .map_err(|error| error.to_string())?
            .1
    } else {
        0
    };
    apply_pages(&mut store, &account.id, &pages)?;
    let after = if notify {
        store
            .counts(std::slice::from_ref(&account.id), &inbox)
            .map_err(|error| error.to_string())?
            .1
    } else {
        0
    };
    Ok((true, (after - before).max(0)))
}

fn notify_new_mail(app: &AppHandle, new_unread: &[(String, i64)]) {
    for (email, count) in new_unread {
        let body = if *count == 1 {
            format!("1 new message in {email}")
        } else {
            format!("{count} new messages in {email}")
        };
        if let Err(error) = app
            .notification()
            .builder()
            .title("New mail")
            .body(body)
            .show()
        {
            eprintln!("OneMail could not show a notification: {error}");
        }
    }
}

pub(crate) fn is_configured(state: &AppState, account_id: &str) -> bool {
    state
        .settings
        .lock()
        .map(|settings| {
            settings
                .accounts
                .iter()
                .any(|account| account.id == account_id)
        })
        .unwrap_or(false)
}

/// The configured account with this id, cloned so the caller can hold it across
/// a network round trip without the settings lock.
pub(crate) fn account(state: &AppState, account_id: &str) -> Option<LocalAccount> {
    state
        .settings
        .lock()
        .ok()?
        .accounts
        .iter()
        .find(|account| account.id == account_id)
        .cloned()
}

fn folder_sync(folder: &Folder, page: SyncPage) -> FolderSync {
    FolderSync {
        folder: folder.path.clone(),
        role: folder_role(folder.role),
        uid_validity: page.uid_validity,
        messages: page.messages.into_iter().map(message).collect(),
    }
}

fn message(message: mail_imap::Message) -> SyncedMessage {
    SyncedMessage {
        message_id: message.message_id,
        conversation_id: message.conversation_id,
        subject: message.subject,
        from_address: message.from_address,
        to_addresses: message.to_addresses,
        received_at_ms: message.received_at_ms,
        read: message.read,
        starred: message.starred,
        has_attachments: message.has_attachments,
        uid: message.uid,
    }
}

fn folder_role(role: Option<Role>) -> FolderRole {
    match role {
        Some(Role::Inbox) => FolderRole::Inbox,
        Some(Role::Sent) => FolderRole::Sent,
        Some(Role::Drafts) => FolderRole::Drafts,
        Some(Role::Trash) => FolderRole::Trash,
        Some(Role::Spam) => FolderRole::Spam,
        Some(Role::Archive) | Some(Role::AllMail) | None => FolderRole::Archive,
    }
}

fn sync_error(error: mail_imap::ImapError) -> String {
    use mail_imap::ImapError;
    match error {
        ImapError::Login(_) => {
            "The mail server rejected this username and password. Check the credential or use an app password."
                .to_string()
        }
        ImapError::Connect { .. } | ImapError::Timeout(_) => format!(
            "Could not reach the IMAP server. Check the host and port. ({error})"
        ),
        ImapError::Tls(_) => format!(
            "The IMAP server's TLS handshake failed. Check the port and TLS settings. ({error})"
        ),
        ImapError::Config(_) | ImapError::Protocol(_) => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mail_imap::Message;
    use mail_store::MailboxFilter;

    #[test]
    fn a_fetched_page_lands_in_the_mirror() {
        let path =
            std::env::temp_dir().join(format!("onemail-sync-{}.sqlite", uuid::Uuid::new_v4()));
        let mut store = MailStore::open(&path).expect("opens");
        let page = folder_sync(
            &Folder {
                path: "INBOX".to_string(),
                name: "Inbox".to_string(),
                role: Some(Role::Inbox),
            },
            SyncPage {
                uid_validity: 11,
                messages: vec![Message {
                    uid: 4,
                    message_id: "<hello@example.com>".to_string(),
                    conversation_id: "hello@example.com".to_string(),
                    subject: "Hello".to_string(),
                    from_address: "ana@example.com".to_string(),
                    from_name: Some("Ana".to_string()),
                    to_addresses: vec!["me@example.com".to_string()],
                    received_at_ms: 1_700_000_000_000,
                    read: false,
                    starred: true,
                    has_attachments: false,
                }],
            },
        );

        apply_pages(&mut store, "acc-1", &[page]).expect("applies");

        let ids = vec!["acc-1".to_string()];
        let filter = MailboxFilter::from_predicate(
            &serde_json::json!({ "kind": "mailbox", "mailbox": "inbox" }),
        );
        let conversations = store.conversations(&ids, &filter, 50).expect("reads");
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0].subject, "Hello");
        assert_eq!(conversations[0].from, "ana@example.com");
        assert!(conversations[0].unread);
        assert!(conversations[0].starred);
        drop(conversations);
        drop(store);
        let _ = std::fs::remove_file(path);
    }
}
