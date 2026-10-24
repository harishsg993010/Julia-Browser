// Part 14: Permissions Policy: the declared policy from the Permissions-Policy response header,
// container policies from <iframe allow / allowfullscreen / allowpaymentrequest>, inherited
// policies along the frame tree, document.permissionsPolicy and
// iframe.permissionsPolicy (PermissionsPolicy: allowsFeature, features, allowedFeatures,
// getAllowlistForFeature), and __jb.permissionsPolicyAllows(feature) for the APIs it gates.
(function () {
  if (globalThis.__jb_workerRealm) return;
  // Supported features and their default allowlists ("*" or "self").
  var DEFAULTS = {
    accelerometer: "self", "ambient-light-sensor": "self", "attribution-reporting": "*", autoplay: "self", bluetooth: "self", "browsing-topics": "*", camera: "self",
    "captured-surface-control": "self", "ch-ua": "*", "ch-ua-arch": "self", "ch-ua-bitness": "self", "ch-ua-full-version-list": "self", "ch-ua-mobile": "*", "ch-ua-model": "self",
    "ch-ua-platform": "*", "ch-ua-platform-version": "self", "ch-ua-wow64": "self", "clipboard-read": "self", "clipboard-write": "self", "compute-pressure": "self",
    "cross-origin-isolated": "self", "deferred-fetch": "self", "digital-credentials-get": "self", "display-capture": "self", "document-domain": "*", "encrypted-media": "self",
    "execution-while-not-rendered": "*", "execution-while-out-of-viewport": "*", fullscreen: "self", gamepad: "self", geolocation: "self", gyroscope: "self", hid: "self",
    "identity-credentials-get": "self", "idle-detection": "self", "keyboard-map": "self", "local-fonts": "self", magnetometer: "self", microphone: "self", midi: "self",
    "otp-credentials": "self", payment: "self", "picture-in-picture": "*", "private-state-token-issuance": "self", "private-state-token-redemption": "self",
    "publickey-credentials-create": "self", "publickey-credentials-get": "self", "screen-wake-lock": "self", serial: "self", "shared-storage": "*", "shared-storage-select-url": "*",
    "smart-card": "self", "speaker-selection": "self", "storage-access": "*", "sync-xhr": "*", "unload": "*", usb: "self", "web-share": "self", "window-management": "self",
    "xr-spatial-tracking": "self",
  };
  var FEATURES = Object.keys(DEFAULTS).sort();
  var originOf = function (u, base) { try { var x = new URL(u, base); return x.origin; } catch (e) { return null; } };

  // ---- parsing ----
  // Structured-field dictionary: feature=*, feature=self, feature=(), feature=(self "https://a")
  var parseHeader = function (value) {
    var out = Object.create(null);
    if (!value) return out;
    var s = String(value), i = 0, n = s.length;
    var ws = function () { while (i < n && (s[i] === " " || s[i] === "\t")) i++; };
    var parseItem = function () {
      ws();
      if (s[i] === '"') { var j = s.indexOf('"', i + 1); if (j < 0) throw 0; var v = s.slice(i + 1, j); i = j + 1; return { str: v }; }
      var m = /^[A-Za-z*][A-Za-z0-9_\-.:%*\/]*/.exec(s.slice(i));
      if (!m) throw 0;
      i += m[0].length;
      return { tok: m[0] };
    };
    var skipParams = function () { while (s[i] === ";") { i++; var m = /^[a-z*][a-z0-9_\-.*]*/.exec(s.slice(i)); if (!m) throw 0; i += m[0].length; if (s[i] === "=") { i++; parseItem(); } } };
    try {
      while (i < n) {
        ws();
        var km = /^[a-z*][a-z0-9_\-.*]*/.exec(s.slice(i));
        if (!km) throw 0;
        var key = km[0]; i += key.length;
        var items = null;
        if (s[i] === "=") {
          i++;
          if (s[i] === "(") {
            i++; items = [];
            for (;;) { ws(); if (s[i] === ")") { i++; break; } if (i >= n) throw 0; items.push(parseItem()); skipParams(); }
          } else items = [parseItem()];
        } else items = null; // boolean true: not a valid allowlist
        skipParams();
        if (items) {
          var list = { all: false, self: false, origins: [] };
          items.forEach(function (it) {
            if (it.tok === "*") list.all = true;
            else if (it.tok === "self") list.self = true;
            else if (it.str !== undefined) { var o = originOf(it.str); if (o && o !== "null") list.origins.push(o); }
          });
          if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) out[key] = list;
        }
        ws();
        if (i < n) { if (s[i] !== ",") throw 0; i++; }
      }
    } catch (e) { return Object.create(null); } // an unparsable header is ignored
    return out;
  };
  // iframe allow="feature 'src' https://a; other *" (+ allowfullscreen / allowpaymentrequest)
  var parseAllow = function (iframe, parentOrigin, srcOrigin) {
    var out = Object.create(null);
    var attr = iframe.getAttribute("allow") || "";
    attr.split(";").forEach(function (dir) {
      var toks = dir.trim().split(/[\t\n\f\r ]+/).filter(Boolean);
      if (!toks.length) return;
      var feature = toks[0];
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, feature) || out[feature]) return;
      var list = { all: false, self: false, origins: [] }, vals = toks.slice(1);
      if (!vals.length) vals = ["'src'"];
      vals.forEach(function (v) {
        var lv = v.toLowerCase();
        if (v === "*") list.all = true;
        else if (lv === "'self'") { if (parentOrigin) list.origins.push(parentOrigin); }
        else if (lv === "'src'") { if (srcOrigin) list.origins.push(srcOrigin); }
        else if (lv === "'none'") {}
        else { var o = originOf(v); if (o && o !== "null") list.origins.push(o); }
      });
      out[feature] = list;
    });
    if (iframe.hasAttribute("allowfullscreen") && !out.fullscreen) out.fullscreen = { all: true, self: false, origins: [] };
    if (iframe.hasAttribute("allowpaymentrequest") && !out.payment) out.payment = { all: true, self: false, origins: [] };
    return out;
  };
  var matches = function (list, origin, selfOrigin) {
    if (list.all) return true;
    if (!origin || origin === "null") return false;
    if (list.self && origin === selfOrigin) return true;
    return list.origins.indexOf(origin) >= 0;
  };

  // ---- policies ----
  var docOrigin = function (doc) {
    try { var w = doc.defaultView; if (w && typeof w.origin === "string") return w.origin; } catch (e) {}
    try { return new URL(doc.URL).origin; } catch (e2) { return "null"; }
  };
  var headerOf = function (doc) { var h = doc && doc._responseHeaders; if (!h) return ""; return h["permissions-policy"] || h["Permissions-Policy"] || ""; };
  var policyOfDoc = function (doc) {
    if (!doc) return null;
    if (doc._ppCache && doc._ppCache.header === headerOf(doc)) return doc._ppCache;
    var p = { header: headerOf(doc), declared: parseHeader(headerOf(doc)), origin: docOrigin(doc), container: null };
    try { var w = doc.defaultView, fe = w && w.frameElement; if (fe) p.container = fe; } catch (e) { p.container = null; }
    try { if (!p.container && doc.defaultView && doc.defaultView.__jb && doc.defaultView.__jb.frameContext) p.container = doc.defaultView.__jb.frameContext.frameElement || null; } catch (e) {}
    try { Object.defineProperty(doc, "_ppCache", { value: p, writable: true, configurable: true }); } catch (e) {}
    return p;
  };
  // "Is feature enabled in document for origin"
  var enabledInDoc = function (doc, feature, origin) {
    var p = policyOfDoc(doc);
    if (!p) return true;
    if (!inherited(feature, p.container, p.origin)) return false;
    var d = p.declared[feature];
    if (d) return matches(d, origin, p.origin);
    return true;
  };
  // "Define an inherited policy for feature in container at origin"
  var inherited = function (feature, container, origin) {
    if (!container) return true;
    var pdoc = container.ownerDocument;
    var pOrigin = docOrigin(pdoc);
    if (!enabledInDoc(pdoc, feature, pOrigin)) return false;
    if (!enabledInDoc(pdoc, feature, origin)) return false;
    var cp = parseAllow(container, pOrigin, frameSrcOrigin(container, pOrigin));
    if (cp[feature]) return matches(cp[feature], origin, pOrigin);
    if (DEFAULTS[feature] === "*") return true;
    return origin === pOrigin;
  };
  var frameSrcOrigin = function (iframe, pOrigin) {
    var sb = iframe.getAttribute("sandbox");
    if (sb !== null && !/(^|\s)allow-same-origin(\s|$)/i.test(sb)) return "null";
    if (iframe.hasAttribute("srcdoc")) return pOrigin;
    var src = iframe.getAttribute("src");
    if (!src) return pOrigin;
    var o = originOf(src, iframe.ownerDocument.baseURI);
    if (!o || /^(about|data|javascript):/i.test(src.trim())) return /^data:/i.test(src.trim()) ? "null" : pOrigin;
    return o;
  };
  var parseOriginArg = function (origin) { var o = originOf(String(origin)); return o; };

  class PermissionsPolicy {
    constructor() { throw new TypeError("Illegal constructor"); }
    allowsFeature(feature, origin) {
      if (arguments.length < 1) throw new TypeError("PermissionsPolicy.allowsFeature: At least 1 argument required");
      feature = String(feature);
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, feature)) return false;
      var t = this._pp, o;
      if (origin !== undefined) { o = parseOriginArg(origin); if (!o) return false; }
      if (t.doc) return enabledInDoc(t.doc, feature, o === undefined ? docOrigin(t.doc) : o);
      var pOrigin = docOrigin(t.frame.ownerDocument);
      return inherited(feature, t.frame, o === undefined ? frameSrcOrigin(t.frame, pOrigin) : o);
    }
    features() { return FEATURES.slice(); }
    allowedFeatures() { var self_ = this; return FEATURES.filter(function (f) { return self_.allowsFeature(f); }); }
    getAllowlistForFeature(feature) {
      if (arguments.length < 1) throw new TypeError("PermissionsPolicy.getAllowlistForFeature: At least 1 argument required");
      feature = String(feature);
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, feature)) return [];
      var t = this._pp;
      var listOut = function (list, selfOrigin) { if (list.all) return ["*"]; var out = []; if (list.self && selfOrigin) out.push(selfOrigin); list.origins.forEach(function (o) { if (out.indexOf(o) < 0) out.push(o); }); return out; };
      if (t.doc) {
        var p = policyOfDoc(t.doc);
        if (!inherited(feature, p.container, p.origin)) return [];
        if (p.declared[feature]) return listOut(p.declared[feature], p.origin);
        return ["*"];
      }
      var pdoc = t.frame.ownerDocument, pOrigin = docOrigin(pdoc), src = frameSrcOrigin(t.frame, pOrigin);
      if (!inherited(feature, t.frame, src)) return [];
      var cp = parseAllow(t.frame, pOrigin, src);
      if (cp[feature]) return listOut(cp[feature], pOrigin);
      return DEFAULTS[feature] === "*" ? ["*"] : [pOrigin];
    }
  }
  var makePolicy = function (target) { var o = Object.create(PermissionsPolicy.prototype); Object.defineProperty(o, "_pp", { value: target }); return o; };
  var docPolicy = function () { if (!this._ppObj) Object.defineProperty(this, "_ppObj", { value: makePolicy({ doc: this }) }); return this._ppObj; };
  Object.defineProperty(Document.prototype, "permissionsPolicy", { get: docPolicy, enumerable: true, configurable: true });
  if (typeof HTMLIFrameElement === "function") {
    var framePolicy = function () { if (!this._ppObj) Object.defineProperty(this, "_ppObj", { value: makePolicy({ frame: this }) }); return this._ppObj; };
    Object.defineProperty(HTMLIFrameElement.prototype, "permissionsPolicy", { get: framePolicy, enumerable: true, configurable: true });
  }
  // gate used by the platform API modules
  __jb.permissionsPolicyAllows = function (feature, doc) {
    doc = doc || __jb.currentDocument;
    if (!doc || !Object.prototype.hasOwnProperty.call(DEFAULTS, feature)) return true;
    try { return enabledInDoc(doc, feature, docOrigin(doc)); } catch (e) { return true; }
  };
  Object.defineProperty(PermissionsPolicy.prototype, Symbol.toStringTag, { value: "PermissionsPolicy", configurable: true });
  globalThis.PermissionsPolicy = PermissionsPolicy;
})();
