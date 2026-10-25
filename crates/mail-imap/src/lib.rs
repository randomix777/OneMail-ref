//! IMAP reads for the Rust mail engine.
//!
//! A deliberately small surface: log in, list folders, read the newest messages of
//! one folder. Everything the mirror needs is derived from the raw header block, so
//! the network layer stays thin and the mapping below is testable without a server.

use std::fmt;
use std::time::Duration;

use async_imap::imap_proto::NameAttribute;
use async_imap::types::Flag;
use futures_util::TryStreamExt;
use mail_parser::{Address, HeaderValue, MessageParser, MessagePart, MimeHeaders};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

/// How long a connect/handshake/login may take before the socket is abandoned.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a full-message download may take.
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

/// Bodies larger than this are refused instead of copied into the mirror, the
/// same ceiling `apps/desktop/src/local/imap.ts` applies.
const MAX_MESSAGE_BYTES: usize = 25 * 1024 * 1024;
/// `MAX_BODY_LENGTH` from `@inboxzero/mail-core/sync`.
const MAX_BODY_LENGTH: usize = 5_000_000;
/// `MAX_BODY_ATTACHMENTS` from `@inboxzero/mail-core/sync`.
const MAX_ATTACHMENTS: usize = 100;
const PREVIEW_LENGTH: usize = 500;

/// The props are readable, the password never is.
#[derive(Clone)]
pub struct Credentials {
    pub host: String,
    pub port: u16,
    pub secure: bool,
    pub username: String,
    pub password: String,
}

impl fmt::Debug for Credentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Credentials")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("secure", &self.secure)
            .field("username", &self.username)
            .field("password", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ImapError {
    #[error("{0}")]
    Config(String),
    #[error("could not reach {host}:{port}: {source}")]
    Connect {
        host: String,
        port: u16,
        #[source]
        source: std::io::Error,
    },
    #[error("TLS handshake failed: {0}")]
    Tls(String),
    #[error("timed out talking to {0}")]
    Timeout(String),
    #[error("the server rejected the credentials for {0}")]
    Login(String),
    #[error("IMAP request failed: {0}")]
    Protocol(String),
}

/// Which well-known mailbox a folder plays the part of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Inbox,
    Sent,
    Drafts,
    Archive,
    Trash,
    Spam,
    /// A virtual "all messages" mailbox. It is never used as a move target and
    /// is never mirrored, because its rows overlap every real folder.
    AllMail,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Folder {
    /// The path `SELECT` accepts, e.g. `[Gmail]/Sent Mail`.
    pub path: String,
    /// The leaf to show in a folder list.
    pub name: String,
    pub role: Option<Role>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Login {
    pub folders: Vec<Folder>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub uid: u32,
    /// The RFC 5322 Message-ID, or a UID-derived stand-in when the header has none.
    pub message_id: String,
    /// A stable conversation key: the thread root's Message-ID when the headers
    /// carry one, otherwise this message's own id.
    pub conversation_id: String,
    pub subject: String,
    pub from_address: String,
    pub from_name: Option<String>,
    pub to_addresses: Vec<String>,
    pub received_at_ms: i64,
    pub read: bool,
    pub starred: bool,
    /// Not known from headers alone; body reads land in a later slice.
    pub has_attachments: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncPage {
    /// Bumped by the server when UIDs are reassigned; the mirror keys off it.
    pub uid_validity: u32,
    /// Oldest first, so a mirror can insert in arrival order.
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderPage {
    pub folder: Folder,
    pub page: SyncPage,
}

/// A downloaded RFC 5322 message plus the fence it was read under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedMessage {
    pub uid_validity: u32,
    pub bytes: Vec<u8>,
}

/// One attachment descriptor; `index` is the position in the parsed list and is
/// what the renderer sends back when it wants the bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub index: usize,
    pub filename: String,
    pub mime_type: String,
    pub size: usize,
    pub inline: bool,
    pub content_id: Option<String>,
}

/// Everything the conversation view renders from a message body. No bytes: the
/// attachment contents stay on the server until the renderer asks for one.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Body {
    pub html: Option<String>,
    pub text: Option<String>,
    pub preview: String,
    /// Full visible text (`preview` is its first 500 characters).
    pub search_text: String,
    pub attachments: Vec<Attachment>,
    pub is_meeting_invitation: bool,
}

/// Logs in and lists folders. This is the "verify" step of adding an account.
pub async fn verify(credentials: &Credentials) -> Result<Login, ImapError> {
    let mut session = connect(credentials).await?;
    let folders = list_folders(&mut session).await?;
    let _ = session.logout().await;
    Ok(Login { folders })
}

/// Reads the newest `limit` messages of each wanted folder over one connection.
///
/// Folders the server does not have are skipped rather than failing the sync.
pub async fn fetch_folders(
    credentials: &Credentials,
    roles: &[Role],
    limit: u32,
) -> Result<Vec<FolderPage>, ImapError> {
    let limit = limit.clamp(1, 500);
    let mut session = connect(credentials).await?;
    let folders = list_folders(&mut session).await?;
    let mut pages = Vec::new();
    for role in roles {
        let Some(folder) = folders.iter().find(|folder| folder.role == Some(*role)) else {
            continue;
        };
        let page = read_page(&mut session, &folder.path, limit).await?;
        pages.push(FolderPage {
            folder: folder.clone(),
            page,
        });
    }
    let _ = session.logout().await;
    Ok(pages)
}

/// Downloads one full message by UID. Used for both body hydration and
/// attachment reads, so the two always parse the same bytes.
pub async fn fetch_message(
    credentials: &Credentials,
    folder: &str,
    uid: u32,
) -> Result<FetchedMessage, ImapError> {
    let endpoint = format!("{}:{}", credentials.host, credentials.port);
    let mut session = connect(credentials).await?;
    let mailbox = session.select(folder).await.map_err(protocol)?;
    let uid_validity = mailbox.uid_validity.unwrap_or(0);

    let fetches = tokio::time::timeout(FETCH_TIMEOUT, async {
        session
            .uid_fetch(uid.to_string(), "(BODY.PEEK[])")
            .await?
            .try_collect::<Vec<_>>()
            .await
    })
    .await
    .map_err(|_| ImapError::Timeout(endpoint))?
    .map_err(protocol)?;
    let bytes = fetches
        .iter()
        .find_map(|fetch| fetch.body().map(<[u8]>::to_vec));
    let _ = session.logout().await;

    let Some(bytes) = bytes else {
        return Err(ImapError::Protocol(format!(
            "message {uid} is no longer in {folder}"
        )));
    };
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(ImapError::Protocol(
            "the message exceeds the 25 MB local download limit".to_string(),
        ));
    }
    Ok(FetchedMessage {
        uid_validity,
        bytes,
    })
}

