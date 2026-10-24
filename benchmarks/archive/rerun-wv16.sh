#!/bin/sh
# Re-run the unsuccessful (and never-run) WebVoyager tasks of fix-oct13c on dev219 (run fix-oct16wv, seeded with its successes).
cd /c/Users/haris/Desktop/personal/browser || exit 1
target/wheels/venv/Scripts/python.exe benchmarks/seed-run.py webvoyager fix-oct13c fix-oct16wv > benchmarks/results/webvoyager-fix-oct16wv.log 2>&1
sh benchmarks/loop.sh webvoyager fix-oct16wv 3 25 --limit 0 --page-timeout 90 >> benchmarks/results/webvoyager-fix-oct16wv.log 2>&1
target/wheels/venv/Scripts/python.exe benchmarks/run.py webvoyager --run fix-oct16wv --jobs 2 --limit 0 --page-timeout 90 --retry-errors >> benchmarks/results/webvoyager-fix-oct16wv.log 2>&1
echo done > benchmarks/results/fix-oct16wv.done
