//! Persistent browser sessions for the agent-style CLI commands (`open`, `click`, `fill`, ...).
//!
//! Each command is a separate process, but they all drive one live page: the first command starts
//! a background session server (`julia-browser __serve --session <name>`) that owns an
//! [`AgentSdk`] — page, JavaScript realm, cookies, focus and held keys — and later commands send it
//! one JSON request each over a localhost TCP socket. A session file under
//! `<local data>/julia-browser/sessions/<name>.json` records the server's port, pid and a random
//! token the client must present. `close` stops the server; an idle server exits after
//! `JB_SESSION_IDLE_SECS` (default 30 minutes).

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::agent::AgentSdk;
use crate::js::JsConfig;

/// Script budget of the catch-up run before a read-only observation (`eval` with settle=false).
const CATCH_UP_BUDGET_MS: u64 = 1500;

// ---------------------------------------------------------------- session files

/// Where session files and server logs live.
pub fn sessions_dir() -> PathBuf {
    dirs::data_local_dir().map(|d| d.join("julia-browser")).unwrap_or_else(|| PathBuf::from(".browser_cache")).join("sessions")
}

fn sanitize(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    if s.is_empty() { "default".into() } else { s }
}

fn session_file(name: &str) -> PathBuf {
    sessions_dir().join(format!("{}.json", sanitize(name)))
}

/// A running session server.
#[derive(Clone, Debug)]
pub struct SessionInfo {
    pub name: String,
    pub port: u16,
    pub pid: u32,
    pub token: String,
}

fn parse_info(name: &str, text: &str) -> Option<SessionInfo> {
    let v: Value = serde_json::from_str(text).ok()?;
    Some(SessionInfo {
        name: name.to_string(),
        port: v.get("port")?.as_u64()? as u16,
        pid: v.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32,
        token: v.get("token")?.as_str()?.to_string(),
    })
}

pub fn read_info(name: &str) -> Option<SessionInfo> {
    let text = std::fs::read_to_string(session_file(name)).ok()?;
    parse_info(name, &text)
}

fn write_info(info: &SessionInfo) -> std::io::Result<()> {
    std::fs::create_dir_all(sessions_dir())?;
    let tmp = session_file(&info.name).with_extension("json.tmp");
    std::fs::write(&tmp, json!({"port": info.port, "pid": info.pid, "token": info.token}).to_string())?;
    std::fs::rename(&tmp, session_file(&info.name))
}

fn remove_info(name: &str) {
    let _ = std::fs::remove_file(session_file(name));
}

/// Every session that has a session file (running or stale).
pub fn list_sessions() -> Vec<SessionInfo> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(sessions_dir()) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            if let Some(info) = std::fs::read_to_string(&path).ok().and_then(|t| parse_info(&name, &t)) {
                out.push(info);
            }
        }
    }
    out
}

/// The session name from `--session`, else `JB_SESSION`, else "default".
pub fn resolve_name(flag: &str) -> String {
    if !flag.is_empty() {
        return flag.to_string();
    }
    std::env::var("JB_SESSION").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "default".to_string())
}

// ---------------------------------------------------------------- client

enum SendError {
    /// Nothing answered on the port (stale session file).
    Unreachable(String),
    /// The server answered but the exchange failed.
    Failed(String),
}

fn send(info: &SessionInfo, cmd: &str, args: &Value) -> Result<Value, SendError> {
    let addr = SocketAddr::from(([127, 0, 0, 1], info.port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|e| SendError::Unreachable(e.to_string()))?;
    // Commands can load pages and run their scripts; allow them time.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(900)));
    let req = json!({"token": info.token, "cmd": cmd, "args": args});
    writeln!(stream, "{req}").and_then(|_| stream.flush()).map_err(|e| SendError::Failed(e.to_string()))?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|e| SendError::Failed(e.to_string()))?;
    if line.trim().is_empty() {
        return Err(SendError::Failed("the browser session closed the connection".into()));
    }
    serde_json::from_str(&line).map_err(|e| SendError::Failed(format!("bad response from the browser session: {e}")))
}

/// Run `cmd` in session `name`, starting the session server first when none is running (unless
/// `autostart` is off). `spawn_args` are the browser options passed to a newly started server.
/// Returns the server's JSON response and whether a new server was started.
pub fn request(name: &str, spawn_args: &[String], cmd: &str, args: Value, autostart: bool) -> Result<(Value, bool), String> {
    if let Some(info) = read_info(name) {
        match send(&info, cmd, &args) {
            Ok(v) => return Ok((v, false)),
            Err(SendError::Failed(e)) => return Err(e),
            Err(SendError::Unreachable(_)) => remove_info(name), // stale: the server is gone
        }
    }
    if !autostart {
        return Err(format!("no browser session '{name}' is running (start one with `open`)"));
    }
    let info = spawn(name, spawn_args)?;
    match send(&info, cmd, &args) {
        Ok(v) => Ok((v, true)),
        Err(SendError::Failed(e)) | Err(SendError::Unreachable(e)) => Err(e),
    }
}

