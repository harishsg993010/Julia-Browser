"""Failing subtests of the result files whose path contains a substring.
  py scripts/wpt-file.py target/wpt-X.json <substring> [limit]"""
import io, json, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
res, sub = sys.argv[1], sys.argv[2]
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 8
for r in json.load(open(res, encoding="utf-8")):
    if sub not in r["test"]:
        continue
    p = sum(1 for s in r["subtests"] if s["status"] == "PASS")
    print(f"{r['status']:8} {p}/{len(r['subtests'])} {r['test']}  {r.get('message', '')[:200]}")
    n = 0
    for s in r["subtests"]:
        if s["status"] != "PASS" and n < limit:
            n += 1
            print("    ", s["status"], s["name"][:90], "|", (s.get("message") or "")[:220].replace("\n", " "))
