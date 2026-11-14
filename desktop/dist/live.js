/*! live-core.js and live-hook.js: Bilibili 线程撕裂者, https://github.com/MrTangLuyao/Bilibili-thread-ripper

MIT License

Copyright (c) 2026 Bilibili-thread-ripper contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
(function () {
if (globalThis.__BTR_LIVE_BUNDLE__) return;
Object.defineProperty(globalThis, "__BTR_LIVE_BUNDLE__", { value: "2026.11.10.1-d1" });

/* shared/range-core.js */
(function installRangeCore(root) {
  "use strict";

  const MEDIA_SUFFIX_RE = /\.(?:m4s|mp4|flv)$/i;
  const MEDIA_HOST_RE = /(?:^|\.)(?:bilivideo\.(?:com|cn|net)|akamaized\.net|szbdyd\.com|hdslb\.com|xycdn\.com|mountaintoys\.cn|nexusedgeio\.com|ahdohpiechei\.com)$/i;

  function parseByteRange(value) {
    if (typeof value !== "string") return null;
    const match = /^(\d+)-(\d+)$/.exec(value.trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    return { start, end, length: end - start + 1 };
  }

  function parseRangeHeader(value) {
    if (typeof value !== "string") return null;
    const match = /^bytes=(\d+)-(\d+)$/i.exec(value.trim());
    return match ? parseByteRange(`${match[1]}-${match[2]}`) : null;
  }

  function parseContentRange(value) {
    if (typeof value !== "string") return null;
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === "*" ? null : Number(match[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    if (total !== null && (!Number.isSafeInteger(total) || total <= end)) return null;
    return { start, end, total, length: end - start + 1 };
  }

  function splitRange(start, end, concurrency, minChunkBytes = 128 * 1024) {
    const length = end - start + 1;
    const limit = Math.max(1, Math.min(512, Math.trunc(concurrency) || 1));
    const minimum = Math.max(32 * 1024, Math.trunc(minChunkBytes) || 128 * 1024);
    const count = Math.max(1, Math.min(limit, Math.ceil(length / minimum)));
    const base = Math.floor(length / count);
    const remainder = length % count;
    const pieces = [];
    let cursor = start;
    for (let index = 0; index < count; index += 1) {
      const size = base + (index < remainder ? 1 : 0);
      pieces.push({ index, start: cursor, end: cursor + size - 1, length: size });
      cursor += size;
    }
    return pieces;
  }

  function concatChunks(chunks, expectedLength) {
    const output = new Uint8Array(expectedLength);
    let offset = 0;
    for (const chunk of chunks) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (offset + bytes.byteLength > expectedLength) throw new RangeError("子区间超出目标长度");
      output.set(bytes, offset);
      offset += bytes.byteLength;
    }
    if (offset !== expectedLength) throw new RangeError(`子区间长度不符：${offset}/${expectedLength}`);
    return output;
  }

  function isBilibiliMediaUrl(value) {
    try {
      const url = new URL(value, root.location?.href);
      return url.protocol === "https:" && MEDIA_SUFFIX_RE.test(url.pathname) && MEDIA_HOST_RE.test(url.hostname);
    } catch (_error) {
      return false;
    }
  }

  // A server added by hand in the custom CDN mode. Only its host name is kept, and only for
  // the Bilibili video servers isBilibiliMediaUrl accepts: the signed download addresses
  // must never be sent to anyone else.
  function normalizeCdnHost(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text || text.length > 253) return "";
    let host = "";
    try { host = new URL(/^[a-z][a-z\d+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname; }
    catch (_error) { return ""; }
    return /^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/.test(host) && MEDIA_HOST_RE.test(host) ? host : "";
  }

  function normalizeSettings(input) {
    const source = input && typeof input === "object" ? input : {};
    const allowed = [4, 8, 16, 32, 64, 128];
    const requested = Math.trunc(Number(source.concurrency));
    return {
      enabled: source.enabled !== false,
      theme: ["light", "dark"].includes(source.theme) ? source.theme : "auto",
      // The live module on live.bilibili.com; the master switch above still rules. Off unless
      // switched on: a viewer who never chose keeps Bilibili's own live player.
      liveEnabled: source.liveEnabled === true,
      // 剧集加速: episode pages (/bangumi/play/ep… and ss…: anime, films, documentaries, …),
      // sped up in the compatibility mode only.
      episodeEnabled: source.episodeEnabled !== false,
      // 阻止使用国际版: keeps the viewer on Bilibili's domestic site (bilibili-site.js). Off unless
      // switched on.
      blockInternational: source.blockInternational === true,
      // "full" replaces Bilibili's playback core; "compat" leaves it in charge and only
      // downloads its media requests.
      takeover: source.takeover === "compat" ? "compat" : "full",
      mode: ["overseas", "custom"].includes(source.mode) ? source.mode : "mainland",
      customHosts: (Array.isArray(source.customHosts) ? source.customHosts : [])
        .map(normalizeCdnHost)
        .filter((host, index, all) => host && all.indexOf(host) === index)
        .slice(0, 32),
      // The round button in the page corner that opens the settings panel.
      floatingButton: source.floatingButton !== false,
      // Where the viewer dragged it, as shares of the window (0 = flush left, 1 = flush
      // right); null when it was never moved.
      floatingButtonLeft: source.floatingButtonLeft != null && Number(source.floatingButtonLeft) >= 0 && Number(source.floatingButtonLeft) <= 1 ? Number(source.floatingButtonLeft) : null,
      floatingButtonTop: source.floatingButtonTop != null && Number(source.floatingButtonTop) >= 0 && Number(source.floatingButtonTop) <= 1 ? Number(source.floatingButtonTop) : null,
      // The first-run guide to the floating button was answered (settings-panel.js).
      guideDone: source.guideDone === true,
      concurrency: allowed.includes(requested) ? requested : 8,
      // 自动线程数: the downloader picks the thread count itself, between 8 and 64, and
      // `concurrency` above is only what the viewer set by hand. Off when the value is
      // missing here; the userscript's stored settings (bridge.js) default it to on.
      autoConcurrency: source.autoConcurrency === true,
      minChunkBytes: 64 * 1024,
      firstByteTimeoutMs: 5500,
      stallTimeoutMs: 4000,
      attemptTimeoutMs: 15000,
      hedgeDelayMs: 900,
      // 全接管预缓冲时长: how far ahead the full takeover buffers, one of a few choices.
      bufferAheadSeconds: [30, 45, 90, 180].includes(Number(source.bufferAheadSeconds)) ? Number(source.bufferAheadSeconds) : 45,
      // 二级缓冲: what the browser's buffer has no room for waits in memory (native-mse-player.js).
      // Experimental, off unless switched on.
      secondaryBuffer: source.secondaryBuffer === true
    };
  }

  root.__BILI_RANGE_CORE__ = Object.freeze({
    concatChunks,
    isBilibiliMediaUrl,
    normalizeCdnHost,
    normalizeSettings,
    parseByteRange,
    parseContentRange,
    parseRangeHeader,
    splitRange
  });
})(globalThis);


/* shared/live-core.js */
(function installLiveCore(root) {
  "use strict";

  // The parts of the live module that carry logic: playlist parsing, P2P/proxy URL handling
  // and the host pool, plus a room playinfo parser that only the tests use. No DOM and no
  // timers, so dev tests can run all of it in Node.

  // fMP4 HLS nodes that accept each other's signatures, verified by probing real streams
  // (2026-09): a segment signed for one of them downloads from all of them with HTTP 206,
  // while FLV-line (ov-gotcha07) and TS-line (gotcha105) nodes answer 403. The live module
  // probes each candidate before trusting it, again with later playlists until it passes or
  // is banned.
  const KNOWN_FMP4_HOSTS = Object.freeze([
    "d1--cn-gotcha204.bilivideo.com",
    "d1--cn-gotcha208.bilivideo.com",
    "d1--ov-gotcha208.bilivideo.com",
    "d1--ov-gotcha208b.bilivideo.com"
  ]);

  const LIVE_HOST_RE = /(?:^|\.)bilivideo\.(?:com|cn|net)$/i;
  const P2P_HOST_RE = /(?:^|\.)(?:mcdn\.bilivideo\.(?:com|cn|net)|szbdyd\.com|nexusedgeio\.com|ahdohpiechei\.com)$/i;
  // A stream URL wrapped in a commercial relay: https://xxx.smtcdns.net/d1--yy.bilivideo.com/...
  const PROXY_WRAP_RE = /^(https?:)\/\/[\w.-]+\.smtcdns\.(?:net|com)\/([\w-]+\.bilivideo\.(?:com|cn|net))(\/.*)$/i;

  function hostnameOf(value) {
    try { return new URL(value).hostname.toLowerCase(); }
    catch (_error) { return ""; }
  }

  function isLiveSegmentUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && LIVE_HOST_RE.test(url.hostname) && /\/live-bvc\//.test(url.pathname) && /\.m4s$/i.test(url.pathname);
    } catch (_error) { return false; }
  }

  function isLivePlaylistUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && LIVE_HOST_RE.test(url.hostname) && /\.m3u8$/i.test(url.pathname);
    } catch (_error) { return false; }
  }

  function isP2pUrl(value) {
    const host = hostnameOf(value);
    if (!host) return false;
    return P2P_HOST_RE.test(host) || host.split(".")[0].includes("302");
  }

  // A smtcdns-wrapped URL unwraps to the official node it relays for; anything else
  // returns "" and stays untouched.
  function unwrapProxyUrl(value) {
    const match = PROXY_WRAP_RE.exec(String(value || ""));
    return match ? `${match[1]}//${match[2]}${match[3]}` : "";
  }

  // The playurl of getRoomPlayInfo, flattened to one entry per protocol/format/codec.
  function parseRoomPlayInfo(payload) {
    const playurl = payload?.data?.playurl_info?.playurl
      || payload?.result?.playurl_info?.playurl
      || payload?.playurl_info?.playurl;
    const out = [];
    for (const stream of playurl?.stream || []) {
      for (const format of stream.format || []) {
        for (const codec of format.codec || []) {
          const urls = (codec.url_info || [])
            .map((info) => ({ host: String(info?.host || ""), extra: String(info?.extra || "") }))
            .filter((info) => info.host && !isP2pUrl(info.host));
          if (!urls.length || !codec.base_url) continue;
          out.push({
            protocol: String(stream.protocol_name || ""),
            format: String(format.format_name || ""),
            codec: String(codec.codec_name || ""),
            qn: Number(codec.current_qn) || 0,
            acceptQn: Array.isArray(codec.accept_qn) ? codec.accept_qn.map(Number) : [],
            baseUrl: String(codec.base_url),
            urls
          });
        }
      }
    }
    return out;
  }

  function segmentNumber(name) {
    const match = /(\d+)\.m4s$/i.exec(String(name || ""));
    return match ? Number(match[1]) : 0;
  }

  // A live media playlist. Segment URLs resolve against the playlist URL, so a playlist
  // fetched from any node names segments on that same node.
  function parseM3u8(text, playlistUrl) {
    const lines = String(text || "").split(/\r?\n/);
    const segments = [];
    let mapUrl = "";
    let duration = 0;
    for (const line of lines) {
      if (line.startsWith("#EXT-X-MAP")) {
        const uri = /URI="([^"]+)"/.exec(line)?.[1];
        if (uri) try { mapUrl = new URL(uri, playlistUrl).href; } catch (_error) {}
        continue;
      }
      if (line.startsWith("#EXTINF")) {
        duration = Number(/#EXTINF:([\d.]+)/.exec(line)?.[1]) || 0;
        continue;
      }
      if (!line || line.startsWith("#")) continue;
      try {
        segments.push({ name: line.trim(), url: new URL(line.trim(), playlistUrl).href, num: segmentNumber(line), duration });
      } catch (_error) {}
      duration = 0;
    }
    return { mapUrl, segments, lastNum: segments.at(-1)?.num || 0 };
  }

  // Node health for one live stream. Live pieces are one second long, so the pool acts
  // fast: it ranks by first-byte time, blocks a failing node briefly, and bans one that
  // twice sent nothing. Proven nodes rank first; unproven candidates follow them until a
  // probe or a download proves them.
  function createHostPool(options = {}) {
    const health = new Map(); // host -> {fbMs, bps, failures, blockedUntil, proven, emptyReplies, banned}
    const now = () => (options.now ? options.now() : Date.now());

    function entry(host) {
      if (!health.has(host)) health.set(host, { fbMs: 0, bps: 0, failures: 0, blockedUntil: 0, proven: false, emptyReplies: 0, banned: false });
      return health.get(host);
    }

    return Object.freeze({
      add(host, proven = false) {
        const item = entry(String(host || "").toLowerCase());
        if (proven) item.proven = true;
      },
      success(host, fbMs, bps) {
        const item = entry(host);
        item.proven = true;
        item.banned = false;
        item.emptyReplies = 0;
        item.failures = 0;
        item.blockedUntil = 0;
        if (Number(fbMs) > 0) item.fbMs = item.fbMs ? item.fbMs * 0.6 + fbMs * 0.4 : fbMs;
        if (Number(bps) > 0) item.bps = item.bps ? item.bps * 0.6 + bps * 0.4 : bps;
      },
      failure(host, receivedBytes = 0) {
        const item = entry(host);
        item.failures += 1;
        item.blockedUntil = now() + Math.min(20000, 1500 * (2 ** Math.min(item.failures, 3)));
        if (Number(receivedBytes) <= 0) {
          item.emptyReplies += 1;
          if (item.emptyReplies >= 2 && !item.banned) {
            item.banned = true;
            try { options.onBan?.(host); } catch (_error) {}
          }
        }
      },
      // Ranked hosts: proven ones by first-byte speed, then unproven candidates. Blocked
      // and banned hosts drop out unless nothing else is left.
      pick(count = 3) {
        const time = now();
        const all = [...health.entries()];
        const open = all.filter(([, item]) => !item.banned && item.blockedUntil <= time);
        const unbanned = all.filter(([, item]) => !item.banned);
        const pool = open.length ? open : unbanned.length ? unbanned : all;
        const ranked = pool.sort(([, a], [, b]) =>
          Number(b.proven) - Number(a.proven)
          || (a.fbMs || 9e9) - (b.fbMs || 9e9)
          || (b.bps || 0) - (a.bps || 0));
        return ranked.slice(0, Math.max(1, count)).map(([host]) => host);
      },
      unproven() {
        return [...health.entries()].filter(([, item]) => !item.proven && !item.banned).map(([host]) => host);
      },
      status() {
        const time = now();
        return [...health.entries()].map(([host, item]) => ({
          host,
          state: item.banned ? "banned" : item.blockedUntil > time ? "blocked" : item.proven ? "healthy" : "untested",
          bps: Math.round(item.bps || 0)
        }));
      }
    });
  }

  root.__BILI_LIVE_CORE__ = Object.freeze({
    KNOWN_FMP4_HOSTS,
    createHostPool,
    isLivePlaylistUrl,
    isLiveSegmentUrl,
    isP2pUrl,
    parseM3u8,
    parseRoomPlayInfo,
    segmentNumber,
    unwrapProxyUrl
  });
})(globalThis);


