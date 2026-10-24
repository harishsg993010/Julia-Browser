// Part 84: getComputedStyle(element, "::pseudo") for tree-abiding and highlight
// pseudo-elements. The pseudo-element's cascaded declarations come from the style sheets'
// rules whose selector ends in that pseudo-element and matches the element (by specificity
// and order, UA defaults first, properties the pseudo-element does not accept dropped); the
// layout engine computes them on a box inheriting from the element (host layout op "style"
// with `pseudoDecls`). Ill-formed pseudo-element arguments give an empty declaration.
(function () {
  var LEGACY = { before: 1, after: 1, "first-line": 1, "first-letter": 1 };
  var TREE = { before: 1, after: 1, marker: 1, "first-line": 1, "first-letter": 1, placeholder: 1, "file-selector-button": 1, backdrop: 1, "details-content": 1, checkmark: 1, "picker-icon": 1, "scroll-marker": 1, "scroll-marker-group": 1, "scroll-button": 0, column: 1 };
  var HIGHLIGHT = { selection: 1, "target-text": 1, "spelling-error": 1, "grammar-error": 1, "search-text": 1, highlight: 1 };

  // pseudo argument -> { name, arg } ; null when ill-formed or unsupported
  __jb.parsePseudoArgument = function (p) {
    var m = /^(::?)([A-Za-z][A-Za-z0-9-]*)(?:\(([^()]*)\))?$/.exec(p);
    if (!m) return null;
    var name = m[2].toLowerCase(), arg = m[3];
    if (m[1] === ":" && !LEGACY[name]) return null;
    if (name === "highlight") {
      if (arg === undefined || !/^\s*-?[A-Za-z_][A-Za-z0-9_-]*\s*$/.test(arg)) return null;
      return { name: name, arg: arg.trim() };
    }
    if (arg !== undefined) return null;
    if (!TREE[name] && !HIGHLIGHT[name]) return null;
    return { name: name, arg: null };
  };

  // ---- which properties apply ----
  var FONT = /^(font|font-[a-z-]+|line-height)$/;
  var TEXT_DECO = /^(text-decoration|text-decoration-[a-z-]+|text-shadow|text-underline-[a-z-]+|text-emphasis|text-emphasis-[a-z-]+)$/;
  var BACKGROUND = /^(background|background-[a-z-]+)$/;
  var ANIM = /^(animation|animation-[a-z-]+|transition|transition-[a-z-]+)$/;
  var applies = function (pseudo, prop) {
    if (prop.indexOf("--") === 0) return true;
    switch (pseudo) {
      case "marker":
        return FONT.test(prop) || ANIM.test(prop) || /^(white-space|white-space-collapse|text-wrap-mode|color|text-combine-upright|unicode-bidi|direction|content|hyphens|letter-spacing|line-break|overflow-wrap|word-wrap|tab-size|text-transform|word-break|word-spacing|text-decoration-skip-ink|text-emphasis|text-emphasis-[a-z-]+|text-shadow|cursor)$/.test(prop);
      case "first-line":
        return FONT.test(prop) || TEXT_DECO.test(prop) || BACKGROUND.test(prop) || /^(color|opacity|letter-spacing|word-spacing|text-transform|vertical-align|text-justify|ruby-position|text-indent)$/.test(prop);
      case "first-letter":
        return FONT.test(prop) || TEXT_DECO.test(prop) || BACKGROUND.test(prop) || /^(color|opacity|letter-spacing|word-spacing|text-transform|vertical-align|text-justify|float|initial-letter|initial-letter-align|box-shadow)$/.test(prop) || /^(margin|padding|border)(-[a-z-]+)?$/.test(prop);
      case "selection": case "target-text": case "spelling-error": case "grammar-error": case "search-text": case "highlight":
        return TEXT_DECO.test(prop) || /^(color|background-color|stroke-color|fill-color|stroke-width|-webkit-text-fill-color|-webkit-text-stroke-color|-webkit-text-stroke-width|caret-color|cursor|outline|outline-[a-z-]+)$/.test(prop);
      case "placeholder": case "file-selector-button": case "backdrop": case "before": case "after": case "details-content": case "checkmark": case "picker-icon": case "column":
        return true;
    }
    return true;
  };
  var UA = {
    marker: "unicode-bidi: isolate; font-variant-numeric: tabular-nums; white-space: pre; text-transform: none; text-indent: 0px;",
    backdrop: "position: fixed; inset: 0px;",
  };

  // ---- selector specificity [a, b, c] ----
  var specificity = function (sel) {
    var a = 0, b = 0, c = 0, s = sel;
    // functional pseudo-classes: :where() counts nothing, :is/:not/:has the most specific argument
    s = s.replace(/:(where|is|not|has|matches|-webkit-any)\(((?:[^()]|\([^()]*\))*)\)/gi, function (m, fn, args) {
      if (fn.toLowerCase() === "where") return " ";
      var best = [0, 0, 0];
      args.split(",").forEach(function (x) { var sp = specificity(x); if (sp[0] > best[0] || (sp[0] === best[0] && (sp[1] > best[1] || (sp[1] === best[1] && sp[2] > best[2])))) best = sp; });
      a += best[0]; b += best[1]; c += best[2];
      return " ";
    });
    s = s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
    s = s.replace(/\[[^\]]*\]/g, function () { b++; return " "; });
    s = s.replace(/#[A-Za-z0-9_-]+/g, function () { a++; return " "; });
    s = s.replace(/::?[A-Za-z-]+(\([^()]*\))?/g, function (m) { if (m.charAt(1) === ":" || /^:(before|after|first-line|first-letter)$/i.test(m)) c++; else b++; return " "; });
    s = s.replace(/\.[A-Za-z0-9_-]+/g, function () { b++; return " "; });
    s.replace(/(^|[\s>+~(])([A-Za-z][A-Za-z0-9-]*)/g, function () { c++; return ""; });
    return [a, b, c];
  };
  var splitList = function (text) {
    var out = [], depth = 0, cur = "", q = null;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (q) { cur += ch; if (ch === "\\") { cur += text.charAt(++i); continue; } if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === "(" || ch === "[") depth++; else if (ch === ")" || ch === "]") depth--;
      if (ch === "," && !depth) { out.push(cur.trim()); cur = ""; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  // the selector's base (without the trailing pseudo-element) when it targets `info`
  var targets = function (sel, info) {
    var m = /(::?)([A-Za-z][A-Za-z0-9-]*)(?:\(([^()]*)\))?((?::[A-Za-z-]+(?:\([^()]*\))?)*)$/.exec(sel);
    if (!m) return null;
    var name = m[2].toLowerCase();
    if (name !== info.name) return null;
    if (m[1] === ":" && !LEGACY[name]) return null;
    if (info.name === "highlight" && (m[3] || "").trim() !== info.arg) return null;
    if (m[4] && !/^(:window-inactive)?$/i.test(m[4])) return null;
    var base = sel.slice(0, m.index).trim();
    if (!base || /[>+~]$/.test(base)) base += "*";
    return base;
  };
  var mediaOk = function (rule) {
    try { var t = rule.media && rule.media.mediaText; return !t || matchMedia(t).matches; } catch (e) { return true; }
  };
  var collect = function (rules, out, el, info, order) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!r) continue;
      if (r.type === 4) { if (mediaOk(r)) collect(r.cssRules, out, el, info, order); continue; }
      if (r.type === 12 || (r.cssRules && r.type !== 1 && /^@(supports|layer|container|scope)/i.test(r.cssText || ""))) { try { collect(r.cssRules, out, el, info, order); } catch (e) {} continue; }
      if (r.type !== 1) continue;
      var selText = r.selectorText;
      if (!selText || selText.indexOf(":") < 0) continue;
      splitList(selText).forEach(function (sel) {
        var base = targets(sel, info);
        if (base === null) return;
        var ok = false; try { ok = el.matches(base); } catch (e) { ok = false; }
        if (!ok) return;
        out.push({ spec: specificity(sel), order: order.n++, style: r.style });
      });
    }
  };
  var cmp = function (x, y) {
    for (var k = 0; k < 3; k++) if (x.spec[k] !== y.spec[k]) return x.spec[k] - y.spec[k];
    return x.order - y.order;
  };
  // declarations text of the pseudo-element of `el`; highlight pseudo-elements inherit every
  // property from the parent element's same highlight (highlight inheritance)
  __jb.pseudoDeclarations = function (el, info) {
    if (!HIGHLIGHT[info.name]) return ownDeclarations(el, info);
    var chain = [];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) chain.unshift(n);
    var merged = Object.create(null), order = [];
    chain.forEach(function (n) {
      ownDeclarations(n, info, true).forEach(function (d) {
        if (!(d[0] in merged)) order.push(d[0]);
        merged[d[0]] = d;
      });
    });
    return order.map(function (p) { var d = merged[p]; return p + ": " + d[1] + (d[2] ? " !important" : ""); }).join("; ");
  };
  var ownDeclarations = function (el, info, asList) {
    var doc = el.ownerDocument, found = [], order = { n: 0 };
    var sheets = [];
    try { sheets = Array.prototype.slice.call(doc.styleSheets || []); } catch (e) {}
    try { if (doc.adoptedStyleSheets) sheets = sheets.concat(Array.prototype.slice.call(doc.adoptedStyleSheets)); } catch (e) {}
    sheets.forEach(function (sh) {
      if (!sh || sh.disabled) return;
      var rules; try { rules = sh.cssRules; } catch (e) { return; }
      if (rules) collect(rules, found, el, info, order);
    });
    found.sort(cmp);
    var normal = [], important = [], list = [];
    found.forEach(function (f) {
      var st = f.style;
      for (var i = 0; i < st.length; i++) {
        var p = st.item(i);
        if (!applies(info.name, p)) continue;
        var v = st.getPropertyValue(p);
        if (v === "") continue;
        var imp = st.getPropertyPriority(p) === "important";
        (imp ? important : normal).push(p + ": " + v + (imp ? " !important" : ""));
        list.push([p, v, imp]);
      }
    });
    if (asList) return list.filter(function (d) { return !d[2]; }).concat(list.filter(function (d) { return d[2]; }));
    return (UA[info.name] || "") + normal.concat(important).join("; ");
  };
  // CSS animations / transitions of the pseudo-element: the keyframes (or the previous and the
  // new declarations) and the progress given by a negative delay
  var timeOf = function (v) { var m = /^\s*(-?[\d.]+)(ms|s)\s*$/.exec(String(v || "").split(",")[0]); return m ? parseFloat(m[1]) * (m[2] === "s" ? 1000 : 1) : 0; };
  var findKeyframes = function (doc, name) {
    var hit = null;
    var visit = function (rules) { for (var i = 0; rules && i < rules.length; i++) { var r = rules[i]; if (r.type === 7 && r.name === name) hit = r; else if (r.cssRules && r.type !== 7) { try { visit(r.cssRules); } catch (e) {} } } };
    try { Array.prototype.forEach.call(doc.styleSheets, function (sh) { try { visit(sh.cssRules); } catch (e) {} }); } catch (e) {}
    return hit;
  };
  var animationOf = function (el, info, decls) {
    var d; try { d = document.createElement("div").style; d.cssText = decls; } catch (e) { return null; }
    var name = String(d.getPropertyValue("animation-name") || "").split(",")[0].trim();
    if (name && name !== "none") {
      var kf = findKeyframes(el.ownerDocument, name);
      var dur = timeOf(d.getPropertyValue("animation-duration")), delay = timeOf(d.getPropertyValue("animation-delay"));
      if (kf && dur > 0 && delay < 0) {
        var from = "", to = "";
        for (var i = 0; i < kf.cssRules.length; i++) { var k = kf.cssRules[i], kt = String(k.keyText).trim(); if (kt === "0%" || kt === "from") from = k.style.cssText; if (kt === "100%" || kt === "to") to = k.style.cssText; }
        return { from: from, to: to, progress: Math.min(1, -delay / dur) };
      }
    }
    // transitions: a change of the declarations (seen between two reads) starts one from the
    // previous declarations to the new ones
    var tdur = timeOf(d.getPropertyValue("transition-duration")), tdelay = timeOf(d.getPropertyValue("transition-delay"));
    var key = info.name + "(" + (info.arg || "") + ")";
    if (!el._jbPseudoLast) Object.defineProperty(el, "_jbPseudoLast", { value: {}, writable: true });
    var st = el._jbPseudoLast[key];
    if (!st) { el._jbPseudoLast[key] = { decls: decls, trans: null }; return null; }
    if (st.decls !== decls) {
      st.trans = tdur > 0 && tdelay < 0 ? { from: st.decls, to: decls, progress: Math.min(1, -tdelay / tdur) } : null;
      st.decls = decls;
    }
    if (st.trans && st.trans.to === decls) return { from: st.trans.from, to: st.trans.to, progress: st.trans.progress };
    return null;
  };
  __jb.pseudoComputedValue = function (el, info, prop) {
    var decls = "";
    try { decls = __jb.pseudoDeclarations(el, info); } catch (e) { decls = UA[info.name] || ""; }
    var an = null; try { an = animationOf(el, info, decls); } catch (e) { an = null; }
    if (!el.isConnected || typeof __jb.layoutQuery !== "function" || (__jb.layoutState && __jb.layoutState.available === false)) return null;
    if (el.__jbid === undefined || __jb.nodeById[el.__jbid] !== el) __jb.assignLayoutIds();
    var r = null;
    // Real pages: ::before / ::after as the layout engine generated them — Stylo cascades every
    // sheet, while linked sheets have no script-side rules here (FlightAware picks its row
    // template from `#results-table-template::after { content: "desktop_row" }` in a linked sheet)
    if (!__jb.wptMode && (info.name === "before" || info.name === "after") && !an) {
      try { r = __jb.layoutQuery("style", { id: el.__jbid, props: [prop], generated: info.name }); } catch (e) { r = null; }
      if (r && typeof r === "object" && typeof r[prop] === "string" && r[prop] !== "") return r[prop];
      if (prop === "content" && r && typeof r === "object") return "none";
      r = null;
    }
    var q = { id: el.__jbid, props: [prop], pseudoDecls: decls, base: el.ownerDocument ? el.ownerDocument.baseURI : "" };
    if (an) { q.animFrom = an.from; q.animTo = an.to; q.progress = an.progress; }
    try { r = __jb.layoutQuery("style", q); } catch (e) { r = null; }
    if (r && typeof r === "object" && typeof r[prop] === "string" && r[prop] !== "") return r[prop];
    // properties the layout engine does not compute: the cascaded value, else the element's
    try { var dd = document.createElement("div").style; dd.cssText = decls; var dv = dd.getPropertyValue(prop); if (dv) return dv; } catch (e) {}
    return r && typeof r === "object" && typeof r[prop] === "string" ? r[prop] : null;
  };

  var baseGCS = globalThis.getComputedStyle;
  globalThis.getComputedStyle = function getComputedStyle(el, pseudo) {
    if (!(el instanceof Element)) return baseGCS.apply(this, arguments);
    var ps = pseudo === undefined || pseudo === null ? "" : String(pseudo);
    if (ps === "" || ps.charAt(0) !== ":") return baseGCS.call(this, el);
    var info = __jb.parsePseudoArgument(ps);
    if (!info) {
      var empty = new CSSStyleDeclaration(null);
      Object.defineProperty(empty, "_readOnly", { value: true });
      return __jb.styleProxy(empty);
    }
    var decl = baseGCS.call(this, el, ps);
    if (el.isConnected && el.ownerDocument === __jb.currentDocument) {
      Object.defineProperty(decl, "_computedFor", { value: el });
      Object.defineProperty(decl, "_pseudoInfo", { value: info });
    }
    return decl;
  };
})();
