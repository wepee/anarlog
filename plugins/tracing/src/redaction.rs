use std::io::{self, Write};
use std::sync::LazyLock;

use regex::Regex;

static EMAIL_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}").expect("Invalid regex")
});

static IP_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b").expect("Invalid regex"));
static IPV6_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b").expect("Invalid regex")
});
static UUID_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
        .expect("Invalid regex")
});
static SECRET_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(bearer\s+|api[_ -]?key[=:]\s*|token[=:]\s*)[a-z0-9._~+/=-]{8,}")
        .expect("Invalid regex")
});

fn redact_sensitive_text(value: &str, home_dir: Option<&str>) -> String {
    let mut redacted = value.to_string();
    if let Some(home) = home_dir {
        redacted = redacted.replace(home, "[HOME]");
    }
    redacted = EMAIL_REGEX
        .replace_all(&redacted, "[EMAIL_REDACTED]")
        .into_owned();
    redacted = IP_REGEX
        .replace_all(&redacted, "[IP_REDACTED]")
        .into_owned();
    redacted = IPV6_REGEX
        .replace_all(&redacted, "[IP_REDACTED]")
        .into_owned();
    redacted = UUID_REGEX
        .replace_all(&redacted, "[ID_REDACTED]")
        .into_owned();
    SECRET_REGEX
        .replace_all(&redacted, "$1[SECRET_REDACTED]")
        .into_owned()
}

pub fn redact_text(value: &str) -> String {
    let home_dir = dirs::home_dir().map(|path| path.to_string_lossy().into_owned());
    redact_sensitive_text(value, home_dir.as_deref())
}

pub struct RedactingWriter<W: Write> {
    inner: W,
    buffer: Vec<u8>,
    home_dir: Option<String>,
}

impl<W: Write> RedactingWriter<W> {
    pub fn new(inner: W) -> Self {
        Self {
            inner,
            buffer: Vec::with_capacity(8192),
            home_dir: dirs::home_dir().map(|p| p.to_string_lossy().into_owned()),
        }
    }

    #[cfg(test)]
    fn with_home_dir(inner: W, home_dir: Option<String>) -> Self {
        Self {
            inner,
            buffer: Vec::with_capacity(8192),
            home_dir,
        }
    }

    fn redact_line(&self, line: &str) -> String {
        if anlg_user_error::is_user_error_text(line) {
            return String::new();
        }
        redact_sensitive_text(line, self.home_dir.as_deref())
    }

    fn flush_buffer(&mut self) -> io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }

        let line = String::from_utf8_lossy(&self.buffer);
        let redacted = self.redact_line(&line);
        self.inner.write_all(redacted.as_bytes())?;

        self.buffer.clear();
        Ok(())
    }
}

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut last_newline_pos = 0;

        for (i, &byte) in buf.iter().enumerate() {
            if byte == b'\n' {
                self.buffer.extend_from_slice(&buf[last_newline_pos..=i]);
                self.flush_buffer()?;
                last_newline_pos = i + 1;
            }
        }

        if last_newline_pos < buf.len() {
            self.buffer.extend_from_slice(&buf[last_newline_pos..]);
        }

        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.flush_buffer()?;
        self.inner.flush()
    }
}

impl<W: Write> Drop for RedactingWriter<W> {
    fn drop(&mut self) {
        let _ = self.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn assert_redaction(home: Option<&str>, input: &str, expected: &str) {
        let mut output = Vec::new();
        {
            let mut writer = RedactingWriter::with_home_dir(&mut output, home.map(String::from));
            writeln!(writer, "{}", input).unwrap();
            writer.flush().unwrap();
        }
        let result = String::from_utf8(output).unwrap();
        assert_eq!(result.trim(), expected, "input: {}", input);
    }

    #[test]
    fn redacts_sensitive_text() {
        for (home, input, expected) in [
            (
                Some("/home/alice"),
                "/home/alice/file and /home/alice/other",
                "[HOME]/file and [HOME]/other",
            ),
            (
                Some("/Users/janedoe"),
                "/Users/janedoe/projects/app",
                "[HOME]/projects/app",
            ),
            (
                Some(r"C:\Users\johndoe"),
                r"C:\Users\johndoe\Desktop\file.txt",
                r"[HOME]\Desktop\file.txt",
            ),
            (
                Some("/home/alice"),
                "/home/bob/documents/file.txt",
                "/home/bob/documents/file.txt",
            ),
            (
                None,
                "From alice@test.org to bob@example.com",
                "From [EMAIL_REDACTED] to [EMAIL_REDACTED]",
            ),
            (
                None,
                "Email: john.doe+tag@sub.example.co.uk",
                "Email: [EMAIL_REDACTED]",
            ),
            (
                None,
                "Listening on 127.0.0.1:8080",
                "Listening on [IP_REDACTED]:8080",
            ),
            (
                Some("/home/alice"),
                "User alice@test.com at /home/alice connected from 192.168.1.50",
                "User [EMAIL_REDACTED] at [HOME] connected from [IP_REDACTED]",
            ),
            (
                None,
                "session 550e8400-e29b-41d4-a716-446655440000 failed",
                "session [ID_REDACTED] failed",
            ),
            (
                None,
                "authorization Bearer abcdefghijklmnop",
                "authorization Bearer [SECRET_REDACTED]",
            ),
            (
                None,
                "Application started successfully",
                "Application started successfully",
            ),
        ] {
            assert_redaction(home, input, expected);
        }
    }

    #[test]
    fn writer_drops_user_account_errors() {
        let mut output = Vec::new();
        {
            let mut writer = RedactingWriter::with_home_dir(&mut output, None);
            writeln!(writer, "provider rejected request: insufficient_quota").unwrap();
            writer.flush().unwrap();
        }
        assert!(output.is_empty());
    }

    #[test]
    fn writer_buffers_partial_lines() {
        let mut output = Vec::new();
        {
            let mut writer = RedactingWriter::with_home_dir(&mut output, Some("/home/user".into()));
            writer.write_all(b"test /home/").unwrap();
            writer.write_all(b"user/file\n").unwrap();
            writer.flush().unwrap();
        }
        let result = String::from_utf8(output).unwrap();
        assert_eq!(result, "test [HOME]/file\n");
    }

    #[test]
    fn writer_handles_interleaved_writes() {
        let mut output = Vec::new();
        {
            let mut writer = RedactingWriter::new(&mut output);
            writer.write_all(b"line1 ").unwrap();
            writer.write_all(b"user@test.com").unwrap();
            writer.write_all(b" end\n").unwrap();
            writer.write_all(b"line2\n").unwrap();
            writer.flush().unwrap();
        }
        let result = String::from_utf8(output).unwrap();
        assert_eq!(result, "line1 [EMAIL_REDACTED] end\nline2\n");
    }

    #[test]
    fn writer_passes_through_empty_and_blank_input() {
        for input in ["", "\n\n\n"] {
            let mut output = Vec::new();
            {
                let mut writer = RedactingWriter::new(&mut output);
                writer.write_all(input.as_bytes()).unwrap();
                writer.flush().unwrap();
            }
            assert_eq!(
                String::from_utf8(output).unwrap(),
                input,
                "unexpected output for input {input:?}"
            );
        }
    }
}
