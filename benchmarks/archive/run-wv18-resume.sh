#!/bin/sh
# WebVoyager fix-oct18wv: rerun every non-success of fix-oct17gh on dev224 (F1-F3 triage fixes).
cd /c/Users/haris/Desktop/personal/browser || exit 1
PY=target/wheels/venv/Scripts/python.exe
export PYTHONIOENCODING=utf-8
L=benchmarks/results/wv18-queue.log; echo "== resume $(date)" >> $L
sh benchmarks/loop.sh webvoyager fix-oct18wv 3 25 --limit 0 --page-timeout 90 --shift-dates \
  --sites "Allrecipes,Amazon,Apple,ArXiv,GitHub,Booking,Cambridge Dictionary,Coursera,ESPN,BBC News,Google Flights,Google Map,Google Search,Wolfram Alpha" >> $L 2>&1
# Huggingface alone with 1 job (429s), then anything left
sh benchmarks/loop.sh webvoyager fix-oct18wv 1 25 --limit 0 --page-timeout 90 --shift-dates --sites "Huggingface" >> $L 2>&1
$PY benchmarks/run.py webvoyager --run fix-oct18wv --jobs 2 --limit 0 --page-timeout 90 --shift-dates >> $L 2>&1
echo "== wv18 done" >> $L
