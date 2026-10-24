"""Time the browser side of one web-agent step on a few sites: open, observe (OBSERVE_JS + read),
screenshot, click, type. Usage: python benchmarks/steptime.py [url ...]"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jbbench.suites.webagent import OBSERVE_JS  # noqa: E402
from julia_browser import Browser  # noqa: E402

URLS = sys.argv[1:] or ["https://www.adoptapet.com/", "https://www.bestbuy.com/", "https://www.coursera.org/",
                        "https://new.mta.info/", "https://www.traderjoes.com/"]


def timed(label, fn):
    t = time.time()
    try:
        r = fn()
        err = ""
    except Exception as e:  # noqa: BLE001
        r, err = None, f" ERR {str(e)[:120]}"
    dt = time.time() - t
    print(f"  {label:10s} {dt:6.2f}s{err}", flush=True)
    return r, dt


for url in URLS:
    print(url, flush=True)
    b = Browser(timeout=40, js_budget_ms=8000)
    timed("open", lambda: b.open(url))
    obs, _ = timed("observe", lambda: b.eval(OBSERVE_JS, settle=False))
    timed("read", lambda: b.read())
    timed("screenshot", lambda: b.screenshot())
    els = (obs or {}).get("elements") or []
    print(f"  {len(els)} elements", flush=True)
    btn = next((e for e in els if e["tag"] in ("button", "a") and not e.get("below_fold")), None)
    inp = next((e for e in els if e["tag"] == "input" and e.get("type") in (None, "text", "search")), None)
    if inp:
        timed("type", lambda: b.fill(f'[data-jb-idx="{inp["i"]}"]', "test"))
        timed("observe2", lambda: b.eval(OBSERVE_JS, settle=False))
    if btn:
        timed("click", lambda: b.click(f'[data-jb-idx="{btn["i"]}"]'))
        timed("observe3", lambda: b.eval(OBSERVE_JS, settle=False))
        timed("screenshot2", lambda: b.screenshot())
    b.close()
