#!/bin/sh
# Oct 17 2026, after the disk-full stop: Odysseys full-oct17 resumes (3 jobs) while BU Bench's
# unsuccessful InteractionTests rerun as fix-oct17bu (upload tool + date inputs, 2 jobs).
cd /c/Users/haris/Desktop/personal/browser || exit 1
PY=target/wheels/venv/Scripts/python.exe
export PYTHONIOENCODING=utf-8
(
  L=benchmarks/results/bu17-queue.log
  $PY benchmarks/seed-bu17.py > $L 2>&1 || exit 1
  sh benchmarks/loop.sh bubench fix-oct17bu 2 20 --limit 0 --page-timeout 90 --sites InteractionTests >> $L 2>&1
  $PY benchmarks/run.py bubench --run fix-oct17bu --jobs 2 --limit 0 --page-timeout 90 >> $L 2>&1
  echo "== bu17 done" >> $L
) &
L=benchmarks/results/od17-queue.log
sh benchmarks/loop.sh odysseys full-oct17 3 10 --limit 50 --page-timeout 90 > $L 2>&1
$PY benchmarks/run.py odysseys --run full-oct17 --jobs 2 --limit 50 --page-timeout 90 --retry-errors >> $L 2>&1
echo "== odysseys done" >> $L
wait
echo done > benchmarks/results/oct17b.done
