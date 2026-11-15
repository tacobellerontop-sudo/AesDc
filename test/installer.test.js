"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { tmpDir, fakeResources, writeAsar } = require("./helpers");

const home = tmpDir("aesdc-home-");
process.env.AESDC_HOME = home;
process.env.AESDC_DATA_DIR = path.join(home, "data");

const discord = require("../src/discord");
const installer = require("../src/installer");
const corrode = require("../src/corrode");

/** A Corrode dist/ folder like `npm run build` produces. */
function fakeCorrodeDist(apiVersion = 1) {
  const dir = tmpDir("corrode-dist-");
  const code = `/*! Corrode v9.9.9 (abc1234) | MIT | injector api v${apiVersion} */\nwindow.__corrode=1;`;
  fs.writeFileSync(path.join(dir, "corrode.min.js"), code);
  const sha256 = require("node:crypto").createHash("sha256").update(code).digest("hex");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ name: "corrode", version: "9.9.9", commit: "abc1234", injectorApiVersion: apiVersion, main: "corrode.min.js", files: { "corrode.min.js": { size: code.length, sha256 } } }),
  );
  return dir;
}

test("finds Windows Squirrel installs and picks the newest app-x.y.z", () => {
  const local = tmpDir();
  fakeResources(path.join(local, "Discord", "app-1.0.9", "resources"));
  fakeResources(path.join(local, "Discord", "app-1.0.10", "resources"));
  fakeResources(path.join(local, "DiscordCanary", "app-1.0.500", "resources"));
  const found = discord.findInstalls({ env: { LOCALAPPDATA: local, APPDATA: local, AESDC_HOME: local }, platform: "win32" });
  assert.deepEqual(found.map((i) => i.id).sort(), ["canary", "stable"]);
  const stable = found.find((i) => i.id === "stable");
  assert.match(stable.resourcesDir, /app-1\.0\.10/);
  assert.deepEqual(stable.launch.args, ["--processStart", "Discord.exe"]);
});

test("finds macOS app bundles", () => {
  const h = tmpDir();
  fakeResources(path.join(h, "Applications", "Discord PTB.app", "Contents", "Resources"));
  const found = discord.findInstalls({ env: { AESDC_HOME: h }, platform: "darwin" }).filter((i) => i.root.startsWith(h));
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "ptb");
  assert.equal(found[0].processName, "Discord PTB");
});

test("finds Linux installs, including Flatpak with a sandbox-readable data dir", () => {
  const h = tmpDir();
  fakeResources(path.join(h, ".local", "share", "discord-canary", "resources"));
  fakeResources(path.join(h, ".local", "share", "flatpak", "app", "com.discordapp.Discord", "current", "active", "files", "discord", "resources"));
  const found = discord.findInstalls({ env: { AESDC_HOME: h }, platform: "linux" }).filter((i) => i.root.startsWith(h));
  const byId = Object.fromEntries(found.map((i) => [i.id, i]));
  assert.ok(byId.canary);
  assert.equal(byId["stable-flatpak"].dataDir, path.join(h, ".var", "app", "com.discordapp.Discord", "config", "AesDc"));
});

test("--path accepts a resources folder, its parent or a .app", () => {
  const h = tmpDir();
  const res = fakeResources(path.join(h, "Discord Canary.app", "Contents", "Resources"));
  for (const p of [res, path.join(h, "Discord Canary.app")]) {
    const inst = discord.installFromPath(p, { env: { AESDC_HOME: h }, platform: "darwin" });
    assert.equal(inst.resourcesDir, res);
    assert.equal(inst.flavor, "canary");
  }
  assert.throws(() => discord.installFromPath(tmpDir()));
});

test("corrode sources: dist folder, single file, API mismatch and bad checksum", async () => {
  const dist = fakeCorrodeDist();
  assert.equal((await corrode.resolveBundle(dist)).manifest.version, "9.9.9");
  assert.equal((await corrode.resolveBundle(path.join(dist, "corrode.min.js"))).manifest.injectorApiVersion, 1);
  await assert.rejects(corrode.resolveBundle(fakeCorrodeDist(2)), /injector API v2/);
  fs.appendFileSync(path.join(dist, "corrode.min.js"), "tampered");
  await assert.rejects(corrode.resolveBundle(dist), /sha256/);
});

test("install, repair after a Discord update, uninstall --purge (Linux layout)", { skip: process.platform === "win32" }, async () => {
  const res = fakeResources(path.join(home, ".local", "share", "discord", "resources"));
  const original = fs.readFileSync(path.join(res, "app.asar"));
  const dataDir = process.env.AESDC_DATA_DIR;
  const installs = () => discord.findInstalls().filter((i) => i.root.startsWith(home));
  const logs = [];
  const log = (m) => logs.push(m);

  let results = await installer.install({ installs: installs(), source: fakeCorrodeDist(), restart: false, log });
  assert.deepEqual(results, [{ id: "stable", ok: true }]);
  assert.equal(installs()[0].state, "injected");
  assert.ok(fs.existsSync(path.join(dataDir, "host", "runtime", "main.js")));
  assert.ok(fs.existsSync(path.join(dataDir, "host", "src", "inject.js")));
  assert.ok(!fs.existsSync(path.join(dataDir, "host", "src", "gui")));
  assert.equal(corrode.installedBundle(dataDir).version, "9.9.9");
  // The runtime loads in plain Node (minus electron) without missing files.
  execFileSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(dataDir, "host", "src", "discord.js"))})`]);

  // A package upgrade replaces app.asar and our app/ folder is the only thing left: repair puts it back.
  fs.rmSync(path.join(res, "app"), { recursive: true });
  fs.rmSync(path.join(res, "_app.asar"));
  writeAsar(path.join(res, "app.asar"), { "package.json": JSON.stringify({ name: "discord", version: "0.0.99", main: "index.js" }), "index.js": "" });
  const upgraded = fs.readFileSync(path.join(res, "app.asar"));
  assert.equal(installs()[0].state, "clean");
  results = await installer.repair({ installs: installs(), restart: false, log });
  assert.deepEqual(results, [{ id: "stable", ok: true }]);
  assert.equal(installs()[0].state, "injected");

  results = await installer.uninstall({ installs: installs(), purge: true, restart: false, log });
  assert.deepEqual(results, [{ id: "stable", ok: true }]);
  assert.equal(installs()[0].state, "clean");
  assert.deepEqual(fs.readFileSync(path.join(res, "app.asar")), upgraded);
  assert.notDeepEqual(upgraded, original);
  assert.ok(!fs.existsSync(dataDir));
});

test("unsupported installs are reported, not touched", async () => {
  const results = await installer.install({ installs: [{ id: "stable", supported: false, unsupportedReason: "Snap packages are read-only." }] });
  assert.deepEqual(results, [{ id: "stable", ok: false, error: "Snap packages are read-only." }]);
});
