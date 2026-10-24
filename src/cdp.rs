//! Chrome DevTools Protocol (CDP) server: lets Puppeteer, Playwright (`connectOverCDP`),
//! chromedp and other CDP clients drive the browser as if it were Chrome.
//!
//! ```text
//! julia-browser cdp --port 9222
//! DevTools listening on ws://127.0.0.1:9222/devtools/browser/<id>
//! ```
//!
//! Layout: one listener thread serves the `/json/*` HTTP endpoints and upgrades WebSocket
//! connections; each connection runs on its own thread, handles the browser-level domains
//! (`Browser.*`, `Target.*`) and routes session messages (flat mode, `sessionId`) to the page
//! targets. Every page target is an actor thread (a large native stack, as the JavaScript engine
//! needs) owning an [`AgentSdk`]; it answers the page domains (`Page`, `Runtime`, `DOM`, `Input`,
//! `Network` cookies, `Emulation`) and sends events to every session attached to it. Remote
//! objects and DOM node ids live in the page (`cdp_helper.js`).
//!
//! The page's event loop runs while a command executes (timers settle for a short stretch of page
//! time after each script) and while an awaited promise (`awaitPromise`) is pending.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::agent::AgentSdk;
use crate::js::JsConfig;

const HELPER: &str = include_str!("cdp_helper.js");
/// Native stack of a page thread (the engine reserves a 24 MiB quota inside it).
const PAGE_STACK: usize = 256 * 1024 * 1024;
/// Product name reported by `Browser.getVersion` and `/json/version`.
const PRODUCT: &str = "HeadlessChrome/131.0.0.0";
const DEFAULT_CONTEXT: &str = "DEFAULTBROWSERCONTEXT0000000000000";

/// How the CDP server is started.
#[derive(Clone)]
pub struct CdpOptions {
    pub host: String,
    /// 0 picks a free port.
    pub port: u16,
    pub js: JsConfig,
    pub execute_js: bool,
    pub user_agent: Option<String>,
}

impl Default for CdpOptions {
    fn default() -> Self {
        CdpOptions { host: "127.0.0.1".into(), port: 9222, js: JsConfig::default(), execute_js: true, user_agent: None }
    }
}

/// A running server: its address and browser WebSocket URL.
pub struct CdpServer {
    pub addr: SocketAddr,
    pub ws_url: String,
    shared: Arc<Shared>,
}

impl CdpServer {
    /// Close every page target (the listener keeps running until the process exits).
    pub fn close_targets(&self) {
        self.shared.close_all();
    }

    /// Close every page target and wait up to `limit` for their threads to end (before the
    /// JavaScript engine shuts down at exit). True once all have ended.
    pub fn close_and_wait(&self, limit: Duration) -> bool {
        self.shared.close_all();
        let until = Instant::now() + limit;
        let threads: Vec<std::thread::JoinHandle<()>> = self.shared.threads.lock().map(|mut t| t.drain(..).collect()).unwrap_or_default();
        let mut all = true;
        for h in threads {
            while !h.is_finished() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(5));
            }
            all &= h.is_finished();
        }
        all
    }
}

