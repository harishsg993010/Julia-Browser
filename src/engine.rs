//! Browser Engine - core functionality for web browsing: HTTP requests through
//! the intercepting proxy, HTML parsing, JavaScript execution and the rendering
//! pipeline.

use crate::css_parser::CssParser;
use crate::dom::{self, Document};
use crate::http::{self, HttpClient, HttpError, HttpResponse};
use crate::js::{JavaScriptEngine, JsConfig, JsExecution};
use crate::proxy::ProxyServer;
use crate::renderer::HtmlRenderer;
use ego_tree::NodeId;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::LazyLock;
use url::Url;

static JS_REDIRECT_RES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r#"window\.location\.replace\(["']([^"']+)["']\)"#,
        r#"window\.location\.href\s*=\s*["']([^"']+)["']"#,
        r#"location\.replace\(["']([^"']+)["']\)"#,
        r#"location\.href\s*=\s*["']([^"']+)["']"#,
        r#"window\.parent\.location\.replace\(["']([^"']+)["']\)"#,
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

/// A link found on the current page.
#[derive(Debug, Clone, Serialize)]
pub struct Link {
    pub text: String,
    pub url: String,
    pub title: String,
}

/// A fetched page: raw HTML, parsed document and the HTTP response.
#[derive(Debug)]
pub struct Page {
    pub html: String,
    pub document: Document,
    pub response: HttpResponse,
}

/// Errors from fetching.
#[derive(Debug, thiserror::Error)]
pub enum BrowseError {
    #[error("{0}")]
    Http(#[from] HttpError),
    #[error("{0}")]
    Other(String),
}

/// Core browser engine: fetching, navigation state and rendering.
pub struct BrowserEngine {
    pub user_agent: String,
    pub session: HttpClient,
    pub base_headers: BTreeMap<String, String>,
    pub renderer: HtmlRenderer,
    pub js_engine: JavaScriptEngine,
    pub css_parser: CssParser,
    pub proxy: ProxyServer,
    /// Whether page JavaScript is executed on fetch.
    pub execute_js: bool,
    pub history: Vec<String>,
    pub history_index: isize,
    pub current_url: Option<String>,
    pub current_document: Option<Document>,
    pub current_links: Vec<Link>,
    pub bookmarks: BTreeMap<String, String>,
    pub current_content_type: String,
    pub current_json_data: Option<Value>,
    /// Result of the last JavaScript run (if any).
    pub last_js: Option<JsExecution>,
    pub default_timeout: u64,
    /// The document that started the next top-level navigation (`location.href = ...`, a link
    /// click, a form): (its URL, referrer policy, user-activated). `fetch_page` takes it and sends
    /// that navigation with a Referer and Sec-Fetch-* relative to it, as a browser does; without
    /// it every followed navigation looked typed in (NVIDIA's driver results bounced back to the
    /// form because `document.referrer` was empty).
    pub nav_initiator: Option<(String, String, bool)>,
}

/// The subresources a browser's preload scanner would start fetching for `doc`: external scripts,
/// stylesheets, preloads and images (bounded), resolved against the document base URL.
/// The preload scanner's requests: each subresource URL with its request destination.
pub fn subresource_requests(doc: &Document, page_url: &str) -> Vec<(String, &'static str)> {
    let mut out: Vec<(String, &'static str)> = Vec::new();
    let mut kinds: std::collections::HashMap<String, &'static str> = std::collections::HashMap::new();
    let base = dom::find_all(doc, &["base"]).into_iter().find_map(|b| dom::attr(doc, b, "href")).map(|h| http::urljoin(page_url, h.trim())).unwrap_or_else(|| page_url.to_string());
    let abs = |raw: &str| { let u = http::urljoin(&base, raw.trim()); u.split('#').next().unwrap_or(&u).to_string() };
    for s in dom::find_all(doc, &["script"]) {
        let module = dom::attr(doc, s, "type").is_some_and(|t| t.trim().eq_ignore_ascii_case("module"));
        if let Some(src) = dom::attr(doc, s, "src") {
            kinds.insert(abs(&src), if module { "" } else { "script" });
        }
    }
    for l in dom::find_all(doc, &["link"]) {
        let rel = dom::attr(doc, l, "rel").unwrap_or_default().to_ascii_lowercase();
        if let Some(h) = dom::attr(doc, l, "href") {
            if rel.split_whitespace().any(|r| r == "stylesheet") {
                kinds.insert(abs(&h), "style");
            } else if rel.split_whitespace().any(|r| r == "modulepreload") {
                kinds.insert(abs(&h), "");
            }
        }
    }
    for i in dom::find_all(doc, &["img"]) {
        if let Some(src) = dom::attr(doc, i, "src") {
            kinds.entry(abs(&src)).or_insert("image");
        }
    }
    for u in subresource_urls(doc, page_url) {
        match kinds.get(&u) {
            // module scripts are prefetched by the module loader with cors-mode headers
            Some(&"") => {}
            Some(k) => out.push((u, *k)),
            // preloads with an unknown destination keep the plain request
            None => out.push((u, "")),
        }
    }
    out
}

pub fn subresource_urls(doc: &Document, page_url: &str) -> Vec<String> {
    let base = dom::find_all(doc, &["base"]).into_iter().find_map(|b| dom::attr(doc, b, "href")).map(|h| http::urljoin(page_url, h.trim())).unwrap_or_else(|| page_url.to_string());
    let mut out: Vec<String> = Vec::new();
    let mut push = |raw: &str| {
        let raw = raw.trim();
        if raw.is_empty() || raw.starts_with("data:") || raw.starts_with("javascript:") || raw.starts_with('#') {
            return;
        }
        let u = http::urljoin(&base, raw);
        let u = u.split('#').next().unwrap_or(&u).to_string();
        if !out.contains(&u) {
            out.push(u);
        }
    };
    for s in dom::find_all(doc, &["script"]) {
        if let Some(src) = dom::attr(doc, s, "src") {
            push(&src);
        }
    }
    for l in dom::find_all(doc, &["link"]) {
        let rel = dom::attr(doc, l, "rel").unwrap_or_default().to_ascii_lowercase();
        if rel.split_whitespace().any(|r| matches!(r, "stylesheet" | "preload" | "modulepreload")) && !rel.contains("alternate") {
            if let Some(h) = dom::attr(doc, l, "href") {
                push(&h);
            }
        }
    }
    let mut images = 0;
    for i in dom::find_all(doc, &["img"]) {
        if images >= 24 || dom::attr(doc, i, "loading").is_some_and(|l| l.eq_ignore_ascii_case("lazy")) {
            continue;
        }
        if let Some(src) = dom::attr(doc, i, "src") {
            push(&src);
            images += 1;
        }
    }
    out
}

/// Outcome of a user action (click, type, press, ...) performed through the page's JavaScript.
#[derive(Debug, Default)]
pub struct UserActionOutcome {
    /// The action's JSON report from the page (`{ok, el}` or `{error}`).
    pub report: Value,
    /// A navigation the action started (link click, location change).
    pub navigation: Option<String>,
    /// A form submission the action started.
    pub submission: Option<crate::js::FormSubmission>,
    pub dom_changed: bool,
    pub console: Vec<String>,
    pub errors: Vec<String>,
}

/// JavaScript performing `action` on the element `target` (CSS selector, `text=...`, or a JS-side
/// node id as a number) with `value`, through the trusted user-input layer (`__jb.user`).
pub fn user_action_script(action: &str, target: &str, value: Option<&str>) -> String {
    let t = if !target.is_empty() && target.chars().all(|c| c.is_ascii_digit()) { target.to_string() } else { serde_json::to_string(target).unwrap_or_else(|_| "\"\"".into()) };
    let v = serde_json::to_string(&value).unwrap_or_else(|_| "null".into());
    let a = serde_json::to_string(action).unwrap_or_else(|_| "\"\"".into());
    let body = format!(
        r#"(function () {{
  var U = __jb.user, action = {a}, spec = {t}, value = {v};
  var el = spec === "" ? (document.activeElement || document.body) : U.find(spec);
  if (!el && action !== "press" && action !== "scroll") return __jb.hostJson({{ error: "No element matches " + __jb.hostJson(spec) }});
  var out = {{ ok: true }};
  // Like a user (and WebDriver/Playwright): pointer and typing actions need a rendered element.
  if (el && /^(click|dblclick|rightclick|hover|type|fill|clear|check|uncheck|select|focus)$/.test(action) && !__jb.isRendered(el))
    return __jb.hostJson({{ error: "Element " + __jb.hostJson(spec) + " is not visible (hidden, display:none or not rendered)", el: U.describe(el) }});
  switch (action) {{
    case "click": U.click(el); break;
    case "dblclick": U.dblclick(el); break;
    case "rightclick": U.click(el, {{ button: 2 }}); break;
    case "hover": U.hover(el); break;
    case "focus": U.focus(el); break;
    case "type": case "fill":
      out.value = U.shownValue(el, U.type(el, value || "", {{ clear: action === "fill" }}));
      if (U.deepActive() !== el && !el.isContentEditable) return __jb.hostJson({{ error: "Element " + __jb.hostJson(spec) + " could not be focused for typing (disabled, read-only or not editable)", el: U.describe(el) }});
      break;
    case "clear": U.clear(el); break;
    case "press": U.pressKey(value || "Enter", el && spec !== "" ? el : null); break;
    case "select": if (!U.select(el, value)) return __jb.hostJson({{ error: "No option " + __jb.hostJson(value) }}); break;
    case "check": if (!U.setChecked(el, true)) return __jb.hostJson({{ error: "Could not check the element" }}); break;
    case "uncheck": if (!U.setChecked(el, false)) return __jb.hostJson({{ error: "Could not uncheck the element" }}); break;
    case "scroll": if (el && spec !== "") U.scrollIntoView(el); else window.scrollBy(0, Number(value) || window.innerHeight * 0.875); break;
    case "exists": break;
    default: return __jb.hostJson({{ error: "Unknown action " + action }});
  }}
  out.el = el && el.isConnected ? U.describe(el) : null;
  return __jb.hostJson(out);
}})()"#
    );
    if t.starts_with('"') && target != "" {
        let src = serde_json::to_string(&body).unwrap_or_else(|_| "\"\"".into());
        format!(
            r#"(function () {{
  var spec = {t}, el = null;
  try {{ el = __jb.user.find(spec); }} catch (e) {{ el = null; }}
  if (!el && typeof __jb.findFrameFor === "function") {{ var w = __jb.findFrameFor(spec); if (w) return w.eval({src}); }}
  return {body};
}})()"#
        )
    } else {
        body
    }
}

