//! AI Agent SDK - simple website interaction functions for AI agents.
//!
//! Every method returns a `serde_json::Value` object with the same keys as the
//! original Python API (`success`, `error`, `title`, `content`, ...), so the
//! output can be handed straight to an LLM tool-calling loop.

use crate::dom::{self, Document};
use crate::engine::BrowserEngine;
use crate::forms::{self, InteractiveElements};
use crate::http;
use crate::js::JsConfig;
use crate::proxy::{HttpRequest, HttpResponseRecord};
use crate::renderer;
use ego_tree::NodeId;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const NO_PAGE: &str = "No website open. Use open_website() first.";

/// Result of [`AgentSdk::run_page_script`].
#[derive(Debug, Clone)]
pub struct PageScriptOutcome {
    /// The script's JSON result; `None` when the page navigated or submitted a form.
    pub result: Option<Value>,
    pub navigated: bool,
    pub console: Vec<String>,
    pub errors: Vec<String>,
}

/// The document response of [`AgentSdk::load_page`].
#[derive(Debug, Clone)]
pub struct PageLoad {
    pub status: u16,
    pub reason: String,
    /// Final URL after redirects.
    pub url: String,
    /// Lower-cased header names.
    pub headers: BTreeMap<String, String>,
    pub body_len: usize,
}

#[derive(Debug, Clone)]
struct ContentItem {
    kind: String,
    text: String,
}

/// Agent SDK: numbered elements, typing, clicking, scrolling and proxy control.
pub struct AgentSdk {
    pub engine: BrowserEngine,
    pub current_url: Option<String>,
    pub current_document: Option<Document>,
    pub form_data: BTreeMap<String, String>,
    pub default_timeout: u64,
    pub scroll_position: usize,
    pub scroll_chunk_size: usize,
    content_cache: Vec<ContentItem>,
    /// Leave `content` (the page re-rendered as markdown) out of action results: the session
    /// CLI never shows it, and on a 750 KB page it cost seconds per action (twice per `fill`).
    pub skip_action_content: bool,
}

impl Default for AgentSdk {
    fn default() -> Self {
        Self::new(None, 30)
    }
}

fn err(msg: impl Into<String>) -> Value {
    json!({"success": false, "error": msg.into()})
}

impl AgentSdk {
    pub fn new(user_agent: Option<&str>, timeout: u64) -> Self {
        Self::with_js_config(user_agent, timeout, JsConfig::default())
    }

    pub fn with_js_config(user_agent: Option<&str>, timeout: u64, js: JsConfig) -> Self {
        let mut engine = BrowserEngine::with_js_config(user_agent, js);
        engine.default_timeout = timeout;
        Self { engine, current_url: None, current_document: None, form_data: BTreeMap::new(), default_timeout: timeout, scroll_position: 0, scroll_chunk_size: 20, content_cache: Vec::new(), skip_action_content: false }
    }

    fn doc(&self) -> Option<&Document> {
        self.current_document.as_ref()
    }

    fn title_of(doc: &Document) -> String {
        dom::title(doc).unwrap_or_else(|| "No title".into())
    }

    /// Open a website and return its clean content.
    pub fn open_website(&mut self, url: &str) -> Value {
        match self.engine.fetch_page(url, self.default_timeout) {
            Ok(page) => {
                self.current_url = Some(page.response.url.clone());
                self.form_data.clear();
                let title = Self::title_of(&page.document);
                let clean = self.extract_text_only_content(&page.document);
                self.initialize_scroll_state(&page.document);
                self.current_document = Some(page.document);
                let mut out = json!({
                    "success": true,
                    "url": self.current_url,
                    "title": title,
                    "content": clean,
                    "page_title": title,
                });
                if let Some(js) = &self.engine.last_js {
                    out["javascript"] = json!({
                        "scripts_run": js.scripts_run,
                        "errors": js.errors.len(),
                        "dom_updates": js.dom_updates.len(),
                        "api_calls": js.api_calls.len(),
                        "navigations": js.navigations,
                        "notifications": js.notifications,
                        "websocket_messages": js.websocket_messages,
                        "open_connections": js.open_connections,
                        "canvas_text": js.canvas_text,
                        "cookies_set": js.cookies_set.len(),
                    });
                }
                out
            }
            Err(e) => err(e.to_string()),
        }
    }

    fn elements(&self) -> Option<InteractiveElements> {
        let doc = self.doc()?;
        Some(forms::extract_interactive_elements(doc, self.current_url.as_deref().unwrap_or("")))
    }

    /// List clickable elements (form buttons, then buttons and links) and input fields, numbered.
    pub fn list_elements(&self) -> Value {
        let elements = match self.elements() {
            Some(e) => e,
            None => return err(NO_PAGE),
        };
        let buttons: Vec<Value> = elements
            .all_buttons()
            .iter()
            .map(|b| {
                let mut v = json!({"number": b.number, "text": b.text, "type": b.button_type});
                if let Some(a) = &b.action {
                    v["url"] = json!(a);
                }
                v
            })
            .collect();
        let inputs: Vec<Value> = elements.all_inputs().iter().map(|i| json!({"number": i.number, "name": i.name, "type": i.input_type, "placeholder": i.placeholder, "value": if i.input_type == "password" && !i.value.is_empty() { "••••••••".to_string() } else { i.value.clone() }, "required": i.required})).collect();
        let summary = create_element_summary(&buttons, &inputs);
        json!({
            "success": true,
            "summary": summary,
            "buttons": buttons,
            "inputs": inputs,
            "total_clickable": buttons.len(),
            "total_inputs": inputs.len(),
            "total_elements": buttons.len() + inputs.len(),
            "forms": elements.forms.len(),
        })
    }

