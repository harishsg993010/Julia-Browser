//! Form Validation Extractor - client-side validation requirements and messages.

use super::{find_by_class_regex, title_case};
use crate::dom::{self, Document};
use ego_tree::NodeId;
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

const MESSAGE_SELECTORS: &[&str] = &[
    ".error", ".invalid", ".validation-error", ".field-error", ".form-error", ".error-message", ".invalid-feedback", "[data-error]",
    "[data-validation]", ".help-block",
];

const INPUT_TYPE_MESSAGES: &[(&str, &str)] = &[
    ("email", "Valid email address required"),
    ("url", "Valid URL required"),
    ("number", "Numeric value required"),
    ("tel", "Valid phone number required"),
    ("date", "Valid date required"),
    ("time", "Valid time required"),
    ("datetime-local", "Valid date and time required"),
    ("month", "Valid month required"),
    ("week", "Valid week required"),
    ("color", "Valid color required"),
];

static HELP_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"help|hint|description|note").unwrap());
static STRENGTH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"password.*strength|strength.*meter").unwrap());
static CONFIRM_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"confirm|repeat").unwrap());
static VALID_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"is-valid|valid").unwrap());
static INVALID_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"is-invalid|invalid").unwrap());

pub fn extract(doc: &Document, js_context: &Value) -> String {
    let mut out = Vec::new();
    out.extend(html5_validation(doc));
    out.extend(visible_messages(doc));
    out.extend(custom_validation(doc));
    out.extend(js_validation(js_context));
    out.extend(constraint_validation(doc));
    if out.is_empty() {
        String::new()
    } else {
        format!("\n## ✅ Form Validation Requirements\n{}\n", out.join("\n"))
    }
}

fn html5_validation(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for id in dom::find_with_attr(doc, "required") {
        let ty = dom::attr(doc, id, "type").unwrap_or_else(|| dom::tag_name(doc, id).unwrap_or_default());
        out.push(format!("⚠️ Required: {} ({})", field_name(doc, id), title_case(&ty)));
    }
    for id in dom::find_with_attr(doc, "pattern") {
        let p = dom::attr(doc, id, "pattern").unwrap_or_default().trim().to_string();
        if !p.is_empty() {
            out.push(format!("🔤 Pattern Required ({}): {p}", field_name(doc, id)));
        }
    }
    for id in dom::find_with_attr(doc, "minlength") {
        out.push(format!("📏 Minimum Length ({}): {} characters", field_name(doc, id), dom::attr(doc, id, "minlength").unwrap_or_default()));
    }
    for id in dom::find_with_attr(doc, "maxlength") {
        out.push(format!("📏 Maximum Length ({}): {} characters", field_name(doc, id), dom::attr(doc, id, "maxlength").unwrap_or_default()));
    }
    for id in dom::find_with_attr(doc, "min") {
        out.push(format!("🔢 Minimum Value ({}): {}", field_name(doc, id), dom::attr(doc, id, "min").unwrap_or_default()));
    }
    for id in dom::find_with_attr(doc, "max") {
        out.push(format!("🔢 Maximum Value ({}): {}", field_name(doc, id), dom::attr(doc, id, "max").unwrap_or_default()));
    }
    for id in dom::find_with_attr(doc, "step") {
        let step = dom::attr(doc, id, "step").unwrap_or_default();
        if step != "any" {
            out.push(format!("📊 Step Increment ({}): {step}", field_name(doc, id)));
        }
    }
    for (ty, message) in INPUT_TYPE_MESSAGES {
        for id in dom::find_all(doc, &["input"]) {
            if dom::attr(doc, id, "type").map(|t| t.eq_ignore_ascii_case(ty)).unwrap_or(false) {
                out.push(format!("🔍 {message} ({})", field_name(doc, id)));
            }
        }
    }
    out
}

