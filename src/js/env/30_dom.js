// Part 4: DOM nodes (spec-shaped core: live collections, namespaces, Attr
// nodes, pre-insertion validation, mutation records)
__jb.HTML_NS = "http://www.w3.org/1999/xhtml";
__jb.SVG_NS = "http://www.w3.org/2000/svg";
__jb.MATHML_NS = "http://www.w3.org/1998/Math/MathML";
__jb.XML_NS = "http://www.w3.org/XML/1998/namespace";
__jb.XMLNS_NS = "http://www.w3.org/2000/xmlns/";
__jb.XLINK_NS = "http://www.w3.org/1999/xlink";
// Bumped on every tree/attribute mutation; live collections re-query lazily.
__jb.domVersion = 0;
// Bumped only by tree mutations and id/name/form attribute changes: caches of named
// properties (form.name) key on it, as style/class churn bumps domVersion constantly.
__jb.namesVersion = 0;
__jb.dirty = new Set(); // elements (with __jbid) whose subtree changed
__jb.markDirty = function (node) {
  __jb.layoutVersion++;
  if (__jb.scheduleObserverCheck) __jb.scheduleObserverCheck();
  while (node && node.nodeType !== 9 && node.nodeType !== 11) {
    if (node.__jbid !== undefined) { __jb.dirty.add(node); return; }
    node = node.parentNode || node._host || null;
  }
  if (node && node.nodeType === 11 && node._host) __jb.markDirty(node._host);
  else if (node && node.nodeType === 9 && node.documentElement) __jb.dirty.add(node.documentElement);
};
// Nodes of another realm (frames) are recognised structurally: their Node class is a different object.
__jb.isNode = function (v) { return v !== null && typeof v === "object" && (v instanceof Node || (typeof v.nodeType === "number" && typeof v._appendChildRaw === "function" && typeof v.getRootNode === "function")); };
__jb.expectNode = function (v, what) { if (!__jb.isNode(v)) throw new TypeError((what || "Argument") + " is not a Node."); return v; };
__jb.domError = function (name, message) { return new DOMException(message || name, name); };

// ---- name validation (DOM Standard "valid element/attribute local name") ----
var __FORBIDDEN_NAME_RE = /[\t\n\f\r \u0000\/>]/;
__jb.isAsciiAlpha = function (c) { return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a); };
__jb.validElementLocalName = function (name) {
  if (name.length === 0) return false;
  var c0 = name.codePointAt(0);
  if (__jb.isAsciiAlpha(c0)) return !__FORBIDDEN_NAME_RE.test(name);
  if (!(c0 === 0x3a || c0 === 0x5f || c0 >= 0x80)) return false;
  for (var i = c0 > 0xffff ? 2 : 1; i < name.length; i++) {
    var c = name.codePointAt(i);
    if (c > 0xffff) i++;
    var ok = c === 0x3a || c === 0x5f || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39) || __jb.isAsciiAlpha(c) || c >= 0x80;
    if (!ok) return false;
  }
  return true;
};
__jb.validAttributeLocalName = function (name) { return name.length > 0 && !/[\t\n\f\r \u0000\/=>]/.test(name); };
__jb.validNamespacePrefix = function (p) { return p.length > 0 && !__FORBIDDEN_NAME_RE.test(p); };
__jb.validDoctypeName = function (n) { return !/[\t\n\f\r \u0000>]/.test(n); };
// "validate and extract" for createElementNS / setAttributeNS.
__jb.validateAndExtract = function (ns, qname, forAttribute) {
  if (ns === "" || ns === undefined) ns = null;
  qname = String(qname);
  var prefix = null, local = qname;
  var colon = qname.indexOf(":");
  if (colon >= 0) { prefix = qname.slice(0, colon); local = qname.slice(colon + 1); }
  if (prefix !== null && !__jb.validNamespacePrefix(prefix)) throw __jb.domError("InvalidCharacterError", "The prefix '" + prefix + "' is not valid");
  var validLocal = forAttribute ? __jb.validAttributeLocalName(local) : __jb.validElementLocalName(local);
  if (!validLocal) throw __jb.domError("InvalidCharacterError", "The local name '" + local + "' is not valid");
  if (prefix !== null && ns === null) throw __jb.domError("NamespaceError", "prefix without namespace");
  if (prefix === "xml" && ns !== __jb.XML_NS) throw __jb.domError("NamespaceError", "xml prefix");
  if ((qname === "xmlns" || prefix === "xmlns") && ns !== __jb.XMLNS_NS) throw __jb.domError("NamespaceError", "xmlns");
  if (ns === __jb.XMLNS_NS && qname !== "xmlns" && prefix !== "xmlns") throw __jb.domError("NamespaceError", "xmlns namespace");
  return { ns: ns, prefix: prefix, local: local };
};

