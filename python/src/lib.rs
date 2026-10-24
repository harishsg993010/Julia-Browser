//! `julia_browser._native`: the Rust browser engine as a Python extension module.
//!
//! SpiderMonkey runtimes are bound to the thread that created them and need a large native
//! stack, so every [`Engine`] owns a dedicated worker thread (256 MiB stack) that builds and
//! drives its browser. Python calls send a job to that thread and wait for the reply with the
//! GIL released, so other Python threads keep running and an `Engine` can be used from any
//! Python thread. Arguments and results cross the boundary as JSON text; the pure-Python layer
//! (`julia_browser/__init__.py`) turns them into keyword arguments and dicts.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use julia_browser::js::JsConfig;
use julia_browser::session::Session;
use julia_browser::{AgentSdk, BrowserSdk};
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyBytes;
use serde_json::{json, Value};

/// Native stack of an engine thread (the engine reserves a 24 MiB quota inside it).
const ENGINE_STACK: usize = 256 * 1024 * 1024;

/// The browser an engine thread drives.
enum Target {
    /// Selector-based session (`open`, `click`, `type`, `eval`, ...), as the CLI session commands.
    Session(Box<Session>),
    /// Numbered-element agent API (`open_website`, `list_elements`, `click_element`, ...).
    Agent(Box<AgentSdk>),
    /// One-shot page fetching and rendering (`render_to_markdown`, `fetch_page`, ...).
    Sdk(Box<BrowserSdk>),
}

enum Reply {
    Json(Value),
    Bytes(Vec<u8>),
    Err(String),
}

type Job = Box<dyn FnOnce(&mut Target) -> Reply + Send>;

/// The engine thread of a browser and the channel to it.
struct Inner {
    tx: Mutex<Option<mpsc::Sender<(Job, mpsc::Sender<Reply>)>>>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// The engine thread's JavaScript context while it is alive (0 before start and after
    /// teardown); held locked while aborting so the context cannot be destroyed meanwhile.
    cx: Arc<Mutex<usize>>,
}

impl Inner {
    /// Let the thread finish: the job in progress has its scripts stopped (a page task could
    /// otherwise keep `close()` and interpreter exit waiting for minutes).
    fn close(&self) {
        if let Ok(mut tx) = self.tx.lock() {
            tx.take();
        }
        if let Ok(cx) = self.cx.lock() {
            if !SHUT_DOWN.load(Ordering::SeqCst) || !self.thread.lock().map(|t| t.is_none()).unwrap_or(false) {
                julia_browser::js::runtime::abort_context(*cx);
            }
        }
    }