impl BrowserEngine {
    /// Perform a user action on the current document through its live JavaScript realm, then let
    /// timers and network callbacks settle. See [`user_action_script`].
    pub fn user_action(&mut self, doc: &mut Document, url: &str, action: &str, target: &str, value: Option<&str>) -> UserActionOutcome {
        // Typing: focus first and let the page react before the keys arrive, as with a person.
        // Search boxes often mount their real component on first focus (a lazy chunk, a fetch);
        // typing in the same task left the text in the placeholder input, which the component then
        // reset to its empty state (dev.to, Walmart).
        if (action == "fill" || action == "type") && !target.is_empty() {
            let focus = self.user_script(doc, url, &user_action_script("focus", target, None));
            if focus.report.get("error").is_some() || focus.navigation.is_some() || focus.submission.is_some() {
                return focus;
            }
        }
        let script = user_action_script(action, target, value);
        self.user_script(doc, url, &script)
    }

    /// Run a user-input script (one that returns a JSON report string like `user_action_script`)
    /// against the live realm and collect what it started (navigation, form submission).
    pub fn user_script(&mut self, doc: &mut Document, url: &str, script: &str) -> UserActionOutcome {
        let exec = self.js_engine.execute_script(script, Some(doc), url);
        let report = exec.result.as_deref().and_then(|r| serde_json::from_str::<Value>(r).ok()).unwrap_or_else(|| json!({"error": exec.errors.first().cloned().unwrap_or_else(|| "the page did not run the action".into())}));
        // A link to the current URL plus a fragment (`href="#"`, `#top`) is a scroll in the same
        // document, not a reload (Trader Joe's store picker reloaded the page after its onClick).
        let strip = |u: &str| u.split('#').next().unwrap_or("").to_string();
        let navigation = exec.navigations.first().map(|n| n.url.clone()).filter(|n| !(n.contains('#') && strip(n) == strip(url)));
        if navigation.is_some() {
            let policy = exec.navigations.first().and_then(|n| n.referrer_policy.clone()).unwrap_or_default();
            self.nav_initiator = Some((url.to_string(), policy, true));
        }
        let submission = exec.form_submissions.first().cloned();
        UserActionOutcome { report, navigation, submission, dom_changed: !exec.dom_updates.is_empty(), console: exec.console.clone(), errors: exec.errors.clone() }
    }

    pub fn new(user_agent: Option<&str>) -> Self {
        Self::with_js_config(user_agent, JsConfig::default())
    }

