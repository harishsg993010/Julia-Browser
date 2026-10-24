// Part 7: Rust <-> JS bridge
// window behaves as an EventTarget
globalThis._jbListeners = Object.create(null);
// Bare calls such as `addEventListener("load", f)` have an undefined `this`;
// WebIDL treats that as the global object.
["addEventListener", "removeEventListener", "dispatchEvent"].forEach(function (m) {
  var impl = EventTarget.prototype[m];
  var op = { [m]: function () { return impl.apply(this === undefined || this === null ? globalThis : this, arguments); } }[m];
  Object.defineProperty(op, "length", { value: impl.length });
  Object.defineProperty(EventTarget.prototype, m, { value: op, writable: true, enumerable: true, configurable: true });
});
["_dispatchInner", "_dispatchPath", "_invokeListeners"].forEach(function (m) {
  var impl = EventTarget.prototype[m];
  Object.defineProperty(globalThis, m, { value: function () { return impl.apply(this === undefined || this === null ? globalThis : this, arguments); }, writable: true, enumerable: false, configurable: true });
});
globalThis.globalThis = globalThis;

// Build the DOM from the JSON produced by Rust: {t:tag, a:[[name,value]...], c:[children], i:jbid} | {x:text} | {m:comment}
__jb.nodeById = [];
// Real pages (not WPT) see the shape of a desktop browser without touch or GPU: no ontouch*
// handler attributes (sites switch to their touch layout when "ontouchstart" in window), and the
// WebGL interface objects of the no-draw WebGL contexts (59b_webgl.js) exist.
__jb.realSiteShape = function () {
  __jb.realSiteShapeDone = true;
  var touch = ["ontouchstart", "ontouchmove", "ontouchend", "ontouchcancel"];
  [globalThis, globalThis.Window && Window.prototype, globalThis.Document && Document.prototype, globalThis.HTMLElement && HTMLElement.prototype, globalThis.SVGElement && SVGElement.prototype, globalThis.MathMLElement && MathMLElement.prototype, globalThis.Element && Element.prototype].forEach(function (o) {
    if (!o) return;
    touch.forEach(function (n) { var d = Object.getOwnPropertyDescriptor(o, n); if (d && d.configurable) delete o[n]; });
  });
  if (typeof __jb.installWebGL === "function") __jb.installWebGL();
  ["WebGLRenderingContext", "WebGL2RenderingContext"].forEach(function (name) {
    if (typeof globalThis[name] === "function") return;
    var C = { [name]: function () { throw new TypeError("Illegal constructor"); } }[name];
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
    Object.defineProperty(globalThis, name, { value: C, writable: true, configurable: true, enumerable: false });
  });
};
__jb.loadDom = function (json, url) {
  var data = typeof json === "string" ? JSON.parse(json) : json;
  // Fresh document
  var doc = new Document();
  doc._isHTML = true; doc._contentType = "text/html";
  __jb.currentDocument = doc;
  __jb.dirty = new Set();
  __jb.nodeById = [];
  __jb.pendingScripts = [];
  __jb.apiCalls = [];
  __jb.navigations = [];
  __jb.formSubmissions = [];
  __jb.dialogs = [];
  __jb.cookiesSet = [];
  __jb.mutationObservers = [];
  __jb.timers = [];
  __jb.timerRuns = {};
  __jb.sockets = {};
  __jb.eventSources = {};
  __jb.canvasText = [];
  // The fragment directive (#...:~:text=...) never reaches the document.
  var fragDirective = null;
  if (url && __jb.splitFragmentDirective) { var fsp = __jb.splitFragmentDirective(url); url = fsp.url; fragDirective = fsp.directive; }
  if (url) { location._set(url); history._entries = [{ state: null, url: location.href }]; history._index = 0; }
  doc._fragmentDirective = fragDirective;
  if (url && __jb.applySecureContext) __jb.applySecureContext(url);
  if (!__jb.wptMode && !__jb.realSiteShapeDone) { var shapeTop = null; try { shapeTop = typeof __jb.topJb === "function" ? __jb.topJb() : null; } catch (e) {} if (!(shapeTop && shapeTop.wptMode)) __jb.realSiteShape(); }
  doc.URL = doc.documentURI = location.href;
  // Restore this origin's IndexedDB databases.
  try { __jb.idbRestore(__jb.native("idb", { op: "load" })); } catch (e) { __jb.idb = {}; }
  doc._quirks = !!data.q;
  if (data.c) __jb.buildTree(data.c, doc, doc, true, false, true);
  __jb.ensureHtmlSkeleton(doc);
  // Named access on the window for elements of the initial markup.
  __jb.descendants(doc, function (n) { return n.nodeType === 1 && (n.hasAttribute("id") || (n._ns === __jb.HTML_NS && __jb.NAMED_ACCESS_TAGS[n._tag] && n.hasAttribute("name"))); }).forEach(__jb.registerNamedAccess);
  if (typeof __jb.initDocNamed === "function") __jb.initDocNamed(doc);
  // Nested browsing contexts present in the initial markup.
  if (typeof __jb.iframeConnected === "function") __jb.descendants(doc, function (n) { return n.nodeType === 1 && n._tag === "iframe" && n._ns === __jb.HTML_NS; }).forEach(function (f) { try { __jb.iframeConnected(f); } catch (e) { __jb.reportException(e); } });
  // Images of the initial markup start loading before the first script runs.
  if (typeof __jb.initImages === "function") __jb.initImages();
  if (typeof __jb.initMedia === "function") __jb.initMedia();
  if (typeof __jb.initStylesheets === "function") __jb.initStylesheets();
  if (typeof __jb.initOtherFetches === "function") { try { __jb.initOtherFetches(); } catch (e) {} }
  doc.readyState = "loading";
  return true;
};

