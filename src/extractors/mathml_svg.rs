//! MathML and SVG Text Extraction.

use super::{find_by_class_regex, take};
use crate::dom::{self, Document};
use ego_tree::NodeId;
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

const MATH_ENTITIES: &[(&str, &str)] = &[
    ("&plus;", "+"), ("&minus;", "−"), ("&times;", "×"), ("&divide;", "÷"), ("&equals;", "="), ("&ne;", "≠"), ("&lt;", "<"), ("&gt;", ">"),
    ("&le;", "≤"), ("&ge;", "≥"), ("&plusmn;", "±"), ("&infin;", "∞"), ("&int;", "∫"), ("&sum;", "∑"), ("&prod;", "∏"), ("&part;", "∂"),
    ("&nabla;", "∇"), ("&radic;", "√"), ("&prop;", "∝"), ("&empty;", "∅"), ("&isin;", "∈"), ("&notin;", "∉"), ("&ni;", "∋"), ("&cap;", "∩"),
    ("&cup;", "∪"), ("&sub;", "⊂"), ("&sup;", "⊃"), ("&nsub;", "⊄"), ("&sube;", "⊆"), ("&supe;", "⊇"), ("&oplus;", "⊕"), ("&otimes;", "⊗"),
    ("&perp;", "⊥"), ("&sdot;", "⋅"), ("&lceil;", "⌈"), ("&rceil;", "⌉"), ("&lfloor;", "⌊"), ("&rfloor;", "⌋"), ("&lang;", "⟨"), ("&rang;", "⟩"),
];

static DISPLAY_MATH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)\$\$([^$]+)\$\$").unwrap());
static INLINE_MATH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$([^$\n]+)\$").unwrap());
static LATEX_ENV_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)\\begin\{([^}]+)\}(.*?)\\end\{[^}]+\}").unwrap());
static LATEX_CMD_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\([a-zA-Z]+)(\{[^}]*\})*").unwrap());
static MATH_SCRIPT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"math|tex").unwrap());
static MATH_CLASS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"math|formula|equation|expression").unwrap());
static MATRIX_CLASS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"matrix|math").unwrap());
static MATH_INDICATORS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"[+\-*/=<>≤≥≠±∞∑∏∫∂∇√π∈∉⊂⊃∩∪]",
        r"\b\d+\s*[+\-*/]\s*\d+",
        r"\b[a-zA-Z]\s*[=<>]\s*\d+",
        r"(?i)\b(sin|cos|tan|log|ln|exp|sqrt|abs)\s*\(",
        r"\^\d+|\b\d+\^\d+",
        r"(?i)\b(matrix|vector|equation|formula|theorem|proof)\b",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});
static NUMBER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-+]?\d*\.?\d+([eE][-+]?\d+)?$").unwrap());
static VARIABLE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-zA-Z][a-zA-Z0-9]{0,2}$").unwrap());
static EXPR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[+\-*/=<>√∑∏∫]").unwrap());

pub fn extract(doc: &Document, _js_context: &Value) -> String {
    let mut out = Vec::new();
    out.extend(mathml_formulas(doc));
    out.extend(svg_text(doc));
    out.extend(latex_math(doc));
    out.extend(ascii_math(doc));
    if out.is_empty() {
        String::new()
    } else {
        format!("\n## 🔢 Mathematical Content & Graphics\n{}\n", out.join("\n"))
    }
}

fn mathml_formulas(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    let maths = dom::find_all(doc, &["math"]);
    for m in &maths {
        let text = convert_mathml_to_text(doc, *m);
        if !text.trim().is_empty() {
            out.push(format!("📐 Formula: {text}"));
        }
    }
    if maths.is_empty() {
        for mi in dom::find_all(doc, &["mi"]) {
            let t = dom::get_text_stripped(doc, mi);
            if !t.is_empty() && t.chars().count() <= 5 {
                out.push(format!("🔤 Variable: {t}"));
            }
        }
        for mn in dom::find_all(doc, &["mn"]) {
            let t = dom::get_text_stripped(doc, mn);
            if !t.is_empty() {
                out.push(format!("🔢 Number: {t}"));
            }
        }
        let ops: Vec<String> = dom::find_all(doc, &["mo"]).into_iter().map(|o| dom::get_text_stripped(doc, o)).filter(|t| !t.is_empty()).collect();
        if !ops.is_empty() {
            out.push(format!("➕ Operators: {}", ops.join(" ")));
        }
    }
    out
}

