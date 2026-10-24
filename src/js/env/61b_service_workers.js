// ---------------------------------------------------------------- Service Workers + Cache API
// Registrations, workers and caches live on the top-level realm's `__jb.sw` (shared by every
// realm of the page); each realm has its own ServiceWorker / ServiceWorkerRegistration objects for
// them. The lifecycle (install -> installed -> activating -> activated, waitUntil, skipWaiting,
// redundant) is promise driven. Fetches of controlled documents go to the active worker's `fetch`
// handlers: fetch() asynchronously, synchronous loads (frame navigations, XHR) through a bounded
// nested event loop. Real pages keep the inert navigator.serviceWorker stub (WPT mode only).
(function () {
  var trusted = function (ev) { __jb.setTrusted(ev, true); ev._trustedDispatch = true; return ev; };
  // workers belong to their owner document's page
  var tjOf = function () { try { var j = __jb; for (var i = 0; i < 8 && j.workerOwnerJb && j.workerOwnerJb !== j; i++) j = j.workerOwnerJb; return j.topJb(); } catch (e) { return __jb; } };
  var store = function () {
    var tj = tjOf();
    if (!tj.swStore) tj.swStore = { regs: [], nextWorker: 1, caches: Object.create(null) };
    return tj.swStore;
  };
  var illegal = function () { throw new TypeError("Illegal constructor"); };
  var def = function (o, k, v, en) { Object.defineProperty(o, k, { value: v, writable: true, configurable: true, enumerable: en !== false }); };
  var getter = function (C, k, fn) { Object.defineProperty(C.prototype, k, { get: fn, enumerable: true, configurable: true }); };
  var SW = __jb.sw = {};
  // Service workers run on every secure page (WPT runs keep the full behaviour). Real pages get
  // limits so a worker cannot slow the page down: registration starts after the load event, a
  // worker may make SW.REAL_FETCH_CAP requests (precaching beyond that fails the install, and the
  // site then works from the network), and synchronous loads never wait for a worker.
  SW.REAL_FETCH_CAP = 24;
  SW.trace = function (msg) { try { __jb.native("trace", { message: "[sw] " + msg }); } catch (e) {} };
  SW.on = function () {
    var tj = tjOf();
    if (tj.wptMode) return true;
    if (tj.swDisabled) return false;
    try { return (tj.secureContext !== false) && __jb.secureContext !== false; } catch (e) { return false; }
  };
  SW.real = function () { return !tjOf().wptMode; };
  SW.afterLoad = function (fn) {
    var done = false, run = function () { if (done) return; done = true; fn(); };
    try { if (__jb.currentDocument.readyState === "complete" || __jb.loadEventDone) { run(); return; } } catch (e) { run(); return; }
    globalThis.addEventListener("load", function () { setTimeout(run, 0); }, { once: true });
    setTimeout(run, 5000); // pages whose load event never comes
  };

  // ---- realm-local objects for shared records ----
  var objs = function () { if (!__jb.swObjects) __jb.swObjects = new Map(); return __jb.swObjects; };
  function ServiceWorker() { illegal(); }
  ServiceWorker.prototype = Object.create(EventTarget.prototype, { constructor: { value: ServiceWorker, writable: true, configurable: true } });
  Object.setPrototypeOf(ServiceWorker, EventTarget);
  function ServiceWorkerRegistration() { illegal(); }
  ServiceWorkerRegistration.prototype = Object.create(EventTarget.prototype, { constructor: { value: ServiceWorkerRegistration, writable: true, configurable: true } });
  Object.setPrototypeOf(ServiceWorkerRegistration, EventTarget);
  function ServiceWorkerContainer() { illegal(); }
  ServiceWorkerContainer.prototype = Object.create(EventTarget.prototype, { constructor: { value: ServiceWorkerContainer, writable: true, configurable: true } });
  Object.setPrototypeOf(ServiceWorkerContainer, EventTarget);
  function NavigationPreloadManager() { illegal(); }
  var newTarget = function (proto) { var o = Object.create(proto); EventTarget.call(o); return o; };
  // EventTarget's constructor may refuse Reflect-less calls; fall back to a constructed instance.
  newTarget = function (proto) {
    var o;
    try { o = Reflect.construct(EventTarget, [], function () {}); } catch (e) { o = new EventTarget(); }
    Object.setPrototypeOf(o, proto);
    return o;
  };
  SW.workerObject = function (w) {
    if (!w) return null;
    var m = objs(), o = m.get(w);
    if (o) return o;
    o = newTarget(ServiceWorker.prototype);
    Object.defineProperty(o, "_rec", { value: w });
    m.set(w, o);
    return o;
  };
  SW.registrationObject = function (r) {
    if (!r) return null;
    var m = objs(), o = m.get(r);
    if (o) return o;
    o = newTarget(ServiceWorkerRegistration.prototype);
    Object.defineProperty(o, "_rec", { value: r });
    var np = Object.create(NavigationPreloadManager.prototype);
    Object.defineProperty(np, "_rec", { value: r });
    Object.defineProperty(o, "_np", { value: np });
    m.set(r, o);
    return o;
  };
  var recOf = function (o, C) { if (!o || !(o instanceof C) || !o._rec) throw new TypeError("Illegal invocation"); return o._rec; };
  getter(ServiceWorker, "scriptURL", function () { return recOf(this, ServiceWorker).scriptURL; });
  getter(ServiceWorker, "state", function () { return recOf(this, ServiceWorker).state; });
  def(ServiceWorker.prototype, "postMessage", function postMessage(message, transfer) {
    var w = recOf(this, ServiceWorker);
    if (arguments.length < 1) throw new TypeError("ServiceWorker.postMessage: 1 argument required");
    if (w.state === "redundant") return;
    var g = w.realm;
    var o = Array.isArray(transfer) ? { transfer: transfer } : Object.assign({}, transfer); o.outPorts = [];
    var data = __jb.cloneInto(g.__jb, message, o);
    var source = g.__jb.sw.clientFor(globalThis);
    var origin = location.origin;
    setTimeout(function () {
      if (w.state === "redundant") return;
      var ev = new g.ExtendableMessageEvent("message", { data: data, source: source, origin: origin, ports: o.outPorts });
      g.__jb.sw.dispatchExtendable(ev, g);
    }, 0);
  });
  __jb.defineEventHandlerProps(ServiceWorker.prototype, ["statechange", "error"]);
  getter(ServiceWorkerRegistration, "scope", function () { return recOf(this, ServiceWorkerRegistration).scope; });
  getter(ServiceWorkerRegistration, "installing", function () { return SW.workerObject(recOf(this, ServiceWorkerRegistration).installing); });
  getter(ServiceWorkerRegistration, "waiting", function () { return SW.workerObject(recOf(this, ServiceWorkerRegistration).waiting); });
  getter(ServiceWorkerRegistration, "active", function () { return SW.workerObject(recOf(this, ServiceWorkerRegistration).active); });
  getter(ServiceWorkerRegistration, "updateViaCache", function () { return recOf(this, ServiceWorkerRegistration).updateViaCache; });
  getter(ServiceWorkerRegistration, "navigationPreload", function () { recOf(this, ServiceWorkerRegistration); return this._np; });
  def(ServiceWorkerRegistration.prototype, "update", function update() {
    var r;
    try { r = recOf(this, ServiceWorkerRegistration); } catch (e) { return Promise.reject(e); }
    var newest = r.installing || r.waiting || r.active;
    if (!newest) return Promise.reject(__jb.domError("InvalidStateError", "The registration has no worker"));
    if (r.uninstalling) return Promise.reject(__jb.domError("InvalidStateError", "The registration is being unregistered"));
    var self_ = this;
    return SW.runUpdate(r, newest.scriptURL, newest.type, false).then(function () { return self_; });
  });
  def(ServiceWorkerRegistration.prototype, "unregister", function unregister() {
    var r;
    try { r = recOf(this, ServiceWorkerRegistration); } catch (e) { return Promise.reject(e); }
    return new Promise(function (resolve) { setTimeout(function () { resolve(SW.unregister(r)); }, 0); });
  });
  __jb.defineEventHandlerProps(ServiceWorkerRegistration.prototype, ["updatefound"]);
  // NavigationPreloadManager
  def(NavigationPreloadManager.prototype, "enable", function enable() { var r = this._rec; if (!r.active) return Promise.reject(__jb.domError("InvalidStateError", "no active worker")); r.preload.enabled = true; return Promise.resolve(); });
  def(NavigationPreloadManager.prototype, "disable", function disable() { var r = this._rec; if (!r.active) return Promise.reject(__jb.domError("InvalidStateError", "no active worker")); r.preload.enabled = false; return Promise.resolve(); });
  def(NavigationPreloadManager.prototype, "setHeaderValue", function setHeaderValue(v) { var r = this._rec; v = String(v); if (!/^[\t\x20-\x7e\x80-\xff]*$/.test(v)) return Promise.reject(new TypeError("invalid header value")); if (!r.active) return Promise.reject(__jb.domError("InvalidStateError", "no active worker")); r.preload.header = v; return Promise.resolve(); });
  def(NavigationPreloadManager.prototype, "getState", function getState() { var r = this._rec; return Promise.resolve({ enabled: r.preload.enabled, headerValue: r.preload.header }); });

  // ---- registry ----
  var scopeMatch = function (url) {
    var best = null;
    store().regs.forEach(function (r) { if (!r.uninstalling && String(url).indexOf(r.scope) === 0 && (!best || r.scope.length > best.scope.length)) best = r; });
    return best;
  };
  SW.matchRegistration = scopeMatch;
  SW.hasRegistrations = function () { return store().regs.length > 0; };
  SW.getRegistration = function (scope) { var regs = store().regs; for (var i = 0; i < regs.length; i++) if (regs[i].scope === scope) return regs[i]; return null; };
  var queueToAll = function (fn) {
    // run `fn(realmJb, realmWindow)` in a task of every realm (each realm sees its own objects)
    var wins = [];
    try { wins = tjOf().allRealmWindows ? tjOf().allRealmWindows() : [globalThis]; } catch (e) { wins = [globalThis]; }
    store().regs.forEach(function () {});
    var workers = [];
    store().regs.forEach(function (r) { [r.installing, r.waiting, r.active].forEach(function (w) { if (w && w.realm && workers.indexOf(w.realm) < 0) workers.push(w.realm); }); });
    wins.concat(workers).forEach(function (w) { try { if (w && w.__jb && w.__jb.sw) w.setTimeout(function () { try { fn(w.__jb, w); } catch (e) {} }, 0); } catch (e2) {} });
  };
  // every realm that may hold objects for the shared records (documents and service workers)
  SW.allRealms = function () {
    var wins = [];
    try { wins = tjOf().allRealmWindows ? tjOf().allRealmWindows() : [globalThis]; } catch (e) { wins = [globalThis]; }
    store().regs.forEach(function (r) { [r.installing, r.waiting, r.active].forEach(function (w) { if (w && w.realm && wins.indexOf(w.realm) < 0) wins.push(w.realm); }); });
    return wins.filter(function (w) { try { return !!(w && w.__jb && w.__jb.sw); } catch (e) { return false; } });
  };
  // "Update Worker State": the objects that exist now get a statechange event in a task.
  SW.setState = function (w, state) {
    w.state = state;
    SW.allRealms().forEach(function (win) {
      var o = win.__jb.swObjects && win.__jb.swObjects.get(w);
      if (o) win.setTimeout(function () { o.dispatchEvent(trusted(new win.Event("statechange"))); }, 0);
    });
    if (w.reg && w.reg.dead) return;
  };
  var createWorkerRecord = function (scriptURL, type, reg) {
    return { id: store().nextWorker++, scriptURL: scriptURL, type: type, state: "parsed", reg: reg, realm: null, skipWaiting: false, scripts: Object.create(null), handlesFetch: false };
  };
  // Fetch a worker script: same-origin, `Service-Worker: script`, JavaScript MIME type.
  SW.fetchScript = function (url, reg, isImport) {
    // the HTTP cache for worker scripts: fresh (max-age) responses are reused for imported scripts
    // unless updateViaCache is "none", and for the main script only with "all"
    var cache = store().httpCache || (store().httpCache = Object.create(null));
    var uvc = reg && reg.updateViaCache || "imports";
    var useCache = isImport ? uvc !== "none" : uvc === "all";
    var hit = cache[url];
    if (useCache && hit && Date.now() < hit.expires) return { text: hit.text, headers: hit.headers, url: hit.url };
    var r = __jb.native("fetch", { url: url, method: "GET", headers: { "Service-Worker": "script", Accept: "*/*" }, mode: "same-origin", dest: isImport ? "script" : "serviceworker", credentials: true });
    if (!r || !r.status) return { error: new TypeError("Failed to fetch the service worker script " + url) };
    if (r.status < 200 || r.status > 299) return { error: new TypeError("A bad HTTP response code (" + r.status + ") was received when fetching the script.") };
    var ct = String((r.headers && r.headers["content-type"]) || "").split(";")[0].trim().toLowerCase();
    if (!/^(text|application)\/(x-)?(javascript|ecmascript)$|^text\/(jscript|livescript|x-ecmascript|javascript1\.[0-5])$/.test(ct)) return { error: __jb.domError("SecurityError", "The script has an unsupported MIME type ('" + ct + "').") };
    var text = r.text !== undefined ? r.text : __utf8Decode(__jb.b64ToBytes(r.bodyBase64 || ""));
    var cc = String((r.headers && r.headers["cache-control"]) || ""), ma = /max-age\s*=\s*(\d+)/i.exec(cc);
    if (ma && !/no-store|no-cache/i.test(cc)) cache[url] = { text: text, headers: r.headers || {}, url: r.url || url, expires: Date.now() + Number(ma[1]) * 1000 };
    return { text: text, headers: r.headers || {}, url: r.url || url };
  };
  // Register / update job.
  SW.runUpdate = function (reg, scriptURL, type, isRegister) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        var res = SW.fetchScript(scriptURL, reg, false);
        SW.trace("update " + scriptURL + " scope=" + reg.scope + (res.error ? " fetch failed: " + res.error : " fetched " + res.text.length + " bytes"));
        if (res.error) { reject(res.error); if (isRegister && !reg.installing && !reg.waiting && !reg.active) SW.removeRegistration(reg); return; }
        // the scope must be within the script's directory or Service-Worker-Allowed
        var maxScope = res.headers["service-worker-allowed"] !== undefined ? new URL(res.headers["service-worker-allowed"], res.url).href : new URL("./", res.url).href;
        var maxPath = new URL(maxScope).pathname, scopePath = new URL(reg.scope).pathname;
        if (scopePath.indexOf(maxPath) !== 0) { reject(__jb.domError("SecurityError", "The path of the provided scope ('" + scopePath + "') is not under the max scope allowed ('" + maxPath + "').")); if (isRegister && !reg.active && !reg.waiting && !reg.installing) SW.removeRegistration(reg); return; }
        var newest = reg.installing || reg.waiting || reg.active;
        if (newest && newest.scriptURL === scriptURL && newest.type === type && newest.source === res.text) {
          // byte-for-byte equal main script: an update only when an imported script changed
          var importsChanged = Object.keys(newest.scripts).some(function (u) { var ir = SW.fetchScript(u, reg, true); return ir.error || ir.text !== newest.scripts[u]; });
          if (!importsChanged) { resolve(reg); return; }
        }
        var w = createWorkerRecord(scriptURL, type, reg);
        w.source = res.text;
        var ok = SW.startWorker(w, res);
        if (!ok) { SW.trace("evaluation failed " + scriptURL + ": " + (w.evalError || "")); reject(new TypeError("ServiceWorker script evaluation failed")); w.state = "redundant"; if (isRegister && !reg.active && !reg.waiting && !reg.installing) SW.removeRegistration(reg); return; }
        SW.install(reg, w);
        resolve(reg);
      }, 0);
    });
  };
  SW.removeRegistration = function (reg) { var regs = store().regs, i = regs.indexOf(reg); if (i >= 0) regs.splice(i, 1); };
  // Create the worker's global and run its script.
  SW.startWorker = function (w, res) {
    var g = typeof __jb.createFrameRealm === "function" ? __jb.createFrameRealm(null, __jb.MAX_AUX_REALMS, true) : null;
    if (!g) return false;
    try { g.__jb.frameContext = null; g.__jb.workerOwnerJb = __jb; } catch (e) {}
    g.__jb.loadDom('{"c":[]}', res.url);
    g.__jb.currentDocument._responseHeaders = res.headers || {};
    g.__jb.becomeServiceWorker(w);
    w.realm = g;
    var r;
    try {
      if (w.type === "module") { g.__jb.workerGraphLoading = true; try { r = JSON.parse(g.__jb_native("evalModule", __jb.hostJson({ code: res.text, filename: res.url, base: res.url })) || "{}"); } finally { g.__jb.workerGraphLoading = false; } }
      else r = JSON.parse(g.__jb_native("evalScript", __jb.hostJson({ code: res.text, filename: res.url, base: res.url })) || "{}");
    } catch (e) { r = { error: String(e) }; }
    w.evaluated = true;
    if (r && r.error) { w.evalError = r.error; try { g.__jb.reportError(r.error, res.url); } catch (e2) {} return false; }
    w.handlesFetch = g.__jb.sw.hasHandler("fetch");
    return true;
  };
  // Install, then try to activate.
  SW.install = function (reg, w) {
    if (reg.installing && reg.installing !== w) { SW.setState(reg.installing, "redundant"); }
    reg.installing = w;
    SW.setState(w, "installing");
    queueToAll(function (jb) { var o = jb.swObjects && jb.swObjects.get(reg); if (o) o.dispatchEvent(trusted(new Event("updatefound"))); });
    var g = w.realm;
    setTimeout(function () {
      var ev = new g.InstallEvent("install");
      g.__jb.sw.dispatchExtendable(ev, g).then(function (ok) {
        if (w.state === "redundant") return;
        SW.trace("install " + w.scriptURL + (ok ? " ok" : " failed (waitUntil rejected)"));
        if (!ok) { reg.installing = null; SW.setState(w, "redundant"); if (!reg.active && !reg.waiting) SW.removeRegistration(reg); return; }
        if (reg.waiting) SW.setState(reg.waiting, "redundant");
        reg.installing = null; reg.waiting = w;
        SW.setState(w, "installed");
        setTimeout(function () { SW.tryActivate(reg); }, 0);
      });
    }, 0);
  };
  SW.controlledClients = function (w) {
    return SW.windows().filter(function (win) { try { return win.__jb.swController === w; } catch (e) { return false; } });
  };
  SW.tryActivate = function (reg) {
    var w = reg.waiting;
    if (!w || w.state !== "installed") return;
    if (reg.active && reg.active.state === "activating") return;
    if (reg.active && !w.skipWaiting && SW.controlledClients(reg.active).length) return;
    SW.activate(reg);
  };
  SW.activate = function (reg) {
    var w = reg.waiting;
    if (!w) return;
    var old = reg.active;
    if (old) { SW.setState(old, "redundant"); }
    reg.active = w; reg.waiting = null;
    // clients using the old worker now use the new one
    if (old) SW.controlledClients(old).forEach(function (win) { win.__jb.swController = w; win.__jb.sw.fireControllerChange(); });
    SW.setState(w, "activating");
    var g = w.realm;
    setTimeout(function () {
      var ev = new g.ExtendableEvent("activate");
      g.__jb.sw.dispatchExtendable(ev, g).then(function () {
        if (w.state === "redundant") return;
        SW.setState(w, "activated");
        SW.trace("activated " + w.scriptURL);
        SW.readyWaiters();
      });
    }, 0);
  };
  SW.unregister = function (reg) {
    if (store().regs.indexOf(reg) < 0) return false;
    reg.uninstalling = true;
    var w = reg.active;
    if (!w || !SW.controlledClients(w).length) SW.clearRegistration(reg);
    return true;
  };
  SW.clearRegistration = function (reg) {
    [reg.installing, reg.waiting, reg.active].forEach(function (w) { if (w) SW.setState(w, "redundant"); });
    reg.installing = reg.waiting = reg.active = null;
    SW.removeRegistration(reg);
  };
  // A client went away: an uninstalling registration without clients is cleared.
  SW.clientGone = function () {
    store().regs.slice().forEach(function (r) {
      if (r.uninstalling && (!r.active || !SW.controlledClients(r.active).length)) SW.clearRegistration(r);
      else if (r.waiting) SW.tryActivate(r);
    });
  };
  // ---- clients ----
  SW.windows = function () {
    var out = [];
    try { out = tjOf().allRealmWindows ? tjOf().allRealmWindows() : [tjOf().window || globalThis]; } catch (e) { out = [globalThis]; }
    return out.filter(function (w) { try { return w && w.__jb && !w.__jb.isWorker && !w.closed; } catch (e) { return false; } });
  };
  SW.clientId = function (win) {
    if (!win.__jb.clientId) win.__jb.clientId = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2);
    return win.__jb.clientId;
  };
  SW.readyWaiters = function () {
    SW.windows().forEach(function (win) { try { var c = win.__jb.swContainer; if (c && c._readyResolve) win.__jb.sw.checkReady(); } catch (e) {} });
  };

  // ---- the container (navigator.serviceWorker) ----
  SW.container = function () {
    if (__jb.swContainer) return __jb.swContainer;
    var c = newTarget(ServiceWorkerContainer.prototype);
    // the client message queue is enabled once the document has completely loaded
    var loaded = false;
    try { loaded = !!(__jb.isWorker || __jb.loadEventDone || __jb.completelyLoaded || __jb.currentDocument.readyState !== "loading"); } catch (e) {}
    Object.defineProperty(c, "_messagesEnabled", { value: loaded, writable: true });
    Object.defineProperty(c, "_messageQueue", { value: [], writable: true });
    var resolveReady;
    var ready = new Promise(function (r) { resolveReady = r; });
    Object.defineProperty(c, "_ready", { value: ready });
    Object.defineProperty(c, "_readyResolve", { value: resolveReady, writable: true });
    __jb.swContainer = c;
    return c;
  };
  SW.checkReady = function () {
    var c = __jb.swContainer;
    if (!c || !c._readyResolve) return;
    var reg = scopeMatch(__jb.swClientUrl());
    if (reg && reg.active && (reg.active.state === "activated" || reg.active.state === "activating")) { var f = c._readyResolve; c._readyResolve = null; f(SW.registrationObject(reg)); }
  };
  __jb.swClientUrl = function () { try { return __jb.isWorker ? __jb.workerScriptUrl : __jb.currentDocument.URL; } catch (e) { return ""; } };
  SW.fireControllerChange = function () { var c = SW.container(); setTimeout(function () { c.dispatchEvent(trusted(new Event("controllerchange"))); }, 0); };
  getter(ServiceWorkerContainer, "controller", function () { return SW.workerObject(__jb.swController && __jb.swController.state !== "redundant" ? __jb.swController : null); });
  getter(ServiceWorkerContainer, "ready", function () {
    if (!(this instanceof ServiceWorkerContainer) || !this._ready) return Promise.reject(new TypeError("Illegal invocation"));
    SW.checkReady(); return this._ready;
  });
  def(ServiceWorkerContainer.prototype, "register", function register(scriptURL, options) {
    if (arguments.length < 1) return Promise.reject(new TypeError("register: 1 argument required"));
    var url, scope;
    options = options || {};
    try { url = new URL(String(scriptURL), __jb.currentDocument.baseURI); } catch (e) { return Promise.reject(new TypeError("Invalid script URL")); }
    if (!/^https?:$/.test(url.protocol)) return Promise.reject(new TypeError("The script URL scheme must be http or https"));
    if (/%2f|%5c/i.test(url.pathname)) return Promise.reject(new TypeError("The script URL path must not contain an escaped slash"));
    try { scope = options.scope !== undefined ? new URL(String(options.scope), __jb.currentDocument.baseURI) : new URL("./", url); } catch (e2) { return Promise.reject(new TypeError("Invalid scope URL")); }
    if (!/^https?:$/.test(scope.protocol)) return Promise.reject(new TypeError("The scope URL scheme must be http or https"));
    if (/%2f|%5c/i.test(scope.pathname)) return Promise.reject(new TypeError("The scope URL path must not contain an escaped slash"));
    scope.hash = "";
    if (url.origin !== location.origin) return Promise.reject(__jb.domError("SecurityError", "The origin of the script URL does not match the current origin"));
    if (scope.origin !== location.origin) return Promise.reject(__jb.domError("SecurityError", "The origin of the scope URL does not match the current origin"));
    var type = options.type === undefined ? "classic" : String(options.type);
    if (type !== "classic" && type !== "module") return Promise.reject(new TypeError("Invalid worker type"));
    var uvc = options.updateViaCache === undefined ? "imports" : String(options.updateViaCache);
    if (["imports", "all", "none"].indexOf(uvc) < 0) return Promise.reject(new TypeError("Invalid updateViaCache"));
    url.hash = "";
    var reg = SW.getRegistration(scope.href);
    if (reg && reg.uninstalling) { reg.uninstalling = false; }
    var sameUvc = true;
    if (!reg) {
      reg = { scope: scope.href, updateViaCache: uvc, installing: null, waiting: null, active: null, uninstalling: false, preload: { enabled: false, header: "true" } };
      store().regs.push(reg);
    } else { sameUvc = reg.updateViaCache === uvc; reg.updateViaCache = uvc; }
    var newest = reg.installing || reg.waiting || reg.active;
    // the same script, type and updateViaCache: the registration as it is; otherwise an update job
    var p = newest && newest.scriptURL === url.href && newest.type === type && sameUvc ? Promise.resolve(reg)
      : SW.real() ? new Promise(function (resolve) { SW.afterLoad(resolve); }).then(function () { return SW.runUpdate(reg, url.href, type, true); })
      : SW.runUpdate(reg, url.href, type, true);
    return p.then(function (r) { return SW.registrationObject(r); });
  });
  def(ServiceWorkerContainer.prototype, "getRegistration", function getRegistration(clientURL) {
    var u;
    try { u = new URL(clientURL === undefined ? "" : String(clientURL), __jb.currentDocument.baseURI); } catch (e) { return Promise.reject(new TypeError("Invalid URL")); }
    if (u.origin !== location.origin) return Promise.reject(__jb.domError("SecurityError", "The origin of the URL does not match the current origin"));
    var r = scopeMatch(u.href);
    return Promise.resolve(r ? SW.registrationObject(r) : undefined);
  });
  def(ServiceWorkerContainer.prototype, "getRegistrations", function getRegistrations() {
    var origin = location.origin;
    return Promise.resolve(store().regs.filter(function (r) { return !r.uninstalling && new URL(r.scope).origin === origin; }).map(SW.registrationObject));
  });
  def(ServiceWorkerContainer.prototype, "startMessages", function startMessages() { SW.enableMessages(this); });
  SW.enableMessages = function (c) {
    if (c._messagesEnabled) return;
    c._messagesEnabled = true;
    var q = c._messageQueue; c._messageQueue = [];
    q.forEach(function (fn) { setTimeout(fn, 0); });
  };
  __jb.defineEventHandlerProps(ServiceWorkerContainer.prototype, ["controllerchange", "messageerror"]);
  Object.defineProperty(ServiceWorkerContainer.prototype, "onmessage", {
    get: function () { return this._onmessageH || null; },
    set: function (v) { this._onmessageH = typeof v === "function" ? v : null; __jb.handlerSlot(this, "message", this._onmessageH); SW.enableMessages(this); },
    enumerable: true, configurable: true,
  });
  // a message from a service worker (Client.postMessage)
  SW.deliverToClient = function (data, ports, sourceWorker, origin) {
    var c = SW.container();
    var send = function () { c.dispatchEvent(trusted(new MessageEvent("message", { data: data, ports: ports || [], origin: origin, source: SW.workerObject(sourceWorker) }))); };
    if (!c._messagesEnabled) { try { if (__jb.loadEventDone || __jb.currentDocument.readyState !== "loading") c._messagesEnabled = true; } catch (eL) {} }
    if (c._messagesEnabled) setTimeout(send, 0); else c._messageQueue.push(send);
  };
  // after the document's load completes, client message queues are enabled
  [ServiceWorker, ServiceWorkerRegistration, ServiceWorkerContainer, NavigationPreloadManager].forEach(function (C) {
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
    def(globalThis, C.name, C, false);
  });

  // ---- worker global ----
  function ExtendableEvent(type, init) {
    if (!new.target) throw new TypeError("Constructor ExtendableEvent requires 'new'");
    var e = Reflect.construct(Event, [type, init], new.target);
    Object.defineProperty(e, "_extend", { value: [], writable: true });
    return e;
  }
  ExtendableEvent.prototype = Object.create(Event.prototype, { constructor: { value: ExtendableEvent, writable: true, configurable: true } });
  Object.setPrototypeOf(ExtendableEvent, Event);
  def(ExtendableEvent.prototype, "waitUntil", function waitUntil(p) {
    if (!this.isTrusted) throw __jb.domError("InvalidStateError", "waitUntil called on an untrusted event");
    if (!this._swActive && !this._pending) throw __jb.domError("InvalidStateError", "The event handler is already finished");
    this._extend.push(Promise.resolve(p));
    var self_ = this;
    this._pending = (this._pending || 0) + 1;
    Promise.resolve(p).then(function () { self_._pending--; }, function () { self_._pending--; });
  });
  function FetchEvent(type, init) {
    if (!new.target) throw new TypeError("Constructor FetchEvent requires 'new'");
    if (arguments.length < 2 || !init || !(init.request instanceof Request)) throw new TypeError("FetchEvent: init.request must be a Request");
    var e = Reflect.construct(ExtendableEvent, [type, init], new.target);
    Object.defineProperty(e, "_fe", { value: { request: init.request, clientId: init.clientId === undefined ? "" : String(init.clientId), resultingClientId: init.resultingClientId === undefined ? "" : String(init.resultingClientId), replacesClientId: init.replacesClientId === undefined ? "" : String(init.replacesClientId), preloadResponse: init.preloadResponse !== undefined ? init.preloadResponse : Promise.resolve(undefined), handled: init.handled || Promise.resolve(undefined), responded: false, response: null } });
    return e;
  }
  FetchEvent.prototype = Object.create(ExtendableEvent.prototype, { constructor: { value: FetchEvent, writable: true, configurable: true } });
  Object.setPrototypeOf(FetchEvent, ExtendableEvent);
  ["request", "clientId", "resultingClientId", "replacesClientId", "preloadResponse", "handled"].forEach(function (k) { getter(FetchEvent, k, function () { return this._fe[k]; }); });
  def(FetchEvent.prototype, "respondWith", function respondWith(r) {
    var fe = this._fe;
    if (!this._swActive) throw __jb.domError("InvalidStateError", "respondWith must be called synchronously in the fetch handler");
    if (fe.responded) throw __jb.domError("InvalidStateError", "respondWith has already been called");
    fe.responded = true;
    this.preventDefault();
    var p = Promise.resolve(r);
    fe.response = p;
    this._extend.push(p.then(function () {}, function () {}));
  });
  function ExtendableMessageEvent(type, init) {
    if (!new.target) throw new TypeError("Constructor ExtendableMessageEvent requires 'new'");
    var e = Reflect.construct(ExtendableEvent, [type, init], new.target);
    init = init || {};
    Object.defineProperty(e, "_me", { value: { data: init.data === undefined ? null : init.data, origin: init.origin === undefined ? "" : String(init.origin), lastEventId: init.lastEventId === undefined ? "" : String(init.lastEventId), source: init.source === undefined ? null : init.source, ports: Object.freeze((init.ports || []).slice()) } });
    return e;
  }
  ExtendableMessageEvent.prototype = Object.create(ExtendableEvent.prototype, { constructor: { value: ExtendableMessageEvent, writable: true, configurable: true } });
  Object.setPrototypeOf(ExtendableMessageEvent, ExtendableEvent);
  ["data", "origin", "lastEventId", "source", "ports"].forEach(function (k) { getter(ExtendableMessageEvent, k, function () { return this._me[k]; }); });
  function InstallEvent(type, init) {
    if (!new.target) throw new TypeError("Constructor InstallEvent requires 'new'");
    return Reflect.construct(ExtendableEvent, [type, init], new.target);
  }
  InstallEvent.prototype = Object.create(ExtendableEvent.prototype, { constructor: { value: InstallEvent, writable: true, configurable: true } });
  Object.setPrototypeOf(InstallEvent, ExtendableEvent);
  def(InstallEvent.prototype, "addRoutes", function addRoutes(rules) {
    var w = __jb.swSelfRecord;
    try {
      if (!w || w.state !== "installing") throw __jb.domError("InvalidStateError", "addRoutes must be called during installation");
      var list = Array.isArray(rules) ? rules : [rules];
      var out = list.map(function (rule) {
        if (!rule || typeof rule !== "object" || rule.condition === undefined || rule.source === undefined) throw new TypeError("addRoutes: a rule needs a condition and a source");
        var src = routerSource(rule.source);
        if ((src === "fetch-event" || src === "race-network-and-fetch-handler") && !SW.hasHandler("fetch")) throw new TypeError("addRoutes: the 'fetch-event' source needs a fetch handler");
        return { condition: routerCondition(rule.condition, w.scriptURL, 0), source: src };
      });
      if ((w.routes || []).length + out.length > MAX_ROUTER_RULES) throw new TypeError("addRoutes: too many rules");
      w.routes = (w.routes || []).concat(out);
      return Promise.resolve();
    } catch (e) { return Promise.reject(e); }
  });
  [ExtendableEvent, FetchEvent, ExtendableMessageEvent, InstallEvent].forEach(function (C) { Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true }); });
  // Dispatch an extendable event in worker global `g`; resolves to whether no waitUntil rejected.
  SW.dispatchExtendable = function (ev, g) {
    trusted(ev);
    ev._swActive = true;
    try { g.dispatchEvent(ev); } catch (e) { try { __jb.reportException(e); } catch (e2) {} }
    ev._swActive = false;
    if (!ev._extend.length) return Promise.resolve(true);
    // promises added while earlier ones are pending also extend the lifetime
    var wait = function (n) { return Promise.all(ev._extend.slice(0, n)).then(function () { return ev._extend.length > n ? wait(ev._extend.length) : true; }); };
    return wait(ev._extend.length).then(function () { return true; }, function () { return false; });
  };
  SW.hasHandler = function (type) {
    var l = globalThis._jbListeners && globalThis._jbListeners[type];
    return !!(l && l.some(function (x) { return !x.removed; })) || typeof globalThis["on" + type] === "function";
  };
  function Clients() { illegal(); }
  function Client() { illegal(); }
  function WindowClient() { illegal(); }
  WindowClient.prototype = Object.create(Client.prototype, { constructor: { value: WindowClient, writable: true, configurable: true } });
  Object.setPrototypeOf(WindowClient, Client);
  var clientObjects = new Map();
  SW.clientFor = function (win) {
    if (!win) return null;
    var o = clientObjects.get(win);
    if (o) return o;
    o = Object.create((win.__jb && !win.__jb.isWorker) ? WindowClient.prototype : Client.prototype);
    Object.defineProperty(o, "_win", { value: win });
    clientObjects.set(win, o);
    return o;
  };
  var winOf = function (c) { if (!c || !c._win) throw new TypeError("Illegal invocation"); return c._win; };
  getter(Client, "url", function () { var w = winOf(this); try { return w.__jb.isWorker ? w.__jb.workerScriptUrl : w.document.URL; } catch (e) { return ""; } });
  getter(Client, "id", function () { return SW.clientId(winOf(this)); });
  getter(Client, "type", function () { var w = winOf(this); return w.__jb && w.__jb.isWorker ? (w.__jb.isSharedWorker ? "sharedworker" : "worker") : "window"; });
  getter(Client, "frameType", function () { var w = winOf(this); try { if (w.__jb.frameContext && w.__jb.frameContext.parent && w.__jb.frameContext.parent !== w) return "nested"; if (w.__jb.auxiliary) return "auxiliary"; return "top-level"; } catch (e) { return "none"; } });
  getter(Client, "lifecycleState", function () { return "active"; });
  def(Client.prototype, "postMessage", function postMessage(message, transfer) {
    var w = winOf(this);
    if (arguments.length < 1) throw new TypeError("Client.postMessage: 1 argument required");
    var o = Array.isArray(transfer) ? { transfer: transfer } : Object.assign({}, transfer); o.outPorts = [];
    var data = __jb.cloneInto(w.__jb, message, o);
    var me = __jb.swSelfRecord;
    var origin = location.origin;
    w.setTimeout(function () { w.__jb.sw.deliverToClient(data, o.outPorts, me, origin); }, 0);
  });
  getter(WindowClient, "visibilityState", function () { try { return winOf(this).document.visibilityState; } catch (e) { return "visible"; } });
  getter(WindowClient, "focused", function () { try { return winOf(this).document.hasFocus(); } catch (e) { return false; } });
  getter(WindowClient, "ancestorOrigins", function () { return Object.freeze([]); });
  def(WindowClient.prototype, "focus", function focus() { return Promise.reject(__jb.domError("InvalidAccessError", "Not allowed to focus a window")); });
  def(WindowClient.prototype, "navigate", function navigate(url) {
    var w = winOf(this), self_ = this;
    var target;
    try { target = new URL(String(url), location.href).href; } catch (e) { return Promise.reject(new TypeError("Invalid URL")); }
    if (w.__jb.swController !== __jb.swSelfRecord) return Promise.reject(new TypeError("The client is not controlled by this worker"));
    return new Promise(function (resolve) {
      try { w.location.href = target; } catch (e) {}
      setTimeout(function () { resolve(new URL(target).origin === location.origin ? SW.clientFor(w) : null); }, 50);
    });
  });
  var clientsMatch = function (opts) {
    opts = opts || {};
    var me = __jb.swSelfRecord, origin = location.origin;
    var wins = SW.windows().filter(function (w) { try { return w.location.origin === origin && !/^about:/.test(w.document.URL); } catch (e) { return false; } });
    if (!opts.includeUncontrolled) wins = wins.filter(function (w) { return w.__jb.swController === me; });
    var type = opts.type === undefined ? "window" : String(opts.type);
    if (type !== "window" && type !== "all") return [];
    return wins.map(SW.clientFor);
  };
  var clientsObj = Object.create(Clients.prototype);
  def(Clients.prototype, "get", function get(id) { var list = clientsMatch({ includeUncontrolled: true, type: "all" }); for (var i = 0; i < list.length; i++) if (list[i].id === String(id)) return Promise.resolve(list[i]); return Promise.resolve(undefined); });
  def(Clients.prototype, "matchAll", function matchAll(opts) { return Promise.resolve(clientsMatch(opts)); });
  def(Clients.prototype, "openWindow", function openWindow() { return Promise.reject(__jb.domError("InvalidAccessError", "Not allowed to open a window")); });
  def(Clients.prototype, "claim", function claim() {
    var me = __jb.swSelfRecord;
    if (!me || me.state !== "activating" && me.state !== "activated") return Promise.reject(__jb.domError("InvalidStateError", "The worker is not active"));
    SW.windows().forEach(function (w) {
      try {
        if (w.location.origin !== location.origin) return;
        var reg = SW.matchRegistration(w.document.URL);
        if (reg !== me.reg || w.__jb.swController === me) return;
        w.__jb.swController = me; w.__jb.sw.fireControllerChange();
      } catch (e) {}
    });
    return Promise.resolve();
  });
  [Clients, Client, WindowClient].forEach(function (C) { Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true }); });
  __jb.becomeServiceWorker = function (w) {
    var g = globalThis, base = Object.getPrototypeOf(g);
    function WorkerGlobalScope() { illegal(); }
    function ServiceWorkerGlobalScope() { illegal(); }
    WorkerGlobalScope.prototype = Object.create(base, { constructor: { value: WorkerGlobalScope, writable: true, configurable: true } });
    ServiceWorkerGlobalScope.prototype = Object.create(WorkerGlobalScope.prototype, { constructor: { value: ServiceWorkerGlobalScope, writable: true, configurable: true } });
    Object.setPrototypeOf(ServiceWorkerGlobalScope, WorkerGlobalScope);
    Object.defineProperty(WorkerGlobalScope.prototype, Symbol.toStringTag, { value: "WorkerGlobalScope", configurable: true });
    Object.defineProperty(ServiceWorkerGlobalScope.prototype, Symbol.toStringTag, { value: "ServiceWorkerGlobalScope", configurable: true });
    try { Object.setPrototypeOf(g, ServiceWorkerGlobalScope.prototype); } catch (e) {}
    var d = function (k, v) { Object.defineProperty(g, k, { value: v, writable: true, configurable: true, enumerable: false }); };
    d("WorkerGlobalScope", WorkerGlobalScope); d("ServiceWorkerGlobalScope", ServiceWorkerGlobalScope);
    d("ExtendableEvent", ExtendableEvent); d("FetchEvent", FetchEvent); d("ExtendableMessageEvent", ExtendableMessageEvent); d("InstallEvent", InstallEvent);
    d("Clients", Clients); d("Client", Client); d("WindowClient", WindowClient);
    __jb.isWorker = true; __jb.isServiceWorker = true; __jb.swSelfRecord = w; try { delete g.document; } catch (eD) {}
    __jb.workerScriptUrl = w.scriptURL;
    Object.defineProperty(ServiceWorkerGlobalScope.prototype, "clients", { get: function () { return clientsObj; }, enumerable: true, configurable: true });
    Object.defineProperty(ServiceWorkerGlobalScope.prototype, "registration", { get: function () { return SW.registrationObject(w.reg); }, enumerable: true, configurable: true });
    Object.defineProperty(ServiceWorkerGlobalScope.prototype, "serviceWorker", { get: function () { return SW.workerObject(w); }, enumerable: true, configurable: true });
    def(ServiceWorkerGlobalScope.prototype, "skipWaiting", function skipWaiting() { w.skipWaiting = true; setTimeout(function () { var outer = w.reg; if (outer.waiting === w) outer.waitingSkip = true; SW.tryActivate(outer); }, 0); return Promise.resolve(); });
    __jb.defineEventHandlerProps(ServiceWorkerGlobalScope.prototype, ["install", "activate", "fetch", "message", "messageerror"]);
    d("importScripts", function importScripts() {
      for (var i = 0; i < arguments.length; i++) {
        var arg = arguments[i];
        if (typeof __jb.ttImportScriptsUrl === "function") arg = __jb.ttImportScriptsUrl(arg);
        var u;
        try { u = new URL(String(arg), w.scriptURL).href; } catch (e) { throw __jb.domError("SyntaxError", "importScripts: invalid URL " + arg); }
        var text = w.scripts[u];
        if (text === undefined) {
          if (w.state !== "parsed" && w.state !== "installing") throw __jb.domError("NetworkError", "importScripts: new scripts cannot be imported after installation");
          var src = SW.fetchScript(u, w.reg, true);
          if (src.error) throw __jb.domError("NetworkError", "importScripts: failed to load " + u);
          text = w.scripts[u] = src.text;
        }
        var res = JSON.parse(__jb_native("evalScript", __jb.hostJson({ code: text, filename: u, base: u })) || "{}");
        if (res && res.error) {
          if (globalThis.__jb_hasLastError) { var e2 = globalThis.__jb_lastError; globalThis.__jb_hasLastError = false; globalThis.__jb_lastError = undefined; throw e2; }
          throw new Error(res.error);
        }
      }
    });
    // service workers have no navigator.serviceWorker controller and cannot nest
    __jb.swController = null;
    if (SW.real()) {
      var baseFetch = g.fetch;
      w.netCount = 0;
      d("fetch", function fetch(input, init) {
        if (++w.netCount > SW.REAL_FETCH_CAP) return Promise.reject(new TypeError("NetworkError when attempting to fetch resource: service worker request limit reached"));
        // fetch() never throws: failures reject the returned promise
        try { return baseFetch.apply(this, arguments); } catch (e) { return Promise.reject(e); }
      });
    }
  };

  // ---- fetch interception ----
  // Pull the bytes and metadata out of a Response (any realm).
  SW.responseRecord = function (resp) {
    if (!resp || typeof resp !== "object" || Object.prototype.toString.call(resp) !== "[object Response]") return null;
    if (resp.type === "error") return null;
    var headers = {};
    try { resp.headers.forEach(function (v, k) { headers[k] = v; }); } catch (e) {}
    var body;
    try { body = resp._opaque ? resp._opaque.body : resp._bodyBytes ? resp._bodyBytes() : new Uint8Array(0); } catch (e2) { body = new Uint8Array(0); }
    if (resp._opaque && resp._opaque.headers && resp._opaque.headers["content-type"]) headers["content-type"] = resp._opaque.headers["content-type"];
    return { status: resp.status, statusText: resp.statusText, headers: headers, body: body, url: resp.url, type: resp.type, redirected: resp.redirected, redirect: resp._redirect || null };
  };
  // Run the event loop until `done()` (bounded).
  SW.spin = function (done, maxSteps) {
    var tj = tjOf(), steps = 0;
    maxSteps = maxSteps || 4000;
    while (!done() && steps++ < maxSteps) {
      try { __jb_native("runJobs", ""); } catch (e) {}
      if (done()) break;
      var ran = false;
      try { ran = tj.runOneTimer(); } catch (e2) {}
      if (!ran) { try { __jb_native("runJobs", ""); } catch (e3) {} if (!done()) break; }
    }
    return done();
  };
  // Handle Fetch: `req` = {url, method, headers, body, mode, credentials, redirect, destination,
  // referrer}; returns a promise of a response record, `null` (network fallback) or `false`
  // (network error).
  SW.handleFetch = function (w, req, clientWin, resultingClientId) {
    var g = w.realm;
    if (!g) return Promise.resolve(null);
    // static routes first
    var route = SW.routeFor(w, req);
    if (route === "network") return Promise.resolve(null);
    if (route && route.cache) { var hit = g.__jb.sw.cacheLookup(req, route.cacheName); return Promise.resolve(hit ? hit : null); }
    if (!w.handlesFetch && !g.__jb.sw.hasHandler("fetch")) return Promise.resolve(null);
    // the request's referrer as main fetch computes it (policy defaults to strict-origin-when-cross-origin)
    if (clientWin && clientWin.__jb && typeof clientWin.__jb.requestReferrer === "function") {
      try {
        var rf = req.mode === "navigate" && req.referrerPolicy !== undefined ? { referrer: req.referrer, referrerPolicy: req.referrerPolicy } : clientWin.__jb.requestReferrer(req.referrerPolicy || "");
        var src = req.referrer === "" ? "" : req.referrer && req.referrer !== "about:client" ? req.referrer : rf.referrer;
        var pol = rf.referrerPolicy || "strict-origin-when-cross-origin";
        var computed = src ? __jb.native("referrer", { source: src, policy: pol, target: req.url }) : null;
        req = Object.assign({}, req, { referrer: computed || "", referrerPolicy: pol });
      } catch (eR) {}
    }
    var init = { method: req.method || "GET", headers: req.headers || {}, redirect: req.redirect || "follow", credentials: req.credentials || "include", mode: req.mode === "navigate" ? "same-origin" : (req.mode || "no-cors") };
    if (req.cache) init.cache = req.cache;
    if (req.integrity) init.integrity = req.integrity;
    if (req.keepalive) init.keepalive = true;
    if (req.body !== undefined && req.body !== null && !/^(GET|HEAD)$/.test(init.method)) init.body = req.body;
    if (req.referrer !== undefined) init.referrer = req.referrer;
    var request;
    try { request = new g.Request(req.url, init); } catch (e) { return Promise.resolve(null); }
    request.mode = req.mode || request.mode;
    request.isReloadNavigation = !!req.isReload;
    request.isHistoryNavigation = !!req.isHistory;
    // the request's origin (its initiator's), used when the worker passes it on
    try { Object.defineProperty(request, "_jbOrigin", { value: req.origin || (clientWin && clientWin.location ? clientWin.location.origin : undefined), writable: true, configurable: true }); } catch (eO) {}
    request.destination = req.destination || "";
    if (req.referrer !== undefined && req.referrer !== "about:client") request.referrer = req.referrer;
    if (req.referrerPolicy !== undefined) request.referrerPolicy = req.referrerPolicy;
    var handledResolve;
    var handled = new g.Promise(function (r) { handledResolve = r; });
    var preload = Promise.resolve(undefined);
    if (req.mode === "navigate" && w.reg && w.reg.preload && w.reg.preload.enabled) {
      try {
        var ph = Object.assign({}, req.headers || {}); ph["Service-Worker-Navigation-Preload"] = w.reg.preload.header;
        var pinit = { method: req.method || "GET", headers: ph, credentials: "include", redirect: "manual" };
        if (req.body !== undefined && req.body !== null && !/^(GET|HEAD)$/.test(pinit.method)) pinit.body = req.body;
        if (req.referrer !== undefined && req.referrer !== "about:client") pinit.referrer = req.referrer;
        if (req.referrerPolicy) pinit.referrerPolicy = req.referrerPolicy;
        var preq = new g.Request(req.url, pinit);
        if (req.referrer !== undefined) preq.referrer = req.referrer; // the navigation's referrer, whatever its origin
        preload = g.fetch(preq).catch(function () { return undefined; });
      } catch (eP) { preload = Promise.resolve(undefined); }
    }
    var ev = new g.FetchEvent("fetch", { request: request, clientId: req.mode === "navigate" || !clientWin ? "" : SW.clientId(clientWin), resultingClientId: resultingClientId || "", handled: handled, preloadResponse: preload, cancelable: true });
    // the fetch event is a task on the worker's event loop
    // (synchronous loads spin the loop, possibly inside a microtask: no task hop for them)
    var taskHost = !SW.syncDispatch && clientWin && typeof clientWin.setTimeout === "function" ? clientWin : null;
    var queued = taskHost ? new Promise(function (res) { taskHost.setTimeout(res, 0); }) : Promise.resolve();
    return queued.then(function () { return g.__jb.sw.dispatchExtendable(ev, g); }).then(function () {
      var fe = ev._fe;
      SW.trace("fetch event " + req.url + (fe.responded ? " respondWith" : " fallback"));
      if (fe.responded) fe.response.then(function (x) { SW.trace("respondWith value " + Object.prototype.toString.call(x) + " type=" + (x && x.type) + " status=" + (x && x.status)); }, function (e) { SW.trace("respondWith rejected " + e); });
      if (!fe.responded) { handledResolve(undefined); return null; }
      return fe.response.then(function (resp) {
        // a stream body is read to its end first
        var typeOk = function (r) {
          if (r.type === "opaque" && req.mode !== "no-cors") return false;
          if (r.type === "cors" && req.mode === "same-origin") return false;
          if (r.type === "opaqueredirect" && req.redirect !== "manual") return false;
          return true;
        };
        if (resp && typeof resp === "object" && !resp._opaque && resp._body && Object.prototype.toString.call(resp._body) === "[object ReadableStream]" && !resp.bodyUsed && typeof resp._collect === "function") {
          return resp._collect().then(function (bytes) { SW.trace("stream response " + req.url + " bytes=" + bytes.length); var rec2 = SW.responseRecord(resp); if (!rec2 || !typeOk(rec2)) return false; rec2.body = bytes; handledResolve(undefined); return rec2; }, function () { return false; });
        }
        var rec = SW.responseRecord(resp);
        SW.trace("response " + req.url + " type=" + (rec && rec.type) + " status=" + (rec && rec.status) + " bytes=" + (rec && rec.body && rec.body.length) + " bodyUsed=" + (resp && resp.bodyUsed) + " bodyKind=" + (resp && Object.prototype.toString.call(resp._body)));
        if (!rec) return false;
        if (!typeOk(rec)) return false;
        if (resp.bodyUsed) return false;
        try { resp.bodyUsed = true; } catch (eU) {}
        handledResolve(undefined);
        return rec;
      }, function () { return false; });
    }, function () { return null; });
  };
  // Synchronous variant for loads that cannot wait (navigations, XHR): spins the event loop.
  SW.handleFetchSync = function (w, req, clientWin, resultingClientId) {
    if (SW.real()) return null;
    var out, settled = false, prevSync = SW.syncDispatch;
    SW.syncDispatch = true;
    try { SW.handleFetch(w, req, clientWin, resultingClientId).then(function (r) { out = r; settled = true; }, function () { out = false; settled = true; }); } finally { SW.syncDispatch = prevSync; }
    SW.spin(function () { return settled; });
    return settled ? out : null;
  };
  // The service worker that a fetch from this realm goes through (null when none).
  SW.controllerForRequest = function (url) {
    if (!SW.on()) return null;
    var w = __jb.swController;
    if (!w || w.state === "redundant" || __jb.isServiceWorker) return null;
    if (!/^https?:/.test(String(url))) return null;
    return w;
  };
  SW.navigationController = function (url) {
    if (!SW.on() || __jb.isServiceWorker) return null;
    var reg = scopeMatch(url);
    if (!reg || !reg.active || reg.active.state === "redundant") return null;
    return reg.active;
  };
  // A response record as a Response of this realm.
  SW.toResponse = function (rec, reqUrl) {
    if (rec.type === "opaque" && rec.body && rec.body.length && !rec._plain) {
      var op = SW.toResponse(Object.assign({}, rec, { body: null, headers: {}, _plain: true }), reqUrl);
      Object.defineProperty(op, "_opaque", { value: { body: new Uint8Array(rec.body), headers: rec.headers || {} }, configurable: true });
      return op;
    }
    var bodyCopy = rec.body ? new Uint8Array(rec.body) : null;
    var r = new Response(rec.status === 204 || rec.status === 304 || rec.status === 205 ? null : bodyCopy, { status: rec.status === 0 ? 200 : rec.status, statusText: rec.statusText, headers: rec.headers });
    if (rec.status === 0) { try { Object.defineProperty(r, "status", { value: 0, writable: true, configurable: true }); } catch (e) {} }
    r.type = rec.type === "default" ? "basic" : rec.type;
    r.url = rec.url || "";
    r.redirected = !!rec.redirected;
    if (r.type === "opaque") r.headers._guard = "immutable";
    return r;
  };
  // Controller of a newly loaded document (called from the realm loader).
  SW.assignController = function (g, url, inheritFrom) {
    try {
      if (!SW.on()) return;
      var c = null;
      if (/^https?:/.test(url)) c = g.__jb.pendingSwController !== undefined ? g.__jb.pendingSwController : SW.navigationController(url);
      else if (inheritFrom && inheritFrom.__jb) c = inheritFrom.__jb.swController || null;
      g.__jb.swController = c && c.state !== "redundant" ? c : null;
      g.__jb.pendingSwController = undefined;
    } catch (e) {}
  };

  // ---- Cache API ----
  function CacheStorage() { illegal(); }
  function Cache() { illegal(); }
  var originCaches = function () {
    var o = location.origin, c = store().caches;
    if (!c[o]) c[o] = { names: [], map: Object.create(null) };
    return c[o];
  };
  var toRequestRec = function (input, forMatch) {
    var req = input instanceof Request || Object.prototype.toString.call(input) === "[object Request]" ? input : new Request(String(input));
    var headers = {};
    try { req.headers.forEach(function (v, k) { headers[k] = v; }); } catch (e) {}
    return { url: req.url.split("#")[0], method: req.method, headers: headers, req: req };
  };
  var varyMatches = function (entry, reqRec) {
    var vary = entry.response.headers.vary;
    if (!vary) return true;
    return vary.split(",").every(function (h) { h = h.trim().toLowerCase(); if (h === "*") return false; return (entry.request.headers[h] || null) === (reqRec.headers[h] || null); });
  };
  var queryCache = function (cache, reqRec, opts) {
    opts = opts || {};
    return cache.entries.filter(function (e) {
      if (!opts.ignoreMethod && reqRec.method !== "GET" && reqRec.method !== "HEAD") return false;
      var a = new URL(e.request.url), b = new URL(reqRec.url);
      if (opts.ignoreSearch) { a.search = ""; b.search = ""; }
      a.hash = ""; b.hash = "";
      if (a.href !== b.href) return false;
      return opts.ignoreVary || varyMatches(e, reqRec);
    });
  };
  var cacheObject = function (name) {
    var c = Object.create(Cache.prototype);
    Object.defineProperty(c, "_name", { value: name });
    return c;
  };
  var cacheRec = function (c) { var oc = originCaches(); var r = oc.map[c._name]; if (!r) { r = oc.map[c._name] = { entries: [] }; } return r; };
  var responseFromEntry = function (e) {
    var rec = e.response;
    if (rec.type === "opaque") { var o = SW.toResponse(Object.assign({}, rec, { body: null, headers: {} })); Object.defineProperty(o, "_opaque", { value: { body: rec.body, headers: rec.headers }, configurable: true }); return o; }
    return SW.toResponse(rec);
  };
  def(Cache.prototype, "match", function match(request, options) {
    var self_ = this;
    return Promise.resolve().then(function () { var rr = toRequestRec(request); var list = queryCache(cacheRec(self_), rr, options); return list.length ? responseFromEntry(list[0]) : undefined; });
  });
  def(Cache.prototype, "matchAll", function matchAll(request, options) {
    var self_ = this;
    return Promise.resolve().then(function () { var list = request === undefined ? cacheRec(self_).entries.slice() : queryCache(cacheRec(self_), toRequestRec(request), options); return list.map(responseFromEntry); });
  });
  var putEntry = function (cache, reqRec, rec) {
    cache.entries = cache.entries.filter(function (e) { return !(e.request.url === reqRec.url && (!rec || true) && varyMatches({ request: e.request, response: { headers: rec.headers } }, reqRec)); });
    cache.entries.push({ request: { url: reqRec.url, method: reqRec.method, headers: reqRec.headers }, response: rec });
  };
  var checkPutRequest = function (rr) {
    if (!/^https?:$/.test(new URL(rr.url).protocol)) throw new TypeError("Request scheme must be http or https");
    if (rr.method !== "GET") throw new TypeError("Request method must be GET");
  };
  def(Cache.prototype, "put", function put(request, response) {
    var self_ = this;
    return Promise.resolve().then(function () {
      var rr = toRequestRec(request);
      checkPutRequest(rr);
      if (!response || Object.prototype.toString.call(response) !== "[object Response]") throw new TypeError("Cache.put: response is not a Response");
      if (response.status === 206) throw new TypeError("Cache.put: partial responses are not supported");
      var vary = response.headers.get("vary");
      if (vary && vary.split(",").some(function (h) { return h.trim() === "*"; })) throw new TypeError("Cache.put: Vary: * is not cacheable");
      if (response.bodyUsed) throw new TypeError("Cache.put: the response body is already used");
      return response.clone()._collect().then(function (bytes) {
        response.bodyUsed = true;
        var rec = SW.responseRecord(response) || {};
        if (!response._opaque) rec.body = bytes;
        putEntry(cacheRec(self_), rr, rec);
      });
    });
  });
  def(Cache.prototype, "add", function add(request) { return this.addAll([request]); });
  def(Cache.prototype, "addAll", function addAll(requests) {
    var self_ = this;
    var list;
    try { list = __jb.arrayFrom(requests).map(function (r) { return toRequestRec(r); }); } catch (e) { return Promise.reject(e); }
    try { list.forEach(checkPutRequest); } catch (e2) { return Promise.reject(e2); }
    return Promise.all(list.map(function (rr) { return fetch(rr.req); })).then(function (resps) {
      resps.forEach(function (resp) { if (!resp.ok) throw new TypeError("Cache.addAll: a request failed with status " + resp.status); var v = resp.headers.get("vary"); if (v && /(^|,)\s*\*\s*(,|$)/.test(v)) throw new TypeError("Vary: *"); });
      return Promise.all(resps.map(function (r) { return r._collect(); })).then(function (bodies) {
        resps.forEach(function (resp, i) { var rec = SW.responseRecord(resp) || {}; rec.body = bodies[i]; putEntry(cacheRec(self_), list[i], rec); });
      });
    });
  });
  def(Cache.prototype, "delete", function (request, options) {
    var self_ = this;
    return Promise.resolve().then(function () { var c = cacheRec(self_), rr = toRequestRec(request), hit = queryCache(c, rr, options); c.entries = c.entries.filter(function (e) { return hit.indexOf(e) < 0; }); return hit.length > 0; });
  });
  def(Cache.prototype, "keys", function keys(request, options) {
    var self_ = this;
    return Promise.resolve().then(function () { var c = cacheRec(self_); var list = request === undefined ? c.entries.slice() : queryCache(c, toRequestRec(request), options); return list.map(function (e) { return new Request(e.request.url, { method: e.request.method, headers: e.request.headers }); }); });
  });
  var cachesObj = Object.create(CacheStorage.prototype);
  def(CacheStorage.prototype, "open", function open(name) { name = String(name); return Promise.resolve().then(function () { var oc = originCaches(); if (oc.names.indexOf(name) < 0) { oc.names.push(name); oc.map[name] = { entries: [] }; } return cacheObject(name); }); });
  def(CacheStorage.prototype, "has", function has(name) { name = String(name); return Promise.resolve(originCaches().names.indexOf(name) >= 0); });
  def(CacheStorage.prototype, "delete", function (name) { name = String(name); return Promise.resolve().then(function () { var oc = originCaches(), i = oc.names.indexOf(name); if (i < 0) return false; oc.names.splice(i, 1); delete oc.map[name]; return true; }); });
  def(CacheStorage.prototype, "keys", function keys() { return Promise.resolve(originCaches().names.slice()); });
  def(CacheStorage.prototype, "match", function match(request, options) {
    return Promise.resolve().then(function () {
      var oc = originCaches(), names = options && options.cacheName !== undefined ? [String(options.cacheName)].filter(function (n) { return oc.names.indexOf(n) >= 0; }) : oc.names;
      for (var i = 0; i < names.length; i++) { var list = queryCache(oc.map[names[i]], toRequestRec(request), options); if (list.length) return responseFromEntry(list[0]); }
      return undefined;
    });
  });
  [Cache, CacheStorage].forEach(function (C) { Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true }); def(globalThis, C.name, C, false); });

  // ---- URLPattern (patterns parsed natively, components matched with this realm's RegExp) ----
  var COMPONENTS = ["protocol", "username", "password", "hostname", "port", "pathname", "search", "hash"];
  var patternInput = function (input) {
    if (input === undefined || input === null) return {};
    if (typeof input === "string") return input;
    if (typeof input !== "object" && typeof input !== "function") return String(input);
    var out = {};
    COMPONENTS.concat(["baseURL"]).forEach(function (k) { var v = input[k]; if (v !== undefined) out[k] = String(v); });
    return out;
  };
  class URLPattern {
    constructor(input, baseURL, options) {
      if (input === undefined) input = {};
      if (baseURL !== undefined && baseURL !== null && typeof baseURL === "object" && options === undefined) { options = baseURL; baseURL = undefined; }
      var ignoreCase = !!(options && options.ignoreCase);
      var inp = patternInput(input);
      if (typeof inp !== "string" && baseURL !== undefined) throw new TypeError("URLPattern: a baseURL is not allowed with a URLPatternInit");
      var r = __jb.native("urlpattern", { op: "parse", input: inp, baseURL: baseURL === undefined ? undefined : String(baseURL), ignoreCase: ignoreCase });
      if (!r || r.error) throw new TypeError("URLPattern: " + (r && r.error ? r.error : "invalid pattern"));
      var comps = {};
      COMPONENTS.forEach(function (k) {
        var c = r[k];
        var re;
        try { re = new RegExp(c.regexpString, ignoreCase ? "ui" : "u"); } catch (e) { throw new TypeError("URLPattern: invalid " + k + " pattern: " + e.message); }
        comps[k] = { pattern: c.patternString, re: re, groups: c.groupNameList };
      });
      Object.defineProperty(this, "_c", { value: comps });
      Object.defineProperty(this, "_regexpGroups", { value: !!r.hasRegexpGroups });
    }
    test(input, baseURL) { return this._exec(input, baseURL, true) !== null; }
    exec(input, baseURL) { return this._exec(input, baseURL, false); }
    _exec(input, baseURL, testOnly) {
      if (input === undefined) input = {};
      var inp = patternInput(input);
      if (typeof inp !== "string" && baseURL !== undefined) throw new TypeError("URLPattern: a baseURL is not allowed with a URLPatternInit");
      var m = __jb.native("urlpattern", { op: "match", input: inp, baseURL: baseURL === undefined ? undefined : String(baseURL) });
      if (m && m.error) throw new TypeError("URLPattern: " + m.error);
      if (!m) return null;
      var out = { inputs: baseURL === undefined ? [input] : [input, baseURL] };
      for (var i = 0; i < COMPONENTS.length; i++) {
        var k = COMPONENTS[i], c = this._c[k], text = m[k];
        var res = c.re.exec(text);
        if (!res) return null;
        if (testOnly) continue;
        var groups = {};
        c.groups.forEach(function (name, gi) { groups[name] = res[gi + 1]; });
        out[k] = { input: text, groups: groups };
      }
      return testOnly ? true : out;
    }
    get hasRegExpGroups() { return this._regexpGroups; }
  }
  COMPONENTS.forEach(function (k) { Object.defineProperty(URLPattern.prototype, k, { get: function () { return this._c[k].pattern; }, enumerable: true, configurable: true }); });
  Object.defineProperty(URLPattern.prototype, Symbol.toStringTag, { value: "URLPattern", configurable: true });
  def(globalThis, "URLPattern", URLPattern, false);

  // ---- ServiceWorker Static Routing API ----
  var ROUTER_SOURCES = ["network", "cache", "fetch-event", "race-network-and-fetch-handler"];
  var MAX_ROUTER_RULES = 1024;
  // Validate and copy a router condition (this realm's URLPattern for url patterns).
  var routerCondition = function (cond, scriptURL, depth) {
    if (cond === null || typeof cond !== "object") throw new TypeError("addRoutes: a condition must be an object");
    if (depth > 10) throw new TypeError("addRoutes: conditions are nested too deeply");
    var out = {}, any = false;
    if (cond.urlPattern !== undefined) {
      var up = cond.urlPattern;
      if (up instanceof URLPattern) out.urlPattern = up;
      else if (typeof up === "string") out.urlPattern = new URLPattern(up, scriptURL);
      else { var init = patternInput(up); if (init.baseURL === undefined) init.baseURL = scriptURL; out.urlPattern = new URLPattern(init); }
      if (out.urlPattern.hasRegExpGroups) throw new TypeError("addRoutes: URL patterns with regexp groups are not allowed");
      any = true;
    }
    if (cond.requestMethod !== undefined) { out.requestMethod = __jb.normalizeMethod(String(cond.requestMethod)); any = true; }
    if (cond.requestMode !== undefined) { var md = String(cond.requestMode); if (["navigate", "same-origin", "no-cors", "cors"].indexOf(md) < 0) throw new TypeError("addRoutes: invalid requestMode"); out.requestMode = md; any = true; }
    if (cond.requestDestination !== undefined) { out.requestDestination = String(cond.requestDestination); any = true; }
    if (cond.runningStatus !== undefined) { var rs = String(cond.runningStatus); if (rs !== "running" && rs !== "not-running") throw new TypeError("addRoutes: invalid runningStatus"); out.runningStatus = rs; any = true; }
    if (cond.or !== undefined) {
      if (any) throw new TypeError("addRoutes: `or` cannot be combined with other conditions");
      out.or = __jb.arrayFrom(cond.or).map(function (c) { return routerCondition(c, scriptURL, depth + 1); });
      any = true;
    }
    if (cond.not !== undefined) {
      if (any) throw new TypeError("addRoutes: `not` cannot be combined with other conditions");
      out.not = routerCondition(cond.not, scriptURL, depth + 1);
      any = true;
    }
    if (!any) throw new TypeError("addRoutes: a condition needs at least one member");
    return out;
  };
  var routerSource = function (src) {
    if (typeof src === "string") { if (ROUTER_SOURCES.indexOf(src) < 0) throw new TypeError("addRoutes: invalid source '" + src + "'"); return src === "cache" ? { cache: true } : src; }
    if (src && typeof src === "object" && src.cacheName !== undefined) return { cache: true, cacheName: String(src.cacheName) };
    throw new TypeError("addRoutes: invalid source");
  };
  SW.conditionMatches = function (cond, req) {
    if (cond.or) return cond.or.some(function (c) { return SW.conditionMatches(c, req); });
    if (cond.not) return !SW.conditionMatches(cond.not, req);
    if (cond.urlPattern && !cond.urlPattern.test(req.url)) return false;
    if (cond.requestMethod && cond.requestMethod !== (req.method || "GET")) return false;
    if (cond.requestMode && cond.requestMode !== (req.mode || "no-cors")) return false;
    if (cond.requestDestination !== undefined && cond.requestDestination !== (req.destination || "")) return false;
    if (cond.runningStatus && cond.runningStatus !== "running") return false;
    return true;
  };
  SW.routeFor = function (w, req) {
    var rules = w.routes || [];
    for (var i = 0; i < rules.length; i++) {
      var g = w.realm;
      try { if (g.__jb.sw.conditionMatches(rules[i].condition, req)) return rules[i].source; } catch (e) {}
    }
    return null;
  };
  // the cached response for `req` (a response record) or null
  SW.cacheLookup = function (req, cacheName) {
    var oc = originCaches();
    var names = cacheName !== undefined ? [cacheName].filter(function (n) { return oc.names.indexOf(n) >= 0; }) : oc.names;
    var rr = { url: String(req.url).split("#")[0], method: req.method || "GET", headers: req.headers || {} };
    for (var i = 0; i < names.length; i++) { var list = queryCache(oc.map[names[i]], rr, {}); if (list.length) return Object.assign({}, list[0].response); }
    return null;
  };

  [ServiceWorker, ServiceWorkerRegistration, ServiceWorkerContainer, NavigationPreloadManager, Cache, CacheStorage, Clients, Client, WindowClient, ExtendableEvent, FetchEvent, ExtendableMessageEvent, InstallEvent].forEach(function (C) {
    try { Object.defineProperty(C, "prototype", { writable: false, enumerable: false, configurable: false }); } catch (e) {}
  });
  // ---- exposure ----
  // navigator.serviceWorker / caches: real in WPT mode (secure contexts), the inert stub elsewhere.
  var nav = typeof navigator !== "undefined" ? navigator : null;
  var stubSW = nav ? nav.serviceWorker : undefined;
  var stubCaches = globalThis.caches;
  if (nav) Object.defineProperty(nav, "serviceWorker", { get: function () { if (SW.on()) return __jb.isServiceWorker ? undefined : SW.container(); return tjOf().wptMode ? undefined : stubSW; }, enumerable: true, configurable: true });
  Object.defineProperty(globalThis, "caches", { get: function () { return SW.on() ? cachesObj : stubCaches; }, enumerable: true, configurable: true });
  // messages to the page are delivered once the document has loaded (automatic startMessages)
  globalThis.addEventListener("load", function () { try { if (__jb.swContainer) SW.enableMessages(__jb.swContainer); } catch (e) {} });
})();
