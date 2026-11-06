use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use sqlx::SqlitePool;
use tauri::Manager;
use tauri_plugin_fs_sync::FsSyncPluginExt;
use tauri_specta::Event;

use crate::{BatchSessionRegistry, ListenerPluginExt};

const SWEEP_INTERVAL: Duration = Duration::from_secs(60);
const VOICEPRINT_CLEANUP_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const ARCHIVE_INTERVAL: Duration = Duration::from_secs(2 * 60);
const ARCHIVE_EVICT_INTERVAL: Duration = Duration::from_secs(2 * 60);
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

const AUDIO_RETENTION_SETTING_ID: &str = "audio_retention";
const SAVE_RECORDINGS_SETTING_ID: &str = "save_recordings";
const LEGACY_SETTINGS_ID: &str = "legacy_settings_document";
const LEGACY_MAIN_VALUES_ID: &str = "legacy_main_values_document";
const AUDIO_ARCHIVE_DIRECTORY_SETTING_ID: &str = "audio_archive_directory";
const AUDIO_ARCHIVE_AFTER_SETTING_ID: &str = "audio_archive_after";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioRetentionPolicy {
    None,
    OneDay,
    ThreeDays,
    OneWeek,
    OneMonth,
    Forever,
}

impl AudioRetentionPolicy {
    fn from_value(value: &Value) -> Option<Self> {
        match value {
            Value::Bool(false) => Some(Self::None),
            Value::Bool(true) => Some(Self::Forever),
            Value::String(value) => match value.as_str() {
                "none" => Some(Self::None),
                "oneDay" => Some(Self::OneDay),
                "threeDays" => Some(Self::ThreeDays),
                "oneWeek" => Some(Self::OneWeek),
                "oneMonth" => Some(Self::OneMonth),
                "forever" => Some(Self::Forever),
                _ => None,
            },
            _ => None,
        }
    }

    fn duration_ms(self) -> Option<i64> {
        match self {
            Self::None => Some(0),
            Self::OneDay => Some(DAY_MS),
            Self::ThreeDays => Some(3 * DAY_MS),
            Self::OneWeek => Some(7 * DAY_MS),
            Self::OneMonth => Some(30 * DAY_MS),
            Self::Forever => None,
        }
    }
}

#[derive(Debug, Default)]
struct StoredRetentionSettings {
    audio_retention: Option<String>,
    save_recordings: Option<String>,
    legacy_settings: Option<String>,
    legacy_main_values: Option<String>,
}

/// Mirrors the desktop settings resolution: direct row, then legacy documents,
/// then `save_recordings = false`, then the `forever` default.
fn resolve_policy(stored: &StoredRetentionSettings) -> AudioRetentionPolicy {
    let parse = |json: &Option<String>| {
        json.as_deref()
            .and_then(|json| serde_json::from_str::<Value>(json).ok())
    };

    if let Some(policy) = parse(&stored.audio_retention)
        .as_ref()
        .and_then(AudioRetentionPolicy::from_value)
    {
        return policy;
    }

    let legacy_settings = parse(&stored.legacy_settings).unwrap_or(Value::Null);
    let legacy_main_values = parse(&stored.legacy_main_values).unwrap_or(Value::Null);
    let legacy = [
        legacy_settings.pointer("/general/audio_retention"),
        legacy_settings.pointer("/general/saveAudioAfterMeeting"),
        legacy_settings.pointer("/general/save_recordings"),
        legacy_main_values.get("audio_retention"),
        legacy_main_values.get("save_recordings"),
    ];
    if let Some(policy) = legacy
        .into_iter()
        .flatten()
        .find_map(AudioRetentionPolicy::from_value)
    {
        return policy;
    }

    if parse(&stored.save_recordings) == Some(Value::Bool(false)) {
        return AudioRetentionPolicy::None;
    }
    AudioRetentionPolicy::Forever
}

