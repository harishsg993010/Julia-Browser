//! Dynamic Content Loading Detection - lazy-loaded media, infinite scroll,
//! AJAX placeholders and progressive enhancement hints.

use super::{find_by_class_regex, take, title_case};
use crate::dom::{self, Document};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

const LAZY_SELECTORS: &[&str] = &["[data-lazy]", "[data-src]", "[loading=\"lazy\"]", ".lazy", ".lazyload", ".lazy-load", "[data-original]", "[data-echo]"];
const INFINITE_SELECTORS: &[&str] = &[".load-more", ".show-more", ".infinite-scroll", "[data-infinite]", "[data-scroll]", ".pagination-next", ".load-next", ".more-content"];

static PAGINATION_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"pagination|pager").unwrap());
static NEXT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)next|more").unwrap());
static LOADING_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"loading|spinner|placeholder|skeleton").unwrap());
static TOGGLE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"collapse|accordion|dropdown|toggle").unwrap());
static DATA_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    ["data-.*url", "data-.*src", "data-.*content", "data-.*load", "data-.*fetch"].iter().map(|p| Regex::new(p).unwrap()).collect()
});
static DISPLAY_NONE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"display:\s*none").unwrap());

pub fn detect(doc: &Document, js_context: &Value) -> String {
    let mut out = Vec::new();
    out.extend(lazy_media(doc));
    out.extend(infinite_scroll(doc));
    out.extend(ajax_content(doc, js_context));
    out.extend(progressive_content(doc));
    out.extend(lazy_loading_data(doc));
    if out.is_empty() {
        String::new()
    } else {
        format!("\n## 🔄 Dynamic Content Detected\n{}\n", out.join("\n"))
    }
}

fn lazy_media(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for selector in LAZY_SELECTORS {
        for id in dom::select(doc, selector) {
            if dom::tag_name(doc, id).as_deref() != Some("img") {
                continue;
            }
            let src = dom::attr(doc, id, "data-src")
                .or_else(|| dom::attr(doc, id, "data-original"))
                .or_else(|| dom::attr(doc, id, "data-lazy"))
                .or_else(|| dom::attr(doc, id, "src"))
                .unwrap_or_default();
            let alt = dom::attr(doc, id, "alt").unwrap_or_else(|| "Image".into());
            if src.is_empty() {
                out.push(format!("🖼️ Lazy Image: {alt} (source pending)"));
            } else {
                out.push(format!("🖼️ Lazy Image: {alt} ({}...)", take(&src, 50)));
            }
        }
    }
    for video in dom::find_all(doc, &["video"]) {
        if let Some(src) = dom::attr(doc, video, "data-src") {
            let title = dom::attr(doc, video, "title").or_else(|| dom::attr(doc, video, "aria-label")).unwrap_or_else(|| "Video".into());
            out.push(format!("🎥 Lazy Video: {title} ({}...)", take(&src, 50)));
        }
    }
    for iframe in dom::find_all(doc, &["iframe"]) {
        if let Some(src) = dom::attr(doc, iframe, "data-src") {
            let title = dom::attr(doc, iframe, "title").or_else(|| dom::attr(doc, iframe, "aria-label")).unwrap_or_else(|| "Embedded Content".into());
            out.push(format!("📱 Lazy Embed: {title} ({}...)", take(&src, 50)));
        }
    }
    out
}

fn infinite_scroll(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for selector in INFINITE_SELECTORS {
        for id in dom::select(doc, selector) {
            let text = dom::get_text_stripped(doc, id);
            if !text.is_empty() {
                out.push(format!("📜 Load More: {text}"));
            }
            if let Some(url) = dom::attr(doc, id, "data-url").or_else(|| dom::attr(doc, id, "data-next")).or_else(|| dom::attr(doc, id, "data-load")) {
                out.push(format!("🔗 Next Content URL: {}...", take(&url, 50)));
            }
        }
    }
    for pag in find_by_class_regex(doc, &PAGINATION_RE) {
        for a in dom::find_all_within(doc, pag, &["a"]) {
            if NEXT_RE.is_match(&dom::get_text(doc, a)) {
                out.push(format!("➡️ Next Page: {}...", take(&dom::attr(doc, a, "href").unwrap_or_default(), 50)));
                break;
            }
        }
    }
    for id in dom::find_with_attr(doc, "data-scroll") {
        let info = dom::attr(doc, id, "data-scroll").unwrap_or_default();
        if !info.is_empty() {
            out.push(format!("📏 Scroll Trigger: {info}"));
        }
    }
    out
}

