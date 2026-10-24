#!/bin/sh
# Re-run the unsuccessful Mind2Web and WebVoyager tasks (run fix-oct13c, seeded with the successes of
# fix-oct13b by benchmarks/seed-run.py), one suite at a time.
cd /c/Users/haris/Desktop/personal/browser || exit 1
sh benchmarks/loop.sh mind2web fix-oct13c 3 25 --limit 0 > benchmarks/results/mind2web-fix-oct13c.log 2>&1
sh benchmarks/loop.sh webvoyager fix-oct13c 3 25 --limit 0 > benchmarks/results/webvoyager-fix-oct13c.log 2>&1
echo done > benchmarks/results/fix-oct13c.done
