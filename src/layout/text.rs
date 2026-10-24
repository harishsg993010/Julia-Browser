//! `--format layout`: the laid-out page as a grid of
//! character cells, a "screenshot" an agent can look at in a terminal.
//!
//! CSS pixels map to cells: `viewport width / cols` px per column and a
//! fixed 16 px (a typical line) per row. Elements are painted in layout-tree
//! order with positioned high-z elements last: box borders as line drawing,
//! form controls as `[widgets]`, replaced elements as `[img: alt]`, and every
//! text line from Parley's line boxes at its position. Characters of a run go
//! one per cell from the run's start column, and a run never overwrites text
//! already there: it moves to the first free span on its row, else to the row
//! below, so glyphs wider than a cell and lines closer than a row apart stay
//! readable instead of interleaving.

use super::blitz::Layout;
use super::TextOptions;
use blitz_dom::{BaseDocument, Node, NodeId};
use parley::PositionedLayoutItem;
use std::ops::Range;
use style::properties::generated::longhands::position::computed_value::T as Position;
use style::properties::generated::longhands::visibility::computed_value::T as Visibility;
use style::values::specified::box_::Overflow;
use style::values::specified::BorderStyle;

/// Height of a row in CSS px (a typical line box).
const ROW_PX: f64 = 16.0;
/// How far right a run may move to find free cells on its row.
const MAX_SHIFT: i64 = 40;
/// Cells a run may overflow its inline root's right edge by.
const OVERFLOW_CELLS: i64 = 4;
/// Smallest replaced element that gets a `[label]`; smaller ones are dots.
const MIN_LABEL_CELLS: usize = 5;

/// Render the laid-out page as text.
pub fn render(layout: &Layout, opts: &TextOptions) -> String {
    let doc = layout.base();
    let cols = opts.cols.max(20);
    let cell_w = layout.viewport.0 as f64 / cols as f64;
    let cell_h = ROW_PX;
    // At least the viewport: fixed elements sit there even on short pages.
    let (_, doc_h) = layout.document_size();
    let rows = ((doc_h.max(layout.viewport.1 as f64) / cell_h).ceil() as usize).clamp(1, opts.max_rows.max(1));
    let mut painter = Painter { doc, canvas: Canvas::new(cols, rows), cell_w, cell_h, annotate: opts.annotate, deferred: Vec::new() };
    let root = doc.root_node().id;
    let clip = Clip { x0: f64::NEG_INFINITY, y0: f64::NEG_INFINITY, x1: f64::INFINITY, y1: f64::INFINITY };
    painter.paint(root, clip, false);
    // Positioned elements with a z-index paint over everything else.
    let mut deferred = std::mem::take(&mut painter.deferred);
    deferred.sort_by_key(|(z, _, _)| *z);
    for (_, id, clip) in deferred {
        painter.paint(id, clip, true);
    }
    painter.canvas.to_string()
}

/// A document-relative clip rectangle in CSS px.
#[derive(Clone, Copy)]
struct Clip {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

impl Clip {
    fn intersect(&self, x: f64, y: f64, w: f64, h: f64) -> Clip {
        Clip { x0: self.x0.max(x), y0: self.y0.max(y), x1: self.x1.min(x + w), y1: self.y1.min(y + h) }
    }
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x0 && x < self.x1 && y >= self.y0 && y < self.y1
    }
}

struct Canvas {
    cols: usize,
    rows: usize,
    cells: Vec<char>,
}

impl Canvas {
    fn new(cols: usize, rows: usize) -> Self {
        Canvas { cols, rows, cells: vec![' '; cols * rows] }
    }

    fn put(&mut self, col: i64, row: i64, ch: char) {
        if col < 0 || row < 0 || col as usize >= self.cols || row as usize >= self.rows {
            return;
        }
        self.cells[row as usize * self.cols + col as usize] = ch;
    }

    fn get(&self, col: i64, row: i64) -> char {
        if col < 0 || row < 0 || col as usize >= self.cols || row as usize >= self.rows {
            return ' ';
        }
        self.cells[row as usize * self.cols + col as usize]
    }

    /// Write `text` starting at (col, row), never past `max_col`. Returns the
    /// next free column.
    fn text(&mut self, col: i64, row: i64, text: &str, max_col: i64) -> i64 {
        let mut c = col;
        for ch in text.chars() {
            if c > max_col {
                break;
            }
            self.put(c, row, ch);
            c += 1;
        }
        c
    }

