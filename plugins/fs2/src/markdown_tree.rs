use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownFile {
    /// Path relative to the scanned folder, with `/` separators.
    pub path: String,
    pub content: String,
    pub modified_ms: f64,
}

// Reads the Markdown notes of a folder the user picked (an Obsidian vault,
// for instance). Hidden folders such as `.obsidian`, `.trash` or `.git` are
// skipped. When there are more files than `max_files`, the most recently
// modified ones are kept; each file is cut at `max_file_bytes`.
pub fn read_markdown_tree(
    root: &Path,
    max_files: usize,
    max_file_bytes: usize,
) -> std::io::Result<Vec<MarkdownFile>> {
    let mut found = Vec::new();
    collect(root, root, &mut found)?;
    found.sort_by(|a, b| b.1.total_cmp(&a.1));
    found.truncate(max_files);

    Ok(found
        .into_iter()
        .filter_map(|(path, modified_ms)| {
            let content = std::fs::read_to_string(&path).ok()?;
            let relative = path
                .strip_prefix(root)
                .ok()?
                .components()
                .map(|component| component.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            Some(MarkdownFile {
                path: relative,
                content: truncate_at_char_boundary(content, max_file_bytes),
                modified_ms,
            })
        })
        .collect())
}

fn collect(
    root: &Path,
    dir: &Path,
    found: &mut Vec<(std::path::PathBuf, f64)>,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            let _ = collect(root, &path, found);
        } else if file_type.is_file()
            && path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            let modified_ms = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as f64)
                .unwrap_or(0.0);
            found.push((path, modified_ms));
        }
    }
    Ok(())
}

fn truncate_at_char_boundary(mut text: String, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_notes_and_skips_hidden_folders() {
        let root =
            &std::env::temp_dir().join(format!("anlg-fs2-markdown-tree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(root);
        std::fs::create_dir_all(root.join("Clients")).unwrap();
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        std::fs::write(
            root.join("Clients").join("Maison Lumen.md"),
            "Budget 40 à 60 k€",
        )
        .unwrap();
        std::fs::write(root.join(".obsidian").join("workspace.md"), "hidden").unwrap();
        std::fs::write(root.join("image.png"), "not markdown").unwrap();

        let files = read_markdown_tree(root, 10, 10).unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "Clients/Maison Lumen.md");
        assert_eq!(files[0].content, "Budget 40 ");
        let _ = std::fs::remove_dir_all(root);
    }
}
