// Part 6b: Web APIs with real backends (binary-safe fetch/XHR/Blob, WebSocket,
// EventSource, Compression Streams, clipboard, geolocation, notifications,
// cookies, IndexedDB persistence).

// ---- Blob / File / FileReader (byte-accurate) ----
// File API: Blob and File (https://w3c.github.io/FileAPI/).
__jb.nativeEol = function () { return /win/i.test((typeof navigator !== "undefined" && navigator.platform) || "") ? "\r\n" : "\n"; };
// This engine throws when a detached buffer's byteLength/detached are read.
__jb.blobIsDetached = function (buf) { try { return buf.detached === true || buf.byteLength === 0; } catch (e) { return true; } };
// "process blob parts": sequence<(BufferSource or Blob or USVString)> + BlobPropertyBag.
__jb.blobParts = function (parts, options, ctor) {
  if (parts !== undefined) {
    if (parts === null || (typeof parts !== "object" && typeof parts !== "function") || typeof parts[Symbol.iterator] !== "function") throw new TypeError(ctor + " constructor: argument 1 can't be converted to a sequence.");
  }
  var endings = "transparent", type = "";
  if (options !== undefined && options !== null) {
    if (typeof options !== "object" && typeof options !== "function") throw new TypeError(ctor + " constructor: argument 2 can't be converted to a dictionary.");
    if (options.endings !== undefined) {
      endings = String(options.endings);
      if (endings !== "transparent" && endings !== "native") throw new TypeError("'" + endings + "' is not a valid value for enumeration EndingType.");
    }
    if (options.type !== undefined) type = String(options.type);
  }
  var chunks = [];
  if (parts !== undefined) {
    for (var part of parts) {
      if (part instanceof Blob) chunks.push(part._bytes());
      else if (part instanceof ArrayBuffer) chunks.push(__jb.blobIsDetached(part) ? new Uint8Array(0) : new Uint8Array(part));
      else if (ArrayBuffer.isView(part)) chunks.push(__jb.blobIsDetached(part.buffer) ? new Uint8Array(0) : new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
      else {
        var str = __jb.wellFormed(String(part));
        if (endings === "native") str = str.replace(/\r\n|\r|\n/g, __jb.nativeEol());
        chunks.push(__utf8Encode(str));
      }
    }
  }
  var total = __jb.A.reduce.call(chunks, function (n, c) { return n + c.length; }, 0);
  var buf = new Uint8Array(total), off = 0;
  chunks.forEach(function (c) { buf.set(c, off); off += c.length; });
  return { buf: buf, type: __jb.blobType(type) };
};
class Blob {
  constructor(parts = undefined, options = undefined, ctor = "Blob") {
    var r = __jb.blobParts(parts, options, ctor);
    Object.defineProperty(this, "_buf", { value: r.buf, enumerable: false, writable: true });
    Object.defineProperty(this, "_type", { value: r.type, enumerable: false, writable: true });
  }
  get type() { return this._type; }
  _bytes() { return this._buf; }
  _text() { return new TextDecoder().decode(this._buf); }
  get size() { return this._buf.length; }
  text() { var self_ = this; return new Promise(function (resolve) { resolve(self_._text()); }); }
  arrayBuffer() { return Promise.resolve(this._buf.slice().buffer); }
  bytes() { return Promise.resolve(this._buf.slice()); }
  slice(start = undefined, end = undefined, contentType = undefined) {
    var size = this.size;
    var s = start === undefined ? 0 : __jb.toIntegerClamp(start);
    var e = end === undefined ? size : __jb.toIntegerClamp(end);
    s = s < 0 ? Math.max(size + s, 0) : Math.min(s, size);
    e = e < 0 ? Math.max(size + e, 0) : Math.min(e, size);
    var span = Math.max(e - s, 0);
    // The sliced blob's type is the argument (lowercased, ASCII-printable only), never the source's.
    var t = contentType === undefined ? "" : String(contentType);
    t = /^[\x20-\x7e]*$/.test(t) ? t.toLowerCase() : "";
    var b = new Blob();
    b._buf = this._buf.slice(s, s + span);
    b._type = t;
    return b;
  }
  stream() { var bytes = this._buf.slice(); return new ReadableStream({ type: "bytes", start: function (c) { if (bytes.length) c.enqueue(bytes); c.close(); } }); }
  textStream() { var self_ = this; return new ReadableStream({ start: function (c) { if (self_.size) c.enqueue(self_._text()); c.close(); } }); }
}
// WebIDL long long conversion: NaN/±Infinity become 0, otherwise truncate.
__jb.toIntegerClamp = function (v) { v = Number(v); return Number.isFinite(v) ? Math.trunc(v) : 0; };
class File extends Blob {
  constructor(parts, name, options = undefined) {
    if (arguments.length < 2) throw new TypeError("File constructor: At least 2 arguments required, but only " + arguments.length + " passed");
    super(parts, options, "File");
    this.name = __jb.wellFormed(String(name));
    var lm = options !== undefined && options !== null && options.lastModified !== undefined ? __jb.toIntegerClamp(options.lastModified) : Date.now();
    this.lastModified = lm;
    this.lastModifiedDate = new Date(lm);
    this.webkitRelativePath = "";
  }
}
class FileList extends Array { item(i) { return this[i] || null; } }
class FileReader extends EventTarget {
  constructor() { super(); this.readyState = 0; this.result = null; this.error = null; this.onload = null; this.onerror = null; this.onloadend = null; this.onprogress = null; this.onabort = null; this.onloadstart = null; }
  _finish(result) { var self_ = this; this.readyState = 1; this.dispatchEvent(new ProgressEvent("loadstart")); setTimeout(function () { self_.readyState = 2; self_.result = result; self_.dispatchEvent(new ProgressEvent("load", { lengthComputable: true, loaded: 1, total: 1 })); self_.dispatchEvent(new ProgressEvent("loadend")); }, 0); }
  readAsText(b) { this._finish(b._text()); }
  readAsDataURL(b) { this._finish("data:" + (b.type || "application/octet-stream") + ";base64," + __jb.bytesToB64(b._bytes())); }
  readAsArrayBuffer(b) { this._finish(b._bytes().slice().buffer); }
  readAsBinaryString(b) { var bytes = b._bytes(), s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); this._finish(s); }
  abort() { this.readyState = 2; this.dispatchEvent(new ProgressEvent("abort")); }
}
FileReader.EMPTY = 0; FileReader.LOADING = 1; FileReader.DONE = 2;

// ---- Streams (queue-based, synchronous producers) ----
class TextDecoderStream extends TransformStream {
  constructor(label, options) {
    var dec = new TextDecoder(label, options);
    super({ transform: function (chunk, c) { if (!(chunk instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk)) throw new TypeError("TextDecoderStream: chunk is not a BufferSource"); var t = dec.decode(chunk, { stream: true }); if (t) c.enqueue(t); }, flush: function (c) { var t = dec.decode(); if (t) c.enqueue(t); } });
    Object.defineProperty(this, "encoding", { value: dec.encoding });
    Object.defineProperty(this, "fatal", { value: dec.fatal });
    Object.defineProperty(this, "ignoreBOM", { value: dec.ignoreBOM });
  }
}
class TextEncoderStream extends TransformStream {
  constructor() {
    var enc = new TextEncoder(), pendingHigh = "";
    super({ transform: function (chunk, c) { var str = pendingHigh + String(chunk); pendingHigh = ""; if (str.length && str.charCodeAt(str.length - 1) >= 0xd800 && str.charCodeAt(str.length - 1) <= 0xdbff) { pendingHigh = str.slice(-1); str = str.slice(0, -1); } if (str) c.enqueue(enc.encode(str)); }, flush: function (c) { if (pendingHigh) c.enqueue(enc.encode(pendingHigh)); } });
    Object.defineProperty(this, "encoding", { value: "utf-8" });
  }
}
function __compressionStream(format, decompress) {
  var parts = [];
  return {
    transform: function (chunk) { parts.push(__jb.toBytes(chunk)); },
    flush: function (c) {
      var total = __jb.A.reduce.call(parts, function (n, p) { return n + p.length; }, 0), buf = new Uint8Array(total), off = 0;
      parts.forEach(function (p) { buf.set(p, off); off += p.length; });
      var r = __jb.native("compress", { format: format, data: __jb.bytesToB64(buf), decompress: decompress });
      if (!r || r.error) throw new TypeError(r && r.error || "compression failed");
      c.enqueue(__jb.b64ToBytes(r.bytes));
    },
  };
}
class CompressionStream extends TransformStream { constructor(format) { super(__compressionStream(String(format), false)); } }
class DecompressionStream extends TransformStream { constructor(format) { super(__compressionStream(String(format), true)); } }

