// Part 6: Web APIs backed by the Rust host (fetch, XHR, storage) and stubs
// Fetch "forbidden request-header" and "CORS-safelisted request-header".
__jb.HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
__jb.FORBIDDEN_REQUEST_HEADER = /^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/;
__jb.isForbiddenRequestHeader = function (name, value) {
  if (__jb.FORBIDDEN_REQUEST_HEADER.test(name)) return true;
  if (name === "x-http-method" || name === "x-http-method-override" || name === "x-method-override") {
    return String(value).split(",").some(function (m) { return /^(connect|trace|track)$/i.test(m.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "")); });
  }
  return false;
};
__jb.CORS_UNSAFE_BYTE = /[\0-\x08\x0a-\x1f"():<>?@\[\\\]{}\x7f]/;
__jb.isCorsSafelistedRequestHeader = function (name, value) {
  if (value.length > 128) return false;
  switch (name) {
    case "accept": return !__jb.CORS_UNSAFE_BYTE.test(value);
    case "accept-language": case "content-language": return /^[0-9A-Za-z *,\-.;=]*$/.test(value);
    case "content-type": { if (__jb.CORS_UNSAFE_BYTE.test(value)) return false; var m = typeof __jb.parseMime === "function" ? __jb.parseMime(value) : null; return !!m && /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)$/.test(m.essence); }
    default: return false;
  }
};
__jb.normalizeHeaderValue = function (v) { return String(v).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, ""); };
class Headers {
  constructor(init) {
    this._map = new Map();
    Object.defineProperty(this, "_wire", { value: new Map(), writable: true }); // lower-case name -> name as first given
    this._guard = "none";
    if (init !== undefined) this._fill(init);
  }
  _fill(init) {
    if (init === null || typeof init !== "object") throw new TypeError("Headers: the init value must be an object");
    var self_ = this;
    if (init instanceof Headers) { init.forEach(function (v, k) { self_.append(k, v); }); return; }
    if (typeof init[Symbol.iterator] === "function") {
      for (var p of init) {
        var pair = __jb.arrayFrom(p);
        if (pair.length !== 2) throw new TypeError("Headers: each header must be a [name, value] pair");
        this.append(pair[0], pair[1]);
      }
      return;
    }
    Object.keys(init).forEach(function (k) { self_.append(k, init[k]); });
  }
  _name(k) { k = String(k); if (!__jb.HEADER_TOKEN.test(k)) throw new TypeError("Headers: '" + k + "' is not a valid header name"); return k.toLowerCase(); }
  _value(v) { v = __jb.normalizeHeaderValue(v); if (/[\0\r\n]/.test(v) || !/^[\x00-\xff]*$/.test(v)) throw new TypeError("Headers: invalid header value"); return v; }
  _allowed(name, value) {
    if (this._guard === "immutable") throw new TypeError("Headers are immutable");
    if (this._guard === "request" && __jb.isForbiddenRequestHeader(name, value)) return false;
    if (this._guard === "request-no-cors" && !__jb.isCorsSafelistedRequestHeader(name, value)) return false;
    if (this._guard === "response" && (name === "set-cookie" || name === "set-cookie2")) return false;
    return true;
  }
  append(k, v) {
    if (arguments.length < 2) throw new TypeError("Headers.append: 2 arguments required");
    var name = this._name(k), value = this._value(v);
    var cur = this._map.get(name);
    var combined = cur === undefined ? value : cur + ", " + value;
    if (!this._allowed(name, this._guard === "request-no-cors" ? combined : value)) return;
    if (name === "set-cookie") (this._setCookies || (this._setCookies = [])).push(value);
    if (!this._wire.has(name)) this._wire.set(name, String(k));
    this._map.set(name, combined);
  }
  set(k, v) {
    if (arguments.length < 2) throw new TypeError("Headers.set: 2 arguments required");
    var name = this._name(k), value = this._value(v);
    if (!this._allowed(name, value)) return;
    if (name === "set-cookie") this._setCookies = [value];
    this._map.set(name, value);
  }
  get(k) { if (arguments.length < 1) throw new TypeError("Headers.get: 1 argument required"); var v = this._map.get(this._name(k)); return v === undefined ? null : v; }
  has(k) { if (arguments.length < 1) throw new TypeError("Headers.has: 1 argument required"); return this._map.has(this._name(k)); }
  delete(k) {
    if (arguments.length < 1) throw new TypeError("Headers.delete: 1 argument required");
    var name = this._name(k);
    if (this._guard === "immutable") throw new TypeError("Headers are immutable");
    if (this._guard === "request" && __jb.isForbiddenRequestHeader(name, "")) return;
    if (this._guard === "request-no-cors" && !/^(accept|accept-language|content-language|content-type|range)$/.test(name)) return;
    if (this._guard === "response" && (name === "set-cookie" || name === "set-cookie2")) return;
    this._map.delete(name);
    if (name === "set-cookie") this._setCookies = [];
  }
  // Iteration is sorted by name; set-cookie yields one entry per value.
  _sorted() {
    var out = [];
    var self_ = this;
    __jb.arrayFrom(this._map.keys()).sort().forEach(function (k) {
      if (k === "set-cookie" && self_._setCookies) self_._setCookies.forEach(function (v) { out.push([k, v]); });
      else out.push([k, self_._map.get(k)]);
    });
    return out;
  }
  forEach(cb, thisArg) { if (typeof cb !== "function") throw new TypeError("Headers.forEach: callback is not a function"); var self_ = this; this._sorted().forEach(function (p) { cb.call(thisArg, p[1], p[0], self_); }); }
  keys() { return this._sorted().map(function (p) { return p[0]; })[Symbol.iterator](); }
  values() { return this._sorted().map(function (p) { return p[1]; })[Symbol.iterator](); }
  entries() { return this._sorted()[Symbol.iterator](); }
  getSetCookie() { return (this._setCookies || []).slice(); }
  [Symbol.iterator]() { return this.entries(); }
  toJSON() { var o = {}; this._map.forEach(function (v, k) { o[k] = v; }); return o; }
  // Names as the author wrote them (what goes on the wire).
  _wireJSON() { var o = {}, self_ = this; this._map.forEach(function (v, k) { o[self_._wire.get(k) || k] = v; }); return o; }
}
class FormData {
  constructor(form, submitter) {
    this._list = [];
    if (form === undefined) return;
    if (!(form instanceof HTMLElement) || form._tag !== "form") throw new TypeError("Failed to construct 'FormData': parameter 1 is not of type 'HTMLFormElement'.");
    if (submitter !== undefined && submitter !== null) {
      var isSubmit = (submitter._tag === "button" && submitter.type === "submit") || (submitter._tag === "input" && /^(submit|image)$/.test(__jb.inputType(submitter)));
      if (!isSubmit) throw new TypeError("Failed to construct 'FormData': The specified element is not a submit button.");
      if (__jb.formOwner(submitter) !== form) throw __jb.domError("NotFoundError", "The specified element is not owned by this form element.");
    }
    var list = __jb.constructEntryList(form, submitter || null, "UTF-8");
    if (list === null) throw __jb.domError("InvalidStateError", "The form is constructing its entry list.");
    this._list = list;
  }
  append(k, v, fn) { this._list.push([String(k), v instanceof Blob ? (fn ? new File([v], fn) : v) : String(v)]); }
  set(k, v, fn) { this.delete(k); this.append(k, v, fn); }
  get(k) { var p = this._list.find((p) => p[0] === String(k)); return p ? p[1] : null; }
  getAll(k) { return this._list.filter((p) => p[0] === String(k)).map((p) => p[1]); }
  has(k) { return this._list.some((p) => p[0] === String(k)); }
  delete(k) { this._list = this._list.filter((p) => p[0] !== String(k)); }
  forEach(cb, thisArg) { this._list.forEach((p) => cb.call(thisArg, p[1], p[0], this)); }
  keys() { return this._list.map((p) => p[0])[Symbol.iterator](); } values() { return this._list.map((p) => p[1])[Symbol.iterator](); } entries() { return this._list.map((p) => p.slice())[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  _toURLEncoded() { return this._list.map((p) => __jb.formEncode(p[0]) + "=" + __jb.formEncode(typeof p[1] === "string" ? p[1] : p[1].name || "blob")).join("&"); }
}
// "multipart/form-data encoding algorithm": a fresh boundary per extraction,
// CRLF-normalized string values, files with their name and type.
__jb.multipartEncode = function (fd) {
  var boundary = "----formdata-julia-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  var escape = function (s) { return String(s).replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22"); };
  var chunks = [];
  var push = function (s) { chunks.push(typeof s === "string" ? __utf8Encode(s) : s); };
  fd._list.forEach(function (p) {
    var name = p[0], value = p[1];
    push("--" + boundary + "\r\n");
    if (typeof value === "string") {
      push('Content-Disposition: form-data; name="' + escape(name) + '"\r\n\r\n');
      push(value.replace(/\r\n|\r|\n/g, "\r\n"));
    } else {
      var filename = value instanceof File ? value.name : "blob";
      push('Content-Disposition: form-data; name="' + escape(name) + '"; filename="' + escape(filename) + '"\r\n');
      push("Content-Type: " + (value.type || "application/octet-stream") + "\r\n\r\n");
      push(value._bytes());
    }
    push("\r\n");
  });
  push("--" + boundary + "--\r\n");
  var total = __jb.A.reduce.call(chunks, function (n, c) { return n + c.length; }, 0), out = new Uint8Array(total), off = 0;
  chunks.forEach(function (c) { out.set(c, off); off += c.length; });
  return { bytes: out, boundary: boundary, contentType: "multipart/form-data; boundary=" + boundary };
};



