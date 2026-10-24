//! Native host services exposed to page JavaScript: console capture, real
//! `fetch`/`XMLHttpRequest` over the browser's HTTP session, persistent Web
//! Storage and IndexedDB, cookies, WebSocket/EventSource connections, WebCrypto,
//! compression, clipboard, geolocation and notifications.

use super::runtime::NativeHost;
use super::storage::RealStorage;
use super::webapis::{self, EventSourceManager, IdbStore, NetEvent, WebSocketManager};
use crate::http::HttpClient;
use rand::Rng;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Instant;

/// A fixed geolocation reported to pages that ask for it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Geolocation {
    pub latitude: f64,
    pub longitude: f64,
    pub accuracy: f64,
}

/// Configuration knobs for page script execution.
#[derive(Debug, Clone)]
pub struct JsConfig {
    /// Maximum number of network requests a page's scripts may make.
    pub max_requests: usize,
    /// Per-request timeout in seconds for `fetch`/XHR.
    pub request_timeout_secs: u64,
    /// Total wall-clock budget for a page's scripts (timers included), in ms.
    pub time_budget_ms: u64,
    /// Maximum number of timer callbacks executed per page.
    pub max_timer_steps: usize,
    /// Whether `<script src>` files are downloaded and executed.
    pub fetch_external_scripts: bool,
    /// Cap on the number of external scripts fetched per page.
    pub max_external_scripts: usize,
    /// Print console output to stderr as it happens.
    pub echo_console: bool,
    /// Allow pages to open WebSocket / EventSource connections.
    pub allow_websockets: bool,
    /// How long (ms) to keep pumping open WebSocket/EventSource connections
    /// after scripts and timers have settled.
    pub network_idle_ms: u64,
    /// Position returned by `navigator.geolocation`; `None` denies permission.
    pub geolocation: Option<Geolocation>,
    /// `Notification.permission` value ("granted", "denied" or "default").
    pub notification_permission: String,
    /// Allow pages to read/write the OS clipboard through `navigator.clipboard`.
    pub allow_clipboard: bool,
    /// Expose HttpOnly cookies to `document.cookie` (off, like a real browser).
    pub expose_http_only_cookies: bool,
    /// Separate per-page budget (ms) for ad/analytics scripts: their run time does not count
    /// against `time_budget_ms`, and once this is spent further ad scripts are skipped (they fire
    /// `error`, as with an ad blocker). 0 skips ad scripts entirely. Not applied in WPT mode.
    pub ad_budget_ms: u64,
    /// Service workers (registration, fetch interception, Cache API) on secure pages.
    pub service_workers: bool,
    /// After a script run on a loaded page (an agent action, an eval), run the page's timers only
    /// up to this much virtual time ahead (as a person waits a moment after acting) instead of
    /// until the queue is empty, so polling loops and animations do not use up the time budget
    /// on every action. `None`: drain every timer (one-shot page loads).
    pub action_settle_ms: Option<u64>,
    /// Directory for persistent localStorage / IndexedDB files instead of the shared one under the
    /// user's data directory (per-task profiles in agent benchmarks; `JB_PROFILE_DIR` sets it for
    /// the CLI). Empty string = in-memory only.
    pub profile_dir: Option<std::path::PathBuf>,
}

impl Default for JsConfig {
    fn default() -> Self {
        Self {
            max_requests: 300,
            request_timeout_secs: 10,
            time_budget_ms: 15000,
            max_timer_steps: 400,
            fetch_external_scripts: true,
            max_external_scripts: 200,
            echo_console: false,
            allow_websockets: true,
            network_idle_ms: 1500,
            geolocation: None,
            notification_permission: "default".into(),
            allow_clipboard: false,
            expose_http_only_cookies: false,
            ad_budget_ms: 1500,
            service_workers: true,
            action_settle_ms: None,
            profile_dir: std::env::var_os("JB_PROFILE_DIR").map(std::path::PathBuf::from),
        }
    }
}

/// A recorded network call made by page JavaScript.
#[derive(Debug, Clone, Serialize)]
pub struct ApiCall {
    pub method: String,
    pub url: String,
    pub status: u16,
    pub content_type: String,
}

/// A `Notification` created by the page.
#[derive(Debug, Clone, Serialize)]
pub struct NotificationRecord {
    pub title: String,
    pub body: String,
}

/// What a page's scripts did, as drained from the host by `take_report`.
#[derive(Debug, Default)]
pub struct HostReport {
    pub console: Vec<String>,
    pub errors: Vec<String>,
    pub api_calls: Vec<ApiCall>,
    pub notifications: Vec<NotificationRecord>,
    pub websocket_messages: usize,
}

pub struct Host {
    pub client: HttpClient,
    pub storage: RealStorage,
    pub idb: IdbStore,
    pub config: JsConfig,
    pub console: Vec<String>,
    pub errors: Vec<String>,
    pub api_calls: Vec<ApiCall>,
    pub notifications: Vec<NotificationRecord>,
    pub websockets: WebSocketManager,
    pub event_sources: EventSourceManager,
    pub requests_made: usize,
    pub started: Instant,
    /// The thread's network wait total when `started` was set (see `restart_budget`).
    pub net_base: std::time::Duration,
    /// The thread's browser-work total (layouts) when `started` was set.
    pub work_base: std::time::Duration,
    pub base_url: String,
    /// Request destination and mode per subresource URL (fetch metadata), set by the page.
    pub fetch_kinds: std::collections::HashMap<String, (String, String, String)>,
    /// Referrer (source URL, policy) the page gave for a subresource URL.
    pub fetch_referrers: std::collections::HashMap<String, (String, String)>,
    /// Internal per-hop markers (CSP source lists, mixed content mode) for a subresource URL.
    pub fetch_markers: std::collections::HashMap<String, Vec<(String, String)>>,
    /// Referrer policy for the module graph being loaded (the script element's, else the document's).
    pub module_referrer_policy: String,
    /// Sizes of decoded canvas images by cache key.
    image_sizes: std::collections::HashMap<String, (u32, u32)>,
    /// Referrer-Policy headers of fetched module scripts (they apply to their own imports).
    module_policies: std::collections::HashMap<String, String>,
    /// Credential-less client for cross-origin module fetches (kept for connection reuse).
    anon_client: Option<HttpClient>,
    /// Speculative module fetches (preload scanning); off for WPT, whose tests count requests.
    pub speculative_fetch: bool,
    /// Module URLs this page already prefetched (or fetched): each is prefetched once, not once
    /// per importing module (the importer's Referer made every prefetch a distinct request).
    pub prefetched_modules: std::collections::HashSet<String>,
    /// Integrity metadata of the top-level module script being fetched: (url, metadata).
    pub module_integrity: Option<(String, String)>,
    /// Streaming `TextDecoder` instances owned by page scripts.
    decoders: BTreeMap<u64, TextDecoderState>,
    /// Image probe results by URL (`naturalWidth`/`naturalHeight`, feature `images`).
    image_cache: BTreeMap<String, Value>,
    decoder_seq: u64,
    /// Laid-out snapshot of the page (Cargo feature `layout`).
    #[cfg(feature = "layout")]
    layout: Option<crate::layout::blitz::Layout>,
    /// Identity of the document the layout was built from (realm token + id epoch, sent by the
    /// page as `inc`); a query with the same key may update the layout incrementally.
    layout_key: Option<String>,
    /// Layouts of other realms (iframes) by realm token, most recent last: a page and its frames
    /// take turns querying geometry, and one shared layout made every turn a full rebuild.
    #[cfg(feature = "layout")]
    layout_stash: Vec<(String, crate::layout::blitz::Layout)>,
    /// Background page requests: results channel, next id, ids in flight with their start.
    fetch_tx: std::sync::mpsc::Sender<(u64, Value, ApiCall)>,
    fetch_rx: std::sync::mpsc::Receiver<(u64, Value, ApiCall)>,
    fetch_next: u64,
    fetch_inflight: std::collections::HashMap<u64, Instant>,
}

struct TextDecoderState {
    encoding: &'static encoding_rs::Encoding,
    fatal: bool,
    ignore_bom: bool,
    decoder: encoding_rs::Decoder,
}

impl TextDecoderState {
    fn fresh(&self) -> encoding_rs::Decoder {
        if self.ignore_bom {
            self.encoding.new_decoder_without_bom_handling()
        } else {
            self.encoding.new_decoder_with_bom_removal()
        }
    }
}

impl Host {
    pub fn new(client: HttpClient, storage: RealStorage, idb: IdbStore, config: JsConfig, base_url: &str) -> Self {
        let fetch_channel = std::sync::mpsc::channel();
        Self {
            client,
            storage,
            idb,
            config,
            console: Vec::new(),
            errors: Vec::new(),
            api_calls: Vec::new(),
            notifications: Vec::new(),
            websockets: WebSocketManager::default(),
            event_sources: EventSourceManager::default(),
            requests_made: 0,
            started: Instant::now(),
            net_base: super::runtime::budget_offset(),
            work_base: crate::http::thread_browser_work(),
            base_url: base_url.to_string(),
            fetch_kinds: std::collections::HashMap::new(),
            fetch_referrers: std::collections::HashMap::new(),
            fetch_markers: std::collections::HashMap::new(),
            module_referrer_policy: String::new(),
            image_sizes: std::collections::HashMap::new(),
            module_policies: std::collections::HashMap::new(),
            anon_client: None,
            speculative_fetch: true,
            prefetched_modules: std::collections::HashSet::new(),
            module_integrity: None,
            decoders: BTreeMap::new(),
            image_cache: BTreeMap::new(),
            decoder_seq: 0,
            #[cfg(feature = "layout")]
            layout: None,
            layout_key: None,
            #[cfg(feature = "layout")]
            layout_stash: Vec::new(),
            fetch_tx: fetch_channel.0,
            fetch_rx: fetch_channel.1,
            fetch_next: 1,
            fetch_inflight: std::collections::HashMap::new(),
        }
    }

