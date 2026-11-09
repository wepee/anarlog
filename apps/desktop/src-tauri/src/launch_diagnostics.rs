// [fork] Logs once per launch how macOS sees this build: its code signature
// and the permissions it holds. Keychain prompts after an update, and an
// Accessibility switch that stays off, both come down to these.

use tauri::Manager as _;
use tauri_plugin_permissions::{Permission, PermissionsPluginExt};

pub fn spawn(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        #[cfg(target_os = "macos")]
        {
            if let Ok(signature) = tauri::async_runtime::spawn_blocking(code_signature).await {
                tracing::info!(%signature, "launch_code_signature");
            }
        }

        let permissions = app.permissions();
        let mut statuses = Vec::new();
        for (name, permission) in [
            ("accessibility", Permission::Accessibility),
            ("microphone", Permission::Microphone),
            ("screen_recording", Permission::ScreenRecording),
        ] {
            let status = match permissions.check(permission).await {
                Ok(status) => format!("{status:?}"),
                Err(error) => format!("error({error})"),
            };
            statuses.push(format!("{name}={status}"));
        }
        tracing::info!(
            version = %app.package_info().version,
            permissions = %statuses.join(" "),
            "launch_permissions"
        );
    });
}

/// `codesign`'s own reading of the running bundle: ad-hoc or certificate,
/// team, cdhash and the designated requirement macOS keys grants on.
#[cfg(target_os = "macos")]
fn code_signature() -> String {
    const KEPT: [&str; 5] = [
        "Signature",
        "Authority=",
        "TeamIdentifier=",
        "CDHash=",
        "designated =>",
    ];

    let Some(bundle) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.ancestors().nth(3).map(std::path::Path::to_path_buf))
        .filter(|path| path.extension().is_some_and(|ext| ext == "app"))
    else {
        return "not running from an app bundle".to_string();
    };

    let mut fields = Vec::new();
    for args in [["-d", "--verbose=2"], ["-d", "-r-"]] {
        match std::process::Command::new("/usr/bin/codesign")
            .args(args)
            .arg(&bundle)
            .output()
        {
            // `-dv` reports on stderr, `-r-` prints the requirement on stdout.
            Ok(output) => fields.extend(
                String::from_utf8_lossy(&output.stderr)
                    .lines()
                    .chain(String::from_utf8_lossy(&output.stdout).lines())
                    .filter(|line| KEPT.iter().any(|kept| line.starts_with(*kept)))
                    .map(str::to_string)
                    .collect::<Vec<_>>(),
            ),
            Err(error) => fields.push(format!("codesign failed: {error}")),
        }
    }
    format!("{} | {}", bundle.display(), fields.join(" | "))
}
