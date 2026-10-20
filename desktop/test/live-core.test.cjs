"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const context = vm.createContext({ URL });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../shared/live-core.js"), "utf8"), context);
  return context.__BILI_LIVE_CORE__;
}

const playlist = "https://upos-sz-mirrorali.bilivideo.com/live-bvc/room/720p.m3u8";
const init = "https://upos-sz-mirrorali.bilivideo.com/live-bvc/room/init.m4s";
const segment = "https://upos-sz-mirrorali.bilivideo.com/live-bvc/room/seg-1.m4s";

test("live URLs are narrowly scoped", () => {
  const core = load();
  assert.equal(core.isLivePageUrl("https://live.bilibili.com/123"), true);
  assert.equal(core.isLivePageUrl("https://www.bilibili.com/video/BV1"), false);
  assert.equal(core.isLivePlaylistUrl(playlist), true);
  assert.equal(core.isLiveSegmentUrl(segment), true);
  assert.equal(core.isLiveSegmentUrl("https://upos-sz-mirrorali.bilivideo.com/upgcxcode/1.m4s"), false);
});

test("fMP4 media playlists resolve init and segment URLs", () => {
  const core = load();
  const parsed = core.parseM3u8(`#EXTM3U
#EXT-X-MAP:URI="../room/init.m4s"
#EXTINF:2.0,
seg-1.m4s
#EXTINF:2.0,
seg-2.m4s`, playlist);
  assert.equal(parsed.initSegment, init);
  assert.deepEqual(Array.from(parsed.segments), [
    segment,
    "https://upos-sz-mirrorali.bilivideo.com/live-bvc/room/seg-2.m4s"
  ]);
  assert.equal(core.parseM3u8("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8", playlist), null);
  assert.equal(core.parseM3u8("#EXTM3U\n#EXTINF:2,\nseg.ts", playlist), null);
});

test("the safety gate defaults off and rejects non-live or ranged requests", () => {
  const core = load();
  const base = { pageUrl: "https://live.bilibili.com/123", url: segment };
  assert.equal(core.shouldHandleRequest(base), false);
  assert.equal(core.shouldHandleRequest({ ...base, liveEnabled: true }), true);
  assert.equal(core.shouldHandleRequest({ ...base, liveEnabled: true, pageUrl: "https://bilipc.bilibili.com/player.html" }), false);
  assert.equal(core.shouldHandleRequest({ ...base, liveEnabled: true, headers: { Range: "bytes=0-1" } }), false);
  assert.equal(core.shouldHandleRequest({ ...base, liveEnabled: true, method: "POST" }), false);
});
