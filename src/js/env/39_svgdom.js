// ---- SVG DOM (SVG 2): interfaces, basic data types, animated attribute reflection, geometry ----
// Every reflected attribute has an SVGAnimated* object (one per element and attribute) whose
// baseVal is live: reading parses the content attribute (invalid or missing -> the initial
// value), writing serializes back into it. animVal mirrors baseVal (no SMIL engine) and is
// read-only. Lists keep their identity and re-sync from the attribute when it changes.
(function () {
  var SVG_NS = "http://www.w3.org/2000/svg", XLINK_NS = "http://www.w3.org/1999/xlink";
  var dom = function (name, msg) { return new DOMException(msg || name, name); };
  var NUM = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
  var NUM_RE = new RegExp("^" + NUM + "$");
  function parseNumber(s) { s = String(s).trim(); return NUM_RE.test(s) ? Number(s) : null; }
  function fmt(n) { return String(n); }
  function constructGuard(flag) { if (!flag.on) throw new TypeError("Illegal constructor"); }
  function need(args, n, what) { if (args.length < n) throw new TypeError(what + ": " + n + " argument(s) required, but only " + args.length + " present"); }
  function define(C, name, consts) {
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
    if (consts) Object.keys(consts).forEach(function (k) { Object.defineProperty(C, k, { value: consts[k], enumerable: true }); Object.defineProperty(C.prototype, k, { value: consts[k], enumerable: true }); });
    Object.getOwnPropertyNames(C.prototype).forEach(function (p) { if (p === "constructor" || p.charAt(0) === "_") return; var d = Object.getOwnPropertyDescriptor(C.prototype, p); if (!d.enumerable && (d.get || typeof d.value === "function")) { d.enumerable = true; Object.defineProperty(C.prototype, p, d); } });
    Object.defineProperty(globalThis, name, { value: C, writable: true, configurable: true, enumerable: false });
  }
  var making = { on: false };
  function make(C) { making.on = true; try { return new C(); } finally { making.on = false; } }

  // ------------------------------------------------------------ viewport helpers
  function fontSize(el) { return 16; }
  function viewportSize(el) {
    var svg = el && el.ownerSVGElement;
    if (!svg) return { w: 0, h: 0 };
    var vb = svg.getAttribute("viewBox");
    if (vb) { var p = vb.trim().split(/[\s,]+/).map(Number); if (p.length === 4 && p[2] >= 0 && p[3] >= 0) return { w: p[2], h: p[3] }; }
    var w = lengthToPx(parseLength(svg.getAttribute("width")) || { v: 100, u: 2 }, svg, "x", true);
    var h = lengthToPx(parseLength(svg.getAttribute("height")) || { v: 100, u: 2 }, svg, "y", true);
    return { w: w, h: h };
  }

  // ------------------------------------------------------------ SVGLength
  var LENGTH_UNITS = { "": 1, "%": 2, em: 3, ex: 4, px: 5, cm: 6, mm: 7, in: 8, pt: 9, pc: 10 };
  var UNIT_SUFFIX = ["", "", "%", "em", "ex", "px", "cm", "mm", "in", "pt", "pc"];
  var LENGTH_RE = new RegExp("^(" + NUM + ")(px|%|em|ex|cm|mm|in|pt|pc)?$", "i");
  function parseLength(s) {
    if (s === null || s === undefined) return null;
    var m = LENGTH_RE.exec(String(s).trim());
    if (!m) return null;
    return { v: Number(m[1]), u: LENGTH_UNITS[(m[2] || "").toLowerCase()] };
  }
  function serializeLength(l) { return fmt(l.v) + UNIT_SUFFIX[l.u]; }
  function lengthToPx(l, el, dir, outermost) {
    switch (l.u) {
      case 1: case 5: return l.v;
      case 2: {
        if (outermost) return l.v; // percentages of the outermost viewport: left as is
        var vp = viewportSize(el);
        var ref = dir === "x" ? vp.w : dir === "y" ? vp.h : Math.sqrt((vp.w * vp.w + vp.h * vp.h) / 2);
        return l.v / 100 * ref;
      }
      case 3: return l.v * fontSize(el);
      case 4: return l.v * fontSize(el) / 2;
      case 6: return l.v * 96 / 2.54;
      case 7: return l.v * 96 / 25.4;
      case 8: return l.v * 96;
      case 9: return l.v * 4 / 3;
      case 10: return l.v * 16;
    }
    return l.v;
  }
  function pxToUnit(px, unit, el, dir) { var one = lengthToPx({ v: 1, u: unit }, el, dir); return one ? px / one : 0; }

  // A length "slot": where an SVGLength reads and writes its value.
  //   detached: { l }    reflected: { el, attr, dir, initial, readonly }    list item: { list, index }
  class SVGLength {
    constructor() { constructGuard(making); }
    get unitType() { return lget(this).u; }
    get value() { var s = this._slot; return lengthToPx(lget(this), s.el || (s.list && s.list._el), s.dir || (s.list && s.list._dir)); }
    set value(v) { v = Number(v); if (!isFinite(v)) throw new TypeError("value is not finite"); var l = lget(this), s = this._slot; lset(this, { v: l.u === 1 || l.u === 5 ? v : pxToUnit(v, l.u, s.el || (s.list && s.list._el), s.dir || (s.list && s.list._dir)), u: l.u }); }
    get valueInSpecifiedUnits() { return lget(this).v; }
    set valueInSpecifiedUnits(v) { v = Number(v); if (!isFinite(v)) throw new TypeError("value is not finite"); lset(this, { v: v, u: lget(this).u }); }
    get valueAsString() { return serializeLength(lget(this)); }
    set valueAsString(s) { var l = parseLength(s); if (!l) throw dom("SyntaxError", "Invalid length"); lset(this, l); }
    newValueSpecifiedUnits(unitType, value) {
      need(arguments, 2, "newValueSpecifiedUnits");
      unitType = Number(unitType); value = Number(value);
      if (!isFinite(value)) throw new TypeError("value is not finite");
      if (!(unitType >= 1 && unitType <= 10)) throw dom("NotSupportedError", "Invalid unit type");
      lset(this, { v: value, u: unitType });
    }
    convertToSpecifiedUnits(unitType) {
      need(arguments, 1, "convertToSpecifiedUnits");
      unitType = Number(unitType);
      if (!(unitType >= 1 && unitType <= 10)) throw dom("NotSupportedError", "Invalid unit type");
      var s = this._slot, el = s.el || (s.list && s.list._el), dir = s.dir || (s.list && s.list._dir);
      lset(this, { v: pxToUnit(lengthToPx(lget(this), el, dir), unitType, el, dir), u: unitType });
    }
  }
  function lget(len) {
    var s = len._slot;
    if (s.l) return s.l;
    if (s.list) { s.list._sync(); if (len._slot !== s) return lget(len); return s.list._items[s.index]._val || { v: 0, u: 1 }; }
    var raw = s.el.getAttribute(s.attr);
    return parseLength(raw) || parseLength(s.initial) || { v: 0, u: 1 };
  }
  function lset(len, l) {
    var s = len._slot;
    if (s.readonly) throw dom("NoModificationAllowedError", "The object is read-only");
    if (s.list) { s.list._sync(); if (len._slot !== s) return lset(len, l); s.list._checkWritable(); s.list._items[s.index]._val = l; s.list._commit(); return; }
    if (s.el) { s.el.setAttribute(s.attr, serializeLength(l)); return; }
    s.l = l;
  }
  function newLength(slot) { var l = make(SVGLength); Object.defineProperty(l, "_slot", { value: slot, writable: true }); return l; }
  define(SVGLength, "SVGLength", { SVG_LENGTHTYPE_UNKNOWN: 0, SVG_LENGTHTYPE_NUMBER: 1, SVG_LENGTHTYPE_PERCENTAGE: 2, SVG_LENGTHTYPE_EMS: 3, SVG_LENGTHTYPE_EXS: 4, SVG_LENGTHTYPE_PX: 5, SVG_LENGTHTYPE_CM: 6, SVG_LENGTHTYPE_MM: 7, SVG_LENGTHTYPE_IN: 8, SVG_LENGTHTYPE_PT: 9, SVG_LENGTHTYPE_PC: 10 });

  // ------------------------------------------------------------ SVGAngle
  var ANGLE_RE = new RegExp("^(" + NUM + ")(deg|rad|grad|turn)?$", "i");
  var ANGLE_UNITS = { "": 1, deg: 2, rad: 3, grad: 4 };
  var ANGLE_SUFFIX = ["", "", "deg", "rad", "grad"];
  function parseAngle(s) {
    if (s === null || s === undefined) return null;
    var m = ANGLE_RE.exec(String(s).trim());
    if (!m) return null;
    var u = (m[2] || "").toLowerCase();
    if (u === "turn") return { v: Number(m[1]) * 360, u: 2 };
    return { v: Number(m[1]), u: ANGLE_UNITS[u] };
  }
  function angleToDeg(a) { return a.u === 3 ? a.v * 180 / Math.PI : a.u === 4 ? a.v * 0.9 : a.v; }
  function degToUnit(d, u) { return u === 3 ? d * Math.PI / 180 : u === 4 ? d / 0.9 : d; }
  class SVGAngle {
    constructor() { constructGuard(making); }
    get unitType() { return aget(this).u; }
    get value() { return angleToDeg(aget(this)); }
    set value(v) { v = Number(v); if (!isFinite(v)) throw new TypeError("value is not finite"); var a = aget(this); aset(this, { v: degToUnit(v, a.u), u: a.u }); }
    get valueInSpecifiedUnits() { return aget(this).v; }
    set valueInSpecifiedUnits(v) { v = Number(v); if (!isFinite(v)) throw new TypeError("value is not finite"); aset(this, { v: v, u: aget(this).u }); }
    get valueAsString() { var a = aget(this); return fmt(a.v) + ANGLE_SUFFIX[a.u]; }
    set valueAsString(s) { var a = parseAngle(s); if (!a) throw dom("SyntaxError", "Invalid angle"); aset(this, a); }
    newValueSpecifiedUnits(unitType, value) { need(arguments, 2, "newValueSpecifiedUnits"); unitType = Number(unitType); value = Number(value); if (!isFinite(value)) throw new TypeError("value is not finite"); if (!(unitType >= 1 && unitType <= 4)) throw dom("NotSupportedError", "Invalid unit type"); aset(this, { v: value, u: unitType }); }
    convertToSpecifiedUnits(unitType) { need(arguments, 1, "convertToSpecifiedUnits"); unitType = Number(unitType); if (!(unitType >= 1 && unitType <= 4)) throw dom("NotSupportedError", "Invalid unit type"); aset(this, { v: degToUnit(angleToDeg(aget(this)), unitType), u: unitType }); }
  }
  function aget(a) { var s = a._slot; if (s.get) return s.get(); return s.a || { v: 0, u: 1 }; }
  function aset(a, v) { var s = a._slot; if (s.readonly) throw dom("NoModificationAllowedError", "The object is read-only"); if (s.set) s.set(v); else s.a = v; }
  function newAngle(slot) { var a = make(SVGAngle); Object.defineProperty(a, "_slot", { value: slot }); return a; }
  define(SVGAngle, "SVGAngle", { SVG_ANGLETYPE_UNKNOWN: 0, SVG_ANGLETYPE_UNSPECIFIED: 1, SVG_ANGLETYPE_DEG: 2, SVG_ANGLETYPE_RAD: 3, SVG_ANGLETYPE_GRAD: 4 });

  // ------------------------------------------------------------ SVGNumber
  class SVGNumber {
    constructor() { constructGuard(making); }
    get value() { var s = this._slot; if (s.list) { s.list._sync(); if (this._slot !== s) return this.value; return s.list._items[s.index]._val; } return s.get ? s.get() : s.v; }
    set value(v) {
      v = Number(v); if (!isFinite(v)) throw new TypeError("value is not finite");
      var s = this._slot;
      if (s.readonly) throw dom("NoModificationAllowedError", "The object is read-only");
      if (s.list) { s.list._sync(); if (this._slot !== s) { this.value = v; return; } s.list._checkWritable(); s.list._items[s.index]._val = v; s.list._commit(); }
      else if (s.set) s.set(v); else s.v = v;
    }
  }
  function newNumber(slot) { var n = make(SVGNumber); Object.defineProperty(n, "_slot", { value: slot, writable: true }); return n; }
  define(SVGNumber, "SVGNumber");

  // ------------------------------------------------------------ transforms
  var T = { UNKNOWN: 0, MATRIX: 1, TRANSLATE: 2, SCALE: 3, ROTATE: 4, SKEWX: 5, SKEWY: 6 };
  function parseTransformList(s) {
    if (s === null || s === undefined) return [];
    s = String(s);
    var re = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/g, out = [], m, pos = 0;
    s = s.trim();
    if (s === "") return [];
    while ((m = re.exec(s)) !== null) {
      if (m.index !== pos) return null;
      pos = re.lastIndex;
      var args = m[2].trim() === "" ? [] : m[2].trim().split(/\s*,\s*|\s+/).map(function (a) { return parseNumber(a); });
      if (args.some(function (a) { return a === null; })) return null;
      var t = transformFrom(m[1], args);
      if (!t) return null;
      out.push(t);
    }
    if (pos !== s.length) return null;
    return out;
  }
  function transformFrom(kind, a) {
    switch (kind) {
      case "matrix": return a.length === 6 ? { type: T.MATRIX, m: a.slice(), angle: 0 } : null;
      case "translate": return a.length === 1 || a.length === 2 ? { type: T.TRANSLATE, m: [1, 0, 0, 1, a[0], a.length > 1 ? a[1] : 0], angle: 0 } : null;
      case "scale": return a.length === 1 || a.length === 2 ? { type: T.SCALE, m: [a[0], 0, 0, a.length > 1 ? a[1] : a[0], 0, 0], angle: 0 } : null;
      case "rotate": {
        if (a.length !== 1 && a.length !== 3) return null;
        var r = a[0] * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r), cx = a[1] || 0, cy = a[2] || 0;
        return { type: T.ROTATE, m: [c, sn, -sn, c, cx - c * cx + sn * cy, cy - sn * cx - c * cy], angle: a[0], cx: cx, cy: cy };
      }
      case "skewX": return a.length === 1 ? { type: T.SKEWX, m: [1, 0, Math.tan(a[0] * Math.PI / 180), 1, 0, 0], angle: a[0] } : null;
      case "skewY": return a.length === 1 ? { type: T.SKEWY, m: [1, Math.tan(a[0] * Math.PI / 180), 0, 1, 0, 0], angle: a[0] } : null;
    }
    return null;
  }
  function serializeTransform(t) {
    var m = t.m;
    switch (t.type) {
      case T.TRANSLATE: return "translate(" + fmt(m[4]) + " " + fmt(m[5]) + ")";
      case T.SCALE: return "scale(" + fmt(m[0]) + " " + fmt(m[3]) + ")";
      case T.ROTATE: return t.cx || t.cy ? "rotate(" + fmt(t.angle) + " " + fmt(t.cx) + " " + fmt(t.cy) + ")" : "rotate(" + fmt(t.angle) + ")";
      case T.SKEWX: return "skewX(" + fmt(t.angle) + ")";
      case T.SKEWY: return "skewY(" + fmt(t.angle) + ")";
      default: return "matrix(" + m.map(fmt).join(" ") + ")";
    }
  }
  class SVGTransform {
    constructor() { constructGuard(making); }
    get type() { return tget(this).type; }
    get matrix() {
      if (this._matrix) return this._matrix;
      var self = this, M = make(SVGMatrixView);
      Object.defineProperty(M, "_t", { value: self });
      return (this._matrix = M);
    }
    get angle() { return tget(this).angle; }
    setMatrix(matrix) { var m = matrix || {}; var a = [m.a !== undefined ? m.a : m.m11 !== undefined ? m.m11 : 1, m.b !== undefined ? m.b : m.m12 || 0, m.c !== undefined ? m.c : m.m21 || 0, m.d !== undefined ? m.d : m.m22 !== undefined ? m.m22 : 1, m.e !== undefined ? m.e : m.m41 || 0, m.f !== undefined ? m.f : m.m42 || 0].map(Number); tset(this, { type: T.MATRIX, m: a, angle: 0 }); }
    setTranslate(tx, ty) { need(arguments, 2, "setTranslate"); tset(this, transformFrom("translate", [Number(tx), Number(ty)])); }
    setScale(sx, sy) { need(arguments, 2, "setScale"); tset(this, transformFrom("scale", [Number(sx), Number(sy)])); }
    setRotate(angle, cx, cy) { need(arguments, 3, "setRotate"); tset(this, transformFrom("rotate", [Number(angle), Number(cx), Number(cy)])); }
    setSkewX(angle) { need(arguments, 1, "setSkewX"); tset(this, transformFrom("skewX", [Number(angle)])); }
    setSkewY(angle) { need(arguments, 1, "setSkewY"); tset(this, transformFrom("skewY", [Number(angle)])); }
  }
  // The live matrix of an SVGTransform: writing a component makes it a matrix transform.
  class SVGMatrixView {
    constructor() { constructGuard(making); }
  }
  ["a", "b", "c", "d", "e", "f"].forEach(function (k, i) {
    Object.defineProperty(SVGMatrixView.prototype, k, {
      get: function () { return tget(this._t).m[i]; },
      set: function (v) { var t = tget(this._t), m = t.m.slice(); m[i] = Number(v); tset(this._t, { type: T.MATRIX, m: m, angle: 0 }); },
      enumerable: true, configurable: true,
    });
  });
  ["m11", "m12", "m21", "m22", "m41", "m42"].forEach(function (k, i) {
    Object.defineProperty(SVGMatrixView.prototype, k, { get: function () { return this[["a", "b", "c", "d", "e", "f"][i]]; }, set: function (v) { this[["a", "b", "c", "d", "e", "f"][i]] = v; }, configurable: true });
  });
  ["m13", "m14", "m23", "m24", "m31", "m32", "m34", "m43"].forEach(function (k) { Object.defineProperty(SVGMatrixView.prototype, k, { get: function () { return 0; }, configurable: true }); });
  ["m33", "m44"].forEach(function (k) { Object.defineProperty(SVGMatrixView.prototype, k, { get: function () { return 1; }, configurable: true }); });
  Object.defineProperty(SVGMatrixView.prototype, "is2D", { get: function () { return true; }, configurable: true });
  Object.defineProperty(SVGMatrixView.prototype, "isIdentity", { get: function () { var m = tget(this._t).m; return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0; }, configurable: true });
  ["multiply", "inverse", "translate", "scale", "rotate", "skewX", "skewY", "flipX", "flipY", "transformPoint", "toFloat32Array", "toFloat64Array", "toString", "toJSON"].forEach(function (op) {
    SVGMatrixView.prototype[op] = function () { var m = tget(this._t).m; var dm = new DOMMatrix([m[0], m[1], m[2], m[3], m[4], m[5]]); return dm[op].apply(dm, arguments); };
  });
  try { Object.setPrototypeOf(SVGMatrixView.prototype, DOMMatrix.prototype); } catch (e) {}
  function tget(t) { var s = t._slot; if (s.list) { s.list._sync(); if (t._slot !== s) return tget(t); return s.list._items[s.index]._val; } return s.t; }
  function tset(t, v) {
    var s = t._slot;
    if (s.readonly) throw dom("NoModificationAllowedError", "The object is read-only");
    if (s.list) { s.list._sync(); if (t._slot !== s) return tset(t, v); s.list._checkWritable(); s.list._items[s.index]._val = v; s.list._commit(); } else s.t = v;
  }
  function newTransform(slot) { var t = make(SVGTransform); Object.defineProperty(t, "_slot", { value: slot, writable: true }); return t; }
  define(SVGTransform, "SVGTransform", { SVG_TRANSFORM_UNKNOWN: 0, SVG_TRANSFORM_MATRIX: 1, SVG_TRANSFORM_TRANSLATE: 2, SVG_TRANSFORM_SCALE: 3, SVG_TRANSFORM_ROTATE: 4, SVG_TRANSFORM_SKEWX: 5, SVG_TRANSFORM_SKEWY: 6 });
  function multiply(a, b) { return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]; }

  // ------------------------------------------------------------ lists
  // A list reflects an attribute: _parse(string) -> [values], _serialize([values]) -> string.
  // Items are wrapper objects bound to (list, index); values live in _items[i]._val.
  function makeListClass(name, wrap, extra) {
    class L {
      constructor() { constructGuard(making); }
      get length() { this._sync(); return this._items.length; }
      get numberOfItems() { this._sync(); return this._items.length; }
      clear() { this._checkWritable(); this._detachAll(); this._items = []; this._commit(); }
      initialize(item) { need(arguments, 1, "initialize"); this._checkWritable(); this._detachAll(); this._items = []; var w = this._adopt(item); this._items.push(w); this._rebind(); this._commit(); return w._wrapper; }
      getItem(index) { need(arguments, 1, "getItem"); this._sync(); index = idx(index); if (index >= this._items.length) throw dom("IndexSizeError", "Index out of range"); return this._items[index]._wrapper; }
      insertItemBefore(item, index) { need(arguments, 2, "insertItemBefore"); this._checkWritable(); this._sync(); index = idx(index); if (index > this._items.length) index = this._items.length; var w = this._adopt(item); this._items.splice(index, 0, w); this._rebind(); this._commit(); return w._wrapper; }
      replaceItem(item, index) { need(arguments, 2, "replaceItem"); this._checkWritable(); this._sync(); index = idx(index); if (index >= this._items.length) throw dom("IndexSizeError", "Index out of range"); var w = this._adopt(item); this._detach(this._items[index]); this._items[index] = w; this._rebind(); this._commit(); return w._wrapper; }
      removeItem(index) { need(arguments, 1, "removeItem"); this._checkWritable(); this._sync(); index = idx(index); if (index >= this._items.length) throw dom("IndexSizeError", "Index out of range"); var w = this._items.splice(index, 1)[0]; this._detach(w); this._rebind(); this._commit(); return w._wrapper; }
      appendItem(item) { need(arguments, 1, "appendItem"); this._checkWritable(); this._sync(); var w = this._adopt(item); this._items.push(w); this._rebind(); this._commit(); return w._wrapper; }
      _checkWritable() { if (this._readonly) throw dom("NoModificationAllowedError", "The list is read-only"); }
      _sync() {
        if (!this._el) return;
        var raw = this._el.getAttribute(this._attr);
        if (raw === this._lastRaw) return;
        this._lastRaw = raw;
        var vals = this._parse(raw) || [];
        var self = this, old = this._items || [];
        // Items held by script stay the same objects: the first ones take the new values,
        // surplus old items are detached, extra values get new items.
        old.slice(vals.length).forEach(function (it) { self._detach(it); });
        this._items = vals.map(function (v, i) { if (i < old.length) { old[i]._val = v; return old[i]; } return self._newItem(v); });
        this._rebind();
      }
      _commit() {
        if (!this._el) return;
        var s = this._serialize(this._items.map(function (i) { return i._val; }));
        this._lastRaw = s;
        this._el.setAttribute(this._attr, s);
      }
      _newItem(v) { var it = { _val: v }; it._wrapper = wrap({ list: this, index: 0 }, this._readonly); return it; }
      // A list takes a copy of an item that belongs to another list (or another object).
      _adopt(item) { var v = this._valueOf(item); return this._newItem(v); }
      _rebind() { var self = this; this._items.forEach(function (it, i) { it._wrapper._slot = { list: self, index: i, readonly: self._readonly }; }); }
      _detach(it) { var v = it._val; it._wrapper._slot = this._detachedSlot(v); }
      _detachAll() { var self = this; (this._items || []).forEach(function (it) { self._detach(it); }); }
    }
    Object.keys(extra || {}).forEach(function (k) { L.prototype[k] = extra[k]; });
    Object.defineProperty(L, "name", { value: name });
    define(L, name);
    return L;
  }
  function idx(i) { return Number(i) >>> 0; }
  function listProxy(list) {
    return new Proxy(list, {
      get: function (t, p, r) { if (typeof p === "string" && /^\d+$/.test(p)) { t._sync(); var i = Number(p); return i < t._items.length ? t._items[i]._wrapper : undefined; } var v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v; },
      set: function (t, p, v) { if (typeof p === "string" && /^\d+$/.test(p)) { t.replaceItem(v, Number(p)); return true; } return Reflect.set(t, p, v, t); },
      has: function (t, p) { if (typeof p === "string" && /^\d+$/.test(p)) { t._sync(); return Number(p) < t._items.length; } return p in t; },
      getPrototypeOf: function (t) { return Object.getPrototypeOf(t); },
    });
  }
  var SVGLengthList = makeListClass("SVGLengthList", function (slot, ro) { slot.readonly = ro; return newLength(slot); }, {
    _parse: function (raw) { if (raw === null) return []; raw = String(raw).trim(); if (!raw) return []; var parts = raw.split(/\s*,\s*|\s+/), out = []; for (var i = 0; i < parts.length; i++) { var l = parseLength(parts[i]); if (!l) return null; out.push(l); } return out; },
    _serialize: function (vals) { return vals.map(serializeLength).join(" "); },
    _valueOf: function (item) { if (!(item instanceof SVGLength)) throw new TypeError("Not an SVGLength"); return Object.assign({}, lget(item)); },
    _detachedSlot: function (v) { return { l: v }; },
  });
  var SVGNumberList = makeListClass("SVGNumberList", function (slot, ro) { slot.readonly = ro; return newNumber(slot); }, {
    _parse: function (raw) { if (raw === null) return []; raw = String(raw).trim(); if (!raw) return []; var parts = raw.split(/\s*,\s*|\s+/), out = []; for (var i = 0; i < parts.length; i++) { var n = parseNumber(parts[i]); if (n === null) return null; out.push(n); } return out; },
    _serialize: function (vals) { return vals.map(fmt).join(" "); },
    _valueOf: function (item) { if (!(item instanceof SVGNumber)) throw new TypeError("Not an SVGNumber"); return item.value; },
    _detachedSlot: function (v) { return { v: v }; },
  });
  var SVGTransformList = makeListClass("SVGTransformList", function (slot, ro) { slot.readonly = ro; return newTransform(slot); }, {
    _parse: function (raw) { return parseTransformList(raw); },
    _serialize: function (vals) { return vals.map(serializeTransform).join(" "); },
    _valueOf: function (item) { if (!(item instanceof SVGTransform)) throw new TypeError("Not an SVGTransform"); var t = tget(item); return { type: t.type, m: t.m.slice(), angle: t.angle, cx: t.cx, cy: t.cy }; },
    _detachedSlot: function (v) { return { t: v }; },
    createSVGTransformFromMatrix: function (matrix) { var t = newTransform({ t: { type: T.MATRIX, m: [1, 0, 0, 1, 0, 0], angle: 0 } }); t.setMatrix(matrix); return t; },
    consolidate: function () {
      this._checkWritable(); this._sync();
      if (!this._items.length) return null;
      var m = [1, 0, 0, 1, 0, 0];
      this._items.forEach(function (it) { m = multiply(m, it._val.m); });
      this._detachAll();
      var it = this._newItem({ type: T.MATRIX, m: m, angle: 0 });
      this._items = [it]; this._rebind(); this._commit();
      return it._wrapper;
    },
  });
  var SVGPointList = makeListClass("SVGPointList", function (slot, ro) { return pointFor(slot, ro); }, {
    _parse: function (raw) { if (raw === null) return []; raw = String(raw).trim(); if (!raw) return []; var parts = raw.split(/\s*,\s*|\s+/); var out = []; for (var i = 0; i + 1 < parts.length; i += 2) { var x = parseNumber(parts[i]), y = parseNumber(parts[i + 1]); if (x === null || y === null) return out; out.push({ x: x, y: y }); } return out; },
    _serialize: function (vals) { return vals.map(function (p) { return fmt(p.x) + "," + fmt(p.y); }).join(" "); },
    _valueOf: function (item) { if (!item || typeof item !== "object" || !("x" in item)) throw new TypeError("Not a DOMPoint"); return { x: Number(item.x), y: Number(item.y) }; },
    _detachedSlot: function (v) { return { p: v }; },
  });
  // Points of an SVGPointList are DOMPoints that write back into the list.
  function pointFor(slot, ro) {
    var p = new DOMPoint();
    var holder = { slot: slot };
    Object.defineProperty(p, "_slot", { get: function () { return holder.slot; }, set: function (s) { holder.slot = s; }, configurable: true });
    ["x", "y"].forEach(function (k) {
      Object.defineProperty(p, k, {
        get: function () { var s = holder.slot; if (s.list) { s.list._sync(); s = holder.slot; } return s.list ? s.list._items[s.index]._val[k] : s.p ? s.p[k] : 0; },
        set: function (v) { var s = holder.slot; if (s.list) { s.list._sync(); s = holder.slot; } if (s.readonly) throw dom("NoModificationAllowedError", "The point is read-only"); if (s.list) { var val = Object.assign({}, s.list._items[s.index]._val); val[k] = Number(v); s.list._items[s.index]._val = val; s.list._commit(); } else if (s.p) s.p[k] = Number(v); },
        configurable: true, enumerable: true,
      });
    });
    return p;
  }
  var SVGStringList = makeListClass("SVGStringList", function (slot) { return slot; }, {
    _parse: function (raw) { if (raw === null) return []; return String(raw).trim().split(this._attr === "systemLanguage" ? /\s*,\s*/ : /\s+/).filter(Boolean); },
    _serialize: function (vals) { return vals.join(" "); },
    _valueOf: function (item) { return String(item); },
    _detachedSlot: function (v) { return v; },
    _newItem: function (v) { return { _val: v, _wrapper: v }; },
    _rebind: function () { this._items.forEach(function (it) { it._wrapper = it._val; }); },
    _detach: function () {},
  });
  function newList(L, el, attr, readonly, dir) {
    var l = make(L);
    Object.defineProperties(l, { _el: { value: el }, _attr: { value: attr }, _readonly: { value: !!readonly }, _dir: { value: dir }, _items: { value: [], writable: true }, _lastRaw: { value: undefined, writable: true } });
    return listProxy(l);
  }

  // ------------------------------------------------------------ SVGPreserveAspectRatio
  var ALIGNS = ["none", "xMinYMin", "xMidYMin", "xMaxYMin", "xMinYMid", "xMidYMid", "xMaxYMid", "xMinYMax", "xMidYMax", "xMaxYMax"];
  function parsePAR(s) {
    if (s === null || s === undefined) return { align: 6, meet: 1 };
    var parts = String(s).trim().split(/\s+/);
    var i = ALIGNS.indexOf(parts[0]);
    if (i < 0 || parts.length > 2) return null;
    var meet = parts[1] === undefined || parts[1] === "meet" ? 1 : parts[1] === "slice" ? 2 : 0;
    if (!meet) return null;
    return { align: i + 1, meet: meet };
  }
  class SVGPreserveAspectRatio {
    constructor() { constructGuard(making); }
    get align() { return pget(this).align; }
    set align(v) { v = Number(v); if (this._ro) throw dom("NoModificationAllowedError", "read-only"); if (!(v >= 1 && v <= 10)) throw new TypeError("Invalid align"); var p = pget(this); this._el.setAttribute(this._attr, ALIGNS[v - 1] + (p.meet === 2 ? " slice" : "")); }
    get meetOrSlice() { return pget(this).meet; }
    set meetOrSlice(v) { v = Number(v); if (this._ro) throw dom("NoModificationAllowedError", "read-only"); if (!(v >= 1 && v <= 2)) throw new TypeError("Invalid meetOrSlice"); var p = pget(this); this._el.setAttribute(this._attr, ALIGNS[p.align - 1] + (v === 2 ? " slice" : "")); }
  }
  function pget(p) { return parsePAR(p._el.getAttribute(p._attr)) || { align: 6, meet: 1 }; }
  define(SVGPreserveAspectRatio, "SVGPreserveAspectRatio", { SVG_PRESERVEASPECTRATIO_UNKNOWN: 0, SVG_PRESERVEASPECTRATIO_NONE: 1, SVG_PRESERVEASPECTRATIO_XMINYMIN: 2, SVG_PRESERVEASPECTRATIO_XMIDYMIN: 3, SVG_PRESERVEASPECTRATIO_XMAXYMIN: 4, SVG_PRESERVEASPECTRATIO_XMINYMID: 5, SVG_PRESERVEASPECTRATIO_XMIDYMID: 6, SVG_PRESERVEASPECTRATIO_XMAXYMID: 7, SVG_PRESERVEASPECTRATIO_XMINYMAX: 8, SVG_PRESERVEASPECTRATIO_XMIDYMAX: 9, SVG_PRESERVEASPECTRATIO_XMAXYMAX: 10, SVG_MEETORSLICE_UNKNOWN: 0, SVG_MEETORSLICE_MEET: 1, SVG_MEETORSLICE_SLICE: 2 });

  // ------------------------------------------------------------ animated types
  function animClass(name, baseGetter, extra) {
    class A { constructor() { constructGuard(making); } }
    Object.defineProperty(A, "name", { value: name });
    Object.defineProperty(A.prototype, "baseVal", baseGetter.baseVal);
    Object.defineProperty(A.prototype, "animVal", baseGetter.animVal);
    Object.keys(extra || {}).forEach(function (k) { A.prototype[k] = extra[k]; });
    define(A, name);
    return A;
  }
  function info(a) { return a._info; }
  // number-ish attribute values: initial value when missing/invalid
  function numGet(a) {
    var i = info(a), raw = i.el.getAttribute(i.attr);
    if (i.parse) { var r = i.parse(raw); return r === null || r === undefined ? i.initial : r; }
    var n = raw === null ? null : parseNumber(raw);
    return n === null ? i.initial : n;
  }
  function numSet(a, v) {
    var i = info(a);
    if (i.set) { i.set(v); return; }
    i.el.setAttribute(i.attr, fmt(v));
  }
  var SVGAnimatedNumber = animClass("SVGAnimatedNumber", {
    baseVal: { get: function () { return numGet(this); }, set: function (v) { v = Number(v); if (!isFinite(v)) throw new TypeError("value is not finite"); numSet(this, v); }, enumerable: true, configurable: true },
    animVal: { get: function () { return numGet(this); }, enumerable: true, configurable: true },
  });
  var SVGAnimatedInteger = animClass("SVGAnimatedInteger", {
    baseVal: { get: function () { return numGet(this); }, set: function (v) { v = Number(v); if (!isFinite(v)) throw new TypeError("value is not finite"); v = Math.trunc(v) | 0; numSet(this, v); }, enumerable: true, configurable: true },
    animVal: { get: function () { return numGet(this); }, enumerable: true, configurable: true },
  });
  var SVGAnimatedBoolean = animClass("SVGAnimatedBoolean", {
    baseVal: { get: function () { var i = info(this); return i.el.getAttribute(i.attr) === "true"; }, set: function (v) { var i = info(this); i.el.setAttribute(i.attr, v ? "true" : "false"); }, enumerable: true, configurable: true },
    animVal: { get: function () { var i = info(this); return i.el.getAttribute(i.attr) === "true"; }, enumerable: true, configurable: true },
  });
  function enumGet(a) {
    var i = info(a), raw = i.el.getAttribute(i.attr);
    if (raw === null) return i.initial;
    var k = i.keywords.indexOf(raw);
    return k > 0 ? k : (i.invalid !== undefined ? i.invalid : i.initial);
  }
  var SVGAnimatedEnumeration = animClass("SVGAnimatedEnumeration", {
    baseVal: {
      get: function () { return enumGet(this); },
      set: function (v) {
        v = Number(v) & 0xffff;
        var i = info(this);
        if (v === 0 || !i.keywords[v]) throw new TypeError("Invalid enumeration value");
        i.el.setAttribute(i.attr, i.keywords[v]);
      }, enumerable: true, configurable: true,
    },
    animVal: { get: function () { return enumGet(this); }, enumerable: true, configurable: true },
  });
  function strGet(a) {
    var i = info(a);
    if (i.href) { var h = i.el.getAttribute("href"); if (h !== null) return h; var x = i.el.getAttributeNS(XLINK_NS, "href"); return x === null ? "" : x; }
    var raw = i.el.getAttribute(i.attr);
    return raw === null ? (i.initial || "") : raw;
  }
  var SVGAnimatedString = animClass("SVGAnimatedString", {
    baseVal: { get: function () { return strGet(this); }, set: function (v) { var i = info(this); i.el.setAttribute(i.href ? "href" : i.attr, String(v)); }, enumerable: true, configurable: true },
    animVal: { get: function () { return strGet(this); }, enumerable: true, configurable: true },
  });
  var SVGAnimatedLength = animClass("SVGAnimatedLength", {
    baseVal: { get: function () { var i = info(this); return i.base || (i.base = newLength({ el: i.el, attr: i.attr, dir: i.dir, initial: i.initial })); }, enumerable: true, configurable: true },
    animVal: { get: function () { var i = info(this); return i.anim || (i.anim = newLength({ el: i.el, attr: i.attr, dir: i.dir, initial: i.initial, readonly: true })); }, enumerable: true, configurable: true },
  });
  var SVGAnimatedAngle = animClass("SVGAnimatedAngle", {
    baseVal: { get: function () { var i = info(this); return i.base || (i.base = newAngle({ get: i.get, set: i.set })); }, enumerable: true, configurable: true },
    animVal: { get: function () { var i = info(this); return i.anim || (i.anim = newAngle({ get: i.get, readonly: true })); }, enumerable: true, configurable: true },
  });
  function listAnim(name, L) {
    return animClass(name, {
      baseVal: { get: function () { var i = info(this); return i.base || (i.base = newList(L, i.el, i.attr, false, i.dir)); }, enumerable: true, configurable: true },
      animVal: { get: function () { var i = info(this); return i.anim || (i.anim = newList(L, i.el, i.attr, true, i.dir)); }, enumerable: true, configurable: true },
    });
  }
  var SVGAnimatedLengthList = listAnim("SVGAnimatedLengthList", SVGLengthList);
  var SVGAnimatedNumberList = listAnim("SVGAnimatedNumberList", SVGNumberList);
  var SVGAnimatedTransformList = listAnim("SVGAnimatedTransformList", SVGTransformList);
  function rectFor(i, readonly) {
    var r = readonly ? new DOMRectReadOnly() : new DOMRect();
    var get = function () { var raw = i.el.getAttribute(i.attr); if (raw === null) return null; var p = raw.trim().split(/\s*,\s*|\s+/).map(parseNumber); return p.length === 4 && p.every(function (x) { return x !== null; }) ? p : null; };
    ["x", "y", "width", "height"].forEach(function (k, n) {
      Object.defineProperty(r, k, {
        get: function () { var p = get(); return p ? p[n] : 0; },
        set: readonly ? undefined : function (v) { var p = get() || [0, 0, 0, 0]; p[n] = Number(v); i.el.setAttribute(i.attr, p.map(fmt).join(" ")); },
        configurable: true, enumerable: true,
      });
    });
    return r;
  }
  var SVGAnimatedRect = animClass("SVGAnimatedRect", {
    baseVal: { get: function () { var i = info(this); if (i.el.getAttribute(i.attr) === null) return null; return i.base || (i.base = rectFor(i, false)); }, enumerable: true, configurable: true },
    animVal: { get: function () { var i = info(this); if (i.el.getAttribute(i.attr) === null) return null; return i.anim || (i.anim = rectFor(i, true)); }, enumerable: true, configurable: true },
  });
  var SVGAnimatedPreserveAspectRatio = animClass("SVGAnimatedPreserveAspectRatio", {
    baseVal: { get: function () { var i = info(this); if (!i.base) { i.base = make(SVGPreserveAspectRatio); Object.defineProperties(i.base, { _el: { value: i.el }, _attr: { value: i.attr }, _ro: { value: false } }); } return i.base; }, enumerable: true, configurable: true },
    animVal: { get: function () { var i = info(this); if (!i.anim) { i.anim = make(SVGPreserveAspectRatio); Object.defineProperties(i.anim, { _el: { value: i.el }, _attr: { value: i.attr }, _ro: { value: true } }); } return i.anim; }, enumerable: true, configurable: true },
  });

  // One animated object per element and property ([SameObject]).
  function anim(el, prop, C, init) {
    var cache = el._svgAnim || (el._svgAnim = Object.create(null));
    if (cache[prop]) return cache[prop];
    var a = make(C);
    var i = Object.assign({ el: el, attr: prop }, init || {});
    Object.defineProperty(a, "_info", { value: i });
    return (cache[prop] = a);
  }

  // ------------------------------------------------------------ interfaces and reflection
  var Graphics = __jb.svgClasses.SVGGraphicsElement;
  // Remove the old placeholder getters from SVGElement.prototype.
  ["href", "viewBox", "width", "height", "x", "y", "cx", "cy", "r", "d", "fill", "stroke", "transform", "points", "preserveAspectRatio"].forEach(function (p) { delete SVGElement.prototype[p]; });
  ["getBBox", "getScreenCTM", "getCTM", "createSVGPoint"].forEach(function (p) { delete SVGElement.prototype[p]; });

  var classes = {};
  function cls(name, parent) {
    if (classes[name]) return classes[name];
    var existing = __jb.svgClasses[name];
    var C;
    if (existing && Object.getPrototypeOf(existing) === parent) C = existing;
    else {
      C = ({ [name]: class extends parent {} })[name];
      __jb.setTag(C, name);
    }
    classes[name] = C;
    __jb.svgClasses[name] = C;
    return C;
  }
  function len(C, props) { Object.keys(props).forEach(function (p) { var o = props[p]; Object.defineProperty(C.prototype, p, { get: function () { return anim(this, p, SVGAnimatedLength, { attr: o.attr || p, dir: o.dir, initial: o.initial || "0" }); }, enumerable: true, configurable: true }); }); }
  function nums(C, props) { Object.keys(props).forEach(function (p) { var o = props[p]; Object.defineProperty(C.prototype, p, { get: function () { return anim(this, p, o.integer ? SVGAnimatedInteger : SVGAnimatedNumber, { attr: o.attr || p, initial: o.initial === undefined ? 0 : o.initial, parse: o.parse }); }, enumerable: true, configurable: true }); }); }
  function enums(C, props) { Object.keys(props).forEach(function (p) { var o = props[p]; Object.defineProperty(C.prototype, p, { get: function () { return anim(this, p, SVGAnimatedEnumeration, { attr: o.attr || p, keywords: o.keywords, initial: o.initial, invalid: o.invalid }); }, enumerable: true, configurable: true }); }); }
  function strs(C, props) { Object.keys(props).forEach(function (p) { var o = props[p]; Object.defineProperty(C.prototype, p, { get: function () { return anim(this, p, SVGAnimatedString, { attr: o.attr || p, href: o.href, initial: o.initial }); }, enumerable: true, configurable: true }); }); }
  function bools(C, props) { props.forEach(function (p) { Object.defineProperty(C.prototype, p, { get: function () { return anim(this, p, SVGAnimatedBoolean, { attr: p }); }, enumerable: true, configurable: true }); }); }
  function lists(C, props) { Object.keys(props).forEach(function (p) { var o = props[p]; Object.defineProperty(C.prototype, p, { get: function () { return anim(this, p, o.type, { attr: o.attr || p, dir: o.dir }); }, enumerable: true, configurable: true }); }); }
  function rects(C, props) { props.forEach(function (p) { Object.defineProperty(C.prototype, p, { get: function () { return anim(this, p, SVGAnimatedRect, { attr: p }); }, enumerable: true, configurable: true }); }); }
  function pars(C) { Object.defineProperty(C.prototype, "preserveAspectRatio", { get: function () { return anim(this, "preserveAspectRatio", SVGAnimatedPreserveAspectRatio, {}); }, enumerable: true, configurable: true }); }
  function hrefs(C) { strs(C, { href: { href: true } }); }
  // second number of a "number-optional-number" attribute
  function optNum(attr, which, initial) {
    return { attr: attr, initial: initial, parse: function (raw) {
      if (raw === null) return null;
      var p = String(raw).trim().split(/\s*,\s*|\s+/).map(parseNumber);
      if (p.length < 1 || p.length > 2 || p.some(function (x) { return x === null; })) return null;
      return which === 0 ? p[0] : (p.length > 1 ? p[1] : p[0]);
    } };
  }
  var UNITS = ["", "userSpaceOnUse", "objectBoundingBox"];

  // SVGElement members
  strs(SVGElement, { className: { attr: "class" } });
  Object.defineProperty(SVGElement.prototype, "tabIndex", { get: __jb.tabIndexGetter, set: function (v) { this.setAttribute("tabindex", String(__jb.toInt32(v))); }, enumerable: true, configurable: true });
  Object.defineProperty(SVGElement.prototype, "ownerSVGElement", { get: function () { for (var p = this.parentNode; p && p.nodeType === 1; p = p.parentNode) { if (p._ns === SVG_NS && p._tag === "svg") return p; if (p._ns === SVG_NS && p._tag === "foreignObject") return null; } return null; }, enumerable: true, configurable: true });
  Object.defineProperty(SVGElement.prototype, "viewportElement", { get: function () { for (var p = this.parentNode; p && p.nodeType === 1; p = p.parentNode) { if (p._ns === SVG_NS && (p._tag === "svg" || p._tag === "symbol")) return p; } return null; }, enumerable: true, configurable: true });

  // SVGGraphicsElement
  lists(Graphics, { transform: { type: SVGAnimatedTransformList } });
  function testsMixin(C) {
    Object.defineProperty(C.prototype, "requiredExtensions", { get: function () { var c = this._svgAnim || (this._svgAnim = Object.create(null)); return c.__re || (c.__re = newList(SVGStringList, this, "requiredExtensions", false)); }, enumerable: true, configurable: true });
    Object.defineProperty(C.prototype, "systemLanguage", { get: function () { var c = this._svgAnim || (this._svgAnim = Object.create(null)); return c.__sl || (c.__sl = newList(SVGStringList, this, "systemLanguage", false)); }, enumerable: true, configurable: true });
  }
  testsMixin(Graphics);
  Graphics.prototype.getBBox = function () { var b = bbox(this); return new DOMRect(b.x, b.y, b.width, b.height); };
  Graphics.prototype.getCTM = function () { var m = ctm(this, false); return new DOMMatrix(m); };
  Graphics.prototype.getScreenCTM = function () { if (!this.isConnected) return null; var m = ctm(this, true); return new DOMMatrix(m); };

  // SVGGeometryElement
  var Geometry = cls("SVGGeometryElement", Graphics);
  nums(Geometry, { pathLength: { initial: 0 } });
  Geometry.prototype.getTotalLength = function () { return pathLengthOf(segmentsOf(this)); };
  Geometry.prototype.getPointAtLength = function (distance) {
    need(arguments, 1, "getPointAtLength");
    distance = Number(distance);
    if (!isFinite(distance)) throw new TypeError("distance is not finite");
    var p = pointAtLength(segmentsOf(this), distance);
    return new DOMPoint(p.x, p.y);
  };
  Geometry.prototype.isPointInFill = function (pt) { var p = pt || {}; return pointInPolygon(flatten(segmentsOf(this)), Number(p.x) || 0, Number(p.y) || 0); };
  Geometry.prototype.isPointInStroke = function (pt) { var p = pt || {}; var x = Number(p.x) || 0, y = Number(p.y) || 0, w = (parseNumber(this.getAttribute("stroke-width") || "1") || 1) / 2; return flatten(segmentsOf(this)).some(function (poly) { for (var i = 1; i < poly.length; i++) if (distToSeg(x, y, poly[i - 1], poly[i]) <= w) return true; return false; }); };

  var shapes = {
    SVGRectElement: { tag: "rect", len: { x: { dir: "x" }, y: { dir: "y" }, width: { dir: "x" }, height: { dir: "y" }, rx: { dir: "x" }, ry: { dir: "y" } } },
    SVGCircleElement: { tag: "circle", len: { cx: { dir: "x" }, cy: { dir: "y" }, r: { dir: "xy" } } },
    SVGEllipseElement: { tag: "ellipse", len: { cx: { dir: "x" }, cy: { dir: "y" }, rx: { dir: "x" }, ry: { dir: "y" } } },
    SVGLineElement: { tag: "line", len: { x1: { dir: "x" }, y1: { dir: "y" }, x2: { dir: "x" }, y2: { dir: "y" } } },
    SVGPathElement: { tag: "path", len: {} },
    SVGPolylineElement: { tag: "polyline", len: {} },
    SVGPolygonElement: { tag: "polygon", len: {} },
  };
  Object.keys(shapes).forEach(function (n) { var C = cls(n, Geometry); len(C, shapes[n].len); });
  ["SVGPolylineElement", "SVGPolygonElement"].forEach(function (n) {
    var C = classes[n];
    Object.defineProperty(C.prototype, "points", { get: function () { var c = this._svgAnim || (this._svgAnim = Object.create(null)); return c.__pts || (c.__pts = newList(SVGPointList, this, "points", false)); }, enumerable: true, configurable: true });
    Object.defineProperty(C.prototype, "animatedPoints", { get: function () { var c = this._svgAnim || (this._svgAnim = Object.create(null)); return c.__apts || (c.__apts = newList(SVGPointList, this, "points", true)); }, enumerable: true, configurable: true });
  });

  // containers / structural
  var SVGSVGElement = cls("SVGSVGElement", Graphics);
  len(SVGSVGElement, { x: { dir: "x" }, y: { dir: "y" }, width: { dir: "x", initial: "100%" }, height: { dir: "y", initial: "100%" } });
  rects(SVGSVGElement, ["viewBox"]); pars(SVGSVGElement);
  ["SVGGElement", "SVGDefsElement", "SVGSwitchElement", "SVGForeignObjectElement", "SVGUseElement", "SVGImageElement", "SVGAElement", "SVGTextContentElement"].forEach(function (n) { cls(n, Graphics); });
  len(classes.SVGForeignObjectElement, { x: { dir: "x" }, y: { dir: "y" }, width: { dir: "x" }, height: { dir: "y" } });
  len(classes.SVGUseElement, { x: { dir: "x" }, y: { dir: "y" }, width: { dir: "x" }, height: { dir: "y" } }); hrefs(classes.SVGUseElement);
  Object.defineProperty(classes.SVGUseElement.prototype, "instanceRoot", { get: function () { return null; }, enumerable: true, configurable: true });
  Object.defineProperty(classes.SVGUseElement.prototype, "animatedInstanceRoot", { get: function () { return null; }, enumerable: true, configurable: true });
  len(classes.SVGImageElement, { x: { dir: "x" }, y: { dir: "y" }, width: { dir: "x" }, height: { dir: "y" } }); pars(classes.SVGImageElement); hrefs(classes.SVGImageElement);
  Object.defineProperty(classes.SVGImageElement.prototype, "crossOrigin", { get: function () { var v = this.getAttribute("crossorigin"); return v === null ? null : v.toLowerCase() === "use-credentials" ? "use-credentials" : "anonymous"; }, set: function (v) { if (v === null) this.removeAttribute("crossorigin"); else this.setAttribute("crossorigin", v); }, enumerable: true, configurable: true });
  hrefs(classes.SVGAElement); strs(classes.SVGAElement, { target: {} });
  ["download", "ping", "rel", "hreflang", "type", "referrerPolicy"].forEach(function (p) { var a = p === "referrerPolicy" ? "referrerpolicy" : p.toLowerCase(); Object.defineProperty(classes.SVGAElement.prototype, p, { get: function () { var v = this.getAttribute(a); return v === null ? "" : v; }, set: function (v) { this.setAttribute(a, String(v)); }, enumerable: true, configurable: true }); });
  Object.defineProperty(classes.SVGAElement.prototype, "relList", { get: function () { return this._relList || (this._relList = __jb.makeTokenList ? __jb.makeTokenList(this, "rel") : { value: this.getAttribute("rel") || "" }); }, enumerable: true, configurable: true });

  // text
  var TextContent = classes.SVGTextContentElement;
  len(TextContent, { textLength: { dir: "x" } });
  enums(TextContent, { lengthAdjust: { keywords: ["", "spacing", "spacingAndGlyphs"], initial: 1 } });
  Object.defineProperty(TextContent, "LENGTHADJUST_UNKNOWN", { value: 0, enumerable: true }); Object.defineProperty(TextContent, "LENGTHADJUST_SPACING", { value: 1, enumerable: true }); Object.defineProperty(TextContent, "LENGTHADJUST_SPACINGANDGLYPHS", { value: 2, enumerable: true });
  ["LENGTHADJUST_UNKNOWN", "LENGTHADJUST_SPACING", "LENGTHADJUST_SPACINGANDGLYPHS"].forEach(function (k, i) { Object.defineProperty(TextContent.prototype, k, { value: i, enumerable: true }); });
  var CHAR_W = 8;
  function textChars(el) { return __jb.arrayFrom(el.textContent || ""); }
  TextContent.prototype.getNumberOfChars = function () { return textChars(this).length; };
  TextContent.prototype.getComputedTextLength = function () { return textChars(this).length * CHAR_W; };
  function checkChar(el, i) { if (i === undefined) throw new TypeError("1 argument required"); i = Number(i) >>> 0; if (i >= textChars(el).length) throw dom("IndexSizeError", "Character index out of range"); return i; }
  TextContent.prototype.getSubStringLength = function (charnum, nchars) { need(arguments, 2, "getSubStringLength"); var n = textChars(this).length; charnum = Number(charnum) >>> 0; if (charnum >= n) throw dom("IndexSizeError", "Character index out of range"); nchars = Number(nchars) >>> 0; return Math.min(nchars, n - charnum) * CHAR_W; };
  TextContent.prototype.getStartPositionOfChar = function (i) { i = checkChar(this, i); var x = startX(this); return new DOMPoint(x + i * CHAR_W, startY(this)); };
  TextContent.prototype.getEndPositionOfChar = function (i) { i = checkChar(this, i); var x = startX(this); return new DOMPoint(x + (i + 1) * CHAR_W, startY(this)); };
  TextContent.prototype.getExtentOfChar = function (i) { i = checkChar(this, i); var x = startX(this); return new DOMRect(x + i * CHAR_W, startY(this) - 12, CHAR_W, 16); };
  TextContent.prototype.getRotationOfChar = function (i) {
    i = checkChar(this, i);
    for (var el = this; el && el._ns === SVG_NS; el = el.parentNode) {
      var raw = el.getAttribute && el.getAttribute("rotate");
      if (raw !== null && raw !== undefined) { var r = raw.trim().split(/\s*,\s*|\s+/).map(parseNumber).filter(function (x) { return x !== null; }); if (r.length) return r[Math.min(i, r.length - 1)]; }
      if (el._tag === "text") break;
    }
    return 0;
  };
  TextContent.prototype.getCharNumAtPosition = function (p) { var x = (p && Number(p.x)) || 0, n = textChars(this).length, i = Math.floor((x - startX(this)) / CHAR_W); return i >= 0 && i < n ? i : -1; };
  TextContent.prototype.selectSubString = function (charnum, nchars) { need(arguments, 2, "selectSubString"); checkChar(this, charnum); };
  function startX(el) { var v = parseLength((el.getAttribute("x") || "").trim().split(/\s*,\s*|\s+/)[0]); return v ? lengthToPx(v, el, "x") : 0; }
  function startY(el) { var v = parseLength((el.getAttribute("y") || "").trim().split(/\s*,\s*|\s+/)[0]); return v ? lengthToPx(v, el, "y") : 0; }
  var Positioning = cls("SVGTextPositioningElement", TextContent);
  lists(Positioning, { x: { type: SVGAnimatedLengthList, dir: "x" }, y: { type: SVGAnimatedLengthList, dir: "y" }, dx: { type: SVGAnimatedLengthList, dir: "x" }, dy: { type: SVGAnimatedLengthList, dir: "y" }, rotate: { type: SVGAnimatedNumberList } });
  cls("SVGTextElement", Positioning); cls("SVGTSpanElement", Positioning);
  var TextPath = cls("SVGTextPathElement", TextContent);
  len(TextPath, { startOffset: { dir: "x" } }); hrefs(TextPath);
  enums(TextPath, { method: { keywords: ["", "align", "stretch"], initial: 1 }, spacing: { keywords: ["", "auto", "exact"], initial: 2 } });
  [["TEXTPATH_METHODTYPE_UNKNOWN", 0], ["TEXTPATH_METHODTYPE_ALIGN", 1], ["TEXTPATH_METHODTYPE_STRETCH", 2], ["TEXTPATH_SPACINGTYPE_UNKNOWN", 0], ["TEXTPATH_SPACINGTYPE_AUTO", 1], ["TEXTPATH_SPACINGTYPE_EXACT", 2]].forEach(function (c) { Object.defineProperty(TextPath, c[0], { value: c[1], enumerable: true }); Object.defineProperty(TextPath.prototype, c[0], { value: c[1], enumerable: true }); });

  // paint servers, clipping, masking, markers
  var Gradient = cls("SVGGradientElement", SVGElement);
  enums(Gradient, { gradientUnits: { keywords: UNITS, initial: 2 }, spreadMethod: { keywords: ["", "pad", "reflect", "repeat"], initial: 1 } });
  lists(Gradient, { gradientTransform: { type: SVGAnimatedTransformList } }); hrefs(Gradient);
  [["SVG_SPREADMETHOD_UNKNOWN", 0], ["SVG_SPREADMETHOD_PAD", 1], ["SVG_SPREADMETHOD_REFLECT", 2], ["SVG_SPREADMETHOD_REPEAT", 3]].forEach(function (c) { Object.defineProperty(Gradient, c[0], { value: c[1], enumerable: true }); Object.defineProperty(Gradient.prototype, c[0], { value: c[1], enumerable: true }); });
  len(cls("SVGLinearGradientElement", Gradient), { x1: { dir: "x", initial: "0%" }, y1: { dir: "y", initial: "0%" }, x2: { dir: "x", initial: "100%" }, y2: { dir: "y", initial: "0%" } });
  len(cls("SVGRadialGradientElement", Gradient), { cx: { dir: "x", initial: "50%" }, cy: { dir: "y", initial: "50%" }, r: { dir: "xy", initial: "50%" }, fx: { dir: "x", initial: "50%" }, fy: { dir: "y", initial: "50%" }, fr: { dir: "xy", initial: "0%" } });
  nums(cls("SVGStopElement", SVGElement), { offset: { initial: 0, parse: function (raw) { if (raw === null) return null; var s = String(raw).trim(), pct = /%$/.test(s); var n = parseNumber(pct ? s.slice(0, -1) : s); if (n === null) return null; if (pct) n /= 100; return Math.max(0, Math.min(1, n)); } } });
  var Pattern = cls("SVGPatternElement", SVGElement);
  enums(Pattern, { patternUnits: { keywords: UNITS, initial: 2 }, patternContentUnits: { keywords: UNITS, initial: 1 } });
  lists(Pattern, { patternTransform: { type: SVGAnimatedTransformList } });
  len(Pattern, { x: { dir: "x" }, y: { dir: "y" }, width: { dir: "x" }, height: { dir: "y" } }); rects(Pattern, ["viewBox"]); pars(Pattern); hrefs(Pattern);
  enums(cls("SVGClipPathElement", SVGElement), { clipPathUnits: { keywords: UNITS, initial: 1 } });
  lists(classes.SVGClipPathElement, { transform: { type: SVGAnimatedTransformList } });
  var Mask = cls("SVGMaskElement", SVGElement);
  enums(Mask, { maskUnits: { keywords: UNITS, initial: 2 }, maskContentUnits: { keywords: UNITS, initial: 1 } });
  len(Mask, { x: { dir: "x", initial: "-10%" }, y: { dir: "y", initial: "-10%" }, width: { dir: "x", initial: "120%" }, height: { dir: "y", initial: "120%" } });
  var Marker = cls("SVGMarkerElement", SVGElement);
  len(Marker, { refX: { dir: "x" }, refY: { dir: "y" }, markerWidth: { dir: "x", initial: "3" }, markerHeight: { dir: "y", initial: "3" } });
  enums(Marker, { markerUnits: { keywords: ["", "userSpaceOnUse", "strokeWidth"], initial: 2 } });
  rects(Marker, ["viewBox"]); pars(Marker);
  Object.defineProperty(Marker.prototype, "orientType", { get: function () { var el = this; return anim(this, "orientType", SVGAnimatedEnumeration, { attr: "orient", keywords: ["", "auto", "", "auto-start-reverse"], initial: 2, invalid: 2, get: null }); }, enumerable: true, configurable: true });
  // orient: "auto" -> 1, "auto-start-reverse" -> 3, an angle -> 2
  Object.defineProperty(Marker.prototype, "orientAngle", { get: function () {
    var el = this;
    return anim(this, "orientAngle", SVGAnimatedAngle, {
      get: function () { var raw = el.getAttribute("orient"); var a = raw === null ? null : parseAngle(raw); return a || { v: 0, u: 1 }; },
      set: function (a) { el.setAttribute("orient", fmt(a.v) + ANGLE_SUFFIX[a.u]); },
    });
  }, enumerable: true, configurable: true });
  Marker.prototype.setOrientToAuto = function () { this.setAttribute("orient", "auto"); };
  Marker.prototype.setOrientToAngle = function (angle) { need(arguments, 1, "setOrientToAngle"); if (!(angle instanceof SVGAngle)) throw new TypeError("Not an SVGAngle"); this.setAttribute("orient", angle.valueAsString); };
  Object.defineProperty(Marker.prototype, "orient", { get: function () { var v = this.getAttribute("orient"); return v === null ? "0" : v; }, set: function (v) { this.setAttribute("orient", String(v)); }, enumerable: true, configurable: true });
  [["SVG_MARKERUNITS_UNKNOWN", 0], ["SVG_MARKERUNITS_USERSPACEONUSE", 1], ["SVG_MARKERUNITS_STROKEWIDTH", 2], ["SVG_MARKER_ORIENT_UNKNOWN", 0], ["SVG_MARKER_ORIENT_AUTO", 1], ["SVG_MARKER_ORIENT_ANGLE", 2]].forEach(function (c) { Object.defineProperty(Marker, c[0], { value: c[1], enumerable: true }); Object.defineProperty(Marker.prototype, c[0], { value: c[1], enumerable: true }); });
  var Symbol_ = cls("SVGSymbolElement", Graphics); rects(Symbol_, ["viewBox"]); pars(Symbol_);
  var View = cls("SVGViewElement", SVGElement); rects(View, ["viewBox"]); pars(View);
  hrefs(cls("SVGMPathElement", SVGElement));
  ["SVGTitleElement", "SVGDescElement", "SVGMetadataElement"].forEach(function (n) { cls(n, SVGElement); });
  var SScript = cls("SVGScriptElement", SVGElement); hrefs(SScript);
  Object.defineProperty(SScript.prototype, "type", { get: function () { var v = this.getAttribute("type"); return v === null ? "" : v; }, set: function (v) { this.setAttribute("type", String(v)); }, enumerable: true, configurable: true });
  cls("SVGStyleElement", SVGElement);

  // filters
  var Filter = cls("SVGFilterElement", SVGElement);
  enums(Filter, { filterUnits: { keywords: UNITS, initial: 2 }, primitiveUnits: { keywords: UNITS, initial: 1 } });
  len(Filter, { x: { dir: "x", initial: "-10%" }, y: { dir: "y", initial: "-10%" }, width: { dir: "x", initial: "120%" }, height: { dir: "y", initial: "120%" } }); hrefs(Filter);
  var FE = {
    feBlend: ["SVGFEBlendElement", function (C) { strs(C, { in1: { attr: "in" }, in2: {} }); enums(C, { mode: { keywords: ["", "normal", "multiply", "screen", "darken", "lighten", "overlay", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"], initial: 1 } }); }],
    feColorMatrix: ["SVGFEColorMatrixElement", function (C) { strs(C, { in1: { attr: "in" } }); enums(C, { type: { keywords: ["", "matrix", "saturate", "hueRotate", "luminanceToAlpha"], initial: 1 } }); lists(C, { values: { type: SVGAnimatedNumberList } }); }],
    feComponentTransfer: ["SVGFEComponentTransferElement", function (C) { strs(C, { in1: { attr: "in" } }); }],
    feComposite: ["SVGFECompositeElement", function (C) { strs(C, { in1: { attr: "in" }, in2: {} }); enums(C, { operator: { keywords: ["", "over", "in", "out", "atop", "xor", "arithmetic"], initial: 1 } }); nums(C, { k1: {}, k2: {}, k3: {}, k4: {} }); }],
    feConvolveMatrix: ["SVGFEConvolveMatrixElement", function (C) { strs(C, { in1: { attr: "in" } }); nums(C, { orderX: Object.assign(optNum("order", 0, 3), { integer: true }), orderY: Object.assign(optNum("order", 1, 3), { integer: true }), divisor: { initial: 1 }, bias: {}, targetX: { integer: true }, targetY: { integer: true }, kernelUnitLengthX: optNum("kernelUnitLength", 0, 0), kernelUnitLengthY: optNum("kernelUnitLength", 1, 0) }); lists(C, { kernelMatrix: { type: SVGAnimatedNumberList } }); enums(C, { edgeMode: { keywords: ["", "duplicate", "wrap", "none"], initial: 1 } }); bools(C, ["preserveAlpha"]); }],
    feDiffuseLighting: ["SVGFEDiffuseLightingElement", function (C) { strs(C, { in1: { attr: "in" } }); nums(C, { surfaceScale: { initial: 1 }, diffuseConstant: { initial: 1 }, kernelUnitLengthX: optNum("kernelUnitLength", 0, 0), kernelUnitLengthY: optNum("kernelUnitLength", 1, 0) }); }],
    feDisplacementMap: ["SVGFEDisplacementMapElement", function (C) { strs(C, { in1: { attr: "in" }, in2: {} }); nums(C, { scale: {} }); enums(C, { xChannelSelector: { keywords: ["", "R", "G", "B", "A"], initial: 4 }, yChannelSelector: { keywords: ["", "R", "G", "B", "A"], initial: 4 } }); }],
    feDropShadow: ["SVGFEDropShadowElement", function (C) { strs(C, { in1: { attr: "in" } }); nums(C, { dx: { initial: 2 }, dy: { initial: 2 }, stdDeviationX: optNum("stdDeviation", 0, 2), stdDeviationY: optNum("stdDeviation", 1, 2) }); C.prototype.setStdDeviation = function (x, y) { this.setAttribute("stdDeviation", fmt(Number(x)) + " " + fmt(Number(y))); }; }],
    feFlood: ["SVGFEFloodElement", function () {}],
    feGaussianBlur: ["SVGFEGaussianBlurElement", function (C) { strs(C, { in1: { attr: "in" } }); nums(C, { stdDeviationX: optNum("stdDeviation", 0, 0), stdDeviationY: optNum("stdDeviation", 1, 0) }); enums(C, { edgeMode: { keywords: ["", "duplicate", "wrap", "none"], initial: 3 } }); C.prototype.setStdDeviation = function (x, y) { this.setAttribute("stdDeviation", fmt(Number(x)) + " " + fmt(Number(y))); }; }],
    feImage: ["SVGFEImageElement", function (C) { pars(C); hrefs(C); Object.defineProperty(C.prototype, "crossOrigin", { get: function () { var v = this.getAttribute("crossorigin"); return v === null ? null : v.toLowerCase() === "use-credentials" ? "use-credentials" : "anonymous"; }, set: function (v) { if (v === null) this.removeAttribute("crossorigin"); else this.setAttribute("crossorigin", v); }, enumerable: true, configurable: true }); }],
    feMerge: ["SVGFEMergeElement", function () {}],
    feMorphology: ["SVGFEMorphologyElement", function (C) { strs(C, { in1: { attr: "in" } }); enums(C, { operator: { keywords: ["", "erode", "dilate"], initial: 1 } }); nums(C, { radiusX: optNum("radius", 0, 0), radiusY: optNum("radius", 1, 0) }); }],
    feOffset: ["SVGFEOffsetElement", function (C) { strs(C, { in1: { attr: "in" } }); nums(C, { dx: {}, dy: {} }); }],
    feSpecularLighting: ["SVGFESpecularLightingElement", function (C) { strs(C, { in1: { attr: "in" } }); nums(C, { surfaceScale: { initial: 1 }, specularConstant: { initial: 1 }, specularExponent: { initial: 1 }, kernelUnitLengthX: optNum("kernelUnitLength", 0, 0), kernelUnitLengthY: optNum("kernelUnitLength", 1, 0) }); }],
    feTile: ["SVGFETileElement", function (C) { strs(C, { in1: { attr: "in" } }); }],
    feTurbulence: ["SVGFETurbulenceElement", function (C) { nums(C, { baseFrequencyX: optNum("baseFrequency", 0, 0), baseFrequencyY: optNum("baseFrequency", 1, 0), numOctaves: { integer: true, initial: 1 }, seed: {} }); enums(C, { stitchTiles: { keywords: ["", "stitch", "noStitch"], initial: 2 }, type: { keywords: ["", "fractalNoise", "turbulence"], initial: 2 } }); }],
  };
  Object.keys(FE).forEach(function (tag) {
    var C = cls(FE[tag][0], SVGElement);
    len(C, { x: { dir: "x", initial: "0%" }, y: { dir: "y", initial: "0%" }, width: { dir: "x", initial: "100%" }, height: { dir: "y", initial: "100%" } });
    strs(C, { result: {} });
    FE[tag][1](C);
    __jb.SVG_INTERFACES[tag] = FE[tag][0];
  });
  var MergeNode = cls("SVGFEMergeNodeElement", SVGElement); strs(MergeNode, { in1: { attr: "in" } }); __jb.SVG_INTERFACES.feMergeNode = "SVGFEMergeNodeElement";
  nums(cls("SVGFEDistantLightElement", SVGElement), { azimuth: {}, elevation: {} }); __jb.SVG_INTERFACES.feDistantLight = "SVGFEDistantLightElement";
  nums(cls("SVGFEPointLightElement", SVGElement), { x: {}, y: {}, z: {} }); __jb.SVG_INTERFACES.fePointLight = "SVGFEPointLightElement";
  nums(cls("SVGFESpotLightElement", SVGElement), { x: {}, y: {}, z: {}, pointsAtX: {}, pointsAtY: {}, pointsAtZ: {}, specularExponent: { initial: 1 }, limitingConeAngle: {} }); __jb.SVG_INTERFACES.feSpotLight = "SVGFESpotLightElement";
  var Transfer = cls("SVGComponentTransferFunctionElement", SVGElement);
  enums(Transfer, { type: { keywords: ["", "identity", "table", "discrete", "linear", "gamma"], initial: 1 } });
  lists(Transfer, { tableValues: { type: SVGAnimatedNumberList } });
  nums(Transfer, { slope: { initial: 1 }, intercept: {}, amplitude: { initial: 1 }, exponent: { initial: 1 }, offset: {} });
  ["feFuncR", "feFuncG", "feFuncB", "feFuncA"].forEach(function (t) { var n = "SVGFE" + t.slice(2) + "Element"; cls(n, Transfer); __jb.SVG_INTERFACES[t] = n; });
  [["SVG_FECOMPONENTTRANSFER_TYPE_UNKNOWN", 0], ["SVG_FECOMPONENTTRANSFER_TYPE_IDENTITY", 1], ["SVG_FECOMPONENTTRANSFER_TYPE_TABLE", 2], ["SVG_FECOMPONENTTRANSFER_TYPE_DISCRETE", 3], ["SVG_FECOMPONENTTRANSFER_TYPE_LINEAR", 4], ["SVG_FECOMPONENTTRANSFER_TYPE_GAMMA", 5]].forEach(function (c) { Object.defineProperty(Transfer, c[0], { value: c[1], enumerable: true }); Object.defineProperty(Transfer.prototype, c[0], { value: c[1], enumerable: true }); });

  function constants(C, list) { list.forEach(function (c, i) { if (c === null) return; Object.defineProperty(C, c, { value: i, enumerable: true }); Object.defineProperty(C.prototype, c, { value: i, enumerable: true }); }); }
  constants(classes.SVGFEBlendElement, ["SVG_FEBLEND_MODE_UNKNOWN", "SVG_FEBLEND_MODE_NORMAL", "SVG_FEBLEND_MODE_MULTIPLY", "SVG_FEBLEND_MODE_SCREEN", "SVG_FEBLEND_MODE_DARKEN", "SVG_FEBLEND_MODE_LIGHTEN", "SVG_FEBLEND_MODE_OVERLAY", "SVG_FEBLEND_MODE_COLOR_DODGE", "SVG_FEBLEND_MODE_COLOR_BURN", "SVG_FEBLEND_MODE_HARD_LIGHT", "SVG_FEBLEND_MODE_SOFT_LIGHT", "SVG_FEBLEND_MODE_DIFFERENCE", "SVG_FEBLEND_MODE_EXCLUSION", "SVG_FEBLEND_MODE_HUE", "SVG_FEBLEND_MODE_SATURATION", "SVG_FEBLEND_MODE_COLOR", "SVG_FEBLEND_MODE_LUMINOSITY"]);
  constants(classes.SVGFEColorMatrixElement, ["SVG_FECOLORMATRIX_TYPE_UNKNOWN", "SVG_FECOLORMATRIX_TYPE_MATRIX", "SVG_FECOLORMATRIX_TYPE_SATURATE", "SVG_FECOLORMATRIX_TYPE_HUEROTATE", "SVG_FECOLORMATRIX_TYPE_LUMINANCETOALPHA"]);
  constants(classes.SVGFECompositeElement, ["SVG_FECOMPOSITE_OPERATOR_UNKNOWN", "SVG_FECOMPOSITE_OPERATOR_OVER", "SVG_FECOMPOSITE_OPERATOR_IN", "SVG_FECOMPOSITE_OPERATOR_OUT", "SVG_FECOMPOSITE_OPERATOR_ATOP", "SVG_FECOMPOSITE_OPERATOR_XOR", "SVG_FECOMPOSITE_OPERATOR_ARITHMETIC"]);
  constants(classes.SVGFEConvolveMatrixElement, ["SVG_EDGEMODE_UNKNOWN", "SVG_EDGEMODE_DUPLICATE", "SVG_EDGEMODE_WRAP", "SVG_EDGEMODE_NONE"]);
  constants(classes.SVGFEGaussianBlurElement, ["SVG_EDGEMODE_UNKNOWN", "SVG_EDGEMODE_DUPLICATE", "SVG_EDGEMODE_WRAP", "SVG_EDGEMODE_NONE"]);
  constants(classes.SVGFEDisplacementMapElement, ["SVG_CHANNEL_UNKNOWN", "SVG_CHANNEL_R", "SVG_CHANNEL_G", "SVG_CHANNEL_B", "SVG_CHANNEL_A"]);
  constants(classes.SVGFEMorphologyElement, ["SVG_MORPHOLOGY_OPERATOR_UNKNOWN", "SVG_MORPHOLOGY_OPERATOR_ERODE", "SVG_MORPHOLOGY_OPERATOR_DILATE"]);
  constants(classes.SVGFETurbulenceElement, ["SVG_TURBULENCE_TYPE_UNKNOWN", "SVG_TURBULENCE_TYPE_FRACTALNOISE", "SVG_TURBULENCE_TYPE_TURBULENCE"]);
  ["SVG_STITCHTYPE_UNKNOWN", "SVG_STITCHTYPE_STITCH", "SVG_STITCHTYPE_NOSTITCH"].forEach(function (c, i) { Object.defineProperty(classes.SVGFETurbulenceElement, c, { value: i, enumerable: true }); Object.defineProperty(classes.SVGFETurbulenceElement.prototype, c, { value: i, enumerable: true }); });
  class SVGUnitTypes { constructor() { throw new TypeError("Illegal constructor"); } }
  constants(SVGUnitTypes, ["SVG_UNIT_TYPE_UNKNOWN", "SVG_UNIT_TYPE_USERSPACEONUSE", "SVG_UNIT_TYPE_OBJECTBOUNDINGBOX"]);
  define(SVGUnitTypes, "SVGUnitTypes");

  // animation elements (API surface; no SMIL engine)
  var Animation = cls("SVGAnimationElement", SVGElement);
  testsMixin(Animation);
  Object.defineProperty(Animation.prototype, "targetElement", { get: function () { var h = this.getAttribute("href") || this.getAttributeNS(XLINK_NS, "href"); if (h && h.charAt(0) === "#") return this.ownerDocument.getElementById(h.slice(1)); var p = this.parentNode; return p && p.nodeType === 1 ? p : null; }, enumerable: true, configurable: true });
  Animation.prototype.getStartTime = function () { throw dom("InvalidStateError", "The animation has no current interval"); };
  Animation.prototype.getCurrentTime = function () { var svg = this.ownerSVGElement; return svg ? svg.getCurrentTime() : 0; };
  Animation.prototype.getSimpleDuration = function () { var d = (this.getAttribute("dur") || "").trim(), m = /^([\d.]+)(ms|s|min|h)?$/.exec(d); if (!m) throw dom("NotSupportedError", "The simple duration is indefinite"); var n = Number(m[1]); return m[2] === "ms" ? n / 1000 : m[2] === "min" ? n * 60 : m[2] === "h" ? n * 3600 : n; };
  Animation.prototype.beginElement = function () {};
  Animation.prototype.endElement = function () {};
  Animation.prototype.beginElementAt = function (offset) { need(arguments, 1, "beginElementAt"); };
  Animation.prototype.endElementAt = function (offset) { need(arguments, 1, "endElementAt"); };
  ["begin", "end", "repeat"].forEach(function (t) { var slot = "_on" + t; Object.defineProperty(Animation.prototype, "on" + t, { get: function () { return this[slot] === undefined ? null : this[slot]; }, set: function (v) { this[slot] = typeof v === "function" || (v !== null && typeof v === "object") ? v : null; __jb.handlerSlot(this, t, this[slot]); }, enumerable: true, configurable: true }); });
  [["animate", "SVGAnimateElement"], ["set", "SVGSetElement"], ["animateMotion", "SVGAnimateMotionElement"], ["animateTransform", "SVGAnimateTransformElement"]].forEach(function (p) { cls(p[1], Animation); __jb.SVG_INTERFACES[p[0]] = p[1]; });

  // SVGSVGElement methods
  var clock = { paused: false, base: 0, start: Date.now() };
  SVGSVGElement.prototype.pauseAnimations = function () { if (!this._clock) this._clock = { paused: false, t: 0, at: Date.now() }; var c = this._clock; if (!c.paused) { c.t += (Date.now() - c.at) / 1000; c.paused = true; } };
  SVGSVGElement.prototype.unpauseAnimations = function () { if (!this._clock) this._clock = { paused: false, t: 0, at: Date.now() }; var c = this._clock; if (c.paused) { c.paused = false; c.at = Date.now(); } };
  SVGSVGElement.prototype.animationsPaused = function () { return !!(this._clock && this._clock.paused); };
  SVGSVGElement.prototype.getCurrentTime = function () { var c = this._clock || (this._clock = { paused: false, t: 0, at: Date.now() }); return c.paused ? c.t : c.t + (Date.now() - c.at) / 1000; };
  SVGSVGElement.prototype.setCurrentTime = function (s) { need(arguments, 1, "setCurrentTime"); s = Number(s); if (!isFinite(s)) throw new TypeError("seconds is not finite"); var c = this._clock || (this._clock = { paused: false, t: 0, at: Date.now() }); c.t = Math.max(0, s); c.at = Date.now(); };
  SVGSVGElement.prototype.suspendRedraw = function (ms) { need(arguments, 1, "suspendRedraw"); return 1; };
  SVGSVGElement.prototype.unsuspendRedraw = function (handle) { need(arguments, 1, "unsuspendRedraw"); };
  SVGSVGElement.prototype.unsuspendRedrawAll = function () {};
  SVGSVGElement.prototype.forceRedraw = function () {};
  SVGSVGElement.prototype.deselectAll = function () { var s = getSelection && getSelection(); if (s) s.removeAllRanges(); };
  SVGSVGElement.prototype.createSVGNumber = function () { return newNumber({ v: 0 }); };
  SVGSVGElement.prototype.createSVGLength = function () { return newLength({ l: { v: 0, u: 1 } }); };
  SVGSVGElement.prototype.createSVGAngle = function () { return newAngle({ a: { v: 0, u: 1 } }); };
  SVGSVGElement.prototype.createSVGPoint = function () { return new DOMPoint(); };
  SVGSVGElement.prototype.createSVGMatrix = function () { return new DOMMatrix(); };
  SVGSVGElement.prototype.createSVGRect = function () { return new DOMRect(); };
  SVGSVGElement.prototype.createSVGTransform = function () { return newTransform({ t: { type: T.MATRIX, m: [1, 0, 0, 1, 0, 0], angle: 0 } }); };
  SVGSVGElement.prototype.createSVGTransformFromMatrix = function (matrix) { var t = this.createSVGTransform(); t.setMatrix(matrix); return t; };
  SVGSVGElement.prototype.getElementById = function (id) { need(arguments, 1, "getElementById"); id = String(id); var found = null; (function walk(n) { for (var c = n.firstChild; c && !found; c = c.nextSibling) { if (c.nodeType === 1) { if (c.getAttribute("id") === id) { found = c; return; } walk(c); } } })(this); return found; };
  SVGSVGElement.prototype.getIntersectionList = function (rect, ref) { need(arguments, 2, "getIntersectionList"); return __jb.currentDocument.createDocumentFragment().childNodes; };
  SVGSVGElement.prototype.getEnclosureList = function (rect, ref) { need(arguments, 2, "getEnclosureList"); return __jb.currentDocument.createDocumentFragment().childNodes; };
  SVGSVGElement.prototype.checkIntersection = function (el, rect) { need(arguments, 2, "checkIntersection"); return false; };
  SVGSVGElement.prototype.checkEnclosure = function (el, rect) { need(arguments, 2, "checkEnclosure"); return false; };
  Object.defineProperty(SVGSVGElement.prototype, "currentScale", { get: function () { return this._currentScale === undefined ? 1 : this._currentScale; }, set: function (v) { v = Number(v); if (!isFinite(v)) throw new TypeError("not finite"); this._currentScale = v; }, enumerable: true, configurable: true });
  Object.defineProperty(SVGSVGElement.prototype, "currentTranslate", { get: function () { return this._currentTranslate || (this._currentTranslate = new DOMPoint(0, 0)); }, enumerable: true, configurable: true });
  [["SVG_ZOOMANDPAN_UNKNOWN", 0], ["SVG_ZOOMANDPAN_DISABLE", 1], ["SVG_ZOOMANDPAN_MAGNIFY", 2]].forEach(function (c) { Object.defineProperty(View, c[0], { value: c[1], enumerable: true }); });
  // SVGSVGElement event handler attributes (WindowEventHandlers subset)
  void clock;

  // ------------------------------------------------------------ geometry
  function lengthAttr(el, name, dir) { var l = parseLength(el.getAttribute(name)); return l ? lengthToPx(l, el, dir) : 0; }
  // Path data: an array of absolute segments {type: "M"|"L"|"C"|"Z", pts}.
  function parsePathData(d) {
    var segs = [], re = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g, tokens = [], m;
    while ((m = re.exec(d || "")) !== null) tokens.push(m[1] || Number(m[2]));
    var i = 0, cmd = null, x = 0, y = 0, sx = 0, sy = 0, lcx = 0, lcy = 0, lqx = 0, lqy = 0, prev = "";
    var num = function () { var v = tokens[i]; if (typeof v !== "number") throw 0; i++; return v; };
    try {
      while (i < tokens.length) {
        if (typeof tokens[i] === "string") cmd = tokens[i++];
        else if (!cmd) break;
        var rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
        if (C === "Z") { segs.push({ type: "L", from: [x, y], to: [sx, sy], close: true }); x = sx; y = sy; prev = "Z"; cmd = null; continue; }
        if (C === "M") { var mx = num(), my = num(); if (rel) { mx += x; my += y; } x = sx = mx; y = sy = my; segs.push({ type: "M", to: [x, y] }); cmd = rel ? "l" : "L"; prev = "M"; continue; }
        if (C === "L" || C === "H" || C === "V") { var nx = x, ny = y; if (C === "L") { nx = num(); ny = num(); if (rel) { nx += x; ny += y; } } else if (C === "H") { nx = num() + (rel ? x : 0); } else { ny = num() + (rel ? y : 0); } segs.push({ type: "L", from: [x, y], to: [nx, ny] }); x = nx; y = ny; prev = "L"; continue; }
        if (C === "C" || C === "S") {
          var c1x, c1y; if (C === "C") { c1x = num(); c1y = num(); if (rel) { c1x += x; c1y += y; } } else { c1x = /[CS]/.test(prev) ? 2 * x - lcx : x; c1y = /[CS]/.test(prev) ? 2 * y - lcy : y; }
          var c2x = num(), c2y = num(), ex = num(), ey = num(); if (rel) { c2x += x; c2y += y; ex += x; ey += y; }
          segs.push({ type: "C", from: [x, y], c1: [c1x, c1y], c2: [c2x, c2y], to: [ex, ey] }); lcx = c2x; lcy = c2y; x = ex; y = ey; prev = C; continue;
        }
        if (C === "Q" || C === "T") {
          var qx, qy; if (C === "Q") { qx = num(); qy = num(); if (rel) { qx += x; qy += y; } } else { qx = /[QT]/.test(prev) ? 2 * x - lqx : x; qy = /[QT]/.test(prev) ? 2 * y - lqy : y; }
          var qex = num(), qey = num(); if (rel) { qex += x; qey += y; }
          segs.push({ type: "C", from: [x, y], c1: [x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y)], c2: [qex + 2 / 3 * (qx - qex), qey + 2 / 3 * (qy - qey)], to: [qex, qey] }); lqx = qx; lqy = qy; x = qex; y = qey; prev = C; continue;
        }
        if (C === "A") {
          var rx = num(), ry = num(), rot = num(), large = num(), sweep = num(), ax = num(), ay = num(); if (rel) { ax += x; ay += y; }
          arcToCurves(x, y, rx, ry, rot, large, sweep, ax, ay).forEach(function (s) { segs.push(s); });
          x = ax; y = ay; prev = "A"; continue;
        }
        break;
      }
    } catch (e) {}
    return segs;
  }
  function arcToCurves(x1, y1, rx, ry, phi, fa, fs, x2, y2) {
    if (rx === 0 || ry === 0) return [{ type: "L", from: [x1, y1], to: [x2, y2] }];
    rx = Math.abs(rx); ry = Math.abs(ry);
    var sinp = Math.sin(phi * Math.PI / 180), cosp = Math.cos(phi * Math.PI / 180);
    var dx = (x1 - x2) / 2, dy = (y1 - y2) / 2, x1p = cosp * dx + sinp * dy, y1p = -sinp * dx + cosp * dy;
    var lam = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry); if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    var num_ = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p, den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    var coef = (fa !== fs ? 1 : -1) * Math.sqrt(Math.max(0, num_ / den));
    var cxp = coef * rx * y1p / ry, cyp = -coef * ry * x1p / rx;
    var cx = cosp * cxp - sinp * cyp + (x1 + x2) / 2, cy = sinp * cxp + cosp * cyp + (y1 + y2) / 2;
    var ang = function (ux, uy, vx, vy) { var a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a; };
    var t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry), dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!fs && dt > 0) dt -= 2 * Math.PI; else if (fs && dt < 0) dt += 2 * Math.PI;
    var n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2))), out = [], step = dt / n;
    var pt = function (t) { var ex = rx * Math.cos(t), ey = ry * Math.sin(t); return [cosp * ex - sinp * ey + cx, sinp * ex + cosp * ey + cy]; };
    for (var k = 0; k < n; k++) {
      var a1 = t1 + k * step, a2 = a1 + step, al = 4 / 3 * Math.tan(step / 4);
      var p1 = pt(a1), p2 = pt(a2);
      var d1 = [-rx * Math.sin(a1), ry * Math.cos(a1)], d2 = [-rx * Math.sin(a2), ry * Math.cos(a2)];
      var rd = function (d) { return [cosp * d[0] - sinp * d[1], sinp * d[0] + cosp * d[1]]; };
      var r1 = rd(d1), r2 = rd(d2);
      out.push({ type: "C", from: p1, c1: [p1[0] + al * r1[0], p1[1] + al * r1[1]], c2: [p2[0] - al * r2[0], p2[1] - al * r2[1]], to: k === n - 1 ? [x2, y2] : p2 });
    }
    return out;
  }
  function segmentsOf(el) {
    var t = el._tag;
    if (t === "path") return parsePathData(el.getAttribute("d"));
    var L = function (a, b) { return { type: "L", from: a, to: b }; };
    if (t === "line") { var p1 = [lengthAttr(el, "x1", "x"), lengthAttr(el, "y1", "y")], p2 = [lengthAttr(el, "x2", "x"), lengthAttr(el, "y2", "y")]; return [{ type: "M", to: p1 }, L(p1, p2)]; }
    if (t === "polyline" || t === "polygon") {
      var pts = SVGPointList.prototype._parse.call(null, el.getAttribute("points")) || [];
      if (!pts.length) return [];
      var segs = [{ type: "M", to: [pts[0].x, pts[0].y] }];
      for (var i = 1; i < pts.length; i++) segs.push(L([pts[i - 1].x, pts[i - 1].y], [pts[i].x, pts[i].y]));
      if (t === "polygon") segs.push(L([pts[pts.length - 1].x, pts[pts.length - 1].y], [pts[0].x, pts[0].y]));
      return segs;
    }
    if (t === "rect") {
      var x = lengthAttr(el, "x", "x"), y = lengthAttr(el, "y", "y"), w = lengthAttr(el, "width", "x"), h = lengthAttr(el, "height", "y");
      if (w <= 0 || h <= 0) return [];
      return [{ type: "M", to: [x, y] }, L([x, y], [x + w, y]), L([x + w, y], [x + w, y + h]), L([x + w, y + h], [x, y + h]), L([x, y + h], [x, y])];
    }
    if (t === "circle" || t === "ellipse") {
      var cx = lengthAttr(el, "cx", "x"), cy = lengthAttr(el, "cy", "y");
      var rx = t === "circle" ? lengthAttr(el, "r", "xy") : lengthAttr(el, "rx", "x"), ry = t === "circle" ? rx : lengthAttr(el, "ry", "y");
      if (rx <= 0 || ry <= 0) return [];
      var start = [cx + rx, cy];
      return [{ type: "M", to: start }].concat(arcToCurves(cx + rx, cy, rx, ry, 0, 0, 1, cx - rx, cy), arcToCurves(cx - rx, cy, rx, ry, 0, 0, 1, cx + rx, cy));
    }
    return [];
  }
  function bezierAt(s, t) { var u = 1 - t; return [u * u * u * s.from[0] + 3 * u * u * t * s.c1[0] + 3 * u * t * t * s.c2[0] + t * t * t * s.to[0], u * u * u * s.from[1] + 3 * u * u * t * s.c1[1] + 3 * u * t * t * s.c2[1] + t * t * t * s.to[1]]; }
  var STEPS = 64;
  function segLength(s) {
    if (s.type === "M") return 0;
    if (s.type === "L") return Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]);
    var len = 0, p = s.from;
    for (var i = 1; i <= STEPS; i++) { var q = bezierAt(s, i / STEPS); len += Math.hypot(q[0] - p[0], q[1] - p[1]); p = q; }
    return len;
  }
  function pathLengthOf(segs) { return __jb.A.reduce.call(segs, function (a, s) { return a + segLength(s); }, 0); }
  function pointAtLength(segs, d) {
    if (!segs.length) return { x: 0, y: 0 };
    d = Math.max(0, d);
    var last = null;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.type === "M") { last = s.to; continue; }
      var l = segLength(s);
      if (d <= l) {
        if (s.type === "L") { var t = l ? d / l : 0; return { x: s.from[0] + (s.to[0] - s.from[0]) * t, y: s.from[1] + (s.to[1] - s.from[1]) * t }; }
        var acc = 0, p = s.from;
        for (var k = 1; k <= STEPS; k++) { var q = bezierAt(s, k / STEPS), sl = Math.hypot(q[0] - p[0], q[1] - p[1]); if (acc + sl >= d) { var f = sl ? (d - acc) / sl : 0; return { x: p[0] + (q[0] - p[0]) * f, y: p[1] + (q[1] - p[1]) * f }; } acc += sl; p = q; }
        return { x: s.to[0], y: s.to[1] };
      }
      d -= l; last = s.to;
    }
    return { x: last ? last[0] : 0, y: last ? last[1] : 0 };
  }
  function flatten(segs) {
    var polys = [], cur = null;
    segs.forEach(function (s) {
      if (s.type === "M") { cur = [s.to]; polys.push(cur); return; }
      if (!cur) { cur = [s.from]; polys.push(cur); }
      if (s.type === "L") cur.push(s.to);
      else for (var i = 1; i <= 16; i++) cur.push(bezierAt(s, i / 16));
    });
    return polys;
  }
  function pointInPolygon(polys, x, y) {
    var wn = 0;
    polys.forEach(function (poly) {
      for (var i = 0; i < poly.length; i++) {
        var a = poly[i], b = poly[(i + 1) % poly.length];
        if (a[1] <= y) { if (b[1] > y && (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]) > 0) wn++; }
        else if (b[1] <= y && (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]) < 0) wn--;
        if (distToSeg(x, y, a, b) < 1e-9) { wn = 1; return; }
      }
    });
    return wn !== 0;
  }
  function distToSeg(x, y, a, b) { var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0; return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)); }
  function bbox(el) {
    if (el._tag === "g" || el._tag === "svg" || el._tag === "a" || el._tag === "switch" || el._tag === "symbol") {
      var r = null;
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1 || c._ns !== SVG_NS || typeof c.getBBox !== "function" || c._tag === "defs") continue;
        var b = bbox(c);
        if (b.width === 0 && b.height === 0 && b.x === 0 && b.y === 0 && !segmentsOf(c).length && c.childNodes.length === 0) continue;
        var tl = transformPoint(ownTransform(c), [b.x, b.y]), br = transformPoint(ownTransform(c), [b.x + b.width, b.y + b.height]);
        var nb = { x: Math.min(tl[0], br[0]), y: Math.min(tl[1], br[1]), width: Math.abs(br[0] - tl[0]), height: Math.abs(br[1] - tl[1]) };
        r = r ? union(r, nb) : nb;
      }
      return r || { x: 0, y: 0, width: 0, height: 0 };
    }
    if (el._tag === "use" || el._tag === "image" || el._tag === "foreignObject") return { x: lengthAttr(el, "x", "x"), y: lengthAttr(el, "y", "y"), width: lengthAttr(el, "width", "x"), height: lengthAttr(el, "height", "y") };
    if (el._tag === "text" || el._tag === "tspan" || el._tag === "textPath") { var n = (el.textContent || "").length; return { x: startX(el), y: startY(el) - 12, width: n * CHAR_W, height: n ? 16 : 0 }; }
    var polys = flatten(segmentsOf(el)), minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    polys.forEach(function (p) { p.forEach(function (q) { minx = Math.min(minx, q[0]); miny = Math.min(miny, q[1]); maxx = Math.max(maxx, q[0]); maxy = Math.max(maxy, q[1]); }); });
    if (minx === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: minx, y: miny, width: maxx - minx, height: maxy - miny };
  }
  function union(a, b) { var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x: x, y: y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }; }
  function ownTransform(el) { var list = parseTransformList(el.getAttribute && el.getAttribute("transform")) || []; return __jb.A.reduce.call(list, function (m, t) { return multiply(m, t.m); }, [1, 0, 0, 1, 0, 0]); }
  function transformPoint(m, p) { return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]; }
  function ctm(el, screen) {
    var m = ownTransform(el);
    for (var p = el.parentNode; p && p.nodeType === 1 && p._ns === SVG_NS; p = p.parentNode) {
      if (p._tag === "svg") {
        var x = lengthAttr(p, "x", "x"), y = lengthAttr(p, "y", "y");
        if (!screen && !p.ownerSVGElement) break;
        if (p.ownerSVGElement || screen) m = multiply([1, 0, 0, 1, x, y], m);
        if (!screen) break;
        continue;
      }
      m = multiply(ownTransform(p), m);
    }
    return m;
  }

  // ------------------------------------------------------------ registration
  function nameMethods(C) {
    Object.getOwnPropertyNames(C.prototype).forEach(function (p) {
      var d = Object.getOwnPropertyDescriptor(C.prototype, p);
      if (typeof d.value === "function" && p !== "constructor" && d.value.name !== p) { try { Object.defineProperty(d.value, "name", { value: p, configurable: true }); } catch (e) {} }
    });
  }
  [SVGElement, Graphics, SVGLength, SVGAngle, SVGNumber, SVGTransform, SVGLengthList, SVGNumberList, SVGTransformList, SVGPointList, SVGStringList].forEach(nameMethods);
  Object.keys(classes).forEach(function (n) {
    var C = classes[n];
    nameMethods(C);
    Object.getOwnPropertyNames(C.prototype).forEach(function (p) { if (p === "constructor") return; var d = Object.getOwnPropertyDescriptor(C.prototype, p); if (!d.enumerable && (d.get || typeof d.value === "function")) { d.enumerable = true; Object.defineProperty(C.prototype, p, d); } });
    Object.defineProperty(globalThis, n, { value: C, writable: true, configurable: true, enumerable: false });
  });
  var TAGS = { svg: "SVGSVGElement", g: "SVGGElement", defs: "SVGDefsElement", "switch": "SVGSwitchElement", foreignObject: "SVGForeignObjectElement", use: "SVGUseElement", image: "SVGImageElement", a: "SVGAElement", rect: "SVGRectElement", circle: "SVGCircleElement", ellipse: "SVGEllipseElement", line: "SVGLineElement", path: "SVGPathElement", polyline: "SVGPolylineElement", polygon: "SVGPolygonElement", text: "SVGTextElement", tspan: "SVGTSpanElement", textPath: "SVGTextPathElement", linearGradient: "SVGLinearGradientElement", radialGradient: "SVGRadialGradientElement", stop: "SVGStopElement", pattern: "SVGPatternElement", clipPath: "SVGClipPathElement", mask: "SVGMaskElement", marker: "SVGMarkerElement", symbol: "SVGSymbolElement", view: "SVGViewElement", mpath: "SVGMPathElement", title: "SVGTitleElement", desc: "SVGDescElement", metadata: "SVGMetadataElement", script: "SVGScriptElement", style: "SVGStyleElement", filter: "SVGFilterElement" };
  Object.keys(TAGS).forEach(function (t) { __jb.SVG_INTERFACES[t] = TAGS[t]; });
  // Elements created before this module loaded (none in practice) keep their class; new ones use the map.
})();
