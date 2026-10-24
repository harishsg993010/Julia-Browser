//! HTML Renderer - converts HTML/CSS to markdown for terminal display.

use crate::content_filter::DynamicContentFilter;
use crate::css_parser::CssRules;
use crate::dom::{self, Document};
use crate::extractors;
use crate::markdown::{self, MarkdownOptions};
use comfy_table::{presets::UTF8_FULL, Cell, Color, ContentArrangement, Table};
use ego_tree::NodeId;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::LazyLock;

static MULTI_BLANK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n\s*\n\s*\n+").unwrap());
static LEADING_BLANK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\n+").unwrap());
static TRIPLE_NL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n\s*\n\s*\n").unwrap());
static LIST_FIX_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n\s*-\s*\n").unwrap());
static HEADING_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n(#{1,6}\s+[^\n]+)\n").unwrap());
static TABLE_ROW_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n(\|[^\n]+\|)\n").unwrap());
static BLOCK_COMMENT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)/\*.*?\*/").unwrap());

/// Renders HTML content to markdown format with CSS styling support.
pub struct HtmlRenderer {
    pub content_filter: DynamicContentFilter,
    pub md_options: MarkdownOptions,
}

impl Default for HtmlRenderer {
    fn default() -> Self {
        Self::new()
    }
}

impl HtmlRenderer {
    pub fn new() -> Self {
        Self { content_filter: DynamicContentFilter::new(), md_options: MarkdownOptions::default() }
    }

    /// Convert HTML to markdown with CSS-based styling and content filtering.
    ///
    /// `clean_mode = true` shows only core page content; `false` also appends the
    /// technical extraction sections (web components, ARIA, media queries, ...).
    pub fn render_to_markdown(&self, doc: &Document, css_rules: Option<&CssRules>, js_context: Option<&Value>, clean_mode: bool) -> String {
        let mut cleaned = self.clean_html(doc);
        if clean_mode {
            return self.render_clean_content(&mut cleaned, css_rules);
        }

        let empty_ctx = Value::Object(Default::default());
        let ctx = js_context.unwrap_or(&empty_ctx);
        let web_components = extractors::web_components::extract(&cleaned, Some(ctx));
        let css_generated = extractors::css_generated::extract(&cleaned, css_rules);
        let layout_orders = extractors::layout::calculate_layout_order(&cleaned, css_rules);
        let aria = extractors::aria::extract(&cleaned, ctx);
        let form_validation = extractors::form_validation::extract(&cleaned, ctx);
        let dynamic = extractors::dynamic_content::detect(&cleaned, ctx);
        let mathml_svg = extractors::mathml_svg::extract(&cleaned, ctx);
        let media = extractors::media_query::extract(&cleaned, ctx);

        if !layout_orders.is_empty() {
            extractors::layout::apply_layout_order(&mut cleaned, &layout_orders);
        }
        if let Some(rules) = css_rules {
            self.apply_css_styling(&mut cleaned, rules);
        }

        let md = markdown::html_to_markdown(&cleaned, &self.md_options);
        let processed = self.post_process_markdown(&md);

        let mut parts = vec![processed];
        for extra in [web_components, css_generated, aria, form_validation, dynamic, mathml_svg, media] {
            if !extra.trim().is_empty() {
                parts.push(extra);
            }
        }
        self.extract_meaningful_content(&parts.join("\n"))
    }

    /// Render only core page content without technical details.
    fn render_clean_content(&self, doc: &mut Document, css_rules: Option<&CssRules>) -> String {
        for tag in ["script", "style", "noscript"] {
            for id in dom::find_all(doc, &[tag]) {
                dom::decompose(doc, id);
            }
        }
        if let Some(rules) = css_rules {
            self.apply_css_styling(doc, rules);
        }
        self.enhance_form_elements_clean(doc);
        let md = markdown::html_to_markdown(doc, &self.md_options);
        self.comprehensive_content_filter(&md).trim().to_string()
    }

