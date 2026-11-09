// [fork] Moves a meeting's finished recording out of the app data folder while
// keeping it playable. The archived file replaces the local one through a
// symlink, so every reader that opens `<session>/audio.*` (playback, peaks,
// re-transcription) follows it without knowing about the archive.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use super::AUDIO_FORMATS;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchiveOutcome {
    Archived(PathBuf),
    AlreadyArchived,
    NoAudio,
    /// A capture or a recovery is still writing next to the recording.
    Busy,
}

// Present while a recording is still being written or repaired; archiving the
// primary file then would race the writer.
const IN_PROGRESS_ARTIFACTS: [&str; 5] = [
    "audio.mp3.tmp",
    "audio.wav.tmp",
    "audio_mic.wav",
    "audio_spk.wav",
    ".delete-audio-on-stop",
];

fn primary(session_dir: &Path) -> std::io::Result<Option<(PathBuf, bool)>> {
    for format in AUDIO_FORMATS {
        let path = session_dir.join(format);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) => return Ok(Some((path, metadata.file_type().is_symlink()))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

/// The file a symlinked primary recording points at, when it is archived.
pub fn archived_target(session_dir: &Path) -> std::io::Result<Option<PathBuf>> {
    match primary(session_dir)? {
        Some((path, true)) => {
            let target = std::fs::read_link(&path)?;
            Ok(Some(if target.is_absolute() {
                target
            } else {
                session_dir.join(target)
            }))
        }
        _ => Ok(None),
    }
}

#[cfg(unix)]
pub fn archive(
    session_dir: &Path,
    archive_dir: &Path,
    session_id: &str,
) -> std::io::Result<ArchiveOutcome> {
    let Some((source, is_symlink)) = primary(session_dir)? else {
        return Ok(ArchiveOutcome::NoAudio);
    };
    if is_symlink {
        return Ok(ArchiveOutcome::AlreadyArchived);
    }
    if session_dir.join("audio-recovery").exists()
        || IN_PROGRESS_ARTIFACTS
            .iter()
            .any(|artifact| session_dir.join(artifact).exists())
    {
        return Ok(ArchiveOutcome::Busy);
    }
    // A WAV left next to an MP3 is an unfinished encode; leave both alone.
    if source.file_name().is_some_and(|name| name == "audio.mp3")
        && session_dir.join("audio.wav").exists()
    {
        return Ok(ArchiveOutcome::Busy);
    }

    let filename = source
        .file_name()
        .ok_or_else(|| std::io::Error::other("audio_source_filename_missing"))?;
    let target_dir = archive_dir.join(session_id);
    std::fs::create_dir_all(&target_dir)?;
    let target = target_dir.join(filename);

    let source_len = std::fs::metadata(&source)?.len();
    let reuse_existing = std::fs::metadata(&target).is_ok_and(|metadata| {
        metadata.len() == source_len && same_content(&source, &target).unwrap_or(false)
    });
    if !reuse_existing {
        let partial = target_dir.join(format!(
            ".{}.{}.partial",
            filename.to_string_lossy(),
            uuid::Uuid::new_v4()
        ));
        let copy = (|| {
            std::fs::copy(&source, &partial)?;
            // Keep the recording's own timestamp: the waveform cache is keyed
            // on it, and a new one would force a download just to redraw peaks.
            let modified = std::fs::metadata(&source)?.modified()?;
            let copied = std::fs::OpenOptions::new().write(true).open(&partial)?;
            copied.set_modified(modified)?;
            copied.sync_all()?;
            if std::fs::metadata(&partial)?.len() != source_len {
                return Err(std::io::Error::other("audio_archive_size_mismatch"));
            }
            std::fs::rename(&partial, &target)
        })();
        if let Err(error) = copy {
            let _ = std::fs::remove_file(&partial);
            return Err(error);
        }
    }

    // Swap the local file for a link in one rename, so the recording is never
    // missing from the session folder.
    let link = session_dir.join(format!(".{}.archive-link", filename.to_string_lossy()));
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(&target, &link)?;
    if let Err(error) = std::fs::rename(&link, &source) {
        let _ = std::fs::remove_file(&link);
        return Err(error);
    }
    Ok(ArchiveOutcome::Archived(target))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioAvailability {
    /// The recording lives in the archive folder.
    pub archived: bool,
    /// Its bytes are on this disk; an archived file the cloud provider has
    /// offloaded is not, and opening it starts a download.
    pub local: bool,
}

pub fn availability(session_dir: &Path) -> std::io::Result<AudioAvailability> {
    let Some(target) = archived_target(session_dir)? else {
        return Ok(AudioAvailability {
            archived: false,
            local: super::exists(session_dir)?,
        });
    };
    let local = match std::fs::metadata(&target) {
        Ok(metadata) => !is_offloaded(&metadata),
        // An unreachable archive (folder gone, drive unplugged) is not local.
        Err(_) => false,
    };
    Ok(AudioAvailability {
        archived: true,
        local,
    })
}

/// Whether the cloud provider keeps only a placeholder for this file.
#[cfg(target_os = "macos")]
pub fn is_offloaded(metadata: &std::fs::Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    // SF_DATALESS from <sys/stat.h>.
    const SF_DATALESS: u32 = 0x4000_0000;
    metadata.st_flags() & SF_DATALESS != 0
}

/// Brings an archived recording back onto this disk. Reading the file is what
/// makes the cloud provider download it, so this blocks until it is local.
pub fn download(session_dir: &Path) -> std::io::Result<()> {
    use std::io::Read;

    let path = super::path(session_dir)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "audio_path_not_found"))?;
    mark_opened(&path);
    let mut file = std::fs::File::open(&path)?;
    let mut buffer = vec![0_u8; 1 << 20];
    while file.read(&mut buffer)? > 0 {}
    mark_opened(&path);
    Ok(())
}

// Archives the user has just listened to stay on disk for a while, so the
// offloading pass does not pull a file out from under the player.
static OPENED: LazyLock<Mutex<HashMap<PathBuf, Instant>>> = LazyLock::new(Default::default);

pub fn mark_opened(path: &Path) {
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    OPENED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(path, Instant::now());
}

pub fn opened_within(path: &Path, window: Duration) -> bool {
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    OPENED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&path)
        .is_some_and(|at| at.elapsed() < window)
}