    pub fn with_js_config(user_agent: Option<&str>, js_config: JsConfig) -> Self {
        // a browser engine loads real pages (the WPT runner drives JavaScriptEngine directly);
        // without this, script-less pages never went through run_page and kept WPT behaviour
        // (@keyframes stripped from the layout, CSS fade-ins stuck at opacity 0)
        crate::js::runtime::set_real_pages(true);
        let ua = user_agent.unwrap_or(http::DEFAULT_USER_AGENT).to_string();
        let session = HttpClient::new(Some(&ua));
        let base_headers: BTreeMap<String, String> = [
            ("User-Agent", ua.as_str()),
            ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"),
            ("Accept-Language", "en-US,en;q=0.9"),
            ("DNT", "1"),
            ("Upgrade-Insecure-Requests", "1"),
            ("Sec-Fetch-Dest", "document"),
            ("Sec-Fetch-Mode", "navigate"),
            ("Sec-Fetch-Site", "none"),
            ("Sec-Fetch-User", "?1"),
            ("Cache-Control", "max-age=0"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        session.set_default_headers(base_headers.clone());
        Self {
            user_agent: ua,
            js_engine: JavaScriptEngine::with_config(session.clone(), js_config),
            css_parser: CssParser::new(Some(session.clone())),
            session,
            base_headers,
            renderer: HtmlRenderer::new(),
            proxy: ProxyServer::new(),
            execute_js: true,
            history: Vec::new(),
            history_index: -1,
            current_url: None,
            current_document: None,
            current_links: Vec::new(),
            bookmarks: BTreeMap::new(),
            current_content_type: "text/html".into(),
            current_json_data: None,
            last_js: None,
            default_timeout: 30,
            nav_initiator: None,
        }
    }

    /// Headers signalling a JavaScript-capable Chromium browser, with a few
    /// site-specific additions.
    /// Request headers of a top-level navigation to `url`; with an initiating document, the
    /// client computes Referer and Sec-Fetch-* per redirect hop (internal markers).
    pub fn navigation_headers(&self, url: &str, initiator: Option<&(String, String, bool)>) -> BTreeMap<String, String> {
        let mut h = self.get_js_enhanced_headers(url);
        if let Some((source, policy, user)) = initiator {
            if source.starts_with("http") {
                h.retain(|k, _| !k.eq_ignore_ascii_case("referer"));
                let (k, v) = http::referrer_marker(source, policy);
                h.insert(k, v);
                let (k, v) = http::fetch_metadata_marker("document", "navigate", source, if *user { "?1" } else { "" });
                h.insert(k, v);
            }
        }
        h
    }

    pub fn get_js_enhanced_headers(&self, url: &str) -> BTreeMap<String, String> {
        let mut h = self.base_headers.clone();
        for (k, v) in [
            ("sec-ch-ua", "\"Google Chrome\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\""),
            ("sec-ch-ua-mobile", "?0"),
            ("sec-ch-ua-platform", "\"Windows\""),
            ("sec-ch-ua-full-version-list", "\"Google Chrome\";v=\"131.0.6778.205\", \"Chromium\";v=\"131.0.6778.205\", \"Not_A Brand\";v=\"24.0.0.0\""),
            ("sec-ch-ua-arch", "\"x86\""),
            ("sec-ch-ua-bitness", "\"64\""),
            ("sec-ch-ua-model", "\"\""),
            ("sec-ch-ua-wow64", "?0"),
        ] {
            h.insert(k.into(), v.into());
        }
        let domain = url.to_lowercase();
        if domain.contains("x.com") || domain.contains("twitter.com") {
            h.insert("X-Twitter-Client-Language".into(), "en".into());
            h.insert("X-Twitter-Active-User".into(), "yes".into());
        } else if domain.contains("facebook.com") || domain.contains("fb.com") {
            h.insert("X-ASBD-ID".into(), "129477".into());
        } else if ["google.com", "gmail.com", "youtube.com", "googleusercontent.com"].iter().any(|d| domain.contains(d)) {
            h.insert("Sec-Ch-Prefers-Color-Scheme".into(), "light".into());
            h.insert("Sec-Ch-Prefers-Reduced-Motion".into(), "no-preference".into());
            h.insert("Sec-Ch-Viewport-Width".into(), "1280".into());
            h.insert("Sec-Ch-Device-Memory".into(), "8".into());
        }
        if url.contains("/search") {
            if let Some(idx) = url.find("/search") {
                h.insert("Referer".into(), format!("{}/", &url[..idx]));
            }
        }
        h
    }

    /// Heuristic: does the page need JavaScript to show its content?
    pub fn detect_js_requirement(&self, doc: &Document, html: &str) -> bool {
        const PATTERNS: &[&str] = &[
            "javascript is disabled", "enable javascript", "javascript is not available", "javascript must be enabled", "requires javascript",
            "<div id=\"root\"", "<div id=\"app\"", "data-reactroot", "ng-app=", "v-app", "<noscript>", "window.__initial_state__",
            "window.__preloaded_state__", "window.app_config", "spa-", "single-page", "dynamic-content",
        ];
        let lower = html.to_lowercase();
        if PATTERNS.iter().any(|p| lower.contains(p)) {
            return true;
        }
        let text = dom::visible_text(doc);
        if text.split_whitespace().collect::<String>().chars().count() < 200 && !dom::find_all(doc, &["script"]).is_empty() {
            return true;
        }
        for id in dom::find_all(doc, &["main", "div"]) {
            if matches!(dom::attr(doc, id, "id").as_deref(), Some("root" | "app" | "content" | "main")) && !dom::has_text(doc, id) {
                return true;
            }
        }
        false
    }

    /// Make an HTTP request through the intercepting proxy.
    pub fn proxy_request(&self, method: &str, url: &str, headers: &BTreeMap<String, String>, body: Option<String>, timeout: u64) -> Result<HttpResponse, HttpError> {
        let intercepted = self.proxy.intercept_request(method, url, headers, body);
        if intercepted.is_blocked() {
            let mut h = BTreeMap::new();
            h.insert("x-blocked-by-proxy".to_string(), "true".to_string());
            let text = "Request blocked by proxy rule".to_string();
            return Ok(HttpResponse { status: 403, reason: "Forbidden".into(), url: intercepted.url, headers: h, body: text.as_bytes().to_vec(), text, encoding: "UTF-8".into(), elapsed: Default::default() });
        }
        let body_bytes = intercepted.body.as_ref().map(|b| b.as_bytes().to_vec());
        let mut req_headers = intercepted.headers.clone();
        if body_bytes.is_some() && !req_headers.keys().any(|k| k.eq_ignore_ascii_case("content-type")) {
            req_headers.insert("Content-Type".into(), "application/x-www-form-urlencoded".into());
        }
        let response = self.session.request(&intercepted.method, &intercepted.url, &req_headers, body_bytes, timeout, true)?;
        let modified = self.proxy.intercept_response(&intercepted, response.status, &response.headers, Some(response.text.clone()));
        // A rule that rewrote the (text) body replaces the raw bytes too.
        let (text, body) = match modified.body {
            Some(b) if b != response.text => {
                let bytes = b.as_bytes().to_vec();
                (b, bytes)
            }
            _ => (response.text, response.body),
        };
        Ok(HttpResponse { status: modified.status_code, reason: response.reason, url: response.url, headers: modified.headers, text, body, encoding: response.encoding, elapsed: response.elapsed })
    }

    /// Fetch a page, run its JavaScript (when enabled) and update navigation state.
    pub fn fetch_page(&mut self, url: &str, timeout: u64) -> Result<Page, BrowseError> {
        let url = http::normalize_url(url);
        let initiator = self.nav_initiator.take();
        let headers = self.navigation_headers(&url, initiator.as_ref());
        let mut response = self.proxy_request("GET", &url, &headers, None, timeout)?;
        // The fragment is not sent to the server but belongs to the document's URL (a redirect
        // without a fragment of its own inherits it): hash-routed pages read their state from it.
        if let Some((_, frag)) = url.split_once('#') {
            if !response.url.contains('#') && (response.url.starts_with("http://") || response.url.starts_with("https://")) {
                response.url = format!("{}#{}", response.url, frag);
            }
        }
        // Error responses are pages too (404 pages, challenge/blocked pages): render their body as a
        // browser does, and fail only when there is nothing to show.
        if response.status >= 400 && response.text.trim().is_empty() {
            return Err(HttpError::Status { status: response.status, reason: response.reason.clone() }.into());
        }
        let mut document = self.parse_response(&response);
        // Preload scanner: fetch the document's subresources concurrently while scripts run in order.
        // one prefetch batch per request destination (each batch has a bounded worker pool)
        let mut groups: Vec<(&'static str, Vec<String>)> = Vec::new();
        for (u, dest) in subresource_requests(&document, &response.url) {
            match groups.iter_mut().find(|g| g.0 == dest) {
                Some(g) => g.1.push(u),
                None => groups.push((dest, vec![u])),
            }
        }
        for (dest, urls) in groups {
            if dest.is_empty() {
                self.session.prefetch(urls, timeout);
            } else {
                let headers = http::fetch_metadata_headers(dest, "no-cors", &response.url, "");
                self.session.prefetch_with(urls, headers, timeout);
            }
        }
        if self.current_json_data.is_none() {
            if let Some(redirect) = self.handle_client_side_redirects(&document, &response.url) {
                if redirect != response.url {
                    if let Ok(r2) = self.proxy_request("GET", &redirect, &headers, None, timeout) {
                        if r2.status < 400 || !r2.text.trim().is_empty() {
                            document = dom::parse_document(&r2.text);
                            response = r2;
                        }
                    }
                }
            }
        }

        self.last_js = None;
        self.js_engine.document_charset = Some(response.encoding.clone());
        self.js_engine.document_headers = Some(response.headers.clone());
        // A new document: the previous page's realm is no longer the live one (even at the same URL).
        self.js_engine.invalidate_live();
        if self.execute_js && self.current_json_data.is_none() && !dom::find_all(&document, &["script"]).is_empty() {
            let exec = self.js_engine.run_page(&mut document, &response.url, Some(INIT_JS));
            self.last_js = Some(exec);
            // Navigations requested by scripts (`location.href = …`, submitted
            // forms, activated links) are followed like a browser would, for a
            // bounded number of hops.
            let mut reloaded = false;
            for _hop in 0..MAX_SCRIPT_NAVIGATIONS {
                let Some((method, target, body)) = self.pending_script_navigation(&response.url, &document, reloaded) else { break };
                reloaded |= target == response.url;
                let policy = self.last_js.as_ref().and_then(|e| e.navigations.first()).and_then(|n| n.referrer_policy.clone()).unwrap_or_default();
                let nav_headers = self.navigation_headers(&target, Some(&(response.url.clone(), policy, false)));
                let Ok(next) = self.proxy_request(&method, &target, &nav_headers, body, timeout) else { break };
                // error pages are pages (block / captcha / 404 pages): shown, as a browser does
                if next.status >= 400 && next.text.trim().is_empty() {
                    break;
                }
                response = next;
                document = self.parse_response(&response);
                self.js_engine.document_charset = Some(response.encoding.clone());
                self.js_engine.document_headers = Some(response.headers.clone());
                self.last_js = None;
                self.js_engine.invalidate_live();
                if self.current_json_data.is_none() && !dom::find_all(&document, &["script"]).is_empty() {
                    let exec = self.js_engine.run_page(&mut document, &response.url, Some(INIT_JS));
                    self.last_js = Some(exec);
                } else {
                    break;
                }
            }
        }

        self.current_url = Some(response.url.clone());
        if self.history_index < 0 || self.history.get(self.history_index as usize) != Some(&response.url) {
            // Drop forward history when navigating somewhere new.
            if self.history_index >= 0 && (self.history_index as usize) + 1 < self.history.len() {
                self.history.truncate(self.history_index as usize + 1);
            }
            self.history.push(response.url.clone());
            self.history_index = self.history.len() as isize - 1;
        }
        self.current_links = extract_links(&document);
        self.current_document = Some(document.clone());
        Ok(Page { html: response.text.clone(), document, response })
    }

    /// The navigation the last script run asked for, if it leads to a new
    /// document: `(method, url, body)`. Fragment-only changes, `javascript:`
    /// URLs and reloads of the same URL are not navigations here.
    fn pending_script_navigation(&self, current_url: &str, doc: &Document, reloaded: bool) -> Option<(String, String, Option<String>)> {
        let exec = self.last_js.as_ref()?;
        if let Some(sub) = exec.form_submissions.first() {
            if sub.method.eq_ignore_ascii_case("dialog") {
                return None;
            }
            let (method, url, body, _) = sub.request();
            return Some((method, url, body));
        }
        let Some(nav) = exec.navigations.iter().find(|n| n.kind != "reload" && n.kind != "open") else {
            // A page with next to no content that reloads itself is an interstitial (a cookie
            // check, a JS challenge that has set its token): follow that reload once per load.
            // Other reloads stay ignored (the virtual clock fires auto-refresh timers early).
            let reload = exec.navigations.iter().any(|n| n.kind == "reload");
            if reload && !reloaded && dom::visible_text(doc).split_whitespace().map(|w| w.len() + 1).sum::<usize>() < 400 {
                return Some(("GET".into(), current_url.to_string(), None));
            }
            return None;
        };
        let target = nav.url.trim();
        if target.is_empty() || target.starts_with("javascript:") || target.starts_with("about:") || target.starts_with("blob:") || target.starts_with("data:") {
            return None;
        }
        // Same document except for the fragment: a scroll, not a navigation.
        let strip = |u: &str| u.split('#').next().unwrap_or("").to_string();
        if strip(target) == strip(current_url) {
            return None;
        }
        Some(("GET".into(), target.to_string(), None))
    }

    /// Parse a response body into a document. JSON responses become a
    /// browsable JSON view (and are remembered in `current_json_data`).
    pub fn parse_response(&mut self, response: &HttpResponse) -> Document {
        let content_type = response.content_type();
        self.current_content_type = content_type.clone();
        if content_type.contains("application/json") || response.url.ends_with(".json") {
            if let Ok(v) = serde_json::from_str::<Value>(&response.text) {
                let doc = json_to_html(&v, &response.url);
                self.current_json_data = Some(v);
                return doc;
            }
        }
        self.current_json_data = None;
        if content_type.contains("application/pdf") || response.body.starts_with(b"%PDF-") {
            return pdf_to_html(&response.body, &response.url);
        }
        if let Some(doc) = media_document(&content_type, &response.url) {
            return doc;
        }
        dom::parse_document(&response.text)
    }

    /// Find meta-refresh / JavaScript / DuckDuckGo-style redirects.
    pub fn handle_client_side_redirects(&self, doc: &Document, current_url: &str) -> Option<String> {
        for id in dom::find_all(doc, &["meta"]) {
            if dom::attr(doc, id, "http-equiv").map(|v| v.eq_ignore_ascii_case("refresh")).unwrap_or(false) {
                let content = dom::attr(doc, id, "content").unwrap_or_default();
                if let Some(pos) = content.to_uppercase().find("URL=") {
                    let target = content[pos + 4..].trim().trim_matches(['"', '\'']);
                    if let Some(r) = resolve_redirect(target, current_url) {
                        return Some(r);
                    }
                }
            }
        }
        // Guessing redirects from script text is only a fallback for runs without JavaScript: with
        // JS the scripts themselves navigate, and a regex cannot see conditions (Figma's homepage
        // redirects to the app only when a login cookie exists).
        let script_ids = if self.execute_js { Vec::new() } else { dom::find_all(doc, &["script"]) };
        for id in script_ids {
            let text = dom::get_text(doc, id);
            for re in JS_REDIRECT_RES.iter() {
                if let Some(c) = re.captures(&text) {
                    if let Some(r) = resolve_redirect(&c[1], current_url) {
                        return Some(r);
                    }
                }
            }
        }
        if current_url.contains("duckduckgo.com/l/") {
            if let Ok(u) = Url::parse(current_url) {
                if let Some((_, v)) = u.query_pairs().find(|(k, _)| k == "uddg") {
                    return Some(v.into_owned());
                }
            }
        }
        None
    }

    /// Render a document to markdown (clean mode).
    pub fn render_page(&self, doc: &Document, _execute_js: bool) -> String {
        self.render_page_mode(doc, true)
    }

    /// Render a document in clean or full mode. With a layout (Cargo feature
    /// `layout`) the document is first rewritten into visual order; clean
    /// mode also puts the main column before the sidebars.
    pub fn render_page_mode(&self, doc: &Document, clean_mode: bool) -> String {
        let visual = self.visual_document(doc, clean_mode);
        let doc = visual.as_ref().unwrap_or(doc);
        if let Some(path) = std::env::var_os("JB_DUMP_RENDER") {
            let _ = std::fs::write(path, dom::to_html(doc));
        }
        let mut css_rules = self.css_parser.extract_css_from_document(doc, self.current_url.as_deref());
        // With a layout, hidden elements were already dropped using real computed styles; the
        // regex rules (no specificity, no selector context, no inline overrides) hid whole pages
        // (UPS: read() returned nothing).
        if visual.is_some() {
            for rules in css_rules.values_mut() {
                rules.remove("display");
            }
        }
        let js_context = self.last_js.as_ref().map(|j| j.to_context());
        self.renderer.render_to_markdown(doc, Some(&css_rules), js_context.as_ref(), clean_mode)
    }

    #[cfg(not(feature = "layout"))]
    fn visual_document(&self, _doc: &Document, _reader: bool) -> Option<Document> {
        None
    }

    /// `doc` reordered by its layout (`layout::visual`), or `None` when no
    /// usable layout exists.
    #[cfg(feature = "layout")]
    fn visual_document(&self, doc: &Document, reader: bool) -> Option<Document> {
        // Escape hatch for comparing against DOM order.
        if std::env::var_os("JB_DOM_ORDER").is_some() {
            return None;
        }
        let (boxes, viewport) = self.layout_boxes_for(doc)?;
        let opts = crate::layout::visual::Options { viewport: (viewport.0 as f64, viewport.1 as f64), reader };
        crate::layout::visual::reorder(doc, &boxes, opts)
    }

    /// Boxes for `doc`'s elements: from the live page's layout when `doc` is
    /// its mirror, otherwise by laying the document out directly.
    #[cfg(feature = "layout")]
    fn layout_boxes_for(&self, doc: &Document) -> Option<(std::collections::HashMap<NodeId, crate::layout::BoxInfo>, (u32, u32))> {
        let url = self.current_url.as_deref().unwrap_or("about:blank");
        if self.js_engine.is_live(url) {
            // The page re-lays itself out when the DOM changed since the last query.
            let _ = crate::js::runtime::eval("__jb.layoutQuery('size', { fresh: true })", "layout.js");
            if let Some((by_jbid, viewport)) = crate::js::runtime::with_host(|h| h.layout_boxes()).flatten() {
                let map = self.js_engine.node_map();
                let mut boxes = std::collections::HashMap::with_capacity(by_jbid.len());
                let mut mismatched = 0usize;
                let debug = std::env::var_os("JB_VISUAL_DEBUG").is_some();
                for (jbid, info) in by_jbid {
                    let node = map.get(jbid).copied().filter(|n| doc.tree.get(*n).is_some());
                    match node.and_then(|n| dom::tag_name(doc, n).map(|t| (n, t))) {
                        // SVG names keep their case in the layout tree (`clipPath`).
                        Some((n, tag)) if tag.eq_ignore_ascii_case(&info.tag) => {
                            boxes.insert(n, info);
                        }
                        other => {
                            mismatched += 1;
                            if debug && mismatched <= 5 {
                                eprintln!("[visual] jbid {jbid}: layout <{}> vs document {:?}", info.tag, other.map(|(_, t)| t));
                            }
                        }
                    }
                }
                if debug {
                    eprintln!("[visual] live layout: {} boxes, {mismatched} mismatched", boxes.len());
                }
                // A different document than the live page's (e.g. a copy
                // with elements removed) is laid out on its own below.
                if mismatched == 0 && !boxes.is_empty() {
                    return Some((boxes, viewport));
                }
            }
        }
        let (layout, ids) = self.direct_layout(doc);
        let boxes = layout.boxes().into_iter().filter_map(|(i, info)| Some((*ids.get(i)?, info))).collect();
        Some((boxes, layout.viewport))
    }

    /// Lay `doc` out on its own (no live page): every element gets a
    /// `data-jb` index into the returned node list.
    #[cfg(feature = "layout")]
    fn direct_layout(&self, doc: &Document) -> (crate::layout::blitz::Layout, Vec<NodeId>) {
        use crate::layout::blitz::{Layout, DEFAULT_VIEWPORT};
        let url = self.current_url.as_deref().unwrap_or("about:blank");
        let mut tagged = dom::clone_document(doc);
        let ids: Vec<NodeId> = dom::find_all(&tagged, &[]);
        for (i, id) in ids.iter().enumerate() {
            dom::set_attr(&mut tagged, *id, "data-jb", &i.to_string());
        }
        let html = dom::to_html(&tagged);
        // The document was parsed as HTML: a doctype on its own line keeps blitz from sniffing
        // XHTML (it XML-parses when the first line mentions "xhtml" or the root declares the
        // XHTML namespace).
        let body = html.trim_start();
        let body = if body.get(..9).is_some_and(|p| p.eq_ignore_ascii_case("<!doctype")) { &body[body.find('>').map_or(0, |i| i + 1)..] } else { body };
        let html = format!("<!DOCTYPE html>\n{body}");
        let layout = Layout::from_html(&html, url, self.session.clone(), DEFAULT_VIEWPORT, 40);
        if std::env::var_os("JB_VISUAL_DEBUG").is_some() {
            eprintln!("[visual] direct layout: {} nodes in {} ms", layout.node_count(), layout.resolve_ms);
        }
        (layout, ids)
    }

    /// The page as character cells (`--format layout`); `None` without the
    /// `layout` feature.
    #[cfg(not(feature = "layout"))]
    pub fn render_layout_text(&self, _doc: &Document, _opts: &crate::layout::TextOptions) -> Option<String> {
        None
    }

    /// The page as a PNG (`--format png`); `clip` is a CSS selector whose
    /// first match is captured instead of the page. `None` without the
    /// `screenshot` feature.
    #[cfg(not(feature = "screenshot"))]
    pub fn render_screenshot(&self, _doc: &Document, _opts: &crate::layout::ScreenshotOptions, _clip: Option<&str>) -> Option<Result<Vec<u8>, String>> {
        None
    }

    #[cfg(feature = "screenshot")]
    pub fn render_screenshot(&self, doc: &Document, opts: &crate::layout::ScreenshotOptions, clip: Option<&str>) -> Option<Result<Vec<u8>, String>> {
        use crate::layout::screenshot::render_png;
        let url = self.current_url.as_deref().unwrap_or("about:blank");
        let target = match clip {
            Some(selector) => match dom::select(doc, selector).first().copied() {
                Some(node) => Some(node),
                None => return Some(Err(format!("no element matches {selector:?}"))),
            },
            None => None,
        };
        if self.js_engine.is_live(url) {
            // Visible frames lay their documents out in their own realms, then the page is laid out
            // afresh (last, so its layout is the current one); each frame is painted from its own
            // layout into its <iframe> box.
            let listed = crate::js::runtime::eval(
                &format!("typeof __jb.frameShotList === 'function' ? __jb.frameShotList({}) : ''", if target.is_some() { 0 } else { 2 }),
                "layout.js",
            )
            .unwrap_or_default();
            if listed.is_empty() {
                let _ = crate::js::runtime::eval("__jb.layoutState.key = -1; __jb.layoutQuery('size', { fresh: true })", "layout.js");
            }
            let frames: Vec<Value> = serde_json::from_str(&listed).unwrap_or_default();
            let scrolls = crate::js::runtime::eval("typeof __jb.elementScrolls === 'function' ? __jb.elementScrolls() : '[]'", "layout.js")
                .ok()
                .and_then(|s| serde_json::from_str::<Vec<(usize, f64, f64)>>(&s).ok())
                .unwrap_or_default();
            let jbid = target.and_then(|n| self.js_engine.jbid_of(n));
            let live = crate::js::runtime::with_host(|h| {
                let mut pictures = Vec::new();
                if !frames.is_empty() {
                    let top = h.layout_realm_key()?;
                    for f in &frames {
                        let (Some(token), Some(id)) = (f["token"].as_str(), f["id"].as_u64()) else { continue };
                        if !h.switch_layout_realm(token) {
                            continue;
                        }
                        let num = |k: &str| f[k].as_f64().unwrap_or(0.0);
                        let clip = crate::layout::Rect { x: num("sx"), y: num("sy"), width: num("w"), height: num("h"), ..Default::default() };
                        let fopts = crate::layout::ScreenshotOptions { clip: Some(clip), ..Default::default() };
                        if let Some(fl) = h.layout_mut() {
                            if let Ok(Ok((px, pw, ph))) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| crate::layout::screenshot::render_rgba(fl, &fopts))) {
                                pictures.push((id as usize, pw, ph, px));
                            }
                        }
                    }
                    if !h.switch_layout_realm(&top) {
                        return None;
                    }
                }
                let layout = h.layout_mut()?;
                layout.set_element_scrolls(&scrolls, true);
                let mut opts = opts.clone();
                if target.is_some() {
                    match jbid.and_then(|j| layout.rect_of_jbid(j)) {
                        Some(r) => opts.clip = Some(r),
                        None => return Some(Err("the element has no box".to_string())),
                    }
                }
                let saved: Vec<_> = pictures.into_iter().filter_map(|(id, w, hh, px)| layout.set_element_picture(id, w, hh, px)).collect();
                let painted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| render_png(layout, &opts)));
                if painted.is_ok() {
                    layout.set_element_scrolls(&scrolls, false);
                    layout.restore_special(saved);
                }
                match painted {
                    Ok(r) => Some(r),
                    Err(_) => {
                        // painting a broken layout: drop it and paint a direct layout below
                        h.drop_layout();
                        None
                    }
                }
            })
            .flatten();
            if let Some(result) = live {
                return Some(result);
            }
        }
        let (mut layout, ids) = self.direct_layout(doc);
        let mut opts = opts.clone();
        if let Some(node) = target {
            match ids.iter().position(|n| *n == node).and_then(|i| layout.rect_of_jbid(i)) {
                Some(r) => opts.clip = Some(r),
                None => return Some(Err("the element has no box".to_string())),
            }
        }
        Some(render_png(&mut layout, &opts))
    }

    #[cfg(feature = "layout")]
    pub fn render_layout_text(&self, doc: &Document, opts: &crate::layout::TextOptions) -> Option<String> {
        use crate::layout::text;
        let url = self.current_url.as_deref().unwrap_or("about:blank");
        if self.js_engine.is_live(url) {
            let _ = crate::js::runtime::eval("__jb.layoutQuery('size', { fresh: true })", "layout.js");
            if std::env::var_os("JB_TRACE_JS").is_some() {
                let info = crate::js::runtime::with_host(|h| h.layout().map(|l| (l.node_count(), l.document_size(), l.viewport))).flatten();
                eprintln!("[layout] text render from live layout: {info:?}");
            }
            if let Some(s) = crate::js::runtime::with_host(|h| h.layout().map(|l| text::render(l, opts))).flatten() {
                return Some(s);
            }
        }
        let (layout, _) = self.direct_layout(doc);
        Some(text::render(&layout, opts))
    }

    pub fn go_back(&mut self) -> Option<String> {
        if self.history_index > 0 {
            self.history_index -= 1;
            return self.history.get(self.history_index as usize).cloned();
        }
        None
    }

    pub fn go_forward(&mut self) -> Option<String> {
        if (self.history_index + 1) < self.history.len() as isize {
            self.history_index += 1;
            return self.history.get(self.history_index as usize).cloned();
        }
        None
    }

    pub fn can_go_back(&self) -> bool {
        self.history_index > 0
    }

    pub fn can_go_forward(&self) -> bool {
        self.history_index + 1 < self.history.len() as isize
    }

    pub fn get_current_links(&self) -> Vec<Link> {
        self.current_links.clone()
    }

    /// Resolve the URL of a link by index.
    pub fn follow_link(&self, index: usize) -> Option<String> {
        let link = self.current_links.get(index)?;
        Some(self.resolve(&link.url))
    }

    /// Resolve a possibly-relative URL against the current page.
    pub fn resolve(&self, href: &str) -> String {
        if href.starts_with("http://") || href.starts_with("https://") || href.starts_with("ftp://") || href.starts_with("mailto:") {
            return href.to_string();
        }
        match &self.current_url {
            Some(base) => http::urljoin(base, href),
            None => http::normalize_url(href),
        }
    }

    pub fn add_bookmark(&mut self, name: &str, url: Option<&str>) -> bool {
        match url.map(|u| u.to_string()).or_else(|| self.current_url.clone()) {
            Some(u) => {
                self.bookmarks.insert(name.to_string(), u);
                true
            }
            None => false,
        }
    }

    pub fn get_bookmark(&self, name: &str) -> Option<String> {
        self.bookmarks.get(name).cloned()
    }

    pub fn list_bookmarks(&self) -> BTreeMap<String, String> {
        self.bookmarks.clone()
    }

    pub fn remove_bookmark(&mut self, name: &str) -> bool {
        self.bookmarks.remove(name).is_some()
    }

    pub fn get_json_data(&self) -> Option<&Value> {
        self.current_json_data.as_ref()
    }

    pub fn is_json_response(&self) -> bool {
        self.current_json_data.is_some()
    }

    /// Search keys and string values of the current JSON response.
    pub fn search_json(&self, query: &str) -> Vec<Value> {
        let mut results = Vec::new();
        if let Some(data) = &self.current_json_data {
            search_json_recursive(data, &query.to_lowercase(), "", &mut results);
        }
        results
    }

    /// Inline JavaScript of the current document, concatenated.
    pub fn extract_javascript(&self, doc: &Document) -> String {
        let mut scripts = Vec::new();
        for id in dom::find_all(doc, &["script"]) {
            if dom::has_attr(doc, id, "src") {
                continue;
            }
            let ty = dom::attr(doc, id, "type").unwrap_or_else(|| "text/javascript".into()).to_ascii_lowercase();
            if matches!(ty.as_str(), "application/ld+json" | "application/json") {
                continue;
            }
            let code = dom::get_text(doc, id);
            if !code.trim().is_empty() {
                scripts.push(code.trim().to_string());
            }
        }
        scripts.join("\n")
    }

    /// Fetch and render a URL.
    pub fn browse(&mut self, url: &str, execute_js: bool) -> Result<String, BrowseError> {
        let prev = self.execute_js;
        self.execute_js = execute_js;
        let result = self.fetch_page(url, self.default_timeout);
        self.execute_js = prev;
        let page = result?;
        Ok(self.render_page(&page.document, execute_js))
    }

    /// All links of the current page as (text, absolute url).
    pub fn get_links(&self) -> Vec<(String, String)> {
        let doc = match &self.current_document {
            Some(d) => d,
            None => return Vec::new(),
        };
        let mut out = Vec::new();
        for id in dom::find_all(doc, &["a"]) {
            if let Some(href) = dom::attr(doc, id, "href") {
                let text = dom::get_text_stripped(doc, id);
                let text = if text.is_empty() { href.clone() } else { text };
                out.push((text, self.resolve(&href)));
            }
        }
        out
    }

    /// Case-insensitive line search in the current page text.
    pub fn search_page(&self, query: &str) -> Vec<String> {
        let doc = match &self.current_document {
            Some(d) => d,
            None => return Vec::new(),
        };
        let text = dom::visible_text(doc);
        let q = query.to_lowercase();
        text.lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .enumerate()
            .filter(|(_, l)| l.to_lowercase().contains(&q))
            .map(|(i, l)| format!("Line {}: {}", i + 1, l))
            .collect()
    }

    /// Title/description/keywords of the current page.
    pub fn get_page_info(&self) -> BTreeMap<String, String> {
        let mut info = BTreeMap::new();
        let (doc, url) = match (&self.current_document, &self.current_url) {
            (Some(d), Some(u)) => (d, u),
            _ => return info,
        };
        info.insert("url".into(), url.clone());
        info.insert("title".into(), dom::title(doc).unwrap_or_default());
        info.insert("description".into(), dom::meta_content(doc, "description").unwrap_or_default());
        info.insert("keywords".into(), dom::meta_content(doc, "keywords").unwrap_or_default());
        info
    }

    /// The document currently loaded (mutable, for form interactions).
    pub fn current_document_mut(&mut self) -> Option<&mut Document> {
        self.current_document.as_mut()
    }
}