    /// Simple form element rendering (used after the rich pass in clean mode).
    fn enhance_form_elements_clean(&self, doc: &mut Document) {
        for id in dom::find_all(doc, &["input"]) {
            let input_type = dom::attr(doc, id, "type").unwrap_or_else(|| "text".into()).to_ascii_lowercase();
            let value = dom::attr(doc, id, "value").unwrap_or_default();
            let placeholder = dom::attr(doc, id, "placeholder").unwrap_or_default();
            match input_type.as_str() {
                "submit" => {
                    let text = if value.is_empty() { "Submit".to_string() } else { value };
                    dom::replace_with_text(doc, id, &format!("[{text}]"));
                }
                "search" => {
                    let search = if placeholder.is_empty() { "Search".to_string() } else { placeholder };
                    if value.is_empty() {
                        dom::replace_with_text(doc, id, &format!("[________] ({search})"));
                    } else {
                        dom::replace_with_text(doc, id, &format!("[{value}] ({search})"));
                    }
                }
                "text" | "email" => {
                    let field = if !placeholder.is_empty() {
                        placeholder
                    } else {
                        dom::attr(doc, id, "name").unwrap_or_else(|| "Input".into())
                    };
                    if value.is_empty() {
                        dom::replace_with_text(doc, id, &format!("[{field}]"));
                    } else {
                        dom::replace_with_text(doc, id, &format!("[{value}]"));
                    }
                }
                "hidden" => dom::decompose(doc, id),
                _ => {}
            }
        }
        for id in dom::find_all(doc, &["button"]) {
            let text = dom::get_text_stripped(doc, id);
            let text = if text.is_empty() { "Button".to_string() } else { text };
            dom::replace_with_text(doc, id, &format!("[{text}]"));
        }
        for id in dom::find_all(doc, &["textarea"]) {
            let placeholder = dom::attr(doc, id, "placeholder").unwrap_or_else(|| "Text Area".into());
            dom::replace_with_text(doc, id, &format!("[{placeholder}]"));
        }
    }

    /// Filter out technical content (JS/CSS residue) line by line.
    fn comprehensive_content_filter(&self, markdown: &str) -> String {
        let mut clean_lines: Vec<&str> = Vec::new();
        for line in markdown.split('\n') {
            let s = line.trim();
            // A block-comment continuation is "* text", "*/" or a bare "*"; a line starting with
            // markdown emphasis ("**bold**", "*italic*", any length) is page text.
            let comment_star = s == "*" || s.starts_with("* ") || s.starts_with("*/");
            let js_like = s.starts_with("var ")
                || s.starts_with("function")
                || s.starts_with("const ")
                || s.starts_with("let ")
                || line.contains("= function")
                || line.contains("function(")
                || (s.ends_with(';') && (line.contains('=') || line.contains("var")))
                || line.contains("setTimeout")
                || line.contains("addEventListener")
                || line.contains("translationsHash")
                || line.contains("portalSearchDomain")
                || line.contains("rtlLangs")
                || line.contains("translationsPortalKey")
                || line.contains("wmL10nVisible")
                || line.contains("document.body.className")
                || line.contains("document.documentElement")
                || line.contains("className")
                || line.contains(".replace(")
                || line.contains(".addClass")
                || line.contains(".removeClass")
                || line.contains("window.")
                || line.contains("console.")
                || s.starts_with("/*")
                || comment_star
                || s.starts_with("//")
                || s.ends_with("*/")
                || s.starts_with("/**")
                || line.contains("jQuery")
                || line.contains("$(")
                || line.contains("getElementById");
            if js_like {
                continue;
            }
            let css_like = line.contains('{')
                || line.contains('}')
                || (line.contains(':') && line.contains(';') && !line.starts_with('#'))
                || s.starts_with('@')
                || line.contains("Custom Element")
                || line.starts_with("🏷️")
                || line.starts_with("🎭")
                || line.starts_with("📏")
                || line.starts_with("📐")
                || line.starts_with("🔽")
                || line.starts_with("*data-")
                || line.starts_with("Visible:")
                || line.contains("Media Condition:");
            if css_like {
                continue;
            }
            if s.starts_with('[') && s.ends_with(']') && (line.contains(',') || line.contains('\'')) {
                continue;
            }
            if s.is_empty() && clean_lines.last().map(|l| l.trim().is_empty()).unwrap_or(true) {
                continue;
            }
            clean_lines.push(line);
        }

        let mut content = clean_lines.join("\n");
        content = remove_sections(
            &content,
            &["## 🔍 Accessibility Content", "## ✅ Form Validation Requirements", "## 📱 Responsive & Media-Specific Content"],
        );
        content = BLOCK_COMMENT_RE.replace_all(&content, "").to_string();
        content = MULTI_BLANK_RE.replace_all(&content, "\n\n").to_string();
        content = LEADING_BLANK_RE.replace(&content, "").to_string();
        content.trim().to_string()
    }

