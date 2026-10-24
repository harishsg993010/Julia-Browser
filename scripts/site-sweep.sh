#!/usr/bin/env bash
# Load a list of real sites and report per site: load time, scripts run, and uncaught JS errors.
#   scripts/site-sweep.sh [exe] [sites...]     (default exe: target/release/julia-browser.exe)
#   JOBS=3 parallel loads; ERRS=3 errors shown per site.
EXE=${1:-target/release/julia-browser.exe}
shift || true
SITES=("$@")
if [ ${#SITES[@]} -eq 0 ]; then
  SITES=(https://github.com/rust-lang/rust https://dev.to https://www.npmjs.com/package/react https://medium.com
    https://www.netflix.com https://www.reuters.com https://www.figma.com https://vercel.com https://www.producthunt.com
    https://www.airbnb.com https://open.spotify.com https://www.apple.com https://stripe.com https://www.bbc.com
    "https://en.wikipedia.org/wiki/Rust_(programming_language)" https://www.youtube.com https://www.reddit.com
    https://www.linkedin.com https://www.cnn.com https://www.google.com https://news.ycombinator.com
    https://developer.mozilla.org/en-US/ https://react.dev https://www.theguardian.com https://www.twitch.tv)
fi
OUT=target/spot/sweep
mkdir -p "$OUT"
one() {
  local u=$1 name
  name=$(echo "$u" | sed -E 's#https?://##; s#[^A-Za-z0-9]+#_#g' | cut -c1-40)
  local t0=$SECONDS
  timeout 180 "$EXE" browse --format json "$u" > "$OUT/$name.json" 2>/dev/null
  local dt=$((SECONDS - t0))
  PYTHONIOENCODING=utf-8 ${PYTHON:-py} - "$OUT/$name.json" "$u" "$dt" "${ERRS:-3}" <<'PY'
import json, sys
path, url, dt, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
try:
    d = json.load(open(path, encoding="utf-8"))
except Exception as e:
    print(f"{url[:45]:46} {dt:>4}s  LOAD FAILED"); sys.exit()
j = d.get("javascript") or {}
errs = j.get("errors") or []
title = ((d.get("metadata") or {}).get("title") or "")[:40]
print(f"{url[:45]:46} {dt:>4}s  run={j.get('scripts_run', '?')} errs={len(errs)}  {title}")
for e in errs[:n]:
    print("      " + str(e).split("\n")[0][:220])
PY
}
export -f one
export EXE OUT ERRS
printf '%s\n' "${SITES[@]}" | xargs -P "${JOBS:-3}" -I{} bash -c 'one "$@"' _ {}
