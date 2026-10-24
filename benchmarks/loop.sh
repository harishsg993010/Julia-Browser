#!/bin/sh
# Run a suite in chunks of fresh processes, so engine memory is returned between chunks.
#   sh benchmarks/loop.sh <suite> <run-name> <jobs> <chunk> [extra run.py args...]
# e.g. sh benchmarks/loop.sh mind2web full-oct11 2 20 --limit 0
# The first chunk also re-runs items that ended in an error (--retry-errors).
cd "$(dirname "$0")/.." || exit 1
PY=${PY:-target/wheels/venv/Scripts/python.exe}
suite=$1; run=$2; jobs=$3; chunk=$4; shift 4
export PYTHONIOENCODING=utf-8
retry=--retry-errors
while true; do
  "$PY" benchmarks/run.py "$suite" --run "$run" --jobs "$jobs" --max-items "$chunk" $retry "$@"
  code=$?
  retry=
  [ $code -eq 3 ] || exit $code   # 3 = items remain; anything else = done or a crash
done
