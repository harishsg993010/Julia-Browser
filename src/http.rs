//! HTTP client: a cookie-persisting session shared by the engine, the form
//! submission code and the JavaScript `fetch`/`XMLHttpRequest`/`document.cookie`
//! bridges.

use reqwest::blocking::{Client, Response as ReqResponse};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest_cookie_store::CookieStoreMutex;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::Duration;
use url::Url;

pub const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// A fully-read HTTP response.
/// MIME Sniffing Standard "JavaScript MIME type essence match".
pub fn is_javascript_mime(essence: &str) -> bool {
    matches!(
        essence,
        "application/ecmascript" | "application/javascript" | "application/x-ecmascript" | "application/x-javascript" | "text/ecmascript"
            | "text/javascript" | "text/javascript1.0" | "text/javascript1.1" | "text/javascript1.2" | "text/javascript1.3"
            | "text/javascript1.4" | "text/javascript1.5" | "text/jscript" | "text/livescript" | "text/x-ecmascript" | "text/x-javascript"
    )
}

#[derive(Debug, Clone, Default)]
pub struct HttpResponse {
    pub status: u16,
    pub reason: String,
    /// Final URL after redirects.
    pub url: String,
    /// Lower-cased header names.
    pub headers: BTreeMap<String, String>,
    /// Body decoded as UTF-8 (lossy for binary payloads).
    pub text: String,
    /// Raw body bytes.
    pub body: Vec<u8>,
    /// Canonical name of the encoding `text` was decoded with (e.g. "UTF-8").
    pub encoding: String,
    pub elapsed: Duration,
}

impl HttpResponse {
    pub fn content_type(&self) -> String {
        self.headers.get("content-type").cloned().unwrap_or_default().to_ascii_lowercase()
    }
    pub fn ok(&self) -> bool {
        self.status < 400
    }
    /// Whether the body should be treated as binary (images, fonts, archives, wasm, ...).
    pub fn is_binary(&self) -> bool {
        let ct = self.content_type();
        let textual = ct.is_empty()
            || ct.starts_with("text/")
            || ct.contains("json")
            || ct.contains("xml")
            || ct.contains("javascript")
            || ct.contains("ecmascript")
            || ct.contains("x-www-form-urlencoded")
            || ct.contains("csv")
            || ct.contains("svg");
        if textual {
            // Text in a legacy encoding is still text; only an unknown type
            // with non-UTF-8 bytes is treated as binary.
            return ct.is_empty() && std::str::from_utf8(&self.body).is_err();
        }
        true
    }
}

/// Errors surfaced by the client, mapped to the same categories the Python
/// version reported.
#[derive(Debug, thiserror::Error)]
pub enum HttpError {
    #[error("Request timeout after {0} seconds")]
    Timeout(u64),
    #[error("Connection error: Could not connect to {0}")]
    Connection(String),
    #[error("HTTP error {status}: {reason}")]
    Status { status: u16, reason: String },
    #[error("Request error: {0}")]
    Other(String),
}

/// A cloneable HTTP session (shared cookie jar + default headers).
#[derive(Clone)]
pub struct HttpClient {
    inner: Arc<RwLock<Client>>,
    /// Same client without redirect following (requests that set per-hop fetch metadata).
    manual: Arc<RwLock<Client>>,
    /// No redirects and no automatic cookies: requests with fetch metadata get their Cookie header
    /// (and store Set-Cookie) here, with SameSite applied.
    bare: Arc<RwLock<Client>>,
    jar: Arc<CookieStoreMutex>,
    default_headers: Arc<RwLock<BTreeMap<String, String>>>,
    user_agent: Arc<RwLock<String>>,
    prefetch: Arc<Prefetch>,
    /// Completed subresource requests, for Resource Timing (drained by the page's realms).
    timings: Arc<Mutex<Vec<ResourceRecord>>>,
    /// Responses of `<link rel=preload>` requests, keyed "dest|mode|url": the next matching
    /// request consumes one instead of going to the network.
    preloaded: Arc<Mutex<std::collections::HashMap<String, (std::time::Instant, HttpResponse)>>>,
}

// Test-page switches shared by every client of the process (anonymous / per-request clients too).
static SUBRESOURCE_LINK_PRELOADS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static NEL_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Network Error Logging (test pages): Reporting endpoints and NEL policies per origin.
static NEL_STATE: std::sync::OnceLock<Mutex<NelState>> = std::sync::OnceLock::new();
fn nel_state() -> &'static Mutex<NelState> {
    NEL_STATE.get_or_init(|| Mutex::new(NelState::default()))
}

#[derive(Default)]
struct NelState {
    /// origin -> group -> (endpoint URL, expiry)
    endpoints: HashMap<String, HashMap<String, (String, std::time::Instant)>>,
    /// origin -> policy
    policies: HashMap<String, NelPolicy>,
}

#[derive(Clone)]
struct NelPolicy {
    origin: String,
    host: String,
    report_to: String,
    expiry: std::time::Instant,
    include_subdomains: bool,
    success_fraction: f64,
    failure_fraction: f64,
}

/// One finished subresource request as Resource Timing sees it.
#[derive(Clone, Debug)]
pub struct ResourceRecord {
    pub url: String,
    pub final_url: String,
    pub dest: String,
    pub mode: String,
    pub initiator: String,
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body_len: usize,
    pub start: std::time::Instant,
    pub end: std::time::Instant,
}

/// A document's subresources fetched concurrently (as a browser's preload scanner does); plain
/// GETs for them wait for and reuse the result for a short while.
#[derive(Default)]
struct Prefetch {
    slots: Mutex<HashMap<String, (std::time::Instant, Option<Option<HttpResponse>>)>>,
    done: Condvar,
}

/// Prefetch slot key: the URL, plus the request headers when there are any (a response
/// prefetched with other headers is not reused).
fn prefetch_key(url: &str, headers: &BTreeMap<String, String>) -> String {
    if headers.is_empty() {
        return url.to_string();
    }
    let mut k = url.to_string();
    for (n, v) in headers {
        k.push('\u{1}');
        k.push_str(&n.to_ascii_lowercase());
        k.push('=');
        k.push_str(v);
    }
    k
}

thread_local! {
    /// Total time this thread spent blocked on the network (requests, prefetch waits).
    static NET_WAIT: std::cell::Cell<Duration> = const { std::cell::Cell::new(Duration::ZERO) };
    /// The part of the excluded time that was the browser's own work (layout, realm creation),
    /// not network wait: the hard wall-clock cap of the script budget does not count it either.
    static BROWSER_WORK: std::cell::Cell<Duration> = const { std::cell::Cell::new(Duration::ZERO) };
}

/// Total time the current thread spent on browser work done for scripts (see `ExcludedWork::browser`).
pub fn thread_browser_work() -> Duration {
    BROWSER_WORK.with(|w| w.get())
}

/// Total time the current thread has spent blocked on HTTP requests so far. The script
/// budget subtracts it, so slow servers do not eat the time scripts get to run.
pub fn thread_network_wait() -> Duration {
    NET_WAIT.with(|w| w.get())
}

/// Browser work done on behalf of a script (laying the page out for a geometry query) that the
/// script budget should not count, like network wait: adds its duration, minus the network wait
/// already counted inside it, to the thread's wait when dropped.
pub struct ExcludedWork(std::time::Instant, Duration, bool);

impl ExcludedWork {
    pub fn start() -> Self {
        ExcludedWork(std::time::Instant::now(), thread_network_wait(), false)
    }

    /// Work the browser itself does (a layout for a geometry query, creating a frame realm): also
    /// excluded from the budget's hard wall-clock cap. A page whose render queries geometry many
    /// times (Highcharts measuring labels: ~30 relayouts of a 1-2 MB page) was killed half-way by
    /// the cap although its own script time was within budget, leaving the chart empty.
    pub fn browser() -> Self {
        ExcludedWork(std::time::Instant::now(), thread_network_wait(), true)
    }
}

impl Drop for ExcludedWork {
    fn drop(&mut self) {
        let inner_net = thread_network_wait().saturating_sub(self.1);
        let dt = self.0.elapsed().saturating_sub(inner_net);
        NET_WAIT.with(|w| w.set(w.get() + dt));
        if self.2 {
            BROWSER_WORK.with(|w| w.set(w.get() + dt));
        }
    }
}

/// Adds the time between its creation and its drop to the thread's network wait.
struct NetWait(std::time::Instant);

impl NetWait {
    fn start() -> Self {
        NetWait(std::time::Instant::now())
    }
}

impl Drop for NetWait {
    fn drop(&mut self) {
        let dt = self.0.elapsed();
        NET_WAIT.with(|w| w.set(w.get() + dt));
    }
}

/// Fetch metadata request headers (Sec-Fetch-Dest/Mode/Site, no Sec-Fetch-User) for a
/// subresource request of `dest` made by a document at `initiator`. Empty values remove the
/// session's document defaults; nothing is sent to non-trustworthy (plain http) targets.
pub fn fetch_metadata_headers(dest: &str, mode: &str, initiator: &str, _target: &str) -> BTreeMap<String, String> {
    let mut h = BTreeMap::new();
    let accept = match dest {
        // no image/avif: the image decoders (image crate features) cannot read it, and CDNs
        // that negotiate on Accept (gumlet, 1mg) would serve undecodable bytes
        "image" => "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "style" => "text/css,*/*;q=0.1",
        "script" | "empty" | "audio" | "video" | "track" | "font" => "*/*",
        _ => "",
    };
    if !accept.is_empty() {
        h.insert("Accept".to_string(), accept.to_string());
    }
    h.insert("Upgrade-Insecure-Requests".to_string(), String::new());
    // The client follows redirects itself for these requests and sets Sec-Fetch-* per hop.
    h.insert(FETCH_META.to_string(), format!("{}|{}|{}|", dest, mode, initiator));
    h
}

/// Navigation request metadata (document/iframe destinations, `navigate` mode); `user` adds
/// Sec-Fetch-User for user-activated navigations.
pub fn navigation_metadata_headers(dest: &str, initiator: &str, user: bool) -> BTreeMap<String, String> {
    let mut h = BTreeMap::new();
    h.insert(FETCH_META.to_string(), format!("{}|navigate|{}|{}", dest, initiator, if user { "?1" } else { "" }));
    h
}

