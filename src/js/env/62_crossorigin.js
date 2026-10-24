// Part 6d: origins across browsing contexts. Documents of about:blank and
// about:srcdoc inherit their creator's origin, sandboxed frames without
// allow-same-origin get an opaque one; `document.domain` relaxes the
// same-origin check ("same origin-domain"); a Window of another realm that is
// not same origin-domain with the accessing realm is handed out as a
// cross-origin WindowProxy that exposes only the spec's CrossOriginProperties
// (window, self, location, close, closed, focus, blur, frames, length, top,
// opener, parent, postMessage, child frames) and throws SecurityError for
// everything else; its `location` only allows setting `href` and `replace()`.
// Origin-Agent-Cluster headers key agent clusters by origin
// (`originAgentCluster`, document.domain becomes a no-op, WebAssembly.Module
// messages across clusters raise `messageerror`).

// ---- origins ----
__jb.effectiveOrigin = function (w) {
  try {
    var j = w.__jb;
    if (j.opaqueOrigin) return j.opaqueOrigin;
    if (j.inheritedOrigin) return j.inheritedOrigin;
    var doc = w.document, url = doc ? doc.URL : "";
    if (j._eoDoc === doc && j._eoUrl === url) return j._eo;
    var o = w.location.origin;
    j._eoDoc = doc; j._eoUrl = url; j._eo = o;
    return o;
  } catch (e) { return "null"; }
};
// The origin of a window's document as a shared record: documents that
// inherit an origin (initial about:blank, srcdoc) share their creator's
// record, so a document.domain set on one applies to both.
__jb.originRecord = function (w) {
  var j = w.__jb;
  if (!j.originRec) j.originRec = { domain: null };
  return j.originRec;
};
__jb.isOpaqueOrigin = function (o) { return !o || o === "null" || o.indexOf("null#") === 0; };
Object.defineProperty(globalThis, "origin", {
  get: function () { var o = __jb.effectiveOrigin(globalThis); return __jb.isOpaqueOrigin(o) ? "null" : o; },
  set: function (v) { Object.defineProperty(globalThis, "origin", { value: v, writable: true, configurable: true, enumerable: true }); },
  configurable: true, enumerable: true,
});

// Same origin-domain (HTML "same origin-domain"): with document.domain set on
// both sides the schemes and domains decide; set on one side only, never.
__jb.sameOriginDomain = function (a, b) {
  if (a === b) return true;
  var oa = __jb.effectiveOrigin(a), ob = __jb.effectiveOrigin(b);
  if (__jb.isOpaqueOrigin(oa) || __jb.isOpaqueOrigin(ob)) return oa === ob && oa !== "null";
  var ra = null, rb = null;
  try { ra = __jb.originRecord(a); } catch (e) {}
  try { rb = __jb.originRecord(b); } catch (e2) {}
  if (ra && ra === rb) return true; // the same origin, whatever its domain
  var da = ra ? ra.domain : null, db = rb ? rb.domain : null;
  if (da !== null && db !== null) return oa.split(":")[0] === ob.split(":")[0] && da === db;
  return da === null && db === null && oa === ob;
};

// ---- agent clusters (Origin-Agent-Cluster) ----
__jb.agentKeyedOf = function (w) {
  var j = w.__jb;
  if (j.agentKeyed !== undefined) return j.agentKeyed;
  var root = __jb.rootRealm();
  if (w !== root && root.__jb.agentKeyed === undefined) __jb.agentKeyedOf(root);
  var rj = root.__jb;
  if (!rj.oacRegistry) rj.oacRegistry = {};
  var origin = __jb.effectiveOrigin(w);
  var header = j.oacHeader;
  if (header === undefined || header === null) { try { var h = w.document._responseHeaders; if (h) header = h["origin-agent-cluster"]; } catch (e) {} }
  var keyed;
  if (__jb.isOpaqueOrigin(origin)) keyed = true;
  else if (Object.prototype.hasOwnProperty.call(rj.oacRegistry, origin)) keyed = rj.oacRegistry[origin];
  else {
    // Only secure contexts may ask for origin keying.
    var secure = /^https:/.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin);
    keyed = secure && /^\s*\?1\s*$/.test(String(header || ""));
    rj.oacRegistry[origin] = keyed;
  }
  j.agentKeyed = keyed;
  return keyed;
};
__jb.agentClusterKey = function (w) {
  var origin = __jb.effectiveOrigin(w);
  if (__jb.agentKeyedOf(w)) return "origin:" + origin;
  try { var u = new URL(origin); return "site:" + u.protocol + __jb.registrableDomain(u.hostname); } catch (e) { return "origin:" + origin; }
};
Object.defineProperty(globalThis, "originAgentCluster", { get: function () { return __jb.agentKeyedOf(globalThis); }, configurable: true, enumerable: true });

