//! CSS Generated Content Extractor - text from `::before`/`::after`, counters,
//! `attr()` and list markers.

use super::{select_elements, selector_matches_element, take};
use crate::css_parser::CssRules;
use crate::dom::{self, Document};
use ego_tree::NodeId;
use regex::Regex;
use std::collections::BTreeMap;
use std::sync::LazyLock;

static COUNTER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"counter\(\s*([^)]+)\s*\)").unwrap());
static ATTR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"attr\(\s*([^)]+)\s*\)").unwrap());
static QUOTED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"["']([^"']*)["']"#).unwrap());
static HEX_ESC_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\([0-9A-Fa-f]{1,6})").unwrap());

pub fn extract(doc: &Document, css_rules: Option<&CssRules>) -> String {
    let rules = match css_rules {
        Some(r) if !r.is_empty() => r,
        _ => return String::new(),
    };
    let mut out = Vec::new();
    out.extend(pseudo_element_content(doc, rules));
    out.extend(counter_content(doc, rules));
    out.extend(attr_content(doc, rules));
    out.extend(list_marker_content(doc, rules));
    out.join("\n")
}

fn strip_pseudo(selector: &str) -> String {
    selector.replace("::before", "").replace(":before", "").replace("::after", "").replace(":after", "")
}

fn pseudo_element_content(doc: &Document, rules: &CssRules) -> Vec<String> {
    let mut out = Vec::new();
    for (selector, props) in rules {
        let is_before = selector.contains("::before") || selector.contains(":before");
        let is_after = selector.contains("::after") || selector.contains(":after");
        if !is_before && !is_after {
            continue;
        }
        let content = match props.get("content") {
            Some(c) => clean_css_content_value(c),
            None => continue,
        };
        if content.is_empty() {
            continue;
        }
        let label = if is_before { "Before" } else { "After" };
        for id in select_elements(doc, &strip_pseudo(selector)) {
            out.push(format!("{label} {}: {content}", describe_element(doc, id)));
        }
    }
    out
}

fn counter_content(doc: &Document, rules: &CssRules) -> Vec<String> {
    let mut out = Vec::new();
    let mut values: BTreeMap<String, i64> = BTreeMap::new();
    for props in rules.values() {
        if let Some(reset) = props.get("counter-reset") {
            let name = reset.trim();
            if !name.is_empty() && name != "none" {
                values.insert(name.to_string(), 0);
            }
        }
        if let Some(inc) = props.get("counter-increment") {
            *values.entry(inc.trim().to_string()).or_insert(0) += 1;
        }
    }
    for (selector, props) in rules {
        if let Some(content) = props.get("content") {
            for cap in COUNTER_RE.captures_iter(content) {
                let parts: Vec<String> = cap[1].split(',').map(|p| p.trim().trim_matches(['"', '\'']).to_string()).collect();
                let name = &parts[0];
                let style = parts.get(1).cloned().unwrap_or_else(|| "decimal".into());
                if let Some(v) = values.get(name) {
                    let formatted = format_counter_value(*v, &style);
                    for id in select_elements(doc, &strip_pseudo(selector)) {
                        out.push(format!("Counter {}: {formatted}", describe_element(doc, id)));
                    }
                }
            }
        }
    }
    out
}

fn attr_content(doc: &Document, rules: &CssRules) -> Vec<String> {
    let mut out = Vec::new();
    for (selector, props) in rules {
        if let Some(content) = props.get("content") {
            for cap in ATTR_RE.captures_iter(content) {
                let attr_name = cap[1].trim().trim_matches(['"', '\'']).to_string();
                let pseudo = if selector.contains("::before") || selector.contains(":before") { "Before" } else { "After" };
                for id in select_elements(doc, &strip_pseudo(selector)) {
                    if let Some(v) = dom::attr(doc, id, &attr_name).filter(|v| !v.is_empty()) {
                        out.push(format!("{pseudo} {} ({attr_name}): {v}", describe_element(doc, id)));
                    }
                }
            }
        }
    }
    out
}

fn list_marker_content(doc: &Document, rules: &CssRules) -> Vec<String> {
    let mut out = Vec::new();
    for list in dom::find_all(doc, &["ul", "ol"]) {
        let style = list_style_for_element(doc, list, rules);
        if !matches!(style.as_str(), "disc" | "circle" | "square" | "decimal" | "none") {
            for (i, item) in dom::find_all_within(doc, list, &["li"]).into_iter().enumerate() {
                let marker = generate_list_marker(i as i64 + 1, &style);
                if !marker.is_empty() {
                    out.push(format!("List marker: {marker} ({}...)", take(&dom::get_text_stripped(doc, item), 50)));
                }
            }
        }
    }
    for (selector, props) in rules {
        if selector.contains("::marker") {
            if let Some(content) = props.get("content") {
                let marker = clean_css_content_value(content);
                for id in select_elements(doc, &selector.replace("::marker", "")) {
                    out.push(format!("Custom marker {}: {marker}", describe_element(doc, id)));
                }
            }
        }
    }
    out
}

/// Clean a CSS `content` value and extract its text.
pub fn clean_css_content_value(value: &str) -> String {
    let cleaned = value.trim().trim_matches(['"', '\'']).to_string();
    if matches!(cleaned.as_str(), "none" | "normal" | "initial" | "inherit" | "unset") {
        return String::new();
    }
    let parts: Vec<String> = QUOTED_RE.captures_iter(value).map(|c| c[1].to_string()).collect();
    if !parts.is_empty() {
        return parts.concat();
    }
    let cleaned = cleaned.replace("\\A", "\n").replace("\\D", "\r");
    HEX_ESC_RE
        .replace_all(&cleaned, |c: &regex::Captures| {
            u32::from_str_radix(&c[1], 16).ok().and_then(char::from_u32).map(|ch| ch.to_string()).unwrap_or_default()
        })
        .to_string()
}

fn describe_element(doc: &Document, id: NodeId) -> String {
    let mut parts = vec![format!("<{}>", dom::tag_name(doc, id).unwrap_or_default())];
    if let Some(el_id) = dom::attr(doc, id, "id") {
        parts.push(format!("#{el_id}"));
    }
    let classes = super::classes(doc, id);
    if !classes.is_empty() {
        parts.push(format!(".{}", classes.iter().take(2).cloned().collect::<Vec<_>>().join(".")));
    }
    let text = take(&dom::get_text_stripped(doc, id), 30);
    if !text.is_empty() {
        parts.push(format!("\"{text}...\""));
    }
    parts.join(" ")
}

fn list_style_for_element(doc: &Document, id: NodeId, rules: &CssRules) -> String {
    for (selector, props) in rules {
        if let Some(style) = props.get("list-style-type") {
            if selector_matches_element(doc, selector, id) && !selector.contains([' ', '>', ':', '[']) {
                return style.clone();
            }
        }
    }
    match dom::tag_name(doc, id).as_deref() {
        Some("ol") => "decimal".into(),
        _ => "disc".into(),
    }
}

fn generate_list_marker(index: i64, style: &str) -> String {
    match style {
        "decimal" => index.to_string(),
        "lower-roman" => to_roman(index).to_lowercase(),
        "upper-roman" => to_roman(index),
        "lower-alpha" | "lower-latin" => ((b'a' + ((index - 1) % 26) as u8) as char).to_string(),
        "upper-alpha" | "upper-latin" => ((b'A' + ((index - 1) % 26) as u8) as char).to_string(),
        "disc" => "•".into(),
        "circle" => "○".into(),
        "square" => "■".into(),
        _ => index.to_string(),
    }
}

fn to_roman(mut num: i64) -> String {
    if num <= 0 {
        return num.to_string();
    }
    const VALUES: [(i64, &str); 13] = [
        (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"), (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
    ];
    let mut out = String::new();
    for (v, s) in VALUES {
        while num >= v {
            out.push_str(s);
            num -= v;
        }
    }
    out
}

fn format_counter_value(value: i64, style: &str) -> String {
    match style {
        "lower-roman" => to_roman(value).to_lowercase(),
        "upper-roman" => to_roman(value),
        "lower-alpha" => ((b'a' + ((value - 1).rem_euclid(26)) as u8) as char).to_string(),
        "upper-alpha" => ((b'A' + ((value - 1).rem_euclid(26)) as u8) as char).to_string(),
        _ => value.to_string(),
    }
}