    /// Whether `len` cells from (col, row) are free for text: blank or line
    /// art (text matters more than a border it crosses), with a blank cell
    /// before them so runs never touch. Cells past `max_col` are not written
    /// and do not count.
    fn free(&self, col: i64, row: i64, len: i64, max_col: i64) -> bool {
        (col == 0 || is_blank_or_line(self.get(col - 1, row))) && (col..col + len).all(|c| c > max_col || c >= self.cols as i64 || is_blank_or_line(self.get(c, row)))
    }

    /// Place a text run at (col, row) without overwriting other text: on
    /// the first free span at or right of `col` on that row, else on the row
    /// below, else into whatever cells are free. Returns the column after it.
    fn place(&mut self, col: i64, row: i64, text: &str, max_col: i64) -> i64 {
        let len = text.chars().count() as i64;
        if len == 0 {
            return col;
        }
        let candidates = [row, row + 1];
        for r in candidates {
            if r < 0 || r as usize >= self.rows {
                continue;
            }
            for c in col..=(col + MAX_SHIFT).min(max_col) {
                if self.free(c, r, len, max_col) {
                    return self.text(c, r, text, max_col);
                }
            }
        }
        let mut c = col;
        for ch in text.chars() {
            if c <= max_col && is_blank_or_line(self.get(c, row)) {
                self.put(c, row, ch);
            }
            c += 1;
        }
        c
    }

    /// Draw a line-art character: joins existing lines, never covers text.
    fn line(&mut self, col: i64, row: i64, ch: char) {
        let existing = self.get(col, row);
        if is_blank_or_line(existing) {
            self.put(col, row, join(existing, ch));
        }
    }

    /// Box outline over cells [c0, c1] × [r0, r1]; existing lines join.
    fn frame(&mut self, c0: i64, r0: i64, c1: i64, r1: i64) {
        if c1 <= c0 || r1 <= r0 {
            return;
        }
        for c in c0 + 1..c1 {
            self.line(c, r0, '─');
            self.line(c, r1, '─');
        }
        for r in r0 + 1..r1 {
            self.line(c0, r, '│');
            self.line(c1, r, '│');
        }
        self.line(c0, r0, '┌');
        self.line(c1, r0, '┐');
        self.line(c0, r1, '└');
        self.line(c1, r1, '┘');
    }

    fn hline(&mut self, c0: i64, c1: i64, row: i64) {
        for c in c0..=c1 {
            self.line(c, row, '─');
        }
    }
}

/// `JB_LAYOUT_DEBUG=1` traces every painted element on stderr.
fn debug() -> bool {
    std::env::var_os("JB_LAYOUT_DEBUG").is_some()
}

/// The boxes blitz laid out under a node (anonymous wrappers included), or
/// its DOM children when it built none.
fn layout_children(node: &Node) -> Vec<NodeId> {
    match node.layout_children.borrow().as_ref() {
        Some(kids) => kids.iter().copied().collect(),
        None => node.children.iter().copied().collect(),
    }
}

fn is_option(node: &Node) -> bool {
    node.element_data().map(|e| e.name.local.as_ref() == "option").unwrap_or(false)
}

const LINES: &str = "─│┌┐└┘├┤┬┴┼";

fn is_blank_or_line(ch: char) -> bool {
    ch == ' ' || LINES.contains(ch)
}

/// Merge a box-drawing character into an existing one (shared table edges).
fn join(existing: char, new: char) -> char {
    if !LINES.contains(existing) {
        return new;
    }
    if existing == new {
        return existing;
    }
    match (existing, new) {
        ('─', '│') | ('│', '─') => '┼',
        ('┌', '┐') | ('┐', '┌') | ('─', '┌') | ('─', '┐') | ('┌', '─') | ('┐', '─') => '┬',
        ('└', '┘') | ('┘', '└') | ('─', '└') | ('─', '┘') | ('└', '─') | ('┘', '─') => '┴',
        ('┌', '└') | ('└', '┌') | ('│', '┌') | ('│', '└') | ('┌', '│') | ('└', '│') => '├',
        ('┐', '┘') | ('┘', '┐') | ('│', '┐') | ('│', '┘') | ('┐', '│') | ('┘', '│') => '┤',
        _ => '┼',
    }
}

impl std::fmt::Display for Canvas {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut lines: Vec<String> = (0..self.rows).map(|r| self.cells[r * self.cols..(r + 1) * self.cols].iter().collect::<String>().trim_end().to_string()).collect();
        while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
            lines.pop();
        }
        // Long empty stretches (margins, images that were not drawn) shrink
        // to two blank rows.
        let mut blank = 0;
        let mut out = Vec::with_capacity(lines.len());
        for line in lines {
            blank = if line.is_empty() { blank + 1 } else { 0 };
            if blank <= 2 {
                out.push(line);
            }
        }
        write!(f, "{}", out.join("\n"))
    }
}

