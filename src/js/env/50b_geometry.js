// ---- Geometry Interfaces: DOMPoint(ReadOnly), DOMRect(ReadOnly), DOMQuad, DOMMatrix(ReadOnly) ----
// Matrices are stored as [m11, m12, m13, m14, m21, ..., m44] (column-major, as the spec's
// mIJ naming: column I, row J); a point transforms as p' = M p.
var __geo = (function () {
  var num = function (v) { return +v; };
  var slot = function (o) {
    if (!o || typeof o !== "object" || !o.__g) throw new TypeError("Illegal invocation");
    return o.__g;
  };
  var hide = function (o, v) { Object.defineProperty(o, "__g", { value: v, writable: true, configurable: true }); };
  var ident = function () { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
  var mul = function (A, B) { // A x B
    var C = new Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
      var s = 0;
      for (var k = 0; k < 4; k++) s += A[k * 4 + r] * B[c * 4 + k];
      C[c * 4 + r] = s;
    }
    return C;
  };
  var syntax = function (m) { return __jb.domError("SyntaxError", m || "Failed to parse the transform list"); };
  return { num: num, slot: slot, hide: hide, ident: ident, mul: mul, syntax: syntax };
})();

class DOMPointReadOnly {
  constructor(x, y, z, w) {
    __geo.hide(this, { x: x === undefined ? 0 : +x, y: y === undefined ? 0 : +y, z: z === undefined ? 0 : +z, w: w === undefined ? 1 : +w });
  }
  static fromPoint(other) { var o = other == null ? {} : other; if (typeof o !== "object" && typeof o !== "function") throw new TypeError("DOMPointInit must be an object"); return new this(o.x, o.y, o.z, o.w); }
  get x() { return __geo.slot(this).x; }
  get y() { return __geo.slot(this).y; }
  get z() { return __geo.slot(this).z; }
  get w() { return __geo.slot(this).w; }
  matrixTransform(matrix) { var m = DOMMatrixReadOnly.fromMatrix(matrix); return m.transformPoint(this); }
  toJSON() { var g = __geo.slot(this); return { x: g.x, y: g.y, z: g.z, w: g.w }; }
}
class DOMPoint extends DOMPointReadOnly {
  static fromPoint(other) { var o = other == null ? {} : other; return new DOMPoint(o.x, o.y, o.z, o.w); }
  get x() { return __geo.slot(this).x; } set x(v) { __geo.slot(this).x = +v; }
  get y() { return __geo.slot(this).y; } set y(v) { __geo.slot(this).y = +v; }
  get z() { return __geo.slot(this).z; } set z(v) { __geo.slot(this).z = +v; }
  get w() { return __geo.slot(this).w; } set w(v) { __geo.slot(this).w = +v; }
}

class DOMRectReadOnly {
  constructor(x, y, width, height) {
    __geo.hide(this, { x: x === undefined ? 0 : +x, y: y === undefined ? 0 : +y, width: width === undefined ? 0 : +width, height: height === undefined ? 0 : +height });
  }
  static fromRect(other) { var o = other == null ? {} : other; return new this(o.x, o.y, o.width, o.height); }
  get x() { return __geo.slot(this).x; }
  get y() { return __geo.slot(this).y; }
  get width() { return __geo.slot(this).width; }
  get height() { return __geo.slot(this).height; }
  get top() { var g = __geo.slot(this); return Math.min(g.y, g.y + g.height); }
  get right() { var g = __geo.slot(this); return Math.max(g.x, g.x + g.width); }
  get bottom() { var g = __geo.slot(this); return Math.max(g.y, g.y + g.height); }
  get left() { var g = __geo.slot(this); return Math.min(g.x, g.x + g.width); }
  toJSON() { return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, right: this.right, bottom: this.bottom, left: this.left }; }
}
class DOMRect extends DOMRectReadOnly {
  static fromRect(other) { var o = other == null ? {} : other; return new DOMRect(o.x, o.y, o.width, o.height); }
  get x() { return __geo.slot(this).x; } set x(v) { __geo.slot(this).x = +v; }
  get y() { return __geo.slot(this).y; } set y(v) { __geo.slot(this).y = +v; }
  get width() { return __geo.slot(this).width; } set width(v) { __geo.slot(this).width = +v; }
  get height() { return __geo.slot(this).height; } set height(v) { __geo.slot(this).height = +v; }
}

