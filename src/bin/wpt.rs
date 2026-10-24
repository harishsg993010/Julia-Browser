//! Web Platform Tests runner for Julia Browser.
//!
//! ```text
//! wpt run  --root ../wpt [--filter dom/nodes] [--jobs 8] [--out wpt-results.json]
//! wpt one  --root ../wpt --port 8123 dom/nodes/Node-appendChild.html   (internal)
//! wpt serve --root ../wpt --port 8123                                   (debugging)
//! ```
//!
//! `run` starts a static HTTP server over the WPT checkout (with the bits of
//! `wpt serve` we need: `.any.js` / `.window.js` wrapping, `.sub` substitution,
//! `.headers` sidecars and a `testharnessreport.js` that records results),
//! discovers testharness.js tests and runs each one in a child process with a
//! timeout. Results are aggregated per top-level directory.

use clap::{Parser, Subcommand};
use julia_browser::dom;
use regex::Regex;
use julia_browser::http::HttpClient;
use julia_browser::js::{JavaScriptEngine, JsConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Parser)]
#[command(name = "wpt", about = "Run web-platform-tests against Julia Browser")]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Discover and run tests, printing a summary.
    Run {
        #[arg(long)]
        root: PathBuf,
        /// Only run tests whose path starts with one of these prefixes (comma separated).
        #[arg(long, default_value = "")]
        filter: String,
        /// Skip tests whose path contains any of these substrings (comma separated).
        #[arg(long, default_value = "")]
        exclude: String,
        #[arg(long, default_value_t = 0)]
        jobs: usize,
        /// Per-test wall-clock timeout in seconds.
        #[arg(long, default_value_t = 60)]
        timeout: u64,
        /// Longer timeouts for slow files: "prefix=secs,prefix=secs"
        #[arg(long, default_value = "")]
        timeout_for: String,
        /// Serve the checkout with WPT's own `wpt serve` (Python handlers, .sub
        /// files, https/wss, alternate hosts) instead of the built-in server.
        #[arg(long)]
        wptserve: bool,
        #[arg(long, default_value = "wpt-results.json")]
        out: PathBuf,
        /// Print every failing subtest.
        #[arg(long)]
        verbose: bool,
        /// Only list the discovered tests.
        #[arg(long)]
        list: bool,
    },
    /// Run a single test (internal; used by `run`).
    One {
        #[arg(long)]
        root: PathBuf,
        /// Port of the built-in server (ignored when --base is given).
        #[arg(long, default_value_t = 0)]
        port: u16,
        /// Base URL of an external server, e.g. http://web-platform.test:8000
        #[arg(long)]
        base: Option<String>,
        test: String,
    },
    /// Serve the checkout (for debugging with another client).
    Serve {
        #[arg(long)]
        root: PathBuf,
        #[arg(long, default_value_t = 8123)]
        port: u16,
    },
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Cmd::Run { root, filter, exclude, jobs, timeout, timeout_for, wptserve, out, verbose, list } => run(root, &filter, &exclude, jobs, timeout, &timeout_for, wptserve, out, verbose, list),
        Cmd::One { root, port, base, test } => {
            let base = base.unwrap_or_else(|| format!("http://127.0.0.1:{port}"));
            let r = julia_browser::js::runtime::run_on_big_stack(move || run_one(&root, &base, &test));
            println!("{}", serde_json::to_string(&r).unwrap());
        }
        Cmd::Serve { root, port } => {
            let root = root.canonicalize().expect("root");
            eprintln!("serving {} on http://127.0.0.1:{port}/", root.display());
            serve(root, port);
        }
    }
}

// ---------------------------------------------------------------- results

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SubtestResult {
    name: String,
    /// PASS | FAIL | TIMEOUT | NOTRUN | PRECONDITION_FAILED
    status: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TestResult {
    test: String,
    /// OK | ERROR | TIMEOUT | CRASH | PRECONDITION_FAILED
    status: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    message: String,
    #[serde(default)]
    subtests: Vec<SubtestResult>,
    #[serde(default)]
    duration_ms: u64,
}

// ---------------------------------------------------------------- discovery

fn discover(root: &Path, filters: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    walk(root, root, filters, &mut out);
    out.sort();
    out
}

const SKIP_DIRS: &[&str] = &["resources", "support", "tools", "common", ".git", "conformance-checkers", "css", "docs", "infrastructure", "webdriver", "interfaces"];

// A directory can hold tests matching one of the --filter prefixes (no filters: every directory).
fn dir_matches(root: &Path, dir: &Path, filters: &[String]) -> bool {
    if filters.is_empty() {
        return true;
    }
    let rel = dir.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    let slash = format!("{rel}/");
    filters.iter().any(|f| f.starts_with(&slash) || slash.starts_with(f.as_str()) || rel.starts_with(f.as_str()))
}

fn walk(root: &Path, dir: &Path, filters: &[String], out: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) && dir != root {
                continue;
            }
            if name == "resources" || name == "support" || name == "tools" || name == ".git" || name.starts_with("_venv") {
                continue;
            }
            if !dir_matches(root, &path, filters) {
                continue;
            }
            // css/: every module is walked; only its testharness files run (reftests are skipped
            // below because they do not load testharness.js)
            if name == "css" && dir == root {
                if let Ok(subs) = std::fs::read_dir(&path) {
                    let mut subs: Vec<_> = subs.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
                    subs.sort();
                    for sub in subs {
                        let n = sub.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                        if n != "support" && n != "reference" && dir_matches(root, &sub, filters) {
                            walk(root, &sub, filters, out);
                        }
                    }
                }
                continue;
            }
            walk(root, &path, filters, out);
            continue;
        }
        let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        let lower = name.to_lowercase();
        if lower.contains("-manual.") || lower.contains("-ref.") || lower.contains("-expected") || lower.starts_with("ref-") {
            continue;
        }
        if lower.ends_with(".any.js") || lower.ends_with(".window.js") {
            let src = std::fs::read_to_string(&path).unwrap_or_default();
            let meta = parse_meta(&src);
            if lower.ends_with(".any.js") && !meta.globals.is_empty() && !meta.globals.iter().any(|g| g == "window") {
                continue; // worker-only test
            }
            let html = format!("{}.html", &rel[..rel.len() - 3]);
            push_variants(&html, &meta.variants, out);
        } else if lower.ends_with(".html") || lower.ends_with(".htm") {
            let src = std::fs::read_to_string(&path).unwrap_or_default();
            if !src.contains("testharness.js") {
                continue;
            }
            let variants = html_variants(&src);
            push_variants(&rel, &variants, out);
        }
    }
}

fn push_variants(test: &str, variants: &[String], out: &mut Vec<String>) {
    if variants.is_empty() {
        out.push(test.to_string());
    } else {
        for v in variants {
            out.push(format!("{test}{v}"));
        }
    }
}

#[derive(Default)]
struct Meta {
    title: String,
    scripts: Vec<String>,
    variants: Vec<String>,
    globals: Vec<String>,
    timeout_long: bool,
}

fn parse_meta(src: &str) -> Meta {
    let mut m = Meta::default();
    for line in src.lines() {
        let line = line.trim();
        let rest = match line.strip_prefix("// META:") {
            Some(r) => r.trim(),
            None => {
                if line.is_empty() || line.starts_with("//") {
                    continue;
                }
                break;
            }
        };
        if let Some((k, v)) = rest.split_once('=') {
            let v = v.trim().to_string();
            match k.trim() {
                "title" => m.title = v,
                "script" => m.scripts.push(v),
                "variant" => m.variants.push(v),
                "global" => m.globals = v.split(',').map(|s| s.trim().to_string()).collect(),
                "timeout" => m.timeout_long = v == "long",
                _ => {}
            }
        }
    }
    m
}

