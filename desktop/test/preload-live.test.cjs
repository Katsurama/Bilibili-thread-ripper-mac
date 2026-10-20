"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../../payload/preload.cjs"), "utf8")
  .replace("__BTR_BUNDLE__", JSON.stringify("globalThis.__TEST_BUNDLE__ = true;"))
  .replace("__BTR_MAC_INFO__", JSON.stringify({ macVersion: "test", btrVersion: "test", license: "test" }));

function load({ executeJavaScript }) {
  const attributes = new Map();
  const elements = new Map();
  const posted = [];
  const listeners = new Map();
  const document = {
    documentElement: {
      setAttribute(name, value) { attributes.set(name, value); },
      append(node) { node.isConnected = true; if (node.id) elements.set(node.id, node); }
    },
    body: null,
    createElement() {
      return {
        style: {},
        setAttribute() {},
        append() {},
        addEventListener() {},
        remove() { this.isConnected = false; },
        isConnected: false
      };
    },
    getElementById(id) { return elements.get(id) || null; },
    addEventListener() {}
  };
  document.body = document.documentElement;
  const window = {
    postMessage(message) { posted.push(message); },
    addEventListener(type, listener) { listeners.set(type, listener); }
  };
  const ipcRenderer = {
    on(type, listener) { listeners.set(type, listener); },
    invoke(type) {
      if (type === "btr-desktop:get-live-settings") return Promise.resolve({ enabled: true, liveEnabled: true });
      return Promise.resolve({});
    }
  };
  const context = {
    console,
    document,
    location: { origin: "https://live.bilibili.com", pathname: "/desktop/123" },
    localStorage: { setItem() {} },
    process: { isMainFrame: true },
    window,
    require(name) { assert.equal(name, "electron"); return { ipcRenderer, webFrame: { executeJavaScript } }; },
    __BTR_BUNDLE__: undefined,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(source, context, { filename: "payload/preload.cjs" });
  return { attributes, elements, posted, listeners, context };
}

test("live preload marks and executes the bundle", async () => {
  const calls = [];
  const state = load({ executeJavaScript: async code => { calls.push(code); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.attributes.get("data-btr-live-preload"), "loaded");
  assert.equal(state.attributes.get("data-btr-live-bundle"), "loaded");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /__TEST_BUNDLE__/);
  assert.equal(state.posted.at(-1).channel, "__BTR_DESKTOP_UPDATE__");
  assert.equal(state.posted.at(-1).type, "live-injection");
  assert.equal(state.posted.at(-1).state, "loaded");
});

test("live preload exposes an injection failure", async () => {
  const state = load({ executeJavaScript: async () => { throw new Error("blocked"); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.attributes.get("data-btr-live-preload"), "loaded");
  assert.equal(state.attributes.get("data-btr-live-bundle"), "failed");
  assert.equal(state.elements.get("btr-live-preload-status").textContent, "BTR 直播：注入失败");
  assert.equal(state.posted.at(-1).channel, "__BTR_DESKTOP_UPDATE__");
  assert.equal(state.posted.at(-1).type, "live-injection");
  assert.equal(state.posted.at(-1).state, "failed");
});
