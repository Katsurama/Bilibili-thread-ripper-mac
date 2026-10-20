(function installLiveCore(root) {
  "use strict";

  const LIVE_ORIGIN = "https://live.bilibili.com";
  const LIVE_HOST_RE = /(?:^|\.)bilivideo\.(?:com|cn|net)$/i;
  const M4S_RE = /\.m4s$/i;
  const M3U8_RE = /\.m3u8$/i;

  function parseUrl(value, base) {
    try { return new URL(value, base); } catch (_error) { return null; }
  }

  function isLivePageUrl(value) {
    const url = parseUrl(value);
    return url?.protocol === "https:" && url.origin === LIVE_ORIGIN;
  }

  function isLivePlaylistUrl(value) {
    const url = parseUrl(value);
    return url?.protocol === "https:" && LIVE_HOST_RE.test(url.hostname) && M3U8_RE.test(url.pathname);
  }

  function isLiveSegmentUrl(value) {
    const url = parseUrl(value);
    return url?.protocol === "https:" && LIVE_HOST_RE.test(url.hostname)
      && url.pathname.includes("/live-bvc/") && M4S_RE.test(url.pathname);
  }

  function parseM3u8(text, playlistUrl) {
    if (typeof text !== "string" || !isLivePlaylistUrl(playlistUrl)) return null;
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines[0] !== "#EXTM3U" || lines.some(line => line.startsWith("#EXT-X-STREAM-INF"))) return null;
    let initSegment = null;
    const segments = [];
    for (const line of lines) {
      if (line.startsWith("#EXT-X-MAP:")) {
        const match = /(?:^|,)URI="([^"]+)"/.exec(line.slice("#EXT-X-MAP:".length));
        if (!match) return null;
        initSegment = parseUrl(match[1], playlistUrl)?.href || null;
      } else if (!line.startsWith("#")) {
        const url = parseUrl(line, playlistUrl)?.href;
        if (!url || !isLiveSegmentUrl(url)) return null;
        segments.push(url);
      }
    }
    if (!initSegment || !isLiveSegmentUrl(initSegment) || !segments.length) return null;
    return Object.freeze({ initSegment, segments: Object.freeze(segments) });
  }

  function shouldHandleRequest({ pageUrl, liveEnabled, url, method = "GET", headers } = {}) {
    if (liveEnabled !== true || !isLivePageUrl(pageUrl) || String(method).toUpperCase() !== "GET") return false;
    const range = headers && typeof headers.get === "function" ? headers.get("range") : headers?.Range || headers?.range;
    if (range) return false;
    return isLivePlaylistUrl(url) || isLiveSegmentUrl(url);
  }

  root.__BILI_LIVE_CORE__ = Object.freeze({
    isLivePageUrl,
    isLivePlaylistUrl,
    isLiveSegmentUrl,
    parseM3u8,
    shouldHandleRequest
  });
})(globalThis);