struct Painter<'a> {
    doc: &'a BaseDocument,
    canvas: Canvas,
    cell_w: f64,
    cell_h: f64,
    annotate: bool,
    deferred: Vec<(i32, NodeId, Clip)>,
}

impl<'a> Painter<'a> {
    fn col(&self, x: f64) -> i64 {
        (x / self.cell_w).round() as i64
    }
    fn row(&self, y: f64) -> i64 {
        (y / self.cell_h).floor() as i64
    }

    fn paint(&mut self, id: NodeId, clip: Clip, deferred_pass: bool) {
        let Some(node) = self.doc.get_node(id) else { return };
        // Anonymous boxes (a button's or a mixed block's inline content) own
        // text layouts of their own; the document node only forwards.
        if !node.is_element() {
            if node.element_data().is_some() && node.flags.is_inline_root() {
                self.paint_text(node, clip);
            }
            for c in layout_children(node) {
                self.paint(c, clip, deferred_pass);
            }
            return;
        }
        let Some(el) = node.element_data() else { return };
        let tag = el.name.local.as_ref();
        if matches!(tag, "head" | "script" | "style" | "template" | "noscript") {
            return;
        }
        let mut visible = true;
        let mut clip = clip;
        if let Some(styles) = node.primary_styles() {
            let display = styles.clone_display();
            if display.is_none() || styles.get_effects().opacity <= 0.01 {
                return;
            }
            let position = styles.get_box().position;
            let z = node.z_index();
            if !deferred_pass && matches!(position, Position::Absolute | Position::Fixed) && z > 0 {
                self.deferred.push((z, id, clip));
                return;
            }
            visible = styles.get_inherited_box().visibility == Visibility::Visible;
            if styles.get_box().overflow_x != Overflow::Visible || styles.get_box().overflow_y != Overflow::Visible {
                let pos = node.absolute_position(0.0, 0.0);
                let size = node.final_layout().size;
                clip = clip.intersect(pos.x as f64, pos.y as f64, size.width as f64, size.height as f64);
            }
        }
        let pos = node.absolute_position(0.0, 0.0);
        let layout = node.final_layout();
        let (x, y, w, h) = (pos.x as f64, pos.y as f64, layout.size.width as f64, layout.size.height as f64);
        let (c0, r0) = (self.col(x), self.row(y));
        let (c1, r1) = (self.col(x + w) - 1, self.row(y + h - 0.01));
        let in_clip = clip.contains(x, y) || clip.contains(x + w - 0.01, y + h - 0.01) || clip.contains(x, y + h - 0.01) || clip.contains(x + w - 0.01, y);
        let width_cells = (c1 - c0 + 1).max(0) as usize;
        if debug() {
            eprintln!(
                "[layout] <{tag}{}> {x:.0},{y:.0} {w:.0}x{h:.0} inline_root={} text_layout={} children={} visible={visible} in_clip={in_clip}",
                node.attr(blitz_dom::local_name!("id")).map(|i| format!("#{i}")).unwrap_or_default(),
                node.flags.is_inline_root(),
                el.inline_layout_data.is_some(),
                node.children.len()
            );
        }

        if visible && in_clip && w > 0.0 && h > 0.0 {
            // An opaque background hides what was painted underneath (a
            // translucent backdrop does not).
            let opaque = node.primary_styles().map(|s| s.get_background().background_color.as_absolute().map(|c| c.alpha >= 0.9).unwrap_or(false)).unwrap_or(false);
            if opaque && !matches!(tag, "html" | "body") {
                for r in r0..=r1 {
                    for c in c0..=c1 {
                        self.canvas.put(c, r, ' ');
                    }
                }
            }
            match tag {
                "input" => {
                    self.paint_input(node, c0, r0, c1);
                    return;
                }
                "select" => {
                    let selected = self.doc.tree().iter().filter(|(_, n)| n.parent == Some(id) || n.parent.and_then(|p| self.doc.get_node(p)).map(|p| p.parent == Some(id)).unwrap_or(false)).find(|(_, n)| is_option(n) && n.attr(blitz_dom::local_name!("selected")).is_some()).or_else(|| self.doc.tree().iter().find(|(_, n)| n.parent == Some(id) && is_option(n))).map(|(_, n)| n.text_content().trim().to_string()).unwrap_or_default();
                    self.widget(c0, r0, c1, &format!("{selected} ▾"));
                    return;
                }
                "textarea" => {
                    self.canvas.frame(c0, r0, c1, r1.max(r0 + 1));
                    let text = node.attr(blitz_dom::local_name!("placeholder")).map(|s| s.to_string()).unwrap_or_else(|| node.text_content());
                    let mut row = r0 + 1;
                    for line in text.lines() {
                        if row >= r1 {
                            break;
                        }
                        self.canvas.text(c0 + 1, row, line, c1 - 1);
                        row += 1;
                    }
                    return;
                }
                "img" | "svg" | "canvas" | "video" | "iframe" | "object" | "embed" => {
                    let alt = node.attr(blitz_dom::local_name!("alt")).or_else(|| node.attr(blitz_dom::local_name!("title"))).unwrap_or("").trim();
                    let label = if alt.is_empty() { format!("[{tag}]") } else { format!("[{tag}: {alt}]") };
                    if width_cells >= MIN_LABEL_CELLS {
                        if r1 > r0 {
                            self.canvas.frame(c0, r0, c1, r1);
                        }
                        let mid = (r0 + r1) / 2;
                        self.canvas.text(c0 + 1, mid, &label, c1 - 1);
                    } else if width_cells >= 1 {
                        self.canvas.put(c0, r0, '▣');
                    }
                    return;
                }
                "hr" => {
                    self.canvas.hline(c0, c1, r0);
                    return;
                }
                _ => {}
            }
            // Table cells laid out on blitz's grid carry their borders in the
            // computed style only, so fall back to it when taffy has none.
            let mut b = layout.border;
            if b.top == 0.0 && b.right == 0.0 && b.bottom == 0.0 && b.left == 0.0 {
                if let Some(styles) = node.primary_styles() {
                    // A width only counts with a visible style (`medium` is
                    // 3 px even for `border-style: none`).
                    let sb = styles.get_border();
                    let width = |style: BorderStyle, width: f32| if matches!(style, BorderStyle::None | BorderStyle::Hidden) { 0.0 } else { width };
                    b.top = width(sb.border_top_style, sb.border_top_width.0.to_f32_px());
                    b.right = width(sb.border_right_style, sb.border_right_width.0.to_f32_px());
                    b.bottom = width(sb.border_bottom_style, sb.border_bottom_width.0.to_f32_px());
                    b.left = width(sb.border_left_style, sb.border_left_width.0.to_f32_px());
                }
            }
            let bordered = [b.top, b.right, b.bottom, b.left].iter().filter(|s| **s >= 1.0).count();
            // One-line controls are marked by their brackets, not framed;
            // table cells are framed at any height (their edges sit in the
            // padding, and lines never cover text).
            let cell = matches!(tag, "td" | "th");
            if bordered == 4 && c1 > c0 && (r1 - r0 >= 2 || (cell && r1 > r0)) {
                self.canvas.frame(c0, r0, c1, r1);
            } else if bordered > 0 && c1 > c0 && (r1 - r0 >= 2 || cell) {
                if b.top >= 1.0 {
                    self.canvas.hline(c0, c1, r0);
                }
                if b.bottom >= 1.0 {
                    self.canvas.hline(c0, c1, r1);
                }
            }
            if node.flags.is_inline_root() {
                self.paint_text(node, clip);
            }
        }
        for c in layout_children(node) {
            self.paint(c, clip, deferred_pass);
        }
        // Buttons are bracketed at their edges once their label is in place
        // (never over a neighbour's text).
        if visible && in_clip && tag == "button" && width_cells >= 3 {
            let mid = (r0 + r1) / 2;
            for (c, ch) in [(c0, '['), (c1, ']')] {
                if is_blank_or_line(self.canvas.get(c, mid)) {
                    self.canvas.put(c, mid, ch);
                }
            }
        }
        // `#id` labels go where the box still has room, after its content.
        if self.annotate && visible && in_clip && r1 > r0 {
            if let Some(idv) = node.attr(blitz_dom::local_name!("id")) {
                let label = format!("#{idv}");
                let len = label.chars().count() as i64;
                if width_cells as i64 >= len + 2 && self.canvas.free(c0 + 1, r0, len, c1 - 1) {
                    self.canvas.text(c0 + 1, r0, &label, c1 - 1);
                }
            }
        }
    }

