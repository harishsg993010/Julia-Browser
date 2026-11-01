//! CDP `Network` and `Fetch` domains of one page target, on top of the HTTP client's request hook
//! ([`crate::http::NetHook`]).
//!
//! - `Network`: once enabled, every request the page makes (document, scripts, styles, images,
//!   fetch/XHR) produces `requestWillBeSent` / `responseReceived` / `loadingFinished` or
//!   `loadingFailed`, with one request id across a redirect chain. Response bodies are kept (bounded)
//!   for `Network.getResponseBody`. `emulateNetworkConditions({offline: true})` and `setBlockedURLs`
//!   fail matching requests.
//! - `Fetch`: with `Fetch.enable`, requests matching its patterns stop before they are sent and a
//!   `Fetch.requestPaused` event goes out; the request thread waits until `continueRequest`,
//!   `fulfillRequest` or `failRequest` names it. Those commands are answered on the connection
//!   thread (the page thread may be the one waiting), as are `enable` / `disable` here. Only the
//!   request stage is supported: `requestStage: "Response"` patterns are rejected.

use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::{event, hex_id, mono, now_secs};
use crate::http::{HttpError, HttpResponse, NetDecision, NetHook, NetRequest};

/// Bodies kept for `Network.getResponseBody`.
const MAX_BODIES: usize = 200;
const MAX_BODY_BYTES: usize = 64 << 20;
/// How long a paused request waits for the client before it fails.
const PAUSE_LIMIT: Duration = Duration::from_secs(300);

pub type Sinks = Arc<Mutex<Vec<(Option<String>, Sender<String>)>>>;

struct Pattern {
    url: Option<String>,
    resource_type: Option<String>,
}

#[derive(Default)]
struct State {
    network: bool,
    offline: bool,
    blocked: Vec<String>,
    fetch: Option<Vec<Pattern>>,
    /// The current document's loader id (requests carry it).
    loader: String,
    /// Request id of the last top-level document request (it becomes the new loader id).
    doc_request: Option<String>,
    /// Redirect target URL -> (request id, redirect response JSON) of a hop still to come.
    redirects: HashMap<String, (String, Value)>,
    /// NetRequest id -> CDP request id.
    ids: HashMap<u64, String>,
    bodies: VecDeque<(String, Vec<u8>, bool)>,
    body_bytes: usize,
    next_interception: u64,
}

pub struct CdpNet {
    frame_id: String,
    sinks: Sinks,
    state: Mutex<State>,
    /// interception id -> the waiting request thread
    paused: Mutex<HashMap<String, (Sender<NetDecision>, String)>>,
}

fn resource_type(req: &NetRequest) -> &'static str {
    match req.dest.as_str() {
        "document" | "iframe" | "frame" => "Document",
        "script" | "worker" | "sharedworker" | "serviceworker" | "audioworklet" | "paintworklet" => "Script",
        "style" => "Stylesheet",
        "image" => "Image",
        "font" => "Font",
        "audio" | "video" | "track" => "Media",
        "manifest" => "Manifest",
        "empty" => {
            if req.headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("x-requested-with") && v.eq_ignore_ascii_case("XMLHttpRequest")) {
                "XHR"
            } else {
                "Fetch"
            }
        }
        _ => "Other",
    }
}

/// CDP URL pattern: `*` any run, `?` one character, `\` escapes.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    fn go(p: &[char], t: &[char]) -> bool {
        let (mut pi, mut ti, mut star, mut mark) = (0usize, 0usize, None::<usize>, 0usize);
        while ti < t.len() {
            if pi < p.len() && p[pi] == '\\' && pi + 1 < p.len() && p[pi + 1] == t[ti] {
                pi += 2;
                ti += 1;
            } else if pi < p.len() && (p[pi] == '?' || (p[pi] != '*' && p[pi] != '\\' && p[pi] == t[ti])) {
                pi += 1;
                ti += 1;
            } else if pi < p.len() && p[pi] == '*' {
                star = Some(pi);
                mark = ti;
                pi += 1;
            } else if let Some(s) = star {
                pi = s + 1;
                mark += 1;
                ti = mark;
            } else {
                return false;
            }
        }
        while pi < p.len() && p[pi] == '*' {
            pi += 1;
        }
        pi == p.len()
    }
    go(&p, &t)
}

