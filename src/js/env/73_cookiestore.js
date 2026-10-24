// Part 11d: Cookie Store API (cookieStore: CookieStore, CookieChangeEvent, CookieStoreManager)
// over the host cookie jar. Change events come from diffing the cookies visible to the document
// after writes through cookieStore, document.cookie and fetch/XHR responses.
(function () {
  var CTL = /[\x00-\x08\x0A-\x1F\x7F;]/;
  var trimWs = function (s) { return s.replace(/^[\t ]+|[\t ]+$/g, ""); };
  var docUrl = function () { try { return __jb.currentDocument ? __jb.currentDocument.URL : location.href; } catch (e) { return location.href; } };
  var site = function () { try { return __jb.cookieSite ? __jb.cookieSite() : ""; } catch (e) { return ""; } };
  var readJar = function (url) {
    var v = __jb.native("cookie", { op: "get", url: url || docUrl(), site: site() });
    var s = typeof v === "string" ? v : "", out = [];
    if (!s) return out;
    s.split("; ").forEach(function (part) {
      var i = part.indexOf("=");
      if (i < 0) out.push({ name: "", value: part });
      else out.push({ name: part.slice(0, i), value: part.slice(i + 1) });
    });
    return out;
  };
  var writeJar = function (str) { __jb.native("cookie", { op: "set", url: docUrl(), cookie: str, site: site() }); };
  var opaque = function () { try { return self.origin === "null"; } catch (e) { return false; } };
  var checkActive = function () { if (opaque()) throw __jb.domError("SecurityError", "Cookies are not available in opaque origins"); };

  var resolveUrl = function (u, what) {
    var url;
    try { url = new URL(String(u), docUrl()); } catch (e) { throw new TypeError(what + ": invalid URL"); }
    if (!__jb.isServiceWorker) {
      var cur = new URL(docUrl()); cur.hash = ""; url.hash = "";
      if (url.href !== cur.href) throw new TypeError(what + ": url must match the document URL");
    } else if (url.origin !== location.origin) throw new TypeError(what + ": url must be same-origin");
    return url.href;
  };
  var getOptions = function (args, what) {
    if (!args.length || args[0] === undefined) return {};
    var a = args[0];
    if (a !== null && typeof a === "object") {
      var o = {};
      if (a.name !== undefined) o.name = String(a.name);
      if (a.url !== undefined) o.url = resolveUrl(a.url, what);
      if (o.name === undefined && o.url === undefined && what === "get") throw new TypeError("CookieStore.get: options must contain a name or url");
      return o;
    }
    return { name: String(a) };
  };
  var query = function (o) {
    var list = readJar(o.url);
    if (o.name !== undefined) list = list.filter(function (c) { return c.name === o.name; });
    return list;
  };

  var validateNameValue = function (name, value) {
    if (CTL.test(name) || CTL.test(value)) throw new TypeError("Cookie name or value contains invalid characters");
    if (name.indexOf("=") >= 0) throw new TypeError("Cookie name cannot contain '='");
    if (name === "" && value === "") throw new TypeError("Cookie name and value cannot both be empty");
    if (name === "" && value.indexOf("=") >= 0) throw new TypeError("A cookie without a name cannot have '=' in its value");
    if (name.length + value.length > 4096) throw new TypeError("Cookie name and value are too long");
    var lower = name.toLowerCase();
    if (name === "" && /^__(secure|host|http|hosthttp)-/i.test(value)) throw new TypeError("A nameless cookie cannot start with a reserved prefix");
    if (/^__(http|hosthttp)-/.test(lower)) throw new TypeError("Cookies with the __Http- prefix cannot be set from script");
  };
  var attrs = function (o, name) {
    var host = new URL(docUrl()).hostname, s = "";
    if (o.domain !== null && o.domain !== undefined) {
      var d = String(o.domain);
      if (d.charAt(0) === ".") throw new TypeError("Cookie domain cannot start with '.'");
      if (host !== d && !host.endsWith("." + d)) throw new TypeError("Cookie domain must domain-match the current host");
      if (d.length > 1024) throw new TypeError("Cookie domain is too long");
      s += "; Domain=" + d;
    }
    var path = o.path === undefined || o.path === null ? "/" : String(o.path);
    if (path.charAt(0) !== "/") throw new TypeError("Cookie path must start with '/'");
    if (path.charAt(path.length - 1) !== "/") path += "/";
    if (path.length > 1024) throw new TypeError("Cookie path is too long");
    if (/^__host-/i.test(name) && ((o.domain !== null && o.domain !== undefined) || path !== "/")) throw new TypeError("__Host- cookies need path '/' and no domain");
    s += "; Path=" + path;
    return s;
  };
  var sameSiteAttr = function (v) {
    v = v === undefined ? "strict" : String(v);
    if (v !== "strict" && v !== "lax" && v !== "none") throw new TypeError("'" + v + "' is not a valid value for enumeration CookieSameSite.");
    return "; SameSite=" + v.charAt(0).toUpperCase() + v.slice(1);
  };

  // ---- change events ----
  var snapshot = null;
  var snap = function () { var m = new Map(); try { readJar().forEach(function (c) { if (!m.has(c.name)) m.set(c.name, c.value); }); } catch (e) {} return m; };
  var pendingCheck = false;
  var checkChanges = function () {
    if (__jb.isServiceWorker || typeof document === "undefined") return;
    if (pendingCheck) return;
    pendingCheck = true;
    setTimeout(function () {
      pendingCheck = false;
      var now = snap(), prev = snapshot || new Map(), changed = [], deleted = [];
      snapshot = now;
      now.forEach(function (v, k) { if (!prev.has(k) || prev.get(k) !== v) changed.push({ name: k, value: v }); });
      prev.forEach(function (v, k) { if (!now.has(k)) deleted.push({ name: k }); });
      if (!changed.length && !deleted.length) return;
      store.dispatchEvent(new CookieChangeEvent("change", { changed: changed, deleted: deleted }));
    }, 0);
  };
  __jb.cookiesMaybeChanged = checkChanges;

  var freezeList = function (l) { return Object.freeze((l === undefined ? [] : __jb.arrayFrom(l)).map(function (c) { var o = {}; if (c && c.name !== undefined) o.name = String(c.name); if (c && c.value !== undefined) o.value = String(c.value); return o; })); };
  class CookieChangeEvent extends Event {
    constructor(type, init) {
      if (arguments.length < 1) throw new TypeError("CookieChangeEvent constructor: At least 1 argument required");
      super(type, init);
      Object.defineProperty(this, "_c", { value: freezeList(init && init.changed) });
      Object.defineProperty(this, "_d", { value: freezeList(init && init.deleted) });
    }
    get changed() { return this._c; }
    get deleted() { return this._d; }
  }

  var constructing = false;
  class CookieStore extends EventTarget {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); super(); }
    get(a) {
      var args = arguments;
      return new Promise(function (resolve) {
        checkActive();
        if (!args.length) throw new TypeError("CookieStore.get: At least 1 argument required");
        var o = getOptions(args, "get"), l = query(o);
        resolve(l.length ? l[0] : null);
      });
    }
    getAll(a) {
      var args = arguments;
      return new Promise(function (resolve) { checkActive(); resolve(query(getOptions(args, "getAll"))); });
    }
    set(a, b) {
      var args = arguments;
      return new Promise(function (resolve) {
        checkActive();
        var o;
        if (a !== null && typeof a === "object" && args.length < 2) {
          if (a.name === undefined) throw new TypeError("CookieStore.set: 'name' member of CookieInit is required");
          if (a.value === undefined) throw new TypeError("CookieStore.set: 'value' member of CookieInit is required");
          o = a;
        } else {
          if (args.length < 2) throw new TypeError("CookieStore.set: At least 2 arguments required");
          o = { name: a, value: b };
        }
        var name = trimWs(String(o.name)), value = trimWs(String(o.value));
        validateNameValue(name, value);
        var s = (name === "" ? "" : name + "=") + value + attrs(o, name);
        if (o.expires !== undefined && o.expires !== null) {
          if (o.maxAge !== undefined && o.maxAge !== null) throw new TypeError("CookieStore.set: expires and maxAge cannot both be given");
          s += "; Expires=" + new Date(Number(o.expires)).toUTCString();
        }
        if (o.maxAge !== undefined && o.maxAge !== null) s += "; Max-Age=" + Math.trunc(Number(o.maxAge));
        s += sameSiteAttr(o.sameSite) + "; Secure";
        if (o.partitioned) s += "; Partitioned";
        writeJar(s);
        checkChanges();
        resolve(undefined);
      });
    }
    delete(a) {
      var args = arguments;
      return new Promise(function (resolve) {
        checkActive();
        if (!args.length) throw new TypeError("CookieStore.delete: At least 1 argument required");
        var o = a !== null && typeof a === "object" ? a : { name: a };
        if (o.name === undefined) throw new TypeError("CookieStore.delete: 'name' member is required");
        var name = trimWs(String(o.name));
        if (CTL.test(name)) throw new TypeError("Cookie name contains invalid characters");
        var s = (name === "" ? "" : name + "=") + attrs(o, name) + "; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Secure; SameSite=Strict";
        if (o.partitioned) s += "; Partitioned";
        writeJar(s);
        checkChanges();
        resolve(undefined);
      });
    }
  }
  if (!__jb.isServiceWorker) {
    Object.defineProperty(CookieStore.prototype, "onchange", {
      get: function () { return this._onchange === undefined ? null : this._onchange; },
      set: function (v) { var self_ = this; if (this._onchangeL) this.removeEventListener("change", this._onchangeL); this._onchange = typeof v === "function" || (v && typeof v === "object") ? v : null; if (this._onchange) { this._onchangeL = function (e) { var h = self_._onchange; return typeof h === "function" ? h.call(self_, e) : undefined; }; this.addEventListener("change", this._onchangeL); } },
      enumerable: true, configurable: true,
    });
  }

  // service worker registration.cookies
  class CookieStoreManager {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); Object.defineProperty(this, "_subs", { value: [] }); }
    subscribe(subs) {
      var self_ = this;
      return new Promise(function (resolve) {
        __jb.arrayFrom(subs).forEach(function (s) {
          var o = { name: s && s.name !== undefined ? String(s.name) : undefined, url: new URL(s && s.url !== undefined ? String(s.url) : (self_._scope || location.href), location.href).href };
          if (self_._scope && o.url.indexOf(self_._scope) !== 0) throw new TypeError("CookieStoreManager.subscribe: url is outside the registration scope");
          if (!self_._subs.some(function (x) { return x.name === o.name && x.url === o.url; })) self_._subs.push(o);
        });
        resolve(undefined);
      });
    }
    getSubscriptions() { var s = this._subs; return Promise.resolve(s.map(function (x) { var o = { url: x.url }; if (x.name !== undefined) o.name = x.name; return o; })); }
    unsubscribe(subs) {
      var self_ = this;
      return new Promise(function (resolve) {
        __jb.arrayFrom(subs).forEach(function (s) {
          var url = new URL(s && s.url !== undefined ? String(s.url) : (self_._scope || location.href), location.href).href, name = s && s.name !== undefined ? String(s.name) : undefined;
          for (var i = self_._subs.length - 1; i >= 0; i--) if (self_._subs[i].name === name && self_._subs[i].url === url) self_._subs.splice(i, 1);
        });
        resolve(undefined);
      });
    }
  }
  __jb.newCookieStoreManager = function (scope) { constructing = true; try { var m = new CookieStoreManager(); Object.defineProperty(m, "_scope", { value: scope }); return m; } finally { constructing = false; } };

  constructing = true;
  var store;
  try { store = new CookieStore(); } finally { constructing = false; }
  Object.defineProperty(globalThis, "cookieStore", { get: function () { return store; }, set: function (v) { Object.defineProperty(globalThis, "cookieStore", { value: v, writable: true, enumerable: true, configurable: true }); }, enumerable: true, configurable: true });
  globalThis.CookieStore = CookieStore;
  globalThis.CookieChangeEvent = CookieChangeEvent;
  globalThis.CookieStoreManager = CookieStoreManager;

  // writes through document.cookie and network responses can change what the document sees
  if (typeof Document !== "undefined") {
    var d = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    if (d && d.set) {
      var origSet = d.set;
      Object.defineProperty(Document.prototype, "cookie", { get: d.get, set: function (v) { origSet.call(this, v); checkChanges(); }, enumerable: d.enumerable, configurable: true });
    }
  }
  snapshot = __jb.isServiceWorker || typeof document === "undefined" ? null : snap();
})();
