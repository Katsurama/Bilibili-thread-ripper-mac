(function (root) {
  "use strict";
  if (root.__BTR_DESKTOP__) return;
  const KEY = "BTR_Desktop.settings.v1";
  const listeners = new Set();
  // 0.9.1.2 moves everyone once to mainland CDN and 8 threads.
  const REVISION = 2, UPGRADE = { mode: "mainland", concurrency: 8 };
  const normalize = value => {
    const s = root.__BILI_RANGE_CORE__.normalizeSettings(value || {});
    // mode "custom" uses only the servers in customHosts; the shared core keeps Bilibili's
    // video servers and drops anything else.
    // 自动线程数 is on unless switched off, as in the browser version; concurrency is then only
    // the manual choice, used again when it is switched off.
    // The client only has the browser version's compatibility mode (src/page-hook.js).
    return { enabled: s.enabled, takeover: "compat", liveEnabled: s.liveEnabled, autoConcurrency: value?.autoConcurrency !== false, concurrency: s.concurrency, mode: s.mode, customHosts: s.customHosts, autoCheckUpdates: value?.autoCheckUpdates !== false, revision: REVISION };
  };
  let current;
  // macOS: the main process injects the live player code only while 直播加速（实验性） is on, so
  // it is told the switch when a client page starts and whenever it changes.
  const tellLive = () => root.postMessage({ channel: "__BTR_DESKTOP_UPDATE__", type: "live-config", enabled: current.liveEnabled === true }, root.location.origin);
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    const outdated = !!saved && saved.revision !== REVISION;
    current = normalize(outdated ? { ...saved, ...UPGRADE } : saved);
    if (outdated) localStorage.setItem(KEY, JSON.stringify(current));
  } catch (_) { current = normalize({}); }
  const emit = () => listeners.forEach(fn => { try { fn({ ...current, customHosts: current.customHosts.slice() }); } catch (error) { console.error("BTR settings listener", error); } });
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("BTR_Desktop.settings.v1") : null;
  const api = {
    version: root.__BTR_DESKTOP_RELEASE__?.version || "2026.11.10.1-d1",
    adapterRevision: root.__BTR_DESKTOP_RELEASE__?.adapterRevision || 1,
    getSettings: () => ({ ...current, customHosts: current.customHosts.slice() }),
    setSettings(patch) {
      const next = normalize({ ...current, ...patch });
      localStorage.setItem(KEY, JSON.stringify(next)); // Failure must not pretend to save.
      const liveChanged = next.liveEnabled !== current.liveEnabled;
      current = next; emit(); channel?.postMessage(current);
      if (liveChanged) tellLive();
      return api.getSettings();
    },
    resetSettings() {
      const next = normalize({});
      localStorage.setItem(KEY, JSON.stringify(next)); // Failure must not pretend to save.
      current = next; emit(); channel?.postMessage(current);
      tellLive();
      return api.getSettings();
    },
    onSettings(fn) { listeners.add(fn); fn(api.getSettings()); return () => listeners.delete(fn); },
    update: Object.freeze({ state: "idle", message: "从 GitHub 检查 BTR 更新" })
  };
  root.addEventListener("storage", event => {
    if (event.key !== KEY) return;
    try { current = normalize(JSON.parse(event.newValue || "{}")); emit(); } catch (_) {}
  });
  if (channel) channel.onmessage = event => { current = normalize(event.data); emit(); };
  Object.defineProperty(root, "__BTR_DESKTOP__", { value: api });
  tellLive();
})(globalThis);
