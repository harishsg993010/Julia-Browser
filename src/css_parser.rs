//! CSS Parser - extracts and parses CSS rules from HTML pages.

use crate::dom::{self, Document};
use crate::http::HttpClient;
use base64::Engine as _;
use regex::Regex;
use std::collections::BTreeMap;
use std::sync::LazyLock;
use url::Url;

/// `{selector: {property: value}}`
pub type CssRules = BTreeMap<String, BTreeMap<String, String>>;

static COMMENT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)/\*.*?\*/").unwrap());
static RULE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)([^{}]+)\{([^}]*)\}").unwrap());

/// Parsed external stylesheets by URL, with when they were fetched: every `read()` used to fetch
/// and regex-parse each sheet again, one after another (seconds per call on large sites).
static EXTERNAL_CSS: LazyLock<std::sync::Mutex<std::collections::HashMap<String, (std::sync::Arc<CssRules>, std::time::Instant)>>> = LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
const EXTERNAL_CSS_TTL_SECS: u64 = 120;

fn external_css_get(url: &str) -> Option<std::sync::Arc<CssRules>> {
    let cache = EXTERNAL_CSS.lock().unwrap();
    let (rules, at) = cache.get(url)?;
    (at.elapsed().as_secs() < EXTERNAL_CSS_TTL_SECS).then(|| rules.clone())
}

fn external_css_put(url: &str, rules: CssRules) -> std::sync::Arc<CssRules> {
    let rules = std::sync::Arc::new(rules);
    let mut cache = EXTERNAL_CSS.lock().unwrap();
    if cache.len() >= 256 {
        cache.retain(|_, (_, at)| at.elapsed().as_secs() < EXTERNAL_CSS_TTL_SECS);
        if cache.len() >= 256 {
            cache.clear();
        }
    }
    cache.insert(url.to_string(), (rules.clone(), std::time::Instant::now()));
    rules
}

/// Parses CSS from HTML pages and converts rules to a usable format.
#[derive(Default)]
pub struct CssParser {
    /// Client used to fetch external stylesheets (optional).
    pub client: Option<HttpClient>,
    /// Whether external `<link rel=stylesheet>` sheets are fetched.
    pub fetch_external: bool,
}

impl CssParser {
    pub fn new(client: Option<HttpClient>) -> Self {
        Self { client, fetch_external: true }
    }

    /// Extract all CSS rules from an HTML document.
    pub fn extract_css_from_document(&self, doc: &Document, base_url: Option<&str>) -> CssRules {
        let mut all_rules = CssRules::new();
        all_rules.extend(self.extract_inline_styles(doc));
        all_rules.extend(self.extract_embedded_css(doc));
        if self.fetch_external {
            all_rules.extend(self.extract_external_css(doc, base_url));
        }
        all_rules
    }

    /// Rules from `style="..."` attributes, keyed by `#id`, `.class` or `tag-inline-N`.
    fn extract_inline_styles(&self, doc: &Document) -> CssRules {
        let mut rules = CssRules::new();
        for (i, id) in dom::find_with_attr(doc, "style").into_iter().enumerate() {
            let style_attr = dom::attr(doc, id, "style").unwrap_or_default();
            if style_attr.is_empty() {
                continue;
            }
            let selector = if let Some(el_id) = dom::attr(doc, id, "id") {
                format!("#{el_id}")
            } else if let Some(class) = dom::attr(doc, id, "class") {
                match class.split_whitespace().next() {
                    Some(first) => format!(".{first}"),
                    None => format!("{}-inline-{i}", dom::tag_name(doc, id).unwrap_or_default()),
                }
            } else {
                format!("{}-inline-{i}", dom::tag_name(doc, id).unwrap_or_default())
            };
            let parsed = parse_css_properties(&style_attr);
            if !parsed.is_empty() {
                rules.insert(selector, parsed);
            }
        }
        rules
    }

    /// Rules from `<style>` elements.
    fn extract_embedded_css(&self, doc: &Document) -> CssRules {
        let mut rules = CssRules::new();
        for id in dom::find_all(doc, &["style"]) {
            let css = dom::get_text(doc, id);
            if !css.trim().is_empty() {
                rules.extend(parse_css_content(&css));
            }
        }
        rules
    }

    /// Rules from external stylesheets (`<link rel="stylesheet" href=...>`).
    fn extract_external_css(&self, doc: &Document, base_url: Option<&str>) -> CssRules {
        let mut rules = CssRules::new();
        let client = match &self.client {
            Some(c) => c,
            None => return rules,
        };
        let mut sheets: Vec<String> = Vec::new();
        for id in dom::find_all(doc, &["link"]) {
            let rel = dom::attr(doc, id, "rel").unwrap_or_default().to_ascii_lowercase();
            if !rel.split_whitespace().any(|r| r == "stylesheet") {
                continue;
            }
            let href = match dom::attr(doc, id, "href") {
                Some(h) if !h.trim().is_empty() => h.trim().to_string(),
                _ => continue,
            };
            if href.starts_with("data:") {
                if let Some(css) = parse_data_uri(&href) {
                    rules.extend(parse_css_content(&css));
                }
                continue;
            }
            if let Some(url) = resolve_href(&href, base_url) {
                if !sheets.contains(&url) {
                    sheets.push(url);
                }
            }
        }
        // missing sheets in parallel, then every sheet in document order
        let missing: Vec<String> = sheets.iter().filter(|u| external_css_get(u).is_none()).cloned().collect();
        if !missing.is_empty() {
            let queue = std::sync::Mutex::new(missing);
            std::thread::scope(|scope| {
                for _ in 0..8 {
                    scope.spawn(|| loop {
                        let Some(url) = queue.lock().unwrap().pop() else { break };
                        let parsed = match client.get_simple(&url, 10) {
                            Ok(resp) if resp.status == 200 => parse_css_content(&resp.text),
                            _ => CssRules::new(),
                        };
                        external_css_put(&url, parsed);
                    });
                }
            });
        }
        for url in &sheets {
            if let Some(parsed) = external_css_get(url) {
                rules.extend(parsed.iter().map(|(k, v)| (k.clone(), v.clone())));
            }
        }
        rules
    }

