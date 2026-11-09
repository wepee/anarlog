use std::sync::PoisonError;

use crate::Store2PluginExt;
use crate::chunked::{self, ChunkedError};

const SECURE_STORE_SUFFIX: &str = "secure-store";
const NATIVE_SECRET_ACCOUNT_PREFIXES: &[&str] = &["e2ee:"];
#[cfg(target_os = "macos")]
const MACOS_KEYCHAIN_ACCESS_ERROR_PREFIX: &str = "macOS couldn't access your login Keychain.";
#[cfg(target_os = "linux")]
const LINUX_SECRET_SERVICE_ACCESS_ERROR: &str =
    "Linux couldn't access Secret Service. Unlock your login keyring, then try again.";
#[cfg(target_os = "linux")]
const LINUX_SECRET_SERVICE_UNAVAILABLE_ERROR: &str =
    "Linux Secret Service is unavailable. Start your desktop keyring service, then try again.";

#[cfg(target_os = "macos")]
const ERR_SEC_AUTH_FAILED: i32 = -25293;

#[derive(Clone, Copy, PartialEq, Eq)]
enum SecretCaller {
    Native,
    Renderer,
}

fn validate_secret_coordinate(caller: SecretCaller, scope: &str, key: &str) -> Result<(), String> {
    let account = format!("{scope}:{key}");
    if caller == SecretCaller::Renderer
        && NATIVE_SECRET_ACCOUNT_PREFIXES
            .iter()
            .any(|prefix| account.starts_with(prefix))
    {
        return Err("secure-store account is reserved for native use".to_string());
    }

    Ok(())
}

// The keychain namespace is deliberately not the bundle id. Renaming the bundle
// would otherwise strand every stored secret -- provider API keys, connected
// import credentials and the CloudSync identity -- behind a service name nothing
// looks up any more. Each new id maps onto the namespace its channel already
// writes to, so a rename costs the user nothing.
fn secure_store_service(identifier: &str) -> String {
    let identifier = match identifier {
        "com.hyprnote.dev" | "com.blackmushi.dev" => "com.anarlog.dev",
        "com.hyprnote.staging" | "com.blackmushi.staging" => "com.anarlog.staging",
        "com.hyprnote.stable"
        | "com.hyprnote.Hyprnote"
        | "com.blackmushi.stable"
        | "com.blackmushi.desktop" => "com.anarlog.stable",
        "com.blackmushi.nightly" => "com.hyprnote.nightly",
        identifier => identifier,
    };

    format!("{identifier}.{SECURE_STORE_SUFFIX}")
}

fn secure_store_account(identifier: &str, scope: &str, key: &str) -> String {
    let account = format!("{scope}:{key}");
    if matches!(identifier, "com.hyprnote.dev" | "com.blackmushi.dev") {
        // Rotate away from dev items whose ACLs captured unstable ad-hoc signatures.
        // The renamed dev id has to keep the same prefix, or the service remap
        // above would find the right keychain service and still miss the account.
        format!("v2:{account}")
    } else {
        account
    }
}

fn secure_store_error(error: keyring::Error) -> String {
    #[cfg(target_os = "macos")]
    if keychain_error_code(&error) == Some(ERR_SEC_AUTH_FAILED) {
        return format!(
            "{MACOS_KEYCHAIN_ACCESS_ERROR_PREFIX} Use “Repair Keychain Access” below, then try again."
        );
    }

    #[cfg(target_os = "linux")]
    match error {
        keyring::Error::NoStorageAccess(_) => {
            return LINUX_SECRET_SERVICE_ACCESS_ERROR.to_string();
        }
        keyring::Error::PlatformFailure(_) => {
            return LINUX_SECRET_SERVICE_UNAVAILABLE_ERROR.to_string();
        }
        _ => {}
    }

    error.to_string()
}

