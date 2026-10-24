//! Browser SDK - programmatic access to the browser (fetch, render, links, search, batch).

use crate::dom::{self, Document};
use crate::engine::BrowserEngine;
use crate::js::JsConfig;
use chrono::Local;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Page metadata extracted after a fetch.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Metadata {
    pub title: Option<String>,
    pub meta: BTreeMap<String, String>,
    pub language: Option<String>,
    pub character_count: usize,
    pub word_count: usize,
    pub link_count: usize,
    pub image_count: usize,
    pub content_type: String,
}

/// Result of an SDK operation. `content` holds the rendered output (or the raw
/// HTML for `fetch_page`); `document` the parsed DOM.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SdkResult {
    pub success: bool,
    pub url: String,
    pub final_url: Option<String>,
    pub timestamp: String,
    pub content: Option<String>,
    pub raw_html: Option<String>,
    pub error: Option<String>,
    pub metadata: Option<Metadata>,
    pub format: Option<String>,
    pub javascript_executed: Option<bool>,
    pub links: Option<Vec<(String, String)>>,
    pub link_count: Option<usize>,
    pub query: Option<String>,
    pub results: Option<Vec<String>>,
    pub result_count: Option<usize>,
    pub json_data: Option<Value>,
    /// Summary of the page's JavaScript run (console lines, errors, network calls).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub javascript: Option<Value>,
    #[serde(skip)]
    pub document: Option<Document>,
}

impl SdkResult {
    fn failure(url: &str, error: String) -> Self {
        Self { success: false, url: url.to_string(), timestamp: now(), error: Some(error), ..Default::default() }
    }

    /// The result as a JSON value (documents are omitted).
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

fn now() -> String {
    Local::now().to_rfc3339()
}

/// Rust SDK for the browser engine.
pub struct BrowserSdk {
    pub engine: BrowserEngine,
    pub default_timeout: u64,
}

impl Default for BrowserSdk {
    fn default() -> Self {
        Self::new(None, 30)
    }
}

impl BrowserSdk {
    pub fn new(user_agent: Option<&str>, timeout: u64) -> Self {
        let mut engine = BrowserEngine::new(user_agent);
        engine.default_timeout = timeout;
        Self { engine, default_timeout: timeout }
    }

    pub fn with_js_config(user_agent: Option<&str>, timeout: u64, js: JsConfig) -> Self {
        let mut engine = BrowserEngine::with_js_config(user_agent, js);
        engine.default_timeout = timeout;
        Self { engine, default_timeout: timeout }
    }

    /// Fetch a page (raw HTML + metadata).
    pub fn fetch_page(&mut self, url: &str, timeout: Option<u64>) -> SdkResult {
        let timeout = timeout.unwrap_or(self.default_timeout);
        match self.engine.fetch_page(url, timeout) {
            Ok(page) => {
                let mut metadata = extract_metadata(&page.document);
                metadata.content_type = page.response.content_type();
                SdkResult {
                    success: true,
                    url: url.to_string(),
                    final_url: self.engine.current_url.clone(),
                    timestamp: now(),
                    content: Some(page.html.clone()),
                    raw_html: Some(page.html),
                    metadata: Some(metadata),
                    json_data: self.engine.current_json_data.clone(),
                    document: Some(page.document),
                    ..Default::default()
                }
            }
            Err(e) => SdkResult::failure(url, e.to_string()),
        }
    }

    /// Fetch and render to markdown.
    pub fn render_to_markdown(&mut self, url: &str, execute_js: bool, timeout: Option<u64>) -> SdkResult {
        let prev = self.engine.execute_js;
        self.engine.execute_js = execute_js;
        let mut result = self.fetch_page(url, timeout);
        self.engine.execute_js = prev;
        if !result.success {
            return result;
        }
        let markdown = match &result.document {
            Some(doc) => self.engine.render_page(doc, execute_js),
            None => String::new(),
        };
        result.content = Some(markdown);
        result.format = Some("markdown".into());
        result.javascript_executed = Some(execute_js);
        result.javascript = self.engine.last_js.as_ref().map(|js| {
            json!({
                "scripts_run": js.scripts_run,
                "scripts_failed": js.scripts_failed,
                "errors": js.errors,
                "console": js.console,
                "api_calls": js.api_calls,
                "navigations": js.navigations,
                "final_url": js.final_url,
            })
        });
        result
    }

    /// Fetch and render to plain text.
    pub fn render_to_text(&mut self, url: &str, execute_js: bool, timeout: Option<u64>) -> SdkResult {
        let mut result = self.render_to_markdown(url, execute_js, timeout);
        if !result.success {
            return result;
        }
        let md = result.content.clone().unwrap_or_default();
        let text = markdown_to_text(&md);
        result.content = Some(text);
        result.format = Some("text".into());
        result
    }