    /// Click an element by number: links navigate, submit buttons submit, other
    /// buttons dispatch a JavaScript click.
    pub fn click_element(&mut self, element_number: usize) -> Value {
        let elements = match self.elements() {
            Some(e) => e,
            None => return err(NO_PAGE),
        };
        let target = match elements.all_buttons().into_iter().find(|b| b.number == element_number) {
            Some(t) => t,
            None => return err(format!("Element {element_number} not found")),
        };
        match target.button_type.as_str() {
            "link" => {
                let url = target.action.clone().unwrap_or_default();
                let mut result = self.open_website(&url);
                if result["success"].as_bool().unwrap_or(false) {
                    result["message"] = json!(format!("Followed '{}' link to {}", target.text, result["title"].as_str().unwrap_or("")));
                }
                result
            }
            "submit" => self.submit_form_node(target.form),
            _ => {
                // Try a real JavaScript click first.
                if let Some(node) = target.node {
                    if let Some(res) = self.js_click(node) {
                        return res;
                    }
                }
                if let Some(nav) = &target.action {
                    let url = self.engine.resolve(nav);
                    let mut result = self.open_website(&url);
                    result["message"] = json!(format!("Button '{}' navigated to {}", target.text, url));
                    return result;
                }
                json!({"success": true, "message": format!("Clicked '{}' button successfully", target.text), "action": "clicked", "element": target.text})
            }
        }
    }

    /// The JS-side id of a node of the current document. When the page's realm
    /// is live the engine's map is authoritative; otherwise the document is
    /// (re)mirrored on the next `execute_script`, whose ids follow tree order.
    fn jbid_for(&self, node: NodeId) -> Option<usize> {
        let url = self.current_url.as_deref()?;
        let doc = self.current_document.as_ref()?;
        if self.engine.js_engine.is_live(url) {
            self.engine.js_engine.jbid_of(node)
        } else {
            let (_, map) = crate::js::serialize_document(doc);
            map.iter().position(|n| *n == node)
        }
    }

    /// Dispatch a click through the JS engine and report DOM changes.
    fn js_click(&mut self, node: NodeId) -> Option<Value> {
        let url = self.current_url.clone()?;
        let jbid = self.jbid_for(node)?;
        let doc = self.current_document.as_mut()?;
        // A real pointer sequence (move, down, focus, up, click) at the element's center.
        let script = format!("(function(){{ var el = __jb.nodeById[{jbid}]; if (!el) return 'missing'; __jb.user.click(el); return 'clicked'; }})()");
        let exec = self.engine.js_engine.execute_script(&script, Some(doc), &url);
        if exec.result.as_deref() != Some("clicked") {
            return None;
        }
        let changed = !exec.dom_updates.is_empty();
        if let Some(nav) = exec.navigations.first() {
            self.engine.nav_initiator = Some((url.clone(), nav.referrer_policy.clone().unwrap_or_default(), true));
            let mut result = self.open_website(&nav.url.clone());
            result["message"] = json!(format!("Button click navigated to {}", nav.url));
            return Some(result);
        }
        if let Some(sub) = exec.form_submissions.first().cloned() {
            return Some(self.submit_script_form(&sub));
        }
        let doc = self.current_document.as_ref()?;
        let content = if changed { self.extract_text_only_content(doc) } else { String::new() };
        if changed {
            let d = self.current_document.clone().unwrap();
            self.initialize_scroll_state(&d);
        }
        Some(json!({
            "success": true,
            "action": "clicked",
            "message": if changed { "Button clicked - page content updated by JavaScript" } else { "Button clicked (no visible page change)" },
            "dom_changed": changed,
            "content": if changed { Value::String(content) } else { Value::Null },
            "console": exec.console,
        }))
    }

    /// Perform a user action on an element found by CSS selector, `text=...` or JS node id:
    /// `click`, `dblclick`, `rightclick`, `hover`, `focus`, `type` / `fill` (value = text),
    /// `clear`, `press` (value = key or combo like "Control+a"), `select` (value = option value or
    /// label), `check`, `uncheck`, `scroll`, `exists`. Events are trusted pointer/keyboard
    /// sequences; navigations and form submissions the page starts are followed.
    pub fn act(&mut self, action: &str, target: &str, value: Option<&str>) -> Value {
        // Typing: focus first and let the page react before the keys arrive (see
        // `BrowserEngine::user_action`: search components that mount on first focus).
        if (action == "fill" || action == "type") && !target.is_empty() {
            let before = self.current_url.clone();
            let focus = self.run_user_script(&crate::engine::user_action_script("focus", target, None), "focus", target);
            if focus.get("success") == Some(&Value::Bool(false)) || self.current_url != before {
                return focus;
            }
        }
        let script = crate::engine::user_action_script(action, target, value);
        self.run_user_script(&script, action, target)
    }

