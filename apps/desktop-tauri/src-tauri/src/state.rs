use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use mail_store::MailStore;
use mail_vault::KeyringVault;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub host: String,
    pub port: u16,
    pub secure: bool,
}

/// The account shape the renderer receives from `local_settings`.
///
/// Credentials are deliberately absent: the password lives in the OS keychain
/// (`mail-vault`), never in this file. The renderer still sends it on save, and
/// `local_account_save` verifies it against IMAP before storing it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAccount {
    pub id: String,
    pub email: String,
    pub name: String,
    pub username: String,
    pub imap: Server,
    pub smtp: Server,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSettings {
    #[serde(default)]
    pub accounts: Vec<LocalAccount>,
    #[serde(default)]
    pub ai: Option<serde_json::Value>,
}

pub struct Paths {
    pub settings: PathBuf,
    pub mailbox: PathBuf,
}

impl Paths {
    /// Keeps the profile under `%APPDATA%/OneMail`. The SQLite mirror uses its
    /// own filename so an older Electron-era profile is never opened by two
    /// engines.
    pub fn resolve() -> Self {
        let data_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("OneMail");
        Self {
            settings: data_dir.join("settings.json"),
            mailbox: data_dir.join("local-mailbox.rust.sqlite"),
        }
    }
}

/// How many full-message downloads may be in flight at once. Opening one IMAP
/// connection per visible message would otherwise stampede the server when a
/// conversation is opened.
const MAX_CONCURRENT_FETCHES: usize = 2;

pub struct AppState {
    pub paths: Paths,
    pub store: Mutex<MailStore>,
    pub settings: Mutex<LocalSettings>,
    pub subscriptions: Mutex<HashMap<String, serde_json::Value>>,
    /// Message keys with a body fetch already running, so repeated renderer
    /// requests collapse into one network round trip.
    pub fetching: Mutex<HashSet<String>>,
    /// Accounts with a sync already running, so launch, manual and periodic
    /// syncs do not stack up on the same mailbox.
    pub syncing: Mutex<HashSet<String>>,
    /// Accounts with an IDLE watcher, so the supervisor does not duplicate one.
    pub idling: Mutex<HashSet<String>>,
    /// Accounts whose server does not advertise IDLE; these rely on polling.
    pub idle_unsupported: Mutex<HashSet<String>>,
    /// Bounds concurrent full-message downloads.
    pub fetch_permits: tokio::sync::Semaphore,
    /// One JYI sign-in can be open at a time; this is cleared when it ends.
    pub ai_login: AtomicBool,
    pub vault: KeyringVault,
}

impl AppState {
    pub fn load() -> Result<Self, String> {
        let paths = Paths::resolve();
        let settings = read_settings(&paths.settings);
        let store = MailStore::open(&paths.mailbox).map_err(|error| error.to_string())?;
        for account in &settings.accounts {
            let _ = store.register_account(&account.id);
        }
        Ok(Self {
            paths,
            store: Mutex::new(store),
            settings: Mutex::new(settings),
            subscriptions: Mutex::new(HashMap::new()),
            fetching: Mutex::new(HashSet::new()),
            syncing: Mutex::new(HashSet::new()),
            idling: Mutex::new(HashSet::new()),
            idle_unsupported: Mutex::new(HashSet::new()),
            fetch_permits: tokio::sync::Semaphore::new(MAX_CONCURRENT_FETCHES),
            ai_login: AtomicBool::new(false),
            vault: KeyringVault::new(),
        })
    }

    /// Registers a body fetch for `key`. `None` means one is already running.
    pub fn claim_fetch(&self, key: &str) -> Option<FetchClaim<'_>> {
        let mut fetching = self.fetching.lock().ok()?;
        if !fetching.insert(key.to_string()) {
            return None;
        }
        drop(fetching);
        Some(FetchClaim {
            state: self,
            key: key.to_string(),
        })
    }

    /// Registers a sync for `account_id`. `None` means one is already running.
    pub fn claim_sync(&self, account_id: &str) -> Option<SyncClaim<'_>> {
        let mut syncing = self.syncing.lock().ok()?;
        if !syncing.insert(account_id.to_string()) {
            return None;
        }
        drop(syncing);
        Some(SyncClaim {
            state: self,
            account_id: account_id.to_string(),
        })
    }

    /// Registers an IDLE watcher for `account_id`.
    pub fn claim_idle(&self, account_id: &str) -> Option<IdleClaim<'_>> {
        if self
            .idle_unsupported
            .lock()
            .map(|unsupported| unsupported.contains(account_id))
            .unwrap_or(true)
        {
            return None;
        }
        let mut idling = self.idling.lock().ok()?;
        if !idling.insert(account_id.to_string()) {
            return None;
        }
        drop(idling);
        Some(IdleClaim {
            state: self,
            account_id: account_id.to_string(),
        })
    }

    pub fn mark_idle_unsupported(&self, account_id: &str) {
        if let Ok(mut unsupported) = self.idle_unsupported.lock() {
            unsupported.insert(account_id.to_string());
        }
    }

    pub fn forget_idle_state(&self, account_id: &str) {
        if let Ok(mut unsupported) = self.idle_unsupported.lock() {
            unsupported.remove(account_id);
        }
    }
}

/// Releases the sync marker even when the sync task unwinds.
pub struct SyncClaim<'a> {
    state: &'a AppState,
    account_id: String,
}

impl Drop for SyncClaim<'_> {
    fn drop(&mut self) {
        if let Ok(mut syncing) = self.state.syncing.lock() {
            syncing.remove(&self.account_id);
        }
    }
}

/// Releases the IDLE marker when the watcher exits.
pub struct IdleClaim<'a> {
    state: &'a AppState,
    account_id: String,
}

impl Drop for IdleClaim<'_> {
    fn drop(&mut self) {
        if let Ok(mut idling) = self.state.idling.lock() {
            idling.remove(&self.account_id);
        }
    }
}

/// Releases the in-flight marker even when the fetch task unwinds.
pub struct FetchClaim<'a> {
    state: &'a AppState,
    key: String,
}

impl Drop for FetchClaim<'_> {
    fn drop(&mut self) {
        if let Ok(mut fetching) = self.state.fetching.lock() {
            fetching.remove(&self.key);
        }
    }
}

fn read_settings(path: &Path) -> LocalSettings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn write_settings(path: &Path, settings: &LocalSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    std::fs::write(path, raw).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_survive_a_round_trip() {
        let dir = std::env::temp_dir().join(format!("onemail-settings-{}", uuid::Uuid::new_v4()));
        let path = dir.join("settings.json");
        let settings = LocalSettings {
            accounts: vec![LocalAccount {
                id: "acc-1".into(),
                email: "person@example.com".into(),
                name: "Person".into(),
                username: "person@example.com".into(),
                imap: Server {
                    host: "imap.example.com".into(),
                    port: 993,
                    secure: true,
                },
                smtp: Server {
                    host: "smtp.example.com".into(),
                    port: 465,
                    secure: true,
                },
            }],
            ai: None,
        };

        write_settings(&path, &settings).expect("writes");
        let restored = read_settings(&path);
        assert_eq!(restored.accounts.len(), 1);
        assert_eq!(restored.accounts[0].imap.host, "imap.example.com");
    }

    #[test]
    fn a_missing_settings_file_reads_as_no_accounts() {
        let restored = read_settings(Path::new("/nonexistent/onemail/settings.json"));
        assert!(restored.accounts.is_empty());
        assert!(restored.ai.is_none());
    }
}
