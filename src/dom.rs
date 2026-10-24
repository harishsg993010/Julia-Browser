//! DOM helpers: a BeautifulSoup-flavoured convenience layer over `scraper`.
//!
//! `scraper` gives us an html5ever-parsed tree with CSS selectors; the helpers
//! here add the handful of traversal and *mutation* operations the rendering
//! pipeline needs (`get_text`, `find_all`, `decompose`, `replace_with`, ...).

use ego_tree::NodeId;
use html5ever::{ns, LocalName, QualName};
#[allow(unused_imports)]
use html5ever::namespace_url;
use scraper::node::{Element, Node, Text};
use scraper::{ElementRef, Html, Selector};

/// A parsed HTML document. Alias kept short because it is passed everywhere.
pub type Document = Html;

/// Parse a full HTML document.
pub fn parse_document(html: &str) -> Document {
    Html::parse_document(html)
}

/// Parse an HTML fragment (no implicit `<html>/<body>` wrappers).
pub fn parse_fragment(html: &str) -> Document {
    Html::parse_fragment(html)
}

/// Deep copy of a document (BeautifulSoup(str(soup))).
pub fn clone_document(doc: &Document) -> Document {
    doc.clone()
}

/// Build a qualified HTML tag name.
pub fn qual_name(tag: &str) -> QualName {
    QualName::new(None, ns!(html), LocalName::from(tag))
}

fn attr_name(name: &str) -> QualName {
    QualName::new(None, ns!(), LocalName::from(name))
}

/// Create a detached text node value.
pub fn text_node(text: &str) -> Node {
    Node::Text(Text { text: text.into() })
}

/// Create a detached element node value.
pub fn element_node(tag: &str, attrs: &[(&str, &str)]) -> Node {
    let attributes = attrs
        .iter()
        .map(|(k, v)| html5ever::Attribute {
            name: attr_name(k),
            value: (*v).into(),
        })
        .collect();
    Node::Element(Element::new(qual_name(tag), attributes))
}

/// Tag name of a node if it is an element.
pub fn tag_name(doc: &Document, id: NodeId) -> Option<String> {
    doc.tree
        .get(id)
        .and_then(|n| n.value().as_element().map(|e| e.name().to_ascii_lowercase()))
}

/// Attribute lookup on an element node.
pub fn attr(doc: &Document, id: NodeId, name: &str) -> Option<String> {
    doc.tree
        .get(id)
        .and_then(|n| n.value().as_element().and_then(|e| e.attr(name).map(|s| s.to_string())))
}

pub fn has_attr(doc: &Document, id: NodeId, name: &str) -> bool {
    attr(doc, id, name).is_some()
}

/// Set (or add) an attribute on an element node.
pub fn set_attr(doc: &mut Document, id: NodeId, name: &str, value: &str) {
    if let Some(mut node) = doc.tree.get_mut(id) {
        if let Node::Element(el) = node.value() {
            let qn = attr_name(name);
            // attributes keep their source/insertion order (scraper "deterministic")
            if let Some((_, v)) = el.attrs.iter_mut().find(|(k, _)| k.local == qn.local) {
                *v = value.into();
            } else {
                el.attrs.insert(qn, value.into());
            }
        }
    }
}

/// Remove every attribute of an element node.
pub fn clear_attrs(doc: &mut Document, id: NodeId) {
    if let Some(mut node) = doc.tree.get_mut(id) {
        if let Node::Element(el) = node.value() {
            el.attrs.clear();
        }
    }
}

/// All descendant element ids in document order (optionally filtered by tag).
pub fn find_all(doc: &Document, tags: &[&str]) -> Vec<NodeId> {
    doc.tree
        .root()
        .descendants()
        .filter(|n| match n.value().as_element() {
            Some(el) => tags.is_empty() || tags.iter().any(|t| el.name().eq_ignore_ascii_case(t)),
            None => false,
        })
        .map(|n| n.id())
        .collect()
}

/// Descendants of `root` (excluding root) matching any tag.
pub fn find_all_within(doc: &Document, root: NodeId, tags: &[&str]) -> Vec<NodeId> {
    match doc.tree.get(root) {
        Some(node) => node
            .descendants()
            .skip(1)
            .filter(|n| match n.value().as_element() {
                Some(el) => tags.is_empty() || tags.iter().any(|t| el.name().eq_ignore_ascii_case(t)),
                None => false,
            })
            .map(|n| n.id())
            .collect(),
        None => Vec::new(),
    }
}

