// ---------------------------------------------------------------- shadow style scoping for the layout mirror
// The layout engine sees the flat tree as one document, so a shadow tree's styles are rewritten to
// apply only inside it: its elements carry data-jbs="N", its host data-jbh="N", elements slotted
// into it data-jbsl="N". `:host(...)` maps to the host, `::slotted(x)` to slotted elements, and every
// other selector's subject must be inside the shadow tree.
(function () {
  var cache = new Map();
  // Split at top-level occurrences of the given characters (outside (), [], strings).
  var splitTop = function (s, chars) {
    var out = [], cur = "", depth = 0, q = null;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (q) { cur += c; if (c === "\\") { cur += s.charAt(++i); } else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      if (depth === 0 && chars.indexOf(c) >= 0) { out.push(cur); cur = ""; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  };
  // Index where the last compound selector starts.
  var lastCompoundStart = function (sel) {
    var depth = 0, q = null, start = 0;
    for (var i = 0; i < sel.length; i++) {
      var c = sel.charAt(i);
      if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (depth === 0 && (c === " " || c === ">" || c === "+" || c === "~" || c === "\t" || c === "\n")) start = i + 1;
    }
    return start;
  };
  // Insert `attr` into a compound before its top-level pseudo-element.
  var addToCompound = function (compound, attr) {
    var depth = 0;
    for (var i = 0; i < compound.length; i++) {
      var c = compound.charAt(i);
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (depth === 0 && c === ":" && (compound.charAt(i + 1) === ":" || /^:(before|after|first-line|first-letter)\b/i.test(compound.slice(i)))) return compound.slice(0, i) + attr + compound.slice(i);
    }
    return compound + attr;
  };
  var balancedArg = function (s, open) { // s[open] === "(" -> [arg, indexAfterClose]
    var depth = 0;
    for (var i = open; i < s.length; i++) { var c = s.charAt(i); if (c === "(") depth++; else if (c === ")") { depth--; if (depth === 0) return [s.slice(open + 1, i), i + 1]; } }
    return [s.slice(open + 1), s.length];
  };
  var scopeComplex = function (sel, id) {
    var host = '[data-jbh="' + id + '"]', inside = '[data-jbs="' + id + '"]';
    sel = sel.trim();
    if (!sel) return sel;
    var m = /^:host(-context)?/i.exec(sel);
    if (m) {
      var rest = sel.slice(m[0].length), head = host;
      if (rest.charAt(0) === "(") { var ba = balancedArg(rest, 0); head = m[1] ? ":is(" + ba[0] + ") " + host : host + ":is(" + ba[0] + ")"; rest = ba[1] < rest.length ? rest.slice(ba[1]) : ""; }
      if (!rest.trim()) return head + rest;
      if (/^\s*::?[a-z-]/i.test(rest) && !/^\s+/.test(rest)) return head + rest; // :host::before / :host(:hover)
      var s2 = rest, at = lastCompoundStart(s2);
      return head + s2.slice(0, at) + scopeLast(s2.slice(at), id, inside);
    }
    var at2 = lastCompoundStart(sel);
    return sel.slice(0, at2) + scopeLast(sel.slice(at2), id, inside);
  };
  var scopeLast = function (compound, id, inside) {
    var sm = /::slotted\(/i.exec(compound);
    if (sm) { var ba = balancedArg(compound, sm.index + sm[0].length - 1); return compound.slice(0, sm.index) + ":is(" + ba[0] + ')[data-jbsl="' + id + '"]' + compound.slice(ba[1]); }
    return addToCompound(compound, inside);
  };
  var scopeSelectorList = function (prelude, id) { return splitTop(prelude, ",").map(function (s) { return scopeComplex(s, id); }).join(", "); };
  var GROUPING = /^@(media|supports|layer|container|document|scope|starting-style)\b/i;
  var scopeBlock = function (css, id) {
    var out = "", i = 0, n = css.length;
    while (i < n) {
      // read up to '{', ';' or '}' at top level
      var j = i, depth = 0, q = null;
      while (j < n) {
        var c = css.charAt(j);
        if (q) { if (c === "\\") j++; else if (c === q) q = null; j++; continue; }
        if (c === "/" && css.charAt(j + 1) === "*") { var e = css.indexOf("*/", j + 2); j = e < 0 ? n : e + 2; continue; }
        if (c === '"' || c === "'") { q = c; j++; continue; }
        if (c === "(" || c === "[") depth++;
        else if (c === ")" || c === "]") depth--;
        else if (depth <= 0 && (c === "{" || c === ";")) break;
        j++;
      }
      if (j >= n || css.charAt(j) === ";") { out += css.slice(i, Math.min(j + 1, n)); i = j + 1; continue; }
      // block: find the matching '}'
      var k = j + 1, d = 1; q = null;
      while (k < n && d > 0) {
        var ch = css.charAt(k);
        if (q) { if (ch === "\\") k++; else if (ch === q) q = null; k++; continue; }
        if (ch === "/" && css.charAt(k + 1) === "*") { var e2 = css.indexOf("*/", k + 2); k = e2 < 0 ? n : e2 + 2; continue; }
        if (ch === '"' || ch === "'") q = ch;
        else if (ch === "{") d++;
        else if (ch === "}") d--;
        k++;
      }
      var prelude = css.slice(i, j), body = css.slice(j + 1, k - 1), p = prelude.trim();
      if (p.charAt(0) === "@") out += prelude + "{" + (GROUPING.test(p) ? scopeBlock(body, id) : body) + "}";
      else out += scopeSelectorList(prelude, id) + "{" + scopeBlock(body, id) + "}";
      i = k;
    }
    return out;
  };
  __jb.scopeCss = function (css, id) {
    css = String(css || "");
    var key = id + "\u0000" + css, hit = cache.get(key);
    if (hit !== undefined) return hit;
    var r;
    try { r = scopeBlock(css, id); } catch (e) { r = ""; }
    if (cache.size > 500) cache.clear();
    cache.set(key, r);
    return r;
  };
  __jb.layoutScope = null;
  __jb.layoutScopeSeq = 0;
})();
