//! blitz-dom backend: parse the page HTML, resolve styles and layout, and
//! expose boxes keyed by the JS DOM's element ids.

use super::{BoxInfo, LaidOutElement, Position, Rect};
use crate::http::HttpClient;
use blitz_dom::{BaseDocument, DocumentConfig, NodeId, DEFAULT_CSS};
use blitz_html::HtmlDocument;
use blitz_traits::net::{NetHandler, NetProvider, Request};
use blitz_traits::shell::{ColorScheme, Viewport};
use markup5ever::LocalName;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Default viewport, in CSS pixels.
pub const DEFAULT_VIEWPORT: (u32, u32) = (1280, 720);

/// Sub-resource loader (stylesheets, `@import`s, fonts) that goes through the
/// browser's HTTP session so cookies, proxy rules and budgets apply. Requests
/// are served synchronously: blitz hands the bytes to its own queue and picks
/// them up on the next `resolve`.
struct SessionNet {
    client: HttpClient,
    timeout_secs: u64,
    max_requests: usize,
    fetch_images: bool,
    /// The document URL: the initiator for fetch metadata.
    base: String,
    requests: AtomicUsize,
    /// Web fonts downloaded (not served from the cache) by this layout.
    fonts: AtomicUsize,
    log: Mutex<Vec<(String, u16, usize)>>,
}

/// Sub-resources whose last layout fetch failed (non-200 or network error), with when. Only
/// successes were cached, so every relayout retried each broken image or font, one at a time
/// (LiveJournal: ~46 s of repeated 404/502 image fetches during one load).
static FAILED_CACHE: std::sync::LazyLock<Mutex<std::collections::HashMap<String, Instant>>> = std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
const FAILED_CACHE_TTL_SECS: u64 = 120;

fn failed_recently(url: &str) -> bool {
    FAILED_CACHE.lock().unwrap().get(url).is_some_and(|at| at.elapsed().as_secs() < FAILED_CACHE_TTL_SECS)
}

fn remember_failure(url: &str) {
    let mut cache = FAILED_CACHE.lock().unwrap();
    if cache.len() >= 4096 {
        cache.retain(|_, at| at.elapsed().as_secs() < FAILED_CACHE_TTL_SECS);
    }
    cache.insert(url.to_string(), Instant::now());
}

/// New web-font downloads per real-page layout; later faces fall back to system fonts (and are
/// not tried again for FAILED_CACHE_TTL_SECS). Font
/// requests are made one at a time while blitz parses, and an embedded newsletter form loading
/// every Google font cost eastsidefeed.com 273 requests (~12 s) per page load.
const MAX_LAYOUT_FONTS: usize = 24;
/// Larger web fonts are not used by real-page layouts (system fallback): CJK variable fonts of
/// 13.5 MB each made one nvidia.com layout take 18 s.
const MAX_LAYOUT_FONT_BYTES: usize = 3 * 1024 * 1024;

fn is_font_path(path: &str) -> bool {
    [".woff2", ".woff", ".ttf", ".otf", ".eot"].iter().any(|e| path.ends_with(e))
}

/// Bytes of media sub-resources already fetched by a layout, keyed by URL
/// (bounded; the JS side keeps its own list of available images).
static MEDIA_CACHE: std::sync::LazyLock<Mutex<(usize, std::collections::HashMap<String, Vec<u8>>)>> = std::sync::LazyLock::new(|| Mutex::new((0, std::collections::HashMap::new())));
const MEDIA_CACHE_LIMIT: usize = 64 * 1024 * 1024;

fn media_cache_get(url: &str) -> Option<Vec<u8>> {
    MEDIA_CACHE.lock().unwrap().1.get(url).cloned()
}

/// Images the page itself fetched: layout reuses these bytes instead of fetching again (a second
/// request may get a different response).
pub fn remember_page_image(url: &str, bytes: &[u8]) {
    media_cache_put(url, bytes);
}

fn media_cache_put(url: &str, bytes: &[u8]) {
    // one huge entry (a 13 MB CJK font) must not flush everything else
    if bytes.len() > MEDIA_CACHE_LIMIT / 8 {
        return;
    }
    let mut cache = MEDIA_CACHE.lock().unwrap();
    let (used, map) = &mut *cache;
    if let Some(old) = map.remove(url) {
        *used -= old.len();
    }
    while *used + bytes.len() > MEDIA_CACHE_LIMIT {
        let Some(k) = map.keys().next().cloned() else { break };
        if let Some(v) = map.remove(&k) {
            *used -= v.len();
        }
    }
    *used += bytes.len();
    map.insert(url.to_string(), bytes.to_vec());
}

/// Stylesheet and font bytes fetched by layouts on real pages, keyed by URL: (final URL, body,
/// when fetched). Every relayout re-parses the page and blitz asks for every sheet again; a big
/// site has ~40 of them, fetched one after another.
static STYLE_CACHE: std::sync::LazyLock<Mutex<std::collections::HashMap<String, (String, Vec<u8>, Instant)>>> = std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
const STYLE_CACHE_TTL_SECS: u64 = 120;
const STYLE_CACHE_MAX_ENTRIES: usize = 512;

fn style_cache_get(url: &str) -> Option<(String, Vec<u8>)> {
    let cache = STYLE_CACHE.lock().unwrap();
    let (final_url, body, at) = cache.get(url)?;
    (at.elapsed().as_secs() < STYLE_CACHE_TTL_SECS).then(|| (final_url.clone(), body.clone()))
}

fn style_cache_put(url: &str, final_url: &str, body: &[u8]) {
    let mut cache = STYLE_CACHE.lock().unwrap();
    if cache.len() >= STYLE_CACHE_MAX_ENTRIES {
        cache.retain(|_, (_, _, at)| at.elapsed().as_secs() < STYLE_CACHE_TTL_SECS);
        if cache.len() >= STYLE_CACHE_MAX_ENTRIES {
            cache.clear();
        }
    }
    cache.insert(url.to_string(), (final_url.to_string(), body.to_vec(), Instant::now()));
}

/// CSS animations belong to the JS animation engine (63_animations.js), whose values are layered
/// on getComputedStyle. Stylo would run `@keyframes` animations itself at time 0 (fade-ins stuck
/// at `opacity: 0`, WPT underlying values counted twice), so the rules are renamed to an unknown
/// at-rule before blitz sees them; `animation-name` still computes normally.
/// Seconds after load at which real-page layouts sample CSS animations.
const SETTLED_ANIMATION_TIME: f64 = 60.0;

/// `html` serialized from a scripting-enabled DOM with each `<noscript>` emptied. Its content is raw
/// text there (and in Chrome); the layout parsers run with scripting disabled and would parse it as
/// markup: `<noscript><iframe .../></noscript>` (StreetEasy's tag manager) opened an iframe whose raw
/// text swallowed the rest of <body>, so modal portals appended later were never laid out.
pub fn strip_noscript_content(html: &str) -> std::borrow::Cow<'_, str> {
    static NOSCRIPT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?is)(<noscript\b[^>]*>).*?(</noscript\s*>)").unwrap());
    if !html.contains("<noscript") && !html.contains("<NOSCRIPT") {
        return std::borrow::Cow::Borrowed(html);
    }
    NOSCRIPT.replace_all(html, "$1$2")
}

fn disable_keyframes(css: &str) -> std::borrow::Cow<'_, str> {
    static KEYFRAMES: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)@(-webkit-|-moz-|-o-)?keyframes\b").unwrap());
    // Real pages keep their @keyframes: the layout settles them (see SETTLED_ANIMATION_TIME).
    if std::env::var_os("JB_STYLO_KEYFRAMES").is_some() || crate::js::runtime::real_pages() {
        return std::borrow::Cow::Borrowed(css);
    }
    KEYFRAMES.replace_all(css, "@jb-disabled-keyframes")
}

