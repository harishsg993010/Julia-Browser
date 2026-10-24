"""BrowseComp: an agent with `search` and `fetch` tools backed by julia-browser.

Reported like the TinyFish table: average search+fetch latency, tasks completed without timeout or
error (out of N), plus accuracy from the BrowseComp grader."""

import json
import time

from .. import data
from ..judges import grade_browsecomp
from ..util import mean, pct, rate, run_items

PAGE_SLICE = 12_000

TOOLS = [
    {
        "name": "search",
        "description": "Web search. Returns up to 10 results (title, url, snippet).",
        "input_schema": {"type": "object", "properties": {"query": {"type": "string"}},
                         "required": ["query"], "additionalProperties": False},
        "strict": True,
    },
    {
        "name": "fetch",
        "description": f"Open a URL in a real browser and return the page as markdown, {PAGE_SLICE} characters "
                       "at a time starting at `offset` (use the returned next_offset to read further).",
        "input_schema": {"type": "object",
                         "properties": {"url": {"type": "string"}, "offset": {"type": "integer"}},
                         "required": ["url", "offset"], "additionalProperties": False},
        "strict": True,
    },
]

SYSTEM = """You are a meticulous web researcher. Use the search and fetch tools to find the answer to
the question. Questions are hard: they combine several constraints, so search for the most distinctive
constraint first, verify candidates against every constraint, and keep going until you are confident.
You can call several tools in parallel.

When done, reply (no tool call) in exactly this format:
Explanation: <your reasoning, citing sources>
Exact Answer: <succinct final answer>
Confidence: <0-100%>"""


def browsecomp(ctx):
    items = data.browsecomp(ctx.limit or 100, ctx.seed)

    def one(it):
        return _research(ctx, it)

    rows = run_items(ctx.run, items, one, ctx.jobs, "browsecomp")
    calls = [c for r in rows for c in r.get("calls", [])]
    lat = [c["latency_s"] for c in calls]
    # Completed = graded answer without hitting the wall-clock timeout (an answer forced at the turn
    # limit still counts; one forced by the timeout does not).
    completed = sum(1 for r in rows if r.get("status") in ("correct", "incorrect") and not r.get("timed_out"))
    return {
        "items": len(rows),
        "completed": f"{completed}/{len(rows)}",
        "completed_pct": rate(r.get("status") in ("correct", "incorrect") for r in rows),
        "accuracy_pct": rate(r.get("correct") for r in rows),
        "avg_search_fetch_latency_s": _r2(mean(lat)),
        "avg_search_latency_s": _r2(mean([c["latency_s"] for c in calls if c["tool"] == "search"])),
        "avg_fetch_latency_s": _r2(mean([c["latency_s"] for c in calls if c["tool"] == "fetch"])),
        "p50_search_fetch_latency_s": _r2(pct(lat, 50)),
        "tool_calls": len(calls),
        "answered_at_turn_limit": sum(1 for r in rows if r.get("hit_limit") and not r.get("timed_out")),
        "timed_out": sum(1 for r in rows if r.get("timed_out")),
        "search_failures": sum(1 for c in calls if c["tool"] == "search" and not c["ok"]),
        "headline": ("accuracy (%)", rate(r.get("correct") for r in rows)),
        "headline2": ("tasks completed without timeout or error", f"{completed}/{len(rows)}"),
        "headline3": ("average search + fetch latency (s)", _r2(mean(lat))),
    }


def _research(ctx, it):
    deadline = time.time() + (ctx.args.task_timeout or 1500)
    pages = {}  # url -> markdown, so paging through a document does not refetch it
    calls = []
    messages = [{"role": "user", "content": f"Question: {it['question']}"}]
    final = None
    status = "timeout"
    for turn in range(ctx.args.max_turns):
        if time.time() > deadline:
            break
        resp = ctx.agent.create(system=SYSTEM, messages=messages, tools=TOOLS, max_tokens=16000, cache=True)
        messages.append({"role": "assistant", "content": resp.content})
        if resp.stop_reason == "refusal":
            status = "refused"
            break
        uses = [b for b in resp.content if b.type == "tool_use"]
        if not uses:
            final = "".join(b.text for b in resp.content if b.type == "text")
            status = "answered"
            break
        results = []
        for u in uses:  # sequential on this worker's browser; tasks run in parallel across workers
            out, err = _tool(ctx, u.name, u.input, pages, calls)
            results.append({"type": "tool_result", "tool_use_id": u.id, "content": out, **({"is_error": True} if err else {})})
        messages.append({"role": "user", "content": results})
    else:
        status = "max-turns"

    timed_out = status == "timeout"
    if status in ("max-turns", "timeout") and messages[-1]["role"] == "user":
        # Budget spent: like the reference BrowseComp setups, the agent must still commit to its best
        # answer (one call, tools disabled). The last user turn holds tool results not yet sent.
        messages[-1]["content"].append({"type": "text", "text": "You have no tool calls left. Give your final "
                                        "answer now from what you have found, in the required format; if "
                                        "unsure, give your best guess with a low confidence."})
        resp = ctx.agent.create(system=SYSTEM, messages=messages, tools=TOOLS, max_tokens=16000, cache=True,
                                tool_choice={"type": "none"})
        text = "".join(b.text for b in resp.content if b.type == "text")
        if resp.stop_reason != "refusal" and text.strip():
            final, status = text, "answered-at-limit"

    row = {"question": it["question"], "gold": it["answer"], "turns": turn + 1, "calls": calls,
           "response": final, "hit_limit": status == "answered-at-limit", "timed_out": timed_out}
    if status not in ("answered", "answered-at-limit"):
        return {**row, "status": status, "correct": False}
    g = grade_browsecomp(ctx.judge, it["question"], it["answer"], final)
    return {**row, "extracted": g["extracted_final_answer"], "correct": g["correct"],
            "status": "correct" if g["correct"] else "incorrect"}


def _tool(ctx, name, args, pages, calls):
    t = time.time()
    if name == "search":
        r = ctx.web.search(args["query"])
        calls.append({"tool": "search", "latency_s": round(r["latency_s"], 3), "ok": bool(r["results"]),
                      **({"error": (r["error"] or "")[:200]} if not r["results"] else {})})
        if not r["results"]:
            return f"No results ({r['error']})", True
        return json.dumps(r["results"], ensure_ascii=False), False
    if name == "fetch":
        url, off = args["url"], max(0, args.get("offset") or 0)
        if url not in pages:
            f = ctx.web.fetch(url)
            calls.append({"tool": "fetch", "latency_s": round(f["latency_s"], 3), "ok": bool(f["markdown"])})
            if not f["markdown"]:
                return f"Fetch failed: {f['error'] or 'empty page'}", True
            pages[url] = f"# {f['title']}\n\n{f['markdown']}"
        md = pages[url]
        chunk = md[off:off + PAGE_SLICE]
        nxt = off + PAGE_SLICE if off + PAGE_SLICE < len(md) else None
        return f"[chars {off}-{off + len(chunk)} of {len(md)}; next_offset={nxt}]\n{chunk}", False
    return f"unknown tool {name}", True


def _r2(x):
    return None if x is None else round(x, 2)