    /// Wait for the thread to end, at most `limit`; true once it has ended.
    fn join(&self, limit: Option<Duration>) -> bool {
        let Ok(mut slot) = self.thread.lock() else { return false };
        let Some(handle) = slot.take() else { return true };
        if let Some(limit) = limit {
            let until = Instant::now() + limit;
            while !handle.is_finished() {
                if Instant::now() >= until {
                    *slot = Some(handle);
                    return false;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        let _ = handle.join();
        true
    }
}

impl Drop for Inner {
    // A browser Python dropped without `close()`: its thread ends on its own; keep the handle so
    // the shutdown at exit can wait for it.
    fn drop(&mut self) {
        self.close();
        if let Some(h) = self.thread.get_mut().ok().and_then(Option::take) {
            if let Ok(mut o) = ORPHANS.lock() {
                o.retain(|h| !h.is_finished());
                o.push(h);
            }
        }
    }
}

/// Every engine started in this process, for the shutdown at exit.
static ENGINES: Mutex<Vec<Weak<Inner>>> = Mutex::new(Vec::new());
/// Threads of engines dropped while still running.
static ORPHANS: Mutex<Vec<std::thread::JoinHandle<()>>> = Mutex::new(Vec::new());
/// Set by `shutdown`: SpiderMonkey is gone and no engine may start again.
static SHUT_DOWN: AtomicBool = AtomicBool::new(false);

/// A browser running on its own thread.
#[pyclass(frozen, module = "julia_browser._native")]
struct Engine {
    inner: Arc<Inner>,
    kind: String,
}

fn opt_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn opt_u64(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(Value::as_u64)
}

fn opt_bool(v: &Value, key: &str) -> Option<bool> {
    v.get(key).and_then(Value::as_bool)
}

/// Engine options shared by every kind (see `julia_browser.Browser` for their meaning).
fn js_config(opts: &Value) -> JsConfig {
    let d = JsConfig::default();
    let geolocation = match (opts.get("geolocation").and_then(|g| g.get(0)).and_then(Value::as_f64), opts.get("geolocation").and_then(|g| g.get(1)).and_then(Value::as_f64)) {
        (Some(latitude), Some(longitude)) => Some(julia_browser::js::Geolocation { latitude, longitude, accuracy: 25.0 }),
        _ => None,
    };
    let javascript = opt_bool(opts, "javascript").unwrap_or(true);
    JsConfig {
        time_budget_ms: opt_u64(opts, "js_budget_ms").unwrap_or(8000),
        ad_budget_ms: opt_u64(opts, "ad_budget_ms").unwrap_or(d.ad_budget_ms),
        fetch_external_scripts: opt_bool(opts, "external_scripts").unwrap_or(true),
        echo_console: opt_bool(opts, "echo_console").unwrap_or(false),
        allow_websockets: opt_bool(opts, "websockets").unwrap_or(true),
        allow_clipboard: opt_bool(opts, "clipboard").unwrap_or(false),
        service_workers: opt_bool(opts, "service_workers").unwrap_or(true),
        notification_permission: opt_str(opts, "notifications").unwrap_or("default").to_string(),
        request_timeout_secs: opt_u64(opts, "request_timeout").unwrap_or(d.request_timeout_secs),
        max_timer_steps: if javascript { d.max_timer_steps } else { 0 },
        action_settle_ms: opt_u64(opts, "settle_ms"),
        profile_dir: opt_str(opts, "profile_dir").map(std::path::PathBuf::from).or(d.profile_dir.clone()),
        geolocation,
        ..d
    }
}

fn build(kind: &str, opts: &Value) -> Result<Target, String> {
    let ua = opt_str(opts, "user_agent");
    let timeout = opt_u64(opts, "timeout").unwrap_or(30);
    let javascript = opt_bool(opts, "javascript").unwrap_or(true);
    let js = js_config(opts);
    Ok(match kind {
        "session" => Target::Session(Box::new(Session::with_user_agent(js, javascript, ua))),
        "agent" => {
            let mut a = AgentSdk::with_js_config(ua, timeout, js);
            a.engine.execute_js = javascript;
            Target::Agent(Box::new(a))
        }
        "sdk" => {
            let mut s = BrowserSdk::with_js_config(ua, timeout, js);
            s.engine.execute_js = javascript;
            Target::Sdk(Box::new(s))
        }
        other => return Err(format!("unknown engine kind {other:?}")),
    })
}

fn need_str<'a>(a: &'a Value, key: &str) -> Result<&'a str, String> {
    opt_str(a, key).ok_or_else(|| format!("missing argument {key:?}"))
}

fn need_usize(a: &Value, key: &str) -> Result<usize, String> {
    opt_u64(a, key).map(|n| n as usize).ok_or_else(|| format!("missing argument {key:?}"))
}

fn sdk_json(r: julia_browser::sdk::SdkResult) -> Value {
    r.to_json()
}

fn call_session(s: &mut Session, method: &str, a: &Value) -> Result<Reply, String> {
    Ok(match method {
        "exec" => Reply::Json(s.exec(need_str(a, "cmd")?, a.get("args").unwrap_or(&json!({})))),
        "screenshot_bytes" => match s.screenshot_bytes(opt_bool(a, "full").unwrap_or(false)) {
            Ok(png) => Reply::Bytes(png),
            Err(e) => Reply::Err(e),
        },
        "page" => {
            let agent = s.agent();
            Reply::Json(json!({"url": agent.current_url, "title": agent.current_title()}))
        }
        "cookies" => Reply::Json(s.agent().get_cookies()),
        "set_cookie" => Reply::Json(s.agent().set_cookie(need_str(a, "url")?, need_str(a, "cookie")?)),
        other => return Err(format!("unknown session method {other:?}")),
    })
}

fn call_agent(g: &mut AgentSdk, method: &str, a: &Value) -> Result<Reply, String> {
    let n = |k: &str| need_usize(a, k);
    let chunks = opt_u64(a, "chunks").unwrap_or(1) as usize;
    let v = match method {
        "open_website" | "navigate" => g.open_website(need_str(a, "url")?),
        "list_elements" | "get_elements" => g.list_elements(),
        "click_element" | "click_button" => g.click_element(n("element_number")?),
        "type_text" | "fill_input" => g.type_text(n("field_number")?, need_str(a, "text")?),
        "submit_form" | "submit_current_form" => g.submit_form(),
        "follow_link" => match a.get("link") {
            Some(Value::String(url)) => g.follow_link_url(url),
            Some(v) if v.is_u64() => g.follow_link(v.as_u64().unwrap_or(0) as usize),
            _ => return Err("follow_link needs a link number or URL".into()),
        },
        "search_page" => g.search_page(need_str(a, "term")?),
        "get_page_info" => g.get_page_info(),
        "readable_text" => g.readable_text(),
        "execute_javascript" => g.execute_javascript(need_str(a, "script")?),
        "act" => g.act(need_str(a, "action")?, opt_str(a, "target").unwrap_or(""), opt_str(a, "value")),
        "wait_for" => g.wait_for(need_str(a, "selector")?, opt_u64(a, "rounds").unwrap_or(4) as usize),
        "view_layout" => g.view_layout(opt_u64(a, "cols").unwrap_or(120) as usize),
        "screenshot_bytes" => {
            return Ok(match g.screenshot_png(opt_bool(a, "full").unwrap_or(true), None) {
                Ok(png) => Reply::Bytes(png),
                Err(e) => Reply::Err(e),
            })
        }
        "get_cookies" => g.get_cookies(),
        "set_cookie" => g.set_cookie(need_str(a, "url")?, need_str(a, "cookie")?),
        "scroll_down" => g.scroll_down(chunks),
        "scroll_up" => g.scroll_up(chunks),
        "scroll_to_top" => g.scroll_to_top(),
        "scroll_to_bottom" => g.scroll_to_bottom(),
        "get_scroll_info" => g.get_scroll_info(),
        "current_title" => json!(g.current_title()),
        "current_url" => json!(g.current_url),
        other => return Err(format!("unknown agent method {other:?}")),
    };
    Ok(Reply::Json(v))
}

fn call_sdk(s: &mut BrowserSdk, method: &str, a: &Value) -> Result<Reply, String> {
    let timeout = opt_u64(a, "timeout");
    let js = opt_bool(a, "execute_js").unwrap_or(true);
    let v = match method {
        "fetch_page" => sdk_json(s.fetch_page(need_str(a, "url")?, timeout)),
        "render_to_markdown" => sdk_json(s.render_to_markdown(need_str(a, "url")?, js, timeout)),
        "render_to_text" => sdk_json(s.render_to_text(need_str(a, "url")?, js, timeout)),
        "render_to_layout" => {
            let opts = julia_browser::layout::TextOptions { cols: opt_u64(a, "cols").unwrap_or(160) as usize, ..Default::default() };
            sdk_json(s.render_to_layout(need_str(a, "url")?, js, timeout, &opts))
        }
        "render_to_png" => {
            let opts = julia_browser::layout::ScreenshotOptions {
                full_page: opt_bool(a, "full_page").unwrap_or(true),
                scale: a.get("scale").and_then(Value::as_f64).unwrap_or(1.0),
                ..Default::default()
            };
            return Ok(match s.render_to_png(need_str(a, "url")?, js, timeout, &opts, None) {
                Ok(png) => Reply::Bytes(png),
                Err(e) => Reply::Err(e),
            });
        }
        "browse_url" => sdk_json(s.browse_url(need_str(a, "url")?)),
        "get_page_links" => sdk_json(s.get_page_links(need_str(a, "url")?, timeout)),
        "search_page" => sdk_json(s.search_page(need_str(a, "url")?, need_str(a, "query")?, timeout)),
        "fetch_and_render" => sdk_json(s.fetch_and_render(need_str(a, "url")?, opt_str(a, "output_format").unwrap_or("markdown"), js, timeout)),
        "batch_process" => {
            let urls: Vec<String> = a.get("urls").and_then(Value::as_array).map(|v| v.iter().filter_map(|u| u.as_str().map(str::to_string)).collect()).unwrap_or_default();
            Value::Array(s.batch_process(&urls, opt_str(a, "output_format").unwrap_or("markdown"), js, timeout).into_iter().map(sdk_json).collect())
        }
        "submit_form" => {
            let data: BTreeMap<String, String> = a
                .get("data")
                .and_then(Value::as_object)
                .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))).collect())
                .unwrap_or_default();
            sdk_json(s.submit_form(need_str(a, "url")?, &data))
        }
        "get_browser_info" => s.get_browser_info(),
        "clear_history" => {
            s.clear_history();
            json!({"success": true})
        }
        "set_user_agent" => {
            s.set_user_agent(need_str(a, "user_agent")?);
            json!({"success": true})
        }
        other => return Err(format!("unknown sdk method {other:?}")),
    };
    Ok(Reply::Json(v))
}

