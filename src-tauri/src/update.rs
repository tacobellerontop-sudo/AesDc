//! Updates for the client and for the Corrode build it loads.
//!
//! Corrode: every build of Corrode's main branch is published as its `latest-main` release
//! (manifest.json + corrode.min.js). A newer one is downloaded into the config directory and
//! used instead of the build embedded in this binary, until a newer client replaces it.
//!
//! Client: this repo's `latest-main` release. On Windows the installer is downloaded and
//! started; elsewhere the release page opens in the browser.
use crate::{inject, store};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

const CORRODE_RELEASE: &str = "https://github.com/tacobellerontop-sudo/corrode/releases/download/latest-main";
const CLIENT_RELEASE_API: &str = "https://api.github.com/repos/tacobellerontop-sudo/AesDc/releases/tags/latest-main";
#[cfg(not(windows))]
pub const CLIENT_RELEASE_PAGE: &str = "https://github.com/tacobellerontop-sudo/AesDc/releases/tag/latest-main";
#[cfg(windows)]
const CLIENT_INSTALLER: &str = "https://github.com/tacobellerontop-sudo/AesDc/releases/download/latest-main/AesDc-setup-x64.exe";
/// Injector API versions this client implements (same list as build.rs).
const SUPPORTED_API: &[u32] = &[1];
const MAX_CORRODE_BYTES: usize = 20 * 1024 * 1024;
#[cfg(windows)]
const MAX_INSTALLER_BYTES: usize = 200 * 1024 * 1024;

/// Where Corrode builds are published. `AESDC_CORRODE_RELEASE` overrides it (used by the tests).
fn corrode_release() -> String {
    std::env::var("AESDC_CORRODE_RELEASE").unwrap_or_else(|_| CORRODE_RELEASE.to_string())
}
/// `AESDC_CLIENT_RELEASE_API` overrides it (used by the tests).
fn client_release_api() -> String {
    std::env::var("AESDC_CLIENT_RELEASE_API").unwrap_or_else(|_| CLIENT_RELEASE_API.to_string())
}

/// The commit this client was built from, and when (Unix seconds). Set by build.rs.
pub const CLIENT_COMMIT: &str = env!("AESDC_COMMIT");
pub fn client_built_at() -> u64 {
    env!("AESDC_BUILT_AT").parse().unwrap_or(0)
}

fn short(commit: &str) -> String {
    commit.chars().take(7).collect()
}

/// Same commit, whatever length each side abbreviates it to.
fn same_commit(a: &str, b: &str) -> bool {
    let n = a.len().min(b.len());
    n >= 7 && a[..n].eq_ignore_ascii_case(&b[..n])
}

/// Unix seconds from an ISO-8601 UTC timestamp like `2026-11-15T13:37:07Z` (fractions ignored).
pub fn parse_iso(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d, h, mi, sec) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    // Days since 1970-01-01 (Howard Hinnant's days_from_civil).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    u64::try_from(days * 86400 + h * 3600 + mi * 60 + sec).ok()
}

// ---- Which Corrode runs ----------------------------------------------------------------------

/// Written next to a downloaded Corrode build.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Downloaded {
    pub commit: String,
    pub version: String,
    /// When that build was made, Unix seconds.
    pub built_at: u64,
}

pub struct Corrode {
    pub code: String,
    /// When this build was made, Unix seconds (0 if unknown).
    pub built_at: u64,
}

fn code_file(dir: &Path) -> PathBuf {
    dir.join("corrode.min.js")
}
fn info_file(dir: &Path) -> PathBuf {
    dir.join("corrode.update.json")
}

