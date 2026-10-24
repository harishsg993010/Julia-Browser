// Part 3c: form controls, popovers and dialogs (HTML "Forms", "The popover
// attribute", "The dialog element"). Replaces the stubs of 30_dom.js: input
// value modes and sanitization per type, the text-control selection API,
// constraint validation, the popover state machine with its invoker
// attributes and light dismiss, and dialog close requests.

// ---------------------------------------------------------------- input types and values
__jb.TEXTUAL_INPUT = /^(text|search|url|tel|email|password)$/;
__jb.SELECTABLE_INPUT = /^(text|search|url|tel|password)$/;
__jb.DATE_INPUT = /^(date|month|week|time|datetime-local)$/;
// value mode per type: "value" (dirty value), "default", "default/on", "filename"
__jb.inputValueMode = function (type) {
  if (type === "checkbox" || type === "radio") return "default/on";
  if (type === "file") return "filename";
  if (/^(hidden|submit|image|reset|button)$/.test(type)) return "default";
  return "value";
};
__jb.isValidFloat = function (s) { return /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s); };
__jb.pad = function (n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; };
__jb.daysInMonth = function (y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
__jb.parseDateString = function (s) { var m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(s); if (!m) return null; var y = +m[1], mo = +m[2], d = +m[3]; if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > __jb.daysInMonth(y, mo)) return null; return { y: y, m: mo, d: d }; };
__jb.parseTimeString = function (s) { var m = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(s); if (!m) return null; var h = +m[1], mi = +m[2], se = m[3] === undefined ? 0 : +m[3], ms = m[4] === undefined ? 0 : +(m[4] + "00").slice(0, 3); if (h > 23 || mi > 59 || se > 59) return null; return { h: h, mi: mi, s: se, ms: ms, hasSeconds: m[3] !== undefined, fraction: m[4] }; };
__jb.weeksInYear = function (y) { var jan1 = new Date(Date.UTC(y, 0, 1)).getUTCDay(); var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; return jan1 === 4 || (leap && jan1 === 3) ? 53 : 52; };
// "value sanitization algorithm" per type; returns the sanitized value.
__jb.sanitizeInputValue = function (el, type, v) {
  v = String(v);
  switch (type) {
    case "text": case "search": case "tel": case "password": return v.replace(/[\r\n]/g, "");
    case "url": return v.replace(/[\r\n]/g, "").replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
    case "email": {
      if (el.hasAttribute("multiple")) return v.replace(/[\r\n]/g, "").split(",").map(function (p) { return p.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ""); }).join(",");
      return v.replace(/[\r\n]/g, "").replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
    }
    case "number": return __jb.isValidFloat(v) ? v : "";
    case "range": {
      var min = __jb.isValidFloat(el.getAttribute("min") || "") ? parseFloat(el.getAttribute("min")) : 0;
      var max = __jb.isValidFloat(el.getAttribute("max") || "") ? parseFloat(el.getAttribute("max")) : 100;
      if (max < min) max = min;
      var n = __jb.isValidFloat(v) ? parseFloat(v) : min + (max - min) / 2;
      if (n < min) n = min; if (n > max) n = max;
      var step = el.getAttribute("step"); var stepN = step !== null && __jb.isValidFloat(step) && parseFloat(step) > 0 ? parseFloat(step) : (String(step).toLowerCase() === "any" ? null : 1);
      if (stepN) { var base = min; var k = Math.round((n - base) / stepN); var cand = base + k * stepN; if (cand > max) cand = base + Math.floor((max - base) / stepN) * stepN; if (cand >= min) n = cand; }
      return String(n);
    }
    case "color": {
      // Any CSS color, serialized as a lowercase sRGB hex (alpha ignored).
      if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
      var cc = typeof __jb.parseCssColor === "function" ? __jb.parseCssColor(v.trim()) : null;
      if (!cc || cc === "currentcolor") return "#000000";
      var hx = function (n) { var t = Math.round(n).toString(16); return t.length < 2 ? "0" + t : t; };
      return "#" + hx(cc[0]) + hx(cc[1]) + hx(cc[2]);
    }
    case "date": return __jb.parseDateString(v) ? v : "";
    case "month": { var mm = /^(\d{4,})-(\d{2})$/.exec(v); return mm && +mm[1] >= 1 && +mm[2] >= 1 && +mm[2] <= 12 ? v : ""; }
    case "week": { var wm = /^(\d{4,})-W(\d{2})$/.exec(v); return wm && +wm[1] >= 1 && +wm[2] >= 1 && +wm[2] <= __jb.weeksInYear(+wm[1]) ? v : ""; }
    case "time": return __jb.parseTimeString(v) ? v : ""; // valid time strings are kept as written
    case "datetime-local": {
      var dm = /^(\d{4,}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/.exec(v); if (!dm || !__jb.parseDateString(dm[1])) return "";
      var tt = __jb.parseTimeString(dm[2]); if (!tt) return "";
      var o = dm[1] + "T" + __jb.pad(tt.h, 2) + ":" + __jb.pad(tt.mi, 2); if (tt.s || tt.ms) o += ":" + __jb.pad(tt.s, 2); if (tt.ms) o += "." + String(tt.ms / 1000).slice(2).replace(/0+$/, ""); return o;
    }
    default: return v;
  }
};
(function () {
  var base = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "value");
  Object.defineProperty(HTMLElement.prototype, "value", {
    get: function () {
      if (this._tag !== "input") return base.get.call(this);
      var type = __jb.inputType(this), mode = __jb.inputValueMode(type);
      if (mode === "filename") { var f = this._files && this._files[0]; return f ? "C:\\fakepath\\" + f.name : ""; }
      if (mode === "default") return this.getAttribute("value") === null ? "" : this.getAttribute("value");
      if (mode === "default/on") return this.getAttribute("value") === null ? "on" : this.getAttribute("value");
      if (this._valueOverride !== undefined) return this._valueOverride;
      return __jb.sanitizeInputValue(this, type, this.getAttribute("value") === null ? "" : this.getAttribute("value"));
    },
    set: function (v) {
      if (this._tag === "textarea") { var oldT = this.value; base.set.call(this, v); var newT = this.value; this._valueDirty = true; if (newT !== oldT) { this._selStart = this._selEnd = newT.length; this._selDir = "none"; } return; }
      if (this._tag !== "input") { base.set.call(this, v); return; }
      var type = __jb.inputType(this), mode = __jb.inputValueMode(type);
      if (mode === "filename") { if (v === "" || v === null) { this._files = new FileList(); return; } throw __jb.domError("InvalidStateError", "Only the empty string may be assigned to a file input's value"); }
      if (mode === "default" || mode === "default/on") { this.setAttribute("value", v === null ? "" : String(v)); return; }
      var old = this.value;
      var next = __jb.sanitizeInputValue(this, type, v === null ? "" : String(v));
      this._valueOverride = next;
      this._valueDirty = true;
      if (next !== old) { this._selStart = this._selEnd = next.length; this._selDir = "none"; }
      __jb.markDirty(this);
    },
    configurable: true,
  });
  // Changing the type moves the value between its modes and re-sanitizes it.
  // The reflected `type` lives on HTMLInputElement.prototype (35_reflect) and
  // on HTMLElement.prototype; both get the state-transition setter.
  [HTMLElement.prototype].concat(typeof HTMLInputElement === "function" ? [HTMLInputElement.prototype] : []).forEach(function (proto) {
  var typeDesc = Object.getOwnPropertyDescriptor(proto, "type");
  if (!typeDesc) return;
  Object.defineProperty(proto, "type", {
    get: typeDesc.get,
    set: function (v) {
      if (this._tag !== "input") { typeDesc.set.call(this, v); return; }
      var oldType = __jb.inputType(this), oldMode = __jb.inputValueMode(oldType), oldValue = this.value;
      this.setAttribute("type", String(v));
      var newType = __jb.inputType(this), newMode = __jb.inputValueMode(newType);
      if (oldMode === "value" && newMode !== "value" && newMode !== "filename" && this._valueOverride !== undefined && oldValue !== "") { this.setAttribute("value", this._valueOverride); }
      if (oldMode !== "value" && newMode === "value") { this._valueOverride = undefined; }
      if (newMode === "value") {
        if (this._valueOverride !== undefined) this._valueOverride = __jb.sanitizeInputValue(this, newType, this._valueOverride);
        if (__jb.SELECTABLE_INPUT.test(newType) && !__jb.SELECTABLE_INPUT.test(oldType)) { this._selStart = this._selEnd = 0; this._selDir = "none"; }
      }
      if (oldValue !== this.value) __jb.markDirty && __jb.markDirty(this);
    },
    configurable: true,
  });
  });
})();
Object.defineProperty(HTMLElement.prototype, "valueAsNumber", {
  get: function () {
    if (this._tag !== "input") return NaN;
    var t = __jb.inputType(this), v = this.value;
    if (t === "number" || t === "range") return v === "" ? NaN : parseFloat(v);
    if (t === "month") { var mm = /^(\d{4,})-(\d{2})$/.exec(v); return mm ? (+mm[1] - 1970) * 12 + (+mm[2] - 1) : NaN; } // months since 1970-01
    if (t === "datetime-local") { var dl = /^(.*)T(.*)$/.exec(v); if (!dl) return NaN; var dd = __jb.parseDateString(dl[1]), dt = __jb.parseTimeString(dl[2]); return dd && dt ? Date.UTC(dd.y, dd.m - 1, dd.d) + ((dt.h * 60 + dt.mi) * 60 + dt.s) * 1000 + dt.ms : NaN; }
    var d = this.valueAsDate; return d ? d.getTime() : NaN;
  },
  set: function (v) {
    var t = __jb.inputType(this);
    v = Number(v);
    if (!isFinite(v) && !isNaN(v)) throw new TypeError("valueAsNumber cannot be set to Infinity");
    if (!/^(number|range|date|month|week|time|datetime-local)$/.test(t)) throw __jb.domError("InvalidStateError", "valueAsNumber does not apply to this input type");
    if (isNaN(v)) { this.value = ""; return; }
    if (t === "number" || t === "range") { this.value = String(v); return; }
    // time: milliseconds after midnight, for any finite number (wraps around the day)
    if (t === "time") { this.valueAsDate = new Date(((Math.floor(v) % 864e5) + 864e5) % 864e5); return; }
    if (t === "month") { var months = Math.floor(v), y = 1970 + Math.floor(months / 12), mo = months - (y - 1970) * 12; this.value = y + "-" + __jb.pad(mo + 1, 2); return; }
    if (t === "datetime-local") { var d2 = new Date(v); var ms2 = d2.getUTCSeconds() * 1000 + d2.getUTCMilliseconds(); this.value = d2.getUTCFullYear() + "-" + __jb.pad(d2.getUTCMonth() + 1, 2) + "-" + __jb.pad(d2.getUTCDate(), 2) + "T" + __jb.pad(d2.getUTCHours(), 2) + ":" + __jb.pad(d2.getUTCMinutes(), 2) + (ms2 ? ":" + __jb.pad(d2.getUTCSeconds(), 2) + (d2.getUTCMilliseconds() ? "." + __jb.pad(d2.getUTCMilliseconds(), 3) : "") : ""); return; }
    this.valueAsDate = new Date(v);
  },
  configurable: true,
});
Object.defineProperty(HTMLElement.prototype, "valueAsDate", {
  get: function () {
    if (this._tag !== "input") return null;
    var t = __jb.inputType(this), v = this.value;
    if (t === "date") { var d = __jb.parseDateString(v); return d ? new Date(Date.UTC(d.y, d.m - 1, d.d)) : null; }
    if (t === "month") { var m = /^(\d{4,})-(\d{2})$/.exec(v); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, 1)) : null; }
    if (t === "week") { var w = /^(\d{4,})-W(\d{2})$/.exec(v); if (!w) return null; var jan4 = new Date(Date.UTC(+w[1], 0, 4)); var dow = jan4.getUTCDay() || 7; var monday = jan4.getTime() - (dow - 1) * 864e5; return new Date(monday + (+w[2] - 1) * 7 * 864e5); }
    if (t === "time") { var tm = __jb.parseTimeString(v); return tm ? new Date(((tm.h * 60 + tm.mi) * 60 + tm.s) * 1000 + tm.ms) : null; }
    return null;
  },
  set: function (v) {
    var t = __jb.inputType(this);
    if (!/^(date|month|week|time)$/.test(t)) throw __jb.domError("InvalidStateError", "valueAsDate does not apply to this input type");
    if (v !== null && !(v instanceof Date)) throw new TypeError("valueAsDate must be a Date or null");
    if (v === null || isNaN(v.getTime())) { this.value = ""; return; }
    if (t === "date") this.value = v.getUTCFullYear() + "-" + __jb.pad(v.getUTCMonth() + 1, 2) + "-" + __jb.pad(v.getUTCDate(), 2);
    else if (t === "month") this.value = v.getUTCFullYear() + "-" + __jb.pad(v.getUTCMonth() + 1, 2);
    else if (t === "time") { var ms = v.getTime() % 864e5; if (ms < 0) ms += 864e5; var h = Math.floor(ms / 36e5), mi = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1000) % 60, f = ms % 1000; this.value = __jb.pad(h, 2) + ":" + __jb.pad(mi, 2) + (s || f ? ":" + __jb.pad(s, 2) : "") + (f ? "." + __jb.pad(f, 3) : ""); }
    else if (t === "week") { var d = new Date(v.getTime()); var day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - day); var y = d.getUTCFullYear(); var wk = Math.ceil(((d - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7); this.value = y + "-W" + __jb.pad(wk, 2); }
  },
  configurable: true,
});

