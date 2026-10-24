"""Julia Browser: a headless web browser with real JavaScript (Mozilla SpiderMonkey),
layout and screenshots, written in Rust and usable from Python.

Three ways in:

* :class:`Browser` drives a live page with CSS / text selectors, like a person would::

      from julia_browser import Browser

      with Browser() as b:
          b.open("https://duckduckgo.com")
          b.type("input[name=q]", "rust browser")
          b.press("Enter")
          b.wait("#links")
          print(b.read()[:500])
          b.screenshot(path="results.png")

* :class:`AgentSDK` is the numbered-element API for AI agents (``list_elements``,
  ``click_element(3)``, ``type_text(1, "...")``), compatible with julia-browser 2.x.

* :class:`BrowserSDK` and :func:`render` fetch and render pages in one call (markdown, text,
  character-cell layout, PNG).

Every browser runs on its own engine thread; calls release the GIL while the page works.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple, Union

import atexit

from ._native import ENGINE_VERSION, Engine as _Engine, serve_cdp as _serve_cdp, shutdown as _shutdown, vault_op as _vault_op

# Close every browser and stop SpiderMonkey's helper threads before the interpreter exits;
# otherwise C++ static destructors abort the process on Linux.
atexit.register(_shutdown)

__version__ = "3.0.0"
__author__ = "Harish Santhanalakshmi Ganesan"
__email__ = "harishsg99@gmail.com"
__all__ = [
    "Vault",
    "Browser",
    "AgentSDK",
    "BrowserSDK",
    "BrowserError",
    "render",
    "screenshot",
    "serve_cdp",
    "CDPServer",
    "ENGINE_VERSION",
    "__version__",
    "__author__",
]

PathLike = Union[str, "os.PathLike[str]"]


class BrowserError(RuntimeError):
    """An action failed: no element matched, navigation failed, the page threw, ..."""

    def __init__(self, message: str, data: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.data = data or {}


def _options(
    user_agent: Optional[str],
    javascript: bool,
    js_budget_ms: int,
    timeout: int,
    geolocation: Optional[Tuple[float, float]],
    extra: Dict[str, Any],
) -> str:
    opts: Dict[str, Any] = {
        "user_agent": user_agent,
        "javascript": javascript,
        "js_budget_ms": js_budget_ms,
        "timeout": timeout,
    }
    if geolocation is not None:
        opts["geolocation"] = [float(geolocation[0]), float(geolocation[1])]
    opts.update(extra)
    return json.dumps({k: v for k, v in opts.items() if v is not None})


class _Base:
    _kind = ""

    def __init__(
        self,
        user_agent: Optional[str] = None,
        timeout: int = 30,
        *,
        javascript: bool = True,
        js_budget_ms: int = 8000,
        geolocation: Optional[Tuple[float, float]] = None,
        **options: Any,
    ):
        self._engine = _Engine(self._kind, _options(user_agent, javascript, js_budget_ms, timeout, geolocation, options))

    def _call(self, method: str, **args: Any) -> Any:
        out = self._engine.call(method, json.dumps(args))
        return out if isinstance(out, bytes) else json.loads(out)

    def close(self) -> None:
        """Stop the browser. Further calls raise ``RuntimeError``."""
        self._engine.close()

    @property
    def closed(self) -> bool:
        return self._engine.closed

    def __enter__(self):
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def __del__(self) -> None:
        try:
            self._engine.close()
        except Exception:
            pass


class Browser(_Base):
    """A live browser tab driven with selectors.

    Selectors are CSS (``#id``, ``input[name=q]``), ``text=Sign in`` (visible text), or the
    ``@eN`` refs printed by :meth:`snapshot`-style annotations.

    Options (keyword arguments):

    * ``user_agent``: User-Agent header and ``navigator.userAgent``.
    * ``javascript``: run page scripts (default True).
    * ``js_budget_ms``: script time per page load or action (default 8000).
    * ``geolocation``: ``(latitude, longitude)`` for ``navigator.geolocation``; denied otherwise.
    * ``external_scripts``, ``websockets``, ``service_workers``, ``clipboard``: feature switches.
    * ``notifications``: ``"default"``, ``"granted"`` or ``"denied"``.
    * ``settle_ms``: page time to let run after each action (default 2500).
    * ``profile_dir``: directory for this browser's localStorage/IndexedDB files instead of the
      shared one under the user's data directory; ``""`` keeps them in memory only.
    """

    _kind = "session"

    def _exec(self, cmd: str, **args: Any) -> Dict[str, Any]:
        r = self._call("exec", cmd=cmd, args={k: v for k, v in args.items() if v is not None})
        if not r.get("ok"):
            raise BrowserError(r.get("error") or f"{cmd} failed", r.get("data"))
        return r

    # ---- navigation and reading

    def open(self, url: str) -> Dict[str, Any]:
        """Load ``url`` (scripts run until the page settles). Returns ``{"url": ...}``."""
        return self._exec("open", url=url).get("data") or {}

    goto = open

    def read(self, url: Optional[str] = None) -> str:
        """The page's readable text as markdown (opening ``url`` first when given)."""
        return self._exec("read", url=url).get("message", "")

    @property
    def url(self) -> Optional[str]:
        return self._call("page").get("url")

    @property
    def title(self) -> str:
        t = self._call("page").get("title") or ""
        return "" if t == "No title" else t

    def content(self) -> str:
        """The current DOM serialized as HTML."""
        return self.eval("document.documentElement ? document.documentElement.outerHTML : ''")

    # ---- actions

    def click(self, selector: str, *, new_tab: bool = False) -> str:
        """Click an element (real pointer + mouse events, follows links and submits forms)."""
        return self._exec("click", selector=selector, new_tab=new_tab or None)["message"]

    def click_at(self, x: float, y: float, *, count: int = 1) -> str:
        """Click at viewport coordinates (CSS pixels from the top-left of the 1280x720 viewport),
        e.g. a square of a canvas board or a point on a map; points inside frames reach the frame."""
        return self._exec("click_at", x=float(x), y=float(y), count=count)["message"]

    def drag_at(self, x1: float, y1: float, x2: float, y2: float) -> str:
        """Drag with the mouse from (x1, y1) to (x2, y2), viewport CSS pixels (slider handles, maps)."""
        return self._exec("drag_at", x1=float(x1), y1=float(y1), x2=float(x2), y2=float(y2))["message"]

    def dblclick(self, selector: str) -> str:
        return self._exec("dblclick", selector=selector)["message"]

    def hover(self, selector: str) -> str:
        return self._exec("hover", selector=selector)["message"]

    def focus(self, selector: str) -> str:
        return self._exec("focus", selector=selector)["message"]

    def type(self, selector: str, text: str) -> str:
        """Type ``text`` key by key into the element (appends to its value)."""
        return self._exec("type", selector=selector, text=text)["message"]

    def fill(self, selector: str, text: str) -> str:
        """Replace the element's value with ``text`` (input events fire)."""
        return self._exec("fill", selector=selector, text=text)["message"]

    def press(self, key: str) -> str:
        """Press a key at the focused element: ``"Enter"``, ``"Tab"``, ``"Control+a"``, ..."""
        return self._exec("press", key=key)["message"]

    def check(self, selector: str) -> str:
        return self._exec("check", selector=selector)["message"]

    def uncheck(self, selector: str) -> str:
        return self._exec("uncheck", selector=selector)["message"]

    def select(self, selector: str, value: str) -> str:
        """Choose an ``<option>`` of a ``<select>`` by value or visible text."""
        return self._exec("select", selector=selector, value=value)["message"]

    def scroll(self, direction: str = "down", px: int = 300, selector: Optional[str] = None) -> str:
        return self._exec("scroll", direction=direction, px=px, selector=selector)["message"]

    def scroll_into_view(self, selector: str) -> str:
        return self._exec("scrollintoview", selector=selector)["message"]

    def drag(self, source: str, target: str) -> str:
        return self._exec("drag", source=source, target=target)["message"]

    def upload(self, selector: str, files: Union[PathLike, Sequence[PathLike]]) -> str:
        """Set the files of an ``<input type=file>``."""
        paths = [os.fspath(files)] if isinstance(files, (str, os.PathLike)) else [os.fspath(f) for f in files]
        return self._exec("upload", selector=selector, files=paths)["message"]

    def keyboard_type(self, text: str) -> str:
        """Type at the current focus without a selector."""
        return self._exec("keyboard", mode="type", text=text)["message"]

    def wait(self, target: Union[str, int, float], timeout: int = 10000) -> str:
        """Wait for a selector to match (up to ``timeout`` ms of page time), or for a number of ms."""
        return self._exec("wait", target=str(int(target)) if isinstance(target, (int, float)) else target, timeout=timeout)["message"]

    def eval(self, code: str, settle: bool = True) -> Any:
        """Evaluate JavaScript in the page; promises are awaited. Returns the JSON value.
        settle=False reads the page as it is, without letting its timers and network run afterwards
        (much faster for observations; promises and statements still take the normal path)."""
        return (self._exec("eval", code=code, settle=None if settle else False).get("data") or {}).get("value")

    evaluate = eval

    # ---- screenshots and cookies

    def screenshot(self, path: Optional[PathLike] = None, *, full_page: bool = False) -> bytes:
        """PNG of the viewport (or the whole page). Also written to ``path`` when given."""
        png = self._call("screenshot_bytes", full=full_page)
        if path is not None:
            with open(path, "wb") as f:
                f.write(png)
        return png

    def pdf(self, path: PathLike) -> str:
        return self._exec("pdf", path=os.fspath(path))["message"]

    def cookies(self) -> Any:
        return self._call("cookies")

    def set_cookie(self, url: str, cookie: str) -> Any:
        """Add a cookie for ``url`` in ``Set-Cookie`` syntax (``"name=value; Path=/"``)."""
        return self._call("set_cookie", url=url, cookie=cookie)

    def command(self, cmd: str, **args: Any) -> Dict[str, Any]:
        """Run any session command of the ``julia-browser`` CLI by name (raw result dict)."""
        return self._call("exec", cmd=cmd, args=args)

    # ---- vault (credentials are typed inside the browser; results never contain a secret)

    def login(self, reason: str, account: Optional[str] = None) -> str:
        """Fill the page's username/password fields from the vault for the page's site. The site
        must be allowed (``Vault.allow``); ``reason`` goes to the audit log."""
        return self._exec("login", reason=reason, account=account)["message"]

    def otp(self, reason: str, account: Optional[str] = None) -> str:
        """Fill the current one-time code (TOTP) of the site's vault login."""
        return self._exec("otp", reason=reason, account=account)["message"]

    def new_password(self, username: str, reason: str) -> str:
        """Sign-up: generate a password, save it for this site + username, fill the new-password fields."""
        return self._exec("new_password", username=username, reason=reason)["message"]

    def vault_scope(self, sites: Optional[Sequence[str]] = None) -> str:
        """Narrow vault use to the sites this task needs (None lifts it). Applies to the process."""
        return self._exec("vault_scope", sites=list(sites) if sites else None)["message"]


class Vault:
    """The encrypted password + passkey vault shared with the ``julia-browser vault`` CLI.

    Secrets go in (``add``, ``import_file``) and come out only through ``export``; the agent uses
    them through ``Browser.login`` / ``otp`` / ``new_password`` and WebAuthn passkeys.
    """

    @staticmethod
    def _op(op: str, **args: Any) -> Any:
        return json.loads(_vault_op(op, json.dumps(args)))

    @classmethod
    def status(cls) -> Dict[str, Any]:
        return cls._op("status")

    @classmethod
    def list(cls) -> Dict[str, Any]:
        """Logins and passkeys without secrets."""
        return cls._op("list")

    @classmethod
    def add(cls, site: str, username: str, password: str, *, totp: Optional[str] = None, title: Optional[str] = None, allow: bool = False) -> str:
        return cls._op("add", site=site, username=username, password=password, totp=totp, title=title, allow=allow)["id"]

    @classmethod
    def remove(cls, item_id: str) -> bool:
        return cls._op("remove", id=item_id)["removed"]

    @classmethod
    def allow(cls, *sites: str) -> List[str]:
        return cls._op("allow", sites=list(sites))["allowed_sites"]

    @classmethod
    def deny(cls, *sites: str) -> List[str]:
        return cls._op("deny", sites=list(sites))["allowed_sites"]

    @classmethod
    def security_key(cls, *sites: str, on: bool = True) -> List[str]:
        """Send these sites' WebAuthn to a FIDO security key / Windows Hello (a person answers the
        prompt) instead of the vault's passkeys; ``on=False`` switches back."""
        return cls._op("security_key", sites=list(sites), on=on)["security_key_sites"]

    @classmethod
    def import_file(cls, path: PathLike, format: str = "auto") -> Dict[str, Any]:
        """Import a CSV export (Chrome, Firefox, Apple Passwords, 1Password, Bitwarden, LastPass,
        Dashlane, ...), Bitwarden JSON or FIDO CXF JSON (the last two include passkeys)."""
        return cls._op("import", path=os.fspath(path), format=format)

    @classmethod
    def export(cls, path: PathLike, format: str = "cxf") -> Dict[str, Any]:
        """Write every secret to an unencrypted file (cxf with passkeys, or csv)."""
        return cls._op("export", path=os.fspath(path), format=format)

    @classmethod
    def log(cls, last: int = 20) -> List[Dict[str, Any]]:
        """Audit log entries: what was used, when, where and why."""
        return cls._op("log", last=last)


class AgentSDK(_Base):
    """Numbered-element browsing for AI agents (compatible with julia-browser 2.x).

    ``open_website`` returns the page as markdown; ``list_elements`` numbers the buttons,
    links and inputs; act on them with ``click_element(n)``, ``type_text(n, text)``,
    ``submit_form()`` and ``follow_link(n)``. Every method returns a dict with ``success``.
    """

    _kind = "agent"

    def open_website(self, url: str) -> Dict[str, Any]:
        return self._call("open_website", url=url)

    def list_elements(self) -> Dict[str, Any]:
        return self._call("list_elements")

    def click_element(self, element_number: int) -> Dict[str, Any]:
        return self._call("click_element", element_number=element_number)

    def type_text(self, field_number: int, text: str) -> Dict[str, Any]:
        return self._call("type_text", field_number=field_number, text=text)

    def submit_form(self) -> Dict[str, Any]:
        return self._call("submit_form")

    def follow_link(self, link: Union[int, str]) -> Dict[str, Any]:
        """Follow a link by its number from ``list_elements`` or by URL."""
        return self._call("follow_link", link=link)

    def search_page(self, search_term: str) -> Dict[str, Any]:
        return self._call("search_page", term=search_term)

    def get_page_info(self) -> Dict[str, Any]:
        return self._call("get_page_info")

    def readable_text(self) -> Dict[str, Any]:
        return self._call("readable_text")

    def execute_javascript(self, script: str) -> Dict[str, Any]:
        return self._call("execute_javascript", script=script)

    def act(self, action: str, target: str = "", value: Optional[str] = None) -> Dict[str, Any]:
        """Selector-based action: ``act("click", "text=Next")``, ``act("fill", "#q", "hi")``."""
        return self._call("act", action=action, target=target, value=value)

    def wait_for(self, selector: str, rounds: int = 4) -> Dict[str, Any]:
        return self._call("wait_for", selector=selector, rounds=rounds)

    def view_layout(self, cols: int = 120) -> Dict[str, Any]:
        return self._call("view_layout", cols=cols)

    def screenshot(self, path: Optional[PathLike] = None, *, full_page: bool = True) -> bytes:
        png = self._call("screenshot_bytes", full=full_page)
        if path is not None:
            with open(path, "wb") as f:
                f.write(png)
        return png

    def get_cookies(self) -> Dict[str, Any]:
        return self._call("get_cookies")

    def set_cookie(self, url: str, cookie: str) -> Dict[str, Any]:
        return self._call("set_cookie", url=url, cookie=cookie)

    def scroll_down(self, chunks: int = 1) -> Dict[str, Any]:
        return self._call("scroll_down", chunks=chunks)

    def scroll_up(self, chunks: int = 1) -> Dict[str, Any]:
        return self._call("scroll_up", chunks=chunks)

    def scroll_to_top(self) -> Dict[str, Any]:
        return self._call("scroll_to_top")

    def scroll_to_bottom(self) -> Dict[str, Any]:
        return self._call("scroll_to_bottom")

    def get_scroll_info(self) -> Dict[str, Any]:
        return self._call("get_scroll_info")

    @property
    def current_url(self) -> Optional[str]:
        return self._call("current_url")

    @property
    def current_title(self) -> str:
        return self._call("current_title")

    # julia-browser 2.x names
    navigate = open_website
    get_elements = list_elements
    click_button = click_element
    fill_input = type_text
    submit_current_form = submit_form


class BrowserSDK(_Base):
    """One-call page fetching and rendering. Methods return result dicts with ``success``,
    ``content``, ``metadata``, ``error``, ... (compatible with julia-browser 2.x)."""

    _kind = "sdk"

    def fetch_page(self, url: str, timeout: Optional[int] = None) -> Dict[str, Any]:
        return self._call("fetch_page", url=url, timeout=timeout)

    def render_to_markdown(self, url: str, execute_js: bool = True, timeout: Optional[int] = None) -> Dict[str, Any]:
        return self._call("render_to_markdown", url=url, execute_js=execute_js, timeout=timeout)

    def render_to_text(self, url: str, execute_js: bool = True, timeout: Optional[int] = None) -> Dict[str, Any]:
        return self._call("render_to_text", url=url, execute_js=execute_js, timeout=timeout)

    def render_to_layout(self, url: str, execute_js: bool = True, timeout: Optional[int] = None, cols: int = 160) -> Dict[str, Any]:
        """The laid-out page drawn in character cells (boxes, text where it renders)."""
        return self._call("render_to_layout", url=url, execute_js=execute_js, timeout=timeout, cols=cols)

    def render_to_png(self, url: str, execute_js: bool = True, timeout: Optional[int] = None, *, full_page: bool = True, scale: float = 1.0) -> bytes:
        return self._call("render_to_png", url=url, execute_js=execute_js, timeout=timeout, full_page=full_page, scale=scale)

    def browse_url(self, url: str) -> Dict[str, Any]:
        return self._call("browse_url", url=url)

    def get_page_links(self, url: str, timeout: Optional[int] = None) -> Dict[str, Any]:
        return self._call("get_page_links", url=url, timeout=timeout)

    def search_page(self, url: str, query: str, timeout: Optional[int] = None) -> Dict[str, Any]:
        return self._call("search_page", url=url, query=query, timeout=timeout)

    def fetch_and_render(self, url: str, output_format: str = "markdown", execute_js: bool = True, timeout: Optional[int] = None) -> Dict[str, Any]:
        return self._call("fetch_and_render", url=url, output_format=output_format, execute_js=execute_js, timeout=timeout)

    def batch_process(self, urls: Iterable[str], output_format: str = "markdown", execute_js: bool = True, timeout: Optional[int] = None) -> List[Dict[str, Any]]:
        return self._call("batch_process", urls=list(urls), output_format=output_format, execute_js=execute_js, timeout=timeout)

    def submit_form(self, url: str, data: Dict[str, Any]) -> Dict[str, Any]:
        return self._call("submit_form", url=url, data=data)

    def get_browser_info(self) -> Dict[str, Any]:
        return self._call("get_browser_info")

    def clear_history(self) -> None:
        self._call("clear_history")

    def set_user_agent(self, user_agent: str) -> None:
        self._call("set_user_agent", user_agent=user_agent)


def render(url: str, format: str = "markdown", *, javascript: bool = True, **options: Any) -> str:
    """Load ``url`` and return it as ``"markdown"``, ``"text"``, ``"html"`` or ``"layout"``."""
    with BrowserSDK(javascript=javascript, **options) as sdk:
        if format == "html":
            r = sdk.fetch_page(url)
        elif format == "layout":
            r = sdk.render_to_layout(url, execute_js=javascript)
        else:
            r = sdk.fetch_and_render(url, output_format=format, execute_js=javascript)
    if not r.get("success"):
        raise BrowserError(r.get("error") or f"could not load {url}", r)
    return r.get("content") or r.get("raw_html") or ""


def screenshot(url: str, path: Optional[PathLike] = None, *, full_page: bool = True, scale: float = 1.0, **options: Any) -> bytes:
    """Load ``url`` and return a PNG (also written to ``path`` when given)."""
    with BrowserSDK(**options) as sdk:
        png = sdk.render_to_png(url, full_page=full_page, scale=scale)
    if path is not None:
        with open(path, "wb") as f:
            f.write(png)
    return png


class CDPServer:
    """A Chrome DevTools Protocol endpoint served by this process (see :func:`serve_cdp`)."""

    def __init__(self, host: str, port: int, ws_url: str):
        self.host = host
        self.port = port
        #: ``http://host:port``: pass as ``browserURL`` (Puppeteer) or to ``connect_over_cdp`` (Playwright)
        self.url = f"http://{host}:{port}"
        #: the browser WebSocket endpoint (``browserWSEndpoint``)
        self.ws_url = ws_url

    def __repr__(self) -> str:
        return f"CDPServer({self.url!r})"


def serve_cdp(port: int = 9222, host: str = "127.0.0.1", *, javascript: bool = True, js_budget_ms: int = 8000, user_agent: Optional[str] = None, **options: Any) -> CDPServer:
    """Serve the Chrome DevTools Protocol from a background thread, so CDP clients can drive
    this browser like Chrome. ``port=0`` picks a free port.

    Playwright (Python)::

        server = julia_browser.serve_cdp(port=0)
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(server.url)
            page = browser.contexts[0].new_page()
            page.goto("https://example.com")

    Puppeteer / pyppeteer: ``connect(browserURL=server.url)``.
    """
    opts = json.loads(_options(user_agent, javascript, js_budget_ms, 30, None, options))
    bound, ws = _serve_cdp(json.dumps(opts), host, port)
    return CDPServer(host, bound, ws)
