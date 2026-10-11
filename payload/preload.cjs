"use strict";
// Renderer preload, the same as the Windows build: relays the settings page's update and
// uninstall requests to the main process and injects the BTR bundle into the client pages.
// btr_mac.py replaces __BTR_BUNDLE__ with the bundle as a JSON string.
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
const code = __BTR_BUNDLE__;
let injected = false;
function inject() { if (injected || !document.documentElement) return; injected = true; observer.disconnect(); const script = document.createElement("script"); script.textContent = code; (document.head || document.documentElement).appendChild(script); script.remove(); }
const observer = new MutationObserver(inject); observer.observe(document, { childList: true, subtree: true }); inject();
})();
