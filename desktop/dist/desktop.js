globalThis.__BTR_DESKTOP_RELEASE__={"version":"2026.11.10.1-d1","adapterRevision":1};

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


/* shared/cdn-resolver.js */
(function installCdnResolver(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  if (!core) return;

  const MAINLAND_HOSTS = Object.freeze([
    "upos-sz-mirrorali.bilivideo.com",
    "upos-sz-mirrorhw.bilivideo.com",
    "upos-sz-mirrorbos.bilivideo.com",
    "upos-sz-mirror08c.bilivideo.com",
    "upos-sz-mirrorbd.bilivideo.com",
    "upos-sz-mirror14b.bilivideo.com",
    "upos-sz-estgoss.bilivideo.com",
    "upos-sz-mirrorcos.bilivideo.com",
    "upos-sz-mirrorcoso1.bilivideo.com"
  ]);

  const OVERSEAS_HOSTS = Object.freeze([
    "upos-sz-mirrorcosov.bilivideo.com",
    "upos-sz-mirroraliov.bilivideo.com",
    "cn-hk-eq-01-01.bilivideo.com",
    "cn-hk-eq-01-03.bilivideo.com"
  ]);

  function isAkamaiUrl(value) {
    try { return new URL(value).hostname.toLowerCase().endsWith(".akamaized.net"); }
    catch (_error) { return false; }
  }

  // A P2P or edge-cache relay (an mcdn node, or the mountaintoys.cn caches beside them) wraps
  // the file in its own path and signature. Its address works only on relays: every ordinary
  // node refuses it.
  function isRelayUrl(value) {
    try {
      const url = new URL(value);
      return /(?:^|\.)mcdn\./i.test(url.hostname) || /^\/v1\/resource\//i.test(url.pathname)
        || String(url.searchParams.get("os") || "").toLowerCase() === "mcdn";
    } catch (_error) {
      return false;
    }
  }

  function safeMediaUrl(value) {
    try {
      const url = new URL(String(value));
      return core.isBilibiliMediaUrl(url.href) ? url.href : null;
    } catch (_error) {
      return null;
    }
  }

  function swapOrdinaryHost(rawUrl, targetHost, allowAkamai = false) {
    if (!allowAkamai && isAkamaiUrl(rawUrl)) return null;
    const host = String(targetHost || "").toLowerCase();
    if (core.normalizeCdnHost(host) !== host) return null;
    try {
      const url = new URL(rawUrl);
      // Setting only the host name would keep a non-standard port, such as a peer CDN's
      // :4483, so the port is cleared too.
      url.hostname = host;
      url.port = "";
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  // The custom mode uses only the servers picked in the settings. Without any, it uses the
  // mainland node list.
  function customServers(mode, customHosts) {
    return mode === "custom" && Array.isArray(customHosts) ? customHosts.map(core.normalizeCdnHost).filter(Boolean) : [];
  }

  function representationUrls(representation, mode, customHosts = []) {
    const primary = representation?.baseUrl || representation?.base_url;
    const backup = representation?.backupUrl || representation?.backup_url || representation?.backup_url_list || [];
    const originals = [primary, ...(Array.isArray(backup) ? backup : [])]
      .map(safeMediaUrl)
      .filter(Boolean)
      .filter((value, index, all) => all.indexOf(value) === index);
    const custom = customServers(mode, customHosts);
    const hosts = custom.length ? custom : mode === "overseas" ? OVERSEAS_HOSTS : MAINLAND_HOSTS;
    // A relay address moved to an ordinary node is refused there, so only ordinary addresses
    // are moved to the other nodes.
    const ordinary = originals.filter((url) => !isRelayUrl(url));
    const donor = ordinary.find((url) => !isAkamaiUrl(url));
    // Some overseas accounts are given nothing but akamaized.net addresses. That used to leave
    // no node at all in mainland mode and a single one in overseas mode. The nodes accept
    // those signatures too, so only in that case the akamaized.net addresses are the donors.
    // Bilibili may hand out an address that every node refuses (HTTP 403) next to one that
    // works, so each of them is tried; the ban list drops the refused one. Node-major order
    // puts every address in the first few requests, so one that every node refuses cannot
    // take all of them.
    const synthetic = (donor
      ? hosts.map((host) => swapOrdinaryHost(donor, host))
      : hosts.flatMap((host) => ordinary.map((url) => swapOrdinaryHost(url, host, true))))
      .map(safeMediaUrl)
      .filter(Boolean);
    const allowedOriginals = custom.length
      ? originals.filter((url) => custom.includes(hostOf(url)))
      : mode === "overseas"
        ? originals.filter((url) => !MAINLAND_HOSTS.includes(hostOf(url)))
        : originals.filter((url) => MAINLAND_HOSTS.includes(hostOf(url)));
    // Bilibili sometimes hands a track out only through relays. No other node can serve it
    // then, so the relays are used whatever the mode, rather than giving the video up.
    const relays = ordinary.length ? [] : originals;
    return [...allowedOriginals, ...synthetic, ...relays].filter((value, index, all) => all.indexOf(value) === index);
  }

  function hostOf(value) {
    try { return new URL(value).hostname.toLowerCase(); }
    catch (_error) { return ""; }
  }

  // The signed address without its node: the same address can be asked of any node.
  function addressOf(value) {
    try {
      const url = new URL(value);
      return url.pathname + url.search;
    } catch (_error) {
      return "";
    }
  }

  // A CDN node that twice fails without sending a single byte is skipped for the
  // rest of the current video. The owner resets the list when the video changes.
  //
  // HTTP 4xx means the node answered and refused the signed address, and either side can be
  // at fault: a node may lack the file, or Bilibili may have handed out an address that every
  // node refuses. What has delivered data decides it. Refused by a node that serves other
  // addresses, the address is dropped; refused where other nodes serve it, the node is.
  // With neither known yet, the reply counts against nobody until one of them delivers.
  function createBanList(options = {}) {
    const limit = Math.max(1, Math.trunc(Number(options.limit)) || 2);
    const emptyReplies = new Map();
    const goodNodes = new Set();
    const goodAddresses = new Set();
    const reported = new Set();
    let banned = new Set();

    function judge(url, error) {
      const strikes = new Map();
      for (const [key, count] of emptyReplies) {
        const [node, address, refused] = key.split("\n");
        // A node that serves other addresses and refuses one that other nodes serve loses only
        // that pair; it is often the fastest node for the addresses it does serve.
        const blamed = !refused ? `node:${node}`
          : goodNodes.has(node) ? (goodAddresses.has(address) ? `pair:${node} ${address}` : `address:${address}`)
            : goodAddresses.has(address) ? `node:${node}` : "";
        if (blamed) strikes.set(blamed, (strikes.get(blamed) || 0) + count);
      }
      banned = new Set([...strikes].filter(([, count]) => count >= limit).map(([key]) => key));
      let added = false;
      for (const key of banned) {
        if (reported.has(key)) continue;
        reported.add(key);
        added = true;
        const isNode = key.startsWith("node:");
        try { options.onBan?.(isNode ? key.slice(5) : hostOf(url), strikes.get(key), error, isNode ? "node" : "address"); } catch (_error) {}
      }
      return added;
    }

    return Object.freeze({
      record(url, receivedBytes, error) {
        if (error?.name === "AbortError" || Number(receivedBytes) > 0) return false;
        const node = hostOf(url);
        if (!node) return false;
        const status = Number(error?.status) || 0;
        const key = `${node}\n${addressOf(url)}\n${status >= 400 && status < 500 ? "refused" : ""}`;
        emptyReplies.set(key, (emptyReplies.get(key) || 0) + 1);
        return judge(url, error);
      },
      success(url) {
        const node = hostOf(url);
        const address = addressOf(url);
        if (!node || (goodNodes.has(node) && goodAddresses.has(address))) return;
        goodNodes.add(node);
        goodAddresses.add(address);
        judge(url, null);
      },
      allows: (url) => !banned.has(`node:${hostOf(url)}`) && !banned.has(`address:${addressOf(url)}`) && !banned.has(`pair:${hostOf(url)} ${addressOf(url)}`),
      allowsNode: (url) => !banned.has(`node:${hostOf(url)}`),
      allowsAddress: (url) => !banned.has(`address:${addressOf(url)}`),
      hosts: () => [...banned].filter((key) => key.startsWith("node:")).map((key) => key.slice(5)),
      reset() {
        emptyReplies.clear();
        goodNodes.clear();
        goodAddresses.clear();
        reported.clear();
        banned = new Set();
      }
    });
  }

  // How long a measured speed counts. A node in use is measured again with every segment; one
  // that was left out for being slow goes back to the untested ones after this, and gets
  // another try through the exploration slot.
  const MEASUREMENT_TTL_MS = 90000;

  function createResolver(representation, getMode, bans = null, getCustomHosts = null) {
    const health = new Map();
    // What is known about a node's speed, per node and file, without the query. An address
    // with a fresh signature is the same route, so it starts with what its predecessor
    // measured. Failures are not kept here: those belong to the address they happened on.
    const routes = new Map();
    const routeKeys = new Map();
    const routeOf = (url) => {
      let key = routeKeys.get(url);
      if (!key) {
        try {
          const parsed = new URL(url);
          key = `${parsed.host}${parsed.pathname}`;
        } catch (_error) { key = String(url); }
        if (routeKeys.size > 512) routeKeys.clear();
        routeKeys.set(url, key);
      }
      return key;
    };
    const measurement = (url) => routes.get(routeOf(url)) || null;
    // Only a transfer long enough to measure a speed renews it. The short tail of a resumed
    // piece proves the node works, and must not keep an old speed alive for ever.
    const measuredNow = (url, now = Date.now()) => {
      const item = measurement(url);
      return Boolean(item?.lastMeasuredAt) && now - item.lastMeasuredAt < MEASUREMENT_TTL_MS;
    };
    const bySpeed = (a, b) => {
      const am = measurement(a) || {};
      const bm = measurement(b) || {};
      return Number(Boolean(bm.lastSuccessAt)) - Number(Boolean(am.lastSuccessAt)) || (bm.bps || 0) - (am.bps || 0);
    };
    let cursor = 0;
    let mediaRangeCount = 0;
    let rangeCursor = 0;

    function allUrls() {
      return representationUrls(representation, getMode?.(), getCustomHosts?.() || []);
    }

    // Banned nodes, addresses and node/address pairs are left out. If everything is banned,
    // keep using the full list rather than leaving the video with no download address at all.
    function unbanned(list) {
      if (!bans) return list;
      const allowed = list.filter(bans.allows);
      return allowed.length ? allowed : list;
    }

    function urls() {
      return unbanned(allUrls());
    }

    function ordered(pieceIndex = 0, exclude = new Set()) {
      const now = Date.now();
      const candidates = urls().filter((url) => !exclude.has(url));
      const available = candidates.filter((url) => (health.get(url)?.blockedUntil || 0) <= now);
      const pool = available.length ? available : candidates;
      if (!pool.length) return [];
      const offset = (cursor + pieceIndex) % pool.length;
      const rotated = pool.slice(offset).concat(pool.slice(0, offset));
      cursor = (cursor + 1) % pool.length;
      return rotated;
    }

    function rangeCandidates() {
      const now = Date.now();
      const pool = urls()
        .filter((url) => (health.get(url)?.blockedUntil || 0) <= now)
        .sort(bySpeed);
      if (!pool.length) return urls();
      const firstRange = mediaRangeCount === 0;
      const width = Math.min(firstRange ? pool.length : 6, pool.length);
      let selected;
      const warmupRanges = getMode?.() === "mainland" ? 1 : 4;
      if (mediaRangeCount < warmupRanges) {
        selected = pool.slice(0, width);
        rangeCursor = width % pool.length;
      } else {
        // After the warm-up the measured nodes carry the segments in speed order; the
        // downloader gives the fast ones the larger share. One other node rides along per
        // segment: one that never answered, or one whose measurement has gone stale because
        // it was too slow to be used. Routes change, so a slow node is not slow for good.
        // While fewer nodes are measured than a segment uses, the free places go to the others
        // as well: the downloader gives an unmeasured node only a trial piece or two, so
        // finding the good nodes quickly costs little.
        const measured = pool.filter((url) => measuredNow(url, now));
        const rest = pool.filter((url) => !measuredNow(url, now));
        const places = Math.min(rest.length, Math.max(1, width - measured.length));
        const explore = Array.from({ length: places }, (_item, index) => rest[(rangeCursor + index) % rest.length]);
        rangeCursor = (rangeCursor + places) % Math.max(1, pool.length);
        selected = [...measured.slice(0, width - explore.length), ...explore];
        for (const url of pool) {
          if (selected.length >= Math.min(3, pool.length)) break;
          if (!selected.includes(url)) selected.push(url);
        }
      }
      mediaRangeCount += 1;
      return selected;
    }

    function startupCandidates() {
      const now = Date.now();
      const primary = representation?.baseUrl || representation?.base_url;
      const backup = representation?.backupUrl || representation?.backup_url || representation?.backup_url_list || [];
      // The first request also races the addresses Bilibili handed out, except in the custom
      // mode, which keeps to the picked servers.
      const originals = customServers(getMode?.(), getCustomHosts?.()).length ? [] : [primary, ...(Array.isArray(backup) ? backup : [])]
        .map(safeMediaUrl)
        .filter(Boolean);
      const candidates = unbanned([...originals, ...allUrls()]
        .filter((url, index, all) => all.indexOf(url) === index))
        .filter((url) => (health.get(url)?.blockedUntil || 0) <= now);
      return candidates.slice(0, 8);
    }

    function rescueCandidates() {
      const now = Date.now();
      return urls()
        .filter((url) => (health.get(url)?.blockedUntil || 0) <= now)
        .sort(bySpeed);
    }

    function success(url, bps) {
      bans?.success?.(url);
      const old = measurement(url) || {};
      const now = Date.now();
      const measured = bps > 0;
      health.set(url, { failures: 0, blockedUntil: 0, lastSuccessAt: now });
      routes.set(routeOf(url), {
        lastSuccessAt: now,
        // No speed comes with a transfer too short to measure one; the last one stays, and
        // keeps its age.
        lastMeasuredAt: measured ? now : old.lastMeasuredAt || 0,
        bps: !measured ? old.bps || 0 : old.bps ? old.bps * 0.65 + bps * 0.35 : bps
      });
    }

    // The speed of a transfer that was cut off before its end. It says how fast the node is
    // and nothing more: the address has not proven itself, and earlier failures stay.
    function sample(url, bps) {
      if (!(bps > 0)) return;
      const old = measurement(url) || {};
      routes.set(routeOf(url), {
        lastSuccessAt: old.lastSuccessAt || 0,
        lastMeasuredAt: Date.now(),
        bps: old.bps ? old.bps * 0.65 + bps * 0.35 : bps
      });
    }

    function failure(url, error, receivedBytes = 0) {
      if (error?.name === "AbortError") return;
      bans?.record(url, receivedBytes, error);
      const old = health.get(url) || {};
      const failures = (old.failures || 0) + 1;
      health.set(url, {
        ...old,
        failures,
        blockedUntil: Date.now() + Math.min(60000, 3000 * (2 ** Math.min(failures, 4)))
      });
    }

    function status() {
      const now = Date.now();
      // A refused address says nothing about its node, so it is left out of the node list.
      const all = allUrls();
      const usable = bans?.allowsAddress ? all.filter(bans.allowsAddress) : all;
      return (usable.length ? usable : all).map((url) => {
        const item = health.get(url) || {};
        const nodeBanned = bans && !(bans.allowsNode ? bans.allowsNode(url) : bans.allows(url));
        return {
          host: new URL(url).hostname,
          state: nodeBanned ? "banned" : (item.blockedUntil || 0) > now ? "blocked" : measurement(url)?.lastSuccessAt ? "healthy" : "untested",
          bps: measurement(url)?.bps || 0
        };
      });
    }

    const allows = (url) => !bans || bans.allows(url);
    // The measured download speed of an address, for weighting piece assignments. 0 when
    // there is none or it has gone stale.
    const speed = (url) => (measuredNow(url) ? measurement(url)?.bps || 0 : 0);
    return Object.freeze({ allows, failure, ordered, rangeCandidates, rescueCandidates, sample, speed, startupCandidates, status, success, urls });
  }

  root.__BILI_CDN_RESOLVER_FACTORY__ = Object.freeze({
    MAINLAND_HOSTS,
    OVERSEAS_HOSTS,
    createBanList,
    createResolver,
    isAkamaiUrl,
    isRelayUrl,
    representationUrls,
    swapOrdinaryHost
  });
})(globalThis);


/* shared/idm-downloader.js */
(function installIdmDownloader(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  if (!core) return;

  const PIECE_ROUNDS = 3;
  const PIECE_RETRY_WINDOW_MS = 25000;
  // The pause before a piece's next round of addresses: half a second, doubling, at most two.
  const roundPause = (round) => Math.min(2000, 500 * (2 ** (round - 1)));
  // Below this a resumed request saves less than its own round trip costs.
  const RESUME_MIN_BYTES = 32 * 1024;
  // Hedging a piece with a playback deadline (see hedgeDue): a first copy projected to finish
  // this long before the deadline gets no copy yet; one receiving at least HEDGE_PACE of the
  // usual connection speed is on pace; a copy's node measured HEDGE_FASTER times faster than the
  // first copy is receiving is worth a copy anyway.
  const HEDGE_SLACK_MS = 1500;
  const HEDGE_PACE = 0.6;
  const HEDGE_FASTER = 1.5;
  // Queue classes, served in this order: the startup probe and init/index, then startup
  // pieces, then everything else. A class never waits behind a lower one.
  const QUEUE_CRITICAL = 0, QUEUE_STARTUP = 1, QUEUE_ORDINARY = 2;
  // Priority an ordinary request with a playback deadline gains per millisecond of waiting:
  // 20 (a hedge copy's boost) in 0.9 s.
  const QUEUE_AGING_PER_MS = 20 / 900;
  // A shorter transfer is mostly round trip. The tail of a resumed piece can be a few KiB,
  // and counting it would mark down the very node that came to the rescue.
  const SPEED_SAMPLE_MIN_BYTES = 48 * 1024;

  function abortError(reason) {
    if (reason instanceof Error || reason instanceof DOMException) return reason;
    return new DOMException("播放器任务已取消", "AbortError");
  }

  class Semaphore {
    constructor(limit) {
      this.limit = limit;
      this.active = 0;
      this.queue = [];
      this.sequence = 0;
    }

    setLimit(limit) {
      this.limit = Math.max(1, Math.min(512, Math.trunc(limit) || 1));
      this.drain();
    }

    drain() {
      try { this.drainQueue(); } finally { this.onChange?.(this.active, this.limit, this.queue.length); }
    }

    drainQueue() {
      while (this.active < this.limit && this.queue.length) {
        const now = performance.now();
        const urgency = entry => {
          // Read again at every pass: the player's deadline moves with the playhead and the
          // playback rate, and a queued piece may have become due while it waited.
          const deadlineAt = entry.deadline ? entry.deadline() : entry.deadlineAt;
          if (!Number.isFinite(deadlineAt)) return 0;
          const remaining = deadlineAt - now;
          if (remaining <= 0) return 12;
          if (remaining <= 750) return 9;
          if (remaining <= 2000) return 6;
          return 0;
        };
        // A bounded, recomputed boost prevents overdue primaries from sitting behind
        // prefetch work without turning the queue back into strict deadline ordering. A
        // request with a deadline also gains priority while it waits, so a piece queued long
        // ago is not passed over again and again by newer ones of a slightly higher priority;
        // requests without one (compatibility mode, the desktop client) keep the fixed order.
        // Sorting inside the class keeps the startup probe, init and index, and then the
        // startup pieces, ahead of ordinary media whatever the boosts add up to.
        const rank = entry => entry.priority + urgency(entry)
          + (entry.ages ? (now - entry.queuedAt) * QUEUE_AGING_PER_MS : 0);
        this.queue.sort((a, b) => a.queueClass - b.queueClass || rank(b) - rank(a)
          || a.sequence - b.sequence);
        const entry = this.queue.shift();
        entry.signal?.removeEventListener("abort", entry.cancel);
        if (entry.signal?.aborted) {
          entry.reject(abortError(entry.signal.reason));
          continue;
        }
        this.active += 1;
        entry.resolve(() => {
          if (entry.released) return;
          entry.released = true;
          this.active = Math.max(0, this.active - 1);
          this.drain();
        });
      }
    }

    // deadline: a function giving the clock time playback needs this request, or null; the
    // fixed deadlineAt is what callers without one pass.
    acquire(signal, priority = 0, deadlineAt = Infinity, queueClass = QUEUE_CRITICAL, ages = false, deadline = null) {
      if (signal?.aborted) return Promise.reject(abortError(signal.reason));
      return new Promise((resolve, reject) => {
        const entry = {
          reject,
          resolve,
          signal,
          released: false,
          priority: Number(priority) || 0,
          deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : Infinity,
          deadline,
          queueClass,
          ages,
          queuedAt: performance.now(),
          sequence: this.sequence++
        };
        entry.cancel = () => {
          const index = this.queue.indexOf(entry);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal.removeEventListener("abort", entry.cancel);
          reject(abortError(signal.reason));
        };
        signal?.addEventListener("abort", entry.cancel, { once: true });
        this.queue.push(entry);
        this.drain();
      });
    }
  }

  // 自动线程数. One controller for the whole page: the thread count starts at 8 and climbs a
  // ladder towards 64 on every sign that the download is not keeping up with playback
  // (the player stalls; a low buffer stops growing while bytes keep arriving; a
  // connection waits too long for its first byte while every slot is busy). Every step up
  // is a trial: ten seconds later the bytes per second must have grown, otherwise the
  // step is taken back to where it started and that level rests for a while — more
  // connections that bring nothing only add risk. A server refusing the load (412, 429)
  // steps it back too, and nothing climbs past a refused level until it has rested. The
  // level is kept across videos on the same page; a new page starts at 8 again.
  //
  // Each start (a new video, a seek outside the buffer) opens with at least 16 threads: the
  // first seconds are when a slow node turns into a spinning wheel. Once the buffer is well
  // ahead, the count steps back down to the level the page had before. A sign of not keeping
  // up meanwhile climbs as usual and ends the start there; so does half a minute without
  // catching up. From then on the rules above carry on.
  //
  // Stalls, the buffer and new starts come from the player (stall, buffer, newSession); a
  // caller that reports none of them (the userscript's compatibility mode) gets only the
  // slow-first-byte climb and the refusals.
  const AUTO_LADDER = Object.freeze([8, 12, 16, 24, 32, 48, 64]);
  const AUTO_STARTUP_LEVEL = 2;
  const AUTO_STARTUP_COMFORT_SECONDS = 15;
  const AUTO_STARTUP_MAX_MS = 30000;
  const AUTO_STEP_COOLDOWN_MS = 2500;
  const AUTO_TRIAL_MS = 10000;
  const AUTO_WINDOW_MS = 5000;
  const AUTO_BUCKET_MS = 250;
  const AUTO_REST_MS = 90000;
  const AUTO_PUSHBACK_REST_MS = 180000;
  const AUTO_LOW_BUFFER_SECONDS = 6;
  const AUTO_PRESSURE_MS = 1000;
  const AUTO_ACTIVITY_MS = 1500;

  function createAutoConcurrency({ now = () => performance.now() } = {}) {
    const listeners = new Set();
    const state = {
      level: 0, changedAt: 0, reason: "起步", steps: 0, trial: null,
      // level index -> { until, hard }: hard rests (refusals) also cap every level above.
      resting: new Map(),
      buckets: [], lastActivityAt: -Infinity,
      // Time the connections spent saturated: intervals of { from, to } within the window.
      saturated: false, saturatedSince: 0, saturatedSpans: [],
      aheadSamples: [], pressureSince: 0,
      // The start of a session while it runs above the page's own level: { base, until }.
      startup: null
    };
    const threads = () => AUTO_LADDER[state.level];

    function pruneBuckets(at) {
      while (state.buckets.length && at - state.buckets[0].at > AUTO_WINDOW_MS) state.buckets.shift();
    }

    // Bytes per second over the window, from completed pieces only: a hedge copy that lost
    // its race is not delivery.
    function throughput(at = now()) {
      pruneBuckets(at);
      if (!state.buckets.length) return 0;
      const bytes = state.buckets.reduce((sum, item) => sum + item.bytes, 0);
      // Over the time between the first and the last delivery in the window: an idle tail
      // (nothing wanted) is not slowness.
      return bytes * 1000 / Math.max(1000, state.buckets.at(-1).at - state.buckets[0].at + AUTO_BUCKET_MS);
    }

    // The share of the window during which every slot was busy and pieces were queued.
    function saturation(at = now()) {
      const from = at - AUTO_WINDOW_MS;
      state.saturatedSpans = state.saturatedSpans.filter((span) => span.to > from);
      let busy = state.saturatedSpans.reduce((sum, span) => sum + Math.max(0, span.to - Math.max(span.from, from)), 0);
      if (state.saturated) busy += Math.max(0, at - Math.max(state.saturatedSince, from));
      return Math.min(1, busy / AUTO_WINDOW_MS);
    }

    function resting(level, at) {
      const rest = state.resting.get(level);
      if (!rest) return null;
      if (rest.until <= at) { state.resting.delete(level); return null; }
      return rest;
    }

    function setLevel(level, reason, trial) {
      const previous = threads();
      const at = now();
      state.level = level;
      state.changedAt = at;
      state.reason = reason;
      state.steps += 1;
      state.trial = trial || null;
      state.pressureSince = 0;
      for (const listener of listeners) {
        try { listener({ threads: threads(), previous, reason }); } catch (_error) {}
      }
    }

    // Up one level. A level resting after a refusal caps the climb; one resting after a
    // fruitless trial is skipped only by a strong signal (a stall), not by pressure.
    function stepUp(reason, strong) {
      const at = now();
      if (at - state.changedAt < AUTO_STEP_COOLDOWN_MS) return false;
      if (resting(state.level, at)?.hard) return false;
      let next = state.level + 1;
      while (next < AUTO_LADDER.length) {
        const rest = resting(next, at);
        if (!rest) break;
        if (rest.hard || !strong) return false;
        next += 1;
      }
      if (next >= AUTO_LADDER.length) return false;
      setLevel(next, reason, { from: state.level, level: next, at, baseline: throughput(at), stalled: false });
      // Not keeping up even with the start's threads: the start ends at this level.
      state.startup = null;
      return true;
    }

    // How high a start may go: up to 16 threads, but not onto or past a level the server
    // refused (a fruitless trial does not hold it back; the start comes down on its own).
    function startupLevel(at) {
      if (resting(state.level, at)?.hard) return state.level;
      let level = state.level;
      while (level < AUTO_STARTUP_LEVEL && !resting(level + 1, at)?.hard) level += 1;
      return level;
    }

    function stepDown(target, restLevel, reason, restMs, hard) {
      state.resting.set(restLevel, { until: now() + restMs, hard });
      if (target >= state.level) return false;
      setLevel(target, reason, null);
      return true;
    }

    // A step up has had its time: did the extra connections deliver? Only judged when the
    // connections were busy meanwhile; an idle download (buffer full) proves nothing, and
    // so does a stall in between. Without any gain the step goes back to where it started.
    function judgeTrial(at) {
      const trial = state.trial;
      if (!trial || at - trial.at < AUTO_TRIAL_MS) return;
      state.trial = null;
      if (trial.stalled || saturation(at) < 0.6 || trial.baseline <= 0) return;
      if (throughput(at) < trial.baseline) {
        stepDown(trial.from, trial.level, `${AUTO_LADDER[trial.level]} 线程没有比 ${AUTO_LADDER[trial.from]} 线程更快`, AUTO_REST_MS, false);
      }
    }

    return Object.freeze({
      ladder: AUTO_LADDER,
      threads,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      // A piece arrived whole.
      delivered(bytes, at = now()) {
        const last = state.buckets.at(-1);
        if (last && at - last.at < AUTO_BUCKET_MS) last.bytes += bytes;
        else state.buckets.push({ at, bytes });
        pruneBuckets(at);
        judgeTrial(at);
      },
      // Bytes are flowing on some connection right now.
      activity(at = now()) {
        state.lastActivityAt = at;
      },
      // The connections' state whenever it changes.
      demand(active, limit, queued, at = now()) {
        const saturated = active >= limit && queued > 0;
        if (saturated === state.saturated) return;
        if (state.saturated) state.saturatedSpans.push({ from: state.saturatedSince, to: at });
        state.saturated = saturated;
        state.saturatedSince = at;
        saturation(at);
      },
      // The player stalled: more threads at once.
      stall(reason = "播放卡了一下") {
        if (state.trial) state.trial.stalled = true;
        return stepUp(reason, true);
      },
      // The buffer ahead of the playhead, a few times a second while playing. A low buffer
      // that has not grown over the last second although bytes keep arriving, for a whole
      // second, means the connections are too few.
      buffer(ahead, playing, at = now()) {
        state.aheadSamples.push({ at, ahead });
        while (state.aheadSamples.length && at - state.aheadSamples[0].at > AUTO_PRESSURE_MS + AUTO_BUCKET_MS) state.aheadSamples.shift();
        // The start: once well ahead, one step back down per cooldown towards the page's level.
        const start = state.startup;
        if (start && at >= start.until) state.startup = null;
        else if (start && ahead >= AUTO_STARTUP_COMFORT_SECONDS && at - state.changedAt >= AUTO_STEP_COOLDOWN_MS) {
          if (state.level > start.base) setLevel(state.level - 1, `开头已经跟上，线程数降到 ${AUTO_LADDER[state.level - 1]}`, null);
          if (state.level <= start.base) state.startup = null;
        }
        const earlier = state.aheadSamples.find((item) => at - item.at >= AUTO_PRESSURE_MS);
        const downloading = at - state.lastActivityAt < AUTO_ACTIVITY_MS;
        const pressed = playing && downloading && ahead < AUTO_LOW_BUFFER_SECONDS && earlier && ahead <= earlier.ahead + 0.05;
        if (!pressed) { state.pressureSince = 0; return false; }
        if (!state.pressureSince) { state.pressureSince = at; return false; }
        if (at - state.pressureSince < AUTO_PRESSURE_MS) return false;
        state.pressureSince = 0;
        return stepUp("缓冲跟不上播放", false);
      },
      // A connection waited too long for its first byte while every slot was busy.
      slow() {
        return saturation() >= 0.6 ? stepUp("连接排队等太久", false) : false;
      },
      // The server refused the load: back one level, and nothing climbs past this one for
      // a while.
      pushback(status) {
        return stepDown(Math.max(0, state.level - 1), state.level, `服务器返回 ${status}`, AUTO_PUSHBACK_REST_MS, true);
      },
      // A new playback session: what the buffer did before means nothing now, and the start
      // runs with more threads. A session that begins while another one's start is still
      // running keeps the page's own level to come back to.
      newSession() {
        const at = now();
        state.aheadSamples.length = 0;
        state.pressureSince = 0;
        state.trial = null;
        state.buckets.length = 0;
        state.saturatedSpans.length = 0;
        if (state.saturated) state.saturatedSince = at;
        const base = state.startup ? state.startup.base : state.level;
        const target = startupLevel(at);
        if (target > state.level) setLevel(target, `开头先用 ${AUTO_LADDER[target]} 线程`, null);
        state.startup = state.level > base ? { base, until: at + AUTO_STARTUP_MAX_MS } : null;
      },
      status() {
        const at = now();
        return {
          threads: threads(), level: state.level, reason: state.reason, steps: state.steps, changedAt: state.changedAt,
          throughputBps: Math.round(throughput(at)), saturation: Math.round(saturation(at) * 100) / 100,
          buckets: state.buckets.length, activityAgeMs: Math.round(at - state.lastActivityAt),
          resting: [...state.resting.entries()].filter(([, rest]) => rest.until > at).map(([level, rest]) => ({ threads: AUTO_LADDER[level], hard: rest.hard, forMs: Math.round(rest.until - at) })),
          trial: state.trial ? { from: AUTO_LADDER[state.trial.from], level: AUTO_LADDER[state.trial.level], ageMs: Math.round(at - state.trial.at), baselineBps: Math.round(state.trial.baseline), stalled: state.trial.stalled } : null,
          startup: state.startup ? { base: AUTO_LADDER[state.startup.base], forMs: Math.round(state.startup.until - at) } : null
        };
      },
      reset() {
        state.level = 0; state.changedAt = 0; state.reason = "起步"; state.steps = 0; state.trial = null;
        state.resting.clear(); state.buckets.length = 0; state.lastActivityAt = -Infinity;
        state.saturated = false; state.saturatedSince = 0; state.saturatedSpans.length = 0;
        state.aheadSamples.length = 0; state.pressureSince = 0; state.startup = null;
      }
    });
  }
  const autoConcurrency = createAutoConcurrency();
  // Every downloader on the page follows the controller's count at once.
  const autoFollowers = new Set();
  autoConcurrency.subscribe(() => {
    for (const ref of autoFollowers) {
      const follow = ref.deref();
      if (follow) follow(); else autoFollowers.delete(ref);
    }
  });

  function createDownloader(options) {
    const nativeFetch = options.nativeFetch || root.fetch.bind(root);
    const getSettings = options.getSettings;
    const onTransfer = typeof options.onTransfer === "function" ? options.onTransfer : () => null;
    // getSettings returns a new object whenever something changes (the userscript's page
    // does), so the reference tells whether the previous normalization is still valid.
    let rawSettings = null;
    let normalizedSettings = null;
    let autoView = null;
    function config() {
      const raw = getSettings();
      if (raw !== rawSettings || !normalizedSettings) {
        rawSettings = raw;
        normalizedSettings = core.normalizeSettings(raw);
        autoView = null;
      }
      if (!normalizedSettings.autoConcurrency) return normalizedSettings;
      // In the automatic mode the thread count is the controller's, everything else the viewer's.
      const threads = autoConcurrency.threads();
      if (!autoView || autoView.concurrency !== threads) autoView = { ...normalizedSettings, concurrency: threads };
      return autoView;
    }
    const semaphore = new Semaphore(config().concurrency);
    const applySettings = () => semaphore.setLimit(config().concurrency);
    autoFollowers.add(new WeakRef(applySettings));
    semaphore.onChange = (active, limit, queued) => { if (config().autoConcurrency) autoConcurrency.demand(active, limit, queued); };

    // What one connection typically delivers here and how long a sub-chunk typically
    // takes. Sub-chunk sizing and the hedge delay follow these measurements.
    const meter = { connectionBps: 0, pieceMs: 0 };
    function recordMeter(bytes, elapsedMs) {
      if (bytes < SPEED_SAMPLE_MIN_BYTES || elapsedMs <= 0) return;
      const bps = bytes * 1000 / elapsedMs;
      meter.connectionBps = meter.connectionBps ? meter.connectionBps * 0.7 + bps * 0.3 : bps;
      meter.pieceMs = meter.pieceMs ? meter.pieceMs * 0.7 + elapsedMs * 0.3 : elapsedMs;
    }

    // A sub-chunk should keep its connection busy for a good part of a second, otherwise
    // request round trips dominate on high-latency routes. 64 KiB stays the floor while
    // the speed is still unknown, and a range still splits into at least one piece per
    // node: the total bandwidth only grows by spreading over hosts, and the hedges
    // against a stalling one need more than a single request to work with.
    function adaptiveMinChunk(settings, rangeLength, pieceLimit, hostCount = 4) {
      if (!meter.connectionBps) return settings.minChunkBytes;
      const target = Math.floor(meter.connectionBps * 0.6 / (64 * 1024)) * 64 * 1024;
      const spread = Math.ceil(rangeLength / Math.max(1, Math.min(Math.max(4, hostCount), pieceLimit)));
      return Math.max(settings.minChunkBytes, Math.min(1024 * 1024, target, spread));
    }

    // A second copy starts once a piece takes clearly longer than pieces have been
    // taking, instead of always waiting the full fixed delay.
    function hedgeDelayMs(settings) {
      return meter.pieceMs
        ? Math.max(250, Math.min(settings.hedgeDelayMs, Math.round(meter.pieceMs * 1.5)))
        : settings.hedgeDelayMs;
    }

    // Whether the second copy of a piece with a playback deadline should start now. Checked
    // every 50 ms once the first copy holds a connection (a copy of a request still queued
    // would only queue as well, and with its higher priority take the connection meant for
    // it). first: the first copy (when it started, bytes received, bytes asked for); the delay
    // counts from its start. copyBps: the measured speed of the copy's node, 0 when unknown.
    // - No data yet, or nothing new for a whole delay (stopped): copy.
    // - A deadline it meets with time to spare at its speed so far: no copy yet, the bandwidth
    //   goes to pieces needed sooner.
    // - The copy's node known to be clearly faster (HEDGE_FASTER times): copy.
    // - Slower than connections usually are, or no usual speed measured yet: copy.
    // - On pace: a copy on a node not known to be HEDGE_FASTER times faster only takes the
    //   next piece's connection and bandwidth; one on a node not measured yet is tried, as
    //   the chance of a faster one. A piece that will miss its deadline even so may spend one
    //   of the range's rescue slots on that node anyway: its measurement can be stale (a node
    //   that was slow a minute ago may have recovered), and waiting for the request to time
    //   out costs far more.
    function hedgeDue(first, delayMs, deadlineAt, copyBps, rescue) {
      const now = performance.now(), ran = now - first.startedAt;
      const got = first.recorder.bytes;
      if (got !== first.seenBytes) {
        first.seenBytes = got;
        first.seenAt = now;
      }
      if (ran < delayMs) return false;
      if (!got || now - first.seenAt >= delayMs) return true;
      const rate = got * 1000 / ran;
      if (now + Math.max(0, first.length - got) * 1000 / rate <= deadlineAt - HEDGE_SLACK_MS) return false;
      if (copyBps > rate * HEDGE_FASTER) return true;
      if (!(meter.connectionBps > 0) || rate < meter.connectionBps * HEDGE_PACE) return true;
      if (!(copyBps > 0)) return true;
      return now + Math.max(0, first.length - got) * 1000 / rate > deadlineAt
        && Boolean(rescue?.claimStale?.());
    }

    // When playback needs a range, as a clock time; Infinity when the caller did not say.
    // options.deadlineAt is that time, options.deadlineMs the time left; either can be a
    // function, read again at every check, so a new playback rate or position also moves the
    // deadline of pieces already on their way.
    function deadlineOf(options) {
      const read = (value, relative) => {
        const ms = Number(value);
        if (value == null || !Number.isFinite(ms)) return Infinity;
        return relative ? performance.now() + Math.max(0, ms) : ms;
      };
      const live = (value, relative) => () => {
        try { return read(value(), relative); } catch (_error) { return Infinity; }
      };
      if (typeof options.deadlineAt === "function") return live(options.deadlineAt, false);
      if (options.deadlineAt != null && Number.isFinite(Number(options.deadlineAt))) {
        const fixed = Number(options.deadlineAt);
        return () => fixed;
      }
      if (typeof options.deadlineMs === "function") return live(options.deadlineMs, true);
      const fixed = read(options.deadlineMs, true);
      return () => fixed;
    }

    // Only measured per-request progress can spend this bounded rescue budget. The second
    // budget is for pieces that will miss their deadline while their copy's node is not
    // measured as HEDGE_FASTER times faster: that measurement can be stale, and a bounded
    // number of such copies per range is far cheaper than waiting for a timeout.
    function createEarlyHedge(limit) {
      return {
        progressRemaining: Math.max(0, limit),
        claimProgress() {
          if (this.progressRemaining <= 0) return false;
          this.progressRemaining -= 1;
          return true;
        },
        // At least one per range, even where no connection is held back (a single-piece
        // download): one request is much cheaper than waiting out a timeout.
        staleRemaining: Math.max(1, limit),
        claimStale() {
          if (this.staleRemaining <= 0) return false;
          this.staleRemaining -= 1;
          return true;
        }
      };
    }

    async function readBody(response, controller, transferId, settings, received, report = onTransfer) {
      if (!response.body?.getReader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        received.bytes += bytes.byteLength;
        received.chunks?.push(bytes);
        if (settings.autoConcurrency) autoConcurrency.activity();
        report({ phase: "progress", id: transferId, bytes: bytes.byteLength });
        return bytes;
      }
      const reader = response.body.getReader();
      // Do not rely on fetch implementations to unblock read() after abort. A
      // pending reader must release its concurrency slot before a quality change.
      const cancelReader = () => { reader.cancel(controller.signal.reason).catch(() => {}); };
      controller.signal.addEventListener("abort", cancelReader, { once: true });
      if (controller.signal.aborted) cancelReader();
      const chunks = [];
      let total = 0;
      let stallTimer = null;
      const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => controller.abort(new DOMException("CDN 子块停止传输", "TimeoutError")), settings.stallTimeoutMs);
      };
      armStall();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw abortError(controller.signal.reason);
          if (done) break;
          armStall();
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          chunks.push(chunk);
          total += chunk.byteLength;
          received.bytes += chunk.byteLength;
          // The recorder keeps what a failed attempt already received, so a retry or a
          // hedge copy can ask only for the missing tail.
          received.chunks?.push(chunk);
          if (settings.autoConcurrency) autoConcurrency.activity();
          report({ phase: "progress", id: transferId, bytes: chunk.byteLength });
        }
      } finally {
        clearTimeout(stallTimer);
        controller.signal.removeEventListener("abort", cancelReader);
        reader.releaseLock?.();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }

    // begin: called once the request has its connection slot, and returns what to ask for.
    // A copy that waited in the queue resumes from what the first copy has received by then,
    // not from what it had when the copy was queued.
    async function attempt(piece, url, signal, kind, resolver, priority = 0, begin = null,
      deadline = null, observeProgress = null, queueClass = QUEUE_CRITICAL) {
      const settings = config();
      const deadlineAt = deadline ? deadline() : Infinity;
      const release = await semaphore.acquire(signal, priority, deadlineAt, queueClass,
        queueClass === QUEUE_ORDINARY && Number.isFinite(deadlineAt), deadline);
      let received = { bytes: 0, chunks: [] };
      if (begin) {
        try {
          const plan = begin();
          piece = plan.part;
          received = plan.recorder;
        } catch (error) {
          release();
          throw error;
        }
      }
      const controller = new AbortController();
      const cancel = () => controller.abort(abortError(signal?.reason));
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      const firstByteTimer = setTimeout(() => controller.abort(new DOMException("CDN 首字节超时", "TimeoutError")), settings.firstByteTimeoutMs);
      const totalTimer = setTimeout(() => controller.abort(new DOMException("CDN 子块总耗时超限", "TimeoutError")), settings.attemptTimeoutMs);
      const startedAt = performance.now();
      const report = event => {
        const elapsedMs = Math.max(1, performance.now() - startedAt);
        const bps = received.bytes * 1000 / elapsedMs;
        const remaining = Math.max(0, piece.length - received.bytes);
        const payload = { ...event, receivedBytes: received.bytes, totalBytes: piece.length,
          bps, etaMs: bps > 0 ? Math.round(remaining * 1000 / bps) : null };
        observeProgress?.({ ...payload, elapsedMs });
        return onTransfer(payload);
      };
      const transferId = report({ phase: "start", kind, totalBytes: piece.length, url,
        deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : null });
      try {
        const response = await nativeFetch(url, {
          method: "GET",
          headers: { Range: `bytes=${piece.start}-${piece.end}` },
          credentials: "omit",
          cache: "no-store",
          mode: "cors",
          referrer: root.location?.href,
          referrerPolicy: "strict-origin-when-cross-origin",
          priority: priority >= 100 ? "high" : "auto",
          signal: controller.signal
        });
        clearTimeout(firstByteTimer);
        const contentRange = core.parseContentRange(response.headers.get("content-range"));
        if (response.status !== 206 || !contentRange || contentRange.start !== piece.start || contentRange.end !== piece.end) {
          // The status tells a refused signed address (4xx) apart from a node that is down.
          throw Object.assign(new Error(`Range 校验失败：HTTP ${response.status}`), { status: response.status });
        }
        const bytes = await readBody(response, controller, transferId, settings, received, report);
        if (bytes.byteLength !== piece.length) throw new Error(`子块长度不符：${bytes.byteLength}/${piece.length}`);
        const elapsedMs = Math.max(1, performance.now() - startedAt);
        recordMeter(bytes.byteLength, elapsedMs);
        // The node answered either way; only a large enough transfer says how fast it is.
        resolver.success(url, bytes.byteLength >= SPEED_SAMPLE_MIN_BYTES ? bytes.byteLength * 1000 / elapsedMs : 0);
        report({ phase: "done", id: transferId });
        return { bytes, total: contentRange.total, url };
      } catch (error) {
        const canceled = error?.name === "AbortError";
        // A copy that lost the race was cut off, not broken, and what it had received by then
        // is a measurement of its node. Without it a slow node is never measured at all: its
        // pieces are always finished by a faster copy first, and an unmeasured node only ever
        // gets trial pieces.
        if (canceled && received.bytes >= SPEED_SAMPLE_MIN_BYTES && typeof resolver.sample === "function") {
          resolver.sample(url, received.bytes * 1000 / Math.max(1, performance.now() - startedAt));
        }
        // Received bytes tell a dead node (0 KiB) apart from a transfer that stalled midway.
        resolver.failure(url, error, received.bytes);
        if (settings.autoConcurrency) {
          if (error?.status === 412 || error?.status === 429) autoConcurrency.pushback(error.status);
          else if (!canceled && error?.name === "TimeoutError" && received.bytes === 0) autoConcurrency.slow();
        }
        report({ phase: canceled ? "cancel" : "error", id: transferId, error });
        throw error;
      } finally {
        clearTimeout(firstByteTimer);
        clearTimeout(totalTimer);
        // Invalid headers can reject before readBody obtains a reader. Stop that
        // response too, otherwise it keeps downloading after releasing the slot.
        controller.abort();
        signal?.removeEventListener("abort", cancel);
        release();
      }
    }

    function pause(delayMs, signal) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(done, delayMs);
        function done() {
          signal?.removeEventListener("abort", canceled);
          resolve();
        }
        function canceled() {
          clearTimeout(timer);
          reject(abortError(signal.reason));
        }
        if (signal?.aborted) canceled();
        else signal?.addEventListener("abort", canceled, { once: true });
      });
    }

    function pieceCandidates(piece, resolver, preferredUrls, round) {
      const preferred = Array.isArray(preferredUrls) ? preferredUrls : [];
      // The first preferred address is the node this piece was assigned to by speed;
      // only a retry round moves past it.
      const preferredOffset = preferred.length ? round % preferred.length : 0;
      const rotatedPreferred = preferred.slice(preferredOffset).concat(preferred.slice(0, preferredOffset));
      const rescue = (typeof resolver.rescueCandidates === "function" ? resolver.rescueCandidates() : resolver.ordered(piece.index))
        .filter((url) => !rotatedPreferred.includes(url));
      if (typeof resolver.speed === "function") {
        // The copies after the first go to the fastest known nodes, wherever they were
        // listed: a hedge that lands on the slowest node saves nothing.
        const rest = [...rotatedPreferred.slice(1), ...rescue]
          .sort((left, right) => resolver.speed(right) - resolver.speed(left));
        const candidates = rotatedPreferred.length ? [rotatedPreferred[0], ...rest] : rest;
        for (const url of resolver.ordered(piece.index)) {
          if (!candidates.includes(url)) candidates.push(url);
        }
        return candidates;
      }
      const candidates = [];
      const width = Math.max(rotatedPreferred.length, rescue.length);
      for (let index = 0; index < width; index += 1) {
        if (rotatedPreferred[index]) candidates.push(rotatedPreferred[index]);
        if (rescue[index]) candidates.push(rescue[index]);
      }
      for (const url of resolver.ordered(piece.index)) {
        if (!candidates.includes(url)) candidates.push(url);
      }
      return candidates;
    }

    async function downloadPiece(piece, resolver, signal, kind, preferredUrls, startupMode = false, priority = 0,
      deadline = null, earlyHedge = null) {
      const hasDeadline = Boolean(deadline) && Number.isFinite(deadline());
      const deadlineNow = () => (deadline ? deadline() : Infinity);
      const settings = config();
      const allowed = (url) => typeof resolver.allows !== "function" || resolver.allows(url);
      const startup = startupMode === true || startupMode === "probe";
      const probe = startupMode === "probe";
      const startedAt = performance.now();
      let lastError = null;

      // The longest contiguous run of bytes fetched from the front of this piece so far.
      // A retry or a hedge copy asks only for what is still missing and splices the two
      // halves, instead of downloading the whole piece again. Every kept byte came out
      // of a response whose 206 Content-Range was verified against this piece.
      let prefix = null;
      const keepProgress = (base, recorder) => {
        const bytes = (base?.bytes || 0) + recorder.bytes;
        if (bytes > (prefix?.bytes || 0) && bytes < piece.length) {
          prefix = { bytes, chunks: base ? [...base.chunks, ...recorder.chunks] : recorder.chunks.slice() };
        }
      };
      const liveProgress = (context) => {
        if (!context) return null;
        const chunks = context.recorder.chunks.slice();
        let bytes = context.base?.bytes || 0;
        for (const chunk of chunks) bytes += chunk.byteLength;
        return { bytes, chunks: context.base ? [...context.base.chunks, ...chunks] : chunks };
      };

      // Failing a piece ends acceleration for the whole video, and the list can be as short as
      // one working address. One slow reply must not decide that, so the list is walked again
      // after a pause; node health and bans have changed by then, so it is rebuilt each time.
      for (let round = 0; round < PIECE_ROUNDS; round += 1) {
        if (round) {
          if (performance.now() - startedAt > PIECE_RETRY_WINDOW_MS) break;
          await pause(roundPause(round), signal);
        }
        const candidates = pieceCandidates(piece, resolver, preferredUrls, round);
        const limit = Math.min(8, candidates.length);
        const batchWidth = probe ? limit : 2;
        const tried = new Set();
        while (tried.size < limit) {
          if (signal?.aborted) throw abortError(signal.reason);
          // A node banned while this piece was waiting is skipped, unless only banned nodes are left.
          const untried = candidates.filter((url) => !tried.has(url));
          const open = untried.filter(allowed);
          const pair = (open.length ? open : untried).slice(0, batchWidth);
          if (!pair.length) break;
          pair.forEach((url) => tried.add(url));
          const controllers = pair.map(() => new AbortController());
          const cancelAll = () => controllers.forEach((controller) => controller.abort(abortError(signal?.reason)));
          if (signal?.aborted) cancelAll();
          else signal?.addEventListener("abort", cancelAll, { once: true });
          // A first copy that is refused at once (HTTP 403) should not leave the piece idle
          // for the rest of the hedge delay.
          let firstFailed = () => {};
          const firstFailure = new Promise((resolve) => { firstFailed = resolve; });
          let firstStartedAt = 0, deadlineDeficitSamples = 0, firstBecameStraggler = () => {};
          const firstStraggler = new Promise((resolve) => { firstBecameStraggler = resolve; });
          const observeFirst = event => {
            if (!hasDeadline || event.phase !== "progress" || !Number.isFinite(event.etaMs)) return;
            const deadlineAt = deadlineNow();
            const missesDeadline = Number.isFinite(deadlineAt)
              && event.etaMs >= Math.max(0, deadlineAt - performance.now());
            const slowerThanPeers = meter.connectionBps > 0 && event.bps < meter.connectionBps * 0.5
              && event.etaMs >= 500;
            const remainingToDeadline = deadlineAt - performance.now();
            deadlineDeficitSamples = Number.isFinite(deadlineAt)
              && event.etaMs - remainingToDeadline >= 250
              ? deadlineDeficitSamples + 1
              : 0;
            // A clearly slow node is rescued immediately. If the whole route is slow,
            // two consecutive deficit samples may spend the same per-range rescue budget
            // (createEarlyHedge).
            if (Number.isFinite(deadlineAt)
              && ((missesDeadline && slowerThanPeers) || deadlineDeficitSamples >= 2)) {
              firstBecameStraggler();
            }
          };
          const contexts = [];
          const attempts = pair.map((url, pairIndex) => (async () => {
            if (pairIndex) await new Promise((resolve, reject) => {
              let timer = null, settled = false, earlyClaimed = false;
              const finish = (operation) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                controllers[pairIndex].signal.removeEventListener("abort", canceled);
                operation();
              };
              const measured = hedgeDelayMs(settings);
              const delay = probe ? 0 : startup
                ? Math.min(hasDeadline ? 200 : 250, measured)
                : measured;
              const copyBps = () => (typeof resolver.speed === "function" ? resolver.speed(url) || 0 : 0);
              // A playback-deadline request decides once its first copy has a connection (see
              // hedgeDue); one without a deadline (compatibility mode, the desktop client)
              // keeps the fixed hedge delay (hedgeDelayMs), counted from the moment the piece
              // asked, queue time included.
              const check = () => {
                if (settled) return;
                if (contexts[0] && hedgeDue(contexts[0], delay, deadlineNow(), copyBps(), earlyHedge)) return finish(resolve);
                timer = setTimeout(check, 50);
              };
              if (hasDeadline && !probe) timer = setTimeout(check, 0);
              else timer = setTimeout(() => finish(resolve), delay);
              firstStraggler.then(() => {
                if (settled || probe || earlyClaimed || !earlyHedge?.claimProgress?.()) return;
                earlyClaimed = true;
                if (timer) clearTimeout(timer);
                const grace = Math.max(0, 250 - (performance.now() - firstStartedAt));
                timer = setTimeout(() => finish(resolve), grace);
              });
              firstFailure.then(() => finish(resolve));
              const canceled = () => {
                finish(() => reject(abortError(controllers[pairIndex].signal.reason)));
              };
              if (controllers[pairIndex].signal.aborted) canceled();
              else controllers[pairIndex].signal.addEventListener("abort", canceled, { once: true });
            });
            // Resume from the longest prefix known when the request really starts: an earlier
            // failed attempt, or what the still-running first copy has received by then.
            let base = null;
            const recorder = { bytes: 0, chunks: [] };
            const begin = () => {
              if (!pairIndex) firstStartedAt = performance.now();
              base = prefix && prefix.bytes >= RESUME_MIN_BYTES ? prefix : null;
              if (pairIndex) {
                const live = liveProgress(contexts[0]);
                if (live && live.bytes >= RESUME_MIN_BYTES && live.bytes > (base?.bytes || 0)) base = live;
              }
              if (base && base.bytes >= piece.length) base = null;
              const startedAt = performance.now();
              contexts[pairIndex] = { base, recorder, startedAt, seenBytes: 0, seenAt: startedAt, length: piece.length - (base?.bytes || 0) };
              return {
                recorder,
                part: base
                  ? { index: piece.index, start: piece.start + base.bytes, end: piece.end, length: piece.length - base.bytes }
                  : piece
              };
            };
            try {
              const result = await attempt(piece, url, controllers[pairIndex].signal, kind, resolver,
                priority + (pairIndex ? 20 : 0), begin, deadline, pairIndex ? null : observeFirst,
                probe ? QUEUE_CRITICAL : startup ? QUEUE_STARTUP : QUEUE_ORDINARY);
              return base
                ? { bytes: core.concatChunks([...base.chunks, result.bytes], piece.length), total: result.total, url: result.url }
                : result;
            } catch (error) {
              keepProgress(base, recorder);
              if (!pairIndex) firstFailed();
              throw error;
            }
          })());
          try {
            const winner = await Promise.any(attempts);
            controllers.forEach((controller) => {
              if (!controller.signal.aborted) controller.abort(new DOMException("并发副本已取消", "AbortError"));
            });
            if (settings.autoConcurrency) autoConcurrency.delivered(piece.length);
            return winner;
          } catch (aggregate) {
            lastError = aggregate?.errors?.at?.(-1) || aggregate;
            if (signal?.aborted) throw abortError(signal.reason);
          } finally {
            signal?.removeEventListener("abort", cancelAll);
          }
        }
      }
      throw lastError || new Error("没有可用 CDN");
    }

    async function delayedAttempt(piece, url, delayMs, signal, kind, resolver, controller, priority = 0) {
      if (delayMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          const canceled = () => {
            clearTimeout(timer);
            reject(abortError(controller.signal.reason));
          };
          if (controller.signal.aborted) canceled();
          else controller.signal.addEventListener("abort", canceled, { once: true });
        });
      }
      if (signal?.aborted) throw abortError(signal.reason);
      return attempt(piece, url, controller.signal, kind, resolver, priority);
    }

    async function startupAttempt(piece, candidates, resolver, options) {
      const controllers = candidates.map(() => new AbortController());
      const cancelAll = () => controllers.forEach((controller) => {
        if (!controller.signal.aborted) controller.abort(abortError(options.signal?.reason));
      });
      if (options.signal?.aborted) cancelAll();
      else options.signal?.addEventListener("abort", cancelAll, { once: true });
      try {
        let winner;
        try {
          winner = await Promise.any(candidates.map((url, index) => delayedAttempt(
            piece,
            url,
            index === 0 ? 0 : index === 1 ? 120 : 300,
            options.signal,
            options.kind || "meta",
            resolver,
            controllers[index],
            220
          )));
        } catch (aggregate) {
          if (options.signal?.aborted) throw abortError(options.signal.reason);
          throw aggregate?.errors?.at?.(-1) || aggregate;
        }
        controllers.forEach((controller) => {
          if (!controller.signal.aborted) controller.abort(new DOMException("并发副本已取消", "AbortError"));
        });
        return winner;
      } finally {
        options.signal?.removeEventListener("abort", cancelAll);
      }
    }

    // Which address each piece tries first. The fastest node gets the most pieces, and a node
    // measured at under a twelfth of the best is left out entirely: a piece it starts has to
    // be rescued anyway. Its measurement goes stale after a while, and the resolver's
    // exploration slot then gives it, like any untested node, another try.
    let assignTurn = 0;
    // Trials are counted per resolver: the video and the audio track take turns on this
    // downloader, and one shared count could leave a track without a trial for good.
    const trialStates = new WeakMap();
    function assignPrimaries(urls, resolver, count) {
      if (!urls.length || count <= 0) return [];
      if (urls.length === 1) return new Array(count).fill(urls[0]);
      // Each range opens one node further on, so ranges in flight together do not all
      // send their first pieces to the same node.
      const turn = assignTurn;
      assignTurn = (assignTurn + 1) % 4096;
      const measure = typeof resolver.speed === "function" ? (url) => Math.max(0, Number(resolver.speed(url)) || 0) : () => 0;
      let known = urls.map(measure);
      const positive = known.filter((value) => value > 0);
      if (!positive.length) return Array.from({ length: count }, (_ignored, index) => urls[(index + turn) % urls.length]);
      const top = Math.max(...known);
      const eligible = urls.filter((_url, index) => !known[index] || known[index] >= top / 12);
      if (eligible.length && eligible.length < urls.length) {
        urls = eligible;
        known = urls.map(measure);
      }
      // A node without a measurement is a trial. It gets a piece or two from the end of the
      // range, which are needed last and may take longest, enough to measure it and cheap
      // when it turns out to be slow. With very few pieces there is none to spare.
      const unknown = urls.filter((_url, index) => !known[index]);
      let trials = Math.min(unknown.length * 2, Math.floor(count / 4));
      let trialState = trialStates.get(resolver);
      if (!trialState) trialStates.set(resolver, trialState = { waited: 0, cursor: 0 });
      // Small segments never have a piece to spare, and a node left out for being slow would
      // stay unmeasured for good. Every fourth such range gives up its last piece for a trial.
      if (!trials && unknown.length && count >= 2) {
        trialState.waited += 1;
        if (trialState.waited >= 4) trials = 1;
      }
      if (trials) trialState.waited = 0;
      if (unknown.length) {
        urls = urls.filter((_url, index) => known[index]);
        known = urls.map(measure);
        count -= trials;
      }
      const weights = known.map((value) => Math.max(value, top * 0.05));
      const total = weights.reduce((sum, value) => sum + value, 0);
      // Handed out in turns (smooth weighted round-robin), not in one block per node. The
      // pieces with the lowest numbers get the free connections first, and the player has
      // several segments in flight: with blocks, every segment's first pieces went to the
      // same node and the others sat idle.
      const primaries = [];
      const credit = weights.map(() => 0);
      const order = urls.map((_url, index) => (index + turn) % urls.length);
      for (let index = 0; index < count; index += 1) {
        let best = order[0];
        for (const urlIndex of order) {
          credit[urlIndex] += weights[urlIndex];
          if (credit[urlIndex] > credit[best]) best = urlIndex;
        }
        credit[best] -= total;
        primaries.push(urls[best]);
      }
      for (let index = 0; index < trials; index += 1) primaries.push(unknown[(index + trialState.cursor) % unknown.length]);
      trialState.cursor = (trialState.cursor + trials) % 4096;
      return primaries;
    }

    function preferredFor(primary, urls) {
      return primary ? [primary, ...urls.filter((url) => url !== primary)] : urls;
    }

    // Hands the finished pieces to onOrderedChunk in order: each one as soon as every piece
    // before it has been handed over. done() waits for what has been handed over so far.
    function orderedDelivery(pieces, onOrderedChunk) {
      const ordered = new Array(pieces.length);
      let next = 0;
      let operation = Promise.resolve();
      return {
        add(index, result) {
          ordered[index] = result;
          operation = operation.then(async () => {
            while (ordered[next]) {
              const item = ordered[next];
              ordered[next] = null;
              await onOrderedChunk(item.bytes, pieces[next], item.total);
              next += 1;
            }
          });
          return operation;
        },
        done: () => operation
      };
    }

    async function downloadStartupRange(range, resolver, options) {
      semaphore.setLimit(config().concurrency);
      const piece = { index: 0, start: range.start, end: range.end, length: range.length };
      const startedAt = performance.now();
      let lastError = null;
      // The addresses that just failed are backing off by the next round, so each round
      // moves on to the next three.
      for (let round = 0; round < PIECE_ROUNDS; round += 1) {
        if (round) {
          if (performance.now() - startedAt > PIECE_RETRY_WINDOW_MS) break;
          await pause(roundPause(round), options.signal);
        }
        let candidates = (typeof resolver.startupCandidates === "function" ? resolver.startupCandidates() : resolver.urls())
          .filter((url, index, all) => all.indexOf(url) === index)
          .slice(0, 3);
        if (!candidates.length && round) candidates = resolver.ordered(round).slice(0, 3);
        if (!candidates.length) break;
        try {
          const winner = await startupAttempt(piece, candidates, resolver, options);
          return {
            bytes: winner.bytes,
            pieceCount: 1,
            total: winner.total || null,
            hosts: [new URL(winner.url).hostname]
          };
        } catch (error) {
          if (options.signal?.aborted) throw abortError(options.signal.reason);
          lastError = error;
        }
      }
      throw lastError || new Error("没有可用 CDN");
    }

    async function downloadStartupMediaRange(range, resolver, options, settings) {
      const effectiveConcurrency = settings.concurrency;
      semaphore.setLimit(effectiveConcurrency);
      const candidateUrls = (typeof resolver.rangeCandidates === "function" ? resolver.rangeCandidates() : resolver.urls())
        .filter((url, index, all) => all.indexOf(url) === index);
      const headLength = Math.min(range.length, Math.max(64 * 1024, settings.minChunkBytes));
      const head = {
        index: 0,
        start: range.start,
        end: range.start + headLength - 1,
        length: headLength
      };
      const headResult = await downloadPiece(
        head,
        resolver,
        options.signal,
        options.kind || "media",
        candidateUrls,
        "probe",
        220,
        options.deadline
      );
      await options.onOrderedChunk(headResult.bytes, head, headResult.total);
      if (head.end >= range.end) {
        options.onStartupScheduled?.();
        return {
          bytes: null,
          byteLength: range.length,
          pieceCount: 1,
          streamed: true,
          total: headResult.total || null,
          hosts: [new URL(headResult.url).hostname]
        };
      }

      const rescueReserve = Math.max(1, Math.min(16, Math.ceil(effectiveConcurrency / 8)));
      const mediaBudget = Math.max(1, effectiveConcurrency - rescueReserve);
      const audioBudget = Math.max(1, Math.min(mediaBudget, Math.ceil(effectiveConcurrency / 8)));
      const pieceBudget = options.kind === "audio"
        ? audioBudget
        : Math.max(1, mediaBudget - audioBudget);
      const pieces = core.splitRange(
        head.end + 1,
        range.end,
        pieceBudget,
        adaptiveMinChunk(settings, range.end - head.end, pieceBudget, candidateUrls.length)
      ).map((piece, index) => ({ ...piece, index: index + 1 }));
      const delivery = orderedDelivery(pieces, options.onOrderedChunk);
      // The probe measured at least its own winner, so the pieces spread over the nodes by
      // speed at once; the proven address is among each piece's fallbacks, which
      // pieceCandidates orders by measured speed. Only the probe's winner and nodes with a
      // speed measurement carry the first segment: a node whose probe never finished would
      // otherwise get a share of it and hold up the start. The others stay available for
      // rescue, and later ranges try them.
      const measured = typeof resolver.speed === "function" ? (url) => resolver.speed(url) > 0 : () => false;
      const provenUrls = candidateUrls.filter((url) => url === headResult.url || measured(url));
      const primaries = assignPrimaries(provenUrls.length ? provenUrls : [headResult.url], resolver, pieces.length);
      const earlyHedge = createEarlyHedge(rescueReserve);
      const pendingPieces = pieces.map(async (piece, orderedIndex) => {
        const result = await downloadPiece(
          piece,
          resolver,
          options.signal,
          options.kind || "media",
          preferredFor(primaries[orderedIndex], [headResult.url, ...candidateUrls.filter((url) => url !== headResult.url)]),
          true,
          120 - Math.min(30, piece.index),
          options.deadline,
          earlyHedge
        );
        await delivery.add(orderedIndex, result);
        return result;
      });
      options.onStartupScheduled?.();
      const results = await Promise.all(pendingPieces);
      await delivery.done();
      const totals = [headResult, ...results].map((item) => item.total).filter(Number.isSafeInteger);
      if (totals.length && totals.some((value) => value !== totals[0])) throw new Error("不同 CDN 返回的文件总长度不一致");
      return {
        bytes: null,
        byteLength: range.length,
        pieceCount: pieces.length + 1,
        streamed: true,
        total: totals[0] || null,
        hosts: [...new Set([headResult, ...results].map((item) => new URL(item.url).hostname))]
      };
    }

    async function downloadRange(range, resolver, options = {}) {
      const settings = config();
      if (options.kind === "meta") return downloadStartupRange(range, resolver, options);
      // One deadline for the whole range, resolved at its boundary: every piece, including work
      // scheduled after the startup probe, refers to the same playback instant.
      const deadline = deadlineOf(options);
      const parallel = options.parallel !== false;
      if (options.startup === true && parallel && typeof options.onOrderedChunk === "function") {
        return downloadStartupMediaRange(range, resolver, { ...options, deadline }, settings);
      }
      const preferredUrls = parallel && typeof resolver.rangeCandidates === "function"
        ? resolver.rangeCandidates()
        : resolver.urls();
      const globalConcurrency = parallel ? settings.concurrency : 1;
      const requestedConcurrency = Number.isFinite(Number(options.maxConcurrency))
        ? Math.max(1, Math.trunc(Number(options.maxConcurrency)))
        : globalConcurrency;
      const effectiveConcurrency = parallel ? Math.min(globalConcurrency, requestedConcurrency) : 1;
      // Fewer primary pieces than slots is not a hard-reserved connection: it gives a
      // stalled piece's hedge/retry room to start immediately while the other primaries run.
      semaphore.setLimit(globalConcurrency);
      const basePriority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : 50;
      const rescueReserve = parallel && effectiveConcurrency >= 8
        ? Math.min(8, Math.max(1, Math.ceil(effectiveConcurrency / 8)))
        : 0;
      const pieceConcurrency = options.startup === true
        ? Math.max(1, Math.min(22, effectiveConcurrency))
        : Math.max(1, effectiveConcurrency - rescueReserve);
      const pieces = core.splitRange(
        range.start,
        range.end,
        pieceConcurrency,
        parallel ? adaptiveMinChunk(settings, range.length, pieceConcurrency, preferredUrls.length) : Number.MAX_SAFE_INTEGER
      );
      const primaries = parallel ? assignPrimaries(preferredUrls, resolver, pieces.length) : [];
      const earlyHedge = createEarlyHedge(rescueReserve);
      const progressive = typeof options.onOrderedChunk === "function";
      const delivery = orderedDelivery(pieces, options.onOrderedChunk);
      const results = await Promise.all(pieces.map(async (piece) => {
        const result = await downloadPiece(
          piece,
          resolver,
          options.signal,
          options.kind || "media",
          preferredFor(primaries[piece.index], preferredUrls),
          options.startup === true,
          basePriority - Math.min(20, piece.index),
          deadline,
          earlyHedge
        );
        if (progressive) await delivery.add(piece.index, result);
        return result;
      }));
      if (progressive) await delivery.done();
      const totals = results.map((item) => item.total).filter(Number.isSafeInteger);
      if (totals.length && totals.some((value) => value !== totals[0])) throw new Error("不同 CDN 返回的文件总长度不一致");
      return {
        bytes: progressive ? null : core.concatChunks(results.map((item) => item.bytes), range.length),
        byteLength: range.length,
        pieceCount: pieces.length,
        streamed: progressive,
        total: totals[0] || null,
        hosts: [...new Set(results.map((item) => new URL(item.url).hostname))]
      };
    }

    return Object.freeze({ downloadRange, applySettings, getConcurrency: () => semaphore.limit });
  }

  root.__BILI_IDM_DOWNLOADER_FACTORY__ = Object.freeze({ createDownloader, createAutoConcurrency, autoConcurrency });
})(globalThis);