/// `::placeholder` rules -> `[data-jb-ph]`: the layout mirror shows an empty field's placeholder
/// as its value (see layoutFormState in 20_html.js); colors become `!important` to beat the
/// default placeholder color. Mirrors `__jb.placeholderCss` in 90_bridge.js.
fn placeholder_css(css: &str) -> std::borrow::Cow<'_, str> {
    static RULE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)([^{}]*?(?:::?-?(?:webkit-input-|moz-|ms-input-)?placeholder|:placeholder-shown)[^{}]*)\{([^{}]*)\}").unwrap());
    static SEL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i):placeholder-shown\b|::?-?(?:webkit-input-|moz-|ms-input-)?placeholder\b").unwrap());
    static COLOR: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)(^|;)(\s*color\s*:)([^;!}]*)(;|$)").unwrap());
    if !css.contains("placeholder") {
        return std::borrow::Cow::Borrowed(css);
    }
    RULE.replace_all(css, |c: &regex::Captures| {
        let sel = SEL.replace_all(&c[1], "[data-jb-ph]");
        let body = COLOR.replace_all(&c[2], "${1}${2}${3} !important${4}");
        format!("{sel}{{{body}}}")
    })
}

/// Real pages: `:hover` -> `[data-jbhv]`, the attribute the layout mirror puts on the pointer's
/// hover chain (blitz never sets the hover state). Mirrors fixHover in 90_bridge.js.
fn hover_css(css: &str) -> std::borrow::Cow<'_, str> {
    static HOVER: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)(\(\s*(?:any-)?hover\s*)?:hover([\w-]?)").unwrap());
    if !css.contains(":hover") || !crate::js::runtime::real_pages() {
        return std::borrow::Cow::Borrowed(css);
    }
    HOVER.replace_all(css, |c: &regex::Captures| {
        // `(hover:hover)` media features and longer names (`:hover-x`) stay
        if c.get(1).is_some_and(|m| !m.as_str().is_empty()) || !c[2].is_empty() { c[0].to_string() } else { "[data-jbhv]".to_string() }
    })
}

/// Real pages: `:popover-open` -> `[jb-open]` and `:modal` -> `[jb-modal]`, the attributes the layout
/// mirror puts on open popovers / modal dialogs (blitz never sets those states). Steam's review
/// filter flyouts are `._x:not(:popover-open){display:none !important}`: they never showed.
/// Escaped class names (`.\:popover-open`) stay. Mirrors fixPopover in 90_bridge.js.
/// Also (all pages) `:defined` -> `:not([data-jbu])`, as fixDef does for `<style>` blocks: Stylo never
/// matches `:defined` here, so linked-sheet rules like cars.com's
/// `fuse-popover:where(:not(:defined):not([defer-hydration])){display:none}` hid every popover.
fn popover_css(css: &str) -> std::borrow::Cow<'_, str> {
    static STATE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(\\)?:(popover-open|modal|defined)([\w-]?)").unwrap());
    let real = crate::js::runtime::real_pages();
    if !(css.contains(":defined") || (real && (css.contains(":popover-open") || css.contains(":modal")))) {
        return std::borrow::Cow::Borrowed(css);
    }
    STATE.replace_all(css, |c: &regex::Captures| {
        if c.get(1).is_some() || !c[3].is_empty() {
            return c[0].to_string();
        }
        match &c[2] {
            "defined" => ":not([data-jbu])".to_string(),
            _ if !real => c[0].to_string(),
            "modal" => "[jb-modal]".to_string(),
            _ => "[jb-open]".to_string(),
        }
    })
}

fn disable_keyframes_bytes(body: Vec<u8>) -> Vec<u8> {
    match std::str::from_utf8(&body) {
        Ok(text) => {
            let css = disable_keyframes(text);
            let rewritten = match placeholder_css(&css) {
                std::borrow::Cow::Owned(t) => Some(t),
                std::borrow::Cow::Borrowed(_) => None,
            };
            let hovered = match hover_css(rewritten.as_deref().unwrap_or(&css)) {
                std::borrow::Cow::Owned(t) => Some(t),
                std::borrow::Cow::Borrowed(_) => None,
            };
            let rewritten = hovered.or(rewritten);
            let popped = match popover_css(rewritten.as_deref().unwrap_or(&css)) {
                std::borrow::Cow::Owned(t) => Some(t),
                std::borrow::Cow::Borrowed(_) => None,
            };
            let rewritten = popped.or(rewritten);
            match (rewritten, css) {
                (Some(t), _) | (None, std::borrow::Cow::Owned(t)) => t.into_bytes(),
                (None, std::borrow::Cow::Borrowed(_)) => body,
            }
        }
        Err(_) => body,
    }
}

