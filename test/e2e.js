#!/usr/bin/env node
// End-to-end test of the real client: serves a fake Discord page on 127.0.0.1, starts the AesDc
// binary pointed at it (AESDC_DISCORD_URL), and checks from inside the page that Corrode ran
// before the page's first script, the CorrodeNative bridge works, settings reach the settings
// file, links are kept out of the client, the themes folder works, an update check finds a newer Corrode, downloads it and
// loads it after a restart, and "Uninstall Corrode" restarts into plain Discord.
//
// Usage: node test/e2e.js [path/to/aesdc binary]   (Linux needs a display: xvfb-run -a ...)
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const exe = path.resolve(process.argv[2] || path.join(__dirname, "..", "src-tauri", "target", "debug", process.platform === "win32" ? "aesdc.exe" : "aesdc"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "aesdc-e2e-"));

// A newer "Corrode" published on the fake release server.
const NEW_CORRODE = `/*! Corrode v9.9.9 (e2e9999) | MIT | injector api v1 */\nwindow.corrode = { version: "9.9.9", loadMode: "early" };\n`;
const MANIFEST = {
  name: "corrode",
  version: "9.9.9",
  commit: "e2e9999",
  injectorApiVersion: 1,
  builtAt: "2099-01-01T00:00:00.000Z",
  main: "corrode.min.js",
  files: { "corrode.min.js": { size: NEW_CORRODE.length, sha256: require("node:crypto").createHash("sha256").update(NEW_CORRODE).digest("hex") } },
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><script>
  // The page's first script, standing in for Discord's.
  window.__first = { corrode: !!window.corrode, native: !!window.CorrodeNative };
  (window.webpackChunkdiscord_app = window.webpackChunkdiscord_app || []).push([[0], {}]);
</script></head><body>fake discord<a id="ext" href="https://example.com/" target="_blank">x</a><script>
(async () => {
  const r = { ...window.__first, corrode: !!window.corrode };
  try {
    if (window.corrode) { r.loadMode = window.corrode.loadMode; r.version = window.corrode.version; }
    const n = window.CorrodeNative;
    if (n) {
      r.nativeName = n.name;
      r.before = n.storage.get("corrode:e2e");
      n.storage.set("corrode:e2e", "hello");
      r.after = n.storage.get("corrode:e2e");
      r.fetched = await n.fetchText(location.origin + "/plugin.txt");
      r.fileBlocked = await n.fetchText("file:///etc/passwd").then(() => false, () => true);
      // window.open to another site must not open a window inside the client.
      r.openReturned = String(window.open("https://example.com/"));
      r.updates = await n.updates.check();
      // The themes folder.
      await n.themes.write("e2e.theme.css", "/** @name E2E */ body{}");
      r.themeList = (await n.themes.list()).files.map((f) => f.file);
      r.themeRead = await n.themes.read("e2e.theme.css");
      r.themeEscape = await n.themes.read("../settings.json").then(() => false, () => true);
      const media = await n.themes.writeMedia("bg é.png", new Uint8Array([1, 2, 3, 250]));
      r.media = media;
      r.mediaBack = [...new Uint8Array(await n.themes.readMedia(media))];
      await n.themes.delete("e2e.theme.css");
      r.themeListAfter = (await n.themes.list()).files.length;
    }
  } catch (e) { r.error = String(e && e.message || e); }
  const reply = await fetch("/report", { method: "POST", body: JSON.stringify(r) }).then((x) => x.text());
  if (reply === "update") {
    await window.CorrodeNative.updates.updateCorrode();
    window.CorrodeNative.relaunch();
  }
  if (reply === "eject") await window.CorrodeNative.eject();
})();
</script></body></html>`;

const reports = [];
let onReport = null;
const server = http.createServer((req, res) => {
  if (req.url === "/report") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = JSON.parse(body);
      reports.push(r);
      console.log("report:", r);
      res.end(["update", "eject"][reports.length - 1] ?? "done");
      onReport && onReport();
    });
    return;
  }
  if (req.url === "/plugin.txt") return res.end("plugin source");
  if (req.url === "/release/manifest.json") return res.end(JSON.stringify(MANIFEST));
  if (req.url === "/release/corrode.min.js") return res.end(NEW_CORRODE);
  if (req.url === "/client-release") return res.end(JSON.stringify({ target_commitish: "f".repeat(40), published_at: "2099-01-01T00:00:00Z" }));
  res.setHeader("content-type", "text/html");
  res.end(PAGE);
});

const waitReports = (n, ms) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${n} report(s), got ${reports.length}`)), ms);
    onReport = () => reports.length >= n && (clearTimeout(t), resolve());
    onReport();
  });

