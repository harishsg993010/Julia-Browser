#!/bin/bash
# Authentication smoke test on public demo sites (published test credentials only): log in
# through the interactive CLI with real user actions and report where the session ends up.
#   scripts/auth-check.sh [exe]      (default: target/release/julia-browser.exe)
#   ONLY=<regex> limits the scenarios run.
set -u
cd "$(dirname "$0")/.."
EXE=${1:-target/release/julia-browser.exe}
OUT=target/spot/auth
mkdir -p "$OUT"
run() { # name, commands...
  local name=$1; shift
  if [ -n "${ONLY:-}" ] && ! [[ "$name" =~ $ONLY ]]; then return; fi
  local t0=$(date +%s)
  printf '%s\n' "$@" "quit" | timeout 300 "$EXE" interactive > "$OUT/$name.log" 2>&1
  local probe=$(grep -E "^.*→ " "$OUT/$name.log" | tail -1 | sed 's/.*→ //')
  printf "%-16s %4ss  %s\n" "$name" "$(( $(date +%s) - t0 ))" "$probe"
}
# Classic server-side form login: POST, redirect, cookie session, logout link.
run herokuapp "open https://the-internet.herokuapp.com/login" \
  "fill #username tomsmith" "fill #password SuperSecretPassword!" "click button[type=submit]" \
  "js location.pathname + ' | ' + (document.querySelector('#flash') || {}).textContent.trim().split('\\n')[0]"
# Wrong password stays on the login page with an error.
run herokuapp-bad "open https://the-internet.herokuapp.com/login" \
  "fill #username tomsmith" "fill #password wrong" "click button[type=submit]" \
  "js location.pathname + ' | ' + (document.querySelector('#flash') || {}).textContent.trim().split('\\n')[0]"
# Form with a CSRF token (Flask/Scrapy demo).
run quotes "open https://quotes.toscrape.com/login" \
  "fill #username demo" "fill #password demo" "click input[type=submit]" \
  "js location.pathname + ' | ' + Array.from(document.links).map(function (a) { return a.textContent.trim(); }).filter(function (t) { return /logout/i.test(t); }).join(',')"
# React SPA login with client-side routing and localStorage/cookie session.
run saucedemo "open https://www.saucedemo.com/" \
  "fill #user-name standard_user" "fill #password secret_sauce" "click #login-button" \
  "wait .inventory_item" \
  "js location.pathname + ' | items=' + document.querySelectorAll('.inventory_item').length"
# WordPress-style practice page.
run practice "open https://practicetestautomation.com/practice-test-login/" \
  "fill #username student" "fill #password Password123" "click #submit" \
  "js location.pathname + ' | ' + (document.querySelector('h1') || {}).textContent"
# Form auth with a redirect to a protected page.
run authtest "open https://authenticationtest.com/simpleFormAuth/" \
  "fill #email simpleForm@authenticationtest.com" "fill #password pa\$\$w0rd" "click input[type=submit]" \
  "js location.pathname + ' | ' + (document.querySelector('h1, h2') || {}).textContent"
# Vue SPA with an XHR login and a dashboard (heavy).
run orangehrm "open https://opensource-demo.orangehrmlive.com/web/index.php/auth/login" \
  "wait input[name=username]" "fill input[name=username] Admin" "fill input[name=password] admin123" "click button[type=submit]" \
  "wait .oxd-topbar-header-breadcrumb" \
  "js location.pathname + ' | ' + (document.querySelector('.oxd-topbar-header-breadcrumb') || {}).textContent"