Object.defineProperty(HTMLElement.prototype, "files", {
  get: function () { if (this._tag !== "input" || __jb.inputType(this) !== "file") return null; if (!this._files) this._files = new FileList(); return this._files; },
  set: function (v) { if (v !== null && !(v instanceof FileList)) throw new TypeError("files must be a FileList or null"); if (this._tag === "input" && __jb.inputType(this) === "file" && v !== null) this._files = v; },
  configurable: true,
});

// ---------------------------------------------------------------- text control selection
__jb.selectionApplies = function (el) { return el._tag === "textarea" || (el._tag === "input" && __jb.SELECTABLE_INPUT.test(__jb.inputType(el))); };
__jb.clampSel = function (el, n) { var len = el.value.length; n = Number(n); if (!isFinite(n)) n = 0; n = n >= 0 && n <= 4294967295 ? Math.floor(n) : (n >>> 0); return Math.min(n, len); }; // WebIDL unsigned long: -1 wraps to 2^32-1, then clamps to the length
__jb.queueSelectEvent = function (el) { if (el._selectQueued) return; el._selectQueued = true; setTimeout(function () { el._selectQueued = false; var ev = new Event("select", { bubbles: true }); __jb.setTrusted(ev, true); ev._trustedDispatch = true; el.dispatchEvent(ev); }, 0); };
__jb.setSelection = function (el, start, end, dir) {
  var len = el.value.length;
  if (end === undefined || end === null) end = len; if (start === undefined || start === null) start = 0;
  end = __jb.clampSel(el, end); start = Math.min(__jb.clampSel(el, start), end);
  var d = dir === "backward" ? "backward" : dir === "forward" ? "forward" : "none";
  var changed = el._selStart !== start || el._selEnd !== end || (el._selDir || "none") !== d;
  el._selStart = start; el._selEnd = end; el._selDir = d;
  if (changed) __jb.queueSelectEvent(el);
};
["selectionStart", "selectionEnd", "selectionDirection"].forEach(function (prop) {
  Object.defineProperty(HTMLElement.prototype, prop, {
    get: function () {
      if (!__jb.selectionApplies(this)) return null;
      var len = this.value.length;
      if (prop === "selectionDirection") return this._selDir || "none";
      var v = prop === "selectionStart" ? this._selStart : this._selEnd;
      return v === undefined ? 0 : Math.min(v, len);
    },
    set: function (v) {
      if (!__jb.selectionApplies(this)) throw __jb.domError("InvalidStateError", prop + " does not apply to this element");
      var s = this.selectionStart, e = this.selectionEnd, d = this.selectionDirection;
      if (prop === "selectionStart") { s = v === null ? 0 : v; if (e < __jb.clampSel(this, s)) e = __jb.clampSel(this, s); }
      else if (prop === "selectionEnd") e = v === null ? 0 : v;
      else d = v;
      __jb.setSelection(this, s, e, d);
    },
    configurable: true,
  });
});
HTMLElement.prototype.select = function () { if (!__jb.selectionApplies(this) && !(this._tag === "input" && /^(email|number|color|date|month|week|time|datetime-local)$/.test(__jb.inputType(this)))) return; if (__jb.selectionApplies(this)) __jb.setSelection(this, 0, this.value.length, "none"); else __jb.queueSelectEvent(this); };
HTMLElement.prototype.setSelectionRange = function (start, end, direction) {
  if (arguments.length < 2) throw new TypeError("setSelectionRange: 2 arguments required");
  if (!__jb.selectionApplies(this)) throw __jb.domError("InvalidStateError", "setSelectionRange does not apply to this element");
  __jb.setSelection(this, start === null ? 0 : start, end === null ? 0 : end, direction);
};
HTMLElement.prototype.setRangeText = function (replacement, start, end, mode) {
  if (arguments.length < 1) throw new TypeError("setRangeText: 1 argument required");
  if (!__jb.selectionApplies(this)) throw __jb.domError("InvalidStateError", "setRangeText does not apply to this element");
  replacement = String(replacement);
  var value = this.value, selStart = this.selectionStart, selEnd = this.selectionEnd;
  if (arguments.length < 2) { start = selStart; end = selEnd; }
  else { start = __jb.clampSel(this, start); end = __jb.clampSel(this, end); if (start > end) throw __jb.domError("IndexSizeError", "start is after end"); }
  this._valueOverride = value.slice(0, start) + replacement + value.slice(end);
  this._valueDirty = true;
  var newLen = replacement.length, newEnd = start + newLen;
  mode = String(mode === undefined ? "preserve" : mode);
  if (mode === "select") { selStart = start; selEnd = newEnd; }
  else if (mode === "start") { selStart = selEnd = start; }
  else if (mode === "end") { selStart = selEnd = newEnd; }
  else {
    var delta = newLen - (end - start);
    if (selStart > end) selStart += delta; else if (selStart > start) selStart = start;
    if (selEnd > end) selEnd += delta; else if (selEnd > start) selEnd = newEnd;
  }
  __jb.setSelection(this, selStart, selEnd, this.selectionDirection);
};