    /// Encoding Standard operations backing `TextDecoder` and friends.
    /// `{op:"label", label}` → `{name}`; `{op:"open", label, fatal, ignoreBOM}`
    /// → `{id, name}`; `{op:"decode", id, data, stream}` → `{text}` or
    /// `{error}`; `{op:"encode", label, text}` → `{bytes}` (legacy encoders,
    /// used for form submission); `{op:"close", id}`.
    fn encoding_op(&mut self, payload: &Value) -> Value {
        let op = payload.get("op").and_then(Value::as_str).unwrap_or("");
        let label = payload.get("label").and_then(Value::as_str).unwrap_or("utf-8");
        match op {
            "label" => match encoding_rs::Encoding::for_label(label.trim_matches(|c: char| matches!(c, ' ' | '\t' | '\n' | '\x0c' | '\r')).as_bytes()) {
                Some(e) => json!({"name": e.name()}),
                None => Value::Null,
            },
            "open" => {
                let trimmed = label.trim_matches(|c: char| matches!(c, ' ' | '\t' | '\n' | '\x0c' | '\r'));
                match encoding_rs::Encoding::for_label(trimmed.as_bytes()) {
                    Some(encoding) => {
                        let st = TextDecoderState { encoding, fatal: payload.get("fatal").and_then(Value::as_bool).unwrap_or(false), ignore_bom: payload.get("ignoreBOM").and_then(Value::as_bool).unwrap_or(false), decoder: encoding.new_decoder() };
                        let mut st = st;
                        st.decoder = st.fresh();
                        self.decoder_seq += 1;
                        let id = self.decoder_seq;
                        if self.decoders.len() > 512 {
                            let first = *self.decoders.keys().next().unwrap();
                            self.decoders.remove(&first);
                        }
                        self.decoders.insert(id, st);
                        json!({"id": id, "name": encoding.name()})
                    }
                    None => json!({"error": "RangeError"}),
                }
            }
            "decode" => {
                let id = payload.get("id").and_then(Value::as_u64).unwrap_or(0);
                let data = webapis::unb64(payload.get("data").and_then(Value::as_str).unwrap_or(""));
                let stream = payload.get("stream").and_then(Value::as_bool).unwrap_or(false);
                let st = match self.decoders.get_mut(&id) {
                    Some(s) => s,
                    None => return json!({"error": "InvalidStateError"}),
                };
                let last = !stream;
                let mut out = String::with_capacity(st.decoder.max_utf8_buffer_length(data.len()).unwrap_or(data.len() * 3));
                let result = if st.fatal {
                    let (res, _read) = st.decoder.decode_to_string_without_replacement(&data, &mut out, last);
                    match res {
                        encoding_rs::DecoderResult::InputEmpty => Ok(()),
                        encoding_rs::DecoderResult::Malformed(_, _) => Err(()),
                        encoding_rs::DecoderResult::OutputFull => Err(()),
                    }
                } else {
                    let (res, _read, _had) = st.decoder.decode_to_string(&data, &mut out, last);
                    match res {
                        encoding_rs::CoderResult::InputEmpty => Ok(()),
                        encoding_rs::CoderResult::OutputFull => Err(()),
                    }
                };
                if last || result.is_err() {
                    st.decoder = st.fresh();
                }
                match result {
                    Ok(()) => json!({"text": out}),
                    Err(()) => json!({"error": "TypeError"}),
                }
            }
            "encode" => {
                let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
                let encoding = encoding_rs::Encoding::for_label(label.trim().as_bytes()).unwrap_or(encoding_rs::UTF_8).output_encoding();
                let (bytes, _, _) = encoding.encode(text);
                json!({"bytes": webapis::b64(&bytes), "name": encoding.name()})
            }
            "close" => {
                self.decoders.remove(&payload.get("id").and_then(Value::as_u64).unwrap_or(0));
                Value::Null
            }
            _ => json!({"error": "unknown encoding op"}),
        }
    }

    /// Reset per-page state for a new page load at `base_url`.
    pub fn begin_page(&mut self, base_url: &str) {
        self.base_url = base_url.to_string();
        #[cfg(feature = "layout")]
        {
            self.layout = None;
            self.layout_stash.clear();
        }
        self.layout_key = None;
        self.fetch_inflight.clear();
        self.restart_budget();
        self.websockets = WebSocketManager::default();
        self.event_sources = EventSourceManager::default();
        self.console.clear();
        self.errors.clear();
        self.api_calls.clear();
        self.notifications.clear();
    }

    /// Drain everything recorded since the last report and flush storage.
    pub fn take_report(&mut self) -> HostReport {
        self.storage.flush();
        HostReport {
            console: std::mem::take(&mut self.console),
            errors: std::mem::take(&mut self.errors),
            api_calls: std::mem::take(&mut self.api_calls),
            notifications: std::mem::take(&mut self.notifications),
            websocket_messages: self.websockets.messages_received,
        }
    }

    /// Start a new time and request budget (new page, or a script run on the live page).
    pub fn restart_budget(&mut self) {
        self.started = Instant::now();
        self.net_base = super::runtime::budget_offset();
        self.work_base = crate::http::thread_browser_work();
        self.requests_made = 0;
    }

    /// The page's script time is spent (network wait excluded outside WPT mode, see
    /// `runtime::budget_spent`).
    pub fn over_budget(&self) -> bool {
        super::runtime::budget_spent(self.started, self.net_base, self.config.time_budget_ms, self.work_base)
    }

    pub fn has_open_streams(&self) -> bool {
        self.websockets.has_open() || self.event_sources.has_open()
    }

    /// Poll WebSocket/EventSource connections for new events.
    pub fn poll_network(&mut self) -> Vec<NetEvent> {
        let mut events = self.websockets.poll();
        events.extend(self.event_sources.poll());
        events
    }

    /// `<img>` "update the image data": fetch the selected source and report
    /// its intrinsic size. Results are cached per URL (the list of available
    /// images). Without the `images` feature the op reports `unsupported` and
    /// the JS side keeps images in the "available, size unknown" state.
    fn image(&mut self, payload: &Value) -> Value {
        let url = payload.get("url").and_then(Value::as_str).unwrap_or("").to_string();
        if crate::js::is_blocked_tracker(&url) {
            return json!({"ok": false, "status": 0, "blocked": true});
        }
        if let Some(v) = self.image_cache.get(&url) {
            return v.clone();
        }
        let result = self.probe_image(&url);
        self.image_cache.insert(url, result.clone());
        result
    }

    fn probe_image(&mut self, url: &str) -> Value {
        if !cfg!(feature = "images") {
            return json!({"unsupported": true});
        }
        let started = Instant::now();
        let result = self.probe_image_inner(url);
        if std::env::var_os("JB_TRACE_JS").is_some() {
            eprintln!("[js] image {url} -> {} in {} ms", if result.get("ok").and_then(Value::as_bool).unwrap_or(false) { "ok" } else { "fail" }, started.elapsed().as_millis());
        }
        result
    }

