// Part 6b: the <img> loading model (HTML "Images"): source selection from
// src/srcset/sizes and <picture>/<source>, "update the image data" driven by
// relevant mutations, the list of available images (the host caches probe
// results per URL), currentSrc, naturalWidth/Height, complete, load/error
// events and decode(). Image bytes are fetched by the host `image` op, which
// reports intrinsic sizes when the crate is built with the `images` feature.

// ---- srcset / sizes parsing ----
__jb.parseSrcset = function (input) {
  // "parse a srcset attribute": [{url, w, d}] with w (width descriptor) or d (density).
  var out = [], s = String(input), i = 0, n = s.length;
  var isSpace = function (c) { return c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r"; };
  while (i < n) {
    while (i < n && (isSpace(s[i]) || s[i] === ",")) i++;
    if (i >= n) break;
    var start = i;
    while (i < n && !isSpace(s[i])) i++;
    var url = s.slice(start, i);
    var descriptors = [];
    if (url.slice(-1) === ",") { url = url.replace(/,+$/, ""); }
    else {
      while (i < n && isSpace(s[i])) i++;
      var cur = "", inParens = false, state = "descriptor";
      for (; ; i++) {
        var c = i < n ? s[i] : null;
        if (state === "descriptor") {
          if (c === null) { if (cur) descriptors.push(cur); break; }
          if (isSpace(c)) { if (cur) { descriptors.push(cur); cur = ""; } state = "after"; }
          else if (c === ",") { i++; if (cur) descriptors.push(cur); break; }
          else if (c === "(") { cur += c; state = "parens"; }
          else cur += c;
        } else if (state === "parens") {
          if (c === null) { if (cur) descriptors.push(cur); break; }
          cur += c; if (c === ")") state = "descriptor";
        } else { // after descriptor
          if (c === null) break;
          if (isSpace(c)) continue;
          if (c === ",") { i++; break; }
          cur = c; state = "descriptor"; if (c === "(") state = "parens";
        }
      }
    }
    if (!url) continue;
    var w = null, d = null, h = null, err = false;
    descriptors.forEach(function (desc) {
      var last = desc.slice(-1), num = desc.slice(0, -1);
      if (last === "w" && /^\d+$/.test(num) && +num > 0 && w === null && d === null) w = +num;
      else if (last === "x" && /^-?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/.test(num) && +num >= 0 && w === null && d === null && h === null) d = +num;
      else if (last === "h" && /^\d+$/.test(num) && +num > 0 && h === null && d === null) h = +num;
      else err = true;
    });
    if (err || (h !== null && w === null)) continue;
    out.push({ url: url, w: w, d: d });
  }
  return out;
};
// ---- CSS syntax (tokenizer + component values) for sizes/media conditions ----
__jb.cssTokenize = function (input) {
  var s = String(input).replace(/\r\n?|\f/g, "\n").replace(/\0/g, "�"), i = 0, n = s.length, out = [];
  var isName = function (c) { return /[A-Za-z0-9_\-\u0080-￿]/.test(c); };
  var isNameStart = function (c) { return /[A-Za-z_\u0080-￿]/.test(c); };
  var validEscape = function (a, b) { return a === "\\" && b !== "\n" && b !== undefined && b !== ""; };
  var startsIdent = function (a, b, c) { if (a === "-") return isNameStart(b) || b === "-" || validEscape(b, c); if (isNameStart(a)) return true; return validEscape(a, b); };
  var startsNumber = function (a, b, c) { if (a === "+" || a === "-") return /\d/.test(b) || (b === "." && /\d/.test(c)); if (a === ".") return /\d/.test(b); return /\d/.test(a); };
  var escape = function () { var c = s.charAt(i++); if (/[0-9a-fA-F]/.test(c)) { var h = c; while (h.length < 6 && /[0-9a-fA-F]/.test(s.charAt(i))) h += s.charAt(i++); if (/\s/.test(s.charAt(i))) i++; var cp = parseInt(h, 16); return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "�" : String.fromCodePoint(cp); } return c === "" ? "�" : c; };
  var name = function () { var r = ""; for (;;) { var c = s.charAt(i); if (isName(c) && c !== "") { r += c; i++; } else if (validEscape(c, s.charAt(i + 1))) { i++; r += escape(); } else return r; } };
  var number = function () { var m = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i)); i += m[0].length; return parseFloat(m[0]); };
  while (i < n) {
    var c = s.charAt(i);
    if (c === "/" && s.charAt(i + 1) === "*") { var e = s.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (/[ \t\n]/.test(c)) { while (/[ \t\n]/.test(s.charAt(i)) && i < n) i++; out.push({ t: "ws" }); continue; }
    if (c === '"' || c === "'") { i++; var str = "", bad = false; while (i < n) { var d = s.charAt(i); if (d === c) { i++; break; } if (d === "\n") { bad = true; break; } if (d === "\\") { if (s.charAt(i + 1) === "\n") { i += 2; continue; } i++; str += escape(); continue; } str += d; i++; } out.push({ t: bad ? "bad-string" : "string", v: str }); continue; }
    if (startsNumber(c, s.charAt(i + 1), s.charAt(i + 2))) {
      var num = number();
      if (startsIdent(s.charAt(i), s.charAt(i + 1), s.charAt(i + 2))) out.push({ t: "dim", v: num, u: name().toLowerCase() });
      else if (s.charAt(i) === "%") { i++; out.push({ t: "pct", v: num }); }
      else out.push({ t: "num", v: num });
      continue;
    }
    if (startsIdent(c, s.charAt(i + 1), s.charAt(i + 2))) { var id = name(); if (s.charAt(i) === "(") { i++; out.push({ t: "func", v: id.toLowerCase() }); } else out.push({ t: "ident", v: id }); continue; }
    if (c === "\\") { out.push({ t: "delim", v: c }); i++; continue; }
    i++;
    if ("()[]{},:;".indexOf(c) >= 0) out.push({ t: c }); else out.push({ t: "delim", v: c });
  }
  return out;
};
// Component values: blocks and functions become {t:"block"|"func", ...children}.
__jb.cssComponents = function (tokens) {
  var i = 0;
  var consume = function (end) {
    var list = [];
    while (i < tokens.length) {
      var t = tokens[i++];
      if (end && t.t === end) return list;
      if (t.t === "(" || t.t === "[" || t.t === "{") { var close = { "(": ")", "[": "]", "{": "}" }[t.t]; list.push({ t: "block", open: t.t, c: consume(close) }); }
      else if (t.t === "func") list.push({ t: "fn", v: t.v, c: consume(")") });
      else list.push(t);
    }
    return list;
  };
  return consume(null);
};
// Length in CSS px for a dimension token (null for non-length units).
__jb.cssLengthPx = function (v, u) {
  var vw = globalThis.innerWidth || 1280, vh = globalThis.innerHeight || 720;
  var k = { px: 1, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, in: 96, pt: 96 / 72, pc: 16, em: 16, rem: 16, ex: 8, rex: 8, ch: 8, rch: 8, cap: 11.2, rcap: 11.2, ic: 16, ric: 16, lh: 19.2, rlh: 19.2, vw: vw / 100, svw: vw / 100, lvw: vw / 100, dvw: vw / 100, vi: vw / 100, svi: vw / 100, lvi: vw / 100, dvi: vw / 100, vh: vh / 100, svh: vh / 100, lvh: vh / 100, dvh: vh / 100, vb: vh / 100, svb: vh / 100, lvb: vh / 100, dvb: vh / 100, vmin: Math.min(vw, vh) / 100, svmin: Math.min(vw, vh) / 100, lvmin: Math.min(vw, vh) / 100, dvmin: Math.min(vw, vh) / 100, vmax: Math.max(vw, vh) / 100, svmax: Math.max(vw, vh) / 100, lvmax: Math.max(vw, vh) / 100, dvmax: Math.max(vw, vh) / 100 }[u];
  return k === undefined ? null : v * k;
};
// Math functions (calc/min/max/clamp) over lengths: {len:px} or {num:n} or null.
__jb.cssMathValue = function (node) {
  var nonWs = function (list) { return list.filter(function (x) { return x.t !== "ws"; }); };
  var split = function (list) { var parts = [[]]; list.forEach(function (x) { if (x.t === ",") parts.push([]); else parts[parts.length - 1].push(x); }); return parts; };
  var value = function (x) {
    if (x.t === "num") return { num: x.v };
    if (x.t === "dim") { var px = __jb.cssLengthPx(x.v, x.u); return px === null ? null : { len: px }; }
    if (x.t === "block" && x.open === "(") return sum(x.c);
    if (x.t === "fn") return fn(x);
    return null;
  };
  var sum = function (list) {
    // tokens with whitespace-separated + and -; * and / bind tighter
    var items = [], cur = [];
    for (var k = 0; k < list.length; k++) {
      var x = list[k];
      if (x.t === "delim" && (x.v === "+" || x.v === "-") && list[k - 1] && list[k - 1].t === "ws" && list[k + 1] && list[k + 1].t === "ws") { items.push(cur, x.v); cur = []; }
      else if (x.t !== "ws") cur.push(x);
    }
    items.push(cur);
    var acc = product(items[0]);
    for (var j = 1; j < items.length; j += 2) {
      var rhs = product(items[j + 1]);
      if (!acc || !rhs || ("len" in acc) !== ("len" in rhs)) return null;
      var key = "len" in acc ? "len" : "num", sign = items[j] === "-" ? -1 : 1;
      var r = {}; r[key] = acc[key] + sign * rhs[key]; acc = r;
    }
    return acc;
  };
  var product = function (list) {
    if (!list || !list.length) return null;
    var acc = value(list[0]);
    for (var k = 1; k < list.length; k += 2) {
      var op = list[k], rhs = value(list[k + 1]);
      if (!acc || !rhs || op.t !== "delim" || (op.v !== "*" && op.v !== "/")) return null;
      if (op.v === "*") { if ("len" in acc && "len" in rhs) return null; acc = "len" in acc ? { len: acc.len * rhs.num } : "len" in rhs ? { len: rhs.len * acc.num } : { num: acc.num * rhs.num }; }
      else { if (!("num" in rhs)) return null; acc = "len" in acc ? { len: acc.len / rhs.num } : { num: acc.num / rhs.num }; }
    }
    return acc;
  };
  var fn = function (f) {
    var args = split(f.c).map(function (p) { return sum(p); });
    if (args.some(function (a) { return !a; })) return null;
    var lens = args.every(function (a) { return "len" in a; }), nums = args.every(function (a) { return "num" in a; });
    if (!lens && !nums) return null;
    var key = lens ? "len" : "num", vals = args.map(function (a) { return a[key]; }), r = {};
    if (f.v === "calc") { if (args.length !== 1) return null; r[key] = vals[0]; }
    else if (f.v === "min") r[key] = Math.min.apply(null, vals);
    else if (f.v === "max") r[key] = Math.max.apply(null, vals);
    else if (f.v === "clamp") { if (vals.length !== 3) return null; r[key] = Math.max(vals[0], Math.min(vals[1], vals[2])); }
    else return null;
    return r;
  };
  return node.t === "fn" ? fn(node) : null;
};
// <source-size-value>: a non-negative <length> (math functions clamp) in px, or null.
__jb.sourceSizeValue = function (x) {
  if (x.t === "num") return x.v === 0 ? 0 : null;
  if (x.t === "dim") { var px = __jb.cssLengthPx(x.v, x.u); return px === null || px < 0 ? null : px; }
  if (x.t === "fn" && /^(calc|min|max|clamp)$/.test(x.v)) { var r = __jb.cssMathValue(x); if (!r || !("len" in r) || !isFinite(r.len)) return null; return Math.max(0, r.len); }
  return null;
};
// <media-condition> (no media types): true / false / undefined (unknown), or "invalid".
__jb.evalMediaCondition = function (list) {
  var items = list.filter(function (x) { return x.t !== "ws"; });
  if (!items.length) return "invalid";
  var inParens = function (x) {
    var stray = function (l) { return l.some(function (y) { return y.t === ")" || y.t === "]" || y.t === "}" || ((y.t === "block" || y.t === "fn") && stray(y.c)); }); };
    if ((x.t === "fn" || x.t === "block") && stray(x.c)) return "invalid";
    if (x.t === "fn") return undefined; // <general-enclosed>
    if (x.t !== "block" || x.open !== "(") return "invalid";
    var inner = x.c.filter(function (y) { return y.t !== "ws"; });
    if (inner.length && (inner[0].t === "block" || (inner[0].t === "ident" && /^not$/i.test(inner[0].v)))) { var r = __jb.evalMediaCondition(x.c); return r === "invalid" ? undefined : r; }
    return feature(inner);
  };
  var feature = function (inner) {
    if (!inner.length || inner[0].t !== "ident") return undefined;
    var nm = inner[0].v.toLowerCase();
    if (inner.length === 1) return /^(width|height|color|grid|hover|pointer|orientation|any-hover|any-pointer|prefers-reduced-motion|prefers-color-scheme)$/.test(nm) ? __jb.evalMediaQuery("(" + nm + ")") : undefined;
    if (inner[1].t !== ":" || inner.length !== 3) return undefined;
    var v = inner[2], m = /^(min-|max-)?(width|height)$/.exec(nm);
    if (m) {
      var px = v.t === "num" && v.v === 0 ? 0 : v.t === "dim" ? __jb.cssLengthPx(v.v, v.u) : v.t === "fn" ? (function () { var r = __jb.cssMathValue(v); return r && "len" in r ? r.len : r && r.num === 0 ? 0 : null; })() : null;
      if (px === null) return undefined;
      var actual = m[2] === "width" ? (globalThis.innerWidth || 1280) : (globalThis.innerHeight || 720);
      return m[1] === "min-" ? actual >= px : m[1] === "max-" ? actual <= px : actual === px;
    }
    if (v.t !== "ident") return undefined;
    var known = /^(orientation|hover|any-hover|pointer|any-pointer|prefers-color-scheme|prefers-reduced-motion|scripting|update|color-gamut|display-mode|forced-colors|inverted-colors|prefers-contrast)$/.test(nm);
    return known ? __jb.evalMediaQuery("(" + nm + ": " + v.v + ")") : undefined;
  };
  var not3 = function (a) { return a === undefined ? undefined : !a; };
  if (items[0].t === "ident" && /^not$/i.test(items[0].v)) { if (items.length !== 2) return "invalid"; var r0 = inParens(items[1]); return r0 === "invalid" ? "invalid" : not3(r0); }
  var acc = inParens(items[0]);
  if (acc === "invalid") return "invalid";
  var op = null;
  for (var k = 1; k < items.length; k += 2) {
    var w = items[k];
    if (w.t !== "ident" || !/^(and|or)$/i.test(w.v)) return "invalid";
    var thisOp = w.v.toLowerCase();
    if (op && op !== thisOp) return "invalid";
    op = thisOp;
    if (!items[k + 1]) return "invalid";
    var r = inParens(items[k + 1]);
    if (r === "invalid") return "invalid";
    if (op === "and") acc = acc === false || r === false ? false : acc === undefined || r === undefined ? undefined : true;
    else acc = acc === true || r === true ? true : acc === undefined || r === undefined ? undefined : false;
  }
  return acc;
};
__jb.parseSizes = function (input) {
  // HTML "parse a sizes attribute": px length, "auto", or null (the 100vw default).
  if (input === null || input === undefined) return null;
  var comps = __jb.cssComponents(__jb.cssTokenize(input));
  var entries = [[]];
  comps.forEach(function (x) { if (x.t === ",") entries.push([]); else entries[entries.length - 1].push(x); });
  for (var e = 0; e < entries.length; e++) {
    var list = entries[e].slice();
    while (list.length && list[list.length - 1].t === "ws") list.pop();
    if (!list.length) continue;
    var last = list.pop(), size;
    if (last.t === "ident" && /^auto$/i.test(last.v) && e === entries.length - 1 && !list.filter(function (x) { return x.t !== "ws"; }).length) return "auto";
    size = __jb.sourceSizeValue(last);
    if (size === null) continue;
    while (list.length && list[list.length - 1].t === "ws") list.pop();
    if (!list.length) return size;
    if (__jb.evalMediaCondition(list) === true) return size;
  }
  return null;
};

