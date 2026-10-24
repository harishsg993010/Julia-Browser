import json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
path = sys.argv[1] if len(sys.argv) > 1 else 'wpt-results.json'
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 6
for r in json.load(open(path, encoding='utf-8')):
    p = sum(1 for s in r['subtests'] if s['status'] == 'PASS')
    print(f"{r['status']:8} {p}/{len(r['subtests'])} {r['test']}  {r.get('message','')[:200]}")
    n = 0
    for s in r['subtests']:
        if s['status'] != 'PASS' and n < limit:
            n += 1
            print('    ', s['status'], s['name'][:70], '|', s.get('message','')[:160].replace('\n', ' '))
