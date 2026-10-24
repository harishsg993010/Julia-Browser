#!/bin/sh
# BrowseComp, 100 questions (same sample as full-oct11), on dev219: run full-oct16.
cd /c/Users/haris/Desktop/personal/browser || exit 1
sh benchmarks/loop.sh browsecomp full-oct16 3 20 --limit 100 > benchmarks/results/browsecomp-full-oct16.log 2>&1
target/wheels/venv/Scripts/python.exe benchmarks/run.py browsecomp --run full-oct16 --jobs 2 --limit 100 --retry-errors >> benchmarks/results/browsecomp-full-oct16.log 2>&1
echo done > benchmarks/results/bc-full-oct16.done
