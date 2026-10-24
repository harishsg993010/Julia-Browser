// Julia Browser - browser environment for SpiderMonkey (part 1: core utilities)
// Runs in a bare SpiderMonkey global; `__jb_native(op, json)` is the Rust bridge.
"use strict";
// [LegacyUnforgeable] window, [Replaceable] self (accessors, as WebIDL has them).
// Worker globals (created with __jb_workerRealm set) have no window; the environment itself
// uses globalThis.
if (!globalThis.__jb_workerRealm) Object.defineProperty(globalThis, "window", { get: function () { return globalThis; }, enumerable: true, configurable: false });
Object.defineProperty(globalThis, "self", { get: function () { return globalThis; }, set: function (v) { Object.defineProperty(globalThis, "self", { value: v, writable: true, enumerable: true, configurable: true }); }, enumerable: true, configurable: true });
var __jb = globalThis.__jb || {};
globalThis.__jb = __jb;
// Builtins captured before page scripts run (Prototype.js replaces them; see hostJson).
__jb.A = { from: Array.from, map: Array.prototype.map, filter: Array.prototype.filter, some: Array.prototype.some, every: Array.prototype.every, reduce: Array.prototype.reduce };
// Object.defineProperty as the environment found it (pages wrap it; hot constructors use this).
__jb.dp = Object.defineProperty;
__jb.arrayFrom = function (items, mapFn, thisArg) { return arguments.length > 1 ? __jb.A.from.call(Array, items, mapFn, thisArg) : __jb.A.from.call(Array, items); };
// JSON for the host bridge and other internal serialization: Prototype.js 1.6 defines toJSON on
// Array/String/Number/Boolean.prototype (strings serialize as quoted literals, arrays as strings),
// so those page-added methods are set aside while the environment serializes.
(function () {
  var stringify = JSON.stringify, nativeDateToJSON = Date.prototype.toJSON, gopd = Object.getOwnPropertyDescriptor, dp = Object.defineProperty, has = Object.prototype.hasOwnProperty;
  var protos = [Array.prototype, String.prototype, Number.prototype, Boolean.prototype, Object.prototype, Date.prototype];
  __jb.hostJson = function (value, replacer, space) {
    var saved = null;
    for (var i = 0; i < protos.length; i++) {
      var p = protos[i];
      if (!has.call(p, "toJSON") || (p === Date.prototype && p.toJSON === nativeDateToJSON)) continue;
      var d = gopd(p, "toJSON");
      if (!d || !d.configurable) continue;
      (saved || (saved = [])).push([p, d]);
      if (p === Date.prototype) dp(p, "toJSON", { value: nativeDateToJSON, writable: true, configurable: true });
      else delete p.toJSON;
    }
    if (saved === null) return stringify(value, replacer, space);
    try { return stringify(value, replacer, space); }
    finally { for (var j = 0; j < saved.length; j++) dp(saved[j][0], "toJSON", saved[j][1]); }
  };
})();

// HTML "import.meta.resolve(specifier)": resolves against the module's URL and the import map.
__jb.installImportMetaResolve = function (meta) {
  var base = meta.url;
  Object.defineProperty(meta, "resolve", {
    value: function resolve(specifier) {
      var r = __jb.native("resolveModule", { spec: String(specifier), base: base });
      if (typeof r !== "string") throw new TypeError("Failed to resolve module specifier " + String(specifier));
      return r;
    },
    writable: true, enumerable: true, configurable: true,
  });
};
// Requests of this realm carry its referrer source and policy unless the caller gave them.
__jb.REFERRER_OPS = { fetch: true, image: true, imageStart: true, media: true };
__jb.native = function (op, payload) {
  if (__jb.REFERRER_OPS[op] === true && payload && typeof payload === "object" && payload.referrer === undefined && typeof __jb.requestReferrer === "function") {
    try { var rr = __jb.requestReferrer(payload.referrerPolicy); payload.referrer = rr.referrer; payload.referrerPolicy = rr.referrerPolicy; } catch (e) {}
  }
  try {
    var raw = __jb_native(op, __jb.hostJson(payload === undefined ? null : payload));
    return raw === undefined || raw === "" ? null : JSON.parse(raw);
  } catch (e) {
    return null;
  }
};

__jb.log = function (level, args) {
  var parts = [];
  for (var i = 0; i < args.length; i++) parts.push(__jb.fmt(args[i]));
  var message = parts.join(" ");
  __jb.native("log", { level: level, message: message });
  if (level === "error") __jb.consoleErrors.push(message);
  else __jb.consoleOutput.push(message);
  if (__jb.consoleOutput.length > 500) __jb.consoleOutput.splice(0, 100);
};
__jb.consoleOutput = [];
__jb.consoleErrors = [];
__jb.fmt = function (v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) {
    // Where it was thrown: the first page frame of the stack (console shows it in browsers too).
    var where = "";
    try { if (typeof v.stack === "string") { var fr = v.stack.split("\n").filter(function (l) { return l && l.indexOf("browser_env.js") < 0; })[0]; if (fr) where = " @ " + fr; } } catch (x) {}
    return v.name + ": " + v.message + where;
  }
  if (v && typeof v === "object") {
    try {
      if (v.nodeType) return "<" + (v.tagName || v.nodeName || "").toLowerCase() + ">";
      return JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  }
  return String(v);
};

// Early console for the environment's own scripts; 15_performance.js installs the real namespace.
Object.defineProperty(globalThis, "console", { value: {
  log: function () { __jb.log("log", arguments); }, info: function () { __jb.log("info", arguments); }, warn: function () { __jb.log("warn", arguments); },
  error: function () { __jb.log("error", arguments); }, debug: function () { __jb.log("debug", arguments); },
}, writable: true, enumerable: false, configurable: true });

