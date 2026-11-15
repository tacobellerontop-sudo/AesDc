"use strict";
// Finding Discord installations (Stable, PTB, Canary, Development) on Windows, macOS and Linux,
// and the per-user data directory AesDc keeps its runtime, the Corrode bundle and settings in.
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { fs, exists, isDir, readJson, isWritableDir, compareVersions } = require("./fsx");
const { inspect } = require("./inject");

const FLAVORS = {
  stable: { label: "Discord Stable", win: "Discord", mac: "Discord", linux: ["discord", "Discord"], bin: "Discord", flatpak: "com.discordapp.Discord", snap: "discord" },
  ptb: { label: "Discord PTB", win: "DiscordPTB", mac: "Discord PTB", linux: ["discord-ptb", "DiscordPTB"], bin: "DiscordPTB", flatpak: null, snap: null },
  canary: { label: "Discord Canary", win: "DiscordCanary", mac: "Discord Canary", linux: ["discord-canary", "DiscordCanary"], bin: "DiscordCanary", flatpak: "com.discordapp.DiscordCanary", snap: "discord-canary" },
  development: { label: "Discord Development", win: "DiscordDevelopment", mac: "Discord Development", linux: ["discord-development", "DiscordDevelopment"], bin: "DiscordDevelopment", flatpak: null, snap: null },
};

/**
 * The real user's home directory. Under `sudo` (needed for system-wide Linux installs), this is
 * the invoking user's home, not root's, so Corrode's data ends up where Discord can read it.
 */
function userHome(env = process.env) {
  if (env.AESDC_HOME) return env.AESDC_HOME;
  if (env.SUDO_USER && typeof process.getuid === "function" && process.getuid() === 0) {
    try {
      const line = execFileSync("getent", ["passwd", env.SUDO_USER], { encoding: "utf8" }).trim();
      const home = line.split(":")[5];
      if (home) return home;
    } catch {}
    if (process.platform === "darwin") return `/Users/${env.SUDO_USER}`;
  }
  return os.homedir();
}

/** Where AesDc keeps its runtime, the Corrode bundle and Corrode's settings. */
function defaultDataDir(env = process.env, platform = process.platform) {
  if (env.AESDC_DATA_DIR) return path.resolve(env.AESDC_DATA_DIR);
  const home = userHome(env);
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "AesDc");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "AesDc");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "AesDc");
}

function buildInfo(resourcesDir) {
  return readJson(path.join(resourcesDir, "build_info.json"), {}) || {};
}

function makeInstall(base) {
  const st = inspect(base.resourcesDir);
  const info = buildInfo(base.resourcesDir);
  const writable = isWritableDir(base.resourcesDir);
  return {
    supported: true,
    unsupportedReason: null,
    ...base,
    version: info.version || base.version || null,
    releaseChannel: info.releaseChannel || null,
    id: `${base.flavor}${base.kind === "flatpak" ? "-flatpak" : ""}`,
    label: `${FLAVORS[base.flavor] ? FLAVORS[base.flavor].label : "Discord"}${base.kind === "flatpak" ? " (Flatpak)" : base.kind === "custom" ? " (custom path)" : ""}`,
    state: st.state,
    status: st,
    writable,
    needsElevation: !writable,
  };
}

function windowsInstalls(env) {
  const local = env.LOCALAPPDATA || path.join(userHome(env), "AppData", "Local");
  const out = [];
  for (const [flavor, f] of Object.entries(FLAVORS)) {
    const root = path.join(local, f.win);
    const appDirs = listAppDirs(root);
    if (!appDirs.length) continue;
    const latest = appDirs[0];
    out.push(
      makeInstall({
        flavor,
        kind: "squirrel",
        root,
        resourcesDir: path.join(root, latest.name, "resources"),
        version: latest.version,
        processName: `${f.win}.exe`,
        launch: { command: path.join(root, "Update.exe"), args: ["--processStart", `${f.win}.exe`] },
      }),
    );
  }
  return out;
}

