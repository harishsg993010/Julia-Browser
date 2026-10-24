"""Search and fetch on top of julia-browser (one Browser per worker thread).

Every browser call runs under a hard wall-clock watchdog: if the engine does not answer in
time, that Browser is abandoned (closed in the background) and the thread gets a fresh one.
"""

import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutTimeout
from urllib.parse import parse_qs, quote_plus, urlparse

from julia_browser import Browser, BrowserError

# DuckDuckGo's no-JS endpoints: fast and parseable. Lite first, HTML as a fallback.
ENGINES = [
    ("ddg-lite", "https://lite.duckduckgo.com/lite/?q={q}",
     """[...document.querySelectorAll('a.result-link')].map(a => {
          const tr = a.closest('tr'); let s = '', n = tr;
          for (let i = 0; i < 3 && n; i++) { n = n.nextElementSibling;
            const c = n && n.querySelector('td.result-snippet'); if (c) { s = c.textContent.trim(); break } }
          return {url: a.href, title: a.textContent.trim(), snippet: s} })"""),
    ("ddg-html", "https://html.duckduckgo.com/html/?q={q}",
     """[...document.querySelectorAll('.result')].filter(r => !r.classList.contains('result--ad')).map(r => {
          const a = r.querySelector('a.result__a'), s = r.querySelector('.result__snippet');
          return a ? {url: a.href, title: a.textContent.trim(), snippet: s ? s.textContent.trim() : ''} : null
        }).filter(Boolean)"""),
]

BLOCK_MARKERS = ("captcha", "unusual traffic", "are you a robot", "access denied", "verify you are human",
                 "attention required", "just a moment", "anomaly", "enable javascript and cookies")
# URLs of bot-check / block pages (Google SearchGuard's no-JS retry page and its /sorry/ CAPTCHA)
BLOCK_URL_MARKERS = ("/httpservice/retry/enablejs", "google.com/sorry/", "/_sec/cp_challenge")
# page text of block pages without a telling title (Akamai's Nestle-branded block page on Petfinder)
BLOCK_TEXT_MARKERS = ("there seems to be a problem with our website", "performing security verification",
                      "just a quick check", "checking your browser", "verifying you are human",
                      "request blocked", "the request could not be satisfied")


class WebTimeout(Exception):
    pass


# A browser is replaced after this many calls: engine memory grows with every page a long-lived
# browser visits, and 3 runs x 3 workers ran the machine out of commit (an image decode aborted).
RECYCLE_AFTER_CALLS = 25


