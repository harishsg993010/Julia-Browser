//! JavaScript Engine - executes page scripts with Mozilla SpiderMonkey.
//!
//! The engine loads a browser environment (DOM, events, fetch, storage, ...)
//! written in JavaScript into a SpiderMonkey global, mirrors the parsed HTML
//! into it, runs the page's scripts (including timers and promise jobs) and
//! finally applies the resulting DOM changes back onto the Rust document so
//! they show up in the rendered markdown.

pub mod crypto;
pub mod host;
pub mod media;
pub mod passkeys;
pub mod runtime;
pub mod storage;
pub mod webapis;

use crate::dom::{self, Document};
use crate::http::HttpClient;
use ego_tree::NodeId;
pub use host::{ApiCall, Geolocation, JsConfig, NotificationRecord};
use host::Host;
use webapis::IdbStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::rc::Rc;
pub use storage::RealStorage;

/// Hosts (and their subdomains) that serve ads, ad auctions, analytics or tracking scripts.
const AD_SCRIPT_HOSTS: &[&str] = &[
    "doubleclick.net", "googlesyndication.com", "googletagservices.com", "googleadservices.com",
    "google-analytics.com", "googletagmanager.com", "adservice.google.com", "amazon-adsystem.com",
    "adnxs.com", "criteo.com", "criteo.net", "taboola.com", "tblcontent.com", "taboolasyndication.com", "outbrain.com", "scorecardresearch.com",
    "chartbeat.com", "chartbeat.net", "hotjar.com", "quantserve.com", "quantcount.com", "moatads.com",
    "confiant-integrations.net", "adsafeprotected.com", "doubleverify.com", "rubiconproject.com",
    "pubmatic.com", "openx.net", "casalemedia.com", "indexww.com", "teads.tv", "yieldmo.com",
    "sharethrough.com", "smartadserver.com", "bidswitch.net", "3lift.com", "sonobi.com", "media.net",
    "lijit.com", "connect.facebook.net", "ads-twitter.com", "static.ads-twitter.com",
    "analytics.tiktok.com", "bat.bing.com", "clarity.ms", "cdn.segment.com", "fastly-insights.com",
    "ads.linkedin.com", "snap.licdn.com", "adform.net", "permutive.com", "permutive.app",
    "imasdk.googleapis.com", "pagead2.googlesyndication.com", "securepubads.g.doubleclick.net",
    // marketing pixels and their loaders (GTM tags keep firing them while a page settles)
    "tr.snapchat.com", "sc-static.net", "alb.reddit.com", "pixel-config.reddit.com", "q.quora.com", "bat.bing.net",
    "ojrq.net", "i384100.net", "impactcdn.com", "ct.pinterest.com", "analytics.twitter.com", "static.ads-twitter.com",
    "api.segment.io", "cdn.heapanalytics.com", "js.hs-analytics.net", "track.hubspot.com", "px.ads.linkedin.com",
    "dynatrace.com", "go-mpulse.net", "akstat.io", "cdn.mxpnl.com", "cdn.amplitude.com", "trc.taboola.com",
    "dwin1.com", "appdynamics.com", "eum-appdynamics.com",
];

/// Ad-tech hosts page scripts send requests to (ID syncs, bids, beacons) besides AD_SCRIPT_HOSTS.
const TRACKER_HOSTS: &[&str] = &[
    // telemetry/RUM collectors (TikTok embed monitors, Pingdom RUM, Datadog RUM intake)
    "tiktokv.us", "tiktokw.us", "tiktokv.com", "pingdom.net", "browser-intake-datadoghq.com", "browser-intake-us5-datadoghq.com",
    "id5-sync.com", "liadm.com", "rlcdn.com", "adsrvr.org", "optable.co", "rezync.com", "thrtle.com",
    "sitescout.com", "demdex.net", "everesttech.net", "bluekai.com", "krxd.net", "tapad.com", "agkn.com",
    "mathtag.com", "contextweb.com", "gumgum.com", "33across.com", "quantcast.com", "bidr.io", "crwdcntrl.net",
    "exelator.com", "eyeota.net", "lotame.com", "omnitagjs.com", "adsymptotic.com", "pubmine.com", "openwebmp.com",
    "amplify.outbrain.com", "zemanta.com", "smaato.net", "inmobi.com", "unrulymedia.com", "sharethis.com",
    "addthis.com", "simpli.fi", "adition.com", "dotomi.com", "turn.com", "w55c.net", "ipredictive.com",
    "nr-data.net", "newrelic.com", "mookie1.com", "serving-sys.com", "flashtalking.com", "kargo.com",
    "trustx.org", "ads.yahoo.com", "analytics.yahoo.com", "advertising.com", "creativecdn.com",
    "presage.io", "seedtag.com", "connatix.com", "primis.tech", "brealtime.com", "onetag-sys.com",
    "rubiconproject.net", "pbxai.com", "hbopenbid.pubmatic.com", "aniview.com", "adlightning.com",
    "imrworldwide.com", "branch.io", "mparticle.com", "amplitude.com", "mixpanel.com", "fullstory.com",
    "heapanalytics.com", "doubleclick.com", "adroll.com", "rfihub.com", "intentiq.com", "ad-delivery.net",
];

/// Requests a content blocker would stop: ad, analytics and ID-sync traffic. On real pages these
/// fail at once (as with an ad blocker) instead of costing 0.2-1 s each: page JS makes them through
/// the synchronous fetch op, so dozens of them made every action take tens of seconds (Allrecipes
/// search: 50 s). `JB_ALLOW_ADS=1` lets them through; WPT pages are never affected.
pub(crate) fn is_blocked_tracker(url: &str) -> bool {
    if !runtime::real_pages() || std::env::var_os("JB_ALLOW_ADS").is_some() {
        return false;
    }
    let Ok(u) = url::Url::parse(url) else { return false };
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    let matches = |d: &&str| host == *d || host.ends_with(&format!(".{d}"));
    // analytics collection endpoints served from first-party hosts (server-side GTM, Sentry)
    let path = u.path();
    let first_party_pixel = (host == "www.facebook.com" || host == "facebook.com") && (path == "/tr" || path == "/tr/")
        || (host.ends_with("google.com") && path.starts_with("/pagead/"))
        || (host == "t.co" && path.starts_with("/i/adsct"));
    let collect = first_party_pixel || path.contains("/_/service_worker/") || path.ends_with("/g/collect") || path.ends_with("/j/collect") || path.ends_with("/mp/collect") || (host.ends_with("ingest.sentry.io") || host.ends_with(".ingest.us.sentry.io"))
        // Shopify web pixels (analytics sandboxes the shop's Web Pixels Manager builds)
        || path.starts_with("/web-pixels@") || path.starts_with("/web-pixels/");
    collect || AD_SCRIPT_HOSTS.iter().any(matches) || TRACKER_HOSTS.iter().filter(|d| !d.contains('/')).any(matches)
}

/// Whether a script URL is an ad/analytics script (by host, or a prebid bundle by name).
pub(crate) fn is_ad_script(src: &str) -> bool {
    let Ok(u) = url::Url::parse(src) else { return false };
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    if AD_SCRIPT_HOSTS.iter().any(|d| host == *d || host.ends_with(&format!(".{d}"))) {
        return true;
    }
    let file = u.path().rsplit('/').next().unwrap_or("").to_ascii_lowercase();
    // Shopify's Web Pixels Manager, served from the shop (/cdn/wpm/<hash>.js, or under /cdn/shop)
    file.contains("prebid") || (u.path().contains("/cdn/wpm/") && file.ends_with(".js"))
}

/// The browser environment shim, concatenated in load order.
/// The environment runs as one strict-mode block: its top-level classes and functions are
/// block-scoped (page scripts may replace the window properties 94_exports.js creates for them).
pub const BROWSER_ENV: &str = concat!(
    // `globalThis` inside the environment is the real global, whatever page scripts assign to
    // the property later (OpenStreetMap's Bootstrap bundle swaps it while loading)
    "\"use strict\";\n{\nconst globalThis = this;\n",
    include_str!("env/00_core.js"),
    "\n",
    include_str!("env/10_events.js"),
    "\n",
    include_str!("env/15_performance.js"),
    "\n",
    include_str!("env/16_webcrypto.js"),
    "\n",
    include_str!("env/20_html.js"),
    "\n",
    include_str!("env/21_scopecss.js"),
    "\n",
    include_str!("env/30_dom.js"),
    include_str!("env/30b_cssparse.js"),
    include_str!("env/30c_stylo_cssom.js"),
    "\n",
    include_str!("env/35_reflect.js"),
    "\n",
    include_str!("env/36_slots.js"),
    "\n",
    include_str!("env/37_forms.js"),
    "\n",
    include_str!("env/37b_select.js"),
    "\n",
    include_str!("env/38_closewatcher.js"),
    "\n",
    include_str!("env/38b_internals.js"),
    "\n",
    include_str!("env/39_svgdom.js"),
    "\n",
    include_str!("env/40_document.js"),
    "\n",
    include_str!("env/41_partial_updates.js"),
    "\n",
    include_str!("env/45_frames.js"),
    "\n",
    include_str!("env/50_apis.js"),
    include_str!("env/50b_geometry.js"),
    "\n",
    include_str!("env/51_indexeddb.js"),
    "\n",
    include_str!("env/52_streams.js"),
    "\n",
    include_str!("env/55_webapis.js"),
    "\n",
    include_str!("env/57_layout.js"),
    "\n",
    include_str!("env/58_images.js"),
    "\n",
    include_str!("env/58_stylesheets.js"),
    "\n",
    include_str!("env/59_canvas.js"),
    "\n",
    include_str!("env/59b_webgl.js"),
    "\n",
    include_str!("env/59_media.js"),
    "\n",
    include_str!("env/60_realms.js"),
    "\n",
    include_str!("env/61_workers.js"),
    "\n",
    include_str!("env/61b_service_workers.js"),
    "\n",
    include_str!("env/62_crossorigin.js"),
    include_str!("env/62b_cssprops.js"),
    "
",
    include_str!("env/62c_typed_om.js"),
    include_str!("env/63_animations.js"),
    "\n",
    include_str!("env/64_history.js"),
    include_str!("env/65_navigation.js"),
    "\n",
    include_str!("env/66_policy.js"),
    "\n",
    include_str!("env/66b_csp.js"),
    include_str!("env/67_editing.js"),
    include_str!("env/67b_editing_glue.js"),
    include_str!("env/68_platform_apis.js"),
    include_str!("env/68b_webauthn.js"),
    include_str!("env/68c_text_fragments.js"),
    include_str!("env/69_xpath.js"),
    "\n",
    include_str!("env/70_scheduling.js"),
    "\n",
    include_str!("env/71_locks.js"),
    "\n",
    include_str!("env/72_storage_fs.js"),
    "\n",
    include_str!("env/73_cookiestore.js"),
    "\n",
    include_str!("env/74a_device_apis.js"),
    "\n",
    include_str!("env/74b_payment_shape.js"),
    "\n",
    include_str!("env/74c_sw_managers.js"),
    "\n",
    include_str!("env/74d_pip.js"),
    "\n",
    include_str!("env/75_paint_timing.js"),
    "
",
    include_str!("env/76_mathml_dom.js"),
    "
",
    include_str!("env/77_permissions_policy.js"),
    "
",
    include_str!("env/78_resource_timing.js"),
    "
",
    include_str!("env/79_properties_values.js"),
    "
",
    include_str!("env/80_css_misc.js"),
    "
",
    include_str!("env/81_compute_pressure.js"),
    "
",
    include_str!("env/82_device_orientation.js"),
    "
",
    include_str!("env/83_xslt.js"),
    "\n",
    include_str!("env/84_pseudo_style.js"),
    "\n",
    include_str!("env/85_soft_nav.js"),
    "\n",
    include_str!("env/86_css_shapes.js"),
    "\n",
    include_str!("env/87_css_gaps.js"),
    "\n",
    include_str!("env/90_bridge.js"),
    include_str!("env/90b_anim_hooks.js"),
    "\n",
    include_str!("env/92_user.js"),
    "\n",
    include_str!("env/94_exports.js"),
    "\n",
    include_str!("env/95_idl_shape.js"),
    "\n",
    include_str!("env/96_idl_data.js"),
    "\n",
    include_str!("env/97_idl_install.js"),
    "\n",
    include_str!("env/97b_trusted_types.js"),
    "\n",
    include_str!("env/98_native.js"),
    "\n}\n",
);

