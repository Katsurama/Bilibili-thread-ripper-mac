"use strict";
// The desktop side of live acceleration: dist/live.js in a live frame (the switch, its saved
// state and the settings it hands live-hook.js), and the main-process injection in bootstrap.cjs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const LIVE = fs.readFileSync(path.join(__dirname, "../dist/live.js"), "utf8");
const BOOTSTRAP = fs.readFileSync(path.join(__dirname, "../../payload/bootstrap.cjs"), "utf8");

// A small stand-in for the live player page: the quality menu, localStorage and postMessage.
function livePage({ saved, href = "https://live.bilibili.com/blanc/1?liteVersion=true" } = {}) {
  const listeners = { message: [], storage: [] }, store = new Map(saved === undefined ? [] : [["BTR_Desktop.live.v1", saved]]);
  const posted = [];
  const nodes = [];
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.parent = null; this.attrs = {}; this.classList = { set: new Set(), toggle: (c, on) => on ? this.classList.set.add(c) : this.classList.set.delete(c), contains: c => this.classList.set.has(c) }; this.style = {}; this.hidden = false; this.textContent = ""; this.listeners = {}; nodes.push(this); }
    set className(value) { this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classList.set].join(" "); }
    set innerHTML(_value) {}
    get firstChild() { return this.children[0] || null; }
    get isConnected() { for (let n = this; n; n = n.parent) if (n === doc.documentElement) return true; return false; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    click() { for (const fn of this.listeners.click || []) fn({ stopPropagation() {} }); }
    append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
    prepend(...kids) { for (const k of kids.reverse()) { k.remove(); k.parent = this; this.children.unshift(k); } }
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter(k => k !== this); this.parent = null; } }
  }
  const doc = { documentElement: new Node("html"), head: new Node("head"), createElement: tag => new Node(tag), querySelector: sel => sel === ".quality-wrap .panel" ? panel : sel === ".quality-wrap .selected-qn" ? label : null };
  doc.documentElement.append(doc.head);
  const panel = new Node("div"), label = new Node("div");
  doc.documentElement.append(panel, label);
  const window = {
    location: new URL(href), document: doc, URL, console, Promise, setTimeout, clearTimeout, setInterval: () => 0,
    MutationObserver: class { observe() {} },
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)) },
    addEventListener: (type, fn) => (listeners[type] ||= []).push(fn),
    postMessage(data) { posted.push(data); for (const fn of listeners.message || []) fn({ source: window, data }); },
    fetch: async () => ({ ok: true }), AbortController, DOMException, Headers, Response, Request, performance: { now: () => 0 }
  };
  window.globalThis = window; window.window = window;
  vm.runInContext(LIVE, vm.createContext(window), { filename: "live.js" });
  const settings = () => posted.filter(m => m?.type === "settings").map(m => m.payload.liveEnabled);
  const row = nodes.find(n => n.classList.contains("btr-live-row"));
  const tag = nodes.find(n => n.classList.contains("btr-live-tag"));
  return { window, store, settings, row, tag, panel, label, fireStorage: () => (listeners.storage || []).forEach(fn => fn({ key: "BTR_Desktop.live.v1" })) };
}

test("switched on in the settings, live acceleration starts on; the switch in the quality menu turns it off and is remembered", () => {
  const page = livePage();
  assert.equal(page.panel.children[0], page.row, "the switch is the first row of the quality menu");
  assert.equal(page.label.children[0], page.tag, "the BTR tag sits in front of the quality");
  assert.deepEqual(page.settings(), [true], "live-hook.js is told it is on");
  assert.equal(page.row.getAttribute("aria-checked"), "true");
  assert.equal(page.window.__biliThreadRipperLiveInstalled, true, "live-hook.js is installed in the frame");
  page.row.click();
  assert.deepEqual(page.settings(), [true, false]);
  assert.equal(page.store.get("BTR_Desktop.live.v1"), JSON.stringify({ enabled: false }));
  assert.equal(page.tag.hidden, true, "no tag while off");
});

test("a switch turned off stays off in a new live room, and another window's change is followed", () => {
  const page = livePage({ saved: JSON.stringify({ enabled: false }) });
  assert.deepEqual(page.settings(), [false]);
  page.store.set("BTR_Desktop.live.v1", JSON.stringify({ enabled: true }));
  page.fireStorage();
  assert.deepEqual(page.settings(), [false, true]);
  assert.equal(page.row.getAttribute("aria-checked"), "true");
});

