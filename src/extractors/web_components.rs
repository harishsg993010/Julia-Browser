//! Web Components Content Extractor - text from Shadow DOM, custom elements,
//! templates and slots.

use super::take;
use crate::dom::{self, Document};
use ego_tree::NodeId;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;

static SHADOW_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        Regex::new(r#"(?i)shadowRoot\.innerHTML\s*=\s*['"`]([^'"`]+)['"`]"#).unwrap(),
        Regex::new(r#"(?i)shadow\.textContent\s*=\s*['"`]([^'"`]+)['"`]"#).unwrap(),
        Regex::new(r#"(?i)attachShadow.*?innerHTML.*?['"`]([^'"`]+)['"`]"#).unwrap(),
    ]
});
static CUSTOM_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        Regex::new(r#"(?i)customElements\.define\(['"`]([^'"`]+)['"`].*?innerHTML.*?['"`]([^'"`]+)['"`]"#).unwrap(),
        Regex::new(r#"(?i)connectedCallback.*?textContent.*?['"`]([^'"`]+)['"`]"#).unwrap(),
    ]
});

/// Extract all content from Web Components, Shadow DOM and custom elements.
pub fn extract(doc: &Document, js_context: Option<&Value>) -> String {
    let mut parts = Vec::new();
    if let Some(ctx) = js_context {
        let s = extract_shadow_dom_from_js(ctx);
        if !s.is_empty() {
            parts.push(s);
        }
    }
    for id in find_custom_elements(doc) {
        let c = extract_custom_element_content(doc, id, js_context);
        if !c.is_empty() {
            parts.push(c);
        }
    }
    for s in [extract_template_content(doc), extract_slot_content(doc), extract_declarative_shadow_dom(doc)] {
        if !s.is_empty() {
            parts.push(s);
        }
    }
    parts.join("\n\n")
}