    fn probe_image_inner(&mut self, url: &str) -> Value {
        // (animated: GIF with a looping/animation extension, APNG acTL chunk, animated WebP)
        fn image_is_animated(b: &[u8]) -> bool {
            let has = |needle: &[u8]| b.windows(needle.len()).any(|w| w == needle);
            if b.starts_with(b"GIF8") {
                return has(b"NETSCAPE2.0") || has(b"ANIMEXTS1.0");
            }
            if b.starts_with(b"\x89PNG") {
                return has(b"acTL");
            }
            if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
                return has(b"ANIM");
            }
            false
        }
        let (bytes, mime) = match self.image_bytes(url) {
            Ok(v) => v,
            Err(e) => return e,
        };
        match image_dimensions(&bytes, &mime) {
            Some((w, h, intrinsic)) => json!({"ok": true, "width": w, "height": h, "intrinsic": intrinsic, "type": mime, "animated": image_is_animated(&bytes)}),
            None => json!({"ok": false, "status": 200, "decode": true, "type": mime}),
        }
    }

    /// Canvas 2D backing stores (`crate::canvas`); `loadImage` decodes an
    /// image URL into the canvas image cache for drawImage/createPattern.
    #[cfg(feature = "canvas")]
    fn canvas_op(&mut self, payload: &Value) -> Value {
        if payload.get("op").and_then(Value::as_str) == Some("loadFont") {
            // A FontFace font for canvas text: {family, url} or {family, b64}.
            let family = payload.get("family").and_then(Value::as_str).unwrap_or("").to_string();
            let bytes = match payload.get("b64").and_then(Value::as_str) {
                Some(b) => webapis::unb64(b),
                None => match self.image_bytes(payload.get("url").and_then(Value::as_str).unwrap_or("")) {
                    Ok((b, _)) => b,
                    Err(e) => return e,
                },
            };
            return json!({"ok": crate::canvas::register_font(&family, &bytes)});
        }
        if payload.get("op").and_then(Value::as_str) == Some("loadImage") {
            let url = payload.get("url").and_then(Value::as_str).unwrap_or("").to_string();
            let space = payload.get("space").and_then(Value::as_str).unwrap_or("srgb").to_string();
            let orient = payload.get("orient").and_then(Value::as_bool).unwrap_or(true);
            let key = format!("{}{}", crate::canvas::image_key(&url, &space), if orient { "" } else { "\u{2}raw" });
            if let Some((w, h)) = self.image_sizes.get(&key).copied().filter(|_| crate::canvas::has_cached_image(&key)) {
                return json!({"ok": true, "width": w, "height": h});
            }
            #[cfg(feature = "images")]
            {
                let Ok((bytes, _)) = self.image_bytes(&url) else { return json!({"ok": false}) };
                // Decode with the embedded ICC profile and convert to the canvas color space.
                use image::ImageDecoder;
                let decoded = image::ImageReader::new(std::io::Cursor::new(&bytes)).with_guessed_format().ok().and_then(|r| r.into_decoder().ok()).and_then(|mut dec| {
                    let icc = dec.icc_profile().ok().flatten();
                    let orientation = dec.orientation().ok();
                    image::DynamicImage::from_decoder(dec).ok().map(|mut img| {
                        if let (true, Some(o)) = (orient, orientation) {
                            img.apply_orientation(o);
                        }
                        (img, icc)
                    })
                });
                return match decoded {
                    Some((img, icc)) => {
                        let (w, h) = (img.width(), img.height());
                        let profile = icc.as_deref().and_then(crate::colorspace::parse_icc);
                        let rgba = if profile.is_none() && space != "display-p3" { img.to_rgba8().into_raw() } else { crate::colorspace::convert_to_rgba8(img.to_rgba32f().as_raw(), profile.as_ref(), crate::colorspace::Space::from_name(&space)) };
                        self.image_sizes.insert(key.clone(), (w, h));
                        json!({"ok": crate::canvas::cache_image(&key, &rgba, w, h), "width": w, "height": h})
                    }
                    None => {
                        // SVG images: rasterized at their intrinsic size.
                        #[cfg(feature = "screenshot")]
                        if let Some((mut rgba, w, h)) = crate::layout::screenshot::rasterize_svg(&bytes, None) {
                            crate::colorspace::convert_rgba8_between(&mut rgba, crate::colorspace::Space::Srgb, crate::colorspace::Space::from_name(&space));
                            self.image_sizes.insert(key.clone(), (w, h));
                            return json!({"ok": crate::canvas::cache_image(&key, &rgba, w, h), "width": w, "height": h});
                        }
                        json!({"ok": false})
                    }
                };
            }
            #[cfg(not(feature = "images"))]
            return json!({"ok": false});
        }
        crate::canvas::op(payload)
    }

    #[cfg(not(feature = "canvas"))]
    fn canvas_op(&mut self, _payload: &Value) -> Value {
        json!({"unavailable": true})
    }

    /// Container metadata of a media resource for the virtual media pipeline.
    fn media_op(&mut self, payload: &Value) -> Value {
        let url = payload.get("url").and_then(Value::as_str).unwrap_or("").to_string();
        let key = format!("media:{url}");
        if let Some(v) = self.image_cache.get(&key) {
            return v.clone();
        }
        self.note_fetch_kind(payload, "video");
        let result = match self.image_bytes(&url) {
            Ok((bytes, mime)) => match super::media::probe(&bytes) {
                Some(info) => {
                    let mut v = super::media::to_json(&info);
                    v["type"] = json!(mime);
                    v
                }
                None => json!({"ok": false, "decode": true, "type": mime}),
            },
            Err(e) => e,
        };
        self.image_cache.insert(key, result.clone());
        result
    }

    /// Record the request destination/mode the page gave for a subresource URL.
    fn note_fetch_kind(&mut self, payload: &Value, default_dest: &str) {
        let Some(url) = payload.get("url").and_then(Value::as_str) else { return };
        let dest = payload.get("dest").and_then(Value::as_str).unwrap_or(default_dest).to_string();
        let mode = payload.get("mode").and_then(Value::as_str).unwrap_or("no-cors").to_string();
        let initiator = payload.get("initiator").and_then(Value::as_str).unwrap_or(&self.base_url).to_string();
        if self.fetch_kinds.len() > 4096 {
            self.fetch_kinds.clear();
            self.fetch_referrers.clear();
            self.fetch_markers.clear();
        }
        let mut markers = Vec::new();
        if let Some(l) = payload.get("csp").filter(|v| v.is_array()) {
            markers.push((crate::http::CSP_META.to_string(), l.to_string()));
        }
        if let Some(m) = payload.get("mixed").and_then(Value::as_str) {
            markers.push((crate::http::MIXED_META.to_string(), m.to_string()));
        }
        if let Some(d) = payload.get("rtDoc").and_then(Value::as_str) {
            markers.push((crate::http::RT_INITIATOR.to_string(), d.to_string()));
        }
        if payload.get("preload").and_then(Value::as_bool).unwrap_or(false) {
            markers.push((crate::http::PRELOAD_META.to_string(), "1".to_string()));
        }
        if markers.is_empty() {
            self.fetch_markers.remove(url);
        } else {
            self.fetch_markers.insert(url.to_string(), markers);
        }
        self.fetch_kinds.insert(url.to_string(), (dest, mode, initiator));
        if let Some(r) = payload.get("referrer").and_then(Value::as_str) {
            let policy = payload.get("referrerPolicy").and_then(Value::as_str).unwrap_or("").to_string();
            self.fetch_referrers.insert(url.to_string(), (r.to_string(), policy));
        }
    }

    /// Request headers of an image-like subresource fetch: fetch metadata plus the Referer
    /// marker for the referrer the page gave.
    fn subresource_headers(&self, url: &str) -> BTreeMap<String, String> {
        let (dest, mode, initiator) = self.fetch_kinds.get(url).cloned().unwrap_or_else(|| ("image".into(), "no-cors".into(), self.base_url.clone()));
        let mut headers = crate::http::fetch_metadata_headers(&dest, &mode, &initiator, url);
        if let Some((source, policy)) = self.fetch_referrers.get(url) {
            let (k, v) = crate::http::referrer_marker(source, policy);
            headers.insert(k, v);
        }
        for (k, v) in self.fetch_markers.get(url).cloned().unwrap_or_default() {
            headers.insert(k, v);
        }
        headers
    }

    fn image_bytes(&mut self, url: &str) -> Result<(Vec<u8>, String), Value> {
        Ok(if let Some(rest) = url.strip_prefix("data:") {
            let v = data_url_response(rest, url);
            if !v.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                return Err(json!({"ok": false, "status": 0}));
            }
            let mime = v.get("headers").and_then(|h| h.get("content-type")).and_then(Value::as_str).unwrap_or("").to_string();
            let bytes = match v.get("bodyBase64").and_then(Value::as_str) {
                Some(b) => webapis::unb64(b),
                None => v.get("text").and_then(Value::as_str).unwrap_or("").as_bytes().to_vec(),
            };
            (bytes, mime)
        } else {
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err(json!({"ok": false, "status": 0}));
            }
            if self.requests_made >= self.config.max_requests || self.over_budget() {
                return Err(json!({"ok": false, "status": 0, "budget": true}));
            }
            self.requests_made += 1;
            let headers = self.subresource_headers(url);
            match self.client.request("GET", url, &headers, None, self.config.request_timeout_secs, true) {
                Ok(resp) if (200..300).contains(&resp.status) => {
                    #[allow(unused_mut)]
                    let mut mime = resp.headers.get("content-type").map(|c| c.split(';').next().unwrap_or("").trim().to_ascii_lowercase()).unwrap_or_default();
                    // AVIF is transcoded to PNG once here (see src/avif.rs)
                    #[cfg(feature = "images")]
                    let body = match crate::avif::to_png_if_avif(&resp.body) {
                        Some(png) => {
                            mime = "image/png".into();
                            png
                        }
                        None => resp.body.clone(),
                    };
                    #[cfg(not(feature = "images"))]
                    let body = resp.body.clone();
                    #[cfg(feature = "layout")]
                    crate::layout::blitz::remember_page_image(url, &body);
                    (body, mime)
                }
                Ok(resp) => return Err(json!({"ok": false, "status": resp.status})),
                Err(e) => return Err(json!({"ok": false, "status": 0, "error": e.to_string()})),
            }
        })
    }

    /// Request headers for a module script fetch: Accept by module type, Referer per the
    /// referrer policy, Origin when cross-origin, fetch metadata (cors mode).
    fn module_request_headers(&self, url: &str, kind: &str, referrer: &str) -> std::collections::BTreeMap<String, String> {
        let doc_origin = url::Url::parse(&self.base_url).ok().map(|u| u.origin());
        let target_origin = url::Url::parse(url).ok().map(|u| u.origin());
        let cross = doc_origin.is_some() && target_origin != doc_origin;
        let dest = match kind { "json" => "json", "css" => "style", "text" => "empty", _ => "script" };
        let mut headers = crate::http::fetch_metadata_headers(dest, "cors", &self.base_url, url);
        headers.insert("Accept".to_string(), match kind { "json" => "application/json,*/*;q=0.5", "css" => "text/css,*/*;q=0.1", "text" => "text/plain,*/*;q=0.5", _ => "*/*" }.to_string());
        // Referer per the referrer policy (default strict-origin-when-cross-origin).
        let policy = self.module_policies.get(referrer).cloned().unwrap_or_else(|| self.module_referrer_policy.clone());
        if let Some(v) = crate::http::determine_referrer(referrer, &policy, url) {
            headers.insert("Referer".to_string(), v);
        }
        if cross {
            if let Some(o) = &doc_origin {
                headers.insert("Origin".to_string(), o.ascii_serialization());
            }
        }
        headers
    }

    /// The client a module fetch uses: the session's, or a credential-less one cross-origin
    /// (kept, so its connections are reused).
    fn module_client(&mut self, cross: bool) -> HttpClient {
        if !cross {
            return self.client.clone();
        }
        let ua = self.client.user_agent();
        self.anon_client.get_or_insert_with(|| HttpClient::new(Some(&ua))).clone()
    }

    /// Start fetching the page's module scripts (requested as the module loader will request them).
    pub fn prefetch_entry_modules(&mut self, urls: &[String]) {
        if !self.speculative_fetch {
            return;
        }
        let base = self.base_url.clone();
        let doc_origin = url::Url::parse(&base).ok().map(|u| u.origin());
        for u in urls {
            if !(u.starts_with("http://") || u.starts_with("https://")) {
                continue;
            }
            if !self.prefetched_modules.insert(u.clone()) {
                continue;
            }
            let cross = doc_origin.is_some() && url::Url::parse(u).ok().map(|x| x.origin()) != doc_origin;
            let h = self.module_request_headers(u, "javascript", &base);
            self.module_client(cross).prefetch_with(vec![u.clone()], h, self.config.request_timeout_secs);
        }
    }

    /// Start fetching a module's static imports in parallel, each with the exact request the
    /// module loader will make for it, so the loader picks the responses up.
    fn prefetch_module_imports(&mut self, module_url: &str, source: &str) {
        if !self.speculative_fetch {
            return;
        }
        static IMPORT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let re = IMPORT.get_or_init(|| regex::Regex::new(r#"(?:^|[;\s}])(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?["']([^"'\n]{1,300})["']\s*(\w*)"#).unwrap());
        let Ok(base) = url::Url::parse(module_url) else { return };
        let mut groups: Vec<(bool, std::collections::BTreeMap<String, String>, Vec<String>)> = Vec::new();
        let doc_origin = url::Url::parse(&self.base_url).ok().map(|u| u.origin());
        for c in re.captures_iter(source).take(64) {
            let spec = &c[1];
            // import attributes (`with { type: "json" }`) change the request; leave those alone
            if matches!(&c[2], "with" | "assert") {
                continue;
            }
            if !(spec.starts_with("./") || spec.starts_with("../") || spec.starts_with('/') || spec.starts_with("http://") || spec.starts_with("https://")) {
                continue;
            }
            let Ok(u) = base.join(spec) else { continue };
            if !matches!(u.scheme(), "http" | "https") {
                continue;
            }
            let u = u.to_string();
            if !self.prefetched_modules.insert(u.clone()) {
                continue;
            }
            let cross = doc_origin.is_some() && url::Url::parse(&u).ok().map(|x| x.origin()) != doc_origin;
            let h = self.module_request_headers(&u, "javascript", module_url);
            match groups.iter_mut().find(|(c2, h2, _)| *c2 == cross && *h2 == h) {
                Some((_, _, v)) => { if !v.contains(&u) { v.push(u) } }
                None => groups.push((cross, h, vec![u])),
            }
        }
        for (cross, h, urls) in groups {
            let client = self.module_client(cross);
            client.prefetch_with(urls, h, self.config.request_timeout_secs);
        }
    }

    /// Fetch a module script for the ES module loader. The response must be
    /// a JavaScript (or JSON) MIME type, as for `<script type="module">`.
    /// `kind`: the module type of the import ("javascript", "json", "css", "text"); `referrer`: the
    /// importing script's URL (or the document URL).
    pub fn fetch_module(&mut self, url: &str, kind: &str, referrer: &str) -> Result<String, String> {
        if let Some(data_url) = url.strip_prefix("data:") {
            let v = data_url_response(data_url, url);
            return match v.get("text").and_then(Value::as_str) {
                Some(t) if v.get("ok").and_then(Value::as_bool).unwrap_or(false) => Ok(t.to_string()),
                _ => Err(format!("Failed to fetch module {url}")),
            };
        }
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(format!("Failed to fetch module {url}: unsupported URL scheme"));
        }
        if self.requests_made >= self.config.max_requests || self.over_budget() {
            return Err(format!("Failed to fetch module {url}: request budget exhausted"));
        }
        self.requests_made += 1;
        // Module scripts are fetched in "cors" mode with credentials "same-origin": cross-origin
        // requests carry no cookies and need Access-Control-Allow-Origin on the response.
        let doc_origin = url::Url::parse(&self.base_url).ok().map(|u| u.origin());
        let target_origin = url::Url::parse(url).ok().map(|u| u.origin());
        let cross = doc_origin.is_some() && target_origin != doc_origin;
        let headers = self.module_request_headers(url, kind, referrer);
        let client = self.module_client(cross);
        self.prefetched_modules.insert(url.to_string());
        match client.request("GET", url, &headers, None, self.config.request_timeout_secs, true) {
            Ok(resp) if resp.status == 200 => {
                if let Some(h) = resp.headers.get("referrer-policy") {
                    let valid = ["no-referrer", "no-referrer-when-downgrade", "same-origin", "origin", "strict-origin", "origin-when-cross-origin", "strict-origin-when-cross-origin", "unsafe-url"];
                    if let Some(p) = h.split(',').map(|t| t.trim().to_ascii_lowercase()).filter(|t| valid.contains(&t.as_str())).last() {
                        self.module_policies.insert(url.to_string(), p.clone());
                        self.module_policies.insert(resp.url.clone(), p);
                    }
                }
                let final_cross = url::Url::parse(&resp.url).ok().map(|u| u.origin()) != doc_origin;
                if cross || final_cross {
                    let acao = resp.headers.get("access-control-allow-origin").map(|s| s.trim().to_string()).unwrap_or_default();
                    let ok = acao == "*" || doc_origin.as_ref().map(|o| o.ascii_serialization() == acao).unwrap_or(false);
                    if !ok {
                        return Err(format!("Failed to fetch module {url}: blocked by CORS (no Access-Control-Allow-Origin)"));
                    }
                }
                let ct = resp.headers.get("content-type").map(|c| c.split(';').next().unwrap_or("").trim().to_ascii_lowercase()).unwrap_or_default();
                let ok = match kind {
                    "json" => crate::http::is_json_mime(&ct),
                    "css" => ct == "text/css",
                    "text" => true,
                    _ => ct.is_empty() || crate::http::is_javascript_mime(&ct),
                };
                if !ok {
                    return Err(format!("Failed to load module script {url}: unexpected MIME type \"{ct}\""));
                }
                // Module scripts are always decoded as UTF-8 (BOM stripped),
                // whatever the Content-Type charset says.
                if self.module_integrity.as_ref().is_some_and(|(u, _)| u == url) {
                    let (_, meta) = self.module_integrity.take().unwrap_or_default();
                    if !sri_matches(&meta, &resp.body) {
                        return Err(format!("Failed to fetch module {url}: integrity metadata does not match"));
                    }
                }
                let body = resp.body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&resp.body);
                let text = String::from_utf8_lossy(body).into_owned();
                if kind == "javascript" {
                    self.prefetch_module_imports(url, &text);
                }
                Ok(text)
            }
            Ok(resp) => Err(format!("Failed to fetch module {url}: HTTP {}", resp.status)),
            Err(e) => Err(format!("Failed to fetch module {url}: {e}")),
        }
    }

    /// Boxes of the current layout keyed by `data-jb` id, for visual-order
    /// rendering; `None` until a page has been laid out.
    #[cfg(feature = "layout")]
    pub fn layout_boxes(&self) -> Option<(std::collections::HashMap<usize, crate::layout::BoxInfo>, (u32, u32))> {
        self.layout.as_ref().map(|l| (l.boxes(), l.viewport))
    }

    /// The current page's layout, if one has been computed.
    #[cfg(feature = "layout")]
    pub fn layout(&self) -> Option<&crate::layout::blitz::Layout> {
        self.layout.as_ref()
    }

    #[cfg(feature = "layout")]
    /// Forget the current layout (it panicked); the next query rebuilds it from the page.
    pub fn drop_layout(&mut self) {
        self.layout = None;
        self.layout_key = None;
        self.layout_stash.clear();
    }

    /// Make the layout of realm `key` the current one (stashing the current one). False when the
    /// host has no layout for that realm.
    #[cfg(feature = "layout")]
    pub(crate) fn switch_layout_realm(&mut self, key: &str) -> bool {
        const MAX_STASHED: usize = 3;
        if self.layout_key.as_deref() == Some(key) {
            return self.layout.is_some();
        }
        let found = self.layout_stash.iter().position(|(k, _)| k == key).map(|i| self.layout_stash.remove(i));
        if let (Some(cur), Some(cur_key)) = (self.layout.take(), self.layout_key.take()) {
            self.layout_stash.push((cur_key, cur));
            if self.layout_stash.len() > MAX_STASHED {
                self.layout_stash.remove(0);
            }
        }
        match found {
            Some((k, l)) => {
                self.layout = Some(l);
                self.layout_key = Some(k);
                true
            }
            None => false,
        }
    }

    pub fn layout_mut(&mut self) -> Option<&mut crate::layout::blitz::Layout> {
        self.layout.as_mut()
    }

    /// The realm whose layout is the current one (real pages keep one per realm).
    #[cfg(feature = "layout")]
    pub(crate) fn layout_realm_key(&self) -> Option<String> {
        self.layout_key.clone()
    }

    /// Geometry queries from the page (`__jb.layoutQuery`). A payload with
    /// `html` re-lays the document out first; the document is laid out with
    /// this session's HTTP client so stylesheets share cookies and budgets.
    #[cfg(not(feature = "layout"))]
    fn layout_op(&mut self, _payload: &Value) -> Value {
        json!({"error": "layout is not compiled in (cargo feature `layout`)", "unavailable": true})
    }

    #[cfg(feature = "layout")]
    fn layout_op(&mut self, payload: &Value) -> Value {
        use crate::layout::blitz::Layout;
        // layout is the browser's work, not the page's: it does not use up the script budget
        let _excluded = crate::http::ExcludedWork::browser();
        // a realm asking about its own (kept) layout while another realm's is current
        if let Some(realm) = payload.get("realm").and_then(Value::as_str) {
            if payload.get("html").is_none() && !self.switch_layout_realm(realm) {
                return json!({"error": "no layout for this realm", "rebuild": true});
            }
        }
        if let Some(html) = payload.get("html").and_then(Value::as_str) {
            // the page's DOM has scripting on: <noscript> content is text, not markup to lay out
            let html = &*crate::layout::blitz::strip_noscript_content(html);
            let base = payload.get("base").and_then(Value::as_str).unwrap_or(&self.base_url).to_string();
            let viewport = payload
                .get("viewport")
                .and_then(Value::as_array)
                .and_then(|a| Some((a.first()?.as_f64()? as u32, a.get(1)?.as_f64()? as u32)))
                .unwrap_or(crate::layout::blitz::DEFAULT_VIEWPORT);
            // Rendering sub-resources (style sheets, images) get their own budget: a page whose
            // scripts used up the request budget must still be styled and laid out.
            let budget = 40;
            if std::env::var_os("JB_TRACE_JS").is_some() {
                if std::env::var_os("JB_LAYOUT_DUMP").is_some() {
                    let _ = std::fs::write("target/spot/layout-input.html", html);
                }
                eprintln!("[layout] building layout from {} bytes of HTML", html.len());
            }
            let key = payload.get("inc").and_then(Value::as_str).map(str::to_string);
            if let Some(k) = key.as_deref() {
                self.switch_layout_realm(k);
            }
            let incremental = key.is_some() && key == self.layout_key && std::env::var_os("JB_NO_INCREMENTAL_LAYOUT").is_none();
            let remap: Vec<usize> = payload.get("remap").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_u64().map(|n| n as usize)).collect()).unwrap_or_default();
            let updated = incremental
                && match self.layout.as_mut() {
                    Some(l) => std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| l.update(html, &base, viewport, &remap))).unwrap_or_else(|_| {
                        // a half-applied diff: rebuild from scratch below
                        self.layout = None;
                        false
                    }),
                    None => false,
                };
            if updated {
                self.requests_made += self.layout.as_ref().map(|l| l.network_log().len()).unwrap_or(0);
            } else {
                let layout = Layout::from_html(html, &base, self.client.clone(), viewport, budget);
                self.requests_made += layout.network_log().len();
                let swap = std::time::Instant::now();
                self.layout = Some(layout);
                if std::env::var_os("JB_TRACE_JS").is_some() && swap.elapsed().as_millis() >= 50 {
                    eprintln!("[layout] dropping the previous layout took {} ms", swap.elapsed().as_millis());
                }
            }
            self.layout_key = key;
        }
        // hit test with scrolled element panes (tracked by the JS DOM) applied for this query only
        if payload.get("op").and_then(Value::as_str) == Some("point") && payload.get("scrolls").is_some() {
            let Some(layout) = self.layout.as_mut() else {
                return json!({"error": "no layout for this page"});
            };
            let x = payload.get("x").and_then(Value::as_f64).unwrap_or(0.0);
            let y = payload.get("y").and_then(Value::as_f64).unwrap_or(0.0);
            let sx = payload.get("sx").and_then(Value::as_f64).unwrap_or(0.0);
            let sy = payload.get("sy").and_then(Value::as_f64).unwrap_or(0.0);
            let scrolls: Vec<(usize, f64, f64)> = payload.get("scrolls").and_then(Value::as_array).map(|a| a.iter().filter_map(|s| Some((s.get(0)?.as_u64()? as usize, s.get(1)?.as_f64()?, s.get(2)?.as_f64()?))).collect()).unwrap_or_default();
            layout.set_element_scrolls(&scrolls, true);
            let hit = layout.element_at_scrolled(x, y, sx, sy).and_then(|e| e.jbid).map(|j| json!(j)).unwrap_or(Value::Null);
            layout.set_element_scrolls(&scrolls, false);
            return hit;
        }
        let Some(layout) = self.layout.as_ref() else {
            return json!({"error": "no layout for this page"});
        };
        match payload.get("op").and_then(Value::as_str).unwrap_or("") {
            "rect" => payload.get("id").and_then(Value::as_u64).and_then(|i| layout.rect_of_jbid(i as usize)).map(|r| json!(r)).unwrap_or(Value::Null),
            "rects" => {
                let ids = payload.get("ids").and_then(Value::as_array).cloned().unwrap_or_default();
                json!(ids.iter().map(|v| v.as_u64().and_then(|i| layout.rect_of_jbid(i as usize)).map(|r| json!(r)).unwrap_or(Value::Null)).collect::<Vec<_>>())
            }
            "point" => {
                let x = payload.get("x").and_then(Value::as_f64).unwrap_or(0.0);
                let y = payload.get("y").and_then(Value::as_f64).unwrap_or(0.0);
                // the window scroll: the viewport bounds and viewport-fixed boxes need it
                let sx = payload.get("sx").and_then(Value::as_f64).unwrap_or(0.0);
                let sy = payload.get("sy").and_then(Value::as_f64).unwrap_or(0.0);
                layout.element_at_scrolled(x, y, sx, sy).and_then(|e| e.jbid).map(|j| json!(j)).unwrap_or(Value::Null)
            }
            "size" => {
                let (w, h) = layout.document_size();
                json!({"width": w, "height": h, "nodes": layout.node_count(), "ms": layout.resolve_ms, "requests": layout.network_log().len()})
            }
            "elements" => json!(layout.elements()),
            "pointers" => json!(layout.pointer_roots()),
            "animate" => {
                let s = |k: &str| payload.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                let id = payload.get("id").and_then(Value::as_u64).unwrap_or(u64::MAX) as usize;
                let progress = payload.get("progress").and_then(Value::as_f64).unwrap_or(0.0);
                let count = payload.get("count").and_then(Value::as_u64).unwrap_or(1);
                layout.animate_value(id, &s("prop"), &s("kind"), &s("base"), &s("a"), &s("b"), progress, count, &s("url")).map(Value::String).unwrap_or(Value::Null)
            }
            "style" => {
                let props: Vec<String> = payload.get("props").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
                let computed_only = payload.get("computedOnly").and_then(Value::as_bool).unwrap_or(false);
                // the generated ::before / ::after box as Stylo styled it
                if let Some(which) = payload.get("generated").and_then(Value::as_str) {
                    return payload.get("id").and_then(Value::as_u64).and_then(|i| layout.generated_pseudo_style(i as usize, which, &props)).map(Value::Object).unwrap_or(Value::Null);
                }
                // pseudo-element style: the given declarations on a box inheriting from the element
                if let Some(decls) = payload.get("pseudoDecls").and_then(Value::as_str) {
                    let base = payload.get("base").and_then(Value::as_str).unwrap_or("about:blank");
                    let anim = match (payload.get("animFrom").and_then(Value::as_str), payload.get("animTo").and_then(Value::as_str), payload.get("progress").and_then(Value::as_f64)) {
                        (Some(f), Some(t), Some(p)) => Some((f, t, p)),
                        _ => None,
                    };
                    return payload.get("id").and_then(Value::as_u64).and_then(|i| layout.pseudo_style(i as usize, decls, base, &props, anim)).map(Value::Object).unwrap_or(Value::Null);
                }
                payload.get("id").and_then(Value::as_u64).and_then(|i| layout.computed_style(i as usize, &props, computed_only)).map(Value::Object).unwrap_or(Value::Null)
            }
            other => json!({"error": format!("unknown layout op {other}")}),
        }
    }

    fn fetch(&mut self, payload: &Value) -> Value {
        let url = payload.get("url").and_then(Value::as_str).unwrap_or("").to_string();
        let method = payload.get("method").and_then(Value::as_str).unwrap_or("GET").to_string();
        // Standard methods are normalised to uppercase; others keep their case.
        let method = if ["delete", "get", "head", "options", "post", "put", "patch"].contains(&method.to_ascii_lowercase().as_str()) { method.to_ascii_uppercase() } else { method };
        let resolved = crate::http::urljoin(&self.base_url, &url);
        if let Some(data_url) = resolved.strip_prefix("data:") {
            return data_url_response(data_url, &resolved);
        }
        if !(resolved.starts_with("http://") || resolved.starts_with("https://")) {
            return json!({"ok": false, "status": 0, "statusText": "Unsupported URL scheme", "url": resolved, "headers": {}, "text": ""});
        }
        if self.requests_made >= self.config.max_requests || self.over_budget() {
            return json!({"ok": false, "status": 0, "statusText": "Request budget exhausted", "url": resolved, "headers": {}, "text": ""});
        }
        if crate::js::is_blocked_tracker(&resolved) {
            return json!({"ok": false, "status": 0, "statusText": "Blocked (ad/tracker request)", "url": resolved, "headers": {}, "text": ""});
        }
        // Beacons (sendBeacon, fetch keepalive) outlive the page in browsers and nobody waits for
        // them: on real pages they are sent from a background thread and answered at once. Sent
        // synchronously, a first-party analytics beacon held Coursera's load for its 10 s timeout.
        if payload.get("keepalive").and_then(Value::as_bool).unwrap_or(false) && crate::js::runtime::real_pages() {
            self.requests_made += 1;
            let client = self.client.clone();
            let body = payload.get("body").and_then(Value::as_str).unwrap_or("").to_string();
            let mut hdrs: BTreeMap<String, String> = BTreeMap::new();
            if let Some(h) = payload.get("headers").and_then(Value::as_object) {
                for (k, v) in h {
                    if let Some(v) = v.as_str() {
                        hdrs.insert(k.clone(), v.to_string());
                    }
                }
            }
            let (m, u) = (method.clone(), resolved.clone());
            let _ = std::thread::Builder::new().name("beacon".into()).spawn(move || {
                let _ = client.request(&m, &u, &hdrs, if body.is_empty() { None } else { Some(body.as_bytes().to_vec()) }, 10, true);
            });
            return json!({"ok": true, "status": 204, "statusText": "No Content", "url": resolved, "headers": {}, "text": ""});
        }
        self.requests_made += 1;
        let mut headers: BTreeMap<String, String> = BTreeMap::new();
        headers.insert("Accept".into(), "application/json, text/plain, */*".into());
        headers.insert("Accept-Language".into(), "en-US,en;q=0.9".into());
        // Fetch metadata from the page's view of the request (mode, site, destination).
        let mode = payload.get("mode").and_then(Value::as_str).unwrap_or("cors").to_string();
        let site = payload.get("site").and_then(Value::as_str).unwrap_or("same-origin").to_string();
        let dest = payload.get("dest").and_then(Value::as_str).filter(|d| !d.is_empty()).unwrap_or("empty").to_string();
        // Fetch metadata per hop (the client follows redirects itself): the initiator is the
        // requesting document (its origin when the page gave one).
        let initiator = match payload.get("origin").and_then(Value::as_str) {
            Some(o) if o != "null" => o.to_string(),
            Some(_) => "null:".to_string(),
            None => self.base_url.clone(),
        };
        let user = if payload.get("user").and_then(Value::as_bool).unwrap_or(false) { "?1" } else { "" };
        // Content Security Policy: the source lists every redirect target must match.
        if let Some(lists) = payload.get("csp").filter(|v| v.is_array()) {
            headers.insert(crate::http::CSP_META.to_string(), lists.to_string());
        }
        if let Some(m) = payload.get("mixed").and_then(Value::as_str) {
            headers.insert(crate::http::MIXED_META.to_string(), m.to_string());
        }
        if let Some(d) = payload.get("rtDoc").and_then(Value::as_str) {
            headers.insert(crate::http::RT_INITIATOR.to_string(), d.to_string());
        }
        if payload.get("preload").and_then(Value::as_bool).unwrap_or(false) {
            headers.insert(crate::http::PRELOAD_META.to_string(), "1".to_string());
        }
        if follow_requested(payload) {
            let (k, v) = crate::http::fetch_metadata_marker(&dest, &mode, &initiator, user);
            headers.insert(k, v);
        } else {
            for (k, v) in crate::http::fetch_metadata_hop(&dest, &mode, &initiator, &[resolved.clone()], user) {
                if k != "Upgrade-Insecure-Requests" {
                    headers.insert(k, v);
                }
            }
        }
        let _ = &site;
        // Referrer Policy: the page gives the request's referrer and policy; the client computes
        // the Referer of every hop.
        match payload.get("referrer").and_then(Value::as_str) {
            Some(r) => {
                let policy = payload.get("referrerPolicy").and_then(Value::as_str).unwrap_or("");
                let (k, v) = crate::http::referrer_marker(r, policy);
                headers.insert(k, v);
            }
            None => {
                headers.insert("Referer".into(), self.base_url.clone());
            }
        }
        // Browsers send Origin on requests that are not GET/HEAD and on every CORS request.
        let page_origin = payload.get("origin").and_then(Value::as_str).map(|s| s.to_string()).or_else(|| url::Url::parse(&self.base_url).ok().map(|u| u.origin().ascii_serialization()));
        if (method != "GET" && method != "HEAD") || (site != "same-origin" && mode == "cors") {
            if let Some(origin) = page_origin {
                headers.insert("Origin".into(), origin);
            }
        }
        // Credentials: cookies go only where the page's request mode allows them.
        let with_credentials = payload.get("credentials").and_then(Value::as_bool).unwrap_or(true);
        if let Some(h) = payload.get("headers").and_then(Value::as_object) {
            for (k, v) in h {
                headers.insert(k.clone(), v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string()));
            }
        }
        let body = match (payload.get("bodyBase64").and_then(Value::as_str), payload.get("body").and_then(Value::as_str)) {
            (Some(b64), _) => Some(webapis::unb64(b64)),
            (None, Some(s)) => Some(s.as_bytes().to_vec()),
            _ => None,
        };
        // Fetch redirect modes: "follow" (default) lets the client follow,
        // "manual" surfaces the redirect as an opaque-redirect response and
        // "error" turns it into a network error.
        let redirect_mode = payload.get("redirect").and_then(Value::as_str).unwrap_or("follow");
        let follow = redirect_mode == "follow";
        let exchange = FetchExchange {
            method,
            resolved,
            headers,
            body,
            timeout_secs: self.config.request_timeout_secs,
            follow,
            redirect_mode: redirect_mode.to_string(),
            with_credentials,
        };
        // Real pages: fetch()/XHR requests run on a background thread and the page's event loop
        // picks the response up (`fetchPoll`), so requests overlap and scripts are not blocked.
        if payload.get("async").and_then(Value::as_bool).unwrap_or(false) && std::env::var_os("JB_SYNC_FETCH").is_none() {
            let id = self.fetch_next;
            self.fetch_next += 1;
            let client = self.client.clone();
            let tx = self.fetch_tx.clone();
            self.fetch_inflight.insert(id, Instant::now());
            let spawned = std::thread::Builder::new().name("fetch".into()).spawn(move || {
                let (v, call) = exchange.run(&client);
                let _ = tx.send((id, v, call));
            });
            return match spawned {
                Ok(_) => json!({"pending": id}),
                Err(e) => {
                    self.fetch_inflight.remove(&id);
                    json!({"ok": false, "status": 0, "statusText": format!("cannot start request: {e}"), "headers": {}, "text": ""})
                }
            };
        }
        let (v, call) = exchange.run(&self.client);
        self.api_calls.push(call);
        v
    }

    /// Responses of background requests (`fetch` with `async`) that have arrived; waits up to
    /// `wait` ms for the first one. `young` counts requests in flight for less than
    /// ASYNC_FETCH_HOLD_SECS: only those keep a page's event loop waiting.
    fn fetch_poll(&mut self, payload: &Value) -> Value {
        let _excluded = crate::http::ExcludedWork::start();
        let wait = payload.get("wait").and_then(Value::as_u64).unwrap_or(0);
        let mut got: Vec<(u64, Value, ApiCall)> = Vec::new();
        while let Ok(m) = self.fetch_rx.try_recv() {
            got.push(m);
        }
        if got.is_empty() && wait > 0 && !self.fetch_inflight.is_empty() {
            if let Ok(m) = self.fetch_rx.recv_timeout(std::time::Duration::from_millis(wait)) {
                got.push(m);
                while let Ok(m) = self.fetch_rx.try_recv() {
                    got.push(m);
                }
            }
        }
        let mut done = Vec::with_capacity(got.len());
        for (id, v, call) in got {
            if self.fetch_inflight.remove(&id).is_some() {
                self.api_calls.push(call);
                done.push(json!({"id": id, "result": v}));
            }
        }
        let young = self.fetch_inflight.values().filter(|t| t.elapsed().as_secs() < ASYNC_FETCH_HOLD_SECS).count();
        json!({"done": done, "inflight": self.fetch_inflight.len(), "young": young})
    }

    fn storage(&mut self, payload: &Value) -> Value {
        let area = payload.get("area").and_then(Value::as_str).unwrap_or("localStorage");
        let op = payload.get("op").and_then(Value::as_str).unwrap_or("");
        let key = payload.get("key").and_then(Value::as_str).unwrap_or("");
        let origin = origin_of(&self.base_url);
        match op {
            "get" => json!(self.storage.get_item(&origin, area, key)),
            "set" => {
                let value = payload.get("value").map(|v| v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string())).unwrap_or_default();
                self.storage.set_item(&origin, area, key, &value);
                Value::Null
            }
            "remove" => {
                self.storage.remove_item(&origin, area, key);
                Value::Null
            }
            "clear" => {
                self.storage.clear(&origin, area);
                Value::Null
            }
            "keys" => json!(self.storage.keys(&origin, area)),
            _ => Value::Null,
        }
    }

    fn cookie(&mut self, payload: &Value) -> Value {
        let op = payload.get("op").and_then(Value::as_str).unwrap_or("get");
        let url = payload.get("url").and_then(Value::as_str).map(|s| s.to_string()).unwrap_or_else(|| self.base_url.clone());
        match op {
            "get" => {
                let site = payload.get("site").and_then(Value::as_str).unwrap_or("");
                json!(self.client.cookies_for_site(&url, site, self.config.expose_http_only_cookies))
            }
            "set" => {
                let cookie = payload.get("cookie").and_then(Value::as_str).unwrap_or("");
                let site = payload.get("site").and_then(Value::as_str).unwrap_or("");
                json!(self.client.set_cookie_for_site(&url, cookie, site))
            }
            "clear" => {
                self.client.clear_cookies();
                json!(true)
            }
            "all" => json!(self
                .client
                .all_cookies()
                .into_iter()
                .map(|(name, value, domain, path, secure, http_only)| json!({"name": name, "value": value, "domain": domain, "path": path, "secure": secure, "httpOnly": http_only}))
                .collect::<Vec<_>>()),
            _ => Value::Null,
        }
    }

    fn websocket(&mut self, payload: &Value) -> Value {
        if !self.config.allow_websockets {
            return json!({"ok": false, "error": "WebSockets are disabled by configuration"});
        }
        let op = payload.get("op").and_then(Value::as_str).unwrap_or("");
        let id = payload.get("id").and_then(Value::as_u64).unwrap_or(0);
        match op {
            "open" => {
                if self.requests_made >= self.config.max_requests {
                    return json!({"ok": false, "error": "Request budget exhausted"});
                }
                self.requests_made += 1;
                let url = payload.get("url").and_then(Value::as_str).unwrap_or("");
                let protocols: Vec<String> = payload.get("protocols").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
                let origin = origin_of(&self.base_url);
                // the handshake carries the cookies of the URL's http(s) twin, like a browser's
                let http_url = if let Some(rest) = url.strip_prefix("wss://") { format!("https://{rest}") } else if let Some(rest) = url.strip_prefix("ws://") { format!("http://{rest}") } else { url.to_string() };
                let cookie = self.client.cookies_for_site(&http_url, &self.base_url, true);
                self.websockets.open(id, url, &protocols, &self.client.user_agent(), &origin, &cookie)
            }
            "send" => self.websockets.send(id, payload.get("data").and_then(Value::as_str).unwrap_or(""), payload.get("binary").and_then(Value::as_bool).unwrap_or(false)),
            "close" => self.websockets.close(id, payload.get("code").and_then(Value::as_u64).unwrap_or(1000) as u16, payload.get("reason").and_then(Value::as_str).unwrap_or("")),
            _ => json!({"ok": false, "error": "unknown websocket op"}),
        }
    }

    fn event_source(&mut self, payload: &Value) -> Value {
        if !self.config.allow_websockets {
            return json!({"ok": false, "error": "EventSource is disabled by configuration"});
        }
        let op = payload.get("op").and_then(Value::as_str).unwrap_or("");
        let id = payload.get("id").and_then(Value::as_u64).unwrap_or(0);
        match op {
            "open" => {
                if self.requests_made >= self.config.max_requests {
                    return json!({"ok": false, "error": "Request budget exhausted"});
                }
                self.requests_made += 1;
                let url = crate::http::urljoin(&self.base_url, payload.get("url").and_then(Value::as_str).unwrap_or(""));
                self.event_sources.open(id, &url, &self.client)
            }
            "close" => {
                self.event_sources.close(id);
                json!({"ok": true})
            }
            _ => json!({"ok": false}),
        }
    }
}