/// A script to run against a page.
#[derive(Debug, Clone)]
pub struct ScriptSource {
    /// Inline code (None for external scripts).
    pub code: Option<String>,
    /// `src` attribute (already resolved) for external scripts.
    pub src: Option<String>,
    /// `type="module"`.
    pub module: bool,
    /// Index of the `<script>` element in the mirrored DOM (for `document.currentScript`).
    pub jbid: Option<usize>,
    /// Index in `__jb.pendingScriptEls` for scripts inserted by other scripts.
    pub pending: Option<usize>,
    /// Runs after parsing finishes (`defer`, and module scripts without `async`).
    pub deferred: bool,
}

/// A DOM subtree change reported by the JS side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomUpdate {
    pub id: Option<usize>,
    pub html: String,
    #[serde(default)]
    pub attrs: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Navigation {
    #[serde(rename = "type")]
    pub kind: String,
    pub url: String,
    /// The initiating document's referrer policy for this navigation ("" = the document's).
    #[serde(rename = "referrerPolicy", default, skip_serializing_if = "Option::is_none")]
    pub referrer_policy: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormSubmission {
    pub action: String,
    pub method: String,
    #[serde(default)]
    pub data: serde_json::Map<String, Value>,
    /// The request as the page realm encoded it from the form's entry list (order and repeated
    /// names kept): the GET URL, or the POST body and its content type. `data` (one value per
    /// name) is the fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(rename = "contentType", default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

impl FormSubmission {
    /// One value per name (the last), for callers that look fields up.
    pub fn data_map(&self) -> std::collections::BTreeMap<String, String> {
        self.data.iter().map(|(k, v)| (k.clone(), v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string()))).collect()
    }

    /// The request this submission makes: (method, url, body, content type).
    pub fn request(&self) -> (String, String, Option<String>, Option<String>) {
        if self.method.eq_ignore_ascii_case("post") {
            let body = self.body.clone().unwrap_or_else(|| crate::http::url_encode_form(&self.data_map()));
            return ("POST".into(), self.action.clone(), Some(body), self.content_type.clone());
        }
        let url = self.url.clone().unwrap_or_else(|| crate::http::append_query(&self.action, &self.data_map()));
        ("GET".into(), url, None, None)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dialog {
    #[serde(rename = "type")]
    pub kind: String,
    pub message: String,
}

/// Everything observed while running a page's JavaScript.
#[derive(Debug, Clone, Default, Serialize)]
pub struct JsExecution {
    pub scripts_run: usize,
    pub scripts_failed: usize,
    pub console: Vec<String>,
    pub errors: Vec<String>,
    pub dom_updates: Vec<DomUpdate>,
    pub title: Option<String>,
    pub navigations: Vec<Navigation>,
    pub form_submissions: Vec<FormSubmission>,
    pub dialogs: Vec<Dialog>,
    pub cookies_set: Vec<String>,
    pub api_calls: Vec<ApiCall>,
    pub notifications: Vec<NotificationRecord>,
    /// Text drawn onto <canvas> elements via fillText/strokeText.
    pub canvas_text: Vec<String>,
    pub websocket_messages: usize,
    pub open_connections: usize,
    pub pending_timers: usize,
    pub final_url: Option<String>,
    /// Completion value of the last evaluated script (for `execute_script`).
    pub result: Option<String>,
}

impl JsExecution {
    /// Context passed to the extractors (`js_context`).
    pub fn to_context(&self) -> Value {
        json!({
            "console_output": self.console,
            "console_errors": self.errors,
            "dom_modifications": self.dom_updates.iter().filter_map(|u| u.id.map(|id| (id.to_string(), json!({"innerHTML": u.html})))).collect::<serde_json::Map<_, _>>(),
            "ajax_endpoints": self.api_calls.iter().map(|c| c.url.clone()).collect::<Vec<_>>(),
            "navigations": self.navigations,
            "form_submissions": self.form_submissions,
            "notifications": self.notifications,
            "canvas_text": self.canvas_text,
        })
    }
}

/// JavaScript execution engine backed by SpiderMonkey.
pub struct JavaScriptEngine {
    client: HttpClient,
    /// Storage handed to the host when it is first created (None = persistent).
    pending_storage: Rc<RefCell<Option<(RealStorage, IdbStore)>>>,
    pub config: JsConfig,
    env_loaded: bool,
    /// Node map for the most recently mirrored document: jbid -> NodeId.
    node_map: Vec<NodeId>,
    /// Canonical encoding name the next loaded document was decoded with.
    pub document_charset: Option<String>,
    /// `run_page`'s extra init script, also run before the DOM is mirrored (so flags it sets apply during load).
    pre_dom_init: Option<String>,
    /// Response headers (lower-cased names) of the next loaded document
    /// (`Origin-Agent-Cluster` and friends are read from them).
    pub document_headers: Option<std::collections::BTreeMap<String, String>>,
    /// URL of the page whose realm is currently live (scripts ran, listeners
    /// registered). Interactions against the same URL reuse that realm.
    live_url: Option<String>,
    /// Scripts executed / external scripts fetched for the current page.
    page_run_count: usize,
    page_external_fetched: usize,
    /// Ad/analytics scripts on the current page: time used (ms), how many were skipped, and
    /// whether the ad budget applies (off in WPT mode).
    page_ad_used_ms: u64,
    page_ads_skipped: usize,
    ad_budget_on: bool,
    /// True while parser-inserted scripts run; external scripts inserted by
    /// scripts then wait until parsing finishes (as async scripts do).
    parsing: bool,
    dynamic_deferred: Vec<ScriptSource>,
    /// Live scripts (`execute_script` on a live realm) leave the Rust document stale instead of
    /// re-exporting the whole DOM after each one; [`Self::sync_if_stale`] catches up on demand.
    /// Protocol drivers (CDP) read the page through JS and set this.
    pub defer_dom_sync: bool,
    dom_stale: bool,
}

impl JavaScriptEngine {
    pub fn new(client: HttpClient) -> Self {
        Self::with_config(client, JsConfig::default())
    }

    pub fn with_config(client: HttpClient, config: JsConfig) -> Self {
        Self { client, pending_storage: Rc::new(RefCell::new(None)), config, env_loaded: false, node_map: Vec::new(), document_charset: None, pre_dom_init: None, document_headers: None, live_url: None, page_run_count: 0, page_external_fetched: 0, page_ad_used_ms: 0, page_ads_skipped: 0, ad_budget_on: false, parsing: false, dynamic_deferred: Vec::new(), defer_dom_sync: false, dom_stale: false }
    }

    /// Use non-persistent Web Storage (tests, sandboxing).
    pub fn set_ephemeral_storage(&mut self) {
        let installed = runtime::with_host(|h| {
            h.storage = RealStorage::ephemeral();
            h.idb = IdbStore::ephemeral();
        })
        .is_some();
        if !installed {
            *self.pending_storage.borrow_mut() = Some((RealStorage::ephemeral(), IdbStore::ephemeral()));
        }
    }

    fn ensure_env(&mut self) -> Result<(), runtime::JsError> {
        // The environment needs the host from the start (e.g. `location`
        // parses a URL natively).
        self.ensure_host(None);
        if self.env_loaded {
            return Ok(());
        }
        // Check for an already-loaded environment in this thread's global.
        if runtime::eval("typeof __jb === 'object' && __jb.ready === true", "probe.js").map(|s| s == "true").unwrap_or(false) {
            self.env_loaded = true;
            return Ok(());
        }
        runtime::eval(BROWSER_ENV, "browser_env.js")?;
        self.env_loaded = true;
        Ok(())
    }

    /// Make sure a host is installed in this thread; with `page_url` the host
    /// is (re)initialised for a new page load.
    fn ensure_host(&mut self, page_url: Option<&str>) {
        let config = self.config.clone();
        let existing = runtime::with_host(|h| {
            h.config = config.clone();
            if let Some(url) = page_url {
                h.begin_page(url);
            }
        });
        if existing.is_none() {
            let (storage, idb) = self.pending_storage.borrow_mut().take().unwrap_or_else(|| match &config.profile_dir {
                Some(dir) if dir.as_os_str().is_empty() => (RealStorage::ephemeral(), IdbStore::ephemeral()),
                Some(dir) => {
                    let _ = std::fs::create_dir_all(dir);
                    (RealStorage::at_path(dir.join("localStorage.json")), IdbStore::at_path(dir.join("indexedDB.json")))
                }
                None => (RealStorage::persistent(), IdbStore::persistent()),
            });
            runtime::set_host(Box::new(Host::new(self.client.clone(), storage, idb, config, page_url.unwrap_or("about:blank"))));
        }
    }

    /// The live realm's document moved to `url` within the same document (history API,
    /// fragment): later scripts against `url` keep using that realm.
    pub fn follow_same_document(&mut self, url: &str) {
        if self.live_url.is_some() {
            self.live_url = Some(url.to_string());
        }
    }

    /// Whether a live realm for `url` exists that interactions can reuse.
    pub fn is_live(&self, url: &str) -> bool {
        self.env_loaded && self.live_url.as_deref() == Some(url) && !self.node_map.is_empty()
    }

    /// The JS-side id of a node of the last synced document, if any.
    /// The mirrored document's nodes indexed by the id the JS DOM uses for them.
    pub fn node_map(&self) -> &[NodeId] {
        &self.node_map
    }

    pub fn jbid_of(&self, node: NodeId) -> Option<usize> {
        self.node_map.iter().position(|n| *n == node)
    }

    /// Discard the live realm (the next page load starts fresh).
    pub fn invalidate_live(&mut self) {
        self.live_url = None;
    }

    /// Mirror the document into the JS side, in a fresh global scope (each
    /// page gets its own realm, as in a real browser).
    pub fn load_document(&mut self, doc: &Document, url: &str) -> Result<(), runtime::JsError> {
        self.live_url = None;
        if self.env_loaded {
            runtime::reset_global();
            self.env_loaded = false;
        }
        self.ensure_env()?;
        if let Some(init) = self.pre_dom_init.take() {
            let _ = runtime::eval(&init, "init.js");
        }
        let (json, map) = serialize_document(doc);
        self.node_map = map;
        let script = format!("__jb.loadDom({}, {})", json, serde_json::to_string(url).unwrap_or_else(|_| "\"about:blank\"".into()));
        runtime::eval(&script, "load_dom.js")?;
        if let Some(cs) = &self.document_charset {
            let _ = runtime::eval(&format!("document._characterSet = {}", serde_json::to_string(cs).unwrap_or_default()), "charset.js");
        }
        if let Some(h) = &self.document_headers {
            let _ = runtime::eval(&format!("document._responseHeaders = {}", serde_json::to_string(h).unwrap_or_else(|_| "{}".into())), "headers.js");
            // the Referer the navigation was sent with is the document's referrer
            if let Some(r) = h.get(crate::http::SENT_REFERRER) {
                let _ = runtime::eval(&format!("document._referrer = {}", serde_json::to_string(r).unwrap_or_else(|_| "\"\"".into())), "referrer.js");
            }
        }
        if !self.config.service_workers {
            let _ = runtime::eval("__jb.swDisabled = true", "sw.js");
        }
        runtime::eval("__jb.markScriptsExecuted()", "mark.js")?;
        Ok(())
    }

    /// Collect the page's scripts in document order; the first import map
    /// on the page becomes the module resolver's map.
    pub fn collect_scripts(&self, doc: &Document, base_url: &str) -> Vec<ScriptSource> {
        let mut out = Vec::new();
        let ids = dom::find_all(doc, &["script"]);
        let mut import_map: Option<runtime::ImportMap> = None;
        for id in &ids {
            if dom::attr(doc, *id, "type").map(|t| t.trim().eq_ignore_ascii_case("importmap")).unwrap_or(false) && import_map.is_none() {
                import_map = runtime::parse_import_map(&dom::get_text(doc, *id), base_url);
            }
        }
        runtime::set_import_map(import_map.unwrap_or_default());
        for id in ids {
            let ty = dom::attr(doc, id, "type");
            let lang = dom::attr(doc, id, "language");
            let module = match script_kind(ty.as_deref(), lang.as_deref()) {
                Some(m) => m,
                None => continue, // JSON-LD, templates, importmaps, ...
            };
            // nomodule only applies to classic scripts.
            if !module && dom::has_attr(doc, id, "nomodule") {
                continue;
            }
            // Legacy `<script for=... event=...>` runs only for window's load event.
            if !module {
                if let (Some(f), Some(e)) = (dom::attr(doc, id, "for"), dom::attr(doc, id, "event")) {
                    let trim = |s: &str| s.trim_matches(|c: char| matches!(c, '\t' | '\n' | '\x0c' | '\r' | ' ')).to_ascii_lowercase();
                    let (f, e) = (trim(&f), trim(&e));
                    if f != "window" || (e != "onload" && e != "onload()") {
                        continue;
                    }
                }
            }
            let jbid = self.node_map.iter().position(|n| *n == id);
            let is_async = dom::has_attr(doc, id, "async");
            if let Some(src) = dom::attr(doc, id, "src") {
                let src = src.trim();
                let deferred = !is_async && (module || dom::has_attr(doc, id, "defer"));
                // An empty src fires `error` on the element (no fetch).
                let resolved = if src.is_empty() { String::new() } else { crate::http::urljoin(base_url, src) };
                out.push(ScriptSource { code: None, src: Some(resolved), module, jbid, pending: None, deferred });
            } else {
                let code = dom::get_text(doc, id);
                if !code.is_empty() {
                    out.push(ScriptSource { code: Some(code), src: None, module, jbid, pending: None, deferred: module && !is_async });
                }
            }
        }
        out
    }

    /// Run the whole page lifecycle: scripts, DOMContentLoaded, timers, load.
    /// DOM changes are applied to `doc` when the run completes.
    pub fn run_page(&mut self, doc: &mut Document, url: &str, extra_init: Option<&str>) -> JsExecution {
        let mut exec = JsExecution::default();
        self.ensure_host(Some(url));
        runtime::set_base_url(url);
        runtime::clear_modules();
        self.pre_dom_init = extra_init.map(|s| s.to_string());
        if let Err(e) = self.load_document(doc, url) {
            exec.errors.push(format!("Failed to initialise JavaScript environment: {e}"));
            self.finish(doc, &mut exec);
            return exec;
        }
        // `<script src>` resolves against the document base URL (the first `<base href>`): Angular
        // apps ship `<base href="/">` with relative bundle names, so every deep link (Raising
        // Cane's /location/.../the-box-combo) fetched /location/.../main.js -> 404, blank page.
        let base = dom::find_all(doc, &["base"]).into_iter().find_map(|b| dom::attr(doc, b, "href")).map(|h| crate::http::urljoin(url, h.trim())).unwrap_or_else(|| url.to_string());
        let scripts = self.collect_scripts(doc, &base);
        let wpt = extra_init.is_some_and(|s| s.contains("__jb.wptMode = true"));
        runtime::with_host(|h| {
            h.speculative_fetch = !wpt;
            h.prefetched_modules.clear();
            h.client.set_subresource_link_preloads(wpt);
            h.client.set_network_error_logging(wpt);
        });
        // Real pages: time spent waiting on servers does not count against the script budget.
        runtime::set_exclude_network_wait(!wpt);
        self.ad_budget_on = !wpt;
        self.page_ad_used_ms = 0;
        self.page_ads_skipped = 0;

        if let Some(init) = extra_init {
            if let Err(e) = runtime::eval(init, "init.js") {
                exec.errors.push(format!("init: {e}"));
            }
        }
        // real pages: Date on the virtual timer clock (see installVirtualDate in 15_performance.js)
        if !wpt {
            let _ = runtime::eval("if (typeof __jb.installVirtualDate === 'function') __jb.installVirtualDate();", "date.js");
        }

        self.page_run_count = 0;
        self.page_external_fetched = 0;
        // A runaway script is aborted when the page's time budget is spent.
        runtime::set_deadline(Some(std::time::Duration::from_millis(self.config.time_budget_ms.max(1000))));
        // Parser-inserted scripts run in document order; deferred ones
        // (`defer`, modules) after the rest, in their own order. Scripts a
        // script inserts run right after it, before the next parser script.
        // Preload scanner for module scripts: their fetches carry module request headers, so
        // they are prefetched here with exactly those (classic scripts were prefetched by the engine).
        let module_srcs: Vec<String> = scripts.iter().filter(|s| s.module).filter_map(|s| s.src.clone()).collect();
        if !module_srcs.is_empty() {
            runtime::with_host(|h| h.prefetch_entry_modules(&module_srcs));
        }
        let (deferred, immediate): (Vec<ScriptSource>, Vec<ScriptSource>) = scripts.into_iter().partition(|s| s.deferred);
        self.parsing = true;
        self.dynamic_deferred.clear();
        for script in immediate.into_iter().chain(deferred) {
            if self.page_run_count >= MAX_SCRIPTS_PER_PAGE || self.host_over_budget() {
                break;
            }
            self.run_script(script, &mut exec, url);
            self.run_pending_scripts(&mut exec, url);
        }
        self.parsing = false;
        // External scripts inserted while parsing (async in a browser).
        for script in std::mem::take(&mut self.dynamic_deferred) {
            if self.page_run_count >= MAX_SCRIPTS_PER_PAGE || self.host_over_budget() {
                break;
            }
            self.run_script(script, &mut exec, url);
            self.run_pending_scripts(&mut exec, url);
        }

        let _ = runtime::eval("__jb.fireLifecycle('interactive')", "lifecycle.js");
        runtime::run_jobs();
        self.run_pending_scripts(&mut exec, url);
        // Between DOMContentLoaded and load only near-immediate timers run
        // (as in a browser where resources finish loading within a few ms);
        // long timeouts must not fire before the load event.
        self.drain_timers_until(self.config.max_timer_steps / 4, "__jb.clock + 30", &mut exec, url);
        let _ = runtime::eval("__jb.fireLifecycle('complete')", "lifecycle.js");
        runtime::run_jobs();
        self.run_pending_scripts(&mut exec, url);
        self.drain_timers(self.config.max_timer_steps, &mut exec, url);
        self.pump_network();

        let interrupted = runtime::set_deadline(None);
        runtime::profile_report(&format!("load {url}"));
        if interrupted > 0 {
            exec.errors.push(format!("{interrupted} script(s) were stopped: the page's time budget of {} ms ran out", self.config.time_budget_ms));
        }
        if self.page_ads_skipped > 0 {
            exec.console.push(format!("INFO: {} ad/analytics script(s) skipped: their budget of {} ms was spent ({} ms used)", self.page_ads_skipped, self.config.ad_budget_ms, self.page_ad_used_ms));
        }
        self.finish(doc, &mut exec);
        self.live_url = Some(url.to_string());
        exec
    }

    /// `JB_TRACE_JS=1`: one stderr line per script with where it came from and how long it took.
    fn run_script(&mut self, script: ScriptSource, exec: &mut JsExecution, url: &str) {
        let trace = std::env::var_os("JB_TRACE_JS").is_some();
        let label = script.src.clone().unwrap_or_else(|| format!("inline ({} bytes)", script.code.as_ref().map(|c| c.len()).unwrap_or(0)));
        let started = std::time::Instant::now();
        if trace {
            eprintln!("[js] start {}{}", if script.module { "module " } else { "" }, label);
        }
        self.run_script_inner(script, exec, url);
        if trace {
            eprintln!("[js] done  {label} in {} ms", started.elapsed().as_millis());
        }
    }

    /// Execute one script element (parser-inserted or dynamically added):
    /// fetch it if external, evaluate it, and fire its load/error event.
    fn run_script_inner(&mut self, script: ScriptSource, exec: &mut JsExecution, url: &str) {
        // Ad/analytics scripts run on their own budget; once it is spent they are skipped like an
        // ad blocker would (the element fires `error`).
        let ad = self.ad_budget_on && script.src.as_deref().is_some_and(is_ad_script);
        if ad && self.page_ad_used_ms >= self.config.ad_budget_ms {
            self.page_ads_skipped += 1;
            if std::env::var_os("JB_TRACE_JS").is_some() {
                eprintln!("[js] skip  ad script {} (ad budget spent)", script.src.as_deref().unwrap_or(""));
            }
            if let Some(p) = script.pending {
                let _ = runtime::eval(&format!("__jb.endPendingScript({p}, false)"), "pending.js");
            } else if let Some(j) = script.jbid {
                let _ = runtime::eval(&format!("__jb.scriptDone({j}, false)"), "pending.js");
            }
            runtime::run_jobs();
            return;
        }
        if ad {
            runtime::begin_excused(std::time::Duration::from_millis(self.config.ad_budget_ms - self.page_ad_used_ms));
        }
        self.run_script_body(script, exec, url);
        if ad {
            self.page_ad_used_ms += runtime::end_excused().as_millis() as u64;
        }
    }

    fn run_script_body(&mut self, script: ScriptSource, exec: &mut JsExecution, url: &str) {
        // Content Security Policy: inline scripts (nonces, hashes, 'unsafe-inline') and the
        // external URL (before it is fetched; module graphs are checked by the module loader).
        let csp_el = match (script.pending, script.jbid) {
            (Some(p), _) => format!("__jb.pendingScriptEls[{p}]"),
            (None, Some(j)) => format!("__jb.nodeById[{j}]"),
            _ => "null".into(),
        };
        let csp_parser = if script.pending.is_some() { "" } else { "parser-inserted" };
        let csp_src = match (&script.code, &script.src) {
            (Some(_), _) => Some("null".to_string()),
            (None, Some(s)) if !s.is_empty() => Some(serde_json::to_string(s).unwrap_or_default()),
            _ => None,
        };
        if let Some(src_js) = csp_src {
            // inline scripts are checked against the text captured when they were prepared
            let text_js = match &script.code { Some(c) if script.src.is_none() => serde_json::to_string(c).unwrap_or_else(|_| "undefined".into()), _ => "undefined".into() };
            let verdict = runtime::eval(&format!("typeof __jb.cspScriptVerdict === 'function' ? __jb.cspScriptVerdict({csp_el}, {src_js}, '{csp_parser}', {}, false, undefined, {text_js}) : true", script.module), "csp.js").unwrap_or_default();
            if verdict == "false" {
                exec.errors.push(format!("Refused to run script {}: Content Security Policy", script.src.as_deref().unwrap_or("(inline)")));
                let external = script.src.is_some();
                if let Some(p) = script.pending {
                    let _ = runtime::eval(&format!("__jb.endPendingScript({p}, {})", if external { "false" } else { "null" }), "pending.js");
                } else if let Some(j) = script.jbid {
                    if external {
                        let _ = runtime::eval(&format!("__jb.scriptDone({j}, false)"), "pending.js");
                    }
                }
                runtime::run_jobs();
                return;
            }
        }
        // Set when the classic script's response (or any redirect on the way) was cross-origin.
        let mut cross_origin_fetch = false;
        // The element's integrity metadata (external scripts only).
        let integrity: Option<String> = if script.src.is_some() {
            let el = match (script.pending, script.jbid) {
                (Some(p), _) => format!("__jb.pendingScriptEls[{p}]"),
                (None, Some(j)) => format!("__jb.nodeById[{j}]"),
                _ => "null".into(),
            };
            runtime::eval(&format!("(function (e) {{ return __jb.hostJson(e && e.hasAttribute('integrity') ? e.getAttribute('integrity') : null); }})({el})"), "integrity.js")
                .ok()
                .and_then(|v| serde_json::from_str::<Option<String>>(&v).ok())
                .flatten()
                .filter(|m| !m.trim().is_empty())
        } else {
            None
        };
        let code = match (&script.code, &script.src) {
            (Some(c), _) => Some(c.clone()),
            // External modules are fetched through the module map.
            (None, Some(src)) if src.is_empty() => None,
            (None, Some(_)) if script.module => Some(String::new()),
            (None, Some(src)) if src.starts_with("data:") => host::data_url_text(src),
            // blob: URLs resolve in the page's blob URL store
            (None, Some(src)) if src.starts_with("blob:") => {
                let expr = format!("(function () {{ var r = __jb.fetchSource({}); return __jb.hostJson(r && !r.failed ? {{ text: r.html }} : null); }})()", serde_json::to_string(src).unwrap_or_default());
                let text = runtime::eval(&expr, "blob.js").ok().and_then(|v| serde_json::from_str::<Value>(&v).ok()).and_then(|v| v.get("text").and_then(Value::as_str).map(str::to_string));
                if text.is_none() {
                    exec.errors.push(format!("Failed to load external script {src}"));
                }
                text
            }
            (None, Some(src)) => {
                if !self.config.fetch_external_scripts || self.page_external_fetched >= self.config.max_external_scripts {
                    None
                } else {
                    self.page_external_fetched += 1;
                    // Redirects are followed here so every hop's origin is seen (muted errors).
                    let doc_origin = url::Url::parse(url).ok().map(|u| u.origin());
                    let mut target = src.clone();
                    // A prefetched response (redirects already followed) stands for the whole chain.
                    // a crossorigin attribute makes the classic script request a CORS one
                    let el_expr = match (script.pending, script.jbid) {
                        (Some(p), _) => format!("__jb.pendingScriptEls[{p}]"),
                        (None, Some(j)) => format!("__jb.nodeById[{j}]"),
                        _ => "null".into(),
                    };
                    let cors = runtime::eval(&format!("(function (e) {{ return !!(e && e.hasAttribute && e.hasAttribute('crossorigin')); }})({el_expr})"), "cors.js").map(|v| v == "true").unwrap_or(false);
                    let smode = if cors { "cors" } else { "no-cors" };
                    // Referrer Policy: the element's referrerpolicy attribute, else the document's.
                    let referrer: (String, String) = runtime::eval(&format!("(function (e) {{ var r = __jb.requestReferrer ? __jb.requestReferrer(__jb.elementReferrerPolicy(e)) : {{ referrer: '', referrerPolicy: '' }}; return __jb.hostJson([r.referrer, r.referrerPolicy]); }})({el_expr})"), "referrer.js")
                        .ok()
                        .and_then(|v| serde_json::from_str::<(String, String)>(&v).ok())
                        .unwrap_or_else(|| (url.to_string(), String::new()));
                    let script_headers = crate::http::fetch_metadata_headers("script", smode, url, src);
                    let prefetched = self.client.take_prefetched_with(src, &script_headers, self.config.request_timeout_secs);
                    let mut chain: Vec<String> = vec![src.clone()];
                    if let Some(p) = &prefetched {
                        if url::Url::parse(&p.url).ok().map(|u| u.origin()) != doc_origin {
                            cross_origin_fetch = true;
                        }
                    }
                    let mut result = match prefetched {
                        Some(p) => Ok(p),
                        None => {
                            let mut h = crate::http::fetch_metadata_hop("script", smode, url, &chain, "");
                            h.insert("Accept".into(), "*/*".into());
                            // Resource Timing: a script request of this document (marker, not sent)
                            let (mk, mv) = crate::http::fetch_metadata_marker("script", smode, url, "");
                            h.insert(mk, mv);
                            if let Some(r) = crate::http::determine_referrer(&referrer.0, &referrer.1, &target) {
                                h.insert("Referer".into(), r);
                            }
                            self.client.request("GET", &target, &h, None, self.config.request_timeout_secs, false)
                        }
                    };
                    for _ in 0..20 {
                        if url::Url::parse(&target).ok().map(|u| u.origin()) != doc_origin {
                            cross_origin_fetch = true;
                        }
                        let next = match &result {
                            Ok(resp) if (300..400).contains(&resp.status) => resp.headers.get("location").and_then(|l| url::Url::parse(&target).ok()?.join(l.trim()).ok()).map(|u| u.to_string()),
                            _ => None,
                        };
                        match next {
                            Some(n) => {
                                // every redirect target must be allowed by the page's CSP
                                let ok = runtime::eval(&format!("typeof __jb.cspScriptVerdict === 'function' ? __jb.cspScriptVerdict({el_expr}, {}, '{csp_parser}', false, true, {}) : true", serde_json::to_string(&n).unwrap_or_default(), serde_json::to_string(src).unwrap_or_default()), "csp.js").unwrap_or_default();
                                if ok == "false" {
                                    result = Err(crate::http::HttpError::Other("blocked by Content Security Policy".into()));
                                    break;
                                }
                                target = n;
                                chain.push(target.clone());
                                let mut h = crate::http::fetch_metadata_hop("script", smode, url, &chain, "");
                                h.insert("Accept".into(), "*/*".into());
                                if let Some(r) = crate::http::determine_referrer(&referrer.0, &referrer.1, &target) {
                                    h.insert("Referer".into(), r);
                                }
                                result = self.client.request("GET", &target, &h, None, self.config.request_timeout_secs, false);
                            }
                            None => break,
                        }
                    }
                    match result {
                        Ok(resp) if resp.status == 200 && integrity.as_deref().is_some_and(|m| !host::sri_matches(m, &resp.body)) => {
                            exec.errors.push(format!("Failed to load external script {src}: integrity metadata does not match"));
                            None
                        }
                        Ok(resp) if resp.status == 200 => Some(resp.text),
                        _ => {
                            exec.errors.push(format!("Failed to load external script {src}"));
                            None
                        }
                    }
                }
            }
            _ => None,
        };
        let code = match code {
            Some(c) => c,
            None => {
                if let Some(p) = script.pending {
                    let _ = runtime::eval(&format!("__jb.endPendingScript({p}, false)"), "pending.js");
                } else if let Some(j) = script.jbid {
                    let _ = runtime::eval(&format!("__jb.scriptDone({j}, false)"), "pending.js");
                }
                runtime::run_jobs();
                return;
            }
        };
        if let Some(p) = script.pending {
            let _ = runtime::eval(&format!("__jb.beginPendingScript({p}, {})", script.module), "pending.js");
        }
        self.page_run_count += 1;
        exec.scripts_run += 1;
        let cleaned = clean_script(&code);
        let jbid = script.jbid.map(|i| i.to_string()).unwrap_or_else(|| "null".into());
        // (a script inserted by another script already has currentScript set by beginPendingScript)
        if script.pending.is_none() {
            let _ = runtime::eval(&format!("__jb.beginScript({jbid}, {})", script.module), "begin.js");
        }
        // Evaluated as a real global script (not eval) so that top-level
        // let/const/class declarations are visible to later scripts.
        let filename = script.src.clone().unwrap_or_else(|| format!("inline-script-{}.js", self.page_run_count));
        if script.module {
            // The module graph's fetches use the script element's referrer policy (else the document's).
            let el = match (script.pending, script.jbid) {
                (Some(p), _) => format!("__jb.pendingScriptEls[{p}]"),
                (None, Some(j)) => format!("__jb.nodeById[{j}]"),
                _ => "null".into(),
            };
            let policy = runtime::eval(&format!("(function (e) {{ var p = e && e.getAttribute('referrerpolicy'); p = p ? p.toLowerCase() : ''; if (!p) p = __jb.documentReferrerPolicy ? __jb.documentReferrerPolicy() : ''; return p; }})({el})"), "policy.js").unwrap_or_default();
            runtime::with_host(|h| h.module_referrer_policy = policy);
            let top = script.src.clone().zip(integrity.clone());
            runtime::with_host(|h| h.module_integrity = top);
        }
        let result = if script.module {
            match &script.src {
                Some(src) => runtime::eval_module(None, &filename, src),
                None => runtime::eval_module(Some(&cleaned), &filename, url),
            }
        } else {
            {
                // import() from this script inherits its element's nonce (CSP)
                let nonce = runtime::eval(&format!("(function (e) {{ return e && __jb.elementNonce ? __jb.elementNonce(e) : ''; }})({csp_el})"), "nonce.js").unwrap_or_default();
                let base = script.src.as_deref().unwrap_or(url);
                let base = if nonce.is_empty() { base.to_string() } else { format!("{base}\u{1}{nonce}") };
                runtime::eval_script_with_base(&cleaned, &filename, &base)
            }
        };
        let mut loaded = true;
        match result {
            Ok(()) => {}
            Err(runtime::JsError::ModuleFetch(msg)) => {
                // A missing dependency fires `error` on the element only.
                loaded = false;
                exec.scripts_failed += 1;
                exec.errors.push(msg);
            }
            Err(e) if runtime::is_termination(&e.to_string()) => {
                // stopped by the time budget: counted in the "were stopped" summary
                exec.scripts_failed += 1;
            }
            Err(e) => {
                exec.scripts_failed += 1;
                let msg = e.to_string();
                let source = script.src.as_deref().unwrap_or(url);
                // Classic scripts fetched cross-origin without CORS ("crossorigin") report muted errors.
                let muted = cross_origin_fetch && !script.module && {
                    let el = match (script.pending, script.jbid) {
                        (Some(p), _) => format!("__jb.pendingScriptEls[{p}]"),
                        (None, Some(j)) => format!("__jb.nodeById[{j}]"),
                        _ => "null".into(),
                    };
                    runtime::eval(&format!("(function (e) {{ return !(e && e.hasAttribute('crossorigin')); }})({el})"), "muted.js").map(|v| v == "true").unwrap_or(true)
                };
                let _ = runtime::eval(&format!("__jb.reportError({}, {}, {muted})", serde_json::to_string(&msg).unwrap_or_default(), serde_json::to_string(source).unwrap_or_default()), "report.js");
                if !is_harmless_error(&msg, script.module) {
                    exec.errors.push(msg);
                }
            }
        }
        // "Clean up after running script": the microtask checkpoint happens while the script is
        // still the document's currentScript (promise continuations of the script observe it).
        runtime::run_jobs();
        let _ = runtime::eval("__jb.endScript()", "end.js");
        if let Some(p) = script.pending {
            // Inline classic scripts fire no load event.
            let outcome = if loaded && script.src.is_none() { "null".to_string() } else { loaded.to_string() };
            let _ = runtime::eval(&format!("__jb.endPendingScript({p}, {outcome})"), "pending.js");
        } else if let Some(j) = script.jbid {
            // External classic scripts and all module scripts fire load.
            if script.module || script.src.is_some() {
                let _ = runtime::eval(&format!("__jb.scriptDone({j}, {loaded})"), "pending.js");
            }
        }
        runtime::run_jobs();
    }

    /// Run scripts that other scripts (or event handlers) inserted into the
    /// document, including any they insert in turn.
    fn run_pending_scripts(&mut self, exec: &mut JsExecution, url: &str) {
        loop {
            if self.page_run_count >= MAX_SCRIPTS_PER_PAGE || self.host_over_budget() {
                return;
            }
            let list = runtime::eval("__jb.takePendingScripts()", "pending.js").ok().and_then(|p| serde_json::from_str::<Vec<Value>>(&p).ok()).unwrap_or_default();
            if list.is_empty() {
                return;
            }
            // Scripts inserted together (tag managers, consent and ad loaders) download in
            // parallel; each was fetched only when its turn came (~0.5 s apiece on Coursera).
            if self.config.fetch_external_scripts {
                for item in &list {
                    let module = item.get("module").and_then(Value::as_bool).unwrap_or(false);
                    if let (false, Some(src)) = (module, item.get("src").and_then(Value::as_str)) {
                        if (src.starts_with("http://") || src.starts_with("https://")) && !is_ad_script(src) {
                            let headers = crate::http::fetch_metadata_headers("script", "no-cors", url, src);
                            self.client.prefetch_with(vec![src.to_string()], headers, self.config.request_timeout_secs);
                        }
                    }
                }
            }
            for item in list {
                let src = item.get("src").and_then(Value::as_str).map(|s| s.to_string());
                let code = item.get("code").and_then(Value::as_str).map(|s| s.to_string());
                let module = item.get("module").and_then(Value::as_bool).unwrap_or(false);
                let pending = item.get("pending").and_then(Value::as_u64).map(|p| p as usize);
                let blocking = item.get("blocking").and_then(Value::as_bool).unwrap_or(false);
                if code.is_some() || src.is_some() {
                    let script = ScriptSource { code, src, module, jbid: None, pending, deferred: false };
                    if self.parsing && script.src.is_some() && !blocking {
                        self.dynamic_deferred.push(script);
                    } else {
                        self.run_script(script, exec, url);
                    }
                }
            }
        }
    }

    /// Keep delivering WebSocket / EventSource events (and running timers they
    /// schedule) while connections are open, until they go idle or the time
    /// budget is spent.
    fn pump_network(&mut self) {
        let idle_limit = std::time::Duration::from_millis(self.config.network_idle_ms);
        let mut last_activity = std::time::Instant::now();
        let mut steps = 0usize;
        loop {
            if self.host_over_budget() || steps > self.config.max_timer_steps * 4 {
                break;
            }
            let has_streams = runtime::with_host(|h| h.has_open_streams()).unwrap_or(false);
            if !has_streams {
                break;
            }
            let events = runtime::with_host(|h| h.poll_network()).unwrap_or_default();
            if !events.is_empty() {
                last_activity = std::time::Instant::now();
                let json = serde_json::to_string(&events.iter().map(|e| e.to_json()).collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into());
                let _ = runtime::eval(&format!("__jb.deliverNetwork({json})"), "network.js");
                runtime::run_jobs();
            }
            // Let timers scheduled by handlers run.
            let ran = matches!(runtime::eval("__jb.runOneTimer()", "timers.js"), Ok(s) if s == "true");
            if ran {
                runtime::run_jobs();
                last_activity = std::time::Instant::now();
                steps += 1;
                continue;
            }
            if events.is_empty() {
                if last_activity.elapsed() > idle_limit {
                    break;
                }
                webapis::poll_sleep();
            }
        }
    }

    /// Deliver WebSocket/EventSource events that are available within `wait_ms` of real time.
    /// Returns whether any were delivered.
    fn deliver_network_events(&mut self, wait_ms: u64) -> bool {
        let started = std::time::Instant::now();
        loop {
            let events = runtime::with_host(|h| h.poll_network()).unwrap_or_default();
            if !events.is_empty() {
                let json = serde_json::to_string(&events.iter().map(|e| e.to_json()).collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into());
                let _ = runtime::eval(&format!("__jb.deliverNetwork({json})"), "network.js");
                runtime::run_jobs();
                return true;
            }
            if started.elapsed().as_millis() as u64 >= wait_ms || self.host_over_budget() {
                return false;
            }
            webapis::poll_sleep();
        }
    }

    fn host_over_budget(&self) -> bool {
        runtime::eval("__jb.hostJson(__jb.native('budget'))", "budget.js")
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("over").and_then(Value::as_bool))
            .unwrap_or(false)
    }

    fn drain_timers(&mut self, max_steps: usize, exec: &mut JsExecution, url: &str) {
        self.drain_timers_until(max_steps, "undefined", exec, url);
    }

    /// Run due timers whose virtual due time is at or before `limit_expr`
    /// (a JS expression evaluated once, e.g. `__jb.clock + 30`).
    fn drain_timers_until(&mut self, max_steps: usize, limit_expr: &str, exec: &mut JsExecution, url: &str) {
        let limit = runtime::eval(&format!("String({limit_expr})"), "limit.js").unwrap_or_else(|_| "undefined".into());
        let call = format!("__jb.runOneTimer({limit})");
        // Waiting for the network in real time (stream messages, async responses held for
        // ASYNC_FETCH_HOLD_SECS) is capped per drain: a page with a chat socket and polling
        // requests stretched one 2.5 s action settle to 10-14 s of wall time (student.com fill).
        let started = std::time::Instant::now();
        let net_cap = std::time::Duration::from_millis(if limit == "undefined" { LOAD_NET_WAIT_MS } else { SETTLE_NET_WAIT_MS });
        let mut net_capped = false;
        let mut idle = false;
        for _ in 0..max_steps {
            if self.host_over_budget() {
                break;
            }
            if !net_capped && started.elapsed() >= net_cap {
                net_capped = true;
                let _ = runtime::eval("__jb.noNetHold = true", "timers.js");
            }
            // WebSocket/EventSource messages are tasks too: deliver the ones that arrived, and
            // while the next timer lies in the (virtual) future, give the network real time to
            // answer first, so a message is not overtaken by a timer that would fire later.
            if runtime::with_host(|h| h.has_open_streams()).unwrap_or(false) {
                let delay = runtime::eval("String(__jb.nextTimerDelay())", "timers.js").ok().and_then(|s| s.parse::<f64>().ok()).unwrap_or(-1.0);
                let wait = if delay > 0.0 && !net_capped { delay.min(1500.0) as u64 } else { 0 };
                if self.deliver_network_events(wait) {
                    self.run_pending_scripts(exec, url);
                    continue;
                }
            }
            let task_start = std::time::Instant::now();
            let result = runtime::eval(&call, "timers.js");
            if task_start.elapsed().as_millis() >= 1000 && std::env::var_os("JB_TRACE_JS").is_some() {
                let what = runtime::eval("(function(f){ return typeof f === 'function' ? 'function ' + (f.name || '(anonymous)') + ': ' + String(f).slice(0, 160) : String(f).slice(0, 160); })(__jb.lastTimerDesc)", "trace.js").unwrap_or_default();
                eprintln!("[js] slow task {} ms: {what}", task_start.elapsed().as_millis());
            }
            match result {
                Ok(s) if s == "true" => {
                    runtime::run_jobs();
                    self.run_pending_scripts(exec, url);
                }
                Err(e) => {
                    if std::env::var_os("JB_TRACE_JS").is_some() {
                        eprintln!("[js] timer loop stopped: {e}");
                    }
                    if !runtime::is_termination(&e.to_string()) {
                        exec.errors.push(format!("timer loop: {e}"));
                    }
                    break;
                }
                _ => {
                    idle = true;
                    break;
                }
            }
        }
        // nothing was due before the limit: that much page time passed (the clock otherwise only
        // moves to timers that fire, and a timer more than one settle ahead never came due)
        if idle && limit != "undefined" && limit.parse::<f64>().is_ok() {
            let _ = runtime::eval(&format!("(__jb.clock < {limit} && (__jb.clock = {limit}), null)"), "timers.js");
        }
        if net_capped {
            let _ = runtime::eval("__jb.noNetHold = false", "timers.js");
        }
        runtime::run_jobs();
    }

    /// Collect modifications, rebuild `doc` from the live DOM, and fold host
    /// state into `exec`.
    fn finish(&mut self, doc: &mut Document, exec: &mut JsExecution) {
        let trace = std::env::var_os("JB_TRACE_JS").is_some();
        let t0 = std::time::Instant::now();
        // local storage writes are batched while scripts run (see storage.rs)
        runtime::with_host(|h| h.storage.flush());
        if let Ok(raw) = runtime::eval("__jb.collectModifications()", "collect.js") {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                if let Some(updates) = v.get("updates").and_then(Value::as_array) {
                    exec.dom_updates = updates.iter().filter_map(|u| serde_json::from_value(u.clone()).ok()).collect();
                }
                exec.title = v.get("title").and_then(Value::as_str).map(|s| s.to_string());
                exec.navigations = v.get("navigations").and_then(|n| serde_json::from_value(n.clone()).ok()).unwrap_or_default();
                exec.form_submissions = v.get("formSubmissions").and_then(|n| serde_json::from_value(n.clone()).ok()).unwrap_or_default();
                exec.dialogs = v.get("dialogs").and_then(|n| serde_json::from_value(n.clone()).ok()).unwrap_or_default();
                exec.cookies_set = v.get("cookies").and_then(|n| serde_json::from_value(n.clone()).ok()).unwrap_or_default();
                exec.pending_timers = v.get("pendingTimers").and_then(Value::as_u64).unwrap_or(0) as usize;
                exec.canvas_text = v.get("canvasText").and_then(|n| serde_json::from_value(n.clone()).ok()).unwrap_or_default();
                exec.open_connections = v.get("openConnections").and_then(Value::as_u64).unwrap_or(0) as usize;
                exec.final_url = v.get("url").and_then(Value::as_str).map(|s| s.to_string());
            }
        }
        if let Some(report) = runtime::with_host(|h| h.take_report()) {
            exec.console.extend(report.console);
            exec.errors.extend(report.errors);
            exec.api_calls = report.api_calls;
            exec.notifications = report.notifications;
            exec.websocket_messages = report.websocket_messages;
        }
        let t1 = std::time::Instant::now();
        self.sync_document(doc);
        let t2 = std::time::Instant::now();
        runtime::gc();
        if trace && t0.elapsed().as_millis() >= 100 {
            eprintln!("[js] finish {} ms: collect {} ms, sync {} ms, gc {} ms", t0.elapsed().as_millis(), (t1 - t0).as_millis(), (t2 - t1).as_millis(), t2.elapsed().as_millis());
        }
    }

    /// [`Self::finish`] without the document export, subtree updates, title walk and full GC
    /// (`defer_dom_sync`): the Rust document is marked stale.
    fn finish_deferred(&mut self, exec: &mut JsExecution) {
        runtime::with_host(|h| h.storage.flush());
        if let Ok(raw) = runtime::eval("__jb.collectModifications(true)", "collect.js") {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                exec.navigations = v.get("navigations").and_then(|n| serde_json::from_value(n.clone()).ok()).unwrap_or_default();
                exec.form_submissions = v.get("formSubmissions").and_then(|n| serde_json::from_value(n.clone()).ok()).unwrap_or_default();
                exec.dialogs = v.get("dialogs").and_then(|n| serde_json::from_value(n.clone()).ok()).unwrap_or_default();
                exec.cookies_set = v.get("cookies").and_then(|n| serde_json::from_value(n.clone()).ok()).unwrap_or_default();
                exec.pending_timers = v.get("pendingTimers").and_then(Value::as_u64).unwrap_or(0) as usize;
                exec.canvas_text = v.get("canvasText").and_then(|n| serde_json::from_value(n.clone()).ok()).unwrap_or_default();
                exec.open_connections = v.get("openConnections").and_then(Value::as_u64).unwrap_or(0) as usize;
                exec.final_url = v.get("url").and_then(Value::as_str).map(|s| s.to_string());
            }
        }
        if let Some(report) = runtime::with_host(|h| h.take_report()) {
            exec.console.extend(report.console);
            exec.errors.extend(report.errors);
            exec.api_calls = report.api_calls;
            exec.notifications = report.notifications;
            exec.websocket_messages = report.websocket_messages;
        }
        self.dom_stale = true;
    }

    /// Bring `doc` up to date with the JS document if live scripts left it stale.
    pub fn sync_if_stale(&mut self, doc: &mut Document) {
        if self.dom_stale {
            self.sync_document(doc);
        }
    }

    /// Replace `doc` with the JS document (structurally exported) and refresh
    /// the id map so later interactions address the same nodes.
    fn sync_document(&mut self, doc: &mut Document) {
        self.dom_stale = false;
        if let Ok(raw) = runtime::eval("__jb.exportDom()", "export.js") {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                let (new_doc, map) = dom::document_from_json(&v);
                *doc = new_doc;
                self.node_map = map;
            }
        }
    }

    /// Apply JS-side subtree updates to the Rust document.
    pub fn apply_dom_updates(&self, doc: &mut Document, updates: &[DomUpdate]) {
        for update in updates {
            let node = match update.id.and_then(|i| self.node_map.get(i)).copied() {
                Some(n) => n,
                None => continue,
            };
            if doc.tree.get(node).is_none() {
                continue;
            }
            dom::set_inner_html(doc, node, &update.html);
            // `attrs` is the element's complete attribute list.
            dom::clear_attrs(doc, node);
            for (name, value) in &update.attrs {
                dom::set_attr(doc, node, name, value);
            }
        }
    }

    /// Execute arbitrary JavaScript against `url`'s page. If that page's realm
    /// is live (it was just loaded with `run_page`, or an earlier interaction
    /// kept it alive) the script runs in it, so listeners and application
    /// state persist; otherwise the document is mirrored into a fresh realm.
    pub fn execute_script(&mut self, script: &str, doc: Option<&mut Document>, url: &str) -> JsExecution {
        let mut exec = JsExecution::default();
        if let Err(e) = self.ensure_env() {
            exec.errors.push(e.to_string());
            return exec;
        }
        let mut scratch;
        let doc: &mut Document = match doc {
            Some(d) => d,
            None => {
                scratch = dom::parse_document("<html><head></head><body></body></html>");
                &mut scratch
            }
        };
        let live = self.is_live(url);
        if live {
            // Keep the host (cookies, storage, open sockets) but restart budgets.
            runtime::with_host(|h| h.restart_budget());
        } else {
            self.ensure_host(Some(url));
            if let Err(e) = self.load_document(doc, url) {
                exec.errors.push(e.to_string());
                self.finish(doc, &mut exec);
                return exec;
            }
        }
        runtime::set_deadline(Some(std::time::Duration::from_millis(self.config.time_budget_ms.max(1000))));
        // Evaluate inside a block so repeated interactions can re-declare
        // let/const bindings (as a devtools console does).
        let wrapped = format!("{{
{}
}}", clean_script(script));
        match runtime::eval(&wrapped, "script.js") {
            Ok(v) => exec.result = Some(v),
            Err(e) => {
                exec.scripts_failed += 1;
                exec.errors.push(e.to_string());
            }
        }
        exec.scripts_run += 1;
        runtime::run_jobs();
        self.page_run_count = 0;
        self.run_pending_scripts(&mut exec, url);
        match self.config.action_settle_ms {
            // A bounded settle may run many more (tiny) tasks than the step cap: FedEx's sensor
            // queues setTimeout(0) tasks per input event (~1,300 after typing a ZIP, ~3,300 for
            // "Dallas, TX 75201"), so the address
            // autocomplete's 300 ms debounce timer only came due one or two actions later and the
            // suggestions always lagged. The virtual-time limit, the 4 ms nested-timer clamp and
            // the script budget still bound the drain.
            Some(ms) => {
                let steps = if self.config.max_timer_steps == 0 { 0 } else { self.config.max_timer_steps.max(ACTION_SETTLE_TIMER_STEPS) };
                self.drain_timers_until(steps, &format!("__jb.clock + {ms}"), &mut exec, url)
            }
            None => self.drain_timers(self.config.max_timer_steps, &mut exec, url),
        }
        self.pump_network();
        let stopped = runtime::set_deadline(None);
        runtime::profile_report("live script");
        if stopped > 0 {
            exec.errors.push(format!("script stopped: the time budget of {} ms ran out", self.config.time_budget_ms));
        }
        if live && self.defer_dom_sync {
            self.finish_deferred(&mut exec);
        } else {
            self.finish(doc, &mut exec);
        }
        self.live_url = Some(url.to_string());
        exec
    }

    /// Evaluate an expression against the current JS document and return it as JSON.
    pub fn eval_js(&mut self, expression: &str) -> Value {
        if let Err(e) = self.ensure_env() {
            return json!({"error": e.to_string()});
        }
        let wrapped = format!("__jb.evalResult(function(){{ return ({}); }})", expression);
        match runtime::eval(&wrapped, "eval.js") {
            Ok(s) => {
                if s == "undefined" {
                    Value::Null
                } else {
                    serde_json::from_str(&s).unwrap_or(Value::String(s))
                }
            }
            Err(e) => json!({"error": e.to_string()}),
        }
    }

    /// Alias for [`eval_js`].
    pub fn evaluate_expression(&mut self, expression: &str) -> Value {
        self.eval_js(expression)
    }

    /// Serialise the JS-side document (after script execution).
    pub fn current_html(&mut self) -> Option<String> {
        runtime::eval("__jb.serializeDocument()", "serialize.js").ok()
    }

    /// Reset the JavaScript context (fresh global + environment).
    pub fn reset_context(&mut self) {
        runtime::reset_global();
        self.env_loaded = false;
        self.node_map.clear();
        self.live_url = None;
    }
}


