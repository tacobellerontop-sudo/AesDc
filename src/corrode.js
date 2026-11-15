"use strict";
// Getting the Corrode bundle into a data directory: from a GitHub release (default), a manifest
// URL, a local `dist/` folder or a single `corrode.min.js`. Every source is checked against the
// injector API version this AesDc speaks, and downloads are verified with the manifest's sha256.
const path = require("node:path");
const { createHash } = require("node:crypto");
const { fs, exists, isDir, readJson, writeFileAtomic } = require("./fsx");

/** Injector API versions (docs/INJECTOR.md in the corrode repo) this AesDc implements. */
const SUPPORTED_API_VERSIONS = [1];
const DEFAULT_REPO = "tacobellerontop-sudo/corrode";

function releaseManifestUrl(repo = process.env.AESDC_CORRODE_REPO || DEFAULT_REPO) {
  return `https://github.com/${repo}/releases/latest/download/manifest.json`;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function checkApi(version, where) {
  if (!SUPPORTED_API_VERSIONS.includes(Number(version)))
    throw new Error(
      `${where} uses Corrode injector API v${version}, but this AesDc supports v${SUPPORTED_API_VERSIONS.join(", v")}. Update AesDc (or use a matching Corrode build).`,
    );
}

function verify(buf, manifest, file, where) {
  const meta = manifest.files && manifest.files[file];
  if (!meta) throw new Error(`${where}: manifest.json does not list ${file}`);
  if (meta.sha256 && sha256(buf) !== meta.sha256) throw new Error(`${where}: ${file} does not match the sha256 in manifest.json`);
}

/** Version info from the banner of a bundle without a manifest: `/*! Corrode v0.1.0 (abc) | MIT | injector api v1 *\/` */
function parseBanner(code) {
  const m = /Corrode v([^\s]+) \(([^)]*)\).*?injector api v(\d+)/.exec(code.slice(0, 400));
  return m ? { version: m[1], commit: m[2], injectorApiVersion: Number(m[3]) } : null;
}

async function download(url) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Resolve a Corrode source to `{ code: Buffer, manifest }`.
 * @param {string | undefined} source  path to corrode.min.js or a dist/ folder, a manifest URL,
 *   or undefined for the latest GitHub release.
 */
async function resolveBundle(source) {
  if (!source || /^https?:\/\//i.test(source)) {
    const manifestUrl = source || releaseManifestUrl();
    let manifest;
    try {
      manifest = JSON.parse((await download(manifestUrl)).toString("utf8"));
    } catch (err) {
      throw new Error(
        `Could not download Corrode from ${manifestUrl} (${err.message}). If Corrode has no release yet, build it (npm run build in the corrode repo) and pass --corrode <path to corrode/dist>.`,
      );
    }
    checkApi(manifest.injectorApiVersion, manifestUrl);
    const file = manifest.main || "corrode.min.js";
    const fileUrl = new URL(file, manifestUrl).href;
    const code = await download(fileUrl);
    verify(code, manifest, file, fileUrl);
    return { code, manifest: { ...manifest, source: manifestUrl } };
  }

  const abs = path.resolve(source);
  if (isDir(abs)) {
    const manifestPath = path.join(abs, "manifest.json");
    if (!exists(manifestPath)) throw new Error(`${abs} has no manifest.json; point --corrode at Corrode's dist/ folder or at corrode.min.js`);
    const manifest = readJson(manifestPath);
    if (!manifest) throw new Error(`${manifestPath} is not valid JSON`);
    checkApi(manifest.injectorApiVersion, manifestPath);
    const file = manifest.main || "corrode.min.js";
    const code = fs.readFileSync(path.join(abs, file));
    verify(code, manifest, file, path.join(abs, file));
    return { code, manifest: { ...manifest, source: abs } };
  }
  if (!exists(abs)) throw new Error(`Corrode bundle not found: ${abs}`);
  const code = fs.readFileSync(abs);
  const banner = parseBanner(code.toString("utf8"));
  if (!banner) throw new Error(`${abs} does not look like a Corrode bundle (no Corrode banner)`);
  checkApi(banner.injectorApiVersion, abs);
  return {
    code,
    manifest: { name: "corrode", ...banner, main: "corrode.min.js", files: { "corrode.min.js": { size: code.length, sha256: sha256(code) } }, source: abs },
  };
}

/** Write a resolved bundle into `<dataDir>/corrode/`. */
function writeBundle(dataDir, { code, manifest }) {
  const dir = path.join(dataDir, "corrode");
  writeFileAtomic(path.join(dir, "corrode.min.js"), code);
  writeFileAtomic(path.join(dir, "manifest.json"), JSON.stringify({ ...manifest, main: "corrode.min.js", installedAt: new Date().toISOString() }, null, 2) + "\n");
}

/** The Corrode build installed in `dataDir`, or null. */
function installedBundle(dataDir) {
  const dir = path.join(dataDir, "corrode");
  if (!exists(path.join(dir, "corrode.min.js"))) return null;
  return readJson(path.join(dir, "manifest.json"), {}) || {};
}

module.exports = { resolveBundle, writeBundle, installedBundle, parseBanner, releaseManifestUrl, SUPPORTED_API_VERSIONS, DEFAULT_REPO };