/// WHATWG URL parsing and the URL API setters, backed by the `url` crate.
/// `{op:"parse", input, base?}` or `{op:"set", href, field, value}`;
/// returns the components record or `{error}`.
/// The URL Standard's "domain to ASCII" leaves an `xn--` label alone when it is
/// not valid Punycode or fails the UTS 46 validity checks (WPT `IdnaTestV2`,
/// `toascii`), while the `url` crate rejects the whole URL. Such labels are
/// swapped for plain placeholder labels before parsing and swapped back,
/// lowercased, in the serialized components.
const XN_PLACEHOLDER: &str = "xnpassthru";

fn mask_xn_labels(input: &str, masks: &mut Vec<(String, String)>) -> String {
    let trimmed = input.trim_matches(|c: char| c <= ' ');
    // Authority = after `scheme://` (or a leading `//`), up to the first path,
    // query or fragment delimiter, without userinfo, port or IPv6 brackets.
    let after_scheme = match trimmed.find(':') {
        Some(i) if trimmed[..i].chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) && trimmed[..i].starts_with(|c: char| c.is_ascii_alphabetic()) => &trimmed[i + 1..],
        _ => trimmed,
    };
    let rest = after_scheme.trim_start_matches(['/', '\\']);
    if after_scheme.len() - rest.len() < 2 {
        return input.to_string();
    }
    let auth_end = rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..auth_end];
    let host_start = authority.rfind('@').map(|i| i + 1).unwrap_or(0);
    let host = &authority[host_start..];
    if host.starts_with('[') || !host.is_ascii() {
        return input.to_string();
    }
    let host_end = host.find(':').unwrap_or(host.len());
    let host = &host[..host_end];
    let before = masks.len();
    let out = mask_host_labels(host, masks);
    if masks.len() == before {
        return input.to_string();
    }
    // Rebuild the input with the masked host in place.
    let host_offset = (trimmed.len() - after_scheme.len()) + (after_scheme.len() - rest.len()) + host_start;
    let mut result = String::from(&trimmed[..host_offset]);
    result.push_str(&out);
    result.push_str(&trimmed[host_offset + host_end..]);
    result
}

