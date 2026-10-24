// Part 6e: session history. Each top-level traversable (the page, or a popup)
// keeps one joint session history: its navigables (itself and its frames,
// keyed by their browsing-context records) own entry lists, entries sit on
// shared "steps", and history.length / back() / forward() / go() work on the
// used steps. Applying a step updates every navigable whose entry changes:
// within one document that is popstate (+ hashchange), across documents the
// navigable loads the entry's URL again (no bfcache). Fragment navigations
// and pushState/replaceState add or replace entries; navigating a document
// away fires beforeunload, pagehide and unload.
__jb.docSeq = __jb.docSeq || 0;
__jb.newDocId = function () { var tj = __jb.topJb(); tj.docSeqShared = (tj.docSeqShared || 0) + 1; return tj.docSeqShared; };
__jb.traversableRoot = function () {
  var w = globalThis;
  for (var i = 0; i < 64; i++) {
    var fc = w.__jb.frameContext;
    if (!fc || !fc.parent || fc.parent === w) break;
    w = fc.parent;
  }
  return w;
};
__jb.sessionHistory = function () {
  var rj = __jb.traversableRoot().__jb;
  if (!rj.sh) rj.sh = { nextStep: 1, current: 0, navs: [], busy: false };
  return rj.sh;
};
__jb.entryAt = function (bc, step) {
  var es = bc.entries || [], found = null;
  for (var i = 0; i < es.length; i++) if (es[i].step <= step) found = es[i];
  return found;
};
__jb.usedSteps = function (sh) {
  var seen = {}, out = [];
  sh.navs.forEach(function (bc) { (bc.entries || []).forEach(function (e) { if (!seen[e.step]) { seen[e.step] = 1; out.push(e.step); } }); });
  if (!seen[sh.current]) out.push(sh.current);
  return out.sort(function (a, b) { return a - b; });
};
// The navigable's initial entry, on the current step.
__jb.ensureNav = function (bc, url, docId) {
  var sh = __jb.sessionHistory();
  if (sh.navs.indexOf(bc) < 0) sh.navs.push(bc);
  if (!bc.entries || !bc.entries.length) bc.entries = [{ step: sh.current, url: url, state: null, docId: docId || __jb.newDocId(), scrollRestoration: "auto" }];
  return __jb.entryAt(bc, sh.current) || bc.entries[0];
};
__jb.pushEntry = function (bc, fields) {
  var sh = __jb.sessionHistory();
  if (sh.navs.indexOf(bc) < 0) sh.navs.push(bc);
  // Navigating forward from the current step prunes every later step.
  sh.navs.forEach(function (n) { if (n.entries) n.entries = n.entries.filter(function (e) { return e.step <= sh.current; }); });
  var step = sh.nextStep++;
  var e = { step: step, url: fields.url, state: fields.state === undefined ? null : fields.state, docId: fields.docId, scrollRestoration: "auto" };
  (bc.entries = bc.entries || []).push(e);
  sh.current = step;
  return e;
};
__jb.replaceEntry = function (bc, fields) {
  var sh = __jb.sessionHistory();
  var e = __jb.ensureNav(bc, fields.url, fields.docId);
  e.url = fields.url;
  if ("state" in fields) e.state = fields.state === undefined ? null : fields.state;
  if (fields.docId) e.docId = fields.docId;
  return e;
};
__jb.removeNav = function (bc) {
  var sh = __jb.sessionHistory();
  var i = sh.navs.indexOf(bc);
  if (i >= 0) sh.navs.splice(i, 1);
  bc.entries = [];
  // A removed navigable's steps disappear; the current step stays a used step.
};
// This realm's navigable and its current entry.
__jb.myNav = function () { return __jb.bcOf(globalThis); };
__jb.myEntry = function () {
  var bc = __jb.myNav();
  if (__jb.docId === undefined) __jb.docId = __jb.newDocId();
  var e = __jb.ensureNav(bc, __jb.currentDocument.URL, __jb.docId);
  return e;
};

