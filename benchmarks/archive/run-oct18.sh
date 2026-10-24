#!/bin/sh
# dev221 reruns of every unsuccessful Odysseys and BU Bench task (engine fixes: worker WebSocket,
# Content-Length 0, noscript layout, image failure cache, detached-element layout; harness: keep_tab,
# incomplete-answer pushback, truth match, judge evidence weighting).
cd /c/Users/haris/Desktop/personal/browser || exit 1
PY=target/wheels/venv/Scripts/python.exe
export PYTHONIOENCODING=utf-8
L=benchmarks/results/oct18-queue.log
$PY benchmarks/seed-rerun.py bubench fix-oct17bu fix-oct18bu > $L 2>&1 || exit 1
$PY benchmarks/seed-rerun.py odysseys full-oct17 fix-oct18od >> $L 2>&1 || exit 1
sh benchmarks/loop.sh bubench fix-oct18bu 3 20 --limit 0 --page-timeout 90 >> $L 2>&1
$PY benchmarks/run.py bubench --run fix-oct18bu --jobs 2 --limit 0 --page-timeout 90 >> $L 2>&1
echo "== bubench done" >> $L
sh benchmarks/loop.sh odysseys fix-oct18od 3 10 --limit 50 --page-timeout 90 >> $L 2>&1
$PY benchmarks/run.py odysseys --run fix-oct18od --jobs 2 --limit 50 --page-timeout 90 >> $L 2>&1
echo "== odysseys done" >> $L
echo done > benchmarks/results/oct18.done
