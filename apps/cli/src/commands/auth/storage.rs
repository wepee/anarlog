use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anlg_supabase_auth::session::Session;

use crate::{Error, Result};

#[derive(Clone, Copy)]
pub(super) enum Backend {
    File,
}

impl Backend {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
        }
    }
}

pub(super) struct LoadedAuth {
    pub(super) data: HashMap<String, String>,
    pub(super) backend: Backend,
}

pub(super) struct AuthStore {
    path: PathBuf,
}

fn previous_auth_path(bundle_id: &str) -> Option<PathBuf> {
    let previous = previous_bundle_id(bundle_id)?;
    let candidate = dirs::data_local_dir()?.join(previous).join("auth.json");
    candidate.is_file().then_some(candidate)
}

fn previous_bundle_id(bundle_id: &str) -> Option<&'static str> {
    match bundle_id {
        "com.blackmushi.dev" => Some("com.hyprnote.dev"),
        "com.blackmushi.staging" => Some("com.hyprnote.staging"),
        "com.blackmushi.nightly" => Some("com.hyprnote.nightly"),
        "com.blackmushi.stable" => Some("com.hyprnote.stable"),
        _ => None,
    }
}

impl AuthStore {
    pub(super) fn new(bundle_id: &str) -> Result<Self> {
        let override_path = std::env::var_os("ANARLOG_AUTH_PATH").map(PathBuf::from);
        if override_path
            .as_ref()
            .is_some_and(|path| !path.is_absolute())
        {
            return Err(Error::operation(
                "resolve auth storage",
                "ANARLOG_AUTH_PATH must be an absolute path",
            ));
        }
        let path = match override_path.as_ref() {
            Some(path) => path.clone(),
            None => dirs::data_local_dir()
                .ok_or_else(|| {
                    Error::operation(
                        "resolve auth storage",
                        "local data directory is unavailable",
                    )
                })?
                .join(bundle_id)
                .join("auth.json"),
        };
        // A session signed in before the fork renamed its bundle still lives in
        // the old directory; keep reading it until this one has been written.
        let path = if override_path.is_some() || path.is_file() {
            path
        } else {
            previous_auth_path(bundle_id).unwrap_or(path)
        };
        Ok(Self { path })
    }

    #[cfg(test)]
    fn at(path: PathBuf) -> Self {
        Self { path }
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn load(&self) -> Result<LoadedAuth> {
        Ok(LoadedAuth {
            data: self.read_file()?.unwrap_or_default(),
            backend: Backend::File,
        })
    }

    pub(super) fn save(&self, data: &HashMap<String, String>) -> Result<Backend> {
        self.write_file(data)?;
        Ok(Backend::File)
    }

    pub(super) fn remove_sessions(&self) -> Result<()> {
        if let Some(mut data) = self.read_file()? {
            data.retain(|key, _| !key.ends_with("-auth-token"));
            if data.is_empty() {
                self.remove_file()?;
            } else {
                self.write_file(&data)?;
            }
        }
        Ok(())
    }

    fn read_file(&self) -> Result<Option<HashMap<String, String>>> {
        let content = match std::fs::read_to_string(&self.path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(Error::operation("read auth storage", error.to_string())),
        };
        serde_json::from_str(&content)
            .map(Some)
            .map_err(|error| Error::operation("read auth storage", error.to_string()))
    }

    fn write_file(&self, data: &HashMap<String, String>) -> Result<()> {
        let content = serde_json::to_string(data)
            .map_err(|error| Error::operation("serialize auth storage", error.to_string()))?;
        anlg_storage::fs::atomic_write(&self.path, &content)
            .map_err(|error| Error::operation("write auth storage", error.to_string()))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))
                .map_err(|error| Error::operation("protect auth storage", error.to_string()))?;
        }
        Ok(())
    }

    fn remove_file(&self) -> Result<()> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(Error::operation("clear auth storage", error.to_string())),
        }
    }
}

pub(super) fn find_session(data: &HashMap<String, String>) -> Result<Option<Session>> {
    data.iter()
        .filter(|(key, _)| key.ends_with("-auth-token"))
        .map(|(_, value)| {
            serde_json::from_str::<Session>(value)
                .map_err(|error| Error::operation("read login", error.to_string()))
        })
        .collect::<Result<Vec<_>>>()
        .map(|sessions| {
            sessions
                .into_iter()
                .max_by_key(|session| session.expires_at.unwrap_or(0))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn session_json(id: &str, expires_at: u64) -> String {
        serde_json::json!({
            "access_token": "access",
            "refresh_token": "refresh",
            "token_type": "bearer",
            "expires_at": expires_at,
            "user": { "id": id, "email": format!("{id}@example.com") }
        })
        .to_string()
    }

    #[test]
    fn file_store_round_trips_desktop_auth_shape() {
        let dir = tempdir().unwrap();
        let store = AuthStore::at(dir.path().join("com.hyprnote.stable/auth.json"));
        let data = HashMap::from([(
            "sb-project-auth-token".to_string(),
            session_json("user-1", 100),
        )]);

        assert!(matches!(store.save(&data).unwrap(), Backend::File));
        let loaded = store.load().unwrap();
        assert_eq!(loaded.data, data);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(store.path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn logout_removes_only_auth_sessions() {
        let dir = tempdir().unwrap();
        let store = AuthStore::at(dir.path().join("auth.json"));
        let data = HashMap::from([
            (
                "sb-project-auth-token".to_string(),
                session_json("user-1", 100),
            ),
            ("unrelated".to_string(), "value".to_string()),
        ]);
        store.save(&data).unwrap();

        store.remove_sessions().unwrap();

        assert_eq!(
            store.load().unwrap().data,
            HashMap::from([("unrelated".to_string(), "value".to_string())])
        );
    }

    #[test]
    fn finds_the_newest_desktop_session() {
        let data = HashMap::from([
            ("sb-old-auth-token".to_string(), session_json("old", 100)),
            ("sb-new-auth-token".to_string(), session_json("new", 200)),
        ]);

        let session = find_session(&data).unwrap().unwrap();

        assert_eq!(session.user.unwrap().id, "new");
    }
}
