"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const script = fs.readFileSync(path.join(__dirname, "../../install-mac.sh"), "utf8");

test("the client version record uses the client's own algorithm: C locale + ctime.toString() md5", () => {
  // A changed app-update.yml ctime makes the client treat itself as reinstalled (settings reset,
  // hot update re-downloaded). install-mac.sh writes back the same value the client computes, so
  // it must stay byte-for-byte the client's: the C locale (the timezone name follows LANG) and
  // Date.ctime.toString() hashed with md5 as hex.
  assert.match(script, /LC_ALL=C LANG=C ELECTRON_RUN_AS_NODE=1/);
  assert.match(script, /require\("fs"\)\.statSync\(process\.argv\[1\]\)\.ctime\.toString\(\)/);
  assert.match(script, /require\("crypto"\)\.createHash\("md5"\)\.update\(s\)\.digest\("hex"\)/);
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

test("updating downloads from the public address, so no SSH key is asked for, and a failed download is reported", () => {
  assert.match(script, /git -C "\$HERE" pull --ff-only -q "\$SELF_URL" main; then exec .* --pulled; fi\n\s+exec .* --pull-failed/);
  assert.match(script, /if \[ -n "\$PULL_FAILED" \]; then\n\s+say "注意：没能从 GitHub 拉到最新版本/);
});

// install-mac.sh uninstall against a made-up client: it replaces a whole application, so it is run for real.
// macOS only: the script uses PlistBuddy, ditto and xattr.
function fakeClient() {
  const os = require("node:os"), { execFileSync } = require("node:child_process");
  const repo = path.resolve(__dirname, "../.."), dir = fs.mkdtempSync(path.join(os.tmpdir(), "btr-uninstall-"));
  const app = path.join(dir, "Applications/哔哩哔哩.app"), data = path.join(dir, "data"), backup = path.join(data, "backup/哔哩哔哩.app");
  const body = Buffer.from('"use strict";\n'), pkg = Buffer.from(JSON.stringify({ name: "bilibili", version: "1.17.3", main: "index.js" }));
  const header = Buffer.from(JSON.stringify({ files: { "package.json": { size: pkg.length, offset: "0" }, "index.js": { size: body.length, offset: String(pkg.length) } } }));
  const padded = Math.ceil((header.length + 4) / 4) * 4, prefix = Buffer.alloc(12 + padded);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(padded + 4, 4); prefix.writeUInt32LE(padded, 8); prefix.writeUInt32LE(header.length, 12); header.copy(prefix, 16);
  const official = Buffer.concat([prefix, pkg, body]);
  for (const root of [app, backup]) {
    fs.mkdirSync(path.join(root, "Contents/Resources"), { recursive: true }); fs.mkdirSync(path.join(root, "Contents/MacOS"));
    fs.writeFileSync(path.join(root, "Contents/Info.plist"), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.bilibili.bilibiliPC</string><key>CFBundleShortVersionString</key><string>1.17.3</string></dict></plist>\n');
    fs.writeFileSync(path.join(root, "Contents/Resources/app.asar"), official);
  }
  fs.writeFileSync(path.join(data, ".btr-mac-data"), ""); // the script only deletes inside a folder it marked as its own
  const asar = path.join(app, "Contents/Resources/app.asar");
  execFileSync("python3", ["-I", path.join(repo, "btr_mac.py"), "patch", path.join(backup, "Contents/Resources/app.asar"), path.join(repo, "desktop/dist/desktop.js"), asar, repo]);
  const env = { ...process.env, BTR_APP: app, BTR_DATA: data, BTR_CLIENT_RESOURCE: path.join(dir, "resource") };
  const uninstall = () => execFileSync("/bin/bash", [path.join(repo, "install-mac.sh"), "uninstall"], { env, stdio: "pipe", encoding: "utf8" });
  return { dir, app, asar, data, official, uninstall };
}

test("uninstall puts the backup back in place of the client and removes BTR's own files", { skip: process.platform !== "darwin" }, () => {
  const client = fakeClient();
  assert.notDeepEqual(fs.readFileSync(client.asar), client.official);
  client.uninstall();
  assert.deepEqual(fs.readFileSync(client.asar), client.official);
  assert.deepEqual(fs.readdirSync(path.dirname(client.app)), ["哔哩哔哩.app"], "no restore copy or old client left beside it");
  assert.ok(!fs.existsSync(client.data), "backup and data removed");
  fs.rmSync(client.dir, { recursive: true });
});

test("uninstall changes nothing when it cannot tell whether the client has BTR", { skip: process.platform !== "darwin" }, () => {
  const client = fakeClient();
  fs.writeFileSync(client.asar, "not an asar");
  assert.throws(client.uninstall, error => /读不出当前客户端的状态/.test(error.stderr));
  assert.equal(fs.readFileSync(client.asar, "utf8"), "not an asar");
  assert.ok(fs.existsSync(path.join(client.data, "backup")), "the backup is kept");
  fs.rmSync(client.dir, { recursive: true });
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
  const manifest = { schema: 1, version: "2026.10.22.7", minVersion: "2026.10.22.7", changelog: ["仓库地址已更换\u0007", "修复了一个安全问题", 3] };
  for (const autoEnabled of [true, false]) {
    const { dialogs } = await launch(manifest, "2026.10.22.6", autoEnabled);
    assert.equal(dialogs.length, 1, `auto check ${autoEnabled ? "on" : "off"}: one dialog per launch`);
    assert.match(dialogs[0].message, /2026\.10\.22\.7/);
    assert.match(dialogs[0].title, /BTR Desktop for macOS/, "the plugin names itself: the dialog sits over Bilibili's window");
    assert.match(dialogs[0].detail, /^这条提醒来自 BTR Desktop for macOS 插件/);
    assert.match(dialogs[0].detail, /\n\n更新内容：\n· 仓库地址已更换\n· 修复了一个安全问题$/, "the changelog closes the dialog, as plain text lines; control characters and non-strings dropped");
    assert.deepEqual(dialogs[0].buttons, ["现在更新", "稍后"]);
  }
});

test("an ordinary update, or a version already at minVersion, gets no dialog", { timeout: 10000 }, async () => {
  assert.equal((await launch({ schema: 1, version: "2026.10.22.7" }, "2026.10.22.6", true)).dialogs.length, 0);
  assert.equal((await launch({ schema: 1, version: "2026.10.22.8", minVersion: "2026.10.22.7" }, "2026.10.22.7", true)).dialogs.length, 0);
});