// ---- live collections (Proxy over a lazily recomputed item array) ----
__jb.makeCollection = function (proto, compute, live, named) {
  var target = Object.create(proto);
  Object.defineProperty(target, "_items", { value: [], writable: true, configurable: true, enumerable: false });
  Object.defineProperty(target, "_ver", { value: -1, writable: true, configurable: true, enumerable: false });
  function refresh() {
    if (live) { if (target._ver !== __jb.domVersion) { target._items = compute(); target._ver = __jb.domVersion; } }
    else if (target._ver < 0) { target._items = compute(); target._ver = 0; }
  }
  function namedLookup(k) {
    if (!named || typeof k !== "string" || k === "") return undefined;
    refresh();
    if (proto === HTMLFormControlsCollection.prototype) { var nm = HTMLFormControlsCollection.prototype.namedItem.call(proxyRef, k); return nm === null ? undefined : nm; }
    var items = target._items;
    for (var i = 0; i < items.length; i++) if (items[i].nodeType === 1 && items[i].getAttribute("id") === k) return items[i];
    for (var j = 0; j < items.length; j++) { var e = items[j]; if (e.nodeType === 1 && e._ns === __jb.HTML_NS && e.getAttribute("name") === k) return e; }
    return undefined;
  }
  function isIndex(k) { return typeof k === "string" && /^(0|[1-9][0-9]*)$/.test(k); }
  var proxyRef;
  return proxyRef = new Proxy(target, {
    get: function (t, k) {
      if (k === "_items" || k === "length") { refresh(); return k === "length" ? t._items.length : t._items; }
      if (isIndex(k)) { refresh(); return t._items[Number(k)]; }
      if (typeof k === "string" && !(k in t)) { var n = namedLookup(k); if (n !== undefined) return n; }
      return Reflect.get(t, k, t);
    },
    has: function (t, k) {
      if (isIndex(k)) { refresh(); return Number(k) < t._items.length; }
      if (k in t) return true;
      return namedLookup(k) !== undefined;
    },
    set: function (t, k, v) {
      if (isIndex(k)) { if (typeof t.__jbSetIndex === "function") { t.__jbSetIndex.call(proxyRef, Number(k), v); return true; } return false; }
      if (!Object.prototype.hasOwnProperty.call(t, k)) for (var lp = Object.getPrototypeOf(t); lp; lp = Object.getPrototypeOf(lp)) { var ld = Object.getOwnPropertyDescriptor(lp, k); if (ld) { if (ld.set) { ld.set.call(proxyRef, v); return true; } if (ld.get) return false; break; } }
      if (k === "length") return false;
      Object.defineProperty(t, k, { value: v, writable: true, configurable: true, enumerable: true }); return true; },
    deleteProperty: function (t, k) { if (isIndex(k)) return false; return delete t[k]; },
    ownKeys: function (t) {
      refresh();
      var keys = [];
      for (var i = 0; i < t._items.length; i++) keys.push(String(i));
      if (named) { var seen = {}; t._items.forEach(function (e) { if (e.nodeType !== 1) return; var id = e.getAttribute("id"); if (id && !seen[id] && !/^(0|[1-9][0-9]*)$/.test(id)) { seen[id] = 1; keys.push(id); } var nm = e._ns === __jb.HTML_NS ? e.getAttribute("name") : null; if (nm && !seen[nm] && !/^(0|[1-9][0-9]*)$/.test(nm)) { seen[nm] = 1; keys.push(nm); } }); }
      return keys.concat(Reflect.ownKeys(t).filter(function (k) { return keys.indexOf(k) < 0; }));
    },
    getOwnPropertyDescriptor: function (t, k) {
      if (isIndex(k)) { refresh(); var v = t._items[Number(k)]; return v === undefined ? undefined : { value: v, writable: false, enumerable: true, configurable: true }; }
      if (typeof k === "string" && !(k in t)) { var n = namedLookup(k); if (n !== undefined) return { value: n, writable: false, enumerable: false, configurable: true }; }
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
  });
};
function NodeList() { throw new TypeError("Illegal constructor"); }
NodeList.prototype.item = function (i) { i = i >>> 0; var v = this._items[i]; return v === undefined ? null : v; };
NodeList.prototype.forEach = Array.prototype.forEach;
// Iteration methods are the Array ones (WebIDL iterable declarations share them).
NodeList.prototype.entries = Array.prototype.entries;
NodeList.prototype.keys = Array.prototype.keys;
NodeList.prototype.values = Array.prototype.values;
NodeList.prototype[Symbol.iterator] = Array.prototype.values;
Object.defineProperty(NodeList.prototype, "length", { get: function () { return this._items.length; }, configurable: true });
Object.defineProperty(NodeList.prototype, Symbol.toStringTag, { value: "NodeList", configurable: true });
function HTMLCollection() { throw new TypeError("Illegal constructor"); }
HTMLCollection.prototype.item = function (i) { i = i >>> 0; var v = this._items[i]; return v === undefined ? null : v; };
HTMLCollection.prototype.namedItem = function (n) { n = String(n); if (n === "") return null; var items = this._items; for (var i = 0; i < items.length; i++) if (items[i].getAttribute("id") === n) return items[i]; for (var j = 0; j < items.length; j++) if (items[j]._ns === __jb.HTML_NS && items[j].getAttribute("name") === n) return items[j]; return null; };
HTMLCollection.prototype[Symbol.iterator] = Array.prototype.values;
Object.defineProperty(HTMLCollection.prototype, "length", { get: function () { return this._items.length; }, configurable: true });
Object.defineProperty(HTMLCollection.prototype, Symbol.toStringTag, { value: "HTMLCollection", configurable: true });
// HTMLFormControlsCollection (form.elements) and RadioNodeList (its named matches).
function HTMLFormControlsCollection() { throw new TypeError("Illegal constructor"); }
HTMLFormControlsCollection.prototype = Object.create(HTMLCollection.prototype, { constructor: { value: HTMLFormControlsCollection, writable: true, configurable: true } });
Object.setPrototypeOf(HTMLFormControlsCollection, HTMLCollection);
function RadioNodeList() { throw new TypeError("Illegal constructor"); }
RadioNodeList.prototype = Object.create(NodeList.prototype, { constructor: { value: RadioNodeList, writable: true, configurable: true } });
Object.setPrototypeOf(RadioNodeList, NodeList);
__jb.formControlsMatching = function (items, name) { return items.filter(function (e) { return e.nodeType === 1 && (e.getAttribute("id") === name || e.getAttribute("name") === name); }); };
HTMLFormControlsCollection.prototype.namedItem = function namedItem(name) {
  if (arguments.length < 1) throw new TypeError("Failed to execute 'namedItem' on 'HTMLFormControlsCollection': 1 argument required.");
  name = String(name);
  if (name === "") return null;
  var col = this, matches = __jb.formControlsMatching(col._items, name);
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  return __jb.makeCollection(RadioNodeList.prototype, function () { return __jb.formControlsMatching(col._items, name); }, true, false);
};
Object.defineProperty(RadioNodeList.prototype, "value", {
  get: function () { var items = this._items; for (var i = 0; i < items.length; i++) { var e = items[i]; if (e._tag === "input" && __jb.inputType(e) === "radio" && e.checked) { var v = e.getAttribute("value"); return v === null ? "on" : v; } } return ""; },
  set: function (v) { v = String(v); var items = this._items; for (var i = 0; i < items.length; i++) { var e = items[i]; if (e._tag !== "input" || __jb.inputType(e) !== "radio") continue; var ev = e.getAttribute("value"); if ((ev === null ? "on" : ev) === v) { e.checked = true; return; } } },
  enumerable: true, configurable: true,
});
__jb.staticNodeList = function (items) { return __jb.makeCollection(NodeList.prototype, function () { return items; }, false, false); };
__jb.liveNodeList = function (compute) { return __jb.makeCollection(NodeList.prototype, compute, true, false); };
__jb.liveCollection = function (compute) { return __jb.makeCollection(HTMLCollection.prototype, compute, true, true); };
__jb.isCollection = function (v) { return v && typeof v === "object" && (NodeList.prototype.isPrototypeOf(v) || HTMLCollection.prototype.isPrototypeOf(v)); };

// ---- tree helpers ----
// The document's first <base href> element (looked up once per DOM version: URL resolution is hot).
__jb.docBaseEl = function (doc) {
  if (!doc || !doc.querySelector) return null;
  var bc = doc._jbBaseEl;
  if (!bc || bc.version !== __jb.namesVersion) { bc = { version: __jb.namesVersion, el: doc.querySelector("base[href]") }; Object.defineProperty(doc, "_jbBaseEl", { value: bc, writable: true, configurable: true }); }
  return bc.el;
};
__jb.descendants = function (root, filter) {
  var out = [];
  if (root._first === undefined) { (function walk(n) { for (var c = n.firstChild; c; c = c.nextSibling) { if (!filter || filter(c)) out.push(c); if (c.nodeType === 1) walk(c); } })(root); return out; }
  // Iterative pre-order walk over the tree slots (no getter calls; deep trees cost no stack).
  var c = root._first;
  while (c) {
    if (!filter || filter(c)) out.push(c);
    if (c._first && c._attrs !== undefined) { c = c._first; continue; } // descend into elements only
    while (c && !c._next) { c = c._parent; if (c === root) c = null; }
    if (c) c = c._next;
  }
  return out;
};
__jb.allNodes = function (root) { var out = []; (function walk(n) { out.push(n); for (var c = n.firstChild; c; c = c.nextSibling) walk(c); })(root); return out; };
__jb.hostIncludingInclusiveAncestor = function (a, b) {
  // is `a` a host-including inclusive ancestor of `b`?
  for (var n = b; n; n = n.parentNode) if (n === a) return true;
  var root = b; while (root.parentNode) root = root.parentNode;
  if (root.nodeType === 11 && root._host) return __jb.hostIncludingInclusiveAncestor(a, root._host);
  // a template's contents have the template as their host
  if (root.nodeType === 11 && root._templateHost) return __jb.hostIncludingInclusiveAncestor(a, root._templateHost);
  return false;
};
__jb.ownerDoc = function (node) { return node.nodeType === 9 ? node : node.ownerDocument; };
__jb.adoptInto = function (node, doc) {
  if (!doc || node.nodeType === 9 || node.ownerDocument === doc) return;
  var adopted = [];
  var raw = function (n, d) {
    if (n.nodeType === 9 || n.ownerDocument === d) return;
    var old = n.ownerDocument;
    n._doc = d;
    if (n.nodeType === 1) {
      for (var i = 0; i < n._attrs.length; i++) n._attrs[i]._doc = d;
      if (n._ceDef && !n._ceFailed && !n._ceDefPending) adopted.push([n, old, d]);
      if (n._shadowRoot) raw(n._shadowRoot, d);
    }
    // template adopting steps: its contents move to the new document's template contents owner
    if (n.nodeType === 1 && n._tag === "template" && n._ns === __jb.HTML_NS && n._content) raw(n._content, __jb.templateDocument(d));
    for (var c = n.firstChild; c; c = c.nextSibling) raw(c, d);
  };
  raw(node, doc);
  // custom element reactions: adoptedCallback(oldDocument, newDocument) in tree order
  adopted.forEach(function (a) {
    var cb = a[0]._ceDef.callbacks && a[0]._ceDef.callbacks.adoptedCallback;
    if (typeof cb === "function") { try { cb.call(a[0], a[1], a[2]); } catch (e) { __jb.reportException(e); } }
  });
};
__jb.NAMED_ACCESS_TAGS = { embed: 1, form: 1, img: 1, object: 1, iframe: 1 };
__jb.reservedGlobal = function (name) { return name === "" || Object.prototype.hasOwnProperty.call(globalThis, name) || /^(document|window|location|navigator|history|top|parent|self|frames|length|event|name|status|closed|opener|console|__jb)$/.test(name); };
// Define a lazy global getter for `name` that resolves to the element(s) with that id/name.
__jb.defineNamedAccess = function (name) {
  if (typeof name !== "string" || __jb.reservedGlobal(name)) return;
  try {
    Object.defineProperty(globalThis, name, {
      get: function () {
        var byId = __jb.currentDocument.getElementById(name);
        var named = __jb.descendants(__jb.currentDocument, function (n) { return n.nodeType === 1 && ((n._ns === __jb.HTML_NS && __jb.NAMED_ACCESS_TAGS[n._tag] && n.getAttribute("name") === name) || n.getAttribute("id") === name); });
        // A frame is named through its browsing context only: without one, a name match is no match.
        named = named.filter(function (n) { return !((n._tag === "iframe" || n._tag === "frame") && n.getAttribute("id") !== name && !n._contentWindow); });
        if (byId && named.indexOf(byId) < 0) byId = null;
        var frame = named.find(function (n) { return n._tag === "iframe" && n._contentWindow; });
        var wrapW = function (w) { return typeof __jb.wrapWindow === "function" ? __jb.wrapWindow(w) : w; };
        if (frame && frame.getAttribute("name") === name) return wrapW(frame._contentWindow);
        if (named.length > 1) return __jb.liveCollection(function () { return __jb.descendants(__jb.currentDocument, function (n) { return n.nodeType === 1 && n._ns === __jb.HTML_NS && ((__jb.NAMED_ACCESS_TAGS[n._tag] && n.getAttribute("name") === name) || n.getAttribute("id") === name); }); });
        var found = byId || named[0];
        // Frames are named objects through their browsing context name (the name attribute).
        if (found && (found._tag === "iframe" || found._tag === "frame") && found.getAttribute("name") === name && found._contentWindow) return wrapW(found._contentWindow);
        return found || undefined;
      },
      set: function (v) { Object.defineProperty(globalThis, name, { value: v, writable: true, configurable: true, enumerable: true }); },
      configurable: true,
      enumerable: false,
    });
  } catch (e) {}
};
__jb.registerNamedAccess = function (el) {
  var id = el.getAttribute("id"); if (id) __jb.defineNamedAccess(id);
  if (el._ns === __jb.HTML_NS && __jb.NAMED_ACCESS_TAGS[el._tag]) { var nm = el.getAttribute("name"); if (nm) __jb.defineNamedAccess(nm); }
};
__jb.connected = function (node) {
  if (node.nodeType !== 1) return;
  if (node.ownerDocument === __jb.currentDocument && (node._ns === __jb.HTML_NS || node.hasAttribute("id"))) __jb.registerNamedAccess(node);
  // Exclusive accordions: an inserted open details yields to an earlier open one with the same name.
  if (node._tag === "details" && node._ns === __jb.HTML_NS && node.hasAttribute("open") && node.getAttribute("name")) {
    var dn = node.getAttribute("name"), dr = node.getRootNode();
    if (__jb.descendants(dr, function (o) { return o !== node && o.nodeType === 1 && o._tag === "details" && o._ns === __jb.HTML_NS && o.getAttribute("name") === dn && o.hasAttribute("open") && !(node.compareDocumentPosition(o) & 4); }).length) node.removeAttribute("open");
  }
  __jb.customElementConnected(node);
  // Real pages: A/B-testing anti-flicker styles (Adobe Target `body{opacity:0 !important}`, VWO,
  // Adobe Web SDK) hide the whole page until their library loads or a 3-4 s timer fires; tracker
  // blocking and load budgets left FedEx's body at opacity 0 (blank screenshots, every element
  // "hidden" to the agent). Removed right after insertion, as the timer would have.
  if (node._tag === "style" && !__jb.wptMode && /^(at-body-style|alloy-prehiding|_vis_opt_path_hides|abtasty-prehide)$/.test(node.getAttribute("id") || "")) {
    Promise.resolve().then(function () { if (node.parentNode) node.parentNode.removeChild(node); });
  }
  if (node._tag === "script" && node._ns === __jb.HTML_NS && node.ownerDocument === __jb.currentDocument && !node._executed) {
    // Inline classic scripts run synchronously on insertion, as in a
    // browser; external and module scripts go through the async queue.
    // Inline classic scripts run synchronously on insertion (the parser
    // executes a document.write'd inline script at once too, unless a
    // written external script is still pending ahead of it); external and
    // module scripts go through the async queue.
    var writtenBlocking = __jb.inDocumentWrite && __jb.pendingScripts.some(function (s) { return s._fromWrite; });
    if (__jb.inDocumentWrite) node._fromWrite = true;
    if (__jb.scriptsLive && !writtenBlocking && !node.hasAttribute("src") && node.textContent !== "" && __jb.scriptKind(node) === "classic" && typeof __jb.runScriptElement === "function") {
      if (__jb.insertDepth > 0 && !__jb.inDocumentWrite) __jb.postConnection.push(node); else __jb.runScriptElement(node);
    }
    else { node._prepDoc = node.ownerDocument; __jb.pendingScripts.push(node); __jb.wakeForPendingScripts(); }
  }
  // Frame insertion steps are post-connection steps: they run once the whole insertion is done.
  if ((node._tag === "iframe" || node._tag === "frame") && node._ns === __jb.HTML_NS) __jb.frameTreeVersion = (__jb.frameTreeVersion || 0) + 1;
  if ((node._tag === "iframe" || node._tag === "frame") && node._ns === __jb.HTML_NS && typeof __jb.iframeConnected === "function") { if (__jb.insertDepth > 0) __jb.postConnection.push(node); else __jb.iframeConnected(node); }
  for (var c = node.firstChild; c; c = c.nextSibling) __jb.connected(c);
  if (node._shadowRoot) for (var sc = node._shadowRoot.firstChild; sc; sc = sc.nextSibling) __jb.connected(sc);
};
__jb.disconnected = function (node) {
  if (node.nodeType !== 1) return;
  if (node._popoverState === "showing" && typeof __jb.hidePopover === "function") __jb.hidePopover(node, false, false, true);
  if (node._tag === "dialog" && node.hasAttribute("open") && node._modal) { node._modal = false; var tli = __jb.topLayer.indexOf(node); if (tli >= 0) __jb.topLayer.splice(tli, 1); }
  if (node._ceDef && node._ceConnected && typeof node.disconnectedCallback === "function") { node._ceConnected = false; try { node.disconnectedCallback(); } catch (e) { console.error(String(e)); } }
  if ((node._tag === "iframe" || node._tag === "frame") && node._ns === __jb.HTML_NS) __jb.frameTreeVersion = (__jb.frameTreeVersion || 0) + 1;
  if ((node._tag === "iframe" || node._tag === "frame") && node._ns === __jb.HTML_NS && typeof __jb.iframeDisconnected === "function") __jb.iframeDisconnected(node);
  for (var c = node.firstChild; c; c = c.nextSibling) __jb.disconnected(c);
  if (node._shadowRoot) for (var sc = node._shadowRoot.firstChild; sc; sc = sc.nextSibling) __jb.disconnected(sc);
};
__jb.pendingScripts = [];
// A frame's (or popup's) inserted scripts are drained by the top-level event loop after one of the
// child realm's tasks: queue an empty task so an otherwise idle loop gets to them.
__jb.wakeForPendingScripts = function () {
  if (__jb.pendingWake || !(__jb.frameContext || __jb.auxiliary) || typeof setTimeout !== "function") return;
  __jb.pendingWake = true;
  try { setTimeout(function () { __jb.pendingWake = false; }, 0); } catch (e) { __jb.pendingWake = false; }
};
__jb.scriptsLive = false;
__jb.queueToggle = function (el, oldState, newState) {
  if (el._toggleTask) { el._toggleTask.newState = newState; return; }
  el._toggleTask = { oldState: oldState, newState: newState };
  setTimeout(function () { var t = el._toggleTask; el._toggleTask = null; if (!t) return; var ev = new ToggleEvent("toggle", { oldState: t.oldState, newState: t.newState }); __jb.setTrusted(ev, true); ev._trustedDispatch = true; try { el.dispatchEvent(ev); } catch (e) { __jb.reportException(e); } }, 0);
};
__jb.JS_MIME_TYPES = ["application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript", "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2", "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript", "text/x-ecmascript", "text/x-javascript"];
// HTML "prepare the script element" type check: "classic", "module" or null
// (data blocks such as JSON-LD, templates and import maps).
__jb.scriptKind = function (el) {
  var type = el.getAttribute("type"), lang = el.getAttribute("language"), t;
  if ((type === null || type === "") && (lang === null || lang === "")) t = "text/javascript";
  else if (type === null) t = "text/" + lang;
  else t = type.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  t = t.toLowerCase();
  if (t === "module") return "module";
  if (t === "importmap") { __jb.registerImportMapScript(el); return null; }
  if (__jb.JS_MIME_TYPES.indexOf(t) < 0) return null;
  // Legacy for/event scripts only run for window's load event.
  if (__jb.legacyForEventBlocked(el.getAttribute("for"), el.getAttribute("event"))) return null;
  return "classic";
};
// <script type=importmap>: register the map with this realm's module resolver once (HTML
// "register an import map"); parse errors are reported to the window, external maps fail.
__jb.registerImportMapScript = function (el) {
  if (el._importMapDone || !el.isConnected) return;
  var doc = el.ownerDocument;
  if (!doc || !doc.defaultView) return;
  el._importMapDone = true;
  if (el.hasAttribute("src")) {
    setTimeout(function () { el.dispatchEvent(new Event("error")); }, 0);
    return;
  }
  var r = null;
  try { r = __jb.native("importMap", { json: __jb.childTextContent(el), base: doc.baseURI }); } catch (e) { r = null; }
  if (r && r.error) {
    var m = /^(\w+): ([\s\S]*)$/.exec(String(r.error));
    var err = m && m[1] === "SyntaxError" ? new SyntaxError(m[2]) : new TypeError(m ? m[2] : String(r.error));
    if (typeof __jb.reportException === "function") __jb.reportException(err);
  }
};
__jb.legacyForEventBlocked = function (forAttr, eventAttr) {
  if (forAttr === null || eventAttr === null) return false;
  var low = function (s) { return String(s).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").replace(/[A-Z]/g, function (c) { return c.toLowerCase(); }); };
  var f = low(forAttr), e = low(eventAttr);
  return f !== "window" || (e !== "onload" && e !== "onload()");
};

// ---- mutation observers (records queued here, delivered as microtasks) ----
__jb.mutationObservers = [];
__jb.queueMutationRecord = function (type, target, opts) {
  if (!__jb.mutationObservers.length) return;
  opts = opts || {};
  var interested = [];
  for (var n = target; n; n = n.parentNode || (n.nodeType === 11 ? null : null)) {
    for (var i = 0; i < __jb.mutationObservers.length; i++) {
      var mo = __jb.mutationObservers[i];
      for (var j = 0; j < mo._targets.length; j++) {
        var reg = mo._targets[j];
        if (reg.node !== n) continue;
        var o = reg.options;
        if (n !== target && !o.subtree) continue;
        if (type === "attributes" && !o.attributes) continue;
        if (type === "attributes" && o.attributeFilter && (opts.attributeNamespace !== null || o.attributeFilter.indexOf(opts.attributeName) < 0)) continue;
        if (type === "characterData" && !o.characterData) continue;
        if (type === "childList" && !o.childList) continue;
        var entry = null;
        for (var k = 0; k < interested.length; k++) if (interested[k].mo === mo) entry = interested[k];
        if (!entry) { entry = { mo: mo, oldValue: false }; interested.push(entry); }
        if ((type === "attributes" && o.attributeOldValue) || (type === "characterData" && o.characterDataOldValue)) entry.oldValue = true;
      }
    }
  }
  for (var q = 0; q < interested.length; q++) {
    var rec = new MutationRecord();
    rec.type = type; rec.target = target;
    rec.addedNodes = __jb.staticNodeList(opts.addedNodes || []);
    rec.removedNodes = __jb.staticNodeList(opts.removedNodes || []);
    rec.previousSibling = opts.previousSibling || null;
    rec.nextSibling = opts.nextSibling || null;
    rec.attributeName = opts.attributeName === undefined ? null : opts.attributeName;
    rec.attributeNamespace = opts.attributeNamespace === undefined ? null : opts.attributeNamespace;
    rec.oldValue = interested[q].oldValue ? (opts.oldValue === undefined ? null : opts.oldValue) : null;
    var mo2 = interested[q].mo;
    mo2._queue.push(rec);
    __jb.scheduleMutationDelivery(mo2);
  }
};
__jb.scheduleMutationDelivery = function (mo) {
  if (mo._scheduled) return;
  mo._scheduled = true;
  Promise.resolve().then(function () {
    mo._scheduled = false;
    var q = mo._queue.splice(0);
    if (q.length) { try { mo._callback.call(mo, q, mo); } catch (e) { __jb.reportException(e); } }
  });
};
// Legacy shim used by older code paths.
__jb.notifyMutation = function (target, record) { __jb.queueMutationRecord(record.type, target, record); };
class MutationRecord { constructor() { this.type = ""; this.target = null; this.addedNodes = null; this.removedNodes = null; this.previousSibling = null; this.nextSibling = null; this.attributeName = null; this.attributeNamespace = null; this.oldValue = null; } }
class MutationObserver {
  constructor(cb) { if (typeof cb !== "function") throw new TypeError("MutationObserver constructor: Argument 1 is not callable."); this._callback = cb; this._targets = []; this._queue = []; this._scheduled = false; }
  observe(node, options) {
    __jb.expectNode(node, "MutationObserver.observe: Argument 1");
    options = Object.assign({}, options || {});
    if (("attributeOldValue" in options || "attributeFilter" in options) && !("attributes" in options)) options.attributes = true;
    if ("characterDataOldValue" in options && !("characterData" in options)) options.characterData = true;
    if (!options.childList && !options.attributes && !options.characterData) throw new TypeError("The options object must set at least one of 'attributes', 'characterData', or 'childList' to true.");
    if (options.attributeOldValue && !options.attributes) throw new TypeError("attributeOldValue requires attributes");
    if (options.attributeFilter && !options.attributes) throw new TypeError("attributeFilter requires attributes");
    if (options.characterDataOldValue && !options.characterData) throw new TypeError("characterDataOldValue requires characterData");
    if (options.attributeFilter) options.attributeFilter = __jb.arrayFrom(options.attributeFilter, String);
    var existing = this._targets.find(function (t) { return t.node === node; });
    if (existing) existing.options = options; else this._targets.push({ node: node, options: options });
    if (__jb.mutationObservers.indexOf(this) < 0) __jb.mutationObservers.push(this);
  }
  disconnect() { this._targets = []; this._queue = []; var i = __jb.mutationObservers.indexOf(this); if (i >= 0) __jb.mutationObservers.splice(i, 1); }
  takeRecords() { return this._queue.splice(0); }
}

// ---- insertion / removal algorithms ----
__jb.ensurePreInsertionValidity = function (parent, node, child) {
  __jb.expectNode(node, "Node argument");
  var pt = parent.nodeType;
  if (pt !== 9 && pt !== 11 && pt !== 1) throw __jb.domError("HierarchyRequestError", "Cannot insert into this node type");
  if (__jb.hostIncludingInclusiveAncestor(node, parent)) throw __jb.domError("HierarchyRequestError", "The new child is an ancestor of the parent");
  if (child !== null && child.parentNode !== parent) throw __jb.domError("NotFoundError", "The node before which the new node is to be inserted is not a child of this node");
  var nt = node.nodeType;
  if (!(nt === 11 || nt === 10 || nt === 1 || nt === 3 || nt === 7 || nt === 8 || nt === 4)) throw __jb.domError("HierarchyRequestError", "Node type not allowed");
  if ((nt === 3 && pt === 9) || (nt === 10 && pt !== 9)) throw __jb.domError("HierarchyRequestError", "Text or doctype in the wrong place");
  if (pt === 9) {
    var doctypeFollows = function (c) { for (var s = c; s; s = s.nextSibling) if (s.nodeType === 10) return true; return false; };
    var hasElementChild = function () { for (var s = parent.firstChild; s; s = s.nextSibling) if (s.nodeType === 1) return true; return false; };
    if (nt === 11) {
      var elements = 0, hasText = false;
      for (var c = node.firstChild; c; c = c.nextSibling) { if (c.nodeType === 1) elements++; else if (c.nodeType === 3) hasText = true; }
      if (elements > 1 || hasText) throw __jb.domError("HierarchyRequestError", "Fragment cannot be inserted into a document");
      if (elements === 1 && (hasElementChild() || (child && child.nodeType === 10) || (child && doctypeFollows(child.nextSibling)))) throw __jb.domError("HierarchyRequestError", "Document already has a document element");
    } else if (nt === 1) {
      if (hasElementChild() || (child && child.nodeType === 10) || (child && doctypeFollows(child.nextSibling))) throw __jb.domError("HierarchyRequestError", "Document already has a document element");
    } else if (nt === 10) {
      var hasDoctype = false; for (var d = parent.firstChild; d; d = d.nextSibling) if (d.nodeType === 10) hasDoctype = true;
      var elementPrecedes = false; if (child) for (var p = child.previousSibling; p; p = p.previousSibling) if (p.nodeType === 1) elementPrecedes = true;
      if (hasDoctype || elementPrecedes || (!child && hasElementChild())) throw __jb.domError("HierarchyRequestError", "Doctype cannot be inserted here");
    }
  }
};
__jb.preInsert = function (parent, node, child) {
  __jb.ensurePreInsertionValidity(parent, node, child);
  var ref = child;
  if (ref === node) ref = node.nextSibling;
  __jb.insert(parent, node, ref, false);
  return node;
};
__jb.insertDepth = 0;
__jb.postConnection = [];
__jb.insert = function (parent, node, child, suppressObservers) {
  __jb.insertDepth++;
  try { __jb.insertInner(parent, node, child, suppressObservers); }
  finally {
    __jb.insertDepth--;
    if (__jb.insertDepth === 0 && __jb.postConnection.length) {
      var pending = __jb.postConnection.splice(0);
      pending.forEach(function (f) {
        try {
          if (!f.isConnected) return;
          if (f._tag === "script") { if (!f._executed) __jb.runScriptElement(f); }
          else __jb.iframeConnected(f);
        } catch (e) { __jb.reportException(e); }
      });
    }
  }
};
__jb.insertInner = function (parent, node, child, suppressObservers) {
  var nodes = node.nodeType === 11 ? __jb.arrayFrom(node.childNodes) : [node];
  if (!nodes.length) return;
  if (node.nodeType === 11) {
    for (var i = 0; i < nodes.length; i++) node._removeChildRaw(nodes[i]);
    __jb.queueMutationRecord("childList", node, { removedNodes: nodes });
  }
  var previousSibling = child ? child.previousSibling : parent.lastChild;
  if (child && __jb.rangesInsert) __jb.rangesInsert(parent, __jb.nodeIndex(child), nodes.length);
  var parentConnected = parent.isConnected;
  var doc = __jb.ownerDoc(parent);
  for (var j = 0; j < nodes.length; j++) {
    var n = nodes[j];
    // adopting into another document removes the node from its old parent first (with its
    // removing steps: disconnected reactions, mutation record)
    if (doc && n.parentNode && n.ownerDocument !== doc && n.nodeType !== 9) __jb.remove(n);
    __jb.adoptInto(n, doc);
    if (n.parentNode) { var oldParent = n.parentNode, oldNextSib = n.nextSibling, oldSlot = __jb.assignedSlotOf ? __jb.assignedSlotOf(n) : null; if (__jb.rangesRemove) __jb.rangesRemove(n, oldParent); oldParent._removeChildRaw(n); if (__jb.slotsAfterRemove) __jb.slotsAfterRemove(oldParent, n, oldSlot); if (typeof __jb.imageTreeMutation === "function" && n.nodeType === 1 && n._ns === __jb.HTML_NS) __jb.imageTreeMutation(n, oldParent, oldNextSib); } // moving runs the removing steps
    if (child) parent._insertBeforeRaw(n, child); else parent._appendChildRaw(n);
    if (__jb.slotsAfterInsert) __jb.slotsAfterInsert(parent, n);
    if (parentConnected) __jb.connected(n);
    if (typeof __jb.imageTreeMutation === "function" && n.nodeType === 1 && n._ns === __jb.HTML_NS) __jb.imageTreeMutation(n, parent); // insertion steps (also in disconnected trees)
  }
  if (!suppressObservers) __jb.queueMutationRecord("childList", parent, { addedNodes: nodes, previousSibling: previousSibling, nextSibling: child });
  if (parentConnected && parent._tag === "script" && parent._ns === __jb.HTML_NS && !parent._executed && __jb.scriptsLive && parent.ownerDocument === __jb.currentDocument) __jb.scriptChildrenChanged(parent);
  __jb.markDirty(parent);
};
// A script's "child text content": its Text children only.
__jb.childTextContent = function (el) { var t = ""; for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) t += c.data; return t; };
// Children changed steps of a connected script that has not started: prepare it again.
__jb.scriptChildrenChanged = function (s) {
  if (__jb.pendingScripts.indexOf(s) >= 0) return;
  var kind = __jb.scriptKind(s);
  if (!kind) return;
  if (!s.hasAttribute("src") && __jb.childTextContent(s) === "") return;
  if (kind === "classic" && !s.hasAttribute("src") && typeof __jb.runScriptElement === "function") __jb.runScriptElement(s);
  else { __jb.pendingScripts.push(s); __jb.wakeForPendingScripts(); }
};
__jb.remove = function (node, suppressObservers) {
  var parent = node.parentNode;
  if (!parent) return;
  var oldPrev = node.previousSibling, oldNext = node.nextSibling;
  var wasConnected = node.isConnected;
  var oldSlot = __jb.assignedSlotOf ? __jb.assignedSlotOf(node) : null;
  if (__jb.rangesRemove) __jb.rangesRemove(node, parent);
  parent._removeChildRaw(node);
  if (__jb.slotsAfterRemove) __jb.slotsAfterRemove(parent, node, oldSlot);
  if (wasConnected) __jb.disconnected(node);
  // Removing steps of img/source/picture children are relevant mutations for the picture's images.
  if (typeof __jb.imageTreeMutation === "function" && node.nodeType === 1 && node._ns === __jb.HTML_NS) __jb.imageTreeMutation(node, parent, oldNext);
  if (!suppressObservers) __jb.queueMutationRecord("childList", parent, { removedNodes: [node], previousSibling: oldPrev, nextSibling: oldNext });
  __jb.markDirty(parent);
};
__jb.replaceChild = function (parent, node, child) {
  __jb.expectNode(node, "Node argument"); __jb.expectNode(child, "Child argument");
  var pt = parent.nodeType;
  if (pt !== 9 && pt !== 11 && pt !== 1) throw __jb.domError("HierarchyRequestError", "Cannot replace in this node type");
  if (__jb.hostIncludingInclusiveAncestor(node, parent)) throw __jb.domError("HierarchyRequestError", "The new child is an ancestor of the parent");
  if (child.parentNode !== parent) throw __jb.domError("NotFoundError", "The node to be replaced is not a child of this node");
  var nt = node.nodeType;
  if (!(nt === 11 || nt === 10 || nt === 1 || nt === 3 || nt === 7 || nt === 8 || nt === 4)) throw __jb.domError("HierarchyRequestError", "Node type not allowed");
  if ((nt === 3 && pt === 9) || (nt === 10 && pt !== 9)) throw __jb.domError("HierarchyRequestError", "Text or doctype in the wrong place");
  if (pt === 9) {
    var otherElement = function () { for (var s = parent.firstChild; s; s = s.nextSibling) if (s.nodeType === 1 && s !== child) return true; return false; };
    var doctypeFollows = function () { for (var s = child.nextSibling; s; s = s.nextSibling) if (s.nodeType === 10) return true; return false; };
    if (nt === 11) {
      var elements = 0, hasText = false;
      for (var c = node.firstChild; c; c = c.nextSibling) { if (c.nodeType === 1) elements++; else if (c.nodeType === 3) hasText = true; }
      if (elements > 1 || hasText) throw __jb.domError("HierarchyRequestError", "Fragment cannot be inserted into a document");
      if (elements === 1 && (otherElement() || doctypeFollows())) throw __jb.domError("HierarchyRequestError", "Document already has a document element");
    } else if (nt === 1) {
      if (otherElement() || doctypeFollows()) throw __jb.domError("HierarchyRequestError", "Document already has a document element");
    } else if (nt === 10) {
      var otherDoctype = false; for (var d = parent.firstChild; d; d = d.nextSibling) if (d.nodeType === 10 && d !== child) otherDoctype = true;
      var elementPrecedes = false; for (var p = child.previousSibling; p; p = p.previousSibling) if (p.nodeType === 1) elementPrecedes = true;
      if (otherDoctype || elementPrecedes) throw __jb.domError("HierarchyRequestError", "Doctype cannot be inserted here");
    }
  }
  var referenceChild = child.nextSibling;
  if (referenceChild === node) referenceChild = node.nextSibling;
  var previousSibling = child.previousSibling;
  var removedNodes = [];
  if (child.parentNode) { removedNodes = [child]; __jb.remove(child, true); }
  var nodes = node.nodeType === 11 ? __jb.arrayFrom(node.childNodes) : [node];
  __jb.insert(parent, node, referenceChild, true);
  __jb.queueMutationRecord("childList", parent, { addedNodes: nodes, removedNodes: removedNodes, previousSibling: previousSibling, nextSibling: referenceChild });
  return child;
};
__jb.replaceAll = function (parent, node) {
  var removedNodes = __jb.arrayFrom(parent.childNodes);
  var addedNodes = node ? (node.nodeType === 11 ? __jb.arrayFrom(node.childNodes) : [node]) : [];
  for (var i = 0; i < removedNodes.length; i++) __jb.remove(removedNodes[i], true);
  if (node) __jb.insert(parent, node, null, true);
  if (addedNodes.length || removedNodes.length) __jb.queueMutationRecord("childList", parent, { addedNodes: addedNodes, removedNodes: removedNodes });
  __jb.markDirty(parent);
};
// Convert nodes-or-strings (ParentNode/ChildNode methods) into a single node.
__jb.convertNodes = function (ctx, args) {
  var doc = __jb.ownerDoc(ctx);
  var nodes = [];
  for (var i = 0; i < args.length; i++) nodes.push(__jb.isNode(args[i]) ? args[i] : doc.createTextNode(String(args[i])));
  if (nodes.length === 1) return nodes[0];
  var frag = doc.createDocumentFragment();
  for (var j = 0; j < nodes.length; j++) __jb.preInsert(frag, nodes[j], null);
  return frag;
};

class Node extends EventTarget {
  constructor(doc) {
    super();
    if (new.target === Node) throw new TypeError("Illegal constructor");
    // Tree pointers live in internal slots; the IDL attributes are readonly accessors on Node.prototype.
    this._doc = doc || null;
    this._parent = null; this._first = null; this._last = null; this._prev = null; this._next = null;
  }
  get parentNode() { return this._parent; }
  get firstChild() { return this._first; }
  get lastChild() { return this._last; }
  get previousSibling() { return this._prev; }
  get nextSibling() { return this._next; }
  get ownerDocument() { return this.nodeType === 9 ? null : this._doc; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get childNodes() { var self_ = this; if (!Object.prototype.hasOwnProperty.call(this, "_childNodesList")) Object.defineProperty(this, "_childNodesList", { value: __jb.liveNodeList(function () { var a = []; for (var c = self_.firstChild; c; c = c.nextSibling) a.push(c); return a; }), enumerable: false, configurable: true }); return this._childNodesList; }
  get isConnected() { var n = this; for (;;) { var p = n._parent; if (p) { n = p; continue; } if (n._host) { n = n._host; continue; } return n.nodeType === 9; } }
  get baseURI() { var doc = __jb.ownerDoc(this); if (!doc) return ""; var fallback = (doc.URL === "about:blank" || doc.URL === "about:srcdoc") && doc._fallbackBase ? doc._fallbackBase : doc.URL; if (doc.querySelector) { var b = __jb.docBaseEl(doc); if (b) { try { var bh = new URL(b.getAttribute("href"), fallback).href; if (typeof __jb.baseAllowed !== "function" || __jb.baseAllowed(b, bh)) return bh; } catch (e) {} } } return fallback; }
  hasChildNodes() { return !!this.firstChild; }
  // raw _parent walk: event dispatch asks for the root of every node on the path, and the wrapped
  // parentNode getter made that the top cost of image-heavy loads (Vijay Sales)
  getRootNode(options) { var n = this; while (n._parent) n = n._parent; if (options && options.composed && n.nodeType === 11 && n._host) return n._host.getRootNode(options); return n; }
  contains(o) { if (o === null || o === undefined) return false; __jb.expectNode(o, "Node.contains: Argument 1"); for (var n = o; n; n = n.parentNode) if (n === this) return true; return false; }
  compareDocumentPosition(other) {
    __jb.expectNode(other, "Node.compareDocumentPosition: Argument 1");
    if (this === other) return 0;
    var node1 = other, node2 = this, attr1 = null, attr2 = null;
    if (node1.nodeType === 2) { attr1 = node1; node1 = attr1.ownerElement; }
    if (node2.nodeType === 2) {
      attr2 = node2; node2 = attr2.ownerElement;
      if (attr1 && node1 && node2 === node1) { for (var i = 0; i < node2._attrs.length; i++) { if (node2._attrs[i] === attr1) return 32 + 2; if (node2._attrs[i] === attr2) return 32 + 4; } }
    }
    var root1 = node1, root2 = node2;
    while (root1 && root1.parentNode) root1 = root1.parentNode;
    while (root2 && root2.parentNode) root2 = root2.parentNode;
    if (!node1 || !node2 || root1 !== root2) return 1 + 32 + (Math.random() < 0.5 ? 2 : 4) * 0 + (__jb.objectOrder(this, other) ? 4 : 2);
    if (__jb.isAncestor(node1, node2) || (node1 === node2 && attr2)) return 8 + 2;
    if (__jb.isAncestor(node2, node1) || (node1 === node2 && attr1)) return 16 + 4;
    var all = __jb.allNodes(root1);
    return all.indexOf(node1) < all.indexOf(node2) ? 2 : 4;
  }
  isSameNode(o) { return this === o; }
  isEqualNode(o) { return !!o && __jb.nodesEqual(this, o); }
  isDefaultNamespace(ns) { if (ns === "" || ns === undefined) ns = null; return this.lookupNamespaceURI(null) === ns; }
  lookupPrefix(ns) { if (ns === null || ns === "" || ns === undefined) return null; var el = this.nodeType === 1 ? this : this.nodeType === 9 ? this.documentElement : this.nodeType === 2 ? this.ownerElement : this.parentElement; return el ? __jb.locatePrefix(el, ns) : null; }
  lookupNamespaceURI(prefix) {
    if (prefix === "" || prefix === undefined) prefix = null;
    switch (this.nodeType) {
      case 1: return __jb.locateNamespace(this, prefix);
      case 9: return this.documentElement ? __jb.locateNamespace(this.documentElement, prefix) : null;
      case 10: case 11: return null;
      case 2: return this.ownerElement ? __jb.locateNamespace(this.ownerElement, prefix) : null;
      default: return this.parentElement ? __jb.locateNamespace(this.parentElement, prefix) : null;
    }
  }
  normalize() {
    var texts = __jb.descendants(this, function (n) { return n.nodeType === 3; });
    for (var i = 0; i < texts.length; i++) {
      var node = texts[i];
      if (!node.parentNode) continue;
      var length = node.data.length;
      if (length === 0) { __jb.remove(node); continue; }
      var data = "", next = node.nextSibling, toRemove = [];
      while (next && next.nodeType === 3) { data += next.data; toRemove.push(next); next = next.nextSibling; }
      if (data) __jb.replaceData(node, length, 0, data);
      for (var k = 0; k < toRemove.length; k++) __jb.remove(toRemove[k]);
    }
  }
  _appendChildRaw(child) {
    if (child.parentNode) child.parentNode._removeChildRaw(child);
    child._parent = this; child._prev = this.lastChild; child._next = null;
    if (this.lastChild) this.lastChild._next = child; else this._first = child;
    this._last = child;
    __jb.adoptInto(child, this.ownerDocument || (this.nodeType === 9 ? this : null));
    __jb.domVersion++; __jb.namesVersion++;
  }
  _insertBeforeRaw(child, ref) {
    if (!ref) { this._appendChildRaw(child); return; }
    if (child.parentNode) child.parentNode._removeChildRaw(child);
    child._parent = this; child._next = ref; child._prev = ref.previousSibling;
    if (ref.previousSibling) ref.previousSibling._next = child; else this._first = child;
    ref._prev = child;
    __jb.adoptInto(child, this.ownerDocument || (this.nodeType === 9 ? this : null));
    __jb.domVersion++; __jb.namesVersion++;
  }
  _removeChildRaw(child) {
    if (child.parentNode !== this) throw __jb.domError("NotFoundError", "The node to be removed is not a child of this node.");
    if (child.previousSibling) child.previousSibling._next = child.nextSibling; else this._first = child.nextSibling;
    if (child.nextSibling) child.nextSibling._prev = child.previousSibling; else this._last = child.previousSibling;
    child._parent = null; child._prev = null; child._next = null;
    __jb.domVersion++; __jb.namesVersion++;
  }
  appendChild(child) { if (arguments.length < 1) throw new TypeError("Node.appendChild: At least 1 argument required"); return __jb.preInsert(this, child, null); }
  insertBefore(child, ref) { if (arguments.length < 2) throw new TypeError("Node.insertBefore: At least 2 arguments required"); if (ref !== null && ref !== undefined) __jb.expectNode(ref, "Node.insertBefore: Argument 2"); return __jb.preInsert(this, child, ref === undefined ? null : ref); }
  removeChild(child) { if (arguments.length < 1) throw new TypeError("Node.removeChild: At least 1 argument required"); __jb.expectNode(child, "Node.removeChild: Argument 1"); if (child.parentNode !== this) throw __jb.domError("NotFoundError", "The node to be removed is not a child of this node."); __jb.remove(child); return child; }
  replaceChild(newChild, oldChild) { if (arguments.length < 2) throw new TypeError("Node.replaceChild: At least 2 arguments required"); return __jb.replaceChild(this, newChild, oldChild); }
  moveBefore(node, child) {
    if (arguments.length < 2) throw new TypeError("Node.moveBefore: At least 2 arguments required");
    __jb.expectNode(node, "Node.moveBefore: Argument 1");
    if (child !== null && child !== undefined) __jb.expectNode(child, "Node.moveBefore: Argument 2");
    child = child === undefined ? null : child;
    if (this.nodeType !== 1 && this.nodeType !== 11 && this.nodeType !== 9) throw __jb.domError("HierarchyRequestError", "Cannot move into this node type");
    if (node.nodeType !== 1 && node.nodeType !== 3 && node.nodeType !== 8 && node.nodeType !== 7 && node.nodeType !== 4) throw __jb.domError("HierarchyRequestError", "Only elements and character data can be moved");
    if (__jb.rootOf(this) !== __jb.rootOf(node)) throw __jb.domError("HierarchyRequestError", "moveBefore requires the same root");
    if (!node.parentNode) throw __jb.domError("HierarchyRequestError", "node has no parent");
    __jb.ensurePreInsertionValidity(this, node, child);
    var ref = child === node ? node.nextSibling : child;
    if (node.parentNode === this && ref === node.nextSibling) return;
    var oldParent = node.parentNode, oldPrev = node.previousSibling, oldNext = node.nextSibling;
    oldParent._removeChildRaw(node);
    __jb.queueMutationRecord("childList", oldParent, { removedNodes: [node], previousSibling: oldPrev, nextSibling: oldNext });
    var prev = ref ? ref.previousSibling : this.lastChild;
    if (ref) this._insertBeforeRaw(node, ref); else this._appendChildRaw(node);
    __jb.queueMutationRecord("childList", this, { addedNodes: [node], previousSibling: prev, nextSibling: ref });
    if (typeof __jb.imageTreeMutation === "function" && node.nodeType === 1 && node._ns === __jb.HTML_NS) { __jb.imageTreeMutation(node, oldParent, oldNext); __jb.imageTreeMutation(node, this); }
    __jb.markDirty(oldParent); __jb.markDirty(this);
    if (node.nodeType === 1) __jb.descendants(node, function (n) { return n.nodeType === 1 && n._ceDef; }).concat(node._ceDef ? [node] : []).forEach(function (n) { if (typeof n.connectedMoveCallback === "function") { try { n.connectedMoveCallback(); } catch (e) { __jb.reportException(e); } } else if (typeof n.disconnectedCallback === "function" || typeof n.connectedCallback === "function") { try { if (n.disconnectedCallback) n.disconnectedCallback(); if (n.connectedCallback) n.connectedCallback(); } catch (e2) { __jb.reportException(e2); } } });
  }
  cloneNode(deep) { return __jb.clone(this, null, !!deep); }
  get textContent() {
    switch (this.nodeType) {
      case 9: case 10: return null;
      case 3: case 8: case 7: case 4: return this.data;
      case 2: return this.value;
      default: { var out = ""; var texts = __jb.descendants(this, function (n) { return n.nodeType === 3 || n.nodeType === 4; }); for (var i = 0; i < texts.length; i++) out += texts[i].data; return out; }
    }
  }
  set textContent(v) {
    switch (this.nodeType) {
      case 9: case 10: return;
      case 3: case 8: case 7: case 4: __jb.replaceData(this, 0, this.data.length, v === null || v === undefined ? "" : String(v)); return;
      case 2: this.value = v === null || v === undefined ? "" : String(v); return;
      default: { var s = v === null || v === undefined ? "" : String(v); __jb.replaceAll(this, s === "" ? null : __jb.ownerDoc(this).createTextNode(s)); }
    }
  }
  get nodeValue() { switch (this.nodeType) { case 3: case 8: case 7: case 4: return this.data; case 2: return this.value; default: return null; } }
  set nodeValue(v) { switch (this.nodeType) { case 3: case 8: case 7: case 4: __jb.replaceData(this, 0, this.data.length, v === null || v === undefined ? "" : String(v)); break; case 2: this.value = v === null || v === undefined ? "" : String(v); break; } }
}
Node.ELEMENT_NODE = 1; Node.ATTRIBUTE_NODE = 2; Node.TEXT_NODE = 3; Node.CDATA_SECTION_NODE = 4; Node.ENTITY_REFERENCE_NODE = 5; Node.ENTITY_NODE = 6; Node.PROCESSING_INSTRUCTION_NODE = 7; Node.COMMENT_NODE = 8; Node.DOCUMENT_NODE = 9; Node.DOCUMENT_TYPE_NODE = 10; Node.DOCUMENT_FRAGMENT_NODE = 11; Node.NOTATION_NODE = 12;
Node.DOCUMENT_POSITION_DISCONNECTED = 1; Node.DOCUMENT_POSITION_PRECEDING = 2; Node.DOCUMENT_POSITION_FOLLOWING = 4; Node.DOCUMENT_POSITION_CONTAINS = 8; Node.DOCUMENT_POSITION_CONTAINED_BY = 16; Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC = 32;
Object.keys(Node).forEach(function (k) { if (/^[A-Z_]+$/.test(k)) Object.defineProperty(Node.prototype, k, { value: Node[k], enumerable: true }); });
__jb.isAncestor = function (a, b) { for (var n = b.parentNode; n; n = n.parentNode) if (n === a) return true; return false; };
__jb.objSeq = 0;
__jb.objectOrder = function (a, b) { if (a._seq === undefined) Object.defineProperty(a, "_seq", { value: ++__jb.objSeq }); if (b._seq === undefined) Object.defineProperty(b, "_seq", { value: ++__jb.objSeq }); return a._seq < b._seq; };
__jb.locateNamespace = function (el, prefix) {
  for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
    if (e._ns !== null && e._prefix === prefix) return e._ns;
    for (var i = 0; i < e._attrs.length; i++) {
      var a = e._attrs[i];
      if (a._ns === __jb.XMLNS_NS && ((a._prefix === "xmlns" && a._local === prefix) || (prefix === null && a._prefix === null && a._local === "xmlns"))) return a.value === "" ? null : a.value;
    }
  }
  return null;
};
__jb.locatePrefix = function (el, ns) {
  for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
    if (e._ns === ns && e._prefix !== null) return e._prefix;
    for (var i = 0; i < e._attrs.length; i++) { var a = e._attrs[i]; if (a._prefix === "xmlns" && a.value === ns) return a._local; }
  }
  return null;
};
__jb.nodesEqual = function (a, b) {
  if (a.nodeType !== b.nodeType) return false;
  switch (a.nodeType) {
    case 10: if (a.name !== b.name || a.publicId !== b.publicId || a.systemId !== b.systemId) return false; break;
    case 1:
      if (a._ns !== b._ns || a._prefix !== b._prefix || a._local !== b._local || a._attrs.length !== b._attrs.length) return false;
      for (var i = 0; i < a._attrs.length; i++) { var x = a._attrs[i], found = false; for (var j = 0; j < b._attrs.length; j++) { var y = b._attrs[j]; if (x._ns === y._ns && x._local === y._local && x.value === y.value) { found = true; break; } } if (!found) return false; }
      break;
    case 2: if (a._ns !== b._ns || a._local !== b._local || a.value !== b.value) return false; break;
    case 7: if (a.target !== b.target || a.data !== b.data) return false; break;
    case 3: case 8: case 4: if (a.data !== b.data) return false; break;
  }
  var ca = a.firstChild, cb = b.firstChild;
  while (ca && cb) { if (!__jb.nodesEqual(ca, cb)) return false; ca = ca.nextSibling; cb = cb.nextSibling; }
  return !ca && !cb;
};
__jb.clone = function (node, doc, deep) {
  doc = doc || __jb.ownerDoc(node);
  var copy;
  switch (node.nodeType) {
    case 1: {
      copy = __jb.createElementInternal(doc, node._local, node._ns, node._prefix, node.getAttribute("is"), false);
      for (var i = 0; i < node._attrs.length; i++) { var a = node._attrs[i]; copy._attrs.push(__jb.newAttr(doc, a._local, a.value, a._ns, a._prefix, copy)); if (a._ns === null && __jb.isHandlerAttr(copy, a._local)) copy._compileHandler(a._local.slice(2), a.value); }
      if (node._tag === "template" && node._ns === __jb.HTML_NS && node._content && deep) { var c2 = copy.content; for (var t = node._content.firstChild; t; t = t.nextSibling) c2._appendChildRaw(__jb.clone(t, c2.ownerDocument, true)); }
      if (node._tag === "input" && node._ns === __jb.HTML_NS) { copy._valueOverride = node._valueOverride; copy._checked = node._checked; }
      if (node._local === "script" && node._executed) copy._executed = true; // "already started" is cloned
      if (node._nonceSlot !== undefined) copy._nonceSlot = node._nonceSlot; // the nonce slot is cloned
      // A customized built-in (or a defined custom element) clone is upgraded before cloneNode returns.
      if (copy._ceDefPending && typeof __jb.upgradeElement === "function") { var pd = copy._ceDefPending; copy._ceDefPending = null; try { __jb.upgradeElement(copy, pd); } catch (e) { __jb.reportException(e); } }
      break;
    }
    case 9: copy = node._cloneEmpty(); break;
    case 10: copy = new DocumentType(node.name, node.publicId, node.systemId); copy._doc = doc; break;
    case 2: copy = __jb.newAttr(doc, node._local, node.value, node._ns, node._prefix, null); break;
    case 3: copy = doc.createTextNode(node.data); break;
    case 4: copy = new CDATASection(node.data); copy._doc = doc; break;
    case 8: copy = doc.createComment(node.data); break;
    case 7: copy = new ProcessingInstruction(node.target, node.data); copy._doc = doc; break;
    case 11: copy = node.nodeType === 11 && node._host ? doc.createDocumentFragment() : doc.createDocumentFragment(); break;
    default: throw __jb.domError("NotSupportedError", "cannot clone");
  }
  if (deep) for (var c = node.firstChild; c; c = c.nextSibling) copy._appendChildRaw(__jb.clone(c, copy.nodeType === 9 ? copy : doc, true));
  var sr = node.nodeType === 1 ? node._shadowRoot : null;
  if (sr && sr.clonable && !copy._shadowRoot) {
    var csr = null;
    try { csr = copy.attachShadow({ mode: sr.mode, clonable: true, serializable: !!sr.serializable, delegatesFocus: !!sr.delegatesFocus, slotAssignment: sr.slotAssignment || "named" }); } catch (e) { csr = null; }
    if (csr) { csr._declarative = !!sr._declarative; for (var sc = sr.firstChild; sc; sc = sc.nextSibling) csr._appendChildRaw(__jb.clone(sc, doc, true)); }
  }
  return copy;
};

