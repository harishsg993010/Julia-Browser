// Part 5: Document, window objects, observers, custom elements
__jb.ceRegistry = Object.create(null);
__jb.ceByCtor = new Map();
__jb.ceConstructing = null;
__jb.ceWhenDefined = Object.create(null);
__jb.RESERVED_CE_NAMES = ["annotation-xml", "color-profile", "font-face", "font-face-src", "font-face-uri", "font-face-format", "font-face-name", "missing-glyph"];
// HTML "valid custom element name" (relaxed form): lower-case ASCII start, a hyphen, no upper-case
// ASCII, a valid element local name, not reserved.
__jb.validCustomElementName = function (name) {
  name = String(name);
  if (!/^[a-z]/.test(name) || name.indexOf("-") < 0 || /[A-Z]/.test(name)) return false;
  if (__jb.RESERVED_CE_NAMES.indexOf(name) >= 0) return false;
  return /^[A-Za-z][^\0\t\n\f\r\u0020/>]*$/.test(name);
};
class CustomElementRegistry {
  constructor() { if (!__jb.ceRegistryConstructing) throw new TypeError("Illegal constructor"); }
  define(name, ctor, options) {
    if (arguments.length < 2) throw new TypeError("define: 2 arguments required");
    // ElementDefinitionOptions conversion happens first (reads "extends")
    var ext = null;
    if (options !== undefined && options !== null) {
      if (typeof options !== "object" && typeof options !== "function") throw new TypeError("define: options is not an object");
      var ev = options.extends; if (ev !== undefined) ext = String(ev);
    }
    name = String(name);
    if (typeof ctor !== "function") throw new TypeError("CustomElementRegistry.define: Argument 2 is not a constructor.");
    var isCtor = true; try { new (new Proxy(ctor, { construct: function () { return {}; } }))(); } catch (e) { isCtor = false; } // IsConstructor without touching ctor
    if (!isCtor) throw new TypeError("CustomElementRegistry.define: Argument 2 is not a constructor.");
    if (!__jb.validCustomElementName(name)) throw __jb.domError("SyntaxError", "'" + name + "' is not a valid custom element name");
    if (__jb.ceRegistry[name]) throw __jb.domError("NotSupportedError", "'" + name + "' has already been defined as a custom element");
    if (__jb.ceByCtor.has(ctor)) throw __jb.domError("NotSupportedError", "this constructor has already been used with this registry");
    if (ext !== null) {
      if (__jb.validCustomElementName(ext)) throw __jb.domError("NotSupportedError", "extends must be a built-in element");
      if (__jb.htmlInterfaceFor(ext) === HTMLUnknownElement) throw __jb.domError("NotSupportedError", "extends must be a known element");
    }
    if (__jb.ceDefining) throw __jb.domError("NotSupportedError", "define() called re-entrantly");
    __jb.ceDefining = true;
    var def;
    var toFn = function (v, n) { if (v === undefined) return undefined; if (typeof v !== "function") throw new TypeError(n + " is not a function"); return v; };
    var toStrings = function (v, n) { if (v === null || (typeof v !== "object" && typeof v !== "function") || typeof v[Symbol.iterator] !== "function") throw new TypeError(n + " is not iterable"); return __jb.arrayFrom(v, function (x) { return String(x); }); };
    try {
      var proto = ctor.prototype;
      if (proto === null || (typeof proto !== "object" && typeof proto !== "function")) throw new TypeError("constructor.prototype is not an object");
      var callbacks = {};
      ["connectedCallback", "disconnectedCallback", "connectedMoveCallback", "adoptedCallback", "attributeChangedCallback"].forEach(function (n) { var v = toFn(proto[n], n); if (v !== undefined) callbacks[n] = v; });
      var observed = [];
      if (callbacks.attributeChangedCallback) { var oa = ctor.observedAttributes; if (oa !== undefined) observed = toStrings(oa, "observedAttributes"); }
      var disabledFeatures = [];
      var df = ctor.disabledFeatures; if (df !== undefined) disabledFeatures = toStrings(df, "disabledFeatures");
      var formAssociated = !!ctor.formAssociated;
      if (formAssociated) ["formAssociatedCallback", "formResetCallback", "formDisabledCallback", "formStateRestoreCallback"].forEach(function (n) { var v = toFn(proto[n], n); if (v !== undefined) callbacks[n] = v; });
      def = { name: name, ctor: ctor, extends: ext, observedAttributes: observed, callbacks: callbacks, disableShadow: disabledFeatures.indexOf("shadow") >= 0, disableInternals: disabledFeatures.indexOf("internals") >= 0, formAssociated: formAssociated };
    } finally { __jb.ceDefining = false; }
    __jb.ceRegistry[name] = def;
    __jb.ceByCtor.set(ctor, def);
    // upgrade existing elements (document order, shadow trees included)
    if (typeof __jb.currentDocument !== "undefined") { var candidates = __jb.ceCandidates(__jb.currentDocument, name, ext); candidates.forEach(function (el) { __jb.upgradeElement(el, def); }); }
    var pending = __jb.ceWhenDefined[name];
    if (pending) { delete __jb.ceWhenDefined[name]; pending.resolve(ctor); }
  }
  get(name) { var d = __jb.ceRegistry[String(name)]; return d ? d.ctor : undefined; }
  getName(ctor) { var d = __jb.ceByCtor.get(ctor); return d ? d.name : null; }
  whenDefined(name) {
    name = String(name);
    if (!__jb.validCustomElementName(name)) return Promise.reject(__jb.domError("SyntaxError", "'" + name + "' is not a valid custom element name"));
    if (__jb.ceRegistry[name]) return Promise.resolve(__jb.ceRegistry[name].ctor);
    // the same pending promise each time until the name is defined
    var p = __jb.ceWhenDefined[name];
    if (!p) { var res; var pr = new Promise(function (r) { res = r; }); p = __jb.ceWhenDefined[name] = { promise: pr, resolve: res }; }
    return p.promise;
  }
  upgrade(root) { __jb.expectNode(root, "upgrade: Argument 1"); var all = root.nodeType === 1 ? [root].concat(__jb.descendants(root, function (n) { return n.nodeType === 1; })) : __jb.descendants(root, function (n) { return n.nodeType === 1; }); all.forEach(function (el) { __jb.tryUpgrade(el); }); }
}
__jb.setTag(CustomElementRegistry, "CustomElementRegistry");
__jb.ceCandidates = function (root, name, ext) {
  var out = [];
  (function walk(n) {
    for (var c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) {
        if (c._ns === __jb.HTML_NS && !c._ceDef) { if (ext ? (c._local === ext && c.getAttribute("is") === name) : c._local === name) out.push(c); }
        if (c._shadowRoot) walk(c._shadowRoot);
        walk(c);
      }
    }
  })(root);
  return out;
};
__jb.tryUpgrade = function (el) {
  if (el._ceDef || el.nodeType !== 1 || el._ns !== __jb.HTML_NS) return;
  var is = el.getAttribute("is");
  var def = __jb.ceRegistry[el._local] || (is ? __jb.ceRegistry[is] : null);
  if (def && (def.extends ? def.extends === el._local : def.name === el._local)) __jb.upgradeElement(el, def);
};
__jb.upgradeElement = function (el, def) {
  if (el._ceDef || el._ceFailed) return;
  el._ceDefPending = null;
  // Run the constructor body with `this` bound to the existing element: the
  // HTMLElement base constructor returns `existing`, so the derived class
  // constructor operates directly on it.
  __jb.ceConstructing = { doc: el.ownerDocument, tag: el._local, existing: el };
  var result;
  // "Upgrade an element": the definition is set before the constructor runs (attachInternals).
  el._ceDef = def;
  el._ceUpgrading = true; // "precustomized": not :defined until the constructor finishes
  __jb.domVersion++; // the custom element state (:defined) changes
  try { result = Reflect.construct(def.ctor, [], def.ctor); }
  catch (e) { __jb.ceConstructing = null; el._ceDef = null; el._ceFailed = true; __jb.reportException(e); return; }
  finally { __jb.ceConstructing = null; el._ceUpgrading = false; }
  if (result !== el) { el._ceDef = null; el._ceFailed = true; __jb.reportException(new TypeError("custom element constructor returned a different object")); return; }
  el._ceDef = def;
  for (var i = 0; i < el._attrs.length; i++) { var a = el._attrs[i]; if (def.observedAttributes.indexOf(a._local) >= 0 && typeof el.attributeChangedCallback === "function") { try { el.attributeChangedCallback(a._local, null, a._value, a._ns); } catch (e2) { __jb.reportException(e2); } } }
  if (el.isConnected && typeof el.connectedCallback === "function") { el._ceConnected = true; try { el.connectedCallback(); } catch (e3) { __jb.reportException(e3); } }
  if (def.formAssociated && typeof __jb.faceUpgraded === "function") __jb.faceUpgraded(el);
  __jb.markDirty(el);
};
__jb.customElementConnected = function (el) {
  if (el._ns !== __jb.HTML_NS) return;
  if (!el._ceDef) { var od = el.ownerDocument; if (od !== __jb.currentDocument && !od.defaultView) return; var is = el._ceIsValue !== undefined ? el._ceIsValue : el.getAttribute("is"); var def = __jb.ceRegistry[el._local] || (is ? __jb.ceRegistry[is] : null); if (def && !el._ceFailed && (def.extends ? def.extends === el._local : def.name === el._local)) __jb.upgradeElement(el, def); return; }
  if (!el._ceConnected && typeof el.connectedCallback === "function") { el._ceConnected = true; try { el.connectedCallback(); } catch (e) { __jb.reportException(e); } }
};
__jb.ceRegistryConstructing = true;
globalThis.customElements = new CustomElementRegistry();
__jb.ceRegistryConstructing = false;

class IntersectionObserverLegacy {
  constructor(cb, opts) { if (typeof cb !== "function") throw new TypeError("IntersectionObserver: callback is not a function"); this._cb = cb; this.root = (opts && opts.root) || null; this.rootMargin = (opts && opts.rootMargin) || "0px 0px 0px 0px"; var th = opts && opts.threshold !== undefined ? opts.threshold : [0]; this.thresholds = Array.isArray(th) ? th : [th]; this._targets = []; }
  observe(t) { __jb.expectNode(t); if (this._targets.indexOf(t) >= 0) return; this._targets.push(t); var self_ = this; setTimeout(function () { if (self_._targets.indexOf(t) < 0) return; try { self_._cb([{ target: t, isIntersecting: true, intersectionRatio: 1, boundingClientRect: t.getBoundingClientRect(), intersectionRect: t.getBoundingClientRect(), rootBounds: null, time: performance.now() }], self_); } catch (e) { __jb.reportException(e); } }, 0); }
  unobserve(t) { this._targets = this._targets.filter(function (x) { return x !== t; }); }
  disconnect() { this._targets = []; }
  takeRecords() { return []; }
}
class ResizeObserverLegacy { constructor(cb) { if (typeof cb !== "function") throw new TypeError("ResizeObserver: callback is not a function"); this._cb = cb; this._targets = []; } observe(t) { __jb.expectNode(t); if (this._targets.indexOf(t) >= 0) return; this._targets.push(t); var self_ = this; setTimeout(function () { if (self_._targets.indexOf(t) < 0) return; try { self_._cb([{ target: t, contentRect: t.getBoundingClientRect(), borderBoxSize: [{ inlineSize: 0, blockSize: 0 }], contentBoxSize: [{ inlineSize: 0, blockSize: 0 }], devicePixelContentBoxSize: [{ inlineSize: 0, blockSize: 0 }] }], self_); } catch (e) { __jb.reportException(e); } }, 0); } unobserve(t) { this._targets = this._targets.filter(function (x) { return x !== t; }); } disconnect() { this._targets = []; } }
// Reporting API: reports generated in this realm (CSP violations, ...) go to its ReportingObservers.
class ReportBody { constructor() { throw new TypeError("Illegal constructor"); } }
class CSPViolationReportBody extends ReportBody {
  get documentURL() { return this._d.documentURL; } get referrer() { return this._d.referrer; } get blockedURL() { return this._d.blockedURL; }
  get effectiveDirective() { return this._d.effectiveDirective; } get originalPolicy() { return this._d.originalPolicy; } get sourceFile() { return this._d.sourceFile; }
  get sample() { return this._d.sample; } get disposition() { return this._d.disposition; } get statusCode() { return this._d.statusCode; }
  get lineNumber() { return this._d.lineNumber; } get columnNumber() { return this._d.columnNumber; }
  toJSON() { return Object.assign({}, this._d); }
}
class Report {
  constructor() { throw new TypeError("Illegal constructor"); }
  get type() { return this._type; } get url() { return this._url; } get body() { return this._body; }
  toJSON() { return { type: this._type, url: this._url, body: this._body && typeof this._body.toJSON === "function" ? this._body.toJSON() : this._body }; }
}
__jb.reportingObservers = [];
__jb.reportBuffer = [];
__jb.queueReport = function (type, url, data, owner) {
  var w = owner || globalThis;
  var target = w.__jb || __jb;
  var body = null;
  if (type === "csp-violation") { body = Object.create(CSPViolationReportBody.prototype); Object.defineProperty(body, "_d", { value: data }); }
  else body = data;
  var report = Object.create(Report.prototype);
  Object.defineProperty(report, "_type", { value: type }); Object.defineProperty(report, "_url", { value: url }); Object.defineProperty(report, "_body", { value: body });
  target.reportBuffer.push(report);
  if (target.reportBuffer.length > 100) target.reportBuffer.shift();
  target.reportingObservers.forEach(function (o) { o._offer(report); });
};
class ReportingObserver {
  constructor(callback, options) {
    if (typeof callback !== "function") throw new TypeError("ReportingObserver: callback is not a function");
    Object.defineProperty(this, "_cb", { value: callback });
    var types = options && options.types !== undefined ? __jb.arrayFrom(options.types, String) : null;
    Object.defineProperty(this, "_types", { value: types });
    Object.defineProperty(this, "_buffered", { value: !!(options && options.buffered) });
    Object.defineProperty(this, "_queue", { value: [], writable: true });
    Object.defineProperty(this, "_pending", { value: false, writable: true });
  }
  _offer(report) {
    if (this._types && this._types.indexOf(report.type) < 0) return;
    this._queue.push(report);
    if (this._pending) return;
    this._pending = true;
    var self_ = this;
    setTimeout(function () { self_._pending = false; var list = self_.takeRecords(); if (list.length && __jb.reportingObservers.indexOf(self_) >= 0) { try { self_._cb.call(self_, list, self_); } catch (e) { __jb.reportException(e); } } }, 0);
  }
  observe() {
    if (__jb.reportingObservers.indexOf(this) >= 0) return;
    __jb.reportingObservers.push(this);
    if (this._buffered) { var self_ = this; __jb.reportBuffer.forEach(function (r) { self_._offer(r); }); }
  }
  disconnect() { var i = __jb.reportingObservers.indexOf(this); if (i >= 0) __jb.reportingObservers.splice(i, 1); }
  takeRecords() { var q = this._queue; this._queue = []; return q; }
}

