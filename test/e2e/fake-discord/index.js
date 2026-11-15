// A stand-in for Discord's main process: one window with a preload, like Discord's main window.
// Behaviour is driven by env vars from test/e2e/run.js and results go to $E2E_OUT.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const out = process.env.E2E_OUT;
const realExit = app.exit.bind(app);
const finish = (result) => {
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  realExit(0);
};
// The runtime relaunches Discord after an eject; record that instead.
let relaunched = false;
app.relaunch = () => (relaunched = true);
app.exit = (code) => (relaunched && process.env.E2E_ACTION === "eject" ? finish({ ...globalThis.__e2e, relaunched }) : realExit(code));

setTimeout(() => finish({ error: "timeout" }), 20000);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    title: "Discord",
    show: false,
    webPreferences: { preload: path.join(__dirname, "mainScreenPreload.js"), contextIsolation: true, sandbox: false },
  });
  win.webContents.on("console-message", (_e, _level, message) => console.log("[renderer]", message));
  win.loadFile(path.join(__dirname, "index.html"));
  win.webContents.once("did-finish-load", async () => {
    const result = await win.webContents.executeJavaScript(`(async () => {
      const r = { ...window.__seenAtFirstScript, appName: ${JSON.stringify(app.getName())}, appPath: ${JSON.stringify(app.getAppPath())} };
      r.corrode = !!window.corrode;
      if (window.corrode) {
        r.loadMode = window.corrode.loadMode;
        r.version = window.corrode.version;
      }
      if (window.CorrodeNative) {
        r.nativeName = window.CorrodeNative.name;
        window.CorrodeNative.storage.set("corrode:e2e", "hello");
        r.storageRoundTrip = window.CorrodeNative.storage.get("corrode:e2e");
        r.storageKeys = window.CorrodeNative.storage.keys();
        try { await window.CorrodeNative.fetchText("file:///etc/passwd"); r.fetchFile = "allowed"; } catch (e) { r.fetchFile = "blocked"; }
      }
      return r;
    })()`);
    globalThis.__e2e = result;
    if (process.env.E2E_ACTION === "eject") {
      await win.webContents.executeJavaScript("window.corrode && window.corrode.unload(); window.CorrodeNative.eject()");
    } else finish(result);
  });
});
