//! CLI Interface - `browse`, `render`, `interactive` commands and the
//! interactive browsing session.

use crate::dom::{self, Document};
use crate::forms::{self, ButtonInfo, InputInfo};
use crate::http;
use crate::js::JsConfig;
use crate::sdk::{BrowserSdk, SdkResult};
use crate::terminal as term;
use clap::{Args, Parser, Subcommand, ValueEnum};
use console::style;
use dialoguer::{Confirm, Input};
use std::collections::BTreeMap;
use std::time::Instant;

#[derive(Parser, Debug)]
#[command(name = "julia-browser", version, about = "🌐 Julia Browser - a command-line web browser with SpiderMonkey JavaScript support", long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Clone, Copy, Debug, ValueEnum, PartialEq, Eq)]
pub enum Format {
    Markdown,
    Text,
    Html,
    Json,
    /// The laid-out page as character cells (needs the `layout` feature)
    Layout,
    /// A PNG screenshot, written with -o (needs the `screenshot` feature)
    Png,
}

/// Options of `--format layout`.
#[derive(Args, Debug, Clone)]
pub struct LayoutArgs {
    /// Character cells across the page width (--format layout)
    #[arg(long, default_value_t = 160)]
    pub cols: usize,
    /// Label boxes that have an id with #id (--format layout)
    #[arg(long)]
    pub annotate: bool,
    /// CSS selector of the element to capture (--format png)
    #[arg(long, value_name = "SELECTOR")]
    pub clip: Option<String>,
    /// Device pixels per CSS pixel (--format png)
    #[arg(long, default_value_t = 1.0)]
    pub scale: f64,
    /// Capture one viewport (720 px) instead of the whole page (--format png)
    #[arg(long)]
    pub viewport_only: bool,
}

impl LayoutArgs {
    pub fn to_options(&self) -> crate::layout::TextOptions {
        crate::layout::TextOptions { cols: self.cols, annotate: self.annotate, ..Default::default() }
    }

    pub fn to_screenshot_options(&self) -> crate::layout::ScreenshotOptions {
        crate::layout::ScreenshotOptions { scale: self.scale.max(0.1), full_page: !self.viewport_only, ..Default::default() }
    }
}

/// JavaScript / Web API options shared by all commands.
#[derive(Args, Debug, Clone, Default)]
pub struct JsArgs {
    /// Disable JavaScript execution
    #[arg(long = "no-javascript", alias = "no-js", global = true)]
    pub no_javascript: bool,
    /// Do not download and run external <script src> files (they run by default)
    #[arg(long, global = true, alias = "no-external-scripts")]
    pub no_external_js: bool,
    /// Deprecated: external scripts are loaded by default now.
    #[arg(long, global = true, hide = true)]
    pub external_js: bool,
    /// Print JavaScript console output as it happens
    #[arg(long, global = true)]
    pub js_console: bool,
    /// Block WebSocket / EventSource connections from page scripts
    #[arg(long, global = true)]
    pub no_websockets: bool,
    /// Let pages read/write the OS clipboard via navigator.clipboard
    #[arg(long, global = true)]
    pub allow_clipboard: bool,
    /// Position reported to navigator.geolocation, as "lat,lon" (default: permission denied)
    #[arg(long, global = true, value_name = "LAT,LON")]
    pub geolocation: Option<String>,
    /// Notification.permission value: granted, denied or default
    #[arg(long, global = true, default_value = "default")]
    pub notifications: String,
    /// Total time budget for a page's scripts, in milliseconds
    #[arg(long, global = true, default_value_t = 8000)]
    pub js_budget_ms: u64,
    /// Separate budget for ad/analytics scripts, in milliseconds (0 skips them)
    #[arg(long, global = true, default_value_t = 1500)]
    pub ad_budget_ms: u64,
    /// Disable service workers (navigator.serviceWorker stays an inert stub)
    #[arg(long, global = true)]
    pub no_service_workers: bool,
    /// Browser session for the agent commands (open, click, fill, ...); default: $JB_SESSION or "default"
    #[arg(long, global = true, default_value = "")]
    pub session: String,
    /// Print agent command results as JSON
    #[arg(long, global = true)]
    pub json: bool,
}

impl JsArgs {
    /// The browser options as command-line flags, for a session server started in the background.
    pub fn to_cli_args(&self) -> Vec<String> {
        let mut v: Vec<String> = Vec::new();
        let mut flag = |on: bool, name: &str| if on { v.push(name.to_string()) };
        flag(self.no_javascript, "--no-javascript");
        flag(self.no_external_js, "--no-external-js");
        flag(self.js_console, "--js-console");
        flag(self.no_websockets, "--no-websockets");
        flag(self.allow_clipboard, "--allow-clipboard");
        flag(self.no_service_workers, "--no-service-workers");
        if let Some(g) = &self.geolocation {
            v.push("--geolocation".into());
            v.push(g.clone());
        }
        v.extend(["--notifications".into(), self.notifications.clone()]);
        v.extend(["--js-budget-ms".into(), self.js_budget_ms.to_string()]);
        v.extend(["--ad-budget-ms".into(), self.ad_budget_ms.to_string()]);
        v
    }
}

/// `vault` subcommands.
#[derive(Subcommand, Debug)]
pub enum VaultAction {
    /// Where the vault is, how its key is protected, and what it holds
    Status,
    /// Add a login (prompts for the password unless --password or --generate)
    Add {
        /// Site URL or domain
        site: String,
        username: String,
        #[arg(long)]
        password: Option<String>,
        /// Generate a strong password (printed once)
        #[arg(long)]
        generate: bool,
        /// TOTP secret (base32) or otpauth:// URI
        #[arg(long)]
        totp: Option<String>,
        #[arg(long)]
        title: Option<String>,
        /// Also allow the agent to use credentials on this site
        #[arg(long)]
        allow: bool,
    },
    /// List logins and passkeys (no secrets)
    List {
        /// Only this site
        #[arg(long)]
        site: Option<String>,
    },
    /// Show one login; --reveal prints its password (recorded in the audit log)
    Show {
        id: String,
        #[arg(long)]
        reveal: bool,
    },
    /// Remove a login (by id) or a passkey (by credential id)
    Remove { id: String },
    /// Import a password-manager export: CSV (Chrome, Edge, Firefox, Safari/Apple Passwords,
    /// 1Password, Bitwarden, LastPass, Dashlane, Proton Pass, ...), Bitwarden JSON (with passkeys)
    /// or FIDO CXF JSON (with passkeys)
    Import {
        file: String,
        /// auto, csv, bitwarden-json or cxf
        #[arg(long, default_value = "auto")]
        format: String,
    },
    /// Export to an unencrypted file: cxf (passwords, TOTP, passkeys) or csv (passwords)
    Export {
        file: String,
        #[arg(long, default_value = "cxf")]
        format: String,
        /// Confirm writing secrets to a plaintext file
        #[arg(long)]
        yes: bool,
    },
    /// Allow the agent to use credentials on these sites ("example.com" covers subdomains; "*" = all)
    Allow {
        #[arg(required = true)]
        sites: Vec<String>,
    },
    /// Stop allowing these sites
    Deny {
        #[arg(required = true)]
        sites: Vec<String>,
    },
    /// List the allowed sites
    Sites,
    /// Show the audit log: what the agent used, when, and why
    Log {
        #[arg(long, default_value_t = 20)]
        last: usize,
    },
    /// Print a login's current one-time code
    Totp { id: String },
    /// Print a generated password
    Generate {
        #[arg(long, default_value_t = 20)]
        length: usize,
    },
    /// Send a site's WebAuthn requests to a FIDO security key or Windows Hello instead of the
    /// vault's passkeys (a person touches the key / answers the prompt); --off switches back
    #[command(name = "security-key")]
    SecurityKey {
        /// Sites; none lists the current ones
        sites: Vec<String>,
        #[arg(long)]
        off: bool,
    },
    /// Narrow a running session to the sites one task needs (no sites = lift the narrowing)
    Scope {
        sites: Vec<String>,
        #[command(flatten)]
        js: JsArgs,
    },
}

/// `keyboard` subcommands.
#[derive(Subcommand, Debug)]
pub enum KeyboardAction {
    /// Type with real keystrokes at the current focus (no selector)
    Type {
        #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
        text: Vec<String>,
    },
    /// Insert text at the current focus without key events
    Inserttext {
        #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
        text: Vec<String>,
    },
}

