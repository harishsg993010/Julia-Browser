// ---------------------------------------------------------------- CSS property values (CSSOM)
// Validation and canonical serialization of specified values for properties with a parser here
// (__jb.cssLong), and shorthands that expand into longhands (__jb.cssShort). Other properties keep
// the value as given. Used by CSSStyleDeclaration (setProperty / getPropertyValue / removeProperty)
// and CSS.supports().
(function () {
  var LONG = __jb.cssLong = Object.create(null);
  var SHORT = __jb.cssShort = Object.create(null);
  var WIDE = /^(initial|inherit|unset|revert|revert-layer)$/i;
  var NUM = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?";
  var fmtNum = function (n) { var r = Math.round(n * 1e6) / 1e6; return String(Object.is(r, -0) ? 0 : r); };

  // ---- tokenizer helpers
  // split on top-level commas; null if a component is empty
  var commaList = function (s) {
    var out = [], depth = 0, cur = "", q = null;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (q) { cur += c; if (c === "\\") { cur += s.charAt(++i); continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === "(") depth++; else if (c === ")") depth--;
      if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
      cur += c;
    }
    out.push(cur.trim());
    return out.some(function (x) { return x === ""; }) ? null : out;
  };
  // split a component into top-level whitespace-separated tokens (functions and strings stay whole)
  var tokens = function (s) {
    var out = [], depth = 0, cur = "", q = null;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (q) { cur += c; if (c === "\\") { cur += s.charAt(++i); continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === "(") depth++; else if (c === ")") depth--;
      if (/\s/.test(c) && depth === 0) { if (cur) out.push(cur); cur = ""; continue; }
      cur += c;
    }
    if (cur) out.push(cur);
    return out;
  };
  var IDENT = /^-?(?:[a-zA-Z_\u0080-\uffff]|\\.)(?:[a-zA-Z0-9_\u0080-\uffff-]|\\.)*$|^--(?:[a-zA-Z0-9_\u0080-\uffff-]|\\.)*$/;
  var isIdent = function (t) { return IDENT.test(t); };
  var unescapeIdent = function (t) { return t.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, function (m, h, c) { return h ? String.fromCodePoint(parseInt(h, 16)) : c; }); };
  // serialize an identifier (CSSOM "serialize an identifier")
  var serializeIdent = function (s) {
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i), code = s.charCodeAt(i);
      if (code === 0) { out += "\ufffd"; continue; }
      if ((code >= 1 && code <= 0x1f) || code === 0x7f || (i === 0 && code >= 0x30 && code <= 0x39) || (i === 1 && code >= 0x30 && code <= 0x39 && s.charAt(0) === "-")) { out += "\\" + code.toString(16) + " "; continue; }
      if (i === 0 && c === "-" && s.length === 1) { out += "\\-"; continue; }
      if (code >= 0x80 || c === "-" || c === "_" || /[a-zA-Z0-9]/.test(c)) { out += c; continue; }
      out += "\\" + c;
    }
    return out;
  };
  var serializeString = function (s) { return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\u0001-\u001f\u007f]/g, function (c) { return "\\" + c.charCodeAt(0).toString(16) + " "; }) + '"'; };
  var parseString = function (t) {
    var m = /^(["'])([\s\S]*)\1$/.exec(t); if (!m) return null;
    return m[2].replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, function (x, h, c) { return h ? String.fromCodePoint(parseInt(h, 16)) : c; });
  };

  // ---- value types
  var time = function (t, nonNeg) {
    var m = new RegExp("^(" + NUM + ")(s|ms)$", "i").exec(t);
    if (!m) { var c = /^calc\((.*)\)$/i.exec(t); if (c) { var inner = time(c[1].trim(), false); if (inner !== null) return "calc(" + inner + ")"; } return null; }
    var n = parseFloat(m[1]);
    if (nonNeg && n < 0) return null;
    return fmtNum(n) + m[2].toLowerCase();
  };
  var EASE_KW = /^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/i;
  var easing = function (t) {
    if (EASE_KW.test(t)) return t.toLowerCase();
    var m = /^cubic-bezier\((.*)\)$/i.exec(t);
    if (m) {
      var a = m[1].split(",").map(function (x) { return x.trim(); });
      if (a.length !== 4 || !a.every(function (x) { return new RegExp("^" + NUM + "$").test(x); })) return null;
      var v = a.map(parseFloat);
      if (v[0] < 0 || v[0] > 1 || v[2] < 0 || v[2] > 1) return null;
      return "cubic-bezier(" + v.map(fmtNum).join(", ") + ")";
    }
    m = /^steps\((.*)\)$/i.exec(t);
    if (m) {
      var p = m[1].split(",").map(function (x) { return x.trim(); });
      if (p.length < 1 || p.length > 2 || !/^\+?\d+$/.test(p[0])) return null;
      var n = parseInt(p[0], 10), pos = (p[1] || "end").toLowerCase();
      if (!/^(start|end|jump-start|jump-end|jump-none|jump-both)$/.test(pos)) return null;
      if (n < 1 || (pos === "jump-none" && n < 2)) return null;
      return pos === "end" || pos === "jump-end" ? "steps(" + n + ")" : "steps(" + n + ", " + pos + ")";
    }
    m = /^linear\((.*)\)$/i.exec(t);
    if (m) { var ok = __jb.anim && __jb.anim.parseEasing ? __jb.anim.parseEasing(t) : true; if (!ok) return null; return "linear(" + m[1].split(",").map(function (x) { return x.trim().split(/\s+/).join(" "); }).join(", ") + ")"; }
    return null;
  };
  __jb.cssEasing = easing;
  var lengthPct = function (t) {
    if (t === "0") return "0px";
    var m = new RegExp("^(" + NUM + ")(px|em|rem|ex|ch|vw|vh|vmin|vmax|cm|mm|in|pt|pc|q|%)$", "i").exec(t);
    if (m) return fmtNum(parseFloat(m[1])) + (m[2] === "%" ? "%" : m[2].toLowerCase());
    var c = /^calc\((.*)\)$/i.exec(t);
    if (c) {
      var parts = c[1].trim().split(/\s+([+-])\s+/);
      if (parts.length === 3) { var a = lengthPct(parts[0]), b = lengthPct(parts[2]); if (a && b) { var pa = /%$/.test(a), pb = /%$/.test(b); if (pb && !pa && parts[1] === "+") { var x = a; a = b; b = x; } return "calc(" + a + " " + parts[1] + " " + b + ")"; } }
      return null;
    }
    return null;
  };
  // list longhand from a single-item parser
  var listOf = function (one, allowNoneAlone) {
    return function (v) {
      var items = commaList(v); if (!items) return null;
      var out = [];
      for (var i = 0; i < items.length; i++) { var r = one(items[i], items.length); if (r === null) return null; out.push(r); }
      return out.join(", ");
    };
  };
  var kw = function (re) { return function (t) { t = t.trim(); return re.test(t) ? t.toLowerCase() : null; }; };

  // ---- transitions
  var transitionPropertyItem = function (t, n) {
    t = t.trim();
    if (tokens(t).length !== 1) return null;
    if (/^none$/i.test(t)) return n === 1 ? "none" : null;
    if (/^all$/i.test(t)) return "all";
    if (!isIdent(t) || WIDE.test(t) || /^default$/i.test(t)) return null;
    return /^--/.test(t) ? t : t.toLowerCase().indexOf("-") === 0 && !LONG_KNOWN(t) ? t : (__jb.KNOWN_CSS_PROPERTIES && __jb.KNOWN_CSS_PROPERTIES[t.toLowerCase()] ? t.toLowerCase() : t);
  };
  var LONG_KNOWN = function (t) { return __jb.KNOWN_CSS_PROPERTIES && __jb.KNOWN_CSS_PROPERTIES[t.toLowerCase()]; };
  LONG["transition-property"] = listOf(transitionPropertyItem);
  LONG["transition-duration"] = listOf(function (t) { return tokens(t).length === 1 ? time(t, true) : null; });
  LONG["transition-delay"] = listOf(function (t) { return tokens(t).length === 1 ? time(t, false) : null; });
  LONG["transition-timing-function"] = listOf(function (t) { return tokens(t).length === 1 ? easing(t) : null; });
  LONG["transition-behavior"] = listOf(kw(/^(normal|allow-discrete)$/i));
  var parseSingleTransition = function (item, count) {
    var r = {}, toks = tokens(item);
    if (!toks.length) return null;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i], tv = time(t, false);
      if (tv !== null) { if (r.duration === undefined) { if (/^-/.test(tv)) return null; r.duration = tv; } else if (r.delay === undefined) r.delay = tv; else return null; continue; }
      var e = easing(t);
      if (e !== null && r.timing === undefined) { r.timing = e; continue; }
      if (/^(normal|allow-discrete)$/i.test(t)) { if (r.behavior !== undefined) return null; r.behavior = t.toLowerCase(); continue; }
      if (r.property !== undefined) return null;
      var p = transitionPropertyItem(t, count);
      if (p === null) { if (/^none$/i.test(t) && count > 1) return null; return null; }
      r.property = p;
    }
    return r;
  };
  SHORT.transition = {
    longhands: ["transition-property", "transition-duration", "transition-timing-function", "transition-delay", "transition-behavior"],
    expand: function (v) {
      var items = commaList(v); if (!items) return null;
      var parsed = items.map(function (it) { return parseSingleTransition(it, items.length); });
      if (parsed.some(function (x) { return x === null; })) return null;
      if (items.length > 1 && parsed.some(function (x) { return x.property === "none"; })) return null;
      var col = function (k, d) { return parsed.map(function (x) { return x[k] === undefined ? d : x[k]; }).join(", "); };
      return { "transition-property": col("property", "all"), "transition-duration": col("duration", "0s"), "transition-timing-function": col("timing", "ease"), "transition-delay": col("delay", "0s"), "transition-behavior": col("behavior", "normal") };
    },
    serialize: function (get) {
      var lists = this.longhands.map(function (l) { return commaList(get(l)) || []; });
      var n = lists[0].length;
      if (!lists.every(function (l) { return l.length === n; })) return "";
      var out = [];
      for (var i = 0; i < n; i++) {
        var p = lists[0][i], d = lists[1][i], tf = lists[2][i], dl = lists[3][i], b = lists[4][i], parts = [];
        if (p !== "all") parts.push(p);
        if (d !== "0s" || dl !== "0s") parts.push(d);
        if (tf !== "ease") parts.push(tf);
        if (dl !== "0s") parts.push(dl);
        if (b !== "normal") parts.push(b);
        out.push(parts.length ? parts.join(" ") : "all");
      }
      return out.join(", ");
    },
  };

  // ---- animations
  var nameItem = function (t, n) {
    t = t.trim();
    if (tokens(t).length !== 1) return null;
    if (/^none$/i.test(t)) return "none";
    var str = parseString(t);
    if (str !== null) {
      if (str === "") return null;
      if (/^(none|initial|inherit|unset|revert|revert-layer|default)$/i.test(str)) return serializeString(str);
      return serializeIdent(str);
    }
    if (!isIdent(t) || WIDE.test(t) || /^default$/i.test(t)) return null;
    return serializeIdent(unescapeIdent(t));
  };
  LONG["animation-name"] = listOf(nameItem);
  LONG["animation-duration"] = listOf(function (t) { t = t.trim(); if (/^auto$/i.test(t)) return "auto"; return tokens(t).length === 1 ? time(t, true) : null; });
  LONG["animation-delay"] = listOf(function (t) { return tokens(t).length === 1 ? time(t.trim(), false) : null; });
  LONG["animation-timing-function"] = listOf(function (t) { return tokens(t).length === 1 ? easing(t.trim()) : null; });
  var iterCount = function (t) { t = t.trim(); if (/^infinite$/i.test(t)) return "infinite"; var m = new RegExp("^" + NUM + "$").exec(t); if (!m) { var c = /^calc\((.*)\)$/i.exec(t); if (c && new RegExp("^" + NUM + "$").test(c[1].trim())) return "calc(" + fmtNum(parseFloat(c[1])) + ")"; return null; } var n = parseFloat(t); return n < 0 ? null : fmtNum(n); };
  LONG["animation-iteration-count"] = listOf(iterCount);
  LONG["animation-direction"] = listOf(kw(/^(normal|reverse|alternate|alternate-reverse)$/i));
  LONG["animation-fill-mode"] = listOf(kw(/^(none|forwards|backwards|both)$/i));
  LONG["animation-play-state"] = listOf(kw(/^(running|paused)$/i));
  LONG["animation-composition"] = listOf(kw(/^(replace|add|accumulate)$/i));
  var timelineItem = function (t) {
    t = t.trim();
    if (/^(auto|none)$/i.test(t)) return t.toLowerCase();
    if (/^--/.test(t) && isIdent(t)) return t;
    var m = /^(scroll|view)\((.*)\)$/i.exec(t);
    if (m) { var args = tokens(m[2].trim()).map(function (x) { return x.toLowerCase(); }); return m[1].toLowerCase() + "(" + args.join(" ") + ")"; }
    return null;
  };
  LONG["animation-timeline"] = listOf(timelineItem);
  var RANGE_NAMES = /^(cover|contain|entry|exit|entry-crossing|exit-crossing|scroll)$/i;
  var rangeItem = function (isEnd) {
    return function (t) {
      var toks = tokens(t.trim());
      if (toks.length === 1 && /^normal$/i.test(toks[0])) return "normal";
      if (toks.length === 1) { if (RANGE_NAMES.test(toks[0])) return toks[0].toLowerCase(); var l = lengthPct(toks[0]); return l; }
      if (toks.length === 2 && RANGE_NAMES.test(toks[0])) { var lp = lengthPct(toks[1]); if (lp === null) return null; var name = toks[0].toLowerCase(); if ((!isEnd && lp === "0%") || (isEnd && lp === "100%")) return name; return name + " " + lp; }
      return null;
    };
  };
  LONG["animation-range-start"] = listOf(rangeItem(false));
  LONG["animation-range-end"] = listOf(rangeItem(true));
  // one <animation-range-start> [<animation-range-end>]? item
  var parseRangeItem = function (item) {
    var toks = tokens(item.trim());
    var takeOne = function (i) {
      if (i >= toks.length) return null;
      if (/^normal$/i.test(toks[i])) return { v: "normal", n: 1, name: null };
      if (RANGE_NAMES.test(toks[i])) { var nm = toks[i].toLowerCase(); if (i + 1 < toks.length && lengthPct(toks[i + 1]) !== null) return { v: nm, off: lengthPct(toks[i + 1]), n: 2, name: nm }; return { v: nm, n: 1, name: nm }; }
      var l = lengthPct(toks[i]); if (l !== null) return { v: null, off: l, n: 1, name: null };
      return null;
    };
    var a = takeOne(0); if (!a) return null;
    var b = takeOne(a.n);
    if (a.n + (b ? b.n : 0) !== toks.length) return null;
    var startStr = a.v === "normal" ? "normal" : a.name ? (a.off && a.off !== "0%" ? a.name + " " + a.off : a.name) : a.off;
    var endStr;
    if (!b) endStr = a.name ? a.name : "normal";
    else endStr = b.v === "normal" ? "normal" : b.name ? (b.off && b.off !== "100%" ? b.name + " " + b.off : b.name) : b.off;
    return { start: startStr, end: endStr };
  };
  SHORT["animation-range"] = {
    longhands: ["animation-range-start", "animation-range-end"],
    expand: function (v) {
      var items = commaList(v); if (!items) return null;
      var parsed = items.map(parseRangeItem);
      if (parsed.some(function (x) { return x === null; })) return null;
      return { "animation-range-start": parsed.map(function (x) { return x.start; }).join(", "), "animation-range-end": parsed.map(function (x) { return x.end; }).join(", ") };
    },
    serialize: function (get) {
      var s = commaList(get("animation-range-start")) || [], e = commaList(get("animation-range-end")) || [];
      if (s.length !== e.length) return "";
      return s.map(function (st, i) {
        var en = e[i];
        var sName = st.split(" ")[0], named = RANGE_NAMES.test(sName);
        // the end is implied: the start's range name at 100%, or normal / 100% after a plain offset
        if (named && en === sName) return st;
        if (!named && st !== "normal" && (en === "normal" || en === "100%")) return st;
        if (st === "normal" && en === "normal") return "normal";
        return st + " " + en;
      }).join(", ");
    },
  };
  var parseSingleAnimation = function (item) {
    var r = {}, toks = tokens(item);
    if (!toks.length) return null;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i], tv = time(t, false);
      if (tv !== null) { if (r.duration === undefined) { if (/^-/.test(tv)) return null; r.duration = tv; } else if (r.delay === undefined) r.delay = tv; else return null; continue; }
      if (/^auto$/i.test(t) && r.duration === undefined) { r.duration = "auto"; continue; }
      var e = easing(t);
      if (e !== null && r.timing === undefined) { r.timing = e; continue; }
      var ic = iterCount(t);
      if (ic !== null && (/^infinite$/i.test(t) || new RegExp("^" + NUM + "$").test(t) || /^calc/i.test(t))) { if (r.count !== undefined) { if (/^infinite$/i.test(t) && r.name === undefined) { r.name = nameItem(t); continue; } return null; } r.count = ic; continue; }
      if (/^(normal|reverse|alternate|alternate-reverse)$/i.test(t) && r.direction === undefined) { r.direction = t.toLowerCase(); continue; }
      if (/^(forwards|backwards|both)$/i.test(t) && r.fill === undefined) { r.fill = t.toLowerCase(); continue; }
      if (/^none$/i.test(t) && r.fill === undefined && r.name !== undefined) { r.fill = "none"; continue; }
      if (/^(running|paused)$/i.test(t) && r.play === undefined) { r.play = t.toLowerCase(); continue; }
      if (r.name !== undefined) { if (/^none$/i.test(t) && r.fill === undefined) { r.fill = "none"; continue; } return null; }
      var nm = nameItem(t);
      if (nm === null) return null;
      r.name = nm;
    }
    return r;
  };
  SHORT.animation = {
    longhands: ["animation-duration", "animation-timing-function", "animation-delay", "animation-iteration-count", "animation-direction", "animation-fill-mode", "animation-play-state", "animation-name", "animation-timeline", "animation-range-start", "animation-range-end"],
    expand: function (v) {
      var items = commaList(v); if (!items) return null;
      var parsed = items.map(parseSingleAnimation);
      if (parsed.some(function (x) { return x === null; })) return null;
      var col = function (k, d) { return parsed.map(function (x) { return x[k] === undefined ? d : x[k]; }).join(", "); };
      return { "animation-duration": col("duration", "auto"), "animation-timing-function": col("timing", "ease"), "animation-delay": col("delay", "0s"), "animation-iteration-count": col("count", "1"), "animation-direction": col("direction", "normal"), "animation-fill-mode": col("fill", "none"), "animation-play-state": col("play", "running"), "animation-name": col("name", "none"), "animation-timeline": "auto", "animation-range-start": "normal", "animation-range-end": "normal" };
    },
    serialize: function (get) {
      var keys = ["animation-duration", "animation-timing-function", "animation-delay", "animation-iteration-count", "animation-direction", "animation-fill-mode", "animation-play-state", "animation-name"];
      if (get("animation-timeline") !== "auto" || get("animation-range-start") !== "normal" || get("animation-range-end") !== "normal") return "";
      var lists = keys.map(function (l) { return commaList(get(l)) || []; });
      var n = lists[0].length;
      if (!lists.every(function (l) { return l.length === n; })) return "";
      var out = [];
      for (var i = 0; i < n; i++) {
        var d = lists[0][i], tf = lists[1][i], dl = lists[2][i], ic = lists[3][i], dir = lists[4][i], fm = lists[5][i], ps = lists[6][i], nm = lists[7][i], parts = [];
        if (d !== "auto" || dl !== "0s") parts.push(d === "auto" && dl !== "0s" ? "0s" : d);
        if (tf !== "ease") parts.push(tf);
        if (dl !== "0s") parts.push(dl);
        if (ic !== "1") parts.push(ic);
        if (dir !== "normal") parts.push(dir);
        if (fm !== "none") parts.push(fm);
        if (ps !== "running") parts.push(ps);
        // a name that could be read as a keyword goes first? keep it last (canonical order)
        if (nm !== "none" || !parts.length) parts.push(nm === "none" && !parts.length ? "none" : nm);
        out.push(parts.join(" "));
      }
      return out.join(", ");
    },
  };

  __jb.cssHelpers = { commaList: commaList, tokens: tokens, isIdent: isIdent, lengthPct: lengthPct, fmtNum: fmtNum, computedFallback: {} };
  // ---- CSSStyleDeclaration integration
  var P = CSSStyleDeclaration.prototype;
  var origSet = P.setProperty, origGet = P.getPropertyValue, origRemove = P.removeProperty;
  var findLong = function (decl, n) { var p = decl._props.find(function (x) { return x[0] === n; }); return p ? p[1] : ""; };
  P.setProperty = function (n, v, prio) {
    n = String(n).toLowerCase();
    if (this._computedFor || this._readOnly) return origSet.apply(this, arguments);
    if (this._owner && __jb.anim && typeof __jb.anim.recordBefore === "function" && !/^transition/.test(n)) { try { __jb.anim.recordBefore(this._owner, n); } catch (e) {} }
    if (v === null || v === undefined || String(v) === "") { this.removeProperty(n); return; }
    v = String(v);
    var important = false;
    v = v.replace(/\s*!\s*important\s*$/i, function () { important = true; return ""; }).trim();
    if (prio !== undefined && prio !== null && prio !== "" && String(prio).toLowerCase() !== "important") return;
    if (important || (prio && String(prio).toLowerCase() === "important")) prio = "important"; else prio = "";
    var sh = SHORT[n];
    if (sh) {
      var map;
      if (WIDE.test(v)) { map = {}; sh.longhands.forEach(function (l) { map[l] = v.toLowerCase(); }); }
      else map = sh.expand(v);
      if (!map) return;
      var self = this;
      sh.longhands.forEach(function (l) { var p = self._props.find(function (x) { return x[0] === l; }); if (p) p[1] = map[l]; else self._props.push([l, map[l]]); if (prio) self._priority[l] = prio; else delete self._priority[l]; });
      this._sync();
      return;
    }
    var parse = LONG[n];
    if (parse) {
      var canon = WIDE.test(v) ? v.toLowerCase() : parse(v);
      if (canon === null) return;
      return origSet.call(this, n, canon, prio);
    }
    return origSet.call(this, n, v, prio);
  };
  // computed value of a parsed property the layout engine does not compute: the cascaded
  // specified value with CSS-wide keywords, font-relative lengths and simple calc() resolved
  var resolveLen = function (tok, el) {
    var fs = 16; try { fs = parseFloat(getComputedStyle(el).fontSize) || 16; } catch (e) {}
    var m = new RegExp("^(" + NUM + ")(em|rem|px|%)$", "i").exec(tok);
    if (m) { var u = m[2].toLowerCase(), n = parseFloat(m[1]); if (u === "em") return fmtNum(n * fs) + "px"; if (u === "rem") return fmtNum(n * 16) + "px"; return fmtNum(n) + (u === "%" ? "%" : "px"); }
    var c = /^calc\((.*)\)$/i.exec(tok);
    if (c) {
      var px = 0, pct = 0, ok = true, sign = 1;
      c[1].trim().split(/\s+/).forEach(function (part) {
        if (part === "+") { sign = 1; return; } if (part === "-") { sign = -1; return; }
        var r = resolveLen(part, el); var mm = /^([+-]?[\d.e+-]+)(px|%)$/.exec(r || "");
        if (!mm) { ok = false; return; } if (mm[2] === "%") pct += sign * parseFloat(mm[1]); else px += sign * parseFloat(mm[1]);
      });
      if (!ok) return tok;
      if (pct && px) return "calc(" + fmtNum(pct) + "% + " + fmtNum(px) + "px)";
      return pct ? fmtNum(pct) + "%" : fmtNum(px) + "px";
    }
    return tok;
  };
  var resolveComputed = function (el, n, v) {
    var init = __jb.cssHelpers.computedFallback[n];
    if (!v || /^(initial|unset|revert|revert-layer)$/i.test(v)) return init;
    if (/^inherit$/i.test(v)) { var p = el.parentElement; return p ? getComputedStyle(p).getPropertyValue(n) || init : init; }
    return (commaList(v) || [v]).map(function (item) { var t = tokens(item); var out = t.map(function (x) { return resolveLen(x, el); }); return LONG[n] ? (LONG[n](out.join(" ")) || out.join(" ")) : out.join(" "); }).join(", ");
  };
  P.getPropertyValue = function (n) {
    n = String(n).toLowerCase();
    if (this._computedFor && __jb.cssHelpers.computedFallback[n] !== undefined) {
      var cv = origGet.apply(this, arguments);
      return resolveComputed(this._computedFor, n, cv);
    }
    if (this._computedFor && SHORT[n] && SHORT[n].longhands.every(function (l) { return __jb.cssHelpers.computedFallback[l] !== undefined; })) {
      var selfC = this;
      return SHORT[n].serialize(function (l) { return selfC.getPropertyValue(l); });
    }
    var sh = SHORT[n];
    if (sh && !this._computedFor) {
      var self = this, vals = sh.longhands.map(function (l) { return findLong(self, l); });
      if (vals.some(function (x) { return x === ""; })) return "";
      if (vals.every(function (x) { return WIDE.test(x); })) return vals.every(function (x) { return x === vals[0]; }) ? vals[0] : "";
      if (vals.some(function (x) { return WIDE.test(x); })) return "";
      return sh.serialize(function (l) { return findLong(self, l); });
    }
    return origGet.apply(this, arguments);
  };
  P.removeProperty = function (n) {
    n = String(n).toLowerCase();
    var sh = SHORT[n];
    if (sh && !this._computedFor) {
      var old = this.getPropertyValue(n), self = this;
      this._props = this._props.filter(function (x) { return sh.longhands.indexOf(x[0]) < 0; });
      sh.longhands.forEach(function (l) { delete self._priority[l]; });
      this._sync();
      return old;
    }
    return origRemove.apply(this, arguments);
  };
  // CSS.supports(property, value) for parsed properties
  __jb.cssSupports = function (prop, value) {
    prop = String(prop).toLowerCase(); value = String(value).trim();
    if (WIDE.test(value)) return true;
    if (SHORT[prop]) return !!SHORT[prop].expand(value);
    if (LONG[prop]) return LONG[prop](value) !== null;
    return null;
  };
})();

