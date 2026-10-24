// Part 13: MathML Core DOM: MathMLElement includes HTMLOrSVGOrMathMLElement (tabIndex,
// autofocus, nonce, focus(), blur()) and GlobalEventHandlers; MathMLAnchorElement (<a> in the
// MathML namespace) has href / target and the hyperlink members of HTMLAnchorElement.
(function () {
  if (typeof MathMLElement !== "function" || typeof HTMLElement !== "function") return;
  var MP = MathMLElement.prototype, HP = HTMLElement.prototype;
  var copy = function (from, to, name) {
    for (var p = from; p; p = Object.getPrototypeOf(p)) {
      var d = Object.getOwnPropertyDescriptor(p, name);
      if (d) { Object.defineProperty(to, name, d); return true; }
    }
    return false;
  };
  Object.defineProperty(MP, "tabIndex", {
    get: function () {
      var v = __jb.parseHtmlInt(this.getAttribute("tabindex") || "");
      if (v !== null && v <= __jb.MAX_INT && v >= __jb.MIN_INT) return v;
      return this._local === "a" || this._tag === "a" ? 0 : -1;
    },
    set: function (v) { this.setAttribute("tabindex", String(__jb.toInt32(v))); },
    enumerable: true, configurable: true,
  });
  Object.defineProperty(MP, "autofocus", {
    get: function () { return this.hasAttribute("autofocus"); },
    set: function (v) { if (v) this.setAttribute("autofocus", ""); else this.removeAttribute("autofocus"); },
    enumerable: true, configurable: true,
  });
  ["nonce", "dataset", "attributeStyleMap"].forEach(function (n) { if (!Object.prototype.hasOwnProperty.call(MP, n)) copy(HP, MP, n); });
  MP.focus = function (options) { __jb.focusElement(this, options); };
  MP.blur = function () { __jb.blurElement(this); };

  class MathMLAnchorElement extends MathMLElement {}
  var AP = MathMLAnchorElement.prototype;
  if (typeof HTMLAnchorElement === "function") {
    ["href", "target", "download", "ping", "rel", "relList", "hreflang", "type", "referrerPolicy", "origin", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash", "toString"].forEach(function (n) {
      copy(HTMLAnchorElement.prototype, AP, n);
    });
  }
  Object.defineProperty(AP, Symbol.toStringTag, { value: "MathMLAnchorElement", configurable: true });
  __jb.mathmlClasses = { a: MathMLAnchorElement };
  // MathML Core attribute mapping (presentational hints of the layout mirror, see 20_html.js)
  __jb.mathmlPresentationDecls = function (el) {
    var out = "", a = function (n) { return el.getAttribute(n); };
    var esc = function (v) { return String(v).replace(/[;{}<>]/g, ""); };
    var dir = a("dir");
    if (dir !== null && /^(ltr|rtl)$/i.test(dir.trim())) out += "direction:" + dir.trim().toLowerCase() + ";";
    if (a("mathcolor") !== null) out += "color:" + esc(a("mathcolor")) + ";";
    if (a("mathbackground") !== null) out += "background-color:" + esc(a("mathbackground")) + ";";
    if (a("mathsize") !== null) out += "font-size:" + esc(a("mathsize")) + ";";
    var ds = a("displaystyle");
    if (ds !== null && /^(true|false)$/i.test(ds.trim())) out += "math-style:" + (/^true$/i.test(ds.trim()) ? "normal" : "compact") + ";";
    var sl = a("scriptlevel");
    if (sl !== null) {
      var m = /^\s*([+-]?)(\d+)\s*$/.exec(sl);
      if (m) out += "math-depth:" + (m[1] ? "add(" + (m[1] === "-" ? "-" : "") + m[2] + ")" : m[2]) + ";";
    }
    if (el._local === "mi" && a("mathvariant") !== null && /^normal$/i.test(a("mathvariant").trim())) out += "text-transform:none;";
    return out;
  };
  globalThis.MathMLAnchorElement = MathMLAnchorElement;
})();
