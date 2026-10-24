"""WebVoyager and Online-Mind2Web: an observe -> act agent driving julia-browser.

Each step: the agent sees the URL, title, the numbered interactive elements in/near the viewport and
(with --vision, the default) a screenshot; it calls one browser action; the harness records the step
and a screenshot under results/<suite>/<run>/<task_id>/trajectory/. Success is decided by an LLM judge
over the action history and the last screenshots. Mind2Web runs also write the official
`result.json` (schema online-mind2web-v2), so the official WebJudge can be run on the same folder.
"""

import base64
import json
import re
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import quote_plus

from julia_browser import BrowserError

from .. import data
from ..judges import REFERENCE_TRUTH, _answer_facts as answer_facts, evidence_step, judge_rubrics, judge_webtask, truth_match
from ..util import rate, run_items
from ..web import BLOCK_MARKERS, BLOCK_TEXT_MARKERS, BLOCK_URL_MARKERS, WebTimeout

_OBSERVE_SRC = r"""(() => {
  // inside a frame (run by the page's observation): numbers continue the page's, frames not entered
  const BASE = globalThis.__jbObsBase || 0, IN_FRAME = !!globalThis.__jbObsInFrame, SELF = __OBS_SELF__;
  for (const e of document.querySelectorAll('[data-jb-idx]')) e.removeAttribute('data-jb-idx');
  // open shadow roots, nested ones too (web components: Healthline's quiz <landing-view>)
  const shadowRoots = [];
  (function walk(root) { for (const h of root.querySelectorAll('*')) { const sr = h.shadowRoot || h._shadowRoot; if (sr) { shadowRoots.push(sr); walk(sr); } } })(document);
  // the parent in the flat tree: a shadow tree's top elements continue at their host
  const up = a => a.parentElement || (a.parentNode && a.parentNode.host) || null;
  for (const sr of shadowRoots) for (const e of sr.querySelectorAll('[data-jb-idx]')) e.removeAttribute('data-jb-idx');
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],' +
    '[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=treeitem],[role=option],[role=checkbox],[role=radio],[role=combobox],[role=switch],' +
    '[role=searchbox],[role=textbox],[contenteditable=true],[contenteditable=""],[onclick]';
  const marks = [];
  const H = window.innerHeight || 720, W = window.innerWidth || 1280, out = [];
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  // an element inside a transparent or clipping ancestor it lies outside of is not visible (USPS's
  // closed mega-menus: opacity 0 / max-height 0 containers filled the list)
  const anc = new Map();
  const ancInfo = a => {
    let v = anc.get(a);
    if (v === undefined) {
      const s = getComputedStyle(a), clip = o => o === 'hidden' || o === 'clip' || o === 'auto' || o === 'scroll';
      v = {op: s.opacity === '0', cx: clip(s.overflowX), cy: clip(s.overflowY), r: null, pane: false};
      if (v.cx || v.cy) { try { v.r = a.getBoundingClientRect(); } catch (e) { v.cx = v.cy = false; } }
      // an on-screen pane the user can scroll
      if (v.r && /auto|scroll/.test(s.overflowY + ' ' + s.overflowX) && v.r.width >= 20 && v.r.height >= 20 &&
          v.r.bottom > 0 && v.r.top < H && (a.scrollHeight > a.clientHeight + 2 || a.scrollWidth > a.clientWidth + 2)) v.pane = true;
      anc.set(a, v);
    }
    return v;
  };
  // -> true (hidden), the scroll pane it is scrolled out of (listed "in scroll pane"), or false
  const hiddenByAncestor = (el, r) => {
    let pane = null, box = r;
    for (let a = up(el); a && a !== document.body && a !== document.documentElement; a = up(a)) {
      const v = ancInfo(a);
      if (v.op) return true;
      const out = (v.cy && (box.bottom <= v.r.top || box.top >= v.r.bottom)) || (v.cx && (box.right <= v.r.left || box.left >= v.r.right));
      if (!out) continue;
      if (!pane && v.pane) { pane = a; box = v.r; continue; }
      return true;
    }
    return pane || false;
  };
  const paneCount = new Map();
  const paneOk = hb => { if (!hb) return true; const n = paneCount.get(hb) || 0; if (n >= 30) return false; paneCount.set(hb, n + 1); return true; };
  const base = new Set(document.querySelectorAll(sel)), extra = new Set();
  const shadowEls = [];
  for (const sr of shadowRoots) for (const e of sr.querySelectorAll(sel)) { base.add(e); shadowEls.push(e); }
  for (const el of document.querySelectorAll('div,span,li,img,label,p,td,i,svg,h2,h3,h4,dt,dd')) {
    if (base.has(el) || !(typeof el.onclick === 'function' || el.getAttribute('tabindex') === '0' || el.hasAttribute('phx-click') || el.hasAttribute('aria-haspopup')) || el.querySelector(sel)) continue;
    // inside a listed control: skip; inside another onclick element (a dropdown's list): the inner one wins
    let p = el.parentElement, nested = false;
    for (let k = 0; p && k < 4; k++, p = p.parentElement) {
      if (base.has(p)) { nested = true; break; }
      if (extra.has(p)) extra.delete(p);
    }
    if (!nested) extra.add(el);
  }
  // plain elements the layout paints with cursor: pointer (jQuery flyouts on Parkers)
  try {
    const ptr = window.__jb && __jb.pointerElements ? __jb.pointerElements() : [];
    for (const el of ptr) {
      if (base.has(el) || extra.has(el) || el.querySelector(sel)) continue;
      let p = el.parentElement, nested = false;
      for (let k = 0; p && k < 6; k++, p = p.parentElement) if (base.has(p) || extra.has(p)) { nested = true; break; }
      if (!nested) extra.add(el);
    }
  } catch (e) {}
  let all = [...base];
  if (extra.size) { all = []; for (const e of document.querySelectorAll('*')) if (base.has(e) || extra.has(e)) all.push(e); all.push(...shadowEls); }
  const farCands = [];
  const emit = (el, r, hb) => {
    const tag = el.tagName.toLowerCase();
    let label = clean(el.getAttribute('aria-label')) || clean(el.innerText || el.textContent);
    if (!label && el.labels && el.labels[0]) label = clean(el.labels[0].textContent);
    if (!label) label = clean(el.placeholder || el.title || el.alt || el.getAttribute('name'));
    if (!label) { const img = el.querySelector && el.querySelector('img[alt]'); if (img) label = clean(img.alt); }
    const rn = el.getRootNode ? el.getRootNode() : document;
    if (!label && el.id) { const l = (rn && rn.querySelector ? rn : document).querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) label = clean(l.textContent); }
    // a control inside a component: the component's own label (mds-slider slider-label="Age range")
    if (rn && rn.host && (!label || label.length < 3)) {
      const h = rn.host, hl = clean(h.getAttribute('aria-label') || h.getAttribute('label') || h.getAttribute('slider-label') || h.getAttribute('accessible-text') || h.getAttribute('placeholder') || '');
      if (hl) label = (hl + (label ? ' ' + label : '')).trim();
    }
    if (!label && extra.has(el) && el.parentElement) label = clean(el.parentElement.innerText || el.parentElement.textContent).slice(0, 90);
    const idx = BASE + out.length;
    marks.push([el, idx]);
    const o = {i: idx, tag, label: label.slice(0, 90)};
    const type = el.getAttribute('type') || el.getAttribute('role');
    if (type) o.type = type;
    if (tag === 'a') o.href = (el.getAttribute('href') || '').slice(0, 80);
    if ((tag === 'input' || tag === 'textarea') && el.value) o.value = String(el.value).slice(0, 60);
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) o.checked = !!el.checked;
    if (tag === 'input' && el.type === 'range') { o.min = el.min; o.max = el.max; }
    if (tag === 'select') o.options = [...el.options].slice(0, 15).map(x => clean(x.textContent).slice(0, 40));
    if (hb) o.in_pane = true;
    else if (r.top > H) o.below_fold = true;
    out.push(o);
  };
  for (const el of all) {
    if (out.length >= 150) break;
    let r; try { r = el.getBoundingClientRect(); } catch (e) { continue; }
    if (extra.has(el) && r && r.width >= W * 0.9 && r.height >= H * 0.5) continue;
    // custom-styled checkboxes/radios (opacity 0 or 1px, drawn by their label): use the label's box
    const box = el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio') && el.labels && el.labels[0];
    let cs = getComputedStyle(el);
    if (box && (cs.opacity === '0' || !r || r.width < 2 || r.height < 2)) {
      const lr = box.getBoundingClientRect(), ls = getComputedStyle(box);
      if (lr.width >= 2 && lr.height >= 2) { r = lr; cs = ls; }
    }
    if (!r || r.width < 2 || r.height < 2) continue;
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    if (r.bottom < -20 || r.top > H * 1.5) { if (farCands.length < 600) farCands.push([el, r]); continue; }
    const hb = hiddenByAncestor(el, r);
    if (hb === true || !paneOk(hb)) continue;
    emit(el, r, hb);
  }
  // controls far down (or up) an on-screen scroll pane
  for (const [el, r] of farCands) {
    if (out.length >= 150) break;
    let inPane = false;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const v = anc.get(a); if (v && v.pane) { inPane = true; break; } }
    if (!inPane) continue;
    const hb = hiddenByAncestor(el, r);
    if (!hb || hb === true || !paneOk(hb)) continue;
    emit(el, r, hb);
  }
  // script-clickable elements without a role: own click-type listeners, a React onClick prop or a
  // tabindex. Innermost candidates only (scanned bottom-up), none inside or around a listed element.
  const TAGS = new Set(['DIV', 'SPAN', 'LI', 'TD', 'TH', 'IMG', 'svg', 'I', 'P', 'LABEL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
                        'DT', 'DD', 'EM', 'STRONG', 'B', 'SECTION', 'ARTICLE', 'FIGURE', 'TR', 'UL', 'PICTURE']);
  const CLICK = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart'];
  const scripted = el => {
    const L = el._jbListeners;
    if (L) for (const t of CLICK) if (L[t] && L[t].length) return true;
    if (el.hasAttribute('tabindex') && el.tabIndex >= 0) return true;
    for (const k of Object.keys(el)) if (k.startsWith('__reactProps')) { const p = el[k]; return !!(p && (p.onClick || p.onMouseDown || p.onPointerDown || p.onMouseUp)); }
    return false;
  };
  const picked = [], listed = new Set(marks.map(m => m[0]));
  const aroundListed = new Set();
  for (const m of listed) for (let p = m.parentElement; p && !aroundListed.has(p); p = p.parentElement) aroundListed.add(p);
  const nearListed = el => {
    if (aroundListed.has(el)) return true;
    for (let p = el; p; p = p.parentElement) if (listed.has(p)) return true;
    return false;
  };
  if (out.length < 150) {
    const all = document.getElementsByTagName('*');
    for (let n = all.length - 1; n >= 0 && picked.length < 60; n--) {
      const el = all[n];
      if (!TAGS.has(el.tagName) || !scripted(el)) continue;
      if (el.querySelector('[data-jb-c]') || nearListed(el)) continue;
      let r; try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (!r || r.width < 2 || r.height < 2 || r.bottom < -20 || r.top > H * 1.5 || r.width * r.height > 400000) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      const hb = hiddenByAncestor(el, r);
      if (hb === true || !paneOk(hb)) continue;
      el.setAttribute('data-jb-c', '');
      picked.push([el, r, hb]);
    }
  }
  for (const [el, r, hb] of picked.reverse()) {
    el.removeAttribute('data-jb-c');
    if (out.length >= 150) continue;
    const label = clean(el.getAttribute('aria-label')) || clean(el.innerText || el.textContent) || clean(el.title || el.getAttribute('alt') || el.getAttribute('data-id') || '');
    const idx = BASE + out.length;
    marks.push([el, idx]);
    const o = {i: idx, tag: el.tagName.toLowerCase(), label: label.slice(0, 90), type: 'clickable'};
    if (hb) o.in_pane = true;
    else if (r.top > H) o.below_fold = true;
    out.push(o);
  }
  for (const [m, i] of marks) m.setAttribute('data-jb-idx', String(i));
  if (IN_FRAME) {
    let text = clean(document.body ? document.body.innerText : '');
    for (const sr of shadowRoots) {
      if (text.length >= 3000) break;
      const t = clean([...sr.children].filter(c => !/^(STYLE|SCRIPT|LINK)$/.test(c.tagName)).map(c => c.innerText || c.textContent).join(' '));
      if (t) text += ' | ' + t.slice(0, 300);
    }
    return {elements: out, text: text.slice(0, 3000)};
  }
  const frames = [];
  if (SELF) {
    for (const f of document.querySelectorAll('iframe,frame')) {
      if (out.length >= 220) break;
      let w = null, fr = null;
      try { w = f._contentWindow; fr = f.getBoundingClientRect(); } catch (e) { continue; }
      if (!w || !w.__jb || !w.document || !fr || fr.width < 60 || fr.height < 40 || fr.bottom < 0 || fr.top > H * 1.5) continue;
      const fs = getComputedStyle(f);
      if (fs.visibility === 'hidden' || fs.display === 'none' || hiddenByAncestor(f, fr)) continue;
      let sub = null;
      try { w.__jbObsBase = BASE + out.length; w.__jbObsInFrame = true; sub = w.eval(SELF); } catch (e) { sub = null; }
      try { w.__jbObsInFrame = false; w.__jbObsBase = 0; } catch (e) {}
      if (!sub || !sub.elements) continue;
      for (const e of sub.elements) { if (out.length >= 220) break; e.frame = true; if (fr.top + 20 > H) e.below_fold = true; out.push(e); }
      if (sub.text) frames.push({src: (f.getAttribute('src') || '').slice(0, 100), text: sub.text});
    }
  }
  const se = document.scrollingElement || document.documentElement;
  return {url: location.href, title: document.title, scroll_y: Math.round(window.scrollY || 0),
          page_height: Math.round(se ? se.scrollHeight : 0), viewport_h: H, elements: out, frames};
})()"""
_FRAME_SRC = _OBSERVE_SRC.replace("__OBS_SELF__", '""')
OBSERVE_JS = _OBSERVE_SRC.replace("__OBS_SELF__", json.dumps(_FRAME_SRC))


