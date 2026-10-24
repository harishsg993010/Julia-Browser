// Part 5b: nested browsing contexts. <iframe> documents are loaded into the
// same realm (their scripts are not executed) so that pages and tests can
// use `contentDocument`, `contentWindow`, `frames[n]` and the load event.
__jb.frameLocation = function (win) {
  var loc = {
    get href() { return win._doc.URL; },
    set href(v) { __jb.navigateFrame(win, v); },
    get protocol() { return new URL(win._doc.URL).protocol; },
    get host() { return new URL(win._doc.URL).host; },
    get hostname() { return new URL(win._doc.URL).hostname; },
    get port() { return new URL(win._doc.URL).port; },
    get pathname() { return new URL(win._doc.URL).pathname; },
    get search() { return new URL(win._doc.URL).search; },
    get hash() { return new URL(win._doc.URL).hash; },
    set hash(v) { var u = new URL(win._doc.URL); u.hash = v; win._doc.URL = win._doc.documentURI = u.href; },
    get origin() { return new URL(win._doc.URL).origin; },
    assign: function (v) { __jb.navigateFrame(win, v); },
    replace: function (v) { __jb.navigateFrame(win, v); },
    reload: function () { __jb.loadFrame(win._frameElement, win._doc.URL); },
    toString: function () { return win._doc.URL; },
  };
  return loc;
};
__jb.navigateFrame = function (win, v) {
  var target;
  try { target = new URL(String(v), win._doc.URL).href; }
  catch (e) { throw __jb.domError("SyntaxError", "'" + v + "' is not a valid URL."); }
  if (target.indexOf("javascript:") === 0) return;
  var iframe = win._frameElement;
  setTimeout(function () { if (iframe && iframe._contentWindow === win) __jb.loadFrame(iframe, target); }, 0);
};
__jb.createFrameWindow = function (iframe) {
  var target = new EventTarget();
  target._frameElement = iframe;
  target._doc = null;
  target.closed = false;
  target.opener = null;
  target.name = iframe.getAttribute("name") || "";
  target.postMessage = function (data, origin) { var self_ = this; var ev = new MessageEvent("message", { data: structuredClone(data), origin: globalThis.location.origin, source: globalThis }); setTimeout(function () { self_.dispatchEvent(ev); }, 0); };
  target.close = function () {}; target.focus = function () {}; target.blur = function () {}; target.stop = function () {};
  target.alert = function () {}; target.confirm = function () { return true; }; target.prompt = function () { return null; };
  target.getComputedStyle = getComputedStyle;
  target.getSelection = function () { return null; };
  target.matchMedia = matchMedia;
  target.setTimeout = setTimeout; target.clearTimeout = clearTimeout; target.setInterval = setInterval; target.clearInterval = clearInterval;
  target.requestAnimationFrame = requestAnimationFrame; target.cancelAnimationFrame = cancelAnimationFrame;
  target.queueMicrotask = queueMicrotask; target.structuredClone = structuredClone;
  target.eval = function (s) { return (0, eval)(s); };
  target.customElements = customElements;
  target.navigator = navigator; target.screen = screen; target.performance = performance; target.console = console;
  target.localStorage = localStorage; target.sessionStorage = sessionStorage; target.history = history;
  target.innerWidth = 300; target.innerHeight = 150; target.outerWidth = 300; target.outerHeight = 150; target.devicePixelRatio = 1; target.scrollX = 0; target.scrollY = 0; target.pageXOffset = 0; target.pageYOffset = 0;
  target.scrollTo = function () {}; target.scrollBy = function () {}; target.scroll = function () {};
  target.onload = null; target.onerror = null; target.onmessage = null; target.onunload = null; target.onpagehide = null; target.onpageshow = null; target.onhashchange = null; target.onpopstate = null;
  Object.defineProperty(target, "document", { get: function () { return this._doc; } });
  Object.defineProperty(target, "frameElement", { get: function () { return this._frameElement; } });
  Object.defineProperty(target, "parent", { get: function () { var el = this._frameElement; if (!el) return this; var d = el.ownerDocument; return d && d._frameWindow ? d._frameWindow : globalThis; } });
  Object.defineProperty(target, "top", { get: function () { var w = this; for (var i = 0; i < 64; i++) { var p = w.parent; if (p === w || p === globalThis) return p === w ? w : globalThis; w = p; } return globalThis; } });
  Object.defineProperty(target, "self", { get: function () { return this._proxy; } });
  Object.defineProperty(target, "window", { get: function () { return this._proxy; } });
  Object.defineProperty(target, "globalThis", { get: function () { return this._proxy; } });
  Object.defineProperty(target, "frames", { get: function () { return this._proxy; } });
  Object.defineProperty(target, "length", { get: function () { return this._doc ? __jb.frameWindows(this._doc).length : 0; } });
  Object.defineProperty(target, "location", { get: function () { if (!this._loc) this._loc = __jb.frameLocation(this); return this._loc; }, set: function (v) { __jb.navigateFrame(this, v); } });
  Object.defineProperty(target, "origin", { get: function () { return this._doc ? new URL(this._doc.URL).origin : "null"; } });
  var proxy = new Proxy(target, {
    get: function (t, k) {
      if (typeof k === "string" && /^(0|[1-9][0-9]*)$/.test(k)) { var ws = t._doc ? __jb.frameWindows(t._doc) : []; return ws[Number(k)]; }
      if (k in t) { var v = t[k]; return typeof v === "function" && !/^[A-Z]/.test(String(k)) ? v.bind(t) : v; }
      // Constructors and other globals are shared with the main realm.
      return globalThis[k];
    },
    set: function (t, k, v) { t[k] = v; return true; },
    has: function (t, k) { return k in t || k in globalThis; },
  });
  target._proxy = proxy;
  return proxy;
};
__jb.frameWindows = function (doc) {
  // window.length / frames[i] are read in hot page code: the frame elements of a document are
  // cached per DOM version (a full tree walk per read made FedEx's tracking app spend seconds here)
  // (after parsing, per frame-tree version: connecting/disconnecting a frame bumps it)
  var key = doc && doc.readyState !== "loading" && !__jb.wptMode ? "f" + (__jb.frameTreeVersion || 0) : "d" + __jb.domVersion;
  var c = doc && doc._jbFrameEls;
  if (!c || c.v !== key) {
    c = { v: key, els: __jb.descendants(doc, function (n) { return n.nodeType === 1 && n._ns === __jb.HTML_NS && (n._tag === "iframe" || n._tag === "frame"); }) };
    try { Object.defineProperty(doc, "_jbFrameEls", { value: c, writable: true, configurable: true, enumerable: false }); } catch (e) {}
  }
  var out = [];
  for (var i = 0; i < c.els.length; i++) if (c.els[i]._contentWindow) out.push(c.els[i]._contentWindow);
  return out;
};
__jb.blankFrameDocument = function () {
  var d = new Document(); d._isHTML = true; d._contentType = "text/html";
  __jb.ensureHtmlSkeleton(d);
  d.readyState = "complete";
  return d;
};
// Load (or reload) the document of an iframe. `explicitUrl` overrides the src attribute.
__jb.loadFrame = function (iframe, explicitUrl) {
  var win = iframe._contentWindow;
  if (!win) { win = __jb.createFrameWindow(iframe); iframe._contentWindow = win; }
  var srcdoc = iframe.getAttribute("srcdoc");
  var src = explicitUrl !== undefined ? explicitUrl : iframe.getAttribute("src");
  var doc = null, url = "about:blank", encodingName = null;
  if (explicitUrl === undefined && srcdoc !== null) {
    doc = new Document(); doc._isHTML = true; doc._contentType = "text/html";
    var json = __jb.native("html", { html: srcdoc });
    if (json && json.c) __jb.buildTree(json.c, doc, doc, false);
    __jb.ensureHtmlSkeleton(doc);
    url = "about:srcdoc";
  } else if (src !== null && String(src).trim() !== "" && String(src).trim() !== "about:blank") {
    try { url = new URL(String(src).trim(), iframe.ownerDocument.URL).href; } catch (e) { url = "about:blank"; }
    if (url.indexOf("javascript:") === 0 || url.indexOf("about:") === 0) { url = "about:blank"; }
    else {
      var r = __jb.native("fetch", { url: url, method: "GET", headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" } });
      if (r && r.status && r.status < 400) {
        var ct = String((r.headers && r.headers["content-type"]) || "").toLowerCase();
        var text = r.text !== undefined ? r.text : __utf8Decode(__jb.b64ToBytes(r.bodyBase64 || ""));
        if (r.url) url = r.url;
        encodingName = r.encoding || null;
        if (/xml|svg/.test(ct) && ct.indexOf("text/html") < 0) {
          doc = new XMLDocument();
          doc._contentType = /xhtml/.test(ct) ? "application/xhtml+xml" : /svg/.test(ct) ? "image/svg+xml" : /text\/xml/.test(ct) ? "text/xml" : "application/xml";
          __jb.parseXML(text, doc);
        } else if (/^text\/plain/.test(ct) || /^application\/json/.test(ct)) {
          doc = new Document(); doc._isHTML = true; doc._contentType = ct.split(";")[0].trim();
          __jb.ensureHtmlSkeleton(doc);
          var pre = doc.createElement("pre"); pre._appendChildRaw(doc.createTextNode(text)); doc.body._appendChildRaw(pre);
        } else {
          doc = new Document(); doc._isHTML = true; doc._contentType = "text/html";
          var json2 = __jb.native("html", { html: text });
          if (json2 && json2.c) { __jb.buildTree(json2.c, doc, doc, false); doc._quirks = !!json2.q; }
          __jb.ensureHtmlSkeleton(doc);
          if (encodingName) doc._characterSet = encodingName;
        }
      }
    }
  }
  if (!doc) doc = __jb.blankFrameDocument();
  doc.URL = doc.documentURI = url;
  doc._frameWindow = win;
  doc.readyState = "complete";
  var targetWin = win;
  var winTarget = __jb.frameTarget(win);
  winTarget._doc = doc;
  winTarget._loc = null;
  iframe._contentDocument = doc;
  // Nested frames of the loaded document.
  __jb.descendants(doc, function (n) { return n.nodeType === 1 && n._ns === __jb.HTML_NS && n._tag === "iframe"; }).forEach(function (f) { if (!f._contentWindow) __jb.loadFrame(f); });
  setTimeout(function () {
    if (iframe._contentWindow !== targetWin) return;
    __jb.fireUA(targetWin, "load");
    __jb.fireUA(iframe, "load");
  }, 0);
};
__jb.frameTarget = function (winProxy) { return winProxy._target || winProxy; };
__jb.canonicalEncoding = function (label) { var r = __jb.native("encoding", { op: "label", label: String(label) }); return r && r.name ? r.name : null; };
__jb.iframeConnected = function (iframe) { if (iframe._contentWindow) return; __jb.loadFrame(iframe); };
__jb.iframeDisconnected = function (iframe) { iframe._contentWindow = null; iframe._contentDocument = null; };
Object.defineProperty(HTMLElement.prototype, "contentWindow", { get: function () { return (this._tag === "iframe" || this._tag === "frame" || this._tag === "object" || this._tag === "embed") ? (this._contentWindow || null) : undefined; }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "contentDocument", { get: function () { return (this._tag === "iframe" || this._tag === "frame" || this._tag === "object" || this._tag === "embed") ? (this._contentDocument || null) : undefined; }, configurable: true });
HTMLElement.prototype.getSVGDocument = function () { return this._contentDocument || null; };
// Event handler IDL attributes on <body>/<frameset> that forward to the window.
["afterprint", "beforeprint", "beforeunload", "pagereveal", "pageswap", "hashchange", "languagechange", "message", "messageerror", "offline", "online", "pagehide", "pageshow", "popstate", "rejectionhandled", "storage", "unhandledrejection", "unload", "blur", "error", "focus", "load", "resize", "scroll"].forEach(function (name) {
  var desc = { get: function () { var w = this.ownerDocument && this.ownerDocument.defaultView; return w ? (w["on" + name] === undefined ? null : w["on" + name]) : null; }, set: function (v) { var w = this.ownerDocument && this.ownerDocument.defaultView; if (w) w["on" + name] = typeof v === "function" || (v !== null && typeof v === "object") ? v : null; }, configurable: true, enumerable: true };
  __jb.defineOnInterfaces(["HTMLBodyElement", "HTMLFrameSetElement"], "on" + name, desc);
});
// window.frames / window.length for the top-level document.
__jb.replaceable = function (obj, name, getter) { Object.defineProperty(obj, name, { get: getter, set: function (v) { Object.defineProperty(obj, name, { value: v, writable: true, configurable: true, enumerable: true }); }, configurable: true, enumerable: true }); };
__jb.replaceable(globalThis, "frames", function () { return __jb.topFrames; });
__jb.replaceable(globalThis, "length", function () { return __jb.frameWindows(__jb.currentDocument).length; });
__jb.topFrames = new Proxy(globalThis, {
  get: function (t, k) { if (typeof k === "string" && /^(0|[1-9][0-9]*)$/.test(k)) return __jb.frameWindows(__jb.currentDocument)[Number(k)]; var v = t[k]; return v; },
  has: function (t, k) { if (typeof k === "string" && /^(0|[1-9][0-9]*)$/.test(k)) return Number(k) < __jb.frameWindows(__jb.currentDocument).length; return k in t; },
});

// The frame window (nested up to 3 deep) whose document has an element matching `spec`, for user
// actions on frame content (the target is not in the top document).
__jb.findFrameFor = function (spec, doc, depth) {
  doc = doc || __jb.currentDocument; depth = depth || 0;
  if (depth > 3 || !doc) return null;
  var ws = __jb.frameWindows(doc);
  for (var i = 0; i < ws.length; i++) {
    var w = ws[i], hit = null;
    try { hit = w.__jb && w.__jb.user && w.__jb.user.find(spec); } catch (e) { hit = null; }
    if (hit) return w;
    var deeper = null;
    try { deeper = w.__jb && w.document ? w.__jb.findFrameFor(spec, w.document, depth + 1) : null; } catch (e) { deeper = null; }
    if (deeper) return deeper;
  }
  return null;
};

// Frames a screenshot paints (engine render_screenshot): up to `max` visible frames of the page,
// each laid out in its own realm first; then the page is laid out afresh (last, so its layout is the
// current one). -> JSON [{token, id, sx, sy, w, h}]: the frame realm's layout key, the <iframe>'s
// layout id, the frame's scroll offset and its content box size.
__jb.frameShotList = function (max) {
  var doc = __jb.currentDocument, picks = [];
  if (!__jb.wptMode && doc && max > 0) {
    // the largest frames with a document of their own (ad slots and blank frames are small or empty)
    var cands = [], fs = doc.querySelectorAll("iframe,frame");
    for (var i = 0; i < fs.length && i < 200; i++) {
      var f = fs[i], w = f._contentWindow, cs, r;
      try {
        if (!w || !w.__jb || !w.document || !w.document.body || !w.document.body.firstChild) continue;
        cs = getComputedStyle(f);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
        r = f.getBoundingClientRect();
      } catch (e) { continue; }
      if (!r || r.width < 40 || r.height < 30) continue;
      cands.push({ f: f, w: w, cs: cs, r: r, area: r.width * r.height });
    }
    cands.sort(function (a, b) { return b.area - a.area; });
    for (var k = 0; k < cands.length && picks.length < max; k++) {
      var c = cands[k], ccs = c.cs;
      var px = function (p) { return parseFloat(ccs.getPropertyValue(p)) || 0; };
      var cw = Math.round(c.r.width - px("border-left-width") - px("border-right-width") - px("padding-left") - px("padding-right"));
      var ch = Math.round(c.r.height - px("border-top-width") - px("border-bottom-width") - px("padding-top") - px("padding-bottom"));
      if (cw < 20 || ch < 20 || cw > 4096 || ch > 8192) continue;
      try { c.w.eval("__jb.layoutQuery('size', { fresh: true })"); } catch (e) { continue; }
      if (!c.w.__jb.realmToken || c.w.__jb.layoutState.available === false) continue;
      picks.push({ f: c.f, token: c.w.__jb.realmToken, sx: c.w.scrollX || 0, sy: c.w.scrollY || 0, w: cw, h: ch });
    }
  }
  __jb.layoutState.key = -1; __jb.layoutQuery("size", { fresh: true });
  var out = [];
  for (var j = 0; j < picks.length; j++) {
    var p = picks[j];
    if (p.f.__jbid !== undefined) out.push({ token: p.token, id: p.f.__jbid, sx: p.sx, sy: p.sy, w: p.w, h: p.h });
  }
  return __jb.hostJson(out);
};