fn visible_messages(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for selector in MESSAGE_SELECTORS {
        for id in dom::select(doc, selector) {
            let text = dom::get_text_stripped(doc, id);
            if !text.is_empty() && text.chars().count() < 200 {
                out.push(format!("❌ Validation Error: {text}"));
            }
        }
    }
    for id in dom::find_with_attr(doc, "data-error") {
        let t = dom::attr(doc, id, "data-error").unwrap_or_default().trim().to_string();
        if !t.is_empty() {
            out.push(format!("❌ Field Error: {t}"));
        }
    }
    for id in dom::find_with_attr(doc, "data-validation") {
        let t = dom::attr(doc, id, "data-validation").unwrap_or_default().trim().to_string();
        if !t.is_empty() {
            out.push(format!("✅ Validation Rule: {t}"));
        }
    }
    for id in dom::find_with_attr(doc, "aria-invalid") {
        if dom::attr(doc, id, "aria-invalid").as_deref() != Some("true") {
            continue;
        }
        let target = dom::attr(doc, id, "aria-describedby").unwrap_or_default().trim().to_string();
        if let Some(err) = dom::find_by_id(doc, &target) {
            let text = dom::get_text_stripped(doc, err);
            if !text.is_empty() {
                out.push(format!("❌ {} Error: {text}", field_name(doc, id)));
            }
        }
    }
    out
}

fn custom_validation(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for id in find_by_class_regex(doc, &HELP_RE) {
        let text = dom::get_text_stripped(doc, id);
        let lower = text.to_lowercase();
        if !text.is_empty() && ["required", "format", "characters", "valid", "enter"].iter().any(|w| lower.contains(w)) {
            out.push(format!("💡 Validation Hint: {text}"));
        }
    }
    for id in find_by_class_regex(doc, &STRENGTH_RE) {
        let text = dom::get_text_stripped(doc, id);
        if !text.is_empty() {
            out.push(format!("🔐 Password Strength: {text}"));
        }
    }
    for id in dom::find_with_attr(doc, "name") {
        if CONFIRM_RE.is_match(&dom::attr(doc, id, "name").unwrap_or_default()) {
            out.push(format!("🔁 Confirmation Required: {}", field_name(doc, id)));
        }
    }
    out
}

fn js_validation(ctx: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(msgs) = ctx.get("validation_messages").and_then(Value::as_object) {
        for (field, message) in msgs {
            out.push(format!("🔧 JS Validation ({field}): {}", message.as_str().map(|s| s.to_string()).unwrap_or_else(|| message.to_string())));
        }
    }
    if let Some(validators) = ctx.get("form_validators").and_then(Value::as_array) {
        for v in validators.iter().filter_map(Value::as_str) {
            out.push(format!("🔧 JS Validator: {v}"));
        }
    }
    out
}

fn constraint_validation(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for id in dom::find_with_attr(doc, "data-custom-validity") {
        let m = dom::attr(doc, id, "data-custom-validity").unwrap_or_default().trim().to_string();
        if !m.is_empty() {
            out.push(format!("🎯 Custom Validity ({}): {m}", field_name(doc, id)));
        }
    }
    for id in find_by_class_regex(doc, &VALID_RE) {
        if matches!(dom::tag_name(doc, id).as_deref(), Some("input" | "textarea" | "select")) {
            out.push(format!("✅ Valid Field: {}", field_name(doc, id)));
        }
    }
    for id in find_by_class_regex(doc, &INVALID_RE) {
        if matches!(dom::tag_name(doc, id).as_deref(), Some("input" | "textarea" | "select")) {
            out.push(format!("❌ Invalid Field: {}", field_name(doc, id)));
        }
    }
    out
}

/// Human-readable name for a form field.
pub fn field_name(doc: &Document, id: NodeId) -> String {
    if let Some(l) = dom::attr(doc, id, "aria-label").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return l;
    }
    if let Some(el_id) = dom::attr(doc, id, "id") {
        if let Some(parent) = dom::parent(doc, id) {
            for label in dom::find_all_within(doc, parent, &["label"]) {
                if dom::attr(doc, label, "for").as_deref() == Some(el_id.as_str()) {
                    return dom::get_text_stripped(doc, label);
                }
            }
        }
    }
    if let Some(parent) = dom::find_parent(doc, id, "label") {
        return dom::get_text_stripped(doc, parent);
    }
    if let Some(name) = dom::attr(doc, id, "name").filter(|n| !n.is_empty()) {
        return title_case(&name.replace(['_', '-'], " "));
    }
    if let Some(p) = dom::attr(doc, id, "placeholder").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return p;
    }
    let ty = dom::attr(doc, id, "type").unwrap_or_else(|| dom::tag_name(doc, id).unwrap_or_default());
    format!("{} Field", title_case(&ty))
}
