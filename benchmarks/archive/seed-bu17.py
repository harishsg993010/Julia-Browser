"""Seed BU Bench run fix-oct17bu from full-oct17 without the unsuccessful InteractionTests tasks
(rerun with the harness's new upload tool and date-input handling)."""
import json
import shutil
from pathlib import Path

root = Path(__file__).resolve().parent / "results" / "bubench"
src, dst = root / "full-oct17", root / "fix-oct17bu"
assert not dst.exists(), dst
dst.mkdir()
kept = dropped = 0
with open(src / "results.jsonl", encoding="utf-8") as f, open(dst / "results.jsonl", "w", encoding="utf-8") as out:
    for line in f:
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("category") == "InteractionTests" and not row.get("success"):
            dropped += 1
            continue
        out.write(line if line.endswith("\n") else line + "\n")
        kept += 1
        name = "".join(c if c.isalnum() or c in "-_" else "_" for c in row["id"])
        if (src / name).is_dir():
            shutil.copytree(src / name, dst / name)
print(f"kept {kept}, dropped {dropped}")