    /// Run a user-input script (returning a JSON report: `{ok, el, value, ...}` or `{error}`)
    /// against the live page, then follow any navigation or form submission it started, like
    /// [`act`](Self::act). `label`/`target` only describe the action in the result.
    pub fn run_user_script(&mut self, script: &str, action: &str, target: &str) -> Value {
        let url = match self.current_url.clone() {
            Some(u) => u,
            None => return err(NO_PAGE),
        };
        let mut doc = match self.current_document.take() {
            Some(d) => d,
            None => return err(NO_PAGE),
        };
        let started = std::time::Instant::now();
        let out = self.engine.user_script(&mut doc, &url, script);
        if std::env::var_os("JB_TRACE_JS").is_some() {
            eprintln!("[action] {action} script + settle {} ms", started.elapsed().as_millis());
        }
        self.current_document = Some(doc);
        if let Some(e) = out.report.get("error").and_then(Value::as_str) {
            return json!({"success": false, "error": e, "action": action, "target": target, "console": out.console});
        }
        if let Some(nav) = out.navigation {
            let mut result = self.open_website(&nav);
            result["message"] = json!(format!("{action} on {target} navigated to {nav}"));
            return result;
        }
        if let Some(sub) = out.submission {
            return self.submit_script_form(&sub);
        }
        let content = if out.dom_changed && !self.skip_action_content {
            let d = self.current_document.clone().unwrap();
            self.initialize_scroll_state(&d);
            Value::String(self.extract_text_only_content(&d))
        } else {
            Value::Null
        };
        json!({
            "success": true,
            "action": action,
            "target": target,
            "element": out.report.get("el").cloned().unwrap_or(Value::Null),
            "value": out.report.get("value").cloned().unwrap_or(Value::Null),
            "report": out.report.clone(),
            "dom_changed": out.dom_changed,
            "content": content,
            "console": out.console,
        })
    }

    /// Run a script against the live page like [`run_user_script`](Self::run_user_script) (the
    /// page's timers settle afterwards; navigations and form submissions it starts are followed),
    /// without re-rendering the page as markdown: for protocol drivers (CDP) that call this for
    /// every command. Returns the script's JSON result (`None` when the page navigated away), the
    /// console lines and the uncaught errors.
    pub fn run_page_script(&mut self, script: &str) -> PageScriptOutcome {
        let (Some(url), Some(mut doc)) = (self.current_url.clone(), self.current_document.take()) else {
            return PageScriptOutcome { result: None, navigated: false, console: Vec::new(), errors: vec![NO_PAGE.to_string()] };
        };
        let out = self.engine.user_script(&mut doc, &url, script);
        self.current_document = Some(doc);
        let mut navigated = false;
        if let Some(nav) = out.navigation {
            let _ = self.load_page(&nav);
            navigated = true;
        } else if let Some(sub) = out.submission {
            self.submit_script_form(&sub);
            navigated = true;
        }
        PageScriptOutcome { result: if navigated { None } else { Some(out.report) }, navigated, console: out.console, errors: out.errors }
    }

    /// Load `url` as the current page (scripts run until it settles) without rendering it as
    /// markdown, for protocol drivers; `about:blank` gives an empty page.
    pub fn load_page(&mut self, url: &str) -> Result<PageLoad, String> {
        if url == "about:blank" {
            self.open_blank();
            return Ok(PageLoad { status: 200, reason: "OK".into(), url: url.into(), headers: BTreeMap::new(), body_len: 0 });
        }
        // a page without scripts leaves the previous page's run in place
        self.engine.last_js = None;
        let page = self.engine.fetch_page(url, self.default_timeout).map_err(|e| e.to_string())?;
        self.current_url = Some(page.response.url.clone());
        self.form_data.clear();
        self.content_cache.clear();
        self.scroll_position = 0;
        self.current_document = Some(page.document);
        let r = page.response;
        Ok(PageLoad { status: r.status, reason: r.reason, url: r.url, headers: r.headers, body_len: r.body.len() })
    }

    /// Start on an empty `about:blank` page (a browser launched without navigating).
    pub fn open_blank(&mut self) -> Value {
        let doc = dom::parse_document("<!DOCTYPE html><html><head><title></title></head><body></body></html>");
        self.current_url = Some("about:blank".to_string());
        self.engine.current_url = Some("about:blank".to_string());
        self.form_data.clear();
        self.current_document = Some(doc);
        json!({"success": true, "url": "about:blank", "title": ""})
    }

    /// Bring the Rust document up to date when live scripts deferred the sync
    /// (`engine.js_engine.defer_dom_sync`).
    pub fn sync_dom(&mut self) {
        if let Some(doc) = self.current_document.as_mut() {
            self.engine.js_engine.sync_if_stale(doc);
        }
    }

    /// Title of the current page ("" without one).
    pub fn current_title(&self) -> String {
        self.doc().map(Self::title_of).unwrap_or_default()
    }

