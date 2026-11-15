"use strict";
// What the CLI and the GUI actually do: install, uninstall (eject), repair, update and status.
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { fs, exists, readJson, writeFileAtomic, rm } = require("./fsx");
const assets = require("./assets");
const injector = require("./inject");
const discord = require("./discord");
const corrode = require("./corrode");
const processes = require("./processes");

const VERSION = JSON.parse(assets.readText("package.json")).version;

const hostMain = (dataDir) => path.join(dataDir, "host", "runtime", "main.js");
const recordFile = (dataDir) => path.join(dataDir, "installs.json");

function readRecord(dataDir) {
  const r = readJson(recordFile(dataDir), null);
  return r && Array.isArray(r.installs) ? r : { installs: [] };
}

function updateRecord(dataDir, fn) {
  const r = readRecord(dataDir);
  r.installs = fn(r.installs);
  writeFileAtomic(recordFile(dataDir), JSON.stringify(r, null, 2) + "\n");
}

/** Under sudo, hand the data directory back to the real user so Discord can write settings. */
function fixOwnership(dataDir) {
  const uid = Number(process.env.SUDO_UID);
  const gid = Number(process.env.SUDO_GID);
  if (!process.env.SUDO_UID || !(typeof process.getuid === "function" && process.getuid() === 0)) return;
  try {
    execFileSync("chown", ["-R", `${uid}:${gid}`, dataDir], { stdio: "ignore" });
  } catch {}
}

/** Write the runtime (runtime/ and the src/ modules it uses) into `<dataDir>/host`. */
function deployHost(dataDir) {
  const host = path.join(dataDir, "host");
  const next = path.join(dataDir, `host.${process.pid}.new`);
  rm(next);
  for (const rel of assets.HOST_FILES) {
    const file = path.join(next, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, assets.read(rel));
  }
  rm(host);
  fs.renameSync(next, host);
}

/**
 * Make sure each data directory has the runtime and a Corrode bundle. The bundle is fetched at
 * most once per call. `source` forces a (re)fetch from that source.
 */
async function prepareDataDirs(dataDirs, { source, refresh, log }) {
  let resolved = null;
  // A Corrode build embedded in the executable is used for first installs, not for updates.
  const embedded = !source && !refresh ? corrode.embeddedBundle() : null;
  for (const dataDir of dataDirs) {
    fs.mkdirSync(dataDir, { recursive: true });
    deployHost(dataDir);
    if (refresh || source || !corrode.installedBundle(dataDir)) {
      if (!resolved && embedded) {
        resolved = embedded;
        log(`Using the bundled Corrode ${resolved.manifest.version} (${resolved.manifest.commit || "unknown commit"})`);
      }
      if (!resolved) {
        log(`Getting Corrode from ${source || corrode.releaseManifestUrl()}`);
        resolved = await corrode.resolveBundle(source);
        log(`Corrode ${resolved.manifest.version} (${resolved.manifest.commit || "unknown commit"}), injector API v${resolved.manifest.injectorApiVersion}`);
      }
      corrode.writeBundle(dataDir, resolved);
    }
    fixOwnership(dataDir);
  }
}

function unsupported(inst) {
  if (!inst.supported) return inst.unsupportedReason;
  return null;
}

function permissionHint(inst, err) {
  if (!["EACCES", "EPERM"].includes(err.code)) return err.message;
  if (process.platform === "darwin")
    return `macOS blocked changes to ${inst.root}. Give your terminal "App Management" (or "Full Disk Access") in System Settings > Privacy & Security, then try again.`;
  if (process.platform === "win32") return `${err.message}. Close Discord (including from the tray) and try again.`;
  return `No permission to change ${inst.resourcesDir}. Run again with sudo.`;
}

/**
 * Run `fn` with Discord closed, and start it again afterwards if it was running.
 */
async function withDiscordClosed(inst, { restart, log }, fn) {
  let wasRunning = false;
  if (restart && processes.isRunning(inst)) {
    log(`Closing ${inst.label}`);
    wasRunning = await processes.close(inst);
  }
  try {
    return await fn();
  } finally {
    if (wasRunning) {
      if (processes.launch(inst)) log(`Starting ${inst.label}`);
      else log(`Start ${inst.label} again to finish.`);
    }
  }
}

/**
 * @param {{ installs: any[], source?: string, restart?: boolean, log?: (m: string) => void }} opts
 */
