#!/bin/sh
# Human-style sweep of 50 popular Indian websites (25 government, 25 private), no logins/OTP/payments.
#   scripts/human-sweep-india.sh [exe] [site-regex]
# Each step's output goes to target/spot/sweep-india/<site>.log with its wall time.
# Session commands write to files (the session daemon inherits pipes, so never pipe them).
EXE="${1:-./target/jb-india.exe}"
ONLY="${2:-.*}"
OUT=target/spot/sweep-india
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
  printf '  %-12s %5ss rc=%s %s\n' "$site" "$dt" "$rc" "$*" | cut -c1-140
}

run() { # site then steps as "cmd!arg!arg" strings
  site="$1"; shift
  echo "$site" | grep -Eq "^($ONLY)\$" || return
  sess="in-$site"
  : > "$OUT/$site.log"
  for s in "$@"; do
    IFS='!'; set -f; set -- $s; set +f; unset IFS
    step "$site" "$sess" "$@"
  done
  "$EXE" close --session "$sess" > /dev/null 2>&1 < /dev/null
}

URL='location.href + " | " + document.title'
# first 5 texts of a selector list
T() { echo "[...document.querySelectorAll('$1')].map(e=>e.textContent.trim().replace(/\\s+/g,' ').slice(0,80)).filter(Boolean).slice(0,5).join(' || ')"; }
TXT='document.body ? document.body.innerText.length + " chars: " + document.body.innerText.replace(/\s+/g," ").slice(0,300) : "no body"'
# text of links whose href contains a pattern
L() { echo "[...document.querySelectorAll('a[href*=\"$1\"]')].map(e=>e.textContent.trim().replace(/\\s+/g,' ').slice(0,80)).filter(Boolean).slice(0,5).join(' || ')"; }

# ---------------------------------------------------------------- government
run indiagov "open!https://www.india.gov.in/" "fill!#topbar-inputData!passport" "press!Enter" "eval!$URL" "eval!$(T 'h2 a, h3 a, h3, h4')"
run mygov "open!https://www.mygov.in/" "fill!#edit-term!digital india" "press!Enter" "eval!$URL" "eval!$(T 'h3 a, h2 a, .views-row a')"
run incometax "open!https://www.incometax.gov.in/iec/foportal/" "click!text=Downloads" "eval!$URL" "eval!$(T 'h1, h2, h3, h4')"
run gst "open!https://www.gst.gov.in/" "click!text=News and Updates" "eval!$URL" "eval!$(T 'td a, li a.ng-binding, h4, h3')"
run irctc "open!https://www.irctc.co.in/" "eval!$URL" "eval!$TXT"
run ntes "open!https://enquiry.indianrail.gov.in/mntes/" "eval!$URL" "eval!$TXT"
run passport "open!https://www.passportindia.gov.in/psp" "fill!#pinCodeData!110001" "press!Enter" "eval!$URL" "eval!$TXT"
run parivahan "open!https://parivahan.gov.in/" "fill!#edit-keys!driving licence" "press!Enter" "eval!$URL" "eval!$(T 'li.search-result h3 a, .search-results h3 a, h3 a')"
run digilocker "open!https://www.digilocker.gov.in/" "click!text=Statistics" "eval!$URL" "eval!$(T 'h1, h2, h3, h4')"
run epfo "open!https://www.epfindia.gov.in/" "eval!$URL" "eval!$TXT"
run rbi "open!https://www.rbi.org.in/" "fill!#txtSearch1!repo rate" "click!#btnSearch" "eval!$URL" "eval!$(T 'a.gs-title, td a, h3 a, .link2')"
run sebi "open!https://www.sebi.gov.in/" "fill!#search_text!mutual fund" "press!Enter" "eval!$URL" "eval!$(T 'td a, .points a, h3 a')"
run eci "open!https://voters.eci.gov.in/" "eval!$URL" "eval!$TXT"
run pib "open!https://pib.gov.in/index.aspx?lang=1" "fill!#Bar1_q!budget" "click!#Bar1_go" "eval!$URL" "eval!$(T 'a.gs-title, h3 a, ul.num li a')"
run isro "open!https://www.isro.gov.in/" "fill!#searchTextD!Chandrayaan" "press!Enter" "eval!$URL" "eval!$(T 'h3 a, h2, h3, li a')"
run mea "open!https://www.mea.gov.in/" "click!a[href=\"/press-releases\"], text=Press Releases" "eval!$URL" "eval!$(T 'ul li a, h3 a, h4 a')"
run nta "open!https://www.nta.ac.in/" "fill!input[placeholder=Search]!NEET" "press!Enter" "eval!$URL" "eval!$TXT"
run upsc "open!https://upsc.gov.in/" "eval!$URL" "eval!$TXT"
run indiapost "open!https://www.indiapost.gov.in/" "fill!input[placeholder^=Namaste]!pincode" "press!Enter" "eval!$URL" "eval!$TXT"
run datagov "open!https://www.data.gov.in/" "click!text=CATALOG" "eval!$URL" "eval!$(T 'h3 a, h2, h3')"
run umang "open!https://web.umang.gov.in/" "wait!5000" "eval!$URL" "eval!$TXT"
run mohfw "open!https://www.mohfw.gov.in/" "fill!input[type=search]!vaccination" "press!Enter" "eval!$URL" "eval!$TXT"
run imd "open!https://mausam.imd.gov.in/" "click!text=English Website" "eval!$URL" "eval!$(T 'h1, h2, h3')"
run npci "open!https://www.npci.org.in/" "eval!$URL" "eval!$TXT"
run uidai "open!https://uidai.gov.in/en/" "eval!$URL" "eval!$TXT"

