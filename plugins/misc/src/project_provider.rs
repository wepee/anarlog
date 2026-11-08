use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MAX_STDOUT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_STDERR_BYTES: u64 = 8 * 1024;

// The app only ever calls the user's projects command with one of these
// subcommands. Nothing goes through a shell: options are separate arguments,
// and what comes from the call (title, participants, transcript) is written
// to the command's stdin as JSON, so it cannot run anything.
#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectProviderRequest {
    Route {
        input: String,
    },
    Context {
        project: String,
    },
    Read {
        project: String,
        section: Option<String>,
        search: Option<String>,
    },
}

impl ProjectProviderRequest {
    fn args(&self) -> Vec<String> {
        match self {
            Self::Route { .. } => vec!["route".into()],
            Self::Context { project } => {
                vec!["context".into(), "--project".into(), project.clone()]
            }
            Self::Read {
                project,
                section,
                search,
            } => {
                let mut args = vec!["read".into(), "--project".into(), project.clone()];
                if let Some(section) = section {
                    args.extend(["--section".into(), section.clone()]);
                }
                if let Some(search) = search {
                    args.extend(["--search".into(), search.clone()]);
                }
                args
            }
        }
    }

    fn stdin(&self) -> Option<&str> {
        match self {
            Self::Route { input } => Some(input),
            _ => None,
        }
    }

    fn timeout(&self) -> Duration {
        match self {
            Self::Route { .. } => Duration::from_secs(10),
            Self::Context { .. } => Duration::from_secs(15),
            Self::Read { .. } => Duration::from_secs(8),
        }
    }
}

pub async fn run(command: &str, request: &ProjectProviderRequest) -> Result<String, String> {
    let mut words = split_command(command)?.into_iter();
    let program = words
        .next()
        .ok_or_else(|| "the projects command is empty".to_string())?;
    let program = expand_home(&program);
    let search_path = search_path(Path::new(&program));
    let resolved = resolve_program(&program, &search_path)
        .ok_or_else(|| format!("{program} was not found"))?;

    let mut command = tokio::process::Command::new(&resolved);
    command
        .args(words.map(|word| expand_home(&word)))
        .args(request.args())
        .env("PATH", &search_path)
        .stdin(if request.stdin().is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Its own process group, so a timeout also stops what a wrapper script
    // started (node, ripgrep...).
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start {program}: {error}"))?;
    let pid = child.id();
    let input = request.stdin().map(str::to_owned);
    let stdin = child.stdin.take();

    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let work = async {
        let write_input = async move {
            if let (Some(mut stdin), Some(input)) = (stdin, input) {
                // A command that does not read its input is fine.
                let _ = stdin.write_all(input.as_bytes()).await;
            }
        };
        let (_, out, err, status) = tokio::join!(
            write_input,
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

    let (status, out, err) = match tokio::time::timeout(request.timeout(), work).await {
        Ok(result) => result?,
        Err(_) => {
            kill_group(pid);
            return Err(format!("timed out after {}s", request.timeout().as_secs()));
        }
    };

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

#[cfg(unix)]
fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid {
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .status();
    }
}

#[cfg(not(unix))]
fn kill_group(_pid: Option<u32>) {}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn expand_home(word: &str) -> String {
    match (word.strip_prefix("~/"), home_dir()) {
        (Some(rest), Some(home)) => home.join(rest).to_string_lossy().into_owned(),
        _ => word.to_string(),
    }
}

// An app opened from the Dock gets a bare PATH (/usr/bin:/bin...), so the
// usual install folders for CLIs and their runtimes are added, after the
// command's own folder.
fn search_path(program: &Path) -> std::ffi::OsString {
    let mut dirs = Vec::new();
    if let Some(parent) = program
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        dirs.push(parent.to_path_buf());
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.extend([
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
    ]);
    if let Some(home) = home_dir() {
        for dir in [
            ".local/bin",
            ".bun/bin",
            ".cargo/bin",
            ".volta/bin",
            ".asdf/shims",
            ".npm-global/bin",
            ".fnm/aliases/default/bin",
        ] {
            dirs.push(home.join(dir));
        }
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions = entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path().join("bin"))
                .collect::<Vec<_>>();
            versions.sort();
            dirs.extend(versions.into_iter().rev());
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

fn resolve_program(program: &str, search_path: &std::ffi::OsStr) -> Option<PathBuf> {
    let path = Path::new(program);
    if path.components().count() > 1 {
        return path.is_file().then(|| path.to_path_buf());
    }
    let names: Vec<String> = if cfg!(windows) {
        vec![
            format!("{program}.exe"),
            format!("{program}.cmd"),
            program.to_string(),
        ]
    } else {
        vec![program.to_string()]
    };
    std::env::split_paths(search_path)
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
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
    async fn passes_the_call_on_stdin_without_a_shell() {
        let output = run(
            "sh -c 'printf \"$0 \"; cat'",
            &ProjectProviderRequest::Route {
                input: r#"{"transcript":"$(touch pwned); prix ?"}"#.into(),
            },
        )
        .await
        .unwrap();

        assert_eq!(output, r#"route {"transcript":"$(touch pwned); prix ?"}"#);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn finds_a_script_runtime_outside_the_inherited_path() {
        let dir = std::env::temp_dir().join(format!("project-provider-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let runtime = dir.join("fake-runtime");
        std::fs::write(&runtime, "#!/bin/sh\nshift\nprintf 'ran %s' \"$1\"\n").unwrap();
        let script = dir.join("tool");
        std::fs::write(&script, "#!/usr/bin/env fake-runtime\n").unwrap();
        for file in [&runtime, &script] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let output = run(
            script.to_str().unwrap(),
            &ProjectProviderRequest::Context {
                project: "lumen".into(),
            },
        )
        .await
        .unwrap();
        std::fs::remove_dir_all(&dir).unwrap();

        assert_eq!(output, "ran context");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn passes_read_options_as_separate_arguments() {
        let output = run(
            "printf %s|",
            &ProjectProviderRequest::Read {
                project: "projects/lumen optique".into(),
                section: None,
                search: Some("prix; tarif $(id)".into()),
            },
        )
        .await
        .unwrap();

        assert_eq!(
            output,
            "read|--project|projects/lumen optique|--search|prix; tarif $(id)|"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reports_a_failing_command() {
        let error = run(
            "false",
            &ProjectProviderRequest::Context {
                project: "lumen".into(),
            },
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("exited with"), "{error}");
    }
}