// ---- Web Storage (persisted through the host) ----
class Storage {
  constructor(area) {
    // configurable: the proxy's ownKeys lists stored keys only (a non-configurable own property must be listed)
    Object.defineProperty(this, "_area", { value: area, enumerable: false, configurable: true });
    return new Proxy(this, {
      get: function (t, k) { if (typeof k === "symbol" || k in t) { var v = t[k]; return typeof v === "function" ? v.bind(t) : v; } return t.getItem(k) === null ? undefined : t.getItem(k); },
      set: function (t, k, v) { if (typeof k === "symbol") return true; t.setItem(k, v); return true; },
      deleteProperty: function (t, k) { t.removeItem(k); return true; },
      has: function (t, k) { return k in t || t.getItem(k) !== null; },
      ownKeys: function (t) { return t._keys(); },
      getOwnPropertyDescriptor: function (t, k) { var v = t.getItem(k); return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true }; },
    });
  }
  _keys() { return __jb.native("storage", { area: this._area, op: "keys" }) || []; }
  get length() { return this._keys().length; }
  key(i) { return this._keys()[i] || null; }
  getItem(k) { var v = __jb.native("storage", { area: this._area, op: "get", key: String(k) }); return v === null || v === undefined ? null : String(v); }
  setItem(k, v) { k = String(k); v = String(v); var old = this.getItem(k); __jb.native("storage", { area: this._area, op: "set", key: k, value: v }); if (old !== v) __jb.storageChanged(this._area, k, old, v); }
  removeItem(k) { k = String(k); var old = this.getItem(k); __jb.native("storage", { area: this._area, op: "remove", key: k }); if (old !== null) __jb.storageChanged(this._area, k, old, null); }
  clear() { var had = this._keys().length > 0; __jb.native("storage", { area: this._area, op: "clear" }); if (had) __jb.storageChanged(this._area, null, null, null); }
}
// Overridden by 60_realms.js to notify the other documents of the origin.
__jb.storageChanged = function () {};
globalThis.localStorage = new Storage("localStorage");
globalThis.sessionStorage = new Storage("sessionStorage");
globalThis.localStorage = localStorage; globalThis.sessionStorage = sessionStorage;

