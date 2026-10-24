"""Dataset download + loading. Everything is cached under benchmarks/data/."""

import ast
import base64
import csv
import hashlib
import io
import json
import os
import random
import urllib.request

from .util import DATA, ROOT

SIMPLEQA_URL = "https://openaipublic.blob.core.windows.net/simple-evals/simple_qa_test_set.csv"
BROWSECOMP_URL = "https://openaipublic.blob.core.windows.net/simple-evals/browse_comp_test_set.csv"
WEBVOYAGER_URL = "https://raw.githubusercontent.com/MinorJerry/WebVoyager/main/data/WebVoyager_data.jsonl"
WEBVOYAGER_REF_URL = "https://raw.githubusercontent.com/MinorJerry/WebVoyager/main/data/reference_answer.json"
MIND2WEB_URL = "https://huggingface.co/datasets/osunlp/Online-Mind2Web/resolve/main/Online_Mind2Web.json"
M2W_LOCAL = ROOT.parent.parent / "m2w"  # ../m2w next to the repo (see benchmark.md)
# BU Bench V1 and Odysseys task files as published (base64-encoded JSON) in Aside's benchmark repo
ASIDE_RAW = "https://raw.githubusercontent.com/at-inc/aside-benchmarks/main/"
BUBENCH_URL = ASIDE_RAW + "bu-bench-v1/runner/BU-Bench-v1-dataset.json.enc"
ODYSSEYS_URL = ASIDE_RAW + "odysseys/runner/Odysseys-dataset.json.enc"
ODYSSEYS_SEARCH_START = "https://lite.duckduckgo.com/lite/"


