// AesDc injector, part 1 of 2. Runs in Discord's page before any of Discord's scripts (it is a
// webview initialization script), then Corrode is evaluated right after it ("early" mode).
//
// It exposes `window.CorrodeNative`, the bridge described in Corrode's docs/INJECTOR.md.
// The Rust side (src/inject.rs) fills in the config object: { hosts, version, corrode, storage }.
(() => {
  const cfg = __AESDC_CONFIG__;
  if (!cfg.hosts.includes(location.host) || window.CorrodeNative) return;

  const internals = window.__TAURI_INTERNALS__;
  const invoke = (cmd, args) =>
    internals ? internals.invoke(cmd, args) : Promise.reject(new Error("AesDc bridge unavailable"));

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