fn dispatch(t: &mut Target, method: &str, a: &Value) -> Reply {
    let r = match t {
        Target::Session(s) => call_session(s, method, a),
        Target::Agent(g) => call_agent(g, method, a),
        Target::Sdk(s) => call_sdk(s, method, a),
    };
    r.unwrap_or_else(Reply::Err)
}

fn panic_message(p: Box<dyn std::any::Any + Send>) -> String {
    p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "the browser engine panicked".into())
}

#[pymethods]
impl Engine {
    /// Start a browser of `kind` ("session", "agent" or "sdk") with JSON-encoded options.
    #[new]
    fn new(py: Python<'_>, kind: String, options: &str) -> PyResult<Self> {
        if SHUT_DOWN.load(Ordering::SeqCst) {
            return Err(PyRuntimeError::new_err("the browser engine has shut down (the interpreter is exiting)"));
        }
        let opts: Value = serde_json::from_str(options).map_err(|e| PyValueError::new_err(format!("bad options: {e}")))?;
        let (tx, rx) = mpsc::channel::<(Job, mpsc::Sender<Reply>)>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let k = kind.clone();
        let cx_slot: Arc<Mutex<usize>> = Arc::new(Mutex::new(0));
        let thread_cx = cx_slot.clone();
        let thread = std::thread::Builder::new()
            .name(format!("julia-browser-{kind}"))
            .stack_size(ENGINE_STACK)
            .spawn(move || {
                let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| build(&k, &opts)));
                let mut target = match built {
                    Ok(Ok(t)) => {
                        if let Ok(mut c) = thread_cx.lock() {
                            *c = julia_browser::js::runtime::context_id();
                        }
                        let _ = ready_tx.send(Ok(()));
                        t
                    }
                    Ok(Err(e)) => return drop(ready_tx.send(Err(e))),
                    Err(p) => return drop(ready_tx.send(Err(panic_message(p)))),
                };
                for (job, reply) in rx {
                    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(&mut target))).unwrap_or_else(|p| Reply::Err(panic_message(p)));
                    let _ = reply.send(r);
                }
                // Free the browser and this thread's JavaScript runtime now: left to thread exit,
                // they were leaked (6-15 GB processes in long benchmark runs).
                drop(target);
                let guard = thread_cx.lock();
                if !SHUT_DOWN.load(Ordering::SeqCst) {
                    let _ = std::panic::catch_unwind(julia_browser::js::runtime::teardown_thread);
                }
                // The context is gone (or about to be, with SpiderMonkey's shutdown at exit): a later
                // `close()` (the Browser freed after the atexit shutdown) must not interrupt it.
                if let Ok(mut c) = guard {
                    *c = 0;
                }
            })
            .map_err(|e| PyRuntimeError::new_err(format!("cannot start the engine thread: {e}")))?;
        py.detach(move || ready_rx.recv())
            .map_err(|_| PyRuntimeError::new_err("the engine thread exited during start-up"))?
            .map_err(PyRuntimeError::new_err)?;
        let inner = Arc::new(Inner { tx: Mutex::new(Some(tx)), thread: Mutex::new(Some(thread)), cx: cx_slot });
        if let Ok(mut all) = ENGINES.lock() {
            all.retain(|w| w.strong_count() > 0);
            all.push(Arc::downgrade(&inner));
        }
        Ok(Engine { inner, kind })
    }

    /// Call `method` with JSON-encoded keyword arguments. Returns JSON text, or bytes for images.
    fn call(&self, py: Python<'_>, method: String, args: &str) -> PyResult<Py<PyAny>> {
        let a: Value = serde_json::from_str(args).map_err(|e| PyValueError::new_err(format!("bad arguments: {e}")))?;
        let tx = self.inner.tx.lock().map_err(|_| PyRuntimeError::new_err("engine lock poisoned"))?.clone();
        let Some(tx) = tx else { return Err(PyRuntimeError::new_err("the browser is closed")) };
        let (reply_tx, reply_rx) = mpsc::channel();
        let job: Job = Box::new(move |t| dispatch(t, &method, &a));
        tx.send((job, reply_tx)).map_err(|_| PyRuntimeError::new_err("the browser engine stopped"))?;
        let reply = py.detach(move || reply_rx.recv()).map_err(|_| PyRuntimeError::new_err("the browser engine stopped"))?;
        match reply {
            Reply::Json(v) => Ok(v.to_string().into_pyobject(py)?.into_any().unbind()),
            Reply::Bytes(b) => Ok(PyBytes::new(py, &b).into_any().unbind()),
            Reply::Err(e) => Err(PyRuntimeError::new_err(e)),
        }
    }

    /// Stop the engine thread and wait for it (after the call in progress, if any). Idempotent.
    fn close(&self, py: Python<'_>) {
        self.inner.close();
        let inner = self.inner.clone();
        py.detach(move || inner.join(None));
    }

    #[getter]
    fn kind(&self) -> &str {
        &self.kind
    }

    #[getter]
    fn closed(&self) -> bool {
        self.inner.tx.lock().map(|t| t.is_none()).unwrap_or(true)
    }
}