/* shared/native-range-transport.js */
(function installNativeRangeTransport(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  if (root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__) return;
  const resolvers = root.__BILI_CDN_RESOLVER_FACTORY__;
  const downloaders = root.__BILI_IDM_DOWNLOADER_FACTORY__;
  if (!core || !resolvers || !downloaders || !root.fetch || !root.XMLHttpRequest) return;
  const nativeFetch = root.fetch.bind(root);
  // The compatibility mode ("兼容模式" in the settings): Bilibili's own player keeps the
  // decoder, the buffer and the quality switching, and only its media requests are
  // downloaded here. Safari needs it, because replacing the MediaSource breaks its quality
  // switching. Nothing is intercepted until a player of this mode is created.
  let active = null;
  let passthroughFetch = nativeFetch;

  function nativeCore(video) {
    const wrapper = root.player?.__core?.(), dash = wrapper?.getCorePlayer?.();
    if (!dash || dash.getVideoElement?.() !== video) return null;
    if (![video.requestVideoFrameCallback, wrapper.fire, wrapper.getQualityChangedData,
      dash.on, dash.off, dash.getQualityFor].every(method => typeof method === "function")) {
      throw new Error("原生播放器接口不兼容");
    }
    return dash;
  }

  function nativeSwitchPending() {
    try {
      const quality = root.player?.getQuality?.();
      const current = Number(quality?.nowQ), target = Number(quality?.newQ);
      return Number.isFinite(current) && Number.isFinite(target) && current > 0 && target > 0 && current !== target;
    } catch (_error) { return false; }
  }

  // A completed VOD scheduler stays stopped when Bilibili changes quality.
  // Reopen scheduling during that request; native rules still choose every
  // fragment. Never restart a running scheduler: start() clears its append lock.
  function attachQualityGuard(dash, video, note, unavailable) {
    const records = new Map();
    let disposed = false;
    const fail = error => {
      release();
      note("native quality guard unavailable", String(error?.message || error));
      unavailable(error);
    };
    const protect = fn => (...args) => {
      if (disposed) return;
      try { return fn(...args); }
      catch (error) { fail(error); }
    };
    const clear = record => {
      record.pending = null;
      clearTimeout(record.timer);
      if (record.frame) video.cancelVideoFrameCallback?.(record.frame);
      record.frame = 0;
    };
    const restore = record => {
      clear(record);
      if (record.buffer.getIsBufferingCompleted === record.wrapped) record.buffer.getIsBufferingCompleted = record.original;
    };
    function oldFuture(record) {
      const model = record.processor.getFragmentModel?.(), target = dash.getQualityFor(record.processor.getType());
      const history = model?.getRequests?.({ state: "executed", type: "MediaSegment" }) || [];
      return history.some(request => request && request.quality !== target && request.startTime > video.currentTime
        && model.getRequests({ state: "executed", time: request.startTime + request.duration / 2, threshold: 0 })?.[0] === request);
    }
    function finishSource() {
      const source = [...records.values()][0]?.buffer.getMediaSource?.();
      if (disposed || source?.readyState !== "open" || source.sourceBuffers.length !== records.size) return;
      if ([...records.values()].every(record => record.buffer.getMediaSource?.() === source
        && record.buffer.getIsBufferingCompleted() && !record.processor.getFragmentModel?.()?.getLoadingRequests?.().length)
        && [...source.sourceBuffers].every(buffer => !buffer.updating)) source.endOfStream();
    }
    function resumeFuture(record) {
      if (disposed || dash.getFastSwitchEnabled?.() === false) return;
      const processor = record.processor, scheduler = processor.getScheduleController();
      if (scheduler.isStarted()) return;
      const target = dash.getQualityFor(processor.getType());
      const duration = processor.getRepresentationInfoForQuality?.(target)?.fragmentDuration || 5;
      const offsets = dash.getFastSwitchQnV2Enabled?.() ? [1, 1.5] : [1.5];
      const due = offsets.some(offset => {
        const request = processor.getFragmentModel?.()?.getRequests?.({ state: "executed", time: video.currentTime + duration * offset, threshold: 0 })?.[0];
        return request?.type === "MediaSegment" && request.quality !== target;
      });
      if (due) { scheduler.start(); note("native future replacement resumed", processor.getType()); }
    }
    function observe(event) {
      const buffer = event.sender, processor = buffer?.getStreamProcessor?.(), type = processor?.getType?.();
      if (type !== "video" && type !== "audio") return;
      if (typeof buffer.getIsBufferingCompleted !== "function" || typeof processor.getScheduleController !== "function") {
        throw new Error("原生缓冲接口不兼容");
      }
      const scheduler = processor.getScheduleController();
      if (typeof scheduler?.isStarted !== "function" || typeof scheduler.start !== "function") throw new Error("原生调度接口不兼容");
      const previous = records.get(type);
      if (previous?.processor === processor) {
        queueMicrotask(protect(() => { if (records.get(type) === previous) { resumeFuture(previous); finishSource(); } }));
        return;
      }
      if (previous) restore(previous);
      const record = { buffer, processor, original: buffer.getIsBufferingCompleted, pending: null, frame: 0 };
      // A successful switch only confirms the current segment. Keep native
      // replacement scheduling alive while later buffered segments are old.
      record.wrapped = function () {
        const completed = record.original.call(this);
        if (!completed) return false;
        try { return !record.pending && !oldFuture(record); }
        catch (error) { fail(error); return completed; }
      };
      buffer.getIsBufferingCompleted = record.wrapped;
      records.set(type, record);
    }
    function requested(event) {
      const record = records.get(event.mediaType);
      if (!record || !Number.isInteger(event.newQuality)) return;
      clear(record);
      record.pending = event;
      // Only a cleanup bound: Bilibili keeps its original switch timeout.
      record.timer = setTimeout(() => clear(record), 21000);
      const processor = record.processor;
      queueMicrotask(protect(() => {
        if (record.pending !== event) return;
        const scheduler = processor.getScheduleController();
        if (!scheduler.isStarted()) { scheduler.start(); note("native stopped scheduler resumed", event.mediaType); }
      }));

      // After seeking back into an old rendition, the requested quality can
      // already be displayed. Native rendering notifications require a change
      // from the previous frame and otherwise never resolve this request.
      const wrapper = root.player?.__core?.();
      if (event.mediaType !== "video" || !video.requestVideoFrameCallback || typeof wrapper?.fire !== "function"
        || typeof wrapper.getQualityChangedData !== "function") return;
      const at = time => processor.getFragmentModel?.()?.getRequests?.({ state: "executed", time, threshold: 0 })
        ?.find(request => request?.type === "MediaSegment");
      const target = processor.getMediaInfo?.()?.bitrateList?.[event.newQuality];
      if (!target) return;
      let frames = 0, switching = null;
      const confirm = (_now, metadata) => {
        record.frame = 0;
        if (disposed || record.pending !== event || wrapper.getCorePlayer() !== dash) return;
        const current = wrapper.qnSwitchingInfo?.video, request = at(metadata.mediaTime);
        if (!current?.switching || current.qn !== event.newQuality || typeof current.listener !== "function"
          || (switching && switching !== current)) return;
        switching = current;
        // Native history may be absent immediately after a seek. Observe until
        // matching frames arrive; an index/init response alone is never success.
        frames = request?.quality === event.newQuality && video.videoWidth === target.width
          && video.videoHeight === target.height ? frames + 1 : 0;
        if (frames < 2) { record.frame = video.requestVideoFrameCallback(protect(confirm)); return; }
        const rendered = { type: "qualityChangeRendered", mediaType: "video", oldQuality: event.oldQuality, newQuality: event.newQuality,
          index: request.index, requestType: request.type, isMediaSegment: true };
        wrapper.fire("qualityChangeRendered", wrapper.getQualityChangedData(rendered));
        current.listener(rendered);
        clear(record);
        note("native already-rendered quality confirmed", `${target.width}x${target.height} / 2 decoded frames`);
      };
      record.frame = video.requestVideoFrameCallback(protect(confirm));
    }
    function rendered(event) {
      const record = records.get(event.mediaType);
      if (record?.pending?.newQuality === event.newQuality) clear(record);
    }
    const handlers = { bufferLevelUpdated: protect(observe), qualityChangeRequested: protect(requested), qualityChangeRendered: protect(rendered) };
    try {
      for (const [name, handler] of Object.entries(handlers)) dash.on(name, handler);
    } catch (error) {
      release();
      throw error;
    }
    function release() {
      if (disposed) return;
      disposed = true;
      for (const [name, handler] of Object.entries(handlers)) {
        try { dash.off(name, handler); } catch (_error) { /* Still restore buffers if the native core changed. */ }
      }
      for (const record of records.values()) {
        try { restore(record); } catch (_error) { /* Continue cleaning other processors. */ }
      }
      records.clear();
    }
    return release;
  }

  // Only bounded, ordinary media GETs are replaced. Authentication, conditional
  // requests, open-ended ranges, sync XHR and unknown files retain native behavior.
  function planRequest(url, method, headers, credentials) {
    const owner = active;
    if (!owner || owner.disposed || !owner.settings().enabled || method !== "GET"
      || credentials === "include" || !core.isBilibiliMediaUrl(url)) return null;
    if ([...headers.keys()].some(name => !["range", "accept"].includes(name))) return null;
    const range = core.parseRangeHeader(headers.get("range"));
    if (!range || !Number.isSafeInteger(range.length)) return null;
    const track = owner.track(url);
    if (!track || !owner.sampleQuality()) return null;
    if (nativeSwitchPending()) owner.nativeSwitchRequest();
    return { owner, url, range, track };
  }

  // Both loaders use one downloader, with the existing CDN policy, retries,
  // thread budget and transfer statistics. FetchLoader can swallow reader errors:
  // finish and validate the range before resolving fetch, so failure rejects the
  // request instead of becoming an invisible error in a partially delivered body.
  async function download(plan, signal, progress = () => {}) {
    const { owner, range, track } = plan;
    if (signal?.aborted) throw signal.reason;
    if (owner.disposed) throw new DOMException("加速任务已停止", "AbortError");
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    owner.jobs.add(controller);
    track.jobs?.add(controller);
    let received = 0, total = null;
    const chunks = [];
    // Only a start gets the startup treatment (racing the head on every node, copying each
    // piece early): the first media of a track, a seek, a retry. The segment that follows
    // the last one delivered is an ordinary download; treating every request as a start
    // cost a third to half of each segment's time and a fifth of the traffic.
    const following = Boolean(track.warmEnd) && range.start === track.warmEnd;
    try {
      const result = await owner.downloader.downloadRange(range, owner.resolver(plan.url, track), {
        signal: controller.signal, parallel: true, startup: !following, kind: track.kind,
        onOrderedChunk(bytes, piece, fileTotal) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (piece.start !== range.start + received || bytes.byteLength !== piece.length
            || !Number.isSafeInteger(fileTotal) || fileTotal <= range.end
            || (total !== null && total !== fileTotal)) throw new Error("媒体 Range 校验失败");
          total = fileTotal;
          chunks.push(bytes);
          received += bytes.byteLength;
          progress(received, total);
        }
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (received !== range.length || result.total !== total) throw new Error("媒体 Range 长度不符");
      const bytes = core.concatChunks(chunks, received);
      // The init segment and the index are small and come first; media follows them.
      if (track.warmEnd || range.length > 64 * 1024) track.warmEnd = range.end + 1;
      owner.delivered(track, result);
      return { bytes, headers: new Headers({
        "Content-Type": track.representation.mimeType || track.representation.mime_type || `${track.kind}/mp4`,
        "Content-Length": String(range.length), "Content-Range": `bytes ${range.start}-${range.end}/${total}`,
        "Accept-Ranges": "bytes"
      }) };
    } catch (error) {
      track.warmEnd = 0;
      if (!controller.signal.aborted && !owner.disposed) owner.failed(error, track);
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      controller.abort();
      signal?.removeEventListener("abort", cancel);
      owner.jobs.delete(controller);
      track.jobs?.delete(controller);
    }
  }

  function responseURL(response, url) {
    const clone = response.clone.bind(response);
    Object.defineProperties(response, {
      url: { value: url },
      clone: { value: () => responseURL(clone(), url) }
    });
    return response;
  }

  function interceptedFetch(input, init) {
    const url = input instanceof Request ? input.url : String(input);
    const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!active || method !== "GET" || !core.isBilibiliMediaUrl(url)) return passthroughFetch(input, init);
    let request;
    try { request = new Request(input instanceof Request ? input : new URL(String(input), root.location.href), init); }
    catch (_error) { return passthroughFetch(input, init); }
    const plan = request.mode === "no-cors" || request.integrity ? null
      : planRequest(request.url, request.method, request.headers, request.credentials);
    if (!plan) return passthroughFetch(input, init);
    return download(plan, request.signal).then(({ bytes, headers }) => {
      if (request.signal.aborted) throw request.signal.reason;
      return responseURL(new Response(bytes, { status: 206, statusText: "Partial Content", headers }), request.url);
    });
  }

  // Preserve the actual XMLHttpRequest object, event handlers and prototype. Only
  // eligible arraybuffer requests receive a synthetic response. Calling open()
  // again restores all native response accessors before the object is reused.
  const proto = root.XMLHttpRequest.prototype;
  // Taken when the interception is installed, so anything already wrapping fetch or
  // XMLHttpRequest (the playurl reader of page-hook.js) stays in the chain.
  let nativeOpen, nativeSend, nativeAbort, nativeSetHeader, nativeGetHeader, nativeGetHeaders;
  const requests = new WeakMap();
  const fields = ["readyState", "status", "statusText", "response", "responseText", "responseURL"];
  function emit(xhr, type, progress) {
    xhr.dispatchEvent(progress ? new ProgressEvent(type, progress) : new Event(type));
  }
  function restore(xhr, entry) {
    if (!entry?.synthetic) return;
    for (const key of fields) {
      const descriptor = entry.descriptors[key];
      if (descriptor) Object.defineProperty(xhr, key, descriptor);
      else delete xhr[key];
    }
    entry.synthetic = false;
  }
  function isCurrent(xhr, entry) { return requests.get(xhr) === entry && entry.sending; }
  function finish(xhr, entry, type) {
    if (!isCurrent(xhr, entry)) return;
    clearTimeout(entry.timer);
    entry.sending = false;
    entry.state = 4;
    emit(xhr, "readystatechange");
    if (requests.get(xhr) !== entry || entry.state !== 4) return;
    const progress = { lengthComputable: type === "load", loaded: entry.body?.byteLength || 0, total: entry.body?.byteLength || 0 };
    emit(xhr, type, progress);
    if (requests.get(xhr) === entry) emit(xhr, "loadend", progress);
  }
  const patchedOpen = function (method, url, async = true, ...rest) {
    const previous = requests.get(this);
    requests.delete(this);
    if (previous) {
      previous.sending = false;
      clearTimeout(previous.timer);
      previous.controller?.abort();
      restore(this, previous);
    }
    const result = nativeOpen.call(this, method, url, async, ...rest);
    requests.set(this, { method: String(method).toUpperCase(), url: new URL(String(url), root.location.href).href,
      async: async !== false, headers: new Headers(), authenticated: rest.some(value => value != null), sending: false, synthetic: false });
    return result;
  };
  const patchedSetRequestHeader = function (name, value) {
    const entry = requests.get(this);
    if (entry?.synthetic) throw new DOMException("Call open() before sending again", "InvalidStateError");
    const result = nativeSetHeader.call(this, name, value);
    entry?.headers.append(name, value);
    return result;
  };
  const patchedGetResponseHeader = function (name) {
    const entry = requests.get(this);
    return entry?.synthetic ? (entry.state >= 2 ? entry.responseHeaders.get(name) : null) : nativeGetHeader.call(this, name);
  };
  const patchedGetAllResponseHeaders = function () {
    const entry = requests.get(this);
    return entry?.synthetic ? (entry.state >= 2 ? [...entry.responseHeaders].map(([key, value]) => `${key}: ${value}\r\n`).join("") : "") : nativeGetHeaders.call(this);
  };
  const patchedAbort = function () {
    const entry = requests.get(this);
    if (!entry?.synthetic) return nativeAbort.call(this);
    entry.status = 0; entry.statusText = ""; entry.responseUrl = ""; entry.body = null; entry.responseHeaders = new Headers();
    if (entry.sending) {
      entry.controller.abort();
      finish(this, entry, "abort");
    }
    if (requests.get(this) === entry && !entry.sending) entry.state = 0;
  };
  const patchedSend = function (body) {
    const entry = requests.get(this);
    if (entry?.synthetic) throw new DOMException("Call open() before sending again", "InvalidStateError");
    if (this.readyState !== 1) return nativeSend.call(this, body);
    const plan = entry?.async && !entry.authenticated && body == null && this.responseType === "arraybuffer"
      ? planRequest(entry.url, entry.method, entry.headers, this.withCredentials ? "include" : "same-origin") : null;
    if (!plan) return nativeSend.call(this, body);
    entry.sending = true; entry.synthetic = true; entry.state = 1;
    entry.status = 0; entry.statusText = ""; entry.body = null; entry.responseUrl = "";
    entry.responseHeaders = new Headers(); entry.controller = new AbortController();
    entry.descriptors = Object.fromEntries(fields.map(key => [key, Object.getOwnPropertyDescriptor(this, key)]));
    Object.defineProperties(this, {
      readyState: { configurable: true, get: () => entry.state },
      status: { configurable: true, get: () => entry.status },
      statusText: { configurable: true, get: () => entry.statusText },
      response: { configurable: true, get: () => entry.state === 4 ? entry.body : null },
      responseText: { configurable: true, get() { throw new DOMException("arraybuffer response", "InvalidStateError"); } },
      responseURL: { configurable: true, get: () => entry.responseUrl }
    });
    if (this.timeout > 0) entry.timer = setTimeout(() => {
      if (!isCurrent(this, entry)) return;
      entry.controller.abort();
      entry.status = 0; entry.statusText = ""; entry.responseUrl = ""; entry.responseHeaders = new Headers();
      finish(this, entry, "timeout");
    }, this.timeout);
    emit(this, "loadstart", { lengthComputable: false, loaded: 0, total: 0 });
    if (!isCurrent(this, entry)) return;
    entry.loaded = 0;
    const reportProgress = (received, total) => {
      if (!isCurrent(this, entry)) return;
      if (entry.state === 1) {
        entry.status = 206; entry.statusText = "Partial Content"; entry.responseUrl = entry.url;
        entry.responseHeaders = new Headers({ "content-range": `bytes ${plan.range.start}-${plan.range.end}/${total}`, "content-length": String(plan.range.length), "content-type": plan.track.representation.mimeType || plan.track.representation.mime_type || `${plan.track.kind}/mp4` });
        entry.state = 2; emit(this, "readystatechange");
      }
      if (!isCurrent(this, entry) || received <= entry.loaded) return;
      entry.loaded = received;
      entry.state = 3; emit(this, "readystatechange");
      if (isCurrent(this, entry)) emit(this, "progress", { lengthComputable: true, loaded: received, total: plan.range.length });
    };
    download(plan, entry.controller.signal, reportProgress).then(result => {
      if (!isCurrent(this, entry)) return;
      entry.responseHeaders = result.headers; entry.responseUrl = entry.url;
      entry.body = result.bytes.buffer;
      finish(this, entry, "load");
    }).catch(() => {
      if (!isCurrent(this, entry)) return;
      entry.status = 0; entry.statusText = ""; entry.responseUrl = ""; entry.body = null; entry.responseHeaders = new Headers();
      finish(this, entry, "error");
    });
  };

  // Only a player of this mode installs the interception, and what is in place then keeps
  // working under it. The other mode never sees any of this.
  let intercepting = false;
  function installInterception() {
    if (intercepting) return;
    intercepting = true;
    passthroughFetch = root.fetch.bind(root);
    nativeOpen = proto.open;
    nativeSend = proto.send;
    nativeAbort = proto.abort;
    nativeSetHeader = proto.setRequestHeader;
    nativeGetHeader = proto.getResponseHeader;
    nativeGetHeaders = proto.getAllResponseHeaders;
    root.fetch = interceptedFetch;
    proto.open = patchedOpen;
    proto.setRequestHeader = patchedSetRequestHeader;
    proto.getResponseHeader = patchedGetResponseHeader;
    proto.getAllResponseHeaders = patchedGetAllResponseHeaders;
    proto.abort = patchedAbort;
    proto.send = patchedSend;
  }

  function createNativePlayer(options) {
    const video = options.container.querySelector("video");
    if (!video) throw new Error("没有找到 B 站原生 video 元素");
    installInterception();
    if (active) active.destroy();
    let tracks = [], lastVideo = null, lastAudio = null;
    let delivered = 0, failures = 0, nativeSwitchRequests = 0;
    let qualityState = "", guardedDash = null, releaseGuard = null;
    let coreWaitStarted = null, coreWaitTimer = null;
    const cache = new Map(), jobs = new Set(), timeline = [];
    let lastError = "";
    const settings = () => core.normalizeSettings(options.getSettings());
    // In English for the diagnostic copy; an error goes in as the message it was thrown with.
    const note = (what, detail = "") => {
      timeline.push({ at: Math.round(performance.now()), time: Math.round((Number(video.currentTime) || 0) * 10) / 10, what, detail: String(detail) });
      if (timeline.length > 120) timeline.shift();
    };
    const update = playinfo => {
      const dash = playinfo?.data?.dash || playinfo?.result?.dash || playinfo?.dash;
      if (!dash) return;
      const audio = [...(dash.audio || []), ...[].concat(dash.dolby?.audio || [], dash.flac?.audio || [])];
      tracks = (dash.video || []).map(representation => ({ kind: "video", representation }))
        .concat(audio.map(representation => ({ kind: "audio", representation })));
      // Retain healthy-node history across same-video playurl updates.
    };
    update(options.playinfo);
    const urls = representation => [representation.baseUrl || representation.base_url, ...[].concat(representation.backupUrl || representation.backup_url || [])].filter(Boolean);
    const pathOf = url => { try { return new URL(url).pathname; } catch (_error) { return ""; } };
    // A file of this video that the playinfo BTR holds does not list (#71). Another script
    // can hand Bilibili's player a playinfo of its own, with a quality or an address BTR
    // never saw; BTR reads Bilibili's answers before such a script changes them. The
    // request is still the player's own and goes to a Bilibili video server, so it is sped
    // up like the others, from its own address: the servers of the list are asked for the
    // same file. It used to be left alone, and with it the whole video track, while the
    // audio next to it was sped up.
    //
    // Only files of the video being played: a file is named after the video's cid, and the
    // files BTR knows give that away. A preview or an advertisement elsewhere on the page
    // is not this player's business. A file the other servers refuse is left to Bilibili
    // from then on.
    const outside = new Map();
    // Their refusals are counted apart from the ban list of the listed files: an address
    // another script brought along must not get a server banned for the rest of the video.
    const outsideBans = resolvers.createBanList();
    // After this many refusals (HTTP 4xx) the file is left to Bilibili at once: the
    // downloader would otherwise try every server for every piece, three rounds each.
    const OUTSIDE_REFUSALS = 3;
    const watched = new Map();
    let transferIds = 0;
    function watchTransfer(event) {
      if (event?.phase === "start") {
        const id = options.onTransfer ? options.onTransfer(event) : ++transferIds;
        const track = outside.get(pathOf(event.url));
        if (track) watched.set(id, track);
        return id;
      }
      const track = watched.get(event?.id);
      if (track && event.phase !== "progress") {
        watched.delete(event.id);
        const status = Number(event.error?.status) || 0;
        if (event.phase === "error" && status >= 400 && status < 500 && !track.refused && ++track.refusals >= OUTSIDE_REFUSALS) {
          track.refused = true;
          note("file outside the playinfo left to Bilibili", `HTTP ${status} from the other servers`);
          for (const controller of track.jobs) controller.abort(new Error("其他服务器没有这个文件"));
        }
      }
      return options.onTransfer ? options.onTransfer(event) : event?.id;
    }
    const cidOf = url => /\/(\d+)[^/]*-\d+-\d+\.m4s$/.exec(pathOf(url))?.[1] || "";
    function outsideTrack(url) {
      const path = pathOf(url), cid = cidOf(url);
      if (!cid || !tracks.some(track => urls(track.representation).some(candidate => cidOf(candidate) === cid))) return null;
      let track = outside.get(path);
      if (!track) {
        if (outside.size >= 16) outside.delete(outside.keys().next().value);
        // Bilibili numbers its audio files 30216, 30232, 30280 (AAC), 30250 (Dolby) and 30251 (Hi-Res).
        const id = Number(/-(\d+)\.m4s$/.exec(path)?.[1]) || 0;
        track = { kind: [30216, 30232, 30280, 30250, 30251].includes(id) ? "audio" : "video", representation: { id: 0, baseUrl: url, base_url: url },
          outside: true, refused: false, refusals: 0, failures: 0, jobs: new Set() };
        outside.set(path, track);
        note("file outside the playinfo", `${track.kind} ${path.slice(path.lastIndexOf("/") + 1)}`);
      }
      return track.refused ? null : track;
    }
    function unavailable(error) {
      if (owner.disposed) return;
      owner.destroy();
      lastError = `原生播放器接口发生变化，已停止加速：${error?.message || error}`;
      note("native quality guard unavailable", `acceleration stopped: ${error?.message || error}`);
      options.onState?.({ playerState: "native-fallback", lastError });
    }
    function sampleQuality() {
      if (owner.disposed || !settings().enabled) return false;
      try {
        const dash = nativeCore(video);
        if (dash !== guardedDash) {
          releaseGuard?.(); releaseGuard = null; guardedDash = null;
        }
        if (!dash) {
          // Codec/source changes can briefly remove the native core. Suspend
          // interception during that gap; never accelerate without the guard.
          if (coreWaitStarted === null) {
            coreWaitStarted = performance.now();
            for (const controller of jobs) controller.abort();
            note("native core transition: acceleration suspended");
          }
          if (performance.now() - coreWaitStarted >= 3000) throw new Error("原生内核未恢复");
          coreWaitTimer ??= setTimeout(() => { coreWaitTimer = null; sampleQuality(); }, 100);
          return false;
        }
        clearTimeout(coreWaitTimer); coreWaitTimer = null; coreWaitStarted = null;
        if (!releaseGuard) {
          releaseGuard = attachQualityGuard(dash, video, note, unavailable);
          guardedDash = dash;
        }
        const quality = root.player?.getQuality?.();
        const value = `${quality?.nowQ}/${quality?.newQ}/${quality?.realQ}`;
        if (value !== qualityState) { qualityState = value; note("native quality now/target/rendered", value); }
        return true;
      } catch (error) { unavailable(error); return false; }
    }
    const publish = () => {
      if (owner.disposed) return;
      sampleQuality();
      if (owner.disposed) return;
      const playing = tracks.find(track => track.kind === "video" && Number(track.representation.id) === Number(qualityState.split("/")[0]))?.representation;
      options.onState?.({ playerState: video.error ? "error" : video.ended ? "ended" : video.readyState >= 3 ? "ready" : "buffering",
        lastError: video.error ? video.error.message || `media error ${video.error.code}` : lastError,
        // "native" when Bilibili's player has not said which it plays.
        mode: settings().mode, quality: playing ? root.__BILI_NATIVE_MSE_PLAYER_FACTORY__?.qualityLabel?.(playing) || String(playing.id) : "native",
        bufferedAhead: bufferedAhead(), cdnHosts: [...cache.values()].flatMap(resolver => resolver.status()) });
    };
    function bufferedAhead() {
      const time = Number(video.currentTime) || 0;
      for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= time && video.buffered.end(i) > time) return video.buffered.end(i) - time;
      return 0;
    }
    const owner = {
      disposed: false, jobs, settings, sampleQuality,
      track: url => tracks.find(track => urls(track.representation).some(candidate => pathOf(candidate) === pathOf(url))) || outsideTrack(url),
      resolver(url, track) {
        const parsed = new URL(url), key = parsed.pathname + parsed.search;
        if (!cache.has(key)) {
          if (cache.size >= 64) cache.delete(cache.keys().next().value);
          cache.set(key, resolvers.createResolver({ ...track.representation, baseUrl: url, base_url: url }, () => settings().mode,
            track.outside ? outsideBans : options.cdnBans, () => settings().customHosts));
        }
        return cache.get(key);
      },
      delivered(track, result) {
        if (owner.disposed) return;
        if (track.kind === "video") lastVideo = track.representation;
        else lastAudio = track.representation;
        if (track.outside) track.failures = 0;
        lastError = "";
        delivered++;
        note("native range delivered", `${track.kind} ${result.byteLength} bytes / ${result.pieceCount} pieces`);
        options.onSegment?.({ kind: track.kind, bytes: result.byteLength, pieces: result.pieceCount, hosts: result.hosts });
        publish();
      },
      nativeSwitchRequest() {
        nativeSwitchRequests++;
        note("quality switch: accelerated request");
      },
      failed(error, track) {
        // One failure can be the network's, and Bilibili's player asks again. Two in a row:
        // from now on it gets this file from where it asked.
        if (track?.outside && !track.refused && ++track.failures >= 2) {
          track.refused = true;
          note("file outside the playinfo left to Bilibili", String(error?.message || error));
        }
        failures++;
        lastError = String(error?.message || error);
        note("native range failed", lastError);
        publish();
        // Reject the original loader request; Bilibili owns playback recovery.
      },
      destroy() {
        if (owner.disposed) return;
        owner.disposed = true;
        clearTimeout(coreWaitTimer); coreWaitTimer = null;
        releaseGuard?.(); releaseGuard = null; guardedDash = null;
        for (const controller of jobs) controller.abort();
        events.abort();
        if (active === owner) active = null;
        // The native media source, buffers, playback position and pause state are untouched.
      }
    };
    owner.downloader = downloaders.createDownloader({ getSettings: settings, nativeFetch, onTransfer: watchTransfer });
    const events = new AbortController();
    for (const name of ["playing", "waiting", "stalled", "seeking", "seeked", "ended", "loadedmetadata", "error", "progress", "timeupdate"]) video.addEventListener(name, () => {
      if (name !== "timeupdate" && name !== "progress") note(`media ${name}`, `buffer ${bufferedAhead().toFixed(2)}s`);
      if (name === "playing") lastError = "";
      if (name === "timeupdate") sampleQuality();
      else publish();
    }, { signal: events.signal });
    active = owner;
    note("native transport attached");
    queueMicrotask(publish);
    return Object.freeze({
      nativeTransport: true, video,
      get transportActive() { return !owner.disposed && settings().enabled && !!releaseGuard && coreWaitStarted === null; },
      applySettings() {
        if (owner.disposed) return;
        if (!settings().enabled) { owner.destroy(); return; }
        owner.downloader.applySettings(); sampleQuality();
      },
      async updatePlayinfo(playinfo) { update(playinfo); },
      destroy: owner.destroy,
      getDebug: () => ({ architecture: "native-player-range-transport", transportRevision: 6, qualityGuardRevision: 11, nativeQualityGuard: !!guardedDash,
        qualityId: Number(qualityState.split("/")[0]) || 0, downloadedQualityId: Number(lastVideo?.id) || 0,
        width: video.videoWidth, height: video.videoHeight, currentTime: Number(video.currentTime) || 0,
        videoType: lastVideo?.mimeType || lastVideo?.mime_type || "", audioType: lastAudio?.mimeType || lastAudio?.mime_type || "",
        videoBandwidth: Number(lastVideo?.bandwidth) || 0, audioBandwidth: Number(lastAudio?.bandwidth) || 0,
        codec: lastVideo?.codecs || "", frameRate: (() => {
          const [n, d = 1] = String(lastVideo?.frameRate || lastVideo?.frame_rate || 0).split("/").map(Number);
          return d ? n / d : 0;
        })(),
        acceleratedRanges: delivered, failedRanges: failures, nativeSwitchRequests, filesOutsidePlayinfo: outside.size,
        nativeQuality: qualityState, nativeSwitchPending: nativeSwitchPending(), activeRequests: jobs.size,
        mediaSourceReplacements: 0, timeline: timeline.slice() })
    });
  }
  root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__ = Object.freeze({
    createNativePlayer,
    supports(container) {
      try {
        const video = container?.querySelector("video");
        return !!video && !!nativeCore(video);
      } catch (_error) { return false; }
    }
  });
})(globalThis);


