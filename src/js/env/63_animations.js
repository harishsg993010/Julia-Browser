// ---------------------------------------------------------------- Web Animations
// Timing model, Animation / KeyframeEffect / DocumentTimeline, effect values layered on the
// layout engine's computed style, CSS Animations and CSS Transitions (CSSAnimation /
// CSSTransition), animation events. Timelines advance per rendering frame (16 ms frames of the
// virtual clock, see __jb.untilNextFrame); pending play/pause tasks complete at the next frame.
// ---- minimal CSS Typed OM numerics (CSSUnitValue, CSS.number/percent/px/ms/s/...)
(function () {
  if (typeof CSS === "undefined" || typeof CSS.percent === "function") return;
  class CSSStyleValue { constructor() { if (!__jb.typedOmCreating) throw new TypeError("Illegal constructor"); } toString() { return ""; } }
  class CSSNumericValue extends CSSStyleValue {
    equals() { var self = this; return __jb.A.every.call(arguments, function (o) { return o && o.unit === self.unit && o.value === self.value; }); }
    to(unit) { var f = { ms: 1, s: 1000 }; if (this.unit === unit) return mk(this.value, unit); if (f[this.unit] && f[unit]) return mk(this.value * f[this.unit] / f[unit], unit); throw new TypeError("Cannot convert"); }
    add(o) { if (!o || o.unit !== this.unit) throw new TypeError("Mixed units are not supported"); return mk(this.value + o.value, this.unit); }
    sub(o) { if (!o || o.unit !== this.unit) throw new TypeError("Mixed units are not supported"); return mk(this.value - o.value, this.unit); }
    mul(n) { return mk(this.value * (typeof n === "object" ? n.value : n), this.unit); }
    div(n) { return mk(this.value / (typeof n === "object" ? n.value : n), this.unit); }
  }
  class CSSUnitValue extends CSSNumericValue {
    constructor(value, unit) { __jb.typedOmCreating = true; try { super(); } finally { __jb.typedOmCreating = false; } value = +value; if (!isFinite(value) && value === value) {} this._v = value; this._u = String(unit).toLowerCase() === "%" ? "percent" : String(unit).toLowerCase(); }
    get value() { return this._v; } set value(v) { this._v = +v; }
    get unit() { return this._u; }
    toString() { return String(this._v) + (this._u === "percent" ? "%" : this._u === "number" ? "" : this._u); }
  }
  var mk = function (v, u) { return new CSSUnitValue(v, u); };
  ["number", "percent", "px", "em", "rem", "vw", "vh", "ms", "s", "deg", "rad", "turn", "fr"].forEach(function (u) { CSS[u] = function (v) { return mk(v, u); }; });
  [CSSStyleValue, CSSNumericValue, CSSUnitValue].forEach(function (C) { Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true }); });
  Object.assign(globalThis, { CSSStyleValue: CSSStyleValue, CSSNumericValue: CSSNumericValue, CSSUnitValue: CSSUnitValue });
  ["CSSStyleValue", "CSSNumericValue", "CSSUnitValue"].forEach(function (n) { var d = Object.getOwnPropertyDescriptor(globalThis, n); if (d) { d.enumerable = false; Object.defineProperty(globalThis, n, d); } });
})();
(function () {
  var A = __jb.anim = {};
  var dom = function (name, msg) { return __jb.domError(name, msg); };
  var FRAME = 16;
  A.frameTime = function () { return Math.floor(((__jb.clock || 0) + 0.002) / FRAME) * FRAME; };
  var isNum = function (v) { return typeof v === "number" && v === v; };
  // numeric time of a timeline (ms, or percent for progress-based timelines); null when inactive
  A.tlNow = function (tl) { if (!tl) return null; var v = tl._currentTime(); return v === null || v === undefined ? null : +v; };
  A.isProgress = function (tl) { return !!tl && typeof tl._progressBased === "function" && tl._progressBased(); };
  var pct = function (v) { return v === null || v === undefined ? null : (typeof CSS !== "undefined" && typeof CSS.percent === "function" ? CSS.percent(v) : v); };
  // CSSNumberish input -> number (ms for time-based timelines, percent for progress-based ones)
  A.numberish = function (v, progress) {
    if (v === null || v === undefined) return null;
    if (typeof v === "object" && typeof v.unit === "string") {
      var u = v.unit, x = +v.value;
      if (progress) { if (u !== "percent") throw new TypeError("A percentage is required for a progress-based timeline"); return x; }
      if (u === "ms" || u === "number") return x; if (u === "s") return x * 1000;
      throw new TypeError("Invalid time value");
    }
    if (progress) throw new TypeError("A CSSNumericValue percentage is required for a progress-based timeline");
    return +v;
  };
  var animations = A.all = []; // every animation that may still matter (not idle-and-unreferenced)
  var animIndex = 0;

  // ------------------------------------------------------------------ easing
  function cubicBezier(x1, y1, x2, y2) {
    var cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    var cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    var sx = function (t) { return ((ax * t + bx) * t + cx) * t; };
    var sy = function (t) { return ((ay * t + by) * t + cy) * t; };
    var dx = function (t) { return (3 * ax * t + 2 * bx) * t + cx; };
    var solve = function (x) {
      var t = x, i;
      for (i = 0; i < 8; i++) { var e = sx(t) - x; if (Math.abs(e) < 1e-7) return t; var d = dx(t); if (Math.abs(d) < 1e-6) break; t -= e / d; }
      var lo = 0, hi = 1; t = x;
      if (t < lo) return lo; if (t > hi) return hi;
      while (lo < hi) { var v = sx(t); if (Math.abs(v - x) < 1e-7) return t; if (x > v) lo = t; else hi = t; t = (hi - lo) / 2 + lo; if (hi - lo < 1e-9) break; }
      return t;
    };
    return function (x) {
      if (x <= 0) { var s0 = x1 > 0 ? y1 / x1 : (y1 === 0 && x2 > 0 ? y2 / x2 : 0); return s0 * x; }
      if (x >= 1) { var s1 = x2 < 1 ? (y2 - 1) / (x2 - 1) : (x2 === 1 && x1 < 1 ? (y1 - 1) / (x1 - 1) : 0); return 1 + s1 * (x - 1); }
      return sy(solve(x));
    };
  }
  function stepsFn(n, pos) {
    return function (x, before) {
      var jumps = pos === "jump-none" ? n - 1 : pos === "jump-both" ? n + 1 : n;
      var step = Math.floor(x * n);
      if (pos === "jump-start" || pos === "jump-both") step += 1;
      if (before && Math.floor(x * n) === x * n) step -= 1;
      if (x >= 0 && step < 0) step = 0;
      if (x <= 1 && step > jumps) step = jumps;
      return step / jumps;
    };
  }
  function linearFn(points) {
    return function (x) {
      if (points.length === 1) return points[0][0];
      var i;
      if (x < points[0][1]) { var a = points[0], b = points[1]; return b[1] === a[1] ? a[0] : a[0] + (b[0] - a[0]) * (x - a[1]) / (b[1] - a[1]); }
      for (i = points.length - 1; i > 0; i--) if (x >= points[i - 1][1] && x <= points[i][1] && !(points[i][1] === x && i < points.length - 1 && points[i + 1][1] === x)) break;
      if (x > points[points.length - 1][1]) i = points.length - 1;
      var p = points[i - 1], q = points[i];
      if (q[1] === p[1]) return q[0];
      return p[0] + (q[0] - p[0]) * (x - p[1]) / (q[1] - p[1]);
    };
  }
  var NAMED = { linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], "ease-in": [0.42, 0, 1, 1], "ease-out": [0, 0, 0.58, 1], "ease-in-out": [0.42, 0, 0.58, 1] };
  // Parse a CSS <easing-function>: { fn, text } or null when invalid.
  A.parseEasing = function (text) {
    var s = String(text).trim(), l = s.toLowerCase();
    if (l === "linear") return { fn: function (x) { return x; }, text: "linear" };
    if (NAMED[l]) { var nb = NAMED[l]; return { fn: cubicBezier(nb[0], nb[1], nb[2], nb[3]), text: l }; }
    if (l === "step-start") return { fn: stepsFn(1, "jump-start"), text: "steps(1, start)" };
    if (l === "step-end") return { fn: stepsFn(1, "jump-end"), text: "steps(1)" };
    var m = /^cubic-bezier\(\s*([^,]+),([^,]+),([^,]+),([^,]+)\)$/i.exec(s);
    if (m) {
      var v = [m[1], m[2], m[3], m[4]].map(function (x) { x = x.trim(); return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(x) ? parseFloat(x) : NaN; });
      if (v.some(function (x) { return !isFinite(x); }) || v[0] < 0 || v[0] > 1 || v[2] < 0 || v[2] > 1) return null;
      return { fn: cubicBezier(v[0], v[1], v[2], v[3]), text: "cubic-bezier(" + v.join(", ") + ")" };
    }
    m = /^steps\(\s*([^,)]+)\s*(?:,\s*([a-z-]+)\s*)?\)$/i.exec(s);
    if (m) {
      if (!/^\+?\d+$/.test(m[1].trim())) return null;
      var n = parseInt(m[1], 10), pos = (m[2] || "end").toLowerCase();
      if (pos === "start") pos = "jump-start"; else if (pos === "end") pos = "jump-end";
      if (!/^jump-(start|end|none|both)$/.test(pos)) return null;
      if (n < 1 || (pos === "jump-none" && n < 2)) return null;
      var txt = pos === "jump-end" ? "steps(" + n + ")" : "steps(" + n + ", " + (m[2] || "").toLowerCase() + ")";
      return { fn: stepsFn(n, pos), text: txt, step: true };
    }
    m = /^linear\((.*)\)$/i.exec(s);
    if (m) {
      var parts = m[1].split(","), pts = [];
      for (var i = 0; i < parts.length; i++) {
        var toks = parts[i].trim().split(/\s+/);
        if (!toks[0]) return null;
        var out = parseFloat(toks[0]); if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(toks[0])) return null;
        var ins = toks.slice(1).map(function (t) { var pm = /^([+-]?(\d+\.?\d*|\.\d+))%$/.exec(t); return pm ? parseFloat(pm[1]) / 100 : NaN; });
        if (ins.some(isNaN) || ins.length > 2) return null;
        if (!ins.length) pts.push([out, null]); else ins.forEach(function (x) { pts.push([out, x]); });
      }
      if (pts.length < 2) return null;
      if (pts[0][1] === null) pts[0][1] = 0;
      if (pts[pts.length - 1][1] === null) pts[pts.length - 1][1] = 1;
      var maxSoFar = 0;
      for (i = 0; i < pts.length; i++) { if (pts[i][1] !== null) { if (pts[i][1] < maxSoFar) pts[i][1] = maxSoFar; maxSoFar = pts[i][1]; } }
      for (i = 0; i < pts.length; i++) if (pts[i][1] === null) { var j = i; while (pts[j][1] === null) j++; var a0 = pts[i - 1][1], a1 = pts[j][1]; for (var k = i; k < j; k++) pts[k][1] = a0 + (a1 - a0) * (k - i + 1) / (j - i + 1); i = j; }
      return { fn: linearFn(pts), text: "linear(" + m[1].trim().replace(/\s*,\s*/g, ", ") + ")" };
    }
    return null;
  };
  var easingOrThrow = function (text) { var e = A.parseEasing(text); if (!e) throw new TypeError("Invalid easing '" + text + "'"); return e; };

  // ------------------------------------------------------------------ timing
  var FILLS = ["none", "forwards", "backwards", "both", "auto"], DIRS = ["normal", "reverse", "alternate", "alternate-reverse"];
  function enumOf(v, list, what) { v = String(v); if (list.indexOf(v) < 0) throw new TypeError("Invalid " + what + " '" + v + "'"); return v; }
  // Apply an OptionalEffectTiming / EffectTiming dictionary to `t` (validation first, then assignment).
  A.applyTiming = function (t, o, isUpdate) {
    if (o === undefined || o === null) return t;
    if (typeof o !== "object" && typeof o !== "function") throw new TypeError("Timing must be an object");
    var n = {};
    // dictionary members are read in lexicographic order
    var get = function (k) { return o[k]; };
    var delay = get("delay"), direction = get("direction"), duration = get("duration"), easing = get("easing"), endDelay = get("endDelay"), fill = get("fill"), iterationStart = get("iterationStart"), iterations = get("iterations");
    if (delay !== undefined) { n.delay = +delay; if (!isFinite(n.delay)) throw new TypeError("delay must be finite"); }
    if (direction !== undefined) n.direction = enumOf(direction, DIRS, "direction");
    if (duration !== undefined) {
      if (typeof duration === "string") { if (duration !== "auto") throw new TypeError("Invalid duration"); n.duration = "auto"; }
      else { n.duration = +duration; if (n.duration !== n.duration || n.duration < 0) throw new TypeError("Invalid duration"); }
    }
    if (easing !== undefined) n.easing = easingOrThrow(easing);
    if (endDelay !== undefined) { n.endDelay = +endDelay; if (!isFinite(n.endDelay)) throw new TypeError("endDelay must be finite"); }
    if (fill !== undefined) n.fill = enumOf(fill, FILLS, "fill");
    if (iterationStart !== undefined) { n.iterationStart = +iterationStart; if (!isFinite(n.iterationStart) || n.iterationStart < 0) throw new TypeError("Invalid iterationStart"); }
    if (iterations !== undefined) { n.iterations = +iterations; if (n.iterations !== n.iterations || n.iterations < 0) throw new TypeError("Invalid iterations"); }
    Object.keys(n).forEach(function (k) { t[k] = n[k]; });
    return t;
  };
  A.defaultTiming = function () { return { delay: 0, endDelay: 0, fill: "auto", iterationStart: 0, iterations: 1, duration: "auto", direction: "normal", easing: A.parseEasing("linear") }; };
  // timing of an effect for its animation's timeline: on a progress-based timeline the times are
  // proportions of the timeline (100%): auto durations fill it, time values are scaled
  A.effTiming = function (e) {
    var t = e._timing, a = e._animation;
    if (!a || !A.isProgress(a._s.timeline)) return t;
    var n = {}; for (var k in t) n[k] = t[k];
    var iters = t.iterations;
    if (t.duration === "auto") {
      n.delay = 0; n.endDelay = 0;
      n.duration = iters > 0 && isFinite(iters) ? 100 / iters : 0;
    } else {
      var total = t.delay + t.duration * iters + t.endDelay;
      var scale = total > 0 && isFinite(total) ? 100 / total : 0;
      n.delay = t.delay * scale; n.endDelay = t.endDelay * scale; n.duration = t.duration * scale;
    }
    n._progress = true;
    return n;
  };
  function iterDuration(t) { return t.duration === "auto" ? 0 : t.duration; }
  function activeDuration(t) { var d = iterDuration(t); return d === 0 || t.iterations === 0 ? 0 : d * t.iterations; }
  function endTime(t) { return Math.max(t.delay + activeDuration(t) + t.endDelay, 0); }
  A.endTime = endTime; A.activeDuration = activeDuration;
  // Computed timing of an effect at `local` time; `forwards` = animation direction is forwards.
  A.computeTiming = function (t, local, forwards, fillAuto) {
    var ad = activeDuration(t), et = endTime(t), d = iterDuration(t);
    var fill = t.fill === "auto" ? (fillAuto || "none") : t.fill;
    var r = { delay: t.delay, endDelay: t.endDelay, fill: fill, iterationStart: t.iterationStart, iterations: t.iterations, duration: d, direction: t.direction, easing: t.easing.text, endTime: et, activeDuration: ad, localTime: local, progress: null, currentIteration: null, phase: "idle", activeTime: null };
    if (local === null || local === undefined) { r.localTime = null; return r; }
    var beforeB = Math.max(Math.min(t.delay, et), 0), afterB = Math.max(Math.min(t.delay + ad, et), 0);
    var phase;
    if (local < beforeB || (!forwards && local === beforeB)) phase = "before";
    else if (local > afterB || (forwards && local === afterB)) phase = "after";
    else phase = "active";
    r.phase = phase;
    var at = null;
    if (phase === "before") { if (fill === "backwards" || fill === "both") at = Math.max(local - t.delay, 0); }
    else if (phase === "active") at = local - t.delay;
    else if (fill === "forwards" || fill === "both") at = Math.max(Math.min(local - t.delay, ad), 0);
    r.activeTime = at;
    if (at === null) return r;
    var overall;
    if (d === 0) overall = phase === "before" ? t.iterationStart : t.iterationStart + t.iterations;
    else overall = at / d + t.iterationStart;
    var simple = overall === Infinity ? t.iterationStart % 1 : overall % 1;
    if (simple === 0 && (phase === "active" || phase === "after") && at === ad && t.iterations !== 0 && overall !== 0) simple = 1;
    var cur;
    if (phase === "after" && t.iterations === Infinity) cur = Infinity;
    else if (simple === 1) cur = Math.floor(overall) - 1;
    else cur = Math.floor(overall);
    var dirForwards = t.direction === "normal" ? true : t.direction === "reverse" ? false : ((t.direction === "alternate") === (cur === Infinity ? true : cur % 2 === 0));
    if (cur === Infinity && (t.direction === "alternate" || t.direction === "alternate-reverse")) dirForwards = t.direction === "alternate";
    var directed = dirForwards ? simple : 1 - simple;
    var before = (phase === "before" && dirForwards) || (phase === "after" && !dirForwards);
    var p = t.easing.fn(directed, before);
    r.progress = p; r.currentIteration = cur;
    return r;
  };

  // ------------------------------------------------------------------ timelines
  class AnimationTimeline {
    constructor() { if (!A.constructingTimeline) throw new TypeError("Illegal constructor"); }
    get currentTime() { return this._currentTime(); }
    get duration() { return null; }
    _currentTime() { return null; }
  }
  class DocumentTimeline extends AnimationTimeline {
    constructor(options) {
      A.constructingTimeline = true;
      try { super(); } finally { A.constructingTimeline = false; }
      var origin = 0;
      if (options !== undefined && options !== null) { if (typeof options !== "object") throw new TypeError("options must be an object"); if (options.originTime !== undefined) origin = +options.originTime; }
      Object.defineProperty(this, "_origin", { value: origin });
      Object.defineProperty(this, "_doc", { value: __jb.docTimelineDoc || null, writable: true });
    }
    _currentTime() {
      var d = this._doc;
      if (d && d !== __jb.currentDocument && !d.defaultView) return null; // a document without a browsing context: inactive (null _doc: this window's document) // a document without a browsing context: inactive
      return A.frameTime() - this._origin;
    }
  }
  A.isMonotonic = function (tl) { return tl instanceof DocumentTimeline; };
  A.documentTimeline = new DocumentTimeline();
  Object.defineProperty(Document.prototype, "timeline", { get: function () { if (this === __jb.currentDocument) return A.documentTimeline; if (!this._timeline) { __jb.docTimelineDoc = this; try { this._timeline = new DocumentTimeline(); } finally { __jb.docTimelineDoc = null; } } return this._timeline; }, enumerable: true, configurable: true });

  // ------------------------------------------------------------------ keyframes
  var camelToCss = function (p) {
    if (p === "cssFloat") return "float";
    if (p === "cssOffset") return "offset";
    if (p.indexOf("--") === 0) return p;
    return p.replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); });
  };
  var cssToCamel = function (p) {
    if (p === "float") return "cssFloat";
    if (p === "offset") return "cssOffset";
    if (p.indexOf("--") === 0) return p;
    return p.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
  };
  A.camelToCss = camelToCss; A.cssToCamel = cssToCamel;
  // Animatable properties: anything that looks like a CSS property in camelCase (not "offset",
  // "easing", "composite" and not prefixed / unknown forms).
  var NOT_ANIMATABLE = { display: 0, "animation": 1, "animation-name": 1, "animation-duration": 1, "animation-delay": 1, "animation-iteration-count": 1, "animation-direction": 1, "animation-fill-mode": 1, "animation-play-state": 1, "animation-timing-function": 1, "animation-composition": 1, "animation-timeline": 1, "transition": 1, "transition-property": 1, "transition-duration": 1, "transition-delay": 1, "transition-timing-function": 1, "transition-behavior": 1, "will-change": 1, "direction": 1, "unicode-bidi": 1, "writing-mode": 1, "text-orientation": 1, "text-combine-upright": 1, "all": 1 };
  var isPropertyName = function (k) {
    if (k === "offset" || k === "easing" || k === "composite" || k === "computedOffset") return false;
    if (k.indexOf("--") === 0) return true;
    if (!/^[a-z][a-zA-Z]*$/.test(k)) return false;
    if (/^(webkit|moz|ms|o)[A-Z]/.test(k) && k !== "webkitTextStrokeColor") return false;
    if (k === "float") return false;
    var css = camelToCss(k);
    if (NOT_ANIMATABLE[css] === 1) return false;
    return A.knownProperty(css);
  };
  A.knownProperty = function (css) {
    if (css === "display") return true;
    return __jb.KNOWN_CSS_PROPERTIES ? !!__jb.KNOWN_CSS_PROPERTIES[css] : /^[a-z-]+$/.test(css);
  };
  var COMPOSITES = ["replace", "add", "accumulate", "auto"];
  // "Process a keyframes argument" into [{offset, easing, composite, props:{css: value}}].
  A.processKeyframes = function (obj) {
    if (obj === null || obj === undefined) return [];
    if (typeof obj !== "object" && typeof obj !== "function") throw new TypeError("Keyframes must be an object");
    var iter = obj[Symbol.iterator];
    var frames = [];
    if (iter !== undefined && iter !== null) {
      if (typeof iter !== "function") throw new TypeError("Keyframes iterator is not callable");
      var it = iter.call(obj), step;
      while (!(step = it.next()).done) {
        var kf = step.value;
        if (kf !== null && kf !== undefined && typeof kf !== "object" && typeof kf !== "function") throw new TypeError("Keyframe must be an object");
        frames.push(readKeyframe(kf || {}, false));
      }
      // offsets: nullable doubles in [0,1], non-decreasing
      var prev = -Infinity;
      frames.forEach(function (f) {
        if (f.offset !== null) {
          if (f.offset < 0 || f.offset > 1) throw new TypeError("Offsets must be in [0, 1]");
          if (f.offset < prev) throw new TypeError("Offsets must be loosely sorted");
          prev = f.offset;
        }
      });
    } else {
      var pi = readKeyframe(obj, true);
      var props = Object.keys(pi.props).sort();
      var byOffset = [];
      props.forEach(function (p) {
        var vals = pi.props[p];
        if (!vals.length) return;
        if (vals.length === 1) { byOffset.push({ off: 1, prop: p, value: vals[0] }); return; }
        vals.forEach(function (v, i) { byOffset.push({ off: i / (vals.length - 1), prop: p, value: v }); });
      });
      byOffset.sort(function (a, b) { return a.off - b.off; });
      byOffset.forEach(function (e) {
        var last = frames[frames.length - 1];
        if (last && last.computedOffset === e.off) last.props[e.prop] = e.value;
        else { var nf = { offset: null, computedOffset: e.off, easing: "linear", composite: "auto", props: {} }; nf.props[e.prop] = e.value; frames.push(nf); }
      });
      var offsets = pi.offsetList, easings = pi.easingList, comps = pi.compositeList;
      frames.forEach(function (f, i) { if (offsets && i < offsets.length) f.offset = offsets[i]; });
      if (offsets) offsets.forEach(function (o) { if (o !== null && (o < 0 || o > 1)) throw new TypeError("Offsets must be in [0, 1]"); });
      if (offsets) { var pv = -Infinity; offsets.forEach(function (o) { if (o !== null) { if (o < pv) throw new TypeError("Offsets must be loosely sorted"); pv = o; } }); }
      if (easings && easings.length) { frames.forEach(function (f, i) { f.easing = easings[i % easings.length]; }); }
      if (comps && comps.length) { frames.forEach(function (f, i) { f.composite = comps[i % comps.length]; }); }
      if (offsets && offsets.length > frames.length) { /* extra offsets are ignored */ }
      if (easings) easings.forEach(function (e) { easingOrThrow(e); });
    }
    frames.forEach(function (f) { f.easingParsed = easingOrThrow(f.easing); f.easing = f.easingParsed.text; });
    A.computeOffsets(frames);
    return frames;
  };
  function readKeyframe(kf, indexed) {
    var out = { offset: null, easing: "linear", composite: "auto", props: {} };
    // offset, easing, composite first (dictionary order: composite, easing, offset)
    var comp = kf.composite, eas = kf.easing, off = kf.offset;
    if (indexed) {
      out.compositeList = comp === undefined ? null : (Array.isArray(comp) ? comp : [comp]).map(function (c) { return c === null ? "auto" : enumOf(c, COMPOSITES, "composite"); });
      out.easingList = eas === undefined ? null : (Array.isArray(eas) ? eas : [eas]).map(String);
      out.offsetList = off === undefined ? null : (off !== null && typeof off === "object" && typeof off[Symbol.iterator] === "function" ? __jb.arrayFrom(off) : [off]).map(function (o) { if (o === null) return null; var n = +o; if (!isFinite(n)) throw new TypeError("Offset must be finite"); return n; });
    } else {
      if (comp !== undefined && comp !== null) out.composite = enumOf(comp, COMPOSITES, "composite");
      if (eas !== undefined) out.easing = String(eas);
      if (off !== undefined && off !== null) { var n = +off; if (!isFinite(n)) throw new TypeError("Offset must be finite"); out.offset = n; }
    }
    var keys = [];
    for (var k in kf) keys.push(k);
    keys = keys.filter(isPropertyName).sort();
    keys.forEach(function (k) {
      var v = kf[k], css = camelToCss(k);
      if (indexed) {
        var list = v !== null && typeof v === "object" && typeof v[Symbol.iterator] === "function" && typeof v !== "string" ? __jb.arrayFrom(v).map(String) : [String(v)];
        out.props[css] = list;
      } else {
        if (v !== null && typeof v === "object" && typeof v[Symbol.iterator] === "function") v = __jb.arrayFrom(v).map(String).join(",");
        out.props[css] = String(v);
      }
    });
    return out;
  }
  A.computeOffsets = function (frames) {
    if (!frames.length) return frames;
    frames.forEach(function (f) { f.computedOffset = f.offset; });
    if (frames.length > 1 && frames[0].computedOffset === null) frames[0].computedOffset = 0;
    if (frames[frames.length - 1].computedOffset === null) frames[frames.length - 1].computedOffset = frames.length === 1 ? 1 : 1;
    for (var i = 1; i < frames.length; i++) {
      if (frames[i].computedOffset !== null) continue;
      var j = i; while (frames[j].computedOffset === null) j++;
      var a = frames[i - 1].computedOffset, b = frames[j].computedOffset;
      for (var k = i; k < j; k++) frames[k].computedOffset = a + (b - a) * (k - i + 1) / (j - i + 1);
      i = j;
    }
    return frames;
  };

  // ------------------------------------------------------------------ CSS values
  var NUM = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?";
  var reLen = new RegExp("^(" + NUM + ")(px|em|rem|%|vw|vh|vmin|vmax|pt|pc|in|cm|mm|q|ex|ch|deg|rad|grad|turn|s|ms|fr)?$", "i");
  var UNIT_PX = { px: 1, pt: 4 / 3, pc: 16, "in": 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };
  var ANGLE_DEG = { deg: 1, rad: 180 / Math.PI, grad: 0.9, turn: 360 };
  function fontSizeOf(el) { var v = parseFloat(baseValue(el, "font-size")); return isFinite(v) ? v : 16; }
  function rootFontSize() { var r = __jb.currentDocument.documentElement; return r ? fontSizeOf(r) : 16; }
  // A typed animation value: {t:"num", v}, {t:"len", v, pct}, {t:"color", c:[r,g,b,a]}, {t:"tf", fns}, {t:"list", items}, {t:"raw", s}
  // CSS-wide keywords in keyframes resolve against the target (initial value / parent value)
  var INHERITED = /^(color|font|font-size|font-weight|font-style|font-family|font-stretch|font-size-adjust|line-height|letter-spacing|word-spacing|text-indent|text-align|text-shadow|text-transform|visibility|white-space|cursor|direction|quotes|list-style.*|caret-color|fill|fill-opacity|stroke|stroke-.*|tab-size|orphans|widows|text-decoration-thickness|text-underline-offset|word-break|overflow-wrap|hyphens|accent-color|color-scheme)$/;
  var INITIAL_VALUES = { "z-index": "auto", opacity: "1", visibility: "visible", "vertical-align": "baseline", "flex-grow": "0", "flex-shrink": "1", order: "0", "font-weight": "400", "line-height": "normal", "letter-spacing": "normal", "word-spacing": "0px", "text-indent": "0px", "text-shadow": "none", "box-shadow": "none", filter: "none", transform: "none", color: "rgb(0, 0, 0)", "background-color": "rgba(0, 0, 0, 0)", "font-size": "16px", "outline-offset": "0px" };
  function resolveKeyword(s, prop, el) {
    var k = String(s).trim().toLowerCase();
    if (!/^(initial|inherit|unset|revert|revert-layer)$/.test(k)) return s;
    if (k === "unset" || k === "revert" || k === "revert-layer") k = INHERITED.test(prop) ? "inherit" : "initial";
    if (k === "inherit") { var p = el && el.parentElement; if (p) { var v = baseValue(p, prop); if (v) return v; } }
    if (INITIAL_VALUES[prop] !== undefined) return INITIAL_VALUES[prop];
    if (/^(margin|padding|border-.*-width|outline-width|column-gap|row-gap|text-indent)/.test(prop)) return "0px";
    if (/^(top|left|right|bottom|width|height|flex-basis)$/.test(prop)) return "auto";
    if (/color$/.test(prop)) return "rgb(0, 0, 0)";
    return INITIAL[prop] !== undefined ? INITIAL[prop] : s;
  }
  function parseValue(s, prop, el) {
    s = resolveKeyword(String(s).trim(), prop, el);
    if (prop.indexOf("--") === 0) return { t: "raw", s: s };
    if (/color$/.test(prop) || prop === "fill" || prop === "stroke" || prop === "caret-color" || prop === "outline-color" || prop === "text-decoration-color" || prop === "accent-color") {
      if (/^currentcolor$/i.test(s) && el) s = baseValue(el, "color") || "black";
      var c = __jb.parseCssColor ? __jb.parseCssColor(s) : null;
      if (c) return { t: "color", c: [c[0], c[1], c[2], c.length > 3 ? c[3] : 1] };
      return { t: "raw", s: s };
    }
    if (prop === "transform") return parseTransform(s, el);
    if ((SHADOW.test(prop) || prop === "filter" || prop === "backdrop-filter") && /^none$/i.test(s)) return { t: "clist", parts: [], sep: ", " };
    if (prop === "translate" || prop === "scale" || prop === "rotate") {
      if (s === "none") return { t: "raw", s: s };
      var parts = s.split(/\s+/).map(function (x) { return parseLength(x, el, prop); });
      if (parts.some(function (p) { return !p; })) return { t: "raw", s: s };
      return { t: "list", items: parts, sep: " " };
    }
    var l = parseLength(s, el, prop);
    if (l) return l;
    if (/[\s,(]/.test(s)) { var c = parseCompound(s, prop, el); if (c) return c; }
    return { t: "raw", s: s };
  }
  // top-level split on `sep` (outside parentheses)
  function splitTop(s, sepRe) {
    var out = [], depth = 0, cur = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === "(" || ch === "[") depth++; else if (ch === ")" || ch === "]") depth--;
      if (depth === 0 && sepRe.test(ch)) { if (cur.trim() !== "" || sepRe.source === ",") out.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim() !== "") out.push(cur.trim());
    return out;
  }
  var SHADOW = /^(text-shadow|box-shadow)$/;
  function parseToken(tok, prop, el) {
    var l = parseLength(tok, el, prop);
    if (l) return l;
    var fm = /^([a-zA-Z-]+)\((.*)\)$/.exec(tok);
    if (fm && !/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)$/i.test(fm[1])) {
      var args = splitTop(fm[2], /,/).length > 1 ? splitTop(fm[2], /,/) : splitTop(fm[2], /\s/);
      var argOf = function (a) { var ts = splitTop(a, /\s/); return ts.length > 1 ? { t: "list", items: ts.map(function (x) { return parseToken(x, prop, el); }), sep: " " } : parseToken(a, prop, el); };
      return { t: "fn", name: fm[1].toLowerCase(), args: args.map(argOf), sep: splitTop(fm[2], /,/).length > 1 ? ", " : " " };
    }
    if (/^currentcolor$/i.test(tok) && el) tok = baseValue(el, "color") || "black";
    if (!/^[+-]?[\d.]/.test(tok)) { var c = __jb.parseCssColor ? __jb.parseCssColor(tok) : null; if (c && typeof c === "object") return { t: "color", c: [c[0], c[1], c[2], c.length > 3 ? c[3] : 1] }; }
    return { t: "raw", s: tok };
  }
  function parseCompound(s, prop, el) {
    if (prop === "filter" || prop === "backdrop-filter") {
      var fl = splitTop(s, /\s/).map(function (t) { return parseToken(t, prop, el); });
      if (fl.some(function (t) { return t.t !== "fn"; })) return null;
      return { t: "clist", parts: fl, sep: " " };
    }
    var parts = splitTop(s, /,/);
    var lists = parts.map(function (part) {
      var toks = splitTop(part, /\s/).map(function (t) { return parseToken(t, prop, el); });
      if (SHADOW.test(prop)) {
        // computed form: color first, then lengths (inset last)
        var col = toks.filter(function (t) { return t.t === "color"; }), inset = toks.filter(function (t) { return t.t === "raw" && t.s === "inset"; }), lens = toks.filter(function (t) { return t.t === "len" || t.t === "num"; }).map(function (t) { return t.t === "num" ? { t: "len", v: t.v, pct: 0 } : t; });
        if (!col.length) { var cc = __jb.parseCssColor ? __jb.parseCssColor(el ? (baseValue(el, "color") || "black") : "black") : [0, 0, 0, 1]; col = [{ t: "color", c: [cc[0], cc[1], cc[2], cc.length > 3 ? cc[3] : 1] }]; }
        while (lens.length < (prop === "box-shadow" ? 4 : 3)) lens.push({ t: "len", v: 0, pct: 0 });
        toks = col.concat(lens, inset);
      }
      return { t: "list", items: toks, sep: " " };
    });
    if (parts.length === 1 && lists[0].items.length === 1) return lists[0].items[0].t === "raw" ? null : lists[0].items[0];
    return { t: "clist", parts: lists, sep: ", " };
  }
  function parseLength(s, el, prop) {
    var m = reLen.exec(s);
    if (!m) {
      var cm = /^calc\((.*)\)$/i.exec(s);
      if (cm) { var inner = cm[1].trim(); var mm = new RegExp("^(" + NUM + ")%\\s*([+-])\\s*(" + NUM + ")px$").exec(inner); if (mm) return { t: "len", v: (mm[2] === "-" ? -1 : 1) * parseFloat(mm[3]), pct: parseFloat(mm[1]) }; }
      return null;
    }
    var n = parseFloat(m[1]), u = (m[2] || "").toLowerCase();
    if (!u) return { t: "num", v: n };
    if (u === "%") return { t: "len", v: 0, pct: n };
    if (UNIT_PX[u]) return { t: "len", v: n * UNIT_PX[u], pct: 0 };
    if (u === "em") return { t: "len", v: n * (el ? (prop === "font-size" ? fontSizeOf(el.parentElement || el) : fontSizeOf(el)) : 16), pct: 0 };
    if (u === "rem") return { t: "len", v: n * rootFontSize(), pct: 0 };
    if (u === "vw") return { t: "len", v: n * globalThis.innerWidth / 100, pct: 0 };
    if (u === "vh") return { t: "len", v: n * globalThis.innerHeight / 100, pct: 0 };
    if (u === "vmin") return { t: "len", v: n * Math.min(globalThis.innerWidth, globalThis.innerHeight) / 100, pct: 0 };
    if (u === "vmax") return { t: "len", v: n * Math.max(globalThis.innerWidth, globalThis.innerHeight) / 100, pct: 0 };
    if (u === "ex" || u === "ch") return { t: "len", v: n * fontSizeOf(el) / 2, pct: 0 };
    if (ANGLE_DEG[u] !== undefined) return { t: "ang", v: n * ANGLE_DEG[u] };
    if (u === "s") return { t: "time", v: n * 1000 };
    if (u === "ms") return { t: "time", v: n };
    if (u === "fr") return n < 0 ? null : { t: "fr", v: n };
    return null;
  }
  function parseTransform(s, el) {
    if (s === "none" || s === "") return { t: "tf", fns: [] };
    var fns = [], re = /([a-zA-Z0-9]+)\(([^)]*)\)/g, m, consumed = "";
    while ((m = re.exec(s))) {
      consumed += m[0];
      var args = m[2].split(/\s*,\s*|\s+/).filter(Boolean).map(function (a) { return parseLength(a, el, "transform") || { t: "raw", s: a }; });
      fns.push({ name: m[1].toLowerCase(), args: args });
    }
    if (consumed.replace(/\s+/g, "") !== s.replace(/\s+/g, "")) return { t: "raw", s: s };
    return { t: "tf", fns: fns };
  }
  var fmt = function (n) { var r = Math.round(n * 1e6) / 1e6; return String(r === 0 ? 0 : r); };
  function serialize(v, prop) {
    switch (v.t) {
      case "num": return prop === "z-index" || prop === "order" ? String(Math.round(v.v)) : fmt(v.v);
      case "len": return v.pct ? (v.v ? "calc(" + fmt(v.pct) + "% " + (v.v < 0 ? "- " + fmt(-v.v) : "+ " + fmt(v.v)) + "px)" : fmt(v.pct) + "%") : fmt(v.v) + "px";
      case "ang": return fmt(v.v) + "deg";
      case "time": return fmt(v.v / 1000) + "s";
      case "fr": return fmt(v.v) + "fr";
      case "color": {
        var c = v.c.map(function (x, i) { return i < 3 ? Math.round(Math.min(255, Math.max(0, x))) : Math.min(1, Math.max(0, x)); });
        return c[3] >= 1 ? "rgb(" + c[0] + ", " + c[1] + ", " + c[2] + ")" : "rgba(" + c[0] + ", " + c[1] + ", " + c[2] + ", " + fmt(c[3]) + ")";
      }
      case "tf": {
        if (!v.fns.length) return "none";
        var txt = v.fns.map(function (f) { return f.name + "(" + f.args.map(function (a) { return serialize(a, "transform"); }).join(", ") + ")"; }).join(" ");
        if (v.fns.some(function (f) { return f.args.some(function (a) { return a.t === "len" && a.pct; }); })) return txt;
        try { var m = new DOMMatrix(txt); var arr = m.is2D ? [m.a, m.b, m.c, m.d, m.e, m.f] : __jb.arrayFrom(m.toFloat64Array()); return (m.is2D ? "matrix(" : "matrix3d(") + arr.map(fmt).join(", ") + ")"; } catch (e) { return txt; }
      }
      case "list": return v.items.map(function (i) { return serialize(i, prop); }).join(v.sep || " ");
      case "fn": return v.name + "(" + v.args.map(function (a) { return serialize(a, prop); }).join(v.sep || ", ") + ")";
      case "clist":
        if (SHADOW.test(prop)) v = { t: "clist", sep: v.sep, parts: v.parts.map(function (part) { if (part.t !== "list") return part; var lens = 0; return { t: "list", sep: part.sep, items: part.items.map(function (it) { if (it.t === "len") { lens++; if (lens === 3 && it.v < 0) return { t: "len", v: 0, pct: it.pct }; } return it; }) }; }) };
        return v.parts.length ? v.parts.map(function (p) { return serialize(p, prop); }).join(prop === "filter" || prop === "backdrop-filter" ? " " : (v.sep || ", ")) : "none";
      default: return v.s;
    }
  }
  function lerp(a, b, p) { return a + (b - a) * p; }
  // Interpolate two typed values (p may be outside [0,1]); null when not interpolable.
  function interpolate(a, b, p, prop) {
    if (a.t === "num" && b.t === "num") {
      var r = lerp(a.v, b.v, p);
      if (prop === "opacity" || /-opacity$/.test(prop)) r = Math.min(1, Math.max(0, r));
      if ((prop === "z-index" || prop === "order" || prop === "font-weight") && prop !== "font-weight") r = Math.round(r);
      if (prop === "font-weight") r = Math.min(1000, Math.max(1, r));
      if (/^(line-height|flex-grow|flex-shrink|tab-size|orphans|widows)$/.test(prop)) r = Math.max(0, r);
      return { t: "num", v: r };
    }
    if ((a.t === "len" || (a.t === "num" && a.v === 0)) && (b.t === "len" || (b.t === "num" && b.v === 0))) {
      var al = a.t === "len" ? a : { v: 0, pct: 0 }, bl = b.t === "len" ? b : { v: 0, pct: 0 };
      var out = { t: "len", v: lerp(al.v, bl.v, p), pct: lerp(al.pct || 0, bl.pct || 0, p) };
      if (/^(width|height|min-width|min-height|max-width|max-height|padding|font-size|border-.*-width|outline-width|flex-basis|line-height|letter-spacing-never)/.test(prop) && !/^(margin|inset|top|left|right|bottom)/.test(prop)) { if (out.v < 0 && !out.pct) out.v = 0; }
      return out;
    }
    if (a.t === "ang" && b.t === "ang") return { t: "ang", v: lerp(a.v, b.v, p) };
    if (a.t === "time" && b.t === "time") return { t: "time", v: lerp(a.v, b.v, p) };
    if (a.t === "fr" && b.t === "fr") return { t: "fr", v: Math.max(0, lerp(a.v, b.v, p)) };
    if (a.t === "color" && b.t === "color") {
      // premultiplied sRGB
      var aa = a.c[3], ba = b.c[3], oa = lerp(aa, ba, p);
      if (oa <= 0) return { t: "color", c: [0, 0, 0, 0] };
      var ch = [0, 1, 2].map(function (i) { return lerp(a.c[i] * aa, b.c[i] * ba, p) / oa; });
      return { t: "color", c: [ch[0], ch[1], ch[2], Math.min(1, oa)] };
    }
    if (a.t === "raw" && b.t === "raw" && a.s === b.s) return a;
    if (a.t === "fn" && b.t === "fn" && a.name === "repeat" && b.name === "repeat") {
      if (a.args.length !== b.args.length || serialize(a.args[0], prop) !== serialize(b.args[0], prop)) return null;
      var rargs = [a.args[0]];
      for (var ri = 1; ri < a.args.length; ri++) { var rx = interpolate(a.args[ri], b.args[ri], p, prop); if (!rx) return null; rargs.push(rx); }
      return { t: "fn", name: "repeat", args: rargs, sep: a.sep };
    }
    if (a.t === "fn" && b.t === "fn" && a.name === b.name && a.args.length === b.args.length) {
      var fargs = [];
      for (var fi = 0; fi < a.args.length; fi++) { var fx = interpolate(a.args[fi], b.args[fi], p, prop); if (!fx) return null; fargs.push(fx); }
      return { t: "fn", name: a.name, args: fargs, sep: a.sep };
    }
    if (a.t === "clist" || b.t === "clist") {
      var pa = a.t === "clist" ? a.parts : [a.t === "list" ? a : { t: "list", items: [a], sep: " " }], pb = b.t === "clist" ? b.parts : [b.t === "list" ? b : { t: "list", items: [b], sep: " " }];
      if (pa.length !== pb.length) {
        if (!SHADOW.test(prop) && prop !== "filter" && prop !== "backdrop-filter") return null;
        var longer = pa.length > pb.length ? pa : pb, shorter = longer === pa ? pb : pa, padded = shorter.slice();
        for (var pi2 = shorter.length; pi2 < longer.length; pi2++) padded.push(neutralOf(longer[pi2]));
        if (longer === pa) pb = padded; else pa = padded;
      }
      var outParts = [];
      for (var k2 = 0; k2 < pa.length; k2++) { var ip = interpolate(pa[k2], pb[k2], p, prop); if (!ip) return null; outParts.push(ip); }
      return { t: "clist", parts: outParts, sep: ", " };
    }
    if (GRID_TEMPLATE.test(prop) && a.t === "list" && b.t === "list") return gridCombine(a, b, p < 0.5 ? a : b, function (x, y) { return interpolate(x, y, p, prop) || ((x.t === "fn" && x.name === "repeat") || (y.t === "fn" && y.name === "repeat") ? null : p < 0.5 ? x : y); });
    if (a.t === "list" && b.t === "list" && a.items.length === b.items.length) {
      var items = [];
      for (var i = 0; i < a.items.length; i++) { var x = interpolate(a.items[i], b.items[i], p, prop); if (!x && /^grid-template-(rows|columns)$/.test(prop)) x = p < 0.5 ? a.items[i] : b.items[i]; if (!x) return null; items.push(x); }
      return { t: "list", items: items, sep: a.sep };
    }
    if (a.t === "tf" && b.t === "tf") {
      var fa = a.fns, fb = b.fns;
      if (!fa.length && fb.length) fa = fb.map(identityFn);
      if (!fb.length && fa.length) fb = fa.map(identityFn);
      if (fa.length === fb.length && fa.every(function (f, i) { return primitive(f.name) === primitive(fb[i].name) && f.args.length === fb[i].args.length; })) {
        var fns = [];
        for (var j = 0; j < fa.length; j++) {
          var na = fa[j], nb2 = fb[j], args = [];
          for (var q = 0; q < na.args.length; q++) { var ia = interpolate(na.args[q], nb2.args[q], p, "transform"); if (!ia) return null; args.push(ia); }
          fns.push({ name: na.name === nb2.name ? na.name : primitive(na.name), args: args });
        }
        return { t: "tf", fns: fns };
      }
      // fall back to matrix interpolation of the 2D matrices (component-wise)
      var ma = tfMatrix(fa), mb = tfMatrix(fb);
      if (ma && mb) return { t: "tf", fns: [{ name: "matrix", args: ma.map(function (x, k) { return { t: "num", v: lerp(x, mb[k], p) }; }) }] };
      return null;
    }
    return null;
  }
  // the neutral (zero) form of a shadow / filter item, used to pad shorter lists
  function neutralOf(item) {
    var z = function (t) { return t.t === "len" ? { t: "len", v: 0, pct: 0 } : t.t === "num" ? { t: "num", v: 0 } : t.t === "color" ? { t: "color", c: [0, 0, 0, 0] } : t.t === "fn" ? { t: "fn", name: t.name, args: t.args.map(function (x) { return /^(brightness|contrast|opacity|saturate)$/.test(t.name) && x.t === "num" ? { t: "num", v: 1 } : z(x); }), sep: t.sep } : t; };
    return item.t === "list" ? { t: "list", items: item.items.map(z), sep: item.sep } : z(item);
  }
  function primitive(n) { return /^translate[xy]?$/.test(n) ? "translate" : /^scale[xy]?$/.test(n) ? "scale" : n; }
  function identityFn(f) {
    var zero = function (a) { return a.t === "len" ? { t: "len", v: 0, pct: 0 } : a.t === "ang" ? { t: "ang", v: 0 } : { t: "num", v: /^scale/.test(f.name) ? 1 : 0 }; };
    if (f.name === "matrix") return { name: "matrix", args: [1, 0, 0, 1, 0, 0].map(function (v) { return { t: "num", v: v }; }) };
    return { name: f.name, args: f.args.map(zero) };
  }
  function tfMatrix(fns) {
    try {
      var m = new DOMMatrix();
      var txt = fns.map(function (f) { return f.name + "(" + f.args.map(function (a) { return serialize(a, "transform"); }).join(", ") + ")"; }).join(" ");
      m = new DOMMatrix(txt || "none");
      return [m.a, m.b, m.c, m.d, m.e, m.f];
    } catch (e) { return null; }
  }
  var GRID_TEMPLATE = /^grid-template-(rows|columns)$/;
  function isLineNames(t) { return t.t === "raw" && /^\[/.test(t.s); }
  // combine two track lists item by item, ignoring [line names]; names (and anything that does not
  // combine) come from `names`
  function gridCombine(a, b, names, fn) {
    var ta = a.items.filter(function (t) { return !isLineNames(t); }), tb = b.items.filter(function (t) { return !isLineNames(t); });
    if (ta.length !== tb.length) return null;
    var out = [], k = 0;
    for (var i = 0; i < names.items.length; i++) {
      var it = names.items[i];
      if (isLineNames(it)) { out.push(it); continue; }
      var r = fn(ta[k], tb[k]); k++;
      if (!r) return null;
      out.push(r);
    }
    return { t: "list", items: out, sep: " " };
  }
  function addValues(a, b, prop, accumulate) {
    if (GRID_TEMPLATE.test(prop) && a.t === "list" && b.t === "list") return gridCombine(a, b, b, function (x, y) { return addValues(x, y, prop, accumulate) || y; });
    if (a.t === "num" && b.t === "num") return interpolate({ t: "num", v: a.v + b.v }, { t: "num", v: a.v + b.v }, 0, prop);
    if ((a.t === "len" || a.t === "num") && (b.t === "len" || b.t === "num")) { var al = a.t === "len" ? a : { v: a.v, pct: 0 }, bl = b.t === "len" ? b : { v: b.v, pct: 0 }; return { t: "len", v: al.v + bl.v, pct: (al.pct || 0) + (bl.pct || 0) }; }
    if (a.t === "ang" && b.t === "ang") return { t: "ang", v: a.v + b.v };
    if (a.t === "fr" && b.t === "fr") return { t: "fr", v: a.v + b.v };
    if (a.t === "color" && b.t === "color") return { t: "color", c: [a.c[0] + b.c[0], a.c[1] + b.c[1], a.c[2] + b.c[2], Math.min(1, a.c[3] + b.c[3])] };
    if (a.t === "tf" && b.t === "tf") {
      if (accumulate && a.fns.length === b.fns.length && a.fns.every(function (f, i) { return f.name === b.fns[i].name; })) {
        return { t: "tf", fns: a.fns.map(function (f, i) { return { name: f.name, args: f.args.map(function (x, k) { var y = b.fns[i].args[k]; return /^scale/.test(f.name) && x.t === "num" ? { t: "num", v: x.v + y.v - 1 } : addValues(x, y, "transform") || y; }) }; }) };
      }
      return { t: "tf", fns: a.fns.concat(b.fns) };
    }
    if (a.t === "list" && b.t === "list" && a.items.length === b.items.length) return { t: "list", items: a.items.map(function (x, i) { return addValues(x, b.items[i], prop, accumulate) || b.items[i]; }), sep: a.sep };
    if (a.t === "clist" || b.t === "clist") {
      var la = a.t === "clist" ? a.parts : [a], lb = b.t === "clist" ? b.parts : [b];
      // only shadow and filter lists add by concatenation; other lists add item by item
      var concatAdd = SHADOW.test(prop) || prop === "filter" || prop === "backdrop-filter";
      if ((accumulate || !concatAdd) && la.length === lb.length) return { t: "clist", parts: la.map(function (x, i) { return addValues(x, lb[i], prop, accumulate) || lb[i]; }), sep: a.t === "clist" ? a.sep : ", " };
      if (!concatAdd) return null;
      return { t: "clist", parts: la.concat(lb), sep: ", " };
    }
    if (a.t === "fn" && b.t === "fn" && a.name === "repeat" && b.name === "repeat") {
      if (a.args.length !== b.args.length || serialize(a.args[0], prop) !== serialize(b.args[0], prop)) return null;
      return { t: "fn", name: "repeat", args: a.args.map(function (x, i) { return i === 0 ? x : addValues(x, b.args[i], prop, accumulate) || b.args[i]; }), sep: a.sep };
    }
    if (a.t === "fn" && b.t === "fn" && a.name === b.name) return { t: "fn", name: a.name, args: a.args.map(function (x, i) { return addValues(x, b.args[i], prop, accumulate) || b.args[i]; }), sep: a.sep };
    return null;
  }

  // underlying (non-animated) computed value of a property
  function baseValue(el, prop) {
    var v = null;
    A.baseDepth = (A.baseDepth || 0) + 1;
    try { v = A.rawComputed ? A.rawComputed(el, prop) : null; } finally { A.baseDepth--; }
    if (v === null || v === undefined) { try { v = el.style ? el.style.getPropertyValue(prop) : ""; } catch (e) { v = ""; } if (!v) v = INITIAL[prop] !== undefined ? INITIAL[prop] : ""; }
    return v;
  }
  var INITIAL = { opacity: "1", "margin-left": "0px", "margin-right": "0px", "margin-top": "0px", "margin-bottom": "0px", left: "auto", top: "auto", right: "auto", bottom: "auto", width: "auto", height: "auto", transform: "none", color: "rgb(0, 0, 0)", "background-color": "rgba(0, 0, 0, 0)", "font-size": "16px", "z-index": "auto", visibility: "visible", translate: "none", rotate: "none", scale: "none", "line-height": "normal", filter: "none" };

  // ------------------------------------------------------------------ effects
  class AnimationEffect {
    constructor() { if (!A.constructingEffect) throw new TypeError("Illegal constructor"); }
    getTiming() {
      var t = this._timing;
      return { delay: t.delay, endDelay: t.endDelay, fill: t.fill, iterationStart: t.iterationStart, iterations: t.iterations, duration: t.duration, direction: t.direction, easing: t.easing.text };
    }
    getComputedTiming() {
      var anim = this._animation, local = anim ? currentTimeOfA(anim) : null;
      var fwd = !anim || anim.playbackRate >= 0;
      var r = A.computeTiming(A.effTiming(this), local, fwd, "none");
      if (anim && A.isProgress(anim._s.timeline)) {
        var t0 = this._timing;
        return { delay: t0.delay, endDelay: t0.endDelay, fill: r.fill, iterationStart: r.iterationStart, iterations: r.iterations, duration: pct(r.duration), direction: r.direction, easing: r.easing, endTime: pct(r.endTime), activeDuration: pct(r.activeDuration), localTime: pct(r.localTime), progress: r.progress, currentIteration: r.currentIteration };
      }
      return { delay: r.delay, endDelay: r.endDelay, fill: r.fill, iterationStart: r.iterationStart, iterations: r.iterations, duration: r.duration, direction: r.direction, easing: r.easing, endTime: r.endTime, activeDuration: r.activeDuration, localTime: r.localTime, progress: r.progress, currentIteration: r.currentIteration };
    }
    updateTiming(timing) {
      A.applyTiming(this._timing, timing === undefined ? {} : timing, true);
      if (this._animation) A.updateFinished(this._animation, false, false);
      A.invalidate(this);
    }
  }
  class KeyframeEffect extends AnimationEffect {
    constructor(target, keyframes, options) {
      if (arguments.length < 2) throw new TypeError("KeyframeEffect: 2 arguments required");
      A.constructingEffect = true;
      try { super(); } finally { A.constructingEffect = false; }
      Object.defineProperty(this, "_timing", { value: A.defaultTiming(), writable: true });
      Object.defineProperty(this, "_animation", { value: null, writable: true });
      if (target instanceof KeyframeEffect && keyframes === undefined && arguments.length === 1) { /* copy constructor handled below */ }
      if (target instanceof KeyframeEffect) {
        var src = target;
        this._target = src._target; this._pseudo = src._pseudo; this._composite = src._composite; this._iterationComposite = src._iterationComposite;
        this._frames = src._frames.map(function (f) { return { offset: f.offset, computedOffset: f.computedOffset, easing: f.easing, easingParsed: f.easingParsed, composite: f.composite, props: Object.assign({}, f.props) }; });
        var st = src._timing; this._timing = { delay: st.delay, endDelay: st.endDelay, fill: st.fill, iterationStart: st.iterationStart, iterations: st.iterations, duration: st.duration, direction: st.direction, easing: st.easing };
        return;
      }
      if (target !== null && !(target instanceof Element)) throw new TypeError("KeyframeEffect: target must be an Element or null");
      this._target = target; this._pseudo = null; this._composite = "replace"; this._iterationComposite = "replace";
      if (typeof options === "number" || (options !== undefined && options !== null && typeof options !== "object")) {
        var d = +options; if (d !== d || d < 0) throw new TypeError("Invalid duration"); this._timing.duration = d;
      } else if (options !== undefined && options !== null) {
        A.applyTiming(this._timing, options);
        if (options.composite !== undefined) this._composite = enumOf(options.composite, ["replace", "add", "accumulate"], "composite");
        if (options.iterationComposite !== undefined) this._iterationComposite = enumOf(options.iterationComposite, ["replace", "accumulate"], "iterationComposite");
        if (options.pseudoElement !== undefined && options.pseudoElement !== null) this.pseudoElement = options.pseudoElement;
      }
      this._frames = A.processKeyframes(keyframes);
    }
    get target() { return this._target; }
    set target(t) { if (t !== null && !(t instanceof Element)) throw new TypeError("target must be an Element or null"); var old = this._target; this._target = t; A.invalidateTarget(old); A.invalidate(this); }
    get pseudoElement() { return this._pseudo; }
    set pseudoElement(p) {
      if (p === null) { this._pseudo = null; return; }
      p = String(p);
      var norm = /^::?(before|after|marker|first-line|first-letter|placeholder|selection|backdrop)$/i.exec(p);
      if (!/^::?[a-z-]+(\(.*\))?$/i.test(p) || (p.charAt(1) !== ":" && !norm)) throw dom("SyntaxError", "Invalid pseudo-element '" + p + "'");
      if (norm && p.charAt(1) !== ":") p = "::" + norm[1].toLowerCase();
      this._pseudo = p;
    }
    get composite() { return this._composite; }
    set composite(v) { this._composite = enumOf(v, ["replace", "add", "accumulate"], "composite"); A.invalidate(this); }
    get iterationComposite() { return this._iterationComposite; }
    set iterationComposite(v) { this._iterationComposite = enumOf(v, ["replace", "accumulate"], "iterationComposite"); A.invalidate(this); }
    getKeyframes() {
      var self = this;
      return this._frames.map(function (f) {
        var o = { offset: f.offset, computedOffset: f.computedOffset, easing: f.easing, composite: f.composite };
        Object.keys(f.props).sort().forEach(function (p) { o[cssToCamel(p)] = A.specifiedValue(f.props[p], p, self._target); });
        return o;
      });
    }
    setKeyframes(keyframes) { this._frames = A.processKeyframes(keyframes); A.invalidate(this); }
  }
  // Keyframe values as getKeyframes() reports them (CSS-wide normalisation of simple forms).
  A.specifiedValue = function (v, prop, el) {
    v = String(v);
    if (prop.indexOf("--") === 0) return v;
    var s = v.trim();
    if (/^(?:[+-]?(?:\d+\.?\d*|\.\d+))$/.test(s) && prop !== "opacity" && !/^(z-index|order|flex-grow|flex-shrink|font-weight|line-height|orphans|widows|tab-size)$/.test(prop)) return v; // invalid-for-property values stay as given
    var m = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|em|rem|%|deg|s|ms)$/i.exec(s);
    if (m) return fmt(parseFloat(m[1])) + m[2].toLowerCase();
    return v;
  };

  // ------------------------------------------------------------------ Animation
  class AnimationPlaybackEvent extends Event {
    constructor(type, init) {
      if (arguments.length < 1) throw new TypeError("AnimationPlaybackEvent: 1 argument required");
      super(type, init);
      init = init || {};
      var ct = init.currentTime === undefined ? null : init.currentTime, tt = init.timelineTime === undefined ? null : init.timelineTime;
      this._ev.currentTime = ct === null ? null : +ct; this._ev.timelineTime = tt === null ? null : +tt;
    }
    get currentTime() { return this._ev.currentTime; }
    get timelineTime() { return this._ev.timelineTime; }
  }
  var newPromise = function () { var res, rej; var p = new Promise(function (a, b) { res = a; rej = b; }); return { p: p, res: res, rej: rej, done: false }; };
  class Animation extends EventTarget {
    constructor(effect, timeline) {
      super();
      if (effect === undefined) effect = null;
      if (effect !== null && !(effect instanceof AnimationEffect)) throw new TypeError("effect must be an AnimationEffect");
      var s = { timeline: arguments.length >= 2 ? timeline : A.documentTimeline, effect: null, startTime: null, holdTime: null, rate: 1, pendingRate: null, pendingPlay: false, pendingPause: false, ready: null, finished: null, prevCurrent: null, replace: "active", index: ++animIndex, id: "", resetTask: false, finishNotify: null, events: [] };
      if (s.timeline !== null && s.timeline !== undefined && !(s.timeline instanceof AnimationTimeline)) throw new TypeError("timeline must be an AnimationTimeline");
      if (s.timeline === undefined) s.timeline = null;
      Object.defineProperty(this, "_s", { value: s });
      s.ready = newPromise(); s.ready.done = true; s.ready.res(this);
      s.finished = newPromise();
      this.onfinish = null; this.oncancel = null; this.onremove = null;
      if (effect !== null) this.effect = effect;
      animations.push(this);
    }
    get id() { return this._s.id; } set id(v) { this._s.id = String(v); }
    get effect() { return this._s.effect; }
    set effect(e) {
      var s = this._s;
      if (e !== null && !(e instanceof AnimationEffect)) throw new TypeError("effect must be an AnimationEffect");
      if (e === s.effect) return;
      if (s.pendingPause || s.pendingPlay) { /* reschedule: tasks continue with the new effect */ }
      if (e && e._animation && e._animation !== this) { var other = e._animation; other._s.effect = null; A.updateFinished(other, false, false); }
      if (s.effect) { s.effect._animation = null; A.invalidate(s.effect); }
      s.effect = e;
      if (e) e._animation = this;
      A.invalidate(e);
      A.updateFinished(this, false, false);
    }
    get timeline() { return this._s.timeline; }
    set timeline(t) {
      var s = this._s;
      if (t === undefined) t = null;
      if (t !== null && !(t instanceof AnimationTimeline)) throw new TypeError("timeline must be an AnimationTimeline");
      if (t === s.timeline) return;
      var prevTime = currentTimeOf(this), prevState = this.playState;
      s.timeline = t;
      if (s.startTime !== null) s.holdTime = null;
      if (t === null && prevTime !== null && s.holdTime === null && prevState !== "paused") { /* keep current time */ s.holdTime = prevTime; s.startTime = null; }
      A.updateFinished(this, false, false);
      if (t && (s.pendingPlay || s.pendingPause)) A.scheduleTick();
    }
    get startTime() { var v = this._s.startTime; return A.isProgress(this._s.timeline) ? pct(v) : v; }
    set startTime(v) {
      var s = this._s;
      v = v === null || v === undefined ? null : A.numberish(v, A.isProgress(s.timeline));
      if (v !== null && !isFinite(v)) throw new TypeError("startTime must be finite");
      var tt = A.tlNow(s.timeline);
      if (tt === null && v !== null) s.holdTime = null;
      var prev = currentTimeOf(this);
      applyPendingRate(this);
      s.startTime = v;
      if (v !== null) { if (s.rate !== 0) s.holdTime = null; }
      else s.holdTime = prev;
      if (s.pendingPlay || s.pendingPause) { s.pendingPlay = false; s.pendingPause = false; resolveReady(this); }
      A.updateFinished(this, true, false);
      A.invalidate(s.effect);
    }
    get currentTime() { var v = currentTimeOf(this); return A.isProgress(this._s.timeline) ? pct(v) : v; }
    set currentTime(v) {
      if (v === null || v === undefined) { if (currentTimeOf(this) !== null) throw new TypeError("currentTime cannot be set to null"); return; }
      v = A.numberish(v, A.isProgress(this._s.timeline)); if (!isFinite(v)) throw new TypeError("currentTime must be finite");
      this._s.userSeek = true;
      setCurrentTimeSilently(this, v);
      var s = this._s;
      if (s.pendingPause) { s.holdTime = v; applyPendingRate(this); s.startTime = null; s.pendingPause = false; resolveReady(this); }
      A.updateFinished(this, true, false);
      A.invalidate(s.effect);
    }
    get playbackRate() { return this._s.rate; }
    set playbackRate(r) {
      r = +r; if (!isFinite(r)) throw new TypeError("playbackRate must be finite");
      var s = this._s;
      s.pendingRate = null;
      var prev = currentTimeOf(this);
      s.rate = r;
      if (prev !== null) { setCurrentTimeSilently(this, prev); A.updateFinished(this, true, false); }
    }
    get playState() {
      var s = this._s, ct = currentTimeOf(this);
      if (ct === null && s.startTime === null && !s.pendingPlay && !s.pendingPause) return "idle";
      if (s.pendingPause || (s.startTime === null && !s.pendingPlay)) return "paused";
      if (ct !== null) { var rate = effectiveRate(this), end = effectEnd(this); if ((rate > 0 && ct >= end) || (rate < 0 && ct <= 0)) return "finished"; }
      return "running";
    }
    get replaceState() { return this._s.replace; }
    get pending() { return this._s.pendingPlay || this._s.pendingPause; }
    get ready() { return this._s.ready.p; }
    get finished() { return this._s.finished.p; }
    get onfinish() { return this._onfinish || null; } set onfinish(f) { this._onfinish = typeof f === "function" ? f : null; }
    get oncancel() { return this._oncancel || null; } set oncancel(f) { this._oncancel = typeof f === "function" ? f : null; }
    get onremove() { return this._onremove || null; } set onremove(f) { this._onremove = typeof f === "function" ? f : null; }
    play() { playAnimation(this, true); }
    pause() { pauseAnimation(this); }
    finish() { finishAnimation(this); }
    cancel() { cancelAnimation(this); }
    reverse() { reverseAnimation(this); }
    updatePlaybackRate(rate) {
      rate = +rate; if (!isFinite(rate)) throw new TypeError("playbackRate must be finite");
      var s = this._s, prev = this.playState;
      s.pendingRate = rate;
      if (this.pending) return;
      if (prev === "idle" || prev === "paused" || s.timeline === null || A.tlNow(s.timeline) === null) { applyPendingRate(this); return; }
      if (prev === "finished") {
        var unconstrained = s.startTime === null ? null : (A.tlNow(s.timeline) - s.startTime) * s.rate;
        if (rate === 0) s.startTime = A.tlNow(s.timeline);
        else if (unconstrained !== null) s.startTime = A.tlNow(s.timeline) - unconstrained / rate;
        applyPendingRate(this);
        A.updateFinished(this, false, false);
        return;
      }
      playAnimation(this, false);
    }
    persist() { this._s.replace = "persisted"; }
    commitStyles() {
      var e = this._s.effect;
      if (!e || !(e instanceof KeyframeEffect) || !e._target) return;
      var t = e._target;
      if (e._pseudo) throw dom("NoModificationAllowedError", "Cannot commit styles of a pseudo-element animation");
      if (!(t.style && t.style instanceof CSSStyleDeclaration)) throw dom("NoModificationAllowedError", "The target has no style attribute");
      if (!A.isRendered(t)) throw dom("InvalidStateError", "The target is not being rendered");
      var props = {};
      e._frames.forEach(function (f) { Object.keys(f.props).forEach(function (p) { props[p] = 1; }); });
      Object.keys(props).forEach(function (p) {
        var v = A.animatedValue(t, p, this, true);
        if (v !== null) t.style.setProperty(p, v);
      }, this);
    }
    get [Symbol.toStringTag]() { return this instanceof CSSTransition ? "CSSTransition" : this instanceof CSSAnimation ? "CSSAnimation" : "Animation"; }
  }
  A.isRendered = function (el) { if (!el.isConnected) return false; for (var n = el; n && n.nodeType === 1; n = n.parentNode) if (__jb.styleOf(n, "display") === "none") return false; return true; };
  function effectiveRate(a) { var s = a._s; return s.pendingRate !== null ? s.pendingRate : s.rate; }
  function effectEnd(a) { var e = a._s.effect; return e ? endTime(A.effTiming(e)) : 0; }
  function currentTimeOfA(a) { return currentTimeOf(a); }
  A.currentTimeOf = function (a) { return currentTimeOf(a); };
  function currentTimeOf(a) {
    var s = a._s;
    if (s.holdTime !== null) return s.holdTime;
    if (!s.timeline || s.startTime === null) return null;
    var tt = A.tlNow(s.timeline);
    if (tt === null) return null;
    return (tt - s.startTime) * s.rate;
  }
  function setCurrentTimeSilently(a, v) {
    var s = a._s;
    var tt = A.tlNow(s.timeline);
    if (s.holdTime !== null || s.startTime === null || tt === null || s.rate === 0) s.holdTime = v;
    else s.startTime = tt - v / s.rate;
    if (!s.timeline || tt === null) s.startTime = null;
    s.prevCurrent = null;
  }
  function applyPendingRate(a) { var s = a._s; if (s.pendingRate !== null) { s.rate = s.pendingRate; s.pendingRate = null; } }
  function resolveReady(a) { var s = a._s; if (!s.ready.done) { s.ready.done = true; var r = s.ready; Promise.resolve().then(function () { r.res(a); }); } }
  function resetReady(a) { var s = a._s; if (s.ready.done) { s.ready = newPromise(); s.ready.p.catch(function () {}); } }
  function playAnimation(a, autoRewind) {
    var s = a._s;
    var abortedPause = s.pendingPause, hasPendingReady = false, seekTime = null;
    var rate = effectiveRate(a), ct = currentTimeOf(a), end = effectEnd(a);
    if (rate > 0 && autoRewind && (ct === null || ct < 0 || ct >= end)) seekTime = 0;
    else if (rate < 0 && autoRewind && (ct === null || ct <= 0 || ct > end)) {
      if (end === Infinity) throw dom("InvalidStateError", "Cannot play a reversed infinite animation");
      seekTime = end;
    } else if (rate === 0 && ct === null) seekTime = 0;
    if (seekTime !== null) { s.startTime = null; s.holdTime = seekTime; }
    if (s.holdTime !== null) s.startTime = null;
    if (s.pendingPlay || s.pendingPause) { s.pendingPause = false; hasPendingReady = true; }
    if (s.holdTime === null && seekTime === null && !abortedPause && s.pendingRate === null) return;
    if (!hasPendingReady) resetReady(a);
    s.pendingPlay = true;
    A.scheduleTick();
    A.updateFinished(a, false, false);
    A.invalidate(s.effect);
  }
  function pauseAnimation(a) {
    var s = a._s;
    if (s.pendingPause) return;
    if (a.playState === "paused" && !s.pendingPlay) return;
    var seekTime = null, rate = effectiveRate(a);
    if (currentTimeOf(a) === null) {
      if (rate >= 0) seekTime = 0;
      else { var end = effectEnd(a); if (end === Infinity) throw dom("InvalidStateError", "Cannot pause a reversed infinite animation"); seekTime = end; }
    }
    if (seekTime !== null) s.holdTime = seekTime;
    var hasPending = false;
    if (s.pendingPlay) { s.pendingPlay = false; hasPending = true; }
    if (!hasPending) resetReady(a);
    s.pendingPause = true;
    A.scheduleTick();
    A.updateFinished(a, false, false);
    A.invalidate(s.effect);
  }
  function finishAnimation(a) {
    var s = a._s, rate = effectiveRate(a), end = effectEnd(a);
    if (rate === 0 || (rate > 0 && end === Infinity)) throw dom("InvalidStateError", "Cannot finish this animation");
    applyPendingRate(a);
    var limit = s.rate > 0 ? end : 0;
    setCurrentTimeSilently(a, limit);
    var tt = A.tlNow(s.timeline);
    if (s.startTime === null && tt !== null) s.startTime = tt - limit / s.rate;
    if (s.pendingPause && s.startTime !== null) { s.holdTime = null; s.pendingPause = false; resolveReady(a); }
    if (s.pendingPlay && s.startTime !== null) { s.pendingPlay = false; resolveReady(a); }
    A.updateFinished(a, true, true);
    A.invalidate(s.effect);
  }
  function cancelAnimation(a) {
    var s = a._s;
    if (a.playState !== "idle") {
      if (s.pendingPlay || s.pendingPause) { s.pendingPlay = false; s.pendingPause = false; }
      if (!s.ready.done) { var r = s.ready; r.done = true; r.rej(dom("AbortError", "The animation was cancelled")); r.p.catch(function () {}); }
      s.ready = newPromise(); s.ready.done = true; s.ready.res(a);
      if (!s.finished.done) { var f = s.finished; f.done = true; f.rej(dom("AbortError", "The animation was cancelled")); f.p.catch(function () {}); }
      s.finished = newPromise();
      var tt = A.tlNow(s.timeline);
      queueEvent(a, "cancel", null, tt);
      if (typeof a._cssCancelled === "function") a._cssCancelled();
    }
    s.holdTime = null; s.startTime = null;
    A.invalidate(s.effect);
  }
  function reverseAnimation(a) {
    var s = a._s;
    if (!s.timeline || A.tlNow(s.timeline) === null) throw dom("InvalidStateError", "Cannot reverse an animation without an active timeline");
    var orig = effectiveRate(a);
    s.pendingRate = -orig;
    try { playAnimation(a, true); } catch (e) { s.pendingRate = null === orig ? null : (orig === s.rate ? null : orig); throw e; }
  }
  // "Update an animation's finished state"
  A.updateFinished = function (a, didSeek, sync) {
    var s = a._s;
    var unconstrained = s.timeline && s.startTime !== null && A.tlNow(s.timeline) !== null && !(s.pendingPlay || s.pendingPause) ? (A.tlNow(s.timeline) - s.startTime) * s.rate : null;
    var ct = unconstrained !== null ? unconstrained : currentTimeOf(a);
    if (unconstrained !== null && s.startTime !== null && !s.pendingPlay) {
      var end = effectEnd(a);
      if (s.rate > 0 && unconstrained >= end) {
        if (didSeek) s.holdTime = unconstrained;
        else s.holdTime = s.prevCurrent === null ? end : Math.max(s.prevCurrent, end);
      } else if (s.rate < 0 && unconstrained <= 0) {
        if (didSeek) s.holdTime = unconstrained;
        else s.holdTime = s.prevCurrent === null ? 0 : Math.min(s.prevCurrent, 0);
      } else if (s.rate !== 0 && s.timeline && A.tlNow(s.timeline) !== null) {
        if (didSeek && s.holdTime !== null) s.startTime = A.tlNow(s.timeline) - s.holdTime / s.rate;
        s.holdTime = null;
      }
    }
    s.prevCurrent = currentTimeOf(a);
    var finished = a.playState === "finished";
    if (finished && !s.finished.done) {
      if (sync) { if (s.finishNotify) { s.finishNotify.cancelled = true; s.finishNotify = null; } finishNotify(a); }
      else if (!s.finishNotify) {
        var task = { cancelled: false };
        s.finishNotify = task;
        Promise.resolve().then(function () { if (task.cancelled || s.finishNotify !== task) return; s.finishNotify = null; if (a.playState === "finished") finishNotify(a); });
      }
    } else if (!finished) {
      if (s.finishNotify) { s.finishNotify.cancelled = true; s.finishNotify = null; }
      if (s.finished.done) { s.finished = newPromise(); }
    }
    if (finished || a.playState === "running") A.scheduleTick();
  };
  function finishNotify(a) {
    var s = a._s;
    if (s.finished.done) return;
    s.finished.done = true; s.finished.res(a);
    var tt = A.tlNow(s.timeline);
    queueEvent(a, "finish", currentTimeOf(a), tt);
  }
  var eventQueue = [];
  function queueEvent(a, type, ct, tt) {
    eventQueue.push({ target: a, type: type, ct: ct, tt: tt, time: tt === null ? -Infinity : tt, Ctor: AnimationPlaybackEvent });
    A.scheduleTick();
  }
  A.queueEventRaw = function (rec) { eventQueue.push(rec); A.scheduleTick(); };

  // ------------------------------------------------------------------ frame tick
  var tickScheduled = false;
  A.scheduleTick = function () {
    if (tickScheduled) return;
    tickScheduled = true;
    // just before the frame's animation frame callbacks
    var d = __jb.untilNextFrame() - 0.001;
    if (d < 0.0005) d += FRAME; // this frame's tick already ran
    (__jb.frameTimeout || setTimeout)(A.tick, d);
  };
  A.tick = function () {
    tickScheduled = false;
    // the tick runs 0.001 ms before its frame: timelines read the frame time
    A.inTick = true;
    if (typeof A.cssUpdate === "function") { try { A.cssUpdate(); } catch (e) { __jb.reportException(e); } }
    // pending tasks complete with the frame's timeline time
    animations.slice().forEach(function (a) {
      var s = a._s;
      if (!s.timeline) return;
      var tt = A.tlNow(s.timeline);
      if (tt === null) return;
      if (s.pendingPlay) {
        s.pendingPlay = false;
        if (A.isProgress(s.timeline) && !s.userSeek) { applyPendingRate(a); s.startTime = s.rate >= 0 ? 0 : 100; s.holdTime = null; }
        else if (s.holdTime !== null) { applyPendingRate(a); if (s.rate === 0) s.startTime = tt; else s.startTime = tt - s.holdTime / s.rate; }
        else if (s.startTime !== null && s.pendingRate !== null) { var ct = (tt - s.startTime) * s.rate; applyPendingRate(a); if (s.rate === 0) s.holdTime = ct; else s.startTime = tt - ct / s.rate; }
        else applyPendingRate(a);
        if (s.rate !== 0) s.holdTime = null;
        resolveReady(a);
        A.updateFinished(a, false, false);
        A.invalidate(s.effect);
      } else if (s.pendingPause) {
        s.pendingPause = false;
        if (s.startTime !== null && s.holdTime === null) s.holdTime = (tt - s.startTime) * s.rate;
        applyPendingRate(a);
        s.startTime = null;
        resolveReady(a);
        A.updateFinished(a, false, false);
        A.invalidate(s.effect);
      }
    });
    animations.slice().forEach(function (a) { if (a._s.timeline) A.updateFinished(a, false, false); });
    removeReplaced();
    if (typeof A.beforeDispatch === "function") { try { A.beforeDispatch(); } catch (e) { __jb.reportException(e); } }
    // drop idle animations nobody can observe any more
    for (var i = animations.length - 1; i >= 0; i--) { var a = animations[i]; if (a.playState === "idle" && !a._s.effect) animations.splice(i, 1); }
    // dispatch queued events (sorted by scheduled time, then composite order)
    var evs = eventQueue.splice(0);
    evs.forEach(function (e, i) { e.seq = i; });
    evs.sort(function (x, y) { return (x.time - y.time) || (compositeOrder(x.target, y.target)) || (x.seq - y.seq); });
    evs.forEach(function (e) {
      try {
        var ev;
        if (e.make) ev = e.make();
        else { ev = new AnimationPlaybackEvent(e.type, { currentTime: e.ct, timelineTime: e.tt }); }
        __jb.setTrusted(ev, true); ev._trustedDispatch = true;
        var target = e.dispatchTarget || e.target;
        if (e.dispatchTarget && !e.dispatchTarget.isConnected && e.requireConnected) return;
        target.dispatchEvent(ev); // (the dispatch also runs the on<type> handler)
      } catch (err) { __jb.reportException(err); }
    });
    if (animations.some(function (a) { var ps = a.playState; return ps === "running" || a.pending; }) || (A.cssActive && A.cssActive())) A.scheduleTick();
    // animated values are computed on read (getComputedStyle); the layout is not rebuilt per frame
    A.dirtyTargets.clear();
  };

  // ------------------------------------------------------------------ composite order / replacement
  function animClass(a) { return a instanceof CSSTransition ? 0 : a instanceof CSSAnimation ? 1 : 2; }
  function compositeOrder(a, b) {
    if (a === b) return 0;
    if (!(a instanceof Animation) || !(b instanceof Animation)) return 0;
    var ca = animClass(a._owningOrSelf ? a : a), cb = animClass(b);
    var ao = a._owningElement && a._owningElement(), bo = b._owningElement && b._owningElement();
    var ka = ao ? animClass(a) : 2, kb = bo ? animClass(b) : 2;
    if (ka !== kb) return ka - kb;
    if (ka === 0 && kb === 0) { if (ao !== bo) return __jb.treeOrderCompare ? __jb.treeOrderCompare(ao, bo) : 0; return (a._s.transitionGen - b._s.transitionGen) || (a.transitionProperty < b.transitionProperty ? -1 : a.transitionProperty > b.transitionProperty ? 1 : 0); }
    if (ka === 1 && kb === 1) { if (ao !== bo) return __jb.treeOrderCompare ? __jb.treeOrderCompare(ao, bo) : 0; return a._s.nameIndex - b._s.nameIndex; }
    return a._s.index - b._s.index;
  }
  A.compositeOrder = compositeOrder;
  __jb.treeOrderCompare = __jb.treeOrderCompare || function (x, y) { if (x === y) return 0; var p = x.compareDocumentPosition(y); return p & 4 ? -1 : p & 2 ? 1 : 0; };
  function propsOf(e) { var p = {}; if (e && e._frames) e._frames.forEach(function (f) { Object.keys(f.props).forEach(function (k) { p[k] = 1; }); }); return p; }
  function removeReplaced() {
    var cands = animations.filter(function (a) {
      var s = a._s;
      return s.replace === "active" && a.playState === "finished" && A.isMonotonic(s.timeline) && s.effect instanceof KeyframeEffect && s.effect._target && inEffect(a) && !(a._owningElement && a._owningElement());
    });
    if (!cands.length) return;
    var all = animations.filter(function (a) { var s = a._s; return s.effect instanceof KeyframeEffect && s.effect._target && (a.playState === "finished" || a.playState === "running" || a.playState === "paused") && inEffect(a) && s.replace !== "removed"; });
    cands.forEach(function (a) {
      var t = a._s.effect._target, pseudo = a._s.effect._pseudo, props = propsOf(a._s.effect);
      var later = all.filter(function (b) { return b !== a && b._s.effect._target === t && b._s.effect._pseudo === pseudo && compositeOrder(a, b) < 0 && b._s.replace !== "removed"; });
      var covered = Object.keys(props).every(function (p) { return later.some(function (b) { return propsOf(b._s.effect)[p]; }); });
      if (!covered) return;
      a._s.replace = "removed";
      A.invalidate(a._s.effect);
      var tt = a._s.timeline ? A.tlNow(a._s.timeline) : null;
      eventQueue.push({ target: a, type: "remove", ct: a.currentTime, tt: tt, time: tt === null ? -Infinity : tt });
    });
  }
  function inEffect(a) {
    var e = a._s.effect; if (!e) return false;
    var ct = currentTimeOf(a); if (ct === null) return false;
    var r = A.computeTiming(A.effTiming(e), ct, a.playbackRate >= 0, "none");
    return r.activeTime !== null;
  }
  A.inEffect = inEffect;
  // "relevant": current or in effect
  A.isRelevant = function (a) {
    var e = a._s.effect; if (!e) return false;
    if (a._s.replace === "removed") return false;
    var ct = currentTimeOf(a);
    if (ct === null) return false;
    var r = A.computeTiming(A.effTiming(e), ct, a.playbackRate >= 0, "none");
    var rate = a.playbackRate;
    var current = r.phase === "active" || (rate > 0 && r.phase === "before") || (rate < 0 && r.phase === "after") || a.pending && (r.phase === "before" || r.phase === "active");
    return current || r.activeTime !== null;
  };

  // ------------------------------------------------------------------ effect values
  A.dirtyTargets = new Set();
  A.invalidate = function (effect) {
    if (!effect || !(effect instanceof KeyframeEffect) || !effect._target) return;
    A.invalidateTarget(effect._target);
  };
  A.invalidateTarget = function (el) { if (!el) return; A.version = (A.version || 0) + 1; A.dirtyTargets.add(el); try { if (el._csCache) el._csCache.key = -1; } catch (e) {} };
  A.targetsAnimating = function (el) { return animations.some(function (a) { var e = a._s.effect; return e && e._target === el && !e._pseudo; }); };
  // The animated value of `prop` on `el` (all effects in composite order), or null when no
  // effect animates it. With `only`, just that animation's effect over the underlying value.
  A.animatedValue = function (el, prop, only, commit) {
    var list = animations.filter(function (a) { var e = a._s.effect; return e instanceof KeyframeEffect && e._target === el && !e._pseudo && a._s.replace !== "removed" && (only ? a === only || compositeOrder(a, only) < 0 : true); });
    if (!list.length) return null;
    list = list.filter(function (a) { return propsOf(a._s.effect)[prop] || (prop === "margin-left" || prop === "margin-right" || prop === "margin-top" || prop === "margin-bottom") && propsOf(a._s.effect).margin; });
    if (!list.length) return null;
    list.sort(compositeOrder);
    if (nativeEligible(el, prop)) try {
      // Stylo does the arithmetic (interpolate / add / accumulate) on computed values
      var nu = "", ntouched = false;
      list.forEach(function (a) {
        var e = a._s.effect, ct = a.currentTime;
        if (ct === null) return;
        var r = A.computeTiming(A.effTiming(e), ct, a.playbackRate >= 0, "none");
        if (r.progress === null) return;
        var v = nativeEffectValue(e, prop, el, nu, r.progress, r.currentIteration);
        if (v !== null) { nu = v; ntouched = true; }
      });
      if (!ntouched) return null;
      if (nu === "") return baseValue(el, prop);
      if (prop === "transform") { var m = nativeOp(el, prop, "resolve", "", nu, "", 0, 1); if (m !== null) return m; }
      return resolvePercent(el, prop, nu);
    } catch (err) {
      // Stylo cannot animate these values (or animates the property only discretely): use the JS model
      if (err !== NATIVE_DISCRETE) throw err;
      // (fall through)
    }
    var base = baseValue(el, prop), underlying = parseValue(base, prop, el), touched = false;
    list.forEach(function (a) {
      var e = a._s.effect, ct = a.currentTime;
      if (ct === null) return;
      var r = A.computeTiming(A.effTiming(e), ct, a.playbackRate >= 0, "none");
      if (r.progress === null) return;
      var v = effectValue(e, prop, el, underlying, r.progress, r.currentIteration);
      if (v) { underlying = v; touched = true; }
    });
    return touched ? serialize(underlying, prop) : null;
  };
  function shorthandValue(f, prop) {
    if (prop in f.props) return f.props[prop];
    if (/^margin-(left|right|top|bottom)$/.test(prop) && f.props.margin !== undefined) {
      var parts = String(f.props.margin).trim().split(/\s+/), side = prop.slice(7);
      var idx = { top: 0, right: 1, bottom: 2, left: 3 }[side];
      var four = parts.length === 1 ? [parts[0], parts[0], parts[0], parts[0]] : parts.length === 2 ? [parts[0], parts[1], parts[0], parts[1]] : parts.length === 3 ? [parts[0], parts[1], parts[2], parts[1]] : parts;
      return four[idx];
    }
    return undefined;
  }
  // ---- Stylo-backed effect values (properties Stylo animates, see Layout::animate_value)
  // (opacity: Stylo clamps the endpoints before interpolating; the spec clamps the result)
  var NATIVE_EXCLUDE = /^(grid-template-rows|grid-template-columns|display|content-visibility|overlay|opacity|fill-opacity|stroke-opacity|flood-opacity|stop-opacity)$/;
  var nativeKnown = Object.create(null);
  function nativeEligible(el, prop) {
    if (A.noNative === undefined) A.noNative = !!__jb.noStyloAnim;
    if (A.noNative || prop.indexOf("--") === 0 || NATIVE_EXCLUDE.test(prop)) return false;
    if (!el.isConnected || typeof __jb.layoutQuery !== "function" || (__jb.layoutState && __jb.layoutState.available === false) || !__jb.styloCssom || !__jb.styloCssom()) return false;
    if (!(prop in nativeKnown)) { var k = null; try { k = __jb.native("cssdecl", { op: "known", prop: prop }); } catch (e) { k = null; } nativeKnown[prop] = k !== false && k !== null; }
    return nativeKnown[prop];
  }
  // resolved values (getComputedStyle) of box properties of a rendered element are lengths:
  // percentages resolve against the containing block (the parent's content box)
  var RESOLVE_W = /^(width|min-width|max-width|left|right|margin-(left|right|top|bottom)|padding-(left|right|top|bottom))$/, RESOLVE_H = /^(height|min-height|max-height|top|bottom)$/;
  function resolvePercent(el, prop, v) {
    if (!/%/.test(v) || !(RESOLVE_W.test(prop) || RESOLVE_H.test(prop)) || typeof __jb.layoutRect !== "function") return v;
    // insets resolve to lengths only on positioned boxes
    if (/^(top|left|right|bottom)$/.test(prop)) { var pos = null; try { pos = __jb.computedValue(el, "position"); } catch (e) { pos = null; } if (!pos || pos === "static") return v; }
    var p = el.parentElement, own = null, lr = null;
    try { own = __jb.layoutRect(el); lr = p ? __jb.layoutRect(p) : null; } catch (e) { return v; }
    if (!own || !lr || !lr.border || !lr.padding) return v;
    var basis = RESOLVE_H.test(prop) ? lr.height - lr.border[0] - lr.border[2] - lr.padding[0] - lr.padding[2] : lr.width - lr.border[1] - lr.border[3] - lr.padding[1] - lr.padding[3];
    var m = /^(-?[\d.]+(?:e[+-]?\d+)?)%$/.exec(v);
    if (m) return fmt(parseFloat(m[1]) * basis / 100) + "px";
    m = /^calc\((-?[\d.]+(?:e[+-]?\d+)?)% ([+-]) ([\d.]+(?:e[+-]?\d+)?)px\)$/.exec(v);
    if (m) return fmt(parseFloat(m[1]) * basis / 100 + (m[2] === "-" ? -1 : 1) * parseFloat(m[3])) + "px";
    return v;
  }
  function nativeOp(el, prop, op, base, a, b, progress, count) {
    if (el.__jbid === undefined || __jb.nodeById[el.__jbid] !== el) __jb.assignLayoutIds();
    var all = (base || "") + (a || "") + (b || ""), r = null;
    try { r = __jb.layoutQuery("animate", { id: el.__jbid, prop: prop, kind: op, base: base || "", a: a || "", b: b || "", progress: progress || 0, count: count || 1, url: /url\(/i.test(all) && el.ownerDocument ? el.ownerDocument.baseURI : "" }); } catch (e) { r = null; }
    // "\u0001discrete": Stylo cannot animate the property (remembered); "\u0001value": these values
    if (r === "\u0001discrete") { nativeKnown[prop] = false; throw NATIVE_DISCRETE; }
    if (r === "\u0001value") throw NATIVE_DISCRETE;
    return typeof r === "string" ? r : null;
  }
  var NATIVE_DISCRETE = { nativeDiscrete: true };
  // like effectValue, on CSS text ("" = the element's own value)
  function nativeEffectValue(e, prop, el, underlying, progress, iteration) {
    var frames = e._frames.filter(function (f) { return shorthandValue(f, prop) !== undefined; });
    if (!frames.length) return null;
    var comp = function (f) { return f.composite === "auto" ? e._composite : f.composite; };
    var val = function (f) {
      var v = resolveKeyword(String(shorthandValue(f, prop)).trim(), prop, el);
      var c = comp(f);
      if (c === "add" || c === "accumulate") { var sv = nativeOp(el, prop, c, underlying, v, "", 0, 1); if (sv !== null) v = sv; }
      return v;
    };
    var list = frames.map(function (f) { return { off: f.computedOffset, f: f }; });
    if (!list.some(function (x) { return x.off === 0; })) list.unshift({ off: 0, neutral: true });
    if (!list.some(function (x) { return x.off === 1; })) list.push({ off: 1, neutral: true });
    var valueOf = function (x) { return x.neutral ? underlying : val(x.f); };
    var interval;
    if (progress < 0 && list.filter(function (x) { return x.off === 0; }).length > 1) { var z = list.filter(function (x) { return x.off === 0; }); return valueOf(z[0]); }
    if (progress >= 1 && list.filter(function (x) { return x.off === 1; }).length > 1) { var o = list.filter(function (x) { return x.off === 1; }); return valueOf(o[o.length - 1]); }
    if (progress < 0) interval = [list[0], list[1]];
    else if (progress >= 1) interval = [list[list.length - 2], list[list.length - 1]];
    else {
      for (var i = list.length - 1; i >= 0; i--) if (list[i].off <= progress) break;
      if (i < 0) i = 0;
      if (i >= list.length - 1) i = list.length - 2;
      interval = [list[i], list[i + 1]];
    }
    var a = interval[0], b = interval[1];
    if (a.off === b.off) return valueOf(b);
    var local = (progress - a.off) / (b.off - a.off);
    if (!a.neutral && a.f.easingParsed) local = a.f.easingParsed.fn(local, false);
    else if (a.neutral && e._cssEasing) local = e._cssEasing.fn(local, false);
    var va = valueOf(a), vb = valueOf(b);
    if (e._iterationComposite === "accumulate" && iteration > 0 && isFinite(iteration)) {
      var lastVal = valueOf(list[list.length - 1]);
      var xa = nativeOp(el, prop, "accumulate", lastVal, va, "", 0, iteration), xb = nativeOp(el, prop, "accumulate", lastVal, vb, "", 0, iteration);
      if (xa !== null) va = xa;
      if (xb !== null) vb = xb;
    }
    var r = nativeOp(el, prop, "interpolate", "", va, vb, local, 1);
    if (r !== null) return r;
    return local < 0.5 ? va : vb; // discrete
  }
  function effectValue(e, prop, el, underlying, progress, iteration) {
    var frames = e._frames.filter(function (f) { return shorthandValue(f, prop) !== undefined; });
    if (!frames.length) return null;
    var comp = function (f) { return f.composite === "auto" ? e._composite : f.composite; };
    var val = function (f) {
      var v = parseValue(shorthandValue(f, prop), prop, el);
      var c = comp(f);
      if (c === "add" || c === "accumulate") { var s = addValues(underlying, v, prop, c === "accumulate"); if (s) v = s; }
      return v;
    };
    // implicit 0% / 100% keyframes use the underlying value (neutral keyframe)
    var list = frames.map(function (f) { return { off: f.computedOffset, f: f }; });
    if (!list.some(function (x) { return x.off === 0; })) list.unshift({ off: 0, neutral: true });
    if (!list.some(function (x) { return x.off === 1; })) list.push({ off: 1, neutral: true });
    var valueOf = function (x) { return x.neutral ? underlying : val(x.f); };
    var interval;
    if (progress < 0 && list.filter(function (x) { return x.off === 0; }).length > 1) { var z = list.filter(function (x) { return x.off === 0; }); return valueOf(z[0]); }
    if (progress >= 1 && list.filter(function (x) { return x.off === 1; }).length > 1) { var o = list.filter(function (x) { return x.off === 1; }); return valueOf(o[o.length - 1]); }
    if (progress < 0) interval = [list[0], list[1]];
    else if (progress >= 1) interval = [list[list.length - 2], list[list.length - 1]];
    else {
      for (var i = list.length - 1; i >= 0; i--) if (list[i].off <= progress) break;
      if (i < 0) i = 0;
      if (i >= list.length - 1) i = list.length - 2;
      interval = [list[i], list[i + 1]];
    }
    var a = interval[0], b = interval[1];
    if (a.off === b.off) return valueOf(b);
    var local = (progress - a.off) / (b.off - a.off);
    if (!a.neutral && a.f.easingParsed) local = a.f.easingParsed.fn(local, false);
    else if (a.neutral && e._cssEasing) local = e._cssEasing.fn(local, false); // implicit CSS keyframes use animation-timing-function
    var va = valueOf(a), vb = valueOf(b);
    // iteration composite: accumulate the final value per iteration
    if (e._iterationComposite === "accumulate" && iteration > 0 && isFinite(iteration)) {
      var last = list[list.length - 1], lastVal = valueOf(last);
      for (var k = 0; k < iteration; k++) { va = addValues(va, lastVal, prop, true) || va; vb = addValues(vb, lastVal, prop, true) || vb; }
    }
    if (prop === "visibility" && va.t === "raw" && vb.t === "raw") {
      if (va.s === "visible" || vb.s === "visible") return local <= 0 ? va : local >= 1 ? vb : { t: "raw", s: "visible" };
    }
    var r = interpolate(va, vb, local, prop);
    if (r) return r;
    return local < 0.5 ? va : vb; // discrete
  }

  // style flushes through layout reads (offsetWidth, getBoundingClientRect, ...) also update CSS
  // animations and transitions
  // (installed in 90b_anim_hooks.js, after the layout bridge exists)
  // layer the animated values on the computed style
  var computedValue = __jb.computedValue;
  A.rawComputed = function (el, prop) { return computedValue(el, prop); };
  __jb.computedValue = function (el, prop) {
    if (typeof A.cssUpdate === "function" && !A.baseDepth && !A.inCssUpdate) { try { A.cssUpdate(); } catch (e) { __jb.reportException(e); } }
    var out = null;
    if (!A.baseDepth && animations.length) out = A.animatedValue(el, prop);
    if (out === null) out = computedValue(el, prop);
    // the style as last observed: the before-change style of a transition that starts later
    if (!A.baseDepth && !A.inCssUpdate && out !== null && out !== undefined) { try { var ls = el._lastStyle || Object.defineProperty(el, "_lastStyle", { value: {}, writable: true, configurable: true })._lastStyle; ls[prop] = { v: out, key: __jb.layoutKey ? __jb.layoutKey() : 0 }; } catch (e) {} }
    return out;
  };

  // ------------------------------------------------------------------ Element / Document APIs
  var animateImpl = function (keyframes, options) {
    var e = new KeyframeEffect(this, keyframes, options);
    var tl = A.documentTimeline;
    if (options && typeof options === "object" && "timeline" in options) tl = options.timeline === undefined ? A.documentTimeline : options.timeline;
    else if (this.ownerDocument && this.ownerDocument !== __jb.currentDocument) tl = this.ownerDocument.timeline;
    var a = new Animation(e, tl);
    if (options && typeof options === "object" && options.id !== undefined) a.id = options.id;
    a.play();
    return a;
  };
  var getAnimationsFor = function (root, subtree) {
    var out = animations.filter(function (a) {
      var e = a._s.effect;
      if (!(e instanceof KeyframeEffect) || !e._target || !A.isRelevant(a)) return false;
      var t = e._target;
      if (root.nodeType === 9) return t.ownerDocument === root && t.isConnected;
      return t === root || (subtree && root.contains(t));
    });
    out.sort(function (x, y) {
      var tx = x._s.effect._target, ty = y._s.effect._target;
      var ox = x._owningElement && x._owningElement(), oy = y._owningElement && y._owningElement();
      var kx = ox ? animClass(x) : 2, ky = oy ? animClass(y) : 2;
      if (kx !== ky) return kx - ky;
      if (kx < 2 && ox !== oy) return __jb.treeOrderCompare(ox, oy);
      if (kx === 2 && tx !== ty && false) return __jb.treeOrderCompare(tx, ty);
      return compositeOrder(x, y);
    });
    return out;
  };
  Object.defineProperty(Element.prototype, "animate", { value: function animate(keyframes, options) { return animateImpl.call(this, keyframes, options); }, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(Element.prototype, "getAnimations", { value: function getAnimations(options) { if (typeof A.cssUpdate === "function") A.cssUpdate(); return getAnimationsFor(this, !!(options && options.subtree)); }, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(Document.prototype, "getAnimations", { value: function getAnimations() { if (typeof A.cssUpdate === "function") A.cssUpdate(); return getAnimationsFor(this, true); }, writable: true, enumerable: true, configurable: true });
  if (typeof ShadowRoot !== "undefined") Object.defineProperty(ShadowRoot.prototype, "getAnimations", { value: function getAnimations() { if (typeof A.cssUpdate === "function") A.cssUpdate(); var self = this; return animations.filter(function (a) { var e = a._s.effect; return e instanceof KeyframeEffect && e._target && e._target.getRootNode() === self && A.isRelevant(a); }).sort(compositeOrder); }, writable: true, enumerable: true, configurable: true });

  // CSSAnimation / CSSTransition classes (filled by the CSS part below)
  class CSSAnimation extends Animation {
    constructor(effect, timeline) { if (!A.cssCreating) throw new TypeError("Illegal constructor"); super(effect, timeline); }
    get animationName() { return this._s.animationName; }
  }
  class CSSTransition extends Animation {
    constructor(effect, timeline) { if (!A.cssCreating) throw new TypeError("Illegal constructor"); super(effect, timeline); }
    get transitionProperty() { return this._s.transitionProperty; }
  }
  A.CSSAnimation = CSSAnimation; A.CSSTransition = CSSTransition;

  // scroll / view timelines (progress-based)
  class ScrollTimeline extends AnimationTimeline {
    constructor(options) {
      A.constructingTimeline = true;
      try { super(); } finally { A.constructingTimeline = false; }
      options = options || {};
      var src = options.source === undefined ? (__jb.currentDocument.scrollingElement || __jb.currentDocument.documentElement) : options.source;
      var axis = options.axis === undefined ? "block" : enumOf(options.axis, ["block", "inline", "x", "y"], "axis");
      Object.defineProperty(this, "_source", { value: src, writable: true });
      Object.defineProperty(this, "_axis", { value: axis });
    }
    get source() { return this._source; }
    get axis() { return this._axis; }
    get duration() { return CSSPercent(100); }
    get currentTime() { var v = this._currentTime(); return v === null ? null : CSSPercent(v); }
    _progressBased() { return true; }
    _currentTime() {
      var s = this._source;
      if (!s || !s.isConnected) return null;
      var vertical = this._axis === "block" || this._axis === "y";
      var max = vertical ? s.scrollHeight - s.clientHeight : s.scrollWidth - s.clientWidth;
      if (!(max > 0)) return null;
      var pos = vertical ? s.scrollTop : Math.abs(s.scrollLeft);
      return Math.min(100, Math.max(0, pos / max * 100));
    }
  }
  class ViewTimeline extends ScrollTimeline {
    constructor(options) {
      options = options || {};
      var subject = options.subject === undefined ? null : options.subject;
      var src = null;
      for (var p = subject ? subject.parentElement : null; p; p = p.parentElement) { var ov = __jb.styleOf(p, "overflow-y") || __jb.styleOf(p, "overflow"); if (/auto|scroll|hidden/.test(ov || "")) { src = p; break; } }
      super({ source: src || __jb.currentDocument.scrollingElement || __jb.currentDocument.documentElement, axis: options.axis });
      Object.defineProperty(this, "_subject", { value: subject });
      var inset = options.inset === undefined ? "auto" : options.inset;
      Object.defineProperty(this, "_inset", { value: inset });
    }
    get subject() { return this._subject; }
    get startOffset() { return CSSPx(0); }
    get endOffset() { return CSSPx(0); }
  }
  function CSSPercent(v) { return typeof CSS !== "undefined" && typeof CSS.percent === "function" ? CSS.percent(v) : { value: v, unit: "percent", toString: function () { return v + "%"; } }; }
  function CSSPx(v) { return typeof CSS !== "undefined" && typeof CSS.px === "function" ? CSS.px(v) : { value: v, unit: "px", toString: function () { return v + "px"; } }; }

  [AnimationTimeline, DocumentTimeline, ScrollTimeline, ViewTimeline, AnimationEffect, KeyframeEffect, Animation, AnimationPlaybackEvent, CSSAnimation, CSSTransition].forEach(function (C) {
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
    Object.getOwnPropertyNames(C.prototype).forEach(function (p) {
      if (p === "constructor" || p.charAt(0) === "_") return;
      var d = Object.getOwnPropertyDescriptor(C.prototype, p);
      if (!d.enumerable) { d.enumerable = true; Object.defineProperty(C.prototype, p, d); }
    });
  });
  // EventHandler attributes live on the prototype (onfinish / oncancel / onremove)
  Object.assign(globalThis, { AnimationTimeline: AnimationTimeline, DocumentTimeline: DocumentTimeline, ScrollTimeline: ScrollTimeline, ViewTimeline: ViewTimeline, AnimationEffect: AnimationEffect, KeyframeEffect: KeyframeEffect, Animation: Animation, AnimationPlaybackEvent: AnimationPlaybackEvent, CSSAnimation: CSSAnimation, CSSTransition: CSSTransition });
  ["AnimationTimeline", "DocumentTimeline", "ScrollTimeline", "ViewTimeline", "AnimationEffect", "KeyframeEffect", "Animation", "AnimationPlaybackEvent", "CSSAnimation", "CSSTransition"].forEach(function (n) {
    var d = Object.getOwnPropertyDescriptor(globalThis, n); if (d) { d.enumerable = false; Object.defineProperty(globalThis, n, d); }
  });
  A.parseValue = parseValue; A.serialize = serialize; A.interpolate = interpolate;
})();

// ---------------------------------------------------------------- CSS Animations / Transitions
(function () {
  var A = __jb.anim;
  var CSSAnimation = A.CSSAnimation, CSSTransition = A.CSSTransition;
  var raw = function (el, p) { var v = null; A.baseDepth = (A.baseDepth || 0) + 1; try { v = A.rawComputed(el, p); } catch (e) { v = null; } finally { A.baseDepth--; } return v; };
  // read many computed properties of one element with a single layout query (filling the
  // per-element computed-style cache that __jb.computedValue uses)
  var prefetch = function (el, props) {
    try {
      if (!el.isConnected || typeof __jb.layoutQuery !== "function" || typeof __jb.layoutKey !== "function") return;
      if (el.__jbid === undefined || __jb.nodeById[el.__jbid] !== el) __jb.assignLayoutIds();
      var key = __jb.layoutKey(), c = el._csCache;
      if (!c || c.key !== key) { c = { key: key, values: Object.create(null) }; Object.defineProperty(el, "_csCache", { value: c, writable: true, configurable: true }); }
      var missing = props.filter(function (p) { return !(p in c.values) && p.slice(0, 2) !== "--"; });
      if (missing.length < 2) return;
      var r = __jb.layoutQuery("style", { id: el.__jbid, props: missing });
      if (!r || typeof r !== "object") return;
      missing.forEach(function (p) { if (typeof r[p] === "string") c.values[p] = (p === "display" && r[p] === "contents") ? r[p] : r[p]; });
      if (__jb.layoutKey() !== key) c.key = -1;
    } catch (e) {}
  };
  var splitList = function (v) {
    if (v === null || v === undefined) return [];
    var out = [], depth = 0, cur = "";
    String(v).split("").forEach(function (c) { if (c === "(") depth++; if (c === ")") depth--; if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += c; });
    if (cur.trim() !== "" || out.length) out.push(cur.trim());
    return out;
  };
  var timeMs = function (s) { s = String(s || "0s").trim(); var m = /^([+-]?[\d.e+-]+)(ms|s)$/i.exec(s); if (!m) return 0; return parseFloat(m[1]) * (m[2].toLowerCase() === "s" ? 1000 : 1); };
  var at = function (list, i, dflt) { return list.length ? list[i % list.length] : dflt; };

  // ---- @keyframes lookup (last rule with the name wins)
  function sheetRules(doc) {
    var out = [];
    var visit = function (rules) { if (!rules) return; for (var i = 0; i < rules.length; i++) { var r = rules[i]; out.push(r); if (r.cssRules && r.type !== 7) visit(r.cssRules); } };
    try { var sheets = doc.styleSheets; for (var i = 0; i < sheets.length; i++) { var rs = null; try { rs = sheets[i].cssRules; } catch (e) {} visit(rs); } } catch (e) {}
    return out;
  }
  function keyframesFor(name, rules) {
    var found = null;
    rules.forEach(function (r) { if (r.type === 7 && unquote(r.name) === name) found = r; });
    return found;
  }
  var unquote = function (s) { s = String(s || "").trim(); if (/^(["']).*\1$/.test(s)) s = s.slice(1, -1); return s; };
  function framesFromRule(rule, el) {
    var byOffset = {};
    var order = [];
    (rule.cssRules || []).forEach(function (kr) {
      String(kr.keyText || "").split(",").forEach(function (k) {
        k = k.trim().toLowerCase();
        var off = k === "from" ? 0 : k === "to" ? 1 : /^[\d.]+%$/.test(k) ? parseFloat(k) / 100 : null;
        if (off === null || off < 0 || off > 1) return;
        var decl = kr.style, props = {}, easing = null, comp = null;
        for (var i = 0; i < decl.length; i++) { var p = decl[i], v = decl.getPropertyValue(p); if (p === "animation-timing-function") easing = v; else if (p === "animation-composition") comp = v.trim().toLowerCase(); else if (A.knownProperty(p) && !/^animation/.test(p)) props[p] = v; }
        // Stylo expands vertical-align into baseline-* longhands; it animates as one value
        var va = decl.getPropertyValue("vertical-align");
        if (va) { props["vertical-align"] = va; delete props["baseline-shift"]; delete props["alignment-baseline"]; delete props["baseline-source"]; }
        var key = off + "|" + (easing || "") + "|" + (comp || "");
        if (!byOffset[key]) { byOffset[key] = { offset: off, easing: easing, comp: comp, props: {} }; order.push(key); }
        Object.assign(byOffset[key].props, props);
      });
    });
    var frames = order.map(function (k) { return byOffset[k]; }).sort(function (a, b) { return a.offset - b.offset; });
    return frames.map(function (f) { var e = (f.easing && A.parseEasing(f.easing)) || A.parseEasing("ease"); return { offset: f.offset, computedOffset: f.offset, easing: e.text, easingParsed: e, composite: /^(replace|add|accumulate)$/.test(f.comp || "") ? f.comp : "auto", props: f.props, _ownEasing: !!f.easing }; });
  }

  // ---- candidate elements: matched by rules / inline styles mentioning animation or transition
  function candidates(doc, rules, word) {
    var set = new Set();
    rules.forEach(function (r) {
      if (r.type !== 1 || !r.selectorText) return;
      var t = String(r.cssText || "");
      var body = t.slice(t.indexOf("{"));
      if (body.indexOf(word) < 0) return;
      try { doc.querySelectorAll(r.selectorText).forEach(function (e) { set.add(e); }); } catch (e) {}
    });
    try { doc.querySelectorAll("[style*='" + word + "']").forEach(function (e) { set.add(e); }); } catch (e) {}
    return set;
  }
  var tracked = { anim: new Set(), trans: new Set() };
  var lastKey = -1;
  A.inCssUpdate = false;
  // CSS animations/transitions are evaluated for test pages; on real pages the scan over large
  // stylesheets on every style read costs more than it gives a headless renderer
  var cssEnabled = function () { if (__jb.wptMode) return true; try { return !!(globalThis.top && globalThis.top.__jb && globalThis.top.__jb.wptMode); } catch (e) { return false; } };
  A.cssUpdate = function (force) {
    if (A.inCssUpdate || typeof __jb.currentDocument === "undefined" || !__jb.currentDocument.documentElement || !cssEnabled()) return;
    var key = __jb.layoutKey ? __jb.layoutKey() : 0;
    if (!force && key === lastKey) return;
    A.inCssUpdate = true;
    A.prevFlushKey = lastKey;
    try {
      var rules = sheetRules(__jb.currentDocument);
      A.cssRulesCache = rules;
      var ac = candidates(__jb.currentDocument, rules, "animation");
      tracked.anim.forEach(function (e) { ac.add(e); });
      ac.forEach(function (el) { updateAnimations(el, rules); });
      var tc = candidates(__jb.currentDocument, rules, "transition");
      tracked.trans.forEach(function (e) { tc.add(e); });
      // parents first: a value that changes through inheritance from a transitioning parent
      // does not start its own transition
      __jb.arrayFrom(tc).sort(function (x, y) { return x === y ? 0 : (x.compareDocumentPosition(y) & 4 ? -1 : 1); }).forEach(function (el) { updateTransitions(el); });
    } finally { A.inCssUpdate = false; lastKey = __jb.layoutKey ? __jb.layoutKey() : 0; }
  };
  A.cssActive = function () { return tracked.anim.size > 0 || tracked.trans.size > 0; };
  function displayed(el) { return el.isConnected && A.isRendered(el); }

  // ---- CSS animations
  function updateAnimations(el, rules) {
    var list = el._cssAnims || [];
    var names = [];
    var cs = {};
    if (displayed(el)) {
      prefetch(el, ["animation-name", "animation-duration", "animation-delay", "animation-iteration-count", "animation-direction", "animation-fill-mode", "animation-play-state", "animation-timing-function", "animation-composition"]);
      names = splitList(raw(el, "animation-name")).map(unquote);
      if (names.length === 1 && names[0] === "none") names = [];
      ["animation-duration", "animation-delay", "animation-iteration-count", "animation-direction", "animation-fill-mode", "animation-play-state", "animation-timing-function", "animation-composition"].forEach(function (p) { cs[p] = splitList(raw(el, p)); });
    }
    var next = [];
    names.forEach(function (name, i) {
      if (name === "none" || !name) return;
      var rule = keyframesFor(name, rules);
      var existing = null;
      for (var j = 0; j < list.length; j++) if (list[j].name === name && next.indexOf(list[j]) < 0) { existing = list[j]; break; }
      var timing = {
        duration: Math.max(0, timeMs(at(cs["animation-duration"], i, "0s"))),
        delay: timeMs(at(cs["animation-delay"], i, "0s")),
        iterations: (function (v) { v = String(v || "1"); return v === "infinite" ? Infinity : Math.max(0, parseFloat(v) || 0); })(at(cs["animation-iteration-count"], i, "1")),
        direction: at(cs["animation-direction"], i, "normal"),
        fill: at(cs["animation-fill-mode"], i, "none"),
        easing: at(cs["animation-timing-function"], i, "ease"),
      };
      var paused = at(cs["animation-play-state"], i, "running") === "paused";
      var composite = at(cs["animation-composition"], i, "replace");
      if (!rule && !existing) return; // no @keyframes rule: nothing runs
      if (!existing) {
        var effect = new KeyframeEffect(el, null);
        effect._frames = rule ? framesFromRule(rule, el) : [];
        applyCssTiming(effect, timing, {});
        if (/^(add|accumulate|replace)$/.test(composite)) effect._composite = composite;
        A.cssCreating = true; var a; try { a = new CSSAnimation(effect, A.documentTimeline); } finally { A.cssCreating = false; }
        a._s.animationName = name; a._s.owner = el; a._s.nameIndex = i; a._s.overrides = {};
        a._owningElement = function () { return this._s.owner; };
        a._cssCancelled = function () { queueCssEvent(this, "animationcancel"); this._s.cssPhase = "idle"; };
        a._s.cssPhase = "idle"; a._s.cssIter = null;
        if (paused) { a.pause(); } else a.play();
        a._s.cssPaused = paused;
        existing = { name: name, anim: a };
        // owning-element API overrides: pause()/play() from script stick
        wrapOverrides(a);
      } else {
        var an = existing.anim;
        an._s.nameIndex = i;
        if (rule && !an._s.overrides.keyframes) { an._s.effect && (an._s.effect._frames = framesFromRule(rule, el)); }
        if (an._s.effect) applyCssTiming(an._s.effect, timing, an._s.overrides);
        if (!an._s.overrides.playState) {
          if (paused && !an._s.cssPaused) { an._s.cssPaused = true; A.internalCall = true; try { an.pause(); } finally { A.internalCall = false; } }
          else if (!paused && an._s.cssPaused) { an._s.cssPaused = false; A.internalCall = true; try { an.play(); } finally { A.internalCall = false; } }
        }
        A.invalidate(an._s.effect);
      }
      next.push(existing);
    });
    list.forEach(function (x) { if (next.indexOf(x) < 0) { var a = x.anim; a._s.owner = null; A.internalCall = true; try { if (a.playState !== "idle") { queueCssEvent(a, "animationcancel", el); } a._cssCancelled = null; a.cancel(); } finally { A.internalCall = false; } } });
    el._cssAnims = next;
    if (next.length) tracked.anim.add(el); else tracked.anim.delete(el);
    if (next.length) A.scheduleTick();
  }
  function applyCssTiming(effect, t, overrides) {
    var tm = effect._timing;
    if (!overrides.duration) tm.duration = t.duration;
    if (!overrides.delay) tm.delay = t.delay;
    if (!overrides.iterations) tm.iterations = t.iterations;
    if (!overrides.direction && /^(normal|reverse|alternate|alternate-reverse)$/.test(t.direction)) tm.direction = t.direction;
    if (!overrides.fill && /^(none|forwards|backwards|both)$/.test(t.fill)) tm.fill = t.fill;
    if (!overrides.easing) { tm.easing = A.parseEasing("linear"); }
    // the animation-timing-function applies per keyframe interval (keyframes without their own)
    var e = A.parseEasing(t.easing) || A.parseEasing("ease");
    effect._cssEasing = e;
    effect._frames.forEach(function (f) { if (!f._ownEasing) { f.easing = e.text; f.easingParsed = e; } });
  }
  function wrapOverrides(a) {
    var o = a._s.overrides;
    ["pause", "play"].forEach(function (m) {
      var orig = Animation.prototype[m];
      Object.defineProperty(a, m, { value: function () { if (!A.internalCall) o.playState = true; return orig.apply(this, arguments); }, writable: true, configurable: true, enumerable: false });
    });
    var eff = a._s.effect;
    if (eff) {
      var ut = AnimationEffect.prototype.updateTiming;
      Object.defineProperty(eff, "updateTiming", { value: function (t) { if (t && typeof t === "object") Object.keys(t).forEach(function (k) { o[k] = true; }); return ut.apply(this, arguments); }, writable: true, configurable: true });
      var sk = KeyframeEffect.prototype.setKeyframes;
      Object.defineProperty(eff, "setKeyframes", { value: function () { o.keyframes = true; return sk.apply(this, arguments); }, writable: true, configurable: true });
    }
  }

  // ---- CSS transitions
  var TRACKED_PROPS = ["opacity", "transform", "translate", "rotate", "scale", "color", "background-color", "width", "height", "min-width", "min-height", "max-width", "max-height", "left", "top", "right", "bottom", "margin-left", "margin-right", "margin-top", "margin-bottom", "padding-left", "padding-right", "padding-top", "padding-bottom", "font-size", "line-height", "letter-spacing", "word-spacing", "border-left-color", "border-right-color", "border-top-color", "border-bottom-color", "border-left-width", "border-right-width", "border-top-width", "border-bottom-width", "outline-color", "outline-width", "visibility", "z-index", "filter", "box-shadow", "text-shadow", "flex-grow", "flex-shrink", "flex-basis", "font-weight", "text-indent", "vertical-align", "background-position", "background-size", "border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius", "clip-path", "column-count", "column-width", "column-rule-color", "column-rule-width", "column-height", "transform-origin", "perspective", "perspective-origin", "object-position", "object-view-box", "font-size-adjust", "font-stretch", "outline-offset", "word-spacing", "background-image", "border-spacing", "text-decoration-thickness", "text-underline-offset", "fill", "stroke", "stroke-width", "column-gap", "row-gap", "text-decoration-color", "caret-color", "order"];
  var SHORT = { margin: ["margin-top", "margin-right", "margin-bottom", "margin-left"], padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"], "border-color": ["border-top-color", "border-right-color", "border-bottom-color", "border-left-color"], "border-width": ["border-top-width", "border-right-width", "border-bottom-width", "border-left-width"], inset: ["top", "right", "bottom", "left"], background: ["background-color", "background-position", "background-size"], border: ["border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width"], outline: ["outline-color", "outline-width"], flex: ["flex-grow", "flex-shrink", "flex-basis"], "border-radius": ["border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius"], gap: ["row-gap", "column-gap"], "column-rule": ["column-rule-color", "column-rule-width"], columns: ["column-width", "column-count"] };
  // `all`: the tracked list plus whatever animatable longhands the element's inline style sets
  function expandProp(p, el) {
    if (p === "all") {
      var extra = [];
      try {
        var st = el && el.style;
        for (var i = 0; st && i < st.length; i++) { var n = st[i]; if (n && n.indexOf("--") !== 0 && !(n in NOT_ANIMATABLE) && TRACKED_PROPS.indexOf(n) < 0) extra.push(n); }
      } catch (e) {}
      return extra.length ? TRACKED_PROPS.concat(extra) : TRACKED_PROPS;
    }
    if (SHORT[p]) return SHORT[p]; return [p];
  }
  function updateTransitions(el) {
    var fresh = !el._tState;
    var st = el._tState || (el._tState = { values: {}, running: {} });
    st.fresh = fresh;
    if (!displayed(el)) {
      Object.keys(st.running).forEach(function (p) { cancelTransition(el, p); });
      st.values = {};
      tracked.trans.delete(el);
      return;
    }
    prefetch(el, ["transition-property", "transition-duration", "transition-delay", "transition-timing-function", "transition-behavior"]);
    var props = splitList(raw(el, "transition-property")), durs = splitList(raw(el, "transition-duration")), dels = splitList(raw(el, "transition-delay")), fns = splitList(raw(el, "transition-timing-function")), behs = splitList(raw(el, "transition-behavior"));
    var spec = {};
    props.forEach(function (p, i) {
      p = p.trim();
      if (!p || p === "none") return;
      expandProp(p, el).forEach(function (q) { spec[q] = { duration: Math.max(0, timeMs(at(durs, i, "0s"))), delay: timeMs(at(dels, i, "0s")), easing: at(fns, i, "ease"), discrete: at(behs, i, "normal") === "allow-discrete", name: q }; });
    });
    var watch = {};
    Object.keys(spec).forEach(function (p) { watch[p] = 1; });
    Object.keys(st.values).forEach(function (p) { watch[p] = 1; });
    Object.keys(st.running).forEach(function (p) { watch[p] = 1; });
    var any = false;
    prefetch(el, Object.keys(watch));
    Object.keys(watch).forEach(function (p) {
      var s = spec[p];
      var now = raw(el, p);
      if (now === null || now === undefined) now = el.style.getPropertyValue(p) || "";
      var before = st.values[p];
      if (before === undefined && el._beforeStyle && el._beforeStyle[p] !== undefined) before = el._beforeStyle[p];
      // the value read at the previous style flush stands for the before-change style
      if (before === undefined && (st.fresh || !(p in st.values)) && el._lastStyle && el._lastStyle[p] && el._lastStyle[p].key === A.prevFlushKey) before = el._lastStyle[p].v;
      var run = st.running[p];
      if (run && run.anim.playState === "finished") { completeTransition(el, p); run = null; }
      if (before !== undefined && before !== now && RESOLVED.test(p) && !st.running[p]) {
        var sp = specifiedOf(el, p);
        if (!sp || /^auto$/i.test(sp)) { st.values[p] = now; return; }
      }
      if (before !== undefined && before !== now) {
        var combined = s ? s.duration + s.delay : 0;
        var fromVal = run ? (A.animatedValue(el, p) || before) : before;
        var interp = A.interpolate(A.parseValue(fromVal, p, el), A.parseValue(now, p, el), 0.5, p) !== null;
        var pr = el.parentElement && el.parentElement._tState && el.parentElement._tState.running[p];
        if (run && run.to === now) { /* already transitioning there */ }
        else if (!run && pr && pr.to === now && pr.from === before) { /* inherited from the parent's transition */ }
        else if (s && combined > 0 && (interp || s.discrete)) {
          var dur = s.duration, delay = s.delay, startVal = fromVal, factor = 1;
          if (run && run.reversingStart === now) {
            // reversing an interrupted transition: shorten by the progress made
            var rp = run.anim.effect ? (run.anim.effect.getComputedTiming().progress || 0) : 0;
            factor = Math.min(1, Math.max(0, rp * run.factor + (1 - run.factor)));
            dur = dur * factor; if (delay < 0) delay = delay * factor;
          }
          if (run) cancelTransition(el, p);
          startTransition(el, p, startVal, now, dur, delay, s.easing, run && run.reversingStart === now ? run.to : startVal, factor);
        } else if (run) cancelTransition(el, p);
      } else if (run && !s) cancelTransition(el, p);
      if (s || st.running[p]) any = true;
      st.values[p] = now;
    });
    st.fresh = false;
    el._beforeStyle = null;
    if (any || Object.keys(st.running).length) { tracked.trans.add(el); A.scheduleTick(); } else tracked.trans.delete(el);
  }
  // Properties the layout engine reports as resolved (used) values: a change of the resolved value
  // alone (e.g. width:auto after a padding change) is not a computed-value change.
  var RESOLVED = /^(width|height|min-width|min-height|max-width|max-height|top|left|right|bottom|margin-(top|right|bottom|left)|inset)$/;
  function specifiedOf(el, p) {
    var v = "";
    try { v = el.style.getPropertyValue(p); } catch (e) {}
    if (v) return v;
    var found = "";
    (A.cssRulesCache || []).forEach(function (r) {
      if (r.type !== 1 || !r.style) return;
      var x = ""; try { x = r.style.getPropertyValue(p); } catch (e) {}
      if (!x) return;
      try { if (el.matches(r.selectorText)) found = x; } catch (e) {}
    });
    return found;
  }
  // before-change style: an inline style change on an element that may transition records the
  // property's current computed value (the style before the change)
  A.recordBefore = function (el, prop) {
    if (A.inCssUpdate || A.baseDepth || !el || el.nodeType !== 1 || !el.isConnected) return;
    var inline = el.getAttribute("style") || "";
    if (!el._tState && inline.indexOf("transition") < 0 && !tracked.trans.has(el)) return;
    // an element whose style was never computed has no before-change style
    if (!el._tState && !el._lastStyle) return;
    A.scheduleTick();
    var props = __jb.cssShort && __jb.cssShort[prop] ? __jb.cssShort[prop].longhands : SHORT[prop] ? SHORT[prop] : [prop];
    var bs = el._beforeStyle || (el._beforeStyle = {});
    // reading a stale style costs a relayout: only for inline transitions; otherwise cached values
    var key = __jb.layoutKey ? __jb.layoutKey() : 0, c = el._csCache, fresh = c && c.key === key;
    var mayRead = inline.indexOf("transition") >= 0;
    props.forEach(function (p) {
      if (bs[p] !== undefined || (el._tState && el._tState.values[p] !== undefined)) return;
      var v = null;
      var ls = el._lastStyle && el._lastStyle[p];
      if (ls && ls.key === lastKey) v = ls.v; // read at the latest style flush
      else if (fresh && p in c.values) v = c.values[p];
      else if (mayRead && !ls) v = raw(el, p);
      if (v !== null && v !== undefined) bs[p] = v;
    });
  };
  // removing an element cancels its CSS transitions and animations
  A.cancelCssFor = function (node) {
    var visit = function (el) {
      if (el._tState) { Object.keys(el._tState.running).forEach(function (p) { cancelTransition(el, p); }); el._tState = null; tracked.trans.delete(el); }
      if (el._cssAnims && el._cssAnims.length) { el._cssAnims.forEach(function (x) { var a = x.anim; a._s.owner = null; A.internalCall = true; try { if (a.playState !== "idle") queueCssEvent(a, "animationcancel", el); a._cssCancelled = null; a.cancel(); } finally { A.internalCall = false; } }); el._cssAnims = []; tracked.anim.delete(el); }
    };
    // (__jb.disconnected runs for every node of the removed subtree)
    if (node.nodeType !== 1 || (!node._tState && !(node._cssAnims && node._cssAnims.length))) return;
    visit(node);
  };
  var baseDisconnected = __jb.disconnected;
  __jb.disconnected = function (node) { baseDisconnected.apply(this, arguments); try { A.cancelCssFor(node); } catch (e) { __jb.reportException(e); } };
  var transitionGen = 0;
  function startTransition(el, prop, from, to, duration, delay, easing, reversingStart, factor) {
    var effect = new KeyframeEffect(el, null);
    var e = A.parseEasing(easing) || A.parseEasing("ease");
    var f0 = { offset: null, computedOffset: 0, easing: e.text, easingParsed: e, composite: "auto", props: {} }, f1 = { offset: null, computedOffset: 1, easing: "linear", easingParsed: A.parseEasing("linear"), composite: "auto", props: {} };
    f0.props[prop] = from; f1.props[prop] = to;
    effect._frames = [f0, f1];
    effect._timing.duration = duration; effect._timing.delay = delay; effect._timing.fill = "backwards";
    A.cssCreating = true; var a; try { a = new CSSTransition(effect, A.documentTimeline); } finally { A.cssCreating = false; }
    a._s.transitionProperty = prop; a._s.owner = el; a._s.transitionGen = ++transitionGen;
    a._owningElement = function () { return this._s.owner; };
    a._cssCancelled = function () { queueCssEvent(this, "transitioncancel"); };
    a._s.cssPhase = "idle";
    el._tState.running[prop] = { anim: a, to: to, from: from, reversingStart: reversingStart, factor: factor };
    a.play();
    queueCssEvent(a, "transitionrun");
    A.scheduleTick();
  }
  function cancelTransition(el, prop) {
    var r = el._tState && el._tState.running[prop];
    if (!r) return;
    delete el._tState.running[prop];
    var a = r.anim;
    a._s.owner = null;
    A.internalCall = true;
    try { if (a.playState !== "idle" && a.playState !== "finished") { queueCssEvent(a, "transitioncancel", el); } a._cssCancelled = null; a.cancel(); } finally { A.internalCall = false; }
  }
  function completeTransition(el, prop) { var r = el._tState.running[prop]; if (r) { delete el._tState.running[prop]; } }

  // ---- events (animationstart/iteration/end/cancel, transitionrun/start/end/cancel)
  function elapsed(a, which) {
    var e = a._s.effect; if (!e) return 0;
    var t = e._timing, d = t.duration === "auto" ? 0 : t.duration, ad = A.activeDuration(t);
    var startI = Math.max(Math.min(-t.delay, ad), 0), endI = Math.max(Math.min(ad - Math.min(t.delay, 0) * 0 , ad), 0);
    if (which === "start") return startI;
    if (which === "end") return ad;
    return startI;
  }
  function queueCssEvent(a, type, target, elapsedOverride) {
    var el = target || a._s.owner;
    if (!el) return;
    var isT = a instanceof CSSTransition;
    var tt = a._s.timeline ? A.tlNow(a._s.timeline) : null;
    var et = elapsedOverride !== undefined ? elapsedOverride : (type === "animationcancel" || type === "transitioncancel" ? cancelElapsed(a) : type === "transitionend" || type === "animationend" ? elapsed(a, "end") : elapsed(a, "start"));
    A.queueEventRaw({ target: a, dispatchTarget: el, type: type, time: tt === null ? -Infinity : tt, make: function () {
      var init = { bubbles: true, cancelable: false, elapsedTime: et / 1000, pseudoElement: "", animation: a };
      if (isT) { init.propertyName = a._s.transitionProperty; return new TransitionEvent(type, init); }
      init.animationName = a._s.animationName; return new AnimationEvent(type, init);
    } });
  }
  function cancelElapsed(a) { var e = a._s.effect; if (!e) return 0; var ct = A.currentTimeOf(a); if (ct === null) { var r0 = a._s.lastActive; return r0 || 0; } var r = A.computeTiming(A.effTiming(e), ct, true, "both"); return r.activeTime === null ? 0 : r.activeTime; }
  // per frame (before the frame's events are dispatched): phase transitions -> events
  A.beforeDispatch = function () {
    A.all.forEach(function (a) {
      if (!(a instanceof CSSAnimation || a instanceof CSSTransition)) return;
      var s = a._s, e = s.effect;
      if (!s.owner || !e) return;
      var ct = A.currentTimeOf(a);
      var phase = "idle", iter = null;
      if (ct !== null && a.playState !== "idle") { var r = A.computeTiming(A.effTiming(e), ct, a.playbackRate >= 0, "both"); phase = r.phase; iter = r.currentIteration; if (r.activeTime !== null) s.lastActive = r.activeTime; }
      var prev = s.cssPhase || "idle", isT = a instanceof CSSTransition;
      var ad = A.activeDuration(e._timing);
      if (isT) {
        if ((prev === "idle" || prev === "before") && phase === "active") queueCssEvent(a, "transitionstart");
        else if ((prev === "idle" || prev === "before") && phase === "after") { queueCssEvent(a, "transitionstart"); queueCssEvent(a, "transitionend"); }
        else if (prev === "active" && phase === "after") queueCssEvent(a, "transitionend");
        else if (prev === "active" && phase === "before") queueCssEvent(a, "transitionend", null, 0);
        else if (prev === "after" && phase === "active") queueCssEvent(a, "transitionstart", null, ad);
        else if (prev === "after" && phase === "before") { queueCssEvent(a, "transitionstart", null, ad); queueCssEvent(a, "transitionend", null, 0); }
      } else {
        var d = e._timing.duration === "auto" ? 0 : e._timing.duration;
        if ((prev === "idle" || prev === "before") && phase === "active") queueCssEvent(a, "animationstart");
        else if ((prev === "idle" || prev === "before") && phase === "after") { queueCssEvent(a, "animationstart"); queueCssEvent(a, "animationend"); }
        else if (prev === "active" && phase === "before") queueCssEvent(a, "animationend", null, 0);
        else if (prev === "active" && phase === "active" && s.cssIter !== null && iter !== s.cssIter) queueCssEvent(a, "animationiteration", null, (Math.min(iter, s.cssIter) + (iter > s.cssIter ? 1 : 1) - e._timing.iterationStart) * d);
        else if (prev === "active" && phase === "after") queueCssEvent(a, "animationend");
        else if (prev === "after" && phase === "active") queueCssEvent(a, "animationstart", null, ad);
        else if (prev === "after" && phase === "before") { queueCssEvent(a, "animationstart", null, ad); queueCssEvent(a, "animationend", null, 0); }
      }
      s.cssPhase = phase; s.cssIter = iter;
    });
  };
})();