/// CDP servers started by `serve_cdp`, closed by `shutdown`.
static CDP_SERVERS: Mutex<Vec<julia_browser::cdp::CdpServer>> = Mutex::new(Vec::new());

/// Start a Chrome DevTools Protocol server in this process; returns `(port, browser WebSocket URL)`.
#[pyfunction]
#[pyo3(signature = (options, host = "127.0.0.1".to_string(), port = 9222))]
fn serve_cdp(options: &str, host: String, port: u16) -> PyResult<(u16, String)> {
    if SHUT_DOWN.load(Ordering::SeqCst) {
        return Err(PyRuntimeError::new_err("the browser engine has shut down (the interpreter is exiting)"));
    }
    let opts: Value = serde_json::from_str(options).map_err(|e| PyValueError::new_err(format!("bad options: {e}")))?;
    let server = julia_browser::cdp::spawn(julia_browser::cdp::CdpOptions {
        host,
        port,
        js: js_config(&opts),
        execute_js: opt_bool(&opts, "javascript").unwrap_or(true),
        user_agent: opt_str(&opts, "user_agent").map(str::to_string),
    })
    .map_err(PyRuntimeError::new_err)?;
    let out = (server.addr.port(), server.ws_url.clone());
    if let Ok(mut all) = CDP_SERVERS.lock() {
        all.push(server);
    }
    Ok(out)
}

