// Part 9c: CSS Typed OM. CSSStyleValue and its subclasses (numeric values with types and math
// expressions, keywords, unparsed values / var() references, transforms, images, colors),
// the CSS.* numeric factories, and StylePropertyMap(ReadOnly) over inline style
// (element.attributeStyleMap), CSS rules (CSSStyleRule.styleMap) and computed style
// (element.computedStyleMap()). Values are reified from CSS text (the declaration's text, or
// getComputedStyle's) by their form; setting serializes a value and lets the CSSOM decide
// validity.
(function () {
  if (typeof CSS === "undefined") return;
  var BASE = ["length", "angle", "time", "frequency", "resolution", "flex", "percent"];
  var UNIT_TYPE = Object.create(null), TO_CANON = Object.create(null), CANON = { length: "px", angle: "deg", time: "ms", frequency: "hz", resolution: "dppx" };
  var defUnits = function (base, units) { Object.keys(units).forEach(function (u) { UNIT_TYPE[u] = base; if (units[u] !== null) TO_CANON[u] = units[u]; }); };
  defUnits("length", { px: 1, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, "in": 96, pt: 4 / 3, pc: 16,
    em: null, rem: null, ex: null, rex: null, cap: null, rcap: null, ch: null, rch: null, ic: null, ric: null, lh: null, rlh: null,
    vw: null, vh: null, vi: null, vb: null, vmin: null, vmax: null, svw: null, svh: null, svi: null, svb: null, svmin: null, svmax: null,
    lvw: null, lvh: null, lvi: null, lvb: null, lvmin: null, lvmax: null, dvw: null, dvh: null, dvi: null, dvb: null, dvmin: null, dvmax: null,
    cqw: null, cqh: null, cqi: null, cqb: null, cqmin: null, cqmax: null });
  defUnits("angle", { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 });
  defUnits("time", { s: 1000, ms: 1 });
  defUnits("frequency", { hz: 1, khz: 1000 });
  defUnits("resolution", { dpi: 1 / 96, dpcm: 2.54 / 96, dppx: 1, x: 1 });
  defUnits("flex", { fr: null });
  UNIT_TYPE.percent = "percent"; UNIT_TYPE.number = null;
  var unitKnown = function (u) { return u === "number" || Object.prototype.hasOwnProperty.call(UNIT_TYPE, u); };
  var dom = function (n, m) { return __jb.domError(n, m); };
  var creating = false;
  var internal = function (C, fn) { creating = true; try { return fn(); } finally { creating = false; } };

  // ---------------------------------------------------------------- numeric types
  var emptyType = function () { var t = {}; BASE.forEach(function (b) { t[b] = 0; }); t.hint = null; return t; };
  var typeOfUnit = function (u) { var t = emptyType(); var b = UNIT_TYPE[u]; if (b) t[b] = 1; return t; };
  var copyType = function (t) { var o = {}; BASE.forEach(function (b) { o[b] = t[b] || 0; }); o.hint = t.hint || null; return o; };
  var applyHint = function (t, hint) { t[hint] = (t[hint] || 0) + (t.percent || 0); if (hint !== "percent") t.percent = 0; t.hint = hint; };
  var sameEntries = function (a, b) { return BASE.every(function (k) { return (a[k] || 0) === (b[k] || 0); }); };
  var addTypes = function (t1, t2) {
    var a = copyType(t1), b = copyType(t2);
    if (a.hint && b.hint && a.hint !== b.hint) return null;
    if (a.hint) applyHint(b, a.hint); else if (b.hint) applyHint(a, b.hint);
    if (sameEntries(a, b)) return a;
    if ((a.percent || b.percent) && !(a.hint || b.hint)) {
      for (var i = 0; i < BASE.length; i++) {
        var h = BASE[i];
        if (h === "percent") continue;
        var a2 = copyType(a), b2 = copyType(b);
        applyHint(a2, h); applyHint(b2, h);
        if (sameEntries(a2, b2)) return a2;
      }
    }
    return null;
  };
  var mulTypes = function (t1, t2) {
    var a = copyType(t1), b = copyType(t2);
    if (a.hint && b.hint && a.hint !== b.hint) return null;
    if (a.hint) applyHint(b, a.hint); else if (b.hint) applyHint(a, b.hint);
    BASE.forEach(function (k) { a[k] = (a[k] || 0) + (b[k] || 0); });
    a.hint = a.hint || b.hint;
    return a;
  };
  var invertType = function (t) { var o = copyType(t); BASE.forEach(function (k) { o[k] = -(o[k] || 0); }); return o; };
  var typeDict = function (t) { var o = {}; BASE.forEach(function (k) { if (t[k]) o[k] = t[k]; }); if (t.hint) o.percentHint = t.hint; return o; };
  var isNumberType = function (t) { return BASE.every(function (k) { return !t[k]; }); };
  var matchesBase = function (t, base) { return BASE.every(function (k) { return k === base ? t[k] === 1 : !t[k]; }); };

  // ---------------------------------------------------------------- value classes
  class CSSStyleValue {
    constructor() { if (!creating) throw new TypeError("Illegal constructor"); }
    toString() { return this._text === undefined ? "" : this._text; }
    static parse(property, cssText) { if (arguments.length < 2) throw new TypeError("CSSStyleValue.parse: 2 arguments required"); return parseFor(property, cssText, false)[0]; }
    static parseAll(property, cssText) { if (arguments.length < 2) throw new TypeError("CSSStyleValue.parseAll: 2 arguments required"); return parseFor(property, cssText, true); }
  }
  var unsupported = function (text, prop) { var v = internal(CSSStyleValue, function () { return new CSSStyleValue(); }); Object.defineProperty(v, "_text", { value: String(text) }); Object.defineProperty(v, "_prop", { value: prop || null }); return v; };

  var rectify = function (v) {
    if (typeof v === "number") return internal(CSSUnitValue, function () { return new CSSUnitValue(v, "number"); });
    if (v instanceof CSSNumericValue) return v;
    throw new TypeError("Value is not a CSSNumericValue or a number");
  };
  // A typed value must match the property's grammar by its type, not by its text (CSS.number(0)
  // serializes as "0", which is a valid <length>). Value categories the grammar of properties
  // without a Stylo parser (stored as text) accepts, plus box properties: l length, p percentage,
  // n number, a angle, i image; "" = keywords / colors only.
  var TYPED_GRAMMAR = (function () {
    var g = Object.create(null), set = function (cats, names) { names.split(" ").forEach(function (n) { g[n] = cats; }); };
    set("", "accent-color anchor-scope break-inside clip-rule color-interpolation counter-set dominant-baseline flood-color lighting-color stop-color text-emphasis-color font-palette font-variant-emoji hyphens overflow-anchor page paint-order position-visibility resize scrollbar-gutter shape-rendering speak text-anchor text-autospace text-box-trim text-combine-upright text-decoration-skip-ink text-emphasis-position transform-box vector-effect white-space-collapse text-wrap-mode text-wrap-style white-space-trim column-rule-color column-rule-style");
    set("lp", "baseline-shift cx cy x y r rx ry width height min-width min-height max-width max-height block-size inline-size min-block-size min-inline-size max-block-size max-inline-size top left bottom right letter-spacing word-spacing text-indent text-decoration-thickness text-underline-offset font-size flex-basis offset-distance shape-margin");
    set("l", "overflow-clip-margin outline-offset outline-width perspective column-width column-rule-width");
    set("np", "flood-opacity stop-opacity");
    set("n", "orphans widows shape-image-threshold");
    set("p", "text-size-adjust");
    set("a", "offset-rotate");
    set("i", "shape-outside");
    return g;
  })();
  function typedValueAllowed(map, prop, v) {
    if (v instanceof CSSKeywordValue || v instanceof CSSUnparsedValue || Object.getPrototypeOf(v) === CSSStyleValue.prototype) return true;
    var cats = TYPED_GRAMMAR[prop];
    if (v instanceof CSSNumericValue) {
      var t = v.type(), keys = Object.keys(t).filter(function (k) { return k !== "percentHint" && t[k] !== 0; });
      var need = keys.length ? keys.map(function (k) { return { length: "l", percent: "p", angle: "a", time: "t", frequency: "q", resolution: "r", flex: "f" }[k] || "?"; }) : ["n"];
      if (cats !== undefined) return need.every(function (c) { return cats.indexOf(c) >= 0; });
      // unitless numbers only where the grammar takes numbers (a non-zero integer parses)
      if (!keys.length && prop.indexOf("--") !== 0) {
        var st = map._style, before = st.getPropertyValue(prop), prio = st.getPropertyPriority(prop);
        var ok = map._try(prop, "7");
        st.removeProperty(prop);
        if (before !== "") st.setProperty(prop, before, prio);
        return ok;
      }
      return true;
    }
    if (cats === undefined) return true;
    if (typeof CSSImageValue === "function" && v instanceof CSSImageValue) return cats.indexOf("i") >= 0;
    return cats.indexOf("x") >= 0;
  }
  class CSSNumericValue extends CSSStyleValue {
    constructor() { if (!creating) throw new TypeError("Illegal constructor"); super(); }
    add() { return arith(this, arguments, "add"); }
    sub() { return arith(this, arguments, "sub"); }
    mul() { return arith(this, arguments, "mul"); }
    div() { return arith(this, arguments, "div"); }
    min() { return arith(this, arguments, "min"); }
    max() { return arith(this, arguments, "max"); }
    equals() { var self = this; var vals = __jb.A.map.call(arguments, rectify); return vals.every(function (v) { return numEquals(self, v); }); }
    to(unit) {
      if (arguments.length < 1) throw new TypeError("CSSNumericValue.to: 1 argument required");
      var u = normUnit(unit);
      if (!unitKnown(u)) throw new SyntaxError("Invalid unit '" + unit + "'");
      var sum = toSumValues(this);
      if (!sum || sum.length !== 1) throw new TypeError("Cannot convert to " + unit);
      var item = sum[0];
      var c = convertUnit(item.value, item.unit, u);
      if (c === null) throw new TypeError("Cannot convert " + item.unit + " to " + unit);
      return makeUnit(c, u);
    }
    toSum() {
      var units = __jb.A.map.call(arguments, function (x) { var u = normUnit(x); if (!unitKnown(u)) throw new SyntaxError("Invalid unit '" + x + "'"); return u; });
      var sum = toSumValues(this);
      if (!sum) throw new TypeError("This value cannot be converted to a sum");
      if (!units.length) {
        sum.sort(function (a, b) { return a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0; });
        return internal(CSSMathSum, function () { return mathOf(CSSMathSum, sum.map(function (s) { return makeUnit(s.value, s.unit); }), null); });
      }
      var out = units.map(function (u) { return { unit: u, value: 0 }; });
      sum.forEach(function (s) {
        for (var i = 0; i < out.length; i++) { var c = convertUnit(s.value, s.unit, out[i].unit); if (c !== null) { out[i].value += c; return; } }
        throw new TypeError("Cannot convert " + s.unit + " to any of the given units");
      });
      return internal(CSSMathSum, function () { return mathOf(CSSMathSum, out.map(function (s) { return makeUnit(s.value, s.unit); }), null); });
    }
    type() { return typeDict(this._type()); }
    static parse(cssText) {
      if (arguments.length < 1) throw new TypeError("CSSNumericValue.parse: 1 argument required");
      var toks = tokenize(String(cssText)).filter(function (t) { return t.t !== "ws"; });
      if (!toks.length) throw dom("SyntaxError", "Empty numeric value");
      var p = { toks: tokenize(String(cssText)), i: 0 };
      skipWs(p);
      var v = parseNumericComponent(p);
      skipWs(p);
      if (!v || p.i < p.toks.length) throw dom("SyntaxError", "'" + cssText + "' is not a numeric value");
      return v;
    }
  }
  var normUnit = function (u) { u = String(u).toLowerCase(); return u === "%" ? "percent" : u; };
  var convertUnit = function (value, from, to) {
    if (from === to) return value;
    if (from === "number" || to === "number" || from === "percent" || to === "percent") return null;
    var bf = UNIT_TYPE[from], bt = UNIT_TYPE[to];
    if (!bf || bf !== bt || TO_CANON[from] === undefined || TO_CANON[to] === undefined) return null;
    return value * TO_CANON[from] / TO_CANON[to];
  };
  class CSSUnitValue extends CSSNumericValue {
    constructor(value, unit) {
      if (arguments.length < 2) throw new TypeError("CSSUnitValue constructor: 2 arguments required");
      value = Number(value);
      var u = normUnit(unit);
      if (!unitKnown(u)) throw new TypeError("Invalid unit '" + unit + "'");
      if (!creating && !isFinite(value)) throw new TypeError("CSSUnitValue: the value is not a finite number");
      var prev = creating; creating = true;
      try { super(); } finally { creating = prev; }
      Object.defineProperty(this, "_v", { value: value, writable: true });
      Object.defineProperty(this, "_u", { value: u });
    }
    get value() { return this._v; }
    set value(v) { v = Number(v); if (!isFinite(v)) throw new TypeError("CSSUnitValue.value must be finite"); this._v = v; }
    get unit() { return this._u; }
    _type() { return typeOfUnit(this._u); }
    toString() { return serializeUnit(this, false); }
  }
  var makeUnit = function (v, u) { return internal(CSSUnitValue, function () { return new CSSUnitValue(v, u); }); };
  var numStr = function (x) {
    if (Object.is(x, -0)) return "0";
    var s = String(x);
    if (/e/i.test(s)) {
      var m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
      if (m) {
        var digits = m[2] + (m[3] || ""), exp = parseInt(m[4], 10);
        if (exp < 0) s = m[1] + "0." + new Array(-exp).join("0") + digits;
        else s = m[1] + (digits.length <= exp + 1 ? digits + new Array(exp + 2 - digits.length).join("0") : digits.slice(0, exp + 1) + "." + digits.slice(exp + 1));
      }
    }
    return s;
  };
  var unitSuffix = function (u) { return u === "percent" ? "%" : u === "number" ? "" : u; };
  var serializeUnit = function (v, nested) {
    var x = v._v, u = v._u;
    if (!isFinite(x)) {
      var inf = x !== x ? "NaN" : x > 0 ? "infinity" : "-infinity";
      var body = u === "number" ? inf : inf + " * 1" + unitSuffix(u);
      return nested ? body : "calc(" + body + ")";
    }
    return numStr(x) + unitSuffix(u);
  };
  // sum value: list of {value, unit} with distinct units, or null
  var toSumValues = function (v) {
    if (v instanceof CSSUnitValue) {
      var u = v._u, val = v._v;
      if (TO_CANON[u] !== undefined && CANON[UNIT_TYPE[u]]) { var cu = CANON[UNIT_TYPE[u]]; return [{ value: val * TO_CANON[u] / TO_CANON[cu], unit: cu }]; }
      return [{ value: val, unit: u }];
    }
    var vals = v._values ? v._values._list : null;
    if (v instanceof CSSMathSum) {
      var acc = [];
      for (var i = 0; i < vals.length; i++) {
        var s = toSumValues(vals[i]);
        if (!s) return null;
        s.forEach(function (it) { var f = acc.filter(function (a) { return a.unit === it.unit; })[0]; if (f) f.value += it.value; else acc.push({ value: it.value, unit: it.unit }); });
      }
      return acc;
    }
    if (v instanceof CSSMathNegate) { var n = toSumValues(v._value); return n ? n.map(function (it) { return { value: -it.value, unit: it.unit }; }) : null; }
    if (v instanceof CSSMathProduct) {
      var res = [{ value: 1, unit: "number" }];
      for (var j = 0; j < vals.length; j++) {
        var t = toSumValues(vals[j]);
        if (!t) return null;
        var next = [];
        for (var a = 0; a < res.length; a++) for (var b = 0; b < t.length; b++) {
          var ua = res[a].unit, ub = t[b].unit;
          var unit = ua === "number" ? ub : ub === "number" ? ua : null;
          if (unit === null) return null;
          next.push({ value: res[a].value * t[b].value, unit: unit });
        }
        res = next;
      }
      return res;
    }
    if (v instanceof CSSMathInvert) { var iv = toSumValues(v._value); if (!iv || iv.length !== 1 || iv[0].unit !== "number") return null; return [{ value: 1 / iv[0].value, unit: "number" }]; }
    if (v instanceof CSSMathMin || v instanceof CSSMathMax) {
      var parts = vals.map(toSumValues);
      if (parts.some(function (p) { return !p || p.length !== 1; })) return null;
      if (parts.some(function (p) { return p[0].unit !== parts[0][0].unit; })) return null;
      var pick = parts.map(function (p) { return p[0].value; });
      return [{ value: v instanceof CSSMathMin ? Math.min.apply(null, pick) : Math.max.apply(null, pick), unit: parts[0][0].unit }];
    }
    return null;
  };
  var numEquals = function (a, b) {
    if (a.constructor !== b.constructor) return false;
    if (a instanceof CSSUnitValue) return a._v === b._v && a._u === b._u;
    if (a instanceof CSSMathNegate || a instanceof CSSMathInvert) return numEquals(a._value, b._value);
    if (a instanceof CSSMathClamp) return numEquals(a._lower, b._lower) && numEquals(a._val, b._val) && numEquals(a._upper, b._upper);
    var x = a._values._list, y = b._values._list;
    return x.length === y.length && x.every(function (v, i) { return numEquals(v, y[i]); });
  };
  var negate = function (v) {
    if (v instanceof CSSUnitValue) return makeUnit(-v._v, v._u);
    if (v instanceof CSSMathNegate) return v._value;
    return internal(CSSMathNegate, function () { return new CSSMathNegate(v); });
  };
  var invert = function (v) {
    if (v instanceof CSSUnitValue && v._u === "number") { if (v._v === 0) throw new RangeError("Division by zero"); return makeUnit(1 / v._v, "number"); }
    if (v instanceof CSSMathInvert) return v._value;
    return internal(CSSMathInvert, function () { return new CSSMathInvert(v); });
  };
  var arith = function (self, args, op) {
    var vals = __jb.A.map.call(args, rectify);
    if (op === "sub") { vals = vals.map(negate); op = "add"; }
    if (op === "div") { vals = vals.map(invert); op = "mul"; }
    var head = function (C) { return self instanceof C ? self._values._list.slice() : [self]; };
    var all;
    if (op === "add") {
      all = head(CSSMathSum).concat(vals);
      if (all.every(function (v) { return v instanceof CSSUnitValue && v._u === all[0]._u; })) return makeUnit(__jb.A.reduce.call(all, function (s, v) { return s + v._v; }, 0), all[0]._u);
      var flat = [];
      all.forEach(function (v) { if (v instanceof CSSMathSum) flat.push.apply(flat, v._values._list); else flat.push(v); });
      var t = flat[0]._type();
      for (var i = 1; i < flat.length; i++) { t = addTypes(t, flat[i]._type()); if (!t) throw new TypeError("Incompatible types"); }
      return internal(CSSMathSum, function () { return mathOf(CSSMathSum, flat, t); });
    }
    if (op === "mul") {
      all = head(CSSMathProduct).concat(vals);
      var units = all.filter(function (v) { return v instanceof CSSUnitValue; });
      if (units.length === all.length && all.filter(function (v) { return v._u !== "number"; }).length <= 1) {
        var unit = "number", prod = 1;
        all.forEach(function (v) { prod *= v._v; if (v._u !== "number") unit = v._u; });
        return makeUnit(prod, unit);
      }
      var fl = [];
      all.forEach(function (v) { if (v instanceof CSSMathProduct) fl.push.apply(fl, v._values._list); else fl.push(v); });
      var mt = fl[0]._type();
      for (var k = 1; k < fl.length; k++) { mt = mulTypes(mt, fl[k]._type()); if (!mt) throw new TypeError("Incompatible types"); }
      return internal(CSSMathProduct, function () { return mathOf(CSSMathProduct, fl, mt); });
    }
    // min / max
    all = head(op === "min" ? CSSMathMin : CSSMathMax).concat(vals);
    if (all.every(function (v) { return v instanceof CSSUnitValue && v._u === all[0]._u; })) {
      var nums = all.map(function (v) { return v._v; });
      return makeUnit(op === "min" ? Math.min.apply(null, nums) : Math.max.apply(null, nums), all[0]._u);
    }
    var C = op === "min" ? CSSMathMin : CSSMathMax;
    var fm = [];
    all.forEach(function (v) { if (v instanceof C) fm.push.apply(fm, v._values._list); else fm.push(v); });
    var tt = fm[0]._type();
    for (var m = 1; m < fm.length; m++) { tt = addTypes(tt, fm[m]._type()); if (!tt) throw new TypeError("Incompatible types"); }
    return internal(C, function () { return mathOf(C, fm, tt); });
  };

  class CSSNumericArray {
    constructor() { if (!creating) throw new TypeError("Illegal constructor"); }
    get length() { return this._list.length; }
    [Symbol.iterator]() { return this._list.slice()[Symbol.iterator](); }
    forEach(cb, thisArg) { var self = this; this._list.forEach(function (v, i) { cb.call(thisArg, v, i, self); }); }
    keys() { return this._list.keys(); } values() { return this._list.values(); } entries() { return this._list.entries(); }
  }
  var numArray = function (list) {
    var a = internal(CSSNumericArray, function () { return new CSSNumericArray(); });
    Object.defineProperty(a, "_list", { value: list.slice() });
    return new Proxy(a, {
      get: function (t, k, r) { if (typeof k === "string" && /^\d+$/.test(k)) return t._list[+k]; var v = Reflect.get(t, k, t); return typeof v === "function" && k !== "constructor" ? v.bind(t) : v; },
      has: function (t, k) { if (typeof k === "string" && /^\d+$/.test(k)) return +k < t._list.length; return k in t; },
      set: function () { return false; },
      ownKeys: function (t) { return t._list.map(function (_, i) { return String(i); }).concat(Reflect.ownKeys(t)); },
      getOwnPropertyDescriptor: function (t, k) { if (typeof k === "string" && /^\d+$/.test(k) && +k < t._list.length) return { value: t._list[+k], writable: false, enumerable: true, configurable: true }; return Reflect.getOwnPropertyDescriptor(t, k); },
    });
  };
  var mathOf = function (C, list, type) {
    var o = Object.create(C.prototype);
    Object.defineProperty(o, "_values", { value: numArray(list) });
    Object.defineProperty(o, "_t", { value: type || null });
    return o;
  };
  class CSSMathValue extends CSSNumericValue {
    constructor() { if (!creating) throw new TypeError("Illegal constructor"); super(); }
    toString() { return serializeMath(this, false, false); }
  }
  var variadic = function (C, name, combine) {
    return function (args) {
      var vals = __jb.A.map.call(args, rectify);
      if (!vals.length) throw new SyntaxError(name + " requires at least one argument");
      var t = vals[0]._type();
      for (var i = 1; i < vals.length; i++) { t = combine(t, vals[i]._type()); if (!t) throw new TypeError(name + ": incompatible types"); }
      return { list: vals, type: t };
    };
  };
  var sumArgs = variadic(null, "CSSMathSum", addTypes), prodArgs = variadic(null, "CSSMathProduct", mulTypes), minArgs = variadic(null, "CSSMathMin", addTypes), maxArgs = variadic(null, "CSSMathMax", addTypes);
  var mathCtor = function (self, parsed) { Object.defineProperty(self, "_values", { value: numArray(parsed.list) }); Object.defineProperty(self, "_t", { value: parsed.type }); };
  class CSSMathSum extends CSSMathValue {
    constructor() { var p = sumArgs(arguments); var prev = creating; creating = true; try { super(); } finally { creating = prev; } mathCtor(this, p); }
    get values() { return this._values; } get operator() { return "sum"; }
    _type() { if (this._t) return this._t; var l = this._values._list, t = l[0]._type(); for (var i = 1; i < l.length; i++) t = addTypes(t, l[i]._type()); return t; }
  }
  class CSSMathProduct extends CSSMathValue {
    constructor() { var p = prodArgs(arguments); var prev = creating; creating = true; try { super(); } finally { creating = prev; } mathCtor(this, p); }
    get values() { return this._values; } get operator() { return "product"; }
    _type() { if (this._t) return this._t; var l = this._values._list, t = l[0]._type(); for (var i = 1; i < l.length; i++) t = mulTypes(t, l[i]._type()); return t; }
  }
  class CSSMathMin extends CSSMathValue {
    constructor() { var p = minArgs(arguments); var prev = creating; creating = true; try { super(); } finally { creating = prev; } mathCtor(this, p); }
    get values() { return this._values; } get operator() { return "min"; }
    _type() { if (this._t) return this._t; var l = this._values._list, t = l[0]._type(); for (var i = 1; i < l.length; i++) t = addTypes(t, l[i]._type()); return t; }
  }
  class CSSMathMax extends CSSMathValue {
    constructor() { var p = maxArgs(arguments); var prev = creating; creating = true; try { super(); } finally { creating = prev; } mathCtor(this, p); }
    get values() { return this._values; } get operator() { return "max"; }
    _type() { if (this._t) return this._t; var l = this._values._list, t = l[0]._type(); for (var i = 1; i < l.length; i++) t = addTypes(t, l[i]._type()); return t; }
  }
  class CSSMathClamp extends CSSMathValue {
    constructor(lower, value, upper) {
      if (arguments.length < 3) throw new TypeError("CSSMathClamp constructor: 3 arguments required");
      lower = rectify(lower); value = rectify(value); upper = rectify(upper);
      var t = addTypes(lower._type(), value._type()); if (t) t = addTypes(t, upper._type());
      if (!t) throw new TypeError("CSSMathClamp: incompatible types");
      var prev = creating; creating = true; try { super(); } finally { creating = prev; }
      Object.defineProperty(this, "_lower", { value: lower }); Object.defineProperty(this, "_val", { value: value }); Object.defineProperty(this, "_upper", { value: upper }); Object.defineProperty(this, "_t", { value: t });
    }
    get lower() { return this._lower; } get value() { return this._val; } get upper() { return this._upper; } get operator() { return "clamp"; }
    _type() { return this._t; }
  }
  class CSSMathNegate extends CSSMathValue {
    constructor(arg) { if (arguments.length < 1) throw new TypeError("CSSMathNegate constructor: 1 argument required"); arg = rectify(arg); var prev = creating; creating = true; try { super(); } finally { creating = prev; } Object.defineProperty(this, "_value", { value: arg }); }
    get value() { return this._value; } get operator() { return "negate"; }
    _type() { return copyType(this._value._type()); }
  }
  class CSSMathInvert extends CSSMathValue {
    constructor(arg) { if (arguments.length < 1) throw new TypeError("CSSMathInvert constructor: 1 argument required"); arg = rectify(arg); var prev = creating; creating = true; try { super(); } finally { creating = prev; } Object.defineProperty(this, "_value", { value: arg }); }
    get value() { return this._value; } get operator() { return "invert"; }
    _type() { return invertType(this._value._type()); }
  }
  var serializeNumeric = function (v, nested, parenLess) {
    if (v instanceof CSSUnitValue) return serializeUnit(v, nested);
    return serializeMath(v, nested, parenLess);
  };
  var serializeMath = function (v, nested, parenLess) {
    if (v instanceof CSSMathMin || v instanceof CSSMathMax) return (v instanceof CSSMathMin ? "min(" : "max(") + v._values._list.map(function (x) { return serializeNumeric(x, true, true); }).join(", ") + ")";
    if (v instanceof CSSMathClamp) return "clamp(" + [v._lower, v._val, v._upper].map(function (x) { return serializeNumeric(x, true, true); }).join(", ") + ")";
    var s = nested ? (parenLess ? "" : "(") : "calc(";
    if (v instanceof CSSMathSum) {
      var l = v._values._list;
      s += serializeNumeric(l[0], true, false);
      for (var i = 1; i < l.length; i++) {
        if (l[i] instanceof CSSMathNegate) s += " - " + serializeNumeric(l[i]._value, true, false);
        else s += " + " + serializeNumeric(l[i], true, false);
      }
    } else if (v instanceof CSSMathNegate) {
      s += "-" + serializeNumeric(v._value, true, false);
    } else if (v instanceof CSSMathProduct) {
      var p = v._values._list;
      s += serializeNumeric(p[0], true, false);
      for (var j = 1; j < p.length; j++) {
        if (p[j] instanceof CSSMathInvert) s += " / " + serializeNumeric(p[j]._value, true, false);
        else s += " * " + serializeNumeric(p[j], true, false);
      }
    } else if (v instanceof CSSMathInvert) {
      s += "1 / " + serializeNumeric(v._value, true, false);
    }
    if (!(nested && parenLess)) s += ")";
    return s;
  };

  // ---------------------------------------------------------------- keywords / unparsed / var()
  class CSSKeywordValue extends CSSStyleValue {
    constructor(value) {
      if (arguments.length < 1) throw new TypeError("CSSKeywordValue constructor: 1 argument required");
      value = String(value);
      if (value === "") throw new TypeError("CSSKeywordValue: the keyword cannot be empty");
      var prev = creating; creating = true; try { super(); } finally { creating = prev; }
      Object.defineProperty(this, "_kw", { value: value, writable: true });
    }
    get value() { return this._kw; }
    set value(v) { v = String(v); if (v === "") throw new TypeError("CSSKeywordValue: the keyword cannot be empty"); this._kw = v; }
    toString() { return serializeIdent(this._kw); }
  }
  var serializeIdent = function (s) {
    if (/^-?[A-Za-z_\u0080-￿][A-Za-z0-9_\-\u0080-￿]*$/.test(s) || /^--[A-Za-z0-9_\-\u0080-￿]*$/.test(s)) return s;
    return typeof CSS.escape === "function" ? CSS.escape(s) : s;
  };
  var checkMember = function (m) { if (typeof m === "string" || m instanceof CSSVariableReferenceValue) return m; if (m && typeof m === "object") throw new TypeError("CSSUnparsedValue members must be strings or CSSVariableReferenceValues"); return String(m); };
  class CSSUnparsedValue extends CSSStyleValue {
    constructor(members) {
      if (arguments.length < 1) throw new TypeError("CSSUnparsedValue constructor: 1 argument required");
      var list = __jb.arrayFrom(members, checkMember);
      var prev = creating; creating = true; try { super(); } finally { creating = prev; }
      Object.defineProperty(this, "_list", { value: list });
      var self = this;
      return new Proxy(this, {
        get: function (t, k) { if (typeof k === "string" && /^\d+$/.test(k)) return t._list[+k]; var v = Reflect.get(t, k, t); return typeof v === "function" && k !== "constructor" ? v.bind(t) : v; },
        set: function (t, k, v) {
          if (typeof k === "string" && /^\d+$/.test(k)) { var i = +k; if (i > t._list.length) throw new RangeError("Index out of range"); t._list[i] = checkMember(v); return true; }
          return Reflect.set(t, k, v, t);
        },
        has: function (t, k) { if (typeof k === "string" && /^\d+$/.test(k)) return +k < t._list.length; return k in t; },
        ownKeys: function (t) { return t._list.map(function (_, i) { return String(i); }).concat(Reflect.ownKeys(t)); },
        getOwnPropertyDescriptor: function (t, k) { if (typeof k === "string" && /^\d+$/.test(k) && +k < t._list.length) return { value: t._list[+k], writable: true, enumerable: true, configurable: true }; return Reflect.getOwnPropertyDescriptor(t, k); },
        getPrototypeOf: function (t) { return Object.getPrototypeOf(t); },
      });
    }
    get length() { return this._list.length; }
    [Symbol.iterator]() { return this._list.slice()[Symbol.iterator](); }
    forEach(cb, thisArg) { var self = this; this._list.forEach(function (v, i) { cb.call(thisArg, v, i, self); }); }
    keys() { return this._list.keys(); } values() { return this._list.values(); } entries() { return this._list.entries(); }
    toString() { return this._list.map(function (m) { return typeof m === "string" ? m : m.toString(); }).join(""); }
  }
  class CSSVariableReferenceValue {
    constructor(variable, fallback) {
      if (arguments.length < 1) throw new TypeError("CSSVariableReferenceValue constructor: 1 argument required");
      variable = String(variable);
      if (variable.indexOf("--") !== 0) throw new TypeError("CSSVariableReferenceValue: '" + variable + "' is not a custom property name");
      if (fallback !== undefined && fallback !== null && !(fallback instanceof CSSUnparsedValue)) throw new TypeError("CSSVariableReferenceValue: fallback must be a CSSUnparsedValue");
      Object.defineProperty(this, "_var", { value: variable, writable: true });
      Object.defineProperty(this, "_fb", { value: fallback === undefined ? null : fallback });
    }
    get variable() { return this._var; }
    set variable(v) { v = String(v); if (v.indexOf("--") !== 0) throw new TypeError("CSSVariableReferenceValue: '" + v + "' is not a custom property name"); this._var = v; }
    get fallback() { return this._fb; }
    toString() { return "var(" + this._var + (this._fb ? "," + this._fb.toString() : "") + ")"; }
  }

  // ---------------------------------------------------------------- images
  class CSSImageValue extends CSSStyleValue {
    constructor() { if (!creating) throw new TypeError("Illegal constructor"); super(); }
  }
  var imageValue = function (text) { var v = internal(CSSImageValue, function () { return new CSSImageValue(); }); Object.defineProperty(v, "_text", { value: text }); return v; };

  // ---------------------------------------------------------------- transforms
  var isLengthPct = function (v) { var t = v._type(); return matchesBase(t, "length") || matchesBase(t, "percent") || (t.hint === "length" && matchesBase(Object.assign(copyType(t), { percent: 0 }), "length")); };
  var isLength = function (v) { return matchesBase(v._type(), "length"); };
  var isAngle = function (v) { return matchesBase(v._type(), "angle"); };
  var isNumber = function (v) { return isNumberType(v._type()); };
  var D2 = function (o, v) { Object.defineProperty(o, "_is2D", { value: v, writable: true }); };
  class CSSTransformComponent {
    constructor() { if (!creating) throw new TypeError("Illegal constructor"); }
    get is2D() { return this._is2D; }
    set is2D(v) { this._is2D = !!v; }
    toMatrix() { return new DOMMatrix(this._matrixText()); }
  }
  var cv = function (v) { return v instanceof CSSUnitValue ? v._v : NaN; };
  var pxOf = function (v) { var s = toSumValues(v); return s && s.length === 1 && s[0].unit === "px" ? s[0].value : null; };
  class CSSTranslate extends CSSTransformComponent {
    constructor(x, y, z) {
      if (arguments.length < 2) throw new TypeError("CSSTranslate constructor: 2 arguments required");
      if (!(x instanceof CSSNumericValue) || !(y instanceof CSSNumericValue) || (z !== undefined && !(z instanceof CSSNumericValue))) throw new TypeError("CSSTranslate: arguments must be CSSNumericValues");
      if (!isLengthPct(x) || !isLengthPct(y) || (z !== undefined && !isLength(z))) throw new TypeError("CSSTranslate: invalid argument types");
      var prev = creating; creating = true; try { super(); } finally { creating = prev; }
      Object.defineProperty(this, "_x", { value: x, writable: true }); Object.defineProperty(this, "_y", { value: y, writable: true }); Object.defineProperty(this, "_z", { value: z === undefined ? makeUnit(0, "px") : z, writable: true });
      D2(this, z === undefined);
    }
    get x() { return this._x; } set x(v) { if (!(v instanceof CSSNumericValue) || !isLengthPct(v)) throw new TypeError("CSSTranslate.x must be a length-percentage"); this._x = v; }
    get y() { return this._y; } set y(v) { if (!(v instanceof CSSNumericValue) || !isLengthPct(v)) throw new TypeError("CSSTranslate.y must be a length-percentage"); this._y = v; }
    get z() { return this._z; } set z(v) { if (!(v instanceof CSSNumericValue) || !isLength(v)) throw new TypeError("CSSTranslate.z must be a length"); this._z = v; }
    toString() { return this._is2D ? "translate(" + this._x + ", " + this._y + ")" : "translate3d(" + this._x + ", " + this._y + ", " + this._z + ")"; }
    toMatrix() {
      var x = pxOf(this._x), y = pxOf(this._y), z = pxOf(this._z);
      if (x === null || y === null || z === null) throw new TypeError("CSSTranslate.toMatrix: relative lengths cannot be converted");
      var m = new DOMMatrix(); m = this._is2D ? m.translate(x, y) : m.translate(x, y, z); return m;
    }
  }
  var numberish = function (v, what) { v = rectify(v); if (!isNumber(v)) throw new TypeError(what + " must be a number"); return v; };
  class CSSRotate extends CSSTransformComponent {
    constructor(a, b, c, d) {
      var prev = creating; creating = true; try { super(); } finally { creating = prev; }
      if (arguments.length === 1) {
        if (!(a instanceof CSSNumericValue) || !isAngle(a)) throw new TypeError("CSSRotate: angle must be an angle");
        Object.defineProperty(this, "_x", { value: makeUnit(0, "number"), writable: true }); Object.defineProperty(this, "_y", { value: makeUnit(0, "number"), writable: true }); Object.defineProperty(this, "_z", { value: makeUnit(1, "number"), writable: true });
        Object.defineProperty(this, "_angle", { value: a, writable: true }); D2(this, true);
      } else if (arguments.length >= 4) {
        if (!(d instanceof CSSNumericValue) || !isAngle(d)) throw new TypeError("CSSRotate: angle must be an angle");
        Object.defineProperty(this, "_x", { value: numberish(a, "CSSRotate.x"), writable: true }); Object.defineProperty(this, "_y", { value: numberish(b, "CSSRotate.y"), writable: true }); Object.defineProperty(this, "_z", { value: numberish(c, "CSSRotate.z"), writable: true });
        Object.defineProperty(this, "_angle", { value: d, writable: true }); D2(this, false);
      } else throw new TypeError("CSSRotate constructor: 1 or 4 arguments required");
    }
    get x() { return this._x; } set x(v) { this._x = numberish(v, "CSSRotate.x"); }
    get y() { return this._y; } set y(v) { this._y = numberish(v, "CSSRotate.y"); }
    get z() { return this._z; } set z(v) { this._z = numberish(v, "CSSRotate.z"); }
    get angle() { return this._angle; } set angle(v) { if (!(v instanceof CSSNumericValue) || !isAngle(v)) throw new TypeError("CSSRotate.angle must be an angle"); this._angle = v; }
    toString() { return this._is2D ? "rotate(" + this._angle + ")" : "rotate3d(" + this._x + ", " + this._y + ", " + this._z + ", " + this._angle + ")"; }
    toMatrix() {
      var deg = this._angle.to("deg").value, m = new DOMMatrix();
      return this._is2D ? m.rotate(deg) : m.rotateAxisAngle(cv(this._x), cv(this._y), cv(this._z), deg);
    }
  }
  class CSSScale extends CSSTransformComponent {
    constructor(x, y, z) {
      if (arguments.length < 2) throw new TypeError("CSSScale constructor: 2 arguments required");
      var prev = creating; creating = true; try { super(); } finally { creating = prev; }
      Object.defineProperty(this, "_x", { value: numberish(x, "CSSScale.x"), writable: true }); Object.defineProperty(this, "_y", { value: numberish(y, "CSSScale.y"), writable: true });
      Object.defineProperty(this, "_z", { value: z === undefined ? makeUnit(1, "number") : numberish(z, "CSSScale.z"), writable: true }); D2(this, z === undefined);
    }
    get x() { return this._x; } set x(v) { this._x = numberish(v, "CSSScale.x"); }
    get y() { return this._y; } set y(v) { this._y = numberish(v, "CSSScale.y"); }
    get z() { return this._z; } set z(v) { this._z = numberish(v, "CSSScale.z"); }
    toString() { return this._is2D ? "scale(" + this._x + ", " + this._y + ")" : "scale3d(" + this._x + ", " + this._y + ", " + this._z + ")"; }
    toMatrix() { var m = new DOMMatrix(); return this._is2D ? m.scale(cv(this._x), cv(this._y)) : m.scale(cv(this._x), cv(this._y), cv(this._z)); }
  }
  var angleArg = function (v, what) { if (!(v instanceof CSSNumericValue) || !isAngle(v)) throw new TypeError(what + " must be an angle"); return v; };
  class CSSSkew extends CSSTransformComponent {
    constructor(ax, ay) { if (arguments.length < 2) throw new TypeError("CSSSkew constructor: 2 arguments required"); var prev = creating; creating = true; try { super(); } finally { creating = prev; } Object.defineProperty(this, "_ax", { value: angleArg(ax, "CSSSkew.ax"), writable: true }); Object.defineProperty(this, "_ay", { value: angleArg(ay, "CSSSkew.ay"), writable: true }); D2(this, true); }
    get ax() { return this._ax; } set ax(v) { this._ax = angleArg(v, "CSSSkew.ax"); }
    get ay() { return this._ay; } set ay(v) { this._ay = angleArg(v, "CSSSkew.ay"); }
    get is2D() { return true; } set is2D(v) {}
    toString() { var ay = this._ay; return "skew(" + this._ax + (ay instanceof CSSUnitValue && ay._v === 0 ? "" : ", " + ay) + ")"; }
    toMatrix() { return new DOMMatrix([1, Math.tan(this._ay.to("rad").value), Math.tan(this._ax.to("rad").value), 1, 0, 0]); }
  }
  class CSSSkewX extends CSSTransformComponent {
    constructor(ax) { if (arguments.length < 1) throw new TypeError("CSSSkewX constructor: 1 argument required"); var prev = creating; creating = true; try { super(); } finally { creating = prev; } Object.defineProperty(this, "_ax", { value: angleArg(ax, "CSSSkewX.ax"), writable: true }); D2(this, true); }
    get ax() { return this._ax; } set ax(v) { this._ax = angleArg(v, "CSSSkewX.ax"); }
    get is2D() { return true; } set is2D(v) {}
    toString() { return "skewX(" + this._ax + ")"; }
    toMatrix() { return new DOMMatrix().skewX(this._ax.to("deg").value); }
  }
  class CSSSkewY extends CSSTransformComponent {
    constructor(ay) { if (arguments.length < 1) throw new TypeError("CSSSkewY constructor: 1 argument required"); var prev = creating; creating = true; try { super(); } finally { creating = prev; } Object.defineProperty(this, "_ay", { value: angleArg(ay, "CSSSkewY.ay"), writable: true }); D2(this, true); }
    get ay() { return this._ay; } set ay(v) { this._ay = angleArg(v, "CSSSkewY.ay"); }
    get is2D() { return true; } set is2D(v) {}
    toString() { return "skewY(" + this._ay + ")"; }
    toMatrix() { return new DOMMatrix().skewY(this._ay.to("deg").value); }
  }
  var perspArg = function (v) {
    if (typeof v === "string") { if (v !== "none") throw new TypeError("CSSPerspective: invalid keyword"); return new CSSKeywordValue("none"); }
    if (v instanceof CSSKeywordValue) { if (v.value !== "none") throw new TypeError("CSSPerspective: invalid keyword"); return v; }
    if (!(v instanceof CSSNumericValue) || !isLength(v)) throw new TypeError("CSSPerspective: length must be a length");
    return v;
  };
  class CSSPerspective extends CSSTransformComponent {
    constructor(length) { if (arguments.length < 1) throw new TypeError("CSSPerspective constructor: 1 argument required"); var prev = creating; creating = true; try { super(); } finally { creating = prev; } Object.defineProperty(this, "_len", { value: perspArg(length), writable: true }); D2(this, false); }
    get length() { return this._len; } set length(v) { this._len = perspArg(v); }
    get is2D() { return false; } set is2D(v) {}
    toString() {
      var l = this._len;
      if (l instanceof CSSUnitValue && l._v < 0) return "perspective(calc(" + l + "))";
      return "perspective(" + l + ")";
    }
    toMatrix() { if (this._len instanceof CSSKeywordValue) return new DOMMatrix(); var d = pxOf(this._len); if (d === null) throw new TypeError("CSSPerspective.toMatrix: relative length"); var m = new DOMMatrix(); m.m34 = -1 / Math.max(1, d); return m; }
  }
  class CSSMatrixComponent extends CSSTransformComponent {
    constructor(matrix, options) {
      if (arguments.length < 1) throw new TypeError("CSSMatrixComponent constructor: 1 argument required");
      if (!(matrix instanceof DOMMatrixReadOnly)) throw new TypeError("CSSMatrixComponent: argument is not a DOMMatrixReadOnly");
      var prev = creating; creating = true; try { super(); } finally { creating = prev; }
      Object.defineProperty(this, "_m", { value: DOMMatrix.fromMatrix(matrix), writable: true });
      D2(this, options && options.is2D !== undefined ? !!options.is2D : matrix.is2D);
    }
    get matrix() { return this._m; } set matrix(v) { if (!(v instanceof DOMMatrixReadOnly)) throw new TypeError("CSSMatrixComponent.matrix must be a DOMMatrixReadOnly"); this._m = v; }
    toString() {
      var m = this._m;
      if (this._is2D) return "matrix(" + [m.a, m.b, m.c, m.d, m.e, m.f].map(numStr).join(", ") + ")";
      return "matrix3d(" + [m.m11, m.m12, m.m13, m.m14, m.m21, m.m22, m.m23, m.m24, m.m31, m.m32, m.m33, m.m34, m.m41, m.m42, m.m43, m.m44].map(numStr).join(", ") + ")";
    }
    toMatrix() { return DOMMatrix.fromMatrix(this._m); }
  }
  class CSSTransformValue extends CSSStyleValue {
    constructor(transforms) {
      if (arguments.length < 1) throw new TypeError("CSSTransformValue constructor: 1 argument required");
      var list = __jb.arrayFrom(transforms);
      if (!list.length) throw new TypeError("CSSTransformValue requires at least one component");
      list.forEach(function (c) { if (!(c instanceof CSSTransformComponent)) throw new TypeError("CSSTransformValue: not a CSSTransformComponent"); });
      var prev = creating; creating = true; try { super(); } finally { creating = prev; }
      Object.defineProperty(this, "_list", { value: list });
      return new Proxy(this, {
        get: function (t, k) { if (typeof k === "string" && /^\d+$/.test(k)) return t._list[+k]; var v = Reflect.get(t, k, t); return typeof v === "function" && k !== "constructor" ? v.bind(t) : v; },
        set: function (t, k, v) {
          if (typeof k === "string" && /^\d+$/.test(k)) { var i = +k; if (i > t._list.length) throw new RangeError("Index out of range"); if (!(v instanceof CSSTransformComponent)) throw new TypeError("Not a CSSTransformComponent"); t._list[i] = v; return true; }
          return Reflect.set(t, k, v, t);
        },
        has: function (t, k) { if (typeof k === "string" && /^\d+$/.test(k)) return +k < t._list.length; return k in t; },
        ownKeys: function (t) { return t._list.map(function (_, i) { return String(i); }).concat(Reflect.ownKeys(t)); },
        getOwnPropertyDescriptor: function (t, k) { if (typeof k === "string" && /^\d+$/.test(k) && +k < t._list.length) return { value: t._list[+k], writable: true, enumerable: true, configurable: true }; return Reflect.getOwnPropertyDescriptor(t, k); },
      });
    }
    get length() { return this._list.length; }
    get is2D() { return this._list.every(function (c) { return c.is2D; }); }
    toMatrix() { var m = new DOMMatrix(); this._list.forEach(function (c) { m = m.multiply(c.toMatrix()); }); return m; }
    [Symbol.iterator]() { return this._list.slice()[Symbol.iterator](); }
    forEach(cb, thisArg) { var self = this; this._list.forEach(function (v, i) { cb.call(thisArg, v, i, self); }); }
    keys() { return this._list.keys(); } values() { return this._list.values(); } entries() { return this._list.entries(); }
    toString() { return this._list.map(String).join(" "); }
  }

  // ---------------------------------------------------------------- colors
  var colorPct = function (v, what) {
    if (typeof v === "number") return makeUnit(v, "number");
    if (v instanceof CSSKeywordValue) { if (v.value !== "none") throw new SyntaxError(what + ": invalid keyword"); return v; }
    if (typeof v === "string") { if (v !== "none") throw new SyntaxError(what + ": invalid keyword"); return new CSSKeywordValue("none"); }
    if (!(v instanceof CSSNumericValue)) throw new TypeError(what + " must be numeric");
    if (!(isNumber(v) || matchesBase(v._type(), "percent"))) throw new SyntaxError(what + " must be a number or a percentage");
    return v;
  };
  var colorNum = function (v, what) {
    if (typeof v === "number") return makeUnit(v, "number");
    if (v instanceof CSSKeywordValue) { if (v.value !== "none") throw new SyntaxError(what + ": invalid keyword"); return v; }
    if (typeof v === "string") { if (v !== "none") throw new SyntaxError(what + ": invalid keyword"); return new CSSKeywordValue("none"); }
    if (!(v instanceof CSSNumericValue) || !isNumber(v)) throw new SyntaxError(what + " must be a number");
    return v;
  };
  var colorAngle = function (v, what) {
    if (typeof v === "number") return makeUnit(v, "deg");
    if (v instanceof CSSKeywordValue) { if (v.value !== "none") throw new SyntaxError(what + ": invalid keyword"); return v; }
    if (typeof v === "string") { if (v !== "none") throw new SyntaxError(what + ": invalid keyword"); return new CSSKeywordValue("none"); }
    if (!(v instanceof CSSNumericValue) || !isAngle(v)) throw new SyntaxError(what + " must be an angle");
    return v;
  };
  var colorPctOnly = function (v, what) {
    if (typeof v === "number") return makeUnit(v * 100, "percent");
    if (v instanceof CSSKeywordValue) { if (v.value !== "none") throw new SyntaxError(what + ": invalid keyword"); return v; }
    if (typeof v === "string") { if (v !== "none") throw new SyntaxError(what + ": invalid keyword"); return new CSSKeywordValue("none"); }
    if (!(v instanceof CSSNumericValue) || !matchesBase(v._type(), "percent")) throw new SyntaxError(what + " must be a percentage");
    return v;
  };
  class CSSColorValue extends CSSStyleValue {
    constructor() { if (!creating) throw new TypeError("Illegal constructor"); super(); }
    static parse(cssText) { throw dom("SyntaxError", "CSSColorValue.parse is not supported for '" + cssText + "'"); }
  }
  var defColor = function (name, fields, fn) {
    var C = class extends CSSColorValue {
      constructor() {
        var args = arguments;
        if (args.length < fields.length - 1) throw new TypeError(name + " constructor: " + (fields.length - 1) + " arguments required");
        var prev = creating; creating = true; try { super(); } finally { creating = prev; }
        var self = this;
        fields.forEach(function (f, i) { var v = args[i]; if (v === undefined && f[0] === "alpha") v = 1; Object.defineProperty(self, "_" + f[0], { value: f[1](v, name + "." + f[0]), writable: true }); });
      }
    };
    Object.defineProperty(C, "name", { value: name });
    fields.forEach(function (f) { Object.defineProperty(C.prototype, f[0], { get: function () { return this["_" + f[0]]; }, set: function (v) { this["_" + f[0]] = f[1](v, name + "." + f[0]); }, enumerable: true, configurable: true }); });
    return C;
  };
  var CSSRGB = defColor("CSSRGB", [["r", colorPct], ["g", colorPct], ["b", colorPct], ["alpha", colorPct]]);
  var CSSHSL = defColor("CSSHSL", [["h", colorAngle], ["s", colorPctOnly], ["l", colorPctOnly], ["alpha", colorPctOnly]]);
  var CSSHWB = defColor("CSSHWB", [["h", colorAngle], ["w", colorPct], ["b", colorPct], ["alpha", colorPct]]);
  var CSSLab = defColor("CSSLab", [["l", colorPct], ["a", colorNum], ["b", colorNum], ["alpha", colorPct]]);
  var CSSLCH = defColor("CSSLCH", [["l", colorPct], ["c", colorPct], ["h", colorAngle], ["alpha", colorPct]]);
  var CSSOKLab = defColor("CSSOKLab", [["l", colorPct], ["a", colorNum], ["b", colorNum], ["alpha", colorPct]]);
  var CSSOKLCH = defColor("CSSOKLCH", [["l", colorPct], ["c", colorPct], ["h", colorAngle], ["alpha", colorPct]]);

  // ---------------------------------------------------------------- tokenizer and reification
  var tokenize = function (s) {
    var out = [], i = 0, n = s.length;
    while (i < n) {
      var c = s[i];
      if (/\s/.test(c)) { var j = i; while (j < n && /\s/.test(s[j])) j++; out.push({ t: "ws", v: s.slice(i, j) }); i = j; continue; }
      var m = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
      if (m && !(m[0].slice(-1) === "." && !/\d/.test(m[0].slice(-2, -1)))) {
        var num = m[0]; i += num.length;
        if (s[i] === "%") { out.push({ t: "pct", v: parseFloat(num), raw: num + "%" }); i++; continue; }
        var um = /^-?[A-Za-z_][A-Za-z0-9_-]*/.exec(s.slice(i));
        if (um && !(um[0].toLowerCase() === "e" && /^[+-]?\d/.test(s.slice(i + 1)))) { i += um[0].length; out.push({ t: "dim", v: parseFloat(num), u: um[0].toLowerCase(), raw: num + um[0] }); continue; }
        out.push({ t: "num", v: parseFloat(num), raw: num }); continue;
      }
      var im = /^-?-?[A-Za-z_\u0080-￿][A-Za-z0-9_\-\u0080-￿]*|^--[A-Za-z0-9_\-\u0080-￿]*/.exec(s.slice(i));
      if (im) {
        i += im[0].length;
        if (s[i] === "(") { out.push({ t: "fn", v: im[0].toLowerCase(), raw: im[0] + "(" }); i++; continue; }
        out.push({ t: "ident", v: im[0] }); continue;
      }
      if (c === '"' || c === "'") { var e = i + 1; while (e < n && s[e] !== c) { if (s[e] === "\\") e++; e++; } out.push({ t: "str", v: s.slice(i, e + 1) }); i = e + 1; continue; }
      if (c === "#") { var hm = /^#[A-Za-z0-9_\-]+/.exec(s.slice(i)); if (hm) { out.push({ t: "hash", v: hm[0] }); i += hm[0].length; continue; } }
      out.push({ t: "delim", v: c }); i++;
    }
    return out;
  };
  var skipWs = function (p) { while (p.i < p.toks.length && p.toks[p.i].t === "ws") p.i++; };
  var MATH_FNS = { calc: 1, min: 1, max: 1, clamp: 1, "-webkit-calc": 1 };
  // one numeric component: number / dimension / percentage / math function
  var parseNumericComponent = function (p) {
    var t = p.toks[p.i];
    if (!t) return null;
    if (t.t === "num") { p.i++; return makeUnit(t.v, "number"); }
    if (t.t === "pct") { p.i++; return makeUnit(t.v, "percent"); }
    if (t.t === "dim") { if (!unitKnown(t.u)) return null; p.i++; return makeUnit(t.v, t.u); }
    if (t.t === "fn" && MATH_FNS[t.v]) {
      p.i++;
      var fn = t.v, args = [];
      for (;;) {
        skipWs(p);
        var a = parseSum(p);
        if (!a) return null;
        args.push(a);
        skipWs(p);
        var d = p.toks[p.i];
        if (!d) return null;
        if (d.t === "delim" && d.v === ",") { p.i++; continue; }
        if (d.t === "delim" && d.v === ")") { p.i++; break; }
        return null;
      }
      try {
        if (fn === "calc" || fn === "-webkit-calc") { if (args.length !== 1) return null; return args[0]; }
        if (fn === "min") return new CSSMathMin(...args);
        if (fn === "max") return new CSSMathMax(...args);
        if (fn === "clamp") { if (args.length !== 3) return null; return new CSSMathClamp(args[0], args[1], args[2]); }
      } catch (e) { return null; }
    }
    return null;
  };
  var parseTerm = function (p) {
    skipWs(p);
    var t = p.toks[p.i];
    if (!t) return null;
    if (t.t === "delim" && t.v === "(") {
      p.i++;
      var inner = parseSum(p);
      skipWs(p);
      var c = p.toks[p.i];
      if (!inner || !c || c.t !== "delim" || c.v !== ")") return null;
      p.i++;
      return inner;
    }
    if (t.t === "ident") {
      var k = t.v.toLowerCase(), cv2 = { e: Math.E, pi: Math.PI, infinity: Infinity, "-infinity": -Infinity, nan: NaN }[k];
      if (cv2 !== undefined) { p.i++; return makeUnit(cv2, "number"); }
      return null;
    }
    return parseNumericComponent(p);
  };
  var parseProduct = function (p) {
    var first = parseTerm(p);
    if (!first) return null;
    var items = [first];
    for (;;) {
      var save = p.i;
      skipWs(p);
      var op = p.toks[p.i];
      if (op && op.t === "delim" && (op.v === "*" || op.v === "/")) {
        p.i++;
        var next = parseTerm(p);
        if (!next) return null;
        items.push(op.v === "/" ? invert(next) : next);
      } else { p.i = save; break; }
    }
    if (items.length === 1) return items[0];
    try { return new CSSMathProduct(...items); } catch (e) { return null; }
  };
  var parseSum = function (p) {
    var first = parseProduct(p);
    if (!first) return null;
    var items = [first];
    for (;;) {
      var save = p.i;
      var hadWs = p.toks[p.i] && p.toks[p.i].t === "ws";
      skipWs(p);
      var op = p.toks[p.i];
      if (hadWs && op && op.t === "delim" && (op.v === "+" || op.v === "-") && p.toks[p.i + 1] && p.toks[p.i + 1].t === "ws") {
        p.i++;
        var next = parseProduct(p);
        if (!next) return null;
        items.push(op.v === "-" ? negate(next) : next);
      } else { p.i = save; break; }
    }
    if (items.length === 1) return items[0];
    try { return new CSSMathSum(...items); } catch (e) { return null; }
  };
  // var() references inside a token list -> CSSUnparsedValue members
  var unparsedFrom = function (text) {
    var members = [], i = 0, buf = "";
    var parseVar = function (start) {
      // start at "var(": returns [CSSVariableReferenceValue, endIndex]
      var j = start + 4, depth = 1, inner = "";
      while (j < text.length && depth) { var ch = text[j]; if (ch === "(") depth++; else if (ch === ")") { depth--; if (!depth) break; } inner += ch; j++; }
      var comma = -1, d = 0;
      for (var k = 0; k < inner.length; k++) { if (inner[k] === "(") d++; else if (inner[k] === ")") d--; else if (inner[k] === "," && !d) { comma = k; break; } }
      var name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      var fb = comma < 0 ? null : new CSSUnparsedValue(unparsedFrom(inner.slice(comma + 1)));
      return [new CSSVariableReferenceValue(name, fb), j + 1];
    };
    while (i < text.length) {
      if (/^var\(/i.test(text.slice(i, i + 4))) {
        if (buf) { members.push(buf); buf = ""; }
        var r = parseVar(i);
        members.push(r[0]); i = r[1];
      } else buf += text[i++];
    }
    if (buf) members.push(buf);
    return members;
  };
  var CSS_WIDE = { initial: 1, inherit: 1, unset: 1, revert: 1, "revert-layer": 1 };
  var IMAGE_FN = /^(url|image|image-set|-webkit-image-set|linear-gradient|radial-gradient|conic-gradient|repeating-linear-gradient|repeating-radial-gradient|repeating-conic-gradient|cross-fade|element|paint)\(/i;
  var IMAGE_PROPS = { "background-image": 1, "border-image-source": 1, "list-style-image": 1, "mask-image": 1, "-webkit-mask-image": 1, "shape-outside": 1, content: 0, cursor: 0 };
  var reify = function (prop, text) {
    text = String(text).trim();
    var lower = text.toLowerCase();
    if (CSS_WIDE[lower]) return new CSSKeywordValue(lower);
    if (prop.indexOf("--") === 0) return new CSSUnparsedValue(unparsedFrom(text));
    if (/var\(/i.test(text)) return new CSSUnparsedValue(unparsedFrom(text));
    if (prop === "transform" && lower !== "none") { var tv = reifyTransform(text); if (tv) return tv; return unsupported(text, prop); }
    if (IMAGE_PROPS[prop] && IMAGE_FN.test(text) && splitTopLevel(text, " ").length === 1) return imageValue(text);
    var toks = tokenize(text).filter(function (t) { return t.t !== "ws"; });
    if (toks.length === 1 && toks[0].t === "ident") return new CSSKeywordValue(toks[0].v);
    var p = { toks: tokenize(text), i: 0 };
    skipWs(p);
    var v = parseNumericComponent(p);
    skipWs(p);
    if (v && p.i === p.toks.length) return v;
    return unsupported(text, prop);
  };
  var splitTopLevel = function (text, sep) {
    var out = [], depth = 0, cur = "", q = null;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === "(") depth++; else if (c === ")") depth--;
      if (!depth && (sep === " " ? /\s/.test(c) : c === sep)) { if (cur.trim() || sep !== " ") out.push(cur.trim()); cur = ""; continue; }
      cur += c;
    }
    if (cur.trim() || (sep !== " " && out.length)) out.push(cur.trim());
    return out;
  };
  var reifyTransform = function (text) {
    var parts = splitTopLevel(text, " ");
    var comps = [];
    for (var i = 0; i < parts.length; i++) {
      var m = /^([a-z0-9]+)\((.*)\)$/i.exec(parts[i]);
      if (!m) return null;
      var fn = m[1].toLowerCase(), args = splitTopLevel(m[2], ",").map(function (a) { var p = { toks: tokenize(a), i: 0 }; skipWs(p); var v = parseNumericComponent(p); skipWs(p); return v && p.i === p.toks.length ? v : null; });
      if (args.some(function (a) { return !a; })) return null;
      try {
        var px0 = makeUnit(0, "px");
        switch (fn) {
          case "translate": comps.push(new CSSTranslate(args[0], args[1] || px0)); break;
          case "translatex": comps.push(new CSSTranslate(args[0], px0)); break;
          case "translatey": comps.push(new CSSTranslate(px0, args[0])); break;
          case "translatez": comps.push(new CSSTranslate(px0, px0, args[0])); break;
          case "translate3d": comps.push(new CSSTranslate(args[0], args[1], args[2])); break;
          case "scale": comps.push(new CSSScale(args[0], args[1] || args[0])); break;
          case "scalex": comps.push(new CSSScale(args[0], 1)); break;
          case "scaley": comps.push(new CSSScale(1, args[0])); break;
          case "scalez": comps.push(new CSSScale(1, 1, args[0])); break;
          case "scale3d": comps.push(new CSSScale(args[0], args[1], args[2])); break;
          case "rotate": case "rotatez": comps.push(fn === "rotate" ? new CSSRotate(args[0]) : new CSSRotate(0, 0, 1, args[0])); break;
          case "rotatex": comps.push(new CSSRotate(1, 0, 0, args[0])); break;
          case "rotatey": comps.push(new CSSRotate(0, 1, 0, args[0])); break;
          case "rotate3d": comps.push(new CSSRotate(args[0], args[1], args[2], args[3])); break;
          case "skew": comps.push(new CSSSkew(args[0], args[1] || makeUnit(0, "deg"))); break;
          case "skewx": comps.push(new CSSSkewX(args[0])); break;
          case "skewy": comps.push(new CSSSkewY(args[0])); break;
          case "perspective": comps.push(new CSSPerspective(args[0])); break;
          case "matrix": comps.push(new CSSMatrixComponent(new DOMMatrixReadOnly(args.map(function (a) { return a.value; })))); break;
          case "matrix3d": comps.push(new CSSMatrixComponent(new DOMMatrixReadOnly(args.map(function (a) { return a.value; })))); break;
          default: return null;
        }
      } catch (e) { return null; }
    }
    return comps.length ? new CSSTransformValue(comps) : null;
  };

  // ---------------------------------------------------------------- properties
  var LIST_VALUED = ("animation-composition animation-delay animation-direction animation-duration animation-fill-mode animation-iteration-count animation-name animation-play-state animation-timing-function animation-timeline animation-range-start animation-range-end " +
    "background-attachment background-blend-mode background-clip background-image background-origin background-position background-position-x background-position-y background-repeat background-size " +
    "box-shadow font-family grid-template-areas mask-clip mask-composite mask-image mask-mode mask-origin mask-position mask-repeat mask-size text-shadow transition-behavior transition-delay transition-duration transition-property transition-timing-function will-change " +
    "scroll-timeline-name scroll-timeline-axis view-timeline-name view-timeline-axis view-timeline-inset timeline-scope font-feature-settings font-variation-settings").split(" ");
  var LIST_SET = Object.create(null); LIST_VALUED.forEach(function (p) { LIST_SET[p] = 1; });
  var scratch = null;
  var scratchStyle = function () {
    if (!scratch) { try { scratch = __jb.currentDocument.createElement("div"); } catch (e) { scratch = null; } }
    return scratch ? scratch.style : null;
  };
  var validProperty = function (prop) {
    if (prop.indexOf("--") === 0) return prop;
    var lp = prop.toLowerCase();
    if (__jb.KNOWN_CSS_PROPERTIES && __jb.KNOWN_CSS_PROPERTIES[lp]) return lp;
    var st = scratchStyle();
    if (st) {
      try { st.cssText = ""; st.setProperty(lp, "initial"); if (st.getPropertyValue(lp) !== "" || st.length) { st.cssText = ""; return lp; } } catch (e) {}
    }
    return null;
  };
  var needProp = function (prop, what) { var p = validProperty(String(prop)); if (!p) throw new TypeError(what + ": '" + prop + "' is not a valid CSS property"); return p; };
  var textFor = function (value, prop) {
    if (typeof value === "string") return value;
    if (!(value instanceof CSSStyleValue) && !(value instanceof CSSVariableReferenceValue)) throw new TypeError("Value is not a CSSStyleValue or a string");
    if (value._prop && value.constructor === CSSStyleValue && value._prop !== prop) throw new TypeError("This CSSStyleValue belongs to '" + value._prop + "'");
    if (value instanceof CSSUnitValue && !isFinite(value._v)) return serializeUnit(value, false);
    return value.toString();
  };
  var parseFor = function (property, cssText, all) {
    var prop = needProp(property, "CSSStyleValue.parse");
    var text = String(cssText).trim();
    var st = scratchStyle();
    if (st && prop.indexOf("--") !== 0) {
      st.cssText = "";
      st.setProperty(prop, text);
      var ok = st.getPropertyValue(prop) !== "" || (st.length > 0);
      st.cssText = "";
      if (!ok) throw new TypeError("CSSStyleValue.parse: '" + cssText + "' is not a valid value for " + prop);
    }
    var items = LIST_SET[prop] ? splitTopLevel(text, ",") : [text];
    var vals = items.map(function (t) { return reify(prop, t); });
    return all ? vals : [vals[0]];
  };

  // ---------------------------------------------------------------- StylePropertyMap
  class StylePropertyMapReadOnly {
    constructor() { if (!creating) throw new TypeError("Illegal constructor"); }
    get(property) {
      if (arguments.length < 1) throw new TypeError("StylePropertyMapReadOnly.get: 1 argument required");
      var prop = needProp(property, "get"), text = this._read(prop);
      if (text === null || text === "") return undefined;
      return LIST_SET[prop] ? reify(prop, splitTopLevel(text, ",")[0]) : reify(prop, text);
    }
    getAll(property) {
      if (arguments.length < 1) throw new TypeError("StylePropertyMapReadOnly.getAll: 1 argument required");
      var prop = needProp(property, "getAll"), text = this._read(prop);
      if (text === null || text === "") return [];
      return (LIST_SET[prop] ? splitTopLevel(text, ",") : [text]).map(function (t) { return reify(prop, t); });
    }
    has(property) { if (arguments.length < 1) throw new TypeError("StylePropertyMapReadOnly.has: 1 argument required"); var prop = needProp(property, "has"), text = this._read(prop); return text !== null && text !== ""; }
    get size() { return this._names().length; }
    entries() { var self = this; return this._names().map(function (n) { return [n, self.getAll(n)]; })[Symbol.iterator](); }
    keys() { return this._names()[Symbol.iterator](); }
    values() { var self = this; return this._names().map(function (n) { return self.getAll(n); })[Symbol.iterator](); }
    forEach(cb, thisArg) { var self = this; this._names().forEach(function (n) { cb.call(thisArg, self.getAll(n), n, self); }); }
    [Symbol.iterator]() { return this.entries(); }
    _names() {
      var names = this._list();
      var std = names.filter(function (n) { return n.indexOf("--") !== 0; }).sort(), custom = names.filter(function (n) { return n.indexOf("--") === 0; }).sort();
      return std.concat(custom);
    }
  }
  class StylePropertyMap extends StylePropertyMapReadOnly {
    constructor() { if (!creating) throw new TypeError("Illegal constructor"); super(); }
    set(property) {
      if (arguments.length < 2) throw new TypeError("StylePropertyMap.set: 2 arguments required");
      var prop = needProp(property, "set"), vals = Array.prototype.slice.call(arguments, 1);
      if (vals.length > 1 && !LIST_SET[prop]) throw new TypeError("StylePropertyMap.set: '" + prop + "' is not list-valued");
      var st = this._style;
      if (prop.indexOf("--") === 0) {
        var t0 = vals.map(function (v) { return textFor(v, prop); }).join(", ");
        st.setProperty(prop, t0);
        return;
      }
      var self = this;
      vals.forEach(function (v) { if (typeof v !== "string" && !typedValueAllowed(self, prop, v)) throw new TypeError("StylePropertyMap.set: invalid value for " + prop); });
      var texts = vals.map(function (v) {
        if (typeof v === "string") return { text: v, str: true };
        return { text: textFor(v, prop), v: v };
      });
      if (vals.length === 1 && texts[0].str) { var parsed = parseFor(prop, texts[0].text, true); if (parsed.length > 1 && !LIST_SET[prop]) throw new TypeError("StylePropertyMap.set: too many values"); }
      var text = texts.map(function (t) { return t.text; }).join(", ");
      var before = st.getPropertyValue(prop), beforePrio = st.getPropertyPriority(prop);
      if (!this._try(prop, text)) {
        // out-of-range numbers are kept as calc() (the computed value clamps them)
        var ok = false;
        if (texts.length === 1 && texts[0].v instanceof CSSNumericValue) ok = this._try(prop, "calc(" + texts[0].text.replace(/^calc\((.*)\)$/, "$1") + ")");
        if (!ok) { if (before !== "") st.setProperty(prop, before, beforePrio); throw new TypeError("StylePropertyMap.set: invalid value for " + prop); }
      }
    }
    _try(prop, text) {
      var st = this._style;
      st.removeProperty(prop);
      st.setProperty(prop, text);
      if (st.getPropertyValue(prop) !== "") return true;
      // shorthand values show up in their longhands
      return false;
    }
    append(property) {
      if (arguments.length < 2) throw new TypeError("StylePropertyMap.append: 2 arguments required");
      var prop = needProp(property, "append");
      if (!LIST_SET[prop]) throw new TypeError("StylePropertyMap.append: '" + prop + "' is not list-valued");
      var vals = Array.prototype.slice.call(arguments, 1).map(function (v) { return textFor(v, prop); });
      var cur = this._style.getPropertyValue(prop);
      var text = (cur ? cur + ", " : "") + vals.join(", ");
      if (!this._try(prop, text)) { if (cur) this._style.setProperty(prop, cur); throw new TypeError("StylePropertyMap.append: invalid value"); }
    }
    delete(property) { if (arguments.length < 1) throw new TypeError("StylePropertyMap.delete: 1 argument required"); var prop = needProp(property, "delete"); this._style.removeProperty(prop); }
    clear() { this._style.cssText = ""; }
  }
  var declaredMap = function (getStyle, readonly) {
    var m = internal(StylePropertyMap, function () { return new StylePropertyMap(); });
    Object.defineProperty(m, "_style", { get: getStyle });
    Object.defineProperty(m, "_read", { value: function (prop) { var st = getStyle(); return st ? st.getPropertyValue(prop) : ""; } });
    Object.defineProperty(m, "_list", { value: function () { var st = getStyle(), out = []; if (!st) return out; for (var i = 0; i < st.length; i++) if (out.indexOf(st[i]) < 0) out.push(st[i]); return out; } });
    return m;
  };
  var computedMap = function (el) {
    var m = internal(StylePropertyMapReadOnly, function () { return new StylePropertyMapReadOnly(); });
    Object.defineProperty(m, "_computed", { value: true });
    var cs = function () { try { return getComputedStyle(el); } catch (e) { return null; } };
    Object.defineProperty(m, "_read", { value: function (prop) {
      // computed values (percentages and auto stay) where the layout engine has them; resolved otherwise
      if (prop.indexOf("--") !== 0 && __jb.KNOWN_CSS_PROPERTIES && __jb.KNOWN_CSS_PROPERTIES[prop] && typeof __jb.computedOnlyValue === "function") { var v = __jb.computedOnlyValue(el, prop); if (v !== null && v !== "") return v; }
      var s = cs(); return s ? s.getPropertyValue(prop) : "";
    } });
    Object.defineProperty(m, "_list", { value: function () { var s = cs(), out = []; if (!s) return out; for (var i = 0; i < s.length; i++) out.push(s[i]); return out; } });
    return m;
  };
  __jb.typedOm = { reify: reify, declaredMap: declaredMap, computedMap: computedMap };
  // element.attributeStyleMap / computedStyleMap(), CSSStyleRule.styleMap (installed once the classes exist)
  __jb.installTypedOm = function () {
    var def = function (C, name, get) { if (typeof C === "function") Object.defineProperty(C.prototype, name, { get: get, enumerable: true, configurable: true }); };
    var attrMap = function () { var self = this; if (!this._attrStyleMap) Object.defineProperty(this, "_attrStyleMap", { value: declaredMap(function () { return self.style; }) }); return this._attrStyleMap; };
    def(globalThis.HTMLElement, "attributeStyleMap", attrMap);
    def(globalThis.SVGElement, "attributeStyleMap", attrMap);
    def(globalThis.MathMLElement, "attributeStyleMap", attrMap);
    if (typeof Element === "function") Object.defineProperty(Element.prototype, "computedStyleMap", { value: function computedStyleMap() { return computedMap(this); }, writable: true, enumerable: true, configurable: true });
    var ruleMap = function () { var self = this; if (!this._ruleStyleMap) Object.defineProperty(this, "_ruleStyleMap", { value: declaredMap(function () { return self.style; }) }); return this._ruleStyleMap; };
    def(globalThis.CSSStyleRule, "styleMap", ruleMap);
    def(globalThis.CSSPageRule, "styleMap", ruleMap);
    def(globalThis.CSSFontFaceRule, "styleMap", ruleMap);
    def(globalThis.CSSKeyframeRule, "styleMap", ruleMap);
    def(globalThis.CSSNestedDeclarations, "styleMap", ruleMap);
  };

  // ---------------------------------------------------------------- CSS namespace factories
  ["number", "percent", "cm", "mm", "Q", "in", "pt", "pc", "px", "em", "rem", "ex", "rex", "cap", "rcap", "ch", "rch", "ic", "ric", "lh", "rlh", "vw", "vh", "vi", "vb", "vmin", "vmax",
    "svw", "svh", "svi", "svb", "svmin", "svmax", "lvw", "lvh", "lvi", "lvb", "lvmin", "lvmax", "dvw", "dvh", "dvi", "dvb", "dvmin", "dvmax",
    "cqw", "cqh", "cqi", "cqb", "cqmin", "cqmax", "deg", "grad", "rad", "turn", "s", "ms", "Hz", "kHz", "dpi", "dpcm", "dppx", "fr"].forEach(function (u) {
    var unit = u === "Q" ? "q" : u.toLowerCase();
    Object.defineProperty(CSS, u, { value: { [u](value) { if (arguments.length < 1) throw new TypeError("CSS." + u + ": 1 argument required"); value = Number(value); if (!isFinite(value)) throw new TypeError("CSS." + u + ": the value is not a finite number"); return makeUnit(value, unit); } }[u], writable: true, enumerable: true, configurable: true });
  });

  __jb.installTypedOm();
  var classes = { CSSStyleValue: CSSStyleValue, CSSNumericValue: CSSNumericValue, CSSUnitValue: CSSUnitValue, CSSMathValue: CSSMathValue, CSSMathSum: CSSMathSum, CSSMathProduct: CSSMathProduct,
    CSSMathMin: CSSMathMin, CSSMathMax: CSSMathMax, CSSMathClamp: CSSMathClamp, CSSMathNegate: CSSMathNegate, CSSMathInvert: CSSMathInvert, CSSNumericArray: CSSNumericArray,
    CSSKeywordValue: CSSKeywordValue, CSSUnparsedValue: CSSUnparsedValue, CSSVariableReferenceValue: CSSVariableReferenceValue, CSSImageValue: CSSImageValue,
    CSSTransformValue: CSSTransformValue, CSSTransformComponent: CSSTransformComponent, CSSTranslate: CSSTranslate, CSSRotate: CSSRotate, CSSScale: CSSScale, CSSSkew: CSSSkew,
    CSSSkewX: CSSSkewX, CSSSkewY: CSSSkewY, CSSPerspective: CSSPerspective, CSSMatrixComponent: CSSMatrixComponent, CSSColorValue: CSSColorValue, CSSRGB: CSSRGB, CSSHSL: CSSHSL,
    CSSHWB: CSSHWB, CSSLab: CSSLab, CSSLCH: CSSLCH, CSSOKLab: CSSOKLab, CSSOKLCH: CSSOKLCH, StylePropertyMapReadOnly: StylePropertyMapReadOnly, StylePropertyMap: StylePropertyMap };
  Object.keys(classes).forEach(function (n) {
    var C = classes[n];
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: n, configurable: true });
    Object.defineProperty(globalThis, n, { value: C, writable: true, enumerable: false, configurable: true });
  });
})();
