"""Start a new run from an old one's successes, so only the unsuccessful tasks are run again.
    python benchmarks/seed-run.py <suite> <old-run> <new-run>"""
import json
import shutil
import sys
from pathlib import Path

suite, old, new = sys.argv[1:4]
root = Path(__file__).resolve().parent / "results" / suite
src, dst = root / old, root / new
if dst.exists():
    sys.exit(f"{dst} exists")
dst.mkdir(parents=True)
kept = 0
with open(src / "results.jsonl", encoding="utf8") as f, open(dst / "results.jsonl", "w", encoding="utf8") as out:
    for line in f:
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("success"):
            out.write(line if line.endswith("\n") else line + "\n")
            kept += 1
            task_dir = src / str(row["id"])
            if task_dir.is_dir():
                shutil.copytree(task_dir, dst / str(row["id"]))
for extra in ("config.json", "items.json"):
    if (src / extra).exists():
        shutil.copy(src / extra, dst / extra)
print(f"{suite}: kept {kept} successes from {old} in {new}")
