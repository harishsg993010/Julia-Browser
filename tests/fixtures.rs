//! Golden-file tests over the layout fixtures: each page
//! in `tests/layout` is loaded through the real pipeline (HTTP, JavaScript,
//! layout, visual-order rendering) and its Markdown is compared with
//! `tests/layout/expected/<name>.md`. The character-cell screenshots are
//! written next to them (`.txt`) for people to look at but only checked for
//! properties, since text metrics depend on the machine's fonts.
//!
//!     cargo test --features layout --test fixtures
//!     UPDATE_GOLDENS=1 cargo test --features layout --test fixtures   # accept changes
#![cfg(feature = "layout")]

use julia_browser::agent::AgentSdk;
use julia_browser::layout::TextOptions;
use julia_browser::sdk::BrowserSdk;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::time::Instant;

const FIXTURES: &[&str] = &["flex-columns", "grid-dashboard", "sticky-modal", "accordion", "rtl", "table", "lazy-images"];

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("layout")
}

/// Serve `tests/layout` over HTTP on a free port (the browser speaks HTTP only).
fn serve_fixtures() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    let dir = fixtures_dir();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let dir = dir.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let target = request.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
                let path = target.split(['?', '#']).next().unwrap_or("/").trim_start_matches('/');
                let (status, content_type, body) = match std::fs::read(dir.join(path)) {
                    Ok(b) if path.ends_with(".html") => ("200 OK", "text/html; charset=utf-8", b),
                    Ok(b) => ("200 OK", "application/octet-stream", b),
                    Err(_) => ("404 Not Found", "text/plain", b"not found".to_vec()),
                };
                let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = stream.write_all(&body);
            });
        }
    });
    format!("http://127.0.0.1:{port}")
}

fn normalize(s: &str) -> String {
    s.replace("\r\n", "\n").trim_end().to_string()
}

fn updating() -> bool {
    std::env::var_os("UPDATE_GOLDENS").is_some()
}

fn golden_path(name: &str, ext: &str) -> PathBuf {
    fixtures_dir().join("expected").join(format!("{name}.{ext}"))
}

fn check_golden(name: &str, actual: &str) {
    let path = golden_path(name, "md");
    if updating() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, normalize(actual) + "\n").unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("missing {}; run with UPDATE_GOLDENS=1", path.display()));
    assert_eq!(normalize(&expected), normalize(actual), "{name}.md differs from the golden (UPDATE_GOLDENS=1 accepts the new output)");
}

/// Position of `needle` in `hay`, failing with the whole text when absent.
fn pos(hay: &str, needle: &str) -> usize {
    hay.find(needle).unwrap_or_else(|| panic!("missing {needle:?} in:\n{hay}"))
}

fn ordered(hay: &str, needles: &[&str]) {
    let positions: Vec<usize> = needles.iter().map(|n| pos(hay, n)).collect();
    assert!(positions.windows(2).all(|w| w[0] < w[1]), "expected order {needles:?} in:\n{hay}");
}

fn absent(hay: &str, needles: &[&str]) {
    for n in needles {
        assert!(!hay.contains(n), "{n:?} should not be rendered:\n{hay}");
    }
}