    /// `[text]` centred in a control's box, clipped to its width.
    fn widget(&mut self, c0: i64, r0: i64, c1: i64, text: &str) {
        let inner = (c1 - c0 - 1).max(1) as usize;
        let shown: String = text.chars().take(inner).collect();
        let padded = format!("{shown:<inner$}");
        self.canvas.put(c0, r0, '[');
        self.canvas.text(c0 + 1, r0, &padded, c1 - 1);
        self.canvas.put(c1.max(c0 + 1), r0, ']');
    }

    fn paint_input(&mut self, node: &Node, c0: i64, r0: i64, c1: i64) {
        let attr = |n: &str| node.attr(blitz_dom::LocalName::from(n)).map(|s| s.to_string());
        let kind = attr("type").unwrap_or_else(|| "text".into()).to_ascii_lowercase();
        let el = node.element_data();
        match kind.as_str() {
            "hidden" => {}
            "checkbox" | "radio" => {
                let checked = el.and_then(|e| e.checkbox_input_checked()).unwrap_or(false) || attr("checked").is_some();
                let s = match (kind.as_str(), checked) {
                    ("radio", true) => "(•)",
                    ("radio", false) => "( )",
                    (_, true) => "[x]",
                    _ => "[ ]",
                };
                self.canvas.text(c0, r0, s, c1.max(c0 + 2));
            }
            "submit" | "button" | "reset" | "image" => {
                let label = attr("value").filter(|v| !v.is_empty()).or_else(|| attr("alt")).unwrap_or_else(|| if kind == "reset" { "Reset".into() } else { "Submit".into() });
                self.widget(c0, r0, c1, &label);
            }
            "range" => self.widget(c0, r0, c1, "──●──"),
            "color" => self.widget(c0, r0, c1, "■"),
            "file" => self.widget(c0, r0, c1, "Choose file"),
            _ => {
                let value = attr("value").filter(|v| !v.is_empty());
                let text = match value {
                    Some(v) if kind == "password" => "•".repeat(v.chars().count()),
                    Some(v) => v,
                    None => attr("placeholder").unwrap_or_default(),
                };
                let inner = (c1 - c0 - 1).max(1) as usize;
                let filled: String = text.chars().take(inner).collect();
                let padded = format!("{filled}{}", "_".repeat(inner.saturating_sub(filled.chars().count())));
                self.widget(c0, r0, c1, &padded);
            }
        }
    }