/// Concrete Sec-Fetch-* headers for one hop of a request whose URL list so far is `chain`
/// (the last entry is the URL being requested). Empty values remove session defaults.
pub fn fetch_metadata_hop(dest: &str, mode: &str, initiator: &str, chain: &[String], user: &str) -> BTreeMap<String, String> {
    let mut h = BTreeMap::new();
    for k in ["Sec-Fetch-Dest", "Sec-Fetch-Mode", "Sec-Fetch-Site", "Sec-Fetch-User", "Sec-Fetch-Storage-Access", "Upgrade-Insecure-Requests"] {
        h.insert(k.to_string(), String::new());
    }
    let Some(last) = chain.last() else { return h };
    let Ok(target) = Url::parse(last) else { return h };
    if mode == "navigate" {
        h.insert("Upgrade-Insecure-Requests".into(), "1".into());
    }
    if !potentially_trustworthy(&target) {
        return h;
    }
    let rank = chain.iter().map(|u| if initiator.is_empty() { 0 } else { site_rank(fetch_site(initiator, u)) }).max().unwrap_or(0);
    h.insert("Sec-Fetch-Dest".into(), dest.to_string());
    h.insert("Sec-Fetch-Mode".into(), mode.to_string());
    let site = if initiator.is_empty() { "none" } else { ["same-origin", "same-site", "cross-site"][rank as usize] };
    h.insert("Sec-Fetch-Site".into(), site.to_string());
    if !user.is_empty() {
        h.insert("Sec-Fetch-User".into(), user.to_string());
    }
    if rank == 2 && (mode == "no-cors" || mode == "navigate" && dest != "document") {
        h.insert("Sec-Fetch-Storage-Access".into(), "none".into());
    }
    h
}

/// The internal header naming a request's fetch metadata (`dest|mode|initiator|user`); the
/// client follows that request's redirects itself and sets Sec-Fetch-* on every hop.
pub fn fetch_metadata_marker(dest: &str, mode: &str, initiator: &str, user: &str) -> (String, String) {
    (FETCH_META.to_string(), format!("{}|{}|{}|{}", dest, mode, initiator, user))
}

/// Internal header carrying `dest|mode|initiator|user` for per-hop fetch metadata.
const FETCH_META: &str = "x-jb-fetch-meta";
/// Internal header naming the document that made a request (Resource Timing ownership) when
/// the request has no fetch metadata marker; never sent.
pub const RT_INITIATOR: &str = "x-jb-rt-initiator";
/// Internal header (never sent): the request is a `<link rel=preload>` fetch.
pub const PRELOAD_META: &str = "x-jb-preload";
/// Internal header carrying `policy|referrer source` (Referrer Policy): the client computes the
/// Referer of every hop from it.
const REF_META: &str = "x-jb-referrer";
/// Pseudo response header: the Referer the final hop was sent with (absent = none sent).
pub const SENT_REFERRER: &str = "x-jb-sent-referrer";
/// Pseudo response header: the Origin header the final hop was sent with (for the CORS check).
pub const SENT_ORIGIN: &str = "x-jb-sent-origin";
/// Internal header: JSON `[[self origin, [source expressions]], ...]` — Content Security Policy
/// source lists every redirect target must match (otherwise the hop is not requested).
pub const CSP_META: &str = "x-jb-csp";

/// Internal response header: the redirect chain visited another origin than its first URL's.
pub const CROSS_REDIRECT: &str = "x-jb-cross-redirect";
/// Internal header: mixed content handling of redirect targets that are not potentially
/// trustworthy — "block", or "upgrade" (to https; image/audio/video and upgrade-insecure-requests).
pub const MIXED_META: &str = "x-jb-mixed";

/// Upgrade an http(s)/ws URL to its secure scheme (port 80 becomes 443).
pub fn upgrade_to_secure(u: &mut Url) {
    let secure = match u.scheme() { "http" => "https", "ws" => "wss", _ => return };
    let was80 = u.port() == Some(80);
    let _ = u.set_scheme(secure);
    if was80 {
        let _ = u.set_port(Some(443));
    }
}

/// Whether redirect target `url` is allowed by the CSP source lists of a `CSP_META` value.
fn csp_allows_redirect(lists: &str, url: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Vec<(String, Vec<String>)>>(lists) else { return true };
    v.iter().all(|(origin, list)| crate::csp::url_matches_source_list(list, url, origin, true))
}

/// The internal header asking the client to send the Referer that `policy` allows for a request
/// whose referrer is `source` (a URL; empty = no referrer), recomputed on every redirect hop.
pub fn referrer_marker(source: &str, policy: &str) -> (String, String) {
    (REF_META.to_string(), format!("{}|{}", policy, source))
}

/// Referrer Policy "determine request's referrer" for a request to `target` whose referrer is
/// `source` under `policy` ("" = strict-origin-when-cross-origin). `None` = no referrer.
pub fn determine_referrer(source: &str, policy: &str, target: &str) -> Option<String> {
    let src = Url::parse(source).ok()?;
    // local schemes (about:, blob:, data:) and other non-network URLs have no referrer
    if !matches!(src.scheme(), "http" | "https") {
        return None;
    }
    let tgt = Url::parse(target).ok()?;
    let mut full = src.clone();
    let _ = full.set_username("");
    let _ = full.set_password(None);
    full.set_fragment(None);
    let origin_only = format!("{}/", src.origin().ascii_serialization());
    let mut full = full.to_string();
    // referrers longer than 4096 bytes are cut down to the origin
    if full.len() > 4096 {
        full = origin_only.clone();
    }
    if origin_only.len() > 4096 {
        return None;
    }
    let same = src.origin() == tgt.origin();
    let downgrade = potentially_trustworthy(&src) && !potentially_trustworthy(&tgt);
    match policy {
        "no-referrer" => None,
        "unsafe-url" => Some(full),
        "origin" => Some(origin_only),
        "same-origin" => same.then_some(full),
        "strict-origin" => (!downgrade).then_some(origin_only),
        "origin-when-cross-origin" => Some(if same { full } else { origin_only }),
        "no-referrer-when-downgrade" => (!downgrade).then_some(full),
        _ => {
            if same {
                Some(full)
            } else if downgrade {
                None
            } else {
                Some(origin_only)
            }
        }
    }
}

/// The last valid token of a Referrer-Policy header ("" when none is valid).
pub fn parse_referrer_policy_header(value: &str) -> String {
    const VALID: [&str; 8] = ["no-referrer", "no-referrer-when-downgrade", "same-origin", "origin", "strict-origin", "origin-when-cross-origin", "strict-origin-when-cross-origin", "unsafe-url"];
    let mut policy = String::new();
    for t in value.split(',') {
        let t = t.trim().to_ascii_lowercase();
        if VALID.contains(&t.as_str()) {
            policy = t;
        }
    }
    policy
}

fn potentially_trustworthy(u: &Url) -> bool {
    u.scheme() == "https" || u.scheme() == "wss" || matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"))
}

fn site_rank(s: &str) -> u8 {
    match s {
        "same-origin" => 0,
        "same-site" => 1,
        "none" => 0,
        _ => 2,
    }
}

/// "same-origin", "same-site" or "cross-site" for a request from `initiator` to `target`.
pub fn fetch_site(initiator: &str, target: &str) -> &'static str {
    let (Ok(a), Ok(b)) = (Url::parse(initiator), Url::parse(target)) else { return "cross-site" };
    if a.origin() == b.origin() {
        return "same-origin";
    }
    let site = |u: &Url| -> String {
        let host = u.host_str().unwrap_or("").to_ascii_lowercase();
        let labels: Vec<&str> = host.split('.').collect();
        let reg = if host.parse::<std::net::IpAddr>().is_ok() || labels.len() <= 2 { host.clone() } else { labels[labels.len() - 2..].join(".") };
        format!("{}://{}", u.scheme(), reg)
    };
    if site(&a) == site(&b) { "same-site" } else { "cross-site" }
}

/// How long a prefetched response may be reused.
const PREFETCH_TTL: Duration = Duration::from_secs(30);
/// Concurrent prefetch workers.
const PREFETCH_WORKERS: usize = 6;

