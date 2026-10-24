"""Search latency, fetch quality, SimpleQA (first result) and SimpleQA end-to-end."""

from .. import data
from ..judges import ANSWER_SCHEMA, grade_simpleqa, judge_evidence, judge_usable
from ..util import mean, pct, rate, run_items

PAGE_CHARS_FOR_ANSWER = 15_000


# ---------------------------------------------------------------- search latency

def search_latency(ctx):
    items = data.simpleqa(ctx.limit or 200, ctx.seed)

    def one(it):
        r = ctx.web.search(it["question"])
        return {"query": it["question"], "latency_s": round(r["latency_s"], 3), "engine": r["engine"],
                "n_results": len(r["results"]), "error": r["error"],
                "status": "ok" if r["results"] else "no-results"}

    rows = run_items(ctx.run, items, one, ctx.jobs, "search-latency")
    ok = [r for r in rows if r.get("n_results")]
    lat = [r["latency_s"] * 1000 for r in ok]
    return {
        "items": len(rows),
        "success_rate": rate(r.get("n_results") for r in rows),
        "p50_ms": _r(pct(lat, 50)), "p90_ms": _r(pct(lat, 90)), "p95_ms": _r(pct(lat, 95)),
        "mean_ms": _r(mean(lat)),
        "headline": ("p50 search latency (ms)", _r(pct(lat, 50))),
    }


# ---------------------------------------------------------------- fetch quality

def fetch_quality(ctx):
    items = data.fetch_urls(ctx.limit or 200, ctx.seed, ctx.args.urls)

    def one(it):
        f = ctx.web.fetch(it["url"])
        verdict = judge_usable(ctx.judge, f)
        return {"url": it["url"], "final_url": f["final_url"], "title": f["title"], "chars": f["chars"],
                "latency_s": round(f["latency_s"], 3), "error": f["error"], **verdict,
                "status": "usable" if verdict["usable"] else verdict["category"]}

    rows = run_items(ctx.run, items, one, ctx.jobs, "fetch-quality")
    cats = {}
    for r in rows:
        cats[r.get("category", "error")] = cats.get(r.get("category", "error"), 0) + 1
    lat = [r["latency_s"] for r in rows if r.get("latency_s") is not None]
    return {
        "items": len(rows),
        "usable_pct": rate(r.get("usable") for r in rows),
        "categories": dict(sorted(cats.items(), key=lambda kv: -kv[1])),
        "fetch_p50_s": _r(pct(lat, 50), 2), "fetch_mean_s": _r(mean(lat), 2),
        "headline": ("pages returned as usable context (%)", rate(r.get("usable") for r in rows)),
    }


# ---------------------------------------------------------------- SimpleQA: first result

def simpleqa_first(ctx):
    items = data.simpleqa(ctx.limit or 200, ctx.seed)

    def one(it):
        s = ctx.web.search(it["question"])
        row = {"question": it["question"], "answer": it["answer"], "search_s": round(s["latency_s"], 3)}
        if not s["results"]:
            return {**row, "evidence": False, "status": "no-results", "error": s["error"]}
        top = s["results"][0]
        f = ctx.web.fetch(top["url"])
        v = judge_evidence(ctx.judge, it["question"], it["answer"], top, f)
        return {**row, "url": top["url"], "fetch_s": round(f["latency_s"], 3), "chars": f["chars"],
                "fetch_error": f["error"], **v, "status": "evidence" if v["evidence"] else "no-evidence"}

    rows = run_items(ctx.run, items, one, ctx.jobs, "simpleqa-first")
    return {
        "items": len(rows),
        "evidence_pct": rate(r.get("evidence") for r in rows),
        "no_results": sum(1 for r in rows if r.get("status") == "no-results"),
        "headline": ("first result contains enough evidence (%)", rate(r.get("evidence") for r in rows)),
    }


# ---------------------------------------------------------------- SimpleQA: search + fetch, end to end

ANSWER_SYSTEM = (
    "Answer the question using only the search results and fetched pages provided. "
    "Give the shortest exact answer. If the sources do not contain the answer, set answer to "
    "\"I don't know\"."
)


def simpleqa_e2e(ctx):
    items = data.simpleqa(ctx.limit or 200, ctx.seed)
    k = ctx.args.top_k

    def one(it):
        s = ctx.web.search(it["question"])
        row = {"question": it["question"], "gold": it["answer"], "search_s": round(s["latency_s"], 3)}
        if not s["results"]:
            return {**row, "grade": "NOT_ATTEMPTED", "status": "no-results", "error": s["error"]}
        parts = ["Search results:"]
        for i, r in enumerate(s["results"]):
            parts.append(f"[{i + 1}] {r['title']} - {r['url']}\n{r['snippet']}")
        fetch_s = []
        for r in s["results"][:k]:
            f = ctx.web.fetch(r["url"])
            fetch_s.append(round(f["latency_s"], 3))
            body = f["markdown"][:PAGE_CHARS_FOR_ANSWER] if f["markdown"] else f"(fetch failed: {f['error']})"
            parts.append(f"\n=== Page: {r['url']} ===\n{body}")
        ans = ctx.agent.json(ANSWER_SYSTEM, "\n".join(parts) + f"\n\nQuestion: {it['question']}", ANSWER_SCHEMA,
                             effort="low")
        grade = grade_simpleqa(ctx.judge, it["question"], it["answer"], ans["answer"])
        return {**row, "predicted": ans["answer"], "fetch_s": fetch_s, "grade": grade, "status": grade.lower()}

    rows = run_items(ctx.run, items, one, ctx.jobs, "simpleqa-e2e")
    correct = rate(r.get("grade") == "CORRECT" for r in rows)
    attempted = [r for r in rows if r.get("grade") in ("CORRECT", "INCORRECT")]
    return {
        "items": len(rows),
        "correct_pct": correct,
        "not_attempted_pct": rate(r.get("grade") == "NOT_ATTEMPTED" for r in rows),
        "correct_given_attempted_pct": rate(r["grade"] == "CORRECT" for r in attempted),
        "top_k_fetched": k,
        "headline": ("questions answered correctly after search + fetch (%)", correct),
    }


def _r(x, nd=0):
    return None if x is None else round(x, nd) if nd else round(x)
