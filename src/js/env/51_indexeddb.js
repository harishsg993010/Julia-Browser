// ---- IndexedDB 3.0 (in memory per origin, persisted through the host's idb snapshot) ----
// Keys, key paths, key generators, object stores and indexes with sorted records, cursors,
// key ranges, and the transaction lifecycle (active/inactive/committing/finished, auto-commit,
// abort with rollback, error events request -> transaction -> database), versionchange
// upgrades, blocked/versionchange events between connections.
(function () {
  var dom = function (name, msg) { return new DOMException(msg || name, name); };
  var MAX_KEYGEN = 9007199254740992;

  // ------------------------------------------------------------------ keys
  // A key is { t: "number"|"date"|"string"|"binary"|"array", v } (binary v = Uint8Array).
  var INVALID = { invalid: true };
  function isBufferSource(v) { return v instanceof ArrayBuffer || ArrayBuffer.isView(v) || Object.prototype.toString.call(v) === "[object ArrayBuffer]"; }
  function toKey(input, seen) {
    seen = seen || [];
    if (typeof input === "number") return isNaN(input) ? INVALID : { t: "number", v: input };
    if (input instanceof Date || Object.prototype.toString.call(input) === "[object Date]") { var ms = Date.prototype.getTime.call(input); return isNaN(ms) ? INVALID : { t: "date", v: ms }; }
    if (typeof input === "string") return { t: "string", v: input };
    if (input !== null && typeof input === "object" && isBufferSource(input)) {
      var buf = ArrayBuffer.isView(input) ? input.buffer : input;
      if (buf.detached) return INVALID;
      var bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice() : new Uint8Array(input).slice();
      return { t: "binary", v: bytes };
    }
    if (Array.isArray(input)) {
      if (seen.indexOf(input) >= 0) return INVALID;
      seen.push(input);
      var keys = [], len = input.length;
      for (var i = 0; i < len; i++) {
        if (!Object.prototype.hasOwnProperty.call(input, i)) return INVALID;
        var k = toKey(input[i], seen);
        if (k === INVALID) return INVALID;
        keys.push(k);
      }
      seen.pop();
      return { t: "array", v: keys };
    }
    return INVALID;
  }
  var RANK = { number: 0, date: 1, string: 2, binary: 3, array: 4 };
  function cmp(a, b) {
    if (a.t !== b.t) return RANK[a.t] < RANK[b.t] ? -1 : 1;
    switch (a.t) {
      case "number": case "date": return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
      case "string": return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
      case "binary": {
        var n = Math.min(a.v.length, b.v.length);
        for (var i = 0; i < n; i++) if (a.v[i] !== b.v[i]) return a.v[i] < b.v[i] ? -1 : 1;
        return a.v.length < b.v.length ? -1 : a.v.length > b.v.length ? 1 : 0;
      }
      case "array": {
        var m = Math.min(a.v.length, b.v.length);
        for (var j = 0; j < m; j++) { var c = cmp(a.v[j], b.v[j]); if (c) return c; }
        return a.v.length < b.v.length ? -1 : a.v.length > b.v.length ? 1 : 0;
      }
    }
    return 0;
  }
  function keyToValue(k) {
    switch (k.t) {
      case "number": case "string": return k.v;
      case "date": return new Date(k.v);
      case "binary": return k.v.slice().buffer;
      case "array": return k.v.map(keyToValue);
    }
  }
  function valueToKeyOrThrow(v) { var k = toKey(v); if (k === INVALID) throw dom("DataError", "The parameter is not a valid key"); return k; }
  function multiEntryKey(v) {
    if (!Array.isArray(v)) return toKey(v);
    var seen = [v], keys = [];
    for (var i = 0; i < v.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(v, i)) continue;
      var k = toKey(v[i], seen);
      if (k === INVALID) continue;
      if (!keys.some(function (x) { return cmp(x, k) === 0; })) keys.push(k);
    }
    return { t: "array", v: keys };
  }

  // ------------------------------------------------------------------ key paths
  var IDENT = /^[$A-Z_a-zª-￿][$\wª-￿‌‍]*$/;
  function validKeyPathString(s) { return s === "" || s.split(".").every(function (p) { return IDENT.test(p); }); }
  function validKeyPath(kp) {
    if (typeof kp === "string") return validKeyPathString(kp);
    if (Array.isArray(kp)) return kp.length > 0 && kp.every(function (s) { return typeof s === "string" && validKeyPathString(s); });
    return false;
  }
  // WebIDL (DOMString or sequence<DOMString>)? conversion of a keyPath argument
  function convertKeyPath(kp) {
    if (kp === null || kp === undefined) return null;
    if (typeof kp === "object" && typeof kp[Symbol.iterator] === "function" && typeof kp !== "string") return __jb.arrayFrom(kp, String);
    return String(kp);
  }
  var FAIL = { failure: true };
  function evaluateKeyPath(value, kp) {
    if (Array.isArray(kp)) {
      var out = [];
      for (var i = 0; i < kp.length; i++) { var r = evaluateKeyPath(value, kp[i]); if (r === FAIL) return FAIL; out.push(r); }
      return out;
    }
    if (kp === "") return value;
    var ids = kp.split(".");
    for (var j = 0; j < ids.length; j++) {
      var id = ids[j];
      if (typeof value === "string" && id === "length") value = value.length;
      else if (Array.isArray(value) && id === "length") value = value.length;
      else if (typeof Blob !== "undefined" && value instanceof Blob && (id === "size" || id === "type")) value = value[id];
      else if (typeof File !== "undefined" && value instanceof File && (id === "name" || id === "lastModified")) value = value[id];
      else if (value === null || typeof value !== "object") return FAIL;
      else { if (!Object.prototype.hasOwnProperty.call(value, id)) return FAIL; value = value[id]; }
    }
    return value;
  }
  function extractKey(value, kp, multiEntry) {
    var r = evaluateKeyPath(value, kp);
    if (r === FAIL) return FAIL;
    return multiEntry ? multiEntryKey(r) : toKey(r);
  }
  function canInjectKey(value, kp) {
    var ids = kp.split("."); ids.pop();
    for (var i = 0; i < ids.length; i++) {
      if (value === null || typeof value !== "object") return false;
      if (!Object.prototype.hasOwnProperty.call(value, ids[i])) return true;
      value = value[ids[i]];
    }
    return value !== null && typeof value === "object";
  }
  function injectKey(value, key, kp) {
    var ids = kp.split("."), last = ids.pop();
    for (var i = 0; i < ids.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, ids[i])) value[ids[i]] = {};
      value = value[ids[i]];
    }
    Object.defineProperty(value, last, { value: keyToValue(key), writable: true, enumerable: true, configurable: true });
  }
  function clone(v) { return __jb.structuredCloneValue(v, new Map()); }

  // ------------------------------------------------------------------ storage model
  // databases[origin][name] = { name, version, stores: {name: Store}, connections: [] }
  // Store = { name, keyPath, autoIncrement, current (key generator), records: [{key, value}], indexes: {name: Index} }
  // Index = { name, keyPath, unique, multiEntry, records: [{key, pk}] }
  var databases = Object.create(null);
  function originKey() { try { return location.origin || "null"; } catch (e) { return "null"; } }
  function dbsForOrigin() { var o = originKey(); return databases[o] || (databases[o] = Object.create(null)); }
  function findIndex(list, key, pk) {
    // first position whose (key[, pk]) is >= the given one
    var lo = 0, hi = list.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1, c = cmp(list[mid].key, key);
      if (c === 0 && pk !== undefined) c = cmp(list[mid].pk, pk);
      if (c < 0) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  function storeGet(store, key) { var i = findIndex(store.records, key); return i < store.records.length && cmp(store.records[i].key, key) === 0 ? store.records[i] : null; }
  function indexRemovePk(index, pk) { index.records = index.records.filter(function (r) { return cmp(r.pk, pk) !== 0; }); }
  function indexKeysFor(index, value) {
    var k = extractKey(value, index.keyPath, index.multiEntry);
    if (k === FAIL || k === INVALID) return [];
    if (index.multiEntry && k.t === "array") return k.v;
    return [k];
  }
  function copyStore(s) {
    var idx = {};
    Object.keys(s.indexes).forEach(function (n) { var x = s.indexes[n]; idx[n] = { name: x.name, keyPath: x.keyPath, unique: x.unique, multiEntry: x.multiEntry, records: x.records.slice(), deleted: x.deleted }; });
    return { name: s.name, keyPath: s.keyPath, autoIncrement: s.autoIncrement, current: s.current, records: s.records.slice(), indexes: idx, deleted: s.deleted };
  }

  // ------------------------------------------------------------------ key ranges
  var constructingKR = false;
  class IDBKeyRange {
    constructor() { if (!constructingKR) throw new TypeError("Illegal constructor"); }
    get lower() { return this._l === undefined ? undefined : keyToValue(this._l); }
    get upper() { return this._u === undefined ? undefined : keyToValue(this._u); }
    get lowerOpen() { return this._lo; }
    get upperOpen() { return this._uo; }
    includes(key) { if (arguments.length < 1) throw new TypeError("includes requires 1 argument"); return rangeIncludes(this, valueToKeyOrThrow(key)); }
    static only(value) { if (arguments.length < 1) throw new TypeError("only requires 1 argument"); var k = valueToKeyOrThrow(value); return makeRange(k, k, false, false); }
    static lowerBound(lower, open) { if (arguments.length < 1) throw new TypeError("lowerBound requires 1 argument"); return makeRange(valueToKeyOrThrow(lower), undefined, !!open, true); }
    static upperBound(upper, open) { if (arguments.length < 1) throw new TypeError("upperBound requires 1 argument"); return makeRange(undefined, valueToKeyOrThrow(upper), true, !!open); }
    static bound(lower, upper, lowerOpen, upperOpen) {
      if (arguments.length < 2) throw new TypeError("bound requires 2 arguments");
      var l = valueToKeyOrThrow(lower), u = valueToKeyOrThrow(upper);
      var c = cmp(l, u);
      if (c > 0 || (c === 0 && (lowerOpen || upperOpen))) throw dom("DataError", "The lower key is greater than the upper key");
      return makeRange(l, u, !!lowerOpen, !!upperOpen);
    }
  }
  function makeRange(l, u, lo, uo) {
    constructingKR = true; var r; try { r = new IDBKeyRange(); } finally { constructingKR = false; }
    Object.defineProperties(r, { _l: { value: l }, _u: { value: u }, _lo: { value: lo }, _uo: { value: uo } });
    return r;
  }
  function rangeIncludes(r, k) {
    if (r._l !== undefined) { var c = cmp(r._l, k); if (c > 0 || (c === 0 && r._lo)) return false; }
    if (r._u !== undefined) { var d = cmp(r._u, k); if (d < 0 || (d === 0 && r._uo)) return false; }
    return true;
  }
  var UNBOUNDED = { _l: undefined, _u: undefined, _lo: true, _uo: true };
  function toRange(value, nullDisallowed) {
    if (value instanceof IDBKeyRange) return value;
    if (value === undefined || value === null) { if (nullDisallowed) throw dom("DataError", "No key or key range specified"); return UNBOUNDED; }
    var k = valueToKeyOrThrow(value);
    return makeRange(k, k, false, false);
  }
  function isPotentiallyValidKeyRange(v) {
    return v instanceof IDBKeyRange || typeof v === "number" || typeof v === "string" || Array.isArray(v) || isBufferSource(v) ||
      v instanceof Date || Object.prototype.toString.call(v) === "[object Date]";
  }

  // ------------------------------------------------------------------ DOMStringList
  var constructingSL = false;
  class DOMStringList {
    constructor() { if (!constructingSL) throw new TypeError("Illegal constructor"); }
    get length() { return this._items.length; }
    item(i) { i = Number(i) >>> 0; return i < this._items.length ? this._items[i] : null; }
    contains(s) { return this._items.indexOf(String(s)) >= 0; }
    [Symbol.iterator]() { return this._items[Symbol.iterator](); }
  }
  function stringList(items) {
    constructingSL = true; var l; try { l = new DOMStringList(); } finally { constructingSL = false; }
    var sorted = items.slice().sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
    Object.defineProperty(l, "_items", { value: sorted });
    sorted.forEach(function (s, i) { Object.defineProperty(l, i, { value: s, enumerable: true }); });
    return l;
  }

  // ------------------------------------------------------------------ events
  class IDBVersionChangeEvent extends Event {
    constructor(type, init) {
      super(type, init);
      var o = init && init.oldVersion !== undefined ? Number(init.oldVersion) : 0;
      var n = init && init.newVersion !== undefined && init.newVersion !== null ? Number(init.newVersion) : null;
      Object.defineProperty(this, "_oldVersion", { value: o });
      Object.defineProperty(this, "_newVersion", { value: n });
    }
    get oldVersion() { return this._oldVersion; }
    get newVersion() { return this._newVersion; }
  }
  function fire(target, type, opts, EventClass) {
    var ev = EventClass ? new EventClass(type, opts) : new Event(type, opts || {});
    __jb.setTrusted(ev, true); ev._trustedDispatch = true; ev._checkpoint = true;
    var before = __jb.listenerExceptions || 0;
    var notCanceled = target.dispatchEvent(ev);
    return { notCanceled: notCanceled, threw: (__jb.listenerExceptions || 0) !== before, event: ev };
  }

  // ------------------------------------------------------------------ requests
  var constructing = false;
  function create(C) { constructing = true; try { return new C(); } finally { constructing = false; } }
  class IDBRequest extends EventTarget {
    constructor() { super(); if (!constructing) throw new TypeError("Illegal constructor"); this._done = false; this._result = undefined; this._error = null; this._source = null; this._tx = null; }
    get result() { if (!this._done) throw dom("InvalidStateError", "The request has not finished"); return this._result; }
    get error() { if (!this._done) throw dom("InvalidStateError", "The request has not finished"); return this._error; }
    get source() { return this._source; }
    get transaction() { return this._tx; }
    get readyState() { return this._done ? "done" : "pending"; }
    get _eventParent() { return this._tx; }
  }
  class IDBOpenDBRequest extends IDBRequest {}
  defineHandlers(IDBRequest, ["success", "error"]);
  defineHandlers(IDBOpenDBRequest, ["blocked", "upgradeneeded"]);

  function defineHandlers(C, types) {
    types.forEach(function (type) {
      var slot = "_on" + type;
      Object.defineProperty(C.prototype, "on" + type, {
        get: function () { return this[slot] === undefined ? null : this[slot]; },
        set: function (v) { this[slot] = typeof v === "function" || (v !== null && typeof v === "object") ? v : null; __jb.handlerSlot(this, type, this[slot]); },
        enumerable: true, configurable: true,
      });
    });
  }

  // ------------------------------------------------------------------ transactions
  // Requests are processed in order, one per task. Each completed request fires its event with
  // the transaction active; afterwards the transaction is inactive, and with no pending requests
  // it commits.
  class IDBTransaction extends EventTarget {
    constructor() { super(); if (!constructing) throw new TypeError("Illegal constructor"); }
    get objectStoreNames() { return this._storeNamesList || (this._storeNamesList = stringList(this._mode === "versionchange" ? Object.keys(this._db._db.stores) : this._scope)); }
    get mode() { return this._mode; }
    get durability() { return this._durability; }
    get db() { return this._db; }
    get error() { return this._error; }
    get _eventParent() { return this._db; }
    objectStore(name) {
      if (this._state === "finished") throw dom("InvalidStateError", "The transaction has finished");
      name = String(name);
      var inScope = this._mode === "versionchange" ? !!this._db._db.stores[name] : this._scope.indexOf(name) >= 0 && !!this._db._db.stores[name];
      if (!inScope) throw dom("NotFoundError", "No object store named " + name + " in this transaction");
      if (!this._storeObjects[name]) this._storeObjects[name] = makeStore(this, this._db._db.stores[name]);
      return this._storeObjects[name];
    }
    abort() {
      if (this._state === "committing" || this._state === "finished") throw dom("InvalidStateError", "The transaction has already finished");
      abortTransaction(this, null);
    }
    commit() {
      if (this._state !== "active") throw dom("InvalidStateError", "The transaction is not active");
      this._commitRequested = true;
      this._state = "inactive";
      schedule(this);
    }
  }
  defineHandlers(IDBTransaction, ["abort", "complete", "error"]);

  function newTransaction(conn, scope, mode, durability) {
    var tx = create(IDBTransaction);
    tx._db = conn; tx._scope = scope; tx._mode = mode; tx._durability = durability || "default";
    tx._error = null; tx._state = "active"; tx._requests = []; tx._storeObjects = {};
    tx._snapshot = null; tx._started = false;
    conn._transactions.push(tx);
    if (mode !== "readonly") {
      var stores = conn._db.stores, snap = {};
      Object.keys(stores).forEach(function (n) { if (mode === "versionchange" || scope.indexOf(n) >= 0) snap[n] = copyStore(stores[n]); });
      tx._snapshot = { stores: snap, names: Object.keys(stores) };
    }
    // Inactive once the current task ends; then commit when nothing is pending.
    setTimeout(function () { if (tx._state === "active") tx._state = "inactive"; schedule(tx); }, 0);
    return tx;
  }
  function assertActive(tx) { if (tx._state !== "active") throw dom("TransactionInactiveError", "The transaction is not active"); }
  // Queue an operation on the transaction; returns the request.
  function queueRequest(tx, source, op, request) {
    var req = request || create(IDBRequest);
    req._source = source; req._tx = tx;
    tx._requests.push({ req: req, op: op });
    schedule(tx);
    return req;
  }
  function schedule(tx) {
    if (tx._scheduled || tx._state === "finished") return;
    tx._scheduled = true;
    setTimeout(function () { tx._scheduled = false; step(tx); }, 0);
  }
  function step(tx) {
    if (tx._state === "finished") return;
    var next = tx._requests.shift();
    if (next && next.internal) {
      try { next.internal(); } catch (e) { abortTransaction(tx, e); return; }
      schedule(tx);
      return;
    }
    if (next) {
      var result, error = null;
      try { result = next.op(); } catch (e) { error = e; }
      if (tx._state === "finished") return;
      var req = next.req;
      req._done = true;
      if (error) {
        req._result = undefined; req._error = error;
        var prev = tx._state; tx._state = "active";
        var r = fire(req, "error", { bubbles: true, cancelable: true });
        if (tx._state === "active") tx._state = prev === "committing" ? "committing" : "inactive";
        if (r.threw) abortTransaction(tx, dom("AbortError", "An error event handler threw"));
        else if (r.notCanceled) abortTransaction(tx, error);
      } else {
        req._result = result; req._error = null;
        var prev2 = tx._state; tx._state = "active";
        var s = fire(req, "success", { bubbles: false, cancelable: false });
        if (tx._state === "active") tx._state = prev2 === "committing" ? "committing" : "inactive";
        if (s.threw) abortTransaction(tx, dom("AbortError", "A success event handler threw"));
      }
      if (tx._state === "inactive" && tx._requests.length === 0) tx._state = "committing";
      schedule(tx);
      return;
    }
    if (tx._state === "inactive" || tx._state === "committing") commitTransaction(tx);
  }
  function commitTransaction(tx) {
    if (tx._state === "finished") return;
    tx._state = "committing";
    tx._state = "finished";
    finishTransaction(tx);
    fire(tx, "complete", { bubbles: false, cancelable: false });
    if (tx._mode !== "readonly") persist();
    if (tx._onFinished) tx._onFinished(false);
    connectionMaybeClosed(tx._db);
  }
  function abortTransaction(tx, error) {
    if (tx._state === "finished") return;
    // roll back
    if (tx._snapshot) {
      var stores = tx._db._db.stores;
      if (tx._mode === "versionchange") {
        Object.keys(stores).forEach(function (n) { if (!tx._snapshot.stores[n]) { stores[n].deleted = true; delete stores[n]; } });
      }
      Object.keys(tx._snapshot.stores).forEach(function (n) {
        var snap = tx._snapshot.stores[n];
        var live = stores[n];
        if (live) { live.records = snap.records; live.current = snap.current; live.indexes = snap.indexes; live.name = snap.name; live.deleted = false; }
        else { stores[n] = snap; snap.deleted = false; }
      });
      tx._db._db.storesVersion++;
      // store objects of this transaction follow the restored metadata
      Object.keys(tx._storeObjects).forEach(function (n) { var so = tx._storeObjects[n]; so._indexObjects = {}; });
    }
    tx._error = error === null ? null : error;
    var pending = tx._requests; tx._requests = [];
    tx._state = "finished";
    finishTransaction(tx);
    if (tx._onAbortSync) tx._onAbortSync();
    setTimeout(function () {
      pending.forEach(function (p) {
        if (!p.req) return; // internal steps have no request
        var req = p.req;
        req._done = true; req._result = undefined; req._error = dom("AbortError", "The transaction was aborted");
        fire(req, "error", { bubbles: true, cancelable: true });
      });
      fire(tx, "abort", { bubbles: true, cancelable: false });
      if (tx._onFinished) tx._onFinished(true);
      connectionMaybeClosed(tx._db);
    }, 0);
  }
  function finishTransaction(tx) {
    var list = tx._db._transactions, i = list.indexOf(tx);
    if (i >= 0) list.splice(i, 1);
  }

  // ------------------------------------------------------------------ object stores
  class IDBObjectStore {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); }
    get name() { return this._store.name; }
    set name(v) {
      v = String(v);
      var tx = this._tx, store = this._store;
      if (tx._mode !== "versionchange") throw dom("InvalidStateError", "Object stores can only be renamed during an upgrade");
      if (store.deleted) throw dom("InvalidStateError", "The object store has been deleted");
      assertActive(tx);
      if (store.name === v) return;
      var stores = tx._db._db.stores;
      if (stores[v]) throw dom("ConstraintError", "An object store named " + v + " already exists");
      delete stores[store.name]; delete tx._storeObjects[store.name];
      store.name = v; stores[v] = store; tx._storeObjects[v] = this;
      tx._db._storeNamesList = null; tx._storeNamesList = null;
    }
    get keyPath() { var kp = this._store.keyPath; if (Array.isArray(kp)) return this._kpArray || (this._kpArray = kp.slice()); return kp; }
    get indexNames() { var names = Object.keys(this._store.indexes).filter(function (n) { return n.charAt(0) !== "\u0000"; }); return stringList(names); }
    get transaction() { return this._tx; }
    get autoIncrement() { return this._store.autoIncrement; }
    put(value, key) { return storeWrite(this, value, key, arguments.length, false); }
    add(value, key) { return storeWrite(this, value, key, arguments.length, true); }
    delete(query) {
      if (arguments.length < 1) throw new TypeError("delete requires 1 argument");
      var st = checkStore(this), tx = this._tx;
      if (tx._mode === "readonly") throw dom("ReadOnlyError", "The transaction is read-only");
      var range = toRange(query, true);
      return queueRequest(tx, this, function () {
        var removed = st.records.filter(function (r) { return rangeIncludes(range, r.key); });
        st.records = st.records.filter(function (r) { return !rangeIncludes(range, r.key); });
        removed.forEach(function (r) { Object.keys(st.indexes).forEach(function (n) { indexRemovePk(st.indexes[n], r.key); }); });
        return undefined;
      });
    }
    clear() {
      var st = checkStore(this), tx = this._tx;
      if (tx._mode === "readonly") throw dom("ReadOnlyError", "The transaction is read-only");
      return queueRequest(tx, this, function () {
        st.records = [];
        Object.keys(st.indexes).forEach(function (n) { st.indexes[n].records = []; });
        return undefined;
      });
    }
    get(query) {
      if (arguments.length < 1) throw new TypeError("get requires 1 argument");
      var st = checkStore(this), range = toRange(query, true);
      return queueRequest(this._tx, this, function () { var r = firstInRange(st.records, range); return r ? clone(r.value) : undefined; });
    }
    getKey(query) {
      if (arguments.length < 1) throw new TypeError("getKey requires 1 argument");
      var st = checkStore(this), range = toRange(query, true);
      return queueRequest(this._tx, this, function () { var r = firstInRange(st.records, range); return r ? keyToValue(r.key) : undefined; });
    }
    getAll(queryOrOptions, count) { return getAllImpl(this, false, "value", queryOrOptions, count, arguments.length); }
    getAllKeys(queryOrOptions, count) { return getAllImpl(this, false, "key", queryOrOptions, count, arguments.length); }
    getAllRecords(options) { return getAllImpl(this, false, "record", options, undefined, -1); }
    count(query) {
      var st = checkStore(this), range = toRange(query, false);
      return queueRequest(this._tx, this, function () { return st.records.filter(function (r) { return rangeIncludes(range, r.key); }).length; });
    }
    openCursor(query, direction) { return openCursorImpl(this, false, query, direction, false); }
    openKeyCursor(query, direction) { return openCursorImpl(this, false, query, direction, true); }
    index(name) {
      if (arguments.length < 1) throw new TypeError("index requires 1 argument");
      var st = this._store, tx = this._tx;
      if (st.deleted) throw dom("InvalidStateError", "The object store has been deleted");
      if (tx._state === "finished") throw dom("InvalidStateError", "The transaction has finished");
      name = String(name);
      var ix = st.indexes[name];
      if (!ix) throw dom("NotFoundError", "No index named " + name);
      if (!this._indexObjects[name] || this._indexObjects[name]._index !== ix) this._indexObjects[name] = makeIndex(this, ix);
      return this._indexObjects[name];
    }
    createIndex(name, keyPath, options) {
      if (arguments.length < 2) throw new TypeError("createIndex requires 2 arguments");
      name = String(name); keyPath = convertKeyPath(keyPath);
      var unique = !!(options && options.unique), multiEntry = !!(options && options.multiEntry);
      var st = this._store, tx = this._tx;
      if (tx._mode !== "versionchange") throw dom("InvalidStateError", "Indexes can only be created during an upgrade");
      if (st.deleted) throw dom("InvalidStateError", "The object store has been deleted");
      assertActive(tx);
      if (st.indexes[name]) throw dom("ConstraintError", "An index named " + name + " already exists");
      if (!validKeyPath(keyPath)) throw dom("SyntaxError", "The key path is not valid");
      if (Array.isArray(keyPath) && multiEntry) throw dom("InvalidAccessError", "A multiEntry index cannot have an array key path");
      var ix = { name: name, keyPath: keyPath, unique: unique, multiEntry: multiEntry, records: [], pending: true };
      st.indexes[name] = ix;
      // Populated in request order: writes queued before createIndex are already in the store; a
      // uniqueness violation aborts the upgrade transaction (no error event).
      tx._requests.push({ internal: function () {
        ix.pending = false;
        if (ix.deleted) return;
        var violated = false;
        st.records.forEach(function (r) {
          indexKeysFor(ix, r.value).forEach(function (k) {
            if (unique && ix.records.some(function (e) { return cmp(e.key, k) === 0; })) violated = true;
            ix.records.splice(findIndex(ix.records, k, r.key), 0, { key: k, pk: r.key });
          });
        });
        if (violated) throw dom("ConstraintError", "Unique index constraint violated");
      } });
      schedule(tx);
      var obj = makeIndex(this, ix);
      this._indexObjects[name] = obj;
      return obj;
    }
    deleteIndex(name) {
      if (arguments.length < 1) throw new TypeError("deleteIndex requires 1 argument");
      var st = this._store, tx = this._tx;
      if (tx._mode !== "versionchange") throw dom("InvalidStateError", "Indexes can only be deleted during an upgrade");
      if (st.deleted) throw dom("InvalidStateError", "The object store has been deleted");
      assertActive(tx);
      name = String(name);
      var ix = st.indexes[name];
      if (!ix) throw dom("NotFoundError", "No index named " + name);
      ix.deleted = true;
      delete this._indexObjects[name];
      var hidden = "\u0000deleted\u0000" + name + "\u0000" + Math.random();
      delete st.indexes[name];
      st.indexes[hidden] = ix;
      tx._requests.push({ internal: function () { if (st.indexes[hidden] === ix) delete st.indexes[hidden]; } });
      schedule(tx);
    }
  }
  function makeStore(tx, store) {
    var s = create(IDBObjectStore);
    Object.defineProperties(s, { _tx: { value: tx }, _store: { value: store, writable: true }, _indexObjects: { value: {}, writable: true } });
    return s;
  }
  function checkStore(so) {
    if (so._store.deleted) throw dom("InvalidStateError", "The object store has been deleted");
    assertActive(so._tx);
    return so._store;
  }
  function firstInRange(records, range) {
    for (var i = range._l === undefined ? 0 : findIndex(records, range._l); i < records.length; i++) { if (rangeIncludes(range, records[i].key)) return records[i]; if (range._u !== undefined && cmp(records[i].key, range._u) > 0) break; }
    return null;
  }
  function storeWrite(so, value, key, argc, noOverwrite) {
    if (argc < 1) throw new TypeError((noOverwrite ? "add" : "put") + " requires 1 argument");
    var st = so._store, tx = so._tx;
    if (st.deleted) throw dom("InvalidStateError", "The object store has been deleted");
    assertActive(tx);
    if (tx._mode === "readonly") throw dom("ReadOnlyError", "The transaction is read-only");
    var inline = st.keyPath !== null;
    if (inline && key !== undefined) throw dom("DataError", "The object store uses in-line keys and the key parameter was provided");
    if (!inline && !st.autoIncrement && key === undefined) throw dom("DataError", "The object store uses out-of-line keys and has no key generator and the key parameter was not provided");
    var k;
    if (key !== undefined) k = valueToKeyOrThrow(key);
    tx._state = "inactive";
    var v;
    try { v = clone(value); } finally { tx._state = "active"; }
    if (inline) {
      var kpk = extractKey(v, st.keyPath, false);
      if (kpk === INVALID) throw dom("DataError", "Evaluating the object store's key path yielded a value that is not a valid key");
      if (kpk === FAIL) {
        if (!st.autoIncrement) throw dom("DataError", "Evaluating the object store's key path did not yield a value");
        if (Array.isArray(st.keyPath) || !canInjectKey(v, st.keyPath)) throw dom("DataError", "A generated key could not be inserted into the value");
      } else k = kpk;
    }
    return queueRequest(tx, so, function () { return keyToValue(storeRecord(st, v, k, noOverwrite)); });
  }
  function storeRecord(st, value, key, noOverwrite) {
    if (st.autoIncrement) {
      if (key === undefined) {
        if (st.current > MAX_KEYGEN) throw dom("ConstraintError", "The key generator has reached its maximum");
        key = { t: "number", v: st.current++ };
        if (st.keyPath !== null) injectKey(value, key, st.keyPath);
      } else if (key.t === "number") {
        var n = Math.min(Math.floor(key.v), MAX_KEYGEN);
        if (n >= st.current) st.current = n >= MAX_KEYGEN ? Infinity : n + 1;
      }
    }
    var existing = storeGet(st, key);
    if (existing && noOverwrite) throw dom("ConstraintError", "A record with this key already exists");
    // index keys first: a uniqueness violation must leave the store untouched
    var additions = [];
    Object.keys(st.indexes).forEach(function (n) {
      var ix = st.indexes[n];
      if (ix.pending) return;
      indexKeysFor(ix, value).forEach(function (ik) {
        if (ix.unique && ix.records.some(function (e) { return cmp(e.key, ik) === 0 && cmp(e.pk, key) !== 0; })) throw dom("ConstraintError", "Unique index constraint violated in " + n);
        additions.push([ix, ik]);
      });
    });
    if (existing) {
      st.records.splice(findIndex(st.records, key), 1);
      Object.keys(st.indexes).forEach(function (n) { indexRemovePk(st.indexes[n], key); });
    }
    st.records.splice(findIndex(st.records, key), 0, { key: key, value: value });
    additions.forEach(function (a) { var ix = a[0]; ix.records.splice(findIndex(ix.records, a[1], key), 0, { key: a[1], pk: key }); });
    return key;
  }

  // getAll / getAllKeys / getAllRecords (with the IDBGetAllOptions dictionary)
  function getAllImpl(src, isIndex, kind, queryOrOptions, count, argc) {
    var st = isIndex ? src._so._store : src._store, tx = src._tx;
    if (st.deleted || (isIndex && src._index.deleted)) throw dom("InvalidStateError", "The " + (isIndex ? "index" : "object store") + " has been deleted");
    assertActive(tx);
    var query = queryOrOptions, direction = "next";
    var useOptions = argc === -1 || (queryOrOptions !== null && typeof queryOrOptions === "object" && !isPotentiallyValidKeyRange(queryOrOptions));
    if (useOptions) {
      var o = queryOrOptions || {};
      query = o.query; count = o.count;
      direction = o.direction === undefined ? "next" : String(o.direction);
      if (["next", "nextunique", "prev", "prevunique"].indexOf(direction) < 0) throw new TypeError("Invalid direction");
    }
    var range = toRange(query, false);
    var limit = count === undefined ? 0 : enforceUL(count);
    return queueRequest(tx, src, function () {
      var recs = isIndex ? src._index.records.map(function (r) { return { key: r.key, pk: r.pk, value: storeGet(st, r.pk).value }; })
        : st.records.map(function (r) { return { key: r.key, pk: r.key, value: r.value }; });
      recs = recs.filter(function (r) { return rangeIncludes(range, r.key); });
      if (direction === "prev" || direction === "prevunique") recs.reverse();
      if (direction === "nextunique" || direction === "prevunique") {
        var out = [];
        recs.forEach(function (r) {
          if (direction === "prevunique") { var j = out.findIndex(function (x) { return cmp(x.key, r.key) === 0; }); if (j >= 0) out[j] = r; else out.push(r); }
          else if (!out.some(function (x) { return cmp(x.key, r.key) === 0; })) out.push(r);
        });
        recs = out;
      }
      if (limit) recs = recs.slice(0, limit);
      if (kind === "value") return recs.map(function (r) { return clone(r.value); });
      if (kind === "key") return recs.map(function (r) { return keyToValue(r.pk); });
      return recs.map(function (r) { return makeRecord(r); });
    });
  }
  function enforceUL(v) {
    var n = Number(v);
    if (!isFinite(n)) throw new TypeError("count is not a finite number");
    n = Math.trunc(n);
    if (n < 0 || n > 4294967295) throw new TypeError("count is out of range");
    return n;
  }
  var constructingRecord = false;
  class IDBRecord {
    constructor() { if (!constructingRecord) throw new TypeError("Illegal constructor"); }
    get key() { return this._key; }
    get primaryKey() { return this._pk; }
    get value() { return this._value; }
  }
  function makeRecord(r) {
    constructingRecord = true; var rec; try { rec = new IDBRecord(); } finally { constructingRecord = false; }
    Object.defineProperties(rec, { _key: { value: keyToValue(r.key) }, _pk: { value: keyToValue(r.pk) }, _value: { value: clone(r.value) } });
    return rec;
  }

  // ------------------------------------------------------------------ indexes
  class IDBIndex {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); }
    get name() { return this._index.name; }
    set name(v) {
      v = String(v);
      var tx = this._tx, ix = this._index, st = this._so._store;
      if (tx._mode !== "versionchange") throw dom("InvalidStateError", "Indexes can only be renamed during an upgrade");
      if (ix.deleted || st.deleted) throw dom("InvalidStateError", "The index has been deleted");
      assertActive(tx);
      if (ix.name === v) return;
      if (st.indexes[v]) throw dom("ConstraintError", "An index named " + v + " already exists");
      delete st.indexes[ix.name]; delete this._so._indexObjects[ix.name];
      ix.name = v; st.indexes[v] = ix; this._so._indexObjects[v] = this;
    }
    get objectStore() { return this._so; }
    get keyPath() { var kp = this._index.keyPath; if (Array.isArray(kp)) return this._kpArray || (this._kpArray = kp.slice()); return kp; }
    get multiEntry() { return this._index.multiEntry; }
    get unique() { return this._index.unique; }
    get(query) {
      if (arguments.length < 1) throw new TypeError("get requires 1 argument");
      var self = this; checkIndex(this); var range = toRange(query, true), st = this._so._store;
      return queueRequest(this._tx, this, function () { var r = firstInRange(self._index.records, range); return r ? clone(storeGet(st, r.pk).value) : undefined; });
    }
    getKey(query) {
      if (arguments.length < 1) throw new TypeError("getKey requires 1 argument");
      var self = this; checkIndex(this); var range = toRange(query, true);
      return queueRequest(this._tx, this, function () { var r = firstInRange(self._index.records, range); return r ? keyToValue(r.pk) : undefined; });
    }
    getAll(queryOrOptions, count) { return getAllImpl(this, true, "value", queryOrOptions, count, arguments.length); }
    getAllKeys(queryOrOptions, count) { return getAllImpl(this, true, "key", queryOrOptions, count, arguments.length); }
    getAllRecords(options) { return getAllImpl(this, true, "record", options, undefined, -1); }
    count(query) {
      var self = this; checkIndex(this); var range = toRange(query, false);
      return queueRequest(this._tx, this, function () { return self._index.records.filter(function (r) { return rangeIncludes(range, r.key); }).length; });
    }
    openCursor(query, direction) { return openCursorImpl(this, true, query, direction, false); }
    openKeyCursor(query, direction) { return openCursorImpl(this, true, query, direction, true); }
  }
  function makeIndex(so, ix) {
    var i = create(IDBIndex);
    Object.defineProperties(i, { _so: { value: so }, _tx: { value: so._tx }, _index: { value: ix } });
    return i;
  }
  function checkIndex(io) {
    if (io._index.deleted || io._so._store.deleted) throw dom("InvalidStateError", "The index or its object store has been deleted");
    assertActive(io._tx);
  }

  // ------------------------------------------------------------------ cursors
  class IDBCursor {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); }
    get source() { return this._source; }
    get direction() { return this._direction; }
    get key() { return this._key === undefined ? undefined : (this._keyValue !== undefined ? this._keyValue : (this._keyValue = keyToValue(this._key))); }
    get primaryKey() { return this._pk === undefined ? undefined : (this._pkValue !== undefined ? this._pkValue : (this._pkValue = keyToValue(this._pk))); }
    get request() { return this._request; }
    advance(count) {
      if (arguments.length < 1) throw new TypeError("advance requires 1 argument");
      count = enforceUL(count);
      if (count === 0) throw new TypeError("count must not be 0");
      cursorChecks(this);
      if (!this._gotValue) throw dom("InvalidStateError", "The cursor is being iterated or has iterated past its end");
      this._gotValue = false;
      var self = this;
      this._request._done = false;
      queueRequest(this._tx, this._source, function () { return iterate(self, undefined, undefined, count); }, this._request);
    }
    continue(key) {
      cursorChecks(this);
      if (!this._gotValue) throw dom("InvalidStateError", "The cursor is being iterated or has iterated past its end");
      var k;
      if (key !== undefined) {
        k = valueToKeyOrThrow(key);
        var c = cmp(k, this._key);
        if ((this._direction === "next" || this._direction === "nextunique") && c <= 0) throw dom("DataError", "The key is not after the cursor's position");
        if ((this._direction === "prev" || this._direction === "prevunique") && c >= 0) throw dom("DataError", "The key is not before the cursor's position");
      }
      this._gotValue = false;
      var self = this;
      this._request._done = false;
      queueRequest(this._tx, this._source, function () { return iterate(self, k, undefined, 1); }, this._request);
    }
    continuePrimaryKey(key, primaryKey) {
      if (arguments.length < 2) throw new TypeError("continuePrimaryKey requires 2 arguments");
      cursorChecks(this);
      if (!this._isIndex) throw dom("InvalidAccessError", "continuePrimaryKey is only for index cursors");
      if (this._direction !== "next" && this._direction !== "prev") throw dom("InvalidAccessError", "continuePrimaryKey needs a next or prev cursor");
      if (!this._gotValue) throw dom("InvalidStateError", "The cursor is being iterated or has iterated past its end");
      var k = valueToKeyOrThrow(key), pk = valueToKeyOrThrow(primaryKey);
      var c = cmp(k, this._key);
      if (this._direction === "next" && (c < 0 || (c === 0 && cmp(pk, this._pk) <= 0))) throw dom("DataError", "The key is not after the cursor's position");
      if (this._direction === "prev" && (c > 0 || (c === 0 && cmp(pk, this._pk) >= 0))) throw dom("DataError", "The key is not before the cursor's position");
      this._gotValue = false;
      var self = this;
      this._request._done = false;
      queueRequest(this._tx, this._source, function () { return iterate(self, k, pk, 1); }, this._request);
    }
    update(value) {
      if (arguments.length < 1) throw new TypeError("update requires 1 argument");
      cursorChecks(this);
      if (this._tx._mode === "readonly") throw dom("ReadOnlyError", "The transaction is read-only");
      if (!this._gotValue || this._keyOnly) throw dom("InvalidStateError", "The cursor has no value");
      var st = this._store;
      var tx = this._tx;
      tx._state = "inactive";
      var v;
      try { v = clone(value); } finally { tx._state = "active"; }
      if (st.keyPath !== null) {
        var kpk = extractKey(v, st.keyPath, false);
        if (kpk === FAIL || kpk === INVALID || cmp(kpk, this._pk) !== 0) throw dom("DataError", "The value's key does not match the cursor's effective key");
      }
      var pk = this._pk;
      return queueRequest(tx, this, function () { return keyToValue(storeRecord(st, v, pk, false)); });
    }
    delete() {
      cursorChecks(this);
      if (this._tx._mode === "readonly") throw dom("ReadOnlyError", "The transaction is read-only");
      if (!this._gotValue || this._keyOnly) throw dom("InvalidStateError", "The cursor has no value");
      var st = this._store, pk = this._pk;
      return queueRequest(this._tx, this, function () {
        var i = findIndex(st.records, pk);
        if (i < st.records.length && cmp(st.records[i].key, pk) === 0) st.records.splice(i, 1);
        Object.keys(st.indexes).forEach(function (n) { indexRemovePk(st.indexes[n], pk); });
        return undefined;
      });
    }
  }
  class IDBCursorWithValue extends IDBCursor {
    get value() { return this._value; }
  }
  function cursorChecks(c) {
    if (c._store.deleted || (c._isIndex && c._source._index.deleted)) throw dom("InvalidStateError", "The cursor's source has been deleted");
    assertActive(c._tx);
  }
  function openCursorImpl(src, isIndex, query, direction, keyOnly) {
    if (isIndex) checkIndex(src); else checkStore(src);
    direction = direction === undefined ? "next" : String(direction);
    if (["next", "nextunique", "prev", "prevunique"].indexOf(direction) < 0) throw new TypeError("Invalid cursor direction");
    var range = toRange(query, false);
    var cursor = create(keyOnly ? IDBCursor : IDBCursorWithValue);
    var req = create(IDBRequest);
    Object.defineProperties(cursor, {
      _source: { value: src }, _direction: { value: direction }, _range: { value: range }, _keyOnly: { value: keyOnly },
      _isIndex: { value: isIndex }, _tx: { value: src._tx }, _store: { value: isIndex ? src._so._store : src._store }, _request: { value: req },
    });
    cursor._gotValue = false; cursor._key = undefined; cursor._pk = undefined; cursor._value = undefined;
    return queueRequest(src._tx, src, function () { return iterate(cursor, undefined, undefined, 1); }, req);
  }
  // "Iterate a cursor": returns the cursor, or null at the end.
  function iterate(c, key, primaryKey, count) {
    var forward = c._direction === "next" || c._direction === "nextunique";
    var unique = c._direction === "nextunique" || c._direction === "prevunique";
    var records = c._isIndex ? c._source._index.records : c._store.records.map(function (r) { return { key: r.key, pk: r.key }; });
    var pos = c._key, posPk = c._pk;
    var found = null;
    while (count > 0) {
      found = null;
      if (forward) {
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          if (!rangeIncludes(c._range, r.key)) continue;
          if (key !== undefined && cmp(r.key, key) < 0) continue;
          if (primaryKey !== undefined && cmp(r.key, key) === 0 && cmp(r.pk, primaryKey) < 0) continue;
          if (pos !== undefined) {
            var cpos = cmp(r.key, pos);
            if (unique ? cpos <= 0 : (cpos < 0 || (cpos === 0 && (!c._isIndex || cmp(r.pk, posPk) <= 0)))) continue;
          }
          found = r; break;
        }
      } else {
        for (var j = records.length - 1; j >= 0; j--) {
          var q = records[j];
          if (!rangeIncludes(c._range, q.key)) continue;
          if (key !== undefined && cmp(q.key, key) > 0) continue;
          if (primaryKey !== undefined && cmp(q.key, key) === 0 && cmp(q.pk, primaryKey) > 0) continue;
          if (pos !== undefined) {
            var cq = cmp(q.key, pos);
            if (unique ? cq >= 0 : (cq > 0 || (cq === 0 && (!c._isIndex || cmp(q.pk, posPk) >= 0)))) continue;
          }
          if (c._direction === "prevunique") {
            // the first (lowest primary key) record with this key
            while (j > 0 && cmp(records[j - 1].key, q.key) === 0 && rangeIncludes(c._range, records[j - 1].key)) { j--; q = records[j]; }
          }
          found = q; break;
        }
      }
      if (!found) break;
      pos = found.key; posPk = found.pk;
      key = undefined; primaryKey = undefined;
      count--;
    }
    if (!found) {
      c._key = undefined; c._pk = undefined; c._value = undefined; c._keyValue = undefined; c._pkValue = undefined;
      c._gotValue = false;
      return null;
    }
    c._key = found.key; c._pk = found.pk; c._keyValue = undefined; c._pkValue = undefined;
    if (!c._keyOnly) { var rec = storeGet(c._store, found.pk); c._value = rec ? clone(rec.value) : undefined; }
    c._gotValue = true;
    return c;
  }

  // ------------------------------------------------------------------ connections
  class IDBDatabase extends EventTarget {
    constructor() { super(); if (!constructing) throw new TypeError("Illegal constructor"); }
    get name() { return this._db.name; }
    get version() { return this._version; }
    get objectStoreNames() {
      if (this._storeNamesList && this._storeNamesVersion === this._db.storesVersion) return this._storeNamesList;
      this._storeNamesVersion = this._db.storesVersion;
      return (this._storeNamesList = stringList(this._snapshotNames && (this._closePending || !this._upgradeTx || this._upgradeTx._state === "finished") ? this._snapshotNames : Object.keys(this._db.stores)));
    }
    createObjectStore(name, options) {
      if (arguments.length < 1) throw new TypeError("createObjectStore requires 1 argument");
      name = String(name);
      var keyPath = options && options.keyPath !== undefined ? convertKeyPath(options.keyPath) : null;
      var autoIncrement = !!(options && options.autoIncrement);
      var tx = this._upgradeTx;
      if (!tx || tx._state === "finished") throw dom("InvalidStateError", "Object stores can only be created during an upgrade");
      assertActive(tx);
      if (this._db.stores[name]) throw dom("ConstraintError", "An object store named " + name + " already exists");
      if (keyPath !== null && !validKeyPath(keyPath)) throw dom("SyntaxError", "The key path is not valid");
      if (autoIncrement && (keyPath === "" || Array.isArray(keyPath))) throw dom("InvalidAccessError", "An autoIncrement object store cannot have an empty or array key path");
      var store = { name: name, keyPath: keyPath, autoIncrement: autoIncrement, current: 1, records: [], indexes: {}, deleted: false };
      this._db.stores[name] = store;
      this._db.storesVersion++;
      var so = makeStore(tx, store);
      tx._storeObjects[name] = so;
      return so;
    }
    deleteObjectStore(name) {
      if (arguments.length < 1) throw new TypeError("deleteObjectStore requires 1 argument");
      name = String(name);
      var tx = this._upgradeTx;
      if (!tx || tx._state === "finished") throw dom("InvalidStateError", "Object stores can only be deleted during an upgrade");
      assertActive(tx);
      var store = this._db.stores[name];
      if (!store) throw dom("NotFoundError", "No object store named " + name);
      store.deleted = true;
      Object.keys(store.indexes).forEach(function (n) { store.indexes[n].deleted = true; });
      delete this._db.stores[name];
      delete tx._storeObjects[name];
      this._db.storesVersion++;
    }
    transaction(storeNames, mode, options) {
      if (arguments.length < 1) throw new TypeError("transaction requires 1 argument");
      if (this._upgradeTx && this._upgradeTx._state !== "finished") throw dom("InvalidStateError", "A version change transaction is running");
      if (this._closePending) throw dom("InvalidStateError", "The connection is closing");
      var names = typeof storeNames === "string" ? [storeNames] : __jb.arrayFrom(storeNames, String);
      names = names.filter(function (n, i) { return names.indexOf(n) === i; });
      var self = this;
      names.forEach(function (n) { if (!self._db.stores[n]) throw dom("NotFoundError", "No object store named " + n); });
      if (names.length === 0) throw dom("InvalidAccessError", "The scope is empty");
      mode = mode === undefined ? "readonly" : String(mode);
      if (mode !== "readonly" && mode !== "readwrite") throw new TypeError("Invalid transaction mode");
      var durability = options && options.durability !== undefined ? String(options.durability) : "default";
      if (["default", "strict", "relaxed"].indexOf(durability) < 0) throw new TypeError("Invalid durability");
      return newTransaction(this, names.sort(), mode, durability);
    }
    close() { closeConnection(this, false); }
    get _eventParent() { return null; }
  }
  defineHandlers(IDBDatabase, ["abort", "close", "error", "versionchange"]);

  function closeConnection(conn, forced) {
    if (conn._closePending) return;
    conn._snapshotNames = Object.keys(conn._db.stores);
    conn._closePending = true;
    if (forced) conn._transactions.slice().forEach(function (tx) { abortTransaction(tx, dom("AbortError", "The connection was closed")); });
    connectionMaybeClosed(conn);
    if (forced) fire(conn, "close", { bubbles: false, cancelable: false });
  }
  function connectionMaybeClosed(conn) {
    if (conn._closePending && !conn._closed && conn._transactions.length === 0) {
      conn._closed = true;
      var list = conn._db.connections, i = list.indexOf(conn);
      if (i >= 0) list.splice(i, 1);
      (conn._db.waiters || []).slice().forEach(function (w) { w(); });
    }
  }

  // ------------------------------------------------------------------ factory
  var opQueues = Object.create(null); // per database name: serialized open/delete requests
  function enqueue(name, fn) {
    var q = opQueues[name] || (opQueues[name] = []);
    q.push(fn);
    if (q.length === 1) setTimeout(function () { fn(done); }, 0);
    function done() { q.shift(); if (q.length) { var next = q[0]; setTimeout(function () { next(done); }, 0); } }
  }
  // Wait until every other connection to db is closed (after versionchange/blocked events).
  function waitForOthers(db, except, request, oldVersion, newVersion, then) {
    var others = db.connections.filter(function (c) { return c !== except && !c._closePending; });
    others.forEach(function (c) { if (!c._closePending) fire(c, "versionchange", { oldVersion: oldVersion, newVersion: newVersion }, IDBVersionChangeEvent); });
    var open = function () { return db.connections.filter(function (c) { return c !== except && !c._closed; }); };
    if (open().length === 0) { then(); return; }
    setTimeout(function () {
      if (open().some(function (c) { return !c._closePending; })) fire(request, "blocked", { oldVersion: oldVersion, newVersion: newVersion }, IDBVersionChangeEvent);
    }, 0);
    db.waiters = db.waiters || [];
    var waiter = function () {
      if (open().length) return;
      db.waiters.splice(db.waiters.indexOf(waiter), 1);
      setTimeout(then, 0);
    };
    db.waiters.push(waiter);
  }

  class IDBFactory {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); }
    open(name, version) {
      if (arguments.length < 1) throw new TypeError("open requires 1 argument");
      name = String(name);
      if (version !== undefined) {
        var v = Number(version);
        if (!isFinite(v)) throw new TypeError("version is not a finite number");
        v = Math.trunc(v);
        if (v < 1 || v > MAX_KEYGEN - 1) throw new TypeError("version must be between 1 and 2^53 - 1");
        version = v;
      }
      var request = create(IDBOpenDBRequest);
      enqueue(name, function (done) {
        var dbs = dbsForOrigin();
        var db = dbs[name];
        var ver = version === undefined ? (db ? db.version : 1) : version;
        if (db && db.version > ver) {
          request._done = true; request._result = undefined; request._error = dom("VersionError", "The requested version is lower than the existing one");
          fire(request, "error", { bubbles: true, cancelable: true });
          done(); return;
        }
        if (!db) { db = dbs[name] = { name: name, version: 0, stores: {}, connections: [], storesVersion: 0 }; }
        var conn = create(IDBDatabase);
        conn._db = db; conn._version = db.version; conn._transactions = []; conn._closePending = false; conn._closed = false; conn._upgradeTx = null;
        db.connections.push(conn);
        if (db.version < ver) {
          var oldVersion = db.version;
          waitForOthers(db, conn, request, oldVersion, ver, function () {
            if (conn._closePending) {
              request._done = true; request._error = dom("AbortError", "The connection was closed"); request._result = undefined;
              fire(request, "error", { bubbles: true, cancelable: true }); done(); return;
            }
            var tx = newTransaction(conn, [], "versionchange", "default");
            tx._snapshot.oldVersion = oldVersion;
            conn._upgradeTx = tx;
            db.version = ver; conn._version = ver;
            request._done = true; request._result = conn; request._tx = tx;
            // "Abort an upgrade transaction": the versions revert at once.
            tx._onAbortSync = function () {
              db.version = oldVersion; conn._version = oldVersion;
              conn._snapshotNames = Object.keys(db.stores);
            };
            tx._onFinished = function (aborted) {
              conn._upgradeTx = null;
              if (aborted) {
                if (oldVersion === 0) { delete dbsForOrigin()[name]; }
                closeConnection(conn, false);
                setTimeout(function () {
                  request._tx = null; request._result = undefined; request._error = dom("AbortError", "The version change transaction was aborted");
                  fire(request, "error", { bubbles: true, cancelable: true });
                  done();
                }, 0);
              } else {
                request._tx = null;
                setTimeout(function () {
                  if (conn._closePending) {
                    request._result = undefined; request._error = dom("AbortError", "The connection was closed before the upgrade finished");
                    fire(request, "error", { bubbles: true, cancelable: true });
                  } else fire(request, "success", { bubbles: false, cancelable: false });
                  done();
                }, 0);
              }
            };
            var r = fire(request, "upgradeneeded", { oldVersion: oldVersion, newVersion: ver }, IDBVersionChangeEvent);
            if (tx._state === "active") tx._state = "inactive";
            if (r.threw) abortTransaction(tx, dom("AbortError", "An upgradeneeded handler threw"));
            else schedule(tx);
          });
          return;
        }
        request._done = true; request._result = conn;
        fire(request, "success", { bubbles: false, cancelable: false });
        done();
      });
      return request;
    }
    deleteDatabase(name) {
      if (arguments.length < 1) throw new TypeError("deleteDatabase requires 1 argument");
      name = String(name);
      var request = create(IDBOpenDBRequest);
      enqueue(name, function (done) {
        var dbs = dbsForOrigin(), db = dbs[name];
        var finish = function (oldVersion) {
          delete dbsForOrigin()[name];
          persist();
          request._done = true; request._result = undefined;
          fire(request, "success", { oldVersion: oldVersion, newVersion: null }, IDBVersionChangeEvent);
          done();
        };
        if (!db) { finish(0); return; }
        waitForOthers(db, null, request, db.version, null, function () { finish(db.version); });
      });
      return request;
    }
    databases() {
      var dbs = dbsForOrigin();
      return Promise.resolve(Object.keys(dbs).filter(function (n) { return dbs[n].version > 0; }).map(function (n) { return { name: n, version: dbs[n].version }; }));
    }
    cmp(first, second) {
      if (arguments.length < 2) throw new TypeError("cmp requires 2 arguments");
      return cmp(valueToKeyOrThrow(first), valueToKeyOrThrow(second));
    }
  }

  // ------------------------------------------------------------------ persistence (host idb snapshot)
  function encodeKey(k) { return k.t === "binary" ? { t: "binary", v: __jb.bytesToB64(k.v) } : k.t === "array" ? { t: "array", v: k.v.map(encodeKey) } : k; }
  function decodeKey(k) { return k.t === "binary" ? { t: "binary", v: __jb.b64ToBytes(k.v) } : k.t === "array" ? { t: "array", v: k.v.map(decodeKey) } : k; }
  function encodeValue(v) {
    if (v === undefined) return { $u: 1 };
    if (v === null || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number") return isFinite(v) ? v : { $n: String(v) };
    if (typeof v === "bigint") return { $bi: String(v) };
    if (v instanceof Date) return { $d: v.getTime() };
    if (v instanceof ArrayBuffer) return { $ab: __jb.bytesToB64(new Uint8Array(v)) };
    if (ArrayBuffer.isView(v)) return { $ta: Object.prototype.toString.call(v).slice(8, -1), b: __jb.bytesToB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (v instanceof Map) return { $map: __jb.arrayFrom(v, function (e) { return [encodeValue(e[0]), encodeValue(e[1])]; }) };
    if (v instanceof Set) return { $set: __jb.arrayFrom(v, encodeValue) };
    if (Array.isArray(v)) return v.map(encodeValue);
    if (typeof v === "object") { var o = {}; Object.keys(v).forEach(function (k) { o[k] = encodeValue(v[k]); }); return { $o: o }; }
    return null;
  }
  function decodeValue(v) {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(decodeValue);
    if (v.$u) return undefined;
    if (v.$n !== undefined) return Number(v.$n);
    if (v.$bi !== undefined) return BigInt(v.$bi);
    if (v.$d !== undefined) return new Date(v.$d);
    if (v.$ab !== undefined) return __jb.b64ToBytes(v.$ab).buffer;
    if (v.$ta !== undefined) { var C = globalThis[v.$ta] || Uint8Array; var bytes = __jb.b64ToBytes(v.b); return new C(bytes.buffer, 0, bytes.byteLength / (C.BYTES_PER_ELEMENT || 1)); }
    if (v.$map !== undefined) return new Map(v.$map.map(function (e) { return [decodeValue(e[0]), decodeValue(e[1])]; }));
    if (v.$set !== undefined) return new Set(v.$set.map(decodeValue));
    if (v.$o !== undefined) { var o = {}; Object.keys(v.$o).forEach(function (k) { o[k] = decodeValue(v.$o[k]); }); return o; }
    return v;
  }
  __jb.idbSnapshot = function () {
    var dbs = dbsForOrigin(), out = {};
    try {
      Object.keys(dbs).forEach(function (n) {
        var db = dbs[n];
        if (db.version === 0) return;
        // an upgrade still running when the page ends is not committed (its version rolls back)
        if ((db.connections || []).some(function (c) { return c._upgradeTx && c._upgradeTx._state !== "finished"; })) return;
        var stores = {};
        Object.keys(db.stores).forEach(function (sn) {
          var s = db.stores[sn];
          stores[sn] = { v2: 1, keyPath: s.keyPath, autoIncrement: s.autoIncrement, current: s.current,
            records: s.records.map(function (r) { return [encodeKey(r.key), encodeValue(r.value)]; }),
            indexes: Object.keys(s.indexes).filter(function (i) { return i.charAt(0) !== "\u0000"; }).map(function (i) { var x = s.indexes[i]; return { name: i, keyPath: x.keyPath, unique: x.unique, multiEntry: x.multiEntry }; }) };
        });
        out[n] = { version: db.version, stores: stores };
      });
    } catch (e) { return null; }
    return Object.keys(out).length ? out : null;
  };
  __jb.idbRestore = function (snap) {
    var dbs = dbsForOrigin();
    Object.keys(dbs).forEach(function (k) { delete dbs[k]; });
    if (!snap || typeof snap !== "object") return;
    Object.keys(snap).forEach(function (name) {
      var d = snap[name];
      if (!d || typeof d !== "object" || !d.stores) return;
      var db = { name: name, version: d.version || 1, stores: {}, connections: [], storesVersion: 0 };
      var stale = false;
      Object.keys(d.stores).forEach(function (sn) {
        var s = d.stores[sn];
        if (!s || !s.v2) { stale = true; return; } // snapshots of the old implementation are dropped
        var store = { name: sn, keyPath: s.keyPath, autoIncrement: !!s.autoIncrement, current: s.current || 1, records: [], indexes: {}, deleted: false };
        store.records = (s.records || []).map(function (r) { return { key: decodeKey(r[0]), value: decodeValue(r[1]) }; });
        (s.indexes || []).forEach(function (i) {
          var ix = { name: i.name, keyPath: i.keyPath, unique: !!i.unique, multiEntry: !!i.multiEntry, records: [] };
          store.records.forEach(function (r) { indexKeysFor(ix, r.value).forEach(function (k) { ix.records.splice(findIndex(ix.records, k, r.key), 0, { key: k, pk: r.key }); }); });
          store.indexes[i.name] = ix;
        });
        db.stores[sn] = store;
      });
      // a database whose stores could not be restored is dropped whole, so the page's
      // upgradeneeded handler creates its schema again
      if (!stale) dbs[name] = db;
    });
  };
  function persist() { /* the host saves __jb.idbSnapshot() when the page finishes */ }

  // ------------------------------------------------------------------ exposure
  var factory = create(IDBFactory);
  [IDBKeyRange, DOMStringList, IDBRequest, IDBOpenDBRequest, IDBTransaction, IDBObjectStore, IDBIndex, IDBCursor, IDBCursorWithValue, IDBDatabase, IDBFactory, IDBVersionChangeEvent, IDBRecord].forEach(function (C) {
    Object.getOwnPropertyNames(C.prototype).forEach(function (p) {
      if (p === "constructor" || p.charAt(0) === "_") return;
      var d = Object.getOwnPropertyDescriptor(C.prototype, p);
      if (!d.enumerable) { d.enumerable = true; Object.defineProperty(C.prototype, p, d); }
    });
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
    Object.defineProperty(globalThis, C.name, { value: C, writable: true, configurable: true, enumerable: false });
  });
  Object.defineProperty(globalThis, "indexedDB", { value: factory, writable: true, configurable: true, enumerable: true });
})();
