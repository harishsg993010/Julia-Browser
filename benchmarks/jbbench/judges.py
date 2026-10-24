"""LLM judges. Prompts follow the official graders where one exists (SimpleQA, BrowseComp,
WebVoyager auto-eval, Online-Mind2Web WebJudge), condensed; all return structured JSON."""

import base64
import re

from .llm import obj_schema

ANSWER_SCHEMA = obj_schema(answer={"type": "string"})

# ---------------------------------------------------------------- fetch: usable context?

USABLE_CATEGORIES = ["usable", "empty", "error_page", "bot_wall", "login_wall", "consent_only",
                     "boilerplate_only", "wrong_page", "garbled"]

USABLE_SYSTEM = """You grade a web fetcher. You see the URL that was requested and the text the fetcher
returned for it (markdown of the rendered page). Decide whether the returned text is USABLE CONTEXT:
it contains the page's main content (article, reference entry, listing, document, profile, ...) so an
LLM could answer questions about what that page says.

Not usable: empty or near-empty text; an HTTP/browser error page or "page not found"; a bot check or
CAPTCHA (Cloudflare, "verify you are human", "unusual traffic"); a login wall; only a cookie/consent
banner; only navigation/footer boilerplate with the main content missing; a different page than the URL
implies (e.g. redirected to a home page); text garbled by encoding problems.
A page whose main content is genuinely short (e.g. a short notice) is still usable."""


def judge_usable(judge, f):
    if f["error"] and not f["markdown"]:
        return {"usable": False, "category": "error_page", "reason": f["error"][:300]}
    if len(f["markdown"].strip()) < 40:
        return {"usable": False, "category": "empty", "reason": f"{len(f['markdown'])} chars"}
    body = f["markdown"][:8000]
    user = (f"Requested URL: {f['url']}\nFinal URL: {f['final_url']}\nTitle: {f['title']}\n"
            f"Returned text ({f['chars']} chars total, first {len(body)} shown):\n-----\n{body}\n-----")
    schema = obj_schema(category={"type": "string", "enum": USABLE_CATEGORIES}, reason={"type": "string"})
    v = judge.json(USABLE_SYSTEM, user, schema, effort="low")
    return {"usable": v["category"] == "usable", "category": v["category"], "reason": v["reason"]}


# ---------------------------------------------------------------- SimpleQA: is the evidence in the first result?

EVIDENCE_SYSTEM = """You check search quality. Given a question, its correct answer, and the content of
the FIRST search result (title, snippet and the fetched page), decide whether that result alone contains
enough evidence to answer the question correctly - i.e. the correct answer (or an unambiguous equivalent)
is stated or directly derivable from the text, in the right context. Do not use outside knowledge."""


def judge_evidence(judge, question, answer, result, f):
    page = f["markdown"][:30000] if f["markdown"] else f"(fetch failed: {f['error']})"
    user = (f"Question: {question}\nCorrect answer: {answer}\n\nFirst result: {result['title']} - {result['url']}\n"
            f"Snippet: {result['snippet']}\n\nFetched page:\n-----\n{page}\n-----")
    v = judge.json(EVIDENCE_SYSTEM, user, obj_schema(evidence={"type": "boolean"}, reason={"type": "string"}),
                   effort="low")
    return {"evidence": v["evidence"], "reason": v["reason"]}


# ---------------------------------------------------------------- SimpleQA grader (official rubric, condensed)

SIMPLEQA_GRADER = """Grade a predicted answer against the gold target as CORRECT, INCORRECT or NOT_ATTEMPTED.

CORRECT: the prediction contains the gold target's key information without contradicting it. Hedging is
fine if the right answer is given. Minor spelling differences and extra non-contradicting detail are fine.
Numbers must match to the precision of the gold target (e.g. gold "120k": "124k" is wrong, "about 120k" fine).
Partial names are fine when unambiguous (gold "Barack Obama": "Obama" is correct).
INCORRECT: any factual statement contradicts the gold target, or several candidate answers are given
without committing to one that is right.
NOT_ATTEMPTED: the gold target is not given and nothing contradicts it ("I don't know", "need more context")."""


