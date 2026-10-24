//! Canvas 2D backing store: page scripts build device-space drawing commands
//! (`59_canvas.js`) and flush them here in batches; each canvas bitmap is a
//! premultiplied RGBA pixmap rasterized with `vello_cpu`.
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use vello_cpu::kurbo::{Affine, BezPath, Cap, Join, Point, Rect, Stroke};
use vello_cpu::peniko::{BlendMode, Compose, Extend, Fill, Gradient, ImageQuality, ImageSampler, Mix};
use vello_cpu::{color::AlphaColor, Image, ImageSource, Pixmap, RenderContext, Resources};

fn store() -> &'static Mutex<HashMap<String, Pixmap>> {
    static S: OnceLock<Mutex<HashMap<String, Pixmap>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Per-canvas bitmap version (bumped by every draw/put/reset) and whether anything was drawn
/// since the last reset. The layout mirror paints a canvas from `LAYOUT_URL_PREFIX<id>/<version>.png`,
/// so a changed bitmap gets a new URL and an unchanged one is served from the layout media cache.
fn versions() -> &'static Mutex<HashMap<String, (u64, bool)>> {
    static S: OnceLock<Mutex<HashMap<String, (u64, bool)>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn bump(id: &str, inked: bool) {
    let mut v = match versions().lock() { Ok(g) => g, Err(p) => p.into_inner() };
    let e = v.entry(id.to_string()).or_insert((0, false));
    e.0 += 1;
    e.1 = inked;
}

/// URL prefix the layout loader (`src/layout/blitz.rs`) answers from this store without network.
pub const LAYOUT_URL_PREFIX: &str = "https://jb-canvas.invalid/";

/// PNG of a canvas bitmap for the layout mirror: `<prefix><id>/<version>.png`.
pub fn layout_png(url: &str) -> Option<Vec<u8>> {
    let id = url.strip_prefix(LAYOUT_URL_PREFIX)?.split('/').next()?;
    let pm = {
        let all = match store().lock() { Ok(g) => g, Err(p) => p.into_inner() };
        all.get(id)?.clone()
    };
    encode_png(&pm)
}

fn encode_png(pm: &Pixmap) -> Option<Vec<u8>> {
    let (pw, ph) = (pm.width() as u32, pm.height() as u32);
    let rgba = read_rgba(pm, 0, 0, pw, ph);
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, pw, ph);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut wr = enc.write_header().ok()?;
        wr.write_image_data(&rgba).ok()?;
    }
    Some(out)
}

/// Decoded images keyed by URL (drawImage/createPattern sources).
fn image_cache() -> &'static Mutex<HashMap<String, Arc<Pixmap>>> {
    static S: OnceLock<Mutex<HashMap<String, Arc<Pixmap>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

const MAX_DIM: u32 = 8192;

/// fillText/strokeText/measureText (Parley shaping, glyph runs); needs Parley (layout) and
/// vello_cpu's `text` feature, which the `screenshot` feature brings in.
#[cfg(feature = "screenshot")]
#[path = "canvas_text.rs"]
mod text;

