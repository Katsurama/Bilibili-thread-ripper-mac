"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const script = fs.readFileSync(path.join(__dirname, "../../install-mac.sh"), "utf8");

test("client-launched maintenance leaves the single relaunch to Terminal", () => {
  assert.match(script, /relaunch_after_action\(\) \{ \[ -z "\$FROM_APP" \] && relaunch; \}/);
  assert.equal((script.match(/relaunch_after_action/g) || []).length, 4);
  assert.match(script, /notify "BTR 已卸载，正在重新打开官方客户端"\n\s+relaunch_after_action/);
});

// maintain.cjs against a fake Electron: the update check reads only this repository's mac-version.json.
function updateCheck(macVersion, installedMac) {
  const os = require("node:os"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "btr-maintain-"));
  fs.copyFileSync(path.join(__dirname, "../../payload/maintain.cjs"), path.join(dir, "maintain.cjs"));
  fs.writeFileSync(path.join(dir, "installed.json"), JSON.stringify({ version: "2026.10.19.1-d1", macVersion: installedMac }));
  const requested = [], handlers = {};
  const net = { request({ url }) {
    requested.push(url.replace(/\?.*/, ""));
    const listeners = {};
    const request = { on: (type, fn) => { listeners[type] = fn; }, abort() {}, end() {
      const body = url.includes("mac-version.json") ? JSON.stringify({ schema: 1, version: macVersion }) : JSON.stringify({ schema: 1, version: "2099.1.1.1-d1" });
      const response = { statusCode: 200, on(type, fn) { if (type === "data") setImmediate(() => fn(Buffer.from(body))); if (type === "end") setImmediate(() => setImmediate(fn)); } };
      setImmediate(() => listeners.response(response));
    } };
    return request;
  } };
  const electron = { app: { once() {}, quit() {} }, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, dialog: {}, BrowserWindow: {}, net, shell: {} };
  require(path.join(dir, "maintain.cjs")).register(electron);
  const frame = { url: "https://bilipc.bilibili.com/index.html" };
  const event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } };
  return handlers["btr-desktop:update-check"](event).then(result => ({ result, requested }));
}

test("a new upstream BTR release alone is not offered: the BTR code ships with this repository", async () => {
  const { result, requested } = await updateCheck("2026.10.22.5", "2026.10.22.5");
  assert.equal(result.state, "current");
  assert.deepEqual(requested, ["https://raw.githubusercontent.com/Katsurama/Bilibili-thread-ripper-mac/main/mac-version.json"]);
});

test("a higher mac-version.json is offered, a lower one (a stale CDN copy) is not", async () => {
  assert.equal((await updateCheck("2026.10.22.6", "2026.10.22.5")).result.state, "available");
  assert.match((await updateCheck("2026.10.22.6", "2026.10.22.5")).result.message, /macOS 移植 2026\.10\.22\.6（当前 2026\.10\.22\.5）/);
  assert.equal((await updateCheck("2026.10.22.4", "2026.10.22.5")).result.state, "current");
});

test("update moves a copy cloned from the old GitHub address to the current one", () => {
  const { execFileSync } = require("node:child_process"), os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "btr-remote-"));
  const run = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  run("init", "-q"); run("remote", "add", "origin", "https://github.com/someone-old/Bilibili-thread-ripper-mac.git");
  // Only the remote fix of update(), without pulling or installing.
  const body = script.match(/\n  if \[ -d "\$HERE\/\.git" \]; then\n[\s\S]*?\n  fi\n/)[0];
  const self = script.match(/^SELF_URL=.*$/m)[0];
  execFileSync("/bin/bash", ["-c", `say() { :; }; HERE=${JSON.stringify(dir)}; ${self}\n${body}`]);
  assert.equal(run("remote", "get-url", "origin"), "https://github.com/Katsurama/Bilibili-thread-ripper-mac.git");
});

// The important-update dialog: maintain.cjs with a fake Electron whose dialog answers 稍后.
function launch(manifest, installedMac, autoEnabled) {
  const os = require("node:os"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "btr-critical-"));
  fs.copyFileSync(path.join(__dirname, "../../payload/maintain.cjs"), path.join(dir, "maintain.cjs"));
  fs.writeFileSync(path.join(dir, "installed.json"), JSON.stringify({ version: "2026.10.19.1-d1", macVersion: installedMac }));
  const dialogs = [], sent = [], handlers = {};
  const net = { request() {
    const listeners = {};
    return { on: (type, fn) => { listeners[type] = fn; }, abort() {}, end() {
      const body = JSON.stringify(manifest);
      setImmediate(() => listeners.response({ statusCode: 200, on(type, fn) { if (type === "data") setImmediate(() => fn(Buffer.from(body))); if (type === "end") setImmediate(() => setImmediate(fn)); } }));
    } };
  } };
  const electron = {
    app: { once() {}, quit() {} }, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, net, shell: {},
    BrowserWindow: { fromWebContents: () => null },
    dialog: { showMessageBox: async options => { dialogs.push(options); return { response: 1 }; } }
  };
  require(path.join(dir, "maintain.cjs")).register(electron);
  const frame = { url: "https://bilipc.bilibili.com/index.html" };
  const event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false, send: (_channel, value) => sent.push(value) } };
  handlers["btr-desktop:auto-config"](event, { enabled: autoEnabled });
  return new Promise(resolve => setTimeout(() => resolve({ dialogs, sent }), 2200));
}

test("an installed version below minVersion gets one dialog with the notice, even with auto check off", { timeout: 10000 }, async () => {
  const manifest = { schema: 1, version: "2026.10.22.7", minVersion: "2026.10.22.7", notice: "仓库地址已更换，请尽快更新。\u0007" };
  for (const autoEnabled of [true, false]) {
    const { dialogs } = await launch(manifest, "2026.10.22.6", autoEnabled);
    assert.equal(dialogs.length, 1, `auto check ${autoEnabled ? "on" : "off"}: one dialog per launch`);
    assert.match(dialogs[0].message, /2026\.10\.22\.7/);
    assert.match(dialogs[0].title, /BTR Desktop for macOS/, "the plugin names itself: the dialog sits over Bilibili's window");
    assert.match(dialogs[0].detail, /^这条提醒来自 BTR Desktop for macOS 插件/);
    assert.match(dialogs[0].detail, /\n\n仓库地址已更换，请尽快更新。\n\n/, "the notice is shown as plain text, control characters dropped");
    assert.deepEqual(dialogs[0].buttons, ["现在更新", "稍后"]);
  }
});

test("an ordinary update, or a version already at minVersion, gets no dialog", { timeout: 10000 }, async () => {
  assert.equal((await launch({ schema: 1, version: "2026.10.22.7" }, "2026.10.22.6", true)).dialogs.length, 0);
  assert.equal((await launch({ schema: 1, version: "2026.10.22.8", minVersion: "2026.10.22.7" }, "2026.10.22.7", true)).dialogs.length, 0);
});
