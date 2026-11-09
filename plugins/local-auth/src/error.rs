#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[error("{0}")]
    Platform(String),
}

pub type Result<T> = std::result::Result<T, Error>;