def _schema(props, req):
    return {"type": "object", "properties": props, "required": req, "additionalProperties": False}


INT = {"type": "integer"}
STR = {"type": "string"}
TOOLS = [
    {"name": "click", "description": "Click the element with this number.", "input_schema": _schema({"element": INT}, ["element"])},
    {"name": "type", "description": "Replace the text of an input/textarea with `text`; set submit=true to press Enter after.",
     "input_schema": _schema({"element": INT, "text": STR, "submit": {"type": "boolean"}}, ["element", "text", "submit"])},
    {"name": "select", "description": "Choose an option of a <select> by its visible text or value.",
     "input_schema": _schema({"element": INT, "option": STR}, ["element", "option"])},
    {"name": "click_at", "description": "Click at a point of the screenshot: x, y in CSS pixels from its top-left corner "
                                        "(the viewport is 1280x720). For things that have no element number: squares of a "
                                        "game board, points on a map or chart, parts of a canvas. double=true double-clicks "
                                        "(edit a text layer in a design/meme editor, select a word).",
     "input_schema": _schema({"x": INT, "y": INT, "double": {"type": "boolean"}}, ["x", "y"])},
    {"name": "keyboard_type", "description": "Type text with the keyboard into whatever has the focus (no element number "
                                             "needed): a text layer opened by double-clicking it on a canvas editor, a "
                                             "focused field inside a frame.",
     "input_schema": _schema({"text": STR}, ["text"])},
    {"name": "drag_at", "description": "Drag with the mouse from one point of the screenshot to another (x, y in CSS pixels): "
                                       "range-slider handles, sliders, maps, drag-and-drop without element numbers.",
     "input_schema": _schema({"x1": INT, "y1": INT, "x2": INT, "y2": INT}, ["x1", "y1", "x2", "y2"])},
    {"name": "upload", "description": "Attach a sample file to a file input (<input type=file>, or the button/label "
                                      "that opens one): photo.png (image), resume.pdf (PDF) or document.txt (text). "
                                      "Use it when a form needs a file and the user gave none.",
     "input_schema": _schema({"element": INT, "file": {"type": "string", "enum": ["photo.png", "resume.pdf", "document.txt"]}},
                             ["element", "file"])},
    {"name": "hover", "description": "Move the mouse over an element (opens hover menus).", "input_schema": _schema({"element": INT}, ["element"])},
    {"name": "press", "description": "Press a key at the focused element, e.g. Enter, Escape, Tab, ArrowDown.",
     "input_schema": _schema({"key": STR}, ["key"])},
    {"name": "scroll", "description": "Scroll the page up or down by about one screen.",
     "input_schema": _schema({"direction": {"type": "string", "enum": ["up", "down"]}}, ["direction"])},
    {"name": "goto", "description": "Navigate to a URL.", "input_schema": _schema({"url": STR}, ["url"])},
    {"name": "back", "description": "Go back to the previous page.", "input_schema": _schema({}, [])},
    {"name": "wait", "description": "Let the page run for a few seconds (1-10) when it is still loading: a spinner, "
                                    "skeleton, 'Loading...' text or a page about to redirect.",
     "input_schema": _schema({"seconds": INT}, ["seconds"])},
    {"name": "find", "description": "Find text on the page, like Ctrl+F: scrolls the first element containing `text` "
                                    "(case-insensitive; also matches labels, alt text and field values) into view and "
                                    "lists the matches. Calling it again with the same text moves to the next match. Use "
                                    "it for a button, link or section that is not in the element list (far down a long "
                                    "page, in the footer) instead of scrolling step by step.",
     "input_schema": _schema({"text": STR}, ["text"])},
    {"name": "read_page", "description": "Return the page's text as markdown, 8000 characters from `offset`.",
     "input_schema": _schema({"offset": INT}, ["offset"])},
    {"name": "finish", "description": "End the task. `answer` is the final answer or a summary of what was done; "
                                      "start it with 'BLOCKED:' if a bot check, CAPTCHA or required login stopped you.",
     "input_schema": _schema({"answer": STR}, ["answer"])},
]
KEEP_TAB_TOOL = {"name": "keep_tab", "description": "Keep the current page open as a browser tab (the task asks "
                                                 "to leave pages open in tabs). The page stays open as a tab, as it "
                                                 "looks now, while you go on browsing; give each kept tab's URL in your "
                                                 "answer. Keep only the pages the task asks for, once each.",
                 "input_schema": _schema({}, [])}
