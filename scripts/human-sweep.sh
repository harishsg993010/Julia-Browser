#!/bin/sh
# Human-style interaction sweep on real sites (no logins): search, open results, navigate.
#   scripts/human-sweep.sh [exe] [site-regex]
# Each step's output goes to target/spot/sweep2/<site>.log with its wall time.
# Session commands write to files (the session daemon inherits pipes, so never pipe them).
EXE="${1:-./target/release/julia-browser.exe}"
ONLY="${2:-.}"
OUT=target/spot/sweep2
mkdir -p "$OUT"

step() { # site session cmd args...
  site="$1"; sess="$2"; shift 2
  t0=$(date +%s.%N)
  cmd="$1"; shift
  "$EXE" "$cmd" --session "$sess" "$@" > "$OUT/.step" 2>&1 < /dev/null
  rc=$?
  set -- "$cmd" "$@"
  t1=$(date +%s.%N)
  dt=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1f", b-a}')
  { echo "### [$dt s rc=$rc] $*"; head -c 1500 "$OUT/.step"; echo; } >> "$OUT/$site.log"
  printf '  %-6s %5ss rc=%s %s\n' "$site" "$dt" "$rc" "$*" | cut -c1-140
}

run() { # site then steps as "cmd|arg|arg" strings
  site="$1"; shift
  echo "$site" | grep -Eq "$ONLY" || return
  sess="hs-$site"
  : > "$OUT/$site.log"
  for s in "$@"; do
    IFS='!'; set -f; set -- $s; set +f; unset IFS
    step "$site" "$sess" "$@"
  done
  "$EXE" close --session "$sess" > /dev/null 2>&1 < /dev/null
}

URL='location.href + " | " + document.title'

run google \
  "open!https://www.google.com/" \
  "fill!textarea[name=q]!rust programming language" \
  "press!Enter" \
  "eval!$URL" \
  "eval![...document.querySelectorAll('h3')].slice(0,5).map(h=>h.textContent).join(' || ')"

run ddg \
  "open!https://duckduckgo.com/" \
  "fill![name=q]!best hiking trails in colorado" \
  "press!Enter" \
  "eval!$URL" \
  "eval![...document.querySelectorAll('h2 a, a[data-testid=result-title-a]')].slice(0,5).map(a=>a.textContent).join(' || ')"

run bing \
  "open!https://www.bing.com/" \
  "fill!#sb_form_q!weather in new york" \
  "press!Enter" \
  "eval!$URL" \
  "eval![...document.querySelectorAll('#b_results h2')].slice(0,5).map(h=>h.textContent).join(' || ')"

run wikipedia \
  "open!https://en.wikipedia.org/" \
  "fill!input[name=search]!Alan Turing" \
  "press!Enter" \
  "eval!$URL" \
  "click!text=Bletchley Park" \
  "eval!$URL"

run youtube \
  "open!https://www.youtube.com/" \
  "fill!input[name=search_query]!lofi hip hop" \
  "press!Enter" \
  "eval!$URL" \
  "eval![...document.querySelectorAll('a#video-title, #video-title')].slice(0,5).map(a=>a.textContent.trim()).join(' || ')" \
  "click!a#video-title" \
  "eval!$URL"

run amazon \
  "open!https://www.amazon.com/" \
  "fill!#twotabsearchtextbox!usb c cable" \
  "press!Enter" \
  "eval!$URL" \
  "eval![...document.querySelectorAll('[data-component-type=s-search-result] h2')].slice(0,5).map(h=>h.textContent.trim()).join(' || ')" \
  "click![data-component-type=s-search-result] h2" \
  "eval!$URL + ' | price=' + (document.querySelector('.a-price .a-offscreen')||{}).textContent"

run ebay \
  "open!https://www.ebay.com/" \
  "fill!#gh-ac!mechanical keyboard" \
  "press!Enter" \
  "eval!$URL" \
  "eval![...document.querySelectorAll('.s-item__title, .s-card__title')].slice(1,6).map(h=>h.textContent.trim()).join(' || ')"

run github \
  "open!https://github.com/search?q=web+browser+rust&type=repositories" \
  "eval!$URL" \
  "eval![...document.querySelectorAll('[data-testid=results-list] h3, .search-title')].slice(0,5).map(h=>h.textContent.trim()).join(' || ')" \
  "open!https://github.com/servo/servo" \
  "click!text=Issues" \
  "eval!$URL"

