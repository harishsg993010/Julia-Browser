// Part 5d: style sheet loading for <link rel=stylesheet> and <style> (HTML
// "link type stylesheet", "update a style block"): fetch with the CSS MIME
// check, @import chains, mixed-content blocking, load/error events and the
// associated CSSStyleSheet objects behind `.sheet` / document.styleSheets.
(function () {
  var isStylesheetLink = function (el) { return el._ns === __jb.HTML_NS && el._tag === "link" && /(^|[\t\n\f\r ])stylesheet([\t\n\f\r ]|$)/i.test(el.getAttribute("rel") || ""); };
  var fetchText = function (url, depth) {
    // data: URLs: the body is everything after the first comma, query included (Fetch "data: URL processor").
    if (/^data:/i.test(url)) {
      var noFrag = url.split("#")[0], comma = noFrag.indexOf(",");
      if (comma < 0) return null;
      var meta = noFrag.slice(5, comma), payload = noFrag.slice(comma + 1), b64 = /;\s*base64\s*$/i.test(meta);
      var mime = (b64 ? meta.replace(/;\s*base64\s*$/i, "") : meta).split(";")[0].trim().toLowerCase() || "text/plain";
      var text;
      try { text = b64 ? __utf8Decode(__jb.b64ToBytes(decodeURIComponent(payload).replace(/\s+/g, ""))) : decodeURIComponent(payload); } catch (e) { text = payload; }
      return { ok: true, type: mime, text: text, url: url, nosniff: false };
    }
    var r = null;
    // Resource Timing: an @import is initiated by its importing sheet ("css")
    if (depth > 0 && __jb.rtHints && !__jb.rtHints[url]) __jb.rtHints[url] = "css";
    try { r = __jb.hostFetch(url, "GET", { Accept: "text/css,*/*;q=0.1" }, null, false, "", depth > 0 ? "css" : "link", { dest: "style", mode: "no-cors" }); } catch (e) { r = null; }
    if (!r || !r.result || r.error) return null;
    var st = r.result.status;
    var ct = String((r.result.headers && (r.result.headers["content-type"] || r.result.headers["Content-Type"])) || "").split(";")[0].trim().toLowerCase();
    var text = typeof r.body === "string" ? r.body : __utf8Decode(r.body || new Uint8Array(0));
    var nosniff = /(^|,)\s*nosniff\s*(,|$)/i.test(String((r.result.headers && (r.result.headers["x-content-type-options"] || r.result.headers["X-Content-Type-Options"])) || ""));
    return { ok: st >= 200 && st < 300, type: ct, text: text, url: r.result.url || url, nosniff: nosniff };
  };
  var mixedContent = function (url) { if (__jb.mixed) return __jb.mixed.blocks("style", url); try { return location.protocol === "https:" && new URL(url).protocol === "http:"; } catch (e) { return false; } };
  // Fetch a sheet and its @import chain; returns {text, url} or null on failure.
  __jb.loadStyleSheetResource = function (url, quirks, sameOrigin, depth) {
    if (depth > 8 || mixedContent(url)) return null;
    var r = fetchText(url, depth);
    if (!r || !r.ok) return null;
    if (__jb.rtCssSubresources) { try { __jb.rtCssSubresources(r.text, r.url); } catch (e) {} }
    if (r.type !== "text/css") {
      // A valid non-CSS MIME type fails (in quirks mode only cross-origin); missing/broken ones pass unless nosniff.
      var validMime = /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/.test(r.type);
      if (r.nosniff || (validMime && (!quirks || !sameOrigin(r.url)))) return null;
    }
    if (!__jb.cssImportsLoad(r.text, r.url, quirks, sameOrigin, depth)) return null;
    return r;
  };
  __jb.cssImportsLoad = function (text, base, quirks, sameOrigin, depth) {
    var re = /@import\s+(?:url\(\s*(["']?)([^"')]*)\1\s*\)|(["'])([^"']*)\3)/gi, m;
    var body = text.replace(/\/\*[\s\S]*?\*\//g, "");
    while ((m = re.exec(body))) {
      var href = m[2] !== undefined ? m[2] : m[4], u;
      try { u = new URL(href, base).href; } catch (e) { return false; }
      if (!__jb.loadStyleSheetResource(u, quirks, sameOrigin, depth + 1)) return false;
    }
    return true;
  };
  var newSheet = function (el, text, href) {
    var sh = new CSSStyleSheet(text || "");
    sh.ownerNode = el; sh.href = href || null;
    var media = el.getAttribute("media");
    if (media !== null) sh.media.mediaText = __jb.normalizeMedia(media);
    sh.title = el.getAttribute("title");
    return sh;
  };
  __jb.processLinkStylesheet = function (el, fromAttr) {
    // Touching rel/href/type without changing the request does not fetch again.
    var key = el.isConnected && isStylesheetLink(el) ? [el.getAttribute("href"), (el.getAttribute("type") || "").trim().toLowerCase(), el.getAttribute("crossorigin"), /alternate/i.test(el.getAttribute("rel") || "") ? el.getAttribute("title") : ""].join("\u0000") : null;
    if (fromAttr && key !== null && key === el._sheetKey) return;
    el._sheetKey = key;
    var gen = el._sheetGen = (el._sheetGen || 0) + 1;
    el._sheet = null;
    if (!el.isConnected || !isStylesheetLink(el)) { el._sheetKey = null; return; }
    if (/(^|[\t\n\f\r ])alternate([\t\n\f\r ]|$)/i.test(el.getAttribute("rel") || "") && !el.getAttribute("title")) { el._sheetKey = null; return; }
    var hrefAttr = el.getAttribute("href");
    if (hrefAttr === null || hrefAttr === "") return;
    var type = el.getAttribute("type");
    if (type !== null && type.trim() !== "" && !/^text\/css$/i.test(type.trim())) return;
    var url; try { url = new URL(hrefAttr, el.baseURI).href; } catch (e) { setTimeout(function () { if (el._sheetGen === gen) __jb.fireUA(el, "error"); }, 0); return; }
    var doc = el.ownerDocument;
    var origin = location.origin;
    var sameOrigin = function (u) { try { return new URL(u).origin === origin; } catch (e) { return false; } };
    setTimeout(function () {
      if (el._sheetGen !== gen || !el.isConnected) return;
      if (__jb.csp && !__jb.csp.allowsRequest("style", url, { element: el, nonce: __jb.elementNonce(el) })) { __jb.fireUA(el, "error"); return; }
      var r = __jb.loadStyleSheetResource(url, !!(doc && doc._quirks), sameOrigin, 0);
      if (el._sheetGen !== gen) return;
      if (!r) { __jb.fireUA(el, "error"); return; }
      el._sheet = newSheet(el, r.text, url);
      __jb.fireUA(el, "load");
    }, 0);
  };
  // Content Security Policy for a style block (checked once per text; blocked blocks have no sheet).
  __jb.styleBlockAllowed = function (el) {
    if (!__jb.csp || !__jb.cspPolicies().length) { el._cspBlocked = false; return true; }
    var text = el.textContent;
    if (el._cspCheckedText === text && el._cspCheckedDoc === el.ownerDocument) return !el._cspBlocked;
    el._cspCheckedText = text; el._cspCheckedDoc = el.ownerDocument;
    el._cspBlocked = !__jb.csp.allowsInline("style", el, text);
    return !el._cspBlocked;
  };
  __jb.updateStyleBlock = function (el) {
    if (!el.isConnected) { el._sheet = null; return; }
    var type = el.getAttribute("type");
    if (type !== null && type !== "" && !/^text\/css$/i.test(type)) { el._sheet = null; return; }
    if (!__jb.styleBlockAllowed(el)) { el._sheet = null; return; }
    el._sheet = newSheet(el, el.textContent, null);
  };
  var sheetDesc = { get: function () {
    if (this._tag === "link") return this.isConnected && this._sheet ? this._sheet : null;
    if (this._tag === "style") { if (!this.isConnected) return null; if (!this._sheet || this._sheetText !== this.textContent) { this._sheetText = this.textContent; __jb.updateStyleBlock(this); } return this._sheet; }
    return null;
  }, configurable: true, enumerable: true };
  __jb.defineOnInterfaces(["HTMLLinkElement", "HTMLStyleElement"], "sheet", sheetDesc);
  delete HTMLElement.prototype.sheet;
  Object.defineProperty(Document.prototype, "styleSheets", { get: function () {
    var list = __jb.descendants(this, function (n) { return n.nodeType === 1 && n._ns === __jb.HTML_NS && (n._tag === "style" || n._tag === "link"); }).map(function (n) { return n.sheet; }).filter(Boolean);
    list.item = function (i) { return this[i >>> 0] || null; };
    return list;
  }, configurable: true, enumerable: true });
  // Insertion, removal and attribute changes.
  var baseConnected = __jb.connected;
  __jb.connected = function (node) {
    baseConnected(node);
    var list = node.nodeType === 1 && (node._tag === "link" || node._tag === "style") ? [node] : [];
    if (node.nodeType === 1 && node.firstElementChild) list = list.concat(__jb.arrayFrom(node.querySelectorAll("link,style")));
    list.forEach(function (el) { if (el._ns !== __jb.HTML_NS) return; if (el._tag === "link") __jb.processLinkStylesheet(el); });
  };
  var baseAttrChanged = __jb.attributeChanged;
  __jb.attributeChanged = function (el, attr, oldValue, newValue) {
    baseAttrChanged(el, attr, oldValue, newValue);
    if (attr._ns === null && el._tag === "link" && el._ns === __jb.HTML_NS && /^(href|rel|type|media|crossorigin)$/.test(attr._local) && el.isConnected) {
      if (attr._local === "media" && el._sheet) { el._sheet.media.mediaText = newValue ? __jb.normalizeMedia(newValue) : ""; return; }
      __jb.processLinkStylesheet(el, true);
    }
  };
  // <style> load events: queued after each update of the style block.
  var styleChanged = function (st) {
    if (!st.isConnected) return;
    __jb.updateStyleBlock(st); st._sheetText = st.textContent;
    if (st._styleLoadQueued) return;
    st._styleLoadQueued = true;
    setTimeout(function () { st._styleLoadQueued = false; if (st.isConnected) { var ok = __jb.cssImportsLoad(st.textContent, st.baseURI, !!(st.ownerDocument && st.ownerDocument._quirks), function (u) { try { return new URL(u).origin === location.origin; } catch (e) { return false; } }, 0); __jb.fireUA(st, ok ? "load" : "error"); } }, 0);
  };
  var baseInsert = __jb.insert;
  __jb.insert = function (parent, node, child, suppressObservers) {
    baseInsert(parent, node, child, suppressObservers);
    if (parent.nodeType === 1 && parent._tag === "style" && parent._ns === __jb.HTML_NS) styleChanged(parent);
    if (node.nodeType === 1 && node._tag === "style" && node._ns === __jb.HTML_NS && node.parentNode === parent) styleChanged(node);
  };
  var baseRemove = __jb.remove;
  __jb.remove = function (node, suppressObservers) {
    var parent = node.parentNode;
    baseRemove(node, suppressObservers);
    if (parent && parent.nodeType === 1 && parent._tag === "style" && parent._ns === __jb.HTML_NS) styleChanged(parent);
  };
  // StyleSheet is the base interface of CSSStyleSheet.
  var StyleSheet = function StyleSheet() { throw new TypeError("Illegal constructor"); };
  Object.setPrototypeOf(CSSStyleSheet.prototype, StyleSheet.prototype);
  Object.setPrototypeOf(CSSStyleSheet, StyleSheet);
  __jb.setTag(StyleSheet, "StyleSheet");
  globalThis.StyleSheet = StyleSheet;
  // Links in the initial markup; <style> blocks of the markup fire load before the document's load event.
  __jb.initStylesheets = function () {
    var styles = __jb.descendants(__jb.currentDocument, function (n) { return n.nodeType === 1 && n._tag === "style" && n._ns === __jb.HTML_NS; });
    styles.forEach(function (st) { __jb.styleBlockAllowed(st); });
    if (styles.length) {
      var baseBefore = __jb.beforeLoadEvent;
      var fired = false;
      __jb.beforeLoadEvent = function () {
        if (!fired) { fired = true; styles.forEach(function (st) { if (st.isConnected && !st._styleLoadQueued) __jb.fireUA(st, "load"); }); }
        if (typeof baseBefore === "function") baseBefore();
      };
    }
    // Pages with many sheets: only the first few are fetched here (the layout engine loads them all).
    var links = __jb.descendants(__jb.currentDocument, function (n) { return n.nodeType === 1 && n._tag === "link" && n._ns === __jb.HTML_NS && isStylesheetLink(n); });
    links.forEach(function (l, i) {
      if (__jb.wptMode || l.hasAttribute("onload") || l.hasAttribute("onerror")) __jb.processLinkStylesheet(l);
      else if (/(^|[\t\n\f\r ])alternate([\t\n\f\r ]|$)/i.test(l.getAttribute("rel") || "") && !l.getAttribute("title")) return; // never obtained
      else { var gen = l._sheetGen = (l._sheetGen || 0) + 1; l._sheet = newSheet(l, "", l.href); setTimeout(function () { if (l._sheetGen === gen) __jb.fireUA(l, "load"); }, 0); }
    });
  };
})();