fn html_variants(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = src.to_lowercase();
    let mut pos = 0;
    while let Some(i) = lower[pos..].find("<meta") {
        let start = pos + i;
        let end = lower[start..].find('>').map(|e| start + e).unwrap_or(lower.len());
        let tag = &src[start..end];
        if tag.to_lowercase().contains("name=\"variant\"") || tag.to_lowercase().contains("name=variant") {
            if let Some(c) = attr_value(tag, "content") {
                out.push(c);
            }
        }
        pos = end;
    }
    out
}

fn attr_value(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let i = lower.find(&format!("{name}="))? + name.len() + 1;
    let rest = &tag[i..];
    let (q, rest) = match rest.chars().next()? {
        '"' => ('"', &rest[1..]),
        '\'' => ('\'', &rest[1..]),
        _ => (' ', rest),
    };
    let end = rest.find(|c| c == q || (q == ' ' && (c == '>' || c == ' '))).unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

// ---------------------------------------------------------------- server

const REPORT_JS: &str = r#"
(function(){
  var STATUS = ["PASS","FAIL","TIMEOUT","NOTRUN","PRECONDITION_FAILED"];
  var HSTATUS = ["OK","ERROR","TIMEOUT","PRECONDITION_FAILED"];
  // Lone surrogates are not representable in the JSON the runner parses.
  function wf(s) { s = String(s); return typeof s.toWellFormed === "function" ? s.toWellFormed() : s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�"); }
  add_completion_callback(function(tests, status){
    self.__wpt_result = JSON.stringify({
      status: HSTATUS[status.status] || String(status.status),
      message: status.message ? wf(status.message) : "",
      subtests: tests.map(function(t){ return {name: wf(t.name), status: STATUS[t.status] || String(t.status), message: t.message ? wf(t.message) : ""}; })
    });
  });
})();
"#;

fn serve(root: PathBuf, port: u16) {
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind");
    for stream in listener.incoming().flatten() {
        let root = root.clone();
        std::thread::spawn(move || {
            let _ = handle_connection(stream, &root, port);
        });
    }
}

fn start_server(root: PathBuf) -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let root = root.clone();
            std::thread::spawn(move || {
                let _ = handle_connection(stream, &root, port);
            });
        }
    });
    port
}

fn handle_connection(mut stream: TcpStream, root: &Path, port: u16) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let mut headers = BTreeMap::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 {
            break;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
            // Raw header lines (original case and order) for inspect-headers.py.
            let raw = headers.entry("\0raw".to_string()).or_default();
            raw.push_str(h);
            raw.push('\n');
        }
    }
    let mut body = Vec::new();
    if let Some(len) = headers.get("content-length").and_then(|v| v.parse::<usize>().ok()) {
        body.resize(len, 0);
        reader.read_exact(&mut body)?;
    }
    let (status, ctype, extra, resp_body) = respond(root, port, &method, &target, &headers, &body);
    let mut out = format!("HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n", resp_body.len());
    for (k, v) in extra {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    stream.write_all(out.as_bytes())?;
    stream.write_all(&resp_body)?;
    stream.flush()
}

fn content_type(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html",
        "xhtml" | "xht" => "application/xhtml+xml",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "css" => "text/css",
        "txt" => "text/plain",
        "xml" => "text/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "oga" | "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "py" => "text/plain",
        _ => "application/octet-stream",
    }
}

type Response = (&'static str, String, Vec<(String, String)>, Vec<u8>);

/// Files that are symlinks upstream: Git on Windows leaves them out or writes
/// the link target as a one-line file. Resolve the known ones and any
/// one-line placeholder that names an existing sibling.
fn resolve_symlinked(root: &Path, rel: &str) -> Option<std::path::PathBuf> {
    const KNOWN: &[(&str, &str)] = &[("resources/WebIDLParser.js", "resources/webidl2/lib/webidl2.js")];
    if let Some((_, target)) = KNOWN.iter().find(|(from, _)| *from == rel) {
        let p = root.join(target);
        return p.is_file().then_some(p);
    }
    let path = root.join(rel);
    let meta = std::fs::metadata(&path).ok()?;
    if meta.len() > 512 {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    let line = content.trim();
    if line.is_empty() || line.contains('\n') || line.contains(' ') {
        return None;
    }
    let candidate = path.parent()?.join(line);
    (candidate.is_file() && candidate != path).then_some(candidate)
}

fn respond(root: &Path, port: u16, method: &str, target: &str, req_headers: &BTreeMap<String, String>, body: &[u8]) -> Response {
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.to_string(), String::new()),
    };
    let path = percent_decode(&path);
    if path.contains("..") {
        return ("400 Bad Request", "text/plain".into(), vec![], b"bad path".to_vec());
    }
    // Reporter override.
    if path == "/resources/testharnessreport.js" {
        return ("200 OK", "text/javascript".into(), vec![], REPORT_JS.as_bytes().to_vec());
    }
    // In-process test_driver: clicks and key presses are dispatched directly.
    if path == "/resources/testdriver-vendor.js" {
        return ("200 OK", "text/javascript".into(), vec![], TESTDRIVER_VENDOR_JS.as_bytes().to_vec());
    }
    // Generated wrappers for .any.js / .window.js.
    for (suffix, js_suffix) in [(".any.html", ".any.js"), (".window.html", ".window.js")] {
        if let Some(base) = path.strip_suffix(suffix) {
            let js_rel = format!("{base}{js_suffix}");
            let file = root.join(js_rel.trim_start_matches('/'));
            let src = match std::fs::read_to_string(&file) {
                Ok(s) => s,
                Err(_) => return ("404 Not Found", "text/plain".into(), vec![], b"not found".to_vec()),
            };
            let meta = parse_meta(&src);
            let mut html = String::from("<!doctype html>\n<meta charset=utf-8>\n");
            if !meta.title.is_empty() {
                html.push_str(&format!("<title>{}</title>\n", dom::escape_html(&meta.title)));
            }
            if meta.timeout_long {
                html.push_str("<meta name=\"timeout\" content=\"long\">\n");
            }
            html.push_str("<script jb-runner>self.GLOBAL = { isWindow: function() { return true; }, isWorker: function() { return false; }, isShadowRealm: function() { return false; } };</script>\n");
            html.push_str("<script src=\"/resources/testharness.js\"></script>\n<script src=\"/resources/testharnessreport.js\"></script>\n");
            for s in &meta.scripts {
                html.push_str(&format!("<script src=\"{}\"></script>\n", dom::escape_html(s)));
            }
            html.push_str("<div id=log></div>\n");
            html.push_str(&format!("<script src=\"{}\"></script>\n", dom::escape_html(&js_rel)));
            return ("200 OK", "text/html; charset=utf-8".into(), vec![], html.into_bytes());
        }
    }
    // Some very common python handlers, implemented natively.
    if let Some(r) = python_handler(root, &path, &query, method, req_headers, body) {
        return r;
    }
    let file = root.join(path.trim_start_matches('/'));
    let file = if file.is_dir() { file.join("index.html") } else { file };
    let file = resolve_symlinked(root, path.trim_start_matches('/')).unwrap_or(file);
    let bytes = match std::fs::read(&file) {
        Ok(b) => b,
        Err(_) => return ("404 Not Found", "text/plain".into(), vec![], format!("not found: {path}").into_bytes()),
    };
    let mut ctype = content_type(&path).to_string();
    let mut extra = Vec::new();
    let mut status: &'static str = "200 OK";
    // `.headers` sidecar files.
    if let Ok(h) = std::fs::read_to_string(format!("{}.headers", file.display())) {
        for line in h.lines() {
            if let Some((k, v)) = line.split_once(':') {
                let (k, v) = (k.trim(), v.trim());
                if k.eq_ignore_ascii_case("content-type") {
                    ctype = substitute(v, port, &query);
                } else {
                    extra.push((k.to_string(), substitute(v, port, &query)));
                }
            }
        }
    }
    // Pipes (`?pipe=status(404)` etc.) – status only.
    for pipe in query.split('&').filter_map(|p| p.strip_prefix("pipe=")) {
        if let Some(code) = pipe.strip_prefix("status(").and_then(|s| s.strip_suffix(')')) {
            status = match code {
                "404" => "404 Not Found",
                "500" => "500 Internal Server Error",
                "204" => "204 No Content",
                "301" => "301 Moved Permanently",
                "302" => "302 Found",
                _ => status,
            };
        }
    }
    let bytes = if path.contains(".sub.") {
        substitute(&String::from_utf8_lossy(&bytes), port, &query).into_bytes()
    } else {
        bytes
    };
    (status, ctype, extra, bytes)
}

