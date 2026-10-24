// ---- ElementInternals and form-associated custom elements ---------------------------------
// attachInternals() returns an ElementInternals: shadowRoot, the form value and state
// (setFormValue), validity (setValidity, checkValidity, reportValidity), form, labels,
// willValidate, a CustomStateSet (`:state(x)`), and ARIA properties. Form-associated custom
// elements take part in form.elements, submission, reset and the disabled state.
(function () {
  var dom = function (name, msg) { return new DOMException(msg || name, name); };
  var constructing = false;
  function isFACE(el) { return !!(el && el._ceDef && el._ceDef.formAssociated); }
  // Internals live in a WeakMap: pages commonly store theirs in `this._internals`.
  var internalsOf = new WeakMap();
  __jb.internalsOf = function (el) { return internalsOf.get(el) || null; };
  __jb.isFACE = isFACE;
  function target(i) { var t = i && i._target; if (!t) throw new TypeError("Illegal invocation"); return t; }
  function needFACE(i) { var t = target(i); if (!isFACE(t)) throw dom("NotSupportedError", "The target element is not a form-associated custom element"); return t; }

  class CustomStateSet {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); }
    get size() { return this._set.size; }
    add(v) { v = String(v); this._set.add(v); __jb.markDirty && __jb.markDirty(this._el); return this; }
    delete(v) { var r = this._set.delete(String(v)); __jb.markDirty && __jb.markDirty(this._el); return r; }
    has(v) { return this._set.has(String(v)); }
    clear() { this._set.clear(); __jb.markDirty && __jb.markDirty(this._el); }
    forEach(cb, thisArg) { var self = this; this._set.forEach(function (v) { cb.call(thisArg, v, v, self); }); }
    keys() { return this._set.values(); }
    values() { return this._set.values(); }
    entries() { return this._set.entries(); }
    [Symbol.iterator]() { return this._set.values(); }
  }
  var FLAGS = ["valueMissing", "typeMismatch", "patternMismatch", "tooLong", "tooShort", "rangeUnderflow", "rangeOverflow", "stepMismatch", "badInput", "customError"];

  class ElementInternals {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); }
    get shadowRoot() { var t = target(this); var sr = t._shadowRoot; return sr && sr._availableToInternals !== false ? sr : null; }
    setFormValue(value, state) {
      var t = needFACE(this);
      if (arguments.length < 1) throw new TypeError("setFormValue: 1 argument required");
      var conv = function (v) { if (v === null || v === undefined) return null; if (typeof File !== "undefined" && v instanceof File) return v; if (typeof FormData !== "undefined" && v instanceof FormData) { var copy = []; v.forEach(function (val, key) { copy.push([key, val]); }); return { formData: copy }; } return String(v); };
      this._value = conv(value);
      this._state = arguments.length > 1 ? conv(state) : this._value;
    }
    get form() { var t = needFACE(this); return __jb.formOwner(t); }
    setValidity(flags, message, anchor) {
      var t = needFACE(this);
      flags = flags || {};
      var set = {}, any = false;
      FLAGS.forEach(function (f) { set[f] = !!flags[f]; if (set[f]) any = true; });
      if (any && (message === undefined || message === null || String(message) === "")) throw new TypeError("setValidity: a message is required when a flag is set");
      if (anchor !== undefined && anchor !== null) {
        if (!(anchor instanceof HTMLElement)) throw new TypeError("setValidity: anchor is not an HTMLElement");
        var ok = false;
        for (var n = anchor; n; n = n.parentNode || (n.nodeType === 11 && n._host ? n._host : null)) if (n === t) { ok = n !== anchor; break; }
        if (!ok) throw dom("NotFoundError", "The anchor is not a shadow-including descendant of the element");
      }
      this._flags = set;
      this._message = any ? String(message) : "";
      this._anchor = anchor || null;
    }
    get willValidate() { var t = needFACE(this); return willValidate(t); }
    get validity() { needFACE(this); var self = this; if (!this._validity) { var v = Object.create(ValidityState.prototype); FLAGS.concat(["valid"]).forEach(function (f) { Object.defineProperty(v, f, { get: function () { if (f === "valid") return !FLAGS.some(function (k) { return self._flags && self._flags[k]; }); return !!(self._flags && self._flags[f]); }, configurable: true }); }); this._validity = v; } return this._validity; }
    get validationMessage() { var t = needFACE(this); return willValidate(t) && this._message ? this._message : ""; }
    checkValidity() { var t = needFACE(this); if (!willValidate(t) || this.validity.valid) return true; t.dispatchEvent(new Event("invalid", { cancelable: true })); return false; }
    reportValidity() { return this.checkValidity(); }
    get labels() { var t = needFACE(this); var id = t.getAttribute("id"); var root = t.getRootNode(); var out = __jb.descendants(root, function (n) { return n.nodeType === 1 && n._tag === "label" && n._ns === __jb.HTML_NS && (n.hasAttribute("for") ? id !== null && n.getAttribute("for") === id : n.contains(t)); }); return __jb.staticNodeList ? __jb.staticNodeList(out) : out; }
    get states() { return this._states; }
  }
  function willValidate(t) {
    if (__jb.faceDisabled(t)) return false;
    if (t.hasAttribute("readonly")) return false;
    if (t.closest && t.closest("datalist")) return false;
    return true;
  }
  // ARIA mixin on ElementInternals: plain values (not reflected to attributes).
  var ARIA = ["role", "ariaAtomic", "ariaAutoComplete", "ariaBusy", "ariaBrailleLabel", "ariaBrailleRoleDescription", "ariaChecked", "ariaColCount", "ariaColIndex", "ariaColIndexText", "ariaColSpan", "ariaCurrent", "ariaDescription", "ariaDisabled", "ariaExpanded", "ariaHasPopup", "ariaHidden", "ariaInvalid", "ariaKeyShortcuts", "ariaLabel", "ariaLevel", "ariaLive", "ariaModal", "ariaMultiLine", "ariaMultiSelectable", "ariaOrientation", "ariaPlaceholder", "ariaPosInSet", "ariaPressed", "ariaReadOnly", "ariaRelevant", "ariaRequired", "ariaRoleDescription", "ariaRowCount", "ariaRowIndex", "ariaRowIndexText", "ariaRowSpan", "ariaSelected", "ariaSetSize", "ariaSort", "ariaValueMax", "ariaValueMin", "ariaValueNow", "ariaValueText"];
  ARIA.forEach(function (p) {
    Object.defineProperty(ElementInternals.prototype, p, {
      get: function () { target(this); var v = this._aria[p]; return v === undefined ? null : v; },
      set: function (v) { target(this); this._aria[p] = v === null || v === undefined ? null : String(v); },
      enumerable: true, configurable: true,
    });
  });
  ["ariaActiveDescendantElement", "ariaControlsElements", "ariaDescribedByElements", "ariaDetailsElements", "ariaErrorMessageElements", "ariaFlowToElements", "ariaLabelledByElements", "ariaOwnsElements"].forEach(function (p) {
    Object.defineProperty(ElementInternals.prototype, p, {
      get: function () { target(this); var v = this._aria[p]; return v === undefined ? null : v; },
      set: function (v) { target(this); this._aria[p] = v === undefined ? null : v; },
      enumerable: true, configurable: true,
    });
  });
  [CustomStateSet, ElementInternals].forEach(function (C) {
    Object.getOwnPropertyNames(C.prototype).forEach(function (p) { if (p === "constructor" || p.charAt(0) === "_") return; var d = Object.getOwnPropertyDescriptor(C.prototype, p); if (!d.enumerable) { d.enumerable = true; Object.defineProperty(C.prototype, p, d); } });
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
    Object.defineProperty(globalThis, C.name, { value: C, writable: true, configurable: true, enumerable: false });
  });

  HTMLElement.prototype.attachInternals = function attachInternals() {
    if (this._isValueSet || (this.hasAttribute && this.hasAttribute("is") && this._ceDef && this._ceDef.extends)) throw dom("NotSupportedError", "Customized built-in elements cannot attach internals");
    var def = this._ceDef || (this._local && __jb.ceRegistry && __jb.ceRegistry[this._local]) || null;
    if (!def || def.extends) throw dom("NotSupportedError", "Not an autonomous custom element");
    if (def.disableInternals) throw dom("NotSupportedError", "Internals are disabled for this custom element");
    if (internalsOf.has(this)) throw dom("NotSupportedError", "attachInternals() was already called");
    if (!this._ceDef && !this._ceDefPending) throw dom("NotSupportedError", "The element is not custom");
    constructing = true;
    var i, s;
    try { i = new ElementInternals(); s = new CustomStateSet(); } finally { constructing = false; }
    Object.defineProperty(s, "_set", { value: new Set() }); Object.defineProperty(s, "_el", { value: this });
    Object.defineProperties(i, { _target: { value: this }, _states: { value: s }, _aria: { value: {} } });
    i._value = null; i._state = null; i._flags = null; i._message = ""; i._anchor = null;
    internalsOf.set(this, i);
    return i;
  };
  __jb.customStates = function (el) { var i = el && internalsOf.get(el); return i ? i._states._set : null; };

  // Disabled state of a form-associated custom element (disabled attribute or a disabled fieldset).
  __jb.faceDisabled = function (el) {
    if (el.hasAttribute("disabled")) return true;
    for (var fs = el.parentNode; fs && fs.nodeType === 1; fs = fs.parentNode) {
      if (fs._tag === "fieldset" && fs._ns === __jb.HTML_NS && fs.hasAttribute("disabled")) {
        var legend = null; for (var c = fs.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c._tag === "legend") { legend = c; break; }
        if (!legend || !legend.contains(el)) return true;
      }
    }
    return false;
  };
  // Entries a form-associated custom element contributes to its form's entry list.
  __jb.faceEntries = function (el) {
    var internals = internalsOf.get(el);
    if (!internals || __jb.faceDisabled(el)) return [];
    var v = internals._value;
    if (v === null || v === undefined) return [];
    if (typeof v === "object" && v.formData) return v.formData.slice();
    var name = el.getAttribute("name");
    if (name === null || name === "") return [];
    return [[name, v]];
  };
})();

