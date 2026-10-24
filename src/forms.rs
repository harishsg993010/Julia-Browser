//! Interactive Forms Handler - extraction of forms, inputs, buttons and links
//! for the numbered element model used by the CLI and the Agent SDK.

use crate::dom::{self, Document};
use crate::http;
use ego_tree::NodeId;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
pub struct InputInfo {
    pub number: usize,
    pub name: String,
    #[serde(rename = "type")]
    pub input_type: String,
    pub placeholder: String,
    pub value: String,
    pub required: bool,
    /// `input`, `textarea` or `select`
    pub element: String,
    #[serde(skip)]
    pub node: Option<NodeId>,
    #[serde(skip)]
    pub form: Option<NodeId>,
    /// Value typed by the user (CLI `type` command).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_value: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ButtonInfo {
    pub number: usize,
    pub text: String,
    #[serde(rename = "type")]
    pub button_type: String,
    pub name: String,
    pub value: String,
    /// Link target for links / navigation URL for buttons.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip)]
    pub node: Option<NodeId>,
    #[serde(skip)]
    pub form: Option<NodeId>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FormInfo {
    pub number: usize,
    pub action: String,
    pub method: String,
    pub inputs: Vec<InputInfo>,
    pub buttons: Vec<ButtonInfo>,
    #[serde(skip)]
    pub node: NodeId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filled_data: Option<BTreeMap<String, String>>,
}

/// Extracted interactive elements of a page.
#[derive(Debug, Clone, Default, Serialize)]
pub struct InteractiveElements {
    pub forms: Vec<FormInfo>,
    /// Links and buttons outside forms (numbered after form buttons).
    pub buttons: Vec<ButtonInfo>,
    /// Inputs outside forms (numbered after form inputs).
    pub inputs: Vec<InputInfo>,
}

impl InteractiveElements {
    /// All buttons/links in numbering order.
    pub fn all_buttons(&self) -> Vec<ButtonInfo> {
        let mut out: Vec<ButtonInfo> = self.forms.iter().flat_map(|f| f.buttons.clone()).collect();
        out.extend(self.buttons.clone());
        out
    }

