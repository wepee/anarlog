// [fork] One keychain item for every secret.
//
// Each secret used to be its own keychain item: provider API keys, import
// credentials and every voiceprint sample. macOS ties an item to the code
// signature that created it, and this fork ships ad-hoc signed builds whose
// signature changes with every build, so each item prompted on its own, and
// "Always Allow" on one did nothing for the next. Startup cleanup of expired
// voiceprints alone could raise dozens of prompts.
//
// Secrets now live in a local file, each sealed with XChaCha20-Poly1305 under
// a random master key. That key is the only keychain item: at most one prompt
// per new build, and "Always Allow" covers everything behind it. The account
// name is bound as associated data, so a ciphertext cannot be swapped onto
// another secret.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};

const VERSION: u32 = 1;
const NONCE_LEN: usize = 24;
pub(crate) const KEY_LEN: usize = 32;

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct VaultFile {
    version: u32,
    /// `None` is a tombstone: the secret was deleted, so the legacy keychain
    /// item must not be read back.
    entries: BTreeMap<String, Option<String>>,
}

pub(crate) enum Lookup {
    Found(String),
    Deleted,
    Unknown,
}

pub(crate) struct Vault {
    path: PathBuf,
    cipher: XChaCha20Poly1305,
    file: VaultFile,
}

/// Secrets sealed in the vault file at `path`, readable without its key.
pub(crate) fn sealed_entries_on_disk(path: &Path) -> usize {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<VaultFile>(&bytes).ok())
        .map_or(0, |file| {
            file.entries
                .values()
                .filter(|sealed| sealed.is_some())
                .count()
        })
}

pub(crate) fn generate_key() -> Result<[u8; KEY_LEN], String> {
    let mut key = [0_u8; KEY_LEN];
    getrandom::fill(&mut key).map_err(|error| error.to_string())?;
    Ok(key)
}

pub(crate) fn encode_key(key: &[u8; KEY_LEN]) -> String {
    base64::engine::general_purpose::STANDARD.encode(key)
}

pub(crate) fn decode_key(encoded: &str) -> Option<[u8; KEY_LEN]> {
    base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?
        .try_into()
        .ok()
}

impl Vault {
    /// Opens the vault at `path` with `key`. A file sealed under another key
    /// (the keychain was reset) is set aside rather than silently overwritten.
    pub(crate) fn open(path: PathBuf, key: &[u8; KEY_LEN]) -> Result<Self, String> {
        let cipher = XChaCha20Poly1305::new(key.into());
        let file = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<VaultFile>(&bytes).map_err(|e| e.to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => VaultFile {
                version: VERSION,
                entries: BTreeMap::new(),
            },
            Err(error) => return Err(error.to_string()),
        };
        let mut vault = Self { path, cipher, file };
        if !vault.readable() {
            tracing::warn!(
                sealed = vault.sealed_count(),
                "secure_store_vault_unreadable_set_aside"
            );
            let aside = vault.path.with_extension(format!(
                "unreadable-{}.json",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or_default()
            ));
            std::fs::rename(&vault.path, aside).map_err(|e| e.to_string())?;
            vault.file = VaultFile {
                version: VERSION,
                entries: BTreeMap::new(),
            };
        }
        Ok(vault)
    }

    fn sealed_count(&self) -> usize {
        self.file
            .entries
            .values()
            .filter(|sealed| sealed.is_some())
            .count()
    }

    fn readable(&self) -> bool {
        self.file
            .entries
            .iter()
            .find_map(|(account, sealed)| sealed.as_ref().map(|sealed| (account, sealed)))
            .is_none_or(|(account, sealed)| self.unseal(account, sealed).is_ok())
    }

    pub(crate) fn get(&self, account: &str) -> Result<Lookup, String> {
        match self.file.entries.get(account) {
            None => Ok(Lookup::Unknown),
            Some(None) => Ok(Lookup::Deleted),
            Some(Some(sealed)) => self.unseal(account, sealed).map(Lookup::Found),
        }
    }

    pub(crate) fn put(&mut self, account: &str, value: &str) -> Result<(), String> {
        let sealed = self.seal(account, value)?;
        self.file.entries.insert(account.to_string(), Some(sealed));
        self.save()
    }

