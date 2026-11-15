"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { inspect, inject, eject } = require("../src/inject");
const asar = require("../src/asar");
const { tmpDir, fakeResources, writeAsar } = require("./helpers");

const opts = (dir) => ({ hostMain: path.join(dir, "host", "runtime", "main.js"), dataDir: dir, version: "0.1.0" });
const read = (p) => fs.readFileSync(p);

test("asar reader reads package.json", () => {
  const res = fakeResources(tmpDir());
  assert.equal(asar.readJson(path.join(res, "app.asar"), "package.json").name, "discord");
  assert.equal(asar.readFile(path.join(res, "app.asar"), "app_bootstrap/index.js").toString(), "module.exports = 'discord';");
});

test("inject then eject restores the original byte for byte", () => {
  const root = tmpDir();
  const res = fakeResources(path.join(root, "resources"));
  const original = read(path.join(res, "app.asar"));
  const before = fs.readdirSync(res).sort();

  assert.equal(inspect(res).state, "clean");
  inject(res, opts(root));
  const st = inspect(res);
  assert.equal(st.state, "injected");
  assert.equal(st.marker.aesdc, "0.1.0");
  assert.ok(!fs.existsSync(path.join(res, "app.asar")));
  assert.deepEqual(read(path.join(res, "_app.asar")), original);

  const shimPkg = JSON.parse(fs.readFileSync(path.join(res, "app", "package.json"), "utf8"));
  assert.deepEqual(shimPkg, { name: "discord", productName: "Discord", version: "0.0.80", main: "index.js" });
  const shim = fs.readFileSync(path.join(res, "app", "index.js"), "utf8");
  assert.ok(shim.includes(JSON.stringify(opts(root).hostMain)));
  new Function("require", shim); // syntactically valid

  const r = eject(res);
  assert.equal(r.state, "clean");
  assert.deepEqual(r.deferred, []);
  assert.deepEqual(fs.readdirSync(res).sort(), before);
  assert.deepEqual(read(path.join(res, "app.asar")), original);
});

test("inject is idempotent and eject on a clean install is a no-op", () => {
  const root = tmpDir();
  const res = fakeResources(path.join(root, "resources"));
  inject(res, opts(root));
  inject(res, { ...opts(root), version: "0.2.0" });
  assert.equal(inspect(res).marker.aesdc, "0.2.0");
  eject(res);
  assert.equal(eject(res).state, "clean");
  assert.equal(inspect(res).state, "clean");
});

test("app.asar.unpacked travels with the archive", () => {
  const root = tmpDir();
  const res = fakeResources(path.join(root, "resources"));
  fs.mkdirSync(path.join(res, "app.asar.unpacked"));
  fs.writeFileSync(path.join(res, "app.asar.unpacked", "native.node"), "x");
  inject(res, opts(root));
  assert.ok(fs.existsSync(path.join(res, "_app.asar.unpacked", "native.node")));
  assert.ok(!fs.existsSync(path.join(res, "app.asar.unpacked")));
  eject(res);
  assert.ok(fs.existsSync(path.join(res, "app.asar.unpacked", "native.node")));
  assert.ok(!fs.existsSync(path.join(res, "_app.asar.unpacked")));
});

test("a Discord update that rewrites app.asar is detected and repaired", () => {
  const root = tmpDir();
  const res = fakeResources(path.join(root, "resources"));
  inject(res, opts(root));
  // A package manager upgrade writes a new app.asar but leaves our app/ folder alone.
  writeAsar(path.join(res, "app.asar"), { "package.json": JSON.stringify({ name: "discord", version: "0.0.81", main: "index.js" }), "index.js": "" });
  const fresh = read(path.join(res, "app.asar"));
  assert.equal(inspect(res).state, "outdated");

  inject(res, opts(root));
  assert.equal(inspect(res).state, "injected");
  assert.deepEqual(read(path.join(res, "_app.asar")), fresh);
  assert.equal(JSON.parse(fs.readFileSync(path.join(res, "app", "aesdc.json"), "utf8")).discordVersion, "0.0.81");

  // Ejecting an outdated install keeps the newer archive.
  writeAsar(path.join(res, "app.asar"), { "package.json": JSON.stringify({ name: "discord", version: "0.0.82", main: "index.js" }), "index.js": "" });
  const newest = read(path.join(res, "app.asar"));
  eject(res);
  assert.equal(inspect(res).state, "clean");
  assert.deepEqual(read(path.join(res, "app.asar")), newest);
  assert.ok(!fs.existsSync(path.join(res, "_app.asar")));
});

test("refuses to touch another mod's resources/app", () => {
  const root = tmpDir();
  const res = fakeResources(path.join(root, "resources"));
  fs.renameSync(path.join(res, "app.asar"), path.join(res, "_app.asar"));
  fs.mkdirSync(path.join(res, "app"));
  fs.writeFileSync(path.join(res, "app", "index.js"), "// some other mod");
  assert.equal(inspect(res).state, "foreign");
  assert.throws(() => inject(res, opts(root)), { code: "EFOREIGN" });
  assert.throws(() => eject(res), { code: "EFOREIGN" });
  assert.equal(fs.readFileSync(path.join(res, "app", "index.js"), "utf8"), "// some other mod");
});

test("a half-finished eject (only _app.asar) is restored", () => {
  const root = tmpDir();
  const res = fakeResources(path.join(root, "resources"));
  fs.renameSync(path.join(res, "app.asar"), path.join(res, "_app.asar"));
  assert.equal(inspect(res).state, "broken");
  eject(res);
  assert.equal(inspect(res).state, "clean");
});

test("rolls back if the shim cannot be written", () => {
  const root = tmpDir();
  const res = fakeResources(path.join(root, "resources"));
  writeAsar(path.join(res, "app.asar"), { "index.js": "" }); // no package.json
  assert.throws(() => inject(res, opts(root)), { code: "EBADASAR" });
  assert.equal(inspect(res).state, "clean");
  assert.ok(fs.existsSync(path.join(res, "app.asar")));
});

test("not a Discord folder", () => {
  assert.equal(inspect(tmpDir()).state, "missing");
  assert.throws(() => inject(tmpDir(), opts(tmpDir())), { code: "ENOTDISCORD" });
});