// ---- Ranges / Selection / TreeWalker ----
__jb.nodeIndex = function (n) { var i = 0; for (var s = n.previousSibling; s; s = s.previousSibling) i++; return i; };
__jb.nodeLength = function (n) { switch (n.nodeType) { case 10: return 0; case 3: case 8: case 7: case 4: return n.data.length; default: { var c = 0; for (var k = n.firstChild; k; k = k.nextSibling) c++; return c; } } };
__jb.rootOf = function (n) { while (n.parentNode) n = n.parentNode; return n; };
// Compare two boundary points: -1 before, 0 equal, 1 after.
__jb.compareBoundary = function (nodeA, offsetA, nodeB, offsetB) {
  if (nodeA === nodeB) return offsetA < offsetB ? -1 : offsetA > offsetB ? 1 : 0;
  if (__jb.isAncestor(nodeB, nodeA) === false && __jb.isAncestor(nodeA, nodeB) === false) {
    // sibling-ish: compare tree order
    var pos = nodeA.compareDocumentPosition(nodeB);
    if (pos & 2) return __jb.compareBoundary(nodeB, offsetB, nodeA, offsetA) === -1 ? 1 : -1;
    return -1;
  }
  if (__jb.isAncestor(nodeA, nodeB)) {
    // nodeA is ancestor of nodeB: find child of nodeA that contains nodeB
    var child = nodeB; while (child.parentNode !== nodeA) child = child.parentNode;
    return __jb.nodeIndex(child) < offsetA ? 1 : -1;
  }
  // nodeB is ancestor of nodeA
  var child2 = nodeA; while (child2.parentNode !== nodeB) child2 = child2.parentNode;
  return __jb.nodeIndex(child2) < offsetB ? -1 : 1;
};
class AbstractRange {
  constructor() { if (new.target === AbstractRange) throw new TypeError("Illegal constructor"); }
  get startContainer() { return this._start[0]; } get startOffset() { return this._start[1]; }
  get endContainer() { return this._end[0]; } get endOffset() { return this._end[1]; }
  get collapsed() { return this._start[0] === this._end[0] && this._start[1] === this._end[1]; }
}
class StaticRange extends AbstractRange {
  constructor(init) { super(); if (!init || !__jb.isNode(init.startContainer) || !__jb.isNode(init.endContainer)) throw new TypeError("StaticRange: invalid init"); if (init.startContainer.nodeType === 10 || init.startContainer.nodeType === 2 || init.endContainer.nodeType === 10 || init.endContainer.nodeType === 2) throw __jb.domError("InvalidNodeTypeError", "invalid node type"); this._start = [init.startContainer, init.startOffset >>> 0]; this._end = [init.endContainer, init.endOffset >>> 0]; }
}
// Live ranges and node iterators, held weakly (when WeakRef exists) so the DOM mutation steps can update them.
__jb.weakList = function () {
  var items = [], adds = 0, Weak = typeof WeakRef === "function" ? WeakRef : null;
  return {
    add: function (o) { items.push(Weak ? new Weak(o) : o); if (++adds % 256 === 0) items = items.filter(function (r) { return Weak ? r.deref() !== undefined : true; }); },
    each: function (fn) { for (var i = 0; i < items.length; i++) { var o = Weak ? items[i].deref() : items[i]; if (o) fn(o); } },
    get size() { return items.length; },
  };
};
__jb.liveRanges = __jb.weakList();
__jb.nodeIterators = __jb.weakList();
// DOM "replace data" steps for live ranges.
__jb.rangesReplaceData = function (node, offset, count, dataLen) {
  if (!__jb.liveRanges.size) return;
  __jb.liveRanges.each(function (r) {
    if (r._start[0] === node && r._start[1] > offset && r._start[1] <= offset + count) r._start = [node, offset];
    if (r._end[0] === node && r._end[1] > offset && r._end[1] <= offset + count) r._end = [node, offset];
    if (r._start[0] === node && r._start[1] > offset + count) r._start = [node, r._start[1] + dataLen - count];
    if (r._end[0] === node && r._end[1] > offset + count) r._end = [node, r._end[1] + dataLen - count];
  });
};
// "split a Text node": boundaries past offset move into the new node; boundaries right after node move past it.
__jb.rangesSplit = function (node, offset, newNode, parent) {
  if (!__jb.liveRanges.size) return;
  var idx = __jb.nodeIndex(node);
  __jb.liveRanges.each(function (r) {
    if (r._start[0] === node && r._start[1] > offset) r._start = [newNode, r._start[1] - offset];
    if (r._end[0] === node && r._end[1] > offset) r._end = [newNode, r._end[1] - offset];
  });
  __jb.liveRanges.each(function (r) {
    if (r._start[0] === parent && r._start[1] === idx + 1) r._start = [parent, r._start[1] + 1];
    if (r._end[0] === parent && r._end[1] === idx + 1) r._end = [parent, r._end[1] + 1];
  });
};
// "insert": boundaries in parent after the reference child's index shift by count.
__jb.rangesInsert = function (parent, childIndex, count) {
  if (!__jb.liveRanges.size) return;
  __jb.liveRanges.each(function (r) {
    if (r._start[0] === parent && r._start[1] > childIndex) r._start = [parent, r._start[1] + count];
    if (r._end[0] === parent && r._end[1] > childIndex) r._end = [parent, r._end[1] + count];
  });
};
// "remove" (before the node leaves parent): ranges inside it collapse to its old position; later ones shift back;
// node iterators run their pre-removing steps.
__jb.rangesRemove = function (node, parent) {
  if (__jb.nodeIterators.size) __jb.nodeIterators.each(function (it) { __jb.nodeIteratorPreRemove(it, node); });
  if (!__jb.liveRanges.size) return;
  var idx = __jb.nodeIndex(node);
  var inside = function (n) { for (; n; n = n.parentNode) if (n === node) return true; return false; };
  __jb.liveRanges.each(function (r) {
    if (inside(r._start[0])) r._start = [parent, idx];
    if (inside(r._end[0])) r._end = [parent, idx];
    if (r._start[0] === parent && r._start[1] > idx) r._start = [parent, r._start[1] - 1];
    if (r._end[0] === parent && r._end[1] > idx) r._end = [parent, r._end[1] - 1];
  });
};
__jb.nodeIteratorPreRemove = function (it, node) {
  var ref = it.referenceNode, root = it.root;
  if (!ref) return;
  for (var rn = root; rn; rn = rn.parentNode) if (rn === node) return; // removing the root or an ancestor of it
  var n; for (n = ref; n && n !== node; n = n.parentNode); if (!n) return; // node is not an inclusive ancestor of the reference
  if (it.pointerBeforeReferenceNode) {
    // first following node outside node, still inside root
    var next = null, cur = node;
    while (cur && cur !== root) { if (cur.nextSibling) { next = cur.nextSibling; break; } cur = cur.parentNode; }
    if (next) { it.referenceNode = next; return; }
    it.pointerBeforeReferenceNode = false;
  }
  if (!node.previousSibling) it.referenceNode = node.parentNode;
  else { var last = node.previousSibling; while (last.lastChild) last = last.lastChild; it.referenceNode = last; }
};
class Range extends AbstractRange {
  constructor() { super(); var d = typeof __jb.currentDocument !== "undefined" ? __jb.currentDocument : null; this._start = [d, 0]; this._end = [d, 0]; __jb.liveRanges.add(this); }
  get commonAncestorContainer() { var a = this._start[0]; while (a && !(a === this._end[0] || __jb.isAncestor(a, this._end[0]))) a = a.parentNode; return a; }
  _setBoundary(which, node, offset) {
    __jb.expectNode(node, "Range: Argument 1");
    if (node.nodeType === 10) throw __jb.domError("InvalidNodeTypeError", "doctype");
    offset = offset >>> 0;
    if (offset > __jb.nodeLength(node)) throw __jb.domError("IndexSizeError", "offset out of range");
    var bp = [node, offset];
    if (which === "start") { if (__jb.rootOf(node) !== __jb.rootOf(this._end[0]) || __jb.compareBoundary(node, offset, this._end[0], this._end[1]) === 1) this._end = bp; this._start = bp; }
    else { if (__jb.rootOf(node) !== __jb.rootOf(this._start[0]) || __jb.compareBoundary(node, offset, this._start[0], this._start[1]) === -1) this._start = bp; this._end = bp; }
  }
  setStart(n, o) { if (arguments.length < 2) throw new TypeError("setStart: 2 arguments required"); this._setBoundary("start", n, o); }
  setEnd(n, o) { if (arguments.length < 2) throw new TypeError("setEnd: 2 arguments required"); this._setBoundary("end", n, o); }
  setStartBefore(n) { __jb.expectNode(n); if (!n.parentNode) throw __jb.domError("InvalidNodeTypeError", "no parent"); this._setBoundary("start", n.parentNode, __jb.nodeIndex(n)); }
  setStartAfter(n) { __jb.expectNode(n); if (!n.parentNode) throw __jb.domError("InvalidNodeTypeError", "no parent"); this._setBoundary("start", n.parentNode, __jb.nodeIndex(n) + 1); }
  setEndBefore(n) { __jb.expectNode(n); if (!n.parentNode) throw __jb.domError("InvalidNodeTypeError", "no parent"); this._setBoundary("end", n.parentNode, __jb.nodeIndex(n)); }
  setEndAfter(n) { __jb.expectNode(n); if (!n.parentNode) throw __jb.domError("InvalidNodeTypeError", "no parent"); this._setBoundary("end", n.parentNode, __jb.nodeIndex(n) + 1); }
  collapse(toStart) { if (toStart) this._end = this._start; else this._start = this._end; }
  selectNode(n) { __jb.expectNode(n); if (!n.parentNode) throw __jb.domError("InvalidNodeTypeError", "no parent"); var i = __jb.nodeIndex(n); this._start = [n.parentNode, i]; this._end = [n.parentNode, i + 1]; }
  selectNodeContents(n) { __jb.expectNode(n); if (n.nodeType === 10) throw __jb.domError("InvalidNodeTypeError", "doctype"); this._start = [n, 0]; this._end = [n, __jb.nodeLength(n)]; }
  compareBoundaryPoints(how, source) {
    if (arguments.length < 2) throw new TypeError("compareBoundaryPoints: 2 arguments required");
    if (!(source instanceof Range)) throw new TypeError("compareBoundaryPoints: Argument 2 is not a Range");
    how = (how >>> 0) & 0xffff; // unsigned short
    if (how > 3) throw __jb.domError("NotSupportedError", "invalid how");
    if (__jb.rootOf(this._start[0]) !== __jb.rootOf(source._start[0])) throw __jb.domError("WrongDocumentError", "different roots");
    var tp, op;
    switch (how) { case 0: tp = this._start; op = source._start; break; case 1: tp = this._end; op = source._start; break; case 2: tp = this._end; op = source._end; break; default: tp = this._start; op = source._end; }
    return __jb.compareBoundary(tp[0], tp[1], op[0], op[1]);
  }
  deleteContents() {
    if (this.collapsed) return;
    var os = this._start, oe = this._end;
    if (os[0] === oe[0] && (os[0].nodeType === 3 || os[0].nodeType === 8 || os[0].nodeType === 7 || os[0].nodeType === 4)) { __jb.replaceData(os[0], os[1], oe[1] - os[1], ""); return; }
    var nodesToRemove = [];
    var ancestor = this.commonAncestorContainer;
    __jb.allNodes(ancestor).forEach(function (n) { if (n === ancestor) return; if (__jb.rangeContains(os, oe, n) && !(n.parentNode && __jb.rangeContains(os, oe, n.parentNode))) nodesToRemove.push(n); });
    var newNode, newOffset;
    if (os[0] === oe[0] || __jb.isAncestor(os[0], oe[0])) { newNode = os[0]; newOffset = os[1]; }
    else { var ref = os[0]; while (ref.parentNode && !__jb.isAncestor(ref.parentNode, oe[0]) && ref.parentNode !== oe[0]) ref = ref.parentNode; newNode = ref.parentNode; newOffset = __jb.nodeIndex(ref) + 1; }
    if (os[0].nodeType === 3 || os[0].nodeType === 8 || os[0].nodeType === 7 || os[0].nodeType === 4) __jb.replaceData(os[0], os[1], __jb.nodeLength(os[0]) - os[1], "");
    nodesToRemove.forEach(function (n) { __jb.remove(n); });
    if (oe[0].nodeType === 3 || oe[0].nodeType === 8 || oe[0].nodeType === 7 || oe[0].nodeType === 4) __jb.replaceData(oe[0], 0, oe[1], "");
    this._start = [newNode, newOffset]; this._end = [newNode, newOffset];
  }
  extractContents() { return __jb.extractRange(this, false); }
  cloneContents() { return __jb.extractRange(this, true); }
  insertNode(node) {
    __jb.expectNode(node);
    var s = this._start;
    if (s[0].nodeType === 7 || s[0].nodeType === 8 || (s[0].nodeType === 3 && !s[0].parentNode) || s[0] === node) throw __jb.domError("HierarchyRequestError", "cannot insert here");
    var referenceNode = null;
    if (s[0].nodeType === 3) referenceNode = s[0]; else referenceNode = s[0].childNodes[s[1]] || null;
    var parent = referenceNode ? referenceNode.parentNode : s[0];
    __jb.ensurePreInsertionValidity(parent, node, referenceNode);
    if (s[0].nodeType === 3) referenceNode = s[0].splitText(s[1]);
    if (node === referenceNode) referenceNode = node.nextSibling;
    if (node.parentNode) __jb.remove(node);
    var newOffset = referenceNode ? __jb.nodeIndex(referenceNode) : __jb.nodeLength(parent);
    newOffset += node.nodeType === 11 ? __jb.nodeLength(node) : 1;
    __jb.preInsert(parent, node, referenceNode);
    if (this.collapsed) this._end = [parent, newOffset];
  }
  surroundContents(newParent) {
    __jb.expectNode(newParent);
    var self_ = this;
    var partial = __jb.allNodes(this.commonAncestorContainer).some(function (n) { return n.nodeType !== 3 && __jb.rangePartiallyContains(self_._start, self_._end, n); });
    if (partial) throw __jb.domError("InvalidStateError", "range partially contains a non-Text node");
    if (newParent.nodeType === 9 || newParent.nodeType === 10 || newParent.nodeType === 11) throw __jb.domError("InvalidNodeTypeError", "invalid parent");
    var frag = this.extractContents();
    if (newParent.firstChild) __jb.replaceAll(newParent, null);
    this.insertNode(newParent);
    newParent.appendChild(frag);
    this.selectNode(newParent);
  }
  cloneRange() { var r = new Range(); r._start = this._start; r._end = this._end; return r; }
  detach() {}
  isPointInRange(node, offset) { __jb.expectNode(node); if (__jb.rootOf(node) !== __jb.rootOf(this._start[0])) return false; if (node.nodeType === 10) throw __jb.domError("InvalidNodeTypeError", "doctype"); offset = offset >>> 0; if (offset > __jb.nodeLength(node)) throw __jb.domError("IndexSizeError", "offset out of range"); return __jb.compareBoundary(node, offset, this._start[0], this._start[1]) >= 0 && __jb.compareBoundary(node, offset, this._end[0], this._end[1]) <= 0; }
  comparePoint(node, offset) { __jb.expectNode(node); if (__jb.rootOf(node) !== __jb.rootOf(this._start[0])) throw __jb.domError("WrongDocumentError", "different root"); if (node.nodeType === 10) throw __jb.domError("InvalidNodeTypeError", "doctype"); offset = offset >>> 0; if (offset > __jb.nodeLength(node)) throw __jb.domError("IndexSizeError", "offset out of range"); if (__jb.compareBoundary(node, offset, this._start[0], this._start[1]) === -1) return -1; if (__jb.compareBoundary(node, offset, this._end[0], this._end[1]) === 1) return 1; return 0; }
  intersectsNode(node) { __jb.expectNode(node); if (__jb.rootOf(node) !== __jb.rootOf(this._start[0])) return false; var parent = node.parentNode; if (!parent) return true; var offset = __jb.nodeIndex(node); return __jb.compareBoundary(parent, offset, this._end[0], this._end[1]) === -1 && __jb.compareBoundary(parent, offset + 1, this._start[0], this._start[1]) === 1; }
  toString() { var s = this._start, e = this._end; if (s[0] === e[0] && s[0].nodeType === 3) return s[0].data.slice(s[1], e[1]); var out = ""; if (s[0].nodeType === 3) out += s[0].data.slice(s[1]); var self_ = this; __jb.allNodes(__jb.rootOf(s[0])).forEach(function (n) { if (n.nodeType === 3 && __jb.rangeContains(s, e, n)) out += n.data; }); if (e[0].nodeType === 3) out += e[0].data.slice(0, e[1]); return out; }
  getBoundingClientRect() { return new DOMRect(0, 0, 0, 0); }
  getClientRects() { return []; }
  createContextualFragment(html) { if (arguments.length < 1) throw new TypeError("createContextualFragment: 1 argument required"); var node = this._start[0]; var el = node.nodeType === 9 || node.nodeType === 11 ? null : node.nodeType === 1 ? node : node.parentElement; var doc = __jb.ownerDoc(node); if (!el || (el._tag === "html" && el._ns === __jb.HTML_NS)) el = doc.createElement("body"); var frag = __jb.parseFragment(String(html), el); __jb.descendants(frag, function (n) { return n.nodeType === 1 && n._tag === "script"; }).forEach(function (s) { s._executed = false; }); return frag; }
}
Range.START_TO_START = 0; Range.START_TO_END = 1; Range.END_TO_END = 2; Range.END_TO_START = 3;
Object.keys(Range).forEach(function (k) { if (/^[A-Z_]+$/.test(k)) Object.defineProperty(Range.prototype, k, { value: Range[k], enumerable: true }); });
__jb.setTag(Range, "Range"); __jb.setTag(StaticRange, "StaticRange"); __jb.setTag(AbstractRange, "AbstractRange");
__jb.rangeContains = function (s, e, node) { if (__jb.rootOf(node) !== __jb.rootOf(s[0])) return false; var parent = node.parentNode; if (!parent) return false; var i = __jb.nodeIndex(node); return __jb.compareBoundary(parent, i, s[0], s[1]) >= 0 && __jb.compareBoundary(parent, i + 1, e[0], e[1]) <= 0; };
__jb.rangePartiallyContains = function (s, e, node) { var a = node === s[0] || __jb.isAncestor(node, s[0]), b = node === e[0] || __jb.isAncestor(node, e[0]); return a !== b; };
__jb.extractRange = function (range, cloneOnly) {
  var os = range._start, oe = range._end;
  var doc = __jb.ownerDoc(os[0]);
  var frag = doc.createDocumentFragment();
  if (range.collapsed) return frag;
  var charLike = function (n) { return n.nodeType === 3 || n.nodeType === 8 || n.nodeType === 7 || n.nodeType === 4; };
  if (os[0] === oe[0] && charLike(os[0])) {
    var c = __jb.clone(os[0], doc, false); c._data = os[0].data.slice(os[1], oe[1]); frag._appendChildRaw(c);
    if (!cloneOnly) __jb.replaceData(os[0], os[1], oe[1] - os[1], "");
    return frag;
  }
  var commonAncestor = range.commonAncestorContainer;
  var firstPartial = null, lastPartial = null;
  if (os[0] !== commonAncestor && !__jb.isAncestor(os[0], oe[0])) { firstPartial = os[0]; while (firstPartial.parentNode !== commonAncestor) firstPartial = firstPartial.parentNode; }
  if (oe[0] !== commonAncestor && !__jb.isAncestor(oe[0], os[0])) { lastPartial = oe[0]; while (lastPartial.parentNode !== commonAncestor) lastPartial = lastPartial.parentNode; }
  var contained = []; for (var ch = commonAncestor.firstChild; ch; ch = ch.nextSibling) if (__jb.rangeContains(os, oe, ch)) contained.push(ch);
  if (contained.some(function (n) { return n.nodeType === 10; })) throw __jb.domError("HierarchyRequestError", "doctype in range");
  var newNode, newOffset;
  if (os[0] === commonAncestor || __jb.isAncestor(os[0], oe[0])) { newNode = os[0]; newOffset = os[1]; }
  else { var ref = os[0]; while (ref.parentNode && !(ref.parentNode === oe[0] || __jb.isAncestor(ref.parentNode, oe[0]))) ref = ref.parentNode; newNode = ref.parentNode; newOffset = __jb.nodeIndex(ref) + 1; }
  if (firstPartial && charLike(firstPartial)) {
    var c1 = __jb.clone(os[0], doc, false); c1._data = os[0].data.slice(os[1]); frag._appendChildRaw(c1);
    if (!cloneOnly) __jb.replaceData(os[0], os[1], __jb.nodeLength(os[0]) - os[1], "");
  } else if (firstPartial) {
    var c2 = __jb.clone(firstPartial, doc, false); frag._appendChildRaw(c2);
    var sub = new Range(); sub._start = os; sub._end = [firstPartial, __jb.nodeLength(firstPartial)];
    var subFrag = __jb.extractRange(sub, cloneOnly); while (subFrag.firstChild) { var x = subFrag.firstChild; subFrag._removeChildRaw(x); c2._appendChildRaw(x); }
  }
  contained.forEach(function (n) { if (cloneOnly) frag._appendChildRaw(__jb.clone(n, doc, true)); else { __jb.remove(n); frag._appendChildRaw(n); } });
  if (lastPartial && charLike(lastPartial)) {
    var c3 = __jb.clone(oe[0], doc, false); c3._data = oe[0].data.slice(0, oe[1]); frag._appendChildRaw(c3);
    if (!cloneOnly) __jb.replaceData(oe[0], 0, oe[1], "");
  } else if (lastPartial) {
    var c4 = __jb.clone(lastPartial, doc, false); frag._appendChildRaw(c4);
    var sub2 = new Range(); sub2._start = [lastPartial, 0]; sub2._end = oe;
    var subFrag2 = __jb.extractRange(sub2, cloneOnly); while (subFrag2.firstChild) { var y = subFrag2.firstChild; subFrag2._removeChildRaw(y); c4._appendChildRaw(y); }
  }
  if (!cloneOnly) { range._start = [newNode, newOffset]; range._end = [newNode, newOffset]; }
  return frag;
};
class Selection {
  constructor() { if (!__jb.selectionConstructing) throw new TypeError("Illegal constructor"); this._range = null; this._direction = "none"; }
  get anchorNode() { if (!this._range) return null; return this._direction === "backwards" ? this._range.endContainer : this._range.startContainer; }
  get anchorOffset() { if (!this._range) return 0; return this._direction === "backwards" ? this._range.endOffset : this._range.startOffset; }
  get focusNode() { if (!this._range) return null; return this._direction === "backwards" ? this._range.startContainer : this._range.endContainer; }
  get focusOffset() { if (!this._range) return 0; return this._direction === "backwards" ? this._range.startOffset : this._range.endOffset; }
  get isCollapsed() { return !this._range || this._range.collapsed; }
  get rangeCount() { return this._range ? 1 : 0; }
  get type() { return !this._range ? "None" : this._range.collapsed ? "Caret" : "Range"; }
  get direction() { return this._direction; }
  getRangeAt(i) { if (i !== 0 || !this._range) throw __jb.domError("IndexSizeError", "index out of range"); return this._range; }
  addRange(r) { if (!(r instanceof Range)) throw new TypeError("addRange: not a Range"); if (__jb.rootOf(r.startContainer) !== __jb.currentDocument) return; if (this._range) return; this._range = r; this._direction = "forwards"; }
  removeRange(r) { if (r !== this._range) throw __jb.domError("NotFoundError", "range not found"); this._range = null; this._direction = "none"; }
  removeAllRanges() { this._range = null; this._direction = "none"; }
  empty() { this.removeAllRanges(); }
  collapse(node, offset) { if (node === null || node === undefined) { this.removeAllRanges(); return; } __jb.expectNode(node); offset = offset >>> 0; if (node.nodeType === 10) throw __jb.domError("InvalidNodeTypeError", "doctype"); if (offset > __jb.nodeLength(node)) throw __jb.domError("IndexSizeError", "offset"); if (__jb.rootOf(node) !== __jb.currentDocument) return; var r = new Range(); r._start = [node, offset]; r._end = [node, offset]; this._range = r; this._direction = "forwards"; }
  setPosition(n, o) { this.collapse(n, o); }
  collapseToStart() { if (!this._range) throw __jb.domError("InvalidStateError", "no range"); var r = new Range(); r._start = this._range._start; r._end = this._range._start; this._range = r; this._direction = "forwards"; }
  collapseToEnd() { if (!this._range) throw __jb.domError("InvalidStateError", "no range"); var r = new Range(); r._start = this._range._end; r._end = this._range._end; this._range = r; this._direction = "forwards"; }
  extend(node, offset) {
    __jb.expectNode(node); offset = offset >>> 0;
    if (__jb.rootOf(node) !== __jb.currentDocument) return;
    if (!this._range) throw __jb.domError("InvalidStateError", "no range");
    if (node.nodeType === 10) throw __jb.domError("InvalidNodeTypeError", "doctype");
    if (offset > __jb.nodeLength(node)) throw __jb.domError("IndexSizeError", "offset");
    var anchor = [this.anchorNode, this.anchorOffset];
    var r = new Range();
    if (__jb.rootOf(node) !== __jb.rootOf(anchor[0])) { r._start = [node, offset]; r._end = [node, offset]; }
    else if (__jb.compareBoundary(anchor[0], anchor[1], node, offset) <= 0) { r._start = anchor; r._end = [node, offset]; }
    else { r._start = [node, offset]; r._end = anchor; }
    this._range = r;
    this._direction = __jb.compareBoundary(node, offset, anchor[0], anchor[1]) < 0 ? "backwards" : "forwards";
  }
  setBaseAndExtent(an, ao, fn, fo) {
    __jb.expectNode(an); __jb.expectNode(fn); ao = ao >>> 0; fo = fo >>> 0;
    if (ao > __jb.nodeLength(an) || fo > __jb.nodeLength(fn)) throw __jb.domError("IndexSizeError", "offset");
    if (__jb.rootOf(an) !== __jb.currentDocument || __jb.rootOf(fn) !== __jb.currentDocument) return;
    var r = new Range();
    if (__jb.compareBoundary(an, ao, fn, fo) <= 0) { r._start = [an, ao]; r._end = [fn, fo]; this._direction = "forwards"; } else { r._start = [fn, fo]; r._end = [an, ao]; this._direction = "backwards"; }
    this._range = r;
  }
  selectAllChildren(node) { __jb.expectNode(node); if (node.nodeType === 10) throw __jb.domError("InvalidNodeTypeError", "doctype"); if (__jb.rootOf(node) !== __jb.currentDocument) return; var r = new Range(); r._start = [node, 0]; r._end = [node, node.childNodes.length]; this._range = r; this._direction = "forwards"; }
  modify() {}
  deleteFromDocument() { if (this._range) this._range.deleteContents(); }
  containsNode(node, allowPartial) { __jb.expectNode(node); if (!this._range || __jb.rootOf(node) !== __jb.currentDocument) return false; var s = this._range._start, e = this._range._end; if (!node.parentNode) return false; var i = __jb.nodeIndex(node); var startBefore = __jb.compareBoundary(s[0], s[1], node.parentNode, i) <= 0, endAfter = __jb.compareBoundary(e[0], e[1], node.parentNode, i + 1) >= 0; if (!allowPartial) return startBefore && endAfter; return __jb.compareBoundary(s[0], s[1], node.parentNode, i + 1) < 0 && __jb.compareBoundary(e[0], e[1], node.parentNode, i) > 0; }
  getComposedRanges() { return this._range ? [new StaticRange({ startContainer: this._range.startContainer, startOffset: this._range.startOffset, endContainer: this._range.endContainer, endOffset: this._range.endOffset })] : []; }
  toString() { return this._range ? this._range.toString() : ""; }
}
__jb.setTag(Selection, "Selection");
__jb.selectionConstructing = true;
__jb.selection = new Selection();
__jb.selectionConstructing = false;
var NodeFilter = { FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3, SHOW_ALL: 0xffffffff, SHOW_ELEMENT: 1, SHOW_ATTRIBUTE: 2, SHOW_TEXT: 4, SHOW_CDATA_SECTION: 8, SHOW_ENTITY_REFERENCE: 16, SHOW_ENTITY: 32, SHOW_PROCESSING_INSTRUCTION: 64, SHOW_COMMENT: 128, SHOW_DOCUMENT: 256, SHOW_DOCUMENT_TYPE: 512, SHOW_DOCUMENT_FRAGMENT: 1024, SHOW_NOTATION: 2048 };
__jb.filterNode = function (walker, node) {
  if (walker._active) throw __jb.domError("InvalidStateError", "filter is already active");
  var bit = 1 << (node.nodeType - 1);
  if (!(walker.whatToShow & bit)) return 3;
  if (!walker.filter) return 1;
  walker._active = true;
  var result;
  try { result = typeof walker.filter === "function" ? walker.filter(node) : walker.filter.acceptNode(node); }
  finally { walker._active = false; }
  return Number(result);
};
class NodeIterator {
  constructor() { if (!__jb.walkerConstructing) throw new TypeError("Illegal constructor"); }
  _traverse(next) {
    var node = this.referenceNode, before = this.pointerBeforeReferenceNode;
    var all = __jb.allNodes(this.root);
    var i = all.indexOf(node);
    for (;;) {
      if (next) { if (!before) i++; before = false; }
      else { if (before) i--; before = true; }
      if (i < 0 || i >= all.length) return null;
      node = all[i];
      if (__jb.filterNode(this, node) === 1) break;
    }
    this.referenceNode = node; this.pointerBeforeReferenceNode = before;
    return node;
  }
  nextNode() { return this._traverse(true); }
  previousNode() { return this._traverse(false); }
  detach() {}
}
__jb.setTag(NodeIterator, "NodeIterator");
class TreeWalker {
  constructor() { if (!__jb.walkerConstructing) throw new TypeError("Illegal constructor"); }
  get currentNode() { return this._current; }
  set currentNode(n) { __jb.expectNode(n); this._current = n; }
  parentNode() { var n = this._current; while (n && n !== this.root) { n = n.parentNode; if (n && __jb.filterNode(this, n) === 1) { this._current = n; return n; } } return null; }
  _child(first) {
    var node = this._current;
    node = first ? node.firstChild : node.lastChild;
    while (node) {
      var r = __jb.filterNode(this, node);
      if (r === 1) { this._current = node; return node; }
      if (r === 3) { var c = first ? node.firstChild : node.lastChild; if (c) { node = c; continue; } }
      for (;;) {
        var sib = first ? node.nextSibling : node.previousSibling;
        if (sib) { node = sib; break; }
        var p = node.parentNode;
        if (!p || p === this.root || p === this._current) return null;
        node = p;
      }
    }
    return null;
  }
  firstChild() { return this._child(true); }
  lastChild() { return this._child(false); }
  _sibling(next) {
    var node = this._current;
    if (node === this.root) return null;
    for (;;) {
      var sib = next ? node.nextSibling : node.previousSibling;
      while (sib) {
        node = sib;
        var r = __jb.filterNode(this, node);
        if (r === 1) { this._current = node; return node; }
        sib = next ? node.firstChild : node.lastChild;
        if (r === 2 || !sib) sib = next ? node.nextSibling : node.previousSibling;
      }
      node = node.parentNode;
      if (!node || node === this.root) return null;
      if (__jb.filterNode(this, node) === 1) return null;
    }
  }
  nextSibling() { return this._sibling(true); }
  previousSibling() { return this._sibling(false); }
  previousNode() {
    var node = this._current;
    while (node !== this.root) {
      var sib = node.previousSibling;
      while (sib) {
        node = sib;
        var r = __jb.filterNode(this, node);
        while (r !== 2 && node.lastChild) { node = node.lastChild; r = __jb.filterNode(this, node); }
        if (r === 1) { this._current = node; return node; }
        sib = node.previousSibling;
      }
      if (node === this.root || !node.parentNode) return null;
      node = node.parentNode;
      if (__jb.filterNode(this, node) === 1) { this._current = node; return node; }
    }
    return null;
  }
  nextNode() {
    var node = this._current, result = 1;
    for (;;) {
      while (result !== 2 && node.firstChild) { node = node.firstChild; result = __jb.filterNode(this, node); if (result === 1) { this._current = node; return node; } }
      var sibling = null, temp = node;
      while (temp && temp !== this.root) { sibling = temp.nextSibling; if (sibling) break; temp = temp.parentNode; }
      if (!sibling || !temp || temp === this.root) return null;
      node = sibling;
      result = __jb.filterNode(this, node);
      if (result === 1) { this._current = node; return node; }
    }
  }
}
__jb.setTag(TreeWalker, "TreeWalker");
__jb.makeWalker = function (C, root, whatToShow, filter) {
  __jb.expectNode(root, "Argument 1");
  if (filter !== undefined && filter !== null && typeof filter !== "function" && typeof filter !== "object") throw new TypeError("filter is not an object");
  __jb.walkerConstructing = true;
  var w;
  try { w = new C(); } finally { __jb.walkerConstructing = false; }
  if (C === NodeIterator) __jb.nodeIterators.add(w);
  Object.defineProperty(w, "root", { value: root, enumerable: true });
  Object.defineProperty(w, "whatToShow", { value: whatToShow === undefined ? 0xffffffff : whatToShow >>> 0, enumerable: true });
  Object.defineProperty(w, "filter", { value: filter === undefined ? null : filter, enumerable: true });
  w._active = false;
  if (C === NodeIterator) { w.referenceNode = root; w.pointerBeforeReferenceNode = true; } else w._current = root;
  return w;
};

