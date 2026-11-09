const COMMANDS: &[&str] = &[
    "get_git_hash",
    "get_fingerprint",
    "get_device_info",
    "get_process_memory_bytes",
    "opinionated_md_to_html",
    "run_project_provider",
    "delete_session_folder",
    "audio_open",
    "audio_exist",
    "audio_delete",
    "audio_path",
    "audio_import",
    "reveal_session_in_finder",
];

// [fork] `git` directly instead of vergen-gix, which pulled ~64 gix crates into
// every build for this one value.
fn main() {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
    };

    let sha = git(&["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=GIT_SHA={sha}");

    if let Some(git_dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        println!("cargo:rerun-if-changed={git_dir}/HEAD");
        if let Some(head_ref) = git(&["symbolic-ref", "-q", "HEAD"]) {
            println!("cargo:rerun-if-changed={git_dir}/{head_ref}");
        }
        println!("cargo:rerun-if-changed={git_dir}/packed-refs");
    }

    tauri_plugin::Builder::new(COMMANDS).build();
}