    /// Agent-readable Markdown of the current page as its live DOM stands now.
    pub fn readable_text(&self) -> Value {
        let Some(doc) = self.doc() else { return err(NO_PAGE) };
        json!({"success": true, "url": self.current_url, "title": Self::title_of(doc), "content": self.engine.render_page(doc, false)})
    }

    /// PNG of the current page: the whole document (`full_page`), or the document region `clip`.
    pub fn screenshot_png(&self, full_page: bool, clip: Option<crate::layout::Rect>) -> Result<Vec<u8>, String> {
        let Some(doc) = self.doc() else { return Err(NO_PAGE.to_string()) };
        let opts = crate::layout::ScreenshotOptions { full_page, clip, ..Default::default() };
        match self.engine.render_screenshot(doc, &opts, None) {
            Some(r) => r,
            None => Err("screenshots are not compiled in (build with --features screenshot)".to_string()),
        }
    }

    /// Wait (running the page's timers and network callbacks) until `selector` matches, up to
    /// `rounds` settle rounds.
    pub fn wait_for(&mut self, selector: &str, rounds: usize) -> Value {
        for i in 0..rounds.max(1) {
            let r = self.act("exists", selector, None);
            if r["success"].as_bool().unwrap_or(false) {
                return json!({"success": true, "found": true, "rounds": i + 1, "element": r["element"].clone()});
            }
        }
        json!({"success": false, "found": false, "error": format!("{selector} did not appear")})
    }

    /// Type text into an input field (by number). Stored for the next submit.
    pub fn type_text(&mut self, field_number: usize, text: &str) -> Value {
        let elements = match self.elements() {
            Some(e) => e,
            None => return err(NO_PAGE),
        };
        let inputs = elements.all_inputs();
        if field_number < 1 || field_number > inputs.len() {
            return err(format!("Input field {field_number} not found. Found {} fields.", inputs.len()));
        }
        let target = &inputs[field_number - 1];
        let field_name = if target.name.is_empty() { format!("field_{field_number}") } else { target.name.clone() };
        self.form_data.insert(field_name.clone(), text.to_string());
        // Type through the page's JavaScript when its realm is live so that
        // input/change listeners (frameworks, validation) see the value.
        let typed_via_js = match (target.node, self.current_url.clone()) {
            (Some(node), Some(url)) if self.engine.js_engine.is_live(&url) => match self.jbid_for(node) {
                Some(jbid) => {
                    // Key events per character through the native value setter (framework-controlled inputs see them).
                    let script = format!(
                        "(function(){{ var el = __jb.nodeById[{jbid}]; if (!el) return 'missing'; __jb.user.type(el, {}); return 'typed'; }})()",
                        serde_json::to_string(text).unwrap_or_default()
                    );
                    if let Some(doc) = self.current_document.as_mut() {
                        let exec = self.engine.js_engine.execute_script(&script, Some(doc), &url);
                        exec.result.as_deref() == Some("typed")
                    } else {
                        false
                    }
                }
                None => false,
            },
            _ => false,
        };
        if !typed_via_js {
            if let (Some(doc), Some(node)) = (self.current_document.as_mut(), target.node) {
                if target.element == "textarea" {
                    dom::set_string(doc, node, text);
                } else {
                    dom::set_attr(doc, node, "value", text);
                }
            }
        }
        json!({"success": true, "message": format!("Typed '{text}' into {field_name} field"), "action": "typed", "field": field_name, "text": text, "field_number": field_number})
    }

    /// Submit the first form on the page with the typed data.
    pub fn submit_form(&mut self) -> Value {
        if self.doc().is_none() {
            return err(NO_PAGE);
        }
        let form = self.doc().and_then(|d| dom::find_first(d, "form"));
        self.submit_form_node(form)
    }

    fn submit_form_node(&mut self, form: Option<NodeId>) -> Value {
        if self.doc().is_none() {
            return err(NO_PAGE);
        }
        let form = match form.or_else(|| self.doc().and_then(|d| dom::find_first(d, "form"))) {
            Some(f) => f,
            None => return err("No form found on page"),
        };
        if let Some(v) = self.js_submit(form) {
            return v;
        }
        let doc = match self.doc() {
            Some(d) => d,
            None => return err(NO_PAGE),
        };
        let current_url = self.current_url.clone().unwrap_or_default();
        let action = dom::attr(doc, form, "action").unwrap_or_default();
        let method = dom::attr(doc, form, "method").unwrap_or_else(|| "GET".into()).to_ascii_uppercase();
        let submit_url = forms::resolve_form_action(&action, &current_url);
        let data = forms::collect_form_data(doc, form, &self.form_data);
        self.submit_to(&submit_url, &method, data)
    }