/// Start the server on a background thread and return once it listens.
pub fn spawn(opts: CdpOptions) -> Result<CdpServer, String> {
    let listener = TcpListener::bind((opts.host.as_str(), opts.port)).map_err(|e| format!("cannot listen on {}:{}: {e}", opts.host, opts.port))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let shared = Arc::new(Shared::new(addr, opts));
    shared.create_target("about:blank", DEFAULT_CONTEXT);
    let ws_url = shared.browser_ws_url();
    let s = shared.clone();
    std::thread::Builder::new()
        .name("cdp-listener".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let s = s.clone();
                let _ = std::thread::Builder::new().name("cdp-conn".into()).spawn(move || serve_connection(stream, s));
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(CdpServer { addr, ws_url, shared })
}

/// Run the server in the foreground (the `cdp` command). Never returns unless binding fails.
pub fn serve(opts: CdpOptions) -> i32 {
    match spawn(opts) {
        Ok(server) => {
            // Same line as Chrome prints, which launchers parse.
            eprintln!("\nDevTools listening on {}", server.ws_url);
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

// ---------------------------------------------------------------- shared browser state

struct TargetInfo {
    url: String,
    title: String,
    context: String,
    attached: bool,
}

struct Target {
    tx: Sender<PageMsg>,
    info: Arc<Mutex<TargetInfo>>,
}

struct Conn {
    out: Sender<String>,
    discover: bool,
    auto_attach: bool,
    /// sessionId -> targetId
    sessions: HashMap<String, String>,
}

struct Shared {
    addr: SocketAddr,
    browser_id: String,
    opts: CdpOptions,
    targets: Mutex<BTreeMap<String, Target>>,
    conns: Mutex<HashMap<u64, Conn>>,
    contexts: Mutex<Vec<String>>,
    next_conn: AtomicU64,
    next_ctx: AtomicI64,
    /// Page threads, for `close_and_wait`.
    threads: Mutex<Vec<std::thread::JoinHandle<()>>>,
}

fn hex_id(len: usize) -> String {
    let mut s = String::new();
    while s.len() < len {
        s.push_str(&uuid::Uuid::new_v4().simple().to_string().to_uppercase());
    }
    s.truncate(len);
    s
}

fn now_secs() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// Monotonic timestamp in seconds, as CDP events carry.
fn mono() -> f64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() + 1000.0
}

fn event(method: &str, params: Value, session: Option<&str>) -> String {
    let mut m = json!({"method": method, "params": params});
    if let Some(s) = session {
        m["sessionId"] = json!(s);
    }
    m.to_string()
}

fn response(id: &Value, result: Result<Value, String>, session: Option<&str>) -> String {
    let mut m = match result {
        Ok(r) => json!({"id": id, "result": r}),
        Err(e) => {
            let code = if e.ends_with("wasn't found") { -32601 } else { -32000 };
            json!({"id": id, "error": {"code": code, "message": e}})
        }
    };
    if let Some(s) = session {
        m["sessionId"] = json!(s);
    }
    m.to_string()
}

impl Shared {
    fn new(addr: SocketAddr, opts: CdpOptions) -> Self {
        Shared {
            addr,
            browser_id: uuid::Uuid::new_v4().to_string(),
            opts,
            targets: Mutex::new(BTreeMap::new()),
            conns: Mutex::new(HashMap::new()),
            contexts: Mutex::new(Vec::new()),
            next_conn: AtomicU64::new(1),
            next_ctx: AtomicI64::new(1),
            threads: Mutex::new(Vec::new()),
        }
    }

    fn host(&self) -> String {
        self.addr.to_string()
    }

    fn browser_ws_url(&self) -> String {
        format!("ws://{}/devtools/browser/{}", self.host(), self.browser_id)
    }

    fn user_agent(&self) -> String {
        self.opts.user_agent.clone().unwrap_or_else(|| crate::http::DEFAULT_USER_AGENT.to_string())
    }

    fn version_json(&self) -> Value {
        json!({
            "Browser": PRODUCT,
            "Protocol-Version": "1.3",
            "User-Agent": self.user_agent(),
            "V8-Version": "13.1.201.0",
            "WebKit-Version": "537.36",
            "julia-browser": crate::VERSION,
            "webSocketDebuggerUrl": self.browser_ws_url(),
        })
    }

    fn target_info(&self, id: &str, t: &Target) -> Value {
        let i = t.info.lock().unwrap();
        json!({"targetId": id, "type": "page", "title": i.title, "url": i.url, "attached": i.attached, "canAccessOpener": false, "browserContextId": i.context})
    }

    fn target_infos(&self) -> Vec<Value> {
        self.targets.lock().unwrap().iter().map(|(id, t)| self.target_info(id, t)).collect()
    }

    fn list_json(&self) -> Value {
        let host = self.host();
        Value::Array(
            self.targets
                .lock()
                .unwrap()
                .iter()
                .map(|(id, t)| {
                    let i = t.info.lock().unwrap();
                    json!({
                        "description": "", "devtoolsFrontendUrl": "", "id": id, "title": i.title, "type": "page", "url": i.url,
                        "webSocketDebuggerUrl": format!("ws://{host}/devtools/page/{id}"),
                    })
                })
                .collect(),
        )
    }

    /// Send a browser-level event to every connection that discovers targets.
    fn broadcast_discover(&self, method: &str, params: Value) {
        let msg = event(method, params, None);
        for c in self.conns.lock().unwrap().values() {
            if c.discover {
                let _ = c.out.send(msg.clone());
            }
        }
    }

    fn target_changed(&self, id: &str) {
        let info = self.targets.lock().unwrap().get(id).map(|t| self.target_info(id, t));
        if let Some(info) = info {
            self.broadcast_discover("Target.targetInfoChanged", json!({"targetInfo": info}));
        }
    }

    /// Start a page target; connections that discover / auto-attach are told about it.
    fn create_target(self: &Arc<Self>, url: &str, context: &str) -> String {
        let id = hex_id(32);
        let (tx, rx) = mpsc::channel();
        let info = Arc::new(Mutex::new(TargetInfo { url: "about:blank".into(), title: String::new(), context: context.to_string(), attached: false }));
        let shared = self.clone();
        let (pid, pinfo) = (id.clone(), info.clone());
        let spawned = std::thread::Builder::new().name(format!("cdp-page-{}", &id[..8])).stack_size(PAGE_STACK).spawn(move || {
            let mut page = Page::new(shared, pid, pinfo);
            page.run(rx);
            // free the page's engine and JavaScript runtime with the target
            drop(page);
            crate::js::runtime::teardown_thread();
        });
        match spawned {
            Ok(h) => self.threads.lock().unwrap().push(h),
            Err(_) => return id,
        }
        self.targets.lock().unwrap().insert(id.clone(), Target { tx: tx.clone(), info });
        let info = self.targets.lock().unwrap().get(&id).map(|t| self.target_info(&id, t)).unwrap_or(Value::Null);
        self.broadcast_discover("Target.targetCreated", json!({"targetInfo": info}));
        let auto: Vec<u64> = self.conns.lock().unwrap().iter().filter(|(_, c)| c.auto_attach).map(|(k, _)| *k).collect();
        for conn in auto {
            self.attach(conn, &id);
        }
        if url != "about:blank" && !url.is_empty() {
            let _ = tx.send(PageMsg::Navigate(url.to_string()));
        }
        id
    }

    /// Attach connection `conn` to target `id` in flat mode; returns the session id.
    fn attach(&self, conn: u64, id: &str) -> Option<String> {
        let (tx, info) = {
            let t = self.targets.lock().unwrap();
            let t = t.get(id)?;
            (t.tx.clone(), self.target_info(id, t))
        };
        let session = hex_id(32);
        let out = {
            let mut conns = self.conns.lock().unwrap();
            let c = conns.get_mut(&conn)?;
            c.sessions.insert(session.clone(), id.to_string());
            c.out.clone()
        };
        if let Some(t) = self.targets.lock().unwrap().get(id) {
            t.info.lock().unwrap().attached = true;
        }
        let mut info = info;
        info["attached"] = json!(true);
        // The event goes out before anything the page sends on the new session.
        let _ = out.send(event("Target.attachedToTarget", json!({"sessionId": session, "targetInfo": info, "waitingForDebugger": false}), None));
        let _ = tx.send(PageMsg::Attach { session: Some(session.clone()), out });
        Some(session)
    }

    fn close_target(&self, id: &str) -> bool {
        let Some(t) = self.targets.lock().unwrap().remove(id) else { return false };
        let _ = t.tx.send(PageMsg::Close);
        let info = json!({"targetId": id});
        for c in self.conns.lock().unwrap().values_mut() {
            let gone: Vec<String> = c.sessions.iter().filter(|(_, t)| t.as_str() == id).map(|(s, _)| s.clone()).collect();
            for s in gone {
                c.sessions.remove(&s);
                let _ = c.out.send(event("Target.detachedFromTarget", json!({"sessionId": s, "targetId": id}), None));
            }
        }
        self.broadcast_discover("Target.targetDestroyed", info);
        true
    }

    fn close_all(&self) {
        let ids: Vec<String> = self.targets.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.close_target(&id);
        }
    }
}

// ---------------------------------------------------------------- HTTP + WebSocket

/// Read the request head without consuming it (a WebSocket handshake reads it again).
fn peek_head(stream: &TcpStream) -> Option<String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut buf = vec![0u8; 16384];
    for _ in 0..200 {
        let n = stream.peek(&mut buf).ok()?;
        if n == 0 {
            return None;
        }
        let text = String::from_utf8_lossy(&buf[..n]).to_string();
        if text.contains("\r\n\r\n") {
            return Some(text);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    None
}

fn http_reply(mut stream: TcpStream, status: &str, body: &str) {
    // consume the request
    let mut sink = [0u8; 16384];
    let _ = stream.set_read_timeout(Some(Duration::from_millis(50)));
    let _ = stream.read(&mut sink);
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=UTF-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.flush();
}

fn serve_connection(stream: TcpStream, shared: Arc<Shared>) {
    let Some(head) = peek_head(&stream) else { return };
    let first = head.lines().next().unwrap_or("").to_string();
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let upgrade = head.to_ascii_lowercase().contains("upgrade: websocket");
    let (path, query) = target.split_once('?').map(|(p, q)| (p.to_string(), q.to_string())).unwrap_or((target.clone(), String::new()));
    let path = path.trim_end_matches('/').to_string();

    if !upgrade {
        let (status, body) = match path.as_str() {
            "/json/version" => ("200 OK", shared.version_json().to_string()),
            "/json" | "/json/list" => ("200 OK", shared.list_json().to_string()),
            "/json/protocol" => ("200 OK", json!({"version": {"major": "1", "minor": "3"}, "domains": []}).to_string()),
            "/json/new" if method == "PUT" || method == "GET" => {
                let url = percent_encoding::percent_decode_str(&query).decode_utf8_lossy().to_string();
                let url = if url.is_empty() { "about:blank".to_string() } else { url };
                let id = shared.create_target(&url, DEFAULT_CONTEXT);
                let host = shared.host();
                ("200 OK", json!({"description": "", "devtoolsFrontendUrl": "", "id": id, "title": "", "type": "page", "url": url, "webSocketDebuggerUrl": format!("ws://{host}/devtools/page/{id}")}).to_string())
            }
            p if p.starts_with("/json/close/") => {
                if shared.close_target(&p["/json/close/".len()..]) {
                    ("200 OK", "\"Target is closing\"".to_string())
                } else {
                    ("404 Not Found", "\"No such target id\"".to_string())
                }
            }
            p if p.starts_with("/json/activate/") => ("200 OK", "\"Target activated\"".to_string()),
            _ => ("404 Not Found", "\"Not found\"".to_string()),
        };
        http_reply(stream, status, &body);
        return;
    }

    // WebSocket: the browser endpoint, or a page endpoint (messages without sessionId go to it)
    let bound = if let Some(id) = path.strip_prefix("/devtools/page/") {
        if !shared.targets.lock().unwrap().contains_key(id) {
            http_reply(stream, "404 Not Found", "\"No such target id\"");
            return;
        }
        Some(id.to_string())
    } else if path.starts_with("/devtools/browser") {
        None
    } else {
        http_reply(stream, "404 Not Found", "\"Not found\"");
        return;
    };
    let _ = stream.set_read_timeout(None);
    let _ = stream.set_nodelay(true);
    let Ok(raw) = stream.try_clone() else { return };
    let lock = Arc::new(Mutex::new(()));
    let config = tungstenite::protocol::WebSocketConfig::default().max_message_size(Some(256 << 20)).max_frame_size(Some(256 << 20));
    let Ok(mut ws) = tungstenite::accept_with_config(WsIo { stream, lock: lock.clone() }, Some(config)) else { return };

    // Replies and events go out from their own thread as soon as they are queued (the reader
    // blocks on the socket); frames are written whole under the lock tungstenite's own writes
    // (pongs, close) take too.
    let (out_tx, out_rx) = mpsc::channel::<String>();
    let mut writer = raw.try_clone().ok();
    std::thread::spawn(move || {
        let Some(w) = writer.as_mut() else { return };
        while let Ok(m) = out_rx.recv() {
            log("->", &m);
            let frame = ws_text_frame(m.as_bytes());
            let _guard = lock.lock().unwrap();
            if w.write_all(&frame).and_then(|_| w.flush()).is_err() {
                break;
            }
        }
    });
    let conn_id = shared.next_conn.fetch_add(1, Ordering::SeqCst);
    shared.conns.lock().unwrap().insert(conn_id, Conn { out: out_tx.clone(), discover: false, auto_attach: false, sessions: HashMap::new() });
    if let Some(id) = &bound {
        if let Some(t) = shared.targets.lock().unwrap().get(id) {
            let _ = t.tx.send(PageMsg::Attach { session: None, out: out_tx.clone() });
        }
    }

    loop {
        match ws.read() {
            Ok(tungstenite::Message::Text(t)) => handle_message(&shared, conn_id, bound.as_deref(), &out_tx, t.as_str()),
            Ok(tungstenite::Message::Binary(b)) => handle_message(&shared, conn_id, bound.as_deref(), &out_tx, &String::from_utf8_lossy(&b)),
            Ok(tungstenite::Message::Close(_)) => {
                let _ = ws.flush();
                break;
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted) => {}
            Err(_) => break,
        }
    }
    shared.conns.lock().unwrap().remove(&conn_id);
    // the writer thread stops at its next write
    let _ = raw.shutdown(std::net::Shutdown::Both);
}

/// The server side of a WebSocket connection: reads go straight to the socket, writes take the
/// lock shared with the writer thread.
struct WsIo {
    stream: TcpStream,
    lock: Arc<Mutex<()>>,
}

impl Read for WsIo {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.stream.read(buf)
    }
}

impl Write for WsIo {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _guard = self.lock.lock().unwrap();
        self.stream.write_all(buf)?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

/// An unmasked (server-to-client) text frame.
fn ws_text_frame(payload: &[u8]) -> Vec<u8> {
    let n = payload.len();
    let mut f = Vec::with_capacity(n + 10);
    f.push(0x81);
    if n < 126 {
        f.push(n as u8);
    } else if n <= 0xffff {
        f.push(126);
        f.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        f.push(127);
        f.extend_from_slice(&(n as u64).to_be_bytes());
    }
    f.extend_from_slice(payload);
    f
}

/// `JB_CDP_LOG=1`: print protocol traffic to stderr.
fn logging() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("JB_CDP_LOG").map_or(false, |v| v != "0"))
}

fn log(dir: &str, text: &str) {
    if logging() {
        let t: String = text.chars().take(400).collect();
        eprintln!("[cdp {:.3}] {dir} {t}", mono());
    }
}

fn handle_message(shared: &Arc<Shared>, conn: u64, bound: Option<&str>, out: &Sender<String>, text: &str) {
    log("<-", text);
    let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("").to_string();
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    let session = msg.get("sessionId").and_then(Value::as_str).map(str::to_string);

    // Page sessions
    let target = match &session {
        Some(s) => match shared.conns.lock().unwrap().get(&conn).and_then(|c| c.sessions.get(s).cloned()) {
            Some(t) => Some(t),
            None => {
                let _ = out.send(response(&id, Err(format!("Session with given id not found.")), Some(s)));
                return;
            }
        },
        None => bound.map(str::to_string),
    };
    if let Some(t) = target {
        if !method.starts_with("Target.") || session.is_some() && matches!(method.as_str(), "Target.setAutoAttach" | "Target.setDiscoverTargets") {
            let tx = shared.targets.lock().unwrap().get(&t).map(|t| t.tx.clone());
            match tx {
                Some(tx) => {
                    let _ = tx.send(PageMsg::Cmd { id, session, method, params, out: out.clone() });
                }
                None => {
                    let _ = out.send(response(&id, Err("No target with given id found".into()), session.as_deref()));
                }
            }
            return;
        }
    }

    let result = browser_command(shared, conn, &method, &params, out);
    let _ = out.send(response(&id, result, session.as_deref()));
}

fn browser_command(shared: &Arc<Shared>, conn: u64, method: &str, p: &Value, out: &Sender<String>) -> Result<Value, String> {
    let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match method {
        "Browser.getVersion" => Ok(json!({"protocolVersion": "1.3", "product": PRODUCT, "revision": "@julia-browser", "userAgent": shared.user_agent(), "jsVersion": "13.1.201.0"})),
        "Browser.close" => {
            shared.close_all();
            Ok(json!({}))
        }
        "Browser.getWindowForTarget" => Ok(json!({"windowId": 1, "bounds": {"left": 0, "top": 0, "width": 1280, "height": 720, "windowState": "normal"}})),
        "Browser.getWindowBounds" => Ok(json!({"bounds": {"left": 0, "top": 0, "width": 1280, "height": 720, "windowState": "normal"}})),
        "Target.setDiscoverTargets" => {
            let on = p.get("discover").and_then(Value::as_bool).unwrap_or(false);
            if let Some(c) = shared.conns.lock().unwrap().get_mut(&conn) {
                c.discover = on;
            }
            if on {
                for info in shared.target_infos() {
                    let _ = out.send(event("Target.targetCreated", json!({"targetInfo": info}), None));
                }
            }
            Ok(json!({}))
        }
        "Target.setAutoAttach" => {
            let on = p.get("autoAttach").and_then(Value::as_bool).unwrap_or(false);
            let already: Vec<String> = {
                let mut conns = shared.conns.lock().unwrap();
                let Some(c) = conns.get_mut(&conn) else { return Ok(json!({})) };
                c.auto_attach = on;
                c.sessions.values().cloned().collect()
            };
            if on {
                let ids: Vec<String> = shared.targets.lock().unwrap().keys().cloned().collect();
                for id in ids.iter().filter(|id| !already.contains(id)) {
                    shared.attach(conn, id);
                }
            }
            Ok(json!({}))
        }
        "Target.getTargets" => Ok(json!({"targetInfos": shared.target_infos()})),
        "Target.getTargetInfo" => {
            let id = s("targetId");
            let t = shared.targets.lock().unwrap();
            match t.get(&id) {
                Some(target) => Ok(json!({"targetInfo": shared.target_info(&id, target)})),
                None => Ok(json!({"targetInfo": {"targetId": shared.browser_id, "type": "browser", "title": "", "url": "", "attached": true, "canAccessOpener": false}})),
            }
        }
        "Target.createTarget" => {
            let url = s("url");
            let ctx = p.get("browserContextId").and_then(Value::as_str).unwrap_or(DEFAULT_CONTEXT).to_string();
            Ok(json!({"targetId": shared.create_target(if url.is_empty() { "about:blank" } else { &url }, &ctx)}))
        }
        "Target.closeTarget" => Ok(json!({"success": shared.close_target(&s("targetId"))})),
        "Target.attachToTarget" => match shared.attach(conn, &s("targetId")) {
            Some(session) => Ok(json!({"sessionId": session})),
            None => Err("No target with given id found".into()),
        },
        "Target.detachFromTarget" => {
            let session = s("sessionId");
            let target = shared.conns.lock().unwrap().get_mut(&conn).and_then(|c| c.sessions.remove(&session));
            if let Some(t) = &target {
                if let Some(target) = shared.targets.lock().unwrap().get(t) {
                    let _ = target.tx.send(PageMsg::Detach(session.clone()));
                }
                let _ = out.send(event("Target.detachedFromTarget", json!({"sessionId": session, "targetId": t}), None));
            }
            Ok(json!({}))
        }
        "Target.activateTarget" | "Target.exposeDevToolsProtocol" | "Target.setRemoteLocations" => Ok(json!({})),
        "Target.createBrowserContext" => {
            let id = hex_id(32);
            shared.contexts.lock().unwrap().push(id.clone());
            Ok(json!({"browserContextId": id}))
        }
        "Target.getBrowserContexts" => Ok(json!({"browserContextIds": shared.contexts.lock().unwrap().clone()})),
        "Target.disposeBrowserContext" => {
            let ctx = s("browserContextId");
            let ids: Vec<String> = shared.targets.lock().unwrap().iter().filter(|(_, t)| t.info.lock().unwrap().context == ctx).map(|(id, _)| id.clone()).collect();
            for id in ids {
                shared.close_target(&id);
            }
            shared.contexts.lock().unwrap().retain(|c| *c != ctx);
            Ok(json!({}))
        }
        m if m.starts_with("Browser.") || m.starts_with("Storage.") && !m.contains("Cookies") || m.starts_with("SystemInfo.") || m.ends_with(".enable") || m.ends_with(".disable") => Ok(json!({})),
        "Storage.getCookies" | "Storage.setCookies" | "Storage.clearCookies" => {
            // cookies are shared by every page: ask the first one
            let tx = shared.targets.lock().unwrap().values().next().map(|t| t.tx.clone());
            let Some(tx) = tx else { return Ok(json!({"cookies": []})) };
            let (rtx, rrx) = mpsc::channel();
            let _ = tx.send(PageMsg::Cookies { method: method.to_string(), params: p.clone(), reply: rtx });
            rrx.recv_timeout(Duration::from_secs(30)).unwrap_or_else(|_| Err("page did not answer".into()))
        }
        other => Err(format!("'{other}' wasn't found")),
    }
}

// ---------------------------------------------------------------- page targets

enum PageMsg {
    Cmd { id: Value, session: Option<String>, method: String, params: Value, out: Sender<String> },
    Attach { session: Option<String>, out: Sender<String> },
    Detach(String),
    Navigate(String),
    Cookies { method: String, params: Value, reply: Sender<Result<Value, String>> },
    Close,
}

/// A command waiting for a promise the page has not settled yet.
struct Pending {
    id: Value,
    session: Option<String>,
    out: Sender<String>,
    pid: u64,
}

struct Page {
    shared: Arc<Shared>,
    target_id: String,
    info: Arc<Mutex<TargetInfo>>,
    agent: AgentSdk,
    sinks: Vec<(Option<String>, Sender<String>)>,
    loader_id: String,
    /// Execution contexts of the current document: (id, world name; "" for the main world).
    contexts: Vec<(i64, String)>,
    worlds: Vec<String>,
    init_scripts: Vec<(String, String)>,
    bindings: Vec<String>,
    runtime_enabled: bool,
    lifecycle: bool,
    pending: Vec<Pending>,
    history: Vec<String>,
    history_index: usize,
    last_href: String,
    next_script: u64,
    /// Page time a command lets timers run for (`JB_SETTLE_MS`).
    settle_ms: u64,
    /// When the page's event loop last ran (idle pumping catches up from here).
    last_run: Instant,
}

/// While no command arrives, the page's timers and network callbacks run every this many ms,
/// in step with real time (as a browser's event loop would).
const IDLE_PUMP_MS: u64 = 50;

impl Page {
    fn new(shared: Arc<Shared>, target_id: String, info: Arc<Mutex<TargetInfo>>) -> Self {
        let mut js = shared.opts.js.clone();
        if js.action_settle_ms.is_none() {
            js.action_settle_ms = Some(std::env::var("JB_SETTLE_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(50));
        }
        let settle_ms = js.action_settle_ms.unwrap_or(50);
        let mut agent = AgentSdk::with_js_config(shared.opts.user_agent.as_deref(), 30, js);
        agent.engine.execute_js = shared.opts.execute_js;
        // commands read the page through JS; the Rust document is only synced for screenshots
        agent.engine.js_engine.defer_dom_sync = true;
        agent.open_blank();
        let mut page = Page {
            shared,
            target_id,
            info,
            agent,
            sinks: Vec::new(),
            loader_id: hex_id(32),
            contexts: Vec::new(),
            worlds: Vec::new(),
            init_scripts: Vec::new(),
            bindings: Vec::new(),
            runtime_enabled: false,
            lifecycle: false,
            pending: Vec::new(),
            history: vec!["about:blank".into()],
            history_index: 0,
            last_href: "about:blank".into(),
            next_script: 1,
            settle_ms,
            last_run: Instant::now(),
        };
        page.new_contexts();
        page
    }

    fn run(&mut self, rx: Receiver<PageMsg>) {
        loop {
            let wait = Duration::from_millis(if self.pending.is_empty() { IDLE_PUMP_MS } else { 15 });
            match rx.recv_timeout(wait) {
                Ok(PageMsg::Close) | Err(RecvTimeoutError::Disconnected) => {
                    for p in std::mem::take(&mut self.pending) {
                        let _ = p.out.send(response(&p.id, Err("Target closed".into()), p.session.as_deref()));
                    }
                    return;
                }
                Ok(PageMsg::Attach { session, out }) => self.sinks.push((session, out)),
                Ok(PageMsg::Detach(s)) => self.sinks.retain(|(x, _)| x.as_deref() != Some(s.as_str())),
                Ok(PageMsg::Navigate(url)) => {
                    let _ = self.navigate(&url);
                }
                Ok(PageMsg::Cookies { method, params, reply }) => {
                    let _ = reply.send(self.cookies(&method, &params));
                }
                Ok(PageMsg::Cmd { id, session, method, params, out }) => {
                    let r = self.command(&method, &params);
                    match r {
                        Ok(Reply::Now(v)) => {
                            let _ = out.send(response(&id, Ok(v), session.as_deref()));
                        }
                        Ok(Reply::Pending(pid)) => self.pending.push(Pending { id, session, out, pid }),
                        Err(e) => {
                            let _ = out.send(response(&id, Err(e), session.as_deref()));
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) if !self.pending.is_empty() => self.pump(),
                Err(RecvTimeoutError::Timeout) => self.idle(),
            }
        }
    }

    // ---- events

    fn emit(&mut self, method: &str, params: Value) {
        self.sinks.retain(|(s, out)| out.send(event(method, params.clone(), s.as_deref())).is_ok());
    }

    fn frame(&self) -> Value {
        let url = self.agent.current_url.clone().unwrap_or_else(|| "about:blank".into());
        let origin = url::Url::parse(&url).map(|u| u.origin().ascii_serialization()).unwrap_or_else(|_| "null".into());
        json!({
            "id": self.target_id, "loaderId": self.loader_id, "url": url, "domainAndRegistry": "", "securityOrigin": origin,
            "mimeType": "text/html", "adFrameStatus": {"adFrameType": "none"}, "secureContextType": if url.starts_with("https:") || url.starts_with("http://localhost") || url.starts_with("http://127.") { "Secure" } else { "InsecureScheme" },
            "crossOriginIsolatedContextType": "NotIsolated", "gatedAPIFeatures": [],
        })
    }

    fn context_json(&self, id: i64, world: &str) -> Value {
        let url = self.agent.current_url.clone().unwrap_or_else(|| "about:blank".into());
        let origin = url::Url::parse(&url).map(|u| u.origin().ascii_serialization()).unwrap_or_else(|_| "://".into());
        json!({
            "id": id, "origin": origin, "name": world, "uniqueId": format!("{}.{}", self.target_id, id),
            "auxData": {"isDefault": world.is_empty(), "type": if world.is_empty() { "default" } else { "isolated" }, "frameId": self.target_id},
        })
    }

    fn new_contexts(&mut self) {
        let mut ctx = vec![(self.shared.next_ctx.fetch_add(1, Ordering::SeqCst), String::new())];
        for w in &self.worlds {
            ctx.push((self.shared.next_ctx.fetch_add(1, Ordering::SeqCst), w.clone()));
        }
        self.contexts = ctx;
    }

    fn announce_contexts(&mut self) {
        if !self.runtime_enabled {
            return;
        }
        for (id, w) in self.contexts.clone() {
            let c = self.context_json(id, &w);
            self.emit("Runtime.executionContextCreated", json!({"context": c}));
        }
    }

    fn lifecycle_event(&mut self, name: &str) {
        if self.lifecycle {
            let p = json!({"frameId": self.target_id, "loaderId": self.loader_id, "name": name, "timestamp": mono()});
            self.emit("Page.lifecycleEvent", p);
        }
    }

    /// Events of a new document in the frame: after `Page.navigate`, a link click, a form
    /// submission or a location change made by the page.
    fn document_changed(&mut self, load: Option<&crate::agent::PageLoad>, requested: &str) {
        self.loader_id = hex_id(32);
        self.last_run = Instant::now();
        for p in std::mem::take(&mut self.pending) {
            let _ = p.out.send(response(&p.id, Err("Execution context was destroyed.".into()), p.session.as_deref()));
        }
        let url = self.agent.current_url.clone().unwrap_or_else(|| requested.to_string());
        self.emit("Page.frameStartedLoading", json!({"frameId": self.target_id}));
        self.lifecycle_event("init");
        if !url.starts_with("about:") {
            let (status, reason, headers, len) = match load {
                Some(l) => (l.status, l.reason.clone(), l.headers.clone(), l.body_len),
                None => (200, "OK".to_string(), BTreeMap::new(), 0),
            };
            let mime = headers.get("content-type").map(|c| c.split(';').next().unwrap_or("").trim().to_string()).unwrap_or_else(|| "text/html".into());
            let rid = self.loader_id.clone();
            let ts = mono();
            self.emit("Network.requestWillBeSent", json!({
                "requestId": rid, "loaderId": rid, "documentURL": requested, "frameId": self.target_id, "type": "Document",
                "request": {"url": requested, "method": "GET", "headers": {"User-Agent": self.shared.user_agent()}, "initialPriority": "VeryHigh", "referrerPolicy": "strict-origin-when-cross-origin", "mixedContentType": "none"},
                "timestamp": ts, "wallTime": now_secs(), "initiator": {"type": "other"}, "redirectHasExtraInfo": false, "hasUserGesture": false,
            }));
            self.emit("Network.responseReceived", json!({
                "requestId": rid, "loaderId": rid, "frameId": self.target_id, "type": "Document", "timestamp": ts, "hasExtraInfo": false,
                "response": {"url": url, "status": status, "statusText": reason, "headers": headers, "mimeType": mime, "charset": "utf-8",
                    "connectionReused": false, "connectionId": 0, "fromDiskCache": false, "fromServiceWorker": false, "fromPrefetchCache": false,
                    "encodedDataLength": len, "securityState": if url.starts_with("https:") { "secure" } else { "insecure" }, "protocol": "http/1.1",
                    "remoteIPAddress": "", "remotePort": 0},
            }));
            self.emit("Network.loadingFinished", json!({"requestId": rid, "timestamp": ts, "encodedDataLength": len}));
        }
        if self.runtime_enabled {
            self.emit("Runtime.executionContextsCleared", json!({}));
        }
        let frame = self.frame();
        self.emit("Page.frameNavigated", json!({"frame": frame, "type": "Navigation"}));
        self.new_contexts();
        self.announce_contexts();
        self.lifecycle_event("commit");
        // what the page logged while loading
        if !url.starts_with("about:") {
            let console = self.agent.engine.last_js.as_ref().map(|j| j.console.clone()).unwrap_or_default();
            self.emit_console(&console);
        }
        // page-side setup of the new document: bindings and scripts to evaluate on new documents
        for b in self.bindings.clone() {
            let _ = self.quick(&format!("(__jb.cdp.addBinding({}), null)", js_str(&b)));
        }
        for (_, src) in self.init_scripts.clone() {
            let _ = self.quick(&format!("((0, eval)({}), null)", js_str(&src)));
        }
        let ts = mono();
        self.emit("Page.domContentEventFired", json!({"timestamp": ts}));
        self.lifecycle_event("DOMContentLoaded");
        self.emit("Page.loadEventFired", json!({"timestamp": ts}));
        self.lifecycle_event("load");
        self.lifecycle_event("networkAlmostIdle");
        self.lifecycle_event("networkIdle");
        self.emit("Page.frameStoppedLoading", json!({"frameId": self.target_id}));
        self.last_href = self.href();
        let title = self.agent.current_title();
        {
            let mut i = self.info.lock().unwrap();
            i.url = url;
            i.title = if title == "No title" { String::new() } else { title };
        }
        self.shared.target_changed(&self.target_id);
    }

    fn href(&mut self) -> String {
        match self.agent.engine.js_engine.eval_js("String(location.href)") {
            Value::String(s) => s,
            _ => self.agent.current_url.clone().unwrap_or_default(),
        }
    }

    /// After a script ran: report bindings, console output and same-document navigations.
    fn after_script(&mut self, console: &[String]) {
        self.emit_console(console);
        if !self.bindings.is_empty() {
            if let Ok(Value::Array(calls)) = self.quick("__jb.cdp.takeBindings()") {
                let ctx = self.contexts.first().map(|c| c.0).unwrap_or(0);
                for c in calls {
                    self.emit("Runtime.bindingCalled", json!({"name": c["name"], "payload": c["payload"], "executionContextId": ctx}));
                }
            }
        }
        let href = self.href();
        if href != self.last_href {
            self.last_href = href.clone();
            self.agent.current_url = Some(href.clone());
            self.agent.engine.js_engine.follow_same_document(&href);
            self.emit("Page.navigatedWithinDocument", json!({"frameId": self.target_id, "url": href, "navigationType": "historyApi"}));
            self.info.lock().unwrap().url = href;
            self.shared.target_changed(&self.target_id);
        }
    }

    /// `Runtime.consoleAPICalled` for console lines ("LEVEL: text") the page wrote.
    fn emit_console(&mut self, console: &[String]) {
        if self.runtime_enabled {
            let ctx = self.contexts.first().map(|c| c.0).unwrap_or(0);
            for line in console {
                let (kind, text) = match line.split_once(": ") {
                    Some((l, t)) if l.chars().all(|c| c.is_ascii_uppercase()) => (l.to_ascii_lowercase(), t.to_string()),
                    _ => ("log".to_string(), line.clone()),
                };
                let kind = match kind.as_str() {
                    "warn" => "warning".to_string(),
                    "log" | "info" | "error" | "debug" => kind,
                    _ => "log".to_string(),
                };
                self.emit("Runtime.consoleAPICalled", json!({"type": kind, "args": [{"type": "string", "value": text}], "executionContextId": ctx, "timestamp": now_secs() * 1000.0}));
            }
        }
    }

    // ---- running JavaScript

    fn wrap(expr: &str) -> String {
        format!(
            "(function () {{ try {{ return JSON.stringify({{ ok: true, r: ({expr}) }}); }} catch (e) {{ return JSON.stringify({{ ok: true, jserr: String(e && e.message || e) }}); }} }})()"
        )
    }

    /// Install the page helper (`__jb.cdp`) when the current document does not have it yet,
    /// so commands do not re-parse it every time. A page loaded without scripts has no realm
    /// yet (the previous page's is still current): build it first.
    fn ensure_helper(&mut self) {
        let url = self.agent.current_url.clone().unwrap_or_default();
        if !self.agent.engine.js_engine.is_live(&url) {
            let out = self.agent.run_page_script("null");
            self.emit_console(&out.console);
        }
        let js = &mut self.agent.engine.js_engine;
        if js.eval_js("!!(globalThis.__jb && __jb.cdp && __jb.cdp.doc === __jb.currentDocument)") != Value::Bool(true) {
            let _ = js.eval_js(&format!("(function () {{ {HELPER}\n }})(), null"));
        }
    }

    fn unwrap(v: Value) -> Result<Value, String> {
        if let Some(e) = v.get("jserr").and_then(Value::as_str) {
            return Err(e.to_string());
        }
        if v.get("ok").is_none() {
            return Err(v.get("error").and_then(Value::as_str).unwrap_or("the page did not run the command").to_string());
        }
        Ok(v.get("r").cloned().unwrap_or(Value::Null))
    }

    /// Evaluate without running the page's timers (reads: properties, node info, geometry).
    fn quick(&mut self, expr: &str) -> Result<Value, String> {
        crate::js::runtime::set_csp_eval_bypass(true);
        self.ensure_helper();
        let raw = self.agent.engine.js_engine.eval_js(&Self::wrap(expr));
        crate::js::runtime::set_csp_eval_bypass(false);
        let v = match raw {
            Value::String(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
            other => other,
        };
        Self::unwrap(v)
    }

    /// Run a script as a task of the page (timers settle afterwards; navigations are followed).
    /// `Ok(None)` when the page navigated away.
    fn task(&mut self, expr: &str) -> Result<Option<Value>, String> {
        crate::js::runtime::set_csp_eval_bypass(true);
        self.ensure_helper();
        let out = self.agent.run_page_script(&Self::wrap(expr));
        self.last_run = Instant::now();
        crate::js::runtime::set_csp_eval_bypass(false);
        if out.navigated {
            let url = self.agent.current_url.clone().unwrap_or_default();
            self.push_history(&url);
            self.document_changed(None, &url);
            return Ok(None);
        }
        self.after_script(&out.console);
        match out.result {
            Some(v) => Self::unwrap(v).map(Some),
            None => Ok(None),
        }
    }

    /// Run the page's event loop for the real time that passed since it last ran: the page clock
    /// only moves to timers that fire, so it is advanced first and the timers now due run.
    /// `Ok(None)` when the page navigated away.
    fn catch_up(&mut self) -> Result<Option<Value>, String> {
        let behind = (self.last_run.elapsed().as_millis() as u64).min(1000);
        if behind > 0 {
            let _ = self.agent.engine.js_engine.eval_js(&format!("(globalThis.__jb && (__jb.clock += {behind}), null)"));
        }
        self.agent.engine.js_engine.config.action_settle_ms = Some(0);
        let r = self.task("null");
        self.agent.engine.js_engine.config.action_settle_ms = Some(self.settle_ms);
        r
    }

    /// No command is running: let the page's timers catch up with real time.
    fn idle(&mut self) {
        let _ = self.catch_up();
    }

    /// Let the page run while promises are awaited, then answer the settled ones.
    fn pump(&mut self) {
        match self.catch_up() {
            Ok(Some(_)) => {}
            _ => return, // navigated: document_changed failed the pending calls
        }
        let pending = std::mem::take(&mut self.pending);
        for p in pending {
            match self.quick(&format!("__jb.cdp.settled({})", p.pid)) {
                Ok(Value::Null) => self.pending.push(p),
                Ok(v) => {
                    let _ = p.out.send(response(&p.id, Ok(v), p.session.as_deref()));
                }
                Err(e) => {
                    let _ = p.out.send(response(&p.id, Err(e), p.session.as_deref()));
                }
            }
        }
    }

    fn push_history(&mut self, url: &str) {
        self.history.truncate(self.history_index + 1);
        self.history.push(url.to_string());
        self.history_index = self.history.len() - 1;
    }

    fn navigate(&mut self, url: &str) -> Result<Value, String> {
        match self.agent.load_page(url) {
            Ok(load) => {
                let final_url = load.url.clone();
                self.push_history(&final_url);
                self.document_changed(Some(&load), url);
                Ok(json!({"frameId": self.target_id, "loaderId": self.loader_id}))
            }
            Err(e) => {
                let text = if e.contains("dns") || e.contains("resolve") || e.contains("No such host") {
                    "net::ERR_NAME_NOT_RESOLVED"
                } else if e.contains("refused") {
                    "net::ERR_CONNECTION_REFUSED"
                } else if e.contains("invalid") || e.contains("builder") {
                    "net::ERR_INVALID_URL"
                } else {
                    "net::ERR_FAILED"
                };
                Ok(json!({"frameId": self.target_id, "loaderId": self.loader_id, "errorText": text}))
            }
        }
    }

    fn context_ok(&self, p: &Value) -> Result<(), String> {
        if let Some(id) = p.get("contextId").or_else(|| p.get("executionContextId")).and_then(Value::as_i64) {
            if !self.contexts.iter().any(|(c, _)| *c == id) {
                return Err("Cannot find context with specified id".into());
            }
        }
        if let Some(u) = p.get("uniqueContextId").and_then(Value::as_str) {
            if !self.contexts.iter().any(|(c, _)| format!("{}.{}", self.target_id, c) == u) {
                return Err("Cannot find context with specified id".into());
            }
        }
        Ok(())
    }

    /// `{result}` / `{exceptionDetails}` now, or a promise to wait for.
    fn evaluation(&mut self, expr: &str) -> Result<Reply, String> {
        match self.task(expr)? {
            None => Ok(Reply::Now(json!({"result": {"type": "undefined"}}))),
            Some(v) => match v.get("pending").and_then(Value::as_u64) {
                Some(pid) => Ok(Reply::Pending(pid)),
                None => Ok(Reply::Now(v)),
            },
        }
    }

    fn node_expr(p: &Value) -> String {
        format!("__jb.cdp.target({})", json!({"objectId": p.get("objectId"), "nodeId": p.get("nodeId"), "backendNodeId": p.get("backendNodeId")}))
    }

    // ---- commands

    fn command(&mut self, method: &str, p: &Value) -> Result<Reply, String> {
        let now = |v: Value| Ok(Reply::Now(v));
        let b = |k: &str| p.get(k).and_then(Value::as_bool).unwrap_or(false);
        let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match method {
            // ---- Page
            "Page.enable" | "Page.disable" | "Page.setBypassCSP" | "Page.setInterceptFileChooserDialog" | "Page.bringToFront" | "Page.stopLoading" | "Page.setDownloadBehavior" | "Page.setFontFamilies" | "Page.setAdBlockingEnabled" | "Page.handleJavaScriptDialog" | "Page.resetNavigationHistory" | "Page.setWebLifecycleState" | "Page.setRPHRegistrationMode" | "Page.setSPCTransactionMode" | "Page.setPrerenderingAllowed" => now(json!({})),
            "Page.setLifecycleEventsEnabled" => {
                self.lifecycle = b("enabled");
                now(json!({}))
            }
            "Page.getFrameTree" => now(json!({"frameTree": {"frame": self.frame(), "childFrames": []}})),
            "Page.getResourceTree" => now(json!({"frameTree": {"frame": self.frame(), "childFrames": [], "resources": []}})),
            "Page.navigate" => {
                let url = s("url");
                now(self.navigate(&url)?)
            }
            "Page.reload" => {
                let url = self.agent.current_url.clone().unwrap_or_else(|| "about:blank".into());
                self.navigate(&url)?;
                now(json!({}))
            }
            "Page.getNavigationHistory" => {
                let entries: Vec<Value> = self.history.iter().enumerate().map(|(i, u)| json!({"id": i, "url": u, "userTypedURL": u, "title": "", "transitionType": "typed"})).collect();
                now(json!({"currentIndex": self.history_index, "entries": entries}))
            }
            "Page.navigateToHistoryEntry" => {
                let i = p.get("entryId").and_then(Value::as_u64).unwrap_or(0) as usize;
                let Some(url) = self.history.get(i).cloned() else { return Err("No entry with passed id".into()) };
                match self.agent.load_page(&url) {
                    Ok(load) => {
                        self.history_index = i;
                        self.document_changed(Some(&load), &url);
                        now(json!({}))
                    }
                    Err(e) => Err(e),
                }
            }
            "Page.addScriptToEvaluateOnNewDocument" => {
                let id = self.next_script.to_string();
                self.next_script += 1;
                let world = s("worldName");
                if !world.is_empty() {
                    if !self.worlds.contains(&world) {
                        self.worlds.push(world);
                    }
                } else {
                    self.init_scripts.push((id.clone(), s("source")));
                }
                if b("runImmediately") {
                    let _ = self.quick(&format!("((0, eval)({}), null)", js_str(&s("source"))));
                }
                now(json!({"identifier": id}))
            }
            "Page.removeScriptToEvaluateOnNewDocument" => {
                let id = s("identifier");
                self.init_scripts.retain(|(i, _)| *i != id);
                now(json!({}))
            }
            "Page.createIsolatedWorld" => {
                let world = s("worldName");
                if !self.worlds.contains(&world) {
                    self.worlds.push(world.clone());
                }
                let id = self.shared.next_ctx.fetch_add(1, Ordering::SeqCst);
                self.contexts.push((id, world.clone()));
                if self.runtime_enabled {
                    let c = self.context_json(id, &world);
                    self.emit("Runtime.executionContextCreated", json!({"context": c}));
                }
                now(json!({"executionContextId": id}))
            }
            "Page.getLayoutMetrics" => now(self.quick("__jb.cdp.layoutMetrics()")?),
            "Page.captureScreenshot" => now(self.screenshot(p)?),
            "Page.close" => {
                self.shared.close_target(&self.target_id.clone());
                now(json!({}))
            }

            // ---- Runtime
            "Runtime.enable" => {
                self.runtime_enabled = true;
                self.announce_contexts();
                now(json!({}))
            }
            "Runtime.disable" => {
                self.runtime_enabled = false;
                now(json!({}))
            }
            "Runtime.runIfWaitingForDebugger" | "Runtime.releaseObjectGroup" | "Runtime.discardConsoleEntries" | "Runtime.setAsyncCallStackDepth" | "Runtime.setCustomObjectFormatterEnabled" | "Runtime.setMaxCallStackSizeToCapture" => now(json!({})),
            "Runtime.evaluate" => {
                self.context_ok(p)?;
                let expr = format!("__jb.cdp.evaluate({}, {}, {})", js_str(&s("expression")), b("returnByValue"), b("awaitPromise"));
                self.evaluation(&expr)
            }
            "Runtime.callFunctionOn" => {
                self.context_ok(p)?;
                let this = p.get("objectId").cloned().unwrap_or(Value::Null);
                let args = p.get("arguments").cloned().unwrap_or(json!([]));
                let expr = format!("__jb.cdp.call({}, {}, {}, {}, {})", js_str(&s("functionDeclaration")), this, args, b("returnByValue"), b("awaitPromise"));
                self.evaluation(&expr)
            }
            "Runtime.awaitPromise" => {
                let expr = format!("(function () {{ var v = __jb.cdp.get({}); return __jb.cdp.call('function (x) {{ return x; }}', null, [{{ objectId: {} }}], {}, true); }})()", json!(p.get("promiseObjectId")), json!(p.get("promiseObjectId")), b("returnByValue"));
                self.evaluation(&expr)
            }
            "Runtime.getProperties" => now(self.quick(&format!("__jb.cdp.properties({}, {}, {})", json!(p.get("objectId")), b("ownProperties"), b("accessorPropertiesOnly")))?),
            "Runtime.releaseObject" => {
                let _ = self.quick(&format!("(__jb.cdp.release({}), null)", json!(p.get("objectId"))));
                now(json!({}))
            }
            "Runtime.addBinding" => {
                let name = s("name");
                if !self.bindings.contains(&name) {
                    self.bindings.push(name.clone());
                }
                let _ = self.quick(&format!("(__jb.cdp.addBinding({}), null)", js_str(&name)));
                now(json!({}))
            }
            "Runtime.removeBinding" => {
                let name = s("name");
                self.bindings.retain(|n| *n != name);
                now(json!({}))
            }
            "Runtime.getHeapUsage" => now(json!({"usedSize": 0, "totalSize": 0})),
            "Runtime.getIsolateId" => now(json!({"id": self.target_id})),

            // ---- DOM
            "DOM.enable" | "DOM.disable" | "DOM.setInspectedNode" | "DOM.markUndoableState" => now(json!({})),
            "DOM.getDocument" => {
                let depth = p.get("depth").and_then(Value::as_i64).unwrap_or(1);
                now(json!({"root": self.quick(&format!("__jb.cdp.describe(document, {depth})"))?}))
            }
            "DOM.describeNode" => {
                let depth = p.get("depth").and_then(Value::as_i64).unwrap_or(0);
                now(json!({"node": self.quick(&format!("__jb.cdp.describe({}, {depth})", Self::node_expr(p)))?}))
            }
            "DOM.resolveNode" => now(json!({"object": self.quick(&format!("__jb.cdp.remote({}, false)", Self::node_expr(p)))?})),
            "DOM.requestNode" => now(json!({"nodeId": self.quick(&format!("__jb.cdp.nodeId({})", Self::node_expr(p)))?})),
            "DOM.pushNodesByBackendIdsToFrontend" => now(json!({"nodeIds": p.get("backendNodeIds").cloned().unwrap_or(json!([]))})),
            "DOM.querySelector" => now(json!({"nodeId": self.quick(&format!("(function (n) {{ var r = n.querySelector({}); return r ? __jb.cdp.nodeId(r) : 0; }})(__jb.cdp.node({}))", js_str(&s("selector")), json!(p.get("nodeId"))))?})),
            "DOM.querySelectorAll" => now(json!({"nodeIds": self.quick(&format!("Array.from(__jb.cdp.node({}).querySelectorAll({})).map(__jb.cdp.nodeId)", json!(p.get("nodeId")), js_str(&s("selector"))))?})),
            "DOM.getOuterHTML" => now(json!({"outerHTML": self.quick(&format!("(function (n) {{ return n.outerHTML !== undefined ? n.outerHTML : new XMLSerializer().serializeToString(n); }})({})", Self::node_expr(p)))?})),
            "DOM.getAttributes" => now(json!({"attributes": self.quick(&format!("__jb.cdp.describe({}, 0).attributes || []", Self::node_expr(p)))?})),
            "DOM.setAttributeValue" => {
                self.task(&format!("({}.setAttribute({}, {}), null)", Self::node_expr(p), js_str(&s("name")), js_str(&s("value"))))?;
                now(json!({}))
            }
            "DOM.removeAttribute" => {
                self.task(&format!("({}.removeAttribute({}), null)", Self::node_expr(p), js_str(&s("name"))))?;
                now(json!({}))
            }
            "DOM.removeNode" => {
                self.task(&format!("({}.remove(), null)", Self::node_expr(p)))?;
                now(json!({}))
            }
            "DOM.setOuterHTML" => {
                self.task(&format!("({}.outerHTML = {}, null)", Self::node_expr(p), js_str(&s("outerHTML"))))?;
                now(json!({}))
            }
            "DOM.focus" => {
                self.task(&format!("(__jb.user.focus({}), null)", Self::node_expr(p)))?;
                now(json!({}))
            }
            "DOM.getBoxModel" => now(self.quick(&format!("__jb.cdp.boxModel({})", Self::node_expr(p)))?),
            "DOM.getContentQuads" => now(self.quick(&format!("__jb.cdp.contentQuads({})", Self::node_expr(p)))?),
            "DOM.scrollIntoViewIfNeeded" => now(self.quick(&format!("__jb.cdp.scrollIntoView({})", Self::node_expr(p)))?),
            "DOM.getNodeForLocation" => {
                let (x, y) = (p.get("x").and_then(Value::as_f64).unwrap_or(0.0), p.get("y").and_then(Value::as_f64).unwrap_or(0.0));
                let id = self.quick(&format!("__jb.cdp.nodeId(__jb.user.elementAt({x}, {y}))"))?;
                now(json!({"backendNodeId": id, "nodeId": id, "frameId": self.target_id}))
            }
            "DOM.getFrameOwner" => Err("Frame with the given id does not belong to the target.".into()),
            "DOM.setFileInputFiles" => {
                let files = p.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
                let mut list = Vec::new();
                for f in files.iter().filter_map(Value::as_str) {
                    let path = std::path::Path::new(f);
                    let bytes = std::fs::read(path).map_err(|e| format!("cannot read {f}: {e}"))?;
                    list.push(json!({"name": path.file_name().and_then(|n| n.to_str()).unwrap_or("file"), "type": "", "b64": crate::js::webapis::b64(&bytes), "lastModified": 0}));
                }
                self.task(&format!("(__jb.user.upload({}, {}), null)", Self::node_expr(p), Value::Array(list)))?;
                now(json!({}))
            }

            // ---- Input
            "Input.dispatchMouseEvent" => {
                self.task(&format!("__jb.cdp.mouse({p})"))?;
                now(json!({}))
            }
            "Input.dispatchKeyEvent" => {
                self.task(&format!("__jb.cdp.key({p})"))?;
                now(json!({}))
            }
            "Input.insertText" | "Input.imeSetComposition" => {
                self.task(&format!("(__jb.user.insertText({}), null)", js_str(&s("text"))))?;
                now(json!({}))
            }
            "Input.setIgnoreInputEvents" | "Input.setInterceptDrags" | "Input.dispatchTouchEvent" | "Input.dispatchDragEvent" => now(json!({})),

            // ---- Network
            "Network.setUserAgentOverride" | "Emulation.setUserAgentOverride" => {
                let ua = s("userAgent");
                if !ua.is_empty() {
                    let e = &mut self.agent.engine;
                    e.user_agent = ua.clone();
                    e.base_headers.insert("User-Agent".into(), ua.clone());
                    e.session.set_user_agent(&ua);
                    e.session.set_default_headers(e.base_headers.clone());
                }
                now(json!({}))
            }
            "Network.setExtraHTTPHeaders" => {
                if let Some(h) = p.get("headers").and_then(Value::as_object) {
                    let e = &mut self.agent.engine;
                    for (k, v) in h {
                        e.base_headers.insert(k.clone(), v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()));
                    }
                    e.session.set_default_headers(e.base_headers.clone());
                }
                now(json!({}))
            }
            "Network.getCookies" | "Network.getAllCookies" | "Network.setCookie" | "Network.setCookies" | "Network.deleteCookies" | "Network.clearBrowserCookies" | "Storage.getCookies" | "Storage.setCookies" | "Storage.clearCookies" => now(self.cookies(method, p)?),
            "Network.getResponseBody" => Err("No resource with given identifier found".into()),

            // ---- domains accepted without effect
            m if m.ends_with(".enable") || m.ends_with(".disable") => now(json!({})),
            m if m.starts_with("Emulation.") || m.starts_with("Network.") || m.starts_with("Log.") || m.starts_with("Performance.") || m.starts_with("Security.") || m.starts_with("Fetch.") || m.starts_with("Overlay.") || m.starts_with("Target.") || m.starts_with("Debugger.") || m.starts_with("CSS.") || m.starts_with("Audits.") || m.starts_with("ServiceWorker.") || m.starts_with("Inspector.") || m.starts_with("Autofill.") || m.starts_with("Browser.") => {
                if m == "Performance.getMetrics" {
                    return now(json!({"metrics": []}));
                }
                now(json!({}))
            }
            other => Err(format!("'{other}' wasn't found")),
        }
    }

    fn screenshot(&mut self, p: &Value) -> Result<Value, String> {
        let clip = p.get("clip").filter(|c| c.is_object());
        let rect = match clip {
            Some(c) => {
                let f = |k: &str| c.get(k).and_then(Value::as_f64).unwrap_or(0.0);
                crate::layout::Rect { x: f("x"), y: f("y"), width: f("width"), height: f("height"), ..Default::default() }
            }
            None => {
                let v = self.agent.engine.js_engine.eval_js("({ x: globalThis.scrollX || 0, y: globalThis.scrollY || 0, w: globalThis.innerWidth || 1280, h: globalThis.innerHeight || 720 })");
                let f = |k: &str, d: f64| v.get(k).and_then(Value::as_f64).unwrap_or(d);
                crate::layout::Rect { x: f("x", 0.0), y: f("y", 0.0), width: f("w", 1280.0), height: f("h", 720.0), ..Default::default() }
            }
        };
        let full = clip.is_some();
        self.agent.sync_dom();
        let png = self.agent.screenshot_png(full, Some(rect))?;
        let format = p.get("format").and_then(Value::as_str).unwrap_or("png");
        let bytes = if format == "jpeg" { to_jpeg(&png, p.get("quality").and_then(Value::as_u64).unwrap_or(80) as u8)? } else { png };
        Ok(json!({"data": crate::js::webapis::b64(&bytes)}))
    }

    fn cookies(&mut self, method: &str, p: &Value) -> Result<Value, String> {
        let all = || -> Vec<Value> { self.agent.get_cookies()["cookies"].as_array().cloned().unwrap_or_default() };
        match method {
            "Network.getCookies" | "Network.getAllCookies" | "Storage.getCookies" => {
                let cookies: Vec<Value> = all()
                    .into_iter()
                    .map(|c| {
                        let (name, value) = (c["name"].as_str().unwrap_or(""), c["value"].as_str().unwrap_or(""));
                        json!({
                            "name": name, "value": value, "domain": c["domain"], "path": c["path"], "expires": -1, "size": name.len() + value.len(),
                            "httpOnly": c["http_only"], "secure": c["secure"], "session": true, "priority": "Medium", "sameParty": false,
                            "sourceScheme": if c["secure"].as_bool().unwrap_or(false) { "Secure" } else { "NonSecure" }, "sourcePort": 443,
                        })
                    })
                    .collect();
                Ok(json!({"cookies": cookies}))
            }
            "Network.setCookie" => {
                set_cdp_cookie(&self.agent, p, self.agent.current_url.as_deref());
                Ok(json!({"success": true}))
            }
            "Network.setCookies" | "Storage.setCookies" => {
                for c in p.get("cookies").and_then(Value::as_array).cloned().unwrap_or_default() {
                    set_cdp_cookie(&self.agent, &c, self.agent.current_url.as_deref());
                }
                Ok(json!({}))
            }
            "Network.deleteCookies" => {
                let name = p.get("name").and_then(Value::as_str).unwrap_or("");
                for c in all() {
                    if c["name"].as_str() != Some(name) {
                        continue;
                    }
                    if let Some(d) = p.get("domain").and_then(Value::as_str) {
                        if c["domain"].as_str().map(|cd| cd.trim_start_matches('.')) != Some(d.trim_start_matches('.')) {
                            continue;
                        }
                    }
                    expire_cookie(&self.agent, &c);
                }
                Ok(json!({}))
            }
            _ => {
                for c in all() {
                    expire_cookie(&self.agent, &c);
                }
                Ok(json!({}))
            }
        }
    }
}

enum Reply {
    Now(Value),
    Pending(u64),
}

fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn cookie_url(domain: &str, path: &str, secure: bool) -> String {
    format!("{}://{}{}", if secure { "https" } else { "http" }, domain.trim_start_matches('.'), if path.is_empty() { "/" } else { path })
}

fn set_cdp_cookie(agent: &AgentSdk, c: &Value, page_url: Option<&str>) {
    let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let secure = c.get("secure").and_then(Value::as_bool).unwrap_or(false);
    let url = match (s("url"), s("domain")) {
        (u, _) if !u.is_empty() => u,
        (_, d) if !d.is_empty() => cookie_url(&d, &s("path"), secure),
        _ => page_url.unwrap_or("").to_string(),
    };
    let mut cookie = format!("{}={}", s("name"), s("value"));
    if !s("domain").is_empty() {
        cookie.push_str(&format!("; Domain={}", s("domain")));
    }
    cookie.push_str(&format!("; Path={}", if s("path").is_empty() { "/".to_string() } else { s("path") }));
    if secure {
        cookie.push_str("; Secure");
    }
    if c.get("httpOnly").and_then(Value::as_bool).unwrap_or(false) {
        cookie.push_str("; HttpOnly");
    }
    if let Some(exp) = c.get("expires").and_then(Value::as_f64).filter(|e| *e > 0.0) {
        cookie.push_str(&format!("; Max-Age={}", (exp - now_secs()).max(0.0) as i64));
    }
    if !s("sameSite").is_empty() {
        cookie.push_str(&format!("; SameSite={}", s("sameSite")));
    }
    agent.set_cookie(&url, &cookie);
}

fn expire_cookie(agent: &AgentSdk, c: &Value) {
    let (name, domain, path) = (c["name"].as_str().unwrap_or(""), c["domain"].as_str().unwrap_or(""), c["path"].as_str().unwrap_or("/"));
    let secure = c["secure"].as_bool().unwrap_or(false);
    let host_only = !domain.starts_with('.');
    let attrs = if host_only { format!("{name}=; Path={path}; Max-Age=0") } else { format!("{name}=; Domain={domain}; Path={path}; Max-Age=0") };
    agent.set_cookie(&cookie_url(domain, path, secure), &format!("{attrs}{}", if secure { "; Secure" } else { "" }));
}

#[cfg(feature = "images")]
fn to_jpeg(png: &[u8], quality: u8) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(png).map_err(|e| e.to_string())?.to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100)).encode_image(&img).map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(not(feature = "images"))]
fn to_jpeg(png: &[u8], _quality: u8) -> Result<Vec<u8>, String> {
    Ok(png.to_vec())
}