/// `{{...}}` substitutions used by `.sub` files (subset of wptserve).
fn substitute(text: &str, port: u16, query: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("{{") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        let Some(j) = after.find("}}") else {
            out.push_str(&rest[i..]);
            rest = "";
            break;
        };
        let key = after[..j].trim();
        let value = match key {
            "host" => "127.0.0.1".to_string(),
            k if k.starts_with("domains[") || k.starts_with("hosts[") => "127.0.0.1".to_string(),
            k if k.starts_with("ports[") => port.to_string(),
            "location[scheme]" => "http".to_string(),
            "location[host]" => format!("127.0.0.1:{port}"),
            "location[hostname]" => "127.0.0.1".to_string(),
            "location[port]" => port.to_string(),
            "location[server]" => format!("http://127.0.0.1:{port}"),
            k if k.starts_with("GET[") => {
                let name = &k[4..k.len() - 1];
                query.split('&').find_map(|p| p.strip_prefix(&format!("{name}="))).map(percent_decode).unwrap_or_default()
            }
            k if k.starts_with("uuid()") => uuid::Uuid::new_v4().to_string(),
            _ => format!("{{{{{key}}}}}"),
        };
        out.push_str(&value);
        rest = &after[j + 2..];
    }
    out.push_str(rest);
    out
}

fn percent_decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()
}

/// Native stand-ins for the python handlers that many tests rely on.
fn python_handler(root: &Path, path: &str, query: &str, method: &str, req_headers: &BTreeMap<String, String>, body: &[u8]) -> Option<Response> {
    let q: BTreeMap<String, String> = query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (percent_decode(k), percent_decode(v)),
            None => (percent_decode(p), String::new()),
        })
        .collect();
    let name = path.rsplit('/').next().unwrap_or("");
    match name {
        "echo-content.py" | "echo-content.h2.py" => {
            let ctype = req_headers.get("content-type").cloned().unwrap_or_else(|| "text/plain".into());
            Some(("200 OK", ctype, vec![("X-Request-Method".into(), method.into())], body.to_vec()))
        }
        "inspect-headers.py" => {
            let mut extra = Vec::new();
            if let Some(h) = q.get("headers") {
                for n in h.split('|') {
                    if let Some(v) = req_headers.get(&n.to_ascii_lowercase()) {
                        extra.push((format!("x-request-{n}"), v.clone()));
                    }
                }
            }
            if q.contains_key("cors") {
                extra.push(("Access-Control-Allow-Credentials".into(), "true".into()));
                extra.push(("Access-Control-Allow-Methods".into(), "GET, POST, PUT, FOO".into()));
                extra.push(("Access-Control-Allow-Headers".into(), "x-test, x-foo".into()));
                extra.push(("Access-Control-Expose-Headers".into(), "x-request-method, x-request-content-type, x-request-query, x-request-content-length".into()));
            }
            // filter_name: "Name: value\n" per matching header; filter_value: names of
            // headers with that value. The HTTP client lowercases names, so the
            // filter's own spelling is echoed.
            let raw = req_headers.get("\0raw").cloned().unwrap_or_default();
            let filter_value = q.get("filter_value").cloned().unwrap_or_default();
            let filter_name = q.get("filter_name").cloned().unwrap_or_default();
            let mut result = String::new();
            for line in raw.lines() {
                if let Some((n, v)) = line.split_once(':') {
                    let v = v.trim();
                    if !filter_value.is_empty() {
                        if v == filter_value {
                            result.push_str(n);
                            result.push(',');
                        }
                    } else if !filter_name.is_empty() && n.eq_ignore_ascii_case(&filter_name) {
                        result.push_str(&format!("{filter_name}: {v}\n"));
                    }
                }
            }
            Some(("200 OK", "text/plain".into(), extra, result.into_bytes()))
        }
        "status.py" => {
            let code = q.get("code").cloned().unwrap_or_else(|| "200".into());
            let status: &'static str = Box::leak(format!("{code} {}", q.get("text").cloned().unwrap_or_else(|| "OMG".into())).into_boxed_str());
            let ctype = q.get("type").cloned().unwrap_or_default();
            Some((status, ctype, vec![("X-Request-Method".into(), method.into())], q.get("content").cloned().unwrap_or_default().into_bytes()))
        }
        "content.py" => {
            let ctype = match q.get("response_charset_label") {
                Some(l) => format!("text/plain;charset={l}"),
                None => "text/plain".into(),
            };
            let extra = vec![
                ("X-Request-Method".into(), method.into()),
                ("X-Request-Query".into(), if query.is_empty() { "NO".into() } else { query.to_string() }),
                ("X-Request-Content-Length".into(), req_headers.get("content-length").cloned().unwrap_or_else(|| "NO".into())),
                ("X-Request-Content-Type".into(), req_headers.get("content-type").cloned().unwrap_or_else(|| "NO".into())),
            ];
            let content = q.get("content").map(|c| c.as_bytes().to_vec()).unwrap_or_else(|| body.to_vec());
            Some(("200 OK", ctype, extra, content))
        }
        "redirect.py" => {
            let code = q.get("code").and_then(|c| c.parse::<u16>().ok()).unwrap_or(302);
            if q.contains_key("followed") {
                return Some(("200 OK", "text/plain".into(), vec![], b"MAGIC HAPPENED".to_vec()));
            }
            let mut location = q.get("location").cloned().unwrap_or_else(|| format!("{path}?followed"));
            if location.starts_with("redirect.py") {
                location.push_str(&format!("&code={code}"));
            }
            let status: &'static str = Box::leak(format!("{code} WEBSRT MARKETING").into_boxed_str());
            Some((status, "text/plain".into(), vec![("Location".into(), location)], b"TEST".to_vec()))
        }
        "method.py" => Some(("200 OK", "text/plain".into(), vec![("x-request-method".into(), method.into())], method.as_bytes().to_vec())),
        "single-byte-raw.py" => Some(("200 OK", format!("text/plain;charset={}", q.get("label").cloned().unwrap_or_default()), vec![], (0u8..255).collect())),
        "encoding.py" => {
            let label = q.get("label").cloned().unwrap_or_default().replace('"', "&quot;");
            Some(("200 OK", "text/html".into(), vec![], format!("<!doctype html><meta charset=\"{label}\">").into_bytes()))
        }
        "text-html-meta-charset.py" => {
            let label = q.get("label").cloned().unwrap_or_default();
            Some(("200 OK", "text/html".into(), vec![], format!("<!doctype html><meta charset=\"{label}\"><script>document.documentElement.setAttribute('data-charset', document.characterSet)</script>").into_bytes()))
        }
        "serve-with-content-type.py" => {
            // Serves the sibling file `fn` with the Content-Type `ct`.
            let file = q.get("fn").cloned().unwrap_or_default();
            if file.contains("..") || file.contains('/') {
                return Some(("404 Not Found", "text/plain".into(), vec![], Vec::new()));
            }
            let dir = Path::new(path.trim_start_matches('/')).parent().map(|d| d.to_path_buf()).unwrap_or_default();
            let bytes = std::fs::read(root.join(dir).join(&file)).ok()?;
            Some(("200 OK", q.get("ct").cloned().unwrap_or_else(|| "text/plain".into()), vec![], bytes))
        }
        "top.txt" => Some(("200 OK", "text/plain".into(), vec![], b"top".to_vec())),
        "data.json" if path.contains("/fetch/api/resources/") => Some(("200 OK", "application/json".into(), vec![], b"{\"key\": \"value\"}".to_vec())),
        _ => None,
    }
}