// ---- timers (virtual clock, drained by Rust after the script runs) ----
__jb.timers = [];
__jb.timerSeq = 0;
// Long Animation Frames: user callbacks run through __jb.loafRun (measuring once 75 enables it)
__jb.loafOn = false;
__jb.loafRun = function (type, invoker, fn, self, args) { return fn.apply(self, args); };
__jb.clock = 0;
__jb.timerRuns = {};
globalThis.setTimeout = function setTimeout(fn, delay) {
  // a string handler blocked by CSP ('unsafe-eval') schedules nothing
  if (typeof fn === "string" && typeof globalThis.__jb_cspEvalCheck === "function" && !globalThis.__jb_cspEvalCheck("js", fn)) return 0;
  var args = Array.prototype.slice.call(arguments, 2);
  var id = ++__jb.timerSeq;
  // HTML timer nesting: from the sixth nested level on, delays are at least 4 ms
  var nest = (__jb.timerNesting || 0) + 1, d0 = Math.max(0, Number(delay) || 0);
  if (nest > 5 && d0 < 4) d0 = 4;
  __jb.timers.push({ id: id, fn: fn, args: args, due: __jb.clock + d0, interval: null, nest: nest, kind: __jb._internalTimer ? null : "TimerHandler:setTimeout" });
  return id;
}
globalThis.setInterval = function setInterval(fn, delay) {
  if (typeof fn === "string" && typeof globalThis.__jb_cspEvalCheck === "function" && !globalThis.__jb_cspEvalCheck("js", fn)) return 0;
  var args = Array.prototype.slice.call(arguments, 2);
  var id = ++__jb.timerSeq;
  var d = Math.max(1, Number(delay) || 0);
  __jb.timers.push({ id: id, fn: fn, args: args, due: __jb.clock + d, interval: d, kind: "TimerHandler:setInterval" });
  return id;
}
globalThis.clearTimeout = function clearTimeout(id) { __jb.timers = __jb.timers.filter(function (t) { return t.id !== id; }); if (__jb.parkedIntervals && __jb.parkedIntervals.length) __jb.parkedIntervals = __jb.parkedIntervals.filter(function (t) { return t.id !== id; }); }
globalThis.clearInterval = function clearInterval(id) { clearTimeout(id); }
globalThis.queueMicrotask = function queueMicrotask(fn) { Promise.resolve().then(fn); }
// A microtask for the browser's own work (mutation observer delivery, slotchange), queued with the
// Promise machinery as it was before page scripts ran. zone.js replaces Promise and patches
// Promise.prototype.then, which turned every internal delivery into an Angular zone task: each one
// triggered change detection, whose DOM writes queued the next delivery (Raising Cane's bag page:
// ~11,000 change detections in one click, then the budget kill wedged the app).
__jb.nativeMicrotask = (function () {
  var then = Promise.prototype.then, resolved = Promise.resolve();
  return function (fn) { then.call(resolved, fn); };
})();
// Frames are 16 ms apart on the (virtual) clock: rAF callbacks run at the next frame boundary,
// and "update the rendering" work (observers) right after them.
__jb.untilNextFrame = function () { var c = __jb.clock || 0; return (Math.floor(c / 16) + 1) * 16 - c; };
// Rendering steps (animation frames, observers) are not nested timers: no 4 ms clamping.
__jb.frameTimeout = function (fn, d) { var n = __jb.timerNesting, it = __jb._internalTimer; __jb.timerNesting = 0; __jb._internalTimer = true; try { return setTimeout(fn, d); } finally { __jb.timerNesting = n; __jb._internalTimer = it; } };
globalThis.requestAnimationFrame = function requestAnimationFrame(cb) { return __jb.frameTimeout(function () { __jb.loafRun("user-callback", "FrameRequestCallback", cb, globalThis, [__jb.clock]); }, __jb.untilNextFrame()); }
globalThis.cancelAnimationFrame = function cancelAnimationFrame(id) { clearTimeout(id); }
globalThis.requestIdleCallback = function requestIdleCallback(cb) { var it = __jb._internalTimer; __jb._internalTimer = true; try { return setTimeout(function () { __jb.loafRun("user-callback", "IdleRequestCallback", cb, globalThis, [{ didTimeout: false, timeRemaining: function () { return 50; } }]); }, 1); } finally { __jb._internalTimer = it; } }
globalThis.cancelIdleCallback = function cancelIdleCallback(id) { clearTimeout(id); }
// Run the earliest due timer. Returns true if one ran. `limit` (ms of virtual
// time) restricts the run to timers due at or before that instant.
// Virtual milliseconds until the next timer is due (-1 without timers).
__jb.nextTimerDelay = function () {
  if (!__jb.timers.length) return -1;
  var due = __jb.A.reduce.call(__jb.timers, function (a, b) { return b.due < a ? b.due : a; }, Infinity);
  return Math.max(0, due - __jb.clock);
};
// Background requests (real pages, see __jb.asyncNet in 55_webapis.js): callbacks by host id, kept
// on the top realm. Responses are delivered as tasks from runOneTimer.
__jb.registerAsyncFetch = function (id, cb) {
  var tj = typeof __jb.topJb === "function" ? __jb.topJb() : __jb;
  if (!tj.asyncFetches) { tj.asyncFetches = Object.create(null); tj.asyncFetchCount = 0; }
  tj.asyncFetches[id] = cb; tj.asyncFetchCount++; tj.asyncFetchGen = (tj.asyncFetchGen || 0) + 1;
  if (!tj.asyncFetchRealms) tj.asyncFetchRealms = Object.create(null);
  tj.asyncFetchRealms[id] = globalThis;
};
// Deliver arrived responses (waiting up to waitMs for one). Returns "ran" when callbacks ran,
// "wait" when requests younger than the host's hold time are still in flight, "" otherwise.
__jb.deliverAsyncFetches = function (waitMs) {
  var tj = typeof __jb.topJb === "function" ? __jb.topJb() : __jb;
  if (!tj.asyncFetchCount) return "";
  // responses of another realm left over from the previous call go first
  var poll = null, done = tj.asyncFetchStash;
  tj.asyncFetchStash = null;
  if (!done || !done.length) { poll = __jb.native("fetchPoll", { wait: waitMs }); done = poll && poll.done || []; }
  var ran = false, gen = tj.asyncFetchGen || 0, realm = null;
  var realms = tj.asyncFetchRealms || (tj.asyncFetchRealms = Object.create(null));
  for (var i = 0; i < done.length; i++) {
    var id = done[i].id, cb = tj.asyncFetches[id];
    if (!cb) { delete realms[id]; continue; }
    var owner = realms[id] || null;
    if (ran && owner !== realm) { tj.asyncFetchStash = done.slice(i); break; }
    realm = owner;
    delete tj.asyncFetches[id]; delete realms[id]; tj.asyncFetchCount--; ran = true;
    if (owner && typeof __jb.setIncumbent === "function") { try { __jb.setIncumbent(owner); } catch (ei) {} }
    try { cb(done[i].result); } catch (e) { console.error("Uncaught (in fetch callback): " + (e && e.stack ? String(e) + "\n" + e.stack : e)); }
  }
  // nothing in flight: drop callbacks of requests the host forgot - but not ones the callbacks
  // above just registered (a preflight's callback sends the real request), nor stashed ones
  if (poll && !poll.inflight && !tj.asyncFetchStash && (tj.asyncFetchGen || 0) === gen) { tj.asyncFetches = Object.create(null); tj.asyncFetchCount = 0; tj.asyncFetchRealms = Object.create(null); }
  if (ran) return "ran";
  return poll && poll.young > 0 ? "wait" : "";
};
__jb.runOneTimer = function (limit) {
  __jb.fetchBurst = 0; // a task boundary (see fetch() in 55_webapis.js)
  // a new bounded drain (an action's settle, wait(ms)): intervals parked by the run cap resume
  if (limit !== undefined && limit !== null && __jb.drainLimit !== limit) {
    __jb.drainLimit = limit;
    __jb.timerRuns = {};
    var parked = __jb.parkedIntervals;
    if (parked && parked.length) {
      __jb.parkedIntervals = [];
      for (var pk = 0; pk < parked.length; pk++) { parked[pk].due = __jb.clock + parked[pk].interval; __jb.timers.push(parked[pk]); }
    }
  }
  var tjA = typeof __jb.topJb === "function" ? __jb.topJb() : __jb;
  if (tjA.asyncFetchCount > 0 && tjA === __jb) {
    var dueNow = __jb.timers.length && (limit === undefined || limit === null || __jb.timers.some(function (t) { return t.due <= limit; }));
    var got = __jb.deliverAsyncFetches(dueNow || __jb.noNetHold ? 0 : 25);
    if (got === "ran") return true;
    // nothing else to do: keep the loop alive for the network (unless the host capped the wait)
    if (!dueNow && got === "wait" && !__jb.noNetHold) return true;
    // Requests are in flight and the next timer lies ahead in virtual time: let that time pass in
    // real time for the network instead of jumping the clock. Otherwise a request's own timeout
    // timer (axios 3000 ms) fired before its response arrived (JCPenney filters, student.com
    // search). The host caps the real time a drain spends here (noNetHold).
    if (dueNow && got === "wait" && !__jb.noNetHold) {
      var nextDue = Infinity;
      for (var pi = 0; pi < __jb.timers.length; pi++) if (__jb.timers[pi].due < nextDue) nextDue = __jb.timers[pi].due;
      if (nextDue > __jb.clock && (limit === undefined || limit === null || nextDue <= limit)) {
        var paceMs = Math.min(100, Math.ceil(nextDue - __jb.clock));
        if (__jb.deliverAsyncFetches(paceMs) === "ran") return true;
        __jb.clock = Math.min(nextDue, __jb.clock + paceMs);
        if (nextDue > __jb.clock) return true;
      }
    }
  }
  if (!__jb.timers.length) return false;
  var next = __jb.A.reduce.call(__jb.timers, function (a, b) { return b.due < a.due ? b : a; });
  if (limit !== undefined && limit !== null && next.due > limit) return false;
  __jb.timers = __jb.timers.filter(function (t) { return t !== next; });
  if (next.due > __jb.clock) __jb.clock = next.due;
  if (next.interval !== null) {
    var runs = (__jb.timerRuns[next.id] || 0) + 1;
    __jb.timerRuns[next.id] = runs;
    // Page loads stop an interval after a few runs; the WPT runner (bounded by
    // its own step/time budget) lifts the cap through `maxIntervalRuns`.
    var bounded = limit !== undefined && limit !== null;
    var cap = bounded ? 200 : 5, wptCap = false; try { var tj = typeof __jb.topJb === "function" ? __jb.topJb() : __jb; if (tj.maxIntervalRuns) { cap = tj.maxIntervalRuns; wptCap = true; } } catch (e) {}
    var again = { id: next.id, fn: next.fn, args: next.args, due: __jb.clock + next.interval, interval: next.interval, kind: next.kind };
    if (runs < cap) __jb.timers.push(again);
    else if (!wptCap) (__jb.parkedIntervals || (__jb.parkedIntervals = [])).push(again); // resumes in the next bounded drain
  }
  var prevNest = __jb.timerNesting;
  __jb.timerNesting = next.nest || 0;
  __jb.lastTimerDesc = next.fn; // diagnostics: the host names slow tasks (JB_TRACE_JS)
  try {
    if (typeof next.fn === "function") { if (next.kind && __jb.loafOn) __jb.loafRun("user-callback", next.kind, next.fn, globalThis, next.args); else next.fn.apply(globalThis, next.args); }
    else if (typeof next.fn === "string") { var tcode = next.fn; __jb.csp ? __jb.csp.trusted(function () { (0, eval)(tcode); }) : (0, eval)(tcode); } // checked when scheduled
  } catch (e) {
    console.error("Uncaught (in timer): " + (e && e.stack ? String(e) + "\n" + e.stack : e));
  } finally { __jb.timerNesting = prevNest; }
  return true;
};

