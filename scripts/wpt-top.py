import json, sys, io, re, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
path = sys.argv[1]; n = int(sys.argv[2]) if len(sys.argv) > 2 else 30
prefix = sys.argv[3] if len(sys.argv) > 3 else ''
res = [r for r in json.load(open(path, encoding='utf-8')) if r['test'].startswith(prefix)]
harness = collections.Counter(); msgs = collections.Counter(); files = collections.Counter()
for r in res:
    if r['status'] != 'OK':
        harness[(r['status'], re.sub(r'\d+', 'N', r.get('message', ''))[:110])] += 1
    fails = [s for s in r['subtests'] if s['status'] != 'PASS']
    files[r['test']] += len(fails)
    for s in fails:
        m = re.sub(r'"[^"]*"', '"…"', re.sub(r'\d+', 'N', s.get('message', '')))[:120]
        msgs[m] += 1
print("== harness problems =="); [print(f"{c:5} {k[0]:8} {k[1]}") for k, c in harness.most_common(n)]
print("== subtest failure messages =="); [print(f"{c:5} {k}") for k, c in msgs.most_common(n)]
print("== files with most failing subtests =="); [print(f"{c:5} {k}") for k, c in files.most_common(20)]