// Loading a document into a realm decides its origin and cluster.
(function () {
  var baseLoad = __jb.loadRealmDocument;
  __jb.loadRealmDocument = function (g, source, allowScripts) {
    try {
      var gj = g.__jb;
      gj.inheritedOrigin = null;
      gj.originRec = null;
      if (/^about:(blank|srcdoc)([?#]|$)/.test(source.url || "") && !gj.opaqueOrigin) { gj.inheritedOrigin = __jb.effectiveOrigin(globalThis); gj.originRec = __jb.originRecord(globalThis); }
      gj.oacHeader = source.oac === undefined ? null : source.oac;
      gj.agentKeyed = undefined;
    } catch (e) {}
    var r = baseLoad(g, source, allowScripts);
    try { __jb.agentKeyedOf(g); } catch (e3) {}
    return r;
  };
})();

// ---- document.domain ----
__jb.isRegistrableSuffix = function (suffix, host) {
  if (suffix === "") return false;
  if (suffix === host) return true;
  var isIp = function (h) { return /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.charAt(0) === "["; };
  if (isIp(host) || isIp(suffix)) return false;
  if (host.slice(-(suffix.length + 1)) !== "." + suffix) return false;
  // The suffix may not be a public suffix (approximated like registrableDomain).
  return suffix.length >= __jb.registrableDomain(host).length;
};
Object.defineProperty(Document.prototype, "domain", {
  get: function () {
    var w = this.defaultView;
    if (w && w.document === this) { var rec = __jb.originRecord(w); if (rec.domain !== null) return rec.domain; }
    var o = w ? __jb.effectiveOrigin(w) : null;
    if (o === null) { try { return new URL(this.URL).hostname; } catch (e) { return ""; } }
    if (__jb.isOpaqueOrigin(o)) return "";
    try { return new URL(o).hostname; } catch (e2) { return ""; }
  },
  set: function (v) {
    var w = this.defaultView;
    if (!w || w.document !== this) throw __jb.domError("SecurityError", "document.domain: the document has no browsing context");
    try { if (w.__jb.opaqueOrigin) throw 0; } catch (e) { throw __jb.domError("SecurityError", "document.domain: sandboxed document"); }
    var eff = this.domain;
    if (eff === "") throw __jb.domError("SecurityError", "document.domain: opaque origin");
    var host;
    try { host = new URL("http://" + String(v) + "/").hostname; } catch (e2) { throw __jb.domError("SecurityError", "document.domain: '" + v + "' is not a valid domain"); }
    if (String(v) === "" || !__jb.isRegistrableSuffix(host, eff)) throw __jb.domError("SecurityError", "document.domain: '" + v + "' is not a suffix of '" + eff + "'");
    if (__jb.agentKeyedOf(w)) return; // origin-keyed agent clusters ignore document.domain
    __jb.originRecord(w).domain = host;
  },
  configurable: true, enumerable: true,
});

// ---- cross-origin WindowProxy / Location ----
__jb.XO_WINDOW = { window: "self", self: "self", frames: "self", location: "location", close: "method", closed: "get", focus: "method", blur: "method", length: "get", top: "get", opener: "get", parent: "get", postMessage: "method" };
__jb.XO_FALLBACK = ["then", Symbol.toStringTag, Symbol.hasInstance, Symbol.isConcatSpreadable];
__jb.xoProxySet = new WeakSet();
__jb.isXoFallback = function (k) { return __jb.XO_FALLBACK.indexOf(k) >= 0; };
__jb.xoError = function (k) { return __jb.domError("SecurityError", "Blocked a frame from accessing a cross-origin frame (property '" + String(typeof k === "symbol" ? k.toString() : k) + "')."); };
__jb.rawRelative = function (w, name) {
  var j = w.__jb;
  if (name === "opener") { if (j.openerOverride !== undefined) return j.openerOverride; return j.auxiliary ? j.auxiliary.opener : null; }
  var fc = j.frameContext;
  if (!fc) return w;
  var discarded = false; try { discarded = !!fc.frameElement && (!fc.frameElement.isConnected || fc.frameElement._contentWindow !== w); } catch (e) {}
  if (discarded) return null;
  return (name === "top" ? fc.top : fc.parent) || w;
};
__jb.rawChildren = function (w) { try { return w.__jb.closedFlag ? [] : w.__jb.frameWindows(w.document); } catch (e) { return []; } };

// Browsing contexts: one record per frame / popup / top-level context that
// follows its current global, so a WindowProxy handed out before a navigation
// keeps working afterwards (each frame document gets a fresh global here).
__jb.bcOf = function (raw) { var j = raw.__jb; if (!j.bc) j.bc = { current: raw }; return j.bc; };
__jb.bcProxies = new WeakMap();   // browsing context -> this realm's WindowProxy

// This realm's view of another realm's window: the WindowProxy of its
// browsing context, which forwards to the context's current global and
// re-checks same origin-domain access on every operation.
__jb.wrapWindow = function (w) {
  if (!w || typeof w !== "object" || w === globalThis) return w;
  if (__jb.xoProxySet.has(w)) return w;
  // A proxy made by another realm stands for its browsing context.
  var raw = __jb.unwrapForeign(w);
  if (raw === globalThis) return globalThis;
  if (!__jb.isRealmWindow(raw)) return raw;
  var bc = __jb.bcOf(raw);
  if (bc.current === globalThis) return globalThis;
  return __jb.windowProxyFor(bc);
};
// Proxies of every realm, so any realm can see through them (proxy -> context).
__jb.xoRegistry = function () { var tj = __jb.topJb(); if (!tj.xoAllProxies) tj.xoAllProxies = new WeakMap(); return tj.xoAllProxies; };
__jb.unwrapForeign = function (v) { try { var bc = __jb.xoRegistry().get(v); return bc ? bc.current : v; } catch (e) { return v; } };
// Values read through a same-origin-domain proxy: windows become this realm's view.
__jb.localizeValue = function (v) {
  if (!v || typeof v !== "object") return v;
  if (__jb.xoProxySet.has(v)) return v;
  var raw = __jb.unwrapForeign(v);
  if (raw !== v || raw === globalThis || __jb.isRealmWindow(raw)) return __jb.wrapWindow(raw);
  return v;
};

// A thin membrane for same-origin-domain access: functions read through a
// WindowProxy convert window-valued arguments into the callee realm's view
// and results into ours; functions stored into another window convert the
// other way when that realm calls them. Identities are cached per function.
__jb.toRealmView = function (v, targetRaw) {
  if (!v || typeof v !== "object") return v;
  var raw = v === globalThis ? globalThis : __jb.unwrapForeign(v);
  if (raw === v && raw !== globalThis && !__jb.isRealmWindow(raw)) return v;
  try { return targetRaw.__jb.wrapWindow(raw); } catch (e) { return v; }
};
__jb.foreignFns = new WeakMap();  // other realm's function -> proxy calling it with converted values
__jb.localFns = new WeakMap();    // our function -> proxy the other realm calls
__jb.localFnOrig = new WeakMap(); // that proxy -> our function
__jb.foreignFunction = function (fn, bc, windowProxy) {
  if (__jb.localFnOrig.has(fn)) return __jb.localFnOrig.get(fn);
  var cached = __jb.foreignFns.get(fn);
  if (cached) return cached;
  var fp = new Proxy(fn, {
    apply: function (t, thisArg, args) {
      var tr = bc.current;
      var th = thisArg === windowProxy ? tr : __jb.toRealmView(thisArg, tr);
      return __jb.localizeValue(Reflect.apply(t, th, __jb.A.map.call(args, function (a) { return __jb.toRealmView(a, tr); })));
    },
    construct: function (t, args, nt) {
      var tr = bc.current;
      return Reflect.construct(t, __jb.A.map.call(args, function (a) { return __jb.toRealmView(a, tr); }), nt === fp ? t : nt);
    },
  });
  __jb.foreignFns.set(fn, fp);
  return fp;
};
__jb.localFunction = function (fn, bc) {
  var cached = __jb.localFns.get(fn);
  if (cached) return cached;
  var lp = new Proxy(fn, {
    apply: function (t, thisArg, args) {
      var r = Reflect.apply(t, __jb.localizeValue(thisArg), __jb.A.map.call(args, function (a) { return __jb.localizeValue(a); }));
      return __jb.toRealmView(r, bc.current);
    },
  });
  __jb.localFns.set(fn, lp);
  __jb.localFnOrig.set(lp, fn);
  return lp;
};

__jb.windowProxyFor = function (bc) {
  var cached = __jb.bcProxies.get(bc);
  if (cached) return cached;
  var fns = {};
  var fn = function (key, make) { if (!fns[key]) fns[key] = make(); return fns[key]; };
  var cur = function () { return bc.current; };
  var same = function () { return __jb.sameOriginDomain(globalThis, bc.current); };
  var isIndex = function (k) { return typeof k === "string" && /^(0|[1-9][0-9]*)$/.test(k); };
  var proxy;
  var value = function (k) {
    var raw = cur();
    var kind = __jb.XO_WINDOW[k];
    if (kind === "self") return proxy;
    if (kind === "location") return __jb.crossOriginLocation(bc);
    if (kind === "get") {
      if (k === "closed") return !!raw.closed;
      if (k === "length") return __jb.rawChildren(raw).length;
      return __jb.wrapWindow(__jb.rawRelative(raw, k));
    }
    if (kind === "method") return fn(k, function () {
      var f;
      // the caller is the realm that holds this proxy (promise callbacks do not update the incumbent)
      if (k === "postMessage") f = function postMessage(message, targetOrigin, transfer) { var r = cur(); var prev = __jb.setIncumbent(globalThis); try { return r.postMessage.apply(r, arguments); } finally { __jb.setIncumbent(prev); } };
      else if (k === "close") f = function close() { return cur().close(); };
      else f = function () {};
      Object.defineProperty(f, "name", { value: k });
      return f;
    });
    return undefined;
  };
  var getter = function (k) { return fn("get " + k, function () { var g = function () { return value(k); }; Object.defineProperty(g, "name", { value: "get " + k }); return g; }); };
  var descriptor = function (k) {
    var raw = cur();
    if (isIndex(k)) {
      var kids = __jb.rawChildren(raw), i = Number(k);
      if (i < kids.length) return { value: __jb.wrapWindow(kids[i]), writable: false, enumerable: false, configurable: true };
      return undefined;
    }
    var kind = __jb.XO_WINDOW[k];
    if (kind === "method") return { value: value(k), writable: false, enumerable: false, configurable: true };
    if (kind === "location") return { get: getter(k), set: fn("set location", function () { var s = function (v) { __jb.xoSetLocationHref(cur(), v); }; Object.defineProperty(s, "name", { value: "set location" }); return s; }), enumerable: false, configurable: true };
    if (kind) return { get: getter(k), set: undefined, enumerable: false, configurable: true };
    if (__jb.isXoFallback(k)) return { value: undefined, writable: false, enumerable: false, configurable: true };
    if (typeof k === "string" && k !== "") {
      var named = __jb.rawChildren(raw).filter(function (c) { try { return c.name === k; } catch (e) { return false; } })[0];
      if (named) return { value: __jb.wrapWindow(named), writable: false, enumerable: false, configurable: true };
    }
    return undefined;
  };
  // Same-origin-domain access forwards to the current global; the window's
  // own aliases (window, self, frames, globalThis) answer with this proxy.
  var selfNames = { window: 1, self: 1, frames: 1, globalThis: 1 };
  proxy = new Proxy(Object.create(null), {
    get: function (t, k) {
      if (same()) {
        if (selfNames[k] === 1) { var raw0 = cur(); var v0 = Reflect.get(raw0, k, raw0); return v0 === raw0 ? proxy : __jb.localizeValue(v0); }
        if (k === "location") return __jb.crossOriginLocation(bc);
        var raw = cur(); var gv = Reflect.get(raw, k, raw);
        // Constructors keep their identity (`w.DOMException`, `instanceof w.Node`).
        if (typeof gv === "function" && !/^[A-Z]/.test(String(k))) return __jb.foreignFunction(gv, bc, proxy);
        return __jb.localizeValue(gv);
      }
      var d = descriptor(k);
      if (d && "value" in d) return d.value;
      if (d && d.get) return d.get();
      throw __jb.xoError(k);
    },
    set: function (t, k, v) {
      if (same()) {
        if (k === "__proto__") { if (v !== Object.getPrototypeOf(cur())) throw new TypeError("can't set prototype of this object"); return true; }
        var raw = cur();
        if (typeof v === "function" && !__jb.foreignFns.has(v)) v = __jb.localFunction(v, bc);
        else v = __jb.toRealmView(v, raw);
        return Reflect.set(raw, k, v, raw);
      }
      if (k === "location") { __jb.xoSetLocationHref(cur(), v); return true; }
      throw __jb.xoError(k);
    },
    has: function (t, k) {
      if (same()) return k in cur();
      if (descriptor(k)) return true;
      throw __jb.xoError(k);
    },
    getOwnPropertyDescriptor: function (t, k) {
      if (same()) {
        // Non-configurable properties defined through the proxy are mirrored on the proxy
        // target (Proxy invariants); report them from there.
        var td = Reflect.getOwnPropertyDescriptor(t, k);
        if (td && !td.configurable) { var rd = Reflect.getOwnPropertyDescriptor(cur(), k); if (rd && "value" in rd && td.writable) { td.value = rd.value; Reflect.defineProperty(t, k, { value: rd.value }); } return td; }
        var d = Reflect.getOwnPropertyDescriptor(cur(), k); if (d) { d.configurable = true; if ("value" in d) d.value = selfNames[k] === 1 && d.value === cur() ? proxy : __jb.localizeValue(d.value); } return d;
      }
      var xd = descriptor(k);
      if (xd) return xd;
      throw __jb.xoError(k);
    },
    defineProperty: function (t, k, d) {
      if (same()) {
        var td = Reflect.getOwnPropertyDescriptor(t, k);
        if (td && !td.configurable) { if (!Reflect.defineProperty(t, k, d)) return false; }
        var copy = Object.assign({}, d); copy.configurable = true;
        if (!Reflect.defineProperty(cur(), k, copy)) return false;
        if (d.configurable === false && !td) { var m = Object.assign({}, d); if (!("get" in m) && !("set" in m) && !("value" in m)) m.value = cur()[k]; Reflect.defineProperty(t, k, m); }
        return true;
      }
      throw __jb.xoError(k);
    },
    deleteProperty: function (t, k) {
      if (same()) { var td = Reflect.getOwnPropertyDescriptor(t, k); if (td && !td.configurable) return false; return Reflect.deleteProperty(cur(), k); }
      throw __jb.xoError(k);
    },
    ownKeys: function () {
      if (same()) { var seen = {}, out = []; Reflect.ownKeys(cur()).forEach(function (k) { if (typeof k === "symbol") { if (out.indexOf(k) < 0) out.push(k); } else if (!seen["s:" + k]) { seen["s:" + k] = 1; out.push(k); } }); return out; }
      var keys = [];
      for (var i = 0; i < __jb.rawChildren(cur()).length; i++) keys.push(String(i));
      return keys.concat(Object.keys(__jb.XO_WINDOW), __jb.XO_FALLBACK);
    },
    getPrototypeOf: function () { return same() ? Object.getPrototypeOf(cur()) : null; },
    // WindowProxy has an immutable prototype.
    setPrototypeOf: function (t, p) { return p === (same() ? Object.getPrototypeOf(cur()) : null); },
    isExtensible: function () { return true; },
    preventExtensions: function () { return false; },
  });
  __jb.bcProxies.set(bc, proxy);
  __jb.xoProxySet.add(proxy);
  try { __jb.xoRegistry().set(proxy, bc); } catch (e) {}
  return proxy;
};

// Navigating another browsing context through its (cross-origin) Location:
// the URL resolves against the accessing realm's document.
__jb.xoResolve = function (v) {
  try { return new URL(String(v), __jb.currentDocument.baseURI).href; }
  catch (e) { throw __jb.domError("SyntaxError", "'" + v + "' is not a valid URL."); }
};
__jb.xoSetLocationHref = function (raw, v) { var abs = __jb.xoResolve(v); raw.location.href = abs; };
__jb.xoLocations = new WeakMap();
__jb.xoLocationSet = new WeakSet();
__jb.crossOriginLocation = function (bc) {
  var cached = __jb.xoLocations.get(bc);
  if (cached) return cached;
  var same = function () { return __jb.sameOriginDomain(globalThis, bc.current); };
  var rawLoc = function () { return bc.current.location; };
  var replaceFn = function replace(url) { var abs = __jb.xoResolve(url); rawLoc().replace(abs); };
  var hrefSetter = function (v) { __jb.xoSetLocationHref(bc.current, v); };
  Object.defineProperty(hrefSetter, "name", { value: "set href" });
  var descriptor = function (k) {
    if (k === "replace") return { value: replaceFn, writable: false, enumerable: false, configurable: true };
    if (k === "href") return { get: undefined, set: hrefSetter, enumerable: false, configurable: true };
    if (__jb.isXoFallback(k)) return { value: undefined, writable: false, enumerable: false, configurable: true };
    return undefined;
  };
  var loc = new Proxy(Object.create(null), {
    get: function (t, k) {
      if (same()) { var l = rawLoc(); return Reflect.get(l, k, l); }
      var d = descriptor(k);
      if (d && "value" in d) return d.value;
      throw __jb.xoError(k);
    },
    set: function (t, k, v) {
      if (same()) {
        if (k === "__proto__") { if (v !== Object.getPrototypeOf(rawLoc())) throw new TypeError("can't set prototype of this object"); return true; }
        var l = rawLoc(); return Reflect.set(l, k, v, l);
      }
      if (k === "href") { hrefSetter(v); return true; }
      throw __jb.xoError(k);
    },
    has: function (t, k) { if (same()) return k in rawLoc(); if (descriptor(k)) return true; throw __jb.xoError(k); },
    getOwnPropertyDescriptor: function (t, k) {
      if (same()) { var d = Reflect.getOwnPropertyDescriptor(rawLoc(), k); if (d) d.configurable = true; return d; }
      var xd = descriptor(k); if (xd) return xd; throw __jb.xoError(k);
    },
    defineProperty: function (t, k, d) { if (same()) { var c = Object.assign({}, d); c.configurable = true; return Reflect.defineProperty(rawLoc(), k, c); } throw __jb.xoError(k); },
    deleteProperty: function (t, k) { if (same()) return Reflect.deleteProperty(rawLoc(), k); throw __jb.xoError(k); },
    ownKeys: function () { if (same()) return Reflect.ownKeys(rawLoc()); return ["href", "replace"].concat(__jb.XO_FALLBACK); },
    getPrototypeOf: function () { return same() ? Object.getPrototypeOf(rawLoc()) : null; },
    setPrototypeOf: function (t, p) { return p === (same() ? Object.getPrototypeOf(rawLoc()) : null); },
    isExtensible: function () { return true; },
    preventExtensions: function () { return false; },
  });
  __jb.xoLocations.set(bc, loc);
  __jb.xoLocationSet.add(loc);
  return loc;
};

// ---- every way one realm reaches another's window goes through wrapWindow ----
Object.defineProperty(HTMLElement.prototype, "contentWindow", {
  get: function () {
    if (!(this._tag === "iframe" || this._tag === "frame" || this._tag === "object" || this._tag === "embed")) return undefined;
    return __jb.wrapWindow(this._contentWindow || null);
  },
  configurable: true,
});
(function () {
  var cd = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "contentDocument");
  if (cd && cd.get) Object.defineProperty(HTMLElement.prototype, "contentDocument", {
    get: function () {
      var w = this._contentWindow;
      if (w && __jb.isRealmWindow(w) && !__jb.sameOriginDomain(globalThis, w)) return null;
      return cd.get.call(this);
    },
    configurable: true,
  });
  ["parent", "top", "opener"].forEach(function (name) {
    var d = Object.getOwnPropertyDescriptor(globalThis, name);
    if (!d || !d.get) return;
    Object.defineProperty(globalThis, name, { get: function () { return __jb.wrapWindow(d.get.call(globalThis)); }, set: d.set, configurable: true, enumerable: true });
  });
  var fe = Object.getOwnPropertyDescriptor(globalThis, "frameElement");
  if (fe && fe.get) Object.defineProperty(globalThis, "frameElement", {
    get: function () {
      var el = fe.get.call(globalThis);
      if (!el) return null;
      var owner = __jb.frameContext && __jb.frameContext.parent;
      if (owner && owner !== globalThis && !__jb.sameOriginDomain(globalThis, owner)) return null;
      return el;
    },
    set: fe.set, configurable: true, enumerable: true,
  });
  var baseOpen = globalThis.open;
  globalThis.open = function open(url, target, features) { return __jb.wrapWindow(baseOpen.apply(this, arguments)); };
})();

(function () {
  (__jb.EVENT_HANDLER_NAMES || []).concat(__jb.WINDOW_HANDLER_NAMES || []).forEach(function (n) {
    if (!Object.prototype.hasOwnProperty.call(globalThis, "on" + n) && !("on" + n in globalThis)) { try { globalThis["on" + n] = null; } catch (e) {} }
  });
})();

// ---- WebAssembly.Module across realms: keep the bytes so the receiving realm
// can rebuild the module; across agent clusters the message fails ----
__jb.wasmBytes = new WeakMap();
(function () {
  if (typeof WebAssembly !== "object") return;
  var copyBytes = function (src) {
    try {
      if (src instanceof ArrayBuffer) return new Uint8Array(src.slice(0));
      if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
    } catch (e) {}
    return null;
  };
  var baseCompile = WebAssembly.compile;
  var compile = { compile: function (bytes) {
    var copy = copyBytes(bytes);
    return baseCompile.apply(WebAssembly, arguments).then(function (m) { if (copy) __jb.wasmBytes.set(m, copy); return m; });
  } }.compile;
  Object.defineProperty(WebAssembly, "compile", { value: compile, writable: true, enumerable: false, configurable: true });
  // The embedding has no stream consumer (SpiderMonkey throws "streaming not supported"):
  // compileStreaming/instantiateStreaming read the whole Response first (wasm-js-api 3).
  var bodyBytes = function (source) {
    return Promise.resolve(source).then(function (r) {
      if (!(r instanceof Response)) throw new TypeError("WebAssembly: argument must be a Response or a Promise for one");
      var mime = (r.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      if (mime !== "application/wasm") throw new TypeError("WebAssembly: Response has unsupported MIME type '" + mime + "' expected 'application/wasm'");
      if (r.type !== "basic" && r.type !== "cors" && r.type !== "default") throw new TypeError("WebAssembly: Response.type must be 'basic', 'cors' or 'default'");
      if (!r.ok) throw new TypeError("WebAssembly: Response has HTTP status " + r.status);
      if (r.bodyUsed) throw new TypeError("WebAssembly: Response body is already used");
      return r.arrayBuffer();
    });
  };
  var streaming = {
    compileStreaming: function (source) { return bodyBytes(source).then(function (b) { return WebAssembly.compile(b); }); },
    instantiateStreaming: function (source, imports) { return bodyBytes(source).then(function (b) { return WebAssembly.instantiate(b, imports); }); },
  };
  Object.defineProperty(WebAssembly, "compileStreaming", { value: streaming.compileStreaming, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(WebAssembly, "instantiateStreaming", { value: streaming.instantiateStreaming, writable: true, enumerable: true, configurable: true });
})();
__jb.isWasmModule = function (v) { try { return Object.prototype.toString.call(v) === "[object WebAssembly.Module]"; } catch (e) { return false; } };