for _t in TOOLS + [KEEP_TAB_TOOL]:
    _t["strict"] = True

SYSTEM = """You operate a web browser to complete a task for a user on a live website.
After each action you get the new page state: URL, title, numbered interactive elements (in and just
below the viewport) and usually a screenshot. Refer to elements by number. Take one action per turn.

Rules:
- Work like a careful human: use the site's own search, filters and sort controls; check every
  requirement of the task (dates, quantities, ratings, locations, price limits) before finishing.
- Do not sign in, create accounts, enter payment details or complete purchases/bookings: stop at the
  last step before that and finish, describing where you stopped.
- If a bot check, CAPTCHA or login wall blocks you, finish immediately with "BLOCKED: <what you saw>".
  So does a rate limit (HTTP 429, "too many requests") that is still there after the harness waited.
  A sign-in prompt for the task's last action (save, add to list, checkout) is not a block: finish
  normally, naming the item and saying the site asks you to sign in for that step.
- Close cookie/consent banners and popups that cover the page.
- Elements marked "(in scroll pane)" are inside a scrollable list, sidebar or dialog, outside its
  visible part; clicking one scrolls it into view.
- Each observation includes the page text near the current scroll position; use read_page to read
  other parts of a long page.
- When the task asks for information, put the information itself in the finish answer.
- Every fact in your answer (a price, rating, engine, size, date, address) must come from a page you
  saw. When a results list does not show a detail, open the item's page and check it there.
- The task fails unless every requirement is met. If a control does not respond, try another route
  before giving up: the same control's other element (label, option text), the filter panel after
  scrolling it, the site's search or URL parameters, a different page of the site. Do not finish
  with a partial answer while you still have steps left.
- If the page is still loading (spinner, skeleton, "Loading..."), use wait instead of reloading.
- Canvas/design editors (meme makers, photo editors): add a text layer, double-click it on the canvas
  (click_at double=true) to edit it, select its old text (press Control+a) and keyboard_type the new text.
  Plan the whole edit first and go straight to the tools it needs (background/image, then text); do not
  open every panel to look around, and do not reload the editor to undo (use its delete/undo instead).
- If a results list shows a "From $X" price lower than the price you found on the item's page, check the
  item's dates/options list for that price (within the task's conditions) before finishing.
- When the task asks for a total (price, cost, fee), open the step where the site itself shows that total
  for the chosen option (booking/checkout summary, stopping before payment or personal details) instead
  of computing it yourself.
- When you pick an image for a subject (a frog, a dog), choose one where the subject is large and clearly
  recognizable, use the full-size image rather than a thumbnail, and keep added text from covering it.
- In an editor, an image meant as the background must cover the whole canvas: use the editor's background
  option for it (Background panel, "set as background", right-click menu), or select the image and drag a
  corner handle (drag_at) until it fills the canvas; check the screenshot shows no margin around it.
- When what you need to click has no element number (a chess square, a map, a canvas), use click_at
  with coordinates read off the screenshot.
- "Cheapest", "highest-rated", "most ...", "best-selling": read the actual value of every candidate
  (read_page or each item's page), compare them, and cite the numbers in your answer. A sort order alone
  is not proof; if the order looks inconsistent, check further.
- Before finish, go through each condition of the task (new/used, size, rating, distance, date, price
  range) and confirm it is applied in the URL, the active filters or the item itself.
- "Latest", "most recent", "yesterday", "within N days": read the date (and time) of each candidate on
  the page, compare it with today's date given above and cite it; when several share the latest day,
  compare their start or publish times before picking one.
- Never claim a state you did not see. After repeating an action (next arrow, scroll, click_at), check
  the screenshot or page text before saying where you ended up.
- Do not finish with a tentative or partial answer while more than half of your steps remain: break
  ties by opening the candidates, and go through lists that cannot be sorted.
- Navigate with the site's links, menus and search. After two guessed URLs return errors or 404, stop
  guessing URLs.
- Use only what the site shows, not your own memory; if the site lacks the information, say so.
- A button, link or section you expect but do not see in the element list (share buttons, footers, long
  pages): use find with its text instead of scrolling step by step.
- Time windows ("last week", "past 30 days", "this month"): compute the exact dates from today's date given
  with the task and apply exactly that range. "Latest", "newest", "most recent": sort by the date the task
  names (submitted, updated, created, released) and take the first item of that sort.
- If the site correctly answers that nothing matches (no results, "not found"), report exactly that
  together with the search/filters you used; that is a valid outcome.
- Do not click Cancel, Clear or Start over in a multi-step form unless you mean to.
- End on the page that shows the result, so the final screenshot proves the answer.
- When the task asks for details of one item (all locations, prices, specs), finish on that item's page
  showing them, not on a results list.
- If the task's conditions look contradictory or a requested category seems missing, search the site for
  a combined category or term (e.g. "Internal Medicine Pediatrics" for pediatricians specializing in
  internal medicine) before concluding.
- Range sliders: drag the handle with drag_at, or click the handle and press ArrowRight/ArrowLeft/End/
  Home. If the page URL or hash shows the filter (e.g. #duration=7-10), edit it directly with goto.
- An interstitial check ("Just a quick check", "Checking your browser"): wait once, then goto the same
  URL once; if it is still there, finish with "BLOCKED:".
- When a list shows "X of Y" results or has "Load more"/pagination, load or page through all of it before
  concluding that nothing matches.
- In app-like sites (single-page apps, setup flows), open items by clicking their tiles/links; typing a
  guessed URL can reset the app and lose your progress.
- Sort and filter links often hide options (time ranges like "last day / week / month", sub-categories)
  in a hover dropdown: hover the link and observe before clicking it.
- A transient site error ("Oops, something went wrong", "Something went wrong", "No results returned"
  next to a Reload button, an error page right after Search or Select): wait a few seconds and use the
  page's Reload/Try again; if it stays, goto the same URL for a fresh load, or go back and redo the step.
  Try this up to 3 times before reporting the error.
- Copy buttons (a share dialog's "Copy link"): click them; the action result reports the text the page
  copied to the clipboard. Print buttons: the action result reports the PDF the browser saved.
- A task to book or reserve ends at the last step before guest/personal or payment details: pick the
  specific option (room, flight, ticket) that meets every condition, press its Reserve/Select/Book
  button and finish on the details page that follows - not on a results list or a property page.
- "Hotel" in a task means the property type: apply the site's property-type filter (Hotels) when it has
  one, and do not answer with an apartment, hostel or guesthouse.
- When the task asks about the top N results (or several items), check each of the N on its own page or
  details before answering."""


def webvoyager(ctx):
    sites = {s.lower() for s in ctx.args.sites.split(",")} if ctx.args.sites else None
    items = data.webvoyager(ctx.limit or 60, ctx.seed, sites, ctx.args.shift_dates)
    out = _suite(ctx, items, "webvoyager", reference=True)
    if ctx.args.shift_dates:
        out["date_shifted_tasks"] = sum(1 for it in items if it.get("date_shift_years"))
    return out


def mind2web(ctx):
    items = data.mind2web(ctx.limit or 60, ctx.seed)
    return _suite(ctx, items, "mind2web", reference=False)


def bubench(ctx):
    cats = {s.lower() for s in ctx.args.sites.split(",")} if ctx.args.sites else None
    items = data.bubench(ctx.limit or 100, ctx.seed, cats)
    return _suite(ctx, items, "bubench", reference=True)


def odysseys(ctx):
    levels = set(ctx.args.sites.split(",")) if ctx.args.sites else None
    items = data.odysseys(ctx.limit or 50, ctx.seed, levels)
    return _suite(ctx, items, "odysseys", reference=False)


# Per-suite defaults when --max-steps / --task-timeout are not given (Odysseys tasks span several sites)
MAX_STEPS = {"odysseys": 100, "bubench": 50}
TASK_TIMEOUT = {"odysseys": 3600, "bubench": 1800}
ODYSSEYS_SHOTS = 10  # screenshots of distinct pages shown to the rubric judge


