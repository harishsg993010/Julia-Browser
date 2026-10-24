// Part 17: smaller CSS object models: the CSS Custom Highlight API (Highlight,
// HighlightRegistry at CSS.highlights), CSSPseudoElement (element.pseudo()) and View
// Transitions (document/element.startViewTransition, ViewTransition, ViewTransitionTypeSet).
(function () {
  if (globalThis.__jb_workerRealm || typeof CSS === "undefined") return;
  var dom = function (n, m) { return __jb.domError(n, m); };
  var TOKEN = {};
  var setlikeProto = function (proto, key) {
    proto.has = function (v) { return this[key].has(v); };
    proto.forEach = function (cb, thisArg) { var self = this; this[key].forEach(function (v) { cb.call(thisArg, v, v, self); }); };
    proto.entries = function () { return this[key].entries(); };
    proto.keys = function () { return this[key].values(); };
    proto.values = function () { return this[key].values(); };
    proto[Symbol.iterator] = proto.values;
    Object.defineProperty(proto, "size", { get: function () { return this[key].size; }, enumerable: true, configurable: true });
  };

  // ---------------------------------------------------------------- Custom Highlight API
  var TYPES = ["highlight", "spelling-error", "grammar-error"];
  var isRange = function (r) { return typeof AbstractRange === "function" ? r instanceof AbstractRange : (r instanceof Range || (typeof StaticRange === "function" && r instanceof StaticRange)); };
  class Highlight {
    constructor() {
      var set = new Set();
      Array.prototype.forEach.call(arguments, function (r) { if (!isRange(r)) throw new TypeError("Highlight: argument is not an AbstractRange"); set.add(r); });
      Object.defineProperty(this, "_set", { value: set });
      Object.defineProperty(this, "_prio", { value: 0, writable: true });
      Object.defineProperty(this, "_type", { value: "highlight", writable: true });
    }
    get priority() { return this._prio; }
    set priority(v) { this._prio = __jb.toInt32 ? __jb.toInt32(v) : (Number(v) | 0); }
    get type() { return this._type; }
    set type(v) { v = String(v); if (TYPES.indexOf(v) >= 0) this._type = v; }
    add(r) { if (!isRange(r)) throw new TypeError("Highlight.add: argument is not an AbstractRange"); this._set.add(r); __jb.domVersion++; return this; }
    delete(r) { var d = this._set.delete(r); if (d) __jb.domVersion++; return d; }
    clear() { this._set.clear(); __jb.domVersion++; }
  }
  setlikeProto(Highlight.prototype, "_set");
  class HighlightRegistry {
    constructor(tok) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); Object.defineProperty(this, "_map", { value: new Map() }); }
    get(k) { return this._map.get(String(k)); }
    has(k) { return this._map.has(String(k)); }
    set(k, v) { if (!(v instanceof Highlight)) throw new TypeError("HighlightRegistry.set: value is not a Highlight"); this._map.set(String(k), v); __jb.domVersion++; return this; }
    delete(k) { var d = this._map.delete(String(k)); if (d) __jb.domVersion++; return d; }
    clear() { this._map.clear(); __jb.domVersion++; }
    get size() { return this._map.size; }
    forEach(cb, thisArg) { var self = this; this._map.forEach(function (v, k) { cb.call(thisArg, v, k, self); }); }
    entries() { return this._map.entries(); } keys() { return this._map.keys(); } values() { return this._map.values(); }
    highlightsFromPoint(x, y, options) {
      if (arguments.length < 2) throw new TypeError("HighlightRegistry.highlightsFromPoint: 2 arguments required");
      x = Number(x); y = Number(y);
      if (!isFinite(x) || !isFinite(y)) throw new TypeError("HighlightRegistry.highlightsFromPoint: coordinates must be finite");
      var out = [];
      this._map.forEach(function (h) {
        var hits = [];
        h._set.forEach(function (r) {
          try {
            if (r instanceof Range && !r.collapsed) {
              var rects = r.getClientRects();
              for (var i = 0; i < rects.length; i++) { var q = rects[i]; if (x >= q.left && x < q.right && y >= q.top && y < q.bottom) { hits.push(r); break; } }
            }
          } catch (e) {}
        });
        if (hits.length) out.push({ highlight: h, ranges: hits });
      });
      out.sort(function (a, b) { return b.highlight.priority - a.highlight.priority; });
      return out;
    }
  }
  HighlightRegistry.prototype[Symbol.iterator] = HighlightRegistry.prototype.entries;
  var registry = new HighlightRegistry(TOKEN);
  Object.defineProperty(CSS, "highlights", { get: function () { return registry; }, enumerable: true, configurable: true });

  // ---------------------------------------------------------------- CSSPseudoElement
  var PSEUDO_OK = { "::before": 1, "::after": 1, "::marker": 1, "::first-letter": 1, "::first-line": 1, "::selection": 1, "::backdrop": 1, "::placeholder": 1, "::file-selector-button": 1, "::details-content": 1, "::checkmark": 1, "::picker-icon": 1, "::column": 1, "::scroll-marker": 1, "::scroll-marker-group": 1, "::search-text": 1, "::target-text": 1, "::spelling-error": 1, "::grammar-error": 1 };
  var NESTED_OK = { "::before": { "::marker": 1 }, "::after": { "::marker": 1 }, "::column": { "::scroll-marker": 1 } };
  var pseudoCache = new WeakMap();
  class CSSPseudoElement extends EventTarget {
    constructor(tok) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); super(); }
    get type() { return this._pe.type; }
    get element() { return this._pe.element; }
    get parent() { return this._pe.parent; }
    get selectorText() { return this._pe.type; }
    pseudo(type) { return pseudoOf(this, String(type)); }
    getBoxQuads() { return []; }
  }
  var normType = function (type) {
    var t = type.toLowerCase();
    if (/^:(before|after|first-letter|first-line)$/.test(t)) t = ":" + t;
    return t;
  };
  var pseudoOf = function (owner, type) {
    var t = normType(type);
    var isEl = !(owner instanceof CSSPseudoElement);
    var hl = /^::highlight\(\s*(-?[A-Za-z_\u0080-￿][\w\-\u0080-￿]*)\s*\)$/i.exec(type);
    var vt = /^::view-transition(-(group|image-pair|old|new)\(\s*[^)\s]+\s*\))?$/i.test(type);
    if (isEl) { if (!PSEUDO_OK[t] && !hl && !vt) return null; }
    else { var allowed = NESTED_OK[owner._pe.type]; if (!allowed || !allowed[t]) return null; }
    var key = hl ? "::highlight(" + hl[1] + ")" : t;
    var cache = pseudoCache.get(owner);
    if (!cache) { cache = new Map(); pseudoCache.set(owner, cache); }
    if (cache.has(key)) return cache.get(key);
    var pe = new CSSPseudoElement(TOKEN);
    Object.defineProperty(pe, "_pe", { value: { type: key, element: isEl ? owner : owner._pe.element, parent: owner } });
    cache.set(key, pe);
    return pe;
  };
  Object.defineProperty(Element.prototype, "pseudo", { value: function pseudo(type) { if (arguments.length < 1) throw new TypeError("Element.pseudo: 1 argument required"); return pseudoOf(this, String(type)); }, writable: true, enumerable: true, configurable: true });

  // ---------------------------------------------------------------- View Transitions
  class ViewTransitionTypeSet {
    constructor(tok) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); Object.defineProperty(this, "_s", { value: new Set() }); }
    add(v) { this._s.add(String(v)); return this; }
    delete(v) { return this._s.delete(String(v)); }
    clear() { this._s.clear(); }
  }
  setlikeProto(ViewTransitionTypeSet.prototype, "_s");
  var active = new WeakMap();
  var deferred = function () { var d = {}; d.promise = new Promise(function (res, rej) { d.resolve = res; d.reject = rej; }); d.promise.catch(function () {}); return d; };
  class ViewTransition {
    constructor(tok) { if (tok !== TOKEN) throw new TypeError("Illegal constructor"); }
    get updateCallbackDone() { return this._vt.update.promise; }
    get ready() { return this._vt.ready.promise; }
    get finished() { return this._vt.finished.promise; }
    get types() { return this._vt.types; }
    get transitionRoot() { return this._vt.root; }
    skipTransition() { skip(this, dom("AbortError", "Transition was skipped")); }
    waitUntil(p) { var vt = this._vt; vt.waits.push(Promise.resolve(p)); }
  }
  var skip = function (t, reason) {
    var vt = t._vt;
    if (vt.phase === "done") return;
    vt.phase = "done";
    if (active.get(vt.scope) === t) active.delete(vt.scope);
    if (!vt.readySettled) { vt.readySettled = true; vt.ready.reject(reason); }
    // the update callback still runs; finished follows it
    runUpdate(t).then(function () { vt.finished.resolve(undefined); }, function (e) { vt.finished.reject(e); });
  };
  var runUpdate = function (t) {
    var vt = t._vt;
    if (vt.updateStarted) return vt.update.promise;
    vt.updateStarted = true;
    var p;
    try { p = vt.cb ? Promise.resolve(vt.cb.call(undefined)) : Promise.resolve(); } catch (e) { p = Promise.reject(e); }
    p.then(function () { vt.update.resolve(undefined); }, function (e) { vt.update.reject(e); });
    return vt.update.promise;
  };
  var start = function (scope, root, arg) {
    var cb = null, types = null;
    if (typeof arg === "function") cb = arg;
    else if (arg !== undefined && arg !== null) {
      if (typeof arg !== "object") throw new TypeError("startViewTransition: argument is not a callback or an options dictionary");
      if (arg.update !== undefined && arg.update !== null) { if (typeof arg.update !== "function") throw new TypeError("startViewTransition: 'update' is not callable"); cb = arg.update; }
      if (arg.types !== undefined && arg.types !== null) types = __jb.arrayFrom(arg.types, String);
    }
    var t = new ViewTransition(TOKEN);
    var ts = new ViewTransitionTypeSet(TOKEN);
    (types || []).forEach(function (x) { ts._s.add(x); });
    var vt = { cb: cb, types: ts, root: root, scope: scope, update: deferred(), ready: deferred(), finished: deferred(), phase: "pending", waits: [], readySettled: false, updateStarted: false };
    Object.defineProperty(t, "_vt", { value: vt });
    var doc = root.ownerDocument || root;
    var hidden = false; try { hidden = doc.visibilityState === "hidden"; } catch (e) {}
    if (hidden) { vt.phase = "done"; vt.readySettled = true; vt.ready.reject(dom("InvalidStateError", "The document is hidden")); runUpdate(t).then(function () { vt.finished.resolve(undefined); }, function (e) { vt.finished.reject(e); }); return t; }
    if (active.get(scope)) skip(active.get(scope), dom("AbortError", "Skipped by a new view transition"));
    active.set(scope, t);
    // capture the old state at the next rendering opportunity, then run the update
    requestAnimationFrame(function () {
      if (vt.phase === "done") return;
      vt.phase = "update";
      runUpdate(t).then(function () {
        if (vt.phase === "done") return;
        requestAnimationFrame(function () {
          if (vt.phase === "done") return;
          vt.phase = "animating";
          vt.readySettled = true;
          vt.ready.resolve(undefined);
          Promise.all(vt.waits).catch(function () {}).then(function () {
            requestAnimationFrame(function () {
              if (vt.phase === "done") return;
              vt.phase = "done";
              if (active.get(scope) === t) active.delete(scope);
              vt.finished.resolve(undefined);
            });
          });
        });
      }, function (e) {
        if (vt.phase === "done") return;
        vt.phase = "done";
        if (active.get(scope) === t) active.delete(scope);
        if (!vt.readySettled) { vt.readySettled = true; vt.ready.reject(e); }
        vt.finished.reject(e);
      });
    });
    return t;
  };
  Object.defineProperty(Document.prototype, "startViewTransition", { value: function startViewTransition(arg) { return start(this, this.documentElement || this, arg); }, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(Document.prototype, "activeViewTransition", { get: function () { return active.get(this) || null; }, enumerable: true, configurable: true });
  Object.defineProperty(Element.prototype, "startViewTransition", { value: function startViewTransition(arg) { return start(this, this, arg); }, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(Element.prototype, "activeViewTransition", { get: function () { return active.get(this) || null; }, enumerable: true, configurable: true });

  [Highlight, HighlightRegistry, CSSPseudoElement, ViewTransition, ViewTransitionTypeSet].forEach(function (C) {
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
    globalThis[C.name] = C;
  });
})();
