# Command line

```bash
julia-browser browse https://example.com                      # page as markdown, JavaScript on
julia-browser browse https://example.com --no-javascript
julia-browser browse https://api.github.com --format json     # JSON responses as a browsable view
julia-browser render https://example.com --format text -o page.txt
julia-browser render https://example.com --format layout --cols 120         # character-cell screenshot
julia-browser render https://example.com --format png -o page.png --clip main
julia-browser eval https://example.com "document.title"
julia-browser interactive
```

Formats: `markdown` (default), `text`, `html`, `json`, `layout`, `png`. See
[Rendering and screenshots](rendering.md).

## Page options

These flags work with `browse` and `render`:

| Flag | Effect |
| --- | --- |
| `--no-javascript` | Do not run page scripts |
| `--no-external-js` | Run inline scripts only; skip `<script src>` |
| `--js-console` | Print the page's console output as it happens |
| `--js-budget-ms N` | Script time per page load or action (default 8000). Time spent waiting on the network does not count |
| `--ad-budget-ms N` | A separate budget for ad and analytics scripts (default 1500; 0 skips them) |
| `--no-websockets` | Block WebSocket and EventSource |
| `--no-service-workers` | Keep `navigator.serviceWorker` inert |
| `--allow-clipboard` | Let `navigator.clipboard` read and write the OS clipboard |
| `--geolocation LAT,LON` | Position reported to `navigator.geolocation` |
| `--notifications granted\|denied\|default` | `Notification.permission` |
| `--full` | Add technical sections: web components, ARIA, form validation, media queries, MathML/SVG |

## Interactive mode

`julia-browser interactive` opens a prompt with these commands:

- Navigation: `browse <url>`, `back`, `forward`, `reload`, `history`, `bookmark add <name>`, `bookmarks`
- Links and controls: `links`, `follow <n>`, `elements`, `click <n>`, `button <n>`, `link <n>`, `type [<n>] <text>`, `submit`, `anchors`
- Page tools: `search <term>`, `js <code>`, `console`, `screen [cols]`, `screenshot <file> [selector]`, `info`, `performance`, `full`
- Proxy: `proxy start|stop|status|traffic|rules|rule <json>`
- `help`, `quit`

Interaction commands send trusted pointer and keyboard events to the page's handlers. Targets can
be CSS selectors, `text=<label>`, or shadow-piercing descendant selectors:

- `click`, `dblclick`, `hover` and `focus` take a selector.
- `fill <selector> <text>` clears the field and types; `press <keys>` sends keys such as `Enter` or `Control+a`.
- `select <selector> <value>`, `check <selector>`, `uncheck <selector>` and `wait <selector>`.
- `do <action> <target> [value]` is the generic form of all of the above.

For scripted use across several commands, use the [agent commands](agent-commands.md). They keep one
live page between invocations.
