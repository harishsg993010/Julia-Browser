// ---- Close watchers (HTML "close requests and close watchers") ------------------------
// A per-window close watcher manager groups watchers; user activation allows one more group.
// Esc (a trusted, not cancelled keydown) runs "process close watchers" on the last group.
// <dialog> and auto/hint popovers establish internal close watchers; CloseWatcher is the API.
(function () {
  var mgr = { groups: [], allowed: 1, nextAllowsNewGroup: true };
  __jb.closeWatcherManager = mgr;

  // History-action activation: the last activation that has not been consumed by a close
  // watcher's preventable cancel.
  var lastHistoryActionUse = -Infinity;
  function hasHistoryActionActivation() { return __jb.activationTime !== -Infinity && __jb.activationTime !== lastHistoryActionUse; }
  function consumeHistoryActionActivation() { lastHistoryActionUse = __jb.activationTime; }
  var noteActivation = __jb.noteUserActivation;
  __jb.noteUserActivation = function () {
    noteActivation.apply(this, arguments);
    if (mgr.nextAllowsNewGroup) { mgr.allowed++; mgr.nextAllowsNewGroup = false; }
  };

  function establish(rec) {
    if (mgr.groups.length < mgr.allowed) mgr.groups.push([rec]);
    else mgr.groups[mgr.groups.length - 1].push(rec);
    mgr.nextAllowsNewGroup = true;
    return rec;
  }
  function isActive(rec) { return mgr.groups.some(function (g) { return g.indexOf(rec) >= 0; }); }
  function destroy(rec) {
    mgr.groups.forEach(function (g) { var i = g.indexOf(rec); if (i >= 0) g.splice(i, 1); });
    mgr.groups = mgr.groups.filter(function (g) { return g.length > 0; });
  }
  // A frame's document stops being fully active when its container leaves the document.
  function fullyActive() {
    try {
      var fc = __jb.frameContext;
      if (fc && fc.frameElement && !fc.frameElement.isConnected) return false;
    } catch (e) {}
    var d = __jb.currentDocument || __jb.currentDocument;
    return !d || d._fullyActive !== false;
  }
  function close(rec) {
    if (!isActive(rec) || !fullyActive()) return;
    destroy(rec);
    rec.closeAction();
  }
  function requestClose(rec, requireHistoryActionActivation) {
    if (!isActive(rec)) return true;
    if (!rec.enabled()) return true;
    if (rec.runningCancel) return true;
    if (!fullyActive()) return true;
    var canPreventClose = !requireHistoryActionActivation || (mgr.groups.length < mgr.allowed && hasHistoryActionActivation());
    rec.runningCancel = true;
    var shouldContinue;
    try { shouldContinue = rec.cancelAction(canPreventClose); } finally { rec.runningCancel = false; }
    if (!shouldContinue) { consumeHistoryActionActivation(); return false; }
    if (!isActive(rec)) return true;
    if (!fullyActive()) return true;
    close(rec);
    return true;
  }
  __jb.processCloseWatchers = function () {
    var processed = false;
    if (mgr.groups.length) {
      var group = mgr.groups[mgr.groups.length - 1].slice();
      for (var i = group.length - 1; i >= 0; i--) {
        var rec = group[i];
        if (rec.enabled()) processed = true;
        if (!requestClose(rec, true)) break;
      }
    }
    if (mgr.allowed > 1) mgr.allowed--;
    return processed;
  };
  // Esc keydown handling (10_events.js calls __jb.popoverEscape for trusted, uncancelled Escape).
  __jb.popoverEscape = function () { return __jb.processCloseWatchers(); };

  function fire(target, type, cancelable) {
    var ev = new Event(type, { cancelable: !!cancelable });
    __jb.setTrusted(ev, true); ev._trustedDispatch = true;
    return target.dispatchEvent(ev);
  }

  // ---- popovers: auto and hint popovers have a close watcher while showing ----
  var showPopover = __jb.showPopover, hidePopover = __jb.hidePopover;
  __jb.showPopover = function (el) {
    var r = showPopover.apply(this, arguments);
    if (el._popoverState === "showing" && __jb.popoverValue(el) !== "manual" && !el._closeWatcher) {
      el._closeWatcher = establish({
        cancelAction: function () { return true; },
        closeAction: function () { if (el._popoverState === "showing") __jb.hidePopover(el, false, true); },
        enabled: function () { return true; },
      });
    }
    return r;
  };
  __jb.hidePopover = function (el) {
    var r = hidePopover.apply(this, arguments);
    if (el._popoverState !== "showing" && el._closeWatcher) { destroy(el._closeWatcher); el._closeWatcher = null; }
    return r;
  };

  // ---- dialogs ----
  var dialogOpen = __jb.dialogOpen, dialogClose = __jb.dialogClose;
  // "Set the dialog close watcher": every open, connected dialog has one (show(), showModal() or
  // the open attribute); getting the enabled state reads closedby.
  function setDialogCloseWatcher(el) {
    if (el._closeWatcher || !el.hasAttribute("open") || !el.isConnected) return;
    el._closeWatcher = establish({
      cancelAction: function (canPreventClose) { return fire(el, "cancel", canPreventClose); },
      closeAction: function () { __jb.dialogClose(el, el._requestCloseValue); },
      enabled: function () { return !!el._enableCloseWatcherForRequestClose || el.closedBy !== "none"; },
    });
  }
  __jb.dialogOpenAttributeChanged = function (el, open) {
    if (open) setDialogCloseWatcher(el);
    else if (el._closeWatcher) { destroy(el._closeWatcher); el._closeWatcher = null; }
  };
  __jb.dialogOpen = function (el) {
    var r = dialogOpen.apply(this, arguments);
    setDialogCloseWatcher(el);
    return r;
  };
  __jb.dialogClose = function (el, rv) {
    var r = dialogClose.call(this, el, rv);
    if (!el.hasAttribute("open") && el._closeWatcher) { destroy(el._closeWatcher); el._closeWatcher = null; }
    el._requestCloseValue = undefined;
    return r;
  };
  __jb.dialogRequestClose = function (el, rv) {
    if (!el.hasAttribute("open")) return;
    if (!el._closeWatcher) { __jb.dialogClose(el, rv); return; }
    el._enableCloseWatcherForRequestClose = true;
    el._requestCloseValue = rv;
    try { requestClose(el._closeWatcher, false); }
    finally { el._enableCloseWatcherForRequestClose = false; }
  };

  // ---- CloseWatcher ----
  var records = new WeakMap();
  class CloseWatcher extends EventTarget {
    constructor(options) {
      super();
      if (!fullyActive()) throw __jb.domError("InvalidStateError", "The document is not fully active");
      var self = this;
      var signal = options && options.signal;
      if (signal !== undefined && signal !== null && !(signal instanceof AbortSignal)) throw new TypeError("signal is not an AbortSignal");
      var rec = {
        cancelAction: function (canPreventClose) { return fire(self, "cancel", canPreventClose); },
        closeAction: function () { fire(self, "close", false); },
        enabled: function () { return true; },
      };
      records.set(this, rec);
      if (signal && signal.aborted) return;
      establish(rec);
      if (signal) signal.addEventListener("abort", function () { destroy(rec); });
    }
    requestClose() { var r = records.get(this); if (!r) throw new TypeError("Illegal invocation"); requestClose(r, false); }
    close() { var r = records.get(this); if (!r) throw new TypeError("Illegal invocation"); close(r); }
    destroy() { var r = records.get(this); if (!r) throw new TypeError("Illegal invocation"); destroy(r); }
  }
  ["cancel", "close"].forEach(function (type) {
    var slot = "_on" + type;
    Object.defineProperty(CloseWatcher.prototype, "on" + type, {
      get: function () { return this[slot] === undefined ? null : this[slot]; },
      set: function (v) {
        this[slot] = typeof v === "function" || (v !== null && typeof v === "object") ? v : null;
        __jb.handlerSlot(this, type, this[slot]);
      },
      enumerable: true, configurable: true,
    });
  });
  ["requestClose", "close", "destroy"].forEach(function (m) { var d = Object.getOwnPropertyDescriptor(CloseWatcher.prototype, m); d.enumerable = true; Object.defineProperty(CloseWatcher.prototype, m, d); });
  Object.defineProperty(CloseWatcher.prototype, Symbol.toStringTag, { value: "CloseWatcher", configurable: true });
  Object.defineProperty(globalThis, "CloseWatcher", { value: CloseWatcher, writable: true, configurable: true, enumerable: false });
})();