#[cfg(target_os = "macos")]
fn keychain_error_code(error: &keyring::Error) -> Option<i32> {
    let source = match error {
        keyring::Error::PlatformFailure(source) | keyring::Error::NoStorageAccess(source) => source,
        _ => return None,
    };

    source
        .downcast_ref::<security_framework::base::Error>()
        .map(|error| error.code())
}

#[cfg(target_os = "macos")]
fn repair_macos_keychain_access() -> Result<(), String> {
    use objc2_security::SecKeychain;

    const ERR_SEC_SUCCESS: i32 = 0;
    const ERR_SEC_USER_CANCELED: i32 = -128;

    #[allow(deprecated)]
    let lock_status = unsafe { SecKeychain::lock(None) };
    if lock_status != ERR_SEC_SUCCESS {
        return Err(format!(
            "macOS couldn't lock your login Keychain (OSStatus {lock_status})."
        ));
    }

    #[allow(deprecated)]
    let unlock_status = unsafe { SecKeychain::unlock(None, 0, std::ptr::null(), false) };
    if unlock_status == ERR_SEC_USER_CANCELED {
        return Err(
            "Keychain unlock was cancelled. Your login Keychain is still locked; run the repair again to unlock it."
                .to_string(),
        );
    }
    if unlock_status != ERR_SEC_SUCCESS {
        return Err(format!(
            "macOS couldn't unlock your login Keychain (OSStatus {unlock_status}). Your login Keychain is still locked."
        ));
    }

    Ok(())
}

fn legacy_secret_locations(identifier: &str, scope: &str, key: &str) -> Vec<(String, String)> {
    let service = secure_store_service(identifier);
    let account = format!("{scope}:{key}");
    let current_account = secure_store_account(identifier, scope, key);
    let legacy_service = format!("{identifier}.{SECURE_STORE_SUFFIX}");
    let mut locations = Vec::new();

    if account != current_account {
        locations.push((service.clone(), account.clone()));
    }
    if legacy_service != service {
        locations.push((legacy_service, account));
    }

    locations
}

fn legacy_secret_entries<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    scope: &str,
    key: &str,
) -> Result<Vec<keyring::Entry>, String> {
    legacy_secret_locations(&app.config().identifier, scope, key)
        .into_iter()
        .map(|(service, account)| {
            keyring::Entry::new(&service, &account).map_err(secure_store_error)
        })
        .collect()
}

struct SecretLocation {
    service: String,
    account: String,
}

impl SecretLocation {
    fn slot(&self) -> impl Fn(&str) -> Result<keyring::Entry, String> + '_ {
        |account| keyring::Entry::new(&self.service, account).map_err(secure_store_error)
    }

    fn read(&self) -> Result<String, ChunkedError> {
        chunked::read(self.slot(), &self.account)
    }

    fn write(&self, value: &str) -> Result<(), String> {
        chunked::write(self.slot(), &self.account, value).map_err(chunked_error)
    }

    fn delete(&self) -> Result<(), String> {
        chunked::delete(self.slot(), &self.account).map_err(chunked_error)
    }
}

fn chunked_error(error: ChunkedError) -> String {
    match error {
        ChunkedError::Keyring(error) => secure_store_error(error),
        ChunkedError::Slot(error) => error,
        ChunkedError::Incomplete => {
            "secure-store secret is incomplete; save it again to repair it".to_string()
        }
    }
}