    /// Copy the document, enhance form elements, remove comments and empty elements.
    fn clean_html(&self, doc: &Document) -> Document {
        let mut cleaned = dom::clone_document(doc);
        self.enhance_form_elements(&mut cleaned);

        // Remove comment nodes.
        let comments: Vec<NodeId> = cleaned.tree.root().descendants().filter(|n| n.value().is_comment()).map(|n| n.id()).collect();
        for id in comments {
            dom::decompose(&mut cleaned, id);
        }

        // Remove empty elements but preserve form/media elements.
        const KEEP: &[&str] = &["br", "hr", "img", "input", "button", "textarea", "select", "form"];
        const KEEP_INSIDE: &[&str] = &["img", "br", "hr", "input", "button", "textarea", "select"];
        for id in dom::find_all(&cleaned, &[]) {
            let tag = match dom::tag_name(&cleaned, id) {
                Some(t) => t,
                None => continue,
            };
            if KEEP.contains(&tag.as_str()) || matches!(tag.as_str(), "html" | "body" | "head") {
                continue;
            }
            if !dom::has_text(&cleaned, id) && !dom::contains_any(&cleaned, id, KEEP_INSIDE) {
                dom::decompose(&mut cleaned, id);
            }
        }
        cleaned
    }

    /// Apply basic CSS styling by modifying HTML elements.
    fn apply_css_styling(&self, doc: &mut Document, css_rules: &CssRules) {
        // Only rules that change the output matter, and matching goes through one index of the
        // tree: a tree walk per rule was rules x nodes (seconds per render on big sites).
        let relevant = |r: &std::collections::BTreeMap<String, String>| {
            r.get("font-weight").is_some_and(|w| matches!(w.as_str(), "bold" | "700" | "800" | "900"))
                || r.get("font-style").is_some_and(|s| s == "italic")
                || r.get("text-decoration").is_some_and(|s| s.contains("underline"))
                || r.get("display").is_some_and(|s| s == "none")
        };
        let wanted: Vec<(&String, &std::collections::BTreeMap<String, String>)> = css_rules.iter().filter(|(_, r)| relevant(r)).collect();
        if wanted.is_empty() {
            return;
        }
        let mut by_id: std::collections::HashMap<String, Vec<NodeId>> = std::collections::HashMap::new();
        let mut by_class: std::collections::HashMap<String, Vec<NodeId>> = std::collections::HashMap::new();
        let mut by_tag: std::collections::HashMap<String, Vec<NodeId>> = std::collections::HashMap::new();
        for node in doc.tree.root().descendants() {
            let Some(el) = node.value().as_element() else { continue };
            by_tag.entry(el.name().to_string()).or_default().push(node.id());
            if let Some(i) = el.attr("id") {
                by_id.entry(i.to_string()).or_default().push(node.id());
            }
            for c in el.classes() {
                by_class.entry(c.to_string()).or_default().push(node.id());
            }
        }
        for (selector, rules) in wanted {
            let elements: Vec<NodeId> = if let Some(id) = selector.strip_prefix('#') {
                by_id.get(id).and_then(|v| v.first().copied()).into_iter().collect()
            } else if let Some(class) = selector.strip_prefix('.') {
                by_class.get(class).cloned().unwrap_or_default()
            } else if selector.chars().all(|c| c.is_ascii_alphanumeric()) {
                by_tag.get(selector.as_str()).cloned().unwrap_or_default()
            } else {
                Vec::new()
            };
            for id in elements {
                if doc.tree.get(id).is_some_and(|n| n.parent().is_some()) {
                    self.apply_element_styling(doc, id, rules);
                }
            }
        }
    }

    /// Select elements for a simplified selector (`#id`, `.class`, `tag`).
    fn select_elements(&self, doc: &Document, selector: &str) -> Vec<NodeId> {
        if let Some(id) = selector.strip_prefix('#') {
            dom::find_by_id(doc, id).into_iter().collect()
        } else if let Some(class) = selector.strip_prefix('.') {
            dom::find_by_class(doc, class)
        } else if selector.chars().all(|c| c.is_ascii_alphanumeric()) {
            dom::find_all(doc, &[selector])
        } else {
            Vec::new()
        }
    }