    /// Computed styles for an element selector (simplified: no specificity).
    pub fn get_element_styles(&self, element_selector: &str, all_rules: &CssRules) -> BTreeMap<String, String> {
        let mut computed = BTreeMap::new();
        for (selector, rules) in all_rules {
            if selector_matches(selector, element_selector) {
                computed.extend(rules.clone());
            }
        }
        computed
    }

    /// Font-related declarations only.
    pub fn get_font_styles(&self, rules: &CssRules) -> CssRules {
        let mut out = CssRules::new();
        for (selector, props) in rules {
            for (prop, value) in props {
                if prop.starts_with("font-") || matches!(prop.as_str(), "color" | "text-decoration" | "text-transform") {
                    out.entry(selector.clone()).or_default().insert(prop.clone(), value.clone());
                }
            }
        }
        out
    }

    /// Layout-related declarations only.
    pub fn get_layout_styles(&self, rules: &CssRules) -> CssRules {
        const LAYOUT: &[&str] = &["display", "position", "float", "clear", "width", "height", "margin", "padding", "border", "background"];
        let mut out = CssRules::new();
        for (selector, props) in rules {
            for (prop, value) in props {
                if LAYOUT.iter().any(|l| prop.starts_with(l)) {
                    out.entry(selector.clone()).or_default().insert(prop.clone(), value.clone());
                }
            }
        }
        out
    }
}

fn resolve_href(href: &str, base_url: Option<&str>) -> Option<String> {
    if href.starts_with("//") {
        return Some(format!("https:{href}"));
    }
    if href.starts_with("http://") || href.starts_with("https://") {
        return Some(href.to_string());
    }
    let base = Url::parse(base_url?).ok()?;
    base.join(href).ok().map(|u| u.to_string())
}

/// Parse the CSS payload of a `data:text/css...` URI.
pub fn parse_data_uri(data_uri: &str) -> Option<String> {
    let content = data_uri.strip_prefix("data:")?;
    if !content.starts_with("text/css") {
        return None;
    }
    let comma = content.find(',')?;
    let (header, payload) = (&content[..comma], &content[comma + 1..]);
    if header.contains(";base64") {
        let bytes = base64::engine::general_purpose::STANDARD.decode(payload).ok()?;
        String::from_utf8(bytes).ok()
    } else {
        Some(percent_encoding::percent_decode_str(payload).decode_utf8_lossy().into_owned())
    }
}

/// Parse CSS text into `{selector: {prop: value}}` (simplified, no nesting).
pub fn parse_css_content(css: &str) -> CssRules {
    let mut rules = CssRules::new();
    let css = COMMENT_RE.replace_all(css, "");
    for cap in RULE_RE.captures_iter(&css) {
        let selector_group = cap[1].trim();
        // Skip at-rule preludes such as "@media (...)" that precede a nested block.
        let selector_group = match selector_group.rfind('}') {
            Some(pos) => selector_group[pos + 1..].trim(),
            None => selector_group,
        };
        let props = parse_css_properties(&cap[2]);
        if props.is_empty() {
            continue;
        }
        for selector in selector_group.split(',') {
            let selector = selector.trim();
            if selector.is_empty() || selector.starts_with('@') {
                continue;
            }
            rules.insert(selector.to_string(), props.clone());
        }
    }
    rules
}

/// Parse `a: b; c: d` into a map.
pub fn parse_css_properties(properties: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for pair in properties.split(';') {
        if let Some(idx) = pair.find(':') {
            let key = pair[..idx].trim().to_ascii_lowercase();
            let value = pair[idx + 1..].trim();
            if !key.is_empty() && !value.is_empty() {
                out.insert(key, value.to_string());
            }
        }
    }
    out
}

fn selector_matches(css_selector: &str, element_selector: &str) -> bool {
    let css = css_selector.trim().to_ascii_lowercase();
    let el = element_selector.trim().to_ascii_lowercase();
    if css == el {
        return true;
    }
    let tag = el.split('#').next().unwrap_or("").split('.').next().unwrap_or("");
    if css == tag {
        return true;
    }
    if css.starts_with('#') && format!("#{el}") == css {
        return true;
    }
    if css.starts_with('.') && format!(".{el}") == css {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rules() {
        let rules = parse_css_content("/* c */ h1, .x { color: red; font-weight: bold } #y{display:none}");
        assert_eq!(rules["h1"]["color"], "red");
        assert_eq!(rules[".x"]["font-weight"], "bold");
        assert_eq!(rules["#y"]["display"], "none");
    }
}
