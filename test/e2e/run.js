#!/usr/bin/env node
// End-to-end test against real Electron: builds a fake Discord (a copy of Electron with a small
// app.asar that behaves like Discord's main window), installs Corrode with the real CLI, boots it,
// checks Corrode loaded early with the native bridge, then ejects from inside the app and checks
// the original app.asar is back byte for byte.
//
// Needs: the `electron` dev dependency, a built Corrode (CORRODE_DIST, default ../corrode/dist),
// and a display (run under xvfb-run on headless Linux).
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { writeAsar } = require("../helpers");

const repo = path.join(__dirname, "..", "..");
const cli = path.join(repo, "bin", "aesdc.js");
let corrodeDist = path.resolve(process.env.CORRODE_DIST || path.join(repo, "..", "corrode", "dist"));
const electronBin = process.env.ELECTRON_BIN || require("electron");
const electronDist = path.dirname(electronBin);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "aesdc-e2e-"));

if (!fs.existsSync(path.join(corrodeDist, "manifest.json"))) {
  // No Corrode build next to us (e.g. in CI): use a stub that follows the same contract.
  console.log(`No Corrode build at ${corrodeDist}; using a stub bundle.`);
  corrodeDist = path.join(work, "corrode-stub.min.js");
  fs.writeFileSync(
    corrodeDist,
    `/*! Corrode v0.0.0-stub (stub) | MIT | injector api v1 */\n` +
      `(()=>{if(window.corrode)return;const api={version:"0.0.0-stub",loadMode:window.webpackChunkdiscord_app?"late":"early",unload(){delete window.corrode}};` +
      `Object.defineProperty(window,"corrode",{value:api,configurable:true})})();`,
  );
}
const home = path.join(work, "home");
const env = { ...process.env, AESDC_HOME: home, AESDC_DATA_DIR: path.join(home, "data") };

// "Install Discord": Electron's dist with our fake app.asar, laid out like the Linux tar.gz.
const discordRoot = path.join(home, ".local", "share", "discord");
fs.cpSync(electronDist, discordRoot, { recursive: true, verbatimSymlinks: true });
const exe = path.join(discordRoot, process.platform === "win32" ? "Discord.exe" : "Discord");
fs.renameSync(path.join(discordRoot, path.basename(electronBin)), exe);
const resources = path.join(discordRoot, "resources");
fs.rmSync(path.join(resources, "default_app.asar"), { force: true });
const appSrc = path.join(__dirname, "fake-discord");
writeAsar(
  path.join(resources, "app.asar"),
  Object.fromEntries(fs.readdirSync(appSrc).map((f) => [f, fs.readFileSync(path.join(appSrc, f))])),
);
const original = fs.readFileSync(path.join(resources, "app.asar"));

function aesdc(...args) {
  // AESDC_EXE tests a built executable (scripts/build-exe.js) instead of the source tree.
  const [cmd, pre] = process.env.AESDC_EXE ? [path.resolve(process.env.AESDC_EXE), []] : [process.execPath, [cli]];
  const r = spawnSync(cmd, [...pre, ...args, "--no-restart"], { env, encoding: "utf8" });
  process.stdout.write(r.stdout + r.stderr);
  assert.equal(r.status, 0, `aesdc ${args.join(" ")} failed`);
}

function boot(action) {
  const out = path.join(work, `${action}.json`);
  const args = process.platform === "linux" ? ["--no-sandbox"] : [];
  const r = spawnSync(exe, [...args, "--disable-gpu"], { env: { ...env, E2E_OUT: out, E2E_ACTION: action }, encoding: "utf8", timeout: 30000, killSignal: "SIGKILL" });
  if (!fs.existsSync(out)) {
    console.log(r.stdout, r.stderr);
    throw new Error(`Discord (${action}) produced no result`);
  }
  const result = JSON.parse(fs.readFileSync(out, "utf8"));
  console.log(`${action}:`, result);
  return result;
}

console.log(`work dir: ${work}`);

// 1. Stock Discord: no Corrode.
let r = boot("check");
assert.equal(r.corrode, false);
assert.equal(r.discordNative, true);
const stock = r;

// 2. Install and boot: Corrode loads before Discord's first script, with the bridge.
aesdc("install", "stable", "--corrode", corrodeDist);
r = boot("check");
assert.equal(r.corrodeBeforeDiscord, true, "Corrode should run before Discord's scripts");
assert.equal(r.loadMode, "early");
assert.ok(r.version);
assert.equal(r.discordNative, true, "Discord's own preload must still run");
assert.equal(r.nativeName, "AesDc");
assert.equal(r.storageRoundTrip, "hello");
assert.equal(r.fetchFile, "blocked");
assert.equal(r.appName, stock.appName, "app name (and so the userData folder) must not change");
assert.match(r.appPath, /_app\.asar$/);
const settings = JSON.parse(fs.readFileSync(path.join(home, "data", "storage", "discord.json"), "utf8"));
assert.equal(settings["corrode:e2e"], "hello");

// 3. "Uninstall Corrode" from inside Discord: the built-in ejector restores stock Discord.
r = boot("eject");
assert.equal(r.relaunched, true);
assert.deepEqual(fs.readFileSync(path.join(resources, "app.asar")), original);
assert.ok(!fs.existsSync(path.join(resources, "app")));
assert.ok(!fs.existsSync(path.join(resources, "_app.asar")));
r = boot("check");
assert.equal(r.corrode, false);

// 4. CLI install + uninstall round trip.
aesdc("install", "stable", "--corrode", corrodeDist);
aesdc("uninstall", "--purge");
assert.deepEqual(fs.readFileSync(path.join(resources, "app.asar")), original);
assert.ok(!fs.existsSync(path.join(home, "data")));

fs.rmSync(work, { recursive: true, force: true });
console.log("e2e: all checks passed");
