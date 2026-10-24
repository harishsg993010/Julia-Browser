// ---------------------------------------------------------------- dedicated workers
// A Worker runs in its own realm (created like a frame realm, with this environment loaded) whose
// global is turned into a DedicatedWorkerGlobalScope. Messages cross as structured clones delivered
// in tasks; the worker realm's timers run from this realm's timer loop (it is a child realm).
(function () {
  var trusted = function (ev) { __jb.setTrusted(ev, true); ev._trustedDispatch = true; return ev; };
  var transferOpts = function (t) { if (t === null) throw new TypeError("postMessage: the transfer argument is not a sequence"); return t === undefined ? undefined : Array.isArray(t) || (t && typeof t[Symbol.iterator] === "function") ? { transfer: __jb.arrayFrom(t) } : t; };

  // ---- worker side (runs inside the worker realm) ----
  __jb.becomeWorker = function (scriptUrl, name, ownerPost, ownerError) {
    var g = globalThis, base = Object.getPrototypeOf(g);
    function WorkerGlobalScope() { throw new TypeError("Illegal constructor"); }
    function DedicatedWorkerGlobalScope() { throw new TypeError("Illegal constructor"); }
    WorkerGlobalScope.prototype = Object.create(base, { constructor: { value: WorkerGlobalScope, writable: true, configurable: true } });
    DedicatedWorkerGlobalScope.prototype = Object.create(WorkerGlobalScope.prototype, { constructor: { value: DedicatedWorkerGlobalScope, writable: true, configurable: true } });
    Object.setPrototypeOf(DedicatedWorkerGlobalScope, WorkerGlobalScope);
    Object.defineProperty(WorkerGlobalScope.prototype, Symbol.toStringTag, { value: "WorkerGlobalScope", configurable: true });
    Object.defineProperty(DedicatedWorkerGlobalScope.prototype, Symbol.toStringTag, { value: "DedicatedWorkerGlobalScope", configurable: true });
    try { Object.setPrototypeOf(g, DedicatedWorkerGlobalScope.prototype); } catch (e) {}
    var def = function (k, v) { Object.defineProperty(g, k, { value: v, writable: true, configurable: true, enumerable: false }); };
    def("WorkerGlobalScope", WorkerGlobalScope);
    def("DedicatedWorkerGlobalScope", DedicatedWorkerGlobalScope);
    def("name", String(name || ""));
    __jb.isWorker = true;
    // worker globals have no document (the env keeps using __jb.currentDocument internally)
    try { delete g.document; } catch (eD) {}
    __jb.workerOwnerPost = ownerPost;
    def("postMessage", function postMessage(message, transfer) {
      if (arguments.length < 1) throw new TypeError("postMessage: 1 argument required");
      // deserialized in the owner's realm
      var ownerJb = __jb.workerOwnerJb || __jb;
      var o = Object.assign({}, transferOpts(transfer)); o.outPorts = [];
      var data = __jb.cloneInto(ownerJb, message, o);
      ownerPost(data, o.outPorts);
    });
    def("importScripts", function importScripts() {
      for (var i = 0; i < arguments.length; i++) {
        var u, arg = arguments[i];
        if (typeof __jb.ttImportScriptsUrl === "function") arg = __jb.ttImportScriptsUrl(arg);
        try { u = new URL(String(arg), location.href).href; } catch (e) { throw __jb.domError("SyntaxError", "importScripts: invalid URL " + arguments[i]); }
        if (__jb.csp && !__jb.csp.allowsRequest("script", u, {})) throw __jb.domError("NetworkError", "importScripts: " + u + " blocked by Content Security Policy");
        var src = __jb.fetchSource(u, null, "script");
        if (!src || src.failed) throw __jb.domError("NetworkError", "importScripts: failed to load " + u);
        var res = JSON.parse(__jb_native("evalScript", __jb.hostJson({ code: src.html, filename: u, base: u })) || "{}");
        if (res && res.error) {
          // rethrow the script's exception to the caller
          if (globalThis.__jb_hasLastError) { var e2 = globalThis.__jb_lastError; globalThis.__jb_hasLastError = false; globalThis.__jb_lastError = undefined; throw e2; }
          throw new Error(res.error);
        }
      }
    });
    def("close", function close() { __jb.workerClosed = true; __jb.timers = []; });
    // Uncaught errors not handled by the worker's own onerror go to the Worker object.
    var report = __jb.reportError;
    __jb.reportError = function (message, filename, muted) {
      var e = globalThis.__jb_hasLastError ? globalThis.__jb_lastError : null;
      var ev = trusted(new ErrorEvent("error", { message: String(message), filename: filename || location.href, lineno: e && e.lineNumber || 1, colno: e && e.columnNumber || 1, error: e, cancelable: true }));
      globalThis.__jb_hasLastError = false; globalThis.__jb_lastError = undefined;
      try { globalThis.dispatchEvent(ev); } catch (x) {}
      if (!ev.defaultPrevented) ownerError(String(message), ev.filename, ev.lineno, ev.colno);
    };
    void report;
  };
  __jb.workerDeliver = function (data, ports) {
    if (__jb.workerClosed) return;
    globalThis.dispatchEvent(trusted(new MessageEvent("message", { data: data, ports: ports || [] })));
  };
  // Fetch and run the worker's main script; returns { ok } or { error, fetch }.
  __jb.runWorkerScript = function (url, type) {
    // the owner fetches the script (its referrer); the response's headers give the worker's policies
    var owner = __jb.workerOwnerJb || __jb;
    owner.workerFetchClient = globalThis; owner.workerFetchController = undefined;
    var src;
    try { src = owner.fetchSource(url, null, __jb.isSharedWorker ? "sharedworker" : "worker"); } finally { owner.workerFetchClient = null; }
    if (!src || src.failed) return { error: "Failed to load worker script " + url, fetch: true };
    __jb.workerScriptUrl = src.url || url;
    // the worker's URL is its script's response URL (after redirects)
    if (src.url && src.url !== url && /^https?:/i.test(src.url)) { try { location._url = new URL(src.url); __jb.currentDocument.URL = __jb.currentDocument.documentURI = src.url; } catch (eL) {} }
    // its controller: the service worker that handled its script (blob/data workers inherit the owner's)
    if (__jb.sw) {
      if (/^(blob|data):/i.test(url)) __jb.swController = owner.swController || null;
      else if (owner.workerFetchController !== undefined) __jb.swController = owner.workerFetchController;
    }
    owner.workerFetchController = undefined;
    try { __jb.currentDocument._responseHeaders = src.headers || {}; __jb.currentDocument._cspState = undefined; } catch (eh) {}
    // workers from local schemes inherit the owner's policies; others take the response's
    if (/^(blob|data):/i.test(url)) { try { __jb.inheritedReferrerPolicy = owner.documentReferrerPolicy(); __jb.inheritedCsp = owner.cspPolicies().slice(); } catch (ei) {} }
    else __jb.inheritedCsp = null;
    __jb.cspModuleOptions = { nonce: "", parser: "" };
    var res;
    try {
      // the module graph is fetched with the owner document as the client (its CSP applies)
      if (type === "module") { __jb.workerGraphLoading = true; try { res = JSON.parse(__jb_native("evalModule", __jb.hostJson({ code: src.html, filename: __jb.workerScriptUrl || url, base: __jb.workerScriptUrl || url })) || "{}"); } finally { __jb.workerGraphLoading = false; } }
      else res = JSON.parse(__jb_native("evalScript", __jb.hostJson({ code: src.html, filename: url, base: url })) || "{}");
    } catch (e) { res = { error: String(e) }; }
    if (res && res.error && !res.fetch) { __jb.reportError(res.error, url); return { ok: true }; }
    if (res && res.error) return { error: res.error, fetch: true };
    return { ok: true };
  };

  // ---- owner side ----
  class Worker extends EventTarget {
    constructor(scriptURL, options) {
      if (arguments.length < 1) throw new TypeError("Failed to construct 'Worker': 1 argument required.");
      super();
      var href;
      try { href = new URL(String(scriptURL), __jb.currentDocument.baseURI).href; } catch (e) { throw __jb.domError("SyntaxError", "Failed to construct 'Worker': The URL '" + scriptURL + "' is invalid."); }
      var opts = options || {}, type = opts.type === "module" ? "module" : "classic", self_ = this;
      Object.defineProperty(this, "_terminated", { value: false, writable: true });
      // the worker script is fetched in same-origin mode: other origins fail like a network error
      var sameOriginScript = /^(data|blob):/i.test(href) || (function () { try { return new URL(href).origin === location.origin; } catch (eo) { return false; } })();
      if (!sameOriginScript) { setTimeout(function () { self_.dispatchEvent(trusted(new Event("error", { cancelable: true }))); }, 0); Object.defineProperty(this, "_g", { value: null, writable: true }); return; }
      // Content Security Policy (worker-src): a blocked worker fails like a network error
      if (__jb.csp && !__jb.csp.allowsRequest("worker", href, {})) { setTimeout(function () { self_.dispatchEvent(trusted(new Event("error"))); }, 0); Object.defineProperty(this, "_g", { value: null, writable: true }); return; }
      var g = typeof __jb.createFrameRealm === "function" ? __jb.createFrameRealm(null, __jb.MAX_AUX_REALMS, true) : null;
      Object.defineProperty(this, "_g", { value: g, writable: true });
      if (!g) { setTimeout(function () { self_.dispatchEvent(trusted(new Event("error"))); }, 0); return; }
      try { g.__jb.frameContext = null; g.__jb.workerOwnerJb = __jb; } catch (e) {}
      g.__jb.loadDom('{"c":[]}', href);
      g.__jb.becomeWorker(href, opts.name, function (data, ports) {
        setTimeout(function () { if (!self_._terminated) self_.dispatchEvent(trusted(new MessageEvent("message", { data: data, ports: ports || [] }))); }, 0);
      }, function (message, filename, lineno, colno) {
        setTimeout(function () { if (!self_._terminated) { var ev = trusted(new ErrorEvent("error", { message: message, filename: filename, lineno: lineno, colno: colno, cancelable: true })); self_.dispatchEvent(ev); if (!ev.defaultPrevented) console.error("Uncaught (in worker) " + message); } }, 0);
      });
      // the worker starts in a task of its own
      setTimeout(function () {
        if (self_._terminated) return;
        var r = g.__jb.runWorkerScript(href, type);
        if (r && r.error) self_.dispatchEvent(trusted(new Event("error")));
      }, 0);
    }
    postMessage(message, transfer) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'postMessage' on 'Worker': 1 argument required.");
      var g = this._g, self_ = this;
      // deserialized in the worker's realm
      var o = Object.assign({}, transferOpts(transfer)); o.outPorts = [];
      var data = __jb.cloneInto(g && g.__jb ? g.__jb : __jb, message, o);
      if (!g || this._terminated) return;
      setTimeout(function () { if (!self_._terminated) g.__jb.workerDeliver(data, o.outPorts); }, 0);
    }
    terminate() {
      if (this._terminated) return;
      this._terminated = true;
      var g = this._g;
      if (g) { try { g.__jb.workerClosed = true; g.__jb.timers = []; } catch (e) {} try { __jb.dropRealm(g); } catch (e2) {} }
    }
  }
  __jb.setTag(Worker, "Worker");
  __jb.defineEventHandlerProps(Worker.prototype, ["message", "messageerror", "error"]);
  Object.defineProperty(globalThis, "Worker", { value: Worker, writable: true, configurable: true, enumerable: false });

  // ---- shared workers ----
  // One SharedWorkerGlobalScope per (origin, script URL, name) for this page's browsing contexts;
  // every SharedWorker object gets a port entangled with one delivered by a `connect` event.
  __jb.becomeSharedWorker = function (scriptUrl, name) {
    var g = globalThis, base = Object.getPrototypeOf(g);
    function WorkerGlobalScope() { throw new TypeError("Illegal constructor"); }
    function SharedWorkerGlobalScope() { throw new TypeError("Illegal constructor"); }
    WorkerGlobalScope.prototype = Object.create(base, { constructor: { value: WorkerGlobalScope, writable: true, configurable: true } });
    SharedWorkerGlobalScope.prototype = Object.create(WorkerGlobalScope.prototype, { constructor: { value: SharedWorkerGlobalScope, writable: true, configurable: true } });
    Object.setPrototypeOf(SharedWorkerGlobalScope, WorkerGlobalScope);
    Object.defineProperty(WorkerGlobalScope.prototype, Symbol.toStringTag, { value: "WorkerGlobalScope", configurable: true });
    Object.defineProperty(SharedWorkerGlobalScope.prototype, Symbol.toStringTag, { value: "SharedWorkerGlobalScope", configurable: true });
    try { Object.setPrototypeOf(g, SharedWorkerGlobalScope.prototype); } catch (e) {}
    var def = function (k, v) { Object.defineProperty(g, k, { value: v, writable: true, configurable: true, enumerable: false }); };
    def("WorkerGlobalScope", WorkerGlobalScope);
    def("SharedWorkerGlobalScope", SharedWorkerGlobalScope);
    def("name", String(name || ""));
    __jb.isWorker = true; try { delete g.document; } catch (eD) {}
    __jb.isSharedWorker = true;
    __jb.defineEventHandlerProps(SharedWorkerGlobalScope.prototype, ["connect"]);
    def("importScripts", function importScripts() {
      for (var i = 0; i < arguments.length; i++) {
        var u, arg = arguments[i];
        if (typeof __jb.ttImportScriptsUrl === "function") arg = __jb.ttImportScriptsUrl(arg);
        try { u = new URL(String(arg), location.href).href; } catch (e) { throw __jb.domError("SyntaxError", "importScripts: invalid URL " + arg); }
        if (__jb.csp && !__jb.csp.allowsRequest("script", u, {})) throw __jb.domError("NetworkError", "importScripts: " + u + " blocked by Content Security Policy");
        var src = __jb.fetchSource(u, null, "script");
        if (!src || src.failed) throw __jb.domError("NetworkError", "importScripts: failed to load " + u);
        var res = JSON.parse(__jb_native("evalScript", __jb.hostJson({ code: src.html, filename: u, base: u })) || "{}");
        if (res && res.error) {
          if (globalThis.__jb_hasLastError) { var e2 = globalThis.__jb_lastError; globalThis.__jb_hasLastError = false; globalThis.__jb_lastError = undefined; throw e2; }
          throw new Error(res.error);
        }
      }
    });
    def("close", function close() { __jb.workerClosed = true; __jb.timers = []; if (__jb.sharedEntry) __jb.sharedEntry.closed = true; });
  };
  class SharedWorker extends EventTarget {
    constructor(scriptURL, options) {
      if (arguments.length < 1) throw new TypeError("Failed to construct 'SharedWorker': 1 argument required.");
      super();
      var opts = typeof options === "string" ? { name: options } : (options === undefined || options === null ? {} : options);
      var name = opts.name === undefined ? "" : String(opts.name), type = opts.type === "module" ? "module" : "classic";
      var href;
      try { href = new URL(String(scriptURL), __jb.currentDocument.baseURI).href; } catch (e) { throw __jb.domError("SyntaxError", "Failed to construct 'SharedWorker': The URL '" + scriptURL + "' is invalid."); }
      var outside = __jb.newPort();
      Object.defineProperty(this, "_portObj", { value: outside });
      var self_ = this;
      var fail = function () { setTimeout(function () { self_.dispatchEvent(trusted(new Event("error"))); }, 0); };
      var sameOrigin = /^(data|blob):/i.test(href) || (function () { try { return new URL(href).origin === location.origin; } catch (eo) { return false; } })();
      if (!sameOrigin) { fail(); return; }
      if (__jb.mixed && __jb.mixed.blocks("sharedworker", href)) { fail(); return; }
      if (__jb.csp && !__jb.csp.allowsRequest("sharedworker", href, {})) { fail(); return; }
      var tj = __jb.topJb();
      var reg = tj.sharedWorkerRegistry || (tj.sharedWorkerRegistry = []);
      var origin = location.origin;
      var entry = null;
      for (var i = 0; i < reg.length; i++) { var e = reg[i]; if (!e.closed && e.url === href && e.name === name && e.origin === origin) { entry = e; break; } }
      if (entry && entry.type !== type) { fail(); return; }
      if (!entry) {
        var g = typeof __jb.createFrameRealm === "function" ? __jb.createFrameRealm(null, __jb.MAX_AUX_REALMS, true) : null;
        if (!g) { fail(); return; }
        try { g.__jb.frameContext = null; g.__jb.workerOwnerJb = __jb; } catch (e1) {}
        g.__jb.loadDom('{"c":[]}', href);
        g.__jb.becomeSharedWorker(href, name);
        entry = { url: href, name: name, origin: origin, type: type, g: g, ready: false, closed: false, pending: [] };
        g.__jb.sharedEntry = entry;
        reg.push(entry);
        setTimeout(function () {
          var r = g.__jb.runWorkerScript(href, type);
          if (r && r.error) { entry.closed = true; entry.pending.forEach(function (p) { p.fail(); }); entry.pending = []; return; }
          entry.ready = true;
          var waiting = entry.pending; entry.pending = [];
          waiting.forEach(function (p) { p.connect(); });
        }, 0);
      }
      // both ports are entangled now: messages posted before `connect` wait in the inside port
      var inside = entry.g.__jb.newPort();
      __jb.entanglePorts(outside, inside);
      var connect = function () {
        var gw = entry.g;
        if (entry.closed) return;
        var ev = new gw.MessageEvent("connect", { data: "", ports: [inside] });
        try { gw.__jb.setTrusted(ev, true); ev._trustedDispatch = true; } catch (e3) {}
        try { gw.dispatchEvent(ev); } catch (e4) { try { gw.__jb.reportException(e4); } catch (e5) {} }
      };
      if (entry.ready) setTimeout(connect, 0); else entry.pending.push({ connect: connect, fail: fail });
    }
    get port() { return this._portObj; }
  }
  __jb.setTag(SharedWorker, "SharedWorker");
  __jb.defineEventHandlerProps(SharedWorker.prototype, ["error"]);
  Object.defineProperty(globalThis, "SharedWorker", { value: SharedWorker, writable: true, configurable: true, enumerable: false });

  // ---- worklets ----
  // addModule() loads the module graph in one worklet global (a fresh realm sharing the owner's
  // policy container); nothing is rendered or played, but fetches, CSP and mixed content apply.
  var WORKLET = new WeakMap();
  function Worklet() { throw new TypeError("Illegal constructor"); }
  __jb.makeWorklet = function (dest, proto) {
    var w = Object.create(proto || Worklet.prototype);
    WORKLET.set(w, { dest: dest, realm: null });
    return w;
  };
  Object.defineProperty(Worklet.prototype, "addModule", { value: function addModule(moduleURL, options) {
    var rec = WORKLET.get(this);
    if (!rec) return Promise.reject(new TypeError("Illegal invocation"));
    var url;
    try { url = new URL(String(moduleURL), __jb.currentDocument.baseURI).href; } catch (e) { return Promise.reject(__jb.domError("SyntaxError", "Failed to execute 'addModule': invalid URL")); }
    if (typeof __jb.ttImportScriptsUrl === "function") { try { void 0; } catch (e0) {} }
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        var g = rec.realm;
        if (!g) {
          g = rec.realm = typeof __jb.createFrameRealm === "function" ? __jb.createFrameRealm(null, __jb.MAX_AUX_REALMS, true) : null;
          if (!g) { reject(__jb.domError("AbortError", "Unable to load a worklet's module.")); return; }
          try { g.__jb.frameContext = null; g.__jb.workerOwnerJb = __jb; g.__jb.loadDom('{"c":[]}', location.href); } catch (e1) {}
          try { g.__jb.isWorklet = true; g.__jb.inheritedCsp = __jb.cspPolicies().slice(); g.__jb.inheritedReferrerPolicy = __jb.documentReferrerPolicy(); g.__jb.cspOwnerWindow = globalThis; g.__jb.currentDocument._responseHeaders = __jb.currentDocument._responseHeaders || {}; delete g.document; } catch (e2) {}
        }
        var res;
        try {
          g.__jb.cspModuleOptions = { nonce: "", parser: "" };
          res = JSON.parse(g.__jb_native("evalModule", __jb.hostJson({ code: null, filename: url, base: url })) || "{}");
        } catch (e3) { res = { error: String(e3), fetch: true }; }
        if (res && res.error) reject(__jb.domError("AbortError", "Unable to load a worklet's module."));
        else resolve(undefined);
      }, 0);
    });
  }, writable: true, enumerable: true, configurable: true });
  __jb.setTag(Worklet, "Worklet");
  Object.defineProperty(globalThis, "Worklet", { value: Worklet, writable: true, configurable: true, enumerable: false });
  if (typeof CSS === "object" && CSS) {
    ["paintWorklet", "layoutWorklet", "animationWorklet"].forEach(function (k) {
      var inst = null;
      Object.defineProperty(CSS, k, { get: function () { return inst || (inst = __jb.makeWorklet(k === "paintWorklet" ? "paintworklet" : "script")); }, enumerable: true, configurable: true });
    });
  }
  // Web Audio is not implemented; the WPT runner gets an OfflineAudioContext carrying audioWorklet.
  function AudioWorklet() { throw new TypeError("Illegal constructor"); }
  AudioWorklet.prototype = Object.create(Worklet.prototype, { constructor: { value: AudioWorklet, writable: true, configurable: true } });
  function OfflineAudioContext() {
    if (!new.target) throw new TypeError("Constructor OfflineAudioContext requires 'new'");
    Object.defineProperty(this, "audioWorklet", { value: __jb.makeWorklet("audioworklet", AudioWorklet.prototype), enumerable: true });
  }
  Object.defineProperty(globalThis, "OfflineAudioContext", { get: function () { try { return __jb.topJb().wptMode ? OfflineAudioContext : undefined; } catch (e) { return undefined; } }, configurable: true, enumerable: false });
})();
