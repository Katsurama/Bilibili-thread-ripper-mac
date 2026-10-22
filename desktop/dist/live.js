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
Object.defineProperty(globalThis, "__BTR_LIVE_BUNDLE__", { value: "2026.10.19.1-d1" });

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
      // "full" replaces Bilibili's playback core; "compat" leaves it in charge and only
      // downloads its media requests.
      takeover: source.takeover === "compat" ? "compat" : "full",
      mode: ["overseas", "custom"].includes(source.mode) ? source.mode : "mainland",
      customHosts: (Array.isArray(source.customHosts) ? source.customHosts : [])
        .map(normalizeCdnHost)
        .filter((host, index, all) => host && all.indexOf(host) === index)
        .slice(0, 32),
      // The round button in the page corner that opens the settings panel, and where the
      // viewer dragged it: which side, and how far down as a share of the window height.
      floatingButton: source.floatingButton !== false,
      // Where the viewer dragged it, as shares of the window (0 = flush left, 1 = flush
      // right); null when it was never moved.
      floatingButtonLeft: source.floatingButtonLeft != null && Number(source.floatingButtonLeft) >= 0 && Number(source.floatingButtonLeft) <= 1 ? Number(source.floatingButtonLeft) : null,
      floatingButtonTop: source.floatingButtonTop != null && Number(source.floatingButtonTop) >= 0 && Number(source.floatingButtonTop) <= 1 ? Number(source.floatingButtonTop) : null,
      debugNotices: source.debugNotices === true,
      errorNotices: source.errorNotices === true,
      debugCategories: Object.fromEntries(["takeover", "playback", "download", "buffer", "settings", "other"].map(key => [key, source.debugCategories?.[key] !== false])),
      concurrency: allowed.includes(requested) ? requested : 8,
      // 自动线程数: the downloader picks the thread count itself, between 8 and 64, and
      // `concurrency` above is only what the viewer set by hand. Off unless asked for.
      autoConcurrency: source.autoConcurrency === true,
      minChunkBytes: 64 * 1024,
      firstByteTimeoutMs: 5500,
      stallTimeoutMs: 4000,
      attemptTimeoutMs: 15000,
      hedgeDelayMs: 900,
      bufferAheadSeconds: 45
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

  // The parts of the live module that carry logic: playinfo parsing, playlist parsing,
  // P2P/proxy URL handling and the host pool. No DOM and no timers, so dev tests can run
  // all of it in Node.

  // fMP4 HLS nodes that accept each other's signatures, verified by probing real streams
  // (2026-09): a segment signed for one of them downloads from all of them with HTTP 206,
  // while FLV-line (ov-gotcha07) and TS-line (gotcha105) nodes answer 403. The pool probes
  // each candidate once per stream before trusting it.
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
  // twice sent nothing. An unproven candidate must pass a probe before it enters ranking.
  function createHostPool(options = {}) {
    const health = new Map(); // host -> {fbMs, bps, failures, blockedUntil, lastSuccessAt, proven}
    const now = () => (options.now ? options.now() : Date.now());

    function entry(host) {
      if (!health.has(host)) health.set(host, { fbMs: 0, bps: 0, failures: 0, blockedUntil: 0, lastSuccessAt: 0, proven: false, emptyReplies: 0, banned: false });
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
        item.lastSuccessAt = now();
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
        const pool = (open.length ? open : all.filter(([, item]) => !item.banned)).length
          ? (open.length ? open : all.filter(([, item]) => !item.banned))
          : all;
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
  const notices = root.__BTR_RUNTIME_NOTICES__;
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
  // Off until the saved settings have arrived: a viewer who switched the module off must
  // not be taken over during the first second of the page.
  const liveOn = () => settingsLoaded && settings.enabled && settings.liveEnabled !== false;

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
    version: "2026.10.19.1-d1",
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
    takeoverError: null
  };
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
  // context: { key, playlistUrl, pool, cache: Map(url -> {promise, at, hit}), lastNum, mapUrl, probing }
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
    if (context?.key === key) {
      context.playlistUrl = playlistUrl;
      return context;
    }
    dropContext();
    const pool = core.createHostPool({
      onBan(host) { notices?.log("已停用一个直播节点", `${host} 两次没有返回数据，这个直播接下来不再使用它。`, "error", "", "live", "download"); }
    });
    let origin = "";
    try { origin = new URL(playlistUrl).hostname; } catch (_error) {}
    // The node Bilibili handed out is trusted unless it is a P2P relay. In the custom CDN
    // mode only the servers the viewer picked join it; otherwise the known fMP4 group does.
    if (origin && !core.isP2pUrl(playlistUrl)) pool.add(origin, true);
    const extra = settings.mode === "custom" ? settings.customHosts : core.KNOWN_FMP4_HOSTS;
    for (const host of extra) if (host !== origin) pool.add(host, false);
    context = { key, playlistUrl, pool, cache: new Map(), lastNum: 0, mapUrl: "", probing: false, speculativeMisses: 0, prefetchQueue: [], inflightPrefetch: 0, urgentInflight: 0, abort: new AbortController() };
    stats.playerState = "ready";
    notices?.log("已接管这个直播", "直播分片改为多节点竞速下载，并提前缓存即将播放的分片。", "success", "", "live", "takeover");
    schedulePublish();
    return context;
  }

  // Candidate nodes must prove they serve this stream before ranking uses them: the
  // signature is shared within the fMP4 node group, but a node may still lack the stream.
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
          if (item) item.bps = received * 1000 / Math.max(1, performance.now() - startedAt);
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

  // One segment: the best node first, a hedge copy on the second-best when the first is
  // slow to produce bytes. 404 means "not born yet" for a speculative fetch and is not a
  // node failure.
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

  // What a new playlist drives: prefetch the announced-but-uncached tail, the init map,
  // and — once everything announced is in hand — one speculative future segment, whose
  // 404 only means the encoder has not produced it yet.
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
      notices?.log("直播分片下载失败", `${stats.lastError}\n这一片交回给 B 站原来的连接。`, "error", "seg-fallback", "live", "download");
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

  // P2P and relay-wrapped URLs route back to the best official node; without a pool yet,
  // an smtcdns wrapper at least unwraps to the node it fronts.
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

  // A player that loads media over XMLHttpRequest gets the URL rewrite (P2P removal and
  // best-node routing); synthesizing full XHR responses is not worth the risk here.
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
      notices?.configure(settings);
      if (!settingsLoaded || previous.enabled !== settings.enabled || previous.liveEnabled !== settings.liveEnabled) {
        settingsLoaded = true;
        notices?.log("直播加速设置已生效", liveOn() ? "直播分片使用多节点竞速下载。" : "直播加速已关闭，使用 B 站原来的连接。", "success", "", "live", "settings");
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
      version: "2026.10.19.1-d1"
    })
  });
  publish();
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
    .btr-live-status{padding:0 8px 6px 12px;margin-bottom:4px;border-bottom:1px solid rgba(255,255,255,.12);font-size:11px;line-height:16px;color:rgba(255,255,255,.6)}
    .btr-live-tag{display:inline-block;margin-right:6px;padding:0 4px;border-radius:3px;background:rgba(255,255,255,.25);color:#fff;font-size:10px;line-height:14px;vertical-align:1px}
    .btr-live-tag.btr-on{background:#ff6699}`;
  const row = doc.createElement("div");
  row.className = "btr-live-row"; row.setAttribute("role", "switch"); row.tabIndex = 0;
  row.innerHTML = `<span>BTR 直播加速</span><span class="btr-live-switch"></span>`;
  const status = doc.createElement("div"); status.className = "btr-live-status";
  const tag = doc.createElement("span"); tag.className = "btr-live-tag"; tag.textContent = "BTR";
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
    if (!allowed) { row.remove(); status.remove(); tag.remove(); return; }
    if (!style.isConnected && (doc.head || doc.documentElement)) (doc.head || doc.documentElement).append(style);
    const panel = doc.querySelector(".quality-wrap .panel");
    if (panel && panel.firstChild !== row) panel.prepend(row, status);
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