def _download(url, name, headers=None):
    DATA.mkdir(parents=True, exist_ok=True)
    path = DATA / name
    if not path.exists():
        print(f"downloading {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "jbbench", **(headers or {})})
        with urllib.request.urlopen(req, timeout=120) as r:
            path.write_bytes(r.read())
    return path


def _sample(items, limit, seed):
    """Deterministic subset (same items for every run with the same --limit/--seed)."""
    if limit and limit < len(items):
        items = random.Random(seed).sample(items, limit)
    return items


# ---- SimpleQA (OpenAI simple-evals): 4,326 short factual questions

def simpleqa(limit=None, seed=0):
    text = _download(SIMPLEQA_URL, "simple_qa_test_set.csv").read_text(encoding="utf-8")
    items = []
    for i, row in enumerate(csv.DictReader(io.StringIO(text))):
        meta = ast.literal_eval(row["metadata"])
        items.append({"id": f"sqa-{i}", "question": row["problem"], "answer": row["answer"],
                      "topic": meta.get("topic"), "urls": meta.get("urls", [])})
    return _sample(items, limit, seed)


# ---- BrowseComp (OpenAI simple-evals): 1,266 hard browsing questions, XOR-encrypted with a canary

def _derive_key(password, length):
    key = hashlib.sha256(password.encode()).digest()
    return key * (length // len(key)) + key[: length % len(key)]


def _decrypt(b64, password):
    enc = base64.b64decode(b64)
    return bytes(a ^ b for a, b in zip(enc, _derive_key(password, len(enc)))).decode()


def browsecomp(limit=None, seed=0):
    text = _download(BROWSECOMP_URL, "browse_comp_test_set.csv").read_text(encoding="utf-8")
    items = []
    for i, row in enumerate(csv.DictReader(io.StringIO(text))):
        items.append({"id": f"bc-{i}", "question": _decrypt(row["problem"], row["canary"]),
                      "answer": _decrypt(row["answer"], row["canary"]),
                      "topic": row.get("problem_topic")})
    return _sample(items, limit, seed)


# ---- WebVoyager: 643 tasks on 15 live sites

# Tasks that book something on a date (hotel stays, flights, a store pickup). Their 2023-24 dates are in the
# past, and the sites' date pickers start at today; other teams run WebVoyager with these dates moved
# forward. Historical questions (scores on a date, papers announced in a month) keep their dates.
DATE_SHIFT_SITES = {"Booking", "Google Flights"}
DATE_SHIFT_IDS = {"Apple--9"}
_MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


def shift_task_dates(task, today=None):
    """Move every dated year in `task` forward by the same number of years so that the earliest date is
    after today (same month and day). Returns (new_task, years_added); years_added is 0 when no date is past."""
    import datetime
    import re
    today = today or datetime.date.today()
    month = r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?"
    dates, years = [], []  # dates: (month, day, year-token index); years: (start, end, value)
    for m in re.finditer(r"\b(20[12]\d)\b", task):
        years.append((m.start(), m.end(), int(m.group(1))))
    # day/month/year (Booking's 20/12/2023)
    for m in re.finditer(r"\b(\d{1,2})/(\d{1,2})/(20[12]\d)\b", task):
        yi = next(i for i, y in enumerate(years) if y[0] == m.start(3))
        dates.append((int(m.group(2)), int(m.group(1)), yi))
    # "March 20", "Jan 1st", "6 March": each takes the next year written after it ("March 20-27, 2024")
    for m in re.finditer(r"\b" + month + r"\s+(\d{1,2})(?:st|nd|rd|th)?\b|\b(\d{1,2})(?:st|nd|rd|th)?\s+" + month, task, re.I):
        mon = _MONTHS[(m.group(1) or m.group(4)).lower()[:3]]
        day = int(m.group(2) or m.group(3))
        yi = next((i for i, y in enumerate(years) if y[0] >= m.end()), None)
        if yi is not None:
            dates.append((mon, day, yi))
    if not dates:
        return task, 0

    def mk(y, mon, day):
        try:
            return datetime.date(y, mon, day)
        except ValueError:  # Feb 29 in a non-leap year
            return datetime.date(y, mon, 28)

    earliest = min(mk(years[yi][2], mon, day) for mon, day, yi in dates)
    k = 0
    while mk(earliest.year + k, earliest.month, earliest.day) <= today + datetime.timedelta(days=2):
        k += 1
    if not k:
        return task, 0
    used = {yi for _, _, yi in dates}
    out = task
    for i in sorted(used, key=lambda i: -years[i][0]):  # right to left keeps the offsets valid
        s, e, v = years[i]
        out = out[:s] + str(v + k) + out[e:]
    # February 29 of a leap year becomes February 28 when the new year has none ("Feb 22 to Feb 29, 2024")
    if any(mon == 2 and day == 29 and not _leap(years[yi][2] + k) for mon, day, yi in dates):
        out = re.sub(r"\b(feb[a-z]*\.?\s+)29(st|nd|rd|th)?\b", lambda m: m.group(1) + "28" + (m.group(2) and "th" or ""), out, flags=re.I)
        out = re.sub(r"\b29(st|nd|rd|th)?(\s+feb)", lambda m: "28" + (m.group(1) and "th" or "") + m.group(2), out, flags=re.I)
    # a stated length of stay survives a leap day: "a three-night stay from February 28 to March 2, 2024" has
    # 3 nights in 2024 but 2 in 2027, so the end day moves to keep 3 (only when the original range had them)
    words = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}
    nm = re.search(r"\b(\d{1,2}|" + "|".join(words) + r")[- ]nights?\b", task, re.I)
    rng = re.search(r"\bfeb[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*(?:-|\u2013|to|until|through)\s*mar[a-z]*\.?\s+(\d{1,2})", task, re.I)
    if nm and rng:
        nights = int(nm.group(1)) if nm.group(1).isdigit() else words[nm.group(1).lower()]
        yv = next((y[2] for y in years if y[0] >= rng.end()), None)
        if yv is not None:
            try:
                d1, d2 = int(rng.group(1)), int(rng.group(2))
                before = (datetime.date(yv, 3, d2) - datetime.date(yv, 2, d1)).days
                start = mk(yv + k, 2, d1)
                end = start + datetime.timedelta(days=nights)
                if before == nights and (datetime.date(yv + k, 3, d2) - start).days != nights and end.month == 3:
                    s, e = rng.span(2)  # year tokens keep their length, so offsets in `out` are unchanged
                    out = out[:s] + str(end.day) + out[e:]
            except ValueError:
                pass
    return out, k


def _leap(y):
    return y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)


def webvoyager(limit=None, seed=0, sites=None, shift_dates=False):
    lines = _download(WEBVOYAGER_URL, "WebVoyager_data.jsonl").read_text(encoding="utf-8").splitlines()
    refs = json.loads(_download(WEBVOYAGER_REF_URL, "webvoyager_reference_answer.json").read_text(encoding="utf-8"))
    items = []
    for line in lines:
        if not line.strip():
            continue
        t = json.loads(line)
        if sites and t["web_name"].lower() not in sites:
            continue
        num = int(t["id"].rsplit("--", 1)[1])
        ref = next((a for a in refs.get(t["web_name"], {}).get("answers", []) if a["id"] == num), None)
        item = {"id": t["id"], "site": t["web_name"], "task": t["ques"], "start_url": t["web"],
                "reference": ref["ans"] if ref else None,
                "reference_type": ref["type"] if ref else None}
        if shift_dates and (t["web_name"] in DATE_SHIFT_SITES or t["id"] in DATE_SHIFT_IDS):
            import re
            # "today (February 17, 2024)" means today: drop the stale date instead of moving it a year on
            task, k = shift_task_dates(re.sub(r"\btoday \([^)]*20[12]\d\)", "today", t["ques"]))
            k = k or (task != t["ques"])
            if k:  # the reference answer was for the old dates (prices, flights): not even a hint any more
                item.update(task=task, task_original=t["ques"], date_shift_years=k, reference=None, reference_type=None)
        items.append(item)
    return _sample(items, limit, seed)


# ---- Online-Mind2Web: 300 tasks on 136 live sites (gated on Hugging Face)