fn headers_obj(h: &std::collections::BTreeMap<String, String>) -> Value {
    Value::Object(h.iter().map(|(k, v)| (k.clone(), json!(v))).collect())
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s.trim()).ok()
}

fn mime_of(headers: &std::collections::BTreeMap<String, String>) -> String {
    headers.get("content-type").map(|c| c.split(';').next().unwrap_or("").trim().to_ascii_lowercase()).filter(|m| !m.is_empty()).unwrap_or_else(|| "text/plain".into())
}

fn is_text_mime(m: &str) -> bool {
    m.starts_with("text/") || m.contains("json") || m.contains("javascript") || m.contains("xml") || m.contains("ecmascript") || m == "image/svg+xml" || m.ends_with("+json")
}

/// Network error text of a failed request, Chrome style.
fn error_text(e: &HttpError) -> String {
    match e {
        HttpError::Timeout(_) => "net::ERR_TIMED_OUT".into(),
        HttpError::Connection(m) if m.contains("dns") || m.contains("resolve") => "net::ERR_NAME_NOT_RESOLVED".into(),
        HttpError::Connection(_) => "net::ERR_CONNECTION_REFUSED".into(),
        HttpError::Other(m) if m.starts_with("net::") => m.clone(),
        HttpError::Other(m) if m.contains("dns") || m.contains("resolve") || m.contains("No such host") => "net::ERR_NAME_NOT_RESOLVED".into(),
        HttpError::Other(m) if m.contains("refused") => "net::ERR_CONNECTION_REFUSED".into(),
        _ => "net::ERR_FAILED".into(),
    }
}

/// `Fetch.failRequest` errorReason -> network error.
fn fail_reason(r: &str) -> Option<&'static str> {
    Some(match r {
        "Failed" => "net::ERR_FAILED",
        "Aborted" => "net::ERR_ABORTED",
        "TimedOut" => "net::ERR_TIMED_OUT",
        "AccessDenied" => "net::ERR_ACCESS_DENIED",
        "ConnectionClosed" => "net::ERR_CONNECTION_CLOSED",
        "ConnectionReset" => "net::ERR_CONNECTION_RESET",
        "ConnectionRefused" => "net::ERR_CONNECTION_REFUSED",
        "ConnectionAborted" => "net::ERR_CONNECTION_ABORTED",
        "ConnectionFailed" => "net::ERR_CONNECTION_FAILED",
        "NameNotResolved" => "net::ERR_NAME_NOT_RESOLVED",
        "InternetDisconnected" => "net::ERR_INTERNET_DISCONNECTED",
        "AddressUnreachable" => "net::ERR_ADDRESS_UNREACHABLE",
        "BlockedByClient" => "net::ERR_BLOCKED_BY_CLIENT",
        "BlockedByResponse" => "net::ERR_BLOCKED_BY_RESPONSE",
        _ => return None,
    })
}

fn reason_phrase(code: u16) -> &'static str {
    match code {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "",
    }
}

impl CdpNet {
    pub fn new(frame_id: String, sinks: Sinks) -> Self {
        CdpNet { frame_id, sinks, state: Mutex::new(State { loader: hex_id(32), ..Default::default() }), paused: Mutex::new(HashMap::new()) }
    }

    fn emit(&self, method: &str, params: Value) {
        self.sinks.lock().unwrap().retain(|(s, out)| out.send(event(method, params.clone(), s.as_deref())).is_ok());
    }