/// A message coordinate for a write: the folder it lives in and the UID fence
/// the caller read it under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteTarget {
    pub message_id: String,
    pub folder: String,
    pub uid_validity: u32,
    pub uid: u32,
}

/// A message after a move, with the destination coordinate the server reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MovedMessage {
    pub message_id: String,
    pub folder: String,
    pub uid_validity: u32,
    /// Zero when the destination search did not find the message.
    pub uid: u32,
}

/// Adds/removes message flags in one folder. Read and star are a single STORE
/// each; grouping keeps a conversation-wide change to two round trips.
pub async fn set_flags(
    credentials: &Credentials,
    folder: &str,
    uid_validity: u32,
    uids: &[u32],
    add: &[&str],
    remove: &[&str],
) -> Result<(), ImapError> {
    if uids.is_empty() {
        return Ok(());
    }
    let endpoint = format!("{}:{}", credentials.host, credentials.port);
    tokio::time::timeout(
        FETCH_TIMEOUT,
        set_flags_inner(credentials, folder, uid_validity, uids, add, remove),
    )
    .await
    .map_err(|_| ImapError::Timeout(endpoint))?
}

async fn set_flags_inner(
    credentials: &Credentials,
    folder: &str,
    uid_validity: u32,
    uids: &[u32],
    add: &[&str],
    remove: &[&str],
) -> Result<(), ImapError> {
    let mut session = connect(credentials).await?;
    let mailbox = session.select(folder).await.map_err(protocol)?;
    if let Some(actual) = mailbox.uid_validity {
        if actual != uid_validity {
            let _ = session.logout().await;
            return Err(ImapError::Protocol(format!(
                "{folder} was reassigned; the mirrored UIDs are stale"
            )));
        }
    }
    let set = uid_set(uids);
    if !add.is_empty() {
        let flags = format!("+FLAGS.SILENT ({})", add.join(" "));
        session
            .uid_store(&set, &flags)
            .await
            .map_err(protocol)?
            .try_collect::<Vec<_>>()
            .await
            .map_err(protocol)?;
    }
    if !remove.is_empty() {
        let flags = format!("-FLAGS.SILENT ({})", remove.join(" "));
        session
            .uid_store(&set, &flags)
            .await
            .map_err(protocol)?
            .try_collect::<Vec<_>>()
            .await
            .map_err(protocol)?;
    }
    let _ = session.logout().await;
    Ok(())
}

/// Moves messages into `destination`, then reports their new UIDs. Uses MOVE when
/// the server has it and falls back to COPY + `\Deleted` + EXPUNGE otherwise.
pub async fn move_messages(
    credentials: &Credentials,
    targets: &[WriteTarget],
    destination: &str,
) -> Result<Vec<MovedMessage>, ImapError> {
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let endpoint = format!("{}:{}", credentials.host, credentials.port);
    tokio::time::timeout(
        FETCH_TIMEOUT,
        move_messages_inner(credentials, targets, destination),
    )
    .await
    .map_err(|_| ImapError::Timeout(endpoint))?
}