impl HttpClient {
    pub fn new(user_agent: Option<&str>) -> Self {
        // Both ring and aws-lc-rs are linked (reqwest, WebSocket TLS): pick the process-wide
        // rustls provider explicitly, or building a TLS client config panics.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let ua = user_agent.unwrap_or(DEFAULT_USER_AGENT).to_string();
        let jar = Arc::new(CookieStoreMutex::default());
        let client = build_client(&ua, jar.clone(), true);
        Self {
            inner: Arc::new(RwLock::new(client)),
            manual: Arc::new(RwLock::new(build_client(&ua, jar.clone(), false))),
            bare: Arc::new(RwLock::new(build_bare_client(&ua))),
            jar,
            default_headers: Arc::new(RwLock::new(BTreeMap::new())),
            user_agent: Arc::new(RwLock::new(ua)),
            prefetch: Arc::new(Prefetch::default()),
            timings: Arc::new(Mutex::new(Vec::new())),
            preloaded: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    pub fn set_network_error_logging(&self, on: bool) {
        NEL_ON.store(on, std::sync::atomic::Ordering::Relaxed);
    }

    /// Network Error Logging: take the response's Report-To / Reporting-Endpoints / NEL headers,
    /// then report the request to its origin's policy endpoint (uploaded right away).
    fn nel_observe(&self, method: &str, url: &str, outcome: Result<&HttpResponse, (&HttpError, bool)>, started: std::time::Instant) {
        // (CORS preflights are not reported)
        if !NEL_ON.load(std::sync::atomic::Ordering::Relaxed) || method.eq_ignore_ascii_case("OPTIONS") {
            return;
        }
        let Ok(u) = Url::parse(url) else { return };
        if u.scheme() != "https" {
            return;
        }
        let origin = u.origin().ascii_serialization();
        let host = u.host_str().unwrap_or("").to_ascii_lowercase();
        let now = std::time::Instant::now();
        let mut st = nel_state().lock().unwrap();
        if let Ok(resp) = outcome {
            if let Some(rt) = resp.headers.get("report-to") {
                let text = format!("[{}]", rt);
                if let Ok(serde_json::Value::Array(groups)) = serde_json::from_str::<serde_json::Value>(&text) {
                    for g in groups {
                        let name = g.get("group").and_then(|v| v.as_str()).unwrap_or("default").to_string();
                        let max_age = g.get("max_age").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let ep = g.get("endpoints").and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|e| e.get("url")).and_then(|v| v.as_str()).map(str::to_string);
                        let map = st.endpoints.entry(origin.clone()).or_default();
                        match (max_age > 0.0, ep) {
                            (true, Some(e)) => {
                                if let Ok(abs) = u.join(&e) {
                                    map.insert(name, (abs.to_string(), now + Duration::from_secs_f64(max_age.min(1e9))));
                                }
                            }
                            _ => {
                                map.remove(&name);
                            }
                        }
                    }
                }
            }
            if let Some(re) = resp.headers.get("reporting-endpoints") {
                for item in re.split(',') {
                    if let Some((k, v)) = item.split_once('=') {
                        let v = v.trim().trim_matches('"');
                        if let Ok(abs) = u.join(v) {
                            st.endpoints.entry(origin.clone()).or_default().insert(k.trim().to_string(), (abs.to_string(), now + Duration::from_secs(86400)));
                        }
                    }
                }
            }
            if let Some(nel) = resp.headers.get("nel") {
                let first = nel.split("},").next().unwrap_or("");
                let text = if first.trim_end().ends_with('}') { first.to_string() } else { format!("{}}}", first) };
                if let Ok(p) = serde_json::from_str::<serde_json::Value>(&text) {
                    let max_age = p.get("max_age").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    if max_age <= 0.0 {
                        st.policies.remove(&origin);
                    } else {
                        let f = |k: &str, d: f64| p.get(k).and_then(|v| v.as_f64()).unwrap_or(d).clamp(0.0, 1.0);
                        st.policies.insert(origin.clone(), NelPolicy {
                            origin: origin.clone(),
                            host: host.clone(),
                            report_to: p.get("report_to").and_then(|v| v.as_str()).unwrap_or("default").to_string(),
                            expiry: now + Duration::from_secs_f64(max_age.min(1e9)),
                            include_subdomains: p.get("include_subdomains").and_then(|v| v.as_bool()).unwrap_or(false),
                            success_fraction: f("success_fraction", 0.0),
                            failure_fraction: f("failure_fraction", 1.0),
                        });
                    }
                }
            }
        }
        st.policies.retain(|_, p| p.expiry > now);
        let exact = st.policies.get(&origin).cloned();
        let (policy, via_subdomain) = match exact {
            Some(p) => (p, false),
            None => match st.policies.values().find(|p| p.include_subdomains && host.ends_with(&format!(".{}", p.host))).cloned() {
                Some(p) => (p, true),
                None => return,
            },
        };
        let (typ, phase, status, ok) = match outcome {
            Ok(r) if r.status >= 400 => ("http.error", "application", r.status, false),
            Ok(r) => ("ok", "application", r.status, true),
            Err((_, true)) => ("dns.name_not_resolved", "dns", 0, false),
            Err((HttpError::Timeout(_), _)) => ("tcp.timed_out", "connection", 0, false),
            Err((HttpError::Connection(_), _)) => ("tcp.refused", "connection", 0, false),
            Err(_) => ("unknown", "application", 0, false),
        };
        // a policy for a parent domain only reports DNS failures of its subdomains
        if via_subdomain && phase != "dns" {
            return;
        }
        let fraction = if ok { policy.success_fraction } else { policy.failure_fraction };
        if fraction <= 0.0 || (fraction < 1.0 && rand::random::<f64>() >= fraction) {
            return;
        }
        let Some((endpoint, _)) = st.endpoints.get(&policy.origin).and_then(|g| g.get(&policy.report_to)).cloned() else { return };
        drop(st);
        let mut clean = u.clone();
        clean.set_fragment(None);
        // reports through a parent domain's policy carry only the origin
        if via_subdomain {
            clean.set_path("/");
            clean.set_query(None);
        }
        let _ = clean.set_username("");
        let _ = clean.set_password(None);
        let report = serde_json::json!([{
            "age": 0,
            "type": "network-error",
            "url": clean.as_str(),
            "user_agent": self.user_agent(),
            "body": {
                "sampling_fraction": fraction,
                "server_ip": "",
                "protocol": "http/1.1",
                "method": method.to_ascii_uppercase(),
                "request_headers": {},
                "response_headers": {},
                "status_code": status,
                "elapsed_time": started.elapsed().as_millis() as u64,
                "phase": phase,
                "type": typ,
                "referrer": "",
            }
        }]);
        // the upload itself is not observed (no report about a report)
        let client = self.manual.read().unwrap().clone();
        let _ = client.post(&endpoint).header("Content-Type", "application/reports+json").body(report.to_string()).timeout(Duration::from_secs(10)).send();
    }

    pub fn set_subresource_link_preloads(&self, on: bool) {
        SUBRESOURCE_LINK_PRELOADS.store(on, std::sync::atomic::Ordering::Relaxed);
    }

    /// Start fetching `urls` (GET, redirects followed) in the background.
    pub fn prefetch(&self, urls: Vec<String>, timeout_secs: u64) {
        self.prefetch_with(urls, BTreeMap::new(), timeout_secs)
    }

    /// Like `prefetch`, sending `headers`; only a later GET with the same headers reuses it.
    pub fn prefetch_with(&self, urls: Vec<String>, headers: BTreeMap<String, String>, timeout_secs: u64) {
        let mut queue = Vec::new();
        {
            let mut slots = self.prefetch.slots.lock().unwrap();
            slots.retain(|_, (t, _)| t.elapsed() < PREFETCH_TTL);
            for u in urls {
                let key = prefetch_key(&u, &headers);
                if !(u.starts_with("http://") || u.starts_with("https://")) || slots.contains_key(&key) {
                    continue;
                }
                slots.insert(key.clone(), (std::time::Instant::now(), None));
                queue.push((u, key));
            }
        }
        let headers = Arc::new(headers);
        if queue.is_empty() {
            return;
        }
        let workers = queue.len().min(PREFETCH_WORKERS);
        let queue = Arc::new(Mutex::new(queue));
        for _ in 0..workers {
            let client = self.clone();
            let queue = queue.clone();
            let headers = headers.clone();
            std::thread::spawn(move || loop {
                let next = queue.lock().unwrap().pop();
                let Some((url, key)) = next else { break };
                let t0 = std::time::Instant::now();
                let resp = client.request_uncached("GET", &url, &headers, None, timeout_secs, true);
                if std::env::var_os("JB_TRACE_JS").is_some() {
                    eprintln!("[prefetch] {url} -> {} in {} ms", match &resp { Ok(r) => r.status.to_string(), Err(e) => format!("err {e}") }, t0.elapsed().as_millis());
                }
                let resp = resp.ok();
                let mut slots = client.prefetch.slots.lock().unwrap();
                slots.insert(key, (std::time::Instant::now(), Some(resp)));
                client.prefetch.done.notify_all();
            });
        }
    }

    /// The prefetched response for `url`, waiting for an in-flight prefetch. `None` when `url` was
    /// not prefetched (or its prefetch failed).
    pub fn take_prefetched(&self, url: &str, timeout_secs: u64) -> Option<HttpResponse> {
        self.take_prefetched_with(url, &BTreeMap::new(), timeout_secs)
    }

    pub fn take_prefetched_with(&self, url: &str, headers: &BTreeMap<String, String>, timeout_secs: u64) -> Option<HttpResponse> {
        let url = &prefetch_key(url, headers)[..];
        let _wait = NetWait::start();
        let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs.max(1));
        let mut slots = self.prefetch.slots.lock().unwrap();
        loop {
            match slots.get(url) {
                None => return None,
                Some((t, _)) if t.elapsed() > PREFETCH_TTL => {
                    slots.remove(url);
                    return None;
                }
                Some((_, Some(done))) => return done.clone(),
                Some((_, None)) => {
                    let now = std::time::Instant::now();
                    if now >= deadline {
                        if std::env::var_os("JB_TRACE_JS").is_some() {
                            eprintln!("[prefetch] gave up waiting for {url}");
                        }
                        return None;
                    }
                    slots = self.prefetch.done.wait_timeout(slots, deadline - now).unwrap().0;
                }
            }
        }
    }

    pub fn user_agent(&self) -> String {
        self.user_agent.read().unwrap().clone()
    }

    /// Replace the user agent (rebuilds the underlying client; the cookie jar is kept).
    pub fn set_user_agent(&self, ua: &str) {
        *self.user_agent.write().unwrap() = ua.to_string();
        *self.inner.write().unwrap() = build_client(ua, self.jar.clone(), true);
        *self.manual.write().unwrap() = build_client(ua, self.jar.clone(), false);
        *self.bare.write().unwrap() = build_bare_client(ua);
    }

    /// Session-wide header defaults (`session.headers.update`).
    pub fn set_default_headers(&self, headers: BTreeMap<String, String>) {
        *self.default_headers.write().unwrap() = headers;
    }