    pub fn network_enabled(&self) -> bool {
        self.state.lock().unwrap().network
    }

    /// The loader id for a new document: the id of its document request when it went through
    /// the network hook (its Network events are out already), else a fresh one.
    pub fn begin_document(&self) -> (String, bool) {
        let mut st = self.state.lock().unwrap();
        let (id, live) = match st.doc_request.take() {
            Some(id) => (id, true),
            None => (hex_id(32), false),
        };
        st.loader = id.clone();
        (id, live)
    }

    /// Forget the pending document request (before a navigation starts).
    pub fn reset_document(&self) {
        self.state.lock().unwrap().doc_request = None;
    }

    /// Fail every paused request (target closing, `Fetch.disable`).
    pub fn release_all(&self, decision: impl Fn() -> NetDecision) {
        let waiting: Vec<Sender<NetDecision>> = self.paused.lock().unwrap().drain().map(|(_, (tx, _))| tx).collect();
        for tx in waiting {
            let _ = tx.send(decision());
        }
    }

    /// Network / Fetch commands answered without the page thread. `None`: not one of them.
    pub fn command(&self, method: &str, p: &Value) -> Option<Result<Value, String>> {
        let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        Some(match method {
            "Network.enable" => {
                self.state.lock().unwrap().network = true;
                Ok(json!({}))
            }
            "Network.disable" => {
                let mut st = self.state.lock().unwrap();
                st.network = false;
                st.bodies.clear();
                st.body_bytes = 0;
                Ok(json!({}))
            }
            "Network.emulateNetworkConditions" => {
                self.state.lock().unwrap().offline = p.get("offline").and_then(Value::as_bool).unwrap_or(false);
                Ok(json!({}))
            }
            "Network.setBlockedURLs" => {
                let list = p.get("urls").or_else(|| p.get("urlPatterns")).and_then(Value::as_array).cloned().unwrap_or_default();
                self.state.lock().unwrap().blocked = list.iter().filter_map(|u| u.as_str().or_else(|| u.get("urlPattern").and_then(Value::as_str)).map(str::to_string)).collect();
                Ok(json!({}))
            }
            "Network.getResponseBody" => {
                let id = s("requestId");
                let st = self.state.lock().unwrap();
                match st.bodies.iter().rev().find(|(r, _, _)| *r == id) {
                    Some((_, body, true)) => Ok(json!({"body": b64(body), "base64Encoded": true})),
                    Some((_, body, false)) => Ok(json!({"body": String::from_utf8_lossy(body), "base64Encoded": false})),
                    None => Err("No resource with given identifier found".into()),
                }
            }
            "Fetch.enable" => {
                let mut patterns = Vec::new();
                match p.get("patterns").and_then(Value::as_array) {
                    None => patterns.push(Pattern { url: None, resource_type: None }),
                    Some(list) => {
                        for pat in list {
                            if pat.get("requestStage").and_then(Value::as_str) == Some("Response") {
                                return Some(Err("Fetch interception at the response stage is not supported".into()));
                            }
                            patterns.push(Pattern { url: pat.get("urlPattern").and_then(Value::as_str).map(str::to_string), resource_type: pat.get("resourceType").and_then(Value::as_str).map(str::to_string) });
                        }
                    }
                }
                if p.get("handleAuthRequests").and_then(Value::as_bool) == Some(true) {
                    // auth challenges are never paused; requests still are
                }
                self.state.lock().unwrap().fetch = Some(patterns);
                Ok(json!({}))
            }
            "Fetch.disable" => {
                self.state.lock().unwrap().fetch = None;
                self.release_all(|| NetDecision::Continue { url: None, method: None, headers: None, body: None });
                Ok(json!({}))
            }
            "Fetch.continueRequest" | "Fetch.fulfillRequest" | "Fetch.failRequest" | "Fetch.continueWithAuth" => {
                let id = s("requestId");
                let decision = match method {
                    "Fetch.continueRequest" => {
                        let headers = p.get("headers").and_then(Value::as_array).map(|a| {
                            a.iter().filter_map(|h| Some((h.get("name")?.as_str()?.to_string(), h.get("value")?.as_str()?.to_string()))).collect::<std::collections::BTreeMap<_, _>>()
                        });
                        let body = match p.get("postData").and_then(Value::as_str) {
                            Some(d) => match unb64(d) {
                                Some(b) => Some(b),
                                None => return Some(Err("Invalid postData: not base64".into())),
                            },
                            None => None,
                        };
                        let url = Some(s("url")).filter(|u| !u.is_empty());
                        if let Some(u) = &url {
                            if url::Url::parse(u).is_err() {
                                return Some(Err("Invalid URL".into()));
                            }
                        }
                        NetDecision::Continue { url, method: Some(s("method")).filter(|m| !m.is_empty()), headers, body }
                    }
                    "Fetch.fulfillRequest" => {
                        let code = p.get("responseCode").and_then(Value::as_u64).unwrap_or(0) as u16;
                        if !(100..=999).contains(&code) {
                            return Some(Err("Invalid http status code or phrase".into()));
                        }
                        let mut headers = std::collections::BTreeMap::new();
                        for h in p.get("responseHeaders").and_then(Value::as_array).into_iter().flatten() {
                            if let (Some(n), Some(v)) = (h.get("name").and_then(Value::as_str), h.get("value").and_then(Value::as_str)) {
                                let k = n.to_ascii_lowercase();
                                match headers.get_mut(&k) {
                                    Some(old) => {
                                        let sep = if k == "set-cookie" { "\n" } else { ", " };
                                        *old = format!("{old}{sep}{v}");
                                    }
                                    None => {
                                        headers.insert(k, v.to_string());
                                    }
                                }
                            }
                        }
                        if let Some(bin) = p.get("binaryResponseHeaders").and_then(Value::as_str).and_then(unb64) {
                            // NUL-separated name:value pairs
                            for pair in String::from_utf8_lossy(&bin).split('\0') {
                                if let Some((n, v)) = pair.split_once(':') {
                                    headers.insert(n.trim().to_ascii_lowercase(), v.trim().to_string());
                                }
                            }
                        }
                        let body = match p.get("body").and_then(Value::as_str) {
                            Some(b) => match unb64(b) {
                                Some(v) => v,
                                None => return Some(Err("Invalid body: not base64".into())),
                            },
                            None => Vec::new(),
                        };
                        let phrase = Some(s("responsePhrase")).filter(|r| !r.is_empty()).unwrap_or_else(|| reason_phrase(code).to_string());
                        let url = self.paused.lock().unwrap().get(&id).map(|(_, u)| u.clone()).unwrap_or_default();
                        let (text, encoding) = crate::http::decode_body(&body, headers.get("content-type").map(String::as_str).unwrap_or(""));
                        NetDecision::Fulfill(HttpResponse { status: code, reason: phrase, url, headers, text, body, encoding, elapsed: Duration::ZERO })
                    }
                    "Fetch.failRequest" => match fail_reason(&s("errorReason")) {
                        Some(r) => NetDecision::Fail(r.to_string()),
                        None => return Some(Err("Invalid errorReason".into())),
                    },
                    _ => return Some(Err("Invalid InterceptionId.".into())), // no auth challenge is ever paused
                };
                match self.paused.lock().unwrap().remove(&id) {
                    Some((tx, _)) => {
                        let _ = tx.send(decision);
                        Ok(json!({}))
                    }
                    None => Err("Invalid InterceptionId.".into()),
                }
            }
            "Fetch.getResponseBody" | "Fetch.continueResponse" | "Fetch.takeResponseBodyAsStream" => Err("Can only get response body on HeadersReceived pattern matched request.".into()),
            _ => return None,
        })
    }

