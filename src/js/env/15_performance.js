// Part 1b: High Resolution Time, Performance Timeline, User Timing L3,
// Resource/Navigation Timing entries and the console namespace. Loaded after
// the event classes so `Performance` can be an EventTarget; replaces the early
// stubs of 00_core.js.

class PerformanceEntry {
  constructor(name, entryType, startTime, duration) {
    if (new.target === PerformanceEntry) throw new TypeError("Illegal constructor");
    Object.defineProperty(this, "_name", { value: String(name), writable: true });
    Object.defineProperty(this, "_entryType", { value: entryType, writable: true });
    Object.defineProperty(this, "_startTime", { value: startTime, writable: true });
    Object.defineProperty(this, "_duration", { value: duration, writable: true });
  }
  get name() { return this._name; }
  get entryType() { return this._entryType; }
  get startTime() { return this._startTime; }
  get duration() { return this._duration; }
  toJSON() { return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration }; }
}
// User Timing: mark options must be a dictionary; a negative startTime or an unclonable detail is rejected.
__jb.perfOptions = function (options, what) {
  if (options === undefined || options === null) return {};
  if (typeof options !== "object" && typeof options !== "function") throw new TypeError(what + ": options must be a dictionary");
  return options;
};
__jb.perfDetail = function (detail) { return detail === undefined || detail === null ? null : structuredClone(detail); };
class PerformanceMark extends PerformanceEntry {
  constructor(name, options) {
    if (arguments.length < 1) throw new TypeError("PerformanceMark constructor: At least 1 argument required, but only 0 passed");
    name = String(name);
    var opts = __jb.perfOptions(options, "PerformanceMark");
    if (typeof PerformanceTiming !== "undefined" && name in PerformanceTiming.prototype) throw __jb.domError("SyntaxError", "'" + name + "' is a PerformanceTiming attribute name");
    var startTime = opts.startTime === undefined ? performance.now() : Number(opts.startTime);
    if (!Number.isFinite(startTime) && opts.startTime !== undefined) throw new TypeError("startTime must be a finite number");
    if (startTime < 0) throw new TypeError("startTime cannot be negative");
    super(name, "mark", startTime, 0);
    Object.defineProperty(this, "_detail", { value: __jb.perfDetail(opts.detail) });
  }
  get detail() { return this._detail; }
}
class PerformanceMeasure extends PerformanceEntry {
  constructor(name, startTime, duration, detail, token) {
    if (token !== __jb.PERF_TOKEN) throw new TypeError("Illegal constructor");
    super(name, "measure", startTime, duration);
    Object.defineProperty(this, "_detail", { value: detail });
  }
  get detail() { return this._detail; }
}
__jb.PERF_TOKEN = {};
class PerformanceResourceTiming extends PerformanceEntry {
  constructor(token, url, initiatorType, start, end, sizes, status, mime) {
    if (token !== __jb.PERF_TOKEN) throw new TypeError("Illegal constructor");
    super(url, "resource", start, Math.max(0, end - start));
    var f = {}; Object.defineProperty(this, "_rt", { value: f });
    f.initiatorType = initiatorType; f.nextHopProtocol = "http/1.1"; f.deliveryType = "";
    f.workerStart = 0; f.redirectStart = 0; f.redirectEnd = 0; f.fetchStart = start; f.domainLookupStart = start; f.domainLookupEnd = start;
    f.connectStart = start; f.secureConnectionStart = 0; f.connectEnd = start; f.requestStart = start; f.responseStart = end; f.firstInterimResponseStart = 0; f.responseEnd = end;
    f.transferSize = sizes && sizes.transfer !== undefined ? sizes.transfer : 0; f.encodedBodySize = sizes && sizes.encoded !== undefined ? sizes.encoded : 0; f.decodedBodySize = sizes && sizes.decoded !== undefined ? sizes.decoded : 0;
    f.responseStatus = status || 0; f.contentType = mime || ""; f.renderBlockingStatus = "non-blocking"; f.serverTiming = [];
  }
  toJSON() { var o = PerformanceEntry.prototype.toJSON.call(this); var self_ = this; __jb.RT_ATTRS.forEach(function (k) { if (k !== "serverTiming") o[k] = self_[k]; }); return o; }
}
class PerformanceNavigationTiming extends PerformanceResourceTiming {
  constructor(token, url) {
    if (token !== __jb.PERF_TOKEN) throw new TypeError("Illegal constructor");
    super(token, url, "navigation", 0, 0, { transfer: 0, encoded: 0, decoded: 0 }, 200, "text/html");
    this._entryType = "navigation";
    var f = this._rt;
    f.unloadEventStart = 0; f.unloadEventEnd = 0; f.domInteractive = 0; f.domContentLoadedEventStart = 0; f.domContentLoadedEventEnd = 0; f.domComplete = 0; f.loadEventStart = 0; f.loadEventEnd = 0;
    f.type = "navigate"; f.redirectCount = 0; f.activationStart = 0; f.criticalCHRestart = 0; f.notRestoredReasons = null;
  }
  get duration() { return this._rt.loadEventEnd; }
}
// IDL attributes: getters on the prototypes reading the entry's slot
__jb.RT_ATTRS = ["initiatorType", "nextHopProtocol", "deliveryType", "workerStart", "redirectStart", "redirectEnd", "fetchStart", "domainLookupStart", "domainLookupEnd", "connectStart", "secureConnectionStart", "connectEnd", "requestStart", "responseStart", "firstInterimResponseStart", "finalResponseHeadersStart", "responseEnd", "transferSize", "encodedBodySize", "decodedBodySize", "responseStatus", "contentType", "contentEncoding", "renderBlockingStatus", "serverTiming", "initiatorUrl", "workerRouterEvaluationStart", "workerCacheLookupStart", "workerMatchedRouterSource", "workerFinalRouterSource"];
__jb.RT_ATTRS.forEach(function (k) { Object.defineProperty(PerformanceResourceTiming.prototype, k, { get: function () { var f = this && this._rt; if (!f) throw new TypeError("Illegal invocation"); return f[k] === undefined ? (k === "contentEncoding" || k === "workerMatchedRouterSource" || k === "workerFinalRouterSource" ? "" : k === "finalResponseHeadersStart" || k === "workerRouterEvaluationStart" || k === "workerCacheLookupStart" ? 0 : f[k]) : f[k]; }, enumerable: true, configurable: true }); });
["unloadEventStart", "unloadEventEnd", "domInteractive", "domContentLoadedEventStart", "domContentLoadedEventEnd", "domComplete", "loadEventStart", "loadEventEnd", "type", "redirectCount", "activationStart", "criticalCHRestart", "notRestoredReasons"].forEach(function (k) { Object.defineProperty(PerformanceNavigationTiming.prototype, k, { get: function () { var f = this && this._rt; if (!f) throw new TypeError("Illegal invocation"); return f[k]; }, enumerable: true, configurable: true }); });
class PerformanceObserverEntryList {
  constructor(entries) { Object.defineProperty(this, "_entries", { value: entries.slice() }); }
  getEntries() { return this._entries.slice(); }
  getEntriesByType(type) { type = String(type); return this._entries.filter(function (e) { return e.entryType === type; }); }
  getEntriesByName(name, type) { name = String(name); var t = type === undefined ? undefined : String(type); return this._entries.filter(function (e) { return e.name === name && (t === undefined || e.entryType === t); }); }
}
// ---- the timeline: one global buffer per entry type, observers, and the queue that delivers to them ----
__jb.perf = {
  buffers: { mark: [], measure: [], resource: [], navigation: [] },
  resourceBufferSize: 250, resourceBufferFullPending: false, dropped: { resource: 0 },
  observers: [], pending: false,
  supported: ["mark", "measure", "navigation", "resource"],
  add: function (entry) {
    var type = entry.entryType;
    if (type === "resource") {
      if (this.buffers.resource.length >= this.resourceBufferSize) {
        this.dropped.resource++;
        if (!this.resourceBufferFullPending) { this.resourceBufferFullPending = true; var self_ = this; __jb.queueTask(function () { self_.resourceBufferFullPending = false; performance.dispatchEvent(new Event("resourcetimingbufferfull")); }); }
      } else this.buffers.resource.push(entry);
    } else if (this.buffers[type]) this.buffers[type].push(entry);
    this.observers.forEach(function (o) { if (o._observes(type, entry)) { o._queue.push(entry); } });
    this.schedule();
  },
  schedule: function () {
    if (this.pending) return;
    this.pending = true;
    var self_ = this;
    __jb.queueTask(function () {
      self_.pending = false;
      self_.observers.slice().forEach(function (o) {
        if (!o._queue.length) return;
        var entries = o._queue.splice(0).sort(function (a, b) { return a.startTime - b.startTime; });
        var options = {};
        if (o._requiresDropped) { o._requiresDropped = false; var n = 0; o._types.forEach(function (t) { n += self_.dropped[t] || 0; }); options.droppedEntriesCount = n; }
        try { __jb.loafRun("user-callback", "PerformanceObserverCallback", o._cb, o, [new PerformanceObserverEntryList(entries), o, options]); } catch (e) { __jb.reportError(String(e && e.message ? e.message : e)); }
      });
    });
  },
  all: function () { var out = []; for (var k in this.buffers) out = out.concat(this.buffers[k]); return out.sort(function (a, b) { return a.startTime - b.startTime; }); },
};
__jb.queueTask = __jb.queueTask || function (fn) { setTimeout(fn, 0); };
class PerformanceObserver {
  constructor(cb) {
    if (typeof cb !== "function") throw new TypeError("PerformanceObserver constructor: Argument 1 is not callable.");
    Object.defineProperty(this, "_cb", { value: cb });
    Object.defineProperty(this, "_queue", { value: [] });
    Object.defineProperty(this, "_types", { value: [], writable: true });
    Object.defineProperty(this, "_mode", { value: null, writable: true });
    Object.defineProperty(this, "_requiresDropped", { value: false, writable: true });
    Object.defineProperty(this, "_durationThreshold", { value: 104, writable: true });
  }
  static get supportedEntryTypes() { return __jb.perf.supported.slice(); }
  _observes(type, entry) { if (this._types.indexOf(type) < 0) return false; return !(type === "event" && entry.duration < this._durationThreshold); }
  observe(options) {
    options = options === undefined ? {} : options;
    if (options === null || typeof options !== "object") throw new TypeError("PerformanceObserver.observe: options must be a dictionary");
    var hasTypes = options.entryTypes !== undefined, hasType = options.type !== undefined;
    if (!hasTypes && !hasType) throw new TypeError("PerformanceObserver.observe: either entryTypes or type must be given");
    if (hasTypes && (options.entryTypes === null || typeof options.entryTypes !== "object" || typeof options.entryTypes[Symbol.iterator] !== "function")) throw new TypeError("PerformanceObserver.observe: entryTypes must be a sequence");
    this._requiresDropped = true;
    if (hasTypes && (hasType || options.durationThreshold !== undefined)) throw new TypeError("PerformanceObserver.observe: entryTypes cannot be combined with type, buffered or durationThreshold");
    var self_ = this;
    if (hasTypes) {
      if (this._mode === "single") throw __jb.domError("InvalidModificationError", "This observer already observes a single type");
      var types = __jb.arrayFrom(options.entryTypes, String).filter(function (t) { return __jb.perf.supported.indexOf(t) >= 0; });
      if (!types.length) { console.warn("PerformanceObserver.observe: no supported entry types"); return; }
      this._mode = "multiple"; this._types = types;
    } else {
      if (this._mode === "multiple") throw __jb.domError("InvalidModificationError", "This observer already observes multiple types");
      var t = String(options.type);
      if (__jb.perf.supported.indexOf(t) < 0) { console.warn("PerformanceObserver.observe: unsupported entry type " + t); return; }
      this._mode = "single";
      if (this._types.indexOf(t) < 0) this._types.push(t);
      if (options.durationThreshold !== undefined) this._durationThreshold = Math.max(16, Number(options.durationThreshold) || 0);
      if (options.buffered) {
        (__jb.perf.buffers[t] || []).forEach(function (e) { if (self_._queue.indexOf(e) < 0) self_._queue.push(e); });
        __jb.perf.schedule();
      }
    }
    if (__jb.perf.observers.indexOf(this) < 0) __jb.perf.observers.push(this);
  }
  disconnect() { var i = __jb.perf.observers.indexOf(this); if (i >= 0) __jb.perf.observers.splice(i, 1); this._queue.length = 0; this._types = []; this._mode = null; }
  takeRecords() { return this._queue.splice(0).sort(function (a, b) { return a.startTime - b.startTime; }); }
}
class EventCounts { constructor() { Object.defineProperty(this, "_m", { value: new Map() }); } get size() { return this._m.size; } get(k) { return this._m.get(k); } has(k) { return this._m.has(k); } keys() { return this._m.keys(); } values() { return this._m.values(); } entries() { return this._m.entries(); } forEach(f, t) { this._m.forEach(f, t); } [Symbol.iterator]() { return this._m.entries(); } }
class PerformanceTiming {
  constructor(token) { if (token !== __jb.PERF_TOKEN) throw new TypeError("Illegal constructor"); }
  toJSON() { var o = {}; for (var k of PerformanceTiming._keys) o[k] = this[k]; return o; }
}
PerformanceTiming._keys = ["navigationStart", "unloadEventStart", "unloadEventEnd", "redirectStart", "redirectEnd", "fetchStart", "domainLookupStart", "domainLookupEnd", "connectStart", "connectEnd", "secureConnectionStart", "requestStart", "responseStart", "responseEnd", "domLoading", "domInteractive", "domContentLoadedEventStart", "domContentLoadedEventEnd", "domComplete", "loadEventStart", "loadEventEnd"];
PerformanceTiming._keys.forEach(function (k) {
  Object.defineProperty(PerformanceTiming.prototype, k, { get: function () { var t = __jb.perf.timing; if (k === "navigationStart") return t.origin; return t.marks[k] === undefined ? 0 : t.origin + t.marks[k]; }, enumerable: true, configurable: true });
});
class PerformanceNavigation {
  constructor(token) { if (token !== __jb.PERF_TOKEN) throw new TypeError("Illegal constructor"); }
  get type() { return 0; } get redirectCount() { return 0; }
  toJSON() { return { type: 0, redirectCount: 0 }; }
}
PerformanceNavigation.TYPE_NAVIGATE = 0; PerformanceNavigation.TYPE_RELOAD = 1; PerformanceNavigation.TYPE_BACK_FORWARD = 2; PerformanceNavigation.TYPE_RESERVED = 255;
class Performance extends EventTarget {
  constructor(token) {
    if (token !== __jb.PERF_TOKEN) throw new TypeError("Illegal constructor");
    super();
    Object.defineProperty(this, "_timeOrigin", { value: Date.now() });
    Object.defineProperty(this, "timing", { value: new PerformanceTiming(__jb.PERF_TOKEN), enumerable: true });
    Object.defineProperty(this, "navigation", { value: new PerformanceNavigation(__jb.PERF_TOKEN), enumerable: true });
    Object.defineProperty(this, "memory", { value: { usedJSHeapSize: 10000000, totalJSHeapSize: 20000000, jsHeapSizeLimit: 2000000000 }, enumerable: false });
    Object.defineProperty(this, "eventCounts", { value: new EventCounts(), enumerable: true });
  }
  get timeOrigin() { return this._timeOrigin; }
  now() { var n = __jb.native("elapsed"); return (typeof n === "number" ? n : 0) + __jb.clock; }
  toJSON() { return { timeOrigin: this.timeOrigin, timing: this.timing.toJSON(), navigation: this.navigation.toJSON() }; }
  mark(name, options) {
    if (arguments.length < 1) throw new TypeError("Performance.mark: At least 1 argument required, but only 0 passed");
    var entry = new PerformanceMark(name, options);
    __jb.perf.add(entry);
    return entry;
  }
  clearMarks(name) { this._clear("mark", name); }
  clearMeasures(name) { this._clear("measure", name); }
  _clear(type, name) { var b = __jb.perf.buffers[type]; if (name === undefined) { b.length = 0; return; } name = String(name); for (var i = b.length - 1; i >= 0; i--) if (b[i].name === name) b.splice(i, 1); }
  // A mark name, a PerformanceTiming attribute or a number, as User Timing "convert a mark to a timestamp".
  _markTime(mark, endMark) {
    if (typeof mark === "number") { if (mark < 0) throw new TypeError("Mark timestamps cannot be negative"); return mark; }
    mark = String(mark);
    if (typeof PerformanceTiming !== "undefined" && mark in PerformanceTiming.prototype) { var v = this.timing[mark]; if (v === 0) throw __jb.domError("InvalidAccessError", "'" + mark + "' has no value yet"); return v - this.timeOrigin; }
    var marks = __jb.perf.buffers.mark, last = null;
    for (var i = 0; i < marks.length; i++) if (marks[i].name === mark) last = marks[i];
    if (!last) throw __jb.domError("SyntaxError", "The mark '" + mark + "' does not exist.");
    return last.startTime;
  }
  measure(name, startOrOptions, endMark) {
    if (arguments.length < 1) throw new TypeError("Performance.measure: At least 1 argument required, but only 0 passed");
    name = String(name);
    var start, end, detail = null;
    var isDict = startOrOptions !== undefined && startOrOptions !== null && typeof startOrOptions === "object";
    var o = isDict ? startOrOptions : null;
    if (isDict && (o.start !== undefined || o.end !== undefined || o.duration !== undefined || o.detail !== undefined)) {
      if (endMark !== undefined) throw new TypeError("Performance.measure: an end mark cannot be given together with an options dictionary");
      var hasStart = o.start !== undefined, hasEnd = o.end !== undefined, hasDuration = o.duration !== undefined;
      if (!hasStart && !hasEnd) throw new TypeError("Performance.measure: start or end must be given with measure options");
      if (hasStart && hasEnd && hasDuration) throw new TypeError("Performance.measure: start, end and duration cannot all be given");
      end = hasEnd ? this._markTime(o.end) : (hasStart && hasDuration ? this._markTime(o.start) + Number(o.duration) : this.now());
      start = hasStart ? this._markTime(o.start) : (hasEnd && hasDuration ? end - Number(o.duration) : 0);
      detail = __jb.perfDetail(o.detail);
    } else {
      start = startOrOptions === undefined || startOrOptions === null || isDict ? 0 : this._markTime(startOrOptions);
      end = endMark === undefined ? this.now() : this._markTime(endMark);
    }
    var entry = new PerformanceMeasure(name, start, end - start, detail, __jb.PERF_TOKEN);
    __jb.perf.add(entry);
    return entry;
  }
  getEntries() { return __jb.perf.all(); }
  getEntriesByType(type) { type = String(type); return __jb.perf.all().filter(function (e) { return e.entryType === type; }); }
  getEntriesByName(name, type) { name = String(name); var t = type === undefined ? undefined : String(type); return __jb.perf.all().filter(function (e) { return e.name === name && (t === undefined || e.entryType === t); }); }
  clearResourceTimings() { __jb.perf.buffers.resource.length = 0; }
  setResourceTimingBufferSize(n) { if (!arguments.length) throw new TypeError("setResourceTimingBufferSize: 1 argument required"); __jb.perf.resourceBufferSize = Math.max(0, Number(n) >>> 0); }
  // Timestamps for the legacy `timing` object and the navigation entry, in ms since timeOrigin.
  _stamp(name) { var t = __jb.perf.timing; if (t.marks[name] === undefined) t.marks[name] = this.now(); var nav = __jb.perf.buffers.navigation[0]; if (nav && nav._rt && name in nav) nav._rt[name] = t.marks[name]; }
  _addResource(url, initiatorType, start, end, sizes, status, mime) { var e = new PerformanceResourceTiming(__jb.PERF_TOKEN, String(url), initiatorType, start, end, sizes, status, mime); __jb.perf.add(e); return e; }
  _startNavigation(url) { __jb.perf.buffers.navigation.length = 0; var e = new PerformanceNavigationTiming(__jb.PERF_TOKEN, String(url)); __jb.perf.buffers.navigation.push(e); __jb.perf.timing = { origin: this.timeOrigin, marks: {} }; return e; }
}
__jb.perf.timing = { origin: Date.now(), marks: {} };
globalThis.performance = new Performance(__jb.PERF_TOKEN);
__jb.perf.timing.origin = performance.timeOrigin;
performance._startNavigation(typeof location !== "undefined" && location.href ? location.href : "about:blank");
["fetchStart", "domainLookupStart", "domainLookupEnd", "connectStart", "connectEnd", "requestStart", "responseStart", "responseEnd", "domLoading"].forEach(function (k) { performance._stamp(k); });
globalThis.performance = performance;
[PerformanceEntry, PerformanceMark, PerformanceMeasure, PerformanceResourceTiming, PerformanceNavigationTiming, PerformanceObserverEntryList, PerformanceObserver, PerformanceTiming, PerformanceNavigation, Performance, EventCounts].forEach(function (C) { globalThis[C.name] = C; });