    /// `Cookie` header value the jar would send to `url` (what `document.cookie` reads).
    pub fn cookies_for(&self, url: &str, include_http_only: bool) -> String {
        let url = match Url::parse(url) {
            Ok(u) => u,
            Err(_) => return String::new(),
        };
        let store = self.jar.lock().unwrap();
        store
            .matches(&url)
            .into_iter()
            .filter(|c| include_http_only || !c.http_only().unwrap_or(false))
            // A cookie set without a name serializes as its bare value.
            .map(|c| if c.name().is_empty() { c.value().to_string() } else { format!("{}={}", c.name(), c.value()) })
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// `document.cookie` of a document at `url` whose top-level document is at `site`: a cross-site
    /// document sees only SameSite=None cookies.
    pub fn cookies_for_site(&self, url: &str, site: &str, include_http_only: bool) -> String {
        let cross = !site.is_empty() && fetch_site(site, url) == "cross-site";
        if !cross {
            return self.cookies_for(url, include_http_only);
        }
        let Ok(u) = Url::parse(url) else { return String::new() };
        let store = self.jar.lock().unwrap();
        store
            .matches(&u)
            .into_iter()
            .filter(|c| include_http_only || !c.http_only().unwrap_or(false))
            .filter(|c| matches!(c.same_site(), Some(cookie::SameSite::None)))
            .map(|c| if c.name().is_empty() { c.value().to_string() } else { format!("{}={}", c.name(), c.value()) })
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// `document.cookie = ...` in a cross-site document: SameSite cookies are refused.
    pub fn set_cookie_for_site(&self, url: &str, cookie_str: &str, site: &str) -> bool {
        if !site.is_empty() && fetch_site(site, url) == "cross-site" {
            let secure = Url::parse(url).map(|u| u.scheme() == "https").unwrap_or(false);
            if let Some(canonical) = normalize_set_cookie(cookie_str, secure) {
                if let Ok(parsed) = cookie_store::RawCookie::parse(canonical) {
                    if !matches!(parsed.same_site(), Some(cookie::SameSite::None)) {
                        return false;
                    }
                }
            }
        }
        self.set_cookie(url, cookie_str)
    }

    /// Store a `Set-Cookie`-style string for `url` (what `document.cookie = ...` does).
    pub fn set_cookie(&self, url: &str, cookie: &str) -> bool {
        let url = match Url::parse(url) {
            Ok(u) => u,
            Err(_) => return false,
        };
        let Some(canonical) = normalize_set_cookie(cookie, url.scheme() == "https") else { return false };
        let mut store = self.jar.lock().unwrap();
        store.parse(&canonical, &url).is_ok()
    }

    /// All cookies as (name, value, domain, path, secure, http_only).
    /// Drop every cookie in the jar (testdriver `delete_all_cookies`).
    pub fn clear_cookies(&self) {
        self.jar.lock().unwrap().clear();
    }

    pub fn all_cookies(&self) -> Vec<(String, String, String, String, bool, bool)> {
        let store = self.jar.lock().unwrap();
        store
            .iter_any()
            .map(|c| {
                (
                    c.name().to_string(),
                    c.value().to_string(),
                    c.domain().unwrap_or("").to_string(),
                    c.path().unwrap_or("/").to_string(),
                    c.secure().unwrap_or(false),
                    c.http_only().unwrap_or(false),
                )
            })
            .collect()
    }

    /// Plain GET with a timeout; used for stylesheets and JS fetch.
    pub fn get_simple(&self, url: &str, timeout_secs: u64) -> Result<HttpResponse, HttpError> {
        self.request("GET", url, &BTreeMap::new(), None, timeout_secs, true)
    }

    /// Generic request. `body` is sent raw with the given headers. Plain GETs (no extra headers,
    /// redirects followed) reuse a prefetched response when there is one.
    pub fn request(
        &self,
        method: &str,
        url: &str,
        headers: &BTreeMap<String, String>,
        body: Option<Vec<u8>>,
        timeout_secs: u64,
        allow_redirects: bool,
    ) -> Result<HttpResponse, HttpError> {
        let t0 = std::time::Instant::now();
        // preload store: a preload request fills it, a later request with the same destination
        // and mode takes the response (no network request, no new timing record)
        let is_get = method.eq_ignore_ascii_case("GET") && body.is_none();
        let preload_key = if is_get { Self::preload_key(url, headers) } else { None };
        let stripped;
        let (headers, preloading) = if headers.contains_key(PRELOAD_META) {
            let mut h = headers.clone();
            h.remove(PRELOAD_META);
            stripped = h;
            (&stripped, true)
        } else {
            (headers, false)
        };
        if let (false, Some(key)) = (preloading, &preload_key) {
            let mut store = self.preloaded.lock().unwrap();
            store.retain(|_, (t, _)| t.elapsed() < std::time::Duration::from_secs(300));
            if let Some((_, resp)) = store.remove(key) {
                return Ok(resp);
            }
        }
        let result = if allow_redirects && body.is_none() && method.eq_ignore_ascii_case("GET") {
            match self.take_prefetched_with(url, headers, timeout_secs) {
                Some(resp) => Ok(resp),
                None => self.request_uncached(method, url, headers, body, timeout_secs, allow_redirects),
            }
        } else {
            self.request_uncached(method, url, headers, body, timeout_secs, allow_redirects)
        };
        self.record_timing(url, headers, &result, t0, allow_redirects);
        if SUBRESOURCE_LINK_PRELOADS.load(std::sync::atomic::Ordering::Relaxed) {
            if let (Some(key), Ok(resp)) = (&preload_key, &result) {
                if !preloading && !key.starts_with("empty|") {
                    if let Some(link) = resp.headers.get("link").cloned() {
                        self.subresource_link_preload(&resp.url, &link, timeout_secs);
                    }
                }
            }
        }
        if let (true, Some(key), Ok(resp)) = (preloading, preload_key, &result) {
            let mut store = self.preloaded.lock().unwrap();
            if store.len() > 256 {
                store.clear();
            }
            store.insert(key, (std::time::Instant::now(), resp.clone()));
        }
        result
    }

    /// Fetch the `rel=preload` targets of a subresource response's Link header, with no Referer.
    fn subresource_link_preload(&self, base: &str, link: &str, timeout_secs: u64) {
        let Ok(base) = Url::parse(base) else { return };
        for part in link.split(',') {
            let Some(start) = part.find('<') else { continue };
            let Some(end) = part[start..].find('>') else { continue };
            let target = &part[start + 1..start + end];
            let params = part[start + end + 1..].to_ascii_lowercase();
            let is_preload = params.split(';').any(|p| {
                let p = p.trim();
                p.strip_prefix("rel").map(|r| r.trim_start().trim_start_matches('=').trim().trim_matches('"').split_ascii_whitespace().any(|t| t == "preload")).unwrap_or(false)
            });
            if !is_preload {
                continue;
            }
            let Ok(u) = base.join(target.trim()) else { continue };
            if !matches!(u.scheme(), "http" | "https") {
                continue;
            }
            let mut h = BTreeMap::new();
            h.insert("Accept".to_string(), "*/*".to_string());
            let _ = self.request_uncached("GET", u.as_str(), &h, None, timeout_secs, true);
        }
    }

    /// "dest|mode|url" of a request carrying fetch metadata (marker or Sec-Fetch headers).
    fn preload_key(url: &str, headers: &BTreeMap<String, String>) -> Option<String> {
        let get = |k: &str| headers.iter().find(|(hk, _)| hk.eq_ignore_ascii_case(k)).map(|(_, v)| v.clone()).unwrap_or_default();
        let meta = get(FETCH_META);
        let parts: Vec<&str> = meta.splitn(4, '|').collect();
        let (mut dest, mut mode) = (parts.first().copied().unwrap_or("").to_string(), parts.get(1).copied().unwrap_or("").to_string());
        if dest.is_empty() {
            dest = get("Sec-Fetch-Dest");
            mode = get("Sec-Fetch-Mode");
        }
        if dest.is_empty() || dest == "document" || dest == "iframe" || dest == "frame" {
            return None;
        }
        Some(format!("{dest}|{mode}|{}", url.split('#').next().unwrap_or(url)))
    }

    /// Resource Timing: remember a subresource request (its destination comes from the fetch
    /// metadata the caller attached). fetch()/XHR ("empty") are recorded by the JS side.
    fn record_timing(&self, url: &str, headers: &BTreeMap<String, String>, result: &Result<HttpResponse, HttpError>, t0: std::time::Instant, allow_redirects: bool) {
        let get = |k: &str| headers.iter().find(|(hk, _)| hk.eq_ignore_ascii_case(k)).map(|(_, v)| v.clone()).unwrap_or_default();
        let meta = get(FETCH_META);
        let parts: Vec<&str> = meta.splitn(4, '|').collect();
        let mut dest = parts.first().copied().unwrap_or("").to_string();
        let mut mode = parts.get(1).copied().unwrap_or("").to_string();
        let mut initiator = parts.get(2).copied().unwrap_or("").to_string();
        if dest.is_empty() {
            dest = get("Sec-Fetch-Dest");
            mode = get("Sec-Fetch-Mode");
        }
        let marked = get(RT_INITIATOR);
        if !marked.is_empty() {
            initiator = marked;
        }
        if dest.is_empty() || dest == "empty" || dest == "document" || dest == "serviceworker" || dest == "worker" || dest == "sharedworker" {
            return;
        }
        let (status, final_url, rh, len) = match result {
            Ok(r) => {
                // a hop of a redirect chain followed by the caller: only the last hop counts
                if !allow_redirects && (300..400).contains(&r.status) && r.headers.contains_key("location") {
                    return;
                }
                let mut h = BTreeMap::new();
                for k in ["timing-allow-origin", "content-type", "server-timing", "content-length", "content-encoding", "access-control-allow-origin", CROSS_REDIRECT] {
                    if let Some(v) = r.headers.get(k) {
                        h.insert(k.to_string(), v.clone());
                    }
                }
                (r.status, r.url.clone(), h, r.body.len())
            }
            Err(_) => (0, url.to_string(), BTreeMap::new(), 0),
        };
        let mut t = self.timings.lock().unwrap();
        if t.len() > 1000 {
            t.drain(0..500);
        }
        t.push(ResourceRecord { url: url.to_string(), final_url, dest, mode, initiator, status, headers: rh, body_len: len, start: t0, end: std::time::Instant::now() });
    }

    /// Take the recorded requests made by the document at `doc` (`top`: also those without a
    /// known initiator).
    pub fn take_resource_timings(&self, doc: &str, top: bool) -> Vec<ResourceRecord> {
        let strip = |u: &str| u.split('#').next().unwrap_or("").to_string();
        let doc = strip(doc);
        let mut t = self.timings.lock().unwrap();
        let mut out = Vec::new();
        let mut keep = Vec::new();
        for r in t.drain(..) {
            if strip(&r.initiator) == doc || (top && r.initiator.is_empty()) {
                out.push(r);
            } else {
                keep.push(r);
            }
        }
        *t = keep;
        out
    }

    fn request_uncached(
        &self,
        method: &str,
        url: &str,
        headers: &BTreeMap<String, String>,
        body: Option<Vec<u8>>,
        timeout_secs: u64,
        allow_redirects: bool,
    ) -> Result<HttpResponse, HttpError> {
        if allow_redirects && (headers.contains_key(FETCH_META) || headers.contains_key(REF_META) || headers.contains_key(CSP_META) || headers.contains_key(MIXED_META)) {
            let meta = headers.get(FETCH_META).cloned();
            return self.request_with_metadata(method, url, headers, meta.as_deref(), body, timeout_secs);
        }
        if let Some(r) = headers.get(REF_META) {
            // a single hop: its Referer computed here
            let (policy, source) = r.split_once('|').unwrap_or(("", ""));
            let mut h = headers.clone();
            h.remove(REF_META);
            h.retain(|k, _| !k.eq_ignore_ascii_case("referer"));
            let sent = determine_referrer(source, policy, url);
            if let Some(v) = &sent {
                h.insert("Referer".into(), v.clone());
            }
            let mut resp = self.request_uncached(method, url, &h, body, timeout_secs, allow_redirects)?;
            if let Some(v) = sent {
                resp.headers.insert(SENT_REFERRER.into(), v);
            }
            return Ok(resp);
        }
        let _wait = NetWait::start();
        let started = std::time::Instant::now();
        let method = reqwest::Method::from_bytes(method.to_ascii_uppercase().as_bytes())
            .map_err(|e| HttpError::Other(e.to_string()))?;
        let method_name = method.as_str().to_string();
        let client = if allow_redirects {
            self.inner.read().unwrap().clone()
        } else {
            build_client(&self.user_agent(), self.jar.clone(), false)
        };
        let mut req = client.request(method, url).timeout(Duration::from_secs(timeout_secs));

        let mut merged = self.default_headers.read().unwrap().clone();
        for (k, v) in headers {
            if k == FETCH_META || k == RT_INITIATOR {
                continue;
            }
            if v.is_empty() && k.to_ascii_lowercase().starts_with("sec-fetch-") || (v.is_empty() && k.eq_ignore_ascii_case("upgrade-insecure-requests")) {
                // an empty value removes the session default (fetch metadata of subresources)
                let lk = k.to_ascii_lowercase();
                merged.retain(|mk, _| mk.to_ascii_lowercase() != lk);
                continue;
            }
            merged.insert(k.clone(), v.clone());
        }
        let mut hm = HeaderMap::new();
        for (k, v) in &merged {
            if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
                hm.insert(name, value);
            }
        }
        req = req.headers(hm);
        let zero_length = body_needs_zero_length(&method_name, body.as_deref());
        if let Some(b) = body {
            req = req.body(b);
        }
        if zero_length {
            req = req.header(reqwest::header::CONTENT_LENGTH, "0");
        }
        let retry = req.try_clone().and_then(|r| r.build().ok());
        let sent = match req.send() {
            Err(e) if retry.is_some() && is_handshake_reset(&e) => {
                build_client_v(&self.user_agent(), self.jar.clone(), allow_redirects, true).execute(retry.unwrap())
            }
            r => r,
        };
        let resp = match sent {
            Ok(r) => r,
            Err(e) => {
                let dns = is_dns_error(&e);
                let err = map_err(e, url, timeout_secs);
                self.nel_observe(&method_name, url, Err((&err, dns)), started);
                return Err(err);
            }
        };
        let out = read_response(resp, started);
        self.nel_observe(&method_name, url, Ok(&out), started);
        Ok(out)
    }

    /// Follow redirects by hand so each hop carries its own Sec-Fetch-* headers: the site is
    /// the least related of all URLs in the chain so far, and nothing is sent to plain-http hops.
    fn request_with_metadata(
        &self,
        method: &str,
        url: &str,
        headers: &BTreeMap<String, String>,
        meta: Option<&str>,
        body: Option<Vec<u8>>,
        timeout_secs: u64,
    ) -> Result<HttpResponse, HttpError> {
        let parts: Vec<&str> = meta.unwrap_or("").splitn(4, '|').collect();
        let (dest, mode, initiator, user) = (parts.first().copied().unwrap_or(""), parts.get(1).copied().unwrap_or(""), parts.get(2).copied().unwrap_or(""), parts.get(3).copied().unwrap_or(""));
        let mut method = method.to_ascii_uppercase();
        let mut body = body;
        let mut current = url.to_string();
        let mut chain: Vec<String> = Vec::new();
        let mut base: BTreeMap<String, String> = headers.clone();
        base.remove(FETCH_META);
        let csp = base.remove(CSP_META);
        let mixed = base.remove(MIXED_META);
        // Referrer Policy: the Referer is recomputed per hop; a redirect's Referrer-Policy
        // header updates the request's policy.
        let mut referrer: Option<(String, String)> = base.remove(REF_META).map(|r| {
            let (p, s) = r.split_once('|').unwrap_or(("", ""));
            (p.to_string(), s.to_string())
        });
        if referrer.is_some() {
            base.retain(|k, _| !k.eq_ignore_ascii_case("referer"));
        }
        let first_origin = Url::parse(url).ok().map(|u| u.origin());
        let mut origin_tainted = false;
        let mut crossed = false;
        // a request may be redirected 20 times (21 requests)
        for _hop in 0..=20 {
            let target = Url::parse(&current).map_err(|e| HttpError::Other(e.to_string()))?;
            if Some(target.origin()) != first_origin {
                // a cross-origin redirect drops the request's Authorization header
                base.retain(|k, _| !k.eq_ignore_ascii_case("authorization"));
            }
            // Fetch "redirect-tainted origin": after a redirect that changed origins (other than
            // the request's own), the Origin header is serialized as "null"
            if let Some(prev) = chain.last().and_then(|p| Url::parse(p).ok()) {
                let req_origin = Url::parse(initiator).ok().map(|i| i.origin().ascii_serialization());
                if prev.origin() != target.origin() && req_origin.as_deref() != Some(prev.origin().ascii_serialization().as_str()) {
                    origin_tainted = true;
                }
                if Some(target.origin()) != Url::parse(initiator).ok().map(|i| i.origin()) {
                    crossed = true;
                }
                // a GET/HEAD carries Origin only once the response tainting is CORS
                if (method == "GET" || method == "HEAD") && !crossed && meta.is_some() {
                    base.retain(|k, _| !k.eq_ignore_ascii_case("origin"));
                }
                // a CORS request that reaches another origin carries Origin
                if mode == "cors" && Some(target.origin()) != first_origin && !base.keys().any(|k| k.eq_ignore_ascii_case("origin")) {
                    if let Ok(i) = Url::parse(initiator) {
                        base.insert("Origin".into(), i.origin().ascii_serialization());
                    }
                }
                if origin_tainted {
                    for (k, v) in base.iter_mut() {
                        if k.eq_ignore_ascii_case("origin") {
                            *v = "null".to_string();
                        }
                    }
                }
            }
            chain.push(current.clone());
            let mut h = base.clone();
            if meta.is_some() {
                for (k, v) in fetch_metadata_hop(dest, mode, initiator, &chain, user) {
                    // a navigation's Upgrade-Insecure-Requests stays as the caller set it
                    if k == "Upgrade-Insecure-Requests" && base.keys().any(|b| b.eq_ignore_ascii_case(&k)) {
                        continue;
                    }
                    h.insert(k, v);
                }
            }
            let sent = referrer.as_ref().and_then(|(p, s)| determine_referrer(s, p, &current));
            if let Some(v) = &sent {
                h.insert("Referer".into(), v.clone());
            }
            let chain_cross = !initiator.is_empty() && chain.iter().any(|u| fetch_site(initiator, u) == "cross-site");
            let ctx = meta.map(|_| CookieContext { initiator: initiator.to_string(), chain_cross, top_level: mode == "navigate" && dest == "document", safe_method: method == "GET" || method == "HEAD" });
            let mut resp = self.send_once_ctx(&method, &current, &h, body.clone(), timeout_secs, ctx.as_ref())?;
            let loc = resp.headers.get("location").cloned();
            match (resp.status, loc) {
                (301 | 302 | 303 | 307 | 308, Some(loc)) => {
                    let Ok(mut next) = target.join(&loc) else { return Ok(resp) };
                    // mixed content: insecure redirect targets are upgraded or blocked
                    if let Some(mode) = &mixed {
                        if !potentially_trustworthy(&next) && matches!(next.scheme(), "http" | "ws") {
                            if mode == "upgrade" {
                                upgrade_to_secure(&mut next);
                            } else {
                                return Err(HttpError::Other(format!("Mixed content blocked redirect to {next}")));
                            }
                        }
                    }
                    if let Some(lists) = &csp {
                        if !csp_allows_redirect(lists, next.as_str()) {
                            return Err(HttpError::Other(format!("CSP blocked redirect to {next}")));
                        }
                    }
                    if let (Some(r), Some(rp)) = (referrer.as_mut(), resp.headers.get("referrer-policy")) {
                        let p = parse_referrer_policy_header(rp);
                        if !p.is_empty() {
                            r.0 = p;
                        }
                    }
                    if resp.status == 303 && method != "HEAD" || (resp.status == 301 || resp.status == 302) && method == "POST" {
                        method = "GET".into();
                        body = None;
                        base.retain(|k, _| !k.eq_ignore_ascii_case("content-type"));
                        // a GET carries Origin only in CORS mode
                        if mode != "cors" && meta.is_some() {
                            base.retain(|k, _| !k.eq_ignore_ascii_case("origin"));
                        }
                    }
                    current = next.to_string();
                }
                _ => {
                    if let Some(v) = sent {
                        resp.headers.insert(SENT_REFERRER.into(), v);
                    }
                    if chain.len() > 1 {
                        if let Some((_, o)) = h.iter().find(|(k, _)| k.eq_ignore_ascii_case("origin")) {
                            resp.headers.insert(SENT_ORIGIN.into(), o.clone());
                        }
                        // Resource Timing: some hop of the chain left the first URL's origin
                        if chain.iter().any(|u| Url::parse(u).ok().map(|x| x.origin()) != first_origin) {
                            resp.headers.insert(CROSS_REDIRECT.into(), "1".into());
                        }
                    }
                    return Ok(resp);
                }
            }
        }
        Err(HttpError::Other("too many redirects".into()))
    }

    /// One request without redirect following; the response keeps its own URL.
    /// The Cookie header for `url` under SameSite: Strict cookies only same-site, Lax (and
    /// unspecified) also on top-level navigations with a safe method, None always.
    fn cookie_header(&self, url: &Url, ctx: &CookieContext) -> String {
        let cross = ctx.chain_cross || !ctx.initiator.is_empty() && fetch_site(&ctx.initiator, url.as_str()) == "cross-site";
        let store = self.jar.lock().unwrap();
        store
            .matches(url)
            .into_iter()
            .filter(|c| match c.same_site() {
                Some(cookie::SameSite::None) => true,
                Some(cookie::SameSite::Strict) => !cross,
                _ => !cross || (ctx.top_level && ctx.safe_method),
            })
            .map(|c| if c.name().is_empty() { c.value().to_string() } else { format!("{}={}", c.name(), c.value()) })
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// Store a response's Set-Cookie headers; SameSite cookies from cross-site subresource
    /// responses are ignored.
    fn store_cookies(&self, url: &Url, resp: &ReqResponse, ctx: &CookieContext) {
        let cross = ctx.chain_cross || !ctx.initiator.is_empty() && fetch_site(&ctx.initiator, url.as_str()) == "cross-site";
        for v in resp.headers().get_all(reqwest::header::SET_COOKIE) {
            let Ok(raw) = v.to_str() else { continue };
            let Some(canonical) = normalize_set_cookie(raw, url.scheme() == "https") else { continue };
            if cross && !ctx.top_level {
                if let Ok(parsed) = cookie_store::RawCookie::parse(canonical.clone()) {
                    if matches!(parsed.same_site(), Some(cookie::SameSite::Strict) | Some(cookie::SameSite::Lax)) {
                        continue;
                    }
                }
            }
            let _ = self.jar.lock().unwrap().parse(&canonical, url);
        }
    }

    fn send_once(&self, method: &str, url: &str, headers: &BTreeMap<String, String>, body: Option<Vec<u8>>, timeout_secs: u64) -> Result<HttpResponse, HttpError> {
        self.send_once_ctx(method, url, headers, body, timeout_secs, None)
    }

    fn send_once_ctx(&self, method: &str, url: &str, headers: &BTreeMap<String, String>, body: Option<Vec<u8>>, timeout_secs: u64, ctx: Option<&CookieContext>) -> Result<HttpResponse, HttpError> {
        let _wait = NetWait::start();
        let started = std::time::Instant::now();
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| HttpError::Other(e.to_string()))?;
        let client = if ctx.is_some() { self.bare.read().unwrap().clone() } else { self.manual.read().unwrap().clone() };
        let parsed_url = Url::parse(url).ok();
        let mut req = client.request(m, url).timeout(Duration::from_secs(timeout_secs));
        let mut merged = self.default_headers.read().unwrap().clone();
        for (k, v) in headers {
            let lk = k.to_ascii_lowercase();
            if v.is_empty() && (lk.starts_with("sec-fetch-") || lk == "upgrade-insecure-requests") {
                merged.retain(|mk, _| mk.to_ascii_lowercase() != lk);
                continue;
            }
            merged.retain(|mk, _| mk.to_ascii_lowercase() != lk);
            merged.insert(k.clone(), v.clone());
        }
        let mut hm = HeaderMap::new();
        for (k, v) in &merged {
            if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
                hm.insert(name, value);
            }
        }
        if let (Some(c), Some(u)) = (ctx, parsed_url.as_ref()) {
            if !hm.contains_key(reqwest::header::COOKIE) {
                let cookies = self.cookie_header(u, c);
                if let (false, Ok(v)) = (cookies.is_empty(), HeaderValue::from_str(&cookies)) {
                    hm.insert(reqwest::header::COOKIE, v);
                }
            }
        }
        req = req.headers(hm);
        let zero_length = body_needs_zero_length(method, body.as_deref());
        if let Some(b) = body {
            req = req.body(b);
        }
        if zero_length {
            req = req.header(reqwest::header::CONTENT_LENGTH, "0");
        }
        let retry = req.try_clone().and_then(|r| r.build().ok());
        let sent = match req.send() {
            Err(e) if retry.is_some() && is_handshake_reset(&e) => {
                let v4 = if ctx.is_some() { build_bare_client_v(&self.user_agent(), true) } else { build_client_v(&self.user_agent(), self.jar.clone(), false, true) };
                v4.execute(retry.unwrap())
            }
            r => r,
        };
        let resp = match sent {
            Ok(r) => r,
            Err(e) => {
                let dns = is_dns_error(&e);
                let err = map_err(e, url, timeout_secs);
                self.nel_observe(method, url, Err((&err, dns)), started);
                return Err(err);
            }
        };
        if let (Some(c), Some(u)) = (ctx, parsed_url.as_ref()) {
            self.store_cookies(u, &resp, c);
        }
        let out = read_response(resp, started);
        self.nel_observe(method, url, Ok(&out), started);
        Ok(out)
    }

