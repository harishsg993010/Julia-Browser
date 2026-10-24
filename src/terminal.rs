//! Terminal presentation helpers (the `rich` replacement): styled text,
//! panels, tables, spinners and a light markdown renderer.

use comfy_table::{presets::UTF8_FULL, Cell, Color, ContentArrangement, Table};
use console::{style, Style, Term};
use indicatif::{ProgressBar, ProgressStyle};
use std::time::Duration;

/// Terminal width (falls back to 100 columns).
pub fn width() -> usize {
    Term::stdout().size().1.max(40) as usize
}

pub fn print(text: &str) {
    println!("{text}");
}

pub fn info(text: &str) {
    println!("{}", style(text).dim());
}

pub fn success(text: &str) {
    println!("{}", style(text).green());
}

pub fn warn(text: &str) {
    println!("{}", style(text).yellow());
}

pub fn error(text: &str) {
    println!("{}", style(text).red());
}

pub fn bold(text: &str) -> String {
    style(text).bold().to_string()
}

pub fn cyan(text: &str) -> String {
    style(text).cyan().to_string()
}

/// A boxed panel with a title (Rich `Panel`).
pub fn panel(title: &str, body: &str) -> String {
    let w = width().min(100);
    let inner = w.saturating_sub(4);
    let mut out = String::new();
    let title_str = format!(" {title} ");
    let dashes = inner.saturating_sub(console::measure_text_width(&title_str));
    out.push_str(&format!("╭{}{}╮\n", style(&title_str).bold(), "─".repeat(dashes + 2)));
    for line in body.lines() {
        for chunk in wrap(line, inner) {
            let pad = inner.saturating_sub(console::measure_text_width(&chunk));
            out.push_str(&format!("│ {chunk}{} │\n", " ".repeat(pad)));
        }
    }
    out.push_str(&format!("╰{}╯", "─".repeat(inner + 2)));
    out
}

fn wrap(line: &str, width: usize) -> Vec<String> {
    if console::measure_text_width(line) <= width {
        return vec![line.to_string()];
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    for word in line.split(' ') {
        if !cur.is_empty() && console::measure_text_width(&cur) + console::measure_text_width(word) + 1 > width {
            out.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(word);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Build a styled table with a header row.
pub fn table(title: Option<&str>, headers: &[&str], rows: &[Vec<String>]) -> String {
    let mut t = Table::new();
    t.load_style(UTF8_FULL).set_content_arrangement(ContentArrangement::Dynamic);
    t.set_header(headers.iter().map(|h| Cell::new(h).fg(Color::Magenta)).collect::<Vec<_>>());
    for row in rows {
        t.add_row(row.iter().map(Cell::new).collect::<Vec<_>>());
    }
    match title {
        Some(title) => format!("{}\n{t}", style(title).bold()),
        None => t.to_string(),
    }
}

/// Start a transient spinner with a message.
pub fn spinner(message: &str) -> ProgressBar {
    let pb = ProgressBar::new_spinner();
    pb.set_style(ProgressStyle::with_template("{spinner:.cyan} {msg}").unwrap());
    pb.set_message(message.to_string());
    pb.enable_steady_tick(Duration::from_millis(80));
    pb
}

/// Render markdown for the terminal: headings bold, emphasis, code and links
/// styled, everything else passed through.
pub fn render_markdown(md: &str) -> String {
    let heading = Style::new().bold().cyan();
    let code_style = Style::new().yellow();
    let link_style = Style::new().blue().underlined();
    let mut out = Vec::new();
    let mut in_code = false;
    let link_re = regex::Regex::new(r"\[([^\]]+)\]\(([^)]+)\)").unwrap();
    let bold_re = regex::Regex::new(r"\*\*([^*]+)\*\*").unwrap();
    let code_re = regex::Regex::new(r"`([^`]+)`").unwrap();
    for line in md.lines() {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
            out.push(style(line).dim().to_string());
            continue;
        }
        if in_code {
            out.push(code_style.apply_to(line).to_string());
            continue;
        }
        if let Some(rest) = line.strip_prefix('#') {
            let level = 1 + rest.chars().take_while(|c| *c == '#').count();
            let text = line.trim_start_matches('#').trim();
            let rendered = if level == 1 { heading.apply_to(text.to_uppercase()).to_string() } else { heading.apply_to(text).to_string() };
            out.push(rendered);
            continue;
        }
        let mut l = link_re.replace_all(line, |c: &regex::Captures| format!("{} ({})", link_style.apply_to(&c[1]), style(&c[2]).dim())).to_string();
        l = bold_re.replace_all(&l, |c: &regex::Captures| style(&c[1]).bold().to_string()).to_string();
        l = code_re.replace_all(&l, |c: &regex::Captures| code_style.apply_to(&c[1]).to_string()).to_string();
        if l.trim_start().starts_with("> ") {
            l = style(&l).italic().to_string();
        }
        out.push(l);
    }
    out.join("\n")
}

/// Print JSON prettily.
pub fn print_json(value: &serde_json::Value) {
    println!("{}", serde_json::to_string_pretty(value).unwrap_or_default());
}

pub fn clear() {
    let _ = Term::stdout().clear_screen();
}