class DOMQuad {
  constructor(p1, p2, p3, p4) {
    var pt = function (p) { return DOMPoint.fromPoint(p); };
    __geo.hide(this, { p1: pt(p1), p2: pt(p2), p3: pt(p3), p4: pt(p4) });
  }
  static fromRect(other) {
    var o = other == null ? {} : other, x = o.x === undefined ? 0 : +o.x, y = o.y === undefined ? 0 : +o.y, w = o.width === undefined ? 0 : +o.width, h = o.height === undefined ? 0 : +o.height;
    return new DOMQuad({ x: x, y: y }, { x: x + w, y: y }, { x: x + w, y: y + h }, { x: x, y: y + h });
  }
  static fromQuad(other) { var o = other == null ? {} : other; return new DOMQuad(o.p1, o.p2, o.p3, o.p4); }
  get p1() { return __geo.slot(this).p1; }
  get p2() { return __geo.slot(this).p2; }
  get p3() { return __geo.slot(this).p3; }
  get p4() { return __geo.slot(this).p4; }
  getBounds() {
    var g = __geo.slot(this), xs = [g.p1.x, g.p2.x, g.p3.x, g.p4.x], ys = [g.p1.y, g.p2.y, g.p3.y, g.p4.y];
    var nanMin = function (a) { return a.some(isNaN) ? NaN : Math.min.apply(null, a); }, nanMax = function (a) { return a.some(isNaN) ? NaN : Math.max.apply(null, a); };
    var l = nanMin(xs), t = nanMin(ys);
    return new DOMRect(l, t, nanMax(xs) - l, nanMax(ys) - t);
  }
  toJSON() { var g = __geo.slot(this); return { p1: g.p1, p2: g.p2, p3: g.p3, p4: g.p4 }; }
}

