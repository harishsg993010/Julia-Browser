"""In-page JavaScript the agent runs through ``Browser.eval``: observation, find, re-find,
transient messages, uploads and date inputs."""

import json


# Numbered interactive elements in and near the viewport (also open shadow roots and visible
# same-origin frames), with the page's scroll state. Each element gets data-jb-idx=N.
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

# URLs of the windows the page (or its frames) opened with window.open / target=_blank.
POPUPS_JS = r"""(() => {
  const out = [];
  const walk = (w, depth) => {
    try { for (const g of (w.__jb.auxiliaryWindows || [])) { let u = ''; try { u = g.closed ? '' : g.location.href; } catch (e) {} out.push(u); } } catch (e) {}
    if (depth < 3) { try { for (const f of w.__jb.frameWindows(w.document)) walk(f, depth + 1); } catch (e) {} }
  };
  walk(window, 0);
  return out;
})()"""

# Messages a page shows briefly ("Saved!", hidden after 3 s), alert()/confirm() dialogs and
# clipboard writes during an action: recorded between TRANSIENT_START_JS and TRANSIENT_END_JS.
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

# What a field or <select> shows after typing / choosing.
READBACK_JS = r"""((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  if (el.tagName === 'SELECT') { const o = el.options[el.selectedIndex]; return {kind: 'select', value: el.value, text: o ? o.textContent.trim() : ''}; }
  if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return {kind: 'input', value: String(el.value)};
  return null;
})"""

# The <input type=file> a styled upload button, label or drop zone opens.
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

# <input type=date> and friends accept only their ISO form: formats a model may type.
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

# Ctrl+F: innermost visible elements containing the text; repeated calls move to the next match.
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