def _suite(ctx, items, label, reference):
    rows = run_items(ctx.run, items, lambda it: _task(ctx, it, label, reference), ctx.jobs, label)
    by_status = {}
    for r in rows:
        by_status[r.get("status", "error")] = by_status.get(r.get("status", "error"), 0) + 1
    out = {
        "items": len(rows),
        "success_pct": rate(r.get("success") for r in rows),
        "success_pct_excl_blocked": rate(r.get("success") for r in rows if r.get("status") != "blocked"),
        "statuses": by_status,
        "avg_steps": round(sum(r.get("steps", 0) for r in rows) / max(1, len(rows)), 1),
        "headline": ("task success rate (%)" if label == "webvoyager" else "success rate (%)",
                     rate(r.get("success") for r in rows)),
    }
    if label == "bubench":  # by source benchmark
        for name in sorted({r.get("category") for r in rows if r.get("category")}):
            sub = [r for r in rows if r.get("category") == name]
            out[f"success_pct_{name}"] = rate(r.get("success") for r in sub)
            out[f"items_{name}"] = len(sub)
    if label == "odysseys":  # perfect tasks (every rubric item met) + partial progress
        passed = sum(r.get("rubric_pass", 0) for r in rows)
        total = sum(r.get("rubric_total", 0) for r in rows)
        out["rubric_items_pass_pct"] = round(100.0 * passed / max(1, total), 1)
        out["rubric_task_avg_pct"] = round(100.0 * sum(r.get("rubric_pass", 0) / max(1, r.get("rubric_total", 0))
                                                       for r in rows) / max(1, len(rows)), 1)
        out["headline"] = ("perfect tasks (%)", out["success_pct"])
        out["headline2"] = ("rubric items passed (%)", out["rubric_items_pass_pct"])
        out["headline3"] = ("task-average rubric score (%)", out["rubric_task_avg_pct"])
    if label in ("mind2web", "odysseys"):  # by the dataset's difficulty level (easy / medium / hard)
        for name in ("easy", "medium", "hard"):
            sub = [r for r in rows if r.get("level") == name]
            out[f"success_pct_{name}"] = rate(r.get("success") for r in sub)
            out[f"items_{name}"] = len(sub)
    return out


def _task(ctx, it, label, reference):
    task_dir = ctx.run.dir / _safe_name(it["id"])
    traj = task_dir / "trajectory"
    traj.mkdir(parents=True, exist_ok=True)
    web = ctx.web
    # step 0: open the start page in a fresh browser with its own storage profile (tasks used to
    # share one localStorage/IndexedDB: a consent given in one task hid the banner in the next)
    profile = tempfile.mkdtemp(prefix="jb-task-")
    web.set_profile(profile)
    web.reset()
    try:
        return _run_task(ctx, it, label, reference, web, task_dir, traj)
    finally:
        web.reset()
        web.set_profile(None)
        shutil.rmtree(profile, ignore_errors=True)


