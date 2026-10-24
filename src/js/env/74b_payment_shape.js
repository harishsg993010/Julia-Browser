// Part 11f: Payment Request API (request validation and state machine; no payment handlers are
// installed, so show() ends with NotSupportedError) and the Shape Detection API (detectors
// validate their image source and find nothing).
(function () {
  if (globalThis.__jb_workerRealm) return;
  var dom = function (n, m) { return __jb.domError(n, m); };
  var illegal = function () { throw new TypeError("Illegal constructor"); };
  var fullyActive = function () { try { return !(__jb.navApi && __jb.navApi.fullyActive) || __jb.navApi.fullyActive(); } catch (e) { return true; } };
  var activation = function () { return typeof __jb.hasTransientActivation === "function" && __jb.hasTransientActivation(); };
  var consume = function () { if (typeof __jb.consumeUserActivation === "function") __jb.consumeUserActivation(); };
  var policyAllows = function (f) { try { return !__jb.permissionsPolicyAllows || __jb.permissionsPolicyAllows(f); } catch (e) { return true; } };
  var uuid = function () { return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2); };
  var handler = function (proto, name) {
    var slot = "_on" + name;
    Object.defineProperty(proto, "on" + name, {
      get: function () { return this[slot] === undefined ? null : this[slot]; },
      set: function (v) {
        var self_ = this;
        if (!this["_onL" + name]) { Object.defineProperty(this, "_onL" + name, { value: function (e) { var h = self_[slot]; if (typeof h === "function") h.call(self_, e); }, configurable: true }); this.addEventListener(name, this["_onL" + name]); }
        Object.defineProperty(this, slot, { value: typeof v === "function" || (v && typeof v === "object") ? v : null, writable: true, configurable: true });
      },
      enumerable: true, configurable: true,
    });
  };

  // ================================================================ Payment Request
  var STANDARD_PMIS = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  var validPMI = function (s) {
    if (STANDARD_PMIS.test(s)) return true;
    var u;
    try { u = new URL(s); } catch (e) { return false; }
    return u.protocol === "https:" && u.username === "" && u.password === "";
  };
  var MONEY = /^-?[0-9]+(\.[0-9]+)?$/;
  var checkAmount = function (amount, what, nonNegative) {
    if (amount === undefined || amount === null || typeof amount !== "object") throw new TypeError(what + ": amount is required");
    if (amount.currency === undefined) throw new TypeError(what + ": currency is required");
    if (amount.value === undefined) throw new TypeError(what + ": value is required");
    var currency = String(amount.currency), value = String(amount.value);
    if (!/^[A-Za-z]{3}$/.test(currency)) throw new RangeError(what + ": '" + currency + "' is not a well-formed currency code");
    if (!MONEY.test(value)) throw new TypeError(what + ": '" + value + "' is not a valid decimal monetary value");
    if (nonNegative && value.charAt(0) === "-") throw new TypeError(what + ": the total amount cannot be negative");
    return { currency: currency.toUpperCase(), value: value };
  };
  var checkItem = function (item, what, total) {
    if (item === undefined || item === null || typeof item !== "object") throw new TypeError(what + " is required");
    if (item.label === undefined) throw new TypeError(what + ": label is required");
    return { label: String(item.label), amount: checkAmount(item.amount, what, total), pending: !!item.pending };
  };
  var serializeData = function (d, what) {
    if (d === undefined) return null;
    if (d === null || typeof d !== "object") throw new TypeError(what + ": data must be an object");
    return JSON.stringify(d);
  };
  var checkBase = function (details, out, what) {
    if (details.displayItems !== undefined) out.displayItems = __jb.arrayFrom(details.displayItems).map(function (it) { return checkItem(it, what + " display item", false); });
    if (details.shippingOptions !== undefined) {
      var seen = {};
      out.shippingOptions = __jb.arrayFrom(details.shippingOptions).map(function (o) {
        if (o === null || typeof o !== "object" || o.id === undefined || o.label === undefined) throw new TypeError(what + ": shipping option needs an id and a label");
        var id = String(o.id);
        if (Object.prototype.hasOwnProperty.call(seen, id)) throw new TypeError(what + ": duplicate shipping option id '" + id + "'");
        seen[id] = 1;
        return { id: id, label: String(o.label), amount: checkAmount(o.amount, what + " shipping option", false), selected: !!o.selected };
      });
    }
    if (details.modifiers !== undefined) {
      out.modifiers = __jb.arrayFrom(details.modifiers).map(function (m) {
        if (m === null || typeof m !== "object" || m.supportedMethods === undefined) throw new TypeError(what + ": modifier needs supportedMethods");
        var pmi = String(m.supportedMethods);
        if (!validPMI(pmi)) throw new RangeError(what + ": '" + pmi + "' is not a valid payment method identifier");
        var r = { supportedMethods: pmi, data: serializeData(m.data, what + " modifier") };
        if (m.total !== undefined) r.total = checkItem(m.total, what + " modifier total", true);
        if (m.additionalDisplayItems !== undefined) r.additionalDisplayItems = __jb.arrayFrom(m.additionalDisplayItems).map(function (it) { return checkItem(it, what + " modifier item", false); });
        return r;
      });
    }
  };
  var SHIPPING_TYPES = ["shipping", "delivery", "pickup"];
  var showing = function () { var t = __jb.topJb ? __jb.topJb() : __jb; return t.paymentShowing; };
  var setShowing = function (v) { var t = __jb.topJb ? __jb.topJb() : __jb; t.paymentShowing = v; };

  class PaymentRequest extends EventTarget {
    constructor(methodData, details, options) {
      if (arguments.length < 2) throw new TypeError("PaymentRequest constructor: At least 2 arguments required");
      if (globalThis.isSecureContext === false) throw dom("SecurityError", "PaymentRequest requires a secure context");
      var methods = __jb.arrayFrom(methodData);
      if (!methods.length) throw new TypeError("PaymentRequest: at least one payment method is required");
      var seen = {}, parsed = [];
      methods.forEach(function (m) {
        if (m === null || typeof m !== "object" || m.supportedMethods === undefined) throw new TypeError("PaymentRequest: 'supportedMethods' member of PaymentMethodData is required");
        var pmi = String(m.supportedMethods);
        if (!validPMI(pmi)) throw new RangeError("PaymentRequest: '" + pmi + "' is not a valid payment method identifier");
        if (Object.prototype.hasOwnProperty.call(seen, pmi)) throw new RangeError("PaymentRequest: duplicate payment method '" + pmi + "'");
        seen[pmi] = 1;
        parsed.push({ supportedMethods: pmi, data: serializeData(m.data, "PaymentRequest") });
      });
      if (details === null || typeof details !== "object") throw new TypeError("PaymentRequest: details must be a dictionary");
      if (details.total === undefined) throw new TypeError("PaymentRequest: 'total' member of PaymentDetailsInit is required");
      var d = { id: details.id !== undefined ? String(details.id) : uuid(), total: checkItem(details.total, "total", true) };
      checkBase(details, d, "PaymentRequest");
      options = options === undefined || options === null ? {} : options;
      var shippingType = options.shippingType === undefined ? "shipping" : String(options.shippingType);
      if (SHIPPING_TYPES.indexOf(shippingType) < 0) throw new TypeError("PaymentRequest: '" + shippingType + "' is not a valid value for enumeration PaymentShippingType.");
      var selectedOption = null;
      if (options.requestShipping && d.shippingOptions) d.shippingOptions.forEach(function (o) { if (o.selected) selectedOption = o.id; });
      super();
      Object.defineProperty(this, "_p", { value: { state: "created", details: d, methods: parsed, options: options, shippingType: options.requestShipping ? shippingType : null, shippingOption: selectedOption, accept: null, updating: false } });
    }
    get id() { return this._p.details.id; }
    get shippingAddress() { return null; }
    get shippingOption() { return this._p.shippingOption; }
    get shippingType() { return this._p.shippingType; }
    show(detailsPromise) {
      var p = this._p;
      return new Promise(function (resolve, reject) {
        if (!fullyActive()) throw dom("AbortError", "The document is not fully active");
        if (!policyAllows("payment")) throw dom("SecurityError", "payment is disabled by permissions policy");
        try { if (document.visibilityState === "hidden") { p.state = "closed"; throw dom("AbortError", "The document is hidden"); } } catch (e) { if (e && e.name === "AbortError") throw e; }
        if (!activation()) throw dom("SecurityError", "show() must be triggered by user activation");
        consume();
        if (p.state !== "created") throw dom("InvalidStateError", "The request has already been shown or aborted");
        if (showing()) { p.state = "closed"; throw dom("AbortError", "Another payment request is already showing"); }
        p.state = "interactive";
        if (detailsPromise !== undefined) Promise.resolve(detailsPromise).catch(function () {});
        p.state = "closed";
        throw dom("NotSupportedError", "None of the requested payment methods are supported");
      });
    }
    abort() {
      var p = this._p;
      return new Promise(function (resolve) {
        if (p.state !== "interactive") throw dom("InvalidStateError", "The request is not being shown");
        p.state = "closed";
        setShowing(false);
        if (p.accept) p.accept.reject(dom("AbortError", "The request was aborted"));
        resolve(undefined);
      });
    }
    canMakePayment() {
      var p = this._p;
      return new Promise(function (resolve) {
        if (p.state !== "created") throw dom("InvalidStateError", "canMakePayment() is only allowed before show()");
        resolve(false);
      });
    }
  }
  ["shippingaddresschange", "shippingoptionchange", "paymentmethodchange"].forEach(function (n) { handler(PaymentRequest.prototype, n); });

  class PaymentRequestUpdateEvent extends Event {
    constructor(type, init) {
      if (arguments.length < 1) throw new TypeError("PaymentRequestUpdateEvent constructor: At least 1 argument required");
      super(type, init);
      Object.defineProperty(this, "_waiting", { value: false, writable: true });
    }
    updateWith(detailsPromise) {
      if (arguments.length < 1) throw new TypeError("PaymentRequestUpdateEvent.updateWith: At least 1 argument required");
      if (!this.isTrusted) throw dom("InvalidStateError", "updateWith() can only be called on trusted events");
      if (this._waiting) throw dom("InvalidStateError", "updateWith() was already called");
      var target = this.target;
      if (!target || !target._p || target._p.state !== "interactive") throw dom("InvalidStateError", "The request is not interactive");
      this._waiting = true;
      this.stopPropagation(); this.stopImmediatePropagation();
      Promise.resolve(detailsPromise).catch(function () {});
    }
  }
  class PaymentMethodChangeEvent extends PaymentRequestUpdateEvent {
    constructor(type, init) {
      if (arguments.length < 1) throw new TypeError("PaymentMethodChangeEvent constructor: At least 1 argument required");
      super(type, init);
      Object.defineProperty(this, "_m", { value: { name: init && init.methodName !== undefined ? String(init.methodName) : "", details: init && init.methodDetails !== undefined ? init.methodDetails : null } });
    }
    get methodName() { return this._m.name; }
    get methodDetails() { return this._m.details; }
  }
  class PaymentResponse extends EventTarget {
    constructor() { illegal(); super(); }
  }
  ["requestId", "methodName", "details", "shippingAddress", "shippingOption", "payerName", "payerEmail", "payerPhone"].forEach(function (k) {
    Object.defineProperty(PaymentResponse.prototype, k, { get: function () { return this._r ? this._r[k] : null; }, enumerable: true, configurable: true });
  });
  PaymentResponse.prototype.toJSON = function () { var o = {}, self_ = this; ["requestId", "methodName", "details", "shippingAddress", "shippingOption", "payerName", "payerEmail", "payerPhone"].forEach(function (k) { o[k] = self_[k]; }); return o; };
  PaymentResponse.prototype.complete = function () { return Promise.reject(dom("InvalidStateError", "The response is already complete")); };
  PaymentResponse.prototype.retry = function () { return Promise.reject(dom("InvalidStateError", "The response is already complete")); };
  handler(PaymentResponse.prototype, "payerdetailchange");

  // ================================================================ Shape Detection
  var BARCODE_FORMATS = ["aztec", "code_128", "code_39", "code_93", "codabar", "data_matrix", "ean_13", "ean_8", "itf", "pdf417", "qr_code", "unknown", "upc_a", "upc_e"];
  var checkImage = function (image, what) {
    return new Promise(function (resolve) {
      var ok = false;
      var isA = function (n) { return typeof globalThis[n] === "function" && image instanceof globalThis[n]; };
      if (isA("HTMLImageElement")) {
        if (!image.complete) throw dom("InvalidStateError", what + ": the image is not loaded");
        if (image.naturalWidth === 0 && image.getAttribute("src")) throw dom("InvalidStateError", what + ": the image is broken");
        ok = true;
      } else if (isA("HTMLVideoElement")) {
        if (image.readyState === 0) throw dom("InvalidStateError", what + ": the video has no data");
        ok = true;
      } else if (isA("HTMLCanvasElement") || isA("OffscreenCanvas")) {
        if ((image.width === 0 || image.height === 0)) { resolve([]); return; }
        ok = true;
      } else if (isA("ImageBitmap")) {
        if (image.width === 0 && image.height === 0 && image._closed) throw dom("InvalidStateError", what + ": the ImageBitmap is detached");
        ok = true;
      } else if (isA("ImageData") || isA("Blob") || isA("SVGImageElement") || isA("VideoFrame")) ok = true;
      if (!ok) throw new TypeError(what + ": the image is not an ImageBitmapSource");
      if (image && image._originClean === false) throw dom("SecurityError", what + ": the image is tainted by cross-origin data");
      try { if (__jb.isOriginClean && !__jb.isOriginClean(image)) throw dom("SecurityError", what + ": the image is tainted by cross-origin data"); } catch (e) { if (e && e.name === "SecurityError") throw e; }
      resolve([]);
    });
  };
  class BarcodeDetector {
    constructor(options) {
      if (options !== undefined && options !== null && options.formats !== undefined) {
        var f = __jb.arrayFrom(options.formats, String);
        if (!f.length) throw new TypeError("BarcodeDetector: formats cannot be empty");
        f.forEach(function (x) { if (BARCODE_FORMATS.indexOf(x) < 0) throw new TypeError("BarcodeDetector: '" + x + "' is not a valid value for enumeration BarcodeFormat."); if (x === "unknown") throw new TypeError("BarcodeDetector: 'unknown' cannot be requested"); });
      }
    }
    static getSupportedFormats() { return Promise.resolve([]); }
    detect(image) { if (arguments.length < 1) return Promise.reject(new TypeError("BarcodeDetector.detect: At least 1 argument required")); return checkImage(image, "BarcodeDetector.detect"); }
  }
  class FaceDetector {
    constructor(options) {}
    detect(image) { if (arguments.length < 1) return Promise.reject(new TypeError("FaceDetector.detect: At least 1 argument required")); return checkImage(image, "FaceDetector.detect"); }
  }
  class TextDetector {
    constructor() {}
    detect(image) { if (arguments.length < 1) return Promise.reject(new TypeError("TextDetector.detect: At least 1 argument required")); return checkImage(image, "TextDetector.detect"); }
  }
  [PaymentRequest, PaymentRequestUpdateEvent, PaymentMethodChangeEvent, PaymentResponse, BarcodeDetector, FaceDetector, TextDetector].forEach(function (C) {
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
    globalThis[C.name] = C;
  });
})();