/// Registers a page web font (FontFace) for canvas text. False when it is not a font.
pub fn register_font(family: &str, bytes: &[u8]) -> bool {
    #[cfg(feature = "screenshot")]
    return text::register_font(family, bytes);
    #[cfg(not(feature = "screenshot"))]
    {
        let _ = (family, bytes);
        false
    }
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn num(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

fn new_pixmap(w: u32, h: u32) -> Pixmap {
    Pixmap::new(w.clamp(1, MAX_DIM) as u16, h.clamp(1, MAX_DIM) as u16)
}

/// Pixmap from straight-alpha RGBA bytes.
fn pixmap_from_rgba(bytes: &[u8], w: u32, h: u32) -> Option<Pixmap> {
    if w == 0 || h == 0 || w > MAX_DIM || h > MAX_DIM || bytes.len() < (w * h * 4) as usize {
        return None;
    }
    let mut pm = Pixmap::new(w as u16, h as u16);
    for (i, px) in pm.data_mut().iter_mut().enumerate() {
        let s = &bytes[i * 4..i * 4 + 4];
        let a = s[3] as u32;
        let m = |c: u8| ((c as u32 * a + 127) / 255) as u8;
        *px = vello_cpu::color::PremulRgba8 { r: m(s[0]), g: m(s[1]), b: m(s[2]), a: s[3] };
    }
    Some(pm)
}

/// Straight-alpha RGBA bytes of a region (out-of-bounds pixels are transparent black).
fn read_rgba(pm: &Pixmap, x: i64, y: i64, w: u32, h: u32) -> Vec<u8> {
    let mut out = vec![0u8; (w as usize) * (h as usize) * 4];
    let (pw, ph) = (pm.width() as i64, pm.height() as i64);
    let data = pm.data();
    for row in 0..h as i64 {
        let sy = y + row;
        if sy < 0 || sy >= ph {
            continue;
        }
        for col in 0..w as i64 {
            let sx = x + col;
            if sx < 0 || sx >= pw {
                continue;
            }
            let p = data[(sy * pw + sx) as usize];
            let o = ((row * w as i64 + col) * 4) as usize;
            if p.a == 0 {
                continue;
            }
            let un = |c: u8| (((c as u32) * 255 + (p.a as u32) / 2) / p.a as u32).min(255) as u8;
            out[o] = un(p.r);
            out[o + 1] = un(p.g);
            out[o + 2] = un(p.b);
            out[o + 3] = p.a;
        }
    }
    out
}

fn path_of(v: Option<&Value>) -> BezPath {
    let mut p = BezPath::new();
    let Some(arr) = v.and_then(Value::as_array) else { return p };
    let n: Vec<f64> = arr.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect();
    let mut i = 0;
    while i < n.len() {
        match n[i] as i32 {
            0 if i + 2 < n.len() => { p.move_to((n[i + 1], n[i + 2])); i += 3; }
            1 if i + 2 < n.len() => { p.line_to((n[i + 1], n[i + 2])); i += 3; }
            2 if i + 6 < n.len() => { p.curve_to((n[i + 1], n[i + 2]), (n[i + 3], n[i + 4]), (n[i + 5], n[i + 6])); i += 7; }
            3 if i + 4 < n.len() => { p.quad_to((n[i + 1], n[i + 2]), (n[i + 3], n[i + 4])); i += 5; }
            4 => { p.close_path(); i += 1; }
            _ => break,
        }
    }
    p
}

fn affine_of(v: Option<&Value>) -> Affine {
    match v.and_then(Value::as_array) {
        Some(a) if a.len() == 6 => {
            let f: Vec<f64> = a.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect();
            Affine::new([f[0], f[1], f[2], f[3], f[4], f[5]])
        }
        _ => Affine::IDENTITY,
    }
}

fn color_of(v: &Value, alpha: f32) -> AlphaColor<vello_cpu::color::Srgb> {
    let c: Vec<f32> = v.as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect()).unwrap_or_default();
    let g = |i: usize| c.get(i).copied().unwrap_or(0.0);
    AlphaColor::new([g(0) / 255.0, g(1) / 255.0, g(2) / 255.0, (g(3) * alpha).clamp(0.0, 1.0)])
}

fn compose_of(op: &str) -> Option<BlendMode> {
    let c = |compose| Some(BlendMode::new(Mix::Normal, compose));
    let m = |mix| Some(BlendMode::new(mix, Compose::SrcOver));
    match op {
        "source-over" | "" => None,
        "copy" => c(Compose::Copy),
        "source-in" => c(Compose::SrcIn),
        "source-out" => c(Compose::SrcOut),
        "source-atop" => c(Compose::SrcAtop),
        "destination-over" => c(Compose::DestOver),
        "destination-in" => c(Compose::DestIn),
        "destination-out" => c(Compose::DestOut),
        "destination-atop" => c(Compose::DestAtop),
        "xor" => c(Compose::Xor),
        "lighter" => c(Compose::Plus),
        "clear" => c(Compose::Clear),
        "multiply" => m(Mix::Multiply),
        "screen" => m(Mix::Screen),
        "overlay" => m(Mix::Overlay),
        "darken" => m(Mix::Darken),
        "lighten" => m(Mix::Lighten),
        "color-dodge" => m(Mix::ColorDodge),
        "color-burn" => m(Mix::ColorBurn),
        "hard-light" => m(Mix::HardLight),
        "soft-light" => m(Mix::SoftLight),
        "difference" => m(Mix::Difference),
        "exclusion" => m(Mix::Exclusion),
        "hue" => m(Mix::Hue),
        "saturation" => m(Mix::Saturation),
        "color" => m(Mix::Color),
        "luminosity" => m(Mix::Luminosity),
        _ => None,
    }
}

/// Resolves an image source description (another canvas, raw pixels or a decoded URL).
fn source_pixmap(src: &Value, canvases: &HashMap<String, Pixmap>, self_id: &str, self_pm: &Pixmap) -> Option<Arc<Pixmap>> {
    let pm = source_pixmap_raw(src, canvases, self_id, self_pm)?;
    match (src.get("srcSpace").and_then(Value::as_str), src.get("dstSpace").and_then(Value::as_str)) {
        (Some(from), Some(to)) if !from.eq_ignore_ascii_case(to) => Some(Arc::new(convert_pixmap_space(&pm, from, to))),
        _ => Some(pm),
    }
}

/// A copy of `pm` with its colors converted between canvas color spaces.
fn convert_pixmap_space(pm: &Pixmap, from: &str, to: &str) -> Pixmap {
    let (w, h) = (pm.width() as u32, pm.height() as u32);
    let mut straight = read_rgba(pm, 0, 0, w, h);
    crate::colorspace::convert_rgba8_between(&mut straight, crate::colorspace::Space::from_name(from), crate::colorspace::Space::from_name(to));
    pixmap_from_rgba(&straight, w, h).unwrap_or_else(|| pm.clone())
}

fn source_pixmap_raw(src: &Value, canvases: &HashMap<String, Pixmap>, self_id: &str, self_pm: &Pixmap) -> Option<Arc<Pixmap>> {
    if let Some(id) = src.get("canvas").and_then(Value::as_str) {
        if id == self_id {
            return Some(Arc::new(self_pm.clone()));
        }
        return canvases.get(id).map(|p| Arc::new(p.clone()));
    }
    if let Some(data) = src.get("rgba").and_then(Value::as_str) {
        let bytes = b64().decode(data).ok()?;
        return pixmap_from_rgba(&bytes, num(src, "w") as u32, num(src, "h") as u32).map(Arc::new);
    }
    if let Some(url) = src.get("url").and_then(Value::as_str) {
        let mut key = image_key(url, src.get("space").and_then(Value::as_str).unwrap_or("srgb"));
        if src.get("orient").and_then(Value::as_bool) == Some(false) {
            key.push_str("\u{2}raw");
        }
        return image_cache().lock().ok()?.get(&key).cloned();
    }
    None
}

/// Registers decoded pixels for `url` (straight RGBA).
pub fn cache_image(url: &str, rgba: &[u8], w: u32, h: u32) -> bool {
    match pixmap_from_rgba(rgba, w, h) {
        Some(pm) => {
            if let Ok(mut c) = image_cache().lock() {
                c.insert(url.to_string(), Arc::new(pm));
            }
            true
        }
        None => false,
    }
}

/// Cache key of a decoded image converted to a canvas color space.
pub fn image_key(url: &str, space: &str) -> String {
    if space.eq_ignore_ascii_case("display-p3") { format!("{url}\u{1}p3") } else { url.to_string() }
}

pub fn has_cached_image(url: &str) -> bool {
    image_cache().lock().map(|c| c.contains_key(url)).unwrap_or(false)
}

fn set_paint(ctx: &mut RenderContext, paint: &Value, alpha: f32, canvases: &HashMap<String, Pixmap>, id: &str, base: &Pixmap) -> bool {
    let stops = |p: &Value| -> Vec<(f32, AlphaColor<vello_cpu::color::Srgb>)> {
        p.get("stops").and_then(Value::as_array).map(|a| {
            a.iter().filter_map(|s| {
                let s = s.as_array()?;
                let off = s.first()?.as_f64()? as f32;
                Some((off, color_of(&Value::Array(s[1..].to_vec()), alpha)))
            }).collect()
        }).unwrap_or_default()
    };
    let kind = paint.get("k").and_then(Value::as_str).unwrap_or("c");
    ctx.set_paint_transform(affine_of(paint.get("m")));
    match kind {
        "c" => {
            ctx.set_paint(color_of(paint.get("rgba").unwrap_or(&Value::Null), alpha));
            true
        }
        "lg" | "rg" | "cg" => {
            let st = stops(paint);
            if st.is_empty() {
                ctx.set_paint(AlphaColor::<vello_cpu::color::Srgb>::new([0.0, 0.0, 0.0, 0.0]));
                return true;
            }
            let g = match kind {
                "lg" => Gradient::new_linear(Point::new(num(paint, "x0"), num(paint, "y0")), Point::new(num(paint, "x1"), num(paint, "y1"))),
                "rg" => Gradient::new_two_point_radial(Point::new(num(paint, "x0"), num(paint, "y0")), num(paint, "r0") as f32, Point::new(num(paint, "x1"), num(paint, "y1")), num(paint, "r1") as f32),
                _ => {
                    let a = num(paint, "a") as f32;
                    Gradient::new_sweep(Point::new(num(paint, "x"), num(paint, "y")), a, a + std::f32::consts::TAU)
                }
            };
            let mut stops_sorted = st;
            stops_sorted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            ctx.set_paint(g.with_stops(stops_sorted.as_slice()));
            true
        }
        "pat" => {
            let Some(pm) = paint.get("src").and_then(|s| source_pixmap(s, canvases, id, base)) else { return false };
            let rep = paint.get("rep").and_then(Value::as_str).unwrap_or("repeat");
            let (rx, ry) = (rep == "repeat" || rep == "repeat-x", rep == "repeat" || rep == "repeat-y");
            // A non-repeating axis is transparent outside the image: pad it with a transparent
            // pixel on both sides and let Extend::Pad stretch that border instead of the image edge.
            let (px, py) = (if rx { 0u32 } else { 1 }, if ry { 0u32 } else { 1 });
            let pm = if px == 0 && py == 0 {
                pm
            } else {
                let (w, h) = (pm.width() as u32, pm.height() as u32);
                let (nw, nh) = (w + 2 * px, h + 2 * py);
                if nw > MAX_DIM || nh > MAX_DIM {
                    pm
                } else {
                    let mut out = Pixmap::new(nw as u16, nh as u16);
                    let src = pm.data();
                    let dst = out.data_mut();
                    for y in 0..h {
                        let row = (y * w) as usize;
                        let drow = ((y + py) * nw + px) as usize;
                        dst[drow..drow + w as usize].copy_from_slice(&src[row..row + w as usize]);
                    }
                    ctx.set_paint_transform(affine_of(paint.get("m")) * Affine::translate((-(px as f64), -(py as f64))));
                    Arc::new(out)
                }
            };
            let ext = |on: bool| if on { Extend::Repeat } else { Extend::Pad };
            let sampler = ImageSampler { x_extend: ext(rx), y_extend: ext(ry), quality: ImageQuality::Low, alpha };
            ctx.set_paint(Image { image: ImageSource::Pixmap(pm), sampler });
            true
        }
        _ => false,
    }
}

fn stroke_of(s: &Value) -> Stroke {
    let cap = match s.get("cap").and_then(Value::as_str) { Some("round") => Cap::Round, Some("square") => Cap::Square, _ => Cap::Butt };
    let join = match s.get("join").and_then(Value::as_str) { Some("round") => Join::Round, Some("bevel") => Join::Bevel, _ => Join::Miter };
    let mut st = Stroke::new(num(s, "w").max(0.0)).with_caps(cap).with_join(join).with_miter_limit(num(s, "miter").max(1.0));
    if let Some(d) = s.get("dash").and_then(Value::as_array) {
        let dashes: Vec<f64> = d.iter().filter_map(Value::as_f64).collect();
        if !dashes.is_empty() {
            st = st.with_dashes(num(s, "off"), dashes);
        }
    }
    st
}

/// Draws one batch of commands onto canvas `id` (created/resized to w x h).
fn draw(id: &str, w: u32, h: u32, cmds: &[Value]) -> Value {
    let mut all = match store().lock() { Ok(g) => g, Err(p) => p.into_inner() };
    let (w, h) = (w.clamp(1, MAX_DIM), h.clamp(1, MAX_DIM));
    let base = match all.remove(id) {
        Some(p) if p.width() as u32 == w && p.height() as u32 == h => p,
        _ => new_pixmap(w, h),
    };
    let mut ctx = RenderContext::new(w as u16, h as u16);
    let mut resources = Resources::new();
    let base_arc = Arc::new(base.clone());
    let full = Rect::new(0.0, 0.0, w as f64, h as f64);
    ctx.set_paint(Image { image: ImageSource::Pixmap(base_arc), sampler: ImageSampler { x_extend: Extend::Pad, y_extend: Extend::Pad, quality: ImageQuality::Low, alpha: 1.0 } });
    ctx.fill_rect(&full);
    for c in cmds {
        let t = c.get("t").and_then(Value::as_str).unwrap_or("");
        let alpha = c.get("alpha").and_then(Value::as_f64).unwrap_or(1.0) as f32;
        // clearRect = destination-out of an opaque rect
        let comp = if t == "clear" { Some(BlendMode::new(Mix::Normal, Compose::DestOut)) } else { compose_of(c.get("comp").and_then(Value::as_str).unwrap_or("")) };
        let clips: Vec<(BezPath, Fill)> = c.get("clip").and_then(Value::as_array).map(|a| a.iter().map(|cl| (path_of(cl.get("path")), if cl.get("rule").and_then(Value::as_str) == Some("evenodd") { Fill::EvenOdd } else { Fill::NonZero })).collect()).unwrap_or_default();
        ctx.set_transform(Affine::IDENTITY);
        // A compositing operation under a clip is ONE layer carrying both the clip and the blend
        // mode: a clip layer is an isolated group, so a destination-out layer nested inside one erased
        // nothing of the canvas (clearRect under clip() was a no-op; the SEC chart redrew over its
        // previous frame). Further clips narrow the content inside it.
        let layered = comp.is_some();
        let mut rest = &clips[..];
        if let Some(bm) = comp {
            match clips.first() {
                Some((p, rule)) => {
                    ctx.set_fill_rule(*rule);
                    ctx.push_layer(Some(p), Some(bm), None, None, None);
                    rest = &clips[1..];
                }
                None => ctx.push_blend_layer(bm),
            }
        }
        for (p, rule) in rest {
            ctx.set_fill_rule(*rule);
            ctx.push_clip_layer(p);
        }
        match t {
            "fill" => {
                let rule = if c.get("rule").and_then(Value::as_str) == Some("evenodd") { Fill::EvenOdd } else { Fill::NonZero };
                if set_paint(&mut ctx, c.get("paint").unwrap_or(&Value::Null), alpha, &all, id, &base) {
                    ctx.set_fill_rule(rule);
                    ctx.fill_path(&path_of(c.get("path")));
                }
            }
            "stroke" => {
                let m = affine_of(c.get("m"));
                if set_paint(&mut ctx, c.get("paint").unwrap_or(&Value::Null), alpha, &all, id, &base) {
                    ctx.set_transform(m);
                    ctx.set_stroke(stroke_of(c.get("style").unwrap_or(&Value::Null)));
                    ctx.stroke_path(&path_of(c.get("path")));
                }
            }
            "clear" => {
                ctx.set_paint_transform(Affine::IDENTITY);
                ctx.set_paint(AlphaColor::<vello_cpu::color::Srgb>::new([0.0, 0.0, 0.0, 1.0]));
                ctx.set_fill_rule(Fill::NonZero);
                ctx.fill_path(&path_of(c.get("path")));
            }
            "text" => {
                #[cfg(feature = "screenshot")]
                text::draw_text(&mut ctx, &mut resources, c, alpha, &all, id, &base);
            }
            "image" => {
                if let Some(pm) = c.get("src").and_then(|s| source_pixmap(s, &all, id, &base)) {
                    let smooth = c.get("smooth").and_then(Value::as_bool).unwrap_or(true);
                    ctx.set_transform(affine_of(c.get("m")));
                    ctx.set_paint_transform(Affine::IDENTITY);
                    let sampler = ImageSampler { x_extend: Extend::Pad, y_extend: Extend::Pad, quality: if smooth { ImageQuality::Medium } else { ImageQuality::Low }, alpha };
                    ctx.set_paint(Image { image: ImageSource::Pixmap(pm), sampler });
                    ctx.set_fill_rule(Fill::NonZero);
                    ctx.fill_rect(&Rect::new(num(c, "sx"), num(c, "sy"), num(c, "sx") + num(c, "sw"), num(c, "sy") + num(c, "sh")));
                }
            }
            _ => {}
        }
        for _ in rest {
            ctx.pop_layer();
        }
        if layered {
            ctx.pop_layer();
        }
    }
    let mut target = new_pixmap(w, h);
    ctx.flush();
    ctx.render(&mut target, &mut resources);
    all.insert(id.to_string(), target);
    json!({"ok": true})
}

/// Entry point of the `canvas` host op.
pub fn op(payload: &Value) -> Value {
    let id = payload.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let w = num(payload, "w") as u32;
    let h = num(payload, "h") as u32;
    match payload.get("op").and_then(Value::as_str).unwrap_or("") {
        "draw" => {
            let cmds = payload.get("cmds").and_then(Value::as_array).cloned().unwrap_or_default();
            bump(&id, true);
            draw(&id, w, h, &cmds)
        }
        "reset" => {
            bump(&id, false);
            if let Ok(mut all) = store().lock() {
                all.insert(id, new_pixmap(w, h));
            }
            json!({"ok": true})
        }
        "drop" => {
            if let Ok(mut v) = versions().lock() {
                v.remove(&id);
            }
            if let Ok(mut all) = store().lock() {
                all.remove(&id);
            }
            json!({"ok": true})
        }
        "version" => {
            // {v, inked}: inked = drawn on since the last reset (a blank bitmap is not painted)
            let v = match versions().lock() { Ok(g) => g, Err(p) => p.into_inner() };
            let (ver, inked) = v.get(&id).copied().unwrap_or((0, false));
            let inked = inked && store().lock().map(|all| all.contains_key(&id)).unwrap_or(false);
            json!({"v": ver, "inked": inked})
        }
        "get" => {
            let (x, y) = (num(payload, "x") as i64, num(payload, "y") as i64);
            let (rw, rh) = (num(payload, "rw").max(0.0) as u32, num(payload, "rh").max(0.0) as u32);
            let all = match store().lock() { Ok(g) => g, Err(p) => p.into_inner() };
            let mut bytes = match all.get(&id) {
                Some(pm) => read_rgba(pm, x, y, rw, rh),
                None => vec![0u8; (rw as usize) * (rh as usize) * 4],
            };
            // canvas color space -> requested ImageData color space
            if let (Some(from), Some(to)) = (payload.get("space").and_then(Value::as_str), payload.get("to").and_then(Value::as_str)) {
                crate::colorspace::convert_rgba8_between(&mut bytes, crate::colorspace::Space::from_name(from), crate::colorspace::Space::from_name(to));
            }
            json!({"data": b64().encode(bytes)})
        }
        "put" => {
            // Replace a region with straight-alpha pixels (no compositing).
            let (x, y) = (num(payload, "x") as i64, num(payload, "y") as i64);
            let (rw, rh) = (num(payload, "rw") as i64, num(payload, "rh") as i64);
            let Ok(mut bytes) = b64().decode(payload.get("data").and_then(Value::as_str).unwrap_or("")) else { return json!({"error": "bad data"}) };
            bump(&id, true);
            // ImageData color space -> canvas color space
            if let (Some(from), Some(to)) = (payload.get("from").and_then(Value::as_str), payload.get("space").and_then(Value::as_str)) {
                crate::colorspace::convert_rgba8_between(&mut bytes, crate::colorspace::Space::from_name(from), crate::colorspace::Space::from_name(to));
            }
            let mut all = match store().lock() { Ok(g) => g, Err(p) => p.into_inner() };
            let pm = all.entry(id).or_insert_with(|| new_pixmap(w, h));
            let (pw, ph) = (pm.width() as i64, pm.height() as i64);
            let data = pm.data_mut();
            for row in 0..rh {
                for col in 0..rw {
                    let (dx, dy) = (x + col, y + row);
                    if dx < 0 || dy < 0 || dx >= pw || dy >= ph {
                        continue;
                    }
                    let o = ((row * rw + col) * 4) as usize;
                    if o + 3 >= bytes.len() {
                        continue;
                    }
                    let a = bytes[o + 3] as u32;
                    let m = |c: u8| ((c as u32 * a + 127) / 255) as u8;
                    data[(dy * pw + dx) as usize] = vello_cpu::color::PremulRgba8 { r: m(bytes[o]), g: m(bytes[o + 1]), b: m(bytes[o + 2]), a: bytes[o + 3] };
                }
            }
            json!({"ok": true})
        }
        "png" => {
            let all = match store().lock() { Ok(g) => g, Err(p) => p.into_inner() };
            let pm = all.get(&id).cloned().unwrap_or_else(|| new_pixmap(w, h));
            drop(all);
            match encode_png(&pm) {
                Some(out) => json!({"data": b64().encode(out)}),
                None => json!({"error": "png encode"}),
            }
        }
        "measure" => {
            #[cfg(feature = "screenshot")]
            return text::measure(payload);
            #[cfg(not(feature = "screenshot"))]
            json!({"ok": false})
        }
        "cacheImage" => {
            let url = payload.get("url").and_then(Value::as_str).unwrap_or("");
            let ok = b64().decode(payload.get("data").and_then(Value::as_str).unwrap_or("")).map(|b| cache_image(url, &b, w, h)).unwrap_or(false);
            json!({"ok": ok})
        }
        other => json!({"error": format!("unknown canvas op {other}")}),
    }
}
