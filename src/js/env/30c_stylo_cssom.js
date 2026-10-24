// Part 3c: specified-value CSSOM through Stylo (host op "cssdecl", src/layout/cssom.rs).
// When the layout engine is compiled in, element.style / rule.style declaration blocks are parsed,
// validated and serialized by Stylo: invalid values are rejected per property grammar, shorthands
// expand to longhands and serialize back, `!important` and custom properties behave as in a
// browser. The block's state is its serialized text (`_styCss`); `_props` / `_priority` mirror the
// longhand list for the code that reads them directly. Computed declarations (getComputedStyle)
// keep their own path.
(function () {
  var P = CSSStyleDeclaration.prototype;
  var avail = null;
  var native = function (payload) { try { return __jb.native("cssdecl", payload); } catch (e) { return null; } };
  __jb.styloCssom = function () {
    if (avail === null) { var r = native({ op: "parse", text: "color: red" }); avail = !!(r && r.css === "color: red;"); }
    return avail;
  };
  var on = function (d) { return !d._computedFor && !d._readOnly && !d._jsOnly && __jb.styloCssom(); };
  var docOf = function (d) { var o = d._owner; return (o && o.ownerDocument) || (d.parentRule && d.parentRule.parentStyleSheet && d.parentRule.parentStyleSheet.ownerNode && d.parentRule.parentStyleSheet.ownerNode.ownerDocument) || __jb.currentDocument; };
  // The base URL only matters for url() values (computing baseURI scans the document for <base>).
  var opts = function (d, o) {
    var doc = docOf(d);
    if (/url\(/i.test((o.text || "") + (o.value || ""))) { try { o.base = doc && doc.baseURI || undefined; } catch (e) {} }
    o.quirks = !!(doc && doc._quirks);
    return o;
  };
  var apply = function (d, r) {
    if (!r || r.invalid || r.unchanged || typeof r.css !== "string") return false;
    var changed = d._styCss !== r.css;
    d._styCss = r.css;
    d._props = r.list.map(function (x) { return [x[0], x[1]]; });
    d._priority = {};
    r.list.forEach(function (x) { if (x[2]) d._priority[x[0]] = "important"; });
    mirror(d);
    d._getCache = null;
    return changed;
  };
  var text = function (d) {
    if (d._styCss === undefined) {
      var raw = d._props.map(function (p) { return p[0] + ": " + p[1] + (d._priority[p[0]] ? " !important" : "") + ";"; }).join(" ");
      if (!apply(d, native(opts(d, { op: "parse", text: raw })))) d._styCss = d._styCss || "";
    }
    return d._styCss;
  };
  var propName = function (n) { n = String(n); return n.slice(0, 2) === "--" ? n : n.toLowerCase(); };
  // Properties Stylo does not know but 30b_cssparse.js validates (tentative trigger / timeline
  // properties) live in `_extra` as [name, value, important] longhands appended to the block.
  var knownCache = Object.create(null);
  var styloKnows = function (n) { if (!(n in knownCache)) { var r = native({ op: "known", prop: n }); knownCache[n] = r !== false; } return knownCache[n]; };
  var jsSupports = null; // the 30b validator (set below)
  var jsKnows = function (n) { return !!jsSupports && jsSupports(n, "@") !== null; };
  // ...or a standard property Stylo's servo build does not implement (stored as given, as before)
  var jsOk = function (n) { return jsKnows(n) || !!(__jb.KNOWN_CSS_PROPERTIES && __jb.KNOWN_CSS_PROPERTIES[n]); };
  var scratch = function (list) { var t = new CSSStyleDeclaration(null); Object.defineProperty(t, "_jsOnly", { value: true }); (list || []).forEach(function (x) { t._props.push([x[0], x[1]]); if (x[2]) t._priority[x[0]] = "important"; }); return t; };
  var fromScratch = function (t) { return t._props.map(function (p) { return [p[0], p[1], t._priority[p[0]] === "important"]; }); };
  var extraText = function (d) { return (d._extra || []).map(function (x) { return x[0] + ": " + x[1] + (x[2] ? " !important" : "") + ";"; }).join(" "); };
  var mirror = function (d) { (d._extra || []).forEach(function (x) { d._props.push([x[0], x[1]]); if (x[2]) d._priority[x[0]] = "important"; }); };

  var origLoad = P._load;
  P._load = function (t) {
    if (!on(this)) return origLoad.call(this, t);
    this._styCss = undefined;
    // Real pages: declarations of parsed style sheet rules (no owner element) are split by the JS
    // parser; Stylo serializes them only when the page asks (text() parses lazily). A Stylo round
    // trip per rule for every inserted <style> (Angular component styles) cost FedEx's tracking
    // app ~4 s in one task, which the budget then killed, wedging zone.js.
    if (!this._owner && !__jb.wptMode && !(typeof __jb.topJb === "function" && __jb.topJb().wptMode)) { this._extra = []; return origLoad.call(this, t); }
    var src = String(t === null || t === undefined ? "" : t);
    var extras = scratch();
    CSSStyleDeclaration._parse(src).forEach(function (p) { var n = propName(p[0]); if (!styloKnows(n) && jsOk(n)) { var imp = /!\s*important\s*$/i.test(p[1]); prevSet.call(extras, n, p[1].replace(/\s*!\s*important\s*$/i, ""), imp ? "important" : ""); } });
    this._extra = fromScratch(extras);
    if (!apply(this, native(opts(this, { op: "parse", text: src })))) { this._props = []; this._priority = {}; this._styCss = ""; mirror(this); }
  };
  var cssTextDesc = Object.getOwnPropertyDescriptor(P, "cssText");
  Object.defineProperty(P, "cssText", {
    get: function () { if (!on(this)) return cssTextDesc.get.call(this); var a = text(this), b = extraText(this); return a && b ? a + " " + b : a || b; },
    set: function (v) { if (this._readOnly) throw __jb.domError("NoModificationAllowedError", "The declaration is read-only"); cssTextDesc.set.call(this, v); },
    enumerable: cssTextDesc.enumerable, configurable: true,
  });
  var prevSet = P.setProperty, prevGet = P.getPropertyValue, prevRemove = P.removeProperty, prevPrio = P.getPropertyPriority;
  P.setProperty = function (n, v, prio) {
    if (!on(this)) return prevSet.apply(this, arguments);
    n = propName(n);
    if (this._owner && __jb.anim && typeof __jb.anim.recordBefore === "function" && !/^transition/.test(n)) { try { __jb.anim.recordBefore(this._owner, n); } catch (e) {} }
    if (v === null || v === undefined || String(v) === "") { this.removeProperty(n); return; }
    v = String(v);
    var p = prio === undefined || prio === null ? "" : String(prio);
    if (p !== "" && p.toLowerCase() !== "important") return;
    text(this);
    if (!styloKnows(n)) {
      if (!jsOk(n)) return;
      var t = scratch(this._extra);
      prevSet.call(t, n, v, p);
      var next = fromScratch(t);
      if (JSON.stringify(next) !== JSON.stringify(this._extra || [])) { this._extra = next; mirrorReset(this); this._sync(); }
      return;
    }
    if (apply(this, native(opts(this, { op: "set", text: this._styCss, prop: n, value: v, important: p !== "" })))) this._sync();
  };
  var mirrorReset = function (d) { d._props = []; d._priority = {}; var r = native(opts(d, { op: "parse", text: d._styCss || "" })); if (r && r.list) { r.list.forEach(function (x) { d._props.push([x[0], x[1]]); if (x[2]) d._priority[x[0]] = "important"; }); } mirror(d); d._getCache = null; };
  P.getPropertyValue = function (n) {
    if (!on(this)) return prevGet.apply(this, arguments);
    n = propName(n);
    var t = text(this);
    for (var i = 0; i < this._props.length; i++) if (this._props[i][0] === n) return this._props[i][1];
    if (!styloKnows(n)) return jsOk(n) ? prevGet.call(scratch(this._extra), n) : "";
    var cache = this._getCache || (this._getCache = Object.create(null));
    if (!(n in cache)) { var r = native(opts(this, { op: "get", text: t, prop: n })); cache[n] = r || { value: "", important: false }; }
    return cache[n].value || "";
  };
  P.getPropertyPriority = function (n) {
    if (!on(this)) return prevPrio.apply(this, arguments);
    n = propName(n);
    var t = text(this);
    if (this._priority[n]) return "important";
    var cache = this._getCache || (this._getCache = Object.create(null));
    if (!(n in cache)) { var r = native(opts(this, { op: "get", text: t, prop: n })); cache[n] = r || { value: "", important: false }; }
    return cache[n].important ? "important" : "";
  };
  P.removeProperty = function (n) {
    if (!on(this)) return prevRemove.apply(this, arguments);
    if (this._readOnly) throw __jb.domError("NoModificationAllowedError", "The declaration is read-only");
    n = propName(n);
    if (!styloKnows(n)) {
      if (!jsOk(n)) return "";
      var t = scratch(this._extra), old = prevGet.call(t, n);
      prevRemove.call(t, n);
      this._extra = fromScratch(t);
      mirrorReset(this);
      this._sync();
      return old;
    }
    var r = native(opts(this, { op: "remove", text: text(this), prop: n }));
    if (!r) return "";
    if (apply(this, r)) this._sync();
    return r.old || "";
  };
  // Media query lists as CSSOM serializes them ("not all" when invalid).
  __jb.normalizeMedia = function (t) {
    t = String(t === null || t === undefined ? "" : t);
    if (!__jb.styloCssom()) return t.trim();
    var r = native({ op: "media", text: t });
    return r && typeof r.text === "string" ? r.text : t.trim();
  };
  // CSS.supports(property, value) / CSS.supports(conditionText)
  var prevSupports = __jb.cssSupports;
  jsSupports = prevSupports;
  __jb.cssSupports = function (prop, value) {
    if (__jb.styloCssom() && styloKnows(propName(prop))) { var r = native({ op: "supports", prop: propName(prop), value: String(value) }); if (typeof r === "boolean") return r; }
    return prevSupports ? prevSupports(prop, value) : null;
  };
  __jb.cssSupportsCondition = function (cond) {
    // selector(X): the selector engine's own validity (Stylo's supports evaluation lacks :has())
    var sm = /^\s*selector\(([\s\S]*)\)\s*$/i.exec(String(cond));
    if (sm && !/\)\s*(and|or)\s/i.test(sm[1])) { try { __jb.currentDocument.createDocumentFragment().querySelector(sm[1]); return sm[1].trim() !== ""; } catch (e) { return false; } }
    if (!__jb.styloCssom()) return null;
    var r = native({ op: "supports", cond: String(cond) });
    return typeof r === "boolean" ? r : null;
  };
})();