// multipart/form-data bytes -> FormData (RFC 7578: CRLF-delimited parts, quoted names).
__jb.parseMultipart = function (bytes, boundary) {
  var fd = new FormData();
  var delim = __utf8Encode("--" + boundary);
  var indexOf = function (needle, from) {
    outer: for (var i = from; i <= bytes.length - needle.length; i++) { for (var j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer; return i; }
    return -1;
  };
  var pos = indexOf(delim, 0);
  if (pos < 0) throw new TypeError("Could not parse content as FormData.");
  pos += delim.length;
  for (;;) {
    if (bytes[pos] === 0x2d && bytes[pos + 1] === 0x2d) break; // closing delimiter
    if (bytes[pos] === 0x0d && bytes[pos + 1] === 0x0a) pos += 2;
    var headerEnd = indexOf(__utf8Encode("\r\n\r\n"), pos);
    if (headerEnd < 0) throw new TypeError("Could not parse content as FormData.");
    var headerText = __utf8Decode(bytes.subarray(pos, headerEnd));
    var next = indexOf(delim, headerEnd + 4);
    if (next < 0) throw new TypeError("Could not parse content as FormData.");
    var bodyEnd = next >= 2 && bytes[next - 2] === 0x0d && bytes[next - 1] === 0x0a ? next - 2 : next;
    var body = bytes.subarray(headerEnd + 4, bodyEnd);
    var name = null, filename = null, type = "text/plain";
    headerText.split("\r\n").forEach(function (line) {
      var m = /^([^:]+):\s*(.*)$/.exec(line); if (!m) return;
      var hname = m[1].toLowerCase(), value = m[2];
      if (hname === "content-disposition") {
        var n = /;\s*name="((?:[^"\\]|\\.)*)"/.exec(value); if (n) name = n[1].replace(/\\(.)/g, "$1");
        var f = /;\s*filename="((?:[^"\\]|\\.)*)"/.exec(value); if (f) filename = f[1].replace(/\\(.)/g, "$1");
      } else if (hname === "content-type") type = value.trim();
    });
    if (name === null) throw new TypeError("Could not parse content as FormData.");
    if (filename !== null) fd.append(name, new File([body.slice()], filename, { type: type }));
    else fd.append(name, __utf8Decode(body));
    pos = next + delim.length;
  }
  return fd;
};

