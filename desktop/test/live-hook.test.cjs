"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const load = (nativeFetch, settings = {}) => {
  const listeners = {};
  class FakeXHR {
    static instances = [];
    constructor() { this.listeners = {}; this.status = 200; FakeXHR.instances.push(this); }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    open(method, url) { this.method = method; this.url = url; }
    send() { for (const fn of this.listeners.load || []) fn(); }
  }
  const document = {
    documentElement: { append() {}, contains() { return true; } },
    head: { append() {} },
    createElement() { return { style: {}, remove() {}, isConnected: false, setAttribute() {}, addEventListener() {} }; }
  };
  const context = vm.createContext({
    URL, Promise, AbortController, DOMException, Response, Headers, setTimeout, clearTimeout,
    document, location: new URL("https://live.bilibili.com/123"), fetch: nativeFetch,
    MutationObserver: class { observe() {} },
    XMLHttpRequest: FakeXHR,
    addEventListener(name, fn) { listeners[name] = fn; },
    __BTR_DESKTOP__: {
      getSettings: () => ({ enabled: true, liveEnabled: true, mode: "custom", customHosts: ["upos-sz-mirrorali.bilivideo.com"], ...settings }),
      onSettings(fn) { fn(this.getSettings()); return () => {}; }
    }
  });
  context.globalThis = context;
  for (const file of ["shared/range-core.js", "shared/live-core.js", "shared/cdn-resolver.js", "shared/live-hook.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
  return context;
};

test("live hook races a live segment on the selected CDN and falls back when it fails", async () => {
  const asked = [];
  const context = load(async (url) => {
    asked.push(url);
    if (url.includes("mirrorali")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    return new Response("", { status: 503 });
  });
  const response = await context.fetch("https://upos-sz-mirrorhw.bilivideo.com/live-bvc/room/seg.m4s?x=1");
  assert.equal(response.status, 200);
  assert.ok(asked.some(url => url.includes("mirrorali")));
});

test("live hook leaves non-live and disabled requests untouched", async () => {
  const asked = [];
  const context = load(async url => { asked.push(url); return new Response("", { status: 200 }); }, { liveEnabled: false });
  await context.fetch("https://upos-sz-mirrorhw.bilivideo.com/live-bvc/room/seg.m4s?x=1");
  assert.deepEqual(asked, ["https://upos-sz-mirrorhw.bilivideo.com/live-bvc/room/seg.m4s?x=1"]);
});

test("live hook races no more than three CDN nodes", async () => {
  const asked = [];
  const hosts = [
    "upos-sz-mirrorali.bilivideo.com",
    "upos-sz-mirrorhw.bilivideo.com",
    "upos-sz-mirrorbos.bilivideo.com",
    "upos-sz-mirrorbd.bilivideo.com",
    "upos-sz-mirror14b.bilivideo.com"
  ];
  const context = load(async url => {
    asked.push(String(url));
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(new Uint8Array([1]), { status: 200 });
  }, { mode: "custom", customHosts: hosts });
  const response = await context.fetch("https://upos-sz-mirrorcos.bilivideo.com/live-bvc/room/seg.m4s");
  assert.equal(response.status, 200);
  assert.equal(asked.length, 3);
});

test("live hook routes HLS XHR requests through a CDN node", () => {
  const context = load(async () => new Response(new Uint8Array([1]), { status: 200 }), {
    mode: "custom",
    customHosts: ["upos-sz-mirrorali.bilivideo.com"]
  });
  const xhr = new context.XMLHttpRequest();
  xhr.open("GET", "https://upos-sz-mirrorhw.bilivideo.com/live-bvc/room/index.m3u8");
  assert.match(xhr.url, /upos-sz-mirrorali\.bilivideo\.com/);
});

test("live hook caches a completed segment and prefetches only the playlist tail", async () => {
  const asked = [];
  const playlist = "#EXTM3U\n#EXT-X-MAP:URI=\"/live-bvc/room/init.m4s\"\n#EXTINF:1,\n/live-bvc/room/seg-1.m4s\n#EXTINF:1,\n/live-bvc/room/seg-2.m4s\n#EXTINF:1,\n/live-bvc/room/seg-3.m4s\n";
  const context = load(async url => {
    asked.push(String(url));
    if (String(url).endsWith(".m3u8")) return new Response(playlist, { status: 200 });
    return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
  });
  await context.fetch("https://upos-sz-mirrorhw.bilivideo.com/live-bvc/room/index.m3u8");
  await new Promise(resolve => setTimeout(resolve, 10));
  const before = asked.length;
  const response = await context.fetch("https://upos-sz-mirrorhw.bilivideo.com/live-bvc/room/seg-3.m4s");
  assert.equal(response.status, 200);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [4, 5, 6]);
  assert.equal(asked.length, before);
  assert.ok(asked.some(url => url.endsWith("/seg-2.m4s")));
  assert.ok(asked.some(url => url.endsWith("/seg-3.m4s")));
});
