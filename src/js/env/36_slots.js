// Part 4c: shadow DOM slots (DOM Standard "slots" / "slottables" / "signal a slot change")
// and the shared mutation observer microtask that also delivers slotchange events.
__jb.isSlot = function (n) { return !!n && n.nodeType === 1 && n._tag === "slot" && n._ns === __jb.HTML_NS; };
__jb.isSlottable = function (n) { return !!n && (n.nodeType === 1 || n.nodeType === 3); };
__jb.slottableName = function (n) { return n.nodeType === 1 ? (n.getAttribute("slot") || "") : ""; };
// Slots of a tree in tree order (not entering nested shadow trees).
__jb.slotsIn = function (root) {
  var out = [], stack = [root];
  while (stack.length) { var n = stack.pop(); if (__jb.isSlot(n)) out.push(n); for (var c = n.lastChild; c; c = c.previousSibling) if (c.nodeType === 1) stack.push(c); }
  return out;
};
// "Find a slot" for a slottable.
__jb.findSlot = function (slottable, open) {
  var parent = slottable.parentNode;
  if (!parent || parent.nodeType !== 1 || !__jb.isSlottable(slottable)) return null;
  var shadow = parent._shadowRoot;
  if (!shadow) return null;
  if (open && shadow.mode !== "open") return null;
  var slots = __jb.slotsIn(shadow);
  if (shadow.slotAssignment === "manual") { for (var i = 0; i < slots.length; i++) if ((slots[i]._manualAssigned || []).indexOf(slottable) >= 0) return slots[i]; return null; }
  var name = __jb.slottableName(slottable);
  for (var j = 0; j < slots.length; j++) if ((slots[j].getAttribute("name") || "") === name) return slots[j];
  return null;
};
__jb.assignedSlotOf = function (n) { var p = n.parentNode; return p && p.nodeType === 1 && p._shadowRoot ? __jb.findSlot(n, false) : null; };
// "Find slottables" for a slot.
__jb.findSlottables = function (slot) {
  var root = slot.getRootNode(), result = [];
  if (!(root.nodeType === 11 && root._host)) return result;
  var host = root._host;
  if (root.slotAssignment === "manual") { (slot._manualAssigned || []).forEach(function (s) { if (s.parentNode === host) result.push(s); }); return result; }
  for (var c = host.firstChild; c; c = c.nextSibling) if (__jb.isSlottable(c) && __jb.findSlot(c, false) === slot) result.push(c);
  return result;
};
__jb.findFlattenedSlottables = function (slot) {
  var result = [], root = slot.getRootNode();
  if (!(root.nodeType === 11 && root._host)) return result;
  var slottables = __jb.findSlottables(slot);
  if (!slottables.length) for (var c = slot.firstChild; c; c = c.nextSibling) if (__jb.isSlottable(c)) slottables.push(c);
  slottables.forEach(function (n) {
    var r = __jb.isSlot(n) ? n.getRootNode() : null;
    if (r && r.nodeType === 11 && r._host) result.push.apply(result, __jb.findFlattenedSlottables(n)); else result.push(n);
  });
  return result;
};
// "Assign slottables": keep the slot's assigned nodes current and signal a change.
__jb.assignSlottables = function (slot) {
  var now = __jb.findSlottables(slot), old = slot._assignedNodes || [];
  var same = now.length === old.length && now.every(function (n, i) { return n === old[i]; });
  if (!same) { slot._assignedNodes = now; __jb.signalSlotChange(slot); }
};
__jb.assignSlottablesForTree = function (root) { if (root) __jb.slotsIn(root).forEach(__jb.assignSlottables); };
__jb.signalSlots = [];
__jb.signalSlotChange = function (slot) { if (__jb.signalSlots.indexOf(slot) < 0) __jb.signalSlots.push(slot); __jb.queueMutationObserverMicrotask(); };
__jb.inShadowTree = function (n) { var r = n.getRootNode(); return r.nodeType === 11 && !!r._host; };
// Insertion/removal steps that matter for slots (called from __jb.insertInner / __jb.remove).
__jb.slotsAfterInsert = function (parent, node) {
  if (parent.nodeType === 1 && parent._shadowRoot && parent._shadowRoot.slotAssignment !== "manual" && __jb.isSlottable(node)) { var s = __jb.findSlot(node, false); if (s) __jb.assignSlottables(s); }
  if (__jb.isSlot(parent) && __jb.inShadowTree(parent) && !(parent._assignedNodes && parent._assignedNodes.length)) __jb.signalSlotChange(parent);
  if (node.nodeType === 1 && (__jb.isSlot(node) || node.querySelector && node.querySelector("slot"))) __jb.assignSlottablesForTree(node.getRootNode());
};
__jb.slotsAfterRemove = function (parent, node, oldSlot) {
  if (oldSlot) __jb.assignSlottables(oldSlot);
  if (__jb.isSlot(parent) && __jb.inShadowTree(parent) && !(parent._assignedNodes && parent._assignedNodes.length)) __jb.signalSlotChange(parent);
  if (node.nodeType === 1 && (__jb.isSlot(node) || node.querySelector && node.querySelector("slot"))) { __jb.assignSlottablesForTree(parent.getRootNode()); __jb.assignSlottablesForTree(node); }
};
__jb.slotsAttrChanged = function (el, name, oldValue, newValue) {
  if (name === "name" && __jb.isSlot(el)) {
    if (oldValue === newValue || (newValue === null && oldValue === "") || (newValue === "" && oldValue === null)) return;
    __jb.assignSlottablesForTree(el.getRootNode());
  } else if (name === "slot") {
    if (oldValue === newValue || (newValue === null && oldValue === "") || (newValue === "" && oldValue === null)) return;
    var p = el.parentNode;
    if (p && p.nodeType === 1 && p._shadowRoot) __jb.assignSlottablesForTree(p._shadowRoot);
  }
};
// One microtask notifies every observer (in creation order) and then fires slotchange.
__jb.moMicrotaskQueued = false;
__jb.queueMutationObserverMicrotask = function () {
  if (__jb.moMicrotaskQueued) return;
  __jb.moMicrotaskQueued = true;
  // the browser's own microtask: not a page Promise (zone.js would make it a zone task)
  __jb.nativeMicrotask(function () {
    __jb.moMicrotaskQueued = false;
    // notifySet = the pending mutation observers (those that had records queued), in queueing order.
    var observers = __jb.pendingMutationObservers.splice(0);
    var slots = __jb.signalSlots.splice(0);
    observers.forEach(function (mo) {
      mo._scheduled = false;
      var q = mo._queue.splice(0);
      if (typeof __jb.dropTransientObservers === "function") __jb.dropTransientObservers(mo);
      if (q.length) { try { mo._callback.call(mo, q, mo); } catch (e) { __jb.reportException(e); } }
    });
    slots.forEach(function (s) { try { s.dispatchEvent(new Event("slotchange", { bubbles: true })); } catch (e) { __jb.reportException(e); } });
  });
};
__jb.pendingMutationObservers = [];
__jb.scheduleMutationDelivery = function (mo) { mo._scheduled = true; if (__jb.pendingMutationObservers.indexOf(mo) < 0) __jb.pendingMutationObservers.push(mo); __jb.queueMutationObserverMicrotask(); };
(function () {
  var S = __jb.htmlClasses.HTMLSlotElement;
  if (S) {
    Object.defineProperty(S.prototype, "name", { get: function () { return this.getAttribute("name") || ""; }, set: function (v) { this.setAttribute("name", String(v)); }, configurable: true, enumerable: true });
    Object.defineProperty(S.prototype, "assignedNodes", { value: function assignedNodes(options) { return options && options.flatten ? __jb.findFlattenedSlottables(this) : __jb.findSlottables(this); }, writable: true, configurable: true, enumerable: true });
    Object.defineProperty(S.prototype, "assignedElements", { value: function assignedElements(options) { return (options && options.flatten ? __jb.findFlattenedSlottables(this) : __jb.findSlottables(this)).filter(function (n) { return n.nodeType === 1; }); }, writable: true, configurable: true, enumerable: true });
    Object.defineProperty(S.prototype, "assign", {
      value: function assign() {
        var self = this, nodes = [];
        for (var i = 0; i < arguments.length; i++) { var n = arguments[i]; if (!__jb.isNode(n) || (n.nodeType !== 1 && n.nodeType !== 3)) throw new TypeError("Failed to execute 'assign' on 'HTMLSlotElement': parameter " + (i + 1) + " is not of type 'Element' or 'Text'."); nodes.push(n); }
        (this._manualAssigned || []).forEach(function (n) { if (n._manualSlot === self) n._manualSlot = null; });
        var set = [], otherRoots = [];
        nodes.forEach(function (n) {
          if (n._manualSlot && n._manualSlot !== self) { var prev = n._manualSlot._manualAssigned || []; var k = prev.indexOf(n); if (k >= 0) prev.splice(k, 1); var pr = n._manualSlot.getRootNode(); if (otherRoots.indexOf(pr) < 0) otherRoots.push(pr); }
          n._manualSlot = self;
          if (set.indexOf(n) < 0) set.push(n);
        });
        this._manualAssigned = set;
        var myRoot = this.getRootNode();
        __jb.assignSlottablesForTree(myRoot);
        otherRoots.forEach(function (r) { if (r !== myRoot) __jb.assignSlottablesForTree(r); });
      }, writable: true, configurable: true, enumerable: true,
    });
  }
  var slotGetter = { get: function () { return __jb.findSlot(this, true); }, configurable: true, enumerable: true };
  Object.defineProperty(Element.prototype, "assignedSlot", slotGetter);
  Object.defineProperty(Text.prototype, "assignedSlot", slotGetter);
  Object.defineProperty(Element.prototype, "slot", { get: function () { return this.getAttribute("slot") || ""; }, set: function (v) { this.setAttribute("slot", String(v)); }, configurable: true, enumerable: true });
})();