/* shared/live-hook.js */
(function installLiveHook(root) {
  "use strict";

  // The live module: only the live site, and the userscript build loads every file on
  // every bilibili page, so the hostname decides. The dev fixtures run on 127.0.0.1 and
  // opt in explicitly.
  if (!/^live\.bilibili\.com$/i.test(root.location?.hostname || "") && root.__BTR_TEST_ALLOW_LIVE__ !== true) return;

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const INSTALL_FLAG = "__biliThreadRipperLiveInstalled";
  const core = root.__BILI_LIVE_CORE__;
  const rangeCore = root.__BILI_RANGE_CORE__;
  if (!core || !rangeCore || typeof root.fetch !== "function" || root[INSTALL_FLAG]) return;
  Object.defineProperty(root, INSTALL_FLAG, { value: true });

  const nativeFetch = root.fetch.bind(root);
  const HEDGE_MS = 400;
  // A piece the player is actively waiting for hedges sooner: pieces are one second long
  // and its own buffer is shallow.
  const URGENT_HEDGE_MS = 150;
  const FIRST_BYTE_TIMEOUT_MS = 2500;
  const SEGMENT_TIMEOUT_MS = 8000;
  const CACHE_LIMIT = 32;
  const CACHE_TTL_MS = 45000;

  let settings = rangeCore.normalizeSettings({});
  let settingsLoaded = false;
  // Off until the saved settings have arrived, and then only if the viewer switched it on
  // (liveEnabled is off by default).
  const liveOn = () => settingsLoaded && settings.enabled && settings.liveEnabled;

  // Bilibili's web player loads P2P SDKs that pull pieces from other viewers over WebRTC.
  // Overseas there are few viewers nearby, so P2P only adds stalls; the mocks keep the
  // player on the HTTP path. (Approach proven by Make-Bilibili-Great-Than-Ever-Before.)
  // The page's own SDK is kept and handed out whenever the module is off.
  class MockPcdn { on() {} off() {} emit() {} destroy() {} }
  for (const name of ["PCDNLoader", "BPP2PSDK", "SeederSDK"]) {
    let real = root[name];
    try {
      Object.defineProperty(root, name, {
        configurable: true,
        get() { return liveOn() ? MockPcdn : real; },
        set(value) { real = value; }
      });
    } catch (_error) {}
  }

  // ---- stats for the settings panel ----
  const stats = {
    version: "2026.11.10.1-d1",
    architecture: "live-segment-ripper",
    mode: "live",
    playerState: "waiting",
    quality: "直播",
    bufferedAhead: 0,
    acceleratedRequests: 0,
    acceleratedBytes: 0,
    parallelSubrequests: 0,
    activeThreads: 0,
    totalSpeedBps: 0,
    threadSpeeds: [],
    discoveredCdns: 0,
    healthyCdns: 0,
    blockedCdns: 0,
    cdnHosts: [],
    lastHost: "",
    lastError: "",
    lastErrorAt: null,
    takeoverError: null
  };
  // What the module did, in English for the diagnostic copy (diagnostic-report.js); error
  // messages go in as they were thrown.
  const events = [];
  function remember(level, what, detail = "") {
    events.push({ at: Math.round(performance.now()), level, what, detail: String(detail).slice(0, 200) });
    if (events.length > 60) events.shift();
  }
  const activeTransfers = new Map();
  let transferSequence = 1;
  let publishTimer = null;
  function publish() {
    clearTimeout(publishTimer);
    publishTimer = null;
    const now = Date.now();
    stats.activeThreads = activeTransfers.size;
    stats.totalSpeedBps = Math.round([...activeTransfers.values()].reduce((sum, item) => now - item.at < 2000 ? sum + item.bps : sum, 0));
    if (context) {
      stats.cdnHosts = context.pool.status();
      stats.discoveredCdns = stats.cdnHosts.length;
      stats.healthyCdns = stats.cdnHosts.filter((item) => item.state === "healthy").length;
      stats.blockedCdns = stats.cdnHosts.filter((item) => ["blocked", "banned"].includes(item.state)).length;
    }
    root.postMessage({ channel: CHANNEL, type: "stats", payload: { ...stats } }, "*");
  }
  function schedulePublish() {
    if (!publishTimer) publishTimer = setTimeout(publish, 250);
  }

  // ---- one live stream: the playlist currently being played ----
  // context: { key, pool, cache: Map(url -> {promise, at, hit}), lastNum, mapUrl, probing,
  //   speculativeMisses, prefetchQueue, inflightPrefetch, urgentInflight, abort }
  let context = null;
  // The stream the player asked for most recently. A playlist answer that arrives late,
  // after the player moved on to another stream, must not bring the old one back.
  let latestPlaylistKey = "";

  const swapHost = (url, host) => { const u = new URL(url); u.hostname = host; u.port = ""; return u.href; };
  // Everything of a stream stops with it: queued prefetches, running downloads, probes.
  function dropContext() {
    if (!context) return;
    context.prefetchQueue.length = 0;
    context.abort.abort(new DOMException("直播已切换或加速已关闭", "AbortError"));
    context = null;
  }
  const directoryOf = (url) => { try { const u = new URL(url); return u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1); } catch (_error) { return ""; } };

  function contextFor(playlistUrl) {
    const key = directoryOf(playlistUrl);
    if (context?.key === key) return context;
    dropContext();
    const pool = core.createHostPool({
      onBan(host) {
        remember("warn", "node banned", `${host}, 2 failures with no data`);
      }
    });
    let origin = "";
    try { origin = new URL(playlistUrl).hostname; } catch (_error) {}
    // The node Bilibili handed out is trusted unless it is a P2P relay. In the custom CDN
    // mode only the servers the viewer picked join it; otherwise the known fMP4 group does.
    if (origin && !core.isP2pUrl(playlistUrl)) pool.add(origin, true);
    const extra = settings.mode === "custom" ? settings.customHosts : core.KNOWN_FMP4_HOSTS;
    for (const host of extra) if (host !== origin) pool.add(host, false);
    context = { key, pool, cache: new Map(), lastNum: 0, mapUrl: "", probing: false, speculativeMisses: 0, prefetchQueue: [], inflightPrefetch: 0, urgentInflight: 0, abort: new AbortController() };
    stats.playerState = "ready";
    remember("info", "took over", origin ? `stream from ${origin}` : "");
    schedulePublish();
    return context;
  }

  // Candidates are probed so that ranking can trust them: the signature is shared within the
  // fMP4 node group, but a node may still lack the stream. Until proven they rank behind the
  // proven nodes and can still get a hedge copy.
  function probeCandidates(ctx, sampleUrl) {
    if (ctx.probing) return;
    const unproven = ctx.pool.unproven();
    if (!unproven.length) return;
    ctx.probing = true;
    Promise.allSettled(unproven.map(async (host) => {
      const startedAt = performance.now();
      try {
        const probe = new AbortController();
        const probeTimer = setTimeout(() => probe.abort(new DOMException("直播节点探测超时", "TimeoutError")), 4000);
        const dropProbe = () => probe.abort(ctx.abort.signal.reason);
        ctx.abort.signal.addEventListener("abort", dropProbe, { once: true });
        let response;
        let body;
        try {
          response = await nativeFetch(swapHost(sampleUrl, host), {
            headers: { Range: "bytes=0-2047" },
            credentials: "omit",
            cache: "no-store",
            signal: probe.signal
          });
          body = new Uint8Array(await response.arrayBuffer());
        } finally {
          clearTimeout(probeTimer);
          ctx.abort.signal.removeEventListener("abort", dropProbe);
        }
        if ((response.status === 206 || response.status === 200) && body.byteLength > 0) {
          ctx.pool.success(host, performance.now() - startedAt, 0);
        } else {
          ctx.pool.failure(host, body.byteLength);
        }
      } catch (_error) {
        ctx.pool.failure(host, 0);
      }
    })).then(() => {
      ctx.probing = false;
      schedulePublish();
    });
  }

  async function attemptSegment(ctx, url, host, signal) {
    const startedAt = performance.now();
    const transferId = transferSequence++;
    activeTransfers.set(transferId, { at: Date.now(), bps: 0 });
    schedulePublish();
    let received = 0;
    try {
      const response = await nativeFetch(swapHost(url, host), {
        credentials: "omit",
        cache: "no-store",
        signal
      });
      if (response.status !== 200 && response.status !== 206) {
        throw Object.assign(new Error(`直播分片响应异常：HTTP ${response.status}`), { status: response.status });
      }
      // Nothing here asks for a range, so a 206 is only acceptable when it covers the file.
      const contentRange = rangeCore.parseContentRange(response.headers.get("content-range"));
      if (response.status === 206 && (!contentRange || contentRange.start !== 0 || contentRange.total === null || contentRange.end !== contentRange.total - 1)) {
        throw new Error("直播分片只返回了一部分");
      }
      const reader = response.body?.getReader?.();
      const chunks = [];
      let firstByteMs = 0;
      if (reader) {
        const firstByteTimer = setTimeout(() => reader.cancel(new DOMException("直播分片首字节超时", "TimeoutError")).catch(() => {}), FIRST_BYTE_TIMEOUT_MS);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!firstByteMs) {
            firstByteMs = performance.now() - startedAt;
            clearTimeout(firstByteTimer);
          }
          chunks.push(value);
          received += value.byteLength;
          const item = activeTransfers.get(transferId);
          if (item) {
            item.bps = received * 1000 / Math.max(1, performance.now() - startedAt);
            item.at = Date.now();
          }
        }
        clearTimeout(firstByteTimer);
      } else {
        const body = new Uint8Array(await response.arrayBuffer());
        firstByteMs = performance.now() - startedAt;
        chunks.push(body);
        received = body.byteLength;
      }
      if (signal?.aborted) throw new DOMException("已取消", "AbortError");
      if (received <= 0) throw new Error("直播分片为空");
      const declared = response.status === 206 ? contentRange.total : Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > 0 && received !== declared) throw new Error(`直播分片长度不对：收到 ${received}，应为 ${declared}`);
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const elapsed = Math.max(1, performance.now() - startedAt);
      ctx.pool.success(host, firstByteMs || elapsed, received * 1000 / elapsed);
      stats.lastHost = host;
      return { bytes, contentType: response.headers.get("content-type") || "video/iso.segment", host };
    } catch (error) {
      if (error?.name !== "AbortError" && Number(error?.status) !== 404) ctx.pool.failure(host, received);
      throw error;
    } finally {
      activeTransfers.delete(transferId);
      schedulePublish();
    }
  }

  // One segment: the best node first, a hedge copy on the second-best if the first has not
  // finished after a short delay (shorter when the player is waiting, longer for a
  // speculative fetch) or fails. A 404 is never counted against a node: for a speculative
  // fetch it means the segment is not born yet.
  async function downloadSegment(ctx, url, { speculative = false, urgent = false } = {}) {
    const hosts = ctx.pool.pick(2);
    if (!hosts.length) throw new Error("没有可用直播节点");
    const controllers = hosts.map(() => new AbortController());
    const dropped = () => controllers.forEach((c) => { if (!c.signal.aborted) c.abort(ctx.abort.signal.reason); });
    if (ctx.abort.signal.aborted) dropped();
    else ctx.abort.signal.addEventListener("abort", dropped, { once: true });
    const overall = setTimeout(() => controllers.forEach((c) => c.abort(new DOMException("直播分片总超时", "TimeoutError"))), SEGMENT_TIMEOUT_MS);
    let primaryFailed = () => {};
    const primaryFailure = new Promise((resolve) => { primaryFailed = resolve; });
    try {
      const attempts = hosts.map((host, index) => (async () => {
        if (index) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, speculative ? HEDGE_MS * 3 : urgent ? URGENT_HEDGE_MS : HEDGE_MS);
            primaryFailure.then(() => { clearTimeout(timer); resolve(); });
          });
          if (controllers[index].signal.aborted) throw new DOMException("已取消", "AbortError");
        }
        try {
          return await attemptSegment(ctx, url, host, controllers[index].signal);
        } catch (error) {
          if (!index) primaryFailed();
          throw error;
        }
      })());
      const winner = await Promise.any(attempts);
      controllers.forEach((controller) => { if (!controller.signal.aborted) controller.abort(new DOMException("并发副本已取消", "AbortError")); });
      return winner;
    } catch (aggregate) {
      throw aggregate?.errors?.at?.(-1) || aggregate;
    } finally {
      clearTimeout(overall);
      ctx.abort.signal.removeEventListener("abort", dropped);
    }
  }

  function pruneCache(ctx) {
    const now = Date.now();
    for (const [key, item] of ctx.cache) {
      if (key === ctx.mapUrl) continue;
      if (now - item.at > CACHE_TTL_MS) ctx.cache.delete(key);
    }
    while (ctx.cache.size > CACHE_LIMIT) {
      const oldest = [...ctx.cache.keys()].find((key) => key !== ctx.mapUrl);
      if (!oldest) break;
      ctx.cache.delete(oldest);
    }
  }

  function cacheSegment(ctx, url, options = {}) {
    let item = ctx.cache.get(url);
    if (item) return item;
    item = { at: Date.now(), hit: false, promise: downloadSegment(ctx, url, options) };
    item.promise.catch(() => { if (ctx.cache.get(url) === item) ctx.cache.delete(url); });
    ctx.cache.set(url, item);
    pruneCache(ctx);
    return item;
  }

  // Prefetch runs through a small queue instead of all at once: the first playlist would
  // otherwise burst eight segments that compete for bandwidth with the very segment the
  // player is waiting for, which is exactly when its shallow buffer runs dry. While the
  // player waits for a segment (urgent), the queue nearly stops.
  function pumpPrefetch(ctx) {
    while (ctx.inflightPrefetch < (ctx.urgentInflight > 0 ? 1 : 3) && ctx.prefetchQueue.length) {
      const next = ctx.prefetchQueue.shift();
      if (ctx.cache.has(next.url)) continue;
      ctx.inflightPrefetch += 1;
      const item = cacheSegment(ctx, next.url, next.options);
      const done = (ok) => {
        try { next.options.onSettled?.(ok); } catch (_error) {}
        ctx.inflightPrefetch = Math.max(0, ctx.inflightPrefetch - 1);
        pumpPrefetch(ctx);
      };
      item.promise.then(() => done(true), () => done(false));
    }
  }

  function enqueuePrefetch(ctx, url, options = {}) {
    if (ctx.cache.has(url) || ctx.prefetchQueue.some((entry) => entry.url === url)) return;
    ctx.prefetchQueue.push({ url, options });
    if (ctx.prefetchQueue.length > 16) ctx.prefetchQueue.shift();
    pumpPrefetch(ctx);
  }

  // What a new playlist drives: the init map, every announced segment not yet cached, and —
  // once all announced segments are cached or downloading — one speculative future segment,
  // whose 404 only means the encoder has not produced it yet.
  function onPlaylist(playlistUrl, text, requestedKey) {
    if (!liveOn() || requestedKey !== latestPlaylistKey) return;
    // Only fMP4 media playlists: a master playlist or a TS stream is not the module's business.
    if (/#EXT-X-STREAM-INF/.test(text) || !/#EXT-X-MAP/.test(text)) return;
    const parsed = core.parseM3u8(text, playlistUrl);
    if (!parsed.segments.length || !parsed.segments.every((segment) => /\.m4s$/i.test(segment.name))) return;
    const ctx = contextFor(playlistUrl);
    ctx.lastNum = Math.max(ctx.lastNum, parsed.lastNum);
    if (parsed.mapUrl) {
      ctx.mapUrl = parsed.mapUrl;
      // The init segment is tiny and everything needs it: fetched at once, outside the queue.
      if (!ctx.cache.has(parsed.mapUrl)) cacheSegment(ctx, parsed.mapUrl);
    }
    probeCandidates(ctx, parsed.segments[0].url);
    // The whole announced window, not just the newest pieces: the player usually plays a
    // few seconds behind the live edge, and a piece it is about to ask for must already
    // be in hand — a cache miss there costs a fresh download against its shallow buffer.
    // Oldest first: that is the order the player will consume them in.
    let pending = 0;
    for (const segment of parsed.segments) {
      if (!ctx.cache.has(segment.url)) {
        enqueuePrefetch(ctx, segment.url);
        pending += 1;
      }
    }
    if (!pending && parsed.lastNum > 0 && ctx.speculativeMisses < 6) {
      const last = parsed.segments.at(-1);
      const nextUrl = last.url.replace(`${last.num}.m4s`, `${last.num + 1}.m4s`);
      if (!ctx.cache.has(nextUrl)) {
        enqueuePrefetch(ctx, nextUrl, {
          speculative: true,
          onSettled: (ok) => { ctx.speculativeMisses = ok ? 0 : ctx.speculativeMisses + 1; }
        });
      }
    }
    stats.bufferedAhead = parsed.segments.filter((segment) => ctx.cache.get(segment.url)).length;
    schedulePublish();
  }

  async function serveSegment(url, input, init) {
    const ctx = context;
    const signal = init?.signal || (input instanceof Request ? input.signal : null);
    if (signal?.aborted) throw signal.reason || new DOMException("已取消", "AbortError");
    const cached = ctx?.cache.get(url);
    const item = cached || (ctx && directoryOf(url) === ctx.key ? cacheSegment(ctx, url, { urgent: true }) : null);
    if (!item) return nativeFetch(input, init);
    // While the player waits here, the prefetch queue slows to a trickle so the waited-for
    // segment gets the bandwidth.
    if (!cached && ctx) ctx.urgentInflight += 1;
    let stopWaiting = () => {};
    try {
      // The download goes on for the cache; only this caller stops waiting.
      const result = await (signal ? Promise.race([item.promise, new Promise((_resolve, reject) => {
        stopWaiting = () => reject(signal.reason || new DOMException("已取消", "AbortError"));
        signal.addEventListener("abort", stopWaiting, { once: true });
      })]) : item.promise);
      if (!item.hit) {
        item.hit = true;
        stats.acceleratedRequests += 1;
        stats.acceleratedBytes += result.bytes.byteLength;
        schedulePublish();
      }
      const response = new Response(result.bytes.slice(), {
        status: 200,
        headers: { "Content-Type": result.contentType, "Content-Length": String(result.bytes.byteLength) }
      });
      try { Object.defineProperty(response, "url", { value: url }); } catch (_error) {}
      return response;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      stats.lastError = String(error?.message || error).slice(0, 160);
      stats.lastErrorAt = Math.round(performance.now());
      remember("warn", "segment failed", stats.lastError);
      schedulePublish();
      return nativeFetch(input, init);
    } finally {
      signal?.removeEventListener("abort", stopWaiting);
      if (!cached && ctx) {
        ctx.urgentInflight = Math.max(0, ctx.urgentInflight - 1);
        pumpPrefetch(ctx);
      }
    }
  }

  // A request whose URL was rewritten keeps everything else the player gave it: headers,
  // credentials, signal, cache mode.
  function withUrl(input, url) {
    if (!(input instanceof Request)) return url;
    try { return new Request(url, input); } catch (_error) { return url; }
  }

  // An smtcdns wrapper unwraps to the official node it fronts. A P2P segment (.m4s) URL moves
  // to the best official node once a stream's pool exists; other P2P URLs pass through.
  function rewriteUrl(url) {
    const unwrapped = core.unwrapProxyUrl(url) || url;
    if (!core.isP2pUrl(unwrapped)) return unwrapped;
    if (context && (core.isLiveSegmentUrl(unwrapped) || /\.m4s(?:\?|$)/i.test(unwrapped))) {
      const best = context.pool.pick(1)[0];
      if (best) try { return swapHost(unwrapped, best); } catch (_error) {}
    }
    return unwrapped;
  }

  root.fetch = function (input, init) {
    let url = "";
    try { url = input instanceof Request ? input.url : String(input); } catch (_error) {}
    if (!liveOn() || !url) return nativeFetch(input, init);
    const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET") return nativeFetch(input, init);
    const rewritten = rewriteUrl(url);
    if (core.isLivePlaylistUrl(rewritten)) {
      const requestedKey = directoryOf(rewritten);
      latestPlaylistKey = requestedKey;
      const pending = nativeFetch(rewritten === url ? input : withUrl(input, rewritten), init);
      pending.then((response) => {
        response.clone().text().then((text) => onPlaylist(response.url || rewritten, text, requestedKey)).catch(() => {});
      }).catch(() => {});
      return pending;
    }
    let ranged = false;
    try { ranged = Boolean((init?.headers && new Headers(init.headers).get("range")) || (input instanceof Request && input.headers.get("range"))); } catch (_error) {}
    if (core.isLiveSegmentUrl(rewritten) && !ranged) {
      return serveSegment(rewritten, rewritten === url ? input : withUrl(input, rewritten), init);
    }
    if (rewritten !== url) return nativeFetch(withUrl(input, rewritten), init);
    return nativeFetch(input, init);
  };

  // A player that loads media over XMLHttpRequest gets only the URL rewrite: relay
  // unwrapping, P2P segments moved to the best node, and segments of a banned node moved to
  // the best one; synthesizing full XHR responses is not worth the risk here.
  const xhrPrototype = root.XMLHttpRequest?.prototype;
  if (xhrPrototype) {
    const nativeOpen = xhrPrototype.open;
    xhrPrototype.open = function (method, url, ...rest) {
      let target = url;
      try {
        if (liveOn() && String(method).toUpperCase() === "GET") {
          const value = String(url || "");
          const rewritten = rewriteUrl(value);
          if (rewritten !== value) target = rewritten;
          else if (core.isLiveSegmentUrl(value) && context) {
            const best = context.pool.pick(1)[0];
            const origin = new URL(value).hostname;
            if (best && best !== origin && context.pool.status().find((item) => item.host === origin)?.state === "banned") {
              target = swapHost(value, best);
            }
          }
        }
      } catch (_error) { target = url; }
      return nativeOpen.call(this, method, target, ...rest);
    };
  }

  root.addEventListener("message", (event) => {
    if (event.source !== root || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "settings") {
      const previous = settings;
      settings = rangeCore.normalizeSettings(event.data.payload);
      if (!settingsLoaded || previous.enabled !== settings.enabled || previous.liveEnabled !== settings.liveEnabled) {
        settingsLoaded = true;
        remember("info", "settings applied", liveOn() ? "on" : "off");
      }
      if (!liveOn()) {
        dropContext();
        stats.playerState = "disabled";
      } else if (previous.mode !== settings.mode || previous.customHosts.join() !== settings.customHosts.join()) {
        // A new CDN choice means a new node pool; the next playlist builds it.
        dropContext();
      }
      publish();
    } else if (event.data.type === "get-stats") {
      publish();
    }
  });

  Object.defineProperty(root, "__biliThreadRipperLiveDebug", {
    value: Object.freeze({
      getContext: () => context && {
        key: context.key,
        lastNum: context.lastNum,
        cached: context.cache.size,
        hosts: context.pool.status()
      },
      getStats: () => ({ ...stats }),
      getEvents: () => events.map((event) => ({ ...event })),
      version: "2026.11.10.1-d1"
    })
  });
  publish();
})(globalThis);