// ---- console: a WebIDL namespace (non-enumerable global, empty prototype, @@toStringTag) ----
(function () {
  var counts = new Map(), timers = new Map(), groupDepth = 0;
  var proto = Object.create(Object.prototype);
  var ns = Object.create(proto);
  var indent = function () { return groupDepth ? new Array(groupDepth + 1).join("  ") : ""; };
  var log = function (level, args) { var a = Array.prototype.slice.call(args); if (groupDepth && a.length && typeof a[0] === "string") a[0] = indent() + a[0]; __jb.log(level, a); };
  var label = function (v) { return v === undefined ? "default" : String(v); };
  var methods = {
    assert: function (condition) { if (condition) return; var rest = Array.prototype.slice.call(arguments, 1); if (!rest.length) rest = ["Assertion failed"]; else if (typeof rest[0] === "string") rest[0] = "Assertion failed: " + rest[0]; else rest.unshift("Assertion failed:"); log("error", rest); },
    clear: function () {},
    debug: function () { log("debug", arguments); },
    error: function () { log("error", arguments); },
    info: function () { log("info", arguments); },
    log: function () { log("log", arguments); },
    table: function (data) { log("log", [data]); },
    trace: function () { log("trace", arguments); },
    warn: function () { log("warn", arguments); },
    dir: function (item) { log("log", [item]); },
    dirxml: function () { log("log", arguments); },
    count: function (l) { l = label(l); var n = (counts.get(l) || 0) + 1; counts.set(l, n); log("info", [l + ": " + n]); },
    countReset: function (l) { l = label(l); if (counts.has(l)) counts.set(l, 0); else log("warn", ["Counter \"" + l + "\" doesn't exist"]); },
    group: function () { if (arguments.length) log("log", arguments); groupDepth++; },
    groupCollapsed: function () { if (arguments.length) log("log", arguments); groupDepth++; },
    groupEnd: function () { if (groupDepth) groupDepth--; },
    time: function (l) { l = label(l); if (timers.has(l)) { log("warn", ["Timer \"" + l + "\" already exists"]); return; } timers.set(l, performance.now()); },
    timeLog: function (l) { l = label(l); if (!timers.has(l)) { log("warn", ["Timer \"" + l + "\" doesn't exist"]); return; } var rest = Array.prototype.slice.call(arguments, 1); log("log", [l + ": " + (performance.now() - timers.get(l)).toFixed(3) + " ms"].concat(rest)); },
    timeEnd: function (l) { l = label(l); if (!timers.has(l)) { log("warn", ["Timer \"" + l + "\" doesn't exist"]); return; } log("info", [l + ": " + (performance.now() - timers.get(l)).toFixed(3) + " ms"]); timers.delete(l); },
    timeStamp: function () {},
    profile: function () {}, profileEnd: function () {},
  };
  Object.keys(methods).forEach(function (k) { Object.defineProperty(ns, k, { value: methods[k], writable: true, enumerable: true, configurable: true }); });
  Object.defineProperty(ns, Symbol.toStringTag, { value: "console", writable: false, enumerable: false, configurable: true });
  Object.defineProperty(globalThis, "console", { value: ns, writable: true, enumerable: false, configurable: true });
})();