async fn load_policy(pool: &SqlitePool) -> Result<AudioRetentionPolicy, sqlx::Error> {
    let get = |id| anlg_db_app::get_app_setting_json(pool, id);
    Ok(resolve_policy(&StoredRetentionSettings {
        audio_retention: get(AUDIO_RETENTION_SETTING_ID).await?,
        save_recordings: get(SAVE_RECORDINGS_SETTING_ID).await?,
        legacy_settings: get(LEGACY_SETTINGS_ID).await?,
        legacy_main_values: get(LEGACY_MAIN_VALUES_ID).await?,
    }))
}

fn is_expired(created_at_ms: Option<i64>, policy: AudioRetentionPolicy, now_ms: i64) -> bool {
    match (policy, policy.duration_ms(), created_at_ms) {
        (AudioRetentionPolicy::None, _, _) => true,
        (_, Some(duration), Some(created_at)) => now_ms >= created_at.saturating_add(duration),
        _ => false,
    }
}

fn retention_expired(
    candidate: &anlg_db_app::SessionAudioRetentionCandidate,
    policy: AudioRetentionPolicy,
    now_ms: i64,
) -> bool {
    if policy == AudioRetentionPolicy::None && !candidate.has_words {
        return false;
    }
    is_expired(candidate.created_at_ms, policy, now_ms)
}

async fn session_audio_is_expired(pool: &SqlitePool, session_id: &str) -> Result<bool, String> {
    let policy = load_policy(pool).await.map_err(|e| e.to_string())?;
    let candidate = anlg_db_app::get_session_audio_retention_candidate(pool, session_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(candidate.is_some_and(|candidate| {
        retention_expired(&candidate, policy, chrono::Utc::now().timestamp_millis())
    }))
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SessionAudioRetentionPhase {
    Deleting,
    Deleted,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, specta::Type, tauri_specta::Event)]
pub struct SessionAudioRetentionEvent {
    pub session_id: String,
    pub phase: SessionAudioRetentionPhase,
}

fn db_pool<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<SqlitePool> {
    app.try_state::<tauri_plugin_db::ManagedState>()
        .map(|state| state.pool().clone())
}

fn batch_session_belongs_to(batch_session_id: &str, session_id: &str) -> bool {
    batch_session_id
        .strip_prefix(session_id)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(':'))
}

/// Conservative: any uncertainty about capture or batch state keeps the audio.
async fn session_audio_is_idle<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    session_id: &str,
) -> bool {
    let Ok(snapshot) = app.listener().get_capture_snapshot().await else {
        return false;
    };
    if snapshot.active_session_id.as_deref() == Some(session_id)
        || snapshot
            .finalizing_session_ids
            .iter()
            .any(|id| id == session_id)
    {
        return false;
    }

    let registry = app.state::<Arc<BatchSessionRegistry>>();
    registry.sessions.lock().is_ok_and(|sessions| {
        !sessions
            .keys()
            .any(|id| batch_session_belongs_to(id, session_id))
    })
}

#[derive(Clone, Copy)]
enum Eligibility {
    Expired,
    Processed,
    LogicallyDeleted,
}

async fn delete_local_audio<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    pool: &SqlitePool,
    session_id: &str,
    eligibility: Eligibility,
) -> Result<bool, String> {
    let _guard = app.fs_sync().lock_session_audio(session_id).await;
    if !session_audio_is_idle(app, session_id).await {
        return Ok(false);
    }
    let eligible = match eligibility {
        Eligibility::Expired => session_audio_is_expired(pool, session_id).await?,
        Eligibility::Processed => anlg_db_app::session_audio_is_processed(pool, session_id)
            .await
            .map_err(|e| e.to_string())?,
        Eligibility::LogicallyDeleted => {
            anlg_db_app::session_audio_is_logically_deleted(pool, session_id)
                .await
                .map_err(|e| e.to_string())?
        }
    };
    if !eligible {
        return Ok(false);
    }

    let emit = |phase| {
        let _ = SessionAudioRetentionEvent {
            session_id: session_id.to_string(),
            phase,
        }
        .emit(app);
    };
    emit(SessionAudioRetentionPhase::Deleting);
    let deleted = app.fs_sync().delete_session_audio_locked(session_id)?;
    anlg_db_app::mark_session_audio_absent(pool, session_id)
        .await
        .map_err(|e| e.to_string())?;
    if deleted {
        emit(SessionAudioRetentionPhase::Deleted);
    }
    Ok(deleted)
}

