//! AesDc: a lightweight Discord client. Discord's web app runs in the operating system's own
//! webview (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux) and Corrode is injected
//! into it before Discord's scripts run.
mod inject;
mod perf;
mod store;
mod themes;
mod update;

use std::{path::PathBuf, sync::Mutex, time::Duration};
use store::{CorrodeStore, Settings};
use tauri::{
    ipc::CapabilityBuilder,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

const MAIN: &str = "main";
/// What Discord's page may call (same list as capabilities/discord.json).
const BRIDGE_PERMISSIONS: &[&str] = &[
    "core:default",
    "allow-storage-set",
    "allow-storage-delete",
    "allow-fetch-text",
    "allow-relaunch",
    "allow-open-devtools",
    "allow-disable-corrode",
    "allow-open-external",
    "allow-update-check",
    "allow-update-corrode",
    "allow-update-client",
    "allow-window-control",
    "allow-themes-list",
    "allow-themes-read",
    "allow-themes-write",
    "allow-themes-delete",
    "allow-themes-open-folder",
    "allow-themes-media-write",
    "allow-themes-media-read",
];
const MAX_FETCH_BYTES: usize = 20 * 1024 * 1024;

struct AppState {
    dir: PathBuf,
    settings: Mutex<Settings>,
    corrode_store: Mutex<CorrodeStore>,
    tray: Mutex<bool>,
    /// Whether the webview was last told it is out of sight (see perf.rs).
    background: Mutex<bool>,
}

impl AppState {
    fn settings_file(&self) -> PathBuf {
        self.dir.join("settings.json")
    }
    fn storage_file(&self) -> PathBuf {
        self.dir.join("corrode-storage.json")
    }
    fn save_settings(&self, s: &Settings) -> Result<(), String> {
        store::save(&self.settings_file(), s).map_err(|e| e.to_string())
    }
    fn save_storage(&self, s: &CorrodeStore) -> Result<(), String> {
        store::save(&self.storage_file(), s).map_err(|e| e.to_string())
    }
}

// ---- Commands behind the CorrodeNative bridge ------------------------------------------------

#[tauri::command]
fn storage_set(state: tauri::State<AppState>, key: String, value: String, rev: u64) -> Result<(), String> {
    let mut s = state.corrode_store.lock().unwrap();
    s.set(key, value, rev);
    state.save_storage(&s)
}

#[tauri::command]
fn storage_delete(state: tauri::State<AppState>, key: String, rev: u64) -> Result<(), String> {
    let mut s = state.corrode_store.lock().unwrap();
    s.delete(&key, rev);
    state.save_storage(&s)
}

/// Fetch text for Corrode's remote plugins and themes, outside Discord's CORS and CSP.
#[tauri::command]
async fn fetch_text(url: String) -> Result<String, String> {
    let parsed = Url::parse(&url).map_err(|e| format!("Invalid URL {url}: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("Only http(s) URLs can be fetched, not {}", parsed.scheme()));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("AesDc/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(parsed).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {} fetching {url}", res.status()));
    }
    if res.content_length().unwrap_or(0) as usize > MAX_FETCH_BYTES {
        return Err(format!("{url} is too large"));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_FETCH_BYTES {
        return Err(format!("{url} is too large"));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
fn relaunch(app: AppHandle) {
    app.restart();
}

#[tauri::command]
fn open_devtools(window: WebviewWindow) {
    window.open_devtools();
}

/// Corrode's "Uninstall Corrode" button: turn Corrode off and restart into plain Discord.
#[tauri::command]
fn disable_corrode(app: AppHandle) -> Result<(), String> {
    set_corrode_enabled(&app, false)
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err(format!("Refusing to open {} links", parsed.scheme()));
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| e.to_string())
}

// ---- Updates (see update.rs) -------------------------------------------------------------------

#[tauri::command]
async fn update_check(state: tauri::State<'_, AppState>) -> Result<update::Info, String> {
    let running = corrode_code(&state.dir);
    Ok(update::check(running.as_ref()).await)
}

/// Downloads the latest Corrode. The page restarts the client afterwards to load it.
#[tauri::command]
async fn update_corrode(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let info = update::update_corrode(&state.dir).await?;
    eprintln!("[AesDc] downloaded Corrode {} ({})", info.version, info.commit);
    Ok(())
}

/// Windows: downloads the installer, starts it and quits so it can replace this program.
/// Elsewhere: opens the download page.
#[tauri::command]
async fn update_client(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let installer = update::download_installer().await?;
        std::process::Command::new(&installer).spawn().map_err(|e| format!("Couldn't start the installer: {e}"))?;
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        app.opener().open_url(update::CLIENT_RELEASE_PAGE, None::<&str>).map_err(|e| e.to_string())
    }
}

// ---- Custom titlebar (see injection/titlebar.js) ----------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowState {
    maximized: bool,
    fullscreen: bool,
    focused: bool,
    decorated: bool,
}

/// The titlebar's buttons and dragging. `close` goes through the normal close request, so
/// close-to-tray still applies.
#[tauri::command]
fn window_control(window: WebviewWindow, action: String) -> Result<WindowState, String> {
    let r = match action.as_str() {
        "minimize" => window.minimize(),
        "toggleMaximize" => match window.is_maximized() {
            Ok(true) => window.unmaximize(),
            _ => window.maximize(),
        },
        "close" => window.close(),
        "startDrag" => window.start_dragging(),
        "state" => Ok(()),
        other => return Err(format!("Unknown window action {other}")),
    };
    r.map_err(|e| e.to_string())?;
    Ok(WindowState {
        maximized: window.is_maximized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
        focused: window.is_focused().unwrap_or(true),
        decorated: window.is_decorated().unwrap_or(true),
    })
}

// ---- Themes folder (see themes.rs) -----------------------------------------------------------

#[tauri::command]
fn themes_list(state: tauri::State<AppState>) -> Result<themes::Listing, String> {
    themes::list(&state.dir)
}

#[tauri::command]
fn themes_read(state: tauri::State<AppState>, file: String) -> Result<String, String> {
    themes::read(&state.dir, &file)
}

#[tauri::command]
fn themes_write(state: tauri::State<AppState>, file: String, css: String) -> Result<(), String> {
    themes::write(&state.dir, &file, &css)
}

#[tauri::command]
fn themes_delete(state: tauri::State<AppState>, file: String) -> Result<(), String> {
    themes::delete(&state.dir, &file)
}

#[tauri::command]
fn themes_open_folder(app: AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    let dir = themes::dir(&state.dir)?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Saves a background picture or video, sent as base64 chunks: each call appends `data` at
/// `offset` to upload `upload`; the call with `last` saves it as `name` and returns its path in
/// the themes folder (`media/<name>`).
#[tauri::command]
async fn themes_media_write(state: tauri::State<'_, AppState>, upload: String, name: String, data: String, offset: u64, last: bool) -> Result<Option<String>, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| format!("Bad file data: {e}"))?;
    themes::upload_append(&state.dir, &upload, offset, &bytes)?;
    if last {
        themes::upload_finish(&state.dir, &upload, &name).map(Some)
    } else {
        Ok(None)
    }
}

#[derive(serde::Serialize)]
struct MediaChunk {
    data: String,
    size: u64,
}

/// Reads part of a background picture or video, as base64.
#[tauri::command]
async fn themes_media_read(state: tauri::State<'_, AppState>, path: String, offset: u64, length: u64) -> Result<MediaChunk, String> {
    use base64::Engine;
    let (bytes, size) = themes::read_media_chunk(&state.dir, &path, offset, length)?;
    Ok(MediaChunk { data: base64::engine::general_purpose::STANDARD.encode(bytes), size })
}

// ---- Window, tray, settings ------------------------------------------------------------------

fn set_corrode_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    change_settings_and_restart(app, |s| s.corrode_enabled = enabled)
}

fn change_settings_and_restart(app: &AppHandle, change: impl FnOnce(&mut Settings)) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut s = state.settings.lock().unwrap().clone();
    change(&mut s);
    state.save_settings(&s)?;
    app.restart();
}

/// The Corrode build to load: a downloaded update, a hand-placed file or the embedded build.
fn corrode_code(dir: &PathBuf) -> Option<update::Corrode> {
    update::load_corrode(dir, update::client_built_at(), inject::EMBEDDED_CORRODE)
}

/// The Discord URL to load. `AESDC_DISCORD_URL` overrides the setting (used by the tests).
fn discord_url(settings: &Settings) -> Url {
    std::env::var("AESDC_DISCORD_URL")
        .ok()
        .and_then(|u| Url::parse(&u).ok())
        .or_else(|| Url::parse(&settings.discord_url).ok())
        .unwrap_or_else(|| Url::parse("https://discord.com/app").unwrap())
}

fn host_of(url: &Url) -> String {
    match (url.host_str(), url.port()) {
        (Some(h), Some(p)) => format!("{h}:{p}"),
        (Some(h), None) => h.to_string(),
        _ => String::new(),
    }
}

fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();
    let url = discord_url(&settings);

    let mut hosts: Vec<String> = inject::DISCORD_HOSTS.iter().map(|h| h.to_string()).collect();
    let host = host_of(&url);
    if !hosts.contains(&host) {
        // A non-Discord URL (a test page, a self-hosted instance): allow the bridge there too.
        let origin = url.origin().ascii_serialization();
        let mut cap = CapabilityBuilder::new("custom-origin").remote(format!("{origin}/*")).window(MAIN);
        for p in BRIDGE_PERMISSIONS {
            cap = cap.permission(*p);
        }
        app.add_capability(cap)?;
        hosts.push(host);
    }

    let corrode = if settings.corrode_enabled { corrode_code(&state.dir).map(|c| c.code) } else { None };
    match corrode.as_deref() {
        Some(code) => eprintln!("[AesDc] Corrode {} enabled", inject::corrode_version(code).unwrap_or("(unknown version)")),
        None if settings.corrode_enabled => eprintln!("[AesDc] this build has no Corrode; running plain Discord"),
        None => eprintln!("[AesDc] Corrode is turned off; running plain Discord"),
    }
    let script = {
        let storage = state.corrode_store.lock().unwrap();
        inject::script(&inject::Inject {
            hosts,
            version: env!("CARGO_PKG_VERSION"),
            corrode: corrode.as_deref(),
            storage: &storage,
            titlebar: settings.custom_titlebar.then_some(inject::TITLEBAR_STYLE),
        })
    };

    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
        .title("AesDc")
        .inner_size(1280.0, 800.0)
        .min_inner_size(940.0, 500.0)
        .initialization_script(&script)
        .additional_browser_args(&perf::browser_args(settings.low_memory_mode, &settings.extra_browser_args));
    build_frame(builder, settings.custom_titlebar).build()
}

