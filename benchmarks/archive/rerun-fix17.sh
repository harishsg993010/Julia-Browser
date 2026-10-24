#!/bin/sh
# Re-run the unsuccessful Mind2Web tasks of fix-oct16 on dev217 (run fix-oct17, seeded with its successes).
cd /c/Users/haris/Desktop/personal/browser || exit 1
target/wheels/venv/Scripts/python.exe benchmarks/seed-run.py mind2web fix-oct16 fix-oct17 > benchmarks/results/mind2web-fix-oct17.log 2>&1
sh benchmarks/loop.sh mind2web fix-oct17 3 25 --limit 0 --page-timeout 90 >> benchmarks/results/mind2web-fix-oct17.log 2>&1
target/wheels/venv/Scripts/python.exe benchmarks/run.py mind2web --run fix-oct17 --jobs 2 --limit 0 --page-timeout 90 --retry-errors >> benchmarks/results/mind2web-fix-oct17.log 2>&1
echo done > benchmarks/results/fix-oct17.done