impl NetProvider for SessionNet {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let url = request.url.to_string();
        if let Some(rest) = url.strip_prefix("data:") {
            let bytes = data_url_bytes(rest).unwrap_or_default();
            handler.bytes(url, bytes.into());
            return;
        }
        // Canvas bitmaps painted into the layout mirror (see __jb.canvasLayoutPaint in 59_canvas.js):
        // encoded from the canvas store, never fetched. The URL carries the bitmap version, so the
        // media cache serves an unchanged canvas on later layouts.
        #[cfg(feature = "canvas")]
        if url.starts_with(crate::canvas::LAYOUT_URL_PREFIX) {
            if !self.fetch_images {
                return;
            }
            if let Some(bytes) = media_cache_get(&url) {
                handler.bytes(url, bytes.into());
                return;
            }
            let png = crate::canvas::layout_png(&url).unwrap_or_default();
            if !png.is_empty() {
                media_cache_put(&url, &png);
            }
            handler.bytes(url, png.into());
            return;
        }
        // Every request must complete, even empty: a stylesheet left pending blocks the whole
        // layout (a `blob:` sheet made 1mg's search page lay out as a 0x0 body).
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            handler.bytes(url, Vec::new().into());
            return;
        }
        // `url(#id)` in SVG mask/clip-path/fill references this document, not a resource: each
        // used to download the whole page again (BigBasket: 338 KB per icon).
        if let Some((doc_part, _)) = url.split_once('#') {
            if doc_part == self.base.split('#').next().unwrap_or("") {
                handler.bytes(url, Vec::new().into());
                return;
            }
        }
        // Only stylesheets matter for boxes: images keep their attribute /
        // default size and text is measured with system fonts, so image and
        // web-font downloads are skipped (blitz gives no request hint, hence
        // the URL heuristics).
        if !self.fetch_images && looks_like_media(&url) {
            return;
        }
        let media = self.fetch_images && looks_like_media(&url);
        if self.fetch_images {
            if let Some(bytes) = media_cache_get(&url) {
                handler.bytes(url, bytes.into());
                return;
            }
        }
        let real = crate::js::runtime::real_pages();
        let style_cache = !media && real;
        if style_cache {
            if let Some((final_url, bytes)) = style_cache_get(&url) {
                handler.bytes(final_url, disable_keyframes_bytes(bytes).into());
                return;
            }
        }
        let lower = url.to_ascii_lowercase();
        let path = lower.split(['?', '#']).next().unwrap_or("");
        let font = is_font_path(path);
        if real {
            // Known failures, ad iframes (their documents add nothing to the page's boxes) and
            // fonts beyond the per-layout cap complete empty instead of hitting the network.
            let ad_frame = !media && !font && crate::js::is_ad_script(&url);
            let over_font_cap = font && self.fonts.fetch_add(1, Ordering::SeqCst) >= MAX_LAYOUT_FONTS;
            if ad_frame || over_font_cap || failed_recently(&url) {
                // A face skipped by the cap stays skipped: otherwise every relayout downloads the
                // next MAX_LAYOUT_FONTS uncached faces and all of them are fetched anyway.
                if over_font_cap {
                    remember_failure(&url);
                }
                handler.bytes(url, Vec::new().into());
                return;
            }
        }
        if self.requests.fetch_add(1, Ordering::SeqCst) >= self.max_requests {
            if !media {
                handler.bytes(url, Vec::new().into());
            }
            return;
        }
        let started = Instant::now();
        let trace = std::env::var_os("JB_TRACE_JS").is_some();
        let (dest, mode) = if font {
            ("font", "cors")
        } else if media {
            ("image", "no-cors")
        } else {
            ("style", "no-cors")
        };
        let headers = crate::http::fetch_metadata_headers(dest, mode, &self.base, &url);
        let result = self.client.request("GET", &url, &headers, None, self.timeout_secs, true);
        if trace {
            eprintln!("[layout] fetch {url} -> {} in {} ms", match &result { Ok(r) => r.status.to_string(), Err(e) => format!("err {e}") }, started.elapsed().as_millis());
        }
        match result {
            Ok(resp) if resp.status == 200 && real && font && resp.body.len() > MAX_LAYOUT_FONT_BYTES => {
                self.log.lock().unwrap().push((url.clone(), resp.status, resp.body.len()));
                if trace {
                    eprintln!("[layout] font {url} skipped: {} bytes", resp.body.len());
                }
                remember_failure(&url);
                handler.bytes(url, Vec::new().into());
            }
            Ok(resp) if resp.status == 200 => {
                self.log.lock().unwrap().push((url.clone(), resp.status, resp.body.len()));
                let mut resp = resp;
                // the URL did not look like media, but the response is: cache it as media (the
                // style cache keeps only sheets worth re-parsing)
                let media = media || (self.fetch_images && {
                    let ct = resp.content_type().to_ascii_lowercase();
                    ct.starts_with("image/") || ct.starts_with("font/") || ct.starts_with("video/") || ct.starts_with("audio/") || ct.contains("font-woff")
                });
                #[cfg(feature = "images")]
                if media {
                    // blitz decodes with the image crate, which has no AVIF decoder (src/avif.rs)
                    if let Some(png) = crate::avif::to_png_if_avif(&resp.body) {
                        resp.body = png;
                    }
                }
                if media {
                    media_cache_put(&url, &resp.body);
                } else if style_cache {
                    style_cache_put(&url, &resp.url, &resp.body);
                }
                let body = if media { resp.body } else { disable_keyframes_bytes(resp.body) };
                handler.bytes(resp.url.clone(), body.into());
            }
            // Failed sub-resources still complete (empty) so a missing
            // stylesheet cannot leave layout blocked on a critical resource.
            Ok(resp) => {
                self.log.lock().unwrap().push((url.clone(), resp.status, 0));
                if real {
                    remember_failure(&url);
                }
                handler.bytes(url, Vec::new().into());
            }
            Err(_) => {
                self.log.lock().unwrap().push((url.clone(), 0, 0));
                if real {
                    remember_failure(&url);
                }
                handler.bytes(url, Vec::new().into());
            }
        }
    }
}

/// Top-layer rules for the JS DOM's popover/dialog state. Blitz never sets the
/// `:popover-open`/`:modal` element states, so the serializer marks showing
/// popovers with `jb-open` and modal dialogs with `jb-modal`; the repeated
/// attribute selectors outrank the default sheet's `[popover]:not(...)` rule.
const JB_UA_CSS: &str = "[popover][jb-open][jb-open][jb-open][jb-open] { display: block; position: fixed; inset: 0; width: -moz-fit-content; height: -moz-fit-content; margin: auto; border: 1px solid; padding: 0.25em; overflow: auto; z-index: 2147483647; background-color: Canvas; color: CanvasText; }
dialog[jb-modal][jb-modal] { position: fixed; inset: 0; margin: auto; width: -moz-fit-content; height: -moz-fit-content; max-width: calc(100% - 6px - 2em); max-height: calc(100% - 6px - 2em); overflow: auto; z-index: 2147483647; }
";

/// blitz requests sub-resources one at a time while it parses, so an image-heavy page would wait
/// for every image in turn. Fetch the document's `<img src>` images in parallel first; the parse then
/// finds them in the media cache.
fn warm_media_cache(html: &str, net: &SessionNet) {
    const WORKERS: usize = 8;
    const MAX_IMAGES: usize = 96;
    static IMG_SRC: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r#"(?i)<img\b[^>]*?\ssrc="([^"]+)""#).unwrap());
    let Ok(base) = url::Url::parse(&net.base) else { return };
    let mut urls: Vec<String> = Vec::new();
    for cap in IMG_SRC.captures_iter(html) {
        let raw = cap[1].replace("&amp;", "&");
        let Ok(abs) = base.join(&raw) else { continue };
        let abs = abs.to_string();
        if (abs.starts_with("http://") || abs.starts_with("https://")) && !urls.contains(&abs) && media_cache_get(&abs).is_none() && !failed_recently(&abs) {
            urls.push(abs);
        }
        if urls.len() >= MAX_IMAGES {
            break;
        }
    }
    if urls.len() < 2 {
        return;
    }
    let queue = Mutex::new(urls);
    std::thread::scope(|scope| {
        for _ in 0..WORKERS {
            scope.spawn(|| loop {
                let Some(url) = queue.lock().unwrap().pop() else { break };
                let headers = crate::http::fetch_metadata_headers("image", "no-cors", &net.base, &url);
                match net.client.request("GET", &url, &headers, None, net.timeout_secs, true) {
                    Ok(resp) if resp.status == 200 => media_cache_put(&url, &resp.body),
                    // 204 tracking pixels and redirects are cheap to ask again; errors (timeouts,
                    // dead hosts) and 4xx/5xx are not asked again on every incremental layout
                    Ok(resp) if resp.status < 400 => {}
                    _ => remember_failure(&url),
                }
            });
        }
    });
}

/// Fetch the page's `<link rel=stylesheet>` sheets in parallel into STYLE_CACHE (real pages)
/// before blitz parses the document: blitz requests them one at a time (Adopt-a-Pet: 3.9 s of
/// serial CSS fetches per first layout).
fn warm_style_cache(html: &str, net: &SessionNet) {
    const WORKERS: usize = 8;
    static LINK: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r#"(?i)<link\b[^>]*>"#).unwrap());
    static HREF: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r#"(?i)\shref="([^"]+)""#).unwrap());
    static REL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r#"(?i)\srel="[^"]*\bstylesheet\b[^"]*""#).unwrap());
    if !crate::js::runtime::real_pages() {
        return;
    }
    let Ok(base) = url::Url::parse(&net.base) else { return };
    let mut urls: Vec<String> = Vec::new();
    for m in LINK.find_iter(html) {
        let tag = m.as_str();
        if !REL.is_match(tag) {
            continue;
        }
        let Some(h) = HREF.captures(tag) else { continue };
        let Ok(abs) = base.join(&h[1].replace("&amp;", "&")) else { continue };
        let abs = abs.to_string();
        if (abs.starts_with("http://") || abs.starts_with("https://")) && !urls.contains(&abs) && style_cache_get(&abs).is_none() && !failed_recently(&abs) {
            urls.push(abs);
        }
    }
    if urls.len() < 2 {
        return;
    }
    let queue = Mutex::new(urls);
    std::thread::scope(|scope| {
        for _ in 0..WORKERS {
            scope.spawn(|| loop {
                let Some(url) = queue.lock().unwrap().pop() else { break };
                let headers = crate::http::fetch_metadata_headers("style", "no-cors", &net.base, &url);
                match net.client.request("GET", &url, &headers, None, net.timeout_secs, true) {
                    Ok(resp) if resp.status == 200 => style_cache_put(&url, &resp.url, &resp.body),
                    _ => remember_failure(&url),
                }
            });
        }
    });
}

