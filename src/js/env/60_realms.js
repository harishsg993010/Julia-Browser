// Part 6c: nested browsing contexts in their own realm. Every <iframe>
// document gets a SpiderMonkey global of its own (created by the host,
// `__jb_native("frameCreate")`) with this same environment loaded; the parent
// keeps the child's global as `contentWindow`, drives its timers from its own
// timer loop and delivers `postMessage` into it. Documents of frames run
// their scripts through `__jb.runDocumentScripts` (fetches through the host,
// evaluation via the `evalScript`/`evalModule` bridge ops in the frame realm).
// When the host cannot create a realm (limit reached), the shared-realm
// emulation of 45_frames.js is used instead.
__jb.MAX_FRAME_REALMS = 24;
__jb.MAX_AUX_REALMS = 120; // popups close themselves; tests open many before the first message lands
__jb.childRealms = [];
__jb.loadFrameLegacy = __jb.loadFrame;
// The incumbent realm: the window whose task (script, timer, event delivery
// from the host) is currently running. Kept on the top window so every realm
// reads the same value; used for postMessage's source/origin.
// HTML "check a navigation response's adherence to X-Frame-Options" for a document about to be
// shown in a frame of this realm.
__jb.xfoAllows = function (source) {
  var h = source.headers || {}, get = function (n) { for (var k in h) if (k.toLowerCase() === n) return h[k]; return null; };
  if (!/^https?:/i.test(source.url || "")) return true;
  var csp = get("content-security-policy");
  if (csp && /(^|[;,])\s*frame-ancestors(\s|;|,|$)/i.test(String(csp))) return true;
  var raw = get("x-frame-options");
  if (raw === null || raw === undefined) return true;
  var set = [];
  String(raw).split(",").forEach(function (v) { v = v.trim().toLowerCase(); if (set.indexOf(v) < 0) set.push(v); });
  if (set.length > 1) return !set.some(function (v) { return v === "deny" || v === "allowall" || v === "sameorigin"; });
  if (set[0] === "deny") return false;
  if (set[0] === "sameorigin") {
    var dest; try { dest = new URL(source.url).origin; } catch (e) { return false; }
    var w = globalThis, guard = 0;
    while (w && guard++ < 20) {
      var o = "null";
      try { o = w.__jb && w.__jb.opaqueOrigin ? "null" : w.location.origin; } catch (e) { o = "null"; }
      if (o !== dest) return false;
      var fc = null; try { fc = w.__jb && w.__jb.frameContext; } catch (e2) { fc = null; }
      w = fc && fc.parent && fc.parent !== w ? fc.parent : null;
    }
  }
  return true;
};
__jb.topJb = function () { try { if (__jb.auxiliary && __jb.auxiliary.creator && __jb.auxiliary.creator.__jb) return __jb.auxiliary.creator.__jb.topJb(); var t = __jb.frameContext && __jb.frameContext.top; return t && t.__jb ? t.__jb : __jb; } catch (e) { return __jb; } };
__jb.setIncumbent = function (w) { var tj = __jb.topJb(); var prev = tj.incumbentRealm; tj.incumbentRealm = w; return prev; };
__jb.incumbent = function () { var w = __jb.topJb().incumbentRealm; return __jb.isRealmWindow(w) ? w : globalThis; };
// True only for a global of ANOTHER realm: the legacy shared-realm frame proxy
// forwards unknown properties to this window, so its `__jb` is ours.
__jb.isRealmWindow = function (w) { try { return !!(w && typeof w === "object" && w.__jb && w.__jb !== __jb && w.__jb.ready !== undefined); } catch (e) { return false; } };

// ---- window.parent / top / frameElement of this realm ----
["parent", "top", "frameElement"].forEach(function (name) {
  Object.defineProperty(globalThis, name, {
    get: function () {
      var fc = __jb.frameContext;
      if (!fc) return name === "frameElement" ? null : globalThis;
      // A discarded browsing context (container removed) has no parent, top or frame element.
      var discarded = false; try { discarded = !!fc.frameElement && (!fc.frameElement.isConnected || fc.frameElement._contentWindow !== globalThis); } catch (e) {}
      if (discarded) return null;
      if (name === "frameElement") return fc.frameElement || null;
      return fc[name] || globalThis;
    },
    set: function (v) { Object.defineProperty(globalThis, name, { value: v, writable: true, configurable: true, enumerable: true }); },
    configurable: true, enumerable: true,
  });
});

// ---- Storage Access API ----
// A document has storage access at top level, when it is same-site with the top-level site,
// or after a grant (user activation, or the "storage-access" permission set to granted).
__jb.siteOf = function (url) {
  try { var u = new URL(url); if (u.origin === "null") return null; var h = u.hostname, parts = h.split("."); var site = /^[\d.]+$/.test(h) || parts.length <= 2 ? h : parts.slice(-2).join("."); return u.protocol + "//" + site; } catch (e) { return null; }
};
__jb.permissionState = function (name) { var t = typeof __jb.topJb === "function" ? __jb.topJb() : __jb; return (t.permissionStates && t.permissionStates[name]) || "prompt"; };
__jb.storageAccessState = function (doc) {
  if (!doc || !doc.defaultView || doc.defaultView.document !== doc) return "inactive";
  var win = doc.defaultView;
  try { if (win.frameElement && !win.frameElement.isConnected) return "inactive"; } catch (e) {}
  if (win.__jb && win.__jb.frameContext && win.__jb.frameContext.frameElement && !win.__jb.frameContext.frameElement.isConnected) return "inactive";
  if (!win.isSecureContext) return "insecure";
  var top = null;
  try { top = win.top; } catch (e) {}
  if (!top || top === win) return "top";
  if (doc.origin === "null" || (win.origin === "null")) return "opaque";
  var topUrl = null;
  try { topUrl = (typeof __jb.topJb === "function" ? __jb.topJb() : __jb).topLevelURL || top.location.href; } catch (e) { topUrl = (typeof __jb.topJb === "function" ? __jb.topJb() : __jb).topLevelURL || null; }
  if (!topUrl) { try { topUrl = __jb.topJb().currentDocument.URL; } catch (e) {} }
  if (topUrl && __jb.siteOf(topUrl) === __jb.siteOf(doc.URL)) return "same-site";
  return "cross-site";
};
__jb.hasStorageAccess = function (doc) {
  var st = __jb.storageAccessState(doc);
  if (st === "inactive") return Promise.reject(__jb.domError("InvalidStateError", "The document is not fully active"));
  if (st === "insecure" || st === "opaque") return Promise.resolve(false);
  if (st === "top" || st === "same-site") return Promise.resolve(true);
  return Promise.resolve(!!doc._storageAccessGranted);
};
__jb.requestStorageAccess = function (doc) {
  var st = __jb.storageAccessState(doc);
  if (st === "inactive") return Promise.reject(__jb.domError("InvalidStateError", "The document is not fully active"));
  if (st === "insecure") return Promise.reject(__jb.domError("NotAllowedError", "Storage access requires a secure context"));
  if (st === "top" || st === "same-site") return Promise.resolve(undefined);
  if (st === "opaque") {
    var fe = null; try { fe = doc.defaultView.frameElement; } catch (e) {}
    var sb = fe && fe.getAttribute ? fe.getAttribute("sandbox") : null;
    if (sb !== null && !/(^|\s)allow-storage-access-by-user-activation(\s|$)/i.test(sb)) return Promise.reject(__jb.domError("NotAllowedError", "The sandbox does not allow storage access"));
  }
  if (doc._storageAccessGranted || __jb.permissionState("storage-access") === "granted") { doc._storageAccessGranted = true; return Promise.resolve(undefined); }
  if (__jb.permissionState("storage-access") === "denied") return Promise.reject(__jb.domError("NotAllowedError", "Storage access was denied"));
  var win = doc.defaultView;
  var active = win && win.__jb && typeof win.__jb.hasTransientActivation === "function" ? win.__jb.hasTransientActivation() : (typeof __jb.hasTransientActivation === "function" && __jb.hasTransientActivation());
  if (!active) return Promise.reject(__jb.domError("NotAllowedError", "requestStorageAccess() requires user activation"));
  doc._storageAccessGranted = true;
  return Promise.resolve(undefined);
};

// ---- realm lifecycle ----
__jb.createFrameRealm = function (iframe, limit, worker) {
  var g = null;
  // test pages frame many documents at once (x-frame-options/multiple.html: 110); real pages keep the lower cap
  var frameLimit = __jb.MAX_FRAME_REALMS;
  try { if (__jb.wptMode || (__jb.topJb && __jb.topJb().wptMode)) frameLimit = 128; } catch (e) {}
  try { g = __jb_native("frameCreate", __jb.hostJson({ limit: limit || frameLimit, worker: !!worker })); } catch (e) { g = null; }
  if (!g) return null;
  var top = __jb.frameContext && __jb.frameContext.top ? __jb.frameContext.top : globalThis;
  g.__jb.frameContext = { parent: globalThis, top: top, frameElement: iframe };
  // The browsing context name comes from the container element when the context is created.
  try { g.name = iframe ? (iframe.getAttribute("name") || "") : ""; } catch (e) {}
  g.__jb.clock = __jb.clock;
  __jb.childRealms.push(g);
  return g;
};
__jb.dropRealm = function (g) {
  var i = __jb.childRealms.indexOf(g);
  if (i >= 0) __jb.childRealms.splice(i, 1);
  try { g.__jb.childRealms.slice().forEach(function (c) { g.__jb.dropRealm(c); }); } catch (e) {}
  try { g.__jb.timers = []; } catch (e2) {}
  try { if (typeof g.__jb_frameIndex === "number") __jb_native("frameDrop", __jb.hostJson({ index: g.__jb_frameIndex })); } catch (e3) {}
};

