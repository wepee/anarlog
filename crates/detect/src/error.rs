#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("failed to get audio processes: {0}")]
    AudioProcessQuery(String),
    #[error("failed to inspect audio process state: {0}")]
    AudioProcessState(String),
}
