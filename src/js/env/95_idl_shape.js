// Part 8: WebIDL shapes of the global object's own properties (the Window
// interface): operations are writable, enumerable, configurable data
// properties; attributes are enumerable, configurable accessors (with a setter
// when writable; [Replaceable] setters turn the property into a data property;
// event handler attributes only keep functions and objects); `top` is
// [LegacyUnforgeable] (non-configurable, no setter). EventTarget's operations
// are inherited from EventTarget.prototype, not copied onto the window.
// The content-box size of the iframe element showing this realm, from the parent's layout ({w, h}),
// or null (top-level window, popup, WPT mode, no layout). Cached per parent layout key.
__jb.frameViewportSize = function () {
  if (__jb.wptMode || __jb.inFrameViewportSize) return null;
  var fc = __jb.frameContext, fe = fc && fc.frameElement;
  if (!fe || !fe.isConnected) return null;
  var pj = null;
  try { pj = fe.ownerDocument && fe.ownerDocument.defaultView && fe.ownerDocument.defaultView.__jb; } catch (e) { return null; }
  if (!pj || pj.wptMode || typeof pj.layoutKey !== "function") return null;
  var k = pj.layoutKey(), c = __jb.frameViewportCache;
  if (c && c.key === k && c.el === fe) return c.size;
  var size = null;
  __jb.inFrameViewportSize = true;
  try { var w = fe.clientWidth, h = fe.clientHeight; if (w > 0 && h > 0) size = { w: w, h: h }; } catch (e) {}
  finally { __jb.inFrameViewportSize = false; }
  __jb.frameViewportCache = { key: k, el: fe, size: size };
  return size;
};
(function () {
  var g = globalThis;
  var own = function (n) { return Object.getOwnPropertyDescriptor(g, n); };
  var named = function (fn, name) { try { Object.defineProperty(fn, "name", { value: name }); } catch (e) {} return fn; };
  var methods = ["close", "stop", "focus", "blur", "open", "alert", "confirm", "prompt", "print", "postMessage",
    "btoa", "atob", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "createImageBitmap",
    "getSelection", "getComputedStyle", "matchMedia", "moveBy", "moveTo", "resizeBy", "resizeTo", "scroll", "scrollTo", "scrollBy",
    "structuredClone", "reportError", "fetch", "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "cancelIdleCallback", "captureEvents", "releaseEvents"];
  methods.forEach(function (n) {
    var d = own(n);
    if (d && d.configurable && "value" in d && typeof d.value === "function") Object.defineProperty(g, n, { value: d.value, writable: true, enumerable: true, configurable: true });
  });
  var accessor = function (n, mode) {
    var d = own(n);
    if (!d || !d.configurable) return;
    var get, set;
    if ("value" in d) {
      var store = d.value;
      get = named(function () { return store; }, "get " + n);
      if (mode === "writable") set = named(function (v) { store = v; }, "set " + n);
      else if (mode === "handler") {
        if (store !== null && store !== undefined) __jb.handlerSlot(g, n.slice(2), store);
        set = named(function (v) { store = typeof v === "function" || (v !== null && typeof v === "object") ? v : null; __jb.handlerSlot(g, n.slice(2), store); }, "set " + n);
      }
    } else {
      get = d.get;
      if (mode === "writable" || mode === "handler") set = d.set;
      else if (mode === "replaceable") set = d.set;
    }
    // A frame's viewport is its <iframe>'s content box, not the top window's (real pages): a 645px
    // quiz frame laid itself out 1280px wide and was clipped (coolmath4kids).
    if (n === "innerWidth" || n === "innerHeight") {
      var base = get, key = n === "innerWidth" ? "w" : "h";
      get = named(function () { var s = __jb.frameViewportSize ? __jb.frameViewportSize() : null; return s ? s[key] : base(); }, "get " + n);
    }
    if (mode === "replaceable" && !set) set = named(function (v) { Object.defineProperty(g, n, { value: v, writable: true, enumerable: true, configurable: true }); }, "set " + n);
    if (!get) return;
    Object.defineProperty(g, n, { get: get, set: mode === "readonly" ? undefined : set, enumerable: true, configurable: mode !== "unforgeable" });
  };
  ["history", "frameElement", "navigator", "sessionStorage", "localStorage", "customElements", "performance", "crypto", "indexedDB", "caches",
    "visualViewport", "speechSynthesis", "closed", "isSecureContext", "crossOriginIsolated", "originAgentCluster"].forEach(function (n) { accessor(n, "readonly"); });
  ["name", "status", "opener"].forEach(function (n) { accessor(n, "writable"); });
  (__jb.EVENT_HANDLER_NAMES || []).concat(__jb.WINDOW_HANDLER_NAMES || []).forEach(function (n) { accessor("on" + n, "handler"); });
  ["self", "locationbar", "menubar", "personalbar", "scrollbars", "statusbar", "toolbar", "frames", "parent", "external", "length", "origin",
    "screen", "scrollX", "scrollY", "pageXOffset", "pageYOffset", "innerWidth", "innerHeight", "screenLeft", "screenTop", "screenX", "screenY",
    "outerWidth", "outerHeight", "devicePixelRatio", "event", "clientInformation"].forEach(function (n) { accessor(n, "replaceable"); });
  accessor("top", "unforgeable");
})();
