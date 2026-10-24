//! HTML → Markdown conversion (the `markdownify` replacement).
//!
//! Options mirror the ones the Python renderer used: ATX headings, `-` bullets
//! and stripping of `script/style/meta/link/head/noscript`.

use crate::dom::Document;
use ego_tree::NodeId;
use regex::Regex;
use std::sync::LazyLock;

/// Conversion options.
#[derive(Debug, Clone)]
pub struct MarkdownOptions {
    /// Elements removed together with their content.
    pub strip: Vec<String>,
    /// Bullet marker for unordered lists.
    pub bullet: char,
    /// Escape `*` and `_` in text so they are not read as emphasis.
    pub escape_emphasis: bool,
}

impl Default for MarkdownOptions {
    fn default() -> Self {
        Self {
            strip: ["script", "style", "meta", "link", "head", "noscript"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            bullet: '-',
            escape_emphasis: true,
        }
    }
}

const BLOCK_TAGS: &[&str] = &[
    "address", "article", "aside", "blockquote", "details", "dialog", "dd", "div", "dl", "dt",
    "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
    "header", "hgroup", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
    "summary", "tr", "center",
];

static WS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t\r\n\x0c]+").unwrap());
static MULTI_NL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());

/// Convert a whole document to markdown.
pub fn html_to_markdown(doc: &Document, options: &MarkdownOptions) -> String {
    let mut conv = Converter { doc, options };
    let out = conv.convert_children(doc.tree.root().id(), &Ctx::default());
    finish(&out)
}

/// Convert a subtree to markdown.
pub fn node_to_markdown(doc: &Document, id: NodeId, options: &MarkdownOptions) -> String {
    let mut conv = Converter { doc, options };
    let out = conv.convert_node(id, &Ctx::default());
    finish(&out)
}

/// Convert an HTML string to markdown.
pub fn convert_html(html: &str, options: &MarkdownOptions) -> String {
    let doc = crate::dom::parse_document(html);
    html_to_markdown(&doc, options)
}

fn finish(s: &str) -> String {
    let collapsed = MULTI_NL_RE.replace_all(s, "\n\n");
    let mut lines: Vec<String> = collapsed.lines().map(|l| l.trim_end().to_string()).collect();
    while lines.first().map(|l| l.is_empty()).unwrap_or(false) {
        lines.remove(0);
    }
    while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    lines.join("\n")
}

#[derive(Default, Clone)]
struct Ctx {
    in_pre: bool,
    in_code: bool,
    list_depth: usize,
    in_table_cell: bool,
}

struct Converter<'a> {
    doc: &'a Document,
    options: &'a MarkdownOptions,
}

impl<'a> Converter<'a> {
    fn convert_children(&mut self, id: NodeId, ctx: &Ctx) -> String {
        let node = match self.doc.tree.get(id) {
            Some(n) => n,
            None => return String::new(),
        };
        let mut out = String::new();
        for child in node.children() {
            out.push_str(&self.convert_node(child.id(), ctx));
        }
        out
    }

    fn convert_node(&mut self, id: NodeId, ctx: &Ctx) -> String {
        let node = match self.doc.tree.get(id) {
            Some(n) => n,
            None => return String::new(),
        };
        match node.value() {
            scraper::Node::Text(t) => self.convert_text(t, ctx),
            scraper::Node::Element(el) => {
                let tag = el.name().to_ascii_lowercase();
                self.convert_element(id, &tag, ctx)
            }
            scraper::Node::Document | scraper::Node::Fragment => self.convert_children(id, ctx),
            _ => String::new(),
        }
    }

    fn convert_text(&self, t: &str, ctx: &Ctx) -> String {
        if ctx.in_pre {
            return t.to_string();
        }
        let mut text = WS_RE.replace_all(t, " ").to_string();
        if ctx.in_code {
            return text;
        }
        if self.options.escape_emphasis {
            text = text.replace('*', "\\*").replace('_', "\\_");
        }
        text
    }