    /// Submit through the live page: fires `submit` so page handlers
    /// (validation, AJAX submits, `preventDefault`) run as in a browser.
    /// `None` when the page is not live.
    fn js_submit(&mut self, form: NodeId) -> Option<Value> {
        let url = self.current_url.clone()?;
        if !self.engine.js_engine.is_live(&url) {
            return None;
        }
        let jbid = self.jbid_for(form)?;
        let doc = self.current_document.as_mut()?;
        let script = format!("(function(){{ var f = __jb.nodeById[{jbid}]; if (!f) return 'missing'; __jb.submitForm(f, null); return 'submitted'; }})()");
        let exec = self.engine.js_engine.execute_script(&script, Some(doc), &url);
        if exec.result.as_deref() != Some("submitted") {
            return None;
        }
        if let Some(nav) = exec.navigations.first() {
            self.engine.nav_initiator = Some((url.clone(), nav.referrer_policy.clone().unwrap_or_default(), true));
            let mut result = self.open_website(&nav.url.clone());
            result["message"] = json!(format!("Form submission navigated to {}", nav.url));
            return Some(result);
        }
        if let Some(sub) = exec.form_submissions.first().cloned() {
            return Some(self.submit_script_form(&sub));
        }
        // The page's submit handler took over (preventDefault).
        let doc = self.current_document.as_ref()?;
        let content = self.extract_text_only_content(doc);
        let d = self.current_document.clone().unwrap();
        self.initialize_scroll_state(&d);
        Some(json!({
            "success": true,
            "action": "submitted",
            "message": "Form handled by page JavaScript (no navigation)",
            "dom_changed": !exec.dom_updates.is_empty(),
            "content": content,
            "console": exec.console,
        }))
    }

    fn submit_to(&mut self, submit_url: &str, method: &str, data: BTreeMap<String, String>) -> Value {
        if method.eq_ignore_ascii_case("POST") {
            self.submit_request("POST", submit_url, Some(http::url_encode_form(&data)), None)
        } else {
            self.submit_request("GET", &http::append_query(submit_url, &data), None, None)
        }
    }

    /// Follow a submission the page's script started, with the request the realm encoded.
    fn submit_script_form(&mut self, sub: &crate::js::FormSubmission) -> Value {
        let (method, url, body, content_type) = sub.request();
        self.submit_request(&method, &url, body, content_type)
    }

    fn submit_request(&mut self, method: &str, url: &str, body: Option<String>, content_type: Option<String>) -> Value {
        let mut headers = self.engine.get_js_enhanced_headers(url);
        if let Some(ct) = content_type {
            headers.retain(|k, _| !k.eq_ignore_ascii_case("content-type"));
            headers.insert("Content-Type".into(), ct);
        }
        let response = self.engine.proxy_request(method, url, &headers, body, self.default_timeout);
        match response {
            Ok(resp) if resp.status < 400 || !resp.text.trim().is_empty() => {
                let mut doc = self.engine.parse_response(&resp);
                self.engine.js_engine.invalidate_live();
                if self.engine.execute_js && self.engine.current_json_data.is_none() && !dom::find_all(&doc, &["script"]).is_empty() {
                    let exec = self.engine.js_engine.run_page(&mut doc, &resp.url, None);
                    self.engine.last_js = Some(exec);
                }
                self.current_url = Some(resp.url.clone());
                self.engine.current_url = Some(resp.url.clone());
                self.engine.current_links = crate::engine::extract_links(&doc);
                self.form_data.clear();
                let markdown = self.engine.render_page(&doc, false);
                let title = Self::title_of(&doc);
                self.initialize_scroll_state(&doc);
                self.engine.current_document = Some(doc.clone());
                self.current_document = Some(doc);
                json!({"success": true, "action": "form_submitted", "url": resp.url, "title": title, "content": markdown, "page_title": title, "markdown": markdown, "status_code": resp.status})
            }
            Ok(resp) => err(format!("HTTP {}: {}", resp.status, resp.reason)),
            Err(e) => err(e.to_string()),
        }
    }

    /// Follow the n-th `<a href>` link on the page.
    pub fn follow_link(&mut self, link_number: usize) -> Value {
        let doc = match self.doc() {
            Some(d) => d,
            None => return err(NO_PAGE),
        };
        let links: Vec<NodeId> = dom::find_all(doc, &["a"]).into_iter().filter(|a| dom::has_attr(doc, *a, "href")).collect();
        if link_number < 1 || link_number > links.len() {
            return err(format!("Link {link_number} not found. Found {} links.", links.len()));
        }
        let href = dom::attr(doc, links[link_number - 1], "href").unwrap_or_default();
        let url = self.engine.resolve(&href);
        self.open_website(&url)
    }

    /// Navigate to a URL directly (alias of `open_website`).
    pub fn follow_link_url(&mut self, url: &str) -> Value {
        self.open_website(url)
    }

    /// Search text on the current page with context snippets.
    pub fn search_page(&self, term: &str) -> Value {
        let doc = match self.doc() {
            Some(d) => d,
            None => return err(NO_PAGE),
        };
        let lower = term.to_lowercase();
        let mut matches = Vec::new();
        for (id, text) in dom::text_nodes(doc) {
            let text = text.trim().to_string();
            if text.is_empty() {
                continue;
            }
            let tl = text.to_lowercase();
            if let Some(idx) = tl.find(&lower) {
                let chars: Vec<char> = text.chars().collect();
                let cidx = tl[..idx].chars().count();
                let start = cidx.saturating_sub(50);
                let end = (cidx + term.chars().count() + 50).min(chars.len());
                let context: String = chars[start..end].iter().collect();
                matches.push(json!({"text": text, "context": context.trim(), "parent_tag": dom::parent_tag(doc, id)}));
            }
        }
        let total = matches.len();
        json!({"success": true, "search_term": term, "matches": matches.into_iter().take(10).collect::<Vec<_>>(), "total_matches": total, "matches_found": total, "found": total > 0})
    }

