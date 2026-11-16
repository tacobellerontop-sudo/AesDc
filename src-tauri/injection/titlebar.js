// AesDc's custom titlebar. Runs right after bridge.js, before Discord's scripts.
//
// The window has no system frame (Windows, Linux), or keeps only the floating traffic lights
// (macOS). This script puts the window controls into Discord's own top bar, the strip across the
// top of the app that holds the page title and the inbox and help buttons, and makes the empty
// parts of that bar drag the window, as in the official desktop app.
//
// Discord's class names are hashed (bar_c38106, trailing_c38106...), so the bar is found by the
// start of its class name plus its shape: a strip at the very top of the window, as wide as the
// window and 20 to 64 px tall. Where there is no such bar (the loading screen, the login page, or
// a Discord redesign), a slim bar of our own is shown instead, so the window can always be moved
// and closed.
(() => {
  const style = __AESDC_TITLEBAR__; // "controls" | "mac"
  const native = window.CorrodeNative;
  if (!native || native.name !== "AesDc" || !native.window || window.__aesdcTitlebar) return;
  window.__aesdcTitlebar = true;
  const win = native.window;
  const mac = style === "mac";
  const report = (what) => (err) => console.error(`[AesDc] titlebar: ${what} failed`, err);

  const FALLBACK_HEIGHT = mac ? 28 : 30;
  const CSS = `
#aesdc-winctl { display: flex; align-self: stretch; height: 100%; margin-left: 4px; flex: none; -webkit-app-region: no-drag; }
[data-aesdc-bar] > #aesdc-winctl { margin-left: auto; }
#aesdc-winctl button { all: unset; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
  width: 40px; height: 100%; min-height: 24px; color: var(--interactive-normal, #b5bac1); cursor: default; }
#aesdc-winctl button:hover { background: var(--background-modifier-hover, rgba(255,255,255,.08)); color: var(--interactive-hover, #dbdee1); }
#aesdc-winctl button:active { background: var(--background-modifier-active, rgba(255,255,255,.12)); }
#aesdc-winctl button[data-act="close"]:hover { background: #e81123; color: #fff; }
#aesdc-winctl svg { width: 10px; height: 10px; pointer-events: none; }
#aesdc-winctl .aesdc-restore { display: none; }
html[data-aesdc-maximized] #aesdc-winctl .aesdc-maximize { display: none; }
html[data-aesdc-maximized] #aesdc-winctl .aesdc-restore { display: block; }
html:not([data-aesdc-focused]) #aesdc-winctl button:not(:hover) { opacity: .6; }
#aesdc-titlebar { position: fixed; z-index: 2147483000; top: 0; left: 0; right: 0; height: ${FALLBACK_HEIGHT}px; display: none;
  align-items: center; background: var(--background-tertiary, var(--background-base-lowest, #1e1f22));
  color: var(--text-muted, #949ba4); font: 600 12px/1 "gg sans", "Segoe UI", system-ui, sans-serif; user-select: none; }
#aesdc-titlebar .aesdc-title { flex: 1; padding-left: ${mac ? 78 : 12}px; letter-spacing: .02em; }
html[data-aesdc-fallback] #aesdc-titlebar { display: flex; }
html[data-aesdc-fallback] #app-mount { position: fixed !important; top: ${FALLBACK_HEIGHT}px !important; left: 0 !important;
  right: 0 !important; bottom: 0 !important; width: auto !important; height: auto !important; }
html[data-aesdc-mac] [data-aesdc-bar] { padding-left: 78px !important; box-sizing: border-box; }
html[data-aesdc-fullscreen] #aesdc-titlebar { display: none !important; }
html[data-aesdc-fullscreen] #app-mount { top: 0 !important; }
`;
  const ICONS = {
    minimize: '<svg viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg>',
    maximize:
      '<svg class="aesdc-maximize" viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor"/></svg>' +
      '<svg class="aesdc-restore" viewBox="0 0 10 10"><path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" fill="none" stroke="currentColor"/></svg>',
    close: '<svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1.1"/></svg>',
  };
  const LABELS = { minimize: "Minimize", maximize: "Maximize", close: "Close" };

  // Not cached: in WebView2 this script runs before the page has a document element.
  const setFlag = (name, on) => {
    const root = document.documentElement;
    if (root) on ? root.setAttribute(name, "") : root.removeAttribute(name);
  };

  let controls = null;
  const makeControls = () => {
    const box = document.createElement("div");
    box.id = "aesdc-winctl";
    if (mac) return box; // macOS has its own traffic lights.
    for (const act of ["minimize", "maximize", "close"]) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.act = act;
      b.setAttribute("aria-label", LABELS[act]);
      b.title = LABELS[act];
      b.innerHTML = ICONS[act];
      box.append(b);
    }
    box.addEventListener("click", (e) => {
      const act = e.target instanceof Element && e.target.closest("button")?.dataset.act;
      if (!act) return;
      e.stopPropagation();
      const call = { minimize: win.minimize, maximize: win.toggleMaximize, close: win.close }[act];
      call().then(applyState, report(act));
    });
    box.addEventListener("mousedown", (e) => e.stopPropagation());
    return box;
  };

  let fallback = null;
  const makeFallback = () => {
    const bar = document.createElement("div");
    bar.id = "aesdc-titlebar";
    bar.dataset.aesdcBar = "fallback";
    const title = document.createElement("div");
    title.className = "aesdc-title";
    title.textContent = document.title && document.title !== "Discord" ? document.title : "Discord";
    bar.append(title);
    return bar;
  };

  const applyState = (s) => {
    if (!s) return;
    setFlag("data-aesdc-maximized", s.maximized);
    setFlag("data-aesdc-focused", s.focused);
    setFlag("data-aesdc-fullscreen", s.fullscreen || !!document.fullscreenElement);
  };
  const refreshState = () => win.state().then(applyState, report("reading the window state"));

  // Discord's top bar: the full-width strip at the top of the window.
  // Measured against #app-mount, not the window: while our own bar is showing, Discord's app sits
  // below it, so its top bar is not at the top of the window.
  const looksLikeBar = (el) => {
    const mount = document.getElementById("app-mount");
    if (!(el instanceof HTMLElement) || !mount || el.id === "aesdc-titlebar") return false;
    const m = mount.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.top - m.top <= 1 && r.left - m.left <= 1 && r.width >= m.width - 2 && r.height >= 20 && r.height <= 64;
  };
  // Discord's hashed class names come as "bar_c38106" or, in newer builds, "c38106-bar" (with
  // any prefix). True if one of the element's classes is one of these names in either form.
  const hasPart = (el, names) =>
    !!el.classList &&
    [...el.classList].some((c) => names.some((n) => c.startsWith(n + "_") || c.endsWith("-" + n) || c.endsWith("_" + n)));
  const clickable = 'button, [role="button"], a[href]';
  const findBar = () => {
    const mount = document.getElementById("app-mount");
    if (!mount) return null;
    // 1. By name: the 2024+ top bar, or the older Windows-app title bar, with a title bar's shape.
    for (const el of mount.querySelectorAll('[class*="bar"], [class*="Bar"]')) {
      if (hasPart(el, ["bar", "titleBar"]) && looksLikeBar(el)) return el;
    }
    // 2. By position: the widest bar-shaped element holding whatever sits in the app's top-right
    // corner (Discord's help button), as long as it has buttons of its own.
    const m = mount.getBoundingClientRect();
    let el = document.elementFromPoint(m.right - 14, m.top + 14);
    if (!el || !mount.contains(el) || el.closest("#aesdc-titlebar")) return null;
    let best = null;
    for (; el && el !== mount; el = el.parentElement) if (looksLikeBar(el) && el.querySelector(clickable)) best = el;
    return best;
  };
  // Where the buttons go inside the bar: its right-hand section if it has one.
  const trailingOf = (bar) => [...bar.children].reverse().find((c) => hasPart(c, ["trailing", "actions", "toolbar"])) || bar;
  // For bug reports: run __aesdcTitlebarInfo() in DevTools to see what the titlebar found.
  Object.defineProperty(window, "__aesdcTitlebarInfo", {
    value: () => {
      const mount = document.getElementById("app-mount");
      const m = mount && mount.getBoundingClientRect();
      const top = m && document.elementFromPoint(m.right - 14, m.top + 14);
      const chain = [];
      for (let el = top; el && el !== mount; el = el.parentElement) {
        const r = el.getBoundingClientRect();
        chain.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return { bar: bar ? bar.className : null, fallback: document.documentElement.hasAttribute("data-aesdc-fallback"), topRight: chain };
    },
  });

  let bar = null;
  const place = () => {
    if (!document.body) return;
    if (!document.getElementById("aesdc-style")) {
      const css = document.createElement("style");
      css.id = "aesdc-style";
      css.textContent = CSS;
      (document.head || document.documentElement).append(css);
    }
    controls ||= makeControls();
    fallback ||= makeFallback();
    if (!fallback.isConnected) document.body.append(fallback);
    // Nothing moved: skip the search, which runs after every change Discord makes to the page.
    if (bar && bar.isConnected && bar.contains(controls) && looksLikeBar(bar)) return;

    const found = findBar();
    if (bar && bar !== found) bar.removeAttribute("data-aesdc-bar");
    bar = found;
    if (bar) {
      bar.setAttribute("data-aesdc-bar", "discord");
      const into = trailingOf(bar);
      if (controls.parentElement !== into || into.lastElementChild !== controls) into.append(controls);
      setFlag("data-aesdc-fallback", false);
    } else {
      if (controls.parentElement !== fallback) fallback.append(controls);
      setFlag("data-aesdc-fallback", true);
    }
  };

  // Discord re-renders its bar often, so re-check after DOM changes (at most once a frame).
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      place();
    });
  };

  // Dragging: a press on an empty part of a bar moves the window, a double-click maximizes.
  const INTERACTIVE =
    'button, a, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="textbox"], [contenteditable="true"], [tabindex]:not([tabindex="-1"]), #aesdc-winctl';
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    const onBar = e.target.closest("[data-aesdc-bar]");
    if (!onBar || e.target.closest(INTERACTIVE)) return;
    e.preventDefault();
    const call = e.detail === 2 ? win.toggleMaximize : win.startDrag;
    call().then(applyState, report(e.detail === 2 ? "maximize" : "drag"));
  });

  const start = () => {
    document.documentElement.setAttribute("data-aesdc-titlebar", style);
    setFlag("data-aesdc-mac", mac);
    setFlag("data-aesdc-focused", document.hasFocus());
    place();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      schedule();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(refreshState, 120);
    });
    window.addEventListener("focus", () => setFlag("data-aesdc-focused", true));
    window.addEventListener("blur", () => setFlag("data-aesdc-focused", false));
    document.addEventListener("fullscreenchange", refreshState);
    refreshState();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