/// Extra initialisation run before page scripts: marks the environment as a
/// full JavaScript-capable browser for detection scripts.
/// How many script-driven navigations one `fetch_page` follows (redirect
/// pages, login bounces, SPA entry redirects).
const MAX_SCRIPT_NAVIGATIONS: usize = 4;

const INIT_JS: &str = r#"
window._jsEnabled = true; window._cliBrowser = true;
document._javascriptEnabled = true;
"#;

fn resolve_redirect(target: &str, current_url: &str) -> Option<String> {
    let t = target.trim();
    if t.is_empty() {
        return None;
    }
    if t.starts_with("http://") || t.starts_with("https://") {
        Some(t.to_string())
    } else if t.starts_with("//") {
        Some(format!("https:{t}"))
    } else if t.starts_with('/') {
        Some(http::urljoin(current_url, t))
    } else {
        None
    }
}

/// Extract `<a href>` links (skipping empty/javascript anchors).
pub fn extract_links(doc: &Document) -> Vec<Link> {
    let mut links = Vec::new();
    for id in dom::find_all(doc, &["a"]) {
        let url = match dom::attr(doc, id, "href") {
            Some(h) => h.trim().to_string(),
            None => continue,
        };
        if url.is_empty() || matches!(url.as_str(), "#" | "javascript:void(0)" | "javascript:;") {
            continue;
        }
        let text = dom::get_text_stripped(doc, id);
        let text = if text.is_empty() { url.clone() } else { text };
        links.push(Link { text: text.chars().take(100).collect(), url, title: dom::attr(doc, id, "title").unwrap_or_default() });
    }
    links
}

