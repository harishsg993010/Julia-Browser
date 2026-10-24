#!/bin/sh
cd /c/Users/haris/Desktop/personal/browser || exit 1
export PYTHONIOENCODING=utf-8
L=benchmarks/results/bu17d-queue.log
sh benchmarks/loop.sh bubench fix-oct17bu 2 20 --limit 0 --page-timeout 90 --sites InteractionTests > $L 2>&1
target/wheels/venv/Scripts/python.exe benchmarks/run.py bubench --run fix-oct17bu --jobs 2 --limit 0 --page-timeout 90 >> $L 2>&1
echo "== bu17d done" >> $L
