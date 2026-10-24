import json
import os
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RESULTS = ROOT / "results"


class Run:
    """One run of one suite: results/<suite>/<name>/results.jsonl (+ summary.json).

    Rows are appended as items finish, so an interrupted run resumes where it stopped
    (items whose id is already in results.jsonl are skipped).
    """

    def __init__(self, suite: str, name: str):
        self.dir = RESULTS / suite / name
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "results.jsonl"
        self._lock = threading.Lock()

    def rows(self):
        if not self.path.exists():
            return []
        with open(self.path, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def done_ids(self):
        return {r["id"] for r in self.rows()}

    def drop_errors(self, also=None):
        """Remove rows that ended in a harness/infrastructure error (or match `also(row)`) so they
        run again."""
        rows = self.rows()
        keep = [r for r in rows if r.get("status") != "error" and not (also and also(r))]
        if len(keep) != len(rows):
            with self._lock, open(self.path, "w", encoding="utf-8") as f:
                for r in keep:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
        return len(rows) - len(keep)

    def add(self, row):
        with self._lock, open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    def write_summary(self, summary):
        (self.dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")


MAX_ITEMS = None  # set from --max-items: stop after this many new items (the caller restarts us)


def run_items(run: Run, items, fn, jobs: int, label: str):
    """Run fn(item) -> row dict for every item not yet in the run, `jobs` at a time."""
    done = run.done_ids()
    todo = [it for it in items if it["id"] not in done]
    run.dataset_items = len(items)
    if MAX_ITEMS is not None:
        todo = todo[:MAX_ITEMS]
    print(f"[{label}] {len(items)} items, {len(items) - len(todo)} already done, {len(todo)} to run, jobs={jobs}")
    t0 = time.time()
    n = 0
    with ThreadPoolExecutor(max_workers=jobs) as ex:
        futs = {ex.submit(_safe, fn, it): it for it in todo}
        for fut in as_completed(futs):
            row = fut.result()
            run.add(row)
            n += 1
            status = row.get("status") or ("ok" if not row.get("error") else "error")
            print(f"[{label}] {n}/{len(todo)} {row['id']} {status} ({time.time() - t0:.0f}s)", flush=True)
    return run.rows()


def _safe(fn, item):
    t = time.time()
    try:
        row = fn(item)
    except Exception as e:  # one broken item must not stop the run
        row = {"error": f"{type(e).__name__}: {e}", "status": "error"}
    row.setdefault("id", item["id"])
    row.setdefault("elapsed_s", round(time.time() - t, 3))
    return row


def pct(values, p):
    values = sorted(values)
    if not values:
        return None
    k = (len(values) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


def mean(values):
    return statistics.fmean(values) if values else None


def rate(flags):
    flags = list(flags)
    return round(100.0 * sum(1 for f in flags if f) / len(flags), 1) if flags else None


def env_int(name, default):
    return int(os.environ.get(name, default))