/// Serialise a document to the compact JSON the JS side rebuilds, assigning a
/// sequential id to every element. Returns (json, id -> NodeId).
///
/// Node records: `{t, i?, n?, a?, c?}` element (`n`: 1 = SVG, 2 = MathML,
/// attrs `[qname, value, ns?]`), `{x}` text, `{m}` comment,
/// `{d, p, s}` doctype, `{pi, x}` processing instruction, `{f: 1, c}` template
/// contents fragment.
pub fn serialize_document(doc: &Document) -> (String, Vec<NodeId>) {
    let mut map = Vec::new();
    let root = doc.tree.root();
    let children: Vec<Value> = root.children().filter_map(|c| serialize_node(doc, c.id(), &mut Some(&mut map))).collect();
    let quirks = matches!(doc.quirks_mode, html5ever::tree_builder::QuirksMode::Quirks);
    (json!({"c": children, "q": quirks}).to_string(), map)
}

/// Serialise a subtree without assigning ids (fragments parsed for `innerHTML`).
pub fn serialize_children(doc: &Document, id: NodeId) -> Value {
    let children: Vec<Value> = match doc.tree.get(id) {
        Some(node) => node.children().filter_map(|c| serialize_node(doc, c.id(), &mut None)).collect(),
        None => Vec::new(),
    };
    json!({"c": children})
}

