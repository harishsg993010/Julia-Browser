//! Visual-order rendering over a real layout:
//! `cargo test --features layout --test visual_order`.
#![cfg(feature = "layout")]

use julia_browser::dom;
use julia_browser::http::HttpClient;
use julia_browser::layout::blitz::{Layout, DEFAULT_VIEWPORT};
use julia_browser::layout::visual::{reorder, Options};
use julia_browser::markdown::{html_to_markdown, MarkdownOptions};

fn layout_fixture(name: &str) -> (julia_browser::dom::Document, Layout, Vec<ego_tree::NodeId>) {
    let path = format!("{}/tests/layout/{name}", env!("CARGO_MANIFEST_DIR"));
    let html = std::fs::read_to_string(&path).expect("fixture");
    let doc = dom::parse_document(&html);
    let mut tagged = dom::clone_document(&doc);
    let ids = dom::find_all(&tagged, &[]);
    for (i, id) in ids.iter().enumerate() {
        dom::set_attr(&mut tagged, *id, "data-jb", &i.to_string());
    }
    let layout = Layout::from_html(&dom::to_html(&tagged), "file:///fixture.html", HttpClient::new(None), DEFAULT_VIEWPORT, 0);
    (doc, layout, ids)
}

fn render_fixture(name: &str, reader: bool) -> String {
    let (doc, layout, ids) = layout_fixture(name);
    let boxes = layout.boxes().into_iter().map(|(i, b)| (ids[i], b)).collect();
    let out = reorder(&doc, &boxes, Options { viewport: (DEFAULT_VIEWPORT.0 as f64, DEFAULT_VIEWPORT.1 as f64), reader }).expect("layout usable");
    html_to_markdown(&out, &MarkdownOptions::default())
}

#[test]
fn flex_columns_follow_visual_order() {
    let md = render_fixture("flex-columns.html", false);
    let pos = |s: &str| md.find(s).unwrap_or_else(|| panic!("missing {s:?} in:\n{md}"));
    // The fixed cookie banner comes first, then header, the three columns
    // left to right, and the footer.
    assert!(md.starts_with("**Overlay**\n\nCookie banner: Accept\n\n---"), "{md}");
    let order = [pos("Site title"), pos("**Navigation**"), pos("[Alpha](/a)"), pos("**Main content**"), pos("# Article heading"), pos("Card four"), pos("| Name | Qty |"), pos("Buy now"), pos("**Sidebar**"), pos("Related links"), pos("Footer text")];
    assert!(order.windows(2).all(|w| w[0] < w[1]), "{md}");
    for hidden in ["Hidden paragraph", "Invisible paragraph", "Off-screen paragraph"] {
        assert!(!md.contains(hidden), "{hidden} should be dropped:\n{md}");
    }
}

#[test]
fn reader_mode_puts_main_column_first() {
    let md = render_fixture("flex-columns.html", true);
    let main = md.find("# Article heading").unwrap();
    let nav = md.find("[Alpha](/a)").unwrap();
    let aside = md.find("Related links").unwrap();
    assert!(main < nav && nav < aside, "{md}");
}

#[test]
fn layout_text_screenshot_places_columns_side_by_side() {
    use julia_browser::layout::text::render;
    use julia_browser::layout::TextOptions;
    let (_, layout, _) = layout_fixture("flex-columns.html");
    let text = render(&layout, &TextOptions { cols: 160, annotate: true, ..Default::default() });
    println!("{text}");
    let lines: Vec<&str> = text.lines().collect();
    let find = |s: &str| lines.iter().position(|l| l.contains(s)).unwrap_or_else(|| panic!("missing {s:?} in:\n{text}"));
    let col = |s: &str| lines[find(s)].find(s).unwrap();
    // Header on the first rows, nav left of the article, aside at the right
    // (the modal covers the heading, so the paragraph is the anchor).
    assert!(find("Site title") <= 2, "{text}");
    assert!(col("Alpha") < col("First pa") && col("First pa") < col("Related links"), "{text}");
    assert!(find("Related links") < find("First pa"), "{text}");
    // The cookie banner is drawn over the page (button text included), the
    // hidden text is absent.
    assert!(text.contains("Cookie banner") && text.contains("Accept") && text.contains("Buy now"), "{text}");
    assert!(!text.contains("Hidden paragraph") && !text.contains("Off-screen"), "{text}");
    // Table text and card boxes (bordered) are drawn; annotate labels ids.
    assert!(text.contains("Apples") && text.contains("Card three") && text.contains('│'), "{text}");
    assert!(text.contains("#main"), "{text}");
}
