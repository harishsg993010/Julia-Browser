"""Command line: python -m julia_web_agent "task" [--start-url URL] [options]"""

import argparse
import json
import sys

from .agent import WebAgent
from .llm import DEFAULT_MODEL


def main(argv=None):
    p = argparse.ArgumentParser(prog="julia-web-agent", description="Run a web task with julia-browser and Claude.")
    p.add_argument("task", help="what to do, in plain language")
    p.add_argument("--start-url", help="page to start on (default: a web search for the task)")
    p.add_argument("--model", default=DEFAULT_MODEL, help=f"Claude model (default {DEFAULT_MODEL})")
    p.add_argument("--effort", default="medium", choices=["low", "medium", "high", "xhigh", "max"])
    p.add_argument("--max-steps", type=int, default=40)
    p.add_argument("--timeout", type=int, default=1500, help="seconds for the whole task")
    p.add_argument("--no-vision", action="store_true", help="do not send screenshots to the model")
    p.add_argument("--file", action="append", default=[], help="a file the agent may upload (repeatable)")
    p.add_argument("--allow-login", action="store_true", help="let the agent sign in with credentials from the julia-browser vault")
    p.add_argument("--record", metavar="DIR", help="save screenshots and history.json under DIR")
    p.add_argument("--js-budget-ms", type=int, default=8000)
    p.add_argument("--profile-dir", help="keep this run's localStorage/IndexedDB in DIR")
    p.add_argument("--json", action="store_true", help="print the result as JSON")
    p.add_argument("-q", "--quiet", action="store_true", help="do not print each step")
    a = p.parse_args(argv)

    opts = {"js_budget_ms": a.js_budget_ms}
    if a.profile_dir:
        opts["profile_dir"] = a.profile_dir
    on_step = None if a.quiet or a.json else (lambda s: print(f"[{s.n:02d}] {'ok ' if s.ok else 'ERR'} {s.action}"
                                                              f"{'  @ ' + s.url if s.url else ''}", file=sys.stderr))
    with WebAgent(a.model, effort=a.effort, max_steps=a.max_steps, task_timeout_s=a.timeout, vision=not a.no_vision,
                  files=a.file, allow_login=a.allow_login, record_dir=a.record, on_step=on_step, **opts) as agent:
        result = agent.run(a.task, start_url=a.start_url)
    if a.json:
        print(json.dumps(result.to_dict(), indent=1, ensure_ascii=False))
    else:
        print(f"\nStatus: {result.status} ({len(result.steps) - 1} steps, ${result.usage['usd']})")
        print(f"Answer: {result.answer}")
    return 0 if result.status == "finished" else 1


if __name__ == "__main__":
    sys.exit(main())
