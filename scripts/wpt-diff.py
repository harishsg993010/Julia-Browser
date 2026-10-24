"""Compare per-file pass counts of two WPT result files: wpt-diff.py OLD NEW [prefix]."""
import json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

def load(path):
    out = {}
    for r in json.load(open(path, encoding='utf-8')):
        out[r['test']] = (sum(1 for s in r['subtests'] if s['status'] == 'PASS'), len(r['subtests']), r['status'])
    return out

old, new = load(sys.argv[1]), load(sys.argv[2])
prefix = sys.argv[3] if len(sys.argv) > 3 else ''
tests = sorted(t for t in new if t.startswith(prefix))
common = [t for t in tests if t in old]
op = sum(old[t][0] for t in common); np = sum(new[t][0] for t in common)
print(f"{len(common)} common files: old {op} passing, new {np} passing; {len(tests) - len(common)} files only in new")
for t in common:
    if old[t][0] != new[t][0] or old[t][2] != new[t][2]:
        print(f"  {old[t][0]:4} -> {new[t][0]:4} /{new[t][1]:<4} {old[t][2]:>7}->{new[t][2]:<7} {t}")
