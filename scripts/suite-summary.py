"""Per-suite pass rates from one runner result file.
  py scripts/suite-summary.py target/wpt-X.json [depth]   (depth 1 = top dir, 2 = css/<module>)"""
import json, sys
from collections import defaultdict

r = json.load(open(sys.argv[1], encoding="utf-8"))
depth = int(sys.argv[2]) if len(sys.argv) > 2 else 1
agg = defaultdict(lambda: [0, 0, 0, 0])
for t in r:
    parts = t["test"].strip("/").split("/")
    d = depth + 1 if parts[0] == "css" and depth == 1 else depth
    key = "/".join(parts[:d])
    a = agg[key]
    a[0] += sum(1 for s in t["subtests"] if s["status"] == "PASS")
    a[1] += len(t["subtests"]) or 1  # a file that produced no subtests counts as one failure
    a[2] += 1
    a[3] += t["status"] == "TIMEOUT"
for k, (p, n, f, to) in sorted(agg.items(), key=lambda kv: kv[1][0] / max(kv[1][1], 1)):
    print(f"{k:45} {p:>7}/{n:<7} {100*p/max(n,1):5.1f}%  files={f} timeouts={to}")
P = sum(a[0] for a in agg.values()); N = sum(a[1] for a in agg.values())
print(f"{'TOTAL':45} {P:>7}/{N:<7} {100*P/max(N,1):5.1f}%")