// ---- the current document's URL and state ----
__jb.setDocumentUrl = function (url) {
  location._url = new URL(url);
  __jb.currentDocument.URL = __jb.currentDocument.documentURI = location._url.href;
};
__jb.historyState = null;

// ---- unloading ----
__jb.fireUnload = function (w) {
  try {
    if (!w || w.__jb.unloadFired === w.document) return;
    w.__jb.unloadFired = w.document;
    // The document unloads first, then its descendants; opens and writes are ignored meanwhile.
    w.__jb.ignoreOpensDuringUnload = (w.__jb.ignoreOpensDuringUnload || 0) + 1;
    try {
      var ph = new w.PageTransitionEvent("pagehide", { persisted: false }); __jb.setTrusted(ph, true); ph._trustedDispatch = true; ph._legacyTarget = w.document;
      try { w.dispatchEvent(ph); } catch (e1) { w.__jb.reportException(e1); }
      var ul = new w.Event("unload"); __jb.setTrusted(ul, true); ul._trustedDispatch = true; ul._legacyTarget = w.document;
      try { w.dispatchEvent(ul); } catch (e2) { w.__jb.reportException(e2); }
      // The counter stays raised while the descendants unload.
      __jb.rawChildren(w).forEach(function (c) { __jb.fireUnload(c); });
    } finally { w.__jb.ignoreOpensDuringUnload--; }
  } catch (e) {}
};
// beforeunload: true when the document asks to stay (returnValue / preventDefault).
__jb.fireBeforeUnload = function (w) {
  var stay = false;
  try {
    w.__jb.constructingUA = true;
    var ev; try { ev = new w.BeforeUnloadEvent("beforeunload", { cancelable: true }); } finally { w.__jb.constructingUA = false; }
    __jb.setTrusted(ev, true); ev._trustedDispatch = true;
    w.__jb.ignoreOpensDuringUnload = (w.__jb.ignoreOpensDuringUnload || 0) + 1;
    try { w.dispatchEvent(ev); } finally { w.__jb.ignoreOpensDuringUnload--; }
    stay = ev.defaultPrevented || (typeof ev.returnValue === "string" && ev.returnValue !== "");
  } catch (e) {}
  // Descendant documents get it too.
  __jb.rawChildren(w).forEach(function (c) { if (__jb.fireBeforeUnload(c)) stay = true; });
  return stay;
};

// ---- applying a history step ----
__jb.applyHistoryStep = function (targetStep) {
  var sh = __jb.sessionHistory();
  var prev = sh.current;
  if (targetStep === prev) return;
  sh.current = targetStep;
  sh.navs.slice().forEach(function (bc) {
    if (!bc.entries || !bc.entries.length) return;
    var te = __jb.entryAt(bc, targetStep), ce = __jb.entryAt(bc, prev);
    if (!te || te === ce) return;
    var w = bc.current;
    if (!w) return;
    try { if (w.closed) return; } catch (e) { return; }
    var wj = w.__jb;
    if (te.docId === wj.docId) wj.restoreSameDocumentEntry(te, ce);
    else __jb.restoreCrossDocumentEntry(bc, w, te);
  });
};
// Same document: new URL and state, popstate, then hashchange in a task.
__jb.restoreSameDocumentEntry = function (te, ce) {
  var oldUrl = __jb.currentDocument.URL;
  __jb.setDocumentUrl(te.url);
  __jb.historyState = te.state;
  __jb.firePopstate(te.state);
  if (oldUrl !== te.url && oldUrl.split("#")[0] === te.url.split("#")[0]) __jb.queueHashchange(oldUrl, te.url);
};
__jb.firePopstate = function (state) {
  var ev = new PopStateEvent("popstate", { state: state, hasUAVisualTransition: false });
  __jb.setTrusted(ev, true); ev._trustedDispatch = true;
  globalThis.dispatchEvent(ev);
};
__jb.queueHashchange = function (oldUrl, newUrl) {
  setTimeout(function () {
    var ev = new HashChangeEvent("hashchange", { oldURL: oldUrl, newURL: newUrl });
    __jb.setTrusted(ev, true); ev._trustedDispatch = true;
    globalThis.dispatchEvent(ev);
  }, 0);
};
// Another document: load the entry's URL into the navigable again.
__jb.restoreCrossDocumentEntry = function (bc, w, te) {
  var wj = w.__jb;
  var fc = wj.frameContext;
  if (fc && fc.frameElement) {
    var iframe = fc.frameElement, pw = fc.parent;
    iframe._traversalEntry = te;
    try { pw.__jb.loadFrame(iframe, te.url, true); } catch (e) { __jb.reportException(e); }
    return;
  }
  if (wj.auxiliary) {
    var creator = wj.auxiliary.creator || globalThis;
    wj.pendingTraversal = te;
    try { creator.__jb.loadRealmDocument(w, creator.__jb.fetchSource(te.url, null, "document"), true); } catch (e2) { __jb.reportException(e2); }
    return;
  }
  // The top-level page itself: hand the traversal to the host as a navigation.
  wj.navigations.push({ type: "traverse", url: te.url });
};