/* shared/diagnostic-report.js */
// The diagnostic report that 复制诊断信息 copies, format 1. settings-panel.js only collects a
// snapshot of what each part of BTR knows at that moment; this file turns it into plain English
// ASCII text in one fixed layout, for the `text` field of an issue. It touches no DOM, so the
// same code runs in the page and under Node (dev/diagnostic-report-test.js).
//
// The layout keeps a few rules so that a report reads at a glance and two reports diff line by
// line: one clock (T+s.mmm, seconds since the top document loaded), one fact per line, every key
// printed in the same order (n/a when its source is absent, none for an empty list, - for a
// table cell with nothing measured), fixed units (B/KiB/MiB, Mbit/s, ms or s) and no raw floats.
// BTR's own Chinese messages become English through translate(); text it does not know
// (Bilibili's own messages) is replaced, and a last pass over every line takes the query off any
// address, drops cookie and signature fields and turns whatever is still not ASCII into "?".
(function installDiagnosticReport(root) {
  "use strict";

  const FORMAT = "1";
  const LINE_LIMIT = 200;
  // GitHub takes 65 536 characters in an issue body; the rest is left for the form's own text
  // and what the viewer writes.
  const CHAR_LIMIT = 48000;
  const EVENT_LIMIT = 400;
  const NODE_LIMIT = 40;
  const LIVE_LIMIT = 4;
  const LIVE_NODE_LIMIT = 16;
  // Adjacent repeats of one event within this time are printed once, with a count.
  const FOLD_MS = 10000;

  // bridge.js DEFAULTS, the stored settings before anything is changed: Settings marks every
  // value that differs with *. dev/diagnostic-report-test.js checks that the two stay equal.
  const DEFAULTS = Object.freeze({ enabled: true, liveEnabled: false, episodeEnabled: true, blockInternational: false, bufferAheadSeconds: 45, secondaryBuffer: false, theme: "auto", concurrency: 8, autoConcurrency: true, takeover: "full", mode: "mainland", customHosts: Object.freeze([]), floatingButton: true, floatingButtonLeft: null, floatingButtonTop: null, guideDone: false });

  // English names of Bilibili's quality ids; the player's own labels are Chinese (1080P 60帧).
  const QUALITY_LABELS = Object.freeze({ 127: "8K", 126: "Dolby Vision", 125: "HDR", 120: "4K", 116: "1080P60", 112: "1080P+", 80: "1080P", 74: "720P60", 64: "720P", 32: "480P", 16: "360P", 6: "240P" });
  const READY_STATES = ["HAVE_NOTHING", "HAVE_METADATA", "HAVE_CURRENT_DATA", "HAVE_FUTURE_DATA", "HAVE_ENOUGH_DATA"];
  const NETWORK_STATES = ["EMPTY", "IDLE", "LOADING", "NO_SOURCE"];
  const MEDIA_ERRORS = Object.freeze({ 1: "MEDIA_ERR_ABORTED", 2: "MEDIA_ERR_NETWORK", 3: "MEDIA_ERR_DECODE", 4: "MEDIA_ERR_SRC_NOT_SUPPORTED" });

  // ---- translation ----

  // Every message BTR itself writes in Chinese: what its errors are thrown with (the cancel
  // reasons among them), what 自动线程数 gives as its reason, and the few Chinese words older
  // builds left in their English records. The patterns also match inside a longer text, as in
  // "range failed: video <host> after 0 KiB: 并发副本已取消", and keep the numbers and hosts
  // around them. A message that wraps another comes first, and each message before the shorter
  // ones it ends with (并发副本已取消 before 已取消, 媒体 Range 校验失败 before Range 校验失败).
  const DICTIONARY = [
    [/原生播放器接口发生变化，?已停止加速：?\s*/g, "native player API changed, acceleration stopped: "],
    // Downloads: idm-downloader.js and range-core.js.
    [/并发副本已取消/g, "hedge lost"],
    [/播放器任务已取消/g, "player task cancelled"],
    [/播放任务已取消/g, "session cancelled"],
    [/播放清单请求已取消/g, "playlist request cancelled"],
    [/已经跳到新的位置/g, "seeked elsewhere"],
    [/播放内核发生错误/g, "player core failed"],
    [/B ?站原生播放器正在切换媒体源/g, "Bilibili's player is switching sources"],
    [/CDN ?首字节超时/g, "CDN first byte timed out"],
    [/CDN ?子块停止传输/g, "CDN piece stalled"],
    [/CDN ?子块总耗时超限/g, "CDN piece took too long"],
    [/媒体 ?Range ?校验失败/g, "media range check failed"],
    [/媒体 ?Range ?长度不符/g, "media range length mismatch"],
    [/Range ?校验失败：?\s*/g, "range check failed: "],
    [/子块长度不符：?\s*/g, "piece length mismatch: "],
    [/子区间超出目标长度/g, "sub-range past the target length"],
    [/子区间长度不符：?\s*/g, "sub-range length mismatch: "],
    [/没有可用 ?CDN/g, "no usable CDN"],
    [/不同 ?CDN ?返回的文件总长度不一致/g, "CDNs disagree on the file size"],
    // The full takeover: native-mse-player.js.
    [/页面没有 ?DASH ?播放清单/g, "page has no DASH playlist"],
    [/新视频没有 ?DASH ?播放清单/g, "new video has no DASH playlist"],
    [/这一集没有 ?DASH ?播放清单/g, "episode has no DASH playlist"],
    [/浏览器不支持清单中的视频或音频编码/g, "browser supports none of the playlist's codecs"],
    [/播放清单缺少初始化或 ?SIDX ?字节范围/g, "playlist lacks init or SIDX ranges"],
    [/空的缓冲区间/g, "empty buffered range"],
    [/没有找到 ?B ?站原生 ?video ?元素/g, "Bilibili's video element not found"],
    [/(?:(视频|音频)\s*)?SIDX ?解析失败/g, (_match, kind) => `${kind === "视频" ? "video " : kind === "音频" ? "audio " : ""}SIDX parse failed`],
    // waitEvent: `${successName} 失败`, the name of the event that never came.
    [/([\w-]+) 失败/g, "$1 failed"],
    // The compatibility mode: native-range-transport.js.
    [/原生播放器接口不兼容/g, "native player API incompatible"],
    [/原生缓冲接口不兼容/g, "native buffer API incompatible"],
    [/原生调度接口不兼容/g, "native scheduler API incompatible"],
    [/原生内核未恢复/g, "native core not restored"],
    [/加速任务已停止/g, "transport stopped"],
    [/其他服务器没有这个文件/g, "the other servers do not have this file"],
    // The page: page-hook.js.
    [/视频已经换了/g, "video changed"],
    [/B ?站 ?15 ?秒内没有回应/g, "Bilibili did not answer within 15 s"],
    [/读取视频信息失败/g, "video info request failed"],
    [/新视频缺少 ?CID/g, "new video has no CID"],
    [/读取播放清单失败/g, "playlist request failed"],
    [/未知接管错误/g, "unknown takeover error"],
    [/\s*[（(]兼容模式[)）]/g, " (compat)"],
    [/兼容模式/g, "compat"],
    [/全接管/g, "full"],
    // Live: live-hook.js.
    [/直播已切换或加速已关闭/g, "live stream changed or acceleration off"],
    [/直播节点探测超时/g, "live node probe timed out"],
    [/直播分片响应异常：?\s*/g, "live segment failed: "],
    [/直播分片只返回了一部分/g, "live segment came back partial"],
    [/直播分片首字节超时/g, "live segment first byte timed out"],
    [/直播分片为空/g, "live segment empty"],
    [/直播分片长度不对：?\s*收到\s*([^，,]*?)\s*[，,]\s*应为\s*/g, "live segment length wrong: got $1, expected "],
    [/没有可用直播节点/g, "no usable live node"],
    [/直播分片总超时/g, "live segment timed out"],
    [/直播/g, "live"],
    // 自动线程数: idm-downloader.js, and the stalls native-mse-player.js reports to it.
    [/开头已经跟上，?\s*线程数降到\s*(\d+)/g, "start caught up, down to $1"],
    [/开头先用\s*(\d+)\s*线程/g, "start with $1 threads"],
    [/(\d+)\s*线程没有比\s*(\d+)\s*线程更快/g, "$1 threads were not faster than $2"],
    [/服务器返回\s*(\d+)/g, "server returned HTTP $1"],
    [/播放卡了一下/g, "playback stalled"],
    [/前方缓冲快用完了/g, "buffer nearly empty"],
    [/缓冲跟不上播放/g, "buffer not keeping up"],
    [/连接排队等太久/g, "connections queued too long"],
    [/起步/g, "initial"],
    // The player's quality labels, which older builds wrote into their timelines.
    [/杜比视界/g, "Dolby Vision"],
    [/(\d+P) ?(\d+)帧/g, "$1$2"],
    [/(\d+P) ?高码率/g, "$1+"],
    [/(\d+)帧/g, "$1 fps"],
    [/清晰度 ?/g, "qn "],
    [/已取消/g, "cancelled"]
  ];
  const PUNCTUATION = [
    [/：/g, ": "], [/[，、]/g, ", "], [/；/g, "; "], [/。/g, ". "], [/（/g, " ("], [/）/g, ")"],
    [/！/g, "! "], [/？/g, "? "], [/[“”「」『』]/g, "\""], [/[‘’]/g, "'"], [/[—–―]/g, "-"],
    [/…/g, "..."], [/→/g, "->"], [/←/g, "<-"], [/×/g, "x"], [/[·•‧∙⋅]/g, ", "], [/[\u00a0\u3000]/g, " "]
  ];
  const CJK_RUN = /[\u2e80-\u2fff\u3000-\u303f\u3040-\u31ff\u3200-\u9fff\ua000-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]+/g;
  const UNKNOWN = "[non-English text]";

  // Any text BTR may print, as English ASCII. ASCII comes back as it was; anything Chinese the
  // dictionary does not know, such as Bilibili's own API messages, becomes [non-English text],
  // and the numbers and codes around it stay.
  function translate(value) {
    let out = typeof value === "string" ? value
      : typeof value === "number" || typeof value === "boolean" ? String(value)
        : value && typeof value === "object" && typeof value.message === "string" ? value.message : "";
    if (!/[^\x00-\x7f]/.test(out)) return out;
    for (const [pattern, english] of DICTIONARY) out = out.replace(pattern, english);
    for (const [pattern, ascii] of PUNCTUATION) out = out.replace(pattern, ascii);
    try { out = out.normalize("NFKC"); } catch (_error) {}
    // One marker per stretch of unknown text, so "请求错误 请稍后再试" is one placeholder.
    out = out.replace(CJK_RUN, "\ue000").replace(/\ue000(?:[\s,.;:!?'"-]*\ue000)*/g, UNKNOWN);
    return out.replace(/[^\x00-\x7f]/g, "?").replace(/ {2,}/g, " ").replace(/ +([,.;:)])/g, "$1").trim();
  }

  // ---- reading the snapshot ----

  // The snapshot comes from several sources that may be missing, older, or broken; each value
  // is read as the type it should have, or as nothing.
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  const list = (value) => Array.isArray(value) ? value : [];
  const num = (value) => {
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    return Number.isFinite(number) ? number : null;
  };
  const bool = (value) => typeof value === "boolean" ? value : null;
  const text = (value) => typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";

  // ---- units ----

  const yesNo = (value) => value === true ? "yes" : value === false ? "no" : "n/a";
  const count = (value) => { const n = num(value); return n === null ? "n/a" : String(Math.round(n)); };
  const plural = (value, one, many = `${one}s`) => { const n = num(value); return n === null ? `n/a ${many}` : `${Math.round(n)} ${Math.round(n) === 1 ? one : many}`; };
  const fixed = (value, digits) => { const n = num(value); return n === null ? "n/a" : (Math.abs(n) < 0.5 / 10 ** digits ? 0 : n).toFixed(digits); };
  // Media positions: 3 decimals in sections, 1 in the event list.
  const position = (value) => fixed(value, 3);
  const secondsAmount = (value) => num(value) === null ? "n/a" : `${fixed(value, 1)} s`;
  function size(value) {
    const bytes = num(value);
    if (bytes === null || bytes < 0) return "n/a";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const kib = bytes / 1024;
    if (kib < 10) return `${kib.toFixed(1)} KiB`;
    if (Math.round(kib) < 1024) return `${Math.round(kib)} KiB`;
    return `${(bytes / 1048576).toFixed(2)} MiB`;
  }
  // DASH bandwidth is bits per second already; the downloader's speeds are bytes per second
  // and are multiplied by 8 where they are read.
  const mbit = (bitsPerSecond) => num(bitsPerSecond) === null ? "n/a" : `${(num(bitsPerSecond) / 1e6).toFixed(2)} Mbit/s`;
  function duration(value) {
    const ms = num(value);
    if (ms === null) return "n/a";
    if (Math.abs(ms) < 10000) return `${Math.round(ms)} ms`;
    if (Math.abs(ms) < 600000) return `${(ms / 1000).toFixed(1)} s`;
    return `${(ms / 60000).toFixed(1)} min`;
  }
  const fps = (value) => Math.abs(value - Math.round(value)) < 0.01 ? String(Math.round(value)) : value.toFixed(2);
  function qn(value) {
    const id = Math.round(num(value) || 0);
    return QUALITY_LABELS[id] ? `qn ${id} (${QUALITY_LABELS[id]})` : `qn ${id}`;
  }
  function iso(ms, seconds = false) {
    const at = num(ms);
    if (at === null || Math.abs(at) > 8.64e15) return "n/a";
    const out = new Date(at).toISOString();
    return seconds ? out.replace(/\.\d{3}Z$/, "Z") : out;
  }
  // T+s.mmm on the top document's clock; the T column of the events holds the bare number.
  const seconds = (ms) => (Math.abs(ms) < 0.5 ? 0 : ms / 1000).toFixed(3);
  const stamp = (ms) => ms === null || ms === undefined ? "n/a" : `T${ms < 0 ? "-" : "+"}${seconds(Math.abs(ms))}`;

  // A short token from the data, such as a state, a mode or a codec.
  const word = (value, fallback = "n/a") => translate(text(value)).replace(/[^\w .:/+,()#-]/g, "").trim().slice(0, 60) || fallback;
  // Free text from the data, on one line, cut with "..." when it is too long for its place.
  function sentence(value, limit = 160) {
    const out = translate(value).replace(/\s+/g, " ").trim();
    return out.length > limit ? `${out.slice(0, limit - 3).trimEnd()}...` : out;
  }
  // A CDN host name, and nothing that could follow it in an address.
  const hostName = (value) => text(value).toLowerCase().replace(/^[a-z][\w+.-]*:\/\//, "").split(/[/?#\s]/)[0].replace(/[^a-z0-9.:[\]-]/g, "").slice(0, 64);
  // Numbers somebody printed with all their digits; not the ones inside a codec or a version
  // (avc1.640033). No lookbehind: the userscript bundle has to parse in older Safari too.
  const tidyNumbers = (value) => value.replace(/(^|[^\w.])(-?\d+\.\d{4,})(?![\w.])/g, (_match, before, number) => `${before}${Number(number).toFixed(3)}`);

  // An event's detail, which is mostly a string but may be a number, a flag or a small record.
  function detailText(value, depth = 0) {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "number") return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "";
    if (typeof value === "boolean") return value ? "yes" : "no";
    if (depth > 1) return "";
    if (Array.isArray(value)) return value.slice(0, 8).map((item) => detailText(item, depth + 1)).filter(Boolean).join(", ");
    if (typeof value === "object") {
      if ("code" in value || "message" in value) return mediaError(value);
      return Object.entries(value).slice(0, 8).map(([key, item]) => `${word(key, "")} ${detailText(item, depth + 1)}`.trim()).filter(Boolean).join(", ");
    }
    return tidyNumbers(sentence(value, 200));
  }
  function mediaError(error) {
    const code = Math.round(num(error?.code) || 0);
    const message = sentence(error?.message);
    return `${code}${MEDIA_ERRORS[code] ? ` ${MEDIA_ERRORS[code]}` : ""}${message ? `: ${message}` : ""}`;
  }
  const codecsOf = (type) => (/codecs\s*=\s*"?([^";]+)"?/i.exec(text(type)) || [])[1]?.replace(/[^\w.,+-]/g, "").slice(0, 40) || "";
  const rangesOf = (value) => Array.isArray(value)
    ? value.slice(0, 8).map((range) => list(range).map(num)).filter(([start, end]) => start !== null && end !== null && end >= start)
    : null;

  // ---- the privacy pass ----

  // Signed media addresses carry their signature and expiry in the query, and a cookie string
  // that ended up in some message would carry the session. Every line goes through this, the
  // fixed text included, so nothing depends on each source having cleaned its own text.
  const URL_QUERY = /((?:https?:)?\/\/[^\s"'<>?#]+|\b[a-z0-9.-]+\.[a-z]{2,}\/[^\s"'<>?#]*)[?#][^\s"'<>]*/gi;
  const COOKIE_STRING = /(?:[\w.-]+=[^;\s]*;\s*){2,}[\w.-]+=[^;\s]*/g;
  const SECRET_NAMES = /\b(?:SESSDATA|bili_jct|DedeUserID(?:__ckMd5)?|buvid[\w-]*|upsig|uparams)\b(?:\s*[=:]\s*[^\s;&,"']*)?/gi;
  const SECRET_FIELDS = /\b(?:deadline|access_key|auth_key|csrf|token|sign|w_rid|wts|mid|uid)=[^\s;&,"']*/gi;
  const scrub = (line) => line.replace(URL_QUERY, "$1").replace(COOKIE_STRING, "[cookies removed]").replace(SECRET_NAMES, "[removed]").replace(SECRET_FIELDS, "[removed]");

  // One finished line: on one line, private fields out, ASCII, no trailing space, cut to fit.
  function clean(line) {
    let out = scrub(String(line ?? "").replace(/\r\n?|\n|\t/g, " ")).replace(/[^\x20-\x7e]/g, "?").trimEnd();
    if (out.length > LINE_LIMIT) out = `${out.slice(0, LINE_LIMIT - 3).trimEnd()}...`;
    return out;
  }

  // ---- layout ----

  // Key/value lines, the keys padded to the section's longest key + 2.
  function pairs(rows) {
    const width = Math.max(0, ...rows.map(([key]) => key.length)) + 2;
    return rows.map(([key, value]) => `${key.padEnd(width)}${value === "" || value === null || value === undefined ? "n/a" : value}`);
  }
  // A table: text columns left-aligned, numbers right-aligned, two spaces between columns.
  function table(header, rows, align) {
    const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)));
    const line = (cells) => cells.map((cell, index) => align[index] === "r" ? cell.padStart(widths[index]) : cell.padEnd(widths[index])).join("  ").trimEnd();
    return [line(header), ...rows.map(line)];
  }
  const heading = (block) => `== ${block.title} ==${block.note ? `  ${block.note}` : ""}`;

  // ---- the facts every section shares ----

  function facts(snapshot) {
    const capturedAt = num(snapshot.capturedAt), now = num(snapshot.now), origin = num(snapshot.timeOrigin);
    const video = object(snapshot.video);
    // page-hook.js runs in the top document, but its report says where its own clock starts.
    const ownOrigin = num(video?.timeOrigin);
    const videoDelta = ownOrigin !== null && origin !== null && Math.abs(ownOrigin - origin) < 864e5 ? ownOrigin - origin : 0;
    const clock = {
      capturedAt, now, origin,
      // performance.now() of a realm whose clock starts `delta` ms after the top document's.
      perf: (ms, delta = 0) => num(ms) === null ? null : num(ms) + (num(delta) || 0),
      // Date.now(), counted back from the capture: a clock change since the page loaded (a
      // sleep, a time sync) then does not move it.
      epoch: (ms) => {
        const at = num(ms);
        if (at === null || at <= 0) return null;
        if (capturedAt !== null && now !== null) return at - capturedAt + now;
        return origin !== null ? at - origin : null;
      }
    };
    return {
      snapshot, clock, video, videoDelta,
      player: object(video?.player),
      playback: object(video?.playback),
      downloads: object(video?.downloads),
      // A page without a video (home, search) has no engine to speak of; reports from before
      // videoPage existed count as video pages.
      engine: video?.videoPage !== false && ["full", "compat", "native"].includes(video?.actualTakeover) ? video.actualTakeover : null,
      settings: object(snapshot.settings),
      stats: object(snapshot.stats),
      auto: object(snapshot.autoThreads),
      site: object(snapshot.site),
      btr: object(snapshot.btr),
      env: object(snapshot.env),
      live: list(snapshot.live).slice(0, LIVE_LIMIT).map((module, index) => ({ ...(object(module) || {}), index }))
    };
  }

  // One row per CDN host: the node list of the player (video and audio already merged by host,
  // page-hook.js) together with the hosts the downloads went to, which can include hosts only
  // the start used or that a previous player listed.
  const STATE_ORDER = ["banned", "blocked", "healthy", "untested", "unlisted"];
  function nodeRows(c) {
    if (c.nodeRows !== undefined) return c.nodeRows;
    if (!c.video || !(Array.isArray(c.video.nodes) || Array.isArray(c.video.bannedNodes) || object(c.downloads?.hosts))) return (c.nodeRows = null);
    const byHost = new Map();
    for (const raw of list(c.video.nodes)) {
      const node = object(raw), host = hostName(node?.host);
      if (!host) continue;
      const state = STATE_ORDER.includes(node.state) ? node.state : word(node.state, "unknown").toLowerCase().replace(/\s+/g, "-");
      const known = byHost.get(host);
      if (!known || rank(state) < rank(known.state)) byHost.set(host, { host, state, bps: num(node.bps), traffic: null });
    }
    for (const raw of list(c.video.bannedNodes)) {
      const host = hostName(raw);
      if (host && !byHost.has(host)) byHost.set(host, { host, state: "banned", bps: null, traffic: null });
    }
    for (const [raw, traffic] of Object.entries(object(c.downloads?.hosts) || {})) {
      const host = hostName(raw);
      if (!host) continue;
      const row = byHost.get(host) || { host, state: "unlisted", bps: null, traffic: null };
      row.traffic = object(traffic) || {};
      byHost.set(host, row);
    }
    return (c.nodeRows = [...byHost.values()].sort((a, b) => rank(a.state) - rank(b.state)
      || (a.state === "healthy" ? (b.bps || 0) - (a.bps || 0) : 0) || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0)));
  }
  const rank = (state) => { const index = STATE_ORDER.indexOf(state); return index < 0 ? STATE_ORDER.length : index; };

  function nodeCounts(rows) {
    if (!rows) return "n/a";
    if (!rows.length) return "none";
    const counts = new Map();
    for (const row of rows) counts.set(row.state, (counts.get(row.state) || 0) + 1);
    const order = ["healthy", "untested", "blocked", "banned", "unlisted"];
    return [...counts].sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)).map(([state, n]) => `${n} ${state}`).join(", ");
  }

  // Requests per kind since the page loaded, and their sum.
  function kindTotals(downloads) {
    const byKind = object(downloads?.byKind);
    if (!byKind) return null;
    const totals = { started: 0, ok: 0, failed: 0, cancelled: 0, bytes: 0 };
    for (const kind of Object.values(byKind)) for (const key of Object.keys(totals)) totals[key] += num(object(kind)?.[key]) || 0;
    return totals;
  }
  function failedHosts(c) {
    return Object.values(object(c.downloads?.hosts) || {}).filter((host) => (num(object(host)?.failed) || 0) > 0).length;
  }

  const sessionEvents = (c) => list(c.video?.page).map(object).filter((event) => event?.what === "Bilibili replaced the video source");

  // ---- sections ----

  function header(c) {
    const btr = c.btr;
    return [
      `BTR diagnostics (format ${FORMAT}) | BTR ${btr ? `${word(btr.version)} ${word(btr.channel)}` : "n/a"} | captured ${iso(c.clock.capturedAt)}`,
      `Clock: T = seconds since page load at ${iso(c.clock.origin)}; captured at ${c.clock.now === null ? "n/a" : stamp(c.clock.now)}`
    ];
  }

  function summary(c) {
    const { video, player, playback, settings } = c;
    const setting = word(settings?.takeover ?? object(video?.settings)?.takeover);
    const frame = object(playback?.lastPresentedFrame), frames = object(playback?.frames);
    const picture = playback && `${frame ? `last frame at ${stamp(c.clock.perf(frame.observedAtMs, c.videoDelta))} (media ${position(frame.mediaTime)} s)` : "last frame n/a"}, ${count(frames?.total)} total, ${count(frames?.dropped)} dropped`;
    const playing = c.engine === "full" ? num(player?.qualityId) : c.engine === "compat" ? num(player?.downloadedQualityId) || num(player?.qualityId) : null;
    const quality = video && `playing ${playing > 0 ? qn(playing) : "n/a"}, menu ${menuQuality(object(video.nativeQuality))}`;
    const totals = kindTotals(c.downloads), active = num(c.downloads?.active);
    const requests = totals && `${Math.round(totals.started)}: ${Math.round(totals.ok)} ok, ${Math.round(totals.failed)} failed, ${Math.round(totals.cancelled)} cancelled${active > 0 ? `, ${Math.round(active)} active` : ""}`;
    return pairs([
      ["state", video ? word(video.state) : "n/a"],
      ["engine", `${c.engine || "n/a"} (setting ${setting})`],
      ["position", playback ? `${position(playback.currentTime)} / ${position(playback.duration)} s` : "n/a"],
      ["paused", playback ? `page ${yesNo(bool(playback.paused))}, element ${yesNo(elementPaused(c))}` : "n/a"],
      ["picture", picture],
      ["quality", quality],
      ["video", track(c, "video")],
      ["audio", track(c, "audio")],
      ["buffer ahead", bufferAhead(c)],
      ["threads", threads(c)],
      ["requests", requests],
      ["nodes", nodeCounts(nodeRows(c))],
      ["last error", video ? (text(video.lastError) ? sentence(video.lastError) : "none") : "n/a"]
    ]);
  }
  // BTR's player patches video.paused (what the page sees); the element's own state is read
  // through HTMLMediaElement.prototype, and the two disagreeing is a finding of its own (#65).
  const elementPaused = (c) => bool(c.playback?.elementPaused) ?? bool(c.player?.elementPaused);
  function menuQuality(menu) {
    if (!menu) return "n/a";
    if (num(menu.newQ) > 0) return qn(menu.newQ);
    return `auto (shows ${num(menu.realQ) > 0 ? `qn ${Math.round(menu.realQ)}` : "n/a"})`;
  }
  function track(c, kind) {
    const player = c.player;
    if (!player || !Object.keys(player).length) return "n/a";
    const video = kind === "video";
    const parts = [codecsOf(video ? player.videoType : player.audioType) || (video ? word(player.codec, "") : "")];
    if (video && num(player.width) > 0 && num(player.height) > 0) parts.push(`${Math.round(player.width)}x${Math.round(player.height)}`);
    if (video && num(player.frameRate) > 0) parts.push(`${fps(num(player.frameRate))} fps`);
    const bandwidth = num(video ? player.videoBandwidth : player.audioBandwidth);
    if (bandwidth > 0) parts.push(mbit(bandwidth));
    return parts.filter(Boolean).join(" ") || "n/a";
  }
  // From the element's buffered ranges at the capture; the player's last published value only
  // when an older build sent no ranges.
  function bufferAhead(c) {
    const ranges = rangesOf(c.playback?.buffered), time = num(c.playback?.currentTime);
    if (ranges && time !== null) {
      const around = ranges.find(([start, end]) => start <= time + 0.1 && time <= end);
      return `${fixed(around ? Math.max(0, around[1] - time) : 0, 1)} s`;
    }
    return c.video ? secondsAmount(c.stats?.bufferedAhead) : "n/a";
  }
  function threads(c) {
    const settings = c.settings;
    if (!settings) return "n/a";
    if (settings.autoConcurrency === true) {
      const current = num(c.auto?.threads) || num(c.stats?.autoThreads);
      return `${current ? Math.round(current) : "n/a"} (auto)`;
    }
    return settings.autoConcurrency === false ? `${count(settings.concurrency)} (manual)` : "n/a";
  }

  // Findings that restate facts from the sections below, most severe first. No guesses: each
  // rule names one condition on the data. The id column fits the longest id in the catalog, so
  // it lines up the same whichever checks fire.
  const CHECK_IDS = ["takeover-failed", "player-error", "media-error", "node-banned", "address-banned", "range-failures", "quality-mismatch", "settings-not-loaded", "other-build", "site-international", "site-gave-up", "live-error", "redirects-blocked", "source-replaced", "engine-differs", "tab-hidden"];
  const CHECK_WIDTH = Math.max(...CHECK_IDS.map((id) => id.length)) + 2;
  function checks(c) {
    const found = [];
    const add = (level, id, message) => found.push({ level, id, message });
    const { video, playback, settings, site, btr } = c;
    const takeoverError = object(c.stats?.takeoverError) || object(video?.takeoverError);
    if (takeoverError) {
      const at = c.clock.epoch(takeoverError.at);
      add("ERROR", "takeover-failed", `${word(takeoverError.stage, "unknown")}: ${sentence(takeoverError.message) || "no message"} (attempt ${count(takeoverError.retryCount)}${at === null ? "" : `, at ${stamp(at)}`})`);
    }
    if (video?.state === "error" && !(takeoverError && text(takeoverError.message) === text(video.lastError))) add("ERROR", "player-error", `state error: ${sentence(video.lastError) || "no message"}`);
    const mediaFailure = object(playback?.mediaError);
    if (mediaFailure) add("ERROR", "media-error", mediaError(mediaFailure));
    const bans = list(video?.bans).map(object).filter(Boolean);
    for (const ban of bans.filter((item) => item.kind !== "address")) {
      add("WARN", "node-banned", `${hostName(ban.host) || "n/a"}: ${plural(ban.count, "failure")} with no data${text(ban.error) ? ` (${sentence(ban.error, 80)})` : ""}`);
    }
    if (!Array.isArray(video?.bans)) for (const host of list(video?.bannedNodes).map(hostName).filter(Boolean)) add("WARN", "node-banned", `${host}: banned for this video`);
    for (const ban of bans.filter((item) => item.kind === "address")) {
      add("WARN", "address-banned", `a download address refused by the nodes, ${plural(ban.count, "failure")}, last on ${hostName(ban.host) || "n/a"}${text(ban.error) ? ` (${sentence(ban.error, 80)})` : ""}`);
    }
    const totals = kindTotals(c.downloads);
    if (totals?.failed > 0) {
      const hosts = failedHosts(c);
      add("WARN", "range-failures", `${plural(totals.failed, "failed request")}${hosts ? ` on ${plural(hosts, "node")}` : ""}`);
    }
    const menu = object(video?.nativeQuality), wanted = num(menu?.newQ), offered = list(c.player?.qualities ?? video?.qualities).map(num);
    if (c.engine === "full" && wanted > 0 && offered.includes(wanted) && num(c.player?.qualityId) !== wanted) {
      add("WARN", "quality-mismatch", `menu ${qn(wanted)}, playing ${num(c.player?.qualityId) > 0 ? qn(c.player.qualityId) : "n/a"}`);
    }
    if (!settings) add("WARN", "settings-not-loaded", "the stored settings had not reached the page at capture");
    if (text(btr?.otherBuild)) add("WARN", "other-build", `the ${word(btr.otherBuild)} build is enabled too and is not running on this page`);
    if (site?.international === true && settings?.blockInternational === true) add("WARN", "site-international", "international page while block international is on");
    if (site?.gaveUp === true) add("WARN", "site-gave-up", "BTR stopped sending this tab back to the domestic site");
    for (const module of c.live) {
      const error = text(object(module.stats)?.lastError);
      if (error) add("WARN", "live-error", `${liveName(module)}: ${sentence(error)}`);
    }
    if (num(site?.redirectsBlocked) > 0) add("INFO", "redirects-blocked", `${plural(site.redirectsBlocked, "redirect")} to the international site blocked`);
    const replaced = sessionEvents(c);
    if (replaced.length) {
      const times = replaced.reduce((sum, event) => sum + Math.max(1, Math.round(num(event.count) || 1)), 0);
      const last = c.clock.perf(replaced.at(-1).at, c.videoDelta);
      add("INFO", "source-replaced", `Bilibili replaced the video source ${plural(times, "time")}${last === null ? "" : ` (last at ${stamp(last)})`}`);
    }
    const setting = settings?.takeover ?? object(video?.settings)?.takeover;
    if (c.engine && settings?.enabled !== false && ["full", "compat"].includes(setting) && c.engine !== setting) add("INFO", "engine-differs", `setting ${setting}, running ${c.engine}`);
    if (playback?.visibility === "hidden") add("INFO", "tab-hidden", "the tab was hidden at capture");
    const order = ["ERROR", "WARN", "INFO"];
    found.sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level) || CHECK_IDS.indexOf(a.id) - CHECK_IDS.indexOf(b.id));
    return found.length ? found.map((item) => `${item.level.padEnd(6)}${item.id.padEnd(CHECK_WIDTH)}${item.message}`) : ["none"];
  }

  const PAGE_ID = /^(https?:\/\/(?:space\.bilibili\.com\/(?:[a-z-]+\/)?|m\.bilibili\.com\/space\/|(?:www\.|m\.)?bilibili\.com\/(?:[a-z-]+\/)?(?:list\/(?:ml)?|medialist\/(?:play|detail)\/(?:ml)?)))\d+/i;
  function environment(c) {
    const { btr, env } = c;
    const other = word(btr?.otherBuild, "");
    const manager = sentence(btr?.scriptManager, 80);
    // One line each, so a long first one cannot cut off the rest.
    const errors = Array.isArray(c.snapshot.readErrors) ? c.snapshot.readErrors.map((item) => sentence(item, 160)).filter(Boolean) : null;
    const errorRows = errors === null ? [["read errors", "n/a"]] : errors.length ? errors.map((item) => ["read error", item]) : [["read errors", "none"]];
    const viewport = text(env?.viewport);
    return pairs([
      ["btr", btr ? `${word(btr.version)} ${word(btr.channel)} (${word(btr.host)})` : "n/a"],
      ["other build", btr ? other ? `${other} (enabled, not running)` : "none" : "n/a"],
      ["manager", btr ? manager || (btr.host === "desktop" ? "none" : "n/a") : "n/a"],
      ["browser", sentence(env?.userAgent, 400) || "n/a"],
      ["language", word(env?.language)],
      ["viewport", /^\d{1,5}x\d{1,5}$/.test(viewport) ? viewport : "n/a"],
      // Origin and path only. A space page's path is someone's account number, and a
      // favourites list's is the number of someone's folder: both are left out.
      ["page", sentence(env?.page, 400).replace(PAGE_ID, "$1{id}") || "n/a"],
      ["route", word(c.video?.route)],
      ...errorRows
    ]);
  }

  // Which site Bilibili shows and why (#68). Cookies only as what they mean, never their value
  // (lang is a language code); signed in is only yes or no.
  function site(c) {
    const s = c.site;
    const userSite = !s ? "n/a" : s.userSite === "CN" || s.userSite === "OVERSEAS" ? s.userSite : text(s.userSite) ? "other" : "none";
    const accounts = Array.isArray(s?.accountSites) && s.accountSites.length ? s.accountSites : null;
    const account = !accounts ? "n/a" : accounts.includes("CN") ? "domestic allowed" : accounts.every((item) => item === "OVERSEAS") ? "international only" : "other";
    const lang = !s ? "n/a" : !text(s.lang) ? "none" : /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/.test(s.lang) ? s.lang : "other";
    return pairs([
      ["site", typeof s?.international === "boolean" ? s.international ? "international" : "domestic" : "n/a"],
      ["signed in", yesNo(bool(s?.signedIn))],
      ["user_site", userSite],
      ["account", account],
      ["lang cookie", lang],
      ["guard", ["on", "off", "unsupported"].includes(s?.guard) ? s.guard : "n/a"],
      ["blocked", s && num(s.redirectsBlocked) !== null ? plural(s.redirectsBlocked, "redirect") : "n/a"],
      ["gave up", yesNo(bool(s?.gaveUp))]
    ]);
  }

  // Only settings that matter for a report. The theme, the floating button, the guide and the
  // fixed download constants (implied by the version) are left out on purpose.
  function settingsSection(c) {
    const s = c.settings;
    // A value the snapshot does not have is unknown, not changed.
    const same = (key) => s[key] === undefined || JSON.stringify(s[key]) === JSON.stringify(DEFAULTS[key]);
    const mark = (value, ...keys) => `${value}${s && !keys.every(same) ? " *" : ""}`;
    const flag = (key) => s ? mark(yesNo(bool(s[key])), key) : "n/a";
    const hosts = s && (Array.isArray(s.customHosts) ? s.customHosts.map(hostName).filter(Boolean) : []);
    return pairs([
      ["enabled", flag("enabled")],
      ["takeover", s ? mark(word(s.takeover), "takeover") : "n/a"],
      ["cdn", s ? mark(word(s.mode), "mode") : "n/a"],
      ["custom hosts", s ? mark(hosts.length ? hosts.join(", ") : "none", "customHosts") : "n/a"],
      ["threads", !s ? "n/a" : s.autoConcurrency === true ? mark("auto", "autoConcurrency") : s.autoConcurrency === false ? mark(count(s.concurrency), "autoConcurrency", "concurrency") : "n/a"],
      ["buffer ahead", s ? mark(num(s.bufferAheadSeconds) === null ? "n/a" : `${count(s.bufferAheadSeconds)} s`, "bufferAheadSeconds") : "n/a"],
      ["secondary buffer", flag("secondaryBuffer")],
      ["episodes", flag("episodeEnabled")],
      ["live", flag("liveEnabled")],
      ["block international", flag("blockInternational")]
    ]);
  }

  // Bilibili's quality menu as its player reports it (getQuality): the same words in every mode.
  const menuState = (value) => { const menu = object(value); return `menu ${menu ? `now ${count(menu.nowQ)} new ${count(menu.newQ)} real ${count(menu.realQ)}` : "n/a"}`; };

  function elementRows(c) {
    const playback = c.playback;
    const state = (value, names) => { const n = num(value); return n === null ? "n/a" : `${Math.round(n)}${names[Math.round(n)] ? ` ${names[Math.round(n)]}` : ""}`; };
    const ranges = rangesOf(playback?.buffered);
    return [
      ["ready state", state(playback?.readyState, READY_STATES)],
      ["network state", state(playback?.networkState, NETWORK_STATES)],
      ["buffered", !ranges ? "n/a" : ranges.length ? ranges.map(([start, end]) => `${fixed(start, 1)}-${fixed(end, 1)}`).join(", ") : "none"]
    ];
  }

  // The full takeover in detail; for the compatibility mode the transport's own counters; for
  // Bilibili's own playback only the element.
  function playback(c) {
    const { video, player, settings } = c;
    if (!video) return ["n/a"];
    const p = player || {};
    if (c.engine === "compat") {
      const downloaded = num(p.downloadedQualityId);
      return pairs([
        ["transport", `revision ${count(p.transportRevision)}, quality guard ${yesNo(bool(p.nativeQualityGuard))} (revision ${count(p.qualityGuardRevision)})`],
        ["ranges", `${count(p.acceleratedRanges)} served, ${count(p.failedRanges)} failed, ${count(p.activeRequests)} active`],
        ["switch requests", count(p.nativeSwitchRequests)],
        ["switch pending", yesNo(bool(p.nativeSwitchPending))],
        ["quality pick", `downloaded ${downloaded > 0 ? qn(downloaded) : "n/a"}, ${menuState(video.nativeQuality)}, core now/target/rendered ${word(p.nativeQuality)}`],
        ...elementRows(c)
      ]);
    }
    if (c.engine !== "full") return pairs(elementRows(c));
    const session = list(video.timeline).map(object).filter((event) => event?.what === "session").at(-1);
    const sessionAt = session ? c.clock.perf(session.at, c.videoDelta) : null;
    const tracks = list(p.tracks).map(object).filter(Boolean);
    const segments = ["video", "audio"].map((kind) => tracks.find((item) => item.kind === kind)).filter(Boolean)
      .map((item) => `${item.kind} ${count(item.nextIndex)}/${count(item.segments)}`).join(", ");
    const menu = object(video.nativeQuality);
    const preferred = num(p.preferredQuality), auto = num(p.autoQuality);
    const qualities = p.qualities ?? video.qualities;
    const deadline = num(p.urlDeadline);
    const left = deadline > 0 && c.clock.capturedAt !== null ? deadline * 1000 - c.clock.capturedAt : null;
    const core = object(video.nativeCore), reserve = object(p.reserve);
    const lastSeek = num(p.lastSeekMs);
    return pairs([
      ["session", `started at ${position(p.sessionStartTime)} s${sessionAt === null ? "" : ` (${stamp(sessionAt)})`}`],
      ["media source", word(p.mediaSourceState)],
      ["activated", yesNo(bool(p.playbackActivated))],
      ["play wanted", yesNo(bool(p.resumeWanted))],
      ...elementRows(c),
      ["startup buffer", secondsAmount(p.startupBufferSeconds)],
      ["rebuffers", count(p.underflowRebuffers)],
      ["seek reloads", count(p.seekReloads)],
      ["last seek", lastSeek === null ? "n/a" : lastSeek > 0 ? `${duration(lastSeek)} to settle, ${plural(p.stallsAfterSeek, "stall")} after` : "none"],
      ["quality pick", `preferred ${preferred > 0 ? qn(preferred) : preferred === 0 ? "auto" : "n/a"}, auto ${auto > 0 ? qn(auto) : "n/a"}, ${menuState(menu)}`],
      ["qualities", !Array.isArray(qualities) ? "n/a" : qualities.map(num).filter((id) => id !== null).map(Math.round).join(", ") || "none"],
      ["codec pick", text(p.preferredCodec) ? word(p.preferredCodec) : "default"],
      ["segments", segments || "none"],
      ["urls expire", deadline > 0 ? `${iso(deadline * 1000, true)}${left === null ? "" : left >= 0 ? ` (in ${duration(left)})` : ` (expired ${duration(-left)} ago)`}` : "n/a"],
      ["native core", `${plural(core?.buffersLocked, "buffer")} locked, ${plural(core?.mediaRequests, "media request")}, ${plural(p.nativeLeftoversSuppressed, "hidden console error")}, ${plural(p.codecFailuresBlocked, "codec-failure write")} blocked`],
      ["second buffer", !settings ? "n/a" : settings.secondaryBuffer !== true ? "off" : reserve ? `on, ${secondsAmount(reserve.seconds)} held, ${size(reserve.bytes)} of ${size(reserve.limitBytes)}` : "on"]
    ]);
  }

  function downloads(c) {
    const d = c.downloads, byKind = object(d?.byKind), auto = c.auto, now = c.clock.now;
    const kind = (name) => {
      if (!d) return "n/a";
      const item = object(byKind?.[name]) || {};
      const n = (key) => Math.round(num(item[key]) || 0);
      return `${n("started")} started, ${n("ok")} ok, ${n("failed")} failed, ${n("cancelled")} cancelled, ${size(num(item.bytes) || 0)}`;
    };
    // Cancel reasons as the error they were thrown with, in English, as one token each.
    const reasons = new Map();
    for (const [reason, n] of Object.entries(object(d?.cancelReasons) || {})) {
      if (!(num(n) > 0)) continue;
      const token = scrub(translate(reason)).toLowerCase().replace(/\[removed\]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "unknown";
      reasons.set(token, (reasons.get(token) || 0) + num(n));
    }
    const sorted = [...reasons].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const cancelled = !d ? "n/a" : sorted.length ? [...sorted.slice(0, 8).map(([reason, n]) => `${Math.round(n)} ${reason}`), ...(sorted.length > 8 ? [`${sorted.length - 8} more`] : [])].join(", ") : "none";
    const lastBytes = num(d?.lastBytesAt);
    const at = (ms) => now === null || num(ms) === null ? "n/a" : stamp(now + num(ms));
    let threadsLine = "n/a";
    if (c.settings?.autoConcurrency === false) threadsLine = `off (manual ${count(c.settings.concurrency)})`;
    else if (auto) {
      const steps = num(auto.steps) || 0;
      threadsLine = `${count(auto.threads)}, level ${count(auto.level)}, ${plural(steps, "step")}${steps > 0 ? `, last change ${stamp(c.clock.perf(auto.changedAt))} (${sentence(auto.reason, 80) || "n/a"})` : ""}`;
    }
    const trial = object(auto?.trial), startup = object(auto?.startup);
    const resting = list(auto?.resting).map(object).filter(Boolean)
      .map((rest) => `${count(rest.threads)} threads until ${at(rest.forMs)} (${rest.hard === true ? "server refused" : "no gain"})`).join(", ");
    return pairs([
      ["video", kind("video")],
      ["audio", kind("audio")],
      ["meta", kind("meta")],
      ["active", d ? count(d.active ?? 0) : "n/a"],
      ["cancelled", cancelled],
      ["throughput", auto && num(auto.throughputBps) !== null ? mbit(num(auto.throughputBps) * 8) : "n/a"],
      ["last data", !d ? "n/a" : lastBytes > 0 ? stamp(c.clock.perf(lastBytes, c.videoDelta)) : "none"],
      ["auto threads", threadsLine],
      ["trial", !auto ? "n/a" : trial ? `${count(trial.from)} -> ${count(trial.level)} threads since ${at(-(num(trial.ageMs) || 0))}, baseline ${mbit((num(trial.baselineBps) || 0) * 8)}${trial.stalled === true ? ", stalled meanwhile" : ""}` : "none"],
      ["resting", !auto ? "n/a" : resting || "none"],
      ["startup", !auto ? "n/a" : startup ? `back to ${count(startup.base)} threads by ${at(startup.forMs)}` : "none"]
    ]);
  }

  function nodes(c) {
    if (!c.video) return ["n/a"];
    const rows = nodeRows(c);
    const lines = [];
    if (!rows) lines.push("n/a");
    else if (!rows.length) lines.push("none");
    else {
      const cell = (traffic, key) => traffic ? count(traffic[key] ?? 0) : "-";
      const shown = rows.slice(0, NODE_LIMIT).map((row) => [
        row.host, row.state, row.bps > 0 ? (row.bps * 8 / 1e6).toFixed(2) : "-",
        cell(row.traffic, "ok"), cell(row.traffic, "failed"), cell(row.traffic, "cancelled"),
        row.traffic ? size(num(row.traffic.bytes) || 0) : "-",
        row.traffic && text(row.traffic.lastError) ? sentence(row.traffic.lastError, 60) || "-" : "-"
      ]);
      lines.push(...table(["HOST", "STATE", "Mbit/s", "OK", "FAIL", "CXL", "DATA", "LAST ERROR"], shown, ["l", "l", "r", "r", "r", "r", "r", "l"]));
      if (rows.length > NODE_LIMIT) lines.push(`${rows.length - NODE_LIMIT} more`);
    }
    const addressBans = list(c.video.bans).map(object).filter((ban) => ban?.kind === "address");
    if (!Array.isArray(c.video.bans)) lines.push("address bans  n/a");
    else if (!addressBans.length) lines.push("address bans  none");
    else for (const ban of addressBans.slice(0, 20)) {
      const at = c.clock.perf(ban.at, c.videoDelta);
      lines.push(`address ban   ${hostName(ban.host) || "n/a"}: ${plural(ban.count, "failure")}${text(ban.error) ? ` (${sentence(ban.error, 80)})` : ""}${at === null ? "" : ` at ${stamp(at)}`}`);
    }
    return lines;
  }

  const liveName = (module) => word(module.frame, "") || `module ${module.index + 1}`;
  // The live module in each frame that has one: its stats and stream, on the top clock.
  function liveBlocks(c) {
    return c.live.map((module) => {
      const stats = object(module.stats), context = object(module.context), delta = num(module.timeOriginDelta) || 0;
      const hosts = list(context?.hosts ?? stats?.cdnHosts).map(object).filter((node) => hostName(node?.host));
      const errorAt = c.clock.perf(stats?.lastErrorAt, delta);
      const counts = new Map();
      for (const node of hosts) counts.set(word(node.state, "unknown"), (counts.get(word(node.state, "unknown")) || 0) + 1);
      const lines = pairs([
        ["state", stats ? word(stats.playerState) : "n/a"],
        ["stream", context ? word(context.key, "none") : "none"],
        ["last segment", context ? count(context.lastNum) : "n/a"],
        ["cached", context ? plural(context.cached, "segment") : "n/a"],
        ["requests", stats ? `${count(stats.acceleratedRequests)}, ${size(stats.acceleratedBytes)}` : "n/a"],
        ["active", stats ? count(stats.activeThreads) : "n/a"],
        ["speed", stats && num(stats.totalSpeedBps) !== null ? mbit(num(stats.totalSpeedBps) * 8) : "n/a"],
        ["nodes", hosts.length ? [...counts].map(([state, n]) => `${n} ${state}`).join(", ") : "none"],
        ["last error", !stats ? "n/a" : text(stats.lastError) ? `${sentence(stats.lastError)}${errorAt === null || !num(stats.lastErrorAt) ? "" : ` at ${stamp(errorAt)}`}` : "none"]
      ]);
      if (hosts.length) {
        const sorted = hosts.slice().sort((a, b) => rank(a.state) - rank(b.state) || (num(b.bps) || 0) - (num(a.bps) || 0));
        lines.push(...table(["HOST", "STATE", "Mbit/s"], sorted.slice(0, LIVE_NODE_LIMIT).map((node) => [hostName(node.host), word(node.state, "unknown"), num(node.bps) > 0 ? (node.bps * 8 / 1e6).toFixed(2) : "-"]), ["l", "l", "r"]));
        if (hosts.length > LIVE_NODE_LIMIT) lines.push(`${hosts.length - LIVE_NODE_LIMIT} more`);
      }
      return { title: `Live (${liveName(module)})`, note: "", lines };
    });
  }

  // ---- events ----

  const SOURCES = ["page", "player", "prev", "media", "live"];
  const LEVELS = Object.freeze({ debug: "DEBUG", info: "INFO", success: "INFO", warn: "WARN", warning: "WARN", error: "ERROR" });
  // Levels for records that carry none: older builds, the players' timelines and the element.
  const PAGE_LEVELS = Object.freeze({ "native buffer locked": "DEBUG", "native scheduler stopped": "DEBUG", "playback failed": "ERROR" });
  const PLAYER_LEVELS = Object.freeze({
    "headers requested": "DEBUG", "pause taken as the switch's": "DEBUG", "native future replacement resumed": "DEBUG",
    "native stopped scheduler resumed": "DEBUG", "native already-rendered quality confirmed": "DEBUG", "native range delivered": "DEBUG",
    "rebuffer before underflow": "WARN", "buffer quota hit": "WARN", "native range failed": "WARN",
    "native quality guard unavailable": "WARN", "native core transition: acceleration suspended": "WARN",
    "index parsed": "DEBUG", "seek inside buffer": "DEBUG", "autoplay refused": "WARN", "end of stream failed": "ERROR"
  });
  const MEDIA_LEVELS = Object.freeze({ error: "ERROR", stalled: "WARN", seeking: "DEBUG", seeked: "DEBUG", loadedmetadata: "DEBUG", canplay: "DEBUG" });
  const levelOf = (value) => LEVELS[text(value).toLowerCase()] || null;

  // Every record on one clock, in time order: page-hook's page events, the current and the
  // previous player's timelines, the element's events and the live modules' events.
  function collectEvents(c) {
    const events = [];
    const push = (source, entry, at, level, what, pos) => {
      const detail = detailText(entry.detail);
      events.push({ source, order: events.length, at, level, message: what ? detail ? `${what}: ${detail}` : what : detail || "-", pos: num(pos), count: Math.max(1, Math.round(num(entry.count) || 1)), until: null });
    };
    const records = (source, entries, levels, delta, prefix = "") => {
      for (const raw of list(entries)) {
        const entry = object(raw);
        if (!entry) continue;
        const what = sentence(entry.what ?? entry.name, 120);
        push(source, entry, c.clock.perf(entry.at, delta), levelOf(entry.level) || levels[text(entry.what ?? entry.name)] || "INFO", `${prefix}${what}`, entry.time);
      }
    };
    records("page", c.video?.page, PAGE_LEVELS, c.videoDelta);
    records("player", c.video?.timeline, PLAYER_LEVELS, c.videoDelta);
    records("prev", object(c.video?.previousPlayer)?.timeline, PLAYER_LEVELS, c.videoDelta);
    records("media", c.snapshot.media, MEDIA_LEVELS, 0);
    for (const module of c.live) records("live", module.events, {}, num(module.timeOriginDelta) || 0, c.live.length > 1 ? `[${liveName(module)}] ` : "");
    // Records without a time go last, in the order they came.
    return events.sort((a, b) => (a.at === null) - (b.at === null) || (a.at ?? 0) - (b.at ?? 0)
      || SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source) || a.order - b.order);
  }

  // Adjacent repeats of one record within 10 s of its first become one line with a count.
  function fold(events) {
    const folded = [];
    for (const event of events) {
      const last = folded.at(-1);
      if (last && last.source === event.source && last.message === event.message && last.level === event.level
        && last.at !== null && event.at !== null && event.at - last.at <= FOLD_MS) {
        last.count += event.count;
        last.until = event.at;
        continue;
      }
      folded.push({ ...event });
    }
    return folded;
  }

  function eventsBlock(c, budget) {
    const events = fold(collectEvents(c));
    if (!events.length) return { title: "Events", note: "0 shown, 0 omitted", lines: ["none"] };
    const timeWidth = Math.max(8, ...events.map((event) => event.at === null ? 1 : seconds(event.at).length));
    const posWidth = Math.max(5, ...events.map((event) => event.pos === null ? 1 : fixed(event.pos, 1).length));
    // A long message is cut before its repeat count, which always stays readable.
    const lineOf = (event) => {
      const tail = event.count > 1 ? event.until !== null && event.until !== event.at ? ` (x${event.count} until ${stamp(event.until)})` : ` (x${event.count})` : "";
      const line = clean(`${(event.at === null ? "-" : seconds(event.at)).padStart(timeWidth)}  ${event.level.padEnd(5)}  ${event.source.padEnd(6)}  ${(event.pos === null ? "-" : fixed(event.pos, 1)).padStart(posWidth)}  ${event.message}`);
      return line.length + tail.length <= LINE_LIMIT ? line + tail : `${line.slice(0, LINE_LIMIT - tail.length - 3).trimEnd()}...${tail}`;
    };
    const keep = events.map(() => true);
    // Over 400 lines: the oldest DEBUG lines go first, then the oldest INFO; WARN and ERROR stay.
    let excess = events.length - EVENT_LIMIT;
    for (const level of ["DEBUG", "INFO"]) {
      for (let index = 0; index < events.length && excess > 0; index += 1) if (keep[index] && events[index].level === level) { keep[index] = false; excess -= 1; }
    }
    const lines = events.map(lineOf);
    const header = `${"T".padStart(timeWidth)}  LEVEL  SOURCE  ${"POS".padEnd(posWidth)}  EVENT`;
    let used = header.length + 1 + lines.reduce((sum, line, index) => sum + (keep[index] ? line.length + 1 : 0), 0);
    // A paste over GitHub's limit is lost whole, so the character budget wins in the end: only
    // then do WARN and, last of all, ERROR lines go, again oldest first.
    for (const level of ["DEBUG", "INFO", "WARN", "ERROR"]) {
      for (let index = 0; index < events.length && used > budget; index += 1) if (keep[index] && events[index].level === level) { keep[index] = false; used -= lines[index].length + 1; }
    }
    const shown = lines.filter((_line, index) => keep[index]);
    return { title: "Events", note: `${shown.length} shown, ${events.length - shown.length} omitted`, lines: shown.length ? [header, ...shown] : ["none"] };
  }

  // ---- the whole report ----

  // The last line counts the lines and characters of the whole text, itself included, so a cut
  // paste shows.
  function finish(lines) {
    const body = [...lines.map(clean), ""];
    const base = body.join("\n").length + 1;
    let end = "";
    for (let pass = 0; pass < 4; pass += 1) {
      const next = `== End ==  ${body.length + 1} lines, ${base + end.length} chars`;
      if (next === end) break;
      end = next;
    }
    return `${body.join("\n")}\n${end}`;
  }

  function compose(snapshot) {
    const c = facts(snapshot);
    const blocks = [];
    const section = (title, note, build) => {
      let lines;
      try { lines = build(c); } catch (error) { lines = [`n/a (formatter failed: ${sentence(error, 120) || "unknown error"})`]; }
      blocks.push({ title, note, lines });
    };
    section("Summary", "", summary);
    section("Checks", "", checks);
    section("Environment", "", environment);
    section("Site", "", site);
    section("Settings", "(* = changed from default)", settingsSection);
    section("Playback", "", playback);
    section("Downloads", "(since page load)", downloads);
    section("CDN nodes", "", nodes);
    try { blocks.push(...liveBlocks(c)); } catch (error) { blocks.push({ title: "Live", note: "", lines: [`n/a (formatter failed: ${sentence(error, 120) || "unknown error"})`] }); }
    const fixedLines = [...header(c), ...blocks.flatMap((block) => ["", heading(block), ...block.lines])].map(clean);
    const used = fixedLines.reduce((sum, line) => sum + line.length + 1, 0);
    let events;
    // What follows the events: their heading, the blank line and the End line.
    try { events = eventsBlock(c, CHAR_LIMIT - used - 200); } catch (error) { events = { title: "Events", note: "", lines: [`n/a (formatter failed: ${sentence(error, 120) || "unknown error"})`] }; }
    return finish([...fixedLines, "", heading(events), ...events.lines]);
  }

  // Never throws: a report that says the formatter failed is still worth pasting.
  function render(snapshot) {
    try { return compose(object(snapshot) || {}); } catch (error) {
      try { return finish([`BTR diagnostics (format ${FORMAT}) | formatter failed: ${sentence(error, 120) || "unknown error"}`]); } catch (_error) {
        return `BTR diagnostics (format ${FORMAT}) | formatter failed`;
      }
    }
  }

  root.__BTR_DIAGNOSTIC_REPORT__ = Object.freeze({ FORMAT, DEFAULTS, render, translate });
})(globalThis);