    /// Fetch and render as a character-cell screenshot (`--format layout`).
    pub fn render_to_layout(&mut self, url: &str, execute_js: bool, timeout: Option<u64>, opts: &crate::layout::TextOptions) -> SdkResult {
        let prev = self.engine.execute_js;
        self.engine.execute_js = execute_js;
        let mut result = self.fetch_page(url, timeout);
        self.engine.execute_js = prev;
        if !result.success {
            return result;
        }
        match result.document.as_ref().and_then(|doc| self.engine.render_layout_text(doc, opts)) {
            Some(text) => {
                result.content = Some(text);
                result.format = Some("layout".into());
                result.javascript_executed = Some(execute_js);
            }
            None => {
                result.success = false;
                result.error = Some("layout rendering is not compiled in (build with --features layout)".into());
            }
        }
        result
    }

    /// Fetch and capture as PNG bytes (`--format png`, feature `screenshot`);
    /// `clip` is a CSS selector to capture one element.
    pub fn render_to_png(&mut self, url: &str, execute_js: bool, timeout: Option<u64>, opts: &crate::layout::ScreenshotOptions, clip: Option<&str>) -> Result<Vec<u8>, String> {
        let prev = self.engine.execute_js;
        self.engine.execute_js = execute_js;
        let result = self.fetch_page(url, timeout);
        self.engine.execute_js = prev;
        if !result.success {
            return Err(result.error.unwrap_or_else(|| "fetch failed".into()));
        }
        let doc = result.document.as_ref().ok_or("no document")?;
        self.engine.render_screenshot(doc, opts, clip).unwrap_or_else(|| Err("screenshots are not compiled in (build with --features screenshot)".into()))
    }

    /// Alias kept for API compatibility (`sdk.browse_url`).
    pub fn browse_url(&mut self, url: &str) -> SdkResult {
        self.render_to_markdown(url, true, None)
    }

    /// Fetch a page and list its links.
    pub fn get_page_links(&mut self, url: &str, timeout: Option<u64>) -> SdkResult {
        let mut result = self.fetch_page(url, timeout);
        if !result.success {
            return result;
        }
        let links = self.engine.get_links();
        result.link_count = Some(links.len());
        result.links = Some(links);
        result.content = None;
        result
    }

    /// Fetch a page and search its text.
    pub fn search_page(&mut self, url: &str, query: &str, timeout: Option<u64>) -> SdkResult {
        let mut result = self.fetch_page(url, timeout);
        result.query = Some(query.to_string());
        if !result.success {
            return result;
        }
        let results = self.engine.search_page(query);
        result.result_count = Some(results.len());
        result.results = Some(results);
        result.content = None;
        result
    }

    /// Process several URLs (`markdown` or `text`).
    pub fn batch_process(&mut self, urls: &[String], output_format: &str, execute_js: bool, timeout: Option<u64>) -> Vec<SdkResult> {
        urls.iter()
            .map(|u| match output_format {
                "markdown" => self.render_to_markdown(u, execute_js, timeout),
                "text" => self.render_to_text(u, execute_js, timeout),
                other => SdkResult::failure(u, format!("Unsupported format: {other}")),
            })
            .collect()
    }

    /// Fetch and render in one call (`markdown`, `text` or `html`).
    pub fn fetch_and_render(&mut self, url: &str, output_format: &str, execute_js: bool, timeout: Option<u64>) -> SdkResult {
        match output_format {
            "markdown" => self.render_to_markdown(url, execute_js, timeout),
            "text" => self.render_to_text(url, execute_js, timeout),
            "html" => {
                let mut r = self.fetch_page(url, timeout);
                if r.success {
                    r.format = Some("html".into());
                }
                r
            }
            other => SdkResult::failure(url, format!("Unsupported output format: {other}")),
        }
    }

    /// Submit a form to a URL with the given fields (POST).
    pub fn submit_form(&mut self, url: &str, data: &BTreeMap<String, String>) -> SdkResult {
        match self.engine.session.post_form(url, data, &BTreeMap::new(), self.default_timeout) {
            Ok(resp) => {
                let doc = dom::parse_document(&resp.text);
                let markdown = self.engine.render_page(&doc, false);
                SdkResult {
                    success: resp.ok(),
                    url: url.to_string(),
                    final_url: Some(resp.url.clone()),
                    timestamp: now(),
                    content: Some(markdown),
                    raw_html: Some(resp.text.clone()),
                    metadata: Some(extract_metadata(&doc)),
                    error: if resp.ok() { None } else { Some(format!("HTTP {}: {}", resp.status, resp.reason)) },
                    document: Some(doc),
                    ..Default::default()
                }
            }
            Err(e) => SdkResult::failure(url, e.to_string()),
        }
    }