    /// The current page as a character-cell screenshot (`cols` cells wide),
    /// what a person would see at the top of the page.
    pub fn view_layout(&self, cols: usize) -> Value {
        let Some(doc) = self.doc() else { return err(NO_PAGE) };
        let opts = crate::layout::TextOptions { cols: cols.max(20), ..Default::default() };
        match self.engine.render_layout_text(doc, &opts) {
            Some(text) => json!({"success": true, "cols": opts.cols, "rows": text.lines().count(), "layout": text}),
            None => err("layout rendering is not compiled in (build with --features layout)"),
        }
    }

    /// A PNG screenshot of the current page (or of the first element matching
    /// `clip`), base64-encoded, with its pixel size.
    pub fn screenshot(&self, clip: Option<&str>) -> Value {
        let Some(doc) = self.doc() else { return err(NO_PAGE) };
        let opts = crate::layout::ScreenshotOptions::default();
        match self.engine.render_screenshot(doc, &opts, clip) {
            Some(Ok(png)) => {
                // PNG IHDR: width and height are big-endian at bytes 16..24.
                let dim = |at: usize| u32::from_be_bytes([png[at], png[at + 1], png[at + 2], png[at + 3]]);
                let (width, height) = if png.len() >= 24 { (dim(16), dim(20)) } else { (0, 0) };
                json!({"success": true, "format": "png", "width": width, "height": height, "bytes": png.len(), "png_base64": crate::js::webapis::b64(&png)})
            }
            Some(Err(e)) => err(e),
            None => err("screenshots are not compiled in (build with --features screenshot)"),
        }
    }

    /// Title, URL, markdown content and element counts.
    pub fn get_page_info(&self) -> Value {
        let doc = match self.doc() {
            Some(d) => d,
            None => return err(NO_PAGE),
        };
        let title = Self::title_of(doc);
        let markdown = self.engine.render_page(doc, false);
        let forms_n = dom::find_all(doc, &["form"]).len();
        let buttons = dom::find_all(doc, &["button"]).len()
            + dom::find_all(doc, &["input"]).into_iter().filter(|i| matches!(dom::attr(doc, *i, "type").map(|t| t.to_ascii_lowercase()).as_deref(), Some("button" | "submit"))).count();
        let inputs = dom::find_all(doc, &["input"]).len();
        let links = dom::find_all(doc, &["a"]).into_iter().filter(|a| dom::has_attr(doc, *a, "href")).count();
        json!({
            "success": true,
            "title": title,
            "url": self.current_url,
            "content": markdown,
            "page_title": title,
            "markdown": markdown,
            "meta_description": dom::meta_content(doc, "description").unwrap_or_default(),
            "word_count": dom::visible_text(doc).split_whitespace().count(),
            "element_counts": {"forms": forms_n, "buttons": buttons, "inputs": inputs, "links": links},
            "has_javascript": !dom::find_all(doc, &["script"]).is_empty(),
            "has_forms": forms_n > 0,
            "is_interactive": buttons > 0 || inputs > 0 || forms_n > 0,
        })
    }

    /// Run JavaScript against the current page and return the result plus any DOM changes.
    pub fn execute_javascript(&mut self, script: &str) -> Value {
        let url = match self.current_url.clone() {
            Some(u) => u,
            None => return err(NO_PAGE),
        };
        let doc = match self.current_document.as_mut() {
            Some(d) => d,
            None => return err(NO_PAGE),
        };
        let exec = self.engine.js_engine.execute_script(script, Some(doc), &url);
        // a navigation the script started is sent with this document as its initiator (Referer)
        if let Some(n) = exec.navigations.first() {
            self.engine.nav_initiator = Some((url.clone(), n.referrer_policy.clone().unwrap_or_default(), false));
        }
        let changed = !exec.dom_updates.is_empty();
        let content = if changed { self.extract_text_only_content(self.current_document.as_ref().unwrap()) } else { String::new() };
        json!({
            "success": exec.scripts_failed == 0,
            "result": exec.result,
            "errors": exec.errors,
            "console": exec.console,
            "dom_changed": changed,
            "content": if changed { Value::String(content) } else { Value::Null },
            "navigations": exec.navigations,
        })
    }

    /// Cookies held in the session jar (what pages see in `document.cookie`,
    /// plus HttpOnly ones).
    pub fn get_cookies(&self) -> Value {
        let cookies: Vec<Value> = self
            .engine
            .session
            .all_cookies()
            .into_iter()
            .map(|(name, value, domain, path, secure, http_only)| json!({"name": name, "value": value, "domain": domain, "path": path, "secure": secure, "http_only": http_only}))
            .collect();
        json!({"success": true, "cookie_count": cookies.len(), "cookies": cookies})
    }

