#!/bin/sh
# Resume run fix-oct14c (stopped at 281/300 on Oct 15): runs only the items not yet in results.jsonl.
cd /c/Users/haris/Desktop/personal/browser || exit 1
sh benchmarks/loop.sh mind2web fix-oct14c 3 25 --limit 0 --page-timeout 90 >> benchmarks/results/mind2web-fix-oct14c.log 2>&1
echo done > benchmarks/results/fix-oct14c.done
