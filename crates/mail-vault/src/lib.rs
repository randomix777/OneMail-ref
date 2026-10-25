//! OS credential vault for local mail accounts.
//!
//! Passwords live in the platform keystore (Credential Manager, Keychain, Secret
//! Service), never in `settings.json`. The trait exists so the shell can be tested
//! without touching the real keychain.

use std::collections::HashMap;
use std::sync::Mutex;

const SERVICE: &str = "com.getinboxzero.desktop";

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("the OS keychain refused the request: {0}")]
    Keychain(String),
}

pub trait CredentialVault: Send + Sync {
    fn store(&self, account_id: &str, password: &str) -> Result<(), VaultError>;
    fn load(&self, account_id: &str) -> Result<Option<String>, VaultError>;
    fn forget(&self, account_id: &str) -> Result<(), VaultError>;
}

/// Wraps the platform keystore that `keyring` selects for this OS.
#[derive(Debug, Clone)]
pub struct KeyringVault {
    service: String,
}

impl KeyringVault {
    pub fn new() -> Self {
        Self {
            service: SERVICE.to_string(),
        }
    }

    fn entry(&self, account_id: &str) -> Result<keyring::Entry, VaultError> {
        // Namespaced so a future "smtp" or "oauth" secret can share the account id.
        let key = format!("account:{account_id}");
        keyring::Entry::new(&self.service, &key).map_err(keychain)
    }
}

impl Default for KeyringVault {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialVault for KeyringVault {
    fn store(&self, account_id: &str, password: &str) -> Result<(), VaultError> {
        self.entry(account_id)?
            .set_password(password)
            .map_err(keychain)
    }

    fn load(&self, account_id: &str) -> Result<Option<String>, VaultError> {
        match self.entry(account_id)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(keychain(error)),
        }
    }

    fn forget(&self, account_id: &str) -> Result<(), VaultError> {
        match self.entry(account_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(keychain(error)),
        }
    }
}

fn keychain(error: keyring::Error) -> VaultError {
    VaultError::Keychain(error.to_string())
}

/// Test double: same contract, process memory only.
#[derive(Default)]
pub struct MemoryVault {
    entries: Mutex<HashMap<String, String>>,
}

impl MemoryVault {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl CredentialVault for MemoryVault {
    fn store(&self, account_id: &str, password: &str) -> Result<(), VaultError> {
        self.lock()
            .insert(account_id.to_string(), password.to_string());
        Ok(())
    }

    fn load(&self, account_id: &str) -> Result<Option<String>, VaultError> {
        Ok(self.lock().get(account_id).cloned())
    }

    fn forget(&self, account_id: &str) -> Result<(), VaultError> {
        self.lock().remove(account_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_password_can_be_read_back() {
        let vault = MemoryVault::new();
        assert_eq!(vault.load("acc-1").expect("reads"), None);

        vault.store("acc-1", "secret").expect("stores");
        assert_eq!(
            vault.load("acc-1").expect("reads").as_deref(),
            Some("secret")
        );
    }

    #[test]
    fn forgetting_a_password_is_idempotent() {
        let vault = MemoryVault::new();
        vault.store("acc-1", "secret").expect("stores");

        vault.forget("acc-1").expect("forgets");
        vault.forget("acc-1").expect("forgets again");
        assert_eq!(vault.load("acc-1").expect("reads"), None);
    }
}
