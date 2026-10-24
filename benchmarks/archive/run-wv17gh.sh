#!/bin/sh
cd /c/Users/haris/Desktop/personal/browser || exit 1
PY=target/wheels/venv/Scripts/python.exe
export PYTHONIOENCODING=utf-8
L=benchmarks/results/wv17gh-queue.log
$PY benchmarks/seed-wv17gh.py > $L 2>&1 || exit 1
sh benchmarks/loop.sh webvoyager fix-oct17gh 3 25 --limit 0 --page-timeout 90 --shift-dates --sites "GitHub,Booking" >> $L 2>&1
$PY benchmarks/run.py webvoyager --run fix-oct17gh --jobs 2 --limit 0 --page-timeout 90 --shift-dates >> $L 2>&1
echo "== wv17gh done" >> $L