async fn move_messages_inner(
    credentials: &Credentials,
    targets: &[WriteTarget],
    destination: &str,
) -> Result<Vec<MovedMessage>, ImapError> {
    let mut session = connect(credentials).await?;
    let mut groups: Vec<(String, u32, Vec<u32>)> = Vec::new();
    for target in targets {
        if target.folder == destination {
            continue;
        }
        match groups
            .iter_mut()
            .find(|(folder, _, _)| folder == &target.folder)
        {
            Some((_, _, uids)) => uids.push(target.uid),
            None => groups.push((target.folder.clone(), target.uid_validity, vec![target.uid])),
        }
    }

    for (folder, uid_validity, uids) in groups {
        let mailbox = session.select(&folder).await.map_err(protocol)?;
        if let Some(actual) = mailbox.uid_validity {
            if actual != uid_validity {
                let _ = session.logout().await;
                return Err(ImapError::Protocol(format!(
                    "{folder} was reassigned; the mirrored UIDs are stale"
                )));
            }
        }
        let set = uid_set(&uids);
        if session.uid_mv(&set, destination).await.is_err() {
            // MOVE is optional (RFC 6851); the copy/delete sequence works on any
            // server. A failed MOVE that partly applied can duplicate, which is
            // why the caller reports a permanent failure rather than retrying.
            session
                .uid_copy(&set, destination)
                .await
                .map_err(protocol)?;
            session
                .uid_store(&set, "+FLAGS.SILENT (\\Deleted)")
                .await
                .map_err(protocol)?
                .try_collect::<Vec<_>>()
                .await
                .map_err(protocol)?;
            session
                .uid_expunge(&set)
                .await
                .map_err(protocol)?
                .try_collect::<Vec<_>>()
                .await
                .map_err(protocol)?;
        }
    }

    let mailbox = session.select(destination).await.map_err(protocol)?;
    let uid_validity = mailbox.uid_validity.unwrap_or(0);
    let mut moved = Vec::with_capacity(targets.len());
    for target in targets {
        let uid = session
            .uid_search(message_id_query(&target.message_id))
            .await
            .map_err(protocol)?
            .into_iter()
            .max()
            .unwrap_or(0);
        moved.push(MovedMessage {
            message_id: target.message_id.clone(),
            folder: destination.to_string(),
            uid_validity,
            uid,
        });
    }
    let _ = session.logout().await;
    Ok(moved)
}

/// Appends a submitted message to the folder with `role` (normally Sent).
/// Returns false when the account has no such folder; that is not a send
/// failure, because SMTP already accepted the message.
pub async fn append_to_role(
    credentials: &Credentials,
    role: Role,
    message: &[u8],
) -> Result<bool, ImapError> {
    let endpoint = format!("{}:{}", credentials.host, credentials.port);
    tokio::time::timeout(
        FETCH_TIMEOUT,
        append_to_role_inner(credentials, role, message),
    )
    .await
    .map_err(|_| ImapError::Timeout(endpoint))?
}

async fn append_to_role_inner(
    credentials: &Credentials,
    role: Role,
    message: &[u8],
) -> Result<bool, ImapError> {
    let mut session = connect(credentials).await?;
    let folders = list_folders(&mut session).await?;
    let Some(folder) = folders.iter().find(|folder| folder.role == Some(role)) else {
        let _ = session.logout().await;
        return Ok(false);
    };
    session
        .append(&folder.path, Some("(\\Seen)"), None, message)
        .await
        .map_err(protocol)?;
    let _ = session.logout().await;
    Ok(true)
}

/// Looks for a message by RFC Message-ID in the folder with `role`. Used to
/// reconcile a send that left the client but whose SMTP verdict never arrived.
pub async fn find_in_role(
    credentials: &Credentials,
    role: Role,
    message_id: &str,
) -> Result<bool, ImapError> {
    let endpoint = format!("{}:{}", credentials.host, credentials.port);
    tokio::time::timeout(
        FETCH_TIMEOUT,
        find_in_role_inner(credentials, role, message_id),
    )
    .await
    .map_err(|_| ImapError::Timeout(endpoint))?
}

async fn find_in_role_inner(
    credentials: &Credentials,
    role: Role,
    message_id: &str,
) -> Result<bool, ImapError> {
    let mut session = connect(credentials).await?;
    let folders = list_folders(&mut session).await?;
    let Some(folder) = folders.iter().find(|folder| folder.role == Some(role)) else {
        let _ = session.logout().await;
        return Ok(false);
    };
    session.select(&folder.path).await.map_err(protocol)?;
    let uids = session
        .uid_search(message_id_query(message_id))
        .await
        .map_err(protocol)?;
    let _ = session.logout().await;
    Ok(!uids.is_empty())
}