/// Close every engine and shut SpiderMonkey down; registered with `atexit` by the package.
/// Without it the process aborts in C++ static destructors on Linux (see
/// `shutdown_engine_at_exit`). Skipped when an engine is still busy after `timeout` seconds.
#[pyfunction]
#[pyo3(signature = (timeout = 5.0))]
fn shutdown(py: Python<'_>, timeout: f64) -> bool {
    if SHUT_DOWN.swap(true, Ordering::SeqCst) {
        return true;
    }
    let live: Vec<Arc<Inner>> = ENGINES.lock().map(|all| all.iter().filter_map(Weak::upgrade).collect()).unwrap_or_default();
    py.detach(move || {
        for e in &live {
            e.close();
        }
        let until = Instant::now() + Duration::from_secs_f64(timeout.max(0.0));
        let mut all_done = live.iter().all(|e| e.join(Some(until.saturating_duration_since(Instant::now()))));
        let servers: Vec<_> = CDP_SERVERS.lock().map(|mut s| s.drain(..).collect()).unwrap_or_default();
        for s in &servers {
            all_done &= s.close_and_wait(until.saturating_duration_since(Instant::now()));
        }
        let orphans: Vec<_> = ORPHANS.lock().map(|mut o| o.drain(..).collect()).unwrap_or_default();
        for h in orphans {
            while !h.is_finished() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(5));
            }
            all_done &= h.is_finished();
        }
        if all_done {
            julia_browser::js::runtime::shutdown_engine_at_exit();
        }
        all_done
    })
}