// Mark every element in the (initial) document as executed script if it was inline.
__jb.markScriptsExecuted = function () { if (typeof __jb.hideNoncesIn === "function") __jb.hideNoncesIn(__jb.currentDocument); __jb.descendants(__jb.currentDocument, function (n) { return n.nodeType === 1 && n._tag === "script"; }).forEach(function (s) { if (s.hasAttribute("src") || __jb.childTextContent(s) !== "") s._executed = true; }); __jb.scriptsLive = true; };
// Dispatch a user-agent (trusted) event.
__jb.fireUA = function (target, type, init, Ctor) {
  var ev = new (Ctor || Event)(type, init);
  __jb.setTrusted(ev, true); ev._trustedDispatch = true;
  try { target.dispatchEvent(ev); } catch (e) { __jb.reportException(e); }
  return ev;
};
// Inline classic scripts inserted by scripts run synchronously (nested in
// the inserting script), as in a browser.
__jb.runScriptElement = function (el) {
  if (el.hasAttribute("nomodule")) { el._executed = true; return; }
  el._executed = true;
  if (typeof __jb.cspScriptVerdict === "function" && !__jb.cspScriptVerdict(el, null, __jb.inDocumentWrite ? "parser-inserted" : "", false)) return;
  var prev = __jb.currentDocument.currentScript;
  __jb.currentDocument._jbCurrentScript = el;
  var prevIncumbent = typeof __jb.setIncumbent === "function" ? __jb.setIncumbent(globalThis) : undefined;
  var r;
  var nonce = typeof __jb.elementNonce === "function" ? __jb.elementNonce(el) : "";
  try { r = __jb.native("evalScript", { code: __jb.childTextContent(el), filename: location.href, base: nonce ? __jb.currentDocument.baseURI + "\u0001" + nonce : __jb.currentDocument.baseURI }); } catch (e) { r = { error: String(e) }; }
  if (typeof __jb.setIncumbent === "function") __jb.setIncumbent(prevIncumbent);
  __jb.currentDocument._jbCurrentScript = prev;
  if (r && r.error) __jb.reportError(r.error, location.href);
};

