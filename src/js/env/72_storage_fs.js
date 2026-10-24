// Part 11c: Storage (StorageManager, StorageBucketManager / StorageBucket) and the origin private
// file system (FileSystemHandle, FileSystemFileHandle, FileSystemDirectoryHandle,
// FileSystemWritableFileStream, FileSystemSyncAccessHandle). The file system lives in memory on
// the session's shared root (see 71_locks.js), one tree per origin and bucket; handles are
// locators (root + path), resolved on every operation.
(function () {
  var sharedRoot = function () {
    var j = __jb;
    try { while (j.workerOwnerJb) j = j.workerOwnerJb; } catch (e) {}
    try { return j.topJb(); } catch (e2) { return j; }
  };
  var myOrigin = function () {
    try { if (typeof __jb.effectiveOrigin === "function" && !__jb.isWorker) { var o = __jb.effectiveOrigin(globalThis); if (typeof o === "string") return o; } } catch (e) {}
    try { return self.origin; } catch (e2) { return "null"; }
  };
  var dom = function (name, msg) { return __jb.domError(name, msg); };
  var uuid = function () { return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2); };
  var storeFor = function (bucket) {
    var root = sharedRoot();
    if (!root.storageState) root.storageState = Object.create(null);
    var origin = myOrigin(), key = origin + "|" + (bucket || "default");
    return root.storageState[key] || (root.storageState[key] = { fsRoot: null, persisted: false, expires: null, quota: null });
  };
  var newDir = function (name, parent) { return { kind: "directory", name: name, parent: parent, children: new Map(), id: uuid() }; };
  var newFile = function (name, parent) { return { kind: "file", name: name, parent: parent, data: new Uint8Array(0), mtime: Date.now(), id: uuid(), writers: 0, exclusive: false, sah: false }; };
  var fsRoot = function (bucket) { var s = storeFor(bucket); if (!s.fsRoot) s.fsRoot = newDir("", null); return s.fsRoot; };

  var checkName = function (name) {
    name = String(name);
    if (name === "" || name === "." || name === ".." || name.indexOf("/") >= 0 || name.indexOf("\\") >= 0) throw new TypeError("Name is not allowed: '" + name + "'");
    return name;
  };
  // locator -> entry (null when it no longer exists)
  var resolveLoc = function (loc) {
    var e = loc.root;
    for (var i = 0; i < loc.path.length; i++) {
      if (!e || e.kind !== "directory") return null;
      e = e.children.get(loc.path[i]) || null;
    }
    return e && e.kind === loc.kind ? e : null;
  };
  var needEntry = function (loc) {
    var e = resolveLoc(loc);
    if (!e) throw dom("NotFoundError", "A requested file or directory could not be found at the time an operation was processed.");
    return e;
  };
  var pathOf = function (e) { var p = []; for (; e && e.parent; e = e.parent) p.unshift(e.name); return p; };

  var constructing = false;
  var create = function (C, loc) { constructing = true; var h; try { h = new C(); } finally { constructing = false; } Object.defineProperty(h, "_loc", { value: loc, writable: true }); return h; };
  var L = function (h, what) { if (!h || !h._loc) throw new TypeError("Illegal invocation: " + what); return h._loc; };
  var async = function (fn) { return new Promise(function (resolve) { resolve(fn()); }); };

  class FileSystemHandle {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); }
    get kind() { return L(this, "kind").kind; }
    get name() { var l = L(this, "name"); return l.path.length ? l.path[l.path.length - 1] : ""; }
    isSameEntry(other) {
      var self_ = this;
      return async(function () {
        var a = L(self_, "isSameEntry");
        if (!(other instanceof FileSystemHandle) && !(other && other._loc)) throw new TypeError("FileSystemHandle.isSameEntry: Argument 1 is not a FileSystemHandle");
        var b = other._loc;
        return a.root === b.root && a.kind === b.kind && a.path.length === b.path.length && a.path.every(function (p, i) { return p === b.path[i]; });
      });
    }
    queryPermission() { return Promise.resolve("granted"); }
    requestPermission() { return Promise.resolve("granted"); }
    getUniqueId() { var self_ = this; return async(function () { return needEntry(L(self_, "getUniqueId")).id; }); }
    remove(options) {
      var self_ = this;
      return async(function () {
        var loc = L(self_, "remove"), e = needEntry(loc);
        if (!e.parent) throw dom("InvalidModificationError", "The root directory cannot be removed");
        removeEntryChecked(e, !!(options && options.recursive));
      });
    }
    move(a, b) {
      var self_ = this;
      return async(function () {
        var loc = L(self_, "move"), e = needEntry(loc), destDir, newName;
        if (a instanceof FileSystemDirectoryHandle) { destDir = needEntry(a._loc); newName = b === undefined ? e.name : checkName(b); if (a._loc.root !== loc.root) throw dom("InvalidModificationError", "Cannot move between file systems"); }
        else { destDir = e.parent; newName = checkName(a); }
        if (!e.parent) throw dom("InvalidModificationError", "The root directory cannot be moved");
        if (e.kind === "file" && (e.writers || e.sah)) throw dom("NoModificationAllowedError", "The file is locked");
        for (var d = destDir; d; d = d.parent) if (d === e) throw dom("InvalidModificationError", "A directory cannot be moved into itself");
        var existing = destDir.children.get(newName);
        if (existing && existing !== e) {
          if (existing.kind === "directory" || e.kind === "directory") throw dom("InvalidModificationError", "An entry with that name already exists");
          if (existing.writers || existing.sah) throw dom("NoModificationAllowedError", "The destination file is locked");
        }
        e.parent.children.delete(e.name);
        e.name = newName; e.parent = destDir;
        destDir.children.set(newName, e);
        self_._loc = { root: loc.root, kind: loc.kind, path: pathOf(e) };
      });
    }
  }
  var removeEntryChecked = function (e, recursive) {
    if (e.kind === "directory" && e.children.size && !recursive) throw dom("InvalidModificationError", "The directory is not empty");
    var locked = function (x) { if (x.kind === "file") return x.writers > 0 || x.sah; var r = false; x.children.forEach(function (c) { if (locked(c)) r = true; }); return r; };
    if (locked(e)) throw dom("NoModificationAllowedError", "An entry is locked");
    e.parent.children.delete(e.name);
    e.parent = null;
  };

  class FileSystemFileHandle extends FileSystemHandle {
    getFile() {
      var self_ = this;
      return async(function () {
        var e = needEntry(L(self_, "getFile"));
        return new File([e.data.slice()], e.name, { lastModified: e.mtime });
      });
    }
    createWritable(options) {
      var self_ = this;
      return async(function () {
        var loc = L(self_, "createWritable"), e = needEntry(loc);
        var mode = options && options.mode !== undefined ? String(options.mode) : "siloed";
        if (mode !== "siloed" && mode !== "exclusive") throw new TypeError("createWritable: invalid mode");
        if (e.sah || e.exclusive || (mode === "exclusive" && e.writers)) throw dom("NoModificationAllowedError", "The file is locked");
        e.writers++;
        if (mode === "exclusive") e.exclusive = true;
        return makeWritable(loc, e, !!(options && options.keepExistingData), mode);
      });
    }
    createSyncAccessHandle(options) {
      var self_ = this;
      return async(function () {
        if (!__jb.isWorker || __jb.isSharedWorker || __jb.isServiceWorker) throw dom("NotSupportedError", "Sync access handles are only available in dedicated workers");
        var loc = L(self_, "createSyncAccessHandle"), e = needEntry(loc);
        if (e.sah || e.writers) throw dom("NoModificationAllowedError", "The file is locked");
        e.sah = true;
        var h; constructing = true; try { h = new FileSystemSyncAccessHandle(); } finally { constructing = false; }
        Object.defineProperty(h, "_s", { value: { e: e, closed: false } });
        return h;
      });
    }
  }

  // ---- directory handles ----
  var childHandle = function (loc, entry) { var l = { root: loc.root, kind: entry.kind, path: loc.path.concat([entry.name]) }; return create(entry.kind === "file" ? FileSystemFileHandle : FileSystemDirectoryHandle, l); };
  var makeIterator = function (dirHandle, kind) {
    var names = null, i = 0, it = Object.create(AsyncIteratorProto);
    it.next = function () {
      return async(function () {
        var loc = L(dirHandle, "iterator"), dir = needEntry(loc);
        if (names === null) names = __jb.arrayFrom(dir.children.keys());
        while (i < names.length) {
          var n = names[i++], e = dir.children.get(n);
          if (!e) continue;
          var h = childHandle(loc, e);
          return { value: kind === "keys" ? n : kind === "values" ? h : [n, h], done: false };
        }
        return { value: undefined, done: true };
      });
    };
    it.return = function (v) { names = []; return Promise.resolve({ value: v, done: true }); };
    return it;
  };
  var AsyncIteratorProto = Object.getPrototypeOf(Object.getPrototypeOf((async function* () {})()))
  ;
  AsyncIteratorProto = Object.getPrototypeOf(AsyncIteratorProto) || AsyncIteratorProto;
  class FileSystemDirectoryHandle extends FileSystemHandle {
    getFileHandle(name, options) { return this._get(name, options, "file", "getFileHandle"); }
    getDirectoryHandle(name, options) { return this._get(name, options, "directory", "getDirectoryHandle"); }
    _get(name, options, kind, what) {
      var self_ = this;
      return async(function () {
        var loc = L(self_, what);
        if (arguments.length === 0 && name === undefined) {}
        name = checkName(name);
        var dir = needEntry(loc), e = dir.children.get(name);
        if (e) {
          if (e.kind !== kind) throw dom("TypeMismatchError", "The path supplied exists, but was not an entry of requested type.");
        } else {
          if (!(options && options.create)) throw dom("NotFoundError", "A requested file or directory could not be found at the time an operation was processed.");
          e = kind === "file" ? newFile(name, dir) : newDir(name, dir);
          dir.children.set(name, e);
        }
        return childHandle(loc, e);
      });
    }
    removeEntry(name, options) {
      var self_ = this;
      return async(function () {
        var loc = L(self_, "removeEntry");
        name = checkName(name);
        var dir = needEntry(loc), e = dir.children.get(name);
        if (!e) throw dom("NotFoundError", "A requested file or directory could not be found at the time an operation was processed.");
        removeEntryChecked(e, !!(options && options.recursive));
      });
    }
    resolve(possibleDescendant) {
      var self_ = this;
      return async(function () {
        var a = L(self_, "resolve");
        if (!possibleDescendant || !possibleDescendant._loc) throw new TypeError("FileSystemDirectoryHandle.resolve: Argument 1 is not a FileSystemHandle");
        var b = possibleDescendant._loc;
        if (a.root !== b.root || b.path.length < a.path.length) return null;
        for (var i = 0; i < a.path.length; i++) if (a.path[i] !== b.path[i]) return null;
        return b.path.slice(a.path.length);
      });
    }
    entries() { return makeIterator(this, "entries"); }
    keys() { return makeIterator(this, "keys"); }
    values() { return makeIterator(this, "values"); }
  }
  Object.defineProperty(FileSystemDirectoryHandle.prototype, Symbol.asyncIterator, { value: FileSystemDirectoryHandle.prototype.entries, writable: true, configurable: true });

  // ---- writable file stream ----
  var toBytes = function (data) {
    if (typeof data === "string") return Promise.resolve(new TextEncoder().encode(data));
    if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer)) return Promise.resolve(new Uint8Array(data.slice(0)));
    if (ArrayBuffer.isView(data)) return Promise.resolve(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
    if (typeof Blob !== "undefined" && data instanceof Blob) return data.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return Promise.resolve(new TextEncoder().encode(String(data)));
  };
  var isChunk = function (d) { return typeof d === "string" || d instanceof ArrayBuffer || ArrayBuffer.isView(d) || (typeof Blob !== "undefined" && d instanceof Blob) || (typeof SharedArrayBuffer !== "undefined" && d instanceof SharedArrayBuffer); };
  var resize = function (buf, n) { if (buf.length === n) return buf; var out = new Uint8Array(n); out.set(buf.subarray(0, Math.min(n, buf.length))); return out; };
  var makeWritable = function (loc, entry, keep, mode) {
    var st = { buf: keep ? entry.data.slice() : new Uint8Array(0), pos: 0, done: false };
    var finish = function () { if (st.done) return; st.done = true; entry.writers = Math.max(0, entry.writers - 1); if (mode === "exclusive") entry.exclusive = false; };
    var sink = {
      write: function (chunk) {
        var p;
        if (!isChunk(chunk) && chunk !== null && typeof chunk === "object" && chunk.type !== undefined) {
          var type = String(chunk.type);
          if (type === "seek") {
            if (chunk.position === undefined || chunk.position === null) return Promise.reject(dom("SyntaxError", "seek requires a position"));
            st.pos = Number(chunk.position); return Promise.resolve();
          }
          if (type === "truncate") {
            if (chunk.size === undefined || chunk.size === null) return Promise.reject(dom("SyntaxError", "truncate requires a size"));
            st.buf = resize(st.buf, Number(chunk.size)); if (st.pos > st.buf.length) st.pos = st.buf.length; return Promise.resolve();
          }
          if (type !== "write") return Promise.reject(new TypeError("Invalid WriteCommandType '" + type + "'"));
          if (chunk.data === undefined || chunk.data === null) return Promise.reject(dom("SyntaxError", "write requires data"));
          if (chunk.position !== undefined && chunk.position !== null) st.pos = Number(chunk.position);
          p = toBytes(chunk.data);
        } else if (chunk === undefined || chunk === null || (typeof chunk === "object" && !isChunk(chunk))) {
          return Promise.reject(new TypeError("Invalid data for FileSystemWritableFileStream.write"));
        } else p = toBytes(chunk);
        return p.then(function (bytes) {
          if (!resolveLoc(loc)) throw dom("NotFoundError", "The file was removed");
          var end = st.pos + bytes.length;
          if (end > st.buf.length) st.buf = resize(st.buf, end);
          st.buf.set(bytes, st.pos);
          st.pos = end;
        });
      },
      close: function () {
        var e = resolveLoc(loc);
        finish();
        if (!e) throw dom("NotFoundError", "The file was removed");
        e.data = st.buf; e.mtime = Date.now();
      },
      abort: function () { finish(); },
    };
    constructing = true;
    var ws;
    try { ws = Reflect.construct(WritableStream, [sink], FileSystemWritableFileStream); } finally { constructing = false; }
    return ws;
  };
  class FileSystemWritableFileStream extends WritableStream {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); super(); }
    write(data) {
      if (arguments.length < 1) return Promise.reject(new TypeError("FileSystemWritableFileStream.write: At least 1 argument required"));
      var w;
      try { w = this.getWriter(); } catch (e) { return Promise.reject(e); }
      var r = w.write(data);
      w.releaseLock();
      return r;
    }
    seek(position) { return this.write({ type: "seek", position: position }); }
    truncate(size) { return this.write({ type: "truncate", size: size }); }
  }

  // ---- sync access handle (dedicated workers) ----
  class FileSystemSyncAccessHandle {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); }
    _st() { var s = this._s; if (!s) throw new TypeError("Illegal invocation"); if (s.closed) throw dom("InvalidStateError", "The access handle was closed"); return s; }
    read(buffer, options) {
      var s = this._st(), e = s.e, at = options && options.at !== undefined ? Number(options.at) : (s.pos || 0);
      var view = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer);
      if (at >= e.data.length) { s.pos = at; return 0; }
      var n = Math.min(view.length, e.data.length - at);
      view.set(e.data.subarray(at, at + n)); s.pos = at + n;
      return n;
    }
    write(buffer, options) {
      var s = this._st(), e = s.e, at = options && options.at !== undefined ? Number(options.at) : (s.pos || 0);
      var view = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer);
      if (at + view.length > e.data.length) e.data = resize(e.data, at + view.length);
      e.data.set(view, at); s.pos = at + view.length; e.mtime = Date.now();
      return view.length;
    }
    truncate(size) { var s = this._st(); s.e.data = resize(s.e.data, Number(size)); if ((s.pos || 0) > size) s.pos = Number(size); }
    getSize() { return this._st().e.data.length; }
    flush() { this._st(); }
    close() { var s = this._s; if (!s) throw new TypeError("Illegal invocation"); if (!s.closed) { s.closed = true; s.e.sah = false; } }
  }

  var rootHandle = function (bucket) {
    return async(function () {
      if (myOrigin() === "null") throw dom("SecurityError", "The origin private file system is not available in opaque origins");
      return create(FileSystemDirectoryHandle, { root: fsRoot(bucket), kind: "directory", path: [] });
    });
  };

  // ---- StorageManager ----
  var usageOf = function (bucket) {
    var n = 0, walk = function (e) { if (e.kind === "file") n += e.data.length; else e.children.forEach(walk); };
    var s = storeFor(bucket); if (s.fsRoot) walk(s.fsRoot);
    return n;
  };
  var QUOTA = 10737418240;
  class StorageManager {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); }
    persisted() { return async(function () { return storeFor(null).persisted; }); }
    persist() { return async(function () { return storeFor(null).persisted; }); }
    estimate() { return async(function () { var u = usageOf(null); return { quota: QUOTA, usage: u, usageDetails: u ? { fileSystem: u } : {} }; }); }
    getDirectory() { return rootHandle(null); }
  }

  // ---- storage buckets ----
  var bucketNames = function () { var r = sharedRoot(); if (!r.storageBuckets) r.storageBuckets = Object.create(null); var o = myOrigin(); return r.storageBuckets[o] || (r.storageBuckets[o] = []); };
  var validBucketName = function (name) { return /^[a-z0-9][a-z0-9_-]*$/.test(name) && name.length <= 64; };
  class StorageBucket {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); }
    get name() { return this._b; }
    persist() { var b = this._b; return async(function () { storeFor("b:" + b).persisted = true; return true; }); }
    persisted() { var b = this._b; return async(function () { return storeFor("b:" + b).persisted; }); }
    estimate() { var b = this._b; return async(function () { var s = storeFor("b:" + b), u = usageOf("b:" + b); return { quota: s.quota !== null ? s.quota : QUOTA, usage: u, usageDetails: u ? { fileSystem: u } : {} }; }); }
    setExpires(t) { var b = this._b; return async(function () { storeFor("b:" + b).expires = Number(t); }); }
    expires() { var b = this._b; return async(function () { return storeFor("b:" + b).expires; }); }
    get indexedDB() { return globalThis.indexedDB; }
    get caches() { return globalThis.caches; }
    getDirectory() { return rootHandle("b:" + this._b); }
  }
  var bucketObjects = new Map();
  class StorageBucketManager {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); }
    open(name, options) {
      return async(function () {
        name = String(name);
        if (!validBucketName(name)) throw new TypeError("StorageBucketManager.open: invalid bucket name '" + name + "'");
        if (options && options.quota !== undefined && !(Number(options.quota) > 0)) throw new TypeError("StorageBucketManager.open: quota must be positive");
        var names = bucketNames();
        if (names.indexOf(name) < 0) {
          names.push(name);
          var s = storeFor("b:" + name);
          s.persisted = !!(options && options.persisted);
          s.expires = options && options.expires !== undefined ? Number(options.expires) : null;
          s.quota = options && options.quota !== undefined ? Number(options.quota) : null;
        }
        if (!bucketObjects.has(name)) { var b; constructing = true; try { b = new StorageBucket(); } finally { constructing = false; } Object.defineProperty(b, "_b", { value: name }); bucketObjects.set(name, b); }
        return bucketObjects.get(name);
      });
    }
    keys() { return async(function () { return bucketNames().slice().sort(); }); }
    delete(name) {
      return async(function () {
        name = String(name);
        if (!validBucketName(name)) throw new TypeError("StorageBucketManager.delete: invalid bucket name '" + name + "'");
        var names = bucketNames(), i = names.indexOf(name);
        if (i >= 0) names.splice(i, 1);
        var r = sharedRoot(); if (r.storageState) delete r.storageState[myOrigin() + "|b:" + name];
        bucketObjects.delete(name);
      });
    }
  }

  constructing = true;
  var storage, buckets;
  try { storage = new StorageManager(); buckets = new StorageBucketManager(); } finally { constructing = false; }
  if (typeof navigator !== "undefined" && navigator) {
    try { Object.defineProperty(navigator, "storage", { get: function () { return storage; }, enumerable: true, configurable: true }); } catch (e) {}
    try { Object.defineProperty(navigator, "storageBuckets", { get: function () { return buckets; }, enumerable: true, configurable: true }); } catch (e) {}
  }
  // ---- File System Access pickers (window): options are validated, then the picker is
  // "dismissed". The embedder has no file dialog, so outside test pages the pickers stay
  // undefined and sites keep their <input type=file> path (which the agent can drive).
  var wptPage = function () { try { return !!(__jb.wptMode || (__jb.topJb && __jb.topJb().wptMode)); } catch (e) { return false; } };
  if (!globalThis.__jb_workerRealm) {
    var TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
    var WELL_KNOWN = ["desktop", "documents", "downloads", "music", "pictures", "videos"];
    var checkTypes = function (opts) {
      var types = opts.types === undefined ? [] : __jb.arrayFrom(opts.types);
      if (opts.excludeAcceptAllOption && !types.length) throw new TypeError("At least one accepted type is required");
      types.forEach(function (t) {
        var accept = t && t.accept !== undefined ? t.accept : {};
        Object.keys(accept).forEach(function (mime) {
          var m = mime.trim(), slash = m.indexOf("/");
          if (slash <= 0 || !TOKEN_RE.test(m.slice(0, slash)) || !TOKEN_RE.test(m.slice(slash + 1))) throw new TypeError("Invalid MIME type '" + mime + "'");
          var exts = accept[mime];
          (typeof exts === "string" ? [exts] : __jb.arrayFrom(exts || [])).forEach(function (e) {
            e = String(e);
            if (e.length > 16 || !/^\.[A-Za-z0-9+_\-~!.]*[A-Za-z0-9+_\-~!]$/.test(e)) throw new TypeError("Invalid extension '" + e + "'");
          });
        });
      });
    };
    var checkCommon = function (opts) {
      if (Object.prototype.hasOwnProperty.call(opts, "startIn") || opts.startIn !== undefined) {
        var s = opts.startIn;
        if (!(s instanceof FileSystemHandle) && WELL_KNOWN.indexOf(s) < 0) throw new TypeError("Invalid starting directory");
      }
      if (opts.id !== undefined) { var id = String(opts.id); if (id.length > 32 || !/^[A-Za-z0-9_-]*$/.test(id)) throw new TypeError("Invalid picker id"); }
    };
    var picker = function (kind) {
      return function (options) {
        return new Promise(function (resolve) {
          var opts = options === undefined || options === null ? {} : options;
          if (kind !== "directory") checkTypes(opts);
          checkCommon(opts);
          var top = false; try { top = globalThis.top === globalThis; } catch (e) {}
          if (!top || myOrigin() === "null") throw dom("SecurityError", "File pickers are only available in top-level documents");
          if (!(typeof __jb.hasTransientActivation === "function" && __jb.hasTransientActivation())) throw dom("SecurityError", "Showing a file picker requires user activation");
          if (__jb.consumeUserActivation) __jb.consumeUserActivation();
          throw dom("AbortError", "The user aborted a request.");
        });
      };
    };
    var pickerFns = [];
    [["showOpenFilePicker", "file"], ["showSaveFilePicker", "save"], ["showDirectoryPicker", "directory"]].forEach(function (p) {
      pickerFns.push([p[0], { [p[0]]: function (o) { return picker(p[1]).apply(this, arguments); } }[p[0]]]);
    });
    var installPickers = function () { pickerFns.forEach(function (p) { if (!Object.prototype.hasOwnProperty.call(globalThis, p[0])) Object.defineProperty(globalThis, p[0], { value: p[1], writable: true, enumerable: true, configurable: true }); }); };
    if (wptPage()) installPickers();
    else {
      // the WPT runner turns test mode on after the environment loads
      var wptVal = !!__jb.wptMode;
      try { Object.defineProperty(__jb, "wptMode", { get: function () { return wptVal; }, set: function (v) { wptVal = v; if (v) installPickers(); }, enumerable: true, configurable: true }); } catch (e) {}
    }
    // local file system handles: permission queries
    FileSystemHandle.prototype.queryPermission = function (d) { return Promise.resolve("granted"); };
    FileSystemHandle.prototype.requestPermission = function (d) { return Promise.resolve("granted"); };
  }
  __jb.fsHandleLocator = function (h) { return h && h._loc ? h._loc : null; };
  // structured clone support: a handle serializes as its locator (same session, same process)
  __jb.fsHandleFromLocator = function (loc) { return create(loc.kind === "file" ? FileSystemFileHandle : FileSystemDirectoryHandle, loc); };
  [FileSystemHandle, FileSystemFileHandle, FileSystemDirectoryHandle, FileSystemWritableFileStream, FileSystemSyncAccessHandle, StorageManager, StorageBucketManager, StorageBucket].forEach(function (C) {
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
    globalThis[C.name] = C;
  });
})();
