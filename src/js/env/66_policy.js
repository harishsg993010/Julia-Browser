// ---------------------------------------------------------------- policy container: referrer policy
// Each document (and worker) has a policy container: its referrer policy and CSP list. Documents
// loaded from about:blank, about:srcdoc and blob: URLs inherit their creator's; others take the
// response's headers (plus <meta> elements). Requests carry a referrer source and policy to the host,
// which computes the Referer of every hop (src/http.rs determine_referrer).
__jb.REFERRER_POLICIES = ["no-referrer", "no-referrer-when-downgrade", "same-origin", "origin", "strict-origin", "origin-when-cross-origin", "strict-origin-when-cross-origin", "unsafe-url"];
__jb.LEGACY_REFERRER = { never: "no-referrer", "default": "strict-origin-when-cross-origin", always: "unsafe-url", "origin-when-crossorigin": "origin-when-cross-origin" };
__jb.parseReferrerPolicyToken = function (v) {
  if (v === null || v === undefined) return "";
  v = String(v).trim().toLowerCase();
  return __jb.REFERRER_POLICIES.indexOf(v) >= 0 ? v : "";
};
// The response headers of this realm's document ({} when none were recorded).
__jb.documentResponseHeaders = function () {
  try { return (__jb.currentDocument && __jb.currentDocument._responseHeaders) || {}; } catch (e) { return {}; }
};
// Whether the realm's document inherits its creator's policy container.
__jb.inheritsPolicyContainer = function () {
  var u = "";
  try { u = __jb.currentDocument.URL; } catch (e) { return false; }
  return /^(about:(blank|srcdoc)([?#]|$)|blob:|data:)/i.test(u) || !!__jb.policyFromCreator;
};
// The document's referrer policy: the last valid <meta name=referrer> (legacy keywords mapped),
// else the Referrer-Policy header's last valid token, else the inherited policy, else "".
__jb.documentReferrerPolicy = function () {
  var policy = "";
  if (__jb.isWorker && __jb.workerReferrerPolicy !== undefined) policy = __jb.workerReferrerPolicy;
  var h = __jb.documentResponseHeaders();
  var hv = h["referrer-policy"] || h["Referrer-Policy"];
  if (hv) String(hv).split(",").forEach(function (t) { t = __jb.parseReferrerPolicyToken(t); if (t) policy = t; });
  if (!policy && __jb.inheritedReferrerPolicy) policy = __jb.inheritedReferrerPolicy;
  try {
    // The <meta name=referrer> scan is cached per DOM version: every image request asks, and a
    // full-document query per image ate Vijay Sales' whole script budget.
    var doc = __jb.currentDocument, mc = doc._jbMetaReferrer;
    if (!mc || mc.version !== __jb.domVersion) {
      var metaPolicy = "";
      var metas = doc.querySelectorAll("meta[name]");
      for (var i = 0; i < metas.length; i++) {
        var m = metas[i];
        if ((m.getAttribute("name") || "").trim().toLowerCase() !== "referrer") continue;
        var c = (m.getAttribute("content") || "").trim().toLowerCase();
        if (__jb.LEGACY_REFERRER[c]) c = __jb.LEGACY_REFERRER[c];
        if (__jb.REFERRER_POLICIES.indexOf(c) >= 0) metaPolicy = c;
      }
      mc = { version: __jb.domVersion, policy: metaPolicy };
      Object.defineProperty(doc, "_jbMetaReferrer", { value: mc, writable: true, configurable: true });
    }
    if (mc.policy) policy = mc.policy;
  } catch (e) {}
  return policy;
};
// Fetch "determine request's referrer", step "client": the URL requests of this realm report
// ("" = no referrer). Opaque-origin documents send none; srcdoc documents use their container's.
__jb.referrerSourceUrl = function () {
  try {
    if (__jb.opaqueOrigin) return "";
    var u = __jb.currentDocument.URL;
    if (/^about:srcdoc([?#]|$)/.test(u)) {
      var fc = __jb.frameContext, pj = fc && fc.parent && fc.parent.__jb;
      if (pj && pj !== __jb && typeof pj.referrerSourceUrl === "function") return pj.referrerSourceUrl();
      return "";
    }
    if (__jb.isWorker && __jb.workerScriptUrl) return __jb.workerScriptUrl;
    return /^https?:/i.test(u) ? u : "";
  } catch (e) { return ""; }
};
// {referrer, referrerPolicy} for a request from this realm. `policy` is the request's own
// referrer policy (an element's referrerpolicy attribute, a Request's init), "" for the document's.
__jb.requestReferrer = function (policy) {
  var p = __jb.parseReferrerPolicyToken(policy);
  if (!p) p = __jb.documentReferrerPolicy();
  var origin; try { origin = __jb.opaqueOrigin ? "null" : location.origin; } catch (e) { origin = undefined; }
  return { referrer: __jb.referrerSourceUrl(), referrerPolicy: p, origin: origin };
};
// The element's referrerpolicy attribute ("" when missing or invalid).
__jb.elementReferrerPolicy = function (el) {
  try { return __jb.parseReferrerPolicyToken(el && el.getAttribute ? el.getAttribute("referrerpolicy") : ""); } catch (e) { return ""; }
};
// A navigation started by a hyperlink/form/refresh carries its own referrer to fetchSource.
__jb.withNavigationReferrer = function (ref, fn) {
  var tj = __jb.topJb(), prev = tj.pendingNavReferrer;
  tj.pendingNavReferrer = ref;
  try { return fn(); } finally { tj.pendingNavReferrer = prev; }
};
__jb.takeNavigationReferrer = function () {
  var tj = __jb.topJb(), r = tj.pendingNavReferrer;
  tj.pendingNavReferrer = undefined;
  return r;
};

// Loading a document into a realm decides its policy container.
(function () {
  var baseLoad = __jb.loadRealmDocument;
  __jb.loadRealmDocument = function (g, source, allowScripts) {
    try {
      var gj = g.__jb, u = source.url || "";
      gj.inheritedReferrerPolicy = "";
      gj.inheritedCsp = null;
      gj.pendingResponseHeaders = source.headers || null;
      // service worker control: the worker that handled (or matches) the navigation
      if (__jb.sw) { var tjc0 = __jb.topJb(); if (tjc0.pendingSwClientId) gj.clientId = tjc0.pendingSwClientId; tjc0.pendingSwClientId = undefined; }
      if (__jb.sw) { var tjc = __jb.topJb(); gj.pendingSwController = tjc.pendingNavController !== undefined ? tjc.pendingNavController : undefined; tjc.pendingNavController = undefined; __jb.sw.assignController(g, u, globalThis); }
      if (/^(about:(blank|srcdoc)([?#]|$)|blob:|data:)/i.test(u) || source.inheritPolicy) {
        // inherited from the creator (the realm running this load)
        gj.inheritedReferrerPolicy = __jb.documentReferrerPolicy();
        if (typeof __jb.cspPolicies === "function") gj.inheritedCsp = __jb.cspPolicies().slice();
      }
    } catch (e) {}
    return baseLoad(g, source, allowScripts);
  };
})();