// ---- performance ----
globalThis.performance = {
  timeOrigin: Date.now(),
  now: function () { var n = __jb.native("elapsed"); return (typeof n === "number" ? n : 0) + __jb.clock; },
  mark: function (name) { this._marks[name] = this.now(); return { name: name, startTime: this._marks[name], entryType: "mark", duration: 0 }; },
  measure: function (name, a, b) { var s = this._marks[a] || 0, e = this._marks[b] || this.now(); return { name: name, entryType: "measure", startTime: s, duration: e - s }; },
  clearMarks: function () { this._marks = {}; }, clearMeasures: function () {}, clearResourceTimings: function () {},
  getEntries: function () { return []; }, getEntriesByType: function () { return []; }, getEntriesByName: function () { return []; },
  setResourceTimingBufferSize: function () {},
  timing: { navigationStart: Date.now() - 100, domLoading: Date.now() - 50, domInteractive: Date.now(), domContentLoadedEventStart: Date.now(), domContentLoadedEventEnd: Date.now(), domComplete: Date.now(), loadEventStart: Date.now(), loadEventEnd: Date.now(), responseStart: Date.now() - 80, responseEnd: Date.now() - 60, requestStart: Date.now() - 90, fetchStart: Date.now() - 95 },
  navigation: { type: 0, redirectCount: 0 },
  memory: { usedJSHeapSize: 10000000, totalJSHeapSize: 20000000, jsHeapSizeLimit: 2000000000 },
  _marks: {},
  addEventListener: function () {}, removeEventListener: function () {},
  toJSON: function () { return {}; },
};
globalThis.performance = performance;