// ---------------------------------------------------------------- constraint validation
class ValidityState {
  constructor(el) { Object.defineProperty(this, "_el", { value: el }); }
  get _mutable() { var el = this._el; return el.willValidate !== false || !/^(input|select|textarea|button)$/.test(el._tag); }
  get valueMissing() { var el = this._el; if (!el.hasAttribute("required")) return false; if (!this._mutable && (el._tag === "textarea" || (el._tag === "input" && __jb.inputValueMode(__jb.inputType(el)) === "value"))) return false; if (el._tag === "select") return __jb.selectValueMissing(el); if (el._tag === "textarea") return el.value === ""; var t = __jb.inputType(el); if (t === "checkbox") return !el.checked; if (t === "radio") { var group = __jb.radioGroup(el); return !group.some(function (r) { return r.checked; }); } if (t === "file") return !(el.files && el.files.length); if (/^(hidden|submit|image|reset|button|range|color)$/.test(t)) return false; return el.value === ""; }
  get typeMismatch() { var el = this._el; if (el._tag !== "input") return false; var t = __jb.inputType(el), v = el.value; if (v === "") return false; if (t === "email") { var re = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/; return el.hasAttribute("multiple") ? !v.split(",").every(function (p) { return re.test(p); }) : !re.test(v); } if (t === "url") { try { new URL(v); return false; } catch (e) { return true; } } return false; }
  get patternMismatch() { var el = this._el; if (el._tag !== "input" || el.value === "") return false; var p = el.getAttribute("pattern"); if (p === null || !/^(text|search|url|tel|email|password)$/.test(__jb.inputType(el))) return false; var re; try { new RegExp(p, "v"); re = new RegExp("^(?:" + p + ")$", "v"); } catch (e) { return false; } /* a pattern that is not a valid v-mode regexp is ignored */ var values = el.hasAttribute("multiple") && __jb.inputType(el) === "email" ? el.value.split(",") : [el.value]; return !values.every(function (x) { return re.test(x); }); }
  get tooLong() { var el = this._el; if (!el._valueDirty || !el._userEdited) return false; var m = el.getAttribute("maxlength"); if (m === null || !/^\d+$/.test(m)) return false; return __jb.arrayFrom(el.value).length > +m; }
  get tooShort() { var el = this._el; if (!el._valueDirty || !el._userEdited || el.value === "") return false; var m = el.getAttribute("minlength"); if (m === null || !/^\d+$/.test(m)) return false; return __jb.arrayFrom(el.value).length < +m; }
  get rangeUnderflow() { var r = __jb.numericState(this._el); return !!(r && r.min !== null && r.n < r.min); }
  get rangeOverflow() { var r = __jb.numericState(this._el); return !!(r && r.max !== null && r.n > r.max); }
  get stepMismatch() { var r = __jb.numericState(this._el); if (!r || r.step === null) return false; var q = (r.n - r.stepBase) / r.step; return Math.abs(q - Math.round(q)) > 1e-9; }
  get badInput() { return false; }
  get customError() { return !!this._el._customValidity; }
  get valid() { var self_ = this; return !["valueMissing", "typeMismatch", "patternMismatch", "tooLong", "tooShort", "rangeUnderflow", "rangeOverflow", "stepMismatch", "badInput", "customError"].some(function (k) { return self_[k]; }); }
}
__jb.radioGroup = function (el) { if (!el.name) return [el]; var root = __jb.formOwner(el) || el.getRootNode(); var group = __jb.descendants(root, function (n) { return n.nodeType === 1 && n._tag === "input" && __jb.inputType(n) === "radio" && n.name === el.name && __jb.formOwner(n) === __jb.formOwner(el); }); if (group.indexOf(el) < 0) group.push(el); return group; };
__jb.numericState = function (el) {
  if (el._tag !== "input") return null;
  var t = __jb.inputType(el), v = el.value;
  if (v === "") return null;
  var num = function (s) { return s === null || !__jb.isValidFloat(s) ? null : parseFloat(s); };
  var toN = null, defaultStep = 1, base = 0;
  if (t === "number" || t === "range") toN = function (s) { return __jb.isValidFloat(s) ? parseFloat(s) : null; };
  else if (t === "date") { toN = function (s) { var d = __jb.parseDateString(s); return d ? Date.UTC(d.y, d.m - 1, d.d) : null; }; defaultStep = 864e5; }
  else if (t === "time") { toN = function (s) { var tm = __jb.parseTimeString(s); return tm ? ((tm.h * 60 + tm.mi) * 60 + tm.s) * 1000 + tm.ms : null; }; defaultStep = 60000; }
  else if (t === "datetime-local") { toN = function (s) { var m = /^(.*)T(.*)$/.exec(s); if (!m) return null; var d = __jb.parseDateString(m[1]), tm = __jb.parseTimeString(m[2]); return d && tm ? Date.UTC(d.y, d.m - 1, d.d) + ((tm.h * 60 + tm.mi) * 60 + tm.s) * 1000 + tm.ms : null; }; defaultStep = 60000; }
  else if (t === "month") { toN = function (s) { var m = /^(\d{4,})-(\d{2})$/.exec(s); return m ? (+m[1] - 1970) * 12 + (+m[2] - 1) : null; }; }
  else if (t === "week") { toN = function (s) { var w = /^(\d{4,})-W(\d{2})$/.exec(s); if (!w) return null; var jan4 = Date.UTC(+w[1], 0, 4); var dow = new Date(jan4).getUTCDay() || 7; return jan4 - (dow - 1) * 864e5 + (+w[2] - 1) * 7 * 864e5; }; defaultStep = 7 * 864e5; }
  else return null;
  var n = toN(v); if (n === null) return null;
  var min = toN(el.getAttribute("min") || ""), max = toN(el.getAttribute("max") || "");
  if (t === "range") { if (min === null) min = 0; if (max === null) max = 100; }
  var stepAttr = el.getAttribute("step"), step;
  if (stepAttr !== null && stepAttr.toLowerCase() === "any") step = null;
  else {
    // step is in the type's unit (seconds for time/datetime-local, days for date, weeks for week)
    var scale = { date: 864e5, week: 6048e5, time: 1000, "datetime-local": 1000 }[t] || 1;
    var sn = num(stepAttr); step = sn !== null && sn > 0 ? sn * scale : defaultStep;
  }
  var dflBase = t === "week" ? -259200000 : 0; // week: the start of 1970-W01
  if (t === "number" || t === "range") base = min !== null ? min : (num(el.getAttribute("value")) !== null ? num(el.getAttribute("value")) : 0); else base = min !== null ? min : (toN(el.getAttribute("value") || "") !== null ? toN(el.getAttribute("value")) : dflBase);
  return { n: n, min: min, max: max, step: step, stepBase: base };
};
Object.defineProperty(HTMLElement.prototype, "validity", { get: function () { if (!this._validity) Object.defineProperty(this, "_validity", { value: new ValidityState(this) }); return this._validity; }, configurable: true });
Object.defineProperty(HTMLElement.prototype, "willValidate", {
  get: function () {
    if (!/^(input|select|textarea|button|output|object|fieldset)$/.test(this._tag)) return undefined;
    if (this._tag === "output" || this._tag === "object" || this._tag === "fieldset") return false;
    if (this._tag === "input" && /^(hidden|reset|button)$/.test(__jb.inputType(this))) return false;
    if (this._tag === "button" && this.type !== "submit") return false;
    if (__jb.isDisabled(this) || this.hasAttribute("readonly")) return false;
    for (var a = this.parentNode; a; a = a.parentNode) if (a.nodeType === 1 && a._tag === "datalist") return false;
    return true;
  },
  configurable: true,
});
Object.defineProperty(HTMLElement.prototype, "validationMessage", {
  get: function () {
    if (!this.willValidate || this.validity.valid) return "";
    if (this._customValidity) return this._customValidity;
    var v = this.validity;
    if (v.valueMissing) return "Please fill out this field.";
    if (v.typeMismatch) return "Please enter a valid value.";
    if (v.patternMismatch) return "Please match the requested format.";
    if (v.tooLong) return "Please shorten this text.";
    if (v.tooShort) return "Please lengthen this text.";
    if (v.rangeUnderflow) return "Value must be greater than or equal to the minimum.";
    if (v.rangeOverflow) return "Value must be less than or equal to the maximum.";
    if (v.stepMismatch) return "Please enter a valid value.";
    return "Invalid value.";
  },
  configurable: true,
});
HTMLElement.prototype.setCustomValidity = function (msg) { if (arguments.length < 1) throw new TypeError("setCustomValidity: 1 argument required"); this._customValidity = String(msg); };
HTMLElement.prototype.checkValidity = function () {
  if ((this._tag === "form" || this._tag === "fieldset") && __jb.faceInvalidIn && __jb.faceInvalidIn(this)) { var okF = true; var selfF = this; __jb.descendants(this, function (n) { return n.nodeType === 1 && /^(input|select|textarea|button)$/.test(n._tag); }).forEach(function (c) { if (c.willValidate && !c.validity.valid) { okF = false; c.dispatchEvent(new Event("invalid", { cancelable: true })); } }); __jb.faceInvalidIn(selfF).forEach(function (f) { okF = false; f.dispatchEvent(new Event("invalid", { cancelable: true })); }); return okF; }
  if (this._tag === "form" || this._tag === "fieldset") { var ok = true; var self_ = this; __jb.descendants(this, function (n) { return n.nodeType === 1 && /^(input|select|textarea|button)$/.test(n._tag); }).forEach(function (c) { if (c.willValidate && !c.validity.valid) { ok = false; c.dispatchEvent(new Event("invalid", { cancelable: true })); } }); return ok; }
  if (!this.willValidate) return true;
  if (this.validity.valid) return true;
  this.dispatchEvent(new Event("invalid", { cancelable: true }));
  return false;
};
HTMLElement.prototype.reportValidity = function () {
  if (this._tag === "form") { var first = null, ok = true; __jb.descendants(this, function (n) { return n.nodeType === 1 && /^(input|select|textarea|button)$/.test(n._tag); }).forEach(function (c) { if (c.willValidate && !c.validity.valid) { ok = false; if (!c.dispatchEvent(new Event("invalid", { cancelable: true })) === false && !first) first = c; else if (!first) first = c; } }); if (first && first.focus) first.focus(); return ok; }
  if (!this.willValidate || this.validity.valid) return true;
  var notCanceled = this.dispatchEvent(new Event("invalid", { cancelable: true }));
  if (notCanceled && this.focus) this.focus();
  return false;
};

