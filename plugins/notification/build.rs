const COMMANDS: &[&str] = &[
    "show_notification",
    "clear_notifications",
    "resolve_favicon_path",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
