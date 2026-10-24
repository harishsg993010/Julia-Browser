# Rust library

```rust
use julia_browser::{AgentSdk, BrowserSdk};
use serde_json::json;

// Rendering
let mut sdk = BrowserSdk::default();
let page = sdk.render_to_markdown("https://example.com", true, None);
println!("{}", page.content.unwrap_or_default());

// Agent workflow
let mut agent = AgentSdk::default();
agent.proxy_start();
agent.proxy_add_rule(&json!({
    "name": "auth", "type": "request",
    "match": {"url_contains": "api"},
    "actions": {"set_headers": {"Authorization": "Bearer token"}}
}));
agent.open_website("https://httpbin.org/forms/post");
println!("{}", agent.list_elements()["summary"]);
agent.type_text(1, "Ada");
let result = agent.submit_form();
println!("{}", result["content"]);
```

`cargo run --example agent_demo` runs a longer example (`examples/agent_demo.rs`).

## AgentSdk

Every call returns a JSON object:

- Pages: `open_website`, `get_page_info`, `search_page`, `execute_javascript`
- Numbered elements: `list_elements`, `click_element`, `type_text`, `submit_form`, `follow_link`
- Selectors: `act(action, target, value)` and `wait_for(selector)`
- Scrolling and output: the scroll calls, `view_layout`, `screenshot(clip)` (PNG, base64)
- Proxy: the `proxy_*` family

## JsConfig

`JsConfig` controls script execution:

- Request budget (`max_requests`) and per-request timeout
- Total time budget (`time_budget_ms`) and the ad-script budget
- Timer steps and `network_idle_ms`
- Whether external scripts are fetched, and console echoing

Pass it with `AgentSdk::with_js_config` or `BrowserSdk::with_js_config`. The CLI flags in
[Configuration](configuration.md) map onto it.

## Intercepting proxy

Rules are declarative JSON or Rust closures:

- Matchers: `url_contains`, `method`, `header_equals`, ...
- Actions: `set_headers`, `rewrite_url`, `find_replace`, `block_request`, ...

The traffic log has filters and statistics. The same proxy is available in interactive mode
(`proxy start|stop|status|traffic|rules|rule <json>`).

## Modules

| Module | Role |
| --- | --- |
| `engine` | HTTP (through the proxy), parsing, JavaScript execution, navigation state |
| `js` | SpiderMonkey runtime, native bridge, browser environment (`src/js/env/*.js`) |
| `layout` | blitz-dom layout, visual order, character-cell view, screenshots |
| `renderer`, `markdown`, `content_filter` | HTML → Markdown pipeline |
| `css_parser`, `extractors` | CSS rules and technical content extraction |
| `forms`, `agent`, `sdk`, `cli` | Interaction model, SDKs and the terminal UI |
| `http` | HTTP client: cookies, redirects, fetch metadata, referrer policy, prefetching |
| `proxy` | Intercepting proxy |
| `cdp` | Chrome DevTools Protocol server |
| `session` | Persistent agent sessions behind the agent commands |
| `vault` | Encrypted password and passkey vault |
