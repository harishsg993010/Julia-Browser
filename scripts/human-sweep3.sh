#!/bin/sh
# Human-style sweep of the remaining top-100 sites (no logins).
#   scripts/human-sweep3.sh [exe] [site-regex]
# Each step's output goes to target/spot/sweep3/<site>.log with its wall time.
# Session commands write to files (the session daemon inherits pipes, so never pipe them).
EXE="${1:-./target/jb-sweep.exe}"
ONLY="${2:-.}"
OUT=target/spot/sweep3
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
  sess="hs3-$site"
  : > "$OUT/$site.log"
  for s in "$@"; do
    IFS='!'; set -f; set -- $s; set +f; unset IFS
    step "$site" "$sess" "$@"
  done
  "$EXE" close --session "$sess" > /dev/null 2>&1 < /dev/null
}

URL='location.href + " | " + document.title'
# first N texts of a selector list
T() { echo "[...document.querySelectorAll('$1')].map(e=>e.textContent.trim().replace(/\\s+/g,' ').slice(0,80)).filter(Boolean).slice(0,5).join(' || ')"; }
TXT='document.body ? document.body.innerText.length + " chars: " + document.body.innerText.replace(/\s+/g," ").slice(0,300) : "no body"'
SB='input[type=search], input[name=q], input[name=query], input[name=search], input[role=combobox], [role=searchbox]'

run facebook "open!https://www.facebook.com/NASA/" "eval!$URL" "eval!$TXT"
run instagram "open!https://www.instagram.com/nasa/" "eval!$URL" "eval!$TXT"
run x "open!https://x.com/NASA" "eval!$URL" "eval!$TXT"
run yahoo \
  "open!https://www.yahoo.com/" "eval!$(T 'h3, h2')" \
  "fill!#uh-sbq!mars rover" "press!Enter" "eval!$URL" \
  "eval!$(T '#web h3, .compTitle h3, h3')"
run linkedin \
  "open!https://www.linkedin.com/jobs/search?keywords=rust%20developer" "eval!$URL" \
  "eval!$(T '.base-search-card__title, h3')"
run tiktok "open!https://www.tiktok.com/explore" "eval!$URL" "eval!$TXT"
run netflix \
  "open!https://www.netflix.com/" "eval!$URL" \
  "click!text=What is Netflix?" "eval!$(T '[data-uia*=faq] , .faq-list-item, h3')" "eval!$TXT"
run microsoft \
  "open!https://www.microsoft.com/en-us/" "eval!$URL" \
  "click!text=Microsoft 365" "eval!$URL" "eval!$(T 'h1, h2')"
run apple \
  "open!https://www.apple.com/" "click!a[href='/iphone/']" "eval!$URL" "eval!$(T 'h1, h2')"
run openai \
  "open!https://openai.com/" "eval!$URL" "click!text=News" "eval!$URL" "eval!$(T 'h2, h3')"
run chatgpt "open!https://chatgpt.com/" "eval!$URL" "eval!$TXT"
run stackoverflow \
  "open!https://stackoverflow.com/questions" "eval!$URL" \
  "eval!$(T '.s-post-summary--content-title a')"
run walmart \
  "open!https://www.walmart.com/" "fill!input[name=q]!laptop" "press!Enter" "eval!$URL" \
  "eval!$(T '[data-automation-id=product-title], span[data-automation-id=product-title]')"
run target \
  "open!https://www.target.com/" "fill!#search, input[name=searchTerm]!coffee maker" "press!Enter" "eval!$URL" \
  "eval!$(T '[data-test=product-title], a[data-test=product-title]')"
run bestbuy \
  "open!https://www.bestbuy.com/" "wait!#autocomplete-search-bar" "fill!#autocomplete-search-bar!headphones" "press!Enter" "eval!$URL" \
  "eval!$(T '.sku-title a, h4.sku-title, .sku-block-content-title, h2.product-title')"
run aliexpress \
  "open!https://www.aliexpress.com/" "fill!#search-words, input[name=SearchText], $SB!phone case" "press!Enter" "eval!$URL" \
  "eval!$(T 'h3, [class*=title]')"
run temu \
  "open!https://www.temu.com/" "eval!$URL" "fill!$SB!desk lamp" "press!Enter" "eval!$URL" "eval!$TXT"
run shein \
  "open!https://us.shein.com/" "eval!$URL" "click!text=Women" "eval!$URL" "eval!$TXT"