    fn apply_element_styling(&self, doc: &mut Document, id: NodeId, rules: &std::collections::BTreeMap<String, String>) {
        if let Some(w) = rules.get("font-weight") {
            if matches!(w.as_str(), "bold" | "700" | "800" | "900") {
                self.wrap_element_content(doc, id, "**", "**");
            }
        }
        if rules.get("font-style").map(|s| s == "italic").unwrap_or(false) {
            self.wrap_element_content(doc, id, "*", "*");
        }
        if rules.get("text-decoration").map(|s| s.contains("underline")).unwrap_or(false) {
            self.wrap_element_content(doc, id, "<u>", "</u>");
        }
        // Stylesheet rules never remove the page itself: the selector may have needed a class or
        // state the simplified matcher ignores (`body.appear`, anti-clickjacking `html` rules).
        if rules.get("display").map(|s| s == "none").unwrap_or(false) && !matches!(dom::tag_name(doc, id).as_deref(), Some("html" | "body" | "main")) {
            dom::decompose(doc, id);
        }
    }

    fn wrap_element_content(&self, doc: &mut Document, id: NodeId, prefix: &str, suffix: &str) {
        if !dom::has_text(doc, id) {
            return;
        }
        // Headings are already emphasised by their markdown syntax.
        if matches!(dom::tag_name(doc, id).as_deref(), Some("h1" | "h2" | "h3" | "h4" | "h5" | "h6")) {
            return;
        }
        // Inline markers go in as raw markdown so they are not escaped.
        dom::prepend_element_with_text(doc, id, "span", prefix);
        dom::append_element_with_text(doc, id, "span", suffix);
    }

    /// Post-process markdown using the dynamic content filter.
    fn post_process_markdown(&self, markdown: &str) -> String {
        let mut md = self.content_filter.filter_content(markdown);
        md = TRIPLE_NL_RE.replace_all(&md, "\n\n").to_string();
        md = LIST_FIX_RE.replace_all(&md, "\n\n- ").to_string();
        md = HEADING_RE.replace_all(&md, "\n\n$1\n\n").to_string();
        md = self.fix_table_formatting(&md);
        md.trim().to_string()
    }

    /// Adjust the dynamic content filter thresholds.
    pub fn configure_filter(&mut self, settings: &HashMap<String, f64>) {
        self.content_filter.update_thresholds(settings);
    }

    /// Enhance form elements for terminal display (rich variant with emoji).
    fn enhance_form_elements(&self, doc: &mut Document) {
        for id in dom::find_all(doc, &["input"]) {
            self.render_input_element(doc, id);
        }
        for id in dom::find_all(doc, &["button"]) {
            self.render_button_element(doc, id);
        }
        for id in dom::find_all(doc, &["textarea"]) {
            self.render_textarea_element(doc, id);
        }
        for id in dom::find_all(doc, &["select"]) {
            self.render_select_element(doc, id);
        }
        for id in dom::find_all(doc, &["form"]) {
            self.render_form_element(doc, id);
        }
    }

    fn render_input_element(&self, doc: &mut Document, id: NodeId) {
        let input_type = dom::attr(doc, id, "type").unwrap_or_else(|| "text".into()).to_ascii_lowercase();
        let name = dom::attr(doc, id, "name").unwrap_or_default();
        let placeholder = dom::attr(doc, id, "placeholder").unwrap_or_default();
        let value = dom::attr(doc, id, "value").unwrap_or_default();
        let or = |a: &str, b: &str| if a.is_empty() { b.to_string() } else { a.to_string() };

        let new_content = match input_type.as_str() {
            "submit" => format!("[🔍 **{}**]", or(&value, "Submit")),
            "button" => format!("[📱 **{}**]", or(&value, "Button")),
            "search" => {
                let t = or(&placeholder, "Search...");
                if value.is_empty() { format!("🔍 [____________] ({t})") } else { format!("🔍 [{value}] ({t})") }
            }
            "text" => {
                let t = if !placeholder.is_empty() { placeholder.clone() } else if !name.is_empty() { name.clone() } else { "Text input".into() };
                if value.is_empty() { format!("📝 [____________] ({t})") } else { format!("📝 [{value}] ({t})") }
            }
            "email" => {
                let t = or(&placeholder, "Email address");
                if value.is_empty() { format!("📧 [____________] ({t})") } else { format!("📧 [{value}] ({t})") }
            }
            "password" => format!("🔒 [••••••••••••] ({})", or(&placeholder, "Password")),
            "checkbox" => {
                let checked = dom::has_attr(doc, id, "checked");
                let label = if !value.is_empty() { value.clone() } else { or(&name, "Option") };
                format!("{} {}", if checked { "☑️" } else { "☐" }, label)
            }
            "radio" => {
                let checked = dom::has_attr(doc, id, "checked");
                let label = if !value.is_empty() { value.clone() } else { or(&name, "Option") };
                format!("{} {}", if checked { "🔘" } else { "⚪" }, label)
            }
            "file" => "📁 [Choose File...] (File upload)".to_string(),
            "range" => {
                let min = dom::attr(doc, id, "min").unwrap_or_else(|| "0".into());
                let max = dom::attr(doc, id, "max").unwrap_or_else(|| "100".into());
                let cur = or(&value, "50");
                format!("🎚️ [{min}◄─────●─────►{max}] ({cur})")
            }
            "hidden" => return,
            other => {
                let mut t = other.to_string();
                if let Some(f) = t.get_mut(0..1) {
                    f.make_ascii_uppercase();
                }
                let generic = if placeholder.is_empty() { format!("{t} input") } else { placeholder.clone() };
                format!("⚙️ [____________] ({generic})")
            }
        };
        dom::convert_to_text_element(doc, id, "span", &new_content);
    }

