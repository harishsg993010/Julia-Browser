#!/bin/bash
# Render real sites three ways — Markdown in DOM order, Markdown in visual
# order and the character-cell screenshot — and summarise sizes and timings.
# Needs a release build with the layout feature:
#   cargo build --release --features layout --bin julia-browser
#   scripts/spot-check.sh [site ...]        # default: the six sites below
# Outputs land in target/spot/<name>.{dom.md,vis.md,layout.txt,err}.
set -u
cd "$(dirname "$0")/.."
EXE=target/release/julia-browser.exe
[ -x "$EXE" ] || EXE=target/release/julia-browser
OUT=target/spot
mkdir -p "$OUT"
SITES=("react https://react.dev" "hn https://news.ycombinator.com" "wiki https://en.wikipedia.org/wiki/Rust_(programming_language)" "github https://github.com/DioxusLabs/blitz" "vue https://vuejs.org" "todomvc https://todomvc.com/examples/react/dist/")
if [ $# -gt 0 ]; then SITES=("$@"); fi

ms() { echo $(( ($2 - $1) / 1000000 )); }
for site in "${SITES[@]}"; do
  set -- $site
  name=$1; url=$2
  t0=$(date +%s%N)
  JB_DOM_ORDER=1 timeout 120 "$EXE" render "$url" --format markdown -o "$OUT/$name.dom.md" >/dev/null 2>"$OUT/$name.err"
  t1=$(date +%s%N)
  timeout 120 "$EXE" render "$url" --format markdown -o "$OUT/$name.vis.md" >/dev/null 2>>"$OUT/$name.err"
  t2=$(date +%s%N)
  timeout 120 "$EXE" render "$url" --format layout -o "$OUT/$name.layout.txt" >/dev/null 2>>"$OUT/$name.err"
  t3=$(date +%s%N)
  size() { [ -f "$1" ] && wc -c < "$1" || echo "-"; }
  printf "%-8s dom %5s ms %7s B | visual %5s ms %7s B | layout %5s ms %7s B\n" "$name" "$(ms $t0 $t1)" "$(size "$OUT/$name.dom.md")" "$(ms $t1 $t2)" "$(size "$OUT/$name.vis.md")" "$(ms $t2 $t3)" "$(size "$OUT/$name.layout.txt")"
done
