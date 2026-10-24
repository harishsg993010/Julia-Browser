# julia-browser

A headless web browser you can `pip install`. Pages run real JavaScript in Mozilla
SpiderMonkey against a full DOM, are laid out with Stylo + Taffy (the CSS engines from
Servo/Firefox), and can be screenshotted, read as markdown, or driven by clicks and typing.
The engine is written in Rust; this package is its Python binding (PyO3). No Chrome, no
Node, no driver process.

```
pip install julia-browser
```

## Drive a page

```python
from julia_browser import Browser

with Browser() as b:
    b.open("https://news.ycombinator.com")
    print(b.title)
    b.click("text=new")                     # CSS selectors or text=...
    print(b.read()[:800])                    # readable markdown of the live page
    stories = b.eval("[...document.querySelectorAll('.titleline > a')].map(a => a.textContent)")
    b.screenshot(path="hn.png")              # PNG of the viewport (full_page=True for all of it)
```

Forms:

```python
with Browser() as b:
    b.open("https://duckduckgo.com/html/")
    b.fill("input[name=q]", "servo layout engine")
    b.press("Enter")
    b.wait("#links")
    print(b.read())
```

`Browser` methods: `open`, `read`, `content`, `url`, `title`, `click`, `dblclick`, `hover`,
`focus`, `type`, `fill`, `press`, `check`, `uncheck`, `select`, `scroll`, `scroll_into_view`,
`drag`, `upload`, `keyboard_type`, `wait`, `eval`, `screenshot`, `pdf`, `cookies`,
`set_cookie`. Failed actions raise `julia_browser.BrowserError`.

Options: `Browser(user_agent=..., javascript=True, js_budget_ms=8000,
geolocation=(lat, lon), notifications="granted", settle_ms=2500, websockets=True,
service_workers=True)`.

## Password + passkey vault

```python
from julia_browser import Browser, Vault

Vault.import_file("bitwarden.json")       # or a CSV from Chrome, Apple Passwords, 1Password, ...
Vault.allow("github.com")                 # agent use is limited to allowed sites
with Browser() as b:
    b.open("https://github.com/login")
    b.login(reason="read my notifications")   # typed inside the browser; never returned
    b.click("input[type=submit]")
    b.otp(reason="2FA prompt")                 # current TOTP code, if the login has one
print(Vault.log())                             # what was used, where, when and why
```

`Vault.security_key("github.com")` sends a site's WebAuthn to a physical FIDO key or Windows
Hello instead (a person answers the prompt). Passkeys (WebAuthn, with the `prf` extension) are stored in the same encrypted vault and used by the page's
`navigator.credentials` calls. See the main README for the encryption details.

## One call

```python
import julia_browser as jb

md = jb.render("https://example.com")                # markdown (also "text", "html", "layout")
png = jb.screenshot("https://example.com", "example.png")
```

or from a shell: `python -m julia_browser https://example.com -f text`.

## Puppeteer / Playwright (Chrome DevTools Protocol)

`serve_cdp()` serves the Chrome DevTools Protocol from your process, so existing Playwright
or Puppeteer code can drive julia-browser instead of Chrome:

```python
import julia_browser
from playwright.sync_api import sync_playwright

server = julia_browser.serve_cdp(port=0)        # port=0 picks a free port
with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(server.url)
    page = browser.contexts[0].new_page()
    page.goto("https://news.ycombinator.com")
    page.get_by_role("link", name="new", exact=True).click()
    print(page.title())
```

From Node: `puppeteer.connect({ browserURL: server.url })`. The `julia-browser` CLI also has
`julia-browser cdp --port 9222`. `serve_cdp()` accepts `host`, `javascript=False`,
`js_budget_ms` and `user_agent`; the server stops when the process exits. Each page opened by
the client gets its own engine thread.

## Agent API (julia-browser 2.x compatible)

```python
from julia_browser import AgentSDK

agent = AgentSDK()
page = agent.open_website("https://example.com")
print(page["content"])               # markdown of the page
print(agent.list_elements()["summary"])   # numbered buttons / inputs / links
agent.type_text(1, "hello")
agent.click_element(1)
agent.follow_link(2)
```

`BrowserSDK` keeps the 2.x rendering calls (`render_to_markdown`, `fetch_page`,
`get_page_links`, `search_page`, `batch_process`, `submit_form`, ...) and adds
`render_to_layout` and `render_to_png`.

## Notes

* Each `Browser` / `AgentSDK` / `BrowserSDK` owns a dedicated engine thread. Calls release the
  GIL, so several browsers can work in parallel from Python threads.
* Cookies and `localStorage` persist in the user profile directory, like a desktop browser.