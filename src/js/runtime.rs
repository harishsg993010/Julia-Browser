//! Low-level SpiderMonkey (mozjs) runtime wrapper.
//!
//! One JS engine per process and one context/global per thread. All
//! communication between JS and Rust goes through a single native function,
//! `__jb_native(op, payloadJson) -> resultJson`, dispatched to a [`NativeHost`]
//! installed in a thread-local slot for the duration of a call.

use mozjs::context::{JSContext, RawJSContext};
use mozjs::conversions::{jsstr_to_string, ToJSValConvertible};
use mozjs::gc::RootedTraceableBox;
use mozjs::jsapi::{self, CallArgs, Heap, JSGCParamKey, JSObject, OnNewGlobalHookOption, Value};
use mozjs::jsval::UndefinedValue;
use mozjs::realm::AutoRealm;
use mozjs::rooted;
use mozjs::rust::wrappers2::{
    CompileJsonModule1, CompileModule1, FinishLoadingImportedModule, FinishLoadingImportedModuleFailedWithPendingException, JS_WrapObject,
    Compile1, CurrentGlobalOrNull, GetModuleRequestSpecifier, GetModuleRequestType, GetPromiseState, JS_ClearPendingException, JS_DefineFunction,
    JS_DefineProperty, JS_ExecuteScript, JS_GetModulePrivate, JS_GetPendingException, JS_GetScriptPrivate, JS_IsExceptionPending, JS_NewGlobalObject,
    JS_SetPendingException, JS_SetProperty, LoadRequestedModules1, ModuleEvaluate, ModuleLink, RunJobs, ThrowOnModuleEvaluationFailure,
};
use mozjs::rust::{evaluate_script, transform_str_to_source_text, CompileOptionsWrapper, HandleValue, JSEngine, RealmOptions, SIMPLE_GLOBAL_CLASS};
use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::CString;
use std::ptr::{self, NonNull};
use std::sync::OnceLock;

/// Host callbacks reachable from JavaScript.
pub trait NativeHost {
    /// Handle `__jb_native(op, payload)`; returns a JSON string.
    fn call(&mut self, op: &str, payload: &str) -> String;
}

static ENGINE: OnceLock<()> = OnceLock::new();

thread_local! {
    // The runtime is intentionally leaked (`&'static mut`): tearing down a
    // JSContext and its roots during thread-local destruction would touch other
    // thread-locals that may already be gone.
    static RUNTIME: RefCell<Option<&'static mut ThreadRuntime>> = const { RefCell::new(None) };
    // Never dropped at thread exit: the host owns HTTP clients and sockets
    // whose destructors must not run during thread-local teardown.
    static HOST: RefCell<std::mem::ManuallyDrop<Option<Box<dyn NativeHost>>>> = const { RefCell::new(std::mem::ManuallyDrop::new(None)) };
    // Module map (HTML "module map"): resolved URL + module type -> module
    // record, so that every import of a URL yields the same instance.
    // Never dropped at thread exit: the roots would unregister from the
    // traceables list, another thread-local that may already be destroyed.
    static MODULES: RefCell<std::mem::ManuallyDrop<HashMap<String, RootedTraceableBox<Heap<*mut JSObject>>>>> = RefCell::new(std::mem::ManuallyDrop::new(HashMap::new()));
    // Modules that failed to fetch or parse: the same error is rethrown for
    // every later import of that URL.
    static MODULE_ERRORS: RefCell<std::mem::ManuallyDrop<HashMap<String, RootedTraceableBox<Heap<Value>>>>> = RefCell::new(std::mem::ManuallyDrop::new(HashMap::new()));
    // Base URL used to resolve `import()` specifiers from classic scripts.
    static BASE_URL: RefCell<String> = const { RefCell::new(String::new()) };
    // Globals of nested browsing contexts (iframes): each frame document runs
    // in its own realm and compartment, reached from the parent through
    // cross-compartment wrappers. Slots are freed when a page is reset.
    static FRAMES: RefCell<std::mem::ManuallyDrop<Vec<Option<RootedTraceableBox<Heap<*mut JSObject>>>>>> = RefCell::new(std::mem::ManuallyDrop::new(Vec::new()));
    // Promises rejected with no handler, reported as `unhandledrejection`
    // events after the next microtask checkpoint.
    static REJECTED: RefCell<std::mem::ManuallyDrop<Vec<RootedTraceableBox<Heap<*mut JSObject>>>>> = RefCell::new(std::mem::ManuallyDrop::new(Vec::new()));
}

/// Engine callback: a promise was rejected without a handler, or a handler
/// was attached to such a promise later.
unsafe extern "C" fn promise_rejection_tracker(
    _cx: *mut RawJSContext,
    _muted: bool,
    promise: jsapi::Handle<*mut JSObject>,
    state: jsapi::PromiseRejectionHandlingState,
    _data: *mut std::ffi::c_void,
) {
    let p = mozjs::rust::Handle::from_raw(promise).get();
    REJECTED.with(|r| {
        let mut list = r.borrow_mut();
        match state {
            jsapi::PromiseRejectionHandlingState::Unhandled => {
                let root: RootedTraceableBox<Heap<*mut JSObject>> = RootedTraceableBox::new(Heap::default());
                root.set(p);
                list.push(root);
            }
            jsapi::PromiseRejectionHandlingState::Handled => list.retain(|x| x.get() != p),
        }
    });
}

struct ThreadRuntime {
    cx: JSContext,
    /// The raw context, for APIs that another thread may call (interrupts).
    cx_ptr: usize,
    global: RootedTraceableBox<Heap<*mut JSObject>>,
    /// Global of the frame realm the engine is currently driving (see
    /// `push_realm`); the page global when `stack` is empty.
    current: RootedTraceableBox<Heap<*mut JSObject>>,
    stack: Vec<usize>,
}

macro_rules! current_global {
    ($rt:expr) => {
        if $rt.stack.is_empty() { $rt.global.handle() } else { $rt.current.handle() }
    };
}

/// Run `f` on a thread with a stack large enough for the JavaScript engine's
/// native stack quota (deeply nested DOMs and recursive page scripts).
pub fn run_on_big_stack<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new().stack_size(256 * 1024 * 1024).spawn(f).expect("spawn").join().expect("engine thread panicked")
}

/// Errors raised while evaluating JavaScript.
#[derive(Debug, Clone, thiserror::Error)]
pub enum JsError {
    #[error("{0}")]
    Exception(String),
    #[error("JavaScript engine unavailable: {0}")]
    Engine(String),
    /// A module script (or one of its dependencies) could not be fetched:
    /// the script element gets an `error` event instead of a window error.
    #[error("{0}")]
    ModuleFetch(String),
}

fn ensure_engine() {
    ENGINE.get_or_init(|| {
        let engine = JSEngine::init().expect("failed to initialise SpiderMonkey");
        // The engine must outlive every runtime; a CLI never shuts it down.
        std::mem::forget(engine);
    });
}

/// Shut SpiderMonkey down before the process exits, for embedders that exit through C `exit()`
/// (the Python module). The helper threads otherwise still wait on a condition variable of a
/// static mutex when C++ static destructors run; glibc reports that mutex busy and SpiderMonkey
/// aborts the process. Call only once no thread will run JavaScript again: the per-thread
/// runtimes are leaked (see `RUNTIME`), so this skips their teardown and only stops the engine.
pub fn shutdown_engine_at_exit() {
    if ENGINE.get().is_none() {
        return;
    }
    if let Ok(mut w) = WATCH.lock() {
        w.clear();
    }
    unsafe { jsapi::JS_ShutDown() };
}

#[cfg(unix)]
extern "C" {
    fn _exit(status: std::os::raw::c_int) -> !;
}

/// Exit the process from a thread that may still own a JavaScript runtime (the CLI and the
/// session server). `std::process::exit` runs C++ static destructors while that runtime and
/// SpiderMonkey's helper threads are alive, which segfaults on Linux; Rust destructors do not run
/// on exit either way, so flush the standard streams and leave without them.
pub fn exit_process(code: i32) -> ! {
    use std::io::Write;
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    #[cfg(unix)]
    unsafe {
        _exit(code)
    }
    #[cfg(not(unix))]
    std::process::exit(code)
}

/// Free this thread's JavaScript runtime and host (page realms, GC heap, layouts, HTTP client)
/// while the thread is still running. Engine threads that end (a Python `Browser` closing, a CDP
/// page target going away) call it last; otherwise every runtime is leaked (see `RUNTIME`) and a
/// long-lived process grows by the size of each closed browser. JavaScript may run on this
/// thread again afterwards: the next call creates a fresh runtime.
pub fn teardown_thread() {
    let cx = RUNTIME.with(|slot| slot.borrow().as_ref().map(|rt| rt.cx_ptr));
    // The host first: it owns layouts and caches, and its destructors may not need the runtime,
    // but must run before the thread-locals go.
    drop(take_host());
    let Some(cx) = cx else { return };
    if let Ok(mut w) = WATCH.lock() {
        w.retain(|(c, _)| *c != cx);
    }
    if let Ok(mut v) = PROFILE_CX.lock() {
        v.retain(|c| *c != cx);
    }
    if let Ok(mut a) = ABORTED.lock() {
        a.retain(|c| *c != cx);
    }
    DEADLINE.with(|d| *d.borrow_mut() = None);
    IMPORT_MAPS.with(|m| m.borrow_mut().clear());
    // Every rooted value must go before the context: dropping a Heap runs a GC post-barrier.
    clear_modules();
    FRAMES.with(|f| f.borrow_mut().clear());
    REJECTED.with(|r| r.borrow_mut().clear());
    let rt = RUNTIME.with(|slot| slot.borrow_mut().take());
    if let Some(rt) = rt {
        // SAFETY: the runtime was created with Box::leak in with_runtime and nothing else holds it.
        let rt = unsafe { Box::from_raw(rt as *mut ThreadRuntime) };
        let ThreadRuntime { cx: _cx, cx_ptr, global, current, stack: _ } = *rt;
        drop(global);
        drop(current);
        MAIN_GLOBAL.with(|m| m.set(0));
        THREAD_CX.with(|c| c.set(0));
        CURRENT_GLOBAL.with(|m| m.set(0));
        unsafe { jsapi::JS_DestroyContext(cx_ptr as *mut jsapi::JSContext) };
    }
}