/// Parses the display parts of a raw message. Pure, so the mapping is testable
/// without a server.
pub fn parse_body(bytes: &[u8]) -> Body {
    let Some(message) = MessageParser::default().parse(bytes) else {
        return Body::default();
    };

    let html = message
        .html_part(0)
        .filter(|part| part.is_text_html())
        .and_then(MessagePart::text_contents)
        .map(|value| truncate_chars(value, MAX_BODY_LENGTH));
    let text = message
        .text_part(0)
        .filter(|part| !part.is_text_html())
        .and_then(MessagePart::text_contents)
        .map(|value| truncate_chars(value, MAX_BODY_LENGTH));
    let visible_text = message.body_text(0);
    let preview = visible_text
        .as_deref()
        .map(str::trim)
        .map(|value| truncate_chars(value, PREVIEW_LENGTH))
        .unwrap_or_default();
    // The preview is the first 500 characters of the same text; search needs
    // the whole thing.
    let search_text = visible_text
        .as_deref()
        .map(str::trim)
        .map(|value| truncate_chars(value, MAX_BODY_LENGTH))
        .unwrap_or_default();

    let attachments: Vec<Attachment> = message
        .attachments()
        .take(MAX_ATTACHMENTS)
        .enumerate()
        .map(|(index, part)| Attachment {
            index,
            filename: truncate_chars(
                part.attachment_name()
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .unwrap_or("attachment"),
                1024,
            ),
            mime_type: truncate_chars(&mime_type(part), 256),
            size: part.contents().len(),
            inline: part
                .content_disposition()
                .is_some_and(|disposition| disposition.is_inline()),
            content_id: part
                .content_id()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(|id| truncate_chars(id, 1024)),
        })
        .collect();

    // A text/calendar part is the only invitation signal the raw message carries.
    let is_meeting_invitation = message
        .attachments()
        .any(|part| mime_type(part).eq_ignore_ascii_case("text/calendar"));

    Body {
        html,
        text,
        preview,
        search_text,
        attachments,
        is_meeting_invitation,
    }
}

/// The bytes of one attachment, by the same index `parse_body` reports.
pub fn attachment_bytes(bytes: &[u8], index: usize) -> Option<Vec<u8>> {
    let message = MessageParser::default().parse(bytes)?;
    message
        .attachment(index as u32)
        .map(|part| part.contents().to_vec())
}

fn mime_type(part: &MessagePart<'_>) -> String {
    match part.content_type() {
        Some(content_type) => match content_type.subtype() {
            Some(subtype) if !subtype.is_empty() => {
                format!("{}/{}", content_type.ctype(), subtype)
            }
            _ => content_type.ctype().to_string(),
        },
        None => "application/octet-stream".to_string(),
    }
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max).collect()
}

async fn list_folders(session: &mut Session) -> Result<Vec<Folder>, ImapError> {
    let listed: Vec<_> = session
        .list(None, Some("*"))
        .await
        .map_err(protocol)?
        .try_collect()
        .await
        .map_err(protocol)?;
    let mut folders: Vec<Folder> = listed
        .iter()
        .map(|name| folder_from_list(name.name(), name.attributes()))
        .collect();
    folders.sort_by(|left, right| left.path.cmp(&right.path));
    // INBOX is guaranteed by the protocol but is not announced with a special-use
    // attribute, so make sure the first slice always has somewhere to read.
    if !folders
        .iter()
        .any(|folder| folder.role == Some(Role::Inbox))
    {
        folders.insert(
            0,
            Folder {
                path: "INBOX".to_string(),
                name: "Inbox".to_string(),
                role: Some(Role::Inbox),
            },
        );
    }
    Ok(folders)
}

/// Reads the newest `limit` messages of one folder, headers only.
async fn read_page(session: &mut Session, folder: &str, limit: u32) -> Result<SyncPage, ImapError> {
    let mailbox = session.select(folder).await.map_err(protocol)?;
    let uid_validity = mailbox.uid_validity.unwrap_or(0);
    if mailbox.exists == 0 {
        return Ok(SyncPage {
            uid_validity,
            messages: Vec::new(),
        });
    }

    // Sequence numbers are 1-based, so a page of `limit` newest messages starts at
    // `exists - limit + 1` clamped to 1.
    let first = mailbox
        .exists
        .saturating_sub(limit.saturating_sub(1))
        .max(1);
    let fetches: Vec<_> = session
        .fetch(
            format!("{first}:*"),
            "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER])",
        )
        .await
        .map_err(protocol)?
        .try_collect()
        .await
        .map_err(protocol)?;

    let mut messages = Vec::with_capacity(fetches.len());
    for fetch in &fetches {
        let Some(uid) = fetch.uid else { continue };
        let read = fetch.flags().any(|flag| matches!(flag, Flag::Seen));
        let starred = fetch.flags().any(|flag| matches!(flag, Flag::Flagged));
        let internal_date_ms = fetch.internal_date().map(|date| date.timestamp_millis());
        messages.push(map_message(
            uid,
            uid_validity,
            read,
            starred,
            internal_date_ms,
            fetch.header(),
        ));
    }
    messages.sort_by_key(|message| message.received_at_ms);
    Ok(SyncPage {
        uid_validity,
        messages,
    })
}

type Connection = tokio_native_tls::TlsStream<TcpStream>;
type Session = async_imap::Session<Connection>;