async fn sweep<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    pool: &SqlitePool,
) -> Result<(), String> {
    let logically_deleted = anlg_db_app::list_logically_deleted_session_audio(pool)
        .await
        .map_err(|e| e.to_string())?;
    for session_id in logically_deleted {
        if let Err(error) =
            delete_local_audio(app, pool, &session_id, Eligibility::LogicallyDeleted).await
        {
            tracing::warn!(%session_id, %error, "deleted_session_audio_cleanup_failed");
        }
    }

    let policy = load_policy(pool).await.map_err(|e| e.to_string())?;
    if policy == AudioRetentionPolicy::Forever {
        return Ok(());
    }

    let now_ms = chrono::Utc::now().timestamp_millis();
    let candidates = anlg_db_app::list_session_audio_retention_candidates(pool)
        .await
        .map_err(|e| e.to_string())?;
    for candidate in candidates {
        if !retention_expired(&candidate, policy, now_ms) {
            continue;
        }
        let session_id = candidate.session_id;
        if let Err(error) = delete_local_audio(app, pool, &session_id, Eligibility::Expired).await {
            tracing::warn!(%session_id, %error, "expired_session_audio_cleanup_failed");
        }
    }
    Ok(())
}

// [fork] Archiving: recordings older than the chosen delay move to a folder of
// the user's choice (typically iCloud Drive) instead of being deleted, and the
// session keeps a link to them. The retention policy still applies on top.
struct ArchiveSettings {
    directory: std::path::PathBuf,
    after_ms: i64,
    /// "Right after the meeting": wait for the transcript rather than a delay.
    needs_transcript: bool,
}

fn parse_archive_settings(directory: Option<&str>, after: Option<&str>) -> Option<ArchiveSettings> {
    let parse_str = |json: Option<&str>| {
        json.and_then(|json| serde_json::from_str::<Value>(json).ok())
            .and_then(|value| value.as_str().map(str::to_string))
    };
    let directory = parse_str(directory)?;
    let directory = directory.trim();
    if directory.is_empty() {
        return None;
    }
    let after = match parse_str(after).as_deref() {
        Some("immediately") => {
            return Some(ArchiveSettings {
                directory: std::path::PathBuf::from(directory),
                after_ms: 0,
                needs_transcript: true,
            });
        }
        Some("oneDay") => AudioRetentionPolicy::OneDay,
        Some("threeDays") => AudioRetentionPolicy::ThreeDays,
        Some("oneMonth") => AudioRetentionPolicy::OneMonth,
        _ => AudioRetentionPolicy::OneWeek,
    };
    Some(ArchiveSettings {
        directory: std::path::PathBuf::from(directory),
        after_ms: after.duration_ms()?,
        needs_transcript: false,
    })
}

async fn load_archive_settings(pool: &SqlitePool) -> Result<Option<ArchiveSettings>, sqlx::Error> {
    let directory =
        anlg_db_app::get_app_setting_json(pool, AUDIO_ARCHIVE_DIRECTORY_SETTING_ID).await?;
    let after = anlg_db_app::get_app_setting_json(pool, AUDIO_ARCHIVE_AFTER_SETTING_ID).await?;
    Ok(parse_archive_settings(
        directory.as_deref(),
        after.as_deref(),
    ))
}

