//! SMTP submission for the Rust mail engine.
//!
//! The protocol surface is deliberately small: EHLO, AUTH (PLAIN or LOGIN), one
//! envelope, one DATA block, QUIT. Message bodies are HTML only and travel
//! base64-encoded, so no line-ending or dot-stuffing rule depends on the body's
//! text. Implicit TLS and STARTTLS are both supported.

use std::fmt;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_native_tls::TlsStream;

/// How long connecting, the TLS handshake and AUTH may take together.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// A submission's greeting, EHLO and AUTH must finish before any mail is sent.
const SESSION_TIMEOUT: Duration = Duration::from_secs(30);
/// One command/response round trip before the DATA block.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(45);
/// A settings check includes the greeting and AUTH round trips too.
const VERIFY_TIMEOUT: Duration = Duration::from_secs(30);
/// How long one whole submission may take, including the Sent copy.
const SEND_TIMEOUT: Duration = Duration::from_secs(90);
const EHLO_NAME: &str = "onemail.local";
const MAX_RESPONSE_LINES: usize = 100;
const MAX_RESPONSE_LINE: usize = 16 * 1024;
const MAX_ENCODED_WORD_BYTES: usize = 45;

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
pub enum SmtpError {
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
    #[error("the server rejected the message: {0}")]
    Rejected(String),
    #[error("SMTP request failed: {0}")]
    Network(String),
    /// The DATA block was written but the server's verdict never arrived. The
    /// message may have been accepted, so it must not be sent again blindly.
    #[error("delivery is unconfirmed: {0}")]
    Uncertain(String),
}

/// One HTML message. Header values that came from the user are sanitized while
/// building; envelope addresses are validated first.
pub struct Message<'a> {
    pub from: &'a str,
    pub from_name: &'a str,
    pub to: &'a [String],
    pub cc: &'a [String],
    pub bcc: &'a [String],
    pub subject: &'a str,
    pub html: &'a str,
    pub message_id: &'a str,
    pub in_reply_to: Option<&'a str>,
    pub date_ms: i64,
}

pub struct Sent {
    /// The exact bytes submitted, so the caller can APPEND the same message to Sent.
    pub raw: Vec<u8>,
    /// Recipients the server refused while the rest were accepted.
    pub rejected: Vec<String>,
}

/// Logs in and hangs up, for the settings dialog's connection check.
pub async fn verify(credentials: &Credentials) -> Result<(), SmtpError> {
    let endpoint = format!("{}:{}", credentials.host, credentials.port);
    tokio::time::timeout(VERIFY_TIMEOUT, async {
        let mut session = Session::connect(credentials).await?;
        let _ = session.quit().await;
        Ok(())
    })
    .await
    .map_err(|_| SmtpError::Timeout(endpoint))?
}

pub async fn send(credentials: &Credentials, message: &Message<'_>) -> Result<Sent, SmtpError> {
    let endpoint = format!("{}:{}", credentials.host, credentials.port);
    tokio::time::timeout(SEND_TIMEOUT, send_inner(credentials, message))
        .await
        .map_err(|_| SmtpError::Uncertain(format!("timed out talking to {endpoint}")))?
}

