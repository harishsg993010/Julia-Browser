// Part 15: Resource Timing for subresources the host fetches (images, scripts, stylesheets,
// fonts, frames, media): the HTTP client records every request with its fetch destination,
// and each realm claims the records of its own document (host op "resourceTimings") and turns
// them into PerformanceResourceTiming entries: timing-allow check (Timing-Allow-Origin),
// response status / content type hidden for cross-origin no-cors responses, minimized MIME
// types and Server-Timing (PerformanceServerTiming). fetch()/XHR entries come from hostFetch.
(function () {
  if (!__jb.perf || typeof PerformanceResourceTiming !== "function") return;
  var perf = __jb.perf;
  var DEST_INITIATOR = { image: "img", script: "script", style: "link", font: "css", track: "track", audio: "audio", video: "video", iframe: "iframe", frame: "frame", object: "object", embed: "embed", manifest: "link", xslt: "other", report: "other", paintworklet: "other", audioworklet: "other" };
  __jb.rtHints = Object.create(null); // url -> initiatorType given by the loader (e.g. "css" for @import, "input")
  var docUrl = function () { try { return __jb.currentDocument ? __jb.currentDocument.URL : location.href; } catch (e) { return ""; } };
  var myOrigin = function () { try { return new URL(docUrl()).origin; } catch (e) { return "null"; } };
  var originOf = function (u) { try { return new URL(u).origin; } catch (e) { return "null"; } };

  // ---- Server-Timing ----
  class PerformanceServerTiming {
    constructor() { throw new TypeError("Illegal constructor"); }
    get name() { return this._st.name; }
    get duration() { return this._st.duration; }
    get description() { return this._st.description; }
    toJSON() { return { name: this._st.name, duration: this._st.duration, description: this._st.description }; }
  }
  Object.defineProperty(PerformanceServerTiming.prototype, Symbol.toStringTag, { value: "PerformanceServerTiming", configurable: true });
  globalThis.PerformanceServerTiming = PerformanceServerTiming;
  // Server-Timing: metric;dur=12.3;desc="text", other
  __jb.parseServerTiming = function (value) {
    var out = [];
    if (!value) return out;
    var s = String(value), i = 0, n = s.length;
    var ws = function () { while (i < n && /[ \t]/.test(s[i])) i++; };
    var token = function () { var m = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+/.exec(s.slice(i)); if (!m) return null; i += m[0].length; return m[0]; };
    var value_ = function () {
      ws();
      if (s[i] === '"') {
        var v = ""; i++;
        while (i < n && s[i] !== '"') { if (s[i] === "\\" && i + 1 < n) { v += s[i + 1]; i += 2; } else v += s[i++]; }
        if (i < n) i++;
        return v;
      }
      var t = token(); return t === null ? "" : t;
    };
    while (i < n) {
      ws();
      var name = token();
      if (name === null) { var nc = s.indexOf(",", i); if (nc < 0) break; i = nc + 1; continue; }
      var st = { name: name, duration: 0, description: "" }, seenDur = false, seenDesc = false;
      for (;;) {
        ws();
        if (s[i] !== ";") break;
        i++; ws();
        var pn = token();
        if (pn === null) break;
        ws();
        var pv = "";
        if (s[i] === "=") { i++; pv = value_(); }
        var lpn = pn.toLowerCase();
        if (lpn === "dur" && !seenDur) { seenDur = true; var d = parseFloat(pv); st.duration = isNaN(d) ? 0 : d; }
        else if (lpn === "desc" && !seenDesc) { seenDesc = true; st.description = pv; }
      }
      out.push(st);
      ws();
      var c = s.indexOf(",", i);
      if (c < 0) break;
      i = c + 1;
    }
    return out.map(function (x) { var o = Object.create(PerformanceServerTiming.prototype); Object.defineProperty(o, "_st", { value: x }); return o; });
  };

  // ---- MIME type minimization (Resource Timing contentType) ----
  var JS_MIMES = /^(application\/(ecmascript|javascript|x-ecmascript|x-javascript)|text\/(ecmascript|javascript|javascript1\.[0-5]|jscript|livescript|x-ecmascript|x-javascript))$/;
  __jb.minimizeMime = function (ct) {
    var e = String(ct || "").split(";")[0].trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/.test(e)) return "";
    if (JS_MIMES.test(e)) return "text/javascript";
    if (e === "application/json" || e === "text/json" || /\+json$/.test(e)) return "application/json";
    if (e === "image/svg+xml") return e;
    if (e === "application/xml" || e === "text/xml" || /\+xml$/.test(e)) return "application/xml";
    if (/^(text\/(html|css|plain|vtt|csv|markdown|event-stream)|image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|apng)|font\/(woff|woff2|ttf|otf|collection)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|application\/(octet-stream|wasm|pdf|manifest\+json|font-woff))$/.test(e)) return e;
    return "";
  };

  // timing allow check: same origin, or Timing-Allow-Origin lists * or the document origin
  var taoPasses = function (rec, origin) {
    if (originOf(rec.finalUrl || rec.url) === origin && originOf(rec.url) === origin) return true;
    var tao = rec.headers && rec.headers["timing-allow-origin"];
    if (!tao) return false;
    return String(tao).split(",").some(function (v) { v = v.trim(); return v === "*" || v === origin; });
  };
  __jb.makeResourceEntry = function (rec, initiatorType, start, end) {
    var origin = myOrigin(), pass = taoPasses(rec, origin);
    var crossOrigin = originOf(rec.finalUrl || rec.url) !== origin || originOf(rec.url) !== origin;
    // no-cors subresources and navigations (nested documents) hide a cross-origin response's status
    var crossNoCors = (rec.mode === "no-cors" || rec.mode === "navigate" || rec.dest === "object" || rec.dest === "embed") && (crossOrigin || !!(rec.headers && rec.headers["x-jb-cross-redirect"]));
    // a cross-origin CORS request whose response fails the access check is a network error
    if (!crossNoCors && rec.mode === "cors" && crossOrigin && rec.status) {
      var acao = rec.headers && rec.headers["access-control-allow-origin"];
      if (!acao || (String(acao).trim() !== "*" && String(acao).trim() !== origin)) crossNoCors = true;
    }
    var size = rec.size || 0, cl = rec.headers && rec.headers["content-length"] !== undefined ? parseInt(rec.headers["content-length"], 10) : NaN;
    var encoded = isNaN(cl) ? size : cl;
    var e = new PerformanceResourceTiming(__jb.PERF_TOKEN, String(rec.url), initiatorType, start, end, { transfer: pass ? encoded + 300 : 0, encoded: pass ? encoded : 0, decoded: pass ? size : 0 }, crossNoCors ? 0 : rec.status, crossNoCors ? "" : __jb.minimizeMime(rec.headers && rec.headers["content-type"]));
    var mid = start + Math.max(0, end - start) / 2;
    if (pass) {
      e._rt.domainLookupStart = e._rt.domainLookupEnd = e._rt.connectStart = e._rt.connectEnd = e._rt.requestStart = start;
      e._rt.secureConnectionStart = /^https:/.test(rec.finalUrl || rec.url) ? start : 0;
      e._rt.responseStart = mid;
      e._rt.nextHopProtocol = "http/1.1";
      if (rec.finalUrl && rec.finalUrl !== rec.url) { e._rt.redirectStart = start; e._rt.redirectEnd = start; }
      e._rt.serverTiming = __jb.parseServerTiming(rec.headers && rec.headers["server-timing"]);
    } else {
      e._rt.domainLookupStart = e._rt.domainLookupEnd = e._rt.connectStart = e._rt.connectEnd = e._rt.requestStart = e._rt.responseStart = e._rt.secureConnectionStart = 0;
      e._rt.redirectStart = e._rt.redirectEnd = 0;
      e._rt.nextHopProtocol = "";
      e._rt.serverTiming = [];
    }
    if (rec.status === 0) { e._rt.responseStatus = 0; e._rt.contentType = ""; }
    // initiatorUrl (tentative): the external script running when the request was made, else the document
    var iu = __jb.rtInitiatorUrls[rec.url];
    if (iu) delete __jb.rtInitiatorUrls[rec.url];
    e._rt.initiatorUrl = iu || docUrl();
    return e;
  };
  var isTop = function () { try { return !__jb.frameContext && !__jb.isWorker; } catch (e) { return true; } };
  var pulling = false, seenCached = Object.create(null), preloaded = Object.create(null);
  __jb.rtForget = function () { seenCached = Object.create(null); }; // clearResourceTimings() keeps the cache
  __jb.pullResourceTimings = function () {
    if (pulling || typeof __jb.native !== "function") return;
    pulling = true;
    try {
      // the navigation entry's Server-Timing comes from the document's response headers
      var nav = perf.buffers.navigation && perf.buffers.navigation[0];
      if (nav && !nav._jbServerTiming) {
        var dh = null; try { dh = __jb.currentDocument && __jb.currentDocument._responseHeaders; } catch (e0) {}
        if (dh) { Object.defineProperty(nav, "_jbServerTiming", { value: true }); nav._rt.serverTiming = __jb.parseServerTiming(dh["server-timing"] || dh["Server-Timing"]); }
      }
      var recs = __jb.native("resourceTimings", { doc: docUrl(), top: isTop() });
      if (Array.isArray(recs) && recs.length) (__jb.rtLog = __jb.rtLog || []).push(recs.map(function (r) { return r.url.split("/").pop() + ":" + r.dest + ":" + r.mode + ":" + r.status; }).join(","));
      if (!Array.isArray(recs) || !recs.length) return;
      var elapsed = __jb.native("elapsed"), offset = performance.now() - (typeof elapsed === "number" ? elapsed : 0);
      recs.forEach(function (rec) {
        if (/^(data|blob|about):/i.test(rec.url)) return;
        // a preload's response is consumed by the next request for it: one entry for both
        var pkey = rec.dest + " " + rec.url;
        // (a preload's response is consumed by the host's preload store: no second record)
        var hint = __jb.rtHints[rec.url], it;
        if (hint && typeof hint === "object") {
          delete __jb.rtHints[rec.url];
          it = hint.type;
        } else it = hint || DEST_INITIATOR[rec.dest] || "other";
        // images, stylesheets and fonts are reused from the memory cache: one entry per URL
        if ((rec.dest === "image" || rec.dest === "style" || rec.dest === "font") && rec.status) {
          var key = rec.dest + " " + rec.mode + " " + rec.url;
          if (seenCached[key]) return;
          seenCached[key] = true;
        }
        var start = Math.max(0, rec.start + offset), end = Math.max(start, rec.end + offset);
        perf.add(__jb.makeResourceEntry(rec, it, start, end));
      });
    } catch (e) {} finally { pulling = false; }
  };
  // requests the page makes through the host carry the requesting document (ownership)
  __jb.rtInitiatorUrls = Object.create(null);
  var runningScriptUrl = function () {
    try { var cs = __jb.currentDocument && __jb.currentDocument.currentScript; return cs && cs.src ? cs.src : ""; } catch (e) { return ""; }
  };
  var origNative = __jb.native;
  __jb.native = function (op, payload) {
    if ((op === "image" || op === "imageStart" || op === "fetch") && payload && typeof payload === "object") {
      if (payload.rtDoc === undefined) payload.rtDoc = docUrl();
      var su = runningScriptUrl();
      if (su && payload.url) __jb.rtInitiatorUrls[String(payload.url)] = su;
    }
    var r = origNative.apply(this, arguments);
    // the request's record exists now: entries reach observers without waiting for a load event
    if (op === "image" || op === "fetch") { try { __jb.pullResourceTimings(); } catch (e) {} }
    return r;
  };
  // entries become visible when the timeline is read and at every frame
  var origAll = perf.all;
  perf.all = function () { __jb.pullResourceTimings(); return origAll.apply(this, arguments); };
  if (typeof PerformanceObserver === "function") {
    var origObserve = PerformanceObserver.prototype.observe;
    PerformanceObserver.prototype.observe = function (options) {
      __jb.pullResourceTimings();
      var r = origObserve.apply(this, arguments);
      try { if (this._types && this._types.indexOf("resource") >= 0) startTicker(); } catch (e) {}
      return r;
    };
  }
  // requests made outside the page's fetch ops (scripts, stylesheets, workers' subresources) are
  // pulled every frame while a resource observer is connected
  var ticking = false;
  var hasResourceObserver = function () {
    var obs = perf.observers || [];
    for (var i = 0; i < obs.length; i++) if (obs[i]._types && obs[i]._types.indexOf("resource") >= 0) return true;
    return false;
  };
  var startTicker = function () {
    if (ticking) return;
    ticking = true;
    var tick = function () {
      if (!hasResourceObserver()) { ticking = false; return; }
      try { __jb.pullResourceTimings(); } catch (e) {}
      (__jb.frameTimeout || setTimeout)(tick, 16);
    };
    (__jb.frameTimeout || setTimeout)(tick, 16);
  };
  if (__jb.paint) __jb.paint.beforeFrame = function () { __jb.pullResourceTimings(); };
  if (typeof Performance === "function" && __jb.defineEventHandlerProps) __jb.defineEventHandlerProps(Performance.prototype, ["resourcetimingbufferfull"]);
  // CSS-connected fonts: the layout engine renders text without fetching @font-face sources
  // through the page, so test pages fetch them here (initiator "css", destination font)
  var fontsFetched = Object.create(null);
  var wpt = function () { try { return !!(__jb.wptMode || (__jb.topJb && __jb.topJb().wptMode)); } catch (e) { return false; } };
  var fetchFontsIn = function (text, base) {
    var re = /@font-face\s*\{([^}]*)\}/gi, m;
    while ((m = re.exec(text))) {
      var src = /src\s*:\s*([^;]*)/i.exec(m[1]);
      if (!src) continue;
      var u = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/i.exec(src[1]);
      if (!u) continue;
      var abs; try { abs = new URL(u[1] !== undefined ? u[1] : u[2] !== undefined ? u[2] : u[3], base).href; } catch (e) { continue; }
      if (!/^https?:/.test(abs) || fontsFetched[abs]) continue;
      fontsFetched[abs] = true;
      __jb.rtHints[abs] = "css";
      (function (url) { setTimeout(function () { try { __jb.hostFetch(url, "GET", { Accept: "*/*" }, null, false, "", "css", { dest: "font", mode: "cors" }); } catch (e) {} }, 0); })(abs);
    }
  };
  // a fetched style sheet's url() references are requested by the sheet: initiator "css";
  // its @font-face sources are fetched here
  __jb.rtCssSubresources = function (text, base) {
    if (!wpt()) return;
    var re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi, m;
    while ((m = re.exec(text))) {
      var ref = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
      var abs; try { abs = new URL(ref, base).href; } catch (e) { continue; }
      if (!/^https?:/.test(abs)) continue;
      if (!__jb.rtHints[abs]) __jb.rtHints[abs] = "css";
      if (!__jb.rtInitiatorUrls[abs]) __jb.rtInitiatorUrls[abs] = base;
    }
    if (/@font-face/i.test(text)) fetchFontsIn(text, base);
  };
  if (typeof __jb.connected === "function") {
    var baseConnectedRT = __jb.connected;
    __jb.connected = function (node) {
      baseConnectedRT(node);
      if (!wpt() || !node || node.nodeType !== 1) return;
      // elements inserted by an external script: their requests are initiated by that script
      var su = runningScriptUrl();
      if (su && /^(script|link|img|iframe|video|audio|source|track|object|embed)$/.test(node._tag || "")) {
        var ref = node.getAttribute(node._tag === "link" ? "href" : node._tag === "object" ? "data" : "src");
        if (ref) { try { __jb.rtInitiatorUrls[new URL(ref, node.baseURI).href] = su; } catch (e) {} }
      }
      var styles = node._tag === "style" ? [node] : node.firstElementChild ? Array.prototype.slice.call(node.querySelectorAll("style")) : [];
      styles.forEach(function (st) { var t = st.textContent; if (/@font-face/i.test(t)) fetchFontsIn(t, st.baseURI); });
    };
  }
})();
