"""The observe -> act loop: Claude sees the page (URL, numbered elements, page text, screenshot) and
calls one browser action per turn until it finishes the task."""

import base64
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional
from urllib.parse import quote_plus

from .browser import Session
from .llm import DEFAULT_MODEL, LLM
from .page import OBSERVE_JS
from .tools import FAILURES, Actions, tool_list

SYSTEM = """You operate a web browser to complete a task for a user on live websites.
After each action you get the new page state: URL, title, numbered interactive elements (in and just
below the viewport), the page text around the scroll position and usually a screenshot. Refer to
elements by number. Take one action per turn.

How to work:
- Work like a careful person: use the site's own search, filters and sort controls, and check every
  requirement of the task (dates, quantities, ratings, locations, price limits) before finishing.
- Close cookie/consent banners and popups that cover the page.
- Elements marked "(in scroll pane)" are inside a scrollable list, sidebar or dialog; clicking one
  scrolls it into view. Use find for a button or section you expect but do not see in the list.
- Use read_page for other parts of a long page. If the page is still loading, use wait.
- Every fact in your answer must come from a page you saw, not from memory. When a results list does
  not show a detail, open the item's page and check it there.
- If a control does not respond, try another route: the control's label or option text, the site's
  search or URL parameters, another page of the site.
- "Cheapest", "latest", "highest-rated": read the value of every candidate, compare them and cite them.
- Compute relative dates ("tomorrow", "last week") from today's date given with the task.
- When what you need has no element number (a map, a canvas, a chart), use click_at with coordinates
  read off the screenshot.
- If the site correctly reports that nothing matches, say so together with the search and filters you used.
- When the task asks for information, put the information itself in the finish answer.
- End on the page that shows the result."""

NO_ACCOUNT_RULES = """
- Do not sign in, create accounts, enter payment details or complete purchases: stop at the last step
  before that and finish, describing where you stopped.
- If a CAPTCHA or a login wall stops you, finish with "BLOCKED: <what you saw>"."""

LOGIN_RULES = """
- When the task needs an account on this site, use the login tool (and otp for a one-time code): it fills
  the user's saved credentials without showing them to you. Never ask for or type passwords yourself.
- Do not enter payment details or complete purchases unless the task explicitly asks for it.
- If a CAPTCHA stops you, finish with "BLOCKED: <what you saw>"."""

MD_EXCERPT_CHARS = 3000
BLOCKED_RE = re.compile(r"(^|\n)\s*\**BLOCKED\**:", re.I)


@dataclass
class Step:
    n: int
    action: str
    ok: bool
    url: Optional[str]
    thought: str = ""
    screenshot: Optional[bytes] = field(default=None, repr=False)


@dataclass
class Result:
    task: str
    answer: Optional[str]
    status: str  # finished | blocked | max-steps | timeout | refused
    steps: List[Step]
    final_url: Optional[str]
    usage: dict

    def to_dict(self):
        return {"task": self.task, "answer": self.answer, "status": self.status, "final_url": self.final_url,
                "steps": [{"step": s.n, "action": s.action, "ok": s.ok, "url": s.url, "thought": s.thought} for s in self.steps],
                "usage": self.usage}


