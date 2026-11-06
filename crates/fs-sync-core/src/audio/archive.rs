// [fork] Moves a meeting's finished recording out of the app data folder while
// keeping it playable. The archived file replaces the local one through a
// symlink, so every reader that opens `<session>/audio.*` (playback, peaks,
// re-transcription) follows it without knowing about the archive.

use std::path::{Path, PathBuf};

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
            std::fs::File::open(&partial)?.sync_all()?;
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

#[cfg(not(unix))]
pub fn archive(
    _session_dir: &Path,
    _archive_dir: &Path,
    _session_id: &str,
) -> std::io::Result<ArchiveOutcome> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "audio archiving needs symlinks",
    ))
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