/// Convert JSON to a display HTML document.
pub fn json_to_html(data: &Value, source_url: &str) -> Document {
    let body = format_json_as_html(data, 0);
    let html = format!(
        r#"<!DOCTYPE html><html><head><title>JSON Response - {url}</title><meta charset="utf-8"></head><body>
<h1>JSON API Response</h1>
<div class="api-info"><strong>URL:</strong> {url}<br><strong>Content-Type:</strong> application/json<br><strong>Response Size:</strong> {size} characters</div>
<div class="json-container">{body}</div></body></html>"#,
        url = dom::escape_html(source_url),
        size = data.to_string().len(),
    );
    dom::parse_document(&html)
}

fn format_json_as_html(data: &Value, indent: usize) -> String {
    match data {
        Value::Null => "<span class=\"json-null\">null</span>".into(),
        Value::Bool(b) => format!("<span class=\"json-boolean\">{b}</span>"),
        Value::Number(n) => format!("<span class=\"json-number\">{n}</span>"),
        Value::String(s) => {
            let esc = dom::escape_html(s);
            if s.starts_with("http://") || s.starts_with("https://") {
                format!("<span class=\"json-string\"><a href=\"{esc}\">\"{esc}\"</a></span>")
            } else {
                format!("<span class=\"json-string\">\"{esc}\"</span>")
            }
        }
        Value::Array(items) => {
            if items.is_empty() {
                return "<span class=\"json-array\">[]</span>".into();
            }
            let rows: Vec<String> = items.iter().enumerate().map(|(i, item)| format!("<div style=\"margin-left: {}px;\">[{i}]: {}</div>", indent * 20, format_json_as_html(item, indent + 1))).collect();
            format!("<div class=\"json-array\">[<br>{}<br><div>]</div></div>", rows.join("<br>"))
        }
        Value::Object(map) => {
            if map.is_empty() {
                return "<span class=\"json-object\">{}</span>".into();
            }
            let rows: Vec<String> = map
                .iter()
                .map(|(k, v)| format!("<div style=\"margin-left: {}px;\"><span class=\"json-key\">\"{}\"</span>: {}</div>", indent * 20, dom::escape_html(k), format_json_as_html(v, indent + 1)))
                .collect();
            format!("<div class=\"json-object\">{{<br>{}<br><div>}}</div></div>", rows.join("<br>"))
        }
    }
}

