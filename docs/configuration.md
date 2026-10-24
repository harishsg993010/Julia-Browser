# Configuration

## Budgets

Each page gets a JavaScript time budget, `--js-budget-ms` (default 8000 ms):

- It covers script execution. Time spent waiting on the network does not count.
- Once the budget is spent, no new scripts or tasks start.
- A task that is still running gets a few more seconds to finish before it is stopped. Stopping a
  framework half-way through a render would leave the page unresponsive.
- Ad and analytics scripts run on their own budget, `--ad-budget-ms` (default 1500 ms).
- Stopped scripts are counted, not reported as errors.

Known tracker and ad requests are not sent. `JB_ALLOW_ADS=1` lets them through.

## Environment variables

| Variable | Effect |
| --- | --- |
| `JB_SESSION` | Agent session name (default `default`) |
| `JB_SESSION_IDLE_SECS` | Idle seconds before a session exits (default 1800) |
| `JB_SETTLE_MS` | Page time after each action: agent sessions default to 2500, CDP to 50 |
| `JB_PROFILE_DIR` | Directory for localStorage / IndexedDB instead of the shared profile |
| `JB_VAULT_DIR`, `JB_VAULT_PASSPHRASE` | Vault location; passphrase protection ([vault](vault.md)) |
| `JB_FIDO=hardware` | Send every site's WebAuthn to hardware keys / Windows Hello |
| `JB_ALLOW_ADS=1` | Do not block tracker and ad requests |
| `JB_RESOLVE_HOSTS=a,b` | Resolve these host names to 127.0.0.1 (local test servers) |
| `JB_INSECURE_TLS=1` | Accept self-signed certificates (local test servers) |

## Diagnostics

| Variable | Output |
| --- | --- |
| `JB_TRACE_JS=1` | Script runs, fetches, prefetches, layouts, slow tasks (≥ 200 ms host ops) and budget stops |
| `JB_PROFILE=1` | Sampling profiler: hottest script locations, functions and stacks at the end of each load or action |
| `JB_CDP_LOG=1` | Chrome DevTools Protocol traffic |
| `JB_DOM_ORDER=1` | Render Markdown in DOM order instead of visual order |
| `JB_VISUAL_DEBUG=1` | Trace the visual-order decisions |
| `JB_DUMP_RENDER=<file>` | Write the HTML the Markdown renderer saw |
| `JB_LAYOUT_DUMP=1` | Write the HTML handed to layout to `target/spot/layout-input.html` |

For agent sessions, the trace and profiler output goes to `<local data>/julia-browser/sessions/<name>.log`.
`py scripts/env-line.py <N>` maps a `browser_env.js:N` location in a stack trace back to its
`src/js/env/` file.
