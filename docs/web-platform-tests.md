# Web Platform Tests

The repo includes a runner for [web-platform-tests](https://github.com/web-platform-tests/wpt),
`src/bin/wpt.rs`. It does the following:

- Serves a WPT checkout: static files, `.any.js` / `.window.js` wrappers, `.sub` substitution and
  `.headers` sidecars.
- Can run against WPT's own `wpt serve` instead.
- Runs every test in its own process with `testharness.js`.
- Writes a JSON report.

## Setup

```bash
git clone --depth 1 https://github.com/web-platform-tests/wpt ../wpt     # or a sparse checkout
cargo build --release --features screenshot,images --bin wpt
```

## Run

```bash
target/release/wpt run --root ../wpt --filter dom,url,html/dom --jobs 8 --out target/wpt-dom.json > target/wpt-dom.log 2>&1
target/release/wpt run --root ../wpt --wptserve --filter fetch --jobs 6 --timeout 20 --out target/wpt-fetch.json
target/release/wpt serve --root ../wpt --port 8000            # just the server
WPT_DEBUG=1 target/release/wpt one --root ../wpt --port 8000 dom/nodes/Node-cloneNode.html
sh scripts/wpt-one.sh target/release/wpt <test path> ...     # single files against a running server
sh scripts/baseline-suites.sh target/release/wpt N <suites>  # several suites, one report each
```

- `--wptserve` runs the suite against `python wpt serve`: the real Python handlers, https / wss /
  h2, and the `web-platform.test` host family. It needs Python 3 and the checkout's `tools/` and
  `docs/` directories.
- `--timeout-for "prefix=secs,…"` gives slow files a longer budget.
- `--exclude` skips paths.
- `WPT_TRACE=<file>` logs every spawn, kill and join.
- Run one suite per invocation, with output redirected to a file.

## Reading results

```bash
py scripts/wpt-show.py target/wpt-dom.json            # per-file results
py scripts/wpt-top.py target/wpt-dom.json 30 dom/     # biggest failure clusters
py scripts/wpt-diff.py OLD.json NEW.json [prefix]     # per-file changes between two runs
py scripts/suite-summary.py target/wpt-css.json 2     # pass rate per suite (depth 2 = css/<module>)
py scripts/wpt-file.py target/wpt-css.json <substr>   # failures of matching files
```

## Scores

Subtests passing, measured with `--wptserve`:

| Suite | Pass rate |
| --- | --- |
| encoding | 100% (1,139,365 / 1,139,840) |
| wasm | 99.7% (189,466 / 190,017) |
| mimesniff | 99.4% (1,976 / 1,988) |
| selection | 98.2% (33,777 / 34,386) |
| url | 97.4% (8,489 / 8,719) |
| shadow-dom | 97.3% (14,869 / 15,275) |
| user-timing | 97.3% (612 / 629) |
| dom | 96.1% (62,478 / 65,000) |
| permissions | 95.1% (98 / 103) |
| close-watcher | 94.7% (90 / 95) |
| html/semantics/popovers | 94.1% (3,672 / 3,902) |
| sanitizer-api | 94.0% (1,984 / 2,110) |
| html | 93.9% (140,330 / 149,412) |
| streams | 93.4% (1,412 / 1,511) |
| webstorage | 93.1% (1,197 / 1,286) |
| css/css-text-decor | 91.9% (1,264 / 1,376) |
| import-maps | 91.6% (362 / 395) |
| uievents | 90.8% (393 / 433) |
| css/css-typed-om | 90.6% (11,743 / 12,958) |
| custom-elements | 90.3% (3,741 / 4,144) |
| webauthn | 89.7% (383 / 427) |
| IndexedDB | 89.5% (1,452 / 1,623) |
| web-animations | 86.9% (2,084 / 2,398) |
| css/css-masking | 86.9% (4,334 / 4,989) |
| css/css-position | 86.4% (1,293 / 1,496) |
| clipboard-apis | 86.2% (213 / 247) |
| the-img-element | 85.6% (1,577 / 1,842) |
| css/css-shapes | 84.6% (6,355 / 7,516) |
| filter-effects | 83.8% (2,460 / 2,936) |
| fetch/metadata | 83.1% (1,616 / 1,944) |
| css/css-transitions | 83.1% (2,852 / 3,434) |
| resize-observer | 82.7% (105 / 127) |
| css/css-color | 81.3% (7,406 / 9,106) |
| webmessaging | 81.2% (182 / 224) |
| html/semantics/forms | 80.6% (4,098 / 5,083) |
| scroll-animations | 79.4% (1,112 / 1,401) |
| css/css-backgrounds | 79.1% (4,919 / 6,219) |
| touch-events | 79.0% (154 / 195) |
| notifications | 78.8% (145 / 184) |
| scroll-to-text-fragment | 78.8% (145 / 184) |
| css/css-fonts | 78.7% (6,821 / 8,670) |
| svg | 78.4% (3,244 / 4,140) |
| credential-management | 78.3% (126 / 161) |
| css/css-transforms | 78.1% (4,304 / 5,514) |
| css/css-animations | 77.0% (1,101 / 1,430) |
| html/browsers | 75.9% (2,211 / 2,913) |
| service-workers | 75.6% (1,604 / 2,122) |

CSS numbers count testharness files. The runner does not compare reftest screenshots.