/* shared/runtime-notices.js */
(function installRuntimeNotices(root) {
  "use strict";

  const EVENT_NAMES = ["playing", "pause", "waiting", "stalled", "seeking", "seeked", "ended", "error", "emptied", "loadedmetadata", "canplay", "ratechange"];
  let settings = {};
  let attachment = null;
  let controller = null;
  let heartbeat = null;
  let lastTime = 0;
  let lastProgress = -Infinity;
  let lastReportedPlaying = null;
  // The element's own events, in English, for the diagnostic copy (diagnostic-report.js).
  // Capped so a stuttering stream cannot crowd out everything else; a repeat of the same
  // event within a second only counts up.
  const media = [];
  const MEDIA_LIMIT = 150;
  function remember(name, detail = "") {
    const at = Math.round(performance.now());
    const last = media.at(-1);
    if (last && last.name === name && last.detail === detail && at - last.at < 1000) {
      last.count = (last.count || 1) + 1;
      return;
    }
    media.push({ at, name, time: Math.round((Number(attachment?.video?.currentTime) || 0) * 10) / 10, detail });
    if (media.length > MEDIA_LIMIT) media.shift();
  }

  function current() {
    return attachment && attachment.video?.isConnected && attachment.isCurrent();
  }

  function sample() {
    if (!settings.enabled) return;
    const video = attachment?.video;
    const valid = Boolean(current());
    const now = performance.now();
    const time = Number(video?.currentTime) || 0;
    if (valid && !video.paused && !video.seeking && !video.ended && time > lastTime + 0.001) lastProgress = now;
    lastTime = time;
    const playing = valid && !video.paused && !video.ended && !video.seeking && !video.error && video.readyState >= 2 && now - lastProgress < 1800;
    if (playing !== lastReportedPlaying) {
      // The first sample after attaching only says where the watch started.
      if (valid && lastReportedPlaying !== null) remember("progress", playing ? "advancing" : "not advancing");
      lastReportedPlaying = playing;
    }
  }

  function stopWatch() {
    controller?.abort();
    controller = null;
    clearInterval(heartbeat);
    heartbeat = null;
    lastReportedPlaying = null;
    lastProgress = -Infinity;
  }

  function watch() {
    stopWatch();
    if (!settings.enabled || !attachment) return;
    const captured = attachment;
    const video = captured.video;
    controller = new AbortController();
    lastTime = Number(video.currentTime) || 0;
    for (const name of EVENT_NAMES) {
      video.addEventListener(name, () => {
        if (attachment !== captured || !current()) return;
        if (name === "playing") lastProgress = performance.now();
        else if (["pause", "waiting", "stalled", "seeking", "ended", "error", "emptied"].includes(name)) {
          lastProgress = -Infinity;
          lastTime = Number(video.currentTime) || 0;
        }
        remember(name, name === "error" ? `code ${video.error?.code || 0}${video.error?.message ? `: ${video.error.message}` : ""}`
          : name === "ratechange" ? `${Math.round((Number(video.playbackRate) || 0) * 100) / 100}x` : "");
        sample();
      }, { signal: controller.signal });
    }
    video.addEventListener("timeupdate", () => sample(), { signal: controller.signal });
    // A stalled picture fires no timeupdate, so only this heartbeat records "not advancing".
    heartbeat = setInterval(sample, 500);
    sample();
  }

  root.__BTR_RUNTIME_NOTICES__ = Object.freeze({
    history: () => media.map((entry) => ({ ...entry })),
    configure(next) {
      const changed = settings.enabled !== (next.enabled !== false);
      settings = { enabled: next.enabled !== false };
      if (changed) watch();
    },
    // Callers, the desktop app included, pass a route and a session; neither is used here.
    attach(video, _route, _session, isCurrent) {
      attachment = { video, isCurrent };
      watch();
    },
    detach(_reason) {
      stopWatch();
      attachment = null;
    }
  });
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


/* src/settings.js */
(function (root) {
  "use strict";
  if (root.__BTR_DESKTOP__) return;
  const KEY = "BTR_Desktop.settings.v1";
  const listeners = new Set();
  // 0.9.1.2 moves everyone once to mainland CDN and 8 threads.
  const REVISION = 2, UPGRADE = { mode: "mainland", concurrency: 8 };
  const normalize = value => {
    const s = root.__BILI_RANGE_CORE__.normalizeSettings(value || {});
    // mode "custom" uses only the servers in customHosts; the shared core keeps Bilibili's
    // video servers and drops anything else.
    // 自动线程数 is on unless switched off, as in the browser version; concurrency is then only
    // the manual choice, used again when it is switched off.
    // The client only has the browser version's compatibility mode (src/page-hook.js).
    return { enabled: s.enabled, takeover: "compat", liveEnabled: s.liveEnabled, autoConcurrency: value?.autoConcurrency !== false, concurrency: s.concurrency, mode: s.mode, customHosts: s.customHosts, autoCheckUpdates: value?.autoCheckUpdates !== false, revision: REVISION };
  };
  let current;
  // macOS: the main process injects the live player code only while 直播加速（实验性） is on, so
  // it is told the switch when a client page starts and whenever it changes.
  const tellLive = () => root.postMessage({ channel: "__BTR_DESKTOP_UPDATE__", type: "live-config", enabled: current.liveEnabled === true }, root.location.origin);
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    const outdated = !!saved && saved.revision !== REVISION;
    current = normalize(outdated ? { ...saved, ...UPGRADE } : saved);
    if (outdated) localStorage.setItem(KEY, JSON.stringify(current));
  } catch (_) { current = normalize({}); }
  const emit = () => listeners.forEach(fn => { try { fn({ ...current, customHosts: current.customHosts.slice() }); } catch (error) { console.error("BTR settings listener", error); } });
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("BTR_Desktop.settings.v1") : null;
  const api = {
    version: root.__BTR_DESKTOP_RELEASE__?.version || "2026.11.10.1-d1",
    adapterRevision: root.__BTR_DESKTOP_RELEASE__?.adapterRevision || 1,
    getSettings: () => ({ ...current, customHosts: current.customHosts.slice() }),
    setSettings(patch) {
      const next = normalize({ ...current, ...patch });
      localStorage.setItem(KEY, JSON.stringify(next)); // Failure must not pretend to save.
      const liveChanged = next.liveEnabled !== current.liveEnabled;
      current = next; emit(); channel?.postMessage(current);
      if (liveChanged) tellLive();
      return api.getSettings();
    },
    resetSettings() {
      const next = normalize({});
      localStorage.setItem(KEY, JSON.stringify(next)); // Failure must not pretend to save.
      current = next; emit(); channel?.postMessage(current);
      tellLive();
      return api.getSettings();
    },
    onSettings(fn) { listeners.add(fn); fn(api.getSettings()); return () => listeners.delete(fn); },
    update: Object.freeze({ state: "idle", message: "从 GitHub 检查 BTR 更新" })
  };
  root.addEventListener("storage", event => {
    if (event.key !== KEY) return;
    try { current = normalize(JSON.parse(event.newValue || "{}")); emit(); } catch (_) {}
  });
  if (channel) channel.onmessage = event => { current = normalize(event.data); emit(); };
  Object.defineProperty(root, "__BTR_DESKTOP__", { value: api });
  tellLive();
})(globalThis);


/* src/page-hook.js */
(function (root) {
  "use strict";
  // The browser version's page-hook.js, for the client. It finds the client's player and puts
  // the browser version's compatibility mode on it: shared/native-range-transport.js, as it
  // is. The client goes on playing the video and BTR downloads it. Where that mode cannot
  // reach the player, the client downloads the video by itself, as Bilibili's own page does
  // in the browser. biliPlayer is what the browser version calls window.player, so this file
  // gives the shared code what page-hook.js gives it there.
  const api = root.__BTR_DESKTOP__, factory = root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__;
  if (!api || !factory || api.getStatus) return;
  const notices = root.__BTR_RUNTIME_NOTICES__;
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const ARCHITECTURE = "native-player-range-transport";
  // The client plays videos in its player window only.
  const inPlayer = location.origin !== "https://bilipc.bilibili.com" || location.pathname === "/player.html";
  if (inPlayer && root.player === undefined) Object.defineProperty(root, "player", {
    configurable: true, get: () => root.biliPlayer,
    set(value) { Object.defineProperty(root, "player", { configurable: true, enumerable: true, writable: true, value }); }
  });

  let settings = api.getSettings();
  let player = null, route = "", playinfo = null;
  // The compatibility mode on the player, the video element and the video it holds.
  let transport = null, transportVideo = null, transportRoute = "", refusedRoute = "", lifecycle = 0;
  const attached = new WeakSet();

  // What happened on this page, in English for the diagnostic copy (diagnostic-report.js
  // lays it out), as in the browser version: each kind keeps its newest 30, a full list gives
  // up its oldest debug and info entries first, and a repeat within two seconds only counts up.
  const pageEvents = [];
  const PAGE_EVENT_LIMIT = 200, PAGE_EVENTS_PER_KIND = 30;
  const currentVideo = () => { try { return transport?.video || root.biliPlayer?.mediaElement?.() || null; } catch (_) { return null; } };
  function remember(what, detail = "", level = "info") {
    const at = Math.round(performance.now());
    detail = withoutQuery(detail).slice(0, 200);
    const last = pageEvents.at(-1);
    if (last && last.what === what && last.detail === detail && at - last.at < 2000) { last.count = (last.count || 1) + 1; return; }
    pageEvents.push({ at, time: Math.round((Number(currentVideo()?.currentTime) || 0) * 10) / 10, what, detail, level });
    const sameKind = pageEvents.filter(event => event.what === what);
    if (sameKind.length > PAGE_EVENTS_PER_KIND) pageEvents.splice(pageEvents.indexOf(sameKind[0]), 1);
    if (pageEvents.length > PAGE_EVENT_LIMIT) {
      const index = ["debug", "info"].map(minor => pageEvents.findIndex(event => event.level === minor)).find(found => found >= 0);
      pageEvents.splice(index ?? 0, 1);
    }
  }
  // An address keeps its host and path: its query holds the signature and the expiry.
  function withoutQuery(text) { return String(text ?? "").replace(/((?:https?:)?\/\/[^\s"'?#]+)[?#][^\s"']*/gi, "$1"); }
  function errorText(error) { return withoutQuery(error?.message || error?.name || error || "").slice(0, 180); }

  // A CDN node that twice sends nothing, and a download address the nodes keep refusing, is
  // skipped until the client moves to another video.
  let bans = [];
  const cdnBans = root.__BILI_CDN_RESOLVER_FACTORY__.createBanList({
    onBan(host, count, error, kind) {
      const address = kind === "address";
      bans.push({ at: Math.round(performance.now()), kind: address ? "address" : "node", host: String(host || ""), count: Number(count) || 0, error: errorText(error) });
      if (bans.length > 40) bans.shift();
      // The ban is decided while the failed range is still being reported.
      queueMicrotask(() => remember(address ? "address banned" : "node banned", address ? "refused by the nodes" : `${host}, ${Number(count) || 0} failures with no data`, "warn"));
    }
  });

  const stats = {
    version: api.version, architecture: ARCHITECTURE, mode: settings.mode, playerState: "waiting", quality: "", bufferedAhead: 0,
    acceleratedRequests: 0, acceleratedBytes: 0, parallelSubrequests: 0, activeThreads: 0, autoThreads: 0, totalSpeedBps: 0,
    threadSpeeds: [], discoveredCdns: 0, healthyCdns: 0, blockedCdns: 0, cdnHosts: [], lastHost: "", lastError: "", takeoverError: null
  };

  // Every download since the window opened: the threads at work for the panel's 运行状态, and
  // per kind and per node for the diagnostic copy.
  let transferSequence = 1;
  const transfers = new Map();
  const downloads = {
    byKind: Object.fromEntries(["video", "audio", "meta"].map(kind => [kind, { started: 0, ok: 0, failed: 0, cancelled: 0, bytes: 0 }])),
    cancelReasons: {}, hosts: {}, lastBytesAt: null
  };
  function downloadHost(host) {
    const key = host || "unknown";
    if (!downloads.hosts[key] && Object.keys(downloads.hosts).length >= 64) return null;
    downloads.hosts[key] ||= { ok: 0, failed: 0, cancelled: 0, bytes: 0, lastError: "", lastErrorAt: null };
    return downloads.hosts[key];
  }
  function countTransfer(item, event) {
    const now = Math.round(performance.now());
    if (event.phase === "progress") { if (Number(event.bytes) > 0) downloads.lastBytesAt = now; return; }
    const kind = downloads.byKind[item.kind] || downloads.byKind.video, host = downloadHost(item.host);
    if (event.phase === "done") {
      kind.ok += 1; kind.bytes += item.loaded;
      if (host) { host.ok += 1; host.bytes += item.loaded; }
    } else if (event.phase === "cancel") {
      kind.cancelled += 1;
      if (host) host.cancelled += 1;
      let reason = errorText(event.error) || "unknown";
      if (!(reason in downloads.cancelReasons) && Object.keys(downloads.cancelReasons).length >= 20) reason = "other";
      downloads.cancelReasons[reason] = (downloads.cancelReasons[reason] || 0) + 1;
    } else if (event.phase === "error") {
      kind.failed += 1;
      const message = errorText(event.error);
      if (host) { host.failed += 1; host.lastError = message; host.lastErrorAt = now; }
      remember("range failed", `${item.kind} ${item.host || "unknown"} after ${Math.round(item.loaded / 1024)} KiB: ${message}`, "warn");
    }
  }
  function onTransfer(event) {
    if (event?.phase === "start") {
      const id = transferSequence++, now = Date.now();
      let host = "";
      try { host = new URL(event.url).hostname; } catch (_) {}
      const kind = ["video", "audio", "meta"].includes(event.kind) ? event.kind : "video";
      downloads.byKind[kind].started += 1;
      transfers.set(id, { id, kind, host, loaded: 0, totalBytes: Math.max(0, Number(event.totalBytes) || 0), startedAt: now, sampleAt: now, sampleBytes: 0, lastByteAt: 0, bps: 0, finalBps: 0, state: "active", expiresAt: Infinity });
      stats.lastHost = host;
      return id;
    }
    const item = transfers.get(Number(event?.id));
    if (!item || item.state !== "active") return event?.id;
    const now = Date.now();
    countTransfer(item, event);
    if (event.phase === "progress") {
      const bytes = Math.max(0, Number(event.bytes) || 0);
      item.loaded += bytes; item.sampleBytes += bytes; item.lastByteAt = now;
      const elapsed = Math.max(1, now - item.sampleAt);
      if (elapsed >= 200) { item.bps = item.sampleBytes * 1000 / elapsed; item.sampleAt = now; item.sampleBytes = 0; }
      else item.bps = item.loaded * 1000 / Math.max(1, now - item.startedAt);
    } else if (event.phase === "cancel") {
      transfers.delete(item.id);
    } else {
      item.state = event.phase === "done" ? "done" : "error";
      item.finalBps = event.phase === "done" ? item.loaded * 1000 / Math.max(1, now - item.startedAt) : 0;
      item.expiresAt = now + 3500;
      // Finished threads stay listed a moment, then go, with or without the panel open.
      pruneTimer ||= setTimeout(() => { pruneTimer = null; updateTransferStats(); }, 4000);
    }
    return event.id;
  }
  let pruneTimer = null;
  function transferSpeed(item, now) {
    if (item.state !== "active" || !item.lastByteAt || now - item.lastByteAt > 1800) return 0;
    return item.bps || 0;
  }
  function updateTransferStats() {
    const now = Date.now();
    for (const [id, item] of transfers) if (item.state !== "active" && item.expiresAt <= now) transfers.delete(id);
    const all = [...transfers.values()], active = all.filter(item => item.state === "active");
    const recent = all.filter(item => item.state !== "active").sort((a, b) => b.id - a.id).slice(0, 24);
    stats.activeThreads = active.length;
    stats.totalSpeedBps = Math.round(active.reduce((sum, item) => sum + transferSpeed(item, now), 0));
    stats.threadSpeeds = active.concat(recent).sort((a, b) => a.id - b.id).slice(-512).map(item => ({
      id: item.id, label: `${item.kind === "video" ? "V" : item.kind === "audio" ? "A" : "M"}${String(item.id).padStart(2, "0")}`, kind: item.kind,
      loaded: item.loaded, totalBytes: item.totalBytes, bps: Math.round(transferSpeed(item, now) || item.finalBps || 0), state: item.state, host: item.host
    }));
  }
  const getStats = () => {
    updateTransferStats();
    return { ...stats, takeoverError: null, threadSpeeds: stats.threadSpeeds.map(item => ({ ...item })), cdnHosts: stats.cdnHosts.map(item => ({ ...item })) };
  };
  // The panel's 运行状态 asks for these while it is open.
  const publish = () => root.postMessage({ channel: CHANNEL, type: "stats", payload: getStats() }, "*");

  // 自动线程数 (the controller lives in the shared idm-downloader.js). The client's own video
  // element tells it what the browser version's full takeover tells it there: a stall once
  // playback had started, and a low buffer that stops growing while bytes arrive. A new video
  // or a seek starts the buffer watch afresh, and opens with more threads; switched off, the
  // controller is left alone.
  const auto = root.__BILI_IDM_DOWNLOADER_FACTORY__?.autoConcurrency;
  const autoOn = () => settings.enabled && settings.autoConcurrency;
  const newSession = () => { if (autoOn()) auto?.newSession(); };
  auto?.subscribe(({ threads, previous, reason }) => {
    if (!settings.autoConcurrency) return;
    stats.autoThreads = threads;
    remember("threads changed", `${previous} -> ${threads} (${reason})`);
  });
  let watched = null, watchEvents = null;
  function watch(element) {
    if (!auto || element === watched) return;
    watchEvents?.abort(); watchEvents = null; watched = element; newSession();
    if (!element) return;
    const events = watchEvents = new AbortController();
    const on = (name, handler) => element.addEventListener(name, handler, { signal: events.signal });
    let started = false; // playing since the last load or seek
    on("emptied", () => { started = false; newSession(); });
    on("seeking", () => { started = false; newSession(); });
    on("playing", () => { started = true; });
    on("waiting", () => { if (started && autoOn() && !element.seeking && !element.paused) auto.stall("播放卡了一下"); });
    on("timeupdate", () => {
      if (!started || !autoOn()) return;
      const now = element.currentTime, ranges = element.buffered;
      let ahead = 0;
      for (let i = 0; i < ranges.length; i++) if (ranges.start(i) <= now + 0.25 && ranges.end(i) >= now - 0.25) ahead = ranges.end(i) - now;
      auto.buffer(Math.max(0, ahead), !element.paused && !element.seeking);
    });
  }

  // The timeline of the transport stopped last, for the diagnostic copy.
  let previousTimeline = null;
  const keepTimeline = (from, key) => { try { previousTimeline = { route: key, timeline: (from.getDebug?.()?.timeline || []).slice(-60) }; } catch (_) {} };
  function stop(reason) {
    const current = transport, key = transportRoute;
    transport = transportVideo = null; transportRoute = "";
    lifecycle++;
    if (!current) return;
    keepTimeline(current, key);
    current.destroy();
    notices?.detach();
    remember("player stopped", reason);
  }
  function takeOver(video) {
    if (!inPlayer || !settings.enabled || !video) {
      stop(settings.enabled ? "no video" : "BTR switched off");
      stats.playerState = settings.enabled ? "waiting" : "disabled";
      if (!settings.enabled) stats.lastError = "";
      return;
    }
    if (transport && (video !== transportVideo || route !== transportRoute)) stop("video changed");
    if (transport || !route || !playinfo || refusedRoute === route) return;
    const container = { querySelector: () => video };
    // The client's playback core appears a moment after its player.
    if (!factory.supports(container)) { stats.playerState = "waiting"; return; }
    const session = ++lifecycle, key = route;
    let next = null;
    try {
      next = factory.createNativePlayer({
        container, playinfo, getSettings: () => settings, cdnBans, onTransfer,
        onSegment(event) {
          if (session !== lifecycle) return;
          stats.acceleratedRequests += 1;
          stats.acceleratedBytes += Number(event.bytes) || 0;
          stats.parallelSubrequests += Number(event.pieces) || 0;
          stats.lastError = "";
        },
        onState(state) {
          if (session !== lifecycle) return;
          stats.mode = state.mode || settings.mode;
          stats.playerState = state.playerState || stats.playerState;
          stats.quality = state.quality || stats.quality;
          stats.bufferedAhead = Number(state.bufferedAhead) || 0;
          if (typeof state.lastError === "string") stats.lastError = state.lastError.slice(0, 180);
          const byHost = new Map();
          for (const item of state.cdnHosts || []) {
            const known = byHost.get(item.host);
            if (!known || known.state === "untested" || ["blocked", "banned"].includes(item.state)) byHost.set(item.host, item);
          }
          stats.cdnHosts = [...byHost.values()].slice(0, 32);
          stats.discoveredCdns = stats.cdnHosts.length;
          stats.healthyCdns = stats.cdnHosts.filter(item => item.state === "healthy").length;
          stats.blockedCdns = stats.cdnHosts.filter(item => ["blocked", "banned"].includes(item.state)).length;
          // It gives a video back to the client only when the player no longer has what it
          // needs; that video stays with the client until another one is opened.
          if (state.playerState === "native-fallback" && transport === next) {
            keepTimeline(next, key);
            transport = transportVideo = null; transportRoute = ""; refusedRoute = key; lifecycle++;
            notices?.detach();
            remember("handed back to the client", state.lastError || "", "warn");
          }
        }
      });
    } catch (error) {
      refusedRoute = key; stats.playerState = "native-fallback"; stats.lastError = errorText(error);
      remember("takeover failed", `create: ${errorText(error) || "unknown error"}`, "error");
      return;
    }
    transport = next; transportVideo = video; transportRoute = key;
    remember("took over", `${key} (compat)`);
    notices?.attach(video, key, session, () => session === lifecycle && transport === next && !["error", "native-fallback", "disabled"].includes(stats.playerState));
  }

  // The addresses as the client gives them: a video's playurl answer, or an episode's
  // playview answer with the addresses under video_info (normalizePlayinfo in the browser
  // version's page-hook.js does the same).
  function normalizePlayinfo(raw) {
    const body = raw?.data || raw?.result;
    if (body?.video_info) return { code: raw.code, data: body.video_info, arc: body.arc || null };
    return raw?.result || raw?.data || raw;
  }
  function unsupportedEpisode(data) {
    const info = data?.data || data;
    if (info?.is_drm) return "DRM protected";
    if (info?.is_preview) return "preview only";
    return "";
  }
  function bind(next) {
    if (!next?.on || attached.has(next)) return;
    attached.add(next);
    next.on("Player_PlayUrl_Done", event => {
      if (root.biliPlayer !== next) return;
      scan();
      const data = normalizePlayinfo(event?.detail?.raw || event?.detail);
      if (!(data?.dash || data?.data?.dash || data?.result?.dash)) return;
      // As in the browser version, a protected or preview-only episode stays with the client.
      const unsupported = unsupportedEpisode(data);
      if (unsupported) {
        if (route) refusedRoute = route;
        stop("episode not taken over");
        remember("episode not taken over", unsupported);
        return;
      }
      playinfo = data;
      transport?.updatePlayinfo(data);
      remember("playinfo received", "", "debug");
      scan();
    });
    next.on("Player_Initialized", scan);
    next.on("Player_Dispose", () => {
      if (player !== next) return;
      stop("player closed"); watch(null);
      player = null; route = ""; refusedRoute = "";
      stats.playerState = "waiting"; stats.lastError = "";
    });
  }
  function hookFactory() {
    const create = root.nano?.createPlayer;
    if (typeof create !== "function" || create.__btrWrapped) return;
    function createPlayer(...args) { const next = Reflect.apply(create, this, args); bind(next); return next; }
    Object.defineProperty(createPlayer, "__btrWrapped", { value: true });
    try { root.nano.createPlayer = createPlayer; } catch (_) {}
  }
  function scan() {
    hookFactory();
    const next = root.biliPlayer;
    if (!next?.getManifest || !next.mediaElement) return;
    let info, element;
    try { info = next.getManifest(); element = next.mediaElement(); } catch (_) { return; }
    const key = Number(info?.cid) > 0 ? `${info.bvid || info.aid || ""}:${info.cid}` : "";
    if (next !== player || key !== route) {
      stop("video changed");
      player = next; route = key; refusedRoute = "";
      cdnBans.reset(); bans = [];
      stats.quality = ""; stats.bufferedAhead = 0; stats.cdnHosts = []; stats.discoveredCdns = stats.healthyCdns = stats.blockedCdns = 0;
      stats.playerState = "waiting"; stats.lastError = "";
      newSession();
    }
    bind(next);
    const video = element?.isConnected ? element : null;
    watch(video);
    takeOver(video);
  }

  let settingsSeen = false;
  api.onSettings(next => {
    const previous = settings, first = !settingsSeen;
    settings = next; settingsSeen = true;
    notices?.configure(settings);
    stats.mode = settings.mode;
    stats.autoThreads = settings.autoConcurrency ? auto?.threads?.() || 0 : 0;
    const serversChanged = settings.mode === "custom" && previous.customHosts.join(",") !== settings.customHosts.join(",");
    if (first || previous.enabled !== settings.enabled || previous.mode !== settings.mode || previous.concurrency !== settings.concurrency || previous.autoConcurrency !== settings.autoConcurrency || serversChanged) {
      remember("settings applied", `compat, ${settings.mode === "overseas" ? "overseas" : settings.mode === "custom" ? `custom ${settings.customHosts.length}` : "mainland"}, threads ${settings.autoConcurrency ? "auto" : settings.concurrency}`);
    }
    // The download lists read the CDN mode and servers for every request, and the downloads
    // the thread count for every range.
    if (!settings.enabled) { stop("BTR switched off"); stats.playerState = "disabled"; stats.lastError = ""; refusedRoute = ""; }
    else transport?.applySettings();
  });
  root.addEventListener("message", event => {
    if (event.source !== root || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "get-stats") publish();
  });
  const timer = setInterval(scan, 150);
  root.addEventListener("pagehide", () => { clearInterval(timer); stop("window closed"); watch(null); }, { once: true });

  // The element as the browser has it, for the diagnostic copy.
  function elementState(video) {
    const read = (value, fallback = null) => { try { return value(); } catch (_) { return fallback; } };
    const tenths = value => Math.round((Number(value) || 0) * 10) / 10;
    return {
      elementPaused: read(() => video.paused), networkState: read(() => video.networkState),
      mediaError: read(() => (video.error ? { code: Number(video.error.code) || 0, message: String(video.error.message || "") } : null)),
      buffered: read(() => Array.from({ length: Math.min(8, Number(video.buffered?.length) || 0) }, (_item, index) => [tenths(video.buffered.start(index)), tenths(video.buffered.end(index))]), [])
    };
  }
  // The same report as the browser version's, which the settings panel's 复制诊断信息 reads.
  // Playback state and node names only: no download address or account data.
  function report() {
    let debug = {};
    try { debug = transport?.getDebug?.() || {}; } catch (_) {}
    const { timeline = [], ...rest } = debug;
    const video = currentVideo();
    let frames = null;
    try { const quality = video?.getVideoPlaybackQuality?.(); if (quality) frames = { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames }; } catch (_) {}
    let nativeQuality = null;
    try { const quality = root.biliPlayer?.getQuality?.(); if (quality) nativeQuality = { nowQ: quality.nowQ, newQ: quality.newQ, realQ: quality.realQ }; } catch (_) {}
    updateTransferStats();
    return JSON.stringify({
      version: api.version, channel: "stable", scriptManager: "", at: Math.round(performance.now()),
      settings: { takeover: "compat", mode: settings.mode, customHosts: settings.customHosts.slice(), concurrency: settings.concurrency, codec: "default" },
      actualTakeover: transport ? "compat" : "native",
      videoPage: Boolean(route), nativeQuality,
      playback: video ? { currentTime: video.currentTime, duration: video.duration, ended: video.ended, paused: video.paused, seeking: video.seeking,
        readyState: video.readyState, playbackRate: video.playbackRate, width: video.videoWidth, height: video.videoHeight,
        visibility: document.visibilityState, frames, lastPresentedFrame: null, ...elementState(video) } : null,
      state: stats.playerState, lastError: stats.lastError, player: rest, nodes: stats.cdnHosts.map(item => ({ ...item })), bannedNodes: cdnBans.hosts?.() || [],
      page: pageEvents.map(event => ({ ...event })), timeline, previousPlayer: previousTimeline,
      timeOrigin: performance.timeOrigin, route: transportRoute || route,
      downloads: {
        byKind: Object.fromEntries(Object.entries(downloads.byKind).map(([kind, counts]) => [kind, { ...counts }])),
        cancelReasons: { ...downloads.cancelReasons },
        hosts: Object.fromEntries(Object.entries(downloads.hosts).map(([host, counts]) => [host, { ...counts }])),
        active: [...transfers.values()].filter(item => item.state === "active").length,
        lastBytesAt: downloads.lastBytesAt
      },
      bans: bans.map(ban => ({ ...ban }))
    }, null, 1);
  }
  Object.defineProperty(root, "__biliThreadRipperDebug", { configurable: false, value: Object.freeze({ getStats, report, version: api.version }) });

  // For the tools that read a running client (tools/sample-client.cjs and others).
  api.getStatus = () => {
    const media = currentVideo();
    return {
      version: api.version, adapterRevision: api.adapterRevision, route, takeover: transport ? "compat" : "native", stats: getStats(),
      bannedHosts: cdnBans.hosts?.() || [], autoThreads: auto?.status() || null,
      playback: media ? { currentTime: media.currentTime, duration: Number.isFinite(media.duration) ? media.duration : 0, paused: media.paused, readyState: media.readyState, width: media.videoWidth, height: media.videoHeight, buffered: Array.from({ length: media.buffered.length }, (_, i) => [media.buffered.start(i), media.buffered.end(i)]), decodedFrames: media.getVideoPlaybackQuality?.().totalVideoFrames || 0, error: media.error?.code || null } : null
    };
  };
})(globalThis);


/* src/updates.js */
(function(root) {
  "use strict";
  const api=root.__BTR_DESKTOP__, channel="__BTR_DESKTOP_UPDATE__", listeners=new Set();
  let state={state:"idle",message:"从 GitHub 检查 BTR 更新"}, pending=null, timer=null;
  const emit = next => {state=next;for(const fn of listeners)fn({...state});};
  api.getUpdate=()=>({...state});
  api.onUpdate=fn=>{listeners.add(fn);fn({...state});return()=>listeners.delete(fn);};
  api.checkUpdate=()=>{
    if(["confirming","installing","uninstalling"].includes(state.state))return Promise.resolve({...state});
    if(pending)return pending;
    emit({state:"checking",message:"正在检查 BTR 更新"});
    pending=new Promise(resolve=>{
      api._resolveUpdate=resolve;
      timer=setTimeout(()=>finish({state:"error",message:"更新检查超时，请稍后再试"}),12000);
      root.postMessage({channel,type:"check"},location.origin);
    });
    return pending;
  };
  function finish(result){clearTimeout(timer);const resolve=api._resolveUpdate;api._resolveUpdate=null;pending=null;emit(result);resolve?.(result);}
  root.addEventListener("message",event=>{
    if(event.source!==root || event.data?.channel!==channel)return;
    if(event.data.type==="auto-config") {
      if(typeof event.data.enabled==="boolean" && api.getSettings().autoCheckUpdates!==event.data.enabled)api.setSettings({autoCheckUpdates:event.data.enabled});
      return;
    }
    if(event.data.type!=="result")return;
    const value=event.data.result;
    if(!value || !["current","available","checking","confirming","installing","uninstalling","idle","error","not-configured"].includes(value.state))return;
    finish(value);
  });
  // The main process owns one timer for all windows, not a timer in every renderer.
  let configured=false, previousAuto;
  const unsubscribe=api.onSettings(settings=>{
    const enabled=settings.autoCheckUpdates!==false;
    if(configured && previousAuto===enabled)return;
    const changed=configured; configured=true; previousAuto=enabled;
    root.postMessage({channel,type:"configure-auto",enabled,changed},location.origin);
  });
  root.addEventListener("pagehide",()=>{unsubscribe();clearTimeout(timer);},{once:true});
})(globalThis);


/* src/settings-view.js */
(function (root) {
  "use strict";
  const api = root.__BTR_DESKTOP__;
  let panel, navButton, unsubscribe, unsubscribeUpdate, scheduled = false;
  const style = document.createElement("style");
  style.textContent = `
    #btr-desktop-settings{padding:24px 0;border-bottom:1px solid var(--line_regular,#303133);color:var(--text1,#d8dce2);font:inherit}
    #btr-desktop-settings h4{margin:0 0 20px;font-size:16px}#btr-desktop-settings .btr-version{margin-left:12px;color:var(--text3,#9499a0);font-size:12px;font-weight:400}
    #btr-desktop-settings .btr-row{display:flex;align-items:center;gap:16px;margin:16px 0;flex-wrap:wrap}
    #btr-desktop-settings .btr-label{min-width:132px;color:var(--text2,#b3bfca)}
    #btr-desktop-settings button,#btr-desktop-settings select{border:1px solid var(--line_regular,#353638);border-radius:5px;background:var(--bg3,#252729);color:inherit;padding:7px 15px;font:inherit;cursor:pointer}
    #btr-desktop-settings button[aria-pressed=true]{background:#bf4d7b;border-color:#bf4d7b;color:#fff}
    #btr-desktop-settings #btr-desktop-uninstall{background:#b93843;border-color:#d14c57;color:#fff}
    #btr-desktop-settings #btr-desktop-uninstall:hover:not(:disabled){background:#d04450}
    #btr-desktop-settings button:disabled{opacity:.55;cursor:default}
    #btr-desktop-settings .btr-inline{margin:0}#btr-desktop-settings .btr-threads-row.btr-auto{opacity:.45}#btr-desktop-settings .btr-threads-row.btr-auto input{cursor:default}
    #btr-desktop-settings input{accent-color:#d45b88}#btr-desktop-settings input[type=checkbox]{width:16px;height:16px;vertical-align:middle;margin:0 8px 0 0}
    #btr-desktop-settings input[type=range]{width:min(290px,55vw)}#btr-desktop-settings output{min-width:35px;color:#ef77a3;font-weight:600}
    #btr-desktop-settings .btr-custom{margin:0 0 8px 148px;max-width:520px}#btr-desktop-settings .btr-host-title{margin:14px 0 8px;color:var(--text2,#b3bfca);font-size:13px}
    #btr-desktop-settings .btr-host-list{display:grid;grid-template-columns:repeat(2,minmax(230px,1fr));gap:9px 16px;font-size:12px}#btr-desktop-settings .btr-host-list label{overflow-wrap:anywhere;cursor:pointer}
    #btr-desktop-settings .btr-host-add{display:flex;gap:8px;margin:8px 0}#btr-desktop-settings input[type=text]{flex:1;min-width:0;border:1px solid var(--line_regular,#353638);border-radius:5px;background:var(--bg3,#252729);color:inherit;padding:7px 10px;font:inherit;font-size:12px}
    #btr-desktop-settings .btr-manual-host{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:6px 0;font-size:12px;overflow-wrap:anywhere}#btr-desktop-settings .btr-manual-host button{padding:2px 9px}
    #btr-desktop-settings .btr-host-error{color:#f77979}#btr-desktop-settings .btr-host-error:empty{display:none}
    #btr-desktop-settings [hidden]{display:none!important}#btr-desktop-settings .btr-note{font-size:12px;color:var(--text3,#9499a0);line-height:1.7;margin:8px 0}
    #btr-desktop-settings .btr-save-error{color:#f77979} .settings_catalog.btr-current .settings_catalog--item:not(#btr-desktop-nav){color:var(--text2,#b3bfca)!important}.settings_catalog.btr-current .settings_catalog--item:not(#btr-desktop-nav):before{display:none!important}
    #btr-desktop-nav{order:-1}.settings_catalog.btr-current #btr-desktop-nav{color:#ef77a3}.settings_catalog.btr-current #btr-desktop-nav:before{display:block!important}
  `;
  (document.head || document.documentElement).append(style);
  function mount() {
    scheduled = false;
    const general = document.querySelector(".app_settings .settings_content--item.theme-item");
    const catalog = document.querySelector(".app_settings .settings_catalog");
    if (!general || !catalog) return;
    if (!panel?.isConnected) {
      unsubscribe?.(); unsubscribeUpdate?.();
      panel = document.createElement("section"); panel.id = "btr-desktop-settings"; panel.className = "settings_content--item";
      panel.innerHTML = `<h4>BTR 线程撕裂者<span class="btr-version">${api.version}</span></h4>
        <div class="btr-row"><label><input type="checkbox" data-setting="enabled">启用多线程加速</label></div>
        <div class="btr-row"><span class="btr-label">CDN 模式</span><button type="button" data-mode="mainland">大陆 CDN</button><button type="button" data-mode="overseas">海外 CDN</button><button type="button" data-mode="custom">自定义</button></div>
        <div class="btr-custom" hidden>
          <div class="btr-note btr-custom-empty">还没选服务器，暂时按大陆 CDN 下载。</div>
          <div class="btr-host-groups"></div>
          <div class="btr-host-title">手动添加</div>
          <div class="btr-manual-hosts"></div>
          <div class="btr-host-add"><input type="text" id="btr-desktop-host" placeholder="例如 upos-sz-mirrorali.bilivideo.com" spellcheck="false" autocomplete="off" aria-label="服务器地址"><button type="button" id="btr-desktop-host-add">添加</button></div>
          <div class="btr-note btr-host-error" role="alert"></div>
          <div class="btr-note">只能填 B 站的视频服务器（bilivideo.com、akamaized.net 等），视频的下载地址不会发给别的网站。</div>
        </div>
        <div class="btr-row"><label><input type="checkbox" data-setting="autoConcurrency">自动线程数</label><span class="btr-note btr-inline">BTR将智能选择需要的线程数。</span></div>
        <div class="btr-row btr-threads-row"><label class="btr-label" for="btr-desktop-threads">并发线程</label><input id="btr-desktop-threads" type="range" min="0" max="5" step="1"><output></output></div>
        <div class="btr-row btr-live-row"><label><input type="checkbox" data-setting="liveEnabled">直播加速（实验性）</label><span class="btr-note btr-inline">打开后，直播间画面右下角的清晰度菜单里会多一个开关，可以随时关掉。</span></div>
        <div class="btr-row"><label><input type="checkbox" data-setting="autoCheckUpdates">自动检查 BTR 更新</label></div>
        <div class="btr-row"><button type="button" id="btr-desktop-check-update">检查 BTR 更新</button><button type="button" id="btr-desktop-uninstall">卸载 BTR</button><button type="button" id="btr-desktop-install-update" hidden>安装更新</button></div>
        <div class="btr-note btr-update-status" role="status"></div><div class="btr-note btr-save-error" role="status"></div>`;
      // The servers of the custom CDN mode: the known ones to tick, others typed in.
      const core = root.__BILI_RANGE_CORE__, cdn = root.__BILI_CDN_RESOLVER_FACTORY__, maxHosts = 32;
      const hostGroups = [["大陆节点", cdn.MAINLAND_HOSTS], ["海外节点", cdn.OVERSEAS_HOSTS]];
      const knownHosts = hostGroups.flatMap(([, hosts]) => hosts);
      for (const [title, hosts] of hostGroups) {
        const heading = document.createElement("div"); heading.className = "btr-host-title"; heading.textContent = title;
        const list = document.createElement("div"); list.className = "btr-host-list";
        for (const host of hosts) {
          const label = document.createElement("label"), input = document.createElement("input");
          input.type = "checkbox"; input.dataset.host = host; label.append(input, host); list.append(label);
        }
        panel.querySelector(".btr-host-groups").append(heading, list);
      }
      const hostError = panel.querySelector(".btr-host-error"), hostInput = panel.querySelector("#btr-desktop-host");
      general.before(panel);
      const threadOptions = [4, 8, 16, 32, 64, 128];
      const save = patch => {
        try { api.setSettings(patch); panel.querySelector(".btr-save-error").textContent = ""; }
        catch (_) { panel.querySelector(".btr-save-error").textContent = "设置保存失败，请检查客户端的数据目录是否可写。"; }
      };
      const addHost = () => {
        const host = core.normalizeCdnHost(hostInput.value), hosts = api.getSettings().customHosts;
        if (!host) hostError.textContent = "这不是 B 站的视频服务器地址。";
        else if (hosts.includes(host)) hostError.textContent = "这个服务器已经在列表里了。";
        else if (hosts.length >= maxHosts) hostError.textContent = `最多选 ${maxHosts} 个服务器。`;
        else { hostError.textContent = ""; hostInput.value = ""; save({ customHosts: [...hosts, host] }); }
      };
      hostInput.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); addHost(); } });
      panel.addEventListener("change", event => {
        const input = event.target;
        if (input.dataset.host) {
          const hosts = api.getSettings().customHosts.filter(host => host !== input.dataset.host);
          if (input.checked && hosts.length >= maxHosts) { input.checked = false; hostError.textContent = `最多选 ${maxHosts} 个服务器。`; return; }
          hostError.textContent = ""; save({ customHosts: input.checked ? [...hosts, input.dataset.host] : hosts });
        }
        if (input.dataset.setting) save({ [input.dataset.setting]: input.checked });
        if (input.id === "btr-desktop-threads") save({ concurrency: threadOptions[Number(input.value)] });
      });
      panel.querySelector("input[type=range]").addEventListener("input", event => { panel.querySelector("output").textContent = String(threadOptions[Number(event.target.value)]); });
      panel.addEventListener("click", event => {
        const button = event.target.closest("button"); if (!button) return;
        if (button.id === "btr-desktop-check-update") api.checkUpdate();
        if (button.id === "btr-desktop-host-add") addHost();
        if (button.dataset.removeHost) save({ customHosts: api.getSettings().customHosts.filter(host => host !== button.dataset.removeHost) });
        if (button.dataset.mode) save({ mode: button.dataset.mode });
      });
      unsubscribe = api.onSettings(settings => {
        panel.querySelectorAll("[data-setting]").forEach(x => { x.checked = settings[x.dataset.setting]; });
        panel.querySelectorAll("[data-mode]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.mode === settings.mode)));
        panel.querySelector(".btr-custom").hidden = settings.mode !== "custom";
        panel.querySelector(".btr-custom-empty").hidden = settings.customHosts.length > 0;
        panel.querySelectorAll("[data-host]").forEach(x => { x.checked = settings.customHosts.includes(x.dataset.host); });
        panel.querySelector(".btr-manual-hosts").replaceChildren(...settings.customHosts.filter(host => !knownHosts.includes(host)).map(host => {
          const row = document.createElement("div"), text = document.createElement("span"), remove = document.createElement("button");
          row.className = "btr-manual-host"; text.textContent = host;
          remove.type = "button"; remove.dataset.removeHost = host; remove.textContent = "删除"; remove.setAttribute("aria-label", `删除 ${host}`);
          row.append(text, remove); return row;
        }));
        panel.querySelector("input[type=range]").value = String(Math.max(0, threadOptions.indexOf(settings.concurrency)));
        panel.querySelector("output").textContent = String(settings.concurrency);
        // With 自动线程数 on the slider is the manual choice kept for later, not in use.
        panel.querySelector("input[type=range]").disabled = settings.autoConcurrency;
        panel.querySelector(".btr-threads-row").classList.toggle("btr-auto", settings.autoConcurrency);
      });
      unsubscribeUpdate = api.onUpdate(update => {
        panel.querySelector(".btr-update-status").textContent = update.message;
        const busy = ["confirming","installing","uninstalling"].includes(update.state);
        panel.querySelector("#btr-desktop-check-update").disabled = busy || update.state === "checking";
        panel.querySelector("#btr-desktop-uninstall").disabled = busy;
        const install = panel.querySelector("#btr-desktop-install-update");
        install.hidden = update.state !== "available";
        install.textContent = update.manifest ? `更新到 ${update.manifest.version}` : "安装更新";
      });
    }
    if (!navButton?.isConnected) {
      navButton = document.createElement("button"); navButton.type = "button"; navButton.id = "btr-desktop-nav";
      navButton.className = "settings_catalog--item text_ellipsis"; navButton.textContent = "线程撕裂者";
      catalog.prepend(navButton);
      navButton.addEventListener("click", () => {
        const scroller = document.querySelector(".app_settings .settings_content");
        if (!scroller || !panel) return;
        scroller.scrollTo({ top: scroller.scrollTop + panel.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 20, behavior: "smooth" });
        catalog.classList.add("btr-current"); navButton.classList.add("active");
      });
      catalog.addEventListener("click", event => { if (!navButton.contains(event.target)) { catalog.classList.remove("btr-current"); navButton.classList.remove("active"); } });
      const scroller = document.querySelector(".app_settings .settings_content");
      const updateSelection = () => {
        const top = panel.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        const selected = scroller.scrollTop < 1 || (top <= 24 && top + panel.offsetHeight > 24);
        catalog.classList.toggle("btr-current", selected); navButton.classList.toggle("active", selected);
      };
      scroller?.addEventListener("scroll", updateSelection, { passive: true });
      if (scroller) updateSelection();
    }
  }
  const observer = new MutationObserver(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(mount); } });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  mount();
})(globalThis);


