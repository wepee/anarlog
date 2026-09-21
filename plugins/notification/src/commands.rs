use crate::NotificationPluginExt;
use tauri::Manager;
use tauri_plugin_analytics::{AnalyticsPayload, AnalyticsPluginExt};

#[tauri::command]
#[specta::specta]
pub(crate) async fn show_notification<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    v: anlg_notification::Notification,
) -> Result<(), String> {
    let source = match &v.source {
        Some(anlg_notification::NotificationSource::CalendarEvent { .. }) => "calendar_event",
        Some(anlg_notification::NotificationSource::Session { .. }) => "session",
        Some(anlg_notification::NotificationSource::MicDetected { .. }) => "mic_detected",
        None => "unknown",
    };
    let is_persistent = v.is_persistent();
    let has_options = v
        .options
        .as_ref()
        .is_some_and(|options| !options.is_empty());
    app.notification().show(v).map_err(|e| e.to_string())?;
    app.analytics().event_fire_and_forget(
        AnalyticsPayload::builder("notification_shown")
            .with("source_type", source)
            .with("is_persistent", is_persistent)
            .with("has_options", has_options)
            .build(),
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn clear_notifications<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    app.notification().clear().map_err(|e| e.to_string())
}

/// Resolves the favicon for a meeting page's domain to a locally cached file
/// path, so it can be used as a notification icon (which only accepts local
/// paths, not remote URLs). Fetches once per domain; later calls just return
/// the cached file.
#[tauri::command]
#[specta::specta]
pub(crate) async fn resolve_favicon_path<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    domain: String,
) -> Result<String, String> {
    let domain = domain.trim().to_ascii_lowercase();
    let is_valid_domain = !domain.is_empty()
        && domain
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    if !is_valid_domain {
        return Err(format!("invalid domain: {domain}"));
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("favicons");
    std::fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let file_path = cache_dir.join(format!("{domain}.png"));

    if file_path.exists() {
        return Ok(file_path.to_string_lossy().into_owned());
    }

    let url = format!("https://www.google.com/s2/favicons?domain={domain}&sz=64");
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|error| error.to_string())?
        .get(&url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("favicon request failed: {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    std::fs::write(&file_path, &bytes).map_err(|error| error.to_string())?;

    Ok(file_path.to_string_lossy().into_owned())
}