// ---- base64 / text encoding ----
var __b64chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
globalThis.btoa = function btoa(input) {
  if (arguments.length === 0) throw new TypeError("btoa: At least 1 argument required, but only 0 passed");
  var str = String(input), out = "", i = 0;
  for (var k = 0; k < str.length; k++) if (str.charCodeAt(k) > 255) throw __jb.domError("InvalidCharacterError", "String contains an invalid character");
  while (i < str.length) {
    var c1 = str.charCodeAt(i++), c2 = str.charCodeAt(i++), c3 = str.charCodeAt(i++);
    var e1 = c1 >> 2, e2 = ((c1 & 3) << 4) | (c2 >> 4), e3 = ((c2 & 15) << 2) | (c3 >> 6), e4 = c3 & 63;
    if (isNaN(c2)) e3 = e4 = 64; else if (isNaN(c3)) e4 = 64;
    out += __b64chars.charAt(e1) + __b64chars.charAt(e2) + __b64chars.charAt(e3) + __b64chars.charAt(e4);
  }
  return out;
}
globalThis.atob = function atob(input) {
  if (arguments.length === 0) throw new TypeError("atob: At least 1 argument required, but only 0 passed");
  // Infra "forgiving-base64 decode".
  var str = String(input).replace(/[\t\n\f\r ]/g, "");
  if (str.length % 4 === 0) str = str.replace(/==?$/, "");
  if (str.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(str)) throw __jb.domError("InvalidCharacterError", "String contains an invalid character");
  var out = "", i = 0;
  while (i < str.length) {
    var e1 = __b64chars.indexOf(str.charAt(i++)), e2 = __b64chars.indexOf(str.charAt(i++));
    var e3 = i < str.length ? __b64chars.indexOf(str.charAt(i++)) : -1, e4 = i < str.length ? __b64chars.indexOf(str.charAt(i++)) : -1;
    out += String.fromCharCode((e1 << 2) | (e2 >> 4));
    if (e3 >= 0) out += String.fromCharCode(((e2 & 15) << 4) | (e3 >> 2));
    if (e4 >= 0) out += String.fromCharCode(((e3 & 3) << 6) | e4);
  }
  return out;
}
function __utf8Encode(str) {
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.codePointAt(i);
    if (c > 0xffff) i++;
    else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(bytes);
}
// WHATWG "UTF-8 decode": malformed sequences become U+FFFD (maximal subpart), a BOM is not stripped here.
function __utf8Decode(bytes) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes);
  var parts = [], chunk = [], n = bytes.length, i = 0;
  var flush = function () { parts.push(String.fromCharCode.apply(null, chunk)); chunk = []; };
  var push = function (cp) {
    if (cp > 0xffff) { cp -= 0x10000; chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); } else chunk.push(cp);
    if (chunk.length > 8000) flush();
  };
  while (i < n) {
    var b = bytes[i];
    if (b < 0x80) { push(b); i++; continue; }
    var need, cp, lower = 0x80, upper = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; }
    else if (b >= 0xe0 && b <= 0xef) { need = 2; cp = b & 0xf; if (b === 0xe0) lower = 0xa0; if (b === 0xed) upper = 0x9f; }
    else if (b >= 0xf0 && b <= 0xf4) { need = 3; cp = b & 0x7; if (b === 0xf0) lower = 0x90; if (b === 0xf4) upper = 0x8f; }
    else { push(0xfffd); i++; continue; }
    var k = 1, ok = true;
    for (; k <= need; k++) {
      var c = bytes[i + k];
      if (i + k >= n || c < lower || c > upper) { ok = false; break; }
      lower = 0x80; upper = 0xbf;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (ok) { push(cp); i += need + 1; } else { push(0xfffd); i += k; }
  }
  flush();
  return parts.join("");
}
class TextEncoder {
  constructor() {}
  get encoding() { return "utf-8"; }
  encode(s) { return __utf8Encode(s === undefined ? "" : String(s)); }
  encodeInto(s, dest) {
    if (arguments.length < 2) throw new TypeError("encodeInto: 2 arguments required");
    if (!(dest instanceof Uint8Array)) throw new TypeError("encodeInto: Argument 2 is not a Uint8Array");
    s = String(s);
    var read = 0, written = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.codePointAt(i), units = 1;
      if (c > 0xffff) units = 2; else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      var need = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
      if (written + need > dest.length) break;
      if (need === 1) dest[written] = c;
      else if (need === 2) { dest[written] = 0xc0 | (c >> 6); dest[written + 1] = 0x80 | (c & 63); }
      else if (need === 3) { dest[written] = 0xe0 | (c >> 12); dest[written + 1] = 0x80 | ((c >> 6) & 63); dest[written + 2] = 0x80 | (c & 63); }
      else { dest[written] = 0xf0 | (c >> 18); dest[written + 1] = 0x80 | ((c >> 12) & 63); dest[written + 2] = 0x80 | ((c >> 6) & 63); dest[written + 3] = 0x80 | (c & 63); }
      written += need; read += units; if (units === 2) i++;
    }
    return { read: read, written: written };
  }
  get [Symbol.toStringTag]() { return "TextEncoder"; }
}
// TextDecoder is backed by encoding_rs (all Encoding Standard encodings,
// streaming, BOM handling and the fatal flag).
class TextDecoder {
  constructor(label, options) {
    label = label === undefined ? "utf-8" : String(label);
    if (options !== undefined && options !== null && typeof options !== "object" && typeof options !== "function") throw new TypeError("TextDecoder: options is not an object");
    var fatal = !!(options && options.fatal), ignoreBOM = !!(options && options.ignoreBOM);
    var r = __jb.native("encoding", { op: "open", label: label, fatal: fatal, ignoreBOM: ignoreBOM });
    if (!r || r.error) throw new RangeError("TextDecoder constructor: The given encoding '" + label + "' is not supported.");
    Object.defineProperty(this, "_id", { value: r.id });
    Object.defineProperty(this, "_encoding", { value: String(r.name).toLowerCase() });
    Object.defineProperty(this, "_fatal", { value: fatal });
    Object.defineProperty(this, "_ignoreBOM", { value: ignoreBOM });
  }
  get encoding() { return this._encoding; }
  get fatal() { return this._fatal; }
  get ignoreBOM() { return this._ignoreBOM; }
  decode(input, options) {
    var bytes;
    if (input === undefined) bytes = new Uint8Array(0);
    else if (input instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && input instanceof SharedArrayBuffer)) bytes = new Uint8Array(input);
    else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else throw new TypeError("TextDecoder.decode: Argument 1 is not a BufferSource.");
    if (options !== undefined && options !== null && typeof options !== "object" && typeof options !== "function") throw new TypeError("TextDecoder.decode: options is not an object");
    var stream = !!(options && options.stream);
    var r = __jb.native("encoding", { op: "decode", id: this._id, data: __jb.bytesToB64(bytes), stream: stream });
    if (!r) throw new TypeError("TextDecoder.decode: decoder unavailable");
    if (r.error) throw new TypeError("TextDecoder.decode: The encoded data was not valid.");
    return r.text;
  }
  get [Symbol.toStringTag]() { return "TextDecoder"; }
}
globalThis.TextEncoder = TextEncoder; globalThis.TextDecoder = TextDecoder;