fn serialize_node(doc: &Document, id: NodeId, map: &mut Option<&mut Vec<NodeId>>) -> Option<Value> {
    use html5ever::ns;
    let node = doc.tree.get(id)?;
    match node.value() {
        scraper::Node::Text(t) => Some(json!({"x": t.to_string()})),
        scraper::Node::Comment(c) => Some(json!({"m": c.to_string()})),
        scraper::Node::Doctype(d) => Some(json!({"d": d.name().to_string(), "p": d.public_id().to_string(), "s": d.system_id().to_string()})),
        scraper::Node::ProcessingInstruction(pi) => Some(json!({"pi": pi.target.to_string(), "x": pi.data.to_string()})),
        scraper::Node::Fragment => {
            let children: Vec<Value> = node.children().filter_map(|c| serialize_node(doc, c.id(), map)).collect();
            Some(json!({"f": 1, "c": children}))
        }
        scraper::Node::Element(el) => {
            let mut obj = json!({"t": el.name.local.to_string()});
            if let Some(m) = map.as_deref_mut() {
                obj["i"] = json!(m.len());
                m.push(id);
            }
            if el.name.ns == ns!(svg) {
                obj["n"] = json!(1);
            } else if el.name.ns == ns!(mathml) {
                obj["n"] = json!(2);
            }
            let attrs: Vec<Value> = el
                .attrs
                .iter()
                .map(|(name, value)| {
                    // html5ever gives `xmlns` on foreign elements an empty prefix.
                    let qname = match &name.prefix {
                        Some(p) if !p.is_empty() => format!("{p}:{}", name.local),
                        _ => name.local.to_string(),
                    };
                    if name.ns.is_empty() {
                        json!([qname, value.to_string()])
                    } else {
                        json!([qname, value.to_string(), name.ns.to_string()])
                    }
                })
                .collect();
            if !attrs.is_empty() {
                obj["a"] = Value::Array(attrs);
            }
            let children: Vec<Value> = node.children().filter_map(|c| serialize_node(doc, c.id(), map)).collect();
            if !children.is_empty() {
                obj["c"] = Value::Array(children);
            }
            Some(obj)
        }
        _ => None,
    }
}

