//! Message bodies and attachments.
//!
//! `ensureMessageContent` only schedules work; the actual IMAP round trip runs
//! on the async runtime, writes one `message_content` row, and then pushes fresh
//! conversation snapshots. Nothing is pushed on failure, so a server that cannot
//! answer does not make the renderer retry in a loop.

use mail_ipc::AttachmentDescriptor;
use mail_store::{MailStore, StoredContent};
use mail_vault::CredentialVault;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::state::AppState;

/// Schedules a body fetch unless one is already running for this message.
pub fn spawn(app: AppHandle, account_id: String, message_id: String) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let key = fetch_key(&account_id, &message_id);
        let Some(_claim) = state.claim_fetch(&key) else {
            return;
        };
        hydrate(&app, &state, &account_id, &message_id).await;
    });
}

async fn hydrate(app: &AppHandle, state: &AppState, account_id: &str, message_id: &str) {
    let remote = match lock_store(state).and_then(|store| {
        store
            .remote_message(account_id, message_id)
            .map_err(|error| error.to_string())
    }) {
        Ok(Some(remote)) => remote,
        // Seed/local mail has no server location; there is nothing to fetch.
        Ok(None) => return,
        Err(message) => {
            eprintln!("OneMail could not locate a message body: {message}");
            return;
        }
    };

    let Some(account) = crate::sync::account(state, account_id) else {
        return;
    };
    let password = match state.vault.load(account_id) {
        Ok(Some(password)) => password,
        Ok(None) => return,
        Err(error) => {
            eprintln!("OneMail could not read the mailbox credential: {error}");
            return;
        }
    };

    let fetched = {
        let _permit = state.fetch_permits.acquire().await;
        mail_imap::fetch_message(
            &crate::sync::credentials_for(&account, &password),
            &remote.folder,
            remote.uid,
        )
        .await
    };
    let fetched = match fetched {
        Ok(fetched) => fetched,
        Err(error) => {
            eprintln!("OneMail could not fetch a message body: {error}");
            return;
        }
    };
    if fetched.uid_validity != remote.uid_validity {
        // The folder was reassigned while we were reading; the next sync will
        // re-page it, and this body no longer describes the mirrored message.
        eprintln!("OneMail skipped a body: the folder's UIDVALIDITY changed");
        return;
    }

    let body = mail_imap::parse_body(&fetched.bytes);
    let attachments: Vec<AttachmentDescriptor> = body.attachments.iter().map(describe).collect();
    let content = StoredContent {
        html: body.html,
        text: body.text,
        attachments_json: serde_json::to_string(&attachments).unwrap_or_else(|_| "[]".to_string()),
        is_meeting_invitation: body.is_meeting_invitation,
        preview: body.preview,
        search_text: body.search_text,
        has_attachments: !attachments.is_empty(),
    };

    // The account may have been disconnected while the message was on the wire.
    if !crate::sync::is_configured(state, account_id) {
        return;
    }

    let saved = lock_store(state).and_then(|mut store| {
        store
            .save_content(account_id, message_id, &content)
            .map_err(|error| error.to_string())
    });
    match saved {
        Ok(true) => crate::push_snapshots(app, state),
        Ok(false) => {}
        Err(message) => eprintln!("OneMail could not store a message body: {message}"),
    }
}

/// Fetches one attachment's bytes on demand. The renderer asks per inline image,
/// so the whole message is downloaded again rather than keeping blobs in SQLite.
pub async fn read_attachment(state: &AppState, input: &Value) -> Result<Vec<u8>, String> {
    let account_id = input
        .get("accountId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message_id = input
        .get("messageId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let attachment_id = input
        .get("attachmentId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if account_id.is_empty() || message_id.is_empty() {
        return Err("Attachment reads need an account and message id".to_string());
    }
    let index: usize = attachment_id
        .parse()
        .map_err(|_| "Invalid attachment".to_string())?;

    let remote = {
        let store = lock_store(state)?;
        store
            .remote_message(account_id, message_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Message not found".to_string())?
    };
    if !crate::sync::is_configured(state, account_id) {
        return Err("Message not found".to_string());
    }
    let account =
        crate::sync::account(state, account_id).ok_or_else(|| "Message not found".to_string())?;
    let password = state
        .vault
        .load(account_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "The mailbox password is missing from the keychain".to_string())?;

    // A permit is enough here: inline images arrive one at a time per render.
    let _permit = state
        .fetch_permits
        .acquire()
        .await
        .map_err(|_| "Attachment downloads are unavailable".to_string())?;
    let fetched = mail_imap::fetch_message(
        &crate::sync::credentials_for(&account, &password),
        &remote.folder,
        remote.uid,
    )
    .await
    .map_err(|error| error.to_string())?;
    if fetched.uid_validity != remote.uid_validity {
        return Err("Message no longer exists".to_string());
    }

    mail_imap::attachment_bytes(&fetched.bytes, index)
        .ok_or_else(|| "Attachment not found".to_string())
}

fn describe(attachment: &mail_imap::Attachment) -> AttachmentDescriptor {
    AttachmentDescriptor {
        attachment_id: attachment.index.to_string(),
        filename: attachment.filename.clone(),
        mime_type: attachment.mime_type.clone(),
        size: attachment.size as i64,
        inline: attachment.inline,
        content_id: attachment.content_id.clone(),
    }
}

fn fetch_key(account_id: &str, message_id: &str) -> String {
    format!("{account_id}\0{message_id}")
}

fn lock_store(state: &AppState) -> Result<std::sync::MutexGuard<'_, MailStore>, String> {
    state
        .store
        .lock()
        .map_err(|_| "mail store lock poisoned".to_string())
}