fn secret_location<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    scope: &str,
    key: &str,
) -> Result<SecretLocation, String> {
    if scope.trim().is_empty() || key.trim().is_empty() {
        return Err("secure-store scope and key must not be empty".to_string());
    }

    let identifier = &app.config().identifier;
    Ok(SecretLocation {
        service: secure_store_service(identifier),
        account: secure_store_account(identifier, scope, key),
    })
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn save<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    app.store2().save().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn repair_keychain_access() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(repair_macos_keychain_access)
            .await
            .map_err(|error| error.to_string())?;
    }

    #[cfg(not(target_os = "macos"))]
    Err("Keychain repair is only available on macOS.".to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_str<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    scope: String,
    key: String,
) -> Result<Option<String>, String> {
    let store = app
        .store2()
        .scoped_store::<String>(scope)
        .map_err(|e| e.to_string())?;

    store.get::<String>(key).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn set_str<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    scope: String,
    key: String,
    value: String,
) -> Result<(), String> {
    let store = app
        .store2()
        .scoped_store::<String>(scope)
        .map_err(|e| e.to_string())?;

    store.set(key, value).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_bool<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    scope: String,
    key: String,
) -> Result<Option<bool>, String> {
    let store = app
        .store2()
        .scoped_store::<String>(scope)
        .map_err(|e| e.to_string())?;

    store.get::<bool>(key).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn set_bool<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    scope: String,
    key: String,
    value: bool,
) -> Result<(), String> {
    let store = app
        .store2()
        .scoped_store::<String>(scope)
        .map_err(|e| e.to_string())?;

    store.set(key, value).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_number<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    scope: String,
    key: String,
) -> Result<Option<f64>, String> {
    let store = app
        .store2()
        .scoped_store::<String>(scope)
        .map_err(|e| e.to_string())?;

    store.get::<f64>(key).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn set_number<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    scope: String,
    key: String,
    value: f64,
) -> Result<(), String> {
    let store = app
        .store2()
        .scoped_store::<String>(scope)
        .map_err(|e| e.to_string())?;

    store.set(key, value).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_secret<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    scope: String,
    key: String,
) -> Result<Option<String>, String> {
    read_secret_for(SecretCaller::Renderer, app, scope, key).await
}

pub async fn read_secret<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    scope: String,
    key: String,
) -> Result<Option<String>, String> {
    read_secret_for(SecretCaller::Native, app, scope, key).await
}

pub fn read_secret_blocking<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    scope: &str,
    key: &str,
) -> Result<Option<String>, String> {
    read_secret_blocking_for(SecretCaller::Native, app, scope, key)
}

async fn read_secret_for<R: tauri::Runtime>(
    caller: SecretCaller,
    app: tauri::AppHandle<R>,
    scope: String,
    key: String,
) -> Result<Option<String>, String> {
    validate_secret_coordinate(caller, &scope, &key)?;
    tauri::async_runtime::spawn_blocking(move || {
        read_secret_blocking_for(caller, &app, &scope, &key)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Un build non signé par le certificat qui a créé les entrées se voit refuser
/// l'accès par le trousseau. Sans mémoire de ce refus, chaque secret relance
/// une invite : au démarrage, une par fournisseur configuré. On retient donc le
/// refus pour la durée du processus et on cesse de solliciter l'utilisateur.
static KEYCHAIN_ACCESS_DENIED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "macos")]
fn is_access_denied(error: &keyring::Error) -> bool {
    // errSecAuthFailed, errSecUserCanceled, errSecInteractionNotAllowed.
    matches!(keychain_error_code(error), Some(-25293 | -128 | -25308))
}

#[cfg(not(target_os = "macos"))]
fn is_access_denied(_error: &keyring::Error) -> bool {
    false
}

fn read_secret_blocking_for<R: tauri::Runtime>(
    caller: SecretCaller,
    app: &tauri::AppHandle<R>,
    scope: &str,
    key: &str,
) -> Result<Option<String>, String> {
    validate_secret_coordinate(caller, scope, key)?;
    let account = format!("{scope}:{key}");
    let migrated = with_vault(app, |vault| {
        read_through_vault(vault, &account, || {
            read_keychain_secret(app, scope, key, prompts_are_not_worth_it(scope))
        })
    });
    match migrated {
        Some(Ok(VaultRead::Migrated(secret))) => {
            tracing::info!(scope, "secure_store_secret_migrated_from_keychain");
            forget_keychain_secret(app, scope, key);
            Ok(Some(secret))
        }
        Some(Ok(VaultRead::Value(secret))) => Ok(secret),
        Some(Err(error)) => Err(error),
        None => read_keychain_secret(app, scope, key, false),
    }
}

/// The pre-vault behaviour: one keychain item per secret. `silent` reads only
/// what the keychain hands over without asking.
fn read_keychain_secret<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    scope: &str,
    key: &str,
    silent: bool,
) -> Result<Option<String>, String> {
    let _keychain = KEYCHAIN_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    if silent {
        // A silent refusal is expected here and must not switch the keychain
        // off for the rest of the session.
        return without_keychain_prompts(|| read_keychain_item(app, scope, key, false))
            .or(Ok(None));
    }
    read_keychain_item(app, scope, key, true)
}

