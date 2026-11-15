# AesDc

AesDc is a lightweight Discord client with the [Corrode](https://github.com/tacobellerontop-sudo/corrode)
mod built in. It works like Dorion: Discord's web app runs in the webview your operating system
already has, and AesDc injects Corrode into the page. There's no bundled Chromium, so the app is
about 8 MB (a 3 MB download) instead of the ~100 MB of an Electron client like Vesktop. The Linux
AppImage is the exception at ~80 MB, because it carries its own WebKitGTK.

| OS | Webview |
| --- | --- |
| Windows 10/11 | WebView2 (Edge), already installed on almost every PC; the installer fetches it if not |
| macOS | WKWebView (Safari) |
| Linux | WebKitGTK |

## Download

Every push to `main` (or a manual run of the Build workflow) publishes builds on the
[**latest-main** release](https://github.com/tacobellerontop-sudo/AesDc/releases/tag/latest-main):

- **Windows:** `AesDc-setup-x64.exe` (installer), `AesDc-x64.msi`, or `AesDc-portable-x64.exe` (no install).
- **macOS:** `AesDc-macos-arm64.dmg`. It isn't notarized, so right-click the app and choose **Open** the first time.
- **Linux:** `.AppImage`, `.deb` or `.rpm`.

Builds aren't code-signed yet, so Windows SmartScreen will warn: click **More info > Run anyway**.
Tagging `v*` publishes a versioned release.

## Features

- Discord in its own window, with your login kept between launches.
- Corrode loads before Discord's own scripts ("early" mode), so plugin patches reach every module.
- Tray icon: show, reload, turn Corrode on or off, open DevTools, quit. On Windows, closing the
  window hides it to the tray.
- Opening the app a second time focuses the running window.
- Links to other sites open in your normal browser.

## How the injector works

The window loads `https://discord.com/app` and registers one webview initialization script, which
the webview runs in the page before any of Discord's scripts. It has two parts:

1. [`injection/bridge.js`](src-tauri/injection/bridge.js) sets up `window.CorrodeNative`, the
   bridge from Corrode's [`docs/INJECTOR.md`](https://github.com/tacobellerontop-sudo/corrode/blob/main/docs/INJECTOR.md)
   (injector API v1). It also sends external links to the browser.
2. Corrode itself (`corrode.min.js`), which is built into the binary.

The bridge calls into the Rust side (`src-tauri/src/lib.rs`):

| `CorrodeNative` | What it does |
| --- | --- |
| `storage` | Corrode's settings, saved to `corrode-storage.json` in the app's config folder. Reads are synchronous from an in-page copy, and every change is written through to the file. |
| `fetchText` | Downloads remote plugins and themes from the Rust side (http and https only), so Discord's CSP and CORS don't block them. |
| `relaunch` | Restarts the client. |
| `openDevTools` | Opens the webview's DevTools. |
| `eject` | Corrode's **Uninstall Corrode** button. It turns Corrode off and restarts into plain Discord. Turn it back on from the tray. |

Only Discord's own pages (`discord.com`, `ptb.discord.com`, `canary.discord.com`) get the bridge
(see [`capabilities/discord.json`](src-tauri/capabilities/discord.json)).

## Settings

The client's settings live in `settings.json` in the app config folder
(`%APPDATA%\dev.aesdc.client`, `~/Library/Application Support/dev.aesdc.client` or
`~/.config/dev.aesdc.client`):

```json
{
  "corrodeEnabled": true,
  "closeToTray": true,
  "discordUrl": "https://discord.com/app"
}
```

Set `discordUrl` to `https://canary.discord.com/app` or `https://ptb.discord.com/app` for Canary
or PTB. To try a different Corrode build without rebuilding the client, put a `corrode.min.js` in
the same folder. It is loaded instead of the built-in one.

## Building

You need [Rust](https://rustup.rs), Node.js 18+, and on Linux the WebKitGTK headers
(`libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`).

```sh
# Build Corrode next to this repo (or set CORRODE_DIST to its dist/ folder)
git clone https://github.com/tacobellerontop-sudo/corrode ../corrode
(cd ../corrode && npm ci && npm run build)

npm install
npm run dev      # run the client
npm run build    # installers in src-tauri/target/release/bundle/
```

Without a Corrode build, the client still builds and runs plain Discord.

## Tests

```sh
cargo test --manifest-path src-tauri/Cargo.toml   # unit tests
cargo build --manifest-path src-tauri/Cargo.toml
xvfb-run -a node test/e2e.js                      # drop xvfb-run on a desktop
```

The end-to-end test starts the real client pointed at a fake Discord page on `127.0.0.1`
(`AESDC_DISCORD_URL`). From inside the page it checks that Corrode ran before the page's first
script, that storage, `fetchText` and link handling work, and that settings reach the file. It
then presses "Uninstall Corrode" and checks that the client restarts without Corrode and keeps
its settings.
