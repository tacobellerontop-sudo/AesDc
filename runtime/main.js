"use strict";
// The AesDc runtime, running in Discord's Electron main process. The shim in
// resources/app/index.js calls start() and then boots Discord's original app.asar.
//
// It hooks Discord's windows so that AesDc's preload runs first (exposing `CorrodeNative` and
// evaluating Corrode in the page before Discord's scripts), then Discord's own preload.
const path = require("node:path");
const Module = require("node:module");
const electron = require("electron");
const { fs, readJson, writeFileAtomic, compareVersions } = require("../src/fsx");
const { inspect, inject, eject, removeLater } = require("../src/inject");

const HOST_NAME = "AesDc";
const HOST_VERSION = readJson(path.join(__dirname, "..", "package.json"), {}).version || "0.0.0";
const PRELOAD = path.join(__dirname, "preload.js");
const ORIGINAL_PRELOAD_ARG = "--aesdc-original-preload=";
const MAX_FETCH_BYTES = 20 * 1024 * 1024;

let started = false;
const beforeRelaunch = [];

/**
 * @param {{ asar: string, resources: string, shimDir: string, dataDir: string, pkg: any }} ctx
 */
function start(ctx) {
  if (started) return;
  started = true;
  const { app, ipcMain } = electron;

  /** webContents id -> Discord's own preload, for every window AesDc hooked. */
  const hooked = new Map();
  hookBrowserWindow(hooked);

  const corrodeFile = path.join(ctx.dataDir, "corrode", "corrode.min.js");
  const storage = createStorage(path.join(ctx.dataDir, "storage", `${safeName(ctx.pkg && ctx.pkg.name)}.json`));
  app.on("will-quit", () => storage.flush());
  beforeRelaunch.push(() => storage.flush());
  // app.exit() skips will-quit.
  process.on("exit", () => storage.flush());

  // Only Discord's own (hooked) windows may use the bridge.
  const trusted = (e) => hooked.has(e.sender.id) && (!e.senderFrame || !e.sender.mainFrame || e.senderFrame === e.sender.mainFrame);
  const onSync = (channel, fn) =>
    ipcMain.on(channel, (e, ...args) => {
      if (!trusted(e)) return void (e.returnValue = null);
      try {
        e.returnValue = fn(e, ...args);
      } catch (err) {
        console.error(`[AesDc] ${channel} failed`, err);
        e.returnValue = null;
      }
    });
  const onAsync = (channel, fn) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!trusted(e)) throw new Error("Not allowed");
      return fn(e, ...args);
    });

  onSync("aesdc:corrode", () => {
    try {
      return { code: fs.readFileSync(corrodeFile, "utf8"), host: { name: HOST_NAME, version: HOST_VERSION } };
    } catch (err) {
      return { error: `Corrode bundle not found at ${corrodeFile}. Run \`aesdc update\`. (${err.code || err.message})` };
    }
  });
  onSync("corrode:storage-get", (_e, key) => storage.get(String(key)));
  onSync("corrode:storage-set", (_e, key, value) => (storage.set(String(key), String(value)), true));
  onSync("corrode:storage-delete", (_e, key) => (storage.delete(String(key)), true));
  onSync("corrode:storage-keys", () => storage.keys());
  onAsync("corrode:fetch-text", (_e, url) => fetchText(url));
  ipcMain.on("corrode:relaunch", (e) => trusted(e) && relaunch());
  ipcMain.on("corrode:open-devtools", (e) => trusted(e) && e.sender.openDevTools());
  onAsync("corrode:eject", async () => {
    storage.flush();
    const result = ejectFromHere(ctx);
    // Give the renderer a moment to receive the reply, then restart into stock Discord.
    setTimeout(relaunch, 300);
    return result;
  });

  if (process.platform === "win32") {
    // Discord on Windows installs host updates into a new app-x.y.z folder. Inject AesDc into it so
    // Corrode survives the update; check at startup and again when Discord quits to apply one.
    setTimeout(() => healSquirrelUpdates(ctx), 60_000).unref();
    app.on("before-quit", () => healSquirrelUpdates(ctx));
  }
}