/// Parse `html` with html5ever and return the JSON node records for the
/// JS side. `context` is the tag name of the element whose `innerHTML` is
/// being set (`ns`: "html", "svg" or "math"); `None` parses a full document.
pub fn parse_html_to_json(html: &str, context: Option<(&str, &str)>) -> Value {
    parse_html_to_json_opts(html, context, true)
}

/// `parse_html_to_json` with the parser's scripting flag (off for documents
/// without a browsing context: `<noscript>` content is then parsed as markup).
pub fn parse_html_to_json_opts(html: &str, context: Option<(&str, &str)>, scripting: bool) -> Value {
    use html5ever::tendril::TendrilSink;
    use html5ever::{ns, LocalName, QualName};
    let opts = html5ever::ParseOpts { tree_builder: html5ever::tree_builder::TreeBuilderOpts { scripting_enabled: scripting, ..Default::default() }, ..Default::default() };
    match context {
        None => {
            let doc = if scripting { dom::parse_document(html) } else { html5ever::driver::parse_document(scraper::HtmlTreeSink::new(Document::new_document()), opts).one(html) };
            let root = doc.tree.root().id();
            let mut v = serialize_children(&doc, root);
            v["q"] = Value::Bool(matches!(doc.quirks_mode, html5ever::tree_builder::QuirksMode::Quirks));
            v
        }
        Some((tag, nsname)) => {
            let ns = match nsname {
                "svg" => ns!(svg),
                "math" => ns!(mathml),
                _ => ns!(html),
            };
            let sink = scraper::HtmlTreeSink::new(Document::new_fragment());
            let parser = html5ever::driver::parse_fragment(sink, opts, QualName::new(None, ns, LocalName::from(tag)), Vec::new(), false);
            let frag = parser.one(html);
            // The fragment tree is Fragment -> <html> (synthetic context root) -> content.
            let root = frag.tree.root();
            let content_root = root.children().find(|c| c.value().is_element()).map(|c| c.id()).unwrap_or(root.id());
            serialize_children(&frag, content_root)
        }
    }
}

