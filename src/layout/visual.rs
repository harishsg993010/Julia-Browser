//! Visual-order rendering.
//!
//! The Markdown converter walks the document in DOM order. With a layout
//! available, this pass first rewrites a copy of the document so that DOM
//! order *is* visual order: content nobody can see is removed, fixed and
//! high-z overlays (modals, cookie banners) are moved to the front, block
//! children are sorted by their boxes (top to bottom, left to right), columns
//! that sit side by side are separated and labelled by their landmark, and
//! rows of equal-width cards become lists. Inline content, tables and lists
//! keep their DOM order. When the boxes look unreliable (fonts missing, most
//! text boxes empty) the pass declines and the DOM-order renderer is used.

use super::{BoxInfo, Position, Rect};
use crate::dom::{self, Document, RAW_MARKDOWN_ATTR};
use ego_tree::NodeId;
use std::collections::HashMap;

/// How the pass should order things.
#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// Viewport size in CSS px (overlay detection is relative to it).
    pub viewport: (f64, f64),
    /// Put the main column before the sidebars in a multi-column row.
    pub reader: bool,
}

/// Elements whose contents are rendered as a unit by the Markdown converter
/// or the form widgets: never descended into.
const OPAQUE: &[&str] = &[
    "select", "datalist", "template", "svg", "math", "head", "noscript", "object", "video", "audio", "picture", "iframe", "textarea",
    "script", "style", "pre", "table", "input", "img", "canvas", "embed",
];
/// Containers whose children are hidden but never reordered.
const NO_REORDER: &[&str] = &["ul", "ol", "dl", "menu", "p", "h1", "h2", "h3", "h4", "h5", "h6", "a", "button", "label", "blockquote", "figure", "details", "summary", "dialog", "fieldset", "jb-shadow-root"];
/// Elements kept even without a box of their own (they have no size but a
/// visible effect, or their size is only known once the resource loads).
const KEEP_WITHOUT_BOX: &[&str] = &["br", "wbr", "img", "picture", "video", "canvas", "svg", "iframe", "object", "embed", "input", "select", "textarea", "button", "hr"];

/// The largest share of text-bearing elements that may have an empty box
/// before the layout is considered unusable.
const MAX_EMPTY_TEXT_SHARE: f64 = 0.3;
/// Minimum size and text of a box that counts as a column (side-by-side
/// buttons or icons are not columns).
const MIN_COLUMN_WIDTH: f64 = 100.0;
const MIN_COLUMN_HEIGHT: f64 = 120.0;
const MIN_COLUMN_TEXT: usize = 10;
/// Minimum width of a card.
const MIN_CARD_WIDTH: f64 = 100.0;
/// Members of a row whose widths are within this ratio are "cards".
const CARD_WIDTH_RATIO: f64 = 1.15;
/// Longest card text that still renders as a list item.
const MAX_CARD_TEXT: usize = 600;
/// A fixed element at the top edge no taller than this is a bar, not an overlay.
const MAX_BAR_HEIGHT: f64 = 160.0;
/// Smaller fixed elements are decorations, not overlays.
const MIN_OVERLAY_SIZE: f64 = 24.0;
/// Boxes whose edges are this close count as aligned (icons next to labels).
const ALIGN_TOLERANCE: f64 = 4.0;

#[derive(Debug, Clone, Default)]
struct Facts {
    /// Union of every visible box in the subtree, `None` when nothing is visible.
    extent: Option<Rect>,
    hidden: bool,
    text_len: usize,
    /// The element has a non-whitespace text node child.
    text_bearing: bool,
}

struct Pass<'a> {
    boxes: &'a HashMap<NodeId, BoxInfo>,
    opts: Options,
    facts: HashMap<NodeId, Facts>,
    /// Overlays moved to the front of the body; they stay there when the
    /// body's children are sorted.
    hoisted: std::collections::HashSet<NodeId>,
}