test("switched off in the settings, an open room stops and loses its switch; switched on again, it comes back", () => {
  const page = livePage();
  page.window.__BTR_LIVE_ALLOW__(false);
  assert.deepEqual(page.settings(), [true, false]);
  assert.equal(page.panel.children.includes(page.row), false);
  assert.equal(page.label.children.includes(page.tag), false);
  page.window.__BTR_LIVE_ALLOW__(true);
  assert.deepEqual(page.settings(), [true, false, true]);
  assert.equal(page.panel.children[0], page.row);
});

test("the live bundle leaves pages outside live.bilibili.com alone", () => {
  const page = livePage({ href: "https://bilipc.bilibili.com/player.html" });
  assert.equal(page.row, undefined);
  assert.equal(page.window.__biliThreadRipperLiveInstalled, undefined);
});

test("the live bundle runs once per document", () => {
  const page = livePage();
  vm.runInContext(LIVE, vm.createContext(page.window));
  assert.deepEqual(page.settings(), [true], "a second run sends nothing and adds no second switch");
  assert.equal(page.panel.children.filter(n => n === page.row).length, 1);
});

// bootstrap.cjs against a fake Electron: which frames get live.js, and when.
function runBootstrap() {
  const handlers = {}, ran = [], contentsHandlers = {}, ipc = {};
  const frame = url => ({ url, isDestroyed: () => false, executeJavaScript(code) { ran.push([new URL(url).pathname, code === "/* live */" ? "live.js" : code]); return Promise.resolve(); }, on(type, fn) { this[type] = fn; } });
  const blanc = frame("https://live.bilibili.com/blanc/1?liteVersion=true"), top = frame("https://live.bilibili.com/desktop/1"), other = frame("https://bilipc.bilibili.com/index.html");
  const contents = { on: (type, fn) => { contentsHandlers[type] = fn; }, mainFrame: { framesInSubtree: [top, blanc, other] } };
  const electron = {
    app: { on: (type, fn) => { handlers[type] = fn; }, whenReady: () => new Promise(() => {}) },
    session: {}, webFrameMain: { fromId: (_p, id) => [top, blanc, other][id] },
    webContents: { getAllWebContents: () => [contents] },
    ipcMain: { handle: (name, fn) => { ipc[name] = fn; } }
  };
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "btr-live-"));
  fs.writeFileSync(path.join(dir, "live.js"), "/* live */");
  fs.writeFileSync(path.join(dir, "maintain.cjs"), "exports.register = () => {}; exports.trusted = event => event.trusted === true;");
  const req = name => name === "electron" ? electron : name === "./maintain.cjs" ? require(path.join(dir, "maintain.cjs")) : require(name);
  vm.runInNewContext(`(function (require, __dirname, global, console) {${BOOTSTRAP}\n})`, { URL, Error })(req, dir, {}, { error() {} });
  handlers["web-contents-created"]({}, contents);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { contentsHandlers, blanc, ran, ipc, settle };
}

test("bootstrap injects nothing into live rooms until 直播加速（实验性） is on", async () => {
  const { contentsHandlers, ran, settle } = runBootstrap();
  contentsHandlers["dom-ready"]();
  await settle();
  assert.deepEqual(ran, []);
});

test("switched on, live.js goes to the live.bilibili.com frames, including the player iframe, and nothing else", async () => {
  const { contentsHandlers, blanc, ran, ipc, settle } = runBootstrap();
  assert.throws(() => ipc["btr-desktop:live-config"]({ trusted: false }, true), /Untrusted/, "only the client pages may switch it");
  ipc["btr-desktop:live-config"]({ trusted: true }, true);
  await settle();
  assert.deepEqual(ran, [["/desktop/1", "live.js"], ["/blanc/1", "live.js"], ["/desktop/1", "globalThis.__BTR_LIVE_ALLOW__?.(true)"], ["/blanc/1", "globalThis.__BTR_LIVE_ALLOW__?.(true)"]], "rooms already open get it at once");
  ran.length = 0;
  contentsHandlers["frame-created"]({}, { frame: blanc });
  blanc["dom-ready"]();
  contentsHandlers["did-frame-finish-load"]({}, false, 1, 2);
  await settle();
  assert.deepEqual(ran.filter(([, code]) => code === "live.js"), [["/blanc/1", "live.js"]], "the client page is never offered live.js");
  ran.length = 0;
  ipc["btr-desktop:live-config"]({ trusted: true }, false);
  await settle();
  assert.deepEqual(ran, [["/desktop/1", "globalThis.__BTR_LIVE_ALLOW__?.(false)"], ["/blanc/1", "globalThis.__BTR_LIVE_ALLOW__?.(false)"]], "switched off, open rooms are told to stop");
  ran.length = 0;
  contentsHandlers["dom-ready"]();
  await settle();
  assert.deepEqual(ran, [], "and new rooms get nothing");
});