    pub(crate) fn delete(&mut self, account: &str) -> Result<(), String> {
        self.file.entries.insert(account.to_string(), None);
        self.save()
    }

    fn seal(&self, account: &str, value: &str) -> Result<String, String> {
        let nonce_bytes = {
            let mut nonce = [0_u8; NONCE_LEN];
            getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
            nonce
        };
        let ciphertext = self
            .cipher
            .encrypt(
                &XNonce::from(nonce_bytes),
                Payload {
                    msg: value.as_bytes(),
                    aad: account.as_bytes(),
                },
            )
            .map_err(|_| "secure-store vault encryption failed".to_string())?;
        let mut sealed = nonce_bytes.to_vec();
        sealed.extend_from_slice(&ciphertext);
        Ok(base64::engine::general_purpose::STANDARD.encode(sealed))
    }

    fn unseal(&self, account: &str, sealed: &str) -> Result<String, String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(sealed)
            .map_err(|e| e.to_string())?;
        if bytes.len() < NONCE_LEN {
            return Err("secure-store vault entry is truncated".to_string());
        }
        let (nonce, ciphertext) = bytes.split_at(NONCE_LEN);
        let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| "bad nonce".to_string())?;
        let plaintext = self
            .cipher
            .decrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: ciphertext,
                    aad: account.as_bytes(),
                },
            )
            .map_err(|_| "secure-store vault entry could not be decrypted".to_string())?;
        String::from_utf8(plaintext).map_err(|e| e.to_string())
    }

    fn save(&self) -> Result<(), String> {
        let content = serde_json::to_string(&self.file).map_err(|e| e.to_string())?;
        anlg_storage::fs::atomic_write(&self.path, &content).map_err(|e| e.to_string())?;
        restrict_permissions(&self.path);
        Ok(())
    }
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault_in(dir: &Path, key: &[u8; KEY_LEN]) -> Vault {
        Vault::open(dir.join("secure-store.vault.json"), key).unwrap()
    }

    #[test]
    fn secrets_survive_a_reopen_and_stay_encrypted_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let key = generate_key().unwrap();
        vault_in(dir.path(), &key)
            .put("ai-provider-api-keys:llm:openai", "sk-secret")
            .unwrap();

        let reopened = vault_in(dir.path(), &key);
        assert!(matches!(
            reopened.get("ai-provider-api-keys:llm:openai").unwrap(),
            Lookup::Found(value) if value == "sk-secret"
        ));
        assert!(matches!(reopened.get("missing").unwrap(), Lookup::Unknown));
        let on_disk = std::fs::read_to_string(dir.path().join("secure-store.vault.json")).unwrap();
        assert!(!on_disk.contains("sk-secret"));
    }

    #[test]
    fn a_deleted_secret_is_remembered_as_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let key = generate_key().unwrap();
        let mut vault = vault_in(dir.path(), &key);
        vault.put("scope:key", "value").unwrap();
        vault.delete("scope:key").unwrap();

        assert!(matches!(
            vault_in(dir.path(), &key).get("scope:key").unwrap(),
            Lookup::Deleted
        ));
    }

    #[test]
    fn a_ciphertext_moved_onto_another_account_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let key = generate_key().unwrap();
        let mut vault = vault_in(dir.path(), &key);
        vault.put("scope:a", "secret-a").unwrap();
        let sealed = vault.file.entries["scope:a"].clone();
        vault.file.entries.insert("scope:b".to_string(), sealed);

        assert!(vault.get("scope:b").is_err());
    }

    #[test]
    fn a_vault_sealed_under_a_lost_key_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        vault_in(dir.path(), &generate_key().unwrap())
            .put("scope:key", "value")
            .unwrap();

        let vault = vault_in(dir.path(), &generate_key().unwrap());

        assert!(matches!(vault.get("scope:key").unwrap(), Lookup::Unknown));
        let aside = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains("unreadable"));
        assert!(aside);
    }

    #[test]
    fn master_keys_round_trip_through_their_keychain_encoding() {
        let key = generate_key().unwrap();
        assert_eq!(decode_key(&encode_key(&key)), Some(key));
        assert_eq!(decode_key("not a key"), None);
    }
}