// ---- fetch / Request / Response / XMLHttpRequest (binary-safe) ----
// A body from another realm (a frame's fetch given the parent's stream / Blob) becomes this realm's.
__jb.localBodyInit = function (b) {
  if (b === null || typeof b !== "object") return b;
  if (b instanceof ReadableStream || b instanceof Blob || b instanceof FormData || b instanceof URLSearchParams || b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return b;
  var tag = Object.prototype.toString.call(b);
  try {
    if (tag === "[object ReadableStream]") {
      var reader = b.getReader();
      return new ReadableStream({
        pull: function (c) { return reader.read().then(function (x) { if (x.done) c.close(); else c.enqueue(x.value); }, function (e) { c.error(e); }); },
        cancel: function (r) { return reader.cancel(r); },
      });
    }
    if ((tag === "[object Blob]" || tag === "[object File]") && typeof b._bytes === "function") return new Blob([b._bytes()], { type: b.type });
    if (tag === "[object ArrayBuffer]") return new Uint8Array(new Uint8Array(b)).buffer;
    if (tag === "[object URLSearchParams]") return new URLSearchParams(b.toString());
    if (tag === "[object FormData]") { var fd = new FormData(); b.forEach(function (v, k) { if (typeof v === "string") fd.append(k, v); else fd.append(k, new Blob([v._bytes()], { type: v.type }), v.name); }); return fd; }
  } catch (e) {}
  return b;
};
class Body {
  _init(body) { this._body = body === undefined ? null : __jb.localBodyInit(body); this.bodyUsed = false; }
  _bodyBytes() {
    var b = this._body;
    if (b === null || b === undefined) return new Uint8Array(0);
    if (typeof b === "string") return __utf8Encode(b);
    if (b instanceof Blob) return b._bytes();
    if (b instanceof FormData) return (this._multipart || (this._multipart = __jb.multipartEncode(b))).bytes;
    if (b instanceof URLSearchParams) return __utf8Encode(b.toString());
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (b instanceof ReadableStream) return new Uint8Array(0); // stream bodies are read asynchronously (fetch)
    return __utf8Encode(String(b));
  }
  _bodyText() { return typeof this._body === "string" ? this._body : __utf8Decode(this._bodyBytes()); }
  // Fetch "extract a body": the Content-Type a body implies when none was given.
  _implicitContentType() {
    var b = this._body, type = null;
    if (b instanceof FormData) { this._multipart = __jb.multipartEncode(b); type = this._multipart.contentType; }
    else if (b instanceof URLSearchParams) type = "application/x-www-form-urlencoded;charset=UTF-8";
    else if (typeof b === "string") type = "text/plain;charset=UTF-8";
    else if (b instanceof Blob && b.type) type = b.type;
    if (type && !this.headers.has("content-type")) { var guard = this.headers._guard; this.headers._guard = "none"; this.headers.set("content-type", type); this.headers._guard = guard; }
  }
  _bodyIsText() { return typeof this._body === "string" || this._body instanceof FormData || this._body instanceof URLSearchParams; }
  get body() {
    if (this._body === null || this._body === undefined) return null;
    if (!this._bodyStream) {
      if (this._body instanceof ReadableStream) this._bodyStream = this._body;
      else { var bytes = this._bodyBytes().slice(); this._bodyStream = new ReadableStream({ type: "bytes", start: function (c) { if (bytes.length) c.enqueue(bytes); c.close(); } }); }
    }
    return this._bodyStream;
  }
  // Async byte collection: streams are drained through their reader so that
  // pipes (pipeThrough / pipeTo) can finish producing.
  _collect(strict) {
    if (this.bodyUsed) return Promise.reject(new TypeError("body stream already read"));
    var b = this._body;
    // A null body is never "used" (spec: bodyUsed stays false).
    if (b !== null && b !== undefined) this.bodyUsed = true;
    if (!(b instanceof ReadableStream)) return Promise.resolve(this._bodyBytes());
    var reader = b.getReader(), chunks = [];
    return (function next() { return reader.read().then(function (x) { if (x.done) { var total = __jb.A.reduce.call(chunks, function (n, c) { return n + c.length; }, 0), out = new Uint8Array(total), off = 0; chunks.forEach(function (c) { out.set(c, off); off += c.length; }); return out; } if (strict && Object.prototype.toString.call(x.value) !== "[object Uint8Array]") throw new TypeError("fetch: request body stream chunks must be Uint8Array"); chunks.push(__jb.toBytes(x.value)); return next(); }); })();
  }
  text() { return this._collect().then(function (b) { return new TextDecoder().decode(b); }); }
  json() { return this._collect().then(function (b) { var t = new TextDecoder().decode(b); try { return JSON.parse(t); } catch (e) { throw new SyntaxError("JSON.parse: " + e.message); } }); }
  arrayBuffer() { return this._collect().then(function (b) { return b.slice().buffer; }); }
  bytes() { return this._collect().then(function (b) { return b.slice(); }); }
  blob() { var self_ = this; return this._collect().then(function (b) { return new Blob([b], { type: (self_.headers && self_.headers.get("content-type")) || "" }); }); }
  formData() {
    var self_ = this;
    return this._collect().then(function (b) {
      var mime = __jb.parseMime((self_.headers && self_.headers.get("content-type")) || "");
      if (mime && mime.essence === "multipart/form-data") {
        var boundary = mime.params.boundary;
        if (!boundary) throw new TypeError("Missing multipart boundary");
        return __jb.parseMultipart(b, boundary);
      }
      if (mime && mime.essence === "application/x-www-form-urlencoded") { var fd = new FormData(); new URLSearchParams(__utf8Decode(b)).forEach(function (v, k) { fd.append(k, v); }); return fd; }
      throw new TypeError("Could not parse content as FormData.");
    });
  }
}
// Fetch "normalize a method": standard methods are uppercased, others keep their case.
__jb.normalizeMethod = function (m) {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(m)) throw new TypeError("Invalid HTTP method '" + m + "'");
  if (/^(connect|trace|track)$/i.test(m)) throw new TypeError("Forbidden HTTP method '" + m + "'");
  return /^(delete|get|head|options|post|put)$/i.test(m) ? m.toUpperCase() : m;
};
class Request extends Body {
  constructor(input, init) {
    super(); init = init || {};
    // a Request of another realm counts too
    var src = input instanceof Request || (input && typeof input === "object" && Object.prototype.toString.call(input) === "[object Request]" && typeof input._bodyBytes === "function") ? input : null;
    this.url = src ? src.url : __jb.resolveURL(String(input));
    // a non-empty init resets the request's origin, referrer and referrer policy to the client's
    var initEmpty = Object.keys(init).length === 0;
    if (src && src._jbOrigin && initEmpty) Object.defineProperty(this, "_jbOrigin", { value: src._jbOrigin, writable: true, configurable: true });
    this.method = __jb.normalizeMethod(String(init.method || (src && src.method) || "GET"));
    this.mode = init.mode || (src && src.mode) || "cors";
    if (init.mode === "navigate") throw new TypeError("Request: 'navigate' mode is not allowed");
    this.headers = new Headers();
    this.headers._guard = this.mode === "no-cors" ? "request-no-cors" : "request";
    var headersInit = init.headers || (src && src.headers);
    if (headersInit) this.headers._fill(headersInit);
    this._init(init.body !== undefined ? init.body : src ? src._body : null);
    this._implicitContentType();
    this.mode = init.mode || (src && src.mode) || "cors"; this.credentials = init.credentials || (src && src.credentials) || "same-origin"; this.cache = init.cache || (src && src.cache) || "default"; this.redirect = init.redirect || (src && src.redirect) || "follow"; this.referrer = __jb.requestReferrerInit(init.referrer, src && Object.keys(init).length === 0 ? src : null); this.referrerPolicy = init.referrerPolicy !== undefined ? __jb.requestReferrerPolicyInit(init.referrerPolicy) : src && initEmpty ? src.referrerPolicy : ""; this.integrity = init.integrity !== undefined ? String(init.integrity) : (src && src.integrity) || ""; this.keepalive = init.keepalive !== undefined ? !!init.keepalive : !!(src && src.keepalive); this.signal = init.signal || new AbortSignal(); this.destination = ""; this.priority = init.priority || "auto"; this.duplex = "half";
    this.isReloadNavigation = !!(src && initEmpty && src.isReloadNavigation); this.isHistoryNavigation = !!(src && initEmpty && src.isHistoryNavigation);
  }
  clone() { return new Request(this, { body: this._body }); }
}
class Response extends Body {
  constructor(body, init) { super(); init = init || {}; this._init(body); this.status = init.status === undefined ? 200 : init.status; this.statusText = init.statusText || ""; this.headers = new Headers(); this.headers._guard = "response"; if (init.headers) this.headers._fill(init.headers); this._implicitContentType(); Object.defineProperty(this, "type", { value: "basic", writable: true, enumerable: true, configurable: true }); this.url = init.url || ""; this.redirected = false; this.ok = this.status >= 200 && this.status < 300; }
  clone() { var r = new Response(this._body, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url }); r.type = this.type; r.redirected = this.redirected; if (this._opaque) Object.defineProperty(r, "_opaque", { value: this._opaque, configurable: true }); if (this._redirect) Object.defineProperty(r, "_redirect", { value: this._redirect, configurable: true }); return r; }
  static error() { var r = new Response(null, { status: 0 }); r.type = "error"; r.headers._guard = "immutable"; return r; }
  static redirect(url, status) { return new Response(null, { status: status || 302, headers: { location: String(url) } }); }
  static json(data, init) { var r = new Response(JSON.stringify(data), init); r.headers.set("content-type", "application/json"); return r; }
}
// Request "referrer" init: "" = no referrer, "about:client" = the client, a same-origin URL
// stays, a cross-origin one becomes the client. The getter shape: "" / "about:client" / URL.
__jb.requestReferrerInit = function (v, src) {
  if (v === undefined) return src ? src.referrer : "about:client";
  v = String(v);
  if (v === "") return "";
  var u;
  try { u = new URL(v, (typeof __jb.currentDocument !== "undefined" && __jb.currentDocument.baseURI) || location.href); } catch (e) { throw new TypeError("Request: invalid referrer URL"); }
  if (u.href === "about:client") return "about:client";
  try { if (u.origin !== new URL(location.href).origin) return "about:client"; } catch (e2) { return "about:client"; }
  return u.href;
};
__jb.requestReferrerPolicyInit = function (v) {
  v = String(v);
  if (v !== "" && __jb.REFERRER_POLICIES.indexOf(v) < 0) throw new TypeError("Request: invalid referrerPolicy '" + v + "'");
  return v;
};
// {referrer, referrerPolicy} payload fields of a Request.
__jb.requestReferrerFields = function (req) {
  var r = typeof __jb.requestReferrer === "function" ? __jb.requestReferrer(req.referrerPolicy) : { referrer: "", referrerPolicy: "" };
  if (req.referrer === "") r.referrer = "";
  else if (req.referrer && req.referrer !== "about:client" && r.referrer !== "") r.referrer = req.referrer;
  return r;
};
// The top-level document's URL (the "site for cookies" of this realm's documents).
__jb.cookieSite = function () {
  try { var fc = __jb.frameContext; if (!fc || !fc.top || fc.top === globalThis) return ""; return fc.top.document.URL; } catch (e) { return ""; }
};
__jb.apiCalls = [];
// Perform a request through the host; returns {result, bodyValue} or null on network error.
__jb.hostFetch = function (url, method, headers, bodyBytes, isText, bodyText, initiator, extra, asyncCb) {
  if (/^blob:/i.test(url)) {
    var entry = __jb.blobUrls && __jb.blobUrls[String(url).split("#")[0]];
    if (!entry || !(entry instanceof Blob) || (method !== "GET" && method !== "HEAD")) return { error: "blob URL is not available" };
    var blobBytes = method === "HEAD" ? new Uint8Array(0) : entry._bytes().slice();
    return { result: { ok: true, status: 200, statusText: "OK", url: url, headers: { "content-type": entry.type, "content-length": String(entry.size) } }, body: blobBytes };
  }
  var payload = Object.assign({ url: url, method: method, headers: headers }, extra || {});
  if (bodyBytes && bodyBytes.length && method !== "GET" && method !== "HEAD") { if (isText) payload.body = bodyText; else payload.bodyBase64 = __jb.bytesToB64(bodyBytes); }
  var started = performance.now();
  // asyncCb: the request runs on a host thread; the event loop calls asyncCb with the outcome
  // (null is returned then). Hosts that answer at once (data:, blocked, budget) give it now.
  if (asyncCb) {
    payload.async = true;
    var first = __jb.native("fetch", payload);
    if (first && first.pending !== undefined) {
      __jb.registerAsyncFetch(first.pending, function (res) { asyncCb(__jb.hostFetchDone(res, url, method, initiator, extra, started)); });
      return null;
    }
    return __jb.hostFetchDone(first, url, method, initiator, extra, started);
  }
  return __jb.hostFetchDone(__jb.native("fetch", payload), url, method, initiator, extra, started);
};
__jb.hostFetchDone = function (result, url, method, initiator, extra, started) {
  __jb.apiCalls.push({ url: url, method: method, status: result ? result.status : 0 });
  if (__jb.cookiesMaybeChanged) __jb.cookiesMaybeChanged(); // Set-Cookie on the response (cookieStore change events)
  // subresource destinations get their Resource Timing entry from the host's record
  if (extra && extra.dest && extra.dest !== "empty" && __jb.pullResourceTimings) __jb.pullResourceTimings();
  // Resource Timing: one entry per request that got a response.
  if (result && result.status !== 0 && typeof performance._addResource === "function" && !(extra && extra.dest && extra.dest !== "empty")) {
    var size = result.bodyBase64 !== undefined ? Math.floor(result.bodyBase64.length * 3 / 4) : (result.text || "").length;
    var ct = result.headers && (result.headers["content-type"] || result.headers["Content-Type"]) || "";
    var ended = performance.now(), mime = __jb.minimizeMime ? __jb.minimizeMime(ct) : String(ct).split(";")[0].trim().toLowerCase();
    // the entry is queued at response end: after the calling task's synchronous code (observers
    // registered right after fetch() see it)
    var iUrl = ""; try { var cs0 = __jb.currentDocument && __jb.currentDocument.currentScript; iUrl = cs0 && cs0.src ? cs0.src : __jb.currentDocument ? __jb.currentDocument.URL : String(location.href); } catch (e0) {}
    var addIt = function () { var ent = performance._addResource(result.url || url, initiator || "fetch", started, ended, { transfer: size + 300, encoded: size, decoded: size }, result.status, mime); if (ent && ent._rt) ent._rt.initiatorUrl = iUrl; };
    if (initiator === "xmlhttprequest") addIt(); else Promise.resolve().then(addIt);
  }
  if (result && result.opaqueRedirect) return { opaqueRedirect: true, result: result };
  if (!result || result.status === 0) return { error: result ? result.statusText : "network error" };
  var body = result.bodyBase64 !== undefined ? __jb.b64ToBytes(result.bodyBase64) : (result.text || "");
  return { result: result, body: body };
};
// Origin/site relationship of a request URL to the page (Fetch "same origin",
// HTML "same site" via the last two host labels, enough for the test hosts).
__jb.originOf = function (url) { try { return new URL(url).origin; } catch (e) { return "null"; } };
__jb.siteOf = function (host) { var parts = String(host).toLowerCase().split("."); return parts.length > 2 ? parts.slice(-2).join(".") : parts.join("."); };
__jb.requestSite = function (url) {
  var page = (typeof location !== "undefined" && location.href) || "about:blank";
  if (/^(data|blob|about):/i.test(url)) return "same-origin";
  if (__jb.originOf(url) === __jb.originOf(page)) return "same-origin";
  try { if (__jb.siteOf(new URL(url).hostname) === __jb.siteOf(new URL(page).hostname)) return "same-site"; } catch (e) {}
  return "cross-site";
};
__jb.CORS_SAFELISTED_RESPONSE = /^(cache-control|content-language|content-length|content-type|expires|last-modified|pragma)$/;
// CORS check of a response for `origin`; a `*` never satisfies a credentialed request.
__jb.corsCheck = function (headers, origin, credentials) {
  var acao = headers["access-control-allow-origin"];
  if (acao === undefined || acao === null) return false;
  acao = String(acao).trim();
  if (acao === "*") return !credentials;
  if (acao !== origin) return false;
  if (credentials && String(headers["access-control-allow-credentials"] || "").trim() !== "true") return false;
  return true;
};
// Send a request with the Fetch mode/credentials/CORS rules applied; returns a Response or throws.
__jb.corsFetchGen = function* (req, bytes, isText, text, initiator, wireHeaders) {
  var site = __jb.requestSite(req.url), sameOrigin = site === "same-origin";
  var pageOrigin = req._jbOrigin || __jb.originOf((typeof location !== "undefined" && location.href) || "about:blank");
  var credentials = req.credentials === "include" || (req.credentials === "same-origin" && sameOrigin);
  if (!sameOrigin && req.mode === "same-origin") throw new TypeError("NetworkError when attempting to fetch resource: same-origin mode");
  if (!sameOrigin && req.mode === "no-cors" && !/^(GET|HEAD|POST)$/.test(req.method)) throw new TypeError("NetworkError when attempting to fetch resource: no-cors mode does not allow " + req.method);
  var wire = wireHeaders || req.headers._wireJSON();
  var meta = { redirect: req.redirect, credentials: credentials, mode: req.mode, site: site, origin: pageOrigin, dest: req.destination || "" };
  var refFields = __jb.requestReferrerFields(req); meta.referrer = refFields.referrer; meta.referrerPolicy = refFields.referrerPolicy;
  // Content Security Policy (connect-src, or the destination's directive) and mixed content
  var cspDest = req.destination || "";
  var mixed = __jb.mixed ? __jb.mixed.filter(cspDest, req.url) : { url: req.url };
  if (mixed.blocked) throw new TypeError("NetworkError when attempting to fetch resource: blocked as mixed content");
  if (mixed.mode) meta.mixed = mixed.mode;
  if (__jb.csp && !__jb.csp.allowsRequest(cspDest, req.url)) throw new TypeError("NetworkError when attempting to fetch resource: blocked by Content Security Policy");
  var cspLists = __jb.csp ? __jb.csp.redirectLists(cspDest) : null;
  if (cspLists) meta.csp = cspLists;
  var cors = !sameOrigin && req.mode === "cors";
  if (cors) {
    var unsafe = [];
    Object.keys(wire).forEach(function (k) { var lk = k.toLowerCase(); if (!__jb.isCorsSafelistedRequestHeader(lk, String(wire[k]))) unsafe.push(lk); });
    if (!/^(GET|HEAD|POST)$/.test(req.method) || unsafe.length) {
      var pfHeaders = { "Access-Control-Request-Method": req.method };
      if (unsafe.length) pfHeaders["Access-Control-Request-Headers"] = unsafe.sort().join(",");
      var pf = yield [req.url, "OPTIONS", pfHeaders, null, true, null, initiator, { redirect: "error", credentials: false, mode: "cors", site: site, origin: pageOrigin, preflight: true }];
      if (pf.error || !pf.result || pf.result.status < 200 || pf.result.status > 299) {
        if (!__jb.wptMode) try { console.warn("Cross-Origin Request Blocked: " + req.method + " " + req.url + " (Reason: CORS preflight response did not succeed). " + (pf.error ? String(pf.error) : "Status code: " + (pf.result ? pf.result.status : "none"))); } catch (e) {}
        throw new TypeError("NetworkError when attempting to fetch resource: CORS preflight failed");
      }
      var ph = pf.result.headers || {};
      if (!__jb.corsCheck(ph, pageOrigin, credentials)) throw new TypeError("NetworkError when attempting to fetch resource: CORS preflight origin check failed");
      var methods = String(ph["access-control-allow-methods"] || "").split(",").map(function (s) { return s.trim(); });
      var allowAllMethods = methods.indexOf("*") >= 0 && !credentials;
      if (!/^(GET|HEAD|POST)$/.test(req.method) && !allowAllMethods && methods.indexOf(req.method) < 0) throw new TypeError("NetworkError when attempting to fetch resource: method not allowed by CORS preflight");
      var allowed = String(ph["access-control-allow-headers"] || "").split(",").map(function (s) { return s.trim().toLowerCase(); });
      var allowAllHeaders = allowed.indexOf("*") >= 0 && !credentials;
      unsafe.forEach(function (h) { if (!allowAllHeaders && allowed.indexOf(h) < 0 && !(h === "authorization" && false)) throw new TypeError("NetworkError when attempting to fetch resource: header " + h + " not allowed by CORS preflight"); });
    }
  }
  // HTTP authentication: credentials in the URL go out as Basic auth and are remembered per origin
  // (the authentication cache); later credentialed requests to that origin reuse them.
  var fetchUrl = mixed.url || req.url;
  try {
    var authJb = __jb; for (var ai = 0; ai < 8 && authJb.workerOwnerJb && authJb.workerOwnerJb !== authJb; ai++) authJb = authJb.workerOwnerJb;
    var authTop = authJb.topJb ? authJb.topJb() : authJb;
    var cache = authTop.authCache || (authTop.authCache = Object.create(null));
    var au = new URL(fetchUrl);
    var hasAuth = Object.keys(wire).some(function (k) { return k.toLowerCase() === "authorization"; });
    if (au.username || au.password) {
      var cred = "Basic " + btoa(decodeURIComponent(au.username) + ":" + decodeURIComponent(au.password));
      au.username = ""; au.password = ""; fetchUrl = au.href;
      if (!hasAuth) { wire = Object.assign({}, wire); wire.Authorization = cred; }
      cache[au.origin] = cred;
    } else if (credentials && cache[au.origin] && !hasAuth) { wire = Object.assign({}, wire); wire.Authorization = cache[au.origin]; }
  } catch (eAuth) {}
  if (req.keepalive && !__jb.wptMode) meta = Object.assign({}, meta, { keepalive: true });
  var r = yield [fetchUrl, req.method, wire, bytes, isText, text, initiator, meta];
  if (r.error && __jb.csp && __jb.csp.reportBlockedRedirect(cspDest, req.url, r.error)) throw new TypeError("NetworkError when attempting to fetch resource: blocked by Content Security Policy");
  if (r.error) throw new TypeError("NetworkError when attempting to fetch resource: " + r.error);
  if (r.opaqueRedirect) return { type: "opaqueredirect", result: { status: 0, statusText: "", url: r.result.url, headers: {}, redirectLocation: r.result.redirectLocation, redirectStatus: r.result.redirectStatus }, body: null };
  var headers = r.result.headers || {};
  // response tainting follows redirects: a same-origin request that ended up on another origin
  if (sameOrigin && r.result.url && /^https?:/i.test(r.result.url) && __jb.originOf(r.result.url) !== __jb.originOf((typeof location !== "undefined" && location.href) || "about:blank")) {
    if (req.mode === "same-origin") throw new TypeError("NetworkError when attempting to fetch resource: a same-origin request was redirected to another origin");
    if (req.mode === "no-cors") return { type: "opaque", result: { status: 0, statusText: "", url: "", headers: {} }, body: null, opaqueBody: r.body, opaqueHeaders: headers };
    if (req.mode === "cors") { cors = true; if (credentials && req.credentials !== "include") credentials = false; }
  }
  if (!sameOrigin && req.mode === "no-cors") return { type: "opaque", result: { status: 0, statusText: "", url: "", headers: {} }, body: null, opaqueBody: r.body, opaqueHeaders: headers };
  if (cors) {
    // after redirects the CORS check uses the origin the last request carried (maybe "null")
    var checkOrigin = r.result.sentOrigin || pageOrigin;
    if (!__jb.corsCheck(headers, checkOrigin, credentials)) throw new TypeError("NetworkError when attempting to fetch resource: CORS request did not succeed");
    var exposeRaw = String(headers["access-control-expose-headers"] || "");
    var expose = exposeRaw.split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    var exposeAll = expose.indexOf("*") >= 0 && !credentials;
    var filtered = {};
    Object.keys(headers).forEach(function (k) { var lk = k.toLowerCase(); if (lk === "set-cookie" || lk === "set-cookie2") return; if (exposeAll || __jb.CORS_SAFELISTED_RESPONSE.test(lk) || expose.indexOf(lk) >= 0) filtered[k] = headers[k]; });
    headers = filtered;
  }
  return { type: cors ? "cors" : "basic", result: { status: r.result.status, statusText: r.result.statusText, url: r.result.url, headers: headers }, body: r.body, redirected: r.result.url !== req.url };
};
// Synchronous driver: every request is made on the spot (XHR sync, WPT pages, frames, workers).
__jb.corsFetchRaw = function (req, bytes, isText, text, initiator, wireHeaders) {
  var gen = __jb.corsFetchGen(req, bytes, isText, text, initiator, wireHeaders), step = gen.next();
  while (!step.done) step = gen.next(__jb.hostFetch.apply(null, step.value));
  return step.value;
};
// Asynchronous driver (real pages): requests run on host threads, the generator resumes when the
// event loop delivers each response. Resolves with what corsFetchRaw returns, rejects with what it throws.
__jb.corsFetchRawAsync = function (req, bytes, isText, text, initiator, wireHeaders) {
  return new Promise(function (resolve, reject) {
    var gen;
    try { gen = __jb.corsFetchGen(req, bytes, isText, text, initiator, wireHeaders); } catch (e) { reject(e); return; }
    var advance = function (value) {
      var step;
      try { step = gen.next(value); } catch (e) { reject(e); return; }
      if (step.done) { resolve(step.value); return; }
      var r = __jb.hostFetch.apply(null, step.value.concat([advance]));
      if (r !== null) advance(r);
    };
    advance(undefined);
  });
};
// Whether this realm sends requests asynchronously: real (non-WPT) top-level pages only.
__jb.asyncNet = function () {
  if (__jb.wptMode || __jb.noAsyncFetch) return false;
  // worker realms (no document; their event loop does not deliver host responses)
  if (typeof document === "undefined" || __jb.workerOwnerJb) return false;
  var tj = typeof __jb.topJb === "function" ? __jb.topJb() : __jb;
  return tj === __jb && !tj.wptMode && typeof __jb.registerAsyncFetch === "function";
};
__jb.rawToResponse = function (raw) {
  var resp = new Response(raw.body, { status: raw.result.status, statusText: raw.result.statusText, headers: raw.result.headers, url: raw.type === "opaque" ? "" : raw.result.url });
  resp.type = raw.type;
  if (raw.type === "opaque" || raw.type === "opaqueredirect") resp.headers._guard = "immutable";
  resp.redirected = !!raw.redirected;
  if (raw.type === "opaqueredirect" && raw.result.redirectLocation) Object.defineProperty(resp, "_redirect", { value: { location: raw.result.redirectLocation, status: raw.result.redirectStatus }, configurable: true });
  // an opaque response keeps its bytes for elements (scripts, images) but not for JS
  if (raw.type === "opaque" && raw.opaqueBody !== undefined) Object.defineProperty(resp, "_opaque", { value: { body: typeof raw.opaqueBody === "string" ? new TextEncoder().encode(raw.opaqueBody) : raw.opaqueBody, headers: raw.opaqueHeaders || {} }, configurable: true });
  return resp;
};
__jb.corsFetch = function (req, bytes, isText, text, initiator) {
  if (__jb.asyncNet()) return __jb.corsFetchRawAsync(req, bytes, isText, text, initiator).then(__jb.rawToResponse);
  return __jb.rawToResponse(__jb.corsFetchRaw(req, bytes, isText, text, initiator));
};
globalThis.fetch = function fetch(input, init) {
  var req;
  try { req = new Request(input, init); } catch (e) { return Promise.reject(new TypeError("Failed to construct Request: " + e.message)); }
  if (req.signal && req.signal.aborted) return Promise.reject(req.signal.reason || new DOMException("The operation was aborted.", "AbortError"));
  var send = function (bytes, isText, text) {
    var sww = __jb.sw ? __jb.sw.controllerForRequest(req.url) : null;
    // same-origin mode: a cross-origin URL fails before any service worker sees it
    if (sww && req.mode === "same-origin" && !/^data:/i.test(req.url)) { try { if (new URL(req.url).origin !== location.origin) return Promise.reject(new TypeError("NetworkError when attempting to fetch resource: cross-origin request in same-origin mode")); } catch (eSO) {} }
    if (sww) {
      var body = bytes && bytes.length && !/^(GET|HEAD)$/.test(req.method) ? (isText ? text : bytes) : null;
      var headers = {}; try { req.headers.forEach(function (v, k) { headers[k] = v; }); } catch (e) {}
      var swStart = typeof performance !== "undefined" ? performance.now() : 0;
      return __jb.sw.handleFetch(sww, { url: req.url, method: req.method, headers: headers, body: body, mode: req.mode, destination: req.destination || "", credentials: req.credentials, redirect: req.redirect, referrer: req.referrer, referrerPolicy: req.referrerPolicy, cache: req.cache, integrity: req.integrity, keepalive: req.keepalive }, globalThis, "").then(function (rec) {
        if (rec === false) throw new TypeError("NetworkError when attempting to fetch resource: the service worker responded with an error");
        if (rec) {
          var swResp = __jb.sw.toResponse(rec, req.url);
          // resource timing: the worker's response (opaque bodies report no sizes)
          try {
            if (typeof performance._addResource === "function") {
              var n = rec.type === "opaque" ? 0 : rec.body ? rec.body.length : 0;
              var ct = rec.type === "opaque" ? "" : (rec.headers && (rec.headers["content-type"] || rec.headers["Content-Type"])) || "";
              var ent = performance._addResource(req.url, "fetch", swStart, performance.now(), { transfer: 0, encoded: n, decoded: n }, rec.type === "opaque" ? 0 : rec.status, String(ct).split(";")[0].trim().toLowerCase());
              if (ent && ent._rt) ent._rt.workerStart = swStart;
            }
          } catch (eRT) {}
          return swResp;
        }
        return __jb.corsFetch(req, bytes, isText, text, "fetch");
      });
    }
    return __jb.corsFetch(req, bytes, isText, text, "fetch");
  };
  // A stream body is drained first; everything else is sent synchronously.
  if (req._body instanceof ReadableStream) return req._collect(true).then(function (bytes) { return send(bytes, false, null); });
  // The network round trip happens now. A page that keeps fetching without yielding (a polling
  // loop chained on fetch promises) gets its responses in tasks with 1 ms of virtual network
  // time, so timers, popups and frames of other realms still run; other fetches resolve as before.
  __jb.fetchBurst = (__jb.fetchBurst || 0) + 1;
  if (__jb.fetchBurst <= 16) {
    try { return Promise.resolve(send(req._bodyBytes(), req._bodyIsText(), req._bodyIsText() ? req._bodyText() : null)); } catch (e) { return Promise.reject(e); }
  }
  var result, failed = false;
  try { result = send(req._bodyBytes(), req._bodyIsText(), req._bodyIsText() ? req._bodyText() : null); } catch (e) { result = e; failed = true; }
  return new Promise(function (resolve, reject) { setTimeout(function () { __jb.fetchBurst = 17; if (failed) reject(result); else resolve(result); }, 1); });
}
globalThis.fetch = fetch;

