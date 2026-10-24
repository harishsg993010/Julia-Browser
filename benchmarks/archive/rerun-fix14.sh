#!/bin/sh
# Re-run the unsuccessful Mind2Web tasks of fix-oct13c (run fix-oct14, seeded with its successes
# by benchmarks/seed-run.py).
cd /c/Users/haris/Desktop/personal/browser || exit 1
sh benchmarks/loop.sh mind2web fix-oct14 3 25 --limit 0 > benchmarks/results/mind2web-fix-oct14.log 2>&1
echo done > benchmarks/results/fix-oct14.done
