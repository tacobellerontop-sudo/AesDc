"use strict";
// Just enough of the asar format to read one small file (Discord's package.json) out of an
// archive without unpacking it and without Electron.
//
// Layout: [uint32 4][uint32 headerPickleSize][pickle: uint32 payloadSize, uint32 jsonLength, json]
// followed by the file data. A file entry's `offset` is relative to the end of the header.
const path = require("node:path");
const { fs } = require("./fsx");

function readHeader(fd) {
  const sizeBuf = Buffer.alloc(8);
  if (fs.readSync(fd, sizeBuf, 0, 8, 0) !== 8) throw new Error("not an asar archive (too short)");
  const headerPickleSize = sizeBuf.readUInt32LE(4);
  if (headerPickleSize < 8 || headerPickleSize > 64 * 1024 * 1024) throw new Error("not an asar archive (bad header size)");
  const pickle = Buffer.alloc(headerPickleSize);
  fs.readSync(fd, pickle, 0, headerPickleSize, 8);
  const jsonLength = pickle.readUInt32LE(4);
  const header = JSON.parse(pickle.toString("utf8", 8, 8 + jsonLength));
  return { header, dataOffset: 8 + headerPickleSize };
}

/** Read `inner` (e.g. "package.json") from the archive at `asarPath`. */
function readFile(asarPath, inner) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const { header, dataOffset } = readHeader(fd);
    let node = header;
    for (const part of inner.split(/[\\/]/).filter(Boolean)) {
      node = node && node.files && node.files[part];
    }
    if (!node || node.files) throw new Error(`${inner} not found in ${asarPath}`);
    if (node.link) return readFile(asarPath, node.link);
    if (node.unpacked) return fs.readFileSync(path.join(`${asarPath}.unpacked`, inner));
    const buf = Buffer.alloc(node.size);
    fs.readSync(fd, buf, 0, node.size, dataOffset + Number(node.offset));
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function readJson(asarPath, inner) {
  return JSON.parse(readFile(asarPath, inner).toString("utf8"));
}

module.exports = { readFile, readJson };