// ---- loading documents: entries, document ids, unload ----
(function () {
  var baseLoadDoc = __jb.loadRealmDocument;
  __jb.loadRealmDocument = function (g, source, allowScripts) {
    var gj = g.__jb;
    var hadDoc = false; try { hadDoc = !!g.document && gj.docId !== undefined; } catch (e) {}
    // A popup replacing its document unloads the old one first. Its global is
    // reused, so the old document's listeners and handlers go with it (a new
    // document gets a new Window; only the initial about:blank hands its Window on).
    if (hadDoc && !gj.frameContext) {
      __jb.fireUnload(g);
      if (!gj.initialAboutBlank) {
        try {
          g._jbListeners = Object.create(null);
          (gj.EVENT_HANDLER_NAMES || []).concat(gj.WINDOW_HANDLER_NAMES || []).forEach(function (n) { try { g["on" + n] = null; } catch (e) {} });
        } catch (e4) {}
      }
    }
    var trav = gj.pendingTraversal; gj.pendingTraversal = null;
    var prevOrigin = null; try { if (hadDoc && !gj.frameContext && !gj.initialAboutBlank) prevOrigin = __jb.effectiveOrigin(g); } catch (e5) {}
    var pend = gj.bc && gj.bc.pendingDocId;
    if (gj.bc) gj.bc.pendingDocId = null;
    gj.docId = trav ? trav.docId : (pend || __jb.newDocId());
    gj.historyState = trav ? trav.state : null;
    gj.unloadFired = null;
    var r = baseLoadDoc(g, source, allowScripts);
    try {
      // A top-level traversable's initial about:blank is its first, blank document (frames decide in loadFrame).
      if (!gj.frameContext) gj.initialAboutBlank = !hadDoc && !!source.blank;
      if (prevOrigin !== null) { var nowOrigin = __jb.effectiveOrigin(g); if (nowOrigin !== prevOrigin) __jb.bcOf(g).name = ""; }
      // Popups record their own entries here (frames do it in loadFrame).
      if (!gj.frameContext && gj.auxiliary) {
        var bc = __jb.bcOf(g);
        var url = g.document.URL;
        if (trav) { trav.url = url; }
        else if (!bc.entries || !bc.entries.length) __jb.ensureNav(bc, url, gj.docId);
        else if (gj.auxAddsEntry) { __jb.pushEntryIn(g, bc, { url: url, docId: gj.docId }); }
        else __jb.replaceEntryIn(g, bc, { url: url, docId: gj.docId, state: null });
        gj.auxAddsEntry = false;
      }
    } catch (e3) { __jb.reportException(e3); }
    return r;
  };
})();
// Entries of a popup live in the popup's own traversable.
__jb.pushEntryIn = function (g, bc, f) { return g.__jb.pushEntry(bc, f); };
__jb.replaceEntryIn = function (g, bc, f) { return g.__jb.replaceEntry(bc, f); };

