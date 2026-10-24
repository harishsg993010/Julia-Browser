//! CSS Media Query Content Selection - responsive/print/device specific content.

use super::{classes, find_by_class_regex, take, title_case};
use crate::dom::{self, Document};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

const DISPLAY_CLASSES: &[&str] = &[
    "d-none", "d-block", "d-inline", "d-flex", "d-grid", "hidden", "visible", "show", "hide", "desktop-only", "mobile-only", "tablet-only",
    "print-only", "screen-only",
];
const BREAKPOINTS: &[(&str, &str)] = &[
    ("xs", "(max-width: 575px)"),
    ("sm", "(min-width: 576px)"),
    ("md", "(min-width: 768px)"),
    ("lg", "(min-width: 992px)"),
    ("xl", "(min-width: 1200px)"),
    ("mobile", "(max-width: 767px)"),
    ("tablet", "(min-width: 768px) and (max-width: 1023px)"),
    ("desktop", "(min-width: 1024px)"),
    ("print", "print"),
];

static MEDIA_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)@media\s+([^{]+)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}").unwrap());
static MEDIA_SCREEN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)@media\s+screen\s+and\s+\(([^)]+)\)").unwrap());
static MEDIA_PRINT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)@media\s+print").unwrap());
static MEDIA_PAREN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)@media\s+\(([^)]+)\)").unwrap());
static BOOTSTRAP_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [r"d-\w+-none", r"d-\w+-block", r"d-\w+-flex", r"d-\w+-grid", r"visible-\w+", r"hidden-\w+", r"show-\w+", r"hide-\w+"]
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect()
});
static PRINT_HIDDEN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"d-none.*d-print-block|hidden.*visible-print").unwrap());
static PAGE_BREAK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"page-break|break-page").unwrap());
static TOUCH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"touch|no-touch").unwrap());
static LAYOUT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"col-\w+|flex-\w+|grid-\w+").unwrap());
static WIDTH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(max|min)-width:\s*(\d+)").unwrap());

pub fn extract(doc: &Document, _js_context: &Value) -> String {
    let mut out = Vec::new();
    out.extend(css_media_queries(doc));
    out.extend(responsive_content(doc));
    out.extend(print_content(doc));
    out.extend(device_specific_content(doc));
    out.extend(conditional_display_content(doc));
    if out.is_empty() {
        String::new()
    } else {
        format!("\n## 📱 Responsive & Media-Specific Content\n{}\n", out.join("\n"))
    }
}

fn css_media_queries(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for style in dom::find_all(doc, &["style"]) {
        let css = dom::get_text(doc, style);
        if css.trim().is_empty() {
            continue;
        }
        for c in MEDIA_BLOCK_RE.captures_iter(&css) {
            let cond = c[1].trim();
            let rules = c[2].trim();
            if !cond.is_empty() && !rules.is_empty() {
                out.push(format!("📐 Media Query ({cond}): {}...", take(rules, 100)));
            }
        }
        for c in MEDIA_SCREEN_RE.captures_iter(&css) {
            out.push(format!("📐 Media Condition: {}", &c[1]));
        }
        for _ in MEDIA_PRINT_RE.find_iter(&css) {
            out.push("📐 Media Condition: print".into());
        }
        for c in MEDIA_PAREN_RE.captures_iter(&css) {
            out.push(format!("📐 Media Condition: {}", &c[1]));
        }
    }
    for link in dom::find_all(doc, &["link"]) {
        let rel = dom::attr(doc, link, "rel").unwrap_or_default().to_ascii_lowercase();
        if !rel.split_whitespace().any(|r| r == "stylesheet") {
            continue;
        }
        if let (Some(media), Some(href)) = (dom::attr(doc, link, "media"), dom::attr(doc, link, "href")) {
            if !media.is_empty() && !href.is_empty() {
                out.push(format!("🔗 Stylesheet ({media}): {href}"));
            }
        }
    }
    out
}

fn responsive_content(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for class in DISPLAY_CLASSES {
        for id in dom::find_by_class(doc, class) {
            let content = dom::get_text_stripped(doc, id);
            if !content.is_empty() {
                out.push(format!("📱 {}: {}...", title_case(class), take(&content, 100)));
            }
        }
        if let Ok(re) = Regex::new(&format!(r"{}-\w+", regex::escape(class))) {
            for id in find_by_class_regex(doc, &re) {
                let matching: Vec<String> = classes(doc, id).into_iter().filter(|c| c.contains(class)).collect();
                let content = dom::get_text_stripped(doc, id);
                if let (Some(first), false) = (matching.first(), content.is_empty()) {
                    out.push(format!("📱 {first}: {}...", take(&content, 100)));
                }
            }
        }
    }
    for re in BOOTSTRAP_PATTERNS.iter() {
        for id in find_by_class_regex(doc, re).into_iter().take(5) {
            let matching: Vec<String> = classes(doc, id).into_iter().filter(|c| re.is_match(c)).collect();
            let content = dom::get_text_stripped(doc, id);
            if let (Some(first), false) = (matching.first(), content.is_empty()) {
                out.push(format!("📱 {first}: {}...", take(&content, 100)));
            }
        }
    }
    out
}