/// Mask the `xn--` labels of a bare ASCII host (no port).
fn mask_host_labels(host: &str, masks: &mut Vec<(String, String)>) -> String {
    let mut out = String::with_capacity(host.len());
    for (i, label) in host.split('.').enumerate() {
        if i > 0 {
            out.push('.');
        }
        let lower = label.to_ascii_lowercase();
        if lower.starts_with("xn--") && lower.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            let placeholder = format!("{XN_PLACEHOLDER}{}", masks.len());
            masks.push((placeholder.clone(), lower));
            out.push_str(&placeholder);
        } else {
            out.push_str(label);
        }
    }
    out
}

/// Mask a host[:port] value given to the `host`/`hostname` setters.
fn mask_xn_host_value(value: &str, masks: &mut Vec<(String, String)>) -> String {
    if !value.is_ascii() || value.starts_with('[') {
        return value.to_string();
    }
    let (host, rest) = match value.find([':', '/', '\\', '?', '#']) {
        Some(i) => (&value[..i], &value[i..]),
        None => (value, ""),
    };
    format!("{}{rest}", mask_host_labels(host, masks))
}

fn unmask_xn_labels(s: &str, masks: &[(String, String)]) -> String {
    let mut out = s.to_string();
    for (placeholder, label) in masks.iter().rev() {
        out = out.replace(placeholder.as_str(), label);
    }
    out
}