fn looks_like_media(url: &str) -> bool {
    if url.contains("/images/") {
        return true;
    }
    let path = url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    const EXT: &[&str] = &[".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".webm", ".mp3", ".gifv", ".pnj", ".jfif", ".apng"];
    EXT.iter().any(|e| path.ends_with(e)) || path.contains("/_next/image") || url.contains("thumb.wikimedia.org")
}

fn data_url_bytes(rest: &str) -> Option<Vec<u8>> {
    let (meta, payload) = rest.split_once(',')?;
    if meta.ends_with(";base64") {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.decode(payload.trim()).ok()
    } else {
        Some(percent_encoding::percent_decode_str(payload).collect())
    }
}

/// A laid-out document.
pub struct Layout {
    doc: HtmlDocument,
    net: Arc<SessionNet>,
    /// Viewport the page was laid out at, in CSS px.
    pub viewport: (u32, u32),
    /// `data-jb` id -> layout node, built on first use.
    nodes: std::cell::OnceCell<std::collections::HashMap<usize, NodeId>>,
    /// Wall-clock cost of parsing + resolving, for diagnostics.
    pub resolve_ms: u128,
    base_url: String,
    /// Animation clock of the last resolve (real pages settle animations, see SETTLED_ANIMATION_TIME).
    anim_time: f64,
    /// Incremental updates applied since the document was built.
    pub updates: usize,
}

impl Layout {
    /// Parse `html` (the page after scripts ran, with `data-jb` attributes on
    /// elements), fetch its stylesheets through `client`, and lay it out at
    /// `viewport` CSS pixels.
    pub fn from_html(html: &str, base_url: &str, client: HttpClient, viewport: (u32, u32), max_requests: usize) -> Layout {
        let net = Arc::new(SessionNet { client, timeout_secs: 15, max_requests, fetch_images: cfg!(feature = "images"), base: base_url.to_string(), requests: AtomicUsize::new(0), fonts: AtomicUsize::new(0), log: Mutex::new(Vec::new()) });
        let started = Instant::now();
        if net.fetch_images {
            warm_media_cache(html, &net);
        }
        warm_style_cache(html, &net);
        let html = disable_keyframes(html);
        let mut doc = HtmlDocument::from_html(
            &html,
            DocumentConfig {
                base_url: Some(base_url.to_string()),
                net_provider: Some(net.clone() as Arc<dyn NetProvider>),
                viewport: Some(Viewport::new(viewport.0, viewport.1, 1.0, ColorScheme::Light)),
                ua_stylesheets: if std::env::var_os("JB_NO_UA_CSS").is_some() { None } else { Some(vec![DEFAULT_CSS.to_string(), JB_UA_CSS.to_string()]) },
                ..Default::default()
            },
        );
        // Sub-resources arrive synchronously; a few rounds settle @import chains.
        for _ in 0..8 {
            doc.resolve(0.0);
            if !doc.has_pending_critical_resources() {
                break;
            }
        }
        doc.resolve(0.0);
        // Real pages (no JS animation engine there): show animations as settled. The pass at 0
        // created them; resolving again later finishes the finite ones, so `forwards` fills apply
        // (fade-ins from `opacity: 0` would otherwise stay invisible: 1mg product images).
        if crate::js::runtime::real_pages() {
            doc.resolve(SETTLED_ANIMATION_TIME);
        }
        if std::env::var_os("JB_TRACE_JS").is_some() {
            eprintln!("[layout] resolved {} nodes in {} ms", doc.tree().len(), started.elapsed().as_millis());
        }
        let anim_time = if crate::js::runtime::real_pages() { SETTLED_ANIMATION_TIME } else { 0.0 };
        Layout { doc, net, viewport, nodes: std::cell::OnceCell::new(), resolve_ms: started.elapsed().as_millis(), base_url: base_url.to_string(), anim_time, updates: 0 }
    }

    /// Bring the layout up to date with `html` (the page re-serialized after DOM changes) by
    /// diffing it against the current document instead of building a new one. Returns false when
    /// the documents cannot be matched (another base URL or viewport, an XHTML document, a
    /// different root); the caller then rebuilds with `from_html`.
    pub fn update(&mut self, html: &str, base_url: &str, viewport: (u32, u32), remap: &[usize]) -> bool {
        if base_url != self.base_url || viewport != self.viewport || super::incremental::sniffs_as_xml(html) {
            return false;
        }
        let started = Instant::now();
        self.net.requests.store(0, Ordering::Relaxed);
        self.net.log.lock().unwrap().clear();
        if self.net.fetch_images {
            warm_media_cache(html, &self.net);
        }
        warm_style_cache(html, &self.net);
        let html = disable_keyframes(html);
        super::incremental::renumber(&mut self.doc, remap);
        // blitz's own incremental mode skips undamaged subtrees when it rebuilds layout children
        // and stacking contexts; after the diff removed nodes, ancestors outside the damaged path
        // kept stale ids (panics in hit testing, painting and damage clearing). Style stays
        // incremental (Stylo restyles only what changed); layout is rebuilt from it.
        self.doc.set_incremental_layout(false);
        let tree = super::incremental::parse(&html);
        let parsed = started.elapsed().as_millis();
        let Some(stats) = super::incremental::apply(&mut self.doc, &tree) else { return false };
        let applied = started.elapsed().as_millis();
        let real = crate::js::runtime::real_pages();
        let t = if real { self.anim_time + SETTLED_ANIMATION_TIME } else { 0.0 };
        for _ in 0..8 {
            self.doc.resolve(t);
            if !self.doc.has_pending_critical_resources() {
                break;
            }
        }
        if self.doc.has_pending_critical_resources() {
            // resolve() returns early while critical sheets/fonts load, leaving the layout tree
            // built before the diff (ids of removed nodes): rebuild from scratch instead
            return false;
        }
        if real {
            // new animations started at `t`: settle them too
            self.anim_time = t + SETTLED_ANIMATION_TIME;
            self.doc.resolve(self.anim_time);
        }
        self.nodes = std::cell::OnceCell::new();
        self.updates += 1;
        self.resolve_ms = started.elapsed().as_millis();
        if std::env::var_os("JB_TRACE_JS").is_some() {
            eprintln!("[layout] incremental update {}: parse {} ms, diff {} ms ({:?}), total {} ms, {} nodes", self.updates, parsed, applied - parsed, stats, self.resolve_ms, self.doc.tree().len());
        }
        true
    }

    pub(crate) fn base(&self) -> &BaseDocument {
        &self.doc
    }

    #[cfg(feature = "screenshot")]
    pub(crate) fn base_mut(&mut self) -> &mut BaseDocument {
        &mut self.doc
    }

    /// Paint opaque RGBA `pixels` (`w` x `h`) as the content of element `jbid` (a frame's picture
    /// in its <iframe> box). -> what `restore_special` gives back after painting.
    #[cfg(feature = "screenshot")]
    pub(crate) fn set_element_picture(&mut self, jbid: usize, w: u32, h: u32, pixels: Vec<u8>) -> Option<(NodeId, blitz_dom::node::SpecialElementData)> {
        use blitz_dom::node::{ImageData, RasterImageData, SpecialElementData};
        let nid = self.node_of_jbid(jbid)?;
        let el = self.doc.get_node_mut(nid)?.element_data_mut()?;
        let image = ImageData::Raster(RasterImageData::new(w, h, Arc::new(pixels)));
        Some((nid, std::mem::replace(&mut el.special_data, SpecialElementData::Image(Box::new(image)))))
    }

    #[cfg(feature = "screenshot")]
    pub(crate) fn restore_special(&mut self, saved: Vec<(NodeId, blitz_dom::node::SpecialElementData)>) {
        for (nid, data) in saved {
            if let Some(el) = self.doc.get_node_mut(nid).and_then(|n| n.element_data_mut()) {
                el.special_data = data;
            }
        }
    }

    /// Sub-resources fetched during layout: (url, status, bytes).
    pub fn network_log(&self) -> Vec<(String, u16, usize)> {
        self.net.log.lock().unwrap().clone()
    }

    pub fn node_count(&self) -> usize {
        self.base().tree().len()
    }

    /// Size of the scrollable document: the root element's box extended by
    /// its scrollable overflow (wide tables, absolutely positioned content).
    pub fn document_size(&self) -> (f64, f64) {
        let l = self.base().root_element().final_layout();
        let o = &l.scrollable_overflow_rect;
        let w = (l.size.width as f64).max(o.right as f64);
        let h = (l.size.height as f64).max(o.bottom as f64);
        (w, h)
    }

    /// Whether the node or an ancestor is `display: none`. Incremental updates leave the old
    /// boxes on descendants of an element that became display:none (layout skips them).
    fn in_display_none(&self, id: NodeId) -> bool {
        let mut cur = Some(id);
        while let Some(c) = cur {
            let Some(node) = self.base().get_node(c) else { return false };
            if node.is_element() && node.primary_styles().is_some_and(|s| s.clone_display().is_none()) {
                return true;
            }
            cur = node.parent;
        }
        false
    }

    /// The bounding box of `r` (untransformed, viewport coordinates) under the CSS transforms of
    /// node `id` and its layout ancestors, or None when none of them is transformed. Each
    /// transformed ancestor maps its subtree about its own untransformed border-box origin; inner
    /// transforms apply first.
    fn transformed_box(&self, id: NodeId, r: [f64; 4]) -> Option<[f64; 4]> {
        let base = self.base();
        let scale = base.viewport().scale_f64();
        let mut pts = [(r[0], r[1]), (r[0] + r[2], r[1]), (r[0], r[1] + r[3]), (r[0] + r[2], r[1] + r[3])];
        let mut any = false;
        let mut cur = Some(id);
        let mut depth = 0;
        while let Some(c) = cur {
            depth += 1;
            if depth > 4096 {
                break;
            }
            let Some(node) = base.get_node(c) else { break };
            // (transform() panics on text/comment nodes; only elements carry transforms)
            let t = if node.is_element() { *node.transform() } else { None };
            if let Some(t) = t {
                // translation components are stored in device pixels
                let [a, b, cc, d, e, f] = t.as_coeffs();
                let (e, f) = (e / scale, f / scale);
                if !(a == 1.0 && b == 0.0 && cc == 0.0 && d == 1.0 && e == 0.0 && f == 0.0) {
                    if let Some(p) = base.get_client_bounding_rect(c) {
                        any = true;
                        for q in pts.iter_mut() {
                            let (x, y) = (q.0 - p.x, q.1 - p.y);
                            *q = (p.x + a * x + cc * y + e, p.y + b * x + d * y + f);
                        }
                    }
                }
            }
            cur = node.layout_parent.get();
        }
        if !any {
            return None;
        }
        let x0 = pts.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
        let y0 = pts.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
        let x1 = pts.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
        let y1 = pts.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
        Some([x0, y0, x1 - x0, y1 - y0])
    }

    /// Whether node `id` is in a viewport-fixed box: it or an ancestor has `position: fixed` and
    /// no transformed ancestor sits above that box.
    fn viewport_fixed(&self, id: NodeId) -> bool {
        use style::properties::generated::longhands::position::computed_value::T as CssPosition;
        let base = self.base();
        let mut fixed = false;
        let mut cur = Some(id);
        let mut depth = 0;
        while let Some(c) = cur {
            depth += 1;
            if depth > 4096 {
                break;
            }
            let Some(node) = base.get_node(c) else { break };
            if node.is_element() {
                if fixed && node.transform().is_some() {
                    return false;
                }
                if node.primary_styles().is_some_and(|s| s.clone_position() == CssPosition::Fixed) {
                    fixed = true;
                }
            }
            cur = node.layout_parent.get();
        }
        fixed
    }

    /// Scroll offsets of element scroll containers (the JS DOM tracks them; the layout does not):
    /// set on the boxes while painting (`on`), cleared again afterwards (rects and hit tests
    /// subtract them on the JS side).
    pub fn set_element_scrolls(&mut self, scrolls: &[(usize, f64, f64)], on: bool) {
        for &(jbid, x, y) in scrolls {
            let Some(nid) = self.node_of_jbid(jbid) else { continue };
            if let Some(node) = self.base_mut().get_node_mut(nid) {
                if node.is_element() {
                    *node.scroll_offset_mut() = if on { blitz_dom::Point { x, y } } else { blitz_dom::Point { x: 0.0, y: 0.0 } };
                }
            }
        }
    }

    fn rect_of_node(&self, id: NodeId) -> Option<Rect> {
        if self.in_display_none(id) {
            return Some(Rect { hidden: true, ..Rect::default() });
        }
        let r = self.base().get_client_bounding_rect(id)?;
        let transformed = self.transformed_box(id, [r.x, r.y, r.width, r.height]);
        let mut rect = Rect { x: r.x, y: r.y, width: r.width, height: r.height, content_width: r.width, content_height: r.height, border: [0.0; 4], padding: [0.0; 4], transformed, hidden: false, fixed: self.viewport_fixed(id) };
        if let Some(node) = self.base().get_node(id) {
            let l = node.final_layout();
            if l.size.width > 0.0 || l.size.height > 0.0 {
                let o = &l.scrollable_overflow_rect;
                // Scrollable overflow measured from the padding edge (CSSOM scrollWidth).
                rect.content_width = (o.right - l.border.left).max(0.0) as f64;
                rect.content_height = (o.bottom - l.border.top).max(0.0) as f64;
                rect.border = [l.border.top as f64, l.border.right as f64, l.border.bottom as f64, l.border.left as f64];
                rect.padding = [l.padding.top as f64, l.padding.right as f64, l.padding.bottom as f64, l.padding.left as f64];
            }
        }
        Some(rect)
    }

    /// Every real element with its box, in tree order.
    pub fn elements(&self) -> Vec<LaidOutElement> {
        let jb = LocalName::from("data-jb");
        let id_name = LocalName::from("id");
        let mut out = Vec::new();
        let mut stack = vec![self.base().root_node().id];
        while let Some(nid) = stack.pop() {
            let Some(node) = self.base().get_node(nid) else { continue };
            for c in node.children.iter().rev() {
                stack.push(*c);
            }
            let Some(el) = node.element_data() else { continue };
            if !node.is_element() {
                continue; // anonymous boxes
            }
            let Some(rect) = self.rect_of_node(nid) else { continue };
            out.push(LaidOutElement {
                tag: el.name.local.to_string(),
                jbid: node.attr(jb.clone()).and_then(|v| v.parse().ok()),
                id: node.attr(id_name.clone()).map(|s| s.to_string()),
                rect,
            });
        }
        out
    }

    fn node_of_jbid(&self, jbid: usize) -> Option<NodeId> {
        self.nodes
            .get_or_init(|| {
                let jb = LocalName::from("data-jb");
                let mut map = std::collections::HashMap::new();
                for (nid, node) in self.base().tree().iter() {
                    if node.is_element() {
                        if let Some(id) = node.attr(jb.clone()).and_then(|v| v.parse::<usize>().ok()) {
                            map.insert(id, nid);
                        }
                    }
                }
                map
            })
            .get(&jbid)
            .copied()
    }

    /// Resolved values (what `getComputedStyle` reports) of `props` for the
    /// element the JS DOM calls `jbid`: Stylo's computed values, with the used
    /// size for `width`/`height` of rendered boxes. Unknown properties map to null.
    /// Values of `props` for the element `jbid`: resolved values (getComputedStyle), or the plain
    /// computed values when `computed_only` (Typed OM computedStyleMap: no used sizes / matrices).
    /// Computed values of `props` for a pseudo-element of the element `jbid` whose cascaded
    /// declarations are `decls` (it inherits from the element).
    pub fn pseudo_style(&self, jbid: usize, decls: &str, base: &str, props: &[String], anim: Option<(&str, &str, f64)>) -> Option<serde_json::Map<String, serde_json::Value>> {
        use style::properties::{PropertyDeclarationId, PropertyId};
        let nid = self.node_of_jbid(jbid)?;
        let doc = self.base();
        let node = doc.get_node(nid)?;
        let parent = node.primary_styles()?;
        let url = crate::layout::cssom::url_data(Some(base));
        let parse = |t: &str| style::properties::parse_style_attribute(t, &url, None, style::context::QuirksMode::NoQuirks, style::stylesheets::CssRuleType::Style);
        let mut block = parse(decls);
        // an animation or transition at `progress` between two declaration sets: the
        // interpolated longhands are appended to the pseudo-element's declarations
        if let Some((from, to, progress)) = anim {
            use style::properties::animated_properties::AnimationValue;
            use style::values::animated::{Animate, Procedure};
            let from_style = doc.compute_style_for_declarations(&parent, parse(&format!("{decls};{from}")));
            let to_style = doc.compute_style_for_declarations(&parent, parse(&format!("{decls};{to}")));
            let mut ids = Vec::new();
            for text in [from, to] {
                let b = parse(text);
                for (d, _) in b.declaration_importance_iter() {
                    if let PropertyDeclarationId::Longhand(lh) = d.id() {
                        if !ids.contains(&lh) {
                            ids.push(lh);
                        }
                    }
                }
            }
            for lh in ids {
                let id = PropertyDeclarationId::Longhand(lh);
                let (Some(a), Some(b)) = (AnimationValue::from_computed_values(id, &from_style), AnimationValue::from_computed_values(id, &to_style)) else { continue };
                let v = match a.animate(&b, Procedure::Interpolate { progress }) {
                    Ok(v) => v,
                    Err(_) => if progress < 0.5 { a } else { b },
                };
                block.push(v.uncompute(), style::properties::Importance::Normal);
            }
        }
        let styles = doc.compute_style_for_declarations(&parent, block);
        let mut out = serde_json::Map::new();
        for p in props {
            let value = match PropertyId::parse_enabled_for_all_content(p) {
                Ok(PropertyId::Custom(ref name)) => Some(styles.computed_value_to_string(PropertyDeclarationId::Custom(name))),
                Ok(id) => match id.longhand_id() {
                    Some(lh) => Some(styles.computed_value_to_string(PropertyDeclarationId::Longhand(lh))),
                    None => id.as_shorthand().ok().map(|sh| {
                        let mut block = style::properties::PropertyDeclarationBlock::new();
                        for lh in sh.longhands() {
                            let mut ctx = style::values::resolved::Context { style: &styles, for_property: PropertyId::NonCustom(lh.into()), current_longhand: Some(lh) };
                            block.push(styles.computed_or_resolved_declaration(lh, Some(&mut ctx)), style::properties::Importance::Normal);
                        }
                        let mut joined = String::new();
                        let _ = block.shorthand_to_css(sh, &mut joined);
                        if joined.is_empty() {
                            let vals: Vec<String> = sh.longhands().map(|lh| styles.computed_value_to_string(PropertyDeclarationId::Longhand(lh))).collect();
                            if !vals.is_empty() && vals.iter().all(|v| v == &vals[0]) { joined = vals[0].clone(); } else { joined = vals.join(" "); }
                        }
                        joined
                    }),
                },
                Err(_) => None,
            };
            if let Some(v) = value {
                out.insert(p.clone(), serde_json::Value::String(v));
            }
        }
        Some(out)
    }

    /// Web Animations arithmetic for one longhand of an element, done by Stylo: `op` is
    /// "interpolate" (`a` -> `b` at `progress`), "add" (`base` + `a`) or "accumulate" (`base` +
    /// `a` x `count`). Values are CSS text computed in the element's context (em, currentcolor,
    /// percentages as for the element); an empty `base` is the element's own computed value.
    /// Returns the computed value as text, or None when the property is not animatable this way
    /// (the caller then falls back to discrete steps or its own model).
    pub fn animate_value(&self, jbid: usize, prop: &str, op: &str, base: &str, a: &str, b: &str, progress: f64, count: u64, url_base: &str) -> Option<String> {
        use style::properties::animated_properties::AnimationValue;
        use style::properties::{LonghandId, PropertyDeclarationId, PropertyId};
        use style::values::animated::{Animate, Procedure};
        let lh = match PropertyId::parse_enabled_for_all_content(prop).ok()?.longhand_id() {
            Some(lh) => lh,
            // shorthands (vertical-align is one in Stylo) are left to the caller's model
            None => return Some("\u{1}discrete".to_string()),
        };
        let id = PropertyDeclarationId::Longhand(lh);
        // Stylo animates this longhand only discretely (or not at all): the caller's own model may
        // know an interpolation, so say so instead of answering with discrete steps
        if op != "resolve" && (!lh.is_animatable() || lh.is_discrete_animatable()) {
            return Some("\u{1}discrete".to_string());
        }
        let nid = self.node_of_jbid(jbid)?;
        let doc = self.base();
        let node = doc.get_node(nid)?;
        let own = node.primary_styles()?;
        let parent_styles = node.parent.and_then(|p| doc.get_node(p)).and_then(|p| p.primary_styles());
        let parent: &style::properties::ComputedValues = match parent_styles.as_ref() {
            Some(ps) => ps,
            None => &own,
        };
        let url = crate::layout::cssom::url_data(Some(url_base));
        let parse = |t: &str| style::properties::parse_style_attribute(t, &url, None, style::context::QuirksMode::NoQuirks, style::stylesheets::CssRuleType::Style);
        // the element's font size and color so that em / currentcolor resolve as on the element
        let mut ctx_decls = String::new();
        if lh != LonghandId::FontSize {
            ctx_decls.push_str(&format!("font-size: {}px;", own.clone_font_size().computed_size().px()));
        }
        if lh != LonghandId::Color {
            ctx_decls.push_str(&format!("color: {};", own.computed_value_to_string(PropertyDeclarationId::Longhand(LonghandId::Color))));
        }
        // widths compute to 0 without a style: keep the element's border / outline / rule style
        let style_for_width = match lh {
            LonghandId::BorderTopWidth => Some(LonghandId::BorderTopStyle),
            LonghandId::BorderRightWidth => Some(LonghandId::BorderRightStyle),
            LonghandId::BorderBottomWidth => Some(LonghandId::BorderBottomStyle),
            LonghandId::BorderLeftWidth => Some(LonghandId::BorderLeftStyle),
            LonghandId::OutlineWidth => Some(LonghandId::OutlineStyle),
            _ => None,
        };
        if let Some(st) = style_for_width {
            ctx_decls.push_str(&format!("{}: {};", st.name(), own.computed_value_to_string(PropertyDeclarationId::Longhand(st))));
        }
        // Stylo clamps overflowed colors before adding; Web Animations adds them unclamped
        if (op == "add" || op == "accumulate") && (prop.ends_with("color") || prop == "fill" || prop == "stroke") {
            return Some("\u{1}value".to_string());
        }
        for extra in [LonghandId::WritingMode, LonghandId::Direction] {
            if lh != extra {
                ctx_decls.push_str(&format!("{}: {};", extra.name(), own.computed_value_to_string(PropertyDeclarationId::Longhand(extra))));
            }
        }
        let value_of = |text: &str| -> Option<AnimationValue> {
            if text.is_empty() {
                return AnimationValue::from_computed_values(id, &own);
            }
            let decl = format!("{ctx_decls}{prop}: {text}");
            let block = parse(&decl);
            // an invalid value leaves only the context declarations: no animation value
            if !block.declaration_importance_iter().any(|(d, _)| d.id() == id) {
                return None;
            }
            let styles = doc.compute_style_for_declarations(parent, block);
            AnimationValue::from_computed_values(id, &styles)
        };
        // no animation value for an endpoint (a value Stylo cannot represent): the caller's model
        let discrete = || Some("\u{1}value".to_string());
        let result = match op {
            "interpolate" => {
                let (Some(va), Some(vb)) = (value_of(a), value_of(b)) else { return discrete() };
                va.animate(&vb, Procedure::Interpolate { progress }).ok()?
            }
            "add" => {
                let (Some(vbase), Some(va)) = (value_of(base), value_of(a)) else { return discrete() };
                vbase.animate(&va, Procedure::Add).ok()?
            }
            "accumulate" => {
                let (Some(vbase), Some(va)) = (value_of(base), value_of(a)) else { return discrete() };
                vbase.animate(&va, Procedure::Accumulate { count }).ok()?
            }
            // the resolved (CSSOM) value of `a`: transforms become matrix() / matrix3d()
            "resolve" => {
                let va = value_of(a)?;
                let mut block = parse(&ctx_decls);
                block.push(va.uncompute(), style::properties::Importance::Normal);
                let styles = doc.compute_style_for_declarations(parent, block);
                if lh == LonghandId::Transform {
                    return transform_matrix(&styles.get_box().clone_transform(), self.rect_of_node(nid).as_ref());
                }
                return Some(styles.computed_value_to_string(id));
            }
            _ => return None,
        };
        let mut block = parse(&ctx_decls);
        block.push(result.uncompute(), style::properties::Importance::Normal);
        let styles = doc.compute_style_for_declarations(parent, block);
        Some(styles.computed_value_to_string(id))
    }

    /// Computed values of the element's generated `::before` / `::after` box, from Stylo's cascade
    /// over every sheet (linked ones included, which the script-side CSSOM does not parse on real
    /// pages). No generated box: `content` is "none" (nothing else known). None: no style data.
    pub fn generated_pseudo_style(&self, jbid: usize, which: &str, props: &[String]) -> Option<serde_json::Map<String, serde_json::Value>> {
        use style::properties::{PropertyDeclarationId, PropertyId};
        let nid = self.node_of_jbid(jbid)?;
        let node = self.base().get_node(nid)?;
        node.primary_styles()?;
        let pid = if which == "before" { node.before() } else { node.after() };
        let mut out = serde_json::Map::new();
        let Some(pid) = pid else {
            // No generated box: the cascade still styles the pseudo (FlightAware reads its column
            // count from `.fa_dashboard_panel::after { content: "0"; display: none }`).
            if let Some(styles) = self.base().lazy_pseudo_style(nid, which != "before") {
                for p in props {
                    if let Ok(id) = PropertyId::parse_enabled_for_all_content(p) {
                        if let Some(lh) = id.longhand_id() {
                            let mut v = styles.computed_value_to_string(PropertyDeclarationId::Longhand(lh));
                            if p == "content" && v == "normal" {
                                v = "none".into();
                            }
                            out.insert(p.clone(), serde_json::Value::String(v));
                        }
                    }
                }
                return Some(out);
            }
            if props.iter().any(|p| p == "content") {
                out.insert("content".into(), serde_json::Value::String("none".into()));
            }
            return Some(out);
        };
        let pnode = self.base().get_node(pid)?;
        let styles = pnode.primary_styles()?;
        for p in props {
            if let Ok(id) = PropertyId::parse_enabled_for_all_content(p) {
                if let Some(lh) = id.longhand_id() {
                    out.insert(p.clone(), serde_json::Value::String(styles.computed_value_to_string(PropertyDeclarationId::Longhand(lh))));
                }
            }
        }
        Some(out)
    }

    pub fn computed_style(&self, jbid: usize, props: &[String], computed_only: bool) -> Option<serde_json::Map<String, serde_json::Value>> {
        use style::properties::{PropertyDeclarationId, PropertyId};
        use style::values::specified::box_::DisplayOutside;
        let nid = self.node_of_jbid(jbid)?;
        let node = self.base().get_node(nid)?;
        let styles = node.primary_styles()?;
        let display = styles.clone_display();
        let tag = node.element_data().map(|e| e.name.local.to_string()).unwrap_or_default();
        let replaced = matches!(tag.as_str(), "img" | "video" | "canvas" | "iframe" | "embed" | "object" | "input" | "select" | "textarea" | "button" | "audio" | "meter" | "progress");
        let sized_box = !display.is_none() && !(display.outside() == DisplayOutside::Inline && !replaced && display.inside() == style::values::specified::box_::DisplayInside::Flow);
        let rect = if sized_box { self.rect_of_node(nid) } else { None };
        let border_box = styles.get_position().box_sizing == style::computed_values::box_sizing::T::BorderBox;
        let mut out = serde_json::Map::new();
        for p in props {
            // Resolved value of `transform` (CSSOM): the transformation matrix, matrix() when it is 2D.
            if p == "transform" && !computed_only {
                if let Some(v) = transform_matrix(&styles.get_box().clone_transform(), rect.as_ref()) {
                    out.insert(p.clone(), serde_json::Value::String(v));
                    continue;
                }
            }
            let longhand = |lh| styles.computed_value_to_string(PropertyDeclarationId::Longhand(lh));
            let value = match PropertyId::parse_enabled_for_all_content(p) {
                // custom properties: the computed value (registered syntax, var() substituted)
                Ok(PropertyId::Custom(ref name)) => Some(styles.computed_value_to_string(PropertyDeclarationId::Custom(name))),
                Ok(id) => match id.longhand_id() {
                    Some(lh) => {
                        let mut v = longhand(lh);
                        if let (Some(r), "width" | "height", false) = (rect.as_ref(), p.as_str(), computed_only) {
                            let used = if p == "width" {
                                if border_box { r.width } else { r.width - r.border[1] - r.border[3] - r.padding[1] - r.padding[3] }
                            } else if border_box {
                                r.height
                            } else {
                                r.height - r.border[0] - r.border[2] - r.padding[0] - r.padding[2]
                            };
                            let used = (used.max(0.0) * 100.0).round() / 100.0;
                            v = format!("{}px", used);
                        }
                        Some(v)
                    }
                    None => match id.as_shorthand() {
                        Ok(sh) => {
                            // Stylo's own shorthand serialization of the computed longhands
                            // (e.g. white-space: pre, not "preserve nowrap").
                            let mut block = style::properties::PropertyDeclarationBlock::new();
                            for lh in sh.longhands() {
                                let mut ctx = style::values::resolved::Context { style: &styles, for_property: PropertyId::NonCustom(lh.into()), current_longhand: Some(lh) };
                                block.push(styles.computed_or_resolved_declaration(lh, Some(&mut ctx)), style::properties::Importance::Normal);
                            }
                            let mut joined = String::new();
                            let _ = block.shorthand_to_css(sh, &mut joined);
                            let vals: Vec<String> = sh.longhands().map(longhand).collect();
                            if !joined.is_empty() {
                                Some(joined)
                            } else if vals.is_empty() {
                                None
                            } else if vals.iter().all(|v| v == &vals[0]) {
                                Some(vals[0].clone())
                            } else if vals.len() == 4 {
                                let (t, r, b, l) = (&vals[0], &vals[1], &vals[2], &vals[3]);
                                Some(if r == l && t == b { format!("{t} {r}") } else if r == l { format!("{t} {r} {b}") } else { format!("{t} {r} {b} {l}") })
                            } else {
                                Some(vals.join(" "))
                            }
                        }
                        Err(_) => None,
                    },
                },
                Err(_) => None,
            };
            out.insert(p.clone(), value.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null));
        }
        Some(out)
    }

    /// Elements whose computed `cursor` is `pointer` while their parent's is not (the outermost
    /// element of each clickable widget, including ones made of plain elements with script
    /// handlers), by `data-jb` id in tree order.
    pub fn pointer_roots(&self) -> Vec<usize> {
        use style::values::computed::ui::CursorKind;
        let jb = LocalName::from("data-jb");
        let base = self.base();
        let is_pointer = |nid: NodeId| base.get_node(nid).filter(|n| n.is_element()).and_then(|n| n.primary_styles()).is_some_and(|s| s.clone_cursor().keyword == CursorKind::Pointer);
        let mut out = Vec::new();
        let mut stack = vec![base.root_node().id];
        while let Some(nid) = stack.pop() {
            let Some(node) = base.get_node(nid) else { continue };
            for c in node.children.iter().rev() {
                stack.push(*c);
            }
            if !node.is_element() || !is_pointer(nid) || node.parent.is_some_and(is_pointer) {
                continue;
            }
            if let Some(j) = node.attr(jb.clone()).and_then(|v| v.parse::<usize>().ok()) {
                out.push(j);
            }
        }
        out
    }

    /// Box of the element the JS DOM calls `jbid`.
    pub fn rect_of_jbid(&self, jbid: usize) -> Option<Rect> {
        // computed on demand: building every element's rect up front cost a walk of the whole tree
        // after each relayout
        let nid = self.node_of_jbid(jbid)?;
        if !self.base().get_node(nid)?.is_element() {
            return None;
        }
        self.rect_of_node(nid)
    }

    /// Box and visibility facts for every element the JS DOM knows
    /// (`data-jb`), keyed by that id; what visual-order rendering consumes.
    pub fn boxes(&self) -> std::collections::HashMap<usize, BoxInfo> {
        use style::properties::generated::longhands::direction::computed_value::T as Direction;
        use style::properties::generated::longhands::position::computed_value::T as StyloPosition;
        use style::properties::generated::longhands::visibility::computed_value::T as Visibility;
        use style::values::specified::box_::{DisplayInside, DisplayOutside};
        let jb = LocalName::from("data-jb");
        let mut map = std::collections::HashMap::new();
        for (nid, node) in self.base().tree().iter() {
            if !node.is_element() {
                continue;
            }
            let Some(jbid) = node.attr(jb.clone()).and_then(|v| v.parse::<usize>().ok()) else { continue };
            let Some(el) = node.element_data() else { continue };
            let mut info = BoxInfo { tag: el.name.local.to_string(), rect: self.rect_of_node(nid), opacity: 1.0, ..BoxInfo::default() };
            if let Some(styles) = node.primary_styles() {
                let display = styles.clone_display();
                info.styled = true;
                info.display_none = display.is_none();
                info.inline_level = display.outside() == DisplayOutside::Inline;
                info.flex_or_grid = matches!(display.inside(), DisplayInside::Flex | DisplayInside::Grid);
                info.visibility_hidden = styles.get_inherited_box().visibility != Visibility::Visible;
                info.opacity = styles.get_effects().opacity;
                info.position = match styles.get_box().position {
                    StyloPosition::Static => Position::Static,
                    StyloPosition::Relative => Position::Relative,
                    StyloPosition::Absolute => Position::Absolute,
                    StyloPosition::Fixed => Position::Fixed,
                    StyloPosition::Sticky => Position::Sticky,
                };
                info.z_index = node.z_index();
                info.rtl = styles.get_inherited_box().direction == Direction::Rtl;
            }
            map.insert(jbid, info);
        }
        map
    }

    /// The topmost element at document coordinates (x, y).
    pub fn element_at(&self, x: f64, y: f64) -> Option<LaidOutElement> {
        self.element_at_scrolled(x, y, 0.0, 0.0)
    }

    /// The topmost element at document coordinates (x, y) with the window scrolled to (sx, sy).
    pub fn element_at_scrolled(&self, x: f64, y: f64, sx: f64, sy: f64) -> Option<LaidOutElement> {
        let nid = self.base().element_from_point_scrolled(x as f32, y as f32, sx as f32, sy as f32)?;
        let nid = self.base().nearest_non_anonymous_ancestor(nid).unwrap_or(nid);
        let node = self.base().get_node(nid)?;
        let el = node.element_data()?;
        Some(LaidOutElement {
            tag: el.name.local.to_string(),
            jbid: node.attr(LocalName::from("data-jb")).and_then(|v| v.parse().ok()),
            id: node.attr(LocalName::from("id")).map(|s| s.to_string()),
            rect: self.rect_of_node(nid)?,
        })
    }
}