/// First element with the given tag.
pub fn find_first(doc: &Document, tag: &str) -> Option<NodeId> {
    find_all(doc, &[tag]).into_iter().next()
}

/// Element with the given id attribute.
pub fn find_by_id(doc: &Document, id_value: &str) -> Option<NodeId> {
    doc.tree
        .root()
        .descendants()
        .find(|n| n.value().as_element().and_then(|e| e.id()) == Some(id_value))
        .map(|n| n.id())
}

/// Elements having the given class.
pub fn find_by_class(doc: &Document, class: &str) -> Vec<NodeId> {
    doc.tree
        .root()
        .descendants()
        .filter(|n| {
            n.value()
                .as_element()
                .map(|e| e.classes().any(|c| c == class))
                .unwrap_or(false)
        })
        .map(|n| n.id())
        .collect()
}

/// Elements having a given attribute (any value).
pub fn find_with_attr(doc: &Document, name: &str) -> Vec<NodeId> {
    doc.tree
        .root()
        .descendants()
        .filter(|n| n.value().as_element().map(|e| e.attr(name).is_some()).unwrap_or(false))
        .map(|n| n.id())
        .collect()
}

/// CSS selection (`soup.select(...)`). Invalid selectors yield no results.
pub fn select(doc: &Document, selector: &str) -> Vec<NodeId> {
    match Selector::parse(selector) {
        Ok(sel) => doc.select(&sel).map(|e| e.id()).collect(),
        Err(_) => Vec::new(),
    }
}

/// Nearest ancestor with the given tag (`find_parent('form')`).
pub fn find_parent(doc: &Document, id: NodeId, tag: &str) -> Option<NodeId> {
    let mut cur = doc.tree.get(id)?.parent();
    while let Some(node) = cur {
        if node.value().as_element().map(|e| e.name().eq_ignore_ascii_case(tag)).unwrap_or(false) {
            return Some(node.id());
        }
        cur = node.parent();
    }
    None
}

/// Parent element id.
pub fn parent(doc: &Document, id: NodeId) -> Option<NodeId> {
    doc.tree.get(id)?.parent().map(|p| p.id())
}

/// Next sibling element with given tag (`find_next_sibling('a')`).
pub fn find_next_sibling(doc: &Document, id: NodeId, tag: &str) -> Option<NodeId> {
    let mut cur = doc.tree.get(id)?.next_sibling();
    while let Some(node) = cur {
        if node.value().as_element().map(|e| e.name().eq_ignore_ascii_case(tag)).unwrap_or(false) {
            return Some(node.id());
        }
        cur = node.next_sibling();
    }
    None
}

/// Child element ids (direct children only).
pub fn children(doc: &Document, id: NodeId) -> Vec<NodeId> {
    match doc.tree.get(id) {
        Some(n) => n.children().filter(|c| c.value().is_element()).map(|c| c.id()).collect(),
        None => Vec::new(),
    }
}

/// Concatenated text of a node (`get_text()`).
pub fn get_text(doc: &Document, id: NodeId) -> String {
    let mut out = String::new();
    if let Some(node) = doc.tree.get(id) {
        for n in node.descendants() {
            if let Some(t) = n.value().as_text() {
                out.push_str(t);
            }
        }
    }
    out
}

/// Text with a separator between text nodes (`get_text(separator=...)`).
pub fn get_text_sep(doc: &Document, id: NodeId, sep: &str, strip: bool) -> String {
    let mut parts = Vec::new();
    if let Some(node) = doc.tree.get(id) {
        for n in node.descendants() {
            if let Some(t) = n.value().as_text() {
                let s: &str = if strip { t.trim() } else { t };
                if !strip || !s.is_empty() {
                    parts.push(s.to_string());
                }
            }
        }
    }
    parts.join(sep)
}