// ---------------------------------------------------------------- one test

/// Where a test lives on an external server: `.https.`/`.h2.` tests on the
/// https port, everything else on the first http port.
fn test_url(base: &str, test: &str) -> String {
    let secure = test.contains(".https.") || test.contains(".h2.") || test.contains(".serviceworker.");
    if secure && base.starts_with("http://") {
        if let Some(https) = std::env::var_os("JB_WPT_HTTPS_BASE") {
            return format!("{}/{test}", https.to_string_lossy());
        }
    }
    format!("{base}/{test}")
}

/// The runner's own reporter and test driver replace the ones the page
/// includes, whichever server served the page.
fn inject_overrides(html: &str) -> String {
    // src may be quoted with ", ' or not at all.
    let report = Regex::new(r#"(?i)<script[^>]*src=["']?[^"'\s>]*resources/testharnessreport\.js["']?[^>]*>\s*</script>"#).unwrap();
    let vendor = Regex::new(r#"(?i)<script[^>]*src=["']?[^"'\s>]*resources/testdriver-vendor\.js["']?[^>]*>\s*</script>"#).unwrap();
    let out = report.replace(html, |_: &regex::Captures| format!("<script jb-runner>{REPORT_JS}</script>"));
    vendor.replace(&out, |_: &regex::Captures| format!("<script jb-runner>{TESTDRIVER_VENDOR_JS}</script>")).into_owned()
}

fn run_one(root: &Path, base: &str, test: &str) -> TestResult {
    let started = Instant::now();
    let url = test_url(base, test);
    let client = HttpClient::new(None);
    let resp = match client.get_simple(&url, 30) {
        Ok(r) => r,
        Err(e) => return TestResult { test: test.into(), status: "ERROR".into(), message: format!("fetch failed: {e}"), subtests: vec![], duration_ms: 0 },
    };
    if resp.status != 200 {
        return TestResult { test: test.into(), status: "ERROR".into(), message: format!("HTTP {}", resp.status), subtests: vec![], duration_ms: 0 };
    }
    if std::env::var("WPT_DEBUG").is_ok() {
        eprintln!("fetched {} -> {} status {} {} bytes, encoding {}, head: {:?}", url, resp.url, resp.status, resp.body.len(), resp.encoding, resp.text.chars().take(80).collect::<String>());
    }
    let html = if base.contains("127.0.0.1") { resp.text.clone() } else { inject_overrides(&resp.text) };
    let mut doc = dom::parse_document(&html);
    let config = JsConfig {
        max_requests: 10_000,
        request_timeout_secs: 20,
        time_budget_ms: std::env::var("JB_WPT_SCRIPT_BUDGET_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(40_000),
        max_timer_steps: 20_000,
        fetch_external_scripts: true,
        max_external_scripts: 500,
        echo_console: false,
        allow_websockets: true,
        network_idle_ms: 500,
        ..Default::default()
    };
    let mut engine = JavaScriptEngine::with_config(client, config);
    engine.set_ephemeral_storage();
    engine.document_charset = Some(resp.encoding.clone());
    engine.document_headers = Some(resp.headers.clone());
    // Tests poll with setInterval; the runner's step and time budgets bound them.
    // The vendor shim also goes to frames (60_realms.js loads it instead of the served stub).
    let init = format!("__jb.maxIntervalRuns = Infinity; __jb.wptMode = true; __jb.noStyloAnim = {}; __jb.wptVendorSource = {};", std::env::var("JB_NO_STYLO_ANIM").map(|v| !v.is_empty()).unwrap_or(false), serde_json::to_string(TESTDRIVER_VENDOR_JS).unwrap_or_else(|_| "null".into()));
    let exec = engine.run_page(&mut doc, &url, Some(&init));
    let raw = engine.eval_js("self.__wpt_result");
    let _ = root;
    if std::env::var("WPT_DEBUG").is_ok() {
        for l in &exec.console {
            eprintln!("console: {l}");
        }
        for e in &exec.errors {
            eprintln!("error: {e}");
        }
        eprintln!("scripts_run={} failed={} pending_timers={} api_calls={}", exec.scripts_run, exec.scripts_failed, exec.pending_timers, exec.api_calls.len());
    }
    let duration_ms = started.elapsed().as_millis() as u64;
    match raw.as_str().and_then(|s| serde_json::from_str::<Value>(s).ok()) {
        Some(v) => {
            let subtests = v["subtests"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|s| SubtestResult { name: s["name"].as_str().unwrap_or("").into(), status: s["status"].as_str().unwrap_or("").into(), message: s["message"].as_str().unwrap_or("").into() })
                        .collect()
                })
                .unwrap_or_default();
            TestResult { test: test.into(), status: v["status"].as_str().unwrap_or("OK").into(), message: v["message"].as_str().unwrap_or("").into(), subtests, duration_ms }
        }
        None => {
            let mut message = String::from("harness did not complete");
            if !exec.errors.is_empty() {
                message.push_str(": ");
                message.push_str(&exec.errors.iter().take(3).cloned().collect::<Vec<_>>().join(" | "));
            }
            TestResult { test: test.into(), status: "TIMEOUT".into(), message, subtests: vec![], duration_ms }
        }
    }
}

// ---------------------------------------------------------------- orchestrator

/// `WPT_TRACE=<file>` appends one line per runner step, for finding hangs.
fn trace(msg: &str) {
    use std::io::Write;
    if let Some(path) = std::env::var_os("WPT_TRACE") {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{:?} {msg}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
        }
    }
}

/// `--timeout-for prefix=secs,prefix=secs`: longer budgets for legitimately slow files.
/// Tests marked `<meta name="timeout" content="long">` (or `// META: timeout=long`
/// in a generated test's script) get a longer budget, as in wptrunner.
fn long_timeout(root: &Path, test: &str) -> bool {
    let path = test.split(['?', '#']).next().unwrap_or(test);
    let mut candidates = vec![root.join(path)];
    for (suffix, js) in [(".any.html", ".any.js"), (".window.html", ".window.js"), (".worker.html", ".worker.js")] {
        if let Some(stem) = path.strip_suffix(suffix) {
            candidates.push(root.join(format!("{stem}{js}")));
        }
    }
    candidates.iter().any(|p| match std::fs::read_to_string(p) {
        Ok(text) => {
            let head: String = text.chars().take(8192).collect::<String>().to_ascii_lowercase();
            head.contains("timeout=long") || (head.contains("name=\"timeout\"") || head.contains("name=timeout")) && head.contains("content=\"long\"") || head.contains("content=long")
        }
        Err(_) => false,
    })
}

