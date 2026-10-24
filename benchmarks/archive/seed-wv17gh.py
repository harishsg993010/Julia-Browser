"""Seed WebVoyager run fix-oct17gh from fix-oct17wv without the unsuccessful GitHub tasks (dev220 fixes
structuredClone on GitHub) and Booking--28 (Feb 29 -> 28 date shift fix). Task folders are hard-linked."""
import json
import os
import shutil
from pathlib import Path

root = Path(__file__).resolve().parent / "results" / "webvoyager"
src, dst = root / "fix-oct17wv", root / "fix-oct17gh"
assert not dst.exists(), dst
dst.mkdir()
kept = dropped = 0
with open(src / "results.jsonl", encoding="utf-8") as f, open(dst / "results.jsonl", "w", encoding="utf-8") as out:
    for line in f:
        if not line.strip():
            continue
        row = json.loads(line)
        if (row["id"].startswith("GitHub--") and not row.get("success")) or row["id"] == "Booking--28":
            dropped += 1
            continue
        out.write(line if line.endswith("\n") else line + "\n")
        kept += 1
        name = "".join(c if c.isalnum() or c in "-_" else "_" for c in row["id"])
        if (src / name).is_dir():
            shutil.copytree(src / name, dst / name, copy_function=os.link)
print(f"kept {kept}, dropped {dropped}")
