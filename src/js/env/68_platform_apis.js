// Part 6c: small platform APIs - Permissions, Notifications, the async Clipboard API with
// copy/cut/paste commands, and the Credential Management API (password / federated
// credentials; public-key credentials come from 68b_webauthn.js).
(function () {
  var define = function (name, value) { Object.defineProperty(globalThis, name, { value: value, writable: true, enumerable: false, configurable: true }); };
  var tag = function (C, name) { Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name || C.name, configurable: true }); };
  var illegal = function () { throw new TypeError("Illegal constructor"); };
  // UA-internal construction: constructors that are not exposed check this token.
  var UA = {};
  var isWorker = !!globalThis.__jb_workerRealm;
  // Shared state (permission store, clipboard, notification list) lives on the top-level realm
  // of the page; worker realms use their owner's.
  var top = function () {
    try { if (__jb.workerOwnerJb) return typeof __jb.workerOwnerJb.topJb === "function" ? __jb.workerOwnerJb.topJb() : __jb.workerOwnerJb; } catch (e) {}
    return typeof __jb.topJb === "function" ? __jb.topJb() : __jb;
  };
  var fullyActive = function () { return !(__jb.navApi && __jb.navApi.fullyActive) || __jb.navApi.fullyActive(); };
  var rejectIn = function (err) { return Promise.reject(err); };

  // ---------------------------------------------------------------- Permissions
  var KNOWN = ("accelerometer ambient-light-sensor background-fetch background-sync bluetooth camera captured-surface-control " +
    "clipboard-read clipboard-write display-capture geolocation gyroscope idle-detection keyboard-lock local-fonts magnetometer " +
    "microphone midi nfc notifications payment-handler persistent-storage pointer-lock push screen-wake-lock speaker-selection " +
    "storage-access system-wake-lock top-level-storage-access window-management xr-spatial-tracking").split(" ");
  // Effective state of a permission: an explicit setting (WebDriver set_permission), else the
  // host's answer for the few permissions the embedder knows about, else "prompt".
  __jb.permissionState = function (name) {
    var t = top(), s = t.permissionStates && t.permissionStates[name];
    if (s) return s;
    if (!__jb.wptMode) {
      try {
        if (name === "notifications") { var p = __jb.native("notification_permission"); return p === "granted" ? "granted" : p === "denied" ? "denied" : "prompt"; }
        if (name === "geolocation") return __jb.native("geolocation") ? "granted" : "prompt";
      } catch (e) {}
    }
    return "prompt";
  };
  __jb.setPermission = function (name, state) {
    name = String(name); state = String(state);
    if (!/^(granted|denied|prompt)$/.test(state)) throw new TypeError("invalid permission state " + state);
    var t = top();
    var old = __jb.permissionState(name);
    (t.permissionStates || (t.permissionStates = {}))[name] = state;
    if (old === state) return;
    // Every live PermissionStatus with that name (any realm of the page) gets a change event.
    (t.permissionStatuses || []).forEach(function (rec) {
      if (rec.name !== name) return;
      var st = rec.status;
      var fire = function () {
        if (st._state === state) return;
        st._state = state;
        if (rec.jb && rec.jb.navApi && rec.jb.navApi.fullyActive && !rec.jb.navApi.fullyActive()) return;
        try { st.dispatchEvent(new rec.Event("change")); } catch (e) {}
      };
      try { (rec.setTimeout || setTimeout)(fire, 0); } catch (e) { fire(); }
    });
    if (name === "notifications") try { t.notificationPermissionChanged = true; } catch (e) {}
  };

  class PermissionStatus extends EventTarget { constructor(tok) { if (tok !== UA) illegal(); super(); } }
  Object.defineProperty(PermissionStatus.prototype, "state", { get: function () { return this._state; }, enumerable: true, configurable: true });
  Object.defineProperty(PermissionStatus.prototype, "name", { get: function () { return this._name; }, enumerable: true, configurable: true });
  __jb.defineEventHandlerProps(PermissionStatus.prototype, ["change"]);
  tag(PermissionStatus);

  function Permissions() { if (arguments[0] !== UA) illegal(); }
  Permissions.prototype.query = function query(desc) {
    if (arguments.length < 1) return rejectIn(new TypeError("Permissions.query: 1 argument required"));
    if (desc === null || typeof desc !== "object") return rejectIn(new TypeError("Permissions.query: argument is not an object"));
    var name;
    try { var n = desc.name; if (n === undefined) throw new TypeError("Permissions.query: 'name' member is required"); name = String(n); } catch (e) { return rejectIn(e); }
    if (KNOWN.indexOf(name) < 0) return rejectIn(new TypeError("'" + name + "' is not a valid value for enumeration PermissionName."));
    if (!fullyActive()) return rejectIn(__jb.domError("InvalidStateError", "The document is not fully active"));
    // Second conversion to the permission's own descriptor type.
    try { if (name === "midi" || name === "push" || name === "camera" || name === "microphone" || name === "clipboard-read" || name === "clipboard-write" || name === "notifications" || name === "geolocation" || name === "storage-access") void desc.name; } catch (e2) { return rejectIn(e2); }
    var st = new PermissionStatus(UA);
    st._name = name; st._state = __jb.permissionState(name);
    var t = top();
    (t.permissionStatuses || (t.permissionStatuses = [])).push({ name: name, status: st, Event: Event, setTimeout: setTimeout, jb: __jb });
    return Promise.resolve(st);
  };
  tag(Permissions);
  define("Permissions", Permissions);
  define("PermissionStatus", PermissionStatus);
  var permissionsObj = new Permissions(UA);
  try { Object.defineProperty(navigator, "permissions", { get: function () { return permissionsObj; }, enumerable: true, configurable: true }); } catch (e) { navigator.permissions = permissionsObj; }

  // ---------------------------------------------------------------- Notifications
  // BCP 47 well-formed + registered-shape check (no extlangs, 2-3 letter languages).
  var validLang = function (s) {
    if (s === "") return true;
    return /^[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|[0-9]{3}))?(-([a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(-[0-9a-wy-z](-[a-z0-9]{2,8})+)*(-x(-[a-z0-9]{1,8})+)?$/i.test(s) || /^x(-[a-z0-9]{1,8})+$/i.test(s);
  };
  var notifPermission = function () { var s = __jb.permissionState("notifications"); return s === "prompt" ? "default" : s; };
  var resolveURL = function (u) { if (u === undefined || u === null) return ""; try { return new URL(String(u), __jb.currentDocument ? __jb.currentDocument.baseURI : location.href).href; } catch (e) { return ""; } };
  var vibratePattern = function (v) {
    if (v === undefined) return [];
    var list = typeof v === "object" && v !== null && typeof v[Symbol.iterator] === "function" ? __jb.arrayFrom(v) : [v];
    list = list.map(function (x) { return Number(x) >>> 0; });
    if (list.length > 10) list = list.slice(0, 10);
    if (list.length && list.length % 2 === 0) list.pop();
    return list.map(function (x) { return Math.min(x, 10000); });
  };
  class Notification extends EventTarget { constructor(title, options) {
    if (arguments.length < 1) throw new TypeError("Notification constructor: 1 argument required");
    if (globalThis.__jb_serviceWorkerRealm || (typeof ServiceWorkerGlobalScope === "function" && globalThis instanceof ServiceWorkerGlobalScope)) throw new TypeError("Illegal constructor: use ServiceWorkerRegistration.showNotification()");
    super();
    initNotification(this, title, options);
    if (this._idl.actions.length) throw new TypeError("Notification constructor: actions are only supported for persistent notifications");
    var self_ = this, granted = notifPermission() === "granted";
    if (granted && !__jb.wptMode) try { __jb.native("notification", { title: this._idl.title, body: this._idl.body }); } catch (e) {}
    setTimeout(function () {
      if (granted) { addShown(self_, null); self_.dispatchEvent(new Event("show")); }
      else self_.dispatchEvent(new Event("error"));
    }, 0);
  } }
  var initNotification = function (n, title, options) {
    var o = options === undefined || options === null ? {} : options;
    if (typeof o !== "object" && typeof o !== "function") throw new TypeError("Notification: options is not an object");
    var d = {};
    // dictionary members in lexicographic order (WebIDL)
    d.actions = o.actions === undefined ? [] : __jb.arrayFrom(o.actions, function (a) {
      if (a === null || typeof a !== "object") throw new TypeError("NotificationAction is not an object");
      if (a.action === undefined || a.title === undefined) throw new TypeError("NotificationAction requires action and title");
      var r = { action: String(a.action), title: String(a.title) };
      if (a.navigate !== undefined) r.navigate = resolveURL(a.navigate);
      if (a.icon !== undefined) r.icon = resolveURL(a.icon);
      return Object.freeze(r);
    });
    d.badge = resolveURL(o.badge);
    d.body = o.body === undefined ? "" : String(o.body);
    var data = o.data === undefined ? null : o.data;
    d.dataSer = data === null ? null : structuredClone(data);
    var dir = o.dir === undefined ? "auto" : String(o.dir);
    if (!/^(auto|ltr|rtl)$/.test(dir)) throw new TypeError("'" + dir + "' is not a valid value for enumeration NotificationDirection.");
    d.dir = dir;
    d.icon = resolveURL(o.icon);
    d.image = resolveURL(o.image);
    var lang = o.lang === undefined ? "" : String(o.lang);
    d.lang = validLang(lang) ? lang : "";
    d.navigate = resolveURL(o.navigate);
    d.renotify = !!o.renotify;
    d.requireInteraction = !!o.requireInteraction;
    d.silent = o.silent === undefined || o.silent === null ? null : !!o.silent;
    d.tag = o.tag === undefined ? "" : String(o.tag);
    d.timestamp = o.timestamp === undefined ? Date.now() : Math.floor(Number(o.timestamp));
    d.vibrate = vibratePattern(o.vibrate);
    d.title = String(title);
    if (d.renotify && d.tag === "") throw new TypeError("Notification: renotify requires a tag");
    if (d.silent === true && d.vibrate.length) throw new TypeError("Notification: silent notifications cannot vibrate");
    Object.defineProperty(n, "_idl", { value: d, configurable: true });
    Object.defineProperty(n, "_vibrateArr", { value: Object.freeze(d.vibrate.slice()), configurable: true });
    Object.defineProperty(n, "_actionsArr", { value: Object.freeze(d.actions.slice()), configurable: true });
    Object.defineProperty(n, "_dataVal", { value: d.dataSer === null ? null : structuredClone(d.dataSer), configurable: true });
  };
  // The list of notifications shown for the page's origin; a new one replaces a shown one with
  // the same tag (and registration).
  var addShown = function (n, scope) {
    var t = top(), list = t.shownNotifications || (t.shownNotifications = []);
    if (n._idl.tag) for (var i = list.length - 1; i >= 0; i--) if (list[i].tag === n._idl.tag && list[i].scope === scope) list.splice(i, 1);
    list.push({ tag: n._idl.tag, scope: scope, n: n, data: n._idl });
  };
  ["title", "dir", "lang", "body", "navigate", "tag", "image", "icon", "badge", "timestamp", "renotify", "silent", "requireInteraction"].forEach(function (a) {
    Object.defineProperty(Notification.prototype, a, { get: function () { if (!this || !this._idl) throw new TypeError("Illegal invocation"); return this._idl[a]; }, enumerable: true, configurable: true });
  });
  Object.defineProperty(Notification.prototype, "vibrate", { get: function () { if (!this || !this._idl) throw new TypeError("Illegal invocation"); return this._vibrateArr; }, enumerable: true, configurable: true });
  Object.defineProperty(Notification.prototype, "actions", { get: function () { if (!this || !this._idl) throw new TypeError("Illegal invocation"); return this._actionsArr; }, enumerable: true, configurable: true });
  Object.defineProperty(Notification.prototype, "data", { get: function () { if (!this || !this._idl) throw new TypeError("Illegal invocation"); return this._dataVal; }, enumerable: true, configurable: true });
  Notification.prototype.close = function close() {
    if (!this || !this._idl) throw new TypeError("Illegal invocation");
    var t = top(), list = t.shownNotifications || [], self_ = this, was = false;
    for (var i = list.length - 1; i >= 0; i--) if (list[i].n === self_ || (self_._persistentId && list[i].id === self_._persistentId)) { list.splice(i, 1); was = true; }
    if (!this._closed && !this._persistentId) { this._closed = true; setTimeout(function () { self_.dispatchEvent(new Event("close")); }, 0); }
    return was ? undefined : undefined;
  };
  Object.defineProperty(Notification, "permission", { get: function () { return notifPermission(); }, enumerable: true, configurable: true });
  Object.defineProperty(Notification, "maxActions", { get: function () { return 2; }, enumerable: true, configurable: true });
  Notification.requestPermission = function requestPermission(cb) {
    var p = notifPermission();
    if (p === "default" && !__jb.wptMode) { try { var h = __jb.native("notification_permission"); if (h === "granted" || h === "denied") p = h; } catch (e) {} }
    if (typeof cb === "function") setTimeout(function () { cb(p); }, 0);
    return Promise.resolve(p);
  };
  __jb.defineEventHandlerProps(Notification.prototype, ["click", "show", "error", "close"]);
  tag(Notification);
  Object.defineProperty(Notification, "length", { value: 1, configurable: true });
  if (isWorker && !globalThis.__jb_serviceWorkerRealm) delete Notification.requestPermission;
  define("Notification", Notification);

  // ServiceWorkerRegistration.showNotification / getNotifications (persistent notifications).
  __jb.installPersistentNotifications = function (Reg) {
    if (!Reg || !Reg.prototype || Reg.prototype.showNotification) return;
    var seq = 0;
    Reg.prototype.showNotification = function showNotification(title, options) {
      var reg = this;
      if (arguments.length < 1) return Promise.reject(new TypeError("showNotification: 1 argument required"));
      var n;
      try {
        n = Reflect.construct(EventTarget, [], Notification);
        initNotification(n, title, options);
      } catch (e) { return Promise.reject(e); }
      if (!reg.active) return Promise.reject(new TypeError("showNotification: the registration has no active worker"));
      if (notifPermission() !== "granted") return Promise.reject(new TypeError("showNotification: permission is not granted"));
      n._persistentId = ++seq;
      var t = top(), list = t.shownNotifications || (t.shownNotifications = []);
      if (n._idl.tag) for (var i = list.length - 1; i >= 0; i--) if (list[i].tag === n._idl.tag && list[i].scope === reg.scope) list.splice(i, 1);
      list.push({ tag: n._idl.tag, scope: reg.scope, id: n._persistentId, data: n._idl, n: null, options: options });
      return Promise.resolve(undefined);
    };
    Reg.prototype.getNotifications = function getNotifications(filter) {
      var reg = this, tagf = filter && filter.tag !== undefined ? String(filter.tag) : "";
      var t = top(), list = (t.shownNotifications || []).filter(function (r) { return r.id && r.scope === reg.scope && (!tagf || r.tag === tagf); });
      return Promise.resolve(list.map(function (r) {
        var n = Reflect.construct(EventTarget, [], Notification);
        Object.defineProperty(n, "_idl", { value: r.data, configurable: true });
        Object.defineProperty(n, "_vibrateArr", { value: Object.freeze(r.data.vibrate.slice()), configurable: true });
        Object.defineProperty(n, "_actionsArr", { value: Object.freeze(r.data.actions.slice()), configurable: true });
        Object.defineProperty(n, "_dataVal", { value: r.data.dataSer === null ? null : structuredClone(r.data.dataSer), configurable: true });
        n._persistentId = r.id;
        return n;
      }));
    };
  };
  if (typeof ServiceWorkerRegistration === "function") __jb.installPersistentNotifications(ServiceWorkerRegistration);

  if (isWorker) return; // the rest is Window-only

  // ---------------------------------------------------------------- Clipboard
  var clip = function () { var t = top(); return t.clipStore || (t.clipStore = { items: [], changeId: 0 }); };
  var MANDATORY = { "text/plain": 1, "text/html": 1, "image/png": 1, "text/uri-list": 1, "image/svg+xml": 1 };
  var essence = function (t) { var m = __jb.parseMime(t); return m ? m.essence : null; };
  var validItemType = function (t) {
    if (t.indexOf("web ") === 0) return !!__jb.parseMime(t.slice(4));
    return !!__jb.parseMime(t);
  };
  var isPng = function (bytes) { return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47; };
  // Writes the given representations to the clipboard and fires clipboardchange at every
  // realm's Clipboard object of the page.
  var commit = function (reps) {
    var c = clip();
    c.items = [reps];
    c.changeId++;
    if (!__jb.wptMode) {
      var text = reps.filter(function (r) { return r.type === "text/plain"; })[0];
      if (text) try { __jb.native("clipboard", { op: "write", text: text.text }); } catch (e) {}
    }
    // clipboardchange exposes only the mandatory data types
    var types = reps.map(function (r) { return r.type; }).filter(function (t) { return t === "text/plain" || t === "text/html" || t === "image/png"; });
    var t = top();
    (t.clipboardObjects || []).forEach(function (rec) {
      try {
        (rec.queueMicrotask || rec.setTimeout)(function () {
          try {
            var doc = rec.jb.currentDocument;
            if (doc && typeof doc.hasFocus === "function" && !doc.hasFocus()) return;
            rec.obj.dispatchEvent(new rec.ClipboardChangeEvent("clipboardchange", { types: types, changeId: BigInt(c.changeId) }));
          } catch (e) {}
        });
      } catch (e) {}
    });
  };
  __jb.clipboardWrite = commit;
  var readPerm = function (kind) {
    var s = __jb.permissionState(kind);
    if (s === "denied") return false;
    if (s === "granted") return true;
    return __jb.wptMode ? __jb.hasTransientActivation() || true : true;
  };
  var focusedDoc = function () { var d = __jb.currentDocument; try { return !d || typeof d.hasFocus !== "function" || d.hasFocus(); } catch (e) { return true; } };

  function ClipboardItem(items, options) {
    if (!new.target) throw new TypeError("ClipboardItem constructor: 'new' is required");
    if (arguments.length < 1) throw new TypeError("ClipboardItem constructor: 1 argument required");
    if (items === null || typeof items !== "object" || items instanceof Blob) throw new TypeError("ClipboardItem constructor: argument is not a record");
    var keys = Object.keys(items);
    if (!keys.length) throw new TypeError("ClipboardItem constructor: empty record");
    var style = options && options.presentationStyle !== undefined ? String(options.presentationStyle) : "unspecified";
    if (!/^(unspecified|inline|attachment)$/.test(style)) throw new TypeError("invalid presentationStyle");
    var map = Object.create(null);
    keys.forEach(function (k) {
      if (!validItemType(k)) throw new TypeError("ClipboardItem constructor: invalid type '" + k + "'");
      map[k] = items[k];
    });
    Object.defineProperty(this, "_items", { value: map });
    Object.defineProperty(this, "_types", { value: Object.freeze(keys.slice()) });
    Object.defineProperty(this, "_style", { value: style });
  }
  Object.defineProperty(ClipboardItem.prototype, "types", { get: function () { return this._types; }, enumerable: true, configurable: true });
  Object.defineProperty(ClipboardItem.prototype, "presentationStyle", { get: function () { return this._style; }, enumerable: true, configurable: true });
  ClipboardItem.prototype.getType = function getType(type) {
    if (arguments.length < 1) return Promise.reject(new TypeError("getType: 1 argument required"));
    type = String(type);
    if (!validItemType(type)) return Promise.reject(new TypeError("getType: invalid type '" + type + "'"));
    var self_ = this;
    var cached = this._resolved || (Object.defineProperty(this, "_resolved", { value: Object.create(null) }), this._resolved);
    if (!(type in this._items)) return Promise.reject(__jb.domError("NotFoundError", "The type '" + type + "' was not found"));
    if (type in cached) return Promise.resolve(cached[type]);
    if (self_._stale && self_._stale()) return Promise.reject(__jb.domError("InvalidStateError", "The clipboard contents changed"));
    return Promise.resolve(this._items[type]).then(function (v) {
      var b = v instanceof Blob ? v : new Blob([String(v)], { type: type });
      cached[type] = b;
      return b;
    });
  };
  ClipboardItem.supports = function supports(type) {
    if (arguments.length < 1) throw new TypeError("supports: 1 argument required");
    type = String(type);
    if (MANDATORY[type]) return true;
    if (type.indexOf("web ") === 0) { var m = __jb.parseMime(type.slice(4)); return !!m && type.slice(4) === m.essence && !/;/.test(type); }
    return false;
  };
  tag(ClipboardItem);
  define("ClipboardItem", ClipboardItem);

  class ClipboardChangeEvent extends Event {
    constructor(type, init) {
      if (arguments.length < 1) throw new TypeError("ClipboardChangeEvent constructor: 1 argument required");
      super(type, init); init = init || {};
      Object.defineProperty(this, "_types", { value: Object.freeze(init.types === undefined ? [] : __jb.arrayFrom(init.types, String)) });
      Object.defineProperty(this, "_changeId", { value: init.changeId === undefined ? 0n : BigInt(init.changeId) });
    }
    get types() { return this._types; }
    get changeId() { return this._changeId; }
  }
  define("ClipboardChangeEvent", ClipboardChangeEvent);

  class Clipboard extends EventTarget { constructor(tok) { if (tok !== UA) illegal(); super(); } }
  var notAllowed = function (msg) { return __jb.domError("NotAllowedError", msg || "Clipboard access is not allowed"); };
  var blobBytes = function (b) { return b.arrayBuffer().then(function (ab) { return new Uint8Array(ab); }); };
  Clipboard.prototype.writeText = function writeText(data) {
    if (arguments.length < 1) return Promise.reject(new TypeError("writeText: 1 argument required"));
    data = String(data);
    if (!readPerm("clipboard-write")) return Promise.reject(notAllowed());
    if (!focusedDoc()) return Promise.reject(notAllowed("Document is not focused"));
    return new Promise(function (resolve) { setTimeout(function () { commit([{ type: "text/plain", text: data, blob: new Blob([data], { type: "text/plain" }) }]); resolve(undefined); }, 0); });
  };
  Clipboard.prototype.write = function write(data) {
    if (arguments.length < 1) return Promise.reject(new TypeError("write: 1 argument required"));
    var items;
    try {
      if (data === null || typeof data !== "object" || typeof data[Symbol.iterator] !== "function") throw new TypeError("write: argument is not a sequence");
      items = __jb.arrayFrom(data);
      items.forEach(function (it) { if (!(it instanceof ClipboardItem)) throw new TypeError("write: element is not a ClipboardItem"); });
    } catch (e) { return Promise.reject(e); }
    if (!readPerm("clipboard-write")) return Promise.reject(notAllowed());
    if (!focusedDoc()) return Promise.reject(notAllowed("Document is not focused"));
    if (items.length > 1) return Promise.reject(notAllowed("Support for multiple ClipboardItems is not implemented."));
    if (!items.length) return new Promise(function (resolve) { setTimeout(function () { commit([]); resolve(undefined); }, 0); });
    var item = items[0];
    if (item._types.filter(function (t) { return t.indexOf("web ") === 0; }).length > 100) return Promise.reject(notAllowed("Too many custom formats"));
    return Promise.all(item._types.map(function (type) {
      return Promise.resolve(item._items[type]).then(function (v) {
        var blob = v instanceof Blob ? v : new Blob([String(v)], { type: type.indexOf("web ") === 0 ? type : type });
        if (!(v instanceof Blob) && typeof v !== "string") blob = new Blob([String(v)], { type: type });
        var base = type.indexOf("web ") === 0 ? null : essence(type);
        if (base && !MANDATORY[base]) throw notAllowed("Type " + type + " is not supported for writing");
        if (v instanceof Blob && blob.type) {
          if (!base && blob.type.toLowerCase() !== type.toLowerCase()) throw notAllowed("Type mismatch for " + type);
          if (base && essence(blob.type) !== base) throw notAllowed("Type mismatch for " + type);
        }
        var fromString = !(v instanceof Blob);
        return blobBytes(blob).then(function (bytes) {
          if (base === "image/png" && !isPng(bytes)) { if (fromString) throw new TypeError("write: image/png data is not a PNG image"); throw __jb.domError("DataError", "write: image/png data is not a PNG image"); }
          var text = /^text\/|^image\/svg/.test(base || "") || !base ? new TextDecoder().decode(bytes) : null;
          return { type: type, text: text, blob: new Blob([bytes], { type: type }) };
        });
      });
    })).then(function (reps) {
      return new Promise(function (resolve) { setTimeout(function () { commit(reps); resolve(undefined); }, 0); });
    }, function (e) {
      if (e instanceof TypeError) throw e;
      throw e && e.name ? e : notAllowed(String(e));
    });
  };
  var currentReps = function () {
    var c = clip();
    if (!c.items.length && !__jb.wptMode) {
      try { var r = __jb.native("clipboard", { op: "read" }); if (r && typeof r.text === "string") return [{ type: "text/plain", text: r.text, blob: new Blob([r.text], { type: "text/plain" }) }]; } catch (e) {}
    }
    return c.items[0] || [];
  };
  Clipboard.prototype.readText = function readText() {
    if (!readPerm("clipboard-read")) return Promise.reject(notAllowed());
    if (!focusedDoc()) return Promise.reject(notAllowed("Document is not focused"));
    var reps = currentReps(), t = reps.filter(function (r) { return r.type === "text/plain"; })[0];
    return new Promise(function (resolve) { setTimeout(function () { resolve(t ? t.text : ""); }, 0); });
  };
  Clipboard.prototype.read = function read(formats) {
    var unsanitized = [];
    try { if (formats !== undefined && formats !== null && formats.unsanitized !== undefined) unsanitized = __jb.arrayFrom(formats.unsanitized, String); } catch (e) { return Promise.reject(e); }
    if (unsanitized.some(function (u) { return u !== "text/html"; })) return Promise.reject(notAllowed("Only text/html can be read unsanitized"));
    if (!readPerm("clipboard-read")) return Promise.reject(notAllowed());
    if (!focusedDoc()) return Promise.reject(notAllowed("Document is not focused"));
    var reps = currentReps(), c = clip(), changeAt = c.changeId;
    return new Promise(function (resolve) {
      setTimeout(function () {
        var rec = {};
        reps.forEach(function (r) {
          var b = r.blob;
          if (r.type === "text/html" && unsanitized.indexOf("text/html") < 0) b = new Blob([sanitizeHtml(r.text || "")], { type: "text/html" });
          rec[r.type] = b;
        });
        if (!reps.length) { resolve([]); return; }
        var item = new ClipboardItem(rec);
        Object.defineProperty(item, "_stale", { value: function () { return clip().changeId !== changeAt; } });
        resolve([item]);
      }, 0);
    });
  };
  // Sanitized HTML read: scripts and event handler attributes removed, wrapped as a fragment.
  var sanitizeHtml = function (html) {
    try {
      var doc = __jb.currentDocument.implementation.createHTMLDocument("");
      doc.body.innerHTML = html;
      __jb.arrayFrom(doc.querySelectorAll("script, iframe, object, embed")).forEach(function (n) { n.remove(); });
      __jb.arrayFrom(doc.querySelectorAll("*")).forEach(function (el) { __jb.arrayFrom(el.attributes).forEach(function (a) { if (/^on/i.test(a.name)) el.removeAttribute(a.name); }); });
      return doc.body.innerHTML;
    } catch (e) { return html; }
  };
  __jb.defineEventHandlerProps(Clipboard.prototype, ["clipboardchange"]);
  tag(Clipboard);
  define("Clipboard", Clipboard);
  var clipboardObj = new Clipboard(UA);
  (top().clipboardObjects || (top().clipboardObjects = [])).push({ obj: clipboardObj, setTimeout: setTimeout, queueMicrotask: queueMicrotask, ClipboardChangeEvent: ClipboardChangeEvent, jb: __jb });
  try { Object.defineProperty(navigator, "clipboard", { get: function () { return clipboardObj; }, enumerable: true, configurable: true }); } catch (e) {}

  // copy / cut / paste: clipboard events at the focused element (or the selection's element),
  // default actions on the selection, and the clipboard data store written on copy/cut.
  // Plain text of a selection as it renders: collapsible white space collapsed per the text's
  // white-space style, line breaks preserved in pre-formatted text (CRLF on Windows).
  var rangeText = function (r) {
    var out = "", lastSpace = true;
    var root = r.commonAncestorContainer, doc = root.ownerDocument || root;
    var walker = doc.createTreeWalker(root.nodeType === 3 ? root.parentNode : root, 4);
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!r.intersectsNode(n)) continue;
      var t = n.data;
      if (n === r.endContainer) t = t.slice(0, r.endOffset);
      if (n === r.startContainer) t = t.slice(r.startOffset);
      var ws = ""; try { var pcs = getComputedStyle(n.parentNode); var wc = pcs.getPropertyValue("white-space-collapse"); ws = wc === "preserve" || wc === "break-spaces" ? "pre" : wc === "preserve-breaks" ? "pre-line" : (wc ? "normal" : pcs.whiteSpace || ""); } catch (e) {}
      if (/^(pre|pre-wrap|break-spaces)$/.test(ws)) { out += t; lastSpace = /\s$/.test(t); continue; }
      if (ws === "pre-line") t = t.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n");
      else t = t.replace(/[\t\n\f\r ]+/g, " ");
      if (lastSpace) t = t.replace(/^ /, "");
      out += t; if (t) lastSpace = / $/.test(t);
    }
    out = out.replace(/ $/, "");
    if (/Win/.test(navigator.platform || "")) out = out.replace(/\r?\n/g, "\r\n");
    return out;
  };
  __jb.clipboardCommand = function (cmd, doc) {
    doc = doc || __jb.currentDocument;
    var sel = doc.getSelection ? doc.getSelection() : null;
    var target = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
    if (!target && sel && sel.rangeCount) { var n = sel.getRangeAt(0).startContainer; target = n.nodeType === 1 ? n : n.parentNode; }
    if (!target) target = doc.body || doc.documentElement;
    if (!target) return false;
    var dt = new DataTransfer();
    if (cmd === "paste") {
      currentReps().forEach(function (r) { if (r.text !== null && r.text !== undefined && r.type.indexOf("web ") !== 0) try { dt.setData(r.type, r.text); } catch (e) {} });
    }
    var ev = new ClipboardEvent(cmd, { bubbles: true, cancelable: true, composed: true, clipboardData: dt });
    __jb.setTrusted(ev, true); ev._trustedDispatch = true;
    var notCanceled = target.dispatchEvent(ev);
    if (cmd === "paste") {
      if (notCanceled) {
        var text = dt.getData("text/plain");
        if (text && __jb.editing && __jb.editing.isEditable && (doc.activeElement && (doc.activeElement.isContentEditable))) { try { doc.execCommand("insertText", false, text); } catch (e) {} }
        else if (text && target && typeof target.setRangeText === "function") { try { target.setRangeText(text, target.selectionStart, target.selectionEnd, "end"); } catch (e) {} }
      }
      return true;
    }
    if (!notCanceled) {
      // the page set the data: write the data store's items
      var reps = [];
      dt.items._list.forEach(function (it) { if (it.kind === "string") reps.push({ type: it.type, text: it._data, blob: new Blob([it._data], { type: it.type }) }); });
      if (reps.length) commit(reps);
      return true;
    }
    var selText = "", selHtml = "";
    if (target && typeof target.selectionStart === "number" && /^(input|textarea)$/.test(target.localName || "")) {
      try { selText = String(target.value).slice(target.selectionStart, target.selectionEnd); } catch (e) {}
    } else if (sel && sel.rangeCount && !sel.isCollapsed) {
      selText = rangeText(sel.getRangeAt(0));
      try { var box = doc.createElement("div"); box.appendChild(sel.getRangeAt(0).cloneContents()); selHtml = box.innerHTML; } catch (e) {}
    }
    if (selText || selHtml) {
      var out = [{ type: "text/plain", text: selText, blob: new Blob([selText], { type: "text/plain" }) }];
      if (selHtml) out.push({ type: "text/html", text: selHtml, blob: new Blob([selHtml], { type: "text/html" }) });
      commit(out);
      if (cmd === "cut") {
        if (target && typeof target.setRangeText === "function" && /^(input|textarea)$/.test(target.localName || "")) { try { target.setRangeText("", target.selectionStart, target.selectionEnd, "end"); } catch (e) {} }
        else try { doc.execCommand("delete"); } catch (e) {}
      }
    }
    return true;
  };

  // ---------------------------------------------------------------- Credential Management
  function Credential() { if (arguments[0] !== UA) illegal(); }
  Object.defineProperty(Credential.prototype, "id", { get: function () { return this._id; }, enumerable: true, configurable: true });
  Object.defineProperty(Credential.prototype, "type", { get: function () { return this._type; }, enumerable: true, configurable: true });
  Credential.isConditionalMediationAvailable = function isConditionalMediationAvailable() { return Promise.resolve(false); };
  tag(Credential);
  var userData = function (C) {
    Object.defineProperty(C.prototype, "name", { get: function () { return this._name; }, enumerable: true, configurable: true });
    Object.defineProperty(C.prototype, "iconURL", { get: function () { return this._iconURL; }, enumerable: true, configurable: true });
  };
  var originOf = function () { try { return location.origin; } catch (e) { return ""; } };
  var reqStr = function (o, k, iface) { if (o[k] === undefined) throw new TypeError(iface + ": required member " + k + " is undefined"); return String(o[k]); };
  var iconUrl = function (v) { if (v === undefined || v === "") return ""; var u; try { u = new URL(String(v), __jb.currentDocument.baseURI); } catch (e) { throw new TypeError("iconURL is not a valid URL"); } if (u.protocol !== "https:" && !/^(localhost|127\.)/.test(u.hostname)) throw new TypeError("iconURL must be a potentially trustworthy URL"); return u.href; };
  var passwordFromForm = function (form) {
    var data = { origin: originOf() };
    __jb.arrayFrom(form.elements || []).forEach(function (f) {
      var ac = String(f.getAttribute && f.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
      var v = f.value;
      if (ac.indexOf("username") >= 0 && data.id === undefined) data.id = v;
      else if ((ac.indexOf("current-password") >= 0 || ac.indexOf("new-password") >= 0) && (data.password === undefined || ac.indexOf("new-password") >= 0)) data.password = v;
      else if (ac.indexOf("photo") >= 0) data.iconURL = v;
      else if (ac.indexOf("name") >= 0 || ac.indexOf("nickname") >= 0) data.name = v;
    });
    return data;
  };
  function PasswordCredential(init) {
    if (!new.target) throw new TypeError("PasswordCredential constructor: 'new' is required");
    if (arguments.length < 1) throw new TypeError("PasswordCredential constructor: 1 argument required");
    var d = init;
    if (typeof HTMLFormElement === "function" && d instanceof HTMLFormElement) d = passwordFromForm(d);
    else if (d === null || typeof d !== "object") throw new TypeError("PasswordCredential: argument is not a PasswordCredentialData or HTMLFormElement");
    var icon = d.iconURL, id = reqStr(d, "id", "PasswordCredentialData"), name = d.name === undefined ? "" : String(d.name);
    var origin = reqStr(d, "origin", "PasswordCredentialData"), password = reqStr(d, "password", "PasswordCredentialData");
    if (id === "" || password === "" || origin === "") throw new TypeError("PasswordCredential: id, origin and password must not be empty");
    this._id = id; this._type = "password"; this._name = name; this._iconURL = iconUrl(icon); this._password = password; this._origin = origin;
  }
  PasswordCredential.prototype = Object.create(Credential.prototype, { constructor: { value: PasswordCredential, writable: true, configurable: true } });
  Object.setPrototypeOf(PasswordCredential, Credential);
  Object.defineProperty(PasswordCredential.prototype, "password", { get: function () { return this._password; }, enumerable: true, configurable: true });
  userData(PasswordCredential); tag(PasswordCredential);
  function FederatedCredential(init) {
    if (!new.target) throw new TypeError("FederatedCredential constructor: 'new' is required");
    if (arguments.length < 1 || init === null || typeof init !== "object") throw new TypeError("FederatedCredential: argument is not a FederatedCredentialInit");
    var icon = init.iconURL, id = reqStr(init, "id", "FederatedCredentialInit"), name = init.name === undefined ? "" : String(init.name);
    var origin = reqStr(init, "origin", "FederatedCredentialInit"), provider = reqStr(init, "provider", "FederatedCredentialInit");
    var protocol = init.protocol === undefined ? null : String(init.protocol);
    if (id === "") throw new TypeError("FederatedCredential: id must not be empty");
    var pu; try { pu = new URL(provider); } catch (e) { throw new TypeError("FederatedCredential: provider is not a valid URL"); }
    this._id = id; this._type = "federated"; this._name = name; this._iconURL = iconUrl(icon); this._provider = pu.origin; this._protocol = protocol; this._origin = origin;
  }
  FederatedCredential.prototype = Object.create(Credential.prototype, { constructor: { value: FederatedCredential, writable: true, configurable: true } });
  Object.setPrototypeOf(FederatedCredential, Credential);
  Object.defineProperty(FederatedCredential.prototype, "provider", { get: function () { return this._provider; }, enumerable: true, configurable: true });
  Object.defineProperty(FederatedCredential.prototype, "protocol", { get: function () { return this._protocol; }, enumerable: true, configurable: true });
  userData(FederatedCredential); tag(FederatedCredential);
  // Opaque or cross-origin frames without permission get NotAllowedError.
  // Same origin with all ancestors, walking the raw parent globals (frameContext), with the
  // effective origins the cross-origin model uses (sandboxed frames are opaque).
  var eo = function (w) { return __jb.effectiveOrigin ? __jb.effectiveOrigin(w) : (function () { try { return w.location.origin; } catch (e) { return "null"; } })(); };
  var isOpaque = function (o) { return __jb.isOpaqueOrigin ? __jb.isOpaqueOrigin(o) : !o || o === "null"; };
  var sameOriginWithAncestors = function () {
    var mine = eo(globalThis);
    if (isOpaque(mine)) return false;
    var j = __jb, w = globalThis;
    for (var i = 0; i < 32; i++) {
      var fc = j.frameContext, p = fc && fc.parent;
      if (!p || p === w) break;
      if (eo(p) !== mine) return false;
      w = p; j = p.__jb; if (!j) return false;
    }
    return true;
  };
  var opaque = function () { return isOpaque(eo(globalThis)); };
  __jb.credentialSameOriginWithAncestors = sameOriginWithAncestors;
  function CredentialsContainer() { if (arguments[0] !== UA) illegal(); }
  var withSignal = function (options, run) {
    var signal = options && options.signal;
    if (signal !== undefined && signal !== null && !(signal instanceof AbortSignal)) return Promise.reject(new TypeError("signal is not an AbortSignal"));
    if (signal && signal.aborted) return Promise.reject(signal.reason);
    if (!fullyActive()) return Promise.reject(__jb.domError("InvalidStateError", "The document is not fully active"));
    return new Promise(function (resolve, reject) {
      var done = false;
      var finish = function (f, v) { if (done) return; done = true; f(v); };
      if (signal) signal.addEventListener("abort", function () { finish(reject, signal.reason); });
      var p;
      try { p = run(signal); } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function (v) { setTimeout(function () { finish(resolve, v); }, 0); }, function (e) { setTimeout(function () { finish(reject, e); }, 0); });
    });
  };
  var sync = function (fn) { try { return fn(); } catch (e) { return { __err: e }; } };
  CredentialsContainer.prototype.get = function get(options) {
    if (options !== undefined && options !== null && typeof options !== "object") return Promise.reject(new TypeError("get: options is not an object"));
    options = options || {};
    var med = options.mediation === undefined ? "optional" : String(options.mediation);
    if (!/^(silent|optional|conditional|required)$/.test(med)) return Promise.reject(new TypeError("invalid mediation"));
    if (options.uiMode !== undefined && String(options.uiMode) !== "immediate") return Promise.reject(new TypeError("invalid uiMode"));
    var hasPk = options.publicKey !== undefined, hasPw = !!options.password, hasFed = options.federated !== undefined, hasOtp = options.otp !== undefined, hasId = options.identity !== undefined, hasDigital = options.digital !== undefined;
    if (hasPk && (options.publicKey === null || typeof options.publicKey !== "object")) return Promise.reject(new TypeError("publicKey is not an object"));
    if ([hasPw || hasFed, hasPk, hasOtp, hasId, hasDigital].filter(Boolean).length > 1) return Promise.reject(__jb.domError("NotSupportedError", "Only one credential type may be requested"));
    if (opaque() && (hasPw || hasFed)) return Promise.reject(__jb.domError("SecurityError", "Credentials are not available to opaque origins"));
    return withSignal(options, function (signal) {
      if (hasPk) {
        if (!__jb.webauthn) throw __jb.domError("NotSupportedError", "Public key credentials are not supported");
        if (med === "conditional" && (hasPw || hasFed)) throw __jb.domError("NotSupportedError", "conditional mediation with other types");
        return __jb.webauthn.get(options.publicKey, { mediation: med, uiMode: options.uiMode, signal: signal });
      }
      if (hasOtp) {
        if (!sameOriginWithAncestors()) throw __jb.domError("NotAllowedError", "OTP credentials require a same-origin frame");
        throw __jb.domError("NotSupportedError", "OTP credentials are not supported");
      }
      if (!hasPw && !hasFed && !hasId && !hasDigital) throw __jb.domError("NotSupportedError", "No credential type requested");
      if (med === "conditional") throw __jb.domError("NotSupportedError", "conditional mediation needs publicKey");
      if (!sameOriginWithAncestors()) throw __jb.domError("NotAllowedError", "Credentials from a cross-origin frame");
      // no credential store; a combined password + federated request would show an account
      // chooser, which needs transient activation
      if (hasPw && hasFed && med !== "silent" && !(__jb.hasTransientActivation && __jb.hasTransientActivation())) throw __jb.domError("NotAllowedError", "The request requires transient activation");
      return null;
    });
  };
  CredentialsContainer.prototype.store = function store(credential) {
    if (arguments.length < 1 || !(credential instanceof Credential)) return Promise.reject(new TypeError("store: argument is not a Credential"));
    if (opaque()) return Promise.reject(__jb.domError("SecurityError", "Credentials are not available to opaque origins"));
    return withSignal({}, function () {
      if (!sameOriginWithAncestors()) throw __jb.domError("NotAllowedError", "Storing credentials from a cross-origin frame");
      if (credential.type === "public-key") throw __jb.domError("NotSupportedError", "public-key credentials cannot be stored");
      return undefined;
    });
  };
  CredentialsContainer.prototype.create = function create(options) {
    if (options !== undefined && options !== null && typeof options !== "object") return Promise.reject(new TypeError("create: options is not an object"));
    options = options || {};
    var kinds = [];
    if (options.password !== undefined) kinds.push("password");
    if (options.federated !== undefined) kinds.push("federated");
    if (options.publicKey !== undefined) kinds.push("publicKey");
    // bogus data of any requested kind is a TypeError (dictionary conversion happens first)
    var conv = sync(function () {
      if (options.password !== undefined && (options.password === null || (typeof options.password !== "object"))) throw new TypeError("password is not a PasswordCredentialInit");
      if (options.federated !== undefined && (options.federated === null || typeof options.federated !== "object")) throw new TypeError("federated is not a FederatedCredentialInit");
      if (options.publicKey !== undefined && (options.publicKey === null || typeof options.publicKey !== "object")) throw new TypeError("publicKey is not a PublicKeyCredentialCreationOptions");
      var med = options.mediation === undefined ? "optional" : String(options.mediation);
      if (!/^(silent|optional|conditional|required)$/.test(med)) throw new TypeError("invalid mediation");
      return null;
    });
    if (conv && conv.__err) return Promise.reject(conv.__err);
    if (opaque() && (kinds.indexOf("password") >= 0 || kinds.indexOf("federated") >= 0)) return Promise.reject(__jb.domError("SecurityError", "Credentials are not available to opaque origins"));
    return withSignal(options, function (signal) {
      if (kinds.length !== 1) throw __jb.domError("NotSupportedError", kinds.length ? "Only one credential type may be created" : "No credential type requested");
      if (kinds[0] === "password") {
        var d = options.password;
        if (!(typeof HTMLFormElement === "function" && d instanceof HTMLFormElement)) { d = Object.assign({}, d); if (d.origin === undefined) d.origin = originOf(); }
        return new PasswordCredential(d);
      }
      if (kinds[0] === "federated") {
        var f = Object.assign({}, options.federated); if (f.origin === undefined) f.origin = originOf();
        return new FederatedCredential(f);
      }
      if (!__jb.webauthn) throw __jb.domError("NotSupportedError", "Public key credentials are not supported");
      return __jb.webauthn.create(options.publicKey, { signal: signal, mediation: options.mediation });
    });
  };
  CredentialsContainer.prototype.preventSilentAccess = function preventSilentAccess() {
    if (!fullyActive()) return Promise.reject(__jb.domError("InvalidStateError", "The document is not fully active"));
    return Promise.resolve(undefined);
  };
  tag(CredentialsContainer);
  [["Credential", Credential], ["PasswordCredential", PasswordCredential], ["FederatedCredential", FederatedCredential], ["CredentialsContainer", CredentialsContainer]].forEach(function (p) { define(p[0], p[1]); });
  [Permissions, ClipboardItem, Credential, PasswordCredential, FederatedCredential, CredentialsContainer].forEach(function (C) { try { Object.defineProperty(C, "prototype", { writable: false }); } catch (e) {} });
  __jb.credentialCtorToken = UA;
  var credentialsObj = new CredentialsContainer(UA);
  try { Object.defineProperty(navigator, "credentials", { get: function () { return credentialsObj; }, enumerable: true, configurable: true }); } catch (e) {}

  // [SecureContext] members disappear in insecure documents.
  var applySecure = __jb.applySecureContext;
  __jb.applySecureContext = function (url) {
    if (applySecure) applySecure.apply(this, arguments);
    if (__jb.secureContext === false) {
      ["Clipboard", "ClipboardItem", "Credential", "PasswordCredential", "FederatedCredential", "CredentialsContainer", "PublicKeyCredential", "AuthenticatorResponse", "AuthenticatorAttestationResponse", "AuthenticatorAssertionResponse"].forEach(function (n) { try { delete globalThis[n]; } catch (e) {} });
      try { delete navigator.clipboard; delete navigator.credentials; } catch (e) {}
    }
  };
})();
