//! Pixel screenshots (Cargo feature `screenshot`): the
//! laid-out page painted by `blitz-paint` on the vello CPU renderer and
//! encoded as PNG. No GPU is needed. Images are not fetched during layout, so
//! their boxes come out empty; text, backgrounds, borders and SVG are painted.

use super::blitz::Layout;
use super::ScreenshotOptions;
use anyrender::ImageRenderer;
use anyrender_vello_cpu::VelloCpuImageRenderer;

/// vello_cpu addresses pixmaps with 16-bit sizes.
const MAX_SIDE: u32 = 65_535;

/// Paint `layout` and return PNG bytes. A `clip` in the options captures that
/// document region (scrolling the viewport there for the duration), otherwise
/// the whole page (or one viewport with `full_page` off).
pub fn render_png(layout: &mut Layout, opts: &ScreenshotOptions) -> Result<Vec<u8>, String> {
    let (pixels, pw, ph) = render_rgba(layout, opts)?;
    encode_png(&pixels, pw, ph)
}

/// `render_png` without the encoding: opaque RGBA pixels and their size.
pub fn render_rgba(layout: &mut Layout, opts: &ScreenshotOptions) -> Result<(Vec<u8>, u32, u32), String> {
    let (vw, vh) = layout.viewport;
    let (_, doc_h) = layout.document_size();
    let (x0, y0, w, h) = match opts.clip {
        Some(r) => (r.x.max(0.0), r.y.max(0.0), r.width.ceil() as u32, r.height.ceil() as u32),
        None => (0.0, 0.0, vw, if opts.full_page { (doc_h.ceil() as u32).max(vh) } else { vh }),
    };
    let (w, h) = (w.max(1), h.min(opts.max_height).max(1));
    let scale = if opts.scale.is_finite() && opts.scale > 0.0 { opts.scale } else { 1.0 };
    let pw = (w as f64 * scale).round() as u32;
    let ph = (h as f64 * scale).round() as u32;
    if pw == 0 || ph == 0 || pw > MAX_SIDE || ph > MAX_SIDE {
        return Err(format!("screenshot of {pw}x{ph} px is out of range (max {MAX_SIDE})"));
    }

    let doc = layout.base_mut();
    let previous = doc.viewport_scroll();
    doc.set_viewport_scroll(blitz_dom::Point { x: x0, y: y0 });
    let mut renderer = VelloCpuImageRenderer::new(pw, ph);
    let mut pixels = Vec::new();
    renderer.render_to_vec(|scene| blitz_paint::paint_scene(scene, doc, scale, pw, ph, 0, 0), &mut pixels);
    doc.set_viewport_scroll(previous);

    // Premultiplied RGBA over a white page background, then opaque.
    for px in pixels.chunks_exact_mut(4) {
        let uncovered = 255 - px[3] as u32;
        for channel in &mut px[..3] {
            *channel = (*channel as u32 + uncovered).min(255) as u8;
        }
        px[3] = 255;
    }
    Ok((pixels, pw, ph))
}

/// Rasterize an SVG document at its intrinsic size (or `size` when given): straight-alpha RGBA.
pub fn rasterize_svg(data: &[u8], size: Option<(u32, u32)>) -> Option<(Vec<u8>, u32, u32)> {
    let tree = usvg::Tree::from_data(data, &usvg::Options::default()).ok()?;
    let ts = tree.size();
    let (w, h) = size.unwrap_or((ts.width().ceil() as u32, ts.height().ceil() as u32));
    if w == 0 || h == 0 || w > 8192 || h > 8192 {
        return None;
    }
    let transform = vello_cpu::kurbo::Affine::scale_non_uniform(w as f64 / ts.width() as f64, h as f64 / ts.height() as f64);
    let mut renderer = VelloCpuImageRenderer::new(w, h);
    let mut pixels = Vec::new();
    renderer.render_to_vec(|scene| anyrender_svg::render_svg_tree(scene, &tree, transform), &mut pixels);
    // premultiplied -> straight alpha
    for px in pixels.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a > 0 && a < 255 {
            for c in &mut px[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    Some((pixels, w, h))
}

fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}
