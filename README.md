# Julia Browser

**The headless browser for AI agents, written in Rust.**

Not a Chromium wrapper. Julia Browser runs pages with real JavaScript (Mozilla SpiderMonkey)
against its own DOM, lays them out with Stylo + Taffy, and gives agents what they need: the page as
Markdown, numbered elements, trusted clicks and typing, screenshots, an encrypted credential vault,
and a Chrome DevTools Protocol server for Puppeteer and Playwright.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why Julia Browser?

### Built for agents, not adapted for them

Most agent tooling puts a desktop browser behind a remote-control protocol. Julia Browser was
designed from the start around what an agent does:

- read the page
- find the control it needs
- act on that control
- check what changed

Every part of the engine answers to that loop.

### The web as it really runs

Modern sites are applications: React, Vue, Angular, Svelte, web components, service workers and
module bundles. A fetch-and-parse scraper sees an empty shell. Julia Browser runs the page's own
JavaScript in Mozilla SpiderMonkey, the engine inside Firefox. Pages run against a standards-based
DOM that scores above 90% on the core Web Platform Tests suites (html, dom, shadow-dom, url). The
page stays live after it loads, so single-page apps keep working as the agent clicks through them.

### Output an agent can read

A raw DOM dump is noisy, and reading only screenshots is slow and expensive. Julia Browser gives the
model what a person would take in:

- the page as Markdown, in visual order, with landmarks and overlays marked
- numbered controls with their labels, values and state
- a screenshot when the task needs one

The same layout engine as Firefox (Stylo) decides what is visible. Closed menus, hidden panels and
off-screen content don't distract the agent.

### Input that frameworks trust

Clicks, typing, key presses, drags and uploads go through the full pointer and keyboard event
sequence, as trusted events. Controlled inputs, autocomplete boxes, custom dropdowns and date
pickers react as they do for a person. The agent works with selectors, visible text, element
numbers or screen coordinates.

### Credentials the model never sees

The built-in vault stores passwords, TOTP secrets and passkeys encrypted on disk:

- The agent asks to sign in, and the browser fills the fields itself. Secrets never appear in
  prompts, logs or tool results.
- Each site has to be allowed explicitly, and every use is written to an audit log.
- WebAuthn passkeys and hardware security keys work too.

### Fits the stack you already have

One engine with a choice of front ends:

| Front end | Use |
| --- | --- |
| CLI | Humans and shell scripts |
| Persistent agent session | Command-by-command agents |
| Python package | `pip install julia-browser`, nothing else to install |
| Rust library | Embedding the engine |
| Chrome DevTools Protocol server | Existing Puppeteer and Playwright code, unchanged |

There is no Chrome binary to ship, no driver process and no GPU. Each page runs on its own engine
thread, so many browsers run side by side in one process.

### Proven on real tasks

On Online-Mind2Web and WebVoyager, julia-browser with a small, low-cost model (Claude Haiku 5.5)
completes about 87% of tasks on live websites: shopping, travel, government, documentation and
media sites. See the benchmarks below.

## Benchmarks

Agent and research benchmarks on live websites, with julia-browser as the browser and Claude Haiku 5.5
as the model:

| Benchmark | julia-browser + Haiku 5.5 |
| --- | --- |
| Online-Mind2Web (300 tasks, 136 sites) | **87.0%** task success |
| WebVoyager (643 tasks, 15 sites) | **86.9%** task success |
| SimpleQA, end to end (search, fetch, answer) | **90.0%** correct |
| SimpleQA, first search result contains the answer | **76.0%** |
| BrowseComp (100 questions) | **40%** correct, 100% completed |

- Judges are condensed versions of the official graders, run on Claude Haiku 5.5.
- WebVoyager tasks whose dates are already past were moved forward to future dates.
- The harness, datasets, more suites and the methodology are in [`benchmarks/`](benchmarks/README.md).

## Quick start

### Install

```bash
pip install julia-browser               # Python package with the engine built in
```

