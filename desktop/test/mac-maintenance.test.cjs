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
  assert.deepEqual(requested, ["https://raw.githubusercontent.com/luitao666-arch/Bilibili-thread-ripper-mac/main/mac-version.json"]);
});

test("a higher mac-version.json is offered, a lower one (a stale CDN copy) is not", async () => {
  assert.equal((await updateCheck("2026.10.22.6", "2026.10.22.5")).result.state, "available");
  assert.match((await updateCheck("2026.10.22.6", "2026.10.22.5")).result.message, /macOS 移植 2026\.10\.22\.6（当前 2026\.10\.22\.5）/);
  assert.equal((await updateCheck("2026.10.22.4", "2026.10.22.5")).result.state, "current");
});