    fn request_json(req: &NetRequest) -> Value {
        let mut r = json!({
            "url": req.url, "method": req.method, "headers": headers_obj(&req.headers),
            "initialPriority": "High", "referrerPolicy": "strict-origin-when-cross-origin", "mixedContentType": "none",
        });
        if let Some(b) = &req.body {
            r["hasPostData"] = json!(true);
            r["postData"] = json!(String::from_utf8_lossy(b));
            r["postDataEntries"] = json!([{"bytes": b64(b)}]);
        }
        r
    }

    fn response_json(&self, resp: &HttpResponse) -> Value {
        json!({
            "url": resp.url, "status": resp.status, "statusText": resp.reason, "headers": headers_obj(&resp.headers),
            "mimeType": mime_of(&resp.headers), "charset": "utf-8", "connectionReused": false, "connectionId": 0,
            "fromDiskCache": false, "fromServiceWorker": false, "fromPrefetchCache": false,
            "encodedDataLength": resp.body.len(), "securityState": if resp.url.starts_with("https:") { "secure" } else { "insecure" },
            "protocol": "http/1.1", "remoteIPAddress": "", "remotePort": 0,
        })
    }
}

impl NetHook for CdpNet {
    fn active(&self) -> bool {
        let st = self.state.lock().unwrap();
        st.network || st.offline || !st.blocked.is_empty() || st.fetch.is_some()
    }