fn spawn(name: &str, extra_args: &[String]) -> Result<SessionInfo, String> {
    use std::process::{Command, Stdio};
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate the browser executable: {e}"))?;
    std::fs::create_dir_all(sessions_dir()).map_err(|e| format!("cannot create {}: {e}", sessions_dir().display()))?;
    let log_path = sessions_dir().join(format!("{}.log", sanitize(name)));
    let log = std::fs::File::create(&log_path).map_err(|e| format!("cannot create {}: {e}", log_path.display()))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.arg("__serve").arg("--session").arg(name).args(extra_args).stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(log_err));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    let mut child = cmd.spawn().map_err(|e| format!("cannot start the browser session: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(info) = read_info(name) {
            if info.pid == child.id() && matches!(send(&info, "ping", &json!({})), Ok(_)) {
                return Ok(info);
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            let tail = std::fs::read_to_string(&log_path).unwrap_or_default();
            let tail: String = tail.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(format!("the browser session exited during startup ({status}){}", if tail.is_empty() { String::new() } else { format!(":\n{tail}") }));
        }
        if Instant::now() > deadline {
            return Err(format!("the browser session did not start within 60 s (see {})", log_path.display()));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Stop session `name`. Returns false when no session was running.
pub fn close(name: &str) -> bool {
    let Some(info) = read_info(name) else { return false };
    let running = send(&info, "close", &json!({})).is_ok();
    remove_info(name);
    running
}

/// Stop every session; returns how many were running.
pub fn close_all() -> usize {
    list_sessions().iter().filter(|s| close(&s.name)).count()
}

/// Point session `name` at the session server listening on `port`.
pub fn connect(name: &str, port: u16) -> Result<SessionInfo, String> {
    let found = list_sessions().into_iter().find(|s| s.port == port);
    let Some(target) = found else {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        return Err(match TcpStream::connect_timeout(&addr, Duration::from_secs(2)) {
            Ok(_) => format!("port {port} is not a julia-browser session (connecting to other browsers over CDP is not supported)"),
            Err(_) => format!("nothing is listening on port {port}"),
        });
    };
    let info = SessionInfo { name: name.to_string(), ..target };
    send(&info, "ping", &json!({})).map_err(|e| match e {
        SendError::Unreachable(e) | SendError::Failed(e) => format!("the session on port {port} does not answer: {e}"),
    })?;
    write_info(&info).map_err(|e| format!("cannot write the session file: {e}"))?;
    Ok(info)
}

// ---------------------------------------------------------------- server

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn make_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let part = |salt: u64| {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(stamp);
        h.write_u32(std::process::id());
        h.write_u64(salt);
        h.finish()
    };
    format!("{:016x}{:016x}", part(1), part(2))
}

/// Run the session server for `name` until `close` or the idle timeout. Never returns normally.
pub fn serve(name: &str, js: JsConfig, execute_js: bool) -> i32 {
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cannot listen on localhost: {e}");
            return 1;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let token = make_token();
    let info = SessionInfo { name: name.to_string(), port, pid: std::process::id(), token: token.clone() };
    if let Err(e) = write_info(&info) {
        eprintln!("cannot write the session file: {e}");
        return 1;
    }

    let last_activity = Arc::new(AtomicU64::new(now_secs()));
    let idle = std::env::var("JB_SESSION_IDLE_SECS").ok().and_then(|s| s.parse::<u64>().ok()).unwrap_or(30 * 60);
    {
        let last = last_activity.clone();
        let name = name.to_string();
        let pid = info.pid;
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(15));
            if now_secs().saturating_sub(last.load(Ordering::Relaxed)) > idle {
                if read_info(&name).map_or(false, |i| i.pid == pid) {
                    remove_info(&name);
                }
                crate::js::runtime::exit_process(0);
            }
        });
    }

    let mut session = Session::new(js, execute_js);
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        last_activity.store(now_secs(), Ordering::Relaxed);
        let close = handle(stream, &mut session, &token);
        last_activity.store(now_secs(), Ordering::Relaxed);
        if close {
            if read_info(name).map_or(false, |i| i.pid == info.pid) {
                remove_info(name);
            }
            crate::js::runtime::exit_process(0);
        }
    }
    0
}

/// Serve one request; returns true when the session should close.
fn handle(mut stream: TcpStream, session: &mut Session, token: &str) -> bool {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut line = String::new();
    if BufReader::new(&stream).read_line(&mut line).is_err() {
        return false;
    }
    let req: Value = serde_json::from_str(line.trim()).unwrap_or(Value::Null);
    let (resp, close) = if req.get("token").and_then(Value::as_str) != Some(token) {
        (fail("invalid session token"), false)
    } else {
        let cmd = req.get("cmd").and_then(Value::as_str).unwrap_or("");
        let args = req.get("args").cloned().unwrap_or(json!({}));
        match cmd {
            "ping" => (json!({"ok": true, "message": "pong"}), false),
            "close" => (json!({"ok": true, "message": "✓ Browser closed"}), true),
            _ => (session.exec(cmd, &args), false),
        }
    };
    let _ = writeln!(stream, "{resp}");
    let _ = stream.flush();
    close
}

fn fail(msg: impl Into<String>) -> Value {
    json!({"ok": false, "error": msg.into()})
}

fn ok(message: impl Into<String>, data: Value) -> Value {
    json!({"ok": true, "message": message.into(), "data": data})
}

/// The document navigation a script run started (`AgentSdk::execute_javascript`'s result).
fn first_navigation(r: &Value) -> Option<String> {
    let url = r["navigations"].as_array()?.first()?["url"].as_str()?.to_string();
    (!url.is_empty() && !url.starts_with("javascript:")).then_some(url)
}

fn s<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).filter(|v| !v.is_empty())
}

fn js_str(v: &str) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "\"\"".into())
}

/// The live browser of a session.
pub struct Session {
    agent: AgentSdk,
    tabs: Vec<String>,
    active: usize,
    #[cfg(feature = "images")]
    last_shot: Option<(image::RgbaImage, PathBuf)>,
    /// When the last command ended: page time a read-only observation catches up on.
    last_run: std::time::Instant,
}

impl Session {
    pub fn new(js: JsConfig, execute_js: bool) -> Self {
        Self::with_user_agent(js, execute_js, None)
    }