(function () {
  var baseLoadFrame = __jb.loadFrame;
  // the frame loader without session-history bookkeeping (a service worker's response commits the
  // navigation the bookkeeping was already done for)
  __jb.loadFrameCore = baseLoadFrame;
  // Once the containing document has loaded, a frame navigation is a task:
  // the frame shows its initial about:blank right away (without a load event
  // when a URL follows) and the target document arrives later. Frames of a
  // document that is still loading load synchronously, so the window's load
  // event keeps coming after its frames'.
  var needsFetch = function (iframe, explicitUrl) {
    if (explicitUrl === undefined && iframe.getAttribute("srcdoc") !== null) return true;
    var raw = explicitUrl !== undefined ? explicitUrl : iframe.getAttribute("src");
    if (raw === null || raw === undefined || String(raw).trim() === "") return false;
    var u; try { u = new URL(String(raw).trim(), iframe.ownerDocument.URL).href; } catch (e) { return false; }
    return !/^(about|javascript):/.test(u);
  };
  __jb.loadFrame = function (iframe, explicitUrl, replace) {
    var parentLoaded = __jb.currentDocument.readyState === "complete" && (!__jb.frameContext || __jb.completelyLoaded === true);
    if (iframe._traversalEntry || iframe._loadingNow || !parentLoaded || !needsFetch(iframe, explicitUrl)) return loadNow(iframe, explicitUrl, replace);
    if (!iframe._contentWindow) {
      iframe._loadingNow = true;
      try { loadNow(iframe, "about:blank", true); } finally { iframe._loadingNow = false; }
      iframe._loadToken = (iframe._loadToken || 0) + 1; // no load event for that about:blank
    }
    var token = iframe._navToken = (iframe._navToken || 0) + 1;
    iframe._loadToken = (iframe._loadToken || 0) + 1;
    try { var cur = iframe._contentWindow; if (cur && __jb.isRealmWindow(cur)) cur.__jb.navGen = (cur.__jb.navGen || 0) + 1; } catch (e3) {}
    setTimeout(function () {
      if (iframe._navToken !== token || !iframe.isConnected) return;
      iframe._loadingNow = true;
      try { loadNow(iframe, explicitUrl, replace); } finally { iframe._loadingNow = false; }
    }, 0);
  };
  var loadNow = function (iframe, explicitUrl, replace) {
    var trav = iframe._traversalEntry; iframe._traversalEntry = null;
    var old = iframe._contentWindow;
    var oldIsRealm = !!old && __jb.isRealmWindow(old);
    // javascript: URLs run in the current document: no entry, no unload.
    var rawSrc = explicitUrl !== undefined ? explicitUrl : (iframe.getAttribute("srcdoc") === null ? iframe.getAttribute("src") : null);
    var target = "about:blank";
    if (explicitUrl === undefined && iframe.getAttribute("srcdoc") !== null) target = "about:srcdoc";
    else if (rawSrc !== null && rawSrc !== undefined && String(rawSrc).trim() !== "") { try { target = new URL(String(rawSrc).trim(), iframe.ownerDocument.URL).href; } catch (e) { target = "about:blank"; } }
    if (target.indexOf("javascript:") === 0 && oldIsRealm) return baseLoadFrame(iframe, explicitUrl, replace);
    var bc = iframe._bc || (iframe._bc = { current: oldIsRealm ? old : null });
    var adds = !trav && oldIsRealm && __jb.frameNavAddsEntry(iframe, replace);
    if (oldIsRealm) { __jb.fireBeforeUnload(old); __jb.fireUnload(old); }
    var e;
    if (trav) e = trav;
    else if (!bc.entries || !bc.entries.length || !oldIsRealm) { bc.entries = []; e = __jb.ensureNav(bc, target); }
    else if (adds) e = __jb.pushEntry(bc, { url: target, docId: __jb.newDocId() });
    else { e = __jb.replaceEntry(bc, { url: target, docId: __jb.newDocId(), state: null }); }
    bc.pendingDocId = e.docId;
    iframe._swNavPending = false;
    iframe._historyNav = !!trav;
    var r = baseLoadFrame(iframe, explicitUrl, replace);
    iframe._historyNav = false;
    var after = function () {
      try {
        var w = iframe._contentWindow;
        if (w && __jb.isRealmWindow(w)) {
          e.url = w.document.URL;
          w.__jb.docId = e.docId;
          if (trav) w.__jb.historyState = trav.state;
        }
      } catch (e2) {}
    };
    // a service worker is answering: the document arrives later
    if (iframe._swNavPending) iframe._swCommitHook = after; else after();
    return r;
  };
  var baseDisconnected = __jb.iframeDisconnected;
  __jb.iframeDisconnected = function (iframe) {
    var bc = iframe._bc;
    // Removal does not run script synchronously, except under document.open().
    if (__jb.inDocumentOpen > 0) { var w0 = iframe._contentWindow; if (w0 && __jb.isRealmWindow(w0)) __jb.fireUnload(w0); }
    // Visited set: a frame window can be reachable twice (or be its parent's own window when the
    // realm cap is hit), which recursed until the stack overflowed (weather.com's ad iframes:
    // 15 s per removal).
    var seen = new Set();
    var removeTree = function (b) {
      if (!b || seen.has(b)) return;
      seen.add(b);
      try { var cw = b.current; if (cw && __jb.isRealmWindow(cw) && !seen.has(cw)) { seen.add(cw); __jb.rawChildren(cw).forEach(function (c) { try { removeTree(c.__jb.bc); } catch (e) {} }); } } catch (e2) {}
      __jb.removeNav(b);
    };
    removeTree(bc);
    return baseDisconnected(iframe);
  };
})();