unsafe fn create_context() -> (JSContext, usize) {
    const HEAP: u32 = 32 * 1024 * 1024 + (1 << 20);
    // Callers run the engine on threads with a large stack (see
    // `run_on_big_stack`); the quota must stay below the real stack size.
    const STACK_QUOTA: usize = 24 * 1024 * 1024;
    let raw = jsapi::JS_NewContext(HEAP, ptr::null_mut());
    let raw = NonNull::new(raw).expect("JS_NewContext returned null");
    jsapi::JS_SetGCParameter(raw.as_ptr(), JSGCParamKey::JSGC_MAX_BYTES, u32::MAX);
    jsapi::JS_AddExtraGCRootsTracer(raw.as_ptr(), Some(mozjs::gc::trace_traceables), ptr::null_mut());
    jsapi::JS_SetNativeStackQuota(raw.as_ptr(), STACK_QUOTA, STACK_QUOTA - 10 * 1024, STACK_QUOTA - 10 * 1024 - 8 * 12800);
    // Internal job queue gives us Promise/async support; it must be enabled
    // before self-hosted code is initialised.
    assert!(jsapi::UseInternalJobQueues(raw.as_ptr()), "UseInternalJobQueues failed");
    let cache = jsapi::__BindgenOpaqueArray::<u64, 2>::default();
    assert!(jsapi::InitSelfHostedCode(raw.as_ptr(), cache, None), "InitSelfHostedCode failed");
    // ES module loading (static imports, `import()`, `import.meta`).
    let rt = jsapi::JS_GetRuntime(raw.as_ptr());
    jsapi::SetModuleLoadHook(rt, Some(module_load_hook));
    jsapi::SetModuleMetadataHook(rt, Some(module_metadata_hook));
    jsapi::SetPromiseRejectionTrackerCallback(raw.as_ptr(), Some(promise_rejection_tracker), ptr::null_mut());
    jsapi::JS_AddInterruptCallback(raw.as_ptr(), Some(interrupt_callback));
    // Async stacks (on by default; Firefox keeps them to debuggees) make SpiderMonkey capture the
    // whole JS stack for every Promise allocation and promise job: seconds on pages with deep
    // framework stacks (United's map page under Akamai's script hooks).
    let ctx_opts = jsapi::JS::ContextOptionsRef(raw.as_ptr());
    if !ctx_opts.is_null() {
        (*ctx_opts).set_asyncStack_(false);
    }
    // Content Security Policy: string compilation (eval, Function, string timers, wasm) asks the env.
    jsapi::JS_SetSecurityCallbacks(raw.as_ptr(), &SECURITY_CALLBACKS);
    (JSContext::from_ptr(raw), raw.as_ptr() as usize)
}

// ---- wall-clock deadline for running scripts -------------------------------
//
// SpiderMonkey only interrupts a script when asked: a watchdog thread asks for
// the interrupt once the deadline of the engine thread has passed, and the
// callback then aborts the script with an uncatchable exception.
/// A script deadline: `budget` of script time from `start`, where time spent blocked on the
/// network does not count (outside WPT mode), but never later than the wall-clock `hard` cap.
#[derive(Clone, Copy)]
struct Deadline {
    start: std::time::Instant,
    net_base: std::time::Duration,
    budget: std::time::Duration,
    hard: std::time::Instant,
    /// browser work (layout) counter at the start: the hard cap moves by the work done since
    work_base: std::time::Duration,
}

impl Deadline {
    fn expired(&self) -> bool {
        let now = std::time::Instant::now();
        // Outside WPT mode the task running when the budget ends may finish within a grace
        // period: the loops stop between tasks once the budget is spent, and killing a task
        // half-way leaves frameworks wedged (React's execution context stays set, so it never
        // renders again).
        let real = EXCLUDE_NET.with(|e| e.get());
        let grace = if real { TASK_GRACE.min(self.budget) } else { std::time::Duration::ZERO };
        let work = if real { crate::http::thread_browser_work().saturating_sub(self.work_base) } else { std::time::Duration::ZERO };
        // A task that started late (each timer task, script and typed key marks its start) gets
        // its own grace period: the keys of one typing action are separate tasks in a browser,
        // and stopping one half-way wedged React (United's map search never rendered again).
        let task_young = real && TASK_START.with(|t| t.get()).is_some_and(|t| t > self.start && now.duration_since(t) < grace);
        now >= self.hard + grace + work || (script_elapsed(self.start, self.net_base) >= self.budget + grace && !task_young)
    }
}

thread_local! {
    /// When the running task (top-level eval, script, typed key) started, for the budget's grace.
    static TASK_START: std::cell::Cell<Option<std::time::Instant>> = const { std::cell::Cell::new(None) };
}

/// Mark the start of a task (see `Deadline::expired`).
pub fn mark_task_start() {
    TASK_START.with(|t| t.set(Some(std::time::Instant::now())));
}

/// How long a task that is still running when the script budget ends may continue (real pages).
const TASK_GRACE: std::time::Duration = std::time::Duration::from_secs(10);

/// How much longer than its budget a page may run in wall-clock time while it waits on the network.
pub const HARD_BUDGET_FACTOR: u32 = 3;

thread_local! {
    static DEADLINE: RefCell<Option<Deadline>> = const { RefCell::new(None) };
    /// Whether network wait is excluded from the script budget (off in WPT mode, where tests
    /// expect plain wall-clock behaviour).
    static EXCLUDE_NET: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Exclude (or count) time blocked on the network in this thread's script budget.
pub fn set_exclude_network_wait(on: bool) {
    EXCLUDE_NET.with(|e| e.set(on));
    REAL_PAGES.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// Whether the browser is loading real pages (not WPT tests): enables caches that tests would
/// notice (e.g. layout reusing stylesheet bytes).
static REAL_PAGES: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn real_pages() -> bool {
    REAL_PAGES.load(std::sync::atomic::Ordering::Relaxed)
}

/// Switch real-pages mode on or off for the process. `run_page` sets it per page, but only
/// documents with scripts go through `run_page`: browser engines set it when they are built so
/// script-less pages (and layouts made before the first scripted page) behave as real pages too.
pub fn set_real_pages(on: bool) {
    REAL_PAGES.store(on, std::sync::atomic::Ordering::Relaxed);
}

thread_local! {
    /// Time excused from the script budget so far (finished ad/analytics scripts).
    static EXCUSED: std::cell::Cell<std::time::Duration> = const { std::cell::Cell::new(std::time::Duration::ZERO) };
    /// The excused span in progress: (start, network wait at start, most it may excuse).
    static EXCUSING: std::cell::Cell<Option<(std::time::Instant, std::time::Duration, std::time::Duration)>> = const { std::cell::Cell::new(None) };
}

/// Start excusing the running code's time from the script budget (an ad script running on its
/// own budget), for at most `limit`. Network wait inside the span is not counted twice.
pub fn begin_excused(limit: std::time::Duration) {
    let now = std::time::Instant::now();
    EXCUSING.with(|e| e.set(Some((now, crate::http::thread_network_wait(), limit))));
    // An ad script that spends its whole allowance is stopped (like an ad blocker would) instead
    // of eating the page's budget: the watchdog asks for an interrupt from its limit on.
    start_watchdog();
    let cx = with_runtime(|rt| rt.cx_ptr);
    if let Ok(mut w) = WATCH.lock() {
        w.push((cx, now + limit));
    }
}

/// Whether the excused span in progress (an ad script) has used all of its allowance.
fn excused_spent() -> bool {
    match EXCUSING.with(|e| e.get()) {
        Some((_, _, limit)) => in_progress_excused() >= limit,
        None => false,
    }
}

/// End the excused span; returns how much of it was excused.
pub fn end_excused() -> std::time::Duration {
    let excused = in_progress_excused();
    if let Some((start, _, limit)) = EXCUSING.with(|e| e.get()) {
        let cx = with_runtime(|rt| rt.cx_ptr);
        if let Ok(mut w) = WATCH.lock() {
            if let Some(i) = w.iter().position(|(c, t)| *c == cx && *t == start + limit) {
                w.remove(i);
            }
        }
    }
    EXCUSING.with(|e| e.set(None));
    EXCUSED.with(|x| x.set(x.get() + excused));
    excused
}

fn in_progress_excused() -> std::time::Duration {
    match EXCUSING.with(|e| e.get()) {
        Some((start, net_start, limit)) => {
            let waited = crate::http::thread_network_wait().saturating_sub(net_start);
            start.elapsed().saturating_sub(waited).min(limit)
        }
        None => std::time::Duration::ZERO,
    }
}

/// Monotonic total of time that does not count against script budgets on this thread:
/// network wait plus excused (ad script) time. Budgets record it when they start.
pub fn budget_offset() -> std::time::Duration {
    crate::http::thread_network_wait() + EXCUSED.with(|x| x.get()) + in_progress_excused()
}

/// Script time since `start`: wall-clock time minus the network wait since `net_base`
/// (when network wait is excluded).
pub fn script_elapsed(start: std::time::Instant, net_base: std::time::Duration) -> std::time::Duration {
    let wall = start.elapsed();
    if !EXCLUDE_NET.with(|e| e.get()) {
        return wall;
    }
    let waited = budget_offset().saturating_sub(net_base);
    wall.saturating_sub(waited)
}

/// Whether a budget that started at `start` (network wait counter `net_base`) is spent.
pub fn budget_spent(start: std::time::Instant, net_base: std::time::Duration, budget_ms: u64, work_base: std::time::Duration) -> bool {
    // the hard wall-clock cap does not count the browser's own work (layouts) on real pages
    let work = if EXCLUDE_NET.with(|e| e.get()) { crate::http::thread_browser_work().saturating_sub(work_base) } else { std::time::Duration::ZERO };
    if start.elapsed().saturating_sub(work).as_millis() as u64 > budget_ms.saturating_mul(HARD_BUDGET_FACTOR as u64) {
        return true;
    }
    script_elapsed(start, net_base).as_millis() as u64 > budget_ms
}
static WATCH: std::sync::Mutex<Vec<(usize, std::time::Instant)>> = std::sync::Mutex::new(Vec::new());
static WATCHDOG: std::sync::OnceLock<()> = std::sync::OnceLock::new();
static INTERRUPTED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Sampling profiler (`JB_PROFILE=1`): the watchdog interrupts the engine thread every few
/// milliseconds and the callback counts the innermost script location; `profile_report` prints
/// the hottest ones (diagnostics only).
static PROFILE_CX: std::sync::Mutex<Vec<usize>> = std::sync::Mutex::new(Vec::new());

fn profiling() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("JB_PROFILE").is_some())
}

