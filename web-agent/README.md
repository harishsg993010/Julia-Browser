# julia-web-agent

A general web agent: Claude decides, [julia-browser](../README.md) browses. Give it a task in plain
language. It opens pages, searches, clicks, types, fills forms, reads results and returns an answer
taken from the pages it saw.

It is the same observe → act loop as the agent in `benchmarks/` (Online-Mind2Web, WebVoyager, BU
Bench, Odysseys), without the benchmark-specific scoring.

## Install

```bash
pip install julia-browser anthropic
pip install -e web-agent            # from the repo root
export ANTHROPIC_API_KEY=...
```

## Command line

```bash
julia-web-agent "Find the cheapest 4-star hotel in Lisbon for next weekend"
julia-web-agent "Who designed Rust and when did it first appear?" --start-url https://en.wikipedia.org
julia-web-agent "Apply to the job with my CV" --start-url https://jobs.example.com/123 --file cv.pdf
julia-web-agent "Check my latest order status" --start-url https://shop.example.com --allow-login
python -m julia_web_agent "..." --json --record runs/    # JSON result; screenshots + history.json per run
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--start-url URL` | web search for the task | First page |
| `--model` | `claude-haiku-5-5` | Claude model |
| `--effort` | `medium` | Model effort (`low` … `max`) |
| `--max-steps` | 40 | Browser actions per task |
| `--timeout` | 1500 | Seconds per task |
| `--no-vision` | off | Do not send screenshots (text and element lists only) |
| `--file PATH` | none | A file the agent may upload (repeatable) |
| `--allow-login` | off | Give the agent the vault `login` / `otp` tools |
| `--record DIR` | none | Save every step's screenshot and `history.json` |
| `--js-budget-ms` | 8000 | Script time per page load or action |
| `--profile-dir DIR` | shared profile | localStorage / IndexedDB for this run |
| `--json`, `-q` | off | Print the result as JSON, or print no step lines |

## Python

```python
from julia_web_agent import WebAgent

def show(step):
    print(step.n, step.action, step.url)

with WebAgent(max_steps=30, on_step=show, record_dir="runs") as agent:
    result = agent.run("Find today's top story on Hacker News and its points",
                       start_url="https://news.ycombinator.com")

print(result.status)       # finished | blocked | max-steps | timeout | refused
print(result.answer)
print(result.usage)        # tokens and cost in USD
```

`WebAgent(model, effort=, max_steps=, task_timeout_s=, vision=, files=, allow_login=, record_dir=,
on_step=, page_timeout_s=, llm=, **browser_options)`. The `browser_options` are passed to
`julia_browser.Browser`: `js_budget_ms`, `settle_ms`, `profile_dir`, `user_agent`, `geolocation`, and so on.
One agent can run several tasks in a row; the browser stays open between them.

## How it works

Each turn, the model gets the page state:

- the URL, title and scroll position
- the numbered interactive elements in and just below the viewport, including open shadow roots,
  scroll panes and same-origin frames, each with its label, value, options or checked state
- the page text around the scroll position, as markdown
- a screenshot, unless `vision=False`

It answers with exactly one tool call:

| Tool | Action |
| --- | --- |
| `click`, `hover` | An element by number. A click that opens a new tab switches to it |
| `type` | Replace a field's text, optionally pressing Enter. Date inputs get their ISO form; the result reports what the field shows afterwards |
| `select` | A `<select>` option by text or value, or a custom dropdown (opened, then the option clicked) |
| `click_at`, `drag_at`, `keyboard_type` | Coordinates on the screenshot, for maps, canvases, sliders and editors |
| `press`, `scroll`, `goto`, `back`, `wait` | Keys, scrolling, navigation, waiting for slow pages |
| `search` | A web search (DuckDuckGo) with titles, URLs and snippets |
| `find` | Ctrl+F: scroll to text on the page and list the matches |
| `read_page` | Any part of the page as markdown |
| `upload` | Attach one of the `files` (it finds the hidden `<input type=file>` behind styled buttons) |
| `login`, `otp` | Only with `allow_login`. The vault fills credentials inside the browser; the model never sees them |
| `finish` | The answer |

After each action the agent reports what the page showed briefly: toasts, `alert()` dialogs, text
copied to the clipboard, print-to-PDF. If an element was re-rendered by React or Vue, the agent
finds it again by tag and label. If an action hangs the browser, the browser is replaced and the
last page reloaded. When the steps run out, the model is asked once for its best answer.

## Credentials

With `--allow-login` the agent signs in through the julia-browser [vault](../docs/vault.md). Only the
sites you allowed can be used (`julia-browser vault allow example.com`), and every use is written
to the vault's audit log. Without it, the agent stops before sign-ins, payments and purchases and
says where it stopped.

## Files

| File | Contents |
| --- | --- |
| `julia_web_agent/agent.py` | `WebAgent`: system prompt, observe → act loop, recording |
| `julia_web_agent/tools.py` | Tool definitions and their execution on the page |
| `julia_web_agent/page.py` | In-page JavaScript: element scan, find, re-find, transient messages, uploads, dates |
| `julia_web_agent/browser.py` | The browser under a watchdog, and web search |
| `julia_web_agent/llm.py` | Claude client with token and cost accounting |