def grade_simpleqa(judge, question, gold, predicted):
    user = f"Question: {question}\nGold target: {gold}\nPredicted answer: {predicted}"
    schema = obj_schema(grade={"type": "string", "enum": ["CORRECT", "INCORRECT", "NOT_ATTEMPTED"]})
    return judge.json(SIMPLEQA_GRADER, user, schema, effort="low")["grade"]


# ---------------------------------------------------------------- BrowseComp grader (official rubric, condensed)

BROWSECOMP_GRADER = """Judge whether the response answers the question correctly, given the precise
correct answer. Extract the final exact answer from the response ("None" if there is none). It is correct
only if it matches the correct answer, allowing small numerical tolerance and trivial formatting
differences; anything inconsistent, ambiguous or non-equivalent is incorrect. Do not re-solve the question."""


def grade_browsecomp(judge, question, gold, response):
    user = f"[question]: {question}\n\n[response]: {response}\n\n[correct_answer]: {gold}"
    schema = obj_schema(extracted_final_answer={"type": "string"}, reasoning={"type": "string"},
                        correct={"type": "boolean"})
    return judge.json(BROWSECOMP_GRADER, user, schema, effort="low")


# ---------------------------------------------------------------- web tasks (WebVoyager / Online-Mind2Web)

WEBTASK_SYSTEM = """You evaluate a web agent. You get the task, the agent's action history, its final
answer and screenshots of the last steps (in order; the last one is the final state).

The task is SUCCESSFUL only if every requirement in it is met: identify the key points first (filters,
quantities, dates, locations, sort orders, "cheapest", "at least 4 stars", ...), then check each against
the screenshots and history. When the agent read page text (read_page), that text came from the live
page and counts as evidence like a screenshot of it. Evidence outranks the agent's claims - if the answer
states something the screenshots, page text or history do not support, that requirement is not met. For tasks that ask to find or show
something, the final state or answer must show it. For tasks that end in a purchase, booking or sign-in,
reaching the last step before payment/credentials counts as done; saving an item to a list, wishlist or
account is such a step when the site asks to sign in for it (the right item, with the task's conditions,
must be identified). A bot check or error page as the final
state is a failure.

Evidence comes from any step, not only the last screenshots: page text the agent was shown or read at an
earlier step, and the extra screenshot labelled as the step that shows the answer, count as evidence.
If the agent applied every requirement correctly (right search, filters, form values) and the site itself
answers that nothing matches (no results, "order not found", "no match"), reporting that accurately IS a
successful outcome. This includes tasks that give made-up identifiers (order, tracking, title or account
numbers): submitting them correctly and reporting the site's rejection completes the task. Likewise, if the agent did everything the site allows correctly and one requirement asks
for something the site does not publish or offer (prices visible only after sign-in, a category or section
the site no longer has, a detail no page shows), and the evidence shows the agent looked where it would be and
the answer states plainly that the site lacks it (with any clearly labelled closest substitute), count the
task as successful. Do not count it if the agent just stopped early or the evidence shows the information
exists. A requirement phrased "X or Y" is met by either.
A total or comparison the agent computed from prices/values the site shows counts when the inputs are in
the evidence.
Listing prices labelled "From", "Starting at" or "as low as" are teasers: the lowest price over every date,
room type or option, often outside the task's conditions. When the agent sorted or filtered correctly and
reports the price the item's own booking/detail page shows for an option that meets the task, a small
difference from the listing's teaser price is not a failure, even if the agent mentions it as a caveat.
Relative dates ("yesterday", "latest", "within a month", "last 2 days") refer to the date the agent ran,
given with the task; the agent may rely on that date without a page showing it.
A reference answer, when given, was written when the dataset was made (2023) and sites change. For
questions about what the site shows now (latest, current, featured, headlines, sections), judge against
the live pages the agent saw: a reference naming content the evidence does not show is not proof that
the content exists today. More generally, when the agent used the method the task asks for (search,
filters, sort) and the evidence supports its answer, a different answer from the reference is not a failure;
fail only when the evidence shows the answer is wrong, a requirement is unmet or the agent skipped something
the evidence shows was there."""


