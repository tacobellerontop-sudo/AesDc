"use strict";
// Files AesDc ships with: read from the source tree, or from the executable when AesDc runs as a
// single-file build (Node's single executable applications, see scripts/build-exe.js).
const path = require("node:path");
const nodeFs = require("node:fs");

const PKG_ROOT = path.join(__dirname, "..");

/** The runtime Discord loads, copied into `<dataDir>/host` on install. */
const HOST_FILES = ["package.json", "runtime/main.js", "runtime/preload.js", "src/fsx.js", "src/asar.js", "src/inject.js", "src/discord.js"];
/** Other files the CLI itself needs. */
const APP_FILES = ["src/gui/index.html"];
/** A Corrode build embedded into the executable at build time (optional). */
const EMBEDDED_CORRODE = ["corrode/manifest.json", "corrode/corrode.min.js"];

let sea = null;
try {
  const m = require("node:sea");
  if (m.isSea()) sea = m;
} catch {}

function isSea() {
  return !!sea;
}

/** @returns {Buffer | null} */
function read(rel) {
  if (sea) {
    try {
      return Buffer.from(sea.getAsset(rel));
    } catch {
      return null;
    }
  }
  try {
    return nodeFs.readFileSync(path.join(PKG_ROOT, rel));
  } catch {
    return null;
  }
}

function readText(rel) {
  const b = read(rel);
  if (!b) throw new Error(`AesDc is missing its file ${rel}`);
  return b.toString("utf8");
}

module.exports = { HOST_FILES, APP_FILES, EMBEDDED_CORRODE, PKG_ROOT, isSea, read, readText };
