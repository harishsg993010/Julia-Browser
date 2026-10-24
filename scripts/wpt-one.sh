#!/bin/sh
# Run single WPT files against an already running `wpt serve` (started by a
# `--wptserve` run) with a chosen runner and print a compact pass/fail digest.
#   scripts/wpt-one.sh target/debug/wpt.exe html/semantics/popovers/popover-events.html ...
# WPT_ONE_FAILS=N limits the failing subtests listed per file (default 5).
EXE="$1"; shift
export JB_RESOLVE_HOSTS="web-platform.test,www.web-platform.test,www1.web-platform.test,www2.web-platform.test,xn--n8j6ds53lwwkrqhv28a.web-platform.test,xn--lve-6lad.web-platform.test,not-web-platform.test,www.not-web-platform.test,www1.not-web-platform.test,www2.not-web-platform.test,xn--n8j6ds53lwwkrqhv28a.not-web-platform.test,xn--lve-6lad.not-web-platform.test"
export JB_INSECURE_TLS=1 JB_WPT_HTTPS_BASE="https://web-platform.test:8443"
for t in "$@"; do
  echo "=== $t"
  timeout 90 "$EXE" one --root ../wpt --base http://web-platform.test:8000 "$t" 2>/dev/null | ${PYTHON:-py} scripts/wpt-digest.py "${WPT_ONE_FAILS:-5}"
done
