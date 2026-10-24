// Part 11h: Picture-in-Picture (HTMLVideoElement.requestPictureInPicture,
// document.pictureInPictureElement / exitPictureInPicture, PictureInPictureWindow and events)
// and Document Picture-in-Picture (window.documentPictureInPicture.requestWindow opens an
// always-on-top auxiliary window, here a popup realm).
(function () {
  if (globalThis.__jb_workerRealm || typeof HTMLVideoElement !== "function") return;
  var dom = function (n, m) { return __jb.domError(n, m); };
  var TOKEN = {};
  var illegal = function () { throw new TypeError("Illegal constructor"); };
  var activation = function () { return typeof __jb.hasTransientActivation === "function" && __jb.hasTransientActivation(); };
  var consume = function () { if (typeof __jb.consumeUserActivation === "function") __jb.consumeUserActivation(); };
  var policyAllows = function (f) { try { return !__jb.permissionsPolicyAllows || __jb.permissionsPolicyAllows(f); } catch (e) { return true; } };
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

  class PictureInPictureWindow extends EventTarget {
    constructor(tok) { if (tok !== TOKEN) illegal(); super(); Object.defineProperty(this, "_w", { value: { w: 0, h: 0 } }); }
    get width() { return this._w.w; }
    get height() { return this._w.h; }
  }
  handler(PictureInPictureWindow.prototype, "resize");
  class PictureInPictureEvent extends Event {
    constructor(type, init) {
      if (arguments.length < 2) throw new TypeError("PictureInPictureEvent constructor: At least 2 arguments required");
      if (!init || !(init.pictureInPictureWindow instanceof PictureInPictureWindow)) throw new TypeError("PictureInPictureEvent constructor: 'pictureInPictureWindow' member is required");
      super(type, init);
      Object.defineProperty(this, "_win", { value: init.pictureInPictureWindow });
    }
    get pictureInPictureWindow() { return this._win; }
  }

  var state = { el: null, win: null };
  var fireOn = function (el, type, win) {
    var e = new PictureInPictureEvent(type, { bubbles: true, pictureInPictureWindow: win });
    try { __jb.setTrusted(e, true); } catch (x) {}
    el.dispatchEvent(e);
  };
  var exit = function () {
    var el = state.el, win = state.win;
    if (!el) return;
    state.el = null; state.win = null;
    win._w.w = 0; win._w.h = 0;
    fireOn(el, "leavepictureinpicture", win);
  };
  __jb.exitPictureInPicture = exit;
  var enabled = function () { return policyAllows("picture-in-picture"); };

  var VP = HTMLVideoElement.prototype;
  Object.defineProperty(VP, "requestPictureInPicture", { value: function requestPictureInPicture() {
    var video = this;
    return new Promise(function (resolve) {
      if (!(video instanceof HTMLVideoElement)) throw new TypeError("Illegal invocation");
      if (!enabled()) throw dom("NotSupportedError", "Picture-in-Picture is not enabled");
      if (video.readyState === 0) throw dom("InvalidStateError", "The video has no metadata");
      if (!(video.videoWidth > 0) && !(video.srcObject && video.srcObject.getVideoTracks && video.srcObject.getVideoTracks().length)) throw dom("InvalidStateError", "The element has no video track");
      if (video.hasAttribute("disablepictureinpicture")) throw dom("InvalidStateError", "disablePictureInPicture is set");
      if (state.el === null && !activation()) throw dom("NotAllowedError", "requestPictureInPicture() requires a user gesture");
      consume();
      if (state.el === video) { resolve(state.win); return; }
      if (state.el) exit();
      var win = new PictureInPictureWindow(TOKEN);
      win._w.w = Math.min(video.videoWidth || 320, 640); win._w.h = Math.round(win._w.w * ((video.videoHeight || 180) / (video.videoWidth || 320)));
      state.el = video; state.win = win;
      setTimeout(function () { if (state.el === video) fireOn(video, "enterpictureinpicture", win); }, 0);
      resolve(win);
    });
  }, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(VP, "disablePictureInPicture", {
    get: function () { return this.hasAttribute("disablepictureinpicture"); },
    set: function (v) { if (v) this.setAttribute("disablepictureinpicture", ""); else this.removeAttribute("disablepictureinpicture"); if (v && state.el === this) exit(); },
    enumerable: true, configurable: true,
  });
  handler(VP, "enterpictureinpicture"); handler(VP, "leavepictureinpicture");

  var retarget = function (el, scope) {
    // DocumentOrShadowRoot: the element retargeted against the scope
    for (var n = el; n; ) {
      var root = n.getRootNode();
      if (root === scope) return n;
      if (!root.host) return scope.nodeType === 9 && root.nodeType === 9 ? n : null;
      n = root.host;
    }
    return null;
  };
  var pipElementFor = function (scope) {
    var el = state.el;
    if (!el) return null;
    if (!el.isConnected) { exit(); return null; }
    var doc = scope.nodeType === 9 ? scope : scope.ownerDocument;
    if (el.ownerDocument !== doc) return null;
    return retarget(el, scope);
  };
  Object.defineProperty(Document.prototype, "pictureInPictureElement", { get: function () { return pipElementFor(this); }, enumerable: true, configurable: true });
  if (typeof ShadowRoot === "function") Object.defineProperty(ShadowRoot.prototype, "pictureInPictureElement", { get: function () { return pipElementFor(this); }, enumerable: true, configurable: true });
  Object.defineProperty(Document.prototype, "pictureInPictureEnabled", { get: function () { return enabled(); }, enumerable: true, configurable: true });
  Object.defineProperty(Document.prototype, "exitPictureInPicture", { value: function exitPictureInPicture() {
    var doc = this;
    return new Promise(function (resolve) {
      if (!state.el || state.el.ownerDocument !== doc) throw dom("InvalidStateError", "No element is in Picture-in-Picture");
      exit();
      resolve(undefined);
    });
  }, writable: true, enumerable: true, configurable: true });
  try { globalThis.addEventListener("pagehide", function () { exit(); }); } catch (e) {}

  // ================================================================ Document Picture-in-Picture
  class DocumentPictureInPicture extends EventTarget {
    constructor(tok) { if (tok !== TOKEN) illegal(); super(); Object.defineProperty(this, "_d", { value: { win: null } }); }
    get window() { var w = this._d.win; try { if (w && w.closed) this._d.win = w = null; } catch (e) {} return w; }
    requestWindow(options) {
      var self_ = this;
      return new Promise(function (resolve) {
        options = options === undefined || options === null ? {} : options;
        var isTop = false; try { isTop = globalThis.top === globalThis; } catch (e) {}
        if (!isTop) throw dom("NotAllowedError", "requestWindow() must be called from a top-level browsing context");
        try { if (globalThis.opener && globalThis.__jb.isDocumentPip) throw dom("NotAllowedError", "requestWindow() cannot be called from a Picture-in-Picture window"); } catch (e) { if (e && e.name === "NotAllowedError") throw e; }
        if (!activation()) throw dom("NotAllowedError", "requestWindow() requires a user gesture");
        var w = options.width === undefined ? 0 : Number(options.width), h = options.height === undefined ? 0 : Number(options.height);
        if ((w > 0) !== (h > 0)) throw new RangeError("requestWindow(): width and height must both be given");
        consume();
        if (self_._d.win) { try { self_._d.win.close(); } catch (e) {} }
        var win = globalThis.open("about:blank", "", "popup,width=" + (w || 300) + ",height=" + (h || 300));
        if (!win) throw dom("NotAllowedError", "The window could not be opened");
        try { win.__jb.isDocumentPip = true; } catch (e) {}
        self_._d.win = win;
        var ev = new DocumentPictureInPictureEvent("enter", { window: win });
        try { __jb.setTrusted(ev, true); } catch (e) {}
        self_.dispatchEvent(ev);
        resolve(win);
      });
    }
  }
  handler(DocumentPictureInPicture.prototype, "enter");
  class DocumentPictureInPictureEvent extends Event {
    constructor(type, init) {
      if (arguments.length < 2) throw new TypeError("DocumentPictureInPictureEvent constructor: At least 2 arguments required");
      if (!init || init.window === undefined || init.window === null) throw new TypeError("DocumentPictureInPictureEvent constructor: 'window' member is required");
      super(type, init);
      Object.defineProperty(this, "_win", { value: init.window });
    }
    get window() { return this._win; }
  }
  var dpip = null;
  if (globalThis.isSecureContext !== false) {
    Object.defineProperty(globalThis, "documentPictureInPicture", { get: function () { return dpip || (dpip = new DocumentPictureInPicture(TOKEN)); }, enumerable: true, configurable: true });
  }

  [PictureInPictureWindow, PictureInPictureEvent, DocumentPictureInPicture, DocumentPictureInPictureEvent].forEach(function (C) {
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
    globalThis[C.name] = C;
  });
})();