// ---------------------------------------------------------------- popover
__jb.POPOVER_INVOKERS = /^(button|input)$/;
__jb.topLayer = __jb.topLayer || [];
// Missing value default: auto; invalid value default: manual.
__jb.popoverValue = function (el) { var p = el.getAttribute("popover"); if (p === null) return null; p = p.toLowerCase(); return p === "" || p === "auto" ? "auto" : p === "hint" ? "hint" : "manual"; };
Object.defineProperty(HTMLElement.prototype, "popover", {
  get: function () { return __jb.popoverValue(this); },
  set: function (v) { if (v === null || v === undefined) this.removeAttribute("popover"); else this.setAttribute("popover", String(v)); },
  configurable: true,
});
Object.defineProperty(HTMLElement.prototype, "popoverTargetElement", {
  get: function () {
    if (!__jb.POPOVER_INVOKERS.test(this._tag)) return undefined;
    if (this._popoverTargetExplicit !== undefined) return this._popoverTargetExplicit && this._popoverTargetExplicit.isConnected && this.getRootNode() === this._popoverTargetExplicit.getRootNode() ? this._popoverTargetExplicit : null;
    var id = this.getAttribute("popovertarget"); if (id === null || !this.isConnected) return null;
    var root = this.getRootNode(); return (root.getElementById ? root.getElementById(id) : null) || null;
  },
  set: function (v) {
    if (!__jb.POPOVER_INVOKERS.test(this._tag)) return;
    if (v === null) { this._popoverTargetExplicit = undefined; this.removeAttribute("popovertarget"); return; }
    if (!(v instanceof Element)) throw new TypeError("popoverTargetElement must be an Element or null");
    this._popoverTargetExplicit = v; this.setAttribute("popovertarget", "");
  },
  configurable: true,
});
Object.defineProperty(HTMLElement.prototype, "popoverTargetAction", {
  get: function () { if (!__jb.POPOVER_INVOKERS.test(this._tag)) return undefined; var a = (this.getAttribute("popovertargetaction") || "").toLowerCase(); return a === "show" || a === "hide" ? a : "toggle"; },
  set: function (v) { if (__jb.POPOVER_INVOKERS.test(this._tag)) this.setAttribute("popovertargetaction", String(v)); },
  configurable: true,
});
__jb.popoverOpen = function (el) { return el._popoverState === "showing"; };
__jb.checkPopoverValidity = function (el, expectedToBeShowing, throwing) {
  var fail = function (name, msg) { if (throwing) throw __jb.domError(name, msg); return false; };
  if (__jb.popoverValue(el) === null) return fail("NotSupportedError", "Not supported on an element that does not have a valid value for the 'popover' attribute");
  if (expectedToBeShowing && !__jb.popoverOpen(el)) return false;
  if (!expectedToBeShowing && __jb.popoverOpen(el)) return false;
  if (!el.isConnected) return fail("InvalidStateError", "Invalid on popover elements which aren't connected");
  if (el._tag === "dialog" && el.hasAttribute("open")) return fail("InvalidStateError", "Invalid on open dialog elements");
  return true;
};
__jb.fireToggle = function (el, type, oldState, newState, cancelable, source) { var ev = new ToggleEvent(type, { oldState: oldState, newState: newState, cancelable: !!cancelable, source: source || null }); __jb.setTrusted(ev, true); ev._trustedDispatch = true; return el.dispatchEvent(ev); };
__jb.queueToggle = function (el, oldState, newState, source) {
  if (el._toggleTask) { el._toggleTask.newState = newState; el._toggleTask.source = source || null; return; }
  el._toggleTask = { oldState: oldState, newState: newState, source: source || null };
  setTimeout(function () { var t = el._toggleTask; el._toggleTask = null; if (t) __jb.fireToggle(el, "toggle", t.oldState, t.newState, false, t.source); }, 0);
};
__jb.popoverShowingFlag = false; __jb.popoverHidingDepth = 0;
__jb.showPopover = function (el, throwing, invoker) {
  // Nested show during another show/hide throws before any event fires.
  if (__jb.popoverShowingFlag || __jb.popoverHidingDepth) { if (throwing) throw __jb.domError("InvalidStateError", "Cannot show a popover while another popover is being shown or hidden"); return; }
  if (!__jb.checkPopoverValidity(el, false, throwing)) return;
  var kind = __jb.popoverValue(el);
  __jb.popoverShowingFlag = true;
  try {
    if (!__jb.fireToggle(el, "beforetoggle", "closed", "open", true, invoker)) return;
    if (!__jb.checkPopoverValidity(el, false, throwing)) return;
    if (kind !== "manual") {
      // Only one auto popover chain stays open: hide the unrelated ones.
      __jb.topLayer.slice().forEach(function (other) { if (other !== el && other._popoverState === "showing" && __jb.popoverValue(other) !== "manual" && !other.contains(el) && !(invoker && other.contains(invoker))) __jb.hidePopover(other, false, false); });
      if (!__jb.checkPopoverValidity(el, false, throwing)) return;
      if (__jb.popoverValue(el) !== kind) { if (throwing) throw __jb.domError("InvalidStateError", "The popover type changed while showing it"); return; }
    }
    el._popoverState = "showing"; el._popoverInvoker = invoker || null;
    var prevFocus = __jb.currentDocument.activeElement; el._previouslyFocused = kind !== "manual" && prevFocus && prevFocus !== __jb.currentDocument.body ? prevFocus : null;
    __jb.topLayer.push(el);
    __jb.markDirty && __jb.markDirty(el);
    __jb.queueToggle(el, "closed", "open", invoker);
  } finally { __jb.popoverShowingFlag = false; }
  // Popover focusing steps: the popover itself when it carries autofocus, else its focus delegate (autofocus descendants first).
  var focusTarget;
  if (el._tag === "dialog") { var pf = __jb.flatDescendants(el, true); focusTarget = pf.filter(function (n) { return n.hasAttribute("autofocus") && (__jb.isFocusable(n) || (n._shadowRoot && n._shadowRoot.delegatesFocus)); })[0] || pf.filter(function (n) { return __jb.isFocusable(n) || (n._shadowRoot && n._shadowRoot.delegatesFocus); })[0] || el; } // dialogs shown as popovers use the dialog focusing steps
  else focusTarget = el.hasAttribute("autofocus") ? el : (__jb.flatDescendants(el, true).filter(function (n) { return n.hasAttribute("autofocus") && (__jb.isFocusable(n) || (n._shadowRoot && n._shadowRoot.delegatesFocus)); })[0] || null);
  if (focusTarget) __jb.focusElement(focusTarget, { force: focusTarget === el });
};
__jb.hidePopover = function (el, throwing, focusPrevious, silent, fireEvents, force, source) {
  if (silent) { el._popoverState = "hidden"; el._popoverInvoker = null; var si = __jb.topLayer.indexOf(el); if (si >= 0) __jb.topLayer.splice(si, 1); return; }
  if (el._popoverHiding) return;
  if (force) { if (el._popoverState !== "showing") return; }
  else if (!__jb.checkPopoverValidity(el, true, throwing)) return;
  __jb.popoverHidingDepth++; el._popoverHiding = true;
  try {
    // Hide popovers stacked above this one first (no events on a repeated pass).
    var idx = __jb.popoverValue(el) !== "manual" ? __jb.topLayer.indexOf(el) : -1;
    if (idx >= 0) __jb.topLayer.slice(idx + 1).forEach(function (above) { if (above._popoverState === "showing" && __jb.popoverValue(above) !== "manual") __jb.hidePopover(above, false, false, false, fireEvents); });
    if (fireEvents !== false) {
      __jb.fireToggle(el, "beforetoggle", "open", "closed", false, source);
      if (el._popoverState !== "showing" || (!force && !__jb.checkPopoverValidity(el, true, false))) return;
    }
    el._popoverState = "hidden";
    var i = __jb.topLayer.indexOf(el); if (i >= 0) __jb.topLayer.splice(i, 1);
    __jb.markDirty && __jb.markDirty(el);
    __jb.queueToggle(el, "open", "closed", source);
  } finally { __jb.popoverHidingDepth--; el._popoverHiding = false; }
  // Focus returns to the previously focused element only when focus was inside the popover.
  var active = __jb.currentDocument._jbActive;
  if (focusPrevious !== false && active && active.isConnected && (active === el || el.contains(active)) && el._previouslyFocused && el._previouslyFocused.isConnected) { try { __jb.focusElement(el._previouslyFocused); } catch (e) {} }
  el._popoverInvoker = null; el._previouslyFocused = null;
};
HTMLElement.prototype.showPopover = function (options) { var inv = options && options.source instanceof Element ? options.source : null; __jb.showPopover(this, true, inv); };
HTMLElement.prototype.hidePopover = function () { __jb.hidePopover(this, true); };
HTMLElement.prototype.togglePopover = function (options) {
  var force = typeof options === "boolean" ? options : options && typeof options === "object" && options.force !== undefined ? !!options.force : undefined;
  var inv = options && typeof options === "object" && options.source instanceof Element ? options.source : null;
  if (__jb.popoverOpen(this) && force !== true) { __jb.hidePopover(this, true); return false; }
  if (!__jb.popoverOpen(this) && force !== false) { __jb.showPopover(this, true, inv); return __jb.popoverOpen(this); }
  __jb.checkPopoverValidity(this, force === false, true);
  return __jb.popoverOpen(this);
};
// Invoker activation: `popovertarget` on buttons and inputs.
__jb.popoverInvoke = function (el) {
  if (!__jb.POPOVER_INVOKERS.test(el._tag)) return false;
  if (el._tag === "input" && !/^(button|reset|submit|image)$/.test(__jb.inputType(el))) return false;
  if (__jb.formOwner(el) && (el._tag === "input" ? /^(submit|image)$/.test(__jb.inputType(el)) : el.type === "submit")) return false;
  var target = el.popoverTargetElement; if (!target || __jb.popoverValue(target) === null) return false;
  var action = el.popoverTargetAction;
  if (action === "show" && !__jb.popoverOpen(target)) __jb.showPopover(target, false, el);
  else if (action === "hide" && __jb.popoverOpen(target)) __jb.hidePopover(target, false);
  else if (action === "toggle") { if (__jb.popoverOpen(target)) __jb.hidePopover(target, false); else __jb.showPopover(target, false, el); }
  return true;
};
// ---------------------------------------------------------------- command / commandfor invokers
// HTML "button element" activation: a button with a commandfor-associated element fires a
// CommandEvent at it and then runs the built-in command (popover, dialog, details).
__jb.COMMAND_KEYWORDS = ["toggle-popover", "show-popover", "hide-popover", "close", "request-close", "show-modal", "toggle", "open"];
// The command attribute's state: a keyword, the value itself for custom commands ("--x"), or null (unknown).
__jb.commandState = function (el) {
  var v = el.getAttribute("command");
  if (v === null) return null;
  if (v.slice(0, 2) === "--") return v;
  var lower = v.replace(/[A-Z]/g, function (c) { return c.toLowerCase(); });
  return __jb.COMMAND_KEYWORDS.indexOf(lower) >= 0 ? lower : null;
};
__jb.commandValidFor = function (target, cmd) {
  if (target._ns !== __jb.HTML_NS) return false;
  if (target._tag === "dialog") return cmd === "close" || cmd === "request-close" || cmd === "show-modal";
  if (target._tag === "details") return cmd === "toggle" || cmd === "open" || cmd === "close";
  return false;
};
__jb.commandSteps = function (target, source, cmd) {
  if (target._tag === "dialog") {
    if (target._popoverState === "showing") return;
    var optional = source.hasAttribute("value") ? source.getAttribute("value") : undefined;
    if (cmd === "close" && target.hasAttribute("open")) __jb.dialogClose(target, optional);
    else if (cmd === "request-close" && target.hasAttribute("open")) __jb.dialogRequestClose(target, optional);
    else if (cmd === "show-modal" && !target.hasAttribute("open")) { try { __jb.dialogOpen(target, true); } catch (e) {} }
  } else if (target._tag === "details") {
    if (cmd === "toggle") target.toggleAttribute("open");
    else if (cmd === "open") target.setAttribute("open", "");
    else if (cmd === "close") target.removeAttribute("open");
  }
};
// Returns true when the commandfor path handled the activation (the popovertarget path is then skipped).
__jb.commandInvoke = function (el) {
  if (el._tag !== "button" || el._ns !== __jb.HTML_NS) return false;
  if (__jb.formOwner(el)) {
    if (el.type === "submit" || el.type === "reset") return false;
    // Auto state (missing/invalid type) with a form owner: neither submits nor runs the command.
    if (!/^(submit|reset|button)$/i.test(el.getAttribute("type") || "")) return true;
  }
  var target = el.commandForElement; if (!target) return false;
  var cmd = __jb.commandState(el);
  if (cmd === null) return true;
  var custom = cmd.slice(0, 2) === "--";
  var isPopover = __jb.popoverValue(target) !== null;
  if (!custom && !/-popover$/.test(cmd) && !__jb.commandValidFor(target, cmd)) return true;
  var ev = new CommandEvent("command", { command: cmd, source: el, cancelable: true, composed: true });
  __jb.setTrusted(ev, true); ev._trustedDispatch = true;
  if (!target.dispatchEvent(ev)) return true;
  if (!target.isConnected || custom) return true;
  if (cmd === "hide-popover") { if (__jb.checkPopoverValidity(target, true, false)) __jb.hidePopover(target, false, true, false, true, false, el); }
  else if (cmd === "toggle-popover") {
    if (__jb.checkPopoverValidity(target, false, false)) __jb.showPopover(target, false, el);
    else if (__jb.checkPopoverValidity(target, true, false)) __jb.hidePopover(target, false, true, false, true, false, el);
  } else if (cmd === "show-popover") { if (__jb.checkPopoverValidity(target, false, false)) __jb.showPopover(target, false, el); }
  else if (__jb.commandValidFor(target, cmd)) __jb.commandSteps(target, el, cmd);
  return true;
};
(function () {
  var B = __jb.htmlClasses.HTMLButtonElement || HTMLElement;
  Object.defineProperty(B.prototype, "commandForElement", {
    get: function () {
      if (this._tag !== "button") return undefined;
      if (this._commandForExplicit !== undefined) { var e = this._commandForExplicit; return e && __jb.ariaInScope(this, e) ? e : null; }
      var id = this.getAttribute("commandfor");
      return id === null ? null : __jb.ariaFindId(this, id);
    },
    set: function (v) {
      if (this._tag !== "button") return;
      if (v === null || v === undefined) { this._commandForExplicit = undefined; this.removeAttribute("commandfor"); return; }
      if (!__jb.ariaIsElement(v)) throw new TypeError("Failed to set 'commandForElement': The provided value is not of type 'Element'.");
      this.setAttribute("commandfor", ""); this._commandForExplicit = v;
    },
    configurable: true, enumerable: true,
  });
  Object.defineProperty(B.prototype, "command", {
    get: function () { if (this._tag !== "button") return undefined; var s = __jb.commandState(this); return s === null ? "" : s; },
    set: function (v) { if (this._tag === "button") this.setAttribute("command", String(v)); },
    configurable: true, enumerable: true,
  });
})();
// Light dismiss: a click outside every open auto popover (and its invoker) hides them; Escape hides the topmost.
// "Topmost clicked popover": the nearest showing auto/hint popover reached from
// the click target through DOM ancestors, shadow hosts and invoker buttons.
__jb.topmostClickedPopover = function (node) {
  var best = null, bestIdx = -1;
  var consider = function (p) { if (p && p._popoverState === "showing" && __jb.popoverValue(p) !== "manual") { var i = __jb.topLayer.indexOf(p); if (i > bestIdx) { best = p; bestIdx = i; } } };
  for (var n = node; n; n = n.parentNode || (n.nodeType === 11 && n._host ? n._host : null)) {
    if (n.nodeType !== 1) continue;
    consider(n);
    if (__jb.POPOVER_INVOKERS.test(n._tag)) { var t = n.popoverTargetElement; if (t) consider(t); if (n._tag === "button" && n.hasAttribute("commandfor") && /-popover$/.test(__jb.commandState(n) || "")) { var ct = n.commandForElement; if (ct) consider(ct); } }
  }
  return best;
};
__jb.popoverPointerdown = function (target) { __jb.popoverPointerdownTarget = __jb.topmostClickedPopover(target); __jb.popoverPointerdownSeen = true; };
__jb.popoverLightDismiss = function (target) {
  var keep = __jb.topmostClickedPopover(target);
  if (__jb.popoverPointerdownSeen) { var down = __jb.popoverPointerdownTarget; __jb.popoverPointerdownSeen = false; __jb.popoverPointerdownTarget = null; if (down !== keep) return; }
  var keepIdx = keep ? __jb.topLayer.indexOf(keep) : -1;
  var stack = __jb.topLayer.slice(), modalIdx = -1;
  for (var mi = stack.length - 1; mi >= 0 && modalIdx < 0; mi--) if (stack[mi]._tag === "dialog" && stack[mi]._modal && stack[mi].hasAttribute("open")) modalIdx = mi;
  var lower = Math.max(keepIdx + 1, modalIdx), dialogDone = false;
  for (var si = stack.length - 1; si >= lower; si--) {
    var p = stack[si];
    if (p._tag === "dialog" && p.hasAttribute("open")) {
      if (!dialogDone && p.closedBy === "any" && !(target && p.contains(target))) { dialogDone = true; __jb.dialogRequestClose(p); }
      continue;
    }
    if (p._popoverState === "showing" && __jb.popoverValue(p) !== "manual") __jb.hidePopover(p, false, false);
  }
};
__jb.popoverEscape = function () {
  for (var i = __jb.topLayer.length - 1; i >= 0; i--) { var p = __jb.topLayer[i]; if (p._popoverState === "showing" && __jb.popoverValue(p) !== "manual") { __jb.hidePopover(p, false); return true; } if (p._tag === "dialog" && p.hasAttribute("open") && p.closedBy !== "none") { __jb.dialogRequestClose(p); return true; } }
  return false;
};

