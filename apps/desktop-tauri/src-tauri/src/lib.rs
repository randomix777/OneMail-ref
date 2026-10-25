//! Tauri shell for OneMail.
//!
//! Responsibilities mirror `apps/desktop/src/main.ts` + `mail-engine/*`: own the
//! window, own the local profile, and answer the renderer's mail-engine IPC
//! contract. Everything the renderer needs travels through the same envelopes the
//! Electron utility process answered, so `@inboxzero/mail-core` is unchanged.

mod ai;
mod content;
mod operations;
mod state;
mod sync;

use std::sync::MutexGuard;

use mail_ipc::{
    failed, invalid, ok, unsupported, MailboxCountEntry, MailboxCounts, MailboxCountsView,
    MailboxView, Request, Snapshot,
};
use mail_store::{Admission, MailStore, MailboxFilter};
use mail_vault::CredentialVault;
use serde_json::{json, Value};
use state::{write_settings, AppState, LocalAccount, LocalSettings};
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Emitter, Manager, State};

fn lock_store(state: &AppState) -> Result<MutexGuard<'_, MailStore>, String> {
    state
        .store
        .lock()
        .map_err(|_| "mail store lock poisoned".to_string())
}

#[tauri::command]
fn desktop_health() -> Value {
    json!({ "status": "ok", "engine": "rust", "protocolVersion": mail_ipc::PROTOCOL_VERSION })
}

#[tauri::command]
fn local_settings(state: State<'_, AppState>) -> Value {
    settings_snapshot(&state)
}

fn settings_snapshot(state: &AppState) -> Value {
    let accounts = state
        .settings
        .lock()
        .map(|settings| settings.accounts.clone())
        .unwrap_or_default();
    serde_json::to_value(LocalSettings {
        accounts,
        ai: ai::summary(state),
    })
    .unwrap_or_else(|_| json!({ "accounts": [], "ai": null }))
}

/// What the settings form sends: no `id` on create, and the password that is
/// verified against IMAP before it goes into the OS keychain.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountInput {
    id: Option<String>,
    email: String,
    #[serde(default)]
    name: String,
    username: String,
    #[serde(default)]
    password: String,
    imap: state::Server,
    smtp: state::Server,
}

#[tauri::command]
async fn local_account_save(
    app: AppHandle,
    state: State<'_, AppState>,
    input: Value,
) -> Result<Value, String> {
    let input: AccountInput =
        serde_json::from_value(input).map_err(|error| format!("invalid account: {error}"))?;
    if input.email.trim().is_empty() {
        return Err("Enter an email address".to_string());
    }
    if input.password.is_empty() {
        return Err("Enter the mailbox password".to_string());
    }
    let account = LocalAccount {
        id: input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        email: input.email,
        name: input.name,
        username: input.username,
        imap: input.imap,
        smtp: input.smtp,
    };

    // Connect before touching the profile: a wrong password or host must never
    // replace an account that currently works. IMAP proves reading, SMTP proves
    // sending; the same credential is used for both.
    let pages = sync::fetch_account(&account, &input.password).await?;
    mail_smtp::verify(&sync::smtp_credentials_for(&account, &input.password))
        .await
        .map_err(|error| format!("SMTP check failed: {error}"))?;

    state
        .vault
        .store(&account.id, &input.password)
        .map_err(|error| error.to_string())?;

    let summary = {
        let mut settings = state
            .settings
            .lock()
            .map_err(|_| "settings lock poisoned".to_string())?;
        match settings
            .accounts
            .iter_mut()
            .find(|existing| existing.id == account.id)
        {
            Some(existing) => *existing = account.clone(),
            None => settings.accounts.push(account.clone()),
        }
        settings.ai = ai::summary(&state);
        write_settings(&state.paths.settings, &settings)?;
        LocalSettings {
            accounts: settings.accounts.clone(),
            ai: settings.ai.clone(),
        }
    };

    {
        let mut store = lock_store(&state)?;
        sync::apply_pages(&mut store, &account.id, &pages)?;
    }
    push_snapshots(&app, &state);
    // A credential was just stored: any command queued while it was missing can
    // now reach the server.
    operations::spawn(app.clone(), account.id.clone());

    serde_json::to_value(summary).map_err(|error| error.to_string())
}