fn url_op(payload: &Value) -> Value {
    use url::quirks;
    let op = payload.get("op").and_then(Value::as_str).unwrap_or("parse");
    let mut masks: Vec<(String, String)> = Vec::new();
    let masked = |key: &str, masks: &mut Vec<(String, String)>| -> Option<String> { payload.get(key).and_then(Value::as_str).map(|v| mask_xn_labels(v, masks)) };
    let input = masked("input", &mut masks).unwrap_or_default();
    let base = masked("base", &mut masks);
    let href = masked("href", &mut masks).unwrap_or_default();
    let field = payload.get("field").and_then(Value::as_str).unwrap_or("").to_string();
    let raw_value = payload.get("value").and_then(Value::as_str).unwrap_or("");
    let value = match field.as_str() {
        "href" => mask_xn_labels(raw_value, &mut masks),
        "host" | "hostname" => mask_xn_host_value(raw_value, &mut masks),
        _ => raw_value.to_string(),
    };
    let (input, base, href, value) = (input.as_str(), base.as_deref(), href.as_str(), value.as_str());
    let field = field.as_str();
    // Legacy document encodings apply to the query component (URL Standard
    // "encoding override"); utf-16 and replacement map to utf-8.
    let encoding = payload.get("encoding").and_then(Value::as_str).and_then(|l| encoding_rs::Encoding::for_label(l.as_bytes())).map(|e| e.output_encoding()).filter(|e| *e != encoding_rs::UTF_8);
    // URL Standard "percent-encode after encoding": code points the encoding
    // cannot represent become `%26%23<decimal>%3B` (an escaped `&#N;`).
    fn make_override(enc: &'static encoding_rs::Encoding) -> impl Fn(&str) -> std::borrow::Cow<'_, [u8]> {
        move |s| {
            let (bytes, _, had_errors) = enc.encode(s);
            if !had_errors {
                return bytes;
            }
            let mut out = Vec::with_capacity(s.len() * 2);
            for ch in s.chars() {
                let mut buf = [0u8; 4];
                let piece = ch.encode_utf8(&mut buf);
                let (b, _, err) = enc.encode(piece);
                if err {
                    out.extend_from_slice(format!("%26%23{}%3B", ch as u32).as_bytes());
                } else {
                    out.extend_from_slice(&b);
                }
            }
            std::borrow::Cow::Owned(out)
        }
    }
    let override_fn = encoding.map(make_override);
    let parse_with = |input: &str, base: Option<&str>| -> Result<url::Url, String> {
        let base_url = match base {
            Some(b) => Some(url::Url::parse(b).map_err(|e| format!("Invalid base URL: {e}"))?),
            None => None,
        };
        let mut opts = url::Url::options();
        if let Some(f) = override_fn.as_ref() {
            opts = opts.encoding_override(Some(f));
        }
        opts.base_url(base_url.as_ref()).parse(input).map_err(|e| e.to_string())
    };
    let parsed: Result<url::Url, String> = match op {
        "parse" => parse_with(input, base),
        "set" => {
            match parse_with(href, None) {
                Ok(mut u) => {
                    let r: Result<(), ()> = match field {
                        "href" => parse_with(value, None).map(|n| u = n).map_err(|_| ()),
                        "protocol" => quirks::set_protocol(&mut u, value),
                        "username" => quirks::set_username(&mut u, value),
                        "password" => quirks::set_password(&mut u, value),
                        "host" => quirks::set_host(&mut u, value),
                        "hostname" => quirks::set_hostname(&mut u, value),
                        "port" => quirks::set_port(&mut u, value),
                        "pathname" => {
                            quirks::set_pathname(&mut u, value);
                            Ok(())
                        }
                        "search" => {
                            if encoding.is_some() {
                                // Re-parse so the override applies to the new query.
                                let v = value.trim_start_matches('?');
                                let mut base = u.clone();
                                base.set_query(None);
                                let frag = u.fragment().map(|f| format!("#{f}")).unwrap_or_default();
                                let candidate = if v.is_empty() { format!("{}{}", base.as_str().trim_end_matches('#'), frag) } else { format!("{}?{}{}", base.as_str().split('#').next().unwrap_or(""), v, frag) };
                                match parse_with(&candidate, None) {
                                    Ok(n) => { u = n; Ok(()) }
                                    Err(_) => Err(()),
                                }
                            } else {
                                quirks::set_search(&mut u, value);
                                Ok(())
                            }
                        }
                        "hash" => {
                            quirks::set_hash(&mut u, value);
                            Ok(())
                        }
                        _ => Ok(()),
                    };
                    // Setter failures leave the URL unchanged (per spec), except
                    // for `href`, which throws.
                    if r.is_err() && field == "href" {
                        Err("Invalid URL".into())
                    } else {
                        Ok(u)
                    }
                }
                Err(e) => Err(e.to_string()),
            }
        }
        _ => Err("unknown url op".into()),
    };
    match parsed {
        Ok(u) => {
            let f = |s: &str| unmask_xn_labels(s, &masks);
            // A blob: URL's origin is its inner http(s) URL's origin, else opaque.
            let origin = if u.scheme() == "blob" {
                match url::Url::parse(u.path()) {
                    Ok(inner) if matches!(inner.scheme(), "http" | "https") => quirks::origin(&inner),
                    _ => "null".to_string(),
                }
            } else {
                quirks::origin(&u)
            };
            json!({
                "href": f(quirks::href(&u)),
                "origin": f(&origin),
                "protocol": quirks::protocol(&u),
                "username": quirks::username(&u),
                "password": quirks::password(&u),
                "host": f(quirks::host(&u)),
                "hostname": f(quirks::hostname(&u)),
                "port": quirks::port(&u),
                "pathname": quirks::pathname(&u),
                "search": quirks::search(&u),
                "hash": quirks::hash(&u),
            })
        }
        Err(e) => json!({"error": e}),
    }
}

#[cfg(test)]
mod xn_tests {
    use super::*;

    #[test]
    fn invalid_punycode_labels_pass_through() {
        let r = url_op(&json!({"op": "parse", "input": "https://XN--a.pt/x?q=/xn--b"}));
        assert_eq!(r["href"], "https://xn--a.pt/x?q=/xn--b");
        assert_eq!(r["hostname"], "xn--a.pt");
        assert_eq!(r["origin"], "https://xn--a.pt");
        let r = url_op(&json!({"op": "parse", "input": "//xn--ab-j1t:8080/", "base": "http://example.com/"}));
        assert_eq!(r["host"], "xn--ab-j1t:8080");
        let r = url_op(&json!({"op": "set", "href": "https://example.com/", "field": "hostname", "value": "xn--"}));
        assert_eq!(r["href"], "https://xn--/");
        // Valid hosts and non-authority text are untouched.
        let r = url_op(&json!({"op": "parse", "input": "https://example.com/xn--a"}));
        assert_eq!(r["pathname"], "/xn--a");
    }
}

fn origin_of(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(u) => format!("{}://{}", u.scheme(), u.host_str().unwrap_or("")),
        Err(_) => "null".into(),
    }
}

