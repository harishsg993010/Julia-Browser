// Part 11g: service worker registration managers: Push API (PushManager, PushSubscription*),
// Background Sync (SyncManager), Periodic Background Sync (PeriodicSyncManager), Background
// Fetch (BackgroundFetchManager / BackgroundFetchRegistration / BackgroundFetchRecord), Content
// Index (ContentIndex) and the Cookie Store manager (registration.cookies). State lives on the
// shared registration record, so every realm sees the same tags and entries. There is no push
// service: subscribe() checks its arguments and then fails like an unreachable push service.
(function () {
  if (typeof ServiceWorkerRegistration !== "function") return;
  var dom = function (n, m) { return __jb.domError(n, m); };
  var illegal = function () { throw new TypeError("Illegal constructor"); };
  var perm = function (n) { try { return __jb.permissionState(n); } catch (e) { return "prompt"; } };
  var recOf = function (o) { if (!o || !o._rec) throw new TypeError("Illegal invocation"); return o._rec; };
  var mgr = function (C, reg) { var o = Object.create(C.prototype); Object.defineProperty(o, "_reg", { value: reg }); return o; };
  var lazy = function (name, C) {
    Object.defineProperty(ServiceWorkerRegistration.prototype, name, {
      get: function () { var r = recOf(this), k = "_m_" + name; if (!this[k]) Object.defineProperty(this, k, { value: mgr(C, this) }); return this[k]; },
      enumerable: true, configurable: true,
    });
  };
  var hasActive = function (reg) { var r = recOf(reg); return !!r.active; };
  var store = function (reg, key, init) { var r = recOf(reg); if (!r[key]) r[key] = init(); return r[key]; };
  var defineHandlers = function (proto, names) { if (__jb.defineEventHandlerProps) __jb.defineEventHandlerProps(proto, names); };

  // ================================================================ Push
  var b64url = function (s) {
    s = String(s);
    if (!/^[A-Za-z0-9_\-]*={0,2}$/.test(s)) throw dom("InvalidCharacterError", "applicationServerKey is not valid base64url");
    var b = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    while (b.length % 4) b += "=";
    var bin = atob(b), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  var keyBytes = function (k) {
    if (k === undefined || k === null) return null;
    if (typeof k === "string") return b64url(k);
    if (k instanceof ArrayBuffer) return new Uint8Array(k.slice(0));
    if (ArrayBuffer.isView(k)) return new Uint8Array(k.buffer.slice(k.byteOffset, k.byteOffset + k.byteLength));
    throw new TypeError("applicationServerKey must be a BufferSource or a string");
  };
  class PushSubscriptionOptions {
    constructor() { illegal(); }
    get userVisibleOnly() { return this._o.userVisibleOnly; }
    get applicationServerKey() { return this._o.key; }
  }
  class PushSubscription {
    constructor() { illegal(); }
    get endpoint() { return this._s.endpoint; }
    get expirationTime() { return null; }
    get options() { return this._s.options; }
    getKey(name) { var k = this._s.keys[String(name)]; return k ? k.slice(0) : null; }
    unsubscribe() { var s = this._s; return new Promise(function (resolve) { var had = !s.gone; s.gone = true; if (s.store) s.store.sub = null; resolve(had); }); }
    toJSON() { return { endpoint: this.endpoint, expirationTime: null, keys: {} }; }
  }
  class PushManager {
    constructor() { illegal(); }
    static get supportedContentEncodings() { return Object.freeze(["aes128gcm", "aesgcm"]); }
    subscribe(options) {
      var reg = this._reg;
      return new Promise(function (resolve) {
        options = options === undefined || options === null ? {} : options;
        var key = keyBytes(options.applicationServerKey);
        if (key !== null && !(key.length === 65 && key[0] === 4) && key.length < 1) throw dom("InvalidAccessError", "applicationServerKey is not a valid P-256 public key");
        if (key !== null && key.length === 0) throw dom("InvalidAccessError", "applicationServerKey is empty");
        if (!options.userVisibleOnly) throw dom("NotAllowedError", "Push subscriptions require userVisibleOnly: true");
        if (!hasActive(reg)) throw dom("InvalidStateError", "Subscribing for push requires an active service worker");
        if (key === null) throw dom("AbortError", "Registration failed - missing applicationServerKey");
        var st = perm("notifications") === "granted" || perm("push") === "granted" ? "granted" : perm("notifications") === "denied" ? "denied" : "prompt";
        if (st !== "granted") throw dom("NotAllowedError", "Registration failed - permission denied");
        throw dom("AbortError", "Registration failed - push service not available");
      });
    }
    getSubscription() { var reg = this._reg; return new Promise(function (resolve) { var s = store(reg, "_push", function () { return { sub: null }; }); resolve(s.sub); }); }
    permissionState(options) {
      return new Promise(function (resolve) {
        options = options === undefined || options === null ? {} : options;
        if (!options.userVisibleOnly && options.userVisibleOnly !== undefined) throw dom("NotSupportedError", "userVisibleOnly must be true");
        var n = perm("notifications");
        resolve(n === "granted" || perm("push") === "granted" ? "granted" : n === "denied" ? "denied" : "prompt");
      });
    }
  }
  class PushMessageData { constructor() { illegal(); } }
  ["arrayBuffer", "blob", "bytes", "json", "text"].forEach(function (k) { PushMessageData.prototype[k] = function () { var b = this._b || new Uint8Array(0); switch (k) { case "arrayBuffer": return b.buffer.slice(0); case "blob": return new Blob([b]); case "bytes": return b.slice(0); case "json": return JSON.parse(new TextDecoder().decode(b)); default: return new TextDecoder().decode(b); } }; });
  lazy("pushManager", PushManager);

  // ================================================================ Background Sync
  class SyncManager {
    constructor() { illegal(); }
    register(tag) {
      var reg = this._reg;
      return new Promise(function (resolve) {
        if (arguments.length === 0 && tag === undefined) {}
        tag = String(tag);
        if (!hasActive(reg)) throw dom("InvalidStateError", "Registration failed - no active Service Worker");
        if (perm("background-sync") === "denied") throw dom("NotAllowedError", "Background sync is disabled");
        var tags = store(reg, "_syncTags", function () { return []; });
        if (tags.indexOf(tag) < 0) tags.push(tag);
        resolve(undefined);
      });
    }
    getTags() { var reg = this._reg; return new Promise(function (resolve) { resolve(store(reg, "_syncTags", function () { return []; }).slice()); }); }
  }
  lazy("sync", SyncManager);

  // ================================================================ Periodic Background Sync
  class PeriodicSyncManager {
    constructor() { illegal(); }
    register(tag, options) {
      var reg = this._reg;
      return new Promise(function (resolve) {
        tag = String(tag);
        if (!hasActive(reg)) throw dom("InvalidStateError", "Registration failed - no active Service Worker");
        if (perm("periodic-background-sync") !== "granted") throw dom("NotAllowedError", "Permission denied");
        var m = store(reg, "_periodic", function () { return new Map(); });
        m.set(tag, options && options.minInterval !== undefined ? Number(options.minInterval) : 0);
        resolve(undefined);
      });
    }
    getTags() { var reg = this._reg; return new Promise(function (resolve) { resolve(__jb.arrayFrom(store(reg, "_periodic", function () { return new Map(); }).keys())); }); }
    unregister(tag) { var reg = this._reg; return new Promise(function (resolve) { store(reg, "_periodic", function () { return new Map(); }).delete(String(tag)); resolve(undefined); }); }
  }
  lazy("periodicSync", PeriodicSyncManager);

  // ================================================================ Background Fetch
  class BackgroundFetchRegistration extends EventTarget { constructor() { illegal(); super(); } }
  ["id", "uploadTotal", "uploaded", "downloadTotal", "downloaded", "result", "failureReason", "recordsAvailable"].forEach(function (k) {
    Object.defineProperty(BackgroundFetchRegistration.prototype, k, { get: function () { return this._f[k]; }, enumerable: true, configurable: true });
  });
  BackgroundFetchRegistration.prototype.abort = function () { var f = this._f; return Promise.resolve(f.result === "" ? (f.result = "failure", f.failureReason = "aborted", true) : false); };
  BackgroundFetchRegistration.prototype.match = function () { return Promise.resolve(undefined); };
  BackgroundFetchRegistration.prototype.matchAll = function () { return Promise.resolve([]); };
  defineHandlers(BackgroundFetchRegistration.prototype, ["progress"]);
  class BackgroundFetchRecord { constructor() { illegal(); } }
  class BackgroundFetchManager {
    constructor() { illegal(); }
    fetch(id, requests, options) {
      var reg = this._reg;
      return new Promise(function (resolve) {
        if (arguments.length === 0 && id === undefined) {}
        id = String(id);
        var list = typeof requests === "string" || (typeof Request === "function" && requests instanceof Request) ? [requests] : __jb.arrayFrom(requests || []);
        if (!list.length) throw new TypeError("BackgroundFetchManager.fetch: at least one request is required");
        list = list.map(function (r) { return r instanceof Request ? r : new Request(r); });
        list.forEach(function (r) {
          var u = new URL(r.url);
          if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) throw new TypeError("BackgroundFetchManager.fetch: requests must use https");
          if (r.mode === "no-cors") throw new TypeError("BackgroundFetchManager.fetch: no-cors requests are not allowed");
        });
        if (!hasActive(reg)) throw new TypeError("BackgroundFetchManager.fetch: the registration has no active worker");
        var m = store(reg, "_bgfetch", function () { return new Map(); });
        if (m.has(id)) throw new TypeError("BackgroundFetchManager.fetch: there already is a fetch with id '" + id + "'");
        if (perm("background-fetch") === "denied") throw new TypeError("BackgroundFetchManager.fetch: background fetch is not allowed");
        var o = Object.create(BackgroundFetchRegistration.prototype);
        try { EventTarget.call(o); } catch (e) {}
        Object.defineProperty(o, "_f", { value: { id: id, uploadTotal: 0, uploaded: 0, downloadTotal: options && options.downloadTotal !== undefined ? Number(options.downloadTotal) : 0, downloaded: 0, result: "", failureReason: "", recordsAvailable: true } });
        m.set(id, o);
        resolve(o);
      });
    }
    get(id) { var reg = this._reg; return new Promise(function (resolve) { var m = store(reg, "_bgfetch", function () { return new Map(); }); resolve(m.get(String(id))); }); }
    getIds() { var reg = this._reg; return new Promise(function (resolve) { resolve(__jb.arrayFrom(store(reg, "_bgfetch", function () { return new Map(); }).keys())); }); }
  }
  lazy("backgroundFetch", BackgroundFetchManager);

  // ================================================================ Content Index
  var CATEGORIES = ["", "homepage", "article", "video", "audio"];
  class ContentIndex {
    constructor() { illegal(); }
    add(description) {
      var reg = this._reg;
      return new Promise(function (resolve) {
        if (!hasActive(reg)) throw new TypeError("ContentIndex.add: the registration has no active worker");
        if (description === null || typeof description !== "object") throw new TypeError("ContentIndex.add: description is required");
        ["id", "title", "description", "url"].forEach(function (k) { if (description[k] === undefined) throw new TypeError("ContentIndex.add: '" + k + "' member is required"); });
        var d = { id: String(description.id), title: String(description.title), description: String(description.description), category: description.category === undefined ? "" : String(description.category), icons: description.icons === undefined ? [] : __jb.arrayFrom(description.icons), url: String(description.url) };
        if (CATEGORIES.indexOf(d.category) < 0) throw new TypeError("ContentIndex.add: invalid category");
        if (!d.id || !d.title || !d.description) throw new TypeError("ContentIndex.add: id, title and description must not be empty");
        var u = new URL(d.url, location.href);
        if (u.origin !== location.origin) throw new TypeError("ContentIndex.add: url must be same-origin");
        var scope = recOf(reg).scope;
        if (scope && u.href.indexOf(scope) !== 0) throw new TypeError("ContentIndex.add: url must be within the registration scope");
        d.icons.forEach(function (ic) { if (!ic || ic.src === undefined) throw new TypeError("ContentIndex.add: icon src is required"); var iu = new URL(String(ic.src), location.href); if (!/^https?:$/.test(iu.protocol)) throw new TypeError("ContentIndex.add: icon URL must be http(s)"); });
        d.url = u.href;
        store(reg, "_index", function () { return new Map(); }).set(d.id, d);
        resolve(undefined);
      });
    }
    delete(id) { var reg = this._reg; return new Promise(function (resolve) { store(reg, "_index", function () { return new Map(); }).delete(String(id)); resolve(undefined); }); }
    getAll() { var reg = this._reg; return new Promise(function (resolve) { resolve(__jb.arrayFrom(store(reg, "_index", function () { return new Map(); }).values()).map(function (d) { return Object.assign({}, d); })); }); }
  }
  lazy("index", ContentIndex);

  // registration.cookies
  Object.defineProperty(ServiceWorkerRegistration.prototype, "cookies", {
    get: function () { var r = recOf(this); if (!this._m_cookies && __jb.newCookieStoreManager) Object.defineProperty(this, "_m_cookies", { value: __jb.newCookieStoreManager(r.scope) }); return this._m_cookies || null; },
    enumerable: true, configurable: true,
  });

  [PushManager, PushSubscription, PushSubscriptionOptions, PushMessageData, SyncManager, PeriodicSyncManager, BackgroundFetchManager, BackgroundFetchRegistration, BackgroundFetchRecord, ContentIndex].forEach(function (C) {
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
    globalThis[C.name] = C;
  });
})();