// ParentNode / ChildNode mixins
var ParentNodeMixin = {
  get children() { var self_ = this; if (!Object.prototype.hasOwnProperty.call(this, "_childrenList")) Object.defineProperty(this, "_childrenList", { value: __jb.liveCollection(function () { var a = []; for (var c = self_.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) a.push(c); return a; }), enumerable: false, configurable: true }); return this._childrenList; },
  get firstElementChild() { for (var c = this.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) return c; return null; },
  get lastElementChild() { for (var c = this.lastChild; c; c = c.previousSibling) if (c.nodeType === 1) return c; return null; },
  get childElementCount() { var n = 0; for (var c = this.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) n++; return n; },
  append() { var node = __jb.convertNodes(this, arguments); __jb.preInsert(this, node, null); },
  prepend() { var node = __jb.convertNodes(this, arguments); __jb.preInsert(this, node, this.firstChild); },
  replaceChildren() { var node = __jb.convertNodes(this, arguments); __jb.ensurePreInsertionValidity(this, node, null); __jb.replaceAll(this, node); },
  querySelector(sel) { if (arguments.length < 1) throw new TypeError("querySelector: At least 1 argument required"); return __jb.querySelectorAll(this, sel, true)[0] || null; },
  querySelectorAll(sel) { if (arguments.length < 1) throw new TypeError("querySelectorAll: At least 1 argument required"); return __jb.staticNodeList(__jb.querySelectorAll(this, sel, false)); },
  getElementsByTagName(qname) {
    if (arguments.length < 1) throw new TypeError("getElementsByTagName: At least 1 argument required");
    var self_ = this; qname = String(qname);
    var isHTML = __jb.ownerDoc(this) && __jb.ownerDoc(this)._isHTML;
    var lower = qname.toLowerCase();
    return __jb.liveCollection(function () {
      return __jb.descendants(self_, function (n) {
        if (n.nodeType !== 1) return false;
        if (qname === "*") return true;
        if (isHTML) return n._ns === __jb.HTML_NS ? __jb.qualifiedName(n) === lower : __jb.qualifiedName(n) === qname;
        return __jb.qualifiedName(n) === qname;
      });
    });
  },
  getElementsByTagNameNS(ns, local) {
    if (arguments.length < 2) throw new TypeError("getElementsByTagNameNS: At least 2 arguments required");
    var self_ = this; if (ns === "" || ns === undefined) ns = null; local = String(local);
    return __jb.liveCollection(function () { return __jb.descendants(self_, function (n) { return n.nodeType === 1 && (ns === "*" || n._ns === ns) && (local === "*" || n._local === local); }); });
  },
  getElementsByClassName(names) {
    if (arguments.length < 1) throw new TypeError("getElementsByClassName: At least 1 argument required");
    var self_ = this; var cls = String(names).split(/[\t\n\f\r ]+/).filter(Boolean);
    var quirks = __jb.ownerDoc(this) && __jb.ownerDoc(this).compatMode === "BackCompat";
    return __jb.liveCollection(function () {
      if (!cls.length) return [];
      return __jb.descendants(self_, function (n) { if (n.nodeType !== 1) return false; var c = (n.getAttribute("class") || "").split(/[\t\n\f\r ]+/); if (quirks) { c = c.map(function (x) { return x.toLowerCase(); }); return cls.every(function (x) { return c.indexOf(x.toLowerCase()) >= 0; }); } return cls.every(function (x) { return c.indexOf(x) >= 0; }); });
    });
  },
};
__jb.qualifiedName = function (el) { return el._prefix === null ? el._local : el._prefix + ":" + el._local; };
var ChildNodeMixin = {
  remove() { if (this.parentNode) __jb.remove(this); },
  before() { var parent = this.parentNode; if (!parent) return; var args = __jb.arrayFrom(arguments); var viable = this.previousSibling; while (viable && args.indexOf(viable) >= 0) viable = viable.previousSibling; var node = __jb.convertNodes(this, args); __jb.preInsert(parent, node, viable ? viable.nextSibling : parent.firstChild); },
  after() { var parent = this.parentNode; if (!parent) return; var args = __jb.arrayFrom(arguments); var viable = this.nextSibling; while (viable && args.indexOf(viable) >= 0) viable = viable.nextSibling; var node = __jb.convertNodes(this, args); __jb.preInsert(parent, node, viable); },
  replaceWith() { var parent = this.parentNode; if (!parent) return; var args = __jb.arrayFrom(arguments); var viable = this.nextSibling; while (viable && args.indexOf(viable) >= 0) viable = viable.nextSibling; var node = __jb.convertNodes(this, args); if (this.parentNode === parent) __jb.replaceChild(parent, node, this); else __jb.preInsert(parent, node, viable); },
};
var NonDocumentTypeChildNodeMixin = {
  get nextElementSibling() { for (var s = this.nextSibling; s; s = s.nextSibling) if (s.nodeType === 1) return s; return null; },
  get previousElementSibling() { for (var s = this.previousSibling; s; s = s.previousSibling) if (s.nodeType === 1) return s; return null; },
};
function mixin(target, src) { Object.getOwnPropertyNames(src).forEach(function (k) { Object.defineProperty(target, k, Object.getOwnPropertyDescriptor(src, k)); }); }
__jb.setTag = function (C, name) { Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true }); };
__jb.setTag(Node, "Node");

// ---- CharacterData ----
__jb.replaceData = function (node, offset, count, data) {
  var length = node.data.length;
  if (offset > length) throw __jb.domError("IndexSizeError", "offset out of range");
  if (offset + count > length) count = length - offset;
  var old = node.data;
  __jb.queueMutationRecord("characterData", node, { oldValue: old });
  node._data = old.slice(0, offset) + data + old.slice(offset + count);
  if (__jb.rangesReplaceData) __jb.rangesReplaceData(node, offset, count, data.length);
  __jb.domVersion++;
  __jb.markDirty(node.parentNode);
};
class CharacterData extends Node {
  constructor(doc, data) { super(doc); if (new.target === CharacterData) throw new TypeError("Illegal constructor"); this._data = String(data); }
  get data() { return this._data; }
  set data(v) { __jb.replaceData(this, 0, this._data.length, v === null ? "" : String(v)); }
  get length() { return this._data.length; }
  substringData(o, c) { if (arguments.length < 2) throw new TypeError("substringData: 2 arguments required"); o = o >>> 0; c = c >>> 0; if (o > this._data.length) throw __jb.domError("IndexSizeError", "offset out of range"); return this._data.substr(o, c); }
  appendData(d) { if (arguments.length < 1) throw new TypeError("appendData: 1 argument required"); __jb.replaceData(this, this._data.length, 0, String(d)); }
  insertData(o, d) { if (arguments.length < 2) throw new TypeError("insertData: 2 arguments required"); __jb.replaceData(this, o >>> 0, 0, String(d)); }
  deleteData(o, c) { if (arguments.length < 2) throw new TypeError("deleteData: 2 arguments required"); __jb.replaceData(this, o >>> 0, c >>> 0, ""); }
  replaceData(o, c, d) { if (arguments.length < 3) throw new TypeError("replaceData: 3 arguments required"); __jb.replaceData(this, o >>> 0, c >>> 0, String(d)); }
}
mixin(CharacterData.prototype, ChildNodeMixin);
mixin(CharacterData.prototype, NonDocumentTypeChildNodeMixin);
__jb.setTag(CharacterData, "CharacterData");
class Text extends CharacterData {
  constructor(data) { super(typeof __jb.currentDocument !== "undefined" ? __jb.currentDocument : null, data === undefined ? "" : data); }
  get nodeType() { return 3; }
  get nodeName() { return "#text"; }
  splitText(offset) {
    if (arguments.length < 1) throw new TypeError("splitText: 1 argument required");
    offset = offset >>> 0;
    var length = this._data.length;
    if (offset > length) throw __jb.domError("IndexSizeError", "offset out of range");
    var count = length - offset;
    var newData = this._data.substr(offset, count);
    var node = __jb.ownerDoc(this).createTextNode(newData);
    var parent = this.parentNode;
    if (parent) { __jb.insert(parent, node, this.nextSibling, false); if (__jb.rangesSplit) __jb.rangesSplit(this, offset, node, parent); }
    __jb.replaceData(this, offset, count, "");
    return node;
  }
  get wholeText() { var s = this._data; for (var p = this.previousSibling; p && p.nodeType === 3; p = p.previousSibling) s = p.data + s; for (var n = this.nextSibling; n && n.nodeType === 3; n = n.nextSibling) s += n.data; return s; }
  get assignedSlot() { return null; }
}
__jb.setTag(Text, "Text");
class CDATASection extends Text { get nodeType() { return 4; } get nodeName() { return "#cdata-section"; } }
__jb.setTag(CDATASection, "CDATASection");
class Comment extends CharacterData { constructor(data) { super(typeof __jb.currentDocument !== "undefined" ? __jb.currentDocument : null, data === undefined ? "" : data); } get nodeType() { return 8; } get nodeName() { return "#comment"; } }
__jb.setTag(Comment, "Comment");
class ProcessingInstruction extends CharacterData { constructor(target, data) { super(typeof __jb.currentDocument !== "undefined" ? __jb.currentDocument : null, data === undefined ? "" : data); this.target = String(target); } get nodeType() { return 7; } get nodeName() { return this.target; } get sheet() { return null; } }
__jb.setTag(ProcessingInstruction, "ProcessingInstruction");
class DocumentFragment extends Node {
  constructor() { super(typeof __jb.currentDocument !== "undefined" ? __jb.currentDocument : null); }
  get nodeType() { return 11; }
  get nodeName() { return "#document-fragment"; }
  getElementById(id) { if (arguments.length < 1) throw new TypeError("getElementById: 1 argument required"); id = String(id); if (id === "") return null; var found = __jb.descendants(this, function (n) { return n.nodeType === 1 && n.getAttribute("id") === id; }); return found[0] || null; }
}
mixin(DocumentFragment.prototype, ParentNodeMixin);
__jb.setTag(DocumentFragment, "DocumentFragment");
class ShadowRoot extends DocumentFragment {
  constructor(host, init) { if (!__jb.shadowConstructing) throw new TypeError("Illegal constructor"); super(); this._host = host; this.mode = (init && init.mode) || "open"; this.delegatesFocus = !!(init && init.delegatesFocus); this.slotAssignment = (init && init.slotAssignment) || "named"; this.clonable = !!(init && init.clonable); this.serializable = !!(init && init.serializable); this.adoptedStyleSheets = []; this.onslotchange = null; }
  get host() { return this._host; }
  get innerHTML() { return __jb.serializeChildren(this); }
  set innerHTML(v) { var frag = __jb.parseFragment(v === null ? "" : String(v), this._host); __jb.replaceAll(this, frag); __jb.markDirty(this._host); }
  get activeElement() { return null; }
  get styleSheets() { return []; }
  get fullscreenElement() { return null; }
  get pointerLockElement() { return null; }
  get pictureInPictureElement() { return null; }
  getSelection() { return null; }
  elementFromPoint() { return null; }
  elementsFromPoint() { return []; }
  getAnimations() { return []; }
  setHTMLUnsafe(v, options) { var frag = __jb.parseFragment(v === null || v === undefined ? "" : String(v), this._host, { unsafe: true, runScripts: !!(options && options.runScripts) }); __jb.replaceAll(this, frag); __jb.markDirty(this._host); }
  getHTML(options) { return __jb.serializeChildren(this, __jb.getHTMLOpts(options)); }
}
__jb.setTag(ShadowRoot, "ShadowRoot");
__jb.getHTMLOpts = function (o) {
  if (o !== undefined && o !== null && typeof o !== "object") throw new TypeError("getHTML: Argument 1 can't be converted to a dictionary");
  var roots = o && o.shadowRoots !== undefined ? __jb.arrayFrom(o.shadowRoots) : [];
  return { serializable: !!(o && o.serializableShadowRoots), roots: roots };
};
class DocumentType extends Node {
  constructor(name, publicId, systemId) { super(typeof __jb.currentDocument !== "undefined" ? __jb.currentDocument : null); this.name = String(name); this.publicId = publicId === undefined ? "" : String(publicId); this.systemId = systemId === undefined ? "" : String(systemId); }
  get nodeType() { return 10; }
  get nodeName() { return this.name; }
}
mixin(DocumentType.prototype, ChildNodeMixin);
__jb.setTag(DocumentType, "DocumentType");

// ---- CSSStyleDeclaration ----
__jb.camelToKebab = function (s) { return s.replace(/^webkit/, "-webkit").replace(/[A-Z]/g, function (m) { return "-" + m.toLowerCase(); }); };
__jb.kebabToCamel = function (s) { return s.replace(/^-webkit-/, "webkit-").replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); }); };
class CSSStyleDeclaration {
  constructor(owner) { this._owner = owner; this._props = []; this._priority = {}; this.parentRule = null; }
  static _parse(text) { var out = []; String(text || "").split(";").forEach(function (d) { var i = d.indexOf(":"); if (i > 0) { var n = d.slice(0, i).trim().toLowerCase(), v = d.slice(i + 1).trim(); if (n && v) out.push([n, v]); } }); return out; }
  _load(text) { this._props = CSSStyleDeclaration._parse(text); }
  _sync() { if (this._owner) { var t = this.cssText; this._syncing = true; try { if (t) this._owner.setAttribute("style", t); else this._owner.removeAttribute("style"); } finally { this._syncing = false; } } }
  get cssText() { return this._props.map(function (p) { return p[0] + ": " + p[1] + ";"; }).join(" "); }
  set cssText(v) { this._load(v); this._sync(); }
  get length() { return this._props.length; }
  item(i) { return this._props[i] ? this._props[i][0] : ""; }
  getPropertyValue(n) { n = String(n).toLowerCase(); if (this._computedFor) { var cv = this._pseudoInfo ? __jb.pseudoComputedValue(this._computedFor, this._pseudoInfo, n) : __jb.computedValue(this._computedFor, n); if (typeof cv === "string") return cv; } var p = this._props.find(function (x) { return x[0] === n; }); var v = p ? p[1] : ""; if (this._computedFor && typeof __jb.dimensionHint === "function") { var hint = __jb.dimensionHint(this._computedFor, n, v || (/^margin-/.test(n) ? "0px" : "auto")); if (hint !== null) return hint; if (!v && /^(width|height)$/.test(n)) return "auto"; if (!v && /^margin-/.test(n)) return "0px"; } return v; }
  getPropertyPriority(n) { return this._priority[n] || ""; }
  setProperty(n, v, prio) { n = String(n).toLowerCase(); if (v === null || v === undefined || v === "") { this.removeProperty(n); return; } v = String(v).replace(/\s*!important\s*$/i, function () { prio = "important"; return ""; }); var p = this._props.find(function (x) { return x[0] === n; }); if (p) p[1] = v; else this._props.push([n, v]); if (prio) this._priority[n] = prio; this._sync(); }
  removeProperty(n) { n = String(n).toLowerCase(); var old = this.getPropertyValue(n); this._props = this._props.filter(function (x) { return x[0] !== n; }); delete this._priority[n]; this._sync(); return old; }
  [Symbol.iterator]() { return this._props.map(function (p) { return p[0]; })[Symbol.iterator](); }
}
__jb.styleProxy = function (decl) {
  return new Proxy(decl, {
    get: function (t, k) {
      if (typeof k === "symbol" || k in t) { var v = t[k]; return typeof v === "function" ? v.bind(t) : v; }
      if (/^\d+$/.test(k)) return t.item(Number(k));
      return t.getPropertyValue(k.indexOf("-") >= 0 ? k : __jb.camelToKebab(k));
    },
    set: function (t, k, v) {
      if (typeof k === "symbol" || Object.prototype.hasOwnProperty.call(t, k)) { t[k] = v; return true; }
      if (k === "cssText") { t.cssText = v; return true; }
      if (k in CSSStyleDeclaration.prototype) return true;
      t.setProperty(k.indexOf("-") >= 0 ? k : __jb.camelToKebab(k), v);
      return true;
    },
    has: function (t, k) { return true; },
  });
};

class DOMTokenList {
  constructor(el, attr, supported) { this._el = el; this._attr = attr; this._supported = supported || null; }
  _list() { var v = this._el.getAttribute(this._attr); if (v === null) return []; var seen = {}, out = []; v.split(/[\t\n\f\r ]+/).forEach(function (x) { if (x && !seen[x]) { seen[x] = 1; out.push(x); } }); return out; }
  _save(l) { this._el.setAttribute(this._attr, l.join(" ")); }
  _check(tokens) { for (var i = 0; i < tokens.length; i++) { if (tokens[i] === "") throw __jb.domError("SyntaxError", "The token can not be empty."); if (/[\t\n\f\r ]/.test(tokens[i])) throw __jb.domError("InvalidCharacterError", "The token can not contain whitespace."); } }
  get length() { return this._list().length; }
  get value() { return this._el.getAttribute(this._attr) || ""; } set value(v) { this._el.setAttribute(this._attr, String(v)); }
  item(i) { i = i >>> 0; var l = this._list(); return i < l.length ? l[i] : null; }
  contains(t) { return this._list().indexOf(String(t)) >= 0; }
  add() { var tokens = __jb.A.map.call(arguments, String); this._check(tokens); var l = this._list(); tokens.forEach(function (t) { if (l.indexOf(t) < 0) l.push(t); }); this._save(l); }
  remove() { var tokens = __jb.A.map.call(arguments, String); this._check(tokens); var l = this._list().filter(function (x) { return tokens.indexOf(x) < 0; }); if (this._el.getAttribute(this._attr) === null) return; this._save(l); }
  toggle(t, force) { if (arguments.length < 1) throw new TypeError("toggle: 1 argument required"); t = String(t); this._check([t]); var has = this.contains(t); if (has) { if (force === undefined || force === false) { this.remove(t); return false; } return true; } if (force === undefined || force === true) { this.add(t); return true; } return false; }
  replace(a, b) { if (arguments.length < 2) throw new TypeError("replace: 2 arguments required"); a = String(a); b = String(b); this._check([a, b]); var l = this._list(), i = l.indexOf(a); if (i < 0) return false; l[i] = b; var seen = {}; l = l.filter(function (x) { if (seen[x]) return false; seen[x] = 1; return true; }); this._save(l); return true; }
  supports(t) { if (!this._supported) throw new TypeError("DOMTokenList.supports: this attribute has no supported tokens"); return this._supported.indexOf(String(t).toLowerCase()) >= 0; }
  forEach(cb, thisArg) { this._list().forEach(function (t, i) { cb.call(thisArg, t, i, this); }, this); }
  entries() { return this._list().entries(); } keys() { return this._list().keys(); } values() { return this._list().values(); }
  [Symbol.iterator]() { return this._list()[Symbol.iterator](); }
  toString() { return this.value; }
}
__jb.setTag(DOMTokenList, "DOMTokenList");
__jb.tokenListProxy = function (list) {
  return new Proxy(list, {
    get: function (t, k) { if (typeof k === "string" && /^\d+$/.test(k)) return t.item(Number(k)) === null ? undefined : t.item(Number(k)); var v = t[k]; return typeof v === "function" ? v.bind(t) : v; },
    has: function (t, k) { if (typeof k === "string" && /^\d+$/.test(k)) return Number(k) < t.length; return k in t; },
    ownKeys: function (t) { var keys = []; var n = t.length; for (var i = 0; i < n; i++) keys.push(String(i)); return keys.concat(Reflect.ownKeys(t)); },
    getOwnPropertyDescriptor: function (t, k) { if (typeof k === "string" && /^\d+$/.test(k)) { var v = t.item(Number(k)); return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: false }; } return Reflect.getOwnPropertyDescriptor(t, k); },
  });
};