REFERENCE_HINT = "Reference answer from the dataset (may be outdated - live sites change; use only as a hint)"
REFERENCE_TRUTH = ("Ground truth (verified; it takes precedence: if it is a factual answer the agent's answer must agree "
                   "with it, if it lists criteria they must be met. Compare the agent's stated final answer with it "
                   "directly - case, plural/singular and formatting do not matter - and do not re-derive the answer "
                   "from the agent's evidence)")


def _truth_words(s):
    import re
    import unicodedata
    s = unicodedata.normalize("NFKC", str(s)).lower()
    return re.findall(r"[^\W_]+", s)


def truth_match(answer, truth):
    """The answer's first line, or a line starting "Answer:", says exactly the (short) ground truth:
    the same words in the same order, ignoring case, punctuation and markdown."""
    if not answer or not truth or len(str(truth)) > 120:
        return False
    want = _truth_words(truth)
    if not want:
        return False
    lines = [l.strip().strip("*#>- ").strip() for l in str(answer).splitlines() if l.strip()]
    cands = lines[:1] + [l for l in lines if l.lower().lstrip("*").startswith(("answer:", "final answer:"))]
    for c in cands:
        c = c.split(":", 1)[1] if c.lower().lstrip("*").startswith(("answer:", "final answer:")) else c
        c = c.split(" (", 1)[0].rstrip(". ")
        if _truth_words(c) == want:
            return True
    return False


def judge_webtask(judge, task, answer, history, screenshots, reference=None, evidence_shot=None, reference_label=REFERENCE_HINT,
                  today=None):
    """`today`: the date the agent was told it is (default: now)."""
    import time
    content = []
    # earlier screenshots that may hold the answer: [(step, why, png)] (a single (step, png) also accepted)
    shots = [evidence_shot] if evidence_shot and not isinstance(evidence_shot, list) else (evidence_shot or [])
    for e in shots:
        step, why, png = (e[0], "the step whose page text best matches the answer", e[1]) if len(e) == 2 else e
        content.append({"type": "text", "text": f"Screenshot of step {step} ({why}):"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                    "data": base64.standard_b64encode(png).decode()}})
    for i, png in enumerate(screenshots):
        content.append({"type": "text", "text": f"Screenshot {i + 1} of {len(screenshots)}:"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                    "data": base64.standard_b64encode(png).decode()}})
    hist = "\n".join(f"{h['step']}. {h['action']}  @ {h.get('url') or '?'}" for h in history[-40:])
    ref = f"\n{reference_label}: {reference}" if reference else ""
    texts = _read_texts(history)
    texts += _shown_texts(history, answer, texts, task)
    content.append({"type": "text", "text": f"Task: {task}{ref}\n\nThe agent ran on {today or time.strftime('%A, %B %d, %Y')}.\n\n"
                                            f"Action history:\n{hist}\n\n"
                                            f"{texts}Agent's final answer: {answer or '(none)'}"})
    schema = obj_schema(key_points={"type": "array", "items": {"type": "string"}},
                        reasoning={"type": "string"}, success={"type": "boolean"})
    return judge.json(WEBTASK_SYSTEM, content, schema, effort="medium")


# ---------------------------------------------------------------- Odysseys rubrics