thread_local! {
    static PROFILE: RefCell<HashMap<String, u64>> = RefCell::new(HashMap::new());
    /// Inclusive samples per frame (`function@file:line`), counted once per sample.
    static PROFILE_INCL: RefCell<HashMap<String, u64>> = RefCell::new(HashMap::new());
    /// Samples per whole (12-frame) stack.
    static PROFILE_STACKS: RefCell<HashMap<String, u64>> = RefCell::new(HashMap::new());
}

/// Print and reset the profile samples of this thread (no-op unless `JB_PROFILE` is set).
pub fn profile_report(label: &str) {
    if !profiling() {
        return;
    }
    let mut rows: Vec<(String, u64)> = PROFILE.with(|p| p.borrow_mut().drain().collect());
    if rows.is_empty() {
        return;
    }
    rows.sort_by(|a, b| b.1.cmp(&a.1));
    let total: u64 = rows.iter().map(|r| r.1).sum();
    eprintln!("[profile] {label}: {total} samples (~{} ms)", total * 5);
    let mut by_file: HashMap<String, u64> = HashMap::new();
    for (loc, n) in &rows {
        let file = loc.rsplitn(3, ':').nth(2).unwrap_or(loc).to_string();
        *by_file.entry(file).or_default() += n;
    }
    let mut files: Vec<_> = by_file.into_iter().collect();
    files.sort_by(|a, b| b.1.cmp(&a.1));
    for (f, n) in files.iter().take(12) {
        eprintln!("[profile]   file {n:6} {f}");
    }
    for (loc, n) in rows.iter().take(25) {
        eprintln!("[profile]   {n:6} {loc}");
    }
    let mut incl: Vec<(String, u64)> = PROFILE_INCL.with(|p| p.borrow_mut().drain().collect());
    incl.sort_by(|a, b| b.1.cmp(&a.1));
    for (loc, n) in incl.iter().take(60) {
        eprintln!("[profile]   incl {n:6} {loc}");
    }
    let mut stacks: Vec<(String, u64)> = PROFILE_STACKS.with(|p| p.borrow_mut().drain().collect());
    stacks.sort_by(|a, b| b.1.cmp(&a.1));
    for (st, n) in stacks.iter().take(15) {
        eprintln!("[profile]   stack {n:6} {st}");
    }
}

unsafe extern "C" fn interrupt_callback(_cx: *mut jsapi::JSContext) -> bool {
    if profiling() {
        if let Some(raw) = NonNull::new(_cx) {
            let cx = JSContext::from_ptr(raw);
            let loc = match mozjs::rust::describe_scripted_caller(&cx) {
                Ok(c) => format!("{}:{}:{}", c.filename.rsplit('/').next().unwrap_or(&c.filename), c.line, c.col),
                Err(_) => "(native)".to_string(),
            };
            PROFILE.with(|p| *p.borrow_mut().entry(loc).or_default() += 1);
            let mut cx = JSContext::from_ptr(raw);
            mozjs::capture_stack!(&in(&mut cx) let stack = with max depth(24));
            if let Some(text) = stack.and_then(|mut s| s.as_string(None, jsapi::StackFormat::SpiderMonkey)) {
                let mut seen: Vec<String> = Vec::new();
                for frame in text.lines() {
                    let frame = frame.rsplitn(2, ':').nth(1).unwrap_or(frame); // drop the column
                    let frame = match frame.split_once('@') {
                        Some((f, file)) => format!("{}@{}", if f.is_empty() { "(anon)" } else { f }, file.rsplit('/').next().unwrap_or(file)),
                        None => frame.to_string(),
                    };
                    if !seen.contains(&frame) {
                        seen.push(frame);
                    }
                }
                let joined = seen.join(" < ");
                PROFILE_STACKS.with(|p| *p.borrow_mut().entry(joined).or_default() += 1);
                PROFILE_INCL.with(|p| {
                    let mut p = p.borrow_mut();
                    for f in seen {
                        *p.entry(f).or_default() += 1;
                    }
                });
            }
        }
    }
    if is_aborted(_cx as usize) {
        INTERRUPTED.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        return false;
    }
    let expired = DEADLINE.with(|d| d.borrow().map(|t| t.expired()).unwrap_or(false)) || excused_spent();
    if expired {
        if std::env::var_os("JB_TRACE_JS").is_some() {
            let what = DEADLINE.with(|d| {
                d.borrow().map(|t| format!("script {} ms of {} ms, wall {} ms (hard at {} ms)", script_elapsed(t.start, t.net_base).as_millis(), t.budget.as_millis(), t.start.elapsed().as_millis(), (t.hard - t.start).as_millis()))
            });
            eprintln!("[js] interrupt: {} ad_spent={}", what.unwrap_or_default(), excused_spent());
        }
        INTERRUPTED.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    !expired
}

fn start_watchdog() {
    WATCHDOG.get_or_init(|| {
        std::thread::Builder::new()
            .name("js-watchdog".into())
            .spawn(|| loop {
                std::thread::sleep(std::time::Duration::from_millis(if profiling() { 5 } else { 50 }));
                if profiling() {
                    for cx in PROFILE_CX.lock().map(|v| v.clone()).unwrap_or_default() {
                        unsafe { jsapi::JS_RequestInterruptCallback(cx as *mut jsapi::JSContext) };
                    }
                }
                let now = std::time::Instant::now();
                let due: Vec<usize> = WATCH.lock().map(|w| w.iter().filter(|(_, t)| now >= *t).map(|(cx, _)| *cx).collect()).unwrap_or_default();
                for cx in due {
                    // The context stays alive for the thread's lifetime (see with_runtime).
                    unsafe { jsapi::JS_RequestInterruptCallback(cx as *mut jsapi::JSContext) };
                }
            })
            .expect("watchdog thread");
    });
}

/// Give the scripts on this thread until `budget` from now; `None` clears the
/// deadline. Returns how many scripts were interrupted since the last call.
pub fn set_deadline(budget: Option<std::time::Duration>) -> usize {
    start_watchdog();
    let cx = with_runtime(|rt| rt.cx_ptr);
    let now = std::time::Instant::now();
    let deadline = budget.map(|b| Deadline { start: now, net_base: budget_offset(), budget: b, hard: now + b * HARD_BUDGET_FACTOR, work_base: crate::http::thread_browser_work() });
    DEADLINE.with(|d| *d.borrow_mut() = deadline);
    if let Ok(mut w) = WATCH.lock() {
        w.retain(|(c, _)| *c != cx);
        // The watchdog asks for an interrupt from the earliest possible expiry on (every tick
        // after it); the callback decides whether the script time is really spent.
        if let Some(t) = deadline {
            w.push((cx, t.start + t.budget));
        }
    }
    INTERRUPTED.swap(0, std::sync::atomic::Ordering::SeqCst)
}

/// Whether the current thread's script budget has run out.
pub fn deadline_passed() -> bool {
    DEADLINE.with(|d| d.borrow().map(|t| t.expired()).unwrap_or(false)) || excused_spent() || is_aborted(THREAD_CX.with(|c| c.get()))
}

thread_local! {
    /// This thread's context id (0 when it has none), readable while RUNTIME is borrowed.
    static THREAD_CX: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Contexts whose owner is closing: every script on them is stopped at once.
static ABORTED: std::sync::Mutex<Vec<usize>> = std::sync::Mutex::new(Vec::new());

fn is_aborted(cx: usize) -> bool {
    cx != 0 && ABORTED.lock().map(|a| !a.is_empty() && a.contains(&cx)).unwrap_or(false)
}

/// Id of this thread's JavaScript context (created if needed), for `abort_context`.
pub fn context_id() -> usize {
    with_runtime(|rt| rt.cx_ptr)
}

/// Stop whatever the context `cx` is running and every script it starts later (its owner is
/// closing). Call from another thread, only while the context is alive (the caller must keep the
/// owning thread from calling `teardown_thread` meanwhile).
pub fn abort_context(cx: usize) {
    if cx == 0 {
        return;
    }
    if let Ok(mut a) = ABORTED.lock() {
        if !a.contains(&cx) {
            a.push(cx);
        }
    }
    unsafe { jsapi::JS_RequestInterruptCallback(cx as *mut jsapi::JSContext) };
}

fn with_runtime<R>(f: impl FnOnce(&mut ThreadRuntime) -> R) -> R {
    ensure_engine();
    RUNTIME.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            let (mut cx, cx_ptr) = unsafe { create_context() };
            let global = new_global(&mut cx);
            let current: RootedTraceableBox<Heap<*mut JSObject>> = RootedTraceableBox::new(Heap::default());
            if profiling() {
                if let Ok(mut v) = PROFILE_CX.lock() {
                    v.push(cx_ptr);
                }
                start_watchdog();
            }
            THREAD_CX.with(|c| c.set(cx_ptr));
            *slot = Some(Box::leak(Box::new(ThreadRuntime { cx, cx_ptr, global, current, stack: Vec::new() })));
        }
        f(slot.as_mut().unwrap())
    })
}

