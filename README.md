# AesDc

AesDc is the client and injector for [Corrode](https://github.com/tacobellerontop-sudo/corrode). It
patches the Discord desktop app so Corrode loads before Discord's own code. It also has a built-in
ejector that puts the original Discord back.

It works with Discord Stable, PTB, Canary and Development on Windows, macOS and Linux, including
the Flatpak. It needs Node.js 18 or newer and has no runtime dependencies.

## Download

Every push to `main` builds `aesdc-windows-x64.exe` (plus Linux and macOS binaries) and publishes
them on the [**latest-main** release](https://github.com/tacobellerontop-sudo/AesDc/releases/tag/latest-main).
Tagging `v*` publishes a versioned release. Double-click the `.exe` to get the menu, or run it from
a terminal with the commands below. It doesn't need Node.js. Windows SmartScreen will warn about it
because it isn't code-signed: click **More info > Run anyway**.

The executable includes the Corrode build from Corrode's `main` branch when there is one. To bundle
another branch, run the **Build executables** workflow manually and set `corrode_ref`.

## Usage from source

```sh
git clone https://github.com/tacobellerontop-sudo/AesDc && cd AesDc
node bin/aesdc.js            # interactive menu
node bin/aesdc.js gui        # installer page in your browser
```

Or use the commands directly:

| Command | What it does |
| --- | --- |
| `aesdc status` | Lists the Discord installs it found and whether Corrode is installed in each. |
| `aesdc install [stable\|ptb\|canary\|all]` | Downloads Corrode and patches Discord. |
| `aesdc uninstall [target]` | The ejector: restores the original Discord. Add `--purge` to also delete Corrode's settings. |
| `aesdc repair` | Re-applies the patch after a Discord update removed it. |
| `aesdc update` | Downloads the latest Corrode. Restart Discord afterwards. |

Useful options:

- `--corrode <src>` picks the Corrode build. It takes a `corrode/dist` folder, a `corrode.min.js`
  file, or a `manifest.json` URL. The default is the latest GitHub release of Corrode. Until Corrode
  has a release, build it (`npm run build` in the corrode repo) and pass `--corrode ../corrode/dist`.
- `--path <dir>` uses a Discord install in a place AesDc doesn't search.
- `--no-restart` leaves Discord running. Normally AesDc closes Discord, patches it and starts it again.

Corrode's own **Settings > About > Uninstall Corrode** button runs the same ejector from inside
Discord and then restarts it.

## How it works

```
resources/app.asar  ->  resources/_app.asar   Discord's original app, never modified
                        resources/app/        small shim written by AesDc
```

Electron loads `resources/app/` before `app.asar`. The shim starts the AesDc runtime, then boots
`_app.asar` exactly as Electron would have. The runtime hooks Discord's main window so that AesDc's
preload runs first. That preload exposes `window.CorrodeNative` and evaluates Corrode in the page
before Discord's scripts run (Corrode's "early" mode), then runs Discord's own preload. This
follows the contract in Corrode's [`docs/INJECTOR.md`](https://github.com/tacobellerontop-sudo/corrode/blob/main/docs/INJECTOR.md)
(injector API v1).

The bridge gives Corrode:

| `CorrodeNative` | Backed by |
| --- | --- |
| `storage` | A JSON file per Discord flavor in the data folder, so settings survive Discord logouts. |
| `fetchText` | The main process (http and https only), so remote plugins and themes skip CORS and CSP. |
| `relaunch`, `openDevTools` | Electron. |
| `eject` | The built-in ejector, followed by a restart. |

Ejecting moves `_app.asar` back to `app.asar` and deletes `resources/app/`, so Discord is byte for
byte what it was. If Discord replaced `app.asar` itself in the meantime, the newer file is kept.
AesDc never touches a `resources/app/` folder it didn't create, such as one from another client mod.

Files on disk, in the data folder (`%APPDATA%\AesDc`, `~/Library/Application Support/AesDc` or
`~/.config/AesDc`):

```
host/       the runtime Discord loads (refreshed by install, repair and update)
corrode/    corrode.min.js and its manifest.json
storage/    Corrode's settings, one file per Discord flavor
installs.json
```

Corrode downloads are checked against the injector API version AesDc supports and the sha256 in
Corrode's `manifest.json`.

## Platform notes

- **Windows:** Discord locks its files while running, so AesDc closes it first. Discord installs
  updates into a new `app-x.y.z` folder; the runtime patches the new folder automatically, so
  Corrode survives updates.
- **macOS:** Your terminal needs **App Management** permission (System Settings > Privacy &
  Security) to change `/Applications/Discord.app`. Discord updates replace the app, so run
  `aesdc repair` after one.
- **Linux:** Installs under `/usr` or `/opt` need `sudo node bin/aesdc.js install`. AesDc still
  keeps Corrode's data in your own home folder and won't start Discord as root. Run
  `aesdc repair` after your package manager updates Discord. The Flatpak works, with its data in
  `~/.var/app/com.discordapp.Discord/config/AesDc` because the sandbox can't read `~/.config`.
  The Snap is read-only and can't be patched.

## Development

```sh
npm install
npm test                       # unit tests: injection, ejection, discovery, installer
xvfb-run -a npm run test:e2e   # boots a fake Discord in real Electron (drop xvfb-run on a desktop)
npm run build:exe              # build/aesdc(.exe) for this OS; set CORRODE_DIST to bundle Corrode
```

`AESDC_EXE=build/aesdc npm run test:e2e` runs the end-to-end test against the built executable.

The end-to-end test builds a fake Discord (Electron plus an `app.asar` shaped like Discord's main
window), installs Corrode with the real CLI, checks that Corrode loads early with the bridge and
Discord's own preload still running, ejects from inside the app, and checks that `app.asar` is
back byte for byte. It uses `../corrode/dist` when it exists (set `CORRODE_DIST` to change that)
and a stub bundle otherwise.