    /// A session whose requests send `user_agent` (None: the default one).
    pub fn with_user_agent(mut js: JsConfig, execute_js: bool, user_agent: Option<&str>) -> Self {
        // actions settle for a couple of seconds of page time (JB_SETTLE_MS overrides)
        if js.action_settle_ms.is_none() {
            js.action_settle_ms = Some(std::env::var("JB_SETTLE_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(2500));
        }
        let mut agent = AgentSdk::with_js_config(user_agent, 30, js);
        agent.engine.execute_js = execute_js;
        agent.skip_action_content = true;
        agent.open_blank();
        Session {
            agent,
            tabs: vec!["about:blank".into()],
            active: 0,
            #[cfg(feature = "images")]
            last_shot: None,
            last_run: std::time::Instant::now(),
        }
    }

    pub fn exec(&mut self, cmd: &str, args: &Value) -> Value {
        self.advance_clock();
        let result = match cmd {
            "open" => self.open(s(args, "url")),
            "read" => self.read(s(args, "url")),
            "click" => self.click(args),
            "dblclick" | "focus" | "hover" | "check" | "uncheck" => match s(args, "selector") {
                Some(sel) => self.act(cmd, sel, None),
                None => fail(format!("{cmd} needs a selector")),
            },
            "type" | "fill" => match s(args, "selector") {
                Some(sel) => self.act(cmd, sel, Some(args.get("text").and_then(Value::as_str).unwrap_or(""))),
                None => fail(format!("{cmd} needs a selector")),
            },
            "press" => match s(args, "key") {
                Some(key) => self.act("press", "", Some(key)),
                None => fail("press needs a key"),
            },
            "select" => match s(args, "selector") {
                Some(sel) => self.act("select", sel, Some(args.get("value").and_then(Value::as_str).unwrap_or(""))),
                None => fail("select needs a selector"),
            },
            "scrollintoview" => match s(args, "selector") {
                Some(sel) => self.act("scroll", sel, None),
                None => fail("scrollintoview needs a selector"),
            },
            "keyboard" => {
                let text = args.get("text").and_then(Value::as_str).unwrap_or("");
                match s(args, "mode") {
                    Some("type") => self.script(&format!("__jb.user.keyboardType({})", js_str(text)), "keyboard type", ""),
                    Some("inserttext") => self.script(&format!("__jb.user.insertText({})", js_str(text)), "keyboard inserttext", ""),
                    _ => fail("keyboard needs `type <text>` or `inserttext <text>`"),
                }
            }
            "keydown" | "keyup" => match s(args, "key") {
                Some(key) => {
                    let f = if cmd == "keydown" { "keyDown" } else { "keyUp" };
                    self.script(&format!("(function () {{ __jb.user.{f}(__jb.user.normalizeKey({})); return __jb.hostJson({{ ok: true }}); }})()", js_str(key)), cmd, key)
                }
                None => fail(format!("{cmd} needs a key")),
            },
            "scroll" => {
                let dir = s(args, "direction").unwrap_or("down");
                let px = args.get("px").and_then(Value::as_u64).unwrap_or(300);
                let sel = s(args, "selector").map(js_str).unwrap_or_else(|| "null".into());
                self.script(&format!("__jb.user.scrollDir({}, {px}, {sel})", js_str(dir)), "scroll", dir)
            }
            "drag" => match (s(args, "source"), s(args, "target")) {
                (Some(a), Some(b)) => self.script(&format!("__jb.user.drag(__jb.user.find({}), __jb.user.find({}))", js_str(a), js_str(b)), "drag", a),
                _ => fail("drag needs a source and a target"),
            },
            "click_at" | "clickat" => match (args.get("x").and_then(Value::as_f64), args.get("y").and_then(Value::as_f64)) {
                (Some(x), Some(y)) => {
                    let n = args.get("count").and_then(Value::as_u64).unwrap_or(1).clamp(1, 3);
                    self.script(&format!("__jb.user.clickAt({x}, {y}, {n})"), "click_at", &format!("{x},{y}"))
                }
                _ => fail("click_at needs x and y (viewport CSS pixels)"),
            },
            "drag_at" | "dragat" => {
                let f = |k: &str| args.get(k).and_then(Value::as_f64);
                match (f("x1"), f("y1"), f("x2"), f("y2")) {
                    (Some(x1), Some(y1), Some(x2), Some(y2)) => self.script(&format!("__jb.user.dragAt({x1}, {y1}, {x2}, {y2})"), "drag_at", &format!("{x1},{y1} -> {x2},{y2}")),
                    _ => fail("drag_at needs x1, y1, x2, y2 (viewport CSS pixels)"),
                }
            }
            "upload" => self.upload(args),
            "login" => self.vault_fill("login", args),
            "otp" => self.vault_fill("otp", args),
            "new_password" | "newpassword" => self.vault_fill("new", args),
            "vault_scope" => {
                let sites: Option<Vec<String>> = args.get("sites").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect());
                crate::vault::set_scope(sites.clone().filter(|s| !s.is_empty()));
                match crate::vault::scope() {
                    Some(s) => ok(format!("✓ Vault scope: {}", s.join(", ")), json!({"sites": s})),
                    None => ok("✓ Vault scope: every allowed site", json!({"sites": null})),
                }
            }
            "screenshot" => self.screenshot(args),
            "pdf" => self.pdf(args),
            "eval" => self.eval(args.get("code").and_then(Value::as_str).unwrap_or(""), args.get("settle").and_then(Value::as_bool).unwrap_or(true)),
            "wait" => self.wait(s(args, "target").unwrap_or(""), args.get("timeout").and_then(Value::as_u64).unwrap_or(10_000)),
            "back" => self.traverse(true),
            "forward" => self.traverse(false),
            other => fail(format!("unknown command {other:?}")),
        };
        self.last_run = std::time::Instant::now();
        result
    }

    /// The real time since the previous command (the agent was thinking) passes on the page
    /// clock too, at most 3 s per command; the timers it makes due run in the command's settle
    /// (overdue intervals fire once). Without it the clock only moved to timers that fired.
    fn advance_clock(&mut self) {
        let url = self.agent.current_url.clone().unwrap_or_default();
        if !self.agent.engine.js_engine.is_live(&url) {
            return;
        }
        let behind = (self.last_run.elapsed().as_millis() as u64).min(3000);
        if behind >= 50 {
            let _ = self.agent.engine.js_engine.eval_js(&format!("(globalThis.__jb && (__jb.clock += {behind}), null)"));
            self.last_run = std::time::Instant::now();
        }
    }

    /// Before a read-only observation: responses that arrived since the last command (the agent
    /// was thinking) are delivered and the page runs the timers of the time that passed (at most
    /// 1 s), as a browser would have meanwhile. Without it a search answered after the action's
    /// settle stayed "Loading..." in every observation (WebMD, UPS locator, student.com).
    fn catch_up(&mut self) {
        let url = self.agent.current_url.clone().unwrap_or_default();
        if !self.agent.engine.js_engine.is_live(&url) {
            return;
        }
        let behind = (self.last_run.elapsed().as_millis() as u64).min(1000);
        // pending background responses, or timers that would have fired meanwhile (a load that
        // ran out of script budget leaves the app's first render queued: medicare.gov results)
        let pending = self.agent.engine.js_engine.eval_js(&format!("(function () {{ var tj = typeof __jb.topJb === 'function' ? __jb.topJb() : __jb; if ((tj.asyncFetchCount || 0) > 0) return true; var lim = __jb.clock + {behind}; return __jb.timers.some(function (t) {{ return t.due <= lim; }}); }})()"));
        if pending != json!(true) {
            return;
        }
        let _ = self.agent.engine.js_engine.eval_js(&format!("(__jb.clock += {behind}, null)"));
        // Bounded: a load that ran out of budget can leave seconds of deferred work queued (FedEx: 20
        // inserted scripts, 6-7 s), and this runs before every read-only observation. Loops stop
        // between tasks once the budget is spent; the rest runs at the next action.
        let settle = self.agent.engine.js_engine.config.action_settle_ms;
        let budget = self.agent.engine.js_engine.config.time_budget_ms;
        self.agent.engine.js_engine.config.action_settle_ms = Some(0);
        self.agent.engine.js_engine.config.time_budget_ms = budget.min(CATCH_UP_BUDGET_MS);
        let r = self.agent.execute_javascript("void 0");
        self.agent.engine.js_engine.config.action_settle_ms = settle;
        self.agent.engine.js_engine.config.time_budget_ms = budget;
        if let Some(nav) = first_navigation(&r) {
            let _ = self.navigate(&nav);
        }
    }

    // ---- navigation

    fn page_line(&self) -> String {
        let url = self.agent.current_url.clone().unwrap_or_else(|| "about:blank".into());
        let title = self.agent.current_title();
        let title = if title == "No title" { String::new() } else { title };
        if title.is_empty() { url } else { format!("{title}\n  {url}") }
    }

    fn navigate(&mut self, url: &str) -> Result<(), String> {
        let r = if url == "about:blank" { self.agent.open_blank() } else { self.agent.open_website(url) };
        if r["success"].as_bool().unwrap_or(false) {
            // Finish work the load left queued (frame navigations are zero-delay tasks) now, so the
            // next command does not pay for it.
            if url != "about:blank" && self.agent.engine.js_engine.eval_js("__jb.timers.length > 0") == json!(true) {
                let mut r = self.agent.execute_javascript("void 0");
                // a navigation the page started meanwhile (a redirect timer) is followed
                for _ in 0..3 {
                    let Some(nav) = first_navigation(&r) else { break };
                    if !self.agent.open_website(&nav)["success"].as_bool().unwrap_or(false) {
                        break;
                    }
                    if self.agent.engine.js_engine.eval_js("__jb.timers.length > 0") != json!(true) {
                        break;
                    }
                    r = self.agent.execute_javascript("void 0");
                }
            }
            let now = self.agent.current_url.clone().unwrap_or_else(|| url.to_string());
            self.tabs[self.active] = now;
            Ok(())
        } else {
            Err(r["error"].as_str().unwrap_or("navigation failed").to_string())
        }
    }

    fn open(&mut self, url: Option<&str>) -> Value {
        match url {
            None => ok(format!("✓ Browser ready: {}", self.page_line()), json!({"url": self.agent.current_url})),
            Some(u) => match {
                // typed in: no initiating document (no Referer, Sec-Fetch-Site: none)
                self.agent.engine.nav_initiator = None;
                self.navigate(u)
            } {
                Ok(()) => ok(format!("✓ {}", self.page_line()), json!({"url": self.agent.current_url})),
                Err(e) => fail(format!("could not open {u}: {e}")),
            },
        }
    }

    fn read(&mut self, url: Option<&str>) -> Value {
        if let Some(u) = url {
            if let Err(e) = self.navigate(u) {
                return fail(format!("could not open {u}: {e}"));
            }
        }
        let r = self.agent.readable_text();
        if !r["success"].as_bool().unwrap_or(false) {
            return fail(r["error"].as_str().unwrap_or("no page"));
        }
        ok(r["content"].as_str().unwrap_or("").to_string(), r)
    }

    // ---- element actions

    /// Format an action result from [`AgentSdk::act`] / [`AgentSdk::run_user_script`].
    fn finish(&mut self, verb: &str, r: Value) -> Value {
        if !r["success"].as_bool().unwrap_or(false) {
            return fail(r["error"].as_str().unwrap_or("the action failed"));
        }
        // The action loaded another page (link, form submission, location change).
        if r.get("element").is_none() && r.get("url").is_some() {
            if let Some(u) = self.agent.current_url.clone() {
                self.tabs[self.active] = u;
            }
            return ok(format!("✓ {verb} → {}", self.page_line()), r);
        }
        let el = match r.get("element") {
            Some(Value::String(d)) => format!(" {d}"),
            Some(Value::Null) | None => String::new(),
            Some(other) => format!(" {}", describe(other)),
        };
        ok(format!("✓ {verb}{el}"), r)
    }

    fn act(&mut self, action: &str, sel: &str, value: Option<&str>) -> Value {
        let r = self.agent.act(action, sel, value);
        let verb = match action {
            "click" => "Clicked",
            "dblclick" => "Double-clicked",
            "focus" => "Focused",
            "hover" => "Hovered",
            "check" => "Checked",
            "uncheck" => "Unchecked",
            "type" => "Typed into",
            "fill" => "Filled",
            "press" => "Pressed",
            "select" => "Selected in",
            "scroll" => "Scrolled into view",
            other => other,
        };
        let verb = if action == "press" { format!("Pressed {}", value.unwrap_or("")) } else { verb.to_string() };
        self.finish(&verb, r)
    }

    /// `wait <ms>`: let the page run (timers, network) for that long; `wait <selector>`: until an
    /// element matches, checking after each settle period, for at most `timeout_ms` of page time.
    fn wait(&mut self, target: &str, timeout_ms: u64) -> Value {
        // Each live script lets the page settle for this much page time afterwards.
        const SETTLE_MS: u64 = 2500;
        if target.is_empty() {
            return fail("wait needs a selector or a number of milliseconds");
        }
        if let Ok(ms) = target.parse::<u64>() {
            for _ in 0..ms.div_ceil(SETTLE_MS).max(1) {
                let r = self.agent.run_user_script("__jb.hostJson({ ok: true })", "wait", target);
                if !r["success"].as_bool().unwrap_or(false) {
                    return self.finish("wait", r);
                }
            }
            return json!({"ok": true, "message": format!("✓ Waited {ms} ms")});
        }
        let mut last = String::new();
        for _ in 0..timeout_ms.div_ceil(SETTLE_MS).max(1) {
            let r = self.agent.act("exists", target, None);
            if r["success"].as_bool().unwrap_or(false) {
                return self.finish("Found", r);
            }
            last = r["error"].as_str().unwrap_or("").to_string();
            if !last.starts_with("No element matches") {
                break; // not a missing element (no live page, bad selector): waiting will not help
            }
        }
        fail(format!("{target} did not appear within {timeout_ms} ms ({last})"))
    }

    fn script(&mut self, script: &str, label: &str, target: &str) -> Value {
        let r = self.agent.run_user_script(script, label, target);
        if r["success"].as_bool().unwrap_or(false) {
            let report = r.get("report").cloned().unwrap_or(Value::Null);
            let extra = match label {
                "scroll" => match (report.get("x"), report.get("y")) {
                    (Some(x), Some(y)) if report.get("canceled").is_none() => format!(" (now at {x}, {y})"),
                    _ if report.get("canceled").is_some() => " (canceled by the page)".into(),
                    _ => String::new(),
                },
                "drag" => match report.get("dropped").and_then(Value::as_bool) {
                    Some(true) => " (dropped)".into(),
                    Some(false) => " (the target did not accept the drop)".into(),
                    None => String::new(),
                },
                _ => String::new(),
            };
            let verb = match label {
                "keyboard type" => "Typed with the keyboard".to_string(),
                "keyboard inserttext" => "Inserted text".to_string(),
                "keydown" => format!("Holding {target}"),
                "keyup" => format!("Released {target}"),
                "scroll" => format!("Scrolled {target}"),
                "drag" => "Dragged".to_string(),
                "click_at" => format!("Clicked at {target}"),
                "drag_at" => format!("Dragged {target}"),
                "upload" => "Uploaded to".to_string(),
                other => other.to_string(),
            };
            let mut out = self.finish(&verb, r);
            if let Some(m) = out.get("message").and_then(Value::as_str).map(|m| format!("{m}{extra}")) {
                out["message"] = json!(m);
            }
            return out;
        }
        self.finish(label, r)
    }

    fn click(&mut self, args: &Value) -> Value {
        let Some(sel) = s(args, "selector") else { return fail("click needs a selector") };
        if !args.get("new_tab").and_then(Value::as_bool).unwrap_or(false) {
            return self.act("click", sel, None);
        }
        // --new-tab: open the element's link target in a new tab
        let probe = format!(
            "(function () {{ var el = __jb.user.find({}); if (!el) return __jb.hostJson({{ error: 'No element matches ' + {} }}); var a = el.closest ? el.closest('a[href], area[href]') : null; return __jb.hostJson(a ? {{ ok: true, href: a.href }} : {{ error: 'The element is not a link, so it cannot open in a new tab' }}); }})()",
            js_str(sel),
            js_str(&js_str(sel))
        );
        let r = self.agent.run_user_script(&probe, "click", sel);
        let href = r.get("report").and_then(|rep| rep.get("href")).and_then(Value::as_str).map(str::to_string);
        let Some(href) = href else { return fail(r["error"].as_str().unwrap_or("could not read the link")) };
        self.tabs.push(href.clone());
        self.active = self.tabs.len() - 1;
        match self.navigate(&href) {
            Ok(()) => ok(format!("✓ Opened in new tab {}: {}", self.active + 1, self.page_line()), json!({"url": self.agent.current_url, "tab": self.active + 1, "tabs": self.tabs})),
            Err(e) => fail(format!("could not open {href}: {e}")),
        }
    }

    fn upload(&mut self, args: &Value) -> Value {
        let Some(sel) = s(args, "selector") else { return fail("upload needs a selector") };
        let paths: Vec<String> = args.get("files").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if paths.is_empty() {
            return fail("upload needs at least one file");
        }
        let mut files = Vec::new();
        for p in &paths {
            let path = Path::new(p);
            let bytes = match std::fs::read(path) {
                Ok(b) => b,
                Err(e) => return fail(format!("cannot read {p}: {e}")),
            };
            let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            files.push(json!({
                "name": path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
                "type": mime_for(path),
                "b64": crate::js::webapis::b64(&bytes),
                "lastModified": modified,
            }));
        }
        let script = format!("__jb.user.upload(__jb.user.find({}), {})", js_str(sel), Value::Array(files));
        self.script(&script, "upload", sel)
    }

    // ---- vault

    /// `login` / `otp` / `new_password`: find the sign-in fields, look up the credential for the
    /// origin of the frame they are in (site policy + audit in src/vault.rs), and type it in inside
    /// the engine. The result names the filled fields and the account, never a secret.
    fn vault_fill(&mut self, kind: &str, args: &Value) -> Value {
        let reason = s(args, "reason").unwrap_or("").trim().to_string();
        if reason.is_empty() {
            return fail("the vault needs a reason for using a credential (`reason`)");
        }
        let r = self.agent.run_user_script(&format!("__jb.user.vaultFind({})", js_str(kind)), "vault", "");
        if !r["success"].as_bool().unwrap_or(false) {
            return fail(r["error"].as_str().unwrap_or("could not search the page for sign-in fields"));
        }
        let found = r.get("report").cloned().unwrap_or(Value::Null);
        let origin = found["origin"].as_str().unwrap_or("");
        let host = match url::Url::parse(origin) {
            Ok(u) if matches!(u.scheme(), "https" | "http") => u.host_str().unwrap_or("").trim_start_matches("www.").to_string(),
            _ => return fail(format!("the sign-in fields are in a frame without a web origin ({origin})")),
        };
        if kind == "login" && url::Url::parse(origin).map(|u| u.scheme() == "http").unwrap_or(false) && !matches!(host.as_str(), "localhost" | "127.0.0.1") {
            return fail(format!("the vault does not fill passwords over plain http ({origin})"));
        }
        let (values, account) = match crate::vault::secrets_for(kind, &host, s(args, "account"), s(args, "username"), &reason) {
            Ok(v) => v,
            Err(e) => return fail(e),
        };
        let r = self.agent.run_user_script(&format!("__jb.user.vaultFill({values})"), "vault", "");
        drop(values);
        if !r["success"].as_bool().unwrap_or(false) {
            return fail(r["error"].as_str().unwrap_or("could not fill the sign-in fields"));
        }
        if r.get("element").is_none() && r.get("url").is_some() {
            if let Some(u) = self.agent.current_url.clone() {
                self.tabs[self.active] = u;
            }
        }
        let filled: Vec<String> = r.pointer("/report/filled").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let what = if filled.is_empty() { "the sign-in fields".to_string() } else { filled.join(", ") };
        let verb = if kind == "new" { "Generated, saved and filled" } else { "Filled" };
        ok(format!("✓ {verb} {what} for {account} on {host} from the vault (the agent does not see the secret)"), json!({"site": host, "account": account, "filled": filled, "content": r.get("content").cloned().unwrap_or(Value::Null)}))
    }

    // ---- eval

    fn eval(&mut self, code: &str, settle: bool) -> Value {
        if code.trim().is_empty() {
            return fail("eval needs JavaScript code");
        }
        // settle=false: read the live page as it is, without running its timers and network
        // afterwards (an observation after an action that already settled). Statements, errors
        // and promises take the normal path.
        if !settle {
            self.catch_up();
            // the observation's first layout query rebuilds (incrementally) instead of reusing the
            // build made before the action's own DOM changes
            self.agent.engine.js_engine.eval_js("(__jb.layoutState && (__jb.layoutState.builtAt = 0), 0)");
            let url = self.agent.current_url.clone().unwrap_or_default();
            if self.agent.engine.js_engine.is_live(&url) {
                let v = self.agent.engine.js_engine.eval_js(&format!("(function () {{ var v = ({code}\n); return v && typeof v.then === 'function' ? {{ __jbPromise: true }} : v; }})()"));
                let fallback = v.get("__jbPromise").is_some() || v.get("__error").is_some() || v.get("error").is_some();
                if !fallback {
                    let text = match &v {
                        Value::String(s) => s.clone(),
                        Value::Null => "null".to_string(),
                        other => serde_json::to_string_pretty(other).unwrap_or_default(),
                    };
                    return json!({"ok": true, "message": text, "data": {"value": v, "console": []}});
                }
            }
        }
        let errors_of = |r: &Value| -> Vec<String> { r["errors"].as_array().map(|a| a.iter().filter_map(|e| e.as_str().map(str::to_string)).collect()).unwrap_or_default() };
        // An expression first; statements (declarations, loops, several lines) through indirect eval.
        // `lastEvalDone` tells the code's own failures apart from the page's timers running out the
        // time budget after the code finished.
        self.agent.engine.js_engine.eval_js("__jb.lastEvalDone = false");
        let mut r = self.agent.execute_javascript(&format!("__jb.lastEvalPending = false; __jb.lastEval = ({code}\n); __jb.lastEvalDone = true;"));
        let mut nav = first_navigation(&r);
        if errors_of(&r).iter().any(|e| e.contains("SyntaxError")) {
            // the user's own code is not subject to the page's CSP `unsafe-eval` (as in devtools)
            crate::js::runtime::set_csp_eval_bypass(true);
            r = self.agent.execute_javascript(&format!("__jb.lastEvalPending = false; __jb.lastEval = (0, eval)({}); __jb.lastEvalDone = true;", js_str(code)));
            crate::js::runtime::set_csp_eval_bypass(false);
            nav = first_navigation(&r);
        }
        let finished = self.agent.engine.js_engine.eval_js("__jb.lastEvalDone === true") == json!(true);
        // once the user's code finished, errors are the page's own (its timers, its listeners)
        let errors: Vec<String> = if finished { Vec::new() } else { errors_of(&r) };
        if !errors.is_empty() {
            return json!({"ok": false, "error": errors.join("\n"), "data": {"console": r["console"]}});
        }
        // Await a promise result.
        self.agent.engine.js_engine.eval_js("(function () { var v = __jb.lastEval; if (v && typeof v.then === 'function') { __jb.lastEvalPending = true; v.then(function (x) { __jb.lastEval = x; __jb.lastEvalPending = false; }, function (e) { __jb.lastEval = { error: String(e && e.message || e) }; __jb.lastEvalPending = false; }); } })()");
        for _ in 0..50 {
            if self.agent.engine.js_engine.eval_js("__jb.lastEvalPending === true") != json!(true) {
                break;
            }
            let rr = self.agent.execute_javascript("void 0");
            nav = nav.or_else(|| first_navigation(&rr));
        }
        let value = self.agent.engine.js_engine.eval_js("__jb.lastEval");
        let text = match &value {
            Value::String(s) => s.clone(),
            Value::Null => "null".to_string(),
            other => serde_json::to_string_pretty(other).unwrap_or_default(),
        };
        let console = r["console"].clone();
        if let Some(nav) = nav.or_else(|| first_navigation(&r)) {
            let _ = self.navigate(&nav);
        }
        json!({"ok": true, "message": text, "data": {"value": value, "console": console}})
    }

    /// `back` / `forward`: the page's own history when it has an entry that way (same-document
    /// entries of pushState apps), else the session's page history (that URL is loaded again).
    fn traverse(&mut self, back: bool) -> Value {
        let url = self.agent.current_url.clone().unwrap_or_default();
        let (label, js_can, js_go) = if back {
            ("back", "!!(globalThis.navigation && navigation.canGoBack)", "history.back(); __jb.hostJson({ ok: true })")
        } else {
            ("forward", "!!(globalThis.navigation && navigation.canGoForward)", "history.forward(); __jb.hostJson({ ok: true })")
        };
        if self.agent.engine.js_engine.is_live(&url) && self.agent.engine.js_engine.eval_js(js_can) == json!(true) {
            let r = self.agent.run_user_script(js_go, label, "");
            return self.finish(if back { "Went back" } else { "Went forward" }, r);
        }
        let target = if back { self.agent.engine.go_back() } else { self.agent.engine.go_forward() };
        match target {
            Some(u) => match self.navigate(&u) {
                Ok(()) => ok(format!("✓ {}", self.page_line()), json!({"url": self.agent.current_url})),
                Err(e) => {
                    // the move did not happen: keep the history position
                    if back { self.agent.engine.go_forward(); } else { self.agent.engine.go_back(); }
                    fail(e)
                }
            },
            None => fail(if back { "there is no previous page" } else { "there is no next page" }),
        }
    }

    // ---- screenshots and PDF

    /// The agent driving this session (current page, engine, cookies).
    pub fn agent(&mut self) -> &mut AgentSdk {
        &mut self.agent
    }

    /// A PNG of the viewport, or of the whole page when `full`, without writing a file.
    pub fn screenshot_bytes(&mut self, full: bool) -> Result<Vec<u8>, String> {
        let clip = if full { None } else { Some(self.viewport_clip()) };
        self.agent.screenshot_png(full, clip)
    }

    /// The document region of the current viewport, from the page's scroll position.
    fn viewport_clip(&mut self) -> crate::layout::Rect {
        let v = self.agent.engine.js_engine.eval_js("({ x: globalThis.scrollX || 0, y: globalThis.scrollY || 0, w: globalThis.innerWidth || 1280, h: globalThis.innerHeight || 720 })");
        let f = |k: &str, d: f64| v.get(k).and_then(Value::as_f64).unwrap_or(d);
        crate::layout::Rect { x: f("x", 0.0), y: f("y", 0.0), width: f("w", 1280.0), height: f("h", 720.0), ..Default::default() }
    }

    fn screenshot(&mut self, args: &Value) -> Value {
        let full = args.get("full").and_then(Value::as_bool).unwrap_or(false);
        let annotate = args.get("annotate").and_then(Value::as_bool).unwrap_or(false);
        let if_changed = args.get("if_changed").and_then(Value::as_bool).unwrap_or(false);
        let threshold = args.get("threshold").and_then(Value::as_f64).unwrap_or(0.0);
        let format = s(args, "format").unwrap_or("png").to_ascii_lowercase();
        let quality = args.get("quality").and_then(Value::as_u64).unwrap_or(90).clamp(1, 100) as u8;
        let ext = match format.as_str() {
            "png" => "png",
            "jpeg" | "jpg" => "jpg",
            other => return fail(format!("unsupported screenshot format {other:?} (use png or jpeg)")),
        };

        let clip = if full { None } else { Some(self.viewport_clip()) };
        let mut labels: Vec<Value> = Vec::new();
        if annotate {
            let r = self.agent.run_user_script("__jb.user.annotate()", "annotate", "");
            labels = r.get("report").and_then(|rep| rep.get("items")).and_then(Value::as_array).cloned().unwrap_or_default();
        }
        let png = match self.agent.screenshot_png(full, clip) {
            Ok(p) => p,
            Err(e) => return fail(e),
        };

        let path = match s(args, "path") {
            Some(p) => PathBuf::from(p),
            None => {
                let dir = s(args, "dir").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("julia-browser-screenshots"));
                let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
                dir.join(format!("screenshot-{stamp}.{ext}"))
            }
        };
        if let Some(dir) = path.parent() {
            if !dir.as_os_str().is_empty() {
                if let Err(e) = std::fs::create_dir_all(dir) {
                    return fail(format!("cannot create {}: {e}", dir.display()));
                }
            }
        }
        let (ox, oy) = clip.map(|c| (c.x, c.y)).unwrap_or((0.0, 0.0));
        self.write_image(&png, &path, ext, quality, &labels, (ox, oy), if_changed, threshold)
    }

