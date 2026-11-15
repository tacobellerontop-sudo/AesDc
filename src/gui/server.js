"use strict";
// A small installer GUI: a local web page served on 127.0.0.1 and opened in the default browser.
// No dependencies, nothing to install. Every API call needs the random token that is only in the
// URL opened by AesDc, and the Host header must be the loopback address (no DNS rebinding).
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { fs } = require("../fsx");
const discord = require("../discord");
const installer = require("../installer");

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 64 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function pick(ids) {
  const all = discord.findInstalls();
  if (!Array.isArray(ids) || !ids.length) throw new Error("Pick at least one Discord install.");
  return ids.map((id) => {
    const hit = all.find((i) => i.id === id);
    if (!hit) throw new Error(`${id} is no longer installed.`);
    return hit;
  });
}

/**
 * @param {{ port?: number, open?: boolean, source?: string, host?: string }} opts
 * @returns {Promise<{ url: string, close: () => void, server: http.Server }>}
 */
function serve({ port = 0, open = true, source, host = "127.0.0.1" } = {}) {
  const token = crypto.randomBytes(18).toString("base64url");
  const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8").replace("__TOKEN__", token);
  let busy = false;

  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, {
        "content-type": type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
        "referrer-policy": "no-referrer",
      });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    const addr = server.address();
    if (req.headers.host !== `${host}:${addr.port}` && req.headers.host !== `localhost:${addr.port}`) return send(403, { error: "bad host" });
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === `/${token}/`) return send(200, page, "text/html; charset=utf-8");
    if (!url.pathname.startsWith("/api/")) return send(404, { error: "not found" });
    if (req.headers["x-aesdc-token"] !== token) return send(403, { error: "bad token" });

    try {
      if (req.method === "GET" && url.pathname === "/api/status") {
        return send(200, { ...installer.status({ installs: discord.findInstalls() }), platform: process.platform, defaultSource: source || "" });
      }
      if (req.method !== "POST") return send(405, { error: "method not allowed" });
      const body = await readBody(req);
      if (url.pathname === "/api/quit") {
        send(200, { ok: true });
        return setTimeout(() => process.exit(0), 100);
      }
      if (busy) return send(409, { error: "Another operation is still running." });
      busy = true;
      const lines = [];
      const log = (m) => lines.push(m);
      try {
        const corrodeSource = typeof body.corrode === "string" && body.corrode.trim() ? body.corrode.trim() : source;
        let results;
        if (url.pathname === "/api/install") results = await installer.install({ installs: pick(body.targets), source: corrodeSource, log });
        else if (url.pathname === "/api/uninstall") results = await installer.uninstall({ installs: pick(body.targets), purge: !!body.purge, log });
        else if (url.pathname === "/api/repair") results = await installer.repair({ installs: discord.findInstalls(), log });
        else if (url.pathname === "/api/update") results = await installer.update({ installs: discord.findInstalls(), source: corrodeSource, log });
        else return send(404, { error: "not found" });
        return send(200, { results, log: lines });
      } catch (err) {
        return send(200, { results: [{ ok: false, error: err.message }], log: lines });
      } finally {
        busy = false;
      }
    } catch (err) {
      return send(400, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${server.address().port}/${token}/`;
      console.log(`AesDc installer running at ${url}\nPress Ctrl+C to stop.`);
      if (open) openBrowser(url);
      resolve({ url, server, close: () => server.close() });
    });
  });
}

module.exports = { serve };
