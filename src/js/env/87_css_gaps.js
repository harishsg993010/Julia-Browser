// CSS Gap Decorations (css-gaps-1): column-rule-* / row-rule-* lists with repeat(), the rule /
// rule-inset shorthand families, rule-break, rule-visibility-items, rule-overlap. Stylo's servo
// build has none of them, so values are validated here (leaf values through Stylo with a proxy
// property: colors as background-color, widths as border-top-width, insets as margin-left) and
// computed values come from the same proxies computed for the element.
(function () {
  var LONG = __jb.cssLong, SHORT = __jb.cssShort, H = __jb.cssHelpers;
  if (!LONG || !SHORT || !H) return;
  var commaList = H.commaList, tokens = H.tokens;
  var native = function (payload) { try { return __jb.native("cssdecl", payload); } catch (e) { return null; } };
  var styloAs = function (prop, value) {
    if (!__jb.styloCssom || !__jb.styloCssom()) return null;
    if (/[;{}!]/.test(value)) return null;
    var r = native({ op: "parse", text: prop + ": " + value });
    if (!r || r.invalid || typeof r.css !== "string") return null;
    var m = new RegExp("^" + prop + ": (.*);$").exec(r.css.trim());
    return m && !/^(inherit|initial|unset|revert|revert-layer)$/i.test(m[1]) ? m[1] : null;
  };
  var STYLES = /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/i;
  var leaf = {
    color: function (v) { return styloAs("background-color", v); },
    style: function (v) { return STYLES.test(v) ? v.toLowerCase() : null; },
    width: function (v) { return /^(thin|medium|thick)$/i.test(v) ? v.toLowerCase() : styloAs("border-top-width", v); },
  };
  // repeat count: <integer [1,inf]> (calc() allowed) or auto
  var evalInt = function (t) {
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    if (!/^calc\(/i.test(t)) return null;
    // Stylo simplifies calc() integers: "calc(5 + 3)" -> "calc(8)"
    var s = styloAs("order", t), m = s && /^(?:calc\()?(-?\d+(?:\.\d+)?)\)?$/.exec(s);
    return m ? Math.round(parseFloat(m[1])) : null;
  };
  // a list value: [{ repeat: null | "auto" | count text, items: [leaf...] }]
  function parseList(v, item) {
    var parts = commaList(String(v).trim());
    if (!parts) return null;
    var out = [], autos = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], m = /^repeat\(([\s\S]*)\)$/i.exec(p);
      if (m) {
        var args = commaList(m[1].trim());
        if (!args || args.length < 2) return null;
        var count = args[0].trim(), rep;
        if (/^auto$/i.test(count)) { rep = "auto"; autos++; }
        else { var n = evalInt(count); if (n === null || n < 1) return null; rep = /^calc/i.test(count) ? (styloAs("order", count) || count) : String(n); }
        var items = [];
        for (var k = 1; k < args.length; k++) { var x = item(args[k].trim()); if (x === null) return null; items.push(x); }
        out.push({ repeat: rep, items: items });
      } else {
        var y = item(p);
        if (y === null) return null;
        out.push({ repeat: null, items: [y] });
      }
    }
    if (autos > 1) return null;
    return out;
  }
  var itemText = function (x) { return typeof x === "string" ? x : x.text; };
  function serializeList(list) {
    return list.map(function (g) { return g.repeat === null ? itemText(g.items[0]) : "repeat(" + g.repeat + ", " + g.items.map(itemText).join(", ") + ")"; }).join(", ");
  }
  ["column", "row"].forEach(function (axis) {
    ["color", "style", "width"].forEach(function (kind) {
      LONG[axis + "-rule-" + kind] = function (v) { var l = parseList(v, leaf[kind]); return l ? serializeList(l) : null; };
    });
  });

  // ---- <gap-rule> = <line-width> || <line-style> || <line-color>
  function parseRule(t) {
    var toks = tokens(t);
    if (!toks.length) return null;
    var r = {};
    for (var i = 0; i < toks.length; i++) {
      var x = toks[i], v;
      if (r.style === undefined && (v = leaf.style(x)) !== null) { r.style = v; continue; }
      if (r.width === undefined && (v = leaf.width(x)) !== null) { r.width = v; continue; }
      if (r.color === undefined && (v = leaf.color(x)) !== null) { r.color = v; continue; }
      return null;
    }
    return { width: r.width || "medium", style: r.style || "none", color: r.color || "currentcolor" };
  }
  function ruleText(w, s, c) {
    var parts = [];
    if (w !== "medium") parts.push(w);
    if (s !== "none") parts.push(s);
    if (!/^currentcolor$/i.test(c)) parts.push(c);
    return parts.length ? parts.join(" ") : "medium";
  }
  // the three longhand lists of a rule shorthand, or null
  function expandRule(v, axis) {
    var l = parseList(v, parseRule);
    if (!l) return null;
    var pick = function (k) { return serializeList(l.map(function (g) { return { repeat: g.repeat, items: g.items.map(function (r) { return r[k]; }) }; })); };
    var o = {};
    o[axis + "-rule-width"] = pick("width"); o[axis + "-rule-style"] = pick("style"); o[axis + "-rule-color"] = pick("color");
    return o;
  }
  // combine three longhand lists of the same shape into a rule list
  function serializeRule(w, s, c) {
    var lw = parseList(w, function (x) { return x; }), ls = parseList(s, function (x) { return x; }), lc = parseList(c, function (x) { return x; });
    if (!lw || !ls || !lc || lw.length !== ls.length || lw.length !== lc.length) return "";
    var out = [];
    for (var i = 0; i < lw.length; i++) {
      var a = lw[i], b = ls[i], d = lc[i];
      if (a.repeat !== b.repeat || a.repeat !== d.repeat || a.items.length !== b.items.length || a.items.length !== d.items.length) return "";
      out.push({ repeat: a.repeat, items: a.items.map(function (x, k) { return ruleText(x, b.items[k], d.items[k]); }) });
    }
    return serializeList(out);
  }
  ["column", "row"].forEach(function (axis) {
    var p = axis + "-rule";
    SHORT[p] = {
      longhands: [p + "-width", p + "-style", p + "-color"],
      expand: function (v) { return expandRule(v, axis); },
      serialize: function (get) { return serializeRule(get(p + "-width"), get(p + "-style"), get(p + "-color")); },
    };
  });
  SHORT.rule = {
    longhands: ["column-rule-width", "column-rule-style", "column-rule-color", "row-rule-width", "row-rule-style", "row-rule-color"],
    expand: function (v) { var c = expandRule(v, "column"), r = expandRule(v, "row"); if (!c || !r) return null; return Object.assign(c, r); },
    serialize: function (get) {
      var c = serializeRule(get("column-rule-width"), get("column-rule-style"), get("column-rule-color"));
      var r = serializeRule(get("row-rule-width"), get("row-rule-style"), get("row-rule-color"));
      return c && c === r ? c : "";
    },
  };
  // shorthands that set the same value for the column and row longhands
  function bothAxes(name, colShort, colLonghands) {
    var rowLonghands = colLonghands.map(function (l) { return l.replace(/^column-/, "row-"); });
    SHORT[name] = {
      longhands: colLonghands.concat(rowLonghands),
      expand: function (v) {
        var c = colShort(v);
        if (!c) return null;
        var o = {};
        colLonghands.forEach(function (l, i) { o[l] = c[l]; o[rowLonghands[i]] = c[l]; });
        return o;
      },
      serialize: function (get) {
        if (colLonghands.some(function (l, i) { return get(l) !== get(rowLonghands[i]); })) return "";
        return SHORT[colLonghands.length === 1 ? null : name.replace(/^rule/, "column-rule")] ? SHORT[name.replace(/^rule/, "column-rule")].serialize(get) : get(colLonghands[0]);
      },
    };
  }

  // ---- insets
  var inset = function (v) { v = String(v).trim(); if (/^overlap-join$/i.test(v)) return "overlap-join"; if (/^auto$/i.test(v)) return null; return tokens(v).length === 1 ? styloAs("margin-left", v) : null; };
  var two = function (v) { var t = tokens(String(v).trim()); if (t.length < 1 || t.length > 2) return null; var a = inset(t[0]), b = t.length > 1 ? inset(t[1]) : a; return a === null || b === null ? null : [a, b]; };
  ["column", "row"].forEach(function (axis) {
    var p = axis + "-rule-inset";
    ["cap-start", "cap-end", "junction-start", "junction-end"].forEach(function (k) { LONG[p + "-" + k] = inset; });
    ["cap", "junction"].forEach(function (k) {
      SHORT[p + "-" + k] = {
        longhands: [p + "-" + k + "-start", p + "-" + k + "-end"],
        expand: function (v) { var r = two(v); if (!r) return null; var o = {}; o[p + "-" + k + "-start"] = r[0]; o[p + "-" + k + "-end"] = r[1]; return o; },
        serialize: function (get) { var a = get(p + "-" + k + "-start"), b = get(p + "-" + k + "-end"); return a === b ? a : a + " " + b; },
      };
    });
    ["start", "end"].forEach(function (k) {
      SHORT[p + "-" + k] = {
        longhands: [p + "-cap-" + k, p + "-junction-" + k],
        expand: function (v) { var r = inset(v); if (r === null) return null; var o = {}; o[p + "-cap-" + k] = r; o[p + "-junction-" + k] = r; return o; },
        serialize: function (get) { var a = get(p + "-cap-" + k), b = get(p + "-junction-" + k); return a === b ? a : ""; },
      };
    });
    SHORT[p] = {
      longhands: [p + "-cap-start", p + "-cap-end", p + "-junction-start", p + "-junction-end"],
      expand: function (v) {
        var halves = String(v).split("/");
        if (halves.length > 2) return null;
        var cap = two(halves[0]); if (!cap) return null;
        var jn = halves.length > 1 ? two(halves[1]) : cap; if (!jn) return null;
        var o = {};
        o[p + "-cap-start"] = cap[0]; o[p + "-cap-end"] = cap[1]; o[p + "-junction-start"] = jn[0]; o[p + "-junction-end"] = jn[1];
        return o;
      },
      serialize: function (get) {
        var v = [get(p + "-cap-start"), get(p + "-cap-end"), get(p + "-junction-start"), get(p + "-junction-end")];
        if (v.every(function (x) { return x === v[0]; })) return v[0];
        return v[0] + " " + v[1] + " / " + v[2] + " " + v[3];
      },
    };
  });
  ["", "-cap", "-junction", "-start", "-end"].forEach(function (suffix) {
    var col = "column-rule-inset" + suffix;
    bothAxes("rule-inset" + suffix, SHORT[col].expand, SHORT[col].longhands);
    SHORT["rule-inset" + suffix].serialize = function (get) {
      var cl = SHORT[col].longhands, rl = cl.map(function (l) { return l.replace(/^column-/, "row-"); });
      if (cl.some(function (l, i) { return get(l) !== get(rl[i]); })) return "";
      return SHORT[col].serialize(get);
    };
  });

  // ---- keywords
  var kw = function (re) { return function (v) { v = String(v).trim(); return re.test(v) ? v.toLowerCase() : null; }; };
  ["column", "row"].forEach(function (axis) {
    LONG[axis + "-rule-break"] = kw(/^(none|normal|intersection)$/i);
    LONG[axis + "-rule-visibility-items"] = kw(/^(all|around|between|normal)$/i);
  });
  LONG["rule-overlap"] = kw(/^(row-over-column|column-over-row)$/i);
  [["rule-break", "column-rule-break", "row-rule-break"], ["rule-visibility-items", "column-rule-visibility-items", "row-rule-visibility-items"]].forEach(function (x) {
    SHORT[x[0]] = {
      longhands: [x[1], x[2]],
      expand: function (v) { var r = LONG[x[1]](v); if (r === null) return null; var o = {}; o[x[1]] = r; o[x[2]] = r; return o; },
      serialize: function (get) { var a = get(x[1]), b = get(x[2]); return a === b ? a : ""; },
    };
  });

  ["color", "style", "width"].forEach(function (k) {
    var c = "column-rule-" + k, r = "row-rule-" + k;
    SHORT["rule-" + k] = {
      longhands: [c, r],
      expand: function (v) { var x = LONG[c](v); if (x === null) return null; var o = {}; o[c] = x; o[r] = x; return o; },
      serialize: function (get) { var a = get(c), b = get(r); return a === b ? a : ""; },
    };
  });

  // known to keyframe processing / CSS.supports users
  var GAP_NAMES = /^(column-rule|row-rule|rule)(-|$)/;
  if (__jb.KNOWN_CSS_PROPERTIES) {
    Object.keys(LONG).concat(Object.keys(SHORT)).forEach(function (n) { if (GAP_NAMES.test(n)) __jb.KNOWN_CSS_PROPERTIES[n] = true; });
  }

  // ---- computed values
  var INITIAL = Object.create(null); INITIAL["rule-overlap"] = "row-over-column";
  ["column", "row"].forEach(function (axis) {
    var p = axis + "-rule";
    INITIAL[p + "-color"] = "currentcolor"; INITIAL[p + "-style"] = "none"; INITIAL[p + "-width"] = "medium";
    INITIAL[p + "-break"] = "normal"; INITIAL[p + "-visibility-items"] = "normal";
    ["cap-start", "cap-end", "junction-start", "junction-end"].forEach(function (k) { INITIAL[p + "-inset-" + k] = "0px"; });
  });
  function computeLeaf(el, decls, prop) {
    if (el.__jbid === undefined || __jb.nodeById[el.__jbid] !== el) __jb.assignLayoutIds();
    var r = null;
    try { r = __jb.layoutQuery("style", { id: el.__jbid, props: [prop], pseudoDecls: decls, base: "" }); } catch (e) { r = null; }
    return r && typeof r === "object" && typeof r[prop] === "string" && r[prop] !== "" ? r[prop] : null;
  }
  // fast paths in JS (animation sampling reads these often); Stylo for the rest
  var fmtPx = function (n) { var r = Math.round(n * 1000) / 1000; return (r === 0 ? 0 : r) + "px"; };
  var computeKind = {
    color: function (el, v) {
      if (!/^(currentcolor|color-mix|light-dark|.*\bfrom\b)/i.test(v) && typeof __jb.parseCssColor === "function") {
        var c = null; try { c = __jb.parseCssColor(v); } catch (e) { c = null; }
        if (c && c.length >= 3 && !/^(color|lab|lch|oklab|oklch)\(/i.test(v)) {
          var ch = [0, 1, 2].map(function (i) { return Math.round(Math.max(0, Math.min(255, c[i]))); }), a = c.length > 3 ? c[3] : 1;
          return a >= 1 ? "rgb(" + ch.join(", ") + ")" : "rgba(" + ch.join(", ") + ", " + (Math.round(a * 1000) / 1000) + ")";
        }
      }
      return computeLeaf(el, "color: " + v, "color") || v;
    },
    width: function (el, v) {
      var kw = { thin: 1, medium: 3, thick: 5 }[v];
      if (kw !== undefined) return kw + "px";
      var m = /^(\d+(?:\.\d+)?|\.\d+)px$/.exec(v);
      if (m) { var n = parseFloat(m[1]); return fmtPx(n > 0 && n < 1 ? 1 : Math.floor(n)); }
      return computeLeaf(el, "border-top-style: solid; border-top-width: " + v, "border-top-width") || v;
    },
    style: function (el, v) { return v; },
  };
  function computedOf(el, prop, spec) {
    var m = /-rule-(color|style|width)$/.exec(prop);
    if (m) {
      var l = parseList(spec, leaf[m[1]]);
      if (!l) return null;
      return serializeList(l.map(function (g) { return { repeat: g.repeat === null || g.repeat === "auto" ? g.repeat : String(evalInt(g.repeat) || g.repeat), items: g.items.map(function (x) { return computeKind[m[1]](el, x); }) }; }));
    }
    if (/-rule-inset-/.test(prop)) { var v = inset(spec); if (v === null) return null; return v === "overlap-join" || /^-?[\d.]+(px|%)$/.test(v) ? v : computeLeaf(el, "margin-left: " + v, "margin-left") || v; }
    return LONG[prop] ? LONG[prop](spec) : spec;
  }
  // computed shorthands: serialized from the computed longhands
  var GAP_SHORTHANDS = Object.create(null);
  ["column-rule", "row-rule", "rule", "rule-break", "rule-visibility-items", "rule-color", "rule-style", "rule-width"].forEach(function (n) { GAP_SHORTHANDS[n] = 1; });
  ["column-rule-inset", "row-rule-inset", "rule-inset"].forEach(function (p) { ["", "-cap", "-junction", "-start", "-end"].forEach(function (s) { GAP_SHORTHANDS[p + s] = 1; }); });
  var P = CSSStyleDeclaration.prototype, origGet = P.getPropertyValue;
  // underlying values for animations / transitions: the cascaded value (matching <style> rules,
  // then inline style), computed - without building a whole computed style
  function cascaded(el, prop) {
    var v = "";
    try { (__jb.gcsMatchingRules(el) || []).forEach(function (r) { r.props.forEach(function (p) { if (p[0] === prop) v = p[1]; }); }); } catch (e) {}
    try { var iv = el.style ? el.style.getPropertyValue(prop) : ""; if (iv) v = iv; } catch (e) {}
    return String(v || "").trim();
  }
  function rawGap(el, prop) {
    var spec = cascaded(el, prop);
    if (/^inherit$/i.test(spec)) return el.parentElement ? rawGap(el.parentElement, prop) : computedOf(el, prop, INITIAL[prop]);
    if (!spec || /^(initial|unset|revert|revert-layer)$/i.test(spec)) spec = INITIAL[prop];
    var c = computedOf(el, prop, spec);
    return c === null ? computedOf(el, prop, INITIAL[prop]) : c;
  }
  var A = __jb.anim;
  if (A && typeof A.rawComputed === "function") {
    var baseRaw = A.rawComputed;
    A.rawComputed = function (el, prop) { return prop in INITIAL ? rawGap(el, prop) : baseRaw(el, prop); };
  }
  P.getPropertyValue = function (n) {
    var name = String(n).toLowerCase();
    if (this._computedFor) {
      var self = this, el = this._computedFor;
      // shorthands: serialized from the computed longhands
      if (GAP_SHORTHANDS[name] && SHORT[name]) return SHORT[name].serialize(function (l) { return self.getPropertyValue(l); });
      // longhands: the cascaded (or animated) value, computed
      if (name in INITIAL) {
        // (runs the style update of CSS transitions / animations and answers animated values)
        var animated = null;
        try { animated = __jb.computedValue(el, name); } catch (e) { animated = null; }
        var spec = String(animated || origGet.call(this, name) || "").trim();
        if (/^inherit$/i.test(spec)) { var par = el.parentElement; return par ? getComputedStyle(par).getPropertyValue(name) : computedOf(el, name, INITIAL[name]); }
        if (!spec || /^(initial|unset|revert|revert-layer)$/i.test(spec)) spec = INITIAL[name];
        if (!el.isConnected || typeof __jb.layoutQuery !== "function") return spec;
        var c = computedOf(el, name, spec);
        if (c === null) c = computedOf(el, name, INITIAL[name]);
        // the style as last observed: the before-change style of a transition (as 63 does)
        try { var ls = el._lastStyle || Object.defineProperty(el, "_lastStyle", { value: {}, writable: true, configurable: true })._lastStyle; ls[name] = { v: c, key: __jb.layoutKey ? __jb.layoutKey() : 0 }; } catch (e) {}
        return c;
      }
    }
    return origGet.apply(this, arguments);
  };
})();
