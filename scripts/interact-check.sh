#!/bin/bash
# Interaction smoke test on real sites: drive the interactive CLI with user actions
# (fill / press / check / click) and report a JS probe per scenario.
#   scripts/interact-check.sh [exe]      (default: target/release/julia-browser.exe)
#   ONLY=<regex> limits the scenarios run.
set -u
cd "$(dirname "$0")/.."
EXE=${1:-target/release/julia-browser.exe}
OUT=target/spot/interact
mkdir -p "$OUT"
run() { # name, commands...
  local name=$1; shift
  if [ -n "${ONLY:-}" ] && ! [[ "$name" =~ $ONLY ]]; then return; fi
  local t0=$(date +%s)
  printf '%s\n' "$@" "quit" | timeout 300 "$EXE" interactive > "$OUT/$name.log" 2>&1
  local probe=$(grep -E "^.*→ " "$OUT/$name.log" | tail -1 | sed 's/.*→ //')
  printf "%-14s %4ss  %s\n" "$name" "$(( $(date +%s) - t0 ))" "$probe"
}
todo() { # name url-path
  run "todo-$1" "open https://todomvc.com/examples/$2" \
    "fill .new-todo Buy milk" "press Enter" "fill .new-todo Walk dog" "press Enter" \
    "check .todo-list li .toggle" \
    "js 'items=' + (__jb.user.findAll('.todo-list li').length || __jb.user.findAll('todo-item').length) + ' count=' + __jb.user.findAll('.todo-count').map(function (e) { return e.textContent.trim(); }).join('|')"
}
todo react react/dist/
todo vue vue/dist/
todo preact preact/dist/
todo svelte svelte/dist/
todo angular angular/dist/browser/
todo jquery jquery/dist/
todo lit lit/dist/
run ddg "open https://html.duckduckgo.com/html/" "fill input[name=q] servo browser" "press Enter" \
  "js document.title + ' results=' + document.querySelectorAll('.result').length"
run wiki "open https://en.wikipedia.org/wiki/Main_Page" "fill input[name=search] Rust programming language" "press Enter" \
  "js location.pathname"
run hn "open https://news.ycombinator.com/" "click text=new" "js location.pathname + ' rows=' + document.querySelectorAll('.athing').length"
run github "open https://github.com/DioxusLabs/blitz" "click a[href=\"/DioxusLabs/blitz/issues\"]" "js location.pathname + ' rows=' + Array.from(document.links).filter(function (a) { return /\/blitz\/issues\/\d+/.test(a.href); }).length"
run mdn "open https://developer.mozilla.org/en-US/" "click mdn-search-button button" "fill input[type=search] flexbox" "press Enter" "js location.pathname + location.search"
run reactdev "open https://react.dev/learn" "click text=Thinking in React" "js location.pathname + ' | ' + document.title"
run amazon "open https://www.amazon.com" "fill #twotabsearchtextbox usb cable" "press Enter" "js location.pathname + ' ' + document.title.slice(0,60)"