/// A stable Message-ID for an operation, so a retried send reuses the same id
/// and the Sent copy check can tell whether the message is already there.
pub fn message_id(account_id: &str, operation_id: &str) -> String {
    let digest = Sha256::digest(format!("{account_id}:{operation_id}").as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!("<{hex}@onemail.local>")
}

async fn send_inner(credentials: &Credentials, message: &Message<'_>) -> Result<Sent, SmtpError> {
    let raw = build_message(message)?;
    let from = envelope_address(message.from)?;
    let recipients = envelope_recipients(message)?;
    let endpoint = format!("{}:{}", credentials.host, credentials.port);
    let mut session = tokio::time::timeout(SESSION_TIMEOUT, Session::connect(credentials))
        .await
        .map_err(|_| SmtpError::Timeout(endpoint))??;

    let response = session.command(&format!("MAIL FROM:<{from}>")).await?;
    if response.code != 250 {
        let _ = session.quit().await;
        return Err(response_error(response, "MAIL FROM"));
    }

    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    for recipient in &recipients {
        let response = session.command(&format!("RCPT TO:<{recipient}>")).await?;
        if matches!(response.code, 250 | 251) {
            accepted.push(recipient.clone());
        } else if (400..500).contains(&response.code) {
            let _ = session.quit().await;
            return Err(SmtpError::Network(format!(
                "the server temporarily refused {recipient}: {}",
                response.text
            )));
        } else {
            rejected.push(recipient.clone());
        }
    }
    if accepted.is_empty() {
        let _ = session.quit().await;
        return Err(SmtpError::Rejected(
            "every recipient was rejected".to_string(),
        ));
    }

    let response = session.command("DATA").await?;
    if response.code != 354 {
        let _ = session.quit().await;
        return Err(response_error(response, "DATA"));
    }
    if let Err(error) = session.write_data(&raw).await {
        return Err(SmtpError::Uncertain(error.to_string()));
    }
    let response = match session.response().await {
        Ok(response) => response,
        Err(error) => return Err(SmtpError::Uncertain(error.to_string())),
    };
    if response.code != 250 {
        return Err(SmtpError::Uncertain(format!(
            "the server did not confirm the message: {}",
            response.text
        )));
    }
    let _ = session.quit().await;
    Ok(Sent { raw, rejected })
}

/// Builds the RFC 5322 bytes submitted in DATA and appended to Sent.
pub fn build_message(message: &Message<'_>) -> Result<Vec<u8>, SmtpError> {
    let from = envelope_address(message.from)?;
    let to = addresses(message.to)?;
    let cc = addresses(message.cc)?;
    let bcc = addresses(message.bcc)?;
    if to.is_empty() && cc.is_empty() && bcc.is_empty() {
        return Err(SmtpError::Config(
            "the message has no recipients".to_string(),
        ));
    }

    let mut headers = vec![
        format!("Date: {}", format_date(message.date_ms)),
        folded_header("From", &mailbox(message.from_name, &from)),
        folded_header("To", &to.join(", ")),
        folded_header("Message-ID", &header_message_id(message.message_id)),
        folded_header("Subject", &encode_word(message.subject)),
        "MIME-Version: 1.0".to_string(),
        "Content-Type: text/html; charset=UTF-8".to_string(),
        "Content-Transfer-Encoding: base64".to_string(),
    ];
    if !cc.is_empty() {
        headers.insert(3, folded_header("Cc", &cc.join(", ")));
    }
    if let Some(parent) = message.in_reply_to {
        let parent = header_message_id(parent);
        headers.push(folded_header("In-Reply-To", &parent));
        headers.push(folded_header("References", &parent));
    }
    // Bcc is an envelope recipient only: the delivered message must not show it.

    let body = base64_body(message.html);
    let raw = format!("{}\r\n\r\n{}\r\n", headers.join("\r\n"), body);
    Ok(raw.into_bytes())
}

struct Session<T> {
    stream: BufReader<T>,
}

struct Response {
    code: u16,
    text: String,
}

impl Session<TlsStream<TcpStream>> {
    async fn connect(credentials: &Credentials) -> Result<Self, SmtpError> {
        let endpoint = format!("{}:{}", credentials.host, credentials.port);
        let connector = native_tls::TlsConnector::builder()
            .build()
            .map_err(|error| SmtpError::Tls(error.to_string()))?;
        let connector = tokio_native_tls::TlsConnector::from(connector);
        let socket = tokio::time::timeout(
            CONNECT_TIMEOUT,
            TcpStream::connect((credentials.host.as_str(), credentials.port)),
        )
        .await
        .map_err(|_| SmtpError::Timeout(endpoint.clone()))?
        .map_err(|source| SmtpError::Connect {
            host: credentials.host.clone(),
            port: credentials.port,
            source,
        })?;

        if credentials.secure {
            let stream = tls_connect(&connector, credentials, socket, &endpoint).await?;
            let mut session = Self {
                stream: BufReader::new(stream),
            };
            session.begin(credentials).await?;
            return Ok(session);
        }

        // STARTTLS: greet and negotiate in the clear, upgrade, then greet again.
        let mut plain = Session {
            stream: BufReader::new(socket),
        };
        let greeting = plain.response().await?;
        if greeting.code != 220 {
            return Err(response_error(greeting, "greeting"));
        }
        let response = plain.command(&format!("EHLO {EHLO_NAME}")).await?;
        if response.code != 250 {
            return Err(response_error(response, "EHLO"));
        }
        if !offers_starttls(&response.text) {
            return Err(SmtpError::Config(
                "The server does not offer STARTTLS. Choose TLS when the server uses an implicit-TLS port."
                    .to_string(),
            ));
        }
        let response = plain.command("STARTTLS").await?;
        if response.code != 220 {
            return Err(response_error(response, "STARTTLS"));
        }
        if !plain.stream.buffer().is_empty() {
            return Err(SmtpError::Network(
                "the server sent data before the TLS handshake".to_string(),
            ));
        }
        let stream = tls_connect(
            &connector,
            credentials,
            plain.stream.into_inner(),
            &endpoint,
        )
        .await?;
        let mut session = Self {
            stream: BufReader::new(stream),
        };
        let response = session.command(&format!("EHLO {EHLO_NAME}")).await?;
        if response.code != 250 {
            return Err(response_error(response, "EHLO"));
        }
        session.auth_if_offered(credentials, &response.text).await?;
        Ok(session)
    }
}

impl<T: AsyncRead + AsyncWrite + Unpin> Session<T> {
    async fn begin(&mut self, credentials: &Credentials) -> Result<(), SmtpError> {
        let greeting = self.response().await?;
        if greeting.code != 220 {
            return Err(response_error(greeting, "greeting"));
        }
        let response = self.command(&format!("EHLO {EHLO_NAME}")).await?;
        if response.code != 250 {
            return Err(response_error(response, "EHLO"));
        }
        self.auth_if_offered(credentials, &response.text).await
    }

    async fn auth_if_offered(
        &mut self,
        credentials: &Credentials,
        ehlo: &str,
    ) -> Result<(), SmtpError> {
        let mechanisms = auth_mechanisms(ehlo);
        if mechanisms.is_empty() {
            return Ok(());
        }
        self.authenticate(credentials, &mechanisms).await
    }

    async fn authenticate(
        &mut self,
        credentials: &Credentials,
        mechanisms: &[String],
    ) -> Result<(), SmtpError> {
        if mechanisms.iter().any(|mechanism| mechanism == "PLAIN") {
            let token = BASE64
                .encode(format!("\0{}\0{}", credentials.username, credentials.password).as_bytes());
            let response = self.command(&format!("AUTH PLAIN {token}")).await?;
            return auth_result(response);
        }
        if mechanisms.iter().any(|mechanism| mechanism == "LOGIN") {
            let response = self.command("AUTH LOGIN").await?;
            if response.code != 334 {
                return Err(auth_failure(response));
            }
            let response = self
                .command(&BASE64.encode(credentials.username.as_bytes()))
                .await?;
            if response.code != 334 {
                return Err(auth_failure(response));
            }
            let response = self
                .command(&BASE64.encode(credentials.password.as_bytes()))
                .await?;
            return auth_result(response);
        }
        Err(SmtpError::Login(format!(
            "the server offers no supported AUTH mechanism ({})",
            mechanisms.join(" ")
        )))
    }

    async fn command(&mut self, command: &str) -> Result<Response, SmtpError> {
        self.stream
            .write_all(format!("{command}\r\n").as_bytes())
            .await
            .map_err(|error| SmtpError::Network(error.to_string()))?;
        self.stream
            .flush()
            .await
            .map_err(|error| SmtpError::Network(error.to_string()))?;
        tokio::time::timeout(COMMAND_TIMEOUT, self.response())
            .await
            .map_err(|_| SmtpError::Network("timed out waiting for the SMTP server".to_string()))?
    }

    async fn write_data(&mut self, raw: &[u8]) -> Result<(), SmtpError> {
        self.stream
            .write_all(&data_payload(raw))
            .await
            .map_err(|error| SmtpError::Network(error.to_string()))?;
        self.stream
            .flush()
            .await
            .map_err(|error| SmtpError::Network(error.to_string()))
    }

    async fn response(&mut self) -> Result<Response, SmtpError> {
        let mut text = String::new();
        for _ in 0..MAX_RESPONSE_LINES {
            let mut line = Vec::new();
            let read = self
                .stream
                .read_until(b'\n', &mut line)
                .await
                .map_err(|error| SmtpError::Network(error.to_string()))?;
            if read == 0 {
                return Err(SmtpError::Network(
                    "the server closed the connection".to_string(),
                ));
            }
            if line.len() > MAX_RESPONSE_LINE {
                return Err(SmtpError::Network("oversized SMTP response".to_string()));
            }
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\r', '\n']);
            if line.len() < 3 {
                return Err(SmtpError::Network(format!(
                    "unreadable SMTP response: {line}"
                )));
            }
            let code = line
                .get(..3)
                .and_then(|code| code.parse::<u16>().ok())
                .ok_or_else(|| SmtpError::Network(format!("unreadable SMTP response: {line}")))?;
            let last = line.len() == 3 || line.as_bytes().get(3) == Some(&b' ');
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(line);
            if last {
                return Ok(Response { code, text });
            }
        }
        Err(SmtpError::Network(
            "the server sent too many response lines".to_string(),
        ))
    }

    async fn quit(&mut self) -> Result<(), SmtpError> {
        self.command("QUIT").await.map(|_| ())
    }
}

async fn tls_connect(
    connector: &tokio_native_tls::TlsConnector,
    credentials: &Credentials,
    socket: TcpStream,
    endpoint: &str,
) -> Result<TlsStream<TcpStream>, SmtpError> {
    tokio::time::timeout(
        CONNECT_TIMEOUT,
        connector.connect(&credentials.host, socket),
    )
    .await
    .map_err(|_| SmtpError::Timeout(endpoint.to_string()))?
    .map_err(|error| SmtpError::Tls(error.to_string()))
}

fn offers_starttls(ehlo: &str) -> bool {
    ehlo.lines().any(|line| {
        line.get(4..)
            .unwrap_or_default()
            .split_whitespace()
            .any(|token| token == "STARTTLS")
    })
}

fn response_error(response: Response, step: &str) -> SmtpError {
    if (400..500).contains(&response.code) {
        return SmtpError::Network(format!("{step} was refused temporarily: {}", response.text));
    }
    SmtpError::Rejected(format!("{step} was refused: {}", response.text))
}

fn auth_result(response: Response) -> Result<(), SmtpError> {
    if response.code == 235 {
        return Ok(());
    }
    Err(auth_failure(response))
}

fn auth_failure(response: Response) -> SmtpError {
    if (400..500).contains(&response.code) {
        return SmtpError::Network(format!("authentication was deferred: {}", response.text));
    }
    SmtpError::Login(response.text)
}

fn auth_mechanisms(response: &str) -> Vec<String> {
    let mut mechanisms = Vec::new();
    for line in response.lines() {
        let entry = line.get(4..).unwrap_or_default();
        if let Some(list) = entry
            .strip_prefix("AUTH ")
            .or_else(|| entry.strip_prefix("AUTH="))
        {
            mechanisms.extend(list.split_whitespace().map(str::to_ascii_uppercase));
        }
    }
    mechanisms
}

fn addresses(values: &[String]) -> Result<Vec<String>, SmtpError> {
    values.iter().map(|value| envelope_address(value)).collect()
}

fn envelope_recipients(message: &Message<'_>) -> Result<Vec<String>, SmtpError> {
    let mut recipients = addresses(message.to)?;
    recipients.extend(addresses(message.cc)?);
    recipients.extend(addresses(message.bcc)?);
    let mut unique = Vec::with_capacity(recipients.len());
    for recipient in recipients {
        if !unique.contains(&recipient) {
            unique.push(recipient);
        }
    }
    Ok(unique)
}

/// The address inside an optional display name, with any header-breaking
/// character refused rather than stripped.
fn envelope_address(raw: &str) -> Result<String, SmtpError> {
    let value = raw.trim();
    let candidate = match (value.find('<'), value.rfind('>')) {
        (Some(start), Some(end)) if end > start => value[start + 1..end].trim(),
        _ => value,
    };
    let valid = !candidate.is_empty()
        && !candidate
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        && !candidate.contains(['<', '>', ',', ';', '"']);
    if valid {
        if let Some((local, domain)) = candidate.split_once('@') {
            if !local.is_empty() && !domain.is_empty() && !domain.contains('@') {
                return Ok(candidate.to_string());
            }
        }
    }
    Err(SmtpError::Config(format!("invalid email address: {raw}")))
}

fn mailbox(name: &str, address: &str) -> String {
    let name = header_value(name);
    let name = name.trim();
    if name.is_empty() {
        return address.to_string();
    }
    let encoded = encode_word(name);
    if encoded.starts_with("=?") {
        format!("{encoded} <{address}>")
    } else {
        format!(
            "\"{}\" <{address}>",
            encoded.replace('\\', "\\\\").replace('"', "\\\"")
        )
    }
}

fn header_value(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character == '\r' || character == '\n' {
                ' '
            } else {
                character
            }
        })
        .collect()
}

