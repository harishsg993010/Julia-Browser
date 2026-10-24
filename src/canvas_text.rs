//! Canvas 2D text (`fillText` / `strokeText` / `measureText`): the text is shaped with Parley
//! against the system fonts plus the fonts the page loaded through `FontFace`, and drawn into the
//! canvas as vello_cpu glyph runs (filled or stroked with the context's paint and transform).
use super::{affine_of, set_paint, stroke_of};
use parley::fontique::{Blob, FontInfoOverride};
use parley::{FontContext, FontFamily, FontStyle, FontWeight, LayoutContext, PositionedLayoutItem, StyleProperty};
use serde_json::{json, Value};
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use vello_cpu::kurbo::Affine;
use vello_cpu::peniko::{Fill, FontData};
use vello_cpu::{Glyph, Pixmap, RenderContext, Resources};

/// Web fonts the pages registered (family as the page names it, sfnt bytes), shared by every
/// engine thread; each thread's `FontContext` registers new entries before shaping.
fn faces() -> &'static Mutex<Vec<(String, Arc<Vec<u8>>)>> {
    static S: OnceLock<Mutex<Vec<(String, Arc<Vec<u8>>)>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Vec::new()))
}

/// Registers font bytes (TTF/OTF/WOFF/WOFF2) under `family`. Returns false for data that is not a font.
pub fn register_font(family: &str, bytes: &[u8]) -> bool {
    let data = blitz_dom::util::decode_font_bytes(bytes).into_owned();
    let sig = data.get(0..4).unwrap_or(&[]);
    if !(sig == [0, 1, 0, 0] || sig == b"OTTO" || sig == b"true" || sig == b"ttcf") {
        return false;
    }
    let fam = family.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
    if fam.is_empty() {
        return false;
    }
    let mut all = match faces().lock() { Ok(g) => g, Err(p) => p.into_inner() };
    if !all.iter().any(|(n, d)| n.eq_ignore_ascii_case(&fam) && d.len() == data.len()) {
        all.push((fam, Arc::new(data)));
    }
    true
}

struct Cx {
    font: FontContext,
    layout: LayoutContext<()>,
    registered: usize,
    cache: HashMap<String, Arc<Shaped>>,
}

thread_local! {
    static CX: RefCell<Option<Cx>> = const { RefCell::new(None) };
}

/// One shaped line of canvas text in layout space (x from 0, glyph y on the line's baseline).
pub struct Shaped {
    pub width: f64,
    pub ascent: f64,
    pub descent: f64,
    pub baseline: f64,
    runs: Vec<(FontData, f32, Vec<i16>, Vec<Glyph>)>,
}