server.listen(0, "127.0.0.1", async () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/app`;
  const env = { ...process.env, AESDC_DISCORD_URL: url, AESDC_CORRODE_RELEASE: `${origin}/release`, AESDC_CLIENT_RELEASE_API: `${origin}/client-release`, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), APPDATA: home, LOCALAPPDATA: home };
  const child = spawn(exe, [], { env, stdio: ["ignore", "inherit", "inherit"], detached: process.platform !== "win32" });
  const killAll = () => {
    try {
      process.platform === "win32" ? child.kill() : process.kill(-child.pid, "SIGKILL");
    } catch {}
    // app.restart() starts a new process outside our group.
    try {
      require("node:child_process").execFileSync("pkill", ["-9", "-f", exe]);
    } catch {}
  };
  try {
    await waitReports(3, 120_000);
    const [first, updated, second] = reports;
    assert.equal(first.error, undefined);
    assert.equal(first.corrode, true, "Corrode should be in the page");
    assert.equal(first.loadMode, "early", "Corrode should run before the page's scripts");
    assert.equal(first.nativeName, "AesDc");
    assert.equal(first.before, null);
    assert.equal(first.after, "hello");
    assert.equal(first.fetched, "plugin source");
    assert.equal(first.fileBlocked, true);
    assert.equal(first.openReturned, "null");
    assert.deepEqual(first.themeList, ["e2e.theme.css"]);
    assert.equal(first.themeRead, "/** @name E2E */ body{}");
    assert.equal(first.themeEscape, true, "theme paths can't leave the themes folder");
    assert.equal(first.media, "media/bg é.png");
    assert.deepEqual(first.mediaBack, [1, 2, 3, 250]);
    assert.equal(first.themeListAfter, 0);

    const cfg = fs.readdirSync(path.join(home, ".config")).map((d) => path.join(home, ".config", d)).find((d) => fs.existsSync(path.join(d, "corrode-storage.json")));
    assert.ok(cfg, "settings folder");
    assert.equal(JSON.parse(fs.readFileSync(path.join(cfg, "corrode-storage.json"), "utf8")).data["corrode:e2e"], "hello");

    // The update check offered the newer Corrode and a newer client.
    assert.equal(first.updates.corrode.available, true, "Corrode update offered");
    assert.equal(first.updates.corrode.latestVersion, "9.9.9");
    assert.equal(first.updates.corrode.latestCommit, "e2e9999");
    assert.equal(first.updates.client.available, true, "client update offered");
    assert.equal(first.updates.client.latestCommit, "fffffff");
    assert.match(first.updates.client.version, /^\d+\.\d+\.\d+/);

    // After updating Corrode and restarting, the downloaded build runs and nothing more is offered.
    assert.equal(updated.error, undefined);
    assert.equal(updated.version, "9.9.9", "the downloaded Corrode should be loaded");
    assert.equal(updated.updates.corrode.version, "9.9.9");
    assert.equal(updated.updates.corrode.commit, "e2e9999");
    assert.equal(updated.updates.corrode.available, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(cfg, "corrode.update.json"), "utf8")).commit, "e2e9999");

    // After "Uninstall Corrode" the client restarted without Corrode, bridge still present.
    assert.equal(second.corrode, false);
    assert.equal(second.nativeName, "AesDc");
    assert.equal(second.before, "hello", "settings survive a restart");
    assert.equal(JSON.parse(fs.readFileSync(path.join(cfg, "settings.json"), "utf8")).corrodeEnabled, false);
    console.log("e2e: all checks passed");
    process.exitCode = 0;
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    killAll();
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
    setTimeout(() => process.exit(), 200);
  }
});