/// Reorder a copy of `doc` by the layout in `boxes`; `None` when the boxes
/// are too unreliable to improve on DOM order.
pub fn reorder(doc: &Document, boxes: &HashMap<NodeId, BoxInfo>, opts: Options) -> Option<Document> {
    let mut pass = Pass { boxes, opts, facts: HashMap::new(), hoisted: Default::default() };
    let root = doc.tree.root().id();
    pass.analyse(doc, root);
    if !pass.reliable() {
        return None;
    }
    let mut out = dom::clone_document(doc);
    pass.hoist_overlays(&mut out);
    let body = dom::find_first(&out, "body").unwrap_or(root);
    pass.reorder_subtree(&mut out, body);
    Some(out)
}

impl<'a> Pass<'a> {
    fn facts(&self, id: NodeId) -> Facts {
        self.facts.get(&id).cloned().unwrap_or_default()
    }

    /// Bottom-up: extents, text sizes and hidden flags.
    fn analyse(&mut self, doc: &Document, id: NodeId) -> Facts {
        let Some(node) = doc.tree.get(id) else { return Facts::default() };
        let tag = node.value().as_element().map(|e| e.name().to_ascii_lowercase());
        let own = self.boxes.get(&id);
        let mut facts = Facts::default();
        let opaque = tag.as_deref().map(|t| OPAQUE.contains(&t)).unwrap_or(false);
        if opaque {
            facts.text_len = dom::get_text(doc, id).trim().chars().count();
            facts.extent = own.and_then(|b| b.visible_rect());
        } else {
            for child in node.children() {
                match child.value() {
                    scraper::Node::Text(t) => {
                        let n = t.trim().chars().count();
                        facts.text_len += n;
                        facts.text_bearing |= n > 0;
                    }
                    scraper::Node::Element(_) | scraper::Node::Fragment => {
                        let cf = self.analyse(doc, child.id());
                        facts.text_len += cf.text_len;
                        if !cf.hidden {
                            if let Some(e) = cf.extent {
                                facts.extent = Some(facts.extent.map(|x| x.union(&e)).unwrap_or(e));
                            }
                        }
                    }
                    _ => {}
                }
            }
            if let Some(r) = own.and_then(|b| b.visible_rect()) {
                facts.extent = Some(facts.extent.map(|x| x.union(&r)).unwrap_or(r));
            }
        }
        if let Some(b) = own {
            let keep = tag.as_deref().map(|t| KEEP_WITHOUT_BOX.contains(&t)).unwrap_or(false);
            let off_document = facts.extent.map(|e| e.right() <= 0.0 || e.bottom() <= 0.0).unwrap_or(false);
            facts.hidden = b.display_none
                || (b.styled && b.opacity <= 0.01)
                || off_document
                || (b.styled && !keep && facts.extent.is_none());
        }
        self.facts.insert(id, facts.clone());
        facts
    }

    /// Enough text-bearing elements got a box for the layout to be trusted.
    fn reliable(&self) -> bool {
        let (mut total, mut empty) = (0usize, 0usize);
        for (id, f) in &self.facts {
            let Some(b) = self.boxes.get(id) else { continue };
            if !f.text_bearing || !b.styled || b.display_none {
                continue;
            }
            total += 1;
            if b.rect.map(|r| r.is_empty()).unwrap_or(true) {
                empty += 1;
            }
        }
        total == 0 || (empty as f64) / (total as f64) <= MAX_EMPTY_TEXT_SHARE
    }

    // ---- overlays ----

    fn is_overlay(&self, id: NodeId) -> Option<Rect> {
        let b = self.boxes.get(&id)?;
        let f = self.facts(id);
        if f.hidden {
            return None;
        }
        let extent = f.extent?;
        // Decorations (scroll indicators, shadows) are not overlays.
        if f.text_len == 0 || extent.width < MIN_OVERLAY_SIZE || extent.height < MIN_OVERLAY_SIZE {
            return None;
        }
        let (vw, vh) = self.opts.viewport;
        let viewport = Rect { x: 0.0, y: 0.0, width: vw, height: vh, ..Rect::default() };
        let big = extent.area() >= 0.05 * viewport.area();
        let positioned = b.position == Position::Fixed || (b.position == Position::Absolute && b.z_index >= 1 && big);
        (positioned && extent.intersects(&viewport)).then_some(extent)
    }

