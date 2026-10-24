//! # Julia Browser
//!
//! A command-line web browser with real JavaScript execution (Mozilla
//! SpiderMonkey), HTML → markdown rendering, an AI agent SDK and a Burp-style
//! intercepting proxy.
//!
//! ```no_run
//! use julia_browser::AgentSdk;
//!
//! let mut agent = AgentSdk::default();
//! let page = agent.open_website("https://example.com");
//! println!("{}", page["title"]);
//! let elements = agent.list_elements();
//! println!("{}", elements["summary"]);
//! ```

#[cfg(all(windows, target_env = "msvc"))]
pub mod msvc_compat;

pub mod agent;
#[cfg(feature = "images")]
pub mod avif;
#[cfg(feature = "canvas")]
pub mod canvas;
pub mod cdp;
pub mod colorspace;
pub mod cli;
pub mod content_filter;
pub mod csp;
pub mod css_parser;
pub mod dom;
pub mod engine;
pub mod extractors;
pub mod forms;
pub mod http;
pub mod js;
pub mod layout;
pub mod markdown;
pub mod proxy;
pub mod renderer;
pub mod sdk;
pub mod session;
pub mod terminal;
pub mod vault;

pub use agent::AgentSdk;
pub use cli::CliBrowser;
pub use engine::BrowserEngine;
pub use js::{JavaScriptEngine, JsConfig};
pub use proxy::ProxyServer;
pub use renderer::HtmlRenderer;
pub use sdk::BrowserSdk;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
