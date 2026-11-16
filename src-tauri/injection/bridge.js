// AesDc injector, part 1 of 2. Runs in Discord's page before any of Discord's scripts (it is a
// webview initialization script), then Corrode is evaluated right after it ("early" mode).
//
// It exposes `window.CorrodeNative`, the bridge described in Corrode's docs/INJECTOR.md.
// The Rust side (src/inject.rs) fills in the config object: { hosts, version, corrode, storage }.
(() => {
  const cfg = __AESDC_CONFIG__;
  if (!cfg.hosts.includes(location.host) || window.CorrodeNative) return;
  console.info(`[AesDc] client ${cfg.version} injected; Corrode ${cfg.corrode ? "enabled" : "off (turn it on from the tray)"}`);

  const internals = window.__TAURI_INTERNALS__;
  const invoke = (cmd, args, options) =>
    internals ? internals.invoke(cmd, args, options) : Promise.reject(new Error("AesDc bridge unavailable"));

  // Corrode's storage API is synchronous, but calls into the app are not. Keep the settings in
  // memory: they start from the snapshot the app embedded in this script and every change is
  // written through to the app's settings file. A copy in localStorage (Discord deletes
  // window.localStorage later, so keep a reference now) covers page reloads, which re-run this
  // script with the snapshot from app start. Whichever copy has the higher revision wins.
  let ls = null;
  try {
    ls = window.localStorage;
  } catch {}
  const MIRROR = "aesdc:corrode-storage";
  let store = cfg.storage;
  try {
    const mirror = JSON.parse(ls.getItem(MIRROR));
    if (mirror && mirror.rev > store.rev && mirror.data && typeof mirror.data === "object") store = mirror;
  } catch {}
  const commit = () => {
    store.rev += 1;
    try {
      ls && ls.setItem(MIRROR, JSON.stringify(store));
    } catch {}
    return store.rev;
  };
  const toBase64 = (bytes) => {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const fromBase64 = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const report = (what) => (err) => console.error(`[AesDc] ${what} failed`, err);
  const has = (k) => Object.prototype.hasOwnProperty.call(store.data, k);

  const isExternal = (url) => {
    try {
      const u = new URL(url, location.href);
      return /^(https?|mailto):$/.test(u.protocol) && !cfg.hosts.includes(u.host);
    } catch {
      return false;
    }
  };
  const openExternal = (url) => invoke("open_external", { url: new URL(url, location.href).href }).catch(report("open link"));

  Object.defineProperty(window, "CorrodeNative", {
    configurable: false,
    enumerable: false,
    value: Object.freeze({
      name: "AesDc",
      version: cfg.version,
      storage: Object.freeze({
        get: (key) => (has(String(key)) ? store.data[String(key)] : null),
        set: (key, value) => {
          store.data[String(key)] = String(value);
          invoke("storage_set", { key: String(key), value: String(value), rev: commit() }).catch(report("saving settings"));
        },
        delete: (key) => {
          if (!has(String(key))) return;
          delete store.data[String(key)];
          invoke("storage_delete", { key: String(key), rev: commit() }).catch(report("saving settings"));
        },
        keys: () => Object.keys(store.data),
      }),
      fetchText: (url) => invoke("fetch_text", { url: String(url) }),
      relaunch: () => void invoke("relaunch").catch(report("relaunch")),
      openDevTools: () => void invoke("open_devtools").catch(report("open DevTools")),
      // In a standalone client, "uninstall" means: turn Corrode off and restart into plain Discord.
      // It can be turned back on from the tray menu.
      eject: () => invoke("disable_corrode"),
      // Corrode's Updates page. updateCorrode downloads the newest Corrode (loaded after a
      // restart); updateClient starts the AesDc installer (Windows) or opens the download page.
      updates: Object.freeze({
        check: () => invoke("update_check"),
        updateCorrode: () => invoke("update_corrode"),
        updateClient: () => invoke("update_client"),
      }),
      // The window, for the custom titlebar. Each call resolves to the window's state:
      // { maximized, fullscreen, focused, decorated }.
      window: Object.freeze({
        minimize: () => invoke("window_control", { action: "minimize" }),
        toggleMaximize: () => invoke("window_control", { action: "toggleMaximize" }),
        close: () => invoke("window_control", { action: "close" }),
        startDrag: () => invoke("window_control", { action: "startDrag" }),
        state: () => invoke("window_control", { action: "state" }),
      }),
      // The themes folder (<config dir>/themes): .css files shown on Corrode's Themes page, and
      // the pictures and videos its theme creator uses as backgrounds (themes/media).
      themes: Object.freeze({
        list: () => invoke("themes_list"),
        read: (file) => invoke("themes_read", { file: String(file) }),
        write: (file, css) => invoke("themes_write", { file: String(file), css: String(css) }),
        delete: (file) => invoke("themes_delete", { file: String(file) }),
        openFolder: () => invoke("themes_open_folder"),
        // Resolves to the saved file's path in the themes folder, "media/<name>". Sent in
        // base64 chunks: Windows' webview can't pass raw bytes from a remote page.
        writeMedia: async (name, data) => {
          const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
          const upload = Math.random().toString(36).slice(2) + Date.now().toString(36);
          const CHUNK = 3 * 1024 * 1024;
          let saved = null;
          for (let offset = 0; offset < bytes.length || offset === 0; offset += CHUNK) {
            const part = bytes.subarray(offset, offset + CHUNK);
            const last = offset + CHUNK >= bytes.length;
            saved = await invoke("themes_media_write", { upload, name: String(name), data: toBase64(part), offset, last });
            if (last) break;
          }
          return saved;
        },
        // Resolves to an ArrayBuffer.
        readMedia: async (path) => {
          const CHUNK = 4 * 1024 * 1024;
          const parts = [];
          let offset = 0;
          let size = Infinity;
          while (offset < size) {
            const r = await invoke("themes_media_read", { path: String(path), offset, length: CHUNK });
            size = r.size;
            const part = fromBase64(r.data);
            if (!part.length) break;
            parts.push(part);
            offset += part.length;
          }
          const out = new Uint8Array(offset);
          let at = 0;
          for (const p of parts) out.set(p, (at += p.length) - p.length);
          return out.buffer;
        },
      }),
    }),
  });

  // Links to other sites open in the default browser, not inside the client.
  const nativeOpen = window.open;
  window.open = function (url, ...rest) {
    if (url && isExternal(String(url))) {
      openExternal(String(url));
      return null;
    }
    return nativeOpen.call(this, url, ...rest);
  };
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!a || e.defaultPrevented || !isExternal(a.href)) return;
      if (a.target === "_blank" || e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) {
        e.preventDefault();
        openExternal(a.href);
      }
    },
    true,
  );
})();