RUBRIC_SYSTEM = """You are an expert evaluator of web-navigation agent trajectories.

You get the user task (for context), a list of rubric items (each a requirement and how to verify it), the
agent's full action history (one line per step, with the URL), page text it saw, its final answer, and
screenshots of the pages it visited (labelled with step number and URL, in order).

Decide for EACH rubric item separately whether the trajectory satisfies it.
- Ground the judgment in what the screenshots, page text and actions actually show. Do not invent state;
  the agent's own claims are not evidence.
- Filtering / sorting / form requirements must be applied and confirmed to count as satisfied.
- If the agent was blocked (captcha, access denied, login wall) and therefore could not satisfy an item, it fails.
- Tabs: the agent keeps a page open as a browser tab with its keep_tab action. Those pages are listed under
  "Tabs open at the end" (with screenshots taken when they were kept) and are open browser tabs at the end of
  the task: a requirement to keep pages open in tabs is met by kept tabs showing the required pages. When no
  tabs are listed (an older run), a page the agent visited, shown by a screenshot or page text, counts as kept.
- Searches start on DuckDuckGo because Google Search shows this browser a CAPTCHA: a requirement to search on
  Google is met by the same search on DuckDuckGo (the pages it then opens must still meet the requirement).
- Information the task asks to report must also appear correctly in the final answer."""


def judge_rubrics(judge, task, rubrics, answer, history, shots, kept_tabs=None):
    """Odysseys grading: one verdict per rubric item. `shots`: [(step, url, png)] in order; `kept_tabs`:
    [(step, url)] of the pages the agent kept open as tabs."""
    content = []
    for step, url, png in shots:
        content.append({"type": "text", "text": f"Screenshot of step {step} ({url}):"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                    "data": base64.standard_b64encode(png).decode()}})
    hist = "\n".join(f"{h['step']}. {h['action']}  @ {h.get('url') or '?'}" for h in history[-150:])
    items = "\n".join(f"{rid}: requirement: {r['requirement'].strip()}\n    verification: {r['verification'].strip()}"
                      for rid, r in rubrics.items())
    texts = _read_texts(history)
    texts += _shown_texts(history, answer, texts, task)
    tabs = ("Tabs open at the end (kept with keep_tab):\n" + "\n".join(f"  step {s}: {u}" for s, u in kept_tabs) + "\n\n"
            if kept_tabs else "Tabs open at the end: none listed.\n\n")
    content.append({"type": "text", "text": f"User task (context only): {task}\n\nRubric items:\n{items}\n\n"
                                            f"Action history:\n{hist}\n\n{tabs}{texts}Agent's final answer: {answer or '(none)'}"})
    schema = obj_schema(items={"type": "array", "items": obj_schema(
        id={"type": "string"}, reasoning={"type": "string"}, success={"type": "boolean"})})
    out = judge.json(RUBRIC_SYSTEM, content, schema, effort="medium")
    got = {str(i.get("id", "")).strip(): i for i in out.get("items", [])}
    return {rid: {"success": bool(got.get(rid, {}).get("success")), "reasoning": got.get(rid, {}).get("reasoning", "not graded")}
            for rid in rubrics}


READ_TEXT_PER_STEP = 4000
READ_TEXT_TOTAL = 16000
SHOWN_TEXT_TOTAL = 10000
SHOWN_WINDOW = 1200
_FACT_STOP = {"I", "The", "This", "That", "Yes", "No", "What", "When", "Where", "Here", "There", "Steps",
              "Note", "Answer", "Caveats", "BLOCKED", "Partially", "Partial", "Found", "Searched", "Could"}


def _answer_facts(answer):
    """Specific, checkable tokens of an answer: numbers, prices, ids and capitalised names."""
    a = answer or ""
    nums = {t.strip(",.") for t in re.findall(r"\$?\d[\d,]*(?:\.\d+)?", a)}
    nums = {t for t in nums if len(t.replace("$", "").replace(",", "")) >= 2}
    # times and short numbers with a unit ("9AM", "9:00 PM", "3 lb") are checkable too
    nums |= {re.sub(r"\s+", " ", t).strip() for t in re.findall(r"\b\d{1,2}(?::\d\d)?\s?[AaPp]\.?[Mm]\b", a)}
    # a number with its unit ("13 hours", "4.6 stars", "72 ratings"): checkable even when the bare number
    # occurs elsewhere in the page text
    nums |= {re.sub(r"\s+", " ", t).strip() for t in re.findall(
        r"\b\d[\d,]*(?:\.\d+)?\s(?:hours?|hrs?|minutes?|mins?|seconds?|days?|weeks?|months?|years?|stars?|reviews?|"
        r"ratings?|results?|downloads?|likes?|followers?|forks?|items?|courses?|papers?|authors?|pages?|"
        r"miles?|km|kg|lbs?|GB|MB|TB)\b", a)}
    names = set(re.findall(r"\b[A-Z][A-Za-z0-9'&.-]{3,}(?:\s+[A-Z0-9][A-Za-z0-9'&.-]+)*", a))
    return nums | {n for n in names if n.split()[0] not in _FACT_STOP}