async fn archive_sweep<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    pool: &SqlitePool,
    evict: bool,
) -> Result<(), String> {
    let Some(settings) = load_archive_settings(pool)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(());
    };
    // An unplugged drive or a folder that is gone must never turn into a
    // freshly created local directory that silently keeps the audio here.
    if !settings.directory.is_dir() {
        return Ok(());
    }

    let now_ms = chrono::Utc::now().timestamp_millis();
    let candidates = anlg_db_app::list_session_audio_retention_candidates(pool)
        .await
        .map_err(|e| e.to_string())?;
    for candidate in candidates {
        let old_enough = candidate
            .created_at_ms
            .is_some_and(|created_at| now_ms >= created_at.saturating_add(settings.after_ms));
        if !old_enough || (settings.needs_transcript && !candidate.has_words) {
            continue;
        }
        let session_id = candidate.session_id;
        let _guard = app.fs_sync().lock_session_audio(&session_id).await;
        if !session_audio_is_idle(app, &session_id).await {
            continue;
        }
        match app
            .fs_sync()
            .archive_session_audio_locked(&session_id, &settings.directory)
        {
            Ok(tauri_plugin_fs_sync::audio::ArchiveOutcome::Archived(target)) => {
                tracing::info!(%session_id, target = %target.display(), "session_audio_archived");
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(%session_id, %error, "session_audio_archive_failed");
            }
        }
    }

    if evict {
        evict_uploaded_archives(&settings.directory);
    }
    Ok(())
}

// Time for iCloud to upload a fresh copy; `brctl` refuses earlier evictions.
const UPLOAD_GRACE: Duration = Duration::from_secs(10 * 60);
// A recording the user just played stays local while they listen.
const RECENTLY_PLAYED: Duration = Duration::from_secs(30 * 60);

/// Copying into iCloud Drive frees nothing while macOS keeps the local copy,
/// and it only evicts under disk pressure. Ask it to drop archives that have
/// had time to upload; `brctl` refuses files that are not uploaded yet, and
/// those are simply retried on the next pass.
#[cfg(target_os = "macos")]
fn evict_uploaded_archives(directory: &std::path::Path) {
    const BRCTL: &str = "/usr/bin/brctl";

    let in_icloud = directory
        .to_string_lossy()
        .contains("/Library/Mobile Documents/");
    if !in_icloud || !std::path::Path::new(BRCTL).exists() {
        return;
    }
    for path in
        tauri_plugin_fs_sync::audio::archives_to_offload(directory, UPLOAD_GRACE, RECENTLY_PLAYED)
    {
        let _ = std::process::Command::new(BRCTL)
            .arg("evict")
            .arg(&path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

#[cfg(not(target_os = "macos"))]
fn evict_uploaded_archives(directory: &std::path::Path) {
    // Only iCloud needs an explicit eviction; keep the selection compiled
    // and exercised on every platform.
    let _ =
        tauri_plugin_fs_sync::audio::archives_to_offload(directory, UPLOAD_GRACE, RECENTLY_PLAYED);
}

pub(crate) fn spawn<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_voiceprint_cleanup: Option<Instant> = None;
        let mut last_archive: Option<Instant> = None;
        let mut last_evict: Option<Instant> = None;
        loop {
            interval.tick().await;
            let Some(pool) = db_pool(&app) else {
                continue;
            };
            if let Err(error) = sweep(&app, &pool).await {
                tracing::warn!(%error, "audio_retention_sweep_failed");
            }
            if last_archive.is_none_or(|at| at.elapsed() >= ARCHIVE_INTERVAL) {
                last_archive = Some(Instant::now());
                let evict = last_evict.is_none_or(|at| at.elapsed() >= ARCHIVE_EVICT_INTERVAL);
                if evict {
                    last_evict = Some(Instant::now());
                }
                if let Err(error) = archive_sweep(&app, &pool, evict).await {
                    tracing::warn!(%error, "audio_archive_sweep_failed");
                }
            }
            if last_voiceprint_cleanup.is_none_or(|at| at.elapsed() >= VOICEPRINT_CLEANUP_INTERVAL)
            {
                last_voiceprint_cleanup = Some(Instant::now());
                if let Err(error) =
                    crate::voiceprint::cleanup_expired_voiceprint_candidates(&app, &pool).await
                {
                    tracing::warn!(%error, "voiceprint_candidate_cleanup_failed");
                }
            }
        }
    });
}

