//! ARIA and Accessibility Content Extractor.

use super::{find_by_class_regex, take, title_case};
use crate::dom::{self, Document};
use ego_tree::NodeId;
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

const SEMANTIC_ROLES: &[&str] = &[
    "button", "link", "heading", "banner", "navigation", "main", "complementary", "contentinfo", "article", "section", "aside", "search",
    "form", "dialog", "alert", "status", "log", "marquee", "timer", "alertdialog", "application", "document", "feed",
];

static SR_ONLY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"sr-only|screen-reader|visually-hidden").unwrap());
static LANDMARK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"banner|navigation|main|complementary|contentinfo").unwrap());

pub fn extract(doc: &Document, _js_context: &Value) -> String {
    let mut out: Vec<String> = Vec::new();

    for id in dom::find_with_attr(doc, "aria-label") {
        let label = dom::attr(doc, id, "aria-label").unwrap_or_default().trim().to_string();
        if !label.is_empty() {
            out.push(format!("🏷️ {} Label: {label}", dom::tag_name(doc, id).unwrap_or_default().to_uppercase()));
        }
    }
    for id in dom::find_with_attr(doc, "aria-describedby") {
        let target = dom::attr(doc, id, "aria-describedby").unwrap_or_default().trim().to_string();
        if let Some(desc) = dom::find_by_id(doc, &target) {
            let text = dom::get_text_stripped(doc, desc);
            if !text.is_empty() {
                out.push(format!("📝 Description: {text}"));
            }
        }
    }
    for id in dom::find_with_attr(doc, "role") {
        let role = dom::attr(doc, id, "role").unwrap_or_default().trim().to_string();
        if SEMANTIC_ROLES.contains(&role.as_str()) {
            let text = take(&dom::get_text_stripped(doc, id), 100);
            if !text.is_empty() {
                out.push(format!("🎭 {}: {text}", title_case(&role)));
            }
        }
    }
    for id in dom::find_with_attr(doc, "aria-live") {
        let live = dom::attr(doc, id, "aria-live").unwrap_or_default().trim().to_string();
        let content = dom::get_text_stripped(doc, id);
        if !content.is_empty() && !live.is_empty() {
            out.push(format!("📢 Live {}: {content}", title_case(&live)));
        }
    }
    for id in dom::find_with_attr(doc, "aria-errormessage") {
        let target = dom::attr(doc, id, "aria-errormessage").unwrap_or_default().trim().to_string();
        if let Some(err) = dom::find_by_id(doc, &target) {
            let text = dom::get_text_stripped(doc, err);
            if !text.is_empty() {
                out.push(format!("❌ Error: {text}"));
            }
        }
    }
    for id in dom::find_with_attr(doc, "aria-expanded") {
        let expanded = dom::attr(doc, id, "aria-expanded").unwrap_or_default().trim().to_lowercase();
        let label = dom::attr(doc, id, "aria-label").unwrap_or_else(|| take(&dom::get_text_stripped(doc, id), 50));
        if !label.is_empty() {
            out.push(format!("🔽 {}: {label}", if expanded == "true" { "Expanded" } else { "Collapsed" }));
        }
    }
    for id in dom::find_with_attr(doc, "aria-current") {
        let cur = dom::attr(doc, id, "aria-current").unwrap_or_default().trim().to_string();
        if !cur.is_empty() && cur != "false" {
            let text = dom::get_text_stripped(doc, id);
            if !text.is_empty() {
                out.push(format!("👉 Current {cur}: {text}"));
            }
        }
    }
    out.extend(alt_descriptions(doc));
    out.extend(form_accessibility(doc));

    if out.is_empty() {
        String::new()
    } else {
        format!("\n## 🔍 Accessibility Content\n{}\n", out.join("\n"))
    }
}