    /// Open a streaming GET and return the response without reading the body
    /// (used by `EventSource`).
    pub fn stream(&self, url: &str, headers: &BTreeMap<String, String>) -> Result<ReqResponse, HttpError> {
        let client = self.inner.read().unwrap().clone();
        let mut hm = HeaderMap::new();
        for (k, v) in self.default_headers.read().unwrap().iter().chain(headers.iter()) {
            if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
                hm.insert(name, value);
            }
        }
        client.get(url).headers(hm).send().map_err(|e| map_err(e, url, 30))
    }

    /// POST a form (`application/x-www-form-urlencoded`).
    pub fn post_form(
        &self,
        url: &str,
        data: &BTreeMap<String, String>,
        headers: &BTreeMap<String, String>,
        timeout_secs: u64,
    ) -> Result<HttpResponse, HttpError> {
        let body = url_encode_form(data);
        let mut h = headers.clone();
        h.insert("Content-Type".into(), "application/x-www-form-urlencoded".into());
        self.request("POST", url, &h, Some(body.into_bytes()), timeout_secs, true)
    }

    /// GET with query parameters appended.
    pub fn get_with_params(
        &self,
        url: &str,
        params: &BTreeMap<String, String>,
        headers: &BTreeMap<String, String>,
        timeout_secs: u64,
    ) -> Result<HttpResponse, HttpError> {
        let full = append_query(url, params);
        self.request("GET", &full, headers, None, timeout_secs, true)
    }
}

