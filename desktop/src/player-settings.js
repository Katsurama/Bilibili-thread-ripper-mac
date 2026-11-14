(function (root) {
  "use strict";
  const api = root.__BTR_DESKTOP__, threads = [4, 8, 16, 32, 64, 128];
  const id = "btr-desktop-player-settings";
  let panel, unsubscribe, scheduled = false, opened = false;
  const style = document.createElement("style");
  style.textContent = `
    /* The client's own measures (its rows: title 16px + 4px, buttons 19px + 12px, 4px between buttons). */
    #${id}{margin:0;color:#fff;font-size:12px;text-align:left}
    #${id} .btr-native-setting-group{margin:0 0 12px}
    #${id} .btr-native-setting-title{height:16px;line-height:16px;margin:0 0 4px;color:#fff}
    #${id} .bui-radio-group{display:flex!important;flex-wrap:nowrap!important;gap:4px!important;margin:0!important}
    #${id} .bui-radio-item{flex:1 1 0!important;min-width:0!important;margin:0!important}
    #${id} .btr-save-error{color:#ff8585;line-height:1.5}
    #${id} summary{display:flex;justify-content:space-between;gap:12px;height:16px;line-height:16px;margin:0 0 12px;cursor:pointer;list-style:none}
    #${id} summary::-webkit-details-marker{display:none}
    #${id} summary span{color:hsla(0,0%,100%,.6)}#${id} summary span:after{content:" ▸"}#${id} details[open] summary span:after{content:" ▾"}
  `;
  (document.head || document.documentElement).append(style);
  // Keep the official player's own radio styling and secondary settings menu.
  function group(title, setting, options) {
    const section = document.createElement("div"); section.className = "btr-native-setting-group";
    const heading = document.createElement("div"); heading.className = "btr-native-setting-title"; heading.textContent = title;
    const content = document.createElement("div"); content.className = "bui bui-radio bui-dark";
    content.innerHTML = '<div class="bui-area"><div class="bui-radio-wrap bui-radio-button"><div class="bui-radio-group"></div></div></div>';
    for (const [value, text] of options) {
      const label = document.createElement("label"); label.className = "bui-radio-item";
      const input = document.createElement("input"); input.type = "radio"; input.className = "bui-radio-input";
      input.name = `btr-desktop-player-${setting}`; input.dataset.btrSetting = setting; input.value = String(value);
      const body = document.createElement("span"); body.className = "bui-radio-label";
      const caption = document.createElement("span"); caption.className = "bui-radio-text"; caption.textContent = text;
      body.append(caption); label.append(input, body); content.querySelector(".bui-radio-group").append(label);
    }
    section.append(heading, content); return section;
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
  const copyText = text => navigator.clipboard.writeText(text).catch(() => new Promise((resolve, reject) => {
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
    const target = document.querySelector(".bpx-player-ctrl-setting-menu-right");
    if (!target) { if (panel && !panel.isConnected) { unsubscribe?.(); unsubscribe = null; panel = null; } return; }
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
      group("CDN", "mode", [["mainland", "大陆 CDN"], ["overseas", "海外 CDN"], ["custom", "自定义"]]),
      group("并发线程", "concurrency", [["auto", "自动"], ...threads.map(value => [value, String(value)])]),
      // A button in the look of the client's own choices; it never stays picked.
      group("诊断", "diagnostics", [["copy", "复制诊断信息"]]),
      error
    );
    panel.append(fold);
    panel.addEventListener("change", event => {
      const input = event.target; if (!(input instanceof HTMLInputElement) || !input.checked) return;
      const setting = input.dataset.btrSetting;
      if (setting === "diagnostics") {
        input.checked = false;
        const caption = input.parentElement.querySelector(".bui-radio-text");
        copyText(diagnostics()).then(() => "已复制", () => "复制失败").then(text => { caption.textContent = text; setTimeout(() => { caption.textContent = "复制诊断信息"; }, 2000); });
        return;
      }
      if (setting !== "mode" && setting !== "concurrency") return;
      // "自动" switches 自动线程数 on; a number switches it off and sets that thread count.
      const patch = setting === "mode" ? { mode: input.value }
        : input.value === "auto" ? { autoConcurrency: true } : { autoConcurrency: false, concurrency: Number(input.value) };
      try { api.setSettings(patch); error.textContent = ""; }
      catch (_) { error.textContent = "设置保存失败，请检查客户端的数据目录是否可写。"; }
    });
    target.insertBefore(panel, target.querySelector(".bpx-player-ctrl-setting-others") || target.firstChild);
    unsubscribe = api.onSettings(settings => {
      for (const input of panel.querySelectorAll("[data-btr-setting]")) {
        if (input.dataset.btrSetting === "diagnostics") continue;
        const shown = input.dataset.btrSetting === "concurrency" && settings.autoConcurrency ? "auto" : String(settings[input.dataset.btrSetting]);
        input.checked = input.value === shown;
      }
      state.textContent = `${{ mainland: "大陆 CDN", overseas: "海外 CDN", custom: "自定义 CDN" }[settings.mode]} · ${settings.autoConcurrency ? "自动线程" : `${settings.concurrency} 线程`}`;
    });
  }
  const observer = new MutationObserver(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(mount); } });
  observer.observe(document.documentElement, {childList:true,subtree:true});
  root.addEventListener("pagehide", () => { observer.disconnect(); unsubscribe?.(); }, {once:true});
  mount();
})(globalThis);