/// Vault management for the `Vault` class (no secret leaves except through `export`).
#[pyfunction]
fn vault_op(op: &str, args: &str) -> PyResult<String> {
    use julia_browser::vault::{self, Login, Vault};
    let a: Value = serde_json::from_str(args).map_err(|e| PyValueError::new_err(format!("bad args: {e}")))?;
    let st = |k: &str| a.get(k).and_then(Value::as_str).map(str::to_string);
    let list = |k: &str| -> Vec<String> { a.get(k).and_then(Value::as_array).map(|v| v.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default() };
    let run = || -> Result<Value, String> {
        if op == "import" {
            let r = vault::import_file(std::path::Path::new(&st("path").ok_or("path is required")?), st("format").as_deref().unwrap_or("auto"))?;
            return Ok(json!({"format": r.format, "logins": r.logins, "passkeys": r.passkeys, "skipped": r.skipped, "notes": r.notes}));
        }
        if op == "export" {
            let (l, p) = vault::export_file(std::path::Path::new(&st("path").ok_or("path is required")?), st("format").as_deref().unwrap_or("cxf"))?;
            return Ok(json!({"logins": l, "passkeys": p}));
        }
        if op == "log" {
            return Ok(json!(vault::read_audit(a.get("last").and_then(Value::as_u64).unwrap_or(20) as usize)));
        }
        let _g = vault::lock();
        let mut v = Vault::open()?;
        let out = match op {
            "status" => json!({"path": vault::dir().join("vault.jbv"), "protection": v.protection(), "logins": v.logins().len(), "passkeys": v.passkeys().len(), "allowed_sites": v.allowed_sites(), "security_key_sites": v.security_key_sites()}),
            "security_key" => {
                let on = a.get("on").and_then(Value::as_bool).unwrap_or(true);
                let sites = list("sites");
                for s in &sites {
                    v.set_security_key(s, on);
                }
                v.save()?;
                vault::audit(if on { "security_key_on" } else { "security_key_off" }, &sites.join(" "), "", "", true, "");
                json!({"security_key_sites": v.security_key_sites()})
            }
            "list" => {
                let logins: Vec<Value> = v.logins().iter().map(|l| json!({"id": l.id, "title": l.title, "urls": l.urls, "username": l.username, "totp": l.totp.is_some(), "source": l.source, "updated": l.updated})).collect();
                let passkeys: Vec<Value> = v.passkeys().iter().map(|p| json!({"credentialId": p.get("credentialId"), "rpId": p.get("rpId"), "userName": p.get("userName"), "source": p.get("source"), "hidden": p.get("hidden").and_then(Value::as_bool).unwrap_or(false)})).collect();
                json!({"logins": logins, "passkeys": passkeys})
            }
            "add" => {
                let site = st("site").ok_or("site is required")?;
                let url = if site.contains("://") { site } else { format!("https://{site}") };
                let user = st("username").unwrap_or_default();
                let id = v.add_login(Login { title: st("title").unwrap_or_default(), urls: vec![url.clone()], username: user.clone(), password: st("password").ok_or("password is required")?, totp: st("totp"), source: "python".into(), ..Default::default() });
                if a.get("allow").and_then(Value::as_bool).unwrap_or(false) {
                    v.allow(&vault::base_domain(&vault::host_of(&url)));
                }
                v.save()?;
                vault::audit("add", &vault::host_of(&url), &user, "", true, &format!("item {id}"));
                json!({"id": id})
            }
            "remove" => {
                let ok = v.remove(&st("id").unwrap_or_default());
                v.save()?;
                json!({"removed": ok})
            }
            "allow" | "deny" => {
                let sites = list("sites");
                for s in &sites {
                    if op == "allow" { v.allow(s); } else { v.deny(s); }
                }
                v.save()?;
                vault::audit(op, &sites.join(" "), "", "", true, "");
                json!({"allowed_sites": v.allowed_sites()})
            }
            other => return Err(format!("unknown vault op {other:?}")),
        };
        Ok(out)
    };
    run().map(|v| v.to_string()).map_err(PyRuntimeError::new_err)
}

#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(vault_op, m)?)?;
    m.add_class::<Engine>()?;
    m.add_function(wrap_pyfunction!(shutdown, m)?)?;
    m.add_function(wrap_pyfunction!(serve_cdp, m)?)?;
    m.add("ENGINE_VERSION", julia_browser::VERSION)?;
    Ok(())
}