// ---------------------------------------------------------------- scroll-driven animation triggers
// (CSS Animations 2 / scroll-animations: timeline-trigger*, animation-trigger, trigger-scope)
(function () {
  var LONG = __jb.cssLong, SHORT = __jb.cssShort, H = __jb.cssHelpers;
  var commaList = H.commaList, tokens = H.tokens, isIdent = H.isIdent, lengthPct = H.lengthPct;
  var dashed = function (t) { return /^--/.test(t) && isIdent(t); };
  var listOf = function (one) { return function (v) { var items = commaList(v); if (!items) return null; var out = []; for (var i = 0; i < items.length; i++) { var r = one(items[i].trim(), items.length); if (r === null) return null; out.push(r); } return out.join(", "); }; };
  LONG["timeline-trigger-name"] = listOf(function (t) { if (tokens(t).length !== 1) return null; if (/^none$/i.test(t)) return "none"; return dashed(t) ? t : null; });
  // scroll([<scroller> || <axis>]) / view([<axis> || <inset>{1,2}]), canonical order, defaults omitted
  var timelineFn = function (t) {
    var m = /^(scroll|view)\((.*)\)$/i.exec(t);
    if (!m) return null;
    var fn = m[1].toLowerCase(), toks = tokens(m[2].trim()), axis = null, scroller = null, inset = null;
    for (var i = 0; i < toks.length; i++) {
      var x = toks[i].toLowerCase();
      if (/^(block|inline|x|y)$/.test(x)) { if (axis) return null; axis = x; continue; }
      if (fn === "scroll" && /^(nearest|root|self)$/.test(x)) { if (scroller) return null; scroller = x; continue; }
      if (fn === "view" && (x === "auto" || lengthPct(toks[i]) !== null)) {
        if (inset) return null;
        inset = [x === "auto" ? "auto" : lengthPct(toks[i])];
        if (i + 1 < toks.length && (toks[i + 1].toLowerCase() === "auto" || lengthPct(toks[i + 1]) !== null)) { i++; inset.push(toks[i].toLowerCase() === "auto" ? "auto" : lengthPct(toks[i])); }
        continue;
      }
      return null;
    }
    var out = [];
    if (fn === "scroll") { if (scroller && scroller !== "nearest") out.push(scroller); if (axis && axis !== "block") out.push(axis); }
    else {
      if (axis && axis !== "block") out.push(axis);
      if (inset) { if (inset.length === 2 && inset[1] === inset[0]) inset = [inset[0]]; if (!(inset.length === 1 && inset[0] === "auto")) out.push(inset.join(" ")); }
    }
    return fn + "(" + out.join(" ") + ")";
  };
  __jb.cssHelpers.timelineFn = timelineFn;
  var sourceItem = function (t) {
    if (tokens(t).length !== 1) return null;
    if (/^(auto|none)$/i.test(t)) return t.toLowerCase();
    if (dashed(t)) return t;
    return timelineFn(t);
  };
  LONG["timeline-trigger-source"] = listOf(sourceItem);
  var RANGE_NAMES = /^(cover|contain|entry|exit|entry-crossing|exit-crossing|scroll)$/i;
  var rangeItem = function (isEnd, allowAuto) {
    return function (t) {
      var toks = tokens(t.trim());
      if (toks.length === 1 && /^normal$/i.test(toks[0])) return "normal";
      if (allowAuto && toks.length === 1 && /^auto$/i.test(toks[0])) return "auto";
      if (toks.length === 1) { if (RANGE_NAMES.test(toks[0])) return toks[0].toLowerCase(); return lengthPct(toks[0]); }
      if (toks.length === 2 && RANGE_NAMES.test(toks[0])) { var lp = lengthPct(toks[1]); if (lp === null) return null; var name = toks[0].toLowerCase(); if ((!isEnd && lp === "0%") || (isEnd && lp === "100%")) return name; return name + " " + lp; }
      return null;
    };
  };
  var parseActiveItem = function (item) {
    var toks = tokens(item.trim());
    var one = function (i) {
      if (i >= toks.length) return null;
      var x = toks[i].toLowerCase();
      if (x === "auto" || x === "normal") return { v: x, n: 1, name: null };
      if (RANGE_NAMES.test(x)) { if (i + 1 < toks.length && lengthPct(toks[i + 1]) !== null) return { v: x, off: lengthPct(toks[i + 1]), n: 2, name: x }; return { v: x, n: 1, name: x }; }
      var l = lengthPct(toks[i]); if (l !== null) return { v: null, off: l, n: 1, name: null };
      return null;
    };
    var a = one(0); if (!a) return null;
    var b = one(a.n);
    if (a.n + (b ? b.n : 0) !== toks.length) return null;
    var str = function (x, isEnd) { if (x.v === "auto" || x.v === "normal") return x.v; if (x.name) return x.off && x.off !== (isEnd ? "100%" : "0%") ? x.name + " " + x.off : x.name; return x.off; };
    return { start: str(a, false), end: b ? str(b, true) : (a.name ? a.name : "auto") };
  };
  ["activation", "active"].forEach(function (kind) {
    var auto = kind === "active";
    LONG["timeline-trigger-" + kind + "-range-start"] = listOf(rangeItem(false, auto));
    LONG["timeline-trigger-" + kind + "-range-end"] = listOf(rangeItem(true, auto));
    var base = SHORT["animation-range"];
    SHORT["timeline-trigger-" + kind + "-range"] = {
      longhands: ["timeline-trigger-" + kind + "-range-start", "timeline-trigger-" + kind + "-range-end"],
      expand: function (v) {
        if (auto) {
          var items = commaList(v);
          if (items && items.every(function (x) { return /^auto$/i.test(x.trim()); })) { var o0 = {}, a = items.map(function () { return "auto"; }).join(", "); o0["timeline-trigger-" + kind + "-range-start"] = a; o0["timeline-trigger-" + kind + "-range-end"] = a; return o0; }
        }
        if (auto) {
          var its = commaList(v); if (!its) return null;
          var ps = its.map(parseActiveItem); if (ps.some(function (x) { return x === null; })) return null;
          var oa = {}; oa["timeline-trigger-" + kind + "-range-start"] = ps.map(function (x) { return x.start; }).join(", "); oa["timeline-trigger-" + kind + "-range-end"] = ps.map(function (x) { return x.end; }).join(", "); return oa;
        }
        var r = base.expand(v); if (!r) return null;
        var o = {}; o["timeline-trigger-" + kind + "-range-start"] = r["animation-range-start"]; o["timeline-trigger-" + kind + "-range-end"] = r["animation-range-end"]; return o;
      },
      serialize: function (get) {
        var s = get("timeline-trigger-" + kind + "-range-start"), e = get("timeline-trigger-" + kind + "-range-end");
        if (auto) {
          var ss = commaList(s) || [], ee = commaList(e) || [];
          if (ss.length !== ee.length) return "";
          return ss.map(function (st, i) {
            var en = ee[i], nm = st.split(" ")[0], named = RANGE_NAMES.test(nm);
            if (named && en === nm) return st;
            if (!named && en === "auto") return st;
            return st + " " + en;
          }).join(", ");
        }
        return base.serialize(function (l) { return l === "animation-range-start" ? s : e; });
      },
    };
  });
  // timeline-trigger: <name> <source> <activation-range> [ / <active-range> ]?
  var parseTriggerItem = function (item) {
    var parts = item.split("/");
    if (parts.length > 2) return null;
    var toks = tokens(parts[0].trim());
    var r = {}, i = 0;
    if (toks[i] && (/^none$/i.test(toks[i]) || dashed(toks[i]))) { r.name = /^none$/i.test(toks[i]) ? "none" : toks[i]; i++; }
    if (toks[i] && sourceItem(toks[i]) !== null && !RANGE_NAMES.test(toks[i]) && !/^normal$/i.test(toks[i])) { r.source = sourceItem(toks[i]); i++; }
    var rest = toks.slice(i).join(" ");
    if (rest) { var ar = SHORT["animation-range"].expand(rest); if (!ar || commaList(rest).length !== 1) return null; r.aStart = ar["animation-range-start"]; r.aEnd = ar["animation-range-end"]; }
    if (parts.length === 2) {
      var act = parts[1].trim(); if (!act) return null;
      var pr = parseActiveItem(act); if (!pr) return null; r.pStart = pr.start; r.pEnd = pr.end;
    }
    if (r.name === undefined && r.source === undefined && r.aStart === undefined && r.pStart === undefined) return null;
    return r;
  };
  SHORT["timeline-trigger"] = {
    longhands: ["timeline-trigger-name", "timeline-trigger-source", "timeline-trigger-activation-range-start", "timeline-trigger-activation-range-end", "timeline-trigger-active-range-start", "timeline-trigger-active-range-end"],
    expand: function (v) {
      var items = commaList(v); if (!items) return null;
      var parsed = items.map(function (x) { return parseTriggerItem(x.trim()); });
      if (parsed.some(function (x) { return x === null; })) return null;
      var col = function (k, d) { return parsed.map(function (x) { return x[k] === undefined ? d : x[k]; }).join(", "); };
      return { "timeline-trigger-name": col("name", "none"), "timeline-trigger-source": col("source", "auto"), "timeline-trigger-activation-range-start": col("aStart", "normal"), "timeline-trigger-activation-range-end": col("aEnd", "normal"), "timeline-trigger-active-range-start": col("pStart", "auto"), "timeline-trigger-active-range-end": col("pEnd", "auto") };
    },
    serialize: function (get) {
      var L = this.longhands.map(function (l) { return commaList(get(l)) || []; });
      var n = L[0].length;
      if (!L.every(function (l) { return l.length === n; })) return "";
      var out = [];
      for (var i = 0; i < n; i++) {
        var parts = [];
        if (L[0][i] !== "none") parts.push(L[0][i]);
        if (L[1][i] !== "auto") parts.push(L[1][i]);
        var ar = SHORT["animation-range"].serialize(function (l) { return l === "animation-range-start" ? L[2][i] : L[3][i]; });
        var hasActive = !(L[4][i] === "auto" && L[5][i] === "auto");
        if (ar !== "normal") parts.push(ar);
        if (hasActive) parts.push("/ " + SHORT["timeline-trigger-active-range"].serialize(function (l) { return /start$/.test(l) ? L[4][i] : L[5][i]; }));
        out.push(parts.length ? parts.join(" ") : "none");
      }
      return out.join(", ");
    },
  };
  var ACTION = /^(none|play|pause|reset|replay|play-once|play-forwards|play-backwards|play-alternate|toggle)$/i;
  LONG["animation-trigger"] = listOf(function (t) {
    var toks = tokens(t);
    if (toks.length === 1 && /^none$/i.test(toks[0])) return "none";
    if (!toks.length || !dashed(toks[0])) return null;
    var acts = toks.slice(1);
    if (!acts.length || acts.length > 2 || !acts.every(function (a) { return ACTION.test(a); })) return null;
    return [toks[0]].concat(acts.map(function (a) { return a.toLowerCase(); })).join(" ");
  });
  LONG["trigger-scope"] = function (v) {
    v = v.trim();
    if (/^(none|all)$/i.test(v)) return v.toLowerCase();
    var items = commaList(v); if (!items) return null;
    if (!items.every(function (x) { return tokens(x).length === 1 && dashed(x.trim()); })) return null;
    return items.map(function (x) { return x.trim(); }).join(", ");
  };
  // ---- CSS Overflow 4 (not in Stylo's servo build)
  LONG["line-clamp"] = function (v) {
    var toks = v.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
    if (toks.length === 1 && /^none$/i.test(toks[0])) return "none";
    var legacy = toks.length && /^-webkit-legacy$/i.test(toks[toks.length - 1]);
    if (legacy) toks.pop();
    if (!toks.length) return null;
    var n = null, ell = null;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (/^[+]?\d+$/.test(t)) { if (n !== null || parseInt(t, 10) < 1) return null; n = String(parseInt(t, 10)); }
      else if (/^(auto|no-ellipsis|ellipsis)$/i.test(t) || /^["']/.test(t)) { if (ell !== null) return null; ell = /^["']/.test(t) ? t : t.toLowerCase(); }
      else return null;
    }
    var out = [n !== null ? n : "auto"];
    if (ell !== null && ell !== "ellipsis" && !(ell === "auto" && n === null)) out.push(ell);
    if (legacy) out.push("-webkit-legacy");
    return out.join(" ");
  };
  LONG["scrollbar-gutter"] = function (v) {
    var toks = v.trim().toLowerCase().split(/\s+/);
    if (toks.length === 1 && (toks[0] === "auto" || toks[0] === "stable")) return toks[0];
    if (toks.length === 2 && toks.indexOf("stable") >= 0 && toks.indexOf("both-edges") >= 0) return "stable both-edges";
    return null;
  };
  // ---- CSS Scroll Snap (properties Stylo's servo build does not parse)
  var lengthOnly = function (t, nonNeg) {
    var v = lengthPct(t.trim());
    if (v === null || /%/.test(v)) return null;
    if (nonNeg && /^-/.test(v)) return null;
    return v;
  };
  var paddingItem = function (t) {
    t = t.trim();
    if (/^auto$/i.test(t)) return "auto";
    var v = lengthPct(t);
    if (v === null || /^-/.test(v)) return null;
    return v;
  };
  var SIDES = ["top", "right", "bottom", "left"];
  var boxShort = function (prefix, item) {
    var lh = SIDES.map(function (s) { return prefix + "-" + s; });
    SHORT[prefix] = {
      longhands: lh,
      expand: function (v) {
        var t = tokens(v.trim()).map(item);
        if (!t.length || t.length > 4 || t.some(function (x) { return x === null; })) return null;
        var tp = t[0], r = t[1] === undefined ? tp : t[1], b = t[2] === undefined ? tp : t[2], l = t[3] === undefined ? r : t[3];
        var o = {}; o[lh[0]] = tp; o[lh[1]] = r; o[lh[2]] = b; o[lh[3]] = l; return o;
      },
      serialize: function (get) {
        var t = get(lh[0]), r = get(lh[1]), b = get(lh[2]), l = get(lh[3]);
        if (!t || !r || !b || !l) return "";
        if (r === l) { if (t === b) return t === r ? t : t + " " + r; return t + " " + r + " " + b; }
        return t + " " + r + " " + b + " " + l;
      },
    };
    lh.forEach(function (p) { LONG[p] = function (v) { return tokens(v.trim()).length === 1 ? item(v) : null; }; });
    ["block", "inline"].forEach(function (axis) {
      var pair = [prefix + "-" + axis + "-start", prefix + "-" + axis + "-end"];
      pair.forEach(function (p) { LONG[p] = function (v) { return tokens(v.trim()).length === 1 ? item(v) : null; }; });
      SHORT[prefix + "-" + axis] = {
        longhands: pair,
        expand: function (v) {
          var t = tokens(v.trim()).map(item);
          if (!t.length || t.length > 2 || t.some(function (x) { return x === null; })) return null;
          var o = {}; o[pair[0]] = t[0]; o[pair[1]] = t[1] === undefined ? t[0] : t[1]; return o;
        },
        serialize: function (get) { var a = get(pair[0]), b = get(pair[1]); if (!a || !b) return ""; return a === b ? a : a + " " + b; },
      };
    });
  };
  boxShort("scroll-margin", function (t) { return lengthOnly(t, false); });
  boxShort("scroll-padding", paddingItem);
  LONG["scroll-snap-type"] = function (v) {
    var t = tokens(v.trim());
    if (t.length === 1 && /^none$/i.test(t[0])) return "none";
    if (!t.length || t.length > 2 || !/^(x|y|block|inline|both)$/i.test(t[0])) return null;
    if (t.length === 2 && !/^(mandatory|proximity)$/i.test(t[1])) return null;
    var axis = t[0].toLowerCase(), strict = t[1] ? t[1].toLowerCase() : "proximity";
    return strict === "proximity" ? axis : axis + " " + strict;
  };
  LONG["scroll-snap-align"] = function (v) {
    var t = tokens(v.trim());
    if (!t.length || t.length > 2 || !t.every(function (x) { return /^(none|start|end|center)$/i.test(x); })) return null;
    t = t.map(function (x) { return x.toLowerCase(); });
    return t.length === 2 && t[0] !== t[1] ? t.join(" ") : t[0];
  };
  LONG["scroll-snap-stop"] = function (v) { v = v.trim(); return /^(normal|always)$/i.test(v) ? v.toLowerCase() : null; };
  LONG["scroll-initial-target"] = function (v) { v = v.trim(); return /^(none|nearest)$/i.test(v) ? v.toLowerCase() : null; };
  (function () {
    var init = { "scroll-snap-type": "none", "scroll-snap-align": "none", "scroll-snap-stop": "normal", "scroll-initial-target": "none" };
    SIDES.concat(["block-start", "block-end", "inline-start", "inline-end"]).forEach(function (s) { init["scroll-margin-" + s] = "0px"; init["scroll-padding-" + s] = "auto"; });
    H.computedFallback = H.computedFallback || {};
    Object.keys(init).forEach(function (p) { if (H.computedFallback[p] === undefined) H.computedFallback[p] = init[p]; });
  })();
  // computed values: the specified value with CSS-wide keywords and lengths resolved
  var INITIAL = { "timeline-trigger-name": "none", "timeline-trigger-source": "auto", "timeline-trigger-activation-range-start": "normal", "timeline-trigger-activation-range-end": "normal", "timeline-trigger-active-range-start": "auto", "timeline-trigger-active-range-end": "auto", "animation-trigger": "none", "trigger-scope": "none" };
  H.computedFallback = H.computedFallback || {};
  Object.keys(INITIAL).forEach(function (p) { H.computedFallback[p] = INITIAL[p]; });
})();
