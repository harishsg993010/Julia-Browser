#!/bin/sh
# Measure the step-6 suites (frames/realms/navigation) plus the regression
# sample with one runner build in --wptserve mode, one suite per run.
#   scripts/step6-suites.sh target/wpt-dev55.exe 8
EXE="$1"; N="$2"; JOBS="${JOBS:-6}"
# Files that pass alone but exceed the 20 s budget when 6 jobs share the machine.
SLOW="dom/ranges/Range-set.html=60,dom/ranges/Range-compareBoundaryPoints.html=60,html/semantics/popovers/popover-attribute-all-elements.html=60,html/browsers/the-window-object/window-open-windowfeatures-values.html=60,html/browsers/origin/cross-origin-objects/cross-origin-objects.html=60"
run() { "$EXE" run --root ../wpt --wptserve --filter "$1" --jobs "$JOBS" --timeout 20 --timeout-for "$SLOW" --out "target/wpt-$2-$N.json" > "target/spot/$2-$N.log" 2>&1; echo "$2 done: $(${PYTHON:-py} - "target/wpt-$2-$N.json" <<'EOF'
import json,sys
r=json.load(open(sys.argv[1],encoding='utf-8'))
p=sum(1 for t in r for s in t['subtests'] if s['status']=='PASS'); n=sum(len(t['subtests']) for t in r)
print(f"{p}/{n} subtests, files OK {sum(1 for t in r if t['status']=='OK')}/{len(r)}, timeouts {sum(1 for t in r if t['status']=='TIMEOUT')}")
EOF
)"; }
run html/semantics/scripting-1,html/webappapis,html/dom/elements,dom/events sample-w
run html/browsers html_browsers
run webmessaging webmessaging
run webstorage webstorage
run dom dom
echo ALL_DONE
