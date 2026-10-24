# Puppeteer and Playwright (Chrome DevTools Protocol)

```bash
julia-browser cdp --port 9222
julia-browser cdp --port 0 --host 0.0.0.0 --user-agent "..." --no-javascript   # free port, all interfaces
```

```js
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222" });   // puppeteer-core
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");              // playwright-core
```

From Python, `julia_browser.serve_cdp(port=0)` runs the same server inside your process (see
[Python](python.md)).

## What is served

HTTP endpoints: `/json/version`, `/json/list`, `/json/new`, `/json/close`. WebSocket: the browser and
page endpoints, with flat sessions.

| Domain | Commands and events |
| --- | --- |
| `Target` | discovery, auto-attach, create / close / attach, browser contexts |
| `Page` | navigate, reload, history, lifecycle events, frame tree, isolated worlds, init scripts, screenshots, layout metrics |
| `Runtime` | evaluate, callFunctionOn, awaitPromise, remote objects, getProperties, bindings, console events |
| `DOM` | document, query, describe / resolve nodes, box models, content quads, scroll into view, focus, file inputs |
| `Input` | mouse, keyboard, insertText: trusted events through the same layer as the agent commands |
| `Network` | document request events, cookies, user agent, extra headers |

Puppeteer and Playwright test flows pass. They cover navigation, clicks, typing,
`waitForSelector`, locators, screenshots and cookies.

## How it runs

- Each page target runs on its own thread with its own JavaScript engine.
- Commands that run page code (`Runtime.evaluate`, `callFunctionOn`, `Input.*`) let the page's timers
  and network settle for `JB_SETTLE_MS` milliseconds (default 50). They follow any navigation they
  cause.
- Between commands, the page's event loop keeps running in step with real time: timers, network
  callbacks, timer-driven navigations. Pending `awaitPromise` calls are answered as they settle.
- A `Runtime.evaluate` round trip takes about 1–2 ms.
- `JB_CDP_LOG=1` prints the protocol traffic.