impl JsArgs {
    pub fn to_config(&self) -> JsConfig {
        let geolocation = self.geolocation.as_deref().and_then(|g| {
            let mut it = g.split(',').map(|p| p.trim().parse::<f64>());
            match (it.next(), it.next()) {
                (Some(Ok(latitude)), Some(Ok(longitude))) => Some(crate::js::Geolocation { latitude, longitude, accuracy: 25.0 }),
                _ => None,
            }
        });
        JsConfig {
            fetch_external_scripts: !self.no_external_js,
            echo_console: self.js_console,
            allow_websockets: !self.no_websockets,
            allow_clipboard: self.allow_clipboard,
            geolocation,
            notification_permission: self.notifications.clone(),
            time_budget_ms: self.js_budget_ms,
            ad_budget_ms: self.ad_budget_ms,
            service_workers: !self.no_service_workers,
            max_timer_steps: if self.no_javascript { 0 } else { JsConfig::default().max_timer_steps },
            ..Default::default()
        }
    }
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Browse to a URL and display content
    Browse {
        url: String,
        /// Output format
        #[arg(long, value_enum, default_value_t = Format::Markdown)]
        format: Format,
        /// Show technical extraction sections (web components, ARIA, media queries, ...)
        #[arg(long)]
        full: bool,
        #[command(flatten)]
        layout: LayoutArgs,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Render a URL to the given format
    Render {
        url: String,
        #[arg(long, short, value_enum, default_value_t = Format::Markdown)]
        format: Format,
        /// Write output to a file
        #[arg(long, short)]
        output: Option<String>,
        #[command(flatten)]
        layout: LayoutArgs,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Start interactive browsing mode
    Interactive {
        #[command(flatten)]
        js: JsArgs,
    },
    /// Run JavaScript in the session page and print the result (`eval <url> <expr>` loads a page first)
    Eval {
        /// JavaScript code (or a URL followed by an expression)
        #[arg(num_args = 0..=2, allow_hyphen_values = true)]
        code: Vec<String>,
        /// The code is base64-encoded
        #[arg(short = 'b', long = "base64")]
        base64: bool,
        /// Read the code from standard input
        #[arg(long)]
        stdin: bool,
        #[command(flatten)]
        js: JsArgs,
    },
    // ---- agent commands: one persistent browser session shared by successive invocations
    /// Launch the session browser (on about:blank), or navigate it to a URL
    #[command(visible_aliases = ["goto", "navigate"])]
    Open {
        url: Option<String>,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Agent-readable text of the current page, or of a URL (loaded in the active tab)
    Read {
        url: Option<String>,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Click an element (CSS selector, text=..., or @N from an annotated screenshot)
    Click {
        selector: String,
        /// Open the link in a new tab instead
        #[arg(long)]
        new_tab: bool,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Double-click an element
    Dblclick {
        selector: String,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Focus an element
    Focus {
        selector: String,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Type text into an element (appends to its value)
    Type {
        selector: String,
        #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
        text: Vec<String>,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Clear an element and type text into it
    Fill {
        selector: String,
        #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
        text: Vec<String>,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Press a key or combination (Enter, Tab, Control+a)
    #[command(visible_alias = "key")]
    Press {
        key: String,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Keyboard input at the current focus without a selector
    Keyboard {
        #[command(subcommand)]
        action: KeyboardAction,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Hold a key down (until keyup)
    Keydown {
        key: String,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Release a held key
    Keyup {
        key: String,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Hover over an element
    Hover {
        selector: String,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Select a dropdown option by value or visible label
    Select {
        selector: String,
        #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
        value: Vec<String>,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Check a checkbox
    Check {
        selector: String,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Uncheck a checkbox
    Uncheck {
        selector: String,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Scroll the page (or --selector element): up, down, left or right, by px (default 300)
    Scroll {
        direction: String,
        px: Option<u64>,
        /// Scroll this element instead of the page
        #[arg(long)]
        selector: Option<String>,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Wait until an element matching the selector exists (or, given a number, let the page run
    /// for that many milliseconds)
    Wait {
        target: String,
        /// Give up after this many milliseconds of page time (selector form)
        #[arg(long, default_value_t = 10000)]
        timeout: u64,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Scroll an element into view
    #[command(visible_alias = "scrollinto")]
    Scrollintoview {
        selector: String,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Click at viewport coordinates (CSS pixels from the top-left of the 1280x720 viewport)
    #[command(name = "click_at", alias = "clickat")]
    ClickAt {
        x: f64,
        y: f64,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Drag an element and drop it on another
    Drag {
        source: String,
        target: String,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Set the files of a file input
    Upload {
        selector: String,
        #[arg(required = true)]
        files: Vec<String>,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Sign in from the vault: fill the page's username/password fields for its site (the secret
    /// is typed inside the browser and never printed)
    Login {
        /// Why the credential is needed (recorded in the vault audit log)
        #[arg(long, required = true)]
        reason: String,
        /// Which account, when the vault has several for the site (username or item id)
        #[arg(long)]
        account: Option<String>,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Fill the current one-time code (TOTP) from the vault into the page's code field
    Otp {
        #[arg(long, required = true)]
        reason: String,
        #[arg(long)]
        account: Option<String>,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Sign-up: generate a strong password, save it in the vault for this site and username, and
    /// fill the page's new-password fields
    #[command(name = "new-password")]
    NewPassword {
        /// The account's username or email on the site
        username: String,
        #[arg(long, required = true)]
        reason: String,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Manage the encrypted password + passkey vault (import, allow sites, audit log, ...)
    Vault {
        #[command(subcommand)]
        action: VaultAction,
    },
    /// Take a screenshot (viewport by default; saved to a temporary directory without a path)
    Screenshot {
        path: Option<String>,
        /// Capture the full page
        #[arg(long)]
        full: bool,
        /// Number the interactive elements on the image (refer to them as @N)
        #[arg(long)]
        annotate: bool,
        /// Skip saving when the page looks the same as the last screenshot
        #[arg(long)]
        if_changed: bool,
        /// With --if-changed: fraction of pixels allowed to differ (e.g. 0.01)
        #[arg(long, default_value_t = 0.0)]
        threshold: f64,
        /// Directory for screenshots saved without a path
        #[arg(long)]
        screenshot_dir: Option<String>,
        /// Image format: png or jpeg
        #[arg(long, default_value = "png")]
        screenshot_format: String,
        /// JPEG quality (1-100)
        #[arg(long, default_value_t = 90)]
        screenshot_quality: u8,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Save the page as a PDF
    Pdf {
        path: String,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Connect this session to a running julia-browser session on a port
    Connect {
        port: u16,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Close the session browser
    #[command(visible_aliases = ["quit", "exit"])]
    Close {
        /// Close every active session
        #[arg(long)]
        all: bool,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Serve the Chrome DevTools Protocol, so Puppeteer, Playwright (connectOverCDP) and other
    /// CDP clients can drive the browser: `puppeteer.connect({ browserURL: "http://127.0.0.1:9222" })`
    Cdp {
        /// Port to listen on (0 picks a free one)
        #[arg(long, default_value_t = 9222)]
        port: u16,
        /// Address to listen on
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        /// User-Agent header and navigator.userAgent
        #[arg(long)]
        user_agent: Option<String>,
        #[command(flatten)]
        js: JsArgs,
    },
    /// Run a session server (started automatically by the agent commands)
    #[command(name = "__serve", hide = true)]
    Serve {
        #[command(flatten)]
        js: JsArgs,
    },
}

/// Absolute form of a path given on the command line (session servers run elsewhere).
fn absolute(p: &str) -> String {
    let path = std::path::Path::new(p);
    if path.is_absolute() {
        return p.to_string();
    }
    std::env::current_dir().map(|d| d.join(path).to_string_lossy().into_owned()).unwrap_or_else(|_| p.to_string())
}

/// Send an agent command to the session browser and print its result. Returns the exit code.
fn agent_command(js: &JsArgs, cmd: &str, args: serde_json::Value) -> i32 {
    let name = crate::session::resolve_name(&js.session);
    match crate::session::request(&name, &js.to_cli_args(), cmd, args, true) {
        Ok((resp, started)) => {
            if started && !js.json {
                term::info(&format!("Started browser session '{name}'"));
            }
            let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            if js.json {
                println!("{}", serde_json::to_string_pretty(&resp).unwrap_or_default());
            } else if ok {
                println!("{}", resp.get("message").and_then(|m| m.as_str()).unwrap_or(""));
            } else {
                term::error(resp.get("error").and_then(|m| m.as_str()).unwrap_or("the command failed"));
            }
            if ok { 0 } else { 1 }
        }
        Err(e) => {
            if js.json {
                println!("{}", serde_json::json!({"ok": false, "error": e}));
            } else {
                term::error(&e);
            }
            1
        }
    }
}

/// The old standalone form `eval <url> <expression>`: load the page, evaluate, print.
fn legacy_eval(url: &str, expression: &str, js_args: &JsArgs) -> i32 {
    let mut agent = crate::agent::AgentSdk::with_js_config(None, 30, js_args.to_config());
    let opened = agent.open_website(url);
    if !opened["success"].as_bool().unwrap_or(false) {
        term::error(&format!("Failed to load {url}: {}", opened["error"]));
        return 1;
    }
    let result = agent.execute_javascript(&format!("__jb.lastEval = ({expression})"));
    let value = agent.engine.js_engine.eval_js("__jb.lastEval");
    term::print_json(&value);
    for line in result["console"].as_array().into_iter().flatten() {
        term::info(&format!("console: {}", line.as_str().unwrap_or("")));
    }
    for e in result["errors"].as_array().into_iter().flatten() {
        term::error(&format!("error: {}", e.as_str().unwrap_or("")));
    }
    0
}

/// Browser options live on each subcommand, so `julia-browser --session s open …`
/// would be rejected; move leading options to just after the subcommand name.
fn hoist_global_flags(args: Vec<String>) -> Vec<String> {
    const VALUED: &[&str] = &["--session", "--geolocation", "--notifications", "--js-budget-ms", "--ad-budget-ms"];
    let mut moved = Vec::new();
    let mut i = 1;
    while i < args.len() && args[i].starts_with("--") && args[i] != "--help" && args[i] != "--version" {
        let flag = args[i].clone();
        let takes_value = !flag.contains('=') && VALUED.contains(&flag.as_str());
        moved.push(flag);
        i += 1;
        if takes_value && i < args.len() {
            moved.push(args[i].clone());
            i += 1;
        }
    }
    if moved.is_empty() || i >= args.len() {
        return args;
    }
    let mut out = vec![args[0].clone(), args[i].clone()];
    out.extend(moved);
    out.extend(args[i + 1..].iter().cloned());
    out
}

/// Binary entry point.
pub fn run_main() {
    let cli = Cli::parse_from(hoist_global_flags(std::env::args().collect()));
    let code = match cli.command {
        None => {
            let mut browser = CliBrowser::new(JsConfig::default());
            browser.start_interactive_mode();
            0
        }
        Some(Command::Browse { url, format, full, layout, js: js_args }) => {
            let js = !js_args.no_javascript;
            let mut browser = CliBrowser::new(js_args.to_config());
            browser.full_mode = full;
            match format {
                Format::Png => {
                    term::error("--format png needs a file: use `render <url> --format png -o page.png`");
                    2
                }
                Format::Layout => {
                    let result = browser.sdk.render_to_layout(&url, js, None, &layout.to_options());
                    if result.success {
                        println!("{}", result.content.unwrap_or_default());
                        0
                    } else {
                        term::error(&format!("Failed to load {url}: {}", result.error.unwrap_or_default()));
                        1
                    }
                }
                Format::Json => {
                    let result = browser.sdk.render_to_markdown(&url, js, None);
                    term::print_json(&result.to_json());
                    if result.success { 0 } else { 1 }
                }
                Format::Html => {
                    let result = browser.sdk.fetch_page(&url, None);
                    if result.success {
                        println!("{}", result.raw_html.unwrap_or_default());
                        0
                    } else {
                        term::error(&format!("Failed to load {url}: {}", result.error.unwrap_or_default()));
                        1
                    }
                }
                Format::Text => {
                    let result = browser.sdk.render_to_text(&url, js, None);
                    if result.success {
                        println!("{}", result.content.unwrap_or_default());
                        0
                    } else {
                        term::error(&format!("Failed to load {url}: {}", result.error.unwrap_or_default()));
                        1
                    }
                }
                Format::Markdown => {
                    browser.sdk.engine.execute_js = js;
                    if browser.browse_url_enhanced(&url) { 0 } else { 1 }
                }
            }
        }
        Some(Command::Render { url, format, output, layout, js: js_args }) => {
            let mut sdk = BrowserSdk::with_js_config(None, 30, js_args.to_config());
            let js = !js_args.no_javascript;
            if format == Format::Png {
                match output {
                    None => {
                        term::error("--format png needs -o <file.png>");
                        2
                    }
                    Some(path) => match sdk.render_to_png(&url, js, None, &layout.to_screenshot_options(), layout.clip.as_deref()) {
                        Ok(png) => match std::fs::write(&path, &png) {
                            Ok(_) => {
                                term::success(&format!("Screenshot saved to {path} ({} bytes)", png.len()));
                                0
                            }
                            Err(e) => {
                                term::error(&format!("Could not write {path}: {e}"));
                                1
                            }
                        },
                        Err(e) => {
                            term::error(&format!("Failed to capture {url}: {e}"));
                            1
                        }
                    },
                }
            } else {
            let (result, content) = match format {
                Format::Png => unreachable!(),
                Format::Layout => {
                    let r = sdk.render_to_layout(&url, js, None, &layout.to_options());
                    let c = r.content.clone().unwrap_or_default();
                    (r, c)
                }
                Format::Markdown => {
                    let r = sdk.render_to_markdown(&url, js, None);
                    let c = r.content.clone().unwrap_or_default();
                    (r, c)
                }
                Format::Text => {
                    let r = sdk.render_to_text(&url, js, None);
                    let c = r.content.clone().unwrap_or_default();
                    (r, c)
                }
                Format::Html => {
                    sdk.engine.execute_js = js;
                    let r = sdk.fetch_page(&url, None);
                    let c = r.raw_html.clone().unwrap_or_default();
                    (r, c)
                }
                Format::Json => {
                    let r = sdk.render_to_markdown(&url, js, None);
                    let c = serde_json::to_string_pretty(&r.to_json()).unwrap_or_default();
                    (r, c)
                }
            };
            if !result.success {
                term::error(&format!("Failed to render {url}: {}", result.error.unwrap_or_else(|| "Unknown error".into())));
                1
            } else if let Some(path) = output {
                match std::fs::write(&path, content) {
                    Ok(_) => {
                        term::success(&format!("Content saved to {path}"));
                        0
                    }
                    Err(e) => {
                        term::error(&format!("Could not write {path}: {e}"));
                        1
                    }
                }
            } else {
                println!("{content}");
                0
            }
            }
        }
        Some(Command::Interactive { js: js_args }) => {
            let mut browser = CliBrowser::new(js_args.to_config());
            browser.sdk.engine.execute_js = !js_args.no_javascript;
            browser.start_interactive_mode();
            0
        }
        Some(Command::Eval { code, base64, stdin, js: js_args }) => {
            if code.len() == 2 && (code[0].starts_with("http://") || code[0].starts_with("https://") || code[0].starts_with("file:")) {
                legacy_eval(&code[0], &code[1], &js_args)
            } else {
                let source = if stdin {
                    let mut buf = String::new();
                    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf);
                    Ok(buf)
                } else if code.is_empty() {
                    Err("eval needs JavaScript code (or --stdin)".to_string())
                } else {
                    let joined = code.join(" ");
                    if base64 {
                        use base64::Engine;
                        base64::engine::general_purpose::STANDARD
                            .decode(joined.trim())
                            .map_err(|e| format!("the code is not valid base64: {e}"))
                            .and_then(|b| String::from_utf8(b).map_err(|e| format!("the decoded code is not UTF-8: {e}")))
                    } else {
                        Ok(joined)
                    }
                };
                match source {
                    Ok(src) => agent_command(&js_args, "eval", serde_json::json!({"code": src})),
                    Err(e) => {
                        term::error(&e);
                        2
                    }
                }
            }
        }
        Some(Command::Open { url, js }) => agent_command(&js, "open", serde_json::json!({"url": url})),
        Some(Command::Read { url, js }) => agent_command(&js, "read", serde_json::json!({"url": url})),
        Some(Command::Click { selector, new_tab, js }) => agent_command(&js, "click", serde_json::json!({"selector": selector, "new_tab": new_tab})),
        Some(Command::Dblclick { selector, js }) => agent_command(&js, "dblclick", serde_json::json!({"selector": selector})),
        Some(Command::Focus { selector, js }) => agent_command(&js, "focus", serde_json::json!({"selector": selector})),
        Some(Command::Type { selector, text, js }) => agent_command(&js, "type", serde_json::json!({"selector": selector, "text": text.join(" ")})),
        Some(Command::Fill { selector, text, js }) => agent_command(&js, "fill", serde_json::json!({"selector": selector, "text": text.join(" ")})),
        Some(Command::Press { key, js }) => agent_command(&js, "press", serde_json::json!({"key": key})),
        Some(Command::Keyboard { action, js }) => {
            let (mode, text) = match action {
                KeyboardAction::Type { text } => ("type", text),
                KeyboardAction::Inserttext { text } => ("inserttext", text),
            };
            agent_command(&js, "keyboard", serde_json::json!({"mode": mode, "text": text.join(" ")}))
        }
        Some(Command::Keydown { key, js }) => agent_command(&js, "keydown", serde_json::json!({"key": key})),
        Some(Command::Keyup { key, js }) => agent_command(&js, "keyup", serde_json::json!({"key": key})),
        Some(Command::Hover { selector, js }) => agent_command(&js, "hover", serde_json::json!({"selector": selector})),
        Some(Command::Select { selector, value, js }) => agent_command(&js, "select", serde_json::json!({"selector": selector, "value": value.join(" ")})),
        Some(Command::Check { selector, js }) => agent_command(&js, "check", serde_json::json!({"selector": selector})),
        Some(Command::Uncheck { selector, js }) => agent_command(&js, "uncheck", serde_json::json!({"selector": selector})),
        Some(Command::Scroll { direction, px, selector, js }) => agent_command(&js, "scroll", serde_json::json!({"direction": direction, "px": px, "selector": selector})),
        Some(Command::Scrollintoview { selector, js }) => agent_command(&js, "scrollintoview", serde_json::json!({"selector": selector})),
        Some(Command::Wait { target, timeout, js }) => agent_command(&js, "wait", serde_json::json!({"target": target, "timeout": timeout})),
        Some(Command::ClickAt { x, y, js }) => agent_command(&js, "click_at", serde_json::json!({"x": x, "y": y})),
        Some(Command::Drag { source, target, js }) => agent_command(&js, "drag", serde_json::json!({"source": source, "target": target})),
        Some(Command::Login { reason, account, js }) => agent_command(&js, "login", serde_json::json!({"reason": reason, "account": account})),
        Some(Command::Otp { reason, account, js }) => agent_command(&js, "otp", serde_json::json!({"reason": reason, "account": account})),
        Some(Command::NewPassword { username, reason, js }) => agent_command(&js, "new_password", serde_json::json!({"username": username, "reason": reason})),
        Some(Command::Vault { action: VaultAction::Scope { sites, js } }) => agent_command(&js, "vault_scope", serde_json::json!({"sites": sites})),
        Some(Command::Vault { action }) => vault_command(action),
        Some(Command::Upload { selector, files, js }) => {
            let files: Vec<String> = files.iter().map(|f| absolute(f)).collect();
            agent_command(&js, "upload", serde_json::json!({"selector": selector, "files": files}))
        }
        Some(Command::Screenshot { path, full, annotate, if_changed, threshold, screenshot_dir, screenshot_format, screenshot_quality, js }) => agent_command(
            &js,
            "screenshot",
            serde_json::json!({
                "path": path.as_deref().map(absolute),
                "full": full,
                "annotate": annotate,
                "if_changed": if_changed,
                "threshold": threshold,
                "dir": screenshot_dir.as_deref().map(absolute),
                "format": screenshot_format,
                "quality": screenshot_quality,
            }),
        ),
        Some(Command::Pdf { path, js }) => agent_command(&js, "pdf", serde_json::json!({"path": absolute(&path)})),
        Some(Command::Connect { port, js }) => {
            let name = crate::session::resolve_name(&js.session);
            match crate::session::connect(&name, port) {
                Ok(_) => {
                    term::success(&format!("Session '{name}' is connected to the browser on port {port}"));
                    0
                }
                Err(e) => {
                    term::error(&e);
                    1
                }
            }
        }
        Some(Command::Close { all, js }) => {
            if all {
                let n = crate::session::close_all();
                term::success(&format!("Closed {n} session{}", if n == 1 { "" } else { "s" }));
            } else {
                let name = crate::session::resolve_name(&js.session);
                if crate::session::close(&name) {
                    term::success(&format!("✓ Closed browser session '{name}'"));
                } else {
                    term::info(&format!("No browser session '{name}' is running"));
                }
            }
            0
        }
        Some(Command::Cdp { port, host, user_agent, js }) => crate::cdp::serve(crate::cdp::CdpOptions { host, port, js: js.to_config(), execute_js: !js.no_javascript, user_agent }),
        Some(Command::Serve { js }) => {
            let name = crate::session::resolve_name(&js.session);
            crate::session::serve(&name, js.to_config(), !js.no_javascript)
        }
    };
    std::process::exit(code);
}

#[derive(Debug, Clone)]
struct ClickableElement {
    number: usize,
    kind: String,
    subtype: String,
    text: String,
    url: Option<String>,
    nav_url: Option<String>,
    in_form: bool,
    form: Option<ego_tree::NodeId>,
    node: Option<ego_tree::NodeId>,
}

#[derive(Debug, Clone)]
struct PageLink {
    number: usize,
    url: String,
    text: String,
}

struct PerformanceStats {
    pages_visited: usize,
    cache_hits: usize,
    total_load_time: f64,
    session_start: Instant,
}

/// Interactive command-line browser.
pub struct CliBrowser {
    pub sdk: BrowserSdk,
    pub running: bool,
    pub full_mode: bool,
    pub current_url: Option<String>,
    pub current_title: String,
    pub navigation_history: Vec<String>,
    pub history_position: isize,
    pub bookmarks: BTreeMap<String, String>,
    page_links: Vec<PageLink>,
    current_response: Option<SdkResult>,
    clickable_elements: Vec<ClickableElement>,
    input_elements: Vec<InputInfo>,
    stats: PerformanceStats,
}

impl CliBrowser {
    pub fn new(js: JsConfig) -> Self {
        Self {
            sdk: BrowserSdk::with_js_config(None, 30, js),
            running: true,
            full_mode: false,
            current_url: None,
            current_title: "Julia Browser".into(),
            navigation_history: Vec::new(),
            history_position: -1,
            bookmarks: BTreeMap::new(),
            page_links: Vec::new(),
            current_response: None,
            clickable_elements: Vec::new(),
            input_elements: Vec::new(),
            stats: PerformanceStats { pages_visited: 0, cache_hits: 0, total_load_time: 0.0, session_start: Instant::now() },
        }
    }

    pub fn start_interactive_mode(&mut self) {
        self.show_welcome_screen();
        // With a real terminal use the line editor; otherwise (piped input,
        // scripts) read plain lines from stdin.
        let interactive_tty = console::Term::stdout().is_term() && console::user_attended();
        let stdin = std::io::stdin();
        while self.running {
            let prompt = self.get_prompt();
            let input: Option<String> = if interactive_tty {
                Input::<String>::new().with_prompt(prompt).allow_empty(true).interact_text().ok()
            } else {
                use std::io::BufRead;
                print!("{prompt} ");
                let _ = std::io::Write::flush(&mut std::io::stdout());
                let mut line = String::new();
                match stdin.lock().read_line(&mut line) {
                    Ok(0) | Err(_) => None,
                    Ok(_) => {
                        println!("{}", line.trim_end());
                        Some(line)
                    }
                }
            };
            match input {
                Some(cmd) => {
                    let cmd = cmd.trim().to_string();
                    if cmd.is_empty() {
                        continue;
                    }
                    self.process_command(&cmd);
                }
                None => break,
            }
        }
        self.show_goodbye_screen();
    }

    fn show_welcome_screen(&self) {
        let body = format!(
            "{}\n\n{}\n• Full navigation with back/forward, bookmarks, and history\n• Mozilla SpiderMonkey JavaScript execution with a real DOM\n• Advanced web analysis (CSS, forms, links, JSON APIs)\n• Intercepting proxy with declarative rules\n\n{}\n• Type 'help' for all commands\n• Enter URLs directly: google.com\n• Use 'browse <url>' or just paste URLs\n• Type 'quit' to exit\n\n{}",
            style("🌐 Julia Browser - Interactive Mode").bold().blue(),
            style("🚀 Features:").bold(),
            style("💡 Quick Start:").bold(),
            style(format!("Julia Browser v{} (Rust + SpiderMonkey)", env!("CARGO_PKG_VERSION"))).dim()
        );
        println!("{}", term::panel("Welcome to Julia Browser", &body));
    }

    fn show_goodbye_screen(&self) {
        let elapsed = self.stats.session_start.elapsed().as_secs_f64();
        println!("{}", term::panel("Goodbye", &format!("Thanks for using Julia Browser!\nPages visited: {} • Session time: {:.0}s", self.stats.pages_visited, elapsed)));
    }

    fn get_prompt(&self) -> String {
        match &self.current_url {
            Some(u) => {
                let domain = url::Url::parse(u).ok().and_then(|p| p.host_str().map(|h| h.to_string())).unwrap_or_else(|| u.clone());
                let domain: String = if domain.chars().count() > 20 { format!("{}...", domain.chars().take(17).collect::<String>()) } else { domain };
                format!("{} {}", style(domain).green().bold(), style(">").dim())
            }
            None => format!("{} {}", style("browser").blue().bold(), style(">").dim()),
        }
    }

    pub fn process_command(&mut self, command: &str) {
        let parts: Vec<&str> = command.split_whitespace().collect();
        let cmd = parts[0].to_lowercase();
        let args: Vec<String> = parts[1..].iter().map(|s| s.to_string()).collect();
        match cmd.as_str() {
            "quit" | "exit" | "q" => self.confirm_exit(),
            "help" | "?" => self.show_help(),
            "browse" | "go" | "visit" | "open" => self.handle_browse_command(&args),
            "back" => self.navigate_back(),
            "forward" | "fwd" => self.navigate_forward(),
            "reload" | "refresh" => self.reload_page(),
            "links" => self.show_links(),
            "click" if args.first().map(|a| a.parse::<usize>().is_err()).unwrap_or(false) => self.user_act("click", &args.join(" "), None),
            "do" | "act" => {
                if args.len() < 2 {
                    term::error("Usage: do <action> <selector|text=...> [value]");
                } else {
                    let value = if args.len() > 2 { Some(args[2..].join(" ")) } else { None };
                    self.user_act(&args[0], &args[1], value.as_deref());
                }
            }
            "fill" | "select" if args.len() >= 2 => self.user_act(&cmd, &args[0], Some(&args[1..].join(" "))),
            "check" | "uncheck" | "hover" | "dblclick" | "focus" if !args.is_empty() => self.user_act(&cmd, &args.join(" "), None),
            "press" | "key" => self.user_act("press", "", Some(&args.join(" "))),
            "wait" if !args.is_empty() => self.user_wait(&args.join(" ")),
            "follow" | "click" => {
                if cmd == "click" && !self.clickable_elements.is_empty() {
                    self.handle_click_command(&args)
                } else {
                    self.follow_link(&args)
                }
            }
            "elements" | "clickable" => self.show_clickable_elements(),
            "type" | "input" => self.handle_input_command(&args),
            "submit" => self.handle_submit_command(),
            "button" => self.handle_button_command(&args),
            "link" => self.handle_link_command(&args),
            "history" | "hist" => self.show_navigation_history(),
            "performance" | "perf" => self.show_performance_stats(),
            "info" => self.show_page_info(),
            "screen" | "layout" => self.show_screen(&args),
            "screenshot" | "shot" => self.save_screenshot(&args),
            "search" => self.search_page(&args),
            "anchors" => self.show_available_anchors(),
            "bookmark" | "bm" => self.handle_bookmark_command(&args),
            "bookmarks" => self.show_bookmarks(),
            "js" | "eval" => self.handle_js_command(&args),
            "console" => self.show_js_console(),
            "proxy" => self.handle_proxy_command(&args),
            "full" => {
                self.full_mode = !self.full_mode;
                term::info(&format!("Full technical mode: {}", if self.full_mode { "on" } else { "off" }));
            }
            "clear" | "cls" => term::clear(),
            "version" => self.show_version_info(),
            _ => {
                if looks_like_url(command) {
                    self.browse_url_enhanced(command);
                } else {
                    term::error(&format!("Unknown command: {cmd}"));
                    term::info("Type 'help' for available commands");
                }
            }
        }
    }

    fn confirm_exit(&mut self) {
        if self.stats.pages_visited > 0 && console::Term::stdout().is_term() && console::user_attended() {
            let ok = Confirm::new().with_prompt(format!("Exit Julia Browser? ({} pages visited this session)", self.stats.pages_visited)).default(true).interact().unwrap_or(true);
            if ok {
                self.running = false;
            }
        } else {
            self.running = false;
        }
    }

    /// The current page as character cells (`--format layout`).
    fn show_screen(&self, args: &[String]) {
        let Some(doc) = self.sdk.engine.current_document.as_ref() else {
            term::info("No page loaded");
            return;
        };
        let cols = args.first().and_then(|a| a.parse().ok()).unwrap_or(160);
        let opts = crate::layout::TextOptions { cols, ..Default::default() };
        match self.sdk.engine.render_layout_text(doc, &opts) {
            Some(text) => println!("{text}"),
            None => term::error("Layout rendering is not compiled in (build with --features layout)"),
        }
    }

    /// Save the current page (or an element) as PNG.
    fn save_screenshot(&self, args: &[String]) {
        let Some(doc) = self.sdk.engine.current_document.as_ref() else {
            term::info("No page loaded");
            return;
        };
        let Some(path) = args.first() else {
            term::info("Usage: screenshot <file.png> [selector]");
            return;
        };
        let clip = args.get(1).map(|s| s.as_str());
        match self.sdk.engine.render_screenshot(doc, &crate::layout::ScreenshotOptions::default(), clip) {
            Some(Ok(png)) => match std::fs::write(path, &png) {
                Ok(_) => term::success(&format!("Screenshot saved to {path} ({} bytes)", png.len())),
                Err(e) => term::error(&format!("Could not write {path}: {e}")),
            },
            Some(Err(e)) => term::error(&format!("Screenshot failed: {e}")),
            None => term::error("Screenshots are not compiled in (build with --features screenshot)"),
        }
    }

    fn show_help(&self) {
        let nav = vec![
            ("browse <url>", "Navigate to URL", "browse google.com"),
            ("go <url>", "Alias for browse", "go example.com"),
            ("back", "Go back in history", "back"),
            ("forward", "Go forward in history", "forward"),
            ("reload", "Refresh current page", "reload"),
            ("links", "Show all page links", "links"),
            ("follow <num>", "Follow link by number", "follow 3"),
            ("elements", "Show all clickable elements", "elements"),
            ("button <num>", "Click specific button", "button 1"),
            ("link <num>", "Navigate to specific link", "link 3"),
            ("click <num>", "Click any element by number", "click 5"),
        ];
        let adv = vec![
            ("info", "Show page information", "info"),
            ("screen [cols]", "Show the page as character cells (layout)", "screen 120"),
            ("screenshot <file> [selector]", "Save a PNG of the page or one element", "screenshot page.png #main"),
            ("search <term>", "Search page content", "search contact"),
            ("anchors", "Show available anchor links", "anchors"),
            ("type <text>", "Type into the first input field", "type hello"),
            ("type <n> <text>", "Type into input field n", "type 2 hello"),
            ("submit", "Submit the first form", "submit"),
            ("js <code>", "Run JavaScript on the page", "js document.title"),
            ("console", "Show JavaScript console output", "console"),
            ("proxy <cmd>", "start|stop|status|traffic|rules", "proxy traffic"),
            ("bookmark add <name>", "Bookmark current page", "bookmark add docs"),
            ("bookmarks", "List bookmarks", "bookmarks"),
            ("full", "Toggle technical extraction sections", "full"),
            ("performance", "Show performance stats", "performance"),
            ("history", "Show browsing history", "history"),
            ("clear", "Clear screen", "clear"),
            ("version", "Show version", "version"),
            ("quit", "Exit browser", "quit"),
        ];
        let to_rows = |v: &[(&str, &str, &str)]| v.iter().map(|(a, b, c)| vec![a.to_string(), b.to_string(), c.to_string()]).collect::<Vec<_>>();
        println!("{}", term::table(Some("🧭 Navigation Commands"), &["Command", "Description", "Example"], &to_rows(&nav)));
        println!();
        println!("{}", term::table(Some("🚀 Advanced Features"), &["Command", "Description", "Example"], &to_rows(&adv)));
    }

    fn handle_browse_command(&mut self, args: &[String]) {
        if args.is_empty() {
            if let Ok(url) = Input::<String>::new().with_prompt("Enter URL").interact_text() {
                if !url.trim().is_empty() {
                    self.browse_url_enhanced(url.trim());
                }
            }
        } else {
            let url = args.join(" ");
            self.browse_url_enhanced(&url);
        }
    }

    /// Load and display a page. Returns whether it succeeded.
    pub fn browse_url_enhanced(&mut self, url: &str) -> bool {
        let start = Instant::now();
        let spinner = term::spinner(&format!("Loading {url}..."));
        let execute_js = self.sdk.engine.execute_js;
        let mut result = self.sdk.render_to_markdown(url, execute_js, None);
        spinner.finish_and_clear();
        if !result.success {
            term::error(&format!("Failed to load {url}: {}", result.error.clone().unwrap_or_else(|| "Unknown error".into())));
            return false;
        }
        if self.full_mode {
            if let Some(doc) = &result.document {
                result.content = Some(self.sdk.engine.render_page_mode(doc, false));
            }
        }
        let final_url = result.final_url.clone().unwrap_or_else(|| url.to_string());
        self.current_url = Some(final_url.clone());
        self.current_title = result.metadata.as_ref().and_then(|m| m.title.clone()).unwrap_or_else(|| "Unknown".into());
        if self.navigation_history.last() != Some(&final_url) {
            self.navigation_history.push(final_url);
            self.history_position = self.navigation_history.len() as isize - 1;
        }
        let load_time = start.elapsed().as_secs_f64();
        self.stats.pages_visited += 1;
        self.stats.total_load_time += load_time;
        if let Some(doc) = &result.document {
            self.extract_page_links(doc);
            self.extract_clickable_elements(doc);
        }
        let content = result.content.clone().unwrap_or_default();
        println!("{}", term::render_markdown(&content));
        self.current_response = Some(result);
        self.show_quick_page_info(load_time);
        true
    }

    fn show_quick_page_info(&self, load_time: f64) {
        let mut items = Vec::new();
        if self.current_title != "Unknown" && !self.current_title.is_empty() {
            items.push(format!("📄 {}", self.current_title));
        }
        items.push(format!("⏱️ {load_time:.2}s"));
        if !self.page_links.is_empty() {
            items.push(format!("🔗 {} links", self.page_links.len()));
        }
        if let Some(js) = &self.sdk.engine.last_js {
            if js.scripts_run > 0 {
                items.push(format!("⚙️ {} scripts", js.scripts_run));
                if !js.errors.is_empty() {
                    items.push(format!("⚠️ {} JS errors", js.errors.len()));
                }
            }
        }
        if self.sdk.engine.is_json_response() {
            items.push("📊 JSON API".into());
        }
        term::info(&items.join(" • "));
    }

    fn extract_page_links(&mut self, doc: &Document) {
        self.page_links.clear();
        for (i, id) in dom::find_all(doc, &["a"]).into_iter().filter(|a| dom::has_attr(doc, *a, "href")).take(50).enumerate() {
            let href = dom::attr(doc, id, "href").unwrap_or_default();
            if !(href.starts_with("http") || href.starts_with('/') || href.starts_with('#') || href.starts_with('.') || !href.contains(':')) {
                continue;
            }
            let text = dom::get_text_stripped(doc, id);
            let text: String = if text.chars().count() > 60 { format!("{}...", text.chars().take(60).collect::<String>()) } else { text };
            self.page_links.push(PageLink { number: i + 1, url: href, text });
        }
    }

    fn show_links(&self) {
        if self.page_links.is_empty() {
            term::warn("No links found on current page");
            return;
        }
        let rows: Vec<Vec<String>> = self
            .page_links
            .iter()
            .take(20)
            .map(|l| {
                let u: String = if l.url.chars().count() > 50 { format!("{}...", l.url.chars().take(47).collect::<String>()) } else { l.url.clone() };
                vec![l.number.to_string(), if l.text.is_empty() { "[No text]".into() } else { l.text.clone() }, u]
            })
            .collect();
        println!("{}", term::table(Some(&format!("🔗 Page Links ({} found)", self.page_links.len())), &["#", "Link Text", "URL"], &rows));
        if self.page_links.len() > 20 {
            term::info(&format!("... and {} more links", self.page_links.len() - 20));
        }
        term::info("Use 'follow <number>' to navigate to a link");
    }

    fn follow_link(&mut self, args: &[String]) {
        let n: usize = match args.first().and_then(|a| a.parse().ok()) {
            Some(n) => n,
            None => {
                term::error("Please specify a link number (use 'links' to see available links)");
                return;
            }
        };
        if n < 1 || n > self.page_links.len() {
            term::error(&format!("Invalid link number. Use 1-{}", self.page_links.len()));
            return;
        }
        let link = self.page_links[n - 1].clone();
        println!("🖱️ Clicking: {}", link.text);
        if let Some(anchor) = link.url.strip_prefix('#') {
            self.navigate_to_anchor(anchor);
            return;
        }
        let url = self.sdk.engine.resolve(&link.url);
        println!("✓ Navigating to: {url}");
        self.browse_url_enhanced(&url);
    }

    fn navigate_back(&mut self) {
        if self.history_position > 0 {
            self.history_position -= 1;
            let url = self.navigation_history[self.history_position as usize].clone();
            term::info(&format!("Going back to: {url}"));
            self.load_history_entry(&url);
        } else {
            term::warn("No previous page in history");
        }
    }

    fn navigate_forward(&mut self) {
        if self.history_position + 1 < self.navigation_history.len() as isize {
            self.history_position += 1;
            let url = self.navigation_history[self.history_position as usize].clone();
            term::info(&format!("Going forward to: {url}"));
            self.load_history_entry(&url);
        } else {
            term::warn("No next page in history");
        }
    }

    fn load_history_entry(&mut self, url: &str) {
        let saved = (self.navigation_history.clone(), self.history_position);
        self.browse_url_enhanced(url);
        self.navigation_history = saved.0;
        self.history_position = saved.1;
    }

    fn reload_page(&mut self) {
        match self.current_url.clone() {
            Some(u) => {
                term::info(&format!("Reloading: {u}"));
                self.load_history_entry(&u);
            }
            None => term::warn("No page to reload"),
        }
    }

    fn show_navigation_history(&self) {
        if self.navigation_history.is_empty() {
            term::warn("No browsing history available");
            return;
        }
        let rows: Vec<Vec<String>> = self.navigation_history.iter().enumerate().map(|(i, u)| vec![(i + 1).to_string(), u.clone(), if i as isize == self.history_position { "→ Current".into() } else { String::new() }]).collect();
        println!("{}", term::table(Some("📚 Browsing History"), &["#", "URL", "Status"], &rows));
    }

    fn show_performance_stats(&self) {
        let session = self.stats.session_start.elapsed().as_secs_f64();
        let rows = vec![
            vec!["Pages Visited".into(), self.stats.pages_visited.to_string()],
            vec!["Session Duration".into(), format!("{session:.1}s")],
            vec!["Total Load Time".into(), format!("{:.2}s", self.stats.total_load_time)],
            vec!["Average Load Time".into(), format!("{:.2}s", self.stats.total_load_time / self.stats.pages_visited.max(1) as f64)],
            vec!["Cache Hits".into(), self.stats.cache_hits.to_string()],
            vec!["Current Page".into(), self.current_url.clone().unwrap_or_else(|| "None".into())],
            vec!["History Entries".into(), self.navigation_history.len().to_string()],
            vec!["Bookmarks".into(), self.bookmarks.len().to_string()],
        ];
        println!("{}", term::table(Some("📊 Performance Statistics"), &["Metric", "Value"], &rows));
    }

    fn show_page_info(&self) {
        if self.current_response.is_some() {
            let mut info = self.sdk.engine.get_page_info();
            info.insert("links".into(), self.page_links.len().to_string());
            println!("{}", self.sdk.engine.renderer.create_page_info_panel(&info));
            if let Some(js) = &self.sdk.engine.last_js {
                term::info(&format!("JavaScript: {} scripts run, {} DOM updates, {} API calls, {} errors", js.scripts_run, js.dom_updates.len(), js.api_calls.len(), js.errors.len()));
            }
        } else {
            term::warn("No page currently loaded");
        }
    }

    fn search_page(&self, args: &[String]) {
        if args.is_empty() {
            term::error("Please provide a search term");
            return;
        }
        let query = args.join(" ");
        let results = self.sdk.engine.search_page(&query);
        if results.is_empty() {
            term::warn(&format!("No matches for '{query}'"));
            return;
        }
        println!("{}", style(format!("🔍 {} matches for '{query}':", results.len())).bold());
        for r in results.iter().take(25) {
            println!("  {}", r);
        }
        if results.len() > 25 {
            term::info(&format!("... and {} more", results.len() - 25));
        }
    }

    fn show_available_anchors(&self) {
        let doc = match self.current_response.as_ref().and_then(|r| r.document.as_ref()) {
            Some(d) => d,
            None => {
                term::warn("No page loaded");
                return;
            }
        };
        let mut rows = Vec::new();
        for id in dom::find_with_attr(doc, "id") {
            let anchor = dom::attr(doc, id, "id").unwrap_or_default();
            let text: String = dom::get_text_stripped(doc, id).chars().take(60).collect();
            if !anchor.is_empty() && !text.is_empty() {
                rows.push(vec![format!("#{anchor}"), dom::tag_name(doc, id).unwrap_or_default(), text]);
            }
        }
        if rows.is_empty() {
            term::warn("No anchors found on this page");
        } else {
            let total = rows.len();
            rows.truncate(40);
            println!("{}", term::table(Some(&format!("⚓ Anchors ({total})")), &["Anchor", "Tag", "Text"], &rows));
        }
    }

    fn navigate_to_anchor(&self, anchor: &str) {
        let doc = match self.current_response.as_ref().and_then(|r| r.document.as_ref()) {
            Some(d) => d,
            None => {
                term::warn("No page loaded");
                return;
            }
        };
        let target = dom::find_by_id(doc, anchor).or_else(|| dom::find_all(doc, &["a"]).into_iter().find(|a| dom::attr(doc, *a, "name").as_deref() == Some(anchor)));
        match target {
            Some(id) => {
                println!("{}", style(format!("⚓ Section #{anchor}")).bold().blue());
                let md = crate::markdown::node_to_markdown(doc, id, &self.sdk.engine.renderer.md_options);
                let shown = if md.trim().is_empty() { dom::get_text_sep(doc, id, "\n", true) } else { md };
                println!("{}", term::render_markdown(&shown));
            }
            None => {
                term::warn(&format!("Anchor '#{anchor}' not found on this page"));
                self.show_available_anchors();
            }
        }
    }

    fn extract_clickable_elements(&mut self, doc: &Document) {
        self.clickable_elements.clear();
        self.input_elements.clear();
        let mut n = 1;
        for id in dom::find_all(doc, &["button", "input"]) {
            let tag = dom::tag_name(doc, id).unwrap_or_default();
            if tag == "input" {
                let ty = dom::attr(doc, id, "type").unwrap_or_else(|| "text".into()).to_ascii_lowercase();
                if !matches!(ty.as_str(), "submit" | "button" | "reset") {
                    continue;
                }
                let text = dom::attr(doc, id, "value").unwrap_or_else(|| format!("{} Button", crate::extractors::title_case(&ty)));
                let form = dom::find_parent(doc, id, "form");
                self.clickable_elements.push(ClickableElement { number: n, kind: "button".into(), subtype: ty, text, url: None, nav_url: forms::extract_button_navigation_url(doc, id), in_form: form.is_some(), form, node: Some(id) });
                n += 1;
            } else {
                let text = forms::button_label(doc, id);
                let form = dom::find_parent(doc, id, "form");
                let default_type = if form.is_some() { "submit" } else { "button" };
                self.clickable_elements.push(ClickableElement { number: n, kind: "button".into(), subtype: dom::attr(doc, id, "type").unwrap_or_else(|| default_type.into()).to_ascii_lowercase(), text, url: None, nav_url: forms::extract_button_navigation_url(doc, id), in_form: form.is_some(), form, node: Some(id) });
                n += 1;
            }
        }
        for id in dom::find_all(doc, &["a"]) {
            let href = dom::attr(doc, id, "href").unwrap_or_default();
            let text = dom::get_text_stripped(doc, id);
            if href.is_empty() || text.is_empty() {
                continue;
            }
            let text: String = if text.chars().count() > 50 { format!("{}...", text.chars().take(50).collect::<String>()) } else { text };
            self.clickable_elements.push(ClickableElement { number: n, kind: "link".into(), subtype: "link".into(), text, url: Some(href), nav_url: None, in_form: false, form: None, node: Some(id) });
            n += 1;
        }
        let base = self.current_url.clone().unwrap_or_default();
        let elements = forms::extract_interactive_elements(doc, &base);
        self.input_elements = elements.all_inputs();
    }

    fn show_clickable_elements(&self) {
        if self.clickable_elements.is_empty() && self.input_elements.is_empty() {
            term::warn("No interactive elements found on this page");
            return;
        }
        let buttons: Vec<&ClickableElement> = self.clickable_elements.iter().filter(|e| e.kind == "button").collect();
        let links: Vec<&ClickableElement> = self.clickable_elements.iter().filter(|e| e.kind == "link").collect();
        if !buttons.is_empty() {
            let rows: Vec<Vec<String>> = buttons.iter().map(|e| vec![e.number.to_string(), e.text.clone(), crate::extractors::title_case(&e.subtype), if e.in_form { "Yes".into() } else { "No".into() }]).collect();
            println!("{}", term::table(Some("🔘 Buttons"), &["#", "Button Text", "Type", "Form"], &rows));
        }
        if !links.is_empty() {
            let rows: Vec<Vec<String>> = links.iter().map(|e| vec![e.number.to_string(), e.text.clone(), e.url.clone().unwrap_or_default().chars().take(50).collect()]).collect();
            println!("{}", term::table(Some("🔗 Links"), &["#", "Link Text", "URL"], &rows));
        }
        if !self.input_elements.is_empty() {
            let rows: Vec<Vec<String>> = self
                .input_elements
                .iter()
                .map(|i| vec![i.number.to_string(), crate::extractors::title_case(&i.input_type), if i.name.is_empty() { format!("input_{}", i.number) } else { i.name.clone() }, if i.placeholder.is_empty() { "[No placeholder]".into() } else { i.placeholder.clone() }, i.current_value.clone().unwrap_or_default()])
                .collect();
            println!("{}", term::table(Some("✏️ Input Fields"), &["#", "Type", "Name", "Placeholder", "Typed"], &rows));
        }
        println!("\n{}", style("💡 Quick Actions:").bold());
        println!("• {} - Click a specific button", term::cyan("button <number>"));
        println!("• {} - Navigate to a specific link", term::cyan("link <number>"));
        println!("• {} - Click any button or link", term::cyan("click <number>"));
        println!("• {} - Type into the first input field", term::cyan("type <text>"));
        println!("• {} - Type into specific input field", term::cyan("type <number> <text>"));
        println!("• {} - Submit the first form found", term::cyan("submit"));
    }

    fn handle_input_command(&mut self, args: &[String]) {
        if self.input_elements.is_empty() {
            term::warn("No input fields found on this page");
            return;
        }
        if args.is_empty() {
            term::error("Please provide text to type: type <text> or type <field_number> <text>");
            return;
        }
        let (index, text) = match args[0].parse::<usize>() {
            Ok(n) if n >= 1 && n <= self.input_elements.len() => {
                let text = if args.len() > 1 {
                    args[1..].join(" ")
                } else {
                    Input::<String>::new().with_prompt(format!("Enter text for {}", self.input_elements[n - 1].name)).interact_text().unwrap_or_default()
                };
                (n - 1, text)
            }
            Ok(n) => {
                term::error(&format!("Input field #{n} not found. Use 'elements' to see available fields."));
                return;
            }
            Err(_) => (0, args.join(" ")),
        };
        let inp = &mut self.input_elements[index];
        inp.current_value = Some(text.clone());
        let name = if inp.name.is_empty() { format!("input_{}", inp.number) } else { inp.name.clone() };
        let input_type = inp.input_type.clone();
        let node = inp.node;
        // Type through the page's JavaScript when its realm is live so that
        // input/change listeners react (search-as-you-type, validation, ...).
        if let Some(node) = node {
            if self.js_type(node, &text) {
                let doc = self.current_response.as_ref().and_then(|r| r.document.as_ref()).cloned();
                if let Some(doc) = doc {
                    self.sdk.engine.current_document = Some(doc.clone());
                    self.refresh_elements_keep_typed(&doc);
                }
            }
        }
        term::success(&format!("✓ Typed '{text}' into {name} ({input_type} field)"));
    }

    /// Run a user action (see `BrowserEngine::user_action`) on the current page and show the result.
    fn user_act(&mut self, action: &str, target: &str, value: Option<&str>) {
        let url = match self.current_url.clone() {
            Some(u) => u,
            None => {
                term::error("No page loaded");
                return;
            }
        };
        let mut doc = match self.current_response.as_mut().and_then(|r| r.document.take()) {
            Some(d) => d,
            None => {
                term::error("No page loaded");
                return;
            }
        };
        let out = self.sdk.engine.user_action(&mut doc, &url, action, target, value);
        if let Some(r) = self.current_response.as_mut() {
            r.document = Some(doc);
        }
        for line in &out.console {
            term::info(&format!("console: {line}"));
        }
        if let Some(e) = out.report.get("error").and_then(|v| v.as_str()) {
            term::error(e);
            return;
        }
        let el = &out.report["el"];
        let desc = format!("<{}{}> {}", el["tag"].as_str().unwrap_or("?"), el["id"].as_str().filter(|s| !s.is_empty()).map(|s| format!(" #{s}")).unwrap_or_default(), el["text"].as_str().unwrap_or("").chars().take(60).collect::<String>());
        term::success(&format!("✓ {action} {desc}"));
        if let Some(v) = out.report.get("value").and_then(|v| v.as_str()) {
            term::info(&format!("value: {v}"));
        }
        if let Some(nav) = out.navigation {
            term::success(&format!("✓ Navigating to: {nav}"));
            self.browse_url_enhanced(&nav);
            return;
        }
        if let Some(sub) = out.submission {
            self.perform_script_submission(&sub);
            return;
        }
        if out.dom_changed {
            let doc = self.current_response.as_ref().and_then(|r| r.document.as_ref()).cloned();
            if let Some(doc) = doc {
                term::success("✓ Page updated by JavaScript:");
                let md = self.sdk.engine.render_page(&doc, false);
                println!("{}", term::render_markdown(&md));
                self.sdk.engine.current_document = Some(doc.clone());
                self.refresh_elements_keep_typed(&doc);
            }
        }
    }

    /// Wait until an element matching `target` exists (letting timers and fetches run).
    fn user_wait(&mut self, target: &str) {
        for _ in 0..20 {
            let url = match self.current_url.clone() { Some(u) => u, None => return };
            let mut doc = match self.current_response.as_mut().and_then(|r| r.document.take()) { Some(d) => d, None => return };
            let out = self.sdk.engine.user_action(&mut doc, &url, "exists", target, None);
            if let Some(r) = self.current_response.as_mut() {
                r.document = Some(doc);
            }
            if out.report.get("ok").is_some() {
                term::success(&format!("✓ {target} is present"));
                return;
            }
        }
        term::warn(&format!("{target} did not appear"));
    }

    /// Set an input's value via the live JS realm (dispatching input/change).
    /// Returns false when there is no live realm for the current page.
    fn js_type(&mut self, node: ego_tree::NodeId, text: &str) -> bool {
        let url = match self.current_url.clone() {
            Some(u) => u,
            None => return false,
        };
        if !self.sdk.engine.js_engine.is_live(&url) {
            return false;
        }
        let jbid = match self.sdk.engine.js_engine.jbid_of(node) {
            Some(i) => i,
            None => return false,
        };
        let doc = match self.current_response.as_mut().and_then(|r| r.document.as_mut()) {
            Some(d) => d,
            None => return false,
        };
        let script = format!(
            "(function(){{ var el = __jb.nodeById[{jbid}]; if (!el) return 'missing'; __jb.user.type(el, {}); return 'typed'; }})()",
            serde_json::to_string(text).unwrap_or_default()
        );
        let exec = self.sdk.engine.js_engine.execute_script(&script, Some(doc), &url);
        exec.result.as_deref() == Some("typed")
    }

    /// Re-extract clickable/input elements after a DOM change, keeping the
    /// values the user typed so far.
    fn refresh_elements_keep_typed(&mut self, doc: &Document) {
        let typed: Vec<(usize, String)> = self.input_elements.iter().filter_map(|i| i.current_value.clone().map(|v| (i.number, v))).collect();
        self.extract_clickable_elements(doc);
        for inp in &mut self.input_elements {
            if let Some((_, v)) = typed.iter().find(|(n, _)| *n == inp.number) {
                inp.current_value = Some(v.clone());
            }
        }
    }

    fn handle_click_command(&mut self, args: &[String]) {
        if self.clickable_elements.is_empty() {
            term::warn("No clickable elements found on this page");
            return;
        }
        let n: usize = match args.first().and_then(|a| a.parse().ok()) {
            Some(n) => n,
            None => {
                term::error("Please specify element number: click <number>");
                term::info("Use 'elements' to see all clickable elements");
                return;
            }
        };
        if n < 1 || n > self.clickable_elements.len() {
            term::error(&format!("Element #{n} not found. Use 'elements' to see available elements."));
            return;
        }
        let element = self.clickable_elements[n - 1].clone();
        println!("{}", style(format!("🖱️ Clicking: {}", element.text)).blue());
        if element.kind == "link" {
            let url = element.url.clone().unwrap_or_default();
            if let Some(anchor) = url.strip_prefix('#') {
                self.navigate_to_anchor(anchor);
                return;
            }
            let url = self.sdk.engine.resolve(&url);
            term::success(&format!("✓ Navigating to: {url}"));
            self.browse_url_enhanced(&url);
            return;
        }
        if element.subtype == "submit" && element.in_form {
            // With a live realm, click through JavaScript first: submit
            // listeners may handle the form (SPA search boxes, validation).
            let live = self.current_url.as_deref().map(|u| self.sdk.engine.js_engine.is_live(u)).unwrap_or(false);
            if live {
                term::success("✓ Submit button clicked");
                self.execute_button_javascript(&element);
                return;
            }
            term::success("✓ Submit button clicked - triggering form submission");
            self.submit_form_node(element.form);
            return;
        }
        term::success(&format!("✓ {} button clicked", crate::extractors::title_case(&element.subtype)));
        if self.should_attempt_form_submission(&element) {
            println!("{}", style("🔄 Search/submit button detected - attempting form submission...").blue());
            self.submit_form_node(element.form);
        } else if let Some(nav) = &element.nav_url {
            if let Some(anchor) = nav.strip_prefix('#') {
                self.navigate_to_anchor(anchor);
                return;
            }
            let url = self.sdk.engine.resolve(nav);
            term::success(&format!("✓ Button navigating to: {url}"));
            self.browse_url_enhanced(&url);
        } else {
            println!("{}", style("🔄 Executing JavaScript button interaction...").blue());
            self.execute_button_javascript(&element);
        }
    }

    fn execute_button_javascript(&mut self, element: &ClickableElement) {
        let (node, url) = match (element.node, self.current_url.clone()) {
            (Some(n), Some(u)) => (n, u),
            _ => return,
        };
        let live = self.sdk.engine.js_engine.is_live(&url);
        let doc = match self.current_response.as_mut().and_then(|r| r.document.as_mut()) {
            Some(d) => d,
            None => return,
        };
        let jbid = if live {
            self.sdk.engine.js_engine.jbid_of(node)
        } else {
            let (_, map) = crate::js::serialize_document(doc);
            map.iter().position(|n| *n == node)
        };
        let jbid = match jbid {
            Some(i) => i,
            None => return,
        };
        let script = format!("(function(){{ var el = __jb.nodeById[{jbid}]; if (el) __jb.user.click(el); return el ? 'clicked' : 'missing'; }})()");
        let exec = self.sdk.engine.js_engine.execute_script(&script, Some(doc), &url);
        for line in &exec.console {
            term::info(&format!("console: {line}"));
        }
        if let Some(nav) = exec.navigations.first() {
            let target = nav.url.clone();
            term::success(&format!("✓ Button navigated to: {target}"));
            self.browse_url_enhanced(&target);
            return;
        }
        if let Some(sub) = exec.form_submissions.first().cloned() {
            self.perform_script_submission(&sub);
            return;
        }
        if !exec.dom_updates.is_empty() {
            term::success("✓ Page updated by JavaScript:");
            let doc = self.current_response.as_ref().and_then(|r| r.document.as_ref()).cloned();
            if let Some(doc) = doc {
                let md = self.sdk.engine.render_page(&doc, false);
                println!("{}", term::render_markdown(&md));
                self.sdk.engine.current_document = Some(doc.clone());
                self.refresh_elements_keep_typed(&doc);
            }
        } else if !exec.errors.is_empty() {
            for e in &exec.errors {
                term::error(&format!("error: {}", e.lines().next().unwrap_or("")));
            }
        } else {
            term::info("Button action completed (no visible page change)");
        }
    }

    fn should_attempt_form_submission(&self, element: &ClickableElement) -> bool {
        let text = element.text.to_lowercase();
        let indicators = ["search", "submit", "send", "go", "find", "query", "ask"];
        let suggests = indicators.iter().any(|i| text.contains(i));
        let has_search_input = self.input_elements.iter().any(|i| i.input_type == "search" && i.current_value.is_some());
        suggests && (element.in_form || has_search_input)
    }

    fn handle_button_command(&mut self, args: &[String]) {
        let buttons: Vec<usize> = self.clickable_elements.iter().filter(|e| e.kind == "button").map(|e| e.number).collect();
        if buttons.is_empty() {
            term::warn("No buttons found on this page");
            return;
        }
        match args.first().and_then(|a| a.parse::<usize>().ok()) {
            Some(n) if n >= 1 && n <= buttons.len() => self.handle_click_command(&[buttons[n - 1].to_string()]),
            Some(n) => term::error(&format!("Button #{n} not found. Available buttons: 1-{}", buttons.len())),
            None => term::error("Please specify button number: button <number>"),
        }
    }

    fn handle_link_command(&mut self, args: &[String]) {
        let links: Vec<usize> = self.clickable_elements.iter().filter(|e| e.kind == "link").map(|e| e.number).collect();
        if links.is_empty() {
            term::warn("No links found on this page");
            return;
        }
        match args.first().and_then(|a| a.parse::<usize>().ok()) {
            Some(n) if n >= 1 && n <= links.len() => self.handle_click_command(&[links[n - 1].to_string()]),
            Some(n) => term::error(&format!("Link #{n} not found. Available links: 1-{}", links.len())),
            None => term::error("Please specify link number: link <number>"),
        }
    }

    fn handle_submit_command(&mut self) {
        self.submit_form_node(None);
    }

    fn submit_form_node(&mut self, form: Option<ego_tree::NodeId>) {
        let doc = match self.current_response.as_ref().and_then(|r| r.document.as_ref()) {
            Some(d) => d,
            None => {
                term::warn("No page loaded");
                return;
            }
        };
        let form = match form.or_else(|| dom::find_first(doc, "form")) {
            Some(f) => f,
            None => {
                term::warn("No forms found on this page");
                return;
            }
        };
        if self.js_submit_form(form) {
            return;
        }
        let doc = match self.current_response.as_ref().and_then(|r| r.document.as_ref()) {
            Some(d) => d,
            None => return,
        };
        let current_url = self.current_url.clone().unwrap_or_default();
        if current_url.is_empty() {
            term::error("Cannot resolve form action: no current URL available");
            return;
        }
        let action = dom::attr(doc, form, "action").unwrap_or_default();
        let method = dom::attr(doc, form, "method").unwrap_or_else(|| "GET".into()).to_ascii_uppercase();
        let typed: BTreeMap<String, String> = self.input_elements.iter().filter_map(|i| i.current_value.clone().map(|v| (if i.name.is_empty() { format!("input_{}", i.number) } else { i.name.clone() }, v))).collect();
        let data = forms::collect_form_data(doc, form, &typed);
        println!("{}", style(format!("🚀 Submitting form with data: {:?}", data.keys().collect::<Vec<_>>())).blue());
        if data.is_empty() {
            term::warn("No form data found. Make sure to type into input fields first.");
            return;
        }
        let action = forms::resolve_form_action(&action, &current_url);
        self.perform_submission(&action, &method, data);
    }

    /// Submit through the live page so the form's submit handlers (validation,
    /// AJAX submits, `preventDefault`) run as in a browser. Returns false when
    /// the page is not live (the caller then submits over HTTP directly).
    fn js_submit_form(&mut self, form: ego_tree::NodeId) -> bool {
        let url = match self.current_url.clone() {
            Some(u) => u,
            None => return false,
        };
        if !self.sdk.engine.js_engine.is_live(&url) {
            return false;
        }
        let jbid = match self.sdk.engine.js_engine.jbid_of(form) {
            Some(i) => i,
            None => return false,
        };
        let doc = match self.current_response.as_mut().and_then(|r| r.document.as_mut()) {
            Some(d) => d,
            None => return false,
        };
        let script = format!("(function(){{ var f = __jb.nodeById[{jbid}]; if (!f) return 'missing'; __jb.submitForm(f, null); return 'submitted'; }})()");
        let exec = self.sdk.engine.js_engine.execute_script(&script, Some(doc), &url);
        if exec.result.as_deref() != Some("submitted") {
            return false;
        }
        for line in &exec.console {
            term::info(&format!("console: {line}"));
        }
        if let Some(nav) = exec.navigations.first() {
            let target = nav.url.clone();
            term::success(&format!("✓ Form navigated to: {target}"));
            self.browse_url_enhanced(&target);
            return true;
        }
        if let Some(sub) = exec.form_submissions.first().cloned() {
            self.perform_script_submission(&sub);
            return true;
        }
        // The page's submit handler took over (preventDefault): show the result.
        term::success("✓ Form handled by page JavaScript:");
        let doc = self.current_response.as_ref().and_then(|r| r.document.as_ref()).cloned();
        if let Some(doc) = doc {
            let md = self.sdk.engine.render_page(&doc, false);
            println!("{}", term::render_markdown(&md));
            self.sdk.engine.current_document = Some(doc.clone());
            self.refresh_elements_keep_typed(&doc);
        }
        true
    }

    /// A submission the page's script started, sent as the realm encoded it.
    fn perform_script_submission(&mut self, sub: &crate::js::FormSubmission) {
        let (method, url, body, content_type) = sub.request();
        self.perform_submission_with(&sub.action, &method, sub.data_map(), Some((url, body, content_type)));
    }

    fn perform_submission(&mut self, action: &str, method: &str, data: BTreeMap<String, String>) {
        self.perform_submission_with(action, method, data, None);
    }

    /// `encoded`: (url, body, content type) of the request when the page realm encoded it.
    fn perform_submission_with(&mut self, action: &str, method: &str, data: BTreeMap<String, String>, encoded: Option<(String, Option<String>, Option<String>)>) {
        println!("{}", style(format!("🚀 Submitting form to {action}")).blue());
        term::info(&format!("Method: {method} | Data: {} fields", data.len()));
        if url::Url::parse(action).ok().and_then(|u| u.host_str().map(|h| h.to_string())).is_none() {
            term::error(&format!("Invalid form action URL: {action}"));
            return;
        }
        let (enc_url, enc_body, enc_type) = match encoded {
            Some((u, b, t)) => (Some(u), b, t),
            None => (None, None, None),
        };
        if method.eq_ignore_ascii_case("GET") {
            let full = enc_url.unwrap_or_else(|| http::append_query(action, &data));
            if ["google.com/search", "yahoo.com/search", "bing.com/search"].iter().any(|d| full.contains(d)) {
                term::info("Detected search engine - using enhanced search handling");
                self.handle_search_engine_result(&full, &data);
            } else {
                self.browse_url_enhanced(&full);
            }
            return;
        }
        println!("{}", style("Submitting POST form data...").blue());
        let mut headers = self.sdk.engine.get_js_enhanced_headers(action);
        if let Some(ct) = enc_type {
            headers.retain(|k, _| !k.eq_ignore_ascii_case("content-type"));
            headers.insert("Content-Type".into(), ct);
        }
        let body = enc_body.unwrap_or_else(|| http::url_encode_form(&data));
        match self.sdk.engine.proxy_request("POST", action, &headers, Some(body), 30) {
            Ok(resp) if resp.status < 400 => {
                let mut doc = self.sdk.engine.parse_response(&resp);
                self.sdk.engine.js_engine.invalidate_live();
                if self.sdk.engine.execute_js && self.sdk.engine.current_json_data.is_none() && !dom::find_all(&doc, &["script"]).is_empty() {
                    let exec = self.sdk.engine.js_engine.run_page(&mut doc, &resp.url, None);
                    self.sdk.engine.last_js = Some(exec);
                }
                self.current_url = Some(resp.url.clone());
                self.sdk.engine.current_url = Some(resp.url.clone());
                self.sdk.engine.current_document = Some(doc.clone());
                self.current_title = dom::title(&doc).unwrap_or_default();
                self.extract_page_links(&doc);
                self.extract_clickable_elements(&doc);
                let rendered = self.sdk.engine.render_page(&doc, false);
                println!("{}", term::render_markdown(&rendered));
                term::info(&format!("⏱️ {:.2}s • 🔗 {} links", resp.elapsed.as_secs_f64(), self.page_links.len()));
                term::success("✅ Form submitted successfully!");
                self.current_response = Some(SdkResult { success: true, url: resp.url.clone(), final_url: Some(resp.url), timestamp: chrono::Local::now().to_rfc3339(), content: Some(rendered), raw_html: Some(resp.text), document: Some(doc), ..Default::default() });
            }
            Ok(resp) => term::error(&format!("Form submission failed: {} {}", resp.status, resp.reason)),
            Err(e) => {
                term::error(&format!("POST submission failed: {e}"));
                term::warn("Falling back to GET submission...");
                let full = http::append_query(action, &data);
                self.browse_url_enhanced(&full);
            }
        }
    }

    fn handle_search_engine_result(&mut self, search_url: &str, data: &BTreeMap<String, String>) {
        let query = match data.get("q").or_else(|| data.get("p")) {
            Some(q) if !q.is_empty() => q.clone(),
            _ => {
                term::warn("No search query found");
                return;
            }
        };
        let engine = if search_url.contains("google.com") { "Google" } else if search_url.contains("yahoo.com") { "Yahoo" } else if search_url.contains("bing.com") { "Bing" } else { "search engine" };
        println!("{}", style(format!("🔍 Searching {engine} for: '{query}'")).blue());
        let encoded = http::url_encode_form(&BTreeMap::from([("q".to_string(), query.clone())]));
        let encoded = encoded.trim_start_matches("q=").to_string();
        let alternatives: Vec<String> = if search_url.contains("yahoo.com") {
            vec![format!("https://search.yahoo.com/search?p={encoded}"), search_url.to_string()]
        } else if search_url.contains("bing.com") {
            vec![format!("https://www.bing.com/search?q={encoded}"), search_url.to_string()]
        } else {
            vec![format!("https://www.google.com/search?q={encoded}&num=10&hl=en"), search_url.to_string()]
        };
        for (i, alt) in alternatives.iter().enumerate() {
            term::info(&format!("Attempt {}: Trying enhanced search method", i + 1));
            self.browse_url_enhanced(alt);
            let content = self.current_response.as_ref().and_then(|r| r.content.clone()).unwrap_or_default().to_lowercase();
            let js_redirect = ["click if you are not redirected", "please enable javascript", "javascript is required", "/httpservice/retry/enablejs"].iter().any(|p| content.contains(p));
            if content.len() > 1000 && content.contains(&query.to_lowercase()) && !js_redirect {
                term::success("✅ Successfully retrieved search results");
                return;
            }
        }
        term::warn(&format!("⚠️ {engine} is requiring JavaScript - trying alternative search..."));
        let ddg = format!("https://duckduckgo.com/html/?q={encoded}");
        println!("{}", style(format!("🦆 Searching DuckDuckGo for: '{query}'")).blue());
        self.browse_url_enhanced(&ddg);
        let content = self.current_response.as_ref().and_then(|r| r.content.clone()).unwrap_or_default().to_lowercase();
        if content.contains(&query.to_lowercase()) && content.len() > 1000 {
            term::success("✅ Successfully retrieved search results from DuckDuckGo");
        } else {
            term::warn("Search engines are having issues. Try browsing to specific websites directly.");
        }
    }

    fn handle_bookmark_command(&mut self, args: &[String]) {
        match args.first().map(|s| s.as_str()) {
            Some("add") => {
                let name = args.get(1).cloned().unwrap_or_else(|| self.current_title.clone());
                match &self.current_url {
                    Some(u) => {
                        self.bookmarks.insert(name.clone(), u.clone());
                        term::success(&format!("✓ Bookmarked '{name}' → {u}"));
                    }
                    None => term::warn("No page loaded to bookmark"),
                }
            }
            Some("remove") | Some("rm") => {
                let name = args.get(1).cloned().unwrap_or_default();
                if self.bookmarks.remove(&name).is_some() {
                    term::success(&format!("✓ Removed bookmark '{name}'"));
                } else {
                    term::warn(&format!("No bookmark named '{name}'"));
                }
            }
            Some("open") | Some("go") => {
                let name = args.get(1).cloned().unwrap_or_default();
                match self.bookmarks.get(&name).cloned() {
                    Some(u) => {
                        self.browse_url_enhanced(&u);
                    }
                    None => term::warn(&format!("No bookmark named '{name}'")),
                }
            }
            _ => self.show_bookmarks(),
        }
    }

    fn show_bookmarks(&self) {
        if self.bookmarks.is_empty() {
            term::warn("No bookmarks saved. Use 'bookmark add <name>'.");
            return;
        }
        let rows: Vec<Vec<String>> = self.bookmarks.iter().map(|(k, v)| vec![k.clone(), v.clone()]).collect();
        println!("{}", term::table(Some("🔖 Bookmarks"), &["Name", "URL"], &rows));
    }

    fn handle_js_command(&mut self, args: &[String]) {
        if args.is_empty() {
            term::error("Usage: js <javascript code>");
            return;
        }
        let code = args.join(" ");
        let url = match self.current_url.clone() {
            Some(u) => u,
            None => {
                term::warn("No page loaded");
                return;
            }
        };
        let doc = match self.current_response.as_mut().and_then(|r| r.document.as_mut()) {
            Some(d) => d,
            None => return,
        };
        let exec = self.sdk.engine.js_engine.execute_script(&code, Some(doc), &url);
        for line in &exec.console {
            term::info(&format!("console: {line}"));
        }
        for e in &exec.errors {
            term::error(&format!("error: {e}"));
        }
        if let Some(r) = &exec.result {
            println!("{}", style(format!("→ {r}")).green());
        }
        if !exec.dom_updates.is_empty() {
            term::success(&format!("✓ {} DOM update(s) applied", exec.dom_updates.len()));
            if let Some(doc) = self.current_response.as_ref().and_then(|r| r.document.as_ref()).cloned() {
                self.extract_clickable_elements(&doc);
                self.sdk.engine.current_document = Some(doc);
            }
        }
    }

    fn show_js_console(&self) {
        match &self.sdk.engine.last_js {
            Some(js) => {
                if js.console.is_empty() && js.errors.is_empty() {
                    term::info("JavaScript console is empty");
                }
                for l in &js.console {
                    println!("{l}");
                }
                for e in &js.errors {
                    term::error(e);
                }
                if !js.api_calls.is_empty() {
                    let rows: Vec<Vec<String>> = js.api_calls.iter().map(|c| vec![c.method.clone(), c.url.chars().take(70).collect(), c.status.to_string()]).collect();
                    println!("{}", term::table(Some("🌐 Network calls from JavaScript"), &["Method", "URL", "Status"], &rows));
                }
                if js.websocket_messages > 0 || js.open_connections > 0 {
                    term::info(&format!("🔌 WebSocket/EventSource: {} messages received, {} connection(s) still open", js.websocket_messages, js.open_connections));
                }
                for n in &js.notifications {
                    println!("🔔 {}{}", n.title, if n.body.is_empty() { String::new() } else { format!(" — {}", n.body) });
                }
                if !js.canvas_text.is_empty() {
                    term::info(&format!("🎨 Canvas text: {}", js.canvas_text.join(" | ")));
                }
                if !js.cookies_set.is_empty() {
                    term::info(&format!("🍪 {} cookie(s) set by JavaScript", js.cookies_set.len()));
                }
            }
            None => term::info("No JavaScript has been executed yet"),
        }
    }

    fn handle_proxy_command(&mut self, args: &[String]) {
        let proxy = &self.sdk.engine.proxy;
        match args.first().map(|s| s.as_str()) {
            Some("start") => {
                proxy.start();
                term::success("✓ Proxy started - all traffic will be intercepted");
            }
            Some("stop") => {
                proxy.stop();
                term::success("✓ Proxy stopped");
            }
            Some("status") => term::print_json(&proxy.get_status()),
            Some("traffic") => {
                let limit = args.get(1).and_then(|a| a.parse().ok()).unwrap_or(20);
                let rows: Vec<Vec<String>> = proxy
                    .get_traffic_log(limit, None)
                    .iter()
                    .map(|t| vec![t["request"]["method"].as_str().unwrap_or("").to_string(), t["request"]["url"].as_str().unwrap_or("").chars().take(70).collect(), t["response"]["status_code"].to_string(), t["modified"].to_string()])
                    .collect();
                if rows.is_empty() {
                    term::info("No traffic recorded (is the proxy started?)");
                } else {
                    println!("{}", term::table(Some("📡 Proxy Traffic"), &["Method", "URL", "Status", "Modified"], &rows));
                }
            }
            Some("clear") => {
                proxy.clear_traffic_log();
                term::success("✓ Traffic log cleared");
            }
            Some("rules") => term::print_json(&serde_json::Value::Array(proxy.list_rules())),
            Some("rule") => {
                let json = args[1..].join(" ");
                match serde_json::from_str::<serde_json::Value>(&json) {
                    Ok(v) => term::print_json(&proxy.add_declarative_rule(&v)),
                    Err(e) => term::error(&format!("Invalid rule JSON: {e}")),
                }
            }
            _ => term::info("Usage: proxy start|stop|status|traffic [n]|clear|rules|rule <json>"),
        }
    }

    fn show_version_info(&self) {
        let body = format!(
            "{}\n\n{}\n• HTML/CSS rendering to markdown for the terminal\n• JavaScript execution with Mozilla SpiderMonkey ({})\n• Complete navigation with history and bookmarks\n• JSON API support with search capabilities\n• Interactive forms, numbered elements and an AI agent SDK\n• Burp-style intercepting proxy\n\n{}\n• Rust {} • reqwest • html5ever/scraper • mozjs\n",
            style(format!("🌐 Julia Browser v{}", env!("CARGO_PKG_VERSION"))).bold(),
            style("Core Features:").bold(),
            "mozjs 0.26",
            style("Technology Stack:").bold(),
            "stable"
        );
        println!("{}", term::panel("Version Information", &body));
    }
}

/// Heuristic URL detection for bare input.
pub fn looks_like_url(text: &str) -> bool {
    let lower = text.to_lowercase();
    if lower.contains(' ') {
        return false;
    }
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("www.") || lower.starts_with("localhost") || regex::Regex::new(r"\.[a-z]{2,}(/|$|:)").unwrap().is_match(&lower)
}

#[allow(dead_code)]
fn button_summary(b: &ButtonInfo) -> String {
    format!("{}. {} ({})", b.number, b.text, b.button_type)
}

fn vault_command(action: VaultAction) -> i32 {
    use crate::vault::{self, Login, Vault};
    let fail = |e: String| {
        term::error(&e);
        1
    };
    let _g = vault::lock();
    match action {
        VaultAction::Status => match Vault::open() {
            Ok(v) => {
                println!("vault:      {}", vault::dir().join("vault.jbv").display());
                println!("protection: {} (AES-256-GCM)", v.protection());
                println!("logins:     {}", v.logins().len());
                println!("passkeys:   {}", v.passkeys().len());
                println!("allowed:    {}", if v.allowed_sites().is_empty() { "(none: the agent cannot use credentials yet)".to_string() } else { v.allowed_sites().join(", ") });
                println!("security keys: {}", if v.security_key_sites().is_empty() { "(no sites)".to_string() } else { v.security_key_sites().join(", ") });
                println!("audit log:  {}", vault::dir().join("vault-audit.jsonl").display());
                0
            }
            Err(e) => fail(e),
        },
        VaultAction::Add { site, username, password, generate, totp, title, allow } => {
            let url = if site.contains("://") { site.clone() } else { format!("https://{site}") };
            if vault::host_of(&url).is_empty() {
                return fail(format!("not a site: {site}"));
            }
            let password = match (password, generate) {
                (Some(p), _) => p,
                (None, true) => {
                    let p = vault::generate_password(20);
                    println!("generated password: {p}");
                    p
                }
                (None, false) => match dialoguer::Password::new().with_prompt(format!("Password for {username} on {}", vault::host_of(&url))).interact() {
                    Ok(p) => p,
                    Err(e) => return fail(format!("no password: {e}")),
                },
            };
            let mut v = match Vault::open() {
                Ok(v) => v,
                Err(e) => return fail(e),
            };
            let id = v.add_login(Login { title: title.unwrap_or_default(), urls: vec![url.clone()], username: username.clone(), password, totp, source: "cli".into(), ..Default::default() });
            if allow {
                v.allow(&vault::base_domain(&vault::host_of(&url)));
            }
            match v.save() {
                Ok(()) => {
                    vault::audit("add", &vault::host_of(&url), &username, "", true, &format!("item {id}"));
                    term::success(&format!("Saved {username} on {} (id {id}){}", vault::host_of(&url), if allow { ", site allowed" } else { "" }));
                    0
                }
                Err(e) => fail(e),
            }
        }
        VaultAction::List { site } => match Vault::open() {
            Ok(v) => {
                let host = site.as_deref().map(vault::host_of);
                let logins: Vec<&Login> = match &host {
                    Some(h) => v.logins_for(h),
                    None => v.logins().iter().collect(),
                };
                for l in logins {
                    println!("{:<12}  {:<28}  {:<30}  {}{}", l.id, vault::host_of(l.urls.first().map(String::as_str).unwrap_or("")), l.username, l.source, if l.totp.is_some() { "  [totp]" } else { "" });
                }
                for p in v.passkeys() {
                    let s = |k: &str| p.get(k).and_then(serde_json::Value::as_str).unwrap_or("").to_string();
                    if host.as_ref().map_or(true, |h| vault::base_domain(h) == vault::base_domain(&s("rpId"))) {
                        let hidden = if p.get("hidden").and_then(serde_json::Value::as_bool) == Some(true) { "  [hidden by the site]" } else { "" };
                        println!("passkey       {:<28}  {:<30}  {}  id {}{hidden}", s("rpId"), s("userName"), s("source"), s("credentialId"));
                    }
                }
                0
            }
            Err(e) => fail(e),
        },
        VaultAction::Show { id, reveal } => match Vault::open() {
            Ok(v) => match v.find(&id) {
                Some(l) => {
                    println!("id:       {}\ntitle:    {}\nurls:     {}\nusername: {}\npassword: {}\ntotp:     {}\nsource:   {}\nupdated:  {}", l.id, l.title, l.urls.join(" "), l.username, if reveal { l.password.clone() } else { "(hidden; --reveal shows it)".into() }, if l.totp.is_some() { "yes" } else { "no" }, l.source, l.updated);
                    if reveal {
                        vault::audit("reveal", &vault::host_of(l.urls.first().map(String::as_str).unwrap_or("")), &l.username, "shown on the command line", true, &format!("item {}", l.id));
                    }
                    0
                }
                None => fail(format!("no single login matches {id}")),
            },
            Err(e) => fail(e),
        },
        VaultAction::Remove { id } => match Vault::open() {
            Ok(mut v) => {
                let id = v.find(&id).map(|l| l.id.clone()).unwrap_or(id);
                if !v.remove(&id) {
                    return fail(format!("nothing in the vault has id {id}"));
                }
                match v.save() {
                    Ok(()) => {
                        vault::audit("remove", "", "", "", true, &format!("item {id}"));
                        term::success(&format!("Removed {id}"));
                        0
                    }
                    Err(e) => fail(e),
                }
            }
            Err(e) => fail(e),
        },
        VaultAction::Import { file, format } => {
            drop(_g);
            match vault::import_file(std::path::Path::new(&file), &format) {
                Ok(r) => {
                    term::success(&format!("Imported {} logins and {} passkeys ({}); skipped {}", r.logins, r.passkeys, r.format, r.skipped));
                    for n in r.notes.iter().take(10) {
                        term::warn(n);
                    }
                    term::info("The agent can use them only on allowed sites: julia-browser vault allow <site>. Delete the export file now; it is not encrypted.");
                    0
                }
                Err(e) => fail(e),
            }
        }
        VaultAction::Export { file, format, yes } => {
            if !matches!(format.as_str(), "cxf" | "csv") {
                return fail("--format is cxf or csv".into());
            }
            if !yes {
                return fail("the export file holds every secret unencrypted; add --yes to write it".into());
            }
            match vault::export_file(std::path::Path::new(&file), &format) {
                Ok((l, p)) => {
                    term::success(&format!("Wrote {l} logins{} to {file}", if format == "cxf" { format!(" and {p} passkeys") } else { String::new() }));
                    0
                }
                Err(e) => fail(e),
            }
        }
        VaultAction::Allow { sites } => match Vault::open() {
            Ok(mut v) => {
                for s in &sites {
                    v.allow(s);
                }
                match v.save() {
                    Ok(()) => {
                        vault::audit("allow", &sites.join(" "), "", "", true, "");
                        term::success(&format!("Allowed: {}", v.allowed_sites().join(", ")));
                        0
                    }
                    Err(e) => fail(e),
                }
            }
            Err(e) => fail(e),
        },
        VaultAction::Deny { sites } => match Vault::open() {
            Ok(mut v) => {
                for s in &sites {
                    v.deny(s);
                }
                match v.save() {
                    Ok(()) => {
                        vault::audit("deny", &sites.join(" "), "", "", true, "");
                        term::success(&format!("Allowed: {}", if v.allowed_sites().is_empty() { "(none)".to_string() } else { v.allowed_sites().join(", ") }));
                        0
                    }
                    Err(e) => fail(e),
                }
            }
            Err(e) => fail(e),
        },
        VaultAction::Sites => match Vault::open() {
            Ok(v) => {
                for s in v.allowed_sites() {
                    println!("{s}");
                }
                0
            }
            Err(e) => fail(e),
        },
        VaultAction::Log { last } => {
            for e in vault::read_audit(last) {
                let s = |k: &str| e.get(k).and_then(serde_json::Value::as_str).unwrap_or("").to_string();
                let ok = e.get("allowed").and_then(serde_json::Value::as_bool).unwrap_or(false);
                println!("{}  {:<14} {:<6} {:<24} {:<24} {}{}", s("time"), s("action"), if ok { "ok" } else { "DENIED" }, s("site"), s("account"), s("reason"), if s("detail").is_empty() { String::new() } else { format!("  ({})", s("detail")) });
            }
            0
        }
        VaultAction::Totp { id } => match Vault::open() {
            Ok(v) => match v.find(&id) {
                Some(l) => match l.totp.as_deref().map(vault::totp_now) {
                    Some(Ok(code)) => {
                        vault::audit("totp", &vault::host_of(l.urls.first().map(String::as_str).unwrap_or("")), &l.username, "shown on the command line", true, &format!("item {}", l.id));
                        println!("{code}");
                        0
                    }
                    Some(Err(e)) => fail(e),
                    None => fail(format!("{} has no one-time code secret", l.id)),
                },
                None => fail(format!("no single login matches {id}")),
            },
            Err(e) => fail(e),
        },
        VaultAction::Generate { length } => {
            println!("{}", vault::generate_password(length));
            0
        }
        VaultAction::SecurityKey { sites, off } => match Vault::open() {
            Ok(mut v) => {
                for s in &sites {
                    v.set_security_key(s, !off);
                }
                if !sites.is_empty() {
                    if let Err(e) = v.save() {
                        return fail(e);
                    }
                    vault::audit(if off { "security_key_off" } else { "security_key_on" }, &sites.join(" "), "", "", true, "");
                }
                let list = v.security_key_sites();
                term::success(&format!("Security-key sites: {}", if list.is_empty() { "(none)".to_string() } else { list.join(", ") }));
                if !off && !sites.is_empty() && !cfg!(windows) {
                    term::warn("security keys need Windows (webauthn.dll) in this build");
                }
                0
            }
            Err(e) => fail(e),
        },
        VaultAction::Scope { .. } => 0,
    }
}