const STARTTLS_TAG: &str = "a1";
const MAX_LINE: usize = 8 * 1024;

async fn connect(credentials: &Credentials) -> Result<Session, ImapError> {
    let endpoint = format!("{}:{}", credentials.host, credentials.port);
    let connector = tls_connector()?;

    let socket = tokio::time::timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((credentials.host.as_str(), credentials.port)),
    )
    .await
    .map_err(|_| ImapError::Timeout(endpoint.clone()))?
    .map_err(|source| ImapError::Connect {
        host: credentials.host.clone(),
        port: credentials.port,
        source,
    })?;

    let stream = if credentials.secure {
        tls_connect(&connector, credentials, socket, &endpoint).await?
    } else {
        starttls_connect(&connector, credentials, socket, &endpoint).await?
    };
    login(stream, credentials, &endpoint).await
}

fn tls_connector() -> Result<tokio_native_tls::TlsConnector, ImapError> {
    native_tls::TlsConnector::builder()
        .build()
        .map(tokio_native_tls::TlsConnector::from)
        .map_err(|error| ImapError::Tls(error.to_string()))
}

async fn tls_connect(
    connector: &tokio_native_tls::TlsConnector,
    credentials: &Credentials,
    socket: TcpStream,
    endpoint: &str,
) -> Result<Connection, ImapError> {
    tokio::time::timeout(
        CONNECT_TIMEOUT,
        connector.connect(&credentials.host, socket),
    )
    .await
    .map_err(|_| ImapError::Timeout(endpoint.to_string()))?
    .map_err(|error| ImapError::Tls(error.to_string()))
}

async fn starttls_connect(
    connector: &tokio_native_tls::TlsConnector,
    credentials: &Credentials,
    mut socket: TcpStream,
    endpoint: &str,
) -> Result<Connection, ImapError> {
    tokio::time::timeout(CONNECT_TIMEOUT, negotiate_starttls(&mut socket))
        .await
        .map_err(|_| ImapError::Timeout(endpoint.to_string()))??;
    tls_connect(connector, credentials, socket, endpoint).await
}

/// Reads the greeting and upgrades the plaintext socket with STARTTLS. The
/// password is only sent later, over the upgraded stream.
async fn negotiate_starttls<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
) -> Result<(), ImapError> {
    let greeting = read_line(stream).await?;
    let upper = greeting.to_ascii_uppercase();
    if upper.starts_with("* BYE") {
        return Err(ImapError::Protocol(format!(
            "the server closed the connection: {greeting}"
        )));
    }
    if upper.starts_with("* PREAUTH") {
        return Err(ImapError::Config(
            "The server pre-authenticated the connection before TLS; refusing to use it."
                .to_string(),
        ));
    }
    if !upper.starts_with("* OK") {
        return Err(ImapError::Protocol(format!(
            "unexpected IMAP greeting: {greeting}"
        )));
    }

    stream
        .write_all(format!("{STARTTLS_TAG} STARTTLS\r\n").as_bytes())
        .await
        .map_err(|error| ImapError::Protocol(error.to_string()))?;
    stream
        .flush()
        .await
        .map_err(|error| ImapError::Protocol(error.to_string()))?;

    let ok = format!("{} OK", STARTTLS_TAG.to_ascii_uppercase());
    let no = format!("{} NO", STARTTLS_TAG.to_ascii_uppercase());
    let bad = format!("{} BAD", STARTTLS_TAG.to_ascii_uppercase());
    for _ in 0..20 {
        let line = read_line(stream).await?;
        let upper = line.to_ascii_uppercase();
        if upper.starts_with(&ok) {
            return Ok(());
        }
        if upper.starts_with(&no) || upper.starts_with(&bad) {
            return Err(ImapError::Config(format!(
                "The server refused STARTTLS. Choose TLS when the server uses an implicit-TLS port. ({line})"
            )));
        }
    }
    Err(ImapError::Protocol(
        "the server did not answer STARTTLS".to_string(),
    ))
}

async fn read_line<S: AsyncRead + Unpin>(stream: &mut S) -> Result<String, ImapError> {
    let mut bytes = Vec::new();
    loop {
        let byte = stream
            .read_u8()
            .await
            .map_err(|error| ImapError::Protocol(error.to_string()))?;
        bytes.push(byte);
        if byte == b'\n' {
            break;
        }
        if bytes.len() > MAX_LINE {
            return Err(ImapError::Protocol(
                "the server sent an oversized line".to_string(),
            ));
        }
    }
    Ok(String::from_utf8_lossy(&bytes)
        .trim_end_matches(['\r', '\n'])
        .to_string())
}

async fn login(
    stream: Connection,
    credentials: &Credentials,
    endpoint: &str,
) -> Result<Session, ImapError> {
    let client = async_imap::Client::new(stream);
    tokio::time::timeout(
        CONNECT_TIMEOUT,
        client.login(&credentials.username, &credentials.password),
    )
    .await
    .map_err(|_| ImapError::Timeout(endpoint.to_string()))?
    .map_err(|(error, _)| ImapError::Login(error.to_string()))
}

