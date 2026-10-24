// Part 2: Events and EventTarget
class Event {
  constructor(type, init) {
    if (arguments.length < 1) throw new TypeError("Event constructor: At least 1 argument required, but only 0 passed");
    if (init !== undefined && init !== null && typeof init !== "object" && typeof init !== "function") throw new TypeError("Event constructor: Argument 2 can't be converted to a dictionary.");
    init = init || {};
    // IDL attributes live in an internal slot behind prototype getters; isTrusted is [LegacyUnforgeable].
    Object.defineProperty(this, "_ev", { value: { type: String(type), bubbles: !!init.bubbles, cancelable: !!init.cancelable, composed: !!init.composed, defaultPrevented: false, target: null, currentTarget: null, eventPhase: 0, timeStamp: performance.now(), isTrusted: false } });
    Object.defineProperty(this, "isTrusted", { get: __jb.isTrustedGetter, enumerable: true, configurable: false });
    this._stop = false;
    this._stopImmediate = false;
    this._initialized = true;
    this._dispatching = false;
  }
  preventDefault() { if (this.cancelable && !this._inPassive) this._ev.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; this._stopImmediate = true; }
  composedPath() {
    // DOM "composedPath()": hide nodes inside closed shadow trees the current target cannot see.
    var path = this._path, out = [];
    if (!path || !path.length) return out;
    var ct = this.currentTarget; out.push(ct);
    var ctIndex = 0, ctLevel = 0, i;
    for (i = path.length - 1; i >= 0; i--) { if (path[i].rootOfClosed) ctLevel++; if (path[i].item === ct) { ctIndex = i; break; } if (path[i].slotInClosed) ctLevel--; }
    var level = ctLevel, max = ctLevel;
    for (i = ctIndex - 1; i >= 0; i--) { if (path[i].rootOfClosed) level++; if (level <= max) out.unshift(path[i].item); if (path[i].slotInClosed) { level--; if (level < max) max = level; } }
    level = ctLevel; max = ctLevel;
    for (i = ctIndex + 1; i < path.length; i++) { if (path[i].slotInClosed) level++; if (level <= max) out.push(path[i].item); if (path[i].rootOfClosed) { level--; if (level < max) max = level; } }
    return out;
  }
  initEvent(type, bubbles, cancelable) { if (arguments.length < 1) throw new TypeError("initEvent: 1 argument required"); if (this._dispatching) return; this._initialized = true; this._stop = false; this._stopImmediate = false; this._ev.defaultPrevented = false; __jb.setTrusted(this, false); this._ev.target = null; this._ev.type = String(type); this._ev.bubbles = !!bubbles; this._ev.cancelable = !!cancelable; }
  get srcElement() { return this.target; }
  get returnValue() { return !this.defaultPrevented; }
  set returnValue(v) { if (!v && this.cancelable && !this._inPassive) this._ev.defaultPrevented = true; }
  get cancelBubble() { return this._stop; } set cancelBubble(v) { if (v) this._stop = true; }
}
Event.NONE = 0; Event.CAPTURING_PHASE = 1; Event.AT_TARGET = 2; Event.BUBBLING_PHASE = 3;
__jb.isTrustedGetter = function () { return !!(this._ev && this._ev.isTrusted); };
__jb.setTrusted = function (ev, v) { if (ev && ev._ev) ev._ev.isTrusted = !!v; else if (ev) { try { ev.isTrusted = v; } catch (e) {} } };
["type", "target", "currentTarget", "eventPhase", "bubbles", "cancelable", "defaultPrevented", "composed", "timeStamp"].forEach(function (k) {
  Object.defineProperty(Event.prototype, k, { get: { [k]: function () { if (!this || !this._ev) throw new TypeError("'get " + k + "' called on an object that does not implement interface Event."); return this._ev[k]; } }[k], enumerable: true, configurable: true });
});
class CustomEvent extends Event { constructor(type, init) { super(type, init); this.detail = init && init.detail !== undefined ? init.detail : null; } initCustomEvent(t, b, c, d) { if (this._dispatching) return; this.initEvent(t, b, c); this.detail = d === undefined ? null : d; } }
// UI Events: full IDL attribute surface, legacy init*Event methods and modifier queries.
__jb.MODIFIER_KEYS = { Alt: "altKey", AltGraph: "modifierAltGraph", CapsLock: "modifierCapsLock", Control: "ctrlKey", Fn: "modifierFn", FnLock: "modifierFnLock", Hyper: "modifierHyper", Meta: "metaKey", NumLock: "modifierNumLock", ScrollLock: "modifierScrollLock", Shift: "shiftKey", Super: "modifierSuper", Symbol: "modifierSymbol", SymbolLock: "modifierSymbolLock" };
__jb.initModifiers = function (ev, init) { ev._ev.ctrlKey = !!init.ctrlKey; ev._ev.shiftKey = !!init.shiftKey; ev._ev.altKey = !!init.altKey; ev._ev.metaKey = !!init.metaKey; Object.keys(__jb.MODIFIER_KEYS).forEach(function (k) { var f = __jb.MODIFIER_KEYS[k]; if (f.indexOf("modifier") === 0) ev["_" + f] = !!init[f]; }); };
__jb.modifierState = function (ev, key) { var f = __jb.MODIFIER_KEYS[String(key)]; if (!f) return false; return f.indexOf("modifier") === 0 ? !!ev["_" + f] : !!ev[f]; };
class UIEvent extends Event {
  constructor(type, init = undefined) {
    super(type, init); init = init || {};
    if (init.view !== undefined && init.view !== null && !(typeof init.view === "object" && (init.view === globalThis || init.view.window === init.view))) throw new TypeError("UIEventInit.view must be a Window or null");
    this._ev.view = init.view === undefined ? null : init.view; this._ev.detail = init.detail === undefined ? 0 : init.detail | 0; this._which = init.which === undefined ? 0 : init.which >>> 0;
  }
  get which() { return this._which; }
  get sourceCapabilities() { return null; }
  initUIEvent(type, bubbles, cancelable, view, detail) { if (arguments.length < 1) throw new TypeError("initUIEvent: 1 argument required"); if (this._dispatching) return; this.initEvent(type, bubbles, cancelable); this._ev.view = view === undefined ? null : view; this._ev.detail = detail === undefined ? 0 : detail | 0; }
}
class MouseEvent extends UIEvent {
  constructor(type, init = undefined) {
    super(type, init); init = init || {};
    this._ev.screenX = init.screenX === undefined ? 0 : Number(init.screenX); this._ev.screenY = init.screenY === undefined ? 0 : Number(init.screenY);
    this._ev.clientX = init.clientX === undefined ? 0 : Number(init.clientX); this._ev.clientY = init.clientY === undefined ? 0 : Number(init.clientY);
    this._ev.button = init.button === undefined ? 0 : (init.button << 16) >> 16; this._ev.buttons = init.buttons === undefined ? 0 : init.buttons & 0xffff;
    if (init.relatedTarget !== undefined && init.relatedTarget !== null && !(init.relatedTarget instanceof EventTarget)) throw new TypeError("MouseEventInit.relatedTarget must be an EventTarget or null");
    this._ev.relatedTarget = init.relatedTarget || null;
    this._ev.movementX = init.movementX === undefined ? 0 : Number(init.movementX); this._ev.movementY = init.movementY === undefined ? 0 : Number(init.movementY);
    __jb.initModifiers(this, init);
    this._pageX = undefined; this._pageY = undefined; this._offset = undefined;
  }
  get x() { return this.clientX; } get y() { return this.clientY; }
  get pageX() { if (this._pageX !== undefined) return this._pageX; return this.clientX + ((this._dispatching || this._dispatched) && typeof globalThis !== "undefined" ? globalThis.scrollX || 0 : 0); }
  get pageY() { if (this._pageY !== undefined) return this._pageY; return this.clientY + ((this._dispatching || this._dispatched) && typeof globalThis !== "undefined" ? globalThis.scrollY || 0 : 0); }
  get offsetX() { return this._offsetFor(0); } get offsetY() { return this._offsetFor(1); }
  _offsetFor(axis) {
    // relative to the target's padding edge, computed while dispatching and kept afterwards
    var c = this._ev && this._ev.offsetCache;
    if (c) return c[axis];
    if (!this._dispatching) return axis ? this.pageY : this.pageX;
    var t = this.target; if (!t || t.nodeType !== 1 || typeof t.getBoundingClientRect !== "function") return axis ? this.clientY : this.clientX;
    var r = t.getBoundingClientRect(), bl = t.clientLeft || 0, bt = t.clientTop || 0;
    var v = [this.clientX - r.left - bl, this.clientY - r.top - bt];
    if (this._ev) this._ev.offsetCache = v;
    return v[axis];
  }
  get layerX() { return this.pageX; } get layerY() { return this.pageY; }
  get which() { return this.button + 1; }
  getModifierState(key) { if (arguments.length < 1) throw new TypeError("getModifierState: 1 argument required"); return __jb.modifierState(this, key); }
  initMouseEvent(type, bubbles, cancelable, view, detail, screenX, screenY, clientX, clientY, ctrlKey, altKey, shiftKey, metaKey, button, relatedTarget) {
    if (arguments.length < 1) throw new TypeError("initMouseEvent: 1 argument required"); if (this._dispatching) return;
    this.initUIEvent(type, bubbles, cancelable, view, detail);
    this._ev.screenX = screenX === undefined ? 0 : Number(screenX); this._ev.screenY = screenY === undefined ? 0 : Number(screenY); this._ev.clientX = clientX === undefined ? 0 : Number(clientX); this._ev.clientY = clientY === undefined ? 0 : Number(clientY);
    this._ev.ctrlKey = !!ctrlKey; this._ev.altKey = !!altKey; this._ev.shiftKey = !!shiftKey; this._ev.metaKey = !!metaKey; this._ev.button = button === undefined ? 0 : (button << 16) >> 16; this._ev.relatedTarget = relatedTarget || null;
  }
}
// Pointer Events "converting between tiltX/tiltY and altitudeAngle/azimuthAngle".
__jb.tiltToSpherical = function (tiltX, tiltY) {
  var PI = Math.PI, xr = tiltX * PI / 180, yr = tiltY * PI / 180, az = 0, alt = 0;
  if (tiltX === 0) { if (tiltY > 0) az = PI / 2; else if (tiltY < 0) az = 3 * PI / 2; }
  else if (tiltY === 0) { if (tiltX < 0) az = PI; }
  else if (Math.abs(tiltX) === 90 || Math.abs(tiltY) === 90) az = 0;
  else { az = Math.atan2(Math.tan(yr), Math.tan(xr)); if (az < 0) az += 2 * PI; }
  if (Math.abs(tiltX) === 90 || Math.abs(tiltY) === 90) alt = 0;
  else if (tiltX === 0) alt = PI / 2 - Math.abs(yr);
  else if (tiltY === 0) alt = PI / 2 - Math.abs(xr);
  else alt = Math.atan(1 / Math.sqrt(Math.pow(Math.tan(xr), 2) + Math.pow(Math.tan(yr), 2)));
  return [az, alt];
};
__jb.sphericalToTilt = function (az, alt) {
  var PI = Math.PI, xr = 0, yr = 0;
  if (alt === 0) {
    if (az === 0 || az === 2 * PI) xr = PI / 2;
    else if (az === PI / 2) yr = PI / 2;
    else if (az === PI) xr = -PI / 2;
    else if (az === 3 * PI / 2) yr = -PI / 2;
    else if (az > 0 && az < PI / 2) { xr = PI / 2; yr = PI / 2; }
    else if (az > PI / 2 && az < PI) { xr = -PI / 2; yr = PI / 2; }
    else if (az > PI && az < 3 * PI / 2) { xr = -PI / 2; yr = -PI / 2; }
    else if (az > 3 * PI / 2 && az < 2 * PI) { xr = PI / 2; yr = -PI / 2; }
  } else {
    var t = Math.tan(alt);
    xr = Math.atan(Math.cos(az) / t);
    yr = Math.atan(Math.sin(az) / t);
  }
  return [Math.round(xr * 180 / PI) || 0, Math.round(yr * 180 / PI) || 0];
};
class PointerEvent extends MouseEvent {
  constructor(type, init = undefined) {
    super(type, init); init = init || {};
    this._ev.pointerId = init.pointerId === undefined ? 0 : init.pointerId | 0; this._ev.width = init.width === undefined ? 1 : Number(init.width); this._ev.height = init.height === undefined ? 1 : Number(init.height);
    this._ev.pressure = init.pressure === undefined ? 0 : Number(init.pressure); this._ev.tangentialPressure = init.tangentialPressure === undefined ? 0 : Number(init.tangentialPressure);
    this._ev.tiltX = init.tiltX === undefined ? 0 : init.tiltX | 0; this._ev.tiltY = init.tiltY === undefined ? 0 : init.tiltY | 0; this._ev.twist = init.twist === undefined ? 0 : init.twist | 0;
    this._ev.altitudeAngle = init.altitudeAngle === undefined ? Math.PI / 2 : Number(init.altitudeAngle); this._ev.azimuthAngle = init.azimuthAngle === undefined ? 0 : Number(init.azimuthAngle);
    // Pointer Events: tiltX/tiltY and azimuthAngle/altitudeAngle derive from each other when only one pair is given.
    var hasTilt = init.tiltX !== undefined || init.tiltY !== undefined, hasAngles = init.azimuthAngle !== undefined || init.altitudeAngle !== undefined;
    if (hasTilt && !hasAngles) { var sa = __jb.tiltToSpherical(this._ev.tiltX, this._ev.tiltY); this._ev.azimuthAngle = sa[0]; this._ev.altitudeAngle = sa[1]; }
    else if (hasAngles && !hasTilt) { var tl = __jb.sphericalToTilt(this._ev.azimuthAngle, this._ev.altitudeAngle); this._ev.tiltX = tl[0]; this._ev.tiltY = tl[1]; }
    this._ev.pointerType = init.pointerType === undefined ? "" : String(init.pointerType); this._ev.isPrimary = !!init.isPrimary; this._ev.persistentDeviceId = init.persistentDeviceId === undefined ? 0 : init.persistentDeviceId | 0;
    this._coalesced = Array.isArray(init.coalescedEvents) ? init.coalescedEvents.slice() : []; this._predicted = Array.isArray(init.predictedEvents) ? init.predictedEvents.slice() : [];
  }
  getCoalescedEvents() { return this._coalesced.slice(); }
  getPredictedEvents() { return this._predicted.slice(); }
}
class WheelEvent extends MouseEvent {
  constructor(type, init = undefined) { super(type, init); init = init || {}; this._ev.deltaX = init.deltaX === undefined ? (init.wheelDeltaX !== undefined ? -init.wheelDeltaX : 0) : Number(init.deltaX); this._ev.deltaY = init.deltaY === undefined ? (init.wheelDeltaY !== undefined ? -init.wheelDeltaY : 0) : Number(init.deltaY); this._ev.deltaZ = init.deltaZ === undefined ? 0 : Number(init.deltaZ); this._ev.deltaMode = init.deltaMode === undefined ? 0 : init.deltaMode >>> 0; }
  get wheelDelta() { return -this.deltaY; } get wheelDeltaX() { return -this.deltaX; } get wheelDeltaY() { return -this.deltaY; }
}
WheelEvent.DOM_DELTA_PIXEL = WheelEvent.prototype.DOM_DELTA_PIXEL = 0; WheelEvent.DOM_DELTA_LINE = WheelEvent.prototype.DOM_DELTA_LINE = 1; WheelEvent.DOM_DELTA_PAGE = WheelEvent.prototype.DOM_DELTA_PAGE = 2;
class KeyboardEvent extends UIEvent {
  constructor(type, init = undefined) {
    super(type, init); init = init || {};
    this._ev.key = init.key === undefined ? "" : String(init.key); this._ev.code = init.code === undefined ? "" : String(init.code); this._ev.location = init.location === undefined ? 0 : init.location >>> 0;
    this._ev.repeat = !!init.repeat; this._ev.isComposing = !!init.isComposing;
    this._ev.charCode = init.charCode === undefined ? 0 : init.charCode >>> 0; this._ev.keyCode = init.keyCode === undefined ? 0 : init.keyCode >>> 0;
    this._which = init.which === undefined ? this.keyCode : init.which >>> 0;
    __jb.initModifiers(this, init);
  }
  get which() { return this._which; }
  getModifierState(key) { if (arguments.length < 1) throw new TypeError("getModifierState: 1 argument required"); return __jb.modifierState(this, key); }
  initKeyboardEvent(type, bubbles, cancelable, view, key, location, ctrlKey, altKey, shiftKey, metaKey) {
    if (arguments.length < 1) throw new TypeError("initKeyboardEvent: 1 argument required"); if (this._dispatching) return;
    this.initUIEvent(type, bubbles, cancelable, view, 0);
    this._ev.key = key === undefined ? "" : String(key); this._ev.location = location === undefined ? 0 : location >>> 0; this._ev.ctrlKey = !!ctrlKey; this._ev.altKey = !!altKey; this._ev.shiftKey = !!shiftKey; this._ev.metaKey = !!metaKey;
  }
}
[["DOM_KEY_LOCATION_STANDARD", 0], ["DOM_KEY_LOCATION_LEFT", 1], ["DOM_KEY_LOCATION_RIGHT", 2], ["DOM_KEY_LOCATION_NUMPAD", 3]].forEach(function (c) { [KeyboardEvent, KeyboardEvent.prototype].forEach(function (o) { Object.defineProperty(o, c[0], { value: c[1], writable: false, enumerable: true, configurable: false }); }); });
class FocusEvent extends UIEvent { constructor(type, init = undefined) { super(type, init); init = init || {}; if (init.relatedTarget !== undefined && init.relatedTarget !== null && !(init.relatedTarget instanceof EventTarget)) throw new TypeError("FocusEventInit.relatedTarget must be an EventTarget or null"); this._ev.relatedTarget = init.relatedTarget || null; } }
class InputEvent extends UIEvent {
  constructor(type, init = undefined) { super(type, init); init = init || {}; this._ev.data = init.data === undefined ? null : (init.data === null ? null : String(init.data)); this._ev.inputType = init.inputType === undefined ? "" : String(init.inputType); this._ev.isComposing = !!init.isComposing; this._targetRanges = Array.isArray(init.targetRanges) ? init.targetRanges.slice() : []; this._ev.dataTransfer = init.dataTransfer === undefined ? null : init.dataTransfer; }
  get dataTransfer() { return this._ev.dataTransfer === undefined ? null : this._ev.dataTransfer; }
  getTargetRanges() { return this._dispatching ? this._targetRanges.slice() : []; }
}
class CompositionEvent extends UIEvent {
  constructor(type, init = undefined) { super(type, init); init = init || {}; this._ev.data = init.data === undefined ? "" : String(init.data); }
  initCompositionEvent(type, bubbles, cancelable, view, data) { if (arguments.length < 1) throw new TypeError("initCompositionEvent: 1 argument required"); if (this._dispatching) return; this.initUIEvent(type, bubbles, cancelable, view, 0); this._ev.data = data === undefined ? "" : String(data); }
}
class TextEvent extends UIEvent {
  // TextEvent has no constructor: instances come from document.createEvent("TextEvent") or the UA
  constructor(type, init = undefined) { if (!__jb.textEventCreating) throw new TypeError("Illegal constructor"); super(type, init); init = init || {}; this._ev.data = init.data === undefined ? "" : String(init.data); }
  initTextEvent(type, bubbles, cancelable, view, data) { if (arguments.length < 1) throw new TypeError("initTextEvent: 1 argument required"); if (this._dispatching) return; this.initUIEvent(type, bubbles, cancelable, view, 0); this._ev.data = data === undefined ? "undefined" : String(data); }
}
class TouchEvent extends UIEvent {
  constructor(type, init) {
    if (arguments.length < 1) throw new TypeError("TouchEvent constructor: 1 argument required");
    super(type, init); init = init || {};
    var list = function (v, m) { if (v === undefined) return __jb.makeTouchList([]); if (v === null || typeof v !== "object" || typeof v[Symbol.iterator] !== "function") throw new TypeError("TouchEventInit." + m + " is not a sequence"); var a = __jb.arrayFrom(v); a.forEach(function (t) { if (!(t instanceof Touch)) throw new TypeError("TouchEventInit." + m + " contains a non-Touch value"); }); return __jb.makeTouchList(a); };
    this._ev.touches = list(init.touches, "touches"); this._ev.targetTouches = list(init.targetTouches, "targetTouches"); this._ev.changedTouches = list(init.changedTouches, "changedTouches");
    this._ev.altKey = !!init.altKey; this._ev.metaKey = !!init.metaKey; this._ev.ctrlKey = !!init.ctrlKey; this._ev.shiftKey = !!init.shiftKey;
    this._ev.mods = { Alt: !!init.altKey, Meta: !!init.metaKey, Control: !!init.ctrlKey, Shift: !!init.shiftKey, AltGraph: !!init.modifierAltGraph, CapsLock: !!init.modifierCapsLock, Fn: !!init.modifierFn, FnLock: !!init.modifierFnLock, Hyper: !!init.modifierHyper, NumLock: !!init.modifierNumLock, ScrollLock: !!init.modifierScrollLock, Super: !!init.modifierSuper, Symbol: !!init.modifierSymbol, SymbolLock: !!init.modifierSymbolLock };
  }
  getModifierState(key) { if (arguments.length < 1) throw new TypeError("getModifierState: 1 argument required"); var m = this._ev && this._ev.mods; return !!(m && m[String(key)]); }
}
class ErrorEvent extends Event { constructor(type, init) { super(type, init); init = init || {}; this._ev.message = init.message || ""; this._ev.filename = init.filename || ""; this._ev.lineno = init.lineno || 0; this._ev.colno = init.colno || 0; this._ev.error = init.error; } }
// DOM "retarget A against B": climb out of shadow trees that B is not inside of.
__jb.retargetNode = function (a, b) {
  for (;;) {
    if (!a || typeof a.getRootNode !== "function") return a;
    var root = a.getRootNode();
    if (!(root.nodeType === 11 && root._host)) return a;
    for (var n = b; n; n = n.parentNode || (n.nodeType === 11 && n._host ? n._host : null)) if (n === root) return a;
    a = root._host;
  }
};
// `source` of ToggleEvent/CommandEvent is retargeted against currentTarget (the document after dispatch).
__jb.eventSourceGetter = function () { var s = this._source; if (!s) return null; var ref = this.currentTarget; if (!ref || !ref.nodeType) { if (!ref && !this._dispatched && !this._dispatching) return s; ref = s.ownerDocument; } return __jb.retargetNode(s, ref); };
__jb.eventSourceInit = function (ev, init, iface) { var src = init.source; if (src !== undefined && src !== null && !(__jb.isNode(src) && src.nodeType === 1)) throw new TypeError("Failed to construct '" + iface + "': member source is not of type Element."); Object.defineProperty(ev, "_source", { value: src || null, writable: true }); };
__jb.setRelatedTarget = function (ev, v) { if (ev._ev && Object.prototype.hasOwnProperty.call(ev._ev, "relatedTarget")) ev._ev.relatedTarget = v; else { try { ev.relatedTarget = v; } catch (e) {} } };
// UI event attributes are prototype accessors (WebIDL), backed by the event's internal slots.
["view", "detail"].forEach(function (a) { if (!Object.getOwnPropertyDescriptor(UIEvent.prototype, a)) Object.defineProperty(UIEvent.prototype, a, { get: function () { var s = this._ev; return s && a in s ? s[a] : undefined; }, enumerable: true, configurable: true }); });
["screenX", "screenY", "clientX", "clientY", "button", "buttons", "relatedTarget", "movementX", "movementY", "ctrlKey", "altKey", "shiftKey", "metaKey"].forEach(function (a) { if (!Object.getOwnPropertyDescriptor(MouseEvent.prototype, a)) Object.defineProperty(MouseEvent.prototype, a, { get: function () { var s = this._ev; return s && a in s ? s[a] : undefined; }, enumerable: true, configurable: true }); });
// Legacy MouseEvent.fromElement / toElement (null on pointer events).
Object.defineProperty(MouseEvent.prototype, "fromElement", { get: function () { if (this instanceof PointerEvent) return null; var t = this.type; return /^(mouseover|mouseenter)$/.test(t) ? this.relatedTarget : /^(mouseout|mouseleave)$/.test(t) ? this.target : null; }, enumerable: true, configurable: true });
Object.defineProperty(MouseEvent.prototype, "toElement", { get: function () { if (this instanceof PointerEvent) return null; var t = this.type; return /^(mouseover|mouseenter)$/.test(t) ? this.target : /^(mouseout|mouseleave)$/.test(t) ? this.relatedTarget : null; }, enumerable: true, configurable: true });
["pointerId", "width", "height", "pressure", "tangentialPressure", "tiltX", "tiltY", "twist", "altitudeAngle", "azimuthAngle", "pointerType", "isPrimary", "persistentDeviceId"].forEach(function (a) { if (!Object.getOwnPropertyDescriptor(PointerEvent.prototype, a)) Object.defineProperty(PointerEvent.prototype, a, { get: function () { var s = this._ev; return s && a in s ? s[a] : undefined; }, enumerable: true, configurable: true }); });
["deltaX", "deltaY", "deltaZ", "deltaMode"].forEach(function (a) { if (!Object.getOwnPropertyDescriptor(WheelEvent.prototype, a)) Object.defineProperty(WheelEvent.prototype, a, { get: function () { var s = this._ev; return s && a in s ? s[a] : undefined; }, enumerable: true, configurable: true }); });
["key", "code", "location", "repeat", "isComposing", "charCode", "keyCode", "ctrlKey", "altKey", "shiftKey", "metaKey"].forEach(function (a) { if (!Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, a)) Object.defineProperty(KeyboardEvent.prototype, a, { get: function () { var s = this._ev; return s && a in s ? s[a] : undefined; }, enumerable: true, configurable: true }); });
["relatedTarget"].forEach(function (a) { if (!Object.getOwnPropertyDescriptor(FocusEvent.prototype, a)) Object.defineProperty(FocusEvent.prototype, a, { get: function () { var s = this._ev; return s && a in s ? s[a] : undefined; }, enumerable: true, configurable: true }); });
["data", "inputType", "isComposing"].forEach(function (a) { if (!Object.getOwnPropertyDescriptor(InputEvent.prototype, a)) Object.defineProperty(InputEvent.prototype, a, { get: function () { var s = this._ev; return s && a in s ? s[a] : undefined; }, enumerable: true, configurable: true }); });
["data"].forEach(function (a) { if (!Object.getOwnPropertyDescriptor(CompositionEvent.prototype, a)) Object.defineProperty(CompositionEvent.prototype, a, { get: function () { var s = this._ev; return s && a in s ? s[a] : undefined; }, enumerable: true, configurable: true }); });
["data"].forEach(function (a) { if (!Object.getOwnPropertyDescriptor(TextEvent.prototype, a)) Object.defineProperty(TextEvent.prototype, a, { get: function () { var s = this._ev; return s && a in s ? s[a] : undefined; }, enumerable: true, configurable: true }); });
["touches", "targetTouches", "changedTouches", "altKey", "metaKey", "ctrlKey", "shiftKey"].forEach(function (a) { if (!Object.getOwnPropertyDescriptor(TouchEvent.prototype, a)) Object.defineProperty(TouchEvent.prototype, a, { get: function () { var s = this._ev; return s && a in s ? s[a] : undefined; }, enumerable: true, configurable: true }); });
["message", "filename", "lineno", "colno", "error"].forEach(function (a) { if (!Object.getOwnPropertyDescriptor(ErrorEvent.prototype, a)) Object.defineProperty(ErrorEvent.prototype, a, { get: function () { var s = this._ev; return s && a in s ? s[a] : undefined; }, enumerable: true, configurable: true }); });
class ToggleEvent extends Event { constructor(type, init) { super(type, init); init = init || {}; this.oldState = init.oldState === undefined ? "" : String(init.oldState); this.newState = init.newState === undefined ? "" : String(init.newState); __jb.eventSourceInit(this, init, "ToggleEvent"); } get source() { return __jb.eventSourceGetter.call(this); } }
class CommandEvent extends Event { constructor(type, init) { if (arguments.length < 1) throw new TypeError("Failed to construct 'CommandEvent': 1 argument required, but only 0 present."); super(type, init); init = init || {}; __jb.eventSourceInit(this, init, "CommandEvent"); Object.defineProperty(this, "_command", { value: init.command === undefined ? "" : String(init.command) }); } get command() { return this._command; } get source() { return __jb.eventSourceGetter.call(this); } }
class PromiseRejectionEvent extends Event { constructor(type, init) { super(type, init); this.promise = init && init.promise; this.reason = init && init.reason; } }
class MessageEvent extends Event { constructor(type, init) { super(type, init); init = init || {}; this.data = init.data === undefined ? null : init.data; this.origin = init.origin || ""; this.lastEventId = ""; this.source = init.source || null; this.ports = init.ports || []; } }
class CloseEvent extends Event { constructor(type, init) { super(type, init); init = init || {}; this.code = init.code || 1000; this.reason = init.reason || ""; this.wasClean = init.wasClean !== false; } }
class ProgressEvent extends Event { constructor(type, init) { super(type, init); init = init || {}; this.lengthComputable = !!init.lengthComputable; this.loaded = init.loaded || 0; this.total = init.total || 0; } }
class StorageEvent extends Event { constructor(type, init) { super(type, init); init = init || {}; this.key = init.key || null; this.oldValue = init.oldValue || null; this.newValue = init.newValue || null; this.url = init.url || ""; this.storageArea = init.storageArea || null; } }
class HashChangeEvent extends Event { constructor(type, init) { super(type, init); init = init || {}; this.oldURL = init.oldURL || ""; this.newURL = init.newURL || ""; } }
class PopStateEvent extends Event { constructor(type, init) { super(type, init); this.state = (init && init.state) || null; } }
class PageTransitionEvent extends Event { constructor(type, init) { super(type, init); this.persisted = !!(init && init.persisted); } }
class TransitionEvent extends Event {
  constructor(type, init = undefined) {
    if (arguments.length < 1) throw new TypeError("TransitionEvent: 1 argument required");
    super(type, init);
    if (init !== undefined && init !== null && typeof init !== "object" && typeof init !== "function") throw new TypeError("TransitionEventInit must be an object");
    init = init || {};
    var et = init.elapsedTime === undefined ? 0 : +init.elapsedTime; if (!isFinite(et)) throw new TypeError("elapsedTime must be finite");
    this._ev.propertyName = init.propertyName === undefined ? "" : String(init.propertyName); this._ev.elapsedTime = et; this._ev.pseudoElement = init.pseudoElement === undefined ? "" : String(init.pseudoElement); this._ev.animation = init.animation === undefined ? null : init.animation;
  }
  get animation() { return this._ev.animation; }
  get propertyName() { return this._ev.propertyName; }
  get elapsedTime() { return this._ev.elapsedTime; }
  get pseudoElement() { return this._ev.pseudoElement; }
}
class AnimationEvent extends Event {
  constructor(type, init = undefined) {
    if (arguments.length < 1) throw new TypeError("AnimationEvent: 1 argument required");
    super(type, init);
    if (init !== undefined && init !== null && typeof init !== "object" && typeof init !== "function") throw new TypeError("AnimationEventInit must be an object");
    init = init || {};
    var et = init.elapsedTime === undefined ? 0 : +init.elapsedTime; if (!isFinite(et)) throw new TypeError("elapsedTime must be finite");
    this._ev.animationName = init.animationName === undefined ? "" : String(init.animationName); this._ev.elapsedTime = et; this._ev.pseudoElement = init.pseudoElement === undefined ? "" : String(init.pseudoElement); this._ev.animation = init.animation === undefined ? null : init.animation;
  }
  get animation() { return this._ev.animation; }
  get animationName() { return this._ev.animationName; }
  get elapsedTime() { return this._ev.elapsedTime; }
  get pseudoElement() { return this._ev.pseudoElement; }
}
[TransitionEvent, AnimationEvent].forEach(function (C) { ["propertyName", "animationName", "elapsedTime", "pseudoElement", "animation"].forEach(function (k) { var d = Object.getOwnPropertyDescriptor(C.prototype, k); if (d) { var g = d.get; d.get = function () { if (!(this instanceof C)) throw new TypeError("Illegal invocation"); return g.call(this); }; Object.defineProperty(d.get, "name", { value: "get " + k }); d.enumerable = true; Object.defineProperty(C.prototype, k, d); } }); });
class SubmitEvent extends Event { constructor(type, init) { super(type, init); this.submitter = (init && init.submitter) || null; } }
class BeforeUnloadEvent extends Event {
  constructor(type, init) { if (__jb.constructingUA !== true) throw new TypeError("Illegal constructor"); super(type === undefined ? "beforeunload" : type, init || { cancelable: true }); this._returnValue = ""; }
  get returnValue() { return this._returnValue === undefined ? "" : this._returnValue; }
  set returnValue(v) { this._returnValue = String(v); }
}
class DragEvent extends MouseEvent { constructor(type, init) { super(type, init); this.dataTransfer = (init && init.dataTransfer) || new DataTransfer(); } }
class ClipboardEvent extends Event { constructor(type, init) { if (arguments.length < 1) throw new TypeError("ClipboardEvent constructor: 1 argument required"); super(type, init); var cd = init && init.clipboardData; if (cd !== undefined && cd !== null && !(cd instanceof DataTransfer)) throw new TypeError("ClipboardEventInit.clipboardData is not a DataTransfer"); this._ev.clipboardData = cd || null; } get clipboardData() { return this._ev ? this._ev.clipboardData : null; } }
class DataTransferItem { constructor(kind, type, data) { this.kind = kind; this.type = type; this._data = data; } getAsString(cb) { if (this.kind === "string" && typeof cb === "function") setTimeout(cb, 0, this._data); } getAsFile() { return this.kind === "file" ? this._data : null; } }
class DataTransferItemList {
  constructor(dt) { Object.defineProperty(this, "_dt", { value: dt }); Object.defineProperty(this, "_list", { value: [] }); }
  get length() { return this._list.length; }
  add(data, type) {
    var item;
    if (typeof File !== "undefined" && data instanceof File) item = new DataTransferItem("file", data.type, data);
    else { var t = String(type === undefined ? "" : type).toLowerCase(); if (this._list.some(function (i) { return i.kind === "string" && i.type === t; })) throw new DOMException("An item of that type already exists", "NotSupportedError"); item = new DataTransferItem("string", t, String(data)); }
    this._list.push(item); this._dt._sync(); return item;
  }
  remove(i) { this._list.splice(i, 1); this._dt._sync(); }
  clear() { this._list.length = 0; this._dt._sync(); }
  [Symbol.iterator]() { return this._list[Symbol.iterator](); }
}
class DataTransfer {
  constructor() { this.dropEffect = "none"; this.effectAllowed = "all"; Object.defineProperty(this, "items", { value: new DataTransferItemList(this), enumerable: true }); this._sync(); }
  _sync() {
    var list = this.items._list, files = typeof FileList !== "undefined" ? new FileList() : [], types = [];
    for (var i = 0; i < list.length; i++) { list[i] = list[i]; Object.defineProperty(this.items, i, { value: list[i], configurable: true, enumerable: true, writable: false }); if (list[i].kind === "file") { files.push(list[i]._data); if (types.indexOf("Files") < 0) types.push("Files"); } else types.push(list[i].type); }
    for (var j = list.length; j in this.items; j++) delete this.items[j];
    this.files = files; this.types = types;
  }
  setData(t, d) { t = String(t).toLowerCase(); if (t === "text") t = "text/plain"; if (t === "url") t = "text/uri-list"; var list = this.items._list; for (var i = list.length - 1; i >= 0; i--) if (list[i].kind === "string" && list[i].type === t) list.splice(i, 1); list.push(new DataTransferItem("string", t, String(d))); this._sync(); }
  getData(t) { t = String(t).toLowerCase(); if (t === "text") t = "text/plain"; if (t === "url") t = "text/uri-list"; var item = this.items._list.filter(function (i) { return i.kind === "string" && i.type === t; })[0]; if (!item) return ""; return t === "text/uri-list" ? (item._data.split(/\r?\n/).filter(function (l) { return l && l.charAt(0) !== "#"; })[0] || "") : item._data; }
  clearData(t) { var list = this.items._list; if (t === undefined) { for (var i = list.length - 1; i >= 0; i--) if (list[i].kind === "string") list.splice(i, 1); } else { t = String(t).toLowerCase(); if (t === "text") t = "text/plain"; if (t === "url") t = "text/uri-list"; for (var k = list.length - 1; k >= 0; k--) if (list[k].kind === "string" && list[k].type === t) list.splice(k, 1); } this._sync(); }
  setDragImage() {}
}