/// Corrode's code. In order: a downloaded update that is newer than this client, a
/// `corrode.min.js` someone placed in the config directory by hand, the embedded build.
pub fn load_corrode(dir: &Path, client_built_at: u64, embedded: &str) -> Option<Corrode> {
    let embedded = Some(embedded).filter(|c| !c.trim().is_empty()).map(|c| Corrode { code: c.to_string(), built_at: client_built_at });
    let Ok(code) = std::fs::read_to_string(code_file(dir)) else { return embedded };
    match std::fs::read(info_file(dir)).ok().and_then(|b| serde_json::from_slice::<Downloaded>(&b).ok()) {
        // A downloaded update that this client's own build has since overtaken: drop it.
        Some(info) if info.built_at <= client_built_at && embedded.is_some() => {
            let _ = std::fs::remove_file(code_file(dir));
            let _ = std::fs::remove_file(info_file(dir));
            embedded
        }
        Some(info) => Some(Corrode { code, built_at: info.built_at }),
        None => {
            eprintln!("[AesDc] using Corrode from {}", code_file(dir).display());
            Some(Corrode { code, built_at: 0 })
        }
    }
}

/// `(version, commit)` from a bundle's banner: `/*! Corrode v0.1.0 (abc1234) | ... */`.
pub fn banner(code: &str) -> (Option<String>, Option<String>) {
    let Some(v) = inject::corrode_version(code) else { return (None, None) };
    let head = &code[..code.len().min(400)];
    let commit = head
        .split_once(&format!("Corrode v{v} ("))
        .and_then(|(_, rest)| rest.split_once(')'))
        .map(|(c, _)| c.to_string())
        .filter(|c| !c.is_empty() && c.chars().all(|ch| ch.is_ascii_alphanumeric()));
    (Some(v.to_string()), commit)
}

fn banner_api(code: &str) -> Option<u32> {
    let head = &code[..code.len().min(400)];
    head.split("injector api v").nth(1)?.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

// ---- Checking --------------------------------------------------------------------------------

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_commit: Option<String>,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Default, Debug)]
pub struct Info {
    pub client: Target,
    pub corrode: Target,
}

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
struct Manifest {
    version: String,
    commit: String,
    injector_api_version: u32,
    built_at: String,
    main: String,
    files: std::collections::HashMap<String, ManifestFile>,
}
#[derive(Deserialize, Default, Debug)]
#[serde(default)]
struct ManifestFile {
    sha256: String,
}

