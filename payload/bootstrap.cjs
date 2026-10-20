"use strict";
// Main process entry, required from the client's index.js. Adds an ordinary Electron preload
// and the update / uninstall handlers. Never lets an error stop the official client.
// The client can also run a cached copy of this app.asar (made when it thought it was reinstalled),
// which would load BTR a second time. Only the first one, the entry in the app bundle, is used.
if (global.__btrMacBootstrap) return;
global.__btrMacBootstrap = __dirname;
const { app, session } = require("electron");
const path = require("path");
const fs = require("fs");
try { require("./maintain.cjs").register(require("electron")); }
catch (error) { console.error("BTR maintenance:", error.message); }
const preload = path.join(__dirname, "preload.cjs");
let liveBundle;
function getLiveBundle() {
  if (liveBundle === undefined) {
    try { liveBundle = fs.readFileSync(path.join(__dirname, "desktop.js"), "utf8"); }
    catch (error) { liveBundle = null; console.error("BTR live bundle:", error.message); }
  }
  return liveBundle;
}
function isLiveUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/^(?:live|www)\.bilibili\.com$/.test(parsed.hostname)) return false;
    return parsed.hostname === "live.bilibili.com" ||
      /^\/(?:blackboard\/)?live(?:\/|$)/.test(parsed.pathname);
  }
  catch (_) { return false; }
}
function injectLivePage(contents) {
  if (!contents || typeof contents.getURL !== "function" || typeof contents.executeJavaScript !== "function") return;
  const url = contents.getURL();
  if (!isLiveUrl(url)) return;
  const bundle = getLiveBundle();
  if (!bundle) return;
  contents.__btrLiveInjectedUrl = contents.__btrLiveInjectedUrl === url ? url : null;
  if (contents.__btrLiveInjectedUrl === url) return;
  contents.__btrLiveInjectedUrl = url;
  contents.executeJavaScript(`${bundle}\n;globalThis.__BTR_LIVE_BUNDLE_LOADED__ = true;`, true)
    .catch(error => {
      if (contents.__btrLiveInjectedUrl === url) contents.__btrLiveInjectedUrl = null;
      console.error("BTR live injection:", error.message);
    });
}
function attach(target) {
  try {
    const existing = target.getPreloads();
    if (!existing.includes(preload)) target.setPreloads([...existing, preload]);
  } catch (error) { console.error("BTR preload:", error.message); }
}
function bindContents(contents) {
  if (!contents || contents.__btrLiveBound) return;
  contents.__btrLiveBound = true;
  attach(contents.session);
  const inject = () => injectLivePage(contents);
  contents.on?.("dom-ready", inject);
  contents.on?.("did-finish-load", inject);
  contents.on?.("did-navigate", inject);
  contents.on?.("did-navigate-in-page", (_navigationEvent, _url, isMainFrame) => {
    if (isMainFrame !== false) inject();
  });
}
app.on("session-created", attach);
app.on("web-contents-created", (_event, contents) => {
  bindContents(contents);
});
app.on("browser-window-created", (_event, window) => bindContents(window?.webContents));
app.whenReady().then(() => {
  attach(session.defaultSession);
  for (const contents of require("electron").webContents?.getAllWebContents?.() || []) bindContents(contents);
}).catch(error => console.error("BTR preload:", error.message));
