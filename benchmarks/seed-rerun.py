"""Seed a rerun: copy a run's successful rows (task folders hard-linked) into a new run, so the
next run.py/loop.sh pass reruns every unsuccessful task.
    py benchmarks/seed-rerun.py <suite> <from-run> <to-run>"""
import json
import os
import shutil
import sys
from pathlib import Path

suite, src_run, dst_run = sys.argv[1:4]
root = Path(__file__).resolve().parent / "results" / suite
src, dst = root / src_run, root / dst_run
assert not dst.exists(), dst
dst.mkdir()
kept = dropped = 0
with open(src / "results.jsonl", encoding="utf-8") as f, open(dst / "results.jsonl", "w", encoding="utf-8") as out:
    for line in f:
        if not line.strip():
            continue
        row = json.loads(line)
        if not row.get("success"):
            dropped += 1
            continue
        out.write(line if line.endswith("\n") else line + "\n")
        kept += 1
        name = "".join(c if c.isalnum() or c in "-_" else "_" for c in row["id"])
        if (src / name).is_dir():
            shutil.copytree(src / name, dst / name, copy_function=os.link)
print(f"{suite} {dst_run}: kept {kept}, rerunning {dropped}")