fn timeout_for(test: &str, default: u64, overrides: &[(String, u64)]) -> u64 {
    overrides.iter().filter(|(p, _)| test.starts_with(p.as_str())).map(|(_, s)| *s).max().unwrap_or(default)
}

#[allow(clippy::too_many_arguments)]
/// web-platform-tests' host family; `wpt serve` answers for all of them on
/// 127.0.0.1 and its pregenerated certificates cover them.
const WPT_HOSTS: &[&str] = &[
    "web-platform.test", "www.web-platform.test", "www1.web-platform.test", "www2.web-platform.test",
    "xn--n8j6ds53lwwkrqhv28a.web-platform.test", "xn--lve-6lad.web-platform.test",
    "not-web-platform.test", "www.not-web-platform.test", "www1.not-web-platform.test", "www2.not-web-platform.test",
    "xn--n8j6ds53lwwkrqhv28a.not-web-platform.test", "xn--lve-6lad.not-web-platform.test",
];

/// Start `wpt serve` from the checkout with a config written next to the
/// results; returns the child and the http base URL once it answers.
fn wptserve_up() -> bool {
    let probe = HttpClient::new(None);
    let mut headers = BTreeMap::new();
    headers.insert("Host".to_string(), "web-platform.test:8000".to_string());
    matches!(probe.request("GET", "http://127.0.0.1:8000/common/blank.html", &headers, None, 5, true), Ok(r) if r.status == 200)
}

