// Style flushes through layout reads (offsetWidth, getBoundingClientRect, ...) also update CSS
// animations and transitions (see 63_animations.js).
(function () {
  var A = __jb.anim, layoutQuery = __jb.layoutQuery;
  if (!A || typeof layoutQuery !== "function") return;
  __jb.layoutQuery = function (op, args) {
    if (typeof A.cssUpdate === "function" && !A.baseDepth && !A.inCssUpdate && op !== "style") { try { A.cssUpdate(); } catch (e) { __jb.reportException(e); } }
    return layoutQuery.apply(this, arguments);
  };
})();

// Long tasks (Long Tasks API, Long Animation Frames) of tasks the host runs outside the timer
// queue: parser-inserted scripts, the load event, network callbacks. A task ends after its
// microtask checkpoint, so the end is taken from a microtask queued last.
(function () {
  if (typeof __jb.noteLongTask !== "function") return;
  var now = function () { return performance.now(); };
  var atCheckpoint = function (t0, src) { Promise.resolve().then(function () { __jb.noteLongTask(t0, now(), src); }); };
  var bs = __jb.beginScript, es = __jb.endScript, cur = null;
  if (typeof bs === "function" && typeof es === "function") {
    __jb.beginScript = function (jbid, isModule) {
      var src = ""; try { var el = __jb.nodeById[jbid]; src = el && el.src ? String(el.src) : ""; } catch (e) {}
      cur = { t0: now(), src: src, module: !!isModule };
      return bs.apply(this, arguments);
    };
    __jb.endScript = function () {
      var el = null; try { el = __jb.currentDocument && __jb.currentDocument.currentScript; } catch (e) {}
      var r = es.apply(this, arguments);
      if (cur) {
        var c = cur; cur = null; var t1 = now();
        __jb.noteLongTask(c.t0, t1, c.src);
        if (__jb.loafRecordScript) {
          __jb.loafRecordScript(c.module ? "module-script" : "classic-script", c.src || String(location.href), c.t0, t1, c.src || String(location.href));
        }
      }
      return r;
    };
  }
  ["fireLifecycle", "deliverNetwork"].forEach(function (name) {
    var base = __jb[name];
    if (typeof base !== "function") return;
    __jb[name] = function () {
      var t0 = now();
      try { return base.apply(this, arguments); } finally { atCheckpoint(t0, ""); }
    };
  });
})();