__jb.defaultPassive = function (target, type) {
  if (!/^(touchstart|touchmove|wheel|mousewheel)$/.test(type)) return false;
  if (target === globalThis) return true;
  if (target && target.nodeType === 9) return true;
  var doc = target && target.ownerDocument;
  return !!(doc && (target === doc.documentElement || target === doc.body));
};
// Event handler attributes are listeners registered when first set to a
// non-null value (HTML "event handler" processing order).
__jb.handlerSlot = function (target, type, value) {
  if (!target._jbListeners) target._jbListeners = Object.create(null);
  var list = target._jbListeners[type] || (target._jbListeners[type] = []);
  var at = -1;
  for (var i = 0; i < list.length; i++) if (list[i].handlerSlot) { at = i; break; }
  if (value === null || value === undefined) { if (at >= 0) list.splice(at, 1); return; }
  if (at < 0) list.push({ handlerSlot: true, listener: null, capture: false, once: false, passive: false });
};
class EventTarget {
  constructor() { this._jbListeners = Object.create(null); }
  addEventListener(type, listener, options) {
    if (!listener) return;
    if (!this._jbListeners) this._jbListeners = Object.create(null);
    var capture = typeof options === "boolean" ? options : !!(options && options.capture);
    var once = !!(options && options.once);
    var passive = options && typeof options === "object" && options.passive !== undefined ? !!options.passive : __jb.defaultPassive(this, type);
    if (options && typeof options === "object" && options.signal && options.signal.aborted) return;
    var list = this._jbListeners[type] || (this._jbListeners[type] = []);
    if (list.some(function (l) { return l.listener === listener && l.capture === capture; })) return;
    list.push({ listener: listener, capture: capture, once: once, passive: passive, signal: options && options.signal });
    if (options && options.signal && options.signal.addEventListener) {
      var self_ = this;
      options.signal.addEventListener("abort", function () { self_.removeEventListener(type, listener, options); });
    }
  }
  removeEventListener(type, listener, options) {
    if (!this._jbListeners || !this._jbListeners[type]) return;
    var capture = typeof options === "boolean" ? options : !!(options && options.capture);
    // A removed listener is flagged so clones taken by an ongoing dispatch skip it.
    this._jbListeners[type] = this._jbListeners[type].filter(function (l) { var m = l.listener === listener && l.capture === capture; if (m) l.removed = true; return !m; });
  }
  _invokeListeners(event, phase) {
    if (phase === Event.AT_TARGET) {
      // At the target, capturing listeners run before bubbling ones and a
      // stopPropagation() in between cancels the bubbling ones.
      this._invokeListeners(event, -1);
      if (!event._stop) this._invokeListeners(event, -2);
      return;
    }
    if (!this._jbListeners) this._jbListeners = Object.create(null);
    var list = (this._jbListeners[event.type] || []).slice();
    event._ev.currentTarget = this;
    var wantCapture = phase === Event.CAPTURING_PHASE || phase === -1;
    var wantBubble = phase === Event.BUBBLING_PHASE || phase === -2;
    if (phase < 0) event._ev.eventPhase = Event.AT_TARGET;
    var sawHandlerSlot = false;
    for (var i = 0; i < list.length; i++) {
      var l = list[i];
      if (l.removed) continue;
      if (l.handlerSlot) { sawHandlerSlot = true; if (wantBubble) { this._invokeHandler(event, phase); if (event._checkpoint) __jb_native("runJobs", ""); } if (event._stopImmediate) break; continue; }
      if (wantCapture && !wantBubble && !l.capture) continue;
      if (wantBubble && !wantCapture && l.capture) continue;
      if (l.once) this.removeEventListener(event.type, l.listener, l.capture);
      if (l.passive) event._inPassive = true;
      try {
        if (typeof l.listener === "function") { if (__jb.loafOn) __jb.loafRun("event-listener", __jb.loafTargetName ? __jb.loafTargetName(this, event.type) : "", l.listener, this, [event]); else l.listener.call(this, event); }
        else if (l.listener && typeof l.listener === "object") { var he = l.listener.handleEvent; if (typeof he !== "function") throw new TypeError("handleEvent is not callable"); he.call(l.listener, event); }
      } catch (e) {
        __jb.listenerExceptions = (__jb.listenerExceptions || 0) + 1;
        __jb.reportException(e);
      } finally { event._inPassive = false; }
      // "Clean up after running a callback": events fired by a task (not by script) see a
      // microtask checkpoint after each listener.
      if (event._checkpoint) __jb_native("runJobs", "");
      if (event._stopImmediate) break;
    }
    // on<type> handler property without a slot (set before slots existed, or on
    // objects whose handlers are plain properties): runs after the listeners.
    if (!sawHandlerSlot && !event._stopImmediate) this._invokeHandler(event, phase);
  }
  _invokeHandler(event, phase) {
    var handler = this["on" + event.type];
    if (typeof handler === "function" && phase !== Event.CAPTURING_PHASE && phase !== -1) {
      try {
        var r;
        // Window onerror receives (message, source, lineno, colno, error).
        if (event.type === "error" && event instanceof ErrorEvent && (this === globalThis || this.window === this)) r = handler.call(this, event.message, event.filename, event.lineno, event.colno, event.error);
        else r = handler.call(this, event);
        if (event.type === "beforeunload" && (this === globalThis || this.window === this || this._tag === "body" || this._tag === "frameset")) {
          // OnBeforeUnloadEventHandler returns DOMString?: only a BeforeUnloadEvent is canceled by it.
          var rv = r === null || r === undefined ? null : String(r);
          if (rv !== null && Object.prototype.toString.call(event) === "[object BeforeUnloadEvent]") { event.preventDefault(); if (event.returnValue === "") event.returnValue = rv; }
          r = undefined;
        }
        if (r === false && event.type !== "error") event.preventDefault(); else if (r === true && event.type === "error") event.preventDefault();
      } catch (e) { __jb.listenerExceptions = (__jb.listenerExceptions || 0) + 1; __jb.reportException(e); }
    }
  }
  dispatchEvent(event) {
    if (!(event instanceof Event) && !(event && typeof event === "object" && typeof event.type === "string" && "defaultPrevented" in event && "eventPhase" in event)) throw new TypeError("dispatchEvent: Argument 1 is not an Event");
    if (event._dispatching || event._initialized === false) throw __jb.domError("InvalidStateError", "The event is already being dispatched or was never initialized");
    event._dispatching = true;
    if (event._trustedDispatch) delete event._trustedDispatch; else __jb.setTrusted(event, false); // script-dispatched events are never trusted
    try { return __jb.dispatch(this, event); } finally { event._dispatching = false; event._dispatched = true; }
  }
  _dispatchInner(event) { return __jb.runEventPath(event, __jb.buildEventPath(this, event)); }
  _dispatchPath(event) { return __jb.runEventPath(event, __jb.buildEventPath(this, event)); }
}
// ---- DOM Standard "dispatch" (event paths through shadow trees, retargeting, composedPath)
__jb.isEventNode = function (x) { return x !== null && typeof x === "object" && typeof x.nodeType === "number" && typeof x.getRootNode === "function"; };
__jb.isShadowRoot = function (x) { return __jb.isEventNode(x) && x.nodeType === 11 && !!x._host; };
// Is a a shadow-including inclusive ancestor of b?
__jb.shadowIncludingInclusiveAncestor = function (a, b) {
  for (var n = b; n; n = n.parentNode || (n.nodeType === 11 && n._host ? n._host : null)) if (n === a) return true;
  return false;
};
// "Get the parent" of an event target.
__jb.eventGetParent = function (x, event, firstRoot) {
  if (__jb.isEventNode(x)) {
    if (x.nodeType === 11 && x._host) return !event.composed && x === firstRoot ? null : x._host;
    if (x.nodeType === 9) { if (event.type === "load") return null; var w = null; try { w = x.defaultView; } catch (e) {} return w || null; }
    var slot = typeof __jb.assignedSlotOf === "function" ? __jb.assignedSlotOf(x) : null;
    return slot || x.parentNode || null;
  }
  if (x === globalThis || (x && x.window === x)) return null;
  return (x && x._eventParent) || null;
};
__jb.buildEventPath = function (target, event) {
  var path = [], activationTarget = null;
  var isActivation = event.type === "click" && event instanceof MouseEvent;
  var hasRelProp = "relatedTarget" in event;
  var relSrc = hasRelProp ? event.relatedTarget : (event._source !== undefined ? event._source : null);
  var rt = relSrc ? __jb.retargetNode(relSrc, target) : null;
  var firstRoot = __jb.isEventNode(target) ? target.getRootNode() : null;
  var mk = function (item, adjusted, related, slotInClosed) {
    var inShadow = __jb.isEventNode(item) && __jb.isShadowRoot(item.getRootNode());
    return { item: item, inShadow: inShadow, target: adjusted, related: related, rootOfClosed: __jb.isShadowRoot(item) && item.mode === "closed", slotInClosed: slotInClosed };
  };
  if (target !== rt || target === relSrc) {
    path.push(mk(target, event._legacyTarget || target, rt, false));
    if (isActivation && __jb.isEventNode(target) && target.nodeType === 1 && __jb.hasActivationBehavior(target)) activationTarget = target;
    var slottable = __jb.isEventNode(target) && typeof __jb.assignedSlotOf === "function" && __jb.assignedSlotOf(target) ? target : null;
    var slotInClosed = false;
    var parent = __jb.eventGetParent(target, event, firstRoot);
    while (parent) {
      if (slottable) { slottable = null; var pr = parent.getRootNode(); if (__jb.isShadowRoot(pr) && pr.mode === "closed") slotInClosed = true; }
      if (__jb.isEventNode(parent) && typeof __jb.assignedSlotOf === "function" && __jb.assignedSlotOf(parent)) slottable = parent;
      rt = relSrc ? __jb.retargetNode(relSrc, parent) : null;
      if (!__jb.isEventNode(parent) || (__jb.isEventNode(target) && __jb.shadowIncludingInclusiveAncestor(target.getRootNode(), parent))) {
        if (isActivation && event.bubbles && !activationTarget && __jb.isEventNode(parent) && parent.nodeType === 1 && __jb.hasActivationBehavior(parent)) activationTarget = parent;
        path.push(mk(parent, null, rt, slotInClosed));
      } else if (parent === rt) {
        parent = null;
      } else {
        target = parent;
        if (isActivation && !activationTarget && parent.nodeType === 1 && __jb.hasActivationBehavior(parent)) activationTarget = parent;
        path.push(mk(parent, target, rt, slotInClosed));
      }
      if (parent) parent = __jb.eventGetParent(parent, event, firstRoot);
      slotInClosed = false;
    }
  }
  return { path: path, activationTarget: activationTarget, hasRelProp: hasRelProp };
};
__jb.runEventPath = function (event, built) {
  var path = built.path;
  event._path = path;
  var clearTargets = false;
  for (var c = path.length - 1; c >= 0; c--) if (path[c].target !== null) {
    var cs = path[c];
    clearTargets = (__jb.isEventNode(cs.target) && __jb.isShadowRoot(cs.target.getRootNode())) || (__jb.isEventNode(cs.related) && __jb.isShadowRoot(cs.related.getRootNode()));
    break;
  }
  var prevEvent = globalThis.event;
  var invoke = function (i, phase) {
    var s = path[i];
    for (var j = i; j >= 0; j--) if (path[j].target !== null) { event._ev.target = path[j].target; break; }
    if (built.hasRelProp) __jb.setRelatedTarget(event, s.related);
    if (event._stop) return;
    globalThis.event = s.inShadow ? undefined : event;
    var p = s.target !== null ? (phase === "capturing" ? -1 : -2) : (phase === "capturing" ? Event.CAPTURING_PHASE : Event.BUBBLING_PHASE);
    var inv = s.item && s.item._invokeListeners; (typeof inv === "function" ? inv : EventTarget.prototype._invokeListeners).call(s.item, event, p);
  };
  try {
    for (var i = path.length - 1; i >= 0; i--) { event._ev.eventPhase = path[i].target !== null ? Event.AT_TARGET : Event.CAPTURING_PHASE; invoke(i, "capturing"); }
    for (var k = 0; k < path.length; k++) {
      if (path[k].target !== null) event._ev.eventPhase = Event.AT_TARGET;
      else { if (!event.bubbles) continue; event._ev.eventPhase = Event.BUBBLING_PHASE; }
      invoke(k, "bubbling");
    }
  } finally { globalThis.event = prevEvent; }
  event._ev.eventPhase = Event.NONE; event._ev.currentTarget = null; event._path = null;
  event._stop = false; event._stopImmediate = false;
  if (clearTargets) { event._ev.clearedTarget = event._ev.target; event._ev.target = null; if (built.hasRelProp) __jb.setRelatedTarget(event, null); }
  return !event.defaultPrevented;
};
// HTML "activation triggering input event".
__jb.isActivationTriggering = function (event) {
  switch (event.type) {
    case "keydown": return event.key !== "Escape";
    case "mousedown": case "touchend": return true;
    case "pointerdown": return event.pointerType === "mouse" || event.pointerType === undefined || event.pointerType === "";
    case "pointerup": return event.pointerType !== undefined && event.pointerType !== "" && event.pointerType !== "mouse";
    default: return false;
  }
};
// Full dispatch: legacy pre-activation (checkbox/radio), propagation, then activation behavior.
__jb.dispatch = function (target, event) {
  var built = __jb.buildEventPath(target, event);
  var activationTarget = built.activationTarget;
  var pre = null;
  if (activationTarget && activationTarget._tag === "input" && activationTarget._ns === __jb.HTML_NS) {
    var t = __jb.inputType(activationTarget);
    if (t === "checkbox") { pre = { checked: activationTarget.checked, indeterminate: activationTarget.indeterminate }; activationTarget._checked = !pre.checked; activationTarget.indeterminate = false; }
    else if (t === "radio") { pre = { checked: activationTarget.checked, prevChecked: __jb.checkedRadioIn(activationTarget) }; __jb.protoAssign(activationTarget, "checked", true); }
  }
  var result = __jb.runEventPath(event, built);
  event._dispatching = false; // activation behavior runs after the dispatch flag is unset
  // Popover light dismiss and close requests only react to trusted (user) input.
  if (event.isTrusted && typeof __jb.noteUserActivation === "function" && __jb.isActivationTriggering(event)) __jb.noteUserActivation();
  if (event.isTrusted && typeof __jb.popoverLightDismiss === "function") {
    if (event.type === "pointerdown" && event instanceof PointerEvent) __jb.popoverPointerdown(target.nodeType === 1 ? target : null);
    else if (event.type === "pointerup" && event instanceof PointerEvent) __jb.popoverLightDismiss(target.nodeType === 1 ? target : null);
    else if (event.type === "keydown" && event.key === "Escape" && !event.defaultPrevented && !event._escapeHandled) { event._escapeHandled = true; __jb.popoverEscape(); }
  }
  if (activationTarget) {
    if (event.defaultPrevented) { if (pre) { if (pre.prevChecked !== undefined) { activationTarget._checked = pre.checked; if (pre.prevChecked) pre.prevChecked._checked = true; } else { activationTarget._checked = pre.checked; activationTarget.indeterminate = pre.indeterminate; } } }
    else __jb.activate(activationTarget, event);
  }
  return result;
};
__jb.checkedRadioIn = function (el) { var root = __jb.formOwner(el) || el.getRootNode(); var name = el.getAttribute("name"); if (!name) return null; return __jb.descendants(root, function (n) { return n.nodeType === 1 && n !== el && n._tag === "input" && __jb.inputType(n) === "radio" && n.getAttribute("name") === name && __jb.formOwner(n) === __jb.formOwner(el) && n.checked; })[0] || null; };
// HTML "interactive content".
__jb.isInteractiveContent = function (el) {
  if (el._ns !== __jb.HTML_NS) return false;
  switch (el._tag) {
    case "a": return el.hasAttribute("href");
    case "audio": case "video": return el.hasAttribute("controls");
    case "img": return el.hasAttribute("usemap");
    case "input": return __jb.inputType(el) !== "hidden";
    case "button": case "details": case "embed": case "iframe": case "label": case "select": case "textarea": return true;
    default: return false;
  }
};
__jb.svgAnchorHref = function (el) {
  var h = el.getAttribute("href");
  if (h === null && el.getAttributeNS) h = el.getAttributeNS("http://www.w3.org/1999/xlink", "href");
  return h;
};
__jb.hasActivationBehavior = function (el) {
  // SVG <a> follows its hyperlink like HTML's
  if (el._ns === __jb.SVG_NS && el._local === "a") return __jb.svgAnchorHref(el) !== null;
  if (el._ns !== __jb.HTML_NS) return false;
  switch (el._tag) {
    case "a": case "area": return el.hasAttribute("href");
    case "button": return true;
    case "input": return __jb.inputType(el) !== "hidden"; // otherwise the behavior depends on the type at activation time
    case "label": case "summary": case "select": case "textarea": return el._tag === "label" || el._tag === "summary";
    default: return false;
  }
};
__jb.activate = function (el, event) {
  if (__jb.isDisabled(el) && el._tag !== "a" && el._tag !== "area" && el._tag !== "label" && el._tag !== "summary" && !(el._tag === "input" && /^(checkbox|radio)$/.test(__jb.inputType(el)))) return;
  if (typeof __jb.commandInvoke === "function" && __jb.commandInvoke(el)) return;
  if (typeof __jb.popoverInvoke === "function" && __jb.popoverInvoke(el)) return;
  switch (el._tag) {
    case "a": case "area": {
      var href = el._ns === __jb.SVG_NS ? __jb.svgAnchorHref(el) : el.getAttribute("href");
      if (href !== null && el.isConnected) { // "cannot navigate" when not connected
        try {
          var url = new URL(href, el.ownerDocument.URL);
          if (url.href.indexOf("javascript:") === 0) { if (el.ownerDocument === __jb.currentDocument && (!__jb.csp || __jb.csp.allowsJavascriptUrl(url.href))) { try { var jsCode = decodeURIComponent(url.href.slice(11)); __jb.csp ? __jb.csp.trusted(function () { (0, eval)(jsCode); }) : (0, eval)(jsCode); } catch (e) { __jb.reportException(e); } } }
          else if (el.ownerDocument === __jb.currentDocument && typeof __jb.followHyperlink === "function" && !el.hasAttribute("download")) __jb.followHyperlink(el, url.href);
          else if (el.ownerDocument === __jb.currentDocument && el.hasAttribute("download") && typeof __jb.downloadHyperlink === "function") __jb.downloadHyperlink(el, url.href);
          else if (el.ownerDocument === __jb.currentDocument) {
            var cur = new URL(__jb.currentDocument.URL);
            if (url.href.split("#")[0] === cur.href.split("#")[0] && url.hash !== "") location.hash = url.hash;
            else __jb.navigations.push({ type: "link", url: url.href, referrerPolicy: (typeof __jb.elementReferrerPolicy === "function" && (__jb.elementReferrerPolicy(el) || __jb.documentReferrerPolicy())) || "" });
          }
        } catch (e2) {}
      }
      break;
    }
    case "input": {
      var t = __jb.inputType(el);
      if ((t === "checkbox" || t === "radio") && el.isConnected) { el.dispatchEvent(new Event("input", { bubbles: true, composed: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }
      else if (t === "submit" || t === "image") { var f = el.isConnected ? __jb.formOwner(el) : null; if (f) __jb.submitForm(f, el); }
      else if (t === "reset") { var f2 = __jb.formOwner(el); if (f2) f2.reset(); }
      break;
    }
    case "button": { var bt = el.type; var form = el.isConnected ? __jb.formOwner(el) : null; if (form) { if (bt === "submit") __jb.submitForm(form, el); else if (bt === "reset") form.reset(); } break; }
    case "label": {
      var ctrl = el.control;
      // inside a shadow tree the dispatch has cleared event.target by now: use the target it had
      // (a Lit quiz's <label for> never checked its radio)
      var etgt = event.target || (event._ev && event._ev.clearedTarget) || el;
      // after dispatch the target may be retargeted to a shadow host outside the label
      if (etgt !== el && !(etgt && etgt.nodeType && el.contains(etgt))) etgt = el;
      if (!ctrl || (etgt && ctrl.contains(etgt) && etgt !== el)) break;
      // Clicks on interactive content inside the label stay with that content.
      for (var it = etgt; it && it !== el; it = it.parentNode) if (it.nodeType === 1 && __jb.isInteractiveContent(it)) { it = null; break; }
      if (it === null) break;
      ctrl.click(); break;
    }
    case "summary": { var details = el.parentNode; if (details && details.nodeType === 1 && details._tag === "details" && details.firstElementChild === el) { details.toggleAttribute("open"); } break; }
  }
};
__jb.submitForm = function (form, submitter) {
  if (!form.isConnected) return;
  // Interactive constraint validation unless novalidate/formnovalidate; not re-entrant.
  var noValidate = form.hasAttribute("novalidate") || (submitter && submitter.hasAttribute && submitter.hasAttribute("formnovalidate"));
  if (!noValidate && typeof form.reportValidity === "function") {
    if (form._interactiveValidating) return;
    form._interactiveValidating = true;
    var valid;
    try { valid = form.reportValidity(); } finally { form._interactiveValidating = false; }
    if (!valid || !form.isConnected) return;
  }
  if (form._firingSubmit) return;
  form._firingSubmit = true;
  var ev = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: submitter || null });
  __jb.setTrusted(ev, true); ev._trustedDispatch = true;
  var go;
  try { go = form.dispatchEvent(ev); } finally { form._firingSubmit = false; }
  if (go) __jb.formSubmitted(form, submitter);
};
class AbortSignal extends EventTarget {
  constructor() { super(); this.aborted = false; this.reason = undefined; this.onabort = null; }
  throwIfAborted() { if (this.aborted) throw this.reason; }
  static abort(reason) { var c = new AbortController(); c.abort(reason); return c.signal; }
  static timeout(ms) { var c = new AbortController(); setTimeout(function () { c.abort(new DOMException("Timeout", "TimeoutError")); }, ms); return c.signal; }
  static any(signals) { var c = new AbortController(); (signals || []).forEach(function (s) { if (s.aborted) c.abort(s.reason); else s.addEventListener("abort", function () { c.abort(s.reason); }); }); return c.signal; }
}
class AbortController { constructor() { this.signal = new AbortSignal(); } abort(reason) { if (this.signal.aborted) return; this.signal.aborted = true; this.signal.reason = reason === undefined ? new DOMException("The operation was aborted.", "AbortError") : reason; this.signal.dispatchEvent(new Event("abort")); } }
__jb.DOM_EXCEPTION_CODES = { IndexSizeError: 1, DOMStringSizeError: 2, HierarchyRequestError: 3, WrongDocumentError: 4, InvalidCharacterError: 5, NoDataAllowedError: 6, NoModificationAllowedError: 7, NotFoundError: 8, NotSupportedError: 9, InUseAttributeError: 10, InvalidStateError: 11, SyntaxError: 12, InvalidModificationError: 13, NamespaceError: 14, InvalidAccessError: 15, ValidationError: 16, TypeMismatchError: 17, SecurityError: 18, NetworkError: 19, AbortError: 20, URLMismatchError: 21, QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24, DataCloneError: 25 };
class DOMException extends Error {
  constructor(message, name) {
    super(message === undefined ? "" : String(message));
    __jb.dp(this, "name", { value: name === undefined ? "Error" : String(name), writable: true, configurable: true, enumerable: false });
    __jb.dp(this, "code", { value: __jb.DOM_EXCEPTION_CODES[this.name] || 0, writable: true, configurable: true, enumerable: false });
  }
  get [Symbol.toStringTag]() { return "DOMException"; }
}
// WebIDL QuotaExceededError: a DOMException subclass carrying `quota` and `requested`.
class QuotaExceededError extends DOMException {
  constructor(message, options) {
    super(message, "QuotaExceededError");
    var opt = function (k) {
      var v = options === undefined || options === null ? undefined : options[k];
      if (v === undefined) return null;
      v = Number(v);
      if (!isFinite(v)) throw new TypeError(k + " must be a finite number");
      if (v < 0) throw new RangeError(k + " must not be negative");
      return v;
    };
    var quota = opt("quota"), requested = opt("requested");
    if (quota !== null && requested !== null && requested < quota) throw new RangeError("requested must not be smaller than quota");
    Object.defineProperty(this, "_quota", { value: quota });
    Object.defineProperty(this, "_requested", { value: requested });
  }
  get quota() { return this._quota === undefined ? null : this._quota; }
  get requested() { return this._requested === undefined ? null : this._requested; }
}
Object.defineProperty(QuotaExceededError.prototype, Symbol.toStringTag, { value: "QuotaExceededError", configurable: true });
Object.keys(__jb.DOM_EXCEPTION_CODES).forEach(function (n) { var c = n.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase().replace(/ERROR$/, "ERR"); Object.defineProperty(DOMException, c, { value: __jb.DOM_EXCEPTION_CODES[n], enumerable: true }); Object.defineProperty(DOMException.prototype, c, { value: __jb.DOM_EXCEPTION_CODES[n], enumerable: true }); });
// The global object is the Window: give it the Window interface so that
// `window instanceof Window`, `'Window' in self` (WebIDL exposure checks) and
// `Object.prototype.toString.call(window)` behave as in browsers.
class Window extends EventTarget { constructor() { throw new TypeError("Illegal constructor"); } }
Object.defineProperty(Window.prototype, Symbol.toStringTag, { value: "Window", configurable: true });
try { Object.setPrototypeOf(globalThis, Window.prototype); } catch (e) {}
Object.assign(globalThis, { Window, Event, CustomEvent, UIEvent, MouseEvent, PointerEvent, WheelEvent, KeyboardEvent, FocusEvent, InputEvent, CompositionEvent, TextEvent, TouchEvent, ErrorEvent, ToggleEvent, CommandEvent, PromiseRejectionEvent, MessageEvent, CloseEvent, ProgressEvent, StorageEvent, HashChangeEvent, PopStateEvent, PageTransitionEvent, TransitionEvent, AnimationEvent, SubmitEvent, BeforeUnloadEvent, DragEvent, ClipboardEvent, DataTransfer, EventTarget, AbortSignal, AbortController, DOMException, QuotaExceededError });

// Navigations started by the activation behavior of a trusted (user) click are user-initiated.
(function () {
  var activate = __jb.activate;
  __jb.activate = function (el, event) {
    var prev = __jb.userNavigation; __jb.userNavigation = !!(event && event.isTrusted);
    try { return activate.apply(this, arguments); } finally { __jb.userNavigation = prev; }
  };
})();
// UIEvent.pseudoTarget: the event's pseudo-element target (none are targeted here).
if (!Object.getOwnPropertyDescriptor(UIEvent.prototype, "pseudoTarget")) Object.defineProperty(UIEvent.prototype, "pseudoTarget", { get: function pseudoTarget() { if (!(this instanceof UIEvent)) throw new TypeError("Illegal invocation"); return null; }, enumerable: true, configurable: true });
// Assign through the prototype chain's setter, skipping accessors defined on the object itself
// (React's value tracker wraps `checked`/`value` per element; activation writing through it hid
// the change from React, so radios never fired onChange).
__jb.protoAssign = function (obj, name, value) {
  for (var p = Object.getPrototypeOf(obj); p; p = Object.getPrototypeOf(p)) {
    var d = Object.getOwnPropertyDescriptor(p, name);
    if (d) { if (d.set) d.set.call(obj, value); else obj[name] = value; return; }
  }
  obj[name] = value;
};
