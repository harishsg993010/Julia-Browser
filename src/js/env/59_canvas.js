// Part 5e: Canvas 2D (HTML "the 2D rendering context"). The context keeps the
// drawing state and the current default path in device space here; drawing
// operations are queued as device-space commands and flushed in batches to
// the host's rasterizer (`canvas` op, src/canvas.rs) whenever pixels are read
// (getImageData, toDataURL, drawImage of this canvas, ...).
(function () {
  // ------------------------------------------------------------ CSS colors
  var NAMED = "aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32".split(" ");
  var named = Object.create(null);
  for (var ni = 0; ni < NAMED.length; ni += 2) named[NAMED[ni]] = NAMED[ni + 1];
  var SYSTEM = { canvas: "ffffff", canvastext: "000000", linktext: "0000ee", visitedtext: "551a8b", activetext: "ff0000", buttonface: "efefef", buttontext: "000000", buttonborder: "767676", field: "ffffff", fieldtext: "000000", highlight: "3399ff", highlighttext: "ffffff", selecteditem: "3399ff", selecteditemtext: "ffffff", mark: "ffff00", marktext: "000000", graytext: "808080", accentcolor: "3399ff", accentcolortext: "ffffff",
    // deprecated system colors (CSS Color 4 maps them to the values above)
    activeborder: "767676", activecaption: "ffffff", appworkspace: "ffffff", background: "ffffff", buttonhighlight: "767676", buttonshadow: "767676", captiontext: "000000", inactiveborder: "767676", inactivecaption: "ffffff", inactivecaptiontext: "808080", infobackground: "ffffff", infotext: "000000", menu: "ffffff", menutext: "000000", scrollbar: "ffffff", threeddarkshadow: "767676", threedface: "efefef", threedhighlight: "767676", threedlightshadow: "767676", threedshadow: "767676", window: "ffffff", windowframe: "767676", windowtext: "000000" };
  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
  var hex2 = function (h) { return parseInt(h, 16); };
  function fromHex(h) {
    if (!/^[0-9a-f]+$/i.test(h)) return null;
    if (h.length === 3 || h.length === 4) return [hex2(h[0] + h[0]), hex2(h[1] + h[1]), hex2(h[2] + h[2]), h.length === 4 ? hex2(h[3] + h[3]) / 255 : 1];
    if (h.length === 6 || h.length === 8) return [hex2(h.slice(0, 2)), hex2(h.slice(2, 4)), hex2(h.slice(4, 6)), h.length === 8 ? hex2(h.slice(6, 8)) / 255 : 1];
    return null;
  }
  var NUM = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?";
  function parseComponent(s, pct, max) {
    s = s.trim();
    if (s === "none") return 0;
    var m = new RegExp("^(" + NUM + ")(%?)$", "i").exec(s);
    if (!m) return null;
    var v = parseFloat(m[1]);
    if (m[2]) { if (!pct) return null; return v / 100 * max; }
    return v;
  }
  function parseAlpha(s) {
    if (s === undefined) return 1;
    var m = new RegExp("^(" + NUM + ")(%?)$", "i").exec(s.trim());
    if (!m) return null;
    var v = parseFloat(m[1]); if (m[2]) v /= 100;
    return clamp(v, 0, 1);
  }
  function splitArgs(inner) {
    inner = inner.trim();
    var alpha;
    if (inner.indexOf(",") >= 0) {
      var parts = inner.split(",").map(function (p) { return p.trim(); });
      if (parts.length === 4) alpha = parts.pop();
      if (parts.length !== 3 || parts.some(function (p) { return p === "" || /\s/.test(p); })) return null;
      return { c: parts, a: alpha, legacy: true };
    }
    var slash = inner.split("/");
    if (slash.length > 2) return null;
    if (slash.length === 2) alpha = slash[1].trim();
    var comps = slash[0].trim().split(/\s+/);
    if (comps.length !== 3) return null;
    return { c: comps, a: alpha, legacy: false };
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360; s = clamp(s, 0, 1); l = clamp(l, 0, 1);
    var f = function (n) { var k = (n + h / 30) % 12; var a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  }
  // [r, g, b, a] (0-255, 0-1) or null; "currentcolor" yields the string itself.

  // ---- CSS Color 4 spaces, converted to sRGB (out-of-gamut values are clipped)
  var mat3 = function (m, v) { return [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]]; };
  var sgnPow = function (c, e) { return (c < 0 ? -1 : 1) * Math.pow(Math.abs(c), e); };
  var srgbLin = function (c) { var a = Math.abs(c); return a <= 0.04045 ? c / 12.92 : (c < 0 ? -1 : 1) * Math.pow((a + 0.055) / 1.055, 2.4); };
  var srgbGam = function (c) { var a = Math.abs(c); return a <= 0.0031308 ? 12.92 * c : (c < 0 ? -1 : 1) * (1.055 * Math.pow(a, 1 / 2.4) - 0.055); };
  var XYZ_TO_LSRGB = [[3.2409699419045226, -1.537383177570094, -0.4986107602930034], [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559], [0.05563007969699366, -0.20397695888897652, 1.0569715142428786]];
  var D50_TO_D65 = [[0.955473421488075, -0.02309845494876471, 0.06325924320057072], [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323], [0.012314014864481998, -0.020507649298898964, 1.330365926242124]];
  var SPACES = {
    "srgb": { lin: srgbLin, m: null },
    "srgb-linear": { lin: function (c) { return c; }, m: null },
    "display-p3": { lin: srgbLin, m: [[0.4865709486482162, 0.26566769316909306, 0.1982172852343625], [0.2289745640697488, 0.6917385218365064, 0.079286914093745], [0, 0.04511338185890264, 1.043944368900976]] },
    "rec2020": { lin: function (c) { var a = 1.09929682680944, b = 0.018053968510807, x = Math.abs(c); return (c < 0 ? -1 : 1) * (x < b * 4.5 ? x / 4.5 : Math.pow((x + a - 1) / a, 1 / 0.45)); }, m: [[0.6369580483012914, 0.14461690358620832, 0.1688809751641721], [0.2627002120112671, 0.6779980715188708, 0.05930171646986196], [0, 0.028072693049087428, 1.060985057710791]] },
    "a98-rgb": { lin: function (c) { return sgnPow(c, 563 / 256); }, m: [[0.5766690429101305, 0.1855582379065463, 0.1882286462349947], [0.29734497525053605, 0.6273635662554661, 0.07529145849399788], [0.02703136138641234, 0.07068885253582723, 0.9913375368376388]] },
    "prophoto-rgb": { lin: function (c) { var x = Math.abs(c); return x <= 16 / 512 ? c / 16 : sgnPow(c, 1.8); }, m: [[0.7977604896723027, 0.13518583717574031, 0.0313493495815248], [0.2880711282292934, 0.7118432178101014, 0.00008565396060525902], [0, 0, 0.8251046025104601]], d50: true },
    "xyz": { xyz: true }, "xyz-d65": { xyz: true }, "xyz-d50": { xyz: true, d50: true },
  };
  var xyzToRgb255 = function (xyz, d50) {
    if (d50) xyz = mat3(D50_TO_D65, xyz);
    return mat3(XYZ_TO_LSRGB, xyz).map(function (c) { return clamp(Math.round(clamp(srgbGam(c), 0, 1) * 255), 0, 255); });
  };
  var labToXyzD50 = function (L, a, b) {
    var k = 24389 / 27, e = 216 / 24389, f1 = (L + 16) / 116, f0 = a / 500 + f1, f2 = f1 - b / 200;
    var x = Math.pow(f0, 3) > e ? Math.pow(f0, 3) : (116 * f0 - 16) / k, y = L > k * e ? Math.pow(f1, 3) : L / k, z = Math.pow(f2, 3) > e ? Math.pow(f2, 3) : (116 * f2 - 16) / k;
    return [x * 0.9642956764295677, y, z * 0.8251046025104602];
  };
  var oklabToXyz = function (L, a, b) {
    var lms = mat3([[1, 0.3963377773761749, 0.2158037573099136], [1, -0.1055613458156586, -0.0638541728258133], [1, -0.0894841775298119, -1.2914855480194092]], [L, a, b]).map(function (c) { return c * c * c; });
    return mat3([[1.2268798758459243, -0.5578149944602171, 0.2813910456659647], [-0.0405757452148008, 1.1122868032803170, -0.0717110580655164], [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816]], lms);
  };
  // value with optional % (pctScale = value of 100%); "none" is 0
  var compNum = function (t, pctScale) { t = t.trim(); if (t === "none") return 0; var m = new RegExp("^(" + NUM + ")(%?)$", "i").exec(t); if (!m) return null; var v = parseFloat(m[1]); return m[2] ? v / 100 * pctScale : v; };
  var hueNum = function (t) { t = t.trim(); if (t === "none") return 0; var m = new RegExp("^(" + NUM + ")(deg|rad|grad|turn)?$", "i").exec(t); return m ? parseFloat(m[1]) * ({ rad: 180 / Math.PI, grad: 0.9, turn: 360 }[m[2]] || 1) : null; };
  var parseModernColor = function (s) {
    var m = /^(color|lab|lch|oklab|oklch)\((.*)\)$/.exec(s);
    if (!m) return undefined;
    var inner = m[2].trim(), alphaPart, slash = inner.split("/");
    if (slash.length > 2) return null;
    if (slash.length === 2) alphaPart = slash[1].trim();
    var toks = slash[0].trim().split(/\s+/);
    var a = parseAlpha(alphaPart);
    if (a === null) return null;
    var rgb;
    if (m[1] === "color") {
      var spaceName = toks[0];
      var sp = SPACES[toks.shift()];
      if (!sp || toks.length !== 3) return null;
      var c = toks.map(function (t) { return compNum(t, 1); });
      if (c.some(function (v) { return v === null; })) return null;
      if (sp.xyz) rgb = xyzToRgb255(c, sp.d50);
      else if (!sp.m) rgb = (sp.lin === srgbLin ? c : c.map(srgbGam)).map(function (v) { return clamp(Math.round(clamp(v, 0, 1) * 255), 0, 255); });
      else rgb = xyzToRgb255(mat3(sp.m, c.map(sp.lin)), sp.d50);
      var num = function (t) { t = t.trim(); if (t === "none") return "none"; var v = compNum(t, 1); return String(Math.round(v * 1e6) / 1e6); };
      var css = "color(" + spaceName + " " + toks.map(num).join(" ") + (a !== 1 ? " / " + String(Math.round(a * 1e6) / 1e6) : "") + ")";
      var exact = [rgb[0], rgb[1], rgb[2], a];
      exact.css = css;
      if (sp === SPACES["display-p3"]) exact.p3 = c.map(function (v) { return clamp(Math.round(clamp(v, 0, 1) * 255), 0, 255); }).concat([a]);
      return exact;
    } else {
      if (toks.length !== 3) return null;
      var L, A, B, polar = m[1] === "lch" || m[1] === "oklch", ok = m[1].indexOf("ok") === 0;
      L = compNum(toks[0], ok ? 1 : 100);
      if (polar) { var C = compNum(toks[1], ok ? 0.4 : 150), H = hueNum(toks[2]); if (L === null || C === null || H === null) return null; C = Math.max(C, 0); A = C * Math.cos(H * Math.PI / 180); B = C * Math.sin(H * Math.PI / 180); }
      else { A = compNum(toks[1], ok ? 0.4 : 125); B = compNum(toks[2], ok ? 0.4 : 125); if (L === null || A === null || B === null) return null; }
      L = clamp(L, 0, ok ? 1 : 100);
      rgb = ok ? xyzToRgb255(oklabToXyz(L, A, B), false) : xyzToRgb255(labToXyzD50(L, A, B), true);
    }
    return [rgb[0], rgb[1], rgb[2], a];
  };
  // sRGB (0-255) -> Display P3 (0-255), for display-p3 canvases.
  var P3_FROM_XYZ = (function () {
    var m = [[0.48657095, 0.2656677, 0.19821729], [0.22897457, 0.69173852, 0.07928691], [0, 0.04511338, 1.04394437]];
    var a = m[0][0], b = m[0][1], c = m[0][2], d = m[1][0], e = m[1][1], f = m[1][2], g = m[2][0], h = m[2][1], i = m[2][2];
    var det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    return [[(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det], [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det], [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]];
  })();
  var SRGB_TO_XYZ65 = [[0.4123908, 0.3575843, 0.1804808], [0.2126390, 0.7151687, 0.0721923], [0.0193308, 0.1191948, 0.9505322]];
  __jb.srgbToP3 = function (rgba) {
    if (rgba.p3) return rgba.p3;
    var lin = [rgba[0], rgba[1], rgba[2]].map(function (v) { return srgbLin(v / 255); });
    var p = mat3(P3_FROM_XYZ, mat3(SRGB_TO_XYZ65, lin));
    return p.map(function (v) { return clamp(Math.round(clamp(srgbGam(v), 0, 1) * 255), 0, 255); }).concat([rgba[3]]);
  };
  __jb.parseCssColor = function (str) {
    var s = String(str).trim().toLowerCase();
    if (s === "transparent") return [0, 0, 0, 0];
    if (s === "currentcolor") return "currentcolor";
    if (named[s]) return fromHex(named[s]);
    if (SYSTEM[s]) return fromHex(SYSTEM[s]);
    if (s.charAt(0) === "#") return fromHex(s.slice(1));
    var modern = parseModernColor(s);
    if (modern !== undefined) return modern;
    var m = /^(rgba?|hsla?|hwb)\((.*)\)$/.exec(s);
    if (!m) return null;
    var args = splitArgs(m[2]);
    if (!args) return null;
    var a = parseAlpha(args.a);
    if (a === null) return null;
    if (m[1] === "rgb" || m[1] === "rgba") {
      var pcts = args.c.map(function (c) { return /%$/.test(c); });
      if (args.legacy && pcts.some(function (p) { return p !== pcts[0]; })) return null;
      var rgb = args.c.map(function (c) { return parseComponent(c, true, 255); });
      if (rgb.some(function (v) { return v === null; })) return null;
      return [clamp(Math.round(rgb[0]), 0, 255), clamp(Math.round(rgb[1]), 0, 255), clamp(Math.round(rgb[2]), 0, 255), a];
    }
    var hm = new RegExp("^(" + NUM + ")(deg|rad|grad|turn)?$", "i").exec(args.c[0].trim());
    var h = args.c[0].trim() === "none" ? 0 : hm ? parseFloat(hm[1]) * ({ rad: 180 / Math.PI, grad: 0.9, turn: 360 }[hm[2]] || 1) : null;
    if (h === null) return null;
    var p2 = parseComponent(args.c[1], true, 1), p3 = parseComponent(args.c[2], true, 1);
    if (p2 === null || p3 === null) return null;
    if (args.legacy && (!/%$/.test(args.c[1]) || !/%$/.test(args.c[2]))) return null;
    if (!/%$/.test(args.c[1])) p2 /= 100;
    if (!/%$/.test(args.c[2])) p3 /= 100;
    var out;
    if (m[1] === "hwb") {
      if (args.legacy) return null;
      var wsum = p2 + p3;
      if (wsum >= 1) { var gray = p2 / wsum * 255; out = [gray, gray, gray]; }
      else out = hslToRgb(h, 1, 0.5).map(function (c) { return c * (1 - p2 - p3) + p2 * 255; });
    } else out = hslToRgb(h, p2, p3);
    return [clamp(Math.round(out[0]), 0, 255), clamp(Math.round(out[1]), 0, 255), clamp(Math.round(out[2]), 0, 255), a];
  };
  // HTML "serialization of a color" for canvas: #rrggbb when opaque, else rgba().
  __jb.serializeCanvasColor = function (c) {
    if (c && c.css) return c.css;
    var h = function (v) { var t = v.toString(16); return t.length < 2 ? "0" + t : t; };
    if (c[3] === 1) return "#" + h(c[0]) + h(c[1]) + h(c[2]);
    var a8 = Math.round(c[3] * 255), alpha = String(c[3]);
    for (var d = 1; d <= 3; d++) { var cand = Math.round(c[3] * Math.pow(10, d)) / Math.pow(10, d); if (Math.round(cand * 255) === a8) { alpha = String(cand); break; } }
    if (c[3] === 0) alpha = "0";
    return "rgba(" + c[0] + ", " + c[1] + ", " + c[2] + ", " + alpha + ")";
  };

  // ------------------------------------------------------------ matrices
  // [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f
  var IDENT = [1, 0, 0, 1, 0, 0];
  function mul(m, n) { return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]; }
  function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  function invert(m) { var det = m[0] * m[3] - m[1] * m[2]; if (!det || !isFinite(det)) return null; return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]; }
  var finite = function () { for (var i = 0; i < arguments.length; i++) if (!isFinite(arguments[i])) return false; return true; };

  // ------------------------------------------------------------ paths
  // A path is a flat list of ops: [0,x,y] move, [1,x,y] line, [2,x1,y1,x2,y2,x,y] cubic,
  // [3,x1,y1,x,y] quad, [4] close; `cur` is the last point, `start` the subpath start.
  function PathBuilder() { this.ops = []; this.cur = null; this.start = null; this.needsMove = true; }
  PathBuilder.prototype.clone = function () { var p = new PathBuilder(); p.ops = this.ops.slice(); p.cur = this.cur; p.start = this.start; p.needsMove = this.needsMove; return p; };
  PathBuilder.prototype.moveTo = function (x, y) { this.ops.push(0, x, y); this.cur = [x, y]; this.start = [x, y]; this.needsMove = false; };
  PathBuilder.prototype.ensure = function (x, y) { if (this.needsMove || !this.cur) this.moveTo(x, y); };
  PathBuilder.prototype.lineTo = function (x, y) { if (this.needsMove || !this.cur) { this.moveTo(x, y); return; } this.ops.push(1, x, y); this.cur = [x, y]; };
  PathBuilder.prototype.cubicTo = function (x1, y1, x2, y2, x, y) { this.ensure(x1, y1); this.ops.push(2, x1, y1, x2, y2, x, y); this.cur = [x, y]; };
  PathBuilder.prototype.quadTo = function (x1, y1, x, y) { this.ensure(x1, y1); this.ops.push(3, x1, y1, x, y); this.cur = [x, y]; };
  PathBuilder.prototype.close = function () { if (this.needsMove || !this.cur) return; this.ops.push(4); this.cur = this.start ? this.start.slice() : this.cur; this.ops.push(0, this.cur[0], this.cur[1]); };
  // Ops mapped through matrix m (affine maps keep curve types).
  function transformOps(ops, m) {
    var out = [], i = 0;
    while (i < ops.length) {
      var op = ops[i], n = op === 0 || op === 1 ? 2 : op === 2 ? 6 : op === 3 ? 4 : 0;
      out.push(op);
      for (var k = 0; k < n; k += 2) { var p = apply(m, ops[i + 1 + k], ops[i + 2 + k]); out.push(p[0], p[1]); }
      i += 1 + n;
    }
    return out;
  }
  // Elliptical arc (center cx,cy radii rx,ry rotation rot, from a0 to a1) as cubics through matrix m.
  function arcOps(pb, m, cx, cy, rx, ry, rot, a0, a1, ccw) {
    var TAU = Math.PI * 2, sweep;
    if (!ccw && a1 - a0 >= TAU) sweep = TAU;
    else if (ccw && a0 - a1 >= TAU) sweep = -TAU;
    else {
      sweep = a1 - a0;
      if (!ccw) { sweep = sweep % TAU; if (sweep < 0) sweep += TAU; }
      else { sweep = sweep % TAU; if (sweep > 0) sweep -= TAU; }
    }
    var cosr = Math.cos(rot), sinr = Math.sin(rot);
    var pt = function (t) { var x = rx * Math.cos(t), y = ry * Math.sin(t); return apply(m, cx + x * cosr - y * sinr, cy + x * sinr + y * cosr); };
    var deriv = function (t) { var x = -rx * Math.sin(t), y = ry * Math.cos(t); return [x * cosr - y * sinr, x * sinr + y * cosr]; };
    var s = pt(a0);
    if (pb.needsMove || !pb.cur) pb.moveTo(s[0], s[1]); else pb.lineTo(s[0], s[1]);
    if (sweep === 0) return;
    var segs = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    var step = sweep / segs, k = 4 / 3 * Math.tan(step / 4);
    for (var i = 0; i < segs; i++) {
      var t0 = a0 + i * step, t1 = t0 + step;
      var d0 = deriv(t0), d1 = deriv(t1);
      var p0x = cx + rx * Math.cos(t0) * cosr - ry * Math.sin(t0) * sinr, p0y = cy + rx * Math.cos(t0) * sinr + ry * Math.sin(t0) * cosr;
      var p1x = cx + rx * Math.cos(t1) * cosr - ry * Math.sin(t1) * sinr, p1y = cy + rx * Math.cos(t1) * sinr + ry * Math.sin(t1) * cosr;
      var c1 = apply(m, p0x + k * d0[0], p0y + k * d0[1]), c2 = apply(m, p1x - k * d1[0], p1y - k * d1[1]), e = apply(m, p1x, p1y);
      pb.ops.push(2, c1[0], c1[1], c2[0], c2[1], e[0], e[1]); pb.cur = [e[0], e[1]];
    }
  }
  // Shared path API (CanvasPath mixin) over a PathBuilder and a matrix getter.
  function definePathMethods(proto, builder, matrix) {
    proto.closePath = function () { builder(this).close(); };
    proto.moveTo = function (x, y) { x = +x; y = +y; if (!finite(x, y)) return; var p = apply(matrix(this), x, y); builder(this).moveTo(p[0], p[1]); };
    proto.lineTo = function (x, y) { x = +x; y = +y; if (!finite(x, y)) return; var p = apply(matrix(this), x, y); builder(this).lineTo(p[0], p[1]); };
    proto.quadraticCurveTo = function (cpx, cpy, x, y) { cpx = +cpx; cpy = +cpy; x = +x; y = +y; if (!finite(cpx, cpy, x, y)) return; var m = matrix(this), c = apply(m, cpx, cpy), e = apply(m, x, y); builder(this).quadTo(c[0], c[1], e[0], e[1]); };
    proto.bezierCurveTo = function (c1x, c1y, c2x, c2y, x, y) { c1x = +c1x; c1y = +c1y; c2x = +c2x; c2y = +c2y; x = +x; y = +y; if (!finite(c1x, c1y, c2x, c2y, x, y)) return; var m = matrix(this), a = apply(m, c1x, c1y), b = apply(m, c2x, c2y), e = apply(m, x, y); builder(this).cubicTo(a[0], a[1], b[0], b[1], e[0], e[1]); };
    proto.arcTo = function (x1, y1, x2, y2, r) {
      x1 = +x1; y1 = +y1; x2 = +x2; y2 = +y2; r = +r;
      if (!finite(x1, y1, x2, y2, r)) return;
      if (r < 0) throw __jb.domError("IndexSizeError", "The radius provided (" + r + ") is negative.");
      var pb = builder(this), m = matrix(this), inv = invert(m);
      if (pb.needsMove || !pb.cur) { var q = apply(m, x1, y1); pb.moveTo(q[0], q[1]); }
      var p0 = inv ? apply(inv, pb.cur[0], pb.cur[1]) : [x1, y1];
      var x0 = p0[0], y0 = p0[1];
      var lineTo = function (x, y) { var p = apply(m, x, y); pb.lineTo(p[0], p[1]); };
      if ((x0 === x1 && y0 === y1) || (x1 === x2 && y1 === y2) || r === 0) { lineTo(x1, y1); return; }
      var dx0 = x0 - x1, dy0 = y0 - y1, dx2 = x2 - x1, dy2 = y2 - y1;
      var cross = dx0 * dy2 - dy0 * dx2;
      if (Math.abs(cross) < 1e-10) { lineTo(x1, y1); return; }
      var l0 = Math.hypot(dx0, dy0), l2 = Math.hypot(dx2, dy2);
      var cosA = (dx0 * dx2 + dy0 * dy2) / (l0 * l2), angle = Math.acos(clamp(cosA, -1, 1));
      var dist = r / Math.tan(angle / 2);
      var t0x = x1 + dx0 / l0 * dist, t0y = y1 + dy0 / l0 * dist, t2x = x1 + dx2 / l2 * dist, t2y = y1 + dy2 / l2 * dist;
      var bisx = dx0 / l0 + dx2 / l2, bisy = dy0 / l0 + dy2 / l2, bl = Math.hypot(bisx, bisy);
      var cd = Math.hypot(dist, r);
      var cx = x1 + bisx / bl * cd, cy = y1 + bisy / bl * cd;
      var a0 = Math.atan2(t0y - cy, t0x - cx), a1 = Math.atan2(t2y - cy, t2x - cx);
      lineTo(t0x, t0y);
      arcOps(pb, m, cx, cy, r, r, 0, a0, a1, cross > 0);
    };
    proto.arc = function (x, y, r, a0, a1, ccw) {
      x = +x; y = +y; r = +r; a0 = +a0; a1 = +a1;
      if (!finite(x, y, r, a0, a1)) return;
      if (r < 0) throw __jb.domError("IndexSizeError", "The radius provided (" + r + ") is negative.");
      arcOps(builder(this), matrix(this), x, y, r, r, 0, a0, a1, !!ccw);
    };
    proto.ellipse = function (x, y, rx, ry, rot, a0, a1, ccw) {
      x = +x; y = +y; rx = +rx; ry = +ry; rot = +rot; a0 = +a0; a1 = +a1;
      if (!finite(x, y, rx, ry, rot, a0, a1)) return;
      if (rx < 0 || ry < 0) throw __jb.domError("IndexSizeError", "The radius provided is negative.");
      arcOps(builder(this), matrix(this), x, y, rx, ry, rot, a0, a1, !!ccw);
    };
    proto.rect = function (x, y, w, h) {
      x = +x; y = +y; w = +w; h = +h;
      if (!finite(x, y, w, h)) return;
      var m = matrix(this), pb = builder(this), p = function (a, b) { return apply(m, a, b); };
      var a = p(x, y), b = p(x + w, y), c = p(x + w, y + h), d = p(x, y + h);
      pb.moveTo(a[0], a[1]); pb.lineTo(b[0], b[1]); pb.lineTo(c[0], c[1]); pb.lineTo(d[0], d[1]); pb.close();
    };
    proto.roundRect = function (x, y, w, h, radii) {
      x = +x; y = +y; w = +w; h = +h;
      if (!finite(x, y, w, h)) return;
      var list = radii === undefined ? [0] : (radii !== null && typeof radii === "object" && typeof radii[Symbol.iterator] === "function" ? __jb.arrayFrom(radii) : [radii]);
      if (list.length < 1 || list.length > 4) throw new RangeError("roundRect: " + list.length + " radii provided; between one and four are expected.");
      var norm = [];
      for (var i = 0; i < list.length; i++) {
        var rv = list[i], rx, ry;
        if (rv !== null && typeof rv === "object") { rx = +(rv.x === undefined ? 0 : rv.x); ry = +(rv.y === undefined ? 0 : rv.y); }
        else { rx = ry = +rv; }
        if (!finite(rx, ry)) return;
        if (rx < 0 || ry < 0) throw new RangeError("roundRect: radius is negative.");
        norm.push([rx, ry]);
      }
      var ul, ur, lr, ll;
      if (norm.length === 4) { ul = norm[0]; ur = norm[1]; lr = norm[2]; ll = norm[3]; }
      else if (norm.length === 3) { ul = norm[0]; ur = ll = norm[1]; lr = norm[2]; }
      else if (norm.length === 2) { ul = lr = norm[0]; ur = ll = norm[1]; }
      else { ul = ur = lr = ll = norm[0]; }
      // Negative widths/heights flip the corners.
      if (w < 0) { x += w; w = -w; var t = ul; ul = ur; ur = t; t = ll; ll = lr; lr = t; }
      if (h < 0) { y += h; h = -h; var t2 = ul; ul = ll; ll = t2; t2 = ur; ur = lr; lr = t2; }
      var scale = Math.min(1, w / (ul[0] + ur[0]) || 1, w / (ll[0] + lr[0]) || 1, h / (ul[1] + ll[1]) || 1, h / (ur[1] + lr[1]) || 1);
      [ul, ur, lr, ll] = [ul, ur, lr, ll].map(function (r) { return [r[0] * scale, r[1] * scale]; });
      var m = matrix(this), pb = builder(this), P = function (a, b) { return apply(m, a, b); };
      var s = P(x + ul[0], y); pb.moveTo(s[0], s[1]);
      var l = P(x + w - ur[0], y); pb.lineTo(l[0], l[1]);
      arcOps(pb, m, x + w - ur[0], y + ur[1], ur[0], ur[1], 0, -Math.PI / 2, 0, false);
      l = P(x + w, y + h - lr[1]); pb.lineTo(l[0], l[1]);
      arcOps(pb, m, x + w - lr[0], y + h - lr[1], lr[0], lr[1], 0, 0, Math.PI / 2, false);
      l = P(x + ll[0], y + h); pb.lineTo(l[0], l[1]);
      arcOps(pb, m, x + ll[0], y + h - ll[1], ll[0], ll[1], 0, Math.PI / 2, Math.PI, false);
      l = P(x, y + ul[1]); pb.lineTo(l[0], l[1]);
      arcOps(pb, m, x + ul[0], y + ul[1], ul[0], ul[1], 0, Math.PI, Math.PI * 1.5, false);
      pb.close();
    };
  }

  // SVG path data (Path2D constructor).
  function parseSvgPath(d, target) {
    var toks = String(d).match(/[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) || [];
    var i = 0, cmd = null, x = 0, y = 0, sx = 0, sy = 0, lcx = null, lcy = null, lqx = null, lqy = null;
    var isNum = function () { return i < toks.length && !/[A-Za-z]/.test(toks[i]); };
    var n = function () { return parseFloat(toks[i++]); };
    while (i < toks.length) {
      if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
      else if (cmd === null) return;
      var rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
      var ox = rel ? x : 0, oy = rel ? y : 0;
      if (C === "Z") { target.closePath(); x = sx; y = sy; lcx = lqx = null; continue; }
      if (!isNum()) return;
      if (C === "M") { x = ox + n(); y = oy + n(); target.moveTo(x, y); sx = x; sy = y; cmd = rel ? "l" : "L"; lcx = lqx = null; }
      else if (C === "L") { x = ox + n(); y = oy + n(); target.lineTo(x, y); lcx = lqx = null; }
      else if (C === "H") { x = ox + n(); target.lineTo(x, y); lcx = lqx = null; }
      else if (C === "V") { y = (rel ? y : 0) + n(); target.lineTo(x, y); lcx = lqx = null; }
      else if (C === "C") { var a1 = ox + n(), b1 = oy + n(), a2 = ox + n(), b2 = oy + n(); x = ox + n(); y = oy + n(); target.bezierCurveTo(a1, b1, a2, b2, x, y); lcx = a2; lcy = b2; lqx = null; }
      else if (C === "S") { var r1x = lcx === null ? x : 2 * x - lcx, r1y = lcx === null ? y : 2 * y - lcy, c2x = ox + n(), c2y = oy + n(); x = ox + n(); y = oy + n(); target.bezierCurveTo(r1x, r1y, c2x, c2y, x, y); lcx = c2x; lcy = c2y; lqx = null; }
      else if (C === "Q") { var qx = ox + n(), qy = oy + n(); x = ox + n(); y = oy + n(); target.quadraticCurveTo(qx, qy, x, y); lqx = qx; lqy = qy; lcx = null; }
      else if (C === "T") { var tx = lqx === null ? x : 2 * x - lqx, ty = lqx === null ? y : 2 * y - lqy; x = ox + n(); y = oy + n(); target.quadraticCurveTo(tx, ty, x, y); lqx = tx; lqy = ty; lcx = null; }
      else if (C === "A") {
        var rx = Math.abs(n()), ry = Math.abs(n()), phi = n() * Math.PI / 180, large = n() !== 0, sweep = n() !== 0, ex = ox + n(), ey = oy + n();
        if (rx === 0 || ry === 0) { target.lineTo(ex, ey); }
        else {
          var cp = Math.cos(phi), sp = Math.sin(phi), dx = (x - ex) / 2, dy = (y - ey) / 2;
          var x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
          var lam = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry); if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
          var num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p, den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
          var co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
          var cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
          var ccx = cp * cxp - sp * cyp + (x + ex) / 2, ccy = sp * cxp + cp * cyp + (y + ey) / 2;
          var ang = function (ux, uy, vx, vy) { return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); };
          var th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry), dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
          if (!sweep && dth > 0) dth -= 2 * Math.PI; else if (sweep && dth < 0) dth += 2 * Math.PI;
          target.ellipse(ccx, ccy, rx, ry, phi, th1, th1 + dth, !sweep);
        }
        x = ex; y = ey; lcx = lqx = null;
      }
      else return;
    }
  }

  class Path2D {
    constructor(arg) {
      Object.defineProperty(this, "_pb", { value: new PathBuilder() });
      if (arg instanceof Path2D) { var src = arg._pb.clone(); this._pb.ops = src.ops; this._pb.cur = src.cur; this._pb.start = src.start; this._pb.needsMove = src.needsMove; }
      else if (arg !== undefined) parseSvgPath(String(arg), this);
    }
    addPath(path, transform) {
      if (!(path instanceof Path2D)) throw new TypeError("Failed to execute 'addPath' on 'Path2D': parameter 1 is not of type 'Path2D'.");
      var m = IDENT;
      if (transform !== undefined && transform !== null) {
        var t = __jb.matrixFromInit(transform);
        m = [t.a, t.b, t.c, t.d, t.e, t.f];
        if (!finite.apply(null, m)) return;
      }
      var ops = transformOps(path._pb.ops, m);
      var pb = this._pb;
      for (var i = 0; i < ops.length; i++) pb.ops.push(ops[i]);
      if (path._pb.cur) { pb.cur = apply(m, path._pb.cur[0], path._pb.cur[1]); pb.start = path._pb.start ? apply(m, path._pb.start[0], path._pb.start[1]) : pb.cur; pb.needsMove = path._pb.needsMove; }
    }
  }
  definePathMethods(Path2D.prototype, function (p) { return p._pb; }, function () { return IDENT; });
  __jb.setTag(Path2D, "Path2D");

  // DOMMatrix2DInit / DOMMatrix -> {a..f}
  __jb.matrixFromInit = function (init) {
    if (init === undefined || init === null) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    if (typeof init !== "object") throw new TypeError("Failed to convert value to 'DOMMatrix2DInit'.");
    var pick = function (a, m, def) { var va = init[a], vm = init[m]; if (va !== undefined && vm !== undefined && !(Object.is(+va, +vm) || (+va !== +va && +vm !== +vm))) throw new TypeError("Inconsistent " + a + "/" + m); return va !== undefined ? +va : vm !== undefined ? +vm : def; };
    return { a: pick("a", "m11", 1), b: pick("b", "m12", 0), c: pick("c", "m21", 0), d: pick("d", "m22", 1), e: pick("e", "m41", 0), f: pick("f", "m42", 0) };
  };
  function makeDOMMatrix(m) {
    var dm = new DOMMatrix([m[0], m[1], m[2], m[3], m[4], m[5]]);
    try { dm.m11 = m[0]; dm.m12 = m[1]; dm.m21 = m[2]; dm.m22 = m[3]; dm.m41 = m[4]; dm.m42 = m[5]; dm.isIdentity = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0; } catch (e) {}
    return dm;
  }

  // ------------------------------------------------------------ styles
  class CanvasGradient {
    constructor() { if (!__jb.canvasConstructing) throw new TypeError("Illegal constructor"); }
    addColorStop(offset, color) {
      if (arguments.length < 2) throw new TypeError("Failed to execute 'addColorStop' on 'CanvasGradient': 2 arguments required.");
      offset = +offset;
      if (!isFinite(offset)) throw new TypeError("The provided double value is non-finite.");
      if (offset < 0 || offset > 1) throw __jb.domError("IndexSizeError", "The provided value (" + offset + ") is outside the range (0.0, 1.0).");
      var c = __jb.parseCssColor(color);
      if (c === "currentcolor") c = [0, 0, 0, 1];
      if (!c) throw __jb.domError("SyntaxError", "The value provided ('" + color + "') could not be parsed as a color.");
      // Stops with equal offsets keep insertion order.
      var stops = this._stops, i = stops.length;
      while (i > 0 && stops[i - 1][0] > offset) i--;
      stops.splice(i, 0, [offset, c[0], c[1], c[2], c[3]]);
    }
  }
  __jb.setTag(CanvasGradient, "CanvasGradient");
  class CanvasPattern {
    constructor() { if (!__jb.canvasConstructing) throw new TypeError("Illegal constructor"); }
    setTransform(transform) { var t = __jb.matrixFromInit(transform); var m = [t.a, t.b, t.c, t.d, t.e, t.f]; if (!finite.apply(null, m)) return; this._m = m; }
  }
  __jb.setTag(CanvasPattern, "CanvasPattern");
  var newInternal = function (C) { __jb.canvasConstructing = true; try { return new C(); } finally { __jb.canvasConstructing = false; } };

  class TextMetrics { constructor() { if (!__jb.canvasConstructing) throw new TypeError("Illegal constructor"); } }
  ["width", "actualBoundingBoxLeft", "actualBoundingBoxRight", "fontBoundingBoxAscent", "fontBoundingBoxDescent", "actualBoundingBoxAscent", "actualBoundingBoxDescent", "emHeightAscent", "emHeightDescent", "hangingBaseline", "alphabeticBaseline", "ideographicBaseline"].forEach(function (k) {
    Object.defineProperty(TextMetrics.prototype, k, { get: function () { return this._m[k] || 0; }, enumerable: true, configurable: true });
  });
  __jb.setTag(TextMetrics, "TextMetrics");

  // ------------------------------------------------------------ ImageData
  class ImageData {
    constructor(a, b, c, d) {
      if (arguments.length < 2) throw new TypeError("Failed to construct 'ImageData': 2 arguments required.");
      var data, w, h, settings;
      if (a instanceof Uint8ClampedArray || (a && typeof a === "object" && Object.prototype.toString.call(a) === "[object Uint8ClampedArray]")) {
        data = a; w = b >>> 0; settings = d;
        if (data.length === 0 || data.length % 4 !== 0) throw __jb.domError("InvalidStateError", "The input data has zero elements or a length that is not a multiple of 4.");
        if (w === 0) throw __jb.domError("IndexSizeError", "The source width is zero or not a number.");
        var px = data.length / 4;
        if (px % w !== 0) throw __jb.domError("IndexSizeError", "The input data length is not a multiple of (4 * width).");
        h = px / w;
        if (c !== undefined && (c >>> 0) !== h) throw __jb.domError("IndexSizeError", "The input data length is not equal to (4 * width * height).");
      } else {
        if (a !== null && typeof a === "object") throw new TypeError("Failed to construct 'ImageData': parameter 1 is not of type 'Uint8ClampedArray'.");
        w = +a; h = +b; settings = c;
        if (!isFinite(w) || !isFinite(h)) throw new TypeError("Failed to construct 'ImageData': The provided value is non-finite.");
        w = Math.trunc(w) >>> 0; h = Math.trunc(h) >>> 0;
        if (w === 0) throw __jb.domError("IndexSizeError", "The source width is 0.");
        if (h === 0) throw __jb.domError("IndexSizeError", "The source height is 0.");
        if (w * h * 4 > 0x7fffffff) throw new RangeError("Out of memory at ImageData creation");
        data = new Uint8ClampedArray(w * h * 4);
      }
      var cs = settings && settings.colorSpace !== undefined ? String(settings.colorSpace) : "srgb";
      if (cs !== "srgb" && cs !== "display-p3") throw new TypeError("The provided value '" + cs + "' is not a valid enum value of type PredefinedColorSpace.");
      Object.defineProperty(this, "_w", { value: w }); Object.defineProperty(this, "_h", { value: h });
      Object.defineProperty(this, "_data", { value: data }); Object.defineProperty(this, "_cs", { value: cs });
    }
    get width() { return this._w; }
    get height() { return this._h; }
    get data() { return this._data; }
    get colorSpace() { return this._cs; }
    get pixelFormat() { return "rgba-unorm8"; }
  }
  __jb.setTag(ImageData, "ImageData");
  var b64 = function (u8) { return __jb.bytesToB64(u8); };

  // ------------------------------------------------------------ the context
  var COMPOSITES = /^(clear|source-over|source-in|source-out|source-atop|destination-over|destination-in|destination-out|destination-atop|lighter|copy|xor|multiply|screen|overlay|darken|lighten|color-dodge|color-burn|hard-light|soft-light|difference|exclusion|hue|saturation|color|luminosity)$/;
  function defaultState() {
    return { m: IDENT.slice(), fill: { color: [0, 0, 0, 1] }, stroke: { color: [0, 0, 0, 1] }, alpha: 1, comp: "source-over", lineWidth: 1, lineCap: "butt", lineJoin: "miter", miterLimit: 10, dash: [], dashOffset: 0, shadowBlur: 0, shadowColor: [0, 0, 0, 0], shadowOffsetX: 0, shadowOffsetY: 0, font: "10px sans-serif", textAlign: "start", textBaseline: "alphabetic", direction: "inherit", letterSpacing: "0px", wordSpacing: "0px", fontKerning: "auto", fontStretch: "normal", fontVariantCaps: "normal", textRendering: "auto", smoothing: true, smoothingQuality: "low", filter: "none", clip: [] };
  }
  function cloneState(s) { var o = Object.assign({}, s); o.m = s.m.slice(); o.dash = s.dash.slice(); o.clip = s.clip.slice(); return o; }
  var canvasSeq = 0;
  __jb.canvasId = function (canvas) {
    if (!canvas._canvasId) Object.defineProperty(canvas, "_canvasId", { value: "c" + (++canvasSeq) + "-" + Math.random().toString(36).slice(2), writable: true });
    return canvas._canvasId;
  };
  __jb.canvasSize = function (canvas) {
    if (canvas._tag === "canvas") { var w = __jb.parseHtmlNonneg(canvas.getAttribute("width") || ""), h = __jb.parseHtmlNonneg(canvas.getAttribute("height") || ""); return [w === null ? 300 : w, h === null ? 150 : h]; }
    return [canvas._width >>> 0, canvas._height >>> 0];
  };
  __jb.canvasAvailable = function () { return __jb.canvasHostOk !== false; };
  // Send queued commands of `canvas` to the rasterizer.
  __jb.flushCanvas = function (canvas) {
    var ctx = canvas && canvas._ctx2d;
    if (!ctx || !ctx._queue.length) return;
    var size = __jb.canvasSize(canvas);
    var cmds = ctx._queue.splice(0);
    if (!size[0] || !size[1]) return;
    var r = __jb.native("canvas", { op: "draw", id: __jb.canvasId(canvas), w: size[0], h: size[1], cmds: cmds });
    if (r && r.unavailable) __jb.canvasHostOk = false;
  };
  // Layout mirror (real pages): CSS declarations that paint a drawn canvas's bitmap as its content
  // box background, or null. The layout loader answers the URL from the canvas store (blitz.rs).
  __jb.canvasLayoutPaint = function (canvas) {
    if (!canvas._canvasId || __jb.wptMode || __jb.canvasHostOk === false) return null;
    try {
      __jb.flushCanvas(canvas);
      var r = __jb.native("canvas", { op: "version", id: canvas._canvasId });
      if (!r || !r.inked) return null;
      return "background-image:url(https://jb-canvas.invalid/" + canvas._canvasId + "/" + r.v + ".png)!important;background-size:100% 100%!important;background-repeat:no-repeat!important;background-origin:content-box!important;background-position:0 0!important";
    } catch (e) { return null; }
  };
  __jb.resetCanvasBitmap = function (canvas) {
    var ctx = canvas._ctx2d;
    if (ctx) { ctx._queue.length = 0; ctx._reset(); }
    var size = __jb.canvasSize(canvas);
    if (canvas._canvasId) __jb.native("canvas", { op: "reset", id: canvas._canvasId, w: size[0], h: size[1] });
  };
  // Image sources for drawImage/createPattern: {src, w, h} or null (nothing to draw); throws per spec.
  // "origin-clean": an image or video from another origin loaded without CORS (no crossorigin
  // attribute) is not; neither is a tainted canvas or a bitmap made from such sources.
  __jb.imageSourceTainted = function (img) {
    if (!img || typeof img !== "object") return false;
    if (img._originTainted) return true;
    // an image a service worker answered: tainted unless the response is CORS-same-origin
    if (img._swImage) return !/^(basic|cors|default)$/.test(img._swImage.type || "basic");
    if (img._swMedia) return !/^(basic|cors|default)$/.test(img._swMedia.type || "basic");
    var el = img.nodeType === 1 ? img : null;
    if (!el || !/^(img|video|image)$/.test(el._local)) return false;
    if (el.hasAttribute && el.hasAttribute("crossorigin")) return false;
    var u = el._local === "video" ? (el.currentSrc || el.getAttribute("src")) : (el.currentSrc || el.getAttribute("src") || el.getAttribute("href") || (el.getAttributeNS && el.getAttributeNS("http://www.w3.org/1999/xlink", "href")));
    if (!u) return false;
    try {
      var abs = new URL(u, el.baseURI || __jb.currentDocument.baseURI);
      if (abs.protocol === "data:" || abs.protocol === "blob:") return false;
      return abs.origin !== new URL(__jb.currentDocument.URL).origin;
    } catch (e) { return false; }
  };
  __jb.canvasImageSource = function (img, forPattern) {
    if (img === null || typeof img !== "object") throw new TypeError("The provided value is not of type '(CSSImageValue or HTMLCanvasElement or HTMLImageElement or HTMLVideoElement or ImageBitmap or OffscreenCanvas or SVGImageElement or VideoFrame)'.");
    if (img._tag === "canvas" || img instanceof OffscreenCanvas) {
      var sz = __jb.canvasSize(img);
      if (!sz[0] || !sz[1]) throw __jb.domError("InvalidStateError", "The image argument is a canvas element with a width or height of 0.");
      __jb.flushCanvas(img);
      // pixels are in the source canvas' color space; the renderer converts to the destination's
      return { src: { canvas: __jb.canvasId(img), srcSpace: __jb.canvasSpaceOf(img), dstSpace: __jb.currentCanvasSpace || "srgb" }, w: sz[0], h: sz[1] };
    }
    if (img instanceof ImageBitmap || Object.prototype.toString.call(img) === "[object ImageBitmap]") {
      if (img._closed) throw __jb.domError("InvalidStateError", "The image source is detached.");
      if (!img._src) return null;
      var chosen = __jb.currentCanvasSpace === "display-p3" && img._srcP3 ? img._srcP3 : img._src;
      if (chosen.srcSpace) chosen = Object.assign({}, chosen, { dstSpace: __jb.currentCanvasSpace || "srgb" });
      return { src: chosen, w: img.width, h: img.height };
    }
    if (img._ns === __jb.SVG_NS && img._local === "image") {
      // SVG <image>: usable once its resource loaded (see __jb.svgImageLoad).
      var sres = img._svgImage;
      if (!sres || sres.state === "loading") return null;
      if (sres.state === "broken") throw __jb.domError("InvalidStateError", "The SVGImageElement provided is in the 'broken' state.");
      var sr = __jb.native("canvas", { op: "loadImage", url: sres.url, space: __jb.currentCanvasSpace || "srgb" });
      if (sr && sr.ok) return { src: { url: sres.url, space: __jb.currentCanvasSpace || "srgb" }, w: sr.width, h: sr.height };
      return { src: { rgba: "", w: sres.width, h: sres.height }, w: sres.width, h: sres.height };
    }
    if (img._tag === "img" || img._tag === "image" || (typeof SVGImageElement === "function" && img instanceof SVGImageElement)) {
      var st = typeof __jb.imageState === "function" ? __jb.imageState(img) : null;
      var url = img.currentSrc || (img.getAttribute && (img.getAttribute("src") || img.getAttribute("href"))) || "";
      if (st && st.state === "broken") throw __jb.domError("InvalidStateError", "The HTMLImageElement provided is in the 'broken' state.");
      if (!img.complete || !url) return null;
      // An <img> whose src was emptied or removed (and no srcset) has nothing to draw.
      if (img._tag === "img" && !img.hasAttribute("srcset") && !img.getAttribute("src")) return null;
      if (st && !/^completely[ -]available$/.test(st.state)) { if (st.state === "broken") throw __jb.domError("InvalidStateError", "The HTMLImageElement provided is in the 'broken' state."); return null; }
      try { url = new URL(url, img.baseURI || __jb.currentDocument.baseURI).href; } catch (e) {}
      var space = __jb.currentCanvasSpace || "srgb", orient = __jb.currentImageOrient !== false;
      if (/^blob:/i.test(url) && typeof __jb.hostImageUrl === "function") url = __jb.hostImageUrl(url);
      if (img._swImage && img._swImage.dataUrl) url = img._swImage.dataUrl; // the service worker's response
      var r = __jb.native("canvas", { op: "loadImage", url: url, space: space, orient: orient });
      if (!r || !r.ok) {
        // Decodable size but no raster (vector images): a transparent image of the intrinsic size.
        if (img.naturalWidth && img.naturalHeight) return { src: { rgba: "", w: img.naturalWidth, h: img.naturalHeight }, w: img.naturalWidth, h: img.naturalHeight };
        return null;
      }
      // raw (EXIF-unrotated) pixels have the decoder's size; otherwise the natural (oriented) size
      var w = orient ? (img.naturalWidth || r.width || 0) : (r.width || 0), h = orient ? (img.naturalHeight || r.height || 0) : (r.height || 0);
      if (!w || !h) return null;
      return { src: { url: url, space: space, orient: orient }, w: r.width || w, h: r.height || h, iw: w, ih: h };
    }
    if (img._tag === "video") return null;
    if (img instanceof ImageData && !forPattern) throw new TypeError("ImageData is not a valid image source.");
    throw new TypeError("The provided value is not of type '(CSSImageValue or HTMLCanvasElement or HTMLImageElement or HTMLVideoElement or ImageBitmap or OffscreenCanvas or SVGImageElement or VideoFrame)'.");
  };

  function Ctx2D() { throw new TypeError("Illegal constructor"); }
  var P = Ctx2D.prototype;
  P._reset = function () { this._state = defaultState(); this._stack = []; this._path = new PathBuilder(); };
  P._paintOf = function (style) {
    if (style.pattern && style.pattern._tainted) this._canvas._originTainted = true;
    var p3 = this._attrs && this._attrs.colorSpace === "display-p3";
    if (style.color) return { k: "c", rgba: p3 ? __jb.srgbToP3(style.color) : style.color };
    if (style.gradient) {
      var g = style.gradient, p = Object.assign({ stops: p3 ? g._stops.map(function (st) { var c = __jb.srgbToP3([st[1], st[2], st[3], st[4]].map(Number)); return [st[0], c[0], c[1], c[2], c[3]]; }) : g._stops, m: this._state.m }, g._def);
      return p;
    }
    if (style.pattern) {
      var pt = style.pattern;
      return { k: "pat", src: pt._src, rep: pt._rep, m: pt._m ? mul(this._state.m, pt._m) : this._state.m };
    }
    return { k: "c", rgba: [0, 0, 0, 1] };
  };
  P._emit = function (cmd) {
    var s = this._state;
    cmd.alpha = s.alpha; cmd.comp = s.comp; if (s.clip.length) cmd.clip = s.clip;
    this._queue.push(cmd);
    if (this._queue.length > 256) __jb.flushCanvas(this._canvas);
  };
  P._fillOps = function (ops, rule) { this._emit({ t: "fill", path: ops, rule: rule, paint: this._paintOf(this._state.fill) }); };
  P._strokeOps = function (deviceOps) {
    var s = this._state, inv = invert(s.m);
    if (!inv || !(s.lineWidth > 0)) return;
    this._emit({ t: "stroke", path: transformOps(deviceOps, inv), m: s.m, style: { w: s.lineWidth, cap: s.lineCap, join: s.lineJoin, miter: s.miterLimit, dash: s.dash, off: s.dashOffset }, paint: this._paintOf(s.stroke) });
  };
  P._rectOps = function (x, y, w, h) { var m = this._state.m, a = apply(m, x, y), b = apply(m, x + w, y), c = apply(m, x + w, y + h), d = apply(m, x, y + h); return [0, a[0], a[1], 1, b[0], b[1], 1, c[0], c[1], 1, d[0], d[1], 4]; };
  // State
  P.save = function () { this._stack.push(cloneState(this._state)); };
  P.restore = function () { if (this._stack.length) this._state = this._stack.pop(); };
  P.reset = function () { __jb.resetCanvasBitmap(this._canvas); };
  P.isContextLost = function () { return false; };
  P.getContextAttributes = function () { return { alpha: this._attrs.alpha, colorSpace: this._attrs.colorSpace, colorType: "unorm8", desynchronized: this._attrs.desynchronized, willReadFrequently: this._attrs.willReadFrequently, toneMapping: { mode: "standard" } }; };
  // Transforms
  P.scale = function (x, y) { x = +x; y = +y; if (!finite(x, y)) return; this._state.m = mul(this._state.m, [x, 0, 0, y, 0, 0]); };
  P.rotate = function (a) { a = +a; if (!finite(a)) return; var c = Math.cos(a), s = Math.sin(a); this._state.m = mul(this._state.m, [c, s, -s, c, 0, 0]); };
  P.translate = function (x, y) { x = +x; y = +y; if (!finite(x, y)) return; this._state.m = mul(this._state.m, [1, 0, 0, 1, x, y]); };
  P.transform = function (a, b, c, d, e, f) { var v = [+a, +b, +c, +d, +e, +f]; if (!finite.apply(null, v)) return; this._state.m = mul(this._state.m, v); };
  P.setTransform = function (a, b, c, d, e, f) {
    if (arguments.length <= 1) { var t = __jb.matrixFromInit(a); var v0 = [t.a, t.b, t.c, t.d, t.e, t.f]; if (!finite.apply(null, v0)) return; this._state.m = v0; return; }
    if (arguments.length < 6) throw new TypeError("Failed to execute 'setTransform': 6 arguments required.");
    var v = [+a, +b, +c, +d, +e, +f]; if (!finite.apply(null, v)) return; this._state.m = v;
  };
  P.getTransform = function () { return makeDOMMatrix(this._state.m); };
  P.resetTransform = function () { this._state.m = IDENT.slice(); };
  // Rects
  P.clearRect = function (x, y, w, h) { x = +x; y = +y; w = +w; h = +h; if (!finite(x, y, w, h) || !w || !h) return; this._queue.push({ t: "clear", path: this._rectOps(x, y, w, h), clip: this._state.clip.length ? this._state.clip : undefined }); };
  P.fillRect = function (x, y, w, h) { x = +x; y = +y; w = +w; h = +h; if (!finite(x, y, w, h) || !w || !h) return; this._fillOps(this._rectOps(x, y, w, h), "nonzero"); };
  P.strokeRect = function (x, y, w, h) {
    x = +x; y = +y; w = +w; h = +h; if (!finite(x, y, w, h)) return;
    if (!w && !h) return;
    this._strokeOps(this._rectOps(x, y, w, h));
  };
  // Paths
  P.beginPath = function () { this._path = new PathBuilder(); };
  definePathMethods(P, function (c) { return c._path; }, function (c) { return c._state.m; });
  var ruleOf = function (r) { if (r === undefined) return "nonzero"; r = String(r); if (r !== "nonzero" && r !== "evenodd") throw new TypeError("The provided value '" + r + "' is not a valid enum value of type CanvasFillRule."); return r; };
  P._pathArgs = function (args) {
    if (args[0] instanceof Path2D) return { ops: transformOps(args[0]._pb.ops, this._state.m), rule: ruleOf(args[1]), rest: Array.prototype.slice.call(args, 2) };
    if (args[0] !== undefined && args[0] !== null && typeof args[0] === "object") throw new TypeError("parameter 1 is not of type 'Path2D'.");
    return { ops: this._path.ops.slice(), rule: ruleOf(args[0]), rest: Array.prototype.slice.call(args, 1) };
  };
  P.fill = function () { var a = this._pathArgs(arguments); if (a.ops.length) this._fillOps(a.ops, a.rule); };
  P.stroke = function (path) { var ops = path instanceof Path2D ? transformOps(path._pb.ops, this._state.m) : this._path.ops.slice(); if (path !== undefined && !(path instanceof Path2D)) throw new TypeError("parameter 1 is not of type 'Path2D'."); if (ops.length) this._strokeOps(ops); };
  P.clip = function () {
    var a = this._pathArgs(arguments);
    this._state.clip = this._state.clip.concat([{ path: a.ops.length ? a.ops : [0, 0, 0], rule: a.rule }]);
  };
  // Winding number of point (x, y) for device-space ops (curves flattened).
  function flatten(ops) {
    var polys = [], cur = null, i = 0, last = [0, 0];
    while (i < ops.length) {
      var op = ops[i];
      if (op === 0) { cur = [[ops[i + 1], ops[i + 2]]]; polys.push(cur); last = [ops[i + 1], ops[i + 2]]; i += 3; }
      else if (op === 1) { if (!cur) { cur = [last.slice()]; polys.push(cur); } cur.push([ops[i + 1], ops[i + 2]]); last = [ops[i + 1], ops[i + 2]]; i += 3; }
      else if (op === 2 || op === 3) {
        if (!cur) { cur = [last.slice()]; polys.push(cur); }
        var p0 = last, N = 16;
        for (var k = 1; k <= N; k++) {
          var t = k / N, u = 1 - t, x, y;
          if (op === 2) { x = u * u * u * p0[0] + 3 * u * u * t * ops[i + 1] + 3 * u * t * t * ops[i + 3] + t * t * t * ops[i + 5]; y = u * u * u * p0[1] + 3 * u * u * t * ops[i + 2] + 3 * u * t * t * ops[i + 4] + t * t * t * ops[i + 6]; }
          else { x = u * u * p0[0] + 2 * u * t * ops[i + 1] + t * t * ops[i + 3]; y = u * u * p0[1] + 2 * u * t * ops[i + 2] + t * t * ops[i + 4]; }
          cur.push([x, y]);
        }
        last = cur[cur.length - 1]; i += op === 2 ? 7 : 5;
      } else { if (cur) cur.closed = true; i += 1; }
    }
    return polys;
  }
  function pointInPolys(polys, x, y, rule) {
    var wn = 0, crossings = 0;
    for (var p = 0; p < polys.length; p++) {
      var pts = polys[p];
      for (var i = 0; i < pts.length; i++) {
        var a = pts[i], b = pts[(i + 1) % pts.length];
        // Points on an edge count as inside.
        var cr = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
        if (Math.abs(cr) < 1e-9 && x >= Math.min(a[0], b[0]) - 1e-9 && x <= Math.max(a[0], b[0]) + 1e-9 && y >= Math.min(a[1], b[1]) - 1e-9 && y <= Math.max(a[1], b[1]) + 1e-9) return true;
        if (a[1] <= y) { if (b[1] > y && cr > 0) { wn++; crossings++; } }
        else if (b[1] <= y && cr < 0) { wn--; crossings++; }
      }
    }
    return rule === "evenodd" ? crossings % 2 === 1 : wn !== 0;
  }
  P.isPointInPath = function () {
    var args = Array.prototype.slice.call(arguments), ops, rule, x, y;
    if (args[0] instanceof Path2D) { ops = transformOps(args[0]._pb.ops, this._state.m); x = +args[1]; y = +args[2]; rule = ruleOf(args[3]); }
    else { ops = this._path.ops; x = +args[0]; y = +args[1]; rule = ruleOf(args[2]); }
    if (!finite(x, y) || !ops.length) return false;
    return pointInPolys(flatten(ops), x, y, rule);
  };
  P.isPointInStroke = function () {
    var args = Array.prototype.slice.call(arguments), ops, x, y;
    if (args[0] instanceof Path2D) { ops = transformOps(args[0]._pb.ops, this._state.m); x = +args[1]; y = +args[2]; }
    else { ops = this._path.ops; x = +args[0]; y = +args[1]; }
    var inv = invert(this._state.m);
    if (!finite(x, y) || !ops.length || !inv) return false;
    var u = apply(inv, x, y), half = this._state.lineWidth / 2;
    var polys = flatten(transformOps(ops, inv));
    for (var p = 0; p < polys.length; p++) {
      var pts = polys[p], n = pts.closed ? pts.length : pts.length - 1;
      for (var i = 0; i < n; i++) {
        var a = pts[i], b = pts[(i + 1) % pts.length], dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
        var t = len2 ? clamp(((u[0] - a[0]) * dx + (u[1] - a[1]) * dy) / len2, 0, 1) : 0;
        var px = a[0] + t * dx - u[0], py = a[1] + t * dy - u[1];
        var capped = this._state.lineCap !== "butt" || (t > 0 && t < 1) || n > 1;
        if (px * px + py * py <= half * half + 1e-9 && capped) return true;
      }
    }
    return false;
  };
  P.drawFocusIfNeeded = function () {};
  P.scrollPathIntoView = function () {};
  // Images
  P.drawImage = function (image) {
    var n = arguments.length;
    if (n !== 3 && n !== 5 && n !== 9) throw new TypeError("Failed to execute 'drawImage': Valid arities are: [3, 5, 9], but " + n + " arguments provided.");
    __jb.currentCanvasSpace = this._attrs ? this._attrs.colorSpace : "srgb";
    var info;
    try { info = __jb.canvasImageSource(image, false); } finally { __jb.currentCanvasSpace = null; }
    // (a video with data taints even though its frames cannot be decoded here)
    if ((info || (image && image._tag === "video" && image.readyState >= 2)) && __jb.imageSourceTainted(image)) this._canvas._originTainted = true;
    var a = Array.prototype.slice.call(arguments, 1).map(Number);
    if (!finite.apply(null, a)) return;
    if (!info) return;
    var iw = info.iw || info.w, ih = info.ih || info.h;
    var sx = 0, sy = 0, sw = iw, sh = ih, dx, dy, dw, dh;
    if (n === 3) { dx = a[0]; dy = a[1]; dw = iw; dh = ih; }
    else if (n === 5) { dx = a[0]; dy = a[1]; dw = a[2]; dh = a[3]; }
    else { sx = a[0]; sy = a[1]; sw = a[2]; sh = a[3]; dx = a[4]; dy = a[5]; dw = a[6]; dh = a[7]; }
    if (sw < 0) { sx += sw; sw = -sw; } if (sh < 0) { sy += sh; sh = -sh; }
    if (dw < 0) { dx += dw; dw = -dw; } if (dh < 0) { dy += dh; dh = -dh; }
    if (!sw || !sh || !dw || !dh) return;
    // Clip the source rectangle to the image, adjusting the destination proportionally.
    var x0 = Math.max(sx, 0), y0 = Math.max(sy, 0), x1 = Math.min(sx + sw, iw), y1 = Math.min(sy + sh, ih);
    if (x1 <= x0 || y1 <= y0) return;
    var kx = dw / sw, ky = dh / sh;
    dx += (x0 - sx) * kx; dy += (y0 - sy) * ky; dw = (x1 - x0) * kx; dh = (y1 - y0) * ky; sx = x0; sy = y0; sw = x1 - x0; sh = y1 - y0;
    // Pixel space of the decoded image may differ from its density-corrected size.
    var rx = info.w / iw, ry = info.h / ih;
    var m = mul(this._state.m, [dw / (sw * rx), 0, 0, dh / (sh * ry), dx - sx * rx * dw / (sw * rx), dy - sy * ry * dh / (sh * ry)]);
    this._emit({ t: "image", src: info.src, m: m, sx: sx * rx, sy: sy * ry, sw: sw * rx, sh: sh * ry, smooth: this._state.smoothing });
  };
  P.createImageData = function (a, b, settings) {
    if (a instanceof ImageData) return new ImageData(a.width, a.height, { colorSpace: a.colorSpace });
    if (arguments.length < 2) throw new TypeError("Failed to execute 'createImageData': 2 arguments required.");
    var w = +a, h = +b;
    if (!isFinite(w) || !isFinite(h)) throw new TypeError("The provided double value is non-finite.");
    w = Math.abs(Math.trunc(w)); h = Math.abs(Math.trunc(h));
    if (!w || !h) throw __jb.domError("IndexSizeError", "The source width or height is 0.");
    return new ImageData(w, h, Object.assign({ colorSpace: this._attrs ? this._attrs.colorSpace : "srgb" }, settings || {}));
  };
  P.getImageData = function (sx, sy, sw, sh, settings) {
    if (arguments.length < 4) throw new TypeError("Failed to execute 'getImageData': 4 arguments required.");
    sx = +sx; sy = +sy; sw = +sw; sh = +sh;
    if (!finite(sx, sy, sw, sh)) throw new TypeError("The provided double value is non-finite.");
    sx = Math.trunc(sx); sy = Math.trunc(sy); sw = Math.trunc(sw); sh = Math.trunc(sh);
    if (!sw || !sh) throw __jb.domError("IndexSizeError", "The source width or height is 0.");
    if (this._canvas._originTainted) throw __jb.domError("SecurityError", "The canvas has been tainted by cross-origin data.");
    if (sw < 0) { sx += sw; sw = -sw; } if (sh < 0) { sy += sh; sh = -sh; }
    var canvasSpace = this._attrs ? this._attrs.colorSpace : "srgb";
    var out = new ImageData(sw, sh, Object.assign({ colorSpace: canvasSpace }, settings || {}));
    __jb.flushCanvas(this._canvas);
    var size = __jb.canvasSize(this._canvas);
    var r = this._canvas._canvasId ? __jb.native("canvas", { op: "get", id: this._canvas._canvasId, w: size[0], h: size[1], x: sx, y: sy, rw: sw, rh: sh, space: canvasSpace, to: out.colorSpace }) : null;
    if (r && r.data) { var bytes = __jb.b64ToBytes(r.data); out.data.set(bytes.subarray(0, out.data.length)); }
    return out;
  };
  P.putImageData = function (img, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH) {
    if (!(img instanceof ImageData)) throw new TypeError("Failed to execute 'putImageData': parameter 1 is not of type 'ImageData'.");
    if (arguments.length !== 3 && arguments.length !== 7) throw new TypeError("Failed to execute 'putImageData': 3 or 7 arguments required.");
    dx = +dx; dy = +dy;
    var dX = 0, dY = 0, dW = img.width, dH = img.height;
    if (arguments.length === 7) { dX = +dirtyX; dY = +dirtyY; dW = +dirtyW; dH = +dirtyH; }
    if (!finite(dx, dy, dX, dY, dW, dH)) return;
    dx = Math.trunc(dx); dy = Math.trunc(dy); dX = Math.trunc(dX); dY = Math.trunc(dY); dW = Math.trunc(dW); dH = Math.trunc(dH);
    if (dW < 0) { dX += dW; dW = -dW; } if (dH < 0) { dY += dH; dH = -dH; }
    if (dX < 0) { dW += dX; dX = 0; } if (dY < 0) { dH += dY; dY = 0; }
    if (dX + dW > img.width) dW = img.width - dX; if (dY + dH > img.height) dH = img.height - dY;
    if (dW <= 0 || dH <= 0) return;
    __jb.flushCanvas(this._canvas);
    var region = new Uint8Array(dW * dH * 4), src = img.data;
    for (var row = 0; row < dH; row++) region.set(src.subarray(((dY + row) * img.width + dX) * 4, ((dY + row) * img.width + dX + dW) * 4), row * dW * 4);
    var size = __jb.canvasSize(this._canvas);
    __jb.native("canvas", { op: "put", id: __jb.canvasId(this._canvas), w: size[0], h: size[1], x: dx + dX, y: dy + dY, rw: dW, rh: dH, data: b64(region), from: img.colorSpace, space: this._attrs ? this._attrs.colorSpace : "srgb" });
  };
  // Gradients and patterns
  P.createLinearGradient = function (x0, y0, x1, y1) { var v = [+x0, +y0, +x1, +y1]; if (!finite.apply(null, v)) throw new TypeError("The provided double value is non-finite."); var g = newInternal(CanvasGradient); Object.defineProperty(g, "_stops", { value: [] }); Object.defineProperty(g, "_def", { value: { k: "lg", x0: v[0], y0: v[1], x1: v[2], y1: v[3] } }); return g; };
  P.createRadialGradient = function (x0, y0, r0, x1, y1, r1) { var v = [+x0, +y0, +r0, +x1, +y1, +r1]; if (!finite.apply(null, v)) throw new TypeError("The provided double value is non-finite."); if (v[2] < 0 || v[5] < 0) throw __jb.domError("IndexSizeError", "The radius provided is negative."); var g = newInternal(CanvasGradient); Object.defineProperty(g, "_stops", { value: [] }); Object.defineProperty(g, "_def", { value: { k: "rg", x0: v[0], y0: v[1], r0: v[2], x1: v[3], y1: v[4], r1: v[5] } }); return g; };
  P.createConicGradient = function (a, x, y) { var v = [+a, +x, +y]; if (!finite.apply(null, v)) throw new TypeError("The provided double value is non-finite."); var g = newInternal(CanvasGradient); Object.defineProperty(g, "_stops", { value: [] }); Object.defineProperty(g, "_def", { value: { k: "cg", a: v[0], x: v[1], y: v[2] } }); return g; };
  P.createPattern = function (image, repetition) {
    if (arguments.length < 2) throw new TypeError("Failed to execute 'createPattern': 2 arguments required.");
    __jb.currentCanvasSpace = this._attrs ? this._attrs.colorSpace : "srgb";
    var info;
    try { info = __jb.canvasImageSource(image, true); } finally { __jb.currentCanvasSpace = null; }
    var rep = repetition === null ? "" : String(repetition);
    if (rep === "") rep = "repeat";
    if (!/^(repeat|repeat-x|repeat-y|no-repeat)$/.test(rep)) throw __jb.domError("SyntaxError", "The provided type ('" + rep + "') is not one of 'repeat', 'no-repeat', 'repeat-x', or 'repeat-y'.");
    if (!info) return null;
    var p = newInternal(CanvasPattern);
    Object.defineProperty(p, "_src", { value: info.src }); Object.defineProperty(p, "_rep", { value: rep }); p._m = null;
    if (__jb.imageSourceTainted(image)) p._tainted = true;
    return p;
  };
  // Text: shaped and painted by the host (Parley with the system fonts and the page's FontFace
  // fonts, see src/canvas_text.rs); without it a fixed advance model measures and nothing is drawn.
  var fontSize = function (font) { var m = /(\d*\.?\d+)px/.exec(font); return m ? parseFloat(m[1]) : 10; };
  var FONT_UNITS = { px: 1, pt: 4 / 3, pc: 16, "in": 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, em: 10, rem: 16, "%": 0.1 };
  var parseCanvasFont = function (font) {
    var m = /^\s*((?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]00|(?:ultra-|extra-|semi-)?(?:condensed|expanded))\s+)*)(\d*\.?\d+)(px|pt|pc|in|cm|mm|q|em|rem|%)?(?:\s*\/\s*\S+)?\s+(.+)$/i.exec(String(font));
    if (!m) return { size: fontSize(font), family: "sans-serif", weight: 400, style: "normal" };
    var pre = m[1].toLowerCase(), wm = /\b(bold|bolder|[1-9]00)\b/.exec(pre);
    return { size: parseFloat(m[2]) * (FONT_UNITS[(m[3] || "px").toLowerCase()] || 1), family: m[4].trim(),
      weight: wm ? (/^\d/.test(wm[1]) ? +wm[1] : 700) : (/\blighter\b/.test(pre) ? 300 : 400),
      style: /\bitalic\b/.test(pre) ? "italic" : /\boblique\b/.test(pre) ? "oblique" : "normal" };
  };
  // Fonts added with document.fonts.add(new FontFace(...)) go to the host once per source.
  var canvasFontsSent = {};
  var sendCanvasFont = function (name, url) {
    var key = name + "\u0001" + url;
    if (canvasFontsSent[key]) return;
    canvasFontsSent[key] = 1;
    measureCache.clear();
    __jb.native("canvas", { op: "loadFont", family: name, url: url });
  };
  // @font-face rules of the document's style sheets for the named families (each family looked up once
  // per document; the first url() source that is not SVG/EOT).
  var cssFontsSeen = new WeakMap();
  var GENERIC_FAMILY = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|emoji|math|fangsong|ui-serif|ui-sans-serif|ui-monospace|ui-rounded)$/;
  var ensureCssFonts = function (doc, fams) {
    var seen = cssFontsSeen.get(doc);
    if (!seen) { seen = {}; cssFontsSeen.set(doc, seen); }
    var want = fams.filter(function (f) { return f && !seen[f] && !GENERIC_FAMILY.test(f); });
    if (!want.length) return;
    want.forEach(function (f) { seen[f] = 1; });
    var walk = function (rules, base, depth) {
      if (!rules || depth > 4) return;
      for (var i = 0; i < rules.length && i < 5000; i++) {
        var r = rules[i];
        if (r.type === 5) {
          var text = String(r.cssText || ""), fm = /font-family\s*:\s*(["']?)([^;"'}]+)\1/i.exec(text);
          var name = fm ? fm[2].trim() : "";
          if (!name || want.indexOf(name.toLowerCase()) < 0) continue;
          var re = /url\(\s*(["']?)([^"')]*)\1\s*\)(\s*format\(\s*["']?([^"')]*))?/gi, m;
          while ((m = re.exec(text))) {
            if (/svg|embedded-opentype/i.test(m[4] || "") || /\.(svg|eot)([?#]|$)/i.test(m[2])) continue;
            try { sendCanvasFont(name, new URL(m[2], base).href); } catch (e) {}
            break;
          }
        } else if (r.cssRules && r.type !== 1) {
          walk(r.cssRules, base, depth + 1);
        }
      }
    };
    var sheets = doc.styleSheets || [];
    for (var i = 0; i < sheets.length; i++) {
      var rules = null;
      try { rules = sheets[i].cssRules; } catch (e) { rules = null; }
      walk(rules, sheets[i].href || doc.baseURI, 0);
    }
  };
  var ensureCanvasFonts = function (canvas, family) {
    var doc = (canvas && canvas.ownerDocument) || (typeof document !== "undefined" ? document : null);
    var set = (doc && doc.fonts) || (typeof self !== "undefined" && self.fonts);
    var fams = family.split(",").map(function (f) { return f.trim().replace(/^(["'])(.*)\1$/, "$2").toLowerCase(); });
    if (doc && doc.styleSheets) { try { ensureCssFonts(doc, fams); } catch (e) {} }
    if (!set || !set._faces || !set._faces.size) return;
    set._faces.forEach(function (f) {
      var name = String(f._family).replace(/^(["'])(.*)\1$/, "$2");
      if (fams.indexOf(name.toLowerCase()) < 0 || f._status === "error") return;
      var key = name + "\u0001" + (f._source || ("binary" + (f._bytes ? f._bytes.length : 0)));
      if (canvasFontsSent[key]) return;
      canvasFontsSent[key] = 1;
      measureCache.clear();
      if (f._bytes) { __jb.native("canvas", { op: "loadFont", family: name, b64: __jb.bytesToB64(f._bytes) }); return; }
      var u = /url\(\s*(["']?)([^"')]*)\1\s*\)/i.exec(f._source || "");
      if (!u) return;
      var url;
      try { url = new URL(u[2], (doc && doc.baseURI) || __jb.currentDocument.baseURI).href; } catch (e) { return; }
      __jb.native("canvas", { op: "loadFont", family: name, url: url });
    });
  };
  var measureCache = new Map();
  var hostMeasure = function (ctx, s) {
    var f = parseCanvasFont(ctx._state.font), key = ctx._state.font + "\u0001" + s, r = measureCache.get(key);
    if (r) return r;
    try { ensureCanvasFonts(ctx._canvas, f.family); r = __jb.native("canvas", { op: "measure", text: s, font: f }); } catch (e) { r = null; }
    if (!r || !r.ok) return null;
    if (measureCache.size > 2000) measureCache.clear();
    measureCache.set(key, r);
    return r;
  };
  P.measureText = function (text) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'measureText': 1 argument required.");
    var s = String(text).replace(/[\t\n\f\r]/g, " "), size = fontSize(this._state.font), w = s.length * size * 0.5;
    var asc = size * 0.8, desc = size * 0.2, hm = s ? hostMeasure(this, s) : null;
    if (hm) { w = hm.width; asc = hm.ascent; desc = hm.descent; }
    var tm = newInternal(TextMetrics);
    Object.defineProperty(tm, "_m", { value: { width: w, actualBoundingBoxLeft: 0, actualBoundingBoxRight: w, fontBoundingBoxAscent: asc, fontBoundingBoxDescent: desc, actualBoundingBoxAscent: s.trim() ? asc * 0.875 : 0, actualBoundingBoxDescent: s.trim() ? desc : 0, emHeightAscent: asc, emHeightDescent: desc, hangingBaseline: asc * 0.8, alphabeticBaseline: 0, ideographicBaseline: -desc } });
    return tm;
  };
  P._text = function (t, x, y, maxWidth, stroke) {
    x = +x; y = +y;
    if (!finite(x, y)) return;
    if (maxWidth !== undefined) { maxWidth = +maxWidth; if (!(maxWidth > 0)) return; }
    var s = String(t).replace(/[\t\n\f\r]/g, " ");
    if (!s.trim()) return;
    var st = this._state, f = parseCanvasFont(st.font);
    if (!(f.size > 0)) return;
    if (stroke && !(st.lineWidth > 0)) return;
    try { ensureCanvasFonts(this._canvas, f.family); } catch (e) {}
    var dir = st.direction === "inherit" ? (this._canvas && this._canvas.closest && this._canvas.closest("[dir=rtl]") ? "rtl" : "ltr") : st.direction;
    var cmd = { t: "text", text: s, font: f, x: x, y: y, align: st.textAlign, baseline: st.textBaseline, dir: dir, m: st.m, paint: this._paintOf(stroke ? st.stroke : st.fill) };
    var gp = cmd.paint;
    if (gp && ((gp.k === "lg" && gp.x0 === gp.x1 && gp.y0 === gp.y1) || (gp.k === "rg" && gp.x0 === gp.x1 && gp.y0 === gp.y1 && gp.r0 === gp.r1))) return;
    if (maxWidth !== undefined && isFinite(maxWidth)) cmd.maxWidth = maxWidth;
    if (stroke) cmd.stroke = { w: st.lineWidth, cap: st.lineCap, join: st.lineJoin, miter: st.miterLimit, dash: st.dash, off: st.dashOffset };
    this._emit(cmd);
  };
  var recordText = function (canvas, t) {
    var s = String(t);
    if (!s.trim()) return;
    __jb.canvasText.push(s);
    if (canvas && canvas.setAttribute && !canvas.getAttribute("aria-label")) canvas._setAttrRaw("data-canvas-text", (canvas.getAttribute("data-canvas-text") ? canvas.getAttribute("data-canvas-text") + " " : "") + s);
    if (canvas && canvas.__jbid !== undefined) __jb.markDirty(canvas);
  };
  P.fillText = function (t, x, y, maxWidth) { if (arguments.length < 3) throw new TypeError("Failed to execute 'fillText': 3 arguments required."); recordText(this._canvas, t); this._text(t, x, y, maxWidth, false); };
  P.strokeText = function (t, x, y, maxWidth) { if (arguments.length < 3) throw new TypeError("Failed to execute 'strokeText': 3 arguments required."); recordText(this._canvas, t); this._text(t, x, y, maxWidth, true); };
  P.setLineDash = function (segments) {
    if (segments === null || typeof segments !== "object" || typeof segments[Symbol.iterator] !== "function") throw new TypeError("Failed to execute 'setLineDash': The provided value cannot be converted to a sequence.");
    var list = __jb.arrayFrom(segments, Number);
    if (list.some(function (v) { return !isFinite(v) || v < 0; })) return;
    if (list.length % 2) list = list.concat(list);
    this._state.dash = list;
  };
  P.getLineDash = function () { return this._state.dash.slice(); };
  // Attributes
  var styleProp = function (key) {
    return {
      get: function () { var st = this._state[key]; if (st.color) return __jb.serializeCanvasColor(st.color); return st.gradient || st.pattern; },
      set: function (v) {
        if (v instanceof CanvasGradient) { this._state[key] = { gradient: v }; return; }
        if (v instanceof CanvasPattern) { this._state[key] = { pattern: v }; return; }
        var c = __jb.parseCssColor(v);
        if (c === "currentcolor") { var cc = this._canvas && this._canvas._tag === "canvas" && this._canvas.isConnected ? __jb.parseCssColor(getComputedStyle(this._canvas).color || "black") : null; c = cc && cc !== "currentcolor" ? cc : [0, 0, 0, 1]; }
        if (c) this._state[key] = { color: c };
      },
    };
  };
  var acc = {
    fillStyle: styleProp("fill"), strokeStyle: styleProp("stroke"),
    globalAlpha: { get: function () { return this._state.alpha; }, set: function (v) { v = +v; if (isFinite(v) && v >= 0 && v <= 1) this._state.alpha = v; } },
    globalCompositeOperation: { get: function () { return this._state.comp; }, set: function (v) { v = String(v); if (COMPOSITES.test(v)) this._state.comp = v; } },
    lineWidth: { get: function () { return this._state.lineWidth; }, set: function (v) { v = +v; if (isFinite(v) && v > 0) this._state.lineWidth = v; } },
    lineCap: { get: function () { return this._state.lineCap; }, set: function (v) { v = String(v); if (/^(butt|round|square)$/.test(v)) this._state.lineCap = v; } },
    lineJoin: { get: function () { return this._state.lineJoin; }, set: function (v) { v = String(v); if (/^(round|bevel|miter)$/.test(v)) this._state.lineJoin = v; } },
    miterLimit: { get: function () { return this._state.miterLimit; }, set: function (v) { v = +v; if (isFinite(v) && v > 0) this._state.miterLimit = v; } },
    lineDashOffset: { get: function () { return this._state.dashOffset; }, set: function (v) { v = +v; if (isFinite(v)) this._state.dashOffset = v; } },
    shadowBlur: { get: function () { return this._state.shadowBlur; }, set: function (v) { v = +v; if (isFinite(v) && v >= 0) this._state.shadowBlur = v; } },
    shadowOffsetX: { get: function () { return this._state.shadowOffsetX; }, set: function (v) { v = +v; if (isFinite(v)) this._state.shadowOffsetX = v; } },
    shadowOffsetY: { get: function () { return this._state.shadowOffsetY; }, set: function (v) { v = +v; if (isFinite(v)) this._state.shadowOffsetY = v; } },
    shadowColor: { get: function () { return __jb.serializeCanvasColor(this._state.shadowColor); }, set: function (v) { var c = __jb.parseCssColor(v); if (c === "currentcolor") c = [0, 0, 0, 1]; if (c) this._state.shadowColor = c; } },
    font: { get: function () { return this._state.font; }, set: function (v) { v = String(v); if (/\d(px|pt|em|rem|%)|\b(xx-small|x-small|small|medium|large|x-large|xx-large|larger|smaller)\b/i.test(v)) this._state.font = v.replace(/\s+/g, " ").trim(); } },
    textAlign: { get: function () { return this._state.textAlign; }, set: function (v) { v = String(v); if (/^(start|end|left|right|center)$/.test(v)) this._state.textAlign = v; } },
    textBaseline: { get: function () { return this._state.textBaseline; }, set: function (v) { v = String(v); if (/^(top|hanging|middle|alphabetic|ideographic|bottom)$/.test(v)) this._state.textBaseline = v; } },
    direction: { get: function () { return this._state.direction; }, set: function (v) { v = String(v); if (/^(ltr|rtl|inherit)$/.test(v)) this._state.direction = v; } },
    letterSpacing: { get: function () { return this._state.letterSpacing; }, set: function (v) { v = String(v).trim(); if (/^-?\d*\.?\d+(px|em|rem|pt)$/.test(v) || v === "0") this._state.letterSpacing = v === "0" ? "0px" : v; } },
    wordSpacing: { get: function () { return this._state.wordSpacing; }, set: function (v) { v = String(v).trim(); if (/^-?\d*\.?\d+(px|em|rem|pt)$/.test(v) || v === "0") this._state.wordSpacing = v === "0" ? "0px" : v; } },
    fontKerning: { get: function () { return this._state.fontKerning; }, set: function (v) { v = String(v); if (/^(auto|normal|none)$/.test(v)) this._state.fontKerning = v; } },
    fontStretch: { get: function () { return this._state.fontStretch; }, set: function (v) { v = String(v); if (/^(ultra-condensed|extra-condensed|condensed|semi-condensed|normal|semi-expanded|expanded|extra-expanded|ultra-expanded)$/.test(v)) this._state.fontStretch = v; } },
    fontVariantCaps: { get: function () { return this._state.fontVariantCaps; }, set: function (v) { v = String(v); if (/^(normal|small-caps|all-small-caps|petite-caps|all-petite-caps|unicase|titling-caps)$/.test(v)) this._state.fontVariantCaps = v; } },
    textRendering: { get: function () { return this._state.textRendering; }, set: function (v) { v = String(v); if (/^(auto|optimizeSpeed|optimizeLegibility|geometricPrecision)$/.test(v)) this._state.textRendering = v; } },
    imageSmoothingEnabled: { get: function () { return this._state.smoothing; }, set: function (v) { this._state.smoothing = !!v; } },
    imageSmoothingQuality: { get: function () { return this._state.smoothingQuality; }, set: function (v) { v = String(v); if (/^(low|medium|high)$/.test(v)) this._state.smoothingQuality = v; } },
    filter: { get: function () { return this._state.filter; }, set: function (v) { this._state.filter = String(v); } },
    canvas: { get: function () { return this._canvas; } },
  };
  Object.keys(acc).forEach(function (k) { acc[k].enumerable = true; acc[k].configurable = true; Object.defineProperty(P, k, acc[k]); });
  Object.keys(P).forEach(function (k) { var d = Object.getOwnPropertyDescriptor(P, k); if (k.charAt(0) === "_") Object.defineProperty(P, k, { enumerable: false }); else if (typeof d.value === "function") Object.defineProperty(P, k, { value: d.value, writable: true, enumerable: true, configurable: true }); });
  var CanvasRenderingContext2D = Ctx2D;
  Object.defineProperty(CanvasRenderingContext2D, "name", { value: "CanvasRenderingContext2D" });
  __jb.setTag(CanvasRenderingContext2D, "CanvasRenderingContext2D");
  function OffscreenCanvasRenderingContext2D() { throw new TypeError("Illegal constructor"); }
  // A separate interface (not a subclass): it owns copies of the shared members.
  OffscreenCanvasRenderingContext2D.prototype = Object.create(Object.prototype);
  Object.getOwnPropertyNames(P).forEach(function (k) { if (k !== "constructor") Object.defineProperty(OffscreenCanvasRenderingContext2D.prototype, k, Object.getOwnPropertyDescriptor(P, k)); });
  Object.defineProperty(OffscreenCanvasRenderingContext2D.prototype, "constructor", { value: OffscreenCanvasRenderingContext2D, writable: true, configurable: true });
  __jb.setTag(OffscreenCanvasRenderingContext2D, "OffscreenCanvasRenderingContext2D");

  function ImageBitmapRenderingContext() { throw new TypeError("Illegal constructor"); }
  Object.defineProperty(ImageBitmapRenderingContext.prototype, "canvas", { get: function () { return this._canvas; }, enumerable: true, configurable: true });
  ImageBitmapRenderingContext.prototype.transferFromImageBitmap = function transferFromImageBitmap(bitmap) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'transferFromImageBitmap': 1 argument required.");
    var canvas = this._canvas, id = __jb.canvasId(canvas), size = __jb.canvasSize(canvas);
    __jb.native("canvas", { op: "reset", id: id, w: size[0], h: size[1] });
    if (bitmap === null) { canvas._originTainted = false; return; }
    if (Object.prototype.toString.call(bitmap) !== "[object ImageBitmap]") throw new TypeError("Failed to execute 'transferFromImageBitmap': parameter 1 is not of type 'ImageBitmap'.");
    if (bitmap._closed) throw __jb.domError("InvalidStateError", "The input ImageBitmap has been detached.");
    var src = bitmap._src;
    if (src && src.rgba !== undefined && src.rgba !== "") __jb.native("canvas", { op: "put", id: id, w: size[0], h: size[1], x: 0, y: 0, rw: src.w, rh: src.h, data: src.rgba });
    canvas._originTainted = !!bitmap._originTainted;
    bitmap._closed = true;
  };
  __jb.setTag(ImageBitmapRenderingContext, "ImageBitmapRenderingContext");
  globalThis.ImageBitmapRenderingContext = ImageBitmapRenderingContext;
  __jb.bitmapRendererContext = function (canvas) {
    if (canvas._ctxType && canvas._ctxType !== "bitmaprenderer") return null;
    if (canvas._ctxBitmap) return canvas._ctxBitmap;
    var ctx = Object.create(ImageBitmapRenderingContext.prototype);
    Object.defineProperty(ctx, "_canvas", { value: canvas });
    Object.defineProperty(canvas, "_ctxBitmap", { value: ctx, configurable: true });
    canvas._ctxType = "bitmaprenderer";
    return ctx;
  };
  __jb.canvasSpaceOf = function (canvas) { return canvas._ctx2d && canvas._ctx2d._attrs ? canvas._ctx2d._attrs.colorSpace : "srgb"; };
  __jb.canvasContext = function (canvas, type, attrs) {
    type = String(type);
    if (type === "bitmaprenderer") return __jb.bitmapRendererContext(canvas);
    if (type !== "2d") return canvas._ctxType && canvas._ctxType !== type ? null : null;
    if (canvas._ctxType && canvas._ctxType !== "2d") return null;
    if (canvas._ctx2d) return canvas._ctx2d;
    var proto = canvas instanceof OffscreenCanvas ? OffscreenCanvasRenderingContext2D.prototype : P;
    var ctx = Object.create(proto);
    Object.defineProperty(ctx, "_canvas", { value: canvas });
    Object.defineProperty(ctx, "_queue", { value: [] });
    Object.defineProperty(ctx, "_attrs", { value: { alpha: !(attrs && attrs.alpha === false), colorSpace: attrs && attrs.colorSpace === "display-p3" ? "display-p3" : "srgb", desynchronized: !!(attrs && attrs.desynchronized), willReadFrequently: !!(attrs && attrs.willReadFrequently) } });
    ["_state", "_stack", "_path"].forEach(function (k) { Object.defineProperty(ctx, k, { value: null, writable: true }); });
    ctx._reset();
    Object.defineProperty(canvas, "_ctx2d", { value: ctx, writable: true, configurable: true });
    canvas._ctxType = "2d";
    __jb.canvasId(canvas);
    var size = __jb.canvasSize(canvas);
    __jb.native("canvas", { op: "reset", id: canvas._canvasId, w: size[0], h: size[1] });
    return ctx;
  };

  // ------------------------------------------------------------ canvas elements
  __jb.canvasDataURL = function (canvas, type) {
    var size = __jb.canvasSize(canvas);
    if (!size[0] || !size[1]) return "data:,";
    if (canvas._ctx2d) __jb.flushCanvas(canvas);
    var r = __jb.native("canvas", { op: "png", id: __jb.canvasId(canvas), w: size[0], h: size[1] });
    return r && r.data ? "data:image/png;base64," + r.data : "data:,";
  };
  var C = __jb.htmlClasses.HTMLCanvasElement;
  if (C) {
    [["width", 300], ["height", 150]].forEach(function (pair) {
      Object.defineProperty(C.prototype, pair[0], {
        get: function () { var v = __jb.parseHtmlNonneg(this.getAttribute(pair[0]) || ""); return v === null || v > __jb.MAX_INT ? pair[1] : v; },
        set: function (v) { var u = __jb.toUint32(v); if (u > __jb.MAX_INT) u = pair[1]; this.setAttribute(pair[0], String(u)); },
        configurable: true, enumerable: true,
      });
    });
    C.prototype.getContext = function getContext(type, attrs) { if (arguments.length < 1) throw new TypeError("Failed to execute 'getContext': 1 argument required."); if (this._transferred) throw __jb.domError("InvalidStateError", "Cannot get a context from a canvas that has transferred its control to offscreen."); return __jb.canvasContext(this, type, attrs); };
    C.prototype.toDataURL = function toDataURL(type, quality) { if (this._originTainted) throw __jb.domError("SecurityError", "Tainted canvases may not be exported."); return __jb.canvasDataURL(this, type); };
    C.prototype.toBlob = function toBlob(callback, type, quality) {
      if (typeof callback !== "function") throw new TypeError("Failed to execute 'toBlob': The callback provided as parameter 1 is not a function.");
      if (this._originTainted) throw __jb.domError("SecurityError", "Tainted canvases may not be exported.");
      var url = __jb.canvasDataURL(this, type), self = this;
      setTimeout(function () { var blob = null; if (url !== "data:,") blob = new Blob([__jb.b64ToBytes(url.slice(url.indexOf(",") + 1))], { type: "image/png" }); callback.call(self, blob); }, 0);
    };
    C.prototype.transferControlToOffscreen = function transferControlToOffscreen() {
      if (this._ctxType || this._transferred) throw __jb.domError("InvalidStateError", "Cannot transfer control from a canvas that has a rendering context.");
      this._transferred = true;
      var size = __jb.canvasSize(this), oc = new OffscreenCanvas(size[0], size[1]);
      Object.defineProperty(oc, "_canvasId", { value: __jb.canvasId(this), writable: true });
      return oc;
    };
    C.prototype.captureStream = function captureStream() { return typeof MediaStream === "function" ? new MediaStream() : {}; };
    Object.defineProperty(HTMLElement.prototype, "getContext", { value: undefined, writable: true, configurable: true });
    delete HTMLElement.prototype.getContext; delete HTMLElement.prototype.toDataURL;
  }
  // Setting width/height (even to the same value) resets the bitmap and context state.
  var baseAttrChanged = __jb.attributeChanged;
  __jb.attributeChanged = function (el, attr, oldValue, newValue) {
    baseAttrChanged(el, attr, oldValue, newValue);
    if (el._tag === "canvas" && attr._ns === null && (attr._local === "width" || attr._local === "height") && el._ns === __jb.HTML_NS && (el._ctx2d || el._canvasId)) __jb.resetCanvasBitmap(el);
  };

  class OffscreenCanvas extends EventTarget {
    constructor(width, height) {
      if (arguments.length < 2) throw new TypeError("Failed to construct 'OffscreenCanvas': 2 arguments required.");
      // [EnforceRange] unsigned long long
      var enforce = function (v) { v = Number(v); if (!isFinite(v)) throw new TypeError("Failed to construct 'OffscreenCanvas': Value is not of type 'unsigned long long'."); v = Math.trunc(v); if (v < 0 || v > Number.MAX_SAFE_INTEGER) throw new TypeError("Failed to construct 'OffscreenCanvas': Value is outside the 'unsigned long long' value range."); return v; };
      width = enforce(width); height = enforce(height);
      super();
      Object.defineProperty(this, "_width", { value: width, writable: true });
      Object.defineProperty(this, "_height", { value: height, writable: true });
    }
    get width() { return this._width; }
    set width(v) { this._width = __jb.toUint32(v); __jb.resetCanvasBitmap(this); }
    get height() { return this._height; }
    set height(v) { this._height = __jb.toUint32(v); __jb.resetCanvasBitmap(this); }
    getContext(type, attrs) { if (arguments.length < 1) throw new TypeError("Failed to execute 'getContext': 1 argument required."); if (this._detached) throw __jb.domError("InvalidStateError", "OffscreenCanvas object is detached."); type = String(type); if (!/^(2d|webgl|webgl2|bitmaprenderer|webgpu)$/.test(type)) throw new TypeError("The provided value '" + type + "' is not a valid enum value of type OffscreenRenderingContextId."); return __jb.canvasContext(this, type, attrs); }
    transferToImageBitmap() {
      if (this._detached) throw __jb.domError("InvalidStateError", "OffscreenCanvas object is detached.");
      if (!this._ctxType) throw __jb.domError("InvalidStateError", "Cannot transfer an ImageBitmap from an OffscreenCanvas with no context.");
      var bmp = __jb.imageBitmapFromCanvas(this);
      // the bitmap becomes transparent black; the context keeps its state
      var size = __jb.canvasSize(this);
      if (this._canvasId) __jb.native("canvas", { op: "reset", id: this._canvasId, w: size[0], h: size[1] });
      return bmp;
    }
    convertToBlob(options) {
      if (this._detached) return Promise.reject(__jb.domError("InvalidStateError", "OffscreenCanvas object is detached."));
      if (!this._width || !this._height) return Promise.reject(__jb.domError("IndexSizeError", "The canvas has no pixels."));
      var url = __jb.canvasDataURL(this);
      return Promise.resolve(new Blob([__jb.b64ToBytes(url.slice(url.indexOf(",") + 1))], { type: "image/png" }));
    }
  }
  __jb.setTag(OffscreenCanvas, "OffscreenCanvas");
  __jb.defineEventHandlerProps && __jb.defineEventHandlerProps(OffscreenCanvas.prototype, ["contextlost", "contextrestored"]);

  // ------------------------------------------------------------ SVG <image> loading
  __jb.svgImageLoad = function (el) {
    var href = el.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    if (el.hasAttribute("href")) href = el.getAttribute("href");
    var gen = el._svgImageGen = (el._svgImageGen || 0) + 1;
    if (href === null || href === "") { el._svgImage = null; return; }
    var url; try { url = new URL(href, el.baseURI).href; } catch (e) { url = null; }
    el._svgImage = { state: "loading", url: url, width: 0, height: 0 };
    setTimeout(function () {
      if (el._svgImageGen !== gen) return;
      var r = url ? __jb.native("image", { url: url }) : null;
      if (r && r.ok) { el._svgImage = { state: "available", url: url, width: r.width || 0, height: r.height || 0 }; __jb.fireUA(el, "load"); }
      else if (r && r.unsupported) { el._svgImage = { state: "available", url: url, width: 0, height: 0 }; __jb.fireUA(el, "load"); }
      else { el._svgImage = { state: "broken", url: url, width: 0, height: 0 }; __jb.fireUA(el, "error"); }
    }, 0);
  };
  var baseConnectedSvg = __jb.connected;
  __jb.connected = function (node) {
    baseConnectedSvg(node);
    var list = node.nodeType === 1 && node._ns === __jb.SVG_NS && node._local === "image" ? [node] : [];
    if (node.nodeType === 1 && node.getElementsByTagNameNS) list = list.concat(__jb.arrayFrom(node.getElementsByTagNameNS(__jb.SVG_NS, "image")));
    list.forEach(__jb.svgImageLoad);
  };
  var baseAttrSvg = __jb.attributeChanged;
  __jb.attributeChanged = function (el, attr, oldValue, newValue) {
    baseAttrSvg(el, attr, oldValue, newValue);
    if (el._ns === __jb.SVG_NS && el._local === "image" && attr._local === "href" && el.isConnected) __jb.svgImageLoad(el);
  };

  // ------------------------------------------------------------ ImageBitmap
  class ImageBitmap {
    constructor() { if (!__jb.canvasConstructing) throw new TypeError("Illegal constructor"); }
    get width() { return this._closed ? 0 : this._w; }
    get height() { return this._closed ? 0 : this._h; }
    close() { this._closed = true; }
  }
  __jb.setTag(ImageBitmap, "ImageBitmap");
  var makeBitmap = function (w, h, rgba, space) {
    var bmp = newInternal(ImageBitmap);
    Object.defineProperty(bmp, "_w", { value: w }); Object.defineProperty(bmp, "_h", { value: h });
    Object.defineProperty(bmp, "_src", { value: { rgba: b64(rgba), w: w, h: h, srcSpace: space || "srgb" } });
    bmp._closed = false;
    return bmp;
  };
  __jb.imageBitmapFromCanvas = function (canvas, sx, sy, sw, sh) {
    var size = __jb.canvasSize(canvas);
    if (sx === undefined) { sx = 0; sy = 0; sw = size[0]; sh = size[1]; }
    __jb.flushCanvas(canvas);
    var r = __jb.native("canvas", { op: "get", id: __jb.canvasId(canvas), w: size[0], h: size[1], x: sx, y: sy, rw: sw, rh: sh });
    return makeBitmap(sw, sh, r && r.data ? __jb.b64ToBytes(r.data) : new Uint8Array(sw * sh * 4), __jb.canvasSpaceOf(canvas));
  };
  __jb.cloneImageBitmap = function (v) { if (v._closed) throw __jb.domError("DataCloneError", "An ImageBitmap is detached."); var c = newInternal(ImageBitmap); Object.defineProperty(c, "_w", { value: v._w }); Object.defineProperty(c, "_h", { value: v._h }); Object.defineProperty(c, "_src", { value: v._src }); if (v._srcP3) Object.defineProperty(c, "_srcP3", { value: v._srcP3 }); c._closed = false; return c; };
  // createImageBitmap: the (cropped) source is drawn into a scratch canvas of the
  // output size (resize, flipY, smoothing per resizeQuality) and read back.
  var bitmapSource = function (image) {
    if (image instanceof ImageData) {
      var tmp = new OffscreenCanvas(image.width, image.height);
      __jb.canvasContext(tmp, "2d").putImageData(image, 0, 0);
      return { draw: tmp, w: image.width, h: image.height };
    }
    if (image instanceof ImageBitmap) {
      if (image._closed) throw __jb.domError("InvalidStateError", "The image source is detached.");
      return { draw: image, w: image.width, h: image.height };
    }
    if (image && (image._tag === "canvas" || image instanceof OffscreenCanvas)) {
      var size = __jb.canvasSize(image);
      if (!size[0] || !size[1]) throw __jb.domError("InvalidStateError", "The source canvas has no pixels.");
      return { draw: image, w: size[0], h: size[1] };
    }
    if (image && image._tag === "video") {
      var vm = image._media;
      if (!vm || vm.readyState < 2 || !image.videoWidth) throw __jb.domError("InvalidStateError", "The video element has no frame.");
      var vc = new OffscreenCanvas(image.videoWidth, image.videoHeight); __jb.canvasContext(vc, "2d");
      if (__jb.imageSourceTainted(image)) vc._originTainted = true;
      return { draw: vc, w: image.videoWidth, h: image.videoHeight };
    }
    var info = __jb.canvasImageSource(image, false);
    if (!info) throw __jb.domError("InvalidStateError", "The source image could not be decoded.");
    return { draw: image, w: info.iw || info.w, h: info.ih || info.h };
  };
  var renderBitmap = function (src, crop, options) {
    if (options && options.imageOrientation === "none" && src.draw && src.draw._tag === "img") {
      __jb.currentImageOrient = false;
      try { var rawInfo = __jb.canvasImageSource(src.draw, false); } finally { __jb.currentImageOrient = null; }
      if (rawInfo) src = { draw: src.draw, w: rawInfo.iw || rawInfo.w, h: rawInfo.ih || rawInfo.h, raw: true };
    }
    var sx = 0, sy = 0, sw = src.w, sh = src.h;
    if (crop) { sx = crop[0]; sy = crop[1]; sw = crop[2]; sh = crop[3]; }
    var opt = options || {};
    var rw = opt.resizeWidth, rh = opt.resizeHeight, ow = sw, oh = sh;
    if (rw !== undefined && rh !== undefined) { ow = rw; oh = rh; }
    else if (rw !== undefined) { ow = rw; oh = Math.ceil(sh * rw / sw); }
    else if (rh !== undefined) { oh = rh; ow = Math.ceil(sw * rh / sh); }
    if (!(ow > 0 && oh > 0) || ow > 32767 || oh > 32767 || ow * oh > 268435456) throw __jb.domError("InvalidStateError", "The ImageBitmap would be too large.");
    // The bitmap keeps its source's colors: it is rendered for both canvas color spaces and the
    // destination canvas picks one (see canvasImageSource).
    var renderIn = function (space) {
      var canvas = new OffscreenCanvas(ow, oh), ctx = __jb.canvasContext(canvas, "2d", { colorSpace: space });
      if (src.raw) __jb.currentImageOrient = false;
      ctx.imageSmoothingEnabled = opt.resizeQuality !== "pixelated";
      if (opt.imageOrientation === "flipY") { ctx.translate(0, oh); ctx.scale(1, -1); }
      // Out-of-bounds parts of the crop rectangle stay transparent.
      var x0 = Math.max(sx, 0), y0 = Math.max(sy, 0), x1 = Math.min(sx + sw, src.w), y1 = Math.min(sy + sh, src.h);
      if (x1 > x0 && y1 > y0) {
        var kx = ow / sw, ky = oh / sh;
        ctx.drawImage(src.draw, x0, y0, x1 - x0, y1 - y0, (x0 - sx) * kx, (y0 - sy) * ky, (x1 - x0) * kx, (y1 - y0) * ky);
      }
      __jb.currentImageOrient = null;
      __jb.flushCanvas(canvas);
      var r = __jb.native("canvas", { op: "get", id: __jb.canvasId(canvas), w: ow, h: oh, x: 0, y: 0, rw: ow, rh: oh });
      __jb.native("canvas", { op: "drop", id: __jb.canvasId(canvas) });
      return r && r.data ? __jb.b64ToBytes(r.data) : new Uint8Array(ow * oh * 4);
    };
    var ownSpace = src.draw && (src.draw._tag === "canvas" || src.draw instanceof OffscreenCanvas) ? __jb.canvasSpaceOf(src.draw) : "srgb";
    var bmp = makeBitmap(ow, oh, renderIn(ownSpace), ownSpace);
    // Sources with their own color profile (images, decoded blobs) also get a Display P3 rendering.
    if (src.draw && (src.draw instanceof ImageBitmap ? !!src.draw._srcP3 : !(src.draw instanceof OffscreenCanvas) && src.draw._tag !== "canvas")) Object.defineProperty(bmp, "_srcP3", { value: { rgba: b64(renderIn("display-p3")), w: ow, h: oh, space: "display-p3" } });
    if (src.draw && (src.draw._originTainted || __jb.imageSourceTainted(src.draw))) bmp._originTainted = true;
    return bmp;
  };
  globalThis.createImageBitmap = function createImageBitmap(image) {
    var args = arguments;
    if (args.length < 1) return Promise.reject(new TypeError("Failed to execute 'createImageBitmap': 1 argument required."));
    var crop = null, options;
    try {
      if (args.length >= 5) {
        crop = [args[1], args[2], args[3], args[4]].map(function (v) { v = +v; if (!isFinite(v)) throw new TypeError("The provided value is non-finite."); return v | 0; }); // WebIDL long (wraps)
        if (!crop[2] || !crop[3]) throw new RangeError("The crop rect width or height is 0.");
        if (crop[2] < 0) { crop[0] += crop[2]; crop[2] = -crop[2]; }
        if (crop[3] < 0) { crop[1] += crop[3]; crop[3] = -crop[3]; }
        options = args[5];
      } else if (args.length >= 2) {
        if (args.length > 2) throw new TypeError("Failed to execute 'createImageBitmap': Valid arities are: [1, 2, 5, 6].");
        options = args[1];
      }
      if (options !== undefined && options !== null && typeof options !== "object") throw new TypeError("The provided options are not an object.");
      options = options || {};
      ["resizeWidth", "resizeHeight"].forEach(function (k) {
        if (options[k] === undefined) return;
        var v = Number(options[k]);
        if (!isFinite(v) || v < 0 || v > 0xffffffff) throw new TypeError("The provided " + k + " is out of range.");
        if (Math.trunc(v) === 0) throw __jb.domError("InvalidStateError", "The " + k + " is 0.");
      });
      if (image instanceof Blob) {
        var blob = image;
        return blob.arrayBuffer().then(function (buf) {
          var dataUrl = "data:" + (blob.type || "image/png") + ";base64," + b64(new Uint8Array(buf));
          var r = __jb.native("canvas", { op: "loadImage", url: dataUrl });
          if (!r || !r.ok) throw __jb.domError("InvalidStateError", "The source image could not be decoded.");
          var decoded = newInternal(ImageBitmap);
          Object.defineProperty(decoded, "_w", { value: r.width }); Object.defineProperty(decoded, "_h", { value: r.height });
          Object.defineProperty(decoded, "_src", { value: { url: dataUrl } }); decoded._closed = false;
          var r3 = __jb.native("canvas", { op: "loadImage", url: dataUrl, space: "display-p3" });
          if (r3 && r3.ok) Object.defineProperty(decoded, "_srcP3", { value: { url: dataUrl, space: "display-p3" } });
          return renderBitmap({ draw: decoded, w: r.width, h: r.height }, crop, options);
        });
      }
      var src = bitmapSource(image);
      return new Promise(function (resolve, reject) {
        // The promise settles in a task, not synchronously.
        setTimeout(function () { try { resolve(renderBitmap(src, crop, options)); } catch (e) { reject(e); } }, 0);
      });
    } catch (e) { return Promise.reject(e); }
  };

  Object.assign(globalThis, { Path2D: Path2D, CanvasGradient: CanvasGradient, CanvasPattern: CanvasPattern, TextMetrics: TextMetrics, ImageData: ImageData, CanvasRenderingContext2D: CanvasRenderingContext2D, OffscreenCanvasRenderingContext2D: OffscreenCanvasRenderingContext2D, OffscreenCanvas: OffscreenCanvas, ImageBitmap: ImageBitmap });
})();
