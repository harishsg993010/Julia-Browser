"""One-line progress per suite: python benchmarks/status.py [run-name]

Without a run name, each suite shows its most recently updated run (smoke/test runs excluded)."""

import json
import sys
from pathlib import Path

RESULTS = Path(__file__).resolve().parent / "results"
TOTALS = {"mind2web": 300, "webvoyager": 643, "browsecomp": 100, "simpleqa-e2e": 200, "simpleqa-first": 200}


def latest_run(suite):
    runs = [p for p in (RESULTS / suite).glob("*/results.jsonl")
            if not p.parent.name.startswith(("smoke", "test"))]
    return max(runs, key=lambda p: p.stat().st_mtime).parent.name if runs else None


def main():
    parts = []
    for suite, total in TOTALS.items():
        run = sys.argv[1] if len(sys.argv) > 1 else latest_run(suite)
        path = RESULTS / suite / str(run) / "results.jsonl"
        if not run or not path.exists():
            parts.append(f"{suite}: not started")
            continue
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        n = len(rows)
        if suite == "simpleqa-e2e":
            ok = sum(r.get("grade") == "CORRECT" for r in rows)
        elif suite == "simpleqa-first":
            ok = sum(bool(r.get("evidence")) for r in rows)
        elif suite == "browsecomp":
            ok = sum(bool(r.get("correct")) for r in rows)
            done_ok = sum(r.get("status") in ("correct", "incorrect") and not r.get("timed_out") for r in rows)
            parts.append(f"browsecomp[{run}] {n}/{total} completed {done_ok}/{n}, correct {100 * ok / max(1, n):.1f}%")
            continue
        else:
            ok = sum(bool(r.get("success")) for r in rows)
        err = sum(r.get("status") == "error" for r in rows)
        blocked = sum(r.get("status") == "blocked" for r in rows)
        extra = f", {blocked} blocked" if blocked else ""
        extra += f", {err} errors" if err else ""
        done = " DONE" if (RESULTS / suite / run / "summary.json").exists() else ""
        parts.append(f"{suite}[{run}] {n}/{total} {100 * ok / max(1, n):.1f}%{extra}{done}")
    print(" | ".join(parts), flush=True)


if __name__ == "__main__":
    main()
