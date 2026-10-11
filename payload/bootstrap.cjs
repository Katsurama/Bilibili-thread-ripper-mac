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
