"""The agent's browser actions: tool definitions for Claude and their execution on the page."""

import datetime
import json
import re
import tempfile
import time
from pathlib import Path

from .browser import ERRORS, BrowserError, BrowserTimeout
from .page import (FIND_JS, INPUT_TYPE_JS, POPUPS_JS, READBACK_JS, REFIND_JS, SET_VALUE_JS, TRANSIENT_END_JS,
                   TRANSIENT_START_JS, UPLOAD_TARGET_JS, _DATE_FORMATS, _DATE_OUT)

FAILURES = (*ERRORS, BrowserTimeout)


def _schema(props, req):
    return {"type": "object", "properties": props, "required": req, "additionalProperties": False}


INT = {"type": "integer"}
STR = {"type": "string"}

BASE_TOOLS = [
    {"name": "click", "description": "Click the element with this number.", "input_schema": _schema({"element": INT}, ["element"])},
    {"name": "type", "description": "Replace the text of an input/textarea with `text`; set submit=true to press Enter after.",
     "input_schema": _schema({"element": INT, "text": STR, "submit": {"type": "boolean"}}, ["element", "text", "submit"])},
    {"name": "select", "description": "Choose an option of a <select> (or a custom dropdown) by its visible text or value.",
     "input_schema": _schema({"element": INT, "option": STR}, ["element", "option"])},
    {"name": "click_at", "description": "Click at a point of the screenshot: x, y in CSS pixels from its top-left corner "
                                        "(the viewport is 1280x720). For things without an element number: a map, a chart, "
                                        "a canvas, a game board. double=true double-clicks.",
     "input_schema": _schema({"x": INT, "y": INT, "double": {"type": "boolean"}}, ["x", "y"])},
    {"name": "keyboard_type", "description": "Type text with the keyboard into whatever has the focus (no element number needed).",
     "input_schema": _schema({"text": STR}, ["text"])},
    {"name": "drag_at", "description": "Drag with the mouse from one point of the screenshot to another (x, y in CSS pixels): "
                                       "slider handles, maps, drag-and-drop.",
     "input_schema": _schema({"x1": INT, "y1": INT, "x2": INT, "y2": INT}, ["x1", "y1", "x2", "y2"])},
    {"name": "hover", "description": "Move the mouse over an element (opens hover menus).", "input_schema": _schema({"element": INT}, ["element"])},
    {"name": "press", "description": "Press a key or combination at the focused element, e.g. Enter, Escape, Tab, ArrowDown, Control+a.",
     "input_schema": _schema({"key": STR}, ["key"])},
    {"name": "scroll", "description": "Scroll the page up or down by about one screen.",
     "input_schema": _schema({"direction": {"type": "string", "enum": ["up", "down"]}}, ["direction"])},
    {"name": "goto", "description": "Navigate to a URL.", "input_schema": _schema({"url": STR}, ["url"])},
    {"name": "back", "description": "Go back to the previous page.", "input_schema": _schema({}, [])},
    {"name": "search", "description": "Search the web; returns result titles, URLs and snippets (open one with goto).",
     "input_schema": _schema({"query": STR}, ["query"])},
    {"name": "wait", "description": "Let the page run for a few seconds (1-10) while it is still loading.",
     "input_schema": _schema({"seconds": INT}, ["seconds"])},
    {"name": "find", "description": "Find text on the page, like Ctrl+F: scrolls the first element containing `text` into view "
                                    "and lists the matches; calling it again with the same text moves to the next match.",
     "input_schema": _schema({"text": STR}, ["text"])},
    {"name": "read_page", "description": "Return the page's text as markdown, 8000 characters from `offset`.",
     "input_schema": _schema({"offset": INT}, ["offset"])},
    {"name": "finish", "description": "End the task. `answer` is the final answer or a summary of what was done; start it "
                                      "with 'BLOCKED:' if a CAPTCHA or a required login stopped you.",
     "input_schema": _schema({"answer": STR}, ["answer"])},
]

