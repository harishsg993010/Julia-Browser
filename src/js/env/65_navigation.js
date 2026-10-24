// ---------------------------------------------------------------- Navigation API
// window.navigation over the joint session history of 64_history.js: entries of this navigable
// (same origin, contiguous) as NavigationHistoryEntry objects, navigate events for every
// navigation (fragment, pushState/replaceState, location / links / forms, reload, traversal) with
// intercept()/precommitHandler, transitions, currententrychange, per-entry dispose, activation.
(function () {
  var N = __jb.navApi = {};
  var dom = function (name, msg) { return __jb.domError(name, msg); };
  var uuid = function () { var h = "0123456789abcdef", s = ""; for (var i = 0; i < 32; i++) s += h.charAt(Math.floor(Math.random() * 16)); return s.slice(0, 8) + "-" + s.slice(8, 12) + "-4" + s.slice(13, 16) + "-a" + s.slice(17, 20) + "-" + s.slice(20, 32); };
  var meta = function (e) { if (!e.navKey) { e.navKey = uuid(); e.navId = uuid(); } return e; };
  // the initial about:blank document has no entries and fires no events
  var disabled = function () { return !!__jb.initialAboutBlank || !!__jb.opaqueOrigin; };
  var origin = function (url) { try { return new URL(url).origin; } catch (e) { return "null"; } };
  var handled = function (p) { p.catch(function () {}); return p; };
  var deferred = function () { var d = {}; d.promise = new Promise(function (a, b) { d.resolve = a; d.reject = b; }); handled(d.promise); return d; };

  // ------------------------------------------------------------------ entries
  var entryObjs = Object.create(null); // navId -> NavigationHistoryEntry (this document's)
  class NavigationHistoryEntry extends EventTarget {
    constructor() { if (!N.creatingEntry) throw new TypeError("Illegal constructor"); super(); this.ondispose = null; }
    get url() { var e = this._e; if (!e || !N.fullyActive()) return null; return e.docId === __jb.docId || origin(e.url) === origin(__jb.currentDocument.URL) ? e.url : null; }
    get key() { return this._e && N.fullyActive() ? this._e.navKey : ""; }
    get id() { return this._e && N.fullyActive() ? this._e.navId : ""; }
    get index() { if (this._disposedInfo || !this._e || !N.fullyActive()) return -1; var list = N.entryList(); return list.indexOf(this._e); }
    get sameDocument() { return !!this._e && this._e.docId === __jb.docId && !this._disposedInfo && N.fullyActive(); }
    getState() { var e = this._e; if (!e || e.navState === undefined) return undefined; return structuredClone(e.navState); }
    get ondispose() { return this._ondispose || null; } set ondispose(f) { this._ondispose = typeof f === "function" ? f : null; }
  }
  N.entryObject = function (e) {
    meta(e);
    var o = entryObjs[e.navId];
    if (!o) { N.creatingEntry = true; try { o = new NavigationHistoryEntry(); } finally { N.creatingEntry = false; } Object.defineProperty(o, "_e", { value: e, writable: true }); entryObjs[e.navId] = o; }
    return o;
  };
  // this navigable's entries usable by the Navigation API: the contiguous same-origin run around the current entry
  N.entryList = function () {
    if (disabled()) return [];
    N.adoptPendingState();
    var bc = __jb.myNav(), cur = __jb.myEntry();
    var all = (bc.entries || []).slice().sort(function (a, b) { return a.step - b.step; });
    var i = all.indexOf(cur);
    if (i < 0) return [cur];
    var o = origin(cur.url), lo = i, hi = i;
    while (lo > 0 && origin(all[lo - 1].url) === o) lo--;
    while (hi < all.length - 1 && origin(all[hi + 1].url) === o) hi++;
    return all.slice(lo, hi + 1);
  };
  N.dispose = function (entries) {
    entries.forEach(function (e) {
      var o = e && e.navId ? entryObjs[e.navId] : null;
      if (!o || o._disposedInfo) return;
      var ev = new Event("dispose"); __jb.setTrusted(ev, true); ev._trustedDispatch = true;
      o.dispatchEvent(ev);
    });
  };
  // replaced / pruned entries become disposed; replacement keeps the key, gets a new id
  var basePush = __jb.pushEntry, baseReplace = __jb.replaceEntry;
  __jb.pushEntry = function (bc, fields) {
    var sh = __jb.sessionHistory();
    var pruned = [];
    sh.navs.forEach(function (n) { (n.entries || []).forEach(function (e) { if (e.step > sh.current) pruned.push(e); }); });
    var e = basePush.apply(this, arguments);
    if (fields && fields.navState !== undefined) e.navState = fields.navState;
    if (pruned.length) N.queueDispose(pruned);
    return e;
  };
  __jb.replaceEntry = function (bc, fields) {
    var before = __jb.ensureNav(bc, fields.url, fields.docId);
    var oldId = before.navId, oldKey = before.navKey, beforeUrl = before.url;
    var e = baseReplace.apply(this, arguments);
    if (oldId && bc && bc.reloading) { bc.reloading = false; e.navKey = oldKey; e.navId = oldId; }
    else if (oldId) {
      var oldObj = entryObjs[oldId];
      e.navKey = oldKey; e.navId = uuid();
      if (oldObj) { delete entryObjs[oldId]; var ghost = { url: before.url, docId: before.docId, navKey: oldKey, navId: oldId, step: -1 }; oldObj._e = ghost; N.queueDispose([ghost], oldObj); }
    }
    if (fields && "navState" in fields) e.navState = fields.navState;
    else if (N.clearNavState) e.navState = undefined;
    else if (fields && fields.url !== undefined && before && fields.url !== beforeUrl) e.navState = undefined;
    return e;
  };
  // disposed entries fire "dispose" right after the navigation's currententrychange (or at once)
  N.pendingDispose = [];
  N.queueDispose = function (entries, obj) {
    var objs = obj ? [obj] : entries.map(function (e) { return e.navId ? entryObjs[e.navId] : null; }).filter(Boolean);
    objs.forEach(function (o) { if (!o._disposedInfo && N.pendingDispose.indexOf(o) < 0) N.pendingDispose.push(o); });
    if (!N.inCommit) N.flushDispose();
  };
  N.flushDispose = function () {
    var list = N.pendingDispose.splice(0);
    list.forEach(function (o) {
      if (o._disposedInfo) return;
      o._disposedInfo = true;
      var ev = new Event("dispose"); __jb.setTrusted(ev, true); ev._trustedDispatch = true;
      try { o.dispatchEvent(ev); } catch (e) { __jb.reportException(e); }
    });
  };

  // ------------------------------------------------------------------ events
  class NavigationDestination {
    constructor() { throw new TypeError("Illegal constructor"); }
    get url() { return this._url; }
    get key() { return this._entry ? this._entry.navKey : ""; }
    get id() { return this._entry ? this._entry.navId : ""; }
    get index() { if (!this._entry) return -1; return N.entryList().indexOf(this._entry); }
    get sameDocument() { return this._same; }
    getState() { return this._state === undefined ? undefined : structuredClone(this._state); }
  }
  var makeDestination = function (url, entry, same, state) { var d = Object.create(NavigationDestination.prototype); Object.defineProperty(d, "_url", { value: url, writable: true }); Object.defineProperty(d, "_entry", { value: entry || null }); Object.defineProperty(d, "_same", { value: !!same }); Object.defineProperty(d, "_state", { value: state, writable: true }); return d; };
  class NavigateEvent extends Event {
    constructor(type, init) {
      if (arguments.length < 2) throw new TypeError("NavigateEvent: 2 arguments required");
      super(type, init);
      if (!init || typeof init !== "object") throw new TypeError("NavigateEventInit required");
      if (!(init.destination instanceof NavigationDestination)) throw new TypeError("destination is required");
      if (!(init.signal instanceof AbortSignal)) throw new TypeError("signal is required");
      var t = init.navigationType === undefined ? "push" : String(init.navigationType);
      if (!/^(push|replace|reload|traverse)$/.test(t)) throw new TypeError("Invalid navigationType");
      var s = this._ev;
      s.navigationType = t; s.destination = init.destination; s.canIntercept = !!init.canIntercept; s.userInitiated = !!init.userInitiated; s.hashChange = !!init.hashChange; s.signal = init.signal;
      s.formData = init.formData === undefined ? null : init.formData; s.downloadRequest = init.downloadRequest === undefined || init.downloadRequest === null ? null : String(init.downloadRequest);
      s.info = init.info; s.hasUAVisualTransition = !!init.hasUAVisualTransition; s.sourceElement = init.sourceElement === undefined ? null : init.sourceElement;
      s.handlers = []; s.precommit = []; s.interceptState = "none"; s.focusReset = null; s.scrollBehavior = null;
    }
    get navigationType() { return this._ev.navigationType; }
    get destination() { return this._ev.destination; }
    get canIntercept() { return this._ev.canIntercept; }
    get userInitiated() { return this._ev.userInitiated; }
    get hashChange() { return this._ev.hashChange; }
    get signal() { return this._ev.signal; }
    get formData() { return this._ev.formData; }
    get downloadRequest() { return this._ev.downloadRequest; }
    get info() { return this._ev.info; }
    get hasUAVisualTransition() { return this._ev.hasUAVisualTransition; }
    get sourceElement() { return this._ev.sourceElement; }
    intercept(options) {
      var s = this._ev;
      if (!N.fullyActive()) throw dom("InvalidStateError", "The document is not fully active");
      if (!this.isTrusted) throw dom("SecurityError", "intercept() may only be called on trusted events");
      if (!s.canIntercept) throw dom("SecurityError", "This navigation cannot be intercepted");
      if (!s.dispatching && s.interceptState === "none" || s.doneDispatching) throw dom("InvalidStateError", "intercept() must be called during dispatch");
      if (s.signal.aborted) throw dom("InvalidStateError", "The navigation was aborted");
      if (this.defaultPrevented) throw dom("InvalidStateError", "The navigation was canceled");
      options = options || {};
      if (options.handler !== undefined) { if (typeof options.handler !== "function") throw new TypeError("handler must be a function"); s.handlers.push(options.handler); }
      if (options.precommitHandler !== undefined) {
        if (typeof options.precommitHandler !== "function") throw new TypeError("precommitHandler must be a function");
        if (!this.cancelable) throw dom("InvalidStateError", "precommitHandler requires a cancelable navigation");
        s.precommit.push(options.precommitHandler);
      }
      if (options.focusReset !== undefined) s.focusReset = String(options.focusReset);
      if (options.scroll !== undefined) s.scrollBehavior = String(options.scroll);
      s.interceptState = "intercepted";
    }
    scroll() {
      var s = this._ev;
      if (!this.isTrusted) throw dom("InvalidStateError", "scroll() may only be called on trusted events");
      if (s.interceptState !== "committed") throw dom("InvalidStateError", "scroll() requires a committed, unfinished intercepted navigation");
      s.interceptState = "scrolled";
      N.scrollToFragment(s.destination.url);
    }
  }
  class NavigationCurrentEntryChangeEvent extends Event {
    constructor(type, init) {
      if (arguments.length < 2) throw new TypeError("NavigationCurrentEntryChangeEvent: 2 arguments required");
      super(type, init);
      if (!init || !(init.from instanceof NavigationHistoryEntry)) throw new TypeError("from is required");
      this._ev.from = init.from; this._ev.navigationType = init.navigationType === undefined ? null : init.navigationType;
    }
    get from() { return this._ev.from; }
    get navigationType() { return this._ev.navigationType; }
  }
  class NavigationTransition {
    constructor() { throw new TypeError("Illegal constructor"); }
    get navigationType() { return this._t.navigationType; }
    get from() { return this._t.from; }
    get finished() { return this._t.finished.promise; }
    get committed() { return this._t.committed.promise; }
    get to() { return this._t.to; }
  }
  class NavigationActivation {
    constructor() { throw new TypeError("Illegal constructor"); }
    get from() { return this._from; }
    get entry() { return this._entry(); }
    get navigationType() { return this._type; }
  }
  class NavigationPrecommitController {
    constructor() { throw new TypeError("Illegal constructor"); }
    redirect(url, options) {
      var c = this._c;
      if (c.done) throw dom("InvalidStateError", "redirect() is only possible before commit");
      if (c.navigationType !== "push" && c.navigationType !== "replace") throw dom("InvalidStateError", "Only push/replace navigations can be redirected");
      var u; try { u = new URL(String(url), __jb.currentDocument.baseURI).href; } catch (e) { throw dom("SyntaxError", "Invalid URL"); }
      if (!__jb.canRewriteUrl(new URL(__jb.currentDocument.URL), new URL(u))) throw dom("SecurityError", "Cannot redirect to " + u);
      c.url = u;
      if (c.dest) c.dest._url = u;
      options = options || {};
      if (options.state !== undefined) { c.state = structuredClone(options.state); if (c.dest) c.dest._state = c.state; }
      if (options.info !== undefined) c.info = options.info;
      if (options.history !== undefined) { var h = String(options.history); if (h === "push" || h === "replace") c.navigationType = h; }
    }
    addHandler(handler) { var c = this._c; if (c.done) throw dom("InvalidStateError", "addHandler() is only possible before commit"); if (typeof handler !== "function") throw new TypeError("handler must be a function"); c.addHandlers.push(handler); }
  }

  // ------------------------------------------------------------------ the Navigation object
  class Navigation extends EventTarget {
    constructor() { if (!N.creatingNavigation) throw new TypeError("Illegal constructor"); super(); }
    entries() { if (disabled() || !N.fullyActive()) return []; return N.entryList().map(N.entryObject); }
    get currentEntry() { if (disabled() || !N.fullyActive()) return null; return N.entryObject(__jb.myEntry()); }
    get transition() { return N.transition ? N.transition.obj : null; }
    get activation() { return N.activationFor(); }
    get canGoBack() { if (disabled()) return false; var l = N.entryList(); return l.indexOf(__jb.myEntry()) > 0; }
    get canGoForward() { if (disabled()) return false; var l = N.entryList(); var i = l.indexOf(__jb.myEntry()); return i >= 0 && i < l.length - 1; }
    updateCurrentEntry(options) {
      if (!options || typeof options !== "object" || !("state" in options)) throw new TypeError("updateCurrentEntry: state is required");
      if (disabled() || !N.fullyActive()) throw dom("InvalidStateError", "The document is not fully active");
      var st = structuredClone(options.state);
      var cur = __jb.myEntry();
      var from = N.entryObject(cur);
      cur.navState = st;
      N.fireCurrentChange(null, from);
    }
    navigate(url, options) {
      options = options || {};
      var parsed;
      try { parsed = new URL(String(url), __jb.currentDocument.baseURI).href; } catch (e) { return N.earlyError(dom("SyntaxError", "Invalid URL '" + url + "'")); }
      var hist = options.history === undefined ? "auto" : String(options.history);
      if (!/^(auto|push|replace)$/.test(hist)) return N.earlyError(new TypeError("Invalid history option"));
      if (hist === "push" && /^javascript:/i.test(parsed)) return N.earlyError(dom("NotSupportedError", "push of a javascript: URL"));
      if (hist === "push" && __jb.initialAboutBlank) return N.earlyError(dom("NotSupportedError", "push from the initial about:blank document"));
      var state;
      if (options.state !== undefined) { try { state = structuredClone(options.state); } catch (e) { return N.earlyError(e); } }
      if (!N.fullyActive() || __jb.unloadCounter > 0) return N.earlyError(dom("InvalidStateError", "The document is not fully active"));
      var tracker = N.newTracker(options.info, state, options.state !== undefined);
      N.upcoming = tracker;
      var type = hist === "replace" ? "replace" : hist === "push" ? "push" : null;
      var prevH = N.explicitHistory, prevL = N.fromLink; N.explicitHistory = type; N.fromLink = true;
      try { __jb.navigate(parsed, type === "replace" ? "replace" : type === "push" ? "push" : "assign"); }
      catch (e) { if (N.upcoming === tracker) N.upcoming = null; return N.earlyError(e); }
      finally { N.explicitHistory = prevH; N.fromLink = prevL; }
      if (N.upcoming === tracker) { N.upcoming = null; /* a navigation that fired no navigate event (e.g. javascript:) */ }
      return tracker.result;
    }
    reload(options) {
      options = options || {};
      var state;
      if (options.state !== undefined) { try { state = structuredClone(options.state); } catch (e) { return N.earlyError(e); } }
      if (!N.fullyActive()) return N.earlyError(dom("InvalidStateError", "The document is not fully active"));
      var tracker = N.newTracker(options.info, state, options.state !== undefined);
      N.upcoming = tracker;
      location.reload();
      if (N.upcoming === tracker) N.upcoming = null;
      return tracker.result;
    }
    traverseTo(key, options) {
      key = String(key);
      options = options || {};
      if (!N.fullyActive() || disabled()) return N.earlyError(dom("InvalidStateError", "The document is not fully active"));
      var target = N.entryList().filter(function (e) { return e.navKey === key; })[0];
      if (!target) return N.earlyError(dom("InvalidStateError", "No entry with key " + key));
      if (target === __jb.myEntry()) { var cur = N.entryObject(target); return { committed: Promise.resolve(cur), finished: Promise.resolve(cur) }; }
      return N.traverse(target, options.info);
    }
    back(options) {
      if (!N.fullyActive() || disabled()) return N.earlyError(dom("InvalidStateError", "The document is not fully active"));
      var l = N.entryList(), i = l.indexOf(__jb.myEntry());
      if (i <= 0) return N.earlyError(dom("InvalidStateError", "Cannot go back"));
      return N.traverse(l[i - 1], (options || {}).info);
    }
    forward(options) {
      if (!N.fullyActive() || disabled()) return N.earlyError(dom("InvalidStateError", "The document is not fully active"));
      var l = N.entryList(), i = l.indexOf(__jb.myEntry());
      if (i < 0 || i >= l.length - 1) return N.earlyError(dom("InvalidStateError", "Cannot go forward"));
      return N.traverse(l[i + 1], (options || {}).info);
    }
  }
  ["navigate", "navigatesuccess", "navigateerror", "currententrychange"].forEach(function (t) {
    // the event dispatch runs on<type> after the listeners
    Object.defineProperty(Navigation.prototype, "on" + t, { get: function () { return (this._handlersOn || {})[t] || null; }, set: function (f) { var h = this._handlersOn || (this._handlersOn = {}); h[t] = typeof f === "function" ? f : null; }, enumerable: true, configurable: true });
  });

  N.fullyActive = function () { if (__jb.closedFlag || __jb.discardedFlag) return false; try { var fc = __jb.frameContext; if (fc && fc.frameElement && (!fc.frameElement.isConnected || fc.frameElement._contentWindow !== globalThis)) return false; } catch (e) {} return true; };
  N.earlyError = function (err) { var r = { committed: handled(Promise.reject(err)), finished: handled(Promise.reject(err)) }; return r; };
  N.newTracker = function (info, state, hasState) {
    var c = deferred(), f = deferred();
    return { info: info, state: state, hasState: hasState, committed: c, finished: f, result: { committed: c.promise, finished: f.promise }, key: null };
  };
  N.traverse = function (target, info) {
    var key = target.navKey;
    var tracker = N.newTracker(info, undefined, false);
    tracker.key = key;
    (N.upcomingTraverse || (N.upcomingTraverse = {}))[key] = tracker;
    var sh = __jb.sessionHistory();
    setTimeout(function () {
      if (!N.fullyActive()) return;
      if (__jb.sessionHistory().current === target.step) { delete N.upcomingTraverse[key]; return; }
      // the nearest joint-history step at which this navigable shows the target entry
      var shNow = __jb.sessionHistory(), bcT = __jb.myNav(), best = target.step;
      try {
        var cands = __jb.usedSteps(shNow).filter(function (st) { return __jb.entryAt(bcT, st) === target; });
        if (cands.length) best = __jb.A.reduce.call(cands, function (a, b) { return Math.abs(b - shNow.current) < Math.abs(a - shNow.current) ? b : a; });
      } catch (e) {}
      __jb.traversableRoot().__jb.applyHistoryStep(best);
      // a traversal that fired no navigate event here (cross-document) leaves the tracker pending
    }, 0);
    return tracker.result;
  };

  // ------------------------------------------------------------------ ongoing navigation / transition
  N.abortOngoing = function (reason) {
    var o = N.ongoing;
    if (!o) return;
    N.ongoing = null;
    var err = reason || dom("AbortError", "The navigation was aborted");
    if (o.event && !o.event._ev.signal.aborted) { try { o.controller.abort(err); } catch (e) {} }
    N.fireNavError(err);
    if (o.tracker) { o.tracker.committed.reject(err); o.tracker.finished.reject(err); }
    if (N.transition && N.transition === o.transition) { N.transition.t.committed.reject(err); N.transition.t.finished.reject(err); N.transition = null; }
  };
  N.fireNavError = function (err) {
    var isErr = err && typeof err === "object" && "message" in err;
    var ev = new ErrorEvent("navigateerror", { error: err, message: isErr ? String(err.name || "Error") + ": " + err.message : String(err), filename: !isErr || err instanceof DOMException || /browser_env/.test(err.fileName || "") ? __jb.currentDocument.URL : err.fileName && /^[a-z][a-z0-9+.-]*:/i.test(err.fileName) ? err.fileName : N.scriptUrl, lineno: isErr && err.lineNumber > 0 ? err.lineNumber : 1, colno: isErr && err.columnNumber > 0 ? err.columnNumber : 1 });
    __jb.setTrusted(ev, true); ev._trustedDispatch = true;
    globalThis.navigation.dispatchEvent(ev);
  };
  N.fireCurrentChange = function (type, fromObj) {
    if (disabled()) return;
    var ev = new NavigationCurrentEntryChangeEvent("currententrychange", { navigationType: type, from: fromObj });
    __jb.setTrusted(ev, true); ev._trustedDispatch = true;
    globalThis.navigation.dispatchEvent(ev);
  };
  N.scrollToFragment = function (url) {
    try { var h = new URL(url).hash.slice(1); var el = h ? (__jb.currentDocument.getElementById(decodeURIComponent(h)) || __jb.currentDocument.getElementsByName(decodeURIComponent(h))[0]) : null; if (el && typeof el.scrollIntoView === "function") el.scrollIntoView(); else if (!h) globalThis.scrollTo(0, 0); } catch (e) {}
  };
  N.restoreScroll = function (e) {
    try { if (history.scrollRestoration === "manual") return; var p = e && e.scrollPos; globalThis.scrollTo(p ? p[0] : 0, p ? p[1] : 0); } catch (err) {}
  };
  var waitForAll = function (promises, ok, fail) {
    if (!promises.length) { Promise.resolve().then(ok); return; }
    var left = promises.length, done = false;
    promises.forEach(function (p) {
      p.then(function () { if (done) return; left--; if (left === 0) { done = true; ok(); } }, function (e) { if (done) return; done = true; fail(e); });
    });
  };

  // "Fire a navigate event". Returns { proceed: bool (not canceled), intercepted: bool, finish(commitFn) }.
  // `commit` performs the URL/history update for same-document navigations (intercepted or not).
  N.fireNavigate = function (o) {
    if (disabled()) { o.commit(); return { proceed: true, intercepted: false }; }
    var navigation = globalThis.navigation;
    var tracker = null;
    if (o.type === "traverse") { tracker = N.upcomingTraverse && o.destEntry ? N.upcomingTraverse[o.destEntry.navKey] : null; if (tracker) delete N.upcomingTraverse[o.destEntry.navKey]; }
    else { tracker = N.upcoming; N.upcoming = null; }
    var info = tracker ? tracker.info : undefined;
    // a new navigation aborts the ongoing one (and any started from its navigateerror handlers)
    for (var guard = 0; N.ongoing && guard < 16; guard++) N.abortOngoing();
    var controller = new AbortController();
    var destState = o.type === "traverse" ? (o.destEntry ? o.destEntry.navState : undefined) : tracker && tracker.hasState ? tracker.state : o.destState;
    var dest = makeDestination(o.url, o.type === "traverse" ? o.destEntry : null, o.sameDocument, destState);
    // traversals can be canceled only in the top-level traversable, same-document
    var cancelable = o.type !== "traverse" || (o.sameDocument && !__jb.frameContext);
    var ev = new NavigateEvent("navigate", { cancelable: cancelable, navigationType: o.type, destination: dest, canIntercept: o.canIntercept, userInitiated: !!o.userInitiated, hashChange: !!o.hashChange, signal: controller.signal, formData: o.formData || null, downloadRequest: o.download === undefined ? null : o.download, info: info, sourceElement: o.sourceElement || null });
    __jb.setTrusted(ev, true); ev._trustedDispatch = true;
    var ongoing = { event: ev, controller: controller, tracker: tracker, transition: null };
    N.ongoing = ongoing;
    ev._ev.dispatching = true;
    try { navigation.dispatchEvent(ev); } finally { ev._ev.dispatching = false; ev._ev.doneDispatching = true; }
    if (N.ongoing !== ongoing) {
      // a reentrant navigation inside the navigate event took over
      if (tracker && !tracker.committed._settled) { var err0 = dom("AbortError", "The navigation was aborted"); tracker.committed.reject(err0); tracker.finished.reject(err0); }
      return { proceed: false, intercepted: false };
    }
    if (ev.defaultPrevented) {
      N.ongoing = null;
      var err = dom("AbortError", "The navigation was canceled");
      try { controller.abort(err); } catch (e) {}
      N.fireNavError(err);
      if (tracker) { tracker.committed.reject(err); tracker.finished.reject(err); }
      return { proceed: false, intercepted: false };
    }
    var s = ev._ev;
    var intercepted = s.interceptState === "intercepted";
    var fromObj = disabled() ? null : N.entryObject(o.leavingEntry || __jb.myEntry());
    if (!intercepted && !o.sameDocument) {
      // cross-document: the document goes away; nothing more happens here
      N.ongoing = null;
      return { proceed: true, intercepted: false, tracker: tracker };
    }
    // same-document (intercepted or a real same-document navigation)
    var t = { navigationType: o.type, from: fromObj, to: dest, committed: deferred(), finished: deferred() };
    var tObj = Object.create(NavigationTransition.prototype); Object.defineProperty(tObj, "_t", { value: t });
    var transition = { obj: tObj, t: t };
    // only intercepted navigations have a transition
    if (intercepted) { N.transition = transition; ongoing.transition = transition; }
    var doCommit = function (redirect) {
      if (N.ongoing !== ongoing) return false;
      try { var leaving = o.leavingEntry || __jb.myEntry(); leaving.scrollPos = [globalThis.scrollX || 0, globalThis.scrollY || 0]; } catch (e) {}
      // an intercepted push/replace commits through the URL and history update steps: no popstate
      var prevNo = N.noPopstate; if (intercepted && o.type !== "traverse") N.noPopstate = true;
      var prevIn = N.inCommit; N.inCommit = true;
      try { o.commit(redirect); } finally { N.noPopstate = prevNo; N.inCommit = prevIn; }
      s.interceptState = intercepted ? "committed" : s.interceptState;
      N.fireCurrentChange(o.type, fromObj);
      if (!N.inCommit) N.flushDispose();
      if (o.afterCurrentChange) o.afterCurrentChange(intercepted);
      var cur = N.entryObject(__jb.myEntry());
      if (tracker) { tracker.committed.resolve(cur); tracker.committed._settled = true; }
      t.committed.resolve(cur);
      return true;
    };
    var finishOk = function () {
      if (N.ongoing !== ongoing) return;
      N.ongoing = null;
      var wasState = s.interceptState;
      if (intercepted && s.focusReset !== "manual") N.focusReset(ongoing);
      if (intercepted && s.scrollBehavior !== "manual" && s.interceptState === "committed") { s.interceptState = "scrolled"; if (o.type === "traverse") N.restoreScroll(o.destEntry); else if (o.type !== "reload") N.scrollToFragment(o.url); }
      if (s.interceptState === "committed" && wasState === "committed") s.interceptState = "finished";
      var sev = new Event("navigatesuccess"); __jb.setTrusted(sev, true); sev._trustedDispatch = true;
      navigation.dispatchEvent(sev);
      if (N.transition === transition) N.transition = null;
      var cur = N.entryObject(__jb.myEntry());
      if (tracker) tracker.finished.resolve(cur);
      t.finished.resolve();
    };
    var finishErr = function (e) {
      if (N.ongoing !== ongoing) return;
      N.ongoing = null;
      try { controller.abort(e); } catch (x) {}
      if (intercepted && s.focusReset !== "manual") N.focusReset(ongoing);
      if (s.interceptState === "committed") s.interceptState = "finished";
      N.fireNavError(e);
      if (N.transition === transition) N.transition = null;
      if (tracker) { if (!tracker.committed._settled) tracker.committed.reject(e); tracker.finished.reject(e); }
      t.committed.reject(e); t.finished.reject(e);
    };
    ongoing.focusBefore = __jb.currentDocument.activeElement;
    var runHandlers = function () {
      var ps = [];
      s.handlers.forEach(function (h) { try { ps.push(Promise.resolve(h.call(ev))); } catch (e) { ps.push(Promise.reject(e)); } });
      waitForAll(ps, finishOk, finishErr);
    };
    if (intercepted && s.precommit.length) {
      // precommit handlers run first; the commit waits for them (a redirect may change the URL)
      var c = { done: false, navigationType: o.type, url: null, state: undefined, info: undefined, addHandlers: [], dest: dest };
      var ctl = Object.create(NavigationPrecommitController.prototype); Object.defineProperty(ctl, "_c", { value: c });
      var pps = [];
      s.precommit.forEach(function (h) { try { pps.push(Promise.resolve(h.call(ev, ctl))); } catch (e) { pps.push(Promise.reject(e)); } });
      waitForAll(pps, function () {
        c.done = true;
        if (!doCommit(c.url ? { url: c.url, state: c.state, type: c.navigationType } : null)) return;
        c.addHandlers.forEach(function (h) { s.handlers.push(h); });
        runHandlers();
      }, function (e) { c.done = true; finishErr(e); });
      return { proceed: true, intercepted: true, deferred: true };
    }
    doCommit(null);
    // a same-document navigation that was not intercepted scrolls at once
    if (!intercepted) { if (o.type === "traverse") N.restoreScroll(o.destEntry); else if (o.hashChange) N.scrollToFragment(o.url); }
    runHandlers();
    return { proceed: true, intercepted: intercepted };
  };
  N.focusReset = function (ongoing) {
    try {
      if (__jb.currentDocument.activeElement !== ongoing.focusBefore && __jb.currentDocument.activeElement !== __jb.currentDocument.body) return;
      var af = __jb.currentDocument.querySelector("[autofocus]");
      if (af && typeof af.focus === "function" && __jb.isFocusable && __jb.isFocusable(af)) { af.focus(); return; }
      var a = __jb.currentDocument.activeElement;
      if (a && a !== __jb.currentDocument.body && typeof a.blur === "function") a.blur();
      if (typeof __jb.setSequentialFocusStartingPoint === "function") __jb.setSequentialFocusStartingPoint(__jb.currentDocument.body);
    } catch (e) {}
  };

  // ------------------------------------------------------------------ hooks into navigations
  // fragment navigations (location.hash, location.href = "#x", <a href="#x">, navigation.navigate("#x"))
  var baseFragment = __jb.fragmentNavigate;
  __jb.fragmentNavigate = function (url, replace) {
    var self = this, args = arguments;
    // explicit navigate({history}) wins; Location API navigations before the load completes replace
    var type = N.explicitHistory ? N.explicitHistory : replace || url === __jb.currentDocument.URL || (!N.fromLink && !N.completelyLoaded()) ? "replace" : "push";
    var tracker = N.upcoming;
    // a fragment navigation keeps the navigation API state unless navigate() gave one
    var carried = __jb.myEntry().navState;
    var navState = tracker && tracker.hasState ? tracker.state : carried;
    var r = N.fireNavigate({ type: type, url: url, sameDocument: true, canIntercept: true, hashChange: true, destState: carried, userInitiated: !!__jb.userNavigation, sourceElement: N.sourceElement || null,
      commit: function (redirect) {
        if (redirect && redirect.url) {
          N.pendingNavState = redirect.state !== undefined ? redirect.state : navState;
          try {
            var bc = __jb.myNav(); __jb.myEntry();
            if (redirect.type === "replace") __jb.replaceEntry(bc, { url: redirect.url, state: null }); else __jb.pushEntry(bc, { url: redirect.url, state: null, docId: __jb.docId });
            __jb.setDocumentUrl(redirect.url); __jb.historyState = null;
          } finally { N.pendingNavState = undefined; }
          return;
        }
        N.pendingNavState = navState; try { baseFragment.call(self, url, type === "replace"); } finally { N.pendingNavState = undefined; } } });
    return r;
  };
  // history.pushState / replaceState
  var baseShared = __jb.sharedHistoryUpdate;
  __jb.sharedHistoryUpdate = function (data, url, replace) {
    var self = this, args = arguments;
    // validation errors are thrown before any navigate event
    __jb.historyFullyActive();
    var serialized = structuredClone(data);
    var newUrl = __jb.currentDocument.URL;
    if (url !== undefined && url !== null && String(url) !== "") {
      var parsed;
      try { parsed = new URL(String(url), __jb.currentDocument.baseURI); } catch (e) { throw dom("SecurityError", "'" + url + "' is not a valid URL."); }
      if (!__jb.canRewriteUrl(new URL(__jb.currentDocument.URL), parsed)) throw dom("SecurityError", "A history state object with URL '" + parsed.href + "' cannot be created in a document with URL '" + __jb.currentDocument.URL + "'.");
      newUrl = parsed.href;
    }
    var cur = __jb.myEntry();
    var keepState = cur.navState;
    N.fireNavigate({ type: replace ? "replace" : "push", url: newUrl, sameDocument: true, canIntercept: true, hashChange: false, classicState: serialized,
      commit: function () { N.clearNavState = true; try { baseShared.apply(self, args); } finally { N.clearNavState = false; } } });
  };
  // cross-document navigations (location.assign/href/replace, links, forms, navigation.navigate)
  var baseNavigate = __jb.navigate;
  __jb.navigate = function (u, type) {
    if (N.skipNext) { N.skipNext = false; return baseNavigate.apply(this, arguments); }
    var target;
    try { target = new URL(String(u), location._url.href).href; } catch (e) { return baseNavigate.apply(this, arguments); }
    if (/^javascript:/i.test(target)) return baseNavigate.apply(this, arguments);
    var self = this, args = arguments;
    if (__jb.isFragmentNavigation(target)) {
      // same URL but for the fragment: same-document (64_history routes it to fragmentNavigate)
      var tr = N.upcoming;
      if (tr && type === "push" && false) {}
      return baseNavigate.apply(self, [target, type === "push" ? "assign" : type]);
    }
    var histType = type === "replace" ? "replace" : (type === "push" || type === "assign" || type === undefined) ? "push" : type;
    if (histType === "push" && type !== "push" && (target === __jb.currentDocument.URL || (!N.fromLink && !N.completelyLoaded()))) histType = "replace";
    if (__jb.initialAboutBlank || !__jb.completelyLoaded) { if (histType === "push" && (__jb.initialAboutBlank || __jb.completelyLoaded === false)) histType = __jb.initialAboutBlank ? "replace" : histType; }
    var docUrl; try { docUrl = new URL(__jb.currentDocument.URL); } catch (e) { docUrl = null; }
    var canIntercept = !!docUrl && __jb.canRewriteUrl(docUrl, new URL(target)) && !/^(blob|data|about|javascript):/i.test(target);
    var tracker = N.upcoming;
    var navState = tracker && tracker.hasState ? tracker.state : undefined;
    var crossDocResult = null;
    var r = N.fireNavigate({ type: histType, url: target, sameDocument: false, canIntercept: canIntercept, hashChange: false, userInitiated: !!__jb.userNavigation, formData: N.formData || null, sourceElement: N.sourceElement || null,
      commit: function (redirect) {
        // intercepted: a same-document URL update instead of loading
        var u2 = redirect && redirect.url ? redirect.url : target;
        var t2 = redirect && redirect.type ? redirect.type : histType;
        var st = redirect && redirect.state !== undefined ? redirect.state : navState;
        N.pendingNavState = st;
        try {
          var bc = __jb.myNav(); __jb.myEntry();
          if (t2 === "replace" || t2 === "reload") __jb.replaceEntry(bc, { url: u2, state: null, navState: st });
          else __jb.pushEntry(bc, { url: u2, state: null, docId: __jb.docId, navState: st });
          __jb.setDocumentUrl(u2);
          __jb.historyState = null;
        } finally { N.pendingNavState = undefined; }
      } });
    if (!r.proceed || r.intercepted) return;
    // carry the navigation API state to the new document's entry; remember how it was reached
    try { var bcN = __jb.myNav(); if (navState !== undefined) bcN.pendingNavState = navState; bcN.navFrom = __jb.myEntry(); bcN.navType = histType; } catch (e) {}
    return baseNavigate.apply(self, args);
  };
  // links: <a>/<area> activation in this navigable
  var baseFollow = __jb.followHyperlink;
  __jb.followHyperlink = function (el, href) {
    var t = String(el.getAttribute("target") || "").trim().toLowerCase();
    if (t === "") { var b = __jb.currentDocument.querySelector("base[target]"); t = b ? String(b.getAttribute("target") || "").trim().toLowerCase() : ""; }
    if (t !== "" && t !== "_self") return baseFollow.apply(this, arguments);
    var prevSrc = N.sourceElement; N.sourceElement = el;
    try {
      if (__jb.isFragmentNavigation(href)) { var pl = N.fromLink; N.fromLink = true; try { return baseFollow.apply(this, arguments); } finally { N.fromLink = pl; } }
      var r = N.crossDocNavigate(href, "push", { sourceElement: el });
      if (!r) return;
      N.skipNext = true;
      try { return baseFollow.apply(this, arguments); } finally { N.skipNext = false; }
    } finally { N.sourceElement = prevSrc; }
  };
  // <a download>: a navigate event that cannot be intercepted
  __jb.downloadHyperlink = function (el, href) {
    N.crossDocNavigate(href, "push", { sourceElement: el, download: el.getAttribute("download") || "" });
  };
  // form submissions targeting this navigable
  __jb.formNavigateHook = function (form, submitter, url, post, method, list) {
    var t = typeof __jb.formSubmissionTarget === "function" ? String(__jb.formSubmissionTarget(form, submitter)).toLowerCase() : "_self";
    if (t !== "_self") return true;
    if (__jb.isFragmentNavigation(url) && !post) { var prev = N.sourceElement; N.sourceElement = submitter && submitter !== form ? submitter : form; N.pendingSourceForFragment = true; setTimeout(function () { N.sourceElement = prev; }, 0); return true; }
    var fd = null;
    if (post) { try { fd = new FormData(); fd._list = list.map(function (p) { return [p[0], p[1]]; }); } catch (e) { fd = null; } }
    var type = !N.completelyLoaded() ? "replace" : "push";
    var r = N.crossDocNavigate(url, type, { formData: fd, sourceElement: submitter && submitter !== form ? submitter : form });
    if (!r) return false;
    N.skipNext = true;
    setTimeout(function () { N.skipNext = false; }, 0);
    return true;
  };
  // fire the navigate event of a cross-document navigation; false when canceled or intercepted
  N.crossDocNavigate = function (target, histType, extra) {
    var docUrl; try { docUrl = new URL(__jb.currentDocument.URL); } catch (e) { docUrl = null; }
    var canIntercept = !!docUrl && __jb.canRewriteUrl(docUrl, new URL(target)) && !/^(blob|data|about|javascript):/i.test(target);
    if (histType === "push" && target === __jb.currentDocument.URL) histType = "replace";
    var r = N.fireNavigate({ type: histType, url: target, sameDocument: false, canIntercept: canIntercept, hashChange: false, userInitiated: !!__jb.userNavigation, formData: extra && extra.formData || null, sourceElement: extra && extra.sourceElement || null, download: extra ? extra.download : undefined,
      commit: function (redirect) {
        var u2 = redirect && redirect.url ? redirect.url : target, t2 = redirect && redirect.type ? redirect.type : histType;
        var bc = __jb.myNav(); __jb.myEntry();
        if (t2 === "replace") __jb.replaceEntry(bc, { url: u2, state: null }); else __jb.pushEntry(bc, { url: u2, state: null, docId: __jb.docId });
        __jb.setDocumentUrl(u2); __jb.historyState = null;
      } });
    return r.proceed && !r.intercepted;
  };
  // "completely loaded": after the load event (and pageshow) of this document
  N.completelyLoaded = function () { if (__jb.completelyLoaded === false) return false; if (__jb.frameContext || __jb.auxiliary) return __jb.completelyLoaded !== false; return !!__jb.loadEventDone; };
  // reload
  var baseReload = location.reload;
  location.reload = function reload() {
    var self = this, args = arguments;
    var tracker = N.upcoming;
    var navState = tracker && tracker.hasState ? tracker.state : undefined;
    try { var bcR = __jb.myNav(); bcR.navFrom = __jb.myEntry(); bcR.navType = "reload"; bcR.reloading = true; } catch (e) {}
    var r = N.fireNavigate({ type: "reload", url: __jb.currentDocument.URL, sameDocument: false, canIntercept: true, hashChange: false, destState: __jb.myEntry().navState,
      commit: function () { if (navState !== undefined) __jb.myEntry().navState = navState; } });
    if (!r.proceed || r.intercepted) return;
    if (navState !== undefined) { try { __jb.myEntry().navState = navState; } catch (e) {} }
    return baseReload.apply(self, args);
  };
  // pending navigation API state for entries created by the wrapped steps
  var basePush2 = __jb.pushEntry;
  __jb.pushEntry = function (bc, fields) { var e = basePush2.apply(this, arguments); if (N.pendingNavState !== undefined && e.navState === undefined) e.navState = N.pendingNavState; return e; };
  var baseReplace2 = __jb.replaceEntry;
  __jb.replaceEntry = function (bc, fields) { var e = baseReplace2.apply(this, arguments); if (N.pendingNavState !== undefined) e.navState = N.pendingNavState; return e; };

  // traversal within this document: navigate (traverse) -> currententrychange -> popstate -> hashchange
  var baseRestoreSame = __jb.restoreSameDocumentEntry;
  __jb.restoreSameDocumentEntry = function (te, ce) {
    var self = this, args = arguments;
    meta(te);
    var r = N.fireNavigate({ type: "traverse", url: te.url, destEntry: te, leavingEntry: ce, sameDocument: true, canIntercept: true, hashChange: te.url.split("#")[0] === __jb.currentDocument.URL.split("#")[0] && te.url !== __jb.currentDocument.URL,
      commit: function () { N.deferPopstate = true; try { baseRestoreSame.apply(self, args); } finally { N.deferPopstate = false; } },
      afterCurrentChange: function (intercepted) { var q = N.queuedPopstate; N.queuedPopstate = null; if (q) { if (intercepted && te.state !== null && te.state !== undefined) setTimeout(q, 0); else q(); } } });
    if (!r.proceed) {
      // a canceled same-document traversal: go back to where we were
      try { var sh = __jb.sessionHistory(); if (ce) sh.current = ce.step; } catch (e) {}
    }
  };
  var basePopstate = __jb.firePopstate;
  __jb.firePopstate = function (state) {
    if (N.noPopstate) return;
    if (N.deferPopstate) { N.queuedPopstate = function () { basePopstate(state); }; return; }
    return basePopstate.apply(this, arguments);
  };
  // traversal leaving this document: a non-cancelable navigate event in the old document
  N.fireCrossDocumentTraverse = function (te) {
    meta(te);
    try { var bcT = __jb.myNav(); bcT.navFrom = __jb.myEntry(); bcT.navType = "traverse"; } catch (e) {}
    N.fireNavigate({ type: "traverse", url: te.url, destEntry: te, sameDocument: false, canIntercept: false, hashChange: false, commit: function () {} });
  };
  var baseRestoreCross = __jb.restoreCrossDocumentEntry;
  __jb.restoreCrossDocumentEntry = function (bc, w, te) {
    try { if (w && w.__jb && w.__jb.navApi && w.__jb.navApi.fireCrossDocumentTraverse) w.__jb.navApi.fireCrossDocumentTraverse(te); } catch (e) { __jb.reportException(e); }
    return baseRestoreCross.apply(this, arguments);
  };

  // the new document's entry takes navigation API state handed over by the navigation
  N.adoptPendingState = function () {
    try {
      var bc = __jb.myNav(), e = __jb.myEntry();
      if (bc.pendingNavState !== undefined) { if (e.navState === undefined) e.navState = bc.pendingNavState; bc.pendingNavState = undefined; }
    } catch (err) {}
  };

  // ------------------------------------------------------------------ install
  // the URL the document (and its scripts) was loaded from, before any same-document change
  var baseSetUrl = __jb.setDocumentUrl;
  __jb.setDocumentUrl = function (url) { if (N.loadUrl === undefined || N.loadUrlDoc !== __jb.docId) { N.loadUrl = __jb.currentDocument.URL; N.loadUrlDoc = __jb.docId; } return baseSetUrl.apply(this, arguments); };
  Object.defineProperty(N, "scriptUrl", { get: function () { return N.loadUrlDoc === __jb.docId && N.loadUrl ? N.loadUrl : __jb.currentDocument.URL; } });
  N.creatingNavigation = true;
  var navigationObj;
  try { navigationObj = new Navigation(); } finally { N.creatingNavigation = false; }
  Object.defineProperty(globalThis, "navigation", { get: function () { return navigationObj; }, enumerable: true, configurable: true });
  // activation: how this document was reached
  N.initActivation = function (type, fromEntry) {
    var act = Object.create(NavigationActivation.prototype);
    Object.defineProperty(act, "_type", { value: type || "push" });
    Object.defineProperty(act, "_from", { value: fromEntry ? N.entryObject(fromEntry) : null });
    Object.defineProperty(act, "_entry", { value: function () { return disabled() ? null : N.entryObject(__jb.myEntry()); } });
    N.activation = act;
  };
  // created lazily: the navigable's record of the navigation that produced this document
  N.activationFor = function () {
    if (N.activation) return N.activation;
    if (disabled()) return null;
    var bc = __jb.myNav(), from = bc.navFrom || null, type = bc.navType || "push";
    // the record belongs to the navigation that left another document of this navigable
    if (!from || from.docId === __jb.docId) { from = null; if (!bc.navFrom) type = "push"; }
    if (from && (from.docId === __jb.docId || origin(from.url) !== origin(__jb.currentDocument.URL))) from = null;
    N.initActivation(type, from);
    return N.activation;
  };
  [Navigation, NavigationHistoryEntry, NavigationDestination, NavigateEvent, NavigationCurrentEntryChangeEvent, NavigationTransition, NavigationActivation, NavigationPrecommitController].forEach(function (C) {
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
    Object.getOwnPropertyNames(C.prototype).forEach(function (p) {
      if (p === "constructor" || p.charAt(0) === "_") return;
      var d = Object.getOwnPropertyDescriptor(C.prototype, p);
      if (!d.enumerable) { d.enumerable = true; Object.defineProperty(C.prototype, p, d); }
    });
  });
  Object.assign(globalThis, { Navigation: Navigation, NavigationHistoryEntry: NavigationHistoryEntry, NavigationDestination: NavigationDestination, NavigateEvent: NavigateEvent, NavigationCurrentEntryChangeEvent: NavigationCurrentEntryChangeEvent, NavigationTransition: NavigationTransition, NavigationActivation: NavigationActivation, NavigationPrecommitController: NavigationPrecommitController });
  ["Navigation", "NavigationHistoryEntry", "NavigationDestination", "NavigateEvent", "NavigationCurrentEntryChangeEvent", "NavigationTransition", "NavigationActivation", "NavigationPrecommitController"].forEach(function (n) { var d = Object.getOwnPropertyDescriptor(globalThis, n); if (d) { d.enumerable = false; Object.defineProperty(globalThis, n, d); } });
})();