/// Remove HTML comment wrappers / CDATA markers that legacy pages put inside
/// `<script>` bodies. Unlike the Python port we do not rewrite modern syntax:
/// SpiderMonkey runs it natively.
/// Upper bound on scripts executed for one page (runaway loaders).
const MAX_SCRIPTS_PER_PAGE: usize = 400;

/// HTML "prepare the script element" type check: `Some(is_module)` for
/// scripts that run, `None` for data blocks (JSON-LD, templates, import maps).
pub fn script_kind(ty: Option<&str>, language: Option<&str>) -> Option<bool> {
    let t = match (ty, language) {
        (Some(""), _) | (None, None) | (None, Some("")) => "text/javascript".to_string(),
        (Some(t), _) => t.trim_matches(|c| matches!(c, '\t' | '\n' | '\x0c' | '\r' | ' ')).to_ascii_lowercase(),
        (None, Some(l)) => format!("text/{}", l.to_ascii_lowercase()),
    };
    if t == "module" {
        return Some(true);
    }
    if crate::http::is_javascript_mime(&t) {
        Some(false)
    } else {
        None
    }
}

pub fn clean_script(script: &str) -> String {
    // Scripts run as written: `<!--`/`-->` are JavaScript (Annex B) comments in
    // classic scripts, and CDATA markers inside string literals are data.
    script.to_string()
}