fn print_content(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for class in ["print-only", "d-print-block", "visible-print", "show-print"] {
        for id in dom::find_by_class(doc, class) {
            let content = dom::get_text_stripped(doc, id);
            if !content.is_empty() {
                out.push(format!("🖨️ Print Only: {}...", take(&content, 100)));
            }
        }
    }
    for id in find_by_class_regex(doc, &PRINT_HIDDEN_RE) {
        let content = dom::get_text_stripped(doc, id);
        if !content.is_empty() {
            out.push(format!("🖨️ Print Version: {}...", take(&content, 100)));
        }
    }
    for id in dom::find_with_attr(doc, "data-print") {
        let content = dom::get_text_stripped(doc, id);
        if !content.is_empty() {
            out.push(format!("🖨️ Print Content: {}...", take(&content, 100)));
        }
    }
    for id in find_by_class_regex(doc, &PAGE_BREAK_RE) {
        let content = dom::get_text_stripped(doc, id);
        if content.is_empty() {
            out.push("📄 Page Break Marker".into());
        } else {
            out.push(format!("📄 Page Break: {content}"));
        }
    }
    out
}

fn device_specific_content(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    let groups: [(&[&str], &str); 3] = [
        (&[".mobile-only", ".d-block.d-md-none", ".visible-xs", ".show-mobile"], "📱 Mobile Only"),
        (&[".desktop-only", ".d-none.d-lg-block", ".visible-lg", ".show-desktop"], "🖥️ Desktop Only"),
        (&[".tablet-only", ".d-none.d-md-block.d-lg-none", ".visible-md", ".show-tablet"], "📺 Tablet Only"),
    ];
    for (selectors, label) in groups {
        for selector in selectors {
            for id in dom::select(doc, selector) {
                let content = dom::get_text_stripped(doc, id);
                if !content.is_empty() {
                    out.push(format!("{label}: {}...", take(&content, 100)));
                }
            }
        }
    }
    for id in find_by_class_regex(doc, &TOUCH_RE) {
        let touch: Vec<String> = classes(doc, id).into_iter().filter(|c| c.contains("touch")).collect();
        let content = dom::get_text_stripped(doc, id);
        if let (Some(first), false) = (touch.first(), content.is_empty()) {
            out.push(format!("👆 {}: {}...", title_case(first), take(&content, 100)));
        }
    }
    out
}

fn conditional_display_content(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for (attr, label) in [("data-show-on", "👁️ Show On"), ("data-breakpoint", "📐 Breakpoint"), ("data-viewport", "🔍 Viewport")] {
        for id in dom::find_with_attr(doc, attr) {
            let cond = dom::attr(doc, id, attr).unwrap_or_default();
            let content = dom::get_text_stripped(doc, id);
            if !content.is_empty() && !cond.is_empty() {
                out.push(format!("{label} ({cond}): {}...", take(&content, 100)));
            }
        }
    }
    for id in find_by_class_regex(doc, &LAYOUT_RE).into_iter().take(10) {
        let layout: Vec<String> = classes(doc, id).into_iter().filter(|c| c.contains("col-") || c.contains("flex-") || c.contains("grid-")).collect();
        let content = dom::get_text_stripped(doc, id);
        if let (Some(first), false) = (layout.first(), content.is_empty()) {
            out.push(format!("🔧 Layout ({first}): {}...", take(&content, 100)));
        }
    }
    out
}

/// Simulate media query evaluation for a specific viewport.
pub fn simulate_media_queries(doc: &Document, target_width: u32, target_media: &str) -> String {
    let mut out = Vec::new();
    let mut active = Vec::new();
    for (name, query) in BREAKPOINTS {
        let is_active = if let Some(c) = WIDTH_RE.captures(query) {
            let n: u32 = c[2].parse().unwrap_or(0);
            if &c[1] == "max" { target_width <= n } else { target_width >= n }
        } else if *query == "print" {
            target_media == "print"
        } else {
            true
        };
        if is_active {
            active.push(*name);
        }
    }
    if !active.is_empty() {
        out.push(format!("📐 Active Breakpoints ({target_width}px): {}", active.join(", ")));
    }
    for bp in &active {
        if let Ok(re) = Regex::new(&format!(r"d-{bp}-block|show-{bp}|visible-{bp}")) {
            for id in find_by_class_regex(doc, &re).into_iter().take(5) {
                let content = dom::get_text_stripped(doc, id);
                if !content.is_empty() {
                    out.push(format!("👁️ Visible at {bp}: {}...", take(&content, 100)));
                }
            }
        }
    }
    if out.is_empty() {
        String::new()
    } else {
        format!("\n## 🎯 Media Query Simulation ({target_width}px, {target_media})\n{}\n", out.join("\n"))
    }
}
