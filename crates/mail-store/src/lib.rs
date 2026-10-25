//! Local SQLite mail mirror.
//!
//! This is the Rust half of `packages/mail-sqlite`: same DDL vocabulary, same
//! revision fence (`profile_state`), so a mirror written by either side stays
//! readable. Only the tables the first slice reads are created today; the rest of
//! `migrations.ts` is ported incrementally.

use std::fs;
use std::path::{Path, PathBuf};

use mail_ipc::{
    AttachmentDescriptor, ConversationKey, ConversationMessage, ConversationSummary,
    ConversationView, Coverage, LocalRevision, MessageContent, MessageKey, MessageMetadata,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use uuid::Uuid;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS profile_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  database_epoch TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  owner_fence TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  generation TEXT NOT NULL,
  assistant_cursor TEXT
);

CREATE TABLE IF NOT EXISTS effective_messages (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  preview TEXT NOT NULL,
  external_url TEXT,
  from_address TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  received_at_ms INTEGER NOT NULL,
  read INTEGER NOT NULL,
  starred INTEGER NOT NULL,
  folder_id TEXT,
  inbox_section TEXT,
  label_ids_json TEXT NOT NULL,
  category_ids_json TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  in_inbox INTEGER NOT NULL,
  in_sent INTEGER NOT NULL,
  in_draft INTEGER NOT NULL,
  in_trash INTEGER NOT NULL,
  in_spam INTEGER NOT NULL,
  has_attachments INTEGER NOT NULL,
  snoozed_until_ms INTEGER,
  pending_operation_ids_json TEXT NOT NULL,
  PRIMARY KEY (account_id, message_id)
);

CREATE TABLE IF NOT EXISTS coverage (
  account_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  metadata TEXT NOT NULL,
  content TEXT NOT NULL,
  indexed_content TEXT NOT NULL,
  last_completed_sync_at_ms INTEGER,
  PRIMARY KEY (account_id, scope_id)
);

-- Same columns as `migrations.ts`, except the body is kept as plain text: this
-- mirror is the Rust engine's own file, so the TS body codec does not apply.
CREATE TABLE IF NOT EXISTS message_content (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  version TEXT,
  html TEXT,
  text TEXT,
  attachments_json TEXT,
  is_meeting_invitation INTEGER NOT NULL DEFAULT 0 CHECK (is_meeting_invitation IN (0, 1)),
  search_text TEXT,
  PRIMARY KEY (account_id, message_id)
);

-- Rust-only bookkeeping: where a mirrored message lives on the server, so a body
-- can be fetched by UID later. Message ids are RFC Message-IDs and carry no
-- location, and the shared table keeps the TS column set untouched.
CREATE TABLE IF NOT EXISTS message_remote (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  uid_validity INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id)
);

CREATE INDEX IF NOT EXISTS message_remote_location
  ON message_remote(account_id, folder, uid_validity);

-- Rust-only bookkeeping: the UIDVALIDITY a folder's mirrored rows were fetched
-- under. Not in `migrations.ts`; the TS side has no folder-level UID fence yet.
CREATE TABLE IF NOT EXISTS folder_state (
  account_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  uid_validity INTEGER NOT NULL,
  PRIMARY KEY (account_id, folder)
);

CREATE INDEX IF NOT EXISTS effective_inbox_order
  ON effective_messages(account_id, in_inbox, received_at_ms DESC, conversation_id, message_id);
CREATE INDEX IF NOT EXISTS effective_conversation
  ON effective_messages(account_id, conversation_id, received_at_ms DESC);

-- Metadata changes the user asked for, before the server has confirmed them.
-- `intent_json` is the admission key: the same command id with the same intent
-- is a retry, not a second archive.
CREATE TABLE IF NOT EXISTS operations (
  account_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  status TEXT NOT NULL,
  authority TEXT NOT NULL,
  kind TEXT NOT NULL,
  change_json TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at_ms INTEGER,
  error_code TEXT,
  error_retryable INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (account_id, command_id)
);

CREATE INDEX IF NOT EXISTS operations_pending
  ON operations(account_id, status, next_attempt_at_ms);

-- Compose drafts live on this device. A send freezes the draft so a late edit
-- cannot change the bytes already on the wire.
CREATE TABLE IF NOT EXISTS drafts (
  account_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  frozen INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (account_id, draft_id)
);

-- One row per message an operation touches. `previous_json` is the metadata
-- before the optimistic write, so a permanent failure can put it back.
CREATE TABLE IF NOT EXISTS operation_targets (
  account_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  previous_json TEXT NOT NULL,
  PRIMARY KEY (account_id, command_id, message_id)
);
"#;

const UPSERT_MESSAGE_SQL: &str = r#"
INSERT INTO effective_messages (
  account_id, message_id, conversation_id, subject, preview, external_url,
  from_address, to_json, cc_json, bcc_json, received_at_ms, read, starred,
  folder_id, inbox_section, label_ids_json, category_ids_json, roles_json,
  in_inbox, in_sent, in_draft, in_trash, in_spam, has_attachments,
  snoozed_until_ms, pending_operation_ids_json
) VALUES (
  ?1, ?2, ?3, ?4, '', NULL,
  ?5, ?6, '[]', '[]', ?7, ?8, ?9,
  ?10, NULL, '[]', '[]', ?11,
  ?12, ?13, ?14, ?15, ?16, ?17,
  NULL, '[]'
)
ON CONFLICT(account_id, message_id) DO UPDATE SET
  conversation_id = excluded.conversation_id,
  subject = excluded.subject,
  from_address = excluded.from_address,
  to_json = excluded.to_json,
  received_at_ms = excluded.received_at_ms,
  -- A pending operation owns these columns until it succeeds or reverts.
  read = CASE WHEN effective_messages.pending_operation_ids_json = '[]'
    THEN excluded.read ELSE effective_messages.read END,
  starred = CASE WHEN effective_messages.pending_operation_ids_json = '[]'
    THEN excluded.starred ELSE effective_messages.starred END,
  folder_id = CASE WHEN effective_messages.pending_operation_ids_json = '[]'
    THEN excluded.folder_id ELSE effective_messages.folder_id END,
  roles_json = CASE WHEN effective_messages.pending_operation_ids_json = '[]'
    THEN excluded.roles_json ELSE effective_messages.roles_json END,
  in_inbox = CASE WHEN effective_messages.pending_operation_ids_json = '[]'
    THEN excluded.in_inbox ELSE effective_messages.in_inbox END,
  in_sent = CASE WHEN effective_messages.pending_operation_ids_json = '[]'
    THEN excluded.in_sent ELSE effective_messages.in_sent END,
  in_draft = CASE WHEN effective_messages.pending_operation_ids_json = '[]'
    THEN excluded.in_draft ELSE effective_messages.in_draft END,
  in_trash = CASE WHEN effective_messages.pending_operation_ids_json = '[]'
    THEN excluded.in_trash ELSE effective_messages.in_trash END,
  in_spam = CASE WHEN effective_messages.pending_operation_ids_json = '[]'
    THEN excluded.in_spam ELSE effective_messages.in_spam END,
  -- Header syncs cannot see attachment parts, so only a body may raise this flag.
  has_attachments = MAX(effective_messages.has_attachments, excluded.has_attachments)
"#;

/// A compiled protocol predicate.
///
/// The SQL refers to the `e` alias that `counts` and `conversations` give
/// `effective_messages`, and carries its own bindings. Compiling to SQL instead
/// of mapping a handful of mailbox names is what makes boolean trees, address
/// filters and search expressible; an unknown or malformed predicate compiles to
/// `0=1` so a bad request reads as an empty mailbox instead of an error.
#[derive(Debug, Clone, PartialEq)]
pub struct MailboxFilter {
    sql: String,
    bindings: Vec<SqlValue>,
}

impl MailboxFilter {
    pub fn from_predicate(predicate: &Json) -> Self {
        let clause = compile_predicate(predicate);
        Self {
            sql: clause.sql,
            bindings: clause.bindings,
        }
    }
}

/// One compiled fragment; `bindings` lines up with the `?` placeholders in `sql`.
struct Clause {
    sql: String,
    bindings: Vec<SqlValue>,
}

fn compile_predicate(predicate: &Json) -> Clause {
    let Some(kind) = predicate.get("kind").and_then(Json::as_str) else {
        return always(false);
    };
    match kind {
        "all" => compile_group(predicate, " AND ", true),
        "any" => compile_group(predicate, " OR ", false),
        "not" => {
            let inner = compile_predicate(predicate.get("predicate").unwrap_or(&Json::Null));
            Clause {
                sql: format!("(NOT {})", inner.sql),
                bindings: inner.bindings,
            }
        }
        "role" => match predicate.get("role").and_then(Json::as_str) {
            Some("inbox") => raw("e.in_inbox = 1"),
            Some("sent") => raw("e.in_sent = 1"),
            Some("draft") => raw("e.in_draft = 1"),
            Some("trash") => raw("e.in_trash = 1"),
            Some("spam") => raw("e.in_spam = 1"),
            _ => always(false),
        },
        "mailbox" => match predicate.get("mailbox").and_then(Json::as_str) {
            Some("inbox") => raw("e.in_inbox = 1"),
            Some("sent") => raw("e.in_sent = 1"),
            Some("drafts") => raw("e.in_draft = 1"),
            Some("trash") => raw("e.in_trash = 1"),
            Some("spam") => raw("e.in_spam = 1"),
            // The TS store's archive excludes only inbox, trash and spam, so a
            // message that is also in Sent still reads as archived.
            Some("archive") => raw("(e.in_inbox = 0 AND e.in_trash = 0 AND e.in_spam = 0)"),
            Some("all") => raw("(e.in_trash = 0 AND e.in_spam = 0)"),
            Some("starred") => raw("e.starred = 1"),
            Some("snoozed") => Clause {
                sql: "IFNULL(e.snoozed_until_ms, 0) > ?".to_string(),
                bindings: vec![SqlValue::Integer(now_ms())],
            },
            _ => always(false),
        },
        "read" => column_int("e.read", flag(predicate, "value")),
        "starred" => column_int("e.starred", flag(predicate, "value")),
        "has_attachment" => column_int("e.has_attachments", flag(predicate, "value")),
        "inbox_section" => match predicate.get("section").and_then(Json::as_str) {
            Some(section) => column_text("e.inbox_section", section),
            None => always(false),
        },
        "membership" => compile_membership(predicate),
        "address" => compile_address(predicate),
        "received" => compile_received(predicate),
        "message" => {
            let ids = string_array(predicate.get("ids"));
            if ids.is_empty() {
                return always(false);
            }
            Clause {
                sql: format!("e.message_id IN ({})", placeholders(ids.len())),
                bindings: ids.into_iter().map(SqlValue::Text).collect(),
            }
        }
        "text" => compile_text(predicate),
        _ => always(false),
    }
}

fn compile_group(predicate: &Json, joiner: &str, empty_matches: bool) -> Clause {
    let clauses: Vec<Clause> = predicate
        .get("predicates")
        .and_then(Json::as_array)
        .map(|children| children.iter().map(compile_predicate).collect())
        .unwrap_or_default();
    if clauses.is_empty() {
        return always(empty_matches);
    }
    let sql = clauses
        .iter()
        .map(|clause| clause.sql.as_str())
        .collect::<Vec<_>>()
        .join(joiner);
    Clause {
        sql: format!("({sql})"),
        bindings: clauses
            .into_iter()
            .flat_map(|clause| clause.bindings)
            .collect(),
    }
}

fn compile_membership(predicate: &Json) -> Clause {
    let Some(id) = predicate.get("id").and_then(Json::as_str) else {
        return always(false);
    };
    let membership = match predicate.get("membership").and_then(Json::as_str) {
        Some("folder") => column_text("e.folder_id", id),
        Some("label") => Clause {
            sql: "(EXISTS (SELECT 1 FROM json_each(e.label_ids_json) WHERE value = ?))".to_string(),
            bindings: vec![SqlValue::Text(id.to_string())],
        },
        Some("category") => Clause {
            sql: "(EXISTS (SELECT 1 FROM json_each(e.category_ids_json) WHERE value = ?))"
                .to_string(),
            bindings: vec![SqlValue::Text(id.to_string())],
        },
        _ => return always(false),
    };
    match predicate.get("accountId").and_then(Json::as_str) {
        Some(account_id) => Clause {
            sql: format!("(e.account_id = ? AND {})", membership.sql),
            bindings: std::iter::once(SqlValue::Text(account_id.to_string()))
                .chain(membership.bindings)
                .collect(),
        },
        None => Clause {
            sql: format!("({})", membership.sql),
            bindings: membership.bindings,
        },
    }
}

fn compile_address(predicate: &Json) -> Clause {
    let column = match predicate.get("field").and_then(Json::as_str) {
        Some("from") => "e.from_address",
        Some("to") => "e.to_json",
        Some("cc") => "e.cc_json",
        _ => return always(false),
    };
    let Some(value) = predicate.get("value").and_then(Json::as_str) else {
        return always(false);
    };
    let text = SqlValue::Text(value.to_string());
    if column == "e.from_address"
        && predicate.get("match").and_then(Json::as_str) == Some("address")
    {
        return Clause {
            sql: format!(
                "(LOWER({column}) = LOWER(?) OR LOWER({column}) LIKE '%' || LOWER(?) || '%')"
            ),
            bindings: vec![text.clone(), text],
        };
    }
    Clause {
        sql: format!("LOWER({column}) LIKE '%' || LOWER(?) || '%'"),
        bindings: vec![text],
    }
}

fn compile_received(predicate: &Json) -> Clause {
    let mut parts = Vec::new();
    let mut bindings = Vec::new();
    if let Some(after) = predicate.get("afterMs").and_then(Json::as_i64) {
        parts.push("e.received_at_ms >= ?");
        bindings.push(SqlValue::Integer(after));
    }
    if let Some(before) = predicate.get("beforeMs").and_then(Json::as_i64) {
        parts.push("e.received_at_ms < ?");
        bindings.push(SqlValue::Integer(before));
    }
    if parts.is_empty() {
        return raw("1=1");
    }
    Clause {
        sql: format!("({})", parts.join(" AND ")),
        bindings,
    }
}

