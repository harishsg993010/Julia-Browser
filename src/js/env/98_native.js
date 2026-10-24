// WebIDL attributes and operations are enumerable prototype properties. Interfaces written as ES
// classes (geometry, URL, fetch, encoding, ...) got non-enumerable getters/methods, so `for (k in
// rect)` saw nothing: Highcharts copies getBBox() results with for-in, every label size became
// NaN and CoinMarketCap's price chart was laid out with a NaN plot height (blank).
(function () {
  var names = ["DOMRectReadOnly", "DOMRect", "DOMPointReadOnly", "DOMPoint", "DOMQuad", "DOMMatrixReadOnly", "DOMMatrix", "DOMRectList",
    "URL", "URLSearchParams", "Headers", "Request", "Response", "Blob", "File", "FileReader", "FormData", "TextEncoder", "TextDecoder",
    "AbortController", "AbortSignal", "MessageChannel", "MessagePort", "BroadcastChannel", "ImageData", "Path2D", "TextMetrics",
    "CanvasGradient", "CanvasPattern", "DOMException", "Performance", "PerformanceEntry", "Notification"];
  names.forEach(function (n) {
    var C = globalThis[n];
    if (typeof C !== "function" || !C.prototype) return;
    var p = C.prototype;
    Object.getOwnPropertyNames(p).forEach(function (k) {
      if (k === "constructor" || k.charAt(0) === "_") return;
      var d = Object.getOwnPropertyDescriptor(p, k);
      if (!d || d.enumerable || !d.configurable) return;
      if (!d.get && !d.set && typeof d.value !== "function") return;
      d.enumerable = true;
      try { Object.defineProperty(p, k, d); } catch (e) {}
    });
  });
})();
// Built-ins look native: Function.prototype.toString of an environment function (an interface
// object, a prototype method, getter or setter, a method of navigator/document/...) prints
// "function name() { [native code] }" as in browsers. Sites check this to tell built-ins from
// polyfills (Optimizely "cleanse" deletes non-native members of HTMLElement.prototype; bot
// detectors flag JS-implemented DOM methods).
(function () {
  var natives = new WeakSet();
  var origToString = Function.prototype.toString;
  var seen = new WeakSet();
  function markFn(f) { if (typeof f === "function") natives.add(f); }
  function markProps(o, depth) {
    if (o === null || (typeof o !== "object" && typeof o !== "function") || seen.has(o)) return;
    seen.add(o);
    var names;
    try { names = Object.getOwnPropertyNames(o).concat(Object.getOwnPropertySymbols(o)); } catch (e) { return; }
    names.forEach(function (n) {
      if (typeof n === "string" && n.charAt(0) === "_") return;
      var d;
      try { d = Object.getOwnPropertyDescriptor(o, n); } catch (e) { return; }
      if (!d) return;
      if (d.get) markFn(d.get);
      if (d.set) markFn(d.set);
      if (typeof d.value === "function") {
        markFn(d.value);
        if (depth > 0) { markProps(d.value, depth - 1); if (d.value.prototype) markProps(d.value.prototype, depth - 1); }
      } else if (d.value && typeof d.value === "object" && depth > 0 && !(typeof Node === "function" && d.value instanceof Node)) {
        markProps(d.value, depth - 1);
      }
    });
  }
  // Interface objects, their prototypes and statics; window methods and accessors; the
  // members of objects hanging off window (navigator, document, location, history, ...).
  markProps(globalThis, 2);
  for (var p = Object.getPrototypeOf(globalThis); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) markProps(p, 1);
  [__jb.currentDocument, navigator, location, history, screen, performance, globalThis.crypto, globalThis.localStorage, globalThis.sessionStorage].forEach(function (o) {
    if (!o) return;
    for (var q = o; q && q !== Object.prototype; q = Object.getPrototypeOf(q)) markProps(q, 1);
  });
  // Native-looking source for marked functions (names of accessors keep their get/set prefix).
  function nativeSource(f) {
    var name = "";
    try { name = typeof f.name === "string" ? f.name : ""; } catch (e) {}
    return "function " + name + "() {\n    [native code]\n}";
  }
  var toString = {
    toString: function () {
      if (typeof this === "function" && natives.has(this)) return nativeSource(this);
      return origToString.call(this);
    },
  }.toString;
  natives.add(toString);
  Object.defineProperty(Function.prototype, "toString", { value: toString, writable: true, configurable: true, enumerable: false });
  __jb.markNative = markFn;
  __jb.isNativeLooking = function (f) { return natives.has(f); };
})();
// The attribute methods as the environment defined them (see __jb.attrGet in 35_reflect.js).
if (typeof Element === "function") __jb.nativeAttr = { get: Element.prototype.getAttribute, set: Element.prototype.setAttribute, remove: Element.prototype.removeAttribute, has: Element.prototype.hasAttribute };
