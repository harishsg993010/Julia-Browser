// Part 11a: Prioritized Task Scheduling (scheduler.postTask / scheduler.yield, TaskController,
// TaskSignal, TaskPriorityChangeEvent). Tasks sit in one list and the runner picks the highest
// effective priority (a TaskSignal's priority is read at selection time), oldest first;
// continuations from scheduler.yield() run ahead of plain tasks of the same priority.
(function () {
  var PRIORITIES = { "user-blocking": 2, "user-visible": 1, background: 0 };
  var checkPriority = function (p, what) {
    p = String(p);
    if (!Object.prototype.hasOwnProperty.call(PRIORITIES, p)) throw new TypeError(what + ": '" + p + "' is not a valid value for enumeration TaskPriority.");
    return p;
  };

  class TaskPriorityChangeEvent extends Event {
    constructor(type, init) {
      if (arguments.length < 2) throw new TypeError("TaskPriorityChangeEvent constructor: At least 2 arguments required");
      if (init === null || typeof init !== "object" || init.previousPriority === undefined) throw new TypeError("TaskPriorityChangeEvent constructor: 'previousPriority' member of TaskPriorityChangeEventInit is required");
      var prev = checkPriority(init.previousPriority, "TaskPriorityChangeEvent");
      super(type, init);
      Object.defineProperty(this, "_prev", { value: prev });
    }
    get previousPriority() { return this._prev; }
  }

  class TaskSignal extends AbortSignal {
    constructor() {
      if (!__jb.taskSignalConstructing) throw new TypeError("Illegal constructor");
      super();
      Object.defineProperty(this, "_priority", { value: "user-visible", writable: true });
      Object.defineProperty(this, "_changing", { value: false, writable: true });
      Object.defineProperty(this, "_dependents", { value: [] });
      this.onprioritychange = null;
    }
    get priority() { return this._priority; }
    static any(signals, init) {
      if (arguments.length < 1) throw new TypeError("TaskSignal.any: At least 1 argument required");
      var list = __jb.arrayFrom(signals);
      list.forEach(function (s) { if (!(s instanceof AbortSignal)) throw new TypeError("TaskSignal.any: element is not an AbortSignal"); });
      var src = init && init.priority !== undefined ? init.priority : "user-visible";
      var sig = newTaskSignal();
      if (src instanceof TaskSignal) {
        sig._priority = src._priority;
        src._dependents.push(sig);
      } else sig._priority = checkPriority(src, "TaskSignal.any");
      var done = false;
      var abort = function (reason) { if (done) return; done = true; sig.aborted = true; sig.reason = reason; sig.dispatchEvent(new Event("abort")); };
      for (var i = 0; i < list.length; i++) if (list[i].aborted) { sig.aborted = true; sig.reason = list[i].reason; done = true; return sig; }
      list.forEach(function (s) { s.addEventListener("abort", function () { abort(s.reason); }); });
      return sig;
    }
  }
  var newTaskSignal = function () {
    __jb.taskSignalConstructing = true;
    try { return new TaskSignal(); } finally { __jb.taskSignalConstructing = false; }
  };
  // "signal priority change": fire prioritychange, then update dependent signals.
  var changePriority = function (sig, priority) {
    if (sig._changing) throw __jb.domError("NotAllowedError", "The priority of this signal is already changing");
    if (sig._priority === priority) return;
    sig._changing = true;
    var prev = sig._priority;
    sig._priority = priority;
    try {
      sig.dispatchEvent(new TaskPriorityChangeEvent("prioritychange", { previousPriority: prev }));
      sig._dependents.forEach(function (d) { changePriority(d, priority); });
    } finally { sig._changing = false; }
  };

  class TaskController extends AbortController {
    constructor(init) {
      super();
      var p = init && init.priority !== undefined ? checkPriority(init.priority, "TaskController") : "user-visible";
      var sig = newTaskSignal();
      sig._priority = p;
      var self_ = this;
      Object.defineProperty(this, "signal", { value: sig, writable: true, configurable: true });
    }
    setPriority(priority) {
      if (arguments.length < 1) throw new TypeError("TaskController.setPriority: At least 1 argument required");
      changePriority(this.signal, checkPriority(priority, "TaskController.setPriority"));
    }
  }

  // ---- the task list of this realm ----
  var tasks = [], seq = 0, runnerScheduled = false, current = null;
  var effective = function (t) { return t.fixed !== null ? t.fixed : t.signal instanceof TaskSignal ? t.signal._priority : "user-visible"; };
  var rank = function (t) { return PRIORITIES[effective(t)] * 2 + (t.continuation ? 1 : 0); };
  var scheduleRunner = function () {
    if (runnerScheduled || !tasks.length) return;
    runnerScheduled = true;
    setTimeout(runNext, 0);
  };
  var runNext = function () {
    runnerScheduled = false;
    if (!tasks.length) return;
    var best = 0;
    for (var i = 1; i < tasks.length; i++) {
      var a = rank(tasks[i]), b = rank(tasks[best]);
      if (a > b || (a === b && tasks[i].seq < tasks[best].seq)) best = i;
    }
    var t = tasks.splice(best, 1)[0];
    scheduleRunner();
    t.run();
  };
  var enqueue = function (t) {
    t.seq = ++seq;
    tasks.push(t);
    scheduleRunner();
  };
  var remove = function (t) { var i = tasks.indexOf(t); if (i >= 0) tasks.splice(i, 1); };

  class Scheduler {
    constructor() { if (!__jb.schedulerConstructing) throw new TypeError("Illegal constructor"); }
    postTask(callback, options) {
      if (arguments.length < 1) return Promise.reject(new TypeError("Scheduler.postTask: At least 1 argument required"));
      if (typeof callback !== "function") return Promise.reject(new TypeError("Scheduler.postTask: Argument 1 is not callable"));
      options = options === undefined || options === null ? {} : options;
      var signal = options.signal, fixed = null, delay = 0;
      try {
        if (options.priority !== undefined) fixed = checkPriority(options.priority, "Scheduler.postTask");
        if (options.delay !== undefined) {
          delay = Number(options.delay);
          if (!isFinite(delay) || delay < 0 || delay > Number.MAX_SAFE_INTEGER) throw new TypeError("Scheduler.postTask: delay is out of range");
          delay = Math.trunc(delay);
        }
        if (signal !== undefined && signal !== null && !(signal instanceof AbortSignal)) throw new TypeError("Scheduler.postTask: 'signal' is not an AbortSignal");
      } catch (e) { return Promise.reject(e); }
      if (signal && signal.aborted) return Promise.reject(signal.reason);
      return new Promise(function (resolve, reject) {
        var t = { fixed: fixed, signal: signal || null, continuation: false, timer: 0 };
        t.run = function () {
          if (t.signal) t.signal.removeEventListener("abort", onAbort);
          var prev = current;
          current = { signal: t.signal, priority: effective(t), fixed: t.fixed };
          try { resolve(__jb.loafRun("user-callback", "SchedulerPostTaskCallback", callback, undefined, [])); } catch (e) { reject(e); } finally { current = prev; }
        };
        var onAbort = function () {
          if (t.timer) { clearTimeout(t.timer); t.timer = 0; }
          remove(t);
          reject(t.signal.reason);
        };
        if (t.signal) t.signal.addEventListener("abort", onAbort);
        if (delay > 0) t.timer = setTimeout(function () { t.timer = 0; enqueue(t); }, delay);
        else enqueue(t);
      });
    }
    yield() {
      // the continuation inherits the running task's priority and signal (scheduler.postTask)
      var inh = current;
      var signal = inh ? inh.signal : null, fixed = inh ? (inh.fixed !== null ? inh.fixed : signal instanceof TaskSignal ? null : inh.priority) : "user-visible";
      if (signal && signal.aborted) return Promise.reject(signal.reason);
      return new Promise(function (resolve, reject) {
        var t = { fixed: fixed, signal: signal, continuation: true };
        var onAbort = function () { remove(t); reject(signal.reason); };
        t.run = function () {
          if (signal) signal.removeEventListener("abort", onAbort);
          var prev = current;
          current = inh;
          try { resolve(undefined); } finally { current = prev; }
        };
        if (signal) signal.addEventListener("abort", onAbort);
        enqueue(t);
      });
    }
  }
  __jb.schedulerConstructing = true;
  var scheduler;
  try { scheduler = new Scheduler(); } finally { __jb.schedulerConstructing = false; }
  // [Replaceable] readonly attribute on the global
  Object.defineProperty(globalThis, "scheduler", {
    get: function () { return scheduler; },
    set: function (v) { Object.defineProperty(globalThis, "scheduler", { value: v, writable: true, enumerable: true, configurable: true }); },
    enumerable: true, configurable: true,
  });
  globalThis.Scheduler = Scheduler;
  globalThis.TaskController = TaskController;
  globalThis.TaskSignal = TaskSignal;
  globalThis.TaskPriorityChangeEvent = TaskPriorityChangeEvent;
})();