/// Substring search over the columns the mirror holds: subject, preview, sender,
/// and the search text of a stored body. `term` requires every word to match
/// somewhere, `phrase` the whole string. The TS store prefers an FTS5 index and
/// falls back to this scan for unindexed rows; the Rust mirror stores plain text,
/// so it answers every body search this way.
fn compile_text(predicate: &Json) -> Clause {
    let Some(value) = predicate.get("value").and_then(Json::as_str) else {
        return always(false);
    };
    let field = predicate
        .get("field")
        .and_then(Json::as_str)
        .unwrap_or("any");
    let phrase = predicate.get("match").and_then(Json::as_str) == Some("phrase");
    let mut terms: Vec<&str> = if phrase {
        vec![value.trim()]
    } else {
        value.split_whitespace().collect()
    };
    terms.retain(|term| !term.is_empty());
    if terms.is_empty() {
        return always(false);
    }

    let mut columns: Vec<&str> = Vec::new();
    if field != "body" {
        columns.push("LOWER(e.subject) LIKE LOWER(?) ESCAPE '\\'");
        if field == "any" {
            columns.push("LOWER(e.preview) LIKE LOWER(?) ESCAPE '\\'");
            columns.push("LOWER(e.from_address) LIKE LOWER(?) ESCAPE '\\'");
        }
    }
    if field != "subject" {
        columns.push(
            "EXISTS (SELECT 1 FROM message_content c
                     WHERE c.account_id = e.account_id AND c.message_id = e.message_id
                       AND LOWER(c.search_text) LIKE LOWER(?) ESCAPE '\\')",
        );
    }

    let alternatives = columns.join(" OR ");
    let mut sql_parts = Vec::new();
    let mut bindings = Vec::new();
    for term in terms {
        sql_parts.push(format!("({alternatives})"));
        let pattern = SqlValue::Text(format!("%{}%", escape_like(term)));
        for _ in 0..columns.len() {
            bindings.push(pattern.clone());
        }
    }
    Clause {
        sql: format!("({})", sql_parts.join(" AND ")),
        bindings,
    }
}

fn raw(sql: &str) -> Clause {
    Clause {
        sql: sql.to_string(),
        bindings: Vec::new(),
    }
}

fn always(matches: bool) -> Clause {
    raw(if matches { "1=1" } else { "0=1" })
}

fn column_text(column: &str, value: &str) -> Clause {
    Clause {
        sql: format!("{column} = ?"),
        bindings: vec![SqlValue::Text(value.to_string())],
    }
}

fn column_int(column: &str, value: i64) -> Clause {
    Clause {
        sql: format!("{column} = ?"),
        bindings: vec![SqlValue::Integer(value)],
    }
}

fn flag(predicate: &Json, field: &str) -> i64 {
    i64::from(
        predicate
            .get(field)
            .and_then(Json::as_bool)
            .unwrap_or(false),
    )
}

fn string_array(value: Option<&Json>) -> Vec<String> {
    value
        .and_then(Json::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Json::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// The well-known mailbox a folder mirrors. Drives the `in_*` placement columns
/// and the `roles` the renderer filters on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderRole {
    Inbox,
    Sent,
    Drafts,
    Archive,
    Trash,
    Spam,
}

impl FolderRole {
    fn flags(self) -> (i64, i64, i64, i64, i64) {
        match self {
            Self::Inbox => (1, 0, 0, 0, 0),
            Self::Sent => (0, 1, 0, 0, 0),
            Self::Drafts => (0, 0, 1, 0, 0),
            Self::Archive => (0, 0, 0, 0, 0),
            Self::Trash => (0, 0, 0, 1, 0),
            Self::Spam => (0, 0, 0, 0, 1),
        }
    }

    fn roles_json(self) -> &'static str {
        match self {
            Self::Inbox => r#"["inbox"]"#,
            Self::Sent => r#"["sent"]"#,
            Self::Drafts => r#"["draft"]"#,
            Self::Archive => "[]",
            Self::Trash => r#"["trash"]"#,
            Self::Spam => r#"["spam"]"#,
        }
    }
}

/// One message as a sync page hands it to the mirror.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncedMessage {
    pub message_id: String,
    pub conversation_id: String,
    pub subject: String,
    pub from_address: String,
    pub to_addresses: Vec<String>,
    pub received_at_ms: i64,
    pub read: bool,
    pub starred: bool,
    pub has_attachments: bool,
    /// The server UID inside the page's folder, kept so a body can be fetched.
    pub uid: u32,
}

/// Where one mirrored message can be fetched from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteMessage {
    pub folder: String,
    pub uid_validity: u32,
    pub uid: u32,
}

/// A parsed body ready to be written to `message_content`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredContent {
    pub html: Option<String>,
    pub text: Option<String>,
    pub attachments_json: String,
    pub is_meeting_invitation: bool,
    pub preview: String,
    pub has_attachments: bool,
    /// Full visible text, used by mailbox search; `preview` is its first 500
    /// characters.
    pub search_text: String,
}

/// The newest page of one folder, plus the fence that says when UIDs changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderSync {
    pub folder: String,
    pub role: FolderRole,
    pub uid_validity: u32,
    pub messages: Vec<SyncedMessage>,
}

/// A metadata change this mirror can apply locally and the executor can replay
/// against IMAP. Changes without a server operation (labels, snooze) are
/// rejected at admission instead of being shown as applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetadataChange {
    Archive,
    Unarchive,
    SetRead(bool),
    SetStarred(bool),
    Trash,
    RestoreFromTrash,
    SetSpam(bool),
    Move(String),
}

impl MetadataChange {
    pub fn parse(value: &Json) -> Option<Self> {
        match value.get("kind")?.as_str()? {
            "archive" => Some(Self::Archive),
            "unarchive" => Some(Self::Unarchive),
            "set_read" => Some(Self::SetRead(value.get("read")?.as_bool()?)),
            "set_starred" => Some(Self::SetStarred(value.get("starred")?.as_bool()?)),
            "trash" => Some(Self::Trash),
            "restore_from_trash" => Some(Self::RestoreFromTrash),
            "set_spam" => Some(Self::SetSpam(value.get("spam")?.as_bool()?)),
            "move" => {
                let folder_id = value.get("folderId")?.as_str()?;
                if folder_id.is_empty() {
                    return None;
                }
                Some(Self::Move(folder_id.to_string()))
            }
            _ => None,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Archive => "archive",
            Self::Unarchive => "unarchive",
            Self::SetRead(_) => "set_read",
            Self::SetStarred(_) => "set_starred",
            Self::Trash => "trash",
            Self::RestoreFromTrash => "restore_from_trash",
            Self::SetSpam(_) => "set_spam",
            Self::Move(_) => "move",
        }
    }

    fn apply(&self, state: &mut MessageState) {
        match self {
            Self::Archive => {
                state.roles.retain(|role| role != "inbox");
                state.snoozed_until_ms = None;
            }
            Self::Unarchive => {
                state.roles.retain(|role| role != "trash");
                push_unique(&mut state.roles, "inbox");
                state.snoozed_until_ms = None;
            }
            Self::SetRead(read) => state.read = *read,
            Self::SetStarred(starred) => state.starred = *starred,
            Self::Trash => state.roles = vec!["trash".to_string()],
            Self::RestoreFromTrash => {
                state.roles.retain(|role| role != "trash");
                push_unique(&mut state.roles, "inbox");
            }
            Self::SetSpam(true) => state.roles = vec!["spam".to_string()],
            Self::SetSpam(false) => {
                state.roles.retain(|role| role != "spam");
                push_unique(&mut state.roles, "inbox");
            }
            Self::Move(folder_id) => {
                state.roles.retain(|role| role != "inbox");
                state.folder_id = Some(folder_id.clone());
            }
        }
        state.in_inbox = state.roles.iter().any(|role| role == "inbox");
        state.in_sent = state.roles.iter().any(|role| role == "sent");
        state.in_draft = state.roles.iter().any(|role| role == "draft");
        state.in_trash = state.roles.iter().any(|role| role == "trash");
        state.in_spam = state.roles.iter().any(|role| role == "spam");
    }
}

/// What a draft write did. `frozen` means a send already owns the content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DraftSave {
    Saved {
        draft_revision: i64,
        revision: LocalRevision,
    },
    Conflict {
        current_draft_revision: Option<i64>,
    },
    Rejected(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DraftRead {
    Found { draft_revision: i64, content: Json },
    Missing,
}

/// The frozen content of a send. Stored in `operations.intent_json`, so a retry
/// transmits exactly what the user submitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendIntent {
    pub draft_id: String,
    pub draft_revision: i64,
    pub from: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub html: String,
    pub quoted_html: String,
    pub reply_to_message_id: Option<String>,
    pub reply_to_conversation_id: Option<String>,
}

impl SendIntent {
    fn parse(value: &Json) -> Option<Self> {
        if value.get("kind")?.as_str()? != "send" {
            return None;
        }
        Some(Self {
            draft_id: value.get("frozenDraftId")?.as_str()?.to_string(),
            draft_revision: value.get("frozenDraftRevision")?.as_i64()?,
            from: value.get("from").and_then(Json::as_str).map(str::to_string),
            to: required_string_array(value.get("to"))?,
            cc: required_string_array(value.get("cc"))?,
            bcc: required_string_array(value.get("bcc"))?,
            subject: value.get("subject")?.as_str()?.to_string(),
            html: value.get("html")?.as_str()?.to_string(),
            quoted_html: value.get("quotedHtml")?.as_str()?.to_string(),
            reply_to_message_id: value
                .get("replyToMessageId")
                .and_then(Json::as_str)
                .map(str::to_string),
            reply_to_conversation_id: value
                .get("replyToConversationId")
                .and_then(Json::as_str)
                .map(str::to_string),
        })
    }
}

/// What an operation owes the outside world: a metadata change, or one send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OperationIntent {
    Metadata(MetadataChange),
    Send(Box<SendIntent>),
}

/// Optional parts of a send, kept separate so admission stays readable.
#[derive(Debug, Clone, Default)]
pub struct SendOptions<'a> {
    pub reply_to: Option<(&'a str, &'a str)>,
    pub conversation_id: Option<&'a str>,
    pub not_before_ms: Option<i64>,
}

/// The metadata an operation may rewrite, saved before the optimistic write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct MessageState {
    read: bool,
    starred: bool,
    folder_id: Option<String>,
    roles: Vec<String>,
    label_ids: Vec<String>,
    category_ids: Vec<String>,
    in_inbox: bool,
    in_sent: bool,
    in_draft: bool,
    in_trash: bool,
    in_spam: bool,
    snoozed_until_ms: Option<i64>,
}

/// The result of asking the mirror to record a command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    Queued(LocalRevision),
    AlreadyRecorded(LocalRevision),
    Rejected(&'static str),
}

/// A command that still owes work to the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingOperation {
    pub account_id: String,
    pub command_id: String,
    pub status: String,
    pub intent: OperationIntent,
    pub attempts: i64,
    pub next_attempt_at_ms: Option<i64>,
    pub created_at_ms: i64,
}

/// One message inside a pending command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationTarget {
    pub message_id: String,
    pub conversation_id: String,
}

/// What `observeOperation` shows for one command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationState {
    pub account_id: String,
    pub operation_id: String,
    pub status: String,
    pub attempts: i64,
    pub next_attempt_at_ms: Option<i64>,
    pub error_code: Option<String>,
    pub error_retryable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub account_id: String,
    pub revision: LocalRevision,
    pub coverage: Vec<Coverage>,
    pub pending_operations: i64,
    pub uncertain_operations: i64,
    pub oldest_pending_at_ms: Option<i64>,
    pub commands: Vec<DiagnosticCommand>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticCommand {
    pub operation_id: String,
    pub status: String,
    pub kind: String,
    pub change_kind: Option<String>,
    pub change: Json,
    pub message_ids: Vec<String>,
    pub conversation_ids: Vec<String>,
}

const PENDING_STATUSES: &str = "'queued', 'executing', 'retry_wait'";
const MAX_PENDING_OPERATIONS: i64 = 500;

pub struct MailStore {
    conn: Connection,
    path: PathBuf,
}