fn alt_descriptions(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for img in dom::find_all(doc, &["img"]) {
        if let Some(alt) = dom::attr(doc, img, "alt").map(|a| a.trim().to_string()).filter(|a| !a.is_empty()) {
            let src = take(&dom::attr(doc, img, "src").unwrap_or_else(|| "unknown".into()), 50);
            out.push(format!("🖼️ Image ({src}): {alt}"));
        }
    }
    for fig in dom::find_all(doc, &["figure"]) {
        if let Some(cap) = dom::find_all_within(doc, fig, &["figcaption"]).first() {
            let text = dom::get_text_stripped(doc, *cap);
            if !text.is_empty() {
                out.push(format!("📊 Figure Caption: {text}"));
            }
        }
    }
    for table in dom::find_all(doc, &["table"]) {
        if let Some(cap) = dom::find_all_within(doc, table, &["caption"]).first() {
            let text = dom::get_text_stripped(doc, *cap);
            if !text.is_empty() {
                out.push(format!("📋 Table Caption: {text}"));
            }
        }
        if let Some(summary) = dom::attr(doc, table, "summary").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            out.push(format!("📋 Table Summary: {summary}"));
        }
    }
    out
}

fn form_accessibility(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for label in dom::find_all(doc, &["label"]) {
        let text = dom::get_text_stripped(doc, label);
        if text.is_empty() {
            continue;
        }
        if let Some(for_attr) = dom::attr(doc, label, "for") {
            if let Some(target) = dom::find_by_id(doc, &for_attr) {
                let ty = dom::attr(doc, target, "type").unwrap_or_else(|| dom::tag_name(doc, target).unwrap_or_default());
                out.push(format!("🏷️ {} Label: {text}", title_case(&ty)));
            }
        }
    }
    for id in dom::find_with_attr(doc, "required") {
        let label = element_label(doc, id);
        if !label.is_empty() {
            out.push(format!("⚠️ Required Field: {label}"));
        }
    }
    for id in dom::find_with_attr(doc, "aria-describedby") {
        if matches!(dom::tag_name(doc, id).as_deref(), Some("input" | "textarea" | "select")) {
            let target = dom::attr(doc, id, "aria-describedby").unwrap_or_default().trim().to_string();
            if let Some(desc) = dom::find_by_id(doc, &target) {
                let text = dom::get_text_stripped(doc, desc);
                if !text.is_empty() {
                    out.push(format!("💡 Field Hint ({}): {text}", element_label(doc, id)));
                }
            }
        }
    }
    out
}

/// Label for a form element (aria-label, `<label for>`, parent label, placeholder, name).
pub fn element_label(doc: &Document, id: NodeId) -> String {
    if let Some(l) = dom::attr(doc, id, "aria-label").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return l;
    }
    if let Some(el_id) = dom::attr(doc, id, "id") {
        for label in dom::find_all(doc, &["label"]) {
            if dom::attr(doc, label, "for").as_deref() == Some(el_id.as_str()) {
                return dom::get_text_stripped(doc, label);
            }
        }
    }
    if let Some(parent) = dom::find_parent(doc, id, "label") {
        return dom::get_text_stripped(doc, parent);
    }
    dom::attr(doc, id, "placeholder").or_else(|| dom::attr(doc, id, "name")).unwrap_or_else(|| "Unknown Field".into())
}

/// Content specifically for screen readers.
pub fn extract_screen_reader_content(doc: &Document) -> String {
    let mut out = Vec::new();
    for id in find_by_class_regex(doc, &SR_ONLY_RE) {
        let text = dom::get_text_stripped(doc, id);
        if !text.is_empty() {
            out.push(format!("👁️ Screen Reader: {text}"));
        }
    }
    for a in dom::find_all(doc, &["a"]) {
        if dom::attr(doc, a, "href").map(|h| h.starts_with('#')).unwrap_or(false) && dom::get_text(doc, a).to_lowercase().contains("skip") {
            out.push(format!("⏭️ Skip Link: {}", dom::get_text_stripped(doc, a)));
        }
    }
    for id in dom::find_with_attr(doc, "role") {
        let role = dom::attr(doc, id, "role").unwrap_or_default();
        if LANDMARK_RE.is_match(&role) {
            let label = dom::attr(doc, id, "aria-label").or_else(|| dom::attr(doc, id, "aria-labelledby")).unwrap_or_default();
            if !label.is_empty() {
                out.push(format!("🗺️ {} Region: {label}", title_case(&role)));
            }
        }
    }
    if out.is_empty() {
        String::new()
    } else {
        format!("\n## 👁️ Screen Reader Content\n{}\n", out.join("\n"))
    }
}