// ---------------------------------------------------------------- dialog
Object.defineProperty(HTMLElement.prototype, "closedBy", {
  get: function () { if (this._tag !== "dialog") return undefined; var v = (this.getAttribute("closedby") || "").toLowerCase(); if (v === "any" || v === "closerequest" || v === "none") return v; return this._modal ? "closerequest" : "none"; },
  set: function (v) { if (this._tag === "dialog") this.setAttribute("closedby", String(v)); },
  configurable: true,
});
Object.defineProperty(HTMLElement.prototype, "returnValue", { get: function () { return this._returnValue || ""; }, set: function (v) { this._returnValue = String(v); }, configurable: true });
__jb.dialogOpen = function (el, modal) {
  if (el.hasAttribute("open")) { if (modal && !el._modal) throw __jb.domError("InvalidStateError", "The dialog is already open as a non-modal dialog"); return; }
  if (!el.isConnected) throw __jb.domError("InvalidStateError", "Cannot show a dialog that is not connected");
  if (__jb.popoverOpen(el)) throw __jb.domError("InvalidStateError", "Cannot show a dialog that is an open popover");
  if (!__jb.fireToggle(el, "beforetoggle", "closed", "open", true)) return;
  if (el.hasAttribute("open") || !el.isConnected) return;
  el._requestCloseValue = undefined;
  el.setAttribute("open", ""); el._modal = !!modal;
  __jb.topLayer.push(el);
  if (modal) __jb.topLayer.slice().forEach(function (p) { if (p !== el && p._popoverState === "showing" && __jb.popoverValue(p) !== "manual") __jb.hidePopover(p, false, false); });
  __jb.queueToggle(el, "closed", "open");
  var flat = __jb.flatDescendants(el, true);
  var control = flat.filter(function (n) { return n.hasAttribute("autofocus") && (__jb.isFocusable(n) || (n._shadowRoot && n._shadowRoot.delegatesFocus)); })[0]
    || flat.filter(function (n) { return __jb.isFocusable(n) || (n._shadowRoot && n._shadowRoot.delegatesFocus); })[0];
  el._previousFocus = __jb.currentDocument.activeElement;
  if (control) __jb.focusElement(control); else __jb.focusElement(el, { force: true });
};
__jb.dialogClose = function (el, rv) {
  if (!el.hasAttribute("open")) return;
  __jb.fireToggle(el, "beforetoggle", "open", "closed", false);
  if (!el.hasAttribute("open")) return;
  el.removeAttribute("open"); el._modal = false;
  var i = __jb.topLayer.indexOf(el); if (i >= 0) __jb.topLayer.splice(i, 1);
  if (rv !== undefined) el._returnValue = String(rv);
  __jb.queueToggle(el, "open", "closed");
  var prev = el._previousFocus; el._previousFocus = null;
  if (prev && prev.focus && prev.isConnected) { try { prev.focus(); } catch (e) {} }
  setTimeout(function () { el.dispatchEvent(new Event("close")); }, 0);
};
__jb.dialogRequestClose = function (el, rv) {
  if (!el.hasAttribute("open")) return;
  if (el._closing) return;
  el._closing = true;
  var proceed = el.dispatchEvent(new Event("cancel", { cancelable: true }));
  el._closing = false;
  if (proceed) __jb.dialogClose(el, rv);
};
HTMLElement.prototype.show = function () { if (this._tag === "dialog") __jb.dialogOpen(this, false); };
HTMLElement.prototype.showModal = function () { if (this._tag === "dialog") __jb.dialogOpen(this, true); };
HTMLElement.prototype.close = function (rv) { if (this._tag === "dialog") __jb.dialogClose(this, rv); };
HTMLElement.prototype.requestClose = function (rv) {
  if (this._tag !== "dialog") return;
  if (!this.hasAttribute("open")) return;
  __jb.dialogRequestClose(this, rv);
};

// ---------------------------------------------------------------- sequential focus navigation (Tab)
__jb.isFocusable = function (el) {
  if (!el || el.nodeType !== 1 || !el.isConnected) return false;
  if (el.hasAttribute("hidden") || __jb.isDisabled(el) || el.closest("[inert]")) return false;
  if (el._tag === "dialog" && !el.hasAttribute("open")) return false;
  if (el.hasAttribute("popover") && el._popoverState !== "showing") return false;
  for (var a = el.parentNode; a && a.nodeType === 1; a = a.parentNode) { if (a.hasAttribute("hidden") || (a.hasAttribute("popover") && a._popoverState !== "showing") || (a._tag === "dialog" && !a.hasAttribute("open")) || (a._tag === "details" && !a.hasAttribute("open") && el.closest("summary") === null)) return false; }
  var t = el.getAttribute("tabindex");
  if (t !== null && /^\s*[-+]?\d+/.test(t)) return true;
  if (/^(input|select|textarea|button)$/.test(el._tag)) return !(el._tag === "input" && __jb.inputType(el) === "hidden");
  if ((el._tag === "a" || el._tag === "area") && el.hasAttribute("href")) return true;
  if (el._tag === "summary") { var dp = el.parentNode; if (!dp || dp.nodeType !== 1 || dp._tag !== "details") return false; for (var sc = dp.firstChild; sc; sc = sc.nextSibling) if (sc.nodeType === 1 && sc._tag === "summary") return sc === el; return false; }
  if (el._tag === "iframe" || (el._tag === "audio" || el._tag === "video") && el.hasAttribute("controls")) return true;
  return !!el.isContentEditable;
};
__jb.sequentialFocusOrder = function (root) {
  var scope = root || __jb.currentDocument;
  // A modal dialog scopes navigation to itself.
  for (var i = __jb.topLayer.length - 1; i >= 0; i--) if (__jb.topLayer[i]._tag === "dialog" && __jb.topLayer[i]._modal) { scope = __jb.topLayer[i]; break; }
  var all = __jb.descendants(scope, function (n) { return __jb.isFocusable(n) && n.tabIndex >= 0; });
  var positive = all.filter(function (n) { return n.tabIndex > 0; }).sort(function (a, b) { return a.tabIndex - b.tabIndex; });
  return positive.concat(all.filter(function (n) { return n.tabIndex === 0; }));
};
__jb.focusablesIn = function (root) { return __jb.descendants(root, function (n) { return __jb.isFocusable(n) && n.tabIndex >= 0; }); };
// Sequential focus navigation with the popover rules: Tab past the last
// focusable of a popover continues after its invoker, Shift+Tab from its first
// focusable returns to the invoker, and Tab from an invoker enters its popover.
__jb.moveFocus = function (dir) {
  var order = __jb.sequentialFocusOrder();
  if (!order.length) return;
  var cur = __jb.currentDocument.activeElement, body = __jb.currentDocument.body;
  var isBody = !cur || cur === body || cur === __jb.currentDocument.documentElement;
  var start = isBody ? __jb.currentDocument._focusStartingPoint : cur;
  if (start && !start.isConnected) start = null;
  var next = null;
  var popoverOf = function (n) { for (var a = n; a && a.nodeType === 1; a = a.parentNode || (a.getRootNode().nodeType === 11 ? a.getRootNode()._host : null)) if (a._popoverState === "showing") return a; return null; };
  var following = function (ref, d) {
    if (!ref) return d > 0 ? order[0] : order[order.length - 1];
    var idx = order.indexOf(ref);
    if (idx >= 0) return order[idx + d] || null;
    var pos = ref.nodeType === 1 ? ref : ref.parentNode;
    var zeros = order.filter(function (o) { return o.tabIndex === 0; });
    for (var k = 0; k < zeros.length; k++) { if (pos.compareDocumentPosition(zeros[k]) & 4) return d > 0 ? zeros[k] : (k > 0 ? zeros[k - 1] : order[order.indexOf(zeros[0]) - 1] || null); }
    return d > 0 ? null : zeros[zeros.length - 1] || order[order.length - 1];
  };
  if (start && !isBody) {
    var pop = popoverOf(start), inv = pop && pop._popoverInvoker;
    if (pop && inv) {
      var inside = __jb.focusablesIn(pop);
      if (dir < 0 && (inside.indexOf(start) === 0 || start === pop)) next = inv;
      else if (dir > 0 && inside.length && inside[inside.length - 1] === start) { var afterInv = following(inv, 1); while (afterInv && pop.contains(afterInv)) afterInv = following(afterInv, 1); next = afterInv; }
    }
    if (!next && dir > 0 && __jb.POPOVER_INVOKERS.test(start._tag)) { var tgt = start.popoverTargetElement; if (tgt && tgt._popoverState === "showing" && !tgt.contains(start)) { var first = __jb.focusablesIn(tgt)[0]; if (first) next = first; } }
  }
  if (!next) next = following(start, dir);
  if (next) next.focus(); else if (cur && typeof cur.blur === "function") { cur.blur(); __jb.currentDocument._focusStartingPoint = null; }
};

