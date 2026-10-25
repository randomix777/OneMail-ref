//! Mail engine IPC protocol v1, mirrored from `packages/mail-core/src/protocol/mail-ipc.ts`.
//!
//! The renderer never talks to this crate directly: the Tauri shell answers the
//! same envelopes the Electron mail-engine utility process used to answer, so the
//! existing `@inboxzero/mail-core` client keeps working unchanged.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const PROTOCOL_VERSION: u64 = 1;

/// A validated request envelope. `method` selects the operation; `payload` is
/// left as JSON so one dispatch table can cover every method.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub protocol_version: u64,
    pub request_id: String,
    pub method: String,
    #[serde(default)]
    pub payload: Value,
}

impl Request {
    pub fn parse(value: &Value) -> Result<Self, String> {
        let request: Request =
            serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
        if request.protocol_version != PROTOCOL_VERSION {
            return Err(format!(
                "unsupported protocol version {}",
                request.protocol_version
            ));
        }
        Ok(request)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRevision {
    pub database_epoch: String,
    pub sequence: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationKey {
    pub account_id: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub key: ConversationKey,
    pub subject: String,
    pub preview: String,
    pub from: String,
    pub to: String,
    pub senders: Vec<String>,
    pub latest_message_at_ms: i64,
    pub unread: bool,
    pub starred: bool,
    pub has_attachments: bool,
    pub label_ids: Vec<String>,
    pub roles: Vec<String>,
    pub pending_operation_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageKey {
    pub account_id: String,
    pub message_id: String,
}

/// The message fields the conversation view renders. Mirrors
/// `messageMetadataSchema`; `externalUrl` is omitted when the mirror has none,
/// exactly like the TS store's `undefined`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageMetadata {
    pub subject: String,
    pub preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_url: Option<String>,
    pub from: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub received_at_ms: i64,
    pub read: bool,
    pub starred: bool,
    pub folder_id: Option<String>,
    pub inbox_section: Option<String>,
    pub label_ids: Vec<String>,
    pub category_ids: Vec<String>,
    pub roles: Vec<String>,
    pub has_attachments: bool,
    pub snoozed_until_ms: Option<i64>,
}

/// Mirrors `messageAttachmentDescriptorSchema`; `attachmentId` is the position
/// in the parsed attachment list, so a later read can find the same part.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDescriptor {
    pub attachment_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: i64,
    pub inline: bool,
    pub content_id: Option<String>,
}

/// Mirrors the `ConversationView["messages"][number]["content"]` union.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum MessageContent {
    NotRequested,
    Queued,
    Unavailable,
    Available {
        html: Option<String>,
        text: Option<String>,
        attachments: Vec<AttachmentDescriptor>,
        is_meeting_invitation: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub key: MessageKey,
    pub metadata: MessageMetadata,
    pub content: MessageContent,
    pub pending_operation_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationView {
    pub key: ConversationKey,
    pub messages: Vec<ConversationMessage>,
    pub next_page: Option<String>,
    pub coverage: Vec<Coverage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxCounts {
    pub matching_conversations: i64,
    pub unread_conversations: i64,
    pub extent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub account_id: String,
    pub scope_id: String,
    pub metadata: String,
    pub content: String,
    pub indexed_content: String,
    pub last_completed_sync_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxView {
    pub conversations: Vec<ConversationSummary>,
    pub counts: MailboxCounts,
    pub next_page: Option<String>,
    pub coverage: Vec<Coverage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxCountEntry {
    pub id: String,
    pub matching_conversations: i64,
    pub unread_conversations: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxCountsView {
    pub counts: Vec<MailboxCountEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotError {
    pub code: String,
    pub retryable: bool,
}

/// The `QuerySnapshot<T>` the renderer's mail client stores. Observations answer
/// with one of these, and the same shape is pushed for later changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot<T> {
    pub status: String,
    pub revision: Option<LocalRevision>,
    pub data: Option<T>,
    pub refreshing: bool,
    pub error: Option<SnapshotError>,
}

impl<T> Snapshot<T> {
    pub fn ready(revision: LocalRevision, data: T) -> Self {
        Self {
            status: "ready".to_string(),
            revision: Some(revision),
            data: Some(data),
            refreshing: false,
            error: None,
        }
    }

    pub fn unavailable(revision: Option<LocalRevision>, code: &str) -> Self {
        Self {
            status: "unavailable".to_string(),
            revision,
            data: None,
            refreshing: false,
            error: Some(SnapshotError {
                code: code.to_string(),
                retryable: true,
            }),
        }
    }
}

pub fn ok<T: Serialize>(result: T) -> Value {
    json!({ "status": "ok", "result": result })
}

pub fn unsupported(method: &str) -> Value {
    json!({ "status": "unsupported", "method": method })
}

pub fn invalid(message: &str) -> Value {
    json!({ "status": "invalid", "issues": [{ "message": message }] })
}

pub fn failed(message: &str) -> Value {
    json!({ "status": "error", "message": message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_a_foreign_protocol_version() {
        let request = json!({
            "protocolVersion": 2,
            "requestId": "r1",
            "method": "observeMailbox",
            "payload": {}
        });
        assert!(Request::parse(&request).is_err());
    }

    #[test]
    fn a_conversation_view_serializes_like_the_ts_union() {
        let view = ConversationView {
            key: ConversationKey {
                account_id: "acc-1".into(),
                conversation_id: "thread@example.com".into(),
            },
            messages: vec![ConversationMessage {
                key: MessageKey {
                    account_id: "acc-1".into(),
                    message_id: "message@example.com".into(),
                },
                metadata: MessageMetadata {
                    subject: "Hello".into(),
                    preview: "Hi there".into(),
                    external_url: None,
                    from: "ana@example.com".into(),
                    to: vec!["me@example.com".into()],
                    cc: Vec::new(),
                    bcc: Vec::new(),
                    received_at_ms: 7,
                    read: true,
                    starred: false,
                    folder_id: Some("INBOX".into()),
                    inbox_section: None,
                    label_ids: Vec::new(),
                    category_ids: Vec::new(),
                    roles: vec!["inbox".into()],
                    has_attachments: true,
                    snoozed_until_ms: None,
                },
                content: MessageContent::Available {
                    html: Some("<p>Hi</p>".into()),
                    text: None,
                    attachments: vec![AttachmentDescriptor {
                        attachment_id: "0".into(),
                        filename: "note.txt".into(),
                        mime_type: "text/plain".into(),
                        size: 3,
                        inline: false,
                        content_id: None,
                    }],
                    is_meeting_invitation: false,
                },
                pending_operation_ids: Vec::new(),
            }],
            next_page: None,
            coverage: Vec::new(),
        };
        let value = serde_json::to_value(view).expect("serializes");

        assert_eq!(value["messages"][0]["content"]["status"], "available");
        assert_eq!(
            value["messages"][0]["content"]["isMeetingInvitation"],
            json!(false)
        );
        assert_eq!(
            value["messages"][0]["content"]["attachments"][0]["attachmentId"],
            "0"
        );
        assert_eq!(value["messages"][0]["metadata"]["receivedAtMs"], 7);
        assert!(value["messages"][0]["metadata"]
            .get("externalUrl")
            .is_none());

        let pending = serde_json::to_value(MessageContent::NotRequested).expect("serializes");
        assert_eq!(pending, json!({ "status": "not_requested" }));
    }

    #[test]
    fn keeps_camel_case_on_the_wire() {
        let snapshot = Snapshot::ready(
            LocalRevision {
                database_epoch: "epoch".into(),
                sequence: 7,
            },
            MailboxCountsView { counts: vec![] },
        );
        let value = serde_json::to_value(snapshot).expect("serializes");
        assert_eq!(value["revision"]["databaseEpoch"], "epoch");
        assert_eq!(value["status"], "ready");
        assert_eq!(value["data"]["counts"], json!([]));
    }
}