/// `matrix(a, b, c, d, e, f)` / `matrix3d(...)` for a computed transform list ("none" when empty);
/// percentages resolve against the element's border box when it has one.
fn transform_matrix(t: &style::values::computed::Transform, rect: Option<&Rect>) -> Option<String> {
    use style::values::computed::Length;
    if t.0.is_empty() {
        return Some("none".to_string());
    }
    let reference = rect.map(|r| euclid::Rect::new(euclid::Point2D::origin(), euclid::Size2D::new(Length::new(r.width as f32), Length::new(r.height as f32))));
    let (m, is_3d) = t.to_transform_3d_matrix_f64(reference.as_ref()).ok()?;
    let num = |v: f64| {
        let r = (v * 1_000_000.0).round() / 1_000_000.0;
        let r = if r == 0.0 { 0.0 } else { r };
        let mut s = format!("{r:.6}");
        while s.contains('.') && (s.ends_with('0') || s.ends_with('.')) {
            s.pop();
        }
        s
    };
    Some(if is_3d {
        let v = [m.m11, m.m12, m.m13, m.m14, m.m21, m.m22, m.m23, m.m24, m.m31, m.m32, m.m33, m.m34, m.m41, m.m42, m.m43, m.m44];
        format!("matrix3d({})", v.iter().map(|x| num(*x)).collect::<Vec<_>>().join(", "))
    } else {
        format!("matrix({}, {}, {}, {}, {}, {})", num(m.m11), num(m.m12), num(m.m21), num(m.m22), num(m.m41), num(m.m42))
    })
}