/// Errors that are expected in a headless environment and not worth surfacing.
pub fn is_harmless_error(msg: &str, module: bool) -> bool {
    let lower = msg.to_lowercase();
    if module && (lower.contains("import") || lower.contains("export")) {
        return true;
    }
    const PATTERNS: &[&str] = &[
        "redeclaration of",
        "import declarations may only appear",
        "export declarations may only appear",
        "can't access property \"enqueue\"",
        "window.__re",
        "is not a function",
        "is undefined",
        "is null",
    ];
    PATTERNS.iter().any(|p| lower.contains(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> JavaScriptEngine {
        let mut e = JavaScriptEngine::new(HttpClient::new(None));
        e.set_ephemeral_storage();
        e
    }

    #[test]
    fn runs_inline_scripts_and_applies_dom_changes() {
        let mut doc = dom::parse_document(
            r#"<html><head><title>T</title></head><body><div id="root">old</div><script>document.getElementById('root').innerHTML='<p>Hello <b>JS</b></p>'; document.title='New'; console.log('hi');</script></body></html>"#,
        );
        let mut e = engine();
        let exec = e.run_page(&mut doc, "https://example.com/", None);
        assert_eq!(exec.scripts_run, 1, "{:?}", exec.errors);
        assert!(exec.console.iter().any(|l| l.contains("hi")));
        let root = dom::find_by_id(&doc, "root").unwrap();
        assert_eq!(dom::get_text_stripped(&doc, root), "Hello JS");
        assert_eq!(dom::title(&doc).as_deref(), Some("New"));
    }

    #[test]
    fn timers_promises_and_custom_elements() {
        let mut doc = dom::parse_document(
            r#"<html><body><my-widget></my-widget><ul id="l"></ul><script>
            class W extends HTMLElement { connectedCallback(){ this.innerHTML = '<span>widget</span>'; } }
            customElements.define('my-widget', W);
            const l = document.getElementById('l');
            Promise.resolve(['a','b']).then(xs => xs.forEach(x => { const li = document.createElement('li'); li.textContent = x; l.appendChild(li); }));
            setTimeout(() => { const li = document.createElement('li'); li.textContent = 'later'; l.appendChild(li); }, 50);
            </script></body></html>"#,
        );
        let mut e = engine();
        let exec = e.run_page(&mut doc, "https://example.com/", None);
        assert!(exec.errors.is_empty(), "{:?}", exec.errors);
        let items: Vec<String> = dom::find_all(&doc, &["li"]).into_iter().map(|i| dom::get_text_stripped(&doc, i)).collect();
        assert_eq!(items, vec!["a", "b", "later"]);
        let w = dom::find_first(&doc, "my-widget").unwrap();
        assert_eq!(dom::get_text_stripped(&doc, w), "widget");
    }

    #[test]
    fn eval_returns_json() {
        let mut e = engine();
        let v = e.eval_js("({a: 1 + 1, b: 'x'})");
        assert_eq!(v["a"], 2);
    }

    /// Run a script against a blank page and return the JSON-serialised value of
    /// `window.__result` once timers, promises and network events have settled.
    fn run_and_collect(e: &mut JavaScriptEngine, script: &str, url: &str) -> (Value, JsExecution) {
        let mut doc = dom::parse_document("<html><head></head><body></body></html>");
        let exec = e.execute_script(script, Some(&mut doc), url);
        let v = e.eval_js("window.__result");
        (v, exec)
    }

    #[test]
    fn webcrypto_known_answers() {
        let mut e = engine();
        let (v, exec) = run_and_collect(
            &mut e,
            r#"
            const enc = new TextEncoder();
            const hex = b => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
            window.__result = {};
            crypto.subtle.digest('SHA-256', enc.encode('abc')).then(h => { __result.sha256 = hex(h); });
            crypto.subtle.digest('SHA-1', enc.encode('abc')).then(h => { __result.sha1 = hex(h); });
            crypto.subtle.importKey('raw', enc.encode('key'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
              .then(k => crypto.subtle.sign('HMAC', k, enc.encode('The quick brown fox jumps over the lazy dog')).then(s => { __result.hmac = hex(s); return crypto.subtle.verify('HMAC', k, s, enc.encode('The quick brown fox jumps over the lazy dog')); }))
              .then(ok => { __result.verified = ok; });
            const iv = new Uint8Array(12);
            crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
              .then(k => crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode('secret message')).then(ct => { __result.ctLen = ct.byteLength; return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct); }))
              .then(pt => { __result.roundtrip = new TextDecoder().decode(pt); });
            crypto.subtle.importKey('raw', enc.encode('password'), 'PBKDF2', false, ['deriveBits'])
              .then(k => crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode('salt'), iterations: 1, hash: 'SHA-256' }, k, 256))
              .then(b => { __result.pbkdf2 = hex(b); });
            const u = new Uint8Array(8); crypto.getRandomValues(u); __result.random = Array.from(u).some(x => x !== 0);
            __result.uuid = /^[0-9a-f-]{36}$/.test(crypto.randomUUID());
            "#,
            "https://example.com/",
        );
        assert!(exec.errors.is_empty(), "{:?}", exec.errors);
        assert_eq!(v["sha256"], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(v["sha1"], "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(v["hmac"], "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
        assert_eq!(v["verified"], true);
        assert_eq!(v["ctLen"], 14 + 16);
        assert_eq!(v["roundtrip"], "secret message");
        assert_eq!(v["pbkdf2"], "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b");
        assert_eq!(v["random"], true);
        assert_eq!(v["uuid"], true);
    }

    #[test]
    fn cookies_blob_compression_and_clone() {
        let mut e = engine();
        let (v, exec) = run_and_collect(
            &mut e,
            r#"
            window.__result = {};
            document.cookie = 'session=abc123; path=/';
            document.cookie = 'theme=dark';
            __result.cookie = document.cookie;
            cookieStore.getAll().then(all => { __result.cookieNames = all.map(c => c.name).sort(); });
            const blob = new Blob([new Uint8Array([0, 255, 128]), 'é'], { type: 'application/octet-stream' });
            __result.blobSize = blob.size;
            blob.arrayBuffer().then(b => { __result.blobBytes = Array.from(new Uint8Array(b)); });
            const fr = new FileReader(); fr.onload = () => { __result.dataUrl = fr.result; }; fr.readAsDataURL(new Blob(['hi'], { type: 'text/plain' }));
            new Response(new Blob(['hello hello hello hello']).stream().pipeThrough(new CompressionStream('gzip')).pipeThrough(new DecompressionStream('gzip'))).text().then(t => { __result.gzip = t; });
            const src = { d: new Date(0), m: new Map([['k', { n: 1 }]]), s: new Set([1, 2]), a: new Uint8Array([9]) };
            const c = structuredClone(src);
            __result.clone = c.d instanceof Date && c.m.get('k').n === 1 && c.m.get('k') !== src.m.get('k') && c.s.has(2) && c.a[0] === 9;
            const ctx = document.createElement('canvas').getContext('2d'); ctx.fillText('drawn text', 1, 2);
            new Notification('Title', { body: 'Body' });
            "#,
            "https://example.com/",
        );
        assert!(exec.errors.is_empty(), "{:?}", exec.errors);
        let mut cookies: Vec<&str> = v["cookie"].as_str().unwrap().split("; ").collect();
        cookies.sort();
        assert_eq!(cookies, vec!["session=abc123", "theme=dark"]);
        assert_eq!(v["cookieNames"], json!(["session", "theme"]));
        assert_eq!(v["blobSize"], 5);
        assert_eq!(v["blobBytes"], json!([0, 255, 128, 195, 169]));
        assert_eq!(v["dataUrl"], "data:text/plain;base64,aGk=");
        assert_eq!(v["gzip"], "hello hello hello hello");
        assert_eq!(v["clone"], true);
        assert_eq!(exec.canvas_text, vec!["drawn text"]);
        assert_eq!(exec.notifications.len(), 1);
        assert_eq!(exec.notifications[0].title, "Title");
        // The cookie landed in the real jar used for HTTP requests.
        assert!(e.client.cookies_for("https://example.com/", false).contains("session=abc123"));
    }

    #[test]
    fn indexeddb_persists_across_pages() {
        let mut e = engine();
        let (_, exec) = run_and_collect(
            &mut e,
            r#"
            const req = indexedDB.open('appdb', 1);
            req.onupgradeneeded = () => { req.result.createObjectStore('items', { keyPath: 'id' }); };
            req.onsuccess = () => { const tx = req.result.transaction('items', 'readwrite'); tx.objectStore('items').put({ id: 7, name: 'seven' }); };
            "#,
            "https://example.com/",
        );
        assert!(exec.errors.is_empty(), "{:?}", exec.errors);
        let (v, exec) = run_and_collect(
            &mut e,
            r#"
            window.__result = {};
            const req = indexedDB.open('appdb', 1);
            req.onupgradeneeded = () => { __result.upgraded = true; };
            req.onsuccess = () => { const g = req.result.transaction('items').objectStore('items').get(7); g.onsuccess = () => { __result.name = g.result && g.result.name; }; };
            "#,
            "https://example.com/",
        );
        assert!(exec.errors.is_empty(), "{:?}", exec.errors);
        assert_eq!(v["name"], "seven");
        assert!(v.get("upgraded").is_none(), "database should already exist");
    }

    #[test]
    fn geolocation_and_permissions_follow_config() {
        let mut e = engine();
        e.config.geolocation = Some(Geolocation { latitude: 51.5, longitude: -0.12, accuracy: 20.0 });
        e.config.notification_permission = "granted".into();
        let (v, _) = run_and_collect(
            &mut e,
            r#"
            window.__result = {};
            navigator.geolocation.getCurrentPosition(p => { __result.lat = p.coords.latitude; }, () => { __result.lat = 'denied'; });
            navigator.permissions.query({ name: 'geolocation' }).then(s => { __result.geoState = s.state; });
            __result.notif = Notification.permission;
            "#,
            "https://example.com/",
        );
        assert_eq!(v["lat"], 51.5);
        assert_eq!(v["geoState"], "granted");
        assert_eq!(v["notif"], "granted");
    }

    /// Live network: echo WebSocket + binary fetch. Ignored by default.
    #[test]
    #[ignore]
    fn live_websocket_and_binary_fetch() {
        let mut e = engine();
        let (v, exec) = run_and_collect(
            &mut e,
            r#"
            window.__result = { messages: [] };
            const ws = new WebSocket('wss://ws.ifelse.io');
            ws.onopen = () => { __result.opened = true; ws.send('ping-1'); ws.send('ping-2'); };
            ws.onmessage = e => { __result.messages.push(e.data); if (__result.messages.length >= 3) ws.close(); };
            ws.onclose = e => { __result.closed = e.code; };
            fetch('https://httpbin.org/image/png').then(r => r.arrayBuffer()).then(b => { const u = new Uint8Array(b); __result.png = u[0] === 0x89 && u[1] === 0x50; });
            "#,
            "https://example.com/",
        );
        assert!(exec.errors.is_empty(), "{:?}", exec.errors);
        assert_eq!(v["opened"], true);
        assert!(v["messages"].as_array().unwrap().iter().any(|m| m == "ping-1"), "{v}");
        assert_eq!(v["png"], true);
        assert!(exec.websocket_messages >= 2);
    }
}

/// Real time one timer drain (an action's settle) may spend waiting for the network.
const SETTLE_NET_WAIT_MS: u64 = 2500;
/// The same for a drain without a time limit (a page load, frame loads).
const LOAD_NET_WAIT_MS: u64 = 5000;
/// Timer steps an action's bounded settle may run (the virtual-time limit ends it first normally).
const ACTION_SETTLE_TIMER_STEPS: usize = 10_000;
