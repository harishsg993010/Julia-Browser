// ---------------------------------------------------------------- Trusted Types
// TrustedHTML / TrustedScript / TrustedScriptURL, policies and the factory (window.trustedTypes),
// enforced through CSP `require-trusted-types-for 'script'` and `trusted-types`. Injection sinks
// (HTML parsing APIs, script text and URLs, event handler and other sensitive attributes,
// string compilation, string timers, worker constructors) go through "Get Trusted Type
// compliant string": trusted values pass, plain strings go to the default policy, else a
// violation is reported and the assignment throws. Loaded after 97_idl_install so the sink
// wrappers stay on the prototypes.
(function () {
  var TT = __jb.tt = {};
  var DATA = new WeakMap();
  TT.bypass = 0;
  TT.internal = function (fn) { TT.bypass++; try { return fn(); } finally { TT.bypass--; } };
  var def = function (obj, name, value, enumerable) { Object.defineProperty(obj, name, { value: value, writable: true, enumerable: enumerable !== false, configurable: true }); };
  var illegal = function () { throw new TypeError("Illegal constructor"); };

  // ---- the trusted value types ----
  var makeType = function (name) {
    var C = function () { illegal(); };
    Object.defineProperty(C, "name", { value: name, configurable: true });
    Object.defineProperty(C, "length", { value: 0, configurable: true });
    var brand = function (v) { if (!v || typeof v !== "object" || !DATA.has(v) || DATA.get(v).type !== C) throw new TypeError("'" + name + "' method called on an object that does not implement interface " + name + "."); return DATA.get(v).data; };
    def(C.prototype, "toString", function toString() { return brand(this); });
    def(C.prototype, "toJSON", function toJSON() { return brand(this); });
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
    def(C, "fromLiteral", function fromLiteral(templateStringsArray) {
      if (arguments.length < 1) throw new TypeError(name + ".fromLiteral: 1 argument required");
      var t = templateStringsArray;
      // a template strings array: frozen, with a frozen `raw`, and no substitutions
      if (!Array.isArray(t) || !Object.isFrozen(t) || !t.hasOwnProperty("raw") || !Array.isArray(t.raw) || !Object.isFrozen(t.raw) || t.length !== 1) throw new TypeError(name + ".fromLiteral: argument is not a template literal");
      return TT.create(C, String(t[0]));
    });
    return C;
  };
  var TrustedHTML = makeType("TrustedHTML"), TrustedScript = makeType("TrustedScript"), TrustedScriptURL = makeType("TrustedScriptURL");
  TT.TYPES = { TrustedHTML: TrustedHTML, TrustedScript: TrustedScript, TrustedScriptURL: TrustedScriptURL };
  TT.create = function (C, data) { var o = Object.create(C.prototype); DATA.set(o, { type: C, data: String(data) }); return o; };
  TT.is = function (v, C) { return !!v && typeof v === "object" && DATA.has(v) && DATA.get(v).type === C; };
  TT.isTrustedText = function (v, text) { return TT.is(v, TrustedScript) && TT.data(v) === String(text); };
  TT.data = function (v) { return DATA.get(v).data; };
  var FN_NAME = { TrustedHTML: "createHTML", TrustedScript: "createScript", TrustedScriptURL: "createScriptURL" };

  // ---- policies ----
  var POLICY = new WeakMap();
  var TrustedTypePolicy = function () { illegal(); };
  Object.defineProperty(TrustedTypePolicy, "name", { value: "TrustedTypePolicy", configurable: true });
  Object.defineProperty(TrustedTypePolicy.prototype, Symbol.toStringTag, { value: "TrustedTypePolicy", configurable: true });
  var policyOf = function (p) { var r = POLICY.get(p); if (!r) throw new TypeError("Illegal invocation"); return r; };
  Object.defineProperty(TrustedTypePolicy.prototype, "name", { get: function () { return policyOf(this).name; }, enumerable: true, configurable: true });
  // "Get Trusted Type policy value"
  TT.policyValue = function (rec, typeName, value, args, throwIfMissing) {
    var fn = rec.options[FN_NAME[typeName]];
    if (fn === null || fn === undefined) { if (throwIfMissing) throw new TypeError("Policy " + rec.name + "'s TrustedTypePolicyOptions did not specify a '" + FN_NAME[typeName] + "' member."); return null; }
    var r = fn.apply(undefined, [value].concat(args));
    if (r === null || r === undefined) return r;
    return String(r);
  };
  ["TrustedHTML", "TrustedScript", "TrustedScriptURL"].forEach(function (typeName) {
    def(TrustedTypePolicy.prototype, FN_NAME[typeName], { [FN_NAME[typeName]]: function (input) {
      var rec = policyOf(this);
      if (arguments.length < 1) throw new TypeError("TrustedTypePolicy." + FN_NAME[typeName] + ": 1 argument required");
      var args = Array.prototype.slice.call(arguments, 1);
      var v = TT.policyValue(rec, typeName, String(input), args, true);
      return TT.create(TT.TYPES[typeName], v === null || v === undefined ? "" : v);
    } }[FN_NAME[typeName]]);
  });

  // ---- CSP integration ----
  var policies = function () { try { return __jb.cspPolicies(); } catch (e) { return []; } };
  var has = function (list, kw) { return __jb.csp.has(list, kw); };
  // "Does sink type require trusted types?"
  TT.required = function (includeReportOnly) {
    return policies().some(function (p) { var v = p.directives["require-trusted-types-for"]; return v && has(v, "'script'") && (includeReportOnly || p.disposition === "enforce"); });
  };
  var TT_NAME = /^[A-Za-z0-9\-#=_\/@.%]+$/;
  // "Should Trusted Type policy creation be blocked by CSP?"
  TT.policyCreationAllowed = function (name, created) {
    var result = true;
    policies().forEach(function (p) {
      var v = p.directives["trusted-types"];
      if (!v) return;
      var violation = false;
      if (created.indexOf(name) >= 0 && !has(v, "'allow-duplicates'")) violation = true;
      if (!v.some(function (t) { return t === name && TT_NAME.test(t); }) && !has(v, "*")) violation = true;
      if (!violation) return;
      __jb.csp.violation({ policy: p, effective: "trusted-types", resource: "trusted-types-policy", sample: String(name).slice(0, 40) });
      if (p.disposition === "enforce") result = false;
    });
    return result;
  };
  // "Should sink type mismatch violation be blocked by CSP?"
  TT.sinkMismatchAllowed = function (sink, source) {
    var result = true;
    var sample = String(source);
    if (sink === "Function" && sample.indexOf("function anonymous") === 0) sample = sample.slice("function anonymous".length);
    policies().forEach(function (p) {
      var v = p.directives["require-trusted-types-for"];
      if (!v || !has(v, "'script'")) return;
      __jb.csp.violation({ policy: p, effective: "require-trusted-types-for", resource: "trusted-types-sink", sample: sink + "|" + sample.slice(0, 40) });
      if (p.disposition === "enforce") result = false;
    });
    return result;
  };
  // "Get Trusted Type compliant string"
  TT.compliant = function (C, input, sink) {
    if (TT.is(input, C)) return TT.data(input);
    if (TT.bypass > 0 || !TT.required(true)) return typeof input === "string" ? input : String(input);
    var str = String(input);
    var converted = TT.processDefault(C, str, sink);
    if (converted === null || converted === undefined) {
      if (TT.sinkMismatchAllowed(sink, str)) return str;
      throw new TypeError("This document requires '" + C.name + "' assignment.");
    }
    return converted;
  };
  // "Process value with a default policy" (the converted string, or null/undefined)
  TT.processDefault = function (C, str, sink) {
    var dp = factoryRec.defaultPolicy;
    if (!dp) return null;
    var rec = POLICY.get(dp);
    var v = TT.policyValue(rec, C.name, str, [C.name, sink], false);
    return v;
  };

  // ---- TrustedHTMLParserOptions (tentative): parser options produced by a policy ----
  var TPO = new WeakMap();
  var TrustedHTMLParserOptions = function () { illegal(); };
  Object.defineProperty(TrustedHTMLParserOptions, "name", { value: "TrustedHTMLParserOptions", configurable: true });
  Object.defineProperty(TrustedHTMLParserOptions.prototype, Symbol.toStringTag, { value: "TrustedHTMLParserOptions", configurable: true });
  // the dictionary a createParserOptions callback sees: its sanitizer as a (fresh) Sanitizer
  var callbackOptions = function (o) {
    var out = {};
    if (o !== undefined && o !== null && typeof o === "object") {
      if (o.runScripts !== undefined) out.runScripts = !!o.runScripts;
      if (o.sanitizer !== undefined && typeof Sanitizer === "function") out.sanitizer = o.sanitizer instanceof Sanitizer ? new Sanitizer(o.sanitizer.get()) : new Sanitizer(o.sanitizer === null ? undefined : o.sanitizer);
    }
    return out;
  };
  var makeParserOptions = function (result) {
    if (result === null || result === undefined) result = {};
    else if (typeof result !== "object") throw new TypeError("createParserOptions must return a dictionary");
    var t = Object.create(TrustedHTMLParserOptions.prototype);
    TPO.set(t, { sanitizer: result.sanitizer === undefined || result.sanitizer === null ? null : result.sanitizer, runScripts: !!result.runScripts });
    return t;
  };
  TT.callParserOptions = function (rec, options, args) {
    return makeParserOptions(rec.options.createParserOptions.apply(undefined, [callbackOptions(options)].concat(args || [])));
  };
  def(TrustedTypePolicy.prototype, "createParserOptions", function createParserOptions(options) {
    var rec = policyOf(this);
    if (!rec.options.createParserOptions) throw new TypeError("Policy " + rec.name + "'s TrustedTypePolicyOptions did not specify a 'createParserOptions' member.");
    return TT.callParserOptions(rec, options, Array.prototype.slice.call(arguments, 1));
  });
  __jb.trustedParserOptionsConfig = function (o) { var d = o !== null && typeof o === "object" ? TPO.get(o) : undefined; return d ? d.sanitizer : undefined; };
  __jb.trustedParserOptionsRunScripts = function (o) { var d = o !== null && typeof o === "object" ? TPO.get(o) : undefined; return d ? d.runScripts : undefined; };
  // a string reaching an HTML parsing sink under enforcement: the default policy's parser options
  // (run before createHTML; exceptions propagate), or null
  TT.defaultParserOptions = function (input, baseOptions) {
    if (TT.bypass > 0 || TT.is(input, TrustedHTML) || !TT.required(true)) return null;
    var dp = factoryRec.defaultPolicy;
    if (!dp) return null;
    var rec = POLICY.get(dp);
    if (!rec.options.createParserOptions) return null;
    var t = TT.callParserOptions(rec, baseOptions, []);
    // runScripts can be turned off, never on
    TPO.get(t).runScripts = TPO.get(t).runScripts && !!(baseOptions && baseOptions.runScripts);
    return t;
  };
  TT.parserSanitizer = function (t) { var d = t ? TPO.get(t) : null; return d ? d.sanitizer : null; };

  // ---- the factory ----
  var TrustedTypePolicyFactory = function () { illegal(); };
  Object.defineProperty(TrustedTypePolicyFactory, "name", { value: "TrustedTypePolicyFactory", configurable: true });
  Object.defineProperty(TrustedTypePolicyFactory.prototype, Symbol.toStringTag, { value: "TrustedTypePolicyFactory", configurable: true });
  var factoryRec = { created: [], defaultPolicy: null };
  var factory = Object.create(TrustedTypePolicyFactory.prototype);
  var isFactory = function (f) { if (f !== factory) throw new TypeError("Illegal invocation"); };
  def(TrustedTypePolicyFactory.prototype, "createPolicy", function createPolicy(policyName, policyOptions) {
    isFactory(this);
    if (arguments.length < 1) throw new TypeError("TrustedTypePolicyFactory.createPolicy: 1 argument required");
    var name = String(policyName);
    // TrustedTypePolicyOptions (members in lexicographic order; callbacks must be callable)
    var options = { createHTML: null, createParserOptions: null, createScript: null, createScriptURL: null };
    if (policyOptions !== undefined && policyOptions !== null) {
      if (typeof policyOptions !== "object" && typeof policyOptions !== "function") throw new TypeError("createPolicy: options is not an object");
      ["createHTML", "createParserOptions", "createScript", "createScriptURL"].forEach(function (k) {
        var v = policyOptions[k];
        if (v === undefined) return;
        if (typeof v !== "function") throw new TypeError("createPolicy: '" + k + "' is not a function");
        options[k] = v;
      });
    }
    if (!TT.policyCreationAllowed(name, factoryRec.created)) throw new TypeError("Failed to execute 'createPolicy': Policy \"" + name + "\" disallowed.");
    if (name === "default" && factoryRec.defaultPolicy) throw new TypeError("Failed to execute 'createPolicy': Policy \"default\" already exists.");
    var p = Object.create(TrustedTypePolicy.prototype);
    POLICY.set(p, { name: name, options: options });
    if (name === "default") factoryRec.defaultPolicy = p;
    factoryRec.created.push(name);
    return p;
  });
  def(TrustedTypePolicyFactory.prototype, "isHTML", function isHTML(value) { isFactory(this); return TT.is(value, TrustedHTML); });
  def(TrustedTypePolicyFactory.prototype, "isScript", function isScript(value) { isFactory(this); return TT.is(value, TrustedScript); });
  def(TrustedTypePolicyFactory.prototype, "isScriptURL", function isScriptURL(value) { isFactory(this); return TT.is(value, TrustedScriptURL); });
  var emptyHTML = TT.create(TrustedHTML, ""), emptyScript = TT.create(TrustedScript, "");
  Object.defineProperty(TrustedTypePolicyFactory.prototype, "emptyHTML", { get: function () { isFactory(this); return emptyHTML; }, enumerable: true, configurable: true });
  Object.defineProperty(TrustedTypePolicyFactory.prototype, "emptyScript", { get: function () { isFactory(this); return emptyScript; }, enumerable: true, configurable: true });
  Object.defineProperty(TrustedTypePolicyFactory.prototype, "defaultPolicy", { get: function () { isFactory(this); return factoryRec.defaultPolicy; }, enumerable: true, configurable: true });

  // "Get Trusted Type data for attribute": [type name, sink] or null.
  var XLINK = "http://www.w3.org/1999/xlink";
  TT.isEventHandlerName = function (name) {
    if (!/^on/.test(name)) return false;
    var n = name.slice(2);
    return (__jb.EVENT_HANDLER_NAMES && __jb.EVENT_HANDLER_NAMES.indexOf(n) >= 0) || (__jb.WINDOW_HANDLER_NAMES && __jb.WINDOW_HANDLER_NAMES.indexOf(n) >= 0) || /^(encrypted|waitingforkey|begin|end|repeat)$/.test(n);
  };
  TT.attributeData = function (iface, attr, attrNs) {
    if (attrNs === "") attrNs = null;
    // event handler content attributes of HTML, SVG and MathML elements
    if (attrNs === null && iface !== "Element" && TT.isEventHandlerName(attr)) return ["TrustedScript", "Element " + attr];
    if (iface === "HTMLIFrameElement" && attrNs === null && attr === "srcdoc") return ["TrustedHTML", "HTMLIFrameElement srcdoc"];
    if (iface === "HTMLScriptElement" && attrNs === null && attr === "src") return ["TrustedScriptURL", "HTMLScriptElement src"];
    if (iface === "SVGScriptElement" && (attrNs === null || attrNs === XLINK) && attr === "href") return ["TrustedScriptURL", "SVGScriptElement href"];
    return null;
  };
  var interfaceFor = function (localName, ns) {
    if (ns === __jb.HTML_NS) { if (localName === "iframe") return "HTMLIFrameElement"; if (localName === "script") return "HTMLScriptElement"; return "HTMLElement"; }
    if (ns === __jb.SVG_NS) return localName === "script" ? "SVGScriptElement" : "SVGElement";
    if (ns === "http://www.w3.org/1998/Math/MathML") return "MathMLElement";
    return "Element";
  };
  var elementInterface = function (el) { return interfaceFor(el._local, el._ns); };
  def(TrustedTypePolicyFactory.prototype, "getAttributeType", function getAttributeType(tagName, attribute) {
    isFactory(this);
    if (arguments.length < 2) throw new TypeError("getAttributeType: 2 arguments required");
    var elementNs = arguments.length > 2 && arguments[2] !== undefined ? (arguments[2] === null ? null : String(arguments[2])) : "";
    var attrNs = arguments.length > 3 && arguments[3] !== undefined ? (arguments[3] === null ? null : String(arguments[3])) : "";
    var localName = String(tagName).replace(/[A-Z]/g, function (c) { return c.toLowerCase(); });
    var attr = String(attribute).replace(/[A-Z]/g, function (c) { return c.toLowerCase(); });
    if (elementNs === "") elementNs = __jb.HTML_NS;
    if (attrNs === "") attrNs = null;
    var d = TT.attributeData(interfaceFor(localName, elementNs), attr, attrNs);
    return d ? d[0] : null;
  });
  def(TrustedTypePolicyFactory.prototype, "getPropertyType", function getPropertyType(tagName, property) {
    isFactory(this);
    if (arguments.length < 2) throw new TypeError("getPropertyType: 2 arguments required");
    var elementNs = arguments.length > 2 && arguments[2] !== undefined ? (arguments[2] === null ? null : String(arguments[2])) : "";
    var localName = String(tagName).replace(/[A-Z]/g, function (c) { return c.toLowerCase(); });
    var prop = String(property);
    if (elementNs === "") elementNs = __jb.HTML_NS;
    var iface = interfaceFor(localName, elementNs);
    if (iface === "HTMLIFrameElement" && prop === "srcdoc") return "TrustedHTML";
    if (iface === "HTMLScriptElement" && (prop === "innerText" || prop === "text" || prop === "textContent")) return "TrustedScript";
    if (iface === "HTMLScriptElement" && prop === "src") return "TrustedScriptURL";
    if (prop === "innerHTML" || prop === "outerHTML") return "TrustedHTML";
    return null;
  });
  [TrustedHTML, TrustedScript, TrustedScriptURL, TrustedTypePolicy, TrustedTypePolicyFactory, TrustedHTMLParserOptions].forEach(function (C) { def(globalThis, C.name, C, false); });
  Object.defineProperty(globalThis, "trustedTypes", { get: function () { return factory; }, enumerable: true, configurable: true });

  // ---- sinks ----
  var HTMLSink = function (input, sink) { return TT.compliant(TrustedHTML, input, sink); };
  var wrapSetter = function (proto, prop, C, sink) {
    var d = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    var set = d.set;
    Object.defineProperty(proto, prop, { get: d.get, set: { [prop]: function (v) {
      var self_ = this, po = C === TrustedHTML && v !== null ? TT.defaultParserOptions(v, {}) : null, san = TT.parserSanitizer(po);
      var s = san !== null ? (TT.is(v, TrustedHTML) ? TT.data(v) : String(v)) : v === null && C === TrustedHTML ? v : TT.compliant(C, v, typeof sink === "function" ? sink(this) : sink);
      var ins = san !== null && typeof __jb.captureInsertion === "function" ? __jb.captureInsertion(self_, prop === "outerHTML" ? "outer" : "inner") : null;
      TT.internal(function () { set.call(self_, s); });
      if (ins) __jb.sanitizeInsertion(ins, san);
    } }[prop], enumerable: d.enumerable, configurable: true });
  };
  var wrapMethod = function (obj, name, index, C, sink) {
    var f = obj && obj[name];
    if (typeof f !== "function") return;
    var w = { [name]: function () { var args = Array.prototype.slice.call(arguments); if (args.length > index && TT.bypass === 0) args[index] = TT.compliant(C, args[index], sink); var self_ = this; return TT.internal(function () { return f.apply(self_, args); }); } }[name];
    Object.defineProperty(w, "length", { value: f.length, configurable: true });
    Object.defineProperty(obj, name, { value: w, writable: true, enumerable: Object.getOwnPropertyDescriptor(obj, name) ? Object.getOwnPropertyDescriptor(obj, name).enumerable : true, configurable: true });
  };
  var protoWith = function (C, prop) { var p = C && C.prototype; while (p && !Object.prototype.hasOwnProperty.call(p, prop)) p = Object.getPrototypeOf(p); return p; };
  wrapSetter(protoWith(Element, "innerHTML"), "innerHTML", TrustedHTML, "Element innerHTML");
  wrapSetter(protoWith(Element, "outerHTML"), "outerHTML", TrustedHTML, "Element outerHTML");
  if (typeof ShadowRoot === "function") wrapSetter(protoWith(ShadowRoot, "innerHTML"), "innerHTML", TrustedHTML, "ShadowRoot innerHTML");
  // HTML sinks taking parser options: an explicit TrustedHTMLParserOptions, else the default
  // policy's; with a sanitizer the string needs no createHTML
  var wrapParserMethod = function (obj, name, sink) {
    var f = obj && obj[name];
    if (typeof f !== "function") return;
    var w = { [name]: function (html, options) {
      var args = Array.prototype.slice.call(arguments);
      if (args.length > 0 && TT.bypass === 0) {
        var po = options !== undefined && options !== null && typeof options === "object" && TPO.has(options) ? options : TT.defaultParserOptions(html, options && typeof options === "object" ? options : {});
        if (po && po !== options) args[1] = po;
        args[0] = TT.parserSanitizer(po) !== null ? (TT.is(html, TrustedHTML) ? TT.data(html) : String(html)) : TT.compliant(TrustedHTML, html, sink);
      }
      var self_ = this;
      return TT.internal(function () { return f.apply(self_, args); });
    } }[name];
    Object.defineProperty(w, "length", { value: f.length, configurable: true });
    Object.defineProperty(obj, name, { value: w, writable: true, enumerable: Object.getOwnPropertyDescriptor(obj, name) ? Object.getOwnPropertyDescriptor(obj, name).enumerable : true, configurable: true });
  };
  wrapParserMethod(Element.prototype, "setHTMLUnsafe", "Element setHTMLUnsafe");
  if (typeof ShadowRoot === "function") wrapParserMethod(ShadowRoot.prototype, "setHTMLUnsafe", "ShadowRoot setHTMLUnsafe");
  wrapParserMethod(Document, "parseHTMLUnsafe", "Document parseHTMLUnsafe");
  (function () {
    var f = Element.prototype.insertAdjacentHTML;
    if (typeof f !== "function") return;
    var w = function insertAdjacentHTML(position, html) {
      var args = Array.prototype.slice.call(arguments), self_ = this, ins = null, san = null;
      if (args.length > 1 && TT.bypass === 0) {
        var po = TT.defaultParserOptions(html, {});
        san = TT.parserSanitizer(po);
        args[1] = san !== null ? (TT.is(html, TrustedHTML) ? TT.data(html) : String(html)) : TT.compliant(TrustedHTML, html, "Element insertAdjacentHTML");
        if (san !== null) ins = __jb.captureInsertion(self_, String(position).toLowerCase());
      }
      var r = TT.internal(function () { return f.apply(self_, args); });
      if (ins) __jb.sanitizeInsertion(ins, san);
      return r;
    };
    Object.defineProperty(w, "length", { value: f.length, configurable: true });
    Object.defineProperty(Element.prototype, "insertAdjacentHTML", { value: w, writable: true, enumerable: true, configurable: true });
  })();
  (function () {
    var f = Range.prototype.createContextualFragment;
    if (typeof f !== "function") return;
    var w = function createContextualFragment(html) {
      var args = Array.prototype.slice.call(arguments), self_ = this, po = null;
      if (args.length > 0 && TT.bypass === 0) {
        po = TT.defaultParserOptions(html, { runScripts: true });
        args[0] = TT.parserSanitizer(po) !== null ? (TT.is(html, TrustedHTML) ? TT.data(html) : String(html)) : TT.compliant(TrustedHTML, html, "Range createContextualFragment");
      }
      var frag = TT.internal(function () { return f.apply(self_, args); });
      if (po) {
        if (TT.parserSanitizer(po) !== null) __jb.sanitizeFragment(frag, TT.parserSanitizer(po));
        if (!TPO.get(po).runScripts) __jb.descendants(frag, function (n) { return n.nodeType === 1 && n._tag === "script"; }).forEach(function (s) { s._executed = true; });
      }
      return frag;
    };
    Object.defineProperty(w, "length", { value: f.length, configurable: true });
    Object.defineProperty(Range.prototype, "createContextualFragment", { value: w, writable: true, enumerable: true, configurable: true });
  })();
  wrapMethod(DOMParser.prototype, "parseFromString", 0, TrustedHTML, "DOMParser parseFromString");
  // document.write/writeln: all-trusted arguments concatenate, otherwise the joined string is checked
  ["write", "writeln"].forEach(function (name) {
    var proto = protoWith(Document, name);
    var f = proto && proto[name];
    if (typeof f !== "function") return;
    var w = { [name]: function () {
      var args = Array.prototype.slice.call(arguments);
      if (TT.bypass === 0 && TT.required(true)) {
        var allTrusted = args.length > 0 && args.every(function (a) { return TT.is(a, TrustedHTML); });
        var text = args.map(function (a) { return TT.is(a, TrustedHTML) ? TT.data(a) : String(a); }).join("");
        args = [allTrusted ? text : TT.compliant(TrustedHTML, text, "Document " + name)];
      }
      var self_ = this;
      return TT.internal(function () { return f.apply(self_, args); });
    } }[name];
    Object.defineProperty(w, "length", { value: f.length, configurable: true });
    Object.defineProperty(proto, name, { value: w, writable: true, enumerable: true, configurable: true });
  });
  // execCommand("insertHTML", ui, value)
  (function () {
    var proto = protoWith(Document, "execCommand");
    var f = proto && proto.execCommand;
    if (typeof f !== "function") return;
    var w = function execCommand(commandId, showUI, value) {
      var args = Array.prototype.slice.call(arguments);
      if (TT.bypass === 0 && String(commandId).toLowerCase() === "inserthtml" && args.length > 2) args[2] = TT.compliant(TrustedHTML, args[2], "Document execCommand");
      var self_ = this;
      return TT.internal(function () { return f.apply(self_, args); });
    };
    Object.defineProperty(w, "length", { value: f.length, configurable: true });
    Object.defineProperty(proto, "execCommand", { value: w, writable: true, enumerable: true, configurable: true });
  })();
  // <iframe srcdoc>, <script src>, script text
  wrapSetter(protoWith(HTMLIFrameElement, "srcdoc"), "srcdoc", TrustedHTML, "HTMLIFrameElement srcdoc");
  wrapSetter(protoWith(HTMLScriptElement, "src"), "src", TrustedScriptURL, "HTMLScriptElement src");
  // [[ScriptText]]: what a TT-compliant setter last stored; scripts whose child text differs are
  // checked when they are prepared.
  var scriptTextSetter = function (prop, sinkName, getterProto) {
    var proto = protoWith(HTMLScriptElement, prop) || getterProto;
    var d = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    var set = d.set;
    Object.defineProperty(HTMLScriptElement.prototype, prop, { get: d.get, set: { [prop]: function (v) {
      var s = v === null && prop !== "text" ? "" : TT.compliant(TrustedScript, v, sinkName);
      var self_ = this;
      TT.internal(function () { set.call(self_, s); });
      this._ttScriptText = __jb.childTextContent ? __jb.childTextContent(this) : this.textContent;
    } }[prop], enumerable: true, configurable: true });
  };
  scriptTextSetter("text", "HTMLScriptElement text");
  scriptTextSetter("textContent", "HTMLScriptElement textContent");
  scriptTextSetter("innerText", "HTMLScriptElement innerText");
  // Before an inline script runs: child text that no compliant setter produced is checked.
  TT.scriptText = function (el, text, parser) {
    if (TT.bypass > 0 || !TT.required(true)) return text;
    if (el._ttScriptText === undefined && parser === "parser-inserted") return text;
    if (el._ttScriptText === text) return text;
    var sink = el._ns === __jb.SVG_NS ? "SVGScriptElement text" : "HTMLScriptElement text";
    return TT.compliant(TrustedScript, text, sink);
  };
  // Attribute setters: "Get Trusted Types-compliant attribute value"
  TT.attributeValue = function (el, local, ns, value) {
    if (TT.bypass > 0) return value;
    var d = TT.attributeData(elementInterface(el), local, ns);
    if (!d) return value;
    var C = TT.TYPES[d[0]];
    if (TT.is(value, C)) return TT.data(value);
    var g = globalThis;
    try { var dv = el.ownerDocument && el.ownerDocument.defaultView; if (dv && dv.__jb && dv.__jb.tt && dv.__jb !== __jb) return dv.__jb.tt.attributeValue(el, local, ns, value); } catch (e) {}
    void g;
    return TT.compliant(C, value, d[1]);
  };
  (function () {
    var EP = Element.prototype;
    var setAttribute = EP.setAttribute, setAttributeNS = EP.setAttributeNS;
    def(EP, "setAttribute", { setAttribute: function (n, v) {
      if (arguments.length < 2 || TT.bypass > 0) return setAttribute.apply(this, arguments);
      var name = String(n);
      var lname = this._ns === __jb.HTML_NS && this.ownerDocument && this.ownerDocument._isHTML !== false ? name.replace(/[A-Z]/g, function (c) { return c.toLowerCase(); }) : name;
      var existing = this._getAttr ? this._getAttr(lname) : null;
      var s = TT.attributeValue(this, existing ? existing._local : lname, existing ? existing._ns : null, v);
      var self_ = this;
      return TT.internal(function () { return setAttribute.call(self_, n, s); });
    } }.setAttribute);
    def(EP, "setAttributeNS", { setAttributeNS: function (ns, qname, v) {
      if (arguments.length < 3 || TT.bypass > 0) return setAttributeNS.apply(this, arguments);
      var q = String(qname), local = q.indexOf(":") >= 0 ? q.slice(q.indexOf(":") + 1) : q;
      var s = TT.attributeValue(this, local, ns === undefined || ns === null || ns === "" ? null : String(ns), v);
      var self_ = this;
      return TT.internal(function () { return setAttributeNS.call(self_, ns, qname, s); });
    } }.setAttributeNS);
    // setAttributeNode(NS), NamedNodeMap.setNamedItem(NS), Attr.value: the attr's value is checked
    var baseSetNode = __jb.setAttributeNode;
    __jb.setAttributeNode = function (el, attr) {
      if (TT.bypass === 0 && (!attr._owner || attr._owner === el)) {
        var v = TT.attributeValue(el, attr._local, attr._ns, attr._value);
        if (v !== attr._value) attr._value = v;
      }
      return baseSetNode(el, attr);
    };
    var baseChange = __jb.changeAttribute;
    var AttrProto = typeof Attr === "function" ? Attr.prototype : null;
    var vd = AttrProto && Object.getOwnPropertyDescriptor(AttrProto, "value");
    if (vd && vd.set) {
      var vset = vd.set;
      Object.defineProperty(AttrProto, "value", { get: vd.get, set: function (v) {
        var owner = this.ownerElement;
        if (owner && TT.bypass === 0) {
          var s = TT.attributeValue(owner, this._local, this._ns, v);
          var self_ = this;
          return TT.internal(function () { vset.call(self_, s); });
        }
        return vset.call(this, v);
      }, enumerable: vd.enumerable, configurable: true });
      ["nodeValue", "textContent"].forEach(function (p) {
        var pd = Object.getOwnPropertyDescriptor(AttrProto, p) || null;
        if (pd && pd.set) {
          var ps = pd.set;
          Object.defineProperty(AttrProto, p, { get: pd.get, set: function (v) {
            var owner = this.ownerElement;
            if (owner && TT.bypass === 0) { var s = TT.attributeValue(owner, this._local, this._ns, v); var self_ = this; return TT.internal(function () { ps.call(self_, s); }); }
            return ps.call(this, v);
          }, enumerable: pd.enumerable, configurable: true });
        }
      });
    }
    void baseChange;
  })();
  // workers
  if (typeof Worker === "function") {
    var BaseWorker = Worker;
    var W = function Worker(scriptURL, options) {
      if (!new.target) throw new TypeError("Constructor Worker requires 'new'");
      if (arguments.length < 1) throw new TypeError("Failed to construct 'Worker': 1 argument required.");
      var url = TT.compliant(TrustedScriptURL, scriptURL, "Worker constructor");
      return Reflect.construct(BaseWorker, [url].concat(Array.prototype.slice.call(arguments, 1)), new.target);
    };
    W.prototype = BaseWorker.prototype;
    Object.defineProperty(W.prototype, "constructor", { value: W, writable: true, configurable: true });
    Object.setPrototypeOf(W, Object.getPrototypeOf(BaseWorker));
    def(globalThis, "Worker", W, false);
  }
  if (typeof SharedWorker === "function") {
    var BaseShared = SharedWorker;
    var SW = function SharedWorker(scriptURL, options) {
      if (!new.target) throw new TypeError("Constructor SharedWorker requires 'new'");
      if (arguments.length < 1) throw new TypeError("Failed to construct 'SharedWorker': 1 argument required.");
      var url = TT.compliant(TrustedScriptURL, scriptURL, "SharedWorker constructor");
      return Reflect.construct(BaseShared, [url].concat(Array.prototype.slice.call(arguments, 1)), new.target);
    };
    SW.prototype = BaseShared.prototype;
    Object.defineProperty(SW.prototype, "constructor", { value: SW, writable: true, configurable: true });
    Object.setPrototypeOf(SW, Object.getPrototypeOf(BaseShared));
    def(globalThis, "SharedWorker", SW, false);
  }
  __jb.ttImportScriptsUrl = function (u) { return TT.compliant(TrustedScriptURL, u, "WorkerGlobalScope importScripts"); };
  // string timers
  ["setTimeout", "setInterval"].forEach(function (name) {
    var f = globalThis[name];
    if (typeof f !== "function") return;
    var w = { [name]: function (handler) {
      var args = Array.prototype.slice.call(arguments);
      if (TT.is(handler, TrustedScript)) args[0] = TT.data(handler);
      else if (typeof handler !== "function" && TT.bypass === 0 && TT.required(true)) {
        var sink = (__jb.isWorker ? "WorkerGlobalScope " : "Window ") + name;
        try { args[0] = TT.compliant(TrustedScript, handler, sink); } catch (e) { return 0; }
      } else if (typeof handler !== "function") args[0] = String(handler);
      return f.apply(this, args);
    } }[name];
    Object.defineProperty(w, "length", { value: f.length, configurable: true });
    def(globalThis, name, w, true);
  });
  // eval / Function: the runtime asks __jb_cspEvalCheck (66b_csp.js) and HostGetCodeForEval here
  globalThis.__jb_ttCodeForEval = function (obj) { return TT.is(obj, TrustedScript) ? TT.data(obj) : undefined; };
  // Compilation check: returns false (EvalError) when the source is neither trusted nor made
  // compliant by the default policy; `trusted` = the body was a TrustedScript with that text.
  TT.compileCheck = function (kind, code, compilation, trusted) {
    if (kind === "wasm" || trusted || !TT.required(true)) return true;
    var sink = compilation === "Function" ? "Function" : "eval";
    var v;
    try { v = TT.compliant(TrustedScript, code, sink); } catch (e) { return false; }
    return v === code;
  };
  __jb.ttEvalAllowed = function () { return TT.required(false); };
})();
