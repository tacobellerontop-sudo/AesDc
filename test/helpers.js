"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Write a minimal valid asar archive containing `files` ({ "a/b.js": "content" }). */
function writeAsar(file, files) {
  const header = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const buf = Buffer.from(content);
    const parts = name.split("/");
    let node = header;
    for (const dir of parts.slice(0, -1)) node = node.files[dir] ??= { files: {} };
    node.files[parts.at(-1)] = { size: buf.length, offset: String(offset) };
    chunks.push(buf);
    offset += buf.length;
  }
  const json = Buffer.from(JSON.stringify(header));
  const padded = Math.ceil(json.length / 4) * 4;
  const pickle = Buffer.alloc(8 + padded);
  pickle.writeUInt32LE(4 + padded, 0);
  pickle.writeUInt32LE(json.length, 4);
  json.copy(pickle, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(pickle.length, 4);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([size, pickle, ...chunks]));
}

function tmpDir(prefix = "aesdc-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A fake Discord resources folder with an app.asar. */
function fakeResources(dir, pkg = { name: "discord", productName: "Discord", version: "0.0.80", main: "app_bootstrap/index.js" }) {
  writeAsar(path.join(dir, "app.asar"), {
    "package.json": JSON.stringify(pkg),
    "app_bootstrap/index.js": "module.exports = 'discord';",
  });
  fs.writeFileSync(path.join(dir, "build_info.json"), JSON.stringify({ releaseChannel: "stable", version: pkg.version }));
  return dir;
}

module.exports = { writeAsar, tmpDir, fakeResources };