run hn \
  "open!https://news.ycombinator.com/" \
  "click!text=new" \
  "eval!$URL" \
  "click!.subline a[href^='item?id=']" \
  "eval!$URL + ' | comments=' + document.querySelectorAll('.comtr').length"

run npm \
  "open!https://www.npmjs.com/" \
  "fill!input[type=search]!react" \
  "press!Enter" \
  "eval!$URL" \
  "eval![...document.querySelectorAll('section h3')].slice(0,5).map(h=>h.textContent).join(' || ')"

run mdn \
  "open!https://developer.mozilla.org/en-US/" \
  "click!mdn-search-button button" \
  "fill!input[type=search]!flexbox" \
  "press!Enter" \
  "eval!$URL"

run imdb \
  "open!https://www.imdb.com/" \
  "fill!#suggestion-search!Inception" \
  "press!Enter" \
  "eval!$URL" \
  "eval![...document.querySelectorAll('.ipc-metadata-list-summary-item__t')].slice(0,5).map(a=>a.textContent).join(' || ')"

run bbc \
  "open!https://www.bbc.com/" \
  "click!text=Sport" \
  "eval!$URL" \
  "eval![...document.querySelectorAll('h2, h3')].slice(0,5).map(h=>h.textContent.trim()).join(' || ')"

run craigslist \
  "open!https://sfbay.craigslist.org/" \
  "fill!input[placeholder='search craigslist']!bicycle" \
  "press!Enter" \
  "eval!$URL" \
  "eval![...document.querySelectorAll('.cl-search-result .label, .result-title, .posting-title .label')].slice(0,5).map(a=>a.textContent).join(' || ')"

run weather \
  "open!https://www.timeanddate.com/weather/" \
  "fill!input[name=query]!Tokyo" \
  "press!Enter" \
  "eval!$URL"

run reddit \
  "open!https://www.reddit.com/r/programming/" \
  "eval!$URL" \
  "eval![...document.querySelectorAll('shreddit-post')].slice(0,5).map(p=>p.getAttribute('post-title')).join(' || ')"

run etsy \
  "open!https://www.etsy.com/" \
  "fill!#global-enhancements-search-query!handmade mug" \
  "press!Enter" \
  "eval!$URL"

run booking \
  "open!https://www.booking.com/" \
  "click![aria-label='Dismiss sign-in info.']" \
  "fill!input[name=ss]!Paris" \
  "eval!$URL + ' | value=' + document.querySelector('input[name=ss]').value" \
  "click![role=option]" \
  "click!button[type=submit]" \
  "eval!$URL + ' | cards=' + document.querySelectorAll('[data-testid=property-card]').length" \
  "eval![...document.querySelectorAll('[data-testid=title]')].slice(0,5).map(t=>t.textContent).join(' || ')"

run maps \
  "open!https://www.openstreetmap.org/" \
  "fill!#query!Eiffel Tower" \
  "press!Enter" \
  "eval!$URL" \
  "eval![...document.querySelectorAll('.search_results_entry a, #sidebar_content li')].slice(0,5).map(a=>a.textContent.trim()).join(' || ')"

run stackexchange \
  "open!https://superuser.com/" \
  "eval!$URL"

run archive \
  "open!https://archive.org/" \
  "eval!$URL" \
  "open!https://archive.org/search?query=apollo+11" \
  "eval!$URL + ' | items=' + document.querySelectorAll('tile-dispatcher, item-tile, .item-ia').length"

run pydocs \
  "open!https://docs.python.org/3/" \
  "fill!input[name=q]!asyncio" \
  "press!Enter" \
  "eval!$URL" \
  "eval![...document.querySelectorAll('#search-results li a')].slice(0,5).map(a=>a.textContent).join(' || ')"

run weathergov \
  "open!https://www.weather.gov/" \
  "fill!#inputstring!Denver, CO" \
  "click!#btnSearch" \
  "eval!$URL"

run allrecipes \
  "open!https://www.allrecipes.com/" \
  "fill!input[name=q]!banana bread" \
  "press!Enter" \
  "eval!$URL" \
  "eval![...document.querySelectorAll('.card__title-text')].slice(0,5).map(a=>a.textContent).join(' || ')"

run espn \
  "open!https://www.espn.com/" \
  "click!text=NFL" \
  "eval!$URL"