    /// Move fixed/high-z elements that cover the viewport to the start of the
    /// body: bars along the top edge first, then the real overlays under an
    /// "Overlay" label.
    fn hoist_overlays(&mut self, doc: &mut Document) {
        let Some(body) = dom::find_first(doc, "body") else { return };
        let mut overlays: Vec<(NodeId, Rect)> = Vec::new();
        let mut stack = vec![body];
        while let Some(id) = stack.pop() {
            let Some(node) = doc.tree.get(id) else { continue };
            let children: Vec<NodeId> = node.children().rev().filter(|c| c.value().is_element()).map(|c| c.id()).collect();
            for c in children {
                let tag = dom::tag_name(doc, c).unwrap_or_default();
                if OPAQUE.contains(&tag.as_str()) || self.facts(c).hidden {
                    continue;
                }
                match self.is_overlay(c) {
                    Some(extent) => overlays.push((c, extent)),
                    None => stack.push(c),
                }
            }
        }
        if overlays.is_empty() {
            return;
        }
        if debug() {
            for (id, r) in &overlays {
                eprintln!("[visual] overlay <{}> {:.0},{:.0} {:.0}x{:.0} text={}", dom::tag_name(doc, *id).unwrap_or_default(), r.x, r.y, r.width, r.height, self.facts(*id).text_len);
            }
        }
        let by_position = |a: &(NodeId, Rect), b: &(NodeId, Rect)| finite(a.1.y).total_cmp(&finite(b.1.y)).then(finite(a.1.x).total_cmp(&finite(b.1.x)));
        let (mut bars, mut rest): (Vec<_>, Vec<_>) = overlays.into_iter().partition(|(_, r)| r.y <= 1.0 && r.height <= MAX_BAR_HEIGHT);
        bars.sort_by(by_position);
        rest.sort_by(by_position);
        let mut order: Vec<NodeId> = bars.into_iter().map(|(id, _)| id).collect();
        if !rest.is_empty() {
            order.push(raw_markdown(doc, "**Overlay**"));
            order.extend(rest.into_iter().map(|(id, _)| id));
            order.push(raw_markdown(doc, "---"));
        }
        self.hoisted.extend(order.iter().copied());
        for id in order.into_iter().rev() {
            if let Some(mut b) = doc.tree.get_mut(body) {
                b.prepend_id(id);
            }
        }
    }

    // ---- ordering ----

    fn reorder_subtree(&self, doc: &mut Document, id: NodeId) {
        let tag = dom::tag_name(doc, id).unwrap_or_default();
        if OPAQUE.contains(&tag.as_str()) {
            return;
        }
        let Some(node) = doc.tree.get(id) else { return };
        let mut has_text = false;
        let mut kids: Vec<NodeId> = Vec::new();
        // Hoisted overlays and pre-formatted markdown keep their place in front.
        let mut pinned: Vec<NodeId> = Vec::new();
        for c in node.children() {
            match c.value() {
                scraper::Node::Text(t) => has_text |= !t.trim().is_empty(),
                scraper::Node::Element(_) => {
                    if self.hoisted.contains(&c.id()) {
                        pinned.push(c.id());
                    } else if dom::attr(doc, c.id(), RAW_MARKDOWN_ATTR).is_none() {
                        kids.push(c.id());
                    }
                }
                scraper::Node::Fragment => kids.push(c.id()),
                _ => {}
            }
        }
        // Hidden children go first, so the remaining ones are what a person sees.
        kids.retain(|k| {
            if self.facts(*k).hidden {
                dom::decompose(doc, *k);
                false
            } else {
                true
            }
        });
        let reorderable = !has_text && !NO_REORDER.contains(&tag.as_str()) && kids.len() >= 2 && kids.iter().all(|k| self.block_extent(doc, *k).is_some());
        if reorderable {
            self.reorder_children(doc, id, &tag, &pinned, &kids);
        }
        for k in pinned.into_iter().chain(kids) {
            self.reorder_subtree(doc, k);
        }
    }

    /// The extent of a child that may be moved: block-level with a visible box.
    fn block_extent(&self, doc: &Document, id: NodeId) -> Option<Rect> {
        if !doc.tree.get(id)?.value().is_element() {
            return None;
        }
        if self.boxes.get(&id).map(|b| b.inline_level).unwrap_or(false) {
            return None;
        }
        self.facts(id).extent
    }