    /// Add a cookie to the session jar for a URL (e.g. to reuse a login session).
    pub fn set_cookie(&self, url: &str, cookie: &str) -> Value {
        let ok = self.engine.session.set_cookie(url, cookie);
        json!({"success": ok, "message": if ok { "Cookie stored" } else { "Cookie rejected" }})
    }

    // ---- legacy aliases ----
    pub fn navigate(&mut self, url: &str) -> Value {
        self.open_website(url)
    }
    pub fn get_elements(&self) -> Value {
        self.list_elements()
    }
    pub fn click_button(&mut self, n: usize) -> Value {
        self.click_element(n)
    }
    pub fn fill_input(&mut self, n: usize, text: &str) -> Value {
        self.type_text(n, text)
    }
    pub fn submit_current_form(&mut self) -> Value {
        self.submit_form()
    }

    fn extract_text_only_content(&self, doc: &Document) -> String {
        let mut copy = dom::clone_document(doc);
        for tag in ["script", "style", "meta", "link", "noscript", "head"] {
            for id in dom::find_all(&copy, &[tag]) {
                dom::decompose(&mut copy, id);
            }
        }
        let markdown = self.engine.render_page(&copy, false);
        let mut clean: Vec<String> = Vec::new();
        for line in markdown.split('\n') {
            let line = line.trim();
            if line.is_empty() {
                if clean.last().map(|l| !l.is_empty()).unwrap_or(false) {
                    clean.push(String::new());
                }
                continue;
            }
            if renderer::is_meaningful_line(line, renderer::BASIC_TECHNICAL_PATTERNS, false) {
                clean.push(line.to_string());
            }
        }
        while clean.last().map(|l| l.is_empty()).unwrap_or(false) {
            clean.pop();
        }
        if clean.is_empty() {
            return dom::get_text_sep(&copy, copy.tree.root().id(), "\n", true);
        }
        clean.join("\n")
    }