// ---- CSSOM (light) ----
class CSSStyleSheet { constructor(text) { this.cssRules = []; this.rules = this.cssRules; this.disabled = false; this.href = null; this.media = { mediaText: "", appendMedium: function () {}, deleteMedium: function () {} }; this.ownerNode = null; this.type = "text/css"; this.title = null; this.parentStyleSheet = null; if (typeof text === "string") this._parseInto(text); }
_parseInto(text) { var self_ = this; this.cssRules.length = 0; __jb.parseCssText(text).forEach(function (r) { r.parentStyleSheet = self_; self_.cssRules.push(r); }); } insertRule(rule, index) { this._cssomModified = true; __jb.domVersion++; var parsed = __jb.parseCssText(String(rule)); if (parsed.length !== 1) throw __jb.domError("SyntaxError", "Failed to parse the rule '" + rule + "'."); var r = parsed[0]; r.parentStyleSheet = this; this.cssRules.splice(index === undefined ? this.cssRules.length : index, 0, r); return index === undefined ? this.cssRules.length - 1 : index; } deleteRule(i) { this._cssomModified = true; __jb.domVersion++; this.cssRules.splice(i, 1); } addRule(sel, style, index) { return this.insertRule(sel + "{" + style + "}", index); } removeRule(i) { this.deleteRule(i); } replaceSync(text) { this._cssomModified = true; __jb.domVersion++; this._parseInto(String(text)); } replace(text) { this.replaceSync(text); return Promise.resolve(this); } }
// CSS text -> rule objects: style rules, grouping rules (@media, @supports, @container, @layer, ...)
// with nested cssRules, @keyframes with keyframe rules, other at-rules as single rules.
__jb.parseCssText = function (css, keyframeBody) {
  css = String(css);
  var out = [], i = 0, n = css.length;
  var GROUP = /^@(media|supports|container|layer|document|scope|starting-style|-moz-document)\b/i;
  var KEYFRAMES = /^@(-webkit-|-moz-)?keyframes\b/i;
  while (i < n) {
    // skip whitespace and comments
    while (i < n) { if (/\s/.test(css.charAt(i))) i++; else if (css.charAt(i) === "/" && css.charAt(i + 1) === "*") { var ce = css.indexOf("*/", i + 2); i = ce < 0 ? n : ce + 2; } else break; }
    if (i >= n) break;
    var j = i, q = null, depth = 0;
    while (j < n) {
      var c = css.charAt(j);
      if (q) { if (c === "\\") j++; else if (c === q) q = null; j++; continue; }
      if (c === '"' || c === "'") { q = c; j++; continue; }
      if (c === "/" && css.charAt(j + 1) === "*") { var e1 = css.indexOf("*/", j + 2); j = e1 < 0 ? n : e1 + 2; continue; }
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (depth <= 0 && (c === "{" || c === ";" || c === "}")) break;
      j++;
    }
    var prelude = css.slice(i, j).trim();
    if (j >= n || css.charAt(j) === ";" || css.charAt(j) === "}") {
      // statement at-rule (@import, @charset, @namespace, @layer a, b;)
      if (prelude.charAt(0) === "@") out.push({ cssText: prelude + ";", selectorText: prelude, type: /^@import/i.test(prelude) ? 3 : /^@namespace/i.test(prelude) ? 10 : /^@charset/i.test(prelude) ? 2 : 0, parentStyleSheet: null, cssRules: [], media: { mediaText: "" }, conditionText: "", href: (/^@import\s+(?:url\()?["']?([^"')\s;]+)/i.exec(prelude) || [])[1] || "" });
      i = j + 1;
      continue;
    }
    // block: find the matching '}'
    var k = j + 1, d = 1; q = null;
    while (k < n && d > 0) {
      var ch = css.charAt(k);
      if (q) { if (ch === "\\") k++; else if (ch === q) q = null; k++; continue; }
      if (ch === "/" && css.charAt(k + 1) === "*") { var e2 = css.indexOf("*/", k + 2); k = e2 < 0 ? n : e2 + 2; continue; }
      if (ch === '"' || ch === "'") q = ch; else if (ch === "{") d++; else if (ch === "}") d--;
      k++;
    }
    var body = css.slice(j + 1, d > 0 ? n : k - 1), whole = css.slice(i, k);
    i = k;
    if (GROUP.test(prelude) || KEYFRAMES.test(prelude)) {
      var kf = KEYFRAMES.test(prelude), cond = prelude.replace(/^@[\w-]+\s*/, "");
      var group = { cssText: whole, selectorText: prelude, type: kf ? 7 : /^@media/i.test(prelude) ? 4 : /^@supports/i.test(prelude) ? 12 : 0, parentStyleSheet: null, media: { mediaText: /^@media/i.test(prelude) ? __jb.normalizeMedia(cond) : "" }, conditionText: /^@media/i.test(prelude) ? __jb.normalizeMedia(cond) : cond, name: kf ? cond : undefined, cssRules: [] };
      group.cssRules = kf ? __jb.parseCssText(body, true).map(function (r) { r.type = 8; r.keyText = r.selectorText; r.parentRule = group; return __jb.brandCssRule(r); }) : __jb.parseCssText(body).map(function (r) { r.parentRule = group; return r; });
      group.insertRule = function (text, index) { var parsed = __jb.parseCssText(String(text)); if (parsed.length !== 1) throw __jb.domError("SyntaxError", "Failed to parse the rule."); index = index === undefined ? 0 : index >>> 0; if (index > group.cssRules.length) throw __jb.domError("IndexSizeError", "Index out of range."); group.cssRules.splice(index, 0, parsed[0]); group.cssText = prelude + " {\n" + group.cssRules.map(function (r) { return "  " + r.cssText; }).join("\n") + "\n}"; if (group.parentStyleSheet) { group.parentStyleSheet._cssomModified = true; } __jb.domVersion++; return index; };
      group.deleteRule = function (index) { index = index >>> 0; if (index >= group.cssRules.length) throw __jb.domError("IndexSizeError", "Index out of range."); group.cssRules.splice(index, 1); group.cssText = prelude + " {\n" + group.cssRules.map(function (r) { return "  " + r.cssText; }).join("\n") + "\n}"; __jb.domVersion++; };
      out.push(group);
    } else {
      if (/^@property\b/i.test(prelude) && typeof __jb.propertyRuleValid === "function") {
        if (!__jb.propertyRuleValid(prelude, whole)) continue;
        whole = __jb.propertyRuleText(prelude, whole);
      }
      // a style rule whose selector does not parse is dropped (insertRule then throws)
      // (namespace prefixes need the sheet's @namespace rules: such selectors are left alone)
      if (!keyframeBody && prelude.charAt(0) !== "@" && prelude.indexOf("&") < 0 && prelude.indexOf("|") < 0 && typeof __jb.parseSelectorList === "function") {
        try { __jb.parseSelectorList(prelude.replace(/\/\*[\s\S]*?\*\//g, " ").trim()); } catch (e) { continue; }
      }
      // style rules (their blocks may nest rules); keyframe selectors stay plain rules
      if (!keyframeBody && prelude.charAt(0) !== "@" && typeof __jb.parseNestedStyleRule === "function") out.push(__jb.parseNestedStyleRule(prelude, body, null));
      else out.push(__jb.parseCssRule(whole));
    }
  }
  return out.map(function (r) { return r.type === 8 ? r : __jb.brandCssRule(r); });
};
__jb.parseCssRule = function (text) { var m = /^\s*([^{]+)\{([\s\S]*)\}\s*$/.exec(text); var sel = m ? m[1].trim() : text.trim(); var decl = new CSSStyleDeclaration(null); decl._load(m ? m[2] : "");
  // style rules: the CSSOM serialization of the selector (and of the rule when it holds only declarations)
  var lazyText = false;
  if (m && sel.charAt(0) !== "@" && typeof __jb.canonicalSelector === "function") { sel = __jb.canonicalSelector(sel); if (m[2].indexOf("{") < 0) { if (!__jb.wptMode && !(typeof __jb.topJb === "function" && __jb.topJb().wptMode)) lazyText = true; else { var dt = decl.cssText; text = sel + " { " + (dt ? dt + " " : "") + "}"; } } } var rule = { cssText: text, selectorText: sel, style: __jb.styleProxy(decl), type: sel.charAt(0) === "@" ? (sel.indexOf("@media") === 0 ? 4 : sel.indexOf("@keyframes") === 0 ? 7 : sel.indexOf("@font-face") === 0 ? 5 : 0) : 1, parentStyleSheet: null, cssRules: [] }; if (sel.charAt(0) === "@") { rule.media = { mediaText: sel.replace(/^@media\s*/, "") }; rule.conditionText = sel.replace(/^@\w+\s*/, ""); }
  if (lazyText) { var own = function (o, v) { Object.defineProperty(o, "cssText", { value: v, writable: true, enumerable: true, configurable: true }); }; Object.defineProperty(rule, "cssText", { get: function () { var d = decl.cssText, v = sel + " { " + (d ? d + " " : "") + "}"; own(this, v); return v; }, set: function (v) { own(this, v); }, enumerable: true, configurable: true }); }
  rule.style.parentRule = rule; return rule; };
// CSS Nesting in the CSSOM: a style rule's block holds declarations, nested style rules
// (relative selectors get an implicit "& "), nested group rules and CSSNestedDeclarations.
__jb.splitRuleBlock = function (body) {
  // -> [{decls: text} | {prelude, block}] in order
  var out = [], i = 0, n = body.length, start = 0, q = null, depth = 0;
  var pushDecls = function (t) { if (t.trim()) out.push({ decls: t }); };
  while (i < n) {
    var c = body.charAt(i);
    if (q) { if (c === "\\") i++; else if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'") { q = c; i++; continue; }
    if (c === "/" && body.charAt(i + 1) === "*") { var e = body.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth <= 0 && c === ";") { pushDecls(body.slice(start, i + 1)); start = i + 1; }
    else if (depth <= 0 && c === "{") {
      // a nested rule unless this is a declaration value block (custom property {..})
      var pre = body.slice(start, i), colon = pre.replace(/\([^)]*\)|\[[^\]]*\]/g, "").indexOf(":");
      var looksDecl = /^\s*--[\w-]+\s*:/.test(pre) || (colon > 0 && !/^\s*[&>+~.#\[*:@]/.test(pre) && /^\s*[a-zA-Z-]+\s*:/.test(pre) && !/^\s*[a-zA-Z-]+\s*:{1,2}[a-zA-Z-]+(\(|\s*$)/.test(pre.trim()));
      var k = i + 1, d = 1, q2 = null;
      while (k < n && d > 0) { var ch = body.charAt(k); if (q2) { if (ch === "\\") k++; else if (ch === q2) q2 = null; k++; continue; } if (ch === '"' || ch === "'") q2 = ch; else if (ch === "{") d++; else if (ch === "}") d--; k++; }
      if (looksDecl) { i = k; continue; }
      out.push({ prelude: pre.trim(), block: body.slice(i + 1, d > 0 ? n : k - 1) });
      start = k; i = k; continue;
    }
    i++;
  }
  pushDecls(body.slice(start));
  return out;
};
__jb.relativeNestedSelector = function (sel) {
  return __jb.splitSelectorList(sel).map(function (part) {
    if (part.indexOf("&") >= 0) return part;
    return /^[>+~]/.test(part) ? "& " + part : "& " + part;
  }).join(", ");
};
__jb.ruleList = function (arr) {
  if (!arr.item) Object.defineProperty(arr, "item", { value: function (i) { i = i >>> 0; return i < this.length ? this[i] : null; }, configurable: true });
  return arr;
};
__jb.indentCss = function (t) { return "  " + t; };
__jb.makeNestedDeclarations = function (declText, parent) {
  var decl = new CSSStyleDeclaration(null); decl._load(declText);
  var r = { selectorText: "", style: __jb.styleProxy(decl), type: 0, parentStyleSheet: null, parentRule: parent, cssRules: __jb.ruleList([]), _nestedDecls: true };
  Object.defineProperty(r, "cssText", { get: function () { return this.style.cssText; }, set: function () {}, enumerable: true, configurable: true });
  r.style.parentRule = r;
  if (typeof CSSNestedDeclarations === "function") Object.setPrototypeOf(r, CSSNestedDeclarations.prototype);
  return r;
};
// style rule text (block may contain nested rules) -> rule object
__jb.parseNestedStyleRule = function (sel, body, parent) {
  var items = __jb.splitRuleBlock(body), decls = "", rules = [], seenRule = false;
  var rule;
  items.forEach(function (it) {
    if (it.decls !== undefined) {
      if (!seenRule) decls += it.decls;
      else rules.push({ nestedDecls: it.decls });
    } else { seenRule = true; rules.push(it); }
  });
  rule = __jb.parseCssRule(sel + " {" + decls + "}");
  var list = __jb.ruleList([]);
  rules.forEach(function (it) {
    var child = __jb.parseNestedChild(it, rule);
    if (child) list.push(child);
  });
  __jb.attachNesting(rule, list);
  rule.parentRule = parent || null;
  return rule;
};
__jb.parseNestedChild = function (it, parent) {
  if (it.nestedDecls !== undefined) { var nd = __jb.makeNestedDeclarations(it.nestedDecls, parent); return nd.style.length ? nd : null; }
  if (it.prelude.charAt(0) === "@") {
    if (!/^@(media|supports|container|layer|scope|starting-style)\b/i.test(it.prelude)) return null;
    // a group rule inside a style rule: its declarations are nested declarations
    var g = __jb.parseCssText(it.prelude + " {}")[0];
    if (!g) return null;
    var inner = __jb.splitRuleBlock(it.block), gl = __jb.ruleList([]);
    inner.forEach(function (x) { var c = x.decls !== undefined ? __jb.parseNestedChild({ nestedDecls: x.decls }, g) : __jb.parseNestedChild(x, g); if (c) gl.push(c); });
    g.cssRules = gl;
    g.parentRule = parent;
    Object.defineProperty(g, "cssText", { get: function () { return __jb.rulePrelude(this) + " {" + (this.cssRules.length ? "\n" + __jb.A.map.call(this.cssRules, function (r) { return __jb.indentCss(r.cssText); }).join("\n") + "\n" : " ") + "}"; }, set: function () {}, enumerable: true, configurable: true });
    return g;
  }
  var sel = __jb.relativeNestedSelector(it.prelude);
  try { __jb.parseSelectorList(sel.replace(/&/g, ":scope")); } catch (e) { return null; }
  if (typeof __jb.canonicalSelector === "function") sel = __jb.canonicalSelector(sel);
  return __jb.brandCssRule(__jb.parseNestedStyleRule(sel, it.block, parent));
};
__jb.attachNesting = function (rule, list) {
  list.forEach(function (r) { r.parentRule = rule; });
  rule.cssRules = list;
  var sel0 = rule.selectorText;
  Object.defineProperty(rule, "selectorText", {
    get: function () { return sel0; },
    set: function (v) {
      v = String(v);
      var nested = !!this.parentRule && !this.parentStyleSheet;
      var probe = nested ? __jb.relativeNestedSelector(v).replace(/&/g, ":scope") : v.replace(/&/g, ":scope");
      try { __jb.parseSelectorList(probe.replace(/\/\*[\s\S]*?\*\//g, " ").trim()); } catch (e) { return; }
      sel0 = typeof __jb.canonicalSelector === "function" ? __jb.canonicalSelector(nested ? __jb.relativeNestedSelector(v) : v) : v;
      __jb.domVersion++;
      for (var p = this; p; p = p.parentRule) if (p.parentStyleSheet) { p.parentStyleSheet._cssomModified = true; break; }
    },
    enumerable: true, configurable: true,
  });
  Object.defineProperty(rule, "cssText", {
    get: function () {
      var d = this.style.cssText;
      if (!this.cssRules.length) return this.selectorText + " { " + (d ? d + " " : "") + "}";
      var parts = [];
      if (d) parts.push(__jb.indentCss(d));
      Array.prototype.forEach.call(this.cssRules, function (r) { parts.push(__jb.indentCss(r.cssText)); });
      return this.selectorText + " {\n" + parts.join("\n") + "\n}";
    },
    set: function () {}, enumerable: true, configurable: true,
  });
  rule.insertRule = function (text, index) {
    if (arguments.length < 1) throw new TypeError("insertRule: At least 1 argument required");
    index = index === undefined ? 0 : index >>> 0;
    if (index > this.cssRules.length) throw __jb.domError("IndexSizeError", "Index out of range.");
    text = String(text).trim();
    var m = /^([^{]*)\{([\s\S]*)\}\s*$/.exec(text);
    var child = m ? __jb.parseNestedChild({ prelude: m[1].trim(), block: m[2] }, this) : __jb.parseNestedChild({ nestedDecls: text }, this);
    if (!child) throw __jb.domError("SyntaxError", "Failed to parse the rule '" + text + "'.");
    this.cssRules.splice(index, 0, child);
    __jb.domVersion++;
    for (var p = this; p; p = p.parentRule) if (p.parentStyleSheet) { p.parentStyleSheet._cssomModified = true; break; }
    return index;
  };
  rule.deleteRule = function (index) {
    if (arguments.length < 1) throw new TypeError("deleteRule: At least 1 argument required");
    index = index >>> 0;
    if (index >= this.cssRules.length) throw __jb.domError("IndexSizeError", "Index out of range.");
    this.cssRules.splice(index, 1);
    __jb.domVersion++;
    for (var p = this; p; p = p.parentRule) if (p.parentStyleSheet) { p.parentStyleSheet._cssomModified = true; break; }
  };
  return rule;
};
// CSSOM rule interfaces. Parsed rules are plain objects given the matching prototype.
class CSSRule { constructor() { throw new TypeError("Illegal constructor"); } }
(function () {
  var consts = { STYLE_RULE: 1, CHARSET_RULE: 2, IMPORT_RULE: 3, MEDIA_RULE: 4, FONT_FACE_RULE: 5, PAGE_RULE: 6, KEYFRAMES_RULE: 7, KEYFRAME_RULE: 8, MARGIN_RULE: 9, NAMESPACE_RULE: 10, COUNTER_STYLE_RULE: 11, SUPPORTS_RULE: 12, FONT_FEATURE_VALUES_RULE: 14 };
  Object.keys(consts).forEach(function (k) { var d = { value: consts[k], enumerable: true }; Object.defineProperty(CSSRule, k, d); Object.defineProperty(CSSRule.prototype, k, d); });
})();
class CSSGroupingRule extends CSSRule {}
class CSSStyleRule extends CSSGroupingRule {}
class CSSConditionRule extends CSSGroupingRule {}
class CSSMediaRule extends CSSConditionRule {}
class CSSSupportsRule extends CSSConditionRule {}
class CSSContainerRule extends CSSConditionRule {}
class CSSLayerBlockRule extends CSSGroupingRule {}
class CSSStartingStyleRule extends CSSGroupingRule {}
class CSSScopeRule extends CSSGroupingRule {}
class CSSLayerStatementRule extends CSSRule {}
class CSSImportRule extends CSSRule {}
class CSSNamespaceRule extends CSSRule {}
class CSSFontFaceRule extends CSSRule {}
class CSSPageRule extends CSSGroupingRule {}
class CSSKeyframesRule extends CSSRule {}
class CSSKeyframeRule extends CSSRule {}
class CSSPropertyRule extends CSSRule {}
class CSSCounterStyleRule extends CSSRule {}
class CSSFontFeatureValuesRule extends CSSRule {}
__jb.brandCssRule = function (r) {
  var sel = String(r.selectorText !== undefined ? r.selectorText || "" : r._prelude || ""), at = /^@([\w-]+)/.exec(sel), name = at ? at[1].toLowerCase() : "";
  var proto;
  if (r.type === 8) proto = CSSKeyframeRule;
  else if (!at) proto = CSSStyleRule;
  else proto = ({ media: CSSMediaRule, supports: CSSSupportsRule, container: CSSContainerRule, "starting-style": CSSStartingStyleRule, scope: CSSScopeRule, "import": CSSImportRule, namespace: CSSNamespaceRule, "font-face": CSSFontFaceRule, page: CSSPageRule, keyframes: CSSKeyframesRule, "-webkit-keyframes": CSSKeyframesRule, property: CSSPropertyRule, "counter-style": CSSCounterStyleRule, "font-feature-values": CSSFontFeatureValuesRule })[name] || CSSRule;
  if (name === "layer") proto = /;\s*$/.test(String(r.cssText || "")) ? CSSLayerStatementRule : CSSLayerBlockRule;
  if (name === "layer" && proto === CSSLayerStatementRule) r.nameList = sel.replace(/^@layer\s*/i, "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  if (name === "layer" && proto === CSSLayerBlockRule) r.name = sel.replace(/^@layer\s*/i, "").trim();
  if (proto === CSSStyleRule || proto === CSSKeyframeRule || proto === CSSFontFaceRule || proto === CSSPageRule) { delete r.conditionText; delete r.media; }
  // Only style rules (and @page) have selectorText; other at-rules keep their prelude in a
  // hidden slot (pages filter `rule.selectorText && el.matches(rule.selectorText)`).
  if (at && proto !== CSSPageRule && Object.prototype.hasOwnProperty.call(r, "selectorText")) {
    Object.defineProperty(r, "_prelude", { value: sel, writable: true, configurable: true, enumerable: false });
    delete r.selectorText;
  }
  Object.setPrototypeOf(r, proto.prototype);
  return r;
};
__jb.rulePrelude = function (r) { return r.selectorText !== undefined ? String(r.selectorText) : String(r._prelude || ""); };
var CSS = { supports: function (a, b) { if (arguments.length < 1) throw new TypeError("CSS.supports: At least 1 argument required"); if (arguments.length >= 2 && typeof __jb.cssSupports === "function") { var r = __jb.cssSupports(a, b); if (r !== null) return r; } if (arguments.length === 1 && typeof __jb.cssSupportsCondition === "function") { var c = __jb.cssSupportsCondition(a); if (c !== null) return c; } return true; }, escape: function (s) { s = String(s); var out = ""; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i), ch = s.charAt(i); if (c === 0) out += "�"; else if ((c >= 1 && c <= 0x1f) || c === 0x7f || (i === 0 && c >= 0x30 && c <= 0x39) || (i === 1 && c >= 0x30 && c <= 0x39 && s.charAt(0) === "-")) out += "\\" + c.toString(16) + " "; else if (i === 0 && c === 0x2d && s.length === 1) out += "\\" + ch; else if (c >= 0x80 || c === 0x2d || c === 0x5f || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) out += ch; else out += "\\" + ch; } return out; }, registerProperty: function () {}, px: function (v) { return v + "px"; }, number: function (v) { return v; }, paintWorklet: { addModule: function () { return Promise.resolve(); } }, highlights: new Map() };
class MediaQueryList extends EventTarget { constructor(q) { super(); this.media = __jb.normalizeMedia(q); this.matches = this.media === "not all" ? false : __jb.evalMediaQuery(this.media); this.onchange = null; } addListener(f) { this.addEventListener("change", f); } removeListener(f) { this.removeEventListener("change", f); } }
__jb.evalMediaQuery = function (q) {
  var width = 1280, height = 720;
  q = String(q).trim();
  if (q.indexOf(",") >= 0) return q.split(",").some(function (part) { return part.trim() !== "" && __jb.evalMediaQuery(part); });
  var lower = q.toLowerCase();
  if (lower === "" || lower === "all") return true;
  if (/[!]|\(\s*\)|\band\s*$/.test(lower) || /^(and|or)\b/.test(lower) || /^(not|only)\s+(and|or)\b/.test(lower)) return false; // invalid query evaluates to "not all"
  if (/^not\s+/.test(lower)) return !__jb.evalMediaQuery(q.replace(/^not\s+/i, ""));
  if (/^only\s+/.test(lower)) return __jb.evalMediaQuery(q.replace(/^only\s+/i, ""));
  if (/^(speech|tty|tv|projection|handheld|braille|embossed|aural)\b/.test(lower)) return false;
  if (/prefers-color-scheme:\s*dark/.test(q)) return false;
  if (/prefers-reduced-motion:\s*reduce/.test(q)) return false;
  if (/prefers-reduced-motion:\s*no-preference/.test(q)) return true;
  if (/hover:\s*hover/.test(q) || /pointer:\s*fine/.test(q)) return true;
  if (/hover:\s*none/.test(q) || /pointer:\s*coarse/.test(q)) return false;
  if (/orientation:\s*landscape/.test(q)) return true;
  if (/orientation:\s*portrait/.test(q)) return false;
  if (/\bprint\b/.test(q) && !/not\s+print/.test(q)) return false;
  var ok = true;
  q.replace(/\((min|max)-(width|height):\s*([\d.]+)(px|em|rem)?\)/g, function (m, minmax, dim, num, unit) {
    var v = parseFloat(num) * (unit === "em" || unit === "rem" ? 16 : 1);
    var actual = dim === "width" ? width : height;
    if (minmax === "min" && actual < v) ok = false;
    if (minmax === "max" && actual > v) ok = false;
    return m;
  });
  return ok;
};
globalThis.matchMedia = function matchMedia(q) { return new MediaQueryList(q); }
globalThis.getComputedStyle = function getComputedStyle(el, pseudo) {
  if (!(el instanceof Element)) {
    // an element of another realm (a frame's document): Element is checked by interface, not by realm;
    // its own window answers (react-focus-lock on Coursera walks into frames)
    if (!(el && typeof el === "object" && el.nodeType === 1 && el._tag !== undefined)) throw new TypeError("getComputedStyle: Argument 1 is not an Element");
    var ow = null;
    try { ow = el.ownerDocument && el.ownerDocument.defaultView; } catch (e) {}
    if (ow && ow !== globalThis && typeof ow.getComputedStyle === "function") return ow.getComputedStyle(el, pseudo);
  }
  var decl = new CSSStyleDeclaration(null);
  // Real pages: build the script-side fallback without a Stylo round trip per property (connected
  // elements answer from Stylo's cascade anyway); WPT keeps the normalized values.
  var jsOnly = !__jb.wptMode;
  var computedFor = !pseudo && el.isConnected && el.ownerDocument === __jb.currentDocument;
  // Real pages: the fallback (a JS cascade over every <style> text, ~1.2 ms per call) is built only
  // when a read is not answered by Stylo (display:none subtrees, no layout); observing a 6.6k-element
  // page called getComputedStyle per candidate and spent 75 s building fallbacks nobody read.
  if (jsOnly && computedFor) {
    Object.defineProperty(decl, "_props", { configurable: true, enumerable: false,
      get: function () {
        var tmp = new CSSStyleDeclaration(null);
        __jb.gcsFallback(tmp, el);
        Object.defineProperty(this, "_props", { value: tmp._props, writable: true, configurable: true, enumerable: false });
        for (var k in tmp._priority) this._priority[k] = tmp._priority[k];
        return tmp._props;
      },
      set: function (v) { Object.defineProperty(this, "_props", { value: v, writable: true, configurable: true, enumerable: false }); } });
    Object.defineProperty(decl, "_computedFor", { value: el });
    return __jb.styleProxy(decl);
  }
  if (jsOnly) Object.defineProperty(decl, "_jsOnly", { value: true, writable: true, configurable: true });
  __jb.gcsFallback(decl, el);
  if (jsOnly) decl._jsOnly = false;
  if (computedFor) Object.defineProperty(decl, "_computedFor", { value: el });
  return __jb.styleProxy(decl);
}
// The script-side computed-style model of `el` (defaults, UA states, <style> rules, inline style),
// filled into decl._props; the fallback when the layout engine has no value.
__jb.gcsFallback = function (decl, el) {
  if (!__jb.wptMode) Object.defineProperty(decl, "_jsOnly", { value: true, writable: true, configurable: true });
  var inline = el.getAttribute("style") || "";
  var defaults = { display: /^(span|a|b|i|em|strong|code|img|input|button|label|small|sub|sup|u|s|abbr|cite|q|time|mark|kbd|var|samp|br|wbr|select|textarea)$/.test(el._tag) ? "inline" : /^(script|style|head|meta|link|title|template|noscript)$/.test(el._tag) ? "none" : /^(li)$/.test(el._tag) ? "list-item" : /^(table)$/.test(el._tag) ? "table" : /^(tr)$/.test(el._tag) ? "table-row" : /^(td|th)$/.test(el._tag) ? "table-cell" : "block", visibility: "visible", opacity: "1", position: "static", color: "rgb(0, 0, 0)", "background-color": "rgba(0, 0, 0, 0)", "font-size": "16px", "font-family": "serif", "font-weight": "400", "line-height": "normal", width: "auto", height: "auto", margin: "0px", padding: "0px", border: "0px none rgb(0, 0, 0)", "box-sizing": "content-box", overflow: "visible", "z-index": "auto", transform: "none", transition: "all 0s ease 0s", "pointer-events": "auto", direction: "ltr", "text-align": "start", "white-space": "normal", float: "none", cursor: "auto" };
  Object.keys(defaults).forEach(function (k) { decl._props.push([k, defaults[k]]); });
  if (el.hasAttribute("hidden")) decl.setProperty("display", "none");
  if (el._ns === __jb.HTML_NS && ((el.hasAttribute("popover") && el._popoverState !== "showing") || (el._tag === "dialog" && !el.hasAttribute("open") && el._popoverState !== "showing"))) decl.setProperty("display", "none"); // UA: [popover]:not(:popover-open), dialog:not([open])
  else if (el._ns === __jb.HTML_NS && (el._popoverState === "showing" || (el._tag === "dialog" && el._modal))) { decl.setProperty("position", "fixed"); decl.setProperty("display", "block"); }
  // Apply matching rules from <style> sheets (last wins, no specificity).
  try { __jb.gcsMatchingRules(el).forEach(function (r) { r.props.forEach(function (p) { decl.setProperty(p[0], p[1]); }); }); } catch (e) {}
  CSSStyleDeclaration._parse(inline).forEach(function (p) { decl.setProperty(p[0], p[1]); });
  if (!__jb.wptMode) decl._jsOnly = false;
};
// HTML rendering "maps to the dimension property" hints the layout engine does not apply;
// used only where the cascade left the property at its initial value.
__jb.parseDimensionValue = function (value, ignoreZero) {
  var m = /^[\t\n\f\r ]*([0-9]+(?:\.[0-9]*)?)(%?)/.exec(value);
  if (!m) return null;
  var n = parseFloat(m[1]);
  if (ignoreZero && n === 0) return null;
  var num = String(n);
  return m[2] ? num + "%" : num + "px";
};
__jb.DIMENSION_HINTS = {
  width: { hr: 0, td: 1, th: 1, table: 1, col: 0, marquee: 0, iframe: 0, embed: 0, object: 0, video: 0, img: 0 },
  height: { td: 1, th: 1, table: 0, tr: 0, marquee: 0, iframe: 0, embed: 0, object: 0, video: 0, img: 0 },
};
__jb.dimensionHint = function (el, prop, current) {
  if (el._ns !== __jb.HTML_NS) return null;
  var tag = el._tag, attr = null, ignoreZero = false;
  var imageInput = tag === "input" && __jb.inputType(el) === "image";
  if (prop === "width" || prop === "height") {
    if (current !== "auto") return null;
    var table = __jb.DIMENSION_HINTS[prop];
    if (imageInput) attr = prop; else if (table[tag] !== undefined) { attr = prop; ignoreZero = table[tag] === 1; }
  } else if (/^margin-(left|right)$/.test(prop) || /^margin-(top|bottom)$/.test(prop)) {
    if (current !== "0px") return null;
    if (/^(embed|img|object|marquee)$/.test(tag) || imageInput) attr = /left|right/.test(prop) ? "hspace" : "vspace";
  }
  if (!attr) return null;
  var raw = el.getAttribute(attr);
  // <source width/height> in a <picture> maps to the <img>.
  if (tag === "img" && (attr === "width" || attr === "height") && el.parentNode && el.parentNode._tag === "picture") {
    for (var srcEl = el.parentNode.firstElementChild; srcEl && srcEl !== el; srcEl = srcEl.nextElementSibling) if (srcEl._tag === "source" && srcEl.hasAttribute("srcset")) { if (srcEl.hasAttribute(attr)) raw = srcEl.getAttribute(attr); break; }
  }
  return raw === null ? null : __jb.parseDimensionValue(raw, ignoreZero);
};
// Resolved value of `prop` for a connected element from the layout engine, or null.
__jb.computedValue = function (el, prop) {
  if (!el.isConnected || typeof __jb.layoutQuery !== "function" || (__jb.layoutState && __jb.layoutState.available === false)) return null;
  // Real pages: an inline absolute font-size is the computed value (barring an !important rule), so
  // no relayout is needed. Highcharts creates each label and reads its font-size at once
  // (getStyle): 165 full relayouts (~300 ms each) per CoinMarketCap range switch.
  if (prop === "font-size" && !__jb.wptMode) {
    var ifs = el.getAttribute("style");
    if (ifs && ifs.indexOf("font-size") >= 0) {
      var mfs = /(?:^|;)\s*font-size\s*:\s*([0-9]*\.?[0-9]+)px\s*(;|$)/i.exec(ifs);
      if (mfs) return String(parseFloat(mfs[1])) + "px";
    }
  }
  // Descendants of display:none boxes have no computed style in the layout engine: skip the (expensive) relayout.
  for (var a = el.parentNode; a && a.nodeType === 1; a = a.parentNode) if (a.hasAttribute("hidden") || __jb.styleOf(a, "display") === "none") return null;
  if (el.__jbid === undefined || __jb.nodeById[el.__jbid] !== el) __jb.assignLayoutIds();
  var key = __jb.layoutKey();
  var c = el._csCache;
  if (!c || c.key !== key) { c = { key: key, values: Object.create(null) }; Object.defineProperty(el, "_csCache", { value: c, writable: true, configurable: true }); }
  if (prop in c.values) return c.values[prop];
  // Each DOM change means a full relayout: after many style-driven relayouts, use the light model.
  var stale = __jb.layoutState && __jb.layoutState.key !== key, now = Date.now(), built0 = __jb.layoutState && __jb.layoutState.builtAt;
  if (stale && !__jb.wptMode) {
    // a burst of style reads interleaved with DOM changes (each one a relayout): the light model
    if (now - (__jb.styleRelayoutsAt || 0) > 1000) __jb.styleRelayouts = 0;
    if (__jb.styleRelayouts > 50) return null;
  }
  var r = null;
  try { r = __jb.layoutQuery("style", { id: el.__jbid, props: [prop] }); } catch (e) { r = null; }
  if (stale && __jb.layoutState && __jb.layoutState.builtAt !== built0) { __jb.styleRelayouts = (__jb.styleRelayouts || 0) + 1; __jb.styleRelayoutsAt = now; }
  var v = r && typeof r === "object" && typeof r[prop] === "string" ? r[prop] : null;
  if (v !== null) { var hint = __jb.dimensionHint(el, prop, v); if (hint !== null) v = hint; }
  // CSS Display: elements with unusual contents compute display: contents to none.
  if (prop === "display" && v === "contents" && el._ns === __jb.HTML_NS && /^(br|wbr|meter|progress|canvas|embed|object|audio|iframe|img|video|frame|frameset|input|textarea|select)$/.test(el._tag)) v = "none";
  // The rendered legend is blockified: report its used size.
  if ((prop === "width" || prop === "height") && v === "auto" && el._tag === "legend" && typeof __jb.layoutRect === "function") { var lr = __jb.layoutRect(el); if (lr && lr.width > 0) { var bp = prop === "width" ? (lr.border[1] + lr.border[3] + lr.padding[1] + lr.padding[3]) : (lr.border[0] + lr.border[2] + lr.padding[0] + lr.padding[2]); v = Math.max(0, Math.round(((prop === "width" ? lr.width : lr.height) - bp) * 100) / 100) + "px"; } }
  c.values[prop] = v;
  return v;
};

// Computed (not resolved) value of `prop` (Typed OM computedStyleMap), or null.
__jb.computedOnlyValue = function (el, prop) {
  if (!el.isConnected || typeof __jb.layoutQuery !== "function" || (__jb.layoutState && __jb.layoutState.available === false)) return null;
  if (el.__jbid === undefined || __jb.nodeById[el.__jbid] !== el) __jb.assignLayoutIds();
  var r = null;
  try { r = __jb.layoutQuery("style", { id: el.__jbid, props: [prop], computedOnly: true }); } catch (e) { r = null; }
  return r && typeof r === "object" && typeof r[prop] === "string" ? r[prop] : null;
};

// ---- Document ----
class DOMImplementation {
  constructor() { if (!__jb.implConstructing) throw new TypeError("Illegal constructor"); }
  createDocumentType(qname, publicId, systemId) {
    if (arguments.length < 1) throw new TypeError("createDocumentType: 1 argument required");
    qname = String(qname);
    if (!__jb.validDoctypeName(qname)) throw __jb.domError("InvalidCharacterError", "invalid doctype name");
    var dt = new DocumentType(qname, publicId === undefined ? "" : publicId, systemId === undefined ? "" : systemId); dt._doc = this._doc; return dt;
  }
  createDocument(ns, qname, doctype) {
    if (arguments.length < 2) throw new TypeError("createDocument: 2 arguments required");
    var doc = new XMLDocument();
    doc._isHTML = false;
    var el = null;
    qname = qname === null ? "" : String(qname);
    if (qname !== "") el = doc.createElementNS(ns, qname);
    if (doctype !== undefined && doctype !== null) { if (!(doctype instanceof DocumentType)) throw new TypeError("createDocument: Argument 3 is not a DocumentType"); doc.appendChild(doctype); }
    if (el) doc.appendChild(el);
    doc._contentType = ns === __jb.HTML_NS ? "application/xhtml+xml" : ns === __jb.SVG_NS ? "image/svg+xml" : "application/xml";
    doc.URL = doc.documentURI = "about:blank";
    return doc;
  }
  createHTMLDocument(title) {
    var d = new Document();
    d._isHTML = true;
    d._contentType = "text/html";
    d.URL = d.documentURI = "about:blank";
    var dt = new DocumentType("html", "", ""); dt._doc = d; d._appendChildRaw(dt);
    var html = d.createElement("html"), head = d.createElement("head");
    if (title !== undefined) { var t = d.createElement("title"); t._appendChildRaw(d.createTextNode(String(title))); head._appendChildRaw(t); }
    html._appendChildRaw(head); html._appendChildRaw(d.createElement("body")); d._appendChildRaw(html);
    return d;
  }
  hasFeature() { return true; }
}
__jb.setTag(DOMImplementation, "DOMImplementation");
__jb.EVENT_INTERFACES = { beforeunloadevent: "BeforeUnloadEvent", compositionevent: "CompositionEvent", customevent: "CustomEvent", devicemotionevent: "DeviceMotionEvent", deviceorientationevent: "DeviceOrientationEvent", dragevent: "DragEvent", event: "Event", events: "Event", focusevent: "FocusEvent", hashchangeevent: "HashChangeEvent", htmlevents: "Event", keyboardevent: "KeyboardEvent", messageevent: "MessageEvent", mouseevent: "MouseEvent", mouseevents: "MouseEvent", storageevent: "StorageEvent", svgevents: "Event", textevent: "TextEvent", touchevent: "TouchEvent", uievent: "UIEvent", uievents: "UIEvent" };
class Document extends Node {
  constructor() {
    super(null);
    this._doc = null;
    // `new Document()` is an XML document; HTML documents (page loads,
    // createHTMLDocument, DOMParser text/html) set _isHTML explicitly.
    this._isHTML = false;
    this._contentType = "application/xml";
    this._jbActive = null;
    this.readyState = "complete";
    this.URL = "about:blank";
    this.documentURI = this.URL;
    this._jbCurrentScript = null;
    this.fonts = __jb.newFontFaceSet();
    this.adoptedStyleSheets = [];
    this._characterSet = "UTF-8";
    this._handlers = {};
  }
  get nodeType() { return 9; }
  get nodeName() { return "#document"; }
  get implementation() { if (!this._impl) { __jb.implConstructing = true; try { this._impl = new DOMImplementation(); } finally { __jb.implConstructing = false; } Object.defineProperty(this._impl, "_doc", { value: this }); } return this._impl; }
  get doctype() { for (var c = this.firstChild; c; c = c.nextSibling) if (c.nodeType === 10) return c; return null; }
  get documentElement() { for (var c = this.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) return c; return null; }
  get rootElement() { var de = this.documentElement; return de && de._ns === __jb.SVG_NS && de._local === "svg" ? de : null; }
  get head() { var h = this.documentElement; if (!h || !(h._tag === "html" && h._ns === __jb.HTML_NS)) return null; for (var c = h.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c._tag === "head" && c._ns === __jb.HTML_NS) return c; return null; }
  get body() { var h = this.documentElement; if (!h || !(h._tag === "html" && h._ns === __jb.HTML_NS)) return null; for (var c = h.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && (c._tag === "body" || c._tag === "frameset") && c._ns === __jb.HTML_NS) return c; return null; }
  set body(el) { if (!(el instanceof HTMLElement) || !(el._tag === "body" || el._tag === "frameset")) throw __jb.domError("HierarchyRequestError", "body must be a body or frameset element"); var old = this.body; if (old === el) return; if (old) { __jb.replaceChild(old.parentNode, el, old); return; } var root = this.documentElement; if (!root) throw __jb.domError("HierarchyRequestError", "no document element"); root.appendChild(el); }
  get title() {
    var root = this.documentElement;
    var t = null;
    if (root && root._tag === "svg" && root._ns === __jb.SVG_NS) { for (var c = root.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c._tag === "title" && c._ns === __jb.SVG_NS) { t = c; break; } }
    else t = __jb.descendants(this, function (n) { return n.nodeType === 1 && n._tag === "title" && n._ns === __jb.HTML_NS; })[0] || null;
    if (!t) return "";
    return t.textContent.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
  }
  set title(v) {
    v = String(v);
    var root = this.documentElement;
    if (!root) return;
    if (root._tag === "svg" && root._ns === __jb.SVG_NS) { var st = null; for (var c = root.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c._tag === "title" && c._ns === __jb.SVG_NS) { st = c; break; } if (!st) { st = this.createElementNS(__jb.SVG_NS, "title"); root.insertBefore(st, root.firstChild); } st.textContent = v; return; }
    if (root._ns !== __jb.HTML_NS) return;
    var t = __jb.descendants(this, function (n) { return n.nodeType === 1 && n._tag === "title" && n._ns === __jb.HTML_NS; })[0];
    if (!t) { var head = this.head; if (!head) return; t = this.createElement("title"); head.appendChild(t); }
    t.textContent = v;
  }
  get location() { return this === __jb.currentDocument ? globalThis.location : this._frameWindow ? this._frameWindow.location : null; } set location(v) { if (this === __jb.currentDocument) globalThis.location.href = v; else if (this._frameWindow) this._frameWindow.location = v; }
  get defaultView() { return this === __jb.currentDocument ? globalThis : (this._frameWindow || null); }
  get domain() { return this === __jb.currentDocument ? globalThis.location.hostname : ""; } set domain(v) {}
  get referrer() { return this._referrer || ""; }
  get lastModified() { var d = new Date(); var p = function (n) { return (n < 10 ? "0" : "") + n; }; return p(d.getMonth() + 1) + "/" + p(d.getDate()) + "/" + d.getFullYear() + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()); }
  get characterSet() { return this._characterSet; } get charset() { return this._characterSet; } get inputEncoding() { return this._characterSet; }
  get contentType() { return this._contentType; }
  get compatMode() { return this._quirks ? "BackCompat" : "CSS1Compat"; }
  get designMode() { return this._designMode || "off"; } set designMode(v) { v = String(v).toLowerCase(); if (v === "on" || v === "off") this._designMode = v; }
  get dir() { var r = this.documentElement; return r && r._tag === "html" && r._ns === __jb.HTML_NS ? r.dir : ""; } set dir(v) { var r = this.documentElement; if (r && r._tag === "html" && r._ns === __jb.HTML_NS) r.dir = v; }
  get hidden() { return false; } get visibilityState() { return "visible"; } get fullscreenElement() { return null; } get fullscreenEnabled() { return false; } get pictureInPictureElement() { return null; } get pointerLockElement() { return null; } get pictureInPictureEnabled() { return false; }
  get currentScript() { return this._jbCurrentScript || null; }
  get activeElement() { var el = typeof __jb.retargetFocus === "function" ? __jb.retargetFocus(this) : (this._jbActive && this._jbActive.isConnected ? this._jbActive : null); return el || this.body || null; }
  get forms() { var self_ = this; return __jb.liveCollection(function () { return __jb.descendants(self_, function (n) { return n.nodeType === 1 && n._tag === "form" && n._ns === __jb.HTML_NS; }); }); }
  get images() { var self_ = this; return __jb.liveCollection(function () { return __jb.descendants(self_, function (n) { return n.nodeType === 1 && n._tag === "img" && n._ns === __jb.HTML_NS; }); }); }
  get links() { var self_ = this; return __jb.liveCollection(function () { return __jb.descendants(self_, function (n) { return n.nodeType === 1 && (n._tag === "a" || n._tag === "area") && n._ns === __jb.HTML_NS && n.hasAttribute("href"); }); }); }
  get anchors() { var self_ = this; return __jb.liveCollection(function () { return __jb.descendants(self_, function (n) { return n.nodeType === 1 && n._tag === "a" && n._ns === __jb.HTML_NS && n.hasAttribute("name"); }); }); }
  get scripts() { var self_ = this; return __jb.liveCollection(function () { return __jb.descendants(self_, function (n) { return n.nodeType === 1 && n._tag === "script" && n._ns === __jb.HTML_NS; }); }); }
  get embeds() { var self_ = this; return __jb.liveCollection(function () { return __jb.descendants(self_, function (n) { return n.nodeType === 1 && n._tag === "embed" && n._ns === __jb.HTML_NS; }); }); }
  get plugins() { return this.embeds; }
  get applets() { return __jb.liveCollection(function () { return []; }); }
  get all() { var self_ = this; return __jb.liveCollection(function () { return __jb.descendants(self_, function (n) { return n.nodeType === 1; }); }); }
  get styleSheets() { return __jb.descendants(this, function (n) { return n.nodeType === 1 && (n._tag === "style" || (n._tag === "link" && /(^|\s)stylesheet(\s|$)/i.test(n.getAttribute("rel") || ""))); }).map(function (s) { var sh = new CSSStyleSheet(s._tag === "style" ? s.textContent : ""); sh.ownerNode = s; sh.href = s._tag === "link" ? s.href : null; return sh; }); }
  createElement(local, options) {
    if (arguments.length < 1) throw new TypeError("createElement: 1 argument required");
    local = String(local);
    if (this._isHTML) local = local.toLowerCase();
    if (!__jb.validElementLocalName(local)) throw __jb.domError("InvalidCharacterError", "'" + local + "' is not a valid element name");
    var is = options !== null && typeof options === "object" && options.is !== undefined ? String(options.is) : null;
    var ns = this._isHTML || this._contentType === "application/xhtml+xml" ? __jb.HTML_NS : null;
    return __jb.createElementInternal(this, local, ns, null, is, true);
  }
  createElementNS(ns, qname, options) {
    if (arguments.length < 2) throw new TypeError("createElementNS: 2 arguments required");
    var x = __jb.validateAndExtract(ns === null ? null : ns === undefined ? null : String(ns), qname === null ? "null" : qname === undefined ? "undefined" : qname, false);
    var is = options !== null && typeof options === "object" && options.is !== undefined ? String(options.is) : null;
    return __jb.createElementInternal(this, x.local, x.ns, x.prefix, is, true);
  }
  createTextNode(t) { if (arguments.length < 1) throw new TypeError("createTextNode: 1 argument required"); var n = new Text(String(t)); n._doc = this; return n; }
  createComment(t) { if (arguments.length < 1) throw new TypeError("createComment: 1 argument required"); var n = new Comment(String(t)); n._doc = this; return n; }
  createDocumentFragment() { var f = new DocumentFragment(); f._doc = this; return f; }
  createCDATASection(t) { if (arguments.length < 1) throw new TypeError("createCDATASection: 1 argument required"); if (this._isHTML) throw __jb.domError("NotSupportedError", "CDATA sections are not supported in HTML documents"); t = String(t); if (t.indexOf("]]>") >= 0) throw __jb.domError("InvalidCharacterError", "data contains ']]>'"); var n = new CDATASection(t); n._doc = this; return n; }
  createProcessingInstruction(target, data) { if (arguments.length < 2) throw new TypeError("createProcessingInstruction: 2 arguments required"); target = String(target); data = String(data); if (!__jb.validElementLocalName(target) && !/^[A-Za-z_:][\w:.-]*$/.test(target)) throw __jb.domError("InvalidCharacterError", "invalid target"); if (!__jb.validElementLocalName(target)) throw __jb.domError("InvalidCharacterError", "invalid target"); if (data.indexOf("?>") >= 0) throw __jb.domError("InvalidCharacterError", "data contains '?>'"); var n = new ProcessingInstruction(target, data); n._doc = this; return n; }
  createAttribute(n) { if (arguments.length < 1) throw new TypeError("createAttribute: 1 argument required"); n = String(n); if (!__jb.validAttributeLocalName(n)) throw __jb.domError("InvalidCharacterError", "invalid attribute name"); if (this._isHTML) n = n.toLowerCase(); return __jb.newAttr(this, n, "", null, null, null); }
  createAttributeNS(ns, qname) { if (arguments.length < 2) throw new TypeError("createAttributeNS: 2 arguments required"); var x = __jb.validateAndExtract(ns === null ? null : ns === undefined ? null : String(ns), qname, true); return __jb.newAttr(this, x.local, "", x.ns, x.prefix, null); }
  createEvent(type) {
    if (arguments.length < 1) throw new TypeError("createEvent: 1 argument required");
    var name = __jb.EVENT_INTERFACES[String(type).toLowerCase()];
    if (!name || name === "TouchEvent") throw __jb.domError("NotSupportedError", "The provided event type ('" + type + "') is invalid");
    var C = globalThis[name] || Event;
    __jb.textEventCreating = true;
    var ev;
    try { ev = name === "BeforeUnloadEvent" ? Reflect.construct(Event, [""], C) : new C(""); } finally { __jb.textEventCreating = false; }
    ev._initialized = false; ev._ev.type = ""; __jb.setTrusted(ev, false); ev._ev.bubbles = false; ev._ev.cancelable = false;
    return ev;
  }
  createRange() { var r = new Range(); r._start = [this, 0]; r._end = [this, 0]; return r; }
  createNodeIterator(root, w, f) { if (arguments.length < 1) throw new TypeError("createNodeIterator: 1 argument required"); return __jb.makeWalker(NodeIterator, root, w, f); }
  createTreeWalker(root, w, f) { if (arguments.length < 1) throw new TypeError("createTreeWalker: 1 argument required"); return __jb.makeWalker(TreeWalker, root, w, f); }
  importNode(node, deep) { if (arguments.length < 1) throw new TypeError("importNode: 1 argument required"); __jb.expectNode(node); if (node.nodeType === 9 || (node.nodeType === 11 && node._host)) throw __jb.domError("NotSupportedError", "cannot import a document or shadow root"); var opts = deep !== null && typeof deep === "object" ? !!deep.selfOnly === false : !!deep; return __jb.clone(node, this, typeof deep === "object" && deep !== null ? !deep.selfOnly : !!deep); }
  adoptNode(node) { if (arguments.length < 1) throw new TypeError("adoptNode: 1 argument required"); __jb.expectNode(node); if (node.nodeType === 9) throw __jb.domError("NotSupportedError", "cannot adopt a document"); if (node.nodeType === 11 && node._host) throw __jb.domError("HierarchyRequestError", "cannot adopt a shadow root"); if (node.parentNode) __jb.remove(node); if (node.nodeType === 2) { node._doc = this; return node; } __jb.adoptInto(node, this); return node; }
  getElementById(id) { if (arguments.length < 1) throw new TypeError("getElementById: 1 argument required"); id = String(id); if (id === "") return null; var stack = [this]; while (stack.length) { var n = stack.pop(); if (n.nodeType === 1 && n.getAttribute("id") === id) return n; for (var c = n.lastChild; c; c = c.previousSibling) stack.push(c); } return null; }
  getElementsByName(name) { var self_ = this; name = String(name); return __jb.liveNodeList(function () { return __jb.descendants(self_, function (n) { return n.nodeType === 1 && n._ns === __jb.HTML_NS && n.getAttribute("name") === name; }); }); }
  getSelection() { return this === __jb.currentDocument ? __jb.selection : this._frameWindow ? (this._frameSelection || (__jb.selectionConstructing = true, this._frameSelection = new Selection(), __jb.selectionConstructing = false, this._frameSelection)) : null; }
  hasFocus() { return this === __jb.currentDocument; }
  elementFromPoint() { return this.body; } elementsFromPoint() { return this.body ? [this.body] : []; } caretRangeFromPoint() { return null; } caretPositionFromPoint() { return null; }
  // execCommand / queryCommand*: 67b_editing_glue.js
  open() { if (!this._isHTML) throw __jb.domError("InvalidStateError", "open() on an XML document"); if (this._writeDepth || __jb.ignoreOpensDuringUnload > 0) return this; __jb.navGen = (__jb.navGen || 0) + 1; /* aborts pending navigations (javascript: URLs) */
    // "Erase all event listeners and handlers" of the document and its window.
    this._jbListeners = Object.create(null); this._handlers = {};
    __jb.descendants(this, function (n) { if (n._jbListeners) n._jbListeners = Object.create(null); if (n._handlers) n._handlers = {}; if (n.shadowRoot && n.shadowRoot._jbListeners) n.shadowRoot._jbListeners = Object.create(null); return false; });
    if (this === __jb.currentDocument) { globalThis._jbListeners = Object.create(null); (__jb.EVENT_HANDLER_NAMES || []).concat(__jb.WINDOW_HANDLER_NAMES || []).forEach(function (n) { try { globalThis["on" + n] = null; } catch (e) {} }); }
    __jb.inDocumentOpen = (__jb.inDocumentOpen || 0) + 1;
    try { __jb.replaceAll(this, null); } finally { __jb.inDocumentOpen--; } this.readyState = "loading"; this._opened = true; this._writeBuffer = ""; return this; }
  close() {
    if (!this._isHTML) throw __jb.domError("InvalidStateError", "close() on an XML document");
    if (!this._opened) return;
    if (this._reparsing) { this._pendingClose = true; return; } // a script run by the parser closes once parsing returns
    // Insert an explicit EOF: the written input is parsed to completion, then "the end" runs in a task.
    __jb.reparseWritten(this, true);
    this._opened = false; this._writeBuffer = "";
    if (!this.documentElement) __jb.ensureHtmlSkeleton(this);
    var doc = this;
    if (doc !== __jb.currentDocument || typeof __jb.fireLifecycle !== "function") { this.readyState = "complete"; return; }
    var fe = null; try { fe = globalThis.frameElement; } catch (e) { fe = null; }
    if (fe && fe._contentWindow === globalThis) fe._loadToken = (fe._loadToken || 0) + 1; // supersedes a pending initial about:blank load
    var token = fe ? fe._loadToken : 0;
    setTimeout(function () {
      if (__jb.currentDocument !== doc || doc._opened) return;
      __jb.fireLifecycle("interactive"); __jb.fireLifecycle("complete");
      if (fe && fe._contentWindow === globalThis && fe._loadToken === token) { try { var pw = fe.ownerDocument.defaultView; (pw && pw.__jb ? pw.__jb : __jb).fireUA(fe, "load"); } catch (e) { __jb.reportException(e); } }
    }, 0);
  }
  write() {
    if (!this._isHTML) throw __jb.domError("InvalidStateError", "write() on an XML document");
    if (__jb.ignoreOpensDuringUnload > 0) return; // "ignore-opens-during-unload counter"
    var html = __jb.A.map.call(arguments, String).join("");
    if (this.currentScript && this.currentScript.parentNode && this.currentScript.ownerDocument === this && !this._opened) {
      var frag = __jb.parseFragment(html, this.currentScript.parentNode, { unsafe: true, runScripts: true });
      __jb.inDocumentWrite = (__jb.inDocumentWrite || 0) + 1;
      try { __jb.insert(this.currentScript.parentNode, frag, this.currentScript.nextSibling, false); } finally { __jb.inDocumentWrite--; }
      return;
    }
    // the running parser-inserted script removed its own element: the parser's insertion point stays
    var ip = __jb.writeInsertionPoint;
    if (!this._opened && ip && ip.doc === this && ip.parent.isConnected) {
      var next = ip.next && ip.next.parentNode === ip.parent ? ip.next : null;
      var frag2 = __jb.parseFragment(html, ip.parent, { unsafe: true, runScripts: true });
      __jb.inDocumentWrite = (__jb.inDocumentWrite || 0) + 1;
      try { __jb.insert(ip.parent, frag2, next, false); } finally { __jb.inDocumentWrite--; }
      return;
    }
    // no insertion point: an external script (or module) may not blow the document away
    if (!this._opened && __jb.ignoreDestructiveWrites > 0 && this === __jb.currentDocument) return;
    if (!this._opened) { this.open(); }
    // The written text is the parser's input stream: re-parse all of it and merge the result into the live tree.
    this._writeBuffer = (this._writeBuffer || "") + html;
    __jb.reparseWritten(this, false);
  }
  writeln() { var html = __jb.A.map.call(arguments, String).join(""); this.write(html + "\n"); }
  exitFullscreen() { return Promise.resolve(); } exitPictureInPicture() { return Promise.resolve(); } exitPointerLock() {}
  requestStorageAccess() { return __jb.requestStorageAccess(this); } hasStorageAccess() { return __jb.hasStorageAccess(this); }
  startViewTransition(cb) { if (cb) try { cb(); } catch (e) {} return { ready: Promise.resolve(), finished: Promise.resolve(), updateCallbackDone: Promise.resolve(), skipTransition: function () {} }; }
  _cloneEmpty() { var d = new (this.constructor)(); d._isHTML = this._isHTML; d._contentType = this._contentType; d.URL = d.documentURI = this.URL; d._characterSet = this._characterSet; d._quirks = this._quirks; return d; }
}
mixin(Document.prototype, ParentNodeMixin);
__jb.setTag(Document, "Document");
__jb.defineDocumentColors(Document.prototype);
__jb.defineEventHandlerProps(Document.prototype, __jb.EVENT_HANDLER_NAMES.concat(["readystatechange", "visibilitychange", "fullscreenchange", "fullscreenerror", "pointerlockchange", "pointerlockerror", "DOMContentLoaded"]));
// document.write() into an open()ed document: parse the whole input written so far and reconcile
// it with the current tree (unchanged prefixes keep their node identity; new nodes are inserted,
// so scripts among them run). Input that ends inside a <script> waits for the end tag.
__jb.reparseWritten = function (doc, atEOF) {
  var buf = doc._writeBuffer || "";
  if (!atEOF) {
    var lower = buf.toLowerCase();
    var lastOpen = lower.lastIndexOf("<script"), lastClose = lower.lastIndexOf("</script");
    if (lastOpen > lastClose) return;
  }
  if (doc._reparsing) { doc._reparseAgain = true; return; }
  doc._reparsing = true;
  try {
    do {
      doc._reparseAgain = false;
      var json = __jb.native("html", { html: doc._writeBuffer || "", scripting: !!doc.defaultView });
      var tmp = new Document(); tmp._isHTML = true; tmp._contentType = "text/html"; tmp.URL = tmp.documentURI = doc.URL;
      if (json && json.c) __jb.buildTree(json.c, tmp, tmp, false, false, true);
      // Before EOF the parser has not yet created the implied <html> for input that is only a doctype/comments.
      if (!atEOF && tmp.documentElement && !/<(?!!)|[^\s<]/.test((doc._writeBuffer || "").replace(/<!--[\s\S]*?-->|<!doctype[^>]*>/gi, ""))) tmp._removeChildRaw(tmp.documentElement);
      if (json) doc._quirks = !!json.q;
      __jb.inDocumentWrite = (__jb.inDocumentWrite || 0) + 1;
      try { __jb.reconcileChildren(doc, tmp); } finally { __jb.inDocumentWrite--; }
      __jb.markDirty(doc);
    } while (doc._reparseAgain);
  } finally { doc._reparsing = false; }
  if (doc._pendingClose) { doc._pendingClose = false; doc.close(); }
};
__jb.sameParsedNode = function (o, n) {
  if (o.nodeType !== n.nodeType) return false;
  if (o.nodeType === 10) return o.name === n.name && o.publicId === n.publicId && o.systemId === n.systemId;
  if (o.nodeType === 7) return o.target === n.target;
  if (o.nodeType !== 1) return true;
  if (o._local !== n._local || o._ns !== n._ns || o._attrs.length !== n._attrs.length) return false;
  for (var i = 0; i < o._attrs.length; i++) { var a = o._attrs[i], b = n._attrs[i]; if (a._local !== b._local || a._ns !== b._ns || a._value !== b._value) return false; }
  // A script that already ran must not be replaced by its re-parsed twin with different text.
  if (o._tag === "script" && o.textContent !== n.textContent) return false;
  return true;
};
__jb.reconcileChildren = function (oldParent, newParent) {
  var o = oldParent.firstChild, n = newParent.firstChild;
  while (n) {
    var next = n.nextSibling;
    if (o && __jb.sameParsedNode(o, n)) {
      if (o.nodeType === 3 || o.nodeType === 8 || o.nodeType === 7) { if (o.data !== n.data) o.data = n.data; }
      else if (o.nodeType === 1) {
        __jb.reconcileChildren(o, n);
        if (o._tag === "template" && o.content && n.content) __jb.reconcileChildren(o.content, n.content);
      }
      o = o.nextSibling;
    } else {
      while (o) { var x = o.nextSibling; __jb.remove(o); o = x; }
      newParent._removeChildRaw(n);
      __jb.insert(oldParent, n, null, false);
    }
    n = next;
  }
  while (o) { var y = o.nextSibling; __jb.remove(o); o = y; }
};
__jb.ensureHtmlSkeleton = function (doc) { if (!doc.documentElement) { var html = doc.createElement("html"); html._appendChildRaw(doc.createElement("head")); html._appendChildRaw(doc.createElement("body")); doc._appendChildRaw(html); } };
class HTMLDocument extends Document {}
__jb.setTag(HTMLDocument, "HTMLDocument");
class XMLDocument extends Document { constructor() { super(); this._isHTML = false; this._contentType = "application/xml"; } }
__jb.setTag(XMLDocument, "XMLDocument");
__jb.parseHTMLDocument = function (str, allowShadow) {
  var d = new Document(); d._isHTML = true; d._contentType = "text/html"; d.URL = d.documentURI = __jb.currentDocument.URL;
  var json = __jb.native("html", { html: str, scripting: false });
  if (json) d._quirks = !!json.q;
  if (json && json.c) __jb.buildTree(json.c, d, d, false, true, allowShadow); else __jb.parseHTML(str, d, d);
  __jb.ensureHtmlSkeleton(d);
  d.readyState = "complete";
  return d;
};
Document.parseHTMLUnsafe = function (html) { if (arguments.length < 1) throw new TypeError("parseHTMLUnsafe: 1 argument required"); return __jb.parseHTMLDocument(String(html), true); };
class DOMParser {
  // The parser's relevant global's document supplies the URL of parsed documents.
  constructor() { Object.defineProperty(this, "_ownerDoc", { value: __jb.currentDocument }); }
  parseFromString(str, type) {
    if (arguments.length < 2) throw new TypeError("parseFromString: 2 arguments required");
    str = String(str); type = String(type);
    if (type === "text/html") {
      var od = this._ownerDoc || __jb.currentDocument;
      var d = new Document(); d._isHTML = true; d._contentType = "text/html"; d.URL = d.documentURI = od.URL;
      var json = __jb.native("html", { html: str, scripting: false });
      if (json) d._quirks = !!json.q;
      if (json && json.c) __jb.buildTree(json.c, d, d, false); else __jb.parseHTML(str, d, d);
      __jb.ensureHtmlSkeleton(d);
      d.readyState = "complete";
      __jb.descendants(d, function (n) { return n.nodeType === 1 && n._local === "script"; }).forEach(function (sc) { sc._executed = true; }); // scripting is disabled
      return d;
    }
    if (type === "text/xml" || type === "application/xml" || type === "application/xhtml+xml" || type === "image/svg+xml") {
      var x = new Document(); x._isHTML = false; x._contentType = type; x.URL = x.documentURI = (this._ownerDoc || __jb.currentDocument).URL;
      __jb.parseXML(str, x);
      x.readyState = "complete";
      __jb.descendants(x, function (n) { return n.nodeType === 1 && n._local === "script"; }).forEach(function (sc) { sc._executed = true; });
      return x;
    }
    throw new TypeError("parseFromString: unsupported type '" + type + "'");
  }
}
__jb.setTag(DOMParser, "DOMParser");
// HTML "parsing XHTML documents": these public identifiers get a DTD with the HTML named character references.
__jb.XHTML_ENTITY_PUBLIC_IDS = ["-//W3C//DTD XHTML 1.0 Transitional//EN", "-//W3C//DTD XHTML 1.1//EN", "-//W3C//DTD XHTML 1.0 Strict//EN", "-//W3C//DTD XHTML 1.0 Frameset//EN", "-//W3C//DTD XHTML Basic 1.0//EN", "-//W3C//DTD XHTML 1.1 plus MathML 2.0//EN", "-//W3C//DTD XHTML 1.1 plus MathML 2.0 plus SVG 1.1//EN", "-//W3C//DTD MathML 2.0//EN", "-//WAPFORUM//DTD XHTML Mobile 1.0//EN", "-//WAPFORUM//DTD XHTML Mobile 1.1//EN", "-//WAPFORUM//DTD XHTML Mobile 1.2//EN"];
// The value of the HTML named character reference "&name;" (null when there is none), via the HTML parser.
__jb.htmlNamedRefCache = Object.create(null);
__jb.htmlNamedReference = function (name) {
  if (name in __jb.htmlNamedRefCache) return __jb.htmlNamedRefCache[name];
  var value = null;
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    var json = null; try { json = __jb.native("html", { html: "&" + name + ";" }); } catch (e) { json = null; }
    var text = "";
    (function walk(list) { (list || []).forEach(function (n) { if (n.x !== undefined) text += n.x; else if (n.c) walk(n.c); }); })(json && json.c);
    // A legacy prefix match ("&notit;" -> "¬it;") leaves the rest of the name and the semicolon behind.
    var partial = false;
    for (var k = 1; k <= name.length && !partial; k++) if (text.slice(-(k + 1)) === name.slice(-k) + ";") partial = true;
    if (text !== "" && !partial) value = text;
  }
  return (__jb.htmlNamedRefCache[name] = value);
};
// Minimal namespace-aware XML parser (no DTD) used by DOMParser and XHR.
__jb.parseXML = function (src, doc) {
  var pos = 0, len = src.length;
  var stack = [{ node: doc, ns: { xml: __jb.XML_NS, xmlns: __jb.XMLNS_NS } }];
  var error = null;
  function fail(msg) { error = error || msg; }
  function top() { return stack[stack.length - 1]; }
  // Entities: the predefined five, internal-subset <!ENTITY> declarations and, for the XHTML/MathML
  // public identifiers listed in HTML's "parsing XHTML documents", every HTML named character reference.
  var entities = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }, htmlEntities = false;
  function decode(s) {
    if (s.indexOf("&") < 0) return s;
    return s.replace(/&([^;&\s<]*);?/g, function (m, e) {
      if (m.charAt(m.length - 1) !== ";" || e === "") { fail("malformed entity reference"); return m; }
      if (e.charAt(0) === "#") {
        var hex = e.charAt(1) === "x", digits = hex ? e.slice(2) : e.slice(1);
        if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) { fail("bad character reference"); return m; }
        var code = parseInt(digits, hex ? 16 : 10);
        if (!(code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xD7FF) || (code >= 0xE000 && code <= 0xFFFD) || (code >= 0x10000 && code <= 0x10FFFF))) { fail("invalid character reference"); return m; }
        return String.fromCodePoint(code);
      }
      if (Object.prototype.hasOwnProperty.call(entities, e)) return entities[e];
      if (htmlEntities) { var v = __jb.htmlNamedReference(e); if (v !== null) return v; }
      fail("undefined entity " + e); return m;
    });
  }
  while (pos < len && !error) {
    var lt = src.indexOf("<", pos);
    if (lt < 0) { var rest = src.slice(pos); if (rest.trim() && top().node !== doc) top().node._appendChildRaw(doc.createTextNode(decode(rest))); else if (rest.trim()) fail("text outside root"); break; }
    if (lt > pos) { var text = src.slice(pos, lt); if (top().node !== doc) top().node._appendChildRaw(doc.createTextNode(decode(text))); else if (text.trim()) fail("text outside root"); }
    pos = lt;
    if (src.startsWith("<!--", pos)) { var ce = src.indexOf("-->", pos + 4); if (ce < 0) { fail("unterminated comment"); break; } top().node._appendChildRaw(doc.createComment(src.slice(pos + 4, ce))); pos = ce + 3; continue; }
    if (src.startsWith("<![CDATA[", pos)) { var cd = src.indexOf("]]>", pos + 9); if (cd < 0) { fail("unterminated CDATA"); break; } var cdn = new CDATASection(src.slice(pos + 9, cd)); cdn._doc = doc; top().node._appendChildRaw(cdn); pos = cd + 3; continue; }
    if (src.startsWith("<?", pos)) { var pe = src.indexOf("?>", pos + 2); if (pe < 0) { fail("unterminated PI"); break; } var body = src.slice(pos + 2, pe); var m0 = /^(\S+)\s*([\s\S]*)$/.exec(body); if (m0 && m0[1].toLowerCase() !== "xml") { var pin = new ProcessingInstruction(m0[1], m0[2]); pin._doc = doc; top().node._appendChildRaw(pin); } pos = pe + 2; continue; }
    if (src.startsWith("<!DOCTYPE", pos)) {
      var dt = /^<!DOCTYPE\s+([^\s>\[]+)(?:\s+(?:PUBLIC\s+("[^"]*"|'[^']*')\s+("[^"]*"|'[^']*')|SYSTEM\s+("[^"]*"|'[^']*')))?\s*/.exec(src.slice(pos));
      if (!dt) { fail("bad doctype"); break; }
      var dp = pos + dt[0].length;
      if (src.charAt(dp) === "[") {
        var subEnd = src.indexOf("]", dp);
        if (subEnd < 0) { fail("unterminated internal subset"); break; }
        var subset = src.slice(dp + 1, subEnd), em, entRe = /<!ENTITY\s+([^\s%]+)\s+("([^"]*)"|'([^']*)')\s*>/g;
        while ((em = entRe.exec(subset))) if (!/^(lt|gt|amp|quot|apos)$/.test(em[1]) && !Object.prototype.hasOwnProperty.call(entities, em[1])) entities[em[1]] = em[3] !== undefined ? em[3] : em[4];
        dp = subEnd + 1;
        while (dp < len && /\s/.test(src.charAt(dp))) dp++;
      }
      if (src.charAt(dp) !== ">") { fail("bad doctype"); break; }
      var unq = function (q) { return q === undefined ? "" : q.slice(1, -1); };
      var publicId = unq(dt[2]), systemId = dt[3] !== undefined ? unq(dt[3]) : unq(dt[4]);
      var dtn = new DocumentType(dt[1], publicId, systemId); dtn._doc = doc; doc._appendChildRaw(dtn);
      if (__jb.XHTML_ENTITY_PUBLIC_IDS.indexOf(publicId) >= 0) htmlEntities = true;
      pos = dp + 1; continue;
    }
    if (src.charAt(pos + 1) === "/") { var ee = src.indexOf(">", pos); if (ee < 0 || /\s/.test(src.charAt(pos + 2))) { fail("bad end tag"); break; } var ename = src.slice(pos + 2, ee).trim(); if (stack.length < 2 || __jb.qualifiedName(top().node) !== ename) { fail("mismatched end tag " + ename); break; } stack.pop(); pos = ee + 1; continue; }
    var m = /^<([^\s\/>]+)/.exec(src.slice(pos));
    if (!m) { fail("bad start tag"); break; }
    var qname = m[1]; var p = pos + m[0].length; var attrs = []; var selfClosing = false;
    while (p < len) {
      while (p < len && /\s/.test(src.charAt(p))) p++;
      var ch = src.charAt(p);
      if (ch === ">") { p++; break; }
      if (ch === "/" && src.charAt(p + 1) === ">") { selfClosing = true; p += 2; break; }
      var am = /^([^\s=\/>]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(src.slice(p));
      if (!am) { fail("bad attribute"); break; }
      attrs.push([am[1], decode(am[3] !== undefined ? am[3] : am[4])]); p += am[0].length;
    }
    if (error) break;
    pos = p;
    var nsmap = Object.assign({}, top().ns);
    attrs.forEach(function (a) { if (a[0] === "xmlns") nsmap[""] = a[1]; else if (a[0].indexOf("xmlns:") === 0) nsmap[a[0].slice(6)] = a[1]; });
    var colon = qname.indexOf(":"); var prefix = colon > 0 ? qname.slice(0, colon) : null; var local = colon > 0 ? qname.slice(colon + 1) : qname;
    var QNAME = /^[A-Za-z_À-￿][\w.\-·À-￿]*(:[A-Za-z_À-￿][\w.\-·À-￿]*)?$/;
    if (!QNAME.test(qname)) { fail("not well-formed (invalid element name)"); break; }
    if (prefix !== null && (nsmap[prefix] === undefined || nsmap[prefix] === "")) { fail("unbound prefix"); break; }
    var attrSeen = {};
    for (var ai = 0; ai < attrs.length; ai++) {
      var an0 = attrs[ai][0];
      if (!QNAME.test(an0) || attrSeen[an0]) { fail("not well-formed (bad attribute name)"); break; }
      attrSeen[an0] = true;
      var ac0 = an0.indexOf(":");
      if (ac0 > 0) { var ap0 = an0.slice(0, ac0); if (ap0 !== "xmlns" && ap0 !== "xml" && (nsmap[ap0] === undefined || nsmap[ap0] === "")) { fail("unbound prefix"); break; } }
    }
    if (error) break;
    var ns = prefix !== null ? (nsmap[prefix] !== undefined ? nsmap[prefix] : null) : (nsmap[""] !== undefined ? nsmap[""] : null);
    if (ns === "") ns = null;
    if (top().node === doc && doc.documentElement) { fail("multiple root elements"); break; }
    var el = __jb.createElementInternal(doc, local, ns, prefix, null, false);
    attrs.forEach(function (a) {
      var ac = a[0].indexOf(":"); var ap = ac > 0 ? a[0].slice(0, ac) : null; var al = ac > 0 ? a[0].slice(ac + 1) : a[0];
      var ans = a[0] === "xmlns" ? __jb.XMLNS_NS : ap === "xmlns" ? __jb.XMLNS_NS : ap === "xml" ? __jb.XML_NS : ap !== null ? (nsmap[ap] !== undefined ? nsmap[ap] : null) : null;
      el._attrs.push(__jb.newAttr(doc, al, a[1], ans, ap, el));
    });
    top().node._appendChildRaw(el);
    if (!selfClosing) stack.push({ node: el, ns: nsmap });
  }
  if (!error && stack.length > 1) error = "unclosed element";
  if (error) {
    while (doc.firstChild) doc._removeChildRaw(doc.firstChild);
    var pe2 = doc.createElementNS("http://www.mozilla.org/newlayout/xml/parsererror.xml", "parsererror");
    pe2._appendChildRaw(doc.createTextNode("XML Parsing Error: " + error));
    doc._appendChildRaw(pe2);
  }
  return doc;
};
// ---- CSS Font Loading: FontFace / FontFaceSet / FontFaceSetLoadEvent ----
// Descriptors are validated with Stylo (as the font-* properties they mirror); URL sources are
// fetched on load(); FontFaceSet.load()/check() parse the font shorthand.
(function () {
  var g = globalThis;
  var supports = function (prop, value) { try { var r = __jb.native("cssdecl", { op: "supports", prop: prop, value: value }); return r === true || r === null || r === undefined && true; } catch (e) { return true; } };
  var CSS_WIDE = /^(initial|inherit|unset|default|revert|revert-layer)$/i;
  var DESC = {
    style: { dflt: "normal", check: function (v) { return supports("font-style", v) || /^oblique\s+-?[\d.]+deg\s+-?[\d.]+deg$/i.test(v); } },
    weight: { dflt: "normal", check: function (v) { var p = v.trim().split(/\s+/); return p.length <= 2 && p.every(function (x) { return supports("font-weight", x); }) && !(p.length === 2 && p.some(function (x) { return /^(bolder|lighter)$/i.test(x); })) && !/^(bolder|lighter)$/i.test(v.trim()); } },
    stretch: { dflt: "normal", check: function (v) { var p = v.trim().split(/\s+/); return p.length <= 2 && p.every(function (x) { return supports("font-stretch", x); }); } },
    unicodeRange: { dflt: "U+0-10FFFF", check: function (v) { return v.split(",").every(function (r) { return /^\s*u\+([0-9a-f?]{1,6})(-[0-9a-f]{1,6})?\s*$/i.test(r); }); } },
    featureSettings: { dflt: "normal", check: function (v) { return supports("font-feature-settings", v); } },
    variationSettings: { dflt: "normal", check: function (v) { return supports("font-variation-settings", v); } },
    display: { dflt: "auto", check: function (v) { return /^(auto|block|swap|fallback|optional)$/i.test(v.trim()); } },
    ascentOverride: { dflt: "normal", check: function (v) { return /^(normal|\d*\.?\d+%)$/i.test(v.trim()); } },
    descentOverride: { dflt: "normal", check: function (v) { return /^(normal|\d*\.?\d+%)$/i.test(v.trim()); } },
    lineGapOverride: { dflt: "normal", check: function (v) { return /^(normal|\d*\.?\d+%)$/i.test(v.trim()); } },
    sizeAdjust: { dflt: "100%", check: function (v) { return /^\d*\.?\d+%$/.test(v.trim()); } },
  };
  var NAMES = Object.keys(DESC);
  var normalize = function (k, v) {
    v = String(v).trim();
    if (k === "unicodeRange") return v.split(",").map(function (r) { return r.trim().toUpperCase().replace(/^U\+/, "U+"); }).join(", ");
    if (/^(display)$/.test(k)) return v.toLowerCase();
    return v;
  };
  var validFamily = function (f) {
    f = String(f).trim();
    if (!f) return false;
    if (/^(["']).*\1$/.test(f)) return true;
    return f.split(/\s+/).every(function (w) { return /^-?[A-Za-z_\u0080-￿][\w\-\u0080-￿]*$/.test(w) && !CSS_WIDE.test(w); }) && !/^(serif|sans-serif|cursive|fantasy|monospace|system-ui|emoji|math|fangsong|ui-serif|ui-sans-serif|ui-monospace|ui-rounded)$/i.test(f);
  };
  var fail = function (face, err) {
    face._status = "error";
    face._reject(err);
  };
  function FontFace(family, source, descriptors) {
    if (!new.target) throw new TypeError("Constructor FontFace requires 'new'");
    if (arguments.length < 2) throw new TypeError("FontFace: 2 arguments required");
    descriptors = descriptors === undefined || descriptors === null ? {} : descriptors;
    var self = this, res, rej;
    Object.defineProperty(this, "_loaded", { value: new Promise(function (a, b) { res = a; rej = b; }), writable: true });
    this._loaded.catch(function () {});
    Object.defineProperty(this, "_resolve", { value: res, writable: true });
    Object.defineProperty(this, "_reject", { value: rej, writable: true });
    Object.defineProperty(this, "_status", { value: "unloaded", writable: true });
    // a family that is not a valid <family-name> is kept as a quoted string
    var fam = String(family);
    if (!validFamily(fam)) fam = '"' + fam.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    Object.defineProperty(this, "_family", { value: fam, writable: true });
    var bad = false;
    NAMES.forEach(function (k) {
      var v = descriptors[k] !== undefined ? String(descriptors[k]) : DESC[k].dflt;
      if (descriptors[k] !== undefined && !DESC[k].check(v)) bad = true;
      Object.defineProperty(self, "_" + k, { value: descriptors[k] !== undefined ? normalize(k, v) : v, writable: true });
    });
    var binary = source && typeof source === "object" && (source instanceof ArrayBuffer || ArrayBuffer.isView(source));
    Object.defineProperty(this, "_source", { value: binary ? null : String(source), writable: true });
    if (!binary && !/^\s*(url\(|local\()/i.test(this._source)) bad = true;
    if (bad) { fail(this, __jb.domError("SyntaxError", "Invalid FontFace descriptor or source")); return; }
    if (binary) {
      var bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
      var sig = bytes.length >= 4 ? String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) : "";
      self._status = "loading";
      var ok = /^(wOFF|wOF2|OTTO|true|ttcf)$/.test(sig) || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0);
      if (ok) Object.defineProperty(this, "_bytes", { value: bytes.slice(), writable: true }); // for canvas text
      Promise.resolve().then(function () { if (ok) { self._status = "loaded"; self._resolve(self); } else fail(self, __jb.domError("SyntaxError", "The font data could not be parsed")); });
    }
  }
  NAMES.concat(["family"]).forEach(function (k) {
    Object.defineProperty(FontFace.prototype, k, {
      get: function () { return this["_" + k]; },
      set: function (v) {
        v = String(v);
        if (k === "family") { if (!validFamily(v)) throw __jb.domError("SyntaxError", "Invalid font family"); this._family = v; return; }
        if (!DESC[k].check(v)) throw __jb.domError("SyntaxError", "Invalid value for " + k);
        this["_" + k] = normalize(k, v);
      },
      enumerable: true, configurable: true,
    });
  });
  Object.defineProperty(FontFace.prototype, "status", { get: function () { return this._status; }, enumerable: true, configurable: true });
  Object.defineProperty(FontFace.prototype, "loaded", { get: function () { return this._loaded; }, enumerable: true, configurable: true });
  FontFace.prototype.load = function load() {
    var self = this;
    if (this._status !== "unloaded") return this._loaded;
    this._status = "loading";
    var src = this._source || "", m = /url\(\s*(["']?)([^"')]*)\1\s*\)/i.exec(src);
    setTimeout(function () {
      if (!m) { if (/local\(/i.test(src)) { self._status = "loaded"; self._resolve(self); } else fail(self, __jb.domError("NetworkError", "No font source")); return; }
      var url;
      try { url = new URL(m[2], document.baseURI).href; } catch (e) { fail(self, __jb.domError("NetworkError", "Bad font URL")); return; }
      var r = null;
      try { r = __jb.hostFetch(url, "GET", { Accept: "*/*" }, null, false, "", "css", { dest: "font" }); } catch (e) { r = null; }
      if (!r || r.error || !r.result || r.result.status < 200 || r.result.status >= 300) { fail(self, __jb.domError("NetworkError", "The font could not be loaded")); return; }
      self._status = "loaded"; self._resolve(self);
      __jb.domVersion++;
    }, 0);
    return this._loaded;
  };
  Object.defineProperty(FontFace.prototype, Symbol.toStringTag, { value: "FontFace", configurable: true });

  class FontFaceSetLoadEvent extends Event {
    constructor(type, init) {
      if (arguments.length < 1) throw new TypeError("FontFaceSetLoadEvent constructor: 1 argument required");
      super(type, init);
      Object.defineProperty(this, "_faces", { value: Object.freeze(init && init.fontfaces ? __jb.arrayFrom(init.fontfaces) : []) });
    }
    get fontfaces() { return this._faces; }
  }

  // font shorthand -> family list (null when it does not parse)
  var parseFont = function (font) {
    font = String(font);
    if (CSS_WIDE.test(font.trim()) || /(^|\s)(initial|inherit|unset|default|revert|revert-layer)\s*$/i.test(font.trim())) return null;
    if (/var\(/i.test(font)) return null;
    if (!supports("font", font)) return null;
    var m = /(?:^|\s)((?:\d*\.?\d+(?:px|pt|em|rem|%|ex|ch|vw|vh|pc|in|cm|mm|q)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)(?:\s*\/\s*\S+)?)\s+([\s\S]+)$/i.exec(font.trim());
    if (!m) return null;
    return m[2].split(",").map(function (f) { return f.trim().replace(/^(["'])(.*)\1$/, "$2"); });
  };
  function FontFaceSet(initialFaces) {
    if (!new.target) throw new TypeError("Constructor FontFaceSet requires 'new'");
    var s = __jb.newFontFaceSet();
    __jb.arrayFrom(initialFaces || []).forEach(function (f) { s.add(f); });
    return s;
  }
  FontFaceSet.prototype = Object.create(EventTarget.prototype, { constructor: { value: FontFaceSet, writable: true, configurable: true } });
  Object.setPrototypeOf(FontFaceSet, EventTarget);
  var P = FontFaceSet.prototype;
  P.add = function add(f) { if (!(f instanceof FontFace)) throw new TypeError("FontFaceSet.add: argument is not a FontFace"); this._faces.add(f); return this; };
  P.delete = function (f) { if (!(f instanceof FontFace)) throw new TypeError("FontFaceSet.delete: argument is not a FontFace"); return this._faces.delete(f); };
  P.has = function has(f) { if (!(f instanceof FontFace)) throw new TypeError("FontFaceSet.has: argument is not a FontFace"); return this._faces.has(f); };
  P.clear = function clear() { this._faces.clear(); };
  P.forEach = function forEach(cb, thisArg) { var s = this; this._faces.forEach(function (f) { cb.call(thisArg, f, f, s); }); };
  P.values = function values() { return this._faces.values(); };
  P.keys = P.values;
  P.entries = function entries() { return this._faces.entries(); };
  P[Symbol.iterator] = P.values;
  var matching = function (set, families) {
    var out = [];
    set._faces.forEach(function (f) { if (families.some(function (fam) { return fam.toLowerCase() === String(f._family).replace(/^(["'])(.*)\1$/, "$2").toLowerCase(); })) out.push(f); });
    return out;
  };
  P.check = function check(font, text) {
    if (arguments.length < 1) throw new TypeError("FontFaceSet.check: 1 argument required");
    var fams = parseFont(font);
    if (!fams) throw __jb.domError("SyntaxError", "Could not parse the font '" + font + "'");
    return matching(this, fams).every(function (f) { return f._status === "loaded"; });
  };
  P.load = function load(font, text) {
    var self = this;
    if (arguments.length < 1) return Promise.reject(new TypeError("FontFaceSet.load: 1 argument required"));
    var fams = parseFont(font);
    if (!fams) return Promise.reject(__jb.domError("SyntaxError", "Could not parse the font '" + font + "'"));
    var faces = matching(this, fams);
    return Promise.all(faces.map(function (f) { return f.load(); })).then(function () { return faces; });
  };
  Object.defineProperty(P, "size", { get: function () { return this._faces.size; }, enumerable: true, configurable: true });
  Object.defineProperty(P, "ready", { get: function () { return this._ready; }, enumerable: true, configurable: true });
  Object.defineProperty(P, "status", { get: function () { var loading = false; this._faces.forEach(function (f) { if (f._status === "loading") loading = true; }); return loading ? "loading" : "loaded"; }, enumerable: true, configurable: true });
  __jb.defineEventHandlerProps && __jb.defineEventHandlerProps(P, ["loading", "loadingdone", "loadingerror"]);
  Object.defineProperty(P, Symbol.toStringTag, { value: "FontFaceSet", configurable: true });
  __jb.newFontFaceSet = function () {
    var s = Object.create(P);
    try { EventTarget.call(s); } catch (e) {}
    Object.defineProperty(s, "_faces", { value: new Set(), configurable: true });
    Object.defineProperty(s, "_ready", { value: Promise.resolve(s), configurable: true });
    return s;
  };
  Object.defineProperty(g, "FontFace", { value: FontFace, writable: true, configurable: true });
  Object.defineProperty(g, "FontFaceSet", { value: FontFaceSet, writable: true, configurable: true });
  Object.defineProperty(g, "FontFaceSetLoadEvent", { value: FontFaceSetLoadEvent, writable: true, configurable: true });
  // WorkerGlobalScope includes FontFaceSource
  if (g.__jb_workerRealm) Object.defineProperty(g, "fonts", { value: __jb.newFontFaceSet(), writable: true, enumerable: true, configurable: true });
})();
class XMLSerializer { serializeToString(n) { if (arguments.length < 1) throw new TypeError("serializeToString: 1 argument required"); __jb.expectNode(n); return __jb.xmlSerialize(n, false, false); } }
__jb.setTag(XMLSerializer, "XMLSerializer");
__jb.cookiesSet = [];

// [LegacyUnforgeable] document: the realm's current document (worker globals have none; the
// environment itself uses __jb.currentDocument).
__jb.currentDocument = new Document();
if (!globalThis.__jb_workerRealm) Object.defineProperty(globalThis, "document", { get: function () { return __jb.currentDocument; }, enumerable: true, configurable: false });
__jb.currentDocument.readyState = "loading";
globalThis.customElements = customElements;

// ---- location / history / navigator / screen ----
__jb.navigations = [];
var __jbLocation = {
  _url: new URL("about:blank"),
  _set: function (u) { this._url = new URL(String(u), this._url.href === "about:blank" ? undefined : this._url.href); __jb.currentDocument.URL = __jb.currentDocument.documentURI = this._url.href; },
  get href() { return this._url.href; }, set href(v) { __jb.navigate(v, "assign"); },
  get protocol() { return this._url.protocol; },
  // "basic URL parse with scheme start state": letters/digits/+/-/. up to an
  // optional colon; anything else is a SyntaxError. http<->https and other
  // scheme changes navigate.
  set protocol(v) {
    v = String(v); var cut = v.indexOf(":"); if (cut >= 0) v = v.slice(0, cut);
    if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*$/.test(v)) throw __jb.domError("SyntaxError", "'" + v + "' is not a valid protocol");
    var scheme = v.toLowerCase();
    // Only switches between special schemes apply (URL Standard restriction).
    var special = { http: 1, https: 1, ws: 1, wss: 1, ftp: 1, file: 1 };
    var current = this._url.protocol.slice(0, -1);
    if (!special[current] || !special[scheme]) return;
    var u = new URL(this._url.href); try { u.protocol = scheme; } catch (e) { return; }
    if (u.href !== this._url.href) __jb.navigate(u.href, "assign");
  },
  get host() { return this._url.host; }, set host(v) { var u = new URL(this._url.href); try { u.host = String(v); } catch (e) { return; } if (u.href !== this._url.href) __jb.navigate(u.href, "assign"); },
  get hostname() { return this._url.hostname; }, set hostname(v) { var u = new URL(this._url.href); try { u.hostname = String(v); } catch (e) { return; } if (u.href !== this._url.href) __jb.navigate(u.href, "assign"); },
  get port() { return this._url.port; }, set port(v) { var u = new URL(this._url.href); try { u.port = String(v); } catch (e) { return; } if (u.href !== this._url.href) __jb.navigate(u.href, "assign"); },
  get pathname() { return this._url.pathname; }, set pathname(v) { __jb.navigate(new URL(v, this._url.href).href, "assign"); },
  get search() { return this._url.search; }, set search(v) { var u = new URL(this._url.href); u.search = v; __jb.navigate(u.href, "assign"); },
  get hash() { return this._url.hash; }, set hash(v) { var old = this._url.href; var u = new URL(this._url.href); u.hash = v; if (u.href === old) return; this._url = u; __jb.currentDocument.URL = __jb.currentDocument.documentURI = this._url.href; var self_ = this; setTimeout(function () { globalThis.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: old, newURL: self_._url.href })); }, 0); },
  get origin() { return this._url.origin; },
  get ancestorOrigins() { void this._url; return []; }, // touches `this` so a cross-origin receiver throws
  assign: function (u) { __jb.navigate(u, "assign"); },
  replace: function (u) { __jb.navigate(u, "replace"); },
  reload: function () { __jb.navigations.push({ type: "reload", url: this._url.href }); },
  toString: function () { return this._url.href; },
  valueOf: function () { return this; },
};
__jb.navigate = function (u, type) {
  var target;
  try { target = new URL(String(u), location._url.href).href; }
  catch (e) { throw __jb.domError("SyntaxError", "'" + u + "' is not a valid URL."); }
  if (target.indexOf("javascript:") === 0) {
    // Top-level javascript: navigation: run the script in a task (a string
    // result would replace the document; not supported at the top level).
    var code = typeof __jb.decodeJavascriptUrl === "function" ? __jb.decodeJavascriptUrl(target) : target.slice(11);
    if (__jb.csp && !__jb.csp.allowsJavascriptUrl(target)) return;
    setTimeout(function () { try { __jb.csp ? __jb.csp.trusted(function () { (0, eval)(code); }) : (0, eval)(code); } catch (e) { __jb.reportException(e); } }, 0);
    return;
  }
  __jb.navigations.push({ type: type, url: target, referrerPolicy: typeof __jb.documentReferrerPolicy === "function" ? __jb.documentReferrerPolicy() : "" });
  console.log("location." + type + ": " + target);
};
// [LegacyUnforgeable] accessor: `location = url` navigates instead of
// replacing the global binding.
Object.defineProperty(globalThis, "location", {
  get: function () { return __jbLocation; },
  set: function (v) { __jbLocation.href = String(v); },
  enumerable: true, configurable: false,
});
globalThis.history = {
  _entries: [{ state: null, url: "about:blank" }], _index: 0,
  get length() { return this._entries.length; },
  get state() { return this._entries[this._index].state; },
  scrollRestoration: "auto",
  pushState: function (state, title, url) { if (arguments.length < 2) throw new TypeError("pushState: 2 arguments required"); this._entries = this._entries.slice(0, this._index + 1); var target = url === undefined || url === null ? location.href : new URL(String(url), location.href).href; if (new URL(target).origin !== location.origin) throw __jb.domError("SecurityError", "cross-origin pushState"); this._entries.push({ state: structuredClone(state), url: target }); this._index++; location._url = new URL(target); __jb.currentDocument.URL = __jb.currentDocument.documentURI = target; __jb.navigations.push({ type: "pushState", url: target }); },
  replaceState: function (state, title, url) { if (arguments.length < 2) throw new TypeError("replaceState: 2 arguments required"); var target = url === undefined || url === null ? location.href : new URL(String(url), location.href).href; if (new URL(target).origin !== location.origin) throw __jb.domError("SecurityError", "cross-origin replaceState"); this._entries[this._index] = { state: structuredClone(state), url: target }; location._url = new URL(target); __jb.currentDocument.URL = __jb.currentDocument.documentURI = target; },
  back: function () { this.go(-1); }, forward: function () { this.go(1); },
  go: function (n) { n = n === undefined ? 0 : n | 0; if (n === 0) { __jb.navigations.push({ type: "reload", url: location.href }); return; } var i = this._index + n; if (i < 0 || i >= this._entries.length) return; var self_ = this; setTimeout(function () { self_._index = i; location._url = new URL(self_._entries[i].url); __jb.currentDocument.URL = __jb.currentDocument.documentURI = location.href; globalThis.dispatchEvent(new PopStateEvent("popstate", { state: self_._entries[i].state })); }, 0); },
};
globalThis.history = history;
globalThis.navigator = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  appVersion: "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  appName: "Netscape", appCodeName: "Mozilla", product: "Gecko", productSub: "20030107", vendor: "Google Inc.", vendorSub: "",
  platform: "Win32", oscpu: undefined, language: "en-US", languages: ["en-US", "en"], onLine: true, cookieEnabled: true, doNotTrack: "1", globalPrivacyControl: false,
  hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0, pdfViewerEnabled: true, webdriver: false,
  userAgentData: { brands: [{ brand: "Google Chrome", version: "131" }, { brand: "Chromium", version: "131" }, { brand: "Not_A Brand", version: "24" }], mobile: false, platform: "Windows", getHighEntropyValues: function () { return Promise.resolve({ architecture: "x86", bitness: "64", model: "", platformVersion: "15.0.0", uaFullVersion: "131.0.6778.205", fullVersionList: [] }); }, toJSON: function () { return { brands: this.brands, mobile: false, platform: "Windows" }; } },
  plugins: Object.assign([], { length: 0, item: function () { return null; }, namedItem: function () { return null; }, refresh: function () {} }),
  mimeTypes: Object.assign([], { length: 0, item: function () { return null; }, namedItem: function () { return null; } }),
  connection: { effectiveType: "4g", downlink: 10, rtt: 50, saveData: false, type: "wifi", addEventListener: function () {}, removeEventListener: function () {} },
  permissions: { query: function () { return Promise.resolve({ state: "prompt", onchange: null, addEventListener: function () {}, removeEventListener: function () {} }); } },
  serviceWorker: { register: function () { return Promise.resolve({ scope: location.origin + "/", update: function () { return Promise.resolve(); }, unregister: function () { return Promise.resolve(true); }, active: null, installing: null, waiting: null, addEventListener: function () {}, pushManager: { subscribe: function () { return Promise.reject(new DOMException("Not supported", "NotSupportedError")); }, getSubscription: function () { return Promise.resolve(null); } } }); }, getRegistration: function () { return Promise.resolve(undefined); }, getRegistrations: function () { return Promise.resolve([]); }, ready: new Promise(function () {}), controller: null, addEventListener: function () {}, removeEventListener: function () {}, startMessages: function () {} },
  geolocation: { getCurrentPosition: function (ok, err) { if (err) setTimeout(function () { err({ code: 1, message: "User denied Geolocation", PERMISSION_DENIED: 1 }); }, 0); }, watchPosition: function (ok, err) { if (err) setTimeout(function () { err({ code: 1, message: "User denied Geolocation" }); }, 0); return 1; }, clearWatch: function () {} },
  clipboard: { writeText: function (t) { __jb.clipboard = String(t); return Promise.resolve(); }, readText: function () { return Promise.resolve(__jb.clipboard || ""); }, write: function () { return Promise.resolve(); }, read: function () { return Promise.resolve([]); } },
  mediaDevices: { getUserMedia: function () { return Promise.reject(new DOMException("Permission denied", "NotAllowedError")); }, enumerateDevices: function () { return Promise.resolve([]); }, getSupportedConstraints: function () { return {}; }, addEventListener: function () {}, removeEventListener: function () {} },
  mediaSession: { setActionHandler: function () {}, metadata: null, playbackState: "none", setPositionState: function () {} },
  storage: { estimate: function () { return Promise.resolve({ quota: 1e10, usage: 0 }); }, persist: function () { return Promise.resolve(false); }, persisted: function () { return Promise.resolve(false); }, getDirectory: function () { return Promise.reject(new DOMException("Not supported", "NotSupportedError")); } },
  locks: { request: function (n, o, cb) { var f = typeof o === "function" ? o : cb; return Promise.resolve(f ? f({ name: n, mode: "exclusive" }) : undefined); }, query: function () { return Promise.resolve({ held: [], pending: [] }); } },
  credentials: { get: function () { return Promise.resolve(null); }, store: function () { return Promise.resolve(); }, create: function () { return Promise.resolve(null); }, preventSilentAccess: function () { return Promise.resolve(); } },
  wakeLock: { request: function () { return Promise.resolve({ released: false, release: function () { return Promise.resolve(); }, addEventListener: function () {} }); } },
  // Unsupported device APIs (bluetooth, usb, xr, gpu, hid, serial, ...) are absent rather than
  // `undefined`: pages feature-detect with `"xr" in navigator` and then dereference the value.
  scheduling: { isInputPending: function () { return false; } },
  sendBeacon: function (url, data) { var target; try { target = new URL(String(url), location.href).href; } catch (e) { throw new TypeError("sendBeacon: invalid URL"); } if (__jb.mixed && __jb.mixed.blocks("", target) || __jb.csp && !__jb.csp.allowsRequest("", target)) return true; var t0 = performance.now(), br = __jb.native("fetch", { url: target, method: "POST", body: typeof data === "string" ? data : "", keepalive: !__jb.wptMode }), t1 = performance.now(); if (br && br.status && typeof performance._addResource === "function") Promise.resolve().then(function () { performance._addResource(target, "beacon", t0, t1, { transfer: 300, encoded: 0, decoded: 0 }, br.status, ""); }); return true; },
  vibrate: function () { return false; }, getBattery: function () { return Promise.resolve({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1, addEventListener: function () {}, removeEventListener: function () {} }); },
  getGamepads: function () { return []; }, javaEnabled: function () { return false; }, taintEnabled: function () { return false; },
  requestMediaKeySystemAccess: function () { return Promise.reject(new DOMException("Unsupported keySystem", "NotSupportedError")); },
  canShare: function () { return false; }, share: function () { return Promise.reject(new DOMException("Share not supported", "NotAllowedError")); },
  registerProtocolHandler: function (scheme, url) { if (arguments.length < 2) throw new TypeError("registerProtocolHandler: At least 2 arguments required"); __jb.checkProtocolHandler(scheme, url); },
  unregisterProtocolHandler: function (scheme, url) { if (arguments.length < 2) throw new TypeError("unregisterProtocolHandler: At least 2 arguments required"); __jb.checkProtocolHandler(scheme, url); },
  setAppBadge: function () { return Promise.resolve(); }, clearAppBadge: function () { return Promise.resolve(); },
  getInstalledRelatedApps: function () { return Promise.resolve([]); },
};
globalThis.navigator = navigator; globalThis.clientInformation = navigator;
// User activation (transient: 5 s after trusted input; consumed by APIs such as showPicker).
Object.defineProperty(navigator, "userActivation", { get: function () { return { get isActive() { return __jb.hasTransientActivation(); }, get hasBeenActive() { return __jb.hasBeenActive; } }; }, configurable: true });
globalThis.screen = { width: 1280, height: 720, availWidth: 1280, availHeight: 680, availLeft: 0, availTop: 0, colorDepth: 24, pixelDepth: 24, orientation: { type: "landscape-primary", angle: 0, onchange: null, lock: function () { return Promise.resolve(); }, unlock: function () {}, addEventListener: function () {}, removeEventListener: function () {} }, isExtended: false };
globalThis.screen = screen;

Object.assign(globalThis, { CustomElementRegistry, IntersectionObserver: IntersectionObserverLegacy, ResizeObserver: ResizeObserverLegacy, PerformanceObserver, ReportingObserver, Report, ReportBody, CSPViolationReportBody, AbstractRange, StaticRange, Range, Selection, NodeIterator, TreeWalker, NodeFilter, CSSStyleSheet, CSSRule, CSS, MediaQueryList, matchMedia, getComputedStyle, DOMImplementation, Document, HTMLDocument, XMLDocument, DOMParser, XMLSerializer });

// HTML "register a protocol handler" argument checks (System state).
__jb.SAFELISTED_SCHEMES = ["bitcoin", "cabal", "dat", "did", "doi", "dweb", "ethereum", "ftp", "ftps", "geo", "hyper", "im", "ipfs", "ipns", "irc", "ircs", "magnet", "mailto", "matrix", "mms", "news", "nntp", "openpgp4fpr", "sftp", "sip", "sms", "smsto", "ssb", "ssh", "tel", "urn", "webcal", "wtai", "xmpp"];
__jb.checkProtocolHandler = function (scheme, url) {
  scheme = String(scheme); url = String(url);
  var norm = scheme.replace(/[A-Z]/g, function (c) { return c.toLowerCase(); });
  var ok = /^web\+[a-z]+$/.test(norm) || __jb.SAFELISTED_SCHEMES.indexOf(norm) >= 0;
  if (!ok) throw __jb.domError("SecurityError", "The scheme '" + scheme + "' is not allowed for protocol handlers");
  if (url.indexOf("%s") < 0) throw __jb.domError("SyntaxError", "The URL must contain '%s'");
  var parsed;
  try { parsed = new URL(url, __jb.currentDocument.baseURI); } catch (e) { throw __jb.domError("SyntaxError", "Invalid URL '" + url + "'"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw __jb.domError("SecurityError", "Protocol handler URLs must be http(s)");
  if (parsed.origin !== location.origin) throw __jb.domError("SecurityError", "Protocol handler URLs must be same-origin");
};

// Document named properties ([LegacyOverrideBuiltIns] is not set: prototype members win):
// named embed/form/iframe/img/object elements, objects by id, and imgs by id when they also
// have a name. One match is returned as is (an iframe as its WindowProxy); several as a collection.
__jb.docNamedMatches = function (doc, name) {
  return __jb.descendants(doc, function (n) {
    if (n.nodeType !== 1 || n._ns !== __jb.HTML_NS) return false;
    var t = n._tag;
    if (/^(embed|form|iframe|img|object)$/.test(t) && n.getAttribute("name") === name) return true;
    if (t === "object" && n.getAttribute("id") === name) return true;
    if (t === "img" && n.getAttribute("id") === name && n.getAttribute("name")) return true;
    return false;
  });
};
__jb.syncDocNamed = function (doc, name) {
  if (!doc || doc.nodeType !== 9 || typeof name !== "string" || name === "") return;
  if (name in Object.getPrototypeOf(doc)) return;
  if (!doc._namedProps) Object.defineProperty(doc, "_namedProps", { value: Object.create(null), writable: true });
  var own = Object.getOwnPropertyDescriptor(doc, name);
  if (own && !doc._namedProps[name]) return; // a script expando
  var has = __jb.docNamedMatches(doc, name).length > 0;
  if (has && !doc._namedProps[name]) {
    doc._namedProps[name] = true;
    Object.defineProperty(doc, name, {
      get: function () {
        var m = __jb.docNamedMatches(doc, name);
        if (!m.length) return undefined;
        if (m.length === 1) { var e = m[0]; if (e._tag === "iframe" && e._contentWindow) return typeof __jb.wrapWindow === "function" ? __jb.wrapWindow(e._contentWindow) : e._contentWindow; return e; }
        return __jb.liveCollection(function () { return __jb.docNamedMatches(doc, name); });
      },
      set: function (v) { delete doc._namedProps[name]; Object.defineProperty(doc, name, { value: v, writable: true, enumerable: true, configurable: true }); },
      enumerable: false, configurable: true,
    });
  } else if (!has && doc._namedProps[name]) {
    delete doc._namedProps[name];
    delete doc[name];
  }
};
__jb.docNamedNamesOf = function (el) {
  var out = [];
  if (el.nodeType !== 1 || el._ns !== __jb.HTML_NS || !/^(embed|form|iframe|img|object)$/.test(el._tag)) return out;
  var nm = el.getAttribute("name"), id = el.getAttribute("id");
  if (nm) out.push(nm);
  if (id && (el._tag === "object" || el._tag === "img")) out.push(id);
  return out;
};
(function () {
  var syncTree = function (node, doc) {
    if (!doc) return;
    var els = node.nodeType === 1 ? [node].concat(__jb.descendants(node, function (n) { return n.nodeType === 1; })) : __jb.descendants(node, function (n) { return n.nodeType === 1; });
    els.forEach(function (e) { __jb.docNamedNamesOf(e).forEach(function (n) { __jb.syncDocNamed(doc, n); }); });
  };
  var baseConnected = __jb.connected;
  __jb.connected = function (node) { baseConnected(node); if (node.nodeType === 1 && node._ns === __jb.HTML_NS && /^(embed|form|iframe|img|object)$/.test(node._tag)) { var d = node.ownerDocument; if (d && node.getRootNode() === d) __jb.docNamedNamesOf(node).forEach(function (n) { __jb.syncDocNamed(d, n); }); } };
  var baseRemove = __jb.remove;
  __jb.remove = function (node, suppressObservers) {
    var doc = node.getRootNode && node.getRootNode().nodeType === 9 ? node.getRootNode() : null;
    baseRemove(node, suppressObservers);
    if (doc && node.nodeType === 1) syncTree(node, doc);
  };
  var baseAttr = __jb.attributeChanged;
  __jb.attributeChanged = function (el, attr, oldValue, newValue) {
    baseAttr(el, attr, oldValue, newValue);
    if (attr._ns === null && (attr._local === "name" || attr._local === "id") && el._ns === __jb.HTML_NS && /^(embed|form|iframe|img|object)$/.test(el._tag)) {
      var d = el.getRootNode(); if (d.nodeType !== 9) return;
      if (oldValue) __jb.syncDocNamed(d, oldValue);
      if (newValue) __jb.syncDocNamed(d, newValue);
      // an img's id only counts while it has a name
      if (el._tag === "img") { var id = el.getAttribute("id"); if (id) __jb.syncDocNamed(d, id); }
    }
  };
  __jb.initDocNamed = function (doc) { syncTree(doc, doc); };
})();
