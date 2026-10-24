// ---------------------------------------------------------------- <select> / <option> model
// HTML "list of options", option selectedness + dirtiness, the selectedness setting algorithm
// (run lazily whenever the list of options changed), and HTMLOptionsCollection.
(function () {
  var Sel = __jb.htmlClasses.HTMLSelectElement, Opt = __jb.htmlClasses.HTMLOptionElement;
  if (!Sel || !Opt) return;
  var isHtml = function (n, tag) { return n && n.nodeType === 1 && n._ns === __jb.HTML_NS && n._tag === tag; };

  // Options are descendants of the select, not descending into option, hr, select or datalist
  // elements, nor into an optgroup inside another optgroup.
  __jb.selectOptionList = function (select) {
    var out = [];
    (function walk(node, inGroup) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1 || c._ns !== __jb.HTML_NS) { if (c.nodeType === 1) walk(c, inGroup); continue; }
        if (c._tag === "option") { out.push(c); continue; }
        if (c._tag === "hr" || c._tag === "select" || c._tag === "datalist") continue;
        if (c._tag === "optgroup") { if (!inGroup) walk(c, true); continue; }
        walk(c, inGroup);
      }
    })(select, false);
    return out;
  };
  var ownerSelect = function (opt) {
    for (var p = opt.parentNode; p && p.nodeType === 1; p = p.parentNode) if (isHtml(p, "select")) return __jb.selectOptionList(p).indexOf(opt) >= 0 ? p : null;
    return null;
  };
  __jb.optionOwnerSelect = ownerSelect;
  var touch = function () { __jb.domVersion++; };
  var getSel = function (o) { if (o._sel === undefined) o._sel = o.hasAttribute("selected"); return o._sel; };
  var displaySize = function (s) { var v = s.getAttribute("size"); var n = v === null ? null : __jb.parseHtmlNonNegInt ? __jb.parseHtmlNonNegInt(v) : parseInt(v, 10); if (n === null || isNaN(n) || n < 1) return s.hasAttribute("multiple") ? 4 : 1; return n; };
  // "selectedness setting algorithm"
  var runReset = function (s, list) {
    list = list || __jb.selectOptionList(s);
    if (s.hasAttribute("multiple")) return;
    var selected = list.filter(getSel);
    if (!selected.length) {
      if (displaySize(s) === 1) for (var i = 0; i < list.length; i++) if (!__jb.isDisabled(list[i])) { list[i]._sel = true; touch(); break; }
    } else if (selected.length > 1) {
      for (var k = 0; k < selected.length - 1; k++) selected[k]._sel = false;
      touch();
    }
  };
  __jb.selectAskForReset = function (s) { if (s) { var list = __jb.selectOptionList(s); s._optList = list; s._optVer = __jb.domVersion; runReset(s, list); } };
  // The list is re-derived when the DOM changed; a changed list runs the algorithm.
  var ensure = function (s) {
    if (s._optVer === __jb.domVersion && s._optList) return s._optList;
    var list = __jb.selectOptionList(s), old = s._optList || [];
    var changed = list.length !== old.length || list.some(function (o, i) { return o !== old[i]; });
    s._optList = list; s._optVer = __jb.domVersion;
    if (changed) { runReset(s, list); s._optVer = __jb.domVersion; }
    return list;
  };
  __jb.selectOptions = ensure;
  var brand = function (o, C, what) { if (!(o instanceof C)) throw new TypeError("'" + what + "' called on an object that does not implement interface " + C.name + "."); };

  // ---- HTMLOptionsCollection
  function HTMLOptionsCollection() { throw new TypeError("Illegal constructor"); }
  HTMLOptionsCollection.prototype = Object.create(HTMLCollection.prototype, { constructor: { value: HTMLOptionsCollection, writable: true, configurable: true } });
  Object.setPrototypeOf(HTMLOptionsCollection, HTMLCollection);
  Object.defineProperty(HTMLOptionsCollection.prototype, Symbol.toStringTag, { value: "HTMLOptionsCollection", configurable: true });
  var P = HTMLOptionsCollection.prototype;
  var selOf = function (col) { var s = col && col._select; if (!s) throw new TypeError("Illegal invocation"); return s; };
  Object.defineProperty(P, "length", {
    get: function () { return ensure(selOf(this)).length; },
    set: function (v) {
      var s = selOf(this), n = v >>> 0, list = ensure(s);
      if (n > list.length) {
        if (n > 100000) { console.warn("Unable to expand the option list to more than 100000 items"); return; }
        var doc = __jb.ownerDoc(s), frag = doc.createDocumentFragment();
        for (var i = list.length; i < n; i++) frag.appendChild(doc.createElement("option"));
        s.appendChild(frag);
      }
      else for (var k = list.length - 1; k >= n; k--) list[k].remove();
    },
    enumerable: true, configurable: true,
  });
  Object.defineProperty(P, "selectedIndex", { get: function () { return selOf(this).selectedIndex; }, set: function (v) { selOf(this).selectedIndex = v; }, enumerable: true, configurable: true });
  P.add = function add(element, before) { return Sel.prototype.add.apply(selOf(this), arguments); };
  P.remove = function remove(index) { var s = selOf(this); if (arguments.length < 1) throw new TypeError("remove: 1 argument required"); var list = ensure(s), i = index | 0; if (i >= 0 && i < list.length) list[i].remove(); };
  // collection[index] = option | null
  P.__jbSetIndex = function (index, option) {
    var s = selOf(this), list = ensure(s);
    if (option === null || option === undefined) { if (index < list.length) list[index].remove(); return; }
    if (!(option instanceof Opt)) throw new TypeError("Value is not an HTMLOptionElement.");
    var doc = __jb.ownerDoc(s);
    if (index >= list.length) { for (var i = list.length; i < index; i++) s.appendChild(doc.createElement("option")); s.appendChild(option); }
    else if (list[index] !== option) list[index].parentNode.replaceChild(option, list[index]);
  };
  globalThis.HTMLOptionsCollection = HTMLOptionsCollection;
  __jb.setTag && __jb.setTag(HTMLOptionsCollection, "HTMLOptionsCollection");

  // ---- HTMLSelectElement
  var S = Sel.prototype;
  var def = function (proto, name, get, set) { Object.defineProperty(proto, name, { get: get, set: set, enumerable: true, configurable: true }); };
  def(S, "options", function options() {
    brand(this, Sel, "get options");
    if (!this._optionsCol) {
      var self_ = this;
      var col = __jb.makeCollection(HTMLOptionsCollection.prototype, function () { return ensure(self_).slice(); }, true, true);
      Object.defineProperty(col, "_select", { value: this });
      Object.defineProperty(this, "_optionsCol", { value: col });
    }
    return this._optionsCol;
  });
  def(S, "selectedOptions", function selectedOptions() {
    brand(this, Sel, "get selectedOptions");
    if (!this._selectedCol) { var self_ = this; Object.defineProperty(this, "_selectedCol", { value: __jb.makeCollection(HTMLCollection.prototype, function () { return ensure(self_).filter(getSel); }, true, true) }); }
    return this._selectedCol;
  });
  def(S, "selectedIndex", function selectedIndex() { var list = ensure(this); for (var i = 0; i < list.length; i++) if (getSel(list[i])) return i; return -1; },
    function selectedIndex(v) { var list = ensure(this), i = v | 0; list.forEach(function (o) { o._sel = false; }); if (i >= 0 && i < list.length) { list[i]._sel = true; list[i]._dirty = true; } touch(); __jb.markDirty(this); });
  def(S, "value", function value() { var list = ensure(this); for (var i = 0; i < list.length; i++) if (getSel(list[i])) return list[i].value; return ""; },
    function value(v) { v = String(v); var list = ensure(this), done = false; list.forEach(function (o) { if (!done && o.value === v) { o._sel = true; o._dirty = true; done = true; } else o._sel = false; }); touch(); __jb.markDirty(this); });
  def(S, "length", function length() { return ensure(this).length; }, function length(v) { this.options.length = v; });
  def(S, "type", function type() { return this.hasAttribute("multiple") ? "select-multiple" : "select-one"; });
  S.item = function item(i) { var o = ensure(this)[i >>> 0]; return o === undefined ? null : o; };
  S.namedItem = function namedItem(name) { name = String(name); if (name === "") return null; var list = ensure(this); for (var i = 0; i < list.length; i++) if (list[i].getAttribute("id") === name || list[i].getAttribute("name") === name) return list[i]; return null; };
  S.add = function add(element, before) {
    if (arguments.length < 1) throw new TypeError("add: 1 argument required");
    if (!(element instanceof Opt) && !isHtml(element, "optgroup")) throw new TypeError("add: Argument 1 is not an option or optgroup element.");
    for (var a = this; a; a = a.parentNode) if (a === element) throw __jb.domError("HierarchyRequestError", "The element is an ancestor of the select.");
    var ref = null;
    if (before !== undefined && before !== null) {
      if (typeof before === "object") {
        if (!(before instanceof Node)) throw new TypeError("add: Argument 2 is not an element or index.");
        var inside = false; for (var b = before; b; b = b.parentNode) if (b === this) { inside = true; break; }
        if (!inside) throw __jb.domError("NotFoundError", "The reference element is not in the select.");
        ref = before;
      } else ref = ensure(this)[before | 0] || null;
    }
    if (element === ref) return;
    (ref ? ref.parentNode : this).insertBefore(element, ref);
  };
  var nodeRemove = Element.prototype.remove;
  S.remove = function remove(index) {
    if (arguments.length === 0) { nodeRemove.call(this); return; }
    var list = ensure(this), i = index | 0;
    if (i >= 0 && i < list.length) list[i].remove();
  };

  // the generic fallbacks on HTMLElement.prototype are no longer needed (forms must not have item/namedItem)
  delete HTMLElement.prototype.item; delete HTMLElement.prototype.namedItem; delete HTMLElement.prototype.add;
  // ---- HTMLOptionElement
  var O = Opt.prototype;
  def(O, "selected", function selected() { var s = ownerSelect(this); if (s) ensure(s); return getSel(this); },
    function selected(v) {
      var s = ownerSelect(this); if (s) ensure(s);
      this._sel = !!v; this._dirty = true;
      if (s && v && !s.hasAttribute("multiple")) { var self_ = this; ensure(s).forEach(function (o) { if (o !== self_) o._sel = false; }); }
      if (s) runReset(s);
      touch(); __jb.markDirty(this);
    });
  def(O, "index", function index() { var s = ownerSelect(this); if (!s) return 0; var i = ensure(s).indexOf(this); return i < 0 ? 0 : i; });
  def(O, "form", function form() { var s = ownerSelect(this) || this.closest("select"); return s ? s.form : null; });

  // The selected content attribute sets the selectedness of options that are not dirty.
  var baseAttr = __jb.attributeChanged;
  __jb.attributeChanged = function (el, attr, oldValue, newValue) {
    baseAttr(el, attr, oldValue, newValue);
    if (attr._ns !== null || el._ns !== __jb.HTML_NS) return;
    if (el._tag === "option" && attr._local === "selected" && !el._dirty) {
      var s = ownerSelect(el); if (s) ensure(s);
      el._sel = newValue !== null;
      if (s && el._sel && !s.hasAttribute("multiple")) ensure(s).forEach(function (o) { if (o !== el) o._sel = false; });
      if (s) runReset(s);
      touch();
    } else if (el._tag === "select" && (attr._local === "multiple" || attr._local === "size")) runReset(el);
  };
  // select[index] (getter and setter forward to the options collection).
  __jb.selectProxy = function (select) {
    var isIndex = function (k) { return typeof k === "string" && /^(0|[1-9][0-9]*)$/.test(k); };
    var proxy = new Proxy(select, {
      get: function (t, k, r) { if (isIndex(k)) return ensure(proxy)[Number(k)]; return Reflect.get(t, k, r); },
      set: function (t, k, v, r) { if (isIndex(k)) { proxy.options.__jbSetIndex.call(proxy.options, Number(k), v); return true; } return Reflect.set(t, k, v, r); },
      has: function (t, k) { if (isIndex(k)) return Number(k) < ensure(proxy).length; return k in t; },
      getOwnPropertyDescriptor: function (t, k) { if (isIndex(k)) { var o = ensure(proxy)[Number(k)]; return o ? { value: o, writable: true, enumerable: true, configurable: true } : undefined; } return Reflect.getOwnPropertyDescriptor(t, k); },
      ownKeys: function (t) { var keys = [], n = ensure(proxy).length; for (var i = 0; i < n; i++) keys.push(String(i)); return keys.concat(Reflect.ownKeys(t)); },
      defineProperty: function (t, k, d) { if (isIndex(k)) return false; return Reflect.defineProperty(t, k, d); },
    });
    return proxy;
  };
  // valueMissing: required, and nothing selected or only the placeholder label option.
  __jb.selectValueMissing = function (s) {
    var list = ensure(s), sel = list.filter(getSel);
    if (!sel.length) return true;
    if (sel.length !== 1 || s.hasAttribute("multiple") || displaySize(s) !== 1) return false;
    var first = list[0];
    return sel[0] === first && first.parentNode === s && first.value === "";
  };
  // Form reset: selectedness back to the selected attribute, not dirty.
  __jb.selectFormReset = function (s) { ensure(s).forEach(function (o) { o._sel = o.hasAttribute("selected"); o._dirty = false; }); runReset(s); touch(); };
})();