/* src/player-settings.js */
(function (root) {
  "use strict";
  const api = root.__BTR_DESKTOP__, threads = [4, 8, 16, 32, 64, 128];
  const id = "btr-desktop-player-settings";
  let panel, unsubscribe, scheduled = false, opened = false;
  const style = document.createElement("style");
  style.textContent = `
    /* The client's own measures (its rows: title 16px + 4px, buttons 19px + 12px, 4px between buttons). */
    #${id}{margin:0;color:#fff;font-size:12px;text-align:left}
    #${id} .btr-native-setting-group{margin:0 0 12px}
    #${id} .btr-native-setting-title{height:16px;line-height:16px;margin:0 0 4px;color:#fff}
    #${id} .bui-radio-group{display:flex!important;flex-wrap:nowrap!important;gap:4px!important;margin:0!important}
    #${id} .bui-radio-item{flex:1 1 0!important;min-width:0!important;margin:0!important}
    #${id} .btr-save-error{color:#ff8585;line-height:1.5}
    #${id} summary{display:flex;justify-content:space-between;gap:12px;height:16px;line-height:16px;margin:0 0 12px;cursor:pointer;list-style:none}
    #${id} summary::-webkit-details-marker{display:none}
    #${id} summary span{color:hsla(0,0%,100%,.6)}#${id} summary span:after{content:" ▸"}#${id} details[open] summary span:after{content:" ▾"}
  `;
  (document.head || document.documentElement).append(style);
  // Keep the official player's own radio styling and secondary settings menu.
  function group(title, setting, options) {
    const section = document.createElement("div"); section.className = "btr-native-setting-group";
    const heading = document.createElement("div"); heading.className = "btr-native-setting-title"; heading.textContent = title;
    const content = document.createElement("div"); content.className = "bui bui-radio bui-dark";
    content.innerHTML = '<div class="bui-area"><div class="bui-radio-wrap bui-radio-button"><div class="bui-radio-group"></div></div></div>';
    for (const [value, text] of options) {
      const label = document.createElement("label"); label.className = "bui-radio-item";
      const input = document.createElement("input"); input.type = "radio"; input.className = "bui-radio-input";
      input.name = `btr-desktop-player-${setting}`; input.dataset.btrSetting = setting; input.value = String(value);
      const body = document.createElement("span"); body.className = "bui-radio-label";
      const caption = document.createElement("span"); caption.className = "bui-radio-text"; caption.textContent = text;
      body.append(caption); label.append(input, body); content.querySelector(".bui-radio-group").append(label);
    }
    section.append(heading, content); return section;
  }
  // 复制诊断信息, as the browser version's settings panel does it: gather what each part of BTR
  // knows in this player window and let shared/diagnostic-report.js lay it out as English text for
  // an issue. No download address and no account data.
  function diagnostics() {
    const readErrors = [];
    const read = (name, fact, fallback = null) => { try { return fact(); } catch (error) { readErrors.push(`${name}: ${String(error?.message || error).slice(0, 160)}`); return fallback; } };
    return String(root.__BTR_DIAGNOSTIC_REPORT__.render({
      capturedAt: Date.now(), timeOrigin: performance.timeOrigin, now: performance.now(),
      btr: { version: api.version, channel: "stable", otherBuild: "", scriptManager: "", host: "desktop" },
      env: read("env", () => ({ userAgent: navigator.userAgent, language: navigator.language, viewport: `${root.innerWidth}x${root.innerHeight}`, page: `${location.origin}${location.pathname}` })),
      settings: api.getSettings(), site: null,
      video: read("video", () => JSON.parse(root.__biliThreadRipperDebug.report())),
      stats: read("stats", () => root.__biliThreadRipperDebug.getStats()),
      autoThreads: read("autoThreads", () => root.__BILI_IDM_DOWNLOADER_FACTORY__?.autoConcurrency?.status?.() ?? null),
      media: read("media", () => root.__BTR_RUNTIME_NOTICES__?.history?.() ?? [], []),
      live: [], readErrors
    }));
  }
  // The page may write the clipboard only while its window is in front; otherwise the client's
  // main process does it (payload/preload.cjs).
  const copyText = text => navigator.clipboard.writeText(text).catch(() => new Promise((resolve, reject) => {
    const channel = "__BTR_DESKTOP_UPDATE__", copyId = `${Date.now()}-${Math.random()}`;
    const answer = event => {
      if (event.source !== root || event.data?.channel !== channel || event.data.type !== "copied" || event.data.id !== copyId) return;
      root.removeEventListener("message", answer); clearTimeout(timer);
      if (event.data.ok) resolve(); else reject(Error("copy refused"));
    };
    const timer = setTimeout(() => { root.removeEventListener("message", answer); reject(Error("no answer")); }, 2000);
    root.addEventListener("message", answer);
    root.postMessage({ channel, type: "copy", id: copyId, text }, root.location.origin);
  }));
  function mount() {
    scheduled = false;
    const target = document.querySelector(".bpx-player-ctrl-setting-menu-right");
    if (!target) { if (panel && !panel.isConnected) { unsubscribe?.(); unsubscribe = null; panel = null; } return; }
    if (panel?.parentElement === target) return;
    unsubscribe?.(); panel?.remove();
    panel = document.createElement("div"); panel.id = id;
    // One line in the client's menu, which is already long: the choices open under it.
    const fold = document.createElement("details"), summary = document.createElement("summary"), state = document.createElement("span");
    summary.append("线程撕裂者", state);
    // The client rebuilds its menu now and then: stay as the viewer left it.
    fold.open = opened; fold.addEventListener("toggle", () => { opened = fold.open; });
    const error = document.createElement("div"); error.className = "btr-save-error"; error.setAttribute("role", "status");
    fold.append(
      summary,
      group("CDN", "mode", [["mainland", "大陆 CDN"], ["overseas", "海外 CDN"], ["custom", "自定义"]]),
      group("并发线程", "concurrency", [["auto", "自动"], ...threads.map(value => [value, String(value)])]),
      // A button in the look of the client's own choices; it never stays picked.
      group("诊断", "diagnostics", [["copy", "复制诊断信息"]]),
      error
    );
    panel.append(fold);
    panel.addEventListener("change", event => {
      const input = event.target; if (!(input instanceof HTMLInputElement) || !input.checked) return;
      const setting = input.dataset.btrSetting;
      if (setting === "diagnostics") {
        input.checked = false;
        const caption = input.parentElement.querySelector(".bui-radio-text");
        copyText(diagnostics()).then(() => "已复制", () => "复制失败").then(text => { caption.textContent = text; setTimeout(() => { caption.textContent = "复制诊断信息"; }, 2000); });
        return;
      }
      if (setting !== "mode" && setting !== "concurrency") return;
      // "自动" switches 自动线程数 on; a number switches it off and sets that thread count.
      const patch = setting === "mode" ? { mode: input.value }
        : input.value === "auto" ? { autoConcurrency: true } : { autoConcurrency: false, concurrency: Number(input.value) };
      try { api.setSettings(patch); error.textContent = ""; }
      catch (_) { error.textContent = "设置保存失败，请检查客户端的数据目录是否可写。"; }
    });
    target.insertBefore(panel, target.querySelector(".bpx-player-ctrl-setting-others") || target.firstChild);
    unsubscribe = api.onSettings(settings => {
      for (const input of panel.querySelectorAll("[data-btr-setting]")) {
        if (input.dataset.btrSetting === "diagnostics") continue;
        const shown = input.dataset.btrSetting === "concurrency" && settings.autoConcurrency ? "auto" : String(settings[input.dataset.btrSetting]);
        input.checked = input.value === shown;
      }
      state.textContent = `${{ mainland: "大陆 CDN", overseas: "海外 CDN", custom: "自定义 CDN" }[settings.mode]} · ${settings.autoConcurrency ? "自动线程" : `${settings.concurrency} 线程`}`;
    });
  }
  const observer = new MutationObserver(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(mount); } });
  observer.observe(document.documentElement, {childList:true,subtree:true});
  root.addEventListener("pagehide", () => { observer.disconnect(); unsubscribe?.(); }, {once:true});
  mount();
})(globalThis);

