//! Keeping the webview light. Most of the memory and CPU belongs to Discord's web app itself,
//! which runs in WebView2's processes (msedgewebview2.exe), not in AesDc.exe. What the client can
//! do is:
//!
//! - start WebView2 without browser features a chat client never uses (`browser_args`), and
//! - when the window is minimized or hidden to the tray, tell WebView2 the page is not visible
//!   (Chromium then throttles its timers and drawing) and ask it to trim memory (`set_background`).
//!   Both are undone as soon as the window comes back.
use tauri::WebviewWindow;

/// Chromium features turned off in every AesDc webview. The first three are wry's defaults
/// (passing our own arguments replaces them, so they are repeated here).
const DISABLED_FEATURES: &[&str] = &[
    "msWebOOUI",
    "msPdfOOUI",
    "msSmartScreenProtection",
    // A spare renderer process kept warm for the next page load. Discord is one page.
    "SpareRendererForSitePerProcess",
    // Looks for Chromecast and other cast devices on the local network.
    "MediaRouter",
    // The translate bar, and the hints service that downloads models for it.
    "Translate",
    "OptimizationHints",
    "OptimizationGuideModelDownloading",
];

/// Low memory mode (off by default): Discord's embeds (YouTube, Spotify, captchas...) share
/// one renderer process with Discord instead of getting a process each. Saves memory, at the
/// cost of the extra isolation between Discord and the sites it embeds.
const LOW_MEMORY_ARGS: &[&str] = &["--disable-site-isolation-trials", "--process-per-site"];

/// The WebView2 browser arguments. `extra` is the `extraBrowserArgs` setting, for trying flags
/// without a rebuild; its `--disable-features` and `--enable-features` lists are merged into
/// ours, because Chromium only reads the last copy of each.
pub fn browser_args(low_memory: bool, extra: &str) -> String {
    let mut disable: Vec<String> = DISABLED_FEATURES.iter().map(|s| s.to_string()).collect();
    let mut enable: Vec<String> = Vec::new();
    let mut rest: Vec<String> = Vec::new();
    if low_memory {
        rest.extend(LOW_MEMORY_ARGS.iter().map(|s| s.to_string()));
    }
    for arg in extra.split_whitespace() {
        let (list, value) = if let Some(v) = arg.strip_prefix("--disable-features=") {
            (&mut disable, v)
        } else if let Some(v) = arg.strip_prefix("--enable-features=") {
            (&mut enable, v)
        } else {
            if !rest.iter().any(|r| r == arg) {
                rest.push(arg.to_string());
            }
            continue;
        };
        for f in value.split(',').filter(|f| !f.is_empty()) {
            if !list.iter().any(|x| x == f) {
                list.push(f.to_string());
            }
        }
    }
    // A feature the user turns on wins over our list.
    disable.retain(|f| !enable.contains(f));

    let mut out = vec![format!("--disable-features={}", disable.join(","))];
    if !enable.is_empty() {
        out.push(format!("--enable-features={}", enable.join(",")));
    }
    out.extend(rest);
    out.join(" ")
}

/// Tells the webview whether the window is out of sight (minimized or hidden to the tray).
/// Windows only; WKWebView and WebKitGTK notice this by themselves.
pub fn set_background(window: &WebviewWindow, background: bool) {
    #[cfg(windows)]
    {
        let result = window.with_webview(move |wv| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
            };
            use windows_core::Interface;
            let controller = wv.controller();
            // Not visible: the page's visibilityState becomes "hidden", so Chromium throttles
            // its timers and stops drawing. Messages, notifications and calls keep working, as
            // in a background browser tab.
            if let Err(e) = controller.SetIsVisible(!background) {
                eprintln!("[AesDc] couldn't set the webview's visibility: {e}");
            }
            // WebView2 1.0.1774+: trims the page's memory while it is out of sight.
            let level = if background { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
            if let Ok(core) = controller.CoreWebView2() {
                if let Ok(core) = core.cast::<ICoreWebView2_19>() {
                    let _ = core.SetMemoryUsageTargetLevel(level);
                }
            }
        });
        if let Err(e) = result {
            eprintln!("[AesDc] couldn't reach the webview: {e}");
        }
    }
    #[cfg(not(windows))]
    let _ = (window, background);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_args_keep_wrys_defaults() {
        let args = browser_args(false, "");
        assert!(args.starts_with("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,"));
        assert!(!args.contains("site-isolation"));
        assert_eq!(args.matches("--disable-features").count(), 1);
    }

    #[test]
    fn extra_args_are_merged() {
        let args = browser_args(true, "--disable-features=Foo,MediaRouter --enable-features=Translate --disable-gpu --process-per-site");
        assert_eq!(args.matches("--disable-features").count(), 1);
        assert!(args.contains(",Foo"));
        assert!(!args.contains("Translate,") && args.contains("--enable-features=Translate"));
        assert!(args.contains("--disable-site-isolation-trials") && args.contains("--disable-gpu"));
        assert_eq!(args.matches("--process-per-site").count(), 1);
    }
}