    #[cfg(feature = "images")]
    #[allow(clippy::too_many_arguments)]
    fn write_image(&mut self, png: &[u8], path: &Path, ext: &str, quality: u8, labels: &[Value], origin: (f64, f64), if_changed: bool, threshold: f64) -> Value {
        let mut img = match image::load_from_memory_with_format(png, image::ImageFormat::Png) {
            Ok(i) => i.to_rgba8(),
            Err(e) => return fail(format!("cannot decode the screenshot: {e}")),
        };
        for l in labels {
            let n = l.get("n").and_then(Value::as_u64).unwrap_or(0);
            let g = |k: &str| l.get(k).and_then(Value::as_f64).unwrap_or(0.0);
            draw_label(&mut img, n, g("x") - origin.0, g("y") - origin.1, g("w"), g("h"));
        }
        if if_changed {
            if let Some((prev, prev_path)) = &self.last_shot {
                if prev.dimensions() == img.dimensions() {
                    let total = (img.width() as u64 * img.height() as u64).max(1);
                    let differ = prev.pixels().zip(img.pixels()).filter(|(a, b)| a != b).count() as u64;
                    let ratio = differ as f64 / total as f64;
                    if ratio <= threshold {
                        return ok(
                            format!("Unchanged since the last screenshot ({:.2}% of pixels differ): {}", ratio * 100.0, prev_path.display()),
                            json!({"unchanged": true, "path": prev_path, "changed_ratio": ratio}),
                        );
                    }
                }
            }
        }
        let mut bytes: Vec<u8> = Vec::new();
        let encoded = if ext == "jpg" {
            let rgb = image::DynamicImage::ImageRgba8(img.clone()).to_rgb8();
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality);
            enc.encode_image(&rgb).map_err(|e| e.to_string())
        } else {
            image::DynamicImage::ImageRgba8(img.clone()).write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).map_err(|e| e.to_string())
        };
        if let Err(e) = encoded {
            return fail(format!("cannot encode the screenshot: {e}"));
        }
        if let Err(e) = std::fs::write(path, &bytes) {
            return fail(format!("cannot write {}: {e}", path.display()));
        }
        let (w, h) = img.dimensions();
        self.last_shot = Some((img, path.to_path_buf()));
        let mut message = format!("✓ Screenshot saved to {} ({w}x{h})", path.display());
        if !labels.is_empty() {
            message.push_str("\nElements (use @N as a selector):");
            for l in labels {
                message.push_str(&format!("\n  @{} {}", l.get("n").and_then(Value::as_u64).unwrap_or(0), l.get("el").map(|e| e.as_str().map(str::to_string).unwrap_or_else(|| describe(e))).unwrap_or_default()));
            }
        }
        ok(message, json!({"path": path, "width": w, "height": h, "bytes": bytes.len(), "annotations": labels}))
    }

    #[cfg(not(feature = "images"))]
    #[allow(clippy::too_many_arguments)]
    fn write_image(&mut self, png: &[u8], path: &Path, ext: &str, _quality: u8, labels: &[Value], _origin: (f64, f64), if_changed: bool, _threshold: f64) -> Value {
        if ext != "png" || !labels.is_empty() || if_changed {
            return fail("--annotate, --if-changed and JPEG output need a build with --features images");
        }
        match std::fs::write(path, png) {
            Ok(()) => ok(format!("✓ Screenshot saved to {}", path.display()), json!({"path": path, "bytes": png.len()})),
            Err(e) => fail(format!("cannot write {}: {e}", path.display())),
        }
    }

    fn pdf(&mut self, args: &Value) -> Value {
        let Some(path) = s(args, "path") else { return fail("pdf needs an output path") };
        let png = match self.agent.screenshot_png(true, None) {
            Ok(p) => p,
            Err(e) => return fail(e),
        };
        match write_pdf(&png, Path::new(path)) {
            Ok(pages) => ok(format!("✓ PDF saved to {path} ({pages} page{})", if pages == 1 { "" } else { "s" }), json!({"path": path, "pages": pages})),
            Err(e) => fail(e),
        }
    }
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("txt") => "text/plain",
        Some("csv") => "text/csv",
        Some("html" | "htm") => "text/html",
        Some("json") => "application/json",
        Some("xml") => "application/xml",
        Some("zip") => "application/zip",
        Some("doc") => "application/msword",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("mp4") => "video/mp4",
        Some("mp3") => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------- image helpers