/** Squirrel `app-x.y.z` folders under a Windows install root, newest first. */
function listAppDirs(root) {
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, m: /^app-(\d+(?:\.\d+)*)$/.exec(name) }))
    .filter((e) => e.m && exists(path.join(root, e.name, "resources")))
    .map((e) => ({ name: e.name, version: e.m[1] }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

function macInstalls(env) {
  const out = [];
  for (const dir of ["/Applications", path.join(userHome(env), "Applications")]) {
    for (const [flavor, f] of Object.entries(FLAVORS)) {
      const app = path.join(dir, `${f.mac}.app`);
      const resourcesDir = path.join(app, "Contents", "Resources");
      if (!isDir(resourcesDir)) continue;
      out.push(
        makeInstall({
          flavor,
          kind: "app-bundle",
          root: app,
          resourcesDir,
          processName: f.mac,
          launch: { command: "open", args: ["-a", app] },
        }),
      );
    }
  }
  return out;
}

function linuxInstalls(env) {
  const home = userHome(env);
  const out = [];
  const bases = ["/usr/share", "/usr/lib", "/usr/lib64", "/opt", path.join(home, ".local", "share"), path.join(home, ".local", "opt"), home];
  for (const [flavor, f] of Object.entries(FLAVORS)) {
    for (const base of bases) {
      for (const name of f.linux) {
        const root = path.join(base, name);
        const resourcesDir = path.join(root, "resources");
        if (!isDir(resourcesDir) || inspect(resourcesDir).state === "missing") continue;
        out.push(
          makeInstall({
            flavor,
            kind: "linux",
            root,
            resourcesDir,
            processName: f.bin,
            launch: { command: path.join(root, f.bin), args: [] },
          }),
        );
      }
    }
    if (f.flatpak) {
      for (const fpBase of ["/var/lib/flatpak", path.join(home, ".local", "share", "flatpak")]) {
        const files = path.join(fpBase, "app", f.flatpak, "current", "active", "files");
        for (const name of f.linux) {
          const root = path.join(files, name);
          const resourcesDir = path.join(root, "resources");
          if (!isDir(resourcesDir)) continue;
          out.push(
            makeInstall({
              flavor,
              kind: "flatpak",
              root,
              resourcesDir,
              processName: f.bin,
              launch: { command: "flatpak", args: ["run", f.flatpak] },
              // The Flatpak sandbox can only read its own ~/.var/app/<id>, so the runtime and
              // Corrode's data live there for this install.
              dataDir: path.join(home, ".var", "app", f.flatpak, "config", "AesDc"),
            }),
          );
        }
      }
    }
    if (f.snap) {
      for (const name of f.linux) {
        const resourcesDir = path.join("/snap", f.snap, "current", "usr", "share", name, "resources");
        if (!isDir(resourcesDir)) continue;
        out.push(
          makeInstall({
            flavor,
            kind: "snap",
            root: path.dirname(resourcesDir),
            resourcesDir,
            processName: f.bin,
            launch: null,
            supported: false,
            unsupportedReason: "Snap packages are read-only. Install Discord from discord.com (deb/tar.gz) or Flathub instead.",
          }),
        );
      }
    }
  }
  return out;
}

/**
 * Every Discord installation on this machine.
 * @returns {Array<ReturnType<typeof makeInstall>>}
 */
function findInstalls({ env = process.env, platform = process.platform } = {}) {
  const found = platform === "win32" ? windowsInstalls(env) : platform === "darwin" ? macInstalls(env) : linuxInstalls(env);
  const seen = new Set();
  const out = [];
  for (const inst of found) {
    let key = inst.resourcesDir;
    try {
      key = fs.realpathSync(inst.resourcesDir);
    } catch {}
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dataDir: defaultDataDir(env, platform), ...inst });
  }
  return out;
}

/**
 * Turn a user-supplied path into an install. Accepts the resources folder itself, the folder that
 * contains it, a macOS .app bundle, or a Windows install root (C:\Users\me\AppData\Local\Discord).
 */
function installFromPath(input, { env = process.env, platform = process.platform } = {}) {
  const abs = path.resolve(input);
  const candidates = [abs, path.join(abs, "resources"), path.join(abs, "Contents", "Resources")];
  const apps = listAppDirs(abs);
  if (apps.length) candidates.unshift(path.join(abs, apps[0].name, "resources"));
  const resourcesDir = candidates.find((c) => isDir(c) && inspect(c).state !== "missing");
  if (!resourcesDir) throw new Error(`No Discord resources folder (with app.asar) found at ${abs}`);
  const lower = resourcesDir.toLowerCase();
  const flavor = /canary/.test(lower) ? "canary" : /ptb/.test(lower) ? "ptb" : /development/.test(lower) ? "development" : "stable";
  const f = FLAVORS[flavor];
  const isSquirrel = platform === "win32" && /[\\/]app-[\d.]+[\\/]resources$/i.test(resourcesDir);
  const root = isSquirrel ? path.resolve(resourcesDir, "..", "..") : path.dirname(resourcesDir);
  return {
    dataDir: defaultDataDir(env, platform),
    ...makeInstall({
      flavor,
      kind: isSquirrel ? "squirrel" : "custom",
      root,
      resourcesDir,
      processName: platform === "win32" ? `${f.win}.exe` : platform === "darwin" ? f.mac : f.bin,
      launch: isSquirrel ? { command: path.join(root, "Update.exe"), args: ["--processStart", `${f.win}.exe`] } : null,
    }),
    id: "custom",
  };
}

module.exports = { FLAVORS, findInstalls, installFromPath, defaultDataDir, userHome, listAppDirs };