/// Who makes a request, for SameSite cookies.
pub struct CookieContext {
    /// The requesting document's URL ("" = no initiator: same-site).
    pub initiator: String,
    /// Some URL of the request's redirect chain was cross-site.
    pub chain_cross: bool,
    /// A top-level navigation (cross-site Lax cookies are sent for safe methods).
    pub top_level: bool,
    pub safe_method: bool,
}

/// Response header block size accepted over HTTP/2 (Chrome's limit; hyper's default is 16 KB,
/// which finance.yahoo.com's ~33 KB of headers exceed).
const MAX_HEADER_LIST_SIZE: u32 = 256 * 1024;

/// A client without redirect following or cookie jar.
fn build_bare_client(ua: &str) -> Client {
    build_bare_client_v(ua, false)
}

fn build_bare_client_v(ua: &str, ipv4_only: bool) -> Client {
    let mut builder = Client::builder()
        .user_agent(ua)
        .http2_max_header_list_size(MAX_HEADER_LIST_SIZE)
        .http1_title_case_headers()
        .referer(false)
        .redirect(reqwest::redirect::Policy::none());
    if ipv4_only {
        builder = builder.local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    }
    if let Ok(hosts) = std::env::var("JB_RESOLVE_HOSTS") {
        let loopback = std::net::SocketAddr::from(([127, 0, 0, 1], 0));
        for host in hosts.split(',').map(str::trim).filter(|h| !h.is_empty()) {
            builder = builder.resolve(host, loopback);
        }
    }
    if std::env::var_os("JB_INSECURE_TLS").is_some() {
        builder = builder.danger_accept_invalid_certs(true);
    }
    builder.build().expect("failed to build HTTP client")
}

fn build_client(ua: &str, jar: Arc<CookieStoreMutex>, follow_redirects: bool) -> Client {
    build_client_v(ua, jar, follow_redirects, false)
}

fn build_client_v(ua: &str, jar: Arc<CookieStoreMutex>, follow_redirects: bool, ipv4_only: bool) -> Client {
    let mut builder = Client::builder()
        .cookie_provider(jar)
        .user_agent(ua)
        .http2_max_header_list_size(MAX_HEADER_LIST_SIZE)
        // Header names go out as `Content-Type`, like browsers send them.
        .http1_title_case_headers()
        // the Referer of a redirected request stays what the page's referrer policy chose
        .referer(false)
        .redirect(if follow_redirects { reqwest::redirect::Policy::limited(20) } else { reqwest::redirect::Policy::none() });
    if ipv4_only {
        builder = builder.local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    }
    // Test infrastructure: `JB_RESOLVE_HOSTS=a,b,c` pins host names to
    // 127.0.0.1 (web-platform-tests' `web-platform.test` family has no DNS
    // entry) and `JB_INSECURE_TLS=1` accepts its self-signed certificates.
    if let Ok(hosts) = std::env::var("JB_RESOLVE_HOSTS") {
        let loopback = std::net::SocketAddr::from(([127, 0, 0, 1], 0));
        for host in hosts.split(',').map(str::trim).filter(|h| !h.is_empty()) {
            builder = builder.resolve(host, loopback);
        }
    }
    if std::env::var_os("JB_INSECURE_TLS").is_some() {
        builder = builder.danger_accept_invalid_certs(true);
    }
    builder.build().expect("failed to build HTTP client")
}

/// TLS configuration for WebSocket connections. It matches what reqwest builds for page requests
/// (process-wide rustls provider, TLS 1.2 + 1.3, the platform certificate verifier), so a
/// WebSocket's TLS handshake looks like the rest of the browser's traffic. ALPN offers only
/// "http/1.1", as Chrome does for a WebSocket connection: the upgrade is an HTTP/1.1 request.
/// tungstenite's own connector sent no ALPN. `insecure` accepts any certificate
/// (`JB_INSECURE_TLS`, web-platform-tests' self-signed CA).
pub fn websocket_tls_config(insecure: bool) -> Result<Arc<rustls::ClientConfig>, String> {
    #[derive(Debug)]
    struct AcceptAll(Arc<rustls::crypto::CryptoProvider>);
    impl rustls::client::danger::ServerCertVerifier for AcceptAll {
        fn verify_server_cert(&self, _: &rustls::pki_types::CertificateDer<'_>, _: &[rustls::pki_types::CertificateDer<'_>], _: &rustls::pki_types::ServerName<'_>, _: &[u8], _: rustls::pki_types::UnixTime) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        }
        fn verify_tls12_signature(&self, _: &[u8], _: &rustls::pki_types::CertificateDer<'_>, _: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }
        fn verify_tls13_signature(&self, _: &[u8], _: &rustls::pki_types::CertificateDer<'_>, _: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }
        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            self.0.signature_verification_algorithms.supported_schemes()
        }
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let provider = rustls::crypto::CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::ring::default_provider()));
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| e.to_string())?;
    let mut config = if insecure {
        builder.dangerous().with_custom_certificate_verifier(Arc::new(AcceptAll(provider))).with_no_client_auth()
    } else {
        let verifier = rustls_platform_verifier::Verifier::new(provider).map_err(|e| e.to_string())?;
        builder.dangerous().with_custom_certificate_verifier(Arc::new(verifier)).with_no_client_auth()
    };
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

