#!/bin/sh
# Oct 17 2026 queue on dev219:
#  1. WebVoyager fix-oct17wv: date-shifted Booking / Google Flights / Apple--9 tasks (3 jobs), then the
#     unsuccessful Huggingface tasks with 1 job (fix-oct16wv hit HTTP 429), then the full summary.
#  2. BU Bench V1, all 100 tasks (run full-oct17).
#  3. Odysseys, 50-task sample (run full-oct17).
cd /c/Users/haris/Desktop/personal/browser || exit 1
PY=target/wheels/venv/Scripts/python.exe
export PYTHONIOENCODING=utf-8
L=benchmarks/results/oct17-queue.log

$PY benchmarks/seed-wv17.py > $L 2>&1
sh benchmarks/loop.sh webvoyager fix-oct17wv 3 25 --limit 0 --page-timeout 90 --shift-dates --sites "Booking,Google Flights,Apple" >> $L 2>&1
sh benchmarks/loop.sh webvoyager fix-oct17wv 1 25 --limit 0 --page-timeout 90 --shift-dates --sites Huggingface >> $L 2>&1
$PY benchmarks/run.py webvoyager --run fix-oct17wv --jobs 2 --limit 0 --page-timeout 90 --shift-dates --retry-errors >> $L 2>&1
echo "== webvoyager done" >> $L

sh benchmarks/loop.sh bubench full-oct17 3 20 --limit 0 --page-timeout 90 >> $L 2>&1
$PY benchmarks/run.py bubench --run full-oct17 --jobs 2 --limit 0 --page-timeout 90 --retry-errors >> $L 2>&1
echo "== bubench done" >> $L

sh benchmarks/loop.sh odysseys full-oct17 3 10 --limit 50 --page-timeout 90 >> $L 2>&1
$PY benchmarks/run.py odysseys --run full-oct17 --jobs 2 --limit 50 --page-timeout 90 --retry-errors >> $L 2>&1
echo "== odysseys done" >> $L
echo done > benchmarks/results/oct17-queue.done