def mind2web(limit=None, seed=0):
    """Current task set from Hugging Face (needs HF_TOKEN with the terms accepted), else the older
    task set in ../m2w/human_label.json (no start URL: the agent starts from a search engine)."""
    items = None
    for cand in (DATA / "Online_Mind2Web.json", M2W_LOCAL / "Online_Mind2Web.json"):
        items = _load_m2w(cand)
        if items:
            break
    token = os.environ.get("HF_TOKEN") or _hf_token_from_benchmark_txt()
    if not items and token:
        (DATA / "Online_Mind2Web.json").unlink(missing_ok=True)
        path = _download(MIND2WEB_URL, "Online_Mind2Web.json", {"Authorization": f"Bearer {token}"})
        items = _load_m2w(path)
    if not items:
        print("Online-Mind2Web: current set not available (set HF_TOKEN); using ../m2w/human_label.json "
              "(older task set, start from search) - not comparable to the leaderboard")
        raw = json.loads((M2W_LOCAL / "human_label.json").read_text(encoding="utf-8"))
        items = [{"id": t["task_id"], "task": t["confirmed_task"], "start_url": None,
                  "reference_length": None} for t in raw]
    return _sample(items, limit, seed)


def _hf_token_from_benchmark_txt():
    import re
    path = ROOT.parent / ".notes" / "benchmark.txt"
    if path.exists():
        m = re.search(r"hf_[A-Za-z0-9]+", path.read_text(encoding="utf-8", errors="ignore"))
        if m:
            return m.group(0)
    return None


def _load_m2w(path):
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return None
    if not isinstance(raw, list):
        return None  # e.g. the "access restricted" error body
    out = []
    for t in raw:
        url = t.get("website") or ""
        if url and not url.startswith("http"):
            url = "https://" + url
        out.append({"id": t["task_id"], "task": t["confirmed_task"], "start_url": url or None,
                    "reference_length": t.get("reference_length"), "level": t.get("level")})
    return out


# ---- BU Bench V1 (browser-use/benchmark): 100 tasks, 20 each from WebBenchREAD, Online-Mind2Web 2,
# InteractionTests, GAIA and BrowseComp. 40 have a ground-truth answer.

def bubench(limit=None, seed=0, categories=None):
    import re
    raw = json.loads(base64.b64decode(_download(BUBENCH_URL, "BU-Bench-v1-dataset.json.enc").read_text(encoding="utf-8")))
    items = []
    for t in raw:
        if categories and t["category"].lower() not in categories:
            continue
        task = t["confirmed_task"].replace("\\n", "\n").strip()
        # the start page is the first URL in the task text; GAIA / BrowseComp questions have none (start from search)
        m = re.search(r"https?://[^\s<>\"')\]]+", task)
        items.append({"id": t["task_id"], "task": task, "category": t["category"],
                      "start_url": m.group(0).rstrip(".,;:") if m else None, "reference": t.get("answer")})
    return _sample(items, limit, seed)


# ---- Odysseys (ljang0/Odysseys): 200 long-horizon, multi-site tasks graded by per-task rubrics

def odysseys(limit=None, seed=0, levels=None):
    raw = json.loads(base64.b64decode(_download(ODYSSEYS_URL, "Odysseys-dataset.json.enc").read_text(encoding="utf-8")))
    items = []
    for t in raw:
        if levels and t["level"] not in levels:
            continue
        start = t.get("website") or None
        if start and "google.com" in start and "/maps" not in start:
            # Google Search serves julia a reCAPTCHA ("unusual traffic"); start on another search engine instead
            start = ODYSSEYS_SEARCH_START
        items.append({"id": t["task_id"], "task": t["confirmed_task"].strip(), "start_url": start,
                      "level": t["level"], "reference_length": t.get("reference_length"),
                      "rubrics": t["rubrics"], "categories": t.get("categories")})
    return _sample(items, limit, seed)


# ---- Fetch quality: real pages people cite (SimpleQA source URLs), deduplicated

def fetch_urls(limit=200, seed=0, file=None):
    if file:
        urls = [u.strip() for u in open(file, encoding="utf-8") if u.strip() and not u.startswith("#")]
    else:
        # At most 2 URLs per domain, so Wikipedia (most of SimpleQA's sources) does not dominate.
        from urllib.parse import urlparse
        seen, per_domain, urls = set(), {}, []
        for it in simpleqa():
            for u in it["urls"]:
                if u in seen or not u.startswith("http"):
                    continue
                d = urlparse(u).netloc.lower().removeprefix("www.")
                if per_domain.get(d, 0) >= 2:
                    continue
                seen.add(u)
                per_domain[d] = per_domain.get(d, 0) + 1
                urls.append(u)
    items = [{"id": f"url-{hashlib.sha1(u.encode()).hexdigest()[:10]}", "url": u} for u in urls]
    return _sample(items, limit, seed)
