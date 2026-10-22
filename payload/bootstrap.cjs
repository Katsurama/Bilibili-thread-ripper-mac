"use strict";
// Main process entry, required from the client's index.js. Adds an ordinary Electron preload
// and the update / uninstall handlers. Never lets an error stop the official client.
// The client can also run a cached copy of this app.asar (made when it thought it was reinstalled),
// which would load BTR a second time. Only the first one, the entry in the app bundle, is used.
if (global.__btrMacBootstrap) return;
global.__btrMacBootstrap = __dirname;
const { app, session } = require("electron");
const path = require("path");
try { require("./maintain.cjs").register(require("electron")); }
catch (error) { console.error("BTR maintenance:", error.message); }
const preload = path.join(__dirname, "preload.cjs");
function attach(target) {
  try {
    const existing = target.getPreloads();
    if (!existing.includes(preload)) target.setPreloads([...existing, preload]);
  } catch (error) { console.error("BTR preload:", error.message); }
}
app.on("session-created", attach);
app.whenReady().then(() => attach(session.defaultSession)).catch(error => console.error("BTR preload:", error.message));

// Live rooms: the player sits in a live.bilibili.com iframe (/blanc/…) inside the live window
// (/desktop/…). Preloads do not run in iframes, so the main process hands live.js to every
// live.bilibili.com frame itself, and only while 直播加速（实验性） is on in the settings: the
// client pages report the switch when they start and when it changes (preload.cjs). live.js
// runs once per document; switched off, the rooms already open are told to stop.
const fs = require("fs");
let liveCode, liveAllowed = false;
function liveBundle() {
  if (liveCode === undefined) {
    try { liveCode = fs.readFileSync(path.join(__dirname, "live.js"), "utf8"); }
    catch (_) { liveCode = null; }
  }
  return liveCode;
}
const isLiveFrame = frame => { try { return !!frame && !frame.isDestroyed?.() && new URL(frame.url).origin === "https://live.bilibili.com"; } catch (_) { return false; } };
function injectLive(frame) {
  const code = liveAllowed && isLiveFrame(frame) && liveBundle();
  if (code) frame.executeJavaScript(code).then(() => frame.executeJavaScript("globalThis.__BTR_LIVE_ALLOW__?.(true)")).catch(() => {});
}
function liveFrames() {
  const { webContents } = require("electron");
  return webContents.getAllWebContents().flatMap(contents => { try { return contents.mainFrame.framesInSubtree.filter(isLiveFrame); } catch (_) { return []; } });
}
function setLiveAllowed(value) {
  if (value === liveAllowed) return;
  liveAllowed = value;
  for (const frame of liveFrames()) {
    if (value) injectLive(frame);
    else frame.executeJavaScript("globalThis.__BTR_LIVE_ALLOW__?.(false)").catch(() => {});
  }
}
function watchLive(contents) {
  try {
    const { webFrameMain } = require("electron");
    contents.on("frame-created", (_event, details) => details.frame?.on("dom-ready", () => injectLive(details.frame)));
    contents.on("dom-ready", () => { for (const frame of contents.mainFrame.framesInSubtree) injectLive(frame); });
    contents.on("did-frame-finish-load", (_event, _isMainFrame, processId, routingId) => injectLive(webFrameMain.fromId(processId, routingId)));
  } catch (error) { console.error("BTR live:", error.message); }
}
try {
  const { ipcMain } = require("electron"), { trusted } = require("./maintain.cjs");
  ipcMain.handle("btr-desktop:live-config", (event, enabled) => {
    if (!trusted(event) || typeof enabled !== "boolean") throw Error("Untrusted live settings");
    setLiveAllowed(enabled);
    return enabled;
  });
  app.on("web-contents-created", (_event, contents) => watchLive(contents));
} catch (error) { console.error("BTR live:", error.message); }