    /// All inputs in numbering order.
    pub fn all_inputs(&self) -> Vec<InputInfo> {
        let mut out: Vec<InputInfo> = self.forms.iter().flat_map(|f| f.inputs.clone()).collect();
        out.extend(self.inputs.clone());
        out
    }
}

/// Extract forms, standalone buttons/links and standalone inputs.
pub fn extract_interactive_elements(doc: &Document, base_url: &str) -> InteractiveElements {
    let mut result = InteractiveElements::default();
    let mut button_number = 1;
    let mut input_number = 1;

    for (i, form) in dom::find_all(doc, &["form"]).into_iter().enumerate() {
        let mut info = FormInfo {
            number: i + 1,
            action: dom::attr(doc, form, "action").unwrap_or_default(),
            method: dom::attr(doc, form, "method").unwrap_or_else(|| "GET".into()).to_ascii_uppercase(),
            inputs: Vec::new(),
            buttons: Vec::new(),
            node: form,
            filled_data: None,
        };
        for el in dom::find_all_within(doc, form, &["input", "textarea", "select"]) {
            if let Some(mut inp) = extract_input_data(doc, el) {
                inp.number = input_number;
                inp.form = Some(form);
                input_number += 1;
                info.inputs.push(inp);
            }
        }
        for el in dom::find_all_within(doc, form, &["button", "input"]) {
            let tag = dom::tag_name(doc, el).unwrap_or_default();
            let is_button = tag == "button" || matches!(dom::attr(doc, el, "type").map(|t| t.to_ascii_lowercase()).as_deref(), Some("submit" | "button" | "reset" | "image"));
            if !is_button {
                continue;
            }
            let mut btn = extract_button_data(doc, el);
            btn.number = button_number;
            btn.form = Some(form);
            button_number += 1;
            info.buttons.push(btn);
        }
        result.forms.push(info);
    }

    for el in dom::find_all(doc, &["button", "a"]) {
        let tag = dom::tag_name(doc, el).unwrap_or_default();
        if tag == "a" {
            if let Some(href) = dom::attr(doc, el, "href") {
                let text = dom::get_text_stripped(doc, el);
                result.buttons.push(ButtonInfo {
                    number: button_number,
                    text: if text.is_empty() { "Link".into() } else { text },
                    button_type: "link".into(),
                    name: String::new(),
                    value: String::new(),
                    action: Some(http::urljoin(base_url, &href)),
                    node: Some(el),
                    form: None,
                });
                button_number += 1;
            }
        } else if dom::find_parent(doc, el, "form").is_none() {
            let mut btn = extract_button_data(doc, el);
            btn.number = button_number;
            button_number += 1;
            result.buttons.push(btn);
        }
    }

    for el in dom::find_all(doc, &["input", "textarea", "select"]) {
        if dom::find_parent(doc, el, "form").is_some() {
            continue;
        }
        if let Some(mut inp) = extract_input_data(doc, el) {
            inp.number = input_number;
            input_number += 1;
            result.inputs.push(inp);
        }
    }
    result
}

fn extract_input_data(doc: &Document, el: NodeId) -> Option<InputInfo> {
    let tag = dom::tag_name(doc, el)?;
    let input_type = if tag == "input" { dom::attr(doc, el, "type").unwrap_or_else(|| "text".into()).to_ascii_lowercase() } else { tag.clone() };
    if matches!(input_type.as_str(), "hidden" | "submit" | "button" | "reset" | "image") {
        return None;
    }
    let value = if tag == "textarea" {
        dom::get_text_stripped(doc, el)
    } else if tag == "select" {
        let options = dom::find_all_within(doc, el, &["option"]);
        options
            .iter()
            .find(|o| dom::has_attr(doc, **o, "selected"))
            .or(options.first())
            .map(|o| dom::attr(doc, *o, "value").unwrap_or_else(|| dom::get_text_stripped(doc, *o)))
            .unwrap_or_default()
    } else {
        let v = dom::attr(doc, el, "value").unwrap_or_default();
        if input_type == "password" && !v.is_empty() { "••••••••".into() } else { v }
    };
    Some(InputInfo {
        number: 0,
        name: dom::attr(doc, el, "name").unwrap_or_default(),
        input_type,
        placeholder: dom::attr(doc, el, "placeholder").unwrap_or_default(),
        value,
        required: dom::has_attr(doc, el, "required"),
        element: tag,
        node: Some(el),
        form: None,
        current_value: None,
    })
}

/// Human-readable label for a button: visible text, then `aria-label`,
/// `title`, `value`, the label of a contained `<img alt>`/`<svg><title>`, else "Button".
pub fn button_label(doc: &Document, el: NodeId) -> String {
    let text = dom::get_text_stripped(doc, el);
    if !text.is_empty() {
        return text;
    }
    for attr in ["aria-label", "title", "value", "data-testid"] {
        if let Some(v) = dom::attr(doc, el, attr).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            return v;
        }
    }
    for img in dom::find_all_within(doc, el, &["img"]) {
        if let Some(alt) = dom::attr(doc, img, "alt").filter(|a| !a.trim().is_empty()) {
            return alt;
        }
    }
    if let Some(labelled_by) = dom::attr(doc, el, "aria-labelledby") {
        if let Some(target) = dom::find_by_id(doc, labelled_by.trim()) {
            let t = dom::get_text_stripped(doc, target);
            if !t.is_empty() {
                return t;
            }
        }
    }
    "Button".into()
}

fn extract_button_data(doc: &Document, el: NodeId) -> ButtonInfo {
    let tag = dom::tag_name(doc, el).unwrap_or_default();
    let (button_type, text) = if tag == "input" {
        let t = dom::attr(doc, el, "type").unwrap_or_else(|| "button".into()).to_ascii_lowercase();
        let text = dom::attr(doc, el, "value")
            .or_else(|| dom::attr(doc, el, "aria-label"))
            .unwrap_or_else(|| format!("{} Button", crate::extractors::title_case(&t)));
        (t, text)
    } else {
        // A <button> without an explicit type is a submit button when inside a form.
        let default_type = if dom::find_parent(doc, el, "form").is_some() { "submit" } else { "button" };
        let t = dom::attr(doc, el, "type").unwrap_or_else(|| default_type.into()).to_ascii_lowercase();
        (t, button_label(doc, el))
    };
    ButtonInfo {
        number: 0,
        text,
        button_type,
        name: dom::attr(doc, el, "name").unwrap_or_default(),
        value: dom::attr(doc, el, "value").unwrap_or_default(),
        action: extract_button_navigation_url(doc, el),
        node: Some(el),
        form: dom::find_parent(doc, el, "form"),
    }
}

