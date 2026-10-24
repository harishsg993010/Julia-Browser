// ---------------------------------------------------------------- Content Security Policy (CSP Level 3)
// Policies come from Content-Security-Policy(-Report-Only) response headers, <meta http-equiv> in
// <head>, or are inherited (about:blank, about:srcdoc, blob: documents and workers). Checks:
// requests (fetch directives, per redirect hop via the host's `x-jb-csp` marker), inline scripts,
// styles, event handler attributes and javascript: URLs (nonces, hashes, 'unsafe-inline',
// 'unsafe-hashes', 'strict-dynamic'), string compilation (the runtime's eval callback calls
// __jb_cspEvalCheck), module graphs (__jb_cspModuleCheck). Violations fire
// securitypolicyviolation events and send report-uri / report-to reports. URL matching against
// source lists is native (src/csp.rs).
(function () {
  var CSP = __jb.csp = {};
  var WS = /[\t\n\f\r ]+/;
  var trimWs = function (s) { return String(s).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ""); };
  var lower = function (s) { return String(s).replace(/[A-Z]/g, function (c) { return c.toLowerCase(); }); };
  CSP.FETCH_DIRECTIVES = ["child-src", "connect-src", "default-src", "font-src", "frame-src", "img-src", "manifest-src", "media-src", "object-src", "script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem", "style-src-attr", "worker-src"];
  var FALLBACK = {
    "script-src-elem": ["script-src-elem", "script-src", "default-src"],
    "script-src-attr": ["script-src-attr", "script-src", "default-src"],
    "style-src-elem": ["style-src-elem", "style-src", "default-src"],
    "style-src-attr": ["style-src-attr", "style-src", "default-src"],
    "worker-src": ["worker-src", "child-src", "script-src", "default-src"],
    "connect-src": ["connect-src", "default-src"],
    "manifest-src": ["manifest-src", "default-src"],
    "object-src": ["object-src", "default-src"],
    "frame-src": ["frame-src", "child-src", "default-src"],
    "media-src": ["media-src", "default-src"],
    "font-src": ["font-src", "default-src"],
    "img-src": ["img-src", "default-src"],
  };
  var SCRIPT_LIKE = { audioworklet: 1, paintworklet: 1, script: 1, serviceworker: 1, sharedworker: 1, worker: 1, xslt: 1 };

  // "parse a serialized CSP"
  CSP.parsePolicy = function (text, source, disposition, selfOrigin) {
    var policy = { directives: Object.create(null), names: [], disposition: disposition, source: source, text: trimWs(text), selfOrigin: selfOrigin };
    String(text).split(";").forEach(function (token) {
      token = trimWs(token);
      if (token === "" || /[^\x00-\x7f]/.test(token)) return;
      var m = /^[^\t\n\f\r ]+/.exec(token);
      var name = lower(m[0]);
      if (!/^[a-z0-9-]+$/.test(name)) return;
      if (policy.directives[name]) return; // duplicates are ignored
      var rest = trimWs(token.slice(m[0].length));
      policy.directives[name] = rest === "" ? [] : rest.split(WS);
      policy.names.push(name);
    });
    return policy;
  };
  // "parse a response's Content Security Policies": comma-separated policies per header.
  CSP.headerPolicies = function (headers, selfOrigin) {
    var out = [];
    if (!headers) return out;
    [["content-security-policy", "enforce"], ["content-security-policy-report-only", "report"]].forEach(function (pair) {
      var v = headers[pair[0]];
      if (v === undefined || v === null) return;
      String(v).split(",").forEach(function (t) {
        var p = CSP.parsePolicy(t, "header", pair[1], selfOrigin);
        if (p.names.length) out.push(p);
      });
    });
    return out;
  };
  // The origin used for 'self' (a URL string; "" for opaque origins).
  CSP.selfOrigin = function () {
    try {
      if (__jb.isWorker && __jb.workerScriptUrl && /^https?:/.test(__jb.workerScriptUrl)) return new URL(__jb.workerScriptUrl).origin + "/";
      if (__jb.inheritedOrigin && typeof __jb.inheritedOrigin === "string" && /^https?:/.test(__jb.inheritedOrigin)) return __jb.inheritedOrigin + "/";
      var o = location.origin;
      if (/^https?:/.test(o)) return o + "/";
      var tj = __jb.topJb && __jb.topJb();
      if (/^about:|^blob:|^data:/.test(location.href) && tj && tj !== __jb) return tj.csp.selfOrigin();
    } catch (e) {}
    return "";
  };
  // The realm's CSP list (cached per document; <meta> policies in <head> are added as they appear).
  __jb.cspPolicies = function () {
    var doc;
    try { doc = __jb.currentDocument; } catch (e) { return []; }
    if (!doc) return [];
    var st = doc._cspState;
    // rebuilt when the document's response headers are (re)assigned after the DOM was built
    if (st && st.headers !== doc._responseHeaders) st = null;
    if (!st) {
      st = { list: [], metas: [], version: -1, fromHeader: false, headers: doc._responseHeaders };
      try { Object.defineProperty(doc, "_cspState", { value: st, writable: true, configurable: true }); } catch (e) { doc._cspState = st; }
      var self = CSP.selfOrigin();
      if (__jb.inheritedCsp) st.list = __jb.inheritedCsp.slice();
      if (__jb.embeddedPolicy) { var ep = CSP.parsePolicy(__jb.embeddedPolicy, "required", "enforce", self); if (ep.names.length) st.list.push(ep); }
      var hp = CSP.headerPolicies(doc._responseHeaders, self);
      if (hp.length) { st.fromHeader = true; st.list = st.list.concat(hp); }
    }
    var ver = __jb.domVersion;
    if (st.version !== ver || ver === undefined) {
      st.version = ver;
      try {
        var head = doc.head;
        if (head) {
          for (var c = head.firstChild; c; c = c.nextSibling) {
            // raw fields first: the brand-checked nodeType getter per head child was a hot spot
            if (c._local !== "meta" || c._ns !== __jb.HTML_NS || c.nodeType !== 1 || st.metas.indexOf(c) >= 0) continue;
            var he = c.getAttribute("http-equiv");
            if (he === null || lower(trimWs(he)) !== "content-security-policy") continue;
            var content = c.getAttribute("content");
            if (content === null) continue;
            st.metas.push(c);
            var p = CSP.parsePolicy(content, "meta", "enforce", CSP.selfOrigin());
            Object.defineProperty(p, "meta", { value: c });
            // report-uri, frame-ancestors and sandbox are not supported in <meta>
            ["report-uri", "frame-ancestors", "sandbox"].forEach(function (n) { if (p.directives[n]) { delete p.directives[n]; p.names.splice(p.names.indexOf(n), 1); } });
            if (p.names.length) st.list.push(p);
          }
        }
      } catch (e) {}
    }
    return st.list;
  };
  // Header-delivered policies only: no <meta> rescan. Called from the connected hook for every
  // inserted element; going through cspPolicies() rescanned <head> after each insertion (the DOM
  // version changes every time), so an Angular list render was quadratic in the head size
  // (Raising Cane's "My Order": 15 s, then the budget kill wedged zone.js for good).
  __jb.cspFromHeader = function () {
    try {
      var doc = __jb.currentDocument, st = doc && doc._cspState;
      if (!st || st.headers !== doc._responseHeaders) { __jb.cspPolicies(); st = doc && doc._cspState; }
      return !!(st && st.fromHeader);
    } catch (e) { return false; }
  };

  // "Get the effective directive for request" (by destination).
  CSP.effectiveDirective = function (dest) {
    switch (dest) {
      case "": case "empty": case "json": case "webidentity": return "connect-src";
      case "manifest": return "manifest-src";
      case "object": case "embed": return "object-src";
      case "frame": case "iframe": return "frame-src";
      case "audio": case "track": case "video": return "media-src";
      case "font": return "font-src";
      case "image": return "img-src";
      case "style": return "style-src-elem";
      case "script": case "xslt": case "audioworklet": case "paintworklet": return "script-src-elem";
      case "serviceworker": case "sharedworker": case "worker": return "worker-src";
      case "report": return null;
      case "prefetch": return "default-src";
      default: return "connect-src";
    }
  };
  // The directive of `policy` that governs `effective` (the first of its fallback list present).
  CSP.governing = function (effective, policy) {
    var list = FALLBACK[effective] || [effective];
    for (var i = 0; i < list.length; i++) if (policy.directives[list[i]]) return list[i];
    return null;
  };
  var has = function (list, kw) { for (var i = 0; i < list.length; i++) if (lower(list[i]) === kw) return true; return false; };
  CSP.has = has;
  var NONCE = /^'nonce-([A-Za-z0-9+\/\-_]+={0,2})'$/i;
  var HASH = /^'(sha256|sha384|sha512)-([A-Za-z0-9+\/\-_]+={0,2})'$/i;
  // Native source-list URL matching.
  CSP.urlMatches = function (list, url, self, redirected) {
    var r = __jb.native("csp", { op: "matchUrl", list: list, url: String(url), self: self || "", redirected: !!redirected });
    return r === true;
  };
  // "script directives pre-request check" for one directive value.
  var scriptRequestAllowed = function (value, url, policy, opts) {
    if (opts.nonce) for (var i = 0; i < value.length; i++) { var m = NONCE.exec(value[i]); if (m && m[1] === opts.nonce) return true; }
    var hashes = value.filter(function (v) { return HASH.test(v); }).map(function (v) { var m = HASH.exec(v); return lower(m[1]) + "-" + m[2]; });
    if (hashes.length && opts.integrity) {
      var items = String(opts.integrity).split(WS).filter(Boolean).map(function (t) { var q = t.indexOf("?"); if (q >= 0) t = t.slice(0, q); var d = t.indexOf("-"); return d < 0 ? "" : lower(t.slice(0, d)) + t.slice(d); }).filter(Boolean);
      if (items.length && items.every(function (it) { return hashes.indexOf(it) >= 0; })) return true;
    }
    if (has(value, "'strict-dynamic'")) return opts.parser !== "parser-inserted";
    return CSP.urlMatches(value, url, policy.selfOrigin, opts.redirected);
  };
  var requestAllowedBy = function (effective, value, url, policy, opts) {
    if (SCRIPT_LIKE[opts.dest] && (effective === "script-src-elem" || effective === "worker-src")) return scriptRequestAllowed(value, url, policy, opts);
    // style requests honour nonces too
    if (opts.dest === "style" && opts.nonce) for (var i = 0; i < value.length; i++) { var m = NONCE.exec(value[i]); if (m && m[1] === opts.nonce) return true; }
    return CSP.urlMatches(value, url, policy.selfOrigin, opts.redirected);
  };
  // Should the request be blocked? Reports violations (unless opts.silent); true = allowed.
  // opts: {element, nonce, integrity, parser ("parser-inserted" or ""), redirected, originalUrl, policies}
  // A <meta> policy applies to parser-inserted elements only from the meta onwards.
  CSP.applies = function (p, opts) {
    if (!p.meta || !opts || !opts.element || opts.parser !== "parser-inserted") return true;
    try { return !(opts.element.compareDocumentPosition(p.meta) & 4); } catch (e) { return true; }
  };
  CSP.allowsRequest = function (dest, url, opts) {
    opts = opts || {};
    opts.dest = dest;
    var list = (opts.policies || __jb.cspPolicies()).filter(function (p) { return CSP.applies(p, opts); });
    if (!list.length) return true;
    var eff = CSP.effectiveDirective(dest);
    if (!eff) return true;
    var allowed = true;
    list.forEach(function (p) {
      var name = CSP.governing(eff, p);
      if (!name) return;
      if (requestAllowedBy(eff, p.directives[name], url, p, opts)) return;
      if (!opts.silent) CSP.violation({ policy: p, effective: eff, resource: opts.originalUrl || url, element: opts.element, owner: opts.owner });
      if (p.disposition === "enforce") allowed = false;
    });
    return allowed;
  };
  // Source lists every redirect target of a request must match (for the host's per-hop check), or
  // null when nothing restricts redirects.
  CSP.redirectLists = function (dest, opts) {
    var list = __jb.cspPolicies();
    if (!list.length) return null;
    var eff = CSP.effectiveDirective(dest);
    if (!eff) return null;
    var out = [];
    list.forEach(function (p) {
      if (p.disposition !== "enforce") return;
      var name = CSP.governing(eff, p);
      if (!name) return;
      var value = p.directives[name];
      if (SCRIPT_LIKE[dest] && (has(value, "'strict-dynamic'") || (opts && opts.nonce && value.some(function (v) { var m = NONCE.exec(v); return m && m[1] === opts.nonce; })))) return;
      out.push([p.selfOrigin || "", value]);
    });
    return out.length ? out : null;
  };
  // A redirect hop the host refused (`CSP blocked redirect to <url>`): report it like a blocked request.
  CSP.reportBlockedRedirect = function (dest, originalUrl, statusText, opts) {
    var m = /CSP blocked redirect to (\S+)/.exec(String(statusText || ""));
    if (!m) return false;
    var o = Object.assign({}, opts || {}, { redirected: true, originalUrl: originalUrl });
    CSP.allowsRequest(dest, m[1], o);
    return true;
  };

  // ---- inline content ----
  // "Is element nonceable?"
  CSP.nonceable = function (el) {
    if (!el || !el.hasAttribute || !el.hasAttribute("nonce")) return false;
    if (el._local === "script") {
      var attrs = el.attributes;
      for (var i = 0; i < attrs.length; i++) {
        var n = lower(attrs[i].name), v = lower(attrs[i].value);
        if (n.indexOf("<script") >= 0 || n.indexOf("<style") >= 0 || v.indexOf("<script") >= 0 || v.indexOf("<style") >= 0) return false;
      }
    }
    if (el._dupAttr) return false;
    return true;
  };
  CSP.allowsAllInline = function (list, type) {
    var all = false;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (NONCE.test(e) || HASH.test(e)) return false;
      if ((type === "script" || type === "script attribute" || type === "navigation") && lower(e) === "'strict-dynamic'") return false;
      if (lower(e) === "'unsafe-inline'") all = true;
    }
    return all;
  };
  var hashCache = Object.create(null);
  CSP.digest = function (alg, text) {
    var key = alg + "|" + text;
    if (hashCache[key]) return hashCache[key];
    var bytes = new TextEncoder().encode(String(text));
    var r = __jb.native("crypto", { op: "digest", algorithm: alg, data: __jb.bytesToB64(bytes) });
    var out = r && r.bytes ? r.bytes : "";
    if (Object.keys(hashCache).length > 500) hashCache = Object.create(null);
    hashCache[key] = out;
    return out;
  };
  // "Does element match source list for type and source?"
  CSP.elementMatches = function (el, list, type, source) {
    if (CSP.allowsAllInline(list, type)) return true;
    if ((type === "script" || type === "style") && CSP.nonceable(el)) {
      var nonce = __jb.elementNonce(el);
      for (var i = 0; i < list.length; i++) { var m = NONCE.exec(list[i]); if (m && nonce !== "" && m[1] === nonce) return true; }
    }
    var unsafeHashes = has(list, "'unsafe-hashes'");
    if (type === "script" || type === "style" || unsafeHashes) {
      for (var j = 0; j < list.length; j++) {
        var h = HASH.exec(list[j]);
        if (!h) continue;
        var alg = { sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" }[lower(h[1])];
        var expected = h[2].replace(/-/g, "+").replace(/_/g, "/");
        if (CSP.digest(alg, source) === expected) return true;
      }
    }
    return false;
  };
  var INLINE_DIRECTIVE = { script: "script-src-elem", "script attribute": "script-src-attr", style: "style-src-elem", "style attribute": "style-src-attr", navigation: "script-src-elem" };
  // Should the inline behavior of `type` be blocked? true = allowed (violations reported).
  CSP.allowsInline = function (type, el, source, opts) {
    opts = opts || {};
    var list = (opts.policies || __jb.cspPolicies()).filter(function (p) { return CSP.applies(p, { element: el, parser: opts.parser }); });
    if (!list.length) return true;
    var eff = INLINE_DIRECTIVE[type];
    var allowed = true;
    list.forEach(function (p) {
      var name = CSP.governing(eff, p);
      if (!name) return;
      var value = p.directives[name];
      if (CSP.elementMatches(el, value, type, source)) return;
      var sample = has(value, "'report-sample'") ? String(source).slice(0, 40) : "";
      CSP.violation({ policy: p, effective: eff, resource: "inline", element: type === "navigation" ? null : el, sample: sample, owner: opts.owner, sourceFile: opts.sourceFile, line: opts.line, column: opts.column });
      if (p.disposition === "enforce") allowed = false;
    });
    return allowed;
  };
  // String compilation (eval, Function, string timers, WebAssembly): called by the runtime.
  __jb.cspBypass = 0;
  CSP.trusted = function (fn) { __jb.cspBypass++; try { return fn(); } finally { __jb.cspBypass--; } };
  globalThis.__jb_cspEvalCheck = function (kind, code, compilation, bodyArg, bodyStr, paramsTrusted) {
    if (__jb.cspBypass > 0) return true;
    var list = __jb.cspPolicies();
    if (!list.length) return true;
    // Trusted Types first: an untrusted source must pass the default policy unchanged
    var tt = __jb.tt, ttOk = false;
    if (tt && kind !== "wasm") {
      var trusted = tt.is(bodyArg, tt.TYPES.TrustedScript) && tt.data(bodyArg) === (compilation === "Function" ? bodyStr : code) && paramsTrusted !== false;
      if (!tt.compileCheck(kind, code, compilation, trusted)) return false;
      ttOk = trusted || tt.required(true);
    }
    __jb.ttCompileOk = ttOk;
    var allowed = true;
    list.forEach(function (p) {
      var value = p.directives["script-src"] || p.directives["default-src"];
      if (!value) return;
      if (has(value, "'unsafe-eval'") || (kind === "wasm" && has(value, "'wasm-unsafe-eval'"))) return;
      if (kind !== "wasm" && has(value, "'trusted-types-eval'") && typeof __jb.ttEvalAllowed === "function" && __jb.ttEvalAllowed() && __jb.ttCompileOk) return;
      var sample = has(value, "'report-sample'") ? String(code === undefined || code === null ? "" : code).slice(0, 40) : "";
      CSP.violation({ policy: p, effective: "script-src", resource: kind === "wasm" ? "wasm-eval" : "eval", sample: sample });
      if (p.disposition === "enforce") allowed = false;
    });
    return allowed;
  };
  // Module graph fetches: script-src-elem with the root script's nonce / parser state.
  globalThis.__jb_cspModuleCheck = function (url, importNonce) {
    if (__jb.workerGraphLoading && __jb.workerOwnerJb && __jb.workerOwnerJb !== __jb) {
      var ow = __jb.workerOwnerJb;
      if (ow.mixed && ow.mixed.blocks("script", url)) return false;
      return !ow.cspPolicies().length || ow.csp.allowsRequest("script", url, { nonce: "", parser: "" });
    }
    if (__jb.mixed && __jb.mixed.blocks("script", url)) return false;
    if (!__jb.cspPolicies().length) return true;
    var o = typeof importNonce === "string" ? { nonce: importNonce, parser: "" } : (__jb.cspModuleOptions || {});
    return CSP.allowsRequest(__jb.isWorker && !o.fromElement ? "script" : "script", url, { nonce: o.nonce || "", parser: o.parser || "", element: o.element || null });
  };

  // ---- violations and reports ----
  // "strip URL for use in reports"
  CSP.stripForReport = function (u) {
    try {
      var url = new URL(u);
      if (!/^https?:$/.test(url.protocol)) return url.protocol.slice(0, -1);
      url.hash = ""; url.username = ""; url.password = "";
      return url.href;
    } catch (e) { return String(u); }
  };
  // Where the violation happened: the first stack frame outside the environment.
  CSP.sourceLocation = function () {
    var st = "";
    try { throw new Error(); } catch (e) { st = String(e.stack || ""); }
    var lines = st.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!l || l.indexOf("browser_env.js") >= 0 || l.indexOf("csp-hook") >= 0) continue;
      var m = /@(.*):(\d+):(\d+)$/.exec(l);
      if (m) return { file: m[1], line: +m[2], column: +m[3] };
    }
    return null;
  };
  CSP.documentUrl = function () {
    try { return __jb.isWorker && __jb.workerScriptUrl ? __jb.workerScriptUrl : __jb.currentDocument.URL; } catch (e) { return ""; }
  };
  CSP.violation = function (v) {
    var p = v.policy;
    var docUrl = CSP.documentUrl();
    var blocked = v.resource === "inline" || v.resource === "eval" || v.resource === "wasm-eval" || v.resource === "trusted-types-policy" || v.resource === "trusted-types-sink" ? v.resource : CSP.stripForReport(v.resource);
    var loc = v.sourceFile !== undefined ? { file: v.sourceFile, line: v.line || 0, column: v.column || 0 } : CSP.sourceLocation();
    var init = {
      documentURI: CSP.stripForReport(docUrl),
      referrer: (function () { try { return __jb.currentDocument.referrer || ""; } catch (e) { return ""; } })(),
      blockedURI: blocked,
      violatedDirective: v.effective,
      effectiveDirective: v.effective,
      originalPolicy: p.text,
      sourceFile: loc && loc.file ? CSP.stripForReport(loc.file) : "",
      sample: v.sample || "",
      disposition: p.disposition === "enforce" ? "enforce" : "report",
      statusCode: (function () { try { return /^https?:/.test(docUrl) ? (__jb.currentDocument._statusCode || 200) : 0; } catch (e) { return 0; } })(),
      lineNumber: loc ? loc.line : 0,
      columnNumber: loc ? loc.column : 0,
      bubbles: true, composed: true,
    };
    var target = v.element || null;
    var owner = v.owner || __jb.cspOwnerWindow || globalThis;
    // Reports go out at once: requests here are synchronous, and a page polling its report
    // collector in an earlier task would otherwise block until the poll times out.
    try { CSP.sendReports(p, init, owner); } catch (e4) {}
    owner.setTimeout(function () {
      var t = target;
      try { if (t && (!t.isConnected || t.getRootNode({ composed: true }) !== owner.document)) t = null; } catch (e) { t = null; }
      if (!t) { try { t = owner.__jb && owner.__jb.isWorker ? owner : owner.document; } catch (e2) { t = owner.document; } }
      try {
        var ev = new owner.SecurityPolicyViolationEvent("securitypolicyviolation", init);
        __jb.setTrusted(ev, true); ev._trustedDispatch = true;
        t.dispatchEvent(ev);
      } catch (e3) {}
    }, 0);
  };
  // Reporting endpoints of the document: Reporting-Endpoints (structured dictionary) and the legacy
  // Report-To header (JSON groups).
  CSP.endpoints = function (headers) {
    var out = Object.create(null), h = {};
    try { h = headers || __jb.currentDocument._responseHeaders || {}; } catch (e) {}
    var re = h["reporting-endpoints"];
    if (re) String(re).split(",").forEach(function (part) {
      var m = /^\s*([A-Za-z*][A-Za-z0-9_\-.*]*)\s*=\s*"([^"]*)"/.exec(part);
      if (m) { try { out[m[1]] = new URL(m[2], CSP.documentUrl()).href; } catch (e) {} }
    });
    var rt = h["report-to"];
    if (rt) {
      try {
        var groups = JSON.parse("[" + String(rt) + "]");
        groups.forEach(function (g) { var name = g.group || "default"; if (out[name] === undefined && g.endpoints && g.endpoints[0] && g.endpoints[0].url) { try { out[name] = new URL(g.endpoints[0].url, CSP.documentUrl()).href; } catch (e) {} } });
      } catch (e) {}
    }
    return out;
  };
  CSP.post = function (url, contentType, body) {
    var same = false;
    try { same = new URL(url).origin === new URL(CSP.documentUrl()).origin; } catch (e) {}
    try { __jb.native("fetch", { url: url, method: "POST", headers: { "Content-Type": contentType }, body: body, mode: "no-cors", dest: "report", credentials: same, referrer: "", referrerPolicy: "no-referrer" }); } catch (e) {}
  };
  CSP.sendReportsFor = function (p, init, headers) { CSP.sendReports(p, init, null, headers); };
  CSP.sendReports = function (p, init, owner, headers) {
    var body = {
      documentURL: init.documentURI, referrer: init.referrer, blockedURL: init.blockedURI, effectiveDirective: init.effectiveDirective,
      originalPolicy: init.originalPolicy, sourceFile: init.sourceFile || null, sample: init.sample, disposition: init.disposition,
      statusCode: init.statusCode, lineNumber: init.lineNumber || null, columnNumber: init.columnNumber || null,
    };
    if (owner && typeof __jb.queueReport === "function") __jb.queueReport("csp-violation", init.documentURI, body, owner);
    var rt = p.directives["report-to"];
    if (rt && rt.length) {
      var ep = CSP.endpoints(headers)[rt[0]];
      if (ep) CSP.post(ep, "application/reports+json", JSON.stringify([{ type: "csp-violation", age: 0, url: init.documentURI, user_agent: navigator.userAgent, body: body }]));
      return;
    }
    var ru = p.directives["report-uri"];
    if (!ru) return;
    var report = { "csp-report": {
      "document-uri": init.documentURI, referrer: init.referrer, "violated-directive": init.violatedDirective, "effective-directive": init.effectiveDirective,
      "original-policy": init.originalPolicy, disposition: init.disposition, "blocked-uri": init.blockedURI, "line-number": init.lineNumber,
      "column-number": init.columnNumber, "source-file": init.sourceFile, "status-code": init.statusCode, "script-sample": init.sample,
    } };
    ru.forEach(function (u) { var abs; try { abs = new URL(u, CSP.documentUrl()).href; } catch (e) { return; } CSP.post(abs, "application/csp-report", JSON.stringify(report)); });
  };

  // ---- script elements ----
  // Inline (url null) or external script `el`: may it run / be fetched? Module scripts record the
  // options their graph's fetches use (the module loader checks each URL).
  __jb.cspScriptVerdict = function (el, url, parser, isModule, redirected, originalUrl, preparedText) {
    if (url !== null && url !== undefined && !isModule && __jb.mixed && __jb.mixed.blocks("script", url)) return false;
    if (!__jb.cspPolicies().length) return true;
    // the WPT runner's own inlined harness scripts
    if (el && el.hasAttribute && el.hasAttribute("jb-runner") && __jb.topJb().wptMode) return true;
    if (el && el._fromWrite) parser = "parser-inserted";
    var inlineText = typeof preparedText === "string" ? preparedText : el ? (__jb.childTextContent ? __jb.childTextContent(el) : el.textContent) : "";
    if ((url === null || url === undefined) && __jb.tt && el) { try { __jb.tt.scriptText(el, inlineText, parser); } catch (ett) { return false; } }
    if (url === null || url === undefined) {
      var ok = CSP.allowsInline("script", el, inlineText, { parser: parser });
      if (ok && isModule) __jb.cspModuleOptions = { nonce: __jb.elementNonce(el), parser: parser, element: el, fromElement: true };
      return ok;
    }
    if (isModule) { __jb.cspModuleOptions = { nonce: __jb.elementNonce(el), parser: el && el._fromWrite ? "parser-inserted" : parser, element: el, fromElement: true }; return true; }
    if (el && el._fromWrite) parser = "parser-inserted";
    if (M.blocks("script", url)) return false;
    return CSP.allowsRequest("script", url, { element: el, nonce: __jb.elementNonce(el), integrity: el && el.getAttribute ? el.getAttribute("integrity") : "", parser: parser, redirected: !!redirected, originalUrl: originalUrl });
  };
  // Event handler content attributes (script-src-attr).
  CSP.allowsHandler = function (el, code) {
    if (!__jb.cspPolicies().length) return true;
    return CSP.allowsInline("script attribute", el, code);
  };
  // javascript: URL navigations, checked against the initiating realm's policies.
  CSP.allowsJavascriptUrl = function (url) {
    if (!__jb.cspPolicies().length) return true;
    return CSP.allowsInline("navigation", null, String(url));
  };

  // form-action (no fallback): may `form` submit to `url`?
  CSP.allowsFormAction = function (form, url) {
    var list = __jb.cspPolicies();
    var ok = true;
    list.forEach(function (p) {
      var v = p.directives["form-action"];
      if (!v || CSP.urlMatches(v, url, p.selfOrigin, false)) return;
      CSP.violation({ policy: p, effective: "form-action", resource: url, element: form });
      if (p.disposition === "enforce") ok = false;
    });
    return ok;
  };
  // base-uri: is <base href> allowed (checked once per element and URL)?
  __jb.baseAllowed = function (b, href) {
    try { if (!b || b.ownerDocument !== __jb.currentDocument || !__jb.cspPolicies().length) return true; } catch (e) { return true; }
    if (b._cspBaseHref === href) return b._cspBaseOk;
    b._cspBaseHref = href;
    var ok = true;
    __jb.cspPolicies().forEach(function (p) {
      var v = p.directives["base-uri"];
      if (!v || CSP.urlMatches(v, href, p.selfOrigin, false)) return;
      CSP.violation({ policy: p, effective: "base-uri", resource: href, element: b });
      if (p.disposition === "enforce") ok = false;
    });
    b._cspBaseOk = ok;
    return ok;
  };
  // frame-ancestors of a document about to be shown in `iframe` (header policies of its response):
  // every ancestor's origin must match. Returns false when the document is blocked.
  CSP.frameAncestorsAllow = function (source, iframe) {
    if (!source || !source.headers || !/^https?:/.test(source.url || "")) return true;
    var self; try { self = new URL(source.url).origin + "/"; } catch (e) { return true; }
    var policies = CSP.headerPolicies(source.headers, self).filter(function (p) { return p.directives["frame-ancestors"]; });
    if (!policies.length) return true;
    // ancestors: the iframe's document's window, then up to the top
    var origins = [], w = globalThis, guard = 0;
    while (w && guard++ < 20) {
      var o = "null";
      try { o = w.__jb && w.__jb.opaqueOrigin ? "null" : w.location.origin; } catch (e) { o = "null"; }
      origins.push(o);
      var fc = null; try { fc = w.__jb && w.__jb.frameContext; } catch (e2) { fc = null; }
      w = fc && fc.parent && fc.parent !== w ? fc.parent : null;
    }
    var allowed = true;
    policies.forEach(function (p) {
      var v = p.directives["frame-ancestors"];
      var ok = origins.every(function (o) { return o !== "null" && CSP.urlMatches(v, o + "/", p.selfOrigin, false); });
      if (ok) return;
      // reported through the framed document's policy (no event in the embedding document)
      var init = { documentURI: CSP.stripForReport(source.url), referrer: "", blockedURI: origins.length ? origins[0] : "", violatedDirective: "frame-ancestors", effectiveDirective: "frame-ancestors", originalPolicy: p.text, sourceFile: "", sample: "", disposition: p.disposition === "enforce" ? "enforce" : "report", statusCode: 200, lineNumber: 0, columnNumber: 0 };
      var saved = CSP.documentUrl;
      try { CSP.documentUrl = function () { return source.url; }; CSP.sendReportsFor(p, init, source.headers); } finally { CSP.documentUrl = saved; }
      if (p.disposition === "enforce") allowed = false;
    });
    return allowed;
  };

  // ---- CSP Embedded Enforcement (the <iframe csp> attribute) ----
  // An iframe's required CSP (its csp attribute, cascaded with the embedder's own required CSP) is
  // sent as Sec-Required-CSP; the response must carry Allow-CSP-From matching the embedder (the
  // required policy is then enforced in it) or policies that subsume the required one, otherwise
  // the frame shows a cross-origin error document.
  CSP.validRequiredCsp = function (value) {
    var v = String(value);
    if (v === "" || v.length > 4096 || v.indexOf(",") >= 0 || /[^\x20-\x7e\t]/.test(v)) return false;
    var ok = true, any = false;
    v.split(";").forEach(function (token) {
      token = trimWs(token);
      if (token === "") return;
      var name = lower(/^[^\t\n\f\r ]+/.exec(token)[0]);
      if (!/^[a-z0-9-]+$/.test(name) || name === "report-uri" || name === "report-to") ok = false;
      any = true;
    });
    return ok && any;
  };
  CSP.requiredCspFor = function (iframe) {
    var parentReq = __jb.requiredCsp || null;
    var attr = iframe.getAttribute("csp");
    if (attr === null || attr === "" || !CSP.validRequiredCsp(attr)) return parentReq;
    if (parentReq === null) return attr;
    var self = CSP.selfOrigin();
    var a = CSP.parsePolicy(attr, "attr", "enforce", self), p = CSP.parsePolicy(parentReq, "attr", "enforce", self);
    return CSP.subsumes([a], p) ? attr : parentReq;
  };
  // ---- subsumption ----
  var KEYWORD = /^'[^']*'$/;
  // A source expression as a URL pattern {schemes: [...] | null (= self scheme), host, port, path}
  // (null for keywords, nonces and hashes).
  var pattern = function (expr, self) {
    var e = lower(expr);
    var su = null; try { su = self ? new URL(self) : null; } catch (x) { su = null; }
    if (e === "'self'") {
      if (!su) return { none: true };
      return { schemes: su.protocol === "http:" ? ["http", "https"] : [su.protocol.slice(0, -1)], host: su.hostname, port: su.port || "", path: "", exactHost: true };
    }
    if (KEYWORD.test(e)) return null;
    if (e === "*") return { schemes: ["http", "https", "ws", "wss", "ftp"].concat(su ? [su.protocol.slice(0, -1)] : []), host: "*", port: "*", path: "" };
    var m = /^([a-z][a-z0-9+\-.]*):$/.exec(e);
    if (m) {
      var sc = m[1];
      return { schemes: sc === "http" ? ["http", "https"] : sc === "ws" ? ["ws", "wss", "http", "https"] : sc === "wss" ? ["wss", "https"] : [sc], host: "*", port: "*", path: "", schemeOnly: true };
    }
    var hm = /^(?:([a-z][a-z0-9+\-.]*):\/\/)?((?:\*\.)?[a-z0-9\-]+(?:\.[a-z0-9\-]+)*\.?|\*)(?::(\*|[0-9]+))?(\/[^?#]*)?$/.exec(e);
    if (!hm) return { none: true };
    var scheme = hm[1] || null;
    var schemes = scheme ? (scheme === "http" ? ["http", "https"] : scheme === "ws" ? ["ws", "wss"] : [scheme]) : (su ? (su.protocol === "http:" ? ["http", "https"] : [su.protocol.slice(0, -1)]) : ["https"]);
    return { schemes: schemes, host: hm[2].replace(/\.$/, ""), port: hm[3] === undefined ? "" : hm[3], path: hm[4] || "", declared: scheme };
  };
  var hostCovers = function (r, e) {
    if (r === "*") return true;
    if (e === "*") return false;
    if (r.indexOf("*.") === 0) {
      var suffix = r.slice(1);
      if (e.indexOf("*.") === 0) return e.slice(1).length >= suffix.length && e.slice(1).slice(-suffix.length) === suffix;
      return e.length > suffix.length && e.slice(-suffix.length) === suffix;
    }
    return r === e;
  };
  var DEFAULT_PORTS = { http: "80", https: "443", ws: "80", wss: "443", ftp: "21" };
  // the port a pattern states (or its scheme's default); "*" for any
  var isDefaultPort = function (p) { var sc = p.declared || p.schemes[0]; return p.port === "" || p.port === DEFAULT_PORTS[sc]; };
  var portCovers = function (r, e) {
    if (r.port === "*") return true;
    if (e.port === "*") return false;
    if (isDefaultPort(r) && isDefaultPort(e)) return true;
    return r.port !== "" && r.port === e.port;
  };
  var pathCovers = function (r, e) {
    if (r === "" || r === "/") return true;
    if (e === "") return false;
    if (r.slice(-1) === "/") return e.indexOf(r) === 0;
    return r === e;
  };
  // Does pattern r allow every URL pattern e allows?
  var patternCovers = function (r, e) {
    if (!r || !e || r.none) return false;
    if (e.none) return true;
    if (!e.schemes.every(function (s) { return r.schemes.indexOf(s) >= 0; })) return false;
    if (r.schemeOnly) return true;
    if (e.schemeOnly) return false;
    if (!hostCovers(r.host, e.host)) return false;
    if (!portCovers(r, e)) return false;
    return pathCovers(r.path, e.path);
  };
  var patternsOverlap = function (a, b) {
    if (!a || !b || a.none || b.none) return false;
    if (!a.schemes.some(function (s) { return b.schemes.indexOf(s) >= 0; })) return false;
    if (a.schemeOnly || b.schemeOnly) return true;
    if (!(hostCovers(a.host, b.host) || hostCovers(b.host, a.host))) return false;
    if (a.port !== "*" && b.port !== "*" && !(isDefaultPort(a) && isDefaultPort(b)) && a.port !== b.port) return false;
    return pathCovers(a.path, b.path) || pathCovers(b.path, a.path);
  };
  var keywordsOf = function (list) { return list.map(lower); };
  var isNoneList = function (list) { var items = list.filter(function (x) { return x !== ""; }); return items.length === 0 || (items.length === 1 && lower(items[0]) === "'none'"); };
  // The intersection of two URL patterns (null when they share no URL).
  var intersectPatterns = function (a, b) {
    if (!a || !b || a.none || b.none) return null;
    var schemes = a.schemes.filter(function (x) { return b.schemes.indexOf(x) >= 0; });
    if (!schemes.length) return null;
    if (a.schemeOnly && b.schemeOnly) return { schemes: schemes, host: "*", port: "*", path: "", schemeOnly: true };
    if (a.schemeOnly) return Object.assign({}, b, { schemes: schemes });
    if (b.schemeOnly) return Object.assign({}, a, { schemes: schemes });
    var host = hostCovers(a.host, b.host) ? b.host : hostCovers(b.host, a.host) ? a.host : null;
    if (host === null) return null;
    var port;
    if (a.port === "*") port = b.port; else if (b.port === "*") port = a.port;
    else if (isDefaultPort(a) && isDefaultPort(b)) port = "";
    else if (a.port === b.port) port = a.port; else return null;
    var path = pathCovers(a.path, b.path) ? b.path : pathCovers(b.path, a.path) ? a.path : null;
    if (path === null) return null;
    return { schemes: schemes, host: host, port: port, path: path };
  };
  var hasNonceSrc = function (l) { return l.some(function (x) { return NONCE.test(x); }); };
  // Does the intersection of `lists` (returned policies) allow nothing more than `required` does?
  // The effective returned list keeps the keywords, nonces and hashes every list has, and the
  // pairwise intersections of their URL expressions.
  CSP.sourceListSubsumes = function (required, lists, directive, self) {
    if (!lists.length) return false;
    if (lists.some(isNoneList)) return true;
    var script = /^script-src/.test(directive) || directive === "default-src" || directive === "worker-src";
    var style = /^style-src/.test(directive) || directive === "default-src";
    var inAll = function (tok) { return lists.every(function (l) { return l.some(function (x) { return lower(x) === lower(tok); }); }); };
    var tokens = [];
    lists[0].forEach(function (x) { if ((KEYWORD.test(x) || NONCE.test(x) || HASH.test(x)) && lower(x) !== "'none'" && inAll(x)) tokens.push(x); });
    var kw = tokens.map(lower);
    var nonces = tokens.filter(function (x) { return NONCE.test(x); }), hashes = tokens.filter(function (x) { return HASH.test(x); });
    var rk = keywordsOf(required);
    var reqHas = function (k) { return rk.indexOf(k) >= 0; };
    if (kw.indexOf("'unsafe-eval'") >= 0 && !reqHas("'unsafe-eval'")) return false;
    if (kw.indexOf("'unsafe-hashes'") >= 0 && !reqHas("'unsafe-hashes'")) return false;
    if (kw.indexOf("'unsafe-hashed-attributes'") >= 0 && !reqHas("'unsafe-hashed-attributes'") && !reqHas("'unsafe-hashes'")) return false;
    if (kw.indexOf("'wasm-unsafe-eval'") >= 0 && !reqHas("'wasm-unsafe-eval'") && !reqHas("'unsafe-eval'")) return false;
    var strictDynamic = script && kw.indexOf("'strict-dynamic'") >= 0;
    if (strictDynamic && !reqHas("'strict-dynamic'")) return false;
    if (script || style) {
      var type = script ? "script" : "style";
      if (lists.every(function (l) { return CSP.allowsAllInline(l, type); }) && !CSP.allowsAllInline(required, type)) return false;
      if (nonces.length && !hasNonceSrc(required)) return false;
      for (var h = 0; h < hashes.length; h++) if (required.indexOf(hashes[h]) < 0) return false;
    }
    // URL sources (with 'strict-dynamic' in every script list, URL expressions do not apply)
    if (strictDynamic) return true;
    var urlExprs = function (l) { return l.filter(function (x) { return x !== "" && (!KEYWORD.test(x) || lower(x) === "'self'"); }).map(function (x) { return pattern(x, self); }).filter(Boolean); };
    var reqPatterns = isNoneList(required) ? [] : urlExprs(required);
    var effective = null;
    lists.forEach(function (l) {
      var ps = urlExprs(l);
      if (effective === null) { effective = ps; return; }
      var next = [];
      effective.forEach(function (x) { ps.forEach(function (y) { var z = intersectPatterns(x, y); if (z) next.push(z); }); });
      effective = next;
    });
    // each scheme of an effective expression must be covered by some required expression
    return (effective || []).every(function (e) {
      if (e.none) return true;
      return e.schemes.every(function (sc) { var one = Object.assign({}, e, { schemes: [sc] }); return reqPatterns.some(function (r) { return patternCovers(r, one); }); });
    });
  };
  // Do the (enforced) `policies` subsume `required`?
  CSP.subsumes = function (policies, required) {
    var enforced = policies.filter(function (p) { return p.disposition === "enforce"; });
    var self = required.selfOrigin;
    var names = required.names;
    for (var i = 0; i < names.length; i++) {
      var d = names[i];
      if (d === "default-src") {
        // every fetch directive the required default-src governs
        var ok = CSP.FETCH_DIRECTIVES.every(function (fd) {
          var eff = fd;
          if (required.directives[eff] && eff !== "default-src") return true; // checked on its own
          var lists = enforced.map(function (p) { var g = CSP.governing(eff, p); return g ? p.directives[g] : null; }).filter(Boolean);
          return CSP.sourceListSubsumes(required.directives["default-src"], lists, eff, self);
        });
        if (!ok) return false;
      } else if (CSP.FETCH_DIRECTIVES.indexOf(d) >= 0) {
        var lists2 = enforced.map(function (p) { var g = CSP.governing(d, p); return g ? p.directives[g] : null; }).filter(Boolean);
        if (!CSP.sourceListSubsumes(required.directives[d], lists2, d, self)) return false;
      } else if (d === "base-uri" || d === "form-action" || d === "frame-ancestors" || d === "navigate-to") {
        var lists3 = enforced.map(function (p) { return p.directives[d] || null; }).filter(Boolean);
        if (!CSP.sourceListSubsumes(required.directives[d], lists3, d, self)) return false;
      } else if (d === "upgrade-insecure-requests" || d === "block-all-mixed-content") {
        if (!enforced.some(function (p) { return p.directives[d] !== undefined; })) return false;
      }
    }
    return true;
  };
  // "Is response to request allowed by CSP Embedded Enforcement?" for a frame document `source`
  // fetched with `required`; returns false when the frame must show an error document.
  CSP.embeddedAllows = function (source, required) {
    if (required === null || required === undefined) return true;
    var u = source.url || "";
    if (!/^https?:/i.test(u)) return true; // local schemes inherit the required policy
    var h = source.headers || {};
    var acf = h["allow-csp-from"];
    if (acf !== undefined && acf !== null) {
      var v = trimWs(acf);
      if (v === "*") return "allow";
      try { if (new URL(v).origin === location.origin) return "allow"; } catch (e) {}
    }
    var self; try { self = new URL(u).origin + "/"; } catch (e2) { return false; }
    var req = CSP.parsePolicy(required, "required", "enforce", self);
    return CSP.subsumes(CSP.headerPolicies(h, self), req);
  };

  if (typeof HTMLIFrameElement === "function") Object.defineProperty(HTMLIFrameElement.prototype, "csp", { get: function () { var v = this.getAttribute("csp"); return v === null ? "" : v; }, set: function (v) { this.setAttribute("csp", String(v)); }, enumerable: true, configurable: true });
  // Navigation request headers for the next frame fetch (Sec-Required-CSP).
  __jb.takeNavigationHeaders = function () { var tj = __jb.topJb(), h = tj.pendingNavHeaders; tj.pendingNavHeaders = undefined; return h; };

  // ---- nonces: the element's [[CryptographicNonce]] slot ----
  __jb.elementNonce = function (el) {
    if (!el) return "";
    if (el._nonceSlot !== undefined) return el._nonceSlot;
    var a = el.getAttribute ? el.getAttribute("nonce") : null;
    return a === null ? "" : a;
  };
  // Nonce hiding: once a nonced HTML/SVG element is connected in a document with a header-delivered
  // CSP, its content attribute becomes "" (the slot keeps the value).
  var nonceCarrier = function (el) { return el && el.nodeType === 1 && (el._ns === __jb.HTML_NS || el._ns === __jb.SVG_NS); };
  CSP.hideNonce = function (el) {
    if (!nonceCarrier(el) || !el.hasAttribute("nonce")) return;
    var nonce = __jb.elementNonce(el);
    if (el.getAttribute("nonce") === "") { el._nonceSlot = nonce; return; }
    el.setAttribute("nonce", "");
    el._nonceSlot = nonce;
  };
  __jb.hideNoncesIn = function (root) {
    try {
      if (!__jb.cspFromHeader()) return;
      __jb.descendants(root, function (n) { return n.nodeType === 1 && n.hasAttribute && n.hasAttribute("nonce"); }).forEach(CSP.hideNonce);
    } catch (e) {}
  };
  var baseConnected = __jb.connected;
  __jb.connected = function (node) {
    baseConnected(node);
    try {
      if (node.nodeType !== 1 || node.ownerDocument !== __jb.currentDocument || !__jb.cspFromHeader()) return;
      if (node.hasAttribute("nonce")) CSP.hideNonce(node);
      if (node.firstElementChild) Array.prototype.forEach.call(node.querySelectorAll("[nonce]"), CSP.hideNonce);
    } catch (e) {}
  };
  if (typeof SVGElement === "function" && !Object.getOwnPropertyDescriptor(SVGElement.prototype, "nonce")) {
    Object.defineProperty(SVGElement.prototype, "nonce", { get: function () { return __jb.elementNonce(this); }, set: function (v) { this._nonceSlot = String(v); }, configurable: true, enumerable: true });
  }
  var baseAttrChanged = __jb.attributeChanged;
  __jb.attributeChanged = function (el, attr, oldValue, newValue) {
    if (attr._ns === null && attr._local === "nonce" && nonceCarrier(el)) el._nonceSlot = newValue === null ? "" : String(newValue);
    baseAttrChanged(el, attr, oldValue, newValue);
  };

  // ---- Mixed Content ----
  // Requests from a context that prohibits mixed security contexts (a potentially trustworthy
  // origin, or one embedded in such a document) to URLs that are not potentially trustworthy:
  // image/audio/video are upgraded to https, everything else is blocked. A policy with
  // upgrade-insecure-requests upgrades every insecure subresource and frame request.
  var M = __jb.mixed = {};
  var trustworthyHost = function (h) { h = String(h).toLowerCase().replace(/^\[|\]$/g, ""); return h === "localhost" || /\.localhost$/.test(h) || /^127\./.test(h) || h === "::1"; };
  M.trustworthyUrl = function (u) {
    try {
      if (/^about:(blank|srcdoc)([?#]|$)/i.test(u) || /^data:/i.test(u)) return true;
      var url = new URL(u);
      if (url.protocol === "blob:") { try { return M.trustworthyUrl(new URL(url.pathname).href); } catch (e) { return true; } }
      if (url.protocol === "https:" || url.protocol === "wss:" || url.protocol === "file:") return true;
      return (url.protocol === "http:" || url.protocol === "ws:") && trustworthyHost(url.hostname);
    } catch (e) { return false; }
  };
  var originTrustworthy = function (w) {
    try {
      var j = w.__jb;
      if (j && j.opaqueOrigin) return false;
      var o = j && j.isWorker && j.workerScriptUrl ? new URL(j.workerScriptUrl).origin : w.location.origin;
      if (o === "null") return false;
      return M.trustworthyUrl(o + "/");
    } catch (e) { return false; }
  };
  // "Does settings prohibit mixed security contexts?"
  M.prohibits = function () {
    var w = globalThis, guard = 0;
    try { if (__jb.isWorker && __jb.workerOwnerJb) return originTrustworthy(globalThis) || __jb.workerOwnerJb.mixed.prohibits(); } catch (e) {}
    while (w && guard++ < 20) {
      if (originTrustworthy(w)) return true;
      var fc = null; try { fc = w.__jb && w.__jb.frameContext; } catch (e2) { fc = null; }
      var next = fc && fc.parent && fc.parent !== w ? fc.parent : null;
      if (!next) { try { var aux = w.__jb && w.__jb.auxiliary; next = null; void aux; } catch (e3) {} }
      w = next;
    }
    return false;
  };
  M.upgradeInsecure = function () {
    try { return __jb.cspPolicies().some(function (p) { return p.disposition === "enforce" && p.directives["upgrade-insecure-requests"] !== undefined; }); } catch (e) { return false; }
  };
  M.upgrade = function (u) {
    try { var url = new URL(u); if (url.protocol === "http:") { var p80 = url.port === "80"; url.protocol = "https:"; if (p80) url.port = "443"; } else if (url.protocol === "ws:") { var w80 = url.port === "80"; url.protocol = "wss:"; if (w80) url.port = "443"; } return url.href; } catch (e) { return u; }
  };
  var UPGRADEABLE = { image: 1, audio: 1, video: 1 };
  // {url, blocked, mode}: the URL to request (possibly upgraded), whether it is blocked, and the
  // host's per-redirect-hop mode ("upgrade", "block" or undefined).
  M.filter = function (dest, url) {
    var out = { url: url, blocked: false, mode: undefined };
    if (!/^(http|ws)s?:/i.test(String(url))) return out;
    var uir = M.upgradeInsecure();
    if (uir) { out.url = M.upgrade(url); out.mode = "upgrade"; }
    if (!M.prohibits()) return out;
    if (!out.mode) out.mode = UPGRADEABLE[dest] ? "upgrade" : "block";
    if (M.trustworthyUrl(out.url)) return out;
    if (UPGRADEABLE[dest]) { out.url = M.upgrade(out.url); return out; }
    out.blocked = true;
    return out;
  };
  M.blocks = function (dest, url) { return M.filter(dest, url).blocked; };

  // ---- SecurityPolicyViolationEvent ----
  class SecurityPolicyViolationEvent extends Event {
    constructor(type, init = undefined) {
      if (arguments.length < 1) throw new TypeError("SecurityPolicyViolationEvent: 1 argument required");
      super(type, init);
      if (init !== undefined && init !== null && typeof init !== "object" && typeof init !== "function") throw new TypeError("SecurityPolicyViolationEventInit must be an object");
      init = init || {};
      var str = function (k) { return init[k] === undefined ? "" : String(init[k]); };
      var num = function (k, max) { var n = init[k] === undefined ? 0 : Number(init[k]); if (!isFinite(n)) n = 0; n = Math.trunc(n) % max; if (n < 0) n += max; return n; };
      var disp = init.disposition === undefined ? "enforce" : String(init.disposition);
      if (disp !== "enforce" && disp !== "report") throw new TypeError("SecurityPolicyViolationEventInit.disposition: '" + disp + "' is not a valid value");
      var e = this._ev;
      e.documentURI = str("documentURI"); e.referrer = str("referrer"); e.blockedURI = str("blockedURI");
      e.violatedDirective = str("violatedDirective"); e.effectiveDirective = str("effectiveDirective");
      e.originalPolicy = str("originalPolicy"); e.sourceFile = str("sourceFile"); e.sample = str("sample");
      e.disposition = disp; e.statusCode = num("statusCode", 65536); e.lineNumber = num("lineNumber", 4294967296); e.columnNumber = num("columnNumber", 4294967296);
    }
    get documentURI() { return this._ev.documentURI; }
    get referrer() { return this._ev.referrer; }
    get blockedURI() { return this._ev.blockedURI; }
    get effectiveDirective() { return this._ev.effectiveDirective; }
    get violatedDirective() { return this._ev.violatedDirective; }
    get originalPolicy() { return this._ev.originalPolicy; }
    get sourceFile() { return this._ev.sourceFile; }
    get sample() { return this._ev.sample; }
    get disposition() { return this._ev.disposition; }
    get statusCode() { return this._ev.statusCode; }
    get lineNumber() { return this._ev.lineNumber; }
    get columnNumber() { return this._ev.columnNumber; }
  }
  Object.defineProperty(globalThis, "SecurityPolicyViolationEvent", { value: SecurityPolicyViolationEvent, writable: true, configurable: true, enumerable: false });
})();
