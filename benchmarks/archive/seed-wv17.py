"""Seed WebVoyager run fix-oct17wv from fix-oct16wv, dropping the tasks to run again:
every date-shifted task (Booking / Google Flights / Apple--9, see data.DATE_SHIFT_SITES) and every
unsuccessful Huggingface task (HTTP 429 rate limit during fix-oct16wv)."""
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jbbench import data  # noqa: E402

root = Path(__file__).resolve().parent / "results" / "webvoyager"
src, dst = root / "fix-oct16wv", root / "fix-oct17wv"
assert not dst.exists(), dst
shifted = {it["id"] for it in data.webvoyager(10 ** 9, shift_dates=True) if it.get("date_shift_years")}
dst.mkdir()
kept = dropped = 0
with open(src / "results.jsonl", encoding="utf-8") as f, open(dst / "results.jsonl", "w", encoding="utf-8") as out:
    for line in f:
        if not line.strip():
            continue
        row = json.loads(line)
        if row["id"] in shifted or (row["id"].startswith("Huggingface--") and not row.get("success")):
            dropped += 1
            continue
        out.write(line if line.endswith("\n") else line + "\n")
        kept += 1
        name = "".join(c if c.isalnum() or c in "-_" else "_" for c in row["id"])
        if (src / name).is_dir():
            shutil.copytree(src / name, dst / name)
print(f"kept {kept}, dropped {dropped} ({len(shifted)} date-shifted)")