// ---- Attr / NamedNodeMap ----
class Attr extends Node {
  constructor() { super(null); if (!__jb.attrConstructing) throw new TypeError("Illegal constructor"); }
  get nodeType() { return 2; }
  get nodeName() { return this.name; }
  get name() { return this._prefix === null ? this._local : this._prefix + ":" + this._local; }
  get localName() { return this._local; }
  get namespaceURI() { return this._ns; }
  get prefix() { return this._prefix; }
  get specified() { return true; }
  get value() { return this._value; }
  set value(v) { v = String(v); if (this.ownerElement) __jb.changeAttribute(this.ownerElement, this, v); else this._value = v; }
  get ownerElement() { return this._owner; }
  get childNodes() { return __jb.staticNodeList([]); }
}
__jb.setTag(Attr, "Attr");
__jb.newAttr = function (doc, local, value, ns, prefix, owner) {
  __jb.attrConstructing = true;
  var a;
  try { a = new Attr(); } finally { __jb.attrConstructing = false; }
  a._doc = doc; a._local = local; a._value = String(value); a._ns = ns === undefined || ns === "" ? null : ns; a._prefix = prefix === undefined ? null : prefix; a._owner = owner || null;
  return a;
};
function NamedNodeMap() { throw new TypeError("Illegal constructor"); }
NamedNodeMap.prototype.item = function (i) { i = i >>> 0; return this._items[i] || null; };
NamedNodeMap.prototype.getNamedItem = function (n) { if (arguments.length < 1) throw new TypeError("getNamedItem: 1 argument required"); return this._el._getAttr(String(n)); };
NamedNodeMap.prototype.getNamedItemNS = function (ns, n) { if (arguments.length < 2) throw new TypeError("getNamedItemNS: 2 arguments required"); return this._el._getAttrNS(ns, String(n)); };
NamedNodeMap.prototype.setNamedItem = function (a) { if (!(a instanceof Attr)) throw new TypeError("setNamedItem: Argument 1 is not an Attr"); return __jb.setAttributeNode(this._el, a); };
NamedNodeMap.prototype.setNamedItemNS = function (a) { if (!(a instanceof Attr)) throw new TypeError("setNamedItemNS: Argument 1 is not an Attr"); return __jb.setAttributeNode(this._el, a); };
NamedNodeMap.prototype.removeNamedItem = function (n) { if (arguments.length < 1) throw new TypeError("removeNamedItem: 1 argument required"); var a = this._el._getAttr(String(n)); if (!a) throw __jb.domError("NotFoundError", "attribute not found"); __jb.removeAttr(this._el, a); return a; };
NamedNodeMap.prototype.removeNamedItemNS = function (ns, n) { if (arguments.length < 2) throw new TypeError("removeNamedItemNS: 2 arguments required"); var a = this._el._getAttrNS(ns, String(n)); if (!a) throw __jb.domError("NotFoundError", "attribute not found"); __jb.removeAttr(this._el, a); return a; };
NamedNodeMap.prototype[Symbol.iterator] = function () { return this._items.slice()[Symbol.iterator](); };
Object.defineProperty(NamedNodeMap.prototype, "length", { get: function () { return this._items.length; }, configurable: true });
Object.defineProperty(NamedNodeMap.prototype, Symbol.toStringTag, { value: "NamedNodeMap", configurable: true });
__jb.namedNodeMap = function (el) {
  var target = Object.create(NamedNodeMap.prototype);
  Object.defineProperty(target, "_el", { value: el });
  Object.defineProperty(target, "_items", { get: function () { return el._attrs; } });
  function isIndex(k) { return typeof k === "string" && /^(0|[1-9][0-9]*)$/.test(k); }
  return new Proxy(target, {
    get: function (t, k) { if (isIndex(k)) return el._attrs[Number(k)]; if (typeof k === "string" && !(k in t)) { var a = el._getAttr(k); if (a) return a; } return Reflect.get(t, k, t); },
    has: function (t, k) { if (isIndex(k)) return Number(k) < el._attrs.length; if (k in t) return true; return typeof k === "string" && !!el._getAttr(k); },
    ownKeys: function (t) { var keys = []; for (var i = 0; i < el._attrs.length; i++) keys.push(String(i)); el._attrs.forEach(function (a) { var n = __jb.attrQualifiedName(el, a); if (keys.indexOf(n) < 0) keys.push(n); }); return keys.concat(Reflect.ownKeys(t).filter(function (k) { return keys.indexOf(k) < 0; })); },
    getOwnPropertyDescriptor: function (t, k) { if (isIndex(k)) { var v = el._attrs[Number(k)]; return v ? { value: v, enumerable: true, configurable: true, writable: false } : undefined; } if (typeof k === "string" && !(k in t)) { var a = el._getAttr(k); if (a) return { value: a, enumerable: false, configurable: true, writable: false }; } return Reflect.getOwnPropertyDescriptor(t, k); },
    set: function () { return false; },
  });
};
__jb.attrQualifiedName = function (el, a) { return a._prefix === null ? a._local : a._prefix + ":" + a._local; };
__jb.changeAttribute = function (el, attr, value) {
  var old = attr._value;
  __jb.queueMutationRecord("attributes", el, { attributeName: attr._local, attributeNamespace: attr._ns, oldValue: old });
  attr._value = value;
  __jb.attributeChanged(el, attr, old, value);
};
__jb.appendAttr = function (el, attr) {
  __jb.queueMutationRecord("attributes", el, { attributeName: attr._local, attributeNamespace: attr._ns, oldValue: null });
  el._attrs.push(attr); attr._owner = el; attr._doc = el.ownerDocument;
  __jb.attributeChanged(el, attr, null, attr._value);
};
__jb.removeAttr = function (el, attr) {
  __jb.queueMutationRecord("attributes", el, { attributeName: attr._local, attributeNamespace: attr._ns, oldValue: attr._value });
  var i = el._attrs.indexOf(attr); if (i >= 0) el._attrs.splice(i, 1);
  attr._owner = null;
  __jb.attributeChanged(el, attr, attr._value, null);
};
__jb.replaceAttr = function (el, oldAttr, newAttr) {
  __jb.queueMutationRecord("attributes", el, { attributeName: oldAttr._local, attributeNamespace: oldAttr._ns, oldValue: oldAttr._value });
  var i = el._attrs.indexOf(oldAttr); el._attrs[i] = newAttr; oldAttr._owner = null; newAttr._owner = el; newAttr._doc = el.ownerDocument;
  __jb.attributeChanged(el, newAttr, oldAttr._value, newAttr._value);
};
__jb.setAttributeNode = function (el, attr) {
  if (attr._owner && attr._owner !== el) throw __jb.domError("InUseAttributeError", "The attribute is in use.");
  var old = el._getAttrNS(attr._ns, attr._local);
  if (old === attr) return attr;
  if (old) __jb.replaceAttr(el, old, attr); else __jb.appendAttr(el, attr);
  return old;
};
// Side effects of an attribute change: dirty tracking, style/handler sync,
// custom element callbacks.
__jb.attributeChanged = function (el, attr, oldValue, newValue) {
  __jb.domVersion++;
  // Real pages: an element outside the document (a clone being sized before it replaces the live
  // one) cannot change the current layout. Count those bumps so layoutQuery's key ignores them:
  // Box Office Mojo read offsetWidth of each table cell and styled a detached clone, and every
  // read rebuilt the layout (1,438 builds, 98 s).
  var offDoc = !__jb.wptMode && el && el.nodeType === 1 && !el.isConnected;
  if (offDoc) __jb.offDocDom = (__jb.offDocDom || 0) + 1;
  // style-affecting attribute changes: geometry queries right after them must not reuse a layout
  if (!offDoc && attr && (attr._local === "style" || attr._local === "class" || attr._local === "hidden")) { __jb.geomVersion = (__jb.geomVersion || 0) + 1; (__jb.styleDirtyEls || (__jb.styleDirtyEls = new Set())).add(el); }
  if (attr && (attr._local === "id" || attr._local === "name" || attr._local === "form" || (attr._local === "href" && el._tag === "base"))) __jb.namesVersion++;
  var lv0 = __jb.layoutVersion;
  __jb.markDirty(el);
  if (offDoc) __jb.offDocLayout = (__jb.offDocLayout || 0) + (__jb.layoutVersion - lv0);
  var n = attr._local;
  if (attr._ns === null) {
    if (n === "style" && el._style && !el._style._syncing) el._style._load(newValue === null ? "" : newValue);
    if (__jb.isHandlerAttr(el, n)) el._compileHandler(n.slice(2), newValue);
    if (el._ariaExplicit) __jb.ariaAttrChanged(el, n);
    if (n === "commandfor" && el._commandForExplicit !== undefined) el._commandForExplicit = undefined;
    if ((n === "slot" || n === "name") && __jb.slotsAttrChanged) __jb.slotsAttrChanged(el, n, oldValue, newValue);
  }
  if (el._ceDef && el._ceDef.observedAttributes.indexOf(n) >= 0 && typeof el.attributeChangedCallback === "function") { try { el.attributeChangedCallback(n, oldValue, newValue, attr._ns); } catch (e) { __jb.reportException(e); } }
  if (attr._ns === null && el._ns === __jb.HTML_NS && typeof __jb.imageRelevantMutation === "function" && ((el._tag === "img" && /^(src|srcset|sizes|crossorigin|referrerpolicy|loading|width)$/.test(n)) || (el._tag === "source" && /^(srcset|sizes|media|type|width|height)$/.test(n)))) {
    // crossorigin/referrerpolicy only matter when their enumerated state changes.
    var coState = function (v) { return v === null ? null : String(v).toLowerCase() === "use-credentials" ? "use-credentials" : "anonymous"; };
    var rpState = function (v) { v = v === null ? "" : String(v).toLowerCase(); return /^(no-referrer|no-referrer-when-downgrade|same-origin|origin|strict-origin|origin-when-cross-origin|strict-origin-when-cross-origin|unsafe-url)$/.test(v) ? v : ""; };
    var relevant = n === "crossorigin" ? coState(oldValue) !== coState(newValue) : n === "referrerpolicy" ? rpState(oldValue) !== rpState(newValue) : true;
    if (relevant) __jb.imageRelevantMutation(el);
  }
  if (attr._ns === null && (n === "src" || n === "srcdoc") && (el._tag === "iframe" || el._tag === "frame") && el._ns === __jb.HTML_NS && el.isConnected && el._contentWindow && typeof __jb.loadFrame === "function") __jb.loadFrame(el);
  if (attr._ns === null && (n === "id" || (n === "name" && el._ns === __jb.HTML_NS)) && newValue && el.isConnected && el.ownerDocument === __jb.currentDocument) __jb.registerNamedAccess(el);
  // Popover attribute change steps: changing the popover state of a showing popover hides it.
  if (attr._ns === null && n === "popover" && el._popoverState === "showing" && typeof __jb.hidePopover === "function") {
    var state = function (v) { if (v === null) return null; v = v.toLowerCase(); return v === "" || v === "auto" ? "auto" : v === "hint" ? "hint" : "manual"; };
    if (state(oldValue) !== state(newValue)) __jb.hidePopover(el, false, true, false, true, true);
  }
  // The open attribute of a dialog tracks the close-request list; removing it also ends modality.
  if (attr._ns === null && n === "open" && el._tag === "dialog" && el._ns === __jb.HTML_NS && __jb.topLayer) {
    var ti = __jb.topLayer.indexOf(el);
    if (newValue === null) { el._modal = false; if (ti >= 0) __jb.topLayer.splice(ti, 1); }
    else if (ti < 0 && el.isConnected) __jb.topLayer.push(el);
    if (typeof __jb.dialogOpenAttributeChanged === "function") __jb.dialogOpenAttributeChanged(el, newValue !== null);
  }
  if (attr._ns === null && typeof __jb.faceAttributeChanged === "function" && (n === "form" || n === "disabled" || n === "id")) __jb.faceAttributeChanged(el, n);
  // Focus fixup: a focused element that stops being focusable loses focus at the next rendering update.
  if (attr._ns === null && /^(disabled|hidden|inert|style|class|tabindex|contenteditable)$/.test(n) && typeof __jb.scheduleFocusFixup === "function") { var fdoc = el.ownerDocument, fa = fdoc && fdoc._jbActive; if (fa && (fa === el || el.contains(fa))) __jb.scheduleFocusFixup(fdoc); }
  // Exclusive accordions: opening a named details closes the other open ones sharing its name in the same tree.
  if (attr._ns === null && n === "open" && newValue !== null && el._tag === "details" && el._ns === __jb.HTML_NS && el.getAttribute("name") && el.parentNode) {
    var groupName = el.getAttribute("name"), root = el.getRootNode();
    __jb.descendants(root, function (o) { return o !== el && o.nodeType === 1 && o._tag === "details" && o._ns === __jb.HTML_NS && o.getAttribute("name") === groupName && o.hasAttribute("open"); }).forEach(function (o) { o.removeAttribute("open"); });
  }
  // Toggling a details element queues a toggle event task.
  if (attr._ns === null && n === "open" && el._tag === "details" && el._ns === __jb.HTML_NS && (oldValue === null) !== (newValue === null)) __jb.queueToggle(el, oldValue === null ? "closed" : "open", newValue === null ? "closed" : "open");
  // A src set on a connected script that has not run yet prepares it.
  if (attr._ns === null && n === "src" && newValue !== null && el._tag === "script" && el._ns === __jb.HTML_NS && el.isConnected && el.ownerDocument === __jb.currentDocument && !el._executed && __jb.pendingScripts.indexOf(el) < 0) { __jb.pendingScripts.push(el); __jb.wakeForPendingScripts(); }
};

// Event handler content attributes: element handlers everywhere, plus the
// window-reflecting ones (onstorage, onmessage, onhashchange...) on <body>/<frameset>.
__jb.isHandlerAttr = function (el, n) {
  if ((el._ns !== __jb.HTML_NS && el._ns !== __jb.SVG_NS && el._ns !== __jb.MATHML_NS) || n.indexOf("on") !== 0) return false;
  var t = n.slice(2);
  if (__jb.EVENT_HANDLER_NAMES.indexOf(t) >= 0) return true;
  return (el._tag === "body" || el._tag === "frameset") && __jb.WINDOW_HANDLER_NAMES.indexOf(t) >= 0;
};
__jb.WINDOW_HANDLER_NAMES = ["afterprint", "pagereveal", "pageswap", "beforeprint", "beforeunload", "hashchange", "languagechange", "message", "messageerror", "offline", "online", "pagehide", "pageshow", "popstate", "rejectionhandled", "storage", "unhandledrejection", "unload", "blur", "error", "focus", "load", "resize", "scroll"];
// Event handler attributes (onclick, onload, ...) become real handlers.
__jb.EVENT_HANDLER_NAMES = ["abort", "beforematch", "contextlost", "contextrestored", "webkitanimationend", "webkitanimationiteration", "webkitanimationstart", "webkittransitionend", "animationend", "animationiteration", "animationstart", "animationcancel", "transitionrun", "transitionstart", "transitionend", "transitioncancel", "auxclick", "beforeinput", "beforetoggle", "blur", "cancel", "canplay", "canplaythrough", "change", "click", "close", "command", "contextmenu", "copy", "cuechange", "cut", "dblclick", "drag", "dragend", "dragenter", "dragleave", "dragover", "dragstart", "drop", "durationchange", "emptied", "ended", "error", "focus", "focusin", "focusout", "formdata", "input", "invalid", "keydown", "keypress", "keyup", "load", "loadeddata", "loadedmetadata", "loadstart", "mousedown", "mouseenter", "mouseleave", "mousemove", "mouseout", "mouseover", "mouseup", "paste", "pause", "play", "playing", "pointercancel", "pointerdown", "pointerenter", "pointerleave", "pointermove", "pointerout", "pointerover", "pointerup", "progress", "ratechange", "reset", "resize", "scroll", "scrollend", "securitypolicyviolation", "seeked", "seeking", "select", "selectionchange", "selectstart", "slotchange", "stalled", "submit", "suspend", "timeupdate", "toggle", "touchcancel", "touchend", "touchmove", "touchstart", "transitionend", "volumechange", "waiting", "wheel"];

