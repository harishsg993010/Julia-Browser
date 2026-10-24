//! Incremental relayout: instead of building a new blitz document for every geometry query after a
//! DOM change (0.5-4 s on large pages, 10-50 times per page load or action), the new mirror HTML is
//! parsed into a light tree with the same html5ever options blitz-html uses, diffed against the
//! existing blitz document (elements matched by their `data-jb` id), and only the differences are
//! applied through blitz's `DocumentMutator`. Stylo then restyles only damaged nodes and Taffy keeps
//! the layout caches of untouched subtrees.

use blitz_dom::{Attribute, BaseDocument, DocumentMutator, NodeData, NodeId};
use html5ever::ns;
use html5ever::interface::{ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::tendril::{StrTendril, TendrilSink};
use html5ever::{ParseOpts, QualName};
use std::borrow::Cow;
use std::cell::{Ref, RefCell};
use std::collections::HashMap;

#[derive(Debug)]
pub(crate) enum LKind {
    Document,
    Element { name: QualName, attrs: Vec<Attribute> },
    Text(String),
    Comment,
}

#[derive(Debug)]
pub(crate) struct LNode {
    pub kind: LKind,
    pub parent: Option<usize>,
    pub children: Vec<usize>,
}

/// A parsed document as a flat arena; node 0 is the document.
pub(crate) struct LightTree {
    pub nodes: Vec<LNode>,
}

struct Sink {
    nodes: RefCell<Vec<LNode>>,
}

impl Sink {
    fn push(&self, kind: LKind) -> usize {
        let mut n = self.nodes.borrow_mut();
        n.push(LNode { kind, parent: None, children: Vec::new() });
        n.len() - 1
    }
    fn detach(&self, id: usize) {
        let mut n = self.nodes.borrow_mut();
        if let Some(p) = n[id].parent.take() {
            n[p].children.retain(|c| *c != id);
        }
    }
    fn append_text_or_new(&self, parent: usize, before: Option<usize>, text: &str) {
        // html5ever merges adjacent text into the previous text node (as blitz-html does).
        let prev = {
            let n = self.nodes.borrow();
            match before {
                None => n[parent].children.last().copied(),
                Some(b) => {
                    let kids = &n[parent].children;
                    kids.iter().position(|c| *c == b).and_then(|i| i.checked_sub(1)).map(|i| kids[i])
                }
            }
        };
        if let Some(p) = prev {
            let mut n = self.nodes.borrow_mut();
            if let LKind::Text(t) = &mut n[p].kind {
                t.push_str(text);
                return;
            }
        }
        let id = self.push(LKind::Text(text.to_string()));
        self.insert(parent, id, before);
    }
    fn insert(&self, parent: usize, id: usize, before: Option<usize>) {
        self.detach(id);
        let mut n = self.nodes.borrow_mut();
        n[id].parent = Some(parent);
        match before.and_then(|b| n[parent].children.iter().position(|c| *c == b)) {
            Some(i) => n[parent].children.insert(i, id),
            None => n[parent].children.push(id),
        }
    }
}

impl TreeSink for Sink {
    type Output = LightTree;
    type Handle = usize;
    type ElemName<'a>
        = Ref<'a, QualName>
    where
        Self: 'a;

    fn finish(self) -> LightTree {
        LightTree { nodes: self.nodes.into_inner() }
    }
    fn parse_error(&self, _msg: Cow<'static, str>) {}
    fn get_document(&self) -> usize {
        0
    }
    fn elem_name<'a>(&'a self, target: &'a usize) -> Ref<'a, QualName> {
        Ref::map(self.nodes.borrow(), |n| match &n[*target].kind {
            LKind::Element { name, .. } => name,
            _ => panic!("elem_name on a non-element"),
        })
    }
    fn create_element(&self, name: QualName, attrs: Vec<html5ever::Attribute>, _flags: ElementFlags) -> usize {
        let attrs = attrs.into_iter().map(|a| Attribute { name: a.name, value: a.value.to_string() }).collect();
        self.push(LKind::Element { name, attrs })
    }
    fn create_comment(&self, _text: StrTendril) -> usize {
        self.push(LKind::Comment)
    }
    fn create_pi(&self, _target: StrTendril, _data: StrTendril) -> usize {
        self.push(LKind::Comment)
    }
    fn append(&self, parent: &usize, child: NodeOrText<usize>) {
        match child {
            NodeOrText::AppendNode(id) => self.insert(*parent, id, None),
            NodeOrText::AppendText(t) => self.append_text_or_new(*parent, None, &t),
        }
    }
    fn append_before_sibling(&self, sibling: &usize, new_node: NodeOrText<usize>) {
        let Some(parent) = self.nodes.borrow()[*sibling].parent else { return };
        match new_node {
            NodeOrText::AppendNode(id) => self.insert(parent, id, Some(*sibling)),
            NodeOrText::AppendText(t) => self.append_text_or_new(parent, Some(*sibling), &t),
        }
    }
    fn append_based_on_parent_node(&self, element: &usize, prev_element: &usize, child: NodeOrText<usize>) {
        if self.nodes.borrow()[*element].parent.is_some() {
            self.append_before_sibling(element, child);
        } else {
            self.append(prev_element, child);
        }
    }
    fn append_doctype_to_document(&self, _name: StrTendril, _public_id: StrTendril, _system_id: StrTendril) {}
    fn get_template_contents(&self, target: &usize) -> usize {
        *target // as blitz-html: template contents are the template's children
    }
    fn same_node(&self, x: &usize, y: &usize) -> bool {
        x == y
    }
    fn set_quirks_mode(&self, _mode: QuirksMode) {}
    fn add_attrs_if_missing(&self, target: &usize, attrs: Vec<html5ever::Attribute>) {
        let mut n = self.nodes.borrow_mut();
        if let LKind::Element { attrs: existing, .. } = &mut n[*target].kind {
            for a in attrs {
                if !existing.iter().any(|e| e.name == a.name) {
                    existing.push(Attribute { name: a.name, value: a.value.to_string() });
                }
            }
        }
    }
    fn remove_from_parent(&self, target: &usize) {
        self.detach(*target);
    }
    fn reparent_children(&self, old: &usize, new: &usize) {
        let kids = std::mem::take(&mut self.nodes.borrow_mut()[*old].children);
        for k in kids {
            self.nodes.borrow_mut()[k].parent = None;
            self.insert(*new, k, None);
        }
    }
}

/// Whether blitz-html would parse `html` as XHTML (its sniffing); those documents are rebuilt.
pub(crate) fn sniffs_as_xml(html: &str) -> bool {
    let first_line = html.lines().next().unwrap_or("");
    html.starts_with("<?xml") || (html.starts_with("<!DOCTYPE") && (first_line.contains("XHTML") || first_line.contains("xhtml")))
}

pub(crate) fn parse(html: &str) -> LightTree {
    let sink = Sink { nodes: RefCell::new(vec![LNode { kind: LKind::Document, parent: None, children: Vec::new() }]) };
    let opts = ParseOpts {
        tokenizer: Default::default(),
        tree_builder: html5ever::tree_builder::TreeBuilderOpts {
            exact_errors: false,
            scripting_enabled: false, // as blitz-html
            iframe_srcdoc: false,
            drop_doctype: true,
            quirks_mode: QuirksMode::NoQuirks,
        },
    };
    html5ever::parse_document(sink, opts).from_utf8().read_from(&mut html.as_bytes()).unwrap()
}

/// Rewrite `data-jb` ids of the current document from `remap` ([old, new, old, new, ...]): the page
/// renumbers its elements when it syncs its DOM, and matching by stale ids would rebuild every
/// subtree. The attribute does not affect style, so it is written without restyle damage.
pub(crate) fn renumber(doc: &mut BaseDocument, remap: &[usize]) {
    if remap.len() < 2 {
        return;
    }
    let map: HashMap<String, String> = remap.chunks_exact(2).map(|p| (p[0].to_string(), p[1].to_string())).collect();
    let ids: Vec<NodeId> = doc.tree().iter().map(|(id, _)| id).collect();
    for id in ids {
        let Some(node) = doc.get_node_mut(id) else { continue };
        let Some(el) = node.element_data_mut() else { continue };
        if let Some(a) = el.attrs.iter_mut().find(|a| a.name.ns == ns!() && &*a.name.local == "data-jb") {
            if let Some(new) = map.get(&a.value) {
                a.value = new.clone();
            }
        }
    }
}

/// What an incremental update did.
#[derive(Debug, Default)]
pub(crate) struct DiffStats {
    pub attrs: usize,
    pub texts: usize,
    pub created: usize,
    pub removed: usize,
}

fn jb_attr(attrs: &[Attribute]) -> Option<&str> {
    attrs.iter().find(|a| a.name.ns == ns!() && &*a.name.local == "data-jb").map(|a| a.value.as_str())
}

enum OldKind<'a> {
    Element(&'a QualName, Option<String>),
    Text(&'a str),
    Comment,
    Other,
}

fn old_kind(doc: &BaseDocument, id: NodeId) -> OldKind<'_> {
    let Some(node) = doc.get_node(id) else { return OldKind::Other };
    if let Some(el) = node.element_data() {
        let jb = el.attrs.iter().find(|a| a.name.ns == ns!() && &*a.name.local == "data-jb").map(|a| a.value.clone());
        return OldKind::Element(&el.name, jb);
    }
    if let Some(t) = node.text_data() {
        return OldKind::Text(&t.content);
    }
    if matches!(node.data, NodeData::Comment { .. }) {
        return OldKind::Comment;
    }
    OldKind::Other
}

fn compatible(doc: &BaseDocument, old: NodeId, tree: &LightTree, new: usize) -> bool {
    match (old_kind(doc, old), &tree.nodes[new].kind) {
        (OldKind::Element(name, jb), LKind::Element { name: n2, attrs }) => name == n2 && jb.as_deref() == jb_attr(attrs),
        (OldKind::Text(_), LKind::Text(_)) => true,
        (OldKind::Comment, LKind::Comment) => true,
        _ => false,
    }
}

/// Apply `tree` to the blitz document. Returns None when the documents do not line up (the caller
/// then rebuilds from scratch).
pub(crate) fn apply(doc: &mut BaseDocument, tree: &LightTree) -> Option<DiffStats> {
    let root = doc.root_node().id;
    // Document children: the <html> element (comments around it are ignored).
    let new_html = tree.nodes[0].children.iter().copied().find(|c| matches!(tree.nodes[*c].kind, LKind::Element { .. }))?;
    let old_html = doc.get_node(root)?.children.iter().copied().find(|c| doc.get_node(*c).is_some_and(|n| n.is_element()))?;
    if !compatible(doc, old_html, tree, new_html) {
        return None;
    }
    let mut stats = DiffStats::default();
    let mut m = doc.mutate();
    sync_element(&mut m, old_html, tree, new_html, &mut stats);
    drop(m);
    Some(stats)
}

fn sync_attrs(m: &mut DocumentMutator, old: NodeId, new_attrs: &[Attribute], stats: &mut DiffStats) {
    let old_attrs: Vec<(QualName, String)> = m.doc.get_node(old).and_then(|n| n.element_data()).map(|e| e.attrs.iter().map(|a| (a.name.clone(), a.value.clone())).collect()).unwrap_or_default();
    for a in new_attrs {
        if !old_attrs.iter().any(|(n, v)| *n == a.name && *v == a.value) {
            m.set_attribute(old, a.name.clone(), &a.value);
            stats.attrs += 1;
        }
    }
    for (n, _) in &old_attrs {
        if !new_attrs.iter().any(|a| a.name == *n) {
            m.clear_attribute(old, n.clone());
            stats.attrs += 1;
        }
    }
}

fn sync_element(m: &mut DocumentMutator, old: NodeId, tree: &LightTree, new: usize, stats: &mut DiffStats) {
    if let LKind::Element { attrs, .. } = &tree.nodes[new].kind {
        sync_attrs(m, old, attrs, stats);
    }
    let old_kids: Vec<NodeId> = m.child_ids(old).to_vec();
    let new_kids = &tree.nodes[new].children;
    let same_shape = old_kids.len() == new_kids.len() && old_kids.iter().zip(new_kids).all(|(o, n)| compatible(m.doc, *o, tree, *n));
    if same_shape {
        for (o, n) in old_kids.iter().zip(new_kids) {
            match &tree.nodes[*n].kind {
                LKind::Text(t) => {
                    if !matches!(old_kind(m.doc, *o), OldKind::Text(cur) if cur == t) {
                        m.set_node_text(*o, t);
                        stats.texts += 1;
                    }
                }
                LKind::Element { .. } => sync_element(m, *o, tree, *n, stats),
                _ => {}
            }
        }
        return;
    }
    // Child list changed: reuse old elements by data-jb id (keeping their style and layout state),
    // build the rest.
    let mut by_jb: HashMap<String, NodeId> = HashMap::new();
    for o in &old_kids {
        if let OldKind::Element(_, Some(jb)) = old_kind(m.doc, *o) {
            by_jb.insert(jb, *o);
        }
    }
    let mut ids = Vec::with_capacity(new_kids.len());
    let mut reused: Vec<(NodeId, usize)> = Vec::new();
    for n in new_kids {
        let hit = match &tree.nodes[*n].kind {
            LKind::Element { attrs, .. } => jb_attr(attrs).and_then(|jb| by_jb.remove(jb)).filter(|o| compatible(m.doc, *o, tree, *n)),
            _ => None,
        };
        match hit {
            Some(o) => {
                ids.push(o);
                reused.push((o, *n));
            }
            None => ids.push(build(m, tree, *n, stats)),
        }
    }
    let reused_set: std::collections::HashSet<NodeId> = reused.iter().map(|(o, _)| *o).collect();
    for o in &old_kids {
        if !reused_set.contains(o) {
            m.remove_and_drop_node(*o);
            stats.removed += 1;
        }
    }
    // Reused nodes still in their old relative order: leave them in place (moving a <link> or
    // <style> re-processes its sheet) and insert the new ones around them.
    let old_pos: HashMap<NodeId, usize> = old_kids.iter().enumerate().map(|(i, o)| (*o, i)).collect();
    let in_order = reused.windows(2).all(|w| old_pos[&w[0].0] < old_pos[&w[1].0]);
    if in_order {
        let mut batch: Vec<NodeId> = Vec::new();
        for id in &ids {
            if reused_set.contains(id) {
                if !batch.is_empty() {
                    m.insert_nodes_before(*id, &batch);
                    batch.clear();
                }
            } else {
                batch.push(*id);
            }
        }
        if !batch.is_empty() {
            m.append_children(old, &batch);
        }
    } else {
        m.append_children(old, &ids);
    }
    for (o, n) in reused {
        sync_element(m, o, tree, n, stats);
    }
}

fn build(m: &mut DocumentMutator, tree: &LightTree, n: usize, stats: &mut DiffStats) -> NodeId {
    stats.created += 1;
    match &tree.nodes[n].kind {
        LKind::Element { name, attrs } => {
            let id = m.create_element(name.clone(), attrs.clone());
            let kids: Vec<NodeId> = tree.nodes[n].children.iter().map(|c| build(m, tree, *c, stats)).collect();
            if !kids.is_empty() {
                m.append_children(id, &kids);
            }
            id
        }
        LKind::Text(t) => m.create_text_node(t),
        _ => m.create_comment_node(""),
    }
}