/// A connection that failed before any response, other than name resolution or a refused /
/// unreachable host: some CDN IPv6 edges (CloudFront 2600:9000::) accept TCP and then reset the
/// TLS handshake, and hyper's IPv4 fallback only covers the TCP connect. Such a request is retried
/// once over IPv4.
fn is_handshake_reset(e: &reqwest::Error) -> bool {
    if !e.is_connect() || is_dns_error(e) || std::env::var_os("JB_RESOLVE_HOSTS").is_some() {
        return false;
    }
    let mut src: Option<&dyn std::error::Error> = Some(e);
    while let Some(s) = src {
        let t = s.to_string().to_ascii_lowercase();
        if t.contains("refused") || t.contains("unreachable") || t.contains("timed out") {
            return false;
        }
        src = s.source();
    }
    true
}

/// Whether a request failed resolving the host name.
fn is_dns_error(e: &reqwest::Error) -> bool {
    let mut src: Option<&dyn std::error::Error> = Some(e);
    while let Some(s) = src {
        let t = s.to_string().to_ascii_lowercase();
        if t.contains("dns") || t.contains("failed to lookup") || t.contains("no such host") || t.contains("name or service not known") || t.contains("nodename nor servname") {
            return true;
        }
        src = s.source();
    }
    false
}

fn map_err(e: reqwest::Error, url: &str, timeout: u64) -> HttpError {
    if e.is_timeout() {
        HttpError::Timeout(timeout)
    } else if e.is_connect() || e.is_request() && e.to_string().contains("dns") {
        HttpError::Connection(url.to_string())
    } else if let Some(status) = e.status() {
        HttpError::Status { status: status.as_u16(), reason: status.canonical_reason().unwrap_or("").to_string() }
    } else {
        // reqwest's top-level message ("error sending request for url") hides the cause.
        let mut msg = e.to_string();
        let mut src = std::error::Error::source(&e);
        while let Some(s) = src {
            msg.push_str(": ");
            msg.push_str(&s.to_string());
            src = s.source();
        }
        HttpError::Other(msg)
    }
}

fn read_response(resp: ReqResponse, started: std::time::Instant) -> HttpResponse {
    let status = resp.status();
    let url = resp.url().to_string();
    let mut headers: BTreeMap<String, String> = BTreeMap::new();
    for (k, v) in resp.headers() {
        if let Ok(s) = v.to_str() {
            let name = k.as_str().to_ascii_lowercase();
            match headers.get_mut(&name) {
                // repeated fields combine into one comma-separated value (Fetch "get" a header)
                Some(prev) if name != "location" && name != "content-type" && name != "set-cookie" => {
                    prev.push_str(", ");
                    prev.push_str(s);
                }
                _ => {
                    headers.insert(name, s.to_string());
                }
            }
        } else if k.as_str().eq_ignore_ascii_case("location") {
            // raw UTF-8 in Location: URL parsing percent-encodes it
            headers.insert("location".into(), String::from_utf8_lossy(v.as_bytes()).into_owned());
        }
    }
    // hyper keeps a non-canonical HTTP/1 reason phrase as an extension; the
    // canonical one is what it would have sent otherwise (XHR `statusText`).
    let reason = resp
        .extensions()
        .get::<hyper::ext::ReasonPhrase>()
        .map(|r| String::from_utf8_lossy(r.as_bytes()).into_owned())
        .unwrap_or_else(|| status.canonical_reason().unwrap_or("").to_string());
    // Read incrementally and keep what arrived: servers that end a
    // close-delimited body by dropping the TLS connection without
    // close_notify make the final read fail, but the bytes are complete.
    let mut body = Vec::new();
    let mut resp = resp;
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match std::io::Read::read(&mut resp, &mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }
    let content_type = headers.get("content-type").cloned().unwrap_or_default();
    let (text, encoding) = decode_body(&body, &content_type);
    HttpResponse {
        status: status.as_u16(),
        reason,
        url,
        headers,
        text,
        body,
        encoding,
        elapsed: started.elapsed(),
    }
}