/// Starts `wpt serve` unless one already answers on port 8000 (then that one is reused).
fn start_wptserve(root: &Path) -> Option<(Option<std::process::Child>, String)> {
    if wptserve_up() {
        return Some((None, "http://web-platform.test:8000".to_string()));
    }
    let dir = std::env::current_dir().ok()?.join("target").join("wptserve");
    std::fs::create_dir_all(&dir).ok()?;
    let root_str = root.to_string_lossy().trim_start_matches(r"\\?\").replace('\\', "/");
    // Python's wpt tooling joins relative paths onto the root and cannot open `\\?\` verbatim paths.
    let root = &PathBuf::from(&root_str);
    let config = json!({
        "browser_host": "web-platform.test",
        "doc_root": root_str,
        "ports": {"http": [8000, 8001], "http-private": [8002], "http-public": [8003], "https": [8443, 8444], "https-private": [8445], "https-public": [8446], "ws": [9000], "wss": [9001], "h2": [9002], "webtransport-h3": []},
        "check_subdomains": false,
        "bind_address": false,
        "aliases": []
    });
    let config_path = dir.join("config.json");
    std::fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap()).ok()?;
    let log = std::fs::File::create(dir.join("serve.log")).ok()?;
    // The Microsoft Store `python` alias hangs on some machines; `py` (or JB_PYTHON) is the real interpreter.
    let python = std::env::var("JB_PYTHON").unwrap_or_else(|_| "py".to_string());
    let child = std::process::Command::new(python)
        .arg(root.join("wpt"))
        .args(["serve", "--config"])
        .arg(&config_path)
        .current_dir(root)
        .stdout(std::process::Stdio::from(log.try_clone().ok()?))
        .stderr(std::process::Stdio::from(log))
        .spawn()
        .ok()?;
    let probe = HttpClient::new(None);
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut headers = BTreeMap::new();
    headers.insert("Host".to_string(), "web-platform.test:8000".to_string());
    while Instant::now() < deadline {
        if let Ok(r) = probe.request("GET", "http://127.0.0.1:8000/common/blank.html", &headers, None, 5, true) {
            if r.status == 200 {
                return Some((Some(child), "http://web-platform.test:8000".to_string()));
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    eprintln!("wpt serve did not come up within 120s (see target/wptserve/serve.log)");
    None
}

#[allow(clippy::too_many_arguments)]
fn run(root: PathBuf, filter: &str, exclude: &str, jobs: usize, timeout: u64, timeout_overrides: &str, wptserve: bool, out: PathBuf, verbose: bool, list: bool) {
    let root = root.canonicalize().expect("root does not exist");
    let overrides: Vec<(String, u64)> = timeout_overrides
        .split(',')
        .filter_map(|s| {
            let (p, secs) = s.trim().split_once('=')?;
            Some((p.trim().to_string(), secs.trim().parse().ok()?))
        })
        .collect();
    trace("run: start");
    let filters: Vec<String> = filter.split(',').map(|s| s.trim().trim_start_matches("./").to_string()).filter(|s| !s.is_empty()).collect();
    let excludes: Vec<String> = exclude.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let mut tests = discover(&root, &filters);
    if !filters.is_empty() {
        tests.retain(|t| filters.iter().any(|f| t.starts_with(f)));
    }
    if !excludes.is_empty() {
        tests.retain(|t| !excludes.iter().any(|e| t.contains(e)));
    }
    if list {
        for t in &tests {
            println!("{t}");
        }
        eprintln!("{} tests", tests.len());
        return;
    }
    trace(&format!("run: {} tests discovered", tests.len()));
    // Children inherit these: host pinning and the test CA for wpt serve.
    let mut server_child = None;
    let base = if wptserve {
        std::env::set_var("JB_RESOLVE_HOSTS", WPT_HOSTS.join(","));
        std::env::set_var("JB_INSECURE_TLS", "1");
        std::env::set_var("JB_WPT_HTTPS_BASE", "https://web-platform.test:8443");
        match start_wptserve(&root) {
            Some((child, base)) => {
                server_child = child;
                base
            }
            None => std::process::exit(2),
        }
    } else {
        let port = start_server(root.clone());
        format!("http://127.0.0.1:{port}")
    };
    trace(&format!("run: server at {base}"));
    let jobs = if jobs == 0 { std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) } else { jobs };
    eprintln!("Running {} tests with {jobs} workers (server at {base})", tests.len());
    let queue = Arc::new(Mutex::new(tests.iter().cloned().collect::<VecDeque<_>>()));
    let results = Arc::new(Mutex::new(Vec::<TestResult>::new()));
    let total = tests.len();
    let exe = std::env::current_exe().expect("exe");
    let started = Instant::now();
    std::thread::scope(|s| {
        for _ in 0..jobs {
            let queue = queue.clone();
            let results = results.clone();
            let exe = exe.clone();
            let root = root.clone();
            let overrides = overrides.clone();
            let base = base.clone();
            s.spawn(move || loop {
                let test = match queue.lock().unwrap().pop_front() {
                    Some(t) => t,
                    None => break,
                };
                let mut budget = timeout_for(&test, timeout, &overrides);
                if long_timeout(&root, &test) {
                    budget = budget.max(timeout * 6); // wptrunner: long = 6x the default
                }
                trace(&format!("worker: start {test} (timeout {budget}s)"));
                let r = run_child(&exe, &root, &base, &test, budget);
                trace(&format!("worker: done {test} {}", r.status));
                let mut res = results.lock().unwrap();
                if verbose {
                    let (p, f) = count(&r);
                    eprintln!("[{}/{}] {} {} ({p} pass, {f} fail)", res.len() + 1, total, r.status, r.test);
                    for st in &r.subtests {
                        if st.status != "PASS" {
                            eprintln!("    {} {}: {}", st.status, st.name, st.message.lines().next().unwrap_or(""));
                        }
                    }
                    if !r.message.is_empty() {
                        eprintln!("    {}", r.message.lines().next().unwrap_or(""));
                    }
                } else if (res.len() + 1) % 50 == 0 {
                    eprintln!("  {}/{} ({:.0}s)", res.len() + 1, total, started.elapsed().as_secs_f64());
                }
                res.push(r);
                trace("worker: recorded");
            });
        }
    });
    trace("run: all workers finished");
    if let Some(mut child) = server_child {
        // wpt serve spawns one process per port: take the whole tree down.
        let _ = std::process::Command::new("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).output();
        let _ = child.kill();
        let _ = child.wait();
    }
    let mut results = Arc::try_unwrap(results).unwrap().into_inner().unwrap();
    results.sort_by(|a, b| a.test.cmp(&b.test));
    std::fs::write(&out, serde_json::to_string_pretty(&results).unwrap()).expect("write results");
    print_summary(&results, started.elapsed());
    eprintln!("results written to {}", out.display());
}

fn count(r: &TestResult) -> (usize, usize) {
    let p = r.subtests.iter().filter(|s| s.status == "PASS").count();
    (p, r.subtests.len() - p)
}

/// Spawns are serialized: on Windows the pipe handles of a child being
/// spawned are inheritable, and a sibling spawned at the same instant can
/// inherit the write end of its stdout, so the pipe never reaches EOF after
/// that child is killed and the runner hangs.
static SPAWN_LOCK: Mutex<()> = Mutex::new(());
/// How long to wait for a killed child's output before giving up on it.
const REAPER_GRACE: Duration = Duration::from_secs(3);

fn run_child(exe: &Path, root: &Path, base: &str, test: &str, timeout: u64) -> TestResult {
    let started = Instant::now();
    let spawned = {
        let _guard = SPAWN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::process::Command::new(exe)
            .args(["one", "--root"])
            .arg(root)
            .args(["--base", base, test])
            // the page's script budget follows the test's process budget (long tests get more)
            .env("JB_WPT_SCRIPT_BUDGET_MS", (timeout.saturating_mul(1000)).saturating_sub(3000).max(40_000).to_string())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
    };
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => return TestResult { test: test.into(), status: "CRASH".into(), message: format!("spawn failed: {e}"), subtests: vec![], duration_ms: 0 },
    };
    trace(&format!("child: spawned {test} pid {}", child.id()));
    let mut stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let deadline = Duration::from_secs(timeout);
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if started.elapsed() > deadline {
                    trace(&format!("child: killing {test}"));
                    let _ = child.kill();
                    let _ = child.wait();
                    trace(&format!("child: killed {test}"));
                    break None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => break None,
        }
    };
    trace(&format!("child: exited {test}, joining reader"));
    // A killed child's pipe may never close (see SPAWN_LOCK); do not wait
    // forever for output that will be discarded anyway.
    let output = if status.is_none() {
        let grace = Instant::now();
        while !reader.is_finished() && grace.elapsed() < REAPER_GRACE {
            std::thread::sleep(Duration::from_millis(20));
        }
        if reader.is_finished() { reader.join().unwrap_or_default() } else { String::new() }
    } else {
        reader.join().unwrap_or_default()
    };
    trace(&format!("child: reader joined {test}"));
    let duration_ms = started.elapsed().as_millis() as u64;
    match status {
        None => TestResult { test: test.into(), status: "TIMEOUT".into(), message: format!("killed after {timeout}s"), subtests: vec![], duration_ms },
        Some(st) if !st.success() => TestResult { test: test.into(), status: "CRASH".into(), message: format!("exit status {st}"), subtests: vec![], duration_ms },
        Some(_) => match serde_json::from_str::<TestResult>(output.trim().lines().last().unwrap_or("")) {
            Ok(mut r) => {
                r.duration_ms = duration_ms;
                r
            }
            Err(e) => TestResult { test: test.into(), status: "CRASH".into(), message: format!("bad output: {e}"), subtests: vec![], duration_ms },
        },
    }
}

fn print_summary(results: &[TestResult], elapsed: Duration) {
    #[derive(Default)]
    struct Agg {
        files: usize,
        files_ok: usize,
        subtests: usize,
        pass: usize,
        harness_fail: usize,
    }
    let mut by_dir: BTreeMap<String, Agg> = BTreeMap::new();
    let mut total = Agg::default();
    for r in results {
        let dir = r.test.split('/').next().unwrap_or("").to_string();
        let (p, _) = count(r);
        for a in [by_dir.entry(dir).or_default(), &mut total] {
            a.files += 1;
            a.subtests += r.subtests.len();
            a.pass += p;
            if r.status == "OK" {
                a.files_ok += 1;
            } else {
                a.harness_fail += 1;
            }
        }
    }
    let pct = |p: usize, t: usize| if t == 0 { 0.0 } else { p as f64 * 100.0 / t as f64 };
    eprintln!();
    eprintln!("{:<22} {:>6} {:>7} {:>9} {:>9} {:>8}", "suite", "files", "harnOK", "subtests", "pass", "pass%");
    for (dir, a) in &by_dir {
        eprintln!("{:<22} {:>6} {:>7} {:>9} {:>9} {:>7.1}%", dir, a.files, a.files_ok, a.subtests, a.pass, pct(a.pass, a.subtests));
    }
    eprintln!("{:<22} {:>6} {:>7} {:>9} {:>9} {:>7.1}%", "TOTAL", total.files, total.files_ok, total.subtests, total.pass, pct(total.pass, total.subtests));
    eprintln!("({} files with harness errors/timeouts/crashes; {:.0}s)", total.harness_fail, elapsed.as_secs_f64());
    let _ = json!({});
}

const TESTDRIVER_VENDOR_JS: &str = r##"// testdriver-vendor.js served by the julia-browser WPT runner: drives the
// page in-process instead of through WebDriver.
(function () {
  if (typeof window === "undefined" || !window.test_driver_internal) return;
  var td = window.test_driver_internal;
  td.in_automation = true;
  function fire(target, Ctor, type, init) {
    var boundary = /^(mouseenter|mouseleave|pointerenter|pointerleave)$/.test(type);
    var e = new Ctor(type, Object.assign({ bubbles: !boundary, cancelable: !boundary && type !== "pointerup" && type !== "pointercancel", composed: !boundary, view: window }, init || {}));
    __jb.setTrusted(e, true); e._trustedDispatch = true;
    return target.dispatchEvent(e);
  }
  // WebDriver commands are asynchronous: the events fire in a later task so a
  // caller's own bookkeeping after the call runs first (and nested calls from
  // event listeners never re-enter the dispatcher).
  function later(fn) { return new Promise(function (resolve, reject) { setTimeout(function () { try { resolve(fn()); } catch (e) { reject(e); } }, 0); }); }
  // Input goes through the browser's shared user-input layer (src/js/env/92_user.js).
  var U = __jb.user;
  td.click = function (element, coords) {
    return later(function () { U.click(element); });
  };
  // Cookie helpers over the host's real jar (cookies/ tests).
  // WebAuthn virtual authenticators (WebDriver extension), backed by __jb.webauthnDriver.
  var wa = function (fn) { return function () { var args = arguments; return later(function () { var d = __jb.webauthnDriver; if (!d) throw "error: Action add_virtual_authenticator not implemented"; return fn.apply(null, [d].concat(Array.prototype.slice.call(args))); }); }; };
  td.add_virtual_authenticator = wa(function (d, config) { return d.add(config); });
  td.remove_virtual_authenticator = wa(function (d, id) { d.remove(id); });
  td.add_credential = wa(function (d, id, cred) { return d.addCredential(id, cred); });
  td.get_credentials = wa(function (d, id) { return d.getCredentials(id); });
  td.remove_credential = wa(function (d, id, credId) { d.removeCredential(id, credId); });
  td.remove_all_credentials = wa(function (d, id) { d.removeAllCredentials(id); });
  td.set_user_verified = wa(function (d, id, uv) { d.setUserVerified(id, uv); });
  td.set_credential_properties = wa(function (d, id, credId, props) { d.setCredentialProperties(id, credId, props); });
  td.delete_all_cookies = function () { __jb.native("cookie", { op: "clear" }); return Promise.resolve(); };
  td.get_all_cookies = function () { return Promise.resolve(__jb.native("cookie", { op: "all" }) || []); };
  td.get_named_cookie = function (name) { var all = __jb.native("cookie", { op: "all" }) || []; var c = all.filter(function (x) { return x.name === name; })[0]; return c ? Promise.resolve(c) : Promise.reject(new Error("no such cookie")); };
  // WebDriver "perform actions": the serialized sources from testdriver-actions.js
  // are replayed tick by tick against the JS DOM (pointer, key and wheel sources).
  var KEY_BY_CODEPOINT = { "": "Backspace", "": "Tab", "": "Enter", "": "Enter", "": "Shift", "": "Control", "": "Alt", "": "Escape", "": " ", "": "PageUp", "": "PageDown", "": "End", "": "Home", "": "ArrowLeft", "": "ArrowUp", "": "ArrowRight", "": "ArrowDown", "": "Insert", "": "Delete", "": "Meta", "": "Shift", "": "Control", "": "Alt", "": "Meta" };
  function resolveOrigin(origin, x, y) {
    if (origin && typeof origin === "object" && origin.nodeType === 1) { var c = U.centerOf(origin); return { x: c.x + x, y: c.y + y }; }
    if (origin === "pointer") return { x: U.pointer.x + x, y: U.pointer.y + y };
    return { x: x, y: y };
  }
  function keyOf(ch) { return KEY_BY_CODEPOINT[ch] || ch; }
  td.action_sequence = function (sources) {
    return new Promise(function (resolve, reject) { setTimeout(function () {
      try {
        var ticks = 0;
        sources.forEach(function (s) { ticks = Math.max(ticks, (s.actions || []).length); });
        for (var t = 0; t < ticks; t++) {
          for (var si = 0; si < sources.length; si++) {
            var src = sources[si], a = (src.actions || [])[t];
            if (!a || a.type === "pause") continue;
            if (src.type === "pointer") {
              var params = src.parameters || { pointerType: "mouse" };
              if (a.type === "pointerMove") { var p = resolveOrigin(a.origin, a.x || 0, a.y || 0); U.movePointer(p.x, p.y, params); }
              else if (a.type === "pointerDown") U.press(a.button || 0, params);
              else if (a.type === "pointerUp") U.release(a.button || 0, params);
            } else if (src.type === "key") {
              if (a.type === "keyDown") U.keyDown(keyOf(a.value));
              else if (a.type === "keyUp") U.keyUp(keyOf(a.value));
            } else if (src.type === "wheel" && a.type === "scroll") {
              var wp = resolveOrigin(a.origin, a.x || 0, a.y || 0);
              var wel = U.elementAt(wp.x, wp.y);
              if (U.fire(wel, WheelEvent, "wheel", { clientX: wp.x, clientY: wp.y, deltaX: a.deltaX || 0, deltaY: a.deltaY || 0, deltaMode: 0 })) {
                var scroller = wel; while (scroller && scroller.nodeType === 1 && !(scroller.scrollHeight > scroller.clientHeight || scroller.scrollWidth > scroller.clientWidth)) scroller = scroller.parentNode;
                if (scroller && scroller.nodeType === 1 && scroller !== document.documentElement && scroller !== document.body) { scroller.scrollTop += a.deltaY || 0; scroller.scrollLeft += a.deltaX || 0; }
                else window.scrollBy(a.deltaX || 0, a.deltaY || 0);
              }
            }
          }
        }
        setTimeout(resolve, 0);
      } catch (e) { reject(e); }
    }, 0); });
  };
  td.send_keys = function (element, keys) {
    return later(function () {
      if (element && typeof element.focus === "function" && element !== document.documentElement && element !== document.body && document.activeElement !== element) element.focus();
      // WebDriver "send keys": modifier keys stay pressed (a second press or NULL releases
      // them) and are released at the end
      var held = [];
      var release = function (k) { var i = held.indexOf(k); if (i >= 0) { held.splice(i, 1); U.keyUp(k); } };
      Array.from(String(keys)).forEach(function (ch) {
        var k = keyOf(ch);
        if (ch === "") { held.slice().reverse().forEach(release); return; }
        if (/^(Shift|Control|Alt|Meta)$/.test(k)) { if (held.indexOf(k) >= 0) release(k); else { held.push(k); U.keyDown(k); } return; }
        U.keyDown(k); U.keyUp(k);
      });
      held.slice().reverse().forEach(release);
    });
  };
  td.set_permission = function (params) {
    var t = typeof __jb.topJb === "function" ? __jb.topJb() : __jb;
    var d = params && params.descriptor, name = d && (typeof d === "string" ? d : d.name);
    if (!name) return Promise.reject(new TypeError("set_permission: descriptor has no name"));
    try { if (__jb.setPermission) __jb.setPermission(String(name), String(params.state)); else (t.permissionStates || (t.permissionStates = {}))[String(name)] = String(params.state); } catch (e) { return Promise.reject(e); }
    return Promise.resolve();
  };
  // WebDriver BiDi: permissions and emulation (geolocation, screen orientation).
  var topJb = function () { return typeof __jb.topJb === "function" ? __jb.topJb() : __jb; };
  td.bidi = td.bidi || {};
  td.bidi.permissions = td.bidi.permissions || {};
  td.bidi.permissions.set_permission = function (params) { return td.set_permission({ descriptor: params && params.descriptor, state: params && params.state }); };
  td.bidi.emulation = td.bidi.emulation || {};
  td.bidi.emulation.set_geolocation_override = function (params) {
    return later(function () {
      var t = topJb();
      if (params && params.coordinates) t.geoOverride = params.coordinates;
      else if (params && params.error) t.geoOverride = null;
      else delete t.geoOverride;
    });
  };
  td.bidi.emulation.set_screen_orientation_override = function (params) {
    return later(function () {
      var t = topJb(), so = params && params.screenOrientation;
      var ANGLES = { portrait: { "portrait-primary": 0, "landscape-primary": 90, "portrait-secondary": 180, "landscape-secondary": 270 }, landscape: { "landscape-primary": 0, "portrait-primary": 90, "landscape-secondary": 180, "portrait-secondary": 270 } };
      t.orientationOverride = so ? { type: so.type, angle: (ANGLES[so.natural] || ANGLES.landscape)[so.type] || 0 } : null;
      if (__jb.screenOrientationChanged) __jb.screenOrientationChanged();
    });
  };
  td.get_window_rect = function () { return Promise.resolve({ x: window.screenX || 0, y: window.screenY || 0, width: window.outerWidth || 1280, height: window.outerHeight || 720 }); };
  // Virtual sensors (generic sensors, device orientation / motion) and compute pressure sources.
  var sensors = function () { var t = topJb(); return t.virtualSensors || (t.virtualSensors = {}); };
  td.create_virtual_sensor = function (type, params) {
    return later(function () {
      var s = sensors();
      if (s[type]) throw "error: invalid argument: virtual sensor already exists";
      s[type] = { connected: !(params && params.connected === false), reading: null, minSamplingFrequency: params && params.minSamplingFrequency, maxSamplingFrequency: params && params.maxSamplingFrequency };
    });
  };
  td.update_virtual_sensor = function (type, reading) {
    return later(function () {
      var s = sensors()[type];
      if (!s) throw "error: invalid argument: no virtual sensor of that type";
      s.reading = reading;
      if (__jb.virtualSensorReading) __jb.virtualSensorReading(type, reading);
    });
  };
  td.remove_virtual_sensor = function (type) { return later(function () { delete sensors()[type]; }); };
  td.get_virtual_sensor_information = function (type) {
    return later(function () { var s = sensors()[type]; if (!s) throw "error: invalid argument: no virtual sensor of that type"; return { requestedSamplingFrequency: 60 }; });
  };
  var pressure = function () { var t = topJb(); return t.virtualPressure || (t.virtualPressure = {}); };
  td.create_virtual_pressure_source = function (type, metadata) {
    return later(function () { var p = pressure(); if (p[type]) throw "error: invalid argument: pressure source already exists"; p[type] = { supported: !(metadata && metadata.supported === false), sample: null }; });
  };
  td.update_virtual_pressure_source = function (type, sample, estimate) {
    return later(function () { var p = pressure()[type]; if (!p) throw "error: invalid argument: no pressure source of that type"; p.sample = sample; p.estimate = estimate; if (__jb.virtualPressureUpdate) __jb.virtualPressureUpdate(type, sample, estimate); });
  };
  td.remove_virtual_pressure_source = function (type) { return later(function () { delete pressure()[type]; }); };
  // Accessibility: computed role (explicit role token, ElementInternals role, implicit HTML role)
  // and computed name (aria-labelledby, aria-label, internals ariaLabel, labels, alt/title, content).
  var ROLE_ALIASES = { directory: "list", img: "image" };
  var ARIA_ROLES = "alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox comment complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img image insertion link list listbox listitem log main mark marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript suggestion superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem".split(" ");
  function implicitRole(el) {
    if (!el || el.nodeType !== 1) return "";
    var t = el.localName, a = function (n) { return el.hasAttribute(n); };
    switch (t) {
      case "a": case "area": return a("href") ? "link" : "generic";
      case "article": return "article"; case "aside": return "complementary"; case "button": return "button";
      case "dialog": return "dialog"; case "fieldset": return "group"; case "figure": return "figure";
      case "footer": return el.closest("article,aside,main,nav,section") ? "generic" : "contentinfo";
      case "header": return el.closest("article,aside,main,nav,section") ? "generic" : "banner";
      case "form": return "form"; case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
      case "hr": return "separator"; case "img": return el.getAttribute("alt") === "" ? "presentation" : "image";
      case "li": return "listitem"; case "main": return "main"; case "math": return "math"; case "menu": case "ol": case "ul": return "list";
      case "nav": return "navigation"; case "meter": return "meter"; case "progress": return "progressbar"; case "option": return "option";
      case "output": return "status"; case "p": return "paragraph"; case "search": return "search"; case "section": return "region";
      case "select": return a("multiple") || (+el.getAttribute("size") > 1) ? "listbox" : "combobox";
      case "table": return "table"; case "tbody": case "thead": case "tfoot": return "rowgroup"; case "tr": return "row";
      case "td": return "cell"; case "th": return "columnheader"; case "textarea": return "textbox"; case "dd": return "definition"; case "dt": return "term";
      case "details": return "group"; case "summary": return "button"; case "blockquote": return "blockquote"; case "code": return "code";
      case "del": return "deletion"; case "ins": return "insertion"; case "em": return "emphasis"; case "strong": return "strong"; case "mark": return "mark";
      case "sub": return "subscript"; case "sup": return "superscript"; case "time": return "time"; case "caption": return "caption";
      case "html": return "document"; case "body": case "div": case "span": case "b": case "i": case "u": case "s": case "small": case "pre": case "address": case "hgroup": return "generic";
      case "input": {
        var ty = (el.getAttribute("type") || "text").toLowerCase();
        if (/^(button|image|reset|submit)$/.test(ty)) return "button";
        if (ty === "checkbox") return a("switch") ? "switch" : "checkbox"; if (ty === "radio") return "radio"; if (ty === "range") return "slider"; if (ty === "number") return "spinbutton";
        if (ty === "search") return a("list") ? "combobox" : "searchbox";
        if (/^(text|email|tel|url)$/.test(ty) || ty === "") return a("list") ? "combobox" : "textbox";
        return "";
      }
    }
    return "";
  }
  function computedRole(el) {
    var explicit = (el.getAttribute && el.getAttribute("role") || "").trim().toLowerCase().split(/\s+/).filter(function (r) { return ARIA_ROLES.indexOf(r) >= 0; })[0];
    var r = explicit;
    if (!r) { var i = typeof __jb.internalsOf === "function" ? __jb.internalsOf(el) : null; var ir = i && i._aria && i._aria.role; if (ir) r = String(ir).trim().toLowerCase().split(/\s+/)[0]; }
    if (!r) r = implicitRole(el);
    if (r === "none") r = "presentation";
    return ROLE_ALIASES[r] || r || "";
  }
  function computedLabel(el) {
    var txt = function (n) { return (n.textContent || "").replace(/\s+/g, " ").trim(); };
    var lb = el.getAttribute && el.getAttribute("aria-labelledby");
    if (lb) { var parts = lb.trim().split(/\s+/).map(function (id) { var t = el.ownerDocument.getElementById(id); return t ? (t.getAttribute("aria-label") || txt(t)) : ""; }).filter(Boolean); if (parts.length) return parts.join(" "); }
    var al = el.getAttribute && el.getAttribute("aria-label");
    if (al && al.trim()) return al.trim();
    var i = typeof __jb.internalsOf === "function" ? __jb.internalsOf(el) : null;
    if (i && i._aria && i._aria.ariaLabel) return String(i._aria.ariaLabel).trim();
    if (el.labels && el.labels.length) return Array.from(el.labels).map(txt).join(" ");
    if (el.localName === "img" || (el.localName === "input" && /^image$/i.test(el.getAttribute("type") || ""))) { var alt = el.getAttribute("alt"); if (alt) return alt.trim(); }
    if (el.localName === "input" && /^(button|submit|reset)$/i.test(el.getAttribute("type") || "")) return el.value || "";
    var role = computedRole(el);
    if (/^(button|cell|checkbox|columnheader|gridcell|heading|link|menuitem|menuitemcheckbox|menuitemradio|option|radio|row|rowheader|switch|tab|tooltip|treeitem)$/.test(role)) { var c = txt(el); if (c) return c; }
    var title = el.getAttribute && el.getAttribute("title");
    return title ? title.trim() : "";
  }
  td.get_computed_role = function (el) { return Promise.resolve(computedRole(el)); };
  td.get_computed_label = function (el) { return Promise.resolve(computedLabel(el)); };
  td.freeze = function () { return Promise.resolve(); };
  td.minimize_window = function () { return Promise.resolve({}); };
  td.set_window_rect = function () { return Promise.resolve({}); };
})();
"##;