// ---- source selection ----
__jb.imageDensity = function () { return globalThis.devicePixelRatio || 1; };
__jb.collectImageSources = function (img) {
  // "update the source set": <picture> sources before the img, then the img itself.
  var candidates = null, sizesAttr = null;
  var picture = img.parentNode && img.parentNode.nodeType === 1 && img.parentNode._tag === "picture" && img.parentNode._ns === __jb.HTML_NS ? img.parentNode : null;
  if (picture) {
    for (var c = picture.firstChild; c && c !== img; c = c.nextSibling) {
      if (c.nodeType !== 1 || c._tag !== "source" || c._ns !== __jb.HTML_NS) continue;
      var srcset = c.getAttribute("srcset"); if (srcset === null) continue;
      var set = __jb.parseSrcset(srcset); if (!set.length) continue;
      var media = c.getAttribute("media"); if (media !== null && media.trim() !== "") { try { if (!__jb.evalMediaQuery(media)) continue; } catch (e) { continue; } }
      var type = c.getAttribute("type"); if (type !== null && type.trim() !== "" && !__jb.supportedImageType(type)) continue;
      candidates = set; sizesAttr = c.getAttribute("sizes"); break;
    }
  }
  if (!candidates) {
    var own = img.getAttribute("srcset");
    candidates = own !== null ? __jb.parseSrcset(own) : [];
    sizesAttr = img.getAttribute("sizes");
    var src = img.getAttribute("src");
    if (src !== null && src !== "" && !candidates.some(function (x) { return x.d === 1 && x.w === null; }) && !candidates.some(function (x) { return x.w !== null; })) candidates.push({ url: src, w: null, d: 1, fromSrc: true });
    else if (src !== null && src !== "" && candidates.some(function (x) { return x.w !== null; })) { /* width descriptors: src is only used if there are no candidates */ }
    else if (src !== null && src !== "" && !candidates.length) candidates.push({ url: src, w: null, d: 1, fromSrc: true });
  }
  // Normalise densities: width descriptors become densities against the source size.
  var sourceSize = null;
  if (candidates.some(function (x) { return x.w !== null; })) { sourceSize = __jb.parseSizes(sizesAttr); if (sourceSize === "auto") { var autoBox = img.hasAttribute("loading") && /^lazy$/i.test(img.getAttribute("loading")) && typeof __jb.boxOf === "function" ? __jb.boxOf(img) : null; sourceSize = autoBox ? autoBox.width : null; } if (sourceSize === null) sourceSize = globalThis.innerWidth || 1280; }
  candidates.forEach(function (x) { if (x.w !== null) x.d = sourceSize > 0 ? x.w / sourceSize : Infinity; else if (x.d === null) x.d = 1; });
  // Drop duplicate densities (first wins), resolve URLs.
  var seen = {}, out = [];
  img._imgInvalidUrl = false;
  candidates.forEach(function (x) { var k = String(x.d); if (seen[k]) return; seen[k] = true; var abs = null; try { abs = __jb.resolveURL(x.url, img); } catch (e) { abs = null; } if (!abs) { try { abs = new URL(x.url, __jb.currentDocument.baseURI).href; } catch (e2) { abs = null; } } x.abs = abs || null; if (x.abs !== null) out.push(x); else img._imgInvalidUrl = true; });
  return out;
};
__jb.supportedImageType = function (type) {
  var t = String(type).split(";")[0].trim().toLowerCase();
  return /^image\/(png|jpeg|jpg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml|apng|avif)$/.test(t);
};
__jb.selectImageSource = function (img) {
  var sources = __jb.collectImageSources(img);
  if (!sources.length) return null;
  var dpr = __jb.imageDensity();
  sources.sort(function (a, b) { return a.d - b.d; });
  // Pick the smallest density >= DPR, else the largest.
  var pick = sources.filter(function (x) { return x.d >= dpr; })[0] || sources[sources.length - 1];
  return pick;
};