fn new_global(cx: &mut JSContext) -> RootedTraceableBox<Heap<*mut JSObject>> {
    let options = RealmOptions::default();
    let root: RootedTraceableBox<Heap<*mut JSObject>> = RootedTraceableBox::new(Heap::default());
    unsafe {
        let g = JS_NewGlobalObject(cx, &SIMPLE_GLOBAL_CLASS, ptr::null_mut(), OnNewGlobalHookOption::FireOnNewGlobalHook, &*options);
        assert!(!g.is_null(), "JS_NewGlobalObject failed");
        root.set(g);
        MAIN_GLOBAL.with(|m| m.set(g as usize));
    }
    // Install the native bridge.
    {
        let mut realm = AutoRealm::new_from_handle(cx, root.handle());
        let (gh, cx) = realm.global_and_reborrow();
        unsafe {
            let f = JS_DefineFunction(cx, gh, c"__jb_native".as_ptr(), Some(native_dispatch), 2, 0);
            assert!(!f.is_null());
        }
    }
    root
}

/// Replace the global object (fresh realm): used by `reset_context`.
pub fn reset_global() {
    clear_modules();
    FRAMES.with(|f| f.borrow_mut().clear());
    with_runtime(|rt| {
        rt.stack.clear();
        let g = new_global(&mut rt.cx);
        rt.global = g;
    });
}

/// Create the global of a nested browsing context (its own realm and
/// compartment) with the browser environment loaded, and return its slot.
/// Called from `__jb_native("frameCreate")` while a page script runs. `None` when the
/// environment did not finish loading (e.g. the time budget interrupted it): a half-built
/// realm without `__jb` must not be handed to the page.
/// `worker`: the realm becomes a worker global (the environment then leaves out `window` and
/// `document`).
unsafe fn create_frame_realm(cx: &mut JSContext, worker: bool) -> Option<usize> {
    let options = RealmOptions::default();
    let root: RootedTraceableBox<Heap<*mut JSObject>> = RootedTraceableBox::new(Heap::default());
    let g = JS_NewGlobalObject(cx, &SIMPLE_GLOBAL_CLASS, ptr::null_mut(), OnNewGlobalHookOption::FireOnNewGlobalHook, &*options);
    assert!(!g.is_null(), "JS_NewGlobalObject failed");
    root.set(g);
    {
        let mut realm = AutoRealm::new_from_handle(cx, root.handle());
        let (gh, cx) = realm.global_and_reborrow();
        let f = JS_DefineFunction(cx, gh, c"__jb_native".as_ptr(), Some(native_dispatch), 2, 0);
        assert!(!f.is_null());
        if worker {
            rooted!(&in(cx) let mut wv = mozjs::jsval::BooleanValue(true));
            let _ = JS_SetProperty(cx, gh, c"__jb_workerRealm".as_ptr(), wv.handle());
            let _ = &mut wv;
        }
        rooted!(&in(cx) let mut rval = UndefinedValue());
        let opts = CompileOptionsWrapper::new(cx, CString::new("browser_env.js").unwrap(), 1);
        if evaluate_script(cx, gh, super::BROWSER_ENV, rval.handle_mut(), opts).is_err() {
            if JS_IsExceptionPending(cx) {
                JS_ClearPendingException(cx);
            }
            return None;
        }
    }
    let idx = FRAMES.with(|f| {
        let mut frames = f.borrow_mut();
        frames.push(Some(root));
        frames.len() - 1
    });
    // The realm knows its slot so the parent can release it later.
    let g = frame_global(idx);
    if !g.is_null() {
        let root: RootedTraceableBox<Heap<*mut JSObject>> = RootedTraceableBox::new(Heap::default());
        root.set(g);
        let mut realm = AutoRealm::new_from_handle(cx, root.handle());
        let (gh, cx) = realm.global_and_reborrow();
        rooted!(&in(cx) let mut iv = mozjs::jsval::Int32Value(idx as i32));
        let _ = JS_SetProperty(cx, gh, c"__jb_frameIndex".as_ptr(), iv.handle());
        let _ = &mut iv;
    }
    Some(idx)
}

/// The global object of frame realm `idx`, or null.
fn frame_global(idx: usize) -> *mut JSObject {
    FRAMES.with(|f| f.borrow().get(idx).and_then(|s| s.as_ref()).map(|r| r.get()).unwrap_or(ptr::null_mut()))
}

/// Make frame realm `idx` the one `eval`, `run_jobs` and the script
/// evaluators operate in until `pop_realm`.
pub fn push_realm(idx: usize) -> bool {
    let g = frame_global(idx);
    if g.is_null() {
        return false;
    }
    with_runtime(|rt| {
        rt.stack.push(idx);
        rt.current.set(g);
    });
    true
}

pub fn pop_realm() {
    with_runtime(|rt| {
        rt.stack.pop();
        let top = rt.stack.last().copied();
        let g = top.map(frame_global).unwrap_or(ptr::null_mut());
        rt.current.set(g);
    });
}

/// Number of frame realm slots created for the current page.
pub fn frame_count() -> usize {
    FRAMES.with(|f| f.borrow().len())
}

/// Forget cached module records (a new document gets a fresh module map).
pub fn clear_modules() {
    IMPORT_MAPS.with(|m| m.borrow_mut().clear());
    MODULES.with(|m| m.borrow_mut().clear());
    MODULE_ERRORS.with(|m| m.borrow_mut().clear());
}

/// Remember the pending exception as the cached failure for `key`.
unsafe fn cache_module_error(cx: &mut JSContext, key: String) {
    if !JS_IsExceptionPending(cx) {
        return;
    }
    rooted!(&in(cx) let mut exc = UndefinedValue());
    JS_GetPendingException(cx, exc.handle_mut());
    let root: RootedTraceableBox<Heap<Value>> = RootedTraceableBox::new(Heap::default());
    root.set(exc.get());
    MODULE_ERRORS.with(|m| m.borrow_mut().insert(key, root));
}

/// Re-throw the cached failure for `key`, if any.
unsafe fn rethrow_cached_module_error(cx: &mut JSContext, key: &str) -> bool {
    let cached = MODULE_ERRORS.with(|m| m.borrow().get(key).map(|r| r.get()));
    match cached {
        Some(v) => {
            rooted!(&in(cx) let exc = v);
            JS_SetPendingException(cx, exc.handle(), jsapi::ExceptionStackBehavior::Capture);
            true
        }
        None => false,
    }
}

static SECURITY_CALLBACKS: jsapi::JSSecurityCallbacks = jsapi::JSSecurityCallbacks { contentSecurityPolicyAllows: Some(csp_eval_check), codeForEvalGets: Some(code_for_eval), subsumes: None };

/// HostGetCodeForEval: `eval(trustedScript)` compiles the TrustedScript's text (Trusted Types).
unsafe extern "C" fn code_for_eval(cx: *mut RawJSContext, code: jsapi::Handle<*mut JSObject>, out: jsapi::MutableHandle<*mut jsapi::JSString>) -> bool {
    let mut cx = JSContext::from_ptr(NonNull::new(cx).unwrap());
    let g = CurrentGlobalOrNull(&cx);
    if g.is_null() || code.get().is_null() {
        return true;
    }
    rooted!(&in(&mut cx) let global = g);
    rooted!(&in(&mut cx) let ov = mozjs::jsval::ObjectValue(code.get()));
    if !JS_SetProperty(&mut cx, global.handle(), c"__jb_ttEvalObj".as_ptr(), ov.handle()) {
        JS_ClearPendingException(&mut cx);
        return true;
    }
    rooted!(&in(&mut cx) let mut rval = UndefinedValue());
    let opts = CompileOptionsWrapper::new(&mut cx, c"csp-hook".to_owned(), 1);
    if evaluate_script(&mut cx, global.handle(), "typeof __jb_ttCodeForEval === 'function' ? __jb_ttCodeForEval(__jb_ttEvalObj) : undefined", rval.handle_mut(), opts).is_err() {
        JS_ClearPendingException(&mut cx);
        return true;
    }
    if rval.get().is_string() {
        let mut out = mozjs::rust::MutableHandle::from_raw(out);
        out.set(rval.get().to_string());
    }
    true
}

/// Evaluate `script` in the current global of a context a hook already holds, after setting the
/// global property `name` to `arg`; `None` when there is no global or the script threw.
unsafe fn hook_eval_bool(cx: &mut JSContext, name: &std::ffi::CStr, arg: HandleValue, script: &str) -> Option<bool> {
    let g = CurrentGlobalOrNull(cx);
    if g.is_null() {
        return None;
    }
    rooted!(&in(cx) let global = g);
    if !JS_SetProperty(cx, global.handle(), name.as_ptr(), arg) {
        JS_ClearPendingException(cx);
        return None;
    }
    rooted!(&in(cx) let mut rval = UndefinedValue());
    let opts = CompileOptionsWrapper::new(cx, c"csp-hook".to_owned(), 1);
    if evaluate_script(cx, global.handle(), script, rval.handle_mut(), opts).is_err() {
        JS_ClearPendingException(cx);
        return None;
    }
    if rval.get().is_boolean() { Some(rval.get().to_boolean()) } else { None }
}