    /// Every text line of an inline root, cluster by cluster.
    fn paint_text(&mut self, node: &Node, clip: Clip) {
        let Some(text_layout) = node.element_data().and_then(|e| e.inline_layout_data.as_ref()) else { return };
        let layout = &text_layout.layout;
        let text = &text_layout.text;
        let scale = layout.scale() as f64;
        let root_layout = node.final_layout();
        let pos = node.absolute_position(0.0, 0.0);
        let origin_x = pos.x as f64 + (root_layout.padding.left + root_layout.border.left) as f64;
        let origin_y = pos.y as f64 + (root_layout.padding.top + root_layout.border.top) as f64;
        let right_edge = self.col(pos.x as f64 + root_layout.size.width as f64) + OVERFLOW_CELLS;
        for line in layout.lines() {
            let m = line.metrics();
            let y = origin_y + ((m.block_min_coord + m.block_max_coord) as f64 / 2.0) / scale;
            let row = self.row(y);
            let mut painted: Option<Range<usize>> = None;
            let mut next_col = i64::MIN;
            for item in line.items() {
                let PositionedLayoutItem::GlyphRun(glyph_run) = item else { continue };
                let run = glyph_run.run();
                // Style spans split a run into several glyph runs; the run's
                // clusters are painted once, from the first one.
                if painted.as_ref() == Some(&run.text_range()) {
                    continue;
                }
                painted = Some(run.text_range());
                let x = origin_x + glyph_run.offset() as f64 / scale;
                if !clip.contains(x, y) {
                    continue;
                }
                // Characters go one per cell from the run's start column, so
                // wide glyphs compress and narrow ones never collide.
                let c = self.col(x).max(next_col);
                let s: String = run.visual_clusters().flat_map(|cl| text.get(cl.text_range()).unwrap_or("").chars().filter(|ch| !ch.is_control()).collect::<Vec<_>>()).collect();
                if s.trim().is_empty() {
                    next_col = c + s.chars().count() as i64;
                    continue;
                }
                let (lead, body) = (s.len() - s.trim_start().len(), s.trim_end());
                next_col = self.canvas.place(c + lead as i64, row, body, right_edge) + (s.len() - s.trim_end().len()) as i64;
            }
        }
    }
}