class XMLHttpRequestEventTarget extends EventTarget { constructor() { super(); this.onloadstart = null; this.onprogress = null; this.onabort = null; this.onerror = null; this.onload = null; this.ontimeout = null; this.onloadend = null; } }
// Document Policy of this document (Document-Policy / Document-Policy-Report-Only headers):
// false when `feature` is disabled; a violation is reported either way
__jb.documentPolicyCheck = function (feature, message) {
  var doc = __jb.currentDocument, h = doc && doc._responseHeaders;
  if (!h || !__jb.parseDocPolicy) return true;
  var find = function (name) { var v = h[name] || h[name.replace(/(^|-)([a-z])/g, function (m, d, c) { return d + c.toUpperCase(); })]; var e = __jb.parseDocPolicy(v).filter(function (x) { return x[0] === feature; })[0]; return e ? e[1] : null; };
  var report = function (disposition) {
    var line = 0, col = 0;
    try { var st = String(new Error().stack || "").split("\n"); for (var i = 0; i < st.length; i++) { var m = /:(\d+):(\d+)\)?\s*$/.exec(st[i]); if (m && !/env\/|browser_env/.test(st[i])) { line = +m[1]; col = +m[2]; break; } } } catch (e) {}
    if (__jb.queueReport) __jb.queueReport("document-policy-violation", doc.URL, { featureId: feature, sourceFile: doc.URL, lineNumber: line, columnNumber: col, disposition: disposition, message: message });
  };
  var enforced = find("document-policy");
  if (enforced === "?0") { report("enforce"); return false; }
  if (find("document-policy-report-only") === "?0") report("report");
  return true;
};
class XMLHttpRequestUpload extends XMLHttpRequestEventTarget {}
// MIME type parsing/serialization (MIME Sniffing Standard, simplified).
__jb.HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
__jb.parseMime = function (input) {
  var str = String(input).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
  var m = /^([^\/]*)\/([^;]*)(;[\s\S]*)?$/.exec(str);
  if (!m) return null;
  var type = m[1], subtype = m[2].replace(/[\t\n\r ]+$/, "");
  if (!__jb.HTTP_TOKEN.test(type) || !__jb.HTTP_TOKEN.test(subtype)) return null;
  var params = {}, order = [];
  var rest = m[3] || "";
  var i = 0;
  while (i < rest.length) {
    i++; // ';'
    while (i < rest.length && /[\t\n\r ]/.test(rest.charAt(i))) i++;
    var name = "";
    while (i < rest.length && rest.charAt(i) !== ";" && rest.charAt(i) !== "=") name += rest.charAt(i++);
    name = name.toLowerCase();
    if (i < rest.length && rest.charAt(i) === ";") continue;
    if (i >= rest.length) break;
    i++; // '='
    var value = "";
    if (rest.charAt(i) === '"') {
      i++;
      while (i < rest.length) { var c = rest.charAt(i); if (c === '"') { i++; break; } if (c === "\\" && i + 1 < rest.length) { value += rest.charAt(i + 1); i += 2; continue; } value += c; i++; }
      while (i < rest.length && rest.charAt(i) !== ";") i++;
    } else {
      while (i < rest.length && rest.charAt(i) !== ";") value += rest.charAt(i++);
      value = value.replace(/[\t\n\r ]+$/, "");
      if (value === "") continue;
    }
    if (name !== "" && __jb.HTTP_TOKEN.test(name) && /^[\t -~\u0080-\u00ff]*$/.test(value) && params[name] === undefined) { params[name] = value; order.push(name); }
  }
  return { essence: type.toLowerCase() + "/" + subtype.toLowerCase(), params: params, order: order };
};
// File API: a Blob's type is the parsed and serialized MIME type, or "" when it does not parse.
// File API: a Blob's type is the given string lowercased, or "" when it has characters outside U+0020-U+007E.
__jb.blobType = function (t) { if (t === undefined || t === null || t === "") return ""; t = String(t); return /[^\x20-\x7e]/.test(t) ? "" : t.toLowerCase(); };
__jb.serializeMime = function (m) {
  var out = m.essence;
  (m.order || Object.keys(m.params)).forEach(function (k) {
    var v = m.params[k];
    if (v === "" || !__jb.HTTP_TOKEN.test(v)) v = '"' + v.replace(/(["\\])/g, "\\$1") + '"';
    out += ";" + k + "=" + v;
  });
  return out;
};
__jb.XHR_FORBIDDEN_HEADERS = /^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i;
class XMLHttpRequest extends XMLHttpRequestEventTarget {
  constructor() { super(); this.readyState = 0; this.status = 0; this.statusText = ""; this.responseText = ""; this.responseXML = null; this.responseURL = ""; this._responseType = ""; this.response = ""; this.timeout = 0; this.withCredentials = false; this.upload = new XMLHttpRequestUpload(); this.onreadystatechange = null; this._headers = {}; this._respHeaders = {}; this._aborted = false; this._sent = false; this._mime = null; this._async = true; }
  get responseType() { return this._responseType; }
  set responseType(v) {
    v = String(v);
    if (["", "arraybuffer", "blob", "document", "json", "text"].indexOf(v) < 0) return;
    if (this.readyState === 3 || this.readyState === 4) throw __jb.domError("InvalidStateError", "responseType cannot be set when the state is LOADING or DONE");
    if (!this._async && this.readyState !== 0) throw __jb.domError("InvalidAccessError", "responseType cannot be set on a synchronous request");
    this._responseType = v;
  }
  open(method, url, async, user, password) {
    if (arguments.length < 2) throw new TypeError("XMLHttpRequest.open: At least 2 arguments required");
    method = String(method);
    if (!__jb.HTTP_TOKEN.test(method)) throw __jb.domError("SyntaxError", "Invalid HTTP method");
    if (/^(connect|trace|track)$/i.test(method)) throw __jb.domError("SecurityError", "Forbidden HTTP method");
    if (/^(delete|get|head|options|post|put)$/i.test(method)) method = method.toUpperCase();
    var parsed;
    try { parsed = new URL(String(url), __jb.currentDocument.baseURI); } catch (e) { throw __jb.domError("SyntaxError", "Invalid URL"); }
    if (user !== undefined && user !== null) parsed.username = String(user);
    if (password !== undefined && password !== null) parsed.password = String(password);
    var isAsync = arguments.length < 3 || async !== false;
    if (!isAsync && (this.timeout !== 0 || this._responseType !== "")) throw __jb.domError("InvalidAccessError", "Synchronous requests cannot have a timeout or responseType");
    this._method = method; this._url = parsed.href; this._async = isAsync;
    this._headers = {}; this._sent = false; this._aborted = false; this.response = this._responseType === "" || this._responseType === "text" ? "" : null; this.responseText = ""; this.responseXML = null; this._respHeaders = {}; this.status = 0; this.statusText = ""; this.responseURL = "";
    if (this.readyState !== 1) { this.readyState = 1; this._changed(); }
  }
  setRequestHeader(name, value) {
    if (arguments.length < 2) throw new TypeError("XMLHttpRequest.setRequestHeader: At least 2 arguments required");
    if (this.readyState !== 1 || this._sent) throw __jb.domError("InvalidStateError", "XMLHttpRequest state must be OPENED");
    name = String(name); value = __jb.normalizeHeaderValue(value);
    if (/[^\u0000-ÿ]/.test(name) || /[^\u0000-ÿ]/.test(value)) throw new TypeError("setRequestHeader: header name and value must be ByteStrings");
    if (!__jb.HTTP_TOKEN.test(name) || /[\0\r\n]/.test(value)) throw __jb.domError("SyntaxError", "Invalid header name or value");
    if (__jb.XHR_FORBIDDEN_HEADERS.test(name)) return;
    var lower = name.toLowerCase();
    for (var k in this._headers) if (k.toLowerCase() === lower) { this._headers[k] = this._headers[k] + ", " + value; return; }
    this._headers[name] = value;
  }
  overrideMimeType(mime) {
    if (arguments.length < 1) throw new TypeError("XMLHttpRequest.overrideMimeType: At least 1 argument required");
    if (this.readyState === 3 || this.readyState === 4) throw __jb.domError("InvalidStateError", "Cannot override the MIME type once the response is loading");
    this._mime = __jb.parseMime(mime) || { essence: "application/octet-stream", params: {}, order: [] };
  }
  getResponseHeader(k) { if (this.readyState < 2) return null; var v = this._respHeaders[String(k).toLowerCase()]; return v === undefined ? null : v; }
  getAllResponseHeaders() { if (this.readyState < 2) return ""; var self_ = this; return Object.keys(this._respHeaders).sort().map(function (k) { return k.toLowerCase() + ": " + self_._respHeaders[k] + "\r\n"; }).join(""); }
  _changed() { this.dispatchEvent(new Event("readystatechange")); }
  send(body) {
    if (this.readyState !== 1 || this._sent) throw __jb.domError("InvalidStateError", "XMLHttpRequest state must be OPENED");
    // Document Policy "sync-xhr": a document whose policy disables it reports and fails synchronous requests
    if (!this._async && __jb.documentPolicyCheck && !__jb.documentPolicyCheck("sync-xhr", "Synchronous XMLHttpRequest is disabled by document policy.")) throw __jb.domError("NetworkError", "Synchronous XMLHttpRequest is disabled by document policy");
    var self_ = this;
    if (this._method === "GET" || this._method === "HEAD") body = null;
    var isDoc = body instanceof Document;
    var bodyInit = body === undefined || body === null ? null : isDoc ? __jb.serializeNode(body) : body;
    var req = new Request(this._url, { method: this._method, body: bodyInit });
    var headers = Object.assign({}, this._headers); // names keep the author's casing
    var authorCT = null;
    Object.keys(headers).forEach(function (k) { if (k.toLowerCase() === "content-type") authorCT = k; });
    var isUSP = typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams;
    var defaultCT = bodyInit === null ? null : typeof body === "string" ? "text/plain;charset=UTF-8" : isDoc ? (body._isHTML ? "text/html;charset=UTF-8" : "application/xml;charset=UTF-8") : isUSP ? "application/x-www-form-urlencoded;charset=UTF-8" : (typeof Blob !== "undefined" && body instanceof Blob) ? (body.type || null) : req.headers.get("content-type");
    if (authorCT === null) { if (defaultCT) headers["Content-Type"] = defaultCT; }
    else if (typeof body === "string" || isDoc || isUSP) {
      // The body is UTF-8: an author charset saying otherwise is corrected.
      headers[authorCT] = headers[authorCT].replace(/(charset=)("?)([^";]*)("?)/gi, function (m, p, q1, v, q2) { return v.toLowerCase() === "utf-8" ? m : p + q1 + "UTF-8" + q2; });
    }
    this._sent = true;
    var network = function () {
      var r;
      try { req.mode = "cors"; req.credentials = self_.withCredentials ? "include" : "same-origin"; req.redirect = "follow"; r = __jb.corsFetchRaw(req, req._bodyBytes(), req._bodyIsText(), req._bodyIsText() ? req._bodyText() : null, "xmlhttprequest", headers); if (r.body === null) r.body = new Uint8Array(0); } catch (e) { r = { error: e.message }; }
      return r;
    };
    var run = function () {
      if (self_._aborted) return;
      self_.dispatchEvent(new ProgressEvent("loadstart"));
      // a controlled document's XHR goes to its service worker first
      var sww = __jb.sw && /^https?:/.test(req.url) ? __jb.sw.controllerForRequest(req.url) : null;
      if (sww) {
        var swHeaders = {}, hasAccept = false;
        Object.keys(headers).forEach(function (k) { swHeaders[k] = headers[k]; if (k.toLowerCase() === "accept") hasAccept = true; });
        if (!hasAccept) swHeaders.Accept = "*/*";
        var swBody = bodyInit === null ? null : req._bodyIsText() ? req._bodyText() : req._bodyBytes();
        var swReq = { url: req.url, method: req.method, headers: swHeaders, body: swBody, mode: "cors", destination: "", credentials: self_.withCredentials ? "include" : "same-origin", redirect: "follow" };
        var fromRec = function (rec) {
          if (rec === false) return { error: "the service worker responded with an error" };
          var h = {}; Object.keys(rec.headers || {}).forEach(function (k) { h[k.toLowerCase()] = rec.headers[k]; });
          return { result: { status: rec.status, statusText: rec.statusText || "", url: rec.url || req.url.split("#")[0], headers: h }, body: new Uint8Array(rec.body || []) };
        };
        if (self_._async) {
          __jb.sw.handleFetch(sww, swReq, globalThis, "").then(function (rec) {
            if (self_._aborted) return;
            finish(rec === null || rec === undefined ? network() : fromRec(rec));
          }, function () { finish({ error: "service worker fetch failed" }); });
          return;
        }
        var srec = __jb.sw.handleFetchSync(sww, swReq, globalThis, "");
        finish(srec === null || srec === undefined ? network() : fromRec(srec));
        return;
      }
      if (self_._async && __jb.asyncNet()) {
        req.mode = "cors"; req.credentials = self_.withCredentials ? "include" : "same-origin"; req.redirect = "follow";
        __jb.corsFetchRawAsync(req, req._bodyBytes(), req._bodyIsText(), req._bodyIsText() ? req._bodyText() : null, "xmlhttprequest", headers)
          .then(finish, function (e) { finish({ error: String(e && e.message || e) }); });
        return;
      }
      finish(network());
    };
    var finish = function (r) {
      if (self_._aborted) return;
      if (r.error) { self_.readyState = 4; self_.status = 0; self_._changed(); self_.dispatchEvent(new ProgressEvent("error")); self_.dispatchEvent(new ProgressEvent("loadend")); return; }
      var result = r.result, bytes = typeof r.body === "string" ? null : r.body, text = typeof r.body === "string" ? r.body : __utf8Decode(r.body);
      self_.status = result.status; self_.statusText = result.statusText; self_.responseURL = result.url; self_._respHeaders = result.headers || {};
      self_.readyState = 2; self_._changed(); self_.readyState = 3; self_._changed();
      var respCT = self_._respHeaders["content-type"];
      var respMime = respCT !== undefined ? __jb.parseMime(respCT) : null;
      var finalMime = self_._mime || respMime || { essence: "text/xml", params: {}, order: [] };
      var ct = __jb.serializeMime(finalMime);
      var isHTML = finalMime.essence === "text/html", isXML = /\+xml$|^(text|application)\/xml$/.test(finalMime.essence);
      var parseDoc = function () { try { return isHTML ? new DOMParser().parseFromString(text, "text/html") : isXML ? new DOMParser().parseFromString(text, "text/xml") : null; } catch (e) { return null; } };
      switch (self_._responseType) {
        case "json": try { self_.response = JSON.parse(text); } catch (e) { self_.response = null; } break;
        case "arraybuffer": self_.response = (bytes || __utf8Encode(text)).slice().buffer; break;
        case "blob": self_.response = new Blob([bytes || text], { type: ct }); break;
        case "document": self_.response = parseDoc(); self_.responseXML = self_.response; break;
        default: self_.response = text; self_.responseText = text; if (isXML) self_.responseXML = parseDoc();
      }
      self_.readyState = 4; self_._changed();
      var len = bytes ? bytes.length : text.length;
      self_.dispatchEvent(new ProgressEvent("progress", { lengthComputable: true, loaded: len, total: len }));
      self_.dispatchEvent(new ProgressEvent("load"));
      self_.dispatchEvent(new ProgressEvent("loadend"));
    };
    if (this._async) setTimeout(run, 0); else run();
  }
  abort() { this._aborted = true; var wasActive = this.readyState >= 1 && this.readyState <= 3 && this._sent; this.readyState = 0; this.status = 0; if (wasActive) { this.dispatchEvent(new ProgressEvent("abort")); this.dispatchEvent(new ProgressEvent("loadend")); } }
}
XMLHttpRequest.UNSENT = 0; XMLHttpRequest.OPENED = 1; XMLHttpRequest.HEADERS_RECEIVED = 2; XMLHttpRequest.LOADING = 3; XMLHttpRequest.DONE = 4;

// ---- WebSocket (real connection through the host; events are pumped by Rust) ----
__jb.sockets = {};
__jb.socketSeq = 0;
// Connection ids are unique across realms: the host (shared by frames and popups) keys its
// WebSocket/EventSource connections by them.
// Worker realms have their own __jb (topJb() is the worker itself): register in the owning page's top
// realm, where the host's __jb.deliverNetwork looks.
__jb.connectionsJb = function () {
  var j = __jb;
  try { for (var i = 0; i < 8 && j.workerOwnerJb && j.workerOwnerJb !== j; i++) j = j.workerOwnerJb; } catch (e) {}
  try { return typeof j.topJb === "function" ? j.topJb() : j; } catch (e) { return j; }
};
__jb.nextConnectionId = function () { var t = __jb.connectionsJb(); t.socketSeq = (t.socketSeq || 0) + 1; return t.socketSeq; };
class WebSocket extends EventTarget {
  constructor(url, protocols) {
    super();
    // WebSockets Standard "establish a WebSocket connection" URL rules.
    var parsed;
    try { parsed = new URL(String(url), location.href); } catch (e) { throw new DOMException("The URL '" + url + "' is invalid.", "SyntaxError"); }
    if (parsed.protocol === "http:") parsed.protocol = "ws:";
    else if (parsed.protocol === "https:") parsed.protocol = "wss:";
    if (!/^wss?:$/.test(parsed.protocol)) throw new DOMException("The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '" + parsed.protocol.slice(0, -1) + "' is not allowed.", "SyntaxError");
    if (parsed.hash !== "" || /#/.test(parsed.href)) throw new DOMException("The URL contains a fragment identifier ('" + parsed.hash + "'). Fragment identifiers are not allowed in WebSocket URLs.", "SyntaxError");
    this.url = parsed.href;
    this.protocol = ""; this.readyState = 0; this.bufferedAmount = 0; this.extensions = ""; this.binaryType = "blob";
    this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
    var protos = protocols === undefined ? [] : (typeof protocols === "object" && protocols !== null && typeof protocols[Symbol.iterator] === "function" && typeof protocols !== "string") ? __jb.arrayFrom(protocols, String) : [String(protocols)];
    // Subprotocols are RFC 6455 tokens, unique case-insensitively.
    var seen = {};
    protos.forEach(function (p) {
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(p)) throw new DOMException("The subprotocol '" + p + "' is invalid.", "SyntaxError");
      var k = p.toLowerCase();
      if (seen[k]) throw new DOMException("The subprotocol '" + p + "' is duplicated.", "SyntaxError");
      seen[k] = true;
    });
    this._id = __jb.nextConnectionId();
    __jb.sockets[this._id] = this;
    try { var topJb = __jb.connectionsJb(); (topJb.allSockets || (topJb.allSockets = {}))[this._id] = this; } catch (e) {}
    var self_ = this;
    var cspOk = (!__jb.mixed || !__jb.mixed.blocks("", this.url)) && (!__jb.csp || __jb.csp.allowsRequest("", this.url));
    setTimeout(function () {
      var r = cspOk ? __jb.native("websocket", { op: "open", id: self_._id, url: self_.url, protocols: protos }) : { ok: false, error: "blocked by Content Security Policy" };
      if (r && r.ok) { self_.readyState = 1; self_.protocol = r.protocol || ""; self_.dispatchEvent(new Event("open")); }
      else { self_.readyState = 3; delete __jb.sockets[self_._id]; console.error("WebSocket connection to '" + self_.url + "' failed: " + (r && r.error || "unknown error")); self_.dispatchEvent(new Event("error")); self_.dispatchEvent(new CloseEvent("close", { code: 1006, reason: (r && r.error) || "", wasClean: false })); }
    }, 0);
  }
  send(data) {
    if (this.readyState === 0) throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
    if (this.readyState !== 1) return;
    var binary = !(typeof data === "string");
    var r = __jb.native("websocket", { op: "send", id: this._id, data: binary ? __jb.bytesToB64(data instanceof Blob ? data._bytes() : data) : String(data), binary: binary });
    if (!r || !r.ok) { this.dispatchEvent(new Event("error")); }
  }
  close(code, reason) {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    __jb.native("websocket", { op: "close", id: this._id, code: code === undefined ? 1000 : code, reason: reason || "" });
    var self_ = this;
    setTimeout(function () { self_.readyState = 3; delete __jb.sockets[self_._id]; self_.dispatchEvent(new CloseEvent("close", { code: code === undefined ? 1000 : code, reason: reason || "", wasClean: true })); }, 0);
  }
  _deliver(type, data) {
    if (type === "message") {
      var payload = data.binary !== undefined ? (this.binaryType === "arraybuffer" ? __jb.b64ToBytes(data.binary).buffer : new Blob([__jb.b64ToBytes(data.binary)])) : data.text;
      this.dispatchEvent(new MessageEvent("message", { data: payload, origin: new URL(this.url).origin }));
    } else if (type === "close") { this.readyState = 3; delete __jb.sockets[this._id]; this.dispatchEvent(new CloseEvent("close", data)); }
    else if (type === "error") { this.dispatchEvent(new Event("error")); }
  }
}
WebSocket.CONNECTING = 0; WebSocket.OPEN = 1; WebSocket.CLOSING = 2; WebSocket.CLOSED = 3;
WebSocket.prototype.CONNECTING = 0; WebSocket.prototype.OPEN = 1; WebSocket.prototype.CLOSING = 2; WebSocket.prototype.CLOSED = 3;

// ---- EventSource (server-sent events) ----
__jb.eventSources = {};
class EventSource extends EventTarget {
  constructor(url, init) {
    super();
    this.url = new URL(String(url), location.href).href;
    this.withCredentials = !!(init && init.withCredentials);
    this.readyState = 0; this.onopen = null; this.onmessage = null; this.onerror = null;
    this._id = __jb.nextConnectionId();
    __jb.eventSources[this._id] = this;
    try { var topJbE = __jb.connectionsJb(); (topJbE.allEventSources || (topJbE.allEventSources = {}))[this._id] = this; } catch (e) {}
    var self_ = this;
    var cspOk = (!__jb.mixed || !__jb.mixed.blocks("", this.url)) && (!__jb.csp || __jb.csp.allowsRequest("", this.url));
    setTimeout(function () { var r = cspOk ? __jb.native("eventsource", { op: "open", id: self_._id, url: self_.url }) : null; if (!r || !r.ok) { self_.readyState = 2; delete __jb.eventSources[self_._id]; self_.dispatchEvent(new Event("error")); } }, 0);
  }
  close() { this.readyState = 2; __jb.native("eventsource", { op: "close", id: this._id }); delete __jb.eventSources[this._id]; }
  _deliver(type, data) {
    if (type === "open") { this.readyState = 1; this.dispatchEvent(new Event("open")); }
    else if (type === "message") { var ev = new MessageEvent(data.event || "message", { data: data.data, origin: new URL(this.url).origin }); ev.lastEventId = data.lastEventId || ""; this.dispatchEvent(ev); }
    else if (type === "error") { this.readyState = 2; delete __jb.eventSources[this._id]; this.dispatchEvent(new Event("error")); }
  }
}
EventSource.CONNECTING = 0; EventSource.OPEN = 1; EventSource.CLOSED = 2;
// Called by Rust with the events polled from open connections.
__jb.deliverNetwork = function (events) {
  events = typeof events === "string" ? JSON.parse(events) : events;
  events.forEach(function (e) {
    var target = e.target === "ws" ? __jb.sockets[e.id] : __jb.eventSources[e.id];
    // Connections of other realms (frames, popups) share the host: find them in the top realm's registry.
    if (!target) { var top = __jb.connectionsJb(); var reg = e.target === "ws" ? top.allSockets : top.allEventSources; target = reg && reg[e.id]; }
    if (target) { try { target._deliver(e.type, e.data); } catch (err) { __jb.reportException(err); } }
  });
};
__jb.hasOpenConnections = function () { return Object.keys(__jb.sockets).length > 0 || Object.keys(__jb.eventSources).length > 0; };


// ---- Canvas 2D (records drawn text so it can be surfaced in rendering) ----
__jb.canvasText = [];
__jb.canvasContext = function (canvas, type) {
  if (type !== "2d") return null; // WebGL is not available
  var noop = function () {};
  var ctx = { canvas: canvas, fillStyle: "#000000", strokeStyle: "#000000", lineWidth: 1, lineCap: "butt", lineJoin: "miter", miterLimit: 10, font: "10px sans-serif", textAlign: "start", textBaseline: "alphabetic", direction: "ltr", globalAlpha: 1, globalCompositeOperation: "source-over", shadowBlur: 0, shadowColor: "rgba(0, 0, 0, 0)", shadowOffsetX: 0, shadowOffsetY: 0, imageSmoothingEnabled: true, imageSmoothingQuality: "low", filter: "none", letterSpacing: "0px", wordSpacing: "0px", fontKerning: "auto",
    measureText: function (t) { var w = Math.round(String(t).length * (parseFloat(this.font) || 10) * 0.55); return { width: w, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: w, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }; },
    fillText: function (t, x, y) { var s = String(t); if (s.trim()) { __jb.canvasText.push(s); if (canvas && canvas.setAttribute && !canvas.getAttribute("aria-label")) canvas._setAttrRaw("data-canvas-text", (canvas.getAttribute("data-canvas-text") ? canvas.getAttribute("data-canvas-text") + " " : "") + s); if (canvas && canvas.__jbid !== undefined) __jb.markDirty(canvas); } },
    getImageData: function (x, y, w, h) { return new ImageData(Math.max(1, w | 0), Math.max(1, h | 0)); }, createImageData: function (w, h) { return new ImageData(w instanceof ImageData ? w.width : w, w instanceof ImageData ? w.height : h); },
    createLinearGradient: function () { return { addColorStop: noop }; }, createRadialGradient: function () { return { addColorStop: noop }; }, createConicGradient: function () { return { addColorStop: noop }; }, createPattern: function () { return {}; },
    getTransform: function () { return new DOMMatrix(); }, isPointInPath: function () { return false; }, isPointInStroke: function () { return false; }, getLineDash: function () { return []; }, getContextAttributes: function () { return { alpha: true, desynchronized: false, colorSpace: "srgb", willReadFrequently: false }; } };
  ctx.strokeText = ctx.fillText;
  ["save", "restore", "scale", "rotate", "translate", "transform", "setTransform", "resetTransform", "clearRect", "fillRect", "strokeRect", "beginPath", "closePath", "moveTo", "lineTo", "bezierCurveTo", "quadraticCurveTo", "arc", "arcTo", "ellipse", "rect", "roundRect", "fill", "stroke", "clip", "drawImage", "putImageData", "setLineDash", "drawFocusIfNeeded", "reset"].forEach(function (m) { ctx[m] = noop; });
  return ctx;
};

// ---- cookies (backed by the real cookie jar) ----
Object.defineProperty(Document.prototype, "cookie", {
  get: function () { var v = __jb.native("cookie", { op: "get", url: this.URL || location.href, site: __jb.cookieSite() }); return typeof v === "string" ? v : ""; },
  set: function (v) { v = String(v); __jb.cookiesSet.push(v); __jb.native("cookie", { op: "set", url: this.URL || location.href, cookie: v, site: __jb.cookieSite() }); },
  configurable: true,
});

// ---- navigator: clipboard & geolocation backed by the host ----
__jb.geoWatchSeq = 0;
navigator.geolocation = {
  getCurrentPosition: function (ok, err) {
    var pos = __jb.native("geolocation");
    setTimeout(function () {
      if (pos && typeof pos.latitude === "number") { if (ok) ok({ coords: { latitude: pos.latitude, longitude: pos.longitude, accuracy: pos.accuracy || 50, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() }); }
      else if (err) err({ code: 1, message: "User denied Geolocation", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
    }, 0);
  },
  watchPosition: function (ok, err) { this.getCurrentPosition(ok, err); return ++__jb.geoWatchSeq; },
  clearWatch: function () {},
};

Object.assign(globalThis, { Headers, Blob, File, FileList, FileReader, FormData, ReadableStream, ReadableStreamDefaultReader, WritableStream, WritableStreamDefaultWriter, TransformStream, TextDecoderStream, TextEncoderStream, CompressionStream, DecompressionStream, Request, Response, XMLHttpRequest, XMLHttpRequestEventTarget, XMLHttpRequestUpload, Storage, WebSocket, EventSource, MessagePort, MessageChannel, BroadcastChannel, DOMMatrix, DOMMatrixReadOnly, DOMPoint, DOMPointReadOnly, DOMRect, DOMRectReadOnly, DOMQuad, WebKitCSSMatrix: DOMMatrix, Touch, TouchList, AudioContext: Audio_Context, webkitAudioContext: Audio_Context, SpeechSynthesisUtterance, speechSynthesis, ResizeObserverEntry: ResizeObserverEntryLegacy, IntersectionObserverEntry: IntersectionObserverEntryLegacy, VisualViewport, visualViewport, caches, reportError, alert, confirm, prompt, print, open, close, focus, blur, stop, scroll, scrollTo, scrollBy, moveTo, moveBy, resizeTo, resizeBy, getSelection, postMessage, captureEvents, releaseEvents, setTimeout, setInterval, clearTimeout, clearInterval, queueMicrotask, requestAnimationFrame, cancelAnimationFrame, requestIdleCallback, cancelIdleCallback, btoa, atob, structuredClone, matchMedia, getComputedStyle });