    fn render_button_element(&self, doc: &mut Document, id: NodeId) {
        let text = crate::forms::button_label(doc, id);
        let button_type = dom::attr(doc, id, "type").unwrap_or_else(|| "button".into()).to_ascii_lowercase();
        let lower = text.to_lowercase();
        let emoji = if button_type == "submit" || lower.contains("submit") {
            "🔍"
        } else if lower.contains("search") {
            "🔍"
        } else if lower.contains("login") || lower.contains("sign in") {
            "🔐"
        } else if lower.contains("menu") {
            "☰"
        } else if lower.contains("close") {
            "❌"
        } else if lower.contains("next") {
            "▶️"
        } else if lower.contains("previous") || lower.contains("prev") {
            "◀️"
        } else if lower.contains("save") {
            "💾"
        } else if lower.contains("delete") {
            "🗑️"
        } else {
            "📱"
        };
        dom::convert_to_text_element(doc, id, "span", &format!("{emoji} **[{text}]**"));
    }

    fn render_textarea_element(&self, doc: &mut Document, id: NodeId) {
        let placeholder = dom::attr(doc, id, "placeholder").unwrap_or_default();
        let content = dom::get_text_stripped(doc, id);
        let bar = "─".repeat(50);
        let new_content = if !content.is_empty() {
            let shown: String = content.chars().take(46).collect();
            format!("📝 **Text Area:**\n┌{bar}┐\n│ {shown:<46} │\n└{bar}┘")
        } else {
            let p = if placeholder.is_empty() { "Enter text here...".to_string() } else { placeholder };
            format!("📝 **Text Area:** ({p})\n┌{bar}┐\n│{}│\n└{bar}┘", " ".repeat(50))
        };
        dom::convert_to_text_element(doc, id, "div", &new_content);
    }

    fn render_select_element(&self, doc: &mut Document, id: NodeId) {
        let options = dom::find_all_within(doc, id, &["option"]);
        let mut selected = options
            .iter()
            .find(|o| dom::has_attr(doc, **o, "selected"))
            .map(|o| dom::get_text_stripped(doc, *o));
        if selected.as_deref().map(|s| s.is_empty()).unwrap_or(true) {
            selected = options.first().map(|o| dom::get_text_stripped(doc, *o));
        }
        let selected = selected.filter(|s| !s.is_empty()).unwrap_or_else(|| "Select option".into());
        let count = options.len();
        dom::convert_to_text_element(doc, id, "span", &format!("📋 **[{selected} ▼]** ({count} options)"));
    }

    fn render_form_element(&self, doc: &mut Document, id: NodeId) {
        let action = dom::attr(doc, id, "action").unwrap_or_default();
        let method = dom::attr(doc, id, "method").unwrap_or_else(|| "GET".into()).to_ascii_uppercase();
        let info = if action.is_empty() { format!(" ({method})") } else { format!(" → {method} {action}") };
        let bar = "─".repeat(60);
        dom::prepend_element_with_text(doc, id, "div", &format!("📋 **Form**{info}\n{bar}\n"));
        dom::append_element_with_text(doc, id, "div", &format!("\n{bar}"));
    }

    fn fix_table_formatting(&self, markdown: &str) -> String {
        TABLE_ROW_RE.replace_all(markdown, "\n\n$1\n").to_string()
    }

    /// Print markdown to the terminal (Rich `console.print(Markdown)` analogue).
    pub fn render_to_terminal(&self, markdown: &str) {
        println!("{}", crate::terminal::render_markdown(markdown));
    }