async function install({ installs, source, restart = true, log = () => {} }) {
  const results = [];
  const targets = installs.filter((i) => {
    const why = unsupported(i);
    if (why) results.push({ id: i.id, ok: false, error: why });
    return !why;
  });
  if (!targets.length) return results;
  await prepareDataDirs([...new Set(targets.map((i) => i.dataDir))], { source, log });

  for (const inst of targets) {
    try {
      await withDiscordClosed(inst, { restart, log }, async () => {
        log(`Injecting into ${inst.label} (${inst.resourcesDir})`);
        injector.inject(inst.resourcesDir, { hostMain: hostMain(inst.dataDir), dataDir: inst.dataDir, version: VERSION });
      });
      updateRecord(inst.dataDir, (list) => [...list.filter((r) => r.root !== inst.root), { id: inst.id, root: inst.root, resourcesDir: inst.resourcesDir, kind: inst.kind }]);
      fixOwnership(inst.dataDir);
      results.push({ id: inst.id, ok: true });
    } catch (err) {
      results.push({ id: inst.id, ok: false, error: permissionHint(inst, err), code: err.code });
    }
  }
  return results;
}

/** Every resources dir belonging to an install (all app-x.y.z folders on Windows). */
function resourceDirsOf(inst) {
  if (inst.kind !== "squirrel") return [inst.resourcesDir];
  const dirs = discord.listAppDirs(inst.root).map((a) => path.join(inst.root, a.name, "resources"));
  return dirs.includes(inst.resourcesDir) ? dirs : [inst.resourcesDir, ...dirs];
}

/**
 * The ejector: restore stock Discord.
 * @param {{ installs: any[], purge?: boolean, restart?: boolean, log?: (m: string) => void }} opts
 */
async function uninstall({ installs, purge = false, restart = true, log = () => {} }) {
  const results = [];
  for (const inst of installs) {
    const dirs = resourceDirsOf(inst).filter((d) => {
      const st = injector.inspect(d);
      return st.marker || st.leftoverBackup || (st.state === "broken" && st.hasBackup);
    });
    if (!dirs.length) {
      results.push({ id: inst.id, ok: true, skipped: "not installed" });
      continue;
    }
    try {
      await withDiscordClosed(inst, { restart, log }, async () => {
        for (const dir of dirs) {
          log(`Restoring ${inst.label} (${dir})`);
          const r = injector.eject(dir);
          injector.removeLater(r.deferred);
        }
      });
      updateRecord(inst.dataDir, (list) => list.filter((r) => r.root !== inst.root));
      results.push({ id: inst.id, ok: true });
    } catch (err) {
      results.push({ id: inst.id, ok: false, error: permissionHint(inst, err), code: err.code });
    }
  }

  if (purge) {
    const all = discord.findInstalls();
    for (const dataDir of new Set(installs.map((i) => i.dataDir))) {
      const stillUsed = all.some((i) => i.dataDir === dataDir && resourceDirsOf(i).some((d) => injector.inspect(d).marker));
      if (stillUsed) {
        log(`Keeping ${dataDir}: another Discord install still uses it.`);
        continue;
      }
      log(`Deleting ${dataDir} (Corrode settings, plugins data and the AesDc runtime)`);
      rm(dataDir);
    }
  }
  return results;
}

/**
 * Re-inject installs that Discord updates undid, and refresh the runtime. An install is repaired if
 * AesDc is (partly) installed in it or it was installed with AesDc before.
 */
async function repair({ installs, restart = true, log = () => {} }) {
  const wanted = installs.filter((inst) => {
    if (!inst.supported) return false;
    const recorded = readRecord(inst.dataDir).installs.some((r) => r.root === inst.root);
    const touched = resourceDirsOf(inst).some((d) => injector.inspect(d).marker);
    return recorded || touched || inst.state !== "clean";
  });
  const needed = wanted.filter((i) => i.state !== "foreign" && i.state !== "missing");
  if (!needed.length) {
    log("Nothing to repair.");
    return [];
  }
  return install({ installs: needed, restart, log });
}

/** Refresh Corrode (and the runtime) in every data directory in use. Takes effect on next start. */
async function update({ installs, source, log = () => {} }) {
  const dataDirs = new Set([discord.defaultDataDir()]);
  for (const inst of installs) if (exists(path.join(inst.dataDir, "host"))) dataDirs.add(inst.dataDir);
  await prepareDataDirs([...dataDirs], { source, refresh: true, log });
  log("Restart Discord to load the new version.");
  return [...dataDirs].map((d) => ({ dataDir: d, ok: true, corrode: corrode.installedBundle(d) }));
}

function status({ installs }) {
  return {
    aesdc: VERSION,
    dataDir: discord.defaultDataDir(),
    corrode: corrode.installedBundle(discord.defaultDataDir()),
    installs: installs.map((i) => ({
      id: i.id,
      label: i.label,
      kind: i.kind,
      version: i.version,
      resourcesDir: i.resourcesDir,
      state: i.state,
      runtimeMissing: i.status.runtimeMissing,
      supported: i.supported,
      unsupportedReason: i.unsupportedReason,
      needsElevation: i.needsElevation,
      running: processes.isRunning(i),
      dataDir: i.dataDir,
      corrode: i.dataDir === discord.defaultDataDir() ? undefined : corrode.installedBundle(i.dataDir),
    })),
  };
}

module.exports = { install, uninstall, repair, update, status, deployHost, VERSION };
