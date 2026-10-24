"""Compact digest of `wpt one` JSON result lines read from stdin.

Usage: wpt one ... | python scripts/wpt-digest.py [max_failures]
"""
import json
import sys

limit = int(sys.argv[1]) if len(sys.argv) > 1 else 5
for line in sys.stdin:
    if not line.startswith('{"test"'):
        continue
    r = json.loads(line)
    subs = r["subtests"]
    passed = sum(1 for s in subs if s["status"] == "PASS")
    print("  %s %d/%d %s" % (r["status"], passed, len(subs), r.get("message", "")[:160]))
    shown = 0
    for s in subs:
        if s["status"] != "PASS" and shown < limit:
            shown += 1
            print("   - [%s] %s :: %s" % (s["status"], s["name"][:70], s.get("message", "")[:150]))