    fn reorder_children(&self, doc: &mut Document, container: NodeId, tag: &str, pinned: &[NodeId], kids: &[NodeId]) {
        let extents: HashMap<NodeId, Rect> = kids.iter().map(|k| (*k, self.facts(*k).extent.unwrap_or_default())).collect();
        let text_len: HashMap<NodeId, usize> = kids.iter().map(|k| (*k, self.facts(*k).text_len)).collect();
        let mut rows = group_rows(kids, &extents);
        // Right-to-left containers are read from the right.
        if self.boxes.get(&container).map(|b| b.rtl).unwrap_or(false) {
            for row in rows.iter_mut() {
                row.reverse();
            }
        }
        if self.opts.reader {
            for row in rows.iter_mut() {
                if is_column_row(row, &extents, &text_len) {
                    if let Some(i) = self.main_column(doc, row) {
                        let main = row.remove(i);
                        row.insert(0, main);
                    }
                }
            }
        }
        let order: Vec<NodeId> = rows.iter().flatten().copied().collect();
        if debug() && order != kids {
            let describe = |k: &NodeId| {
                let r = extents[k];
                format!("<{}> {:.0},{:.0} {:.0}x{:.0}", dom::tag_name(doc, *k).unwrap_or_default(), r.x, r.y, r.width, r.height)
            };
            eprintln!("[visual] <{tag}> reordered: {:?} -> {:?}", kids.iter().map(describe).collect::<Vec<_>>(), order.iter().map(describe).collect::<Vec<_>>());
        }
        if order != kids {
            // Moving every child to the end in the wanted order leaves the
            // pinned ones (and any whitespace) in front.
            for k in pinned.iter().chain(&order) {
                if let Some(mut c) = doc.tree.get_mut(container) {
                    c.append_id(*k);
                }
            }
        }
        let all_cards = tag != "body" && pinned.is_empty() && rows.iter().all(|r| is_card_row(r, &extents)) && order.iter().all(|k| self.facts(*k).text_len <= MAX_CARD_TEXT);
        if all_cards {
            self.cards_to_list(doc, container, &order);
            return;
        }
        for row in &rows {
            if !is_column_row(row, &extents, &text_len) {
                continue;
            }
            if debug() {
                eprintln!("[visual] <{tag}> columns: {:?}", row.iter().map(|k| format!("<{}> {:?}", dom::tag_name(doc, *k).unwrap_or_default(), self.column_label(doc, *k))).collect::<Vec<_>>());
            }
            for (i, col) in row.iter().enumerate() {
                if i > 0 {
                    let sep = raw_markdown(doc, "---");
                    if let Some(mut c) = doc.tree.get_mut(*col) {
                        c.insert_id_before(sep);
                    }
                }
                if let Some(label) = self.column_label(doc, *col) {
                    let l = raw_markdown(doc, &format!("**{label}**"));
                    if let Some(mut c) = doc.tree.get_mut(*col) {
                        c.insert_id_before(l);
                    }
                }
            }
        }
    }

    /// Index of the column holding the main content: a `main`/`article`
    /// landmark, else the one with the most text.
    fn main_column(&self, doc: &Document, row: &[NodeId]) -> Option<usize> {
        if row.len() < 2 {
            return None;
        }
        let has_main = |id: NodeId| {
            let node = doc.tree.get(id)?;
            node.descendants().find(|d| {
                let Some(el) = d.value().as_element() else { return false };
                matches!(el.name(), "main" | "article") || el.attr("role") == Some("main")
            })
        };
        if let Some(i) = row.iter().position(|c| has_main(*c).is_some()) {
            return Some(i);
        }
        row.iter().enumerate().max_by_key(|(_, c)| self.facts(**c).text_len).map(|(i, _)| i)
    }