/// 5x7 bitmap digits (bit 4 = leftmost column) for annotation labels.
#[cfg(feature = "images")]
const DIGITS: [[u8; 7]; 10] = [
    [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
    [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
    [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
    [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
    [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
    [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
    [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
    [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
    [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
    [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
];

/// Outline the box (x, y, w, h) and put a numbered tag on its top-left corner.
#[cfg(feature = "images")]
fn draw_label(img: &mut image::RgbaImage, n: u64, x: f64, y: f64, w: f64, h: f64) {
    let (iw, ih) = (img.width() as i64, img.height() as i64);
    let red = image::Rgba([220u8, 38, 38, 255]);
    let white = image::Rgba([255u8, 255, 255, 255]);
    let mut put = |img: &mut image::RgbaImage, px: i64, py: i64, c: image::Rgba<u8>| {
        if px >= 0 && py >= 0 && px < iw && py < ih {
            img.put_pixel(px as u32, py as u32, c);
        }
    };
    let (x0, y0, x1, y1) = (x.round() as i64, y.round() as i64, (x + w).round() as i64, (y + h).round() as i64);
    if x1 < 0 || y1 < 0 || x0 >= iw || y0 >= ih {
        return;
    }
    for t in 0..2 {
        for px in x0..=x1 {
            put(img, px, y0 + t, red);
            put(img, px, y1 - t, red);
        }
        for py in y0..=y1 {
            put(img, x0 + t, py, red);
            put(img, x1 - t, py, red);
        }
    }
    let digits: Vec<usize> = n.to_string().bytes().map(|b| (b - b'0') as usize).collect();
    let scale = 2i64;
    let tag_w = digits.len() as i64 * 6 * scale + 2 * scale;
    let tag_h = 7 * scale + 2 * scale;
    let (tx, ty) = (x0.max(0), (y0 - tag_h).max(0));
    for py in ty..ty + tag_h {
        for px in tx..tx + tag_w {
            put(img, px, py, red);
        }
    }
    for (i, d) in digits.iter().enumerate() {
        let gx = tx + scale + i as i64 * 6 * scale;
        let gy = ty + scale;
        for (row, bits) in DIGITS[*d].iter().enumerate() {
            for col in 0..5 {
                if bits & (0x10 >> col) != 0 {
                    for sy in 0..scale {
                        for sx in 0..scale {
                            put(img, gx + col as i64 * scale + sx, gy + row as i64 * scale + sy, white);
                        }
                    }
                }
            }
        }
    }
}

/// Write the page image as a PDF: A4-proportioned pages, each a JPEG image of its slice.
#[cfg(feature = "images")]
fn write_pdf(png: &[u8], path: &Path) -> Result<usize, String> {
    let img = image::load_from_memory_with_format(png, image::ImageFormat::Png).map_err(|e| format!("cannot decode the page image: {e}"))?.to_rgb8();
    let (w, h) = img.dimensions();
    let page_h = ((w as f64) * 1.4142).round().max(1.0) as u32;
    let pages = h.div_ceil(page_h).max(1) as usize;

    // objects[i] is object number i + 1
    let mut objects: Vec<Vec<u8>> = vec![Vec::new(), Vec::new()];
    let mut kids = Vec::new();
    for p in 0..pages {
        let top = p as u32 * page_h;
        let ch = page_h.min(h - top);
        let slice = image::imageops::crop_imm(&img, 0, top, w, ch).to_image();
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85).encode_image(&slice).map_err(|e| format!("cannot encode page {}: {e}", p + 1))?;
        // every page has the A4 shape; a short last slice sits at the top
        let (pw, ph) = (w as f64 * 0.75, page_h as f64 * 0.75);
        let (iw, ih) = (pw, ch as f64 * 0.75);
        let page_no = objects.len() + 1;
        let img_no = page_no + 1;
        let content_no = page_no + 2;
        kids.push(format!("{page_no} 0 R"));
        objects.push(format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw:.2} {ph:.2}] /Resources << /XObject << /Im0 {img_no} 0 R >> >> /Contents {content_no} 0 R >>").into_bytes());
        let mut image_obj = format!("<< /Type /XObject /Subtype /Image /Width {w} /Height {ch} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n", jpeg.len()).into_bytes();
        image_obj.extend_from_slice(&jpeg);
        image_obj.extend_from_slice(b"\nendstream");
        objects.push(image_obj);
        let content = format!("q {iw:.2} 0 0 {ih:.2} 0 {:.2} cm /Im0 Do Q", ph - ih);
        objects.push(format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()).into_bytes());
    }
    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>".to_vec();
    objects[1] = format!("<< /Type /Pages /Kids [{}] /Count {pages} >>", kids.join(" ")).into_bytes();

    let mut out: Vec<u8> = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for o in &offsets {
        out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes());
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        }
    }
    std::fs::write(path, out).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(pages)
}

#[cfg(not(feature = "images"))]
fn write_pdf(_png: &[u8], _path: &Path) -> Result<usize, String> {
    Err("PDF output needs a build with --features images".into())
}

/// Short human description of an element report: `input#q "text" = "value"`.
fn describe(el: &Value) -> String {
    let mut out = el["tag"].as_str().unwrap_or("element").to_string();
    if let Some(id) = el["id"].as_str().filter(|s| !s.is_empty()) {
        out.push('#');
        out.push_str(id);
    }
    let clip = |s: &str| {
        let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
        if s.chars().count() > 40 { format!("{}…", s.chars().take(40).collect::<String>()) } else { s }
    };
    if let Some(t) = el["text"].as_str().filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!(" \"{}\"", clip(t)));
    }
    if let Some(v) = el["value"].as_str().filter(|s| !s.is_empty() && !(*s == "on" && el["checked"].is_boolean())) {
        out.push_str(&format!(" = \"{}\"", clip(v)));
    }
    if matches!(el["type"].as_str(), Some("checkbox" | "radio")) || el["checked"].as_bool() == Some(true) {
        if let Some(c) = el["checked"].as_bool() {
            out.push_str(if c { " [checked]" } else { " [unchecked]" });
        }
    }
    out
}