class Web:
    def __init__(self, timeout_s=45, js_budget_ms=8000, settle_ms=None):
        self.timeout_s = timeout_s
        self.opts = {"timeout": max(10, timeout_s - 5), "js_budget_ms": js_budget_ms}
        if settle_ms is not None:
            self.opts["settle_ms"] = settle_ms
        self._tl = threading.local()
        self._all = []
        self._lock = threading.Lock()

    # ---- browser lifecycle

    def set_profile(self, path):
        """This thread's next browsers keep localStorage/IndexedDB in `path` (one profile per task, so
        tasks do not see each other's consent cookies and app state); None = the shared profile."""
        self._tl.profile = None if path is None else str(path)

    def browser(self) -> Browser:
        b = getattr(self._tl, "b", None)
        if b is None or b.closed:
            opts = dict(self.opts)
            if getattr(self._tl, "profile", None) is not None:
                opts["profile_dir"] = self._tl.profile
            b = Browser(**opts)
            self._tl.b = b
            self._tl.calls = 0
            with self._lock:
                self._all.append(b)
        return b

    def recycle_if_old(self):
        """Replace this thread's browser once it has made RECYCLE_AFTER_CALLS calls. Only for
        stateless callers (search/fetch); the web agents keep one browser per task."""
        if getattr(self._tl, "calls", 0) >= RECYCLE_AFTER_CALLS:
            self.reset()

    def resets(self) -> int:
        """How many times this thread's browser was replaced (a reset loses the page)."""
        return getattr(self._tl, "resets", 0)

    def reset(self):
        b = getattr(self._tl, "b", None)
        self._tl.resets = getattr(self._tl, "resets", 0) + 1
        self._tl.b = None
        self._tl.calls = 0
        if b is not None:
            with self._lock:
                if b in self._all:
                    self._all.remove(b)
            threading.Thread(target=_close_quietly, args=(b,), daemon=True).start()

    def call(self, fn, timeout_s=None, reset_on_timeout=True):
        """Run fn(browser) with a hard timeout. On timeout the browser is replaced (a fresh one
        starts on about:blank), unless reset_on_timeout is False: then the call keeps running in
        the engine and the next call queues behind it (observations: the page is kept)."""
        b = self.browser()
        self._tl.calls = getattr(self._tl, "calls", 0) + 1
        ex = ThreadPoolExecutor(max_workers=1)
        fut = ex.submit(fn, b)
        try:
            return fut.result(timeout=timeout_s or self.timeout_s)
        except FutTimeout:
            if reset_on_timeout:
                self.reset()
            raise WebTimeout(f"browser call exceeded {timeout_s or self.timeout_s}s")
        finally:
            ex.shutdown(wait=False)

    def close(self, wait_s=30):
        """Close every browser, waiting at most `wait_s`: an engine wedged by a timed-out page can
        block close() forever (a finished SimpleQA run hung here and never wrote its summary)."""
        with self._lock:
            browsers, self._all = self._all, []
        threads = [threading.Thread(target=_close_quietly, args=(b,), daemon=True) for b in browsers]
        for t in threads:
            t.start()
        deadline = time.time() + wait_s
        for t in threads:
            t.join(max(0, deadline - time.time()))

    # ---- search

    def search(self, query: str, n: int = 10):
        """-> {results: [{url, title, snippet}], latency_s, engine, error}"""
        self.recycle_if_old()
        self.browser()  # browser start-up is not part of the measured latency
        t0 = time.time()
        last_err = None
        for name, url_tpl, js in ENGINES:
            url = url_tpl.format(q=quote_plus(query))
            try:
                raw = self.call(lambda b: (b.open(url), b.eval(js))[1]) or []
            except (BrowserError, WebTimeout, RuntimeError) as e:
                last_err = f"{name}: {e}"
                continue
            results = []
            seen = set()
            for r in raw:
                u = unwrap_ddg(r.get("url", ""))
                if not u or u in seen or "duckduckgo.com/y.js" in u:
                    continue
                seen.add(u)
                results.append({"url": u, "title": r.get("title", ""), "snippet": r.get("snippet", "")})
            if results:
                return {"results": results[:n], "latency_s": time.time() - t0, "engine": name, "error": None}
            last_err = f"{name}: no results"
        return {"results": [], "latency_s": time.time() - t0, "engine": None, "error": last_err}

    # ---- fetch

    def fetch(self, url: str, max_chars: int = 200_000):
        """-> {url, final_url, title, markdown, latency_s, error, blocked}"""
        self.recycle_if_old()
        self.browser()
        t0 = time.time()

        def go(b):
            b.open(url)
            md = b.read()
            page = b._call("page")
            return md, page.get("url"), page.get("title") or ""

        try:
            md, final_url, title = self.call(go)
            err = None
        except (BrowserError, WebTimeout, RuntimeError) as e:
            md, final_url, title, err = "", None, "", f"{type(e).__name__}: {e}"
        md = md or ""
        head = (title + " " + md[:2000]).lower()
        return {
            "url": url,
            "final_url": final_url,
            "title": "" if title == "No title" else title,
            "markdown": md[:max_chars],
            "chars": len(md),
            "latency_s": time.time() - t0,
            "error": err,
            "blocked": bool(md) and len(md) < 3000 and any(m in head for m in BLOCK_MARKERS),
        }


def unwrap_ddg(href: str) -> str:
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