def _run_task(ctx, it, label, reference, web, task_dir, traj):
    max_steps = ctx.args.max_steps or MAX_STEPS.get(label, 40)
    tools = TOOLS + [KEEP_TAB_TOOL] if label == "odysseys" else TOOLS
    if label == "mind2web" and it.get("reference_length"):  # ~3x the steps a human needed, at least 25, at most --max-steps
        max_steps = min(max_steps, max(25, 3 * it["reference_length"]))
    start = it.get("start_url") or f"https://lite.duckduckgo.com/lite/?q={quote_plus(it['task'][:400])}"
    deadline = time.time() + (ctx.args.task_timeout or TASK_TIMEOUT.get(label, 1500))
    history = []
    shots = []

    def record(action, status, thought, url, page_text=None, excerpt=None, elements=None):
        n = len(history)
        png = _shot(web)
        name = f"{n:04d}.png"
        if png:
            (traj / name).write_bytes(png)
            shots.append(png)
        step = {"step": n, "screenshot": name if png else None, "url": url, "action": action,
                "action_status": status, "thought": thought}
        if page_text:
            step["page_text"] = page_text
        if excerpt:
            step["page_excerpt"] = excerpt
        if elements:  # element labels shown with this step's observation (dropdown/store details often live only there)
            step["elements_text"] = " | ".join(e.get("label", "") for e in elements if e.get("label"))[:3000]
        history.append(step)
        return png

    timed_out = False
    _cooldown_wait(start, deadline)
    try:
        web.call(lambda b: b.open(start))
        err = None
    except (BrowserError, WebTimeout, RuntimeError) as e:
        err = str(e)
        timed_out = isinstance(e, WebTimeout)
    if timed_out:
        try:  # one retry with more time (slow start pages under load)
            web.call(lambda b: b.open(start), timeout_s=web.timeout_s * 2)
            err = None
        except (BrowserError, WebTimeout, RuntimeError) as e:
            err = str(e)
    obs = _observe(web)
    obs, rl_waits, _ = _rate_limit_backoff(web, obs, 0, deadline)
    png = record(f"page -> NAVIGATE -> {start}", None if not err else "FAILED", "Open the task's start page.", obs.get("url"),
                 excerpt=_excerpt(obs), elements=obs.get("elements"))
    today = time.strftime('%A, %B %d, %Y')
    messages = [{"role": "user", "content": [
        {"type": "text", "text": f"Task: {it['task']}\n\nToday is {today} (local time); "
                                 "dates like 'tomorrow' or 'next month' are relative to it.\n\n"
                                 + ("" if it.get("start_url") else "No start page was given; you start on a search engine.\n\n")
                                 + ("Where the task asks you to keep pages open in tabs, open each such page, let it "
                                    "show fully, and call keep_tab on it before moving on; give its URL in your answer. "
                                    "The task has several parts on different sites: if one site blocks you, say so "
                                    "for that part and carry on with the others instead of finishing with BLOCKED. "
                                    f"You have {max_steps} steps and a long task like this one is expected to use most "
                                    "of them: do every part before you finish.\n\n"
                                    if label == "odysseys" else "")
                                 + _obs_text(obs, err)},
        *_img(png, ctx.args.vision)]}]

    answer, status = None, "max-steps"
    last_url = None
    recent = []  # (action name, input) of the last actions
    pushbacks = 0  # hedged/incomplete early finishes sent back (once; Odysseys up to 3 times)
    max_pushbacks, min_left = (3, 15) if label == "odysseys" else (1, 6)
    while len(history) <= max_steps:
        if time.time() > deadline:
            status = "timeout"
            break
        resp = ctx.agent.create(system=SYSTEM, messages=messages, tools=tools, max_tokens=8000, cache=True,
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
        results = []
        done = False
        for i, u in enumerate(uses):
            if done or i > 0:  # one action per turn; answer extra calls without running them
                results.append({"type": "tool_result", "tool_use_id": u.id, "content": "Skipped: one action per turn.",
                                "is_error": True})
                continue
            if u.name == "finish" and pushbacks < max_pushbacks and max_steps - (len(history) - 1) >= min_left \
                    and not re.search(r"(^|\n)\s*\**BLOCKED\**:", u.input["answer"].strip(), re.I) \
                    and (HEDGE_RE.search(u.input["answer"]) or (label == "odysseys" and INCOMPLETE_RE.search(u.input["answer"]))):
                pushbacks += 1
                results.append({"type": "tool_result", "tool_use_id": u.id, "content":
                                f"You still have {max_steps - (len(history) - 1)} of {max_steps} steps and your answer says "
                                "something is unverified or not done. Use the steps: do the parts that are not done yet and "
                                "verify what is unverified (open the candidates, the item's page, the site's search/filters, "
                                "URL parameters, another site for a part whose site blocked you), then finish again. If the "
                                "sites really do not show it, finish again saying exactly that."})
                continue
            if u.name == "finish":
                answer = u.input["answer"]
                status = "blocked" if re.search(r"(^|\n)\s*\**BLOCKED\**:", answer.strip(), re.I) else "finished"
                results.append({"type": "tool_result", "tool_use_id": u.id, "content": "Task ended."})
                done = True
                continue
            resets = web.resets()
            if (obs.get("url") or "").startswith("http"):
                last_url = obs["url"]
            desc, ok, extra = _act(web, u.name, u.input, _label(obs, u.input), obs)
            if web.resets() > resets and last_url:
                # the action timed out and the browser was replaced (it starts on about:blank):
                # reload the page the agent was on instead of leaving it on an empty tab
                try:
                    web.call(lambda b: b.open(last_url))
                    note = f"The browser was restarted after the timeout and {last_url} was reloaded."
                except (BrowserError, WebTimeout, RuntimeError) as e:
                    note = f"The browser was restarted after the timeout; reloading {last_url} failed: {e}"
                desc, extra = f"{desc} ({note})", (extra + "\n" if extra else "") + note
            obs = _observe(web)
            obs, rl_waits, rl_note = _rate_limit_backoff(web, obs, rl_waits, deadline)
            if rl_note:
                desc, extra = f"{desc} ({rl_note})", (extra + "\n" if extra else "") + rl_note
            png = record(f"{desc} | {'SUCCESS' if ok else 'FAILED'}", "SUCCESS" if ok else "FAILED", thought, obs.get("url"),
                         page_text=extra if u.name == "read_page" and ok else None, excerpt=_excerpt(obs),
                         elements=obs.get("elements"))
            text = (extra + "\n\n" if extra else "") + _obs_text(obs, None if ok else desc) \
                + f"\n\n(Step {len(history) - 1} of {max_steps}.)" \
                + (f" Only {max_steps - (len(history) - 1)} steps left: do the remaining requirements with the fewest "
                   "actions, then finish." if 0 < max_steps - (len(history) - 1) <= 5 else "")
            recent.append((u.name, json.dumps(u.input, sort_keys=True)))
            if len(recent) >= 3 and len(set(recent[-3:])) == 1 and u.name != "read_page":
                text += ("\n\nNote: you have done exactly this action 3 times in a row. Check the screenshot and page "
                         "text to see whether anything changed; if not, try a different way.")
            results.append({"type": "tool_result", "tool_use_id": u.id,
                            # no is_error flag: the API rejects it next to an image; the text says it failed
                            "content": [{"type": "text", "text": text}, *_img(png, ctx.args.vision)]})
        messages.append({"role": "user", "content": results})
        if done:
            break

    if status == "max-steps" and answer is None and messages[-1]["role"] == "user" and time.time() < deadline:
        # out of steps without an answer: one forced finish with what the agent has seen (UPS had the
        # price and the comparison table and simply ran out of steps)
        messages[-1]["content"].append({"type": "text", "text": "You have used all your steps. Call finish now with your "
                                        "best answer from what you have seen; say plainly what you could not verify."})
        try:
            resp = ctx.agent.create(system=SYSTEM, messages=messages, tools=tools, max_tokens=4000, cache=True,
                                    tool_choice={"type": "tool", "name": "finish"})
            fin = next((b for b in resp.content if b.type == "tool_use" and b.name == "finish"), None)
            if fin:
                answer = fin.input.get("answer")
                if answer and re.search(r"(^|\n)\s*\**BLOCKED\**:", answer.strip(), re.I):
                    status = "blocked"
        except Exception:
            pass

    # page heuristic only when the agent gave no answer: a challenge page titled "Canvas CAPTCHA" is not a wall
    if status != "blocked" and not answer and _looks_blocked(obs):
        status = "blocked"

    ev = evidence_step(history, answer)
    ev_shot = []
    last_names = {h.get("screenshot") for h in history[-ctx.args.judge_shots:]}
    if ev and ev.get("screenshot") and ev["screenshot"] not in last_names and (traj / ev["screenshot"]).exists():
        ev_shot.append((ev["step"], "the step whose page text best matches the answer", (traj / ev["screenshot"]).read_bytes()))
    # answer facts no recorded text contains: the agent may have read them off a screenshot of a step whose
    # page text was not captured (a page opened in a new tab, an observation that failed)
    alltext = " ".join(t for h in history for t in (h.get("page_text"), h.get("page_excerpt"), h.get("elements_text")) if t)
    if any(f not in alltext for f in answer_facts(answer)):
        blind = [h for h in history if h.get("screenshot") and not (h.get("page_excerpt") or h.get("page_text"))
                 and h["screenshot"] not in last_names and (traj / h["screenshot"]).exists()]
        for h in blind[-2:]:
            ev_shot.append((h["step"], "a step whose page text was not captured; it may show facts used in the answer",
                            (traj / h["screenshot"]).read_bytes()))
    extra = {}
    if label == "odysseys":
        verdict = _judge_odysseys(ctx, it, answer, history, traj)
        extra = {"rubrics": verdict.pop("rubrics"), "rubric_pass": verdict["passed"], "rubric_total": verdict["total"]}
    else:
        verdict = judge_webtask(ctx.judge, it["task"], answer, history, shots[-ctx.args.judge_shots:],
                                it.get("reference") if reference else None, evidence_shot=ev_shot, today=today,
                                **({"reference_label": REFERENCE_TRUTH} if label == "bubench" else {}))
        # a stated answer equal to the ground truth is a success whatever the judge reasoned
        if label == "bubench" and not verdict["success"] and truth_match(answer, it.get("reference")):
            verdict["success"] = True
            verdict["reasoning"] = "The final answer states the ground truth exactly. (Judge said: " + verdict["reasoning"] + ")"
    if it.get("category"):
        extra["category"] = it["category"]
    if label == "mind2web":
        _write_m2w(task_dir, it, answer, history)
    (task_dir / "history.json").write_text(json.dumps(history, indent=1, ensure_ascii=False), encoding="utf-8")
    if it.get("task_original"):
        extra["task_original"] = it["task_original"]
    extra["run_date"] = today
    return {"task": it["task"], "start_url": start, "answer": answer, "steps": len(history) - 1,
            "reference_length": it.get("reference_length"), "level": it.get("level"), "final_url": obs.get("url"),
            "success": bool(verdict["success"]) and status != "blocked",
            "judge_reason": verdict["reasoning"], "key_points": verdict["key_points"],
            "status": status if status in ("blocked", "timeout", "max-steps", "refused")
            else ("success" if verdict["success"] else "fail"), **extra}


def _judge_odysseys(ctx, it, answer, history, traj):
    """Rubric grading: the last screenshot of each distinct page (the most recent ODYSSEYS_SHOTS), so
    pages the task asks to keep open as proof are visible even when the agent moved on."""
    last, kept = {}, {}
    for h in history:
        if h.get("screenshot") and (traj / h["screenshot"]).exists():
            key = (h.get("url") or "").split("#")[0]
            last[key] = h
            if str(h.get("action", "")).startswith("KEEP TAB OPEN"):
                kept[key] = h
    tabs = sorted(kept.values(), key=lambda h: h["step"])[-ODYSSEYS_SHOTS:]
    rest = [h for h in sorted(last.values(), key=lambda h: h["step"]) if h not in tabs]
    picked = sorted(tabs + rest[-max(0, ODYSSEYS_SHOTS - len(tabs)):] if len(tabs) < ODYSSEYS_SHOTS else tabs,
                    key=lambda h: h["step"])
    shots = [(h["step"], h.get("url"), (traj / h["screenshot"]).read_bytes()) for h in picked]
    rubrics = judge_rubrics(ctx.judge, it["task"], it["rubrics"], answer, history, shots,
                            kept_tabs=[(h["step"], h.get("url")) for h in sorted(kept.values(), key=lambda h: h["step"])])
    passed = sum(r["success"] for r in rubrics.values())
    return {"success": passed == len(rubrics), "passed": passed, "total": len(rubrics), "rubrics": rubrics, "key_points": list(rubrics),
            "reasoning": " | ".join(f"{k}: {'pass' if v['success'] else 'fail'} - {v['reasoning']}" for k, v in rubrics.items())}


def _label(obs, a):
    """The element an action targets, as `[N] <tag> 'label'`, from the observation the agent acted on."""
    if "element" not in a:
        return ""
    e = next((e for e in obs.get("elements", []) if e["i"] == a["element"]), None)
    return f"[{a['element']}] <{e['tag']}> {e['label'][:60]!r}" if e else f"[{a['element']}]"


# Re-find an element of the last observation after the page re-rendered it (React/Vue replace
# nodes, so the data-jb-idx attribute is gone): same tag and label among the same candidates.
REFIND_JS = r"""((tag, label, idx) => {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const lab = el => (clean(el.getAttribute('aria-label')) || clean(el.innerText || el.textContent) ||
    clean(el.placeholder || el.title || el.alt || el.getAttribute('name'))).slice(0, 90);
  const hits = [...document.querySelectorAll(tag)].filter(el => lab(el) === label);
  const vis = hits.filter(el => { const r = el.getBoundingClientRect(); return r.width >= 2 && r.height >= 2; });
  const el = (vis.length ? vis : hits)[0];
  if (!el) return false;
  for (const e of document.querySelectorAll('[data-jb-idx="' + idx + '"]')) e.removeAttribute('data-jb-idx');
  el.setAttribute('data-jb-idx', String(idx));
  return true;
})"""


# URLs of the windows the page (or its frames) opened with window.open / target=_blank
POPUPS_JS = r"""(() => {
  const out = [];
  const walk = (w, depth) => {
    try { for (const g of (w.__jb.auxiliaryWindows || [])) { let u = ''; try { u = g.closed ? '' : g.location.href; } catch (e) {} out.push(u); } } catch (e) {}
    if (depth < 3) { try { for (const f of w.__jb.frameWindows(w.document)) walk(f, depth + 1); } catch (e) {} }
  };
  walk(window, 0);
  return out;
})()"""


# Messages a page shows briefly ("Success! ... hidden after 3 seconds"): the engine's virtual clock runs
# such timers while the action settles, so the agent's next look never sees them. Record text that
# becomes visible during the action (all frames) and the page's alert()/confirm() dialogs.
TRANSIENT_START_JS = r"""(() => {
  const top = window;
  top.__jbTransient = [];
  top.__jbDialogSeen = [];
  // what the page copies to the clipboard during the action (Copy Link buttons) is reported back
  try { const tj = window.__jb && (__jb.topJb ? __jb.topJb() : __jb); top.__jbClipStart = [tj && tj.clipStore ? tj.clipStore.changeId : 0, tj ? tj.clipboard : undefined]; } catch (e) { top.__jbClipStart = null; }
  const walk = (w, depth) => {
    try {
      // the engine drains __jb.dialogs into each settle result, so wrap the dialog functions here
      if (!w.__jbDialogWrap) {
        w.__jbDialogWrap = true;
        for (const k of ['alert', 'confirm', 'prompt', 'print']) {
          const orig = w[k];
          w[k] = function (m) { try { if (top.__jbDialogSeen) top.__jbDialogSeen.push(k + ': ' + String(m)); } catch (e) {} return orig.apply(this, arguments); };
        }
      }
      if (!w.__jbTransObs) {
        const seen = (el) => {
          try {
            if (!el || el.nodeType !== 1 || !el.isConnected) return;
            // messages, not widgets: skip dropdowns, pickers, menus and anything holding controls
            if (el.closest('select,option,datalist,[role=listbox],[role=menu],[role=grid],[role=dialog] table') ||
                el.querySelector('select,option,input,textarea,button,table') || el.getElementsByTagName('*').length > 25) return;
            for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
              const cs = w.getComputedStyle(a);
              if (cs.display === 'none' || cs.visibility === 'hidden') return;
            }
            const s = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (s.length >= 3 && s.length <= 400 && top.__jbTransient && top.__jbTransient.indexOf(s) < 0) top.__jbTransient.push(s);
          } catch (e) {}
        };
        w.__jbTransObs = new w.MutationObserver((ms) => {
          if (!top.__jbTransient || top.__jbTransient.length > 30) return;
          for (const m of ms) {
            if (m.type === 'attributes') seen(m.target);
            else for (const n of m.addedNodes) seen(n.nodeType === 1 ? n : n.parentElement);
          }
        });
        w.__jbTransObs.observe(w.document, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
      }
    } catch (e) {}
    if (depth < 3) { try { for (const f of w.__jb.frameWindows(w.document)) walk(f, depth + 1); } catch (e) {} }
  };
  walk(window, 0);
  return true;
})()"""
TRANSIENT_END_JS = r"""(() => {
  const top = window, out = { gone: [], dialogs: [] };
  const texts = [];
  const walk = (w, depth) => {
    try { texts.push((w.document.body && w.document.body.innerText || '').replace(/\s+/g, ' ')); } catch (e) {}
    if (depth < 3) { try { for (const f of w.__jb.frameWindows(w.document)) walk(f, depth + 1); } catch (e) {} }
  };
  walk(window, 0);
  const now = texts.join(' ');
  // everything that appeared: a message still shown now can be hidden by a timer before the next look
  for (const s of top.__jbTransient || []) if (!out.gone.some(g => g.indexOf(s) >= 0 || s.indexOf(g) >= 0)) out.gone.push([s, now.indexOf(s) < 0]);
  out.dialogs = top.__jbDialogSeen || [];
  try {
    const tj = window.__jb && (__jb.topJb ? __jb.topJb() : __jb), st = top.__jbClipStart;
    if (tj && st) {
      const c = tj.clipStore;
      if (c && c.changeId !== st[0]) {
        const t = (c.items[0] || []).filter(r => r.type === 'text/plain')[0];
        if (t) out.clipboard = String(t.text);
      } else if (typeof tj.clipboard === 'string' && tj.clipboard !== st[1]) out.clipboard = tj.clipboard;
    }
  } catch (e) {}
  top.__jbTransient = null;
  top.__jbDialogSeen = null;
  top.__jbClipStart = null;
  return out;
})()"""
TRANSIENT_ACTIONS = {"click", "press", "type", "click_at", "keyboard_type", "select"}


def _transient_note(web):
    try:
        r = web.call(lambda b: b.eval(TRANSIENT_END_JS, settle=False), timeout_s=20, reset_on_timeout=False) or {}
    except (BrowserError, WebTimeout, RuntimeError):
        return ""
    parts = []
    dialogs = r.get("dialogs") or []
    if any(d.startswith("print:") for d in dialogs):
        # the page opened the print dialog: print to PDF, as "Save as PDF" in a desktop browser would
        path = Path(tempfile.gettempdir()) / f"jb-print-{int(time.time() * 1000)}.pdf"
        try:
            web.call(lambda b: b.pdf(path), timeout_s=60, reset_on_timeout=False)
            parts.append(f"The page opened the print dialog; the browser printed the page to PDF (Save as PDF): "
                         f"{path} ({path.stat().st_size} bytes).")
        except (BrowserError, WebTimeout, RuntimeError, OSError) as e:
            parts.append(f"The page opened the print dialog, but saving it as PDF failed: {e}")
    for d in [d for d in dialogs if not d.startswith("print:")][:3]:
        parts.append(f"The page showed a dialog ({d[:300]}); it was dismissed.")
    if r.get("clipboard"):
        parts.append(f"The page copied this text to the clipboard: {r['clipboard'][:1000]!r}")
    shown = [(s, hidden) for s, hidden in (r.get("gone") or []) if 8 <= len(s) <= 300][:3]
    if shown:
        parts.append("Text the page showed in response to the action (messages like this may hide themselves "
                     "after a few seconds): " + " | ".join(repr(s) + (" (already hidden again)" if hidden else "")
                                                              for s, hidden in shown))
    return " ".join(parts)


def _popups(web):
    try:
        return web.call(lambda b: b.eval(POPUPS_JS, settle=False), timeout_s=20, reset_on_timeout=False) or []
    except (BrowserError, WebTimeout, RuntimeError):
        return []


def _act(web, name, a, target="", obs=None):
    """Run one browser action. -> (description, ok, extra text for the agent)"""
    watch = name in TRANSIENT_ACTIONS
    if watch:
        try:
            web.call(lambda b: b.eval(TRANSIENT_START_JS, settle=False), timeout_s=20, reset_on_timeout=False)
        except (BrowserError, WebTimeout, RuntimeError):
            watch = False
    res = _act_once(web, name, a, target)
    if watch:
        extra = _transient_note(web)
        if extra:
            res = (res[0], res[1], (res[2] + " " + extra).strip())
    if not res[1] and "No element matches" in res[0] and obs and "element" in a:
        e = next((e for e in obs.get("elements", []) if e["i"] == a["element"]), None)
        if e and e.get("label"):
            try:
                found = web.call(lambda b: b.eval(f"{REFIND_JS}({json.dumps(e['tag'])}, {json.dumps(e['label'])}, {a['element']})", settle=False), timeout_s=20, reset_on_timeout=False)
            except (BrowserError, WebTimeout, RuntimeError):
                found = False
            if found:
                return _act_once(web, name, a, target)
    return res


def _act_once(web, name, a, target=""):
    sel = f'[data-jb-idx="{a["element"]}"]' if "element" in a else None
    target = target or (f"[{a['element']}]" if "element" in a else "")
    try:
        if name == "click":
            before = _popups(web)
            web.call(lambda b: b.click(sel))
            after = _popups(web)
            seen = list(before)
            opened = []
            for u in after:
                if u in seen:
                    seen.remove(u)
                elif u.startswith("http"):
                    opened.append(u)
            if opened:
                prev = web.call(lambda b: b.url, timeout_s=20)
                web.call(lambda b: b.open(opened[-1]))
                return (f"CLICK {target} (opened a new tab: {opened[-1]})", True,
                        f"The click opened {opened[-1]} in a new tab; the view now shows it (the previous page was {prev}).")
            return f"CLICK {target}", True, ""
        if name == "keep_tab":
            url = web.call(lambda b: b.url, timeout_s=20)
            return f"KEEP TAB OPEN {url}", True, f"{url} stays open as a tab."
        if name == "upload":
            path = str(ASSETS / a["file"])
            # styled uploads hide the <input type=file> behind a label/button/drop zone: find the input it opens
            found = web.call(lambda b: b.eval(UPLOAD_TARGET_JS % json.dumps(sel), settle=False), timeout_s=20)
            if not found:
                return f"UPLOAD {target} -> FAILED: no <input type=file> at or near that element", False, ""
            msg = web.call(lambda b: b.upload('[data-jb-upload="1"]', path))
            return f"UPLOAD {target} {a['file']}", True, msg if isinstance(msg, str) else ""
        if name == "type":
            text, kind = _date_value(web, sel, a["text"])
            if kind:
                # engines before dev220 type a date input one character at a time and leave it empty
                web.call(lambda b: b.eval(SET_VALUE_JS % (json.dumps(sel), json.dumps(text)), settle=False), timeout_s=20)
                note = _readback(web, sel, text, "type")
                return f"TYPE {target} {text!r}", True, note

            def go(b):
                try:
                    b.fill(sel, a["text"])
                except BrowserError:
                    b.click(sel)
                    b.keyboard_type(a["text"])
                if a.get("submit"):
                    b.press("Enter")
            web.call(go)
            note = _readback(web, sel, a["text"], "type") if not a.get("submit") else ""
            return f"TYPE {target} {a['text']!r}{' + ENTER' if a.get('submit') else ''}", True, note
        if name == "select":
            def pick(b):
                try:
                    b.select(sel, a["option"])
                except BrowserError as e:
                    # custom dropdowns (button/div listboxes): open it, then click the option by text
                    if "No option" not in str(e) or b.eval(f"document.querySelector({json.dumps(sel)})?.tagName", settle=False) == "SELECT":
                        raise
                    b.click(sel)
                    b.click(f"text={a['option']}")
            web.call(pick)
            note = _readback(web, sel, a["option"], "select")
            if note.startswith("FAILED"):
                return f"SELECT {target} {a['option']!r} -> {note}", False, ""
            return f"SELECT {target} {a['option']!r}", True, note
        if name == "click_at":
            x, y = int(a["x"]), int(a["y"])
            n = 2 if a.get("double") else 1
            msg = web.call(lambda b: b.click_at(x, y, count=n))
            return f"{'DOUBLE_' if n == 2 else ''}CLICK_AT ({x}, {y})", True, msg if isinstance(msg, str) else ""
        if name == "keyboard_type":
            msg = web.call(lambda b: b.keyboard_type(a["text"]))
            return f"KEYBOARD_TYPE {a['text']!r}", True, msg if isinstance(msg, str) else ""
        if name == "drag_at":
            x1, y1, x2, y2 = int(a["x1"]), int(a["y1"]), int(a["x2"]), int(a["y2"])
            msg = web.call(lambda b: b.drag_at(x1, y1, x2, y2))
            return f"DRAG_AT ({x1}, {y1}) -> ({x2}, {y2})", True, msg if isinstance(msg, str) else ""
        if name == "hover":
            web.call(lambda b: b.hover(sel))
            return f"HOVER {target}", True, ""
        if name == "press":
            web.call(lambda b: b.press(a["key"]))
            return f"PRESS {a['key']}", True, ""
        if name == "scroll":
            web.call(lambda b: b.scroll(a["direction"], 600))
            return f"SCROLL {a['direction'].upper()}", True, ""
        if name == "goto":
            web.call(lambda b: b.open(a["url"]))
            return f"GOTO {a['url']}", True, ""
        if name == "back":
            def back(b):
                r = b.command("back")
                if not r.get("ok"):
                    if "unknown command" not in (r.get("error") or ""):
                        raise BrowserError(r.get("error") or "back failed")
                    b.eval("history.back()")  # an older engine without the back command
            web.call(back)
            return "GO BACK", True, ""
        if name == "wait":
            secs = min(10, max(1, int(a.get("seconds") or 3)))
            web.call(lambda b: b.wait(secs * 1000))
            return f"WAIT {secs}s", True, ""
        if name == "find":
            r = web.call(lambda b: b.eval(f"({FIND_JS})({json.dumps(a['text'])})")) or {}
            if not r.get("count"):
                return f"FIND {a['text']!r} -> no match", False, f"No visible element contains {a['text']!r}."
            lines = "\n".join(f"  {i + 1}. {m}" for i, m in enumerate(r.get("matches") or []))
            return (f"FIND {a['text']!r} -> match {r.get('shown')} of {r['count']}", True,
                    f"{r['count']} match(es) for {a['text']!r}; match {r.get('shown')} is now scrolled into view "
                    f"(its element is in the list below):\n{lines}")
        if name == "read_page":
            off = max(0, a.get("offset") or 0)
            md = web.call(lambda b: b.read()) or ""
            chunk = md[off:off + 8000]
            return f"READ PAGE from {off}", True, f"[chars {off}-{off + len(chunk)} of {len(md)}]\n{chunk}"
        return f"unknown action {name}", False, ""
    except (BrowserError, WebTimeout, RuntimeError) as e:
        note = ""
        if "stream error received: unexpected internal error" in str(e):
            # HTTP/2 RST_STREAM INTERNAL_ERROR right after the request: Akamai Bot Manager's answer to
            # clients it scores as bots (Best Buy product pages and its /gateway/graphql API). It is
            # not a transient network error; retrying the same kind of URL fails the same way.
            note = ("The site's server refused this request (HTTP/2 stream reset by its bot protection). "
                    "Pages and data of this kind will keep failing; if the task needs them, finish with "
                    "BLOCKED: and say what you could and could not see.")
        return f"{name.upper()} {target or json.dumps(a)} -> error: {e}"[:400], False, note


# an Odysseys answer that stops before doing every part ("I stopped early", "not done", "only partly")
INCOMPLETE_RE = re.compile(r"\b(stopped|stopping|not (yet )?(complete|completed|finished|done)|incomplete|partly|partially|"
                           r"did not (get|finish|complete|create|check|reach|play|build|produce)|could not (finish|complete)|"
                           r"still missing|is missing|are missing|not created)\b", re.I)
HEDGE_RE = re.compile(r"\b(not (fully )?(verified|confirmed)|unverified|could not (confirm|verify)|couldn't (confirm|verify)|so far|partial|caveat)", re.I)


READBACK_JS = r"""((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  if (el.tagName === 'SELECT') { const o = el.options[el.selectedIndex]; return {kind: 'select', value: el.value, text: o ? o.textContent.trim() : ''}; }
  if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return {kind: 'input', value: String(el.value)};
  return null;
})"""


def _readback(web, sel, wanted, kind):
    """What the control shows after the action; a note (or 'FAILED ...') when it did not take the value."""
    try:
        r = web.call(lambda b: b.eval(f"{READBACK_JS}({json.dumps(sel)})", settle=False), timeout_s=20, reset_on_timeout=False)
    except (BrowserError, WebTimeout, RuntimeError):
        return ""
    if not isinstance(r, dict):
        return ""
    norm = lambda x: re.sub(r"\s+", " ", str(x or "")).strip().lower()
    w = norm(wanted)
    if r.get("kind") == "select":
        if w and w not in (norm(r.get("text")), norm(r.get("value"))) and w not in norm(r.get("text")):
            return f"FAILED: the select still shows {r.get('text')!r} (value {r.get('value')!r})"
        return ""
    v = norm(r.get("value"))
    if w and v != w:
        return f"Note: the field now shows {r.get('value')!r} (the page may have reformatted it or opened suggestions)."
    return ""


MD_EXCERPT_CHARS = 3000


def _excerpt(obs):
    """The step's page text for the judge: the markdown excerpt plus the text of visible frames
    (a quiz or form inside an iframe is otherwise missing from the evidence)."""
    frames = "".join(f"\n\n[frame {f.get('src')}]\n{(f.get('text') or '')[:1500]}" for f in obs.get("frames") or [])
    return ((obs.get("md_excerpt") or "") + frames) or None


def _observe(web):
    try:
        obs = web.call(lambda b: b.eval(OBSERVE_JS, settle=False), timeout_s=60, reset_on_timeout=False) or {}
    except (BrowserError, WebTimeout, RuntimeError) as e:
        # the element scan failed; the page text is still worth having (agent and judge evidence)
        obs = {"error": str(e)}
        try:
            obs["url"] = web.call(lambda b: b.url, timeout_s=20, reset_on_timeout=False)
        except (BrowserError, WebTimeout, RuntimeError):
            pass
    try:
        md = web.call(lambda b: b.read(), timeout_s=30, reset_on_timeout=False) or ""
    except (BrowserError, WebTimeout, RuntimeError):
        md = ""
    if md:
        # Markdown has no geometry: start the excerpt at the same fraction of the text as the
        # viewport is of the page, a little before it, so it covers roughly what is on screen.
        frac = (obs.get("scroll_y") or 0) / max(1, obs.get("page_height") or 1)
        start = max(0, min(int(frac * len(md)) - 300, len(md) - MD_EXCERPT_CHARS))
        start = md.rfind("\n", 0, start) + 1 if start else 0
        obs["md_excerpt"] = md[start:start + MD_EXCERPT_CHARS]
        obs["md_start"], obs["md_total"] = start, len(md)
    return obs


def _obs_text(obs, err):
    if obs.get("error"):
        out = f"Could not list the page's elements: {obs['error']}"
        if obs.get("url"):
            out = f"URL: {obs['url']}\n" + out
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


def _shot(web):
    try:
        return web.call(lambda b: b.screenshot(), timeout_s=30, reset_on_timeout=False)
    except (BrowserError, WebTimeout, RuntimeError):
        return None


def _img(png, vision):
    if not (png and vision):
        return []
    return [{"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                         "data": base64.standard_b64encode(png).decode()}}]


ASSETS = Path(__file__).resolve().parent.parent / "assets"
UPLOAD_TARGET_JS = r"""(() => {
  const roots = [document];
  const all = [];
  while (roots.length) {
    const r = roots.pop();
    for (const e of r.querySelectorAll("*")) { if (e.shadowRoot) roots.push(e.shadowRoot); }
    all.push(...r.querySelectorAll("input[type=file]"));
  }
  const find = (s) => { for (const r of [document, ...all.map(i => i.getRootNode())]) { const e = r.querySelector(s); if (e) return e; } return null; };
  for (const i of all) i.removeAttribute("data-jb-upload");
  let el = find(%s), hit = null;
  if (el) {
    if (el.localName === "input" && el.type === "file") hit = el;
    else if (el.control && el.control.type === "file") hit = el.control;
    for (let a = el, n = 0; !hit && a && n < 5; a = a.parentElement || (a.getRootNode() && a.getRootNode().host), n++) {
      const inner = all.filter(i => a.contains(i) || (a.shadowRoot && i.getRootNode() === a.shadowRoot));
      if (inner.length === 1) hit = inner[0];
    }
  }
  if (!hit && all.length === 1) hit = all[0];
  if (hit) hit.setAttribute("data-jb-upload", "1");
  return !!hit;
})()"""
_DATE_FORMATS = {"date": ["%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%m-%d-%Y", "%B %d, %Y", "%b %d, %Y", "%d %B %Y", "%d %b %Y"],
                 "month": ["%Y-%m", "%m/%Y", "%B %Y", "%b %Y"],
                 "datetime-local": ["%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M", "%m/%d/%Y %H:%M", "%m/%d/%Y %I:%M %p"],
                 "time": ["%H:%M", "%I:%M %p", "%I:%M%p", "%H:%M:%S"]}
_FIND_DEEP_JS = r"""const __find = (sel) => { const roots = [[document, 0]];
  while (roots.length) { const [r, d] = roots.pop(); const e = r.querySelector(sel); if (e) return e;
    for (const x of r.querySelectorAll("*")) { if (x.shadowRoot) roots.push([x.shadowRoot, d]);
      if (d < 3 && (x.localName === "iframe" || x.localName === "frame")) { try { if (x.contentDocument) roots.push([x.contentDocument, d + 1]); } catch (e) {} } } }
  return null; };"""
INPUT_TYPE_JS = "(() => { " + _FIND_DEEP_JS + r""" const e = __find(%s); return e && e.localName === "input" ? e.type : ""; })()"""
SET_VALUE_JS = "(() => { " + _FIND_DEEP_JS + r""" const e = __find(%s);
  if (!e) return false;
  const W = e.ownerDocument.defaultView || window;
  e.focus();
  Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, "value").set.call(e, %s);
  e.dispatchEvent(new W.Event("input", { bubbles: true, composed: true }));
  e.dispatchEvent(new W.Event("change", { bubbles: true }));
  e.blur();
  return e.value; })()"""
_DATE_OUT = {"date": "%Y-%m-%d", "month": "%Y-%m", "datetime-local": "%Y-%m-%dT%H:%M", "time": "%H:%M"}


def _date_value(web, sel, text):
    """<input type=date> and friends only accept their ISO form (a browser's date picker types segments);
    "01/15/1990" sets an empty value. Convert what the model types to the form the input accepts."""
    try:
        kind = web.call(lambda b: b.eval(INPUT_TYPE_JS % json.dumps(sel), settle=False), timeout_s=20)
    except Exception:
        return text, ""
    fmts = _DATE_FORMATS.get(kind or "")
    if not fmts:
        return text, ""
    import datetime
    s = text.strip()
    for f in fmts:
        try:
            return datetime.datetime.strptime(s, f).strftime(_DATE_OUT[kind]), kind
        except ValueError:
            pass
    return s, kind


# Ctrl+F: innermost visible elements whose text (or aria-label/placeholder/alt/title/value) contains the
# needle, in document order; each call with the same text moves to the next match and scrolls it into view
FIND_JS = r"""((needle) => {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const want = clean(needle).toLowerCase();
  if (!want) return {count: 0, matches: []};
  const own = el => (clean(el.getAttribute('aria-label')) + ' ' + clean(el.getAttribute('placeholder')) + ' ' +
                     clean(el.getAttribute('alt')) + ' ' + clean(el.getAttribute('title')) + ' ' +
                     ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? clean(el.value) : '')).toLowerCase();
  const hits = [];
  for (const el of document.querySelectorAll('body *')) {
    if (hits.length >= 200) break;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE|META|LINK)$/.test(el.tagName)) continue;
    const text = clean(el.textContent).toLowerCase(), attr = own(el);
    if (!text.includes(want) && !attr.includes(want)) continue;
    // innermost: skip an element whose child holds the match too (unless the match is in its own attributes)
    if (!attr.includes(want) && [...el.children].some(c => clean(c.textContent).toLowerCase().includes(want))) continue;
    let r; try { r = el.getBoundingClientRect(); } catch (e) { continue; }
    if (!r || (r.width < 1 && r.height < 1)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    hits.push(el);
  }
  const st = window.__jbFind && window.__jbFind.want === want ? window.__jbFind : {want, next: 0};
  if (!hits.length) { window.__jbFind = null; return {count: 0, matches: []}; }
  const idx = st.next % hits.length;
  st.next = idx + 1;
  window.__jbFind = st;
  try { hits[idx].scrollIntoView({block: 'center'}); } catch (e) {}
  const snip = e => {
    const t = clean(e.innerText || e.textContent), i = t.toLowerCase().indexOf(want);
    const s = i < 0 ? (clean(e.getAttribute('aria-label') || e.getAttribute('alt') || e.getAttribute('title') || e.value) || t).slice(0, 120)
                    : t.slice(Math.max(0, i - 50), i + want.length + 70);
    return '<' + e.tagName.toLowerCase() + '> ' + s;
  };
  return {count: hits.length, shown: idx + 1, matches: hits.slice(0, 8).map(snip)};
})"""


# HTTP 429 pages ("429 - Hugging Face: We had to rate limit your IP", "Too Many Requests")
RATE_LIMIT_TEXT = ("rate limit", "rate-limit", "ratelimit", "too many requests")
RATE_LIMIT_BACKOFF_S = 60  # first wait; the second is twice as long
RATE_LIMIT_COOLDOWN_S = 300  # a later task on the same host waits this long after a rate limit was seen
_host_cooldown = {}


def _host(url):
    from urllib.parse import urlparse
    h = (urlparse(url or "").hostname or "").lower()
    return h[4:] if h.startswith("www.") else h


def _rate_limited(obs):
    title = (obs.get("title") or "").lower()
    text = (obs.get("md_excerpt") or "")[:2500].lower()
    return ("429" in title or "too many requests" in title or
            ((obs.get("md_total") or 0) < 3000 and any(m in text for m in RATE_LIMIT_TEXT)))


def _cooldown_wait(url, deadline):
    """Before a task starts on a host that rate-limited an earlier task: wait out the cool-down."""
    left = _host_cooldown.get(_host(url), 0) - time.time()
    if left > 0:
        time.sleep(max(0, min(left, deadline - time.time() - 300)))


def _rate_limit_backoff(web, obs, waited, deadline):
    """A rate-limited page: wait (60 s, then 120 s) and reload it, like a person would, before the agent
    sees it. -> (obs, waited, note)"""
    note = ""
    while _rate_limited(obs) and waited < 2 and time.time() + RATE_LIMIT_BACKOFF_S * (waited + 1) < deadline - 120:
        url = obs.get("url")
        _host_cooldown[_host(url)] = time.time() + RATE_LIMIT_COOLDOWN_S
        if not (url or "").startswith("http"):
            break
        waited += 1
        time.sleep(RATE_LIMIT_BACKOFF_S * waited)
        try:
            web.call(lambda b: b.open(url))
        except (BrowserError, WebTimeout, RuntimeError):
            pass
        obs = _observe(web)
        note = (f"The site answered with a rate limit (HTTP 429); the harness waited and reloaded {url}"
                + (" and the page loaded." if not _rate_limited(obs) else "; it is still rate-limited."))
    if _rate_limited(obs):
        _host_cooldown[_host(obs.get("url"))] = time.time() + RATE_LIMIT_COOLDOWN_S
    return obs, waited, note


def _looks_blocked(obs):
    title = (obs.get("title") or "").lower()
    labels = " ".join(e["label"].lower() for e in obs.get("elements", [])[:20])
    url = (obs.get("url") or "").lower()
    text = (obs.get("md_excerpt") or "")[:3000].lower()
    return (any(m in title or m in labels for m in BLOCK_MARKERS) or any(m in url for m in BLOCK_URL_MARKERS)
            or (len(text) < 1500 and any(m in text for m in BLOCK_TEXT_MARKERS)))


def _write_m2w(task_dir, it, answer, history):
    out = {"schema_version": "online-mind2web-v2", "task": it["task"], "task_id": it["id"],
           "agent_final_answer": answer or "", "reference_length": it.get("reference_length"),
           "action_history": history}
    (task_dir / "result.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")


def _safe_name(s):
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in s)
