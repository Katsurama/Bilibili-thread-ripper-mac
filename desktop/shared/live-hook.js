(function installLiveHook(root) {
  "use strict";
  const core = root.__BILI_LIVE_CORE__, cdn = root.__BILI_CDN_RESOLVER_FACTORY__, api = root.__BTR_DESKTOP__;
  if (!core || !cdn || !api || root.location?.origin !== "https://live.bilibili.com") return;
  const nativeFetch = root.fetch?.bind(root);
  const NativeXHR = root.XMLHttpRequest;
  if (!nativeFetch || root.__BTR_LIVE_HOOK__) return;
  root.__BTR_LIVE_HOOK__ = true;
  root.__BTR_LIVE_STATUS__ = "loaded";
  const active = () => {
    const settings = api.getSettings();
    return settings.enabled && settings.liveEnabled;
  };
  let acceleratedSegments = 0;
  const badge = document.createElement("button");
  badge.type = "button";
  badge.textContent = "BTR 直播加速：关闭";
  badge.style.cssText = "position:fixed;z-index:2147483647;right:12px;bottom:12px;padding:5px 9px;border:1px solid rgba(255,255,255,.45);border-radius:5px;background:rgba(20,20,20,.88);color:#fff;font:12px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer";
  document.getElementById?.("btr-live-preload-status")?.remove();
  function updateBadge() {
    badge.textContent = active()
      ? `BTR 直播加速：${acceleratedSegments ? `已接管 ${acceleratedSegments} 个分片` : "已启用，等待分片"}`
      : "BTR 直播加速：关闭";
    badge.style.display = "";
  }
  root.__BTR_LIVE_STATUS__ = active() ? "enabled" : "disabled";
  function installBadge() {
    if (document.documentElement && !badge.isConnected) document.documentElement.append(badge);
    updateBadge();
  }
  badge.addEventListener("click", () => {
    try { api.setSettings({ liveEnabled: !api.getSettings().liveEnabled }); } catch (_) {}
    updateBadge();
    updateQualityControl();
  });
  const qualityControl = document.createElement("button");
  qualityControl.type = "button";
  qualityControl.className = "btr-live-toggle";
  qualityControl.style.cssText = "margin-left:8px;padding:4px 8px;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer";
  qualityControl.addEventListener("click", () => {
    try { api.setSettings({ liveEnabled: !api.getSettings().liveEnabled }); } catch (_) {}
    updateBadge();
    updateQualityControl();
  });
  function updateQualityControl() {
    const enabled = active();
    qualityControl.textContent = enabled
      ? `BTR 加速：${acceleratedSegments ? `已接管 ${acceleratedSegments} 个分片` : "已启用，等待分片"}`
      : "BTR 加速：关";
    qualityControl.setAttribute("aria-pressed", String(enabled));
    qualityControl.title = enabled
      ? "已启用；点击关闭直播加速"
      : "点击开启直播加速";
  }
  function installQualityControl() {
    if (!document.querySelector) return;
    const enhancement = [...document.querySelectorAll("button,[role=button],span,div")].find(node => {
      const text = String(node.textContent || "").trim();
      return /^画质增强(?:\s|$)/.test(text) && text.length < 40;
    });
    if (enhancement?.parentElement) {
      const row = enhancement.parentElement;
      if (qualityControl.parentElement !== row.parentElement) row.parentElement?.insertBefore(qualityControl, row);
      qualityControl.style.cssText = "display:block;width:100%;box-sizing:border-box;margin:0;padding:13px 40px 13px 40px;border:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer";
      qualityControl.dataset.btrQualityMenu = "true";
    } else if (!qualityControl.isConnected) {
      const candidates = [...document.querySelectorAll("button,[role=button],[aria-label]")].filter(node => {
        const text = `${node.textContent || ""} ${node.getAttribute("aria-label") || ""}`;
        return /画质|清晰度|quality/i.test(text) && text.length < 80;
      });
      const anchor = candidates[candidates.length - 1];
      if (anchor?.parentElement) anchor.parentElement.append(qualityControl);
    }
    updateQualityControl();
  }
  installBadge();
  installXhrHook();
  new MutationObserver(() => { installBadge(); installQualityControl(); }).observe(document.documentElement, { childList: true, subtree: true });
  api.onSettings(() => { root.__BTR_LIVE_STATUS__ = active() ? "enabled" : "disabled"; updateBadge(); updateQualityControl(); });
  installQualityControl();

  const segmentCache = new Map();
  const prefetching = new Set();
  const MAX_CACHE_ENTRIES = 4;
  const MAX_CACHE_BYTES = 8 * 1024 * 1024;
  const MAX_PREFETCH = 2;

  function cacheResponse(url, response) {
    if (!response?.ok || !response.body) return;
    void response.clone().arrayBuffer().then(buffer => {
      if (!buffer.byteLength || buffer.byteLength > MAX_CACHE_BYTES) return;
      segmentCache.delete(url);
      segmentCache.set(url, {
        bytes: new Uint8Array(buffer),
        headers: [...response.headers.entries()]
      });
      while (segmentCache.size > MAX_CACHE_ENTRIES) segmentCache.delete(segmentCache.keys().next().value);
    }).catch(() => {});
  }

  function cachedResponse(url) {
    const item = segmentCache.get(url);
    if (!item) return null;
    segmentCache.delete(url);
    segmentCache.set(url, item);
    return new Response(item.bytes.slice(), { status: 200, headers: item.headers });
  }

  function resolver(url) {
    return cdn.createResolver({ baseUrl: url }, () => api.getSettings().mode, null, () => api.getSettings().customHosts);
  }
  const xhrRoutes = new Map();
  function routeLiveUrl(url) {
    if (!active()) return null;
    let candidates = resolver(url).urls().filter(candidate =>
      core.isLivePlaylistUrl(candidate) || core.isLiveSegmentUrl(candidate));
    if (!candidates.length && core.isLivePlaylistUrl(url)) {
      const settings = api.getSettings();
      const custom = settings.mode === "custom" ? settings.customHosts : [];
      const hosts = custom.length ? custom
        : settings.mode === "overseas" ? cdn.OVERSEAS_HOSTS
          : settings.mode === "auto" ? cdn.GLOBAL_HOSTS : cdn.MAINLAND_HOSTS;
      candidates = hosts.map(host => {
        try {
          const routed = new URL(url);
          routed.hostname = host;
          routed.port = "";
          return routed.href;
        } catch (_) { return null; }
      }).filter(Boolean).slice(0, 4);
    }
    if (!candidates.length) return null;
    const key = String(url);
    const index = (xhrRoutes.get(key) || 0) % candidates.length;
    xhrRoutes.set(key, index + 1);
    return candidates[index];
  }
  function installXhrHook() {
    if (!NativeXHR?.prototype?.open || !NativeXHR.prototype.send || root.__BTR_LIVE_XHR_HOOK__) return;
    root.__BTR_LIVE_XHR_HOOK__ = true;
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function btrLiveOpen(method, url, ...rest) {
      const originalUrl = String(url);
      const routedUrl = routeLiveUrl(originalUrl);
      this.__btrLiveUrl = routedUrl ? originalUrl : "";
      return nativeOpen.call(this, method, routedUrl || url, ...rest);
    };
    NativeXHR.prototype.send = function btrLiveSend(body) {
      if (this.__btrLiveUrl) {
        const mark = () => {
          if (this.status >= 200 && this.status < 400) {
            acceleratedSegments += 1;
            updateBadge();
            updateQualityControl();
          }
        };
        this.addEventListener("load", mark, { once: true });
        this.addEventListener("error", () => {
          this.__btrLiveUrl = "";
        }, { once: true });
      }
      return nativeSend.call(this, body);
    };
  }
  async function raceSegment(url, init) {
    const candidates = resolver(url).urls().filter(core.isLiveSegmentUrl).slice(0, 3);
    root.__BTR_LIVE_STATUS__ = candidates.length ? "routing" : "fallback";
    if (!candidates.length) return nativeFetch(url, init);
    const controllers = candidates.map(() => new AbortController());
    let settled = false;
    const request = (candidate, index) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => controllers[index].abort(), 5500);
      nativeFetch(candidate, { ...init, signal: controllers[index].signal }).then(response => {
        clearTimeout(timer);
        if (!response.ok) throw Object.assign(new Error(`直播节点 HTTP ${response.status}`), { response });
        if (settled) return;
        settled = true;
        acceleratedSegments += 1;
        root.__BTR_LIVE_STATUS__ = "accelerated";
        updateBadge();
        updateQualityControl();
        controllers.forEach((controller, other) => { if (other !== index) controller.abort(); });
        cacheResponse(url, response);
        resolve(response);
      }).catch(error => { clearTimeout(timer); reject(error); });
    });
    try {
      return await Promise.any(candidates.map(request));
    } catch (_) {
      return nativeFetch(url, init);
    }
  }

  async function prefetchSegments(urls) {
    for (const url of urls.slice(-MAX_PREFETCH)) {
      if (segmentCache.has(url) || prefetching.has(url)) continue;
      prefetching.add(url);
      try {
        const response = await raceSegment(url, { method: "GET" });
        if (!response.ok) continue;
        await response.arrayBuffer();
      } catch (_) {
        // Prefetch is opportunistic; playback continues through the normal request path.
      } finally {
        prefetching.delete(url);
      }
    }
  }

  root.fetch = async function btrLiveFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input?.url;
    const method = init.method || input?.method || "GET";
    const headers = init.headers || input?.headers;
    if (!active() || !core.shouldHandleRequest({ pageUrl: location.href, liveEnabled: true, url, method, headers })) {
      return nativeFetch(input, init);
    }
    if (core.isLivePlaylistUrl(url)) {
      const response = await nativeFetch(input, init);
      if (!response.ok) return response;
      const text = await response.clone().text();
      const playlist = core.parseM3u8(text, url);
      if (playlist) void prefetchSegments(playlist.segments);
      return response;
    }
    const cached = cachedResponse(url);
    if (cached) return cached;
    return raceSegment(url, init);
  };
  root.addEventListener("pagehide", () => {
    root.fetch = nativeFetch;
    if (NativeXHR?.prototype && root.__BTR_LIVE_XHR_HOOK__) {
      delete root.__BTR_LIVE_XHR_HOOK__;
    }
    xhrRoutes.clear();
    segmentCache.clear();
    prefetching.clear();
    badge.remove();
    qualityControl.remove();
  }, { once: true });
})(globalThis);
