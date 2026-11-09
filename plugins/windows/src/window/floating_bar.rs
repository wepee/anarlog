use serde::{Deserialize, Serialize};

use crate::Error;
use crate::window::live_caption::LiveCaptionPosition;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FloatingBarStatus {
    Recording,
    Reconnecting,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FloatingBarOverlayLayout {
    pub controls_center_x: f64,
    pub expands_upward: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FloatingBarColorScheme {
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FloatingTranscriptBubble {
    pub id: String,
    pub speaker_label: String,
    pub text: String,
    pub is_self: bool,
    pub is_final: bool,
    pub start_ms: f64,
    pub end_ms: f64,
    pub overlaps_previous: bool,
    pub overlaps_next: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FloatingDictationState {
    pub session_id: String,
    pub phase: String,
    pub microphone: String,
    pub text: String,
    pub partial: String,
    pub preview_enabled: bool,
    pub preview_unavailable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FloatingBarState {
    #[serde(default)]
    pub dictation: Option<FloatingDictationState>,
    pub amplitude: f64,
    pub title: String,
    pub status: FloatingBarStatus,
    pub color_scheme: FloatingBarColorScheme,
    pub opacity: f64,
    pub live_caption_opacity: f64,
    pub live_caption_width: f64,
    pub live_caption_line_count: u32,
    pub live_caption_position: LiveCaptionPosition,
    pub live_caption_minimized: bool,
    pub live_caption_toggle_visible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_bubbles: Option<Vec<FloatingTranscriptBubble>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_notice: Option<String>,
    #[serde(default)]
    pub layout: Option<FloatingBarOverlayLayout>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Live Assist panel content, serialized by the main window. Kept as an
    /// opaque JSON string so the native panel and the webview overlay can
    /// evolve it without a Rust type for every field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assist_json: Option<String>,
}

pub const WINDOW_LABEL: &str = "floating-bar";

#[cfg(test)]
pub(crate) mod layout {
    use super::FloatingBarState;

    pub const INSET: f64 = 4.0;
    pub const SCREEN_MARGIN: f64 = 8.0;
    pub const COMPACT_HEIGHT: f64 = 38.0;
    pub const COMPACT_STOP_WIDTH: f64 = 62.0;
    pub const COMPACT_SOLO_STOP_WIDTH: f64 = 68.0;
    pub const COMPACT_ICON_SIZE: f64 = 30.0;
    pub const COMPACT_GAP: f64 = 0.0;
    pub const COMPACT_HORIZONTAL_PADDING: f64 = 4.0;
    pub const EXPANDED_WIDTH: f64 = 360.0;
    pub const EXPANDED_HEIGHT: f64 = 430.0;
    pub const ASSIST_EXPANDED_WIDTH: f64 = 384.0;
    pub const ASSIST_EXPANDED_HEIGHT: f64 = 548.0;
    pub const HOVER_HANDLE_TOP_PADDING: f64 = 7.0;
    pub const HOVER_HANDLE_HEIGHT: f64 = 12.0;
    pub const HOVER_HANDLE_GAP: f64 = 2.0;
    pub const HOVER_HANDLE_RESERVED_HEIGHT: f64 =
        HOVER_HANDLE_TOP_PADDING + HOVER_HANDLE_HEIGHT + HOVER_HANDLE_GAP;

    pub fn is_expanded(state: &FloatingBarState) -> bool {
        state.live_caption_toggle_visible && !state.live_caption_minimized
    }

    pub fn compact_controls_width(shows_expand: bool) -> f64 {
        if shows_expand {
            COMPACT_STOP_WIDTH + COMPACT_GAP + COMPACT_ICON_SIZE
        } else {
            COMPACT_SOLO_STOP_WIDTH
        }
    }

    pub fn compact_width(shows_expand: bool) -> f64 {
        compact_controls_width(shows_expand) + COMPACT_HORIZONTAL_PADDING * 2.0
    }

    pub fn dictation_container_size(expanded: bool) -> (f64, f64) {
        container_size(expanded, true)
    }

    pub fn meeting_container_size(state: &FloatingBarState) -> (f64, f64) {
        let shows_expand = state.live_caption_toggle_visible;
        if is_expanded(state) && state.assist_json.is_some() {
            (
                ASSIST_EXPANDED_WIDTH + INSET * 2.0,
                ASSIST_EXPANDED_HEIGHT + HOVER_HANDLE_RESERVED_HEIGHT + INSET * 2.0,
            )
        } else {
            container_size(is_expanded(state), shows_expand)
        }
    }

    pub fn container_size(is_expanded: bool, shows_expand: bool) -> (f64, f64) {
        if is_expanded {
            (
                EXPANDED_WIDTH + INSET * 2.0,
                EXPANDED_HEIGHT + HOVER_HANDLE_RESERVED_HEIGHT + INSET * 2.0,
            )
        } else {
            (
                compact_width(shows_expand) + INSET * 2.0,
                COMPACT_HEIGHT + HOVER_HANDLE_RESERVED_HEIGHT + INSET * 2.0,
            )
        }
    }

    pub fn controls_center_y(height: f64, expands_upward: bool) -> f64 {
        if expands_upward {
            height - INSET - COMPACT_HEIGHT / 2.0
        } else {
            INSET + HOVER_HANDLE_RESERVED_HEIGHT + COMPACT_HEIGHT / 2.0
        }
    }

    pub fn frame_at_controls(
        anchor: (f64, f64),
        size: (f64, f64),
        work: (f64, f64, f64, f64),
        expands_upward: bool,
    ) -> (f64, f64, f64, f64) {
        let width = size.0.min(work.2);
        let min_height = size.1.min(container_size(false, true).1).min(work.3);
        let (y, height) = if expands_upward {
            let bottom = (anchor.1 + INSET + COMPACT_HEIGHT / 2.0)
                .clamp(work.1 + min_height, work.1 + work.3);
            let height = size.1.min(bottom - work.1);
            (bottom - height, height)
        } else {
            let y = (anchor.1 - controls_center_y(size.1, false))
                .clamp(work.1, work.1 + work.3 - min_height);
            (y, size.1.min(work.1 + work.3 - y))
        };
        let x = (anchor.0 - width / 2.0).clamp(work.0, work.0 + work.2 - width);
        (x, y, width, height)
    }

    pub fn bottom_center_origin(
        work_x: f64,
        work_y: f64,
        work_width: f64,
        work_height: f64,
        window_width: f64,
        window_height: f64,
    ) -> (f64, f64) {
        (
            work_x + (work_width - window_width) / 2.0,
            work_y + work_height - window_height - SCREEN_MARGIN,
        )
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::CStr;
    use std::os::raw::c_char;
    use std::sync::OnceLock;

    use swift_rs::{Bool, SRString, swift};
    use tauri_specta::Event;

    use super::FloatingBarState;
    use crate::Error;

    swift!(fn _floating_bar_show() -> Bool);
    swift!(fn _floating_bar_hide() -> Bool);
    swift!(fn _floating_bar_update(json: &SRString) -> Bool);
    swift!(fn _floating_bar_update_amplitude(amplitude: f64) -> Bool);

    static APP_HANDLE: OnceLock<tauri::AppHandle<tauri::Wry>> = OnceLock::new();

    pub fn set_app_handle(app: tauri::AppHandle<tauri::Wry>) {
        let _ = APP_HANDLE.set(app);
    }

    pub fn show() -> Result<(), Error> {
        unsafe {
            _floating_bar_show();
        }
        Ok(())
    }

    pub fn hide() -> Result<(), Error> {
        unsafe {
            _floating_bar_hide();
        }
        Ok(())
    }

    pub fn update(state: FloatingBarState) -> Result<(), Error> {
        let json = serde_json::to_string(&state).map_err(|error| {
            Error::PanelError(format!("failed to serialize floating bar state: {error}"))
        })?;
        let ok = swift_rs::autoreleasepool!({
            let json = SRString::from(json.as_str());
            unsafe { _floating_bar_update(&json) }
        });
        if ok {
            Ok(())
        } else {
            Err(Error::PanelError(
                "failed to update native floating bar".to_string(),
            ))
        }
    }

    pub fn update_amplitude(amplitude: f64) -> Result<(), Error> {
        let ok = unsafe { _floating_bar_update_amplitude(amplitude) };
        if ok {
            Ok(())
        } else {
            Err(Error::PanelError(
                "failed to update native floating bar amplitude".to_string(),
            ))
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn rust_on_floating_bar_stop() {
        if let Some(app) = APP_HANDLE.get() {
            let _ = crate::events::FloatingBarStop {}.emit(app);
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn rust_on_floating_bar_open_main() {
        if let Some(app) = APP_HANDLE.get() {
            let _ = crate::events::FloatingBarOpenMain {}.emit(app);
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn rust_on_floating_bar_dictation_action(payload: *const c_char) {
        if payload.is_null() {
            return;
        }
        let Ok(json) = (unsafe { CStr::from_ptr(payload) }).to_str() else {
            return;
        };
        if let (Some(app), Ok(event)) = (
            APP_HANDLE.get(),
            serde_json::from_str::<crate::events::FloatingBarDictationAction>(json),
        ) {
            let _ = event.emit(app);
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn rust_on_floating_bar_assist_action(payload: *const c_char) {
        if payload.is_null() {
            return;
        }
        let Ok(json) = (unsafe { CStr::from_ptr(payload) }).to_str() else {
            return;
        };
        if let (Some(app), Ok(event)) = (
            APP_HANDLE.get(),
            serde_json::from_str::<crate::events::FloatingBarAssistAction>(json),
        ) {
            let _ = event.emit(app);
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn rust_on_floating_bar_settings_change(settings_ptr: *const c_char) {
        if settings_ptr.is_null() {
            return;
        }

        let Ok(settings_json) = (unsafe { CStr::from_ptr(settings_ptr) }).to_str() else {
            return;
        };

        let Ok(settings) =
            serde_json::from_str::<crate::events::FloatingBarSettingsChange>(settings_json)
        else {
            return;
        };

        if let Some(app) = APP_HANDLE.get() {
            let _ = settings.emit(app);
        }
    }

    pub fn current_state() -> Option<FloatingBarState> {
        None
    }
}

pub fn set_app_handle(app: tauri::AppHandle<tauri::Wry>) {
    platform::set_app_handle(app);
}

pub fn current_state() -> Option<FloatingBarState> {
    platform::current_state()
}

pub fn show() -> Result<(), Error> {
    platform::show()
}

static SESSION_ID: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub fn session_id() -> Option<String> {
    SESSION_ID.lock().ok().and_then(|guard| guard.clone())
}

pub fn hide() -> Result<(), Error> {
    let hidden_session_id = session_id();
    platform::hide()?;
    if let Ok(mut session_id) = SESSION_ID.lock()
        && *session_id == hidden_session_id
    {
        *session_id = None;
    }
    Ok(())
}

pub fn update(state: FloatingBarState) -> Result<(), Error> {
    let next_session_id = state.session_id.clone();
    platform::update(state)?;
    if let Ok(mut session_id) = SESSION_ID.lock() {
        *session_id = next_session_id;
    }
    Ok(())
}

pub fn update_amplitude(amplitude: f64) -> Result<(), Error> {
    platform::update_amplitude(amplitude)
}

#[cfg(test)]
mod tests {
    use super::layout;

    fn meeting_state(assist_json: Option<&str>, minimized: bool) -> super::FloatingBarState {
        serde_json::from_value(serde_json::json!({
            "amplitude": 0.0,
            "title": "Call",
            "status": "recording",
            "colorScheme": "dark",
            "opacity": 0.8,
            "liveCaptionOpacity": 0.8,
            "liveCaptionWidth": 400.0,
            "liveCaptionLineCount": 2,
            "liveCaptionPosition": "bottomCenter",
            "liveCaptionMinimized": minimized,
            "liveCaptionToggleVisible": true,
            "assistJson": assist_json,
        }))
        .unwrap()
    }

    #[test]
    fn live_assist_opens_a_larger_panel_only_when_expanded() {
        let transcript = layout::meeting_container_size(&meeting_state(None, false));
        let assist = layout::meeting_container_size(&meeting_state(Some("{}"), false));
        let collapsed = layout::meeting_container_size(&meeting_state(Some("{}"), true));

        assert!(assist.0 > transcript.0 && assist.1 > transcript.1);
        assert_eq!(collapsed, layout::container_size(false, true));
    }

    #[test]
    fn controls_dragged_near_vertical_edges_keep_the_panel_visible() {
        for anchor_y in [-100.0, 10.0, 1070.0, 1200.0] {
            for upwards in [false, true] {
                let (x, y, width, height) = layout::frame_at_controls(
                    (960.0, anchor_y),
                    (368.0, 459.0),
                    (0.0, 0.0, 1920.0, 1080.0),
                    upwards,
                );
                assert!(x >= 0.0 && y >= 0.0);
                assert!(height >= layout::container_size(false, true).1);
                assert!(x + width <= 1920.0 && y + height <= 1080.0);
            }
        }
    }

    #[test]
    fn controls_keep_their_screen_position_through_expansion_and_collapse() {
        let work = (-1920.0, 40.0, 1920.0, 1040.0);
        for (anchor, upwards) in [
            ((-960.0, 1049.0), true),
            ((-960.0, 92.0), false),
            ((-64.0, 1049.0), true),
        ] {
            for size in [(111.0, 67.0), (368.0, 459.0), (111.0, 67.0)] {
                let frame = layout::frame_at_controls(anchor, size, work, upwards);
                assert_eq!(
                    frame.1 + layout::controls_center_y(frame.3, upwards),
                    anchor.1
                );
                assert!(frame.0 <= anchor.0 && frame.0 + frame.2 >= anchor.0);
                assert!(frame.0 >= work.0 && frame.0 + frame.2 <= work.0 + work.2);
                assert!(frame.1 >= work.1 && frame.1 + frame.3 <= work.1 + work.3);
            }
        }
    }

    #[test]
    fn short_displays_reduce_the_panel_instead_of_moving_the_controls() {
        let frame = layout::frame_at_controls(
            (150.0, 180.0),
            (368.0, 459.0),
            (0.0, 0.0, 300.0, 320.0),
            true,
        );
        assert_eq!(frame, (0.0, 0.0, 300.0, 203.0));
        assert_eq!(frame.1 + layout::controls_center_y(frame.3, true), 180.0);
    }

    #[test]
    fn collapse_after_drag_uses_the_new_control_position() {
        let work = (0.0, 0.0, 1920.0, 1080.0);
        let expanded = layout::frame_at_controls((1856.0, 1049.0), (368.0, 459.0), work, true);
        let controls_x = 1856.0 - expanded.0;
        let moved_anchor = (expanded.0 - 100.0 + controls_x, 1049.0);
        let collapsed = layout::frame_at_controls(moved_anchor, (144.0, 67.0), work, true);
        assert_eq!(collapsed.0 + collapsed.2 / 2.0, 1756.0);
    }

    #[test]
    fn default_origin_is_bottom_center_on_offset_displays() {
        assert_eq!(
            layout::bottom_center_origin(-1920.0, 40.0, 1920.0, 1040.0, 111.0, 67.0),
            (-1015.5, 1005.0)
        );
    }
}