# ---------------------------------------------------------------- private
run flipkart "open!https://www.flipkart.com/" "fill!input[name=q]!iphone 15" "press!Enter" "eval!$URL" "eval!$(L '/p/')"
run amazonin "open!https://www.amazon.in/" "eval!$URL" "eval!$TXT"
run myntra "open!https://www.myntra.com/" "fill!input[placeholder^='Search for products']!kurta" "press!Enter" "eval!$URL" "eval!$(T 'h3.product-brand, h4.product-product')"
run zomato "open!https://www.zomato.com/mumbai" "eval!$URL" "eval!$(T 'h4, h1, h2')"
run swiggy "open!https://www.swiggy.com/" "eval!$URL" "eval!$TXT"
run paytm "open!https://paytm.com/" "click!text=Mobile Recharge/Bill" "eval!$URL" "eval!$(T 'h1, h2, h3')"
run makemytrip "open!https://www.makemytrip.com/" "click!text=Hotels" "eval!$URL" "eval!$TXT"
run goibibo "open!https://www.goibibo.com/" "click!a[href=\"/trains/\"], text=Trains" "eval!$URL" "eval!$(T 'h1, h2, h3')"
run redbus "open!https://www.redbus.in/" "fill!#srcinput!Bangalore" "press!Enter" "fill!#destinput!Chennai" "press!Enter" "click!text=Search buses" "eval!$URL" "eval!$TXT"
run bookmyshow "open!https://in.bookmyshow.com/" "click!text=Mumbai" "eval!$URL" "eval!$(L '/movies/')"
run nykaa "open!https://www.nykaa.com/" "eval!$URL" "eval!$TXT"
run ajio "open!https://www.ajio.com/" "eval!$URL" "eval!$TXT"
run bigbasket "open!https://www.bigbasket.com/" "fill!input[placeholder='Search for Products...']!milk" "press!Enter" "eval!$URL" "eval!$(L '/pd/')"
run jiomart "open!https://www.jiomart.com/" "fill!header input[type=text], input[type=text]!atta" "press!Enter" "eval!$URL" "eval!$TXT"
run toi "open!https://timesofindia.indiatimes.com/" "fill!#searchField!cricket" "press!Enter" "eval!$URL" "eval!$(T 'h2, h3, figcaption')"
run ndtv "open!https://www.ndtv.com/" "fill!#z!monsoon" "press!Enter" "eval!$URL" "eval!$(T 'h2 a, h3 a, h2, h3')"
run ht "open!https://www.hindustantimes.com/" "click!text=INDIA NEWS" "eval!$URL" "eval!$(T 'h2 a, h3 a, h2, h3')"
run thehindu "open!https://www.thehindu.com/" "click!a[href=\"https://www.thehindu.com/news/national/\"], text=India" "eval!$URL" "eval!$(T 'h3 a, h2 a, h3')"
run moneycontrol "open!https://www.moneycontrol.com/" "eval!$URL" "eval!$TXT"
run cricbuzz "open!https://www.cricbuzz.com/" "eval!$URL" "eval!$TXT"
run naukri "open!https://www.naukri.com/" "fill!input[placeholder^='Enter skills']!python developer" "press!Enter" "eval!$URL" "eval!$(T 'a.title, h2 a, .title')"
run magicbricks "open!https://www.magicbricks.com/" "fill!#keyword!Whitefield" "press!Enter" "eval!$URL" "eval!$TXT"
run 99acres "open!https://www.99acres.com/" "click!text=Price Trends" "eval!$URL" "eval!$(T 'h1, h2, h3')"
run practo "open!https://www.practo.com/" "fill!input[placeholder^='Search doctors']!dentist" "press!Enter" "eval!$URL" "eval!$(T 'h2, h3')"
run olx "open!https://www.olx.in/" "fill!header input:not([placeholder^='Search city'])!bicycle" "press!Enter" "eval!$URL" "eval!$(T 'span[data-aut-id=itemTitle], h2, h3')"