// ---- byte helpers (base64 is the wire format between JS and Rust) ----
__jb.toBytes = function (v) {
  if (v === undefined || v === null) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === "string") return __utf8Encode(v);
  if (v && v._bytes) return v._bytes();
  return __utf8Encode(String(v));
};
__jb.bytesToB64 = function (bytes) {
  bytes = __jb.toBytes(bytes);
  var s = "";
  for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
__jb.b64Lookup = (function () { var t = new Int8Array(128).fill(-1); for (var i = 0; i < 64; i++) t[__b64chars.charCodeAt(i)] = i; return t; })();
__jb.b64ToBytes = function (b64) {
  b64 = String(b64 || "");
  var n = b64.length, t = __jb.b64Lookup, out = new Uint8Array(Math.ceil(n * 3 / 4)), o = 0, acc = 0, bits = 0;
  for (var i = 0; i < n; i++) {
    var c = b64.charCodeAt(i), v = c < 128 ? t[c] : -1;
    if (v < 0) {
      if (c === 61) break; // "=" padding
      if (c === 9 || c === 10 || c === 12 || c === 13 || c === 32) continue;
      throw __jb.domError("InvalidCharacterError", "String contains an invalid character");
    }
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; acc &= (1 << bits) - 1; }
  }
  return o === out.length ? out : out.slice(0, o);
};
__jb.isBinaryMime = function (ct) { ct = (ct || "").toLowerCase(); return !!ct && !(ct.indexOf("text/") === 0 || /json|xml|javascript|ecmascript|urlencoded|csv|svg/.test(ct)); };

