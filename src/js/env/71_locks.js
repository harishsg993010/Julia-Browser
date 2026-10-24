// Part 11b: Web Locks API (navigator.locks: LockManager / Lock). The lock state is shared by every
// realm of the session (frames, popups, workers reach it through the top window's __jb), keyed by
// origin; callbacks run as tasks in the requesting realm.
(function () {
  var sharedRoot = function () {
    var j = __jb;
    try { while (j.workerOwnerJb) j = j.workerOwnerJb; } catch (e) {}
    try { return j.topJb(); } catch (e2) { return j; }
  };
  var state = function () {
    var root = sharedRoot();
    if (!root.lockState) root.lockState = { origins: Object.create(null) };
    return root.lockState;
  };
  var myOrigin = function () {
    try { if (typeof __jb.effectiveOrigin === "function" && !__jb.isWorker) { var o = __jb.effectiveOrigin(globalThis); if (typeof o === "string") return o; } } catch (e) {}
    try { return self.origin; } catch (e2) { return "null"; }
  };
  var clientId = function () {
    if (!__jb.clientId) __jb.clientId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
    return __jb.clientId;
  };
  var queueFor = function (origin, name) {
    var st = state(), o = st.origins[origin] || (st.origins[origin] = { held: [], queues: new Map() });
    if (!o.queues.has(name)) o.queues.set(name, []);
    return { o: o, q: o.queues.get(name) };
  };

  class Lock {
    constructor() { throw new TypeError("Illegal constructor"); }
    get name() { if (!this || !this._lk) throw new TypeError("Illegal invocation"); return this._lk.name; }
    get mode() { if (!this || !this._lk) throw new TypeError("Illegal invocation"); return this._lk.mode; }
  }
  var makeLock = function (name, mode) { var l = Object.create(Lock.prototype); Object.defineProperty(l, "_lk", { value: { name: name, mode: mode } }); return l; };

  // grantable: no conflicting held lock and nothing conflicting queued ahead of it
  var grantable = function (o, q, req) {
    var held = o.held.filter(function (h) { return h.name === req.name; });
    if (req.mode === "exclusive") { if (held.length) return false; return q[0] === req || !q.length; }
    if (held.some(function (h) { return h.mode === "exclusive"; })) return false;
    for (var i = 0; i < q.length && q[i] !== req; i++) if (q[i].mode === "exclusive") return false;
    return true;
  };
  // A request or lock dies with its realm (removed or navigated frame, closed worker).
  var alive = function (r) {
    var j = r.jb;
    if (!j) return true;
    try {
      if (j.workerClosed) return false;
      if (j.navApi && j.navApi.fullyActive && !j.navApi.fullyActive()) return false;
      return true;
    } catch (e) { return false; }
  };
  var purge = function (o, q) {
    for (var i = o.held.length - 1; i >= 0; i--) if (!alive(o.held[i].req)) o.held.splice(i, 1);
    for (var k = q.length - 1; k >= 0; k--) if (!alive(q[k])) q.splice(k, 1);
  };
  var polls = Object.create(null);
  var process = function (origin, name) {
    var x = queueFor(origin, name), o = x.o, q = x.q;
    purge(o, q);
    while (q.length && grantable(o, q, q[0])) grant(origin, o, q.shift());
    // a holder in another realm may go away without releasing: look again later
    if (q.length && !polls[origin + "|" + name]) {
      polls[origin + "|" + name] = true;
      setTimeout(function () { polls[origin + "|" + name] = false; process(origin, name); }, 50);
    }
  };
  var grant = function (origin, o, req) {
    var held = { name: req.name, mode: req.mode, clientId: req.clientId, origin: origin, req: req };
    o.held.push(held);
    req.held = held;
    if (req.signal && req.onAbort) req.signal.removeEventListener("abort", req.onAbort);
    req.task(function () {
      if (!alive(req)) return;
      var lock = makeLock(req.name, req.mode), r;
      try { r = req.callback.call(undefined, lock); } catch (e) { r = Promise.reject(e); }
      Promise.resolve(r).then(function (v) { release(origin, held); req.resolve(v); }, function (err) { release(origin, held); req.reject(err); });
    });
  };
  var release = function (origin, held) {
    var x = queueFor(origin, held.name), i = x.o.held.indexOf(held);
    if (i < 0) return; // stolen
    x.o.held.splice(i, 1);
    process(origin, held.name);
  };
  // The lock task queue: requests and queries are handled in order, after the calling task.
  var lockTask = function (fn) { setTimeout(fn, 0); };

  class LockManager {
    constructor() { if (!__jb.lockManagerConstructing) throw new TypeError("Illegal constructor"); }
    request(name, optionsOrCallback, callback) {
      var nargs = arguments.length;
      return new Promise(function (resolve, reject) {
        if (nargs < 2) throw new TypeError("LockManager.request: At least 2 arguments required");
        var options = {};
        if (nargs < 3) { callback = optionsOrCallback; }
        else options = optionsOrCallback === undefined || optionsOrCallback === null ? {} : optionsOrCallback;
        if (typeof callback !== "function") throw new TypeError("LockManager.request: callback is not a function");
        name = String(name);
        var mode = options.mode === undefined ? "exclusive" : String(options.mode);
        if (mode !== "exclusive" && mode !== "shared") throw new TypeError("LockManager.request: '" + mode + "' is not a valid value for enumeration LockMode.");
        var ifAvailable = !!options.ifAvailable, steal = !!options.steal, signal = options.signal;
        if (signal !== undefined && signal !== null && !(signal instanceof AbortSignal)) throw new TypeError("LockManager.request: 'signal' is not an AbortSignal");
        if (__jb.navApi && __jb.navApi.fullyActive && !__jb.navApi.fullyActive()) throw __jb.domError("InvalidStateError", "The document is not fully active");
        var origin = myOrigin();
        if (origin === "null") throw __jb.domError("SecurityError", "Web locks are not available in opaque origins");
        if (name.charAt(0) === "-") throw __jb.domError("NotSupportedError", "Lock names starting with '-' are reserved");
        if (steal && ifAvailable) throw __jb.domError("NotSupportedError", "steal and ifAvailable cannot both be set");
        if (steal && mode !== "exclusive") throw __jb.domError("NotSupportedError", "steal requires an exclusive lock");
        if (signal && (steal || ifAvailable)) throw __jb.domError("NotSupportedError", "signal cannot be combined with steal or ifAvailable");
        if (signal && signal.aborted) { reject(signal.reason); return; }
        var req = { name: name, mode: mode, clientId: clientId(), callback: callback, resolve: resolve, reject: reject, signal: signal || null, jb: __jb, state: "new",
          task: function (fn) { setTimeout(fn, 0); } };
        if (signal) {
          req.onAbort = function () {
            if (req.held) return;
            var q = queueFor(origin, name).q, i = q.indexOf(req);
            if (i >= 0) q.splice(i, 1);
            req.state = "aborted";
            reject(signal.reason);
            if (i >= 0) process(origin, name);
          };
          signal.addEventListener("abort", req.onAbort);
        }
        lockTask(function () {
          if (req.state === "aborted") return;
          var x = queueFor(origin, name), o = x.o, q = x.q;
          purge(o, q);
          if (steal) {
            o.held.filter(function (h) { return h.name === name; }).forEach(function (h) {
              o.held.splice(o.held.indexOf(h), 1);
              h.req.reject(__jb.domError("AbortError", "The lock was stolen"));
            });
            q.unshift(req);
            process(origin, name);
            return;
          }
          if (ifAvailable && (q.length || !grantable(o, [req], req))) {
            req.task(function () {
              var r;
              try { r = callback.call(undefined, null); } catch (e) { reject(e); return; }
              Promise.resolve(r).then(resolve, reject);
            });
            return;
          }
          q.push(req);
          process(origin, name);
        });
      });
    }
    query() {
      return new Promise(function (resolve) {
        if (__jb.navApi && __jb.navApi.fullyActive && !__jb.navApi.fullyActive()) throw __jb.domError("InvalidStateError", "The document is not fully active");
        var origin = myOrigin();
        if (origin === "null") throw __jb.domError("SecurityError", "Web locks are not available in opaque origins");
        lockTask(function () {
          var o = state().origins[origin], held = [], pending = [];
          if (o) {
            o.queues.forEach(function (q) { purge(o, q); });
            o.held.forEach(function (h) { held.push({ name: h.name, mode: h.mode, clientId: h.clientId }); });
            o.queues.forEach(function (q) { q.forEach(function (r) { pending.push({ name: r.name, mode: r.mode, clientId: r.clientId }); }); });
          }
          resolve({ held: held, pending: pending });
        });
      });
    }
  }
  __jb.lockManagerConstructing = true;
  var manager;
  try { manager = new LockManager(); } finally { __jb.lockManagerConstructing = false; }
  __jb.lockManager = manager;
  if (typeof navigator !== "undefined" && navigator) {
    try { Object.defineProperty(navigator, "locks", { get: function () { return manager; }, enumerable: true, configurable: true }); } catch (e) {}
  }
  globalThis.Lock = Lock;
  globalThis.LockManager = LockManager;
})();
