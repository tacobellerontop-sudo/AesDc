//! Builds the script the webview runs in Discord's page before Discord's own scripts: the
//! CorrodeNative bridge (injection/bridge.js), then Corrode itself.
use crate::store::CorrodeStore;
use serde_json::json;

const BRIDGE: &str = include_str!("../injection/bridge.js");
const TITLEBAR: &str = include_str!("../injection/titlebar.js");

/// How the page should draw the custom titlebar on this OS: "controls" (minimize, maximize and
/// close buttons, Windows and Linux) or "mac" (room for the floating traffic lights).
pub const TITLEBAR_STYLE: &str = if cfg!(target_os = "macos") { "mac" } else { "controls" };
/// Corrode embedded at build time (see build.rs). Empty when the build had no Corrode.
pub const EMBEDDED_CORRODE: &str = include_str!(concat!(env!("OUT_DIR"), "/corrode.min.js"));

/// Discord's web app hosts. The bridge and Corrode only run on these (plus a test host if set).
pub const DISCORD_HOSTS: &[&str] = &["discord.com", "ptb.discord.com", "canary.discord.com"];

pub struct Inject<'a> {
    pub hosts: Vec<String>,
    pub version: &'a str,
    /// Corrode's code, or None to run plain Discord.
    pub corrode: Option<&'a str>,
    pub storage: &'a CorrodeStore,
    /// The custom titlebar's style, or None to keep the system title bar.
    pub titlebar: Option<&'a str>,
}

pub fn script(cfg: &Inject) -> String {
    let config = json!({
        "hosts": cfg.hosts,
        "version": cfg.version,
        "corrode": cfg.corrode.is_some(),
        "storage": cfg.storage,
    });
    let mut out = BRIDGE.replacen("const cfg = __AESDC_CONFIG__;", &format!("const cfg = {config};"), 1);
    if let Some(style) = cfg.titlebar {
        out.push('\n');
        out.push_str(&TITLEBAR.replacen("const style = __AESDC_TITLEBAR__;", &format!("const style = {};", json!(style)), 1));
    }
    if let Some(code) = cfg.corrode.filter(|c| !c.trim().is_empty()) {
        // Part 2: Corrode, only where the bridge set itself up (a Discord page).
        out.push_str("\nif (window.CorrodeNative && window.CorrodeNative.name === \"AesDc\") {\n");
        out.push_str(code);
        out.push_str("\n}\n");
    }
    out.push_str("//# sourceURL=aesdc-inject.js\n");
    out
}

/// The Corrode version from a bundle's banner: `/*! Corrode v0.1.0 (abc1234) | ... */`.
pub fn corrode_version(code: &str) -> Option<&str> {
    let rest = code.get(..code.len().min(400))?.split("Corrode v").nth(1)?;
    rest.split_whitespace().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_embeds_config_and_corrode() {
        let mut storage = CorrodeStore::default();
        storage.set("corrode:x".into(), "</script>\"'".into(), 2);
        let s = script(&Inject {
            hosts: vec!["discord.com".into()],
            version: "1.2.3",
            corrode: Some("/*! Corrode v0.1.0 (abc) | MIT | injector api v1 */ window.__c = 1;"),
            storage: &storage,
            titlebar: Some("controls"),
        });
        assert!(!s.contains("__AESDC_CONFIG__"));
        assert!(s.contains(r#""hosts":["discord.com"]"#));
        assert!(s.contains(r#""rev":2"#));
        assert!(s.contains("window.__c = 1;"));
        assert!(s.find("CorrodeNative\", {").unwrap() < s.find("window.__c").unwrap(), "bridge must come before Corrode");
        assert!(s.contains(r#"const style = "controls";"#));
        assert!(!s.contains("__AESDC_TITLEBAR__"));
    }

    #[test]
    fn plain_discord_without_corrode() {
        let s = script(&Inject { hosts: vec![], version: "1", corrode: None, storage: &CorrodeStore::default(), titlebar: None });
        assert!(s.contains(r#""corrode":false"#));
        assert!(!s.contains("aesdc-winctl"), "no titlebar when it is turned off");
        assert!(!s.contains("if (window.CorrodeNative && window.CorrodeNative.name"));
    }

    #[test]
    fn reads_banner_version() {
        assert_eq!(corrode_version("/*! Corrode v0.1.0 (a7e3b28) | MIT | injector api v1 */"), Some("0.1.0"));
        assert_eq!(corrode_version("nope"), None);
    }
}
