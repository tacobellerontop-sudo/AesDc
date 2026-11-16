//! The client's settings and Corrode's settings, each a small JSON file in the app config folder.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
};

/// The client's own settings (`settings.json`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Load Corrode into Discord. Corrode's "Uninstall Corrode" button turns this off.
    pub corrode_enabled: bool,
    /// Closing the window hides it to the tray instead of quitting.
    pub close_to_tray: bool,
    /// The Discord web app to load: Stable, PTB or Canary.
    pub discord_url: String,
    /// Replace the system title bar with window controls drawn in Discord's own top bar.
    pub custom_titlebar: bool,
    /// Smaller caches and a size-tuned JavaScript engine (see perf.rs). Read at launch.
    pub memory_saver: bool,
    /// Folds WebView2's helper processes together (see perf.rs). Read at launch.
    pub low_memory_mode: bool,
    /// Extra WebView2 browser arguments (Windows), for trying flags without a rebuild.
    pub extra_browser_args: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            corrode_enabled: true,
            close_to_tray: cfg!(windows),
            discord_url: "https://discord.com/app".into(),
            custom_titlebar: true,
            memory_saver: true,
            low_memory_mode: false,
            extra_browser_args: String::new(),
        }
    }
}

/// Corrode's key/value settings (`corrode-storage.json`), with a revision number that goes up on
/// every change so the page can tell which of its two copies is newer.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct CorrodeStore {
    pub rev: u64,
    pub data: BTreeMap<String, String>,
}

impl CorrodeStore {
    pub fn set(&mut self, key: String, value: String, rev: u64) {
        self.data.insert(key, value);
        self.rev = self.rev.max(rev);
    }

    pub fn delete(&mut self, key: &str, rev: u64) {
        self.data.remove(key);
        self.rev = self.rev.max(rev);
    }
}

/// Read a JSON file, falling back to the default if it is missing or unreadable.
pub fn load<T: DeserializeOwned + Default>(path: &Path) -> T {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Write a JSON file atomically (temp file + rename) so a crash never leaves half a file.
pub fn save<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp: PathBuf = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_revisions() {
        let dir = std::env::temp_dir().join(format!("aesdc-store-{}", std::process::id()));
        let file = dir.join("corrode-storage.json");
        let mut s: CorrodeStore = load(&file);
        assert_eq!(s, CorrodeStore::default());
        s.set("corrode:a".into(), "1".into(), 5);
        s.set("corrode:b".into(), "2".into(), 3); // an older revision never moves rev back
        assert_eq!(s.rev, 5);
        s.delete("corrode:a", 6);
        save(&file, &s).unwrap();
        let back: CorrodeStore = load(&file);
        assert_eq!(back, s);
        assert_eq!(back.data.get("corrode:b").map(String::as_str), Some("2"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn settings_tolerate_missing_and_partial_files() {
        let parsed: Settings = serde_json::from_str(r#"{"corrodeEnabled": false}"#).unwrap();
        assert!(!parsed.corrode_enabled);
        assert_eq!(parsed.discord_url, "https://discord.com/app");
        let missing: Settings = load(Path::new("/nonexistent/aesdc/settings.json"));
        assert_eq!(missing, Settings::default());
    }
}