/// RFC 6265bis "parse a set-cookie string" and the storage checks that do
/// not need the jar: returns the cookie in canonical `Set-Cookie` form for the
/// store, or `None` when the string must be ignored. Control characters other
/// than HTAB reject the whole string; a nameless pair keeps its value; names,
/// values and attribute values are trimmed of SP/HTAB; oversized pairs (4096)
/// and attribute values (1024) are dropped; unknown attributes are ignored;
/// `__Secure-`/`__Host-` prefixes, `Secure` from an insecure origin and
/// `SameSite=None` without `Secure` reject the cookie.
pub fn normalize_set_cookie(input: &str, secure_origin: bool) -> Option<String> {
    if input.chars().any(|c| (c < ' ' && c != '\t') || c == '\x7f') {
        return None;
    }
    fn trim(s: &str) -> &str {
        s.trim_matches([' ', '\t'])
    }
    let mut parts = input.split(';');
    let pair = parts.next().unwrap_or("");
    let (name, value) = match pair.split_once('=') {
        Some((n, v)) => (trim(n).to_string(), trim(v).to_string()),
        None => (String::new(), trim(pair).to_string()),
    };
    if name.is_empty() && value.is_empty() {
        return None;
    }
    if name.len() + value.len() > 4096 {
        return None;
    }
    let (mut domain, mut path, mut max_age, mut expires, mut same_site) = (None::<String>, None::<String>, None::<String>, None::<String>, None::<String>);
    let (mut secure, mut http_only, mut partitioned) = (false, false, false);
    for attr in parts {
        let attr = trim(attr);
        if attr.is_empty() {
            continue;
        }
        let (aname, avalue) = match attr.split_once('=') {
            Some((n, v)) => (trim(n).to_ascii_lowercase(), trim(v).to_string()),
            None => (attr.to_ascii_lowercase(), String::new()),
        };
        if avalue.len() > 1024 {
            continue;
        }
        match aname.as_str() {
            "expires" => expires = Some(avalue),
            "max-age" => {
                let ok = !avalue.is_empty() && avalue.trim_start_matches('-').chars().all(|c| c.is_ascii_digit()) && avalue.trim_start_matches('-').len() > 0;
                if ok {
                    max_age = Some(avalue);
                }
            }
            "domain" => {
                let d = avalue.trim_start_matches('.').to_ascii_lowercase();
                if !d.is_empty() {
                    domain = Some(d);
                }
            }
            "path" => path = Some(if avalue.starts_with('/') { avalue } else { String::new() }),
            "secure" => secure = true,
            "httponly" => http_only = true,
            "samesite" => {
                let v = avalue.to_ascii_lowercase();
                same_site = Some(match v.as_str() {
                    "strict" => "Strict",
                    "lax" => "Lax",
                    "none" => "None",
                    _ => "Default",
                }
                .to_string());
            }
            "partitioned" => partitioned = true,
            _ => {}
        }
    }
    if secure && !secure_origin {
        return None;
    }
    if same_site.as_deref() == Some("None") && !secure {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    if lower.starts_with("__secure-") && !secure {
        return None;
    }
    if lower.starts_with("__host-") && (!secure || domain.is_some() || path.as_deref() != Some("/")) {
        return None;
    }
    if partitioned && !secure {
        return None;
    }
    let mut out = format!("{name}={value}");
    if let Some(p) = path.filter(|p| !p.is_empty()) {
        out.push_str("; Path=");
        out.push_str(&p);
    }
    if let Some(d) = domain {
        out.push_str("; Domain=");
        out.push_str(&d);
    }
    if let Some(m) = max_age {
        out.push_str("; Max-Age=");
        out.push_str(&m);
    } else if let Some(e) = expires {
        out.push_str("; Expires=");
        out.push_str(&e);
    }
    if secure {
        out.push_str("; Secure");
    }
    if http_only {
        out.push_str("; HttpOnly");
    }
    if let Some(ss) = same_site.filter(|s| s != "Default") {
        out.push_str("; SameSite=");
        out.push_str(&ss);
    }
    Some(out)
}

#[cfg(test)]
mod cookie_tests {
    use super::normalize_set_cookie;

    #[test]
    fn set_cookie_strings_are_normalized() {
        assert_eq!(normalize_set_cookie(" a = b ; Path=/x; HttpOnly; bogus=1", false).as_deref(), Some("a=b; Path=/x; HttpOnly"));
        assert_eq!(normalize_set_cookie("novalue", false).as_deref(), Some("=novalue"));
        assert_eq!(normalize_set_cookie("bad\u{1}name=1", false), None);
        assert_eq!(normalize_set_cookie("tab\tname=1", false).as_deref(), Some("tab\tname=1"));
        assert_eq!(normalize_set_cookie("s=1; Secure", false), None);
        assert_eq!(normalize_set_cookie("s=1; Secure", true).as_deref(), Some("s=1; Secure"));
        assert_eq!(normalize_set_cookie("__Host-a=1; Secure; Path=/", true).as_deref(), Some("__Host-a=1; Path=/; Secure"));
        assert_eq!(normalize_set_cookie("__Host-a=1; Secure", true), None);
        assert_eq!(normalize_set_cookie("n=1; SameSite=None", true), None);
        assert_eq!(normalize_set_cookie("d=1; Domain=.Example.COM; Max-Age=x", false).as_deref(), Some("d=1; Domain=example.com"));
        assert_eq!(normalize_set_cookie(&format!("big={}", "x".repeat(4094)), false), None);
        assert!(normalize_set_cookie(&format!("big={}", "x".repeat(4093)), false).is_some());
    }
}

/// Decode a response body to text following the HTML "determine the
/// character encoding" order: BOM, `charset` parameter, `<meta charset>`
/// prescan, then the default (windows-1252 for HTML, UTF-8 otherwise).
/// Returns the text and the canonical encoding name.
pub fn decode_body(body: &[u8], content_type: &str) -> (String, String) {
    let ct = content_type.to_ascii_lowercase();
    let is_html = ct.starts_with("text/html") || ct.is_empty();
    let encoding = if let Some((enc, _)) = encoding_rs::Encoding::for_bom(body) {
        enc
    } else if let Some(enc) = charset_param(&ct).and_then(|c| encoding_rs::Encoding::for_label(c.as_bytes())) {
        enc
    } else if is_html {
        // no declaration: the prescan, else detection from the content (as browsers do)
        prescan_meta_charset(body).unwrap_or_else(|| {
            let mut det = chardetng::EncodingDetector::new();
            det.feed(body, true);
            // browsers never guess UTF-8 here, and no longer detect ISO-2022-JP
            let g = det.guess(None, false);
            if g == encoding_rs::ISO_2022_JP { encoding_rs::WINDOWS_1252 } else { g }
        })
    } else {
        encoding_rs::UTF_8
    };
    // utf-16 declared via <meta> is treated as utf-8 (HTML spec).
    let (text, used, _) = encoding.decode(body);
    (text.into_owned(), used.name().to_string())
}

fn charset_param(content_type: &str) -> Option<String> {
    for part in content_type.split(';').skip(1) {
        let part = part.trim();
        if let Some(v) = part.strip_prefix("charset=") {
            return Some(v.trim().trim_matches('"').trim_matches('\'').to_string());
        }
    }
    None
}

/// HTML "prescan a byte stream to determine its encoding": UTF-16 XML
/// declarations, `<meta>` charset/pragma in the first 1024 bytes (skipping
/// comments, `<!`/`</`/`<?` constructs and other tags' attributes), then the
/// encoding of an `<?xml ... encoding=...?>` declaration.
fn prescan_meta_charset(body: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    if body.starts_with(b"<\0?\0x\0") {
        return Some(encoding_rs::UTF_16LE);
    }
    if body.starts_with(b"\0<\0?\0x") {
        return Some(encoding_rs::UTF_16BE);
    }
    let b = &body[..body.len().min(1024)];
    let n = b.len();
    let is_ws = |c: u8| matches!(c, 0x09 | 0x0A | 0x0C | 0x0D | 0x20);
    let mut pos = 0;
    while pos < n {
        if b[pos..].starts_with(b"<!--") {
            // the '>' that ends a "-->" after the '<'
            let mut k = pos + 2;
            loop {
                match b[k..].iter().position(|&c| c == b'>') {
                    Some(off) => {
                        k += off;
                        if k >= pos + 5 && b[k - 1] == b'-' && b[k - 2] == b'-' { break; }
                        k += 1;
                    }
                    None => return xml_declaration_encoding(body),
                }
            }
            pos = k + 1;
            continue;
        }
        if n - pos >= 6 && b[pos..pos + 5].eq_ignore_ascii_case(b"<meta") && (is_ws(b[pos + 5]) || b[pos + 5] == b'/') {
            pos += 6;
            let mut seen: Vec<Vec<u8>> = Vec::new();
            let mut got_pragma = false;
            let mut need_pragma: Option<bool> = None;
            let mut charset: Option<&'static encoding_rs::Encoding> = None;
            while let Some((name, value)) = prescan_attribute(b, &mut pos) {
                if seen.contains(&name) { continue; }
                seen.push(name.clone());
                match name.as_slice() {
                    b"http-equiv" => { if value == b"content-type" { got_pragma = true; } }
                    b"content" => {
                        if charset.is_none() {
                            if let Some(enc) = charset_from_meta_content(&value).and_then(|v| encoding_rs::Encoding::for_label(&v)) {
                                charset = Some(enc);
                                need_pragma = Some(true);
                            }
                        }
                    }
                    b"charset" => {
                        charset = encoding_rs::Encoding::for_label(&value);
                        need_pragma = Some(false);
                    }
                    _ => {}
                }
            }
            match (need_pragma, charset) {
                (None, _) | (_, None) => {}
                (Some(true), _) if !got_pragma => {}
                (_, Some(enc)) => {
                    // A <meta> can only declare utf-8 for utf-16 families.
                    return Some(if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE { encoding_rs::UTF_8 } else if enc == encoding_rs::X_USER_DEFINED { encoding_rs::WINDOWS_1252 } else { enc });
                }
            }
            continue;
        }
        if b[pos] == b'<' && pos + 1 < n && (b[pos + 1].is_ascii_alphabetic() || (b[pos + 1] == b'/' && pos + 2 < n && b[pos + 2].is_ascii_alphabetic())) {
            pos += 1;
            while pos < n && !is_ws(b[pos]) && b[pos] != b'>' { pos += 1; }
            while prescan_attribute(b, &mut pos).is_some() {}
            continue;
        }
        if b[pos] == b'<' && pos + 1 < n && matches!(b[pos + 1], b'!' | b'/' | b'?') {
            match b[pos..].iter().position(|&c| c == b'>') {
                Some(off) => pos += off + 1,
                None => break,
            }
            continue;
        }
        pos += 1;
    }
    xml_declaration_encoding(body)
}

/// The prescan's "get an attribute": lowercased name and value, or None at '>' / end of input.
fn prescan_attribute(b: &[u8], pos: &mut usize) -> Option<(Vec<u8>, Vec<u8>)> {
    let n = b.len();
    let is_ws = |c: u8| matches!(c, 0x09 | 0x0A | 0x0C | 0x0D | 0x20);
    while *pos < n && (is_ws(b[*pos]) || b[*pos] == b'/') { *pos += 1; }
    if *pos >= n || b[*pos] == b'>' { return None; }
    let mut name = Vec::new();
    let mut value = Vec::new();
    loop {
        if *pos >= n { return None; }
        let c = b[*pos];
        if c == b'=' && !name.is_empty() { *pos += 1; break; }
        if is_ws(c) {
            while *pos < n && is_ws(b[*pos]) { *pos += 1; }
            if *pos >= n { return None; }
            if b[*pos] != b'=' { return Some((name, value)); }
            *pos += 1;
            break;
        }
        if c == b'/' || c == b'>' { return Some((name, value)); }
        name.push(c.to_ascii_lowercase());
        *pos += 1;
    }
    while *pos < n && is_ws(b[*pos]) { *pos += 1; }
    if *pos >= n { return None; }
    let c = b[*pos];
    if c == b'"' || c == b'\'' {
        *pos += 1;
        loop {
            if *pos >= n { return None; }
            let d = b[*pos];
            *pos += 1;
            if d == c { return Some((name, value)); }
            value.push(d.to_ascii_lowercase());
        }
    }
    if c == b'>' { return Some((name, value)); }
    value.push(c.to_ascii_lowercase());
    *pos += 1;
    while *pos < n && !is_ws(b[*pos]) && b[*pos] != b'>' { value.push(b[*pos].to_ascii_lowercase()); *pos += 1; }
    if *pos >= n { return None; }
    Some((name, value))
}

/// "Extract a character encoding from a meta element" (`content` attribute value).
fn charset_from_meta_content(s: &[u8]) -> Option<Vec<u8>> {
    let is_ws = |c: u8| matches!(c, 0x09 | 0x0A | 0x0C | 0x0D | 0x20);
    let mut pos = 0;
    loop {
        let off = s[pos..].windows(7).position(|w| w.eq_ignore_ascii_case(b"charset"))?;
        pos += off + 7;
        while pos < s.len() && is_ws(s[pos]) { pos += 1; }
        if pos < s.len() && s[pos] == b'=' { pos += 1; break; }
    }
    while pos < s.len() && is_ws(s[pos]) { pos += 1; }
    if pos >= s.len() { return None; }
    let q = s[pos];
    if q == b'"' || q == b'\'' {
        let end = s[pos + 1..].iter().position(|&c| c == q)?;
        return Some(s[pos + 1..pos + 1 + end].to_vec());
    }
    let end = s[pos..].iter().position(|&c| is_ws(c) || c == b';').map(|e| pos + e).unwrap_or(s.len());
    Some(s[pos..end].to_vec())
}

/// HTML "get an XML encoding" from an `<?xml ... encoding="..."?>` at the start of the stream.
fn xml_declaration_encoding(body: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    if !body.starts_with(b"<?xml") { return None; }
    let end = body.iter().position(|&c| c == b'>')?;
    let mut pos = 5 + body[5..end].windows(8).position(|w| w == b"encoding")? + 8;
    while pos < end && body[pos] <= 0x20 { pos += 1; }
    if pos >= end || body[pos] != b'=' { return None; }
    pos += 1;
    while pos < end && body[pos] <= 0x20 { pos += 1; }
    let q = *body.get(pos)?;
    if q != b'"' && q != b'\'' { return None; }
    pos += 1;
    let close = pos + body[pos..].iter().position(|&c| c == q)?;
    let label = &body[pos..close];
    if label.iter().any(|&c| c <= 0x20) { return None; }
    let enc = encoding_rs::Encoding::for_label(label)?;
    Some(if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE { encoding_rs::UTF_8 } else { enc })
}

/// MIME Sniffing "JSON MIME type": a valid `type/subtype` essence that is application/json,
/// text/json, or whose subtype ends in "+json". `essence` is lower-cased without parameters.
pub fn is_json_mime(essence: &str) -> bool {
    let token = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&b));
    let Some((ty, sub)) = essence.split_once('/') else { return false };
    if !token(ty) || !token(sub) {
        return false;
    }
    essence == "application/json" || essence == "text/json" || sub.ends_with("+json")
}

/// `urllib.parse.urlencode`
pub fn url_encode_form(data: &BTreeMap<String, String>) -> String {
    data.iter()
        .map(|(k, v)| format!("{}={}", form_encode(k), form_encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

fn form_encode(s: &str) -> String {
    use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
    const SET: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');
    utf8_percent_encode(s, SET).to_string().replace("%20", "+")
}

/// Append params to a URL as query string.
pub fn append_query(url: &str, params: &BTreeMap<String, String>) -> String {
    if params.is_empty() {
        return url.to_string();
    }
    let sep = if url.contains('?') { "&" } else { "?" };
    format!("{url}{sep}{}", url_encode_form(params))
}

/// Normalise a user-supplied URL: add `https://` when no scheme is present.
pub fn normalize_url(url: &str) -> String {
    let url = url.trim();
    if url.starts_with("//") {
        format!("https:{url}")
    } else if !url.starts_with("http://") && !url.starts_with("https://") {
        format!("https://{url}")
    } else {
        url.to_string()
    }
}

/// `urllib.parse.urljoin`
pub fn urljoin(base: &str, href: &str) -> String {
    match Url::parse(base) {
        Ok(b) => b.join(href).map(|u| u.to_string()).unwrap_or_else(|_| href.to_string()),
        Err(_) => href.to_string(),
    }
}

/// Fetch, "HTTP-network-or-cache fetch": a POST or PUT whose body is null (or empty) carries
/// `Content-Length: 0`; servers such as IIS answer 411 Length Required without it.
fn body_needs_zero_length(method: &str, body: Option<&[u8]>) -> bool {
    body.map_or(true, |b| b.is_empty()) && (method.eq_ignore_ascii_case("POST") || method.eq_ignore_ascii_case("PUT"))
}
