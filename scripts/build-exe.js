#!/usr/bin/env node
// Builds AesDc into one executable (aesdc.exe on Windows) with Node's single executable
// applications: the CLI is bundled with esbuild, the runtime files Discord loads are embedded as
// assets, and so is a Corrode build when CORRODE_DIST points at one.
//
// Usage: node scripts/build-exe.js   (output: build/aesdc[.exe])
// Needs Node 22+ and the esbuild/postject dev dependencies. The output runs on the OS and CPU
// it was built on.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const esbuild = require("esbuild");
const { HOST_FILES, APP_FILES, EMBEDDED_CORRODE } = require("../src/assets");

const root = path.join(__dirname, "..");
const out = path.join(root, "build");
const exeName = process.platform === "win32" ? "aesdc.exe" : "aesdc";
const exe = path.join(out, exeName);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1. One CommonJS file for the CLI. `original-fs` and `electron` only exist inside Discord.
esbuild.buildSync({
  entryPoints: [path.join(root, "bin", "aesdc.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: path.join(out, "aesdc.cjs"),
  external: ["original-fs", "electron"],
  logLevel: "warning",
});
// esbuild keeps the shebang; SEA main scripts must not have one.
const bundled = path.join(out, "aesdc.cjs");
fs.writeFileSync(bundled, fs.readFileSync(bundled, "utf8").replace(/^#!.*\n/, ""));

// 2. Assets: the runtime, the GUI page, and optionally Corrode.
const assets = {};
for (const rel of [...HOST_FILES, ...APP_FILES]) assets[rel] = path.join(root, ...rel.split("/"));
const corrodeDist = process.env.CORRODE_DIST && path.resolve(process.env.CORRODE_DIST);
if (corrodeDist && fs.existsSync(path.join(corrodeDist, "manifest.json"))) {
  const manifest = JSON.parse(fs.readFileSync(path.join(corrodeDist, "manifest.json"), "utf8"));
  assets[EMBEDDED_CORRODE[0]] = path.join(corrodeDist, "manifest.json");
  assets[EMBEDDED_CORRODE[1]] = path.join(corrodeDist, manifest.main || "corrode.min.js");
  console.log(`Embedding Corrode ${manifest.version} (${manifest.commit}) from ${corrodeDist}`);
} else {
  console.log("No CORRODE_DIST: the executable will download Corrode's latest release on install.");
}

const seaConfig = path.join(out, "sea-config.json");
const blob = path.join(out, "sea-prep.blob");
fs.writeFileSync(seaConfig, JSON.stringify({ main: bundled, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, assets }, null, 2));
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

// 3. Copy this Node binary and inject the blob.
fs.copyFileSync(process.execPath, exe);
if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", exe], { stdio: "inherit" });
const postject = ["NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
if (process.platform === "darwin") postject.push("--macho-segment-name", "NODE_SEA");
execFileSync(process.execPath, [require.resolve("postject/dist/cli.js"), exe, ...postject], { stdio: "inherit" });
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", exe], { stdio: "inherit" });

for (const f of [bundled, seaConfig, blob]) fs.rmSync(f);
console.log(`Built ${path.relative(root, exe)} (${(fs.statSync(exe).size / 1048576).toFixed(1)} MB)`);