function hookBrowserWindow(hooked) {
  const { BrowserWindow } = electron;
  class AesDcBrowserWindow extends BrowserWindow {
    constructor(options) {
      const wp = options && options.webPreferences;
      const original = wp && typeof wp.preload === "string" ? wp.preload : null;
      // Hook windows with a Discord preload (the main window), but not the splash screen.
      const hook = !!original && !/splash/i.test(path.basename(original));
      if (hook) {
        options = {
          ...options,
          webPreferences: {
            ...wp,
            preload: PRELOAD,
            additionalArguments: [...(wp.additionalArguments || []), ORIGINAL_PRELOAD_ARG + original],
          },
        };
      }
      super(options);
      if (hook) {
        const id = this.webContents.id;
        hooked.set(id, original);
        this.webContents.once("destroyed", () => hooked.delete(id));
      }
    }
  }
  Object.defineProperty(AesDcBrowserWindow, "name", { value: "BrowserWindow" });

  // Discord's code does `require("electron").BrowserWindow`; hand it the hooked class.
  const patched = { ...electron, BrowserWindow: AesDcBrowserWindow };
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    const result = originalLoad.call(this, request, ...rest);
    return request === "electron" || request === "electron/main" ? patched : result;
  };
}

function relaunch() {
  for (const fn of beforeRelaunch) fn();
  electron.app.relaunch();
  electron.app.exit(0);
}

/** Synchronous key/value store backed by a JSON file, written shortly after each change. */
function createStorage(file) {
  let data = readJson(file, {});
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  let timer = null;
  const flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    try {
      writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
    } catch (err) {
      console.error("[AesDc] could not save Corrode settings", err);
    }
  };
  const changed = () => {
    if (!timer) timer = setTimeout(flush, 250);
  };
  return {
    get: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    set: (k, v) => {
      data[k] = v;
      changed();
    },
    delete: (k) => {
      if (Object.prototype.hasOwnProperty.call(data, k)) {
        delete data[k];
        changed();
      }
    },
    keys: () => Object.keys(data),
    flush,
  };
}

async function fetchText(url) {
  const u = new URL(String(url));
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`Only http(s) URLs can be fetched, not ${u.protocol}`);
  const doFetch = electron.net && typeof electron.net.fetch === "function" ? electron.net.fetch.bind(electron.net) : fetch;
  const res = await doFetch(u.href, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${u.href}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_FETCH_BYTES) throw new Error(`${u.href} is too large (${len} bytes)`);
  const text = await res.text();
  if (text.length > MAX_FETCH_BYTES) throw new Error(`${u.href} is too large`);
  return text;
}

/** The built-in ejector: restore stock Discord for this install (every app-x.y.z on Windows). */
function ejectFromHere(ctx) {
  const dirs = [ctx.resources];
  if (process.platform === "win32") {
    const { listAppDirs } = require("../src/discord");
    const root = path.resolve(ctx.resources, "..", "..");
    for (const { name } of listAppDirs(root)) {
      const res = path.join(root, name, "resources");
      if (path.resolve(res) !== path.resolve(ctx.resources)) dirs.push(res);
    }
  }
  const deferred = [];
  const ejected = [];
  for (const dir of dirs) {
    const st = inspect(dir);
    if (!st.marker && !st.leftoverBackup) continue;
    const r = eject(dir);
    deferred.push(...r.deferred);
    ejected.push(dir);
  }
  removeLater(deferred);
  return { ok: true, ejected };
}

function healSquirrelUpdates(ctx) {
  try {
    const { listAppDirs } = require("../src/discord");
    const root = path.resolve(ctx.resources, "..", "..");
    const current = path.basename(path.resolve(ctx.resources, ".."));
    const currentVersion = current.replace(/^app-/, "");
    for (const { name, version } of listAppDirs(root)) {
      if (compareVersions(version, currentVersion) <= 0) continue;
      const res = path.join(root, name, "resources");
      if (inspect(res).state === "clean") {
        inject(res, { hostMain: __filename, dataDir: ctx.dataDir, version: HOST_VERSION });
        console.log(`[AesDc] injected into updated Discord ${name}`);
      }
    }
  } catch (err) {
    console.error("[AesDc] could not inject into the updated Discord; run `aesdc repair`", err);
  }
}

function safeName(name) {
  return String(name || "discord").replace(/[^a-z0-9_.-]/gi, "_") || "discord";
}

module.exports = { start, createStorage };