/// Archived recordings still on this disk that may be offloaded: copied long
/// enough ago to be uploaded, and not just played. The copy keeps the
/// recording's modification time, so its age is read from its creation time.
pub fn archives_to_offload(
    archive_dir: &Path,
    upload_grace: Duration,
    recently_played: Duration,
) -> Vec<PathBuf> {
    let Ok(sessions) = std::fs::read_dir(archive_dir) else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    for session in sessions.flatten() {
        let Ok(files) = std::fs::read_dir(session.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            let is_audio = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| AUDIO_FORMATS.contains(&name));
            let Ok(metadata) = file.metadata() else {
                continue;
            };
            let settled = metadata
                .created()
                .or_else(|_| metadata.modified())
                .ok()
                .and_then(|copied| copied.elapsed().ok())
                .is_some_and(|age| age >= upload_grace);
            if is_audio
                && settled
                && !is_offloaded(&metadata)
                && !opened_within(&path, recently_played)
            {
                paths.push(path);
            }
        }
    }
    paths
}

fn same_content(a: &Path, b: &Path) -> std::io::Result<bool> {
    use std::io::Read;

    let mut a = std::io::BufReader::new(std::fs::File::open(a)?);
    let mut b = std::io::BufReader::new(std::fs::File::open(b)?);
    let mut left = [0_u8; 64 * 1024];
    let mut right = [0_u8; 64 * 1024];
    loop {
        let read = a.read(&mut left)?;
        if read == 0 {
            return Ok(b.read(&mut right[..1])? == 0);
        }
        b.read_exact(&mut right[..read])?;
        if left[..read] != right[..read] {
            return Ok(false);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn session_with_audio(root: &Path, bytes: &[u8]) -> PathBuf {
        let session_dir = root.join("sessions").join("session-1");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(session_dir.join("audio.mp3"), bytes).unwrap();
        session_dir
    }

    #[test]
    fn archived_recording_stays_readable_through_the_session_folder() {
        let temp = tempfile::tempdir().unwrap();
        let session_dir = session_with_audio(temp.path(), b"meeting audio");
        let archive_dir = temp.path().join("archive");

        let outcome = archive(&session_dir, &archive_dir, "session-1").unwrap();

        let target = archive_dir.join("session-1").join("audio.mp3");
        assert_eq!(outcome, ArchiveOutcome::Archived(target.clone()));
        assert_eq!(std::fs::read(&target).unwrap(), b"meeting audio");
        assert_eq!(
            std::fs::read(session_dir.join("audio.mp3")).unwrap(),
            b"meeting audio"
        );
        assert_eq!(archived_target(&session_dir).unwrap(), Some(target));
        assert!(super::super::exists(&session_dir).unwrap());
        assert_eq!(
            archive(&session_dir, &archive_dir, "session-1").unwrap(),
            ArchiveOutcome::AlreadyArchived
        );
    }

    #[test]
    fn an_archived_copy_keeps_the_recording_timestamp_and_reports_where_it_lives() {
        let temp = tempfile::tempdir().unwrap();
        let session_dir = session_with_audio(temp.path(), b"meeting audio");
        let before = std::fs::metadata(session_dir.join("audio.mp3"))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(
            availability(&session_dir).unwrap(),
            AudioAvailability {
                archived: false,
                local: true
            }
        );

        archive(&session_dir, &temp.path().join("archive"), "session-1").unwrap();

        let after = std::fs::metadata(session_dir.join("audio.mp3"))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(before, after);
        assert_eq!(
            availability(&session_dir).unwrap(),
            AudioAvailability {
                archived: true,
                local: true
            }
        );
        download(&session_dir).unwrap();
        assert!(opened_within(
            &temp.path().join("archive/session-1/audio.mp3"),
            Duration::from_secs(60)
        ));

        std::fs::remove_dir_all(temp.path().join("archive")).unwrap();
        assert_eq!(
            availability(&session_dir).unwrap(),
            AudioAvailability {
                archived: true,
                local: false
            }
        );
    }

    #[test]
    fn offloads_only_settled_archives_that_were_not_just_played() {
        let temp = tempfile::tempdir().unwrap();
        let session_dir = session_with_audio(temp.path(), b"meeting audio");
        let archive_dir = temp.path().join("archive");
        archive(&session_dir, &archive_dir, "session-1").unwrap();
        let archived = archive_dir.join("session-1").join("audio.mp3");
        let hour = Duration::from_secs(3600);

        assert!(archives_to_offload(&archive_dir, hour, hour).is_empty());
        assert_eq!(
            archives_to_offload(&archive_dir, Duration::ZERO, hour),
            vec![archived.clone()]
        );

        mark_opened(&archived);
        assert!(archives_to_offload(&archive_dir, Duration::ZERO, hour).is_empty());
    }

    #[test]
    fn leaves_recordings_that_are_still_being_written() {
        let temp = tempfile::tempdir().unwrap();
        let session_dir = session_with_audio(temp.path(), b"partial");
        std::fs::write(session_dir.join("audio.wav"), b"pcm").unwrap();

        let outcome = archive(&session_dir, &temp.path().join("archive"), "session-1").unwrap();

        assert_eq!(outcome, ArchiveOutcome::Busy);
        assert!(
            !std::fs::symlink_metadata(session_dir.join("audio.mp3"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn deleting_an_archived_recording_removes_the_archived_file() {
        let temp = tempfile::tempdir().unwrap();
        let session_dir = session_with_audio(temp.path(), b"meeting audio");
        let archive_dir = temp.path().join("archive");
        archive(&session_dir, &archive_dir, "session-1").unwrap();

        assert!(super::super::delete(&session_dir).unwrap());

        assert!(!archive_dir.join("session-1").join("audio.mp3").exists());
        assert!(std::fs::symlink_metadata(session_dir.join("audio.mp3")).is_err());
    }
}