/// What must hold for each fixture regardless of fonts.
fn properties(name: &str, md: &str, screen: &str) {
    match name {
        "flex-columns" => {
            ordered(md, &["**Overlay**", "Cookie banner", "Site title", "**Main content**", "Article heading", "**Navigation**", "Alpha", "**Sidebar**", "Footer text"]);
            absent(md, &["Hidden paragraph", "Invisible paragraph", "Off-screen"]);
            ordered(screen, &["Site title", "Footer text"]);
        }
        "grid-dashboard" => {
            ordered(md, &["Dashboard", "Users", "Errors", "Alpha", "Beta", "Gamma", "Delta", "Zeta", "Updated 5 minutes ago"]);
            assert!(md.contains("- ## Alpha") || md.contains("- Alpha"), "cards should be a list:\n{md}");
            ordered(screen, &["Dashboard", "Alpha", "Delta", "Updated"]);
            // Cards in a grid row share a screen row.
            let row = |s: &str| screen.lines().position(|l| l.contains(s)).unwrap();
            assert_eq!(row("Alpha"), row("Beta"), "{screen}");
        }
        "sticky-modal" => {
            ordered(md, &["**Overlay**", "Subscribe", "Get our newsletter", "We use cookies", "---", "Site header", "Article", "Body text one", "Body text two"]);
            absent(md, &["Hidden menu items"]);
            ordered(screen, &["Site header", "Subscribe", "We use cookies"]);
            absent(screen, &["Hidden menu"]);
        }
        "accordion" => {
            ordered(md, &["Closed section", "Open section", "Open content", "Show more", "Visible end"]);
            absent(md, &["Closed content", "Panel content", "Invisible text", "Transparent text"]);
            absent(screen, &["Panel content", "Invisible text", "Transparent text"]);
        }
        "rtl" => {
            // Reader order: main column, then the rest right to left.
            ordered(md, &["Article title", "Menu one", "Related items"]);
            let col = |s: &str| screen.lines().find(|l| l.contains(s)).unwrap().find(s).unwrap();
            assert!(col("Menu one") > col("Article title") && col("Article title") > col("Related items"), "{screen}");
        }
        "table" => {
            ordered(md, &["Inventory", "| Name | Qty | Price |", "| Apples | 3 | 1.20 |", "| Pears | 5 | 2.50 |", "Left cell text", "Right cell text"]);
            assert!(screen.contains('│') && screen.contains("Apples"), "{screen}");
            let row = |s: &str| screen.lines().position(|l| l.contains(s)).unwrap();
            assert_eq!(row("Left cell text"), row("Right cell text"), "{screen}");
        }
        "lazy-images" => {
            // The first image is in the viewport and loads; nothing below the fold does.
            ordered(md, &["Gallery", "![First picture](/img/one.png)"]);
            absent(md, &["Loaded item"]);
        }
        other => panic!("no properties for {other}"),
    }
}

#[test]
fn fixture_goldens() {
    let base = serve_fixtures();
    let mut sdk = BrowserSdk::default();
    for name in FIXTURES {
        let url = format!("{base}/{name}.html");
        let result = sdk.render_to_markdown(&url, true, None);
        assert!(result.success, "{name}: {:?}", result.error);
        let md = result.content.unwrap_or_default();
        check_golden(name, &md);
        // Default width: 8 px cells match typical glyph widths, so text stays
        // inside its boxes.
        let shot = sdk.render_to_layout(&url, true, None, &TextOptions::default());
        assert!(shot.success, "{name}: {:?}", shot.error);
        let screen = shot.content.unwrap_or_default();
        if updating() {
            std::fs::write(golden_path(name, "txt"), normalize(&screen) + "\n").unwrap();
        }
        properties(name, &md, &screen);
    }
}

/// Scrolling (via the page's own `window.scrollTo`) makes the observers below
/// the fold fire: the second image loads and the list fills, and the rendered
/// page follows. Also measures the interaction round trip.
#[test]
fn lazy_loading_reacts_to_scrolling() {
    let base = serve_fixtures();
    let mut agent = AgentSdk::default();
    let opened = agent.open_website(&format!("{base}/lazy-images.html"));
    assert!(opened["success"].as_bool().unwrap_or(false), "{opened}");
    let state = |agent: &mut AgentSdk| {
        let r = agent.execute_javascript("[document.getElementById('i1').getAttribute('src'), document.getElementById('i2').getAttribute('src'), document.getElementById('list').children.length].join('|')");
        r["result"].as_str().unwrap_or_default().trim_matches('"').to_string()
    };
    assert_eq!(state(&mut agent), "/img/one.png||0");

    let started = Instant::now();
    let scrolled = agent.execute_javascript("window.scrollTo(0, 1800)");
    assert!(scrolled["success"].as_bool().unwrap_or(false), "{scrolled}");
    let info = agent.get_page_info();
    let round_trip = started.elapsed();
    println!("interaction round trip (scroll + observers + relayout + render): {} ms", round_trip.as_millis());

    let after = state(&mut agent);
    assert!(after.starts_with("/img/one.png|/img/two.png|"), "{after}");
    let items: usize = after.rsplit('|').next().unwrap().parse().unwrap();
    assert!(items >= 5, "list should have grown: {after}");
    let content = info["content"].as_str().unwrap_or_default();
    assert!(content.contains("Loaded item 1"), "{content}");
    assert!(round_trip.as_millis() < 3000, "round trip too slow: {} ms", round_trip.as_millis());
}
