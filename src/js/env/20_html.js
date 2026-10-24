// Part 3: HTML tokenizer/parser, serializer and CSS selector engine
// Elements serialized without contents or an end tag (HTML "serializes as void").
__jb.SERIALIZE_VOID = { area: 1, base: 1, basefont: 1, bgsound: 1, br: 1, col: 1, embed: 1, frame: 1, hr: 1, img: 1, input: 1, keygen: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };
__jb.VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };
__jb.RAW_TEXT = { script: 1, style: 1, textarea: 1, title: 1, xmp: 1 };
__jb.ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", laquo: "«", raquo: "»", times: "×", divide: "÷", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾", larr: "←", rarr: "→", uarr: "↑", darr: "↓", hearts: "♥", check: "✓", ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍", shy: "­" };
__jb.decodeEntities = function (s) {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g, function (m, e) {
    if (e.charAt(0) === "#") {
      var code = e.charAt(1).toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch (err) { return m; }
    }
    return __jb.ENTITIES.hasOwnProperty(e) ? __jb.ENTITIES[e] : m;
  });
};
__jb.ESCAPE_TEXT_RE = /[&<>\u00a0]/;
__jb.escapeText = function (s) { s = String(s); if (!__jb.ESCAPE_TEXT_RE.test(s)) return s; return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;"); };
__jb.layoutFormState = function (el) {
  var tag = el._tag;
  try {
    if (tag === "input") {
      var type = String(el.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return { skip: ["checked"], attrs: el.checked ? ' checked=""' : "", text: null };
      if (type === "file" || type === "image" || type === "hidden") return null;
      var v = String(el.value == null ? "" : el.value);
      if (type === "password") v = v.replace(/[^]/gu, "\u2022");
      // The layout engine draws no placeholder: an empty field shows it as its value, marked
      // data-jb-ph so ::placeholder rules (rewritten to [data-jb-ph]) style it
      var ph = v === "" && /^(text|search|email|tel|url|number|password)$/.test(type) ? el.getAttribute("placeholder") : null;
      if (ph) return { skip: ["value"], attrs: ' value="' + __jb.escapeAttr(ph.replace(/[\r\n]+/g, "")) + '" data-jb-ph=""', text: null };
      return { skip: ["value"], attrs: ' value="' + __jb.escapeAttr(v) + '"', text: null };
    }
    if (tag === "option") return { skip: ["selected"], attrs: el.selected ? ' selected=""' : "", text: null };
    // the layout engine paints a textarea's text from a value attribute, not its children
    if (tag === "textarea" && el.value === "" && el.getAttribute("placeholder")) { var tph = el.getAttribute("placeholder"); return { skip: ["value"], attrs: ' value="' + __jb.escapeAttr(tph) + '" data-jb-ph=""', text: String(tph).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }; }
    if (tag === "textarea") return { skip: ["value"], attrs: ' value="' + __jb.escapeAttr(el.value) + '"', text: (el.value.charAt(0) === "\n" ? "\n" : "") + String(el.value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") };
  } catch (e) {}
  return null;
};
// The document copy the engine renders as markdown (read()) gets the live state of form controls
// too: the selected option and typed text are properties, so the copy showed the default option
// (FedEx's country select read "Afghanistan" after United States was chosen) and empty fields.
__jb.syncFormState = function (el) {
  var tag = el._tag;
  try {
    if (tag === "option") return { skip: ["selected"], attrs: el.selected ? ' selected=""' : "", text: null };
    if (tag === "input") {
      var type = String(el.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return { skip: ["checked"], attrs: el.checked ? ' checked=""' : "", text: null };
      if (type === "file" || type === "image" || type === "hidden" || type === "password") return null;
      return { skip: ["value"], attrs: ' value="' + __jb.escapeAttr(String(el.value == null ? "" : el.value)) + '"', text: null };
    }
  } catch (e) {}
  return null;
};
// The attributes of `el` for the engine's document copy, with the live form state (see above).
__jb.syncAttrs = function (el) {
  var list = el._attrs.map(function (a) { return a._ns === null ? [__jb.attrQualifiedName(el, a), a._value] : [__jb.attrQualifiedName(el, a), a._value, a._ns]; });
  if (__jb.wptMode || el._ns !== __jb.HTML_NS || (el._tag !== "option" && el._tag !== "input")) return list;
  var st = __jb.syncFormState(el);
  if (!st) return list;
  list = list.filter(function (p) { return p.length > 2 || st.skip.indexOf(p[0]) < 0; });
  if (el._tag === "option" || (el._tag === "input" && st.skip[0] === "checked")) { if (st.attrs) list.push([st.skip[0], ""]); }
  else list.push(["value", String(el.value == null ? "" : el.value)]);
  return list;
};
// fast path: most values need no escaping (the serializer runs over the whole page per relayout)
__jb.ESCAPE_ATTR_RE = /[&"<>\u00a0]/;
__jb.escapeAttr = function (s) { s = String(s); if (!__jb.ESCAPE_ATTR_RE.test(s)) return s; return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/ /g, "&nbsp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };

// Elements that auto-close a currently open element of the same "family".
__jb.AUTO_CLOSE = { p: { p: 1, div: 1, ul: 1, ol: 1, table: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, pre: 1, blockquote: 1, section: 1, article: 1, header: 1, footer: 1, nav: 1, aside: 1, form: 1, hr: 1, address: 1, fieldset: 1, figure: 1, main: 1 }, li: { li: 1 }, dt: { dt: 1, dd: 1 }, dd: { dt: 1, dd: 1 }, tr: { tr: 1 }, td: { td: 1, th: 1, tr: 1 }, th: { td: 1, th: 1, tr: 1 }, option: { option: 1, optgroup: 1 }, thead: { tbody: 1, tfoot: 1 }, tbody: { tbody: 1, tfoot: 1 } };

// Parse an HTML fragment into children of `parent` (a Node in `doc`).
__jb.parseHTML = function (html, doc, parent) {
  html = String(html);
  var stack = [parent];
  var pos = 0, len = html.length;
  function top() { return stack[stack.length - 1]; }
  function appendText(t) { if (t) top()._appendChildRaw(doc.createTextNode(__jb.decodeEntities(t))); }
  while (pos < len) {
    var lt = html.indexOf("<", pos);
    if (lt < 0) { appendText(html.slice(pos)); break; }
    if (lt > pos) appendText(html.slice(pos, lt));
    pos = lt;
    if (html.startsWith("<!--", pos)) {
      var end = html.indexOf("-->", pos + 4);
      var body = end < 0 ? html.slice(pos + 4) : html.slice(pos + 4, end);
      top()._appendChildRaw(doc.createComment(body));
      pos = end < 0 ? len : end + 3;
      continue;
    }
    if (html.startsWith("<!", pos) || html.startsWith("<?", pos)) {
      var e2 = html.indexOf(">", pos);
      if (/^<!doctype/i.test(html.slice(pos, pos + 9)) && parent.nodeType === 9 && !doc.doctype) { var dtm = /^<!doctype\s+([^\s>]+)/i.exec(html.slice(pos, e2 < 0 ? len : e2)); var dtn = new DocumentType(dtm ? dtm[1].toLowerCase() : "html", "", ""); dtn._doc = doc; doc._appendChildRaw(dtn); }
      pos = e2 < 0 ? len : e2 + 1;
      continue;
    }
    if (html.charAt(pos + 1) === "/") {
      var e3 = html.indexOf(">", pos);
      var name = html.slice(pos + 2, e3 < 0 ? len : e3).trim().toLowerCase().split(/\s/)[0];
      pos = e3 < 0 ? len : e3 + 1;
      for (var i = stack.length - 1; i > 0; i--) {
        if (stack[i]._tag === name) { stack.length = i; break; }
      }
      continue;
    }
    // start tag
    var m = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(pos, pos + 200));
    if (!m) { appendText("<"); pos++; continue; }
    var tag = m[1].toLowerCase();
    var p = pos + m[0].length;
    var attrs = [];
    var selfClosing = false;
    while (p < len) {
      while (p < len && /\s/.test(html.charAt(p))) p++;
      var ch = html.charAt(p);
      if (ch === ">") { p++; break; }
      if (ch === "/") { selfClosing = true; p++; continue; }
      var am = /^([^\s=/>"']+)/.exec(html.slice(p, p + 500));
      if (!am) { p++; continue; }
      var aname = am[1].toLowerCase(); p += am[0].length;
      var q = p; while (q < len && /\s/.test(html.charAt(q))) q++;
      var value = "";
      if (html.charAt(q) === "=") {
        q++; while (q < len && /\s/.test(html.charAt(q))) q++;
        var qc = html.charAt(q);
        if (qc === '"' || qc === "'") {
          var qe = html.indexOf(qc, q + 1);
          value = qe < 0 ? html.slice(q + 1) : html.slice(q + 1, qe);
          p = qe < 0 ? len : qe + 1;
        } else {
          var vm = /^[^\s>]*/.exec(html.slice(q));
          value = vm[0]; p = q + vm[0].length;
        }
        value = __jb.decodeEntities(value);
      }
      attrs.push([aname, value]);
    }
    pos = p;
    // implicit closes
    for (var s = stack.length - 1; s > 0; s--) {
      var open = stack[s]._tag;
      if (__jb.AUTO_CLOSE[open] && __jb.AUTO_CLOSE[open][tag]) { stack.length = s; break; }
      if (open === "td" || open === "th" || open === "table" || open === "caption" || open === "template" || open === "body" || open === "html" || open === "select") break;
      if (tag === "li" && (open === "ul" || open === "ol")) break;
      if ((tag === "dt" || tag === "dd") && open === "dl") break;
      if ((tag === "tr" || tag === "tbody" || tag === "thead" || tag === "tfoot") && (open === "tbody" || open === "thead" || open === "tfoot")) break;
    }
    var el = __jb.createElementInternal(doc, tag, __jb.HTML_NS, null, null, true);
    for (var a = 0; a < attrs.length; a++) el._setAttrRaw(attrs[a][0], attrs[a][1]);
    top()._appendChildRaw(el);
    // Parser insertion of images: the source is set at creation, so the update runs from here.
    if (typeof __jb.imageTreeMutation === "function" && el._ns === __jb.HTML_NS) { if (el._tag === "img") __jb.scheduleImageUpdate(el); else if (el._tag === "source") __jb.imageTreeMutation(el, el.parentNode); }
    if (__jb.VOID[tag] || selfClosing) continue;
    if (__jb.RAW_TEXT[tag]) {
      var re = new RegExp("</" + tag + "\\s*>", "i");
      var rest = html.slice(pos);
      var rm = re.exec(rest);
      var raw = rm ? rest.slice(0, rm.index) : rest;
      if (raw) el._appendChildRaw(doc.createTextNode(tag === "textarea" || tag === "title" ? __jb.decodeEntities(raw) : raw));
      pos = rm ? pos + rm.index + rm[0].length : len;
      continue;
    }
    stack.push(el);
  }
};

__jb.serializeNode = function (node, includeShadow, xml) {
  switch (node.nodeType) {
    case 3: case 4: {
      var p = node.parentNode;
      if (!xml && p && p.nodeType === 1 && p._ns === __jb.HTML_NS && /^(script|style|xmp|iframe|noembed|noframes|plaintext|noscript)$/.test(p._tag) && (p._tag !== "noscript" || (p.ownerDocument && p.ownerDocument.defaultView))) return node.data;
      if (xml && node.nodeType === 4) return "<![CDATA[" + node.data + "]]>";
      return xml ? node.data.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : __jb.escapeText(node.data);
    }
    case 8: return "<!--" + node.data + "-->";
    case 7: return "<?" + node.target + " " + node.data + "?>";
    case 10: return xml ? "<!DOCTYPE " + node.name + (node.publicId ? ' PUBLIC "' + node.publicId + '"' : "") + (node.systemId ? (node.publicId ? ' "' : ' SYSTEM "') + node.systemId + '"' : "") + ">" : "<!DOCTYPE " + node.name + ">";
    case 9: case 11: return __jb.serializeChildren(node, includeShadow, xml);
    case 2: return "";
    case 1: {
      var qn = xml ? __jb.qualifiedName(node) : (node._ns === __jb.HTML_NS || node._ns === __jb.SVG_NS || node._ns === __jb.MATHML_NS ? node._local : __jb.qualifiedName(node));
      var out = "<" + qn;
      if (xml) {
        var needsXmlns = node._ns !== null && (!node.parentNode || node.parentNode.nodeType !== 1 || node.parentNode._ns !== node._ns) && !node._attrs.some(function (a) { return a._ns === __jb.XMLNS_NS && ((node._prefix === null && a._local === "xmlns") || (node._prefix !== null && a._local === node._prefix)); });
        if (needsXmlns) out += node._prefix === null ? ' xmlns="' + __jb.escapeAttr(node._ns) + '"' : ' xmlns:' + node._prefix + '="' + __jb.escapeAttr(node._ns) + '"';
      }
      // Layout/mirror serialization carries the top-layer state as synthetic attributes (see JB_UA_CSS).
      var imgSrc = null;
      if (includeShadow && !xml && node._ns === __jb.HTML_NS) {
        if (node._popoverState === "showing") out += ' jb-open=""'; if (node._tag === "dialog" && node._modal) out += ' jb-modal=""';
        if (node._tag === "img" && node._img && node._img.animated && node._img.state === "completely available") out += ' jb-animated-image=""';
        if (node._tag === "img" && node._img && node._img.currentSrc) { imgSrc = node._img.currentSrc; out += ' src="' + __jb.escapeAttr(imgSrc) + '"'; if (node._img.density && node._img.density !== 1 && node._img.naturalWidth && !node.hasAttribute("width") && !node.hasAttribute("height")) out += ' width="' + Math.round(node._img.naturalWidth / node._img.density) + '" height="' + Math.round(node._img.naturalHeight / node._img.density) + '"'; }
      }
      // The layout mirror paints form controls from markup: carry their live state (typed value,
      // checkedness, selectedness) instead of the content attributes.
      var formState = __jb.serializeWithIds && includeShadow === true && !xml && node._ns === __jb.HTML_NS ? __jb.layoutFormState(node)
        : __jb.serializeForSync && includeShadow === true && !xml && node._ns === __jb.HTML_NS ? __jb.syncFormState(node) : null;
      // A drawn canvas reaches the layout mirror as its bitmap painted over the content box.
      var canvasPaint = __jb.serializeWithIds && includeShadow === true && !xml && node._tag === "canvas" && node._ns === __jb.HTML_NS && node._canvasId && typeof __jb.canvasLayoutPaint === "function" ? __jb.canvasLayoutPaint(node) : null;
      for (var i = 0; i < node._attrs.length; i++) {
        if (imgSrc !== null && node._attrs[i]._ns === null && node._attrs[i]._local === "src") continue;
        if (formState && node._attrs[i]._ns === null && formState.skip.indexOf(node._attrs[i]._local) >= 0) continue;
        var a = node._attrs[i];
        var an;
        if (a._ns === __jb.XML_NS) an = "xml:" + a._local;
        else if (a._ns === __jb.XMLNS_NS) an = a._prefix === null && a._local === "xmlns" ? "xmlns" : "xmlns:" + a._local;
        else if (a._ns === __jb.XLINK_NS) an = "xlink:" + a._local;
        else if (a._ns !== null && a._prefix !== null) an = a._prefix + ":" + a._local;
        else an = a._local;
        if (canvasPaint !== null && a._ns === null && a._local === "style") { out += ' style="' + __jb.escapeAttr(a._value + ";" + canvasPaint) + '"'; canvasPaint = ""; continue; }
        out += " " + an + '="' + __jb.escapeAttr(a._value) + '"';
      }
      if (canvasPaint) out += ' style="' + canvasPaint + '"';
      if (formState) out += formState.attrs;
      if (__jb.serializeWithIds && node.__jbid !== undefined) { out += ' data-jb="' + node.__jbid + '"'; if (!__jb.ceDefined(node)) out += ' data-jbu=""'; }
      if (__jb.layoutHover && includeShadow === true && __jb.layoutHover.has(node)) out += ' data-jbhv=""';
      // SVG presentation attributes reach the layout as zero-specificity author rules (see exportLayoutHtml).
      if (includeShadow === true && !xml && (node._ns === __jb.SVG_NS || (node._ns === __jb.MATHML_NS && __jb.mathmlPresentationDecls)) && __jb.layoutPresRules) {
        var decls = node._ns === __jb.SVG_NS ? __jb.svgPresentationDecls(node) : __jb.mathmlPresentationDecls(node);
        if (decls) {
          var pid = __jb.layoutPresIds ? __jb.layoutPresIds.get(decls) : undefined;
          // one attribute name per rule: Stylo buckets rules by attribute name, so a shared
          // data-jbp="N" made every SVG element test every presentation rule (Tumblr: 2,925 rules
          // x 4,695 elements, a 15 s first layout)
          if (pid === undefined) { pid = __jb.layoutPresRules.length; __jb.layoutPresRules.push(":where([data-jbp-" + pid + "]){" + decls + "}"); if (__jb.layoutPresIds) __jb.layoutPresIds.set(decls, pid); }
          out += " data-jbp-" + pid + '=""';
        }
      }
      if (includeShadow === true && !xml) {
        // shadow scoping markers for the flattened layout tree (see 21_scopecss.js)
        if (__jb.layoutScope !== null) out += ' data-jbs="' + __jb.layoutScope + '"';
        if (__jb.layoutSlottedTop === node) out += ' data-jbsl="' + __jb.layoutSlotted + '"';
        if (node._shadowRoot) out += ' data-jbh="' + __jb.shadowScopeFor(node._shadowRoot) + '"';
      }
      if (xml && !node.firstChild && !(node._tag === "template" && node._content && node._content.firstChild)) return out + "/>";
      out += ">";
      if (!xml && node._ns === __jb.HTML_NS && __jb.SERIALIZE_VOID[node._tag]) return out;
      if (formState && formState.text !== null) return out + formState.text + "</textarea>";
      // Layout mirror, real pages: an SVG sprite (only <symbol>/<defs> children) paints nothing by
      // itself, and the layout engine renders each inline <svg> on its own, so <use> elsewhere
      // cannot reach it either. Its content is left out (FedEx's 1.4 MB sprite made every layout
      // build 6-11 s).
      if (includeShadow === true && !xml && __jb.serializeWithIds && !__jb.wptMode && node._ns === __jb.SVG_NS && node.localName === "svg" && __jb.isSvgSprite(node)) return out + "</" + qn + ">";
      // The HTML serializer no longer re-adds the newline the parser drops; the layout mirror still needs it.
      if (includeShadow && !xml && node._ns === __jb.HTML_NS && /^(pre|textarea|listing)$/.test(node._tag) && node.firstChild && node.firstChild.nodeType === 3 && node.firstChild.data.charAt(0) === "\n") out += "\n";
      out += __jb.serializeShadowRoot(node, includeShadow, xml);
      if (node._tag === "template" && node._ns === __jb.HTML_NS && node._content) out += __jb.serializeChildren(node._content, includeShadow, xml);
      if (includeShadow === true && !xml) {
        // Layout mirror = the flat tree: a host renders only its shadow tree, whose slots render
        // their assigned nodes (or their own children as fallback).
        var cssomText = node._tag === "style" && node._ns === __jb.HTML_NS && node._sheet && node._sheet._cssomModified ? __jb.sheetText(node._sheet) : null; // rules added through the CSSOM
        // <style media> / disabled sheets: the layout engine ignores both, so the mirror wraps the
        // CSS in @media or leaves it out.
        var styleMedia = node._tag === "style" && node._ns === __jb.HTML_NS ? node.getAttribute("media") : null;
        var styleOff = node._tag === "style" && node._ns === __jb.HTML_NS && ((node._sheet && node._sheet.disabled === true) || node.disabled === true);
        if (styleOff) { /* disabled style sheet */ }
        else if (styleMedia !== null && styleMedia.trim() !== "" && !/^\s*all\s*$/i.test(styleMedia)) {
          var mediaCss = cssomText !== null ? cssomText : __jb.childTextContent(node);
          if (__jb.layoutScope !== null) mediaCss = __jb.scopeCss(mediaCss, __jb.layoutScope);
          mediaCss = "@media " + (/[{};]/.test(styleMedia) ? "not all" : styleMedia) + " {\n" + mediaCss + "\n}";
          out += __jb.layoutScope !== null ? __jb.layoutOnceCss(mediaCss) : mediaCss;
        }
        else if (node._tag === "style" && node._ns === __jb.HTML_NS && __jb.layoutScope !== null) out += __jb.layoutOnceCss(__jb.scopeCss(cssomText !== null ? cssomText : __jb.childTextContent(node), __jb.layoutScope));
        else if (cssomText !== null) out += cssomText;
        // element children of a <style> (innerText line breaks are <br>s) are not part of its CSS
        else if (node._tag === "style" && node._ns === __jb.HTML_NS && node.firstElementChild) out += __jb.childTextContent(node).replace(/<\/style/gi, "<\\/style");
        else if (node._shadowRoot) { /* light children appear through slots */ }
        else if (node._tag === "slot" && node._ns === __jb.HTML_NS && typeof node.assignedNodes === "function" && node.getRootNode()._host) {
          var assigned = node.assignedNodes();
          if (assigned.length) {
            // assigned nodes belong to the host's tree; their top elements are marked as slotted here
            var sroot = node.getRootNode(), keepScope = __jb.layoutScope, keepSl = __jb.layoutSlotted, keepTop = __jb.layoutSlottedTop;
            __jb.layoutScope = sroot._jbOuter === undefined ? null : sroot._jbOuter;
            for (var ai = 0; ai < assigned.length; ai++) { __jb.layoutSlotted = sroot._jbScope; __jb.layoutSlottedTop = assigned[ai]; out += __jb.serializeNode(assigned[ai], includeShadow, xml); }
            __jb.layoutScope = keepScope; __jb.layoutSlotted = keepSl; __jb.layoutSlottedTop = keepTop;
          }
          else out += __jb.serializeChildren(node, includeShadow, xml);
        } else out += __jb.serializeChildren(node, includeShadow, xml);
      } else out += __jb.serializeChildren(node, includeShadow, xml);
      return out + "</" + qn + ">";
    }
    default: return "";
  }
};
// The declarative form of `node`'s shadow root when the serialization
// options ask for it (getHTML's serializableShadowRoots / shadowRoots).
__jb.serializeShadowRoot = function (node, includeShadow, xml) {
  var sr = node._shadowRoot;
  if (!sr || !includeShadow) return "";
  if (typeof includeShadow === "object") {
    if (!((includeShadow.serializable && sr.serializable) || includeShadow.roots.indexOf(sr) >= 0)) return "";
    return '<template shadowrootmode="' + sr.mode + '"' + (sr.delegatesFocus ? ' shadowrootdelegatesfocus=""' : "") + (sr.serializable ? ' shadowrootserializable=""' : "") + (sr.clonable ? ' shadowrootclonable=""' : "") + ">" + __jb.serializeChildren(sr, includeShadow, xml) + "</template>";
  }
  if (includeShadow !== true) return "";
  __jb.shadowScopeFor(sr);
  var outer = __jb.layoutScope;
  sr._jbOuter = outer;
  __jb.layoutScope = sr._jbScope;
  try {
    var adopted = (sr.adoptedStyleSheets || []).map(__jb.sheetText).join("\n");
    var adoptedCss = adopted ? __jb.layoutOnceCss(__jb.scopeCss(adopted, sr._jbScope)) : "";
    return (adoptedCss ? "<style>" + adoptedCss + "</style>" : "") + __jb.serializeChildren(sr, includeShadow, xml);
  } finally { __jb.layoutScope = outer; }
};
// Layout scope id of a shadow root. Real pages: roots whose style sheets are identical (every
// instance of one component) share an id, so their scoped CSS is the same text and is emitted once
// per export (layoutOnceCss); per-root ids made each instance carry its own copy of the component CSS.
__jb.shadowScopeFor = function (sr) {
  if (__jb.wptMode || !__jb.serializeWithIds) { if (sr._jbScope === undefined) sr._jbScope = ++__jb.layoutScopeSeq; return sr._jbScope; }
  if (sr._jbScope !== undefined && sr._jbSigVer === __jb.domVersion && sr._jbSigExport === __jb.layoutExportSeq) return sr._jbScope;
  var sig = (sr.adoptedStyleSheets || []).map(__jb.sheetText).join("\n") + "\u0001";
  var styles = sr.querySelectorAll("style");
  for (var i = 0; i < styles.length; i++) {
    var st = styles[i];
    sig += (st.getAttribute("media") || "") + "\u0002" + ((st._sheet && st._sheet.disabled === true) || st.disabled === true ? "off" : "") + "\u0002" + (st._sheet && st._sheet._cssomModified ? __jb.sheetText(st._sheet) : st.textContent) + "\u0003";
  }
  var map = __jb.layoutSigScopes || (__jb.layoutSigScopes = new Map());
  var id = map.get(sig);
  if (id === undefined) { if (map.size > 4000) map.clear(); id = ++__jb.layoutScopeSeq; map.set(sig, id); }
  sr._jbScope = id; sr._jbSigVer = __jb.domVersion; sr._jbSigExport = __jb.layoutExportSeq;
  return id;
};
// Scoped CSS emitted at most once per layout export (real pages; see shadowScopeFor).
__jb.layoutOnceCss = function (css) {
  var seen = __jb.layoutEmittedCss;
  if (!seen || !css) return css;
  if (seen.has(css)) return "";
  seen.add(css);
  return css;
};
// CSS text of a style sheet's rules (CSSOM-built sheets have no source text).
__jb.sheetText = function (sheet) {
  try { return __jb.A.map.call(sheet.cssRules || [], function (r) { return r.cssText || ""; }).join("\n").replace(/<\/style/gi, "<\\/style"); } catch (e) { return ""; }
};
__jb.serializeChildren = function (node, includeShadow, xml) {
  if (!xml && node.nodeType === 1 && node._ns === __jb.HTML_NS && __jb.SERIALIZE_VOID[node._tag]) return "";
  var out = "";
  for (var c = node.firstChild; c; c = c.nextSibling) out += __jb.serializeNode(c, includeShadow, xml);
  return out;
};

// DOM Parsing "XML serialization" (namespace prefix maps, generated prefixes,
// well-formedness checks). Used by XMLSerializer and innerHTML/outerHTML in XML documents.
(function () {
  var XML = "http://www.w3.org/XML/1998/namespace", XMLNS = "http://www.w3.org/2000/xmlns/", HTML = "http://www.w3.org/1999/xhtml";
  var bad = function (msg) { return __jb.domError("InvalidStateError", msg); };
  var CHAR = /^[\t\n\r -퟿-�\ud800-\udfff]*$/; // surrogates checked separately
  var validChars = function (s) {
    if (!CHAR.test(s)) return false;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); if (c >= 0xd800 && c <= 0xdbff) { var d = s.charCodeAt(i + 1); if (!(d >= 0xdc00 && d <= 0xdfff)) return false; i++; } else if (c >= 0xdc00 && c <= 0xdfff) return false; }
    return true;
  };
  var NAME = /^[:A-Z_a-zÀ-ÖØ-öø-˿Ͱ-ͽͿ-῿‌-‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�][:A-Z_a-zÀ-ÖØ-öø-˿Ͱ-ͽͿ-῿‌-‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�\-.0-9·̀-ͯ‿-⁀]*$/;
  var key = function (ns) { return ns === null ? "\u0000null" : ns; };
  var copyMap = function (m) { var o = Object.create(null); Object.keys(m).forEach(function (k) { o[k] = m[k].slice(); }); return o; };
  var addToMap = function (map, prefix, ns) { var k = key(ns); (map[k] || (map[k] = [])).push(prefix); };
  var preferredPrefix = function (map, preferred, ns) {
    var list = map[key(ns)];
    if (!list || !list.length) return null;
    if (list.indexOf(preferred) >= 0) return preferred;
    return list[list.length - 1];
  };
  var generatePrefix = function (map, ns, idx) { var p = "ns" + idx.v; idx.v++; addToMap(map, p, ns); return p; };
  var escText = function (s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
  var escAttr = function (s, wf) {
    if (s === null) return "";
    if (wf && !validChars(s)) throw bad("The attribute value contains characters that are not allowed in XML.");
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  };
  var recordNamespaceInfo = function (el, map, localPrefixes) {
    var defaultNs = null;
    el._attrs.forEach(function (a) {
      if (a._ns !== XMLNS) return;
      if (a._prefix === null) { defaultNs = a._value; return; }
      var prefixDef = a._local, nsDef = a._value;
      if (nsDef === XML) return;
      if (nsDef === "") nsDef = null;
      var list = map[key(nsDef)];
      if (list && list.indexOf(prefixDef) >= 0) return;
      addToMap(map, prefixDef, nsDef);
      localPrefixes[prefixDef] = nsDef === null ? "" : nsDef;
    });
    return defaultNs;
  };
  var serializeAttrs = function (el, map, idx, localPrefixes, ignoreNsDef, wf) {
    var out = "", seen = [];
    el._attrs.forEach(function (a) {
      if (wf && seen.some(function (t) { return t[0] === a._ns && t[1] === a._local; })) throw bad("Duplicate attribute.");
      seen.push([a._ns, a._local]);
      var ns = a._ns, candidate = null;
      if (ns !== null) {
        candidate = preferredPrefix(map, a._prefix, ns);
        if (ns === XMLNS) {
          if (a._value === XML || (a._prefix === null && ignoreNsDef) || (a._prefix !== null && (!(a._local in localPrefixes) || localPrefixes[a._local] !== a._value))) return;
          if (wf && a._value === XMLNS) throw bad("The XMLNS namespace is reserved.");
          if (wf && a._value === "") throw bad("Namespace prefix declarations cannot be used to undeclare a namespace.");
          if (a._prefix === "xmlns") candidate = "xmlns";
        } else if (candidate === null) {
          candidate = generatePrefix(map, ns, idx);
          out += " xmlns:" + candidate + '="' + escAttr(ns, wf) + '"';
        }
      }
      out += " ";
      if (candidate !== null) out += candidate + ":";
      if (wf && (a._local.indexOf(":") >= 0 || !NAME.test(a._local) || (a._local === "xmlns" && ns === null))) throw bad("The attribute name is not a valid XML name.");
      out += a._local + '="' + escAttr(a._value, wf) + '"';
    });
    return out;
  };
  var ser = function (node, ctxNs, map, idx, wf) {
    switch (node.nodeType) {
      case 1: {
        if (wf && (node._local.indexOf(":") >= 0 || !NAME.test(node._local))) throw bad("The element name is not a valid XML name.");
        var markup = "<", qn = "", skipEnd = false, ignoreNsDef = false;
        map = copyMap(map);
        var localPrefixes = Object.create(null);
        var localDefault = recordNamespaceInfo(node, map, localPrefixes);
        var inherited = ctxNs, ns = node._ns;
        if (inherited === ns) {
          if (localDefault !== null) ignoreNsDef = true;
          qn = ns === XML ? "xml:" + node._local : node._local;
          markup += qn;
        } else {
          var prefix = node._prefix, candidate = preferredPrefix(map, prefix, ns);
          if (prefix === "xmlns") { if (wf) throw bad("Elements cannot have the xmlns prefix."); candidate = prefix; }
          if (candidate !== null) {
            qn = candidate + ":" + node._local;
            if (localDefault !== null && localDefault !== XML) inherited = localDefault === "" ? null : localDefault;
            markup += qn;
          } else if (prefix !== null) {
            if (prefix in localPrefixes) prefix = generatePrefix(map, ns, idx);
            else addToMap(map, prefix, ns);
            qn = prefix + ":" + node._local;
            markup += qn + " xmlns:" + prefix + '="' + escAttr(ns, wf) + '"';
            if (localDefault !== null) inherited = localDefault === "" ? null : localDefault;
          } else if (localDefault === null || localDefault !== (ns === null ? "" : ns)) {
            ignoreNsDef = true; qn = node._local; inherited = ns;
            markup += qn + ' xmlns="' + escAttr(ns === null ? "" : ns, wf) + '"';
          } else { qn = node._local; inherited = ns; markup += qn; }
        }
        markup += serializeAttrs(node, map, idx, localPrefixes, ignoreNsDef, wf);
        var kids = node._tag === "template" && ns === HTML && node._content ? node._content : node;
        if (ns === HTML && !kids.firstChild && __jb.VOID[node._local]) { markup += " /"; skipEnd = true; }
        else if (ns !== HTML && !kids.firstChild) { markup += "/"; skipEnd = true; }
        markup += ">";
        if (skipEnd) return markup;
        for (var c = kids.firstChild; c; c = c.nextSibling) markup += ser(c, inherited, map, idx, wf);
        return markup + "</" + qn + ">";
      }
      case 9: {
        if (wf && !node.documentElement) throw bad("A document must have a document element.");
        var d = ""; for (var dc = node.firstChild; dc; dc = dc.nextSibling) d += ser(dc, ctxNs, map, idx, wf); return d;
      }
      case 11: { var f = ""; for (var fc = node.firstChild; fc; fc = fc.nextSibling) f += ser(fc, ctxNs, map, idx, wf); return f; }
      case 8:
        if (wf && (!validChars(node.data) || node.data.indexOf("--") >= 0 || /-$/.test(node.data))) throw bad("The comment is not well-formed.");
        return "<!--" + node.data + "-->";
      case 4: return "<![CDATA[" + node.data + "]]>";
      case 3:
        if (wf && !validChars(node.data)) throw bad("The text contains characters that are not allowed in XML.");
        return escText(node.data);
      case 10: {
        if (wf && !/^[ \u000D\u000Aa-zA-Z0-9\-'()+,./:=?;!*#@$_%]*$/.test(node.publicId)) throw bad("The doctype public identifier is not well-formed.");
        if (wf && node.systemId.indexOf('"') >= 0 && node.systemId.indexOf("'") >= 0) throw bad("The doctype system identifier is not well-formed.");
        var dt = "<!DOCTYPE " + node.name;
        if (node.publicId !== "") dt += ' PUBLIC "' + node.publicId + '"';
        if (node.systemId !== "" && node.publicId === "") dt += " SYSTEM";
        if (node.systemId !== "") dt += ' "' + node.systemId + '"';
        return dt + ">";
      }
      case 7:
        if (wf && (node.target.indexOf(":") >= 0 || /^xml$/i.test(node.target) || !validChars(node.data) || node.data.indexOf("?>") >= 0)) throw bad("The processing instruction is not well-formed.");
        return "<?" + node.target + " " + node.data + "?>";
      default: return "";
    }
  };
  // XML serialization of `node` (or of its children when `childrenOnly`).
  __jb.xmlSerialize = function (node, requireWellFormed, childrenOnly) {
    var map = Object.create(null); map[XML] = ["xml"];
    var idx = { v: 1 };
    try {
      if (!childrenOnly) return ser(node, null, map, idx, !!requireWellFormed);
      var src = node._tag === "template" && node._ns === HTML && node._content ? node._content : node, out = "";
      for (var c = src.firstChild; c; c = c.nextSibling) out += ser(c, null, map, idx, !!requireWellFormed);
      return out;
    } catch (e) {
      if (e && e.name === "InvalidStateError") throw e;
      throw e;
    }
  };
})();
// ---- CSS selectors (Selectors Level 4 subset; CSS-syntax tokenization) ----
__jb.selectorCache = Object.create(null);
__jb.CI_ATTRS = { accept: 1, "accept-charset": 1, align: 1, alink: 1, axis: 1, bgcolor: 1, charset: 1, checked: 1, clear: 1, codetype: 1, color: 1, compact: 1, declare: 1, defer: 1, dir: 1, direction: 1, disabled: 1, enctype: 1, face: 1, frame: 1, hreflang: 1, "http-equiv": 1, lang: 1, language: 1, link: 1, media: 1, method: 1, multiple: 1, nohref: 1, noresize: 1, noshade: 1, nowrap: 1, readonly: 1, rel: 1, rev: 1, rules: 1, scope: 1, scrolling: 1, selected: 1, shape: 1, target: 1, text: 1, type: 1, valign: 1, valuetype: 1, vlink: 1 };
// Heading levels with headingoffset/headingreset (whatwg/html#11086): offsets from the element and
// its ancestors (shadow roots continue at their host) add up until a headingreset or a modal dialog; capped at 9.
__jb.headingLevel = function (el) {
  if (el._ns !== __jb.HTML_NS || !/^h[1-6]$/.test(el._local)) return null;
  var level = Number(el._local.charAt(1)), offset = 0;
  for (var n = el; n; ) {
    if (n.nodeType === 1 && !(n._local === "slot" && n._ns === __jb.HTML_NS)) {
      var raw = n.getAttribute("headingoffset");
      if (raw !== null) { var v = __jb.parseHtmlInt(raw); if (v !== null && v > 0) offset += v; }
      if (n.hasAttribute("headingreset") || (n._tag === "dialog" && n._modal)) break;
    }
    // parent, crossing shadow roots to their hosts (slots are not on this chain)
    n = n.parentNode || (n.nodeType === 11 && n._host ? n._host : null);
    if (n && n.nodeType !== 1 && n.nodeType !== 11) break;
  }
  return Math.min(9, level + offset);
};
__jb.PSEUDO_CLASSES = { heading: 1, "animated-image": 1, not: 1, is: 1, where: 1, matches: 1, "-webkit-any": 1, has: 1, "first-child": 1, "last-child": 1, "only-child": 1, "nth-child": 1, "nth-last-child": 1, "first-of-type": 1, "last-of-type": 1, "only-of-type": 1, "nth-of-type": 1, "nth-last-of-type": 1, empty: 1, root: 1, scope: 1, link: 1, "any-link": 1, visited: 1, "local-link": 1, hover: 1, active: 1, focus: 1, "focus-within": 1, "focus-visible": 1, target: 1, "target-within": 1, lang: 1, dir: 1, enabled: 1, disabled: 1, checked: 1, indeterminate: 1, default: 1, required: 1, optional: 1, valid: 1, invalid: 1, "in-range": 1, "out-of-range": 1, "read-only": 1, "read-write": 1, "placeholder-shown": 1, "user-valid": 1, "user-invalid": 1, defined: 1, host: 1, "host-context": 1, playing: 1, paused: 1, seeking: 1, buffering: 1, stalled: 1, muted: 1, "volume-locked": 1, open: 1, closed: 1, modal: 1, "popover-open": 1, fullscreen: 1, "picture-in-picture": 1, autofill: 1, "-webkit-autofill": 1, state: 1, current: 1, past: 1, future: 1, blank: 1, "nth-col": 1, "nth-last-col": 1 };
__jb.PSEUDO_ELEMENTS = { before: 1, after: 1, "first-line": 1, "first-letter": 1, selection: 1, marker: 1, placeholder: 1, backdrop: 1, "file-selector-button": 1, part: 1, slotted: 1, cue: 1, "cue-region": 1, "target-text": 1, "spelling-error": 1, "grammar-error": 1, highlight: 1, "view-transition": 1, "view-transition-group": 1, "view-transition-image-pair": 1, "view-transition-old": 1, "view-transition-new": 1, "details-content": 1, "scroll-marker": 1, "scroll-marker-group": 1, "scroll-button": 1, checkmark: 1, "picker-icon": 1, picker: 1, column: 1, "search-text": 1 };
// Pseudo-element arguments: view transition names (* or a <custom-ident>, with .classes),
// ::part()/::slotted()/::highlight() need one; the others take none.
__jb.checkPseudoElementArg = function (name, arg, err) {
  if (/^view-transition-(group|image-pair|old|new)$/.test(name)) {
    if (arg === null) err("::" + name + "() needs an argument");
    var ident = "(?:-?(?:[A-Za-z_\\u0080-\\uffff]|\\\\.)(?:[\\w\\-\\u0080-\\uffff]|\\\\.)*|--(?:[\\w\\-\\u0080-\\uffff]|\\\\.)*)";
    var m = new RegExp("^(\\*|" + ident + ")((?:\\." + ident + ")*)$").exec(arg.trim());
    if (!m) err("bad ::" + name + "() argument");
    if (m[1] !== "*" && /^(default|initial|inherit|unset|revert|revert-layer)$/i.test(m[1])) err("bad ::" + name + "() name");
    return;
  }
  if (name === "part" || name === "slotted" || name === "highlight" || name === "picker" || name === "scroll-button") {
    if (arg === null || !arg.trim()) err("::" + name + "() needs an argument");
    if (name === "highlight" && !/^-?[A-Za-z_\u0080-\uffff][\w\-\u0080-\uffff]*$/.test(arg.trim())) err("bad ::highlight() argument");
    return;
  }
  if (name === "cue" || name === "cue-region") return;
  if (arg !== null) err("::" + name + " takes no argument");
};
__jb.allowedAfterPseudo = function (pe, after, isElement) {
  if (/^view-transition-/.test(pe)) return !isElement && after === "only-child";
  if (pe === "view-transition") return false;
  if (isElement) return pe === "before" || pe === "after" ? after === "marker" : pe === "part" || pe === "slotted" ? !!__jb.PSEUDO_ELEMENTS[after] && after !== "part" && after !== "slotted" : pe === "column" ? after === "scroll-marker" : false;
  if (pe === "search-text") return /^(current|not)$/.test(after);
  if (pe === "part") return !/^(first-child|last-child|only-child|nth-|first-of-type|last-of-type|only-of-type|empty|root|scope|has$|not$|is$|where$)/.test(after);
  return /^(hover|active|focus|focus-visible|focus-within|state|open|closed|checked|disabled|enabled)$/.test(after);
};
__jb.listHasPseudoElement = function (list) {
  return (list || []).some(function (complex) {
    if (complex && !Array.isArray(complex) && Array.isArray(complex.complex)) complex = complex.complex; // relative selector (:has)
    return Array.isArray(complex) && complex.some(function (part) { return part && part.compound && part.compound.pseudoElement; });
  });
};
// CSSOM serialization of a selector list (selectorText): one space around combinators, ", "
// between selectors, quoted attribute values, lower-case pseudo names, "::" for the legacy
// pseudo-elements, canonical An+B for :nth-*(). Text that does not parse is returned trimmed.
__jb.canonicalSelector = function (text) {
  var s = String(text).replace(/\/\*[\s\S]*?\*\//g, " ").trim(), n = s.length, i = 0;
  var quote = function (v) { return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ") + '"'; };
  var nthCanon = function (arg) {
    var m = /^\s*(odd|even|[+-]?\d*n(?:\s*[+-]\s*\d+)?|[+-]?\d+)(\s+of\s+([\s\S]+))?\s*$/i.exec(arg);
    if (!m) return arg.trim();
    var t = m[1].toLowerCase().replace(/\s+/g, ""), a, b;
    if (t === "odd") { a = 2; b = 1; } else if (t === "even") { a = 2; b = 0; }
    else if (t.indexOf("n") >= 0) { var p = t.split("n"); a = p[0] === "" || p[0] === "+" ? 1 : p[0] === "-" ? -1 : parseInt(p[0], 10); b = p[1] ? parseInt(p[1], 10) : 0; }
    else { a = 0; b = parseInt(t, 10); }
    var out = a === 0 ? String(b) : (a === 1 ? "" : a === -1 ? "-" : String(a)) + "n" + (b > 0 ? "+" + b : b < 0 ? String(b) : "");
    if (m[3]) out += " of " + __jb.canonicalSelector(m[3]);
    return out;
  };
  var out = "", pendingWs = false;
  var flushWs = function () { if (pendingWs && out && !/[\s(,]$/.test(out)) out += " "; pendingWs = false; };
  while (i < n) {
    var c = s.charAt(i);
    if (c === "\\") { flushWs(); out += s.substr(i, 2); i += 2; continue; }
    if (c === '"' || c === "'") { flushWs(); var j = i + 1; while (j < n && s.charAt(j) !== c) { if (s.charAt(j) === "\\") j++; j++; } out += s.slice(i, j + 1); i = j + 1; continue; }
    if (/\s/.test(c)) { pendingWs = true; i++; continue; }
    if (c === ",") { out = out.replace(/\s+$/, "") + ", "; pendingWs = false; i++; continue; }
    if (c === ">" || c === "+" || c === "~") { out = out.replace(/\s+$/, ""); out += (out && !/\($/.test(out) ? " " : "") + c + " "; pendingWs = false; i++; continue; }
    if (c === "[") {
      flushWs();
      var k = i + 1, depth = 1, q = null;
      while (k < n && depth) { var ch = s.charAt(k); if (q) { if (ch === "\\") k++; else if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch; else if (ch === "[") depth++; else if (ch === "]") depth--; k++; }
      var inner = s.slice(i + 1, k - 1).trim();
      var am = /^((?:[^\s=~|^$*!\]]|\\.)*(?:\|(?:[^\s=~|^$*!\]]|\\.)+)?)\s*(?:([~|^$*]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?:[^\s\\]|\\.)+)\s*([iIsS])?)?$/.exec(inner);
      if (am && am[2]) {
        var val = am[3];
        if (val.charAt(0) === '"' || val.charAt(0) === "'") val = val.slice(1, -1).replace(/\\(.)/g, "$1");
        out += "[" + am[1] + am[2] + quote(val) + (am[4] ? " " + am[4].toLowerCase() : "") + "]";
      } else out += "[" + inner + "]";
      i = k;
      continue;
    }
    if (c === ":") {
      flushWs();
      var dbl = s.charAt(i + 1) === ":";
      var nm = /^[-\w\u0080-￿]+/.exec(s.slice(i + (dbl ? 2 : 1)));
      if (!nm) { out += c; i++; continue; }
      var name = nm[0].toLowerCase();
      i += (dbl ? 2 : 1) + nm[0].length;
      var legacy = !dbl && /^(before|after|first-line|first-letter)$/.test(name);
      out += (dbl || legacy ? "::" : ":") + name;
      if (s.charAt(i) === "(") {
        var d2 = 1, st = i + 1, q2 = null, e = st;
        while (e < n && d2) { var ce = s.charAt(e); if (q2) { if (ce === "\\") e++; else if (ce === q2) q2 = null; } else if (ce === '"' || ce === "'") q2 = ce; else if (ce === "(") d2++; else if (ce === ")") d2--; e++; }
        var arg = s.slice(st, e - 1);
        var canonArg;
        if (/^(is|where|not|has|matches|-webkit-any|host|host-context|slotted|cue)$/.test(name)) canonArg = __jb.canonicalSelector(arg);
        else if (/^nth-(child|last-child|of-type|last-of-type|col|last-col)$/.test(name)) canonArg = nthCanon(arg);
        else if (name === "lang" || name === "heading" || name === "state" || name === "dir" || name === "part" || name === "highlight") canonArg = arg.trim().replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ");
        else canonArg = arg.trim();
        out += "(" + canonArg + ")";
        i = e;
      }
      continue;
    }
    flushWs();
    out += c;
    i++;
  }
  return out.trim();
};
__jb.closeOpenBlocks = function (s) {
  var stack = [], quote = null;
  for (var k = 0; k < s.length; k++) {
    var c = s.charAt(k);
    if (c === "\\") { k++; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[") stack.push("]");
    else if (c === "(") stack.push(")");
    else if ((c === "]" || c === ")") && stack.length && stack[stack.length - 1] === c) stack.pop();
  }
  if (s.charAt(s.length - 1) === "\\") return s; // a trailing escape stays invalid
  return s + (quote || "") + stack.reverse().join("");
};
__jb.parseSelectorList = function (sel) {
  var cached = __jb.selectorCache[sel];
  if (cached) return cached;
  var s = __jb.closeOpenBlocks(String(sel)), i = 0, n = s.length;
  function err(m) { throw new Error(m + " in selector '" + sel + "'"); }
  function isWs(c) { return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f"; }
  function skipWs() { while (i < n && isWs(s.charAt(i))) i++; }
  function isNameStart(c) { return /[a-zA-Z_]/.test(c) || c.charCodeAt(0) >= 0x80; }
  function isNameChar(c) { return /[a-zA-Z0-9_-]/.test(c) || c.charCodeAt(0) >= 0x80; }
  function readEscape() {
    // at backslash
    i++;
    if (i >= n) err("bad escape");
    var c = s.charAt(i);
    if (c === "\n") err("bad escape");
    var hex = /^[0-9a-fA-F]{1,6}/.exec(s.slice(i));
    if (hex) { i += hex[0].length; if (i < n && isWs(s.charAt(i))) { if (s.charAt(i) === "\r" && s.charAt(i + 1) === "\n") i++; i++; } var cp = parseInt(hex[0], 16); if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�"; return String.fromCodePoint(cp); }
    i++;
    return c;
  }
  function startsIdent() {
    var c = s.charAt(i);
    if (c === "-") { var d = s.charAt(i + 1); return d === "-" || isNameStart(d) || (d === "\\" && i + 2 < n && s.charAt(i + 2) !== "\n"); }
    if (isNameStart(c)) return true;
    return c === "\\" && i + 1 < n && s.charAt(i + 1) !== "\n";
  }
  function readIdent() {
    if (!startsIdent()) err("expected identifier");
    var out = "";
    if (s.charAt(i) === "-") { out += "-"; i++; if (s.charAt(i) === "-") { out += "-"; i++; } }
    while (i < n) {
      var c = s.charAt(i);
      if (c === "\\") out += readEscape();
      else if (isNameChar(c)) { out += c; i++; }
      else break;
    }
    return out;
  }
  function readName() { // hash-like names (may start with digit)
    var out = "";
    while (i < n) { var c = s.charAt(i); if (c === "\\") out += readEscape(); else if (isNameChar(c)) { out += c; i++; } else break; }
    if (!out) err("expected name");
    return out;
  }
  function readString() {
    var q = s.charAt(i++); var out = "";
    while (i < n) {
      var c = s.charAt(i);
      if (c === q) { i++; return out; }
      if (c === "\n") err("newline in string");
      if (c === "\\") { if (s.charAt(i + 1) === "\n") { i += 2; continue; } out += readEscape(); continue; }
      out += c; i++;
    }
    err("unterminated string");
  }
  function readNsPrefixedName(allowStar) {
    // returns {ns: undefined|null|"*"|name, name}
    var ns, name;
    if (s.charAt(i) === "*") { i++; name = "*"; }
    else if (s.charAt(i) === "|" ) { name = null; }
    else name = readIdent();
    if (s.charAt(i) === "|" && s.charAt(i + 1) !== "=") {
      i++;
      ns = name === null ? "" : name;
      if (ns !== "" && ns !== "*") err("Undeclared namespace " + ns);
      if (s.charAt(i) === "*") { if (!allowStar) err("bad name"); i++; name = "*"; }
      else name = readIdent();
    }
    return { ns: ns, name: name };
  }
  function parseCompound() {
    var c = { tag: null, tagNs: undefined, id: null, classes: [], attrs: [], pseudos: [], pseudoElement: null };
    var any = false;
    if (i < n && (s.charAt(i) === "*" || s.charAt(i) === "|" || startsIdent())) { var t = readNsPrefixedName(true); c.tag = t.name; c.tagNs = t.ns; any = true; }
    while (i < n) {
      var ch = s.charAt(i);
      if (ch === "#") { i++; if (i >= n || !(isNameChar(s.charAt(i)) || s.charAt(i) === "\\")) err("bad id"); c.id = readName(); any = true; }
      else if (ch === ".") { i++; c.classes.push(readIdent()); any = true; }
      else if (ch === "[") {
        i++; skipWs();
        var an = readNsPrefixedName(false);
        if (an.name === "*") err("bad attribute name");
        skipWs();
        var op = null, value = null, ci = false, cs = false;
        var two = s.substr(i, 2);
        if (two === "~=" || two === "|=" || two === "^=" || two === "$=" || two === "*=") { op = two; i += 2; }
        else if (s.charAt(i) === "=") { op = "="; i++; }
        if (op) {
          skipWs();
          var vc = s.charAt(i);
          if (vc === '"' || vc === "'") value = readString();
          else if (startsIdent()) value = readIdent();
          else err("bad attribute value");
          skipWs();
          if (i < n && s.charAt(i) !== "]") { var flag = readIdent().toLowerCase(); if (flag === "i") ci = true; else if (flag === "s") cs = true; else err("bad attribute flag"); skipWs(); }
        }
        if (s.charAt(i) !== "]") err("expected ]");
        i++;
        c.attrs.push({ name: an.name, ns: an.ns, op: op, value: value, ci: ci, cs: cs });
        any = true;
      } else if (ch === ":") {
        i++;
        var isElement = false;
        if (s.charAt(i) === ":") { isElement = true; i++; }
        if (!startsIdent()) err("bad pseudo");
        var name = readIdent().toLowerCase();
        var arg = null, argList = null;
        if (s.charAt(i) === "(") {
          i++;
          var depth = 1, start = i, inStr = null;
          while (i < n) { var cc = s.charAt(i); if (inStr) { if (cc === "\\") i++; else if (cc === inStr) inStr = null; } else if (cc === '"' || cc === "'") inStr = cc; else if (cc === "(") depth++; else if (cc === ")") { depth--; if (depth === 0) break; } i++; }
          if (depth !== 0) err("unbalanced parentheses");
          arg = s.slice(start, i); i++;
        }
        if (!isElement && (name === "before" || name === "after" || name === "first-line" || name === "first-letter")) isElement = true;
        if (isElement) {
          if (!__jb.PSEUDO_ELEMENTS[name]) err("unknown pseudo-element ::" + name);
          __jb.checkPseudoElementArg(name, arg, err);
          c.pseudoElement = name; any = true;
          // only some pseudo-classes and nested pseudo-elements may follow a pseudo-element
          while (i < n && s.charAt(i) === ":") {
            var nestedPe = s.charAt(i + 1) === ":";
            i += nestedPe ? 2 : 1;
            if (!startsIdent()) err("bad pseudo");
            var after = readIdent().toLowerCase();
            if (s.charAt(i) === "(") { var dep = 1; i++; while (i < n && dep) { var ac = s.charAt(i); if (ac === "(") dep++; else if (ac === ")") dep--; i++; } if (dep) err("unbalanced parentheses"); }
            if (!__jb.allowedAfterPseudo(name, after, nestedPe || /^(before|after|first-line|first-letter)$/.test(after))) err("':" + after + "' cannot follow ::" + name);
          }
          if (i < n && !isWs(s.charAt(i)) && s.charAt(i) !== ",") err("nothing may follow ::" + name);
          break;
        }
        if (!__jb.PSEUDO_CLASSES[name]) err("unknown pseudo-class :" + name);
        var ps = { name: name, arg: arg };
        if (name === "not" || name === "is" || name === "where" || name === "matches" || name === "-webkit-any") { if (arg === null) err("missing argument"); ps.list = name === "not" ? __jb.parseSelectorList(arg) : __jb.parseForgivingList(arg); if (name === "not" && !ps.list.length) err("empty :not()"); if (name === "not" && __jb.listHasPseudoElement(ps.list)) err("pseudo-elements are not allowed in :not()"); }
        else if (name === "has") { if (arg === null || !arg.trim()) err("missing argument"); ps.list = __jb.parseRelativeList(arg); if (__jb.listHasPseudoElement(ps.list)) err("pseudo-elements are not allowed in :has()"); }
        else if (name === "nth-child" || name === "nth-last-child" || name === "nth-of-type" || name === "nth-last-of-type" || name === "nth-col" || name === "nth-last-col") { if (arg === null) err("missing argument"); ps.nth = __jb.parseNth(arg, name === "nth-child" || name === "nth-last-child"); if (!ps.nth) err("bad nth argument"); }
        else if (name === "lang" || name === "dir" || name === "state" || name === "host" || name === "host-context") { if (arg !== null && !arg.trim() && name !== "host") err("empty argument"); if (name === "lang" && arg !== null) ps.langs = arg.split(",").map(function (x) { return x.trim().replace(/^["']|["']$/g, "").toLowerCase(); }); if ((name === "host" || name === "host-context") && arg !== null) ps.list = __jb.parseSelectorList(arg); }
        else if (name === "heading" && arg !== null) {
          var levels = arg.split(",").map(function (x) { return x.trim(); });
          if (levels.some(function (x) { return !/^[0-9]+$/.test(x); })) err("bad :heading() argument");
          ps.levels = levels.map(Number);
        }
        else if (arg !== null) err("unexpected argument");
        c.pseudos.push(ps);
        any = true;
      } else break;
    }
    if (!any) err("empty compound");
    return c;
  }
  var list = [];
  skipWs();
  if (i >= n) err("empty selector");
  for (;;) {
    var complex = [];
    var comb = null;
    for (;;) {
      var compound = parseCompound();
      complex.push({ comb: comb, compound: compound });
      var save = i; skipWs();
      if (i >= n || s.charAt(i) === ",") break;
      if (compound.pseudoElement) err("a pseudo-element must be in the last compound selector");
      var ch2 = s.charAt(i);
      if (ch2 === ">" || ch2 === "+" || ch2 === "~") { i++; skipWs(); comb = ch2; if (s.charAt(i) === ">" || s.charAt(i) === "+" || s.charAt(i) === "~" || s.charAt(i) === ",") err("bad combinator"); }
      else if (i > save) comb = " ";
      else err("unexpected character");
      if (i >= n) err("dangling combinator");
    }
    list.push(complex);
    skipWs();
    if (i < n && s.charAt(i) === ",") { i++; skipWs(); if (i >= n) err("trailing comma"); continue; }
    if (i < n) err("unexpected character");
    break;
  }
  __jb.selectorCache[sel] = list;
  return list;
};
__jb.parseForgivingList = function (arg) {
  var out = [];
  __jb.splitSelectorList(arg).forEach(function (part) { try { out.push.apply(out, __jb.parseSelectorList(part)); } catch (e) {} });
  return out;
};
__jb.splitSelectorList = function (arg) {
  var parts = [], depth = 0, cur = "", inStr = null;
  for (var i = 0; i < arg.length; i++) { var c = arg.charAt(i); if (inStr) { cur += c; if (c === "\\") { cur += arg.charAt(++i); } else if (c === inStr) inStr = null; continue; } if (c === '"' || c === "'") { inStr = c; cur += c; continue; } if (c === "(" || c === "[") depth++; else if (c === ")" || c === "]") depth--; if (c === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += c; }
  parts.push(cur);
  return parts.map(function (p) { return p.trim(); }).filter(Boolean);
};
__jb.parseRelativeList = function (arg) {
  return __jb.splitSelectorList(arg).map(function (part) {
    var m = /^([>+~])\s*/.exec(part);
    var comb = m ? m[1] : " ";
    var rest = m ? part.slice(m[0].length) : part;
    var list = __jb.parseSelectorList(rest);
    if (list.length !== 1) throw new Error("bad relative selector");
    return { comb: comb, complex: list[0] };
  });
};
__jb.parseNth = function (arg, allowOf) {
  var a, b, of = null;
  var text = arg.trim();
  if (allowOf) { var m0 = /^(.*?)\s+of\s+([\s\S]+)$/i.exec(text); if (m0) { text = m0[1].trim(); of = __jb.parseSelectorList(m0[2]); } }
  var t = text.toLowerCase().replace(/\s+/g, "");
  if (t === "odd") { a = 2; b = 1; }
  else if (t === "even") { a = 2; b = 0; }
  else {
    var m = /^([+-]?\d*)?n([+-]\d+)?$/.exec(t);
    if (m) { a = m[1] === "" || m[1] === "+" || m[1] === undefined ? 1 : m[1] === "-" ? -1 : parseInt(m[1], 10); b = m[2] ? parseInt(m[2], 10) : 0; }
    else if (/^[+-]?\d+$/.test(t)) { a = 0; b = parseInt(t, 10); }
    else return null;
  }
  if (/\s*[+-]\s*\d+$/.test(text) && /n\s*[+-]/.test(text) && !/n\s*[+-]\s*\d/.test(text)) return null;
  return { a: a, b: b, of: of };
};
__jb.nthMatches = function (nth, index) {
  if (nth.a === 0) return index === nth.b;
  var k = (index - nth.b) / nth.a;
  return k >= 0 && Number.isInteger(k);
};
// Selector matching runs per element per query: raw fields (_doc, _attrs) instead of the
// brand-checked public getters (ownerDocument, nodeType, getAttribute).
__jb.isHtmlElementInHtmlDoc = function (el) { return el._ns === __jb.HTML_NS && !!el._doc && !!el._doc._isHTML; };
// The null-namespace attribute `local` (what #id and .class match), or null.
__jb.rawAttrValue = function (el, local) { var as = el._attrs; for (var i = 0; i < as.length; i++) if (as[i]._local === local && as[i]._ns === null) return as[i]._value; return null; };
__jb.matchesCompound = function (el, c) {
  if (el._attrs === undefined || el._local === undefined) return false;
  if (c.pseudoElement) return false;
  if (c.tag !== null) {
    if (c.tagNs === "" && el._ns !== null) return false;
    if (c.tag !== "*") { if (__jb.isHtmlElementInHtmlDoc(el) ? el._tag !== c.tag.toLowerCase() : el._local !== c.tag) return false; }
    if (c.tagNs === undefined && c.tag !== "*") { /* default namespace: any */ }
  }
  if (c.id !== null && __jb.rawAttrValue(el, "id") !== c.id) return false;
  if (c.classes.length) {
    var clsv = __jb.rawAttrValue(el, "class");
    if (!clsv) return false;
    var cls = clsv.split(/[\t\n\f\r ]+/);
    var quirks = el._doc && el._doc._quirks;
    if (quirks) cls = cls.map(function (x) { return x.toLowerCase(); });
    for (var k = 0; k < c.classes.length; k++) if (cls.indexOf(quirks ? c.classes[k].toLowerCase() : c.classes[k]) < 0) return false;
  }
  for (var a = 0; a < c.attrs.length; a++) {
    var at = c.attrs[a];
    var htmlCase = __jb.isHtmlElementInHtmlDoc(el);
    var name = htmlCase ? at.name.toLowerCase() : at.name;
    var matched = null, valueOk = false;
    for (var x = 0; x < el._attrs.length; x++) {
      var attr = el._attrs[x];
      var nameOk = at.ns === undefined || at.ns === "" ? (htmlCase ? attr._local.toLowerCase() === name && (at.ns === undefined || attr._ns === null) : attr._local === name && (at.ns === undefined || attr._ns === null)) : attr._local === name;
      if (at.ns === undefined && attr._ns !== null && !(htmlCase && attr._local.toLowerCase() === name)) { if (!(attr._prefix === null && attr._local === name)) nameOk = false; }
      if (nameOk && at.op !== null) { matched = attr; if (__jb.attrValueMatches(el, attr, at, htmlCase)) { valueOk = true; break; } continue; }
      if (nameOk) { matched = attr; break; }
    }
    if (!matched) return false;
    if (at.op !== null && !valueOk) return false;
  }
  for (var p = 0; p < c.pseudos.length; p++) if (!__jb.matchesPseudo(el, c.pseudos[p])) return false;
  return true;
};
__jb.attrValueMatches = function (el, attr, at, htmlCase) {
  var v = attr._value, val = at.value;
  var ci = at.ci || (!at.cs && htmlCase && __jb.CI_ATTRS[attr._local.toLowerCase()]);
  if (ci) { v = v.toLowerCase(); val = val.toLowerCase(); }
  switch (at.op) {
    case "=": return v === val;
    case "~=": return val !== "" && !/[\t\n\f\r ]/.test(val) && v.split(/[\t\n\f\r ]+/).indexOf(val) >= 0;
    case "|=": return v === val || v.indexOf(val + "-") === 0;
    case "^=": return val !== "" && v.indexOf(val) === 0;
    case "$=": return val !== "" && v.slice(-val.length) === val;
    case "*=": return val !== "" && v.indexOf(val) >= 0;
  }
  return false;
};
// 1-based position of `el` among its parent's element children (or those of its type), from the
// start or the end; cached per parent and DOM version.
__jb.elementPosition = function (el, ofType, fromEnd) {
  var p = el.parentNode;
  if (!p) return 1;
  var c = p._jbPos;
  if (!c || c.v !== __jb.domVersion) {
    c = { v: __jb.domVersion, pos: new Map(), n: 0, types: Object.create(null) };
    for (var k = p.firstChild; k; k = k.nextSibling) {
      if (k.nodeType !== 1) continue;
      var key = k._ns + " " + k._local;
      c.n++; c.types[key] = (c.types[key] || 0) + 1;
      c.pos.set(k, [c.n, c.types[key]]);
    }
    try { Object.defineProperty(p, "_jbPos", { value: c, writable: true, configurable: true, enumerable: false }); } catch (e) { p._jbPos = c; }
  }
  var e = c.pos.get(el);
  if (!e) return 1;
  if (!ofType) return fromEnd ? c.n - e[0] + 1 : e[0];
  return fromEnd ? c.types[el._ns + " " + el._local] - e[1] + 1 : e[1];
};
__jb.elementSiblings = function (el, filterList) {
  var out = [];
  if (!el.parentNode) return [el];
  for (var c = el.parentNode.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && (!filterList || filterList.some(function (cx) { return __jb.matchesComplex(c, cx); }))) out.push(c);
  return out;
};
__jb.matchesPseudo = function (el, ps) {
  switch (ps.name) {
    case "not": return !ps.list.some(function (cx) { return __jb.matchesComplex(el, cx); });
    case "is": case "where": case "matches": case "-webkit-any": return ps.list.some(function (cx) { return __jb.matchesComplex(el, cx); });
    case "has": return ps.list.some(function (rel) {
      if (rel.comb === " ") return __jb.descendants(el, function (n) { return n.nodeType === 1; }).some(function (d) { return __jb.matchesComplexScoped(d, rel.complex, el, " "); });
      if (rel.comb === ">") { for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && __jb.matchesComplexScoped(c, rel.complex, el, ">")) return true; return false; }
      if (rel.comb === "+") { var s1 = el.nextElementSibling; return !!s1 && __jb.matchesComplexScoped(s1, rel.complex, el, "+"); }
      for (var s2 = el.nextElementSibling; s2; s2 = s2.nextElementSibling) if (__jb.matchesComplexScoped(s2, rel.complex, el, "~")) return true;
      return false;
    });
    case "first-child": return !el.previousElementSibling;
    case "last-child": return !el.nextElementSibling;
    case "only-child": return !el.previousElementSibling && !el.nextElementSibling;
    case "nth-child": { if (!ps.nth.of) return __jb.nthMatches(ps.nth, __jb.elementPosition(el, false, false)); var sib = __jb.elementSiblings(el, ps.nth.of); if (ps.nth.of && sib.indexOf(el) < 0) return false; return __jb.nthMatches(ps.nth, sib.indexOf(el) + 1); }
    case "nth-last-child": { if (!ps.nth.of) return __jb.nthMatches(ps.nth, __jb.elementPosition(el, false, true)); var sib2 = __jb.elementSiblings(el, ps.nth.of); if (ps.nth.of && sib2.indexOf(el) < 0) return false; return __jb.nthMatches(ps.nth, sib2.length - sib2.indexOf(el)); }
    case "first-of-type": { for (var p = el.previousElementSibling; p; p = p.previousElementSibling) if (p._local === el._local && p._ns === el._ns) return false; return true; }
    case "last-of-type": { for (var q = el.nextElementSibling; q; q = q.nextElementSibling) if (q._local === el._local && q._ns === el._ns) return false; return true; }
    case "only-of-type": return __jb.matchesPseudo(el, { name: "first-of-type" }) && __jb.matchesPseudo(el, { name: "last-of-type" });
    case "nth-of-type": return __jb.nthMatches(ps.nth, __jb.elementPosition(el, true, false));
    case "nth-last-of-type": return __jb.nthMatches(ps.nth, __jb.elementPosition(el, true, true));
    case "empty": { for (var k = el.firstChild; k; k = k.nextSibling) { if (k.nodeType === 1 || k.nodeType === 3 || k.nodeType === 4) return false; } return true; }
    case "root": return !!el.ownerDocument && el === el.ownerDocument.documentElement && el.parentNode === el.ownerDocument;
    case "scope": return __jb.scopeElement ? el === __jb.scopeElement : (!!el.ownerDocument && el === el.ownerDocument.documentElement);
    case "checked": return (el._tag === "input" && el._ns === __jb.HTML_NS && (__jb.inputType(el) === "checkbox" || __jb.inputType(el) === "radio") && el.checked) || (el._tag === "option" && el._ns === __jb.HTML_NS && el.selected);
    case "indeterminate": return el._tag === "input" && el._ns === __jb.HTML_NS && ((__jb.inputType(el) === "checkbox" && !!el.indeterminate) || (__jb.inputType(el) === "radio" && !el.checked && !__jb.radioGroupChecked(el))) || (el._tag === "progress" && !el.hasAttribute("value"));
    case "disabled": return __jb.isDisabled(el, true);
    case "enabled": return __jb.isFormControlLike(el, true) && !__jb.isDisabled(el, true);
    case "required": return el._ns === __jb.HTML_NS && /^(input|select|textarea)$/.test(el._tag) && el.hasAttribute("required");
    case "optional": return el._ns === __jb.HTML_NS && /^(input|select|textarea)$/.test(el._tag) && !el.hasAttribute("required");
    case "link": case "any-link": return el._ns === __jb.HTML_NS && (el._tag === "a" || el._tag === "area") && el.hasAttribute("href");
    case "local-link": { if (!(el._ns === __jb.HTML_NS && (el._tag === "a" || el._tag === "area") && el.hasAttribute("href"))) return false; try { var u = new URL(el.getAttribute("href"), el.ownerDocument.URL), d = new URL(el.ownerDocument.URL); return u.origin === d.origin && u.pathname === d.pathname && u.search === d.search; } catch (e) { return false; } }
    case "lang": { var langEl = el; var lang = ""; while (langEl && langEl.nodeType === 1) { var l = langEl._ns === __jb.HTML_NS ? langEl.getAttribute("lang") : langEl.getAttributeNS(__jb.XML_NS, "lang") || langEl.getAttribute("lang"); if (l !== null) { lang = l; break; } langEl = langEl.parentNode; } if (!lang && langEl && langEl.nodeType === 9) { var meta = __jb.descendants(langEl, function (n) { return n.nodeType === 1 && n._tag === "meta" && /content-language/i.test(n.getAttribute("http-equiv") || ""); })[0]; if (meta) lang = (meta.getAttribute("content") || "").split(",")[0].trim(); } lang = lang.toLowerCase(); return (ps.langs || []).some(function (want) { if (want === "*") return lang !== ""; if (want === "") return false; var w = want.replace(/^\*-/, ""); return lang === w || lang.indexOf(w + "-") === 0 || (want.charAt(0) === "*" && ("-" + lang + "-").indexOf("-" + w + "-") >= 0); }); }
    case "dir": { var dirEl = el; while (dirEl && dirEl.nodeType === 1) { var dv = (dirEl.getAttribute("dir") || "").toLowerCase(); if (dv === "ltr" || dv === "rtl") return dv === String(ps.arg).trim().toLowerCase(); dirEl = dirEl.parentNode; } return String(ps.arg).trim().toLowerCase() === "ltr"; }
    case "state": { var st = __jb.customStates ? __jb.customStates(el) : null; return !!st && st.has(String(ps.arg).trim()); }
    case "defined": return __jb.ceDefined(el);
    case "placeholder-shown": return el._ns === __jb.HTML_NS && (el._tag === "input" || el._tag === "textarea") && el.hasAttribute("placeholder") && !el.value;
    case "read-only": return !__jb.matchesPseudo(el, { name: "read-write" });
    case "read-write": return (el._ns === __jb.HTML_NS && ((el._tag === "input" && !/^(hidden|checkbox|radio|file|submit|image|reset|button|color|range)$/.test(__jb.inputType(el))) || el._tag === "textarea") && !el.hasAttribute("readonly") && !__jb.isDisabled(el)) || (el.isContentEditable === true);
    case "default": return el._ns === __jb.HTML_NS && ((el._tag === "input" && (__jb.inputType(el) === "checkbox" || __jb.inputType(el) === "radio") && el.hasAttribute("checked")) || (el._tag === "option" && el.hasAttribute("selected")) || (/^(button|input)$/.test(el._tag) && __jb.isSubmitButton(el) && __jb.formOwner(el) && __jb.firstSubmitButton(__jb.formOwner(el)) === el));
    case "valid": case "invalid": {
      if (el._ns !== __jb.HTML_NS) return false;
      var wantValid = ps.name === "valid";
      if (el._tag === "form" || el._tag === "fieldset") { var anyInvalid = __jb.descendants(el, function (n) { return n.nodeType === 1 && n._ns === __jb.HTML_NS && /^(input|select|textarea|button)$/.test(n._tag) && n.willValidate === true && !n.validity.valid; }).length > 0; return wantValid ? !anyInvalid : anyInvalid; }
      if (el.willValidate !== true) return false;
      return wantValid ? el.validity.valid : !el.validity.valid;
    }
    case "in-range": case "out-of-range": {
      if (!(el._tag === "input" && el._ns === __jb.HTML_NS && /^(number|range|date|month|week|time|datetime-local)$/.test(__jb.inputType(el)))) return false;
      if (__jb.inputType(el) !== "range" && !el.hasAttribute("min") && !el.hasAttribute("max")) return false;
      if (__jb.isDisabled(el) || el.hasAttribute("readonly")) return false;
      var oor = el.validity.rangeUnderflow || el.validity.rangeOverflow;
      return ps.name === "in-range" ? !oor : oor;
    }
    case "target": { var tdoc = el.ownerDocument; if (tdoc && tdoc._targetOverride) return el === tdoc._targetOverride && el.isConnected; if (!el.isConnected || el.getRootNode().nodeType !== 9) return false; var h = el.ownerDocument && el.ownerDocument.URL ? new URL(el.ownerDocument.URL).hash : ""; return !!h && h.length > 1 && el.getAttribute("id") === decodeURIComponent(h.slice(1)); }
    case "target-within": return __jb.descendants(el, function (n) { return n.nodeType === 1 && __jb.matchesPseudo(n, { name: "target" }); }).length > 0 || __jb.matchesPseudo(el, { name: "target" });
    case "hover": case "active": case "visited": case "autofill": case "-webkit-autofill": case "current": case "past": case "future": case "playing": case "paused": case "seeking": case "buffering": case "stalled": case "muted": case "volume-locked": case "fullscreen": case "picture-in-picture": case "blank": case "nth-col": case "nth-last-col": return false;
    case "focus": case "focus-visible": { var fa = el.ownerDocument && el.ownerDocument._jbActive; if (!fa || !fa.isConnected) return false; if (ps.name === "focus-visible" && fa._focusVisible === false) return false; if (fa === el) return true; for (var fr = fa.getRootNode(); fr && fr.nodeType === 11 && fr._host; fr = fr._host.getRootNode()) if (fr._host === el) return true; return false; }
    case "focus-within": { var fw = el.ownerDocument && el.ownerDocument._jbActive; if (!fw || !fw.isConnected) return false; for (var fn = fw; fn; fn = fn.getRootNode().nodeType === 11 ? fn.getRootNode()._host : null) if (el === fn || el.contains(fn)) return true; return false; }
    case "user-valid": return !!el._userEdited && el.willValidate === true && el.validity.valid;
    case "user-invalid": return !!el._userEdited && el.willValidate === true && !el.validity.valid;
    case "open": return el._ns === __jb.HTML_NS && (el._tag === "details" || el._tag === "dialog") && el.hasAttribute("open");
    case "popover-open": return el._popoverState === "showing";
    case "animated-image": return !!(el._ns === __jb.HTML_NS && el._img && el._img.animated && el._img.state === "completely available");
    case "heading": { var hl = __jb.headingLevel(el); return hl !== null && (!ps.levels || ps.levels.indexOf(hl) >= 0); }
    case "modal": return el._tag === "dialog" && !!el._modal;
    case "closed": return el._ns === __jb.HTML_NS && (el._tag === "details" || el._tag === "dialog") && !el.hasAttribute("open");
    case "host": { var root = el.getRootNode(); if (!(root.nodeType === 11 && root._host === el)) return false; if (!ps.list) return true; return ps.list.some(function (cx) { return __jb.matchesComplex(el, cx); }); }
    case "host-context": { var root2 = el.getRootNode(); if (!(root2.nodeType === 11 && root2._host === el)) return false; for (var hc = el; hc; hc = hc.parentElement || (hc.getRootNode()._host || null)) if (ps.list.some(function (cx) { return __jb.matchesComplex(hc, cx); })) return true; return false; }
    case "state": return !!(el._internalStates && el._internalStates.has(String(ps.arg).trim()));
    default: return false;
  }
};
__jb.radioGroupChecked = function (el) { var root = __jb.formOwner(el) || el.getRootNode(); var name = el.getAttribute("name"); if (!name) return false; return __jb.descendants(root, function (n) { return n.nodeType === 1 && n._tag === "input" && __jb.inputType(n) === "radio" && n.getAttribute("name") === name && n.checked; }).length > 0; };
// withHidden: hidden inputs count too (the :enabled/:disabled selectors match them).
__jb.isFormControlLike = function (el, withHidden) { if (__jb.isFACE && __jb.isFACE(el)) return true; return el._ns === __jb.HTML_NS && /^(button|input|select|textarea|optgroup|option|fieldset)$/.test(el._tag) && (withHidden || !(el._tag === "input" && __jb.inputType(el) === "hidden")); };
__jb.isDisabled = function (el, withHidden) {
  if (!(el._ns === __jb.HTML_NS)) return false;
  if (__jb.isFACE && __jb.isFACE(el)) return __jb.faceDisabled(el);
  if (/^(button|input|select|textarea|optgroup|option|fieldset)$/.test(el._tag)) {
    if (!withHidden && el._tag === "input" && __jb.inputType(el) === "hidden") return false;
    if (el.hasAttribute("disabled")) return true;
    if (el._tag === "option") { var og = el.parentNode; return !!(og && og.nodeType === 1 && og._tag === "optgroup" && og.hasAttribute("disabled")); }
    for (var fs = el.parentNode; fs && fs.nodeType === 1; fs = fs.parentNode) if (fs._tag === "fieldset" && fs.hasAttribute("disabled")) { var legend = null; for (var c = fs.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c._tag === "legend") { legend = c; break; } if (!legend || !legend.contains(el)) return true; }
    return false;
  }
  return false;
};
__jb.isSubmitButton = function (el) { return (el._tag === "button" && el.type === "submit") || (el._tag === "input" && /^(submit|image)$/.test(__jb.inputType(el))); };
__jb.firstSubmitButton = function (form) { return __jb.descendants(form.getRootNode(), function (n) { return n.nodeType === 1 && n._ns === __jb.HTML_NS && __jb.isSubmitButton(n) && __jb.formOwner(n) === form; })[0] || null; };
// parentElement / previousElementSibling on raw tree fields (the public getters are
// brand-checked wrappers, and combinators call them for every candidate element)
__jb.rawParentElement = function (n) { var p = n._parent; return p && p._attrs !== undefined && p._local !== undefined ? p : null; };
__jb.rawPrevElement = function (n) { for (var q = n._prev; q; q = q._prev) if (q._attrs !== undefined && q._local !== undefined) return q; return null; };
__jb.matchesComplex = function (el, complex) {
  var idx = complex.length - 1;
  if (!__jb.matchesCompound(el, complex[idx].compound)) return false;
  return __jb.matchesRest(el, complex, idx, null, null);
};
// Relative matching for :has(): the leftmost compound must be related to `anchor` by `comb`.
__jb.matchesComplexScoped = function (el, complex, anchor, comb) {
  var idx = complex.length - 1;
  if (!__jb.matchesCompound(el, complex[idx].compound)) return false;
  return __jb.matchesRest(el, complex, idx, anchor, comb);
};
__jb.relatedTo = function (el, anchor, comb) {
  if (!anchor) return true;
  if (comb === " ") { for (var a = el.parentNode; a; a = a.parentNode) if (a === anchor) return true; return false; }
  if (comb === ">") return el.parentNode === anchor;
  if (comb === "+") return el.previousElementSibling === anchor;
  if (comb === "~") { for (var s = el.previousElementSibling; s; s = s.previousElementSibling) if (s === anchor) return true; return false; }
  return false;
};
__jb.matchesRest = function (el, complex, idx, anchor, anchorComb) {
  if (idx === 0) return __jb.relatedTo(el, anchor, anchorComb);
  var comb = complex[idx].comb;
  var prev = complex[idx - 1].compound;
  var up = __jb.rawParentElement, back = __jb.rawPrevElement;
  if (comb === ">") { var p = up(el); return !!p && __jb.matchesCompound(p, prev) && __jb.matchesRest(p, complex, idx - 1, anchor, anchorComb); }
  if (comb === " ") { for (var a = up(el); a; a = up(a)) if (__jb.matchesCompound(a, prev) && __jb.matchesRest(a, complex, idx - 1, anchor, anchorComb)) return true; return false; }
  if (comb === "+") { var s = back(el); return !!s && __jb.matchesCompound(s, prev) && __jb.matchesRest(s, complex, idx - 1, anchor, anchorComb); }
  if (comb === "~") { for (var q = back(el); q; q = back(q)) if (__jb.matchesCompound(q, prev) && __jb.matchesRest(q, complex, idx - 1, anchor, anchorComb)) return true; return false; }
  return false;
};
__jb.matchesSelector = function (el, selector) {
  var list;
  try { list = __jb.parseSelectorList(String(selector)); } catch (e) { throw new DOMException("'" + selector + "' is not a valid selector", "SyntaxError"); }
  var prevScope = __jb.scopeElement;
  __jb.scopeElement = el;
  try { for (var i = 0; i < list.length; i++) if (__jb.matchesComplex(el, list[i])) return true; return false; }
  finally { __jb.scopeElement = prevScope; }
};
__jb.querySelectorAll = function (root, selector, firstOnly) {
  var list;
  try { list = __jb.parseSelectorList(String(selector)); } catch (e) { throw new DOMException("'" + selector + "' is not a valid selector", "SyntaxError"); }
  var prevScope = __jb.scopeElement;
  __jb.scopeElement = root.nodeType === 1 ? root : null;
  try { return __jb.querySelectorAllInner(root, list, firstOnly); } finally { __jb.scopeElement = prevScope; }
};
__jb.querySelectorAllInner = function (root, list, firstOnly) {
  var out = [];
  var stack = [];
  // Raw tree fields (_last/_prev; elements are the nodes with _attrs): the public getters are
  // brand-checked wrappers, and a 46k-element page (Vijay Sales) spent its budget in them.
  for (var c = root._last; c; c = c._prev) stack.push(c);
  while (stack.length) {
    var n = stack.pop();
    if (n._attrs !== undefined && n._local !== undefined) {
      for (var i = 0; i < list.length; i++) if (__jb.matchesComplex(n, list[i])) { out.push(n); if (firstOnly) return out; break; }
      for (var k = n._last; k; k = k._prev) stack.push(k);
    }
  }
  return out;
};

// :defined — the element's custom element state is "uncustomized" or "custom".
__jb.ceDefined = function (el) {
  if (el._ceFailed || el._ceUpgrading || el._ceDefPending) return false;
  if (el._ceDef) return true;
  if (el._ns !== __jb.HTML_NS) return true;
  return !(__jb.validCustomElementName(el._local) || el._ceIsValue !== undefined || __jb.rawAttrValue(el, "is") !== null);
};
// An <svg> whose element children are only <symbol>/<defs> (at least one <symbol>): an icon sprite.
__jb.isSvgSprite = function (svg) {
  var symbols = 0;
  for (var c = svg._first; c; c = c._next) {
    if (c.nodeType !== 1) continue;
    var n = c.localName;
    if (n === "symbol") symbols++;
    else if (n !== "defs" && n !== "title" && n !== "desc") return false;
  }
  return symbols > 0;
};
