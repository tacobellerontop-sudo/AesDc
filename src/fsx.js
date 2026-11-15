"use strict";
// Filesystem helpers shared by the CLI (plain Node) and the runtime (inside Discord's Electron).
//
// Inside Electron, the regular `fs` module treats `*.asar` files as directories. AesDc renames and
// copies asar archives as plain files, so it uses Electron's unpatched `original-fs` when present.
const path = require("node:path");

/** @type {typeof import("node:fs")} */
let fs;
try {
  fs = require("original-fs");
} catch {
  fs = require("node:fs");
}

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJson(p, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

/** Write a file so that readers never see a half-written version. */
function writeFileAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, p);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

function rm(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/** Copy a file or directory tree. */
function copy(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: true });
}

/** Can the current user create, rename and delete entries in `dir`? */
function isWritableDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Compare dotted version strings numerically ("1.0.9013" vs "1.0.10"). */
function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

module.exports = { fs, exists, isDir, readJson, writeFileAtomic, rm, copy, isWritableDir, compareVersions };