// ---------------------------------------------------------------- stepUp / stepDown
__jb.stepBy = function (el, n) {
  if (el._tag !== "input") return;
  var t = __jb.inputType(el);
  if (!/^(number|range|date|month|week|time|datetime-local)$/.test(t)) throw __jb.domError("InvalidStateError", "stepUp/stepDown does not apply to this input type");
  var stepAttr = el.getAttribute("step");
  if (stepAttr !== null && stepAttr.toLowerCase() === "any") throw __jb.domError("InvalidStateError", "step is \"any\"");
  var saved = el.value;
  if (el.value === "") el.value = t === "number" || t === "range" ? "0" : (t === "date" ? "1970-01-01" : t === "month" ? "1970-01" : t === "week" ? "1970-W01" : t === "time" ? "00:00" : "1970-01-01T00:00");
  var st = __jb.numericState(el);
  if (!st) { el.value = saved; return; }
  if (st.min !== null && st.max !== null && st.min > st.max) { el.value = saved; return; }
  var value = st.n, step = st.step;
  if (saved === "") value = 0; // an empty value steps from 0
  var q = (value - st.stepBase) / step;
  if (Math.abs(q - Math.round(q)) > 1e-9) { value = st.stepBase + (n > 0 ? Math.ceil(q) : Math.floor(q)) * step; n -= n > 0 ? 1 : -1; }
  var delta = n * step;
  var next = value + delta;
  if (n > 0 && st.max !== null && next > st.max) next = st.stepBase + Math.floor((st.max - st.stepBase) / step + 1e-9) * step;
  if (n < 0 && st.min !== null && next < st.min) next = st.stepBase + Math.ceil((st.min - st.stepBase) / step - 1e-9) * step;
  if ((n > 0 && next < value) || (n < 0 && next > value)) { el.value = saved; return; }
  if (t === "number" || t === "range") { el.value = String(parseFloat(next.toPrecision(15))); return; }
  if (t === "month") { var y = 1970 + Math.floor(next / 12), m = next - (y - 1970) * 12; el.value = y + "-" + __jb.pad(m + 1, 2); return; }
  var d = new Date(next);
  if (t === "date") el.valueAsDate = d;
  else if (t === "week") el.valueAsDate = d;
  else if (t === "time") el.valueAsDate = d;
  else if (t === "datetime-local") { var ms = d.getTime() % 60000; el.value = d.getUTCFullYear() + "-" + __jb.pad(d.getUTCMonth() + 1, 2) + "-" + __jb.pad(d.getUTCDate(), 2) + "T" + __jb.pad(d.getUTCHours(), 2) + ":" + __jb.pad(d.getUTCMinutes(), 2) + (ms ? ":" + __jb.pad(d.getUTCSeconds(), 2) + (d.getUTCMilliseconds() ? "." + __jb.pad(d.getUTCMilliseconds(), 3) : "") : ""); }
};
HTMLElement.prototype.stepUp = function (n) { __jb.stepBy(this, n === undefined ? 1 : Number(n) || 0); };
HTMLElement.prototype.stepDown = function (n) { __jb.stepBy(this, -(n === undefined ? 1 : Number(n) || 0)); };

// Elements of the flat tree under root (shadow trees replace light children,
// slotted light children are visited through their slots), in tree order.
__jb.flatDescendants = function (root, opaqueShadow) {
  var out = [];
  (function walk(n) {
    var kids;
    if (n.nodeType === 1 && n._shadowRoot) { if (!n._shadowRoot.delegatesFocus && opaqueShadow) return; kids = __jb.arrayFrom(n._shadowRoot.childNodes); }
    else if (n.nodeType === 1 && n._tag === "slot" && typeof n.assignedNodes === "function") { kids = n.assignedNodes(); if (!kids.length) kids = __jb.arrayFrom(n.childNodes); }
    else kids = __jb.arrayFrom(n.childNodes);
    for (var i = 0; i < kids.length; i++) { var k = kids[i]; if (k.nodeType !== 1) continue; out.push(k); walk(k); }
  })(root);
  return out;
};
// ---------------------------------------------------------------- focusing steps
__jb.fireFocusEvent = function (target, type, related) {
  var ev = new FocusEvent(type, { bubbles: type === "focusin" || type === "focusout", cancelable: false, composed: true, relatedTarget: related || null, view: globalThis });
  __jb.setTrusted(ev, true); ev._trustedDispatch = true;
  target.dispatchEvent(ev);
};
__jb.focusElement = function (el, options) {
  var doc = el.ownerDocument; if (!doc || !el.isConnected) return;
  if (!__jb.isFocusable(el) && !(options && options.force)) {
    // A shadow host that delegates focus forwards to its first focusable descendant.
    if (el._shadowRoot && el._shadowRoot.delegatesFocus) { var first = __jb.flatDescendants(el._shadowRoot).filter(function (n) { return n.hasAttribute("autofocus") && __jb.isFocusable(n); })[0] || __jb.flatDescendants(el._shadowRoot).filter(__jb.isFocusable)[0]; if (first) __jb.focusElement(first, options); }
    return;
  }
  if (doc._jbActive === el) return;
  var prev = doc._jbActive && doc._jbActive.isConnected ? doc._jbActive : null;
  doc._jbActive = null;
  if (prev) { __jb.fireFocusEvent(prev, "blur", el); __jb.fireFocusEvent(prev, "focusout", el); }
  if (doc._jbActive !== null) return; // a blur handler moved focus elsewhere
  doc._jbActive = el;
  // focusing an editing host puts the caret at its start unless the selection is already in it
  if (el.isContentEditable === true && !(el.parentElement && el.parentElement.isContentEditable) && doc === __jb.currentDocument && typeof getSelection === "function") {
    try {
      var fsel = getSelection();
      var inHost = fsel.rangeCount && el.contains(fsel.getRangeAt(0).startContainer) && el.contains(fsel.getRangeAt(0).endContainer);
      if (!inHost) fsel.collapse(el, 0);
    } catch (eSel) {}
  }
  // :focus-visible: explicit FocusOptions, else keyboard/script focus shows it and pointer focus does not (text fields always do).
  var textual = (el._tag === "input" && !/^(button|submit|reset|image|checkbox|radio|range|color|file)$/.test(__jb.inputType(el))) || el._tag === "textarea" || el.isContentEditable === true;
  el._focusVisible = options && typeof options.focusVisible === "boolean" ? options.focusVisible : (textual || !__jb.lastInputPointer);
  __jb.fireFocusEvent(el, "focus", prev); __jb.fireFocusEvent(el, "focusin", prev);
};
__jb.blurElement = function (el) {
  var doc = el.ownerDocument; if (!doc || doc._jbActive !== el) return;
  doc._jbActive = null;
  __jb.fireFocusEvent(el, "blur", null); __jb.fireFocusEvent(el, "focusout", null);
};
HTMLElement.prototype.focus = function (options) { __jb.focusElement(this, options); };
HTMLElement.prototype.blur = function () { __jb.blurElement(this); };
if (typeof SVGElement === "function") { SVGElement.prototype.focus = function (options) { __jb.focusElement(this, options); }; SVGElement.prototype.blur = function () { __jb.blurElement(this); }; }
// The focused element retargeted against a root (document or shadow root).
__jb.retargetFocus = function (root) {
  var doc = root.nodeType === 9 ? root : root.ownerDocument;
  var el = doc._jbActive && doc._jbActive.isConnected ? doc._jbActive : null;
  if (!el) return null;
  var node = el;
  while (node) { var r = node.getRootNode(); if (r === root) return node; if (r.nodeType === 11 && r._host) node = r._host; else return null; }
  return null;
};
Object.defineProperty(ShadowRoot.prototype, "activeElement", { get: function () { return __jb.retargetFocus(this); }, configurable: true });

// ---------------------------------------------------------------- autofocus
__jb.flushAutofocus = function () {
  if (__jb.currentDocument._autofocusProcessed || !__jb.currentDocument.documentElement) return;
  // a fragment that indicates an element (the document's target element) suppresses autofocus
  var frag = /#/.test(__jb.currentDocument.URL) ? __jb.currentDocument.URL.slice(__jb.currentDocument.URL.indexOf("#") + 1) : "";
  if (frag !== "") { var dec = frag; try { dec = decodeURIComponent(frag); } catch (e) {} if (__jb.currentDocument.getElementById(frag) || __jb.currentDocument.getElementById(dec) || __jb.A.some.call(__jb.currentDocument.getElementsByTagName("a"), function (a) { return a.getAttribute("name") === dec; })) return; }
  var active = __jb.currentDocument._jbActive && __jb.currentDocument._jbActive.isConnected ? __jb.currentDocument._jbActive : null;
  if (active && active !== __jb.currentDocument.body) return;
  var candidates = __jb.currentDocument.querySelectorAll("[autofocus]");
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (c._autofocusSkipped) continue;
    if (c.closest && (c.closest("dialog:not([open])") || c.closest("[popover]") && !__jb.popoverOpen(c.closest("[popover]")))) continue;
    if (!__jb.isFocusable(c)) { c._autofocusSkipped = true; continue; }
    __jb.currentDocument._autofocusProcessed = true;
    __jb.focusElement(c);
    return;
  }
};
(function () {
  var raf = requestAnimationFrame;
  requestAnimationFrame = function (cb) { return raf(function (t) { __jb.flushAutofocus(); cb(t); }); };
})();

