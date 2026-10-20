"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadBootstrap() {
  const source = fs.readFileSync(path.join(__dirname, "../../payload/bootstrap.cjs"), "utf8");
  const appHandlers = {};
  const electron = {
    app: {
      on(name, handler) { appHandlers[name] = handler; },
      whenReady() { return Promise.resolve({ catch() {} }); },
    },
    session: { defaultSession: { getPreloads() { return []; }, setPreloads() {} } },
  };
  const context = {
    console,
    URL,
    global: {},
    require(name) {
      if (name === "electron") return electron;
      if (name === "path") return { join: (...parts) => parts.join("/") };
      if (name === "fs") return { readFileSync: () => "globalThis.__BTR_TEST_BUNDLE__ = true;" };
      if (name === "./maintain.cjs") return { register() {} };
      throw new Error(`unexpected require: ${name}`);
    },
    __dirname: "/btr-desktop",
  };
  vm.runInNewContext(`(function () { ${source}\n}).call(this);`, context);
  return appHandlers;
}

test("bootstrap injects the live bundle into the page main world", async () => {
  const handlers = loadBootstrap();
  const listeners = {};
  let url = "https://live.bilibili.com/123";
  const calls = [];
  const contents = {
    session: { getPreloads() { return []; }, setPreloads() {} },
    getURL() { return url; },
    executeJavaScript(code, userGesture) {
      calls.push({ code, userGesture });
      return Promise.resolve();
    },
    on(name, handler) { listeners[name] = handler; },
  };

  handlers["web-contents-created"]({}, contents);
  listeners["dom-ready"]();
  await Promise.resolve();
  listeners["dom-ready"]();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userGesture, true);
  assert.match(calls[0].code, /__BTR_TEST_BUNDLE__/);

  url = "https://live.bilibili.com/456";
  listeners["did-navigate-in-page"]({}, url, true);
  await Promise.resolve();
  assert.equal(calls.length, 2);
});

test("bootstrap ignores non-live pages", async () => {
  const handlers = loadBootstrap();
  const listeners = {};
  const contents = {
    session: { getPreloads() { return []; }, setPreloads() {} },
    getURL() { return "https://bilipc.bilibili.com/player.html"; },
    executeJavaScript() { throw new Error("should not inject"); },
    on(name, handler) { listeners[name] = handler; },
  };
  handlers["web-contents-created"]({}, contents);
  listeners["dom-ready"]();
  await Promise.resolve();
  assert.equal(typeof listeners["dom-ready"], "function");
});