#[derive(Deserialize, Default, Debug)]
#[serde(default)]
struct Release {
    target_commitish: String,
    published_at: String,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(15))
        .user_agent(concat!("AesDc/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

async fn get(url: &str, max: usize) -> Result<Vec<u8>, String> {
    let res = client()?.get(url).send().await.map_err(|e| format!("Couldn't reach {url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {} from {url}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > max {
        return Err(format!("{url} is too large"));
    }
    Ok(bytes.to_vec())
}

async fn manifest() -> Result<Manifest, String> {
    let bytes = get(&format!("{}/manifest.json", corrode_release()), 1024 * 1024).await?;
    serde_json::from_slice(&bytes).map_err(|e| format!("Corrode's manifest is not valid: {e}"))
}

/// A published Corrode is an update when it is a different commit, built later than what runs
/// now, and speaks an injector API this client knows.
fn corrode_available(running_commit: Option<&str>, running_built_at: u64, m: &Manifest) -> bool {
    let newer = parse_iso(&m.built_at).is_some_and(|t| t > running_built_at);
    let different = running_commit.map_or(true, |c| !same_commit(c, &m.commit));
    different && newer && SUPPORTED_API.contains(&m.injector_api_version)
}

fn client_available(release: &Release) -> bool {
    !same_commit(CLIENT_COMMIT, &release.target_commitish) && parse_iso(&release.published_at).is_some_and(|t| t > client_built_at())
}

/// `running` is the Corrode this client would load now (even while it is switched off).
pub async fn check(running: Option<&Corrode>) -> Info {
    let mut info = Info::default();
    info.client.version = Some(env!("CARGO_PKG_VERSION").to_string());
    info.client.commit = Some(short(CLIENT_COMMIT));
    let (version, commit) = running.map(|c| banner(&c.code)).unwrap_or((None, None));
    info.corrode.version = version;
    info.corrode.commit = commit.clone();

    let m = manifest().await;
    let release = match get(&client_release_api(), 4 * 1024 * 1024).await {
        Ok(bytes) => serde_json::from_slice::<Release>(&bytes).map_err(|e| format!("Unexpected answer from GitHub: {e}")),
        Err(e) => Err(e),
    };
    match m {
        Ok(m) => {
            info.corrode.available = corrode_available(commit.as_deref(), running.map_or(0, |c| c.built_at), &m);
            info.corrode.latest_version = Some(m.version);
            info.corrode.latest_commit = Some(short(&m.commit));
        }
        Err(e) => info.corrode.error = Some(e),
    }
    match release {
        Ok(r) => {
            info.client.available = client_available(&r);
            info.client.latest_commit = Some(short(&r.target_commitish));
        }
        Err(e) => info.client.error = Some(e),
    }
    info
}

// ---- Updating --------------------------------------------------------------------------------

/// Checks a downloaded Corrode build against its manifest and this client.
fn verify(m: &Manifest, code: &[u8]) -> Result<Downloaded, String> {
    let expected = m.files.get(&m.main).map(|f| f.sha256.to_ascii_lowercase()).filter(|h| h.len() == 64).ok_or("Corrode's manifest has no checksum")?;
    let actual: String = Sha256::digest(code).iter().map(|b| format!("{b:02x}")).collect();
    if actual != expected {
        return Err("The downloaded Corrode doesn't match its checksum; try again in a minute".into());
    }
    let text = std::str::from_utf8(code).map_err(|_| "The downloaded Corrode is not text")?;
    match banner_api(text) {
        Some(v) if SUPPORTED_API.contains(&v) && SUPPORTED_API.contains(&m.injector_api_version) => {}
        Some(v) => return Err(format!("That Corrode needs injector API v{v}; update AesDc first")),
        None => return Err("The download is not a Corrode build".into()),
    }
    Ok(Downloaded { commit: m.commit.clone(), version: m.version.clone(), built_at: parse_iso(&m.built_at).ok_or("Corrode's manifest has no build time")? })
}

/// Downloads the latest Corrode into `dir`. It is used from the next start.
pub async fn update_corrode(dir: &Path) -> Result<Downloaded, String> {
    let m = manifest().await?;
    if m.main.is_empty() || m.main.contains(['/', '\\']) {
        return Err("Corrode's manifest is not valid".into());
    }
    let code = get(&format!("{}/{}", corrode_release(), m.main), MAX_CORRODE_BYTES).await?;
    let info = verify(&m, &code)?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // Remove the old description first: a half-finished update must never pair old code with
    // new details, and code without details is still a valid (hand-placed) build.
    let _ = std::fs::remove_file(info_file(dir));
    let tmp = dir.join("corrode.min.js.tmp");
    std::fs::write(&tmp, &code).and_then(|_| std::fs::rename(&tmp, code_file(dir))).map_err(|e| format!("Couldn't save Corrode: {e}"))?;
    store::save(&info_file(dir), &info).map_err(|e| format!("Couldn't save Corrode: {e}"))?;
    Ok(info)
}

/// Windows: downloads the installer and returns its path, for the caller to start.
#[cfg(windows)]
pub async fn download_installer() -> Result<PathBuf, String> {
    let bytes = get(CLIENT_INSTALLER, MAX_INSTALLER_BYTES).await?;
    if !bytes.starts_with(b"MZ") {
        return Err("The download is not an installer".into());
    }
    let dir = std::env::temp_dir().join("AesDc-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("AesDc-setup-x64.exe");
    std::fs::write(&file, &bytes).map_err(|e| format!("Couldn't save the installer: {e}"))?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_for(code: &[u8], built_at: &str, api: u32) -> Manifest {
        let sha: String = Sha256::digest(code).iter().map(|b| format!("{b:02x}")).collect();
        Manifest {
            version: "0.2.0".into(),
            commit: "bbbbbbb".into(),
            injector_api_version: api,
            built_at: built_at.into(),
            main: "corrode.min.js".into(),
            files: [("corrode.min.js".to_string(), ManifestFile { sha256: sha })].into(),
        }
    }
    const CODE: &str = "/*! Corrode v0.2.0 (bbbbbbb) | MIT | injector api v1 */\n(()=>{})();";

    #[test]
    fn parses_timestamps() {
        assert_eq!(parse_iso("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso("2026-11-15T13:37:07Z"), Some(1794749827));
        assert_eq!(parse_iso("2026-11-15T15:12:16.825Z"), Some(1794755536));
        assert_eq!(parse_iso("2024-02-29T00:00:00Z"), Some(1709164800));
        assert_eq!(parse_iso("yesterday"), None);
    }

    #[test]
    fn reads_the_banner() {
        assert_eq!(banner(CODE), (Some("0.2.0".into()), Some("bbbbbbb".into())));
        assert_eq!(banner("console.log(1)"), (None, None));
        assert_eq!(banner_api(CODE), Some(1));
    }

    #[test]
    fn offers_only_newer_different_compatible_builds() {
        let m = manifest_for(CODE.as_bytes(), "2026-11-15T13:37:07Z", 1);
        let t = 1794749827;
        assert!(corrode_available(Some("aaaaaaa"), t - 10, &m));
        assert!(corrode_available(None, 0, &m));
        assert!(!corrode_available(Some("bbbbbbb"), t - 10, &m), "same commit");
        assert!(!corrode_available(Some("bbbbbbbcccc"), t - 10, &m), "same commit, longer hash");
        assert!(!corrode_available(Some("aaaaaaa"), t + 10, &m), "what runs is newer");
        assert!(!corrode_available(Some("aaaaaaa"), t - 10, &manifest_for(CODE.as_bytes(), "2026-11-15T13:37:07Z", 2)), "unknown API");
    }

    #[test]
    fn verifies_downloads() {
        let m = manifest_for(CODE.as_bytes(), "2026-11-15T13:37:07Z", 1);
        assert_eq!(verify(&m, CODE.as_bytes()).unwrap(), Downloaded { commit: "bbbbbbb".into(), version: "0.2.0".into(), built_at: 1794749827 });
        assert!(verify(&m, b"tampered").unwrap_err().contains("checksum"));
        let v2 = "/*! Corrode v0.2.0 (bbbbbbb) | MIT | injector api v2 */";
        assert!(verify(&manifest_for(v2.as_bytes(), "2026-11-15T13:37:07Z", 2), v2.as_bytes()).unwrap_err().contains("update AesDc"));
        assert!(verify(&manifest_for(b"hello", "2026-11-15T13:37:07Z", 1), b"hello").unwrap_err().contains("not a Corrode build"));
    }

    #[test]
    fn picks_the_right_corrode() {
        let dir = std::env::temp_dir().join(format!("aesdc-update-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let embedded = "/*! Corrode v0.1.0 (aaaaaaa) | MIT | injector api v1 */";

        // Nothing downloaded: the embedded build, or nothing.
        assert_eq!(load_corrode(&dir, 100, embedded).unwrap().code, embedded);
        assert!(load_corrode(&dir, 100, "").is_none());

        // A downloaded update newer than the client wins.
        std::fs::write(code_file(&dir), CODE).unwrap();
        store::save(&info_file(&dir), &Downloaded { commit: "bbbbbbb".into(), version: "0.2.0".into(), built_at: 200 }).unwrap();
        let c = load_corrode(&dir, 100, embedded).unwrap();
        assert_eq!((c.code.as_str(), c.built_at), (CODE, 200));

        // A newer client replaces it and cleans up.
        assert_eq!(load_corrode(&dir, 300, embedded).unwrap().code, embedded);
        assert!(!code_file(&dir).exists() && !info_file(&dir).exists());

        // A build placed by hand (no details file) is always used.
        std::fs::write(code_file(&dir), CODE).unwrap();
        assert_eq!(load_corrode(&dir, 300, embedded).unwrap().code, CODE);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