    fn before(&self, req: &NetRequest) -> NetDecision {
        let go = NetDecision::Continue { url: None, method: None, headers: None, body: None };
        let rtype = resource_type(req);
        let top_doc = req.dest == "document";
        let (network, fail, intercept, rid, loader, redirect) = {
            let mut st = self.state.lock().unwrap();
            if !st.network && !st.offline && st.blocked.is_empty() && st.fetch.is_none() && !top_doc {
                return go;
            }
            // a redirect hop keeps the request id of the chain
            let redirect = st.redirects.remove(&req.url);
            let rid = match &redirect {
                Some((id, _)) => id.clone(),
                None if top_doc => hex_id(32),
                None => format!("{}.{}", std::process::id(), req.id),
            };
            if top_doc {
                st.doc_request = Some(rid.clone());
            }
            st.ids.insert(req.id, rid.clone());
            let web = req.url.starts_with("http:") || req.url.starts_with("https:");
            let fail = if st.offline && web {
                Some("net::ERR_INTERNET_DISCONNECTED")
            } else if st.blocked.iter().any(|b| glob_match(b, &req.url) || (!b.contains('*') && req.url.contains(b.as_str()))) {
                Some("net::ERR_BLOCKED_BY_CLIENT")
            } else {
                None
            };
            let intercept = st.fetch.as_ref().map_or(false, |pats| {
                pats.iter().any(|p| p.url.as_deref().map_or(true, |u| glob_match(u, &req.url)) && p.resource_type.as_deref().map_or(true, |t| t == rtype))
            }) && fail.is_none();
            let interception = if intercept {
                st.next_interception += 1;
                Some(format!("interception-job-{}.0", st.next_interception))
            } else {
                None
            };
            let loader = if top_doc { rid.clone() } else { st.loader.clone() };
            (st.network, fail, interception, rid, loader, redirect)
        };
        if network {
            let mut p = json!({
                "requestId": rid, "loaderId": loader, "documentURL": req.url, "frameId": self.frame_id, "type": rtype,
                "request": Self::request_json(req), "timestamp": mono(), "wallTime": now_secs(),
                "initiator": {"type": if top_doc { "other" } else { "script" }}, "redirectHasExtraInfo": false, "hasUserGesture": false,
            });
            if let Some((_, resp)) = redirect {
                p["redirectResponse"] = resp;
            }
            self.emit("Network.requestWillBeSent", p);
        }
        if let Some(reason) = fail {
            return NetDecision::Fail(reason.to_string());
        }
        let Some(iid) = intercept else { return go };
        let (tx, rx) = mpsc::channel();
        self.paused.lock().unwrap().insert(iid.clone(), (tx, req.url.clone()));
        self.emit("Fetch.requestPaused", json!({
            "requestId": iid, "request": Self::request_json(req), "frameId": self.frame_id, "resourceType": rtype, "networkId": rid,
        }));
        match rx.recv_timeout(PAUSE_LIMIT) {
            Ok(NetDecision::Fulfill(mut resp)) => {
                if resp.url.is_empty() {
                    resp.url = req.url.clone();
                }
                NetDecision::Fulfill(resp)
            }
            Ok(d) => d,
            Err(_) => {
                self.paused.lock().unwrap().remove(&iid);
                NetDecision::Fail("net::ERR_ABORTED".into())
            }
        }
    }

