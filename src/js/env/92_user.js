// ---------------------------------------------------------------- user input emulation
// Trusted pointer / mouse / keyboard / input event sequences as a browser produces them for a
// real user, shared by the agent, the interactive CLI and WebDriver-style test drivers.
//   __jb.user.click(el), .dblclick(el), .hover(el), .type(el, text, opts), .press(key, el),
//   .clear(el), .select(el, valueOrLabel), .setChecked(el, bool), .scrollIntoView(el), .find(spec)
(function () {
  var U = __jb.user = {};
  var fire = U.fire = function (target, Ctor, type, init) {
    var boundary = /^(mouseenter|mouseleave|pointerenter|pointerleave)$/.test(type);
    var e = new Ctor(type, Object.assign({ bubbles: !boundary, cancelable: !boundary && type !== "pointerup" && type !== "pointercancel" && type !== "input", composed: !boundary, view: globalThis }, init || {}));
    __jb.setTrusted(e, true); e._trustedDispatch = true;
    // Real input is dispatched with an empty JS stack, so microtasks run after each listener (a Lit
    // component re-renders between its click listener and the button's default action: Healthline's
    // quiz removed its Submit button there, so the form was never submitted). Real pages only.
    if (!__jb.wptMode) e._checkpoint = true;
    var r = target.dispatchEvent(e);
    // a value/selection the user changed must reach the engine's document copy (read() markdown)
    if (!__jb.wptMode && (type === "input" || type === "change") && target && target.nodeType === 1 && /^(input|select|textarea)$/.test(target._tag) && typeof __jb.markDirty === "function") __jb.markDirty(target.parentNode && target.parentNode.nodeType === 1 ? target.parentNode : target);
    return r;
  };
  var pointer = U.pointer = { x: 0, y: 0, over: null, overChain: [], downTarget: null, buttons: 0, clicks: 0, lastClick: 0 };
  var elementAt = function (x, y) { var el = null; try { el = __jb.currentDocument.elementFromPoint(x, y); } catch (e) {} return el || __jb.currentDocument.body || __jb.currentDocument.documentElement; };
  U.elementAt = elementAt;
  var centerOf = U.centerOf = function (el) {
    var r = null; try { r = el.getBoundingClientRect ? el.getBoundingClientRect() : null; } catch (e) {}
    return r && (r.width || r.height) ? { x: r.left + r.width / 2, y: r.top + r.height / 2, empty: false } : { x: 0, y: 0, empty: true };
  };
  var rel = function (n) { return n && n instanceof EventTarget && n.isConnected ? n : null; };
  var mouseInit = function (extra) { return Object.assign({ clientX: pointer.x, clientY: pointer.y, screenX: pointer.x, screenY: pointer.y, buttons: pointer.buttons, button: 0, detail: 0 }, U.modifierInit(), extra || {}); };
  var pointerInit = function (params, extra) { return Object.assign(mouseInit(extra), { pointerId: params && params.pointerType && params.pointerType !== "mouse" ? 2 : 1, isPrimary: true, pointerType: (params && params.pointerType) || "mouse", width: 1, height: 1, pressure: pointer.buttons ? 0.5 : 0 }, extra && extra.pointerId !== undefined ? { pointerId: extra.pointerId, pointerType: extra.pointerType, isPrimary: false, width: 1, height: 1, pressure: 0 } : {}); };
  var flatParent = function (n) { var slot = n.nodeType === 1 && typeof __jb.assignedSlotOf === "function" ? __jb.assignedSlotOf(n) : null; return slot || n.parentNode || (n.nodeType === 11 && n._host ? n._host : null); };
  var ancestorsOf = function (el) { var out = []; for (var n = el; n && n.nodeType === 1; n = flatParent(n)) { out.push(n); var p = flatParent(n); if (p && p.nodeType === 11) n = p; } return out; };

  // Boundary events (UI Events): out/over on old/new targets, leave innermost-first, enter outermost-first.
  U.movePointer = function (x, y, params, noMove, target) {
    pointer.x = x; pointer.y = y; pointer.active = true;
    var el = target || elementAt(x, y), prev = pointer.over;
    if (el !== prev) {
      var prevChain = prev ? (prev.isConnected ? ancestorsOf(prev) : pointer.overChain || [prev]) : [], newChain = el ? ancestorsOf(el) : [];
      var common = null;
      for (var i = 0; i < prevChain.length && !common; i++) if (newChain.indexOf(prevChain[i]) >= 0) common = prevChain[i];
      if (prev && prev.isConnected) { fire(prev, PointerEvent, "pointerout", pointerInit(params, { relatedTarget: rel(el) })); fire(prev, MouseEvent, "mouseout", mouseInit({ relatedTarget: rel(el) })); }
      for (var li = 0; li < prevChain.length && prevChain[li] !== common; li++) { if (!prevChain[li].isConnected) continue; fire(prevChain[li], PointerEvent, "pointerleave", pointerInit(params, { relatedTarget: rel(el) })); fire(prevChain[li], MouseEvent, "mouseleave", mouseInit({ relatedTarget: rel(el) })); }
      pointer.over = el; pointer.overChain = newChain;
      if (el) { fire(el, PointerEvent, "pointerover", pointerInit(params, { relatedTarget: rel(prev) })); fire(el, MouseEvent, "mouseover", mouseInit({ relatedTarget: rel(prev) })); }
      var enter = []; for (var ei = 0; ei < newChain.length && newChain[ei] !== common; ei++) enter.push(newChain[ei]);
      for (var ej = enter.length - 1; ej >= 0; ej--) { fire(enter[ej], PointerEvent, "pointerenter", pointerInit(params, { relatedTarget: rel(prev) })); fire(enter[ej], MouseEvent, "mouseenter", mouseInit({ relatedTarget: rel(prev) })); }
      __jb.hoverChain = newChain;
      if (!__jb.wptMode) {
        __jb.layoutVersion++; __jb.geomVersion = (__jb.geomVersion || 0) + 1;
        var hoverDirty = __jb.styleDirtyEls || (__jb.styleDirtyEls = new Set());
        prevChain.forEach(function (n) { hoverDirty.add(n); }); newChain.forEach(function (n) { hoverDirty.add(n); });
      }
    }
    // a target removed by a boundary event listener: the move goes to its nearest connected ancestor
    if (el && !el.isConnected) { var chain = pointer.overChain || []; var alt = null; for (var ci = 0; ci < chain.length && !alt; ci++) if (chain[ci].isConnected) alt = chain[ci]; el = alt || elementAt(x, y); }
    if (el && !noMove) { fire(el, PointerEvent, "pointermove", pointerInit(params)); fire(el, MouseEvent, "mousemove", mouseInit()); }
    return el;
  };
  // mousedown's default action: focus the nearest focusable flat-tree ancestor, or blur.
  var focusFromPointer = function (el) {
    __jb.currentDocument._focusStartingPoint = el;
    for (var f = el; f; f = flatParent(f)) {
      if (f.nodeType === 11) continue;
      if (f.nodeType !== 1) break;
      if (typeof __jb.isFocusable === "function" ? __jb.isFocusable(f) : (f.tabIndex >= 0)) { if (__jb.currentDocument.activeElement !== f) f.focus(); return; }
    }
    var a = __jb.currentDocument.activeElement;
    if (a && a !== __jb.currentDocument.body && typeof a.blur === "function") a.blur();
  };
  U.press = function (button, params, target) {
    button = button || 0;
    if (!pointer.over || !pointer.over.isConnected) U.movePointer(pointer.x, pointer.y, params, true, target);
    var el = target || pointer.over || elementAt(pointer.x, pointer.y);
    pointer.buttons |= button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : 0;
    pointer.downTarget = el;
    __jb.lastInputPointer = true;
    __jb.activeChain = ancestorsOf(el);
    var goOn = fire(el, PointerEvent, "pointerdown", pointerInit(params, { button: button }));
    var md = goOn ? fire(el, MouseEvent, "mousedown", mouseInit({ button: button, detail: 1 })) : true;
    if (goOn && md && button === 0) focusFromPointer(el);
    if (button === 2) fire(el, PointerEvent, "contextmenu", pointerInit(params, { button: 2 }));
    return el;
  };
  U.release = function (button, params, target) {
    button = button || 0;
    if (!pointer.over || !pointer.over.isConnected) U.movePointer(pointer.x, pointer.y, params, true, target);
    var el = target || pointer.over || elementAt(pointer.x, pointer.y);
    pointer.buttons &= ~(button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : 0);
    fire(el, PointerEvent, "pointerup", pointerInit(params, { button: button }));
    fire(el, MouseEvent, "mouseup", mouseInit({ button: button, detail: 1 }));
    __jb.activeChain = null;
    var clicked = null;
    if (pointer.downTarget) {
      var common = el;
      while (common && !(common === pointer.downTarget || (common.contains && common.contains(pointer.downTarget)))) common = flatParent(common);
      if (common && common.nodeType === 1) {
        var now = Date.now(); pointer.clicks = pointer.lastClick && now - pointer.lastClick < 500 ? pointer.clicks + 1 : 1; pointer.lastClick = now;
        if (button === 0) { fire(common, PointerEvent, "click", pointerInit(params, { button: 0, detail: pointer.clicks })); if (pointer.clicks === 2) fire(common, MouseEvent, "dblclick", mouseInit({ button: 0, detail: 2 })); }
        else fire(common, PointerEvent, "auxclick", pointerInit(params, { button: button, detail: pointer.clicks }));
        clicked = common;
      }
    }
    pointer.downTarget = null;
    return clicked;
  };

  // whether the point c (el's centre) lies outside a clipping ancestor of el
  var clippedByPane = function (el, c) {
    var d = doc();
    for (var a = flatParent(el); a && a !== d.body && a !== d.documentElement && a.nodeType !== 9; a = flatParent(a)) {
      if (a.nodeType !== 1) continue;
      var cs = getComputedStyle(a);
      if (!/(auto|scroll|hidden|overlay)/.test(cs.overflowY + " " + cs.overflowX)) continue;
      var r = a.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (c.y < r.top || c.y > r.bottom || c.x < r.left || c.x > r.right) return true;
    }
    return false;
  };
  U.scrollIntoView = function (el) {
    try {
      var c = centerOf(el);
      if (c.empty || typeof el.scrollIntoView !== "function") return;
      if (c.y < 0 || c.y > globalThis.innerHeight || c.x < 0 || c.x > globalThis.innerWidth) el.scrollIntoView({ block: "center", inline: "center" });
      else if (clippedByPane(el, c)) el.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch (e) {}
  };
  // The event target for a pointer at el's center: the hit element when it is el or inside it,
  // otherwise el itself (an agent means the element it named, even under an overlay).
  var targetFor = function (el) {
    U.scrollIntoView(el);
    var c = centerOf(el);
    if (c.empty) return { el: el, x: 0, y: 0 };
    var hit = elementAt(c.x, c.y);
    var inside = false; for (var n = hit; n; n = flatParent(n)) if (n === el) { inside = true; break; }
    return { el: inside ? hit : el, x: c.x, y: c.y };
  };
  U.hover = function (el) { var t = targetFor(el); U.movePointer(t.x, t.y, null, false, t.el); return t.el; };
  U.click = function (el, opts) {
    opts = opts || {};
    var t = targetFor(el), button = opts.button || 0, n = opts.count || 1;
    U.movePointer(t.x, t.y, null, false, t.el);
    for (var i = 0; i < n; i++) { U.press(button, null, t.el); U.release(button, null, t.el); }
    return true;
  };
  U.dblclick = function (el) { pointer.lastClick = 0; return U.click(el, { count: 2 }); };

  // ---- keyboard
  var modifiers = U.modifiers = { shift: false, ctrl: false, alt: false, meta: false };
  U.modifierInit = function () { return { shiftKey: modifiers.shift, ctrlKey: modifiers.ctrl, altKey: modifiers.alt, metaKey: modifiers.meta }; };
  var NAMED = { Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46, Meta: 91, F1: 112, F5: 116 };
  var ALIASES = { enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape", backspace: "Backspace", delete: "Delete", del: "Delete", space: " ", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", shift: "Shift", control: "Control", ctrl: "Control", alt: "Alt", meta: "Meta", cmd: "Meta" };
  U.normalizeKey = function (k) { k = String(k); if (k.length === 1) return k; return ALIASES[k.toLowerCase()] || k; };
  var keyInit = U.keyInit = function (key) {
    var printable = key.length === 1;
    var code = NAMED[key] !== undefined ? NAMED[key] : (printable ? key.toUpperCase().charCodeAt(0) : 0);
    var codeName = printable ? (/[a-z]/i.test(key) ? "Key" + key.toUpperCase() : /[0-9]/.test(key) ? "Digit" + key : key === " " ? "Space" : key === "\n" ? "Enter" : "") : (key === "Shift" ? "ShiftLeft" : key === "Control" ? "ControlLeft" : key === "Alt" ? "AltLeft" : key === "Meta" ? "MetaLeft" : key);
    return Object.assign({ key: key, code: codeName, keyCode: code, which: code, charCode: printable ? key.charCodeAt(0) : 0 }, U.modifierInit());
  };
  var isTextField = function (t) { return t && t.nodeType === 1 && ((t._tag === "input" && /^(text|search|url|tel|email|password|number|date|month|week|time|datetime-local)$/.test(__jb.inputType(t))) || t._tag === "textarea"); };
  var isEditable = function (t) { return isTextField(t) || (t && t.isContentEditable); };
  // Value changes go through the prototype setter, as editing does: an instance-level `value`
  // property (React's value tracker) must not see them.
  var nativeValueSetter = function (el) { for (var p = Object.getPrototypeOf(el); p; p = Object.getPrototypeOf(p)) { var d = Object.getOwnPropertyDescriptor(p, "value"); if (d && d.set) return d.set; } return null; };
  U.setNativeValue = function (el, v) { var set = nativeValueSetter(el); if (set) set.call(el, v); else el.value = v; el._userEdited = true; if (el._tag === "input" || el._tag === "textarea") el._dirtyValue = true; };
  var selection = function (t) { var v = t.value || "", s = v.length, e = v.length; try { if (typeof t.selectionStart === "number") { s = t.selectionStart; e = t.selectionEnd; } } catch (x) {} return [v, s, e]; };
  var setCaret = function (t, pos) { try { t.setSelectionRange(pos, pos); } catch (e) {} };
  var editTextField = function (t, inputType, data) {
    var sv = selection(t), v = sv[0], s = sv[1], e = sv[2], nv, caret;
    if (inputType === "deleteContentBackward") { if (s === e && s > 0) s -= 1; nv = v.slice(0, s) + v.slice(e); caret = s; }
    else if (inputType === "deleteContentForward") { if (s === e && e < v.length) e += 1; nv = v.slice(0, s) + v.slice(e); caret = s; }
    else { if ((t._tag === "textarea" || (t._tag === "input" && /^(text|search|url|tel|email|password)$/.test(__jb.inputType(t)))) && t.maxLength >= 0 && v.length - (e - s) + data.length > t.maxLength) data = data.slice(0, Math.max(0, t.maxLength - (v.length - (e - s)))); nv = v.slice(0, s) + data + v.slice(e); caret = s + data.length; }
    U.setNativeValue(t, nv); setCaret(t, caret);
  };
  // contenteditable: the editing commands (67_editing.js) at the selection; a selection outside
  // the editing host first moves to its end
  var EDIT_COMMANDS = { insertText: "inserttext", deleteContentBackward: "delete", deleteContentForward: "forwarddelete",
    insertParagraph: "insertparagraph", insertLineBreak: "insertlinebreak", formatBold: "bold", formatItalic: "italic", formatUnderline: "underline" };
  var editContent = function (t, inputType, data) {
    var sel = globalThis.getSelection ? globalThis.getSelection() : null;
    var cmd = EDIT_COMMANDS[inputType];
    if (cmd && __jb.editing && sel) {
      try {
        var inside = sel.rangeCount && t.contains(sel.getRangeAt(0).startContainer) && t.contains(sel.getRangeAt(0).endContainer);
        if (!inside) { var r = __jb.currentDocument.createRange(); r.selectNodeContents(t); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
        if (__jb.editing.exec(cmd, false, cmd === "inserttext" ? String(data) : "") === true) return;
      } catch (e) {}
    }
    if (inputType === "deleteContentBackward") { var txt = t.lastChild; while (txt && txt.nodeType !== 3) txt = txt.lastChild; if (txt && txt.data.length) txt.data = txt.data.slice(0, -1); return; }
    var last = t.lastChild;
    if (inputType === "insertParagraph" || inputType === "insertLineBreak") { t.appendChild(__jb.currentDocument.createElement("br")); return; }
    if (last && last.nodeType === 3) last.data += data; else t.appendChild(__jb.currentDocument.createTextNode(data));
    try { if (sel) { var tn = t.lastChild; sel.collapse(tn, tn.nodeType === 3 ? tn.data.length : 0); } } catch (e) {}
  };
  // beforeinput's getTargetRanges() in rich text: the selection, or for a collapsed caret the
  // character (or block boundary) a deletion removes
  var textLeaves = function (host) { var out = []; (function walk(n) { for (var c = n.firstChild; c; c = c.nextSibling) { if (c.nodeType === 3) { if (c.data.length) out.push(c); } else if (c.nodeType === 1) walk(c); } })(host); return out; };
  var targetRangesFor = function (t, inputType) {
    if (isTextField(t) || !t.isContentEditable) return [];
    var sel = globalThis.getSelection ? globalThis.getSelection() : null;
    if (!sel || !sel.rangeCount) return [];
    var r = sel.getRangeAt(0);
    if (!t.contains(r.startContainer) || !t.contains(r.endContainer)) return [];
    var sr = function (sc, so, ec, eo) { return new StaticRange({ startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo }); };
    if (!r.collapsed) { var nr = shrinkToLeaves(t, r); return [sr(nr[0], nr[1], nr[2], nr[3])]; }
    var c = r.startContainer, o = r.startOffset;
    if (inputType === "deleteContentBackward" || inputType === "deleteContentForward") {
      // the only, empty item of a list: the list goes
      var li = c.nodeType === 1 ? c : c.parentNode;
      while (li && li !== t && li._tag !== "li") li = li.parentNode;
      if (li && li !== t && li.parentNode && /^(ol|ul)$/.test(li.parentNode._tag || "") && li.parentNode.children.length === 1 && li.textContent === "" && !li.querySelector("img,input,hr")) {
        var list = li.parentNode, lp = list.parentNode, lix = Array.prototype.indexOf.call(lp.childNodes, list);
        return [sr(lp, lix, lp, lix + 1)];
      }
      var rr = caretDeletionRange(t, c, o, inputType === "deleteContentBackward");
      return [rr ? sr(rr[0], rr[1], rr[2], rr[3]) : sr(c, o, c, o)];
    }
    return [sr(c, o, c, o)];
  };
  // A non-collapsed deletion range as Gecko reports it: its boundaries moved into the first / last
  // leaf it covers (text offsets; an atomic element's start is inside it; a non-editable element is
  // kept whole).
  var shrinkToLeaves = function (host, r) {
    var sc = r.startContainer, so = r.startOffset, ec = r.endContainer, eo = r.endOffset;
    var editableEl = function (n) { return n.nodeType !== 1 || n.isContentEditable; };
    for (var guard = 0; guard < 100 && sc.nodeType === 1 && so < sc.childNodes.length; guard++) {
      var ch = sc.childNodes[so];
      if (ch.nodeType === 3) { sc = ch; so = 0; break; }
      if (ch.nodeType !== 1) break;
      if (!editableEl(ch)) break;
      if (!ch.firstChild) { if (ATOMIC.test(ch._tag || "")) { sc = ch; so = 0; } break; }
      sc = ch; so = 0;
    }
    for (var guard2 = 0; guard2 < 100 && ec.nodeType === 1 && eo > 0; guard2++) {
      var ch2 = ec.childNodes[eo - 1];
      if (!ch2) break;
      if (ch2.nodeType === 3) { ec = ch2; eo = ch2.data.length; break; }
      if (ch2.nodeType !== 1 || !editableEl(ch2) || !ch2.firstChild) break;
      ec = ch2; eo = ch2.childNodes.length;
    }
    return [sc, so, ec, eo];
  };
  // What a Backspace / Delete at a collapsed caret removes, as [startNode, startOffset, endNode,
  // endOffset] (Gecko's ranges): the previous / next visible character (a surrogate pair) with the
  // collapsible white-space around it that would stay invisible, widened to an inline element it
  // empties; an atomic inline (<br>, <img>) as a whole; at a block boundary, from the last visible
  // point of one block (before an invisible trailing <br>) to the first visible point of the other.
  var BLOCKS = /^(address|article|aside|blockquote|center|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|li|listing|main|menu|nav|ol|p|plaintext|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul|xmp|body)$/;
  var ATOMIC = /^(br|img|input|video|audio|canvas|iframe|embed|object|meter|progress|select|textarea|button|hr|wbr)$/;
  var blockOf = function (host, n) { for (var e = n.nodeType === 1 ? n : n.parentNode; e && e !== host; e = e.parentNode) if (e.nodeType === 1 && BLOCKS.test(e._tag || "")) return e; return host; };
  var editLeaves = function (host) { var out = []; (function walk(n) { for (var c = n.firstChild; c; c = c.nextSibling) { if (c.nodeType === 3) { if (c.data.length) out.push(c); } else if (c.nodeType === 1) { if (ATOMIC.test(c._tag || "") && !BLOCKS.test(c._tag || "")) out.push(c); else if (c._tag === "hr") out.push(c); else walk(c); } } })(host); return out; };
  // "pre" (all white-space kept), "pre-line" (spaces collapse, line feeds kept) or "normal"
  var wsMode = function (n) {
    for (var e = n.nodeType === 1 ? n : n.parentNode; e && e.nodeType === 1; e = e.parentNode) {
      var v = e.style && e.style.whiteSpace;
      if (!v) { try { var cs = getComputedStyle(e).whiteSpace; if (cs && cs !== "normal") v = cs; } catch (x) {} }
      if (!v && /^(pre|listing|xmp|plaintext|textarea)$/.test(e._tag || "")) v = "pre";
      if (v) return /^(pre|pre-wrap|break-spaces)$/.test(v) ? "pre" : v === "pre-line" ? "pre-line" : "normal";
      if (BLOCKS.test(e._tag || "") && e.isContentEditable && !(e.parentElement && e.parentElement.isContentEditable)) break;
    }
    return "normal";
  };
  var isSp = function (ch, mode) { return mode !== "pre" && (ch === " " || ch === "\t" || (mode === "normal" && (ch === "\n" || ch === "\r"))); };
  var isBreak = function (ch, mode) { return mode !== "normal" && ch === "\n"; };
  // whether character i of text node t is rendered (within the node; node edges count as the
  // block's edges when the node is first / last in its block)
  var charVisible = function (t, i, first, last) {
    var d = t.data, mode = wsMode(t), ch = d[i];
    if (!isSp(ch, mode)) return true;
    if (i === 0 ? first : (isSp(d[i - 1], mode) || isBreak(d[i - 1], mode))) return false;
    for (var j = i + 1; j < d.length; j++) { if (isBreak(d[j], mode)) return false; if (!isSp(d[j], mode)) return true; }
    return !last;
  };
  var caretDeletionRange = function (host, c, o, back) {
    var leaves = editLeaves(host);
    var idxOf = function (n) { return Array.prototype.indexOf.call(n.parentNode.childNodes, n); };
    // the caret as a position next to a leaf
    var at = null; // {leaf, off} for a text leaf, {before: leaf} / {after: leaf} for elements
    if (c.nodeType === 3) at = { leaf: c, off: o };
    else {
      var ref = c.childNodes[o] || null;
      var after = leaves.filter(function (lf) { return ref ? (ref === lf || ref.contains(lf) || (ref.compareDocumentPosition(lf) & 4)) : false; })[0];
      var before = leaves.filter(function (lf) { return ref ? (lf.compareDocumentPosition(ref) & 4) && !ref.contains(lf) : c.contains(lf) || (c.compareDocumentPosition(lf) & 2); }).pop();
      at = back ? (before ? (before.nodeType === 3 ? { leaf: before, off: before.data.length } : { after: before }) : null) : (after ? (after.nodeType === 3 ? { leaf: after, off: 0 } : { before: after }) : null);
      if (at && at.leaf && blockOf(host, at.leaf) !== blockOf(host, ref || c)) at = null;
      if (!at) return null;
    }
    var cur = at.leaf || at.after || at.before;
    var blk = blockOf(host, cur);
    var inBlock = leaves.filter(function (lf) { return blockOf(host, lf) === blk; });
    var k = inBlock.indexOf(cur);
    var firstOf = function (lf) { var b = inBlock.length ? inBlock : [lf]; return lf === b[0]; };
    // the nearest visible unit before / after the caret within the block
    var findPrev = function () {
      var start = at.leaf ? k : (at.after ? k + 1 : k);
      var fromOff = at.leaf ? at.off : null;
      for (var j = start; j >= 0; j--) {
        var lf = inBlock[j]; if (!lf) continue;
        if (lf.nodeType === 3) {
          var lim = j === k && fromOff !== null ? fromOff : lf.data.length;
          for (var i = lim - 1; i >= 0; i--) if (charVisible(lf, i, j === 0, j === inBlock.length - 1)) return { leaf: lf, i: i };
        } else if (!(j === k && at.before)) {
          if (lf._tag === "br" && j === inBlock.length - 1 && j > 0) continue; // invisible trailing <br>
          return { el: lf };
        }
      }
      return null;
    };
    var findNext = function () {
      var start = at.leaf ? k : (at.before ? k : k + 1);
      var fromOff = at.leaf ? at.off : null;
      for (var j = start; j < inBlock.length; j++) {
        var lf = inBlock[j];
        if (lf.nodeType === 3) {
          var from = j === k && fromOff !== null ? fromOff : 0;
          for (var i = from; i < lf.data.length; i++) if (charVisible(lf, i, j === 0, j === inBlock.length - 1)) return { leaf: lf, i: i };
        } else if (!(j === k && at.after)) {
          if (lf._tag === "br" && j === inBlock.length - 1) return null; // invisible trailing <br>
          return { el: lf };
        }
      }
      return null;
    };
    var caretPoint = function () { return at.leaf ? [at.leaf, at.off] : [c, o]; };
    var lastPointOf = function (lfs) { // end of a block's visible content: before an invisible trailing <br>
      var last = lfs[lfs.length - 1]; if (!last) return null;
      if (last.nodeType === 1 && last._tag === "br") return [last.parentNode, idxOf(last)];
      if (last.nodeType === 1) return [last.parentNode, idxOf(last) + 1];
      var e = last.data.length; while (e > 0 && !charVisible(last, e - 1, lfs.length === 1, true)) e--;
      return [last, e];
    };
    var firstPointOf = function (lfs) {
      var first = lfs[0]; if (!first) return null;
      if (first.nodeType === 1) return [first.parentNode, idxOf(first)];
      var s0 = 0; while (s0 < first.data.length && !charVisible(first, s0, true, lfs.length === 1)) s0++;
      return [first, s0];
    };
    var hit = back ? findPrev() : findNext();
    if (!hit) {
      // join with the neighbouring block
      var others = leaves.filter(function (lf) { return blockOf(host, lf) !== blk && (back ? (lf.compareDocumentPosition(cur) & 4) : (cur.compareDocumentPosition(lf) & 4)); });
      if (!others.length) return null;
      var nb = blockOf(host, back ? others[others.length - 1] : others[0]);
      var nbLeaves = leaves.filter(function (lf) { return blockOf(host, lf) === nb; });
      if (back) { var a = lastPointOf(nbLeaves), b2 = inBlock.length ? firstPointOf(inBlock) : caretPoint(); return a && b2 ? [a[0], a[1], b2[0], b2[1]] : null; }
      var a2 = inBlock.length ? lastPointOf(inBlock) : caretPoint(), b3 = firstPointOf(nbLeaves); return a2 && b3 ? [a2[0], a2[1], b3[0], b3[1]] : null;
    }
    if (hit.el) { var pe = hit.el.parentNode, ie = idxOf(hit.el); return [pe, ie, pe, ie + 1]; }
    var tn = hit.leaf, d = tn.data, si = hit.i, ei = hit.i + 1;
    var code = d.charCodeAt(si);
    if (code >= 0xdc00 && code <= 0xdfff && si > 0) si--; else if (code >= 0xd800 && code <= 0xdbff && ei < d.length) ei++;
    var fi = inBlock.indexOf(tn), isFirst = fi === 0, isLast = fi === inBlock.length - 1;
    // invisible white-space next to the deleted character goes with it
    while (si > 0 && !charVisible(tn, si - 1, isFirst, isLast)) si--;
    if (tn === (at.leaf || null)) { if (back) ei = Math.max(ei, at.off); else si = Math.min(si, at.off); }
    while (ei < d.length && !charVisible(tn, ei, isFirst, isLast) && (!back || tn !== at.leaf || ei < at.off)) ei++;
    if (!back && tn === at.leaf) { while (ei < d.length && !charVisible(tn, ei, isFirst, isLast)) ei++; }
    // a deletion that empties a text node inside inline elements removes the outermost such element
    if (si === 0 && ei === d.length) {
      var el = null;
      for (var pp = tn.parentNode; pp && pp !== host && pp !== blk && pp.childNodes.length === 1; pp = pp.parentNode) el = pp;
      if (el) {
        var par = el.parentNode, ix = idxOf(el), inside = el.contains(c);
        var cp = caretPoint();
        if (back) return [par, ix, inside ? par : cp[0], inside ? ix + 1 : cp[1]];
        return [inside ? par : cp[0], inside ? ix : cp[1], par, ix + 1];
      }
    }
    if (tn !== at.leaf) { var cp2 = caretPoint(); return back ? [tn, si, cp2[0], cp2[1]] : [cp2[0], cp2[1], tn, ei]; }
    return [tn, si, tn, ei];
  };
  // beforeinput -> edit -> input
  U.edit = function (t, inputType, data) {
    var init = { inputType: inputType, data: data === undefined ? null : data };
    var ranges = targetRangesFor(t, inputType);
    if (!fire(t, InputEvent, "beforeinput", Object.assign({ cancelable: true, targetRanges: ranges }, init))) return false;
    if (isTextField(t)) editTextField(t, inputType, data || ""); else editContent(t, inputType, data || "");
    fire(t, InputEvent, "input", Object.assign({ cancelable: false }, init));
    return true;
  };
  U.deepActive = function () { var a = __jb.currentDocument.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a; };
  var activeTarget = function () { var a = __jb.currentDocument.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a || __jb.currentDocument.body || __jb.currentDocument.documentElement; };
  // The focused frame's user layer when the focus is inside an <iframe> (as in a browser, keys then
  // go to the frame document's focused element, not to the frame element in this document).
  U.focusedFrameUser = function () {
    var a = __jb.currentDocument.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    if (!a || (a.localName !== "iframe" && a.localName !== "frame")) return null;
    var fu = null;
    try { var w = a._contentWindow; fu = w && w.__jb && w.document ? w.__jb.user : null; } catch (e) { fu = null; }
    return fu && fu !== U ? fu : null;
  };
  U.keyDown = function (key) {
    var fu = U.focusedFrameUser();
    if (fu) return fu.keyDown(key);
    __jb.native("taskStart");
    key = U.normalizeKey(key);
    if (key === "Shift") modifiers.shift = true; else if (key === "Control") modifiers.ctrl = true; else if (key === "Alt") modifiers.alt = true; else if (key === "Meta") modifiers.meta = true;
    __jb.lastInputPointer = false;
    var target = activeTarget();
    var init = keyInit(key), printable = key.length === 1;
    var goOn = fire(target, KeyboardEvent, "keydown", init);
    if (goOn && (printable || key === "Enter") && !modifiers.ctrl && !modifiers.meta) goOn = fire(target, KeyboardEvent, "keypress", Object.assign({}, init, key === "Enter" ? { charCode: 13 } : {}));
    if (!goOn) return false;
    if (key === "Tab") { if (typeof __jb.moveFocus === "function") __jb.moveFocus(modifiers.shift ? -1 : 1); return true; }
    // Ctrl/Cmd+C/X/V: clipboard commands (copy/cut/paste events and their default actions)
    if ((modifiers.ctrl || modifiers.meta) && !modifiers.alt && /^[cxv]$/i.test(key) && __jb.clipboardCommand) {
      __jb.clipboardCommand({ c: "copy", x: "cut", v: "paste" }[key.toLowerCase()], target.ownerDocument || __jb.currentDocument);
      return true;
    }
    // Ctrl/Cmd+B/I/U format rich text
    if (target.isContentEditable && (modifiers.ctrl || modifiers.meta) && /^[biu]$/i.test(key)) {
      U.edit(target, { b: "formatBold", i: "formatItalic", u: "formatUnderline" }[key.toLowerCase()]);
      return true;
    }
    if (isEditable(target) && !modifiers.ctrl && !modifiers.meta && !target.readOnly && !target.disabled) {
      if (printable) U.edit(target, "insertText", key);
      else if (key === "Backspace") U.edit(target, "deleteContentBackward");
      else if (key === "Delete") U.edit(target, "deleteContentForward");
      else if (key === "Enter" && (target._tag === "textarea" || target.isContentEditable)) U.edit(target, target._tag === "textarea" || modifiers.shift ? "insertLineBreak" : "insertParagraph", target._tag === "textarea" ? "\n" : null);
      else if (key === "Enter" && target._tag === "input") U.implicitSubmit(target);
      else if ((key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End") && isTextField(target)) { var sv = selection(target); var p = key === "Home" ? 0 : key === "End" ? sv[0].length : Math.max(0, Math.min(sv[0].length, sv[1] + (key === "ArrowLeft" ? -1 : 1))); setCaret(target, p); }
      return true;
    }
    if (target.nodeType === 1 && target._ns === __jb.HTML_NS) {
      if (key === "Enter" && (target._tag === "a" || target._tag === "button" || target._tag === "summary" || (target._tag === "input" && /^(submit|reset|button|image)$/.test(__jb.inputType(target))))) fire(target, PointerEvent, "click", pointerInit(null, { detail: 0, pointerId: -1, pointerType: "", clientX: 0, clientY: 0, screenX: 0, screenY: 0 }));
      else if (key === "Enter" && target._tag === "input") U.implicitSubmit(target);
      else if (key === " " && target._tag === "input" && /^(checkbox|radio)$/.test(__jb.inputType(target))) fire(target, PointerEvent, "click", pointerInit(null, { detail: 0, pointerId: -1, pointerType: "", clientX: 0, clientY: 0, screenX: 0, screenY: 0 }));
      else if (target._tag === "select" && /^Arrow(Up|Down)$/.test(key)) { var opts = __jb.arrayFrom(target.options).filter(function (o) { return !o.disabled; }), cur = opts.indexOf(target.selectedOptions[0]); var nx = opts[Math.max(0, Math.min(opts.length - 1, cur + (key === "ArrowDown" ? 1 : -1)))]; if (nx && !nx.selected) { nx.selected = true; fire(target, Event, "input", { bubbles: true, composed: true }); fire(target, Event, "change", { bubbles: true }); } }
      else if (target._tag === "input" && __jb.inputType(target) === "range" && !target.disabled && /^(Arrow(Up|Down|Left|Right)|PageUp|PageDown|Home|End)$/.test(key)) {
        // slider keys: one step, a tenth of the range, or an end
        var rmin = isFinite(parseFloat(target.min)) ? parseFloat(target.min) : 0, rmax = isFinite(parseFloat(target.max)) ? parseFloat(target.max) : 100;
        var rst = parseFloat(target.step) > 0 ? parseFloat(target.step) : 1, rcur = parseFloat(target.value), rwas = target.value;
        var rv = key === "Home" ? rmin : key === "End" ? rmax : /^Arrow(Up|Right)$/.test(key) ? rcur + rst : /^Arrow(Down|Left)$/.test(key) ? rcur - rst : rcur + (key === "PageUp" ? 1 : -1) * Math.max(rst, (rmax - rmin) / 10);
        U.setNativeValue(target, String(Math.max(rmin, Math.min(rmax, rv))));
        if (target.value !== rwas) { fire(target, Event, "input", { bubbles: true, composed: true }); fire(target, Event, "change", { bubbles: true }); }
      }
      else if (/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/.test(key)) {
        var dy = { ArrowUp: -40, ArrowDown: 40, PageUp: -globalThis.innerHeight * 0.875, PageDown: globalThis.innerHeight * 0.875, " ": globalThis.innerHeight * 0.875 }[key];
        if (key === "Home") globalThis.scrollTo(globalThis.scrollX, 0); else if (key === "End") globalThis.scrollTo(globalThis.scrollX, 1e9); else globalThis.scrollBy(0, dy);
      }
    }
    return true;
  };
  U.keyUp = function (key) {
    var fu = U.focusedFrameUser();
    if (fu) return fu.keyUp(key);
    key = U.normalizeKey(key);
    var target = activeTarget();
    fire(target, KeyboardEvent, "keyup", keyInit(key));
    if (key === " " && target.nodeType === 1 && (target._tag === "button" || (target._tag === "input" && /^(submit|reset|button)$/.test(__jb.inputType(target))))) fire(target, PointerEvent, "click", pointerInit(null, { detail: 0, pointerId: -1, pointerType: "", clientX: 0, clientY: 0, screenX: 0, screenY: 0 }));
    if (key === "Shift") modifiers.shift = false; else if (key === "Control") modifiers.ctrl = false; else if (key === "Alt") modifiers.alt = false; else if (key === "Meta") modifiers.meta = false;
  };
  // "implicit submission": the form's default button is clicked, or the form submitted when allowed.
  U.implicitSubmit = function (input) {
    var form = input.form; if (!form) return;
    var els = __jb.arrayFrom(form.elements);
    var def = els.filter(function (e) { return (e._tag === "button" && (e.type === "submit")) || (e._tag === "input" && /^(submit|image)$/.test(__jb.inputType(e))); })[0];
    if (def) { if (!__jb.isDisabled(def)) fire(def, PointerEvent, "click", pointerInit(null, { detail: 0, pointerId: -1, pointerType: "", clientX: 0, clientY: 0, screenX: 0, screenY: 0 })); return; }
    var blocking = els.filter(function (e) { return e._tag === "input" && /^(text|search|url|tel|email|password|date|month|week|time|datetime-local|number)$/.test(__jb.inputType(e)); });
    if (blocking.length > 1) return;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
  };
  // press("Enter"), press("Control+a")
  U.pressKey = function (combo, el) {
    if (el && typeof el.focus === "function" && __jb.currentDocument.activeElement !== el) el.focus();
    var fu = U.focusedFrameUser();
    if (fu) return fu.pressKey(combo, null);
    var parts = String(combo).split("+").filter(function (p) { return p !== ""; });
    if (String(combo) === "+" || /\+\+$/.test(String(combo))) parts.push("+");
    var mods = parts.slice(0, -1).map(U.normalizeKey), key = U.normalizeKey(parts[parts.length - 1]);
    mods.forEach(U.keyDown);
    if (mods.indexOf("Control") >= 0 || mods.indexOf("Meta") >= 0) {
      var t = activeTarget();
      if (key.toLowerCase() === "a" && isTextField(t)) { if (U.keyDownOnly(key)) { try { t.select(); } catch (e) {} } U.keyUp(key); mods.reverse().forEach(U.keyUp); return; }
    }
    U.keyDown(key); U.keyUp(key);
    mods.reverse().forEach(U.keyUp);
  };
  U.keyDownOnly = function (key) { var fu = U.focusedFrameUser(); if (fu) return fu.keyDownOnly(key); return fire(activeTarget(), KeyboardEvent, "keydown", keyInit(key)); };

  // Focus, (optionally) clear, type each character, then commit (change) when asked.
  U.focus = function (el) {
    if (__jb.currentDocument.activeElement === el) return;
    var t = targetFor(el);
    if (t.x || t.y) { U.movePointer(t.x, t.y, null, false, t.el); U.press(0, null, t.el); U.release(0, null, t.el); }
    if (__jb.currentDocument.activeElement !== el && typeof el.focus === "function") el.focus();
  };
  U.clear = function (el) {
    U.focus(el);
    if (isTextField(el)) {
      if (el.value === "") return;
      var was = el.value;
      U.pressKey("Control+a", el);
      U.keyDown("Backspace"); U.keyUp("Backspace");
      if (el.value === was) { try { el.select(); } catch (e) {} U.edit(el, "deleteContentBackward"); }
    }
    else if (el.isContentEditable) { el.textContent = ""; fire(el, InputEvent, "input", { inputType: "deleteContentBackward", cancelable: false }); }
  };
  U.type = function (el, text, opts) {
    opts = opts || {};
    // range/color and the date family take a whole value (a date picker types segments, never one
    // character at a time: "1" alone sanitizes to "" and the field stays empty)
    if (el && el._tag === "input" && /^(range|color|date|month|week|time|datetime-local)$/.test(__jb.inputType(el))) {
      U.focus(el);
      var was = el.value;
      U.setNativeValue(el, dateLike(__jb.inputType(el), String(text).trim()));
      if (el.value !== was) {
        fire(el, Event, "input", { bubbles: true, composed: true });
        fire(el, Event, "change", { bubbles: true, cancelable: false, composed: false });
      }
      return el.value;
    }
    var cleared = opts.clear !== false && isEditable(el);
    if (cleared) U.clear(el); else U.focus(el);
    // a cleared field the page refilled (a mask): type where the page put the caret
    if (isTextField(el) && !(cleared && el.value)) { var len = (el.value || "").length; setCaret(el, len); }
    var before = isTextField(el) ? el.value : null;
    __jb.arrayFrom(String(text)).forEach(function (ch) { var k = ch === "\n" ? "Enter" : ch === "\t" ? "Tab" : ch; U.keyDown(k); U.keyUp(k); });
    // Commit: change fires when the value differs from the one at focus (on blur in a browser).
    if (opts.commit !== false && isTextField(el) && el.isConnected && el.value !== before) U.commit(el);
    return isTextField(el) ? el.value : el.textContent;
  };
  // "01/15/1990", "15.01.1990", "1/15/1990 3:30 PM" -> the ISO form the input accepts (US order unless the first part > 12)
  function dateLike(type, s) {
    var m, pad = function (n) { return (n < 10 ? "0" : "") + +n; };
    if (type === "date" || type === "datetime-local") {
      m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})(?:[ T,]+(\d{1,2}):(\d{2})\s*([ap]m)?)?$/i.exec(s);
      if (m) {
        var mo = +m[1], d = +m[2];
        if (mo > 12) { var x = mo; mo = d; d = x; }
        var out = m[3] + "-" + pad(mo) + "-" + pad(d);
        if (type === "date") return out;
        var h = +(m[4] || 0); if (m[6]) h = h % 12 + (/p/i.test(m[6]) ? 12 : 0);
        return out + "T" + pad(h) + ":" + (m[5] || "00");
      }
      if (type === "datetime-local" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return s.replace(" ", "T");
    }
    if (type === "time" && (m = /^(\d{1,2}):(\d{2})\s*([ap]m)$/i.exec(s))) return pad(+m[1] % 12 + (/p/i.test(m[3]) ? 12 : 0)) + ":" + m[2];
    if (type === "month" && (m = /^(\d{1,2})[\/.\-](\d{4})$/.exec(s))) return m[2] + "-" + pad(m[1]);
    return s;
  }
  U.commit = function (el) { fire(el, Event, "change", { bubbles: true, composed: false }); el._changeCommitted = el.value; };
  U.select = function (el, wanted) {
    if (!el || el._tag !== "select") return false;
    var list = Array.isArray(wanted) ? wanted.map(String) : [String(wanted)];
    var opts = __jb.arrayFrom(el.options), hit = false;
    U.focus(el);
    opts.forEach(function (o) {
      var match = list.indexOf(o.value) >= 0 || list.indexOf(o.label) >= 0 || list.indexOf((o.textContent || "").trim()) >= 0;
      if (match && (el.multiple || !hit)) { hit = true; o.selected = true; } else if (el.multiple) o.selected = false;
    });
    if (!hit) return false;
    fire(el, Event, "input", { bubbles: true, composed: true });
    fire(el, Event, "change", { bubbles: true });
    return true;
  };
  U.setChecked = function (el, want) {
    if (!el || el._tag !== "input" || !/^(checkbox|radio)$/.test(__jb.inputType(el))) return false;
    if (!!el.checked === !!want) return true;
    U.click(el);
    return !!el.checked === !!want;
  };

  // Element lookup: a CSS selector (shadow roots searched too), "text=..." or a jb id.
  U.find = function (spec, root) {
    if (spec && typeof spec === "object" && spec.nodeType) return spec;
    if (typeof spec === "number") return __jb.nodeById ? __jb.nodeById[spec] || null : null;
    spec = String(spec);
    // @N / @eN: an element numbered by the last annotated screenshot (U.annotate)
    var ref = /^@e?(\d+)$/i.exec(spec.trim());
    if (ref) { var refEl = __jb.userRefs && __jb.userRefs[+ref[1]]; return refEl && refEl.isConnected ? refEl : null; }
    root = root || __jb.currentDocument;
    // A list mixing CSS selectors and text= targets ("button.track, text=Track"): first part that matches.
    if (/(^|,)\s*text=/i.test(spec) && spec.indexOf(",") >= 0 && !/^\s*text=/i.test(spec)) {
      var parts = __jb.splitSelectorList(spec);
      if (parts.length > 1) { for (var pi = 0; pi < parts.length; pi++) { var hit = null; try { hit = U.find(parts[pi], root); } catch (eP) { hit = null; } if (hit) return hit; } return null; }
    }
    var all = function (r, pred) { var out = []; (function walk(n) { for (var c = n.firstChild; c; c = c.nextSibling) { if (c.nodeType === 1) { if (pred(c)) out.push(c); if (c._shadowRoot) walk(c._shadowRoot); if (c._tag === "template") continue; walk(c); } } })(r); return out; };
    var m = /^text=(.*)$/i.exec(spec);
    if (m) {
      var want = m[1].replace(/^["']|["']$/g, "").trim().toLowerCase().replace(/\s+/g, " ");
      // Candidates come from the text nodes holding the first word (and their near ancestors),
      // not from every element's text: that is quadratic on large pages.
      var first = want.split(" ")[0], near = new Set();
      var SKIPT = { script: 1, style: 1, noscript: 1, template: 1, head: 1, title: 1 };
      (function walkText(n) {
        for (var c = n.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3) {
            if (c.data.toLowerCase().indexOf(first) >= 0) { var p = c.parentNode; for (var up = 0; p && p.nodeType === 1 && up < 8; up++, p = p.parentNode) near.add(p); }
          } else if (c.nodeType === 1 && !SKIPT[c._tag]) { if (c._shadowRoot) walkText(c._shadowRoot); walkText(c); }
        }
      })(root);
      var norm = function (e) { return (e.textContent || "").replace(/\s+/g, " ").trim().toLowerCase(); };
      var shown = function (e) { for (var a = e; a && a.nodeType === 1; a = a.parentNode) { if (a.hasAttribute("hidden")) return false; if (__jb.styleOf && __jb.styleOf(a, "display") === "none") return false; } return true; };
      var cands = [];
      near.forEach(function (e) { if (norm(e) === want && shown(e)) cands.push(e); });
      // value= labels only for button inputs: React mirrors typed text into a text field's value
      // attribute, and "text=Dentist" then hit Practo's search box instead of the suggestion
      all(root, function (e) { return (e.getAttribute("aria-label") || "").toLowerCase() === want || (e._tag === "input" && /^(submit|button|reset)$/i.test(e.getAttribute("type") || "") && (e.getAttribute("value") || "").toLowerCase() === want); }).forEach(function (e) { if (cands.indexOf(e) < 0) cands.push(e); });
      // what a person can see wins over matches in closed menus and off-screen copies
      var rendered = function (e) { try { var r = e.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; var v = getComputedStyle(e).visibility; return v !== "hidden" && v !== "collapse"; } catch (x) { return true; } };
      // labels with extra text ("Issues 1.2k" tabs, "Search" buttons with icons): prefix matches
      if (!cands.some(rendered)) near.forEach(function (e) { var t = norm(e); if (t.indexOf(want) === 0 && t.length <= want.length + 24 && shown(e) && cands.indexOf(e) < 0) cands.push(e); });
      if (!cands.some(rendered)) near.forEach(function (e) { var t = norm(e); if (t.indexOf(want) >= 0 && t.length <= want.length * 4 + 40 && shown(e) && cands.indexOf(e) < 0) cands.push(e); });
      if (cands.length > 1) { var vis = cands.filter(rendered); if (vis.length) cands = vis; }
      // the innermost match that is interactive, else the innermost one; among those, the text
      // closest to what was asked for ("Issues 2.9k" before "Issues Plan and track work")
      cands = cands.filter(function (e) { return !cands.some(function (o) { return o !== e && e.contains(o); }); });
      var score = function (e) { var t = norm(e); var next = t.charAt(t.indexOf(want) + want.length); return (t === want ? 0 : 1000) + (next && /[a-z]/.test(next) ? 500 : 0) + t.length; };
      cands.sort(function (a, b) { return score(a) - score(b); });
      return cands.filter(function (e) { return __jb.isInteractiveContent && __jb.isInteractiveContent(e); })[0] || cands[0] || null;
    }
    try {
      var directAll = root.querySelectorAll(spec);
      // Several matches: the first one a person can see (BigBasket has a second search box in an
      // opacity:0 sticky header before the visible one; typing went into the invisible copy).
      if (directAll.length > 1) { for (var di = 0; di < directAll.length && di < 50; di++) if (U.perceivable(directAll[di])) return directAll[di]; }
      if (directAll.length) return directAll[0];
    } catch (e) { return null; }
    var hosts = all(root, function (e) { return !!e._shadowRoot; });
    for (var i = 0; i < hosts.length; i++) { try { var h = hosts[i]._shadowRoot.querySelector(spec); if (h) return h; } catch (e2) {} }
    // Descendant combinators pierce shadow roots (each compound may sit in a different tree).
    var parts = splitDescendants(spec);
    if (parts && parts.length > 1) {
      var last = parts[parts.length - 1], rest = parts.slice(0, -1);
      var cands = all(root, function (e) { try { return e.matches(last); } catch (x) { return false; } });
      for (var k = 0; k < cands.length; k++) {
        var need = rest.length - 1;
        for (var n = composedParent(cands[k]); n && need >= 0; n = composedParent(n)) { try { if (n.nodeType === 1 && n.matches(rest[need])) need--; } catch (x2) { need = -2; } }
        if (need < 0 && need !== -2) return cands[k];
      }
    }
    return null;
  };
  // Laid out with a box, not visibility:hidden, and no fully transparent ancestor.
  U.perceivable = function (el) {
    try {
      var r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      var cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.visibility === "collapse") return false;
      for (var a = el; a && a.nodeType === 1; a = composedParent(a)) if (getComputedStyle(a).opacity === "0") return false;
      return true;
    } catch (e) { return true; }
  };
  var composedParent = function (n) { var p = n.parentNode; return p && p.nodeType === 11 && p._host ? p._host : p; };
  // "a b c" -> ["a", "b", "c"] when the selector uses only descendant combinators (outside brackets/parens/strings)
  var splitDescendants = function (sel) {
    var out = [], cur = "", depth = 0, q = null;
    for (var i = 0; i < sel.length; i++) {
      var c = sel.charAt(i);
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === "(" || c === "[") depth++;
      if (c === ")" || c === "]") depth--;
      if (depth === 0 && (c === ">" || c === "+" || c === "~" || c === ",")) return null;
      if (depth === 0 && /\s/.test(c)) { if (cur) out.push(cur); cur = ""; continue; }
      cur += c;
    }
    if (cur) out.push(cur);
    return out;
  };
  U.findAll = function (spec) {
    var res = [];
    var walk = function (r) { try { Array.prototype.push.apply(res, __jb.arrayFrom(r.querySelectorAll(spec))); } catch (e) {} for (var c = r.firstChild; c; c = c.nextSibling) visit(c); };
    var visit = function (n) { if (n.nodeType !== 1) return; if (n._shadowRoot) walk(n._shadowRoot); for (var c = n.firstChild; c; c = c.nextSibling) visit(c); };
    walk(__jb.currentDocument);
    return res;
  };
  U.describe = function (el) {
    if (!el) return null;
    var c = centerOf(el);
    return { tag: el.localName, id: el.id || "", text: ((el.innerText !== undefined ? el.innerText : el.textContent) || "").replace(/\s+/g, " ").trim().slice(0, 200), value: "value" in el ? U.shownValue(el, el.value) : undefined, checked: "checked" in el ? !!el.checked : undefined, x: Math.round(c.x), y: Math.round(c.y), visible: !c.empty };
  };
  // Values of password fields and vault-filled fields never reach the agent (descriptions, reports).
  U.shownValue = function (el, v) {
    v = v == null ? "" : String(v);
    if (el && el.nodeType === 1 && (el._jbVault || (el._tag === "input" && __jb.inputType(el) === "password"))) return v ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : "";
    return v;
  };

  // Password vault (src/vault.rs, session commands login / otp / new_password): find the sign-in
  // fields on the page or in its frames, report their frame's origin (no secrets), then type the
  // values the host looked up for that origin. Filled secret fields are marked for U.shownValue.
  var acOf = function (el) { return String(el.getAttribute("autocomplete") || "").toLowerCase(); };
  var hintOf = function (el) { return [el.name, el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"), acOf(el)].join(" ").toLowerCase(); };
  var vaultInputs = function (w) {
    var all = [];
    try { all = w.__jb.user.findAll("input"); } catch (e) { try { all = __jb.arrayFrom(w.document.querySelectorAll("input")); } catch (x) {} }
    return all.filter(function (el) { try { return !el.disabled && !el.readOnly && w.__jb.user.describe(el).visible; } catch (e) { return false; } });
  };
  var vaultUser = function (f, pw) {
    var texty = f.filter(function (el) { return /^(text|email|tel)$/.test(__jb.inputType(el)); });
    var form = pw && pw.form;
    var pick = function (list) {
      if (!pw) return list[0] || null;
      var before = list.filter(function (el) { return (!form || el.form === form) && (el.compareDocumentPosition(pw) & 4); });
      return before[before.length - 1] || null;
    };
    return pick(texty.filter(function (el) { return /\b(username|email)\b/.test(acOf(el)); }))
      || pick(texty.filter(function (el) { return __jb.inputType(el) === "email" || /user|e-?mail|login|account|phone|mobile|identifier/.test(hintOf(el)); }))
      || (pw ? pick(texty) : null);
  };
  U.vaultFind = function (kind) {
    var wins = [];
    var walk = function (w, d) { if (wins.indexOf(w) >= 0) return; wins.push(w); if (d < 3) { try { w.__jb.frameWindows(w.document).forEach(function (f) { walk(f, d + 1); }); } catch (e) {} } };
    walk(window, 0);
    __jb.vaultTarget = null;
    for (var i = 0; i < wins.length; i++) {
      var w = wins[i], f = vaultInputs(w), t = null, pw;
      if (kind === "otp") {
        var digits = f.filter(function (el) { return /^(text|tel|number|password)$/.test(__jb.inputType(el)) && el.maxLength === 1; });
        var one = f.filter(function (el) { return /one-time-code/.test(acOf(el)); });
        if (!one.length) one = f.filter(function (el) { return /^(text|tel|number|password)$/.test(__jb.inputType(el)) && /otp|one.?time|totp|2fa|mfa|verif|security.?code|auth.*code|passcode|\bcode\b|token|pin/.test(hintOf(el)); });
        if (digits.length >= 4) t = { otp: digits.slice(0, 10), split: true };
        else if (one.length) t = { otp: [one[0]] };
      } else if (kind === "new") {
        pw = f.filter(function (el) { return __jb.inputType(el) === "password"; });
        var np = pw.filter(function (el) { return /new-password/.test(acOf(el)); });
        if (np.length) pw = np;
        if (pw.length) t = { pass: pw.slice(0, 2), user: vaultUser(f, pw[0]) };
      } else {
        pw = f.filter(function (el) { return __jb.inputType(el) === "password" && !/new-password/.test(acOf(el)); });
        if (!pw.length) pw = f.filter(function (el) { return __jb.inputType(el) === "password"; });
        var user = vaultUser(f, pw[0] || null);
        if (pw.length || user) t = { pass: pw.slice(0, 1), user: user };
      }
      if (t) {
        t.win = w;
        __jb.vaultTarget = t;
        return __jb.hostJson({ ok: true, origin: String(w.location.origin), username: !!t.user, password: !!(t.pass && t.pass.length), otp: t.otp ? t.otp.length : 0 });
      }
    }
    return __jb.hostJson({ error: kind === "otp" ? "No one-time code field on this page" : kind === "new" ? "No new-password field on this page" : "No sign-in field (password or username) on this page" });
  };
  U.vaultFill = function (v) {
    var t = __jb.vaultTarget; __jb.vaultTarget = null;
    if (!t) return __jb.hostJson({ error: "The sign-in fields are gone" });
    var wu = t.win.__jb.user, done = [];
    var put = function (el, text, secret) {
      if (!el || !el.isConnected) return false;
      if (secret) el._jbVault = true;
      wu.type(el, text);
      return true;
    };
    if (v.username != null && t.user && put(t.user, v.username, false)) done.push("username");
    if (v.password != null && t.pass) {
      var n = 0;
      t.pass.forEach(function (el) { if (put(el, v.password, true)) n++; });
      if (n) done.push(n > 1 ? "password and confirmation" : "password");
    }
    if (v.otp != null && t.otp) {
      if (t.split) { var chars = String(v.otp).split(""); t.otp.forEach(function (el, i) { if (chars[i] != null) put(el, chars[i], true); }); }
      else put(t.otp[0], v.otp, true);
      done.push("one-time code");
    }
    if (!done.length) return __jb.hostJson({ error: "The sign-in fields could not be filled" });
    return __jb.hostJson({ ok: true, filled: done });
  };
})();

// Layout changes under a still pointer: at the next rendering update the pointer is hit-tested
// again and boundary events (over/out/enter/leave, with the current modifiers) fire as needed.
(function () {
  var U = __jb.user, pointer = U.pointer, scheduled = false;
  var baseDirty = __jb.markDirty;
  __jb.markDirty = function (node) {
    baseDirty.apply(this, arguments);
    if (!pointer.active || scheduled || pointer.buttons) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      if (!pointer.active || pointer.buttons) return;
      var el = U.elementAt(pointer.x, pointer.y);
      if (el && el !== pointer.over) U.movePointer(pointer.x, pointer.y, null, true, el);
    }, __jb.untilNextFrame() + 0.6);
  };
})();

// ---------------------------------------------------------------- agent commands
// Keyboard without a selector, insert-text, drag and drop, file upload, directional scroll and
// numbered element references, used by the session CLI commands (src/session.rs).
(function () {
  var U = __jb.user;
  var doc = function () { return __jb.currentDocument; };
  var report = function (o) { return __jb.hostJson(o); };
  var desc = function (el) { return el && el.isConnected ? U.describe(el) : null; };

  // Real keystrokes at the current focus: keydown/keypress/beforeinput/input/keyup per character.
  U.keyboardType = function (text) {
    __jb.arrayFrom(String(text)).forEach(function (ch) {
      var key = ch === "\n" ? "Enter" : ch === "\t" ? "Tab" : ch;
      U.keyDown(key); U.keyUp(key);
    });
    return report({ ok: true, el: desc(U.deepActive()) });
  };

  // Insert text at the focused control without key events (beforeinput + input only).
  U.insertText = function (text) {
    var fu = U.focusedFrameUser();
    if (fu) return fu.insertText(text);
    text = String(text);
    var t = U.deepActive();
    if (!t || t === doc().body || t === doc().documentElement) return report({ error: "No element has focus to insert text into" });
    var tag = t.localName;
    if (tag === "input" || tag === "textarea") {
      if (t.disabled || t.readOnly) return report({ error: "The focused field is disabled or read-only", el: desc(t) });
      var before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: text });
      __jb.setTrusted(before, true); before._trustedDispatch = true;
      if (!t.dispatchEvent(before)) return report({ ok: true, canceled: true, el: desc(t) });
      var s = null, e = null; try { s = t.selectionStart; e = t.selectionEnd; } catch (er) {}
      if (typeof s === "number" && typeof t.setRangeText === "function") t.setRangeText(text, s, e, "end");
      else U.setNativeValue(t, String(t.value || "") + text);
      var inp = new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text });
      __jb.setTrusted(inp, true); inp._trustedDispatch = true;
      t.dispatchEvent(inp);
      return report({ ok: true, el: desc(t), value: U.shownValue(t, t.value) });
    }
    if (t.isContentEditable) { doc().execCommand("insertText", false, text); return report({ ok: true, el: desc(t) }); }
    return report({ error: "The focused element is not editable", el: desc(t) });
  };

  // Drag src onto tgt. Draggable sources (draggable=true, links, images) get the HTML drag-and-drop
  // sequence; anything else gets a pointer drag (down, moves, up) as pointer-based libraries expect.
  var isDraggable = function (el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
      var d = n.getAttribute("draggable");
      if (d === "true") return n;
      if (d === "false") return null;
      if ((n.localName === "a" && n.hasAttribute("href")) || n.localName === "img") return n;
    }
    return null;
  };
  U.drag = function (src, tgt) {
    if (!src) return report({ error: "No element matches the drag source" });
    if (!tgt) return report({ error: "No element matches the drop target" });
    U.scrollIntoView(src);
    var a = U.centerOf(src);
    U.movePointer(a.x, a.y, null, false, src);
    U.press(0, null, src);
    var dragged = isDraggable(src);
    var at = function (p) { return { clientX: p.x, clientY: p.y, screenX: p.x, screenY: p.y }; };
    if (dragged) {
      var dt = new DataTransfer();
      var started = U.fire(dragged, DragEvent, "dragstart", Object.assign({ dataTransfer: dt }, at(a)));
      if (!started) { U.release(0, null, src); return report({ ok: true, html5: true, dropped: false, canceled: "dragstart", el: desc(src) }); }
      U.scrollIntoView(tgt);
      var b = U.centerOf(tgt);
      for (var i = 1; i <= 4; i++) U.fire(dragged, DragEvent, "drag", Object.assign({ dataTransfer: dt }, at({ x: a.x + (b.x - a.x) * i / 4, y: a.y + (b.y - a.y) * i / 4 })));
      U.fire(tgt, DragEvent, "dragenter", Object.assign({ dataTransfer: dt }, at(b)));
      var allowed = !U.fire(tgt, DragEvent, "dragover", Object.assign({ dataTransfer: dt }, at(b)));
      if (allowed) U.fire(tgt, DragEvent, "drop", Object.assign({ dataTransfer: dt }, at(b)));
      else U.fire(tgt, DragEvent, "dragleave", Object.assign({ dataTransfer: dt }, at(b)));
      U.fire(dragged, DragEvent, "dragend", Object.assign({ dataTransfer: dt }, at(b)));
      U.pointer.buttons = 0; U.pointer.downTarget = null;
      return report({ ok: true, html5: true, dropped: allowed, el: desc(src), target: desc(tgt) });
    }
    U.scrollIntoView(tgt);
    var c = U.centerOf(tgt);
    for (var j = 1; j <= 5; j++) U.movePointer(a.x + (c.x - a.x) * j / 5, a.y + (c.y - a.y) * j / 5, null, false, j === 5 ? tgt : null);
    U.release(0, null, tgt);
    return report({ ok: true, html5: false, dropped: true, el: desc(src), target: desc(tgt) });
  };
  // <input type=range> default actions of a pointer (the thumb follows a drag, a click on the track
  // moves it there). Thumbs are not elements: the slider under the point is found by its box, and of
  // overlapping sliders (a two-handle "double range") the one whose thumb is nearest is taken.
  var rangeBounds = function (el) {
    var min = parseFloat(el.min), max = parseFloat(el.max), step = el.step === "any" ? 0 : parseFloat(el.step);
    min = isFinite(min) ? min : 0; max = isFinite(max) ? max : 100;
    return { min: min, max: max < min ? min : max, step: step > 0 ? step : el.step === "any" ? 0 : 1 };
  };
  var THUMB = 16;
  var thumbX = function (el, r, b) { var v = parseFloat(el.value); v = isFinite(v) ? v : b.min; return r.left + THUMB / 2 + (b.max > b.min ? (v - b.min) / (b.max - b.min) : 0) * Math.max(0, r.width - THUMB); };
  U.rangeAt = function (x, y, d) {
    var best = null, bestD = Infinity, list;
    try { list = (d || doc()).querySelectorAll("input[type=range]"); } catch (e) { return null; }
    for (var i = 0; i < list.length && i < 200; i++) {
      var el = list[i], r;
      if (el.disabled) continue;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (!(r.width > 0) || x < r.left - 4 || x > r.right + 4 || y < r.top - 8 || y > r.bottom + 8) continue;
      var dist = Math.abs(thumbX(el, r, rangeBounds(el)) - x);
      if (dist < bestD) { best = el; bestD = dist; }
    }
    return best;
  };
  // Value under viewport x; fires input when it changed. -> true when the value changed
  U.rangeTo = function (el, x) {
    var r = el.getBoundingClientRect(), b = rangeBounds(el);
    var f = r.width > THUMB ? (x - r.left - THUMB / 2) / (r.width - THUMB) : 0;
    var v = b.min + Math.max(0, Math.min(1, f)) * (b.max - b.min);
    if (b.step) v = b.min + Math.round((v - b.min) / b.step) * b.step;
    v = Math.max(b.min, Math.min(b.max, +v.toFixed(10)));
    var was = el.value;
    U.setNativeValue(el, String(v));
    if (el.value === was) return false;
    U.fire(el, Event, "input", { bubbles: true, composed: true });
    return true;
  };
  // A mouse click at viewport coordinates (canvas boards, maps, custom widgets without elements).
  // A point inside a frame is clicked in that frame's document.
  U.clickAt = function (x, y, count) {
    x = +x; y = +y;
    if (!(x >= 0 && y >= 0 && x < (globalThis.innerWidth || 1280) && y < (globalThis.innerHeight || 720))) return report({ error: "Point " + x + "," + y + " is outside the viewport" });
    var d0 = __jb.currentDocument, hit = null;
    try { hit = d0.elementFromPoint(x, y); } catch (e) {}
    hit = hit || d0.body || d0.documentElement;
    if (hit && (hit.tagName === "IFRAME" || hit.tagName === "FRAME")) {
      var w = null; try { w = hit._contentWindow; } catch (e) {}
      if (w && w.__jb && w.__jb.user && w.__jb.user !== U) {
        var fr = hit.getBoundingClientRect(), cs = getComputedStyle(hit);
        var ox = fr.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
        var oy = fr.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
        return w.__jb.user.clickAt(x - ox, y - oy, count);
      }
    }
    var n = count || 1, rng = U.rangeAt(x, y, d0);
    U.movePointer(x, y, null, false, hit);
    for (var i = 0; i < n; i++) { U.press(0, null, hit); U.release(0, null, hit); }
    // a click on a slider's track (not on its thumb) moves the thumb there
    if (rng && Math.abs(thumbX(rng, rng.getBoundingClientRect(), rangeBounds(rng)) - x) > THUMB / 2) {
      try { rng.focus(); } catch (e) {}
      if (U.rangeTo(rng, x)) U.fire(rng, Event, "change", { bubbles: true });
      return report({ ok: true, el: desc(rng), value: rng.value });
    }
    return report({ ok: true, el: desc(hit) });
  };
  // A mouse drag between viewport points (range-slider handles, sliders, maps): press at the start,
  // move in steps (each step hit-tested, as a real pointer), release at the end.
  U.dragAt = function (x1, y1, x2, y2) {
    x1 = +x1; y1 = +y1; x2 = +x2; y2 = +y2;
    var W = globalThis.innerWidth || 1280, H = globalThis.innerHeight || 720;
    if (!(x1 >= 0 && y1 >= 0 && x1 < W && y1 < H && x2 >= 0 && y2 >= 0 && x2 < W && y2 < H)) return report({ error: "Drag points must be inside the viewport" });
    var d0 = __jb.currentDocument;
    var at = function (x, y) { var h = null; try { h = d0.elementFromPoint(x, y); } catch (e) {} return h || d0.body || d0.documentElement; };
    var start = at(x1, y1);
    if (start && (start.tagName === "IFRAME" || start.tagName === "FRAME")) {
      var fw = null; try { fw = start._contentWindow; } catch (e) {}
      if (fw && fw.__jb && fw.__jb.user && fw.__jb.user !== U) {
        var fr = start.getBoundingClientRect(), fcs = getComputedStyle(start);
        var fx = fr.left + (parseFloat(fcs.borderLeftWidth) || 0) + (parseFloat(fcs.paddingLeft) || 0);
        var fy = fr.top + (parseFloat(fcs.borderTopWidth) || 0) + (parseFloat(fcs.paddingTop) || 0);
        return fw.__jb.user.dragAt(x1 - fx, y1 - fy, x2 - fx, y2 - fy);
      }
    }
    var rng = U.rangeAt(x1, y1, d0), rngStart = rng ? rng.value : null;
    U.movePointer(x1, y1, null, false, start);
    U.press(0, null, start);
    if (rng) { try { rng.focus(); } catch (e) {} }
    var steps = 8;
    for (var i = 1; i <= steps; i++) {
      var x = x1 + (x2 - x1) * i / steps, y = y1 + (y2 - y1) * i / steps;
      // while the button is down the pointer keeps hitting the pressed element's targets (pointer capture is the page's job)
      U.movePointer(x, y, null, false, at(x, y));
      if (rng && rng.isConnected) U.rangeTo(rng, x);
    }
    var end = at(x2, y2);
    U.release(0, null, end);
    if (rng) {
      if (rng.value !== rngStart) U.fire(rng, Event, "change", { bubbles: true });
      return report({ ok: true, el: desc(rng), value: rng.value, was: rngStart });
    }
    return report({ ok: true, el: desc(start), target: desc(end) });
  };

  // Set the files of an <input type=file> (files = [{name, type, b64, lastModified}]) and fire
  // input + change, as choosing them in the file picker does.
  U.upload = function (el, files) {
    if (!el) return report({ error: "No element matches the file input" });
    if (el.localName !== "input" || __jb.inputType(el) !== "file") return report({ error: "The element is not an <input type=file>", el: desc(el) });
    if (el.disabled) return report({ error: "The file input is disabled", el: desc(el) });
    if (!el.multiple && files.length > 1) return report({ error: "The file input does not accept multiple files", el: desc(el) });
    var list = new FileList();
    files.forEach(function (f) {
      var bin = atob(f.b64), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      list.push(new File([bytes], f.name, { type: f.type || "", lastModified: f.lastModified || Date.now() }));
    });
    el._files = list;
    var input = new Event("input", { bubbles: true, composed: true });
    __jb.setTrusted(input, true); input._trustedDispatch = true;
    el.dispatchEvent(input);
    var change = new Event("change", { bubbles: true });
    __jb.setTrusted(change, true); change._trustedDispatch = true;
    el.dispatchEvent(change);
    return report({ ok: true, el: desc(el), files: files.map(function (f) { return f.name; }) });
  };

  // Scroll the page (or an element) by px in a direction, after a wheel event it may cancel.
  U.scrollDir = function (dir, px, spec) {
    px = Number(px) || 300;
    var dx = 0, dy = 0;
    switch (String(dir).toLowerCase()) {
      case "up": dy = -px; break;
      case "down": dy = px; break;
      case "left": dx = -px; break;
      case "right": dx = px; break;
      default: return report({ error: "Unknown scroll direction " + __jb.hostJson(dir) + " (use up, down, left or right)" });
    }
    var el = spec ? U.find(spec) : null;
    if (spec && !el) return report({ error: "No element matches " + __jb.hostJson(spec) });
    if (!el) el = U.scrollPaneAtCentre(dx, dy);
    var target = el || doc().scrollingElement || doc().documentElement;
    var goOn = U.fire(target, WheelEvent, "wheel", { deltaX: dx, deltaY: dy, deltaMode: 0, clientX: U.pointer.x, clientY: U.pointer.y });
    if (!goOn) return report({ ok: true, canceled: true });
    if (el) { el.scrollLeft += dx; el.scrollTop += dy; return report({ ok: true, x: el.scrollLeft, y: el.scrollTop, el: desc(el) }); }
    globalThis.scrollBy(dx, dy);
    return report({ ok: true, x: globalThis.scrollX, y: globalThis.scrollY });
  };

  // The nearest scrollable ancestor of the element at the viewport centre that can still move in
  // this direction and is a real pane (at least 40% of the viewport), or null (the window scrolls).
  U.scrollPaneAtCentre = function (dx, dy) {
    try {
      var w = globalThis.innerWidth || 1280, h = globalThis.innerHeight || 720, d = doc();
      var hit = d.elementFromPoint(w / 2, h / 2);
      // into open shadow trees: the hit is retargeted to the host, the scroller may be inside it
      for (var depth = 0; hit && hit.shadowRoot && depth < 8; depth++) {
        var inner = null; try { inner = hit.shadowRoot.elementFromPoint(w / 2, h / 2); } catch (e) {}
        if (!inner || inner === hit) break;
        hit = inner;
      }
      var root = d.scrollingElement || d.documentElement;
      var up = __jb.flatParentElement || function (n) { return n.parentElement; };
      for (var x = hit; x && x !== root && x !== d.body && x.nodeType === 1; x = up(x)) {
        var cs = getComputedStyle(x), ov = dy ? cs.overflowY : cs.overflowX;
        if (ov !== "auto" && ov !== "scroll") continue;
        var room = dy ? x.scrollHeight - x.clientHeight : x.scrollWidth - x.clientWidth;
        if (room < 2 || (dy ? x.clientHeight : x.clientWidth) < 0.4 * (dy ? h : w)) continue;
        var pos = dy ? x.scrollTop : x.scrollLeft;
        if ((dy || dx) > 0 ? pos >= room - 1 : pos <= 0) continue;
        return x;
      }
    } catch (e) {}
    return null;
  };

  // Number the visible interactive elements (for an annotated screenshot); `@N` then refers to them.
  var INTERACTIVE = "a[href], button, input:not([type=hidden]), select, textarea, summary, label[for], [role=button], [role=link], [role=checkbox], [role=radio], [role=menuitem], [role=tab], [role=switch], [role=option], [onclick], [contenteditable=''], [contenteditable=true], [tabindex]:not([tabindex='-1'])";
  U.annotate = function () {
    var refs = __jb.userRefs = {};
    var out = [], n = 0, sx = globalThis.scrollX || 0, sy = globalThis.scrollY || 0;
    __jb.arrayFrom(doc().querySelectorAll(INTERACTIVE)).forEach(function (el) {
      if (!__jb.isRendered(el)) return;
      var r = null; try { r = el.getBoundingClientRect(); } catch (e) {}
      if (!r || r.width < 1 || r.height < 1) return;
      n++;
      refs[n] = el;
      out.push({ n: n, x: r.left + sx, y: r.top + sy, w: r.width, h: r.height, el: U.describe(el) });
    });
    return __jb.hostJson({ ok: true, scrollX: sx, scrollY: sy, viewport: { w: globalThis.innerWidth, h: globalThis.innerHeight }, items: out });
  };
})();
