"""Seed run NEW from OLD keeping every row except tasks whose start_url matches one of the given substrings.
   python benchmarks/seed-except.py <old> <new> <substr>..."""
import json, shutil, sys
from pathlib import Path

old, new, *pats = sys.argv[1:]
root = Path(r"C:\Users\haris\Desktop\personal\browser\benchmarks\results\mind2web")
src, dst = root / old, root / new
assert not dst.exists(), dst
dst.mkdir()
kept = dropped = 0
with open(src / "results.jsonl", encoding="utf8") as f, open(dst / "results.jsonl", "w", encoding="utf8") as out:
    for line in f:
        if not line.strip():
            continue
        row = json.loads(line)
        if any(p in row["start_url"] for p in pats):
            dropped += 1
            continue
        out.write(line if line.endswith("\n") else line + "\n")
        kept += 1
        if (src / str(row["id"])).is_dir():
            shutil.copytree(src / str(row["id"]), dst / str(row["id"]))
for extra in ("config.json", "items.json"):
    if (src / extra).exists():
        shutil.copy(src / extra, dst / extra)
print(f"kept {kept}, dropped {dropped}")