class Element extends Node {
  constructor(doc, tag) {
    var ec = __jb.elementConstructing;
    if (ec) { __jb.elementConstructing = null; doc = ec.doc; tag = ec.tag; }
    else if (new.target === Element) throw new TypeError("Illegal constructor");
    super(doc);
    this._local = tag === undefined ? "" : String(tag);
    this._tag = this._local.toLowerCase();
    this._ns = ec ? ec.ns : __jb.HTML_NS;
    this._prefix = ec ? ec.prefix : null;
    this._attrs = [];
    this._handlers = {};
    this._style = null;
    this._shadowRoot = null;
    this._dataset = null;
  }
  get nodeType() { return 1; }
  get nodeName() { return this.tagName; }
  get tagName() { var q = __jb.qualifiedName(this); return this._ns === __jb.HTML_NS && this.ownerDocument && this.ownerDocument._isHTML ? q.toUpperCase() : q; }
  get localName() { return this._local; }
  get namespaceURI() { return this._ns; }
  get prefix() { return this._prefix; }
  _lowerName(n) { n = String(n); return this._ns === __jb.HTML_NS && this.ownerDocument && this.ownerDocument._isHTML ? n.toLowerCase() : n; }
  _getAttr(qname) { qname = this._lowerName(qname); for (var i = 0; i < this._attrs.length; i++) if (__jb.attrQualifiedName(this, this._attrs[i]) === qname) return this._attrs[i]; return null; }
  _getAttrNS(ns, local) { if (ns === "" || ns === undefined) ns = null; for (var i = 0; i < this._attrs.length; i++) if (this._attrs[i]._ns === ns && this._attrs[i]._local === local) return this._attrs[i]; return null; }
  // Raw attribute set used by the parser/bridge (no validation, null namespace).
  _setAttrRaw(n, v, ns, prefix) {
    for (var i = 0; i < this._attrs.length; i++) { var a = this._attrs[i]; if ((ns === undefined || ns === null) ? __jb.attrQualifiedName(this, a) === n : (a._ns === ns && a._local === n)) { a._value = String(v); __jb.domVersion++; if (a._local === "style" || a._local === "class") { __jb.geomVersion = (__jb.geomVersion || 0) + 1; (__jb.styleDirtyEls || (__jb.styleDirtyEls = new Set())).add(this); } if (a._local === "id" || a._local === "name" || a._local === "form" || (a._local === "href" && this._tag === "base")) __jb.namesVersion++; return; } }
    var local = n, pfx = prefix === undefined ? null : prefix;
    if (pfx === null && ns && n.indexOf(":") > 0) { pfx = n.slice(0, n.indexOf(":")); local = n.slice(n.indexOf(":") + 1); }
    this._attrs.push(__jb.newAttr(this.ownerDocument, local, v, ns, pfx, this));
    __jb.domVersion++; __jb.namesVersion++;
    // Markup event handler attributes (onclick="...") become handlers.
    if ((ns === undefined || ns === null) && __jb.isHandlerAttr(this, n)) this._compileHandler(n.slice(2), String(v));
  }
  _removeAttrRaw(n) { var a = this._getAttr(n); if (a) { var i = this._attrs.indexOf(a); this._attrs.splice(i, 1); a._owner = null; __jb.domVersion++; __jb.namesVersion++; } }
  getAttribute(n) { if (arguments.length < 1) throw new TypeError("getAttribute: 1 argument required"); var a = this._getAttr(n); return a ? a._value : null; }
  getAttributeNS(ns, n) { if (arguments.length < 2) throw new TypeError("getAttributeNS: 2 arguments required"); var a = this._getAttrNS(ns, String(n)); return a ? a._value : null; }
  setAttribute(n, v) {
    if (arguments.length < 2) throw new TypeError("setAttribute: 2 arguments required");
    n = String(n); v = String(v);
    if (!__jb.validAttributeLocalName(n)) throw __jb.domError("InvalidCharacterError", "'" + n + "' is not a valid attribute name");
    n = this._lowerName(n);
    var a = this._getAttr(n);
    if (a) __jb.changeAttribute(this, a, v);
    else __jb.appendAttr(this, __jb.newAttr(this.ownerDocument, n, v, null, null, null));
  }
  setAttributeNS(ns, qname, v) {
    if (arguments.length < 3) throw new TypeError("setAttributeNS: 3 arguments required");
    var x = __jb.validateAndExtract(ns === null ? null : ns === undefined ? null : String(ns), qname, true);
    v = String(v);
    var a = this._getAttrNS(x.ns, x.local);
    if (a) __jb.changeAttribute(this, a, v);
    else __jb.appendAttr(this, __jb.newAttr(this.ownerDocument, x.local, v, x.ns, x.prefix, null));
  }
  removeAttribute(n) { if (arguments.length < 1) throw new TypeError("removeAttribute: 1 argument required"); var a = this._getAttr(n); if (a) __jb.removeAttr(this, a); }
  removeAttributeNS(ns, n) { if (arguments.length < 2) throw new TypeError("removeAttributeNS: 2 arguments required"); var a = this._getAttrNS(ns, String(n)); if (a) __jb.removeAttr(this, a); }
  hasAttribute(n) { if (arguments.length < 1) throw new TypeError("hasAttribute: 1 argument required"); return this._getAttr(n) !== null; }
  hasAttributeNS(ns, n) { if (arguments.length < 2) throw new TypeError("hasAttributeNS: 2 arguments required"); return this._getAttrNS(ns, String(n)) !== null; }
  hasAttributes() { return this._attrs.length > 0; }
  toggleAttribute(n, force) {
    if (arguments.length < 1) throw new TypeError("toggleAttribute: 1 argument required");
    n = String(n);
    if (!__jb.validAttributeLocalName(n)) throw __jb.domError("InvalidCharacterError", "'" + n + "' is not a valid attribute name");
    n = this._lowerName(n);
    var a = this._getAttr(n);
    if (!a) { if (force === undefined || force === true) { __jb.appendAttr(this, __jb.newAttr(this.ownerDocument, n, "", null, null, null)); return true; } return false; }
    if (force === undefined || force === false) { __jb.removeAttr(this, a); return false; }
    return true;
  }
  getAttributeNames() { var self_ = this; return this._attrs.map(function (a) { return __jb.attrQualifiedName(self_, a); }); }
  getAttributeNode(n) { if (arguments.length < 1) throw new TypeError("getAttributeNode: 1 argument required"); return this._getAttr(n); }
  getAttributeNodeNS(ns, n) { if (arguments.length < 2) throw new TypeError("getAttributeNodeNS: 2 arguments required"); return this._getAttrNS(ns, String(n)); }
  setAttributeNode(a) { if (!(a instanceof Attr)) throw new TypeError("setAttributeNode: Argument 1 is not an Attr"); return __jb.setAttributeNode(this, a); }
  setAttributeNodeNS(a) { if (!(a instanceof Attr)) throw new TypeError("setAttributeNodeNS: Argument 1 is not an Attr"); return __jb.setAttributeNode(this, a); }
  removeAttributeNode(a) { if (!(a instanceof Attr)) throw new TypeError("removeAttributeNode: Argument 1 is not an Attr"); if (this._attrs.indexOf(a) < 0) throw __jb.domError("NotFoundError", "attribute not found"); __jb.removeAttr(this, a); return a; }
  get attributes() { if (!Object.prototype.hasOwnProperty.call(this, "_attrMap")) Object.defineProperty(this, "_attrMap", { value: __jb.namedNodeMap(this), enumerable: false }); return this._attrMap; }
  get id() { return this.getAttribute("id") || ""; } set id(v) { this.setAttribute("id", v); }
  get className() { return this.getAttribute("class") || ""; } set className(v) { this.setAttribute("class", v); }
  get classList() { if (!Object.prototype.hasOwnProperty.call(this, "_classList")) Object.defineProperty(this, "_classList", { value: __jb.tokenListProxy(new DOMTokenList(this, "class")), enumerable: false }); return this._classList; }
  get part() { if (!Object.prototype.hasOwnProperty.call(this, "_part")) Object.defineProperty(this, "_part", { value: __jb.tokenListProxy(new DOMTokenList(this, "part")), enumerable: false }); return this._part; }
  get slot() { return this.getAttribute("slot") || ""; } set slot(v) { this.setAttribute("slot", v); }
  get style() { if (!Object.prototype.hasOwnProperty.call(this, "_style") || !this._style) { var d = new CSSStyleDeclaration(this); d._load(this.getAttribute("style")); this._style = d; this._styleProxy = __jb.styleProxy(d); } return this._styleProxy; }
  set style(v) { this.setAttribute("style", String(v)); }
  get dataset() {
    if (Object.prototype.hasOwnProperty.call(this, "_dataset") && this._dataset) return this._dataset;
    var el = this;
    // DOMStringMap ([LegacyOverrideBuiltIns]): data-* attributes first, then the prototype chain
    var target = Object.create(typeof DOMStringMap === "function" ? DOMStringMap.prototype : Object.prototype);
    this._dataset = new Proxy(target, {
      get: function (t, k, r) { if (typeof k !== "symbol") { var v = el.getAttribute("data-" + __jb.camelToKebab(k)); if (v !== null) return v; } return Reflect.get(t, k, r); },
      set: function (t, k, v) { if (typeof k === "symbol") return Reflect.set(t, k, v); el.setAttribute("data-" + __jb.camelToKebab(k), v); return true; },
      has: function (t, k) { return (typeof k !== "symbol" && el.hasAttribute("data-" + __jb.camelToKebab(k))) || k in t; },
      deleteProperty: function (t, k) { el.removeAttribute("data-" + __jb.camelToKebab(k)); return true; },
      ownKeys: function () { return el._attrs.filter(function (a) { return a._local.indexOf("data-") === 0; }).map(function (a) { return __jb.kebabToCamel(a._local.slice(5)); }); },
      getOwnPropertyDescriptor: function (t, k) { var v = el.getAttribute("data-" + __jb.camelToKebab(k)); return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true }; },
    });
    return this._dataset;
  }
  get innerHTML() { if (this.ownerDocument && !this.ownerDocument._isHTML) return __jb.xmlSerialize(this, true, true); return this._tag === "template" && this._ns === __jb.HTML_NS && this._content ? __jb.serializeChildren(this._content) : __jb.serializeChildren(this); }
  set innerHTML(v) {
    var target = this._tag === "template" && this._ns === __jb.HTML_NS ? this.content : this;
    var frag = __jb.parseFragment(v === null ? "" : String(v), this);
    __jb.replaceAll(target, frag);
    __jb.markDirty(this);
  }
  get outerHTML() { if (this.ownerDocument && !this.ownerDocument._isHTML) return __jb.xmlSerialize(this, true, false); return __jb.serializeNode(this); }
  set outerHTML(v) {
    var parent = this.parentNode;
    if (!parent) return;
    if (parent.nodeType === 9) throw __jb.domError("NoModificationAllowedError", "Cannot set outerHTML on a document child");
    if (parent.nodeType === 11) parent = __jb.ownerDoc(this).createElement("body");
    var frag = __jb.parseFragment(v === null ? "" : String(v), parent);
    __jb.replaceChild(this.parentNode, frag, this);
  }
  setHTMLUnsafe(v, options) { var frag = __jb.parseFragment(String(v), this, { unsafe: true, runScripts: !!(options && options.runScripts) }); __jb.replaceAll(this._tag === "template" ? this.content : this, frag); __jb.markDirty(this); }
  getHTML(options) { var opts = __jb.getHTMLOpts(options); return __jb.serializeShadowRoot(this, opts, false) + __jb.serializeChildren(this, opts); }
  insertAdjacentHTML(pos, html) {
    if (arguments.length < 2) throw new TypeError("insertAdjacentHTML: 2 arguments required");
    var p = String(pos).toLowerCase();
    var context;
    if (p === "beforebegin" || p === "afterend") { context = this.parentNode; if (!context || context.nodeType === 9) throw __jb.domError("NoModificationAllowedError", "Cannot insert HTML here"); }
    else if (p === "afterbegin" || p === "beforeend") context = this;
    else throw __jb.domError("SyntaxError", "Invalid position");
    if (context.nodeType !== 1 || (context._tag === "html" && context._ns === __jb.HTML_NS)) context = __jb.ownerDoc(this).createElement("body");
    var frag = __jb.parseFragment(String(html), context);
    this.insertAdjacentElement(p, frag);
  }
  insertAdjacentElement(pos, node) {
    switch (String(pos).toLowerCase()) {
      case "beforebegin": if (!this.parentNode) return null; __jb.preInsert(this.parentNode, node, this); break;
      case "afterbegin": __jb.preInsert(this, node, this.firstChild); break;
      case "beforeend": __jb.preInsert(this, node, null); break;
      case "afterend": if (!this.parentNode) return null; __jb.preInsert(this.parentNode, node, this.nextSibling); break;
      default: throw __jb.domError("SyntaxError", "Invalid position");
    }
    return node;
  }
  insertAdjacentText(pos, text) { this.insertAdjacentElement(pos, this.ownerDocument.createTextNode(String(text))); }
  matches(sel) { if (arguments.length < 1) throw new TypeError("matches: 1 argument required"); return __jb.matchesSelector(this, sel); }
  webkitMatchesSelector(sel) { if (arguments.length < 1) throw new TypeError("webkitMatchesSelector: 1 argument required"); return this.matches(sel); }
  msMatchesSelector(sel) { return this.matches(sel); }
  closest(sel) { if (arguments.length < 1) throw new TypeError("closest: 1 argument required"); __jb.parseSelectorList(String(sel)); for (var e = this; e && e.nodeType === 1; e = e.parentNode) if (__jb.matchesSelector(e, sel)) return e; return null; }
  attachShadow(init) {
    if (this._ns !== __jb.HTML_NS) throw __jb.domError("NotSupportedError", "Cannot attach a shadow root to a non-HTML element");
    var valid = /^(article|aside|blockquote|body|div|footer|h[1-6]|header|main|nav|p|section|span)$/.test(this._tag) || (this._tag.indexOf("-") > 0 && /^[a-z]/.test(this._tag));
    if (!valid) throw __jb.domError("NotSupportedError", "Cannot attach a shadow root to this element");
    if (!init || (init.mode !== "open" && init.mode !== "closed")) throw new TypeError("attachShadow: mode must be 'open' or 'closed'");
    if (init.slotAssignment !== undefined && init.slotAssignment !== "named" && init.slotAssignment !== "manual") throw new TypeError("attachShadow: slotAssignment must be 'named' or 'manual'");
    if (this._ceDef && this._ceDef.disableShadow) throw __jb.domError("NotSupportedError", "Shadow root disabled");
    if (this._shadowRoot) { if (this._shadowRoot._declarative && this._shadowRoot.mode === init.mode) { this._shadowRoot._declarative = false; __jb.replaceAll(this._shadowRoot, null); return this._shadowRoot; } throw __jb.domError("NotSupportedError", "Shadow root already attached"); }
    __jb.shadowConstructing = true;
    try { this._shadowRoot = new ShadowRoot(this, init); } finally { __jb.shadowConstructing = false; } this._shadowRoot._doc = this.ownerDocument; return this._shadowRoot;
  }
  get shadowRoot() { return this._shadowRoot && this._shadowRoot.mode === "open" ? this._shadowRoot : null; }
  get assignedSlot() { return null; }
  getBoundingClientRect() { var r = __jb.layoutRect(this); if (r && r.width === 0 && r.height === 0 && !__jb.isRendered(this)) r = null; return r ? new DOMRect(r.x - globalThis.scrollX, r.y - globalThis.scrollY, r.width, r.height) : new DOMRect(0, 0, 0, 0); }
  getClientRects() { var r = this.getBoundingClientRect(); return r.width === 0 && r.height === 0 && !__jb.layoutRect(this) ? [] : [r]; }
  get clientWidth() { return 0; } get clientHeight() { return 0; } get clientTop() { return 0; } get clientLeft() { return 0; }
  get scrollWidth() { return 0; } get scrollHeight() { return 0; }
  get scrollTop() { return this._scrollTop || 0; } set scrollTop(v) { this._scrollTop = Number(v) || 0; }
  get scrollLeft() { return this._scrollLeft || 0; } set scrollLeft(v) { this._scrollLeft = Number(v) || 0; }
  scroll() {} scrollTo() {} scrollBy() {} scrollIntoView() {} scrollIntoViewIfNeeded() {}
  requestFullscreen() { return Promise.resolve(); } requestPointerLock() {}
  animate() { return { play: function () {}, pause: function () {}, cancel: function () {}, finish: function () {}, finished: Promise.resolve(), onfinish: null, addEventListener: function () {}, removeEventListener: function () {} }; }
  getAnimations() { return []; }
  setPointerCapture() {} releasePointerCapture() {} hasPointerCapture() { return false; }
  checkVisibility() { return this.isConnected; }
  _compileHandler(type, code) {
    var fn = null;
    var isWindowHandler = (this._tag === "body" || this._tag === "frameset") && this._ns === __jb.HTML_NS && __jb.WINDOW_HANDLER_NAMES.indexOf(type) >= 0;
    if (__jb.scriptsAllowed === false) code = null; // sandboxed document without allow-scripts: content attributes are not compiled
    if (code !== null && code !== undefined) {
      // Window onerror handlers take (event, source, lineno, colno, error).
      if (__jb.csp && !__jb.csp.allowsHandler(this, code)) code = null;
      if (code !== null) try { fn = __jb.csp ? __jb.csp.trusted(function () { return isWindowHandler && type === "error" ? new Function("event", "source", "lineno", "colno", "error", code) : new Function("event", code); }) : isWindowHandler && type === "error" ? new Function("event", "source", "lineno", "colno", "error", code) : new Function("event", code); } catch (e) { fn = null; }
    }
    // <body onload=...> and friends are window event handlers.
    if ((this._tag === "body" || this._tag === "frameset") && this._ns === __jb.HTML_NS && __jb.WINDOW_HANDLER_NAMES.indexOf(type) >= 0) {
      var w = this.ownerDocument && this.ownerDocument.defaultView;
      if (w) w["on" + type] = fn;
      return;
    }
    this._handlers[type] = fn;
    __jb.handlerSlot(this, type, fn);
  }
}
mixin(Element.prototype, ParentNodeMixin);
mixin(Element.prototype, ChildNodeMixin);
mixin(Element.prototype, NonDocumentTypeChildNodeMixin);
__jb.setTag(Element, "Element");
// GlobalEventHandlers: on<event> accessors backed by _handlers.
__jb.defineEventHandlerProps = function (proto, names) {
  names.forEach(function (name) {
    Object.defineProperty(proto, "on" + name, {
      get: function () { return (this._handlers && this._handlers[name]) || null; },
      set: function (f) { if (!this._handlers) this._handlers = {}; this._handlers[name] = typeof f === "function" || (f !== null && typeof f === "object") ? f : null; __jb.handlerSlot(this, name, this._handlers[name]); },
      configurable: true,
      enumerable: true,
    });
  });
};

// Parse markup for innerHTML & friends with the native (html5ever) parser.
// opts.unsafe: declarative shadow roots are honoured (setHTMLUnsafe);
// opts.runScripts: inserted scripts may run.
__jb.parseFragment = function (html, contextElement, opts) {
  var doc = __jb.ownerDoc(contextElement);
  var frag = doc.createDocumentFragment();
  var ctxTag = contextElement && contextElement.nodeType === 1 ? contextElement._local : "body";
  var ctxNs = contextElement && contextElement._ns === __jb.SVG_NS ? "svg" : contextElement && contextElement._ns === __jb.MATHML_NS ? "math" : "html";
  // Scripting is disabled for documents without a browsing context (and inert template contents),
  // which changes how <noscript> parses.
  var target = contextElement && contextElement._tag === "template" && contextElement._ns === __jb.HTML_NS && contextElement.content ? contextElement.content.ownerDocument : doc;
  var json = __jb.native("html", { html: html, context: ctxTag, ns: ctxNs, scripting: !!(target && target.defaultView) });
  if (json && json.c) __jb.buildTree(json.c, doc, frag, false, !(opts && opts.runScripts), !!(opts && opts.unsafe));
  else __jb.parseHTML(html, doc, frag);
  return frag;
};
// Build nodes from the JSON records produced by Rust.
__jb.buildTree = function (records, doc, parent, assignIds, noScripts, allowShadow) {
  for (var k = 0; k < records.length; k++) __jb.buildNode(records[k], doc, parent, assignIds, noScripts, allowShadow);
};
// <template shadowrootmode> parsed in an "unsafe" context becomes a
// declarative shadow root of its parent.
__jb.applyDeclarativeShadow = function (tpl, parent) {
  var mode = tpl.getAttribute("shadowrootmode");
  if (mode === null) return false;
  mode = mode.toLowerCase();
  if ((mode !== "open" && mode !== "closed") || parent.nodeType !== 1 || parent._shadowRoot) return false;
  var sr;
  try { sr = parent.attachShadow({ mode: mode, slotAssignment: (tpl.getAttribute("shadowrootslotassignment") || "").toLowerCase() === "manual" ? "manual" : "named", delegatesFocus: tpl.hasAttribute("shadowrootdelegatesfocus"), serializable: tpl.hasAttribute("shadowrootserializable"), clonable: tpl.hasAttribute("shadowrootclonable") }); } catch (e) { return false; }
  sr._declarative = true;
  var content = tpl.content;
  while (content.firstChild) { var c = content.firstChild; content._removeChildRaw(c); c._doc = sr.ownerDocument; sr._appendChildRaw(c); }
  parent._removeChildRaw(tpl);
  return true;
};
__jb.buildNode = function (n, doc, parent, assignIds, noScripts, allowShadow) {
  if (n.x !== undefined && n.pi === undefined) { parent._appendChildRaw(doc.createTextNode(n.x)); return; }
  if (n.m !== undefined) { parent._appendChildRaw(doc.createComment(n.m)); return; }
  if (n.pi !== undefined) { var pi = new ProcessingInstruction(n.pi, n.x || ""); pi._doc = doc; parent._appendChildRaw(pi); return; }
  if (n.d !== undefined) { if (parent.nodeType === 9) { var dt = new DocumentType(n.d || "html", n.p || "", n.s || ""); dt._doc = doc; parent._appendChildRaw(dt); } return; }
  if (n.f !== undefined) { if (parent.nodeType === 1 && parent._tag === "template" && parent._ns === __jb.HTML_NS) { var content = parent.content; if (n.c) __jb.buildTree(n.c, content.ownerDocument, content, assignIds, noScripts, allowShadow); } else if (n.c) __jb.buildTree(n.c, doc, parent, assignIds, noScripts, allowShadow); return; }
  var ns = n.n === 1 ? __jb.SVG_NS : n.n === 2 ? __jb.MATHML_NS : __jb.HTML_NS;
  // fragment parsing (innerHTML, DOMParser) creates custom elements without the synchronous flag:
  // they are upgraded after insertion
  var el = __jb.createElementInternal(doc, n.t, ns, null, null, !noScripts);
  if (n.a) for (var i = 0; i < n.a.length; i++) { var a = n.a[i]; el._setAttrRaw(a[0], a[1], a[2] === undefined ? null : a[2]); }
  if (noScripts && el._ceDefPending) (__jb.ceFragmentUpgrades || (__jb.ceFragmentUpgrades = [])).push(el);
  if (assignIds && n.i !== undefined) { el.__jbid = n.i; __jb.nodeById[n.i] = el; }
  parent._appendChildRaw(el);
  // Scripts from fragment parsing (innerHTML, DOMParser) never run.
  if (noScripts && el._tag === "script") el._executed = true;
  if (n.c) __jb.buildTree(n.c, doc, el, assignIds, noScripts, allowShadow);
  if (allowShadow && el._tag === "template" && el._ns === __jb.HTML_NS && el.hasAttribute("shadowrootmode")) __jb.applyDeclarativeShadow(el, parent);
};