    pub fn get_browser_info(&self) -> Value {
        json!({
            "user_agent": self.engine.user_agent,
            "default_timeout": self.default_timeout,
            "history_count": self.engine.history.len(),
            "current_url": self.engine.current_url,
            "version": env!("CARGO_PKG_VERSION"),
            "javascript_engine": "SpiderMonkey (mozjs)",
        })
    }

    pub fn clear_history(&mut self) {
        self.engine.history.clear();
        self.engine.history_index = -1;
        self.engine.current_url = None;
        self.engine.current_document = None;
    }

    pub fn set_user_agent(&mut self, user_agent: &str) {
        self.engine.user_agent = user_agent.to_string();
        self.engine.base_headers.insert("User-Agent".into(), user_agent.to_string());
        self.engine.session.set_user_agent(user_agent);
        self.engine.session.set_default_headers(self.engine.base_headers.clone());
    }

    /// Export results as JSON or CSV.
    pub fn export_results(&self, results: &[SdkResult], filename: &str, format: &str) -> std::io::Result<()> {
        match format {
            "json" => {
                let values: Vec<Value> = results.iter().map(|r| r.to_json()).collect();
                std::fs::write(filename, serde_json::to_string_pretty(&values).unwrap_or_default())
            }
            "csv" => {
                let mut out = String::from("success,url,final_url,timestamp,error,title,word_count\n");
                for r in results {
                    let title = r.metadata.as_ref().and_then(|m| m.title.clone()).unwrap_or_default();
                    let words = r.metadata.as_ref().map(|m| m.word_count).unwrap_or(0);
                    out.push_str(&format!("{},{},{},{},{},{},{}\n", r.success, csv(&r.url), csv(r.final_url.as_deref().unwrap_or("")), r.timestamp, csv(r.error.as_deref().unwrap_or("")), csv(&title), words));
                }
                std::fs::write(filename, out)
            }
            other => Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("Unsupported export format: {other}"))),
        }
    }
}

/// Plain-text view of rendered markdown: links keep their text (URLs are
/// dropped), images keep their alt text, emphasis/heading markers are removed
/// and table rows become tab-separated cells.
pub fn markdown_to_text(md: &str) -> String {
    use std::sync::LazyLock;
    static IMG: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"!\[([^\]]*)\]\([^)]*\)").unwrap());
    static LINK: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap());
    static AUTOLINK: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"<(https?://[^>]+)>").unwrap());
    static EMPH: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(\*\*|__|~~|\*|_|`)").unwrap());
    static HEADING: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?m)^#{1,6}\s+").unwrap());
    static QUOTE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?m)^>\s?").unwrap());
    static SEP_ROW: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?m)^\|(\s*:?-+:?\s*\|)+\s*$").unwrap());
    static MULTI_NL: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\n{3,}").unwrap());
    let mut s = IMG.replace_all(md, "$1").into_owned();
    s = LINK.replace_all(&s, "$1").into_owned();
    s = AUTOLINK.replace_all(&s, "$1").into_owned();
    s = SEP_ROW.replace_all(&s, "").into_owned();
    s = HEADING.replace_all(&s, "").into_owned();
    s = QUOTE.replace_all(&s, "").into_owned();
    s = EMPH.replace_all(&s, "").into_owned();
    let lines: Vec<String> = s
        .lines()
        .map(|l| {
            let t = l.trim_end();
            if t.starts_with('|') && t.ends_with('|') {
                t.trim_matches('|').split('|').map(|c| c.trim()).filter(|c| !c.is_empty()).collect::<Vec<_>>().join("\t")
            } else {
                t.to_string()
            }
        })
        .collect();
    MULTI_NL.replace_all(&lines.join("\n"), "\n\n").trim().to_string()
}

fn csv(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// Title, meta tags, language and simple counts.
pub fn extract_metadata(doc: &Document) -> Metadata {
    let mut meta = BTreeMap::new();
    for id in dom::find_all(doc, &["meta"]) {
        let name = dom::attr(doc, id, "name").or_else(|| dom::attr(doc, id, "property")).or_else(|| dom::attr(doc, id, "http-equiv"));
        if let (Some(n), Some(c)) = (name, dom::attr(doc, id, "content")) {
            meta.insert(n, c);
        }
    }
    let text = dom::visible_text(doc);
    Metadata {
        title: dom::title(doc),
        meta,
        language: dom::find_first(doc, "html").and_then(|h| dom::attr(doc, h, "lang")),
        character_count: text.chars().count(),
        word_count: text.split_whitespace().count(),
        link_count: dom::find_all(doc, &["a"]).into_iter().filter(|a| dom::has_attr(doc, *a, "href")).count(),
        image_count: dom::find_all(doc, &["img"]).len(),
        content_type: String::new(),
    }
}