fn search_json_recursive(data: &Value, query: &str, path: &str, results: &mut Vec<Value>) {
    match data {
        Value::Object(map) => {
            for (k, v) in map {
                let p = if path.is_empty() { k.clone() } else { format!("{path}.{k}") };
                if k.to_lowercase().contains(query) {
                    results.push(json!({"path": p, "type": "key", "value": k, "data": v}));
                }
                if let Value::String(s) = v {
                    if s.to_lowercase().contains(query) {
                        results.push(json!({"path": p, "type": "value", "value": s, "data": s}));
                    }
                }
                search_json_recursive(v, query, &p, results);
            }
        }
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                let p = if path.is_empty() { format!("[{i}]") } else { format!("{path}[{i}]") };
                search_json_recursive(item, query, &p, results);
            }
        }
        Value::String(s) if s.to_lowercase().contains(query) && !path.is_empty() && !path.ends_with(']') => {}
        Value::String(s) if s.to_lowercase().contains(query) => {
            results.push(json!({"path": path, "type": "value", "value": s, "data": s}));
        }
        _ => {}
    }
}

/// Convenience for callers that only need to know which element a `NodeId`
/// belongs to when working with the current document.
pub fn node_tag(doc: &Document, id: NodeId) -> String {
    dom::tag_name(doc, id).unwrap_or_default()
}