globalThis.structuredClone = function structuredClone(v, options) {
  if (arguments.length < 1) throw new TypeError("structuredClone: 1 argument required");
  // The deserialization realm is this's relevant realm (e.g. otherWindow.structuredClone.call(window, x)).
  var self_ = this;
  if (self_ && self_ !== globalThis && typeof self_ === "object" && self_.__jb && self_.__jb.structuredCloneValue && self_.structuredClone !== structuredClone) { return self_.structuredClone(v, options); }
  return __jb.structuredCloneImpl(v, options);
}
__jb.structuredCloneImpl = function (v, options) {
  if (arguments.length === 0) throw new TypeError("structuredClone: At least 1 argument required, but only 0 passed");
  var transfer = options && options.transfer !== undefined ? options.transfer : [];
  if (options !== undefined && options !== null && typeof options !== "object") throw new TypeError("structuredClone: Argument 2 can't be converted to a dictionary");
  var seen = new Map();
  var list = __jb.arrayFrom(transfer);
  var buffers = [], bitmaps = [], canvases = [], ports = [];
  list.forEach(function (t) {
    var ttag = Object.prototype.toString.call(t);
    if (t instanceof ArrayBuffer || ttag === "[object ArrayBuffer]") {
      if (t.detached) throw new DOMException("An ArrayBuffer is detached and could not be transferred.", "DataCloneError");
      if (buffers.indexOf(t) >= 0) throw new DOMException("Duplicate transferable.", "DataCloneError");
      buffers.push(t);
    } else if (t !== null && typeof t === "object" && ((typeof MessagePort !== "undefined" && t instanceof MessagePort) || ttag === "[object MessagePort]")) {
      if (t._port && t._port.detached) throw new DOMException("A MessagePort is detached and could not be transferred.", "DataCloneError");
      if (ports.indexOf(t) >= 0) throw new DOMException("Duplicate transferable.", "DataCloneError");
      ports.push(t);
    } else if (Object.prototype.toString.call(t) === "[object OffscreenCanvas]") {
      if (t._detached) throw new DOMException("An OffscreenCanvas is detached and could not be transferred.", "DataCloneError");
      if (t._ctxType) throw new DOMException("An OffscreenCanvas with a rendering context cannot be transferred.", "InvalidStateError");
      canvases.push(t);
    } else if (Object.prototype.toString.call(t) === "[object ImageBitmap]") {
      if (t._closed) throw new DOMException("An ImageBitmap is detached and could not be transferred.", "DataCloneError");
      if (t._originTainted) throw new DOMException("A non-origin-clean ImageBitmap cannot be transferred.", "DataCloneError");
      if (bitmaps.indexOf(t) >= 0) throw new DOMException("Duplicate transferable.", "DataCloneError");
      bitmaps.push(t);
    } else {
      throw new DOMException("Value not transferable.", "DataCloneError");
    }
  });
  // serialize first (views of transferred buffers clone against the moved copies), detach after
  buffers.forEach(function (b) {
    var moved = b.resizable ? new ArrayBuffer(b.byteLength, { maxByteLength: b.maxByteLength }) : new ArrayBuffer(b.byteLength);
    new Uint8Array(moved).set(new Uint8Array(b)); seen.set(b, moved);
  });
  // transferred ImageBitmaps move to the clone; the original is detached
  bitmaps.forEach(function (b) { var moved = __jb.cloneImageBitmap(b); seen.set(b, moved); b._closed = true; });
  canvases.forEach(function (c) { var moved = new OffscreenCanvas(c.width, c.height); seen.set(c, moved); c._width = 0; c._height = 0; Object.defineProperty(c, "_detached", { value: true, writable: true, configurable: true }); });
  // transferred ports move into this realm (options.outPorts receives them, for MessageEvent.ports)
  var movedPorts = ports.map(function (p) { var m = __jb.movePort(p); seen.set(p, m); return m; });
  if (options && Array.isArray(options.outPorts)) movedPorts.forEach(function (m) { options.outPorts.push(m); });
  var result = __jb.structuredCloneValue(v, seen);
  buffers.forEach(function (b) { if (b.transfer) b.transfer(); });
  return result;
};
// Clone `v` into realm `targetJb`; serialization errors are thrown in this (the sender's) realm.
__jb.cloneInto = function (targetJb, v, options) {
  try { return (targetJb || __jb).structuredCloneImpl(v, options); }
  catch (e) {
    if (e && typeof e === "object" && typeof e.name === "string" && !(e instanceof DOMException) && Object.prototype.toString.call(e) === "[object DOMException]") throw new DOMException(e.message, e.name);
    if (e && typeof e === "object" && !(e instanceof Error) && /Error$/.test(String(e.name)) && typeof globalThis[e.name] === "function") throw new globalThis[e.name](e.message);
    throw e;
  }
};
__jb.structuredCloneValue = function (v, seen) {
  if (v === null || typeof v !== "object") { if (typeof v === "function" || typeof v === "symbol") throw new DOMException("The object could not be cloned.", "DataCloneError"); return v; }
  if (seen.has(v)) return seen.get(v);
  if (__jb.isCryptoKey && __jb.isCryptoKey(v)) { var ck = __jb.cloneCryptoKey(v); seen.set(v, ck); return ck; }
  var out, i;
  // Objects of another realm (frames) fail instanceof: classify them by their class tag.
  var tag = Object.prototype.toString.call(v);
  if (v instanceof Date || tag === "[object Date]") return new Date(v.getTime());
  if (v instanceof RegExp || tag === "[object RegExp]") return new RegExp(v.source, v.flags);
  if (v instanceof ArrayBuffer || tag === "[object ArrayBuffer]") {
    if (v.detached) throw new DOMException("The ArrayBuffer is detached and could not be cloned.", "DataCloneError");
    out = v.resizable ? new ArrayBuffer(v.byteLength, { maxByteLength: v.maxByteLength }) : new ArrayBuffer(v.byteLength);
    new Uint8Array(out).set(new Uint8Array(v)); seen.set(v, out); return out;
  }
  if (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) {
    if (v.buffer.detached) throw new DOMException("The ArrayBuffer is detached and could not be cloned.", "DataCloneError");
    var buf = __jb.structuredCloneValue(v.buffer, seen);
    if (v instanceof DataView) { out = v.byteLength === 0 && v.buffer.resizable && v.byteOffset + 0 === v.buffer.byteLength ? new DataView(buf, v.byteOffset) : new DataView(buf, v.byteOffset, v.byteLength); seen.set(v, out); return out; }
    if (v.byteOffset + v.byteLength > v.buffer.byteLength) throw new DOMException("The typed array is out of bounds.", "DataCloneError");
    var TA = globalThis[tag.slice(8, -1)] || v.constructor; // this realm's constructor (the value may come from another realm)
    out = v.buffer.resizable && v.length * v.BYTES_PER_ELEMENT + v.byteOffset === v.buffer.byteLength ? new TA(buf, v.byteOffset) : new TA(buf, v.byteOffset, v.length);
    seen.set(v, out); return out;
  }
  if (v instanceof Map || tag === "[object Map]") { out = new Map(); seen.set(v, out); v.forEach(function (val, k) { out.set(__jb.structuredCloneValue(k, seen), __jb.structuredCloneValue(val, seen)); }); return out; }
  if (v instanceof Set || tag === "[object Set]") { out = new Set(); seen.set(v, out); v.forEach(function (val) { out.add(__jb.structuredCloneValue(val, seen)); }); return out; }
  if (typeof DOMException !== "undefined" && v instanceof DOMException) { out = new DOMException(v.message, v.name); seen.set(v, out); return out; }
  if (v instanceof Error || tag === "[object Error]") {
    var C = { EvalError: EvalError, RangeError: RangeError, ReferenceError: ReferenceError, SyntaxError: SyntaxError, TypeError: TypeError, URIError: URIError }[v.name] || Error;
    out = new C();
    if (Object.prototype.hasOwnProperty.call(v, "message")) { var m = v.message; out.message = m === undefined ? "" : String(m); } else delete out.message;
    if (Object.prototype.hasOwnProperty.call(v, "stack")) out.stack = String(v.stack);
    if (Object.prototype.hasOwnProperty.call(v, "cause")) Object.defineProperty(out, "cause", { value: __jb.structuredCloneValue(v.cause, seen), writable: true, configurable: true, enumerable: false });
    seen.set(v, out); return out;
  }
  if (typeof File !== "undefined" && v instanceof File) { out = new File([v], v.name, { type: v.type, lastModified: v.lastModified }); seen.set(v, out); return out; }
  if (typeof Blob !== "undefined" && v instanceof Blob) { out = v.slice(0, v.size, v.type); seen.set(v, out); return out; }
  // Blobs and Files of another realm: rebuilt from their bytes in this realm
  if ((tag === "[object File]" || tag === "[object Blob]") && typeof v._bytes === "function") {
    var bytes = new Uint8Array(v._bytes());
    out = tag === "[object File]" ? new File([bytes], v.name, { type: v.type, lastModified: v.lastModified }) : new Blob([bytes], { type: v.type });
    seen.set(v, out); return out;
  }
  if (typeof FileList !== "undefined" && tag === "[object FileList]" && !(v instanceof FileList)) { out = new FileList(); seen.set(v, out); for (i = 0; i < v.length; i++) out.push(__jb.structuredCloneValue(v[i], seen)); return out; }
  if (typeof ImageData !== "undefined" && tag === "[object ImageData]" && !(v instanceof ImageData)) { out = new ImageData(new Uint8ClampedArray(v.data), v.width, v.height); seen.set(v, out); return out; }
  if (typeof FileList !== "undefined" && v instanceof FileList) { out = new FileList(); seen.set(v, out); for (i = 0; i < v.length; i++) out.push(__jb.structuredCloneValue(v[i], seen)); return out; }
  if (typeof ImageData !== "undefined" && v instanceof ImageData) { out = new ImageData(new Uint8ClampedArray(v.data), v.width, v.height); seen.set(v, out); return out; }
  if (Object.prototype.toString.call(v) === "[object ImageBitmap]") {
    if (v._originTainted) throw new DOMException("A non-origin-clean ImageBitmap cannot be serialized.", "DataCloneError"); out = __jb.cloneImageBitmap ? __jb.cloneImageBitmap(v) : v; seen.set(v, out); return out; }
  // File System Access handles serialize as their locator (the file system is shared in-process)
  if ((tag === "[object FileSystemFileHandle]" || tag === "[object FileSystemDirectoryHandle]") && v._loc && __jb.fsHandleFromLocator) { out = __jb.fsHandleFromLocator(v._loc); seen.set(v, out); return out; }
  // real DOM nodes only (any realm): plain data may have a nodeType property (Contentful rich text on GitHub)
  if (__jb.isNode ? __jb.isNode(v) : (typeof v.nodeType === "number" && typeof v.cloneNode === "function")) throw new DOMException("DOM nodes could not be cloned.", "DataCloneError");
  if ([typeof URL !== "undefined" && URL, typeof URLSearchParams !== "undefined" && URLSearchParams, typeof EventTarget !== "undefined" && EventTarget, typeof Event !== "undefined" && Event, typeof PerformanceEntry !== "undefined" && PerformanceEntry, typeof Headers !== "undefined" && Headers, typeof Request !== "undefined" && Request, typeof Response !== "undefined" && Response, typeof FormData !== "undefined" && FormData, typeof ReadableStream !== "undefined" && ReadableStream, typeof WritableStream !== "undefined" && WritableStream, Promise, WeakMap, WeakSet, typeof WeakRef !== "undefined" && WeakRef].some(function (C) { return C && v instanceof C; })) throw new DOMException("The object could not be cloned.", "DataCloneError");
  if (typeof Boolean === "function" && (v instanceof Boolean || v instanceof Number || v instanceof String || (typeof BigInt !== "undefined" && v instanceof BigInt) || /^\[object (Boolean|Number|String|BigInt)\]$/.test(tag))) return Object(v.valueOf());
  if (tag === "[object ArrayBuffer]" && !(v instanceof ArrayBuffer)) { out = new ArrayBuffer(v.byteLength); new Uint8Array(out).set(new Uint8Array(v)); seen.set(v, out); return out; }
  if (__jb.isPlatformObject && __jb.isPlatformObject(v)) throw new DOMException("The object could not be cloned.", "DataCloneError");
  if (Array.isArray(v)) { out = new Array(v.length); seen.set(v, out); }
  else { out = {}; seen.set(v, out); }
  Object.keys(v).forEach(function (k) { out[k] = __jb.structuredCloneValue(v[k], seen); });
  return out;
};