fn read_keychain_item<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    scope: &str,
    key: &str,
    remember_refusal: bool,
) -> Result<Option<String>, String> {
    if KEYCHAIN_ACCESS_DENIED.load(std::sync::atomic::Ordering::Relaxed) {
        return Ok(None);
    }
    let location = secret_location(app, scope, key)?;
    match location.read() {
        Ok(secret) => Ok(Some(secret)),
        Err(ChunkedError::Keyring(keyring::Error::NoEntry)) => {
            for legacy_entry in legacy_secret_entries(app, scope, key)? {
                match legacy_entry.get_password() {
                    Ok(secret) => {
                        if location.write(&secret).is_ok() {
                            let _ = legacy_entry.delete_credential();
                        }
                        return Ok(Some(secret));
                    }
                    Err(keyring::Error::NoEntry | keyring::Error::PlatformFailure(_)) => {}
                    Err(error) => return Err(secure_store_error(error)),
                }
            }
            Ok(None)
        }
        Err(error) => {
            if let ChunkedError::Keyring(keyring_error) = &error
                && is_access_denied(keyring_error)
            {
                if remember_refusal {
                    tracing::warn!(
                        scope,
                        code = ?keychain_status(keyring_error),
                        "secure_store_keychain_refused_for_session"
                    );
                    KEYCHAIN_ACCESS_DENIED.store(true, std::sync::atomic::Ordering::Relaxed);
                }
                return Ok(None);
            }
            Err(chunked_error(error))
        }
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn set_secret<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    scope: String,
    key: String,
    value: String,
) -> Result<(), String> {
    write_secret_for(SecretCaller::Renderer, app, scope, key, value).await
}

pub async fn write_secret<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    scope: String,
    key: String,
    value: String,
) -> Result<(), String> {
    write_secret_for(SecretCaller::Native, app, scope, key, value).await
}

pub fn write_secret_blocking<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    scope: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    write_secret_blocking_for(SecretCaller::Native, app, scope, key, value)
}