/// Where a button navigates to, if that can be inferred from the markup.
pub fn extract_button_navigation_url(doc: &Document, button: NodeId) -> Option<String> {
    if let Some(onclick) = dom::attr(doc, button, "onclick") {
        let patterns = [
            r#"(?:location\.href|window\.location)\s*=\s*['"]([^'"]+)['"]"#,
            r#"(?:location\.replace|location\.assign)\(['"]([^'"]+)['"]\)"#,
            r#"window\.open\(['"]([^'"]+)['"]"#,
            r#"(?:href\s*=|url\s*=)\s*['"]([^'"]+)['"]"#,
        ];
        for p in patterns {
            if let Some(c) = regex::Regex::new(p).ok().and_then(|re| re.captures(&onclick)) {
                return Some(c[1].to_string());
            }
        }
    }
    for attr in ["data-href", "data-url", "data-link", "data-action", "data-navigate", "data-goto", "data-redirect"] {
        if let Some(v) = dom::attr(doc, button, attr).filter(|v| !v.is_empty()) {
            return Some(v);
        }
    }
    if let Some(a) = dom::find_parent(doc, button, "a") {
        if let Some(h) = dom::attr(doc, a, "href") {
            return Some(h);
        }
    }
    if let Some(sib) = dom::find_next_sibling(doc, button, "a") {
        if let Some(h) = dom::attr(doc, sib, "href") {
            return Some(h);
        }
    }
    if let Some(form) = dom::find_parent(doc, button, "form") {
        if dom::attr(doc, button, "type").as_deref() == Some("button") {
            if let Some(action) = dom::attr(doc, form, "action").filter(|a| !a.is_empty()) {
                return Some(action);
            }
        }
    }
    let text = dom::get_text_stripped(doc, button).to_lowercase();
    let keywords = ["login", "log in", "sign in", "sign up", "register", "download", "get started", "learn more"];
    if keywords.iter().any(|k| text.contains(k)) {
        for a in dom::find_all(doc, &["a"]) {
            let link_text = dom::get_text_stripped(doc, a).to_lowercase();
            if !link_text.is_empty() && (link_text.contains(&text) || text.contains(&link_text)) {
                if let Some(h) = dom::attr(doc, a, "href") {
                    return Some(h);
                }
            }
        }
    }
    None
}

/// Collect a form's field values (defaults merged with typed values).
pub fn collect_form_data(doc: &Document, form: NodeId, typed: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut data = typed.clone();
    for el in dom::find_all_within(doc, form, &["input", "textarea", "select"]) {
        let name = match dom::attr(doc, el, "name") {
            Some(n) if !n.is_empty() => n,
            _ => continue,
        };
        if data.contains_key(&name) {
            continue;
        }
        let tag = dom::tag_name(doc, el).unwrap_or_default();
        let ty = dom::attr(doc, el, "type").unwrap_or_else(|| "text".into()).to_ascii_lowercase();
        if matches!(ty.as_str(), "submit" | "button" | "reset" | "image" | "file") {
            continue;
        }
        if matches!(ty.as_str(), "checkbox" | "radio") && !dom::has_attr(doc, el, "checked") {
            continue;
        }
        let value = if tag == "textarea" {
            dom::get_text(doc, el)
        } else if tag == "select" {
            let options = dom::find_all_within(doc, el, &["option"]);
            match options.iter().find(|o| dom::has_attr(doc, **o, "selected")).or(options.first()) {
                Some(o) => dom::attr(doc, *o, "value").unwrap_or_else(|| dom::get_text_stripped(doc, *o)),
                None => String::new(),
            }
        } else {
            dom::attr(doc, el, "value").unwrap_or_else(|| if matches!(ty.as_str(), "checkbox" | "radio") { "on".into() } else { String::new() })
        };
        data.insert(name, value);
    }
    data
}

/// Resolve a form action against the page URL (handles `//`, `/`, `?` and relative forms).
pub fn resolve_form_action(action: &str, current_url: &str) -> String {
    let action = action.trim();
    if action.is_empty() {
        return current_url.to_string();
    }
    if action.starts_with("http://") || action.starts_with("https://") {
        return action.to_string();
    }
    let base = http::normalize_url(current_url);
    if action.starts_with("//") {
        let scheme = url::Url::parse(&base).map(|u| u.scheme().to_string()).unwrap_or_else(|_| "https".into());
        return format!("{scheme}:{action}");
    }
    http::urljoin(&base, action)
}

pub fn validate_email(email: &str) -> bool {
    regex::Regex::new(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$").map(|re| re.is_match(email)).unwrap_or(false)
}
