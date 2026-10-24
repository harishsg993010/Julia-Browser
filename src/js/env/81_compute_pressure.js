// Part 18: Compute Pressure (PressureObserver, PressureRecord). There is no platform collector:
// readings come from WebDriver virtual pressure sources (testdriver create/update/remove), and
// without one observe() rejects with NotSupportedError.
(function () {
  var dom = function (n, m) { return __jb.domError(n, m); };
  var SOURCES = ["cpu"], STATES = ["nominal", "fair", "serious", "critical"];
  var topJb = function () { try { var j = __jb; while (j.workerOwnerJb) j = j.workerOwnerJb; return j.topJb ? j.topJb() : j; } catch (e) { return __jb; } };
  var virtual = function (src) { var t = topJb(); return t.virtualPressure ? t.virtualPressure[src] : undefined; };
  var fullyActive = function () { try { return !(__jb.navApi && __jb.navApi.fullyActive) || __jb.navApi.fullyActive(); } catch (e) { return true; } };
  var policyAllows = function () { try { return !__jb.permissionsPolicyAllows || __jb.permissionsPolicyAllows("compute-pressure"); } catch (e) { return true; } };
  // observers of every realm (windows, workers) share one list: readings arrive in the window
  // realm that runs the test driver
  var shared = function () { var t = topJb(); return t.pressureObservers || (t.pressureObservers = []); };
  var known = Object.freeze(SOURCES.slice());

  class PressureRecord {
    constructor() { throw new TypeError("Illegal constructor"); }
    get source() { return this._r.source; }
    get state() { return this._r.state; }
    get time() { return this._r.time; }
    toJSON() { return { source: this._r.source, state: this._r.state, time: this._r.time }; }
  }
  var makeRecord = function (source, state) { var r = Object.create(PressureRecord.prototype); Object.defineProperty(r, "_r", { value: { source: source, state: state, time: performance.now() } }); return r; };

  class PressureObserver {
    constructor(callback) {
      if (arguments.length < 1) throw new TypeError("PressureObserver constructor: 1 argument required");
      if (typeof callback !== "function") throw new TypeError("PressureObserver constructor: Argument 1 is not callable");
      Object.defineProperty(this, "_p", { value: { cb: callback, active: new Map(), last: new Map(), queue: [], pending: new Map(), lastTime: new Map() } });
    }
    static get knownSources() { return known; }
    observe(source, options) {
      var p = this._p, self = this;
      return new Promise(function (resolve, reject) {
        if (arguments.length === 0 && source === undefined) {}
        source = String(source);
        if (SOURCES.indexOf(source) < 0) throw new TypeError("PressureObserver.observe: '" + source + "' is not a valid value for enumeration PressureSource.");
        var interval = 0;
        if (options && options.sampleInterval !== undefined) {
          interval = Number(options.sampleInterval);
          if (!isFinite(interval) || interval < 0 || interval > 4294967295) throw new TypeError("PressureObserver.observe: sampleInterval is out of range");
          interval = Math.trunc(interval);
        }
        if (!fullyActive()) throw dom("NotAllowedError", "The document is not fully active");
        if (!policyAllows()) throw dom("NotAllowedError", "compute-pressure is disabled by permissions policy");
        var prev = p.pending.get(source);
        if (prev) prev.reject(dom("AbortError", "observe() was called again"));
        var entry = { resolve: resolve, reject: reject };
        p.pending.set(source, entry);
        setTimeout(function () {
          if (p.pending.get(source) !== entry) return;
          p.pending.delete(source);
          var v = virtual(source);
          if (!v || v.supported === false) { reject(dom("NotSupportedError", "The pressure source is not available")); return; }
          p.active.set(source, interval);
          if (!shared().some(function (e) { return e.obs === self; })) shared().push({ obs: self, deliver: deliver });
          resolve(undefined);
          // the source's current reading, if any
          if (v.sample) deliver(self, source, v.sample);
        }, 0);
      });
    }
    unobserve(source) {
      if (arguments.length < 1) throw new TypeError("PressureObserver.unobserve: 1 argument required");
      source = String(source);
      if (SOURCES.indexOf(source) < 0) throw new TypeError("PressureObserver.unobserve: '" + source + "' is not a valid value for enumeration PressureSource.");
      var p = this._p, pend = p.pending.get(source);
      if (pend) { p.pending.delete(source); pend.reject(dom("AbortError", "unobserve() was called")); }
      p.active.delete(source); p.last.delete(source); p.lastTime.delete(source);
      p.queue = p.queue.filter(function (r) { return r._r.source !== source; });
      if (!p.active.size) { var self1 = this, l1 = shared(); for (var i = l1.length - 1; i >= 0; i--) if (l1[i].obs === self1) l1.splice(i, 1); }
    }
    disconnect() {
      var p = this._p;
      p.pending.forEach(function (pend) { pend.reject(dom("AbortError", "disconnect() was called")); });
      p.pending.clear(); p.active.clear(); p.last.clear(); p.lastTime.clear(); p.queue = [];
      var self2 = this, l2 = shared(); for (var j = l2.length - 1; j >= 0; j--) if (l2[j].obs === self2) l2.splice(j, 1);
    }
    takeRecords() { var q = this._p.queue; this._p.queue = []; return q; }
  }
  var deliver = function (obs, source, state) {
    var p = obs._p;
    if (!p.active.has(source)) return;
    try { if (document.visibilityState === "hidden") return; } catch (e) {}
    var interval = p.active.get(source), lt = p.lastTime.get(source), now = performance.now();
    if (interval && lt !== undefined && now - lt < interval) return;
    var last = p.last.get(source);
    if (last && last._r.state === state) return; // no change in data
    var rec = makeRecord(source, state);
    p.last.set(source, rec); p.lastTime.set(source, now);
    p.queue.push(rec);
    if (p.queue.length === 1) setTimeout(function () {
      if (!p.queue.length) return;
      var records = p.queue; p.queue = [];
      try { p.cb.call(undefined, records, obs); } catch (e) { if (__jb.reportException) __jb.reportException(e); }
    }, 0);
  };
  // WebDriver: a virtual source got a new reading
  __jb.virtualPressureUpdate = function (type, sample) {
    if (STATES.indexOf(String(sample)) < 0) return;
    shared().slice().forEach(function (e) { try { e.deliver(e.obs, type, String(sample)); } catch (x) {} });
  };
  [PressureObserver, PressureRecord].forEach(function (C) {
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
    globalThis[C.name] = C;
  });
})();