// Script elements are evaluated by Rust as real global scripts (so top-level
// let/const/class bindings are shared between <script> blocks, as in a
// browser); these hooks bracket that evaluation.
__jb.beginScript = function (jbid, isModule) {
  var el = jbid !== undefined && jbid !== null && !isModule ? __jb.nodeById[jbid] : null;
  // the document's ignore-destructive-writes counter (external classic scripts and modules), and the
  // parser's insertion point, which survives the script removing its own element
  __jb.ignoreDestructiveWrites = isModule || (el && el.hasAttribute("src")) ? 1 : 0;
  __jb.writeInsertionPoint = el && el.parentNode && !el.hasAttribute("async") && !el.hasAttribute("defer") ? { doc: el.ownerDocument, parent: el.parentNode, next: el.nextSibling } : null;
  __jb.currentDocument._jbCurrentScript = el || null;
  if (typeof __jb.setIncumbent === "function") __jb.setIncumbent(globalThis);
};
__jb.endScript = function () { __jb.currentDocument._jbCurrentScript = null; __jb.ignoreDestructiveWrites = 0; __jb.writeInsertionPoint = null; };
// Called by Rust when a global script threw an uncaught exception.
__jb.reportError = function (message, filename, muted) {
  if (String(message).indexOf("script terminated: the time budget ran out") >= 0) return; // budget stop, not a script error
  var e;
  if (globalThis.__jb_hasLastError) { e = globalThis.__jb_lastError; globalThis.__jb_hasLastError = false; globalThis.__jb_lastError = undefined; }
  else e = new Error(String(message));
  var lineno = e && typeof e === "object" && typeof e.lineNumber === "number" && e.lineNumber > 0 ? e.lineNumber : 1;
  var colno = e && typeof e === "object" && typeof e.columnNumber === "number" && e.columnNumber > 0 ? e.columnNumber : 1;
  // Muted errors (cross-origin classic scripts) hide everything about the error.
  var ev = muted ? new ErrorEvent("error", { message: "Script error.", filename: "", lineno: 0, colno: 0, error: null, cancelable: true })
    : new ErrorEvent("error", { message: String(message), filename: filename || location.href, lineno: lineno, colno: colno, error: e, cancelable: true });
  __jb.setTrusted(ev, true); ev._trustedDispatch = true;
  if (__jb.inErrorReporting) { console.error("Uncaught " + String(message)); return; }
  __jb.inErrorReporting = true;
  try { globalThis.dispatchEvent(ev); } catch (x) {} finally { __jb.inErrorReporting = false; }
  // Where it happened: the first frame of the stack, when the error carries one.
  var where = "";
  try { if (e && typeof e.stack === "string") { var fr = e.stack.split("\n").filter(function (l) { return l && l.indexOf("browser_env.js") < 0; })[0]; if (fr) where = " @ " + fr.replace(/^.*@/, ""); } } catch (x) {}
  if (!ev.defaultPrevented) console.error("Uncaught " + String(message) + where);
};
// Legacy path: evaluate inline code with document.currentScript set.
__jb.runInlineScript = function (code, jbid) {
  __jb.beginScript(jbid);
  try {
    __jb.csp ? __jb.csp.trusted(function () { (0, eval)(code); }) : (0, eval)(code);
  } catch (e) {
    __jb.reportException(e);
  } finally {
    __jb.endScript();
  }
};
__jb.reportException = function (e) {
  var msg = e && e.stack ? String(e) + "\n" + String(e.stack) : String(e);
  var ev = new ErrorEvent("error", { message: e && e.message ? e.message : String(e), filename: location.href, lineno: e && typeof e === "object" && e.lineNumber > 0 ? e.lineNumber : 1, colno: e && typeof e === "object" && e.columnNumber > 0 ? e.columnNumber : 1, error: e, cancelable: true });
  __jb.setTrusted(ev, true); ev._trustedDispatch = true;
  // An exception thrown while reporting one is not reported again (no error event recursion).
  if (__jb.inErrorReporting) { console.error("Uncaught " + msg); return; }
  __jb.inErrorReporting = true;
  try { globalThis.dispatchEvent(ev); } catch (x) {} finally { __jb.inErrorReporting = false; }
  if (!ev.defaultPrevented) console.error("Uncaught " + msg);
};
// Scripts appended to the DOM by other scripts (e.g. loaders) are collected here.
__jb.pendingScriptEls = [];
__jb.takePendingScripts = function () {
  var out = [];
  __jb.pendingScripts.forEach(function (s) {
    if (s._executed) return;
    // A script prepared on insertion still runs after being removed (jQuery inserts and at once
    // removes the scripts of HTML it adds); one moved to another document does not.
    if (!s.isConnected && !(s._prepDoc && s._prepDoc === s.ownerDocument)) return;
    var kind = __jb.scriptKind(s);
    if (!kind) return;
    var hasSrc = s.hasAttribute("src");
    // Without src and without source text the element is left alone so a
    // later `src` assignment can still run it.
    if (!hasSrc && s.textContent === "") return;
    s._executed = true;
    if (kind !== "module" && s.hasAttribute("nomodule")) return;
    var idx = __jb.pendingScriptEls.length;
    __jb.pendingScriptEls.push(s);
    var src = s.getAttribute("src");
    // Scripts written by document.write block the parser; others are async.
    var blocking = !!(s._fromWrite && !s.hasAttribute("defer") && !s.hasAttribute("async"));
    out.push({ src: hasSrc ? (src === "" ? "" : __jb.resolveURL(src, s)) : null, code: hasSrc ? null : s.textContent, module: kind === "module", pending: idx, blocking: blocking });
  });
  __jb.pendingScripts = [];
  return __jb.hostJson(out);
};
// Promises rejected without a handler (reported by the engine after each
// microtask checkpoint) fire `unhandledrejection` on the window.
__jb.queueRejection = function (p) {
  p.then(undefined, function (reason) {
    var ev = new PromiseRejectionEvent("unhandledrejection", { promise: p, reason: reason, cancelable: true });
    try { globalThis.dispatchEvent(ev); } catch (e) { __jb.reportException(e); }
    if (!ev.defaultPrevented) { var text; try { text = reason && reason.stack ? String(reason) + "\n" + String(reason.stack) : String(reason); } catch (e) { text = "<unprintable>"; } console.error("Uncaught (in promise) " + text); }
  });
};
// Rust calls these around the execution of a dynamically inserted script so
// loaders (webpack chunk loading, lazy-loaded SDKs) see load/error events.
__jb.beginPendingScript = function (idx, isModule) { var el = isModule ? null : __jb.pendingScriptEls[idx]; __jb.ignoreDestructiveWrites = isModule || (el && el.hasAttribute("src")) ? 1 : 0; __jb.writeInsertionPoint = null; __jb.currentDocument._jbCurrentScript = el || null; if (typeof __jb.setIncumbent === "function") __jb.setIncumbent(globalThis); };
// Parser-inserted script finished loading (or failed to): load/error event.
__jb.scriptDone = function (jbid, ok) {
  var el = __jb.nodeById[jbid];
  if (!el) return;
  __jb.fireUA(el, ok ? "load" : "error");
};
// ok: true -> load, false -> error, null -> no event (inline classic scripts).
__jb.endPendingScript = function (idx, ok) {
  var el = __jb.pendingScriptEls[idx];
  __jb.currentDocument._jbCurrentScript = null;
  if (!el) return;
  __jb.pendingScriptEls[idx] = null;
  if (ok !== null) __jb.fireUA(el, ok ? "load" : "error");
};
__jb.fireLifecycle = function (stage) {
  var prevIncumbent = typeof __jb.setIncumbent === "function" ? __jb.setIncumbent(globalThis) : undefined; // lifecycle events are this document's own tasks
  try {
    var stamp = function (name) { if (typeof performance !== "undefined" && performance._stamp) performance._stamp(name); };
    if (stage === "interactive" && typeof __jb.initImages === "function") __jb.initImages();
    if (stage === "complete" && typeof __jb.beforeLoadEvent === "function") __jb.beforeLoadEvent();
    // "Scroll to the fragment" once parsing finished: a text directive first, else the element fragment.
    if (stage === "complete") { try { var tdDone = __jb.applyTextDirectives ? __jb.applyTextDirectives(__jb.currentDocument) : false; if (!tdDone && location.hash && location.hash.length > 1 && __jb.navApi && __jb.navApi.scrollToFragment && !__jb.frameContext) __jb.navApi.scrollToFragment(location.href); } catch (e) {} }
    if (stage === "interactive") { __jb.currentDocument.readyState = "interactive"; stamp("domInteractive"); __jb.fireUA(__jb.currentDocument, "readystatechange"); stamp("domContentLoadedEventStart"); __jb.fireUA(__jb.currentDocument, "DOMContentLoaded", { bubbles: true }); stamp("domContentLoadedEventEnd"); if (typeof __jb.flushAutofocus === "function") setTimeout(__jb.flushAutofocus, 0); }
    else if (stage === "complete") { __jb.currentDocument.readyState = "complete"; stamp("domComplete"); __jb.fireUA(__jb.currentDocument, "readystatechange"); stamp("loadEventStart"); __jb.fireUA(globalThis, "load"); __jb.fireUA(__jb.currentDocument, "load"); stamp("loadEventEnd"); __jb.fireUA(globalThis, "pageshow", { persisted: false }, PageTransitionEvent); __jb.loadEventDone = true; }
  } catch (e) { __jb.reportException(e); }
  if (typeof __jb.setIncumbent === "function") __jb.setIncumbent(prevIncumbent);
};
// Called after the last tick. Reports elements whose subtree changed.
// `light`: the caller re-exports the whole document later (deferred sync), so skip the
// subtree updates and the title walk.
__jb.collectModifications = function (light) {
  var dirty = light ? [] : __jb.arrayFrom(__jb.dirty);
  __jb.dirty = new Set();
  // Drop nodes that have a dirty ancestor (their change is covered) or that are detached.
  var set = new Set(dirty);
  var updates = [];
  dirty.forEach(function (el) {
    if (!el.isConnected) return;
    for (var a = el.parentNode; a; a = a.parentNode) if (set.has(a)) return;
    __jb.serializeForSync = !__jb.wptMode;
    try { updates.push({ id: el.__jbid, html: __jb.serializeChildren(el, true), attrs: __jb.syncAttrs(el).map(function (p) { return [p[0], p[1]]; }) }); }
    finally { __jb.serializeForSync = false; }
  });
  // Title changes are common and body-independent.
  var titleEl = light ? null : __jb.descendants(__jb.currentDocument, function (n) { return n.nodeType === 1 && n._tag === "title" && n._ns === __jb.HTML_NS; })[0];
  // Persist IndexedDB for this origin (light collects run after every protocol command: only
  // every 20th of them).
  __jb.lightCollects = light ? (__jb.lightCollects || 0) + 1 : 0;
  if (__jb.lightCollects % 20 === 0) {
    try { var snap = __jb.idbSnapshot(); if (snap) __jb.native("idb", { op: "save", data: snap }); } catch (e) {}
  }
  return __jb.hostJson({
    updates: updates,
    title: titleEl ? titleEl.textContent : null,
    canvasText: __jb.canvasText.splice(0),
    openConnections: Object.keys(__jb.sockets).length + Object.keys(__jb.eventSources).length,
    console: __jb.consoleOutput.splice(0),
    errors: __jb.consoleErrors.splice(0),
    navigations: __jb.navigations.splice(0),
    formSubmissions: __jb.formSubmissions.splice(0),
    dialogs: __jb.dialogs.splice(0),
    cookies: __jb.cookiesSet.splice(0),
    apiCalls: __jb.apiCalls.splice(0),
    pendingTimers: __jb.timers.length,
    url: location.href,
  });
};
__jb.serializeDocument = function () { return __jb.serializeNode(__jb.currentDocument, true); };
// Export the whole document as the JSON records Rust rebuilds its tree from,
// assigning fresh sequential ids (element.__jbid) in tree order. Shadow
// roots are exported as <jb-shadow-root> containers so rendering sees them.
__jb.exportDom = function () {
  var ids = [];
  // Ids are reassigned in tree order; a layout taken under the old numbering
  // (geometry queries made by page scripts) must not be reused.
  var renumbered = false;
  function rec(node) {
    switch (node.nodeType) {
      case 3: case 4: return { x: node.data };
      case 8: return { m: node.data };
      case 7: return { pi: node.target, x: node.data };
      case 10: return { d: node.name, p: node.publicId, s: node.systemId };
      case 1: {
        var o = { t: node._local };
        if (node.__jbid !== ids.length) renumbered = true;
        node.__jbid = ids.length; ids.push(node);
        o.i = node.__jbid;
        if (node._ns === __jb.SVG_NS) o.n = 1; else if (node._ns === __jb.MATHML_NS) o.n = 2;
        if (node._attrs.length || node._tag === "option" || node._tag === "input") { var sa = __jb.syncAttrs(node); if (sa.length) o.a = sa; }
        if (node._popoverState === "showing") (o.a = o.a || []).push(["jb-open", ""]);
        if (node._tag === "dialog" && node._modal) (o.a = o.a || []).push(["jb-modal", ""]);
        var kids = [];
        if (node._shadowRoot) { var sr = { t: "jb-shadow-root", c: [] }; for (var s = node._shadowRoot.firstChild; s; s = s.nextSibling) { var r0 = rec(s); if (r0) sr.c.push(r0); } kids.push(sr); }
        if (node._tag === "template" && node._ns === __jb.HTML_NS && node._content) { var f = { f: 1, c: [] }; for (var t = node._content.firstChild; t; t = t.nextSibling) { var r1 = rec(t); if (r1) f.c.push(r1); } kids.push(f); }
        for (var c = node.firstChild; c; c = c.nextSibling) { var r2 = rec(c); if (r2) kids.push(r2); }
        if (kids.length) o.c = kids;
        return o;
      }
      default: return null;
    }
  }
  var children = [];
  for (var c = __jb.currentDocument.firstChild; c; c = c.nextSibling) { var r = rec(c); if (r) children.push(r); }
  __jb.nodeById = ids;
  if (renumbered && __jb.layoutState) __jb.layoutState.key = -1;
  return __jb.hostJson({ c: children, q: !!__jb.currentDocument._quirks, changed: __jb.dirty.size > 0 });
};
// ---- layout bridge (Cargo feature "layout"): boxes come from the Rust side
// (Stylo + Taffy + Parley). The document is re-sent when it changed since the
// last query; elements are matched back by their data-jb id. ----
__jb.layoutVersion = 0;
__jb.layoutState = { key: -1, available: null };
__jb.layoutKey = function () { return __jb.domVersion * 1000003 + __jb.layoutVersion; };
// layoutQuery's staleness key: without the bumps from attribute writes on off-document elements
// (real pages only, see __jb.attributeChanged)
__jb.layoutQueryKey = function () { return (__jb.domVersion - (__jb.offDocDom || 0)) * 1000003 + __jb.layoutVersion - (__jb.offDocLayout || 0); };
// Every connected element gets a stable __jbid (dynamic ones are appended).
__jb.assignLayoutIds = function () {
  if (!__jb.nodeById) __jb.nodeById = [];
  var ids = __jb.nodeById;
  var walk = function (node) {
    if (node.nodeType === 1 && (node.__jbid === undefined || ids[node.__jbid] !== node)) { node.__jbid = ids.length; ids.push(node); }
    if (node._shadowRoot) for (var s = node._shadowRoot.firstChild; s; s = s.nextSibling) walk(s);
    for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(__jb.currentDocument);
};
// SVG presentation attributes (SVG 2 "presentation attributes"): CSS properties that every
// SVG element maps, plus the geometry properties of the elements they belong to.
__jb.SVG_PRESENTATION = ["alignment-baseline", "baseline-shift", "clip-path", "clip-rule", "color", "color-interpolation", "color-interpolation-filters", "cursor", "direction", "display", "dominant-baseline", "fill", "fill-opacity", "fill-rule", "filter", "flood-color", "flood-opacity", "font-family", "font-size", "font-size-adjust", "font-stretch", "font-style", "font-variant", "font-weight", "image-rendering", "letter-spacing", "lighting-color", "marker-end", "marker-mid", "marker-start", "mask", "mask-type", "opacity", "overflow", "paint-order", "pointer-events", "shape-rendering", "stop-color", "stop-opacity", "stroke", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "stroke-width", "text-anchor", "text-decoration", "text-overflow", "text-rendering", "transform-origin", "unicode-bidi", "vector-effect", "visibility", "white-space", "word-spacing", "writing-mode"];
__jb.SVG_GEOMETRY_PRESENTATION = { cx: ["circle", "ellipse"], cy: ["circle", "ellipse"], r: ["circle"], rx: ["ellipse", "rect"], ry: ["ellipse", "rect"], x: ["rect", "image", "svg", "foreignObject", "use", "symbol"], y: ["rect", "image", "svg", "foreignObject", "use", "symbol"], width: ["rect", "image", "svg", "foreignObject", "use", "symbol"], height: ["rect", "image", "svg", "foreignObject", "use", "symbol"], d: ["path"] };
__jb.svgPresentationDecls = function (el) {
  var out = "";
  for (var i = 0; i < el._attrs.length; i++) {
    var a = el._attrs[i];
    if (a._ns !== null) continue;
    var n = a._local, v = a._value;
    if (/[;{}]/.test(v) || !v.trim()) continue;
    var geom = __jb.SVG_GEOMETRY_PRESENTATION[n];
    if (geom) { if (geom.indexOf(el._local) < 0) continue; if (n === "d") { if (__jb.layoutPresIds) continue; v = 'path("' + v.replace(/["\\]/g, "") + '")'; } }
    else if (__jb.SVG_PRESENTATION.indexOf(n) < 0) continue;
    out += n + ":" + v + ";";
  }
  return out;
};
__jb.LAYOUT_SELECT_CSS =
  ":where(select){display:inline-block;box-sizing:border-box;border:1px solid #767676;border-radius:3px;background-color:#fff;color:#000;font:13.33px sans-serif;vertical-align:baseline;white-space:nowrap;overflow:hidden}" +
  ":where(select:not([multiple]):not([size])){padding:1px 18px 1px 4px;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23333'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:right 5px center}" +
  ":where(select) :where(option){display:block;padding:0 2px}" +
  ":where(select:not([multiple]):not([size])) :where(option:not([selected])){display:none}" +
  ":where(select[multiple], select[size]) :where(option[selected]){background-color:#cce4ff}\n";
// Rewrites the text of every <style> element in serialized HTML. A scan, not a regex: a lazy
// [\s\S]*? over a multi-megabyte export overflowed the regex stack (Vijay Sales, 7.8 MB).
__jb.mapStyleBlocks = function (html, fn) {
  var lower = html.toLowerCase(), out = "", pos = 0;
  for (;;) {
    var open = lower.indexOf("<style", pos);
    if (open < 0) break;
    var after = lower.charAt(open + 6);
    if (after !== ">" && after !== " " && after !== "\t" && after !== "\n" && after !== "/") { out += html.slice(pos, open + 6); pos = open + 6; continue; }
    var gt = lower.indexOf(">", open);
    var close = gt < 0 ? -1 : lower.indexOf("</style>", gt);
    if (close < 0) break;
    out += html.slice(pos, gt + 1) + fn(html.slice(gt + 1, close));
    pos = close;
  }
  return out + html.slice(pos);
};
// ::placeholder (and its prefixed forms) -> [data-jb-ph], the marker on fields showing their
// placeholder in the layout mirror; colors become !important to beat the default placeholder color.
// Keep in sync with placeholder_css in src/layout/blitz.rs.
__jb.placeholderCss = function (css) {
  if (!/placeholder/i.test(css)) return css;
  // A linear scan over the rules mentioning "placeholder" (a lazy-quantifier regex over the whole
  // sheet was quadratic: seconds per relayout on CSS-in-JS sheets that grow with every render).
  var SEL = /:placeholder-shown\b|::?-?(?:webkit-input-|moz-|ms-input-)?placeholder\b/gi;
  var lower = css.toLowerCase(), out = "", pos = 0, at = lower.indexOf("placeholder");
  while (at >= 0) {
    var open = lower.indexOf("{", at), closeAfter = lower.indexOf("}", at);
    if (open < 0) break;
    if (closeAfter >= 0 && closeAfter < open) { at = lower.indexOf("placeholder", closeAfter); continue; } // in a declaration block
    var selStart = Math.max(lower.lastIndexOf("}", at), lower.lastIndexOf("{", at)) + 1;
    if (selStart < pos) selStart = pos;
    var close = lower.indexOf("}", open);
    if (close < 0) break;
    var nextOpen = lower.indexOf("{", open + 1);
    if (nextOpen >= 0 && nextOpen < close) { at = lower.indexOf("placeholder", open); continue; } // an at-rule prelude
    var sel = css.slice(selStart, open);
    var sel2 = sel.replace(SEL, "[data-jb-ph]");
    if (sel2 !== sel) {
      var body = css.slice(open + 1, close).replace(/(^|;)(\s*color\s*:)([^;!}]*)(?=;|$)/gi, "$1$2$3 !important");
      out += css.slice(pos, selStart) + sel2 + "{" + body + "}";
      pos = close + 1;
    }
    at = lower.indexOf("placeholder", close + 1);
  }
  return out + css.slice(pos);
};
__jb.exportLayoutHtml = function () {
  __jb.assignLayoutIds();
  __jb.serializeWithIds = true;
  __jb.layoutPresRules = [];
  __jb.layoutHover = !__jb.wptMode && __jb.hoverChain && __jb.hoverChain.length ? new Set(__jb.hoverChain) : null;
  __jb.layoutExportSeq = (__jb.layoutExportSeq || 0) + 1;
  __jb.layoutEmittedCss = __jb.wptMode ? null : new Set();
  __jb.layoutPresIds = __jb.wptMode ? null : new Map();
  try {
    // HTML documents: the newline keeps blitz from sniffing XHTML on the first line (a root
    // `xmlns="http://www.w3.org/1999/xhtml"` made it XML-parse the page; The Hindu rendered blank).
    var html = (__jb.currentDocument._isHTML ? "<!DOCTYPE html>\n" : "<!DOCTYPE html>") + (__jb.currentDocument.documentElement ? __jb.serializeNode(__jb.currentDocument.documentElement, true, false) : "");
    // presentation-attribute rules come first among the author rules; before them, zero-specificity
    // defaults for controls the layout engine has no UA style for (<select> renders nothing otherwise)
    var uaRules = html.indexOf("<select") >= 0 ? __jb.LAYOUT_SELECT_CSS : "";
    if (html.indexOf("data-jb-ph") >= 0) uaRules += ":where([data-jb-ph]){color:#757575 !important}\n";
    // scripting is on: <noscript> content is not rendered (the layout parser treats it as markup)
    // (real pages only: serialization drops namespaces, so an SVG <noscript> would be hidden too)
    if (!__jb.wptMode && html.indexOf("<noscript") >= 0) uaRules +="noscript{display:none !important}\n";
    // real pages: no transitions in the mirror (Stylo left restyled values at the transition start)
    if (!__jb.wptMode) uaRules += "*,*::before,*::after{transition:none !important}\n";
    if (__jb.layoutPresRules.length || uaRules) {
      var pres = "<style>" + uaRules + __jb.layoutPresRules.join("\n") + "</style>";
      var hm = /<head\b[^>]*>/i.exec(html);
      if (hm) html = html.slice(0, hm.index + hm[0].length) + pres + html.slice(hm.index + hm[0].length);
      else { var hh = /<html\b[^>]*>/i.exec(html); html = hh ? html.slice(0, hh.index + hh[0].length) + pres + html.slice(hh.index + hh[0].length) : pres + html; }
    }
    // the layout engine has no custom element state: :defined matches elements not marked data-jbu
    // :animated-image (CSS Images Animation): images the host found animated carry jb-animated-image
    var styleFix = [];
    var fixAnim = function (b) { return b.replace(/:animated-image\b/g, "[jb-animated-image]"); }; fixAnim.jbKey = "a";
    var fixPh = function (b) { return __jb.placeholderCss(b); }; fixPh.jbKey = "p";
    var fixDef = function (b) { return b.replace(/:defined\b/g, ":not([data-jbu])"); }; fixDef.jbKey = "d";
    // (not `(hover:hover)` media features)
    var fixHover = function (b) { return b.replace(/(?<!\(\s*(?:any-)?hover\s*):hover(?![\w-])/gi, "[data-jbhv]"); }; fixHover.jbKey = "h";
    if (html.indexOf(":animated-image") >= 0) styleFix.push(fixAnim);
    if (html.indexOf("placeholder") >= 0) styleFix.push(fixPh);
    if (html.indexOf(":defined") >= 0) styleFix.push(fixDef);
    if (!__jb.wptMode && html.indexOf(":hover") >= 0) styleFix.push(fixHover);
    // :popover-open / :modal -> the jb-open / jb-modal attributes the mirror puts on them (blitz has
    // no such states; Steam hides its filter flyouts with :not(:popover-open)); escaped class names stay
    var fixPopover = function (b) { return b.replace(/(?<!\\):(popover-open|modal)(?![\w-])/g, function (m, s) { return s === "modal" ? "[jb-modal]" : "[jb-open]"; }); }; fixPopover.jbKey = "o";
    if (!__jb.wptMode && (html.indexOf(":popover-open") >= 0 || html.indexOf(":modal") >= 0)) styleFix.push(fixPopover);
    // the rewrites are regexes over whole style sheets (seconds on large CSS-in-JS blocks, every
    // relayout): results are cached by block text and the set of rewrites applied
    if (styleFix.length) {
      var fixKey = styleFix.map(function (f) { return f.jbKey; }).join(",");
      var fixCache = __jb.styleFixCache || (__jb.styleFixCache = new Map());
      if (fixCache.size > 400) fixCache.clear();
      html = __jb.mapStyleBlocks(html, function (b) {
        if (b.length < 64) { for (var f0 = 0; f0 < styleFix.length; f0++) b = styleFix[f0](b); return b; }
        var ck = fixKey + "\u0000" + b, hit = fixCache.get(ck);
        if (hit !== undefined) return hit;
        var out = b;
        for (var f = 0; f < styleFix.length; f++) out = styleFix[f](out);
        fixCache.set(ck, out);
        return out;
      });
    }
    // document.adoptedStyleSheets apply after the document's own sheets
    var adopted = (__jb.currentDocument.adoptedStyleSheets || []).map(__jb.sheetText).join("\n");
    if (adopted) { var at = html.lastIndexOf("</body>"); html = at >= 0 ? html.slice(0, at) + "<style>" + adopted + "</style>" + html.slice(at) : html + "<style>" + adopted + "</style>"; }
    // CSS.registerProperty() registrations: @property rules after every other sheet
    var registered = typeof __jb.registeredPropertyCss === "function" ? __jb.registeredPropertyCss() : "";
    if (registered) { var rt = html.lastIndexOf("</body>"); html = rt >= 0 ? html.slice(0, rt) + "<style>" + registered + "</style>" + html.slice(rt) : html + "<style>" + registered + "</style>"; }
    // blob: stylesheets (1mg's ad CSS) live in this realm's blob store: hand the layout engine the
    // equivalent data: URL
    if (html.indexOf('href="blob:') >= 0 && typeof __jb.hostImageUrl === "function") html = html.replace(/(<link\b[^>]*?\shref=")(blob:[^"]+)(")/gi, function (m, a, u, c) { return a + __jb.hostImageUrl(u.replace(/&amp;/g, "&")) + c; });
    return html;
  }
  finally { __jb.serializeWithIds = false; __jb.layoutHover = null; __jb.layoutPresRules = null; __jb.layoutEmittedCss = null; __jb.layoutPresIds = null; }
};
// A computed-style query for cascade-only properties (font-size, display, overflow, ...) of an element
// the current layout knows, when neither it nor an ancestor had its style/class changed since that
// layout was built: the cascade answer has not changed, so no relayout is needed. Highcharts and
// text-fitting code read font-size after every DOM write; each read re-laid out a 1-2 MB page
// (~300 ms), 68 times during one CoinMarketCap load.
__jb.CASCADE_GEOMETRY_PROP = /^(width|height|top|left|right|bottom|inset|margin|padding|transform|perspective-origin|min-|max-|inline-size|block-size)/;
__jb.cascadeQueryUnaffected = function (op, args) {
  if (op !== "style" || !args || args.id === undefined || !args.props || args.pseudoDecls !== undefined || args.generated !== undefined) return false;
  for (var i = 0; i < args.props.length; i++) if (__jb.CASCADE_GEOMETRY_PROP.test(String(args.props[i]))) return false;
  var el = __jb.nodeById && __jb.nodeById[args.id];
  if (!el || el._jbLid !== args.id) return false; // not in the current layout (new or renumbered)
  var dirty = __jb.styleDirtyEls;
  if (!dirty || !dirty.size) return true;
  for (var n = el; n && n.nodeType !== 9; n = n.nodeType === 11 ? n.host : n.parentNode) if (n.nodeType === 1 && dirty.has(n)) return false;
  return true;
};
__jb.layoutQuery = function (op, args) {
  if (__jb.layoutState.available === false) return null;
  var payload = Object.assign({ op: op, viewport: [globalThis.innerWidth, globalThis.innerHeight] }, args || {});
  var key = __jb.layoutQueryKey();
  var shared = typeof __jb.topJb === "function" ? __jb.topJb() : __jb;
  if (!__jb.realmToken) __jb.realmToken = Math.random().toString(36).slice(2);
  var real = !__jb.wptMode && !shared.wptMode;
  // WPT: the host keeps one layout for all realms; rebuild when another realm (a frame) laid out
  // last. Real pages: the host keeps a layout per realm and switches to ours (`realm`).
  if (shared.layoutOwner !== __jb.realmToken && !real) __jb.layoutState.key = -1;
  if (real && __jb.layoutState.key !== -1) payload.realm = __jb.realmToken;
  var st = __jb.layoutState, stale = st.key !== key;
  // Real pages (not WPT): a full re-layout costs as much as a page load, so queries made soon after
  // the last build reuse it unless they ask about something it does not know (a new element).
  // Not after a style/class change since that build: libraries position an element, then measure
  // it (Polymer iron-fit set position:fixed;top:0 and read the old rect, so YouTube Kids' dialog
  // was moved off-screen).
  if (stale && real && !(args && args.fresh) && st.builtAt && ((__jb.geomVersion || 0) === (st.geomAt || 0) ? Date.now() - st.builtAt < Math.max(250, 3 * (st.buildMs || 0)) : __jb.cascadeQueryUnaffected(op, args))) {
    var quick = __jb.native("layout", payload);
    if (quick && quick.rebuild) { st.key = -1; delete payload.realm; }
    else if (quick && !quick.error && !(quick === null && (op === "rect" || op === "style"))) { shared.layoutOwner = __jb.realmToken; return quick; }
  }
  if (stale) {
    payload.html = __jb.exportLayoutHtml(); payload.base = __jb.currentDocument.baseURI; st.key = key; shared.layoutOwner = __jb.realmToken;
    // same realm: the host may diff against its current layout. Ids the layout knows that were
    // renumbered since (exportDom numbers elements in tree order) go along as [old, new] pairs.
    var ids = __jb.nodeById, remap = [];
    for (var ri = 0; ri < ids.length; ri++) { var rn = ids[ri]; if (!rn) continue; if (rn._jbLid !== undefined && rn._jbLid !== ri) remap.push(rn._jbLid, ri); rn._jbLid = ri; }
    if (!__jb.wptMode && !shared.wptMode) { payload.inc = __jb.realmToken; payload.remap = remap; }
  }
  var t0 = Date.now();
  var r = __jb.native("layout", payload);
  // the host no longer has this realm's layout (evicted): send the page
  if (r && r.rebuild && !stale) { st.key = -1; delete payload.realm; return __jb.layoutQuery(op, args); }
  shared.layoutOwner = __jb.realmToken;
  if (stale) { st.builtAt = Date.now(); st.buildMs = st.builtAt - t0; st.geomAt = __jb.geomVersion || 0; if (__jb.styleDirtyEls) __jb.styleDirtyEls.clear(); }
  // the host dropped its layout (it failed): send the page again next time
  if (r && r.error) st.key = -1;
  if (r && r.unavailable) { st.available = false; return null; }
  st.available = true;
  return r;
};
// Box of a connected element in document coordinates, or null.
__jb.layoutRect = function (el) {
  if (!el || !el.isConnected || __jb.layoutState.available === false) return null;
  if (el.__jbid === undefined || __jb.nodeById[el.__jbid] !== el) __jb.assignLayoutIds();
  var r = __jb.layoutQuery("rect", { id: el.__jbid });
  return r && typeof r.width === "number" ? r : null;
};
__jb.wellFormed = function (s) { s = String(s); return typeof s.toWellFormed === "function" ? s.toWellFormed() : s; };
__jb.evalResult = function (fn) {
  try {
    var v = fn();
    if (v === undefined) return "undefined";
    if (typeof v === "function") return "[Function]";
    if (v && v.nodeType) return __jb.serializeNode(v);
    return __jb.hostJson(v, function (k, val) { return val && val.nodeType ? __jb.serializeNode(val) : typeof val === "string" ? __jb.wellFormed(val) : val; });
  } catch (e) { return __jb.hostJson({ __error: String(e && e.message ? e.message : e) }); }
};
__jb.hasTimers = function () { return __jb.timers.length > 0; };
__jb.ready = true;

// Object.prototype.toString.call(new Event("x")) === "[object Event]": tag
// every platform class defined by this environment (not JS built-ins).
(function () {
  Object.getOwnPropertyNames(globalThis).forEach(function (name) {
    if (!/^[A-Z]/.test(name)) return;
    var C;
    try { C = globalThis[name]; } catch (e) { return; }
    if (typeof C !== "function" || !C.prototype || typeof C.prototype !== "object") return;
    if (/\[native code\]/.test(Function.prototype.toString.call(C))) return;
    if (Object.prototype.hasOwnProperty.call(C.prototype, Symbol.toStringTag)) return;
    try { Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true }); } catch (e) {}
  });
})();
// WebIDL: interface objects, namespaces and constructors on the global object are not enumerable.
Object.getOwnPropertyNames(globalThis).forEach(function (k) {
  if (!/^[A-Z]/.test(k)) return;
  var d = Object.getOwnPropertyDescriptor(globalThis, k);
  if (d && d.enumerable && d.configurable) Object.defineProperty(globalThis, k, { enumerable: false });
});
