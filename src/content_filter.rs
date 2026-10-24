//! Dynamic Content Filter - identifies and removes noise from rendered content.

use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

static CSS_SEL_RE1: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[.#][a-zA-Z][\w-]*\{").unwrap());
static CSS_SEL_RE2: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[.#][a-zA-Z][\w-]*[,\s.#:\w-]*\{").unwrap());
static CSS_PROP_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-zA-Z-]+\s*:\s*[^;]+;?\s*$").unwrap());
static IMG_ALT_RE1: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[!\[(.*?)\]").unwrap());
static IMG_ALT_RE2: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\[(.*?)\]").unwrap());
static DATA_IMG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"data:image/(\w+)").unwrap());
static QUOTED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"["']([^"']{10,50})["']"#).unwrap());

/// Tunable thresholds.
#[derive(Debug, Clone)]
pub struct NoiseIndicators {
    pub repetition_threshold: f64,
    pub length_threshold: f64,
    pub bracket_density: f64,
    pub json_like_threshold: f64,
    pub code_density: f64,
}

impl Default for NoiseIndicators {
    fn default() -> Self {
        Self {
            repetition_threshold: 0.7,
            length_threshold: 150.0,
            bracket_density: 0.3,
            json_like_threshold: 0.5,
            code_density: 0.4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum LineType {
    Empty,
    FrameworkConfig,
    JsonConfig,
    JavascriptDeclaration,
    PerformanceTracking,
    CssRule,
    ImageData,
    ModuleImport,
    EncodedData,
    UrlOrReference,
    ReadableText,
    MarkdownStructure,
    StructuredData,
    HtmlTag,
    MixedContent,
}

struct CharCounts {
    letters: usize,
    digits: usize,
    brackets: usize,
    quotes: usize,
    punctuation: usize,
    special: usize,
}

struct LineStats {
    lengths: Vec<usize>,
    line_types: Vec<LineType>,
}

/// Dynamically identifies and filters content noise patterns.
#[derive(Debug, Clone, Default)]
pub struct DynamicContentFilter {
    pub noise_indicators: NoiseIndicators,
}

impl DynamicContentFilter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Filter content based on statistical and pattern analysis.
    pub fn filter_content(&self, content: &str) -> String {
        let lines: Vec<&str> = content.split('\n').collect();
        let stats = self.analyze_lines(&lines);
        let noise = self.identify_noise_lines(&lines, &stats);
        self.filter_with_context(&lines, &noise, &stats).join("\n")
    }

    fn analyze_lines(&self, lines: &[&str]) -> LineStats {
        let mut stats = LineStats {
            lengths: lines.iter().map(|l| l.trim().len()).collect(),
            line_types: Vec::with_capacity(lines.len()),
        };
        for line in lines {
            let stripped = line.trim();
            if stripped.is_empty() {
                stats.line_types.push(LineType::Empty);
                continue;
            }
            let counts = char_counts(stripped);
            stats.line_types.push(self.classify_line_type(stripped, &counts));
        }
        stats
    }

    fn classify_line_type(&self, line: &str, c: &CharCounts) -> LineType {
        let total = line.chars().count() as f64;
        if total == 0.0 {
            return LineType::Empty;
        }
        let ratio = |n: usize| n as f64 / total;
        let lower = line.to_lowercase();

        if line.starts_with("{\"require\":[") || line.contains("handlePayload") {
            LineType::FrameworkConfig
        } else if line.starts_with("{\"") && ratio(c.brackets) > 0.2 && ratio(c.quotes) > 0.15 {
            LineType::JsonConfig
        } else if ["function", "var ", "const ", "let ", "window.", "import "].iter().any(|p| line.starts_with(p)) {
            LineType::JavascriptDeclaration
        } else if lower.contains("qpl") && (lower.contains("server") || lower.contains("timing")) {
            LineType::PerformanceTracking
        } else if self.is_css_rule(line) {
            LineType::CssRule
        } else if self.is_image_data(line) {
            LineType::ImageData
        } else if self.is_module_import(line) {
            LineType::ModuleImport
        } else if ratio(c.special) > 0.5 || ratio(c.digits) > 0.4 {
            LineType::EncodedData
        } else if ["http", "data:", "//", "src="].iter().any(|p| line.starts_with(p)) {
            LineType::UrlOrReference
        } else if ratio(c.letters) > 0.6 && ratio(c.punctuation) < 0.1 && line.trim().len() > 10 {
            LineType::ReadableText
        } else if line.starts_with(['#', '*', '-', '+']) {
            LineType::MarkdownStructure
        } else if ratio(c.brackets) > 0.2 && ratio(c.quotes) > 0.1 {
            LineType::StructuredData
        } else if line.trim().starts_with('<') && line.trim().ends_with('>') {
            LineType::HtmlTag
        } else {
            LineType::MixedContent
        }
    }

    fn identify_noise_lines(&self, lines: &[&str], stats: &LineStats) -> HashSet<usize> {
        let mut noise = HashSet::new();

        for (i, line) in lines.iter().enumerate() {
            let s = line.trim();
            if s.is_empty() {
                continue;
            }
            let js_patterns = ["window[", "tesla_cta[", "sl_tr_", "qpl_", "handlePayload", "function(", "var ", "let ", "const ", "();"];
            let keep_words = ["tesla", "cybertruck", "solar", "energy", "cars"];
            let lower = s.to_lowercase();
            if js_patterns.iter().any(|p| s.contains(p)) && !keep_words.iter().any(|k| lower.contains(k)) {
                noise.insert(i);
                continue;
            }
            if s.starts_with('"') && s.contains("\":") && !["slide", "image", "delivery", "autonomous"].iter().any(|k| lower.contains(k)) {
                noise.insert(i);
                continue;
            }
            let css_cfg = ["marginBlock", "paddingBlock", "gridRows", "gridCols", "mobileConfigOverwrite", "tabletConfigOverwrite"];
            if css_cfg.iter().any(|p| s.contains(p)) && s.matches(':').count() > 1 {
                noise.insert(i);
                continue;
            }
        }

        let length_threshold = if stats.lengths.is_empty() {
            self.noise_indicators.length_threshold
        } else {
            let avg = stats.lengths.iter().sum::<usize>() as f64 / stats.lengths.len() as f64;
            (avg * 2.0).max(self.noise_indicators.length_threshold)
        };

        let noise_types = [
            LineType::FrameworkConfig,
            LineType::JsonConfig,
            LineType::EncodedData,
            LineType::JavascriptDeclaration,
            LineType::PerformanceTracking,
            LineType::CssRule,
            LineType::ModuleImport,
        ];

        for (i, line) in lines.iter().enumerate() {
            let s = line.trim();
            if s.is_empty() {
                continue;
            }
            let lt = stats.line_types[i];
            let is_noise = noise_types.contains(&lt)
                || (s.len() as f64) > length_threshold
                || (s.len() > 80 && matches!(lt, LineType::StructuredData | LineType::MixedContent))
                || self.has_excessive_repetition(s)
                || self.has_high_noise_density(s)
                || self.is_framework_noise(s);
            if is_noise {
                noise.insert(i);
            }
        }
        noise
    }

    fn has_excessive_repetition(&self, line: &str) -> bool {
        if line.len() < 10 {
            return false;
        }
        let mut freq: HashMap<char, usize> = HashMap::new();
        for c in line.to_lowercase().chars() {
            *freq.entry(c).or_default() += 1;
        }
        let total = line.chars().count() as f64;
        freq.iter().any(|(c, n)| c.is_alphanumeric() && *n as f64 / total > self.noise_indicators.repetition_threshold)
    }

    fn has_high_noise_density(&self, line: &str) -> bool {
        let noise_chars = "{}[]()\":;,=&%@#$";
        let count = line.chars().filter(|c| noise_chars.contains(*c)).count();
        count as f64 / line.chars().count().max(1) as f64 > self.noise_indicators.code_density
    }

    fn is_framework_noise(&self, line: &str) -> bool {
        let lower = line.to_lowercase();
        let terms = ["preloader", "bootstrap", "payload", "timing", "consistency", "server", "config", "handle", "import ", "from \"", "cdn.", ".js\""];
        let indicators = [
            line.matches('"').count() > 6,
            line.matches('[').count() > 3,
            line.matches(',').count() > 5,
            line.contains("null") && line.matches("null").count() > 2,
            terms.iter().any(|t| lower.contains(t)) && line.len() > 50,
            (line.contains("//") || lower.contains("http")) && line.len() > 100,
            line.split_whitespace().any(|p| p.len() > 20 && p.replace(['_', '-'], "").chars().all(|c| c.is_alphanumeric())),
        ];
        indicators.iter().filter(|b| **b).count() >= 2
    }

    fn is_css_rule(&self, line: &str) -> bool {
        let s = line.trim();
        let props = ["display", "padding", "margin", "width", "height", "color", "background", "font", "border", "position", "flex", "grid", "z-index"];
        CSS_SEL_RE1.is_match(s)
            || CSS_SEL_RE2.is_match(s)
            || CSS_PROP_RE.is_match(s)
            || (s.contains(':') && s.contains('{') && props.iter().any(|p| s.contains(p)))
            || s.starts_with("@media")
            || s.starts_with('@')
            || (s.len() > 60
                && s.matches(':').count() >= 2
                && ["px", "em", "rem", "auto", "none", "flex"].iter().any(|u| s.contains(u)))
    }

    fn is_image_data(&self, line: &str) -> bool {
        let s = line.trim();
        if s.starts_with("data:image/") {
            return true;
        }
        if s.contains("base64,") && (s.contains("data:image") || s.len() > 100) {
            return true;
        }
        s.len() > 200 && s.replace(['/', '+', '='], "").chars().all(|c| c.is_alphanumeric())
    }

    fn simplify_image_line(&self, line: &str) -> String {
        let s = line.trim();
        if s.starts_with("[![") {
            if let Some(c) = IMG_ALT_RE1.captures(s) {
                let alt = &c[1];
                return if alt.is_empty() { "[Image supported]".into() } else { format!("[Image: {alt}]") };
            }
        } else if s.starts_with("![") {
            if let Some(c) = IMG_ALT_RE2.captures(s) {
                let alt = &c[1];
                return if alt.is_empty() { "[Image supported]".into() } else { format!("[Image: {alt}]") };
            }
        } else if s.contains("data:image/") {
            if let Some(c) = DATA_IMG_RE.captures(s) {
                return format!("[Image: {} format supported]", c[1].to_uppercase());
            }
        }
        "[Image supported]".to_string()
    }

    fn is_module_import(&self, line: &str) -> bool {
        let s = line.trim();
        s.starts_with("import ")
            || s.starts_with("export ")
            || (s.contains("from \"http") && s.contains(".js\""))
            || (s.contains("cdn.") && (s.contains(".js\"") || s.contains(".css\"")))
            || s.starts_with("import(")
            || s.contains("oaistatic.com")
            || (s.contains("assets/") && s.contains(".js"))
    }

    fn filter_with_context(&self, lines: &[&str], noise: &HashSet<usize>, stats: &LineStats) -> Vec<String> {
        let mut filtered = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if noise.contains(&i) {
                if self.is_contextually_important(line) {
                    let simplified = self.simplify_noise_line(line);
                    if !simplified.is_empty() {
                        filtered.push(simplified);
                    }
                }
            } else if stats.line_types.get(i) == Some(&LineType::ImageData) {
                filtered.push(self.simplify_image_line(line));
            } else {
                filtered.push(line.to_string());
            }
        }
        filtered
    }

    fn is_contextually_important(&self, line: &str) -> bool {
        let s = line.trim();
        let lower = s.to_lowercase();
        if s.len() < 50 && ["error", "warning", "title", "name"].iter().any(|w| lower.contains(w)) {
            return true;
        }
        s.starts_with("# ")
            || s.starts_with("## ")
            || s.starts_with("### ")
            || (!s.is_empty() && s.chars().any(|c| c.is_alphabetic()) && s == s.to_uppercase())
    }

    fn simplify_noise_line(&self, line: &str) -> String {
        let s = line.trim();
        if s.len() > 100 {
            if let Some(c) = QUOTED_RE.captures(s) {
                return format!("// {}", &c[1]);
            }
        }
        String::new()
    }

    /// Adjust thresholds (values are clamped to `[0.1, 0.9]`).
    pub fn update_thresholds(&mut self, feedback: &HashMap<String, f64>) {
        for (k, v) in feedback {
            let v = v.clamp(0.1, 0.9);
            match k.as_str() {
                "repetition_threshold" => self.noise_indicators.repetition_threshold = v,
                "length_threshold" => self.noise_indicators.length_threshold = v,
                "bracket_density" => self.noise_indicators.bracket_density = v,
                "json_like_threshold" => self.noise_indicators.json_like_threshold = v,
                "code_density" => self.noise_indicators.code_density = v,
                _ => {}
            }
        }
    }
}

fn char_counts(s: &str) -> CharCounts {
    let mut c = CharCounts { letters: 0, digits: 0, brackets: 0, quotes: 0, punctuation: 0, special: 0 };
    for ch in s.chars() {
        if ch.is_alphabetic() {
            c.letters += 1;
        }
        if ch.is_ascii_digit() {
            c.digits += 1;
        }
        if "{}[]()".contains(ch) {
            c.brackets += 1;
        }
        if "\"'".contains(ch) {
            c.quotes += 1;
        }
        if ":;,.!?".contains(ch) {
            c.punctuation += 1;
        }
        if !ch.is_alphanumeric() && ch != ' ' && ch != '\t' {
            c.special += 1;
        }
    }
    c
}