/// Synthesize a response for a `data:` URL.
/// Body of a `data:` URL as text (for `<script src="data:...">`).
pub fn data_url_text(url: &str) -> Option<String> {
    let rest = url.strip_prefix("data:")?;
    let v = data_url_response(rest, url);
    if v.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        v.get("text").and_then(Value::as_str).map(|s| s.to_string())
    } else {
        None
    }
}

/// Intrinsic size of an encoded image: raster formats through the `image`
/// crate (header decode only), SVG from its root `width`/`height`/`viewBox`.
#[cfg(feature = "images")]
fn image_dimensions(bytes: &[u8], mime: &str) -> Option<(u32, u32, bool)> {
    let looks_svg = mime == "image/svg+xml" || bytes.iter().take(512).any(|&b| b == b'<') && String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).contains("<svg");
    if looks_svg {
        let text = String::from_utf8_lossy(bytes);
        let root = text.find("<svg").map(|i| &text[i..]).unwrap_or("");
        let root = &root[..root.find('>').unwrap_or(root.len())];
        let attr = |name: &str| -> Option<String> {
            let key = format!("{name}=");
            let i = root.find(&key)?;
            let rest = &root[i + key.len()..];
            let quote = rest.chars().next()?;
            let rest = &rest[1..];
            Some(rest[..rest.find(quote)?].to_string())
        };
        let len = |v: Option<String>| v.and_then(|s| { let t = s.trim(); if t.ends_with('%') { return None; } t.trim_end_matches("px").parse::<f64>().ok() }).filter(|n| *n >= 0.0);
        let (w, h) = (len(attr("width")), len(attr("height")));
        let vb: Option<(f64, f64)> = attr("viewBox").and_then(|s| {
            let n: Vec<f64> = s.split(|c: char| c == ' ' || c == ',').filter(|p| !p.is_empty()).filter_map(|p| p.parse().ok()).collect();
            (n.len() == 4 && n[2] > 0.0 && n[3] > 0.0).then(|| (n[2], n[3]))
        });
        let (w, h, intrinsic) = match (w, h, vb) {
            (Some(w), Some(h), _) => (w, h, true),
            (Some(w), None, Some((vw, vh))) => (w, w * vh / vw, true),
            (None, Some(h), Some((vw, vh))) => (h * vw / vh, h, true),
            (None, None, Some((vw, vh))) => (300.0, 300.0 * vh / vw, true),
            (Some(w), None, None) => (w, 150.0, false),
            (None, Some(h), None) => (300.0, h, false),
            (None, None, None) => (300.0, 150.0, false),
        };
        return Some((w.round() as u32, h.round() as u32, intrinsic));
    }
    use image::ImageDecoder;
    let mut dec = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().ok()?.into_decoder().ok()?;
    let (w, h) = dec.dimensions();
    // EXIF orientations 5-8 swap the axes (images are shown with image-orientation: from-image)
    let swap = matches!(dec.orientation().ok(), Some(image::metadata::Orientation::Rotate90 | image::metadata::Orientation::Rotate270 | image::metadata::Orientation::Rotate90FlipH | image::metadata::Orientation::Rotate270FlipH));
    Some(if swap { (h, w, true) } else { (w, h, true) })
}

#[cfg(not(feature = "images"))]
fn image_dimensions(_bytes: &[u8], _mime: &str) -> Option<(u32, u32, bool)> {
    None
}

fn data_url_response(rest: &str, full: &str) -> Value {
    let (meta, payload) = match rest.find(',') {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => return json!({"ok": false, "status": 0, "statusText": "Malformed data URL", "url": full, "headers": {}, "text": ""}),
    };
    let mime = meta.split(';').next().unwrap_or("text/plain");
    let mime = if mime.is_empty() { "text/plain" } else { mime };
    let bytes: Vec<u8> = if meta.contains(";base64") {
        webapis::unb64(payload)
    } else {
        percent_encoding::percent_decode_str(payload).collect()
    };
    let headers = json!({"content-type": mime});
    match std::str::from_utf8(&bytes) {
        Ok(text) if mime.starts_with("text/") || mime.contains("json") || mime.contains("javascript") => {
            json!({"ok": true, "status": 200, "statusText": "OK", "url": full, "headers": headers, "text": text})
        }
        _ => json!({"ok": true, "status": 200, "statusText": "OK", "url": full, "headers": headers, "bodyBase64": webapis::b64(&bytes)}),
    }
}

impl NativeHost for Host {
    fn call(&mut self, op: &str, payload: &str) -> String {
        let payload: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
        let result = match op {
            // diagnostics for JB_TRACE_JS runs only (never part of the page's console)
            "trace" => {
                if std::env::var_os("JB_TRACE_JS").is_some() {
                    eprintln!("[trace] {}", payload.get("message").and_then(Value::as_str).unwrap_or(""));
                }
                Value::Null
            }
            "log" => {
                let level = payload.get("level").and_then(Value::as_str).unwrap_or("log");
                let message = payload.get("message").and_then(Value::as_str).unwrap_or("").to_string();
                if self.config.echo_console {
                    eprintln!("[js:{level}] {message}");
                }
                if level == "error" {
                    self.errors.push(message.clone());
                }
                self.console.push(format!("{}: {message}", level.to_ascii_uppercase()));
                Value::Null
            }
            "fetch" => self.fetch(&payload),
            "fetchPoll" => self.fetch_poll(&payload),
            "csp" => csp_op(&payload),
            "urlpattern" => urlpattern_op(&payload),
            "referrer" => {
                let source = payload.get("source").and_then(Value::as_str).unwrap_or("");
                let policy = payload.get("policy").and_then(Value::as_str).unwrap_or("");
                let target = payload.get("target").and_then(Value::as_str).unwrap_or("");
                json!(crate::http::determine_referrer(source, policy, target))
            }
            "image" => {
                self.note_fetch_kind(&payload, "image");
                self.image(&payload)
            }
            // Start an image fetch in the background; the "image" op later picks the response up.
            "imageStart" => {
                let url = payload.get("url").and_then(Value::as_str).unwrap_or("");
                if cfg!(feature = "images") && (url.starts_with("http://") || url.starts_with("https://")) && !self.image_cache.contains_key(url) && self.requests_made < self.config.max_requests && !crate::js::is_blocked_tracker(url) {
                    let url = url.to_string();
                    self.note_fetch_kind(&payload, "image");
                    let headers = self.subresource_headers(&url);
                    let url = url.as_str();
                    self.client.prefetch_with(vec![url.to_string()], headers, self.config.request_timeout_secs);
                }
                Value::Null
            }
            "canvas" => self.canvas_op(&payload),
            "media" => self.media_op(&payload),
            "storage" => self.storage(&payload),
            "cookie" => self.cookie(&payload),
            "websocket" => self.websocket(&payload),
            "eventsource" => self.event_source(&payload),
            "crypto" => webapis::crypto_op(&payload),
            "crypto2" => super::crypto::op(&payload),
            "random" => {
                let n = payload.get("n").and_then(Value::as_u64).unwrap_or(16).min(65536) as usize;
                let mut buf = vec![0u8; n];
                rand::rng().fill_bytes(&mut buf);
                json!(webapis::b64(&buf))
            }
            "uuid" => json!(uuid::Uuid::new_v4().to_string()),
            "compress" => {
                let format = payload.get("format").and_then(Value::as_str).unwrap_or("gzip");
                let data = webapis::unb64(payload.get("data").and_then(Value::as_str).unwrap_or(""));
                let decompress = payload.get("decompress").and_then(Value::as_bool).unwrap_or(false);
                match webapis::compress(format, &data, decompress) {
                    Ok(out) => json!({"bytes": webapis::b64(&out)}),
                    Err(e) => json!({"error": e}),
                }
            }
            "clipboard" => {
                if !self.config.allow_clipboard {
                    json!({"error": "Clipboard access is disabled by configuration"})
                } else if payload.get("op").and_then(Value::as_str) == Some("write") {
                    match webapis::clipboard_write(payload.get("text").and_then(Value::as_str).unwrap_or("")) {
                        Ok(_) => json!({"ok": true}),
                        Err(e) => json!({"error": e}),
                    }
                } else {
                    match webapis::clipboard_read() {
                        Ok(t) => json!({"text": t}),
                        Err(e) => json!({"error": e}),
                    }
                }
            }
            "geolocation" => match self.config.geolocation {
                Some(g) => json!({"latitude": g.latitude, "longitude": g.longitude, "accuracy": g.accuracy}),
                None => Value::Null,
            },
            "notification" => {
                let title = payload.get("title").and_then(Value::as_str).unwrap_or("").to_string();
                let body = payload.get("body").and_then(Value::as_str).unwrap_or("").to_string();
                self.console.push(format!("NOTIFICATION: {title}{}", if body.is_empty() { String::new() } else { format!(" — {body}") }));
                self.notifications.push(NotificationRecord { title, body });
                json!(self.config.notification_permission)
            }
            "notification_permission" => json!(self.config.notification_permission),
            "webauthn" => super::passkeys::handle(&payload),
            #[cfg(feature = "layout")]
            "cssdecl" => crate::layout::cssom::handle(&payload),
            "idb" => {
                let origin = origin_of(&self.base_url);
                match payload.get("op").and_then(Value::as_str) {
                    Some("load") => self.idb.load(&origin),
                    Some("save") => {
                        self.idb.save(&origin, payload.get("data").cloned().unwrap_or(Value::Null));
                        Value::Null
                    }
                    _ => Value::Null,
                }
            }
            "url" => url_op(&payload),
            "encoding" => self.encoding_op(&payload),
            "html" => {
                let html = payload.get("html").and_then(Value::as_str).unwrap_or("");
                let scripting = payload.get("scripting").and_then(Value::as_bool).unwrap_or(true);
                match payload.get("context").and_then(Value::as_str) {
                    Some(tag) => super::parse_html_to_json_opts(html, Some((tag, payload.get("ns").and_then(Value::as_str).unwrap_or("html"))), scripting),
                    None => super::parse_html_to_json_opts(html, None, scripting),
                }
            }
            // <script type=importmap> of the calling realm's document
            "importMap" => {
                let json = payload.get("json").and_then(Value::as_str).unwrap_or("");
                let base = payload.get("base").and_then(Value::as_str).unwrap_or("");
                match super::runtime::register_import_map(json, base) {
                    Ok(()) => json!({"ok": true}),
                    Err(e) => json!({"error": e}),
                }
            }
            "resolveModule" => {
                let spec = payload.get("spec").and_then(Value::as_str).unwrap_or("");
                let base = payload.get("base").and_then(Value::as_str).unwrap_or("");
                super::runtime::resolve_module_specifier(spec, base).map(Value::String).unwrap_or(Value::Null)
            }
            "elapsed" => json!(self.started.elapsed().as_secs_f64() * 1000.0),
            // Resource Timing records of the requests made by the document at `doc`
            "resourceTimings" => {
                let doc = payload.get("doc").and_then(Value::as_str).unwrap_or("");
                let top = payload.get("top").and_then(Value::as_bool).unwrap_or(false);
                let ms = |t: std::time::Instant| t.checked_duration_since(self.started).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0);
                json!(self.client.take_resource_timings(doc, top).into_iter().map(|r| json!({
                    "url": r.url, "finalUrl": r.final_url, "dest": r.dest, "mode": r.mode, "status": r.status,
                    "headers": r.headers, "size": r.body_len, "start": ms(r.start), "end": ms(r.end),
                })).collect::<Vec<_>>())
            }
            "budget" => json!({"over": self.over_budget(), "requests_left": self.config.max_requests.saturating_sub(self.requests_made)}),
            // a new task inside one script call (a typed key): see runtime::Deadline::expired
            "taskStart" => {
                super::runtime::mark_task_start();
                Value::Null
            }
            "layout" => match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.layout_op(&payload))) {
                Ok(v) => v,
                Err(_) => {
                    // a layout left inconsistent would panic on every later query: rebuild next time
                    self.drop_layout();
                    json!({"error": "layout failed"})
                }
            },
            _ => json!({"error": format!("unknown native op: {op}")}),
        };
        result.to_string()
    }
}