// (Web Crypto lives in 16_webcrypto.js)

// ---- URL / URLSearchParams (parsing and setters run in Rust: the `url` crate) ----
__jb.urlEncodingOverride = null;
// Run `fn` with URL parsing using `encoding` for query components (used for
// hyperlinks in documents with a legacy encoding).
__jb.withUrlEncoding = function (encoding, fn) { var prev = __jb.urlEncodingOverride; __jb.urlEncodingOverride = encoding && !/^utf-(8|16)/i.test(encoding) && !/^replacement$/i.test(encoding) ? encoding : null; try { return fn(); } finally { __jb.urlEncodingOverride = prev; } };
__jb.urlNative = function (payload) {
  if (__jb.urlEncodingOverride && payload.encoding === undefined) payload.encoding = __jb.urlEncodingOverride;
  var r = __jb.native("url", payload);
  if (!r) throw new TypeError("URL: parser unavailable");
  return r;
};
// application/x-www-form-urlencoded byte serializer.
__jb.formEncode = function (s) {
  var bytes = __utf8Encode(String(s)), out = "";
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    if (b === 0x20) out += "+";
    else if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2a || b === 0x2d || b === 0x2e || b === 0x5f) out += String.fromCharCode(b);
    else out += "%" + (b < 16 ? "0" : "") + b.toString(16).toUpperCase();
  }
  return out;
};
__jb.formDecode = function (s) {
  s = String(s).replace(/\+/g, " ");
  var bytes = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c === 0x25 && i + 2 < s.length && /^[0-9a-fA-F]{2}$/.test(s.substr(i + 1, 2))) { bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else if (c < 0x80) bytes.push(c);
    else { var cp = s.codePointAt(i); var enc = __utf8Encode(String.fromCodePoint(cp)); for (var k = 0; k < enc.length; k++) bytes.push(enc[k]); if (cp > 0xffff) i++; }
  }
  return __utf8Decode(new Uint8Array(bytes));
};
__jb.parseFormUrlencoded = function (s) {
  var out = [];
  String(s).split("&").forEach(function (pair) {
    if (!pair) return;
    var idx = pair.indexOf("=");
    var k = idx < 0 ? pair : pair.slice(0, idx), v = idx < 0 ? "" : pair.slice(idx + 1);
    out.push([__jb.formDecode(k), __jb.formDecode(v)]);
  });
  return out;
};
class URLSearchParams {
  constructor(init) {
    this._list = [];
    this._url = null;
    if (init === undefined || init === null) return;
    if (typeof init === "object" || typeof init === "function") {
      if (init instanceof URLSearchParams) { this._list = init._list.map(function (p) { return p.slice(); }); return; }
      var iter = init[Symbol.iterator];
      if (iter !== undefined && iter !== null) {
        if (typeof iter !== "function") throw new TypeError("URLSearchParams constructor: init is not iterable");
        for (var pair of init) {
          if (pair === null || (typeof pair !== "object" && typeof pair !== "function")) throw new TypeError("URLSearchParams constructor: sequence element is not an object");
          var items = __jb.arrayFrom(pair);
          if (items.length !== 2) throw new TypeError("URLSearchParams constructor: each pair must have exactly two elements");
          this._list.push([String(items[0]), String(items[1])]);
        }
        return;
      }
      for (var key of Object.keys(init)) { var d = Object.getOwnPropertyDescriptor(init, key); if (d && d.enumerable) this._list.push([String(key), String(init[key])]); }
      return;
    }
    init = String(init);
    if (init.charAt(0) === "?") init = init.slice(1);
    this._list = __jb.parseFormUrlencoded(init);
  }
  _update() { if (this._url) this._url._setSearchFromParams(this._list.length ? this.toString() : ""); }
  append(k, v) { if (arguments.length < 2) throw new TypeError("URLSearchParams.append: At least 2 arguments required"); this._list.push([String(k), String(v)]); this._update(); }
  delete(k, v) {
    if (arguments.length < 1) throw new TypeError("URLSearchParams.delete: At least 1 argument required");
    k = String(k);
    if (arguments.length >= 2 && v !== undefined) { v = String(v); this._list = this._list.filter(function (p) { return !(p[0] === k && p[1] === v); }); }
    else this._list = this._list.filter(function (p) { return p[0] !== k; });
    this._update();
  }
  get(k) { if (arguments.length < 1) throw new TypeError("URLSearchParams.get: At least 1 argument required"); k = String(k); var p = this._list.find(function (p) { return p[0] === k; }); return p ? p[1] : null; }
  getAll(k) { if (arguments.length < 1) throw new TypeError("URLSearchParams.getAll: At least 1 argument required"); k = String(k); return this._list.filter(function (p) { return p[0] === k; }).map(function (p) { return p[1]; }); }
  has(k, v) {
    if (arguments.length < 1) throw new TypeError("URLSearchParams.has: At least 1 argument required");
    k = String(k);
    if (arguments.length >= 2 && v !== undefined) { v = String(v); return this._list.some(function (p) { return p[0] === k && p[1] === v; }); }
    return this._list.some(function (p) { return p[0] === k; });
  }
  set(k, v) {
    if (arguments.length < 2) throw new TypeError("URLSearchParams.set: At least 2 arguments required");
    k = String(k); v = String(v);
    var i = this._list.findIndex(function (p) { return p[0] === k; });
    if (i < 0) this._list.push([k, v]);
    else { this._list[i][1] = v; this._list = this._list.filter(function (p, j) { return p[0] !== k || j === i; }); }
    this._update();
  }
  sort() {
    // Stable sort by UTF-16 code units of the name.
    var indexed = this._list.map(function (p, i) { return [p, i]; });
    indexed.sort(function (a, b) { var x = a[0][0], y = b[0][0]; if (x < y) return -1; if (x > y) return 1; return a[1] - b[1]; });
    this._list = indexed.map(function (e) { return e[0]; });
    this._update();
  }
  forEach(cb, thisArg) { if (typeof cb !== "function") throw new TypeError("URLSearchParams.forEach: Argument 1 is not callable."); for (var i = 0; i < this._list.length; i++) cb.call(thisArg, this._list[i][1], this._list[i][0], this); }
  keys() { return __jb.listIterator(this, 0); }
  values() { return __jb.listIterator(this, 1); }
  entries() { return __jb.listIterator(this, 2); }
  [Symbol.iterator]() { return this.entries(); }
  get size() { return this._list.length; }
  toString() { return this._list.map(function (p) { return __jb.formEncode(p[0]) + "=" + __jb.formEncode(p[1]); }).join("&"); }
  get [Symbol.toStringTag]() { return "URLSearchParams"; }
}
// Live iterator over a URLSearchParams list (sees mutations during iteration).
__jb.listIterator = function (params, kind) {
  var i = 0;
  var it = { next: function () { if (i >= params._list.length) return { value: undefined, done: true }; var p = params._list[i++]; return { value: kind === 0 ? p[0] : kind === 1 ? p[1] : [p[0], p[1]], done: false }; } };
  it[Symbol.iterator] = function () { return it; };
  return it;
};
class URL {
  constructor(url, base) {
    if (arguments.length < 1) throw new TypeError("URL constructor: At least 1 argument required, but only 0 passed");
    url = String(url);
    var payload = { op: "parse", input: url };
    if (base !== undefined) payload.base = String(base);
    var r = __jb.urlNative(payload);
    if (r.error) throw new TypeError("URL constructor: " + url + " is not a valid URL.");
    __jb.dp(this, "_c", { value: r, writable: true, enumerable: false });
    __jb.dp(this, "_params", { value: null, writable: true, enumerable: false });
  }
  _set(field, value) {
    var r = __jb.urlNative({ op: "set", href: this._c.href, field: field, value: String(value) });
    if (r.error) { if (field === "href") throw new TypeError("URL: " + value + " is not a valid URL."); return; }
    this._c = r;
  }
  _syncParams() { if (this._params) this._params._list = __jb.parseFormUrlencoded(this._c.search.slice(1)); }
  _setSearchFromParams(serialized) { this._set("search", serialized); }
  get href() { return this._c.href; } set href(v) { this._set("href", v); this._syncParams(); }
  get origin() { return this._c.origin; }
  get protocol() { return this._c.protocol; } set protocol(v) { this._set("protocol", v); }
  get username() { return this._c.username; } set username(v) { this._set("username", v); }
  get password() { return this._c.password; } set password(v) { this._set("password", v); }
  get host() { return this._c.host; } set host(v) { this._set("host", v); }
  get hostname() { return this._c.hostname; } set hostname(v) { this._set("hostname", v); }
  get port() { return this._c.port; } set port(v) { this._set("port", v); }
  get pathname() { return this._c.pathname; } set pathname(v) { this._set("pathname", v); }
  get search() { return this._c.search; } set search(v) { this._set("search", v); this._syncParams(); }
  get hash() { return this._c.hash; } set hash(v) { this._set("hash", v); }
  get searchParams() { if (!this._params) { this._params = new URLSearchParams(this._c.search); this._params._url = this; } return this._params; }
  toString() { return this._c.href; }
  toJSON() { return this._c.href; }
  get [Symbol.toStringTag]() { return "URL"; }
  static canParse(u, b) { if (arguments.length < 1) throw new TypeError("URL.canParse: At least 1 argument required"); var payload = { op: "parse", input: String(u) }; if (b !== undefined) payload.base = String(b); return !__jb.urlNative(payload).error; }
  static parse(u, b) { if (arguments.length < 1) throw new TypeError("URL.parse: At least 1 argument required"); try { return new URL(u, b); } catch (e) { return null; } }
  static createObjectURL(obj) { var id = "blob:" + (typeof location !== "undefined" ? location.origin : "null") + "/" + (__jb.native("uuid") || "x"); __jb.blobUrls = __jb.blobUrls || {}; __jb.blobUrls[id] = obj; return id; }
  static revokeObjectURL(id) { if (__jb.blobUrls) delete __jb.blobUrls[String(id)]; }
}
__jb.normalizePath = function (p) { return p; };
globalThis.URL = URL; globalThis.URLSearchParams = URLSearchParams; globalThis.webkitURL = URL;
