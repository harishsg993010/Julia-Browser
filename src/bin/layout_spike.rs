//! Layout spike: lay out a page with blitz-dom and dump boxes.
//!
//!   cargo run --features layout --bin layout_spike -- <url-or-file> [--point X Y] [--all]

use julia_browser::http::HttpClient;
use julia_browser::layout::blitz::{Layout, DEFAULT_VIEWPORT};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(target) = args.first().cloned() else {
        eprintln!("usage: layout_spike <url-or-file> [--point X Y] [--all]");
        std::process::exit(2);
    };
    let all = args.iter().any(|a| a == "--all");
    let point = args.iter().position(|a| a == "--point").and_then(|i| Some((args.get(i + 1)?.parse::<f64>().ok()?, args.get(i + 2)?.parse::<f64>().ok()?)));

    let client = HttpClient::new(None);
    let started = Instant::now();
    let (html, base_url) = if target.starts_with("http://") || target.starts_with("https://") {
        let resp = client.get_simple(&target, 30).expect("fetch failed");
        (resp.text, resp.url)
    } else {
        let path = std::path::Path::new(&target).canonicalize().expect("file not found");
        (std::fs::read_to_string(&path).expect("read failed"), url::Url::from_file_path(&path).unwrap().to_string())
    };
    println!("fetched {} bytes in {} ms", html.len(), started.elapsed().as_millis());
    let base_url = args.iter().position(|a| a == "--base").and_then(|i| args.get(i + 1).cloned()).unwrap_or(base_url);

    let layout = Layout::from_html(&html, &base_url, client, DEFAULT_VIEWPORT, 40);
    let t = Instant::now();
    let (w, h) = layout.document_size();
    println!("document_size took {} ms", t.elapsed().as_millis());
    println!("laid out {} nodes in {} ms; document {w:.0}x{h:.0} css px", layout.node_count(), layout.resolve_ms);
    for (url, status, bytes) in layout.network_log() {
        println!("  sub-resource {status} {bytes}B {url}");
    }

    let t = Instant::now();
    let elements = layout.elements();
    println!("elements took {} ms", t.elapsed().as_millis());
    let visible = elements.iter().filter(|e| !e.rect.is_empty()).count();
    println!("{} elements, {} with a non-empty box", elements.len(), visible);
    let limit = if all { usize::MAX } else { 60 };
    for e in elements.iter().filter(|e| !e.rect.is_empty()).take(limit) {
        let id = e.id.as_deref().map(|s| format!("#{s}")).unwrap_or_default();
        println!("  <{}{id}> x={:.0} y={:.0} w={:.0} h={:.0}", e.tag, e.rect.x, e.rect.y, e.rect.width, e.rect.height);
    }
    if let Some((x, y)) = point {
        match layout.element_at(x, y) {
            Some(e) => println!("element at ({x},{y}): <{}{}> {:?}", e.tag, e.id.as_deref().map(|s| format!("#{s}")).unwrap_or_default(), e.rect),
            None => println!("element at ({x},{y}): none"),
        }
    }
}
