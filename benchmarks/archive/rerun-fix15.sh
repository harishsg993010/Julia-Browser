#!/bin/sh
# Re-run the unsuccessful Mind2Web tasks of fix-oct14c on dev212 (run fix-oct15, seeded with its
# successes by benchmarks/seed-run.py).
cd /c/Users/haris/Desktop/personal/browser || exit 1
sh benchmarks/loop.sh mind2web fix-oct15 3 25 --limit 0 --page-timeout 90 > benchmarks/results/mind2web-fix-oct15.log 2>&1
echo done > benchmarks/results/fix-oct15.done