thread_local! {
    /// Set while the user's own code runs (the agent `eval` command, CDP evaluation): like a
    /// devtools console, it is not subject to the page's CSP `unsafe-eval` restriction. Per
    /// thread: every engine (CDP page target) has its own thread.
    static CSP_EVAL_BYPASS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub fn set_csp_eval_bypass(on: bool) {
    CSP_EVAL_BYPASS.with(|b| b.set(on));
}

/// JSCSPEvalChecker: CSP `unsafe-eval` / `wasm-unsafe-eval` checks (the env reports violations).
unsafe extern "C" fn csp_eval_check(
    cx: *mut RawJSContext,
    kind: jsapi::JS::RuntimeCode,
    code: jsapi::Handle<*mut jsapi::JSString>,
    compilation: jsapi::JS::CompilationType,
    params: jsapi::Handle<jsapi::JS::StackGCVector<*mut jsapi::JSString, jsapi::js::TempAllocPolicy>>,
    body: jsapi::Handle<*mut jsapi::JSString>,
    param_args: jsapi::Handle<jsapi::JS::StackGCVector<Value, jsapi::js::TempAllocPolicy>>,
    body_arg: jsapi::Handle<Value>,
    out: *mut bool,
) -> bool {
    *out = true;
    if CSP_EVAL_BYPASS.with(|b| b.get()) {
        return true;
    }
    let mut cx = JSContext::from_ptr(NonNull::new(cx).unwrap());
    if JS_IsExceptionPending(&cx) {
        return true;
    }
    // the body argument and body text go along (Trusted Types: was the source a TrustedScript?)
    if let Some(g) = NonNull::new(CurrentGlobalOrNull(&cx)) {
        rooted!(&in(&mut cx) let global = g.as_ptr());
        rooted!(&in(&mut cx) let bv = body_arg.get());
        let _ = JS_SetProperty(&mut cx, global.handle(), c"__jb_cspEvalBody".as_ptr(), bv.handle());
        rooted!(&in(&mut cx) let mut bs = UndefinedValue());
        if !body.get().is_null() {
            bs.set(mozjs::jsval::StringValue(&*body.get()));
        }
        let _ = JS_SetProperty(&mut cx, global.handle(), c"__jb_cspEvalBodyStr".as_ptr(), bs.handle());
    }
    rooted!(&in(&mut cx) let mut cv = UndefinedValue());
    if !code.get().is_null() {
        cv.set(mozjs::jsval::StringValue(&*code.get()));
    }
    // Function constructor parameters: each must be a TrustedScript with that text to count as trusted
    let mut params_trusted = true;
    if compilation == jsapi::JS::CompilationType::Function {
        let n = mozjs::glue::StackGCVectorValueLength(param_args);
        let ns = mozjs::glue::StackGCVectorStringLength(params);
        for i in 0..n {
            let vp = mozjs::glue::StackGCVectorValueAtIndex(param_args, i);
            if vp.is_null() {
                continue;
            }
            rooted!(&in(&mut cx) let pv = *vp);
            rooted!(&in(&mut cx) let mut ps = UndefinedValue());
            if i < ns {
                let sp = mozjs::glue::StackGCVectorStringAtIndex(params, i);
                if !sp.is_null() && !(*sp).is_null() {
                    ps.set(mozjs::jsval::StringValue(&**sp));
                }
            }
            if let Some(g) = NonNull::new(CurrentGlobalOrNull(&cx)) {
                rooted!(&in(&mut cx) let global = g.as_ptr());
                let _ = JS_SetProperty(&mut cx, global.handle(), c"__jb_cspEvalParamStr".as_ptr(), ps.handle());
            }
            if hook_eval_bool(&mut cx, c"__jb_cspEvalParam", pv.handle(), "typeof __jb === 'object' && __jb.tt ? __jb.tt.isTrustedText(__jb_cspEvalParam, __jb_cspEvalParamStr) : true") == Some(false) {
                params_trusted = false;
                break;
            }
        }
    }
    let ctype = match compilation {
        jsapi::JS::CompilationType::DirectEval => "eval",
        jsapi::JS::CompilationType::IndirectEval => "eval",
        jsapi::JS::CompilationType::Function => "Function",
        _ => "",
    };
    let script = if kind == jsapi::JS::RuntimeCode::WASM {
        "typeof __jb_cspEvalCheck === 'function' ? __jb_cspEvalCheck('wasm', __jb_cspEvalCode) : true".to_string()
    } else {
        format!("typeof __jb_cspEvalCheck === 'function' ? __jb_cspEvalCheck('js', __jb_cspEvalCode, '{ctype}', __jb_cspEvalBody, __jb_cspEvalBodyStr, {params_trusted}) : true")
    };
    let script = script.as_str();
    if let Some(allowed) = hook_eval_bool(&mut cx, c"__jb_cspEvalCode", cv.handle(), script) {
        *out = allowed;
    }
    true
}

/// Fetch (through the host) and compile the module at `url`, or return the
/// cached record. Null with a pending exception on failure.
unsafe fn load_module_from_url(cx: &mut JSContext, url: &str, kind: jsapi::ModuleType, referrer: &str) -> *mut JSObject {
    let key = module_key(CurrentGlobalOrNull(cx), url, kind);
    if let Some(p) = MODULES.with(|m| m.borrow().get(&key).map(|r| r.get())) {
        return p;
    }
    if rethrow_cached_module_error(cx, &key) {
        return ptr::null_mut();
    }
    // Content Security Policy (script-src-elem) for every module of the graph.
    if url.starts_with("http") || url.starts_with("data:") || url.starts_with("blob:") {
        rooted!(&in(cx) let mut uv = UndefinedValue());
        url.to_jsval(cx, uv.handle_mut());
        let nonce = IMPORT_NONCE.with(|n| n.borrow_mut().take());
        let check = match nonce {
            Some(n) => format!("typeof __jb_cspModuleCheck === 'function' ? __jb_cspModuleCheck(__jb_cspModuleUrl, {}) : true", serde_json::to_string(&n).unwrap_or_default()),
            None => "typeof __jb_cspModuleCheck === 'function' ? __jb_cspModuleCheck(__jb_cspModuleUrl) : true".to_string(),
        };
        if hook_eval_bool(cx, c"__jb_cspModuleUrl", uv.handle(), &check) == Some(false) {
            let msg = CString::new(format!("Failed to fetch module {}: blocked by Content Security Policy", url.replace('\0', ""))).unwrap();
            mozjs::error::throw_type_error(cx, &msg);
            cache_module_error(cx, key);
            return ptr::null_mut();
        }
    }
    let fetched = with_host(|h| { let r = if referrer.is_empty() { h.base_url.clone() } else { referrer.to_string() }; h.fetch_module(url, module_type_name(kind), &r) }).unwrap_or_else(|| Err("no host installed".into()));
    let code = match fetched {
        Ok(c) => c,
        Err(e) => {
            let msg = CString::new(e.replace('\0', "")).unwrap();
            mozjs::error::throw_type_error(cx, &msg);
            cache_module_error(cx, key);
            return ptr::null_mut();
        }
    };
    let m = compile_module(cx, &code, url, url, kind);
    if m.is_null() {
        cache_module_error(cx, key);
        return ptr::null_mut();
    }
    register_module(key, m);
    m
}

/// Base URL for resolving module specifiers from classic scripts.
pub fn set_base_url(url: &str) {
    BASE_URL.with(|b| *b.borrow_mut() = url.to_string());
}

/// An import map (HTML "import map"): sorted and normalized `imports` and `scopes`. A `None`
/// address is an entry that failed to parse; resolving through it throws.
#[derive(Default, Clone)]
pub struct ImportMap {
    pub imports: Vec<(String, Option<String>)>,
    pub scopes: Vec<(String, Vec<(String, Option<String>)>)>,
}

thread_local! {
    /// Import maps per realm (keyed by the global's address): each document has its own.
    static IMPORT_MAPS: RefCell<HashMap<usize, ImportMap>> = RefCell::new(HashMap::new());
    /// The realm of the script currently calling into the host / resolving imports.
    static CURRENT_GLOBAL: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// The page (top-level document) realm.
    static MAIN_GLOBAL: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// The nonce of the classic script whose import() is being loaded (CSP).
    static IMPORT_NONCE: RefCell<Option<String>> = const { RefCell::new(None) };
}

fn note_current_global(g: *mut JSObject) {
    CURRENT_GLOBAL.with(|c| c.set(g as usize));
}

fn current_realm_key() -> usize {
    let c = CURRENT_GLOBAL.with(|c| c.get());
    if c != 0 { c } else { MAIN_GLOBAL.with(|m| m.get()) }
}

/// The top-level document's import map (registered before its scripts run).
pub fn set_import_map(map: ImportMap) {
    let key = MAIN_GLOBAL.with(|m| m.get());
    IMPORT_MAPS.with(|m| {
        m.borrow_mut().insert(key, map);
    });
}

/// HTML "resolve a URL-like module specifier".
fn resolve_url_like(spec: &str, base: Option<&url::Url>) -> Option<url::Url> {
    if spec.starts_with('/') || spec.starts_with("./") || spec.starts_with("../") {
        return base?.join(spec).ok();
    }
    url::Url::parse(spec).ok()
}

fn is_special(u: &url::Url) -> bool {
    matches!(u.scheme(), "http" | "https" | "ws" | "wss" | "ftp" | "file")
}

/// HTML "sort and normalize a specifier map".
fn sort_and_normalize(obj: &serde_json::Map<String, serde_json::Value>, base: Option<&url::Url>) -> Vec<(String, Option<String>)> {
    let mut out: Vec<(String, Option<String>)> = Vec::new();
    for (key, value) in obj {
        // normalize a specifier key
        if key.is_empty() {
            continue;
        }
        let nkey = resolve_url_like(key, base).map(|u| u.to_string()).unwrap_or_else(|| key.clone());
        let address = match value.as_str() {
            Some(v) => resolve_url_like(v, base).map(|u| u.to_string()),
            None => None,
        };
        let address = match address {
            Some(a) if key.ends_with('/') && !a.ends_with('/') => None,
            other => other,
        };
        out.retain(|(k, _)| k != &nkey);
        out.push((nkey, address));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out
}

/// HTML "parse an import map string": Err("TypeError: ..." / "SyntaxError: ...").
pub fn parse_import_map_spec(json: &str, base: &str) -> Result<ImportMap, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("SyntaxError: import map is not valid JSON: {e}"))?;
    let top = v.as_object().ok_or_else(|| "TypeError: import map must be a JSON object".to_string())?;
    let base_url = url::Url::parse(base).ok();
    let mut map = ImportMap::default();
    if let Some(imports) = top.get("imports") {
        let obj = imports.as_object().ok_or_else(|| "TypeError: the import map's \"imports\" must be a JSON object".to_string())?;
        map.imports = sort_and_normalize(obj, base_url.as_ref());
    }
    if let Some(scopes) = top.get("scopes") {
        let obj = scopes.as_object().ok_or_else(|| "TypeError: the import map's \"scopes\" must be a JSON object".to_string())?;
        for (prefix, entries) in obj {
            let entries = entries.as_object().ok_or_else(|| format!("TypeError: the value of scope \"{prefix}\" must be a JSON object"))?;
            let Some(scope_url) = base_url.as_ref().and_then(|b| b.join(prefix).ok()).or_else(|| url::Url::parse(prefix).ok()) else { continue };
            let key = scope_url.to_string();
            map.scopes.retain(|(k, _)| k != &key);
            map.scopes.push((key, sort_and_normalize(entries, base_url.as_ref())));
        }
        map.scopes.sort_by(|a, b| b.0.cmp(&a.0));
    }
    if let Some(integrity) = top.get("integrity") {
        if !integrity.is_object() {
            return Err("TypeError: the import map's \"integrity\" must be a JSON object".to_string());
        }
    }
    Ok(map)
}

