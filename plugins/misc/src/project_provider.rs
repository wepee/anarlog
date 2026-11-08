use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;

const MAX_STDOUT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_STDERR_BYTES: u64 = 8 * 1024;

// The app only ever calls the user's projects command with one of these
// subcommands, and passes every value as its own argument: nothing goes
// through a shell, so a search query taken from the call cannot run anything.
#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectProviderRequest {
    Projects,
    Context { id: String },
    Search { id: String, query: String },
}

impl ProjectProviderRequest {
    fn args(&self) -> Vec<String> {
        match self {
            Self::Projects => vec!["projects".into()],
            Self::Context { id } => vec!["context".into(), id.clone()],
            Self::Search { id, query } => vec!["search".into(), id.clone(), query.clone()],
        }
    }

    fn timeout(&self) -> Duration {
        match self {
            Self::Projects => Duration::from_secs(10),
            Self::Context { .. } => Duration::from_secs(15),
            Self::Search { .. } => Duration::from_secs(5),
        }
    }
}

pub async fn run(command: &str, request: &ProjectProviderRequest) -> Result<String, String> {
    let mut words = split_command(command)?.into_iter();
    let program = words
        .next()
        .ok_or_else(|| "the projects command is empty".to_string())?;
    let program = expand_home(&program);

    let mut child = tokio::process::Command::new(&program)
        .args(words)
        .args(request.args())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("could not start {program}: {error}"))?;

    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let work = async {
        let (out, err, status) = tokio::join!(
            read_capped(stdout, MAX_STDOUT_BYTES + 1),
            read_capped(stderr, MAX_STDERR_BYTES),
            child.wait(),
        );
        let status = status.map_err(|error| error.to_string())?;
        Ok::<_, String>((
            status,
            out.map_err(|error| error.to_string())?,
            err.map_err(|error| error.to_string())?,
        ))
    };

    let (status, out, err) = tokio::time::timeout(request.timeout(), work)
        .await
        .map_err(|_| format!("timed out after {}s", request.timeout().as_secs()))??;

    if !status.success() {
        let stderr = String::from_utf8_lossy(&err);
        return Err(format!("exited with {status}: {}", stderr.trim()));
    }
    if out.len() as u64 > MAX_STDOUT_BYTES {
        return Err("output is larger than 4 MB".into());
    }
    String::from_utf8(out).map_err(|_| "output is not UTF-8".to_string())
}

// Keeps the first `cap` bytes but reads everything, so a chatty command never
// blocks on a full pipe.
async fn read_capped(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    cap: u64,
) -> std::io::Result<Vec<u8>> {
    let mut kept = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            return Ok(kept);
        }
        let room = (cap as usize).saturating_sub(kept.len());
        kept.extend_from_slice(&buffer[..read.min(room)]);
    }
}

fn expand_home(program: &str) -> String {
    match (program.strip_prefix("~/"), std::env::var("HOME")) {
        (Some(rest), Ok(home)) => format!("{home}/{rest}"),
        _ => program.to_string(),
    }
}

// Splits a command line the way a shell would for plain words and quotes,
// without expanding anything.
pub fn split_command(command: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => word.push(c),
                        None => return Err("unclosed ' in the projects command".into()),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(c) => word.push(c),
                            None => return Err("unclosed \" in the projects command".into()),
                        },
                        Some(c) => word.push(c),
                        None => return Err("unclosed \" in the projects command".into()),
                    }
                }
            }
            '\\' => {
                in_word = true;
                if let Some(c) = chars.next() {
                    word.push(c);
                }
            }
            c if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            c => {
                in_word = true;
                word.push(c);
            }
        }
    }
    if in_word {
        words.push(word);
    }
    Ok(words)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_quoted_words() {
        assert_eq!(
            split_command(r#"  "/Users/me/My Tools/memex" anarlog --vault '~/Second brain' a\ b "#)
                .unwrap(),
            vec![
                "/Users/me/My Tools/memex",
                "anarlog",
                "--vault",
                "~/Second brain",
                "a b"
            ]
        );
        assert!(split_command("memex 'oops").is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn passes_the_query_as_one_argument_without_a_shell() {
        let output = run(
            "printf %s|",
            &ProjectProviderRequest::Search {
                id: "lumen".into(),
                query: "$(touch pwned); prix ?".into(),
            },
        )
        .await
        .unwrap();

        assert_eq!(output, "search|lumen|$(touch pwned); prix ?|");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reports_a_failing_command() {
        let error = run("false", &ProjectProviderRequest::Projects)
            .await
            .unwrap_err();
        assert!(error.starts_with("exited with"), "{error}");
    }
}