// The owner form's validity (form.checkValidity / reportValidity / :invalid) includes custom controls.
__jb.faceInvalid = function (el) { var i = __jb.internalsOf(el); if (!i || !__jb.isFACE(el)) return false; var t = el; if (__jb.faceDisabled(t) || t.hasAttribute("readonly")) return false; return !!i._flags && Object.keys(i._flags).some(function (k) { return i._flags[k]; }); };
__jb.faceInvalidIn = function (container) {
  var list = __jb.descendants(container.getRootNode(), function (n) { return n.nodeType === 1 && __jb.isFACE(n) && (container._tag === "fieldset" ? container.contains(n) : __jb.formOwner(n) === container); });
  return list.filter(__jb.faceInvalid);
};

// ---- form-associated custom element callbacks ----
(function () {
  function call(el, name, args) {
    var def = el._ceDef, cb = def && def.callbacks && def.callbacks[name];
    if (typeof cb !== "function") return;
    try { cb.apply(el, args); } catch (e) { __jb.reportException(e); }
  }
  // "Reset the form owner": the form attribute's form, else the nearest ancestor form.
  function resetOwner(el) {
    if (!__jb.isFACE(el)) return;
    var form = __jb.formOwner(el);
    var prev = el._faceForm || null;
    if (form !== prev) { el._faceForm = form; call(el, "formAssociatedCallback", [form]); }
  }
  function resetDisabled(el) {
    if (!__jb.isFACE(el)) return;
    var d = __jb.faceDisabled(el);
    if (!!el._faceDisabledState !== d) { el._faceDisabledState = d; call(el, "formDisabledCallback", [d]); }
  }
  __jb.faceUpgraded = function (el) { el._faceForm = null; el._faceDisabledState = false; resetOwner(el); resetDisabled(el); };
  var connected = __jb.connected, disconnected = __jb.disconnected;
  __jb.connected = function (node) {
    connected.apply(this, arguments);
    if (node.nodeType === 1 && __jb.isFACE(node)) { resetOwner(node); resetDisabled(node); }
    // a form inserted into the tree can become the owner of controls naming it
    if (node.nodeType === 1 && node._tag === "form" && node._ns === __jb.HTML_NS && node.hasAttribute("id")) relink(node.getRootNode());
  };
  __jb.disconnected = function (node) {
    disconnected.apply(this, arguments);
    if (node.nodeType === 1 && __jb.isFACE(node)) { resetOwner(node); }
    if (node.nodeType === 1 && node._tag === "form" && node._ns === __jb.HTML_NS) relinkOwnedBy(node);
  };
  function relink(root) { __jb.descendants(root, function (n) { return n.nodeType === 1 && __jb.isFACE(n); }).forEach(resetOwner); }
  function relinkOwnedBy(form) { __jb.descendants(form, function (n) { return n.nodeType === 1 && __jb.isFACE(n); }).forEach(resetOwner); (form.ownerDocument ? __jb.descendants(form.ownerDocument, function (n) { return n.nodeType === 1 && __jb.isFACE(n) && n._faceForm === form; }) : []).forEach(resetOwner); }
  __jb.faceAttributeChanged = function (el, name) {
    if (name === "form" && __jb.isFACE(el)) resetOwner(el);
    else if (name === "disabled") {
      if (__jb.isFACE(el)) resetDisabled(el);
      if (el._tag === "fieldset" && el._ns === __jb.HTML_NS) __jb.descendants(el, function (n) { return n.nodeType === 1 && __jb.isFACE(n); }).forEach(resetDisabled);
    } else if (name === "id" && el._tag === "form" && el._ns === __jb.HTML_NS && el.isConnected) relink(el.getRootNode());
  };
  // form.reset(): formResetCallback for the form's custom controls, at the end of the reset.
  var reset = HTMLElement.prototype.reset;
  HTMLElement.prototype.reset = function () {
    var r = reset.apply(this, arguments);
    if (this._tag === "form" && this._ns === __jb.HTML_NS) {
      var self = this;
      __jb.descendants(this.getRootNode(), function (n) { return n.nodeType === 1 && __jb.isFACE(n) && __jb.formOwner(n) === self; }).forEach(function (el) { call(el, "formResetCallback", []); });
    }
    return r;
  };
})();

// "Focus fixup rule": during update the rendering, a focused element that is no longer focusable
// (disabled, hidden, not rendered, inert) stops being focused; the body becomes the active element.
__jb.scheduleFocusFixup = function (doc) {
  if (doc._focusFixupScheduled) return;
  doc._focusFixupScheduled = true;
  setTimeout(function () {
    doc._focusFixupScheduled = false;
    var a = doc._jbActive;
    if (!a || !a.isConnected) return;
    var focusable = typeof __jb.isFocusable === "function" ? __jb.isFocusable(a) : true;
    var rendered = typeof __jb.isRendered === "function" ? __jb.isRendered(a) : true;
    if (!focusable || !rendered) { if (typeof __jb.blurElement === "function") __jb.blurElement(a); else doc._jbActive = null; }
  }, (__jb.untilNextFrame ? __jb.untilNextFrame() : 16) + 0.75);
};