    // ---- scrolling ----
    fn initialize_scroll_state(&mut self, doc: &Document) {
        let mut items = Vec::new();
        for id in dom::find_all(doc, &["h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "section", "article", "ul", "ol", "li", "table", "blockquote", "pre"]) {
            let text = dom::get_text_stripped(doc, id);
            if text.chars().count() > 10 {
                let shown: String = if text.chars().count() > 200 { format!("{}...", text.chars().take(200).collect::<String>()) } else { text };
                items.push(ContentItem { kind: dom::tag_name(doc, id).unwrap_or_default(), text: shown });
            }
        }
        self.content_cache = items;
        self.scroll_position = 0;
    }

    fn format_items(&self, start: usize, end: usize) -> String {
        let mut lines = Vec::new();
        for item in &self.content_cache[start..end] {
            if item.kind.len() == 2 && item.kind.starts_with('h') {
                let level: usize = item.kind[1..].parse().unwrap_or(1);
                lines.push(format!("{} {}", "#".repeat(level), item.text));
            } else {
                lines.push(item.text.clone());
            }
            lines.push(String::new());
        }
        lines.join("\n")
    }

    pub fn scroll_down(&mut self, chunks: usize) -> Value {
        if self.doc().is_none() {
            return err(NO_PAGE);
        }
        if self.content_cache.is_empty() {
            return err("No content available to scroll through.");
        }
        let total = self.content_cache.len();
        let new_pos = (self.scroll_position + chunks.max(1) * self.scroll_chunk_size).min(total);
        if new_pos == self.scroll_position {
            return json!({"success": true, "message": "Already at bottom of page", "scroll_position": self.scroll_position, "total_elements": total, "content": "End of page reached"});
        }
        let (start, end) = (self.scroll_position, new_pos);
        self.scroll_position = new_pos;
        json!({"success": true, "message": format!("Scrolled down {chunks} chunk(s)"), "scroll_position": self.scroll_position, "total_elements": total, "visible_range": format!("{}-{}", start + 1, end), "content": self.format_items(start, end), "can_scroll_down": self.scroll_position < total, "can_scroll_up": self.scroll_position > 0})
    }

    pub fn scroll_up(&mut self, chunks: usize) -> Value {
        if self.doc().is_none() {
            return err(NO_PAGE);
        }
        if self.content_cache.is_empty() {
            return err("No content available to scroll through.");
        }
        let total = self.content_cache.len();
        let new_pos = self.scroll_position.saturating_sub(chunks.max(1) * self.scroll_chunk_size);
        if new_pos == self.scroll_position {
            return json!({"success": true, "message": "Already at top of page", "scroll_position": self.scroll_position, "total_elements": total, "content": "Top of page reached"});
        }
        let start = new_pos;
        let end = (start + self.scroll_chunk_size).min(total);
        self.scroll_position = new_pos;
        json!({"success": true, "message": format!("Scrolled up {chunks} chunk(s)"), "scroll_position": self.scroll_position, "total_elements": total, "visible_range": format!("{}-{}", start + 1, end), "content": self.format_items(start, end), "can_scroll_down": self.scroll_position < total, "can_scroll_up": self.scroll_position > 0})
    }

    pub fn scroll_to_top(&mut self) -> Value {
        if self.doc().is_none() {
            return err(NO_PAGE);
        }
        self.scroll_position = 0;
        self.scroll_down(1)
    }

    pub fn scroll_to_bottom(&mut self) -> Value {
        if self.doc().is_none() {
            return err(NO_PAGE);
        }
        if self.content_cache.is_empty() {
            return err("No content available to scroll through.");
        }
        let total = self.content_cache.len();
        self.scroll_position = total.saturating_sub(self.scroll_chunk_size);
        json!({"success": true, "message": "Scrolled to bottom of page", "scroll_position": self.scroll_position, "total_elements": total, "visible_range": format!("{}-{}", self.scroll_position + 1, total), "content": self.format_items(self.scroll_position, total), "can_scroll_down": false, "can_scroll_up": self.scroll_position > 0})
    }

    pub fn get_scroll_info(&self) -> Value {
        if self.doc().is_none() {
            return err(NO_PAGE);
        }
        let total = self.content_cache.len();
        json!({"success": true, "scroll_position": self.scroll_position, "total_elements": total, "chunk_size": self.scroll_chunk_size, "can_scroll_down": self.scroll_position < total, "can_scroll_up": self.scroll_position > 0, "progress_percentage": ((self.scroll_position as f64 / total.max(1) as f64) * 1000.0).round() / 10.0, "current_page": self.current_url})
    }

    // ---- proxy control ----
    pub fn proxy_start(&self) -> Value {
        self.engine.proxy.start();
        json!({"success": true, "message": "Proxy started - all traffic will be intercepted", "status": self.engine.proxy.get_status()})
    }
    pub fn proxy_stop(&self) -> Value {
        self.engine.proxy.stop();
        json!({"success": true, "message": "Proxy stopped - traffic will pass through normally", "status": self.engine.proxy.get_status()})
    }
    pub fn proxy_status(&self) -> Value {
        json!({"success": true, "proxy_status": self.engine.proxy.get_status()})
    }
    pub fn proxy_get_traffic(&self, limit: usize, filter: Option<&Value>) -> Value {
        let traffic = self.engine.proxy.get_traffic_log(limit, filter);
        json!({"success": true, "traffic_count": traffic.len(), "traffic": traffic, "filter_applied": filter.is_some()})
    }
    pub fn proxy_clear_traffic(&self) -> Value {
        self.engine.proxy.clear_traffic_log();
        json!({"success": true, "message": "All traffic logs cleared"})
    }
    pub fn proxy_add_request_interceptor<F>(&self, f: F, name: &str) -> Value
    where
        F: Fn(&mut HttpRequest) + Send + Sync + 'static,
    {
        self.engine.proxy.add_request_interceptor(name, f);
        json!({"success": true, "message": format!("Request interceptor \"{name}\" added successfully"), "interceptors": self.engine.proxy.get_interceptor_info()})
    }
    pub fn proxy_add_response_interceptor<F>(&self, f: F, name: &str) -> Value
    where
        F: Fn(&HttpRequest, &mut HttpResponseRecord) + Send + Sync + 'static,
    {
        self.engine.proxy.add_response_interceptor(name, f);
        json!({"success": true, "message": format!("Response interceptor \"{name}\" added successfully"), "interceptors": self.engine.proxy.get_interceptor_info()})
    }
    pub fn proxy_remove_interceptor(&self, name: &str) -> Value {
        if self.engine.proxy.remove_interceptor(name) {
            json!({"success": true, "message": format!("Interceptor \"{name}\" removed successfully"), "interceptors": self.engine.proxy.get_interceptor_info()})
        } else {
            err(format!("Interceptor \"{name}\" not found"))
        }
    }
    pub fn proxy_list_interceptors(&self) -> Value {
        json!({"success": true, "interceptors": self.engine.proxy.get_interceptor_info()})
    }
    pub fn proxy_add_rule(&self, rule: &Value) -> Value {
        self.engine.proxy.add_declarative_rule(rule)
    }
    pub fn proxy_remove_rule(&self, name: &str) -> Value {
        self.engine.proxy.remove_rule(name)
    }
    pub fn proxy_list_rules(&self) -> Value {
        let rules = self.engine.proxy.list_rules();
        json!({"success": true, "rule_count": rules.len(), "rules": rules})
    }
}

fn create_element_summary(buttons: &[Value], inputs: &[Value]) -> String {
    let mut parts = Vec::new();
    if !buttons.is_empty() {
        parts.push(format!("Found {} clickable elements:", buttons.len()));
        for b in buttons {
            parts.push(format!("  {}. {} ({})", b["number"], b["text"].as_str().unwrap_or(""), b["type"].as_str().unwrap_or("")));
        }
    }
    if !inputs.is_empty() {
        parts.push(format!("Found {} input fields:", inputs.len()));
        for i in inputs {
            let ph = i["placeholder"].as_str().unwrap_or("");
            let ph = if ph.is_empty() { String::new() } else { format!(" - {ph}") };
            parts.push(format!("  {}. {} ({}){}", i["number"], i["name"].as_str().unwrap_or(""), i["type"].as_str().unwrap_or(""), ph));
        }
    }
    if parts.is_empty() {
        parts.push("No interactive elements found on this page.".into());
    }
    parts.join("\n")
}
