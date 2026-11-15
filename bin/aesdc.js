#!/usr/bin/env node
"use strict";
const readline = require("node:readline/promises");
const discord = require("../src/discord");
const installer = require("../src/installer");

const HELP = `AesDc ${installer.VERSION}: installs the Corrode mod into the Discord desktop app.

Usage:
  aesdc                         Interactive menu
  aesdc status [--json]         Show Discord installs and whether Corrode is installed
  aesdc install [target...]     Patch Discord to load Corrode
  aesdc uninstall [target...]   Eject: restore the original Discord (--purge also deletes settings)
  aesdc repair                  Re-apply after a Discord update undid the patch
  aesdc update                  Download the latest Corrode (restart Discord afterwards)
  aesdc gui                     Open the installer in your browser

Targets: stable, ptb, canary, development, stable-flatpak, canary-flatpak, or all.
With no target, install picks the only Discord found; uninstall removes AesDc from all of them.

Options:
  --path <dir>        Use the Discord install at <dir> instead of searching
  --corrode <src>     Corrode bundle: path to corrode/dist, a corrode.min.js, or a manifest.json URL
                      (default: latest GitHub release of ${require("../src/corrode").DEFAULT_REPO})
  --no-restart        Don't close and restart Discord (Windows needs Discord closed to patch)
  --purge             With uninstall: also delete Corrode's settings and the AesDc data folder
  --port <n>          With gui: port to listen on (default: random)
  --no-open           With gui: print the URL instead of opening a browser
  -h, --help          Show this help
`;

function parseArgs(argv) {
  const flags = { restart: true, open: true };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === "-h" || a === "--help") flags.help = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--purge") flags.purge = true;
    else if (a === "--no-restart") flags.restart = false;
    else if (a === "--no-open") flags.open = false;
    else if (a === "--path") flags.path = value();
    else if (a === "--corrode") flags.corrode = value();
    else if (a === "--port") flags.port = Number(value());
    else if (a.startsWith("-")) fail(`Unknown option ${a}. See aesdc --help.`);
    else positional.push(a);
  }
  return { cmd: positional.shift(), targets: positional, flags };
}

class UsageError extends Error {}
function fail(msg) {
  throw new UsageError(msg);
}

const log = (m) => console.log(`  ${m}`);

function describe(i) {
  const state =
    {
      clean: "not installed",
      injected: i.status.runtimeMissing ? "installed (runtime missing: run repair)" : "installed",
      outdated: "Discord updated: run repair",
      foreign: "another mod is installed",
      broken: "broken: run uninstall or repair",
      missing: "not found",
    }[i.state] || i.state;
  const notes = [];
  if (!i.supported) notes.push(i.unsupportedReason);
  else if (i.needsElevation) notes.push(process.platform === "win32" ? "needs admin" : "needs sudo");
  return `${i.id.padEnd(16)} ${String(i.version || "").padEnd(10)} ${state}${notes.length ? `  (${notes.join("; ")})` : ""}\n${"".padEnd(17)}${i.resourcesDir}`;
}

function select(cmd, targets, flags) {
  if (flags.path) return [discord.installFromPath(flags.path)];
  const all = discord.findInstalls();
  if (!targets.length) {
    if (cmd !== "install") return all;
    const supported = all.filter((i) => i.supported);
    if (supported.length === 1) return supported;
    if (!supported.length) fail("No Discord installation found. Use --path <folder> to point at one.");
    fail(`Found several Discord installs; name one (or "all"):\n${supported.map((i) => `  ${i.id}`).join("\n")}`);
  }
  if (targets.includes("all")) return all;
  return targets.map((t) => {
    const hit = all.find((i) => i.id === t) || all.find((i) => i.flavor === t);
    if (!hit) fail(`${t} not found. Installs: ${all.map((i) => i.id).join(", ") || "none"}`);
    return hit;
  });
}

function report(results) {
  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log(`✓ ${r.id || r.dataDir}${r.skipped ? ` (${r.skipped})` : ""}`);
    else {
      failed++;
      console.log(`✗ ${r.id}: ${r.error}`);
    }
  }
  return failed ? 1 : 0;
}

async function runCommand(cmd, targets, flags) {
  switch (cmd) {
    case "status": {
      const s = installer.status({ installs: discord.findInstalls() });
      if (flags.json) return void console.log(JSON.stringify(s, null, 2));
      console.log(`AesDc ${s.aesdc}`);
      console.log(`Corrode: ${s.corrode ? `${s.corrode.version} (${s.corrode.commit || "?"})` : "not downloaded"}  [${s.dataDir}]\n`);
      const installs = discord.findInstalls();
      if (!installs.length) console.log("No Discord installation found.");
      for (const i of installs) console.log(describe(i));
      return 0;
    }
    case "install":
      console.log("Installing Corrode");
      return report(await installer.install({ installs: select(cmd, targets, flags), source: flags.corrode, restart: flags.restart, log }));
    case "uninstall":
    case "eject":
      console.log("Restoring the original Discord");
      return report(await installer.uninstall({ installs: select(cmd, targets, flags), purge: flags.purge, restart: flags.restart, log }));
    case "repair":
      console.log("Repairing");
      return report(await installer.repair({ installs: select(cmd, targets, flags), restart: flags.restart, log }));
    case "update":
      console.log("Updating Corrode");
      return report(await installer.update({ installs: select(cmd, targets, flags), source: flags.corrode, log }));
    case "gui":
      await require("../src/gui/server").serve({ port: flags.port, open: flags.open, source: flags.corrode });
      return null; // keep running
    default:
      fail(`Unknown command ${cmd}. See aesdc --help.`);
  }
}

async function interactive(flags) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      await runCommand("status", [], {});
      console.log("\n  1) Install   2) Uninstall   3) Repair   4) Update Corrode   5) Open GUI   q) Quit");
      const choice = (await rl.question("> ")).trim().toLowerCase();
      const cmd = { 1: "install", 2: "uninstall", 3: "repair", 4: "update", 5: "gui" }[choice];
      if (!cmd) return 0;
      if (cmd === "gui") {
        rl.close();
        return runCommand("gui", [], flags);
      }
      let targets = [];
      if (cmd === "install" || cmd === "uninstall") {
        const ids = discord.findInstalls().filter((i) => i.supported).map((i) => i.id);
        if (!ids.length) {
          console.log("No Discord installation found.");
          continue;
        }
        const t = (await rl.question(`Which Discord? (${[...ids, "all"].join(", ")}) [${ids[0]}] `)).trim() || ids[0];
        targets = [t];
      }
      const purge = cmd === "uninstall" && /^y/i.test(await rl.question("Also delete Corrode's settings? [y/N] "));
      console.log();
      try {
        await runCommand(cmd, targets, { ...flags, purge });
      } catch (err) {
        console.log(`error: ${err.message}`);
      }
      console.log();
    }
  } finally {
    rl.close();
  }
}

(async () => {
  const { cmd, targets, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) return void console.log(HELP);
  let code;
  if (!cmd) code = process.stdin.isTTY ? await interactive(flags) : (console.log(HELP), 0);
  else code = await runCommand(cmd, targets, flags);
  if (code !== null && code !== undefined) process.exitCode = code;
})().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
