// Part 4b: spec-driven reflection of content attributes as IDL attributes
// (HTML Standard "reflecting content attributes in IDL attributes"). The table
// mirrors the HTML element definitions: type, defaults, enumerated keywords.
__jb.REFLECT = {"picture":{},"img":{"alt":{"type":"string"},"src":{"type":"url"},"srcset":{"type":"string"},"crossOrigin":{"type":"enum","defaultVal":null,"invalidVal":"anonymous","keywords":["anonymous","use-credentials"],"nonCanon":{"":"anonymous"},"isNullable":true},"useMap":{"type":"string"},"isMap":{"type":"boolean"},"width":{"type":"unsigned long","customGetter":true},"height":{"type":"unsigned long","customGetter":true},"referrerPolicy":{"type":"enum","keywords":["","no-referrer","no-referrer-when-downgrade","same-origin","origin","strict-origin","origin-when-cross-origin","strict-origin-when-cross-origin","unsafe-url"]},"decoding":{"type":"enum","defaultVal":"auto","invalidVal":"auto","keywords":["async","sync","auto"]},"name":{"type":"string"},"lowsrc":{"type":"url"},"align":{"type":"string"},"hspace":{"type":"unsigned long"},"vspace":{"type":"unsigned long"},"longDesc":{"type":"url"},"border":{"type":"string","treatNullAsEmptyString":true}},"iframe":{"src":{"type":"url"},"srcdoc":{"type":"string"},"name":{"type":"string"},"sandbox":{"type":"settable tokenlist"},"allowFullscreen":{"type":"boolean"},"width":{"type":"string"},"height":{"type":"string"},"referrerPolicy":{"type":"enum","keywords":["","no-referrer","no-referrer-when-downgrade","same-origin","origin","strict-origin","origin-when-cross-origin","strict-origin-when-cross-origin","unsafe-url"]},"align":{"type":"string"},"scrolling":{"type":"string"},"frameBorder":{"type":"string"},"longDesc":{"type":"url"},"marginHeight":{"type":"string","treatNullAsEmptyString":true},"marginWidth":{"type":"string","treatNullAsEmptyString":true}},"embed":{"src":{"type":"url"},"type":{"type":"string"},"width":{"type":"string"},"height":{"type":"string"},"align":{"type":"string"},"name":{"type":"string"}},"object":{"data":{"type":"url"},"type":{"type":"string"},"name":{"type":"string"},"useMap":{"type":"string"},"width":{"type":"string"},"height":{"type":"string"},"align":{"type":"string"},"archive":{"type":"string"},"code":{"type":"string"},"declare":{"type":"boolean"},"hspace":{"type":"unsigned long"},"standby":{"type":"string"},"vspace":{"type":"unsigned long"},"codeBase":{"type":"url"},"codeType":{"type":"string"},"border":{"type":"string","treatNullAsEmptyString":true}},"param":{"name":{"type":"string"},"value":{"type":"string"},"type":{"type":"string"},"valueType":{"type":"string"}},"video":{"src":{"type":"url"},"crossOrigin":{"type":"enum","defaultVal":null,"invalidVal":"anonymous","keywords":["anonymous","use-credentials"],"nonCanon":{"":"anonymous"},"isNullable":true},"preload":{"type":"enum","defaultVal":"none","keywords":["none","metadata","auto"],"nonCanon":{"":"auto"}},"autoplay":{"type":"boolean"},"loop":{"type":"boolean"},"controls":{"type":"boolean"},"controlsList":{"type":"tokenlist","domAttrName":"controlsList"},"defaultMuted":{"type":"boolean","domAttrName":"muted"},"loading":{"type":"enum","defaultVal":"eager","invalidVal":"eager","keywords":["lazy","eager"]},"width":{"type":"unsigned long"},"height":{"type":"unsigned long"},"poster":{"type":"url"},"playsInline":{"type":"boolean"}},"audio":{"src":{"type":"url"},"crossOrigin":{"type":"enum","defaultVal":null,"invalidVal":"anonymous","keywords":["anonymous","use-credentials"],"nonCanon":{"":"anonymous"},"isNullable":true},"preload":{"type":"enum","defaultVal":"none","keywords":["none","metadata","auto"],"nonCanon":{"":"auto"}},"autoplay":{"type":"boolean"},"loop":{"type":"boolean"},"controls":{"type":"boolean"},"defaultMuted":{"type":"boolean","domAttrName":"muted"},"loading":{"type":"enum","defaultVal":"eager","invalidVal":"eager","keywords":["lazy","eager"]}},"source":{"src":{"type":"url"},"type":{"type":"string"},"srcset":{"type":"string"},"sizes":{"type":"string"},"media":{"type":"string"}},"track":{"kind":{"type":"enum","defaultVal":"subtitles","invalidVal":"metadata","keywords":["subtitles","captions","descriptions","chapters","metadata"]},"src":{"type":"url"},"srclang":{"type":"string"},"label":{"type":"string"},"default":{"type":"boolean"}},"canvas":{"width":{"type":"unsigned long","defaultVal":300},"height":{"type":"unsigned long","defaultVal":150}},"map":{"name":{"type":"string"}},"area":{"alt":{"type":"string"},"coords":{"type":"string"},"shape":{"type":"string"},"target":{"type":"string"},"download":{"type":"string"},"ping":{"type":"string"},"rel":{"type":"string"},"relList":{"type":"tokenlist","domAttrName":"rel"},"referrerPolicy":{"type":"enum","keywords":["","no-referrer","no-referrer-when-downgrade","same-origin","origin","strict-origin","origin-when-cross-origin","strict-origin-when-cross-origin","unsafe-url"]},"hreflang":{"type":"string"},"type":{"type":"string"},"href":{"type":"url"},"noHref":{"type":"boolean"}},"form":{"acceptCharset":{"type":"string","domAttrName":"accept-charset"},"action":{"type":"url"},"autocomplete":{"type":"enum","defaultVal":"on","keywords":["on","off"]},"enctype":{"type":"enum","defaultVal":"application/x-www-form-urlencoded","keywords":["application/x-www-form-urlencoded","multipart/form-data","text/plain"]},"encoding":{"type":"enum","defaultVal":"application/x-www-form-urlencoded","keywords":["application/x-www-form-urlencoded","multipart/form-data","text/plain"],"domAttrName":"enctype"},"method":{"type":"enum","defaultVal":"get","keywords":["get","post","dialog"]},"name":{"type":"string"},"noValidate":{"type":"boolean"},"target":{"type":"string"}},"fieldset":{"disabled":{"type":"boolean"},"name":{"type":"string"}},"legend":{"align":{"type":"string"}},"label":{"htmlFor":{"type":"string","domAttrName":"for"}},"input":{"accept":{"type":"string"},"alpha":{"type":"boolean"},"colorSpace":{"type":"enum","domAttrName":"colorspace","keywords":["limited-srgb","display-p3"],"defaultVal":"limited-srgb","invalidVal":"limited-srgb"},"alt":{"type":"string"},"autocomplete":{"type":"string","customGetter":true},"defaultChecked":{"type":"boolean","domAttrName":"checked"},"dirName":{"type":"string"},"disabled":{"type":"boolean"},"formAction":{"type":"url"},"formEnctype":{"type":"enum","invalidVal":"application/x-www-form-urlencoded","keywords":["application/x-www-form-urlencoded","multipart/form-data","text/plain"]},"formMethod":{"type":"enum","invalidVal":"get","keywords":["get","post"]},"formNoValidate":{"type":"boolean"},"formTarget":{"type":"string"},"height":{"type":"unsigned long","customGetter":true},"max":{"type":"string"},"maxLength":{"type":"limited long"},"min":{"type":"string"},"minLength":{"type":"limited long"},"multiple":{"type":"boolean"},"name":{"type":"string"},"pattern":{"type":"string"},"placeholder":{"type":"string"},"readOnly":{"type":"boolean"},"required":{"type":"boolean"},"size":{"type":"limited unsigned long","defaultVal":20},"src":{"type":"url"},"step":{"type":"string"},"type":{"type":"enum","keywords":["hidden","text","search","tel","url","email","password","date","month","week","time","datetime-local","number","range","color","checkbox","radio","file","submit","image","reset","button"],"defaultVal":"text"},"width":{"type":"unsigned long","customGetter":true},"defaultValue":{"type":"string","domAttrName":"value"},"align":{"type":"string"},"useMap":{"type":"string"}},"button":{"disabled":{"type":"boolean"},"formAction":{"type":"url"},"formEnctype":{"type":"enum","invalidVal":"application/x-www-form-urlencoded","keywords":["application/x-www-form-urlencoded","multipart/form-data","text/plain"]},"formMethod":{"type":"enum","invalidVal":"get","keywords":["get","post","dialog"]},"formNoValidate":{"type":"boolean"},"formTarget":{"type":"string"},"name":{"type":"string"},"type":{"type":"enum","defaultVal":"submit","keywords":["submit","reset","button"],"customGetter":true},"value":{"type":"string"}},"select":{"autocomplete":{"type":"string","customGetter":true},"disabled":{"type":"boolean"},"multiple":{"type":"boolean"},"name":{"type":"string"},"required":{"type":"boolean"},"size":{"type":"unsigned long","defaultVal":0}},"datalist":{},"optgroup":{"disabled":{"type":"boolean"},"label":{"type":"string"}},"option":{"disabled":{"type":"boolean"},"label":{"type":"string","customGetter":true},"defaultSelected":{"type":"boolean","domAttrName":"selected"},"value":{"type":"string","customGetter":true}},"textarea":{"autocomplete":{"type":"string","customGetter":true},"cols":{"type":"limited unsigned long with fallback","defaultVal":20},"dirName":{"type":"string"},"disabled":{"type":"boolean"},"maxLength":{"type":"limited long"},"minLength":{"type":"limited long"},"name":{"type":"string"},"placeholder":{"type":"string"},"readOnly":{"type":"boolean"},"required":{"type":"boolean"},"rows":{"type":"limited unsigned long with fallback","defaultVal":2},"wrap":{"type":"string"}},"output":{"htmlFor":{"type":"settable tokenlist","domAttrName":"for"},"name":{"type":"string"}},"progress":{"max":{"type":"limited double","defaultVal":1}},"meter":{"value":{"type":"double","customGetter":true},"min":{"type":"double","customGetter":true},"max":{"type":"double","customGetter":true},"low":{"type":"double","customGetter":true},"high":{"type":"double","customGetter":true},"optimum":{"type":"double","customGetter":true}},"p":{"align":{"type":"string"}},"hr":{"align":{"type":"string"},"color":{"type":"string"},"noShade":{"type":"boolean"},"size":{"type":"string"},"width":{"type":"string"}},"pre":{"width":{"type":"long"}},"blockquote":{"cite":{"type":"url"}},"ol":{"reversed":{"type":"boolean"},"start":{"type":"long","defaultVal":1},"type":{"type":"string"},"compact":{"type":"boolean"}},"ul":{"compact":{"type":"boolean"},"type":{"type":"string"}},"li":{"value":{"type":"long"},"type":{"type":"string"}},"dl":{"compact":{"type":"boolean"}},"dt":{},"dd":{},"figure":{},"figcaption":{},"main":{},"div":{"align":{"type":"string"}},"head":{},"title":{},"base":{"href":{"type":"url","customGetter":true},"target":{"type":"string"}},"link":{"href":{"type":"url"},"crossOrigin":{"type":"enum","defaultVal":null,"invalidVal":"anonymous","keywords":["anonymous","use-credentials"],"nonCanon":{"":"anonymous"},"isNullable":true},"rel":{"type":"string"},"as":{"type":"enum","defaultVal":"","invalidVal":"","keywords":["fetch","audio","document","embed","font","image","manifest","object","report","script","sharedworker","style","track","video","worker","xslt"]},"relList":{"type":"tokenlist","domAttrName":"rel"},"media":{"type":"string"},"integrity":{"type":"string"},"hreflang":{"type":"string"},"type":{"type":"string"},"sizes":{"type":"settable tokenlist"},"referrerPolicy":{"type":"enum","keywords":["","no-referrer","no-referrer-when-downgrade","same-origin","origin","strict-origin","origin-when-cross-origin","strict-origin-when-cross-origin","unsafe-url"]},"charset":{"type":"string"},"rev":{"type":"string"},"target":{"type":"string"}},"meta":{"name":{"type":"string"},"httpEquiv":{"type":"string","domAttrName":"http-equiv"},"content":{"type":"string"},"media":{"type":"string"},"scheme":{"type":"string"}},"style":{"media":{"type":"string"},"type":{"type":"string"}},"html":{"version":{"type":"string"}},"script":{"src":{"type":"url"},"type":{"type":"string"},"noModule":{"type":"boolean"},"charset":{"type":"string"},"defer":{"type":"boolean"},"crossOrigin":{"type":"enum","defaultVal":null,"invalidVal":"anonymous","keywords":["anonymous","use-credentials"],"nonCanon":{"":"anonymous"},"isNullable":true},"integrity":{"type":"string"},"event":{"type":"string"},"htmlFor":{"type":"string","domAttrName":"for"}},"noscript":{},"template":{},"slot":{"name":{"type":"string"}},"ins":{"cite":{"type":"url"},"dateTime":{"type":"string"}},"del":{"cite":{"type":"url"},"dateTime":{"type":"string"}},"details":{"open":{"type":"boolean"}},"summary":{},"menu":{"compact":{"type":"boolean"}},"dialog":{"open":{"type":"boolean"}},"undefinedelement":{"enterKeyHint":{"type":"enum","keywords":["enter","done","go","next","previous","search","send"]},"inputMode":{"type":"enum","keywords":["none","text","tel","url","email","numeric","decimal","search"]}},"marquee":{"behavior":{"type":"enum","defaultVal":"scroll","keywords":["scroll","slide","alternate"]},"bgColor":{"type":"string"},"direction":{"type":"enum","defaultVal":"left","keywords":["up","right","down","left"]},"height":{"type":"string"},"hspace":{"type":"unsigned long"},"scrollAmount":{"type":"unsigned long","defaultVal":6},"scrollDelay":{"type":"unsigned long","defaultVal":85},"trueSpeed":{"type":"boolean"},"vspace":{"type":"unsigned long"},"width":{"type":"string"}},"frameset":{"cols":{"type":"string"},"rows":{"type":"string"}},"frame":{"name":{"type":"string"},"scrolling":{"type":"string"},"src":{"type":"url"},"frameBorder":{"type":"string"},"longDesc":{"type":"url"},"noResize":{"type":"boolean"},"marginHeight":{"type":"string","treatNullAsEmptyString":true},"marginWidth":{"type":"string","treatNullAsEmptyString":true}},"dir":{"compact":{"type":"boolean"}},"font":{"color":{"type":"string","treatNullAsEmptyString":true},"face":{"type":"string"},"size":{"type":"string"}},"body":{"text":{"type":"string","treatNullAsEmptyString":true},"link":{"type":"string","treatNullAsEmptyString":true},"vLink":{"type":"string","treatNullAsEmptyString":true},"aLink":{"type":"string","treatNullAsEmptyString":true},"bgColor":{"type":"string","treatNullAsEmptyString":true},"background":{"type":"string"}},"article":{},"section":{},"nav":{},"aside":{},"h1":{"align":{"type":"string"}},"h2":{"align":{"type":"string"}},"h3":{"align":{"type":"string"}},"h4":{"align":{"type":"string"}},"h5":{"align":{"type":"string"}},"h6":{"align":{"type":"string"}},"hgroup":{},"header":{},"footer":{},"address":{},"table":{"align":{"type":"string"},"border":{"type":"string"},"frame":{"type":"string"},"rules":{"type":"string"},"summary":{"type":"string"},"width":{"type":"string"},"bgColor":{"type":"string","treatNullAsEmptyString":true},"cellPadding":{"type":"string","treatNullAsEmptyString":true},"cellSpacing":{"type":"string","treatNullAsEmptyString":true}},"caption":{"align":{"type":"string"}},"colgroup":{"span":{"type":"clamped unsigned long","defaultVal":1,"min":1,"max":1000},"align":{"type":"string"},"ch":{"type":"string","domAttrName":"char"},"chOff":{"type":"string","domAttrName":"charoff"},"vAlign":{"type":"string"},"width":{"type":"string"}},"col":{"span":{"type":"clamped unsigned long","defaultVal":1,"min":1,"max":1000},"align":{"type":"string"},"ch":{"type":"string","domAttrName":"char"},"chOff":{"type":"string","domAttrName":"charoff"},"vAlign":{"type":"string"},"width":{"type":"string"}},"tbody":{"align":{"type":"string"},"ch":{"type":"string","domAttrName":"char"},"chOff":{"type":"string","domAttrName":"charoff"},"vAlign":{"type":"string"}},"thead":{"align":{"type":"string"},"ch":{"type":"string","domAttrName":"char"},"chOff":{"type":"string","domAttrName":"charoff"},"vAlign":{"type":"string"}},"tfoot":{"align":{"type":"string"},"ch":{"type":"string","domAttrName":"char"},"chOff":{"type":"string","domAttrName":"charoff"},"vAlign":{"type":"string"}},"tr":{"align":{"type":"string"},"ch":{"type":"string","domAttrName":"char"},"chOff":{"type":"string","domAttrName":"charoff"},"vAlign":{"type":"string"},"bgColor":{"type":"string","treatNullAsEmptyString":true}},"td":{"colSpan":{"type":"clamped unsigned long","defaultVal":1,"min":1,"max":1000},"rowSpan":{"type":"clamped unsigned long","defaultVal":1,"min":0,"max":65534},"headers":{"type":"string"},"scope":{"type":"enum","keywords":["row","col","rowgroup","colgroup"]},"abbr":{"type":"string"},"align":{"type":"string"},"axis":{"type":"string"},"height":{"type":"string"},"width":{"type":"string"},"ch":{"type":"string","domAttrName":"char"},"chOff":{"type":"string","domAttrName":"charoff"},"noWrap":{"type":"boolean"},"vAlign":{"type":"string"},"bgColor":{"type":"string","treatNullAsEmptyString":true}},"th":{"colSpan":{"type":"clamped unsigned long","defaultVal":1,"min":1,"max":1000},"rowSpan":{"type":"clamped unsigned long","defaultVal":1,"min":0,"max":65534},"headers":{"type":"string"},"scope":{"type":"enum","keywords":["row","col","rowgroup","colgroup"]},"abbr":{"type":"string"},"align":{"type":"string"},"axis":{"type":"string"},"height":{"type":"string"},"width":{"type":"string"},"ch":{"type":"string","domAttrName":"char"},"chOff":{"type":"string","domAttrName":"charoff"},"noWrap":{"type":"boolean"},"vAlign":{"type":"string"},"bgColor":{"type":"string","treatNullAsEmptyString":true}},"a":{"target":{"type":"string"},"download":{"type":"string"},"ping":{"type":"string"},"rel":{"type":"string"},"relList":{"type":"tokenlist","domAttrName":"rel"},"hreflang":{"type":"string"},"type":{"type":"string"},"referrerPolicy":{"type":"enum","keywords":["","no-referrer","no-referrer-when-downgrade","same-origin","origin","strict-origin","origin-when-cross-origin","strict-origin-when-cross-origin","unsafe-url"]},"href":{"type":"url"},"coords":{"type":"string"},"charset":{"type":"string"},"name":{"type":"string"},"rev":{"type":"string"},"shape":{"type":"string"}},"em":{},"strong":{},"small":{},"s":{},"cite":{},"q":{"cite":{"type":"url"}},"dfn":{},"abbr":{},"ruby":{},"rt":{},"rp":{},"data":{"value":{"type":"string"}},"time":{"dateTime":{"type":"string"}},"code":{},"var":{},"samp":{},"kbd":{},"sub":{},"sup":{},"i":{},"b":{},"u":{},"mark":{},"bdi":{},"bdo":{},"span":{},"br":{"clear":{"type":"string"}},"wbr":{}};
__jb.REFLECT_GLOBAL = { headingOffset: { type: "clamped unsigned long", domAttrName: "headingoffset", min: 0, max: 8, defaultVal: 0 }, headingReset: { type: "boolean", domAttrName: "headingreset" }, title: { type: "string" }, lang: { type: "string" }, dir: { type: "enum", keywords: ["ltr", "rtl", "auto"] }, className: { type: "string", domAttrName: "class" }, hidden: { type: "boolean" }, inert: { type: "boolean" }, accessKey: { type: "string" }, autofocus: { type: "boolean" }, inputMode: { type: "enum", keywords: ["none", "text", "tel", "url", "email", "numeric", "decimal", "search"] }, enterKeyHint: { type: "enum", keywords: ["enter", "done", "go", "next", "previous", "search", "send"] }, autocapitalize: { type: "enum", keywords: ["", "off", "none", "on", "sentences", "words", "characters"], nonCanon: { off: "none", on: "sentences" } } };
__jb.MAX_INT = 2147483647; __jb.MIN_INT = -2147483648;
// HTML "rules for parsing integers": returns null on error.
__jb.parseHtmlInt = function (input) {
  input = String(input);
  var i = 0, n = input.length, sign = 1;
  while (i < n && /[\t\n\f\r ]/.test(input.charAt(i))) i++;
  if (i >= n) return null;
  if (input.charAt(i) === "-") { sign = -1; i++; } else if (input.charAt(i) === "+") i++;
  if (i >= n || !/[0-9]/.test(input.charAt(i))) return null;
  var start = i;
  while (i < n && /[0-9]/.test(input.charAt(i))) i++;
  var v = sign * parseInt(input.slice(start, i), 10);
  return v === 0 ? 0 : v;
};
__jb.parseHtmlNonneg = function (input) { var v = __jb.parseHtmlInt(input); return v === null || v < 0 ? null : v; };
// HTML "rules for parsing floating-point number values".
__jb.parseHtmlFloat = function (input) {
  input = String(input);
  var m = /^[\t\n\f\r ]*([-+]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?)/.exec(input);
  if (!m) return null;
  var v = parseFloat(m[1]);
  if (!isFinite(v)) return null;
  return v;
};
__jb.toInt32 = function (v) { v = Number(v); if (!isFinite(v)) return 0; return v | 0; };
__jb.toUint32 = function (v) { v = Number(v); if (!isFinite(v)) return 0; return v >>> 0; };
__jb.toDouble = function (v) { v = Number(v); if (!isFinite(v)) throw new TypeError("The provided value is non-finite"); return v; };
// DOMTokenList "supported tokens" of the token-list attributes that define them.
__jb.SUPPORTED_TOKENS = (function () {
  var linkRel = ["alternate", "dns-prefetch", "expect", "icon", "manifest", "modulepreload", "next", "pingback", "preconnect", "prefetch", "preload", "search", "stylesheet"];
  var navRel = ["noreferrer", "noopener", "opener"];
  var sandbox = ["allow-downloads", "allow-forms", "allow-modals", "allow-orientation-lock", "allow-pointer-lock", "allow-popups", "allow-popups-to-escape-sandbox", "allow-presentation", "allow-same-origin", "allow-scripts", "allow-storage-access-by-user-activation", "allow-top-navigation", "allow-top-navigation-by-user-activation", "allow-top-navigation-to-custom-protocols"];
  return { "link.rel": linkRel, "a.rel": navRel, "area.rel": navRel, "form.rel": navRel, "iframe.sandbox": sandbox };
})();
// The attribute methods as the environment finished defining them (98_native.js captures them,
// after the Trusted Types wrappers): reflected getters/setters must not go through a page's
// override. Osano's consent script replaces Element.prototype.getAttribute and the script
// `type`/`src` getters with wrappers that read `this.type` -> infinite recursion before.
__jb.attrGet = function (el, name) { var f = __jb.nativeAttr ? __jb.nativeAttr.get : Element.prototype.getAttribute; return f.call(el, name); };
__jb.reflectGet = function (el, attr, spec) {
  var raw = __jb.attrGet(el, attr);
  switch (spec.type) {
    case "string": return raw === null ? "" : raw;
    case "url": {
      if (raw === null) return "";
      var isAction = attr === "action" || attr === "formaction";
      if (isAction && raw === "") return el.ownerDocument.URL;
      var u = __jb.tryURL(raw, el);
      return u ? u.href : raw;
    }
    case "boolean": return raw !== null;
    case "enum": {
      var missing = raw === null;
      var def = spec.defaultVal === undefined ? "" : spec.defaultVal;
      var inv = spec.invalidVal === undefined ? def : spec.invalidVal;
      if (missing) return def;
      var lower = raw.toLowerCase();
      var found = null;
      for (var i = 0; i < spec.keywords.length; i++) if (spec.keywords[i].toLowerCase() === lower) { found = spec.keywords[i]; break; }
      var v = found === null ? inv : found;
      if (spec.nonCanon && v !== null && spec.nonCanon[v] !== undefined) v = spec.nonCanon[v];
      return v;
    }
    case "long": { var l = __jb.parseHtmlInt(raw === null ? "" : raw); if (l === null || l > __jb.MAX_INT || l < __jb.MIN_INT) return spec.defaultVal === undefined || spec.defaultVal === null ? 0 : spec.defaultVal; return l; }
    case "limited long": { var ll = __jb.parseHtmlNonneg(raw === null ? "" : raw); if (ll === null || ll > __jb.MAX_INT) return spec.defaultVal === undefined ? -1 : spec.defaultVal; return ll; }
    case "unsigned long": { var ul = __jb.parseHtmlNonneg(raw === null ? "" : raw); if (ul === null || ul > __jb.MAX_INT) return spec.defaultVal === undefined ? 0 : spec.defaultVal; return ul; }
    case "limited unsigned long": case "limited unsigned long with fallback": { var lu = __jb.parseHtmlNonneg(raw === null ? "" : raw); if (lu === null || lu < 1 || lu > __jb.MAX_INT) return spec.defaultVal === undefined ? 1 : spec.defaultVal; return lu; }
    case "clamped unsigned long": { var cu = __jb.parseHtmlNonneg(raw === null ? "" : raw); if (cu === null) return spec.defaultVal; if (cu < spec.min) return spec.min; if (cu > spec.max) return spec.max; return cu; }
    case "double": { var d = __jb.parseHtmlFloat(raw === null ? "" : raw); return d === null ? (spec.defaultVal === undefined ? 0 : spec.defaultVal) : d; }
    case "limited double": { var ld = __jb.parseHtmlFloat(raw === null ? "" : raw); return ld === null || ld <= 0 ? (spec.defaultVal === undefined ? 0 : spec.defaultVal) : ld; }
    case "tokenlist": case "settable tokenlist": { var key = "_tl_" + attr; if (!Object.prototype.hasOwnProperty.call(el, key)) Object.defineProperty(el, key, { value: __jb.tokenListProxy(new DOMTokenList(el, attr, __jb.SUPPORTED_TOKENS[el._tag + "." + attr] || null)), enumerable: false }); return el[key]; }
  }
  return raw === null ? "" : raw;
};
// Reflected IDL setters run the attribute algorithms directly: a page that overrides
// setAttribute on one element and calls the IDL setter from it must not recurse
// (secureprivacy.ai consent script: element.setAttribute = (n, v) => element[n] = v).
__jb.protoSetAttr = function (el, name, value) { return (__jb.nativeAttr ? __jb.nativeAttr.set : Element.prototype.setAttribute).call(el, name, value); };
__jb.protoRemoveAttr = function (el, name) { return (__jb.nativeAttr ? __jb.nativeAttr.remove : Element.prototype.removeAttribute).call(el, name); };
__jb.reflectSet = function (el, attr, spec, v) {
  switch (spec.type) {
    case "string": case "url": case "tokenlist": case "settable tokenlist": __jb.protoSetAttr(el, attr, v === null && spec.treatNullAsEmptyString ? "" : String(v)); return;
    case "boolean": el.toggleAttribute(attr, !!v); return;
    case "enum": if ((v === null || v === undefined) && spec.isNullable) { __jb.protoRemoveAttr(el, attr); return; } __jb.protoSetAttr(el, attr, String(v)); return;
    case "long": __jb.protoSetAttr(el, attr, String(__jb.toInt32(v))); return;
    case "limited long": { var l = __jb.toInt32(v); if (l < 0) throw __jb.domError("IndexSizeError", "The value provided (" + l + ") is negative."); __jb.protoSetAttr(el, attr, String(l)); return; }
    case "unsigned long": { var u = __jb.toUint32(v); if (u > __jb.MAX_INT) u = spec.defaultVal === undefined ? 0 : spec.defaultVal; __jb.protoSetAttr(el, attr, String(u)); return; }
    case "limited unsigned long": { var lu = __jb.toUint32(v); if (lu === 0) throw __jb.domError("IndexSizeError", "The value provided (0) is not valid."); if (lu > __jb.MAX_INT) lu = spec.defaultVal === undefined ? 1 : spec.defaultVal; __jb.protoSetAttr(el, attr, String(lu)); return; }
    case "limited unsigned long with fallback": { var lf = __jb.toUint32(v); if (lf === 0 || lf > __jb.MAX_INT) lf = spec.defaultVal === undefined ? 1 : spec.defaultVal; __jb.protoSetAttr(el, attr, String(lf)); return; }
    case "clamped unsigned long": { var cu = __jb.toUint32(v); if (cu > __jb.MAX_INT) cu = spec.defaultVal; __jb.protoSetAttr(el, attr, String(cu)); return; }
    case "double": __jb.protoSetAttr(el, attr, String(__jb.toDouble(v))); return;
    case "limited double": { var d = __jb.toDouble(v); if (d <= 0) return; __jb.protoSetAttr(el, attr, String(d)); return; }
  }
  __jb.protoSetAttr(el, attr, String(v));
};
__jb.defineReflected = function (proto, idl, spec, keepGetter) {
  var attr = spec.domAttrName || idl.toLowerCase();
  var existing = keepGetter ? __jb.findGetter(proto, idl) : null;
  Object.defineProperty(proto, idl, {
    get: existing || function () { return __jb.reflectGet(this, attr, spec); },
    set: function (v) { __jb.reflectSet(this, attr, spec, v); },
    configurable: true,
    enumerable: true,
  });
};
__jb.findGetter = function (proto, name) { for (var p = proto; p; p = Object.getPrototypeOf(p)) { var d = Object.getOwnPropertyDescriptor(p, name); if (d) return d.get || null; } return null; };
// HTML tabIndex: the parsed attribute, else 0 for a, area, button, frame, iframe, input, object,
// select, textarea, SVG a and the summary for its parent details; -1 otherwise.
__jb.isSummaryForDetails = function (el) {
  var p = el.parentNode;
  if (!p || p.nodeType !== 1 || p._tag !== "details" || p._ns !== __jb.HTML_NS) return false;
  for (var c = p.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c._tag === "summary" && c._ns === __jb.HTML_NS) return c === el;
  return false;
};
__jb.tabIndexGetter = function () {
  var v = __jb.parseHtmlInt(this.getAttribute("tabindex") || "");
  if (v !== null && v <= __jb.MAX_INT && v >= __jb.MIN_INT) return v;
  if (this._ns === __jb.SVG_NS) return this._local === "a" ? 0 : -1;
  if (/^(a|area|button|frame|iframe|input|object|select|textarea)$/.test(this._tag)) return 0;
  if (this._tag === "summary" && __jb.isSummaryForDetails(this)) return 0;
  return -1;
};
Object.defineProperty(HTMLElement.prototype, "tabIndex", {
  get: __jb.tabIndexGetter,
  set: function (v) { __jb.protoSetAttr(this, "tabindex", String(__jb.toInt32(v))); },
  configurable: true, enumerable: true,
});
// document.fgColor & friends reflect attributes of the body element
// (installed by 40_document.js once Document exists).
__jb.defineDocumentColors = function (DocumentProto) {
  [["fgColor", "text"], ["linkColor", "link"], ["vlinkColor", "vlink"], ["alinkColor", "alink"], ["bgColor", "bgcolor"]].forEach(function (pair) {
    Object.defineProperty(DocumentProto, pair[0], {
      get: function () { var b = this.body; if (!b || b._tag !== "body") return ""; return b.getAttribute(pair[1]) || ""; },
      set: function (v) { var b = this.body; if (!b || b._tag !== "body") return; b.setAttribute(pair[1], v === null ? "" : String(v)); },
      configurable: true, enumerable: true,
    });
  });
};
(function () {
  Object.keys(__jb.REFLECT_GLOBAL).forEach(function (idl) { var spec = __jb.REFLECT_GLOBAL[idl]; __jb.defineReflected(HTMLElement.prototype, idl, spec, !!spec.customGetter); });
  Object.keys(__jb.REFLECT).forEach(function (tag) {
    var iface = __jb.HTML_INTERFACES[tag];
    var C = iface ? __jb.htmlClasses[iface] : null;
    if (!C || C === HTMLElement || C === HTMLUnknownElement) return;
    var attrs = __jb.REFLECT[tag];
    Object.keys(attrs).forEach(function (idl) { __jb.defineReflected(C.prototype, idl, attrs[idl], !!attrs[idl].customGetter); });
  });
})();
// ARIAMixin (ARIA in HTML, "ARIA reflection"): role/aria-* content attributes as
// nullable IDL attributes on Element, enumerated where ARIA defines keywords, and
// the element-reference attributes (ariaActiveDescendantElement, ariaLabelledByElements, ...)
// backed by "explicitly set attr-elements" with the shadow-including-ancestor scoping rule.
__jb.ARIA_ENUMS = {
  ariaAtomic: [["true", "false"], "false"], ariaAutoComplete: [["inline", "list", "both", "none"], "none"],
  ariaBusy: [["true", "false"], "false"], ariaChecked: [["true", "false", "mixed"], null],
  ariaCurrent: [["page", "step", "location", "date", "time", "true", "false"], "true"], ariaDisabled: [["true", "false"], "false"],
  ariaExpanded: [["true", "false"], null], ariaHasPopup: [["true", "false", "menu", "dialog", "listbox", "tree", "grid"], "false"],
  ariaHidden: [["true", "false"], "false"], ariaInvalid: [["true", "false", "spelling", "grammar"], "true"],
  ariaLive: [["polite", "assertive", "off"], "off"], ariaModal: [["true", "false"], "false"],
  ariaMultiLine: [["true", "false"], "false"], ariaMultiSelectable: [["true", "false"], "false"],
  ariaOrientation: [["horizontal", "vertical"], null], ariaPressed: [["true", "false", "mixed"], null],
  ariaReadOnly: [["true", "false"], "false"], ariaRequired: [["true", "false"], "false"],
  ariaSelected: [["true", "false"], null], ariaSort: [["ascending", "descending", "other", "none"], "none"],
};
__jb.ARIA_STRINGS = ["role", "ariaBrailleLabel", "ariaBrailleRoleDescription", "ariaColCount", "ariaColIndex", "ariaColIndexText", "ariaColSpan", "ariaDescription", "ariaKeyShortcuts", "ariaLabel", "ariaLevel", "ariaPlaceholder", "ariaPosInSet", "ariaRelevant", "ariaRoleDescription", "ariaRowCount", "ariaRowIndex", "ariaRowIndexText", "ariaRowSpan", "ariaSetSize", "ariaValueMax", "ariaValueMin", "ariaValueNow", "ariaValueText"];
__jb.ARIA_ELEMENT = { ariaActiveDescendantElement: "aria-activedescendant" };
__jb.ARIA_ELEMENTS = { ariaControlsElements: "aria-controls", ariaDescribedByElements: "aria-describedby", ariaDetailsElements: "aria-details", ariaErrorMessageElements: "aria-errormessage", ariaFlowToElements: "aria-flowto", ariaLabelledByElements: "aria-labelledby", ariaOwnsElements: "aria-owns" };
__jb.ariaAttrName = function (idl) { return idl === "role" ? "role" : "aria-" + idl.slice(4).toLowerCase(); };
// Is candidate a descendant of one of el's shadow-including inclusive ancestors' roots?
__jb.ariaInScope = function (el, candidate) {
  var r = candidate.getRootNode();
  for (var x = el; x;) { var root = x.getRootNode(); if (root === r) return true; x = root.nodeType === 11 && root._host ? root._host : null; }
  return false;
};
__jb.ariaFindId = function (el, id) {
  if (id === "") return null;
  var stack = [el.getRootNode()];
  while (stack.length) { var n = stack.pop(); if (n.nodeType === 1 && n.getAttribute("id") === id) return n; for (var c = n.lastChild; c; c = c.previousSibling) stack.push(c); }
  return null;
};
__jb.ariaIsElement = function (v) { return __jb.isNode(v) && v.nodeType === 1; };
// Attribute change steps: setting the content attribute drops the explicitly set elements.
__jb.ariaAttrChanged = function (el, name) { if (el._ariaExplicit && Object.prototype.hasOwnProperty.call(el._ariaExplicit, name)) delete el._ariaExplicit[name]; };
(function () {
  var P = Element.prototype;
  __jb.ARIA_STRINGS.forEach(function (idl) {
    var attr = __jb.ariaAttrName(idl);
    Object.defineProperty(P, idl, {
      get: function () { return this.getAttribute(attr); },
      set: function (v) { if (v === null || v === undefined) __jb.protoRemoveAttr(this, attr); else __jb.protoSetAttr(this, attr, String(v)); },
      configurable: true, enumerable: true,
    });
  });
  Object.keys(__jb.ARIA_ENUMS).forEach(function (idl) {
    var attr = __jb.ariaAttrName(idl), keywords = __jb.ARIA_ENUMS[idl][0], invalid = __jb.ARIA_ENUMS[idl][1];
    Object.defineProperty(P, idl, {
      get: function () { var raw = this.getAttribute(attr); if (raw === null) return null; var lower = raw.toLowerCase(); return keywords.indexOf(lower) >= 0 ? lower : invalid; },
      set: function (v) { if (v === null || v === undefined) __jb.protoRemoveAttr(this, attr); else __jb.protoSetAttr(this, attr, String(v)); },
      configurable: true, enumerable: true,
    });
  });
  Object.keys(__jb.ARIA_ELEMENT).forEach(function (idl) {
    var attr = __jb.ARIA_ELEMENT[idl];
    Object.defineProperty(P, idl, {
      get: function () {
        var ex = this._ariaExplicit;
        if (ex && Object.prototype.hasOwnProperty.call(ex, attr)) { var e = ex[attr]; return e && __jb.ariaInScope(this, e) ? e : null; }
        var raw = this.getAttribute(attr);
        return raw === null ? null : __jb.ariaFindId(this, raw);
      },
      set: function (v) {
        if (v === null || v === undefined) { __jb.protoRemoveAttr(this, attr); if (this._ariaExplicit) delete this._ariaExplicit[attr]; return; }
        if (!__jb.ariaIsElement(v)) throw new TypeError("Failed to set '" + idl + "': The provided value is not of type 'Element'.");
        __jb.protoSetAttr(this, attr, "");
        if (!this._ariaExplicit) Object.defineProperty(this, "_ariaExplicit", { value: {}, writable: true });
        this._ariaExplicit[attr] = v;
      },
      configurable: true, enumerable: true,
    });
  });
  Object.keys(__jb.ARIA_ELEMENTS).forEach(function (idl) {
    var attr = __jb.ARIA_ELEMENTS[idl];
    Object.defineProperty(P, idl, {
      get: function () {
        var self = this, list, ex = this._ariaExplicit;
        if (ex && Object.prototype.hasOwnProperty.call(ex, attr)) list = ex[attr].filter(function (e) { return __jb.ariaInScope(self, e); });
        else {
          var raw = this.getAttribute(attr);
          if (raw === null) return null;
          list = [];
          raw.split(/[\t\n\f\r ]+/).forEach(function (tok) { var f = tok ? __jb.ariaFindId(self, tok) : null; if (f) list.push(f); });
        }
        if (!this._ariaCache) Object.defineProperty(this, "_ariaCache", { value: {}, writable: true });
        var cached = this._ariaCache[attr];
        if (cached && cached.length === list.length && cached.every(function (e, i) { return e === list[i]; })) return cached;
        return (this._ariaCache[attr] = Object.freeze(list));
      },
      set: function (v) {
        if (v === null || v === undefined) { __jb.protoRemoveAttr(this, attr); if (this._ariaExplicit) delete this._ariaExplicit[attr]; return; }
        if (typeof v !== "object" || typeof v[Symbol.iterator] !== "function") throw new TypeError("Failed to set '" + idl + "': The provided value cannot be converted to a sequence.");
        var arr = [];
        for (var e of v) { if (!__jb.ariaIsElement(e)) throw new TypeError("Failed to set '" + idl + "': Failed to convert value to 'Element'."); arr.push(e); }
        __jb.protoSetAttr(this, attr, "");
        if (!this._ariaExplicit) Object.defineProperty(this, "_ariaExplicit", { value: {}, writable: true });
        this._ariaExplicit[attr] = arr;
      },
      configurable: true, enumerable: true,
    });
  });
})();
