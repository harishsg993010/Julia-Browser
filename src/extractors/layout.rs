//! CSS Layout Calculator - reading order for Grid/Flexbox containers.
//!
//! Unlike the original (whose reordering hooks were placeholders) the Rust
//! version actually reorders container children by the CSS `order` property
//! and reverses `*-reverse` flex directions before markdown conversion.

use super::{element_identifier, select_elements, selector_matches_element, take};
use crate::css_parser::CssRules;
use crate::dom::{self, Document};
use ego_tree::NodeId;
use std::collections::BTreeMap;

/// `{container_key: ["identifier: text", ...]}`. Keys are `grid-<id>`,
/// `flex-<id>` or `css-order`.
pub type LayoutOrders = BTreeMap<String, Vec<String>>;

/// Internal reorder plan captured alongside the human readable orders.
#[derive(Default)]
struct Plan {
    /// container id -> ordered child ids
    containers: Vec<(NodeId, Vec<NodeId>)>,
}

pub fn calculate_layout_order(doc: &Document, css_rules: Option<&CssRules>) -> LayoutOrders {
    let rules = match css_rules {
        Some(r) if !r.is_empty() => r,
        _ => return LayoutOrders::new(),
    };
    let mut orders = LayoutOrders::new();
    for container in find_containers(doc, rules, &["grid", "inline-grid"]) {
        let (order, _) = calculate_order(doc, container, rules, false);
        if !order.is_empty() {
            orders.insert(format!("grid-{}", element_identifier(doc, container)), order);
        }
    }
    for container in find_containers(doc, rules, &["flex", "inline-flex"]) {
        let reverse = flex_direction(doc, container, rules).contains("reverse");
        let (order, _) = calculate_order(doc, container, rules, reverse);
        if !order.is_empty() {
            orders.insert(format!("flex-{}", element_identifier(doc, container)), order);
        }
    }
    let ordered = css_order_effects(doc, rules);
    if !ordered.is_empty() {
        orders.insert("css-order".into(), ordered.into_iter().map(|(k, v)| format!("{k}: {v}")).collect());
    }
    orders
}

/// Reorder the DOM according to computed layout order. `layout_orders` is used
/// only as a signal; the actual plan is recomputed from the document so the
/// node ids are valid for this tree.
pub fn apply_layout_order(doc: &mut Document, layout_orders: &LayoutOrders) {
    if layout_orders.is_empty() {
        return;
    }
    let plan = build_plan(doc);
    for (container, ordered_children) in plan.containers {
        let current = dom::children(doc, container);
        if current == ordered_children {
            continue;
        }
        for child in ordered_children {
            if let Some(mut node) = doc.tree.get_mut(container) {
                node.append_id(child);
            }
        }
    }
}

fn build_plan(doc: &Document) -> Plan {
    // Reordering needs the same rules the orders were computed with; we
    // re-derive from inline styles (the only rule source that survives the
    // document copy) so this stays self-contained.
    let mut plan = Plan::default();
    for id in dom::find_with_attr(doc, "style") {
        let style = dom::attr(doc, id, "style").unwrap_or_default();
        let props = crate::css_parser::parse_css_properties(&style);
        let display = props.get("display").map(|s| s.as_str()).unwrap_or("");
        if !matches!(display, "flex" | "inline-flex" | "grid" | "inline-grid") {
            continue;
        }
        let reverse = props.get("flex-direction").map(|d| d.contains("reverse")).unwrap_or(false);
        let mut children: Vec<(i64, usize, NodeId)> = dom::children(doc, id)
            .into_iter()
            .enumerate()
            .map(|(i, c)| {
                let cstyle = dom::attr(doc, c, "style").unwrap_or_default();
                let order = crate::css_parser::parse_css_properties(&cstyle).get("order").and_then(|o| o.parse().ok()).unwrap_or(0);
                (order, i, c)
            })
            .collect();
        children.sort();
        let mut ids: Vec<NodeId> = children.into_iter().map(|(_, _, c)| c).collect();
        if reverse {
            ids.reverse();
        }
        plan.containers.push((id, ids));
    }
    plan
}

fn find_containers(doc: &Document, rules: &CssRules, displays: &[&str]) -> Vec<NodeId> {
    let mut out = Vec::new();
    for (selector, props) in rules {
        if props.get("display").map(|d| displays.contains(&d.as_str())).unwrap_or(false) {
            for id in select_elements(doc, selector) {
                if !out.contains(&id) {
                    out.push(id);
                }
            }
        }
    }
    out
}

fn calculate_order(doc: &Document, container: NodeId, rules: &CssRules, reverse: bool) -> (Vec<String>, Vec<NodeId>) {
    let mut items: Vec<(i64, usize, NodeId, String)> = dom::children(doc, container)
        .into_iter()
        .enumerate()
        .map(|(i, c)| (css_order(doc, c, rules), i, c, take(&dom::get_text_stripped(doc, c), 50)))
        .collect();
    items.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
    if reverse {
        items.reverse();
    }
    let ids = items.iter().map(|(_, _, id, _)| *id).collect();
    let text = items.into_iter().filter(|(_, _, _, t)| !t.is_empty()).map(|(_, _, id, t)| format!("{}: {t}", element_identifier(doc, id))).collect();
    (text, ids)
}

fn css_order_effects(doc: &Document, rules: &CssRules) -> BTreeMap<String, i64> {
    let mut out = BTreeMap::new();
    for (selector, props) in rules {
        if let Some(order) = props.get("order").and_then(|o| o.parse::<i64>().ok()) {
            for id in select_elements(doc, selector) {
                out.insert(element_identifier(doc, id), order);
            }
        }
    }
    out
}

fn flex_direction(doc: &Document, container: NodeId, rules: &CssRules) -> String {
    for (selector, props) in rules {
        if selector_matches_element(doc, selector, container) {
            if let Some(d) = props.get("flex-direction") {
                return d.clone();
            }
        }
    }
    "row".into()
}

fn css_order(doc: &Document, id: NodeId, rules: &CssRules) -> i64 {
    for (selector, props) in rules {
        if selector_matches_element(doc, selector, id) {
            if let Some(o) = props.get("order").and_then(|o| o.parse().ok()) {
                return o;
            }
        }
    }
    0
}

/// Human readable summary for debugging.
pub fn layout_summary(orders: &LayoutOrders) -> String {
    if orders.is_empty() {
        return "No layout calculations performed".into();
    }
    let mut out = Vec::new();
    for (container, elements) in orders {
        out.push(format!("{} Layout:", super::title_case(container)));
        for (i, e) in elements.iter().take(5).enumerate() {
            out.push(format!("  {}. {e}", i + 1));
        }
        if elements.len() > 5 {
            out.push(format!("  ... and {} more elements", elements.len() - 5));
        }
        out.push(String::new());
    }
    out.join("\n")
}