run ikea \
  "open!https://www.ikea.com/us/en/" "fill!input[name=q], $SB!bookshelf" "press!Enter" "eval!$URL" \
  "eval!$(T '.plp-price-module__product-name, .plp-price-module__name-decorator, [class*=product-name]')"
run homedepot \
  "open!https://www.homedepot.com/" "fill!#typeahead-search-field-input, input[name=keyword], $SB!drill" "press!Enter" "eval!$URL" \
  "eval!$(T '[data-testid=product-header] h3, [data-testid=attribute-product-label], h3')"
run costco \
  "open!https://www.costco.com/" "fill!#search-field, input[name=keyword], $SB!tv" "press!Enter" "eval!$URL" \
  "eval!$(T '.description a, [data-testid*=Text_ProductTile], h3')"
run zillow \
  "open!https://www.zillow.com/" "fill!$SB!Seattle, WA" "press!Enter" "eval!$URL" \
  "eval!$(T 'address, [data-test=property-card-addr]')"
run airbnb \
  "open!https://www.airbnb.com/" "fill!#bigsearch-query-location-input, input[name=query]!Lake Tahoe" "press!Enter" "eval!$URL" \
  "eval!$(T '[data-testid=listing-card-title]')"
run expedia \
  "open!https://www.expedia.com/Flights" "eval!$URL" "eval!$(T 'button, label')"
run tripadvisor \
  "open!https://www.tripadvisor.com/" "fill!$SB!Lisbon" "press!Enter" "eval!$URL" "eval!$(T 'h3, .result-title')"
run kayak \
  "open!https://www.kayak.com/flights" "eval!$URL" "eval!$(T 'h1, h2, label')"
run gmaps \
  "open!https://www.google.com/maps" "fill!#searchboxinput, input[name=q]!Golden Gate Bridge" "press!Enter" "eval!$URL" "eval!$(T 'h1')"
run weathercom \
  "open!https://weather.com/" "eval!$(T 'h1, [data-testid=TemperatureValue]')" "click![data-testid=location-picker-trigger]" "fill!input[placeholder='Search for a location']!Chicago" "click![data-testid=location-search-result]" "eval!$URL" "eval!$(T 'h1, [data-testid=TemperatureValue]')"
run accuweather \
  "open!https://www.accuweather.com/" "fill!input.search-input, input[name=query], $SB!Boston" "press!Enter" "eval!$URL" "eval!$(T 'h1, .location-name, .search-results a')"
run cnn \
  "open!https://www.cnn.com/" "eval!$(T '.container__headline-text')" \
  "click!a.container__link--type-article" "eval!$URL" "eval!$(T 'h1')"
run nytimes \
  "open!https://www.nytimes.com/" "eval!$URL" "eval!$(T 'section p.indicate-hover, h3')"
run guardian \
  "open!https://www.theguardian.com/international" "eval!$(T '.dcr-lv2v9o, [data-link-name=article] , h3')" \
  "click!a[data-link-name*=article], .dcr-2yd10d a" "eval!$URL" "eval!$(T 'h1')"
run foxnews \
  "open!https://www.foxnews.com/" "eval!$(T 'h3.title a, h2.title a')" \
  "click!h3.title a, h2.title a" "eval!$URL" "eval!$(T 'h1')"
run wapo \
  "open!https://www.washingtonpost.com/" "eval!$(T 'h2, h3')" \
  "click!h2 a, h3 a" "eval!$URL" "eval!$(T 'h1')"
run reuters \
  "open!https://www.reuters.com/" "eval!$URL" "eval!$(T '[data-testid=Heading], h3')"
run bloomberg \
  "open!https://www.bloomberg.com/markets" "eval!$URL" "eval!$(T 'h1, h2, h3')"
run forbes \
  "open!https://www.forbes.com/" "eval!$(T 'h2, h3')" \
  "click!h3 a, h2 a" "eval!$URL" "eval!$(T 'h1')"
run nfl \
  "open!https://www.nfl.com/scores/" "eval!$URL" "eval!$(T '.nfl-c-matchup-strip__team-fullname, .nfl-c-matchup-strip__team-abbreviation, h2')"
run rottentomatoes \
  "open!https://www.rottentomatoes.com/" "fill!input[data-qa=search-input], input[type=search], $SB!Inception" "press!Enter" "eval!$URL" \
  "eval!$(T 'search-page-media-row a[data-qa=info-name], a[slot=title], h2')"
run spotify \
  "open!https://open.spotify.com/search/jazz" "eval!$URL" "eval!$TXT"
