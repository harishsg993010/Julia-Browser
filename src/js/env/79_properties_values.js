// Part 16: CSS Properties and Values API: CSS.registerProperty(). Stylo checks the syntax and
// the initial value (host op cssdecl "register"); registrations reach the layout engine as
// @property rules appended after the document's own style sheets (script registrations win).
(function () {
  if (typeof CSS === "undefined" || globalThis.__jb_workerRealm) return;
  var registry = new Map();
  __jb.registeredProperties = registry;
  var cssString = function (s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ") + '"'; };
  __jb.registeredPropertyCss = function () {
    var out = "";
    registry.forEach(function (r, name) {
      out += "@property " + name + " { syntax: " + cssString(r.syntax) + "; inherits: " + (r.inherits ? "true" : "false") + ";" + (r.initialValue !== null ? " initial-value: " + r.initialValue + ";" : "") + " }\n";
    });
    return out;
  };
  // @property rules: descriptors from the rule text; an invalid rule is dropped from the CSSOM
  var descriptors = function (text) {
    var m = /\{([\s\S]*)\}\s*$/.exec(String(text)), out = Object.create(null);
    if (!m) return out;
    m[1].split(";").forEach(function (d) {
      var i = d.indexOf(":");
      if (i < 0) return;
      var k = d.slice(0, i).trim().toLowerCase(), v = d.slice(i + 1).trim();
      if (k) out[k] = v;
    });
    return out;
  };
  var unquote = function (v) { var m = /^(["'])([\s\S]*)\1$/.exec(v); return m ? m[2].replace(/\\(.)/g, "$1") : null; };
  __jb.propertyRuleValid = function (prelude, text) {
    var name = String(prelude).replace(/^@property\s*/i, "").trim();
    if (!/^--./.test(name)) return false;
    var d = descriptors(text);
    if (d.syntax === undefined || d.inherits === undefined) return false;
    var syntax = unquote(d.syntax);
    if (syntax === null || !/^(true|false)$/i.test(d.inherits)) return false;
    var r = null;
    try { r = __jb.native("cssdecl", { op: "register", syntax: syntax, initial: d["initial-value"] === undefined ? null : d["initial-value"] }); } catch (e) { r = "ok"; }
    return r === "ok" || r === null;
  };
  // CSSOM serialization: @property NAME { syntax: "..."; inherits: ...; initial-value: ...; }
  __jb.propertyRuleText = function (prelude, text) {
    var name = String(prelude).replace(/^@property\s*/i, "").trim(), d = descriptors(text);
    var out = "@property " + name + " {";
    if (d.syntax !== undefined) out += " syntax: " + cssString(unquote(d.syntax) || "") + ";";
    if (d.inherits !== undefined) out += " inherits: " + d.inherits.toLowerCase() + ";";
    if (d["initial-value"] !== undefined) out += " initial-value: " + d["initial-value"] + ";";
    return out + " }";
  };
  if (typeof CSSPropertyRule === "function") {
    var P = CSSPropertyRule.prototype;
    Object.defineProperty(P, "name", { get: function () { return __jb.rulePrelude(this).replace(/^@property\s*/i, "").trim(); }, enumerable: true, configurable: true });
    Object.defineProperty(P, "syntax", { get: function () { var s = unquote(descriptors(this.cssText).syntax || ""); return s === null ? "" : s; }, enumerable: true, configurable: true });
    Object.defineProperty(P, "inherits", { get: function () { return /^true$/i.test(descriptors(this.cssText).inherits || ""); }, enumerable: true, configurable: true });
    Object.defineProperty(P, "initialValue", { get: function () { var v = descriptors(this.cssText)["initial-value"]; return v === undefined ? null : v; }, enumerable: true, configurable: true });
  }
  Object.defineProperty(CSS, "registerProperty", { value: function registerProperty(definition) {
    if (arguments.length < 1) throw new TypeError("CSS.registerProperty: 1 argument required");
    if (definition === null || typeof definition !== "object") throw new TypeError("CSS.registerProperty: Argument 1 is not a dictionary");
    if (definition.name === undefined) throw new TypeError("CSS.registerProperty: 'name' member of PropertyDefinition is required");
    if (definition.inherits === undefined) throw new TypeError("CSS.registerProperty: 'inherits' member of PropertyDefinition is required");
    var name = String(definition.name), syntax = definition.syntax === undefined ? "*" : String(definition.syntax), inherits = !!definition.inherits;
    var initial = definition.initialValue === undefined ? null : String(definition.initialValue);
    if (!/^--./.test(name) && name !== "--") throw __jb.domError("SyntaxError", "'" + name + "' is not a custom property name");
    if (registry.has(name)) throw __jb.domError("InvalidModificationError", "'" + name + "' is already registered");
    var r = null;
    try { r = __jb.native("cssdecl", { op: "register", syntax: syntax, initial: initial }); } catch (e) { r = null; }
    if (r === "syntax") throw __jb.domError("SyntaxError", "'" + syntax + "' is not a valid syntax definition");
    if (r === "missing") throw __jb.domError("SyntaxError", "An initial value is required for syntax '" + syntax + "'");
    if (r === "initial" || r === "dependent") throw __jb.domError("SyntaxError", "'" + initial + "' is not a valid computationally independent initial value for '" + syntax + "'");
    registry.set(name, { syntax: syntax, inherits: inherits, initialValue: initial === null ? null : initial.trim() });
    __jb.domVersion++; // restyle
  }, writable: true, enumerable: true, configurable: true });
})();