    /// Landmark name for a column: the column itself or a descendant landmark
    /// that fills most of it.
    fn column_label(&self, doc: &Document, col: NodeId) -> Option<&'static str> {
        if let Some(l) = landmark(doc, col) {
            return Some(l);
        }
        let height = self.facts(col).extent?.height;
        let node = doc.tree.get(col)?;
        node.descendants().skip(1).take(200).filter(|d| d.value().is_element()).find_map(|d| {
            let l = landmark(doc, d.id())?;
            let h = self.facts(d.id()).extent?.height;
            (h >= 0.6 * height).then_some(l)
        })
    }

    /// Turn a container of card rows into a list: the container becomes a
    /// `ul` and each card is wrapped in an `li`.
    fn cards_to_list(&self, doc: &mut Document, container: NodeId, cards: &[NodeId]) {
        let attrs: Vec<(String, String)> = doc
            .tree
            .get(container)
            .and_then(|n| n.value().as_element().map(|e| e.attrs().map(|(k, v)| (k.to_string(), v.to_string())).collect()))
            .unwrap_or_default();
        if let Some(mut n) = doc.tree.get_mut(container) {
            *n.value() = dom::element_node("ul", &[]);
        }
        for (k, v) in &attrs {
            dom::set_attr(doc, container, k, v);
        }
        for card in cards {
            let li = doc.tree.orphan(dom::element_node("li", &[])).id();
            if let Some(mut c) = doc.tree.get_mut(*card) {
                c.insert_id_before(li);
            }
            if let Some(mut l) = doc.tree.get_mut(li) {
                l.append_id(*card);
            }
        }
    }
}

/// Group boxes into visual rows: a box joins the current row when it
/// overlaps it vertically without overlapping any member horizontally
/// (columns); anything else starts a new row. Rows are top to bottom, members
/// left to right.
fn group_rows(kids: &[NodeId], extents: &HashMap<NodeId, Rect>) -> Vec<Vec<NodeId>> {
    // Boxes on the same line (within tolerance) sort by x; boxes that also
    // share an x keep their DOM order (the sort is stable).
    // "Equal within tolerance" is not transitive, so it cannot be a sort comparator (Rust's sort
    // panics on comparators that are not total orders): coordinates are first snapped to clusters
    // (sorted values chained within the tolerance), then sorted by cluster with DOM order kept.
    let ys = clusters(kids.iter().map(|k| finite(extents[k].y)));
    let xs = clusters(kids.iter().map(|k| finite(extents[k].x)));
    let mut order: Vec<usize> = (0..kids.len()).collect();
    order.sort_by_key(|i| (ys[*i], xs[*i]));
    let sorted: Vec<NodeId> = order.into_iter().map(|i| kids[i]).collect();
    let mut rows: Vec<Vec<NodeId>> = Vec::new();
    let mut bottom = f64::NEG_INFINITY;
    for k in sorted {
        let r = &extents[&k];
        let joins = rows.last().map(|row| {
            r.y < bottom - 1.0 && row.iter().all(|m| {
                let e = &extents[m];
                r.x >= e.right() - 1.0 || r.right() <= e.x + 1.0
            })
        });
        match joins {
            Some(true) => {
                rows.last_mut().unwrap().push(k);
                bottom = bottom.max(r.bottom());
            }
            _ => {
                rows.push(vec![k]);
                bottom = r.bottom();
            }
        }
    }
    for row in rows.iter_mut() {
        let xs = clusters(row.iter().map(|k| finite(extents[k].x)));
        let mut order: Vec<usize> = (0..row.len()).collect();
        order.sort_by_key(|i| xs[*i]);
        *row = order.into_iter().map(|i| row[i]).collect();
    }
    rows
}

/// NaN/infinite coordinates (broken layouts) count as 0.
fn finite(v: f64) -> f64 {
    if v.is_finite() { v } else { 0.0 }
}

/// Cluster index per value: values sorted, a new cluster whenever the gap to the previous value
/// exceeds ALIGN_TOLERANCE. Equal clusters mean "aligned".
fn clusters(values: impl Iterator<Item = f64>) -> Vec<usize> {
    let vals: Vec<f64> = values.collect();
    let mut idx: Vec<usize> = (0..vals.len()).collect();
    idx.sort_by(|a, b| vals[*a].total_cmp(&vals[*b]));
    let mut out = vec![0; vals.len()];
    let mut cluster = 0;
    for w in 0..idx.len() {
        if w > 0 && vals[idx[w]] - vals[idx[w - 1]] > ALIGN_TOLERANCE {
            cluster += 1;
        }
        out[idx[w]] = cluster;
    }
    out
}