// ---------------------------------------------------------------- user activation, showPicker, meter
__jb.activationTime = -Infinity; __jb.hasBeenActive = false;
__jb.noteUserActivation = function () { __jb.activationTime = Date.now(); __jb.hasBeenActive = true; };
__jb.hasTransientActivation = function () { return Date.now() - __jb.activationTime < 5000; };
__jb.consumeUserActivation = function () { __jb.activationTime = -Infinity; };
if (typeof navigator === "object" && !("userActivation" in navigator)) {
  try { Object.defineProperty(navigator, "userActivation", { get: function () { return { get isActive() { return __jb.hasTransientActivation(); }, get hasBeenActive() { return __jb.hasBeenActive; } }; }, configurable: true }); } catch (e) {}
}
HTMLElement.prototype.showPicker = function () {
  if (this._tag === "select") { if (__jb.isDisabled(this)) throw __jb.domError("InvalidStateError", "showPicker() on a disabled select"); if (!__jb.hasTransientActivation()) throw __jb.domError("NotAllowedError", "showPicker() requires a user gesture"); __jb.consumeUserActivation(); return; }
  if (this._tag !== "input") return;
  if (__jb.isDisabled(this) || this.hasAttribute("readonly")) throw __jb.domError("InvalidStateError", "showPicker() on a disabled or readonly input");
  if (!__jb.hasTransientActivation()) throw __jb.domError("NotAllowedError", "showPicker() requires a user gesture");
  __jb.consumeUserActivation();
};
// <meter>: numeric IDL attributes with the spec's clamping rules.
(function () {
  var protos = [HTMLElement.prototype].concat(typeof HTMLMeterElement === "function" ? [HTMLMeterElement.prototype] : []);
  // "rules for parsing floating-point number values" (leading whitespace and '+' allowed, trailing junk ignored)
  var num = function (el, name, dflt) { var v = el.getAttribute(name); var n = v === null ? null : __jb.parseHtmlFloat(v); return n === null ? dflt : n; };
  var calc = function (el) {
    var min = num(el, "min", 0), max = Math.max(num(el, "max", 1), min);
    var value = Math.min(Math.max(num(el, "value", 0), min), max);
    var low = Math.min(Math.max(num(el, "low", min), min), max);
    var high = Math.max(Math.min(num(el, "high", max), max), low);
    var optimum = Math.min(Math.max(num(el, "optimum", (min + max) / 2), min), max);
    return { min: min, max: max, value: value, low: low, high: high, optimum: optimum };
  };
  ["value", "min", "max", "low", "high", "optimum"].forEach(function (prop) {
    protos.forEach(function (proto) {
      var prev = Object.getOwnPropertyDescriptor(proto, prop);
      Object.defineProperty(proto, prop, {
        get: function () { if (this._tag !== "meter") return prev && prev.get ? prev.get.call(this) : undefined; return calc(this)[prop]; },
        set: function (v) { if (this._tag !== "meter") { if (prev && prev.set) prev.set.call(this, v); return; } v = Number(v); if (!isFinite(v)) throw new TypeError("The value provided is non-finite"); this.setAttribute(prop, String(v)); },
        configurable: true,
      });
    });
  });
})();

// <progress>: determinate when it has a value attribute; value is clamped to [0, max], position is value/max or -1.
(function () {
  var proto = typeof HTMLProgressElement === "function" ? HTMLProgressElement.prototype : null;
  if (!proto) return;
  var maxOf = function (el) { var v = el.getAttribute("max"); var n = v === null ? null : __jb.parseHtmlFloat(v); return n !== null && n > 0 ? n : 1; };
  var valueOf = function (el) { var v = el.getAttribute("value"); var n = v === null ? null : __jb.parseHtmlFloat(v); if (n === null || n < 0) n = 0; return Math.min(n, maxOf(el)); };
  var brand = function (el, what) { if (!(el instanceof HTMLProgressElement)) throw new TypeError("'" + what + "' called on an object that does not implement interface HTMLProgressElement."); };
  Object.defineProperty(proto, "value", {
    get: function value() { brand(this, "get value"); return this.hasAttribute("value") ? valueOf(this) : 0; },
    set: function value(v) { brand(this, "set value"); v = Number(v); if (!isFinite(v)) throw new TypeError("The provided double value is non-finite."); this.setAttribute("value", __jb.formatHtmlFloat ? __jb.formatHtmlFloat(v) : String(v)); },
    enumerable: true, configurable: true,
  });
  Object.defineProperty(proto, "position", {
    get: function position() { brand(this, "get position"); return this.hasAttribute("value") ? valueOf(this) / maxOf(this) : -1; },
    enumerable: true, configurable: true,
  });
  if (!Object.getOwnPropertyDescriptor(proto, "labels")) {
    var lab = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "labels") || Object.getOwnPropertyDescriptor(HTMLElement.prototype, "labels");
    if (lab) Object.defineProperty(proto, "labels", lab);
  }
})();

// ---------------------------------------------------------------- autocomplete IDL attribute
// "autofill detail tokens" processing: the attribute reflects only when its
// tokens form a valid autofill expectation mantle, normalized to lowercase.
__jb.AUTOFILL_FIELDS = /^(name|honorific-prefix|given-name|additional-name|family-name|honorific-suffix|nickname|username|new-password|current-password|one-time-code|organization-title|organization|street-address|address-line1|address-line2|address-line3|address-level4|address-level3|address-level2|address-level1|country|country-name|postal-code|cc-name|cc-given-name|cc-additional-name|cc-family-name|cc-number|cc-exp|cc-exp-month|cc-exp-year|cc-csc|cc-type|transaction-currency|transaction-amount|language|bday|bday-day|bday-month|bday-year|sex|url|photo)$/;
__jb.AUTOFILL_CONTACT = /^(tel|tel-country-code|tel-national|tel-area-code|tel-local|tel-local-prefix|tel-local-suffix|tel-extension|email|impp)$/;
__jb.autocompleteValue = function (el) {
  var raw = el.getAttribute("autocomplete");
  if (el._tag === "form") return raw !== null && raw.trim().toLowerCase() === "off" ? "off" : "on";
  if (raw === null) return "";
  var tokens = raw.split(/[\t\n\f\r ]+/).filter(Boolean).map(function (t) { return t.toLowerCase(); });
  if (!tokens.length) return "";
  var i = tokens.length - 1, out = [];
  if (tokens[i] === "webauthn") { out.unshift("webauthn"); i--; if (i < 0) return "webauthn"; }
  var field = tokens[i];
  if (field === "on" || field === "off") return tokens.length === 1 ? field : "";
  var contact = __jb.AUTOFILL_CONTACT.test(field), plain = __jb.AUTOFILL_FIELDS.test(field);
  if (!contact && !plain) return "";
  out.unshift(field); i--;
  if (contact && i >= 0 && /^(home|work|mobile|fax|pager)$/.test(tokens[i])) { out.unshift(tokens[i]); i--; }
  if (i >= 0 && /^(shipping|billing)$/.test(tokens[i])) { out.unshift(tokens[i]); i--; }
  if (i >= 0 && tokens[i].indexOf("section-") === 0) { out.unshift(tokens[i]); i--; }
  if (i >= 0) return "";
  return out.join(" ");
};
[HTMLElement.prototype].concat(["HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "HTMLFormElement"].filter(function (n) { return typeof globalThis[n] === "function"; }).map(function (n) { return globalThis[n].prototype; })).forEach(function (proto) {
  Object.defineProperty(proto, "autocomplete", { get: function () { return /^(form|input|select|textarea)$/.test(this._tag) ? __jb.autocompleteValue(this) : (this.getAttribute("autocomplete") || ""); }, set: function (v) { this.setAttribute("autocomplete", String(v)); }, configurable: true });
});