#[tauri::command]
fn local_account_remove(state: State<'_, AppState>, id: String) -> Result<Value, String> {
    // Forget the secret first: if the keychain refuses, the account stays usable
    // instead of silently losing its credential.
    state.vault.forget(&id).map_err(|error| error.to_string())?;

    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned".to_string())?;
    settings.accounts.retain(|account| account.id != id);
    settings.ai = ai::summary(&state);
    write_settings(&state.paths.settings, &settings)?;
    lock_store(&state)?
        .forget_account(&id)
        .map_err(|error| error.to_string())?;
    serde_json::to_value(LocalSettings {
        accounts: settings.accounts.clone(),
        ai: settings.ai.clone(),
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn mail_engine(app: AppHandle, state: State<'_, AppState>, payload: Value) -> Value {
    let request = match Request::parse(&payload) {
        Ok(request) => request,
        Err(message) => return invalid(&message),
    };
    match request.method.as_str() {
        "observeMailbox"
        | "observeMailboxWindow"
        | "observeMailboxCounts"
        | "observeConversation"
        | "ensureMessageContent"
        | "requestSync"
        | "retainAccounts"
        | "purgeAccount"
        | "getDiagnostics"
        | "submitMetadata"
        | "submitConversations"
        | "saveDraft"
        | "readDraft"
        | "submitSend"
        | "observeOperation"
        | "cancelOperation" => dispatch(&app, &state, &request),
        other => unsupported(other),
    }
}

#[tauri::command]
fn mail_engine_subscribe(app: AppHandle, state: State<'_, AppState>, input: Value) -> Value {
    let subscription_id = input
        .get("subscriptionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let request = input.get("request").cloned().unwrap_or(Value::Null);
    if subscription_id.is_empty() || request.is_null() {
        return invalid("subscribe needs a subscriptionId and a request");
    }

    if let Ok(mut subscriptions) = state.subscriptions.lock() {
        subscriptions.insert(subscription_id.clone(), request.clone());
    }

    // The client routes the listener before it subscribes, so the first snapshot
    // can be pushed before this returns. Later changes push on the same channel.
    let response = dispatch(&app, &state, &request_envelope(&subscription_id, &request));
    if response.get("status").and_then(Value::as_str) == Some("ok") {
        let snapshot = response.get("result").cloned().unwrap_or(Value::Null);
        let _ = app.emit(
            "mail-engine-snapshot",
            json!({ "subscriptionId": subscription_id, "snapshot": snapshot }),
        );
    }
    ok(Value::Null)
}

#[tauri::command]
fn mail_engine_unsubscribe(state: State<'_, AppState>, subscription_id: String) -> Value {
    if let Ok(mut subscriptions) = state.subscriptions.lock() {
        subscriptions.remove(&subscription_id);
    }
    ok(Value::Null)
}

#[tauri::command]
async fn read_attachment(state: State<'_, AppState>, input: Value) -> Result<Vec<u8>, String> {
    content::read_attachment(state.inner(), &input).await
}

#[tauri::command]
fn wipe_mailbox() -> Result<Value, String> {
    Err("Wiping the local mirror is not ported to the Rust engine yet".to_string())
}

#[tauri::command]
async fn local_ai_connect(state: State<'_, AppState>) -> Result<Value, String> {
    ai::connect(&state).await?;
    Ok(settings_snapshot(&state))
}

#[tauri::command]
async fn local_ai_refresh(state: State<'_, AppState>) -> Result<Value, String> {
    ai::refresh(&state).await?;
    Ok(settings_snapshot(&state))
}

#[tauri::command]
async fn local_ai_disconnect(state: State<'_, AppState>) -> Result<Value, String> {
    ai::disconnect(&state).await?;
    Ok(settings_snapshot(&state))
}

#[tauri::command]
async fn local_ai_models(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    ai::models(&state).await
}

#[tauri::command]
async fn local_ai_analyze(state: State<'_, AppState>, input: Value) -> Result<String, String> {
    ai::analyze(&state, input).await
}

fn dispatch(app: &AppHandle, state: &AppState, request: &Request) -> Value {
    match request.method.as_str() {
        "observeMailbox" => {
            let account_ids = string_array(request.payload.get("accountIds"));
            let filter = MailboxFilter::from_predicate(&request.payload["predicate"]);
            let page_size = request.payload["pageSize"].as_i64().unwrap_or(50);
            mailbox_snapshot(state, &account_ids, &filter, page_size)
        }
        "observeMailboxWindow" => {
            let query = &request.payload["query"];
            let account_ids = string_array(query.get("accountIds"));
            let filter = MailboxFilter::from_predicate(&query["predicate"]);
            let page_size = query["pageSize"].as_i64().unwrap_or(50);
            let page_count = request.payload["pageCount"].as_i64().unwrap_or(1).max(1);
            mailbox_snapshot(state, &account_ids, &filter, page_size * page_count)
        }
        "observeMailboxCounts" => {
            let account_ids = string_array(request.payload.get("accountIds"));
            let targets = request
                .payload
                .get("targets")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            counts_snapshot(state, &account_ids, &targets)
        }
        "observeConversation" => {
            let account_id = request.payload["key"]["accountId"]
                .as_str()
                .unwrap_or_default();
            let conversation_id = request.payload["key"]["conversationId"]
                .as_str()
                .unwrap_or_default();
            let after = request.payload["after"].as_str();
            let page_size = request.payload["pageSize"].as_i64().unwrap_or(50);
            conversation_snapshot(state, account_id, conversation_id, after, page_size)
        }
        "ensureMessageContent" => ensure_content(app, state, &request.payload),
        "requestSync" => {
            // A sync is a network round trip; answer immediately and push the
            // resulting snapshots on the subscription channel when it lands.
            sync::spawn_notify(app.clone(), string_array(request.payload.get("accountIds")));
            ok(Value::Null)
        }
        "retainAccounts" => ok(Value::Null),
        "purgeAccount" => {
            let account_id = request.payload["accountId"].as_str().unwrap_or_default();
            match lock_store(state).and_then(|store| {
                store
                    .forget_account(account_id)
                    .map_err(|error| error.to_string())
            }) {
                Ok(()) => ok(Value::Null),
                Err(message) => failed(&message),
            }
        }
        "getDiagnostics" => diagnostics(state, &request.payload),
        "submitMetadata" => submit_metadata(app, state, &request.payload),
        "submitConversations" => submit_conversations(app, state, &request.payload),
        "saveDraft" => save_draft(state, &request.payload),
        "readDraft" => read_draft(state, &request.payload),
        "submitSend" => submit_send(app, state, &request.payload),
        "observeOperation" => operation_snapshot(state, &request.payload),
        "cancelOperation" => cancel_operation(app, state, &request.payload),
        other => unsupported(other),
    }
}

fn diagnostics(state: &AppState, payload: &Value) -> Value {
    let account_id = payload["accountId"].as_str().unwrap_or_default();
    if account_id.is_empty() {
        return invalid("getDiagnostics needs an account id");
    }
    let diagnostics = match lock_store(state).and_then(|store| {
        store
            .diagnostics(account_id)
            .map_err(|error| error.to_string())
    }) {
        Ok(diagnostics) => diagnostics,
        Err(message) => return failed(&message),
    };
    let connection = if state.vault.load(account_id).ok().flatten().is_some() {
        "ready"
    } else {
        "offline"
    };
    ok(json!({
        "accountId": diagnostics.account_id,
        "revision": diagnostics.revision,
        "connection": connection,
        "coverage": diagnostics.coverage,
        "pendingOperations": diagnostics.pending_operations,
        "uncertainOperations": diagnostics.uncertain_operations,
        "pendingJobs": 0,
        "oldestPendingAtMs": diagnostics.oldest_pending_at_ms,
        "commands": diagnostics.commands,
    }))
}

fn submit_metadata(app: &AppHandle, state: &AppState, payload: &Value) -> Value {
    let account_id = payload["accountId"].as_str().unwrap_or_default();
    let command_id = payload["commandId"].as_str().unwrap_or_default();
    if account_id.is_empty() || command_id.is_empty() {
        return invalid("submitMetadata needs an account and command id");
    }
    if !sync::is_configured(state, account_id) {
        return ok(json!({ "status": "rejected", "code": "invalid" }));
    }
    let message_ids: Vec<String> = payload["targets"]
        .as_array()
        .map(|targets| {
            targets
                .iter()
                .filter_map(|target| target["messageId"].as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let change = payload.get("change").cloned().unwrap_or(Value::Null);
    let admission = lock_store(state).and_then(|mut store| {
        store
            .admit_metadata(account_id, command_id, &message_ids, &change)
            .map_err(|error| error.to_string())
    });
    admission_response(app, state, account_id, command_id, admission)
}

fn submit_conversations(app: &AppHandle, state: &AppState, payload: &Value) -> Value {
    let account_id = payload["accountId"].as_str().unwrap_or_default();
    let command_id = payload["commandId"].as_str().unwrap_or_default();
    if account_id.is_empty() || command_id.is_empty() {
        return invalid("submitConversations needs an account and command id");
    }
    if !sync::is_configured(state, account_id) {
        return ok(json!({ "status": "rejected", "code": "invalid" }));
    }
    let conversation_ids: Vec<String> = payload["conversations"]
        .as_array()
        .map(|conversations| {
            conversations
                .iter()
                .filter_map(|conversation| conversation["conversationId"].as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let change = payload.get("change").cloned().unwrap_or(Value::Null);
    let observed_epoch = payload["observedRevision"]["databaseEpoch"]
        .as_str()
        .unwrap_or_default();
    let admission = lock_store(state).and_then(|mut store| {
        store
            .admit_conversations(
                account_id,
                command_id,
                &conversation_ids,
                &change,
                observed_epoch,
            )
            .map_err(|error| error.to_string())
    });
    admission_response(app, state, account_id, command_id, admission)
}

fn save_draft(state: &AppState, payload: &Value) -> Value {
    let account_id = payload["key"]["accountId"].as_str().unwrap_or_default();
    let draft_id = payload["key"]["draftId"].as_str().unwrap_or_default();
    if account_id.is_empty() || draft_id.is_empty() {
        return invalid("saveDraft needs an account and draft id");
    }
    if !sync::is_configured(state, account_id) {
        return ok(json!({ "status": "rejected", "code": "invalid" }));
    }
    let expected_revision = payload.get("expectedRevision").and_then(Value::as_i64);
    let content = payload.get("content").cloned().unwrap_or(Value::Null);
    let result = lock_store(state).and_then(|mut store| {
        store
            .save_draft(account_id, draft_id, expected_revision, &content)
            .map_err(|error| error.to_string())
    });
    match result {
        Ok(mail_store::DraftSave::Saved {
            draft_revision,
            revision,
        }) => ok(json!({
            "status": "saved",
            "draftRevision": draft_revision,
            "revision": revision,
        })),
        Ok(mail_store::DraftSave::Conflict {
            current_draft_revision,
        }) => ok(json!({
            "status": "conflict",
            "currentDraftRevision": current_draft_revision,
        })),
        Ok(mail_store::DraftSave::Rejected(code)) => {
            ok(json!({ "status": "rejected", "code": code }))
        }
        Err(message) => failed(&message),
    }
}

fn read_draft(state: &AppState, payload: &Value) -> Value {
    let account_id = payload["accountId"].as_str().unwrap_or_default();
    let draft_id = payload["draftId"].as_str().unwrap_or_default();
    if account_id.is_empty() || draft_id.is_empty() {
        return invalid("readDraft needs an account and draft id");
    }
    let result = lock_store(state).and_then(|store| {
        store
            .read_draft(account_id, draft_id)
            .map_err(|error| error.to_string())
    });
    match result {
        Ok(mail_store::DraftRead::Found {
            draft_revision,
            content,
        }) => ok(json!({
            "status": "found",
            "draftRevision": draft_revision,
            "content": content,
        })),
        Ok(mail_store::DraftRead::Missing) => ok(json!({ "status": "missing" })),
        Err(message) => failed(&message),
    }
}

fn submit_send(app: &AppHandle, state: &AppState, payload: &Value) -> Value {
    let account_id = payload["draft"]["accountId"].as_str().unwrap_or_default();
    let draft_id = payload["draft"]["draftId"].as_str().unwrap_or_default();
    let command_id = payload["commandId"].as_str().unwrap_or_default();
    let draft_revision = payload["draftRevision"].as_i64().unwrap_or(-1);
    if account_id.is_empty() || draft_id.is_empty() || command_id.is_empty() || draft_revision < 0 {
        return invalid("submitSend needs an account, draft, revision and command id");
    }
    if !sync::is_configured(state, account_id) {
        return ok(json!({ "status": "rejected", "code": "invalid" }));
    }
    let reply_account = payload["replyTo"]["accountId"]
        .as_str()
        .filter(|account| !account.is_empty())
        .unwrap_or(account_id);
    let reply_message = payload["replyTo"]["messageId"].as_str();
    let conversation_id = payload.get("conversationId").and_then(Value::as_str);
    let not_before_ms = payload.get("notBeforeMs").and_then(Value::as_i64);
    let admission = lock_store(state).and_then(|mut store| {
        store
            .admit_send(
                account_id,
                command_id,
                draft_id,
                draft_revision,
                mail_store::SendOptions {
                    reply_to: reply_message.map(|message| (reply_account, message)),
                    conversation_id,
                    not_before_ms,
                },
            )
            .map_err(|error| error.to_string())
    });
    admission_response(app, state, account_id, command_id, admission)
}

fn admission_response(
    app: &AppHandle,
    state: &AppState,
    account_id: &str,
    command_id: &str,
    admission: Result<Admission, String>,
) -> Value {
    let operation = json!({ "accountId": account_id, "operationId": command_id });
    match admission {
        Ok(Admission::Queued(revision)) => {
            push_snapshots(app, state);
            operations::spawn(app.clone(), account_id.to_string());
            ok(json!({
                "status": "queued",
                "operation": operation,
                "revision": revision,
            }))
        }
        Ok(Admission::AlreadyRecorded(revision)) => ok(json!({
            "status": "already_recorded",
            "operation": operation,
            "revision": revision,
        })),
        Ok(Admission::Rejected(code)) => ok(json!({ "status": "rejected", "code": code })),
        Err(message) => failed(&message),
    }
}

fn operation_snapshot(state: &AppState, payload: &Value) -> Value {
    let account_id = payload["accountId"].as_str().unwrap_or_default();
    let operation_id = payload["operationId"].as_str().unwrap_or_default();
    if account_id.is_empty() || operation_id.is_empty() {
        return invalid("observeOperation needs an account and operation id");
    }
    let store = match lock_store(state) {
        Ok(store) => store,
        Err(message) => return failed(&message),
    };
    let revision = match store.revision() {
        Ok(revision) => revision,
        Err(error) => return failed(&error.to_string()),
    };
    let operation = match store.operation_state(account_id, operation_id) {
        Ok(operation) => operation,
        Err(error) => return failed(&error.to_string()),
    };
    let key = json!({ "accountId": account_id, "operationId": operation_id });
    let data = match operation {
        Some(operation) => json!({
            "key": key,
            "status": operation.status,
            "authority": "backend",
            "attempts": operation.attempts,
            "nextAttemptAtMs": operation.next_attempt_at_ms,
            "error": operation.error_code.map(|code| json!({
                "code": code,
                "retryable": operation.error_retryable,
            })),
        }),
        None => json!({
            "key": key,
            "status": "failed",
            "authority": "backend",
            "attempts": 0,
            "nextAttemptAtMs": null,
            "error": { "code": "not_found", "retryable": false },
        }),
    };
    ok(Snapshot::ready(revision, data))
}

fn cancel_operation(app: &AppHandle, state: &AppState, payload: &Value) -> Value {
    let account_id = payload["accountId"].as_str().unwrap_or_default();
    let operation_id = payload["operationId"].as_str().unwrap_or_default();
    if account_id.is_empty() || operation_id.is_empty() {
        return invalid("cancelOperation needs an account and operation id");
    }
    let result = lock_store(state).and_then(|mut store| {
        let state = store
            .operation_state(account_id, operation_id)
            .map_err(|error| error.to_string())?;
        if state.is_none() {
            return Ok(Value::Null);
        }
        let cancelled = store
            .cancel_operation(account_id, operation_id)
            .map_err(|error| error.to_string())?;
        if !cancelled {
            return Ok(json!({ "status": "too_late" }));
        }
        let revision = store.revision().map_err(|error| error.to_string())?;
        Ok(json!({ "status": "cancelled", "revision": revision }))
    });
    match result {
        Ok(Value::Null) => ok(json!({ "status": "not_found" })),
        Ok(outcome) => {
            push_snapshots(app, state);
            ok(outcome)
        }
        Err(message) => failed(&message),
    }
}

fn mailbox_snapshot(
    state: &AppState,
    account_ids: &[String],
    filter: &MailboxFilter,
    page_size: i64,
) -> Value {
    let store = match lock_store(state) {
        Ok(store) => store,
        Err(message) => return failed(&message),
    };
    let revision = match store.revision() {
        Ok(revision) => revision,
        Err(error) => return failed(&error.to_string()),
    };
    let conversations = match store.conversations(account_ids, filter, page_size) {
        Ok(conversations) => conversations,
        Err(error) => return failed(&error.to_string()),
    };
    let (matching, unread) = match store.counts(account_ids, filter) {
        Ok(counts) => counts,
        Err(error) => return failed(&error.to_string()),
    };
    let coverage = store.coverage(account_ids).unwrap_or_default();

    ok(Snapshot::ready(
        revision,
        MailboxView {
            conversations,
            counts: MailboxCounts {
                matching_conversations: matching,
                unread_conversations: unread,
                extent: "local_coverage".to_string(),
            },
            next_page: None,
            coverage,
            connection: None,
        },
    ))
}

fn conversation_snapshot(
    state: &AppState,
    account_id: &str,
    conversation_id: &str,
    after: Option<&str>,
    page_size: i64,
) -> Value {
    if account_id.is_empty() || conversation_id.is_empty() {
        return invalid("observeConversation needs an account and conversation id");
    }
    let store = match lock_store(state) {
        Ok(store) => store,
        Err(message) => return failed(&message),
    };
    let revision = match store.revision() {
        Ok(revision) => revision,
        Err(error) => return failed(&error.to_string()),
    };
    let view = match store.conversation(account_id, conversation_id, after, page_size) {
        Ok(view) => view,
        Err(error) => return failed(&error.to_string()),
    };
    ok(Snapshot::ready(revision, view))
}

/// Answers the admission immediately and hydrates the body in the background.
/// `WorkAdmission` has no "cannot fetch" state, so an account that is no longer
/// configured is reported as `invalid_account`; anything else is `scheduled`.
fn ensure_content(app: &AppHandle, state: &AppState, payload: &Value) -> Value {
    let account_id = payload["accountId"].as_str().unwrap_or_default();
    let message_id = payload["messageId"].as_str().unwrap_or_default();
    if account_id.is_empty() || message_id.is_empty() {
        return invalid("ensureMessageContent needs an account and message id");
    }
    if !sync::is_configured(state, account_id) {
        return ok(json!({ "status": "rejected", "code": "invalid_account" }));
    }
    match lock_store(state) {
        Ok(store) => match store.has_content(account_id, message_id) {
            Ok(true) => return ok(json!({ "status": "already_satisfied" })),
            Ok(false) => {}
            Err(error) => return failed(&error.to_string()),
        },
        Err(message) => return failed(&message),
    }
    content::spawn(app.clone(), account_id.to_string(), message_id.to_string());
    ok(json!({ "status": "scheduled" }))
}

fn counts_snapshot(state: &AppState, account_ids: &[String], targets: &[Value]) -> Value {
    let store = match lock_store(state) {
        Ok(store) => store,
        Err(message) => return failed(&message),
    };
    let revision = match store.revision() {
        Ok(revision) => revision,
        Err(error) => return failed(&error.to_string()),
    };
    let mut counts = Vec::with_capacity(targets.len());
    for target in targets {
        let filter = MailboxFilter::from_predicate(&target["predicate"]);
        let (matching, unread) = match store.counts(account_ids, &filter) {
            Ok(counts) => counts,
            Err(error) => return failed(&error.to_string()),
        };
        counts.push(MailboxCountEntry {
            id: target["id"].as_str().unwrap_or_default().to_string(),
            matching_conversations: matching,
            unread_conversations: unread,
        });
    }
    ok(Snapshot::ready(revision, MailboxCountsView { counts }))
}

/// Recomputes every live subscription and pushes it. Called after the mirror
/// changes so the list updates without a restart.
pub(crate) fn push_snapshots(app: &AppHandle, state: &AppState) {
    let subscriptions: Vec<(String, Value)> = match state.subscriptions.lock() {
        Ok(subscriptions) => subscriptions
            .iter()
            .map(|(id, request)| (id.clone(), request.clone()))
            .collect(),
        Err(_) => return,
    };
    for (subscription_id, request) in subscriptions {
        let response = dispatch(app, state, &request_envelope(&subscription_id, &request));
        if response.get("status").and_then(Value::as_str) != Some("ok") {
            continue;
        }
        let snapshot = response.get("result").cloned().unwrap_or(Value::Null);
        let _ = app.emit(
            "mail-engine-snapshot",
            json!({ "subscriptionId": subscription_id, "snapshot": snapshot }),
        );
    }
}

/// The subscription stores the renderer's `{ method, payload }`; the envelope is
/// rebuilt here so one dispatch path answers both calls and pushes.
fn request_envelope(subscription_id: &str, request: &Value) -> Request {
    Request {
        protocol_version: mail_ipc::PROTOCOL_VERSION,
        request_id: subscription_id.to_string(),
        method: request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        payload: request.get("payload").cloned().unwrap_or(Value::Null),
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub fn run() {
    let state = match AppState::load() {
        Ok(state) => state,
        Err(message) => {
            eprintln!("OneMail could not open its local profile: {message}");
            return;
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            desktop_health,
            local_settings,
            local_account_save,
            local_account_remove,
            mail_engine,
            mail_engine_subscribe,
            mail_engine_unsubscribe,
            read_attachment,
            wipe_mailbox,
            local_ai_connect,
            local_ai_refresh,
            local_ai_disconnect,
            local_ai_models,
            local_ai_analyze,
        ])
        .setup(|app| {
            // Built here rather than in tauri.conf.json so the bridge can be an
            // initialization script: it has to run before the renderer bundle.
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("OneMail")
            .inner_size(1400.0, 900.0)
            .min_inner_size(900.0, 600.0)
            .initialization_script(include_str!("../../ui/init.js"))
            .build()?;
            let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            app.set_menu(Menu::with_items(app, &[&settings_item, &quit_item])?)?;
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "settings" => {
                    let _ = app.emit("open-settings", ());
                }
                "quit" => app.exit(0),
                _ => {}
            });
            // Resume syncing accounts whose password is already in the keychain.
            sync::spawn(app.handle().clone(), Vec::new());
            sync::start_periodic(app.handle().clone());
            // Replay any metadata change a previous run left queued.
            operations::resume(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the OneMail desktop shell");
}