    fn convert_element(&mut self, id: NodeId, tag: &str, ctx: &Ctx) -> String {
        if self.options.strip.iter().any(|s| s == tag) {
            return String::new();
        }
        let attr = |name: &str| crate::dom::attr(self.doc, id, name);

        // Renderer-generated markdown (form widgets etc.): pass through verbatim.
        if attr(crate::dom::RAW_MARKDOWN_ATTR).is_some() {
            let mut c = ctx.clone();
            c.in_pre = true;
            let inner = self.convert_children(id, &c);
            return if BLOCK_TAGS.contains(&tag) { format!("\n\n{}\n\n", inner.trim_matches('\n')) } else { inner };
        }

        match tag {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let level = tag[1..].parse::<usize>().unwrap_or(1);
                let inner = self.convert_children(id, ctx).trim().to_string();
                if inner.is_empty() {
                    return String::new();
                }
                format!("\n\n{} {}\n\n", "#".repeat(level), inner.replace('\n', " "))
            }
            "p" => {
                let inner = self.convert_children(id, ctx).trim().to_string();
                if inner.is_empty() {
                    return String::new();
                }
                format!("\n\n{}\n\n", inner)
            }
            "br" => "  \n".to_string(),
            "hr" => "\n\n---\n\n".to_string(),
            "strong" | "b" => self.wrap_inline(id, ctx, "**"),
            "em" | "i" => self.wrap_inline(id, ctx, "*"),
            "del" | "s" | "strike" => self.wrap_inline(id, ctx, "~~"),
            "code" | "kbd" | "samp" | "tt" if !ctx.in_pre => {
                let mut c = ctx.clone();
                c.in_code = true;
                let inner = self.convert_children(id, &c);
                if inner.trim().is_empty() {
                    return inner;
                }
                let fence = if inner.contains('`') { "``" } else { "`" };
                format!("{fence}{inner}{fence}")
            }
            "pre" => {
                let mut c = ctx.clone();
                c.in_pre = true;
                c.in_code = true;
                let inner = self.convert_children(id, &c);
                let inner = inner.trim_matches('\n');
                let lang = self.code_language(id).unwrap_or_default();
                format!("\n\n```{lang}\n{inner}\n```\n\n")
            }
            "a" => {
                let inner = self.convert_children(id, ctx);
                let text = inner.trim();
                let href = attr("href").unwrap_or_default();
                if href.is_empty() || text.is_empty() {
                    return inner;
                }
                let title = attr("title")
                    .filter(|t| !t.is_empty())
                    .map(|t| format!(" \"{}\"", t.replace('"', "\\\"")))
                    .unwrap_or_default();
                if text == href {
                    format!("<{href}>")
                } else {
                    format!("[{text}]({href}{title})")
                }
            }
            "img" => {
                let alt = attr("alt").unwrap_or_default();
                let src = attr("src").or_else(|| attr("data-src")).unwrap_or_default();
                let title = attr("title")
                    .filter(|t| !t.is_empty())
                    .map(|t| format!(" \"{}\"", t.replace('"', "\\\"")))
                    .unwrap_or_default();
                if src.is_empty() && alt.is_empty() {
                    return String::new();
                }
                format!("![{alt}]({src}{title})")
            }
            "ul" | "ol" => self.convert_list(id, tag, ctx),
            "li" => {
                // Handled by convert_list; a stray <li> renders as a bullet.
                let inner = self.convert_children(id, ctx).trim().to_string();
                format!("\n{} {}\n", self.options.bullet, inner)
            }
            "blockquote" => {
                let inner = self.convert_children(id, ctx);
                let inner = inner.trim();
                if inner.is_empty() {
                    return String::new();
                }
                let quoted: Vec<String> = inner.lines().map(|l| format!("> {l}")).collect();
                format!("\n\n{}\n\n", quoted.join("\n"))
            }
            "table" => self.convert_table(id, ctx),
            "thead" | "tbody" | "tfoot" | "tr" | "th" | "td" | "caption" | "colgroup" | "col"
                if !ctx.in_table_cell =>
            {
                // Table structure outside of convert_table (malformed) – flatten.
                let inner = self.convert_children(id, ctx);
                if tag == "tr" {
                    format!("\n{}\n", inner.trim())
                } else if tag == "td" || tag == "th" {
                    format!("{} ", inner.trim())
                } else {
                    inner
                }
            }
            "sub" => self.wrap_inline(id, ctx, "~"),
            "sup" => self.wrap_inline(id, ctx, "^"),
            "u" | "ins" => {
                let inner = self.convert_children(id, ctx);
                if inner.trim().is_empty() {
                    return inner;
                }
                format!("<u>{inner}</u>")
            }
            "textarea" => {
                let inner = self.convert_children(id, ctx);
                format!("\n\n{}\n\n", inner.trim())
            }
            "input" | "button" | "select" | "option" | "iframe" | "svg" | "canvas" | "video"
            | "audio" | "object" | "embed" | "template" => {
                // No meaningful markdown mapping; buttons/inputs are converted to
                // text by the renderer before this stage.
                let inner = self.convert_children(id, ctx);
                if BLOCK_TAGS.contains(&tag) {
                    format!("\n\n{}\n\n", inner.trim())
                } else {
                    inner
                }
            }
            _ => {
                let inner = self.convert_children(id, ctx);
                if BLOCK_TAGS.contains(&tag) {
                    let t = inner.trim();
                    if t.is_empty() {
                        return String::new();
                    }
                    format!("\n\n{}\n\n", t)
                } else {
                    inner
                }
            }
        }
    }

    fn wrap_inline(&mut self, id: NodeId, ctx: &Ctx, marker: &str) -> String {
        let inner = self.convert_children(id, ctx);
        let trimmed = inner.trim();
        if trimmed.is_empty() {
            return inner;
        }
        let leading = if inner.starts_with(char::is_whitespace) { " " } else { "" };
        let trailing = if inner.ends_with(char::is_whitespace) { " " } else { "" };
        format!("{leading}{marker}{trimmed}{marker}{trailing}")
    }

    fn code_language(&self, id: NodeId) -> Option<String> {
        let code = crate::dom::find_all_within(self.doc, id, &["code"]).into_iter().next()?;
        let class = crate::dom::attr(self.doc, code, "class")?;
        class
            .split_whitespace()
            .find_map(|c| c.strip_prefix("language-").or_else(|| c.strip_prefix("lang-")))
            .map(|s| s.to_string())
    }

    fn convert_list(&mut self, id: NodeId, tag: &str, ctx: &Ctx) -> String {
        let node = match self.doc.tree.get(id) {
            Some(n) => n,
            None => return String::new(),
        };
        let mut c = ctx.clone();
        c.list_depth += 1;
        let indent = "    ".repeat(ctx.list_depth);
        let start: usize = crate::dom::attr(self.doc, id, "start")
            .and_then(|s| s.parse().ok())
            .unwrap_or(1);
        let mut out = String::new();
        let mut index = start;
        for child in node.children() {
            let is_li = child
                .value()
                .as_element()
                .map(|e| e.name().eq_ignore_ascii_case("li"))
                .unwrap_or(false);
            if !is_li {
                // Text or non-li children: only keep if meaningful.
                let extra = self.convert_node(child.id(), &c);
                if !extra.trim().is_empty() {
                    out.push_str(&extra);
                }
                continue;
            }
            let inner = self.convert_children(child.id(), &c);
            let inner = inner.trim_matches('\n');
            let marker = if tag == "ol" {
                format!("{}.", index)
            } else {
                self.options.bullet.to_string()
            };
            index += 1;
            // Indent continuation lines so nested lists stay attached.
            let mut lines = inner.lines();
            let first = lines.next().unwrap_or("").trim_start();
            out.push_str(&format!("{indent}{marker} {first}\n"));
            for line in lines {
                if line.trim().is_empty() {
                    continue;
                }
                let line = line.trim_start();
                out.push_str(&format!("{indent}  {line}\n"));
            }
        }
        if out.trim().is_empty() {
            return String::new();
        }
        if ctx.list_depth == 0 {
            format!("\n\n{}\n", out)
        } else {
            format!("\n{}", out)
        }
    }

    /// Rows belonging directly to this table (children, or children of its
    /// thead/tbody/tfoot) — nested tables keep their own rows.
    fn table_rows(&self, id: NodeId) -> Vec<NodeId> {
        let mut rows = Vec::new();
        for child in crate::dom::children(self.doc, id) {
            match crate::dom::tag_name(self.doc, child).as_deref() {
                Some("tr") => rows.push(child),
                Some("thead" | "tbody" | "tfoot") => {
                    rows.extend(crate::dom::children(self.doc, child).into_iter().filter(|c| crate::dom::tag_name(self.doc, *c).as_deref() == Some("tr")));
                }
                _ => {}
            }
        }
        rows
    }

    fn convert_table(&mut self, id: NodeId, ctx: &Ctx) -> String {
        let rows = self.table_rows(id);
        if rows.is_empty() {
            let inner = self.convert_children(id, ctx);
            return format!("\n\n{}\n\n", inner.trim());
        }
        // Layout tables (nested tables, presentational role) are rendered as
        // flowing blocks instead of a pipe table.
        let is_layout = crate::dom::contains_any(self.doc, id, &["table"])
            || crate::dom::attr(self.doc, id, "role").as_deref() == Some("presentation");
        if is_layout {
            let mut out = String::from("\n\n");
            for tr in rows {
                for cell in crate::dom::children(self.doc, tr) {
                    if !matches!(crate::dom::tag_name(self.doc, cell).as_deref(), Some("td" | "th")) {
                        continue;
                    }
                    let text = self.convert_children(cell, ctx);
                    let text = text.trim();
                    if !text.is_empty() {
                        out.push_str(text);
                        out.push_str("\n\n");
                    }
                }
            }
            return out;
        }
        let mut cell_ctx = ctx.clone();
        cell_ctx.in_table_cell = true;
        let mut table: Vec<Vec<String>> = Vec::new();
        let mut header_row = false;
        for (i, tr) in rows.iter().enumerate() {
            let cells: Vec<NodeId> = match self.doc.tree.get(*tr) {
                Some(n) => n
                    .children()
                    .filter(|c| {
                        c.value()
                            .as_element()
                            .map(|e| matches!(e.name(), "td" | "th"))
                            .unwrap_or(false)
                    })
                    .map(|c| c.id())
                    .collect(),
                None => continue,
            };
            if cells.is_empty() {
                continue;
            }
            if i == 0 {
                header_row = cells
                    .iter()
                    .all(|c| crate::dom::tag_name(self.doc, *c).as_deref() == Some("th"));
            }
            let row: Vec<String> = cells
                .iter()
                .map(|c| {
                    let mut text = self.convert_children(*c, &cell_ctx);
                    text = text.replace('\n', " ").replace('|', "\\|");
                    text.split_whitespace().collect::<Vec<_>>().join(" ")
                })
                .collect();
            table.push(row);
        }
        if table.is_empty() {
            return String::new();
        }
        let width = table.iter().map(|r| r.len()).max().unwrap_or(0);
        let mut out = String::from("\n\n");
        let mut iter = table.into_iter();
        let first = iter.next().unwrap();
        let pad = |mut r: Vec<String>| {
            while r.len() < width {
                r.push(String::new());
            }
            r
        };
        if header_row {
            out.push_str(&format!("| {} |\n", pad(first).join(" | ")));
        } else {
            // markdownify emits an empty header when the first row is not a header.
            out.push_str(&format!("| {} |\n", vec![""; width].join(" | ")));
            out.push_str(&format!("| {} |\n", vec!["---"; width].join(" | ")));
            out.push_str(&format!("| {} |\n", pad(first).join(" | ")));
        }
        if header_row {
            out.push_str(&format!("| {} |\n", vec!["---"; width].join(" | ")));
        }
        for row in iter {
            out.push_str(&format!("| {} |\n", pad(row).join(" | ")));
        }
        out.push('\n');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_conversion() {
        let md = convert_html(
            "<html><head><title>T</title><script>x()</script></head><body><h1>Hi</h1><p>Hello <b>world</b> <a href='/x'>link</a></p><ul><li>a</li><li>b</li></ul></body></html>",
            &MarkdownOptions::default(),
        );
        assert!(md.starts_with("# Hi"));
        assert!(md.contains("Hello **world** [link](/x)"));
        assert!(md.contains("- a\n- b"));
        assert!(!md.contains("x()"));
    }

    #[test]
    fn tables() {
        let md = convert_html(
            "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
            &MarkdownOptions::default(),
        );
        assert!(md.contains("| A | B |"));
        assert!(md.contains("| --- | --- |"));
        assert!(md.contains("| 1 | 2 |"));
    }
}