fn extract_shadow_dom_from_js(ctx: &Value) -> String {
    let mut out = Vec::new();
    if let Some(logs) = ctx.get("console_output").and_then(Value::as_array) {
        for log in logs {
            let s = match log {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            if s.contains("attachShadow") || s.contains("shadowRoot") {
                for re in SHADOW_PATTERNS.iter() {
                    if let Some(c) = re.captures(&s) {
                        out.push(c[1].to_string());
                        break;
                    }
                }
            }
            if s.contains("customElements.define") {
                for re in CUSTOM_PATTERNS.iter() {
                    if let Some(c) = re.captures(&s) {
                        out.push(match c.get(2) {
                            Some(m) => format!("{}: {}", &c[1], m.as_str()),
                            None => c[1].to_string(),
                        });
                        break;
                    }
                }
            }
        }
    }
    if let Some(mods) = ctx.get("dom_modifications").and_then(Value::as_object) {
        for (element_id, changes) in mods {
            if changes.to_string().contains("shadowRoot") {
                let text = shadow_text_from_changes(changes);
                if !text.is_empty() {
                    out.push(format!("Shadow DOM ({element_id}): {text}"));
                }
            }
        }
    }
    out.join("\n")
}

fn find_custom_elements(doc: &Document) -> Vec<NodeId> {
    let mut out = Vec::new();
    for id in dom::find_all(doc, &[]) {
        let tag = dom::tag_name(doc, id).unwrap_or_default();
        if tag.contains('-') {
            out.push(id);
        }
    }
    for id in dom::find_all(doc, &[]) {
        if dom::has_attr(doc, id, "is") || dom::has_attr(doc, id, "data-shadow-host") || dom::has_attr(doc, id, "shadowroot") {
            if !out.contains(&id) {
                out.push(id);
            }
        }
    }
    out
}

fn extract_custom_element_content(doc: &Document, id: NodeId, js_context: Option<&Value>) -> String {
    let mut parts = Vec::new();
    let visible = dom::get_text_stripped(doc, id);
    if !visible.is_empty() {
        parts.push(format!("Visible: {visible}"));
    }
    let mut data_attrs = serde_json::Map::new();
    if let Some(node) = doc.tree.get(id) {
        if let Some(el) = node.value().as_element() {
            for (name, value) in el.attrs() {
                if name.starts_with("data-") {
                    data_attrs.insert(name.to_string(), json!(value));
                }
            }
        }
    }
    if !data_attrs.is_empty() {
        parts.push(format!("Data: {}", serde_json::to_string_pretty(&Value::Object(data_attrs)).unwrap_or_default()));
    }
    for attr in ["title", "alt", "aria-label", "aria-describedby", "placeholder"] {
        if let Some(v) = dom::attr(doc, id, attr).filter(|v| !v.is_empty()) {
            parts.push(format!("{}: {v}", super::title_case(attr)));
        }
    }
    if let (Some(ctx), Some(el_id)) = (js_context, dom::attr(doc, id, "id")) {
        let js = element_content_from_js(&el_id, ctx);
        if !js.is_empty() {
            parts.push(format!("JS Content: {js}"));
        }
    }
    if parts.is_empty() {
        return String::new();
    }
    format!("Custom Element <{}>:\n{}", dom::tag_name(doc, id).unwrap_or_default(), parts.join("\n"))
}

fn extract_template_content(doc: &Document) -> String {
    let mut out = Vec::new();
    for (i, id) in dom::find_all(doc, &["template"]).into_iter().enumerate() {
        let text = dom::get_text_sep(doc, id, " ", true);
        if !text.is_empty() {
            let tid = dom::attr(doc, id, "id").unwrap_or_else(|| format!("template-{}", i + 1));
            out.push(format!("Template ({tid}): {text}"));
        }
    }
    out.join("\n")
}

fn extract_slot_content(doc: &Document) -> String {
    let mut out = Vec::new();
    for id in dom::find_all(doc, &["slot"]) {
        let name = dom::attr(doc, id, "name").unwrap_or_else(|| "default".into());
        let text = dom::get_text_stripped(doc, id);
        if !text.is_empty() {
            out.push(format!("Slot ({name}): {text}"));
        } else {
            let fallback = dom::inner_html(doc, id);
            if !fallback.trim().is_empty() {
                out.push(format!("Slot Fallback ({name}): {}", fallback.trim()));
            }
        }
    }
    for id in dom::find_with_attr(doc, "slot") {
        let name = dom::attr(doc, id, "slot").unwrap_or_default();
        let text = dom::get_text_stripped(doc, id);
        if !text.is_empty() {
            out.push(format!("Slotted Content ({name}): {text}"));
        }
    }
    out.join("\n")
}

fn extract_declarative_shadow_dom(doc: &Document) -> String {
    let mut out = Vec::new();
    for id in dom::find_all(doc, &["template"]) {
        if let Some(mode) = dom::attr(doc, id, "shadowrootmode") {
            let mode = if mode.is_empty() { "open".to_string() } else { mode };
            let text = dom::get_text_sep(doc, id, " ", true);
            if !text.is_empty() {
                out.push(format!("Declarative Shadow DOM ({mode}): {text}"));
            }
        }
    }
    out.join("\n")
}

fn shadow_text_from_changes(changes: &Value) -> String {
    let mut out = Vec::new();
    if let Some(obj) = changes.as_object() {
        for (_, data) in obj {
            if let Some(d) = data.as_object() {
                if let Some(t) = d.get("textContent") {
                    out.push(t.as_str().map(|s| s.to_string()).unwrap_or_else(|| t.to_string()));
                }
                if let Some(h) = d.get("innerHTML") {
                    let frag = dom::parse_fragment(h.as_str().unwrap_or(""));
                    let text = dom::get_text_sep(&frag, frag.tree.root().id(), " ", true);
                    if !text.is_empty() {
                        out.push(text);
                    }
                }
            }
        }
        // Top-level textContent / innerHTML too.
        if let Some(t) = obj.get("textContent") {
            out.push(t.as_str().map(|s| s.to_string()).unwrap_or_else(|| t.to_string()));
        }
    }
    out.join(" ")
}

fn element_content_from_js(element_id: &str, ctx: &Value) -> String {
    if let Some(changes) = ctx.get("dom_modifications").and_then(|m| m.get(element_id)) {
        let text = shadow_text_from_changes(&json!({ element_id: changes }));
        if !text.is_empty() {
            return text;
        }
    }
    if let Some(logs) = ctx.get("console_output").and_then(Value::as_array) {
        let re = Regex::new(&format!(r#"{}.*?['"`]([^'"`]+)['"`]"#, regex::escape(element_id))).ok();
        for log in logs {
            let s = log.as_str().map(|s| s.to_string()).unwrap_or_else(|| log.to_string());
            if s.contains(element_id) {
                if let Some(c) = re.as_ref().and_then(|r| r.captures(&s)) {
                    return take(&c[1], 500);
                }
            }
        }
    }
    String::new()
}
