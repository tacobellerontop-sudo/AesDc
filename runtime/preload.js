"use strict";
// AesDc's preload, used in place of Discord's for its main window. It exposes the native bridge,
// starts Corrode in the page's main world before Discord's scripts run ("early" mode), and then
// runs Discord's own preload.
const { contextBridge, ipcRenderer, webFrame } = require("electron");

const ORIGINAL_PRELOAD_ARG = "--aesdc-original-preload=";
const originalArg = process.argv.find((a) => a.startsWith(ORIGINAL_PRELOAD_ARG));
const originalPreload = originalArg ? originalArg.slice(ORIGINAL_PRELOAD_ARG.length) : null;

try {
  const info = ipcRenderer.sendSync("aesdc:corrode");
  if (info && info.code) {
    contextBridge.exposeInMainWorld("CorrodeNative", {
      name: info.host.name,
      version: info.host.version,
      storage: {
        get: (key) => ipcRenderer.sendSync("corrode:storage-get", String(key)),
        set: (key, value) => void ipcRenderer.sendSync("corrode:storage-set", String(key), String(value)),
        delete: (key) => void ipcRenderer.sendSync("corrode:storage-delete", String(key)),
        keys: () => ipcRenderer.sendSync("corrode:storage-keys") || [],
      },
      fetchText: (url) => ipcRenderer.invoke("corrode:fetch-text", String(url)),
      relaunch: () => ipcRenderer.send("corrode:relaunch"),
      openDevTools: () => ipcRenderer.send("corrode:open-devtools"),
      eject: () => ipcRenderer.invoke("corrode:eject").then(() => undefined),
    });
    webFrame.executeJavaScript(`${info.code}\n//# sourceURL=corrode.js`).catch((err) => console.error("[AesDc] Corrode failed to start", err));
  } else if (info && info.error) {
    console.warn(`[AesDc] ${info.error}`);
  }
} catch (err) {
  console.error("[AesDc] preload failed; continuing without Corrode", err);
}

// Always run Discord's own preload, even if Corrode failed.
if (originalPreload) require(originalPreload);
