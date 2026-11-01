//! Pixel screenshots of a fixture:
//! `cargo test --features screenshot --test screenshot`.
#![cfg(feature = "screenshot")]

use julia_browser::dom;
use julia_browser::http::HttpClient;
use julia_browser::layout::blitz::{Layout, DEFAULT_VIEWPORT};
use julia_browser::layout::screenshot::render_png;
use julia_browser::layout::ScreenshotOptions;

fn fixture_layout(name: &str) -> (Layout, Vec<ego_tree::NodeId>) {
    let path = format!("{}/tests/layout/{name}", env!("CARGO_MANIFEST_DIR"));
    let html = std::fs::read_to_string(&path).expect("fixture");
    let doc = dom::parse_document(&html);
    let mut tagged = dom::clone_document(&doc);
    let ids = dom::find_all(&tagged, &[]);
    for (i, id) in ids.iter().enumerate() {
        dom::set_attr(&mut tagged, *id, "data-jb", &i.to_string());
    }
    let layout = Layout::from_html(&dom::to_html(&tagged), "file:///fixture.html", HttpClient::new(None), DEFAULT_VIEWPORT, 0);
    let ids = ids.into_iter().collect();
    (layout, ids)
}

/// Decode a PNG into (width, height, RGBA bytes).
fn decode(png: &[u8]) -> (u32, u32, Vec<u8>) {
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "not a PNG");
    let decoder = png::Decoder::new(png);
    let mut reader = decoder.read_info().expect("png header");
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).expect("png data");
    buf.truncate(info.buffer_size());
    (info.width, info.height, buf)
}

fn pixel(rgba: &[u8], width: u32, x: u32, y: u32) -> [u8; 3] {
    let i = ((y * width + x) * 4) as usize;
    [rgba[i], rgba[i + 1], rgba[i + 2]]
}

#[test]
fn full_page_screenshot_paints_the_fixture() {
    let (mut layout, _) = fixture_layout("flex-columns.html");
    let png = render_png(&mut layout, &ScreenshotOptions::default()).expect("png");
    let (w, h, rgba) = decode(&png);
    assert_eq!(w, 1280);
    assert!(h >= 720, "height {h}");
    // The header is #333 across the top; the body below it is white.
    assert_eq!(pixel(&rgba, w, 640, 30), [0x33, 0x33, 0x33], "header pixel");
    assert_eq!(pixel(&rgba, w, 10, 700), [255, 255, 255], "page background");
    // The fixed modal (300,100 400x200) has a black border on white.
    assert_eq!(pixel(&rgba, w, 300, 200), [0, 0, 0], "modal border");
}

#[test]
fn clipped_screenshot_captures_one_element() {
    let (mut layout, ids) = fixture_layout("flex-columns.html");
    let doc = dom::parse_document(&std::fs::read_to_string(format!("{}/tests/layout/flex-columns.html", env!("CARGO_MANIFEST_DIR"))).unwrap());
    let modal = dom::find_by_id(&doc, "modal").unwrap();
    let jbid = ids.iter().position(|n| *n == modal).unwrap();
    let clip = layout.rect_of_jbid(jbid).expect("modal box");
    let png = render_png(&mut layout, &ScreenshotOptions { clip: Some(clip), ..Default::default() }).expect("png");
    let (w, h, rgba) = decode(&png);
    assert_eq!((w, h), (402, 202), "modal is 400x200 plus its 1px border");
    assert_eq!(pixel(&rgba, w, 0, 100), [0, 0, 0], "left border");
    assert_eq!(pixel(&rgba, w, 200, 150), [255, 255, 255], "modal interior");

    let scaled = render_png(&mut layout, &ScreenshotOptions { clip: Some(clip), scale: 2.0, ..Default::default() }).expect("png");
    let (w2, h2, _) = decode(&scaled);
    assert_eq!((w2, h2), (804, 404));
}

/// Document regions (not only the first viewport) at device scales 1 and 2: the stripes of a tall
/// page come out where the clip says, including clips that start below the last full viewport.
#[test]
fn clip_regions_at_scales() {
    let html = r#"<!DOCTYPE html><html><head><style>html,body{margin:0}div{width:1280px;height:500px}</style></head><body>
        <div style="background:#ff0000"></div><div style="background:#00ff00"></div><div style="background:#0000ff"></div><div style="background:#ffff00"></div></body></html>"#;
    let mut layout = Layout::from_html(html, "file:///stripes.html", HttpClient::new(None), DEFAULT_VIEWPORT, 0);
    let rect = |x: f64, y: f64, w: f64, h: f64| julia_browser::layout::Rect { x, y, width: w, height: h, ..Default::default() };
    for scale in [1.0, 2.0] {
        let s = scale as u32;
        // straddles red / green
        let png = render_png(&mut layout, &ScreenshotOptions { clip: Some(rect(0.0, 450.0, 100.0, 100.0)), scale, ..Default::default() }).expect("png");
        let (w, h, rgba) = decode(&png);
        assert_eq!((w, h), (100 * s, 100 * s), "scale {scale}");
        assert_eq!(pixel(&rgba, w, 50 * s, 25 * s), [255, 0, 0], "scale {scale}: red above y=500");
        assert_eq!(pixel(&rgba, w, 50 * s, 75 * s), [0, 255, 0], "scale {scale}: green below y=500");
        // the last stripe: beyond the largest viewport scroll (2000 - 720)
        let png = render_png(&mut layout, &ScreenshotOptions { clip: Some(rect(600.0, 1900.0, 80.0, 80.0)), scale, ..Default::default() }).expect("png");
        let (w, h, rgba) = decode(&png);
        assert_eq!((w, h), (80 * s, 80 * s), "scale {scale}");
        assert_eq!(pixel(&rgba, w, 40 * s, 40 * s), [255, 255, 0], "scale {scale}: yellow at y=1940");
        // fractional origin: the top row is still the stripe at that y
        let png = render_png(&mut layout, &ScreenshotOptions { clip: Some(rect(10.5, 999.5, 20.0, 20.0)), scale, ..Default::default() }).expect("png");
        let (w, _, rgba) = decode(&png);
        assert_eq!(pixel(&rgba, w, 10 * s, 15 * s), [0, 0, 255], "scale {scale}: blue below y=1000");
    }
}
