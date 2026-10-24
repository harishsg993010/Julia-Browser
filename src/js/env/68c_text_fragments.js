// Part 6e: URL fragment directives / scroll to text fragment (https://wicg.github.io/scroll-to-text-fragment/).
// The fragment directive (`:~:` and everything after it in the fragment) is removed from the
// document's URL before the document sees it; `text=` directives are matched against the
// rendered text (case-insensitive, word bounded, optional prefix/suffix context and a
// textStart,textEnd range) and the first match is scrolled into view and becomes :target.
(function () {
  if (globalThis.__jb_workerRealm) return;
  var DELIM = ":~:";
  // Splits a URL into the URL without its fragment directive and the directive string.
  __jb.splitFragmentDirective = function (url) {
    var s = String(url), hash = s.indexOf("#");
    if (hash < 0) return { url: s, directive: null };
    var frag = s.slice(hash + 1), i = frag.indexOf(DELIM);
    if (i < 0) return { url: s, directive: null };
    var kept = frag.slice(0, i);
    return { url: s.slice(0, hash) + "#" + kept, directive: frag.slice(i + DELIM.length) };
  };
  var dec = function (t) { try { return decodeURIComponent(t); } catch (e) { return null; } };
  // "parse a text directive": [prefix-,]textStart[,textEnd][,-suffix]
  __jb.parseTextDirectives = function (directive) {
    var out = [];
    String(directive || "").split("&").forEach(function (d) {
      if (d.indexOf("text=") !== 0) return;
      var parts = d.slice(5).split(",");
      if (!parts.length || parts.length > 4) return;
      var r = { prefix: null, start: null, end: null, suffix: null };
      if (parts[0].slice(-1) === "-") { r.prefix = dec(parts.shift().slice(0, -1)); if (r.prefix === null || r.prefix === "") return; }
      if (parts.length && parts[parts.length - 1].charAt(0) === "-") { r.suffix = dec(parts.pop().slice(1)); if (r.suffix === null || r.suffix === "") return; }
      if (parts.length < 1 || parts.length > 2) return;
      r.start = dec(parts[0]); if (!r.start) return;
      if (parts.length === 2) { r.end = dec(parts[1]); if (!r.end) return; }
      if (parts.some(function (p) { return /^-|-$/.test(p); })) return;
      out.push(r);
    });
    return out;
  };

  // ---- searchable text: text nodes in flat-tree order, grouped by their block ancestor
  var SKIP = { script: 1, style: 1, noscript: 1, template: 1, head: 1, title: 1, iframe: 1, object: 1, embed: 1, video: 1, audio: 1, img: 1, canvas: 1, select: 1, input: 1, textarea: 1 };
  var cs = function (el) { try { return getComputedStyle(el); } catch (e) { return null; } };
  var isBlock = function (el) { var s = cs(el), d = s && s.display || ""; return !/^(inline|inline-block|inline-flex|inline-grid|contents|ruby|ruby-text)$/.test(d) && d !== ""; };
  var hiddenEl = function (el) { var s = cs(el); return !!s && (s.display === "none"); };
  var collect = function (doc) {
    var items = []; // {node, text, block, invisible}
    var walk = function (n, block, invisible) {
      if (n.nodeType === 3) { items.push({ node: n, text: n.data, block: block, invisible: invisible }); return; }
      if (n.nodeType !== 1 && n.nodeType !== 11 && n.nodeType !== 9) return;
      var b = block, inv = invisible;
      if (n.nodeType === 1) {
        if (SKIP[n.localName]) return;
        if (hiddenEl(n)) return;
        if (isBlock(n)) b = n;
        var s = cs(n); if (s && (s.visibility === "hidden" || s.visibility === "collapse")) inv = true;
        if (n.shadowRoot && n.shadowRoot.mode !== undefined) { walk(n.shadowRoot, b, inv); return; }
      }
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1 && c.localName === "slot" && typeof c.assignedNodes === "function") { var an = c.assignedNodes({ flatten: true }); if (an.length) { an.forEach(function (x) { walk(x, b, inv); }); continue; } }
        walk(c, b, inv);
      }
    };
    walk(doc.body || doc.documentElement, doc.body || doc.documentElement, false);
    return items;
  };
  // A normalized string over all items with whitespace runs collapsed to one space and a block
  // boundary marked by "\n" (matches never cross it); map[i] = {item, offset} for each character.
  var flatten = function (items) {
    var str = "", map = [], lastBlock = null, lastSpace = true;
    items.forEach(function (it) {
      if (lastBlock !== null && it.block !== lastBlock) { if (str.length && str.charAt(str.length - 1) !== "\n") { str += "\n"; map.push(null); } lastSpace = true; }
      lastBlock = it.block;
      var t = it.text;
      for (var i = 0; i < t.length; i++) {
        var ch = t.charAt(i);
        if (/[\t\n\f\r ]/.test(ch)) { if (lastSpace) continue; ch = " "; lastSpace = true; } else lastSpace = false;
        str += ch; map.push({ item: it, offset: i });
      }
    });
    return { str: str, map: map };
  };
  var fold = function (s) { return s.toLowerCase().replace(/\s+/g, " "); };
  var isWordChar = function (c) { return !!c && /[\p{L}\p{N}_]/u.test(c); };
  var boundaryAt = function (s, i) { return i <= 0 || i >= s.length || !(isWordChar(s.charAt(i - 1)) && isWordChar(s.charAt(i))); };
  var findWord = function (hay, needle, from, to) {
    for (var i = hay.indexOf(needle, from); i >= 0 && (to === undefined || i + needle.length <= to); i = hay.indexOf(needle, i + 1)) {
      if (boundaryAt(hay, i) && boundaryAt(hay, i + needle.length) && hay.slice(i, i + needle.length).indexOf("\n") < 0) return i;
    }
    return -1;
  };
  // a prefix starts on a word boundary but need not end on one
  var findPrefix = function (hay, needle, from) {
    for (var i = hay.indexOf(needle, from); i >= 0; i = hay.indexOf(needle, i + 1)) {
      if (boundaryAt(hay, i) && hay.slice(i, i + needle.length).indexOf("\n") < 0) return i;
    }
    return -1;
  };
  var skipWs = function (s, i) { while (i < s.length && s.charAt(i) === " ") i++; return i; };
  // Returns [startIndex, endIndex) in the flattened string, or null.
  var match = function (flat, d) {
    var hay = fold(flat.str), start = fold(d.start), end = d.end && fold(d.end), prefix = d.prefix && fold(d.prefix), suffix = d.suffix && fold(d.suffix);
    var pos = 0;
    while (pos <= hay.length) {
      var s;
      if (prefix) {
        var p = findPrefix(hay, prefix, pos);
        if (p < 0) return null;
        pos = p + 1;
        s = skipWs(hay, p + prefix.length);
        if (hay.slice(s, s + start.length) !== start || !boundaryAt(hay, s + start.length) && !end) continue;
      } else {
        s = findWord(hay, start, pos);
        if (s < 0) return null;
        pos = s + 1;
      }
      var e = s + start.length;
      if (end) {
        var ee = findWord(hay, end, e);
        if (ee < 0) return null;
        e = ee + end.length;
      } else if (!boundaryAt(hay, e)) continue;
      if (suffix) {
        var t = skipWs(hay, e);
        if (hay.slice(t, t + suffix.length) !== suffix || !boundaryAt(hay, t + suffix.length)) continue;
      }
      return [s, e];
    }
    return null;
  };
  var toRange = function (doc, flat, m) {
    var a = flat.map[m[0]], b = null;
    for (var k = m[1] - 1; k >= m[0] && !b; k--) b = flat.map[k];
    if (!a || !b) return null;
    var r = doc.createRange();
    r.setStart(a.item.node, a.offset);
    r.setEnd(b.item.node, b.offset + 1);
    return { range: r, invisible: a.item.invisible };
  };
  __jb.findTextDirectiveRanges = function (doc, directive) {
    var ds = __jb.parseTextDirectives(directive);
    if (!ds.length) return [];
    var flat = flatten(collect(doc)), out = [];
    ds.forEach(function (d) { var m = match(flat, d); var r = m && toRange(doc, flat, m); if (r) out.push(r); });
    return out;
  };
  var scrollRangeIntoView = function (r) {
    try {
      var rect = r.getBoundingClientRect();
      var el = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode;
      if ((!rect || (!rect.width && !rect.height && !rect.top && !rect.left)) && el && el.scrollIntoView) { el.scrollIntoView({ block: "center", inline: "nearest" }); return; }
      var vw = globalThis.innerWidth, vh = globalThis.innerHeight, x = globalThis.scrollX, y = globalThis.scrollY;
      var ny = y + rect.top + rect.height / 2 - vh / 2;
      if (rect.height > vh) ny = y + rect.top;
      var nx = x;
      if (rect.left < 0 || rect.right > vw) nx = x + rect.left - Math.max(0, (vw - rect.width) / 2);
      globalThis.scrollTo(Math.max(0, nx), Math.max(0, ny));
    } catch (e) {}
  };
  // Invoked when the document finished parsing (before the load event) and on same-document
  // navigations to a URL that carried a directive.
  __jb.applyTextDirectives = function (doc) {
    doc = doc || __jb.currentDocument;
    var directive = doc._fragmentDirective;
    if (!directive) return false;
    doc._fragmentDirective = null;
    if (__jb.auxiliary && __jb.auxiliary.opener && !__jb.auxiliary.noopener && globalThis.opener) return false; // only top-level, no opener
    var found = __jb.findTextDirectiveRanges(doc, directive);
    if (!found.length) return false;
    var first = found[0], r = first.range;
    var el = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode;
    doc._targetOverride = el;
    if (!first.invisible) scrollRangeIntoView(r);
    try { var sel = doc.getSelection && doc.getSelection(); if (sel && __jb.wptMode !== true) { /* highlighting is visual only */ } } catch (e) {}
    return true;
  };

  // document.fragmentDirective ([SameObject] FragmentDirective)
  try {
    Object.defineProperty(Document.prototype, "fragmentDirective", {
      get: function () {
        if (!(this instanceof Document)) throw new TypeError("Illegal invocation");
        if (!this._fragDirObj) { var C = globalThis.FragmentDirective; Object.defineProperty(this, "_fragDirObj", { value: Object.create(C && C.prototype ? C.prototype : Object.prototype), configurable: true }); }
        return this._fragDirObj;
      },
      enumerable: true, configurable: true,
    });
  } catch (e) {}
})();