/// Text of every page lopdf can read (page by page, so one broken page does not lose the rest).
fn pdf_pages_text(bytes: &[u8]) -> String {
    let Ok(Ok(doc)) = std::panic::catch_unwind(|| lopdf::Document::load_mem(bytes)) else { return String::new() };
    let pages: Vec<u32> = doc.get_pages().keys().copied().collect();
    let mut out = String::new();
    for p in pages {
        if out.len() > MAX_PDF_TEXT {
            break;
        }
        if let Ok(Ok(t)) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| doc.extract_text(&[p]))) {
            out.push_str(&t);
            out.push_str("\n\n");
        }
    }
    out
}

/// Most text kept from one PDF (characters).
const MAX_PDF_TEXT: usize = 2_000_000;

/// A PDF response as a readable document: its text, one paragraph per block of lines.
/// The document a browser makes for a top-level image, audio or video response (an `<img>`,
/// `<audio>` or `<video>` of the URL). SVG stays a document.
fn media_document(content_type: &str, url: &str) -> Option<Document> {
    let ct = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let kind = if ct.starts_with("image/") && ct != "image/svg+xml" {
        "img"
    } else if ct.starts_with("video/") {
        "video"
    } else if ct.starts_with("audio/") {
        "audio"
    } else {
        return None;
    };
    let name = url.split(['?', '#']).next().unwrap_or(url).rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or(url);
    let name = percent_encoding::percent_decode_str(name).decode_utf8_lossy().to_string();
    let src = url.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;");
    let element = match kind {
        "img" => format!("<img src=\"{src}\" alt=\"{}\" style=\"display:block;margin:auto;max-width:100%\">", dom::escape_html(&name)),
        other => format!("<{other} controls autoplay name=\"media\"><source src=\"{src}\" type=\"{}\"></{other}>", dom::escape_html(&ct)),
    };
    let html = format!("<!DOCTYPE html><html><head><meta name=\"viewport\" content=\"width=device-width, minimum-scale=0.1\"><title>{}</title></head><body style=\"margin:0;background:#0e0e0e\">{element}</body></html>", dom::escape_html(&name));
    Some(dom::parse_document(&html))
}