// (IndexedDB lives in 51_indexeddb.js)

// HTML message ports: entangled pairs, a port message queue enabled by start() (or by setting
// onmessage), transfer of buffers and ports through postMessage, close().
class MessagePort extends EventTarget {
  constructor() {
    super();
    if (!__jb.constructingPort) throw new TypeError("Illegal constructor");
    Object.defineProperty(this, "_port", { value: { other: null, queue: [], enabled: false, closed: false, detached: false } });
  }
  postMessage(message, transferOrOptions) {
    if (arguments.length < 1) throw new TypeError("MessagePort.postMessage: 1 argument required");
    var transfer = [];
    if (Array.isArray(transferOrOptions) || (transferOrOptions && typeof transferOrOptions === "object" && typeof transferOrOptions[Symbol.iterator] === "function")) transfer = __jb.arrayFrom(transferOrOptions);
    else if (transferOrOptions && typeof transferOrOptions === "object" && transferOrOptions.transfer !== undefined) transfer = __jb.arrayFrom(transferOrOptions.transfer);
    var me = this._port;
    if (transfer.indexOf(this) >= 0) throw new DOMException("A port cannot transfer itself", "DataCloneError");
    var target = me.other;
    if (target && transfer.indexOf(target._owner) >= 0) target = null; // transferring the entangled port: the message is lost
    var ports = transfer.filter(function (t) { return t instanceof MessagePort; });
    ports.forEach(function (pt) { if (pt._port.detached) throw new DOMException("A transferred port is detached", "DataCloneError"); });
    var cloneJb = target && target.jb ? target.jb : __jb; // deserialized in the receiving port's realm
    var data = __jb.cloneInto(cloneJb, message, { transfer: transfer.filter(function (t) { return !(t instanceof MessagePort); }) });
    var moved = ports.map(function (pt) { return __jb.movePort(pt); });
    if (!target || me.closed) return;
    __jb.enqueuePortMessage(target, { data: data, ports: moved });
  }
  start() { __jb.enablePort(this._port); }
  close() {
    var me = this._port;
    me.closed = true;
    var other = me.other;
    if (other) { other.other = null; me.other = null; var o = other._owner; setTimeout(function () { o.dispatchEvent(new Event("close")); }, 0); }
  }
  get onmessage() { return this._onmessage === undefined ? null : this._onmessage; }
  set onmessage(v) { this._onmessage = typeof v === "function" || (v !== null && typeof v === "object") ? v : null; __jb.handlerSlot(this, "message", this._onmessage); __jb.enablePort(this._port); }
  get onmessageerror() { return this._onmessageerror === undefined ? null : this._onmessageerror; }
  set onmessageerror(v) { this._onmessageerror = typeof v === "function" || (v !== null && typeof v === "object") ? v : null; __jb.handlerSlot(this, "messageerror", this._onmessageerror); }
  get onclose() { return this._onclose === undefined ? null : this._onclose; }
  set onclose(v) { this._onclose = typeof v === "function" || (v !== null && typeof v === "object") ? v : null; __jb.handlerSlot(this, "close", this._onclose); }
}
Object.defineProperty(MessagePort.prototype, Symbol.toStringTag, { value: "MessagePort", configurable: true });
__jb.newPort = function () { __jb.constructingPort = true; try { var p = new MessagePort(); } finally { __jb.constructingPort = false; } p._port._owner = p; p._port.jb = __jb; return p; };
__jb.entanglePorts = function (a, b) { a._port.other = b._port; b._port.other = a._port; };
// Transferring a port: a new port object takes over the entanglement and the queued messages.
__jb.movePort = function (old) {
  var o = old._port, n = __jb.newPort(), np = n._port;
  np.other = o.other; if (np.other) np.other.other = np;
  np.queue = o.queue; o.queue = [];
  np.closed = o.closed;
  o.other = null; o.detached = true; o.closed = true;
  return n;
};
__jb.enqueuePortMessage = function (port, msg) {
  port.queue.push(msg);
  if (port.enabled) __jb.flushPort(port);
};
__jb.enablePort = function (port) { if (port.enabled) return; port.enabled = true; __jb.flushPort(port); };
__jb.flushPort = function (port) {
  if (port.flushing) return;
  port.flushing = true;
  setTimeout(function step() {
    port.flushing = false;
    if (!port.queue.length || port.detached) return;
    var msg = port.queue.shift();
    var ev = new MessageEvent("message", { data: msg.data, ports: msg.ports, origin: "" });
    __jb.setTrusted(ev, true); ev._trustedDispatch = true;
    port._owner.dispatchEvent(ev);
    if (port.queue.length) { port.flushing = true; setTimeout(step, 0); }
  }, 0);
};
class MessageChannel {
  constructor() {
    var p1 = __jb.newPort(), p2 = __jb.newPort();
    __jb.entanglePorts(p1, p2);
    Object.defineProperty(this, "_p1", { value: p1 }); Object.defineProperty(this, "_p2", { value: p2 });
  }
  get port1() { return this._p1; }
  get port2() { return this._p2; }
}
Object.defineProperty(MessageChannel.prototype, Symbol.toStringTag, { value: "MessageChannel", configurable: true });
// BroadcastChannel: channels of every realm of the page (frames, popups) are
// registered on the top window; a message is delivered, cloned into each
// receiver's realm, to every other open channel with the same name.
class BroadcastChannel extends EventTarget {
  constructor(name) {
    if (arguments.length < 1) throw new TypeError("BroadcastChannel constructor: 1 argument required");
    super();
    this._name = String(name); this._closed = false; this._realm = globalThis; this.onmessage = null; this.onmessageerror = null;
    var reg = typeof __jb.topJb === "function" ? __jb.topJb() : __jb;
    (reg.broadcastChannels = reg.broadcastChannels || []).push(this);
  }
  get name() { return this._name; }
  postMessage(message) {
    if (arguments.length < 1) throw new TypeError("BroadcastChannel.postMessage: 1 argument required");
    if (this._closed) throw __jb.domError("InvalidStateError", "The channel is closed");
    structuredClone(message); // DataCloneError is reported synchronously
    var reg = typeof __jb.topJb === "function" ? __jb.topJb() : __jb, self_ = this, origin = location.origin;
    (reg.broadcastChannels || []).forEach(function (ch) {
      if (ch === self_ || ch._closed || ch._name !== self_._name) return;
      var tw = ch._realm;
      try { if (tw.location.origin !== origin) return; } catch (e) { return; }
      tw.setTimeout(function () { if (ch._closed) return; var ev = new tw.MessageEvent("message", { data: tw.structuredClone(message), origin: origin }); __jb.setTrusted(ev, true); ev._trustedDispatch = true; ch.dispatchEvent(ev); }, 0);
    });
  }
  close() { this._closed = true; var reg = typeof __jb.topJb === "function" ? __jb.topJb() : __jb; var list = reg.broadcastChannels || []; var i = list.indexOf(this); if (i >= 0) list.splice(i, 1); }
}
class Touch {
  constructor(init) {
    if (arguments.length < 1 || init === null || init === undefined || typeof init !== "object") throw new TypeError("Touch constructor: TouchInit dictionary required");
    if (init.identifier === undefined) throw new TypeError("Touch constructor: required member identifier is undefined");
    var target = init.target;
    if (target === undefined) throw new TypeError("Touch constructor: required member target is undefined");
    if (!(target instanceof EventTarget) && !(target && target.window === target)) throw new TypeError("Touch constructor: target is not an EventTarget");
    var d = function (k) { var v = init[k]; if (v === undefined) return 0; v = Number(v); if (!isFinite(v)) throw new TypeError("Touch constructor: " + k + " is not a finite number"); return v; };
    var f = function (k) { return Math.fround(d(k)); };
    var tt = init.touchType === undefined ? "direct" : String(init.touchType);
    if (tt !== "direct" && tt !== "stylus") throw new TypeError("'" + tt + "' is not a valid value for enumeration TouchType.");
    Object.defineProperty(this, "_t", { value: { identifier: init.identifier | 0, target: target, clientX: d("clientX"), clientY: d("clientY"), screenX: d("screenX"), screenY: d("screenY"), pageX: d("pageX"), pageY: d("pageY"), radiusX: f("radiusX"), radiusY: f("radiusY"), rotationAngle: f("rotationAngle"), force: f("force"), altitudeAngle: f("altitudeAngle"), azimuthAngle: f("azimuthAngle"), touchType: tt } });
  }
}
["identifier", "target", "screenX", "screenY", "clientX", "clientY", "pageX", "pageY", "radiusX", "radiusY", "rotationAngle", "force", "altitudeAngle", "azimuthAngle", "touchType"].forEach(function (a) {
  Object.defineProperty(Touch.prototype, a, { get: function () { if (!this || !this._t) throw new TypeError("'get " + a + "' called on an object that does not implement interface Touch."); return this._t[a]; }, enumerable: true, configurable: true });
});
function TouchList() { throw new TypeError("Illegal constructor"); }
Object.defineProperty(TouchList.prototype, "length", { get: function () { if (!this || !this._list) throw new TypeError("'get length' called on an object that does not implement interface TouchList."); return this._list.length; }, enumerable: true, configurable: true });
TouchList.prototype.item = function item(i) { if (!this || !this._list) throw new TypeError("Illegal invocation"); if (arguments.length < 1) throw new TypeError("item: 1 argument required"); return this._list[i >>> 0] || null; };
TouchList.prototype[Symbol.iterator] = Array.prototype[Symbol.iterator];
Object.defineProperty(TouchList.prototype, Symbol.toStringTag, { value: "TouchList", configurable: true });
Object.defineProperty(TouchList, "prototype", { writable: false });
__jb.makeTouchList = function (arr) {
  var tl = Object.create(TouchList.prototype);
  Object.defineProperty(tl, "_list", { value: arr.slice() });
  arr.forEach(function (t, i) { Object.defineProperty(tl, i, { value: t, enumerable: true, configurable: false, writable: false }); });
  return tl;
};
var __jbAudio = (function () {
  // AudioParam: automation methods are accepted and return the param (values are not scheduled)
  class AudioParam {
    constructor(v, min, max) { this._v = v; this.defaultValue = v; this.minValue = min === undefined ? -3.4028234663852886e38 : min; this.maxValue = max === undefined ? 3.4028234663852886e38 : max; this.automationRate = "a-rate"; }
    get value() { return this._v; } set value(x) { x = Number(x); if (!isNaN(x)) this._v = x; }
    setValueAtTime(v) { this.value = v; return this; } linearRampToValueAtTime(v) { this.value = v; return this; } exponentialRampToValueAtTime(v) { this.value = v; return this; }
    setTargetAtTime(v) { this.value = v; return this; } setValueCurveAtTime(c) { if (c && c.length) this.value = c[c.length - 1]; return this; }
    cancelScheduledValues() { return this; } cancelAndHoldAtTime() { return this; }
  }
  class AudioNode extends EventTarget {
    constructor(ctx, ins, outs) { super(); this.context = ctx; this.numberOfInputs = ins === undefined ? 1 : ins; this.numberOfOutputs = outs === undefined ? 1 : outs; this.channelCount = 2; this.channelCountMode = "max"; this.channelInterpretation = "speakers"; }
    connect(dest) { return dest instanceof AudioNode ? dest : undefined; } disconnect() {}
  }
  var param = function (node, name, v, min, max) { Object.defineProperty(node, name, { value: new AudioParam(v, min, max), enumerable: true }); };
  class GainNode extends AudioNode { constructor(ctx) { super(ctx); param(this, "gain", 1); } }
  class AudioScheduledSourceNode extends AudioNode {
    constructor(ctx) { super(ctx, 0, 1); this.onended = null; }
    start() {} stop() { var self = this; setTimeout(function () { var e = new Event("ended"); self.dispatchEvent(e); if (typeof self.onended === "function") self.onended(e); }, 0); }
  }
  class OscillatorNode extends AudioScheduledSourceNode { constructor(ctx) { super(ctx); this.type = "sine"; param(this, "frequency", 440); param(this, "detune", 0); } setPeriodicWave() {} }
  class ConstantSourceNode extends AudioScheduledSourceNode { constructor(ctx) { super(ctx); param(this, "offset", 1); } }
  class AudioBufferSourceNode extends AudioScheduledSourceNode { constructor(ctx) { super(ctx); this.buffer = null; this.loop = false; this.loopStart = 0; this.loopEnd = 0; param(this, "playbackRate", 1); param(this, "detune", 0); } }
  class BiquadFilterNode extends AudioNode { constructor(ctx) { super(ctx); this.type = "lowpass"; param(this, "frequency", 350); param(this, "detune", 0); param(this, "Q", 1); param(this, "gain", 0); } getFrequencyResponse() {} }
  class DelayNode extends AudioNode { constructor(ctx, max) { super(ctx); param(this, "delayTime", 0, 0, max || 1); } }
  class DynamicsCompressorNode extends AudioNode { constructor(ctx) { super(ctx); param(this, "threshold", -24); param(this, "knee", 30); param(this, "ratio", 12); param(this, "attack", 0.003); param(this, "release", 0.25); this.reduction = 0; } }
  class StereoPannerNode extends AudioNode { constructor(ctx) { super(ctx); param(this, "pan", 0, -1, 1); } }
  class PannerNode extends AudioNode { constructor(ctx) { super(ctx); this.panningModel = "equalpower"; this.distanceModel = "inverse"; ["positionX", "positionY", "positionZ", "orientationY", "orientationZ"].forEach(function (k) { param(this, k, 0); }, this); param(this, "orientationX", 1); } setPosition() {} setOrientation() {} }
  class ConvolverNode extends AudioNode { constructor(ctx) { super(ctx); this.buffer = null; this.normalize = true; } }
  class WaveShaperNode extends AudioNode { constructor(ctx) { super(ctx); this.curve = null; this.oversample = "none"; } }
  class AnalyserNode extends AudioNode {
    constructor(ctx) { super(ctx); this.fftSize = 2048; this.minDecibels = -100; this.maxDecibels = -30; this.smoothingTimeConstant = 0.8; }
    get frequencyBinCount() { return this.fftSize / 2; }
    getByteFrequencyData() {} getByteTimeDomainData(a) { if (a && a.fill) a.fill(128); } getFloatFrequencyData(a) { if (a && a.fill) a.fill(-Infinity); } getFloatTimeDomainData(a) { if (a && a.fill) a.fill(0); }
  }
  class ChannelSplitterNode extends AudioNode {} class ChannelMergerNode extends AudioNode {}
  class ScriptProcessorNode extends AudioNode { constructor(ctx, size) { super(ctx); this.bufferSize = size || 4096; this.onaudioprocess = null; } }
  class MediaElementAudioSourceNode extends AudioNode { constructor(ctx, el) { super(ctx, 0, 1); this.mediaElement = el || null; } }
  class MediaStreamAudioSourceNode extends AudioNode { constructor(ctx, st) { super(ctx, 0, 1); this.mediaStream = st || null; } }
  class MediaStreamAudioDestinationNode extends AudioNode { constructor(ctx) { super(ctx, 1, 0); this.stream = typeof MediaStream === "function" ? new MediaStream() : null; } }
  class AudioDestinationNode extends AudioNode { constructor(ctx) { super(ctx, 1, 0); this.maxChannelCount = 2; } }
  class AudioBuffer {
    constructor(o) { o = o || {}; this.numberOfChannels = o.numberOfChannels || 1; this.length = Math.max(1, o.length | 0); this.sampleRate = o.sampleRate || 44100; this.duration = this.length / this.sampleRate; this._ch = []; for (var i = 0; i < this.numberOfChannels; i++) this._ch.push(new Float32Array(this.length)); }
    getChannelData(i) { if (!(i >= 0 && i < this.numberOfChannels)) throw new DOMException("channel index", "IndexSizeError"); return this._ch[i]; }
    copyFromChannel(dst, i, off) { dst.set(this.getChannelData(i).subarray(off || 0, (off || 0) + dst.length)); }
    copyToChannel(src, i, off) { this.getChannelData(i).set(src, off || 0); }
  }
  class AudioListener { constructor() { ["positionX", "positionY", "positionZ", "forwardX", "forwardY", "upX", "upZ"].forEach(function (k) { param(this, k, 0); }, this); param(this, "forwardZ", -1); param(this, "upY", 1); } setPosition() {} setOrientation() {} }
  class PeriodicWave {}
  return { AudioParam: AudioParam, AudioNode: AudioNode, GainNode: GainNode, AudioScheduledSourceNode: AudioScheduledSourceNode, OscillatorNode: OscillatorNode, ConstantSourceNode: ConstantSourceNode, AudioBufferSourceNode: AudioBufferSourceNode, BiquadFilterNode: BiquadFilterNode, DelayNode: DelayNode, DynamicsCompressorNode: DynamicsCompressorNode, StereoPannerNode: StereoPannerNode, PannerNode: PannerNode, ConvolverNode: ConvolverNode, WaveShaperNode: WaveShaperNode, AnalyserNode: AnalyserNode, ChannelSplitterNode: ChannelSplitterNode, ChannelMergerNode: ChannelMergerNode, ScriptProcessorNode: ScriptProcessorNode, MediaElementAudioSourceNode: MediaElementAudioSourceNode, MediaStreamAudioSourceNode: MediaStreamAudioSourceNode, MediaStreamAudioDestinationNode: MediaStreamAudioDestinationNode, AudioDestinationNode: AudioDestinationNode, AudioBuffer: AudioBuffer, AudioListener: AudioListener, PeriodicWave: PeriodicWave };
})();
class Audio_Context extends EventTarget {
  constructor(opts) { super(); var A = __jbAudio; this.state = "suspended"; this.sampleRate = (opts && opts.sampleRate) || 44100; this.baseLatency = 0.01; this.outputLatency = 0; this.onstatechange = null; this._t0 = typeof performance !== "undefined" ? performance.now() : 0; this.destination = new A.AudioDestinationNode(this); this.listener = new A.AudioListener(); this.audioWorklet = { addModule: function () { return Promise.resolve(); } }; }
  get currentTime() { return this.state === "running" && typeof performance !== "undefined" ? (performance.now() - this._t0) / 1000 : 0; }
  _setState(s) { if (this.state === s) return; this.state = s; var e = new Event("statechange"); this.dispatchEvent(e); if (typeof this.onstatechange === "function") this.onstatechange(e); }
  createGain() { return new __jbAudio.GainNode(this); } createOscillator() { return new __jbAudio.OscillatorNode(this); } createConstantSource() { return new __jbAudio.ConstantSourceNode(this); }
  createBufferSource() { return new __jbAudio.AudioBufferSourceNode(this); } createBiquadFilter() { return new __jbAudio.BiquadFilterNode(this); } createDelay(m) { return new __jbAudio.DelayNode(this, m); }
  createDynamicsCompressor() { return new __jbAudio.DynamicsCompressorNode(this); } createStereoPanner() { return new __jbAudio.StereoPannerNode(this); } createPanner() { return new __jbAudio.PannerNode(this); }
  createConvolver() { return new __jbAudio.ConvolverNode(this); } createWaveShaper() { return new __jbAudio.WaveShaperNode(this); } createAnalyser() { return new __jbAudio.AnalyserNode(this); }
  createChannelSplitter() { return new __jbAudio.ChannelSplitterNode(this); } createChannelMerger() { return new __jbAudio.ChannelMergerNode(this); } createScriptProcessor(n) { return new __jbAudio.ScriptProcessorNode(this, n); }
  createMediaElementSource(el) { return new __jbAudio.MediaElementAudioSourceNode(this, el); } createMediaStreamSource(st) { return new __jbAudio.MediaStreamAudioSourceNode(this, st); } createMediaStreamDestination() { return new __jbAudio.MediaStreamAudioDestinationNode(this); }
  createBuffer(ch, len, rate) { return new __jbAudio.AudioBuffer({ numberOfChannels: ch, length: len, sampleRate: rate }); } createPeriodicWave() { return new __jbAudio.PeriodicWave(); }
  // no decoder: a short silent buffer, so apps that load their sounds keep going
  decodeAudioData(data, ok) { var b = new __jbAudio.AudioBuffer({ numberOfChannels: 1, length: 1, sampleRate: this.sampleRate }); if (typeof ok === "function") setTimeout(function () { ok(b); }, 0); return Promise.resolve(b); }
  getOutputTimestamp() { return { contextTime: this.currentTime, performanceTime: typeof performance !== "undefined" ? performance.now() : 0 }; }
  resume() { this._setState("running"); return Promise.resolve(); } suspend() { this._setState("suspended"); return Promise.resolve(); } close() { this._setState("closed"); return Promise.resolve(); }
}
Object.keys(__jbAudio).forEach(function (k) { if (!(k in globalThis)) Object.defineProperty(globalThis, k, { value: __jbAudio[k], writable: true, configurable: true, enumerable: false }); });
class SpeechSynthesisUtterance extends EventTarget { constructor(t) { super(); this.text = t || ""; } }
globalThis.speechSynthesis = { speak: function () {}, cancel: function () {}, pause: function () {}, resume: function () {}, getVoices: function () { return []; }, speaking: false, pending: false, paused: false, onvoiceschanged: null, addEventListener: function () {}, removeEventListener: function () {} };
class Intl_Segmenter { constructor(l, o) { this.granularity = (o && o.granularity) || "grapheme"; } segment(s) { var out = __jb.arrayFrom(String(s)).map(function (c, i) { return { segment: c, index: i, input: s, isWordLike: /\w/.test(c) }; }); out.containing = function (i) { return out[i]; }; return out; } resolvedOptions() { return { locale: "en", granularity: this.granularity }; } }
if (typeof Intl !== "undefined" && !Intl.Segmenter) Intl.Segmenter = Intl_Segmenter;
class ResizeObserverEntryLegacy {} class IntersectionObserverEntryLegacy {}
class VisualViewport extends EventTarget { constructor() { super(); this.width = 1280; this.height = 720; this.offsetLeft = 0; this.offsetTop = 0; this.pageLeft = 0; this.pageTop = 0; this.scale = 1; this.onresize = null; this.onscroll = null; } }
globalThis.visualViewport = new VisualViewport();
globalThis.caches = { open: function () { return Promise.resolve({ match: function () { return Promise.resolve(undefined); }, matchAll: function () { return Promise.resolve([]); }, add: function () { return Promise.resolve(); }, addAll: function () { return Promise.resolve(); }, put: function () { return Promise.resolve(); }, delete: function () { return Promise.resolve(false); }, keys: function () { return Promise.resolve([]); } }); }, match: function () { return Promise.resolve(undefined); }, has: function () { return Promise.resolve(false); }, delete: function () { return Promise.resolve(false); }, keys: function () { return Promise.resolve([]); } };
globalThis.reportError = function reportError(e) {
  if (arguments.length < 1) throw new TypeError("Window.reportError: At least 1 argument required, but only 0 passed");
  if (typeof __jb.reportException === "function") __jb.reportException(e); else console.error(String(e && e.stack ? e + "\n" + e.stack : e));
}
// __jb.dialogs is drained into each collect result; __jb.dialogLog keeps the last 50 for callers
// that read the page afterwards (an agent harness reporting "the page showed an alert").
__jb.noteDialog = function (type, m) {
  var d = { type: type, message: String(m), time: Date.now() };
  __jb.dialogs.push(d);
  var log = __jb.dialogLog || (__jb.dialogLog = []);
  log.push(d); if (log.length > 50) log.shift();
};
globalThis.alert = function alert(m) { console.log("ALERT: " + (m === undefined ? "" : m)); __jb.noteDialog("alert", m); }
globalThis.confirm = function confirm(m) { console.log("CONFIRM: " + (m === undefined ? "" : m)); __jb.noteDialog("confirm", m); return true; }
globalThis.prompt = function prompt(m, d) { console.log("PROMPT: " + (m === undefined ? "" : m)); __jb.noteDialog("prompt", m); return d === undefined || d === null ? "" : String(d); }
__jb.dialogs = [];
__jb.dialogLog = [];
globalThis.print = function print() {}
globalThis.open = function open(url) { if (url) __jb.navigate(url, "open"); return null; }
globalThis.close = function close() {}; globalThis.focus = function focus() {}; globalThis.blur = function blur() {}; globalThis.stop = function stop() {}
globalThis.scroll = function scroll() {}; globalThis.scrollTo = function scrollTo() {}; globalThis.scrollBy = function scrollBy() {}; globalThis.moveTo = function moveTo() {}; globalThis.moveBy = function moveBy() {}; globalThis.resizeTo = function resizeTo() {}; globalThis.resizeBy = function resizeBy() {}
globalThis.getSelection = function getSelection() { return __jb.currentDocument.getSelection(); }
globalThis.postMessage = function postMessage(d) { var self_ = globalThis; setTimeout(function () { self_.dispatchEvent(new MessageEvent("message", { data: d, origin: location.origin, source: globalThis })); }, 0); }
globalThis.captureEvents = function captureEvents() {}; globalThis.releaseEvents = function releaseEvents() {}
// The visibility of every bar is a single fact per window: normal windows
// show them, popup windows (window.open with popup-implying features) do not.
class BarProp {
  constructor() { if (!__jb.barPropConstructing) throw new TypeError("Illegal constructor"); }
  get visible() { return !__jb.isPopupWindow && !__jb.discardedFlag; } // false in popups and once the context is DISCARDED (later than closed)
}
globalThis.BarProp = BarProp;
(function () {
  ["locationbar", "menubar", "personalbar", "scrollbars", "statusbar", "toolbar"].forEach(function (name) {
    __jb.barPropConstructing = true;
    var bar = new BarProp(); // one object per property, all reporting the same fact
    __jb.barPropConstructing = false;
    Object.defineProperty(globalThis, name, { get: function () { return bar; }, set: function () {}, configurable: true, enumerable: true });
  });
})();
globalThis.innerWidth = 1280; globalThis.innerHeight = 720; globalThis.outerWidth = 1280; globalThis.outerHeight = 720; globalThis.screenX = 0; globalThis.screenY = 0; globalThis.screenLeft = 0; globalThis.screenTop = 0; globalThis.scrollX = 0; globalThis.scrollY = 0; globalThis.pageXOffset = 0; globalThis.pageYOffset = 0; globalThis.devicePixelRatio = 1; globalThis.name = ""; globalThis.status = ""; globalThis.closed = false; Object.defineProperty(globalThis, "isSecureContext", { get: function () { return __jb.secureContext !== false; }, enumerable: true, configurable: true }); globalThis.crossOriginIsolated = false; globalThis.origin = "null"; globalThis.opener = null; globalThis.frameElement = null; globalThis.parent = globalThis; globalThis.top = globalThis; globalThis.menubar = globalThis.toolbar = globalThis.locationbar = globalThis.personalbar = globalThis.scrollbars = globalThis.statusbar = { visible: true }; globalThis.external = { AddSearchProvider: function () {}, IsSearchProviderInstalled: function () { return 0; } }; globalThis.event = undefined; globalThis.onerror = null; globalThis.onunhandledrejection = null; globalThis.onload = null; globalThis.onbeforeunload = null; globalThis.onunload = null; globalThis.onpopstate = null; globalThis.onhashchange = null; globalThis.onresize = null; globalThis.onscroll = null; globalThis.onmessage = null; globalThis.onfocus = null; globalThis.onblur = null; globalThis.onpagehide = null; globalThis.onpageshow = null; globalThis.onstorage = null; globalThis.chrome = { runtime: { id: undefined, connect: function () { return { onMessage: { addListener: function () {} }, postMessage: function () {}, disconnect: function () {} }; }, sendMessage: function () {}, onMessage: { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } }, onConnect: { addListener: function () {}, removeListener: function () {} } }, loadTimes: function () { return {}; }, csi: function () { return {}; }, app: { isInstalled: false, getDetails: function () { return null; }, getIsInstalled: function () { return false; }, runningState: function () { return "cannot_run"; } }, webstore: {} };
