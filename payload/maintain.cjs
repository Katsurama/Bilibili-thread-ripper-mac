"use strict";
// macOS counterpart of the Windows update-main.cjs: the settings page asks over IPC, the main
// process checks the upstream manifest, confirms with a dialog, starts install-mac.sh in the
// background and quits the client. The script waits for the client to exit, does the work and
// opens the client again. IPC channel names and result states match the Windows build, so the
// shared settings page works unchanged. Besides the upstream BTR manifest it also reads this
// repository's mac-version.json, so changes to the macOS port are offered as updates too.
const path = require("path"), fs = require("fs");
const { spawn } = require("child_process");
const MANIFEST = "https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/latest.json";
const MAC_MANIFEST = "https://raw.githubusercontent.com/luitao666-arch/Bilibili-thread-ripper-mac/main/mac-version.json";
const VERSION = /^\d+\.\d+\.\d+\.\d+-d[1-9]\d*$/, MAC_VERSION = /^\d+\.\d+\.\d+\.\d+$/;
// GitHub raw files are cached for a few minutes on several CDN nodes, so a check can see an older
// mac-version.json than the one installed. Only a higher macOS version counts as an update.
function newerMac(remote, local) {
  if (!MAC_VERSION.test(local || "")) return true;
  const a = remote.split(".").map(Number), b = local.split(".").map(Number);
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
const INTERVAL = 30 * 60 * 1000, STARTUP = 1500;

function trusted(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  try { const url = new URL(frame.url); return url.origin === "https://bilipc.bilibili.com" && ["/index.html", "/player.html"].includes(url.pathname); }
  catch (_) { return false; }
}

// electron.net follows the system proxy, unlike Node's https.
function getJson(net, url) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url: url + "?t=" + Date.now(), redirect: "error", useSessionCookies: false });
    const timer = setTimeout(() => { request.abort(); reject(Error("更新检查超时，请稍后再试")); }, 8000);
    request.on("response", response => {
      if (response.statusCode !== 200) { clearTimeout(timer); response.on("data", () => {}); return reject(Error(`更新检查失败，HTTP ${response.statusCode}`)); }
      const chunks = []; let size = 0;
      response.on("data", chunk => { size += chunk.length; if (size > 65536) { clearTimeout(timer); request.abort(); reject(Error("更新清单过大")); } else chunks.push(chunk); });
      response.on("end", () => { clearTimeout(timer); try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (_) { reject(Error("更新清单格式错误")); } });
      response.on("error", error => { clearTimeout(timer); reject(error); });
    });
    request.on("error", error => { clearTimeout(timer); reject(error); });
    request.end();
  });
}

