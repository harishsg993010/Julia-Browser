#!/bin/sh
cd /c/Users/haris/Desktop/personal/browser || exit 1
PY=target/wheels/venv/Scripts/python.exe
export PYTHONIOENCODING=utf-8
L=benchmarks/results/bu17-queue.log
$PY benchmarks/seed-bu17.py > $L 2>&1
sh benchmarks/loop.sh bubench fix-oct17bu 2 20 --limit 0 --page-timeout 90 --sites InteractionTests >> $L 2>&1
$PY benchmarks/run.py bubench --run fix-oct17bu --jobs 2 --limit 0 --page-timeout 90 >> $L 2>&1
echo "== bu17 done" >> $L