fn header_message_id(value: &str) -> String {
    let value = header_value(value);
    let value = value.trim();
    if value.starts_with('<') && value.ends_with('>') {
        value.to_string()
    } else {
        format!("<{value}>")
    }
}

/// Folds a header at spaces so address lists and encoded-word subjects stay
/// inside the RFC 5322 line-length budget. A single token longer than the
/// budget is left whole rather than split into invalid fragments.
fn folded_header(name: &str, value: &str) -> String {
    const BUDGET: usize = 78;
    let mut header = format!("{name}:");
    let mut length = header.len();
    let mut started = false;
    for word in value.split(' ') {
        if started && length + 1 + word.len() > BUDGET {
            header.push_str("\r\n ");
            length = 1 + word.len();
        } else {
            header.push(' ');
            length += 1 + word.len();
        }
        header.push_str(word);
        started = true;
    }
    header
}

/// RFC 2047 encoding for non-ASCII header text; ASCII passes through untouched.
fn encode_word(value: &str) -> String {
    let value = header_value(value);
    if value.is_ascii() {
        return value;
    }
    let mut words = Vec::new();
    let mut chunk = String::new();
    for character in value.chars() {
        if !chunk.is_empty() && chunk.len() + character.len_utf8() > MAX_ENCODED_WORD_BYTES {
            words.push(BASE64.encode(chunk.as_bytes()));
            chunk.clear();
        }
        chunk.push(character);
    }
    if !chunk.is_empty() {
        words.push(BASE64.encode(chunk.as_bytes()));
    }
    words
        .into_iter()
        .map(|word| format!("=?UTF-8?B?{word}?="))
        .collect::<Vec<_>>()
        .join(" ")
}