// ---- loading a frame document into a realm ----
// The host fetches images by URL: a blob: URL is handed over as the equivalent data: URL.
__jb.blobEntry = function (url) {
  var key = String(url).split("#")[0], stores = [__jb.blobUrls];
  try { var tj = __jb.topJb(); if (tj && tj !== __jb) stores.push(tj.blobUrls); } catch (e) {}
  try { if (__jb.workerOwnerJb) stores.push(__jb.workerOwnerJb.blobUrls); } catch (e) {}
  for (var si = 0; si < stores.length; si++) if (stores[si] && stores[si][key]) return stores[si][key];
  return null;
};
__jb.hostImageUrl = function (url) {
  if (!/^blob:/i.test(url)) return url;
  var entry = __jb.blobEntry(url);
  if (!entry || typeof entry._bytes !== "function") return url;
  var bytes = entry._bytes(), bin = "";
  for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return "data:" + (entry.type || "application/octet-stream") + ";base64," + btoa(bin);
};
__jb.fetchSource = function (url, post, dest, user) {
  // Fetch a document for a browsing context: {url, html, contentType, encoding, blank, failed}.
  if (/^about:blank([?#]|$)/.test(url)) return { url: url, html: "", contentType: "text/html", encoding: null, blank: true };
  if (/^blob:/i.test(url)) {
    // The blob URL store is shared by the realms of this page (look in ours, then the top-level one).
    var key = url.split("#")[0], entry = null, stores = [__jb.blobUrls];
    try { var tj = __jb.topJb(); if (tj && tj !== __jb) stores.push(tj.blobUrls); } catch (e) {}
    try { if (__jb.workerOwnerJb) { stores.push(__jb.workerOwnerJb.blobUrls); var otj = __jb.workerOwnerJb.topJb(); if (otj) stores.push(otj.blobUrls); } } catch (e) {}
    for (var si = 0; si < stores.length && !entry; si++) if (stores[si] && stores[si][key]) entry = stores[si][key];
    if (!entry || typeof entry._bytes !== "function") return { url: url, html: "", contentType: "text/html", encoding: null, failed: true };
    var bct = String(entry.type || "text/html").toLowerCase();
    return { url: url, html: __utf8Decode(entry._bytes()), contentType: bct.split(";")[0].trim() || "text/html", encoding: null };
  }
  var req = { url: url, method: post ? "POST" : "GET", headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }, mode: dest === "worker" || dest === "sharedworker" || dest === "script" ? "same-origin" : "navigate", dest: dest || "iframe" };
  var navRef = req.mode === "navigate" && typeof __jb.takeNavigationReferrer === "function" ? __jb.takeNavigationReferrer() : undefined;
  if (navRef) { req.referrer = navRef.referrer; req.referrerPolicy = navRef.referrerPolicy; if (navRef.origin) req.origin = navRef.origin; }
  var navHeaders = req.mode === "navigate" && typeof __jb.takeNavigationHeaders === "function" ? __jb.takeNavigationHeaders() : undefined;
  if (navHeaders) Object.keys(navHeaders).forEach(function (k) { req.headers[k] = navHeaders[k]; });
  if (__jb.csp && (req.dest === "iframe" || req.dest === "frame")) { var cl = __jb.csp.redirectLists("iframe"); if (cl) req.csp = cl; }
  if (user === undefined && req.mode === "navigate") { try { user = !!(navigator.userActivation && navigator.userActivation.isActive); } catch (eu) { user = false; } }
  if (user) req.user = true;
  if (post) { req.headers["Content-Type"] = post.contentType; if (post.bodyBase64 !== undefined) req.bodyBase64 = post.bodyBase64; else req.body = post.body; }
  var r = null;
  // Service workers: a navigation in a registration's scope (or a worker script fetched by a
  // controlled document) goes to the worker's fetch handlers first
  var swHandled = false;
  if (__jb.sw && /^https?:/.test(url)) {
    var pre = __jb.topJb().pendingSwResult;
    if (pre && pre.url === url && pre.rec && !pre.worker) {
      // a response the navigation already fetched hop by hop
      swHandled = true;
      r = { status: pre.rec.status, statusText: pre.rec.statusText, headers: pre.rec.headers || {}, url: pre.rec.url || url, bodyBase64: __jb.bytesToB64(new Uint8Array(pre.rec.body || [])) };
    }
    // worker main scripts, like navigations, go to the registration matching their own URL
    var workerReq = req.dest === "worker" || req.dest === "sharedworker";
    var sww = swHandled ? null : pre && pre.url === url ? pre.worker : req.mode === "navigate" || workerReq ? __jb.sw.navigationController(url) : __jb.sw.controllerForRequest(url);
    if (workerReq) __jb.workerFetchController = sww || null;
    if (sww) {
      var resultingWorker = workerReq && __jb.workerFetchClient ? __jb.sw.clientId(__jb.workerFetchClient) : "";
      var rec = pre && pre.url === url ? pre.rec : __jb.sw.handleFetchSync(sww, { url: url, method: req.method, headers: req.headers, body: req.body, mode: req.mode, destination: req.dest, credentials: workerReq ? "same-origin" : "include", redirect: req.mode === "navigate" ? "manual" : "follow", origin: req.origin, referrer: req.referrer, referrerPolicy: req.referrerPolicy }, globalThis, resultingWorker);
      if (rec === false) return { url: url, html: "", contentType: "text/html", encoding: null, failed: true };
      if (rec) {
        swHandled = true;
        var hb = new Uint8Array(rec.body || []), h = rec.headers || {};
        r = { status: rec.status, statusText: rec.statusText, headers: h, url: rec.url || url, bodyBase64: __jb.bytesToB64(hb) };
      }
      if (req.mode === "navigate") __jb.topJb().pendingNavController = sww;
    }
  }
  // HTTPS Upgrades (test pages): a top-level navigation to an http: URL first tries the https:
  // URL (same port, redirect hops upgraded too) and falls back to http: when that fails
  if (!swHandled && req.dest === "document" && req.method === "GET" && /^http:/i.test(url) && __jb.httpsUpgradesOn && __jb.httpsUpgradesOn()) {
    var upReq = Object.assign({}, req, { url: url.replace(/^http:/i, "https:"), mixed: "upgrade" });
    var ur = null; try { ur = __jb.native("fetch", upReq); } catch (eU) { ur = null; }
    if (ur && ur.status) { r = ur; swHandled = true; }
  }
  if (!swHandled) r = __jb.native("fetch", req);
  if (r && !r.status && req.csp && __jb.csp.reportBlockedRedirect(req.dest, url, r.statusText)) return { url: url, html: "", contentType: "text/html", encoding: null, failed: true, cspBlocked: true };
  if (!r || !r.status || r.status >= 400) return { url: url, html: "", contentType: "text/html", encoding: null, failed: true };
  var ct = String((r.headers && r.headers["content-type"]) || "text/html").toLowerCase();
  var text = r.text !== undefined ? r.text : __utf8Decode(__jb.b64ToBytes(r.bodyBase64 || ""));
  // The response URL carries no fragment: the request's fragment stays on the document URL.
  var finalUrl = r.url || url, hashAt = String(url).indexOf("#");
  if (r.headers && r.headers["link"] && (!dest || dest === "iframe" || dest === "document")) __jb.processLinkHeader(String(r.headers["link"]), finalUrl);
  if (hashAt >= 0 && String(finalUrl).indexOf("#") < 0) finalUrl = finalUrl + String(url).slice(hashAt);
  return { url: finalUrl, html: text, contentType: ct.split(";")[0].trim(), encoding: r.encoding || null, oac: (r.headers && r.headers["origin-agent-cluster"]) || null, refresh: (r.headers && r.headers["refresh"]) || null, headers: r.headers || {}, referrer: r.referrer || "" };
};
// HTTP Link headers of a fetched document: rel=stylesheet and rel=icon start their fetches.
__jb.processLinkHeader = function (value, docUrl) {
  var origin; try { origin = new URL(docUrl).origin; } catch (e) { return; }
  var parts = value.match(/<[^>]*>[^,]*/g) || [];
  parts.slice(0, 16).forEach(function (p) {
    var m = /^<([^>]*)>(.*)$/.exec(p.trim()); if (!m) return;
    var relm = /;\s*rel\s*=\s*"?([^";]*)"?/i.exec(m[2]); if (!relm) return;
    var rels = relm[1].toLowerCase().split(/\s+/), abs;
    try { abs = new URL(m[1], docUrl).href; } catch (e) { return; }
    if (!/^https?:/.test(abs)) return;
    try {
      if (rels.indexOf("stylesheet") >= 0) __jb.native("fetch", { url: abs, method: "GET", headers: { Accept: "text/css,*/*;q=0.1" }, mode: "no-cors", dest: "style", origin: origin });
      else if (rels.indexOf("icon") >= 0) __jb.native("image", { url: abs, dest: "empty", mode: "no-cors", initiator: docUrl });
    } catch (e) {}
  });
};
// A navigation's reserved client carried over a redirect: kept while the target stays same-origin
// with the URL the reservation was created for.
__jb.reservedClientFor = function (iframe, url) {
  var rc = iframe._reservedClient; iframe._reservedClient = null;
  if (!rc) return null;
  try { return new URL(url).origin === rc.origin ? rc : null; } catch (e) { return null; }
};
__jb.fetchFrameSource = function (iframe, explicitUrl) {
  var srcdoc = iframe.getAttribute("srcdoc");
  var src = explicitUrl !== undefined ? explicitUrl : iframe.getAttribute("src");
  if (explicitUrl === undefined && srcdoc !== null) return { url: "about:srcdoc", html: srcdoc, contentType: "text/html", encoding: null };
  var url = "about:blank";
  if (src !== null && String(src).trim() !== "" && String(src).trim() !== "about:blank") {
    try { url = new URL(String(src).trim(), iframe.ownerDocument.URL).href; } catch (e) { url = "about:blank"; }
    if (url.indexOf("javascript:") === 0) { var blank = __jb.fetchSource("about:blank"); blank.javascriptUrl = url; return blank; }
    if (url.indexOf("about:") === 0) url = "about:blank";
  }
  var post = iframe._pendingPost || null; iframe._pendingPost = null;
  if (post || !iframe._swResult) iframe._docPost = post;
  iframe._reservedClient = null;
  iframe._reloadNav = false;
  // mixed content: insecure frames are blocked (or upgraded by upgrade-insecure-requests)
  if (url !== "about:blank" && __jb.mixed) { var mf = __jb.mixed.filter("iframe", url); if (mf.blocked) return { url: url, html: "", contentType: "text/html", encoding: null, failed: true, cspBlocked: true }; url = mf.url; }
  // Content Security Policy frame-src: a blocked frame shows an empty error document
  if (url !== "about:blank" && __jb.csp && !__jb.csp.allowsRequest("iframe", url, { element: iframe })) return { url: url, html: "", contentType: "text/html", encoding: null, failed: true, cspBlocked: true };
  if (__jb.csp) iframe._cspRedirectLists = __jb.csp.redirectLists("iframe");
  var tj = __jb.topJb();
  // CSP Embedded Enforcement: the frame's required CSP goes out as Sec-Required-CSP
  iframe._requiredCsp = __jb.csp ? __jb.csp.requiredCspFor(iframe) : null;
  if (iframe._requiredCsp !== null && /^https?:/i.test(url)) tj.pendingNavHeaders = { "Sec-Required-CSP": iframe._requiredCsp };
  // Document Policy: the frame's required policy (its policy attribute combined with this
  // document's required policy, the stricter value winning) goes out as Sec-Required-Document-Policy
  var rdp = __jb.requiredDocumentPolicyFor ? __jb.requiredDocumentPolicyFor(iframe) : "";
  iframe._sentDocPolicy = rdp;
  if (rdp && /^https?:/i.test(url)) { tj.pendingNavHeaders = tj.pendingNavHeaders || {}; tj.pendingNavHeaders["Sec-Required-Document-Policy"] = rdp; }
  if (tj.pendingNavReferrer === undefined && typeof __jb.requestReferrer === "function") {
    var own = __jb.elementReferrerPolicy(iframe);
    return __jb.withNavigationReferrer(__jb.requestReferrer(own), function () { return __jb.fetchSource(url, post); });
  }
  return __jb.fetchSource(url, post);
};
__jb.httpsUpgradesOn = function () { try { return !!(__jb.wptMode || __jb.topJb().wptMode); } catch (e) { return false; } };
// ---- Document Policy (required policy) ----
// structured-header dictionary -> ordered [[key, rawValue]] (rawValue "" for a bare true)
__jb.parseDocPolicy = function (text) {
  var out = [];
  String(text || "").split(",").forEach(function (item) {
    item = item.trim();
    if (!item) return;
    var m = /^([a-z*][a-z0-9_.*-]*)(?:=([^;]*))?(;.*)?$/.exec(item);
    if (!m) return;
    if (out.some(function (e) { return e[0] === m[1]; })) out = out.filter(function (e) { return e[0] !== m[1]; });
    out.push([m[1], m[2] === undefined ? "" : m[2].trim()]);
  });
  return out;
};
var docPolicyStrictness = function (raw) {
  if (raw === "" || raw === "?1") return 1;     // true: allowed
  if (raw === "?0") return 0;                   // false: disallowed (stricter)
  var n = parseFloat(raw);
  return isNaN(n) ? 1 : n;
};
__jb.combineDocPolicies = function (child, parent) {
  var out = child.map(function (e) { return e.slice(); });
  parent.forEach(function (p) {
    var c = out.filter(function (e) { return e[0] === p[0]; })[0];
    if (!c) out.push(p.slice());
    else if (docPolicyStrictness(p[1]) < docPolicyStrictness(c[1])) c[1] = p[1];
  });
  return out;
};
__jb.serializeDocPolicy = function (list) { return list.map(function (e) { return e[1] === "" || e[1] === "?1" ? e[0] : e[0] + "=" + e[1]; }).join(", "); };
// this document's required policy: what its embedder required plus its own Require-Document-Policy
__jb.documentRequiredPolicy = function () {
  var doc = __jb.currentDocument, own = [];
  try { var h = doc && doc._responseHeaders; own = __jb.parseDocPolicy(h && (h["require-document-policy"] || h["Require-Document-Policy"])); } catch (e) {}
  var inherited = [];
  try { var fe = globalThis.frameElement; if (fe && fe._sentDocPolicy) inherited = __jb.parseDocPolicy(fe._sentDocPolicy); } catch (e) {}
  return __jb.combineDocPolicies(own, inherited);
};
__jb.requiredDocumentPolicyFor = function (iframe) {
  var attr = iframe.getAttribute && iframe.getAttribute("policy");
  var child = attr ? __jb.parseDocPolicy(attr) : [];
  return __jb.serializeDocPolicy(__jb.combineDocPolicies(child, __jb.documentRequiredPolicy()));
};
if (typeof HTMLIFrameElement === "function" && !("policy" in HTMLIFrameElement.prototype)) {
  Object.defineProperty(HTMLIFrameElement.prototype, "policy", { get: function () { var v = this.getAttribute("policy"); return v === null ? "" : v; }, set: function (v) { this.setAttribute("policy", String(v)); }, enumerable: true, configurable: true });
}
// A redirect's Location against the current URL; it keeps the current fragment when it has none.
__jb.redirectTarget = function (location, current) {
  var u = new URL(location, current);
  if (u.hash === "" && String(location).indexOf("#") < 0) { var h = new URL(current).hash; if (h) u.hash = h; }
  return u.href;
};
// Fetch a navigation hop by hop (redirect: manual) until a non-redirect response or a redirect
// into a service worker's scope. `skipFirstScope`: the first URL was already offered to a worker.
// Returns {rec} (a response record), {inScope: url, post} or {} (let the regular path fetch).
__jb.navigationHops = function (url, post, iframe, skipFirstScope, givenRef) {
  var method = post ? "POST" : "GET", cur = url, tainted = !!(iframe && iframe._navTaint && iframe._navTaint.url === url);
  // the navigation's referrer and origin: a hyperlink's / form's, else this document's
  var navRef = givenRef !== undefined ? givenRef : __jb.topJb().pendingNavReferrer;
  if (navRef === undefined && typeof __jb.requestReferrer === "function") navRef = __jb.requestReferrer(iframe ? __jb.elementReferrerPolicy(iframe) : "");
  for (var i = 0; i < 20; i++) {
    if (i > 0 || !skipFirstScope) { if (i > 0 && __jb.sw.navigationController(cur)) { if (tainted && iframe) iframe._navTaint = { url: cur }; return { inScope: cur, post: method === "POST" ? post : null }; } }
    var req = { url: cur, method: method, headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }, mode: "navigate", dest: iframe && iframe._tag === "frame" ? "frame" : "iframe", redirect: "manual" };
    if (navRef) { req.referrer = navRef.referrer; req.referrerPolicy = navRef.referrerPolicy; if (navRef.origin) req.origin = navRef.origin; }
    if (tainted) req.origin = "null"; // redirect-tainted origin
    if (method === "POST" && post) { req.headers["Content-Type"] = post.contentType; if (post.bodyBase64 !== undefined) req.bodyBase64 = post.bodyBase64; else req.body = post.body; }
    var r = __jb.native("fetch", req);
    if (!r) return {};
    if (r.opaqueRedirect && r.redirectLocation) {
      var next; try { next = __jb.redirectTarget(r.redirectLocation, cur); } catch (e) { return {}; }
      if (r.redirectStatus === 303 || ((r.redirectStatus === 301 || r.redirectStatus === 302) && method === "POST")) { method = "GET"; post = null; }
      try { var co = new URL(cur).origin, no = new URL(next).origin; if (co !== no && (!navRef || navRef.origin !== co)) tainted = true; } catch (eT) {}
      cur = next;
      continue;
    }
    if (!r.status) return {};
    var body = r.bodyBase64 !== undefined ? __jb.b64ToBytes(r.bodyBase64) : new TextEncoder().encode(r.text || "");
    return { rec: { status: r.status, statusText: r.statusText, headers: r.headers || {}, url: r.url || cur, body: body, type: "basic", redirected: cur !== url } };
  }
  return {};
};
// "Evaluate a javascript: URL" in browsing context `w`, in a queued task; a
// string result replaces the document (same URL), anything else is ignored.
__jb.decodeJavascriptUrl = function (url) {
  var body = String(url).slice("javascript:".length);
  try { return decodeURIComponent(body); } catch (e) { return body.replace(/%([0-9a-fA-F]{2})/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); }); }
};
__jb.runJavascriptUrl = function (w, url, initiatorOrigin, done) {
  // Same origin with the target document (inherited origins count; opaque ones never match another).
  // The initiator (a window) must be same origin-domain with the target document.
  if (initiatorOrigin !== undefined) {
    if (initiatorOrigin && typeof initiatorOrigin === "object" && typeof __jb.sameOriginDomain === "function") { var okay = false; try { okay = __jb.sameOriginDomain(initiatorOrigin, w); } catch (e00) {} if (!okay) return; }
    else { var targetOrigin = null; try { targetOrigin = w.location.origin; } catch (e0) {} if (targetOrigin !== initiatorOrigin) return; }
  }
  // Content Security Policy of the initiator (script-src-elem 'unsafe-inline' / hashes with 'unsafe-hashes')
  if (__jb.csp && !__jb.csp.allowsJavascriptUrl(url)) { if (typeof done === "function") setTimeout(done, 0); return; }
  var code = __jb.decodeJavascriptUrl(url);
  var gen = w.__jb.navGen;
  w.setTimeout(function () {
    if (w.closed || w.__jb.navGen !== gen) return; // document.open() or a later navigation aborted it
    try { runIt(); } finally { if (typeof done === "function") done(); }
  }, 0);
  function runIt() {
    var result;
    try { result = w.__jb.csp ? w.__jb.csp.trusted(function () { return (0, w.eval)(code); }) : (0, w.eval)(code); } catch (e) { try { w.__jb.reportException(e); } catch (e2) {} return; }
    if (typeof result !== "string") return;
    var docUrl = "about:blank"; try { docUrl = w.document.URL; } catch (e3) {}
    // The Window survives the document replacement, so do its queued tasks.
    var pending = []; try { pending = w.__jb.timers.slice(); } catch (e4) {}
    __jb.loadRealmDocument(w, { url: docUrl, html: result, contentType: "text/html", encoding: null }, true);
    try { w.__jb.timers = pending.concat(w.__jb.timers); } catch (e5) {}
  }
};
// Build the document of `source` in realm `g` and run its scripts (unless sandboxed).
__jb.loadRealmDocument = function (g, source, allowScripts) {
  var html = source.html, ct = source.contentType;
  if (/^text\/plain/.test(ct) || /^application\/json/.test(ct)) html = "<pre>" + html.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</pre>";
  var raw = "";
  try { raw = __jb_native("html", __jb.hostJson({ html: html })); } catch (e) { raw = ""; }
  try {
    g.__jb.scriptsAllowed = allowScripts !== false;
    g.__jb.loadDom(raw || "{}", source.url);
    g.document._responseHeaders = g.__jb.pendingResponseHeaders || {}; g.__jb.pendingResponseHeaders = null;
    if (typeof g.__jb.hideNoncesIn === "function") g.__jb.hideNoncesIn(g.document);
    if (/^about:(blank|srcdoc)$/.test(g.document.URL) && g.__jb.pendingFallbackBase) g.document._fallbackBase = g.__jb.pendingFallbackBase;
    g.document._referrer = g.__jb.pendingReferrer !== undefined ? g.__jb.pendingReferrer : source.referrer !== undefined && source.headers ? source.referrer : (source.blank ? "" : location.href);
    g.__jb.pendingReferrer = undefined;
    if (source.encoding) g.document._characterSet = source.encoding;
    if (/^text\/plain/.test(ct) || /^application\/json/.test(ct)) { g.document._contentType = ct; g.document._quirks = false; } // text documents keep their type (no-quirks)
    if (allowScripts !== false && !source.blank && !source.failed) g.__jb.runDocumentScripts();
    g.__jb.scriptsLive = allowScripts !== false; // scripts inserted from now on run at insertion, as after parsing in a browser
    g.__jb.fireLifecycle("interactive");
    g.__jb.fireLifecycle("complete");
    g.__jb.completelyLoaded = true;
  } catch (e) { __jb.reportException(e); }
};
// HTML "shared declarative refresh steps": [seconds, url string] or null.
__jb.parseDeclarativeRefresh = function (input) {
  input = String(input);
  if (input === "") return null;
  var pos = 0, n = input.length, ws = /[\t\n\f\r ]/;
  var skipWs = function () { while (pos < n && ws.test(input.charAt(pos))) pos++; };
  skipWs();
  var start = pos;
  while (pos < n && /[0-9]/.test(input.charAt(pos))) pos++;
  var timeString = input.slice(start, pos), time = 0;
  if (timeString === "") { if (input.charAt(pos) !== ".") return null; }
  else time = parseInt(timeString, 10);
  while (pos < n && /[0-9.]/.test(input.charAt(pos))) pos++;
  if (pos < n && !/[;,\t\n\f\r ]/.test(input.charAt(pos))) return null;
  skipWs();
  if (input.charAt(pos) === ";" || input.charAt(pos) === ",") { pos++; skipWs(); }
  if (pos >= n) return [time, null];
  var urlString = input.slice(pos), quote = null;
  var parse = function () { return [time, urlString]; };
  var c = input.charAt(pos);
  if (c === "u" || c === "U") {
    pos++;
    if (!/[rR]/.test(input.charAt(pos))) return parse(); pos++;
    if (!/[lL]/.test(input.charAt(pos))) return parse(); pos++;
    skipWs();
    if (input.charAt(pos) !== "=") return parse(); pos++;
    skipWs();
  }
  c = input.charAt(pos);
  if (c === "'" || c === '"') { quote = c; pos++; }
  urlString = input.slice(pos);
  if (quote !== null) { var q = urlString.indexOf(quote); if (q >= 0) urlString = urlString.slice(0, q); }
  return parse();
};
// The Refresh header, else the first <meta http-equiv=refresh>, of a frame document navigates the frame.
__jb.scheduleDeclarativeRefresh = function (g, source, iframe) {
  if (!iframe || iframe._contentWindow !== g) return;
  var doc = g.document, spec = null;
  if (source && source.refresh) spec = __jb.parseDeclarativeRefresh(source.refresh);
  if (!spec) {
    var metas = doc.querySelectorAll("meta[http-equiv]");
    for (var i = 0; i < metas.length && !spec; i++) {
      if (!/^refresh$/i.test(metas[i].getAttribute("http-equiv").trim()) || !metas[i].hasAttribute("content")) continue;
      spec = __jb.parseDeclarativeRefresh(metas[i].getAttribute("content"));
      if (spec) break;
    }
  }
  if (!spec) return;
  var docUrl = doc.URL, gen = iframe._loadToken;
  var target = docUrl;
  if (spec[1] !== null) { try { target = new URL(spec[1].replace(/[\t\n\r]/g, ""), docUrl).href; } catch (e) { return; } }
  setTimeout(function () {
    if (iframe._contentWindow !== g || g.document !== doc || !iframe.isConnected) return;
    iframe._navReferrer = docUrl;
    __jb.loadFrame(iframe, target, true);
  }, Math.max(50, Math.min(spec[0], 600) * 1000));
};
// Joint session history: a frame navigation away from a completely loaded,
// non-initial document adds an entry to the top-level history.
__jb.frameNavAddsEntry = function (iframe, replace) {
  if (replace) return false;
  var w = iframe._contentWindow;
  try { return !!w && __jb.isRealmWindow(w) && w.__jb.completelyLoaded === true && w.document.URL !== "about:blank"; } catch (e) { return false; }
};
__jb.loadFrame = function (iframe, explicitUrl, replace) {
  // src="javascript:..." on a frame that already has a document runs in that
  // document (when same origin) instead of replacing the browsing context.
  var rawSrc = explicitUrl !== undefined ? explicitUrl : (iframe.getAttribute("srcdoc") === null ? iframe.getAttribute("src") : null);
  var jsTarget = null; if (rawSrc !== null && rawSrc !== undefined) { try { jsTarget = new URL(String(rawSrc).trim(), iframe.ownerDocument.URL).href; } catch (eu) {} }
  if (jsTarget && jsTarget.indexOf("javascript:") === 0 && iframe._contentWindow && __jb.isRealmWindow(iframe._contentWindow)) {
    __jb.runJavascriptUrl(iframe._contentWindow, jsTarget, globalThis);
    return;
  }
  if (__jb.sw && !iframe._swResult && __jb.sw.hasRegistrations()) {
    var swTarget = null;
    try { var rawT = explicitUrl !== undefined ? explicitUrl : (iframe.getAttribute("srcdoc") === null ? iframe.getAttribute("src") : null); if (rawT !== null && rawT !== undefined && String(rawT).trim() !== "") swTarget = new URL(String(rawT).trim(), iframe.ownerDocument.URL).href; } catch (eT) { swTarget = null; }
    var swNav = swTarget && /^https?:/.test(swTarget) ? __jb.sw.navigationController(swTarget) : null;
    // outside every scope: fetch hop by hop; a redirect into a scope goes to that worker
    if (!swNav && swTarget && /^https?:/.test(swTarget) && __jb.topJb().wptMode) {
      var hop = __jb.navigationHops(swTarget, iframe._pendingPost || null, iframe);
      if (hop.inScope) { iframe._pendingPost = hop.post; (__jb.loadFrameCore || __jb.loadFrame)(iframe, hop.inScope, replace); return; }
      if (hop.rec) { iframe._pendingPost = null; var rcH = __jb.reservedClientFor(iframe, swTarget); iframe._swResult = { url: swTarget, rec: hop.rec, worker: null, clientId: rcH ? rcH.id : undefined }; try { (__jb.loadFrameCore || __jb.loadFrame)(iframe, explicitUrl, replace); } finally { iframe._swResult = null; } return; }
    }
    if (swNav) {
      var navToken = iframe._swNavToken = (iframe._swNavToken || 0) + 1;
      var navPost = iframe._pendingPost || null;
      iframe._docPost = navPost;
      var navReload = !!iframe._reloadNav; iframe._reloadNav = false;
      var navHistory = !!iframe._historyNav;
      var navHeaders = { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
      var navBody = null;
      if (navPost) { navHeaders["Content-Type"] = navPost.contentType; navBody = navPost.bodyBase64 !== undefined ? __jb.b64ToBytes(navPost.bodyBase64) : navPost.body; }
      // the reserved client survives same-origin redirects (a new one for another origin)
      var rcN = __jb.reservedClientFor(iframe, swTarget);
      var resultingId = rcN ? rcN.id : typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
      var rcOrigin = rcN ? rcN.origin : (function () { try { return new URL(swTarget).origin; } catch (eo) { return ""; } })();
      // the navigation's referrer (a link's / form's, else this document's with the iframe's policy)
      var navRefNow = __jb.topJb().pendingNavReferrer;
      if (navRefNow === undefined && typeof __jb.requestReferrer === "function") navRefNow = __jb.requestReferrer(__jb.elementReferrerPolicy(iframe));
      var navReq = { url: swTarget, method: navPost ? "POST" : "GET", headers: navHeaders, body: navBody, mode: "navigate", destination: iframe._tag === "frame" ? "frame" : "iframe", credentials: "include", redirect: "manual" };
      if (navRefNow) { navReq.referrer = navRefNow.referrer === "" ? "" : navRefNow.referrer; navReq.referrerPolicy = navRefNow.referrerPolicy; navReq.origin = navRefNow.origin; }
      if (iframe._navTaint && iframe._navTaint.url === swTarget) navReq.origin = "null";
      if (navReload) { navReq.isReload = true; navReq.cache = "no-cache"; }
      if (navHistory) navReq.isHistory = true;
      iframe._swNavPending = true;
      __jb.sw.handleFetch(swNav, navReq, globalThis, resultingId).then(function (rec) {
        if (iframe._swNavToken !== navToken || !iframe.isConnected) return;
        if (rec === null && navPost) iframe._pendingPost = navPost; // network fallback keeps the POST
        else iframe._pendingPost = null;
        // the worker's opaque redirect, or the network's redirects, are followed hop by hop
        // a redirect from the worker (fetched with redirect: manual, or generated) is followed
        var redirLoc = rec && rec.type === "opaqueredirect" && rec.redirect && rec.redirect.location ? rec.redirect.location : rec && rec.status >= 301 && rec.status <= 308 && rec.status !== 304 && rec.headers && rec.headers.location ? rec.headers.location : null;
        var redirStatus = rec && rec.redirect ? rec.redirect.status : rec ? rec.status : 0;
        if (redirLoc) {
          var nextU; try { nextU = __jb.redirectTarget(redirLoc, swTarget); } catch (eN) { nextU = null; }
          if (nextU) {
            var keepPost = redirStatus === 307 || redirStatus === 308 ? navPost : null; iframe._pendingPost = keepPost;
            // redirect-tainted origin carries over to the next hop
            try { var o1 = new URL(swTarget).origin, o2 = new URL(nextU).origin; if ((o1 !== o2 && (!navRefNow || navRefNow.origin !== o1)) || (iframe._navTaint && iframe._navTaint.url === swTarget)) iframe._navTaint = { url: nextU }; } catch (eT) {}
            iframe._reservedClient = { id: resultingId, origin: rcOrigin };
            (__jb.loadFrameCore || __jb.loadFrame)(iframe, nextU, replace); return;
          }
        }
        if (rec === null) {
          var hop2 = __jb.navigationHops(swTarget, navPost, iframe, true, navRefNow);
          if (hop2.inScope) { iframe._pendingPost = hop2.post; iframe._reservedClient = { id: resultingId, origin: rcOrigin }; (__jb.loadFrameCore || __jb.loadFrame)(iframe, hop2.inScope, replace); return; }
          if (hop2.rec) { rec = hop2.rec; iframe._pendingPost = null; }
        }
        // the response commits in a task: the new document's scripts must not run inside a
        // microtask (their own service worker fetches spin the event loop)
        var swRes = { url: swTarget, rec: rec, worker: swNav, clientId: resultingId };
        setTimeout(function () {
          if (iframe._swNavToken !== navToken || !iframe.isConnected) return;
          iframe._swResult = swRes;
          var again = function () {
            iframe._swNavPending = false;
            (__jb.loadFrameCore || __jb.loadFrame)(iframe, explicitUrl, replace);
            var hook = iframe._swCommitHook; iframe._swCommitHook = null;
            if (typeof hook === "function") hook();
          };
          try { if (navRefNow) __jb.withNavigationReferrer(navRefNow, again); else again(); } finally { iframe._swResult = null; }
        }, 0);
      }, function () {});
      return;
    }
  }
  if (__jb.frameNavAddsEntry(iframe, replace)) { var tj = __jb.topJb(); tj.jointExtra = (tj.jointExtra || 0) + 1; }
  if (iframe._swResult) __jb.topJb().pendingSwResult = iframe._swResult;
  var source = __jb.fetchFrameSource(iframe, explicitUrl);
  __jb.topJb().pendingSwResult = undefined;
  __jb.topJb().pendingSwClientId = iframe._swResult ? iframe._swResult.clientId : undefined;
  // frame-ancestors of the framed document's policies
  if (__jb.csp && source && source.headers && !__jb.csp.frameAncestorsAllow(source, iframe)) source = { url: source.url, html: "", contentType: "text/html", encoding: null, failed: true, cspBlocked: true };
  // X-Frame-Options (ignored when the response has a CSP frame-ancestors directive)
  if (source && source.headers && !source.cspBlocked && !__jb.xfoAllows(source)) source = { url: source.url, html: "", contentType: "text/html", encoding: null, failed: true, cspBlocked: true };
  // CSP Embedded Enforcement: the response must accept (Allow-CSP-From) or subsume the required CSP
  var required = iframe._requiredCsp === undefined ? null : iframe._requiredCsp, embedded = null;
  if (__jb.csp && required !== null && source && !source.cspBlocked) {
    var verdict = __jb.csp.embeddedAllows(source, required);
    if (verdict === false) source = { url: source.url, html: "", contentType: "text/html", encoding: null, failed: true, cspBlocked: true };
    else if (verdict === "allow" || !/^https?:/i.test(source.url || "")) embedded = required;
  }
  var ct = source.contentType;
  // XML documents keep the shared-realm path (no scripts run in them here).
  // A realm window from an earlier load must not be reused as the legacy
  // container: contentDocument would keep answering with the realm's document.
  if (/xml|svg/.test(ct) && ct.indexOf("text/html") < 0) {
    var prevW = iframe._contentWindow;
    if (prevW && __jb.isRealmWindow(prevW)) { __jb.dropRealm(prevW); iframe._contentWindow = null; iframe._contentDocument = null; }
    return __jb.loadFrameLegacy(iframe, explicitUrl);
  }
  var old = iframe._contentWindow;
  var reuse = false;
  var sandboxAttr = iframe.getAttribute("sandbox");
  var willBeOpaque = sandboxAttr !== null && !/(^|\s)allow-same-origin(\s|$)/i.test(sandboxAttr);
  if (old && __jb.isRealmWindow(old) && old.__jb.initialAboutBlank && !willBeOpaque && !source.blank && !source.failed && !source.javascriptUrl && typeof __jb.effectiveOrigin === "function") {
    // "Navigating from the initial about:blank" to a same-origin document reuses the Window.
    try { reuse = new URL(source.url).origin === __jb.effectiveOrigin(old); } catch (eo) { reuse = false; }
  }
  var g = reuse ? old : __jb.createFrameRealm(iframe);
  if (!g) return __jb.loadFrameLegacy(iframe, explicitUrl);
  if (!reuse && old && __jb.isRealmWindow(old)) __jb.dropRealm(old);
  g.__jb.initialAboutBlank = !!source.blank && !old;
  if (reuse) g.__jb.completelyLoaded = false;
  iframe._contentWindow = g;
  iframe._contentDocument = null;
  // The frame's browsing context outlives its documents (and their globals).
  if (!iframe._bc) iframe._bc = { current: g };
  var prevBc = g.__jb.bc;
  if (prevBc && prevBc !== iframe._bc && iframe._bc.name === undefined) iframe._bc.name = prevBc.name; // the name given at creation
  iframe._bc.current = g; g.__jb.bc = iframe._bc;
  var sandbox = iframe.getAttribute("sandbox");
  var allowScripts = sandbox === null || /(^|\s)allow-scripts(\s|$)/i.test(sandbox);
  g.__jb.opaqueOrigin = sandbox !== null && !/(^|\s)allow-same-origin(\s|$)/i.test(sandbox) ? "null#" + Date.now().toString(36) + Math.random().toString(36).slice(2) : null;
  // a frame blocked by CSP shows an error document with an opaque origin
  if (source.cspBlocked) g.__jb.opaqueOrigin = "null#csp" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  g.__jb.requiredCsp = source.cspBlocked ? null : required;
  g.__jb.embeddedPolicy = source.cspBlocked ? null : embedded;
  if (iframe._navReferrer !== undefined) { g.__jb.pendingReferrer = iframe._navReferrer; iframe._navReferrer = undefined; }
  try { g.__jb.pendingFallbackBase = iframe.ownerDocument.baseURI; } catch (e) {}
  var initialBlank = !old && !!source.blank && !source.javascriptUrl;
  __jb.loadRealmDocument(g, source, allowScripts);
  __jb.scheduleDeclarativeRefresh(g, source, iframe);
  var targetWin = g;
  // A later load of this frame (possibly into the same, reused Window) supersedes this one's load event.
  var loadToken = iframe._loadToken = (iframe._loadToken || 0) + 1;
  var fireLoadNow = function () { if (iframe._contentWindow === targetWin && iframe._loadToken === loadToken) __jb.fireUA(iframe, "load"); };
  if (source.javascriptUrl) {
    if (allowScripts) __jb.runJavascriptUrl(g, source.javascriptUrl, undefined, fireLoadNow);
    else setTimeout(fireLoadNow, 0);
    return;
  }
  // The iframe's load event runs in a task, but always before its document's
  // own load event (which flushes the pending ones first).
  var fired = false;
  var fire = function () {
    if (fired) return; fired = true;
    var i = __jb.pendingFrameLoads.indexOf(fire); if (i >= 0) __jb.pendingFrameLoads.splice(i, 1);
    if (iframe._contentWindow !== targetWin || iframe._loadToken !== loadToken) return;
    __jb.fireUA(iframe, "load");
  };
  if (initialBlank && !replace) { fire(); return; }
  __jb.pendingFrameLoads.push(fire);
  setTimeout(fire, 0);
};
__jb.pendingFrameLoads = [];
(function () {
  var baseBefore = __jb.beforeLoadEvent;
  __jb.beforeLoadEvent = function () {
    if (typeof baseBefore === "function") baseBefore();
    __jb.pendingFrameLoads.slice().forEach(function (f) { try { f(); } catch (e) { __jb.reportException(e); } });
  };
})();
Object.defineProperty(HTMLElement.prototype, "contentDocument", {
  get: function () {
    if (!(this._tag === "iframe" || this._tag === "frame" || this._tag === "object" || this._tag === "embed")) return undefined;
    var w = this._contentWindow;
    if (!w) return null;
    if (__jb.isRealmWindow(w)) return w.document || null;
    return this._contentDocument || null;
  },
  configurable: true,
});

// ---- running the scripts of this realm's document ----
__jb.execScriptElement = function (s, src, code, kind) {
  __jb.currentDocument._jbCurrentScript = s;
  var res = null;
  var prevIncumbent = __jb.setIncumbent(globalThis);
  try {
    if (kind === "module") res = JSON.parse(__jb_native("evalModule", __jb.hostJson({ code: src ? null : code, filename: src || "inline-module.js", base: src || __jb.currentDocument.baseURI })) || "{}");
    else { var sn = typeof __jb.elementNonce === "function" ? __jb.elementNonce(s) : ""; res = JSON.parse(__jb_native("evalScript", __jb.hostJson({ code: code, filename: src || "inline-script.js", base: sn ? __jb.currentDocument.baseURI + "\u0001" + sn : __jb.currentDocument.baseURI })) || "{}"); }
  } catch (e) { res = { error: String(e) }; }
  // microtask checkpoint while the script is still currentScript (document scripts run from a task)
  if (__jb.runningDocumentScripts) __jb_native("runJobs", "");
  __jb.setIncumbent(prevIncumbent);
  __jb.currentDocument._jbCurrentScript = null;
  if (res && res.error) {
    if (res.fetch) return false;
    __jb.reportError(res.error, src || location.href);
  }
  return true;
};
// A classic script fetch of this realm (a controlled document's goes to its service worker first).
__jb.scriptFetch = function (url, el) {
  var sww = __jb.sw && /^https?:/.test(url) ? __jb.sw.controllerForRequest(url) : null;
  if (sww) {
    var co = el && el.getAttribute ? el.getAttribute("crossorigin") : null;
    var rec = __jb.sw.handleFetchSync(sww, { url: url, method: "GET", headers: { Accept: "*/*" }, mode: co === null ? "no-cors" : "cors", destination: "script", credentials: co === null || /^use-credentials$/i.test(co) ? "include" : "same-origin", redirect: "follow" }, globalThis, "");
    if (rec === false) return null;
    if (rec) return { status: rec.type === "opaque" ? 200 : rec.status, statusText: rec.statusText, headers: rec.headers || {}, url: rec.url || url, bodyBase64: __jb.bytesToB64(new Uint8Array(rec.body || [])) };
  }
  var co2 = el && el.getAttribute ? el.getAttribute("crossorigin") : null;
  return __jb.native("fetch", { url: url, method: "GET", headers: { Accept: "*/*" }, dest: "script", mode: co2 === null ? "no-cors" : "cors", credentials: co2 === null || /^use-credentials$/i.test(co2) ? "include" : "same-origin", referrerPolicy: el && __jb.elementReferrerPolicy ? __jb.elementReferrerPolicy(el) : "" });
};
__jb.runDocumentScriptElement = function (s) {
  s._executed = true;
  var kind = __jb.scriptKind(s);
  if (!kind) return;
  var src = null, code = null;
  if (s.hasAttribute("src")) {
    var attr = s.getAttribute("src");
    src = attr === "" ? "" : __jb.resolveURL(attr, s);
    if (!src) { __jb.fireUA(s, "error"); return; }
    if (typeof __jb.cspScriptVerdict === "function" && !__jb.cspScriptVerdict(s, src, "parser-inserted", kind === "module")) { __jb.fireUA(s, "error"); return; }
    if (kind !== "module") {
      var r = null;
      // WPT runner: frames get the runner's testdriver vendor shim, like the top-level test page.
      var vendor = typeof __jb.topJb === "function" && __jb.topJb().wptVendorSource;
      if (vendor && /\/resources\/testdriver-vendor\.js(\?|#|$)/.test(src)) r = { status: 200, text: vendor };
      else if (src.indexOf("data:") === 0) { var d = __jb.native("fetch", { url: src, method: "GET" }); r = d; }
      else r = __jb.scriptFetch(src, s);
      if (!r || !r.status || r.status >= 400) { __jb.fireUA(s, "error"); return; }
      code = r.text !== undefined ? r.text : __utf8Decode(__jb.b64ToBytes(r.bodyBase64 || ""));
    }
  } else {
    code = s.textContent;
    if (code.trim() === "" && kind !== "module") return;
    if (typeof __jb.cspScriptVerdict === "function" && !__jb.cspScriptVerdict(s, null, "parser-inserted", kind === "module")) return;
  }
  var ok = __jb.execScriptElement(s, src, code, kind);
  if (src || kind === "module") __jb.fireUA(s, ok ? "load" : "error");
};
// Scripts inserted by scripts of this realm (through __jb.pendingScripts).
__jb.drainPendingScriptsLocal = function () {
  for (var round = 0; round < 50; round++) {
    var list = JSON.parse(__jb.takePendingScripts());
    if (!list.length) return;
    list.forEach(function (item) {
      var el = __jb.pendingScriptEls[item.pending];
      var ok = true;
      __jb.beginPendingScript(item.pending);
      var cspOk = typeof __jb.cspScriptVerdict !== "function" || __jb.cspScriptVerdict(el, item.src === null ? null : item.src, "", !!item.module);
      if (!cspOk) ok = item.src !== null ? false : null;
      else if (item.src !== null) {
        if (item.src === "") ok = false;
        else if (item.module) ok = __jb.execScriptElement(el, item.src, null, "module");
        else {
          var r = __jb.scriptFetch(item.src, el);
          if (!r || !r.status || r.status >= 400) ok = false;
          else ok = __jb.execScriptElement(el, item.src, r.text !== undefined ? r.text : __utf8Decode(__jb.b64ToBytes(r.bodyBase64 || "")), "classic");
        }
      } else ok = __jb.execScriptElement(el, null, item.code, item.module ? "module" : "classic");
      __jb.endPendingScript(item.pending, ok === null ? null : item.src !== null || item.module ? ok : null);
    });
  }
};
__jb.runDocumentScripts = function () {
  __jb.runningDocumentScripts = true;
  try { __jb.runDocumentScriptsInner(); } finally { __jb.runningDocumentScripts = false; }
};
__jb.runDocumentScriptsInner = function () {
  var scripts = __jb.descendants(__jb.currentDocument, function (n) { return n.nodeType === 1 && n._tag === "script" && n._ns === __jb.HTML_NS && !n._executed; });
  var deferred = [];
  scripts.forEach(function (s) {
    if (s._executed) return;
    var kind = __jb.scriptKind(s);
    if (!kind || (kind !== "module" && s.hasAttribute("nomodule"))) { s._executed = true; return; }
    var isAsync = s.hasAttribute("async"), hasSrc = s.hasAttribute("src");
    if (!isAsync && (kind === "module" || (hasSrc && s.hasAttribute("defer")))) { deferred.push(s); return; }
    __jb.runDocumentScriptElement(s);
    __jb.drainPendingScriptsLocal();
    __jb_native("runJobs", "");
  });
  deferred.forEach(function (s) { if (!s._executed) { __jb.runDocumentScriptElement(s); __jb.drainPendingScriptsLocal(); __jb_native("runJobs", ""); } });
};

// ---- timers of child realms run from this realm's timer loop ----
(function () {
  var baseRun = __jb.runOneTimer;
  __jb.nextTimerDue = function () {
    var d = Infinity;
    __jb.timers.forEach(function (t) { if (t.due < d) d = t.due; });
    __jb.childRealms.forEach(function (c) { try { var cd = c.__jb.nextTimerDue(); if (cd < d) d = cd; } catch (e) {} });
    return d;
  };
  __jb.runOneTimer = function (limit) {
    var own = Infinity;
    __jb.timers.forEach(function (t) { if (t.due < own) own = t.due; });
    var best = null, bestDue = own;
    __jb.childRealms.forEach(function (c) { try { var cd = c.__jb.nextTimerDue(); if (cd < bestDue) { bestDue = cd; best = c; } } catch (e) {} });
    if (best) {
      if (limit !== undefined && limit !== null && bestDue > limit) return false;
      if (best.__jb.clock < __jb.clock) best.__jb.clock = __jb.clock;
      // the frame stays the incumbent for this task's microtasks (drained after we return)
      var ran = best.__jb.runOneTimer(limit);
      if (best.__jb.clock > __jb.clock) __jb.clock = best.__jb.clock;
      try { best.__jb.drainPendingScriptsLocal(); } catch (e2) {}
      return ran;
    }
    __jb.setIncumbent(globalThis);
    return baseRun(limit);
  };
  var baseTake = __jb.takePendingScripts;
  __jb.takePendingScripts = function () {
    __jb.childRealms.forEach(function (c) { try { c.__jb.drainPendingScriptsLocal(); } catch (e) {} });
    return baseTake();
  };
})();

// ---- navigation of a frame replaces its document ----
(function () {
  var baseNavigate = __jb.navigate;
  __jb.navigate = function (u, type) {
    var fc = __jb.frameContext;
    if ((!fc || !fc.frameElement) && !__jb.auxiliary) return baseNavigate(u, type);
    var target;
    try { target = new URL(String(u), __jb.currentDocument.baseURI).href; }
    catch (e) { throw __jb.domError("SyntaxError", "'" + u + "' is not a valid URL."); }
    if (!/^(https?|about|blob|data|file|javascript):/i.test(target)) return;
    if (target.indexOf("javascript:") === 0) { var inc = __jb.incumbent(), io = inc || globalThis; __jb.runJavascriptUrl(globalThis, target, io); return; }
    var me = globalThis;
    // The navigation's referrer is decided now: a hyperlink's, else the initiating document's.
    var navRef = __jb.topJb().pendingNavReferrer;
    if (navRef === undefined && typeof __jb.requestReferrer === "function") { try { var incw = __jb.incumbent() || globalThis; navRef = incw.__jb.requestReferrer(); } catch (er) { navRef = __jb.requestReferrer(); } }
    if (__jb.auxiliary) {
      // A popup replaces its own document (the creator's timer loop drives it).
      var creator = __jb.auxiliary.creator || globalThis;
      creator.setTimeout(function () { if (!me.closed) creator.__jb.loadRealmDocument(me, creator.__jb.withNavigationReferrer(navRef, function () { return creator.__jb.fetchSource(target, null, "document"); }), true); }, 0);
      return;
    }
    var pw = fc.parent, fe = fc.frameElement;
    // A navigation before the document is completely loaded (e.g. from onload) replaces.
    var replace = type === "replace" || __jb.completelyLoaded !== true;
    pw.setTimeout(function () { if (fe._contentWindow === me) pw.__jb.withNavigationReferrer(navRef, function () { pw.__jb.loadFrame(fe, target, replace); }); }, 0);
  };
})();

Object.defineProperty(history, "length", {
  get: function () {
    var fc = __jb.frameContext, top = fc && fc.top ? fc.top : globalThis;
    try { if (top !== globalThis) return top.history.length; } catch (e) {}
    return this._entries.length + (__jb.jointExtra || 0);
  },
  configurable: true, enumerable: true,
});

// ---- storage events: every other same-origin document sharing the area ----
__jb.rootRealm = function () {
  var w = globalThis;
  for (var i = 0; i < 64; i++) {
    var j = w.__jb, next = null;
    try { if (j.auxiliary && j.auxiliary.creator) next = j.auxiliary.creator; else if (j.frameContext && j.frameContext.parent) next = j.frameContext.parent; } catch (e) {}
    if (!next || next === w) break;
    w = next;
  }
  return w;
};
__jb.allRealmWindows = function () {
  var out = [], seen = [];
  (function walk(w) {
    if (!w || seen.indexOf(w) >= 0) return;
    seen.push(w); out.push(w);
    try { w.__jb.childRealms.forEach(walk); } catch (e) {}
  })(__jb.rootRealm());
  return out;
};
__jb.storageChanged = function (area, key, oldValue, newValue) {
  var me = globalThis, origin = location.origin, url = __jb.currentDocument.URL;
  if (origin === "null") return;
  __jb.allRealmWindows().forEach(function (w) {
    if (w === me) return;
    try {
      if (w.closed || w.location.origin !== origin || !w.document) return;
      // sessionStorage is per top-level browsing context.
      if (area === "sessionStorage") { var rt = typeof __jb.rawRelative === "function" ? function (x) { var t = x, n = 0; while (n++ < 64) { var p = __jb.rawRelative(t, "top"); if (!p || p === t) break; t = p; } return t; } : function (x) { return x.top; }; if (rt(w) !== rt(me)) return; }
      w.setTimeout(function () {
        var ev = new w.StorageEvent("storage", { key: key, oldValue: oldValue, newValue: newValue, url: url, storageArea: w[area] });
        __jb.setTrusted(ev, true); ev._trustedDispatch = true;
        w.dispatchEvent(ev);
      }, 0);
    } catch (e) {}
  });
};

// The origin of a window's document as postMessage reports it (inherited for
// about:blank/srcdoc, "null" when opaque); 62_crossorigin.js knows the details.
__jb.serializedOrigin = function (w) {
  if (typeof __jb.effectiveOrigin !== "function") return w.location.origin;
  var o = __jb.effectiveOrigin(w);
  return __jb.isOpaqueOrigin(o) ? "null" : o;
};

// ---- postMessage between realms ----
globalThis.postMessage = function (message, targetOrigin, transfer) {
  if (arguments.length < 1) throw new TypeError("postMessage: 1 argument required");
  var opts = targetOrigin !== null && typeof targetOrigin === "object" ? targetOrigin : { targetOrigin: targetOrigin, transfer: transfer };
  var target = __jb.isRealmWindow(this) ? this : globalThis;
  var caller = target.__jb.incumbent();
  var callerOrigin = "null";
  try { callerOrigin = __jb.serializedOrigin(caller); } catch (e2) {}
  var to = opts.targetOrigin === undefined ? "/" : String(opts.targetOrigin);
  if (to !== "*" && to !== "/") {
    var u; try { u = new URL(to); } catch (e3) { throw __jb.domError("SyntaxError", "Invalid target origin '" + to + "' in a call to 'postMessage'."); }
    if (u.origin !== __jb.serializedOrigin(target)) return;
  } else if (to === "/" && callerOrigin !== __jb.serializedOrigin(target)) return;
  // MessagePorts travel as the event's ports; other transferables are moved by structuredClone.
  var transfer = [], ports = [];
  if (opts.transfer !== undefined && opts.transfer !== null) {
    if (typeof opts.transfer[Symbol.iterator] !== "function") throw new TypeError("postMessage: transfer must be a sequence");
    __jb.arrayFrom(opts.transfer).forEach(function (t) { if (t && typeof t === "object" && typeof t.postMessage === "function" && typeof t.start === "function") ports.push(t); else transfer.push(t); });
  }
  var source = typeof target.__jb.wrapWindow === "function" ? target.__jb.wrapWindow(caller) : caller;
  if (typeof __jb.isWasmModule === "function" && __jb.isWasmModule(message)) {
    // Modules are shareable only inside one agent cluster.
    var sameCluster = true; try { sameCluster = __jb.agentClusterKey(caller) === __jb.agentClusterKey(target); } catch (ek) {}
    if (!sameCluster) {
      target.setTimeout(function () { var mev = new target.MessageEvent("messageerror", { data: null, origin: callerOrigin, source: source, ports: [], lastEventId: "" }); __jb.setTrusted(mev, true); mev._trustedDispatch = true; target.dispatchEvent(mev); }, 0);
      return;
    }
    var bytes = null; try { bytes = (caller.__jb.wasmBytes && caller.__jb.wasmBytes.get(message)) || __jb.wasmBytes.get(message) || null; } catch (eb) {}
    var mod = message; try { if (bytes) { mod = new target.WebAssembly.Module(bytes); target.__jb.wasmBytes.set(mod, bytes); } } catch (em) {}
    target.setTimeout(function () { var wev = new target.MessageEvent("message", { data: mod, origin: callerOrigin, source: source, ports: ports, lastEventId: "" }); __jb.setTrusted(wev, true); wev._trustedDispatch = true; target.dispatchEvent(wev); }, 0);
    return;
  }
  var data = target.structuredClone(message, { transfer: transfer });
  target.setTimeout(function () {
    var ev = new target.MessageEvent("message", { data: data, origin: callerOrigin, source: source, ports: ports, lastEventId: "" });
    __jb.setTrusted(ev, true); ev._trustedDispatch = true;
    target.dispatchEvent(ev);
  }, 0);
};

// ---- auxiliary browsing contexts: window.open ----
__jb.auxiliaryWindows = [];
__jb.findNamedContext = function (name) {
  if (!name || name === "_blank") return null;
  for (var i = 0; i < __jb.auxiliaryWindows.length; i++) { var a = __jb.auxiliaryWindows[i]; try { if (!a.closed && a.name === name) return a; } catch (e) {} }
  var frame = __jb.descendants(__jb.currentDocument, function (n) { return n.nodeType === 1 && n._ns === __jb.HTML_NS && (n._tag === "iframe" || n._tag === "frame") && n.getAttribute("name") === name && n._contentWindow; })[0];
  if (frame) return frame._contentWindow;
  if (globalThis.name === name) return globalThis;
  return null;
};
__jb.dropAuxiliary = function (g) {
  var i = __jb.auxiliaryWindows.indexOf(g);
  if (i >= 0) __jb.auxiliaryWindows.splice(i, 1);
  __jb.dropRealm(g);
};
globalThis.open = function (url, target, features) {
  if (__jb.ignoreOpensDuringUnload > 0) return null; // inside beforeunload / pagehide / unload
  url = url === undefined || url === null ? "" : String(url);
  target = target === undefined || target === null || String(target) === "" ? "_blank" : String(target);
  features = features === undefined || features === null ? "" : String(features).toLowerCase();
  // "tokenize the features argument": name up to separator, optional =value.
  var tokens = {};
  (function () {
    var i = 0, n = features.length, sep = /[ \t\n\r\f,=]/;
    while (i < n) {
      while (i < n && sep.test(features[i])) i++;
      var ns = i; while (i < n && !sep.test(features[i])) i++;
      var name = features.slice(ns, i);
      while (i < n && /[ \t\n\r\f]/.test(features[i])) i++;
      var value = "";
      if (i < n && features[i] === "=") {
        i++; while (i < n && /[ \t\n\r\f]/.test(features[i])) i++;
        var vs = i; while (i < n && !/[ \t\n\r\f,]/.test(features[i])) i++;
        value = features.slice(vs, i);
      }
      if (name) { if (name === "screenx") name = "left"; if (name === "screeny") name = "top"; if (name === "innerwidth") name = "width"; if (name === "innerheight") name = "height"; tokens[name] = value; }
    }
  })();
  var featureOn = function (name, missingDefault) {
    if (!(name in tokens)) return !!missingDefault;
    var v = tokens[name];
    if (v === "") return true;
    if (v === "yes" || v === "true") return true;
    var n = parseInt(v, 10); return !isNaN(n) && n !== 0;
  };
  var noopener = featureOn("noopener") || featureOn("noreferrer");
  var noreferrer = featureOn("noreferrer");
  delete tokens.noopener; delete tokens.noreferrer; // removed before the popup decision
  // "popup window is requested"
  var isPopup = (function () {
    if (Object.keys(tokens).length === 0) return false;
    if ("popup" in tokens) return featureOn("popup");
    if (!(featureOn("location") || featureOn("toolbar"))) return true;
    if (!featureOn("menubar")) return true;
    if (!featureOn("resizable", true)) return true;
    if (!featureOn("scrollbars")) return true;
    if (!featureOn("status")) return true;
    return false;
  })();
  if (noopener) isPopup = false; // noopener/noreferrer open a plain tab
  var resolved = "about:blank";
  if (url !== "") { try { resolved = new URL(url, __jb.currentDocument.baseURI).href; } catch (e) { throw __jb.domError("SyntaxError", "Unable to open a window with invalid URL '" + url + "'."); } }
  var jsUrl = null;
  if (resolved.indexOf("javascript:") === 0) { jsUrl = resolved; resolved = "about:blank"; }
  __jb.navigations.push({ type: "open", url: resolved });
  var existing = null;
  var lower = target.toLowerCase();
  if (lower === "_blank") target = "_blank";
  if (lower === "_self") existing = globalThis; else if (lower === "_parent") existing = globalThis.parent; else if (lower === "_top") existing = globalThis.top; else existing = __jb.findNamedContext(target);
  if (existing) {
    if (jsUrl) __jb.runJavascriptUrl(existing, jsUrl);
    else if (url !== "") { try { existing.__jb.navigate(resolved, "assign"); } catch (e) {} }
    return noopener ? null : existing;
  }
  var g = __jb.createFrameRealm(null, __jb.MAX_AUX_REALMS);
  if (!g) return null;
  g.__jb.frameContext = null;
  g.__jb.auxiliary = { opener: noopener ? null : globalThis, creator: globalThis, name: target === "_blank" ? "" : target };
  g.__jb.isPopupWindow = isPopup;
  // Popup geometry from the features ("rules for parsing integers"; an
  // error counts as 0, positions clamp at 0, sizes at the 100px minimum).
  if (isPopup) {
    var parseIntFeature = function (name) {
      if (!(name in tokens)) return null;
      var m = /^[\t\n\f\r ]*([+-]?)([0-9]+)/.exec(tokens[name]);
      if (!m) return 0;
      var n = parseInt(m[2], 10); return m[1] === "-" ? -n : n;
    };
    var left = parseIntFeature("left"), top = parseIntFeature("top"), width = parseIntFeature("width"), height = parseIntFeature("height");
    if (left !== null) { g.screenX = g.screenLeft = Math.max(0, left); }
    if (top !== null) { g.screenY = g.screenTop = Math.max(0, top); }
    if (width !== null) { g.innerWidth = g.outerWidth = Math.max(100, width); }
    if (height !== null) { g.innerHeight = g.outerHeight = Math.max(100, height); }
  }
  g.name = target === "_blank" ? "" : target;
  __jb.auxiliaryWindows.push(g);
  // The opener gets the window with its initial about:blank document at once;
  // the target document loads in a later task (its load event is observable).
  g.__jb.pendingReferrer = noreferrer ? "" : location.href;
  var initialBlank = /^about:blank([?#]|$)/.test(resolved);
  __jb.loadRealmDocument(g, __jb.fetchSource(initialBlank ? resolved : "about:blank"), true);
  if (jsUrl) __jb.runJavascriptUrl(g, jsUrl);
  if (!initialBlank) {
    var popRef = __jb.topJb().pendingNavReferrer;
    if (popRef === undefined) popRef = __jb.requestReferrer();
    if (noreferrer) popRef = { referrer: "", referrerPolicy: "no-referrer" };
    setTimeout(function () {
      if (g.closed) return;
      __jb.loadRealmDocument(g, __jb.withNavigationReferrer(popRef, function () { return __jb.fetchSource(resolved, null, "document"); }), true);
    }, 0);
  }
  return noopener ? null : g;
};
// "Follow the hyperlink": pick the target browsing context from the element's
// target (or <base target>), then navigate it. Fragment-only changes of the
// current document scroll instead of navigating.
__jb.followHyperlink = function (el, href) {
  var target = el.getAttribute("target");
  if (target === null || target === "") { var base = __jb.currentDocument.querySelector("base[target]"); target = base ? base.getAttribute("target") : ""; }
  target = String(target || "").trim();
  var lower = target.toLowerCase();
  var rel = " " + String(el.getAttribute("rel") || "").toLowerCase().split(/[\t\n\f\r ]+/).join(" ") + " ";
  var noreferrer = rel.indexOf(" noreferrer ") >= 0;
  // target=_blank implies noopener unless rel=opener.
  var noopener = noreferrer || rel.indexOf(" noopener ") >= 0 || (lower === "_blank" && rel.indexOf(" opener ") < 0);
  if (lower === "" || lower === "_self") {
    var cur = new URL(__jb.currentDocument.URL), url = new URL(href);
    // a fragment navigation also for an empty fragment (`href="#"`: url.hash is "" but the URL has a
    // fragment); before, such toggles (Trader Joe's store picker) reloaded the whole page
    if (url.href.split("#")[0] === cur.href.split("#")[0] && url.href.indexOf("#") >= 0) { location.hash = url.hash; return; }
    if (!__jb.frameContext && !__jb.auxiliary) { __jb.navigations.push({ type: "link", url: href, referrerPolicy: noreferrer ? "no-referrer" : __jb.elementReferrerPolicy(el) || __jb.documentReferrerPolicy() }); return; }
    __jb.navigate(href, "assign");
    return;
  }
  if (__jb.formSubmittedInTask) { try { var here = new URL(__jb.currentDocument.URL), there = new URL(href); if (here.href.split("#")[0] === there.href.split("#")[0]) return; } catch (ef) {} }
  var features = noreferrer ? "noreferrer" : noopener ? "noopener" : "";
  var linkRef = typeof __jb.requestReferrer === "function" ? __jb.requestReferrer(__jb.elementReferrerPolicy(el)) : undefined;
  if (linkRef && noreferrer) linkRef.referrerPolicy = "no-referrer";
  var openIt = function () { try { globalThis.open(href, target, features); } catch (e) { __jb.reportException(e); } };
  if (linkRef) __jb.withNavigationReferrer(linkRef, openIt); else openIt();
};
globalThis.close = function () {
  if (!__jb.auxiliary || __jb.closedFlag) return;
  __jb.closedFlag = true; // `closed` is true at once; unloading and discarding happen in a task
  var creator = __jb.auxiliary.creator;
  var me = globalThis;
  var unloadAndDiscard = function () {
    try { __jb.fireUA(me, "pagehide"); __jb.fireUA(me, "unload"); } catch (e) {}
    if (creator) creator.__jb.dropAuxiliary(me); else { if (__jb.auxiliary) __jb.auxiliary.opener = null; }
  };
  if (creator) creator.setTimeout(unloadAndDiscard, 0); else setTimeout(unloadAndDiscard, 0);
};
Object.defineProperty(globalThis, "closed", { get: function () { return !!__jb.closedFlag; }, configurable: true, enumerable: true });
Object.defineProperty(globalThis, "opener", {
  get: function () { if (__jb.openerOverride !== undefined) return __jb.openerOverride; return __jb.auxiliary ? __jb.auxiliary.opener : null; },
  set: function (v) { __jb.openerOverride = v; },
  configurable: true, enumerable: true,
});

// ---- window.frames is the window itself; frames are its indexed properties ----
__jb.syncFrameIndices = function () {
  var ws = __jb.frameWindows(__jb.currentDocument);
  for (var i = 0; i < ws.length; i++) {
    (function (idx) {
      try { Object.defineProperty(globalThis, String(idx), { get: function () { if (__jb.closedFlag) return undefined; var fw = __jb.frameWindows(__jb.currentDocument)[idx]; return typeof __jb.wrapWindow === "function" ? __jb.wrapWindow(fw) : fw; }, set: function () {}, configurable: true, enumerable: true }); } catch (e) {}
    })(i);
  }
  var n = ws.length;
  while (Object.prototype.hasOwnProperty.call(globalThis, String(n))) { try { delete globalThis[String(n)]; } catch (e) { break; } n++; }
};
__jb.replaceable(globalThis, "frames", function () { return globalThis; });
(function () {
  var baseLoad = __jb.loadFrame;
  __jb.loadFrame = function (iframe, explicitUrl, replace) { var r = baseLoad(iframe, explicitUrl, replace); __jb.syncFrameIndices(); return r; };
  __jb.iframeDisconnected = function (iframe) {
    var w = iframe._contentWindow;
    if (w && __jb.isRealmWindow(w)) { try { w.__jb.closedFlag = true; } catch (e) {} __jb.dropRealm(w); }
    iframe._contentWindow = null; iframe._contentDocument = null;
    iframe._bc = null; // re-insertion creates a new browsing context
    __jb.syncFrameIndices();
  };
  var baseDrop = __jb.dropRealm;
  __jb.dropRealm = function (g) {
    try {
      if (g.__jb.auxiliary) g.__jb.auxiliary.opener = null;
      g.__jb.closedFlag = true;
      g.__jb.discardedFlag = true;
      // The discarded document's own frames are discarded with it.
      g.__jb.descendants(g.document, function (n) { return n.nodeType === 1 && (n._tag === "iframe" || n._tag === "frame") && n._contentWindow; }).forEach(function (f) { try { g.__jb.iframeDisconnected(f); } catch (e) {} });
    } catch (e) {}
    baseDrop(g);
  };
  // A discarded browsing context exposes no child navigables.
  __jb.replaceable(globalThis, "length", function () { return __jb.closedFlag ? 0 : __jb.frameWindows(__jb.currentDocument).length; });
})();

// ---- Origin (URL Standard): tuple/opaque origins with same-origin / same-site checks ----
__jb.originSeq = 0;
__jb.registrableDomain = function (host) {
  // Approximation of the public-suffix rule: the last two labels, or three for
  // second-level public suffixes such as co.uk / com.au; IP literals as-is.
  if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.charAt(0) === "[") return host;
  var labels = host.split(".");
  if (labels.length <= 2) return host;
  var sld = labels[labels.length - 2], tld = labels[labels.length - 1];
  var multi = /^(co|com|org|net|gov|edu|ac|nhs|police|sch|ltd|plc|me|or|ne|go|gr|ed|lg|nom|gob|mil)$/.test(sld) && tld.length === 2;
  return labels.slice(multi ? -3 : -2).join(".");
};
class Origin {
  constructor() {
    // A fresh opaque origin.
    this._opaque = true; this._id = ++__jb.originSeq; this._scheme = ""; this._host = ""; this._port = null;
  }
  static from(value) {
    if (arguments.length < 1) throw new TypeError("Origin.from: 1 argument required");
    // A cross-origin Location is still a Location (checked before touching it).
    if (value && typeof value === "object" && __jb.xoLocationSet && __jb.xoLocationSet.has(value)) throw new TypeError("Origin.from: Location objects are not accepted");
    if (value instanceof Origin || (value && typeof value === "object" && typeof value.isSameOrigin === "function" && "opaque" in value)) {
      var copy = new Origin();
      copy._opaque = !!value.opaque; copy._id = value._id; copy._scheme = value._scheme || ""; copy._host = value._host || ""; copy._port = value._port === undefined ? null : value._port;
      return copy;
    }
    var href;
    if (value && typeof value === "object") {
      var isLocation = !value.nodeType && typeof value.assign === "function" && typeof value.replace === "function" && typeof value.reload === "function" && "hash" in value;
      if (isLocation) throw new TypeError("Origin.from: Location objects are not accepted");
      var fromOriginString = function (o) { o = String(o); if (o === "null" || o === "" || o === "undefined") return new Origin(); try { return Origin.from(o + "/"); } catch (e) { return new Origin(); } };
      if (__jb.isRealmWindow(value)) { var lo = null; try { lo = value.location.origin; } catch (e) { lo = null; } return fromOriginString(lo); }
      if (typeof value.type === "string" && typeof value.origin === "string" && "data" in value) return fromOriginString(value.origin); // MessageEvent
      if (value.nodeType === 1) {
        // HyperlinkElementUtils / SVGAElement: the resolved href of the element.
        var raw = typeof value.href === "string" ? value.href : (value.href && typeof value.href.baseVal === "string" ? value.href.baseVal : null);
        if (raw === null || (value.href && typeof value.href.baseVal === "string")) { var attr = value.getAttribute("href") !== null ? value.getAttribute("href") : (value.getAttributeNS ? value.getAttributeNS("http://www.w3.org/1999/xlink", "href") : null); if (attr === null && raw === null) throw new TypeError("Origin.from: element has no href"); if (attr !== null) raw = attr; try { raw = new URL(raw, value.ownerDocument.baseURI).href; } catch (e) {} }
        href = raw;
      }
      else if ("href" in value) href = String(value.href);
      else href = String(value);
    } else href = String(value);
    var u;
    try { u = new URL(href); } catch (e) { throw new TypeError("Origin.from: '" + href + "' is not a valid URL"); }
    var out = new Origin();
    if (u.protocol === "blob:") {
      try { var inner = new URL(u.pathname); if (/^(https?|wss?|ftp|file):$/.test(inner.protocol) && inner.origin !== "null") { u = inner; } else { return out; } } catch (e) { return out; }
    }
    if (/^(https?|wss?|ftp):$/.test(u.protocol) && u.hostname) {
      out._opaque = false; out._scheme = u.protocol.slice(0, -1); out._host = u.hostname; out._port = u.port === "" ? null : Number(u.port);
    }
    return out;
  }
  get opaque() { return this._opaque; }
  isSameOrigin(other) {
    if (!(other && typeof other === "object" && "opaque" in other)) throw new TypeError("isSameOrigin: argument is not an Origin");
    if (this._opaque || other.opaque) return this._opaque && other.opaque && this._id === other._id;
    return this._scheme === other._scheme && this._host === other._host && this._port === other._port;
  }
  isSameSite(other) {
    if (!(other && typeof other === "object" && "opaque" in other)) throw new TypeError("isSameSite: argument is not an Origin");
    if (this._opaque || other.opaque) return this.isSameOrigin(other);
    return this._scheme === other._scheme && __jb.registrableDomain(this._host) === __jb.registrableDomain(other._host);
  }
  toJSON() { return this._opaque ? "null" : this._scheme + "://" + this._host + (this._port === null ? "" : ":" + this._port); }
  toString() { return this.toJSON(); }
}
globalThis.Origin = Origin;
Object.defineProperty(globalThis, "Origin", { enumerable: false });
