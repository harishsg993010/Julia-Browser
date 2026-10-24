// ---- HTML Sanitizer and declarative partial updates ------------------------------------------
// The Sanitizer interface and the sanitization algorithms follow HTML "HTML sanitization" (8.6):
// configurations are canonicalized and validated, get() sorts, the modifier methods keep the
// configuration valid, and the inner sanitize steps filter elements, attributes, comments,
// processing instructions and javascript: URLs. Element.setHTML / Document.parseHTML sanitize with
// the safe default; setHTMLUnsafe / parseHTMLUnsafe sanitize only when given a sanitizer. The
// positional methods {append,prepend,before,after,replaceWith}HTML[Unsafe] parse in the context of
// the target's parent (or the shadow host / template) and insert the result.
(function () {
  var HTML_NS = __jb.HTML_NS, SVG_NS = __jb.SVG_NS, MATHML_NS = __jb.MATHML_NS, XLINK_NS = "http://www.w3.org/1999/xlink";
  var dom = function (name, msg) { return new DOMException(msg || name, name); };
  var DEFAULT_CONFIG = {"elements":[{"name":"math","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"merror","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"mfrac","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"mi","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"mmultiscripts","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"mn","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"mo","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[{"name":"fence","namespace":null},{"name":"form","namespace":null},{"name":"largeop","namespace":null},{"name":"lspace","namespace":null},{"name":"maxsize","namespace":null},{"name":"minsize","namespace":null},{"name":"movablelimits","namespace":null},{"name":"rspace","namespace":null},{"name":"separator","namespace":null},{"name":"stretchy","namespace":null},{"name":"symmetric","namespace":null}]},{"name":"mover","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[{"name":"accent","namespace":null}]},{"name":"mpadded","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[{"name":"depth","namespace":null},{"name":"height","namespace":null},{"name":"lspace","namespace":null},{"name":"voffset","namespace":null},{"name":"width","namespace":null}]},{"name":"mphantom","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"mprescripts","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"mroot","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"mrow","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"ms","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"mspace","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[{"name":"depth","namespace":null},{"name":"height","namespace":null},{"name":"width","namespace":null}]},{"name":"msqrt","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"mstyle","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"msub","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"msubsup","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"msup","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"mtable","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"mtd","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[{"name":"columnspan","namespace":null},{"name":"rowspan","namespace":null}]},{"name":"mtext","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"mtr","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"munder","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[{"name":"accentunder","namespace":null}]},{"name":"munderover","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[{"name":"accent","namespace":null},{"name":"accentunder","namespace":null}]},{"name":"semantics","namespace":"http://www.w3.org/1998/Math/MathML","attributes":[]},{"name":"a","namespace":"http://www.w3.org/1999/xhtml","attributes":[{"name":"href","namespace":null},{"name":"hreflang","namespace":null},{"name":"type","namespace":null}]},{"name":"abbr","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"address","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"article","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"aside","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"b","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"bdi","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"bdo","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"blockquote","namespace":"http://www.w3.org/1999/xhtml","attributes":[{"name":"cite","namespace":null}]},{"name":"body","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"br","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"caption","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"cite","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"code","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"col","namespace":"http://www.w3.org/1999/xhtml","attributes":[{"name":"span","namespace":null}]},{"name":"colgroup","namespace":"http://www.w3.org/1999/xhtml","attributes":[{"name":"span","namespace":null}]},{"name":"data","namespace":"http://www.w3.org/1999/xhtml","attributes":[{"name":"value","namespace":null}]},{"name":"dd","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"del","namespace":"http://www.w3.org/1999/xhtml","attributes":[{"name":"cite","namespace":null},{"name":"datetime","namespace":null}]},{"name":"dfn","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"div","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"dl","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"dt","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"em","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"figcaption","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"figure","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"footer","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"h1","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"h2","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"h3","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"h4","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"h5","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"h6","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"head","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"header","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"hgroup","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"hr","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"html","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"i","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"ins","namespace":"http://www.w3.org/1999/xhtml","attributes":[{"name":"cite","namespace":null},{"name":"datetime","namespace":null}]},{"name":"kbd","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"li","namespace":"http://www.w3.org/1999/xhtml","attributes":[{"name":"value","namespace":null}]},{"name":"main","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"mark","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"menu","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"nav","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"ol","namespace":"http://www.w3.org/1999/xhtml","attributes":[{"name":"reversed","namespace":null},{"name":"start","namespace":null},{"name":"type","namespace":null}]},{"name":"p","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"pre","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"q","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"rp","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"rt","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"ruby","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"s","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"samp","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"search","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"section","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"small","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"span","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"strong","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"sub","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"sup","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"table","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"tbody","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"td","namespace":"http://www.w3.org/1999/xhtml","attributes":[{"name":"colspan","namespace":null},{"name":"headers","namespace":null},{"name":"rowspan","namespace":null}]},{"name":"tfoot","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"th","namespace":"http://www.w3.org/1999/xhtml","attributes":[{"name":"abbr","namespace":null},{"name":"colspan","namespace":null},{"name":"headers","namespace":null},{"name":"rowspan","namespace":null},{"name":"scope","namespace":null}]},{"name":"thead","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"time","namespace":"http://www.w3.org/1999/xhtml","attributes":[{"name":"datetime","namespace":null}]},{"name":"title","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"tr","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"u","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"ul","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"var","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"wbr","namespace":"http://www.w3.org/1999/xhtml","attributes":[]},{"name":"a","namespace":"http://www.w3.org/2000/svg","attributes":[{"name":"href","namespace":null},{"name":"hreflang","namespace":null},{"name":"type","namespace":null}]},{"name":"circle","namespace":"http://www.w3.org/2000/svg","attributes":[{"name":"cx","namespace":null},{"name":"cy","namespace":null},{"name":"pathLength","namespace":null},{"name":"r","namespace":null}]},{"name":"defs","namespace":"http://www.w3.org/2000/svg","attributes":[]},{"name":"desc","namespace":"http://www.w3.org/2000/svg","attributes":[]},{"name":"ellipse","namespace":"http://www.w3.org/2000/svg","attributes":[{"name":"cx","namespace":null},{"name":"cy","namespace":null},{"name":"pathLength","namespace":null},{"name":"rx","namespace":null},{"name":"ry","namespace":null}]},{"name":"foreignObject","namespace":"http://www.w3.org/2000/svg","attributes":[{"name":"height","namespace":null},{"name":"width","namespace":null},{"name":"x","namespace":null},{"name":"y","namespace":null}]},{"name":"g","namespace":"http://www.w3.org/2000/svg","attributes":[]},{"name":"line","namespace":"http://www.w3.org/2000/svg","attributes":[{"name":"pathLength","namespace":null},{"name":"x1","namespace":null},{"name":"x2","namespace":null},{"name":"y1","namespace":null},{"name":"y2","namespace":null}]},{"name":"marker","namespace":"http://www.w3.org/2000/svg","attributes":[{"name":"markerHeight","namespace":null},{"name":"markerUnits","namespace":null},{"name":"markerWidth","namespace":null},{"name":"orient","namespace":null},{"name":"preserveAspectRatio","namespace":null},{"name":"refX","namespace":null},{"name":"refY","namespace":null},{"name":"viewBox","namespace":null}]},{"name":"metadata","namespace":"http://www.w3.org/2000/svg","attributes":[]},{"name":"path","namespace":"http://www.w3.org/2000/svg","attributes":[{"name":"d","namespace":null},{"name":"pathLength","namespace":null}]},{"name":"polygon","namespace":"http://www.w3.org/2000/svg","attributes":[{"name":"pathLength","namespace":null},{"name":"points","namespace":null}]},{"name":"polyline","namespace":"http://www.w3.org/2000/svg","attributes":[{"name":"pathLength","namespace":null},{"name":"points","namespace":null}]},{"name":"rect","namespace":"http://www.w3.org/2000/svg","attributes":[{"name":"height","namespace":null},{"name":"pathLength","namespace":null},{"name":"rx","namespace":null},{"name":"ry","namespace":null},{"name":"width","namespace":null},{"name":"x","namespace":null},{"name":"y","namespace":null}]},{"name":"svg","namespace":"http://www.w3.org/2000/svg","attributes":[{"name":"height","namespace":null},{"name":"preserveAspectRatio","namespace":null},{"name":"viewBox","namespace":null},{"name":"width","namespace":null},{"name":"x","namespace":null},{"name":"y","namespace":null}]},{"name":"text","namespace":"http://www.w3.org/2000/svg","attributes":[{"name":"dx","namespace":null},{"name":"dy","namespace":null},{"name":"lengthAdjust","namespace":null},{"name":"rotate","namespace":null},{"name":"textLength","namespace":null},{"name":"x","namespace":null},{"name":"y","namespace":null}]},{"name":"textPath","namespace":"http://www.w3.org/2000/svg","attributes":[{"name":"lengthAdjust","namespace":null},{"name":"method","namespace":null},{"name":"path","namespace":null},{"name":"side","namespace":null},{"name":"spacing","namespace":null},{"name":"startOffset","namespace":null},{"name":"textLength","namespace":null}]},{"name":"title","namespace":"http://www.w3.org/2000/svg","attributes":[]},{"name":"tspan","namespace":"http://www.w3.org/2000/svg","attributes":[{"name":"dx","namespace":null},{"name":"dy","namespace":null},{"name":"lengthAdjust","namespace":null},{"name":"rotate","namespace":null},{"name":"textLength","namespace":null},{"name":"x","namespace":null},{"name":"y","namespace":null}]}],"processingInstructions":[],"attributes":[{"name":"alignment-baseline","namespace":null},{"name":"baseline-shift","namespace":null},{"name":"clip-path","namespace":null},{"name":"clip-rule","namespace":null},{"name":"color","namespace":null},{"name":"color-interpolation","namespace":null},{"name":"cursor","namespace":null},{"name":"dir","namespace":null},{"name":"direction","namespace":null},{"name":"display","namespace":null},{"name":"displaystyle","namespace":null},{"name":"dominant-baseline","namespace":null},{"name":"fill","namespace":null},{"name":"fill-opacity","namespace":null},{"name":"fill-rule","namespace":null},{"name":"font-family","namespace":null},{"name":"font-size","namespace":null},{"name":"font-size-adjust","namespace":null},{"name":"font-stretch","namespace":null},{"name":"font-style","namespace":null},{"name":"font-variant","namespace":null},{"name":"font-weight","namespace":null},{"name":"lang","namespace":null},{"name":"letter-spacing","namespace":null},{"name":"marker-end","namespace":null},{"name":"marker-mid","namespace":null},{"name":"marker-start","namespace":null},{"name":"mathbackground","namespace":null},{"name":"mathcolor","namespace":null},{"name":"mathsize","namespace":null},{"name":"opacity","namespace":null},{"name":"paint-order","namespace":null},{"name":"pointer-events","namespace":null},{"name":"scriptlevel","namespace":null},{"name":"shape-rendering","namespace":null},{"name":"stop-color","namespace":null},{"name":"stop-opacity","namespace":null},{"name":"stroke","namespace":null},{"name":"stroke-dasharray","namespace":null},{"name":"stroke-dashoffset","namespace":null},{"name":"stroke-linecap","namespace":null},{"name":"stroke-linejoin","namespace":null},{"name":"stroke-miterlimit","namespace":null},{"name":"stroke-opacity","namespace":null},{"name":"stroke-width","namespace":null},{"name":"text-anchor","namespace":null},{"name":"text-decoration","namespace":null},{"name":"text-overflow","namespace":null},{"name":"text-rendering","namespace":null},{"name":"title","namespace":null},{"name":"transform","namespace":null},{"name":"transform-origin","namespace":null},{"name":"unicode-bidi","namespace":null},{"name":"vector-effect","namespace":null},{"name":"visibility","namespace":null},{"name":"white-space","namespace":null},{"name":"word-spacing","namespace":null},{"name":"writing-mode","namespace":null}],"comments":false,"dataAttributes":false,"javascriptURLs":false};
  var BASELINE_REMOVE_ELEMENTS = [["base", HTML_NS], ["embed", HTML_NS], ["frame", HTML_NS], ["iframe", HTML_NS], ["object", HTML_NS], ["script", HTML_NS], ["script", SVG_NS], ["use", SVG_NS]].map(function (x) { return { name: x[0], namespace: x[1] }; });
  var NON_REPLACEABLE = [["html", HTML_NS], ["svg", SVG_NS], ["math", MATHML_NS]];
  // built-in navigating URL attributes: [element, element ns, attribute, attribute ns]
  var NAVIGATING = [["a", HTML_NS, "href", null], ["area", HTML_NS, "href", null], ["form", HTML_NS, "action", null], ["button", HTML_NS, "formaction", null], ["input", HTML_NS, "formaction", null], ["a", SVG_NS, "href", null], ["a", SVG_NS, "href", XLINK_NS]];
  var ANIMATING = [["animate", SVG_NS], ["animateTransform", SVG_NS], ["set", SVG_NS]];
  var eventHandlerNames = null;
  function eventHandlers() {
    if (eventHandlerNames) return eventHandlerNames;
    var seen = Object.create(null), out = [];
    [globalThis, typeof Window === "function" && Window.prototype, typeof HTMLElement === "function" && HTMLElement.prototype, typeof SVGElement === "function" && SVGElement.prototype, typeof Element === "function" && Element.prototype, typeof Document === "function" && Document.prototype, typeof HTMLBodyElement === "function" && HTMLBodyElement.prototype, typeof HTMLFrameSetElement === "function" && HTMLFrameSetElement.prototype].forEach(function (o) {
      if (!o) return;
      try { Object.getOwnPropertyNames(o).forEach(function (n) { if (/^on[a-z]+$/.test(n) && !seen[n]) { seen[n] = 1; out.push(n); } }); } catch (e) {}
    });
    out.sort();
    return (eventHandlerNames = out);
  }

  // ---- canonical names and lists
  var same = function (a, b) { return a.name === b.name && a.namespace === b.namespace; };
  var indexIn = function (list, item) { if (!list) return -1; for (var i = 0; i < list.length; i++) if (same(list[i], item)) return i; return -1; };
  var contains = function (list, item) { return indexIn(list, item) >= 0; };
  var removeFrom = function (list, item) { var i = indexIn(list, item); if (i < 0) return false; list.splice(i, 1); return true; };
  var isData = function (a) { return a.namespace === null && /^data-/.test(a.name); };
  function toSequence(v, what) {
    if (v === null || typeof v !== "object" && typeof v !== "function" || typeof v[Symbol.iterator] !== "function") throw new TypeError(what + " is not a sequence");
    return __jb.arrayFrom(v);
  }
  function str(v) { if (typeof v === "symbol") throw new TypeError("Cannot convert a Symbol to a string"); return String(v); }
  // canonicalize a sanitizer name (string or dictionary) with a default namespace
  function canonName(item, defaultNs) {
    if (item !== null && typeof item === "object") {
      if (item.name === undefined) throw new TypeError("Sanitizer name dictionary needs a name");
      var name = str(item.name), ns = item.namespace;
      ns = ns === undefined ? defaultNs : ns === null ? null : str(ns);
      if (ns === "") ns = null;
      return { name: name, namespace: ns };
    }
    return { name: str(item), namespace: defaultNs };
  }
  var canonAttr = function (item) { return canonName(item, null); };
  var canonElement = function (item) { return canonName(item, HTML_NS); };
  function canonElementWithAttributes(item) {
    var r = canonElement(item);
    if (item !== null && typeof item === "object") {
      var attrs = item.attributes, rem = item.removeAttributes;
      if (attrs !== undefined) r.attributes = toSequence(attrs, "attributes").map(canonAttr);
      if (rem !== undefined) r.removeAttributes = toSequence(rem, "removeAttributes").map(canonAttr);
    }
    if (!r.attributes && !r.removeAttributes) r.removeAttributes = [];
    return r;
  }
  function canonPI(item) {
    if (item !== null && typeof item === "object") { if (item.target === undefined) throw new TypeError("processing instruction needs a target"); return { target: str(item.target) }; }
    return { target: str(item) };
  }
  var piIndex = function (list, pi) { if (!list) return -1; for (var i = 0; i < list.length; i++) if (list[i].target === pi.target) return i; return -1; };

  // WebIDL SanitizerConfig conversion (members in lexicographic order) + canonicalization
  function convertConfig(c, permissive) {
    if (c !== undefined && c !== null && typeof c !== "object" && typeof c !== "function") throw new TypeError("SanitizerConfig is not an object");
    c = c || {};
    var raw = {};
    ["attributes", "comments", "dataAttributes", "elements", "javascriptURLs", "processingInstructions", "removeAttributes", "removeElements", "removeProcessingInstructions", "replaceWithChildrenElements"].forEach(function (k) {
      var v = c[k];
      if (v === undefined) return;
      raw[k] = /^(comments|dataAttributes|javascriptURLs)$/.test(k) ? !!v : toSequence(v, k);
    });
    var cfg = {};
    if (raw.elements) cfg.elements = raw.elements.map(canonElementWithAttributes);
    if (raw.removeElements) cfg.removeElements = raw.removeElements.map(canonElement);
    if (!cfg.elements && !cfg.removeElements) cfg.removeElements = [];
    if (raw.replaceWithChildrenElements) cfg.replaceWithChildrenElements = raw.replaceWithChildrenElements.map(canonElement);
    if (raw.processingInstructions) cfg.processingInstructions = raw.processingInstructions.map(canonPI);
    if (raw.removeProcessingInstructions) cfg.removeProcessingInstructions = raw.removeProcessingInstructions.map(canonPI);
    if (!cfg.processingInstructions && !cfg.removeProcessingInstructions) { if (permissive) cfg.removeProcessingInstructions = []; else cfg.processingInstructions = []; }
    if (raw.attributes) cfg.attributes = raw.attributes.map(canonAttr);
    if (raw.removeAttributes) cfg.removeAttributes = raw.removeAttributes.map(canonAttr);
    if (!cfg.attributes && !cfg.removeAttributes) cfg.removeAttributes = [];
    cfg.comments = raw.comments !== undefined ? raw.comments : permissive;
    if (raw.dataAttributes !== undefined) cfg.dataAttributes = raw.dataAttributes;
    else if (cfg.attributes) cfg.dataAttributes = permissive;
    cfg.javascriptURLs = raw.javascriptURLs !== undefined ? raw.javascriptURLs : permissive;
    return cfg;
  }
  function hasDup(list) { if (!list) return false; for (var i = 0; i < list.length; i++) for (var j = i + 1; j < list.length; j++) if (same(list[i], list[j])) return true; return false; }
  function hasDupPI(list) { if (!list) return false; for (var i = 0; i < list.length; i++) for (var j = i + 1; j < list.length; j++) if (list[i].target === list[j].target) return true; return false; }
  function intersects(a, b) { return (a || []).some(function (x) { return contains(b, x); }); }
  function isValid(cfg) {
    if (cfg.elements && cfg.removeElements) return false;
    if (cfg.processingInstructions && cfg.removeProcessingInstructions) return false;
    if (cfg.attributes && cfg.removeAttributes) return false;
    if (cfg.elements ? hasDup(cfg.elements) : hasDup(cfg.removeElements)) return false;
    if (hasDup(cfg.replaceWithChildrenElements)) return false;
    if (cfg.processingInstructions ? hasDupPI(cfg.processingInstructions) : hasDupPI(cfg.removeProcessingInstructions)) return false;
    if (cfg.attributes ? hasDup(cfg.attributes) : hasDup(cfg.removeAttributes)) return false;
    if (cfg.replaceWithChildrenElements) {
      if (cfg.replaceWithChildrenElements.some(nonReplaceable)) return false;
      if (intersects(cfg.elements || cfg.removeElements, cfg.replaceWithChildrenElements)) return false;
    }
    if (cfg.attributes) {
      for (var i = 0; cfg.elements && i < cfg.elements.length; i++) {
        var e = cfg.elements[i];
        if (hasDup(e.attributes) || hasDup(e.removeAttributes)) return false;
        if (intersects(cfg.attributes, e.attributes)) return false;
        if ((e.removeAttributes || []).some(function (a) { return !contains(cfg.attributes, a); })) return false;
        if (cfg.dataAttributes === true && (e.attributes || []).some(isData)) return false;
      }
      if (cfg.dataAttributes === true && cfg.attributes.some(isData)) return false;
    } else {
      for (var k = 0; cfg.elements && k < cfg.elements.length; k++) {
        var el = cfg.elements[k];
        if (el.attributes && el.removeAttributes) return false;
        if (hasDup(el.attributes) || hasDup(el.removeAttributes)) return false;
        if (intersects(cfg.removeAttributes, el.attributes) || intersects(cfg.removeAttributes, el.removeAttributes)) return false;
      }
      if (cfg.dataAttributes !== undefined) return false;
    }
    return true;
  }
  function nonReplaceable(e) { return NON_REPLACEABLE.some(function (x) { return x[0] === e.name && x[1] === e.namespace; }); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function compareItems(a, b) {
    var na = a.namespace, nb = b.namespace;
    if (na === null) { if (nb !== null) return -1; }
    else { if (nb === null) return 1; if (na < nb) return -1; if (na !== nb) return 1; }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  }
  var byTarget = function (a, b) { return a.target < b.target ? -1 : a.target > b.target ? 1 : 0; };

  // ---- configuration modifiers
  function removeElementFrom(cfg, element) {
    element = canonElement(element);
    var modified = removeFrom(cfg.replaceWithChildrenElements, element);
    if (cfg.elements) { if (removeFrom(cfg.elements, element)) return true; return modified; }
    if (contains(cfg.removeElements, element)) return modified;
    cfg.removeElements.push(element);
    return true;
  }
  function removeAttributeFrom(cfg, attribute) {
    attribute = canonAttr(attribute);
    if (cfg.attributes) {
      var modified = removeFrom(cfg.attributes, attribute);
      (cfg.elements || []).forEach(function (e) {
        if (removeFrom(e.attributes, attribute)) modified = true;
        if (removeFrom(e.removeAttributes, attribute)) modified = true;
      });
      return modified;
    }
    if (contains(cfg.removeAttributes, attribute)) return false;
    (cfg.elements || []).forEach(function (e) { removeFrom(e.attributes, attribute); removeFrom(e.removeAttributes, attribute); });
    cfg.removeAttributes.push(attribute);
    return true;
  }
  function removeUnsafeFrom(cfg) {
    var result = false;
    BASELINE_REMOVE_ELEMENTS.forEach(function (e) { if (removeElementFrom(cfg, e)) result = true; });
    eventHandlers().forEach(function (n) { if (removeAttributeFrom(cfg, { name: n, namespace: null })) result = true; });
    if (cfg.javascriptURLs === true) { result = true; cfg.javascriptURLs = false; }
    return result;
  }

  var configs = new WeakMap();
  var cfgOf = function (s) { var c = configs.get(s); if (!c) throw new TypeError("Illegal invocation"); return c; };
  function configure(sanitizer, configuration, permissive) {
    var fresh = convertConfig(configuration, permissive);
    if (!isValid(fresh)) throw new TypeError("Invalid Sanitizer configuration");
    configs.set(sanitizer, fresh);
  }
  class Sanitizer {
    constructor(configuration) {
      if (configuration === undefined || configuration === "default") configuration = clone(DEFAULT_CONFIG);
      else if (typeof configuration === "string") throw new TypeError("Unknown SanitizerPresets value");
      configure(this, configuration, true);
    }
    get() {
      var c = clone(cfgOf(this));
      if (c.elements) {
        c.elements.forEach(function (e) { if (e.attributes) e.attributes.sort(compareItems); if (e.removeAttributes) e.removeAttributes.sort(compareItems); });
        c.elements.sort(compareItems);
      } else c.removeElements.sort(compareItems);
      if (c.replaceWithChildrenElements) c.replaceWithChildrenElements.sort(compareItems);
      if (c.processingInstructions) c.processingInstructions.sort(byTarget); else c.removeProcessingInstructions.sort(byTarget);
      if (c.attributes) c.attributes.sort(compareItems); else c.removeAttributes.sort(compareItems);
      return c;
    }
    allowElement(element) {
      var cfg = cfgOf(this);
      element = canonElementWithAttributes(element);
      if (cfg.elements) {
        var modified = removeFrom(cfg.replaceWithChildrenElements, element);
        if (cfg.attributes) {
          if (element.attributes) {
            element.attributes = dedupe(element.attributes).filter(function (a) { return !contains(cfg.attributes, a); });
            if (cfg.dataAttributes === true) element.attributes = element.attributes.filter(function (a) { return !isData(a); });
          }
          if (element.removeAttributes) element.removeAttributes = dedupe(element.removeAttributes).filter(function (a) { return contains(cfg.attributes, a); });
        } else {
          if (element.attributes) {
            var rem = element.removeAttributes || [];
            element.attributes = dedupe(element.attributes).filter(function (a) { return !contains(rem, a); });
            delete element.removeAttributes;
            element.attributes = element.attributes.filter(function (a) { return !contains(cfg.removeAttributes, a); });
          }
          if (element.removeAttributes) element.removeAttributes = dedupe(element.removeAttributes).filter(function (a) { return !contains(cfg.removeAttributes, a); });
        }
        var i = indexIn(cfg.elements, element);
        if (i < 0) { cfg.elements.push(element); return true; }
        if (JSON.stringify(normEl(element)) === JSON.stringify(normEl(cfg.elements[i]))) return modified;
        cfg.elements.splice(i, 1);
        cfg.elements.push(element);
        return true;
      }
      if (element.attributes || (element.removeAttributes || []).length) return false;
      var mod = removeFrom(cfg.replaceWithChildrenElements, element);
      if (!contains(cfg.removeElements, element)) return mod;
      removeFrom(cfg.removeElements, element);
      return true;
    }
    removeElement(element) { return removeElementFrom(cfgOf(this), element); }
    replaceElementWithChildren(element) {
      var cfg = cfgOf(this);
      element = canonElement(element);
      if (nonReplaceable(element)) return false;
      var modified = removeFrom(cfg.elements, element);
      if (removeFrom(cfg.removeElements, element)) modified = true;
      if (!cfg.replaceWithChildrenElements) cfg.replaceWithChildrenElements = [];
      if (!contains(cfg.replaceWithChildrenElements, element)) { cfg.replaceWithChildrenElements.push(element); return true; }
      return modified;
    }
    allowProcessingInstruction(pi) {
      var cfg = cfgOf(this);
      pi = canonPI(pi);
      if (cfg.processingInstructions) { if (piIndex(cfg.processingInstructions, pi) >= 0) return false; cfg.processingInstructions.push(pi); return true; }
      var i = piIndex(cfg.removeProcessingInstructions, pi);
      if (i >= 0) { cfg.removeProcessingInstructions.splice(i, 1); return true; }
      return false;
    }
    removeProcessingInstruction(pi) {
      var cfg = cfgOf(this);
      pi = canonPI(pi);
      if (cfg.processingInstructions) { var i = piIndex(cfg.processingInstructions, pi); if (i >= 0) { cfg.processingInstructions.splice(i, 1); return true; } return false; }
      if (piIndex(cfg.removeProcessingInstructions, pi) >= 0) return false;
      cfg.removeProcessingInstructions.push(pi);
      return true;
    }
    allowAttribute(attribute) {
      var cfg = cfgOf(this);
      attribute = canonAttr(attribute);
      if (cfg.attributes) {
        if (cfg.dataAttributes === true && isData(attribute)) return false;
        if (contains(cfg.attributes, attribute)) return false;
        (cfg.elements || []).forEach(function (e) { removeFrom(e.attributes, attribute); });
        cfg.attributes.push(attribute);
        return true;
      }
      if (!contains(cfg.removeAttributes, attribute)) return false;
      removeFrom(cfg.removeAttributes, attribute);
      return true;
    }
    removeAttribute(attribute) { return removeAttributeFrom(cfgOf(this), attribute); }
    setComments(allow) { var cfg = cfgOf(this); allow = !!allow; if (cfg.comments === allow) return false; cfg.comments = allow; return true; }
    setDataAttributes(allow) {
      var cfg = cfgOf(this); allow = !!allow;
      if (!cfg.attributes) return false;
      if (cfg.dataAttributes === allow) return false;
      if (allow) {
        (cfg.elements || []).forEach(function (e) { if (e.attributes) e.attributes = e.attributes.filter(function (a) { return !isData(a); }); });
        cfg.attributes = cfg.attributes.filter(function (a) { return !isData(a); });
      }
      cfg.dataAttributes = allow;
      return true;
    }
    setJavascriptURLs(allow) { var cfg = cfgOf(this); allow = !!allow; if (cfg.javascriptURLs === allow) return false; cfg.javascriptURLs = allow; return true; }
    removeUnsafe() { return removeUnsafeFrom(cfgOf(this)); }
  }
  function dedupe(list) { var out = []; list.forEach(function (x) { if (!contains(out, x)) out.push(x); }); return out; }
  function normEl(e) {
    var o = { name: e.name, namespace: e.namespace };
    if (e.attributes) o.attributes = e.attributes.slice().sort(compareItems);
    if (e.removeAttributes) o.removeAttributes = e.removeAttributes.slice().sort(compareItems);
    return o;
  }
  Object.defineProperty(Sanitizer.prototype, Symbol.toStringTag, { value: "Sanitizer", configurable: true });
  Object.defineProperty(globalThis, "Sanitizer", { value: Sanitizer, writable: true, configurable: true, enumerable: false });
  __jb.sanitizerConfigOf = function (s) { return configs.get(s) || null; };

  // get a sanitizer configuration from options (null: no sanitization)
  function sanitizerFrom(options, safe) {
    var input;
    if (options !== undefined && options !== null && typeof options !== "object" && typeof options !== "function") throw new TypeError("options is not an object");
    if (options && typeof __jb.trustedParserOptionsConfig === "function" && __jb.trustedParserOptionsConfig(options) !== undefined) {
      input = __jb.trustedParserOptionsConfig(options);
      if (input === null) return null;
    } else if (options && options.sanitizer !== undefined) input = options.sanitizer;
    else if (!safe) return null;
    else input = "default";
    if (typeof input === "string") {
      if (input !== "default") throw new TypeError("Unknown SanitizerPresets value");
      input = clone(DEFAULT_CONFIG);
    }
    if (input instanceof Sanitizer) return cfgOf(input);
    if (input === null || typeof input !== "object") throw new TypeError("Invalid sanitizer");
    var s = Object.create(Sanitizer.prototype);
    configure(s, input, !safe);
    return cfgOf(s);
  }
  function containsJavascriptURL(value) {
    try { return new URL(value).protocol === "javascript:"; } catch (e) { return false; }
  }
  // inner sanitize steps
  function innerSanitize(node, cfg, only) {
    for (var child = node.firstChild; child;) {
      var next = child.nextSibling;
      if (only && !only.has(child)) { child = next; continue; }
      var t = child.nodeType;
      if (t === 10 || t === 3) { child = next; continue; }
      if (t === 8) { if (cfg.comments !== true) node.removeChild(child); child = next; continue; }
      if (t === 7) {
        var target = { target: child.target };
        if (cfg.processingInstructions) { if (piIndex(cfg.processingInstructions, target) < 0) node.removeChild(child); }
        else if (piIndex(cfg.removeProcessingInstructions, target) >= 0) node.removeChild(child);
        child = next; continue;
      }
      if (t !== 1) { child = next; continue; }
      var elementName = { name: child._local, namespace: child._ns === undefined ? null : child._ns };
      if (contains(cfg.replaceWithChildrenElements, elementName)) {
        innerSanitize(child, cfg);
        var frag = (child.ownerDocument || __jb.currentDocument).createDocumentFragment();
        while (child.firstChild) frag.appendChild(child.firstChild);
        node.replaceChild(frag, child);
        child = next; continue;
      }
      if (cfg.elements) { if (!contains(cfg.elements, elementName)) { node.removeChild(child); child = next; continue; } }
      else if (contains(cfg.removeElements, elementName)) { node.removeChild(child); child = next; continue; }
      if (elementName.name === "template" && elementName.namespace === HTML_NS && child.content) innerSanitize(child.content, cfg);
      if (child._shadowRoot) innerSanitize(child._shadowRoot, cfg);
      var local = {};
      if (cfg.elements) { var li = indexIn(cfg.elements, elementName); if (li >= 0) local = cfg.elements[li]; }
      var attrs = child._attrs.slice();
      for (var ai = 0; ai < attrs.length; ai++) {
        var attr = attrs[ai];
        var attrName = { name: attr._local, namespace: attr._ns === undefined || attr._ns === "" ? null : attr._ns };
        var drop = false;
        if (local.removeAttributes && contains(local.removeAttributes, attrName)) drop = true;
        else if (cfg.attributes) {
          if (!contains(cfg.attributes, attrName) && !contains(local.attributes, attrName) && !(attrName.namespace === null && /^data-/.test(attrName.name) && cfg.dataAttributes === true)) drop = true;
        } else {
          if (local.attributes && !contains(local.attributes, attrName)) drop = true;
          else if (contains(cfg.removeAttributes, attrName)) drop = true;
        }
        if (!drop && cfg.javascriptURLs !== true) {
          var val = attr._value;
          if (NAVIGATING.some(function (n) { return n[0] === elementName.name && n[1] === elementName.namespace && n[2] === attrName.name && n[3] === attrName.namespace; }) && containsJavascriptURL(val)) drop = true;
          else if (elementName.namespace === MATHML_NS && attrName.name === "href" && (attrName.namespace === null || attrName.namespace === XLINK_NS) && containsJavascriptURL(val)) drop = true;
          else if (attrName.namespace === null && attrName.name === "attributeName" && ANIMATING.some(function (n) { return n[0] === elementName.name && n[1] === elementName.namespace; }) && (val === "href" || val === "xlink:href")) drop = true;
        }
        if (drop) child.removeAttributeNode(attr.ownerElement ? attr : child.getAttributeNodeNS(attr._ns, attr._local) || attr);
      }
      innerSanitize(child, cfg);
      child = next;
    }
  }
  function sanitize(node, cfg, safe) {
    if (safe) { cfg = clone(cfg); removeUnsafeFrom(cfg); }
    innerSanitize(node, cfg);
  }
  // Trusted Types parser options (tentative): sanitize just the nodes an HTML sink inserted
  __jb.captureInsertion = function (el, kind) {
    var tgt = el.nodeType === 1 && el._tag === "template" && el._ns === HTML_NS ? el.content : el;
    switch (kind) {
      case "inner": return { parent: tgt, after: null, before: null };
      case "outer": return { parent: el.parentNode, after: el.previousSibling, before: el.nextSibling };
      case "beforebegin": return { parent: el.parentNode, after: el.previousSibling, before: el };
      case "afterbegin": return { parent: tgt, after: null, before: tgt.firstChild };
      case "beforeend": return { parent: tgt, after: tgt.lastChild, before: null };
      case "afterend": return { parent: el.parentNode, after: el, before: el.nextSibling };
    }
    return null;
  };
  __jb.sanitizeInsertion = function (ins, sanitizerInput) {
    if (!ins || !ins.parent) return;
    var cfg = sanitizerFrom({ sanitizer: sanitizerInput }, false);
    if (!cfg) return;
    var only = new Set();
    for (var n = ins.after ? ins.after.nextSibling : ins.parent.firstChild; n && n !== ins.before; n = n.nextSibling) only.add(n);
    innerSanitize(ins.parent, cfg, only);
  };
  __jb.sanitizeFragment = function (frag, sanitizerInput) {
    var cfg = sanitizerFrom({ sanitizer: sanitizerInput }, false);
    if (cfg) innerSanitize(frag, cfg);
  };
  __jb.sanitizeNode = function (node, options, safe) { var cfg = sanitizerFrom(options, safe); if (cfg) sanitize(node, cfg, safe); };
  // Parse markup for `context` (an element) into a fragment, sanitized when safe or given a sanitizer.
  function parse(html, context, options, safe) {
    var cfg = sanitizerFrom(options, safe);
    var runScripts = !safe && !!(options && options.runScripts);
    var frag = __jb.parseFragment(html === null || html === undefined ? "" : String(html), context, { unsafe: true, runScripts: runScripts });
    if (cfg) sanitize(frag, cfg, safe);
    return frag;
  }

  function contextOf(node) {
    if (node.nodeType === 1) return node;
    if (node.nodeType === 11) {
      if (node._host) return node._host;           // shadow root
      if (node._templateHost) return node._templateHost; // template contents
      var t = __jb.templateOfContent ? __jb.templateOfContent(node) : null;
      if (t) return t;
    }
    return null;
  }
  function parentContext(node) {
    var p = node.parentNode;
    if (!p) return null;
    if (p.nodeType === 9) throw dom("HierarchyRequestError", "The parent is a document");
    if (p.nodeType === 11 && !p._host && !isTemplateContent(p)) throw dom("HierarchyRequestError", "The parent is a document fragment");
    return contextOf(p);
  }
  function isTemplateContent(f) { return !!(f._templateHost || (__jb.templateOfContent && __jb.templateOfContent(f))); }
  // For a <template>, ParentNode methods target its content.
  function targetOf(node) { return node.nodeType === 1 && node._tag === "template" && node._ns === HTML_NS ? node.content : node; }

  function define(proto, name, fn) { Object.defineProperty(proto, name, { value: fn, writable: true, enumerable: true, configurable: true }); }
  [["", true], ["Unsafe", false]].forEach(function (v) {
    var suffix = v[0], safe = v[1];
    var parentProtos = [Element.prototype, ShadowRoot.prototype, DocumentFragment.prototype];
    parentProtos.forEach(function (proto) {
      define(proto, "appendHTML" + suffix, function (html, options) {
        var target = targetOf(this), ctx = contextOf(this.nodeType === 11 ? this : target === this ? this : this);
        var frag = parse(html, ctx || __jb.currentDocument.body || __jb.currentDocument.documentElement, options, safe);
        target.append(frag);
      });
      define(proto, "prependHTML" + suffix, function (html, options) {
        var target = targetOf(this), ctx = contextOf(this);
        var frag = parse(html, ctx || __jb.currentDocument.body || __jb.currentDocument.documentElement, options, safe);
        target.prepend(frag);
      });
    });
    [Element.prototype, CharacterData.prototype, DocumentType.prototype].forEach(function (proto) {
      define(proto, "beforeHTML" + suffix, function (html, options) {
        var ctx = parentContext(this);
        if (!this.parentNode) return;
        var frag = parse(html, ctx, options, safe);
        this.before(frag);
      });
      define(proto, "afterHTML" + suffix, function (html, options) {
        var ctx = parentContext(this);
        if (!this.parentNode) return;
        var frag = parse(html, ctx, options, safe);
        this.after(frag);
      });
      define(proto, "replaceWithHTML" + suffix, function (html, options) {
        var ctx = parentContext(this);
        if (!this.parentNode) return;
        var frag = parse(html, ctx, options, safe);
        this.replaceWith(frag);
      });
    });
  });

  // set and filter HTML: Element / ShadowRoot setHTML (safe) and setHTMLUnsafe
  var isScriptContext = function (el) { return el && el.nodeType === 1 && el._local === "script" && (el._ns === HTML_NS || el._ns === SVG_NS); };
  function setAndFilter(target, context, html, options, safe) {
    var cfg = sanitizerFrom(options, safe);
    if (safe && isScriptContext(context)) { __jb.replaceAll(target, (context.ownerDocument || __jb.currentDocument).createDocumentFragment()); return; }
    var tpoRun = typeof __jb.trustedParserOptionsRunScripts === "function" ? __jb.trustedParserOptionsRunScripts(options) : undefined;
    var runScripts = !safe && (tpoRun !== undefined ? tpoRun : !!(options && options.runScripts));
    var frag = __jb.parseFragment(html === null || html === undefined ? "" : String(html), context, { unsafe: true, runScripts: runScripts });
    if (cfg) sanitize(frag, cfg, safe);
    __jb.replaceAll(target, frag);
    __jb.markDirty && __jb.markDirty(context);
  }
  define(Element.prototype, "setHTML", function (html, options) { setAndFilter(targetOf(this), this, html, options, true); });
  define(ShadowRoot.prototype, "setHTML", function (html, options) { setAndFilter(this, this._host, html, options, true); });
  define(Element.prototype, "setHTMLUnsafe", function setHTMLUnsafe(html, options) { setAndFilter(targetOf(this), this, html, options, false); });
  define(ShadowRoot.prototype, "setHTMLUnsafe", function setHTMLUnsafe(html, options) { setAndFilter(this, this._host, html, options, false); });
  if (typeof Document === "function") {
    Document.parseHTML = function parseHTML(html, options) {
      if (arguments.length < 1) throw new TypeError("parseHTML: 1 argument required");
      var cfg = sanitizerFrom(options, true);
      var doc = __jb.parseHTMLDocument(String(html), true);
      sanitize(doc, cfg, true);
      return doc;
    };
    Document.parseHTMLUnsafe = function parseHTMLUnsafe(html, options) {
      if (arguments.length < 1) throw new TypeError("parseHTMLUnsafe: 1 argument required");
      var cfg = sanitizerFrom(options, false);
      var doc = __jb.parseHTMLDocument(String(html), true);
      if (cfg) sanitize(doc, cfg, false);
      return doc;
    };
  }
})();

// document.setSequentialFocusStartingPoint(node) (tentative): where sequential focus navigation starts.
if (typeof Document === "function" && !Document.prototype.setSequentialFocusStartingPoint) {
  Object.defineProperty(Document.prototype, "setSequentialFocusStartingPoint", {
    value: function setSequentialFocusStartingPoint(node) {
      if (node !== null && node !== undefined && !(node instanceof Node)) throw new TypeError("setSequentialFocusStartingPoint: argument is not a Node");
      this._focusStartingPoint = node || null;
      if (node && this._jbActive && this._jbActive !== node && typeof this._jbActive.blur === "function" && !this._jbActive.contains(node)) { /* the focused element stays; navigation starts at node */ }
    },
    writable: true, enumerable: true, configurable: true,
  });
}