fn base64_body(value: &str) -> String {
    let encoded = BASE64.encode(value.as_bytes());
    encoded
        .as_bytes()
        .chunks(76)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\r\n")
}

fn data_payload(raw: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(raw.len() + 8);
    let mut line_start = true;
    for &byte in raw {
        if line_start && byte == b'.' {
            payload.push(b'.');
        }
        payload.push(byte);
        line_start = byte == b'\n';
    }
    if !line_start {
        payload.extend_from_slice(b"\r\n");
    }
    payload.extend_from_slice(b".\r\n");
    payload
}

/// RFC 5322 date in UTC, without pulling a calendar crate into the engine.
pub fn format_date(ms: i64) -> String {
    const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];

    let seconds = ms.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let time_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let weekday = WEEKDAYS[(days + 4).rem_euclid(7) as usize];
    let hour = time_of_day / 3_600;
    let minute = (time_of_day % 3_600) / 60;
    let second = time_of_day % 60;
    format!(
        "{weekday}, {day:02} {} {year:04} {hour:02}:{minute:02}:{second:02} +0000",
        MONTHS[(month - 1) as usize]
    )
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaked(values: &[&str]) -> &'static [String] {
        Box::leak(
            values
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        )
    }

    fn message() -> Message<'static> {
        Message {
            from: "sender@example.com",
            from_name: "Sender",
            to: leaked(&["one@example.com"]),
            cc: leaked(&["two@example.com"]),
            bcc: leaked(&["hidden@example.com"]),
            subject: "Hello",
            html: "<p>Hi</p>",
            message_id: "<abc@onemail.local>",
            in_reply_to: None,
            date_ms: 1_709_210_096_000,
        }
    }

    #[test]
    fn the_built_message_hides_bcc_and_encodes_the_body() {
        let raw = String::from_utf8(build_message(&message()).expect("builds")).expect("utf8");
        assert!(raw.contains("From: \"Sender\" <sender@example.com>\r\n"));
        assert!(raw.contains("To: one@example.com\r\n"));
        assert!(raw.contains("Cc: two@example.com\r\n"));
        assert!(!raw.contains("hidden@example.com"));
        assert!(raw.contains("Date: Thu, 29 Feb 2024 12:34:56 +0000\r\n"));
        assert!(raw.contains("Subject: Hello\r\n"));
        assert!(raw.contains("Content-Transfer-Encoding: base64\r\n"));

        let body = raw.split_once("\r\n\r\n").expect("has a body").1;
        let body = body.trim_end_matches("\r\n");
        let decoded = BASE64.decode(body).expect("decodes");
        assert_eq!(String::from_utf8(decoded).expect("utf8"), "<p>Hi</p>");
    }

    #[test]
    fn a_reply_carries_both_threading_headers() {
        let raw = build_message(&Message {
            in_reply_to: Some("parent@example.com"),
            ..message()
        })
        .expect("builds");
        let raw = String::from_utf8(raw).expect("utf8");
        assert!(raw.contains("In-Reply-To: <parent@example.com>\r\n"));
        assert!(raw.contains("References: <parent@example.com>\r\n"));
    }

    #[test]
    fn non_ascii_headers_become_encoded_words() {
        let raw = build_message(&Message {
            subject: "Grüße",
            from_name: "Jörg",
            ..message()
        })
        .expect("builds");
        let raw = String::from_utf8(raw).expect("utf8");
        assert!(raw.contains("Subject: =?UTF-8?B?"));
        assert!(raw.contains("From: =?UTF-8?B?"));
    }

    #[test]
    fn addresses_cannot_smuggle_headers_or_extra_recipients() {
        let injected = vec!["one@example.com\r\nBcc: hidden@example.com".to_string()];
        let with_newline = Message {
            to: &injected,
            ..message()
        };
        assert!(matches!(
            build_message(&with_newline),
            Err(SmtpError::Config(_))
        ));

        let two = vec!["one@example.com, two@example.com".to_string()];
        let with_comma = Message {
            to: &two,
            ..message()
        };
        assert!(matches!(
            build_message(&with_comma),
            Err(SmtpError::Config(_))
        ));
    }

    #[test]
    fn data_payload_stuffs_dots_and_terminates() {
        assert_eq!(
            data_payload(b"Subject: x\r\n\r\n.hi\r\n"),
            b"Subject: x\r\n\r\n..hi\r\n.\r\n"
        );
        assert_eq!(data_payload(b"no newline"), b"no newline\r\n.\r\n");
    }

    #[test]
    fn dates_are_formatted_in_utc() {
        assert_eq!(format_date(0), "Thu, 01 Jan 1970 00:00:00 +0000");
        assert_eq!(
            format_date(1_792_800_000_000),
            "Sat, 24 Oct 2026 00:00:00 +0000"
        );
    }

    #[test]
    fn ehlo_capabilities_are_read_from_both_line_shapes() {
        let ehlo = "250-smtp.example.com\n250-STARTTLS\n250-AUTH PLAIN LOGIN\n250 OK";
        assert!(offers_starttls(ehlo));
        assert_eq!(
            auth_mechanisms(ehlo),
            vec!["PLAIN".to_string(), "LOGIN".to_string()]
        );

        let ehlo = "250-smtp.example.com\n250 AUTH=LOGIN";
        assert!(!offers_starttls(ehlo));
        assert_eq!(auth_mechanisms(ehlo), vec!["LOGIN".to_string()]);
    }

    #[test]
    fn message_ids_are_stable_per_operation() {
        let first = message_id("acc-1", "cmd-1");
        assert_eq!(first, message_id("acc-1", "cmd-1"));
        assert_ne!(first, message_id("acc-1", "cmd-2"));
        assert!(first.starts_with('<') && first.ends_with("@onemail.local>"));
    }
}
