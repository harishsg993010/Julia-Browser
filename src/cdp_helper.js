// Page side of the Chrome DevTools Protocol server (src/cdp.rs): remote object handles, DOM node
// ids, evaluation with CDP result shapes, box models. Installed once per document as __jb.cdp.
(function () {
  if (__jb.cdp && __jb.cdp.doc === __jb.currentDocument) return;
  var C = __jb.cdp = {
    doc: __jb.currentDocument,
    seq: String(Date.now() % 1e9) + "." + Math.floor(Math.random() * 1e6),
    objs: new Map(), next: 1,
    nodeIds: new WeakMap(), nodes: new Map(), nextNode: 1,
    pending: new Map(), nextPending: 1,
    bindings: [], nextException: 1,
  };

  var isNode = function (v) { try { return typeof Node === "function" && v instanceof Node; } catch (e) { return false; } };
  var className = function (v) { try { var c = v && v.constructor && v.constructor.name; return c || "Object"; } catch (e) { return "Object"; } };

  C.store = function (v) { var id = C.seq + "." + C.next++; C.objs.set(id, v); return id; };
  C.get = function (id) {
    if (!C.objs.has(id)) throw new Error("Could not find object with given id");
    return C.objs.get(id);
  };
  C.release = function (id) { C.objs.delete(id); };

  C.nodeId = function (n) {
    var id = C.nodeIds.get(n);
    if (!id) { id = C.nextNode++; C.nodeIds.set(n, id); C.nodes.set(id, n); }
    return id;
  };
  C.node = function (id) {
    var n = C.nodes.get(id);
    if (!n) throw new Error("Could not find node with given id");
    return n;
  };

  var nodeDescription = function (n) {
    if (n.nodeType === 1) {
      var d = n.localName || n.nodeName.toLowerCase();
      if (n.id) d += "#" + n.id;
      var cls = n.getAttribute && n.getAttribute("class");
      if (cls) d += "." + cls.trim().split(/\s+/).join(".");
      return d;
    }
    if (n.nodeType === 9) return "#document";
    if (n.nodeType === 3) return "#text";
    return n.nodeName;
  };
  C.errorDescription = function (e) {
    var head = (e && e.name ? e.name : "Error") + ": " + (e && e.message !== undefined ? e.message : String(e));
    var stack = e && typeof e.stack === "string" ? e.stack.split("\n").filter(Boolean).map(function (l) { return "    at " + l; }).join("\n") : "";
    return stack ? head + "\n" + stack : head;
  };

  // A value as a CDP RemoteObject; objects get an objectId unless returned by value.
  C.remote = function (v, byValue) {
    var t = typeof v;
    if (v === undefined) return { type: "undefined" };
    if (v === null) return { type: "object", subtype: "null", value: null };
    if (t === "boolean" || t === "string") return { type: t, value: v };
    if (t === "number") {
      if (Number.isNaN(v) || !Number.isFinite(v) || (v === 0 && 1 / v < 0)) return { type: "number", unserializableValue: Number.isNaN(v) ? "NaN" : v === 0 ? "-0" : v > 0 ? "Infinity" : "-Infinity", description: String(v === 0 ? "-0" : v) };
      return { type: "number", value: v, description: String(v) };
    }
    if (t === "bigint") return { type: "bigint", unserializableValue: v + "n", description: v + "n" };
    if (t === "symbol") return { type: "symbol", description: String(v), objectId: C.store(v) };
    if (t === "function") {
      if (byValue) return { type: "function", value: {} };
      var src = ""; try { src = Function.prototype.toString.call(v); } catch (e) {}
      return { type: "function", className: "Function", description: src.length > 200 ? src.slice(0, 200) + "…" : src, objectId: C.store(v) };
    }
    if (byValue) {
      var out;
      try { out = JSON.parse(JSON.stringify(v, function (k, x) { return typeof x === "bigint" ? Number(x) : x; })); } catch (e) { out = undefined; }
      if (isNode(v) && out && typeof out === "object" && !Object.keys(out).length) out = {};
      return { type: "object", value: out === undefined ? {} : out };
    }
    var r = { type: "object", className: className(v), objectId: C.store(v) };
    if (isNode(v)) { r.subtype = "node"; r.description = nodeDescription(v); }
    else if (Array.isArray(v)) { r.subtype = "array"; r.description = "Array(" + v.length + ")"; }
    else if (v instanceof Error) { r.subtype = "error"; r.description = C.errorDescription(v); }
    else if (v instanceof Date) { r.subtype = "date"; r.description = String(v); }
    else if (v instanceof RegExp) { r.subtype = "regexp"; r.description = String(v); }
    else if (typeof Promise === "function" && v instanceof Promise) { r.subtype = "promise"; r.description = "Promise"; }
    else if (typeof Map === "function" && v instanceof Map) { r.subtype = "map"; r.description = "Map(" + v.size + ")"; }
    else if (typeof Set === "function" && v instanceof Set) { r.subtype = "set"; r.description = "Set(" + v.size + ")"; }
    else if (typeof NodeList === "function" && (v instanceof NodeList || (typeof HTMLCollection === "function" && v instanceof HTMLCollection))) { r.subtype = "array"; r.description = className(v) + "(" + v.length + ")"; }
    else if (v === globalThis) { r.className = "Window"; r.description = "Window"; }
    else r.description = r.className;
    return r;
  };

  C.exception = function (e) {
    var ex = C.remote(e, false);
    var text = "Uncaught";
    return { exceptionDetails: { exceptionId: C.nextException++, text: text, lineNumber: 0, columnNumber: 0, exception: ex } };
  };

  var argValue = function (a) {
    if (!a) return undefined;
    if (a.objectId !== undefined) return C.get(a.objectId);
    if (a.unserializableValue !== undefined) {
      var u = a.unserializableValue;
      if (u === "NaN") return NaN; if (u === "Infinity") return Infinity; if (u === "-Infinity") return -Infinity; if (u === "-0") return -0;
      if (/n$/.test(u) && typeof BigInt === "function") return BigInt(u.slice(0, -1));
      return undefined;
    }
    return "value" in a ? a.value : undefined;
  };

  // The outcome of a call: a result, an exception, or a promise to settle later (await).
  var finish = function (fnResult, byValue, awaitPromise) {
    if (awaitPromise && fnResult && typeof fnResult.then === "function") {
      var pid = C.nextPending++;
      C.pending.set(pid, null);
      try {
        fnResult.then(function (v) { C.pending.set(pid, { result: C.remote(v, byValue) }); },
                      function (e) { C.pending.set(pid, C.exception(e)); });
      } catch (e) { C.pending.set(pid, C.exception(e)); }
      return C.settled(pid) || { pending: pid };
    }
    return { result: C.remote(fnResult, byValue) };
  };
  C.settled = function (pid) {
    var r = C.pending.get(pid);
    if (r) { C.pending.delete(pid); return r; }
    if (!C.pending.has(pid)) return C.exception(new Error("Execution context was destroyed."));
    return null;
  };

  C.evaluate = function (expr, byValue, awaitPromise) {
    var v;
    try { v = (0, eval)(expr); } catch (e) { return C.exception(e); }
    return finish(v, byValue, awaitPromise);
  };
  C.call = function (fnSrc, thisId, args, byValue, awaitPromise) {
    var v;
    try {
      var fn = (0, eval)("(" + fnSrc + "\n)");
      var self = thisId ? C.get(thisId) : undefined;
      v = fn.apply(self, (args || []).map(argValue));
    } catch (e) { return C.exception(e); }
    return finish(v, byValue, awaitPromise);
  };

  C.properties = function (id, ownOnly, accessorsOnly) {
    var o = C.get(id), out = [];
    var seen = {};
    for (var p = o, own = true; p !== null && p !== undefined; p = ownOnly ? null : Object.getPrototypeOf(p), own = false) {
      var names; try { names = Object.getOwnPropertyNames(p); } catch (e) { break; }
      for (var i = 0; i < names.length; i++) {
        var n = names[i]; if (seen[n]) continue; seen[n] = true;
        var d = Object.getOwnPropertyDescriptor(p, n); if (!d) continue;
        if (accessorsOnly && !d.get && !d.set) continue;
        var prop = { name: n, configurable: !!d.configurable, enumerable: !!d.enumerable, isOwn: own };
        if ("value" in d) { prop.value = C.remote(d.value, false); prop.writable = !!d.writable; }
        else { if (d.get) prop.get = C.remote(d.get, false); if (d.set) prop.set = C.remote(d.set, false); }
        out.push(prop);
      }
      if (ownOnly) break;
    }
    return { result: out };
  };

  // ---- DOM domain
  C.describe = function (n, depth) {
    var d = {
      nodeId: C.nodeId(n), backendNodeId: C.nodeId(n), nodeType: n.nodeType, nodeName: n.nodeName,
      localName: n.localName || "", nodeValue: n.nodeValue === null || n.nodeValue === undefined ? "" : String(n.nodeValue),
      childNodeCount: n.childNodes ? n.childNodes.length : 0,
    };
    if (n.parentNode) d.parentId = C.nodeId(n.parentNode);
    if (n.nodeType === 1) {
      var attrs = []; for (var i = 0; i < n.attributes.length; i++) attrs.push(n.attributes[i].name, n.attributes[i].value);
      d.attributes = attrs;
      if (n.shadowRoot) d.shadowRoots = [C.describe(n.shadowRoot, 0)];
    }
    if (n.nodeType === 9) { d.documentURL = String(location.href); d.baseURL = String(n.baseURI || location.href); d.xmlVersion = ""; d.compatibilityMode = "NoQuirksMode"; }
    if (n.nodeType === 10) { d.publicId = n.publicId || ""; d.systemId = n.systemId || ""; }
    if (n.nodeType === 11 && n.host) d.shadowRootType = n.mode === "closed" ? "closed" : "open";
    if (depth !== 0 && n.childNodes && n.childNodes.length) {
      var kids = [];
      for (var k = 0; k < n.childNodes.length; k++) kids.push(C.describe(n.childNodes[k], depth < 0 ? -1 : depth - 1));
      d.children = kids;
    }
    return d;
  };
  C.target = function (p) {
    if (p.objectId) return C.get(p.objectId);
    if (p.nodeId) return C.node(p.nodeId);
    if (p.backendNodeId) return C.node(p.backendNodeId);
    throw new Error("Either nodeId, backendNodeId or objectId must be specified");
  };
  var elementOf = function (n) { return n.nodeType === 1 ? n : n.parentElement; };
  var quad = function (r) { return [r.left, r.top, r.right, r.top, r.right, r.bottom, r.left, r.bottom]; };
  C.contentQuads = function (n) {
    var rects = [];
    if (n.nodeType === 3 && typeof document.createRange === "function") { var rg = document.createRange(); rg.selectNodeContents(n); rects = Array.from(rg.getClientRects ? rg.getClientRects() : []); }
    else { var el = elementOf(n); if (el) rects = Array.from(el.getClientRects()); if (!rects.length && el) rects = [el.getBoundingClientRect()]; }
    rects = rects.filter(function (r) { return r.width > 0 && r.height > 0; });
    if (!rects.length) throw new Error("Could not compute content quads.");
    return { quads: rects.map(quad) };
  };
  C.boxModel = function (n) {
    var el = elementOf(n);
    if (!el) throw new Error("Could not compute box model.");
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el), px = function (v) { return parseFloat(v) || 0; };
    var bt = px(cs.borderTopWidth), br = px(cs.borderRightWidth), bb = px(cs.borderBottomWidth), bl = px(cs.borderLeftWidth);
    var pt = px(cs.paddingTop), pr = px(cs.paddingRight), pb = px(cs.paddingBottom), pl = px(cs.paddingLeft);
    var mt = px(cs.marginTop), mr = px(cs.marginRight), mb = px(cs.marginBottom), ml = px(cs.marginLeft);
    var box = function (l, t, rr, b) { return [l, t, rr, t, rr, b, l, b]; };
    return { model: {
      border: box(r.left, r.top, r.right, r.bottom),
      padding: box(r.left + bl, r.top + bt, r.right - br, r.bottom - bb),
      content: box(r.left + bl + pl, r.top + bt + pt, r.right - br - pr, r.bottom - bb - pb),
      margin: box(r.left - ml, r.top - mt, r.right + mr, r.bottom + mb),
      width: r.width, height: r.height,
    } };
  };
  C.scrollIntoView = function (n) {
    var el = elementOf(n);
    if (!el) throw new Error("Node is detached from document");
    __jb.user.scrollIntoView(el);
    return {};
  };
  C.layoutMetrics = function () {
    var de = document.documentElement, b = document.body;
    var w = Math.max(de ? de.scrollWidth : 0, b ? b.scrollWidth : 0, innerWidth), h = Math.max(de ? de.scrollHeight : 0, b ? b.scrollHeight : 0, innerHeight);
    var lv = { pageX: scrollX, pageY: scrollY, clientWidth: innerWidth, clientHeight: innerHeight };
    var vv = { offsetX: 0, offsetY: 0, pageX: scrollX, pageY: scrollY, clientWidth: innerWidth, clientHeight: innerHeight, scale: 1, zoom: 1 };
    var cs = { x: 0, y: 0, width: w, height: h };
    return { layoutViewport: lv, visualViewport: vv, contentSize: cs, cssLayoutViewport: lv, cssVisualViewport: vv, cssContentSize: cs };
  };

  // ---- Runtime.addBinding
  C.addBinding = function (name) {
    globalThis[name] = function (payload) { C.bindings.push({ name: name, payload: String(payload) }); };
  };
  C.takeBindings = function () { var b = C.bindings; C.bindings = []; return b; };

  // ---- Input
  C.mouse = function (p) {
    var U = __jb.user, m = p.modifiers || 0;
    U.modifiers.alt = !!(m & 1); U.modifiers.ctrl = !!(m & 2); U.modifiers.meta = !!(m & 4); U.modifiers.shift = !!(m & 8);
    var button = { left: 0, middle: 1, right: 2, back: 3, forward: 4 }[p.button] || 0;
    var params = p.pointerType ? { pointerType: p.pointerType } : null;
    if (p.type === "mouseMoved") U.movePointer(p.x, p.y, params);
    else if (p.type === "mousePressed") { if (U.pointer.x !== p.x || U.pointer.y !== p.y || !U.pointer.over) U.movePointer(p.x, p.y, params); if (p.clickCount === 1) U.pointer.lastClick = 0; U.press(button, params); }
    else if (p.type === "mouseReleased") { if (U.pointer.x !== p.x || U.pointer.y !== p.y) U.movePointer(p.x, p.y, params); U.release(button, params); }
    else if (p.type === "mouseWheel") {
      var el = U.elementAt(p.x, p.y);
      var ok = U.fire(el, WheelEvent, "wheel", { clientX: p.x, clientY: p.y, deltaX: p.deltaX || 0, deltaY: p.deltaY || 0, deltaMode: 0 });
      if (ok) globalThis.scrollBy(p.deltaX || 0, p.deltaY || 0);
    }
    return {};
  };
  C.key = function (p) {
    var U = __jb.user, key = p.key || "";
    if (key.length !== 1 && p.text && p.text.length === 1 && !/^(Enter|Tab)$/.test(key) && p.text >= " ") key = p.text;
    if (!key) return {};
    if (p.type === "keyDown" || p.type === "rawKeyDown") U.keyDown(key);
    else if (p.type === "keyUp") U.keyUp(key);
    return {};
  };
})();