// ---- HTML element interfaces ----
__jb.HTML_INTERFACES = { a: "HTMLAnchorElement", abbr: "HTMLElement", address: "HTMLElement", area: "HTMLAreaElement", article: "HTMLElement", aside: "HTMLElement", audio: "HTMLAudioElement", b: "HTMLElement", base: "HTMLBaseElement", bdi: "HTMLElement", bdo: "HTMLElement", blockquote: "HTMLQuoteElement", body: "HTMLBodyElement", br: "HTMLBRElement", button: "HTMLButtonElement", canvas: "HTMLCanvasElement", caption: "HTMLTableCaptionElement", cite: "HTMLElement", code: "HTMLElement", col: "HTMLTableColElement", colgroup: "HTMLTableColElement", data: "HTMLDataElement", datalist: "HTMLDataListElement", dd: "HTMLElement", del: "HTMLModElement", details: "HTMLDetailsElement", dfn: "HTMLElement", dialog: "HTMLDialogElement", dir: "HTMLDirectoryElement", div: "HTMLDivElement", dl: "HTMLDListElement", dt: "HTMLElement", em: "HTMLElement", embed: "HTMLEmbedElement", fieldset: "HTMLFieldSetElement", figcaption: "HTMLElement", figure: "HTMLElement", font: "HTMLFontElement", footer: "HTMLElement", form: "HTMLFormElement", frame: "HTMLFrameElement", frameset: "HTMLFrameSetElement", h1: "HTMLHeadingElement", h2: "HTMLHeadingElement", h3: "HTMLHeadingElement", h4: "HTMLHeadingElement", h5: "HTMLHeadingElement", h6: "HTMLHeadingElement", head: "HTMLHeadElement", header: "HTMLElement", hgroup: "HTMLElement", hr: "HTMLHRElement", html: "HTMLHtmlElement", i: "HTMLElement", iframe: "HTMLIFrameElement", img: "HTMLImageElement", input: "HTMLInputElement", ins: "HTMLModElement", kbd: "HTMLElement", label: "HTMLLabelElement", legend: "HTMLLegendElement", li: "HTMLLIElement", link: "HTMLLinkElement", main: "HTMLElement", map: "HTMLMapElement", mark: "HTMLElement", marquee: "HTMLMarqueeElement", menu: "HTMLMenuElement", meta: "HTMLMetaElement", meter: "HTMLMeterElement", nav: "HTMLElement", noscript: "HTMLElement", object: "HTMLObjectElement", ol: "HTMLOListElement", optgroup: "HTMLOptGroupElement", option: "HTMLOptionElement", output: "HTMLOutputElement", p: "HTMLParagraphElement", param: "HTMLParamElement", picture: "HTMLPictureElement", pre: "HTMLPreElement", progress: "HTMLProgressElement", q: "HTMLQuoteElement", rp: "HTMLElement", rt: "HTMLElement", ruby: "HTMLElement", s: "HTMLElement", samp: "HTMLElement", script: "HTMLScriptElement", search: "HTMLElement", section: "HTMLElement", select: "HTMLSelectElement", slot: "HTMLSlotElement", small: "HTMLElement", source: "HTMLSourceElement", span: "HTMLSpanElement", strong: "HTMLElement", style: "HTMLStyleElement", sub: "HTMLElement", summary: "HTMLElement", sup: "HTMLElement", table: "HTMLTableElement", tbody: "HTMLTableSectionElement", td: "HTMLTableCellElement", template: "HTMLTemplateElement", textarea: "HTMLTextAreaElement", tfoot: "HTMLTableSectionElement", th: "HTMLTableCellElement", thead: "HTMLTableSectionElement", time: "HTMLTimeElement", title: "HTMLTitleElement", tr: "HTMLTableRowElement", track: "HTMLTrackElement", u: "HTMLElement", ul: "HTMLUListElement", "var": "HTMLElement", video: "HTMLVideoElement", wbr: "HTMLElement", acronym: "HTMLElement", basefont: "HTMLElement", big: "HTMLElement", center: "HTMLElement", nobr: "HTMLElement", noembed: "HTMLElement", noframes: "HTMLElement", plaintext: "HTMLElement", rb: "HTMLElement", rtc: "HTMLElement", strike: "HTMLElement", tt: "HTMLElement", listing: "HTMLPreElement", xmp: "HTMLPreElement", image: "HTMLUnknownElement", applet: "HTMLUnknownElement", bgsound: "HTMLUnknownElement", blink: "HTMLUnknownElement", isindex: "HTMLUnknownElement", keygen: "HTMLUnknownElement", multicol: "HTMLUnknownElement", nextid: "HTMLUnknownElement", spacer: "HTMLUnknownElement" };
__jb.elementConstructing = null;
class HTMLElement extends Element {
  constructor(doc, tag) {
    var existing = null;
    if (__jb.elementConstructing) { super(); return; } // internal construction (createElement / parser / cloning)
    if (doc === undefined && tag === undefined) {
      // `new MyElement()` from a custom element constructor, or an upgrade of
      // an element that already exists in the tree.
      var def = __jb.ceConstructing;
      if (def) { doc = def.doc; tag = def.tag; existing = def.existing || null; var recordDef = def.def || null; __jb.ceConstructing = null; }
      else {
        // HTML element constructors: the definition is looked up by NewTarget; the interface
        // NewTarget extends ("active function object") must be HTMLElement for an autonomous
        // custom element and the extended element's interface for a customized built-in.
        // NewTarget equal to the active function object (new HTMLElement()) is never valid
        if (new.target === HTMLElement || __jb.isHtmlInterfaceCtor(new.target)) throw new TypeError("Illegal constructor");
        var d2 = __jb.ceByCtor.get(new.target);
        if (!d2) throw new TypeError("Illegal constructor");
        var active = null;
        for (var ap = Object.getPrototypeOf(new.target); ap; ap = Object.getPrototypeOf(ap)) { if (ap === HTMLElement || __jb.isHtmlInterfaceCtor(ap)) { active = ap; break; } }
        // NewTarget without an HTML interface in its chain (a function or proxy passed to
        // Reflect.construct): the constructor invoked is HTMLElement itself.
        if (!d2.extends) { if (active && active !== HTMLElement) throw new TypeError("Illegal constructor"); tag = d2.name; }
        else { if (active && __jb.htmlInterfaceFor(d2.extends) !== active) throw new TypeError("Illegal constructor"); tag = d2.extends; }
        doc = __jb.currentDocument;
        var directDef = d2;
      }
    } else if (doc && doc.nodeType !== 9) throw new TypeError("Illegal constructor");
    super(doc, tag);
    if (existing) { Object.setPrototypeOf(existing, new.target.prototype); return existing; }
    if (directDef) {
      var setRaw = Element.prototype._setAttrRaw;
      this._ceDef = directDef; if (directDef.extends) setRaw.call(this, "is", directDef.name);
      // NewTarget.prototype not an object: the interface prototype of NewTarget's realm
      // allocation fell back to the realm's Object.prototype when NewTarget.prototype was not an
      // object (read once, by the allocation itself)
      var ap0 = Object.getPrototypeOf(this);
      if (ap0 === null || Object.getPrototypeOf(ap0) === null) {
        var rg = null; try { rg = Object.getPrototypeOf(new.target).constructor("return this")(); } catch (e) { rg = null; }
        var iface = directDef.extends ? __jb.htmlInterfaceFor(directDef.extends) : HTMLElement;
        var C = rg && iface && rg[iface.name] ? rg[iface.name] : iface;
        Object.setPrototypeOf(this, C.prototype);
      }
    }
    else if (recordDef && !this._ceDef) this._ceDef = recordDef;
  }
  get title() { return this.getAttribute("title") || ""; } set title(v) { this.setAttribute("title", v); }
  get lang() { return this.getAttribute("lang") || ""; } set lang(v) { this.setAttribute("lang", v); }
  get translate() { var t = this.getAttribute("translate"); return t === null ? (this.parentElement ? this.parentElement.translate !== false : true) : t.toLowerCase() !== "no"; } set translate(v) { this.setAttribute("translate", v ? "yes" : "no"); }
  get dir() { var d = (this.getAttribute("dir") || "").toLowerCase(); return d === "ltr" || d === "rtl" || d === "auto" ? d : ""; } set dir(v) { this.setAttribute("dir", v); }
  get hidden() { return this.hasAttribute("hidden"); } set hidden(v) { this.toggleAttribute("hidden", !!v); }
  get inert() { return this.hasAttribute("inert"); } set inert(v) { this.toggleAttribute("inert", !!v); }
  get tabIndex() { var t = this.getAttribute("tabindex"); if (t !== null && /^\s*[-+]?\d+/.test(t)) return parseInt(t, 10); return /^(a|button|input|select|textarea|iframe|area|summary|details)$/.test(this._tag) ? 0 : -1; } set tabIndex(v) { this.setAttribute("tabindex", String(v | 0)); }
  get accessKey() { return this.getAttribute("accesskey") || ""; } set accessKey(v) { this.setAttribute("accesskey", v); }
  get accessKeyLabel() { return ""; }
  get draggable() { var d = (this.getAttribute("draggable") || "").toLowerCase(); if (d === "true") return true; if (d === "false") return false; return this._ns === __jb.HTML_NS && (this._tag === "img" || (this._tag === "a" && this.hasAttribute("href"))); } set draggable(v) { this.setAttribute("draggable", v ? "true" : "false"); }
  get spellcheck() { return this.getAttribute("spellcheck") !== "false"; } set spellcheck(v) { this.setAttribute("spellcheck", v ? "true" : "false"); }
  get contentEditable() { var v = (this.getAttribute("contenteditable") || "").toLowerCase(); return v === "" && this.hasAttribute("contenteditable") ? "true" : v === "true" || v === "false" || v === "plaintext-only" ? v : "inherit"; } set contentEditable(v) { v = String(v).toLowerCase(); if (v === "inherit") { this.removeAttribute("contenteditable"); return; } if (v !== "true" && v !== "false" && v !== "plaintext-only") throw __jb.domError("SyntaxError", "invalid contentEditable value"); this.setAttribute("contenteditable", v); }
  get isContentEditable() { var v = this.contentEditable; return v === "true" || v === "plaintext-only" || (v === "inherit" && !!this.parentElement && !!this.parentElement.isContentEditable); }
  get nonce() { return typeof __jb.elementNonce === "function" ? __jb.elementNonce(this) : (this.getAttribute("nonce") || ""); } set nonce(v) { this._nonceSlot = String(v); }
  get autofocus() { return this.hasAttribute("autofocus"); } set autofocus(v) { this.toggleAttribute("autofocus", !!v); }
  get autocapitalize() { return (this.getAttribute("autocapitalize") || "").toLowerCase(); } set autocapitalize(v) { this.setAttribute("autocapitalize", v); }
  get enterKeyHint() { return (this.getAttribute("enterkeyhint") || "").toLowerCase(); } set enterKeyHint(v) { this.setAttribute("enterkeyhint", v); }
  get inputMode() { return (this.getAttribute("inputmode") || "").toLowerCase(); } set inputMode(v) { this.setAttribute("inputmode", v); }
  get offsetParent() { return this.parentElement; } get offsetTop() { return 0; } get offsetLeft() { return 0; } get offsetWidth() { return 0; } get offsetHeight() { return 0; }
  get popover() { var p = this.getAttribute("popover"); return p === null ? null : p.toLowerCase() === "manual" ? "manual" : "auto"; } set popover(v) { if (v === null) this.removeAttribute("popover"); else this.setAttribute("popover", v); }
  showPopover() {} hidePopover() {} togglePopover() { return false; }
  click() { if (this.hasAttribute("disabled") && /^(button|input|select|textarea|fieldset|optgroup|option)$/.test(this._tag)) return; if (this._clickInProgress) return; this._clickInProgress = true; try { this.dispatchEvent(new PointerEvent("click", { bubbles: true, cancelable: true, composed: true, pointerId: -1, pointerType: "" })); } finally { this._clickInProgress = false; } }
  focus() { var doc = this.ownerDocument; if (doc._jbActive === this) return; var prev = doc._jbActive; doc._jbActive = this; if (prev) { prev.dispatchEvent(new FocusEvent("blur")); prev.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); } this.dispatchEvent(new FocusEvent("focus")); this.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); }
  blur() { var doc = this.ownerDocument; if (doc._jbActive !== this) return; doc._jbActive = null; this.dispatchEvent(new FocusEvent("blur")); this.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); }
  attachInternals() { if (this._internalsAttached) throw __jb.domError("NotSupportedError", "attachInternals already called"); if (!this._ceDef || this._ceDef.extends) throw __jb.domError("NotSupportedError", "Not an autonomous custom element"); this._internalsAttached = true; var el = this; return { get shadowRoot() { return el._shadowRoot; }, setFormValue: function () {}, setValidity: function () {}, checkValidity: function () { return true; }, reportValidity: function () { return true; }, states: new Set(), form: null, labels: [], willValidate: true, validity: {}, validationMessage: "" }; }
}
__jb.setTag(HTMLElement, "HTMLElement");
class HTMLUnknownElement extends HTMLElement {}
__jb.setTag(HTMLUnknownElement, "HTMLUnknownElement");
class SVGElement extends Element {
  constructor(doc, tag) {
    if (__jb.elementConstructing) { super(); return; }
    if (doc === undefined) throw new TypeError("Illegal constructor");
    super(doc, tag); this._ns = __jb.SVG_NS;
  }
  get ownerSVGElement() { return this.closest("svg"); } get viewportElement() { return this.ownerSVGElement; } getBBox() { return { x: 0, y: 0, width: 0, height: 0 }; } getScreenCTM() { return null; } getCTM() { return null; } createSVGPoint() { return { x: 0, y: 0, matrixTransform: function () { return this; } }; }
  get className() { var c = this.getAttribute("class") || ""; return { baseVal: c, animVal: c, toString: function () { return c; } }; } set className(v) { this.setAttribute("class", v); }
  focus() {} blur() {}
  get tabIndex() { return -1; }
}
__jb.setTag(SVGElement, "SVGElement");
["href", "viewBox", "width", "height", "x", "y", "cx", "cy", "r", "d", "fill", "stroke", "transform", "points", "preserveAspectRatio"].forEach(function (p) { Object.defineProperty(SVGElement.prototype, p, { get: function () { var v = this.getAttribute(p); return { baseVal: v, animVal: v, toString: function () { return v; } }; }, configurable: true }); });
class MathMLElement extends Element {
  constructor(doc, tag) {
    if (__jb.elementConstructing) { super(); return; }
    if (doc === undefined) throw new TypeError("Illegal constructor");
    super(doc, tag); this._ns = __jb.MATHML_NS;
  }
}
__jb.setTag(MathMLElement, "MathMLElement");
// Concrete HTML element classes.
__jb.htmlClasses = {};
(function () {
  var names = {};
  Object.keys(__jb.HTML_INTERFACES).forEach(function (t) { names[__jb.HTML_INTERFACES[t]] = 1; });
  ["HTMLMediaElement", "HTMLAudioElement", "HTMLVideoElement", "HTMLUnknownElement"].forEach(function (n) { names[n] = 1; });
  delete names.HTMLElement; delete names.HTMLUnknownElement;
  var media = { HTMLAudioElement: 1, HTMLVideoElement: 1 };
  var Media = class HTMLMediaElement extends HTMLElement {};
  __jb.setTag(Media, "HTMLMediaElement");
  __jb.htmlClasses.HTMLMediaElement = Media;
  Object.keys(names).forEach(function (n) {
    if (n === "HTMLMediaElement") return;
    var Base = media[n] ? Media : HTMLElement;
    var C = ({ [n]: class extends Base {} })[n];
    __jb.setTag(C, n);
    __jb.htmlClasses[n] = C;
  });
  __jb.htmlClasses.HTMLElement = HTMLElement;
  __jb.htmlClasses.HTMLUnknownElement = HTMLUnknownElement;
})();
__jb.isHtmlInterfaceCtor = function (C) { for (var k in __jb.htmlClasses) if (__jb.htmlClasses[k] === C) return true; return false; };
__jb.htmlInterfaceFor = function (local) {
  var n = __jb.HTML_INTERFACES[local];
  if (n) return __jb.htmlClasses[n] || HTMLElement;
  if (local.indexOf("-") > 0 && /^[a-z]/.test(local)) return HTMLElement;
  return HTMLUnknownElement;
};
__jb.SVG_INTERFACES = { svg: "SVGSVGElement", g: "SVGGElement", path: "SVGPathElement", use: "SVGUseElement", circle: "SVGCircleElement", rect: "SVGRectElement", line: "SVGLineElement", text: "SVGTextElement", image: "SVGImageElement", defs: "SVGDefsElement", linearGradient: "SVGLinearGradientElement", stop: "SVGStopElement", polygon: "SVGPolygonElement", polyline: "SVGPolylineElement", ellipse: "SVGEllipseElement", symbol: "SVGSymbolElement", clipPath: "SVGClipPathElement", mask: "SVGMaskElement", foreignObject: "SVGForeignObjectElement", animate: "SVGAnimateElement", tspan: "SVGTSpanElement", title: "SVGTitleElement", desc: "SVGDescElement", style: "SVGStyleElement", filter: "SVGFilterElement", pattern: "SVGPatternElement", marker: "SVGMarkerElement", a: "SVGAElement", script: "SVGScriptElement", metadata: "SVGMetadataElement", switch: "SVGSwitchElement", view: "SVGViewElement", radialGradient: "SVGRadialGradientElement" };
__jb.svgClasses = {};
(function () {
  var Graphics = class SVGGraphicsElement extends SVGElement {};
  __jb.setTag(Graphics, "SVGGraphicsElement");
  __jb.svgClasses.SVGGraphicsElement = Graphics;
  var graphic = { SVGSVGElement: 1, SVGGElement: 1, SVGPathElement: 1, SVGUseElement: 1, SVGCircleElement: 1, SVGRectElement: 1, SVGLineElement: 1, SVGTextElement: 1, SVGImageElement: 1, SVGDefsElement: 1, SVGPolygonElement: 1, SVGPolylineElement: 1, SVGEllipseElement: 1, SVGForeignObjectElement: 1, SVGTSpanElement: 1, SVGAElement: 1, SVGSwitchElement: 1 };
  Object.keys(__jb.SVG_INTERFACES).forEach(function (t) { var n = __jb.SVG_INTERFACES[t]; if (__jb.svgClasses[n]) return; var C = ({ [n]: class extends (graphic[n] ? Graphics : SVGElement) {} })[n]; __jb.setTag(C, n); __jb.svgClasses[n] = C; });
})();
// Central element factory. `local` keeps its case; `_tag` is lowercased.
__jb.createElementInternal = function (doc, local, ns, prefix, is, synchronousCE) {
  var C;
  if (ns === __jb.HTML_NS) {
    // definitions are looked up only for documents with a browsing context
    var lookup = doc === __jb.currentDocument || !!(doc.defaultView);
    // "look up a custom element definition": autonomous by local name, customized built-in by
    // is value whose extends is the local name
    var def = null;
    if (lookup) {
      var byName = __jb.ceRegistry[local];
      if (byName && !byName.extends && byName.name === local) def = byName;
      else if (is !== undefined && is !== null) { var byIs = __jb.ceRegistry[String(is)]; if (byIs && byIs.extends === local) def = byIs; }
    }
    if (def && doc._isHTML !== false) {
      if (synchronousCE && def.extends) {
        // customized built-in: created with its interface, then upgraded synchronously
        __jb.elementConstructing = { doc: doc, tag: local, ns: ns, prefix: prefix };
        var cb = new (__jb.htmlInterfaceFor(def.extends))();
        cb._setAttrRaw("is", String(is));
        __jb.upgradeElement(cb, def);
        return cb;
      }
      if (synchronousCE) {
        __jb.ceConstructing = { doc: doc, tag: local, def: def };
        var el;
        var failed = false;
        try {
          el = Reflect.construct(def.ctor, [], def.ctor);
          // the constructed result must be a fresh element of this document with no attributes,
          // children or parent (else a TypeError / NotSupportedError is reported)
          if (!el || typeof el !== "object" || !(el instanceof HTMLElement)) throw new TypeError("custom element constructor did not return an HTMLElement");
          if (el._attrs && el._attrs.length) throw __jb.domError("NotSupportedError", "custom element has attributes after construction");
          if (el.firstChild) throw __jb.domError("NotSupportedError", "custom element has children after construction");
          if (el.parentNode) throw __jb.domError("NotSupportedError", "custom element has a parent after construction");
          if (el.ownerDocument !== doc) throw __jb.domError("NotSupportedError", "custom element belongs to another document");
          if (el._local !== local) throw __jb.domError("NotSupportedError", "custom element has another local name");
        } catch (e) { __jb.ceConstructing = null; __jb.reportException(e); el = null; failed = true; }
        __jb.ceConstructing = null;
        if (el && el.nodeType === 1) { el._ceDef = def; el._doc = doc; el._local = local; el._tag = local.toLowerCase(); el._ns = ns; el._prefix = prefix; if (is) el._setAttrRaw("is", String(is).toLowerCase()); return el; }
        if (failed) {
          __jb.elementConstructing = { doc: doc, tag: local, ns: ns, prefix: prefix };
          var unk = new HTMLUnknownElement();
          unk._ceFailed = true;
          return unk;
        }
      }
      __jb.elementConstructing = { doc: doc, tag: local, ns: ns, prefix: prefix };
      var proto = def.extends ? __jb.htmlInterfaceFor(def.extends) : HTMLElement;
      var el2 = new proto();
      el2._ceDefPending = def;
      if (is) el2._setAttrRaw("is", String(is).toLowerCase());
      return el2;
    }
    C = __jb.htmlInterfaceFor(local);
  } else if (ns === __jb.SVG_NS) {
    C = __jb.svgClasses[__jb.SVG_INTERFACES[local]] || SVGElement;
  } else if (ns === __jb.MATHML_NS) {
    C = (__jb.mathmlClasses && __jb.mathmlClasses[local]) || MathMLElement;
  } else {
    C = Element;
  }
  __jb.elementConstructing = { doc: doc, tag: local, ns: ns, prefix: prefix };
  var out = new C();
  __jb.elementConstructing = null;
  if (is && ns === __jb.HTML_NS) out._setAttrRaw("is", String(is).toLowerCase());
  if (ns === __jb.HTML_NS && local === "form" && typeof __jb.formProxy === "function") out = __jb.formProxy(out);
  if (ns === __jb.HTML_NS && local === "select" && typeof __jb.selectProxy === "function") out = __jb.selectProxy(out);
  return out;
};
// HTMLFormElement's indexed and named properties ([LegacyUnenumerableNamedProperties]):
// form[i] and form.name resolve to its listed controls (or <img>s), not shadowing the prototype.
__jb.formProxy = function (form) {
  var isIndex = function (k) { return typeof k === "string" && /^(0|[1-9][0-9]*)$/.test(k); };
  var proxy;
  var inNamed = false;
  var named = function (name) {
    if (name === "" || inNamed) return undefined;
    inNamed = true;
    try { return namedInner(name); } finally { inNamed = false; }
  };
  // Name -> element / RadioNodeList, rebuilt once per DOM version.
  var cache = { ver: -1, map: null };
  var namedInner = function (name) {
    if (cache.ver !== __jb.namesVersion) {
      var map = Object.create(null), add = function (key, e) { if (!key) return; (map[key] || (map[key] = [])).indexOf(e) < 0 && map[key].push(e); };
      var els = __jb.arrayFrom(__jb.formElementsOf(proxy));
      els.forEach(function (e) { add(e.getAttribute("id"), e); add(e.getAttribute("name"), e); });
      var imgs = Object.create(null);
      __jb.descendants(proxy.getRootNode(), function (n) { return n.nodeType === 1 && n._tag === "img" && n._ns === __jb.HTML_NS; }).forEach(function (n) { if (__jb.formOwner(n) !== proxy) return; [n.getAttribute("id"), n.getAttribute("name")].forEach(function (k) { if (k) (imgs[k] || (imgs[k] = [])).push(n); }); });
      cache = { ver: __jb.namesVersion, map: map, imgs: imgs };
    }
    var list = cache.map[name] || cache.imgs[name];
    if (!list || !list.length) return undefined;
    if (list.length === 1) return list[0];
    return __jb.formElementsOf(proxy).namedItem(name);
  };
  proxy = new Proxy(form, {
    get: function (t, k, r) {
      if (typeof k === "string") {
        if (isIndex(k)) return __jb.formElementsOf(proxy)[k];
        // [LegacyOverrideBuiltIns]: named controls shadow the prototype (not own properties).
        if (k.charAt(0) !== "_" && !__jb.FORM_INTERNAL_NAMES[k] && !Object.prototype.hasOwnProperty.call(t, k)) { var v = named(k); if (v !== undefined) return v; }
      }
      return Reflect.get(t, k, r);
    },
    has: function (t, k) {
      if (isIndex(k)) return Number(k) < __jb.formElementsOf(proxy).length;
      if (k in t) return true;
      return typeof k === "string" && named(k) !== undefined;
    },
    getOwnPropertyDescriptor: function (t, k) {
      if (isIndex(k)) { var e = __jb.formElementsOf(proxy)[k]; return e ? { value: e, writable: false, enumerable: true, configurable: true } : undefined; }
      var d = Reflect.getOwnPropertyDescriptor(t, k);
      if (d || typeof k !== "string" || k in t) return d;
      var v = named(k);
      return v !== undefined ? { value: v, writable: false, enumerable: false, configurable: true } : undefined;
    },
    ownKeys: function (t) { var keys = [], n = __jb.formElementsOf(proxy).length; for (var i = 0; i < n; i++) keys.push(String(i)); return keys.concat(Reflect.ownKeys(t)); },
    defineProperty: function (t, k, d) { if (isIndex(k)) return false; return Reflect.defineProperty(t, k, d); },
  });
  return proxy;
};