    /// Build a table of links.
    pub fn create_link_table(&self, links: &[(String, String)]) -> Table {
        let mut table = Table::new();
        table
            .load_style(UTF8_FULL)
            .set_content_arrangement(ContentArrangement::Dynamic)
            .set_header(vec![Cell::new("Text").fg(Color::Magenta), Cell::new("URL").fg(Color::Magenta)]);
        for (text, url) in links.iter().take(20) {
            let t: String = if text.chars().count() > 50 { format!("{}...", text.chars().take(50).collect::<String>()) } else { text.clone() };
            let u: String = if url.chars().count() > 60 { format!("{}...", url.chars().take(60).collect::<String>()) } else { url.clone() };
            table.add_row(vec![Cell::new(t).fg(Color::Cyan), Cell::new(u).fg(Color::Blue)]);
        }
        table
    }

    /// Build a page-information panel (as text).
    pub fn create_page_info_panel(&self, info: &std::collections::BTreeMap<String, String>) -> String {
        let mut content = Vec::new();
        if let Some(t) = info.get("title").filter(|s| !s.is_empty()) {
            content.push(format!("Title: {t}"));
        }
        if let Some(u) = info.get("url").filter(|s| !s.is_empty()) {
            content.push(format!("URL: {u}"));
        }
        if let Some(d) = info.get("description").filter(|s| !s.is_empty()) {
            content.push(format!("Description: {d}"));
        }
        let body = if content.is_empty() { "No page information available".to_string() } else { content.join("\n") };
        crate::terminal::panel("Page Information", &body)
    }

    /// Extract meaningful content and filter technical clutter.
    fn extract_meaningful_content(&self, markdown: &str) -> String {
        if markdown.is_empty() {
            return String::new();
        }
        let mut clean: Vec<String> = Vec::new();
        for line in markdown.split('\n') {
            let line = line.trim();
            if line.is_empty() {
                if clean.last().map(|l| !l.is_empty()).unwrap_or(false) {
                    clean.push(String::new());
                }
                continue;
            }
            if is_meaningful_line(line, EXTENDED_TECHNICAL_PATTERNS, true) {
                clean.push(line.to_string());
            }
        }
        while clean.last().map(|l| l.is_empty()).unwrap_or(false) {
            clean.pop();
        }
        clean.join("\n")
    }
}

/// Remove `## <header>` sections (until the next `##` header or the end).
pub fn remove_sections(content: &str, headers: &[&str]) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in content.split('\n') {
        if line.starts_with("##") {
            skipping = headers.iter().any(|h| line.starts_with(h));
        }
        if !skipping {
            out.push(line);
        }
    }
    out.join("\n")
}

pub const BASIC_TECHNICAL_PATTERNS: &[&str] = &[
    "javascript:", "function(", "var ", "const ", "let ", "href=", "src=", "class=", "id=", "style=", "<!doctype", "<html", "<head",
    "<script", "<style", "{", "}", "();", "return ", "window.", "document.", "console.", "addeventlistener", "settimeout",
];

pub const EXTENDED_TECHNICAL_PATTERNS: &[&str] = &[
    "javascript:", "function(", "var ", "const ", "let ", "href=", "src=", "class=", "id=", "style=", "<!doctype", "<html", "<head",
    "<script", "<style", "{", "}", "();", "return ", "window.", "document.", "console.", "addeventlistener", "settimeout", "config.",
    "contexthub.", ".customenvironment", ".beaconurl", ".adrumext", "cdcext.", "cdclocale.", "cpe.config", "cpe.version", "maxurllength",
    "paths.contexthub", "paths.resource", "paths.segmentation", "cq_context", "anonymous_home", "targetedcomponent", ".style.visibility",
    ".cdn.", "/content/dam/", "icon_", ".svg)", "if (targetedcomponent)", "// make the targeted", "/\\*", "\\*/", "hidemethod",
    "setting paths", "setting initial",
];

/// Decide whether a rendered line is meaningful content.
pub fn is_meaningful_line(line: &str, patterns: &[&str], extended_checks: bool) -> bool {
    if line.trim().chars().count() < 3 {
        return false;
    }
    let lower = line.to_lowercase();
    if patterns.iter().any(|p| lower.contains(p)) {
        return false;
    }
    let total = line.chars().count() as f64;
    let alpha = line.chars().filter(|c| c.is_alphabetic()).count() as f64;
    if alpha < total * 0.3 {
        return false;
    }
    if extended_checks {
        if line.contains('=') && [".config", ".Paths", ".Constants", "appKey", "version"].iter().any(|p| line.contains(p)) {
            return false;
        }
        if line.matches('/').count() > 3 {
            return false;
        }
    }
    true
}