// ---- fragment navigations ----
__jb.fragmentNavigate = function (url, replace) {
  var fragDirective = null;
  if (__jb.splitFragmentDirective) { var fsp = __jb.splitFragmentDirective(url); url = fsp.url; fragDirective = fsp.directive; }
  __jb.currentDocument._targetOverride = null;
  var oldUrl = __jb.currentDocument.URL;
  var bc = __jb.myNav();
  __jb.myEntry();
  var doReplace = replace || __jb.completelyLoaded === false && !!__jb.frameContext;
  __jb.setDocumentUrl(url);
  __jb.historyState = null;
  if (doReplace) __jb.replaceEntry(bc, { url: url, state: null });
  else __jb.pushEntry(bc, { url: url, state: null, docId: __jb.docId });
  __jb.firePopstate(null);
  if (oldUrl !== url) __jb.queueHashchange(oldUrl, url);
  if (fragDirective !== null && __jb.applyTextDirectives) { var fdoc = __jb.currentDocument; fdoc._fragmentDirective = fragDirective; setTimeout(function () { if (!__jb.applyTextDirectives(fdoc) && __jb.navApi && __jb.navApi.scrollToFragment && fdoc.URL.indexOf("#") >= 0 && fdoc.URL.split("#")[1]) __jb.navApi.scrollToFragment(fdoc.URL); }, 0); }
};
__jb.isFragmentNavigation = function (target) {
  try {
    var cur = new URL(__jb.currentDocument.URL), u = new URL(target);
    // a non-null fragment (possibly empty: "#") on the same URL
    return u.href.indexOf("#") >= 0 && u.href.split("#")[0] === cur.href.split("#")[0];
  } catch (e) { return false; }
};
(function () {
  var baseNavigate = __jb.navigate;
  __jb.navigate = function (u, type) {
    var target;
    try { target = new URL(String(u), location._url.href).href; } catch (e) { return baseNavigate(u, type); }
    if (__jb.isFragmentNavigation(target)) { __jb.fragmentNavigate(target, type === "replace"); return; }
    if (__jb.auxiliary && !__jb.frameContext && target.indexOf("javascript:") !== 0) {
      // A popup navigating away: beforeunload, then an entry when its document is completely loaded.
      __jb.fireBeforeUnload(globalThis);
      __jb.auxAddsEntry = type !== "replace" && __jb.completelyLoaded === true && !__jb.initialAboutBlank && __jb.currentDocument.URL !== "about:blank";
    }
    return baseNavigate(u, type);
  };
  var hashDesc = Object.getOwnPropertyDescriptor(location, "hash");
  Object.defineProperty(location, "hash", {
    get: hashDesc.get,
    set: function (v) {
      var u = new URL(this._url.href);
      v = String(v);
      u.hash = v;
      if (u.hash === this._url.hash && (u.href.indexOf("#") >= 0) === (this._url.href.indexOf("#") >= 0)) return;
      if (v === "" && this._url.hash === "") { /* still navigates to the same URL with an empty fragment */ }
      __jb.fragmentNavigate(u.href, false);
    },
    configurable: true, enumerable: true,
  });
})();

