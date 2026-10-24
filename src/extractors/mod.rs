//! Content extractors used in "full" render mode: web components, CSS
//! generated content, layout order, ARIA, form validation, dynamic content,
//! MathML/SVG and media-query specific content.

pub mod aria;
pub mod css_generated;
pub mod dynamic_content;
pub mod form_validation;
pub mod layout;
pub mod mathml_svg;
pub mod media_query;
pub mod web_components;

use crate::dom::{self, Document};
use ego_tree::NodeId;

/// Truncate to `n` chars (Python slice semantics on str).
pub(crate) fn take(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Elements whose `class` attribute matches a regex.
pub(crate) fn find_by_class_regex(doc: &Document, re: &regex::Regex) -> Vec<NodeId> {
    dom::find_with_attr(doc, "class")
        .into_iter()
        .filter(|id| dom::attr(doc, *id, "class").map(|c| re.is_match(&c)).unwrap_or(false))
        .collect()
}

/// Classes of an element as a vector.
pub(crate) fn classes(doc: &Document, id: NodeId) -> Vec<String> {
    dom::attr(doc, id, "class").unwrap_or_default().split_whitespace().map(|s| s.to_string()).collect()
}

/// `str.title()` for a single word.
pub(crate) fn title_case(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut new_word = true;
    for ch in s.chars() {
        if ch.is_alphanumeric() {
            if new_word {
                out.extend(ch.to_uppercase());
            } else {
                out.extend(ch.to_lowercase());
            }
            new_word = false;
        } else {
            out.push(ch);
            new_word = true;
        }
    }
    out
}

/// Elements for a simplified CSS selector (`#id`, `.class`, `tag`) with a
/// fallback to real CSS selection for complex selectors.
pub(crate) fn select_elements(doc: &Document, selector: &str) -> Vec<NodeId> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Vec::new();
    }
    if let Some(id) = selector.strip_prefix('#') {
        if !id.contains([' ', '.', ':', '[', '>']) {
            return dom::find_by_id(doc, id).into_iter().collect();
        }
    }
    if let Some(class) = selector.strip_prefix('.') {
        if !class.contains([' ', '.', ':', '[', '>']) {
            return dom::find_by_class(doc, class);
        }
    }
    if selector.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return dom::find_all(doc, &[selector]);
    }
    let found = dom::select(doc, selector);
    if !found.is_empty() {
        return found;
    }
    let tag: String = selector.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    if !tag.is_empty() {
        return dom::find_all(doc, &[&tag]);
    }
    Vec::new()
}

/// Simplified "could this selector match this element" test.
pub(crate) fn selector_matches_element(doc: &Document, selector: &str, id: NodeId) -> bool {
    let tag = dom::tag_name(doc, id).unwrap_or_default();
    if selector == tag {
        return true;
    }
    if let Some(sel_id) = selector.strip_prefix('#') {
        return dom::attr(doc, id, "id").as_deref() == Some(sel_id);
    }
    if let Some(class) = selector.strip_prefix('.') {
        return classes(doc, id).iter().any(|c| c == class);
    }
    selector.contains([' ', '>', '+', '~', ':', '['])
}

/// `#id`, `.a.b` or `tag[index]` identifier for an element.
pub(crate) fn element_identifier(doc: &Document, id: NodeId) -> String {
    if let Some(el_id) = dom::attr(doc, id, "id") {
        return format!("#{el_id}");
    }
    let cls = classes(doc, id);
    if !cls.is_empty() {
        return format!(".{}", cls.iter().take(2).cloned().collect::<Vec<_>>().join("."));
    }
    let tag = dom::tag_name(doc, id).unwrap_or_default();
    if let Some(parent) = dom::parent(doc, id) {
        let siblings: Vec<NodeId> = dom::children(doc, parent).into_iter().filter(|c| dom::tag_name(doc, *c).as_deref() == Some(tag.as_str())).collect();
        let index = siblings.iter().position(|s| *s == id).unwrap_or(0);
        return format!("{tag}[{index}]");
    }
    tag
}