LOGIN_TOOLS = [
    {"name": "login", "description": "Sign in on the current page with the user's saved credentials (julia-browser vault): fills "
                                     "the username and password fields without showing them to you; then click the sign-in "
                                     "button. `reason` says why (kept in the vault's audit log).",
     "input_schema": _schema({"reason": STR}, ["reason"])},
    {"name": "otp", "description": "Fill the current one-time code (2FA) for this site from the vault.",
     "input_schema": _schema({"reason": STR}, ["reason"])},
]


def tool_list(files=(), allow_login=False):
    tools = list(BASE_TOOLS)
    if files:
        tools.insert(-1, {"name": "upload", "description": "Attach one of the user's files to a file input (or the button/label "
                                                           "that opens one).",
                          "input_schema": _schema({"element": INT, "file": {"type": "string", "enum": [Path(f).name for f in files]}},
                                                  ["element", "file"])})
    if allow_login:
        tools[-1:-1] = LOGIN_TOOLS
    return [dict(t, strict=True) for t in tools]


TRANSIENT_ACTIONS = {"click", "press", "type", "click_at", "keyboard_type", "select"}


class Actions:
    """Runs one tool call on the page: -> (description, ok, extra text for the model)."""

    def __init__(self, session, files=()):
        self.s = session
        self.files = {Path(f).name: str(Path(f).resolve()) for f in files}

    def run(self, name, a, obs):
        target = _label(obs, a)
        watch = name in TRANSIENT_ACTIONS
        if watch:
            watch = self._eval(TRANSIENT_START_JS) is not None
        res = self._once(name, a, target)
        if watch:
            note = self._transient_note()
            if note:
                res = (res[0], res[1], (res[2] + " " + note).strip())
        # React/Vue re-rendered the element since the observation: find it again by tag + label
        if not res[1] and "No element matches" in res[0] and "element" in a:
            e = next((e for e in obs.get("elements", []) if e["i"] == a["element"]), None)
            if e and e.get("label") and self._eval(f"{REFIND_JS}({json.dumps(e['tag'])}, {json.dumps(e['label'])}, {a['element']})"):
                return self._once(name, a, target)
        return res

    # ---- helpers

    def _eval(self, js, timeout_s=20):
        try:
            return self.s.call(lambda b: b.eval(js, settle=False), timeout_s=timeout_s, reset_on_timeout=False)
        except FAILURES:
            return None

    def _transient_note(self):
        r = self._eval(TRANSIENT_END_JS) or {}
        parts = []
        dialogs = r.get("dialogs") or []
        if any(d.startswith("print:") for d in dialogs):
            path = Path(tempfile.gettempdir()) / f"jb-print-{int(time.time() * 1000)}.pdf"
            try:
                self.s.call(lambda b: b.pdf(path), timeout_s=60, reset_on_timeout=False)
                parts.append(f"The page opened the print dialog; the browser saved it as PDF: {path}.")
            except (*FAILURES, OSError) as e:
                parts.append(f"The page opened the print dialog, but saving it as PDF failed: {e}")
        for d in [d for d in dialogs if not d.startswith("print:")][:3]:
            parts.append(f"The page showed a dialog ({d[:300]}); it was dismissed.")
        if r.get("clipboard"):
            parts.append(f"The page copied this text to the clipboard: {r['clipboard'][:1000]!r}")
        shown = [(s, hidden) for s, hidden in (r.get("gone") or []) if 8 <= len(s) <= 300][:3]
        if shown:
            parts.append("Text the page showed in response to the action (it may hide itself again): "
                         + " | ".join(repr(s) + (" (already hidden again)" if hidden else "") for s, hidden in shown))
        return " ".join(parts)

    def _readback(self, sel, wanted):
        r = self._eval(f"{READBACK_JS}({json.dumps(sel)})")
        if not isinstance(r, dict):
            return ""
        norm = lambda x: re.sub(r"\s+", " ", str(x or "")).strip().lower()
        w = norm(wanted)
        if r.get("kind") == "select":
            if w and w not in (norm(r.get("text")), norm(r.get("value"))) and w not in norm(r.get("text")):
                return f"FAILED: the select still shows {r.get('text')!r} (value {r.get('value')!r})"
            return ""
        if w and norm(r.get("value")) != w:
            return f"Note: the field now shows {r.get('value')!r} (the page may have reformatted it or opened suggestions)."
        return ""

    def _date_value(self, sel, text):
        """Date-family inputs accept only their ISO form; convert what the model typed."""
        kind = self._eval(INPUT_TYPE_JS % json.dumps(sel))
        fmts = _DATE_FORMATS.get(kind or "")
        if not fmts:
            return text, ""
        for f in fmts:
            try:
                return datetime.datetime.strptime(text.strip(), f).strftime(_DATE_OUT[kind]), kind
            except ValueError:
                pass
        return text.strip(), kind

    # ---- one action

    def _once(self, name, a, target):
        s = self.s
        sel = f'[data-jb-idx="{a["element"]}"]' if "element" in a else None
        target = target or (f"[{a['element']}]" if "element" in a else "")
        try:
            if name == "click":
                before = self._eval(POPUPS_JS) or []
                s.call(lambda b: b.click(sel))
                after = self._eval(POPUPS_JS) or []
                seen, opened = list(before), []
                for u in after:
                    if u in seen:
                        seen.remove(u)
                    elif u.startswith("http"):
                        opened.append(u)
                if opened:  # a new tab: show it
                    prev = s.call(lambda b: b.url, timeout_s=20)
                    s.call(lambda b: b.open(opened[-1]))
                    return (f"CLICK {target} (opened a new tab: {opened[-1]})", True,
                            f"The click opened {opened[-1]} in a new tab; the view now shows it (the previous page was {prev}).")
                return f"CLICK {target}", True, ""
            if name == "type":
                text, kind = self._date_value(sel, a["text"])
                if kind:
                    self._eval(SET_VALUE_JS % (json.dumps(sel), json.dumps(text)))
                    return f"TYPE {target} {text!r}", True, self._readback(sel, text)

                def go(b):
                    try:
                        b.fill(sel, a["text"])
                    except BrowserError:
                        b.click(sel)
                        b.keyboard_type(a["text"])
                    if a.get("submit"):
                        b.press("Enter")
                s.call(go)
                note = "" if a.get("submit") else self._readback(sel, a["text"])
                return f"TYPE {target} {a['text']!r}{' + ENTER' if a.get('submit') else ''}", True, note
            if name == "select":
                def pick(b):
                    try:
                        b.select(sel, a["option"])
                    except BrowserError as e:
                        # custom dropdowns: open it, then click the option by its text
                        if "No option" not in str(e) or b.eval(f"document.querySelector({json.dumps(sel)})?.tagName", settle=False) == "SELECT":
                            raise
                        b.click(sel)
                        b.click(f"text={a['option']}")
                s.call(pick)
                note = self._readback(sel, a["option"])
                if note.startswith("FAILED"):
                    return f"SELECT {target} {a['option']!r} -> {note}", False, ""
                return f"SELECT {target} {a['option']!r}", True, note
            if name == "upload":
                path = self.files.get(a["file"])
                if not path:
                    return f"UPLOAD {a['file']} -> unknown file", False, ""
                if not self._eval(UPLOAD_TARGET_JS % json.dumps(sel)):
                    return f"UPLOAD {target} -> FAILED: no <input type=file> at or near that element", False, ""
                msg = s.call(lambda b: b.upload('[data-jb-upload="1"]', path))
                return f"UPLOAD {target} {a['file']}", True, msg if isinstance(msg, str) else ""
            if name == "click_at":
                x, y, n = int(a["x"]), int(a["y"]), 2 if a.get("double") else 1
                msg = s.call(lambda b: b.click_at(x, y, count=n))
                return f"{'DOUBLE_' if n == 2 else ''}CLICK_AT ({x}, {y})", True, msg if isinstance(msg, str) else ""
            if name == "keyboard_type":
                msg = s.call(lambda b: b.keyboard_type(a["text"]))
                return f"KEYBOARD_TYPE {a['text']!r}", True, msg if isinstance(msg, str) else ""
            if name == "drag_at":
                x1, y1, x2, y2 = int(a["x1"]), int(a["y1"]), int(a["x2"]), int(a["y2"])
                msg = s.call(lambda b: b.drag_at(x1, y1, x2, y2))
                return f"DRAG_AT ({x1}, {y1}) -> ({x2}, {y2})", True, msg if isinstance(msg, str) else ""
            if name == "hover":
                s.call(lambda b: b.hover(sel))
                return f"HOVER {target}", True, ""
            if name == "press":
                s.call(lambda b: b.press(a["key"]))
                return f"PRESS {a['key']}", True, ""
            if name == "scroll":
                s.call(lambda b: b.scroll(a["direction"], 600))
                return f"SCROLL {a['direction'].upper()}", True, ""
            if name == "goto":
                s.call(lambda b: b.open(a["url"]))
                return f"GOTO {a['url']}", True, ""
            if name == "back":
                def back(b):
                    r = b.command("back")
                    if not r.get("ok"):
                        raise BrowserError(r.get("error") or "back failed")
                s.call(back)
                return "GO BACK", True, ""
            if name == "search":
                results = s.search(a["query"])
                if not results:
                    return f"SEARCH {a['query']!r} -> no results", False, "The search returned no results."
                lines = "\n".join(f"{i + 1}. {r['title']}\n   {r['url']}\n   {r['snippet'][:200]}" for i, r in enumerate(results))
                return f"SEARCH {a['query']!r}", True, f"Search results for {a['query']!r}:\n{lines}"
            if name == "wait":
                secs = min(10, max(1, int(a.get("seconds") or 3)))
                s.call(lambda b: b.wait(secs * 1000))
                return f"WAIT {secs}s", True, ""
            if name == "find":
                r = s.call(lambda b: b.eval(f"({FIND_JS})({json.dumps(a['text'])})")) or {}
                if not r.get("count"):
                    return f"FIND {a['text']!r} -> no match", False, f"No visible element contains {a['text']!r}."
                lines = "\n".join(f"  {i + 1}. {m}" for i, m in enumerate(r.get("matches") or []))
                return (f"FIND {a['text']!r} -> match {r.get('shown')} of {r['count']}", True,
                        f"{r['count']} match(es) for {a['text']!r}; match {r.get('shown')} is now scrolled into view:\n{lines}")
            if name == "read_page":
                off = max(0, a.get("offset") or 0)
                md = s.call(lambda b: b.read()) or ""
                chunk = md[off:off + 8000]
                return f"READ PAGE from {off}", True, f"[chars {off}-{off + len(chunk)} of {len(md)}]\n{chunk}"
            if name == "login":
                msg = s.call(lambda b: b.login(a["reason"]))
                return "LOGIN (vault)", True, msg if isinstance(msg, str) else ""
            if name == "otp":
                msg = s.call(lambda b: b.otp(a["reason"]))
                return "ONE-TIME CODE (vault)", True, msg if isinstance(msg, str) else ""
            return f"unknown action {name}", False, ""
        except FAILURES as e:
            return f"{name.upper()} {target or json.dumps(a)} -> error: {e}"[:400], False, ""


def _label(obs, a):
    """The element an action targets, as `[N] <tag> 'label'`."""
    if "element" not in a:
        return ""
    e = next((e for e in obs.get("elements", []) if e["i"] == a["element"]), None)
    return f"[{a['element']}] <{e['tag']}> {e['label'][:60]!r}" if e else f"[{a['element']}]"