async fn write_secret_for<R: tauri::Runtime>(
    caller: SecretCaller,
    app: tauri::AppHandle<R>,
    scope: String,
    key: String,
    value: String,
) -> Result<(), String> {
    validate_secret_coordinate(caller, &scope, &key)?;
    tauri::async_runtime::spawn_blocking(move || {
        write_secret_blocking_for(caller, &app, &scope, &key, &value)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn write_secret_blocking_for<R: tauri::Runtime>(
    caller: SecretCaller,
    app: &tauri::AppHandle<R>,
    scope: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    validate_secret_coordinate(caller, scope, key)?;
    let account = format!("{scope}:{key}");
    if let Some(result) = with_vault(app, |vault| vault.put(&account, value)) {
        result?;
        forget_keychain_secret(app, scope, key);
        return Ok(());
    }
    let _keychain = KEYCHAIN_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    secret_location(app, scope, key)?.write(value)?;
    for legacy_entry in legacy_secret_entries(app, scope, key)? {
        let _ = legacy_entry.delete_credential();
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn delete_secret<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    scope: String,
    key: String,
) -> Result<(), String> {
    delete_secret_for(SecretCaller::Renderer, app, scope, key).await
}

pub fn delete_secret_blocking<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    scope: &str,
    key: &str,
) -> Result<(), String> {
    delete_secret_blocking_for(SecretCaller::Native, app, scope, key)
}

async fn delete_secret_for<R: tauri::Runtime>(
    caller: SecretCaller,
    app: tauri::AppHandle<R>,
    scope: String,
    key: String,
) -> Result<(), String> {
    validate_secret_coordinate(caller, &scope, &key)?;
    tauri::async_runtime::spawn_blocking(move || {
        delete_secret_blocking_for(caller, &app, &scope, &key)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn delete_secret_blocking_for<R: tauri::Runtime>(
    caller: SecretCaller,
    app: &tauri::AppHandle<R>,
    scope: &str,
    key: &str,
) -> Result<(), String> {
    validate_secret_coordinate(caller, scope, key)?;
    let account = format!("{scope}:{key}");
    if let Some(result) = with_vault(app, |vault| vault.delete(&account)) {
        result?;
        forget_keychain_secret(app, scope, key);
        return Ok(());
    }
    let _keychain = KEYCHAIN_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    for legacy_entry in legacy_secret_entries(app, scope, key)? {
        match legacy_entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry | keyring::Error::PlatformFailure(_)) => {}
            Err(error) => return Err(secure_store_error(error)),
        }
    }
    secret_location(app, scope, key)?.delete()
}

// [fork] Vault plumbing, see `vault.rs`.
const VAULT_FILENAME: &str = "secure-store.vault.json";
const VAULT_SCOPE: &str = "vault";
const VAULT_KEY: &str = "master-key";
// Voiceprint candidates are numerous, short-lived and rebuilt from the next
// meetings: migrating them is not worth a prompt each, so they are read from
// the old keychain items only when that needs no confirmation.
const SILENT_MIGRATION_SCOPES: &[&str] = &["voiceprint_candidates"];

// Serialises keychain access, so prompts never overlap and the window where
// keychain interaction is switched off cannot swallow a legitimate prompt.
// Lock order: VAULT, then KEYCHAIN_LOCK.
static KEYCHAIN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static VAULT: std::sync::Mutex<VaultSlot> = std::sync::Mutex::new(VaultSlot::Unopened);

enum VaultSlot {
    Unopened,
    Ready(crate::vault::Vault),
    /// The master key was refused: keep to the per-item behaviour.
    Unavailable,
}

enum VaultRead {
    Value(Option<String>),
    /// Read from its old keychain item and now kept in the vault.
    Migrated(String),
}

fn prompts_are_not_worth_it(scope: &str) -> bool {
    SILENT_MIGRATION_SCOPES.contains(&scope)
}

fn read_through_vault(
    vault: &mut crate::vault::Vault,
    account: &str,
    read_keychain: impl FnOnce() -> Result<Option<String>, String>,
) -> Result<VaultRead, String> {
    match vault.get(account) {
        Ok(crate::vault::Lookup::Found(secret)) => return Ok(VaultRead::Value(Some(secret))),
        Ok(crate::vault::Lookup::Deleted) => return Ok(VaultRead::Value(None)),
        // An entry that no longer decrypts falls back to the keychain copy.
        Ok(crate::vault::Lookup::Unknown) | Err(_) => {}
    }
    // Nothing is recorded when the keychain has no copy: a refused keychain
    // also answers "none", and a tombstone would then hide a real secret.
    match read_keychain()? {
        Some(secret) => {
            vault.put(account, &secret)?;
            Ok(VaultRead::Migrated(secret))
        }
        None => Ok(VaultRead::Value(None)),
    }
}

fn with_vault<R: tauri::Runtime, T>(
    app: &tauri::AppHandle<R>,
    operation: impl FnOnce(&mut crate::vault::Vault) -> T,
) -> Option<T> {
    let mut slot = VAULT.lock().unwrap_or_else(PoisonError::into_inner);
    if matches!(*slot, VaultSlot::Unopened) {
        *slot = open_vault(app);
    }
    match &mut *slot {
        VaultSlot::Ready(vault) => Some(operation(vault)),
        VaultSlot::Unopened | VaultSlot::Unavailable => None,
    }
}

fn open_vault<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> VaultSlot {
    let _keychain = KEYCHAIN_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    if KEYCHAIN_ACCESS_DENIED.load(std::sync::atomic::Ordering::Relaxed) {
        tracing::info!("secure_store_vault_skipped_after_refusal");
        return VaultSlot::Unavailable;
    }
    let identifier = &app.config().identifier;
    let Ok(entry) = keyring::Entry::new(
        &secure_store_service(identifier),
        &secure_store_account(identifier, VAULT_SCOPE, VAULT_KEY),
    ) else {
        return VaultSlot::Unopened;
    };
    let Ok(dir) = crate::ext::resolve_store_dir(app) else {
        return VaultSlot::Unopened;
    };
    let vault_path = dir.join(VAULT_FILENAME);

    let mut lookup = read_master_key(&entry);
    let sealed_on_disk = crate::vault::sealed_entries_on_disk(&vault_path);
    if matches!(lookup, Err(keyring::Error::NoEntry)) && sealed_on_disk > 0 {
        // A key existed: these secrets were sealed with it. Generating a new
        // one sets them all aside, so make sure the miss was not transient.
        tracing::warn!(
            sealed_on_disk,
            "secure_store_master_key_missing_while_vault_holds_secrets"
        );
        std::thread::sleep(std::time::Duration::from_millis(500));
        lookup = read_master_key(&entry);
    }

    let key = match lookup {
        Ok(encoded) => match crate::vault::decode_key(&encoded) {
            Some(key) => key,
            // Never overwrite a master key we cannot read: the vault behind it
            // would become unreadable.
            None => {
                tracing::error!("secure_store_master_key_undecodable");
                return VaultSlot::Unavailable;
            }
        },
        Err(keyring::Error::NoEntry) => {
            let Ok(key) = crate::vault::generate_key() else {
                return VaultSlot::Unopened;
            };
            if let Err(error) = entry.set_password(&crate::vault::encode_key(&key)) {
                tracing::warn!(
                    %error,
                    code = ?keychain_status(&error),
                    "secure_store_master_key_create_failed"
                );
                return VaultSlot::Unopened;
            }
            tracing::info!(sealed_on_disk, "secure_store_master_key_created");
            key
        }
        Err(error) if is_access_denied(&error) => {
            KEYCHAIN_ACCESS_DENIED.store(true, std::sync::atomic::Ordering::Relaxed);
            return VaultSlot::Unavailable;
        }
        Err(_) => return VaultSlot::Unopened,
    };
    match crate::vault::Vault::open(vault_path, &key) {
        Ok(vault) => VaultSlot::Ready(vault),
        Err(error) => {
            tracing::warn!(%error, "secure_store_vault_open_failed");
            VaultSlot::Unopened
        }
    }
}

/// Reads the master key and logs how it went. A read that takes seconds is a
/// keychain prompt the user had to answer, which is what an update should no
/// longer cause once the build is signed with a stable identity.
fn read_master_key(entry: &keyring::Entry) -> Result<String, keyring::Error> {
    let started = std::time::Instant::now();
    let lookup = entry.get_password();
    let waited_ms = started.elapsed().as_millis() as u64;
    let likely_prompted = waited_ms >= 1_000;
    match &lookup {
        Ok(_) => tracing::info!(waited_ms, likely_prompted, "secure_store_master_key_read"),
        Err(keyring::Error::NoEntry) => {
            tracing::warn!(waited_ms, "secure_store_master_key_not_found")
        }
        Err(error) => tracing::warn!(
            %error,
            code = ?keychain_status(error),
            denied = is_access_denied(error),
            waited_ms,
            "secure_store_master_key_read_failed"
        ),
    }
    lookup
}

#[cfg(target_os = "macos")]
fn keychain_status(error: &keyring::Error) -> Option<i32> {
    keychain_error_code(error)
}

#[cfg(not(target_os = "macos"))]
fn keychain_status(_error: &keyring::Error) -> Option<i32> {
    None
}

/// Removes a secret's old keychain items once the vault holds it. Silent: an
/// item this build may not touch without asking simply stays behind, unread.
fn forget_keychain_secret<R: tauri::Runtime>(app: &tauri::AppHandle<R>, scope: &str, key: &str) {
    let _keychain = KEYCHAIN_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    without_keychain_prompts(|| {
        if let Ok(location) = secret_location(app, scope, key) {
            let _ = location.delete();
        }
        if let Ok(entries) = legacy_secret_entries(app, scope, key) {
            for entry in entries {
                let _ = entry.delete_credential();
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn without_keychain_prompts<T>(operation: impl FnOnce() -> T) -> T {
    struct RestorePrompts;
    impl Drop for RestorePrompts {
        fn drop(&mut self) {
            #[allow(deprecated)]
            let _ = unsafe { objc2_security::SecKeychain::set_user_interaction_allowed(true) };
        }
    }

    #[allow(deprecated)]
    let _ = unsafe { objc2_security::SecKeychain::set_user_interaction_allowed(false) };
    let _restore = RestorePrompts;
    operation()
}

#[cfg(not(target_os = "macos"))]
fn without_keychain_prompts<T>(operation: impl FnOnce() -> T) -> T {
    operation()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault() -> (tempfile::TempDir, crate::vault::Vault) {
        let dir = tempfile::tempdir().unwrap();
        let key = crate::vault::generate_key().unwrap();
        let vault = crate::vault::Vault::open(dir.path().join(VAULT_FILENAME), &key).unwrap();
        (dir, vault)
    }

    #[test]
    fn a_secret_is_read_from_the_keychain_once_then_from_the_vault() {
        let (_dir, mut vault) = temp_vault();
        let first = read_through_vault(&mut vault, "scope:key", || Ok(Some("legacy".into())));
        assert!(matches!(first, Ok(VaultRead::Migrated(secret)) if secret == "legacy"));

        let second = read_through_vault(&mut vault, "scope:key", || {
            panic!("the keychain must not be asked again")
        });
        assert!(matches!(second, Ok(VaultRead::Value(Some(secret))) if secret == "legacy"));
    }

    #[test]
    fn a_deleted_secret_is_not_revived_from_its_old_keychain_item() {
        let (_dir, mut vault) = temp_vault();
        vault.delete("scope:key").unwrap();

        let read = read_through_vault(&mut vault, "scope:key", || {
            panic!("a deleted secret must not hit the keychain")
        });
        assert!(matches!(read, Ok(VaultRead::Value(None))));
    }

    #[test]
    fn a_missing_keychain_copy_is_not_remembered_as_deleted() {
        let (_dir, mut vault) = temp_vault();
        let missing = read_through_vault(&mut vault, "scope:key", || Ok(None));
        assert!(matches!(missing, Ok(VaultRead::Value(None))));

        let later = read_through_vault(&mut vault, "scope:key", || Ok(Some("granted".into())));
        assert!(matches!(later, Ok(VaultRead::Migrated(secret)) if secret == "granted"));
    }

    #[test]
    fn renaming_the_bundle_keeps_pointing_at_the_same_secrets() {
        // A stored secret has to stay reachable after the fork renames its
        // bundle, so each new id must resolve to the same service AND account
        // as the id it replaces.
        for (previous, renamed) in [
            ("com.hyprnote.dev", "com.blackmushi.dev"),
            ("com.hyprnote.staging", "com.blackmushi.staging"),
            ("com.hyprnote.stable", "com.blackmushi.stable"),
        ] {
            assert_eq!(
                secure_store_service(previous),
                secure_store_service(renamed),
                "service drifted for {renamed}"
            );
            assert_eq!(
                secure_store_account(previous, "ai-provider-api-keys", "openai"),
                secure_store_account(renamed, "ai-provider-api-keys", "openai"),
                "account drifted for {renamed}"
            );
        }
    }

    #[test]
    fn uses_anarlog_service_names_for_legacy_bundle_identifiers() {
        assert_eq!(
            secure_store_service("com.hyprnote.dev"),
            "com.anarlog.dev.secure-store"
        );
        assert_eq!(
            secure_store_service("com.hyprnote.staging"),
            "com.anarlog.staging.secure-store"
        );
        assert_eq!(
            secure_store_service("com.hyprnote.stable"),
            "com.anarlog.stable.secure-store"
        );
        assert_eq!(
            secure_store_service("com.hyprnote.Hyprnote"),
            "com.anarlog.stable.secure-store"
        );
    }

    #[test]
    fn preserves_unknown_service_identifiers() {
        assert_eq!(
            secure_store_service("com.example.app"),
            "com.example.app.secure-store"
        );
    }

    #[test]
    fn versions_dev_accounts_across_signing_changes() {
        assert_eq!(
            secure_store_account("com.hyprnote.dev", "provider", "deepgram"),
            "v2:provider:deepgram"
        );
        assert_eq!(
            secure_store_account("com.hyprnote.stable", "provider", "deepgram"),
            "provider:deepgram"
        );
    }

    #[test]
    fn lists_legacy_secret_locations_without_duplicates() {
        for (identifier, expected) in [
            (
                "com.hyprnote.dev",
                vec![
                    (
                        "com.anarlog.dev.secure-store".to_string(),
                        "provider:deepgram".to_string(),
                    ),
                    (
                        "com.hyprnote.dev.secure-store".to_string(),
                        "provider:deepgram".to_string(),
                    ),
                ],
            ),
            ("com.example.app", vec![]),
        ] {
            let locations = legacy_secret_locations(identifier, "provider", "deepgram");
            assert_eq!(
                locations, expected,
                "unexpected legacy locations for {identifier}"
            );
            let unique: std::collections::HashSet<_> = locations.iter().collect();
            assert_eq!(
                locations.len(),
                unique.len(),
                "duplicate locations for {identifier}"
            );
        }
    }

    #[test]
    fn isolates_native_secret_accounts_from_renderer_commands() {
        assert!(validate_secret_coordinate(SecretCaller::Renderer, "provider", "deepgram").is_ok());
        assert!(
            validate_secret_coordinate(
                SecretCaller::Renderer,
                "e2ee",
                "account:user-a:recovery-v1"
            )
            .is_err()
        );
        assert!(
            validate_secret_coordinate(
                SecretCaller::Renderer,
                "e2ee:account",
                "user-a:recovery-v1"
            )
            .is_err()
        );
        assert!(
            validate_secret_coordinate(SecretCaller::Native, "e2ee", "account:user-a:recovery-v1")
                .is_ok()
        );
    }

    #[tokio::test]
    async fn renderer_secret_commands_reject_native_accounts_before_keychain_access() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let app = app.handle().clone();
        let scope = "e2ee".to_string();
        let key = "account:user-a:recovery-v1".to_string();
        let expected = "secure-store account is reserved for native use";

        assert_eq!(
            get_secret(app.clone(), scope.clone(), key.clone())
                .await
                .unwrap_err(),
            expected
        );
        assert_eq!(
            set_secret(
                app.clone(),
                scope.clone(),
                key.clone(),
                "replacement".to_string()
            )
            .await
            .unwrap_err(),
            expected
        );
        assert_eq!(delete_secret(app, scope, key).await.unwrap_err(), expected);
    }
}