// ---- matrices ----
__jb.geoParseTransform = function (text) {
  // CSS <transform-list> (absolute lengths in px only) into [matrix16, is2D]
  var s = String(text).trim();
  if (s === "" || /^none$/i.test(s)) return [__geo.ident(), true];
  var re = /^\s*([a-zA-Z0-9]+)\(([^)]*)\)\s*/, m, M = __geo.ident(), is2D = true, any = false;
  var len = function (t) {
    var mm = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px)?$/i.exec(t);
    if (!mm) throw __geo.syntax();
    if (!mm[2] && +mm[1] !== 0) throw __geo.syntax();
    return +mm[1];
  };
  var numv = function (t) { if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(t)) throw __geo.syntax(); return +t; };
  var ang = function (t) {
    var mm = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/i.exec(t);
    if (!mm) throw __geo.syntax();
    var v = +mm[1], u = (mm[2] || "").toLowerCase();
    if (!u) { if (v !== 0) throw __geo.syntax(); return 0; }
    return u === "deg" ? v : u === "rad" ? v * 180 / Math.PI : u === "grad" ? v * 0.9 : v * 360;
  };
  while (s.length) {
    m = re.exec(s);
    if (!m) throw __geo.syntax();
    s = s.slice(m[0].length);
    any = true;
    var fn = m[1].toLowerCase(), args = m[2].trim() === "" ? [] : m[2].split(",").map(function (a) { return a.trim(); });
    var need = function (lo, hi) { if (args.length < lo || args.length > hi) throw __geo.syntax(); };
    var t = new DOMMatrix();
    switch (fn) {
      case "matrix": need(6, 6); t = new DOMMatrix(args.map(numv)); break;
      case "matrix3d": need(16, 16); t = new DOMMatrix(args.map(numv)); is2D = false; break;
      case "translate": need(1, 2); t.translateSelf(len(args[0]), args.length > 1 ? len(args[1]) : 0); break;
      case "translatex": need(1, 1); t.translateSelf(len(args[0]), 0); break;
      case "translatey": need(1, 1); t.translateSelf(0, len(args[0])); break;
      case "translatez": need(1, 1); t.translateSelf(0, 0, len(args[0])); is2D = false; break;
      case "translate3d": need(3, 3); t.translateSelf(len(args[0]), len(args[1]), len(args[2])); is2D = false; break;
      case "scale": need(1, 2); t.scaleSelf(numv(args[0]), args.length > 1 ? numv(args[1]) : numv(args[0])); break;
      case "scalex": need(1, 1); t.scaleSelf(numv(args[0]), 1); break;
      case "scaley": need(1, 1); t.scaleSelf(1, numv(args[0])); break;
      case "scalez": need(1, 1); t.scaleSelf(1, 1, numv(args[0])); is2D = false; break;
      case "scale3d": need(3, 3); t.scaleSelf(numv(args[0]), numv(args[1]), numv(args[2])); is2D = false; break;
      case "rotate": case "rotatez": need(1, 1); t.rotateSelf(0, 0, ang(args[0])); if (fn === "rotatez") is2D = false; break;
      case "rotatex": need(1, 1); t.rotateSelf(ang(args[0]), 0, 0); is2D = false; break;
      case "rotatey": need(1, 1); t.rotateSelf(0, ang(args[0]), 0); is2D = false; break;
      case "rotate3d": need(4, 4); t.rotateAxisAngleSelf(numv(args[0]), numv(args[1]), numv(args[2]), ang(args[3])); is2D = false; break;
      case "skew": need(1, 2); t = new DOMMatrix([1, args.length > 1 ? Math.tan(ang(args[1]) * Math.PI / 180) : 0, Math.tan(ang(args[0]) * Math.PI / 180), 1, 0, 0]); break;
      case "skewx": need(1, 1); t.skewXSelf(ang(args[0])); break;
      case "skewy": need(1, 1); t.skewYSelf(ang(args[0])); break;
      case "perspective": need(1, 1); { var d = len(args[0]); if (d !== 0) { var g = __geo.slot(t); g.m[11] = -1 / d; g.is2D = false; } } is2D = false; break;
      default: throw __geo.syntax();
    }
    M = __geo.mul(M, __geo.slot(t).m);
  }
  if (!any) throw __geo.syntax();
  return [M, is2D];
};

