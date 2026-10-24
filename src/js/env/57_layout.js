// Part 5c: CSSOM View geometry backed by the layout engine (Cargo feature
// "layout"). Boxes are document-relative CSS pixels from
// `__jb.layoutRect`; the viewport offset (window.scrollX/scrollY) is owned
// here. Without the feature every query degrades to the old zero-size
// behaviour.
(function () {
  var round = Math.round;
  // Box of a rendered element, null for display:none subtrees.
  // Options of a closed single-select live in the popup, not the page.
  function inClosedSelect(el) {
    if (el._ns !== __jb.HTML_NS || (el._tag !== "option" && el._tag !== "optgroup")) return false;
    for (var a = el.parentNode; a && a.nodeType === 1; a = a.parentNode) if (a._tag === "select" && a._ns === __jb.HTML_NS) return !a.multiple && (a.size || 0) <= 1;
    return false;
  }
  function boxOf(el) {
    if (inClosedSelect(el)) return null;
    var r = __jb.layoutRect(el);
    if (r && r.hidden) return null;
    if (r && r.width === 0 && r.height === 0 && !__jb.isRendered(el)) return null;
    if (!r) return null;
    // a viewport-fixed box is laid out at the top of the document: it shows at the window scroll
    if (r.fixed && (globalThis.scrollX || globalThis.scrollY)) {
      var fsx = globalThis.scrollX || 0, fsy = globalThis.scrollY || 0;
      r = Object.assign({}, r, { x: r.x + fsx, y: r.y + fsy, transformed: r.transformed ? [r.transformed[0] + fsx, r.transformed[1] + fsy, r.transformed[2], r.transformed[3]] : r.transformed });
    }
    // Element scroll containers are tracked here, not in the layout engine.
    var dx = 0, dy = 0;
    // flat tree: slotted content scrolls with the shadow tree's scroll container
    for (var a = __jb.flatParentElement ? __jb.flatParentElement(el) : el.parentNode; a && a.nodeType === 1; a = __jb.flatParentElement ? __jb.flatParentElement(a) : a.parentNode) { if (a._scrollTop) dy += a._scrollTop; if (a._scrollLeft) dx += a._scrollLeft; }
    return dx || dy ? Object.assign({}, r, { x: r.x - dx, y: r.y - dy, transformed: r.transformed ? [r.transformed[0] - dx, r.transformed[1] - dy, r.transformed[2], r.transformed[3]] : r.transformed }) : r;
  }
  // CSSOM client rects include CSS transforms (offset*/client* sizes do not).
  function clientBox(r) { var t = r.transformed; return t ? new DOMRect(t[0] - globalThis.scrollX, t[1] - globalThis.scrollY, t[2], t[3]) : new DOMRect(r.x - globalThis.scrollX, r.y - globalThis.scrollY, r.width, r.height); }
  function border(r) { return r && r.border ? r.border : [0, 0, 0, 0]; }
  // Padding-box size (CSSOM client*): border box minus borders.
  function clientSize(r) { var b = border(r); return { w: Math.max(0, r.width - b[1] - b[3]), h: Math.max(0, r.height - b[0] - b[2]) }; }
  function isScrollContainer(el) { if (el._ns === __jb.HTML_NS && (el._tag === "input" || el._tag === "textarea")) return true; var o = __jb.styleOf(el, "overflow") || __jb.styleOf(el, "overflow-y") || __jb.styleOf(el, "overflow-x"); return /^(auto|scroll|hidden|overlay|clip)$/.test(o); }
  // CSS Overflow 3 §3.3: with the root's overflow visible, the body's overflow is the viewport's
  // and the body box itself does not scroll.
  function bodyToViewport(el) {
    var d = __jb.currentDocument;
    if (el !== d.body || d._quirks || !d.documentElement) return false;
    try { var cs = getComputedStyle(d.documentElement); return cs.overflowX === "visible" && cs.overflowY === "visible"; } catch (e) { return false; }
  }
  // For scroll offset writes (not hot): real pages also consult the computed overflow.
  function canScroll(el) {
    if (el === __jb.currentDocument.body && bodyToViewport(el)) return false;
    if (isScrollContainer(el)) return true;
    var wpt = false; try { wpt = !!(__jb.wptMode || (__jb.topJb && __jb.topJb().wptMode)); } catch (e) {}
    if (wpt) return false;
    try { var cs = getComputedStyle(el), re = /^(auto|scroll|hidden|overlay|clip)$/; return re.test(cs.overflowY) || re.test(cs.overflowX); } catch (e) { return false; }
  }
  // Outermost elements with `cursor: pointer` (clickable widgets without interactive markup).
  __jb.pointerElements = function () {
    var ids = null;
    try { ids = __jb.layoutQuery("pointers"); } catch (e) { ids = null; }
    if (!Array.isArray(ids)) return [];
    var out = [];
    for (var i = 0; i < ids.length; i++) { var n = __jb.nodeById[ids[i]]; if (n && n.nodeType === 1 && n.isConnected) out.push(n); }
    return out;
  };
  __jb.boxOf = boxOf;
  function isNonReplacedInline(el) { return __jb.displayOf(el) === "inline" && !(el._ns === __jb.HTML_NS && __jb.ATOMIC_TAGS.test(el._tag)); }
  function docSize() { var s = __jb.layoutQuery("size"); return s ? { width: s.width, height: s.height } : { width: globalThis.innerWidth, height: globalThis.innerHeight }; }
  function isScrollingRoot(el) { return el === __jb.currentDocument.documentElement || (el === __jb.currentDocument.body && __jb.currentDocument._quirks); }

  // getBoundingClientRect/getClientRects through the same box filter.
  Element.prototype.getBoundingClientRect = function () {
    var r = boxOf(this);
    return r ? clientBox(r) : new DOMRect(0, 0, 0, 0);
  };
  Element.prototype.getClientRects = function () { var r = boxOf(this); return r ? [clientBox(r)] : []; };
  // The layout box without its transforms (GeometryUtils maps between untransformed boxes).
  __jb.untransformedClientRect = function (el) {
    var r = boxOf(el);
    return r ? new DOMRect(r.x - globalThis.scrollX, r.y - globalThis.scrollY, r.width, r.height) : new DOMRect(0, 0, 0, 0);
  };

  // ---- HTMLElement.offset* ----
  Object.defineProperties(HTMLElement.prototype, {
    offsetParent: {
      get: function () {
        if (!__jb.isRendered(this) || this._tag === "body" || this._tag === "html") return null;
        if (((__jb.computedValue && __jb.computedValue(this, "position")) || __jb.styleOf(this, "position")) === "fixed") return null;
        // Ancestors in the flat tree; ones closed-shadow-hidden from this element are skipped.
        var self_ = this;
        var flatParent = function (n) {
          var slot = typeof __jb.assignedSlotOf === "function" ? __jb.assignedSlotOf(n) : null;
          if (slot) return slot;
          var p = n.parentNode;
          if (p && p.nodeType === 11 && p._host) return p._host;
          return p && p.nodeType === 1 ? p : null;
        };
        var hidden = function (a) {
          var root = a.getRootNode();
          if (!(root.nodeType === 11 && root._host)) return false;
          for (var n = self_; n; n = n.nodeType === 11 && n._host ? n._host : n.parentNode) if (n === root) return false;
          return true; // a shadow tree the element is not in (retargeting, as engines do)
        };
        for (var a = flatParent(this); a; a = flatParent(a)) {
          // the cascaded position (Stylo, all style sheets incl. <link>), else the light model
          var pos = (__jb.computedValue && __jb.computedValue(a, "position")) || __jb.styleOf(a, "position");
          if (hidden(a)) { if (pos === "fixed") return null; continue; }
          if ((pos && pos !== "static") || (a._ns === __jb.HTML_NS && /^(td|th|table)$/.test(a._tag))) return a;
          if (a._tag === "body" && a._ns === __jb.HTML_NS) return a;
        }
        return null;
      },
      configurable: true,
    },
    offsetTop: { get: function () { var r = boxOf(this); if (!r) return 0; var p = this.offsetParent; var pr = p && p._tag !== "body" ? boxOf(p) : null; return round(r.y - (pr ? pr.y + border(pr)[0] : 0)); }, configurable: true },
    offsetLeft: { get: function () { var r = boxOf(this); if (!r) return 0; var p = this.offsetParent; var pr = p && p._tag !== "body" ? boxOf(p) : null; return round(r.x - (pr ? pr.x + border(pr)[3] : 0)); }, configurable: true },
    offsetWidth: { get: function () { var r = boxOf(this); return r ? round(r.width) : 0; }, configurable: true },
    offsetHeight: { get: function () { var r = boxOf(this); return r ? round(r.height) : 0; }, configurable: true },
  });

  // Scrollable overflow (CSSOM scrollWidth/scrollHeight): the padding box united with the
  // border boxes of descendants (a nested scroll container contributes only its own box),
  // measured from the scroll origin: the start edge (right edge for rtl in horizontal writing).
  // Real pages: within the layout reuse window (see __jb.layoutQuery) rects come from the same build,
  // so a subtree's scrollable overflow is measured once per build (pages poll scrollHeight).
  function scrollSize(el, r) {
    var st = __jb.layoutState, fresh = !__jb.wptMode && st.builtAt && Date.now() - st.builtAt < Math.max(250, 3 * (st.buildMs || 0));
    if (fresh && el._jbScrollSize && el._jbScrollSize.k === st.builtAt) return el._jbScrollSize.v;
    var v = scrollSizeUncached(el, r);
    if (!__jb.wptMode && st.builtAt) Object.defineProperty(el, "_jbScrollSize", { value: { k: st.builtAt, v: v }, writable: true, configurable: true });
    return v;
  }
  function scrollSizeUncached(el, r) {
    var raw = __jb.layoutRect(el) || r;
    var b = border(raw);
    var left = raw.x + b[3], top = raw.y + b[0], right = raw.x + raw.width - b[1], bottom = raw.y + raw.height - b[2];
    var minL = left, maxR = right, minT = top, maxB = bottom;
    var visit = function (c) {
      var cr = __jb.layoutRect(c);
      if (!cr || (cr.width === 0 && cr.height === 0 && __jb.wptMode && !__jb.isRendered(c))) return;
      var pos = __jb.styleOf(c, "position");
      if (pos === "fixed") return;
      if (cr.width > 0 || cr.height > 0) {
        minL = Math.min(minL, cr.x); maxR = Math.max(maxR, cr.x + cr.width);
        minT = Math.min(minT, cr.y); maxB = Math.max(maxB, cr.y + cr.height);
      }
      if (!isScrollContainer(c)) walk(c);
    };
    var walk = function (n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        // a <slot> in a shadow tree has no box: its content is what is assigned to it (flat
        // tree). Ionic's <ion-content> scrolls a shadow <main> whose only child is a slot, so its
        // scrollHeight was its own height and the page could not scroll (Raising Cane's).
        if (c._tag === "slot" && c._ns === __jb.HTML_NS && c.getRootNode && __jb.isShadowRoot && __jb.isShadowRoot(c.getRootNode())) {
          var assigned = [];
          try { assigned = c.assignedElements({ flatten: true }); } catch (e) {}
          if (assigned.length) { for (var ai = 0; ai < assigned.length; ai++) visit(assigned[ai]); continue; }
        }
        visit(c);
      }
      if (n._shadowRoot) walk(n._shadowRoot);
    };
    walk(el);
    var rtl = __jb.styleOf(el, "direction") === "rtl";
    // inline content overflow (text) as measured by the layout engine
    var hasText = false;
    for (var t = el.firstChild; t && !hasText; t = t.nextSibling) if (t.nodeType === 3 && /\S/.test(t.data)) hasText = true;
    if (hasText) {
      if (!rtl && raw.content_width) maxR = Math.max(maxR, left + raw.content_width);
      if (raw.content_height) maxB = Math.max(maxB, top + raw.content_height);
    }
    var o = scrollOrigin(el);
    var w = o.left ? right - minL : maxR - left, h = o.top ? bottom - minT : maxB - top;
    return { w: Math.max(w, right - left), h: Math.max(h, bottom - top) };
  }
  // Where the scroll origin is: overflow past it (to its start side) is unreachable. Block and
  // inline directions come from writing-mode/direction; flex containers flip by their reversed
  // main axis and wrap-reverse cross axis.
  function scrollOrigin(el) {
    var wm = __jb.styleOf(el, "writing-mode") || "horizontal-tb", rtl = __jb.styleOf(el, "direction") === "rtl";
    var vertical = /^(vertical|sideways)/.test(wm);
    var left = (!vertical && rtl) || wm === "vertical-rl" || wm === "sideways-rl";
    var top = vertical && (wm === "sideways-lr" ? !rtl : rtl);
    var display = __jb.styleOf(el, "display") || "";
    if (/(^|\s)(inline-)?flex$/.test(display) || display === "flex" || display === "inline-flex") {
      var fd = __jb.styleOf(el, "flex-direction") || "row", wrap = __jb.styleOf(el, "flex-wrap") || "";
      var mainVertical = (fd.indexOf("row") === 0) === vertical;
      if (/-reverse$/.test(fd)) { if (mainVertical) top = !top; else left = !left; }
      if (wrap === "wrap-reverse") { if (mainVertical) left = !left; else top = !top; }
    }
    return { left: left, top: top };
  }

  // Element scroll containers with an offset: screenshots paint them scrolled (engine.rs asks for
  // [layout id, x, y] triples).
  var scrolledEls = [];
  function noteScroll(el) { if (!el._jbScrollNoted) { el._jbScrollNoted = true; scrolledEls.push(el); } }
  __jb.elementScrolls = function () {
    var out = [], keep = [];
    for (var i = 0; i < scrolledEls.length; i++) {
      var el = scrolledEls[i];
      if (!el.isConnected) { el._jbScrollNoted = false; continue; }
      keep.push(el);
      if (!(el._scrollTop || el._scrollLeft)) continue;
      if (el.__jbid === undefined || __jb.nodeById[el.__jbid] !== el) __jb.assignLayoutIds();
      if (el.__jbid !== undefined) out.push([el.__jbid, el._scrollLeft || 0, el._scrollTop || 0]);
    }
    scrolledEls = keep;
    return __jb.hostJson(out);
  };

  // ---- Element.client* / scroll* ----
  Object.defineProperties(Element.prototype, {
    clientWidth: { get: function () { if (this === __jb.currentDocument.documentElement) return globalThis.innerWidth; var r = boxOf(this); return !r || isNonReplacedInline(this) ? 0 : round(clientSize(r).w); }, configurable: true },
    clientHeight: { get: function () { if (this === __jb.currentDocument.documentElement) return globalThis.innerHeight; var r = boxOf(this); return !r || isNonReplacedInline(this) ? 0 : round(clientSize(r).h); }, configurable: true },
    clientTop: { get: function () { var r = boxOf(this); return !r || isNonReplacedInline(this) ? 0 : round(border(r)[0]); }, configurable: true },
    clientLeft: { get: function () { var r = boxOf(this); return !r || isNonReplacedInline(this) ? 0 : round(border(r)[3]); }, configurable: true },
    scrollWidth: { get: function () { if (isScrollingRoot(this) || this === __jb.currentDocument.body) return round(Math.max(docSize().width, globalThis.innerWidth)); var r = boxOf(this); if (!r || isNonReplacedInline(this)) return 0; if (this._ns === __jb.HTML_NS && /^(input|textarea|select)$/.test(this._tag)) return round(Math.max(clientSize(r).w, r.content_width || 0)); return round(scrollSize(this, r).w); }, configurable: true },
    scrollHeight: { get: function () { if (isScrollingRoot(this) || this === __jb.currentDocument.body) return round(Math.max(docSize().height, globalThis.innerHeight)); var r = boxOf(this); if (!r || isNonReplacedInline(this)) return 0; if (this._ns === __jb.HTML_NS && /^(input|textarea|select)$/.test(this._tag)) return round(Math.max(clientSize(r).h, r.content_height || 0)); return round(scrollSize(this, r).h); }, configurable: true },
    scrollTop: {
      get: function () { return isScrollingRoot(this) ? globalThis.scrollY : (this._scrollTop || 0); },
      set: function (v) { v = Number(v); if (!isFinite(v)) v = 0; if (isScrollingRoot(this)) { globalThis.scrollTo(globalThis.scrollX, v); return; } if (!canScroll(this)) return; if (__jb.snapScroll && !__jb._snapBusy) { __jb._snapBusy = true; try { v = __jb.snapScroll(this, this._scrollLeft || 0, v)[1]; } finally { __jb._snapBusy = false; } } var max = this._ns === __jb.HTML_NS && (this._tag === "input" || this._tag === "textarea") ? Infinity : this.scrollHeight - this.clientHeight; this._scrollTop = Math.min(Math.max(0, v), Math.max(0, max)); noteScroll(this); __jb.scheduleObserverCheck(); },
      configurable: true,
    },
    scrollLeft: {
      get: function () { return isScrollingRoot(this) ? globalThis.scrollX : (this._scrollLeft || 0); },
      set: function (v) { v = Number(v); if (!isFinite(v)) v = 0; if (isScrollingRoot(this)) { globalThis.scrollTo(v, globalThis.scrollY); return; } if (!canScroll(this)) return; if (__jb.snapScroll && !__jb._snapBusy) { __jb._snapBusy = true; try { v = __jb.snapScroll(this, v, this._scrollTop || 0)[0]; } finally { __jb._snapBusy = false; } } var max = this._ns === __jb.HTML_NS && (this._tag === "input" || this._tag === "textarea") ? Infinity : this.scrollWidth - this.clientWidth; this._scrollLeft = Math.min(Math.max(0, v), Math.max(0, max)); noteScroll(this); __jb.scheduleObserverCheck(); },
      configurable: true,
    },
  });
  // ---- CSS Scroll Snap: programmatic scrolls of a snap container end at a snap position ----
  // the light author cascade (<style> sheets and style attributes) is enough here and cheap
  var cssOf = function (el, p) {
    var v = __jb.styleOf(el, p);
    if (!v && /^scroll-(margin|padding)-/.test(p)) {
      var sh = __jb.styleOf(el, p.replace(/-(top|right|bottom|left)$/, "")).split(/\s+/).filter(Boolean);
      var idx = { top: 0, right: 1, bottom: 2, left: 3 }[p.replace(/^.*-/, "")];
      if (sh.length) v = sh[idx] !== undefined ? sh[idx] : idx === 3 && sh[1] !== undefined ? sh[1] : idx === 2 ? sh[0] : sh[sh.length > 1 ? 1 : 0];
    }
    return v || "";
  };
  var pxv = function (v) { var n = parseFloat(v); return isFinite(n) ? n : 0; };
  __jb.snapScroll = function (container, x, y) {
    // snap containers are resolved through getComputedStyle (the layout engine does not parse
    // scroll-snap-*); real pages scroll without snapping
    var wpt = false; try { wpt = !!(__jb.wptMode || (__jb.topJb && __jb.topJb().wptMode)); } catch (e) {}
    if (!wpt) return [x, y];
    var root = !container || container === __jb.currentDocument.documentElement || container === __jb.currentDocument.scrollingElement;
    var styleEl = root ? __jb.currentDocument.documentElement : container;
    if (!styleEl) return [x, y];
    var type = cssOf(styleEl, "scroll-snap-type").trim().toLowerCase();
    if (!type || type === "none") return [x, y];
    var parts = type.split(/\s+/), axis = parts[0], strict = parts[1] || "proximity";
    var doX = axis === "x" || axis === "both" || axis === "inline", doY = axis === "y" || axis === "both" || axis === "block";
    var cr = root ? { left: -globalThis.scrollX, top: -globalThis.scrollY } : container.getBoundingClientRect();
    var sx = root ? globalThis.scrollX : (container._scrollLeft || 0), sy = root ? globalThis.scrollY : (container._scrollTop || 0);
    var cl = root ? 0 : container.clientLeft, ct = root ? 0 : container.clientTop;
    var vw = root ? globalThis.innerWidth : container.clientWidth, vh = root ? globalThis.innerHeight : container.clientHeight;
    var pad = function (side) { var v = cssOf(styleEl, "scroll-padding-" + side); return v === "auto" ? 0 : pxv(v); };
    var pl = pad("left"), pt = pad("top"), pr = pad("right"), pb = pad("bottom");
    var bestX = null, bestY = null;
    var areas = (root ? __jb.currentDocument.body || __jb.currentDocument.documentElement : container).querySelectorAll("*");
    for (var i = 0; i < areas.length; i++) {
      var a = areas[i], align = cssOf(a, "scroll-snap-align").trim().toLowerCase();
      if (!align || align === "none") continue;
      var al = align.split(/\s+/), ay = al[0], ax = al[1] || al[0];
      var r = a.getBoundingClientRect();
      if (!(r.width || r.height)) continue;
      var left = r.left - (root ? 0 : cr.left + cl) + (root ? globalThis.scrollX : sx), top = r.top - (root ? 0 : cr.top + ct) + (root ? globalThis.scrollY : sy);
      var ml = pxv(cssOf(a, "scroll-margin-left")), mt = pxv(cssOf(a, "scroll-margin-top")), mr = pxv(cssOf(a, "scroll-margin-right")), mb = pxv(cssOf(a, "scroll-margin-bottom"));
      var cand = function (al1, start, size, mS, mE, pS, pE, port) {
        if (al1 === "start") return start - mS - pS;
        if (al1 === "end") return start + size + mE + pE - port;
        if (al1 === "center") return start + size / 2 - (port - pS - pE) / 2 - pS;
        return null;
      };
      if (doX) { var cx = cand(ax, left, r.width, ml, mr, pl, pr, vw); if (cx !== null && (bestX === null || Math.abs(cx - x) < Math.abs(bestX - x))) bestX = cx; }
      if (doY) { var cy = cand(ay, top, r.height, mt, mb, pt, pb, vh); if (cy !== null && (bestY === null || Math.abs(cy - y) < Math.abs(bestY - y))) bestY = cy; }
    }
    var near = function (best, v, port) { return best !== null && (strict === "mandatory" || Math.abs(best - v) <= port / 3); };
    return [near(bestX, x, vw) ? Math.round(bestX) : x, near(bestY, y, vh) ? Math.round(bestY) : y];
  };
  Element.prototype.scrollTo = function (x, y) {
    if (x !== null && typeof x === "object") { y = x.top; x = x.left; }
    if (isScrollingRoot(this)) { globalThis.scrollTo(x, y); return; }
    if (!canScroll(this)) return;
    var before = [this._scrollLeft || 0, this._scrollTop || 0];
    var snapped = __jb.snapScroll(this, x === undefined ? before[0] : Number(x) || 0, y === undefined ? before[1] : Number(y) || 0);
    x = snapped[0]; y = snapped[1];
    if (x !== undefined) this.scrollLeft = Number(x) || 0;
    if (y !== undefined) this.scrollTop = Number(y) || 0;
    if (before[0] === (this._scrollLeft || 0) && before[1] === (this._scrollTop || 0)) return;
    var self_ = this;
    setTimeout(function () { __jb.fireUA(self_, "scroll", { bubbles: false }); __jb.checkObservers(); }, 0);
  };
  Element.prototype.scroll = Element.prototype.scrollTo;
  Element.prototype.scrollBy = function (x, y) {
    if (x !== null && typeof x === "object") { y = x.top; x = x.left; }
    this.scrollTo(this.scrollLeft + (Number(x) || 0), this.scrollTop + (Number(y) || 0));
  };
  // How far a scrollport must scroll to align a box at `off` (from the port's start) of `size`.
  function alignDelta(off, size, port, mode) {
    if (mode === "start") return off;
    if (mode === "end") return off + size - port;
    if (mode === "center") return off + size / 2 - port / 2;
    if (off < 0 || size > port) return off;
    if (off + size > port) return off + size - port;
    return 0;
  }
  // Parent in the flat tree: a slotted element's slot, a shadow root's host (scroll containers
  // around slotted content live in the shadow tree: Ionic's <ion-content> scrolls a shadow <main>).
  __jb.flatParentElement = function (x) {
    if (!x) return null;
    var s = x.assignedSlot; if (s) return s;
    if (x.parentElement) return x.parentElement;
    var p = x.parentNode; return p && p.host ? p.host : null;
  };
  Element.prototype.scrollIntoView = function (arg) {
    var r = boxOf(this);
    if (!r) return;
    var block = "start", inline = "nearest";
    if (arg === false) block = "end";
    else if (arg !== null && typeof arg === "object") { block = arg.block || "start"; inline = arg.inline || "nearest"; }
    // every scroll container between the element and the viewport, innermost first (CSSOM View
    // "scroll an element into view")
    for (var a = __jb.flatParentElement(this); a && !isScrollingRoot(a); a = __jb.flatParentElement(a)) {
      if (!canScroll(a)) continue;
      var sh = a.scrollHeight > a.clientHeight + 1, sw = a.scrollWidth > a.clientWidth + 1;
      if (!sh && !sw) continue;
      var cr = boxOf(a), er = boxOf(this);
      if (!cr || !er) continue;
      var cb = border(cr), cs = clientSize(cr);
      var dy = sh ? alignDelta(er.y - (cr.y + cb[0]), er.height, cs.h, block) : 0;
      var dx = sw ? alignDelta(er.x - (cr.x + cb[3]), er.width, cs.w, inline) : 0;
      if (dx || dy) a.scrollTo((a._scrollLeft || 0) + dx, (a._scrollTop || 0) + dy);
    }
    r = boxOf(this);
    if (!r || r.fixed) return;
    var vh = globalThis.innerHeight, vw = globalThis.innerWidth, y = globalThis.scrollY, x = globalThis.scrollX;
    if (block === "start") y = r.y; else if (block === "end") y = r.y + r.height - vh; else if (block === "center") y = r.y + r.height / 2 - vh / 2;
    else if (r.y < y) y = r.y; else if (r.y + r.height > y + vh) y = r.y + r.height - vh;
    if (inline === "start") x = r.x; else if (inline === "end") x = r.x + r.width - vw; else if (inline === "center") x = r.x + r.width / 2 - vw / 2;
    else if (r.x < x) x = r.x; else if (r.x + r.width > x + vw) x = r.x + r.width - vw;
    globalThis.scrollTo(x, y);
  };
  Element.prototype.scrollIntoViewIfNeeded = function (center) { this.scrollIntoView({ block: center === false ? "nearest" : "center", inline: center === false ? "nearest" : "center" }); };
  Element.prototype.checkVisibility = function (opts) {
    if (!__jb.isRendered(this)) return false;
    var r = boxOf(this);
    if (!r || (r.width === 0 && r.height === 0)) return false;
    if (opts && (opts.checkVisibilityCSS || opts.visibilityProperty) && __jb.innerTextContext(this).vis !== "visible") return false;
    if (opts && (opts.checkOpacity || opts.opacityProperty)) { for (var a = this; a && a.nodeType === 1; a = a.parentNode) if (__jb.styleOf(a, "opacity") === "0") return false; }
    return true;
  };

  // ---- window scrolling ----
  function clamp(v, max) { return Math.min(Math.max(0, v), Math.max(0, max)); }
  globalThis.scrollTo = globalThis.scroll = function (x, y) {
    if (x !== null && typeof x === "object") { y = x.top; x = x.left; }
    var snapped = __jb.snapScroll(null, x === undefined ? globalThis.scrollX : Number(x) || 0, y === undefined ? globalThis.scrollY : Number(y) || 0);
    x = snapped[0]; y = snapped[1];
    var s = docSize();
    var nx = x === undefined ? globalThis.scrollX : clamp(Number(x) || 0, s.width - globalThis.innerWidth);
    var ny = y === undefined ? globalThis.scrollY : clamp(Number(y) || 0, s.height - globalThis.innerHeight);
    if (nx === globalThis.scrollX && ny === globalThis.scrollY) return;
    globalThis.scrollX = globalThis.pageXOffset = nx;
    globalThis.scrollY = globalThis.pageYOffset = ny;
    if (globalThis.visualViewport) { globalThis.visualViewport.pageLeft = nx; globalThis.visualViewport.pageTop = ny; }
    setTimeout(function () { __jb.fireUA(__jb.currentDocument, "scroll", { bubbles: true }); __jb.checkObservers(); }, 0);
  };
  globalThis.scrollBy = function (x, y) {
    if (x !== null && typeof x === "object") { y = x.top; x = x.left; }
    globalThis.scrollTo(globalThis.scrollX + (Number(x) || 0), globalThis.scrollY + (Number(y) || 0));
  };

  Object.defineProperty(Document.prototype, "scrollingElement", {
    get: function () { if (this._quirks) { var b = this.body; return b && b._tag === "body" ? b : null; } return this.documentElement || null; },
    configurable: true,
  });

  // ---- point queries ----
  // Top-layer elements (showing popovers, open dialogs) are hit-tested from
  // their own boxes first: the layout engine keeps them in flow order and
  // does not know about the top layer.
  function deepestAt(root, x, y) {
    var best = null;
    (function walk(n) {
      if (n.nodeType !== 1) return;
      var r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) best = n;
      for (var c = n.firstChild; c; c = c.nextSibling) walk(c);
    })(root);
    return best;
  }
  // HTML image maps: a hit on <img usemap> resolves to the first <area> of the map whose shape
  // contains the point ("rules for parsing a hash-name reference", area shapes and coords).
  __jb.imageMapFor = function (img) {
    var raw = img.getAttribute("usemap");
    if (raw === null) return null;
    var hash = raw.indexOf("#");
    if (hash < 0) return null;
    var name = raw.slice(hash + 1);
    if (name === "") return null;
    var root = img.getRootNode(), stack = [root];
    while (stack.length) { var n = stack.pop(); if (n.nodeType === 1 && n._local === "map" && n._ns === __jb.HTML_NS && (n.getAttribute("name") === name || n.getAttribute("id") === name)) return n; for (var c = n.lastChild; c; c = c.previousSibling) stack.push(c); }
    return null;
  };
  __jb.parseFloatList = function (input) {
    return String(input).split(/[^0-9.eE+\-]+/).filter(function (t) { return t !== ""; }).map(function (t) { var v = parseFloat(t); return isFinite(v) ? v : 0; });
  };
  __jb.areaContains = function (area, x, y) {
    var shape = (area.getAttribute("shape") || "rect").trim().toLowerCase();
    var c = __jb.parseFloatList(area.getAttribute("coords") || "");
    if (shape === "default") return true;
    if (shape === "circle" || shape === "circ") { if (c.length < 3 || c[2] <= 0) return false; var dx = x - c[0], dy = y - c[1]; return dx * dx + dy * dy <= c[2] * c[2]; }
    if (shape === "poly" || shape === "polygon") {
      if (c.length < 6) return false;
      var pts = []; for (var i = 0; i + 1 < c.length; i += 2) pts.push([c[i], c[i + 1]]);
      var inside = false;
      for (var a = 0, b = pts.length - 1; a < pts.length; b = a++) { var pa = pts[a], pb = pts[b]; if (((pa[1] > y) !== (pb[1] > y)) && x <= (pb[0] - pa[0]) * (y - pa[1]) / (pb[1] - pa[1]) + pa[0]) inside = !inside; }
      return inside;
    }
    if (shape === "rect" || shape === "rectangle") { if (c.length < 4) return false; var x0 = Math.min(c[0], c[2]), x1 = Math.max(c[0], c[2]), y0 = Math.min(c[1], c[3]), y1 = Math.max(c[1], c[3]); return x >= x0 && x < x1 && y >= y0 && y < y1; }
    return false;
  };
  __jb.imageMapHit = function (el, px, py) {
    if (!(el._ns === __jb.HTML_NS && el._tag === "img")) return el;
    var map = __jb.imageMapFor(el);
    if (!map) return el;
    var box = __jb.boxOf ? __jb.boxOf(el) : null;
    if (!box) return el;
    var b = box.border || [0, 0, 0, 0], pad = box.padding || [0, 0, 0, 0];
    var rx = px - box.x - b[3] - pad[3], ry = py - box.y - b[0] - pad[0];
    var areas = __jb.descendants(map, function (n) { return n.nodeType === 1 && n._local === "area" && n._ns === __jb.HTML_NS; });
    for (var i = 0; i < areas.length; i++) if (__jb.areaContains(areas[i], rx, ry)) return areas[i];
    return el;
  };
  Document.prototype.elementFromPoint = function (x, y) {
    x = Number(x); y = Number(y);
    if (!(x >= 0 && y >= 0 && x <= globalThis.innerWidth && y <= globalThis.innerHeight)) return null;
    if (__jb.topLayer) for (var ti = __jb.topLayer.length - 1; ti >= 0; ti--) {
      var top = __jb.topLayer[ti];
      if (!top.isConnected || top.ownerDocument !== this) continue;
      if (!(top._popoverState === "showing" || (top._tag === "dialog" && top.hasAttribute("open")))) continue;
      var hit = deepestAt(top, x, y);
      if (hit) return hit;
    }
    var pq = { x: x + globalThis.scrollX, y: y + globalThis.scrollY, sx: globalThis.scrollX || 0, sy: globalThis.scrollY || 0 };
    // scrolled element panes shift what lies under the point
    if (!__jb.wptMode && typeof __jb.elementScrolls === "function") { try { var scr = JSON.parse(__jb.elementScrolls()); if (scr.length) pq.scrolls = scr; } catch (e) {} }
    var id = __jb.layoutQuery("point", pq);
    var el = id !== null && id !== undefined && __jb.nodeById ? __jb.nodeById[id] : null;
    if (el) el = __jb.imageMapHit(el, x + globalThis.scrollX, y + globalThis.scrollY);
    return el || this.documentElement || null;
  };
  // The hit test runs on the flat tree; results are retargeted against the document or shadow root asked.
  var rawElementFromPoint = Document.prototype.elementFromPoint;
  __jb.hitTestPoint = function (doc, x, y) { return rawElementFromPoint.call(doc, x, y); };
  Document.prototype.elementFromPoint = function elementFromPoint(x, y) {
    var hit = rawElementFromPoint.call(this, x, y);
    return hit ? __jb.retargetNode(hit, this) : hit;
  };
  var flatAncestors = function (hit, scope) {
    var out = [];
    for (var a = hit; a; ) {
      if (a.nodeType === 1) { var r = __jb.retargetNode(a, scope); if (out.indexOf(r) < 0) out.push(r); }
      var slot = a.nodeType === 1 && typeof __jb.assignedSlotOf === "function" ? __jb.assignedSlotOf(a) : null;
      a = slot || (a.parentNode && a.parentNode.nodeType === 11 && a.parentNode._host ? a.parentNode._host : a.parentNode);
      if (a && a.nodeType === 9) break;
    }
    return out;
  };
  Document.prototype.elementsFromPoint = function elementsFromPoint(x, y) {
    var hit = rawElementFromPoint.call(this, x, y);
    return hit ? flatAncestors(hit, this) : [];
  };
  ShadowRoot.prototype.elementFromPoint = function elementFromPoint(x, y) {
    var doc = this.ownerDocument || __jb.currentDocument, hit = rawElementFromPoint.call(doc, x, y);
    return hit ? __jb.retargetNode(hit, this) : null;
  };
  ShadowRoot.prototype.elementsFromPoint = function elementsFromPoint(x, y) {
    var doc = this.ownerDocument || __jb.currentDocument, hit = rawElementFromPoint.call(doc, x, y);
    return hit ? flatAncestors(hit, this) : [];
  };

  // ---- IntersectionObserver / ResizeObserver with real geometry ----
  var observers = [], resizeObservers = [], scheduled = false;
  function viewportRect() { return { x: globalThis.scrollX, y: globalThis.scrollY, width: globalThis.innerWidth, height: globalThis.innerHeight }; }
  function toClient(r) { return new DOMRectReadOnly(r.x - globalThis.scrollX, r.y - globalThis.scrollY, r.width, r.height); }
  var ABS_UNITS = { px: 1, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 25.4 / 4, in: 96, pt: 96 / 72, pc: 16 };
  // Parses a rootMargin string into 4 {v, pct} parts (top, right, bottom, left)
  // or returns null when it is not a list of 1-4 absolute lengths/percentages.
  function parseMarginParts(str) {
    var trimmed = String(str).trim();
    if (trimmed === "") return [{ v: 0, pct: false }, { v: 0, pct: false }, { v: 0, pct: false }, { v: 0, pct: false }];
    var parts = trimmed.split(/\s+/);
    if (parts.length < 1 || parts.length > 4) return null;
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var m = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(px|cm|mm|q|in|pt|pc|%)$/i.exec(parts[i]);
      if (!m) { if (/^-?(\d+\.?\d*|\.\d+)$/.test(parts[i]) && parseFloat(parts[i]) === 0) { out.push({ v: 0, pct: false }); continue; } return null; }
      var unit = m[2].toLowerCase();
      out.push(unit === "%" ? { v: parseFloat(m[1]), pct: true } : { v: Math.trunc(parseFloat(m[1]) * ABS_UNITS[unit]), pct: false });
    }
    while (out.length < 4) out.push(out[out.length === 1 ? 0 : out.length - 2]);
    return out;
  }
  function parseMargin(str, root) {
    var parts = parseMarginParts(str || "0px") || [{ v: 0 }, { v: 0 }, { v: 0 }, { v: 0 }];
    return parts.map(function (p, i) { return p.pct ? p.v / 100 * (i % 2 ? root.width : root.height) : p.v; });
  }
  function intersection(io, t) {
    var r = boxOf(t);
    var root = io.root && io.root.nodeType === 1 ? boxOf(io.root) : viewportRect();
    if (!root) root = viewportRect();
    var m = parseMargin(io.rootMargin, root);
    root = { x: root.x - m[3], y: root.y - m[0], width: root.width + m[1] + m[3], height: root.height + m[0] + m[2] };
    var ratio = 0, isIntersecting = false, ir = { x: 0, y: 0, width: 0, height: 0 };
    if (r) {
      var x0 = Math.max(r.x, root.x), y0 = Math.max(r.y, root.y), x1 = Math.min(r.x + r.width, root.x + root.width), y1 = Math.min(r.y + r.height, root.y + root.height);
      if (x1 >= x0 && y1 >= y0) {
        isIntersecting = true;
        ir = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        var area = r.width * r.height;
        ratio = area > 0 ? (ir.width * ir.height) / area : 1;
      }
    }
    return {
      time: typeof performance !== "undefined" ? performance.now() : Date.now(),
      target: t,
      isIntersecting: isIntersecting,
      intersectionRatio: ratio,
      boundingClientRect: toClient(r || { x: 0, y: 0, width: 0, height: 0 }),
      rootBounds: io.root ? toClient(root) : toClient(root),
      intersectionRect: toClient(ir),
      isVisible: false,
    };
  }
  function thresholdIndex(io, ratio, intersecting) {
    if (!intersecting) return -1;
    var i = 0;
    while (i < io.thresholds.length && io.thresholds[i] <= ratio) i++;
    return i;
  }
  function need(args, n, what) { if (args.length < n) throw new TypeError(what + ": " + n + " argument(s) required, but only " + args.length + " present"); }
  function idlClass(C, name) {
    Object.getOwnPropertyNames(C.prototype).forEach(function (p) {
      if (p === "constructor" || p.charAt(0) === "_") return;
      var d = Object.getOwnPropertyDescriptor(C.prototype, p);
      if (!d.enumerable) { d.enumerable = true; Object.defineProperty(C.prototype, p, d); }
    });
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
    Object.defineProperty(globalThis, name, { value: C, writable: true, configurable: true, enumerable: false });
  }
  function checkIO(o) { if (!o || !o._io) throw new TypeError("Illegal invocation"); return o._io; }
  class IntersectionObserver {
    constructor(cb, opts) {
      need(arguments, 1, "IntersectionObserver");
      if (typeof cb !== "function") throw new TypeError("IntersectionObserver: callback is not a function");
      opts = opts || {};
      if (opts.root !== undefined && opts.root !== null && !(opts.root instanceof Element) && !(opts.root instanceof Document)) throw new TypeError("IntersectionObserver: root must be an Element or Document");
      var th = opts.threshold === undefined ? [0] : (opts.threshold !== null && typeof opts.threshold === "object" && typeof opts.threshold[Symbol.iterator] === "function") ? __jb.arrayFrom(opts.threshold, Number) : [Number(opts.threshold)];
      th.forEach(function (v) { if (!isFinite(v)) throw new TypeError("IntersectionObserver: threshold values must be finite"); if (!(v >= 0 && v <= 1)) throw new RangeError("IntersectionObserver: threshold values must be between 0 and 1"); });
      if (!th.length) th = [0];
      var marginParts = parseMarginParts(opts.rootMargin === undefined ? "0px" : opts.rootMargin);
      if (!marginParts) throw __jb.domError("SyntaxError", "IntersectionObserver: rootMargin must be specified in pixels or percent");
      var scrollParts = parseMarginParts(opts.scrollMargin === undefined ? "0px" : opts.scrollMargin);
      if (!scrollParts) throw __jb.domError("SyntaxError", "IntersectionObserver: scrollMargin must be specified in pixels or percent");
      var delay = opts.delay === undefined ? 0 : Math.max(0, Number(opts.delay) || 0);
      var track = !!opts.trackVisibility;
      if (track && delay < 100) delay = 100;
      var fmt = function (parts) { return parts.map(function (p) { return p.pct ? p.v + "%" : p.v + "px"; }).join(" "); };
      Object.defineProperty(this, "_io", { value: {
        cb: cb, root: opts.root || null, rootMargin: fmt(marginParts), scrollMargin: fmt(scrollParts),
        thresholds: Object.freeze(th.slice().sort(function (a, b) { return a - b; })), delay: delay, trackVisibility: track,
        targets: [], prev: new Map(), queued: [], self: this,
      } });
      observers.push(this._io);
    }
    get root() { return checkIO(this).root; }
    get rootMargin() { return checkIO(this).rootMargin; }
    get scrollMargin() { return checkIO(this).scrollMargin; }
    get thresholds() { return checkIO(this).thresholds; }
    get delay() { return checkIO(this).delay; }
    get trackVisibility() { return checkIO(this).trackVisibility; }
    observe(t) {
      var io = checkIO(this); need(arguments, 1, "IntersectionObserver.observe");
      if (!(t instanceof Element)) throw new TypeError("IntersectionObserver.observe: Argument 1 is not an Element");
      if (io.targets.indexOf(t) >= 0) return;
      io.targets.push(t); io.prev.set(t, -2);
      __jb.scheduleObserverCheck();
    }
    unobserve(t) {
      var io = checkIO(this); need(arguments, 1, "IntersectionObserver.unobserve");
      if (!(t instanceof Element)) throw new TypeError("IntersectionObserver.unobserve: Argument 1 is not an Element");
      io.targets = io.targets.filter(function (x) { return x !== t; }); io.prev.delete(t); io.queued = io.queued.filter(function (e) { return e.target !== t; });
    }
    disconnect() { var io = checkIO(this); io.targets = []; io.prev = new Map(); io.queued = []; }
    takeRecords() { var io = checkIO(this); var q = io.queued; io.queued = []; return q; }
  }
  idlClass(IntersectionObserver, "IntersectionObserver");
  class IntersectionObserverEntry {
    constructor(init) {
      need(arguments, 1, "IntersectionObserverEntry");
      init = init || {};
      ["time", "boundingClientRect", "intersectionRect", "intersectionRatio", "target"].forEach(function (k) { if (init[k] === undefined) throw new TypeError("IntersectionObserverEntryInit." + k + " is required"); });
      var rect = function (r) { return r === null || r === undefined ? null : DOMRectReadOnly.fromRect ? DOMRectReadOnly.fromRect(r) : new DOMRectReadOnly(r.x, r.y, r.width, r.height); };
      Object.defineProperty(this, "_e", { value: {
        time: Number(init.time), rootBounds: rect(init.rootBounds), boundingClientRect: rect(init.boundingClientRect), intersectionRect: rect(init.intersectionRect),
        isIntersecting: !!init.isIntersecting, isVisible: !!init.isVisible, intersectionRatio: Number(init.intersectionRatio), target: init.target,
      } });
    }
    get time() { return this._e.time; }
    get rootBounds() { return this._e.rootBounds; }
    get boundingClientRect() { return this._e.boundingClientRect; }
    get intersectionRect() { return this._e.intersectionRect; }
    get isIntersecting() { return this._e.isIntersecting; }
    get isVisible() { return this._e.isVisible; }
    get intersectionRatio() { return this._e.intersectionRatio; }
    get target() { return this._e.target; }
  }
  idlClass(IntersectionObserverEntry, "IntersectionObserverEntry");
  function makeIOEntry(e) {
    var o = Object.create(IntersectionObserverEntry.prototype);
    Object.defineProperty(o, "_e", { value: e });
    return o;
  }

  // ResizeObserver: content box / border box / device-pixel content box sizes.
  var constructingRO = false;
  function checkRO(o) { if (!o || !o._ro) throw new TypeError("Illegal invocation"); return o._ro; }
  class ResizeObserver {
    constructor(cb) {
      need(arguments, 1, "ResizeObserver");
      if (typeof cb !== "function") throw new TypeError("ResizeObserver: callback is not a function");
      Object.defineProperty(this, "_ro", { value: { cb: cb, targets: [], last: new Map(), boxes: new Map(), self: this } });
      resizeObservers.push(this._ro);
    }
    observe(t, opts) {
      var ro = checkRO(this); need(arguments, 1, "ResizeObserver.observe");
      if (!(t instanceof Element)) throw new TypeError("ResizeObserver.observe: Argument 1 is not an Element");
      var box = opts && opts.box !== undefined ? String(opts.box) : "content-box";
      if (["content-box", "border-box", "device-pixel-content-box"].indexOf(box) < 0) throw new TypeError("ResizeObserver.observe: invalid box");
      if (ro.targets.indexOf(t) < 0) ro.targets.push(t);
      ro.boxes.set(t, box); ro.last.set(t, null);
      __jb.scheduleObserverCheck();
    }
    unobserve(t) {
      var ro = checkRO(this); need(arguments, 1, "ResizeObserver.unobserve");
      if (!(t instanceof Element)) throw new TypeError("ResizeObserver.unobserve: Argument 1 is not an Element");
      ro.targets = ro.targets.filter(function (x) { return x !== t; }); ro.last.delete(t); ro.boxes.delete(t);
    }
    disconnect() { var ro = checkRO(this); ro.targets = []; ro.last = new Map(); ro.boxes = new Map(); }
  }
  idlClass(ResizeObserver, "ResizeObserver");
  class ResizeObserverSize {
    constructor() { if (!constructingRO) throw new TypeError("Illegal constructor"); }
    get inlineSize() { return this._i; }
    get blockSize() { return this._b; }
  }
  idlClass(ResizeObserverSize, "ResizeObserverSize");
  function roSize(i, b) { constructingRO = true; var s; try { s = new ResizeObserverSize(); } finally { constructingRO = false; } Object.defineProperties(s, { _i: { value: i }, _b: { value: b } }); return s; }
  class ResizeObserverEntry {
    constructor() { if (!constructingRO) throw new TypeError("Illegal constructor"); }
    get target() { return this._d.target; }
    get contentRect() { return this._d.contentRect; }
    get borderBoxSize() { return this._d.borderBoxSize; }
    get contentBoxSize() { return this._d.contentBoxSize; }
    get devicePixelContentBoxSize() { return this._d.devicePixelContentBoxSize; }
  }
  idlClass(ResizeObserverEntry, "ResizeObserverEntry");
  function roEntry(d) { constructingRO = true; var e; try { e = new ResizeObserverEntry(); } finally { constructingRO = false; } Object.defineProperty(e, "_d", { value: d }); return e; }
  // Box sizes of an element: border box and content box (SVG elements use their bbox).
  function boxSizes(t) {
    if (t._ns === __jb.SVG_NS && typeof t.getBBox === "function" && t._tag !== "svg") {
      var bb = t.getBBox();
      return { cw: bb.width, ch: bb.height, bw: bb.width, bh: bb.height, px: 0, py: 0 };
    }
    var r = boxOf(t);
    if (!r || isNonReplacedInline(t)) return { cw: 0, ch: 0, bw: 0, bh: 0, px: 0, py: 0 };
    var b = border(r), p = r.padding || [0, 0, 0, 0];
    var cw = Math.max(0, r.width - b[1] - b[3] - p[1] - p[3]), ch = Math.max(0, r.height - b[0] - b[2] - p[0] - p[2]);
    return { cw: cw, ch: ch, bw: r.width, bh: r.height, px: p[3], py: p[0] };
  }
  // Runs after layout-affecting changes and scrolls: delivers intersection
  // and resize notifications whose state changed.
  __jb.checkObservers = function () {
    observers.forEach(function (io) {
      var entries = [];
      io.targets.slice().forEach(function (t) {
        var e = intersection(io, t);
        var idx = thresholdIndex(io, e.intersectionRatio, e.isIntersecting);
        var prev = io.prev.get(t);
        if (prev === -2 || prev !== idx) { io.prev.set(t, idx); entries.push(makeIOEntry(e)); }
      });
      if (entries.length) { io.queued = []; try { __jb.loafRun("user-callback", "IntersectionObserverCallback", io.cb, io.self, [entries, io.self]); } catch (err) { __jb.reportException(err); } }
    });
    resizeObservers.forEach(function (ro) {
      var entries = [];
      ro.targets.slice().forEach(function (t) {
        var sz = boxSizes(t), box = ro.boxes.get(t) || "content-box";
        var last = ro.last.get(t);
        var key = box === "border-box" ? sz.bw + "x" + sz.bh : sz.cw + "x" + sz.ch;
        if (last === null || last === undefined ? true : last !== key) {
          var first = last === null || last === undefined;
          ro.last.set(t, key);
          var r = Math.round;
          entries.push(roEntry({
            target: t,
            contentRect: new DOMRectReadOnly(sz.px, sz.py, sz.cw, sz.ch),
            borderBoxSize: Object.freeze([roSize(sz.bw, sz.bh)]),
            contentBoxSize: Object.freeze([roSize(sz.cw, sz.ch)]),
            devicePixelContentBoxSize: Object.freeze([roSize(r(sz.cw * (globalThis.devicePixelRatio || 1)), r(sz.ch * (globalThis.devicePixelRatio || 1)))]),
          }));
        }
      });
      if (entries.length) { try { __jb.loafRun("user-callback", "ResizeObserverCallback", ro.cb, ro.self, [entries, ro.self]); } catch (err) { __jb.reportException(err); } }
    });
  };
  __jb.scheduleObserverCheck = function () {
    if (scheduled) return;
    if (!observers.some(function (o) { return o.targets.length; }) && !resizeObservers.some(function (o) { return o.targets.length; })) return;
    scheduled = true;
    // processed in "update the rendering", after the frame's animation frame callbacks
    (__jb.frameTimeout || setTimeout)(function () { scheduled = false; __jb.checkObservers(); }, (__jb.untilNextFrame ? __jb.untilNextFrame() : 16) + 0.5);
  };
})();