function register(electron) {
  const { app, ipcMain, dialog, BrowserWindow, net } = electron;
  const installed = JSON.parse(fs.readFileSync(path.join(__dirname, "installed.json"), "utf8"));
  let pending = null, latest = null, checkedAt = 0, operation = "";
  let autoEnabled = null, timer = null, generation = 0, stopped = false;
  const windows = new Map();
  const remember = event => windows.set(event.sender, event);
  function activeEvents() {
    return [...windows.values()].filter(event => {
      if (event.sender.isDestroyed() || !trusted(event)) { windows.delete(event.sender); return false; }
      return true;
    });
  }
  function publish(result) { for (const event of activeEvents()) event.sender.send("btr-desktop:maintenance-result", result); return result; }
  const busy = () => ({ state: operation, message: "正在处理 BTR 操作，请稍候" });

  async function inspect() {
    if (pending) return pending;
    if (latest && Date.now() - checkedAt < 3000) return latest;
    // The macOS manifest is optional: when it cannot be read, the upstream result still counts.
    pending = Promise.all([getJson(net, MANIFEST), getJson(net, MAC_MANIFEST).catch(() => null)]).then(([value, mac]) => {
      if (!value || value.schema !== 1 || !VERSION.test(value.version)) throw Error("更新清单无效");
      const macVersion = mac?.schema === 1 && MAC_VERSION.test(mac.version) ? mac.version : null;
      // Upstream rule: any difference counts, including a rollback.
      const btrChanged = value.version !== installed.version;
      const macChanged = macVersion !== null && newerMac(macVersion, installed.macVersion);
      const found = [], label = [];
      if (btrChanged) { found.push(`BTR ${value.version}（当前 ${installed.version || "未知"}）`); label.push(value.version); }
      if (macChanged) { found.push(`macOS 移植 ${macVersion}（当前 ${installed.macVersion || "未知"}）`); label.push(`macOS ${macVersion}`); }
      latest = found.length
        ? { state: "available", manifest: { version: label.join(" + ") }, message: `发现 ${found.join("，")}` }
        : { state: "current", manifest: { version: value.version }, message: "当前已是最新版本" };
      checkedAt = Date.now();
      return latest;
    }).finally(() => { pending = null; });
    return pending;
  }

  // Background checks only report; installing always needs a click and a confirmation.
  function schedule(delay = INTERVAL) {
    clearTimeout(timer);
    const ticket = ++generation;
    if (!autoEnabled || stopped) return;
    timer = setTimeout(async () => {
      try { if (!operation && activeEvents().length) { const result = await inspect(); if (ticket === generation && !operation) publish(result); } }
      catch (_) { /* Retry next interval. */ }
      finally { if (ticket === generation) schedule(); }
    }, delay);
    timer.unref?.();
  }
  app.once("before-quit", () => { stopped = true; generation++; clearTimeout(timer); });

  ipcMain.handle("btr-desktop:auto-config", (event, value) => {
    if (!trusted(event) || typeof value?.enabled !== "boolean") throw Error("Untrusted update settings");
    remember(event);
    if (autoEnabled === null || (value.changed === true && autoEnabled !== value.enabled)) { autoEnabled = value.enabled; schedule(STARTUP); }
    return { enabled: autoEnabled };
  });

  ipcMain.handle("btr-desktop:update-check", async event => {
    if (!trusted(event)) throw Error("Untrusted update sender");
    remember(event);
    if (operation) return busy();
    try { const result = await inspect(); return operation ? busy() : result; }
    catch (error) { return operation ? busy() : { state: "error", message: String(error.message).slice(0, 200) }; }
  });

  async function maintain(event, remove) {
    if (!trusted(event)) return { state: "error", message: "无法处理此窗口的 BTR 操作" };
    if (operation) return busy();
    remember(event);
    operation = "confirming"; let started = false;
    try {
      // Uninstall is local and must also work when GitHub is unreachable.
      const result = remove ? null : await inspect();
      if (!remove && result.state !== "available") return result;
      const options = remove
        ? { type: "warning", title: "卸载 BTR", message: "确定卸载 BTR？", detail: "将关闭哔哩哔哩，在“终端”里用安装前的备份还原官方客户端，完成后重新打开。不会删除账号、缓存和个人设置。", buttons: ["卸载 BTR", "取消"], defaultId: 1, cancelId: 1, noLink: true }
        : { type: "question", title: "检测到新的 BTR 线程撕裂者更新", message: `版本 ${result.manifest.version}`, detail: "将从 BTR Desktop 官方仓库获取新版本，并更新 macOS 安装脚本。确认后会关闭哔哩哔哩，在“终端”里完成更新，完成后自动重新打开。", buttons: ["安装更新", "取消"], defaultId: 1, cancelId: 1, noLink: true };
      publish({ state: "confirming", message: remove ? "请确认是否卸载 BTR" : "请确认是否安装更新" });
      const parent = BrowserWindow.fromWebContents(event.sender);
      const answer = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      if (answer.response !== 0) return publish(remove ? { ...(latest || { state: "idle" }), message: "已取消卸载 BTR" } : { ...result, message: "已取消更新" });
      if (!installed.installRoot || !path.isAbsolute(installed.installRoot)) throw Error("找不到 BTR 安装目录，请在终端重新运行 install-mac.sh");
      const script = path.join(installed.installRoot, "install-mac.sh");
      if (!fs.existsSync(script)) throw Error(`找不到 ${script}，请重新下载 macOS 安装脚本`);
      const environment = { ...process.env };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = spawn("/bin/bash", [script, remove ? "uninstall" : "update", "--from-app", String(process.pid)], { detached: true, stdio: "ignore", cwd: installed.installRoot, env: environment });
      // The script only hands the work to Terminal and exits; wait for that before quitting, because
      // processes started by the client are stopped soon after it exits.
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.unref(); reject(Error("打开终端超时，请在终端运行 install-mac.sh " + (remove ? "uninstall" : "update"))); }, 15000);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", code => { clearTimeout(timer); resolve(code); });
      });
      if (code !== 0) throw Error("无法打开终端，请在终端运行 install-mac.sh " + (remove ? "uninstall" : "update"));
      started = true; operation = remove ? "uninstalling" : "installing";
      publish({ state: operation, message: remove ? "正在关闭客户端，将在终端里卸载 BTR，完成后自动重新打开" : "正在关闭客户端，将在终端里安装更新，完成后自动重新打开" });
      // The script waits for this process to exit before touching the app bundle.
      // Terminal waits for this process to exit before touching the app bundle.
      setTimeout(() => { app.quit(); setTimeout(() => app.exit(0), 3000).unref?.(); }, 1200);
      return { state: operation, message: remove ? "正在卸载 BTR" : "正在安装更新" };
    } catch (error) { return publish({ state: "error", message: String(error.message).slice(0, 200) }); }
    finally { if (!started) operation = ""; }
  }
  ipcMain.handle("btr-desktop:update-install", event => maintain(event, false));
  ipcMain.handle("btr-desktop:uninstall", event => maintain(event, true));
}
module.exports = { register, trusted };