// location.reload() of a frame or popup reloads that navigable (replacing its entry).
(function () {
  var baseReload = location.reload;
  location.reload = function reload() {
    var fc = __jb.frameContext, url = __jb.currentDocument.URL;
    if (fc && fc.frameElement) { var fe = fc.frameElement, pw = fc.parent, me = globalThis; pw.setTimeout(function () { if (fe._contentWindow !== me) return; fe._reloadNav = true; fe._pendingPost = fe._docPost || null; pw.__jb.loadFrame(fe, url, true); }, 0); return; }
    if (__jb.auxiliary) { __jb.navigate(url, "replace"); return; }
    return baseReload.apply(this, arguments);
  };
})();

// ---- the History interface ----
__jb.canRewriteUrl = function (docUrl, target) {
  if (docUrl.protocol !== target.protocol || docUrl.username !== target.username || docUrl.password !== target.password || docUrl.host !== target.host) return false;
  if (/^https?:$/.test(target.protocol)) return true;
  if (target.protocol === "file:" && docUrl.pathname !== target.pathname) return false;
  return docUrl.pathname === target.pathname;
};
class History {
  constructor() { throw new TypeError("Illegal constructor"); }
}
// A History method called on another window's history object (pages borrow pristine methods from
// an about:blank iframe) acts on that object's document: run the owner realm's implementation.
var foreignHistoryProto = function (h) {
  var o = h && h._jbOwner;
  try { return o && o !== globalThis && o.History ? o.History.prototype : null; } catch (e) { return null; }
};
var foreignGet = function (h, name) { var fp = foreignHistoryProto(h); if (!fp) return undefined; var d = Object.getOwnPropertyDescriptor(fp, name); return d && d.get ? { v: d.get.call(h) } : undefined; };
__jb.historyFullyActive = function () {
  if (__jb.closedFlag || __jb.discardedFlag) throw __jb.domError("SecurityError", "The document is not fully active.");
};
Object.defineProperties(History.prototype, {
  length: { get: function () { var fv = foreignGet(this, "length"); if (fv) return fv.v; __jb.historyFullyActive(); __jb.myEntry(); return __jb.usedSteps(__jb.sessionHistory()).length; }, enumerable: true, configurable: true },
  scrollRestoration: {
    get: function () { __jb.historyFullyActive(); return __jb.myEntry().scrollRestoration; },
    set: function (v) { __jb.historyFullyActive(); v = String(v); if (v === "auto" || v === "manual") __jb.myEntry().scrollRestoration = v; },
    enumerable: true, configurable: true,
  },
  state: { get: function () { var fv = foreignGet(this, "state"); if (fv) return fv.v; __jb.historyFullyActive(); return __jb.historyState; }, enumerable: true, configurable: true },
  go: {
    value: function go(delta) {
      var fp = foreignHistoryProto(this); if (fp) return fp.go.apply(this, arguments);
      __jb.historyFullyActive();
      delta = delta === undefined ? 0 : (Number(delta) | 0);
      if (delta === 0) { location.reload(); return; }
      __jb.myEntry();
      // Queued on this document: if it goes away first, the traversal is dropped.
      setTimeout(function () {
        var sh = __jb.sessionHistory();
        var steps = __jb.usedSteps(sh);
        var i = steps.indexOf(sh.current) + delta;
        if (i < 0 || i >= steps.length) return;
        __jb.traversableRoot().__jb.applyHistoryStep(steps[i]);
      }, 0);
    },
    writable: true, enumerable: true, configurable: true,
  },
  back: { value: function back() { this.go(-1); }, writable: true, enumerable: true, configurable: true },
  forward: { value: function forward() { this.go(1); }, writable: true, enumerable: true, configurable: true },
  pushState: {
    value: function pushState(data, unused, url) {
      if (arguments.length < 2) throw new TypeError("History.pushState: 2 arguments required");
      var fp = foreignHistoryProto(this); if (fp) return fp.pushState.apply(this, arguments);
      return __jb.sharedHistoryUpdate(data, url, false);
    },
    writable: true, enumerable: true, configurable: true,
  },
  replaceState: {
    value: function replaceState(data, unused, url) {
      if (arguments.length < 2) throw new TypeError("History.replaceState: 2 arguments required");
      var fp = foreignHistoryProto(this); if (fp) return fp.replaceState.apply(this, arguments);
      return __jb.sharedHistoryUpdate(data, url, true);
    },
    writable: true, enumerable: true, configurable: true,
  },
  [Symbol.toStringTag]: { value: "History", configurable: true },
});
// "Shared history push/replace state steps".
__jb.sharedHistoryUpdate = function (data, url, replace) {
  __jb.historyFullyActive();
  var serialized = structuredClone(data);
  var newUrl = __jb.currentDocument.URL;
  if (url !== undefined && url !== null && String(url) !== "") {
    var parsed;
    try { parsed = new URL(String(url), __jb.currentDocument.baseURI); } catch (e) { throw __jb.domError("SecurityError", "'" + url + "' is not a valid URL."); }
    var docUrl = new URL(__jb.currentDocument.URL);
    if (!__jb.canRewriteUrl(docUrl, parsed)) throw __jb.domError("SecurityError", "A history state object with URL '" + parsed.href + "' cannot be created in a document with URL '" + docUrl.href + "'.");
    newUrl = parsed.href;
  }
  var bc = __jb.myNav();
  __jb.myEntry();
  // Before the document is completely loaded a push behaves as a replace.
  if (replace) __jb.replaceEntry(bc, { url: newUrl, state: serialized });
  else __jb.pushEntry(bc, { url: newUrl, state: serialized, docId: __jb.docId });
  __jb.setDocumentUrl(newUrl);
  __jb.historyState = serialized;
};
// window.name is the browsing context's name: it survives navigations (a new
// global per document here) and is cleared when a top-level traversable
// navigates to another origin.
(function () {
  var initial = ""; try { initial = globalThis.name || ""; } catch (e) {}
  Object.defineProperty(globalThis, "name", {
    get: function () { var bc = __jb.bcOf(globalThis); return bc.name === undefined ? "" : bc.name; },
    set: function (v) { __jb.bcOf(globalThis).name = String(v); },
    configurable: true, enumerable: true,
  });
  if (initial) globalThis.name = initial;
})();
globalThis.History = History;
Object.defineProperty(globalThis, "History", { enumerable: false });
globalThis.history = Object.create(History.prototype);
Object.defineProperty(globalThis.history, "_jbOwner", { value: globalThis });