run soundcloud \
  "open!https://soundcloud.com/search?q=lofi" "eval!$URL" "eval!$(T '.soundTitle__title, h2 a')"
run twitch \
  "open!https://www.twitch.tv/directory" "eval!$URL" "eval!$(T 'h2, [data-a-target=tw-box-art-card-link] , .tw-title')"
run pinterest \
  "open!https://www.pinterest.com/search/pins/?q=garden" "eval!$URL" "eval!$TXT"
run tumblr \
  "open!https://www.tumblr.com/explore/trending" "eval!$URL" "eval!$TXT"
run quora \
  "open!https://www.quora.com/" "eval!$URL" "eval!$TXT"
run medium \
  "open!https://medium.com/tag/programming" "eval!$(T 'h2')" \
  "click!article h2" "eval!$URL" "eval!$(T 'h1')"
run substack \
  "open!https://substack.com/discover" "eval!$URL" "eval!$TXT"
run devto \
  "open!https://dev.to/" "fill!input[name=q], #search-input, $SB!rust" "press!Enter" "eval!$URL" \
  "eval!$(T '.crayons-story__title a, h3 a')" \
  "click!.crayons-story__title a" "eval!$URL"
run producthunt \
  "open!https://www.producthunt.com/" "eval!$(T '[data-test^=post-name], a[href^=\"/products/\"]')" \
  "click![data-test^=post-name] a, a[href^=\"/products/\"]" "eval!$URL" "eval!$(T 'h1')"
run pypi \
  "open!https://pypi.org/" "fill!#search!requests" "press!Enter" "eval!$URL" \
  "eval!$(T '.package-snippet__name')" "click!.package-snippet" "eval!$URL"
run crates \
  "open!https://crates.io/" "fill!input[name=q], $SB!serde" "press!Enter" "eval!$URL" \
  "eval!$(T '[class*=name] a, h3 a, a[href^=\"/crates/\"]')"
run w3schools \
  "open!https://www.w3schools.com/" "click!text=Learn HTML" "eval!$URL" \
  "click!text=Try it Yourself" "eval!$URL"
run gitlab \
  "open!https://gitlab.com/explore/projects" "eval!$URL" "eval!$(T '.project-full-name, [data-testid=project-name], h2 a')"
run huggingface \
  "open!https://huggingface.co/models" "fill!input[name=search], $SB!llama" "press!Enter" "eval!$URL" \
  "eval!$(T 'article h4, header h4')"
run arxiv \
  "open!https://arxiv.org/" "fill!input[name=query]!attention is all you need" "press!Enter" "eval!$URL" \
  "eval!$(T 'p.title')"
run khanacademy \
  "open!https://www.khanacademy.org/math" "eval!$URL" "eval!$(T 'h2, h3')"
run coursera \
  "open!https://www.coursera.org/" "fill!input[name=query], $SB!machine learning" "press!Enter" "eval!$URL" \
  "eval!$(T 'h3.cds-CommonCard-title, h3')"
run duolingo \
  "open!https://www.duolingo.com/" "eval!$URL" "click!text=Get started" "eval!$URL" "eval!$TXT"
run wikihow \
  "open!https://www.wikihow.com/Main-Page" "fill!input[name=search], $SB!tie a tie" "press!Enter" "eval!$URL" \
  "eval!$(T '.result_title, .result a')"
run paypal \
  "open!https://www.paypal.com/us/home" "eval!$URL" "click!text=Business" "eval!$URL" "eval!$(T 'h1, h2')"
run chase \
  "open!https://www.chase.com/" "eval!$URL" "click!text=Credit cards" "eval!$URL" "eval!$(T 'h1, h2')"
run irs \
  "open!https://www.irs.gov/" "fill!input[name=search], $SB!refund status" "press!Enter" "eval!$URL" \
  "eval!$(T '.views-field-title a, h3 a, .search-result a')"
run usps \
  "open!https://tools.usps.com/go/TrackConfirmAction_input" "fill!#tracking-input, textarea, input[name=tLabels]!9400100000000000000000" "click!#trackBtn, text=Track" "eval!$URL" "eval!$TXT"
run fedex \
  "open!https://www.fedex.com/en-us/tracking.html" "fill!input[name=trackingnumber], #trackingnumber, input[type=text]!123456789012" "press!Enter" "eval!$URL" "eval!$TXT"
