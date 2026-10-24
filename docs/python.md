# Python

```bash
pip install julia-browser
```

## Drive a page

```python
from julia_browser import Browser

with Browser() as b:
    b.open("https://news.ycombinator.com")
    print(b.title)
    b.click("text=new")                      # CSS selectors or text=...
    print(b.read()[:800])                    # readable markdown of the live page
    stories = b.eval("[...document.querySelectorAll('.titleline > a')].map(a => a.textContent)")
    b.screenshot(path="hn.png")              # viewport PNG (full_page=True for the whole page)
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

`Browser` methods:

- Navigation and reading: `open`, `read`, `content`, `url`, `title`, `eval`
- Mouse: `click`, `click_at`, `dblclick`, `hover`, `drag`, `drag_at`
- Keyboard and forms: `focus`, `type`, `fill`, `press`, `keyboard_type`, `check`, `uncheck`, `select`, `upload`
- Scrolling and waiting: `scroll`, `scroll_into_view`, `wait`
- Output and state: `screenshot`, `pdf`, `cookies`, `set_cookie`
- Vault: `login`, `otp`, `new_password`
- Any other session command: `command`

A failed action raises `julia_browser.BrowserError`.

`eval(code, settle=False)` reads the page as it is, without letting its timers and network run
afterwards. That is much faster for observations.

Options:

```python
Browser(user_agent=None, javascript=True, js_budget_ms=8000, timeout=30,
        geolocation=(lat, lon), notifications="granted", settle_ms=2500,
        websockets=True, service_workers=True, external_scripts=True, clipboard=False,
        profile_dir=None)     # profile_dir: per-browser localStorage/IndexedDB ("" = in memory)
```

Each `Browser`, `AgentSDK` and `BrowserSDK` owns its own engine thread. Calls release the GIL, so
several browsers can work in parallel from Python threads.

## One call

```python
import julia_browser as jb

md = jb.render("https://example.com")                 # also "text", "html", "layout"
png = jb.screenshot("https://example.com", "example.png")
```

From a shell: `python -m julia_browser https://example.com -f text`.

## Vault

```python
from julia_browser import Browser, Vault

Vault.import_file("bitwarden.json")      # or a CSV from Chrome, Apple Passwords, 1Password, ...
Vault.allow("github.com")                # the agent may use credentials only on allowed sites
with Browser() as b:
    b.open("https://github.com/login")
    b.login(reason="read my notifications")
    b.click("input[type=submit]")
    b.otp(reason="2FA prompt")
print(Vault.log())
```

See [Password and passkey vault](vault.md).

## Puppeteer and Playwright

```python
import julia_browser
from playwright.sync_api import sync_playwright

server = julia_browser.serve_cdp(port=0)        # port=0 picks a free port
with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(server.url)
    page = browser.contexts[0].new_page()
    page.goto("https://news.ycombinator.com")
    print(page.title())
```

`serve_cdp()` accepts `host`, `javascript`, `js_budget_ms` and `user_agent`. See
[Puppeteer and Playwright](cdp.md).

## Numbered-element API (julia-browser 2.x compatible)

```python
from julia_browser import AgentSDK

agent = AgentSDK()
page = agent.open_website("https://example.com")
print(page["content"])                     # markdown of the page
print(agent.list_elements()["summary"])    # numbered buttons, inputs and links
agent.type_text(1, "hello")
agent.click_element(1)
agent.follow_link(2)
```

`BrowserSDK` keeps the 2.x rendering calls (`render_to_markdown`, `fetch_page`, `get_page_links`,
`search_page`, `batch_process`, `submit_form`, ...) and adds `render_to_layout` and `render_to_png`.
