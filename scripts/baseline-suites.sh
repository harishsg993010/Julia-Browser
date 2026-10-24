#!/bin/sh
# Measure every non-core suite with one runner build (--wptserve), one suite per run, and
# print one summary line per suite.  Output: target/wpt-<name>-<N>.json, target/spot/<name>-<N>.log
#   sh scripts/baseline-suites.sh target/wpt-devN.exe <N> [suite ...]
EXE="$1"; N="$2"; shift 2; JOBS="${JOBS:-6}"
SLOW="WebCryptoAPI/derive_bits_keys/hkdf.https.any.html=120,WebCryptoAPI/derive_bits_keys/pbkdf2.https.any.html=120,html/semantics/popovers/popover-attribute-all-elements.html=60,shadow-dom/declarative/gethtml.html=120,shadow-dom/reference-target/tentative/property-reflection-idl-setters.html=120"
SUITES="$*"
[ -z "$SUITES" ] && SUITES="WebCryptoAPI webidl resize-observer css/cssom intersection-observer css/cssom-view domparsing svg close-watcher fetch/metadata fetch/api custom-elements uievents html/interaction html/semantics/popovers html/semantics/embedded-content/the-img-element xhr cookies websockets FileAPI hr-time performance-timeline console IndexedDB selection mimesniff user-timing compression storage-access-api infrastructure webstorage webmessaging streams url"
for s in $SUITES; do
  name=$(echo "$s" | tr '/' '_')
  "$EXE" run --root ../wpt --wptserve --filter "$s" --jobs "$JOBS" --timeout 20 --timeout-for "$SLOW" --out "target/wpt-$name-$N.json" > "target/spot/$name-$N.log" 2>&1
  ${PYTHON:-py} - "target/wpt-$name-$N.json" "$s" <<'EOF'
import json, sys
try:
    r = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e:
    print(f"{sys.argv[2]:45} FAILED {e}"); sys.exit()
p = sum(1 for t in r for s in t["subtests"] if s["status"] == "PASS"); n = sum(len(t["subtests"]) for t in r)
to = sum(1 for t in r if t["status"] == "TIMEOUT")
print(f"{sys.argv[2]:45} {p:>7}/{n:<7} {100*p/max(n,1):5.1f}%  files={len(r)} timeouts={to}", flush=True)
EOF
done
echo ALL_DONE
