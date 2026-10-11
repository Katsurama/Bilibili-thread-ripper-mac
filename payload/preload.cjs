"use strict";
// Renderer preload, the same as the Windows build: relays the settings page's update and
// uninstall requests to the main process and injects the BTR bundle into the client pages.
// btr_mac.py fills in two placeholders below (each must appear exactly once in this file): the bundle
// as a JSON string, and the macOS port's version, the bundled BTR version and the upstream LICENSE text.
(() => {
if (!process.isMainFrame || location.origin !== "https://bilipc.bilibili.com" || !/^\/(index|player)\.html$/.test(location.pathname)) return;
const { ipcRenderer } = require("electron"), channel = "__BTR_DESKTOP_UPDATE__";
let checking = false, acting = false, epoch = 0, configEpoch = 0;
const send = result => window.postMessage({ channel, type: "result", result }, location.origin);
ipcRenderer.on("btr-desktop:maintenance-result", (_event, result) => send(result));
window.addEventListener("message", async event => {
  if (event.source !== window || event.data?.channel !== channel || event.data.type !== "configure-auto" || typeof event.data.enabled !== "boolean") return;
  const ticket = ++configEpoch;
  try {
    const result = await ipcRenderer.invoke("btr-desktop:auto-config", { enabled: event.data.enabled, changed: event.data.changed === true });
    if (ticket === configEpoch) window.postMessage({ channel, type: "auto-config", enabled: result.enabled }, location.origin);
  } catch (_) {}
});
window.addEventListener("message", async event => {
  if (event.source !== window || event.data?.channel !== channel || event.data.type !== "check" || checking || acting) return;
  checking = true; const ticket = epoch;
  try { const result = await ipcRenderer.invoke("btr-desktop:update-check"); if (ticket === epoch) send(result); }
  catch (_) { if (ticket === epoch) send({ state: "error", message: "更新检查失败，请稍后重试" }); }
  finally { checking = false; }
});
document.addEventListener("click", async event => {
  if (!event.isTrusted || acting || !event.target.closest?.("#btr-desktop-settings")) return;
  const button = event.target.closest?.("#btr-desktop-install-update,#btr-desktop-uninstall");
  if (!button || button.disabled) return;
  const remove = button.id === "btr-desktop-uninstall";
  acting = true; epoch++;
  send({ state: "confirming", message: remove ? "请确认是否卸载 BTR" : "请确认是否安装更新" });
  try { send(await ipcRenderer.invoke(remove ? "btr-desktop:uninstall" : "btr-desktop:update-install")); }
  catch (_) { send({ state: "error", message: remove ? "无法启动卸载，请在终端运行 install-mac.sh uninstall" : "无法启动更新，请在终端重新运行 install-mac.sh" }); }
  finally { acting = false; }
}, true);
// The settings section comes from the upstream bundle, which is used unchanged. Rename it to the
// macOS port, show the port's version, and add the notice and the upstream MIT license below the title.
const macInfo = __BTR_MAC_INFO__;
function macLink(text, key) {
  const link = document.createElement("a");
  link.href = "#"; link.textContent = text; link.className = "btr-mac-link";
  link.addEventListener("click", event => { event.preventDefault(); ipcRenderer.invoke("btr-desktop:open-link", key).catch(() => {}); });
  return link;
}
function macLine(...parts) {
  const line = document.createElement("div"); line.className = "btr-note btr-mac-line";
  for (const part of parts) line.append(part);
  return line;
}
function decorate() {
  // The catalog column is narrow: a short name there, the full name on hover and in the title.
  const nav = document.getElementById("btr-desktop-nav");
  if (nav && nav.textContent !== "BTR for macOS") { nav.textContent = "BTR for macOS"; nav.title = "BTR Desktop for macOS"; }
  const panel = document.getElementById("btr-desktop-settings"), title = panel?.querySelector("h4");
  if (!title || panel.querySelector(".btr-mac-about")) return;
  const version = title.querySelector(".btr-version");
  title.firstChild.textContent = "BTR Desktop for macOS";
  if (version) version.textContent = macInfo.macVersion || macInfo.btrVersion || "";
  const about = document.createElement("div"); about.className = "btr-mac-about";
  about.append(
    macLine("Bilibili 线程撕裂者桌面版的非官方 macOS 移植版本"),
    macLine(`此版本基于 Bilibili 线程撕裂者桌面版 ${macInfo.btrVersion || ""} 开发`),
    macLine("原作者明确表示不会做 macOS 版，请不要把这里的问题报到", macLink("原仓库", "upstream"), "，有问题请在", macLink("本仓库的 Issues", "issues"), "里反馈。"));
  const copyright = (macInfo.license || "").split("\n").find(line => /^Copyright/i.test(line.trim()));
  const license = document.createElement("details"); license.className = "btr-mac-license";
  const summary = document.createElement("summary");
  summary.textContent = `开源许可：Bilibili 线程撕裂者桌面版${copyright ? "（" + copyright.trim() + "）" : ""}以 MIT 许可证发布，本移植同样以 MIT 许可证发布`;
  license.append(summary);
  if (macInfo.license) { const text = document.createElement("pre"); text.textContent = macInfo.license; license.append(text); }
  else license.append(macLine("许可证全文见", macLink("原仓库", "upstream")));
  about.append(license);
  const style = document.createElement("style");
  // Upstream gives only buttons a pointer; checkboxes, their labels and the thread slider kept the arrow.
  style.textContent = `#btr-desktop-settings input[type=checkbox]:not(:disabled),#btr-desktop-settings label:has(input[type=checkbox]:not(:disabled)),#btr-desktop-settings input[type=range]:not(:disabled){cursor:pointer}
    #btr-desktop-settings .btr-mac-about{margin:-8px 0 18px}#btr-desktop-settings .btr-mac-line{margin:4px 0}
    #btr-desktop-settings .btr-mac-link{color:#ef77a3;text-decoration:none;margin:0 2px}#btr-desktop-settings .btr-mac-link:hover{text-decoration:underline}
    #btr-desktop-settings .btr-mac-license{margin-top:8px;color:var(--text3,#9499a0);font-size:12px}#btr-desktop-settings .btr-mac-license summary{cursor:pointer}
    #btr-desktop-settings .btr-mac-license pre{white-space:pre-wrap;margin:8px 0 0;padding:10px;border:1px solid var(--line_regular,#353638);border-radius:5px;font:12px/1.5 ui-monospace,Menlo,monospace;user-select:text}`;
  about.append(style);
  title.after(about);
}
// The settings page lives in the main window only; the player page changes constantly (danmaku).
if (location.pathname === "/index.html") new MutationObserver(decorate).observe(document, { childList: true, subtree: true });

const code = __BTR_BUNDLE__;
let injected = false;
function inject() { if (injected || !document.documentElement) return; injected = true; observer.disconnect(); const script = document.createElement("script"); script.textContent = code; (document.head || document.documentElement).appendChild(script); script.remove(); }
const observer = new MutationObserver(inject); observer.observe(document, { childList: true, subtree: true }); inject();
})();