    fn after(&self, req: &NetRequest, result: &Result<HttpResponse, HttpError>, _from_network: bool) {
        let (network, rid) = {
            let mut st = self.state.lock().unwrap();
            let Some(rid) = st.ids.remove(&req.id) else { return };
            (st.network, rid)
        };
        let rtype = resource_type(req);
        match result {
            Ok(resp) => {
                let redirect_to = if (300..400).contains(&resp.status) { resp.headers.get("location").and_then(|l| url::Url::parse(&req.url).ok()?.join(l).ok()).map(|u| u.to_string()) } else { None };
                let rjson = self.response_json(resp);
                if let Some(next) = redirect_to {
                    // the caller follows this hop with a new request: same id, redirectResponse
                    let mut st = self.state.lock().unwrap();
                    if st.redirects.len() > 100 {
                        st.redirects.clear();
                    }
                    st.redirects.insert(next, (rid, rjson));
                    return;
                }
                if !network {
                    return;
                }
                let loader = if req.dest == "document" { rid.clone() } else { self.state.lock().unwrap().loader.clone() };
                self.emit("Network.responseReceived", json!({
                    "requestId": rid, "loaderId": loader, "frameId": self.frame_id, "type": rtype, "timestamp": mono(), "hasExtraInfo": false, "response": rjson,
                }));
                {
                    let mut st = self.state.lock().unwrap();
                    let binary = !is_text_mime(&mime_of(&resp.headers));
                    st.body_bytes += resp.body.len();
                    st.bodies.push_back((rid.clone(), resp.body.clone(), binary));
                    while st.bodies.len() > MAX_BODIES || st.body_bytes > MAX_BODY_BYTES {
                        match st.bodies.pop_front() {
                            Some((_, b, _)) => st.body_bytes -= b.len(),
                            None => break,
                        }
                    }
                }
                self.emit("Network.dataReceived", json!({"requestId": rid, "timestamp": mono(), "dataLength": resp.body.len(), "encodedDataLength": resp.body.len()}));
                self.emit("Network.loadingFinished", json!({"requestId": rid, "timestamp": mono(), "encodedDataLength": resp.body.len()}));
            }
            Err(e) => {
                if !network {
                    return;
                }
                let text = error_text(e);
                let mut p = json!({"requestId": rid, "timestamp": mono(), "type": rtype, "errorText": text, "canceled": text == "net::ERR_ABORTED"});
                if text == "net::ERR_BLOCKED_BY_CLIENT" {
                    p["blockedReason"] = json!("inspector");
                }
                self.emit("Network.loadingFailed", p);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_globs() {
        assert!(glob_match("*", "https://a.test/x"));
        assert!(glob_match("*.png", "https://a.test/img/x.png"));
        assert!(!glob_match("*.png", "https://a.test/img/x.png?y"));
        assert!(glob_match("https://a.test/?", "https://a.test/x"));
        assert!(glob_match("*api*", "https://a.test/api/v1"));
        assert!(glob_match("a\\*b", "a*b"));
        assert!(!glob_match("a\\*b", "axb"));
    }
}
