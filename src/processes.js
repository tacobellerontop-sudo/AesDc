"use strict";
// Detecting, closing and starting Discord. Discord has to be closed to patch it on Windows (it
// locks app.asar), and restarted everywhere for the change to take effect.
const { execFileSync, spawn } = require("node:child_process");

function run(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }) };
  } catch (err) {
    return { ok: false, out: String(err.stdout || "") };
  }
}

function isRunning(install) {
  if (!install.processName) return false;
  if (process.platform === "win32") {
    const r = run("tasklist", ["/FI", `IMAGENAME eq ${install.processName}`, "/NH", "/FO", "CSV"]);
    return r.out.toLowerCase().includes(`"${install.processName.toLowerCase()}"`);
  }
  return run("pgrep", ["-x", install.processName]).ok;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Close Discord and wait (up to ~10s) for it to exit. */
async function close(install) {
  if (!isRunning(install)) return false;
  if (process.platform === "win32") {
    run("taskkill", ["/F", "/T", "/IM", install.processName]);
  } else {
    run("pkill", ["-x", install.processName]);
  }
  for (let i = 0; i < 40; i++) {
    await delay(250);
    if (!isRunning(install)) break;
    if (i === 20 && process.platform !== "win32") run("pkill", ["-9", "-x", install.processName]);
  }
  // Give the OS a moment to release file handles.
  await delay(500);
  if (isRunning(install)) throw new Error(`${install.label} is still running. Quit it (including from the tray) and try again.`);
  return true;
}

/** Start Discord. Returns false when it can't (no launcher known, or running as root via sudo). */
function launch(install) {
  if (!install.launch) return false;
  if (process.env.SUDO_USER && typeof process.getuid === "function" && process.getuid() === 0) return false;
  try {
    const child = spawn(install.launch.command, install.launch.args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = { isRunning, close, launch };
