"""julia-browser eval harness for the benchmarks in benchmark.txt.

    python benchmarks/run.py <suite|all> [--limit N] [--jobs N] [--run NAME] [...]
    python benchmarks/run.py report

Suites: search-latency, fetch-quality, simpleqa-first, simpleqa-e2e, browsecomp, webvoyager, mind2web,
bubench (BU Bench V1), odysseys.
Results: benchmarks/results/<suite>/<run>/ (results.jsonl, summary.json, per-task trajectories).
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from jbbench.llm import LLM  # noqa: E402
from jbbench.suites import LEADERS, SUITES  # noqa: E402
from jbbench import util  # noqa: E402
from jbbench.util import RESULTS, Run  # noqa: E402
from jbbench.web import Web  # noqa: E402

# Default item counts (pass --limit to change; 0 = the whole dataset).
DEFAULT_JOBS = {"search-latency": 2, "webvoyager": 3, "mind2web": 3, "browsecomp": 4, "bubench": 3, "odysseys": 3}


class Ctx:
    def __init__(self, args, suite):
        self.args = args
        self.limit = args.limit
        self.seed = args.seed
        self.jobs = args.jobs or DEFAULT_JOBS.get(suite, 6)
        self.run = Run(suite, args.run)
        self.web = Web(timeout_s=args.page_timeout, js_budget_ms=args.js_budget_ms)
        self.agent = LLM(args.model, args.effort)
        self.judge = LLM(args.judge_model, "low")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("suite", choices=[*SUITES, "all", "report"])
    p.add_argument("--limit", type=int, default=None, help="items to run (default per suite; 0 = all)")
    p.add_argument("--seed", type=int, default=0, help="seed for the item sample")
    p.add_argument("--jobs", type=int, default=None, help="parallel items (default 6; 3-4 for agent suites)")
    p.add_argument("--run", default=None, help="run name (default: timestamp); reuse a name to resume")
    p.add_argument("--model", default="claude-haiku-5-5", help="agent / answering model")
    p.add_argument("--judge-model", default="claude-haiku-5-5", help="judge / grader model")
    p.add_argument("--effort", default="medium", help="agent effort: low|medium|high|xhigh|max")
    p.add_argument("--page-timeout", type=int, default=45, help="hard wall-clock limit per browser call (s)")
    p.add_argument("--js-budget-ms", type=int, default=8000)
    p.add_argument("--top-k", type=int, default=3, help="simpleqa-e2e: results fetched per question")
    p.add_argument("--max-turns", type=int, default=30, help="browsecomp: agent turns per question")
    p.add_argument("--max-steps", type=int, default=None,
                   help="web agents: most browser actions per task (default 40; bubench 50, odysseys 100; "
                        "mind2web: 3x the reference length, at least 25)")
    p.add_argument("--task-timeout", type=int, default=None,
                   help="agent suites: wall-clock limit per task (s) (default 1500; bubench 1800, odysseys 3600)")
    p.add_argument("--no-vision", dest="vision", action="store_false", help="web agents: no screenshots to the agent")
    p.add_argument("--judge-shots", type=int, default=4, help="web agents: last N screenshots shown to the judge")
    p.add_argument("--sites", default=None, help="webvoyager: comma-separated site names (e.g. Allrecipes,GitHub); "
                                                 "bubench: categories (e.g. GAIA,BrowseComp); odysseys: levels (easy,medium,hard)")
    p.add_argument("--shift-dates", action="store_true",
                   help="webvoyager: move the past dates of booking/flight tasks (Booking, Google Flights, Apple--9) to "
                        "the same day in a future year; the original task is kept in the row as task_original")
    p.add_argument("--urls", default=None, help="fetch-quality: file with one URL per line instead of SimpleQA sources")
    p.add_argument("--max-items", type=int, default=None,
                   help="stop after N new items (exit code 3 while items remain); restart to continue - "
                        "bounds the engine's memory growth on long runs")
    p.add_argument("--retry-errors", action="store_true", help="re-run items whose row ended in an error")
    p.add_argument("--retry-read-fails", action="store_true",
                   help="web agents: also re-run failed tasks that used read_page before its text was saved for the judge")
    p.add_argument("--retry-failed", action="store_true",
                   help="web agents, after a full run: give every unsuccessful task (fail, timeout, max-steps, blocked) "
                        "one more attempt. The first attempt is kept in results.attempt1.jsonl (+ _attempt1/<task>/) "
                        "and the summary reports both the first-attempt and the with-retry success rate")
    args = p.parse_args()
    if args.limit == 0:
        args.limit = 10 ** 9

    if args.suite == "report":
        return report()
    args.run = args.run or datetime.now().strftime("%Y%m%d-%H%M%S")
    util.MAX_ITEMS = args.max_items
    remaining = False
    for suite in (SUITES if args.suite == "all" else [args.suite]):
        remaining |= run_suite(suite, args)
    report()
    # Leave without waiting on engine threads that a wedged page may still hold (summary is written).
    sys.stdout.flush()
    os._exit(3 if remaining else 0)


def run_suite(suite, args):
    """Run (or continue) one suite. Returns True when --max-items stopped it with items left."""
    ctx = Ctx(args, suite)
    if args.retry_errors or args.retry_read_fails:
        n = ctx.run.drop_errors(_read_without_text(ctx.run) if args.retry_read_fails else None)
        if n:
            print(f"[{suite}] retrying {n} errored items")
    if args.retry_failed:
        n = _start_retry(ctx.run)
        if n:
            print(f"[{suite}] second attempt for {n} unsuccessful tasks", flush=True)
    t0 = time.time()
    try:
        summary = SUITES[suite](ctx)
    finally:
        ctx.web.close()
    summary = {"suite": suite, "run": args.run, "wall_s": round(time.time() - t0),
               "leader": LEADERS[suite], **summary,
               "llm_cost": {"agent": ctx.agent.cost(), "judge": ctx.judge.cost()},
               "config": {k: v for k, v in vars(args).items() if k not in ("suite",)}}
    first = ctx.run.dir / "results.attempt1.jsonl"
    if first.exists():  # a --retry-failed run: keep the single-attempt number next to the retried one
        rows1 = [json.loads(line) for line in first.read_text(encoding="utf-8").splitlines() if line.strip()]
        summary["first_attempt_success_pct"] = round(100.0 * sum(bool(r.get("success")) for r in rows1) / max(1, len(rows1)), 1)
        summary["retried_tasks"] = sum(not r.get("success") for r in rows1)
        summary["note"] = ("success_pct includes one retry of each unsuccessful task; first_attempt_success_pct is "
                           "the single-attempt rate (comparable with leaderboard numbers)")
    total = getattr(ctx.run, "dataset_items", summary["items"])
    if summary["items"] < total:  # partial (--max-items): no summary file yet, so report/status don't show it as final
        print(f"[{suite}] {summary['items']}/{total} done; run again to continue")
        return True
    ctx.run.write_summary(summary)
    print(json.dumps(summary, indent=2), flush=True)
    return False


def _start_retry(run):
    """Archive the first attempt and drop unsuccessful rows so they run again. Idempotent: once
    results.attempt1.jsonl exists (the retry is under way, e.g. a later loop.sh chunk) it does nothing."""
    import shutil
    first = run.dir / "results.attempt1.jsonl"
    if first.exists() or not run.path.exists():
        return 0
    rows = run.rows()
    shutil.copyfile(run.path, first)
    retry = [r for r in rows if not r.get("success")]
    archive = run.dir / "_attempt1"
    archive.mkdir(exist_ok=True)
    for r in retry:  # keep the first attempt's trajectory; the retry writes a fresh task folder
        name = "".join(c if c.isalnum() or c in "-_" else "_" for c in r["id"])
        if (run.dir / name).exists():
            shutil.move(str(run.dir / name), str(archive / name))
    ids = {r["id"] for r in retry}
    with open(run.path, "w", encoding="utf-8") as f:
        for r in rows:
            if r["id"] not in ids:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    (run.dir / "summary.json").unlink(missing_ok=True)
    return len(retry)


def _read_without_text(run):
    """Predicate: a failed web-agent row whose history used read_page but kept none of its text."""
    def check(row):
        if row.get("status") not in ("fail", "max-steps", "timeout"):
            return False
        name = "".join(c if c.isalnum() or c in "-_" else "_" for c in row["id"])
        path = run.dir / name / "history.json"
        if not path.exists():
            return False
        hist = json.loads(path.read_text(encoding="utf-8"))
        return any(h["action"].startswith("READ PAGE") for h in hist) and not any(h.get("page_text") for h in hist)
    return check


def report():
    """REPORT.md: every suite's best run (most items, then newest) next to the leader numbers from
    benchmark.txt. Smoke/test runs are used only when nothing larger exists, and are labelled."""
    lines = ["# julia-browser vs benchmark.txt", "",
             "| Benchmark | julia-browser | Leader (benchmark.txt) | Items | Run |", "| --- | --- | --- | --- | --- |"]
    for suite in SUITES:
        sums = [json.loads(p.read_text(encoding="utf-8")) | {"_mtime": p.stat().st_mtime}
                for p in (RESULTS / suite).glob("*/summary.json")]
        if not sums:
            lines.append(f"| {suite} | not run | {LEADERS[suite]} | | |")
            continue
        smoke = lambda s: s["run"].startswith(("smoke", "test"))
        s = max(sums, key=lambda s: (not smoke(s), s["items"], s["_mtime"]))
        ours = "; ".join(f"{h[0]}: **{h[1]}**" for h in (s.get("headline"), s.get("headline2"), s.get("headline3")) if h)
        if "first_attempt_success_pct" in s:  # a --retry-failed run: lead with the comparable single-attempt rate
            ours = (f"success rate, first attempt (%): **{s['first_attempt_success_pct']}**; "
                    f"with one retry of unsuccessful tasks: {s['success_pct']}")
        run = f"{s['run']} (smoke test only)" if smoke(s) else s["run"]
        lines.append(f"| {suite} | {ours} | {s['leader']} | {s['items']} | {run} |")
    lines += ["", "Details: `results/<suite>/<run>/summary.json`; per-item rows in `results.jsonl`."]
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def keep_awake():
    """Keep Windows from sleeping while a run is in progress (an overnight run once sat in Modern
    Standby for 4.5 h: every in-flight task 'timed out'). Holds until this process exits."""
    if os.name == "nt":
        try:
            import ctypes
            ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
        except Exception:
            pass


if __name__ == "__main__":
    keep_awake()
    main()