/// Requests in flight longer than this no longer hold a page's event loop (long polls).
const ASYNC_FETCH_HOLD_SECS: u64 = 5;

/// A prepared page request (`fetch` op): the network exchange and its JSON answer, runnable on
/// another thread.
struct FetchExchange {
    method: String,
    resolved: String,
    headers: BTreeMap<String, String>,
    body: Option<Vec<u8>>,
    timeout_secs: u64,
    follow: bool,
    redirect_mode: String,
    with_credentials: bool,
}

impl FetchExchange {
    fn run(self, client: &HttpClient) -> (Value, ApiCall) {
        let trace = std::env::var_os("JB_TRACE_JS").is_some();
        let fetch_started = Instant::now();
        let anonymous;
        let client = if self.with_credentials {
            client
        } else {
            anonymous = HttpClient::new(Some(&client.user_agent()));
            &anonymous
        };
        let FetchExchange { method, resolved, headers, body, timeout_secs, follow, redirect_mode, .. } = self;
        let redirect_mode = redirect_mode.as_str();
        match client.request(&method, &resolved, &headers, body, timeout_secs, follow) {
            Ok(resp) if !follow && matches!(resp.status, 301 | 302 | 303 | 307 | 308) && resp.headers.contains_key("location") => {
                let call = ApiCall { method: method.clone(), url: resolved.clone(), status: resp.status, content_type: String::new() };
                let v = if redirect_mode == "error" {
                    json!({"ok": false, "status": 0, "statusText": "redirect not allowed", "url": resolved, "headers": {}, "text": ""})
                } else {
                    // the Location stays internal (navigations follow it themselves)
                    let loc = resp.headers.get("location").cloned().unwrap_or_default();
                    json!({"ok": false, "status": 0, "statusText": "", "url": resolved, "headers": {}, "text": "", "opaqueRedirect": true, "redirectStatus": resp.status, "redirectLocation": loc})
                };
                (v, call)
            }
            Ok(resp) => {
                if trace {
                    eprintln!("[js] fetch {method} {resolved} -> {} ({} bytes) in {} ms", resp.status, resp.body.len(), fetch_started.elapsed().as_millis());
                }
                let call = ApiCall { method: method.clone(), url: resolved.clone(), status: resp.status, content_type: resp.content_type() };
                let mut resp = resp;
                let sent_referrer = resp.headers.remove(crate::http::SENT_REFERRER);
                let sent_origin = resp.headers.remove(crate::http::SENT_ORIGIN);
                resp.headers.remove(crate::http::CROSS_REDIRECT);
                let mut out = json!({
                    "ok": resp.ok(),
                    "status": resp.status,
                    "statusText": resp.reason,
                    "url": resp.url,
                    "headers": resp.headers,
                    "referrer": sent_referrer.unwrap_or_default(),
                });
                if let Some(o) = sent_origin {
                    out["sentOrigin"] = json!(o);
                }
                if resp.is_binary() {
                    out["bodyBase64"] = json!(webapis::b64(&resp.body));
                } else {
                    out["text"] = json!(resp.text);
                    out["encoding"] = json!(resp.encoding);
                }
                (out, call)
            }
            Err(e) => {
                let call = ApiCall { method, url: resolved.clone(), status: 0, content_type: String::new() };
                (json!({"ok": false, "status": 0, "statusText": e.to_string(), "url": resolved, "headers": {}, "text": ""}), call)
            }
        }
    }
}

/// Subresource Integrity: whether `bytes` match the integrity `metadata` ("sha384-<b64> ...").
/// Only the strongest algorithm listed counts; metadata without a valid token matches anything.
pub fn sri_matches(metadata: &str, bytes: &[u8]) -> bool {
    use base64::Engine as _;
    use sha2::Digest as _;
    let rank = |alg: &str| match alg { "sha256" => 1, "sha384" => 2, "sha512" => 3, _ => 0 };
    let tokens: Vec<(&str, &str)> = metadata
        .split_ascii_whitespace()
        .filter_map(|t| {
            let t = t.split('?').next().unwrap_or(t);
            let (alg, digest) = t.split_once('-')?;
            (rank(&alg.to_ascii_lowercase()) > 0).then_some((alg, digest))
        })
        .collect();
    let Some(best) = tokens.iter().map(|(a, _)| rank(&a.to_ascii_lowercase())).max() else { return true };
    tokens.iter().filter(|(a, _)| rank(&a.to_ascii_lowercase()) == best).any(|(a, d)| {
        let actual = match a.to_ascii_lowercase().as_str() {
            "sha256" => sha2::Sha256::digest(bytes).to_vec(),
            "sha384" => sha2::Sha384::digest(bytes).to_vec(),
            _ => sha2::Sha512::digest(bytes).to_vec(),
        };
        // base64 or base64url, padding optional
        let want = d.trim_end_matches('=').replace('-', "+").replace('_', "/");
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(&actual) == want
    })
}

/// Whether a page fetch follows redirects (fetch "follow" mode, the default).
fn follow_requested(payload: &Value) -> bool {
    payload.get("redirect").and_then(Value::as_str).unwrap_or("follow") == "follow"
}

/// Content Security Policy helpers for the JS environment: `matchUrl` (does a URL match a source
/// list, `self` = the policy's self origin, `redirected` = after a redirect) and `hostSource`.
fn csp_op(payload: &Value) -> Value {
    let list: Vec<String> = payload.get("list").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
    match payload.get("op").and_then(Value::as_str).unwrap_or("") {
        "matchUrl" => {
            let url = payload.get("url").and_then(Value::as_str).unwrap_or("");
            let origin = payload.get("self").and_then(Value::as_str).unwrap_or("");
            let redirected = payload.get("redirected").and_then(Value::as_bool).unwrap_or(false);
            json!(crate::csp::url_matches_source_list(&list, url, origin, redirected))
        }
        "hostSource" => json!(crate::csp::is_host_source(payload.get("expr").and_then(Value::as_str).unwrap_or(""))),
        _ => Value::Null,
    }
}

/// URLPattern (rust-urlpattern's browser integration): `parse` gives the component patterns as
/// ECMAScript regexp strings (the env compiles and runs them), `match` canonicalizes match input.
fn urlpattern_op(payload: &Value) -> Value {
    use urlpattern::quirks;
    let base = payload.get("baseURL").and_then(Value::as_str);
    let input: quirks::StringOrInit = match payload.get("input") {
        Some(Value::String(s)) => quirks::StringOrInit::String(std::borrow::Cow::Owned(s.clone())),
        Some(v @ Value::Object(_)) => match serde_json::from_value::<quirks::UrlPatternInit>(v.clone()) {
            Ok(i) => quirks::StringOrInit::Init(i),
            Err(e) => return json!({"error": e.to_string()}),
        },
        _ => quirks::StringOrInit::Init(quirks::UrlPatternInit::default()),
    };
    match payload.get("op").and_then(Value::as_str).unwrap_or("") {
        "parse" => {
            let ignore_case = payload.get("ignoreCase").and_then(Value::as_bool).unwrap_or(false);
            let init = match quirks::process_construct_pattern_input(input, base) {
                Ok(i) => i,
                Err(e) => return json!({"error": e.to_string()}),
            };
            let options = urlpattern::UrlPatternOptions { regex_syntax: urlpattern::RegexSyntax::EcmaScript, ignore_case };
            match quirks::parse_pattern::<quirks::EcmaRegexp>(init, options) {
                Ok(p) => serde_json::to_value(p).unwrap_or(Value::Null),
                Err(e) => json!({"error": e.to_string()}),
            }
        }
        "match" => match quirks::process_match_input(input, base) {
            Ok(Some((mi, _inputs))) => match quirks::parse_match_input(mi) {
                Some(m) => serde_json::to_value(m).unwrap_or(Value::Null),
                None => Value::Null,
            },
            Ok(None) => Value::Null,
            Err(e) => json!({"error": e.to_string()}),
        },
        _ => Value::Null,
    }
}