/// `get_text(strip=True)` – whitespace-normalised text.
pub fn get_text_stripped(doc: &Document, id: NodeId) -> String {
    get_text(doc, id).split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whole document text (including script/style contents).
pub fn document_text(doc: &Document) -> String {
    get_text(doc, doc.tree.root().id())
}

/// Text a reader would see: skips `script`, `style`, `noscript` and `template`
/// contents and separates block-ish elements with newlines.
pub fn visible_text(doc: &Document) -> String {
    fn walk(doc: &Document, id: NodeId, out: &mut String) {
        let node = match doc.tree.get(id) {
            Some(n) => n,
            None => return,
        };
        match node.value() {
            Node::Text(t) => out.push_str(t),
            Node::Element(el) => {
                let tag = el.name();
                if matches!(tag, "script" | "style" | "noscript" | "template" | "head") {
                    return;
                }
                let block = !matches!(tag, "a" | "span" | "b" | "i" | "em" | "strong" | "code" | "small" | "sub" | "sup" | "u" | "s" | "abbr" | "label" | "mark" | "q" | "cite" | "time" | "kbd" | "var" | "img" | "input" | "button" | "select" | "textarea");
                if block {
                    out.push('\n');
                }
                for c in node.children() {
                    walk(doc, c.id(), out);
                }
                if block {
                    out.push('\n');
                }
            }
            _ => {
                for c in node.children() {
                    walk(doc, c.id(), out);
                }
            }
        }
    }
    let mut out = String::new();
    walk(doc, doc.tree.root().id(), &mut out);
    out
}

/// Document `<title>` text.
pub fn title(doc: &Document) -> Option<String> {
    find_first(doc, "title").map(|id| get_text_stripped(doc, id)).filter(|s| !s.is_empty())
}

/// `<meta name=... content=...>` lookup.
pub fn meta_content(doc: &Document, name: &str) -> Option<String> {
    for id in find_all(doc, &["meta"]) {
        let matches = attr(doc, id, "name").map(|v| v.eq_ignore_ascii_case(name)).unwrap_or(false)
            || attr(doc, id, "property").map(|v| v.eq_ignore_ascii_case(name)).unwrap_or(false)
            || attr(doc, id, "http-equiv").map(|v| v.eq_ignore_ascii_case(name)).unwrap_or(false);
        if matches {
            return attr(doc, id, "content");
        }
    }
    None
}

/// Serialise the outer HTML of a node (`str(tag)`).
pub fn outer_html(doc: &Document, id: NodeId) -> String {
    match doc.tree.get(id).and_then(ElementRef::wrap) {
        Some(el) => el.html(),
        None => doc
            .tree
            .get(id)
            .and_then(|n| n.value().as_text().map(|t| t.to_string()))
            .unwrap_or_default(),
    }
}

/// Serialise the inner HTML of a node.
pub fn inner_html(doc: &Document, id: NodeId) -> String {
    doc.tree
        .get(id)
        .and_then(ElementRef::wrap)
        .map(|el| el.inner_html())
        .unwrap_or_default()
}

/// Serialise the whole document (`str(soup)`).
pub fn to_html(doc: &Document) -> String {
    doc.html()
}

/// Remove a node and its subtree (`decompose()` / `extract()`).
pub fn decompose(doc: &mut Document, id: NodeId) {
    if let Some(mut node) = doc.tree.get_mut(id) {
        node.detach();
    }
}

/// Remove all children of a node (`tag.clear()`).
pub fn clear_children(doc: &mut Document, id: NodeId) {
    let kids: Vec<NodeId> = match doc.tree.get(id) {
        Some(n) => n.children().map(|c| c.id()).collect(),
        None => return,
    };
    for k in kids {
        decompose(doc, k);
    }
}

/// Replace a node with a plain text node (`tag.replace_with("text")`).
pub fn replace_with_text(doc: &mut Document, id: NodeId, text: &str) {
    if let Some(mut node) = doc.tree.get_mut(id) {
        node.insert_before(text_node(text));
        node.detach();
    }
}

/// Attribute marking renderer-generated text that is already markdown and must
/// not be escaped or whitespace-collapsed by the markdown converter.
pub const RAW_MARKDOWN_ATTR: &str = "data-jb-md";

/// Rename an element and make its only content a string
/// (`tag.clear(); tag.name = 'span'; tag.string = text`). The text is treated
/// as pre-formatted markdown.
pub fn convert_to_text_element(doc: &mut Document, id: NodeId, new_tag: &str, text: &str) {
    clear_children(doc, id);
    if let Some(mut node) = doc.tree.get_mut(id) {
        if let Node::Element(el) = node.value() {
            el.name = qual_name(new_tag);
        }
        node.append(text_node(text));
    }
    set_attr(doc, id, RAW_MARKDOWN_ATTR, "1");
}

/// Set `tag.string = text` (drop children, add one text node).
pub fn set_string(doc: &mut Document, id: NodeId, text: &str) {
    clear_children(doc, id);
    if let Some(mut node) = doc.tree.get_mut(id) {
        node.append(text_node(text));
    }
}

/// Append a text node as the last child.
pub fn append_text(doc: &mut Document, id: NodeId, text: &str) {
    if let Some(mut node) = doc.tree.get_mut(id) {
        node.append(text_node(text));
    }
}

/// Prepend a text node as the first child.
pub fn prepend_text(doc: &mut Document, id: NodeId, text: &str) {
    if let Some(mut node) = doc.tree.get_mut(id) {
        node.prepend(text_node(text));
    }
}

/// Insert a new element as first child of `id` with a single pre-formatted
/// markdown text child. Returns its id.
pub fn prepend_element_with_text(doc: &mut Document, id: NodeId, tag: &str, text: &str) -> Option<NodeId> {
    let mut node = doc.tree.get_mut(id)?;
    let mut child = node.prepend(element_node(tag, &[(RAW_MARKDOWN_ATTR, "1")]));
    child.append(text_node(text));
    Some(child.id())
}

/// Append a new element as last child of `id` with a single pre-formatted
/// markdown text child. Returns its id.
pub fn append_element_with_text(doc: &mut Document, id: NodeId, tag: &str, text: &str) -> Option<NodeId> {
    let mut node = doc.tree.get_mut(id)?;
    let mut child = node.append(element_node(tag, &[(RAW_MARKDOWN_ATTR, "1")]));
    child.append(text_node(text));
    Some(child.id())
}

/// Replace the children of `id` with the parsed `html` fragment (`element.append(BeautifulSoup(html))`).
pub fn set_inner_html(doc: &mut Document, id: NodeId, html: &str) {
    clear_children(doc, id);
    append_html(doc, id, html);
}

/// Append a parsed fragment's nodes as children of `id`.
pub fn append_html(doc: &mut Document, id: NodeId, html: &str) {
    let frag = Html::parse_fragment(html);
    // The fragment tree is rooted at Fragment -> html -> children; grab the
    // content nodes below the synthetic <html> wrapper when present.
    let root = frag.tree.root();
    let content_parent = root
        .children()
        .find(|c| c.value().as_element().map(|e| e.name() == "html").unwrap_or(false))
        .unwrap_or(root);
    let sub_ids: Vec<NodeId> = content_parent.children().map(|c| c.id()).collect();
    for sid in sub_ids {
        let subtree = clone_subtree(&frag, sid);
        if let Some(mut node) = doc.tree.get_mut(id) {
            node.append_subtree(subtree);
        }
    }
}

/// Copy a subtree of `src` into a fresh tree.
fn clone_subtree(src: &Document, id: NodeId) -> ego_tree::Tree<Node> {
    fn copy(src: &Document, id: NodeId, dst: &mut ego_tree::NodeMut<'_, Node>) {
        let node = src.tree.get(id).unwrap();
        for child in node.children() {
            let mut new_child = dst.append(child.value().clone());
            copy(src, child.id(), &mut new_child);
        }
    }
    let node = src.tree.get(id).unwrap();
    let mut tree = ego_tree::Tree::new(node.value().clone());
    let mut root = tree.root_mut();
    copy(src, id, &mut root);
    tree
}

/// Build a document from the JSON node records exported by the JavaScript
/// side (`__jb.exportDom`). Returns the document and the jbid -> NodeId map.
pub fn document_from_json(root: &serde_json::Value) -> (Document, Vec<NodeId>) {
    use html5ever::{Attribute, Namespace, Prefix};
    let mut doc = Html::new_document();
    let mut map: Vec<NodeId> = Vec::new();
    fn build(doc: &mut Document, parent: NodeId, rec: &serde_json::Value, map: &mut Vec<NodeId>) {
        let get = |k: &str| rec.get(k);
        let node_value = if let Some(t) = get("x").and_then(|v| v.as_str()).filter(|_| get("pi").is_none()) {
            Some(Node::Text(Text { text: t.into() }))
        } else if let Some(m) = get("m").and_then(|v| v.as_str()) {
            Some(Node::Comment(scraper::node::Comment { comment: m.into() }))
        } else if let Some(pi) = get("pi").and_then(|v| v.as_str()) {
            Some(Node::ProcessingInstruction(scraper::node::ProcessingInstruction { target: pi.into(), data: get("x").and_then(|v| v.as_str()).unwrap_or("").into() }))
        } else if let Some(d) = get("d").and_then(|v| v.as_str()) {
            Some(Node::Doctype(scraper::node::Doctype { name: d.into(), public_id: get("p").and_then(|v| v.as_str()).unwrap_or("").into(), system_id: get("s").and_then(|v| v.as_str()).unwrap_or("").into() }))
        } else if get("f").is_some() {
            Some(Node::Fragment)
        } else if let Some(t) = get("t").and_then(|v| v.as_str()) {
            let ns = match get("n").and_then(|v| v.as_u64()) {
                Some(1) => ns!(svg),
                Some(2) => ns!(mathml),
                _ => ns!(html),
            };
            let attrs: Vec<Attribute> = get("a")
                .and_then(|a| a.as_array())
                .map(|list| {
                    list.iter()
                        .filter_map(|pair| {
                            let arr = pair.as_array()?;
                            let qname = arr.first()?.as_str()?;
                            let value = arr.get(1)?.as_str().unwrap_or("");
                            let ans = arr.get(2).and_then(|v| v.as_str());
                            let (prefix, local) = match qname.split_once(':') {
                                Some((p, l)) if ans.is_some() => (Some(Prefix::from(p)), l),
                                _ => (None, qname),
                            };
                            let namespace = ans.map(Namespace::from).unwrap_or_else(|| ns!());
                            Some(Attribute { name: QualName::new(prefix, namespace, LocalName::from(local)), value: value.into() })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(Node::Element(Element::new(QualName::new(None, ns, LocalName::from(t)), attrs)))
        } else {
            None
        };
        let Some(value) = node_value else { return };
        let is_element = matches!(value, Node::Element(_));
        let id = doc.tree.get_mut(parent).map(|mut p| p.append(value).id());
        let Some(id) = id else { return };
        if is_element {
            if let Some(i) = get("i").and_then(|v| v.as_u64()) {
                let i = i as usize;
                if map.len() <= i {
                    map.resize(i + 1, id);
                }
                map[i] = id;
            }
        }
        if let Some(children) = get("c").and_then(|c| c.as_array()) {
            for child in children {
                build(doc, id, child, map);
            }
        }
    }
    let root_id = doc.tree.root().id();
    if let Some(children) = root.get("c").and_then(|c| c.as_array()) {
        for child in children {
            build(&mut doc, root_id, child, &mut map);
        }
    }
    if root.get("q").and_then(|q| q.as_bool()).unwrap_or(false) {
        doc.quirks_mode = html5ever::tree_builder::QuirksMode::Quirks;
    }
    (doc, map)
}

/// Whether the node has any non-whitespace text content.
pub fn has_text(doc: &Document, id: NodeId) -> bool {
    doc.tree
        .get(id)
        .map(|n| n.descendants().any(|d| d.value().as_text().map(|t| !t.trim().is_empty()).unwrap_or(false)))
        .unwrap_or(false)
}

/// Whether any descendant element has one of the given tags.
pub fn contains_any(doc: &Document, id: NodeId, tags: &[&str]) -> bool {
    !find_all_within(doc, id, tags).is_empty()
}

/// All text nodes in the document (`find_all(text=True)`), as (node id, text).
pub fn text_nodes(doc: &Document) -> Vec<(NodeId, String)> {
    doc.tree
        .root()
        .descendants()
        .filter_map(|n| n.value().as_text().map(|t| (n.id(), t.to_string())))
        .collect()
}

/// Tag name of the parent element of a node.
pub fn parent_tag(doc: &Document, id: NodeId) -> Option<String> {
    let p = doc.tree.get(id)?.parent()?;
    p.value().as_element().map(|e| e.name().to_string())
}

/// Create an element whose id and class attributes are the given ones (used by
/// the JSON → HTML rendering).
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}