/// The first import map of a document (kept for callers that ignore errors).
pub fn parse_import_map(json: &str, base: &str) -> Option<ImportMap> {
    parse_import_map_spec(json, base).ok()
}

/// HTML "register an import map" for the calling realm: a later map is merged into the existing
/// one (entries already present win).
pub fn register_import_map(json: &str, base: &str) -> Result<(), String> {
    let new = parse_import_map_spec(json, base)?;
    let key = current_realm_key();
    IMPORT_MAPS.with(|m| {
        let mut maps = m.borrow_mut();
        let map = maps.entry(key).or_default();
        for (scope, entries) in new.scopes {
            match map.scopes.iter_mut().find(|(k, _)| *k == scope) {
                Some((_, old)) => {
                    for (k, v) in entries {
                        if !old.iter().any(|(ok, _)| *ok == k) {
                            old.push((k, v));
                        }
                    }
                    old.sort_by(|a, b| b.0.cmp(&a.0));
                }
                None => map.scopes.push((scope, entries)),
            }
        }
        map.scopes.sort_by(|a, b| b.0.cmp(&a.0));
        for (k, v) in new.imports {
            if !map.imports.iter().any(|(ok, _)| *ok == k) {
                map.imports.push((k, v));
            }
        }
        map.imports.sort_by(|a, b| b.0.cmp(&a.0));
    });
    Ok(())
}

/// HTML "resolve an imports match": Err(()) = blocked (throws), Ok(None) = no match.
fn resolve_imports_match(normalized: &str, as_url: Option<&url::Url>, entries: &[(String, Option<String>)]) -> Result<Option<String>, ()> {
    for (key, result) in entries {
        if key == normalized {
            return result.clone().map(Some).ok_or(());
        }
        if key.ends_with('/') && normalized.starts_with(key.as_str()) && as_url.map(is_special).unwrap_or(true) {
            let result = result.as_ref().ok_or(())?;
            let after = &normalized[key.len()..];
            let base = url::Url::parse(result).map_err(|_| ())?;
            let url = base.join(after).map_err(|_| ())?;
            let s = url.to_string();
            if !s.starts_with(result.as_str()) {
                return Err(());
            }
            return Ok(Some(s));
        }
    }
    Ok(None)
}

/// HTML "resolve a module specifier" with the calling realm's import map; None = TypeError.
pub fn resolve_module_specifier(spec: &str, base: &str) -> Option<String> {
    let base_url = url::Url::parse(base).ok();
    let as_url = resolve_url_like(spec, base_url.as_ref());
    let normalized = as_url.as_ref().map(|u| u.to_string()).unwrap_or_else(|| spec.to_string());
    let key = current_realm_key();
    let mapped = IMPORT_MAPS.with(|m| -> Result<Option<String>, ()> {
        let maps = m.borrow();
        let Some(map) = maps.get(&key) else { return Ok(None) };
        for (scope, entries) in &map.scopes {
            if base == scope || (scope.ends_with('/') && base.starts_with(scope.as_str())) {
                if let Some(r) = resolve_imports_match(&normalized, as_url.as_ref(), entries)? {
                    return Ok(Some(r));
                }
            }
        }
        resolve_imports_match(&normalized, as_url.as_ref(), &map.imports)
    });
    match mapped {
        Err(()) => None,
        Ok(Some(r)) => Some(r),
        Ok(None) => as_url.map(|u| u.to_string()),
    }
}

/// Compile `code` as a module record whose private value (used for import
/// resolution and `import.meta.url`) is `base_url`. Returns null with a
/// pending exception on syntax errors.
unsafe fn compile_module(cx: &mut JSContext, code: &str, filename: &str, base_url: &str, kind: jsapi::ModuleType) -> *mut JSObject {
    let fname = CString::new(filename.replace('\0', "")).unwrap_or_else(|_| CString::new("module.js").unwrap());
    let opts = CompileOptionsWrapper::new(cx, fname, 1);
    // Text and CSS modules default-export the text / a constructed style sheet: compiled as tiny
    // JavaScript modules producing that value.
    let wrapped;
    let code = match module_type_name(kind) {
        "text" => {
            wrapped = format!("export default {};", serde_json::to_string(code).unwrap_or_else(|_| "\"\"".into()));
            wrapped.as_str()
        }
        "css" => {
            wrapped = format!("const sheet = new CSSStyleSheet(); sheet.replaceSync({}); export default sheet;", serde_json::to_string(code).unwrap_or_else(|_| "\"\"".into()));
            wrapped.as_str()
        }
        _ => code,
    };
    let mut src = transform_str_to_source_text(code);
    let m = match kind {
        jsapi::ModuleType::JSON => CompileJsonModule1(cx, opts.ptr, &mut src),
        _ => CompileModule1(cx, opts.ptr, &mut src),
    };
    if m.is_null() {
        return m;
    }
    rooted!(&in(cx) let module = m);
    // Synthetic (JSON) modules have no script source object to hold a private.
    if kind != jsapi::ModuleType::JSON {
        rooted!(&in(cx) let mut pv = UndefinedValue());
        base_url.to_jsval(cx, pv.handle_mut());
        let v = pv.get();
        jsapi::SetModulePrivate(module.get(), &v);
    }
    module.get()
}

/// The import attribute `type` of a module request, as the HTML spec names it.
fn module_type_name(kind: jsapi::ModuleType) -> &'static str {
    match kind {
        jsapi::ModuleType::JSON => "json",
        jsapi::ModuleType::CSS => "css",
        jsapi::ModuleType::Text => "text",
        jsapi::ModuleType::Bytes => "bytes",
        _ => "javascript",
    }
}

/// Remember a module record under `key` so later imports reuse it.
fn register_module(key: String, module: *mut JSObject) {
    let root: RootedTraceableBox<Heap<*mut JSObject>> = RootedTraceableBox::new(Heap::default());
    root.set(module);
    MODULES.with(|m| m.borrow_mut().insert(key, root));
}

/// Module records belong to one realm: the map is keyed by the importing
/// realm's global as well as the URL (sharing a record between frame realms
/// aborts SpiderMonkey).
fn module_key(global: *mut JSObject, url: &str, kind: jsapi::ModuleType) -> String {
    format!("{}|{}#{}", realm_prefix(global), url, kind as u32)
}

fn realm_prefix(global: *mut JSObject) -> String {
    format!("{:x}", global as usize)
}

/// Drop the module records (and cached failures) of a discarded realm, so a
/// later global allocated at the same address starts with an empty map.
fn forget_realm_modules(global: *mut JSObject) {
    if global.is_null() {
        return;
    }
    IMPORT_MAPS.with(|m| {
        m.borrow_mut().remove(&(global as usize));
    });
    let prefix = format!("{}|", realm_prefix(global));
    MODULES.with(|m| m.borrow_mut().retain(|k, _| !k.starts_with(&prefix)));
    MODULE_ERRORS.with(|m| m.borrow_mut().retain(|k, _| !k.starts_with(&prefix)));
}

/// HostLoadImportedModule: resolve, fetch (synchronously through the host),
/// compile and hand the module record back to the engine.
unsafe extern "C" fn module_load_hook(
    cx: *mut RawJSContext,
    referrer: jsapi::Handle<*mut jsapi::JSScript>,
    request: jsapi::Handle<*mut JSObject>,
    _host_defined: jsapi::Handle<Value>,
    payload: jsapi::Handle<Value>,
    _line: u32,
    _column: jsapi::ColumnNumberOneOrigin,
) -> bool {
    let mut cx = JSContext::from_ptr(NonNull::new(cx).unwrap());
    let referrer = mozjs::rust::Handle::from_raw(referrer);
    let request = mozjs::rust::Handle::from_raw(request);
    let payload = mozjs::rust::Handle::from_raw(payload);
    let specifier = match NonNull::new(GetModuleRequestSpecifier(&cx, request)) {
        Some(nn) => {
            rooted!(&in(&mut cx) let s = nn.as_ptr());
            let _ = s;
            jsstr_to_string(&mut cx, nn)
        }
        None => String::new(),
    };
    // The referrer's base URL: the private value of its script source (set
    // for page scripts and modules), else the document base URL.
    let mut base = BASE_URL.with(|b| b.borrow().clone());
    let mut import_nonce: Option<String> = None;
    if !referrer.get().is_null() {
        rooted!(&in(&mut cx) let mut pv = UndefinedValue());
        JS_GetScriptPrivate(referrer.get(), pv.handle_mut());
        if pv.get().is_string() {
            base = value_to_string(&mut cx, pv.handle());
        }
    }
    // a classic script's private is "base\u{1}nonce" when its element had a nonce (import() inherits it)
    if let Some((b, n)) = base.clone().split_once('\u{1}') {
        base = b.to_string();
        import_nonce = Some(n.to_string());
    }
    IMPORT_NONCE.with(|n| *n.borrow_mut() = import_nonce);
    let kind = GetModuleRequestType(&cx, request);
    note_current_global(CurrentGlobalOrNull(&cx));
    let resolved = match resolve_module_specifier(&specifier, &base) {
        Some(u) => u,
        None => {
            let msg = CString::new(format!("Failed to resolve module specifier \"{}\"", specifier.replace('\0', ""))).unwrap();
            mozjs::error::throw_type_error(&mut cx, &msg);
            return FinishLoadingImportedModuleFailedWithPendingException(&mut cx, payload);
        }
    };
    let module_ptr = load_module_from_url(&mut cx, &resolved, kind, &base);
    if module_ptr.is_null() {
        return FinishLoadingImportedModuleFailedWithPendingException(&mut cx, payload);
    }
    rooted!(&in(&mut cx) let module = module_ptr);
    // Dynamic imports carry their promise as payload. The engine links and
    // evaluates the module as soon as it is handed back, so its dependency
    // graph must be loaded here first.
    let dynamic = payload.get().is_object() && {
        rooted!(&in(&mut cx) let p = payload.get().to_object());
        mozjs::rust::wrappers2::IsPromiseObject(p.handle())
    };
    if dynamic {
        rooted!(&in(&mut cx) let mut load_promise = ptr::null_mut::<JSObject>());
        if !LoadRequestedModules1(&mut cx, module.handle(), HandleValue::undefined(), load_promise.handle_mut()) {
            return FinishLoadingImportedModuleFailedWithPendingException(&mut cx, payload);
        }
        if !load_promise.get().is_null() && GetPromiseState(load_promise.handle()) == jsapi::PromiseState::Rejected {
            let _ = ThrowOnModuleEvaluationFailure(&mut cx, load_promise.handle(), jsapi::ModuleErrorBehaviour::ThrowModuleErrorsSync);
            return FinishLoadingImportedModuleFailedWithPendingException(&mut cx, payload);
        }
    }
    FinishLoadingImportedModule(&mut cx, referrer, request, payload, module.handle(), dynamic)
}