class DOMMatrixReadOnly {
  constructor(init) {
    var g = { m: __geo.ident(), is2D: true };
    __geo.hide(this, g);
    if (init === undefined) return;
    if (typeof init === "string") {
      if (typeof __jb.currentDocument === "undefined") throw new TypeError("DOMMatrix: string init is only supported in a window");
      var r = __jb.geoParseTransform(init); g.m = r[0]; g.is2D = r[1]; return;
    }
    if (init === null || typeof init !== "object" || typeof init[Symbol.iterator] !== "function") {
      // non-sequence values are stringified (WebIDL union with DOMString)
      if (typeof __jb.currentDocument === "undefined") throw new TypeError("DOMMatrix: invalid init");
      var r2 = __jb.geoParseTransform(String(init)); g.m = r2[0]; g.is2D = r2[1]; return;
    }
    var seq = __jb.arrayFrom(init, function (v) { return +v; });
    if (seq.length === 6) { g.m = [seq[0], seq[1], 0, 0, seq[2], seq[3], 0, 0, 0, 0, 1, 0, seq[4], seq[5], 0, 1]; g.is2D = true; }
    else if (seq.length === 16) { g.m = seq; g.is2D = false; }
    else throw new TypeError("DOMMatrix: a sequence of 6 or 16 numbers is required");
  }
  static fromMatrix(other) { var r = __jb.geoFixup(other); var o = new this(); var g = __geo.slot(o); g.m = r[0]; g.is2D = r[1]; return o; }
  static fromFloat32Array(a) { if (!(a instanceof Float32Array)) throw new TypeError("Float32Array required"); if (a.length !== 6 && a.length !== 16) throw new TypeError("6 or 16 elements required"); return new this(__jb.arrayFrom(a)); }
  static fromFloat64Array(a) { if (!(a instanceof Float64Array)) throw new TypeError("Float64Array required"); if (a.length !== 6 && a.length !== 16) throw new TypeError("6 or 16 elements required"); return new this(__jb.arrayFrom(a)); }
  get is2D() { return __geo.slot(this).is2D; }
  get isIdentity() { var m = __geo.slot(this).m, I = __geo.ident(); for (var i = 0; i < 16; i++) if (m[i] !== I[i]) return false; return true; }
  translate(tx, ty, tz) { return DOMMatrix.fromMatrix(this).translateSelf(tx, ty, tz); }
  scale(sx, sy, sz, ox, oy, oz) { return DOMMatrix.fromMatrix(this).scaleSelf(sx, sy, sz, ox, oy, oz); }
  scaleNonUniform(sx, sy) { return DOMMatrix.fromMatrix(this).scaleSelf(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, 1, 0, 0, 0); }
  scale3d(s, ox, oy, oz) { return DOMMatrix.fromMatrix(this).scale3dSelf(s, ox, oy, oz); }
  rotate(rx, ry, rz) { return DOMMatrix.fromMatrix(this).rotateSelf(rx, ry, rz); }
  rotateFromVector(x, y) { return DOMMatrix.fromMatrix(this).rotateFromVectorSelf(x, y); }
  rotateAxisAngle(x, y, z, a) { return DOMMatrix.fromMatrix(this).rotateAxisAngleSelf(x, y, z, a); }
  skewX(s) { return DOMMatrix.fromMatrix(this).skewXSelf(s); }
  skewY(s) { return DOMMatrix.fromMatrix(this).skewYSelf(s); }
  multiply(other) { return DOMMatrix.fromMatrix(this).multiplySelf(other); }
  flipX() { return DOMMatrix.fromMatrix(this).multiplySelf(new DOMMatrix([-1, 0, 0, 1, 0, 0])); }
  flipY() { return DOMMatrix.fromMatrix(this).multiplySelf(new DOMMatrix([1, 0, 0, -1, 0, 0])); }
  inverse() { return DOMMatrix.fromMatrix(this).invertSelf(); }
  transformPoint(point) {
    var p = DOMPoint.fromPoint(point), m = __geo.slot(this).m, x = p.x, y = p.y, z = p.z, w = p.w;
    if (__geo.slot(this).is2D && z === 0 && w === 1) return new DOMPoint(m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13], 0, 1);
    return new DOMPoint(m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w, m[2] * x + m[6] * y + m[10] * z + m[14] * w, m[3] * x + m[7] * y + m[11] * z + m[15] * w);
  }
  toFloat32Array() { return new Float32Array(__geo.slot(this).m); }
  toFloat64Array() { return new Float64Array(__geo.slot(this).m); }
  toString() {
    var g = __geo.slot(this), m = g.m;
    if (m.some(function (v) { return !isFinite(v); })) throw __jb.domError("InvalidStateError", "Matrix contains non-finite values");
    var f = function (v) { return String(v); };
    return g.is2D ? "matrix(" + [m[0], m[1], m[4], m[5], m[12], m[13]].map(f).join(", ") + ")" : "matrix3d(" + m.map(f).join(", ") + ")";
  }
  toJSON() {
    var o = {}, self_ = this;
    ["a", "b", "c", "d", "e", "f", "m11", "m12", "m13", "m14", "m21", "m22", "m23", "m24", "m31", "m32", "m33", "m34", "m41", "m42", "m43", "m44", "is2D", "isIdentity"].forEach(function (k) { o[k] = self_[k]; });
    return o;
  }
}
// element accessors: a..f alias m11, m12, m21, m22, m41, m42
(function () {
  var names = ["m11", "m12", "m13", "m14", "m21", "m22", "m23", "m24", "m31", "m32", "m33", "m34", "m41", "m42", "m43", "m44"];
  var alias = { a: 0, b: 1, c: 4, d: 5, e: 12, f: 13 };
  var twoD = { 2: 0, 3: 0, 6: 0, 7: 0, 8: 0, 9: 0, 11: 0, 14: 0, 10: 1, 15: 1 };
  var def = function (name, i) {
    Object.defineProperty(DOMMatrixReadOnly.prototype, name, { get: function () { return __geo.slot(this).m[i]; }, enumerable: true, configurable: true });
  };
  Object.keys(alias).forEach(function (k) { def(k, alias[k]); });
  names.forEach(function (n, i) { def(n, i); });
  __jb.geoSetters = function (C) {
    var set = function (name, i) {
      Object.defineProperty(C.prototype, name, {
        get: function () { return __geo.slot(this).m[i]; },
        set: function (v) { var g = __geo.slot(this); g.m[i] = +v; if (i in twoD && !(g.m[i] === twoD[i] && !Object.is(g.m[i], -0))) g.is2D = false; },
        enumerable: true, configurable: true,
      });
    };
    Object.keys(alias).forEach(function (k) { set(k, alias[k]); });
    names.forEach(function (n, i) { set(n, i); });
  };
})();
// "Validate and fixup" a DOMMatrixInit dictionary into [matrix16, is2D].
__jb.geoFixup = function (o) {
  if (o === undefined || o === null) o = {};
  if (typeof o !== "object" && typeof o !== "function") throw new TypeError("DOMMatrixInit must be an object");
  if (o instanceof DOMMatrixReadOnly) { var g0 = __geo.slot(o); return [g0.m.slice(), g0.is2D]; }
  var rd = function (k) { var v = o[k]; return v === undefined ? undefined : +v; };
  var pairs = [["a", "m11"], ["b", "m12"], ["c", "m21"], ["d", "m22"], ["e", "m41"], ["f", "m42"]];
  var vals = {};
  ["a", "b", "c", "d", "e", "f", "m11", "m12", "m13", "m14", "m21", "m22", "m23", "m24", "m31", "m32", "m33", "m34", "m41", "m42", "m43", "m44"].forEach(function (k) { vals[k] = rd(k); });
  var is2D = o.is2D === undefined ? undefined : !!o.is2D;
  var same = function (x, y) { return x === y || (x !== x && y !== y); };
  pairs.forEach(function (p) {
    var a = vals[p[0]], m = vals[p[1]];
    if (a !== undefined && m !== undefined && !same(a, m)) throw new TypeError("DOMMatrixInit: " + p[0] + " and " + p[1] + " disagree");
    if (m === undefined) vals[p[1]] = a !== undefined ? a : (p[1] === "m11" || p[1] === "m22" ? 1 : 0);
  });
  var z0 = ["m13", "m14", "m23", "m24", "m31", "m32", "m34", "m43"], z1 = ["m33", "m44"];
  if (is2D === true) {
    z0.forEach(function (k) { if (vals[k] !== undefined && !(vals[k] === 0)) throw new TypeError("DOMMatrixInit: is2D with 3D components"); });
    z1.forEach(function (k) { if (vals[k] !== undefined && vals[k] !== 1) throw new TypeError("DOMMatrixInit: is2D with 3D components"); });
  }
  z0.forEach(function (k) { if (vals[k] === undefined) vals[k] = 0; });
  z1.forEach(function (k) { if (vals[k] === undefined) vals[k] = 1; });
  if (is2D === undefined) is2D = z0.every(function (k) { return vals[k] === 0; }) && z1.every(function (k) { return vals[k] === 1; });
  var m = [vals.m11, vals.m12, vals.m13, vals.m14, vals.m21, vals.m22, vals.m23, vals.m24, vals.m31, vals.m32, vals.m33, vals.m34, vals.m41, vals.m42, vals.m43, vals.m44];
  return [m, is2D];
};