fn ajax_content(doc: &Document, ctx: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for id in dom::find_with_attr(doc, "data-ajax") {
        let url = dom::attr(doc, id, "data-ajax").unwrap_or_default();
        let text = take(&dom::get_text_stripped(doc, id), 50);
        let text = if text.is_empty() { "Content Area".to_string() } else { text };
        if !url.is_empty() {
            out.push(format!("⚡ AJAX Content: {text} → {}...", take(&url, 50)));
        }
    }
    for id in find_by_class_regex(doc, &LOADING_RE) {
        let text = dom::get_text_stripped(doc, id);
        if text.is_empty() {
            out.push("⏳ Content Loading Indicator".into());
        } else {
            out.push(format!("⏳ Loading Placeholder: {}...", take(&text, 50)));
        }
    }
    if let Some(endpoints) = ctx.get("ajax_endpoints").and_then(Value::as_array) {
        for e in endpoints.iter().take(5) {
            out.push(format!("🔗 AJAX Endpoint: {}", e.as_str().map(|s| s.to_string()).unwrap_or_else(|| e.to_string())));
        }
    }
    for id in dom::find_with_attr(doc, "data-api") {
        let url = dom::attr(doc, id, "data-api").unwrap_or_default();
        if !url.is_empty() {
            out.push(format!("🌐 API Endpoint: {}...", take(&url, 50)));
        }
    }
    out
}

fn progressive_content(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for id in dom::find_all(doc, &["noscript"]) {
        let text = dom::get_text_stripped(doc, id);
        if !text.is_empty() {
            out.push(format!("🚫 No-JS Alternative: {}...", take(&text, 100)));
        }
    }
    for id in dom::find_all(doc, &["template"]) {
        let tid = dom::attr(doc, id, "id").unwrap_or_else(|| "Unknown".into());
        let preview = take(&dom::get_text_stripped(doc, id), 50);
        if !preview.is_empty() {
            out.push(format!("📋 Template ({tid}): {preview}..."));
        }
    }
    for id in dom::find_with_attr(doc, "data-show") {
        let cond = dom::attr(doc, id, "data-show").unwrap_or_default();
        let text = take(&dom::get_text_stripped(doc, id), 50);
        if !text.is_empty() {
            out.push(format!("👁️ Conditional Content ({cond}): {text}..."));
        }
    }
    for id in find_by_class_regex(doc, &TOGGLE_RE) {
        let text = take(&dom::get_text_stripped(doc, id), 50);
        if !text.is_empty() {
            out.push(format!("🔽 Collapsible Content: {text}..."));
        }
    }
    out
}

fn lazy_loading_data(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for re in DATA_PATTERNS.iter() {
        let mut count = 0;
        for id in dom::find_all(doc, &[]) {
            let node = match doc.tree.get(id) {
                Some(n) => n,
                None => continue,
            };
            let el = match node.value().as_element() {
                Some(e) => e,
                None => continue,
            };
            let mut matched = false;
            for (name, value) in el.attrs() {
                if re.is_match(name) && !value.is_empty() && (value.starts_with("http") || value.starts_with("//") || value.starts_with('/') || value.len() > 20) {
                    out.push(format!("📦 Lazy Data ({name}): {}...", take(value, 50)));
                    matched = true;
                }
            }
            if matched {
                count += 1;
                if count >= 10 {
                    break;
                }
            }
        }
    }
    for script in dom::find_all(doc, &["script"]) {
        if dom::attr(doc, script, "type").as_deref() == Some("application/json") {
            let sid = dom::attr(doc, script, "id").unwrap_or_else(|| "unknown".into());
            let content = dom::get_text_stripped(doc, script);
            if content.len() > 50 {
                out.push(format!("🔧 JSON Data ({sid}): {}...", take(&content, 50)));
            }
        }
    }
    out
}

/// Attempt to extract actual content from dynamic loading patterns.
pub fn attempt_dynamic_content_extraction(doc: &Document, _js_context: &Value) -> String {
    let mut out = Vec::new();
    for id in dom::find_with_attr(doc, "data-src") {
        let src = dom::attr(doc, id, "data-src").unwrap_or_default();
        if !src.is_empty() && !src.starts_with("data:") {
            out.push(format!("🔗 {} URL: {src}", title_case(&dom::tag_name(doc, id).unwrap_or_default())));
        }
    }
    for id in dom::find_all(doc, &["template"]) {
        let content = dom::get_text_stripped(doc, id);
        if !content.is_empty() {
            out.push(format!("📄 {}: {content}", dom::attr(doc, id, "id").unwrap_or_else(|| "Template".into())));
        }
    }
    for id in dom::find_with_attr(doc, "style") {
        if DISPLAY_NONE_RE.is_match(&dom::attr(doc, id, "style").unwrap_or_default()) {
            let content = dom::get_text_stripped(doc, id);
            if content.len() > 10 {
                out.push(format!("👁️ Hidden Content: {}...", take(&content, 100)));
            }
        }
    }
    if out.is_empty() {
        String::new()
    } else {
        format!("\n## 📥 Extracted Dynamic Content\n{}\n", out.join("\n"))
    }
}