/// Errors raised by the load hook for network/MIME failures (as opposed to
/// syntax, linking or evaluation errors, which are reported to the window).
fn module_error(msg: String) -> JsError {
    if msg.contains("Failed to fetch module") || msg.contains("Failed to load module script") {
        JsError::ModuleFetch(msg)
    } else {
        JsError::Exception(msg)
    }
}

/// HostGetImportMetaProperties: `import.meta.url`.
unsafe extern "C" fn module_metadata_hook(cx: *mut RawJSContext, module: jsapi::Handle<*mut JSObject>, meta: jsapi::Handle<*mut JSObject>) -> bool {
    let mut cx = JSContext::from_ptr(NonNull::new(cx).unwrap());
    let module = mozjs::rust::Handle::from_raw(module);
    let meta = mozjs::rust::Handle::from_raw(meta);
    rooted!(&in(&mut cx) let mut pv = UndefinedValue());
    JS_GetModulePrivate(module.get(), pv.handle_mut());
    if !pv.get().is_string() {
        String::new().to_jsval(&mut cx, pv.handle_mut());
    }
    if !JS_DefineProperty(&mut cx, meta, c"url".as_ptr(), pv.handle(), jsapi::JSPROP_ENUMERATE as u32) {
        return false;
    }
    // `import.meta.resolve` comes from the env (`__jb.installImportMetaResolve`), handed the meta object.
    let g = CurrentGlobalOrNull(&cx);
    if g.is_null() {
        return true;
    }
    rooted!(&in(&mut cx) let global = g);
    rooted!(&in(&mut cx) let mut mv = mozjs::jsval::ObjectValue(meta.get()));
    if !JS_SetProperty(&mut cx, global.handle(), c"__jb_importMeta".as_ptr(), mv.handle()) {
        return false;
    }
    let _ = &mut mv;
    rooted!(&in(&mut cx) let mut rval = UndefinedValue());
    let opts = CompileOptionsWrapper::new(&mut cx, c"import-meta".to_owned(), 1);
    evaluate_script(&mut cx, global.handle(), "typeof __jb === 'object' && __jb.installImportMetaResolve ? __jb.installImportMetaResolve(__jb_importMeta) : undefined", rval.handle_mut(), opts).is_ok()
}

/// Evaluate a page's classic script as a global script whose source private
/// is `base_url` (used to resolve `import()` specifiers inside it).
pub fn eval_script_with_base(script: &str, filename: &str, base_url: &str) -> Result<(), JsError> {
    with_runtime(|rt| {
        let gh = current_global!(rt);
        let mut realm = AutoRealm::new_from_handle(&mut rt.cx, gh);
        let (_gh, cx) = realm.global_and_reborrow();
        mark_task_start();
        unsafe { eval_script_in(cx, script, filename, base_url) }
    })
}

/// `eval_script_with_base` for a context that is already in the realm.
unsafe fn eval_script_in(cx: &mut JSContext, script: &str, filename: &str, base_url: &str) -> Result<(), JsError> {
    let fname = CString::new(filename.replace('\0', "")).unwrap_or_else(|_| CString::new("script.js").unwrap());
    let opts = CompileOptionsWrapper::new(cx, fname, 1);
    let mut src = transform_str_to_source_text(script);
    let compiled = Compile1(cx, opts.ptr, &mut src);
    if compiled.is_null() {
        return Err(JsError::Exception(pending_exception_message(cx)));
    }
    rooted!(&in(cx) let js_script = compiled);
    rooted!(&in(cx) let mut pv = UndefinedValue());
    base_url.to_jsval(cx, pv.handle_mut());
    let v = pv.get();
    jsapi::SetScriptPrivate(js_script.get(), &v);
    rooted!(&in(cx) let mut rval = UndefinedValue());
    if !JS_ExecuteScript(cx, js_script.handle(), rval.handle_mut()) {
        return Err(JsError::Exception(pending_exception_message(cx)));
    }
    Ok(())
}

/// Compile, link and evaluate an ES module. For inline scripts `code` is the
/// source and `base_url` the document base URL; external module scripts pass
/// `code = None` and are fetched through the module map (so the same URL
/// always yields the same record, and cached errors).
pub fn eval_module(code: Option<&str>, filename: &str, base_url: &str) -> Result<(), JsError> {
    with_runtime(|rt| {
        let gh = current_global!(rt);
        let mut realm = AutoRealm::new_from_handle(&mut rt.cx, gh);
        let (_gh, cx) = realm.global_and_reborrow();
        mark_task_start();
        unsafe { eval_module_in(cx, code, filename, base_url) }
    })
}

/// `eval_module` for a context that is already in the realm.
unsafe fn eval_module_in(cx: &mut JSContext, code: Option<&str>, filename: &str, base_url: &str) -> Result<(), JsError> {
    {
        {
            let m = match code {
                Some(c) => compile_module(cx, c, filename, base_url, jsapi::ModuleType::JavaScript),
                None => load_module_from_url(cx, base_url, jsapi::ModuleType::JavaScript, ""),
            };
            if m.is_null() {
                return Err(module_error(pending_exception_message(cx)));
            }
            rooted!(&in(cx) let module = m);
            rooted!(&in(cx) let mut load_promise = ptr::null_mut::<JSObject>());
            if !LoadRequestedModules1(cx, module.handle(), HandleValue::undefined(), load_promise.handle_mut()) {
                return Err(JsError::Exception(pending_exception_message(cx)));
            }
            // Dependencies are fetched synchronously by the load hook, so one
            // pass over the job queue settles the graph-loading promise.
            RunJobs(cx);
            if !load_promise.get().is_null() {
                match GetPromiseState(load_promise.handle()) {
                    jsapi::PromiseState::Fulfilled => {}
                    jsapi::PromiseState::Rejected => {
                        let _ = ThrowOnModuleEvaluationFailure(cx, load_promise.handle(), jsapi::ModuleErrorBehaviour::ThrowModuleErrorsSync);
                        return Err(module_error(pending_exception_message(cx)));
                    }
                    jsapi::PromiseState::Pending => return Err(JsError::Exception("module dependencies did not finish loading".into())),
                }
            }
            if !ModuleLink(cx, module.handle()) {
                return Err(JsError::Exception(pending_exception_message(cx)));
            }
            rooted!(&in(cx) let mut rval = UndefinedValue());
            if !ModuleEvaluate(cx, module.handle(), rval.handle_mut()) {
                return Err(JsError::Exception(pending_exception_message(cx)));
            }
            RunJobs(cx);
            if rval.get().is_object() {
                rooted!(&in(cx) let p = rval.get().to_object());
                if GetPromiseState(p.handle()) == jsapi::PromiseState::Rejected {
                    let _ = ThrowOnModuleEvaluationFailure(cx, p.handle(), jsapi::ModuleErrorBehaviour::ThrowModuleErrorsSync);
                    return Err(JsError::Exception(pending_exception_message(cx)));
                }
            }
            if JS_IsExceptionPending(cx) {
                return Err(JsError::Exception(pending_exception_message(cx)));
            }
            Ok(())
        }
    }
}

/// Install the host used by `__jb_native` calls made during `eval`.
pub fn set_host(host: Box<dyn NativeHost>) {
    HOST.with(|h| **h.borrow_mut() = Some(host));
}

/// Remove and return the installed host.
pub fn take_host() -> Option<Box<dyn NativeHost>> {
    HOST.with(|h| (**h.borrow_mut()).take())
}

/// Run `f` against the installed host, downcast to its concrete type.
/// Returns `None` if no host is installed. Must not be called while a
/// `__jb_native` call is in progress (the host is borrowed then).
pub fn with_host<R>(f: impl FnOnce(&mut super::host::Host) -> R) -> Option<R> {
    HOST.with(|h| {
        let mut guard = h.try_borrow_mut().ok()?;
        let host = (**guard).as_mut()?;
        // SAFETY: the only host type installed by this crate is `Host`.
        let concrete = unsafe { &mut *(host.as_mut() as *mut dyn NativeHost as *mut super::host::Host) };
        Some(f(concrete))
    })
}

unsafe fn value_to_string(cx: &mut JSContext, v: mozjs::rust::HandleValue) -> String {
    let js = mozjs::rust::ToString(cx, v);
    match NonNull::new(js) {
        Some(nn) => {
            rooted!(&in(cx) let s = nn.as_ptr());
            let _ = s;
            jsstr_to_string(cx, nn)
        }
        None => String::new(),
    }
}

