// Part 85: Soft Navigations (soft-navigation and interaction-contentful-paint entries,
// PerformanceEntry.navigationId). A user interaction (trusted click, keyboard activation or a
// user-initiated navigate event) opens a soft-navigation context. DOM modifications and
// same-document URL changes made while that context is current are attributed to it (the
// context stays current until the next interaction: an approximation of task attribution).
// When the URL has changed and an attributed node is contentfully painted, a
// SoftNavigationEntry is emitted (a new navigation id), and paints of attributed nodes produce
// InteractionContentfulPaint entries (their largest contentful paint so far).
(function () {
  if (globalThis.__jb_workerRealm || !__jb.perf || !__jb.paint || typeof PerformanceEntry !== "function") return;
  var perf = __jb.perf, P = __jb.paint, TOKEN = __jb.PERF_TOKEN;
  var wpt = function () { try { return !!(__jb.wptMode || (__jb.topJb && __jb.topJb().wptMode)); } catch (e) { return !!__jb.wptMode; } };
  var uuid = function () { try { return crypto.randomUUID(); } catch (e) { return "nav-" + Math.random().toString(36).slice(2); } };

  // ---- navigationId on every entry ----
  perf.navigationId = uuid();
  var hardNavId = perf.navigationId;
  var origAdd = perf.add;
  perf.add = function (entry) {
    if (entry && !Object.prototype.hasOwnProperty.call(entry, "_navigationId")) { try { Object.defineProperty(entry, "_navigationId", { value: perf.navigationId, writable: true }); } catch (e) {} }
    return origAdd.apply(this, arguments);
  };
  Object.defineProperty(PerformanceEntry.prototype, "navigationId", { get: function () { return this._navigationId !== undefined ? this._navigationId : hardNavId; }, enumerable: true, configurable: true });

  // ---- entry classes ----
  var setFields = function (o, f) { Object.keys(f).forEach(function (k) { Object.defineProperty(o, "_" + k, { value: f[k], writable: true }); }); };
  class SoftNavigationEntry extends PerformanceEntry {
    constructor(tok, name, start, f) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); super(name, "soft-navigation", start, 0); setFields(this, f); Object.defineProperty(this, "_navigationId", { value: f.navigationId, writable: true }); }
    get interactionId() { return this._interactionId; }
    get navigationType() { return this._navigationType; }
    getLargestInteractionContentfulPaint() { return this._largestIcp || null; }
    get paintTime() { return this._paintTime; }
    get presentationTime() { return this._presentationTime; }
    toJSON() { var o = PerformanceEntry.prototype.toJSON.call(this); o.navigationId = this.navigationId; o.interactionId = this._interactionId; o.paintTime = this._paintTime; o.presentationTime = this._presentationTime; return o; }
  }
  class InteractionContentfulPaint extends PerformanceEntry {
    constructor(tok, start, f) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); super("", "interaction-contentful-paint", start, 0); setFields(this, f); Object.defineProperty(this, "_navigationId", { value: f.navigationId, writable: true }); }
    get largestContentfulPaint() { return this._largestContentfulPaint; }
    get interactionId() { return this._interactionId; }
    toJSON() { var o = PerformanceEntry.prototype.toJSON.call(this); o.navigationId = this.navigationId; o.interactionId = this._interactionId; o.largestContentfulPaint = this._largestContentfulPaint && this._largestContentfulPaint.toJSON ? this._largestContentfulPaint.toJSON() : null; return o; }
  }
  [SoftNavigationEntry, InteractionContentfulPaint].forEach(function (C) {
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
    globalThis[C.name] = C;
  });
  ["soft-navigation", "interaction-contentful-paint"].forEach(function (t) {
    if (!perf.buffers[t]) perf.buffers[t] = [];
    if (perf.supported.indexOf(t) < 0) perf.supported.push(t);
  });
  perf.supported.sort();
  if (perf.observerOnly) perf.observerOnly["interaction-contentful-paint"] = 1;
  if (P.paintTypes) { P.paintTypes["soft-navigation"] = 1; P.paintTypes["interaction-contentful-paint"] = 1; }
  // the soft-navigation buffer keeps 50 entries
  var addWithLimit = perf.add;
  perf.add = function (entry) {
    if (entry && entry.entryType === "soft-navigation" && this.buffers["soft-navigation"].length >= 50) {
      this.dropped = this.dropped || {};
      this.dropped["soft-navigation"] = (this.dropped["soft-navigation"] || 0) + 1;
      var b = this.buffers["soft-navigation"], saved = b.slice();
      var r = addWithLimit.apply(this, arguments);
      this.buffers["soft-navigation"] = saved;
      return r;
    }
    return addWithLimit.apply(this, arguments);
  };

  // ---- contexts ----
  var S = __jb.softNav = { ctx: null, seq: 0, list: [] };
  var newContext = function (event) {
    if (!wpt()) return;
    var start = event && typeof event.timeStamp === "number" ? event.timeStamp : performance.now();
    S.ctx = { id: ++S.seq, start: start, startUrl: String(location.href), urlChanged: false, url: null, nodes: new Set(), emitted: false, navId: null, icpSize: 0, interactionId: 0 };
    // (only the latest interaction is attributed: no task attribution to tell them apart)
    S.list = [];
    S.list.push(S.ctx);
    if (!P.active && P.activate) P.activate();
  };
  // interactions: trusted click / keydown (Enter, Space) / navigate events (user-initiated)
  var origDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function dispatchEvent(event) {
    try {
      if (event && event._trustedDispatch) {
        var t = event.type;
        if (t === "click" || (t === "keydown" && /^(Enter| |Spacebar)$/.test(event.key || ""))) newContext(event);
      }
    } catch (e) {}
    return origDispatch.apply(this, arguments);
  };
  if (typeof globalThis.navigation === "object" && globalThis.navigation && typeof globalThis.navigation.addEventListener === "function") {
    try {
      globalThis.navigation.addEventListener("navigate", function (e) { if (e.userInitiated && (!S.ctx || S.ctx.emitted)) newContext(e); }, true);
    } catch (e) {}
  }
  // URL changes made in the context
  // only the first URL change of the interaction (and its type) counts
  var noteUrl = function (type) {
    var c = S.ctx;
    if (c && !c.emitted && !c.urlChanged) {
      c.urlChanged = true; c.url = String(location.href); c.navType = type;
      // the attributed content was painted before the URL changed: the soft navigation is
      // reported at the next frame
      if (c.paintedAt !== undefined && P.schedule) { if (!P.active && P.activate) P.activate(); P.schedule(); }
    }
  };
  ["pushState", "replaceState"].forEach(function (m) {
    var orig = History.prototype[m];
    if (typeof orig !== "function") return;
    History.prototype[m] = function () { var r = orig.apply(this, arguments); noteUrl(m === "pushState" ? "push" : "replace"); return r; };
  });
  try { globalThis.addEventListener("hashchange", function () { noteUrl("push"); }, true); } catch (e) {}
  try { globalThis.addEventListener("popstate", function () { noteUrl("traverse"); }, true); } catch (e) {}
  try {
    if (globalThis.navigation && typeof globalThis.navigation.addEventListener === "function") globalThis.navigation.addEventListener("navigate", function (e) {
      var t = e.navigationType; if (t === "reload") return;
      setTimeout(function () { var c = S.ctx; if (c && !c.emitted && !c.urlChanged && String(location.href) !== c.startUrl) { c.urlChanged = true; c.url = String(location.href); c.navType = t === "traverse" ? "traverse" : t === "replace" ? "replace" : "push"; } }, 0);
    }, true);
  } catch (e) {}
  // DOM modifications made in the context
  var origQueue = __jb.queueMutationRecord;
  __jb.queueMutationRecord = function (type, target, opts) {
    var live = S.list.length ? S.list : (S.ctx ? [S.ctx] : []);
    if (live.length && wpt()) live.forEach(function (c) {
      try {
        if (type === "childList") {
          (opts && opts.addedNodes || []).forEach(function (n) { c.nodes.add(n.nodeType === 3 && target.nodeType === 1 ? target : n); invalidate(n); });
        } else if (target) {
          var el = target.nodeType === 1 ? target : target.parentNode;
          if (el) { c.nodes.add(el); invalidate(el); }
        }
      } catch (e) {}
    });
    return origQueue.apply(this, arguments);
  };
  // modified nodes paint again (and so do their descendants)
  var invalidate = function (n) {
    try {
      if (!n) return;
      if (n.nodeType === 3) n = n.parentNode;
      if (!n || n.nodeType !== 1) return;
      P.painted.delete(n);
      var all = n.querySelectorAll ? n.querySelectorAll("*") : [];
      for (var i = 0; i < all.length && i < 2000; i++) P.painted.delete(all[i]);
    } catch (e) {}
  };
  var attributed = function (c, el) {
    for (var n = el; n; n = n.parentNode || (n.host || null)) if (c.nodes.has(n)) return true;
    return false;
  };

  // ---- at each paint ----
  P.afterPaint = function (newPaint, now) {
    if (!wpt()) return;
    (S.list.length ? S.list.slice() : S.ctx ? [S.ctx] : []).forEach(function (c) { processContext(c, newPaint, now); });
  };
  var processContext = function (c, newPaint, now) {
    if (!c.urlChanged && String(location.href) !== c.startUrl) { c.urlChanged = true; c.url = String(location.href); c.navType = c.navType || "push"; }
    var mine = newPaint.filter(function (p) { return attributed(c, p.c.el); });
    if (!mine.length) {
      if (!c.emitted && c.urlChanged && c.paintedAt !== undefined) {
        c.emitted = true;
        c.navId = uuid();
        perf.navigationId = c.navId;
        c.entry = new SoftNavigationEntry(TOKEN, c.url || String(location.href), c.start, { navigationId: c.navId, interactionId: c.interactionId, paintTime: c.paintedAt, presentationTime: null, navigationType: c.navType || "push" });
        if (c.lastIcp) { try { Object.defineProperty(c.entry, "_largestIcp", { value: c.lastIcp, writable: true, configurable: true }); } catch (e) {} }
        perf.add(c.entry);
      }
      return;
    }
    if (c.paintedAt === undefined) c.paintedAt = now;
    var softEntry = null;
    if (!c.emitted && c.urlChanged) {
      c.emitted = true;
      c.navId = uuid();
      perf.navigationId = c.navId;
      softEntry = c.entry = new SoftNavigationEntry(TOKEN, c.url || String(location.href), c.start, { navigationId: c.navId, interactionId: c.interactionId, paintTime: now, presentationTime: null, navigationType: c.navType || "push" });
    }
    // interaction-contentful-paint: the largest attributed paint so far
    var best = null, bestSize = 0;
    mine.forEach(function (p) {
      var size = p.vis.w * p.vis.h, el = p.c.el;
      if (p.c.kind === "image") {
        var nat = !p.c.bg && el.naturalWidth ? el.naturalWidth * el.naturalHeight : 0, disp = p.rect.width * p.rect.height;
        if (nat && disp > 0 && nat < disp) size = size * nat / disp;
      }
      size = Math.round(size);
      if (size > bestSize) { bestSize = size; best = p; }
    });
    if (!best || bestSize <= c.icpSize) { if (softEntry) perf.add(softEntry); return; }
    c.icpSize = bestSize;
    var el = best.c.el, kind = best.c.kind;
    // text aggregates to its nearest block-level ancestor
    if (kind === "text") {
      for (var ag = el; ag && ag.nodeType === 1; ag = ag.parentElement) {
        var dsp = ""; try { dsp = getComputedStyle(ag).display; } catch (eD) {}
        if (!/^(inline|contents)$/.test(dsp || "")) { el = ag; break; }
      }
    }
    var url = kind === "text" ? "" : (best.c.url && /^data:/.test(best.c.url) ? best.c.url.slice(0, 100) : best.c.url);
    var loadTime = kind === "image" ? (el._jbLoadTime || now) : 0;
    if (loadTime > now) loadTime = now;
    var lcp = typeof LargestContentfulPaint === "function" ? new LargestContentfulPaint(TOKEN, { renderTime: now, loadTime: loadTime, size: bestSize, id: el.id || "", url: url, element: el, paintTime: now, presentationTime: null }) : null;
    if (lcp) { try { Object.defineProperty(lcp, "_navigationId", { value: c.navId || perf.navigationId, writable: true }); } catch (e) {} }
    var icp = new InteractionContentfulPaint(TOKEN, now, { navigationId: c.navId || perf.navigationId, interactionId: c.interactionId, largestContentfulPaint: lcp });
    c.lastIcp = icp;
    if (c.entry) { try { Object.defineProperty(c.entry, "_largestIcp", { value: icp, writable: true, configurable: true }); } catch (e) {} }
    if (softEntry) perf.add(softEntry);
    perf.add(icp);
  };
})();