// Date on the virtual clock (real pages; mod.rs calls this before the page's scripts): Date.now()
// and new Date() add the time the timer clock skipped, like performance.now().
__jb.installVirtualDate = function () {
  var NativeDate = globalThis.Date;
  if (NativeDate.__jbVirtual === true) return;
  var realNow = NativeDate.now;
  var now = function now() { return realNow() + Math.floor(__jb.clock || 0); };
  var VDate = function Date(year, monthIndex, day, hours, minutes, seconds, ms) {
    if (new.target === undefined) return new NativeDate(now()).toString();
    var args = arguments.length === 0 ? [now()] : Array.prototype.slice.call(arguments);
    return Reflect.construct(NativeDate, args, new.target === VDate ? NativeDate : new.target);
  };
  Object.defineProperty(VDate, "prototype", { value: NativeDate.prototype, writable: false, enumerable: false, configurable: false });
  Object.defineProperty(VDate, "now", { value: now, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(VDate, "parse", { value: NativeDate.parse, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(VDate, "UTC", { value: NativeDate.UTC, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(VDate, "__jbVirtual", { value: true });
  Object.defineProperty(NativeDate.prototype, "constructor", { value: VDate, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(globalThis, "Date", { value: VDate, writable: true, enumerable: false, configurable: true });
  if (typeof __jb.markNative === "function") { __jb.markNative(VDate); __jb.markNative(now); }
};
