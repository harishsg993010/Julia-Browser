// CSS Shapes properties (shape-outside, shape-margin, shape-image-threshold) are not in Stylo's
// servo build. Their grammars are those of properties Stylo does implement, so values are
// validated and serialized by Stylo through a proxy property (shape-outside: clip-path for basic
// shapes and boxes, background-image for images; shape-margin: padding-left; shape-image-threshold:
// opacity), and computed values come from the same proxy declaration computed for the element.
(function () {
  var LONG = __jb.cssLong;
  if (!LONG) return;
  var native = function (payload) { try { return __jb.native("cssdecl", payload); } catch (e) { return null; } };
  // Stylo's specified-value serialization of `value` as `prop`, or null when invalid
  var styloAs = function (prop, value) {
    if (!__jb.styloCssom || !__jb.styloCssom()) return null;
    var r = native({ op: "parse", text: prop + ": " + value });
    if (!r || r.invalid || typeof r.css !== "string") return null;
    var m = new RegExp("^" + prop + ": (.*);$").exec(r.css.trim());
    return m ? m[1] : null;
  };
  var IMAGE = /^(url|image|image-set|-webkit-image-set|cross-fade|element|(?:repeating-)?(?:linear|radial|conic)-gradient)\(/i;
  var topComma = function (v) { var d = 0; for (var i = 0; i < v.length; i++) { var c = v.charAt(i); if (c === "(") d++; else if (c === ")") d--; else if (c === "," && d === 0) return true; } return false; };
  // [proxy property, value] for a shape-outside value, or null when the grammar rejects it
  var shapeProxy = function (v) {
    v = String(v).trim();
    if (/^none$/i.test(v)) return ["clip-path", "none"];
    if (IMAGE.test(v)) return topComma(v) ? null : ["background-image", v];
    // <shape-box> is <visual-box> | margin-box (no SVG geometry boxes)
    if (/(^|[\s)])(fill-box|stroke-box|view-box)(\s|$)/i.test(v)) return null;
    return ["clip-path", v];
  };
  var PROXY = {
    "shape-outside": shapeProxy,
    "shape-margin": function (v) { return ["padding-left", v]; },
    "shape-image-threshold": function (v) { return ["opacity", v]; },
  };
  var INITIAL = { "shape-outside": "none", "shape-margin": "0px", "shape-image-threshold": "0" };
  Object.keys(PROXY).forEach(function (name) {
    LONG[name] = function (v) {
      var px = PROXY[name](v);
      if (!px) return null;
      // polygon(round <length>, ...) is newer than Stylo: serialize without the rounding clause
      var round = name === "shape-outside" ? /^polygon\(\s*(?:(nonzero|evenodd)\s+)?round\s+((?:[^,()]|\([^()]*(?:\([^()]*\)[^()]*)*\))+),/i.exec(px[1]) : null;
      if (round) {
        var len = styloAs("padding-left", round[2].trim());
        if (len === null) return null;
        var rest = styloAs("clip-path", "polygon(" + (round[1] ? round[1] + ", " : "") + px[1].slice(round[0].length));
        if (rest === null) return null;
        return rest.replace(/^polygon\((?:(nonzero|evenodd), )?/, function (m, rule) { return "polygon(" + (rule ? rule + " " : "") + (len === "0px" ? "" : "round " + len + ", "); });
      }
      var out = styloAs(px[0], px[1]);
      if (out === null) return null;
      if (name === "shape-outside" && px[0] === "clip-path" && /^none$/i.test(out) && !/^none$/i.test(String(v).trim())) return null;
      return out;
    };
  });

  // computed values: the proxy declaration computed on a box inheriting from the element
  // (animated values still come first: 63_animations.js layers them on __jb.computedValue, and
  // its underlying-value reader is pointed at the proxy computation)
  var baseComputed = __jb.computedValue;
  __jb.computedValue = function (el, prop) {
    if (!(prop in PROXY)) return baseComputed(el, prop);
    var v = baseComputed(el, prop);
    if (v !== null && v !== undefined && v !== "") return v;
    return proxyComputed(el, prop);
  };
  var A = __jb.anim;
  if (A && typeof A.rawComputed === "function") {
    var baseRaw = A.rawComputed;
    A.rawComputed = function (el, prop) { return prop in PROXY ? proxyComputed(el, prop) : baseRaw(el, prop); };
  }
  function proxyComputed(el, prop) {
    if (!el || !el.isConnected || typeof __jb.layoutQuery !== "function" || (__jb.layoutState && __jb.layoutState.available === false)) return null;
    var spec = "";
    try { spec = el.style ? el.style.getPropertyValue(prop) : ""; } catch (e) { spec = ""; }
    if (!spec && typeof __jb.authorStyle === "function") { try { spec = __jb.authorStyle(el, prop) || ""; } catch (e) { spec = ""; } }
    spec = String(spec).trim();
    if (!spec || /^(initial|unset|revert|revert-layer)$/i.test(spec)) return INITIAL[prop];
    if (/^inherit$/i.test(spec)) { var p = el.parentElement; return p ? __jb.computedValue(p, prop) : INITIAL[prop]; }
    var px = PROXY[prop](spec);
    if (!px) return INITIAL[prop];
    if (el.__jbid === undefined || __jb.nodeById[el.__jbid] !== el) __jb.assignLayoutIds();
    var r = null;
    try { r = __jb.layoutQuery("style", { id: el.__jbid, props: [px[0]], pseudoDecls: px[0] + ": " + px[1], base: /url\(/i.test(px[1]) && el.ownerDocument ? el.ownerDocument.baseURI : "" }); } catch (e) { r = null; }
    var v = r && typeof r === "object" && typeof r[px[0]] === "string" ? r[px[0]] : null;
    return v === null || v === "" ? spec : v;
  };
})();