run ups \
  "open!https://www.ups.com/track?loc=en_US" "wait!#stApp_trackingNumber" "fill!#stApp_trackingNumber!1Z999AA10123456784" "click!#stApp_btnTrack" "wait!3000" "eval!$URL" "eval!$TXT"
run indeed \
  "open!https://www.indeed.com/" "fill!#text-input-what, input[name=q]!software engineer" "press!Enter" "eval!$URL" \
  "eval!$(T 'h2.jobTitle, .jobTitle')"
run glassdoor \
  "open!https://www.glassdoor.com/Reviews/index.htm" "eval!$URL" "eval!$TXT"
run zoom \
  "open!https://www.zoom.com/" "eval!$URL" "click!text=Pricing" "eval!$URL" "eval!$(T 'h1, h2')"
run dropbox \
  "open!https://www.dropbox.com/" "eval!$URL" "click!text=Plans" "eval!$URL" "eval!$(T 'h1, h2')"
run notion \
  "open!https://www.notion.com/" "eval!$URL" "open!https://www.notion.com/templates" "eval!$URL" "eval!$(T 'h1, h2, h3')"
run canva \
  "open!https://www.canva.com/templates/" "eval!$URL" "eval!$TXT"
run figma \
  "open!https://www.figma.com/community" "eval!$URL" "eval!$TXT"
run wordpress \
  "open!https://wordpress.com/themes" "eval!$URL" "eval!$(T 'h2, .theme-card__info-title, [class*=theme-card] h2')"
run yelp \
  "open!https://www.yelp.com/" "fill!#search_description, input[name=find_desc]!pizza" "press!Enter" "eval!$URL" "eval!$(T 'h3 a, [class*=businessName] a')"
run vimeo \
  "open!https://vimeo.com/search?q=nature" "eval!$URL" "eval!$TXT"

# Same scenarios typed with real key events (click + keyboard type) instead of fill,
# to separate the fill/controlled-input problem from other failures.
run walmart_kb "open!https://www.walmart.com/" "click!input[name=q]" "keyboard!type!laptop" "press!Enter" "eval!$URL" \
  "eval!$(T '[data-automation-id=product-title]')"
run costco_kb "open!https://www.costco.com/" "click!input[type=search], input[role=combobox]" "keyboard!type!tv" "press!Enter" "eval!$URL" \
  "eval!$(T '[data-testid*=Text_ProductTile], .description a, h3')"
run zillow_kb "open!https://www.zillow.com/" "click!$SB" "keyboard!type!Seattle, WA" "press!Enter" "eval!$URL" \
  "eval!$(T 'address, [data-test=property-card-addr]')"
run ikea_kb "open!https://www.ikea.com/us/en/" "click!#ikea-search-input" "keyboard!type!bookshelf" "press!Enter" "eval!$URL" \
  "eval!$(T '.plp-price-module__product-name, [class*=product-name]')"
run huggingface_kb "open!https://huggingface.co/models" "click!$SB" "keyboard!type!llama" "press!Enter" "eval!$URL" \
  "eval!$(T 'article h4, header h4')"
run indeed_kb "open!https://www.indeed.com/" "click!#text-input-what" "keyboard!type!software engineer" "press!Enter" "eval!$URL" \
  "eval!$(T 'h2.jobTitle, .jobTitle')"
run fedex_kb "open!https://www.fedex.com/en-us/tracking.html" "click!#trackingModuleTrackingNum" "keyboard!type!123456789012" "press!Enter" "eval!$URL" "eval!$TXT"
run coursera_kb "open!https://www.coursera.org/" "click!#search-autocomplete-input" "keyboard!type!machine learning" "press!Enter" "eval!$URL" \
  "eval!$(T 'h3.cds-CommonCard-title, h3')"
run devto_kb "open!https://dev.to/" "click!#search-input" "keyboard!type!rust" "press!Enter" "eval!$URL" \
  "eval!$(T '.crayons-story__title a, h3 a')" "click!.crayons-story__title a, h3 a" "eval!$URL"
run arxiv_kb "open!https://arxiv.org/" "eval![...document.querySelectorAll('input[name=query]')].map(e=>e.id+':'+e.checkVisibility()).join(' ')" \
  "open!https://arxiv.org/search/?query=attention+is+all+you+need&searchtype=all" "eval!$URL" "eval!$(T 'p.title')"
run ups_kb "open!https://www.ups.com/track?loc=en_US" "wait!#stApp_trackingNumber" "click!#stApp_trackingNumber" "keyboard!type!1Z999AA10123456784" "press!Enter" "eval!$URL" "eval!$TXT"