/// Deletes local audio right after processing when the retention policy is `none`.
#[tauri::command]
#[specta::specta]
pub async fn delete_processed_session_audio<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    session_id: String,
) -> Result<bool, String> {
    let pool = db_pool(&app).ok_or_else(|| "database is not ready yet".to_string())?;
    if load_policy(&pool).await.map_err(|e| e.to_string())? != AudioRetentionPolicy::None {
        return Ok(false);
    }
    delete_local_audio(&app, &pool, &session_id, Eligibility::Processed).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(
        audio_retention: Option<&str>,
        save_recordings: Option<&str>,
        legacy_settings: Option<&str>,
        legacy_main_values: Option<&str>,
    ) -> StoredRetentionSettings {
        StoredRetentionSettings {
            audio_retention: audio_retention.map(str::to_string),
            save_recordings: save_recordings.map(str::to_string),
            legacy_settings: legacy_settings.map(str::to_string),
            legacy_main_values: legacy_main_values.map(str::to_string),
        }
    }

    #[test]
    fn retention_policy_never_deletes_audio_the_user_chose_to_keep() {
        use AudioRetentionPolicy as P;
        let cases = [
            (stored(None, None, None, None), P::Forever),
            (stored(Some(r#""unknown""#), None, None, None), P::Forever),
            (stored(Some("not json"), Some("false"), None, None), P::None),
            (
                stored(Some(r#""oneWeek""#), Some("false"), None, None),
                P::OneWeek,
            ),
            (stored(Some("true"), Some("false"), None, None), P::Forever),
            (stored(Some("false"), None, None, None), P::None),
            (
                stored(
                    None,
                    Some("false"),
                    Some(r#"{"general":{"saveAudioAfterMeeting":"threeDays"}}"#),
                    None,
                ),
                P::ThreeDays,
            ),
            (
                stored(None, None, None, Some(r#"{"save_recordings":false}"#)),
                P::None,
            ),
        ];
        for (settings, expected) in cases {
            assert_eq!(resolve_policy(&settings), expected, "{settings:?}");
        }
    }

    #[test]
    fn retention_window_starts_at_session_creation() {
        let created = Some(1_000);
        assert!(!is_expired(
            created,
            AudioRetentionPolicy::OneDay,
            1_000 + DAY_MS - 1
        ));
        assert!(is_expired(
            created,
            AudioRetentionPolicy::OneDay,
            1_000 + DAY_MS
        ));
        assert!(!is_expired(None, AudioRetentionPolicy::OneMonth, i64::MAX));
        assert!(!is_expired(
            created,
            AudioRetentionPolicy::Forever,
            i64::MAX
        ));
        assert!(is_expired(None, AudioRetentionPolicy::None, 0));
    }

    #[test]
    fn batch_sessions_match_their_capture_session_only() {
        assert!(batch_session_belongs_to("s1", "s1"));
        assert!(batch_session_belongs_to("s1:recovery", "s1"));
        assert!(!batch_session_belongs_to("s10", "s1"));
    }

    #[test]
    fn archiving_needs_a_folder_and_defaults_to_one_week() {
        assert!(parse_archive_settings(None, Some(r#""oneDay""#)).is_none());
        assert!(parse_archive_settings(Some(r#""  ""#), Some(r#""oneDay""#)).is_none());

        let settings = parse_archive_settings(Some(r#""/Users/me/iCloud""#), None).unwrap();
        assert_eq!(
            settings.directory,
            std::path::PathBuf::from("/Users/me/iCloud")
        );
        assert_eq!(settings.after_ms, 7 * DAY_MS);
        assert!(!settings.needs_transcript);

        let settings =
            parse_archive_settings(Some(r#""/Users/me/iCloud""#), Some(r#""immediately""#))
                .unwrap();
        assert_eq!(settings.after_ms, 0);
        assert!(settings.needs_transcript);

        let settings =
            parse_archive_settings(Some(r#""/Users/me/iCloud""#), Some(r#""oneMonth""#)).unwrap();
        assert_eq!(settings.after_ms, 30 * DAY_MS);
    }
}