/// The custom titlebar: on Windows and Linux the window has no system frame and the page draws
/// the controls into Discord's own top bar. On macOS the window keeps its traffic lights, which
/// float over the page (like the official app) instead of sitting in a separate title bar.
fn build_frame<'a, R: tauri::Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    custom: bool,
) -> WebviewWindowBuilder<'a, R, M> {
    if !custom {
        return builder;
    }
    #[cfg(target_os = "macos")]
    {
        builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(14.0, 18.0))
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder.decorations(false).shadow(true)
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        sync_background(app);
    }
}

/// Puts the webview in or out of its background state (see perf.rs) to match the window:
/// in the background while minimized or hidden to the tray.
fn sync_background(app: &AppHandle) {
    let Some(w) = app.get_webview_window(MAIN) else { return };
    let background = !w.is_visible().unwrap_or(true) || w.is_minimized().unwrap_or(false);
    let state = app.state::<AppState>();
    let mut last = state.background.lock().unwrap();
    if *last != background {
        *last = background;
        perf::set_background(&w, background);
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let enabled = app.state::<AppState>().settings.lock().unwrap().corrode_enabled;
    let show = MenuItem::with_id(app, "show", "Show AesDc", true, None::<&str>)?;
    let reload = MenuItem::with_id(app, "reload", "Reload", true, None::<&str>)?;
    let corrode = CheckMenuItem::with_id(app, "corrode", "Load Corrode", true, enabled, None::<&str>)?;
    let custom_titlebar = app.state::<AppState>().settings.lock().unwrap().custom_titlebar;
    let titlebar = CheckMenuItem::with_id(app, "titlebar", "Custom titlebar", true, custom_titlebar, None::<&str>)?;
    let low_memory_mode = app.state::<AppState>().settings.lock().unwrap().low_memory_mode;
    let low_memory = CheckMenuItem::with_id(app, "lowmemory", "Low memory mode (next launch)", true, low_memory_mode, None::<&str>)?;
    let devtools = MenuItem::with_id(app, "devtools", "Open DevTools", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit AesDc", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &reload, &corrode, &titlebar, &low_memory, &devtools, &sep, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("AesDc")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "reload" => {
                if let Some(w) = app.get_webview_window(MAIN) {
                    let _ = w.eval("location.reload()");
                }
            }
            "corrode" => {
                let now = app.state::<AppState>().settings.lock().unwrap().corrode_enabled;
                if let Err(e) = set_corrode_enabled(app, !now) {
                    eprintln!("[AesDc] could not save settings: {e}");
                }
            }
            "titlebar" => {
                if let Err(e) = change_settings_and_restart(app, |s| s.custom_titlebar = !s.custom_titlebar) {
                    eprintln!("[AesDc] could not save settings: {e}");
                }
            }
            // Saved only. WebView2's arguments can't change while its processes are still
            // running, and they can outlive a quick restart, so this applies at the next launch.
            "lowmemory" => {
                let state = app.state::<AppState>();
                let mut s = state.settings.lock().unwrap();
                s.low_memory_mode = !s.low_memory_mode;
                if let Err(e) = state.save_settings(&s) {
                    eprintln!("[AesDc] could not save settings: {e}");
                }
            }
            "devtools" => {
                if let Some(w) = app.get_webview_window(MAIN) {
                    w.open_devtools();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        // A second launch focuses the running client instead of opening another one.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            storage_set,
            storage_delete,
            fetch_text,
            relaunch,
            open_devtools,
            disable_corrode,
            open_external,
            update_check,
            update_corrode,
            update_client,
            window_control,
            themes_list,
            themes_read,
            themes_write,
            themes_delete,
            themes_open_folder,
            themes_media_write,
            themes_media_read
        ])
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let settings: Settings = store::load(&dir.join("settings.json"));
            let corrode_store: CorrodeStore = store::load(&dir.join("corrode-storage.json"));
            app.manage(AppState { dir, settings: Mutex::new(settings), corrode_store: Mutex::new(corrode_store), tray: Mutex::new(false), background: Mutex::new(false) });

            let handle = app.handle().clone();
            match build_tray(&handle) {
                Ok(()) => *app.state::<AppState>().tray.lock().unwrap() = true,
                // No tray on this desktop (e.g. no AppIndicator support): closing quits instead.
                Err(e) => eprintln!("[AesDc] no tray icon: {e}"),
            }
            create_main_window(&handle)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let state = window.state::<AppState>();
                let to_tray = state.settings.lock().unwrap().close_to_tray && *state.tray.lock().unwrap();
                if to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                    sync_background(window.app_handle());
                }
            }
            // Minimizing and restoring arrive as a resize; focus covers the rest.
            WindowEvent::Resized(_) | WindowEvent::Focused(_) => sync_background(window.app_handle()),
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running AesDc");
}