// Reflect common attributes as properties.
["type", "value", "src", "alt", "href", "target", "rel", "placeholder", "action", "method", "enctype", "for", "label", "content", "charset", "media", "sizes", "srcset", "loading", "width", "height", "poster", "preload", "download", "hreflang", "ping", "referrerPolicy", "accept", "autocomplete", "min", "max", "step", "pattern", "maxLength", "minLength", "size", "rows", "cols", "wrap", "kind", "srclang", "cite", "datetime", "headers", "scope", "abbr", "span", "colSpan", "rowSpan", "useMap", "isMap", "crossOrigin", "integrity", "as", "list", "form", "formAction", "formMethod", "formTarget", "formEnctype", "formNoValidate", "dirName", "shape", "coords", "align", "vAlign", "bgColor", "border", "cellPadding", "cellSpacing", "frameBorder", "scrolling", "allow", "sandbox", "srcdoc", "start", "reversed", "dateTime", "open", "text", "hspace", "vspace", "noModule", "async", "defer", "xmlns", "httpEquiv", "scheme", "noValidate", "acceptCharset", "defaultValue", "low", "high", "optimum", "readOnly", "multiple", "required", "disabled", "checked", "selected", "defaultChecked", "defaultSelected", "indeterminate", "loop", "autoplay", "controls", "muted", "defaultMuted", "playsInline", "allowFullscreen", "compact", "declare", "noHref", "noShade", "noWrap", "ismap", "usemap", "longDesc", "vlink", "alink", "link", "aLink", "vLink", "background", "marginHeight", "marginWidth", "noResize", "valueType", "codeBase", "codeType", "archive", "standby", "classId", "clear", "chOff", "ch", "axis", "summary", "frame", "rules", "profile", "version", "nonce", "blocking", "shadowRootMode", "popoverTarget", "popoverTargetAction", "fetchPriority", "decoding", "referrerpolicy"].forEach(function (prop) {
  if (Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)) return;
  var attr = { acceptCharset: "accept-charset", httpEquiv: "http-equiv" }[prop] || prop.toLowerCase();
  var isBool = /^(open|reversed|noModule|async|defer|isMap|formNoValidate|noValidate|readOnly|multiple|required|disabled|indeterminate|loop|autoplay|controls|muted|defaultMuted|playsInline|allowFullscreen|compact|declare|noHref|noShade|noWrap|ismap|noResize|defaultChecked|defaultSelected)$/.test(prop);
  var isUrl = /^(href|src|action|formAction|poster|cite|ping|longDesc|codeBase|background|data)$/.test(prop);
  var isNum = /^(width|height|maxLength|minLength|size|rows|cols|span|colSpan|rowSpan|start|marginHeight|marginWidth|hspace|vspace)$/.test(prop);
  Object.defineProperty(HTMLElement.prototype, prop, {
    get: function () {
      if (prop === "value" && this._valueOverride !== undefined) return this._valueOverride;
      if (prop === "form") {
        // label.form is its labeled control's form owner
        if (this._tag === "label" && this._ns === __jb.HTML_NS) { var lc = __jb.labeledControl(this); return lc && /^(button|fieldset|input|object|output|select|textarea)$/.test(lc._tag) ? __jb.formOwner(lc) : (lc && lc.constructor && lc.constructor.formAssociated ? lc.form : null); }
        return __jb.formOwner(this);
      }
      if (prop === "type" && this._tag === "input") return __jb.inputType(this);
      if (prop === "type" && this._tag === "button") { var bt = (this.getAttribute("type") || "").toLowerCase(); if (bt === "reset" || bt === "button" || bt === "submit") return bt; return this.hasAttribute("command") || this.hasAttribute("commandfor") ? "button" : "submit"; }
      if (prop === "method" && this._tag === "form") { var m = (this.getAttribute("method") || "").toLowerCase(); return m === "post" || m === "dialog" ? m : "get"; }
      if (prop === "action" && this._tag === "form") { var a = this.getAttribute("action"); return a === null || a === "" ? (this.ownerDocument ? this.ownerDocument.URL : "") : __jb.resolveURL(a, this); }
      if (prop === "value" && this._tag === "textarea") return this.textContent;
      if (prop === "value" && this._tag === "select") { var o = this.selectedOptions[0]; return o ? o.value : ""; }
      if (prop === "value" && this._tag === "option") { var v = this.getAttribute("value"); return v === null ? this.textContent.replace(/[\t\n\f\r ]+/g, " ").trim() : v; }
      if (prop === "value" && this._tag === "button") return this.getAttribute("value") || "";
      if (prop === "value" && this._tag === "li") { return parseInt(this.getAttribute("value"), 10) || 0; }
      if (prop === "text" && this._tag === "option") return this.textContent.replace(/[\t\n\f\r ]+/g, " ").trim();
      if (prop === "text" && (this._tag === "script" || this._tag === "title" || this._tag === "a")) return this.textContent;
      if (prop === "content" && this._tag === "template") return this.content;
      if (prop === "list" && this._tag === "input") { var lid = this.getAttribute("list"); return lid ? this.ownerDocument.getElementById(lid) : null; }
      if (prop === "checked") return this._checked !== undefined ? this._checked : this.hasAttribute("checked");
      if (prop === "selected") return this._selected !== undefined ? this._selected : this.hasAttribute("selected");
      if (prop === "defaultValue") return this._tag === "textarea" ? this.textContent : (this.getAttribute("value") || "");
      if (prop === "defaultChecked") return this.hasAttribute("checked");
      if (prop === "defaultSelected") return this.hasAttribute("selected");
      if (prop === "target" && this._tag === "form") return this.getAttribute("target") || "";
      var raw = this.getAttribute(attr);
      if (isBool) return raw !== null;
      if (isUrl) return raw === null ? "" : __jb.resolveURL(raw, this);
      if (isNum) return raw === null ? (prop === "rows" ? 2 : prop === "cols" ? 20 : prop === "size" ? 20 : prop === "span" || prop === "colSpan" || prop === "rowSpan" || prop === "start" ? 1 : prop === "maxLength" || prop === "minLength" ? -1 : 0) : (parseInt(raw, 10) >= 0 ? parseInt(raw, 10) : 0);
      return raw === null ? "" : raw;
    },
    set: function (v) {
      if (prop === "value" && (this._tag === "input" || this._tag === "textarea" || this._tag === "select")) { var sv = v === null ? "" : String(v); this._valueOverride = sv; if (this._tag === "textarea") { this._valueOverride = sv; } else if (this._tag === "select") { this._valueOverride = undefined; var self_ = this; var matched = false; __jb.arrayFrom(this.options).forEach(function (o) { var sel = !matched && o.value === sv; if (sel) matched = true; o._selected = sel; }); } __jb.markDirty(this); return; }
      if (prop === "text" && (this._tag === "script" || this._tag === "title" || this._tag === "a" || this._tag === "option")) { this.textContent = String(v); return; }
      if (prop === "checked") { this._checked = !!v; if (v && __jb.inputType(this) === "radio" && this.name) { var me = this; var root = __jb.formOwner(this) || this.getRootNode(); __jb.descendants(root, function (n) { return n.nodeType === 1 && n._tag === "input"; }).forEach(function (r) { if (r !== me && __jb.inputType(r) === "radio" && r.name === me.name && __jb.formOwner(r) === __jb.formOwner(me)) r._checked = false; }); } __jb.markDirty(this); return; }
      if (prop === "selected") { this._selected = !!v; if (v) { var sel = this.closest("select"); if (sel && !sel.multiple) { var self2 = this; __jb.arrayFrom(sel.options).forEach(function (o) { if (o !== self2) o._selected = false; }); } } __jb.markDirty(this); return; }
      if (prop === "defaultValue") { if (this._tag === "textarea") this.textContent = String(v); else this.setAttribute("value", String(v)); return; }
      if (prop === "defaultChecked") { this.toggleAttribute("checked", !!v); return; }
      if (prop === "defaultSelected") { this.toggleAttribute("selected", !!v); return; }
      if (isBool) { this.toggleAttribute(attr, !!v); return; }
      if (isNum) { var n = Number(v); if (!isFinite(n) || n < 0) { if (/^(rows|cols|size|span|colSpan|rowSpan)$/.test(prop)) throw __jb.domError("IndexSizeError", "value out of range"); n = 0; } this.setAttribute(attr, String(Math.floor(n))); return; }
      this.setAttribute(attr, String(v));
    },
    configurable: true,
  });
});
__jb.INPUT_TYPES = ["hidden", "text", "search", "tel", "url", "email", "password", "date", "month", "week", "time", "datetime-local", "number", "range", "color", "checkbox", "radio", "file", "submit", "image", "reset", "button"];
__jb.inputType = function (el) { var t = (el.getAttribute("type") || "").toLowerCase(); return __jb.INPUT_TYPES.indexOf(t) >= 0 ? t : "text"; };
__jb.formOwner = function (el) {
  if (el._tag === "form") return null;
  var fa = el.getAttribute("form");
  if (fa !== null && el.isConnected) { var f = __jb.ownerDoc(el).getElementById(fa); return f && f._tag === "form" ? f : null; }
  return el.closest("form");
};
Object.defineProperty(HTMLElement.prototype, "options", { get: function () { var self_ = this; if (this._tag !== "select" && this._tag !== "datalist") return __jb.liveCollection(function () { return []; }); if (!Object.prototype.hasOwnProperty.call(this, "_optionsList")) Object.defineProperty(this, "_optionsList", { value: __jb.liveCollection(function () { var out = []; for (var c = self_.firstChild; c; c = c.nextSibling) { if (c.nodeType !== 1) continue; if (c._tag === "option") out.push(c); else if (c._tag === "optgroup") for (var g = c.firstChild; g; g = g.nextSibling) if (g.nodeType === 1 && g._tag === "option") out.push(g); } return out; }), enumerable: false }); try { var list = this._optionsList; Object.defineProperty(list, "selectedIndex", { get: function () { return self_.selectedIndex; }, set: function (v) { self_.selectedIndex = v; }, configurable: true }); } catch (e) {} return this._optionsList; }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "selectedOptions", { get: function () { var self_ = this; return __jb.liveCollection(function () { var opts = __jb.arrayFrom(self_.options).filter(function (o) { return o.selected; }); if (!opts.length && self_._tag === "select" && !self_.multiple) { var first = self_.options[0]; if (first) opts = [first]; } return opts; }); }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "selectedIndex", { get: function () { if (this._tag !== "select") return undefined; var o = this.options; for (var i = 0; i < o.length; i++) if (o[i].selected) return i; if (!o.length || this.multiple || this.size > 1) return -1; for (var k = 0; k < o.length; k++) if (!__jb.isDisabled(o[k])) return k; return -1; }, set: function (i) { __jb.arrayFrom(this.options).forEach(function (o, j) { o._selected = j === Number(i); }); __jb.markDirty(this); }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "elements", { get: function () { var self_ = this; var cached = __jb.elementsCols.get(this); if (cached) return cached; var col = __jb.makeCollection(HTMLFormControlsCollection.prototype, function () { if (self_._tag !== "form" && self_._tag !== "fieldset") return []; var root = self_.getRootNode(); return __jb.descendants(root, function (n) { return n.nodeType === 1 && (/^(input|select|textarea|button|fieldset|output|object)$/.test(n._tag) || (__jb.isFACE && __jb.isFACE(n))) && !(n._tag === "input" && __jb.inputType(n) === "image") && (self_._tag === "fieldset" ? self_.contains(n) : __jb.formOwner(n) === self_); }); }, true, true); __jb.elementsCols.set(this, col); return col; }, configurable: true });
__jb.elementsCols = new WeakMap();
__jb.formElementsGetter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "elements").get; // captured before the IDL shape moves it
// HTMLScriptElement.supports(type)
if (__jb.htmlClasses.HTMLScriptElement) Object.defineProperty(__jb.htmlClasses.HTMLScriptElement, "supports", {
  value: function supports(type) { if (arguments.length < 1) throw new TypeError("supports: 1 argument required"); return ["classic", "module", "importmap", "speculationrules"].indexOf(String(type)) >= 0; },
  writable: true, enumerable: true, configurable: true,
});
// <template> declarative shadow root attributes.
if (__jb.htmlClasses.HTMLTemplateElement) (function (P) {
  var en = function (prop, attr, keywords, missing, invalid) {
    Object.defineProperty(P, prop, { get: { [prop]: function () { var v = this.getAttribute(attr); if (v === null) return missing; v = v.toLowerCase(); return keywords.indexOf(v) >= 0 ? v : invalid; } }[prop], set: { [prop]: function (v) { this.setAttribute(attr, String(v)); } }[prop], enumerable: true, configurable: true });
  };
  var bool = function (prop, attr) {
    Object.defineProperty(P, prop, { get: { [prop]: function () { return this.hasAttribute(attr); } }[prop], set: { [prop]: function (v) { if (v) this.setAttribute(attr, ""); else this.removeAttribute(attr); } }[prop], enumerable: true, configurable: true });
  };
  en("shadowRootMode", "shadowrootmode", ["open", "closed"], "", "");
  en("shadowRootSlotAssignment", "shadowrootslotassignment", ["named", "manual"], "named", "named");
  bool("shadowRootDelegatesFocus", "shadowrootdelegatesfocus");
  bool("shadowRootClonable", "shadowrootclonable");
  bool("shadowRootSerializable", "shadowrootserializable");
})(__jb.htmlClasses.HTMLTemplateElement.prototype);
// fieldset.elements: an HTMLCollection of the listed elements among its descendants (image buttons included).
if (__jb.htmlClasses.HTMLFieldSetElement) {
  Object.defineProperty(__jb.htmlClasses.HTMLFieldSetElement.prototype, "elements", { get: function elements() {
    var self_ = this, cached = __jb.elementsCols.get(this); if (cached) return cached;
    var col = __jb.liveCollection(function () { return __jb.descendants(self_, function (n) { return n.nodeType === 1 && n._ns === __jb.HTML_NS && (/^(input|select|textarea|button|fieldset|output|object)$/.test(n._tag) || !!(n.constructor && n.constructor.formAssociated)); }); });
    __jb.elementsCols.set(this, col); return col;
  }, enumerable: true, configurable: true });
  Object.defineProperty(__jb.htmlClasses.HTMLFieldSetElement.prototype, "type", { get: function type() { return "fieldset"; }, enumerable: true, configurable: true });
}
__jb.formElementsOf = function (form) { return __jb.formElementsGetter.call(form); };
// Names the environment itself reads on forms; controls with these names do not shadow them.
__jb.FORM_INTERNAL_NAMES = { nodeType: 1, nodeName: 1, ownerDocument: 1, parentNode: 1, firstChild: 1, lastChild: 1, nextSibling: 1, previousSibling: 1, localName: 1, namespaceURI: 1, tagName: 1, getAttribute: 1, hasAttribute: 1, getRootNode: 1, isConnected: 1, contains: 1, closest: 1, elements: 1, length: 1, constructor: 1, then: 1 };
Object.defineProperty(HTMLElement.prototype, "length", { get: function () { return this._tag === "form" ? this.elements.length : this._tag === "select" ? this.options.length : undefined; }, configurable: true });
// Labelable elements and the label/control association (HTML "labeled control").
__jb.isLabelable = function (n) { return !!n && n.nodeType === 1 && n._ns === __jb.HTML_NS && /^(button|input|meter|output|progress|select|textarea)$/.test(n._tag) && !(n._tag === "input" && __jb.inputType(n) === "hidden"); };
// Per tree root and DOM version: first element (tree order) per id, and the root's <label>s.
__jb.labelIndexes = new WeakMap();
__jb.labelIndex = function (root) {
  var ix = __jb.labelIndexes.get(root);
  if (ix && ix.ver === __jb.domVersion) return ix;
  ix = { ver: __jb.domVersion, ids: new Map(), labels: [] };
  var all = __jb.descendants(root, function (n) { return n.nodeType === 1; });
  for (var i = 0; i < all.length; i++) {
    var n = all[i], id = n.getAttribute("id");
    if (id !== null && id !== "" && !ix.ids.has(id)) ix.ids.set(id, n);
    if (n._tag === "label" && n._ns === __jb.HTML_NS) ix.labels.push(n);
  }
  __jb.labelIndexes.set(root, ix);
  return ix;
};
__jb.labeledControl = function (label) {
  var f = label.getAttribute("for");
  if (f !== null) {
    if (f === "") return null;
    var n = __jb.labelIndex(label.getRootNode()).ids.get(f);
    return n && __jb.isLabelable(n) ? n : null;
  }
  return __jb.descendants(label, __jb.isLabelable)[0] || null;
};
// labels: one live NodeList per element of the labels (in its tree) whose labeled control it is.
__jb.labelsLists = new WeakMap();
Object.defineProperty(HTMLElement.prototype, "labels", { get: function () {
  var self_ = this; if (!__jb.isLabelable(this)) return null;
  var list = __jb.labelsLists.get(this);
  if (!list) {
    var isMine = function (l) { return l.nodeType === 1 && l._tag === "label" && l._ns === __jb.HTML_NS && __jb.labeledControl(l) === self_; };
    list = __jb.liveNodeList(function () { var root = self_.getRootNode(), out = __jb.labelIndex(root).labels.filter(isMine); if (isMine(root)) out.unshift(root); return out; });
    __jb.labelsLists.set(this, list);
  }
  return list;
}, configurable: true });
Object.defineProperty(HTMLElement.prototype, "control", { get: function () { if (this._tag !== "label") return undefined; return __jb.labeledControl(this); }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "htmlFor", { get: function () { return this.getAttribute("for") || ""; }, set: function (v) { this.setAttribute("for", v); }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "files", { get: function () { return this._files || []; }, set: function (v) { this._files = v; }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "valueAsNumber", { get: function () { var n = parseFloat(this.value); return isNaN(n) ? NaN : n; }, set: function (v) { this.value = String(v); }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "validity", { get: function () { return { valid: true, valueMissing: false, typeMismatch: false, patternMismatch: false, tooLong: false, tooShort: false, rangeUnderflow: false, rangeOverflow: false, stepMismatch: false, badInput: false, customError: false }; }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "validationMessage", { get: function () { return ""; }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "willValidate", { get: function () { return /^(input|select|textarea|button|output|object|fieldset)$/.test(this._tag); }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "selectionStart", { get: function () { return this._selStart !== undefined ? this._selStart : (this.value || "").length; }, set: function (v) { this._selStart = v; }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "selectionEnd", { get: function () { return this._selEnd !== undefined ? this._selEnd : (this.value || "").length; }, set: function (v) { this._selEnd = v; }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "selectionDirection", { get: function () { return "none"; }, set: function () {}, configurable: true });
Object.defineProperty(HTMLElement.prototype, "complete", { get: function () { return true; }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "naturalWidth", { get: function () { return 0; }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "naturalHeight", { get: function () { return 0; }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "currentSrc", { get: function () { return this.src; }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "sheet", { get: function () { return this._tag === "style" || this._tag === "link" ? new CSSStyleSheet(this.textContent) : null; }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "content", { get: function () { if (this._tag !== "template") return this.getAttribute("content") || ""; if (!this._content) { var inert = __jb.templateDocument(this.ownerDocument); this._content = inert.createDocumentFragment(); this._content._templateHost = this; while (this.firstChild) { var c = this.firstChild; this._removeChildRaw(c); this._content._appendChildRaw(c); } } return this._content; }, set: function (v) { this.setAttribute("content", v); }, configurable: true });
__jb.templateDocument = function (doc) { if (!doc) return __jb.currentDocument; if (doc._templateDoc) return doc._templateDoc; if (doc._isTemplateDoc) return doc; var d = new Document(); d._isHTML = doc._isHTML; d._isTemplateDoc = true; d._templateDoc = d; doc._templateDoc = d; return d; };
["protocol", "host", "hostname", "port", "pathname", "search", "hash", "username", "password", "origin"].forEach(function (comp) {
  Object.defineProperty(HTMLElement.prototype, comp, {
    get: function () {
      var href = this.getAttribute("href");
      if (href === null || !/^(a|area)$/.test(this._tag) && !this.hasAttribute("href")) { return comp === "protocol" ? ":" : ""; }
      var url = __jb.tryURL(href, this);
      if (!url) return comp === "protocol" ? ":" : comp === "origin" ? "null" : "";
      return url[comp];
    },
    set: function (v) {
      var href = this.getAttribute("href");
      if (href === null) return;
      var url = __jb.tryURL(href, this);
      if (!url || comp === "origin") return;
      var self_ = this;
      __jb.withUrlEncoding(this.ownerDocument && this.ownerDocument._characterSet, function () { url[comp] = v; });
      this.setAttribute("href", url.href);
    },
    configurable: true,
  });
});
__jb.tryURL = function (href, ctx) { try { var doc = (ctx && ctx.ownerDocument) || __jb.currentDocument; return __jb.withUrlEncoding(doc._characterSet, function () { var baseEl = __jb.docBaseEl(doc); var base = baseEl ? new URL(baseEl.getAttribute("href"), doc.URL).href : doc.URL; if (baseEl && typeof __jb.baseAllowed === "function" && !__jb.baseAllowed(baseEl, base)) base = doc.URL; return new URL(String(href), base); }); } catch (e) { return null; } };
__jb.defineOnInterfaces = function (names, prop, desc) { names.forEach(function (n) { var C = __jb.htmlClasses[n]; if (C) Object.defineProperty(C.prototype, prop, desc); }); };
__jb.defineOnInterfaces(["HTMLAnchorElement", "HTMLAreaElement", "HTMLLinkElement", "HTMLFormElement"], "relList", { get: function () { if (!Object.prototype.hasOwnProperty.call(this, "_relList")) Object.defineProperty(this, "_relList", { value: __jb.tokenListProxy(new DOMTokenList(this, "rel", this._tag === "link" ? ["stylesheet", "icon", "preload", "prefetch", "preconnect", "dns-prefetch", "modulepreload", "manifest", "alternate", "canonical", "author", "help", "license", "next", "prev", "search"] : ["noreferrer", "noopener", "opener"])), enumerable: false }); return this._relList; }, configurable: true });
__jb.defineOnInterfaces(["HTMLIFrameElement"], "sandbox", { get: function () { if (!Object.prototype.hasOwnProperty.call(this, "_sandbox")) Object.defineProperty(this, "_sandbox", { value: __jb.tokenListProxy(new DOMTokenList(this, "sandbox", ["allow-forms", "allow-scripts", "allow-same-origin", "allow-popups", "allow-modals", "allow-downloads", "allow-top-navigation", "allow-storage-access-by-user-activation", "allow-popups-to-escape-sandbox", "allow-top-navigation-by-user-activation", "allow-pointer-lock", "allow-orientation-lock", "allow-presentation", "allow-top-navigation-to-custom-protocols"])), enumerable: false }); return this._sandbox; }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "rows", { get: function () { if (this._tag === "table" || this._tag === "tbody" || this._tag === "thead" || this._tag === "tfoot") { var self_ = this; return __jb.liveCollection(function () { if (self_._tag !== "table") return __jb.arrayFrom(self_.children).filter(function (c) { return c._tag === "tr"; }); var out = [], sections = { thead: [], tbody: [], tfoot: [] }; for (var c = self_.firstChild; c; c = c.nextSibling) { if (c.nodeType !== 1) continue; if (c._tag === "tr") sections.tbody.push(c); else if (sections[c._tag]) for (var r = c.firstChild; r; r = r.nextSibling) if (r.nodeType === 1 && r._tag === "tr") sections[c._tag].push(r); } return out.concat(sections.thead, sections.tbody, sections.tfoot); }); } var r = this.getAttribute("rows"); return r === null ? 2 : parseInt(r, 10) || 2; }, set: function (v) { this.setAttribute("rows", v); }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "cells", { get: function () { var self_ = this; return __jb.liveCollection(function () { return __jb.arrayFrom(self_.children).filter(function (c) { return c._tag === "td" || c._tag === "th"; }); }); }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "tBodies", { get: function () { var self_ = this; return __jb.liveCollection(function () { return __jb.arrayFrom(self_.children).filter(function (c) { return c._tag === "tbody"; }); }); }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "rowIndex", { get: function () { var t = this.closest("table"); if (!t) return -1; return __jb.arrayFrom(t.rows).indexOf(this); }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "sectionRowIndex", { get: function () { var p = this.parentNode; if (!p) return -1; return __jb.arrayFrom(p.children).filter(function (c) { return c._tag === "tr"; }).indexOf(this); }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "cellIndex", { get: function () { var p = this.parentNode; if (!p || p._tag !== "tr") return -1; return __jb.arrayFrom(p.cells).indexOf(this); }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "index", { get: function () { if (this._tag !== "option") return undefined; var s = this.closest("select"); return s ? __jb.arrayFrom(s.options).indexOf(this) : 0; }, configurable: true });
HTMLElement.prototype.submit = function () { if (this._tag === "form") __jb.formSubmitted(this); };
HTMLElement.prototype.requestSubmit = function (submitter) { if (this._tag === "form") { if (submitter !== undefined && submitter !== null) { if (!(submitter instanceof HTMLElement) || !/^(button|input)$/.test(submitter._tag) || (submitter._tag === "input" && !/^(submit|image)$/.test(__jb.inputType(submitter))) || (submitter._tag === "button" && submitter.type !== "submit")) throw new TypeError("requestSubmit: submitter is not a submit button"); if (__jb.formOwner(submitter) !== this) throw __jb.domError("NotFoundError", "submitter is not owned by this form"); } __jb.submitForm(this, submitter || null); } };
HTMLElement.prototype.reset = function () { if (this._tag === "form") { __jb.arrayFrom(this.elements).forEach(function (e) { e._valueOverride = undefined; e._checked = undefined; if (e._tag === "select" && __jb.selectFormReset) __jb.selectFormReset(e); }); this.dispatchEvent(new Event("reset", { bubbles: true, cancelable: true })); __jb.markDirty(this); } };
HTMLElement.prototype.checkValidity = function () { return true; };
HTMLElement.prototype.reportValidity = function () { return true; };
HTMLElement.prototype.setCustomValidity = function () {};
HTMLElement.prototype.select = function () {};
HTMLElement.prototype.setSelectionRange = function (s, e) { this._selStart = s; this._selEnd = e; };
HTMLElement.prototype.setRangeText = function (t) { this.value = t; };
HTMLElement.prototype.stepUp = function () {}; HTMLElement.prototype.stepDown = function () {};
HTMLElement.prototype.showPicker = function () {};
HTMLElement.prototype.add = function (opt, before) { if (this._tag === "select" || this._tag === "optgroup") { if (typeof before === "number") before = this.options[before] || null; __jb.preInsert(this, opt, before || null); } };
HTMLElement.prototype.item = function (i) { return this._tag === "select" ? this.options[i] || null : this._tag === "form" ? this.elements[i] || null : null; };
HTMLElement.prototype.namedItem = function (n) { return this._tag === "select" ? this.options.namedItem(n) : this._tag === "form" ? this.elements.namedItem(n) : null; };
HTMLElement.prototype.insertRow = function (i) { if (i === undefined) i = -1; var rows = this._tag === "table" ? __jb.arrayFrom(this.rows) : __jb.arrayFrom(this.children).filter(function (c) { return c._tag === "tr"; }); if (i < -1 || i > rows.length) throw __jb.domError("IndexSizeError", "index out of range"); var tr = this.ownerDocument.createElement("tr"); if (this._tag === "table") { if (rows.length === 0) { var tb = this.tBodies[this.tBodies.length - 1]; if (!tb) { tb = this.ownerDocument.createElement("tbody"); this.appendChild(tb); } tb.appendChild(tr); } else if (i === -1 || i === rows.length) rows[rows.length - 1].parentNode.appendChild(tr); else rows[i].parentNode.insertBefore(tr, rows[i]); } else { if (i === -1 || i === rows.length) this.appendChild(tr); else this.insertBefore(tr, rows[i]); } return tr; };
HTMLElement.prototype.deleteRow = function (i) { var rows = this._tag === "table" ? __jb.arrayFrom(this.rows) : __jb.arrayFrom(this.children).filter(function (c) { return c._tag === "tr"; }); if (i === -1) i = rows.length - 1; if (i < 0 || i >= rows.length) { if (i === -1 && rows.length === 0) return; throw __jb.domError("IndexSizeError", "index out of range"); } rows[i].remove(); };
HTMLElement.prototype.insertCell = function (i) { if (i === undefined) i = -1; var cells = __jb.arrayFrom(this.cells); if (i < -1 || i > cells.length) throw __jb.domError("IndexSizeError", "index out of range"); var td = this.ownerDocument.createElement("td"); if (i === -1 || i === cells.length) this.appendChild(td); else this.insertBefore(td, cells[i]); return td; };
HTMLElement.prototype.deleteCell = function (i) { var cells = __jb.arrayFrom(this.cells); if (i === -1) i = cells.length - 1; if (i < 0 || i >= cells.length) { if (i === -1 && cells.length === 0) return; throw __jb.domError("IndexSizeError", "index out of range"); } cells[i].remove(); };
HTMLElement.prototype.createTBody = function () { var t = this.ownerDocument.createElement("tbody"); var last = this.tBodies[this.tBodies.length - 1]; this.insertBefore(t, last ? last.nextSibling : null); return t; };
HTMLElement.prototype.createCaption = function () { var c = this.querySelector(":scope > caption"); if (!c) { c = this.ownerDocument.createElement("caption"); this.insertBefore(c, this.firstChild); } return c; };
HTMLElement.prototype.deleteCaption = function () { var c = this.querySelector(":scope > caption"); if (c) c.remove(); };
HTMLElement.prototype.createTHead = function () { var h = this.querySelector(":scope > thead"); if (!h) { h = this.ownerDocument.createElement("thead"); var ref = null; for (var c = this.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c._tag !== "caption" && c._tag !== "colgroup") { ref = c; break; } this.insertBefore(h, ref); } return h; };
HTMLElement.prototype.deleteTHead = function () { var h = this.querySelector(":scope > thead"); if (h) h.remove(); };
HTMLElement.prototype.createTFoot = function () { var f = this.querySelector(":scope > tfoot"); if (!f) { f = this.ownerDocument.createElement("tfoot"); this.appendChild(f); } return f; };
HTMLElement.prototype.deleteTFoot = function () { var f = this.querySelector(":scope > tfoot"); if (f) f.remove(); };
Object.defineProperty(HTMLElement.prototype, "caption", { get: function () { return this.querySelector(":scope > caption"); }, set: function (v) { this.deleteCaption(); if (v) this.insertBefore(v, this.firstChild); }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "tHead", { get: function () { return this.querySelector(":scope > thead"); }, set: function (v) { if (v !== null && (!(v instanceof HTMLElement) || v._tag !== "thead")) throw __jb.domError("HierarchyRequestError", "not a thead"); this.deleteTHead(); if (v) { var ref = null; for (var c = this.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c._tag !== "caption" && c._tag !== "colgroup") { ref = c; break; } this.insertBefore(v, ref); } }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "tFoot", { get: function () { return this.querySelector(":scope > tfoot"); }, set: function (v) { if (v !== null && (!(v instanceof HTMLElement) || v._tag !== "tfoot")) throw __jb.domError("HierarchyRequestError", "not a tfoot"); this.deleteTFoot(); if (v) this.appendChild(v); }, configurable: true });
HTMLElement.prototype.getContext = function (type) { return this._tag === "canvas" ? __jb.canvasContext(this, type) : null; };
HTMLElement.prototype.toDataURL = function () { return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="; };
HTMLElement.prototype.toBlob = function (cb) { cb(new Blob([""], { type: "image/png" })); };
HTMLElement.prototype.captureStream = function () { return { getTracks: function () { return []; } }; };
HTMLElement.prototype.play = function () { return Promise.resolve(); }; HTMLElement.prototype.pause = function () {}; HTMLElement.prototype.load = function () {}; HTMLElement.prototype.canPlayType = function () { return ""; };
HTMLElement.prototype.decode = function () { return Promise.resolve(); };
HTMLElement.prototype.show = function () { if (this._tag === "dialog") { if (this.hasAttribute("open")) return; this.setAttribute("open", ""); } };
HTMLElement.prototype.showModal = function () { if (this._tag === "dialog") { if (this.hasAttribute("open")) throw __jb.domError("InvalidStateError", "dialog already open"); if (!this.isConnected) throw __jb.domError("InvalidStateError", "dialog not connected"); this.setAttribute("open", ""); } };
HTMLElement.prototype.close = function (rv) { if (this._tag === "dialog") { if (!this.hasAttribute("open")) return; this.removeAttribute("open"); if (rv !== undefined) this.returnValue = String(rv); var self_ = this; setTimeout(function () { self_.dispatchEvent(new Event("close")); }, 0); } };
HTMLElement.prototype.requestClose = function (rv) { this.close(rv); };

var Image = function Image(w, h) { if (!new.target) throw new TypeError("Illegal constructor"); var el = __jb.currentDocument.createElement("img"); if (w !== undefined) el.setAttribute("width", String(w)); if (h !== undefined) el.setAttribute("height", String(h)); return el; };
Image.prototype = __jb.htmlClasses.HTMLImageElement.prototype;
var Audio = function Audio(src) { if (!new.target) throw new TypeError("Illegal constructor"); var el = __jb.currentDocument.createElement("audio"); el.setAttribute("preload", "auto"); if (src !== undefined) el.setAttribute("src", String(src)); return el; };
Audio.prototype = __jb.htmlClasses.HTMLAudioElement.prototype;
var Option = function Option(text, value, defaultSelected, selected) { if (!new.target) throw new TypeError("Illegal constructor"); var el = __jb.currentDocument.createElement("option"); if (text !== undefined && String(text) !== "") el.textContent = String(text); if (value !== undefined) el.setAttribute("value", String(value)); if (defaultSelected) el.setAttribute("selected", ""); el._sel = !!selected; return el; };
Option.prototype = __jb.htmlClasses.HTMLOptionElement.prototype;

// Resolve a URL against the document base.
__jb.resolveURL = function (href, ctx) {
  try {
    var doc = (ctx && ctx.ownerDocument) || __jb.currentDocument;
    return __jb.withUrlEncoding(ctx && ctx.nodeType === 1 && (ctx._tag === "a" || ctx._tag === "area") ? doc._characterSet : null, function () {
      var baseEl = __jb.docBaseEl(doc);
      var base = baseEl ? new URL(baseEl.getAttribute("href"), doc.URL).href : doc.URL;
      if (baseEl && typeof __jb.baseAllowed === "function" && !__jb.baseAllowed(baseEl, base)) base = doc.URL;
      return new URL(String(href), base).href;
    });
  } catch (e) { return String(href); }
};
// Encoding used to submit a form: the first supported label in accept-charset,
// else the document's encoding.
__jb.formEncoding = function (form) {
  var ac = form.getAttribute("accept-charset");
  if (ac !== null) { var labels = ac.split(/[\t\n\f\r ]+/).filter(Boolean); for (var i = 0; i < labels.length; i++) { var name = __jb.canonicalEncoding(labels[i]); if (name) return name; } return "UTF-8"; }
  return (form.ownerDocument && form.ownerDocument._characterSet) || "UTF-8";
};
// Percent-encode a form value for application/x-www-form-urlencoded in `encoding`.
__jb.formEncodeIn = function (s, encoding) {
  if (!encoding || /^utf-8$/i.test(encoding)) return __jb.formEncode(s);
  var r = __jb.native("encoding", { op: "encode", label: encoding, text: String(s) });
  var bytes = r && r.bytes ? __jb.b64ToBytes(r.bytes) : __utf8Encode(String(s));
  var out = "";
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    if (b === 0x20) out += "+";
    else if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2a || b === 0x2d || b === 0x2e || b === 0x5f) out += String.fromCharCode(b);
    else out += "%" + (b < 16 ? "0" : "") + b.toString(16).toUpperCase();
  }
  return out;
};
__jb.formSubmitted = function (form, submitter) {
  var data = __jb.formDataOf(form);
  var method = form.method, action = form.action;
  __jb.formSubmissions.push({ action: action, method: method, data: data });
  __jb.formSubmittedInTask = true; setTimeout(function () { __jb.formSubmittedInTask = false; }, 0);
  console.log("Form submitted via JavaScript: " + method.toUpperCase() + " " + action);
  // Submissions targeting a nested browsing context navigate that frame.
  var target = (submitter && submitter.getAttribute && submitter.getAttribute("formtarget")) || form.getAttribute("target");
  if (target && typeof __jb.loadFrame === "function" && method !== "dialog") {
    var frame = __jb.descendants(form.ownerDocument, function (n) { return n.nodeType === 1 && n._ns === __jb.HTML_NS && n._tag === "iframe" && (n.getAttribute("name") === target || n.getAttribute("id") === target); })[0];
    if (frame) {
      var enc = __jb.formEncoding(form);
      var query = Object.keys(data).map(function (k) { return __jb.formEncodeIn(k, enc) + "=" + __jb.formEncodeIn(data[k], enc); }).join("&");
      var url;
      try { url = new URL(action); } catch (e) { return; }
      if (method === "get") { url.search = query; }
      __jb.loadFrame(frame, url.href);
    }
  }
};
__jb.formSubmissions = [];
__jb.formDataOf = function (form) { var out = {}; __jb.arrayFrom(form.elements).forEach(function (e) { var n = e.getAttribute("name"); if (!n || e.disabled) return; var t = e.type; if ((t === "checkbox" || t === "radio") && !e.checked) return; if (t === "submit" || t === "button" || t === "image" || t === "reset" || t === "file" || e._tag === "fieldset" || e._tag === "object" || e._tag === "output") return; out[n] = e.value; }); return out; };

Object.assign(globalThis, { Node, NodeList, HTMLCollection, CharacterData, Text, CDATASection, Comment, ProcessingInstruction, DocumentFragment, ShadowRoot, DocumentType, CSSStyleDeclaration, DOMTokenList, NamedNodeMap, Attr, Element, HTMLElement, HTMLUnknownElement, SVGElement, MathMLElement, MutationObserver, MutationRecord, Image, Audio, Option });
// GlobalEventHandlers is included by HTMLElement, SVGElement and MathMLElement (not Element).
__jb.defineEventHandlerProps(HTMLElement.prototype, __jb.EVENT_HANDLER_NAMES);
__jb.defineEventHandlerProps(SVGElement.prototype, __jb.EVENT_HANDLER_NAMES);
if (typeof MathMLElement === "function") __jb.defineEventHandlerProps(MathMLElement.prototype, __jb.EVENT_HANDLER_NAMES);
Object.assign(globalThis, __jb.htmlClasses);
globalThis.HTMLFormControlsCollection = HTMLFormControlsCollection; globalThis.RadioNodeList = RadioNodeList;
Object.assign(globalThis, __jb.svgClasses);

// ---- innerText: HTML "inner text collection steps" over a minimal style
// model (inline style attributes plus per-element defaults) ----
__jb.BLOCK_TAGS = /^(address|article|aside|blockquote|body|center|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frameset|h[1-6]|header|hgroup|hr|html|legend|li|listing|main|menu|nav|ol|optgroup|option|p|plaintext|pre|search|section|summary|ul|xmp)$/;
__jb.NONE_TAGS = /^(area|base|basefont|datalist|head|link|meta|noembed|noframes|param|rp|script|style|template|title|noscript)$/;
__jb.ATOMIC_TAGS = /^(input|img|button|textarea|meter|progress|video|audio|iframe|embed|object|canvas)$/;
// Replaced elements and frames: their children are fallback content.
__jb.REPLACED_TAGS = /^(input|img|textarea|video|audio|iframe|embed|object|canvas|frame)$/;
__jb.SVG_UNRENDERED = /^(defs|clipPath|mask|pattern|symbol|marker|metadata|title|desc|style|script|linearGradient|radialGradient|stop|filter)$/;
__jb.styleOf = function (el, prop) {
  var v = "";
  if (el.hasAttribute("style")) {
    if (!el._style) { var st = el.style; if (!st) return ""; }
    v = el._style ? el._style.getPropertyValue(prop) : "";
  }
  if (!v) v = __jb.authorStyle(el, prop);
  return (v || "").trim().toLowerCase();
};
// Value of `prop` for `el` from the document's <style> sheets (last matching
// rule wins; only the properties innerText looks at are indexed).
__jb.LAYOUT_PROPS = /\b(display|white-space|visibility|text-transform|overflow|overflow-x|overflow-y|position|float|opacity|scroll-snap-type|scroll-snap-align|scroll-margin(?:-[a-z]+)*|scroll-padding(?:-[a-z]+)*)\s*:/;
// Split a selector list at top-level commas (not inside :is()/:not() or attribute selectors).
__jb.splitSelectorList = function (text) {
  var out = [], depth = 0, quote = "", cur = "";
  for (var i = 0; i < text.length; i++) {
    var c = text.charAt(i);
    if (quote) { if (c === "\\") { cur += c + text.charAt(++i); continue; } if (c === quote) quote = ""; cur += c; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
// Bucket key of a selector's rightmost compound: "#id", ".class", "tag" or "*" (anything else).
__jb.selectorKey = function (sel) {
  var depth = 0, quote = "", start = 0;
  for (var i = 0; i < sel.length; i++) {
    var c = sel.charAt(i);
    if (quote) { if (c === "\\") { i++; continue; } if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && (c === " " || c === ">" || c === "+" || c === "~")) start = i + 1;
  }
  var last = sel.slice(start).trim(), m;
  // only the parts outside brackets/parens can name the element itself
  var bare = last.replace(/\[[^\]]*\]|\([^)]*\)/g, "");
  if ((m = /#(-?[_a-zA-Z\u00a0-\uffff][-_a-zA-Z0-9\u00a0-\uffff]*)/.exec(bare)) && bare.indexOf("\\") < 0) return "#" + m[1];
  if ((m = /\.(-?[_a-zA-Z\u00a0-\uffff][-_a-zA-Z0-9\u00a0-\uffff]*)/.exec(bare)) && bare.indexOf("\\") < 0) return "." + m[1];
  if ((m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(bare))) return m[1].toLowerCase();
  return "*";
};
// Top-level style rules of a <style> element as { selectorText, props: [[name, value]...] },
// parsed once per text: pages that mutate the DOM while reading styles (React hydration) would
// otherwise re-parse every sheet after each change.
__jb.styleElementRules = function (st) {
  var text = st.textContent, c = st._jbRules;
  if (c && c.text === text) return c.rules;
  var rules = [];
  try {
    new CSSStyleSheet(text).cssRules.forEach(function (r) {
      if (r.type === 1) rules.push({ selectorText: r.selectorText, props: r.style._props.map(function (p) { return [p[0], p[1]]; }) });
    });
  } catch (e) {}
  Object.defineProperty(st, "_jbRules", { value: { text: text, rules: rules }, writable: true, configurable: true });
  return rules;
};
// The <style> elements of `doc` with their parsed rules, recomputed once per DOM version; `same`
// says whether the rule lists are the ones of the previous version (indexes can be reused).
__jb.styleRuleLists = function (doc, htmlOnly) {
  var key = htmlOnly ? "_jbStyleListsHtml" : "_jbStyleLists", prev = doc[key];
  if (prev && prev.version === __jb.domVersion) return prev;
  var lists = __jb.descendants(doc, function (n) { return n.nodeType === 1 && n._tag === "style" && (!htmlOnly || n._ns === __jb.HTML_NS); }).map(function (st) { return __jb.styleElementRules(st); });
  var same = !!prev && prev.lists.length === lists.length && lists.every(function (l, i) { return l === prev.lists[i]; });
  var out = { version: __jb.domVersion, lists: lists, same: same, gen: same ? prev.gen : (prev ? prev.gen + 1 : 1) };
  Object.defineProperty(doc, key, { value: out, writable: true, configurable: true });
  return out;
};
__jb.layoutRulesOf = function (doc) {
  var cache = doc._layoutRules;
  if (cache && cache.version === __jb.domVersion) return cache;
  var sl = __jb.styleRuleLists(doc, true);
  if (cache && cache.gen === sl.gen) { cache.version = __jb.domVersion; return cache; }
  var rules = [], buckets = Object.create(null);
  sl.lists.forEach(function (list) {
    try {
      list.forEach(function (r) {
        if (r.selectorText.charAt(0) === "@" || /::|:(before|after|first-line|first-letter)\b/.test(r.selectorText)) return;
        var props = {}, any = false;
        r.props.forEach(function (p) { if (/^(display|white-space|visibility|text-transform|overflow|overflow-x|overflow-y|position|float|opacity|scroll-snap-type|scroll-snap-align|scroll-margin(-[a-z]+)*|scroll-padding(-[a-z]+)*)$/.test(p[0])) { props[p[0]] = p[1]; any = true; } });
        if (!any) return;
        __jb.splitSelectorList(r.selectorText).forEach(function (sel) {
          var entry = { sel: sel, props: props, order: rules.length };
          rules.push(entry);
          var key = __jb.selectorKey(sel);
          (buckets[key] || (buckets[key] = [])).push(entry);
        });
      });
    } catch (e) {}
  });
  return (doc._layoutRules = { version: __jb.domVersion, gen: sl.gen, rules: rules, buckets: buckets });
};
// Rules of the document's <style> sheets for the script-side getComputedStyle cascade, bucketed by
// the key of each selector's rightmost compound (pseudo-classes/elements stripped, as before).
__jb.gcsRulesOf = function (doc) {
  var sl = __jb.styleRuleLists(doc, false), cache = doc._jbGcsRules;
  if (cache && cache.gen === sl.gen) return cache;
  var buckets = Object.create(null), order = 0;
  sl.lists.forEach(function (list) {
    list.forEach(function (r) {
      if (r.selectorText.indexOf("@") >= 0) return;
      var rule = { order: order++, sel: r.selectorText.replace(/::?[a-z-]+(\([^)]*\))?/g, "").trim() || "*", props: r.props };
      __jb.splitSelectorList(rule.sel).forEach(function (one) {
        var k = __jb.selectorKey(one);
        (buckets[k] || (buckets[k] = [])).push({ rule: rule, sel: one });
      });
    });
  });
  cache = { gen: sl.gen, buckets: buckets };
  Object.defineProperty(doc, "_jbGcsRules", { value: cache, writable: true, configurable: true });
  return cache;
};
// The <style> rules matching `el` in document order (each rule once).
__jb.gcsMatchingRules = function (el) {
  var doc = el.ownerDocument;
  if (!doc) return [];
  var b = __jb.gcsRulesOf(doc).buckets, cands = [], list;
  if ((list = b["*"])) cands = cands.concat(list);
  if ((list = b[el.localName.toLowerCase()])) cands = cands.concat(list);
  var id = el.getAttribute("id");
  if (id && (list = b["#" + id])) cands = cands.concat(list);
  var cls = el.getAttribute("class");
  if (cls) cls.split(/[\t\n\f\r ]+/).forEach(function (c) { if (c && (list = b["." + c])) cands = cands.concat(list); });
  cands.sort(function (x, y) { return x.rule.order - y.rule.order; });
  var out = [];
  for (var i = 0; i < cands.length; i++) {
    var e = cands[i];
    if (out.length && out[out.length - 1] === e.rule) continue;
    try { if (el.matches(e.sel)) out.push(e.rule); } catch (err) {}
  }
  return out;
};
// The indexed properties the document's <style> rules give `el` (last matching rule wins).
__jb.authorStyles = function (el) {
  var doc = el.ownerDocument;
  if (!doc || !el.isConnected) return null;
  var cache = __jb.layoutRulesOf(doc);
  if (el._authorStyles && el._authorStyles.version === cache.version && el._authorStyles.rules === cache) return el._authorStyles.props;
  var cands = [], b = cache.buckets, list;
  if ((list = b["*"])) cands = cands.concat(list);
  if ((list = b[el.localName.toLowerCase()])) cands = cands.concat(list);
  var id = el.getAttribute("id");
  if (id && (list = b["#" + id])) cands = cands.concat(list);
  var cls = el.getAttribute("class");
  if (cls) cls.split(/[\t\n\f\r ]+/).forEach(function (c) { if (c && (list = b["." + c])) cands = cands.concat(list); });
  cands.sort(function (x, y) { return x.order - y.order; });
  var props = {};
  for (var i = 0; i < cands.length; i++) {
    var r = cands[i];
    if (i > 0 && cands[i - 1] === r) continue; // one entry can sit in two buckets? (not today; cheap guard)
    try { if (el.matches(r.sel)) for (var k in r.props) props[k] = r.props[k]; } catch (e) {}
  }
  el._authorStyles = { version: cache.version, rules: cache, props: props };
  return props;
};
__jb.authorStyle = function (el, prop) {
  var props = __jb.authorStyles(el);
  return props && props[prop] !== undefined ? props[prop] : "";
};
__jb.displayOf = function (el) {
  if (el._ns !== __jb.HTML_NS) return __jb.styleOf(el, "display") || "inline";
  var t = el._tag;
  if (t === "noscript") return "none"; // display:none !important in the UA sheet
  var d = __jb.styleOf(el, "display");
  if (d) return d;
  if (el.hasAttribute("popover") && el._popoverState !== "showing") return "none"; // UA sheet: [popover]:not(:popover-open) { display: none }
  if (el.hasAttribute("hidden") && !el.hasAttribute("popover")) return "none";
  if (el._tag === "dialog" && !el.hasAttribute("open") && el._popoverState !== "showing") return "none";
  if (__jb.NONE_TAGS.test(t)) return "none";
  if (t === "table") return "table";
  if (t === "tr") return "table-row";
  if (t === "td" || t === "th") return "table-cell";
  if (t === "caption") return "table-caption";
  if (t === "thead" || t === "tbody" || t === "tfoot") return "table-row-group";
  if (t === "col" || t === "colgroup") return "table-column";
  if (t === "li") return "list-item";
  if (__jb.BLOCK_TAGS.test(t)) return "block";
  if (__jb.ATOMIC_TAGS.test(t)) return "inline-block";
  return "inline";
};
__jb.isBlockLevelDisplay = function (d) { return d === "block" || d === "flex" || d === "grid" || d === "list-item" || d === "table" || d === "flow-root" || d === "table-caption"; };
__jb.whiteSpaceOf = function (el, inherited) {
  var v = __jb.styleOf(el, "white-space");
  if (v && v !== "inherit") return v;
  if (el._ns === __jb.HTML_NS) {
    var t = el._tag;
    if (t === "pre" || t === "listing" || t === "xmp" || t === "plaintext") return "pre";
    if (t === "textarea") return "pre-wrap";
    if (t === "nobr") return "nowrap";
  }
  return inherited;
};
__jb.visibilityOf = function (el, inherited) { var v = __jb.styleOf(el, "visibility"); return v && v !== "inherit" ? v : inherited; };
__jb.textTransformOf = function (el, inherited) { var v = __jb.styleOf(el, "text-transform"); return v && v !== "inherit" ? v : inherited; };
// Rendered: in a document, with no display:none ancestor-or-self.
// Rendered: connected (shadow-including) with no display:none ancestor in the flat tree;
// light children of a shadow host are rendered only when slotted.
__jb.isRendered = function (el) {
  if (__jb.isRenderedJs(el)) return true;
  // Real pages: the script-side cascade sees inline styles and <style> elements only, not linked
  // style sheets (`.x{display:block!important}` over an inline display:none, AccuWeather's search
  // box). When it says hidden, the layout engine (full cascade) has the last word.
  if (__jb.wptMode || !el.isConnected || typeof __jb.layoutRect !== "function" || (__jb.layoutState && __jb.layoutState.available === false)) return false;
  var box = null;
  try { box = __jb.layoutRect(el); } catch (e) { box = null; }
  return !!(box && (box.width > 0 || box.height > 0));
};
__jb.isRenderedJs = function (el) {
  if (!el.isConnected) return false;
  for (var a = el; a; ) {
    if (a.nodeType === 9) return true;
    if (a.nodeType === 11) { if (!a._host) return false; a = a._host; continue; }
    if (a.nodeType !== 1) return false;
    if (__jb.displayOf(a) === "none") return false;
    var p = a.parentNode;
    if (p && p.nodeType === 1 && p._shadowRoot) {
      var slot = typeof __jb.assignedSlotOf === "function" ? __jb.assignedSlotOf(a) : null;
      if (!slot) return false;
      a = slot; continue;
    }
    a = p;
  }
  return false;
};
__jb.innerTextContext = function (el) {
  var chain = [];
  for (var a = el; a && a.nodeType === 1; a = a.parentNode) chain.push(a);
  var ctx = { ws: "normal", vis: "visible", tt: "none", none: false, lang: "" };
  for (var i = chain.length - 1; i >= 0; i--) { ctx.ws = __jb.whiteSpaceOf(chain[i], ctx.ws); ctx.vis = __jb.visibilityOf(chain[i], ctx.vis); ctx.tt = __jb.textTransformOf(chain[i], ctx.tt); if (chain[i].hasAttribute("lang")) ctx.lang = chain[i].getAttribute("lang"); }
  return ctx;
};
__jb.isLastCell = function (cell) {
  for (var s = cell.nextSibling; s; s = s.nextSibling) if (s.nodeType === 1 && __jb.displayOf(s) === "table-cell") return false;
  return true;
};
__jb.isLastRow = function (row) {
  for (var s = row.nextSibling; s; s = s.nextSibling) if (s.nodeType === 1 && __jb.displayOf(s) === "table-row") return false;
  var group = row.parentNode;
  if (group && group.nodeType === 1 && __jb.displayOf(group) === "table-row-group") {
    for (var g = group.nextSibling; g; g = g.nextSibling) {
      if (g.nodeType !== 1) continue;
      var gd = __jb.displayOf(g);
      if (gd === "table-row") return false;
      if (gd === "table-row-group") for (var r = g.firstChild; r; r = r.nextSibling) if (r.nodeType === 1 && __jb.displayOf(r) === "table-row") return false;
    }
  }
  return true;
};
__jb.localeUpper = function (s, lang) { try { return lang ? s.toLocaleUpperCase(lang) : s.toUpperCase(); } catch (e) { return s.toUpperCase(); } };
__jb.localeLower = function (s, lang) { try { return lang ? s.toLocaleLowerCase(lang) : s.toLowerCase(); } catch (e) { return s.toLowerCase(); } };
__jb.innerTextCollect = function (node, ctx, items, top) {
  if (node.nodeType === 3) {
    if (ctx.none || ctx.vis !== "visible" || (ctx.svg && !ctx.svgText) || ctx.inSelect) return;
    var s = node.data;
    // Whitespace directly inside table boxes has no box of its own.
    if (/^(table|inline-table|table-row|table-row-group|table-header-group|table-footer-group|table-column|table-column-group)$/.test(ctx.pdisp) && !/[^\t\n\f\r ]/.test(s)) return;
    if (ctx.tt === "uppercase") s = __jb.localeUpper(s, ctx.lang);
    else if (ctx.tt === "lowercase") s = __jb.localeLower(s, ctx.lang);
    else if (ctx.tt === "capitalize") s = s.replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, function (m, a, b) { return a + b.toUpperCase(); });
    items.push({ t: "text", s: s, ws: ctx.ws });
    return;
  }
  if (node.nodeType !== 1) return;
  var display = __jb.displayOf(node);
  var tag = node._ns === __jb.HTML_NS ? node._tag : null;
  var svg = node._ns === __jb.SVG_NS;
  if (svg && __jb.SVG_UNRENDERED.test(node._tag)) display = "none";
  var none = ctx.none || display === "none";
  var child = { ws: __jb.whiteSpaceOf(node, ctx.ws), vis: __jb.visibilityOf(node, ctx.vis), tt: __jb.textTransformOf(node, ctx.tt), none: none, svg: svg || ctx.svg, svgText: svg ? (/^(text|tspan|textPath)$/.test(node._tag) || (ctx.svgText && node._tag === "a")) : false, pdisp: display, lang: node.hasAttribute("lang") ? node.getAttribute("lang") : ctx.lang, inSelect: !!ctx.inSelect };
  if (none) return;
  if (tag === "br") { if (child.vis === "visible" && !top) items.push({ t: "forced" }); return; }
  // Inside a select only option and optgroup boxes exist.
  if (ctx.inSelect && tag !== "option" && tag !== "optgroup") { for (var sc = node.firstChild; sc; sc = sc.nextSibling) __jb.innerTextCollect(sc, child, items); return; }
  // Floats, absolutely positioned boxes and flex/grid items are blockified.
  if (!__jb.isBlockLevelDisplay(display) && display !== "none" && !/^(table|inline-table|table-row|table-cell|table-row-group|table-caption)/.test(display)) {
    var fl = __jb.styleOf(node, "float"), pos = __jb.styleOf(node, "position");
    if (fl === "left" || fl === "right" || pos === "absolute" || pos === "fixed" || /^(flex|grid|inline-flex|inline-grid)$/.test(ctx.pdisp)) display = "block";
  }
  if (tag && __jb.REPLACED_TAGS.test(tag)) {
    // Fallback content is not rendered; the element is an atomic box.
    if (__jb.isBlockLevelDisplay(display)) { items.push({ t: "req", n: 1 }); items.push({ t: "req", n: 1 }); } else items.push({ t: "atomic", s: "" });
    return;
  }
  if (tag === "select") {
    // A select's box only contains its option and optgroup boxes.
    var sstart = items.length;
    items.push(null);
    child.inSelect = true;
    for (var oc = node.firstChild; oc; oc = oc.nextSibling) __jb.innerTextCollect(oc, child, items);
    if (__jb.isBlockLevelDisplay(display)) { items[sstart] = { t: "req", n: 1 }; items.push({ t: "req", n: 1 }); }
    return;
  }
  if (tag === "option") child.inSelect = false;
  // A closed <details> renders only its summary.
  var kids = [];
  if (tag === "details" && !node.hasAttribute("open")) {
    for (var dc = node.firstChild; dc; dc = dc.nextSibling) if (dc.nodeType === 1 && dc._ns === __jb.HTML_NS && dc._tag === "summary") { kids.push(dc); break; }
  } else {
    for (var c = node.firstChild; c; c = c.nextSibling) kids.push(c);
  }
  if (display === "inline-block" || display === "inline-flex" || display === "inline-grid" || display === "inline-table") {
    // An atomic inline: its own formatting context, opaque to the
    // surrounding white-space collapsing.
    var inner = [];
    kids.forEach(function (k) { __jb.innerTextCollect(k, child, inner); });
    var astart = items.length;
    items.push(null);
    items.push({ t: "atomic", s: child.vis === "visible" || inner.some(function (x) { return x !== null; }) ? __jb.innerTextFinish(inner) : "" });
    if (tag === "p" && child.vis === "visible") { items[astart] = { t: "req", n: 2 }; items.push({ t: "req", n: 2 }); }
    return;
  }
  var start = items.length;
  items.push(null); // the leading required line break, filled in below
  kids.forEach(function (k) { __jb.innerTextCollect(k, child, items); });
  if (child.vis !== "visible") return;
  if (!top && display === "table-cell" && !__jb.isLastCell(node)) items.push({ t: "raw", s: "\t" });
  if (!top && display === "table-row" && !__jb.isLastRow(node)) items.push({ t: "forced" });
  if (tag === "p") { items[start] = { t: "req", n: 2 }; items.push({ t: "req", n: 2 }); }
  else if (__jb.isBlockLevelDisplay(display)) { items[start] = { t: "req", n: 1 }; items.push({ t: "req", n: 1 }); }
};
// Serialises collected items applying CSS white-space processing and the
// required-line-break rules.
__jb.innerTextFinish = function (items) {
  var out = "", pendingSpace = false, lineStart = true, req = -1;
  function flushReq() { if (req >= 0) { if (out !== "") for (var k = 0; k < req; k++) out += "\n"; req = -1; } }
  function emit(text) { if (text === "") return; flushReq(); if (pendingSpace) { out += " "; pendingSpace = false; } out += text; lineStart = text.charAt(text.length - 1) === "\n"; }
  function forced() { pendingSpace = false; flushReq(); out += "\n"; lineStart = true; }
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it === null) continue;
    if (it.t === "req") { pendingSpace = false; lineStart = true; if (it.n > req) req = it.n; continue; }
    if (it.t === "forced") { forced(); continue; }
    if (it.t === "raw") { pendingSpace = false; flushReq(); out += it.s; lineStart = true; continue; }
    if (it.t === "atomic") { flushReq(); if (pendingSpace) { out += " "; pendingSpace = false; } out += it.s; lineStart = false; continue; }
    var s = it.s.replace(/\r\n?/g, "\n");
    if (it.ws === "pre" || it.ws === "pre-wrap" || it.ws === "break-spaces") { emit(s); continue; }
    var segments;
    if (it.ws === "pre-line") segments = s.replace(/[ \t]*\n[ \t]*/g, "\n").split("\n");
    else segments = [s.replace(/\n/g, " ")];
    for (var j = 0; j < segments.length; j++) {
      if (j > 0) forced();
      var seg = segments[j].replace(/\t/g, " ").replace(/ +/g, " ");
      if (seg === "") continue;
      if (seg.charAt(0) === " ") { if (!lineStart) pendingSpace = true; seg = seg.slice(1); }
      var trailing = seg.length > 0 && seg.charAt(seg.length - 1) === " ";
      if (trailing) seg = seg.slice(0, -1);
      if (seg !== "") { emit(seg); lineStart = false; }
      if (trailing && !lineStart) pendingSpace = true;
    }
  }
  return out;
};
// innerText setter: line breaks become <br> elements.
__jb.renderedTextFragment = function (doc, v) {
  var text = v === null ? "" : String(v);
  var frag = doc.createDocumentFragment();
  var parts = text.split(/\r\n|\r|\n/);
  for (var i = 0; i < parts.length; i++) {
    if (i > 0) frag.appendChild(doc.createElement("br"));
    if (parts[i] !== "") frag.appendChild(doc.createTextNode(parts[i]));
  }
  return frag;
};

// innerText/outerText live on HTMLElement only.
Object.defineProperty(HTMLElement.prototype, "innerText", {
  get: function () {
    if (!__jb.isRendered(this)) return this.textContent;
    var items = [];
    var ctx = this.parentNode && this.parentNode.nodeType === 1 ? __jb.innerTextContext(this.parentNode) : { ws: "normal", vis: "visible", tt: "none", none: false };
    __jb.innerTextCollect(this, ctx, items, true);
    return __jb.innerTextFinish(items);
  },
  set: function (v) { __jb.replaceAll(this, __jb.renderedTextFragment(this.ownerDocument, v)); },
  configurable: true, enumerable: true,
});
Object.defineProperty(HTMLElement.prototype, "outerText", {
  get: function () { return this.innerText; },
  set: function (v) {
    var parent = this.parentNode;
    if (!parent) throw __jb.domError("NoModificationAllowedError", "The element has no parent");
    var next = this.nextSibling, prev = this.previousSibling;
    var frag = __jb.renderedTextFragment(this.ownerDocument, v);
    if (!frag.firstChild) frag.appendChild(this.ownerDocument.createTextNode(""));
    parent.replaceChild(frag, this);
    if (next && next.nodeType === 3 && next.previousSibling && next.previousSibling.nodeType === 3) { var p2 = next.previousSibling; next.data = p2.data + next.data; p2.remove(); }
    if (prev && prev.nodeType === 3 && prev.nextSibling && prev.nextSibling.nodeType === 3) { var n2 = prev.nextSibling; prev.data = prev.data + n2.data; n2.remove(); }
  },
  configurable: true, enumerable: true,
});

// An HTML element created with an `is` value (even "") without a definition is "undefined" for :defined.
(function () {
  var base = __jb.createElementInternal;
  __jb.createElementInternal = function (doc, local, ns, prefix, is) {
    var el = base.apply(this, arguments);
    if (ns === __jb.HTML_NS && is !== undefined && is !== null && el && el.nodeType === 1 && !el._ceDef) el._ceIsValue = String(is);
    return el;
  };
})();

// Custom elements created by fragment parsing get their upgrade reaction once the fragment is built.
(function () {
  var build = __jb.buildTree, depth = 0;
  __jb.buildTree = function () {
    depth++;
    try { return build.apply(this, arguments); }
    finally {
      depth--;
      if (depth === 0 && __jb.ceFragmentUpgrades && __jb.ceFragmentUpgrades.length) {
        var list = __jb.ceFragmentUpgrades.splice(0);
        list.forEach(function (el) { var def = el._ceDefPending; if (def && !el._ceDef && !el._ceFailed && typeof __jb.upgradeElement === "function") __jb.upgradeElement(el, def); });
      }
    }
  };
})();