/// Convert a MathML subtree to readable text (fractions, powers, roots).
fn convert_mathml_to_text(doc: &Document, id: NodeId) -> String {
    fn walk(doc: &Document, id: NodeId, out: &mut Vec<String>) {
        let node = match doc.tree.get(id) {
            Some(n) => n,
            None => return,
        };
        match node.value() {
            scraper::Node::Text(t) => {
                let s = t.trim();
                if !s.is_empty() {
                    out.push(s.to_string());
                }
            }
            scraper::Node::Element(el) => {
                let tag = el.name().to_ascii_lowercase();
                let kids: Vec<NodeId> = node.children().filter(|c| c.value().is_element()).map(|c| c.id()).collect();
                let text_of = |k: NodeId| dom::get_text_sep(doc, k, " ", true);
                match tag.as_str() {
                    "mfrac" if kids.len() >= 2 => out.push(format!("({}/{})", text_of(kids[0]), text_of(kids[1]))),
                    "msup" if kids.len() >= 2 => out.push(format!("{}^{}", text_of(kids[0]), text_of(kids[1]))),
                    "msub" if kids.len() >= 2 => out.push(format!("{}_{}", text_of(kids[0]), text_of(kids[1]))),
                    "msqrt" => out.push(format!("√{}", dom::get_text_stripped(doc, id))),
                    "mroot" if kids.len() >= 2 => out.push(format!("√[{}]{}", text_of(kids[1]), text_of(kids[0]))),
                    _ => {
                        for c in node.children() {
                            walk(doc, c.id(), out);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let mut parts = Vec::new();
    walk(doc, id, &mut parts);
    let mut text = parts.join(" ");
    for (entity, symbol) in MATH_ENTITIES {
        text = text.replace(entity, symbol);
    }
    text
}

fn svg_text(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for svg in dom::find_all(doc, &["svg"]) {
        if let Some(t) = dom::find_all_within(doc, svg, &["title"]).first() {
            let text = dom::get_text_stripped(doc, *t);
            if !text.is_empty() {
                out.push(format!("🎨 SVG Title: {text}"));
            }
        }
        if let Some(d) = dom::find_all_within(doc, svg, &["desc"]).first() {
            let text = dom::get_text_stripped(doc, *d);
            if !text.is_empty() {
                out.push(format!("📝 SVG Description: {text}"));
            }
        }
        for t in dom::find_all_within(doc, svg, &["text", "tspan"]) {
            let text = dom::get_text_stripped(doc, t);
            if !text.is_empty() {
                let x = dom::attr(doc, t, "x").unwrap_or_default();
                let y = dom::attr(doc, t, "y").unwrap_or_default();
                let pos = if !x.is_empty() && !y.is_empty() { format!(" at ({x},{y})") } else { String::new() };
                out.push(format!("📄 SVG Text{pos}: {text}"));
            }
        }
        for tp in dom::find_all_within(doc, svg, &["textpath"]) {
            let text = dom::get_text_stripped(doc, tp);
            if !text.is_empty() {
                out.push(format!("🛤️ SVG Path Text: {text}"));
            }
        }
    }
    out
}

fn latex_math(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    let page_text = dom::document_text(doc);
    for c in DISPLAY_MATH_RE.captures_iter(&page_text) {
        out.push(format!("🔤 Display Math: {}...", take(c[1].trim(), 100)));
    }
    for c in INLINE_MATH_RE.captures_iter(&page_text) {
        out.push(format!("🔤 Inline Math: {}...", take(c[1].trim(), 100)));
    }
    for c in LATEX_ENV_RE.captures_iter(&page_text) {
        if !c[1].is_empty() && !c[2].trim().is_empty() {
            out.push(format!("📚 LaTeX Environment ({}): {}...", &c[1], take(c[2].trim(), 100)));
        }
    }
    for c in LATEX_CMD_RE.captures_iter(&page_text) {
        out.push(format!("🔤 LaTeX Command: {}...", take(c[1].trim(), 100)));
    }
    for script in dom::find_all(doc, &["script"]) {
        if MATH_SCRIPT_RE.is_match(&dom::attr(doc, script, "type").unwrap_or_default()) {
            let content = dom::get_text_stripped(doc, script);
            if !content.is_empty() {
                out.push(format!("🧮 Math Script: {}...", take(&content, 100)));
            }
        }
    }
    out
}

fn ascii_math(doc: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for code in dom::find_all(doc, &["code", "pre", "kbd", "samp"]) {
        let content = dom::get_text_stripped(doc, code);
        if !content.is_empty() && looks_like_math(&content) {
            out.push(format!("💻 ASCII Math: {}...", take(&content, 100)));
        }
    }
    for id in find_by_class_regex(doc, &MATH_CLASS_RE) {
        let content = dom::get_text_stripped(doc, id);
        if !content.is_empty() && !dom::contains_any(doc, id, &["math", "svg"]) {
            out.push(format!("🔢 Math Expression: {}...", take(&content, 100)));
        }
    }
    for table in dom::find_all(doc, &["table"]) {
        if !MATRIX_CLASS_RE.is_match(&dom::attr(doc, table, "class").unwrap_or_default()) {
            continue;
        }
        let rows = dom::find_all_within(doc, table, &["tr"]);
        if rows.is_empty() || rows.len() > 10 {
            continue;
        }
        let mut matrix = Vec::new();
        for row in rows {
            let cells: Vec<String> = dom::find_all_within(doc, row, &["td", "th"]).into_iter().map(|c| dom::get_text_stripped(doc, c)).collect();
            if !cells.is_empty() && cells.iter().all(|c| is_numeric_or_variable(c)) {
                matrix.push(cells.join(" "));
            }
        }
        if !matrix.is_empty() {
            out.push(format!("📊 Math Matrix:\n  {}", matrix.join("\n  ")));
        }
    }
    out
}

fn looks_like_math(text: &str) -> bool {
    MATH_INDICATORS.iter().any(|re| re.is_match(text))
}

fn is_numeric_or_variable(text: &str) -> bool {
    let t = text.trim();
    !t.is_empty() && (NUMBER_RE.is_match(t) || VARIABLE_RE.is_match(t) || EXPR_RE.is_match(t))
}