// ---- update the image data ----
__jb.imageState = function (img) { if (!img._img) img._img = { state: "unavailable", currentSrc: "", naturalWidth: 0, naturalHeight: 0, density: 1, pending: false, lastRequest: null }; return img._img; };
__jb.imageRelevantMutation = function (el, picture) {
  if (el._tag === "img") { __jb.scheduleImageUpdate(el); return; }
  if (el._tag !== "source") return;
  picture = picture || (el.parentNode && el.parentNode.nodeType === 1 && el.parentNode._tag === "picture" ? el.parentNode : null);
  if (!picture) return;
  var after = el.parentNode === picture ? false : true; // a removed source affected every image
  for (var c = picture.firstChild; c; c = c.nextSibling) { if (c === el) { after = true; continue; } if (after && c.nodeType === 1 && c._tag === "img" && c._ns === __jb.HTML_NS) __jb.scheduleImageUpdate(c); }
};
// Insertion/removal steps: img and source elements whose parent is a picture.
__jb.imageTreeMutation = function (node, parent, oldNext) {
  if (!parent || parent.nodeType !== 1 || parent._tag !== "picture" || parent._ns !== __jb.HTML_NS) return;
  if (node._tag === "img") __jb.scheduleImageUpdate(node);
  else if (node._tag === "source") {
    if (node.parentNode === parent) { __jb.imageRelevantMutation(node, parent); return; }
    // Removed source: only the images that followed it are affected.
    for (var c = oldNext || null; c; c = c.nextSibling) if (c.nodeType === 1 && c._tag === "img" && c._ns === __jb.HTML_NS) __jb.scheduleImageUpdate(c);
  }
};
__jb.pendingImages = [];
__jb.availableImages = {};
__jb.scheduleImageUpdate = function (img) {
  var st = __jb.imageState(img);
  // A source already in the list of available images is complete at once; anything else is pending until the update runs.
  var sel = null; try { sel = __jb.selectImageSource(img); } catch (e) { sel = null; }
  if (sel && __jb.availableImages[sel.abs]) { var av = __jb.availableImages[sel.abs]; st.state = "completely available"; st.currentSrc = sel.abs; st.density = sel.d || 1; st.naturalWidth = av.width; st.naturalHeight = av.height; st.intrinsic = av.intrinsic !== false; st.complete = true; st.unknownSize = !!av.unknownSize; }
  else st.complete = false;
  if (st.pending) return;
  st.pending = true;
  __jb.pendingImages.push(img);
  Promise.resolve().then(function () { __jb.flushImageUpdates(); });
};
__jb.flushImageUpdates = function () {
  var list = __jb.pendingImages.splice(0);
  list.forEach(function (img) { var st = __jb.imageState(img); if (st.pending) { st.pending = false; __jb.updateImageData(img); } });
};
__jb.updateImageData = function (img) {
  var st = __jb.imageState(img);
  var hasSrc = img.hasAttribute("src"), src = img.getAttribute("src");
  var selected = __jb.selectImageSource(img);
  var fire = function (type) { setTimeout(function () { __jb.fireUA(img, type); }, 0); };
  if (!selected) {
    var hadSrc = (hasSrc && src === "") || img._imgInvalidUrl;
    st.state = "broken"; st.currentSrc = ""; st.naturalWidth = 0; st.naturalHeight = 0; st.complete = true;
    if (hadSrc) fire("error"); // src="" or an unparsable URL is an error; a missing src has no current request
    return;
  }
  var url = selected.abs;
  st.currentSrc = url; st.density = selected.d || 1;
  var lazy = (img.getAttribute("loading") || "").toLowerCase() === "lazy" && !img.isConnected;
  if (lazy) { st.state = "unavailable"; st.complete = false; return; }
  var known = __jb.availableImages[url];
  if (known) {
    // In the list of available images: completely available at once, load event queued.
    st.state = "completely available"; st.animated = !!known.animated; st.naturalWidth = known.width; st.naturalHeight = known.height; st.intrinsic = known.intrinsic !== false; st.unknownSize = !!known.unknownSize; st.complete = true;
    fire("load");
    __jb.markDirty && __jb.markDirty(img);
    return;
  }
  // The fetch completes in parallel; its result is applied by the networking task, so
  // `complete` stays false until that task runs.
  // the fetch starts now (in the background); the networking task below takes its result
  var hostUrl = typeof __jb.hostImageUrl === "function" ? __jb.hostImageUrl(url) : url;
  // A controlled document's image goes to its service worker first; the worker's response is
  // decoded from a data: URL and taints canvases according to its type.
  var swc = __jb.sw && /^https?:/.test(url) ? __jb.sw.controllerForRequest(url) : null;
  if (swc) {
    if (!img._swFetch || img._swFetch.url !== url) {
      var co = img.getAttribute("crossorigin");
      var imode = co === null ? "no-cors" : "cors", icred = co === null ? "include" : /^use-credentials$/i.test(co) ? "include" : "same-origin";
      var token = img._swFetch = { url: url, done: false, rec: null };
      st.state = "pending"; st.complete = false;
      __jb.sw.handleFetch(swc, { url: url, method: "GET", headers: {}, mode: imode, destination: "image", credentials: icred, redirect: "follow" }, globalThis, "").then(function (rec) {
        if (img._swFetch !== token) return;
        token.done = true; token.rec = rec;
        __jb.updateImageData(img);
      });
      return;
    }
    if (!img._swFetch.done) return;
    var swRec = img._swFetch.rec;
    img._swFetch = null;
    if (swRec === false) { st.state = "broken"; st.complete = true; fire("error"); return; }
    if (swRec) {
      var ctype = (swRec.headers && swRec.headers["content-type"]) || "application/octet-stream";
      hostUrl = "data:" + ctype.split(";")[0] + ";base64," + __jb.bytesToB64(new Uint8Array(swRec.body || []));
      img._swImage = { dataUrl: hostUrl, type: swRec.type };
    } else img._swImage = null;
  } else img._swImage = null;
  // Content Security Policy (img-src): a blocked image fails like a network error
  // mixed content: insecure images are upgraded to https
  var mixedImg = __jb.mixed ? __jb.mixed.filter("image", hostUrl) : { url: hostUrl };
  if (mixedImg.blocked) hostUrl = "about:blank#mixed-blocked"; else hostUrl = mixedImg.url;
  if (__jb.csp && !__jb.csp.allowsRequest("image", url, { element: img })) hostUrl = "about:blank#csp-blocked";
  var fmode = img.hasAttribute("crossorigin") ? "cors" : "no-cors";
  var imgMarkers = { mixed: mixedImg.mode, csp: __jb.csp ? __jb.csp.redirectLists("image") : null };
  try { __jb.native("imageStart", Object.assign({ url: hostUrl, mode: fmode, initiator: __jb.fetchInitiator(), referrerPolicy: __jb.elementReferrerPolicy(img) }, imgMarkers)); } catch (e) {}
  var res = null;
  st.state = "pending"; st.complete = false;
  var seq = st.seq = (st.seq || 0) + 1;
  var apply = function () {
    if (st.seq !== seq || st.state !== "pending") return; // superseded by a later update
    try { res = __jb.native("image", Object.assign({ url: hostUrl, mode: fmode, initiator: __jb.fetchInitiator(), referrerPolicy: __jb.elementReferrerPolicy(img) }, imgMarkers)); } catch (e) { res = { ok: false, status: 0 }; }
    if (res && res.unsupported) { st.state = "completely available"; st.naturalWidth = 0; st.naturalHeight = 0; st.intrinsic = true; st.unknownSize = true; st.complete = true; __jb.availableImages[url] = { width: 0, height: 0, unknownSize: true }; __jb.fireUA(img, "load"); }
    else if (res && res.ok) { st.animated = !!res.animated; st.intrinsic = res.intrinsic !== false; st.state = "completely available"; st.naturalWidth = res.width; st.naturalHeight = res.height; st.type = res.type || ""; st.complete = true; __jb.availableImages[url] = { width: res.width, height: res.height, intrinsic: st.intrinsic, animated: st.animated }; __jb.fireUA(img, "load"); }
    else { st.state = "broken"; st.animated = false; st.naturalWidth = 0; st.naturalHeight = 0; st.complete = true; __jb.fireUA(img, "error"); }
  };
  __jb.imageTasks.push(apply);
  setTimeout(function () { var i = __jb.imageTasks.indexOf(apply); if (i >= 0) __jb.imageTasks.splice(i, 1); apply(); }, 0);
  __jb.markDirty && __jb.markDirty(img);
};
// Images already in the document when the environment initialises.
__jb.initImages = function () {
  try { __jb.descendants(__jb.currentDocument, function (n) { return n.nodeType === 1 && n._tag === "img" && n._ns === __jb.HTML_NS; }).forEach(function (img) { if (img.hasAttribute("src") || img.hasAttribute("srcset") || (img.parentNode && img.parentNode._tag === "picture")) __jb.scheduleImageUpdate(img); }); } catch (e) {}
};
// The window load event waits for pending image requests: run the updates and their networking tasks now.
__jb.imageTasks = [];
__jb.beforeLoadEvent = function () { __jb.flushImageUpdates(); var tasks = __jb.imageTasks.splice(0); tasks.forEach(function (t) { t(); }); if (typeof __jb.fetchCssImages === "function") __jb.fetchCssImages(); };
// The URL requests made by this document carry as their initiator (fetch metadata).
__jb.fetchInitiator = function () { try { var u = String(__jb.currentDocument.URL || location.href); if (/^(about:|blob:|data:)/.test(u) && __jb.currentDocument.baseURI) u = String(__jb.currentDocument.baseURI); return u; } catch (e) { return ""; } };
// CSS images of rules that match an element are fetched before the load event (they delay it).
__jb.cssImageProps = /(?:^|[;{\s])(background(?:-image)?|border-image(?:-source)?|content|cursor|list-style(?:-image)?|mask(?:-image)?|-webkit-mask(?:-image)?)\s*:\s*([^;}]*)/gi;
__jb.fetchedCssImages = {};
__jb.fetchCssImages = function () {
  var urls = [], wpt = !!__jb.wptMode;
  if (!wpt) { try { wpt = !!(globalThis.top && globalThis.top.__jb && globalThis.top.__jb.wptMode); } catch (e) {} }
  var cap = wpt ? 400 : 64;
  var visit = function (rules, base, depth) {
    if (!rules || depth > 4) return;
    for (var i = 0; i < rules.length && urls.length < cap; i++) {
      var r = rules[i];
      if (r.cssRules && r.type !== 1) { visit(r.cssRules, base, depth + 1); continue; }
      if (r.type !== 1 || !r.selectorText) continue;
      var text = r.cssText || "";
      if (text.indexOf("url(") < 0) continue;
      var matched = false;
      try { matched = !!__jb.currentDocument.querySelector(r.selectorText); } catch (e) { matched = false; }
      if (!matched) continue;
      var body = text.slice(text.indexOf("{"));
      var m; __jb.cssImageProps.lastIndex = 0;
      while ((m = __jb.cssImageProps.exec(body))) {
        var re = /url\(\s*(['"]?)(.*?)\1\s*\)/g, u;
        while ((u = re.exec(m[2]))) {
          if (!u[2] || /^(data:|#)/i.test(u[2])) continue;
          var abs; try { abs = new URL(u[2], base).href; } catch (e2) { continue; }
          if (/^https?:/.test(abs) && urls.indexOf(abs) < 0 && !__jb.fetchedCssImages[abs]) urls.push(abs);
        }
      }
    }
  };
  try {
    var sheets = __jb.currentDocument.styleSheets;
    for (var i = 0; i < sheets.length; i++) { var sh = sheets[i], rules = null; try { rules = sh.cssRules; } catch (e) { rules = null; } visit(rules, sh.href || __jb.currentDocument.baseURI, 0); }
  } catch (e) { return; }
  if (!urls.length) return;
  var initiator = __jb.fetchInitiator();
  urls.forEach(function (u) { __jb.fetchedCssImages[u] = true; try { __jb.native("imageStart", { url: u, mode: "no-cors", initiator: initiator }); } catch (e) {} });
  // On test pages the load event waits for them (as in browsers); real pages keep loading.
  if (wpt) urls.forEach(function (u) { try { __jb.native("image", { url: u, mode: "no-cors", initiator: initiator }); } catch (e) {} });
};

// ---- IDL ----
(function () {
  var protos = [HTMLElement.prototype].concat(typeof HTMLImageElement === "function" ? [HTMLImageElement.prototype] : []);
  var define = function (name, desc) { protos.forEach(function (p) { Object.defineProperty(p, name, Object.assign({ configurable: true }, desc)); }); };
  var rendered = function (img, axis) {
    // Rendered size: layout box if available, else the width/height attributes, else the natural size.
    try { if (img.isConnected && typeof __jb.layoutQuery === "function") { var r = typeof __jb.boxOf === "function" ? __jb.boxOf(img) : null; if (r) { var b = r.border || [0, 0, 0, 0], p = r.padding || [0, 0, 0, 0]; var cw = Math.max(0, Math.round(axis === "w" ? r.width - b[1] - b[3] - p[1] - p[3] : r.height - b[0] - b[2] - p[0] - p[2])); if (cw > 0) return cw; } } } catch (e) {}
    var attr = img.getAttribute(axis === "w" ? "width" : "height");
    if (attr !== null && /^\s*\+?\d+/.test(attr)) { var n = parseInt(attr, 10); if (n >= 0) return n; }
    var st = __jb.imageState(img);
    if (st.state === "completely available" && st.intrinsic === false) return axis === "w" ? st.naturalWidth : st.naturalHeight; // no aspect ratio to keep
    if (st.naturalWidth && st.naturalHeight) {
      var other = img.getAttribute(axis === "w" ? "height" : "width");
      if (other !== null && /^\s*\+?\d+/.test(other)) { var o = parseInt(other, 10); return Math.round(axis === "w" ? o * st.naturalWidth / st.naturalHeight : o * st.naturalHeight / st.naturalWidth); }
      return Math.round(axis === "w" ? st.naturalWidth / st.density : st.naturalHeight / st.density);
    }
    return 0;
  };
  define("naturalWidth", { get: function () { if (this._tag !== "img") return undefined; var st = __jb.imageState(this); return st.state === "completely available" ? Math.round(st.naturalWidth / st.density) : 0; } });
  define("naturalHeight", { get: function () { if (this._tag !== "img") return undefined; var st = __jb.imageState(this); return st.state === "completely available" ? Math.round(st.naturalHeight / st.density) : 0; } });
  define("currentSrc", { get: function () { if (this._tag !== "img") return undefined; return __jb.imageState(this).currentSrc; } });
  define("complete", {
    get: function () {
      if (this._tag !== "img") return undefined;
      var st = __jb.imageState(this);
      var hasSource = this.hasAttribute("src") || this.hasAttribute("srcset") || (this.parentNode && this.parentNode.nodeType === 1 && this.parentNode._tag === "picture");
      if (!hasSource) return true;
      if (this.hasAttribute("src") && this.getAttribute("src") === "" && !this.hasAttribute("srcset")) return true;
      return !!st.complete && (st.state === "completely available" || st.state === "broken");
    },
  });
  define("width", { get: function () { return this._tag === "img" ? rendered(this, "w") : (parseInt(this.getAttribute("width"), 10) || 0); }, set: function (v) { this.setAttribute("width", String(Math.max(0, Number(v) >>> 0))); } });
  define("height", { get: function () { return this._tag === "img" ? rendered(this, "h") : (parseInt(this.getAttribute("height"), 10) || 0); }, set: function (v) { this.setAttribute("height", String(Math.max(0, Number(v) >>> 0))); } });
  define("decode", {
    value: function () {
      var img = this;
      if (img._tag !== "img") return Promise.resolve();
      return new Promise(function (resolve, reject) {
        var check = function () {
          var st = __jb.imageState(img);
          if (st.pending) { setTimeout(check, 0); return; }
          if (st.state === "completely available") resolve();
          else reject(__jb.domError("EncodingError", "The source image cannot be decoded."));
        };
        setTimeout(check, 0);
      });
    },
    writable: true,
  });
})();

// ---- other element-initiated fetches: link icon/prefetch, input type=image, embed ----
(function () {
  var isWpt = function () { if (__jb.wptMode) return true; try { return !!(globalThis.top && globalThis.top.__jb && globalThis.top.__jb.wptMode); } catch (e) { return false; } };
  var abs = function (el, attr) { var v = el.getAttribute(attr); if (v === null || String(v).trim() === "") return null; try { var u = new URL(String(v).trim(), el.baseURI).href; return /^https?:/.test(u) ? u : null; } catch (e) { return null; } };
  var origin = function () { try { return location.origin; } catch (e) { return undefined; } };
  function kick(el) {
    if (el.nodeType !== 1 || el._ns !== __jb.HTML_NS || (!el.isConnected && !el._jbLinkHeader)) return;
    var tag = el._tag;
    if (tag === "link") {
      if (!isWpt()) {
        // Real pages: preloads are not fetched here (the later <link rel=stylesheet>/<script> fetches
        // the resource), but loaders wait for the preload's load event: webpack's CSS chunk loader
        // inserts <link rel=preload as=style> and awaits onload, "onload=this.rel='stylesheet'"
        // async CSS does the same.
        var rrels = (el.getAttribute("rel") || "").toLowerCase().split(/[\t\n\f\r ]+/), rhref = abs(el, "href");
        if (!rhref || el._jbKicked === rhref || (rrels.indexOf("preload") < 0 && rrels.indexOf("modulepreload") < 0)) return;
        el._jbKicked = rhref;
        setTimeout(function () { if (el._jbKicked === rhref && el.isConnected) __jb.fireUA(el, "load"); }, 0);
        return;
      }
      var rels = (el.getAttribute("rel") || "").toLowerCase().split(/[\t\n\f\r ]+/), href = abs(el, "href");
      if (!href || el._jbKicked === href) return;
      var cors = el.hasAttribute("crossorigin");
      if (rels.indexOf("preload") >= 0) {
        // HTML "preload": the destination comes from `as`; an unknown `as`, an unsupported
        // `type` or a non-matching `media` means no fetch
        var asv = (el.getAttribute("as") || "").trim().toLowerCase();
        var DEST = { audio: "audio", fetch: "empty", font: "font", image: "image", json: "json", script: "script", style: "style", track: "track", video: "video", worker: "worker", sharedworker: "sharedworker", serviceworker: "serviceworker" };
        var dest = DEST[asv];
        if (!dest) return;
        var type = (el.getAttribute("type") || "").trim().toLowerCase().split(";")[0].trim();
        if (type) {
          var okType = dest === "style" ? type === "text/css" : dest === "script" ? /^(text|application)\/(javascript|ecmascript|x-javascript|x-ecmascript)$/.test(type) || type === "module" : dest === "image" ? /^image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml|bmp|x-icon|vnd\.microsoft\.icon|apng)$/.test(type) : dest === "font" ? /^(font\/(woff|woff2|ttf|otf|collection|sfnt)|application\/(font-woff|x-font-ttf|x-font-woff|vnd\.ms-fontobject))$/.test(type) : dest === "json" ? type === "application/json" : true;
          if (!okType) return;
        }
        var media = el.getAttribute("media");
        if (media && typeof matchMedia === "function") { try { if (!matchMedia(media).matches) return; } catch (e) {} }
        el._jbKicked = href;
        var corsMode = cors || dest === "empty" || dest === "font" || dest === "json";
        if (__jb.rtHints) __jb.rtHints[href] = { type: "link", dest: dest === "empty" ? "" : dest, preload: true };
        setTimeout(function () {
          if (el._jbKicked !== href) return;
          var ok = false;
          try {
            if (dest === "image") { var ri = __jb.native("image", { url: href, dest: "image", preload: true, mode: cors ? "cors" : "no-cors", initiator: __jb.fetchInitiator(), referrerPolicy: __jb.elementReferrerPolicy ? __jb.elementReferrerPolicy(el) : "" }); ok = !!(ri && (ri.ok || ri.unsupported || ri.decode)); }
            else { var rf = __jb.native("fetch", { url: href, method: "GET", headers: {}, preload: true, mode: corsMode ? "cors" : "no-cors", dest: dest, origin: origin(), credentials: !cors || (el.getAttribute("crossorigin") || "").toLowerCase() === "use-credentials" ? "include" : "same-origin", referrerPolicy: __jb.elementReferrerPolicy ? __jb.elementReferrerPolicy(el) : "" }); ok = !!(rf && rf.status >= 200 && rf.status < 300); }
          } catch (e) { ok = false; }
          if (el._jbKicked !== href) return;
          __jb.fireUA(el, ok ? "load" : "error");
        }, 0);
        return;
      }
      if (rels.indexOf("icon") >= 0) { el._jbKicked = href; setTimeout(function () { try { __jb.native("image", { url: href, dest: "empty", mode: cors ? "cors" : "no-cors", initiator: __jb.fetchInitiator() }); } catch (e) {} }, 0); }
      else if (rels.indexOf("manifest") >= 0) {
        el._jbKicked = href;
        if (__jb.rtHints) __jb.rtHints[href] = "link";
        setTimeout(function () { try { __jb.native("fetch", { url: href, method: "GET", headers: {}, mode: "cors", dest: "manifest", origin: origin(), credentials: el.getAttribute("crossorigin") === "use-credentials" ? "include" : "omit" }); } catch (e) {} }, 0);
      }
      else if (rels.indexOf("modulepreload") >= 0) {
        // HTML "modulepreload": a non-script-like known destination fails without a fetch
        el._jbKicked = href;
        var mas = (el.getAttribute("as") || "").trim().toLowerCase();
        var NON_SCRIPT = { audio: 1, document: 1, embed: 1, font: 1, frame: 1, iframe: 1, image: 1, manifest: 1, object: 1, report: 1, track: 1, video: 1, webidentity: 1, xslt: 1, fetch: 1 };
        var SCRIPT_LIKE = { audioworklet: 1, paintworklet: 1, script: 1, serviceworker: 1, sharedworker: 1, worker: 1 };
        if (NON_SCRIPT[mas]) { setTimeout(function () { if (el._jbKicked === href) __jb.fireUA(el, "error"); }, 0); return; }
        var mdest = SCRIPT_LIKE[mas] || mas === "style" || mas === "json" || mas === "text" ? mas : "script";
        var mmedia = el.getAttribute("media");
        if (mmedia && typeof matchMedia === "function") { try { if (!matchMedia(mmedia).matches) return; } catch (e) {} }
        var minteg = el.getAttribute("integrity");
        var mco = el.getAttribute("crossorigin");
        if (__jb.rtHints) __jb.rtHints[href] = "other";
        setTimeout(function () {
          if (el._jbKicked !== href) return;
          var ok = false;
          try {
            var mxo = false; try { mxo = new URL(href).origin !== location.origin; } catch (e0) {}
            var rm = __jb.native("fetch", { url: href, method: "GET", headers: mxo ? { Origin: location.origin } : {}, preload: true, mode: "cors", dest: mdest === "text" ? "script" : mdest, origin: origin(), credentials: mco !== null && /^use-credentials$/i.test(mco) ? "include" : "same-origin", referrerPolicy: __jb.elementReferrerPolicy ? __jb.elementReferrerPolicy(el) : "" });
            var mct = rm && rm.headers ? String(rm.headers["content-type"] || rm.headers["Content-Type"] || "").split(";")[0].trim().toLowerCase() : "";
            var mimeOk = mdest === "text" ? true : mdest === "style" ? mct === "text/css" : mdest === "json" ? mct === "application/json" || /\+json$/.test(mct) || mct === "text/json" : /^(text|application)\/(javascript|ecmascript|x-javascript|x-ecmascript|javascript1\.[0-5]|jscript|livescript)$/.test(mct);
            ok = !!(rm && rm.status >= 200 && rm.status < 300 && mimeOk) && (!minteg || __jb.sriMatches(minteg, rm));
          } catch (e) { ok = false; }
          if (el._jbKicked !== href) return;
          __jb.fireUA(el, ok ? "load" : "error");
        }, 0);
      }
      else if (rels.indexOf("prefetch") >= 0) {
        if (__jb.rtHints) __jb.rtHints[href] = "link";
        el._jbKicked = href;
        var as = (el.getAttribute("as") || "").toLowerCase();
        setTimeout(function () { try { __jb.native("fetch", { url: href, method: "GET", headers: {}, mode: cors ? "cors" : "no-cors", dest: as || "empty", origin: origin(), credentials: !cors || (el.getAttribute("crossorigin") || "").toLowerCase() === "use-credentials" }); } catch (e) {} }, 0);
      }
    } else if (tag === "input" && __jb.inputType(el) === "image") {
      var src = abs(el, "src");
      if (!src || el._jbKicked === src) return;
      el._jbKicked = src;
      if (__jb.rtHints) __jb.rtHints[src] = "input";
      setTimeout(function () {
        var r = null; try { r = __jb.native("image", { url: src, mode: "no-cors", initiator: __jb.fetchInitiator() }); } catch (e) {}
        if (el._jbKicked !== src) return;
        __jb.fireUA(el, r && (r.ok || r.unsupported) ? "load" : "error");
      }, 0);
    } else if (tag === "embed") {
      var esrc = abs(el, "src");
      if (!esrc || el._jbKicked === esrc) return;
      el._jbKicked = esrc;
      setTimeout(function () {
        var r = null; try { r = __jb.native("fetch", { url: esrc, method: "GET", headers: {}, mode: "no-cors", dest: "embed", origin: origin() }); } catch (e) {}
        if (el._jbKicked !== esrc) return;
        if (r && r.status) __jb.fireUA(el, "load");
      }, 0);
    } else if (tag === "object" && isWpt()) {
      // <object data>: fetched with destination "object"; load on success, error otherwise
      var odata = abs(el, "data");
      if (!odata || el._jbKicked === odata) return;
      el._jbKicked = odata;
      setTimeout(function () {
        if (el._jbKicked !== odata || !el.isConnected) return;
        var r = null; try { r = __jb.native("fetch", { url: odata, method: "GET", headers: {}, mode: "no-cors", dest: "object", origin: origin() }); } catch (e) {}
        if (el._jbKicked !== odata) return;
        __jb.fireUA(el, r && r.status >= 200 && r.status < 400 ? "load" : "error");
      }, 0);
    }
  }
  // elements of the initial markup (test pages only: real pages keep their previous loading)
  __jb.initOtherFetches = function () {
    if (!isWpt()) return;
    var doc = __jb.currentDocument;
    if (!doc || !doc.documentElement) return;
    Array.prototype.forEach.call(doc.querySelectorAll("link,input,embed,object"), kick);
    var body = doc.body;
    if (body && body._tag === "body") kickBodyBackground(body);
    // Link response headers (preload, modulepreload, prefetch): processed like <link> elements
    // once the document's headers are attached
    setTimeout(function () {
      var h = doc._responseHeaders, v = h && (h.link || h.Link);
      if (!v) return;
      __jb.parseLinkHeader(String(v)).forEach(function (l) {
        var el = doc.createElement("link");
        el._jbLinkHeader = true;
        Object.keys(l.params).forEach(function (k) { if (k !== "href") { try { el.setAttribute(k, l.params[k]); } catch (e) {} } });
        try { el.setAttribute("href", new URL(l.url, doc.URL).href); } catch (e) { return; }
        kick(el);
      });
    }, 0);
  };
  // Subresource Integrity: the response body matches one of the strongest listed digests
  // (no usable metadata: matches)
  __jb.sriMatches = function (integrity, r) {
    var rank = { sha256: 1, sha384: 2, sha512: 3 };
    var toks = String(integrity || "").trim().split(/[\t\n\f\r ]+/).map(function (t) {
      var m = /^(sha256|sha384|sha512)-([A-Za-z0-9+\/_-]+={0,2})(\?.*)?$/i.exec(t);
      return m ? { alg: m[1].toLowerCase(), val: m[2] } : null;
    }).filter(Boolean);
    if (!toks.length) return true;
    var best = Math.max.apply(null, toks.map(function (t) { return rank[t.alg]; }));
    var data = r.bodyBase64 !== undefined ? r.bodyBase64 : __jb.bytesToB64(new TextEncoder().encode(r.text || ""));
    var norm = function (v) { return String(v).replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, ""); };
    return toks.filter(function (t) { return rank[t.alg] === best; }).some(function (t) {
      var d = null; try { d = __jb.native("crypto", { op: "digest", algorithm: "SHA-" + t.alg.slice(3), data: data }); } catch (e) {}
      return !!(d && d.bytes && norm(d.bytes) === norm(t.val));
    });
  };
  // RFC 8288 Link header: <uri>; param=value; param="quoted", ...
  __jb.parseLinkHeader = function (s) {
    var out = [], i = 0, n = s.length;
    while (i < n) {
      while (i < n && /[\s,]/.test(s[i])) i++;
      if (s[i] !== "<") { var c = s.indexOf(",", i); if (c < 0) break; i = c + 1; continue; }
      var e = s.indexOf(">", i);
      if (e < 0) break;
      var link = { url: s.slice(i + 1, e).trim(), params: {} };
      i = e + 1;
      for (;;) {
        while (i < n && /\s/.test(s[i])) i++;
        if (s[i] !== ";") break;
        i++;
        while (i < n && /\s/.test(s[i])) i++;
        if (s[i] === ";") continue; // empty parameter
        var m = /^[^=;,\s]+/.exec(s.slice(i));
        if (!m) break;
        var name = m[0].toLowerCase(), val = "";
        i += m[0].length;
        while (i < n && /\s/.test(s[i])) i++;
        if (s[i] === "=") {
          i++;
          while (i < n && /\s/.test(s[i])) i++;
          if (s[i] === '"') {
            i++;
            while (i < n && s[i] !== '"') { if (s[i] === "\\" && i + 1 < n) i++; val += s[i]; i++; }
            i++;
          } else { var m2 = /^[^;,]*/.exec(s.slice(i)); val = m2[0].trim(); i += m2[0].length; }
        }
        if (!(name in link.params)) link.params[name] = val;
      }
      out.push(link);
    }
    return out;
  };
  // <body background>: an image request with initiator "body"
  function kickBodyBackground(body) {
    var bg = abs(body, "background");
    if (!bg || body._jbBgKicked === bg) return;
    body._jbBgKicked = bg;
    if (__jb.rtHints) __jb.rtHints[bg] = "body";
    setTimeout(function () { try { __jb.native("image", { url: bg, dest: "image", mode: "no-cors", initiator: __jb.fetchInitiator() }); } catch (e) {} }, 0);
  }
  var baseConnected = __jb.connected;
  __jb.connected = function (node) {
    baseConnected(node);
    if (node.nodeType !== 1) return;
    kick(node);
    if (node._tag === "body" && node._ns === __jb.HTML_NS && isWpt()) kickBodyBackground(node);
    if (node.firstElementChild) Array.prototype.forEach.call(node.querySelectorAll("link,input,embed,object"), kick);
  };
  var baseAttrChanged = __jb.attributeChanged;
  __jb.attributeChanged = function (el, attr, oldValue, newValue) {
    var r = baseAttrChanged.apply(this, arguments);
    var n = attr && attr._ns === null ? attr._local : null;
    if ((n === "src" || n === "href" || n === "rel" || n === "type" || n === "data") && el._ns === __jb.HTML_NS && /^(link|input|embed|object)$/.test(el._tag)) kick(el);
    return r;
  };
})();