/// Equal-width boxes side by side (a card grid, a pair of buttons).
fn is_card_row(row: &[NodeId], extents: &HashMap<NodeId, Rect>) -> bool {
    if row.len() < 2 {
        return false;
    }
    let widths: Vec<f64> = row.iter().map(|k| extents[k].width).collect();
    let min = widths.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = widths.iter().cloned().fold(0.0, f64::max);
    min >= MIN_CARD_WIDTH && max / min <= CARD_WIDTH_RATIO
}

/// Tall boxes of text side by side: page columns.
fn is_column_row(row: &[NodeId], extents: &HashMap<NodeId, Rect>, text_len: &HashMap<NodeId, usize>) -> bool {
    row.len() >= 2 && !is_card_row(row, extents) && row.iter().all(|k| {
        let r = &extents[k];
        r.width >= MIN_COLUMN_WIDTH && r.height >= MIN_COLUMN_HEIGHT && text_len[k] >= MIN_COLUMN_TEXT
    })
}

/// `JB_VISUAL_DEBUG=1` traces the pass's decisions on stderr.
fn debug() -> bool {
    std::env::var_os("JB_VISUAL_DEBUG").is_some()
}

/// Landmark name of an element, from its tag or ARIA role.
fn landmark(doc: &Document, id: NodeId) -> Option<&'static str> {
    let tag = dom::tag_name(doc, id)?;
    let role = dom::attr(doc, id, "role").unwrap_or_default().to_ascii_lowercase();
    Some(match (tag.as_str(), role.as_str()) {
        (_, "navigation") | ("nav", _) => "Navigation",
        (_, "complementary") | ("aside", _) => "Sidebar",
        (_, "main") | ("main", _) => "Main content",
        (_, "banner") | ("header", _) => "Header",
        (_, "contentinfo") | ("footer", _) => "Footer",
        (_, "search") | ("search", _) => "Search",
        _ => return None,
    })
}