pub fn pdf_to_html(bytes: &[u8], url: &str) -> Document {
    let name = url.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or("document.pdf");
    let name = percent_encoding::percent_decode_str(name).decode_utf8_lossy().to_string();
    // pdf-extract panics (or fails) on whole documents over one bad content stream; then the text
    // is taken page by page with lopdf, skipping pages that fail
    let text = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(bytes)).ok().and_then(|r| r.ok()).filter(|t| !t.trim().is_empty()).unwrap_or_else(|| pdf_pages_text(bytes));
    let mut text = text.replace('\u{0}', "");
    if text.len() > MAX_PDF_TEXT {
        let mut cut = MAX_PDF_TEXT;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
    }
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let mut body = String::new();
    if text.trim().is_empty() {
        body.push_str("<p>(This PDF has no extractable text.)</p>");
    }
    for para in text.split("\n\n") {
        let lines: Vec<&str> = para.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        if !lines.is_empty() {
            // join lines; a word hyphenated at a line end ("natu-" + "ral") is put back together
            let mut joined = String::new();
            for l in &lines {
                let starts_lower = l.chars().next().is_some_and(|c| c.is_lowercase());
                if joined.ends_with('-') && starts_lower && !joined.ends_with(" -") {
                    joined.pop();
                } else if !joined.is_empty() {
                    joined.push(' ');
                }
                joined.push_str(l);
            }
            body.push_str("<p>");
            body.push_str(&esc(&joined));
            body.push_str("</p>\n");
        }
    }
    dom::parse_document(&format!("<!DOCTYPE html><html><head><title>{}</title></head><body><main>{}</main></body></html>", esc(&name), body))
}