def evidence_step(history, answer):
    """The step whose page text (excerpt, read_page, element labels) contains the most answer facts."""
    want = _answer_facts(answer)
    if not want:
        return None
    best, score = None, 0
    for h in history:
        text = " ".join(t for t in (h.get("page_text"), h.get("page_excerpt"), h.get("elements_text")) if t)
        n = sum(1 for f in want if f in text)
        if n > score or (n == score and n and best is not None and h["step"] > best["step"]):
            best, score = h, n
    return best if score >= 1 else None


def _windows(text, size=SHOWN_WINDOW):
    out, cur = [], ""
    for para in re.split(r"\n\s*\n", text):
        if cur and len(cur) + len(para) > size:
            out.append(cur)
            cur = ""
        cur = (cur + "\n\n" + para) if cur else para
        while len(cur) > size * 2:
            out.append(cur[:size])
            cur = cur[size:]
    if cur.strip():
        out.append(cur)
    return out


def _shown_texts(history, answer, base, task=""):
    """Passages of the page text the agent was shown (step excerpts, whole read_page texts) that
    contain answer facts `base` (the judge's usual page text) lacks, greedily by facts covered.
    Facts the task itself contains prove nothing (a search start page echoes the whole task), and
    numbers (prices, distances, dates) weigh more than names."""
    low_task = (task or "").lower()
    want = {f for f in _answer_facts(answer) if f not in base and f.lower() not in low_task}
    weight = lambda facts: sum(3 if any(ch.isdigit() for ch in f) else 1 for f in facts)
    if not want:
        return ""
    cands = [(h, w) for h in history for src in (h.get("page_text"), h.get("page_excerpt"), h.get("elements_text"))
             for w in _windows(src or "") if w not in base]
    picked, used, covered = [], 0, set()
    while cands and used < SHOWN_TEXT_TOTAL:
        best, gain = None, set()
        for c in cands:
            g = {f for f in want - covered if f in c[1]}
            if weight(g) > weight(gain):
                best, gain = c, g
        if not best:
            break
        cands.remove(best)
        if used + len(best[1]) > SHOWN_TEXT_TOTAL:
            continue
        covered |= gain
        picked.append(best)
        used += len(best[1])
    if not picked:
        return ""
    picked.sort(key=lambda c: c[0]["step"])
    body = "\n".join(f"--- step {h['step']}, {h.get('url')} ---\n{w}" for h, w in picked)
    return ("Other page text the agent was shown during the task (observation excerpts and read_page, from the "
            "live page; the passages that contain facts used in the answer):\n" + body + "\n\n")


def _read_texts(history):
    """Page text the agent read with read_page (latest reads first, capped), for the judge."""
    final = next((h for h in reversed(history) if h.get("page_excerpt")), None)
    final_text = (f"Text of the final page (markdown excerpt the agent saw at step {final['step']}, {final.get('url')}):\n"
                  f"{final['page_excerpt']}\n\n") if final else ""
    reads = [h for h in history if h.get("page_text")]
    if not reads:
        return final_text
    parts, used = [], 0
    for h in reversed(reads):
        chunk = h["page_text"][:READ_TEXT_PER_STEP]
        if used + len(chunk) > READ_TEXT_TOTAL:
            break
        parts.append(f"--- step {h['step']}, {h.get('url')} ---\n{chunk}")
        used += len(chunk)
    return ("Page text the agent read (read_page, from the live page):\n" + "\n".join(reversed(parts)) + "\n\n"
            + final_text)