class DOMMatrix extends DOMMatrixReadOnly {
  static fromMatrix(other) { var r = __jb.geoFixup(other); var o = new DOMMatrix(); var g = __geo.slot(o); g.m = r[0]; g.is2D = r[1]; return o; }
  static fromFloat32Array(a) { if (!(a instanceof Float32Array)) throw new TypeError("Float32Array required"); if (a.length !== 6 && a.length !== 16) throw new TypeError("6 or 16 elements required"); return new DOMMatrix(__jb.arrayFrom(a)); }
  static fromFloat64Array(a) { if (!(a instanceof Float64Array)) throw new TypeError("Float64Array required"); if (a.length !== 6 && a.length !== 16) throw new TypeError("6 or 16 elements required"); return new DOMMatrix(__jb.arrayFrom(a)); }
  multiplySelf(other) { var r = __jb.geoFixup(other), g = __geo.slot(this); g.m = __geo.mul(g.m, r[0]); if (!r[1]) g.is2D = false; return this; }
  preMultiplySelf(other) { var r = __jb.geoFixup(other), g = __geo.slot(this); g.m = __geo.mul(r[0], g.m); if (!r[1]) g.is2D = false; return this; }
  translateSelf(tx, ty, tz) {
    tx = tx === undefined ? 0 : +tx; ty = ty === undefined ? 0 : +ty; tz = tz === undefined ? 0 : +tz;
    var g = __geo.slot(this);
    g.m = __geo.mul(g.m, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1]);
    if (tz !== 0) g.is2D = false;
    return this;
  }
  scaleSelf(sx, sy, sz, ox, oy, oz) {
    sx = sx === undefined ? 1 : +sx; sy = sy === undefined ? sx : +sy; sz = sz === undefined ? 1 : +sz;
    ox = ox === undefined ? 0 : +ox; oy = oy === undefined ? 0 : +oy; oz = oz === undefined ? 0 : +oz;
    this.translateSelf(ox, oy, oz);
    var g = __geo.slot(this);
    g.m = __geo.mul(g.m, [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]);
    this.translateSelf(-ox, -oy, -oz);
    if (sz !== 1 || oz !== 0) g.is2D = false;
    return this;
  }
  scale3dSelf(s, ox, oy, oz) {
    s = s === undefined ? 1 : +s; ox = ox === undefined ? 0 : +ox; oy = oy === undefined ? 0 : +oy; oz = oz === undefined ? 0 : +oz;
    this.translateSelf(ox, oy, oz);
    var g = __geo.slot(this);
    g.m = __geo.mul(g.m, [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);
    this.translateSelf(-ox, -oy, -oz);
    if (s !== 1) g.is2D = false;
    return this;
  }
  rotateSelf(rx, ry, rz) {
    rx = rx === undefined ? 0 : +rx;
    if (ry === undefined && rz === undefined) { rz = rx; rx = 0; ry = 0; }
    ry = ry === undefined ? 0 : +ry; rz = rz === undefined ? 0 : +rz;
    var g = __geo.slot(this);
    if (rx !== 0 || ry !== 0) g.is2D = false;
    if (rz) this.rotateAxisAngleSelf(0, 0, 1, rz);
    if (ry) this.rotateAxisAngleSelf(0, 1, 0, ry);
    if (rx) this.rotateAxisAngleSelf(1, 0, 0, rx);
    return this;
  }
  rotateFromVectorSelf(x, y) {
    x = x === undefined ? 0 : +x; y = y === undefined ? 0 : +y;
    var angle = x === 0 && y === 0 ? 0 : Math.atan2(y, x) * 180 / Math.PI;
    return this.rotateAxisAngleSelf(0, 0, 1, angle);
  }
  rotateAxisAngleSelf(x, y, z, angle) {
    x = x === undefined ? 0 : +x; y = y === undefined ? 0 : +y; z = z === undefined ? 0 : +z; angle = angle === undefined ? 0 : +angle;
    var g = __geo.slot(this);
    if (x !== 0 || y !== 0) g.is2D = false;
    var len = Math.sqrt(x * x + y * y + z * z);
    if (len === 0) return this;
    x /= len; y /= len; z /= len;
    var a = angle * Math.PI / 180, R;
    if (x === 0 && y === 0) {
      var c = Math.cos(a), s = Math.sin(a) * (z < 0 ? -1 : 1);
      R = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    } else {
      var sc = Math.sin(a / 2) * Math.cos(a / 2), sq = Math.pow(Math.sin(a / 2), 2);
      R = [
        1 - 2 * (y * y + z * z) * sq, 2 * (x * y * sq + z * sc), 2 * (x * z * sq - y * sc), 0,
        2 * (x * y * sq - z * sc), 1 - 2 * (x * x + z * z) * sq, 2 * (y * z * sq + x * sc), 0,
        2 * (x * z * sq + y * sc), 2 * (y * z * sq - x * sc), 1 - 2 * (x * x + y * y) * sq, 0,
        0, 0, 0, 1,
      ];
    }
    g.m = __geo.mul(g.m, R);
    return this;
  }
  skewXSelf(sx) { sx = sx === undefined ? 0 : +sx; var g = __geo.slot(this); g.m = __geo.mul(g.m, [1, 0, 0, 0, Math.tan(sx * Math.PI / 180), 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); return this; }
  skewYSelf(sy) { sy = sy === undefined ? 0 : +sy; var g = __geo.slot(this); g.m = __geo.mul(g.m, [1, Math.tan(sy * Math.PI / 180), 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); return this; }
  invertSelf() {
    var g = __geo.slot(this), m = g.m;
    var inv = new Array(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    var det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (det === 0 || !isFinite(det)) { g.m = m.map(function () { return NaN; }); g.is2D = false; return this; }
    g.m = inv.map(function (v) { return v / det; });
    if (g.is2D) { var k = g.m; k[2] = k[3] = k[6] = k[7] = k[8] = k[9] = k[11] = k[14] = 0; k[10] = k[15] = 1; }
    return this;
  }
  setMatrixValue(text) {
    var r = __jb.geoParseTransform(String(text)), g = __geo.slot(this);
    g.m = r[0]; g.is2D = r[1];
    return this;
  }
}
__jb.geoSetters(DOMMatrix);
[DOMPointReadOnly, DOMPoint, DOMRectReadOnly, DOMRect, DOMQuad, DOMMatrixReadOnly, DOMMatrix].forEach(function (C) {
  Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
});

// ---- GeometryUtils (getBoxQuads / convert*FromNode) over the layout boxes ----
(function () {
  var boxRect = function (node, box, transformed) {
    if (node && node.nodeType === 9) return { x: -(globalThis.scrollX || 0), y: -(globalThis.scrollY || 0), width: 0, height: 0 };
    var r;
    if (node && node.nodeType === 3) { var rg = __jb.currentDocument.createRange(); rg.selectNodeContents(node); r = rg.getBoundingClientRect(); }
    else r = !transformed && typeof __jb.untransformedClientRect === "function" ? __jb.untransformedClientRect(node) : node.getBoundingClientRect();
    var x = r.x, y = r.y, w = r.width, h = r.height;
    if (node.nodeType === 1 && box && box !== "border") {
      var cs = getComputedStyle(node), px = function (p) { return parseFloat(cs.getPropertyValue(p)) || 0; };
      var sides = function (pfx, sfx) { return [px(pfx + "-top" + sfx), px(pfx + "-right" + sfx), px(pfx + "-bottom" + sfx), px(pfx + "-left" + sfx)]; };
      var adj = function (s, sign) { x -= sign * s[3]; y -= sign * s[0]; w += sign * (s[1] + s[3]); h += sign * (s[0] + s[2]); };
      if (box === "margin") adj(sides("margin", ""), 1);
      if (box === "padding" || box === "content") adj(sides("border", "-width"), -1);
      if (box === "content") adj(sides("padding", ""), -1);
    }
    return { x: x, y: y, width: w, height: h };
  };
  var checkNode = function (n) { if (!n || typeof n !== "object" || typeof n.nodeType !== "number") throw new TypeError("GeometryNode required"); return n; };
  var opts = function (o) {
    o = o || {};
    var box = o.box === undefined ? "border" : String(o.box);
    if (!/^(margin|border|padding|content)$/.test(box)) throw new TypeError("Invalid CSSBoxType " + box);
    return { box: box, relativeTo: o.relativeTo || null, fromBox: o.fromBox === undefined ? "border" : String(o.fromBox), toBox: o.toBox === undefined ? "border" : String(o.toBox) };
  };
  var origin = function (node, box) { var r = boxRect(node, box); return { x: r.x, y: r.y }; };
  var methods = {
    getBoxQuads: function (options) {
      var o = opts(options);
      if (this.nodeType === 1 && typeof __jb.isRendered === "function" && !__jb.isRendered(this) && __jb.styleOf(this, "display") === "none") return [];
      var r = boxRect(this, o.box);
      var base = o.relativeTo ? origin(checkNode(o.relativeTo), "border") : { x: 0, y: 0 };
      return [DOMQuad.fromRect({ x: r.x - base.x, y: r.y - base.y, width: r.width, height: r.height })];
    },
    convertQuadFromNode: function (quad, from, options) {
      if (arguments.length < 2) throw new TypeError("convertQuadFromNode: 2 arguments required");
      var o = opts(options), q = DOMQuad.fromQuad(quad);
      var a = origin(checkNode(from), o.fromBox), b = origin(this, o.toBox), dx = a.x - b.x, dy = a.y - b.y;
      var mv = function (p) { return { x: p.x + dx, y: p.y + dy, z: p.z, w: p.w }; };
      return new DOMQuad(mv(q.p1), mv(q.p2), mv(q.p3), mv(q.p4));
    },
    convertRectFromNode: function (rect, from, options) {
      if (arguments.length < 2) throw new TypeError("convertRectFromNode: 2 arguments required");
      return methods.convertQuadFromNode.call(this, DOMQuad.fromRect(DOMRectReadOnly.fromRect(rect)), from, options);
    },
    convertPointFromNode: function (point, from, options) {
      if (arguments.length < 2) throw new TypeError("convertPointFromNode: 2 arguments required");
      var o = opts(options), p = DOMPoint.fromPoint(point);
      var a = origin(checkNode(from), o.fromBox), b = origin(this, o.toBox);
      return new DOMPoint(p.x + a.x - b.x, p.y + a.y - b.y, p.z, p.w);
    },
  };
  __jb.installGeometryUtils = function () {
    [typeof Element !== "undefined" && Element, typeof Text !== "undefined" && Text, typeof Document !== "undefined" && Document].forEach(function (C) {
      if (!C || !C.prototype) return;
      Object.keys(methods).forEach(function (k) { if (!Object.prototype.hasOwnProperty.call(C.prototype, k)) Object.defineProperty(C.prototype, k, { value: methods[k], writable: true, enumerable: true, configurable: true }); });
    });
  };
})();
__jb.installGeometryUtils();
