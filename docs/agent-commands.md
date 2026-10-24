# Agent commands

Each command talks to a background browser session. The session starts on first use and keeps the
page, cookies and tabs between invocations:

- `--session <name>` or `JB_SESSION` picks the session (default `default`).
- Idle sessions exit after `JB_SESSION_IDLE_SECS` seconds (default 1800).
- `--json` prints machine-readable results.

```bash
julia-browser open https://example.com      # aliases: goto, navigate; no URL opens about:blank
julia-browser read [url]                    # the page as markdown
julia-browser click "#submit" [--new-tab]   # also: dblclick, focus, hover, check, uncheck
julia-browser fill "#email" me@example.com  # clear, then type; `type` appends
julia-browser select "#color" Green
julia-browser press Enter                   # alias: key; keydown / keyup Shift hold a key
julia-browser keyboard type "hello"         # real key events to the focused element
julia-browser keyboard inserttext "hello"   # insert without key events
julia-browser scroll down 500 [--selector "#list"]   # up / down / left / right
julia-browser scrollintoview "#footer"      # alias: scrollinto
julia-browser click_at 640 360              # viewport coordinates (CSS pixels)
julia-browser wait "#results" [--timeout 10000]      # until an element exists; `wait 2000` lets the page run 2 s
julia-browser drag "#card" "#column"
julia-browser upload "input[type=file]" a.pdf b.png
julia-browser screenshot [path] [--full] [--annotate] [--if-changed] [--threshold 0.01]
                         [--screenshot-dir dir] [--screenshot-format jpeg] [--screenshot-quality 80]
julia-browser pdf page.pdf
julia-browser eval "document.title"         # -b for base64 code, --stdin to read the code from stdin
julia-browser connect <port>                # attach this session name to a running session
julia-browser close [--all]                 # aliases: quit, exit
```

## Selectors

- CSS: `#id`, `input[name=q]`
- Visible text: `text=Sign in`
- Shadow-piercing descendant selectors
- `@N`: element numbers from `screenshot --annotate`, for example `julia-browser click @3`

Hidden or unfocusable targets return an error instead of a silent no-op.

## Signing in

The session uses the [vault](vault.md) for credentials. The secret is typed inside the browser and
never printed:

```bash
julia-browser login --reason "check order status"
julia-browser otp --reason "2FA prompt after login"
julia-browser new-password me@example.com --reason "sign up"
```

## Notes

- Scrolling, screenshots, annotation and PDF need a build with the `screenshot,images` features.
- Session logs, and `JB_TRACE_JS` / `JB_PROFILE` output, go to `<local data>/julia-browser/sessions/<name>.log`.
- When a script reads a command's output, redirect it to a file. Piping it to another program can
  hang, because the session server inherits the pipe.
