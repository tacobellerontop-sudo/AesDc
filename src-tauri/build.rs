// Embeds the Corrode bundle into the binary. Looks in $CORRODE_DIST, then ../corrode/dist next to
// this repo. Without one, the client still builds and runs Discord without the mod.
use std::{env, fs, path::PathBuf};

/// Injector API versions (docs/INJECTOR.md in the corrode repo) this client implements.
const SUPPORTED_API: &[u32] = &[1];

fn main() {
    println!("cargo:rerun-if-env-changed=CORRODE_DIST");
    println!("cargo:rerun-if-env-changed=AESDC_REQUIRE_CORRODE");
    let required = env::var("AESDC_REQUIRE_CORRODE").map_or(false, |v| v == "1");
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let candidates = env::var("CORRODE_DIST")
        .map(|d| vec![PathBuf::from(d)])
        .unwrap_or_else(|_| vec![manifest_dir.join("../../corrode/dist")]);

    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("corrode.min.js");
    let mut found = None;
    for dir in candidates {
        let file = dir.join("corrode.min.js");
        println!("cargo:rerun-if-changed={}", file.display());
        if let Ok(code) = fs::read_to_string(&file) {
            found = Some((file, code));
            break;
        }
    }

    match found {
        Some((file, code)) => {
            let api = code
                .get(..400)
                .unwrap_or(&code)
                .split("injector api v")
                .nth(1)
                .and_then(|s| s.split(|c: char| !c.is_ascii_digit()).next())
                .and_then(|n| n.parse::<u32>().ok());
            match api {
                Some(v) if SUPPORTED_API.contains(&v) => {}
                Some(v) => panic!("{} uses Corrode injector API v{v}; this client supports {SUPPORTED_API:?}", file.display()),
                None => panic!("{} has no Corrode banner; is it a Corrode build?", file.display()),
            }
            println!("cargo:warning=Embedding Corrode from {}", file.display());
            fs::write(&out, code).unwrap();
        }
        None if required || env::var("CORRODE_DIST").is_ok() => panic!(
            "No corrode.min.js found (CORRODE_DIST={:?}). Build Corrode first or unset CORRODE_DIST.",
            env::var("CORRODE_DIST").ok()
        ),
        None => {
            println!("cargo:warning=No Corrode build found (set CORRODE_DIST); the client will run Discord without Corrode");
            fs::write(&out, "").unwrap();
        }
    }

    // What this build is, for update checks: its commit and when it was made.
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    let commit = env::var("GITHUB_SHA").ok().filter(|s| !s.is_empty()).or_else(|| {
        let out = std::process::Command::new("git").args(["rev-parse", "HEAD"]).current_dir(&manifest_dir).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    });
    println!("cargo:rustc-env=AESDC_COMMIT={}", commit.unwrap_or_else(|| "unknown".into()));
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    println!("cargo:rustc-env=AESDC_BUILT_AT={now}");

    // Declare the app's commands so capabilities can grant them to Discord's (remote) pages.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("tauri build step failed");
}

/// Keep in sync with `generate_handler!` in src/lib.rs and capabilities/discord.json.
const COMMANDS: &[&str] = &["storage_set", "storage_delete", "fetch_text", "relaunch", "open_devtools", "disable_corrode", "open_external", "update_check", "update_corrode", "update_client", "themes_list", "themes_read", "themes_write", "themes_delete", "themes_open_folder", "themes_media_write", "themes_media_read", "window_control"];
