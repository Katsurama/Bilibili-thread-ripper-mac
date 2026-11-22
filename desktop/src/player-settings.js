(function (root) {
  "use strict";
  if (location.origin === "https://bilipc.bilibili.com" && location.pathname === "/index.html") return;
  const api = root.__BTR_DESKTOP__, threads = [4, 8, 16, 32, 64, 128];
  const id = "btr-desktop-player-settings";
  let panel, unsubscribe, scheduled = false, opened = false, copyResetTimer = 0;
  const style = document.createElement("style");
  style.textContent = `
    #${id}{margin:0;color:#fff;font-size:12px;text-align:left}
    #${id} .btr-save-error{color:#ff8585;line-height:1.5}
    #${id} summary{display:flex;justify-content:space-between;gap:12px;height:16px;line-height:16px;margin:0 0 12px;cursor:pointer;list-style:none}
    #${id} summary::-webkit-details-marker{display:none}
    #${id} summary span{color:hsla(0,0%,100%,.6)}#${id} summary span:after{content:" ▸"}#${id} details[open] summary span:after{content:" ▾"}
  `;
  (document.head || document.documentElement).append(style);
  // Each BTR row is a copy of the client's own 视频比例 row with BTR's choices in it, so it looks
  // like the client's rows whatever the client changes. No such row: BTR adds nothing to the menu.
  const TEMPLATE = ":scope > .bpx-player-ctrl-setting-aspect";
  const caption = item => item.querySelector(".bui-radio-text") || item.querySelector(".bui-radio-label");
  function group(template, title, setting, options) {
    const section = template.cloneNode(true);
    // The client fills elements marked for translation with its own words.
    for (const marked of [section, ...section.querySelectorAll("[data-i18n]")]) marked.removeAttribute("data-i18n");
    (section.querySelector("[class*=title]") || section.firstElementChild).textContent = title;
    const list = section.querySelector(".bui-radio-group"), sample = list.querySelector(".bui-radio-item");
    list.replaceChildren(...options.map(([value, text]) => {
      const item = sample.cloneNode(true), input = item.querySelector("input");
      input.removeAttribute("checked"); input.checked = false;
      input.name = `btr-desktop-player-${setting}`; input.dataset.btrSetting = setting; input.value = String(value);
      caption(item).textContent = text;
      return item;
    }));
    return section;
  }
  // 复制诊断信息, as the browser version's settings panel does it: gather what each part of BTR
  // knows in this player window and let shared/diagnostic-report.js lay it out as English text for
  // an issue. No download address and no account data.
  function diagnostics() {
    const readErrors = [];
    const read = (name, fact, fallback = null) => { try { return fact(); } catch (error) { readErrors.push(`${name}: ${String(error?.message || error).slice(0, 160)}`); return fallback; } };
    return String(root.__BTR_DIAGNOSTIC_REPORT__.render({
      capturedAt: Date.now(), timeOrigin: performance.timeOrigin, now: performance.now(),
      btr: { version: api.version, channel: "stable", otherBuild: "", scriptManager: "", host: "desktop" },
      env: read("env", () => ({ userAgent: navigator.userAgent, language: navigator.language, viewport: `${root.innerWidth}x${root.innerHeight}`, page: `${location.origin}${location.pathname}` })),
      settings: api.getSettings(), site: null,
      video: read("video", () => JSON.parse(root.__biliThreadRipperDebug.report())),
      stats: read("stats", () => root.__biliThreadRipperDebug.getStats()),
      autoThreads: read("autoThreads", () => root.__BILI_IDM_DOWNLOADER_FACTORY__?.autoConcurrency?.status?.() ?? null),
      media: read("media", () => root.__BTR_RUNTIME_NOTICES__?.history?.() ?? [], []),
      live: [], readErrors
    }));
  }
  // The page may write the clipboard only while its window is in front; otherwise the client's
  // main process does it (payload/preload.cjs).
  const copyText = text => (navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : Promise.reject(Error("clipboard unavailable"))).catch(() => new Promise((resolve, reject) => {
    const channel = "__BTR_DESKTOP_UPDATE__", copyId = `${Date.now()}-${Math.random()}`;
    const answer = event => {
      if (event.source !== root || event.data?.channel !== channel || event.data.type !== "copied" || event.data.id !== copyId) return;
      root.removeEventListener("message", answer); clearTimeout(timer);
      if (event.data.ok) resolve(); else reject(Error("copy refused"));
    };
    const timer = setTimeout(() => { root.removeEventListener("message", answer); reject(Error("no answer")); }, 2000);
    root.addEventListener("message", answer);
    root.postMessage({ channel, type: "copy", id: copyId, text }, root.location.origin);
  }));
  function mount() {
    scheduled = false;
    const target = document.querySelector(".bpx-player-ctrl-setting-menu-right"), template = target?.querySelector(TEMPLATE);
    const sample = template?.querySelector(".bui-radio-group .bui-radio-item");
    if (!target || !sample?.querySelector("input") || !caption(sample)) { if (panel && !panel.isConnected) { unsubscribe?.(); unsubscribe = null; panel = null; } return; }
    if (panel?.parentElement === target) return;
    unsubscribe?.(); panel?.remove();
    panel = document.createElement("div"); panel.id = id;
    // One line in the client's menu, which is already long: the choices open under it.
    const fold = document.createElement("details"), summary = document.createElement("summary"), state = document.createElement("span");
    summary.append("线程撕裂者", state);
    // The client rebuilds its menu now and then: stay as the viewer left it.
    fold.open = opened; fold.addEventListener("toggle", () => { opened = fold.open; });
    const error = document.createElement("div"); error.className = "btr-save-error"; error.setAttribute("role", "status");
    fold.append(
      summary,
      group(template, "加速", "enabled", [["on", "开启"], ["off", "关闭"]]),
      group(template, "CDN", "mode", [["mainland", "大陆 CDN"], ["overseas", "海外 CDN"], ["custom", "自定义"]]),
      group(template, "并发线程", "concurrency", [["auto", "自动"], ...threads.map(value => [value, String(value)])]),
      // A button in the look of the client's own choices; it never stays picked.
      group(template, "诊断", "diagnostics", [["stats", "统计信息"], ["copy", "复制诊断信息"]]),
      error
    );
    panel.append(fold);
    panel.addEventListener("change", event => {
      const input = event.target; if (!(input instanceof HTMLInputElement) || !input.checked) return;
      const setting = input.dataset.btrSetting;
      if (setting === "diagnostics") {
        input.checked = false;
        if (input.value === "stats") {
          const statsPanel = root.__BILI_STATS_PANEL__;
          if (document.getElementById("__bilibili_thread_ripper_stats__")) statsPanel?.close?.();
          else statsPanel?.open?.();
          return;
        }
        if (input.value !== "copy") return;
        const text = caption(input.closest(".bui-radio-item"));
        clearTimeout(copyResetTimer);
        Promise.resolve().then(() => copyText(diagnostics())).then(() => "已复制", () => "复制失败").then(result => {
          if (text) text.textContent = result;
          copyResetTimer = setTimeout(() => { if (text) text.textContent = "复制诊断信息"; }, 2000);
        });
        return;
      }
      if (!["enabled", "mode", "concurrency"].includes(setting)) return;
      // "自动" switches 自动线程数 on; a number switches it off and sets that thread count.
      const patch = setting === "enabled" ? { enabled: input.value === "on" }
        : setting === "mode" ? { mode: input.value }
        : input.value === "auto" ? { autoConcurrency: true } : { autoConcurrency: false, concurrency: Number(input.value) };
      try { api.setSettings(patch); error.textContent = ""; }
      catch (_) { error.textContent = "设置保存失败，请检查客户端的数据目录是否可写。"; }
    });
    target.insertBefore(panel, target.querySelector(".bpx-player-ctrl-setting-others") || target.firstChild);
    unsubscribe = api.onSettings(settings => {
      for (const input of panel.querySelectorAll("[data-btr-setting]")) {
        if (input.dataset.btrSetting === "diagnostics") continue;
        const settingName = input.dataset.btrSetting;
        const shown = settingName === "enabled" ? (settings.enabled ? "on" : "off")
          : settingName === "concurrency" && settings.autoConcurrency ? "auto"
          : String(settings[settingName]);
        input.checked = input.value === shown;
      }
      state.textContent = settings.enabled
        ? `${{ mainland: "大陆 CDN", overseas: "海外 CDN", custom: "自定义 CDN" }[settings.mode]} · ${settings.autoConcurrency ? "自动线程" : `${settings.concurrency} 线程`}`
        : "已关闭";
    });
  }
  const observer = new MutationObserver(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(mount); } });
  observer.observe(document.documentElement, {childList:true,subtree:true});
  root.addEventListener("pagehide", () => { observer.disconnect(); unsubscribe?.(); clearTimeout(copyResetTimer); }, {once:true});
  mount();
})(globalThis);