/* src/live-ui.js */
(function installLiveUi(root) {
  "use strict";
  // The live player's side of the desktop build: the 直播加速 switch at the top of the player's
  // quality menu, its status line, and a BTR tag in front of the current quality. The switch is
  // kept in this origin's localStorage, so every live window shares it; live-hook.js gets it as
  // its settings message, the same message the browser version's bridge sends. Above it sits
  // 直播加速（实验性） in the client settings: bootstrap.cjs injects this file only while that is
  // on, and calls __BTR_LIVE_ALLOW__(false) in rooms already open when it is switched off.
  if (!/^live\.bilibili\.com$/i.test(root.location?.hostname || "") && root.__BTR_TEST_ALLOW_LIVE__ !== true) return;
  if (root.__btrLiveUi) return;
  Object.defineProperty(root, "__btrLiveUi", { value: true });
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__", KEY = "BTR_Desktop.live.v1";
  const doc = root.document;

  // Whoever switched it on in the settings wants it, so it starts on until switched off here.
  const load = () => { try { return JSON.parse(root.localStorage.getItem(KEY) || "{}").enabled !== false; } catch (_) { return true; } };
  let enabled = load(), allowed = true, stats = null;
  const send = () => root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, liveEnabled: allowed && enabled } }, root.location.origin);
  Object.defineProperty(root, "__BTR_LIVE_ALLOW__", { value: value => { allowed = value === true; send(); mount(); render(); } });
  function setEnabled(value) {
    enabled = value;
    try { root.localStorage.setItem(KEY, JSON.stringify({ enabled })); } catch (_) {}
    send(); render();
  }
  root.addEventListener("storage", event => { if (event.key === KEY && load() !== enabled) { enabled = load(); send(); render(); } });

  // live-hook.js publishes its counters a quarter second after each change. The speed shown is
  // the accelerated bytes of the last five seconds, so it does not drop to zero between pieces.
  const samples = [];
  root.addEventListener("message", event => {
    if (event.source !== root || event.data?.channel !== CHANNEL || event.data.type !== "stats") return;
    stats = event.data.payload;
    samples.push([Date.now(), stats.acceleratedBytes || 0, stats.acceleratedRequests || 0]);
    render();
  });
  function recent() {
    const now = Date.now();
    while (samples.length && now - samples[0][0] > 5000) samples.shift();
    if (!samples.length) return { bps: 0, working: false };
    const [t0, b0, r0] = samples[0], [t1, b1, r1] = samples[samples.length - 1];
    return { bps: samples.length > 1 ? (b1 - b0) / Math.max(1, (t1 - t0) / 1000) : 0, working: samples.length > 1 ? r1 > r0 : now - t1 < 3000 && r1 > 0 };
  }

  const style = doc.createElement("style");
  style.textContent = `
    .btr-live-row{display:flex;align-items:center;justify-content:space-between;height:36px;padding:0 8px 0 12px;font-size:12px;color:#fff;cursor:pointer;user-select:none}
    .btr-live-row:hover{background:rgba(255,255,255,.08);border-radius:4px}
    .btr-live-switch{position:relative;flex:none;width:28px;height:16px;border-radius:8px;background:rgba(255,255,255,.3);transition:background .15s}
    .btr-live-switch::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:left .15s}
    .btr-live-row[aria-checked=true] .btr-live-switch{background:#ff6699}.btr-live-row[aria-checked=true] .btr-live-switch::after{left:14px}
    .btr-live-status{padding:0 8px 2px 12px;font-size:11px;line-height:16px;color:rgba(255,255,255,.6)}
    .btr-live-copy{padding:0 8px 6px 12px;margin-bottom:4px;border-bottom:1px solid rgba(255,255,255,.12);font-size:11px;line-height:16px;color:rgba(255,255,255,.6);cursor:pointer;user-select:none}
    .btr-live-copy:hover{color:#fff}
    .btr-live-tag{display:inline-block;margin-right:6px;padding:0 4px;border-radius:3px;background:rgba(255,255,255,.25);color:#fff;font-size:10px;line-height:14px;vertical-align:1px}
    .btr-live-tag.btr-on{background:#ff6699}`;
  const row = doc.createElement("div");
  row.className = "btr-live-row"; row.setAttribute("role", "switch"); row.tabIndex = 0;
  row.innerHTML = `<span>BTR 直播加速</span><span class="btr-live-switch"></span>`;
  const status = doc.createElement("div"); status.className = "btr-live-status";
  const tag = doc.createElement("span"); tag.className = "btr-live-tag"; tag.textContent = "BTR";
  // 复制诊断信息 for this live room: what live-hook.js knows (state, nodes, its last events), laid
  // out by shared/diagnostic-report.js as English text for an issue. No stream address.
  const copy = doc.createElement("div"); copy.className = "btr-live-copy"; copy.textContent = "复制诊断信息";
  function diagnostics() {
    const live = root.__biliThreadRipperLiveDebug, perf = root.performance;
    return String(root.__BTR_DIAGNOSTIC_REPORT__.render({
      capturedAt: Date.now(), timeOrigin: perf.timeOrigin, now: perf.now(),
      btr: { version: live.getStats().version, channel: "stable", otherBuild: "", scriptManager: "", host: "desktop" },
      env: { userAgent: root.navigator.userAgent, language: root.navigator.language, viewport: `${root.innerWidth}x${root.innerHeight}`, page: `${root.location.origin}${root.location.pathname}` },
      settings: { enabled: true, liveEnabled: allowed && enabled }, site: null, video: null, stats: null, autoThreads: null, media: [],
      live: [{ frame: "top", timeOriginDelta: 0, stats: live.getStats(), context: live.getContext?.() ?? null, events: live.getEvents?.() ?? [] }], readErrors: []
    }));
  }
  // The player sits in a frame, where the clipboard API may be refused: then the old way.
  const copyText = text => root.navigator.clipboard.writeText(text).catch(() => {
    const area = doc.createElement("textarea"); area.value = text; area.style.cssText = "position:fixed;opacity:0";
    doc.documentElement.append(area); area.select();
    const done = doc.execCommand("copy"); area.remove();
    if (!done) throw Error("copy refused");
  });
  copy.addEventListener("click", event => {
    event.stopPropagation();
    Promise.resolve().then(() => copyText(diagnostics())).then(() => "已复制", () => "复制失败")
      .then(text => { copy.textContent = text; setTimeout(() => { copy.textContent = "复制诊断信息"; }, 2000); });
  });
  // The menu belongs to the player; a click here must not also pick a quality or close it.
  row.addEventListener("click", event => { event.stopPropagation(); setEnabled(!enabled); });
  row.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setEnabled(!enabled); } });

  const mb = bps => (bps / 1048576).toFixed(2);
  function render() {
    const { bps, working } = recent();
    const on = enabled && working;
    const healthy = stats?.healthyCdns || 0, total = stats?.discoveredCdns || 0;
    row.setAttribute("aria-checked", String(enabled));
    status.textContent = !enabled ? "已关闭，使用 B 站原来的连接"
      : !stats?.acceleratedRequests ? "已开启，等待下一个分片…"
      : `${on ? "加速中" : "已开启"} · 已接管 ${stats.acceleratedRequests} 个分片 · ${mb(bps)} MB/s · ${healthy}/${total} 个节点可用`;
    tag.hidden = !enabled;
    tag.classList.toggle("btr-on", on);
    tag.title = on ? `BTR 直播加速中：${mb(bps)} MB/s，${healthy} 个节点可用` : "BTR 直播加速已开启，等待分片";
  }
  // The player draws its controls late and redraws them; put the pieces back whenever they go.
  function mount() {
    if (!allowed) { row.remove(); status.remove(); copy.remove(); tag.remove(); return; }
    if (!style.isConnected && (doc.head || doc.documentElement)) (doc.head || doc.documentElement).append(style);
    const panel = doc.querySelector(".quality-wrap .panel");
    if (panel && panel.firstChild !== row) panel.prepend(row, status, copy);
    const label = doc.querySelector(".quality-wrap .selected-qn");
    if (label && label.firstChild !== tag) label.prepend(tag);
  }
  // Danmaku changes the page many times a second, so a burst of changes is checked once. Not
  // with requestAnimationFrame: a window behind others gets no frames, and the menu would stay
  // without the switch. The one-second timer checks too, in case a change slipped through.
  let queued = false;
  new MutationObserver(() => { if (!queued) { queued = true; Promise.resolve().then(() => { queued = false; mount(); }); } })
    .observe(doc.documentElement, { childList: true, subtree: true });
  setInterval(() => { mount(); render(); }, 1000);
  mount(); render(); send();
})(globalThis);


})();
