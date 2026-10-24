// Part 11e: small device and platform APIs as interfaces with their spec checks: Geolocation,
// ScreenOrientation, Screen Wake Lock, Idle Detection, Battery Status, Network Information,
// User-Agent Client Hints, Badging, Keyboard Map / Lock, EyeDropper, Window Management,
// Web Share and the Contact Picker. Without hardware or UI behind them, requests that need a
// user decision end like a declined prompt.
(function () {
  if (globalThis.__jb_workerRealm) return;
  var dom = function (n, m) { return __jb.domError(n, m); };
  var TOKEN = {};
  var illegal = function () { throw new TypeError("Illegal constructor"); };
  var make = function (C, fields) { var o = Object.create(C.prototype); if (fields) Object.keys(fields).forEach(function (k) { Object.defineProperty(o, k, { value: fields[k], writable: true }); }); return o; };
  var fullyActive = function () { try { return !(__jb.navApi && __jb.navApi.fullyActive) || __jb.navApi.fullyActive(); } catch (e) { return true; } };
  var activation = function () { return typeof __jb.hasTransientActivation === "function" && __jb.hasTransientActivation(); };
  var consume = function () { if (typeof __jb.consumeUserActivation === "function") __jb.consumeUserActivation(); };
  var perm = function (n) { try { return __jb.permissionState(n); } catch (e) { return "prompt"; } };
  var policyAllows = function (feature) { try { return !__jb.permissionsPolicyAllows || __jb.permissionsPolicyAllows(feature); } catch (e) { return true; } };
  var isTop = function () { try { return globalThis.top === globalThis; } catch (e) { return false; } };
  var hidden = function () { try { return document.visibilityState === "hidden"; } catch (e) { return false; } };
  var handler = function (proto, name) {
    var slot = "_on" + name;
    Object.defineProperty(proto, "on" + name, {
      get: function () { return this[slot] === undefined ? null : this[slot]; },
      set: function (v) {
        var self_ = this;
        if (!this["_onL" + name]) { Object.defineProperty(this, "_onL" + name, { value: function (e) { var h = self_[slot]; if (typeof h === "function") { var r = h.call(self_, e); if (r === false) e.preventDefault(); } }, configurable: true }); this.addEventListener(name, this["_onL" + name]); }
        Object.defineProperty(this, slot, { value: typeof v === "function" || (v && typeof v === "object") ? v : null, writable: true, configurable: true });
      },
      enumerable: true, configurable: true,
    });
  };
  var defineNav = function (name, getter) { try { Object.defineProperty(navigator, name, { get: getter, enumerable: true, configurable: true }); } catch (e) {} };
  var exportAll = function (list) { list.forEach(function (C) { if (!Object.prototype.hasOwnProperty.call(C.prototype, Symbol.toStringTag)) Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true }); globalThis[C.name] = C; }); };

  // ================================================================ Geolocation
  class GeolocationCoordinates {
    constructor() { illegal(); }
    get accuracy() { return this._c.accuracy; } get latitude() { return this._c.latitude; } get longitude() { return this._c.longitude; }
    get altitude() { return this._c.altitude; } get altitudeAccuracy() { return this._c.altitudeAccuracy; } get heading() { return this._c.heading; } get speed() { return this._c.speed; }
    toJSON() { var c = this._c; return { accuracy: c.accuracy, latitude: c.latitude, longitude: c.longitude, altitude: c.altitude, altitudeAccuracy: c.altitudeAccuracy, heading: c.heading, speed: c.speed }; }
  }
  class GeolocationPosition {
    constructor() { illegal(); }
    get coords() { return this._coords; }
    get timestamp() { return this._ts; }
    toJSON() { return { coords: this._coords.toJSON(), timestamp: this._ts }; }
  }
  class GeolocationPositionError {
    constructor() { illegal(); }
    get code() { return this._code; }
    get message() { return this._msg; }
  }
  [["PERMISSION_DENIED", 1], ["POSITION_UNAVAILABLE", 2], ["TIMEOUT", 3]].forEach(function (k) {
    Object.defineProperty(GeolocationPositionError, k[0], { value: k[1], enumerable: true });
    Object.defineProperty(GeolocationPositionError.prototype, k[0], { value: k[1], enumerable: true });
  });
  var posError = function (code, msg) { return make(GeolocationPositionError, { _code: code, _msg: msg }); };
  var nn = function (v) { return v === undefined || v === null || (typeof v === "number" && isNaN(v)) ? null : Number(v); };
  var makePosition = function (p) {
    var speed = nn(p.speed), heading = nn(p.heading);
    if (speed === 0) heading = null;
    var c = make(GeolocationCoordinates, { _c: { accuracy: Number(p.accuracy === undefined ? 50 : p.accuracy), latitude: Number(p.latitude), longitude: Number(p.longitude), altitude: nn(p.altitude), altitudeAccuracy: nn(p.altitudeAccuracy), heading: heading, speed: speed } });
    return make(GeolocationPosition, { _coords: c, _ts: Date.now() });
  };
  var currentFix = function () {
    var t = __jb.topJb ? __jb.topJb() : __jb;
    if (t.geoOverride !== undefined) return t.geoOverride; // WebDriver BiDi emulation (null = unavailable)
    if (__jb.wptMode || (t && t.wptMode)) return null;
    try { var p = __jb.native("geolocation"); if (p && typeof p.latitude === "number") return p; } catch (e) {}
    return null;
  };
  var watchSeq = 0, watches = new Map(), cached = null;
  var options = function (o) {
    o = o === undefined || o === null ? {} : o;
    var clamp = function (v, d) { if (v === undefined) return d; v = Number(v); if (isNaN(v)) return 0; return Math.min(0xFFFFFFFF, Math.max(0, Math.round(v))); };
    return { high: !!o.enableHighAccuracy, timeout: clamp(o.timeout, 0xFFFFFFFF), maximumAge: clamp(o.maximumAge, 0) };
  };
  var acquire = function (success, error, opts, watchId) {
    var call = function (cb, v) { if (typeof cb === "function") { try { cb.call(undefined, v); } catch (e) { __jb.reportException ? __jb.reportException(e) : console.error(e); } } else if (cb && typeof cb.handleEvent === "function") cb.handleEvent(v); };
    var fail = function (code, msg) { if (watchId && !watches.has(watchId)) return; call(error, posError(code, msg)); };
    setTimeout(function () {
      if (watchId && !watches.has(watchId)) return;
      if (!fullyActive()) return fail(2, "The document is not fully active");
      if (!policyAllows("geolocation")) return fail(1, "Geolocation has been disabled in this document by permissions policy.");
      var state = perm("geolocation");
      if (state !== "granted") return fail(1, "User denied Geolocation");
      if (opts.maximumAge > 0 && cached && Date.now() - cached._ts <= opts.maximumAge) { call(success, cached); return; }
      if (opts.timeout === 0) return fail(3, "Timeout expired");
      var fix = currentFix();
      if (!fix) return fail(2, "Position unavailable");
      cached = makePosition(fix);
      if (watchId && !watches.has(watchId)) return;
      call(success, cached);
    }, 0);
  };
  var checkCallbacks = function (success, error, what) {
    if (typeof success !== "function") throw new TypeError("Geolocation." + what + ": Argument 1 is not callable.");
    if (error !== undefined && error !== null && typeof error !== "function") throw new TypeError("Geolocation." + what + ": Argument 2 is not callable.");
  };
  class Geolocation {
    constructor() { illegal(); }
    getCurrentPosition(success, error, opts) {
      if (arguments.length < 1) throw new TypeError("Geolocation.getCurrentPosition: At least 1 argument required");
      checkCallbacks(success, error, "getCurrentPosition");
      if (!fullyActive()) { var e1 = error; setTimeout(function () { if (typeof e1 === "function") e1(posError(2, "The document is not fully active")); }, 0); return; }
      acquire(success, error, options(opts), 0);
    }
    watchPosition(success, error, opts) {
      if (arguments.length < 1) throw new TypeError("Geolocation.watchPosition: At least 1 argument required");
      checkCallbacks(success, error, "watchPosition");
      if (!fullyActive()) { var e2 = error; setTimeout(function () { if (typeof e2 === "function") e2(posError(2, "The document is not fully active")); }, 0); return 0; }
      var id = ++watchSeq;
      watches.set(id, true);
      acquire(success, error, options(opts), id);
      return id;
    }
    clearWatch(id) { if (arguments.length < 1) throw new TypeError("Geolocation.clearWatch: At least 1 argument required"); watches.delete(Number(id) | 0); }
  }
  var geo = make(Geolocation);
  defineNav("geolocation", function () { return geo; });

  // ================================================================ Screen orientation
  var ORIENTATIONS = ["any", "natural", "landscape", "portrait", "portrait-primary", "portrait-secondary", "landscape-primary", "landscape-secondary"];
  class ScreenOrientation extends EventTarget {
    constructor(tok) { if (tok !== TOKEN) illegal(); super(); }
    get type() { var t = __jb.topJb ? __jb.topJb() : __jb; return (t.orientationOverride && t.orientationOverride.type) || ((globalThis.innerWidth || 1280) >= (globalThis.innerHeight || 720) ? "landscape-primary" : "portrait-primary"); }
    get angle() { var t = __jb.topJb ? __jb.topJb() : __jb; return t.orientationOverride && typeof t.orientationOverride.angle === "number" ? t.orientationOverride.angle : 0; }
    lock(orientation) {
      return new Promise(function (resolve, reject) {
        if (arguments.length === 0 && orientation === undefined) {}
        orientation = String(orientation);
        if (ORIENTATIONS.indexOf(orientation) < 0) throw new TypeError("ScreenOrientation.lock: '" + orientation + "' is not a valid value for enumeration OrientationLockType.");
        if (!fullyActive()) throw dom("InvalidStateError", "The document is not fully active");
        if (__jb.sandboxFlags && __jb.sandboxFlags().orientationLock) throw dom("SecurityError", "The document is sandboxed without allow-orientation-lock");
        if (hidden()) throw dom("SecurityError", "The document is hidden");
        throw dom("NotSupportedError", "Screen orientation locking is not supported on this device");
      });
    }
    unlock() { if (!fullyActive()) throw dom("InvalidStateError", "The document is not fully active"); }
  }
  handler(ScreenOrientation.prototype, "change");
  var orientationObj = null;
  if (typeof screen !== "undefined" && screen) {
    try { Object.defineProperty(screen, "orientation", { get: function () { if (!orientationObj) orientationObj = new ScreenOrientation(TOKEN); return orientationObj; }, enumerable: true, configurable: true }); } catch (e) {}
  }
  __jb.screenOrientationChanged = function () { if (orientationObj) orientationObj.dispatchEvent(new Event("change")); };

  // ================================================================ Screen Wake Lock
  var sentinels = [];
  class WakeLockSentinel extends EventTarget {
    constructor(tok) { if (tok !== TOKEN) illegal(); super(); Object.defineProperty(this, "_released", { value: false, writable: true }); }
    get released() { return this._released; }
    get type() { return "screen"; }
    release() { var self_ = this; return new Promise(function (resolve) { releaseSentinel(self_); resolve(undefined); }); }
  }
  handler(WakeLockSentinel.prototype, "release");
  var releaseSentinel = function (s) {
    var i = sentinels.indexOf(s);
    if (i < 0) return;
    sentinels.splice(i, 1);
    s._released = true;
    s.dispatchEvent(new Event("release"));
  };
  class WakeLock {
    constructor() { illegal(); }
    request(type) {
      return new Promise(function (resolve) {
        type = type === undefined ? "screen" : String(type);
        if (type !== "screen") throw new TypeError("WakeLock.request: '" + type + "' is not a valid value for enumeration WakeLockType.");
        if (!policyAllows("screen-wake-lock")) throw dom("NotAllowedError", "Screen wake lock is disabled by permissions policy");
        if (!fullyActive()) throw dom("NotAllowedError", "The document is not fully active");
        if (hidden()) throw dom("NotAllowedError", "The document is hidden");
        var st = perm("screen-wake-lock");
        if (st === "denied" || (st === "prompt" && __jb.wptMode)) throw dom("NotAllowedError", "Wake lock permission was denied");
        var s = new WakeLockSentinel(TOKEN);
        sentinels.push(s);
        resolve(s);
      });
    }
  }
  var wakeLock = make(WakeLock);
  defineNav("wakeLock", function () { return wakeLock; });
  try { document.addEventListener("visibilitychange", function () { if (hidden()) sentinels.slice().forEach(releaseSentinel); }); } catch (e) {}
  __jb.releaseWakeLocks = function () { sentinels.slice().forEach(releaseSentinel); };

  // ================================================================ Idle Detection
  class IdleDetector extends EventTarget {
    constructor() { super(); if (!isSecure()) throw dom("SecurityError", "IdleDetector requires a secure context"); Object.defineProperty(this, "_s", { value: { state: null, screen: null, started: false } }); }
    get userState() { return this._s.state; }
    get screenState() { return this._s.screen; }
    start(opts) {
      var s = this._s, self_ = this;
      return new Promise(function (resolve) {
        opts = opts === undefined || opts === null ? {} : opts;
        if (!policyAllows("idle-detection")) throw dom("NotAllowedError", "Idle detection is disabled by permissions policy");
        if (perm("idle-detection") !== "granted") throw dom("NotAllowedError", "Idle detection permission was not granted");
        if (s.started) throw dom("InvalidStateError", "Idle detection has already started");
        var threshold = opts.threshold === undefined ? 60000 : Number(opts.threshold);
        if (!isFinite(threshold) || threshold < 60000) throw new TypeError("IdleDetector.start: threshold must be at least 60000");
        if (opts.signal) { if (opts.signal.aborted) throw opts.signal.reason; opts.signal.addEventListener("abort", function () { s.started = false; }); }
        s.started = true; s.state = "active"; s.screen = "unlocked";
        setTimeout(function () { if (s.started) self_.dispatchEvent(new Event("change")); }, 0);
        resolve(undefined);
      });
    }
    static requestPermission() {
      return new Promise(function (resolve) {
        if (!activation()) throw dom("NotAllowedError", "requestPermission requires a user gesture");
        resolve(perm("idle-detection") === "granted" ? "granted" : "denied");
      });
    }
  }
  handler(IdleDetector.prototype, "change");
  var isSecure = function () { try { return globalThis.isSecureContext !== false; } catch (e) { return true; } };

  // ================================================================ Battery Status
  class BatteryManager extends EventTarget {
    constructor(tok) { if (tok !== TOKEN) illegal(); super(); }
    get charging() { return true; } get chargingTime() { return 0; } get dischargingTime() { return Infinity; } get level() { return 1; }
  }
  ["chargingchange", "chargingtimechange", "dischargingtimechange", "levelchange"].forEach(function (n) { handler(BatteryManager.prototype, n); });
  var batteryPromise = null;
  try {
    Object.defineProperty(navigator, "getBattery", { value: function getBattery() {
      if (!isSecure()) return Promise.reject(dom("SecurityError", "getBattery requires a secure context"));
      if (!policyAllows("battery")) return Promise.reject(dom("NotAllowedError", "Battery status is disabled by permissions policy"));
      if (!batteryPromise) batteryPromise = Promise.resolve(new BatteryManager(TOKEN));
      return batteryPromise;
    }, writable: true, enumerable: true, configurable: true });
  } catch (e) {}

  // ================================================================ Network Information
  class NetworkInformation extends EventTarget {
    constructor(tok) { if (tok !== TOKEN) illegal(); super(); }
    get effectiveType() { return "4g"; } get downlink() { return 10; } get rtt() { return 50; } get saveData() { return false; }
  }
  handler(NetworkInformation.prototype, "change");
  var connection = null;
  defineNav("connection", function () { return connection || (connection = new NetworkInformation(TOKEN)); });

  // ================================================================ User-Agent Client Hints
  var brands = function () { return [{ brand: "Not=A?Brand", version: "24" }, { brand: "Chromium", version: "140" }, { brand: "Google Chrome", version: "140" }]; };
  class NavigatorUAData {
    constructor() { illegal(); }
    get brands() { return Object.freeze(brands().map(function (b) { return Object.freeze(b); })); }
    get mobile() { return false; }
    get platform() { return "Windows"; }
    getHighEntropyValues(hints) {
      return new Promise(function (resolve) {
        if (arguments.length === 0 && hints === undefined) throw new TypeError("getHighEntropyValues: At least 1 argument required");
        var list = __jb.arrayFrom(hints, String);
        var all = { architecture: "x86", bitness: "64", formFactors: ["Desktop"], fullVersionList: [{ brand: "Not=A?Brand", version: "24.0.0.0" }, { brand: "Chromium", version: "140.0.0.0" }, { brand: "Google Chrome", version: "140.0.0.0" }], model: "", platformVersion: "10.0.0", uaFullVersion: "140.0.0.0", wow64: false };
        var out = { brands: brands(), mobile: false, platform: "Windows" };
        list.forEach(function (h) { if (Object.prototype.hasOwnProperty.call(all, h)) out[h] = all[h]; });
        resolve(out);
      });
    }
    toJSON() { return { brands: brands(), mobile: false, platform: "Windows" }; }
  }
  var uaData = make(NavigatorUAData);
  if (isSecure()) defineNav("userAgentData", function () { return uaData; });

  // ================================================================ Badging
  var badgeContents = function (c, what) {
    if (c === undefined) return;
    var n = Number(c);
    if (!isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) throw new TypeError(what + ": contents must be a non-negative integer");
  };
  try {
    Object.defineProperty(navigator, "setAppBadge", { value: function setAppBadge(contents) { return new Promise(function (resolve) { if (!fullyActive()) throw dom("InvalidStateError", "The document is not fully active"); badgeContents(contents, "setAppBadge"); resolve(undefined); }); }, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(navigator, "clearAppBadge", { value: function clearAppBadge() { return new Promise(function (resolve) { if (!fullyActive()) throw dom("InvalidStateError", "The document is not fully active"); resolve(undefined); }); }, writable: true, enumerable: true, configurable: true });
  } catch (e) {}

  // ================================================================ Keyboard Map / Lock
  var US = { Backquote: "`", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4", Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9", Digit0: "0", Minus: "-", Equal: "=",
    KeyQ: "q", KeyW: "w", KeyE: "e", KeyR: "r", KeyT: "t", KeyY: "y", KeyU: "u", KeyI: "i", KeyO: "o", KeyP: "p", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
    KeyA: "a", KeyS: "s", KeyD: "d", KeyF: "f", KeyG: "g", KeyH: "h", KeyJ: "j", KeyK: "k", KeyL: "l", Semicolon: ";", Quote: "'",
    KeyZ: "z", KeyX: "x", KeyC: "c", KeyV: "v", KeyB: "b", KeyN: "n", KeyM: "m", Comma: ",", Period: ".", Slash: "/", IntlBackslash: "\\" };
  class KeyboardLayoutMap {
    constructor() { illegal(); }
    get size() { return this._m.size; }
    get(k) { return this._m.get(k); } has(k) { return this._m.has(k); }
    keys() { return this._m.keys(); } values() { return this._m.values(); } entries() { return this._m.entries(); }
    forEach(cb, thisArg) { var self_ = this; this._m.forEach(function (v, k) { cb.call(thisArg, v, k, self_); }); }
  }
  KeyboardLayoutMap.prototype[Symbol.iterator] = KeyboardLayoutMap.prototype.entries;
  class Keyboard extends EventTarget {
    constructor(tok) { if (tok !== TOKEN) illegal(); super(); }
    getLayoutMap() {
      return new Promise(function (resolve) {
        if (!fullyActive()) throw dom("InvalidStateError", "The document is not fully active");
        if (!isTop()) throw dom("SecurityError", "getLayoutMap() must be called from a top-level browsing context");
        if (!policyAllows("keyboard-map")) throw dom("SecurityError", "keyboard-map is disabled by permissions policy");
        resolve(make(KeyboardLayoutMap, { _m: new Map(Object.keys(US).map(function (k) { return [k, US[k]]; })) }));
      });
    }
    lock(codes) {
      return new Promise(function (resolve) {
        if (!fullyActive()) throw dom("InvalidStateError", "The document is not fully active");
        if (!isTop()) throw dom("InvalidStateError", "keyboard.lock() must be called from a top-level browsing context");
        if (codes !== undefined) __jb.arrayFrom(codes, String).forEach(function (c) { if (!/^[A-Z][A-Za-z0-9]*$/.test(c)) throw dom("InvalidAccessError", "Invalid key code '" + c + "'"); });
        resolve(undefined);
      });
    }
    unlock() {}
  }
  handler(Keyboard.prototype, "layoutchange");
  var keyboard = null;
  if (isSecure()) defineNav("keyboard", function () { return keyboard || (keyboard = new Keyboard(TOKEN)); });

  // ================================================================ EyeDropper
  class EyeDropper {
    constructor() { if (!isSecure()) throw dom("SecurityError", "EyeDropper requires a secure context"); }
    open(opts) {
      return new Promise(function (resolve, reject) {
        if (opts && opts.signal && opts.signal.aborted) throw opts.signal.reason;
        if (!activation()) throw dom("NotAllowedError", "EyeDropper.open() requires a user gesture");
        consume();
        throw dom("AbortError", "The user canceled the selection");
      });
    }
  }

  // ================================================================ Window Management
  class ScreenDetailed extends EventTarget {
    constructor(tok) { if (tok !== TOKEN) illegal(); super(); }
  }
  ["availLeft", "availTop", "left", "top"].forEach(function (k) { Object.defineProperty(ScreenDetailed.prototype, k, { get: function () { return 0; }, enumerable: true, configurable: true }); });
  Object.defineProperty(ScreenDetailed.prototype, "isPrimary", { get: function () { return true; }, enumerable: true, configurable: true });
  Object.defineProperty(ScreenDetailed.prototype, "isInternal", { get: function () { return true; }, enumerable: true, configurable: true });
  Object.defineProperty(ScreenDetailed.prototype, "devicePixelRatio", { get: function () { return globalThis.devicePixelRatio || 1; }, enumerable: true, configurable: true });
  Object.defineProperty(ScreenDetailed.prototype, "label", { get: function () { return "Built-in display"; }, enumerable: true, configurable: true });
  ["width", "height", "availWidth", "availHeight", "colorDepth", "pixelDepth"].forEach(function (k) { Object.defineProperty(ScreenDetailed.prototype, k, { get: function () { return screen[k]; }, enumerable: true, configurable: true }); });
  class ScreenDetails extends EventTarget {
    constructor(tok) { if (tok !== TOKEN) illegal(); super(); }
    get screens() { return Object.freeze([this._s]); }
    get currentScreen() { return this._s; }
  }
  handler(ScreenDetails.prototype, "screenschange"); handler(ScreenDetails.prototype, "currentscreenchange");
  try {
    Object.defineProperty(globalThis, "getScreenDetails", { value: function getScreenDetails() {
      return new Promise(function (resolve) {
        if (!fullyActive()) throw dom("InvalidStateError", "The document is not fully active");
        if (!policyAllows("window-management")) throw dom("NotAllowedError", "window-management is disabled by permissions policy");
        if (perm("window-management") !== "granted") throw dom("NotAllowedError", "Permission to manage windows was denied");
        var d = new ScreenDetails(TOKEN);
        Object.defineProperty(d, "_s", { value: new ScreenDetailed(TOKEN) });
        resolve(d);
      });
    }, writable: true, enumerable: true, configurable: true });
    if (typeof screen !== "undefined" && screen && !("isExtended" in screen)) Object.defineProperty(screen, "isExtended", { get: function () { return false; }, enumerable: true, configurable: true });
  } catch (e) {}

  // ================================================================ Web Share
  var shareData = function (data, what) {
    if (data === undefined || data === null) data = {};
    if (typeof data !== "object") throw new TypeError(what + ": data must be a dictionary");
    var has = ["title", "text", "url"].some(function (k) { return data[k] !== undefined; }) || (data.files !== undefined && __jb.arrayFrom(data.files).length > 0);
    if (!has) throw new TypeError(what + ": no known share data fields");
    if (data.url !== undefined) {
      var u;
      try { u = new URL(String(data.url), document.baseURI); } catch (e) { throw new TypeError(what + ": invalid URL"); }
      if (!/^(https?|data|blob|file):$/.test(u.protocol) && u.protocol !== "mailto:" && false) throw new TypeError(what + ": unsupported URL scheme");
      if (/^(file|data|blob|javascript):$/.test(u.protocol)) throw new TypeError(what + ": unsupported URL scheme");
    }
    if (data.files !== undefined && __jb.arrayFrom(data.files).length) throw new TypeError(what + ": file sharing is not supported");
    return data;
  };
  var sharing = false;
  try {
    Object.defineProperty(navigator, "share", { value: function share(data) {
      return new Promise(function (resolve) {
        if (!fullyActive()) throw dom("InvalidStateError", "The document is not fully active");
        if (!policyAllows("web-share")) throw dom("NotAllowedError", "web-share is disabled by permissions policy");
        if (sharing) throw dom("InvalidStateError", "A share is already in progress");
        if (!activation()) throw dom("NotAllowedError", "share() requires transient activation");
        shareData(data, "share");
        consume();
        throw dom("AbortError", "Share canceled");
      });
    }, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(navigator, "canShare", { value: function canShare(data) {
      if (!fullyActive() || !policyAllows("web-share")) return false;
      try { shareData(data, "canShare"); return true; } catch (e) { return false; }
    }, writable: true, enumerable: true, configurable: true });
  } catch (e) {}

  // ================================================================ Contact Picker
  var CONTACT_PROPS = ["address", "email", "icon", "name", "tel"];
  class ContactAddress { constructor() { illegal(); } }
  var contactsBusy = false;
  var contactsHost = function () { try { return __jb.topJb ? __jb.topJb() : __jb; } catch (e) { return __jb; } };
  // the contact picker's answer: test pages set it through WebContactsTest (testing API);
  // otherwise there is no picker and nothing is selected
  var makeAddress = function (a) {
    var o = Object.create(ContactAddress.prototype);
    ["city", "country", "dependentLocality", "organization", "phone", "postalCode", "recipient", "region", "sortingCode"].forEach(function (k) { o[k] = a && a[k] !== undefined ? String(a[k]) : ""; });
    o.addressLine = a && a.addressLine ? __jb.arrayFrom(a.addressLine, String) : [];
    return o;
  };
  class ContactsManager {
    constructor() { illegal(); }
    getProperties() { return Promise.resolve(CONTACT_PROPS.slice()); }
    select(props, opts) {
      return new Promise(function (resolve, reject) {
        if (!isTop()) throw dom("InvalidStateError", "select() must be called from a top-level browsing context");
        if (contactsBusy) throw dom("InvalidStateError", "A contact selection is already in progress");
        if (!activation()) throw dom("SecurityError", "select() requires a user gesture");
        if (props === undefined) throw new TypeError("select: 1 argument required");
        var list = __jb.arrayFrom(props || [], String);
        if (!list.length) throw new TypeError("select: at least one property is required");
        list.forEach(function (p) { if (CONTACT_PROPS.indexOf(p) < 0) throw new TypeError("select: '" + p + "' is not a valid ContactProperty"); });
        consume();
        var mock = contactsHost().contactsMock;
        if (!mock) throw dom("InvalidStateError", "No contacts are available");
        var multiple = !!(opts && opts.multiple);
        contactsBusy = true;
        setTimeout(function () {
          contactsBusy = false;
          if (mock.list === null) { reject(new TypeError("The contact picker could not be opened")); return; }
          var chosen = (mock.list || []).slice(0, multiple ? undefined : 1);
          resolve(chosen.map(function (c) {
            // a ContactInfo dictionary: members in lexicographic order
            var out = {};
            CONTACT_PROPS.filter(function (p) { return list.indexOf(p) >= 0; }).forEach(function (p) {
              var v = c && c[p];
              if (p === "address") out.address = v ? __jb.arrayFrom(v, makeAddress) : [];
              else if (p === "icon") out.icon = v ? __jb.arrayFrom(v, function (b) { return b instanceof Blob ? b.slice(0, b.size, b.type) : new Blob([]); }) : [];
              else out[p] = v ? __jb.arrayFrom(v, String) : [];
            });
            return out;
          }));
        }, 0);
      });
    }
  }
  // testing API (test pages only): WebContactsTest.setSelectedContacts(contacts)
  var installContactsTest = function () {
    if (globalThis.WebContactsTest) return;
    class WebContactsTest {
      setSelectedContacts(c) { contactsHost().contactsMock = { list: c === null || c === undefined ? null : __jb.arrayFrom(c) }; }
    }
    Object.defineProperty(globalThis, "WebContactsTest", { value: WebContactsTest, writable: true, configurable: true });
  };
  try {
    if (__jb.wptMode) installContactsTest();
    else {
      var wdesc = Object.getOwnPropertyDescriptor(__jb, "wptMode");
      if (wdesc && wdesc.set) Object.defineProperty(__jb, "wptMode", { get: wdesc.get, set: function (v) { wdesc.set.call(this, v); if (v) installContactsTest(); }, enumerable: true, configurable: true });
      else { var wv = !!__jb.wptMode; Object.defineProperty(__jb, "wptMode", { get: function () { return wv; }, set: function (v) { wv = v; if (v) installContactsTest(); }, enumerable: true, configurable: true }); }
    }
  } catch (e) {}
  var contacts = make(ContactsManager);
  if (isSecure()) defineNav("contacts", function () { return contacts; });

  exportAll([Geolocation, GeolocationPosition, GeolocationCoordinates, GeolocationPositionError, ScreenOrientation, WakeLock, WakeLockSentinel, IdleDetector, BatteryManager, NetworkInformation, NavigatorUAData,
    KeyboardLayoutMap, Keyboard, EyeDropper, ScreenDetailed, ScreenDetails, ContactAddress, ContactsManager]);
})();
