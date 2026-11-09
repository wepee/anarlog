use serde::{Deserialize, Serialize};

use crate::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum LiveCaptionPosition {
    TopCenter,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    BottomCenter,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LiveCaptionState {
    pub text: String,
    pub opacity: f64,
    pub width: f64,
    pub line_count: u32,
    pub position: LiveCaptionPosition,
    pub minimized: bool,
}

pub const WINDOW_LABEL: &str = "live-caption";

#[cfg(target_os = "macos")]
mod platform {
    use swift_rs::{Bool, swift};

    use super::LiveCaptionState;
    use crate::Error;

    swift!(fn _live_caption_hide() -> Bool);

    pub fn set_app_handle(_app: tauri::AppHandle<tauri::Wry>) {}

    pub fn current_state() -> Option<LiveCaptionState> {
        None
    }

    pub fn show() -> Result<(), Error> {
        hide()
    }

    pub fn hide() -> Result<(), Error> {
        unsafe {
            _live_caption_hide();
        }
        Ok(())
    }

    pub fn update(_state: LiveCaptionState) -> Result<(), Error> {
        hide()
    }
}

pub fn set_app_handle(app: tauri::AppHandle<tauri::Wry>) {
    platform::set_app_handle(app);
}

pub fn current_state() -> Option<LiveCaptionState> {
    platform::current_state()
}

pub fn show() -> Result<(), Error> {
    platform::show()
}

pub fn hide() -> Result<(), Error> {
    platform::hide()
}

pub fn update(state: LiveCaptionState) -> Result<(), Error> {
    platform::update(state)
}