const GENERICS: &[&str] = &["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "emoji", "math"];

fn shape(text: &str, font: &Value) -> Arc<Shaped> {
    let size = font.get("size").and_then(Value::as_f64).unwrap_or(10.0).clamp(0.0, 10_000.0) as f32;
    let mut family = font.get("family").and_then(Value::as_str).unwrap_or("sans-serif").trim().to_string();
    let last = family.rsplit(',').next().unwrap_or("").trim().trim_matches(|c| c == '"' || c == '\'').to_ascii_lowercase();
    if !GENERICS.contains(&last.as_str()) {
        family.push_str(", sans-serif");
    }
    let weight = font.get("weight").and_then(Value::as_f64).unwrap_or(400.0).clamp(1.0, 1000.0) as f32;
    let style_name = font.get("style").and_then(Value::as_str).unwrap_or("normal").to_string();
    let key = format!("{size}\u{1}{family}\u{1}{weight}\u{1}{style_name}\u{1}{text}");
    CX.with(|c| {
        let mut c = c.borrow_mut();
        let cx = c.get_or_insert_with(|| Cx { font: FontContext::new(), layout: LayoutContext::new(), registered: 0, cache: HashMap::new() });
        {
            let all = match faces().lock() { Ok(g) => g, Err(p) => p.into_inner() };
            if cx.registered < all.len() {
                cx.cache.clear();
            }
            while cx.registered < all.len() {
                let (name, data) = &all[cx.registered];
                let blob: Blob<u8> = Blob::new(data.clone() as Arc<dyn AsRef<[u8]> + Send + Sync>);
                cx.font.collection.register_fonts(blob, Some(FontInfoOverride { family_name: Some(name.as_str()), ..Default::default() }));
                cx.registered += 1;
            }
        }
        if let Some(s) = cx.cache.get(&key) {
            return s.clone();
        }
        let Cx { font: fcx, layout: lcx, .. } = &mut *cx;
        let mut b = lcx.ranged_builder(fcx, text, 1.0, false);
        b.push_default(StyleProperty::FontFamily(FontFamily::Source(Cow::Owned(family.clone()))));
        b.push_default(StyleProperty::FontSize(size));
        b.push_default(StyleProperty::FontWeight(FontWeight::new(weight)));
        b.push_default(StyleProperty::FontStyle(match style_name.as_str() {
            "italic" => FontStyle::Italic,
            "oblique" => FontStyle::Oblique(None),
            _ => FontStyle::Normal,
        }));
        let mut layout: parley::Layout<()> = b.build(text);
        layout.break_all_lines(None);
        let mut shaped = Shaped { width: layout.full_width() as f64, ascent: size as f64 * 0.8, descent: size as f64 * 0.2, baseline: size as f64 * 0.8, runs: Vec::new() };
        if let Some(line) = layout.lines().next() {
            let m = line.metrics();
            shaped.ascent = m.ascent as f64;
            shaped.descent = m.descent as f64;
            shaped.baseline = m.baseline as f64;
            for item in line.items() {
                if let PositionedLayoutItem::GlyphRun(gr) = item {
                    let run = gr.run();
                    let glyphs: Vec<Glyph> = gr.positioned_glyphs().map(|g| Glyph { id: g.id, x: g.x, y: g.y }).collect();
                    if !glyphs.is_empty() {
                        shaped.runs.push((run.font().clone(), run.font_size(), run.normalized_coords().to_vec(), glyphs));
                    }
                }
            }
        }
        let shaped = Arc::new(shaped);
        if cx.cache.len() > 4000 {
            cx.cache.clear();
        }
        cx.cache.insert(key, shaped.clone());
        shaped
    })
}

/// `measureText` metrics for the host op.
pub fn measure(payload: &Value) -> Value {
    let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
    let s = shape(text, payload.get("font").unwrap_or(&Value::Null));
    json!({"ok": true, "width": s.width, "ascent": s.ascent, "descent": s.descent, "inked": !s.runs.is_empty()})
}

/// Draws one `text` command (see `59_canvas.js` `_text`).
pub fn draw_text(ctx: &mut RenderContext, resources: &mut Resources, c: &Value, alpha: f32, canvases: &HashMap<String, Pixmap>, id: &str, base: &Pixmap) {
    let text = c.get("text").and_then(Value::as_str).unwrap_or("");
    if text.trim().is_empty() {
        return;
    }
    let s = shape(text, c.get("font").unwrap_or(&Value::Null));
    if s.runs.is_empty() || !(s.width > 0.0) {
        return;
    }
    let mut sx = 1.0;
    if let Some(mw) = c.get("maxWidth").and_then(Value::as_f64) {
        if !(mw > 0.0) {
            return;
        }
        if s.width > mw {
            sx = mw / s.width;
        }
    }
    let rtl = c.get("dir").and_then(Value::as_str) == Some("rtl");
    let w = s.width * sx;
    let ax = match (c.get("align").and_then(Value::as_str).unwrap_or("start"), rtl) {
        ("center", _) => -w / 2.0,
        ("right", _) | ("end", false) | ("start", true) => -w,
        _ => 0.0,
    };
    let by = match c.get("baseline").and_then(Value::as_str).unwrap_or("alphabetic") {
        "top" => s.ascent,
        "hanging" => s.ascent * 0.8,
        "middle" => (s.ascent - s.descent) / 2.0,
        "bottom" | "ideographic" => -s.descent,
        _ => 0.0,
    };
    let x = c.get("x").and_then(Value::as_f64).unwrap_or(0.0);
    let y = c.get("y").and_then(Value::as_f64).unwrap_or(0.0);
    let tf = affine_of(c.get("m")) * Affine::translate((x + ax, y + by - s.baseline)) * Affine::scale_non_uniform(sx, 1.0);
    if !set_paint(ctx, c.get("paint").unwrap_or(&Value::Null), alpha, canvases, id, base) {
        return;
    }
    let stroke = c.get("stroke").filter(|v| v.is_object());
    ctx.set_transform(tf);
    match stroke {
        Some(st) => ctx.set_stroke(stroke_of(st)),
        None => ctx.set_fill_rule(Fill::NonZero),
    }
    for (font, size, coords, glyphs) in &s.runs {
        let b = ctx.glyph_run(resources, font).font_size(*size).hint(false).normalized_coords(coords);
        if stroke.is_some() {
            b.stroke_glyphs(glyphs.iter().copied());
        } else {
            b.fill_glyphs(glyphs.iter().copied());
        }
    }
}