impl MailStore {
    /// Opens (or creates) the mirror and makes sure the revision fence exists.
    pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let conn = Connection::open(&path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA_SQL)?;
        // Mirrors created before body search get the column in place.
        ensure_column(&conn, "message_content", "search_text", "search_text TEXT")?;
        conn.execute(
            "INSERT OR IGNORE INTO profile_state(id, database_epoch, sequence) VALUES (1, ?1, 0)",
            [Uuid::new_v4().to_string()],
        )?;
        Ok(Self { conn, path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn revision(&self) -> rusqlite::Result<LocalRevision> {
        revision_of(&self.conn)
    }

    pub fn coverage(&self, account_ids: &[String]) -> rusqlite::Result<Vec<Coverage>> {
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = placeholders(account_ids.len());
        let sql = format!(
            "SELECT account_id, scope_id, metadata, content, indexed_content,
                    last_completed_sync_at_ms
             FROM coverage
             WHERE account_id IN ({placeholders})
             ORDER BY account_id, scope_id"
        );
        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(account_ids.iter()), |row| {
            Ok(Coverage {
                account_id: row.get(0)?,
                scope_id: row.get(1)?,
                metadata: row.get(2)?,
                content: row.get(3)?,
                indexed_content: row.get(4)?,
                last_completed_sync_at_ms: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    /// Conversation and unread counts for one compiled predicate. A conversation
    /// counts as unread when any of its messages is unread, which is the rule the
    /// TS store encodes in `effective_role_conversations`.
    pub fn counts(
        &self,
        account_ids: &[String],
        filter: &MailboxFilter,
    ) -> rusqlite::Result<(i64, i64)> {
        if account_ids.is_empty() {
            return Ok((0, 0));
        }
        let placeholders = placeholders(account_ids.len());
        let sql = format!(
            "SELECT COUNT(*), COALESCE(SUM(unread), 0) FROM (
               SELECT conversation_id,
                      MAX(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS unread
               FROM effective_messages e
               WHERE e.account_id IN ({placeholders}) AND {}
               GROUP BY conversation_id
             )",
            filter.sql
        );
        let mut values: Vec<SqlValue> = account_ids
            .iter()
            .map(|id| SqlValue::Text(id.clone()))
            .collect();
        values.extend(filter.bindings.iter().cloned());
        self.conn
            .query_row(&sql, params_from_iter(values.iter()), |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
    }

    /// Newest-first conversation summaries. `after` is accepted but not yet
    /// honoured: the renderer's cursor is opaque and the first slice returns the
    /// whole first page only, with `next_page = null`.
    pub fn conversations(
        &self,
        account_ids: &[String],
        filter: &MailboxFilter,
        page_size: i64,
    ) -> rusqlite::Result<Vec<ConversationSummary>> {
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = placeholders(account_ids.len());
        let sql = format!(
            "WITH filtered AS (
               SELECT * FROM effective_messages e
               WHERE e.account_id IN ({placeholders}) AND {}
             ),
             ranked AS (
               SELECT *, ROW_NUMBER() OVER (
                 PARTITION BY account_id, conversation_id
                 ORDER BY received_at_ms DESC, message_id DESC
               ) AS rn
               FROM filtered
             ),
             agg AS (
               SELECT account_id, conversation_id,
                      MAX(received_at_ms) AS latest_at_ms,
                      MAX(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS unread,
                      MAX(starred) AS starred,
                      MAX(has_attachments) AS has_attachments
               FROM filtered
               GROUP BY account_id, conversation_id
             )
             SELECT a.account_id, a.conversation_id, r.subject, r.preview,
                    r.from_address, r.to_json, r.label_ids_json, r.roles_json,
                    a.latest_at_ms, a.unread, a.starred, a.has_attachments
             FROM agg a
             JOIN ranked r
               ON r.account_id = a.account_id
              AND r.conversation_id = a.conversation_id
              AND r.rn = 1
             ORDER BY a.latest_at_ms DESC, a.conversation_id DESC
             LIMIT ?",
            filter.sql
        );
        let mut values: Vec<rusqlite::types::Value> = account_ids
            .iter()
            .map(|id| rusqlite::types::Value::Text(id.clone()))
            .collect();
        values.extend(filter.bindings.iter().cloned());
        values.push(rusqlite::types::Value::Integer(page_size));
        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values.iter()), |row| {
            let to_json: String = row.get(5)?;
            let label_ids_json: String = row.get(6)?;
            let roles_json: String = row.get(7)?;
            let to = parse_json_array(&to_json);
            let from: String = row.get(4)?;
            Ok(ConversationSummary {
                key: ConversationKey {
                    account_id: row.get(0)?,
                    conversation_id: row.get(1)?,
                },
                subject: row.get(2)?,
                preview: row.get(3)?,
                from: from.clone(),
                to: to.join(", "),
                senders: vec![from],
                latest_message_at_ms: row.get(8)?,
                unread: row.get::<_, i64>(9)? == 1,
                starred: row.get::<_, i64>(10)? == 1,
                has_attachments: row.get::<_, i64>(11)? == 1,
                label_ids: parse_json_array(&label_ids_json),
                roles: parse_json_array(&roles_json),
                pending_operation_ids: Vec::new(),
            })
        })?;
        rows.collect()
    }

    pub fn register_account(&self, account_id: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO accounts(account_id, provider, generation)
             VALUES (?1, 'imap', ?2)",
            rusqlite::params![account_id, Uuid::new_v4().to_string()],
        )?;
        Ok(())
    }

    pub fn forget_account(&self, account_id: &str) -> rusqlite::Result<()> {
        self.conn
            .execute("DELETE FROM accounts WHERE account_id = ?1", [account_id])?;
        self.conn.execute(
            "DELETE FROM effective_messages WHERE account_id = ?1",
            [account_id],
        )?;
        self.conn
            .execute("DELETE FROM coverage WHERE account_id = ?1", [account_id])?;
        self.conn.execute(
            "DELETE FROM folder_state WHERE account_id = ?1",
            [account_id],
        )?;
        self.conn.execute(
            "DELETE FROM message_content WHERE account_id = ?1",
            [account_id],
        )?;
        self.conn.execute(
            "DELETE FROM message_remote WHERE account_id = ?1",
            [account_id],
        )?;
        self.conn.execute(
            "DELETE FROM operation_targets WHERE account_id = ?1",
            [account_id],
        )?;
        self.conn
            .execute("DELETE FROM operations WHERE account_id = ?1", [account_id])?;
        self.conn
            .execute("DELETE FROM drafts WHERE account_id = ?1", [account_id])?;
        Ok(())
    }

    /// The server location of one mirrored message, or `None` when the mirror
    /// has no fetchable coordinate for it (e.g. seeded local mail).
    pub fn remote_message(
        &self,
        account_id: &str,
        message_id: &str,
    ) -> rusqlite::Result<Option<RemoteMessage>> {
        self.conn
            .query_row(
                "SELECT folder, uid_validity, uid FROM message_remote
                 WHERE account_id = ?1 AND message_id = ?2",
                rusqlite::params![account_id, message_id],
                |row| {
                    Ok(RemoteMessage {
                        folder: row.get(0)?,
                        uid_validity: row.get::<_, i64>(1)? as u32,
                        uid: row.get::<_, i64>(2)? as u32,
                    })
                },
            )
            .optional()
    }

    pub fn has_content(&self, account_id: &str, message_id: &str) -> rusqlite::Result<bool> {
        let found: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM message_content WHERE account_id = ?1 AND message_id = ?2",
                rusqlite::params![account_id, message_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    /// Writes a hydrated body and advances the revision fence, so conversation
    /// subscribers see the content arrive. Returns false when the message is no
    /// longer mirrored (the account was removed mid-fetch), in which case the
    /// body is dropped instead of becoming an orphan row.
    pub fn save_content(
        &mut self,
        account_id: &str,
        message_id: &str,
        content: &StoredContent,
    ) -> rusqlite::Result<bool> {
        let transaction = self.conn.transaction()?;
        let mirrored: Option<i64> = transaction
            .query_row(
                "SELECT 1 FROM effective_messages WHERE account_id = ?1 AND message_id = ?2",
                rusqlite::params![account_id, message_id],
                |row| row.get(0),
            )
            .optional()?;
        if mirrored.is_none() {
            return Ok(false);
        }

        transaction.execute(
            "INSERT INTO message_content(
               account_id, message_id, version, html, text, attachments_json,
               is_meeting_invitation, search_text
             ) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(account_id, message_id) DO UPDATE SET
               html = excluded.html,
               text = excluded.text,
               attachments_json = excluded.attachments_json,
               is_meeting_invitation = excluded.is_meeting_invitation,
               search_text = excluded.search_text",
            rusqlite::params![
                account_id,
                message_id,
                content.html,
                content.text,
                content.attachments_json,
                content.is_meeting_invitation as i64,
                content.search_text,
            ],
        )?;
        transaction.execute(
            "UPDATE effective_messages
             SET preview = ?3,
                 has_attachments = CASE WHEN ?4 = 1 THEN 1 ELSE has_attachments END
             WHERE account_id = ?1 AND message_id = ?2",
            rusqlite::params![
                account_id,
                message_id,
                content.preview,
                content.has_attachments as i64,
            ],
        )?;
        transaction.execute(
            "UPDATE profile_state SET sequence = sequence + 1 WHERE id = 1",
            [],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    /// One page of a conversation, oldest first. `after` is the message id of the
    /// last message the caller already holds; an unknown cursor restarts at the
    /// first page, matching the TS store.
    pub fn conversation(
        &self,
        account_id: &str,
        conversation_id: &str,
        after: Option<&str>,
        page_size: i64,
    ) -> rusqlite::Result<ConversationView> {
        let page_size = page_size.clamp(1, 100);
        let cursor = match after {
            Some(message_id) => self
                .conn
                .query_row(
                    "SELECT received_at_ms FROM effective_messages
                     WHERE account_id = ?1 AND conversation_id = ?2 AND message_id = ?3",
                    rusqlite::params![account_id, conversation_id, message_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .map(|received_at_ms| (received_at_ms, message_id.to_string())),
            None => None,
        };

        let mut statement = self.conn.prepare(
            "SELECT account_id, message_id, subject, preview, external_url,
                    from_address, to_json, cc_json, bcc_json, received_at_ms,
                    read, starred, folder_id, inbox_section, label_ids_json,
                    category_ids_json, roles_json, has_attachments,
                    snoozed_until_ms, pending_operation_ids_json
             FROM effective_messages
             WHERE account_id = ?1 AND conversation_id = ?2
               AND (
                 ?3 IS NULL
                 OR received_at_ms > ?4
                 OR (received_at_ms = ?4 AND message_id > ?5)
               )
             ORDER BY received_at_ms ASC, message_id ASC
             LIMIT ?6",
        )?;
        let rows = statement.query_map(
            rusqlite::params![
                account_id,
                conversation_id,
                cursor.as_ref().map(|(_, message_id)| message_id.as_str()),
                cursor.as_ref().map(|(at_ms, _)| *at_ms).unwrap_or(0),
                cursor.as_ref().map(|(_, message_id)| message_id.as_str()),
                page_size + 1,
            ],
            |row| {
                Ok((
                    MessageKey {
                        account_id: row.get(0)?,
                        message_id: row.get(1)?,
                    },
                    MessageMetadata {
                        subject: row.get(2)?,
                        preview: row.get(3)?,
                        external_url: row.get(4)?,
                        from: row.get(5)?,
                        to: parse_json_array(&row.get::<_, String>(6)?),
                        cc: parse_json_array(&row.get::<_, String>(7)?),
                        bcc: parse_json_array(&row.get::<_, String>(8)?),
                        received_at_ms: row.get(9)?,
                        read: row.get::<_, i64>(10)? == 1,
                        starred: row.get::<_, i64>(11)? == 1,
                        folder_id: row.get(12)?,
                        inbox_section: row.get(13)?,
                        label_ids: parse_json_array(&row.get::<_, String>(14)?),
                        category_ids: parse_json_array(&row.get::<_, String>(15)?),
                        roles: parse_json_array(&row.get::<_, String>(16)?),
                        has_attachments: row.get::<_, i64>(17)? == 1,
                        snoozed_until_ms: row.get(18)?,
                    },
                    parse_json_array(&row.get::<_, String>(19)?),
                ))
            },
        )?;
        let mut fetched = rows.collect::<rusqlite::Result<Vec<_>>>()?;

        let has_more = fetched.len() as i64 > page_size;
        if has_more {
            fetched.truncate(page_size as usize);
        }
        let next_page = has_more.then(|| {
            fetched
                .last()
                .map(|(key, _, _)| key.message_id.clone())
                .unwrap_or_default()
        });

        let mut messages = Vec::with_capacity(fetched.len());
        for (key, metadata, pending_operation_ids) in fetched {
            let content = self.content_for(&key)?;
            messages.push(ConversationMessage {
                key,
                metadata,
                content,
                pending_operation_ids,
            });
        }

        Ok(ConversationView {
            key: ConversationKey {
                account_id: account_id.to_string(),
                conversation_id: conversation_id.to_string(),
            },
            messages,
            next_page,
            coverage: self.coverage(&[account_id.to_string()])?,
        })
    }

    fn content_for(&self, key: &MessageKey) -> rusqlite::Result<MessageContent> {
        self.conn
            .query_row(
                "SELECT html, text, attachments_json, is_meeting_invitation
                 FROM message_content WHERE account_id = ?1 AND message_id = ?2",
                rusqlite::params![key.account_id, key.message_id],
                |row| {
                    let attachments_json: Option<String> = row.get(2)?;
                    Ok(MessageContent::Available {
                        html: row.get(0)?,
                        text: row.get(1)?,
                        attachments: attachments_json
                            .and_then(|raw| {
                                serde_json::from_str::<Vec<AttachmentDescriptor>>(&raw).ok()
                            })
                            .unwrap_or_default(),
                        is_meeting_invitation: row.get::<_, i64>(3)? == 1,
                    })
                },
            )
            .optional()
            .map(|content| content.unwrap_or(MessageContent::NotRequested))
    }

    pub fn account_exists(&self, account_id: &str) -> rusqlite::Result<bool> {
        let found: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM accounts WHERE account_id = ?1",
                [account_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    /// Writes a draft if the caller still holds the current revision. Drafts are
    /// local only: no server copy is written yet.
    pub fn save_draft(
        &mut self,
        account_id: &str,
        draft_id: &str,
        expected_revision: Option<i64>,
        content: &Json,
    ) -> rusqlite::Result<DraftSave> {
        if account_id.is_empty()
            || draft_id.is_empty()
            || expected_revision.is_some_and(|revision| revision < 0)
            || draft_content(content).is_none()
        {
            return Ok(DraftSave::Rejected("invalid"));
        }
        let transaction = self.conn.transaction()?;
        let current: Option<(i64, i64)> = transaction
            .query_row(
                "SELECT revision, frozen FROM drafts
                 WHERE account_id = ?1 AND draft_id = ?2",
                rusqlite::params![account_id, draft_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let current_revision = current.map(|(revision, _)| revision);
        if let Some((_, frozen)) = current {
            if frozen == 1 {
                return Ok(DraftSave::Conflict {
                    current_draft_revision: current_revision,
                });
            }
        }
        if expected_revision != current_revision {
            return Ok(DraftSave::Conflict {
                current_draft_revision: current_revision,
            });
        }
        let next = current_revision.unwrap_or(0) + 1;
        transaction.execute(
            "INSERT INTO drafts(account_id, draft_id, revision, content_json, frozen, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, 0, ?5)
             ON CONFLICT(account_id, draft_id) DO UPDATE SET
               revision = excluded.revision,
               content_json = excluded.content_json,
               updated_at_ms = excluded.updated_at_ms
             WHERE frozen = 0",
            rusqlite::params![
                account_id,
                draft_id,
                next,
                serde_json::to_string(content).unwrap_or_default(),
                now_ms()
            ],
        )?;
        bump_sequence(&transaction)?;
        let revision = revision_of(&transaction)?;
        transaction.commit()?;
        Ok(DraftSave::Saved {
            draft_revision: next,
            revision,
        })
    }

    pub fn read_draft(&self, account_id: &str, draft_id: &str) -> rusqlite::Result<DraftRead> {
        let row: Option<(i64, String)> = self
            .conn
            .query_row(
                "SELECT revision, content_json FROM drafts
                 WHERE account_id = ?1 AND draft_id = ?2",
                rusqlite::params![account_id, draft_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((draft_revision, content_json)) = row else {
            return Ok(DraftRead::Missing);
        };
        match serde_json::from_str::<Json>(&content_json) {
            Ok(content) if draft_content(&content).is_some() => Ok(DraftRead::Found {
                draft_revision,
                content,
            }),
            _ => Ok(DraftRead::Missing),
        }
    }

    /// Freezes a draft revision and queues one send. The operation carries the
    /// content, so later edits cannot change what is transmitted.
    pub fn admit_send(
        &mut self,
        account_id: &str,
        command_id: &str,
        draft_id: &str,
        draft_revision: i64,
        options: SendOptions<'_>,
    ) -> rusqlite::Result<Admission> {
        if account_id.is_empty()
            || command_id.is_empty()
            || draft_id.is_empty()
            || draft_revision < 0
            || options.not_before_ms.is_some_and(|value| value < 0)
        {
            return Ok(Admission::Rejected("invalid"));
        }
        let draft: Option<(i64, String, i64)> = self
            .conn
            .query_row(
                "SELECT revision, content_json, frozen FROM drafts
                 WHERE account_id = ?1 AND draft_id = ?2",
                rusqlite::params![account_id, draft_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((current_revision, content_json, frozen)) = draft else {
            return Ok(Admission::Rejected("invalid"));
        };
        if current_revision != draft_revision {
            return Ok(Admission::Rejected("invalid"));
        }
        let Some(content) = serde_json::from_str::<Json>(&content_json)
            .ok()
            .and_then(|content| draft_content(&content))
        else {
            return Ok(Admission::Rejected("invalid"));
        };

        let mut reply_to_conversation_id = options.conversation_id.map(str::to_string);
        if let Some((reply_account, reply_message)) = options.reply_to {
            let replied: Option<String> = self
                .conn
                .query_row(
                    "SELECT conversation_id FROM effective_messages
                     WHERE account_id = ?1 AND message_id = ?2",
                    rusqlite::params![reply_account, reply_message],
                    |row| row.get(0),
                )
                .optional()?;
            if replied.is_some() {
                reply_to_conversation_id = replied;
            }
        }

        let intent = json!({
            "kind": "send",
            "frozenDraftId": draft_id,
            "frozenDraftRevision": draft_revision,
            "from": content.from,
            "to": content.to,
            "cc": content.cc,
            "bcc": content.bcc,
            "subject": content.subject,
            "html": content.html,
            "quotedHtml": content.quoted_html,
            "replyToMessageId": options.reply_to.map(|(_, message)| message),
            "replyToConversationId": reply_to_conversation_id,
        });
        let intent_json = serde_json::to_string(&intent).unwrap_or_default();
        let summary = json!({
            "kind": "send",
            "draftId": draft_id,
            "to": content.to,
            "subject": content.subject,
        });
        let now = now_ms();

        let transaction = self.conn.transaction()?;
        let existing: Option<String> = transaction
            .query_row(
                "SELECT intent_json FROM operations
                 WHERE account_id = ?1 AND command_id = ?2",
                rusqlite::params![account_id, command_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            let revision = revision_of(&transaction)?;
            return Ok(if existing == intent_json {
                Admission::AlreadyRecorded(revision)
            } else {
                Admission::Rejected("invalid")
            });
        }
        if frozen == 1 {
            return Ok(Admission::Rejected("invalid"));
        }
        let pending: i64 = transaction.query_row(
            &format!(
                "SELECT COUNT(*) FROM operations
                 WHERE account_id = ?1 AND status IN ({PENDING_STATUSES})"
            ),
            [account_id],
            |row| row.get(0),
        )?;
        if pending >= MAX_PENDING_OPERATIONS {
            return Ok(Admission::Rejected("queue_full"));
        }

        transaction.execute(
            "INSERT INTO operations(
               account_id, command_id, status, authority, kind, change_json,
               intent_json, attempts, created_at_ms, updated_at_ms, next_attempt_at_ms
             ) VALUES (?1, ?2, 'queued', 'backend', 'send', ?3, ?4, 0, ?5, ?5, ?6)",
            rusqlite::params![
                account_id,
                command_id,
                serde_json::to_string(&summary).unwrap_or_default(),
                intent_json,
                now,
                options.not_before_ms.filter(|value| *value > now)
            ],
        )?;
        transaction.execute(
            "UPDATE drafts SET frozen = 1
             WHERE account_id = ?1 AND draft_id = ?2",
            rusqlite::params![account_id, draft_id],
        )?;
        bump_sequence(&transaction)?;
        let revision = revision_of(&transaction)?;
        transaction.commit()?;
        Ok(Admission::Queued(revision))
    }

    /// Records an exact-message command, applies its effect optimistically, and
    /// leaves the operation queued for the executor.
    pub fn admit_metadata(
        &mut self,
        account_id: &str,
        command_id: &str,
        message_ids: &[String],
        change: &Json,
    ) -> rusqlite::Result<Admission> {
        let Some(parsed) = MetadataChange::parse(change) else {
            return Ok(Admission::Rejected("unsupported"));
        };
        if account_id.is_empty() || command_id.is_empty() || message_ids.is_empty() {
            return Ok(Admission::Rejected("invalid"));
        }
        let mut targets = Vec::with_capacity(message_ids.len());
        for message_id in message_ids {
            let conversation_id: Option<String> = self
                .conn
                .query_row(
                    "SELECT conversation_id FROM effective_messages
                     WHERE account_id = ?1 AND message_id = ?2",
                    rusqlite::params![account_id, message_id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(conversation_id) = conversation_id else {
                return Ok(Admission::Rejected("invalid"));
            };
            targets.push((message_id.clone(), conversation_id));
        }
        let intent = json!({
            "kind": "metadata",
            "targets": message_ids,
            "change": change,
        });
        self.admit(account_id, command_id, &intent, change, &targets, parsed)
    }

    /// Resolves conversations to their stored messages and admits the change.
    /// Only an epoch mismatch is stale: a newer sequence still belongs to the
    /// same mirror and the selection is usable.
    pub fn admit_conversations(
        &mut self,
        account_id: &str,
        command_id: &str,
        conversation_ids: &[String],
        change: &Json,
        observed_epoch: &str,
    ) -> rusqlite::Result<Admission> {
        let Some(parsed) = MetadataChange::parse(change) else {
            return Ok(Admission::Rejected("unsupported"));
        };
        if account_id.is_empty() || command_id.is_empty() || conversation_ids.is_empty() {
            return Ok(Admission::Rejected("invalid"));
        }
        if self.revision()?.database_epoch != observed_epoch {
            return Ok(Admission::Rejected("stale_selection"));
        }

        let mut statement = self.conn.prepare(&format!(
            "SELECT message_id, conversation_id FROM effective_messages
             WHERE account_id = ?1 AND conversation_id IN ({})",
            placeholders(conversation_ids.len())
        ))?;
        let mut bindings: Vec<SqlValue> = Vec::with_capacity(conversation_ids.len() + 1);
        bindings.push(SqlValue::Text(account_id.to_string()));
        bindings.extend(
            conversation_ids
                .iter()
                .map(|conversation_id| SqlValue::Text(conversation_id.clone())),
        );
        let targets = {
            let rows = statement.query_map(params_from_iter(bindings), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        drop(statement);
        if targets.is_empty() {
            return Ok(Admission::Rejected("invalid"));
        }
        let intent = json!({
            "kind": "conversations",
            "conversations": conversation_ids,
            "change": change,
        });
        self.admit(account_id, command_id, &intent, change, &targets, parsed)
    }

    fn admit(
        &mut self,
        account_id: &str,
        command_id: &str,
        intent: &Json,
        change: &Json,
        targets: &[(String, String)],
        parsed: MetadataChange,
    ) -> rusqlite::Result<Admission> {
        let kind = intent
            .get("kind")
            .and_then(Json::as_str)
            .unwrap_or_default();
        let intent_json = serde_json::to_string(intent).unwrap_or_default();
        let change_json = serde_json::to_string(change).unwrap_or_default();
        let transaction = self.conn.transaction()?;
        let existing: Option<String> = transaction
            .query_row(
                "SELECT intent_json FROM operations
                 WHERE account_id = ?1 AND command_id = ?2",
                rusqlite::params![account_id, command_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            let revision = revision_of(&transaction)?;
            return Ok(if existing == intent_json {
                Admission::AlreadyRecorded(revision)
            } else {
                Admission::Rejected("invalid")
            });
        }
        let pending: i64 = transaction.query_row(
            &format!(
                "SELECT COUNT(*) FROM operations
                 WHERE account_id = ?1 AND status IN ({PENDING_STATUSES})"
            ),
            [account_id],
            |row| row.get(0),
        )?;
        if pending >= MAX_PENDING_OPERATIONS {
            return Ok(Admission::Rejected("queue_full"));
        }

        let now = now_ms();
        transaction.execute(
            "INSERT INTO operations(
               account_id, command_id, status, authority, kind, change_json,
               intent_json, attempts, created_at_ms, updated_at_ms
             ) VALUES (?1, ?2, 'queued', 'backend', ?3, ?4, ?5, 0, ?6, ?6)",
            rusqlite::params![account_id, command_id, kind, change_json, intent_json, now],
        )?;
        for (message_id, conversation_id) in targets {
            let Some(mut state) = load_state(&transaction, account_id, message_id)? else {
                continue;
            };
            let previous_json = serde_json::to_string(&state).unwrap_or_default();
            parsed.apply(&mut state);
            let mut pending = load_pending(&transaction, account_id, message_id)?;
            push_unique(&mut pending, command_id);
            write_state(&transaction, account_id, message_id, &state, &pending)?;
            transaction.execute(
                "INSERT OR IGNORE INTO operation_targets(
                   account_id, command_id, message_id, conversation_id, previous_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    account_id,
                    command_id,
                    message_id,
                    conversation_id,
                    previous_json
                ],
            )?;
        }
        bump_sequence(&transaction)?;
        let revision = revision_of(&transaction)?;
        transaction.commit()?;
        Ok(Admission::Queued(revision))
    }

    /// Commands the executor still owes the server, oldest first. `executing`
    /// rows are owned by a live attempt and must not be claimed again.
    pub fn pending_operations(&self, account_id: &str) -> rusqlite::Result<Vec<PendingOperation>> {
        let mut statement = self.conn.prepare(
            "SELECT command_id, status, kind, intent_json, attempts,
                    next_attempt_at_ms, created_at_ms
             FROM operations
             WHERE account_id = ?1 AND status IN ('queued', 'retry_wait')
             ORDER BY created_at_ms ASC, rowid ASC",
        )?;
        let rows = statement.query_map([account_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?;
        let mut operations = Vec::new();
        for row in rows {
            let (
                command_id,
                status,
                kind,
                intent_json,
                attempts,
                next_attempt_at_ms,
                created_at_ms,
            ) = row?;
            let Some(intent) = serde_json::from_str::<Json>(&intent_json)
                .ok()
                .and_then(|value| operation_intent(&kind, &value))
            else {
                continue;
            };
            operations.push(PendingOperation {
                account_id: account_id.to_string(),
                command_id,
                status,
                intent,
                attempts,
                next_attempt_at_ms,
                created_at_ms,
            });
        }
        Ok(operations)
    }

    pub fn operation_targets(
        &self,
        account_id: &str,
        command_id: &str,
    ) -> rusqlite::Result<Vec<OperationTarget>> {
        let mut statement = self.conn.prepare(
            "SELECT message_id, conversation_id FROM operation_targets
             WHERE account_id = ?1 AND command_id = ?2 ORDER BY rowid ASC",
        )?;
        let rows = statement.query_map(rusqlite::params![account_id, command_id], |row| {
            Ok(OperationTarget {
                message_id: row.get(0)?,
                conversation_id: row.get(1)?,
            })
        })?;
        rows.collect()
    }

    /// Sends whose delivery was never confirmed. Startup checks Sent for their
    /// deterministic Message-ID before leaving them unresolved.
    pub fn uncertain_send_ids(&self, account_id: &str) -> rusqlite::Result<Vec<String>> {
        let mut statement = self.conn.prepare(
            "SELECT command_id FROM operations
             WHERE account_id = ?1 AND kind = 'send' AND status = 'uncertain'
             ORDER BY created_at_ms ASC, rowid ASC",
        )?;
        let rows = statement.query_map([account_id], |row| row.get::<_, String>(0))?;
        rows.collect()
    }

    pub fn operation_state(
        &self,
        account_id: &str,
        command_id: &str,
    ) -> rusqlite::Result<Option<OperationState>> {
        self.conn
            .query_row(
                "SELECT status, attempts, next_attempt_at_ms, error_code, error_retryable
                 FROM operations WHERE account_id = ?1 AND command_id = ?2",
                rusqlite::params![account_id, command_id],
                |row| {
                    Ok(OperationState {
                        account_id: account_id.to_string(),
                        operation_id: command_id.to_string(),
                        status: row.get(0)?,
                        attempts: row.get(1)?,
                        next_attempt_at_ms: row.get(2)?,
                        error_code: row.get(3)?,
                        error_retryable: row.get::<_, i64>(4)? == 1,
                    })
                },
            )
            .optional()
    }

    /// Claims a due command for one execution attempt. Returns false when another
    /// attempt already owns it or it is no longer pending.
    pub fn begin_operation(
        &mut self,
        account_id: &str,
        command_id: &str,
    ) -> rusqlite::Result<bool> {
        let changed = self.conn.execute(
            "UPDATE operations
             SET status = 'executing', attempts = attempts + 1,
                 next_attempt_at_ms = NULL, updated_at_ms = ?3
             WHERE account_id = ?1 AND command_id = ?2
               AND status IN ('queued', 'retry_wait')",
            rusqlite::params![account_id, command_id, now_ms()],
        )?;
        Ok(changed == 1)
    }

    /// A crash can leave a command `executing` with no live attempt. Metadata is
    /// safe to replay; a send may already have reached the server, so it is
    /// marked uncertain instead of being sent twice.
    pub fn requeue_interrupted(&mut self, account_id: &str) -> rusqlite::Result<usize> {
        let transaction = self.conn.transaction()?;
        let sends = {
            let mut statement = transaction.prepare(
                "SELECT command_id, intent_json FROM operations
                 WHERE account_id = ?1 AND kind = 'send' AND status = 'executing'",
            )?;
            let rows = statement.query_map([account_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let now = now_ms();
        for (command_id, intent_json) in &sends {
            transaction.execute(
                "UPDATE operations
                 SET status = 'uncertain', error_code = 'interrupted', error_retryable = 0,
                     next_attempt_at_ms = NULL, updated_at_ms = ?3
                 WHERE account_id = ?1 AND command_id = ?2",
                rusqlite::params![account_id, command_id, now],
            )?;
            let draft_id = serde_json::from_str::<Json>(intent_json)
                .ok()
                .and_then(|value| SendIntent::parse(&value))
                .map(|intent| intent.draft_id);
            if let Some(draft_id) = draft_id {
                transaction.execute(
                    "UPDATE drafts SET frozen = 0
                     WHERE account_id = ?1 AND draft_id = ?2",
                    rusqlite::params![account_id, draft_id],
                )?;
            }
        }
        let changed = transaction.execute(
            "UPDATE operations
             SET status = 'retry_wait', next_attempt_at_ms = NULL,
                 error_code = 'interrupted', error_retryable = 1, updated_at_ms = ?2
             WHERE account_id = ?1 AND status = 'executing'",
            rusqlite::params![account_id, now],
        )? + sends.len();
        if changed > 0 {
            bump_sequence(&transaction)?;
        }
        transaction.commit()?;
        Ok(changed)
    }

    pub fn retry_operation(
        &mut self,
        account_id: &str,
        command_id: &str,
        error_code: &str,
        next_attempt_at_ms: i64,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE operations
             SET status = 'retry_wait', error_code = ?3, error_retryable = 1,
                 next_attempt_at_ms = ?4, updated_at_ms = ?5
             WHERE account_id = ?1 AND command_id = ?2",
            rusqlite::params![
                account_id,
                command_id,
                error_code,
                next_attempt_at_ms,
                now_ms()
            ],
        )?;
        Ok(())
    }

    pub fn succeed_operation(
        &mut self,
        account_id: &str,
        command_id: &str,
    ) -> rusqlite::Result<()> {
        self.conclude(account_id, command_id, "succeeded", false, None)
    }

    pub fn fail_operation(
        &mut self,
        account_id: &str,
        command_id: &str,
        error_code: &str,
        retryable: bool,
    ) -> rusqlite::Result<()> {
        self.conclude(
            account_id,
            command_id,
            "failed",
            true,
            Some((error_code, retryable)),
        )
    }

    /// A send whose DATA block left the client but whose verdict never arrived.
    /// It is never retried automatically.
    pub fn uncertain_operation(
        &mut self,
        account_id: &str,
        command_id: &str,
        error_code: &str,
    ) -> rusqlite::Result<()> {
        self.conclude(
            account_id,
            command_id,
            "uncertain",
            false,
            Some((error_code, false)),
        )
    }

    /// Cancels a command the executor has not started. Returns false when it is
    /// too late (already executing or finished).
    pub fn cancel_operation(
        &mut self,
        account_id: &str,
        command_id: &str,
    ) -> rusqlite::Result<bool> {
        let status: Option<String> = self
            .conn
            .query_row(
                "SELECT status FROM operations WHERE account_id = ?1 AND command_id = ?2",
                rusqlite::params![account_id, command_id],
                |row| row.get(0),
            )
            .optional()?;
        match status.as_deref() {
            Some("queued") | Some("retry_wait") => {
                self.conclude(account_id, command_id, "cancelled", true, None)?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    fn conclude(
        &mut self,
        account_id: &str,
        command_id: &str,
        status: &str,
        revert: bool,
        error: Option<(&str, bool)>,
    ) -> rusqlite::Result<()> {
        let transaction = self.conn.transaction()?;
        // A send that did not succeed hands its frozen draft back to the user.
        if status != "succeeded" {
            let operation: Option<(String, String)> = transaction
                .query_row(
                    "SELECT kind, intent_json FROM operations
                     WHERE account_id = ?1 AND command_id = ?2",
                    rusqlite::params![account_id, command_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((kind, intent_json)) = operation {
                let draft_id = (kind == "send")
                    .then(|| serde_json::from_str::<Json>(&intent_json).ok())
                    .flatten()
                    .and_then(|value| SendIntent::parse(&value))
                    .map(|intent| intent.draft_id);
                if let Some(draft_id) = draft_id {
                    transaction.execute(
                        "UPDATE drafts SET frozen = 0
                         WHERE account_id = ?1 AND draft_id = ?2",
                        rusqlite::params![account_id, draft_id],
                    )?;
                }
            }
        }
        let targets = {
            let mut statement = transaction.prepare(
                "SELECT message_id, previous_json FROM operation_targets
                 WHERE account_id = ?1 AND command_id = ?2",
            )?;
            let rows = statement.query_map(rusqlite::params![account_id, command_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (message_id, previous_json) in targets {
            let mut pending = load_pending(&transaction, account_id, &message_id)?;
            pending.retain(|id| id != command_id);
            if revert {
                if let Ok(state) = serde_json::from_str::<MessageState>(&previous_json) {
                    write_state(&transaction, account_id, &message_id, &state, &pending)?;
                    continue;
                }
            }
            write_pending(&transaction, account_id, &message_id, &pending)?;
        }
        // Targets stay behind as the command's audit trail: diagnostics and
        // `observeOperation` still name what a finished command touched.
        let (error_code, retryable) = error.unwrap_or(("", false));
        transaction.execute(
            "UPDATE operations
             SET status = ?3, error_code = ?4, error_retryable = ?5,
                 next_attempt_at_ms = NULL, updated_at_ms = ?6
             WHERE account_id = ?1 AND command_id = ?2",
            rusqlite::params![
                account_id,
                command_id,
                status,
                error.is_some().then_some(error_code),
                retryable as i64,
                now_ms()
            ],
        )?;
        bump_sequence(&transaction)?;
        transaction.commit()
    }

    /// Points a moved message at its destination folder, so a UIDVALIDITY change
    /// in the source page does not delete the row.
    pub fn relocate_message(
        &mut self,
        account_id: &str,
        message_id: &str,
        folder: &str,
    ) -> rusqlite::Result<()> {
        let changed = self.conn.execute(
            "UPDATE effective_messages SET folder_id = ?3
             WHERE account_id = ?1 AND message_id = ?2",
            rusqlite::params![account_id, message_id, folder],
        )?;
        if changed > 0 {
            bump_sequence(&self.conn)?;
        }
        Ok(())
    }

    /// Replaces (or drops) the server coordinate of a message after a move.
    pub fn set_remote(
        &mut self,
        account_id: &str,
        message_id: &str,
        remote: Option<&RemoteMessage>,
    ) -> rusqlite::Result<()> {
        match remote {
            Some(remote) => {
                self.conn.execute(
                    "INSERT INTO message_remote(account_id, message_id, folder, uid_validity, uid)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(account_id, message_id) DO UPDATE SET
                       folder = excluded.folder,
                       uid_validity = excluded.uid_validity,
                       uid = excluded.uid",
                    rusqlite::params![
                        account_id,
                        message_id,
                        remote.folder,
                        i64::from(remote.uid_validity),
                        i64::from(remote.uid)
                    ],
                )?;
            }
            None => {
                self.conn.execute(
                    "DELETE FROM message_remote WHERE account_id = ?1 AND message_id = ?2",
                    rusqlite::params![account_id, message_id],
                )?;
            }
        }
        Ok(())
    }

    pub fn diagnostics(&self, account_id: &str) -> rusqlite::Result<Diagnostics> {
        let revision = self.revision()?;
        let (pending_operations, oldest_pending_at_ms): (i64, Option<i64>) = self.conn.query_row(
            &format!(
                "SELECT COUNT(*), MIN(created_at_ms) FROM operations
                     WHERE account_id = ?1 AND status IN ({PENDING_STATUSES})"
            ),
            [account_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let uncertain_operations: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM operations WHERE account_id = ?1 AND status = 'uncertain'",
            [account_id],
            |row| row.get(0),
        )?;

        let mut statement = self.conn.prepare(
            "SELECT command_id, status, kind, change_json FROM operations
             WHERE account_id = ?1 ORDER BY created_at_ms ASC, rowid ASC",
        )?;
        let rows = statement.query_map([account_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        let mut commands = Vec::new();
        for row in rows {
            let (operation_id, status, kind, change_json) = row?;
            let change: Json = serde_json::from_str(&change_json).unwrap_or(Json::Null);
            let mut message_ids = Vec::new();
            let mut conversation_ids = Vec::new();
            for target in self.operation_targets(account_id, &operation_id)? {
                push_unique(&mut message_ids, &target.message_id);
                push_unique(&mut conversation_ids, &target.conversation_id);
            }
            commands.push(DiagnosticCommand {
                operation_id,
                status,
                kind,
                change_kind: change
                    .get("kind")
                    .and_then(Json::as_str)
                    .map(str::to_string),
                change,
                message_ids,
                conversation_ids,
            });
        }
        Ok(Diagnostics {
            account_id: account_id.to_string(),
            revision,
            coverage: self.coverage(&[account_id.to_string()])?,
            pending_operations,
            uncertain_operations,
            oldest_pending_at_ms,
            commands,
        })
    }

    /// Writes one folder page and advances the revision fence in a single
    /// transaction, so subscribers never observe a half-applied page.
    ///
    /// A changed `UIDVALIDITY` means the server reassigned UIDs, so the folder's
    /// mirrored rows are dropped before the new page is written.
    pub fn apply_sync(&mut self, account_id: &str, sync: &FolderSync) -> rusqlite::Result<()> {
        let transaction = self.conn.transaction()?;
        let previous: Option<i64> = transaction
            .query_row(
                "SELECT uid_validity FROM folder_state WHERE account_id = ?1 AND folder = ?2",
                rusqlite::params![account_id, sync.folder],
                |row| row.get(0),
            )
            .optional()?;
        if previous != Some(i64::from(sync.uid_validity)) {
            // Bodies belong to messages that are about to disappear; drop them
            // before the rows they describe so none are left unreachable.
            transaction.execute(
                "DELETE FROM message_content
                 WHERE account_id = ?1 AND message_id IN (
                   SELECT message_id FROM effective_messages
                   WHERE account_id = ?1 AND folder_id = ?2
                 )",
                rusqlite::params![account_id, sync.folder],
            )?;
            transaction.execute(
                "DELETE FROM message_remote WHERE account_id = ?1 AND folder = ?2",
                rusqlite::params![account_id, sync.folder],
            )?;
            transaction.execute(
                "DELETE FROM effective_messages WHERE account_id = ?1 AND folder_id = ?2",
                rusqlite::params![account_id, sync.folder],
            )?;
        }

        let (in_inbox, in_sent, in_draft, in_trash, in_spam) = sync.role.flags();
        {
            let mut statement = transaction.prepare(UPSERT_MESSAGE_SQL)?;
            let mut remote = transaction.prepare(
                "INSERT INTO message_remote(account_id, message_id, folder, uid_validity, uid)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(account_id, message_id) DO UPDATE SET
                   folder = excluded.folder,
                   uid_validity = excluded.uid_validity,
                   uid = excluded.uid",
            )?;
            for message in &sync.messages {
                let to_json = serde_json::to_string(&message.to_addresses)
                    .unwrap_or_else(|_| "[]".to_string());
                statement.execute(rusqlite::params![
                    account_id,
                    message.message_id,
                    message.conversation_id,
                    message.subject,
                    message.from_address,
                    to_json,
                    message.received_at_ms,
                    message.read as i64,
                    message.starred as i64,
                    sync.folder,
                    sync.role.roles_json(),
                    in_inbox,
                    in_sent,
                    in_draft,
                    in_trash,
                    in_spam,
                    message.has_attachments as i64,
                ])?;
                remote.execute(rusqlite::params![
                    account_id,
                    message.message_id,
                    sync.folder,
                    i64::from(sync.uid_validity),
                    i64::from(message.uid),
                ])?;
            }
        }

        transaction.execute(
            "INSERT INTO folder_state(account_id, folder, uid_validity)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(account_id, folder) DO UPDATE SET uid_validity = excluded.uid_validity",
            rusqlite::params![account_id, sync.folder, i64::from(sync.uid_validity)],
        )?;
        // A page is a window into the folder, never the whole of it.
        transaction.execute(
            "INSERT INTO coverage(account_id, scope_id, metadata, content, indexed_content, last_completed_sync_at_ms)
             VALUES (?1, ?2, 'partial', 'partial', 'not_requested', ?3)
             ON CONFLICT(account_id, scope_id) DO UPDATE SET
               metadata = excluded.metadata,
               content = excluded.content,
               last_completed_sync_at_ms = excluded.last_completed_sync_at_ms",
            rusqlite::params![account_id, sync.folder, now_ms()],
        )?;
        transaction.execute(
            "UPDATE profile_state SET sequence = sequence + 1 WHERE id = 1",
            [],
        )?;
        transaction.commit()
    }
}

struct DraftContent {
    from: Option<String>,
    to: Vec<String>,
    cc: Vec<String>,
    bcc: Vec<String>,
    subject: String,
    html: String,
    quoted_html: String,
}

fn draft_content(value: &Json) -> Option<DraftContent> {
    if !value.is_object() {
        return None;
    }
    Some(DraftContent {
        from: value.get("from").and_then(Json::as_str).map(str::to_string),
        to: required_string_array(value.get("to"))?,
        cc: required_string_array(value.get("cc"))?,
        bcc: required_string_array(value.get("bcc"))?,
        subject: value.get("subject")?.as_str()?.to_string(),
        html: value.get("editableHtml")?.as_str()?.to_string(),
        quoted_html: value.get("quotedHtml")?.as_str()?.to_string(),
    })
}

fn operation_intent(kind: &str, value: &Json) -> Option<OperationIntent> {
    if kind == "send" {
        return Some(OperationIntent::Send(Box::new(SendIntent::parse(value)?)));
    }
    Some(OperationIntent::Metadata(MetadataChange::parse(
        value.get("change")?,
    )?))
}

fn required_string_array(value: Option<&Json>) -> Option<Vec<String>> {
    value?
        .as_array()?
        .iter()
        .map(|entry| entry.as_str().map(str::to_string))
        .collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn revision_of(conn: &Connection) -> rusqlite::Result<LocalRevision> {
    conn.query_row(
        "SELECT database_epoch, sequence FROM profile_state WHERE id = 1",
        [],
        |row| {
            Ok(LocalRevision {
                database_epoch: row.get(0)?,
                sequence: row.get(1)?,
            })
        },
    )
}

fn bump_sequence(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE profile_state SET sequence = sequence + 1 WHERE id = 1",
        [],
    )?;
    Ok(())
}

fn load_state(
    conn: &Connection,
    account_id: &str,
    message_id: &str,
) -> rusqlite::Result<Option<MessageState>> {
    conn.query_row(
        "SELECT read, starred, folder_id, roles_json, label_ids_json,
                category_ids_json, in_inbox, in_sent, in_draft, in_trash,
                in_spam, snoozed_until_ms
         FROM effective_messages WHERE account_id = ?1 AND message_id = ?2",
        rusqlite::params![account_id, message_id],
        |row| {
            Ok(MessageState {
                read: row.get::<_, i64>(0)? == 1,
                starred: row.get::<_, i64>(1)? == 1,
                folder_id: row.get(2)?,
                roles: parse_json_array(&row.get::<_, String>(3)?),
                label_ids: parse_json_array(&row.get::<_, String>(4)?),
                category_ids: parse_json_array(&row.get::<_, String>(5)?),
                in_inbox: row.get::<_, i64>(6)? == 1,
                in_sent: row.get::<_, i64>(7)? == 1,
                in_draft: row.get::<_, i64>(8)? == 1,
                in_trash: row.get::<_, i64>(9)? == 1,
                in_spam: row.get::<_, i64>(10)? == 1,
                snoozed_until_ms: row.get(11)?,
            })
        },
    )
    .optional()
}

fn write_state(
    conn: &Connection,
    account_id: &str,
    message_id: &str,
    state: &MessageState,
    pending: &[String],
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE effective_messages SET
           read = ?3, starred = ?4, folder_id = ?5, roles_json = ?6,
           label_ids_json = ?7, category_ids_json = ?8,
           in_inbox = ?9, in_sent = ?10, in_draft = ?11, in_trash = ?12,
           in_spam = ?13, snoozed_until_ms = ?14, pending_operation_ids_json = ?15
         WHERE account_id = ?1 AND message_id = ?2",
        rusqlite::params![
            account_id,
            message_id,
            state.read as i64,
            state.starred as i64,
            state.folder_id,
            json_array(&state.roles),
            json_array(&state.label_ids),
            json_array(&state.category_ids),
            state.in_inbox as i64,
            state.in_sent as i64,
            state.in_draft as i64,
            state.in_trash as i64,
            state.in_spam as i64,
            state.snoozed_until_ms,
            json_array(pending),
        ],
    )?;
    Ok(())
}

fn write_pending(
    conn: &Connection,
    account_id: &str,
    message_id: &str,
    pending: &[String],
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE effective_messages SET pending_operation_ids_json = ?3
         WHERE account_id = ?1 AND message_id = ?2",
        rusqlite::params![account_id, message_id, json_array(pending)],
    )?;
    Ok(())
}

fn load_pending(
    conn: &Connection,
    account_id: &str,
    message_id: &str,
) -> rusqlite::Result<Vec<String>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT pending_operation_ids_json FROM effective_messages
             WHERE account_id = ?1 AND message_id = ?2",
            rusqlite::params![account_id, message_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(raw.map(|raw| parse_json_array(&raw)).unwrap_or_default())
}

fn json_array(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_string())
}

fn push_unique(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_string());
    }
}

fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}

fn parse_json_array(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    let present = conn
        .query_row(
            "SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2",
            rusqlite::params![table, column],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if present.is_none() {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {definition}"), [])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> MailStore {
        let path = std::env::temp_dir().join(format!("onemail-store-{}.sqlite", Uuid::new_v4()));
        MailStore::open(path).expect("opens")
    }

    fn mailbox(name: &str) -> MailboxFilter {
        MailboxFilter::from_predicate(&serde_json::json!({ "kind": "mailbox", "mailbox": name }))
    }

    fn filter(predicate: serde_json::Value) -> MailboxFilter {
        MailboxFilter::from_predicate(&predicate)
    }

    fn text(field: &str, value: &str, matching: &str) -> MailboxFilter {
        filter(serde_json::json!({
            "kind": "text",
            "field": field,
            "value": value,
            "match": matching,
        }))
    }

    fn subjects(store: &MailStore, filter: &MailboxFilter) -> Vec<String> {
        store
            .conversations(&["acc-1".to_string()], filter, 50)
            .expect("reads")
            .into_iter()
            .map(|conversation| conversation.subject)
            .collect()
    }

    #[test]
    fn creates_a_revision_fence_once() {
        let store = temp_store();
        let first = store.revision().expect("reads revision");
        assert_eq!(first.sequence, 0);
        assert!(!first.database_epoch.is_empty());

        let again = MailStore::open(store.path()).expect("reopens");
        assert_eq!(again.revision().expect("reads revision"), first);
    }

    #[test]
    fn an_empty_mirror_answers_zeros() {
        let store = temp_store();
        store.register_account("acc-1").expect("registers");
        assert_eq!(
            store
                .counts(&["acc-1".to_string()], &mailbox("inbox"))
                .expect("counts"),
            (0, 0)
        );
        assert!(store
            .conversations(&["acc-1".to_string()], &mailbox("inbox"), 50)
            .expect("reads")
            .is_empty());
    }

    #[test]
    fn unknown_predicates_read_as_empty() {
        let store = temp_store();
        store.register_account("acc-1").expect("registers");
        let filter = MailboxFilter::from_predicate(&serde_json::json!({ "kind": "nonsense" }));
        assert_eq!(
            store
                .counts(&["acc-1".to_string()], &filter)
                .expect("counts"),
            (0, 0)
        );
    }

    fn synced(
        uid: u32,
        conversation: &str,
        subject: &str,
        read: bool,
        at_ms: i64,
    ) -> SyncedMessage {
        SyncedMessage {
            message_id: format!("m-{uid}@example.com"),
            conversation_id: conversation.to_string(),
            subject: subject.to_string(),
            from_address: "ana@example.com".to_string(),
            to_addresses: vec!["me@example.com".to_string()],
            received_at_ms: at_ms,
            read,
            starred: false,
            has_attachments: false,
            uid,
        }
    }

    fn page(uid_validity: u32, role: FolderRole, messages: Vec<SyncedMessage>) -> FolderSync {
        FolderSync {
            folder: "INBOX".to_string(),
            role,
            uid_validity,
            messages,
        }
    }

    #[test]
    fn a_synced_page_becomes_conversations_and_counts() {
        let mut store = temp_store();
        store.register_account("acc-1").expect("registers");
        let ids = vec!["acc-1".to_string()];

        store
            .apply_sync(
                "acc-1",
                &page(
                    7,
                    FolderRole::Inbox,
                    vec![
                        synced(1, "thread-a@example.com", "First", false, 1_000),
                        synced(2, "thread-a@example.com", "First", true, 2_000),
                        synced(3, "thread-b@example.com", "Second", false, 3_000),
                    ],
                ),
            )
            .expect("applies");

        assert_eq!(
            store.counts(&ids, &mailbox("inbox")).expect("counts"),
            (2, 2)
        );
        assert_eq!(store.revision().expect("revision").sequence, 1);
        assert_eq!(store.coverage(&ids).expect("coverage").len(), 1);

        let conversations = store
            .conversations(&ids, &mailbox("inbox"), 50)
            .expect("reads");
        assert_eq!(conversations.len(), 2);
        assert_eq!(conversations[0].subject, "Second");
        assert!(conversations[0].unread);
        assert_eq!(conversations[1].roles, vec!["inbox".to_string()]);
    }

    #[test]
    fn a_sent_page_lands_in_sent_not_inbox() {
        let mut store = temp_store();
        store.register_account("acc-1").expect("registers");
        let ids = vec!["acc-1".to_string()];

        store
            .apply_sync(
                "acc-1",
                &FolderSync {
                    folder: "Sent".to_string(),
                    role: FolderRole::Sent,
                    uid_validity: 1,
                    messages: vec![synced(9, "sent@example.com", "Re: hello", true, 5_000)],
                },
            )
            .expect("applies");

        assert_eq!(
            store.counts(&ids, &mailbox("sent")).expect("counts"),
            (1, 0)
        );
        assert_eq!(
            store.counts(&ids, &mailbox("inbox")).expect("counts"),
            (0, 0)
        );
    }

    #[test]
    fn re_applying_a_page_updates_instead_of_duplicating() {
        let mut store = temp_store();
        store.register_account("acc-1").expect("registers");
        let sync = page(
            3,
            FolderRole::Inbox,
            vec![synced(4, "thread@example.com", "Hello", false, 1_000)],
        );

        store.apply_sync("acc-1", &sync).expect("applies");
        store.apply_sync("acc-1", &sync).expect("applies again");

        let ids = vec!["acc-1".to_string()];
        assert_eq!(
            store.counts(&ids, &mailbox("inbox")).expect("counts"),
            (1, 1)
        );
        assert_eq!(store.revision().expect("revision").sequence, 2);
    }

    fn body(html: &str, preview: &str) -> StoredContent {
        StoredContent {
            html: Some(html.to_string()),
            text: None,
            attachments_json:
                r#"[{"attachmentId":"0","filename":"note.txt","mimeType":"text/plain","size":3,"inline":false,"contentId":null}]"#
                    .to_string(),
            is_meeting_invitation: false,
            preview: preview.to_string(),
            search_text: preview.to_string(),
            has_attachments: true,
        }
    }

    #[test]
    fn a_synced_page_records_the_server_location() {
        let mut store = temp_store();
        store.register_account("acc-1").expect("registers");
        store
            .apply_sync(
                "acc-1",
                &page(
                    9,
                    FolderRole::Inbox,
                    vec![synced(42, "thread@example.com", "Hello", true, 1_000)],
                ),
            )
            .expect("applies");

        let remote = store
            .remote_message("acc-1", "m-42@example.com")
            .expect("reads")
            .expect("has a location");
        assert_eq!(remote.folder, "INBOX");
        assert_eq!(remote.uid_validity, 9);
        assert_eq!(remote.uid, 42);
        assert!(store
            .remote_message("acc-1", "missing@example.com")
            .expect("reads")
            .is_none());
    }

    #[test]
    fn a_saved_body_lands_in_the_conversation_and_bumps_the_revision() {
        let mut store = temp_store();
        store.register_account("acc-1").expect("registers");
        store
            .apply_sync(
                "acc-1",
                &page(
                    1,
                    FolderRole::Inbox,
                    vec![
                        synced(1, "thread@example.com", "First", true, 1_000),
                        synced(2, "thread@example.com", "Second", true, 2_000),
                    ],
                ),
            )
            .expect("applies");
        let before = store.revision().expect("revision").sequence;

        assert!(store
            .save_content("acc-1", "m-2@example.com", &body("<p>Hi</p>", "Hi"))
            .expect("saves"));

        let view = store
            .conversation("acc-1", "thread@example.com", None, 50)
            .expect("reads");
        assert_eq!(view.messages.len(), 2);
        assert_eq!(view.messages[1].metadata.preview, "Hi");
        assert!(view.messages[1].metadata.has_attachments);
        assert!(matches!(
            view.messages[0].content,
            MessageContent::NotRequested
        ));
        match &view.messages[1].content {
            MessageContent::Available {
                html, attachments, ..
            } => {
                assert_eq!(html.as_deref(), Some("<p>Hi</p>"));
                assert_eq!(attachments[0].filename, "note.txt");
            }
            other => panic!("expected available content, got {other:?}"),
        }
        assert!(store.revision().expect("revision").sequence > before);
        assert_eq!(view.coverage.len(), 1);
    }

    #[test]
    fn a_conversation_pages_oldest_first_and_stops_when_it_ends() {
        let mut store = temp_store();
        store.register_account("acc-1").expect("registers");
        store
            .apply_sync(
                "acc-1",
                &page(
                    1,
                    FolderRole::Inbox,
                    vec![
                        synced(3, "thread@example.com", "Third", true, 3_000),
                        synced(1, "thread@example.com", "First", true, 1_000),
                        synced(2, "thread@example.com", "Second", true, 2_000),
                    ],
                ),
            )
            .expect("applies");

        let first = store
            .conversation("acc-1", "thread@example.com", None, 2)
            .expect("reads");
        assert_eq!(
            first
                .messages
                .iter()
                .map(|message| message.metadata.subject.as_str())
                .collect::<Vec<_>>(),
            vec!["First", "Second"]
        );
        assert_eq!(first.next_page.as_deref(), Some("m-2@example.com"));

        let second = store
            .conversation("acc-1", "thread@example.com", first.next_page.as_deref(), 2)
            .expect("reads");
        assert_eq!(second.messages.len(), 1);
        assert_eq!(second.messages[0].metadata.subject, "Third");
        assert!(second.next_page.is_none());

        // An unknown cursor restarts at the first page rather than going empty.
        let restarted = store
            .conversation("acc-1", "thread@example.com", Some("gone@example.com"), 2)
            .expect("reads");
        assert_eq!(restarted.messages.len(), 2);
    }

    #[test]
    fn a_header_resync_keeps_the_attachment_flag_a_body_taught_it() {
        let mut store = temp_store();
        store.register_account("acc-1").expect("registers");
        let page_sync = page(
            1,
            FolderRole::Inbox,
            vec![synced(1, "thread@example.com", "Hello", true, 1_000)],
        );
        store.apply_sync("acc-1", &page_sync).expect("applies");
        store
            .save_content("acc-1", "m-1@example.com", &body("<p>Hi</p>", "Hi"))
            .expect("saves");

        // The renderer syncs on every launch; that page only has headers.
        store.apply_sync("acc-1", &page_sync).expect("applies");

        let view = store
            .conversation("acc-1", "thread@example.com", None, 50)
            .expect("reads");
        assert!(view.messages[0].metadata.has_attachments);
        assert_eq!(view.messages[0].metadata.preview, "Hi");
    }

    #[test]
    fn a_body_is_dropped_when_its_message_is_no_longer_mirrored() {
        let mut store = temp_store();
        store.register_account("acc-1").expect("registers");
        store
            .apply_sync(
                "acc-1",
                &page(
                    1,
                    FolderRole::Inbox,
                    vec![synced(1, "thread@example.com", "Hello", true, 1_000)],
                ),
            )
            .expect("applies");

        store.forget_account("acc-1").expect("forgets");
        assert!(!store
            .save_content("acc-1", "m-1@example.com", &body("<p>late</p>", "late"))
            .expect("drops"));
        assert!(!store
            .has_content("acc-1", "m-1@example.com")
            .expect("reads"));
    }

    #[test]
    fn a_new_uid_validity_replaces_the_folders_rows() {
        let mut store = temp_store();
        store.register_account("acc-1").expect("registers");
        let message = |id: &str, conversation: &str, subject: &str, at_ms: i64| SyncedMessage {
            message_id: id.to_string(),
            conversation_id: conversation.to_string(),
            subject: subject.to_string(),
            from_address: "ana@example.com".to_string(),
            to_addresses: Vec::new(),
            received_at_ms: at_ms,
            read: true,
            starred: false,
            has_attachments: false,
            uid: 1,
        };

        store
            .apply_sync(
                "acc-1",
                &page(
                    1,
                    FolderRole::Inbox,
                    vec![message("imap:1:5", "old@example.com", "Old", 1_000)],
                ),
            )
            .expect("applies");
        store
            .save_content(
                "acc-1",
                "imap:1:5",
                &StoredContent {
                    html: Some("<p>Old</p>".to_string()),
                    text: None,
                    attachments_json: "[]".to_string(),
                    is_meeting_invitation: false,
                    preview: "Old".to_string(),
                    search_text: "Old".to_string(),
                    has_attachments: false,
                },
            )
            .expect("saves");
        store
            .apply_sync(
                "acc-1",
                &page(
                    2,
                    FolderRole::Inbox,
                    vec![message("imap:2:5", "new@example.com", "New", 2_000)],
                ),
            )
            .expect("applies");

        let ids = vec!["acc-1".to_string()];
        let conversations = store
            .conversations(&ids, &mailbox("inbox"), 50)
            .expect("reads");
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0].subject, "New");
        assert!(!store.has_content("acc-1", "imap:1:5").expect("reads"));
        assert!(store
            .remote_message("acc-1", "imap:1:5")
            .expect("reads")
            .is_none());
    }

    #[test]
    fn text_predicates_match_subject_sender_and_stored_bodies() {
        let mut store = temp_store();
        store.register_account("acc-1").expect("registers");
        let mut dana = synced(2, "dana@example.com", "Hello", true, 2_000);
        dana.from_address = "dana@example.com".to_string();
        store
            .apply_sync(
                "acc-1",
                &page(
                    1,
                    FolderRole::Inbox,
                    vec![
                        synced(1, "quarterly@example.com", "Quarterly numbers", true, 1_000),
                        dana,
                        synced(3, "report@example.com", "Report", true, 3_000),
                    ],
                ),
            )
            .expect("applies");

        assert_eq!(
            subjects(&store, &text("any", "quarterly", "term")),
            vec!["Quarterly numbers"]
        );
        assert_eq!(
            subjects(&store, &text("any", "dana", "term")),
            vec!["Hello"]
        );
        // "grew" lives only in the body, which the mirror learns on hydration.
        assert!(subjects(&store, &text("any", "grew", "term")).is_empty());

        let mut content = body(
            "<p>Revenue grew 12 percent this quarter</p>",
            "Revenue grew 12 percent",
        );
        content.search_text =
            "Revenue grew 12 percent this quarter, with a long tail of detail".to_string();
        store
            .save_content("acc-1", "m-3@example.com", &content)
            .expect("saves");

        assert_eq!(
            subjects(&store, &text("any", "grew", "term")),
            vec!["Report"]
        );
        assert_eq!(
            subjects(&store, &text("body", "long tail", "term")),
            vec!["Report"]
        );
        assert!(subjects(&store, &text("subject", "grew", "term")).is_empty());
        assert_eq!(
            subjects(&store, &text("any", "revenue grew", "phrase")),
            vec!["Report"]
        );
        assert!(subjects(&store, &text("any", "grew revenue", "phrase")).is_empty());
        assert!(subjects(&store, &text("any", "revenue yearly", "term")).is_empty());
    }

    #[test]
    fn text_search_treats_wildcards_as_literal_characters() {
        let mut store = temp_store();
        store.register_account("acc-1").expect("registers");
        store
            .apply_sync(
                "acc-1",
                &page(
                    1,
                    FolderRole::Inbox,
                    vec![
                        synced(1, "hundred@example.com", "100% done", true, 1_000),
                        synced(2, "other@example.com", "1000 done", true, 2_000),
                    ],
                ),
            )
            .expect("applies");

        assert_eq!(
            subjects(&store, &text("subject", "100%", "term")),
            vec!["100% done"]
        );
        assert!(subjects(&store, &text("subject", "100_", "term")).is_empty());
    }

    #[test]
    fn boolean_predicates_nest_read_and_starred() {
        let mut store = temp_store();
        store.register_account("acc-1").expect("registers");
        let mut starred = synced(2, "star@example.com", "Starred", true, 2_000);
        starred.starred = true;
        store
            .apply_sync(
                "acc-1",
                &page(
                    1,
                    FolderRole::Inbox,
                    vec![
                        synced(1, "unread@example.com", "Unread", false, 1_000),
                        starred,
                    ],
                ),
            )
            .expect("applies");

        let read_and_starred = filter(serde_json::json!({
            "kind": "all",
            "predicates": [
                { "kind": "read", "value": true },
                { "kind": "starred", "value": true },
            ],
        }));
        assert_eq!(subjects(&store, &read_and_starred), vec!["Starred"]);

        let unread_or_starred = filter(serde_json::json!({
            "kind": "any",
            "predicates": [
                { "kind": "read", "value": false },
                { "kind": "starred", "value": true },
            ],
        }));
        assert_eq!(
            subjects(&store, &unread_or_starred),
            vec!["Starred", "Unread"]
        );

        let not_read = filter(serde_json::json!({
            "kind": "not",
            "predicate": { "kind": "read", "value": true },
        }));
        assert_eq!(subjects(&store, &not_read), vec!["Unread"]);

        // An empty all matches everything, an empty any nothing.
        let empty_all = filter(serde_json::json!({ "kind": "all", "predicates": [] }));
        assert_eq!(subjects(&store, &empty_all).len(), 2);
        let empty_any = filter(serde_json::json!({ "kind": "any", "predicates": [] }));
        assert!(subjects(&store, &empty_any).is_empty());
    }

    #[test]
    fn address_received_and_membership_predicates_read_header_columns() {
        let mut store = temp_store();
        store.register_account("acc-1").expect("registers");
        let mut dana = synced(2, "dana@example.com", "Second", true, 2_000);
        dana.from_address = "Dana@Other.test".to_string();
        store
            .apply_sync(
                "acc-1",
                &page(
                    1,
                    FolderRole::Inbox,
                    vec![synced(1, "ana@example.com", "First", true, 1_000), dana],
                ),
            )
            .expect("applies");

        let from_address = filter(serde_json::json!({
            "kind": "address", "field": "from", "value": "ana@example.com", "match": "address",
        }));
        assert_eq!(subjects(&store, &from_address), vec!["First"]);

        let from_domain = filter(serde_json::json!({
            "kind": "address", "field": "from", "value": "other.test", "match": "domain",
        }));
        assert_eq!(subjects(&store, &from_domain), vec!["Second"]);

        let to_me = filter(serde_json::json!({
            "kind": "address", "field": "to", "value": "me@example.com", "match": "address",
        }));
        assert_eq!(subjects(&store, &to_me).len(), 2);

        let after = filter(serde_json::json!({
            "kind": "received", "afterMs": 1_500, "beforeMs": null,
        }));
        assert_eq!(subjects(&store, &after), vec!["Second"]);

        let before = filter(serde_json::json!({
            "kind": "received", "afterMs": null, "beforeMs": 1_500,
        }));
        assert_eq!(subjects(&store, &before), vec!["First"]);

        let all_time = filter(serde_json::json!({
            "kind": "received", "afterMs": null, "beforeMs": null,
        }));
        assert_eq!(subjects(&store, &all_time).len(), 2);

        let in_folder = filter(serde_json::json!({
            "kind": "membership", "membership": "folder", "id": "INBOX",
        }));
        assert_eq!(subjects(&store, &in_folder).len(), 2);

        let in_sent = filter(serde_json::json!({
            "kind": "membership", "membership": "folder", "id": "Sent",
        }));
        assert!(subjects(&store, &in_sent).is_empty());

        let labelled = filter(serde_json::json!({
            "kind": "membership", "membership": "label", "id": "label-1",
        }));
        assert!(subjects(&store, &labelled).is_empty());
    }

    #[test]
    fn attachment_and_message_predicates_narrow_to_known_rows() {
        let mut store = temp_store();
        store.register_account("acc-1").expect("registers");
        store
            .apply_sync(
                "acc-1",
                &page(
                    1,
                    FolderRole::Inbox,
                    vec![
                        synced(1, "one@example.com", "First", true, 1_000),
                        synced(2, "two@example.com", "Second", true, 2_000),
                    ],
                ),
            )
            .expect("applies");

        let no_attachment = filter(serde_json::json!({ "kind": "has_attachment", "value": false }));
        assert_eq!(subjects(&store, &no_attachment).len(), 2);

        store
            .save_content("acc-1", "m-2@example.com", &body("<p>Hi</p>", "Hi"))
            .expect("saves");

        let attachment = filter(serde_json::json!({ "kind": "has_attachment", "value": true }));
        assert_eq!(subjects(&store, &attachment), vec!["Second"]);

        let ids = filter(serde_json::json!({
            "kind": "message", "ids": ["m-1@example.com"],
        }));
        assert_eq!(subjects(&store, &ids), vec!["First"]);

        let no_ids = filter(serde_json::json!({ "kind": "message", "ids": [] }));
        assert!(subjects(&store, &no_ids).is_empty());
    }

    #[test]
    fn well_known_mailboxes_match_the_ts_store_definition() {
        let mut store = temp_store();
        store.register_account("acc-1").expect("registers");
        store
            .apply_sync(
                "acc-1",
                &page(
                    1,
                    FolderRole::Inbox,
                    vec![synced(1, "in@example.com", "Inbox message", true, 1_000)],
                ),
            )
            .expect("applies");
        store
            .apply_sync(
                "acc-1",
                &FolderSync {
                    folder: "Sent".to_string(),
                    role: FolderRole::Sent,
                    uid_validity: 1,
                    messages: vec![synced(2, "out@example.com", "Sent message", true, 2_000)],
                },
            )
            .expect("applies");

        assert_eq!(subjects(&store, &mailbox("inbox")), vec!["Inbox message"]);
        assert_eq!(subjects(&store, &mailbox("sent")), vec!["Sent message"]);
        // The TS store's archive excludes only inbox, trash and spam.
        assert_eq!(subjects(&store, &mailbox("archive")), vec!["Sent message"]);
        assert_eq!(subjects(&store, &mailbox("all")).len(), 2);
        assert!(subjects(&store, &mailbox("drafts")).is_empty());
        assert!(subjects(&store, &mailbox("trash")).is_empty());
        assert!(subjects(&store, &mailbox("spam")).is_empty());
        assert!(subjects(&store, &mailbox("starred")).is_empty());
        assert!(subjects(&store, &mailbox("snoozed")).is_empty());
    }

    fn admitted_store() -> MailStore {
        let mut store = temp_store();
        store.register_account("acc-1").expect("registers");
        store
            .apply_sync(
                "acc-1",
                &page(
                    1,
                    FolderRole::Inbox,
                    vec![synced(1, "thread@example.com", "Hello", false, 1_000)],
                ),
            )
            .expect("applies");
        store
    }

    fn message_ids() -> Vec<String> {
        vec!["m-1@example.com".to_string()]
    }

    fn message(store: &MailStore) -> ConversationMessage {
        store
            .conversation("acc-1", "thread@example.com", None, 50)
            .expect("reads")
            .messages
            .into_iter()
            .next()
            .expect("has a message")
    }

    #[test]
    fn a_queued_read_is_optimistic_and_survives_a_sync() {
        let mut store = admitted_store();
        let change = json!({ "kind": "set_read", "read": true });
        let admission = store
            .admit_metadata("acc-1", "cmd-read", &message_ids(), &change)
            .expect("admits");
        assert!(matches!(admission, Admission::Queued(_)));

        let view = message(&store);
        assert!(view.metadata.read);
        assert_eq!(view.pending_operation_ids, vec!["cmd-read"]);
        assert_eq!(
            store
                .counts(&["acc-1".to_string()], &mailbox("inbox"))
                .expect("counts"),
            (1, 0)
        );

        // A header sync still reports the old flag; the pending operation wins.
        store
            .apply_sync(
                "acc-1",
                &page(
                    1,
                    FolderRole::Inbox,
                    vec![synced(1, "thread@example.com", "Hello", false, 1_000)],
                ),
            )
            .expect("applies");
        assert!(message(&store).metadata.read);

        store
            .succeed_operation("acc-1", "cmd-read")
            .expect("succeeds");
        let view = message(&store);
        assert!(view.metadata.read);
        assert!(view.pending_operation_ids.is_empty());
        assert_eq!(
            store
                .operation_state("acc-1", "cmd-read")
                .expect("reads")
                .expect("exists")
                .status,
            "succeeded"
        );
    }

    #[test]
    fn a_failed_archive_puts_the_message_back_in_the_inbox() {
        let mut store = admitted_store();
        let change = json!({ "kind": "archive" });
        store
            .admit_metadata("acc-1", "cmd-archive", &message_ids(), &change)
            .expect("admits");
        assert!(subjects(&store, &mailbox("inbox")).is_empty());
        assert_eq!(subjects(&store, &mailbox("archive")).len(), 1);

        store
            .fail_operation("acc-1", "cmd-archive", "no_archive", false)
            .expect("fails");
        assert_eq!(subjects(&store, &mailbox("inbox")), vec!["Hello"]);
        assert!(message(&store).pending_operation_ids.is_empty());

        let diagnostics = store.diagnostics("acc-1").expect("reads");
        assert_eq!(diagnostics.pending_operations, 0);
        let operation = diagnostics.commands.first().expect("one command");
        assert_eq!(operation.operation_id, "cmd-archive");
        assert_eq!(operation.status, "failed");
        assert_eq!(operation.change_kind.as_deref(), Some("archive"));
    }

    #[test]
    fn a_cancelled_change_reverts_like_a_failure() {
        let mut store = admitted_store();
        let change = json!({ "kind": "set_starred", "starred": true });
        store
            .admit_metadata("acc-1", "cmd-star", &message_ids(), &change)
            .expect("admits");
        assert_eq!(subjects(&store, &mailbox("starred")), vec!["Hello"]);

        assert!(store
            .cancel_operation("acc-1", "cmd-star")
            .expect("cancels"));
        assert!(subjects(&store, &mailbox("starred")).is_empty());
        assert!(!store
            .cancel_operation("acc-1", "cmd-star")
            .expect("already finished"));
        assert_eq!(
            store
                .operation_state("acc-1", "cmd-star")
                .expect("reads")
                .expect("exists")
                .status,
            "cancelled"
        );
    }

    #[test]
    fn the_same_command_is_not_applied_twice() {
        let mut store = admitted_store();
        let change = json!({ "kind": "set_read", "read": true });
        store
            .admit_metadata("acc-1", "cmd-1", &message_ids(), &change)
            .expect("admits");
        let again = store
            .admit_metadata("acc-1", "cmd-1", &message_ids(), &change)
            .expect("admits again");
        assert!(matches!(again, Admission::AlreadyRecorded(_)));
        assert_eq!(store.diagnostics("acc-1").expect("reads").commands.len(), 1);

        let conflicting = store
            .admit_metadata(
                "acc-1",
                "cmd-1",
                &message_ids(),
                &json!({ "kind": "set_read", "read": false }),
            )
            .expect("reads");
        assert_eq!(conflicting, Admission::Rejected("invalid"));
    }

    #[test]
    fn conversations_check_the_epoch_and_resolve_messages() {
        let mut store = admitted_store();
        let change = json!({ "kind": "set_read", "read": true });
        let conversation = vec!["thread@example.com".to_string()];

        let stale = store
            .admit_conversations(
                "acc-1",
                "cmd-stale",
                &conversation,
                &change,
                "another-epoch",
            )
            .expect("reads");
        assert_eq!(stale, Admission::Rejected("stale_selection"));

        let epoch = store.revision().expect("reads").database_epoch;
        let admission = store
            .admit_conversations("acc-1", "cmd-live", &conversation, &change, &epoch)
            .expect("reads");
        assert!(matches!(admission, Admission::Queued(_)));
        assert!(message(&store).metadata.read);
    }

    #[test]
    fn changes_without_a_server_operation_are_rejected() {
        let mut store = admitted_store();
        let rejected = store
            .admit_metadata(
                "acc-1",
                "cmd-labels",
                &message_ids(),
                &json!({
                    "kind": "set_membership",
                    "membership": "label",
                    "id": "invoices",
                    "present": true,
                }),
            )
            .expect("reads");
        assert_eq!(rejected, Admission::Rejected("unsupported"));
        assert_eq!(
            store
                .diagnostics("acc-1")
                .expect("reads")
                .pending_operations,
            0
        );
    }

    #[test]
    fn spam_and_move_change_the_local_placement() {
        let mut store = admitted_store();
        let ids = message_ids();
        store
            .admit_metadata(
                "acc-1",
                "cmd-spam",
                &ids,
                &json!({ "kind": "set_spam", "spam": true }),
            )
            .expect("admits");
        assert!(subjects(&store, &mailbox("inbox")).is_empty());
        assert_eq!(subjects(&store, &mailbox("spam")), vec!["Hello"]);
        store
            .fail_operation("acc-1", "cmd-spam", "no_destination", false)
            .expect("fails");
        assert_eq!(subjects(&store, &mailbox("inbox")), vec!["Hello"]);

        store
            .admit_metadata(
                "acc-1",
                "cmd-move",
                &ids,
                &json!({ "kind": "move", "folderId": "Archive" }),
            )
            .expect("admits");
        let view = message(&store);
        assert_eq!(view.metadata.folder_id.as_deref(), Some("Archive"));
        assert!(view.metadata.roles.is_empty());
        assert!(subjects(&store, &mailbox("inbox")).is_empty());
        assert_eq!(subjects(&store, &mailbox("archive")), vec!["Hello"]);
    }

    #[test]
    fn an_interrupted_command_is_requeued_once() {
        let mut store = admitted_store();
        let change = json!({ "kind": "set_read", "read": true });
        store
            .admit_metadata("acc-1", "cmd-1", &message_ids(), &change)
            .expect("admits");
        assert!(store.begin_operation("acc-1", "cmd-1").expect("claims"));
        // A running attempt is not handed to another executor.
        assert!(store.pending_operations("acc-1").expect("reads").is_empty());
        assert!(!store
            .begin_operation("acc-1", "cmd-1")
            .expect("already running"));

        assert_eq!(store.requeue_interrupted("acc-1").expect("requeues"), 1);
        let pending = store.pending_operations("acc-1").expect("reads");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].status, "retry_wait");
        assert_eq!(store.requeue_interrupted("acc-1").expect("idle"), 0);
        assert!(store
            .begin_operation("acc-1", "cmd-1")
            .expect("claims again"));
        assert_eq!(
            store
                .operation_state("acc-1", "cmd-1")
                .expect("reads")
                .expect("exists")
                .attempts,
            2
        );
    }

    #[test]
    fn an_interrupted_send_is_never_replayed() {
        let mut store = admitted_store();
        store
            .save_draft("acc-1", "draft-1", None, &draft_body())
            .expect("saves");
        store
            .admit_send("acc-1", "cmd-send", "draft-1", 1, send_options(None, None))
            .expect("admits");
        assert!(store.begin_operation("acc-1", "cmd-send").expect("claims"));

        assert_eq!(store.requeue_interrupted("acc-1").expect("requeues"), 1);
        assert!(store.pending_operations("acc-1").expect("reads").is_empty());
        assert_eq!(
            store
                .operation_state("acc-1", "cmd-send")
                .expect("reads")
                .expect("exists")
                .status,
            "uncertain"
        );
        assert_eq!(
            store
                .save_draft("acc-1", "draft-1", Some(1), &draft_body())
                .expect("saves"),
            DraftSave::Saved {
                draft_revision: 2,
                revision: store.revision().expect("reads"),
            }
        );
    }

    #[test]
    fn drafts_require_the_current_revision() {
        let mut store = admitted_store();
        let saved = store
            .save_draft("acc-1", "draft-1", None, &draft_body())
            .expect("saves");
        assert_eq!(
            saved,
            DraftSave::Saved {
                draft_revision: 1,
                revision: store.revision().expect("reads"),
            }
        );

        let stale = store
            .save_draft("acc-1", "draft-1", Some(0), &draft_body())
            .expect("reads");
        assert_eq!(
            stale,
            DraftSave::Conflict {
                current_draft_revision: Some(1),
            }
        );

        let read = store.read_draft("acc-1", "draft-1").expect("reads");
        assert!(matches!(
            read,
            DraftRead::Found {
                draft_revision: 1,
                ..
            }
        ));
        assert_eq!(
            store.read_draft("acc-1", "missing").expect("reads"),
            DraftRead::Missing
        );
        assert_eq!(
            store
                .save_draft("acc-1", "draft-1", None, &json!({ "to": [] }))
                .expect("rejects"),
            DraftSave::Rejected("invalid")
        );
    }

    #[test]
    fn a_send_freezes_the_draft_and_reuses_its_intent() {
        let mut store = admitted_store();
        store
            .save_draft("acc-1", "draft-1", None, &draft_body())
            .expect("saves");

        let admission = store
            .admit_send(
                "acc-1",
                "cmd-send",
                "draft-1",
                1,
                send_options(Some(("acc-1", "m-1@example.com")), None),
            )
            .expect("admits");
        assert!(matches!(admission, Admission::Queued(_)));

        let pending = store.pending_operations("acc-1").expect("reads");
        assert_eq!(pending.len(), 1);
        match &pending[0].intent {
            OperationIntent::Send(intent) => {
                assert_eq!(intent.draft_id, "draft-1");
                assert_eq!(intent.subject, "Hello");
                assert_eq!(intent.to, vec!["friend@example.com".to_string()]);
                assert_eq!(
                    intent.reply_to_conversation_id.as_deref(),
                    Some("thread@example.com")
                );
            }
            other => panic!("expected a send, found {other:?}"),
        }

        // The same command over the same draft is a retry, not a second send.
        let again = store
            .admit_send(
                "acc-1",
                "cmd-send",
                "draft-1",
                1,
                send_options(Some(("acc-1", "m-1@example.com")), None),
            )
            .expect("admits");
        assert!(matches!(again, Admission::AlreadyRecorded(_)));
        assert_eq!(store.pending_operations("acc-1").expect("reads").len(), 1);

        // A frozen draft can no longer be edited.
        assert_eq!(
            store
                .save_draft("acc-1", "draft-1", Some(1), &draft_body())
                .expect("reads"),
            DraftSave::Conflict {
                current_draft_revision: Some(1),
            }
        );

        store
            .fail_operation("acc-1", "cmd-send", "smtp", false)
            .expect("fails");
        let saved = store
            .save_draft("acc-1", "draft-1", Some(1), &draft_body())
            .expect("saves");
        assert!(matches!(
            saved,
            DraftSave::Saved {
                draft_revision: 2,
                ..
            }
        ));
    }

    #[test]
    fn an_uncertain_send_is_not_retried_and_reports_itself() {
        let mut store = admitted_store();
        store
            .save_draft("acc-1", "draft-1", None, &draft_body())
            .expect("saves");
        store
            .admit_send("acc-1", "cmd-send", "draft-1", 1, send_options(None, None))
            .expect("admits");
        store
            .uncertain_operation("acc-1", "cmd-send", "uncertain")
            .expect("records");

        assert!(store.pending_operations("acc-1").expect("reads").is_empty());
        assert_eq!(
            store.uncertain_send_ids("acc-1").expect("reads"),
            vec!["cmd-send".to_string()]
        );
        let diagnostics = store.diagnostics("acc-1").expect("reads");
        assert_eq!(diagnostics.uncertain_operations, 1);
        assert_eq!(diagnostics.commands[0].status, "uncertain");
        assert_eq!(diagnostics.commands[0].change_kind.as_deref(), Some("send"));
        // The message body is not copied into diagnostics.
        assert!(diagnostics.commands[0].change.get("html").is_none());
        assert_eq!(
            store
                .save_draft("acc-1", "draft-1", Some(1), &draft_body())
                .expect("saves"),
            DraftSave::Saved {
                draft_revision: 2,
                revision: store.revision().expect("reads"),
            }
        );
    }

    #[test]
    fn a_send_can_be_held_until_a_not_before_time() {
        let mut store = admitted_store();
        store
            .save_draft("acc-1", "draft-1", None, &draft_body())
            .expect("saves");
        let later = now_ms() + 60_000;
        store
            .admit_send(
                "acc-1",
                "cmd-send",
                "draft-1",
                1,
                send_options(None, Some(later)),
            )
            .expect("admits");
        let pending = store.pending_operations("acc-1").expect("reads");
        assert_eq!(pending[0].next_attempt_at_ms, Some(later));
    }

    #[test]
    fn a_send_needs_a_matching_draft_revision() {
        let mut store = admitted_store();
        store
            .save_draft("acc-1", "draft-1", None, &draft_body())
            .expect("saves");
        assert_eq!(
            store
                .admit_send("acc-1", "cmd-send", "draft-1", 2, send_options(None, None))
                .expect("reads"),
            Admission::Rejected("invalid")
        );
        assert_eq!(
            store
                .admit_send("acc-1", "cmd-send", "missing", 1, send_options(None, None))
                .expect("reads"),
            Admission::Rejected("invalid")
        );
        assert!(store.pending_operations("acc-1").expect("reads").is_empty());
    }

    fn send_options<'a>(
        reply_to: Option<(&'a str, &'a str)>,
        not_before_ms: Option<i64>,
    ) -> SendOptions<'a> {
        SendOptions {
            reply_to,
            conversation_id: None,
            not_before_ms,
        }
    }

    fn draft_body() -> Json {
        json!({
            "to": ["friend@example.com"],
            "cc": [],
            "bcc": [],
            "subject": "Hello",
            "editableHtml": "<p>Hi</p>",
            "quotedHtml": "",
        })
    }
}