fn protocol(error: async_imap::error::Error) -> ImapError {
    ImapError::Protocol(error.to_string())
}

fn uid_set(uids: &[u32]) -> String {
    let mut sorted = uids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    sorted
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

fn message_id_query(message_id: &str) -> String {
    format!(
        "HEADER Message-ID \"{}\"",
        message_id.replace('\\', "\\\\").replace('"', "\\\"")
    )
}

fn folder_from_list(path: &str, attributes: &[NameAttribute<'_>]) -> Folder {
    Folder {
        path: path.to_string(),
        name: leaf_name(path),
        role: role_from(path, attributes),
    }
}

/// The visible folder name: everything after the last hierarchy separator.
fn leaf_name(path: &str) -> String {
    path.rsplit('/')
        .next()
        .filter(|leaf| !leaf.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn role_from(path: &str, attributes: &[NameAttribute<'_>]) -> Option<Role> {
    let declared = attributes.iter().find_map(|attribute| match attribute {
        NameAttribute::Sent => Some(Role::Sent),
        NameAttribute::Drafts => Some(Role::Drafts),
        NameAttribute::Archive => Some(Role::Archive),
        NameAttribute::All => Some(Role::AllMail),
        NameAttribute::Trash => Some(Role::Trash),
        NameAttribute::Junk => Some(Role::Spam),
        _ => None,
    });
    declared.or_else(|| role_from_path(path))
}

fn role_from_path(path: &str) -> Option<Role> {
    let lower = path.to_ascii_lowercase();
    if lower == "inbox" {
        return Some(Role::Inbox);
    }
    match leaf_name(&lower).as_str() {
        "sent" | "sent mail" | "sent items" | "sent messages" => Some(Role::Sent),
        "draft" | "drafts" => Some(Role::Drafts),
        "archive" | "archives" => Some(Role::Archive),
        "all mail" | "all" => Some(Role::AllMail),
        "trash" | "deleted" | "deleted items" | "deleted messages" => Some(Role::Trash),
        "junk" | "junk e-mail" | "spam" | "bulk mail" => Some(Role::Spam),
        _ => None,
    }
}

fn map_message(
    uid: u32,
    uid_validity: u32,
    read: bool,
    starred: bool,
    internal_date_ms: Option<i64>,
    header: Option<&[u8]>,
) -> Message {
    let parsed = header.and_then(|bytes| MessageParser::default().parse(bytes));
    let subject = parsed
        .as_ref()
        .and_then(|message| message.subject())
        .map(str::trim)
        .filter(|subject| !subject.is_empty())
        .unwrap_or("(no subject)")
        .to_string();
    let sender = parsed
        .as_ref()
        .and_then(|message| message.from())
        .and_then(sender);
    let to_addresses = parsed
        .as_ref()
        .and_then(|message| message.to())
        .map(addresses)
        .unwrap_or_default();
    let message_id = parsed
        .as_ref()
        .and_then(|message| message.message_id())
        .map(normalize_id)
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| format!("imap:{uid_validity}:{uid}"));
    let conversation_id = parsed
        .as_ref()
        .and_then(thread_root)
        .map(|root| normalize_id(&root))
        .filter(|root| !root.is_empty())
        .unwrap_or_else(|| message_id.clone());
    let received_at_ms = parsed
        .as_ref()
        .and_then(|message| message.date())
        .map(|date| date.to_timestamp() * 1000)
        .or(internal_date_ms)
        .unwrap_or(0);
    let (from_address, from_name) = sender.unwrap_or_default();

    Message {
        uid,
        message_id,
        conversation_id,
        subject,
        from_address,
        from_name,
        to_addresses,
        received_at_ms,
        read,
        starred,
        has_attachments: false,
    }
}

fn sender(address: &Address<'_>) -> Option<(String, Option<String>)> {
    let Address::List(list) = address else {
        return None;
    };
    let first = list.first()?;
    let email = first.address.as_deref().unwrap_or_default().trim();
    if email.is_empty() {
        return None;
    }
    let name = first
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    Some((email.to_string(), name))
}

fn addresses(address: &Address<'_>) -> Vec<String> {
    let Address::List(list) = address else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|entry| entry.address.as_deref())
        .map(str::trim)
        .filter(|email| !email.is_empty())
        .map(str::to_string)
        .collect()
}

/// The thread root, following the convention that a conversation is keyed by the
/// first Message-ID in `References`.
fn thread_root(message: &mail_parser::Message<'_>) -> Option<String> {
    message_ids(message.references())
        .into_iter()
        .next()
        .or_else(|| message_ids(message.in_reply_to()).into_iter().next())
        .or_else(|| message.message_id().map(normalize_id))
}

fn message_ids(value: &HeaderValue<'_>) -> Vec<String> {
    let raw: Vec<&str> = match value {
        HeaderValue::Text(text) => text.split_whitespace().collect(),
        HeaderValue::TextList(list) => list
            .iter()
            .flat_map(|text| text.split_whitespace())
            .collect(),
        _ => Vec::new(),
    };
    raw.into_iter()
        .map(normalize_id)
        .filter(|id| !id.is_empty())
        .collect()
}

fn normalize_id(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &[u8] = b"From: =?UTF-8?B?5byg5LiJ?= <zhang@example.com>\r\n\
To: Ana <ana@example.com>, ben@example.com\r\n\
Subject: =?UTF-8?B?5L2g5aW977yM5LiA5Liq5rWL6K+V?=\r\n\
Date: Tue, 01 Oct 2024 10:00:00 +0000\r\n\
Message-ID: <child@example.com>\r\n\
References: <root@example.com> <middle@example.com>\r\n\
\r\n";

    #[test]
    fn maps_headers_into_a_mirror_message() {
        let message = map_message(7, 42, false, true, None, Some(HEADER));

        assert_eq!(message.uid, 7);
        assert_eq!(message.message_id, "child@example.com");
        assert_eq!(message.conversation_id, "root@example.com");
        assert_eq!(message.subject, "你好，一个测试");
        assert_eq!(message.from_address, "zhang@example.com");
        assert_eq!(message.from_name.as_deref(), Some("张三"));
        assert_eq!(
            message.to_addresses,
            vec!["ana@example.com".to_string(), "ben@example.com".to_string()]
        );
        assert_eq!(message.received_at_ms, 1_727_776_800_000);
        assert!(!message.read);
        assert!(message.starred);
    }

    #[test]
    fn a_thread_starter_is_its_own_conversation() {
        let header = b"From: ana@example.com\r\n\
Subject: Hello\r\n\
Date: Tue, 01 Oct 2024 10:00:00 +0000\r\n\
Message-ID: <only@example.com>\r\n\
\r\n";

        let message = map_message(1, 3, true, false, None, Some(header));

        assert_eq!(message.message_id, "only@example.com");
        assert_eq!(message.conversation_id, "only@example.com");
        assert_eq!(message.from_name, None);
    }

    #[test]
    fn a_header_without_a_message_id_still_gets_a_stable_id() {
        let header = b"From: ana@example.com\r\nSubject: No id\r\n\r\n";

        let message = map_message(9, 77, false, false, Some(1_700_000_000_000), Some(header));

        assert_eq!(message.message_id, "imap:77:9");
        assert_eq!(message.conversation_id, "imap:77:9");
        assert_eq!(message.received_at_ms, 1_700_000_000_000);
    }

    #[test]
    fn replies_without_references_fall_back_to_in_reply_to() {
        let header = b"From: ana@example.com\r\n\
Subject: Re: Hello\r\n\
In-Reply-To: <parent@example.com>\r\n\
Message-ID: <reply@example.com>\r\n\
\r\n";

        let message = map_message(2, 3, true, false, None, Some(header));

        assert_eq!(message.conversation_id, "parent@example.com");
    }

    #[test]
    fn a_missing_header_block_does_not_lose_the_message() {
        let message = map_message(4, 5, false, false, None, None);

        assert_eq!(message.subject, "(no subject)");
        assert_eq!(message.from_address, "");
        assert!(message.to_addresses.is_empty());
        assert_eq!(message.message_id, "imap:5:4");
        assert_eq!(message.received_at_ms, 0);
    }

    #[test]
    fn special_use_attributes_win_over_folder_names() {
        let attributes = [NameAttribute::Junk];
        assert_eq!(
            role_from("Archiv/Quarantäne", &attributes),
            Some(Role::Spam)
        );
    }

    #[test]
    fn folder_names_cover_the_common_providers() {
        assert_eq!(role_from("INBOX", &[]), Some(Role::Inbox));
        assert_eq!(role_from("Sent Items", &[]), Some(Role::Sent));
        assert_eq!(role_from("[Gmail]/Sent Mail", &[]), Some(Role::Sent));
        assert_eq!(role_from("[Gmail]/All Mail", &[]), Some(Role::AllMail));
        assert_eq!(role_from("Deleted Messages", &[]), Some(Role::Trash));
        assert_eq!(role_from("INBOX/Receipts", &[]), None);
        assert_eq!(leaf_name("[Gmail]/Sent Mail"), "Sent Mail");
    }

    #[tokio::test]
    async fn starttls_is_negotiated_before_credentials_are_sent() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let server = tokio::spawn(async move {
            server.write_all(b"* OK Ready\r\n").await.expect("greets");
            let command = read_line(&mut server).await.expect("reads command");
            server
                .write_all(b"a1 OK Begin TLS\r\n")
                .await
                .expect("accepts STARTTLS");
            command
        });

        negotiate_starttls(&mut client).await.expect("negotiates");
        assert_eq!(server.await.expect("server finished"), "a1 STARTTLS");
    }

    #[tokio::test]
    async fn a_server_that_refuses_starttls_is_a_config_error() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        tokio::spawn(async move {
            server.write_all(b"* OK Ready\r\n").await.expect("greets");
            let _ = read_line(&mut server).await.expect("reads command");
            server
                .write_all(b"a1 NO STARTTLS not supported\r\n")
                .await
                .expect("refuses STARTTLS");
        });

        match negotiate_starttls(&mut client).await {
            Err(ImapError::Config(message)) => assert!(message.contains("refused STARTTLS")),
            other => panic!("expected a config error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_bye_greeting_is_a_protocol_error() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        tokio::spawn(async move {
            server
                .write_all(b"* BYE server shutting down\r\n")
                .await
                .expect("greets");
        });

        assert!(matches!(
            negotiate_starttls(&mut client).await,
            Err(ImapError::Protocol(_))
        ));
    }

    #[tokio::test]
    async fn a_preauthenticated_plaintext_session_is_refused() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        tokio::spawn(async move {
            server
                .write_all(b"* PREAUTH already authenticated\r\n")
                .await
                .expect("greets");
        });

        assert!(matches!(
            negotiate_starttls(&mut client).await,
            Err(ImapError::Config(_))
        ));
    }

    const MIME_MESSAGE: &[u8] = b"From: Ana <ana@example.com>\r\n\
To: me@example.com\r\n\
Subject: Quarterly report\r\n\
Date: Tue, 01 Oct 2024 10:00:00 +0000\r\n\
Message-ID: <report@example.com>\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"outer\"\r\n\
\r\n\
--outer\r\n\
Content-Type: multipart/alternative; boundary=\"inner\"\r\n\
\r\n\
--inner\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Hello there, see the report.\r\n\
--inner\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<p>Hello there, see the report.</p>\r\n\
--inner--\r\n\
--outer\r\n\
Content-Type: application/pdf; name=\"report.pdf\"\r\n\
Content-Disposition: attachment; filename=\"report.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQ=\r\n\
--outer\r\n\
Content-Type: image/png\r\n\
Content-Disposition: inline; filename=\"logo.png\"\r\n\
Content-ID: <logo@example.com>\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
iVBORw0KGgo=\r\n\
--outer--\r\n";

    #[test]
    fn a_multipart_body_yields_html_text_and_attachment_descriptors() {
        let body = parse_body(MIME_MESSAGE);

        assert!(body
            .html
            .as_deref()
            .is_some_and(|html| html.contains("<p>Hello there, see the report.</p>")));
        assert!(body
            .text
            .as_deref()
            .is_some_and(|text| text.contains("Hello there, see the report.")));
        assert!(body.preview.starts_with("Hello there, see the report."));
        assert!(body.search_text.starts_with(&body.preview));
        assert!(!body.is_meeting_invitation);

        assert_eq!(body.attachments.len(), 2);
        assert_eq!(body.attachments[0].index, 0);
        assert_eq!(body.attachments[0].filename, "report.pdf");
        assert_eq!(body.attachments[0].mime_type, "application/pdf");
        assert!(!body.attachments[0].inline);
        assert_eq!(body.attachments[0].size, 8);
        assert_eq!(body.attachments[1].filename, "logo.png");
        assert_eq!(body.attachments[1].mime_type, "image/png");
        assert!(body.attachments[1].inline);
        assert_eq!(
            body.attachments[1].content_id.as_deref(),
            Some("logo@example.com")
        );
    }

    #[test]
    fn attachment_bytes_use_the_descriptor_index() {
        assert_eq!(
            attachment_bytes(MIME_MESSAGE, 0).as_deref(),
            Some(&b"%PDF-1.4"[..])
        );
        assert!(attachment_bytes(MIME_MESSAGE, 2).is_none());
    }

    #[test]
    fn a_text_only_body_has_no_html_and_a_calendar_part_is_an_invitation() {
        let raw = b"From: ana@example.com\r\n\
Subject: Lunch\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"b\"\r\n\
\r\n\
--b\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Lunch on Friday?\r\n\
--b\r\n\
Content-Type: text/calendar; charset=utf-8\r\n\
Content-Disposition: attachment; filename=\"invite.ics\"\r\n\
\r\n\
BEGIN:VCALENDAR\r\n\
END:VCALENDAR\r\n\
--b--\r\n";

        let body = parse_body(raw);

        assert!(body.html.is_none());
        assert_eq!(body.text.as_deref(), Some("Lunch on Friday?"));
        assert!(body.is_meeting_invitation);
        assert_eq!(body.attachments.len(), 1);
        assert_eq!(body.attachments[0].filename, "invite.ics");
    }

    #[test]
    fn credentials_do_not_leak_the_password_when_debugged() {
        let credentials = Credentials {
            host: "imap.example.com".to_string(),
            port: 993,
            secure: true,
            username: "person@example.com".to_string(),
            password: "hunter2".to_string(),
        };

        let rendered = format!("{credentials:?}");
        assert!(!rendered.contains("hunter2"));
        assert!(rendered.contains("imap.example.com"));
    }
}
