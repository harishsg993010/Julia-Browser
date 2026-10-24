// Part 12: rendering-based performance entries: Paint Timing (first-paint,
// first-contentful-paint), Largest Contentful Paint, Element Timing, Layout Instability
// (layout-shift), Long Tasks, Long Animation Frames, Event Timing (event, first-input,
// performance.eventCounts, interactionId) and visibility-state entries.
// The "mark paint timing" step runs once per frame after the animation frame callbacks
// (scheduled when the DOM changes or an image loads) and inspects the laid-out page. On real
// sites only first-paint / first-contentful-paint are computed; the full candidate scans (LCP,
// element timing, layout shifts) run for test pages, where the DOM is small.
(function () {
  if (globalThis.__jb_workerRealm || !__jb.perf || typeof PerformanceEntry !== "function") return;
  var perf = __jb.perf, TOKEN = __jb.PERF_TOKEN;
  var wpt = function () { try { return !!(__jb.wptMode || (__jb.topJb && __jb.topJb().wptMode)); } catch (e) { return !!__jb.wptMode; } };

  // ---- entry types: buffers and timeline availability ----
  ["paint", "largest-contentful-paint", "element", "layout-shift", "longtask", "long-animation-frame", "event", "first-input", "visibility-state", "container"].forEach(function (t) {
    if (!perf.buffers[t]) perf.buffers[t] = [];
    if (perf.supported.indexOf(t) < 0) perf.supported.push(t);
  });
  perf.supported.sort();
  // types not available from performance.getEntries*() (observer buffers only)
  perf.observerOnly = { "largest-contentful-paint": 1, element: 1, "layout-shift": 1, longtask: 1, "long-animation-frame": 1, event: 1, container: 1 };
  var LIMITS = { "largest-contentful-paint": 150, element: 150, "layout-shift": 150, longtask: 200, "long-animation-frame": 200, event: 150, "first-input": 1, "visibility-state": 50, paint: 2 };
  var origAll = perf.all;
  perf.all = function () { var out = []; for (var k in this.buffers) if (!this.observerOnly[k]) out = out.concat(this.buffers[k]); return out.sort(function (a, b) { return a.startTime - b.startTime; }); };
  var origAdd = perf.add;
  perf.add = function (entry) {
    var t = entry.entryType, lim = LIMITS[t];
    if (lim !== undefined && this.buffers[t] && this.buffers[t].length >= lim) {
      // the buffer is full: observers still get the entry
      var b = this.buffers[t], saved = b.slice();
      origAdd.call(this, entry);
      b.length = 0; Array.prototype.push.apply(b, saved);
      return;
    }
    if (t === "event" && entry.duration < 104) {
      // only long events are buffered; observers with a lower threshold still see it
      var b2 = this.buffers.event, saved2 = b2.slice();
      origAdd.call(this, entry);
      b2.length = 0; Array.prototype.push.apply(b2, saved2);
      return;
    }
    origAdd.call(this, entry);
  };

  var defineGetters = function (C, names) { names.forEach(function (n) { Object.defineProperty(C.prototype, n, { get: function () { return this["_" + n]; }, enumerable: true, configurable: true }); }); };
  var jsonOf = function (self_, names) { var o = PerformanceEntry.prototype.toJSON.call(self_); names.forEach(function (n) { var v = self_[n]; o[n] = v && typeof v.toJSON === "function" && !(v instanceof Node) ? v.toJSON() : v; }); return o; };
  var setFields = function (o, f) { Object.keys(f).forEach(function (k) { Object.defineProperty(o, "_" + k, { value: f[k], writable: true }); }); };
  var connectedOr = function (el) { return el && el.isConnected && __jb.currentDocument && el.ownerDocument === __jb.currentDocument ? el : null; };

  class PerformancePaintTiming extends PerformanceEntry {
    constructor(tok, name, t) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); super(name, "paint", t, 0); setFields(this, { paintTime: t, presentationTime: null }); }
    toJSON() { return jsonOf(this, ["paintTime", "presentationTime"]); }
  }
  defineGetters(PerformancePaintTiming, ["paintTime", "presentationTime"]);

  class LargestContentfulPaint extends PerformanceEntry {
    constructor(tok, f) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); super("", "largest-contentful-paint", f.renderTime || f.loadTime, 0); setFields(this, f); }
    get element() { return connectedOr(this._element); }
    toJSON() { return jsonOf(this, ["renderTime", "loadTime", "size", "id", "url", "element", "paintTime", "presentationTime"]); }
  }
  defineGetters(LargestContentfulPaint, ["renderTime", "loadTime", "size", "id", "url", "paintTime", "presentationTime"]);

  class PerformanceElementTiming extends PerformanceEntry {
    constructor(tok, name, f) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); super(name, "element", f.renderTime || f.loadTime, 0); setFields(this, f); }
    get element() { return connectedOr(this._element); }
    toJSON() { return jsonOf(this, ["renderTime", "loadTime", "intersectionRect", "identifier", "naturalWidth", "naturalHeight", "id", "element", "url", "paintTime", "presentationTime"]); }
  }
  defineGetters(PerformanceElementTiming, ["renderTime", "loadTime", "intersectionRect", "identifier", "naturalWidth", "naturalHeight", "id", "url", "paintTime", "presentationTime"]);

  class LayoutShiftAttribution {
    constructor() { throw new TypeError("Illegal constructor"); }
    get node() { return this._node && this._node.isConnected ? this._node : null; }
    get previousRect() { return this._previousRect; }
    get currentRect() { return this._currentRect; }
    toJSON() { return { node: this.node, previousRect: this._previousRect.toJSON(), currentRect: this._currentRect.toJSON() }; }
  }
  class LayoutShift extends PerformanceEntry {
    constructor(tok, t, f) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); super("layout-shift", "layout-shift", t, 0); setFields(this, f); }
    get sources() { return this._sources; }
    toJSON() { var o = jsonOf(this, ["value", "hadRecentInput", "lastInputTime"]); o.sources = this._sources.map(function (s) { return s.toJSON(); }); return o; }
  }
  defineGetters(LayoutShift, ["value", "hadRecentInput", "lastInputTime"]);

  class TaskAttributionTiming extends PerformanceEntry {
    constructor(tok) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); super("unknown", "taskattribution", 0, 0); setFields(this, { containerType: "window", containerSrc: "", containerId: "", containerName: "" }); }
    toJSON() { return jsonOf(this, ["containerType", "containerSrc", "containerId", "containerName"]); }
  }
  defineGetters(TaskAttributionTiming, ["containerType", "containerSrc", "containerId", "containerName"]);
  class PerformanceLongTaskTiming extends PerformanceEntry {
    constructor(tok, start, dur, attribution) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); super("self", "longtask", start, dur); setFields(this, { attribution: Object.freeze(attribution) }); }
    toJSON() { var o = PerformanceEntry.prototype.toJSON.call(this); o.attribution = this._attribution.map(function (a) { return a.toJSON(); }); return o; }
  }
  defineGetters(PerformanceLongTaskTiming, ["attribution"]);

  class PerformanceScriptTiming extends PerformanceEntry {
    constructor(tok, f) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); super(f.name, "script", f.startTime, f.duration); setFields(this, f); }
    get window() { return globalThis; }
    toJSON() { return jsonOf(this, ["invokerType", "invoker", "executionStart", "sourceURL", "sourceFunctionName", "sourceCharPosition", "pauseDuration", "forcedStyleAndLayoutDuration", "windowAttribution"]); }
  }
  defineGetters(PerformanceScriptTiming, ["invokerType", "invoker", "executionStart", "sourceURL", "sourceFunctionName", "sourceCharPosition", "pauseDuration", "forcedStyleAndLayoutDuration", "forcedLayoutDuration", "windowAttribution"]);
  class PerformanceLongAnimationFrameTiming extends PerformanceEntry {
    constructor(tok, start, dur, f) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); super("long-animation-frame", "long-animation-frame", start, dur); setFields(this, f); }
    toJSON() { var o = jsonOf(this, ["renderStart", "styleAndLayoutStart", "firstUIEventTimestamp", "blockingDuration", "paintTime", "presentationTime"]); o.scripts = this._scripts.map(function (s) { return s.toJSON(); }); return o; }
  }
  defineGetters(PerformanceLongAnimationFrameTiming, ["renderStart", "styleAndLayoutStart", "firstUIEventTimestamp", "blockingDuration", "scripts", "paintTime", "presentationTime", "styleDuration", "layoutDuration"]);

  class PerformanceEventTiming extends PerformanceEntry {
    constructor(tok, type, entryType, f) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); super(type, entryType, f.startTime, f.duration); setFields(this, f); }
    get target() { return this._target && this._target.isConnected ? this._target : null; }
    toJSON() { return jsonOf(this, ["processingStart", "processingEnd", "cancelable", "interactionId"]); }
  }
  defineGetters(PerformanceEventTiming, ["processingStart", "processingEnd", "cancelable", "interactionId"]);

  class PerformanceContainerTiming extends PerformanceEntry {
    constructor(tok, t, f) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); super("", "container", t, 0); setFields(this, f); }
    get lastPaintedElement() { return connectedOr(this._lastPaintedElement); }
    get rootElement() { return connectedOr(this._rootElement); }
    toJSON() { return jsonOf(this, ["identifier", "intersectionRect", "size", "firstRenderTime", "lastPaintedElement", "rootElement", "paintTime", "presentationTime"]); }
  }
  defineGetters(PerformanceContainerTiming, ["identifier", "intersectionRect", "size", "firstRenderTime", "paintTime", "presentationTime"]);
  class VisibilityStateEntry extends PerformanceEntry {
    constructor(tok, name, t) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); super(name, "visibility-state", t, 0); }
  }

  // ---------------------------------------------------------------- frame scheduling
  // Scans start when the page asks for paint-based entries (an observer or a timeline read of
  // those types): a frame scan lays the page out, which is too costly to do on every mutation.
  var P = __jb.paint = { active: false, scheduled: false, fp: false, fcp: false, painted: new WeakMap(), lcpSize: 0, lcpStopped: false, lastRects: null, lastInput: -Infinity, pendingEvents: [], longTasks: [] };
  var pending = function () { return P.scheduled && __jb.timers.some(function (t) { return t.id === P.timerId; }); };
  var schedule = P.schedule = function () {
    if (pending()) return; // (a document load drops the timers of the previous page)
    if (!P.active && !P.pendingEvents.length && !P.longTasks.length) return;
    if (P.fcp && !wpt() && !P.pendingEvents.length && !P.longTasks.length) return;
    P.scheduled = true;
    P.timerId = (__jb.frameTimeout || setTimeout)(function () {
      P.scheduled = false;
      P.ownTask = true; // not a page task: no long task entry for the scan itself
      // the scan's own layout bookkeeping (layout ids) must not schedule another frame
      P.inScan = true;
      try { markPaintTiming(); } catch (e) { if (__jb.reportException) __jb.reportException(e); } finally { P.inScan = false; }
    }, (__jb.untilNextFrame ? __jb.untilNextFrame() : 16) + 0.4);
  };
  // DOM mutations bump __jb.domVersion: watch it to schedule the next paint check
  (function () {
    var v = __jb.domVersion || 0;
    try {
      Object.defineProperty(__jb, "domVersion", { get: function () { return v; }, set: function (x) { v = x; if (P.active && !P.inScan && (!P.scheduled || !pending())) schedule(); }, enumerable: true, configurable: true });
    } catch (e) {}
  })();

  // ---------------------------------------------------------------- candidates
  var SKIP = { script: 1, style: 1, title: 1, head: 1, template: 1, noscript: 1, meta: 1, link: 1, base: 1, iframe: 1, frame: 1, object: 1, embed: 1 };
  var vw = function () { return globalThis.innerWidth || 1280; }, vh = function () { return globalThis.innerHeight || 720; };
  var clip = function (r) {
    var x1 = Math.max(0, r.left), y1 = Math.max(0, r.top), x2 = Math.min(vw(), r.right), y2 = Math.min(vh(), r.bottom);
    return x2 > x1 && y2 > y1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
  };
  var styleOf = function (el) { try { return getComputedStyle(el); } catch (e) { return null; } };
  var hiddenByStyle = function (el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var cs = styleOf(n);
      if (!cs) continue;
      if (cs.display === "none") return true;
      if (n === el && (cs.visibility === "hidden" || cs.visibility === "collapse")) return true;
      if (cs.opacity !== "" && Number(cs.opacity) === 0) return true;
    }
    return false;
  };
  var transparentText = function (el) {
    var cs = styleOf(el);
    if (!cs) return false;
    var c = String(cs.color).replace(/\s+/g, "");
    var t = c === "transparent" || /^rgba\([^)]*,0\)$/.test(c) || /^rgb\([^)]*\/0\)$/.test(c);
    if (!t) return false;
    if (cs.textShadow && cs.textShadow !== "none") return false;
    if (cs.webkitTextStrokeWidth && parseFloat(cs.webkitTextStrokeWidth) > 0) return false;
    return true;
  };
  var textRect = function (el) {
    var r = null;
    try {
      var range = document.createRange();
      var first = null, last = null;
      for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && /\S/.test(c.data)) { if (!first) first = c; last = c; }
      if (first) { range.setStart(first, 0); range.setEnd(last, last.data.length); var rr = range.getBoundingClientRect(); if (rr && rr.width > 0 && rr.height > 0) r = rr; }
    } catch (e) {}
    if (!r) { try { r = el.getBoundingClientRect(); } catch (e) {} }
    return r;
  };
  var bgUrl = function (el) {
    var cs = styleOf(el);
    var bi = cs && cs.backgroundImage;
    if (!bi || bi === "none") return null;
    var m = /url\(\s*["']?([^"')]*)["']?\s*\)/.exec(bi);
    return m ? new URL(m[1], document.baseURI).href : null;
  };
  var hasDirectText = function (el, full) {
    for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && /\S/.test(c.data)) return true;
    if (!full) return false; // real pages: generated content is not worth a pseudo-element cascade per element
    try { var bc = getComputedStyle(el, "::before").content, ac = getComputedStyle(el, "::after").content; if ((bc && bc !== "none" && bc !== "normal" && bc !== '""') || (ac && ac !== "none" && ac !== "normal" && ac !== '""')) return true; } catch (e) {}
    return false;
  };
  // real pages: a background image only from the style attribute (no cascade per element)
  var inlineBgUrl = function (el) {
    var s = el.getAttribute && el.getAttribute("style");
    if (!s || s.indexOf("url(") < 0) return null;
    var m = /background(?:-image)?\s*:[^;]*url\(\s*["']?([^"')]*)["']?\s*\)/i.exec(s);
    try { return m ? new URL(m[1], document.baseURI).href : null; } catch (e) { return null; }
  };
  var collect = function (doc, full) {
    var out = [];
    var walk = function (root) {
      for (var el = root.firstElementChild; el; el = el.nextElementSibling) {
        if (!full && out.length >= 60) return; // markPaintTiming checks at most 60 on real pages
        var t = el.localName;
        if (SKIP[t] && el.namespaceURI === "http://www.w3.org/1999/xhtml") continue;
        if (t === "img" || (t === "input" && /^image$/i.test(el.type))) {
          if (el.complete && el.naturalWidth > 0) out.push({ el: el, kind: "image", url: el.currentSrc || el.src || "" });
        } else if (t === "image" && el.namespaceURI === "http://www.w3.org/2000/svg") {
          var href = el.getAttribute("href") || el.getAttributeNS("http://www.w3.org/1999/xlink", "href");
          if (href) out.push({ el: el, kind: "image", url: new URL(href, document.baseURI).href });
        } else if (t === "video" && el.getAttribute("poster")) {
          out.push({ el: el, kind: "image", url: new URL(el.getAttribute("poster"), document.baseURI).href });
        } else if (t === "canvas" && !full) {
          if (el._drawn || el.__drawn) out.push({ el: el, kind: "canvas", url: "" });
        }
        if ((t === "input" && !/^(hidden|checkbox|radio|range|color|file|image|submit|reset|button)$/i.test(el.type || "") && /\S/.test(el.value)) || (t === "textarea" && /\S/.test(el.value))) out.push({ el: el, kind: "text", url: "", control: true });
        var bg = full ? bgUrl(el) : !P.fcp ? inlineBgUrl(el) : null;
        if (bg && t !== "html" && t !== "body") out.push({ el: el, kind: "image", url: bg, bg: true });
        if (hasDirectText(el, full)) out.push({ el: el, kind: "text", url: "" });
        if (el.shadowRoot) walk(el.shadowRoot);
        walk(el);
      }
    };
    walk(doc);
    return out;
  };
  var urlKey = function (c) { return c.kind + "|" + c.url; };

  // ---------------------------------------------------------------- mark paint timing
  var markPaintTiming = function () {
    if (P.beforeFrame) P.beforeFrame();
    var doc = __jb.currentDocument;
    if (!doc || !doc.documentElement) return;
    var now = performance.now();
    var full = wpt();
    // event timing: entries whose next paint is this frame
    if (P.pendingEvents.length) flushEvents(now);
    if (P.longTasks.length) flushLongTasks(now);
    if (!P.active || (P.fcp && !full)) return;
    // Real pages: a scan walks the whole document; stop looking after a few frames without a
    // contentful paint (each DOM change would schedule another full scan).
    if (!full && (P.realScans = (P.realScans || 0) + 1) > 6) { P.fcp = true; return; }
    var scanStart = performance.now();
    var cands = collect(doc, full);
    var newPaint = [];
    var checked = 0;
    cands.forEach(function (c) {
      if (!full && newPaint.length) return; // real pages: the first contentful paint is enough
      if (!full && ++checked > 60) return; // real pages: each check costs a style cascade and a layout read
      var set = P.painted.get(c.el);
      if (set && set[urlKey(c)]) return;
      if (hiddenByStyle(c.el)) return;
      if (c.kind === "text" && transparentText(c.el)) return;
      var r = c.kind === "text" && !c.control ? textRect(c.el) : c.el.getBoundingClientRect();
      if (!r || !(r.width > 0) || !(r.height > 0)) return;
      var vis = clip(r);
      if (!vis) return;
      if (!set) { set = {}; P.painted.set(c.el, set); }
      set[urlKey(c)] = 1;
      newPaint.push({ c: c, rect: r, vis: vis });
    });
    if (!P.fp && (newPaint.length || hasNonDefaultPaint(doc))) {
      P.fp = true;
      perf.add(new PerformancePaintTiming(TOKEN, "first-paint", now));
    }
    if (!P.fcp && newPaint.length) {
      P.fcp = true;
      perf.add(new PerformancePaintTiming(TOKEN, "first-contentful-paint", now));
    }
    // real pages: a slow scan is not repeated after the next DOM change
    if (!full && !P.fcp && performance.now() - scanStart > 250) P.fcp = true;
    if (!full) return;
    if (P.afterPaint) { try { P.afterPaint(newPaint, now); } catch (e) {} }
    newPaint.forEach(function (p) {
      var c = p.c, el = c.el;
      var loadTime = c.kind === "image" ? (el._jbLoadTime || el._loadTime || (P.bgLoad && P.bgLoad[c.url]) || now) : 0;
      if (loadTime > now) loadTime = now;
      var url = c.url && /^data:/.test(c.url) ? c.url.slice(0, 100) : c.url;
      // element timing
      var etKey = "_jbEt|" + c.kind + "|" + (c.url || "");
      if (el.hasAttribute && el.hasAttribute("elementtiming") && c.kind !== "canvas" && !(el._jbEtSeen && el._jbEtSeen[etKey])) {
        if (!el._jbEtSeen) { try { Object.defineProperty(el, "_jbEtSeen", { value: {}, writable: true }); } catch (e) {} }
        if (el._jbEtSeen) el._jbEtSeen[etKey] = 1;
        var nw = 0, nh = 0;
        if (c.kind === "image" && !c.bg && el.naturalWidth !== undefined) { nw = el.naturalWidth; nh = el.naturalHeight; }
        perf.add(new PerformanceElementTiming(TOKEN, c.kind === "text" ? "text-paint" : "image-paint", {
          renderTime: now, loadTime: c.kind === "text" ? 0 : loadTime, intersectionRect: new DOMRectReadOnly(p.vis.x, p.vis.y, p.vis.w, p.vis.h),
          identifier: el.getAttribute("elementtiming"), naturalWidth: nw, naturalHeight: nh, id: el.id || "", element: el, url: c.kind === "text" ? "" : url, paintTime: now, presentationTime: null,
        }));
      }
      // largest contentful paint
      if (P.lcpStopped || c.kind === "canvas") return;
      var size = p.vis.w * p.vis.h;
      if (c.kind === "image") {
        var full_vp = p.vis.w >= vw() && p.vis.h >= vh();
        if (c.bg && full_vp && (el.localName === "body" || el.localName === "html")) return;
        var nat = !c.bg && el.naturalWidth ? el.naturalWidth * el.naturalHeight : 0;
        var disp = p.rect.width * p.rect.height;
        if (nat && disp > 0 && nat < disp) size = size * nat / disp;
      }
      size = Math.round(size);
      if (size <= P.lcpSize) return;
      P.lcpSize = size;
      perf.add(new LargestContentfulPaint(TOKEN, { renderTime: now, loadTime: loadTime, size: size, id: el.id || "", url: c.kind === "text" ? "" : url, element: el, paintTime: now, presentationTime: null }));
    });
    containerTiming(newPaint, now);
    detectLayoutShift(doc, now);
  };
  // Container Timing: paints inside an element with containertiming (not under containertimingignore)
  var ctState = new WeakMap();
  var containerTiming = function (newPaint, now) {
    var perRoot = new Map();
    newPaint.forEach(function (p) {
      var ignored = false;
      for (var n = p.c.el; n && n.nodeType === 1; n = n.parentElement) {
        if (n.hasAttribute("containertiming")) { if (!ignored || n === p.c.el) { var l = perRoot.get(n) || []; l.push(p); perRoot.set(n, l); } break; }
        if (n.hasAttribute("containertimingignore")) ignored = true;
      }
    });
    perRoot.forEach(function (paints, root) {
      var st = ctState.get(root);
      if (!st) { st = { rects: [], first: now, size: 0 }; ctState.set(root, st); }
      var last = null, lastArea = -1;
      paints.forEach(function (p) { st.rects.push(p.vis); var a = p.vis.w * p.vis.h; if (a > lastArea) { lastArea = a; last = p.c.el; } });
      var size = Math.round(rectArea(st.rects));
      if (size <= st.size) return;
      st.size = size;
      var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
      st.rects.forEach(function (q) { l = Math.min(l, q.x); t = Math.min(t, q.y); r = Math.max(r, q.x + q.w); b = Math.max(b, q.y + q.h); });
      perf.add(new PerformanceContainerTiming(TOKEN, now, { identifier: root.getAttribute("containertiming"), intersectionRect: new DOMRectReadOnly(l, t, r - l, b - t), size: size, firstRenderTime: st.first, lastPaintedElement: last, rootElement: root, paintTime: now, presentationTime: null }));
    });
  };
  P.mark = function () { return markPaintTiming(); };
  var hasNonDefaultPaint = function (doc) {
    var body = doc.body;
    if (!body) return false;
    var els = body.querySelectorAll("*");
    for (var i = 0; i < els.length && i < 500; i++) {
      var cs = styleOf(els[i]);
      if (!cs || cs.display === "none") continue;
      var bg = String(cs.backgroundColor).replace(/\s+/g, "");
      if (bg && bg !== "transparent" && !/,0\)$/.test(bg)) { var r = els[i].getBoundingClientRect(); if (r.width > 0 && r.height > 0 && clip(r)) return true; }
    }
    return false;
  };

  // ---------------------------------------------------------------- layout shifts
  var rectArea = function (rects) {
    // area of the union of axis-aligned rectangles (coordinate compression)
    if (!rects.length) return 0;
    var xs = [], ys = [];
    rects.forEach(function (r) { xs.push(r.x, r.x + r.w); ys.push(r.y, r.y + r.h); });
    xs = __jb.arrayFrom(new Set(xs)).sort(function (a, b) { return a - b; }); ys = __jb.arrayFrom(new Set(ys)).sort(function (a, b) { return a - b; });
    var area = 0;
    for (var i = 0; i + 1 < xs.length; i++) for (var j = 0; j + 1 < ys.length; j++) {
      var cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
      for (var k = 0; k < rects.length; k++) { var r = rects[k]; if (cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h) { area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]); break; } }
    }
    return area;
  };
  var detectLayoutShift = function (doc, now) {
    if (!doc.body) return;
    var cur = new Map(), els = doc.body.querySelectorAll("*");
    if (els.length > 3000) { P.lastRects = null; return; }
    var sx = globalThis.scrollX || 0, sy = globalThis.scrollY || 0;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var r = el.getBoundingClientRect();
      if (!(r.width > 0 || r.height > 0)) continue;
      cur.set(el, { x: r.left + sx, y: r.top + sy, w: r.width, h: r.height, vx: r.left, vy: r.top });
    }
    var prev = P.lastRects;
    P.lastRects = cur;
    if (!prev) return;
    var impacted = [], maxDist = 0, sources = [];
    cur.forEach(function (c, el) {
      var p = prev.get(el);
      if (!p) return;
      var dx = c.x - p.x, dy = c.y - p.y;
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return; // shifts below 3px are ignored
      // an element whose parent moved by the same amount is not separately unstable
      var par = el.parentElement, pc = par && cur.get(par), pp = par && prev.get(par);
      var inherited = pc && pp && Math.abs((pc.x - pp.x) - dx) < 1 && Math.abs((pc.y - pp.y) - dy) < 1;
      var pv = clip({ left: p.vx, top: p.vy, right: p.vx + p.w, bottom: p.vy + p.h }), cv = clip({ left: c.vx, top: c.vy, right: c.vx + c.w, bottom: c.vy + c.h });
      if (!pv && !cv) return;
      if (pv) impacted.push(pv);
      if (cv) impacted.push(cv);
      maxDist = Math.max(maxDist, Math.abs(dx), Math.abs(dy));
      if (!inherited) sources.push({ el: el, prev: p, cur: c, area: (pv ? pv.w * pv.h : 0) + (cv ? cv.w * cv.h : 0) });
    });
    if (!impacted.length) return;
    var vpArea = vw() * vh(), maxDim = Math.max(vw(), vh());
    var value = (rectArea(impacted) / vpArea) * Math.min(1, maxDist / maxDim);
    if (!(value > 0)) return;
    sources.sort(function (a, b) { return b.area - a.area; });
    var attr = sources.slice(0, 5).map(function (s) {
      var a = Object.create(LayoutShiftAttribution.prototype);
      setFields(a, { node: s.el, previousRect: new DOMRectReadOnly(s.prev.vx, s.prev.vy, s.prev.w, s.prev.h), currentRect: new DOMRectReadOnly(s.cur.vx, s.cur.vy, s.cur.w, s.cur.h) });
      return a;
    });
    var had = now - P.lastInput < 500;
    perf.add(new LayoutShift(TOKEN, now, { value: value, hadRecentInput: had, lastInputTime: P.lastInput === -Infinity ? 0 : P.lastInput, sources: Object.freeze(attr) }));
  };

  // ---------------------------------------------------------------- long tasks / long animation frames
  var origRun = __jb.runOneTimer;
  __jb.runOneTimer = function (limit) {
    var t0 = performance.now();
    P.ownTask = false;
    var ran = origRun.apply(this, arguments);
    var own = P.ownTask;
    P.ownTask = false;
    if (ran && !own) {
      var t1 = performance.now();
      // long tasks are reported for pages that observe them (or read the timeline)
      if (t1 - t0 > 50 && (P.active || wpt())) { P.longTasks.push({ start: t0, end: t1 }); schedule(); }
    }
    return ran;
  };
  // ---- script attribution (Long Animation Frames): callbacks of 5 ms or more ----
  P.scripts = [];
  var loafStack = [];
  __jb.loafRun = function (type, invoker, fn, self, args, src) {
    if (!__jb.loafOn) return fn.apply(self, args);
    var rec = { type: type, invoker: invoker, start: performance.now(), child: false, src: src || "" };
    if (loafStack.length) loafStack[loafStack.length - 1].child = true;
    loafStack.push(rec);
    try { return fn.apply(self, args); }
    finally {
      loafStack.pop();
      rec.end = performance.now();
      if (!rec.child && rec.end - rec.start >= 5) { P.scripts.push(rec); if (P.scripts.length > 200) P.scripts.splice(0, 100); }
      else if (rec.child && loafStack.length) loafStack[loafStack.length - 1].child = true;
    }
  };
  if (typeof Performance === "function" && !Performance.prototype.bind) {
    Object.defineProperty(Performance.prototype, "bind", { value: function bind(fn, thisArg) {
      if (typeof fn !== "function") throw new TypeError("Performance.bind: Argument 1 is not callable");
      var bound = Array.prototype.slice.call(arguments, 2), name = fn.name || "";
      return function () {
        var self = thisArg === undefined ? globalThis : thisArg;
        return __jb.loafRun("user-entry-point", name, fn, self, bound.concat(Array.prototype.slice.call(arguments)));
      };
    }, writable: true, enumerable: true, configurable: true });
  }
  __jb.loafRecordScript = function (type, invoker, start, end, src) {
    if (__jb.loafOn && end - start >= 5) P.scripts.push({ type: type, invoker: invoker, start: start, end: end, src: src || "" });
  };
  // event listener invoker names: TAG#id.onTYPE, TAG[src="..."].onTYPE, Interface.onTYPE
  __jb.loafTargetName = function (target, type) {
    var base = "";
    try {
      if (target && target.nodeType === 1) {
        var tag = String(target.localName || "").toUpperCase();
        if (target.id) base = tag + "#" + target.id;
        else if (target.getAttribute && target.getAttribute("src") !== null) base = tag + '[src="' + target.getAttribute("src") + '"]';
        else base = tag;
      } else if (target === globalThis) base = "Window";
      else if (target && target.nodeType === 9) base = "Document";
      else if (target) base = (target.constructor && target.constructor.name) || "Object";
    } catch (e) {}
    return base + ".on" + type;
  };
  __jb.noteLongTask = function (t0, t1, src) { if (t1 - t0 > 50 && (P.active || wpt())) { P.longTasks.push({ start: t0, end: t1, src: src }); schedule(); } };
  var flushLongTasks = function (now) {
    var tasks = P.longTasks.splice(0);
    tasks.forEach(function (t) {
      perf.add(new PerformanceLongTaskTiming(TOKEN, t.start, Math.round(t.end - t.start), [new TaskAttributionTiming(TOKEN)]));
    });
    if (!tasks.length) return;
    var start = tasks[0].start, blocking = 0, scripts = [];
    tasks.forEach(function (t) { blocking += Math.max(0, t.end - t.start - 50); });
    // the frame's attributed scripts (callbacks of 5 ms or more that ran in it)
    var recs = P.scripts.filter(function (s) { return s.end >= start - 1 && s.start <= now; });
    P.scripts = P.scripts.filter(function (s) { return recs.indexOf(s) < 0 && s.end > now; });
    recs.forEach(function (s) {
      scripts.push(new PerformanceScriptTiming(TOKEN, { name: "script", startTime: s.start, duration: s.end - s.start, invokerType: s.type, invoker: s.invoker, executionStart: s.start, sourceURL: s.src || "", sourceFunctionName: "", sourceCharPosition: -1, pauseDuration: 0, forcedStyleAndLayoutDuration: 0, forcedLayoutDuration: 0, windowAttribution: "self" }));
    });
    if (!scripts.length) tasks.forEach(function (t) {
      scripts.push(new PerformanceScriptTiming(TOKEN, { name: "script", startTime: t.start, duration: t.end - t.start, invokerType: t.src ? "classic-script" : "user-callback", invoker: t.src || "TimerHandler:setTimeout", executionStart: t.start, sourceURL: t.src || "", sourceFunctionName: "", sourceCharPosition: -1, pauseDuration: 0, forcedStyleAndLayoutDuration: 0, forcedLayoutDuration: 0, windowAttribution: "self" }));
    });
    if (now - start > 50) perf.add(new PerformanceLongAnimationFrameTiming(TOKEN, start, now - start, { renderStart: now, styleAndLayoutStart: now, firstUIEventTimestamp: 0, blockingDuration: blocking, scripts: Object.freeze(scripts), paintTime: now, presentationTime: null, styleDuration: 0, layoutDuration: 0 }));
  };

  // ---------------------------------------------------------------- event timing
  var TIMED = ("auxclick click contextmenu dblclick mousedown mouseenter mouseleave mouseout mouseover mouseup pointerover pointerenter pointerdown pointerup pointercancel pointerout pointerleave gotpointercapture lostpointercapture " +
    "touchstart touchend touchcancel keydown keypress keyup beforeinput input compositionstart compositionupdate compositionend dragstart dragend dragenter dragleave dragover drop").split(" ");
  var TIMED_SET = Object.create(null); TIMED.forEach(function (t) { TIMED_SET[t] = 1; });
  var interactionSeq = 0, pendingPointerId = 0, keyIds = {}, firstInputDone = false, pendingFirstPointer = null;
  var nextInteraction = function () { if (!interactionSeq) interactionSeq = 100 + Math.floor(Math.random() * 1000); interactionSeq += 7; return interactionSeq; };
  var counts = function () { return performance.eventCounts && performance.eventCounts._m; };
  var origDispatch = EventTarget.prototype.dispatchEvent;
  var timedDispatch = function dispatchEvent(event) {
    if (!event || !event._trustedDispatch || !TIMED_SET[event.type]) return origDispatch.apply(this, arguments);
    var type = event.type, start = event.timeStamp, target = this;
    var m = counts(); if (m) m.set(type, (m.get(type) || 0) + 1);
    if (type === "pointerdown" || type === "keydown" || type === "mousedown") { if (!P.active && !P.lcpStopped && wpt()) { try { P.activate(true); } catch (eA) {} } P.lastInput = performance.now(); P.lcpStopped = true; }
    var ps = performance.now();
    var r;
    try { r = origDispatch.apply(this, arguments); }
    finally {
      var pe = performance.now();
      var id = 0;
      if (type === "pointerdown") { pendingPointerId = nextInteraction(); id = 0; }
      else if (type === "pointerup" || type === "click") { id = pendingPointerId || nextInteraction(); if (type === "click") pendingPointerId = 0; }
      else if (type === "keydown") { id = keyIds[event.code || event.key] = nextInteraction(); }
      else if (type === "keyup") { id = keyIds[event.code || event.key] || 0; delete keyIds[event.code || event.key]; }
      var rec = { type: type, start: typeof start === "number" ? start : ps, ps: ps, pe: pe, cancelable: !!event.cancelable, target: target instanceof Node ? target : null, id: id };
      P.pendingEvents.push(rec);
      if (type === "pointerdown") { pendingFirstPointer = rec; rec.deferId = true; } // its interactionId comes with the pointerup
      if (type === "pointerup" && pendingFirstPointer) { pendingFirstPointer.id = id; pendingFirstPointer.deferId = false; }
      schedule();
    }
    return r;
  };
  EventTarget.prototype.dispatchEvent = timedDispatch;
  var flushEvents = function (now) {
    var list = P.pendingEvents.filter(function (e) { return !e.deferId || now - e.pe > 1000; });
    P.pendingEvents = P.pendingEvents.filter(function (e) { return list.indexOf(e) < 0; });
    list.forEach(function (e) {
      var dur = Math.max(0, now - e.start);
      dur = Math.round(dur / 8) * 8;
      var f = { startTime: e.start, duration: dur, processingStart: e.ps, processingEnd: e.pe, cancelable: e.cancelable, target: e.target, interactionId: e.id };
      perf.add(new PerformanceEventTiming(TOKEN, e.type, "event", f));
      if (!firstInputDone && (e.type === "keydown" || e.type === "pointerdown" || e.type === "mousedown" || e.type === "click")) {
        firstInputDone = true;
        perf.add(new PerformanceEventTiming(TOKEN, e.type, "first-input", f));
      }
    });
  };

  // ---------------------------------------------------------------- triggers and visibility
  try {
    document.addEventListener("load", function (e) { var t = e.target; if (t && t.nodeType === 1) { try { Object.defineProperty(t, "_jbLoadTime", { value: performance.now(), writable: true, configurable: true }); } catch (x) {} } if (__jb.pullResourceTimings) __jb.pullResourceTimings(); schedule(); }, true);
    document.addEventListener("error", function () { if (__jb.pullResourceTimings) __jb.pullResourceTimings(); }, true);
    document.addEventListener("scroll", function (e) { if (e.isTrusted) P.lcpStopped = true; }, true);
    document.addEventListener("visibilitychange", function () { perf.add(new VisibilityStateEntry(TOKEN, document.visibilityState, performance.now())); });
  } catch (e) {}
  perf.buffers["visibility-state"].push(new VisibilityStateEntry(TOKEN, "visible", 0));
  __jb.paintReset = function () { P.fp = P.fcp = false; P.lcpSize = 0; P.lcpStopped = false; P.lastRects = null; P.painted = new WeakMap(); };
  // background images: load times by URL (image cache answers reported by 58_images.js)
  P.bgLoad = Object.create(null);
  __jb.noteBackgroundImageLoaded = function (url) { if (!P.bgLoad[url]) P.bgLoad[url] = performance.now(); schedule(); };
  var PAINT_TYPES = P.paintTypes = { paint: 1, "largest-contentful-paint": 1, element: 1, "layout-shift": 1, container: 1, longtask: 1, "long-animation-frame": 1 };
  // sync: a timeline read wants what has been painted so far; an observer waits for the next
  // rendering update (paint never happens in the middle of a script)
  P.activate = function (sync) {
    if (P.active) return;
    P.active = true;
    if (wpt()) __jb.loafOn = true;
    if (sync) { P.inScan = true; try { markPaintTiming(); } catch (e) {} finally { P.inScan = false; } }
    schedule();
  };
  var origObserve = PerformanceObserver.prototype.observe;
  PerformanceObserver.prototype.observe = function (options) {
    try {
      var types = options && options.type !== undefined ? [String(options.type)] : options && options.entryTypes ? __jb.arrayFrom(options.entryTypes, String) : [];
      if (types.some(function (t) { return PAINT_TYPES[t]; })) P.activate();
    } catch (e) {}
    return origObserve.apply(this, arguments);
  };
  var PP = Performance.prototype, origByType = PP.getEntriesByType, origByName = PP.getEntriesByName;
  PP.getEntriesByType = function (type) { if (PAINT_TYPES[String(type)]) P.activate(true); return origByType.apply(this, arguments); };
  PP.getEntriesByName = function (name, type) { if (/^first-(contentful-)?paint$/.test(String(name)) || PAINT_TYPES[String(type)]) P.activate(true); return origByName.apply(this, arguments); };

  // Element Timing: element.elementTiming reflects the elementtiming attribute
  Object.defineProperty(Element.prototype, "elementTiming", { get: function () { var v = this.getAttribute("elementtiming"); return v === null ? "" : v; }, set: function (v) { this.setAttribute("elementtiming", String(v)); }, enumerable: true, configurable: true });
  ["containerTiming", "containertiming"].forEach(function () {});
  if (typeof HTMLElement === "function") {
    Object.defineProperty(HTMLElement.prototype, "containerTiming", { get: function () { var v = this.getAttribute("containertiming"); return v === null ? "" : v; }, set: function (v) { this.setAttribute("containertiming", String(v)); }, enumerable: true, configurable: true });
    Object.defineProperty(HTMLElement.prototype, "containerTimingIgnore", { get: function () { return this.hasAttribute("containertimingignore"); }, set: function (v) { if (v) this.setAttribute("containertimingignore", ""); else this.removeAttribute("containertimingignore"); }, enumerable: true, configurable: true });
  }
  [PerformanceContainerTiming, PerformancePaintTiming, LargestContentfulPaint, PerformanceElementTiming, LayoutShift, LayoutShiftAttribution, TaskAttributionTiming, PerformanceLongTaskTiming, PerformanceScriptTiming,
    PerformanceLongAnimationFrameTiming, PerformanceEventTiming, VisibilityStateEntry].forEach(function (C) {
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
    globalThis[C.name] = C;
  });
})();
