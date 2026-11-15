#!/usr/bin/env node
// End-to-end test of the real client: serves a fake Discord page on 127.0.0.1, starts the AesDc
// binary pointed at it (AESDC_DISCORD_URL), and checks from inside the page that Corrode ran
// before the page's first script, the CorrodeNative bridge works, settings reach the settings
// file, links are kept out of the client, and "Uninstall Corrode" restarts into plain Discord.
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
    }
  } catch (e) { r.error = String(e && e.message || e); }
  const reply = await fetch("/report", { method: "POST", body: JSON.stringify(r) }).then((x) => x.text());
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
      res.end(reports.length === 1 ? "eject" : "done");
      onReport && onReport();
    });
    return;
  }
  if (req.url === "/plugin.txt") return res.end("plugin source");
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
  const url = `http://127.0.0.1:${server.address().port}/app`;
  const env = { ...process.env, AESDC_DISCORD_URL: url, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), APPDATA: home, LOCALAPPDATA: home };
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
    await waitReports(2, 90_000);
    const [first, second] = reports;
    assert.equal(first.error, undefined);
    assert.equal(first.corrode, true, "Corrode should be in the page");
    assert.equal(first.loadMode, "early", "Corrode should run before the page's scripts");
    assert.equal(first.nativeName, "AesDc");
    assert.equal(first.before, null);
    assert.equal(first.after, "hello");
    assert.equal(first.fetched, "plugin source");
    assert.equal(first.fileBlocked, true);
    assert.equal(first.openReturned, "null");

    const cfg = fs.readdirSync(path.join(home, ".config")).map((d) => path.join(home, ".config", d)).find((d) => fs.existsSync(path.join(d, "corrode-storage.json")));
    assert.ok(cfg, "settings folder");
    assert.equal(JSON.parse(fs.readFileSync(path.join(cfg, "corrode-storage.json"), "utf8")).data["corrode:e2e"], "hello");

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