class WebAgent:
    """A general web agent on julia-browser.

    >>> agent = WebAgent()
    >>> result = agent.run("Find the current top story on Hacker News", start_url="https://news.ycombinator.com")
    >>> print(result.answer)

    model / effort: the Claude model driving the browser (default Haiku 5.5).
    max_steps, task_timeout_s: limits per task.
    vision: send a screenshot with every observation.
    files: local files the agent may attach to upload fields.
    allow_login: give the agent the vault login/otp tools (credentials never reach the model).
    record_dir: write screenshots and history.json of each run there.
    on_step: callback(Step) after every action.
    browser_options: passed to julia_browser.Browser (js_budget_ms, settle_ms, profile_dir, user_agent, ...).
    """

    def __init__(self, model: str = DEFAULT_MODEL, *, effort: str = "medium", max_steps: int = 40,
                 task_timeout_s: int = 1500, vision: bool = True, files=(), allow_login: bool = False,
                 record_dir=None, on_step: Optional[Callable[[Step], None]] = None, page_timeout_s: int = 45,
                 llm: Optional[LLM] = None, **browser_options):
        self.llm = llm or LLM(model, effort)
        self.max_steps = max_steps
        self.task_timeout_s = task_timeout_s
        self.vision = vision
        self.files = list(files)
        self.allow_login = allow_login
        self.record_dir = Path(record_dir) if record_dir else None
        self.on_step = on_step
        self.session = Session(timeout_s=page_timeout_s, **browser_options)
        self.actions = Actions(self.session, self.files)
        self.tools = tool_list(self.files, allow_login)
        self.system = SYSTEM + (LOGIN_RULES if allow_login else NO_ACCOUNT_RULES)

    def close(self):
        self.session.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # ---- the loop

    def run(self, task: str, start_url: Optional[str] = None) -> Result:
        deadline = time.time() + self.task_timeout_s
        start = start_url or f"https://lite.duckduckgo.com/lite/?q={quote_plus(task[:400])}"
        steps: List[Step] = []
        run_dir = self._run_dir()

        def record(action, ok, thought, obs):
            png = self._shot()
            step = Step(len(steps), action, ok, obs.get("url"), thought, png)
            steps.append(step)
            if run_dir and png:
                (run_dir / f"{step.n:04d}.png").write_bytes(png)
            if self.on_step:
                self.on_step(step)
            return png

        err = None
        try:
            self.session.call(lambda b: b.open(start))
        except FAILURES as e:
            err = str(e)
        obs = self._observe()
        png = record(f"GOTO {start}", err is None, "Open the start page.", obs)
        today = time.strftime("%A, %B %d, %Y")
        intro = (f"Task: {task}\n\nToday is {today} (local time).\n\n"
                 + ("" if start_url else "No start page was given; you start on a search engine (the search tool works too).\n\n")
                 + (f"Files you can upload: {', '.join(Path(f).name for f in self.files)}.\n\n" if self.files else ""))
        messages = [{"role": "user", "content": [{"type": "text", "text": intro + _obs_text(obs, err)}, *self._img(png)]}]

        answer, status, last_url, recent = None, "max-steps", None, []
        while len(steps) <= self.max_steps:
            if time.time() > deadline:
                status = "timeout"
                break
            resp = self.llm.create(system=self.system, messages=messages, tools=self.tools,
                                   tool_choice={"type": "auto", "disable_parallel_tool_use": True})
            messages.append({"role": "assistant", "content": resp.content})
            if resp.stop_reason == "refusal":
                status = "refused"
                break
            thought = " ".join(b.text for b in resp.content if b.type == "text").strip()
            uses = [b for b in resp.content if b.type == "tool_use"]
            if not uses:
                answer, status = thought, "finished"
                break
            results, done = [], False
            for i, u in enumerate(uses):
                if i > 0:  # one action per turn
                    results.append({"type": "tool_result", "tool_use_id": u.id, "content": "Skipped: one action per turn.",
                                    "is_error": True})
                    continue
                if u.name == "finish":
                    answer = u.input["answer"]
                    status = "blocked" if BLOCKED_RE.search(answer.strip()) else "finished"
                    results.append({"type": "tool_result", "tool_use_id": u.id, "content": "Task ended."})
                    done = True
                    continue
                if (obs.get("url") or "").startswith("http"):
                    last_url = obs["url"]
                resets = self.session.resets
                desc, ok, extra = self.actions.run(u.name, u.input, obs)
                if self.session.resets > resets and last_url:
                    # the action timed out and the browser was replaced: reload the page the agent was on
                    try:
                        self.session.call(lambda b: b.open(last_url))
                        note = f"The browser was restarted after the timeout and {last_url} was reloaded."
                    except FAILURES as e:
                        note = f"The browser was restarted after the timeout; reloading {last_url} failed: {e}"
                    desc, extra = f"{desc} ({note})", (extra + "\n" if extra else "") + note
                obs = self._observe()
                png = record(desc, ok, thought, obs)
                left = self.max_steps - (len(steps) - 1)
                text = (extra + "\n\n" if extra else "") + _obs_text(obs, None if ok else desc) \
                    + f"\n\n(Step {len(steps) - 1} of {self.max_steps}.)" \
                    + (" Only a few steps left: finish the remaining requirements, then call finish." if 0 < left <= 5 else "")
                recent.append((u.name, json.dumps(u.input, sort_keys=True)))
                if len(recent) >= 3 and len(set(recent[-3:])) == 1 and u.name != "read_page":
                    text += "\n\nNote: you did exactly this action 3 times in a row. If nothing changed, try a different way."
                results.append({"type": "tool_result", "tool_use_id": u.id,
                                "content": [{"type": "text", "text": text}, *self._img(png)]})
            messages.append({"role": "user", "content": results})
            if done:
                break

        if status == "max-steps" and answer is None and messages[-1]["role"] == "user":
            # out of steps: one forced finish with what the agent has seen
            messages[-1]["content"].append({"type": "text", "text": "You have used all your steps. Call finish now with your "
                                            "best answer from what you have seen; say plainly what you could not verify."})
            try:
                resp = self.llm.create(system=self.system, messages=messages, tools=self.tools, max_tokens=4000,
                                       tool_choice={"type": "tool", "name": "finish"})
                fin = next((b for b in resp.content if b.type == "tool_use" and b.name == "finish"), None)
                if fin:
                    answer = fin.input.get("answer")
            except Exception:
                pass

        result = Result(task, answer, status, steps, obs.get("url"), self.llm.cost())
        if run_dir:
            (run_dir / "history.json").write_text(json.dumps(result.to_dict(), indent=1, ensure_ascii=False), encoding="utf-8")
        return result

    # ---- observation

    def _observe(self):
        s = self.session
        try:
            obs = s.call(lambda b: b.eval(OBSERVE_JS, settle=False), timeout_s=60, reset_on_timeout=False) or {}
        except FAILURES as e:
            obs = {"error": str(e)}
            try:
                obs["url"] = s.call(lambda b: b.url, timeout_s=20, reset_on_timeout=False)
            except FAILURES:
                pass
        try:
            md = s.call(lambda b: b.read(), timeout_s=30, reset_on_timeout=False) or ""
        except FAILURES:
            md = ""
        if md:
            # markdown has no geometry: start the excerpt at the same fraction of the text as the
            # viewport is of the page, a little before it
            frac = (obs.get("scroll_y") or 0) / max(1, obs.get("page_height") or 1)
            start = max(0, min(int(frac * len(md)) - 300, len(md) - MD_EXCERPT_CHARS))
            start = md.rfind("\n", 0, start) + 1 if start else 0
            obs["md_excerpt"] = md[start:start + MD_EXCERPT_CHARS]
            obs["md_start"], obs["md_total"] = start, len(md)
        return obs

    def _shot(self):
        try:
            return self.session.call(lambda b: b.screenshot(), timeout_s=30, reset_on_timeout=False)
        except FAILURES:
            return None

    def _img(self, png):
        if not (png and self.vision):
            return []
        return [{"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                             "data": base64.standard_b64encode(png).decode()}}]

    def _run_dir(self):
        if not self.record_dir:
            return None
        d = self.record_dir / time.strftime("%Y%m%d-%H%M%S")
        d.mkdir(parents=True, exist_ok=True)
        return d


def _obs_text(obs, err):
    if obs.get("error"):
        out = (f"URL: {obs['url']}\n" if obs.get("url") else "") + f"Could not list the page's elements: {obs['error']}"
        if obs.get("md_excerpt"):
            out += f"\n\nPage text (markdown, first part; read_page shows any part):\n{obs['md_excerpt']}"
        return out
    lines = [f"URL: {obs.get('url')}", f"Title: {obs.get('title')}",
             f"Scroll: {obs.get('scroll_y')} / {obs.get('page_height')} px (viewport {obs.get('viewport_h')})"]
    if err:
        lines.insert(0, f"Last action failed: {err}")
    lines.append("Elements:")
    for e in obs.get("elements", []):
        extra = "".join(f" {k}={json.dumps(e[k], ensure_ascii=False)}" for k in ("type", "href", "value", "min", "max", "checked", "options")
                        if k in e)
        lines.append(f"[{e['i']}] <{e['tag']}> {e['label']!r}{extra}{' (in frame)' if e.get('frame') else ''}"
                     f"{' (in scroll pane)' if e.get('in_pane') else ''}{' (below fold)' if e.get('below_fold') else ''}")
    if not obs.get("elements"):
        lines.append("(none found)")
    if obs.get("md_excerpt"):
        s = obs["md_start"]
        lines.append(f"\nPage text (markdown, chars {s}-{s + len(obs['md_excerpt'])} of {obs['md_total']}, "
                     f"around the current scroll position; read_page shows any part):\n{obs['md_excerpt']}")
    for f in obs.get("frames") or []:
        lines.append(f"\nEmbedded frame {f.get('src')!r} text:\n{f.get('text', '')[:1500]}")
    return "\n".join(lines)