/// A detached block element carrying pre-formatted markdown.
fn raw_markdown(doc: &mut Document, text: &str) -> NodeId {
    let mut el = doc.tree.orphan(dom::element_node("div", &[(RAW_MARKDOWN_ATTR, "1")]));
    el.append(dom::text_node(text));
    el.id()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::{html_to_markdown, MarkdownOptions};

    fn boxed(x: f64, y: f64, w: f64, h: f64) -> BoxInfo {
        BoxInfo { rect: Some(Rect { x, y, width: w, height: h, ..Rect::default() }), styled: true, opacity: 1.0, ..BoxInfo::default() }
    }

    /// Boxes keyed by element id attribute.
    fn boxes_by_id(doc: &Document, spec: &[(&str, BoxInfo)]) -> HashMap<NodeId, BoxInfo> {
        spec.iter().map(|(id, b)| (dom::find_by_id(doc, id).unwrap(), b.clone())).collect()
    }

    fn opts() -> Options {
        Options { viewport: (1280.0, 720.0), reader: false }
    }

    #[test]
    fn hidden_and_offscreen_content_is_dropped() {
        let doc = dom::parse_document("<body><div id=a>A</div><div id=b>B</div><div id=c>C</div><div id=d>D</div></body>");
        let mut none = boxed(0.0, 0.0, 0.0, 0.0);
        none.display_none = true;
        let mut clear = boxed(0.0, 40.0, 100.0, 20.0);
        clear.opacity = 0.0;
        let boxes = boxes_by_id(&doc, &[("a", boxed(0.0, 0.0, 100.0, 20.0)), ("b", none), ("c", clear), ("d", boxed(-9999.0, 60.0, 100.0, 20.0))]);
        let out = reorder(&doc, &boxes, opts()).unwrap();
        let md = html_to_markdown(&out, &MarkdownOptions::default());
        assert_eq!(md, "A");
    }

    #[test]
    fn columns_follow_visual_order_and_get_labels() {
        let long = "Lorem ipsum dolor sit amet, consectetur adipiscing elit";
        let doc = dom::parse_document(&format!("<body><div id=wrap><aside id=side><p id=t3>Side {long}</p></aside><nav id=nav><p id=t1>Nav {long}</p></nav><main id=main><p id=t2>Main {long}</p></main></div><footer id=f>Foot</footer></body>"));
        let boxes = boxes_by_id(
            &doc,
            &[
                ("wrap", boxed(0.0, 0.0, 1280.0, 400.0)),
                ("nav", boxed(0.0, 0.0, 200.0, 400.0)),
                ("main", boxed(220.0, 0.0, 800.0, 400.0)),
                ("side", boxed(1040.0, 0.0, 240.0, 400.0)),
                ("t1", boxed(0.0, 0.0, 200.0, 20.0)),
                ("t2", boxed(220.0, 0.0, 800.0, 20.0)),
                ("t3", boxed(1040.0, 0.0, 240.0, 20.0)),
                ("f", boxed(0.0, 400.0, 1280.0, 40.0)),
            ],
        );
        let out = reorder(&doc, &boxes, opts()).unwrap();
        let md = html_to_markdown(&out, &MarkdownOptions::default());
        assert_eq!(md, format!("**Navigation**\n\nNav {long}\n\n---\n\n**Main content**\n\nMain {long}\n\n---\n\n**Sidebar**\n\nSide {long}\n\nFoot"));
        let out = reorder(&doc, &boxes, Options { reader: true, ..opts() }).unwrap();
        let md = html_to_markdown(&out, &MarkdownOptions::default());
        assert!(md.starts_with(&format!("**Main content**\n\nMain {long}\n\n---\n\n**Navigation**")), "{md}");
    }

    #[test]
    fn overlays_come_first() {
        let doc = dom::parse_document("<body><p id=p>Text</p><div id=modal>Cookies <button id=ok>OK</button></div></body>");
        let mut modal = boxed(300.0, 100.0, 400.0, 200.0);
        modal.position = Position::Fixed;
        let boxes = boxes_by_id(&doc, &[("p", boxed(0.0, 0.0, 1280.0, 20.0)), ("modal", modal), ("ok", boxed(400.0, 150.0, 60.0, 30.0))]);
        let out = reorder(&doc, &boxes, opts()).unwrap();
        let md = html_to_markdown(&out, &MarkdownOptions::default());
        assert!(md.starts_with("**Overlay**\n\nCookies OK\n\n---\n\nText"), "{md}");
    }

    #[test]
    fn card_rows_become_lists() {
        let doc = dom::parse_document("<body><div id=grid><div id=a>One</div><div id=b>Two</div><div id=c>Three</div></div></body>");
        let boxes = boxes_by_id(&doc, &[("grid", boxed(0.0, 0.0, 900.0, 100.0)), ("a", boxed(0.0, 0.0, 300.0, 100.0)), ("b", boxed(300.0, 0.0, 300.0, 100.0)), ("c", boxed(600.0, 0.0, 300.0, 100.0))]);
        let out = reorder(&doc, &boxes, opts()).unwrap();
        let md = html_to_markdown(&out, &MarkdownOptions::default());
        assert_eq!(md, "- One\n- Two\n- Three");
    }

    #[test]
    fn unreliable_layout_is_declined() {
        let doc = dom::parse_document("<body><p id=a>A</p><p id=b>B</p><p id=c>C</p></body>");
        let boxes = boxes_by_id(&doc, &[("a", boxed(0.0, 0.0, 100.0, 20.0)), ("b", boxed(0.0, 0.0, 0.0, 0.0)), ("c", boxed(0.0, 0.0, 0.0, 0.0))]);
        assert!(reorder(&doc, &boxes, opts()).is_none());
    }

    #[test]
    fn inline_content_keeps_dom_order() {
        let doc = dom::parse_document("<body><p id=p><b id=x>x</b> <i id=y>y</i></p></body>");
        let mut x = boxed(20.0, 0.0, 10.0, 16.0);
        x.inline_level = true;
        let mut y = boxed(0.0, 0.0, 10.0, 16.0);
        y.inline_level = true;
        let boxes = boxes_by_id(&doc, &[("p", boxed(0.0, 0.0, 200.0, 16.0)), ("x", x), ("y", y)]);
        let out = reorder(&doc, &boxes, opts()).unwrap();
        let md = html_to_markdown(&out, &MarkdownOptions::default());
        assert_eq!(md, "**x** *y*");
    }
}
