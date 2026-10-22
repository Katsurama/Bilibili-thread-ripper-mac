(function installLiveUi(root) {
  "use strict";
  // The live player's side of the desktop build: the 直播加速 switch at the top of the player's
  // quality menu, its status line, and a BTR tag in front of the current quality. The switch is
  // kept in this origin's localStorage, so every live window shares it; live-hook.js gets it as
  // its settings message, the same message the browser version's bridge sends. Above it sits
  // 直播加速（实验性） in the client settings: bootstrap.cjs injects this file only while that is
  // on, and calls __BTR_LIVE_ALLOW__(false) in rooms already open when it is switched off.
  if (!/^live\.bilibili\.com$/i.test(root.location?.hostname || "") && root.__BTR_TEST_ALLOW_LIVE__ !== true) return;
  if (root.__btrLiveUi) return;
  Object.defineProperty(root, "__btrLiveUi", { value: true });
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__", KEY = "BTR_Desktop.live.v1";
  const doc = root.document;

  // Whoever switched it on in the settings wants it, so it starts on until switched off here.
  const load = () => { try { return JSON.parse(root.localStorage.getItem(KEY) || "{}").enabled !== false; } catch (_) { return true; } };
  let enabled = load(), allowed = true, stats = null;
  const send = () => root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, liveEnabled: allowed && enabled } }, root.location.origin);
  Object.defineProperty(root, "__BTR_LIVE_ALLOW__", { value: value => { allowed = value === true; send(); mount(); render(); } });
  function setEnabled(value) {
    enabled = value;
    try { root.localStorage.setItem(KEY, JSON.stringify({ enabled })); } catch (_) {}
    send(); render();
  }
  root.addEventListener("storage", event => { if (event.key === KEY && load() !== enabled) { enabled = load(); send(); render(); } });

  // live-hook.js publishes its counters a quarter second after each change. The speed shown is
  // the accelerated bytes of the last five seconds, so it does not drop to zero between pieces.
  const samples = [];
  root.addEventListener("message", event => {
    if (event.source !== root || event.data?.channel !== CHANNEL || event.data.type !== "stats") return;
    stats = event.data.payload;
    samples.push([Date.now(), stats.acceleratedBytes || 0, stats.acceleratedRequests || 0]);
    render();
  });
  function recent() {
    const now = Date.now();
    while (samples.length && now - samples[0][0] > 5000) samples.shift();
    if (!samples.length) return { bps: 0, working: false };
    const [t0, b0, r0] = samples[0], [t1, b1, r1] = samples[samples.length - 1];
    return { bps: samples.length > 1 ? (b1 - b0) / Math.max(1, (t1 - t0) / 1000) : 0, working: samples.length > 1 ? r1 > r0 : now - t1 < 3000 && r1 > 0 };
  }

  const style = doc.createElement("style");
  style.textContent = `
    .btr-live-row{display:flex;align-items:center;justify-content:space-between;height:36px;padding:0 8px 0 12px;font-size:12px;color:#fff;cursor:pointer;user-select:none}
    .btr-live-row:hover{background:rgba(255,255,255,.08);border-radius:4px}
    .btr-live-switch{position:relative;flex:none;width:28px;height:16px;border-radius:8px;background:rgba(255,255,255,.3);transition:background .15s}
    .btr-live-switch::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:left .15s}
    .btr-live-row[aria-checked=true] .btr-live-switch{background:#ff6699}.btr-live-row[aria-checked=true] .btr-live-switch::after{left:14px}
    .btr-live-status{padding:0 8px 6px 12px;margin-bottom:4px;border-bottom:1px solid rgba(255,255,255,.12);font-size:11px;line-height:16px;color:rgba(255,255,255,.6)}
    .btr-live-tag{display:inline-block;margin-right:6px;padding:0 4px;border-radius:3px;background:rgba(255,255,255,.25);color:#fff;font-size:10px;line-height:14px;vertical-align:1px}
    .btr-live-tag.btr-on{background:#ff6699}`;
  const row = doc.createElement("div");
  row.className = "btr-live-row"; row.setAttribute("role", "switch"); row.tabIndex = 0;
  row.innerHTML = `<span>BTR 直播加速</span><span class="btr-live-switch"></span>`;
  const status = doc.createElement("div"); status.className = "btr-live-status";
  const tag = doc.createElement("span"); tag.className = "btr-live-tag"; tag.textContent = "BTR";
  // The menu belongs to the player; a click here must not also pick a quality or close it.
  row.addEventListener("click", event => { event.stopPropagation(); setEnabled(!enabled); });
  row.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setEnabled(!enabled); } });

  const mb = bps => (bps / 1048576).toFixed(2);
  function render() {
    const { bps, working } = recent();
    const on = enabled && working;
    const healthy = stats?.healthyCdns || 0, total = stats?.discoveredCdns || 0;
    row.setAttribute("aria-checked", String(enabled));
    status.textContent = !enabled ? "已关闭，使用 B 站原来的连接"
      : !stats?.acceleratedRequests ? "已开启，等待下一个分片…"
      : `${on ? "加速中" : "已开启"} · 已接管 ${stats.acceleratedRequests} 个分片 · ${mb(bps)} MB/s · ${healthy}/${total} 个节点可用`;
    tag.hidden = !enabled;
    tag.classList.toggle("btr-on", on);
    tag.title = on ? `BTR 直播加速中：${mb(bps)} MB/s，${healthy} 个节点可用` : "BTR 直播加速已开启，等待分片";
  }
  // The player draws its controls late and redraws them; put the pieces back whenever they go.
  function mount() {
    if (!allowed) { row.remove(); status.remove(); tag.remove(); return; }
    if (!style.isConnected && (doc.head || doc.documentElement)) (doc.head || doc.documentElement).append(style);
    const panel = doc.querySelector(".quality-wrap .panel");
    if (panel && panel.firstChild !== row) panel.prepend(row, status);
    const label = doc.querySelector(".quality-wrap .selected-qn");
    if (label && label.firstChild !== tag) label.prepend(tag);
  }
  // Danmaku changes the page many times a second, so a burst of changes is checked once. Not
  // with requestAnimationFrame: a window behind others gets no frames, and the menu would stay
  // without the switch. The one-second timer checks too, in case a change slipped through.
  let queued = false;
  new MutationObserver(() => { if (!queued) { queued = true; Promise.resolve().then(() => { queued = false; mount(); }); } })
    .observe(doc.documentElement, { childList: true, subtree: true });
  setInterval(() => { mount(); render(); }, 1000);
  mount(); render(); send();
})(globalThis);