To build the `julia-browser` binary from source, see [Build from source](#build-from-source).

### Read a page

```bash
julia-browser browse https://news.ycombinator.com                  # Markdown, after the page's JavaScript ran
julia-browser render https://example.com --format png -o page.png  # pixels
julia-browser render https://example.com --format layout           # the laid-out page as text
julia-browser eval https://example.com "document.title"
```

### Drive a page

A persistent session keeps the page live between commands:

```bash
julia-browser open https://duckduckgo.com/html/
julia-browser fill "input[name=q]" "rust browser engine"
julia-browser press Enter
julia-browser read
julia-browser screenshot results.png --annotate     # numbered elements; then: julia-browser click @3
julia-browser close
```

### Python

```python
from julia_browser import Browser

with Browser() as b:
    b.open("https://news.ycombinator.com")
    b.click("text=new")
    print(b.read()[:800])
    b.screenshot(path="hn.png")
```

### Web agent

[`web-agent/`](web-agent/README.md) is a general agent: Claude decides, julia-browser browses.

```bash
pip install -e web-agent
julia-web-agent "Who designed Rust and when did it first appear?" --start-url https://en.wikipedia.org
```

### Puppeteer and Playwright

```bash
julia-browser cdp --port 9222
```

```js
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222" });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
```

From Python, `julia_browser.serve_cdp(port=0)` starts the same server in-process.

## Status

- JavaScript: SpiderMonkey with classic and ES module scripts, import maps, `async`/`defer`,
  `document.write`, workers, shared workers and service workers
- DOM: events, shadow DOM, custom elements, ranges and selection, editing (`execCommand`)
- Frames and windows: iframes and popups in their own realms, with cross-origin rules
- Navigation: `history`, the Navigation API, form submission
- Network: an HTTP session with cookies, CORS, fetch metadata, referrer policy, Content Security
  Policy, `fetch`/XHR, WebSocket and EventSource
- Layout and paint: blitz-dom (Stylo cascade, Taffy flex/grid/block, Parley text); CPU screenshots
  and PDF (vello); Canvas 2D; image decoding including AVIF
- Markdown output in visual order, with overlays, landmarks and numbered controls
- Agent interaction: trusted pointer and keyboard events, `text=` selectors, uploads, drag, scrolling
- Persistent agent sessions behind a CLI, plus Rust and Python SDKs
- Chrome DevTools Protocol server: Puppeteer and Playwright
- Password and passkey vault: AES-256-GCM, WebAuthn and FIDO2, TOTP, audit log
- Intercepting proxy with declarative rules
- Web Platform Tests: html 93.9%, dom 96.1%, shadow-dom 97.3%, url 97.4%, encoding 100%
  ([all scores](docs/web-platform-tests.md))

## Build from source

Requirements:

- Rust 1.80 or later
- On Windows, the MSVC build tools
- Python 3 (Stylo's build script runs it)

SpiderMonkey comes prebuilt from `mozjs`.

```bash
make build        # cargo build --release --features screenshot,images
make build-dev    # debug build, same features
make wheel        # Python wheel (maturin + delvewheel)
```

The binaries are `julia-browser` (also installed as `jbrowser` and `jb`) and `wpt`. Cargo
features: [docs/install.md](docs/install.md).

## Test

```bash
make test            # cargo test --features screenshot,images
make interact-check  # TodoMVC (React/Vue/Svelte/Angular/...), search, GitHub, MDN scenarios on live sites
make wpt SUITE=dom   # one Web Platform Tests suite against ../wpt
```

The WPT runner, its options and the result tools are described in
[docs/web-platform-tests.md](docs/web-platform-tests.md).

## Documentation

Guides are in [`docs/`](docs/README.md):

- [Install](docs/install.md), [Command line](docs/cli.md), [Agent commands](docs/agent-commands.md)
- [Python](docs/python.md), [Web agent](docs/web-agent.md), [Puppeteer and Playwright](docs/cdp.md)
- [Vault](docs/vault.md), [Rendering and screenshots](docs/rendering.md), [Rust library](docs/rust-library.md)
- [Web APIs](docs/web-apis.md), [Configuration](docs/configuration.md), [Web Platform Tests](docs/web-platform-tests.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
