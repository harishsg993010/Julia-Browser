"""One julia-browser ``Browser`` under a wall-clock watchdog, plus a web search through it.

A page that keeps the engine busy past the limit raises :class:`BrowserTimeout`. By default the
browser is then replaced (a fresh one starts on about:blank and the agent reloads its last page);
observations pass ``reset_on_timeout=False`` and keep the page.
"""

import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutTimeout
from urllib.parse import parse_qs, quote_plus, urlparse

from julia_browser import Browser, BrowserError

# DuckDuckGo's no-JavaScript endpoints: fast and easy to parse. Lite first, HTML as a fallback.
SEARCH_ENGINES = [
    ("https://lite.duckduckgo.com/lite/?q={q}",
     """[...document.querySelectorAll('a.result-link')].map(a => {
          const tr = a.closest('tr'); let s = '', n = tr;
          for (let i = 0; i < 3 && n; i++) { n = n.nextElementSibling;
            const c = n && n.querySelector('td.result-snippet'); if (c) { s = c.textContent.trim(); break } }
          return {url: a.href, title: a.textContent.trim(), snippet: s} })"""),
    ("https://html.duckduckgo.com/html/?q={q}",
     """[...document.querySelectorAll('.result')].filter(r => !r.classList.contains('result--ad')).map(r => {
          const a = r.querySelector('a.result__a'), s = r.querySelector('.result__snippet');
          return a ? {url: a.href, title: a.textContent.trim(), snippet: s ? s.textContent.trim() : ''} : null
        }).filter(Boolean)"""),
]

ERRORS = (BrowserError, RuntimeError)


class BrowserTimeout(Exception):
    pass


class Session:
    """The agent's browser. ``options`` go to ``julia_browser.Browser`` (``js_budget_ms``,
    ``settle_ms``, ``profile_dir``, ``user_agent``, ...)."""

    def __init__(self, timeout_s=45, **options):
        self.timeout_s = timeout_s
        self.options = {"timeout": max(10, timeout_s - 5), **options}
        self.resets = 0
        self._b = None

    @property
    def browser(self) -> Browser:
        if self._b is None or self._b.closed:
            self._b = Browser(**self.options)
        return self._b

    def call(self, fn, timeout_s=None, reset_on_timeout=True):
        """fn(browser) with a hard time limit."""
        b = self.browser
        ex = ThreadPoolExecutor(max_workers=1)
        fut = ex.submit(fn, b)
        try:
            return fut.result(timeout=timeout_s or self.timeout_s)
        except FutTimeout:
            if reset_on_timeout:
                self.reset()
            raise BrowserTimeout(f"the browser did not answer within {timeout_s or self.timeout_s}s")
        finally:
            ex.shutdown(wait=False)

    def reset(self):
        """Drop the current browser (closed in the background: a busy engine can block close())."""
        b, self._b = self._b, None
        self.resets += 1
        if b is not None:
            threading.Thread(target=_close_quietly, args=(b,), daemon=True).start()

    def close(self, wait_s=30):
        b, self._b = self._b, None
        if b is not None:
            t = threading.Thread(target=_close_quietly, args=(b,), daemon=True)
            t.start()
            t.join(wait_s)

    def search(self, query, n=10):
        """Web search -> [{url, title, snippet}]."""
        last_err = None
        for url_tpl, js in SEARCH_ENGINES:
            url = url_tpl.format(q=quote_plus(query))
            try:
                raw = self.call(lambda b: (b.open(url), b.eval(js))[1]) or []
            except (*ERRORS, BrowserTimeout) as e:
                last_err = e
                continue
            results, seen = [], set()
            for r in raw:
                u = _unwrap_ddg(r.get("url", ""))
                if not u or u in seen or "duckduckgo.com/y.js" in u:
                    continue
                seen.add(u)
                results.append({"url": u, "title": r.get("title", ""), "snippet": r.get("snippet", "")})
            if results:
                return results[:n]
        if last_err:
            raise BrowserError(f"search failed: {last_err}")
        return []


def _unwrap_ddg(href):
    if href.startswith("//"):
        href = "https:" + href
    p = urlparse(href)
    if p.netloc.endswith("duckduckgo.com") and p.path.startswith("/l/"):
        return parse_qs(p.query).get("uddg", [""])[0]
    return href


def _close_quietly(b):
    try:
        b.close()
    except Exception:
        pass