unsafe extern "C" fn native_dispatch(cx: *mut RawJSContext, argc: u32, vp: *mut Value) -> bool {
    let mut cx = JSContext::from_ptr(NonNull::new(cx).unwrap());
    note_current_global(CurrentGlobalOrNull(&cx));
    let args = CallArgs::from_vp(vp, argc);
    let mut op = String::new();
    let mut payload = String::new();
    if args.argc_ >= 1 {
        op = value_to_string(&mut cx, mozjs::rust::Handle::from_raw(args.get(0)));
    }
    if args.argc_ >= 2 {
        payload = value_to_string(&mut cx, mozjs::rust::Handle::from_raw(args.get(1)));
    }
    // Synchronous execution of a script element inserted by a script: runs
    // nested inside the calling script, as in a browser.
    if op == "evalScript" {
        let v: serde_json::Value = serde_json::from_str(&payload).unwrap_or_default();
        let code = v.get("code").and_then(|c| c.as_str()).unwrap_or("").to_string();
        let filename = v.get("filename").and_then(|c| c.as_str()).unwrap_or("inline-script.js").to_string();
        let base = v.get("base").and_then(|c| c.as_str()).unwrap_or("").to_string();
        let result = match eval_script_in(&mut cx, &code, &filename, &base) {
            Ok(()) => "{\"ok\":true}".to_string(),
            Err(e) => serde_json::json!({ "error": e.to_string() }).to_string(),
        };
        rooted!(&in(&mut cx) let mut rv = UndefinedValue());
        result.to_jsval(&mut cx, rv.handle_mut());
        args.rval().set(rv.get());
        return true;
    }
    // Microtask checkpoint after a script of a child document (frame documents run their
    // scripts from a task of this realm, one after another, inside a single JS call).
    if op == "runJobs" {
        RunJobs(&mut cx);
        args.rval().set(UndefinedValue());
        return true;
    }
    if op == "evalModule" {
        let v: serde_json::Value = serde_json::from_str(&payload).unwrap_or_default();
        let code = v.get("code").and_then(|c| c.as_str()).map(|c| c.to_string());
        let filename = v.get("filename").and_then(|c| c.as_str()).unwrap_or("inline-module.js").to_string();
        let base = v.get("base").and_then(|c| c.as_str()).unwrap_or("").to_string();
        let result = match eval_module_in(&mut cx, code.as_deref(), &filename, &base) {
            Ok(()) => "{\"ok\":true}".to_string(),
            Err(e) => serde_json::json!({ "error": e.to_string(), "fetch": matches!(e, JsError::ModuleFetch(_)) }).to_string(),
        };
        rooted!(&in(&mut cx) let mut rv = UndefinedValue());
        result.to_jsval(&mut cx, rv.handle_mut());
        args.rval().set(rv.get());
        return true;
    }
    // Nested browsing contexts: create a frame realm, or hand a global object
    // (wrapped into the caller's compartment) back to the page.
    if op == "frameCreate" || op == "frameGlobal" || op == "callerGlobal" || op == "frameDrop" {
        let v: serde_json::Value = serde_json::from_str(&payload).unwrap_or_default();
        let obj: *mut JSObject = match op.as_str() {
            "frameCreate" => {
                let limit = v.get("limit").and_then(|l| l.as_u64()).unwrap_or(32) as usize;
                if FRAMES.with(|f| f.borrow().iter().filter(|s| s.is_some()).count()) >= limit {
                    ptr::null_mut()
                } else {
                    let worker = v.get("worker").and_then(|w| w.as_bool()).unwrap_or(false);
                    // loading the env into the new realm is the browser's work, not the page's
                    let _excluded = crate::http::ExcludedWork::browser();
                    match create_frame_realm(&mut cx, worker) {
                        Some(idx) => frame_global(idx),
                        None => ptr::null_mut(),
                    }
                }
            }
            "frameGlobal" => frame_global(v.get("index").and_then(|i| i.as_u64()).unwrap_or(u64::MAX) as usize),
            "callerGlobal" => jsapi::GetScriptedCallerGlobal(cx.raw_cx()),
            _ => {
                if let Some(idx) = v.get("index").and_then(|i| i.as_u64()) {
                    forget_realm_modules(frame_global(idx as usize));
                    FRAMES.with(|f| { if let Some(slot) = f.borrow_mut().get_mut(idx as usize) { *slot = None; } });
                }
                ptr::null_mut()
            }
        };
        if obj.is_null() {
            args.rval().set(mozjs::jsval::NullValue());
            return true;
        }
        rooted!(&in(&mut cx) let mut wrapped = obj);
        if !JS_WrapObject(&mut cx, wrapped.handle_mut()) {
            if JS_IsExceptionPending(&mut cx) {
                JS_ClearPendingException(&mut cx);
            }
            args.rval().set(mozjs::jsval::NullValue());
            return true;
        }
        args.rval().set(mozjs::jsval::ObjectValue(wrapped.get()));
        return true;
    }
    // A panic cannot unwind through this extern "C" frame (the process would abort): a bug in a
    // host op (say, the layout engine on an odd page) fails that call instead.
    let op_start = std::time::Instant::now();
    let result = HOST.with(|h| match (**h.borrow_mut()).as_mut() {
        Some(host) => std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| host.call(&op, &payload)))
            .unwrap_or_else(|_| serde_json::json!({ "error": format!("internal error in host op {op}") }).to_string()),
        None => "{\"error\":\"no host installed\"}".to_string(),
    });
    if op_start.elapsed().as_millis() >= 200 && std::env::var_os("JB_TRACE_JS").is_some() {
        eprintln!("[js] slow host op {op} {} ms: {}", op_start.elapsed().as_millis(), payload.chars().take(160).collect::<String>());
    }
    rooted!(&in(cx) let mut rv = UndefinedValue());
    result.to_jsval(&mut cx, rv.handle_mut());
    args.rval().set(rv.get());
    true
}

/// Message of a script stopped by the time budget (an uncatchable termination, not an exception).
pub const TERMINATED: &str = "script terminated: the time budget ran out";

/// Whether an error message is a time-budget termination (counted separately, never reported).
pub fn is_termination(msg: &str) -> bool {
    msg.contains(TERMINATED)
}

unsafe fn pending_exception_message(cx: &mut JSContext) -> String {
    if !JS_IsExceptionPending(cx) {
        if deadline_passed() {
            return TERMINATED.to_string();
        }
        return "Unknown JavaScript error".to_string();
    }
    rooted!(&in(cx) let mut exc = UndefinedValue());
    JS_GetPendingException(cx, exc.handle_mut());
    JS_ClearPendingException(cx);
    // Keep the exception object itself for `__jb.reportError` so window
    // `error` events carry the real value (e.g. a SyntaxError instance).
    let g = CurrentGlobalOrNull(cx);
    if !g.is_null() {
        rooted!(&in(cx) let global = g);
        let _ = JS_SetProperty(cx, global.handle(), c"__jb_lastError".as_ptr(), exc.handle());
        rooted!(&in(cx) let mut flag = mozjs::jsval::BooleanValue(true));
        let _ = JS_SetProperty(cx, global.handle(), c"__jb_hasLastError".as_ptr(), flag.handle());
        let _ = &mut flag;
        if JS_IsExceptionPending(cx) {
            JS_ClearPendingException(cx);
        }
    }
    let mut msg = value_to_string(cx, exc.handle());
    if msg.is_empty() {
        msg = "JavaScript error".into();
    }
    msg
}

/// Evaluate `script` in the thread's global and return the completion value
/// converted to a string (objects go through `String(value)`).
pub fn eval(script: &str, filename: &str) -> Result<String, JsError> {
    with_runtime(|rt| {
        let gh = current_global!(rt);
        let mut realm = AutoRealm::new_from_handle(&mut rt.cx, gh);
        let (gh, cx) = realm.global_and_reborrow();
        rooted!(&in(cx) let mut rval = UndefinedValue());
        let fname = CString::new(filename.replace('\0', "")).unwrap_or_else(|_| CString::new("script.js").unwrap());
        let opts = CompileOptionsWrapper::new(cx, fname, 1);
        mark_task_start();
        let ok = evaluate_script(cx, gh, script, rval.handle_mut(), opts);
        if ok.is_err() {
            return Err(JsError::Exception(unsafe { pending_exception_message(cx) }));
        }
        let v = rval.get();
        if v.is_undefined() {
            return Ok(String::new());
        }
        if v.is_null() {
            return Ok("null".into());
        }
        let s = unsafe { value_to_string(cx, rval.handle()) };
        if unsafe { JS_IsExceptionPending(cx) } {
            unsafe { JS_ClearPendingException(cx) };
        }
        Ok(s)
    })
}

/// Drain the promise job queue (microtasks), then report promises that are
/// still rejected without a handler (`unhandledrejection`).
pub fn run_jobs() {
    with_runtime(|rt| {
        let gh = current_global!(rt);
        let mut realm = AutoRealm::new_from_handle(&mut rt.cx, gh);
        let (gh, cx) = realm.global_and_reborrow();
        unsafe {
            RunJobs(cx);
            if JS_IsExceptionPending(cx) {
                JS_ClearPendingException(cx);
            }
            for _ in 0..8 {
                let pending: Vec<RootedTraceableBox<Heap<*mut JSObject>>> = REJECTED.with(|r| std::mem::take(&mut **r.borrow_mut()));
                if pending.is_empty() {
                    break;
                }
                for p in &pending {
                    rooted!(&in(cx) let mut v = UndefinedValue());
                    v.set(mozjs::jsval::ObjectValue(p.get()));
                    let _ = JS_SetProperty(cx, gh, c"__jb_rej".as_ptr(), v.handle());
                    rooted!(&in(cx) let mut rval = UndefinedValue());
                    let opts = CompileOptionsWrapper::new(cx, CString::new("rejection.js").unwrap(), 1);
                    let _ = evaluate_script(cx, gh, "__jb.queueRejection(__jb_rej)", rval.handle_mut(), opts);
                    if JS_IsExceptionPending(cx) {
                        JS_ClearPendingException(cx);
                    }
                }
                RunJobs(cx);
                if JS_IsExceptionPending(cx) {
                    JS_ClearPendingException(cx);
                }
            }
        }
    });
}

/// Request a garbage collection (used between pages to keep memory bounded).
pub fn gc() {
    with_runtime(|rt| unsafe {
        jsapi::JS_GC(rt.cx.raw_cx(), jsapi::GCReason::API);
    });
}