// ---------------------------------------------------------------- form submission
// HTML "constructing the entry list", the formdata event, the three form
// encodings and navigation of the target (frames get real GET/POST loads).
class FormDataEvent extends Event {
  constructor(type, init) {
    if (arguments.length < 2) throw new TypeError("Failed to construct 'FormDataEvent': 2 arguments required.");
    if (!init || !(init.formData instanceof FormData)) throw new TypeError("Failed to construct 'FormDataEvent': member formData is not of type FormData.");
    super(type, init);
    Object.defineProperty(this, "_formData", { value: init.formData });
  }
  get formData() { return this._formData; }
}
__jb.setTag(FormDataEvent, "FormDataEvent");
globalThis.FormDataEvent = FormDataEvent;
__jb.newlinesToCRLF = function (s) { return String(s).replace(/\r\n|\r|\n/g, "\r\n"); };
__jb.constructEntryList = function (form, submitter, encoding) {
  if (form._constructingEntryList) return null;
  form._constructingEntryList = true;
  try {
    var list = [];
    var push = function (n, v) { list.push([n, v]); };
    var controls = __jb.descendants(form.getRootNode(), function (n) { return n.nodeType === 1 && n._ns === __jb.HTML_NS && (/^(button|input|select|textarea|object)$/.test(n._tag) || (__jb.isFACE && __jb.isFACE(n))) && __jb.formOwner(n) === form; });
    controls.forEach(function (field) {
      if (__jb.isFACE && __jb.isFACE(field)) { __jb.faceEntries(field).forEach(function (e) { push(e[0], e[1]); }); return; }
      if (field.closest("datalist") || __jb.isDisabled(field)) return;
      var tag = field._tag, type = tag === "input" ? __jb.inputType(field) : tag === "button" ? field.type : "";
      if ((tag === "button" || (tag === "input" && /^(submit|reset|button|image)$/.test(type))) && field !== submitter) return;
      if (tag === "input" && /^(checkbox|radio)$/.test(type) && !field.checked) return;
      if (tag === "object") return;
      if (tag === "button" && field.type !== "submit") return;
      if (tag === "input" && type === "image") {
        var nm = field.getAttribute("name"), prefix = nm ? nm + "." : "";
        var c = field._imageCoords || { x: 0, y: 0 };
        push(prefix + "x", String(c.x)); push(prefix + "y", String(c.y));
        return;
      }
      var name = field.getAttribute("name");
      if (name === null || name === "") return;
      if (tag === "select") { __jb.arrayFrom(field.options).forEach(function (o) { if (o.selected && !o.disabled) push(name, o.value); }); }
      else if (tag === "input" && /^(checkbox|radio)$/.test(type)) { var v = field.getAttribute("value"); push(name, v === null ? "on" : v); }
      else if (tag === "input" && type === "file") {
        var files = field.files;
        if (!files || !files.length) push(name, new File([], "", { type: "application/octet-stream" }));
        else for (var i = 0; i < files.length; i++) push(name, files[i]);
      }
      else if (tag === "input" && type === "hidden" && name.toLowerCase() === "_charset_") push(name, encoding);
      else push(name, field.value);
      var dirname = field.getAttribute("dirname");
      if (dirname && (tag === "textarea" || (tag === "input" && /^(text|search|hidden|tel|url|email|password|submit|reset)$/.test(type)))) push(dirname, field.matches && field.matches(":dir(rtl)") ? "rtl" : "ltr");
    });
    var fd = new FormData();
    fd._list = list.map(function (p) { return [p[0], typeof p[1] === "string" ? p[1] : p[1]]; });
    var ev = new FormDataEvent("formdata", { bubbles: true, formData: fd });
    __jb.setTrusted(ev, true); ev._trustedDispatch = true;
    form.dispatchEvent(ev);
    return fd._list.slice();
  } finally { form._constructingEntryList = false; }
};
__jb.encodeUrlencodedEntries = function (list, encoding) {
  return list.map(function (p) {
    var v = __jb.newlinesToCRLF(typeof p[1] === "string" ? p[1] : p[1].name);
    return __jb.formEncodeIn(__jb.newlinesToCRLF(p[0]), encoding) + "=" + __jb.formEncodeIn(v, encoding);
  }).join("&");
};
__jb.encodeTextPlainEntries = function (list) {
  return list.map(function (p) { return __jb.newlinesToCRLF(p[0]) + "=" + __jb.newlinesToCRLF(typeof p[1] === "string" ? p[1] : p[1].name) + "\r\n"; }).join("");
};
__jb.formSubmissionTarget = function (form, submitter) {
  var t = submitter && submitter.hasAttribute && submitter.hasAttribute("formtarget") ? submitter.getAttribute("formtarget") : form.getAttribute("target");
  if (t === null || t === "") { var base = form.ownerDocument && form.ownerDocument.querySelector("base[target]"); t = base ? base.getAttribute("target") : ""; }
  return t || "_self";
};
__jb.formSubmitted = function (form, submitter, fromSubmitMethod) {
  if (!form.isConnected) return;
  if (form._constructingEntryList) return;
  if (form._firingSubmission) return;
  var attr = function (name, formName) { return submitter && submitter !== form && submitter.hasAttribute && submitter.hasAttribute(formName) ? submitter.getAttribute(formName) : form.getAttribute(name); };
  var method = (attr("method", "formmethod") || "").toLowerCase();
  method = method === "post" || method === "dialog" ? method : "get";
  if (method === "dialog") {
    var dlg = form.closest("dialog");
    var result;
    if (submitter && submitter !== form && submitter._tag === "input" && __jb.inputType(submitter) === "image") { var ic = submitter._imageCoords || { x: 0, y: 0 }; result = ic.x + "," + ic.y; }
    else if (submitter && submitter !== form && submitter.hasAttribute && submitter.hasAttribute("value")) result = submitter.getAttribute("value");
    if (dlg && dlg.hasAttribute("open")) __jb.dialogClose(dlg, result);
    return;
  }
  var encoding = __jb.formEncoding(form);
  var list = __jb.constructEntryList(form, submitter && submitter !== form ? submitter : null, encoding);
  if (list === null || !form.isConnected) return;
  var rawAction = attr("action", "formaction");
  var action;
  try { action = new URL(rawAction === null || rawAction === "" ? form.ownerDocument.URL : rawAction, form.baseURI); } catch (e) { return; }
  // Content Security Policy form-action
  if (__jb.csp && !__jb.csp.allowsFormAction(form, action.href)) return;
  var enctype = (attr("enctype", "formenctype") || "").toLowerCase();
  if (!/^(multipart\/form-data|text\/plain)$/.test(enctype)) enctype = "application/x-www-form-urlencoded";
  var data = {}; list.forEach(function (p) { data[p[0]] = typeof p[1] === "string" ? p[1] : p[1].name; });
  // The engine follows `formSubmissions` as a navigation of the top-level document, so a
  // submission is recorded there only when nothing else (a frame, a popup) is its target.
  var submission = { action: action.href, method: method, data: data };
  __jb.formSubmittedInTask = true; setTimeout(function () { __jb.formSubmittedInTask = false; }, 0);
  console.log("Form submitted via JavaScript: " + method.toUpperCase() + " " + action.href);
  var post = null, url = action.href, scheme = action.protocol;
  if (method === "get" && /^(http|https|ftp|data|file):$/.test(scheme)) { action.search = __jb.encodeUrlencodedEntries(list, encoding); url = action.href; }
  else if (method === "post" && /^(http|https):$/.test(scheme)) {
    if (enctype === "multipart/form-data") { var fd = new FormData(); fd._list = list.map(function (p) { var n = __jb.newlinesToCRLF(p[0]); return [n, typeof p[1] === "string" ? p[1] : p[1]]; }); var mp = __jb.multipartEncode(fd); post = { bodyBase64: __jb.bytesToB64(mp.bytes), contentType: mp.contentType }; }
    else if (enctype === "text/plain") post = { body: __jb.encodeTextPlainEntries(list), contentType: "text/plain" };
    else post = { body: __jb.encodeUrlencodedEntries(list, encoding), contentType: "application/x-www-form-urlencoded" };
  } else if (method === "post" && scheme === "data:") { /* mutate data: URLs is rarely used */ }
  // The engine sends exactly this request (entry-list order, repeated names kept).
  if (method === "get") submission.url = url;
  else if (post && post.body !== undefined) { submission.body = post.body; submission.contentType = post.contentType; }
  else if (method === "post" && scheme === "mailto:") { url = action.href; }
  // The Navigation API sees the submission first (navigate event: cancelable, interceptable).
  if (typeof __jb.formNavigateHook === "function" && __jb.formNavigateHook(form, submitter, url, post, method, list) === false) return;
  // Navigate the target.
  var target = __jb.formSubmissionTarget(form, submitter);
  if (typeof __jb.loadFrame === "function") {
    var frame = null;
    if (!/^_(self|blank|parent|top)$/i.test(target)) frame = __jb.descendants(form.ownerDocument, function (n) { return n.nodeType === 1 && n._ns === __jb.HTML_NS && (n._tag === "iframe" || n._tag === "frame") && n.getAttribute("name") === target; })[0];
    if (!frame && !/^_(self|blank|parent|top)$/i.test(target) && typeof __jb.findNamedFrame === "function") frame = __jb.findNamedFrame(target);
    var formRef = typeof __jb.requestReferrer === "function" ? __jb.requestReferrer() : undefined;
    if (frame && frame._tag) { frame._pendingPost = post; if (formRef) __jb.withNavigationReferrer(formRef, function () { __jb.loadFrame(frame, url); }); else __jb.loadFrame(frame, url); return; }
    var selfFrame = (__jb.frameContext && __jb.frameContext.frameElement) || null; // also for cross-origin frames
    if (/^_self$/i.test(target) && selfFrame && selfFrame._contentWindow === globalThis) {
      // the frame navigates itself in a task (as a navigation would), not inside the running script
      var fe = selfFrame, pw = fe.ownerDocument.defaultView, me = globalThis;
      pw.setTimeout(function () { if (fe._contentWindow !== me) return; fe._pendingPost = post; if (formRef) pw.__jb.withNavigationReferrer(formRef, function () { pw.__jb.loadFrame(fe, url); }); else pw.__jb.loadFrame(fe, url); }, 0);
      return;
    }
  }
  // A named auxiliary window (a popup) navigates there, POST bodies included.
  if (!/^_(self|blank|parent|top)$/i.test(target) && typeof __jb.findNamedContext === "function") {
    var aux = __jb.findNamedContext(target);
    if (aux && aux !== globalThis && aux.__jb && aux.__jb.auxiliary) {
      var creator = aux.__jb.auxiliary.creator || globalThis;
      var user = !!__jb.userNavigation;
      creator.setTimeout(function () { if (!aux.closed) creator.__jb.loadRealmDocument(aux, creator.__jb.fetchSource(url, post, "document", user), true); }, 0);
      return;
    }
  }
  // POST into a new window (_blank): the window opens and navigates with the body.
  if (post && /^_blank$/i.test(target) && typeof globalThis.open === "function") {
    var prel = (form.getAttribute("rel") || "").toLowerCase().split(/[\t\n\f\r ]+/);
    var pnoref = prel.indexOf("noreferrer") >= 0, pnoopen = pnoref || prel.indexOf("opener") < 0;
    var postRef = typeof __jb.requestReferrer === "function" ? __jb.requestReferrer() : undefined;
    var nw = null; try { globalThis.open("", "_blank", ""); nw = __jb.auxiliaryWindows[__jb.auxiliaryWindows.length - 1] || null; } catch (eo) { nw = null; }
    if (nw && nw.__jb) {
      var cr = nw.__jb.auxiliary && nw.__jb.auxiliary.creator || globalThis;
      if (pnoopen) { try { nw.__jb.auxiliary.opener = null; } catch (en) {} }
      cr.setTimeout(function () { if (nw.closed) return; var src = postRef ? cr.__jb.withNavigationReferrer(postRef, function () { return cr.__jb.fetchSource(url, post, "document", !!__jb.userNavigation); }) : cr.__jb.fetchSource(url, post, "document", !!__jb.userNavigation); cr.__jb.loadRealmDocument(nw, src, true); }, 0);
    }
    return;
  }
  // New or named auxiliary browsing contexts (GET submissions): rel / _blank decide noopener.
  if (!post && !/^_(self|parent|top)$/i.test(target) && typeof globalThis.open === "function") {
    var rel = (form.getAttribute("rel") || "").toLowerCase().split(/[\t\n\f\r ]+/);
    var noreferrer = rel.indexOf("noreferrer") >= 0, noopener = noreferrer || rel.indexOf("noopener") >= 0 || (/^_blank$/i.test(target) && rel.indexOf("opener") < 0);
    try { globalThis.open(url, target, noopener ? (noreferrer ? "noopener,noreferrer" : "noopener") : ""); } catch (e) {}
    return;
  }
  // A POST into a named target that does not exist (yet) opens nothing here rather than
  // replacing the page (tracking pixels post into frames they create).
  if (!/^_(self|parent|top|blank)$/i.test(target)) return;
  __jb.formSubmissions.push(submission);
};
