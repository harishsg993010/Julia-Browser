// Part 20: XSLT 1.0 (XSLTProcessor) over the XPath engine of 69_xpath.js: templates with match
// patterns, modes and priorities, apply-templates / call-template with parameters, value-of,
// copy(-of), element / attribute / text / comment / processing-instruction, if / choose /
// for-each with sort, variables and parameters, attribute value templates, keys and the XSLT
// functions (current, key, generate-id, format-number, document, system-property,
// element-available, function-available, unparsed-entity-uri).
(function () {
  if (globalThis.__jb_workerRealm || !__jb.xpath) return;
  var XSL = "http://www.w3.org/1999/XSL/Transform", HTML_NS = "http://www.w3.org/1999/xhtml";
  var X = __jb.xpath;
  var XSLT_FUNCS = ["current", "document", "element-available", "format-number", "function-available", "generate-id", "key", "system-property", "unparsed-entity-uri"];
  var INSTRUCTIONS = ["apply-imports", "apply-templates", "attribute", "call-template", "choose", "comment", "copy", "copy-of", "element", "fallback", "for-each", "if", "message", "number", "processing-instruction", "text", "value-of", "variable"];
  var isXsl = function (n, local) { return n && n.nodeType === 1 && n.namespaceURI === XSL && (!local || n.localName === local); };
  var idCounter = 0, ids = new WeakMap();

  // ---- XSLT functions for the XPath engine ----
  var nsOf = function (v) { return X.isNodeSet(v) ? v.nodes : null; };
  var extra = {
    current: { min: 0, max: 0, fn: function () { var e = X.env(); return new X.NodeSet(e && e.current ? [e.current] : []); } },
    "function-available": { min: 1, max: 1, fn: function (ctx, a) { var n = X.toStr(X.evalArg(a[0], ctx)); return X.coreFunctions.indexOf(n) >= 0 || XSLT_FUNCS.indexOf(n) >= 0; } },
    "element-available": { min: 1, max: 1, fn: function (ctx, a) { var n = X.toStr(X.evalArg(a[0], ctx)); var m = /^xsl:(.*)$/.exec(n); return !!m && INSTRUCTIONS.indexOf(m[1]) >= 0; } },
    "system-property": { min: 1, max: 1, fn: function (ctx, a) { var n = X.toStr(X.evalArg(a[0], ctx)); return n === "xsl:version" ? 1 : n === "xsl:vendor" ? "julia-browser" : n === "xsl:vendor-url" ? "" : ""; } },
    "generate-id": { min: 0, max: 1, fn: function (ctx, a) {
      var n = a.length ? (nsOf(X.evalArg(a[0], ctx)) || [])[0] : ctx.node;
      if (!n) return "";
      if (!ids.has(n)) ids.set(n, "id" + (++idCounter));
      return ids.get(n);
    } },
    "unparsed-entity-uri": { min: 1, max: 1, fn: function () { return ""; } },
    "format-number": { min: 2, max: 3, fn: function (ctx, a) { return formatNumber(X.toNum(X.evalArg(a[0], ctx)), X.toStr(X.evalArg(a[1], ctx))); } },
    key: { min: 2, max: 2, fn: function (ctx, a) {
      var e = X.env(), name = X.toStr(X.evalArg(a[0], ctx)), v = X.evalArg(a[1], ctx);
      var vals = X.isNodeSet(v) ? v.nodes.map(X.stringValue) : [X.toStr(v)];
      var defs = e && e.proc ? e.proc._keys[name] || [] : [], out = [];
      var root = ctx.node; while (root.parentNode) root = root.parentNode;
      defs.forEach(function (k) {
        var matched = allNodes(root).filter(function (n) { return matchesPattern(k.match, n, e.proc); });
        matched.forEach(function (n) {
          var u = X.evaluateRaw(k.use, n, e);
          var keys = Array.isArray(u) ? u.map(X.stringValue) : [X.toStr(u)];
          if (keys.some(function (kk) { return vals.indexOf(kk) >= 0; })) out.push(n);
        });
      });
      return new X.NodeSet(X.sortUnique(out));
    } },
    // document() is disabled in browsers (no loading of other documents): an empty node-set
    document: { min: 1, max: 2, fn: function () { return new X.NodeSet([]); } },
  };
  var formatNumber = function (n, pattern) {
    if (n !== n) return "NaN";
    if (!isFinite(n)) return n > 0 ? "Infinity" : "-Infinity";
    var parts = pattern.split(";"), pat = n < 0 && parts[1] ? parts[1] : parts[0], neg = n < 0 && !parts[1];
    var pct = /%/.test(pat); if (pct) n *= 100;
    var m = /^([^#0,.]*)([#0,]*)(?:\.([#0]*))?(.*)$/.exec(pat);
    if (!m) return X.numToStr(n);
    var intPat = m[2], fracPat = m[3] || "", minInt = (intPat.replace(/[^0]/g, "")).length, minFrac = (fracPat.match(/0/g) || []).length, maxFrac = fracPat.length;
    var abs = Math.abs(n), fixed = abs.toFixed(maxFrac);
    var ip = fixed.split(".")[0], fp = fixed.split(".")[1] || "";
    while (fp.length > minFrac && fp.charAt(fp.length - 1) === "0") fp = fp.slice(0, -1);
    while (ip.length < minInt) ip = "0" + ip;
    if (minInt === 0 && ip === "0") ip = "";
    var g = intPat.lastIndexOf(",") >= 0 ? intPat.length - intPat.lastIndexOf(",") - 1 : 0;
    if (g > 0) { var re = new RegExp("\\B(?=(\\d{" + g + "})+(?!\\d))", "g"); ip = ip.replace(re, ","); }
    return (neg ? "-" : "") + m[1] + ip + (fp ? "." + fp : "") + m[4];
  };
  var allNodes = function (root) {
    var out = [root];
    var walk = function (n) { for (var c = n.firstChild; c; c = c.nextSibling) { out.push(c); if (c.nodeType === 1) { Array.prototype.forEach.call(c.attributes, function (at) { if (at.namespaceURI !== "http://www.w3.org/2000/xmlns/") out.push(at); }); walk(c); } } };
    walk(root);
    return out;
  };

  // ---- patterns ----
  var compileExpr = function (expr, nsNode) {
    var resolve = function (prefix) {
      var uri = nsNode && nsNode.lookupNamespaceURI ? nsNode.lookupNamespaceURI(prefix) : null;
      if (prefix === "xml") return "http://www.w3.org/XML/1998/namespace";
      if (!uri) throw __jb.domError("NamespaceError", "XSLT: prefix '" + prefix + "' is not bound");
      return uri;
    };
    resolve.__direct = true;
    return X.compile(expr, resolve, extra);
  };
  var defaultPriority = function (p) {
    p = p.trim();
    if (/\|/.test(p)) return 0.5;
    if (/^(@)?(child::|attribute::)?[\w.-]+(:[\w.-]+)?$/.test(p) && !/^(@)?(child::|attribute::)?(node|text|comment|processing-instruction)$/.test(p)) return /:\*$/.test(p) ? -0.25 : 0;
    if (/^(@)?(child::|attribute::)?[\w.-]+:\*$/.test(p)) return -0.25;
    if (/^(@)?(child::|attribute::)?(\*|node\(\)|text\(\)|comment\(\)|processing-instruction\(\))$/.test(p)) return -0.5;
    if (/^processing-instruction\(\s*["'][^"']*["']\s*\)$/.test(p)) return 0;
    return 0.5;
  };
  // A node matches a pattern branch when the branch, evaluated as an expression from the root
  // (absolute branches) or from one of the node's ancestors (relative ones), selects it.
  var matchesPattern = function (pat, node, proc) {
    var env = { vars: proc ? proc._globalVars || {} : {}, proc: proc };
    for (var i = 0; i < pat.branches.length; i++) {
      var b = pat.branches[i];
      if (b.root) { if (node.nodeType === 9 || (node.nodeType === 11 && !node.parentNode)) return true; continue; }
      var start = node.nodeType === 2 ? node.ownerElement : node.parentNode;
      var ctxs = [];
      for (var n = start; n; n = n.parentNode) ctxs.push(n);
      if (b.absolute) ctxs = ctxs.length ? [ctxs[ctxs.length - 1]] : [];
      for (var c = 0; c < ctxs.length; c++) {
        var r;
        try { r = X.evaluateRaw(b.ast, ctxs[c], env); } catch (e) { r = null; }
        if (Array.isArray(r) && r.indexOf(node) >= 0) return true;
      }
    }
    return false;
  };
  var compilePattern = function (text, nsNode) {
    var parts = [], depth = 0, cur = "", q = null;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (q) { if (ch === q) q = null; cur += ch; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === "[" || ch === "(") depth++; else if (ch === "]" || ch === ")") depth--;
      if (ch === "|" && !depth) { parts.push(cur); cur = ""; } else cur += ch;
    }
    parts.push(cur);
    return { text: text, parts: parts.map(function (x) { return x.trim(); }), branches: parts.map(function (part) {
      part = part.trim();
      if (part === "/") return { root: true };
      return { absolute: part.charAt(0) === "/", ast: compileExpr(part, nsNode) };
    }) };
  };

  // ---- the processor ----
  function XSLTProcessor() {
    if (!new.target) throw new TypeError("Constructor XSLTProcessor requires 'new'");
    Object.defineProperty(this, "_params", { value: new Map(), writable: true });
    Object.defineProperty(this, "_sheet", { value: null, writable: true });
  }
  var P = XSLTProcessor.prototype;
  P.importStylesheet = function (style) {
    if (arguments.length < 1) throw new TypeError("XSLTProcessor.importStylesheet: 1 argument required");
    if (!style || (style.nodeType !== 9 && style.nodeType !== 1)) throw new TypeError("XSLTProcessor.importStylesheet: Argument 1 is not a Document or Element");
    var root = style.nodeType === 9 ? style.documentElement : style;
    if (!root) throw __jb.domError("InvalidStateError", "XSLTProcessor: the stylesheet is empty");
    this._sheet = root;
    this._sheetDoc = style.nodeType === 9 ? style : style.ownerDocument;
    var templates = [], named = Object.create(null), keys = Object.create(null), globals = [], output = { method: null }, self = this;
    if (isXsl(root, "stylesheet") || isXsl(root, "transform")) {
      var order = 0;
      Array.prototype.forEach.call(root.children, function (c) {
        if (isXsl(c, "template")) {
          var t = { node: c, order: order++, mode: c.getAttribute("mode") || "", name: c.getAttribute("name") };
          if (c.hasAttribute("match")) { t.pattern = compilePattern(c.getAttribute("match"), c); t.priority = c.hasAttribute("priority") ? Number(c.getAttribute("priority")) : null; }
          templates.push(t);
          if (t.name) named[t.name] = t;
        } else if (isXsl(c, "key")) {
          (keys[c.getAttribute("name")] = keys[c.getAttribute("name")] || []).push({ match: compilePattern(c.getAttribute("match") || "*", c), use: compileExpr(c.getAttribute("use") || ".", c) });
        } else if (isXsl(c, "variable") || isXsl(c, "param")) globals.push(c);
        else if (isXsl(c, "output")) output.method = (c.getAttribute("method") || "").toLowerCase() || null;
      });
    } else {
      // a literal result element as stylesheet: one template matching "/"
      templates.push({ node: root, order: 0, mode: "", literal: true, pattern: compilePattern("/", root), priority: 0 });
    }
    this._templates = templates; this._named = named; this._keys = keys; this._globals = globals; this._output = output;
  };
  P.setParameter = function (ns, name, value) { if (arguments.length < 3) throw new TypeError("XSLTProcessor.setParameter: 3 arguments required"); this._params.set(String(name), value); };
  P.getParameter = function (ns, name) { var v = this._params.get(String(name)); return v === undefined ? null : v; };
  P.removeParameter = function (ns, name) { this._params.delete(String(name)); };
  P.clearParameters = function () { this._params.clear(); };
  P.reset = function () { this._params.clear(); this._sheet = null; this._templates = null; };
  P.transformToFragment = function (source, output) {
    if (arguments.length < 2) throw new TypeError("XSLTProcessor.transformToFragment: 2 arguments required");
    if (!this._sheet) return null;
    var frag = output.createDocumentFragment();
    run(this, source, output, frag);
    return frag;
  };
  P.transformToDocument = function (source) {
    if (arguments.length < 1) throw new TypeError("XSLTProcessor.transformToDocument: 1 argument required");
    if (!this._sheet) return null;
    var html = this._output.method === "html" || (!this._output.method && false);
    var doc = html ? document.implementation.createHTMLDocument("") : document.implementation.createDocument(null, null, null);
    if (html) { while (doc.firstChild) doc.removeChild(doc.firstChild); }
    var frag = doc.createDocumentFragment();
    run(this, source, doc, frag);
    doc.appendChild(frag);
    return doc;
  };
  Object.defineProperty(P, Symbol.toStringTag, { value: "XSLTProcessor", configurable: true });

  var run = function (proc, source, outDoc, target) {
    var env0 = { vars: {}, proc: proc, current: source };
    proc._globalVars = env0.vars;
    proc._outDoc = outDoc;
    proc._html = proc._output.method === "html" || (outDoc._isHTML && proc._output.method !== "xml");
    proc._globals.forEach(function (g) {
      var name = g.getAttribute("name");
      if (isXsl(g, "param") && proc._params.has(name)) { env0.vars[name] = paramValue(proc._params.get(name)); return; }
      env0.vars[name] = varValue(proc, g, source, env0);
    });
    var root = source.nodeType === 9 ? source : source;
    applyTemplates(proc, [root], "", env0, target, {});
  };
  var paramValue = function (v) { if (v && typeof v === "object" && typeof v.nodeType === "number") return [v]; if (v && typeof v === "object" && typeof v.length === "number") return __jb.arrayFrom(v); return v; };
  var evalX = function (expr, node, env, contextNode, pos, size) {
    return X.evaluateRaw(compileExpr(expr, contextNode), node, env, pos, size);
  };
  var varValue = function (proc, el, node, env, pos, size) {
    if (el.hasAttribute("select")) return evalX(el.getAttribute("select"), node, env, el, pos, size);
    if (!el.firstChild) return "";
    // a result tree fragment: built into a fragment and used as a node-set of its root
    var frag = proc._outDoc.createDocumentFragment();
    instantiate(proc, el, node, env, frag, pos, size);
    return [frag];
  };
  var bestTemplate = function (proc, node, mode) {
    var best = null, bestPrio = -Infinity;
    proc._templates.forEach(function (t) {
      if (!t.pattern || t.mode !== mode) return;
      if (!matchesPattern(t.pattern, node, proc)) return;
      var prio = t.priority !== null && t.priority !== undefined ? t.priority : Math.max.apply(null, t.pattern.parts.map(defaultPriority));
      if (prio > bestPrio || (prio === bestPrio && (!best || t.order > best.order))) { best = t; bestPrio = prio; }
    });
    return best;
  };
  var applyTemplates = function (proc, nodes, mode, env, target, params) {
    nodes.forEach(function (node, i) {
      var t = bestTemplate(proc, node, mode);
      if (t) {
        var env2 = { vars: Object.assign(Object.create(null), proc._globalVars), proc: proc, current: node };
        bindParams(proc, t.node, params, node, env2);
        if (t.literal) instantiateElement(proc, t.node, node, env2, target, i + 1, nodes.length);
        else instantiate(proc, t.node, node, env2, target, i + 1, nodes.length);
        return;
      }
      // built-in templates
      if (node.nodeType === 9 || node.nodeType === 1 || node.nodeType === 11) applyTemplates(proc, childNodes(node), mode, env, target, {});
      else if (node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 2) appendText(proc, target, node.nodeType === 2 ? node.value : node.data);
    });
  };
  var childNodes = function (n) { return __jb.A.filter.call(n.childNodes, function (c) { return c.nodeType !== 10; }); };
  var bindParams = function (proc, tnode, params, node, env) {
    Array.prototype.forEach.call(tnode.children, function (c) {
      if (!isXsl(c, "param")) return;
      var name = c.getAttribute("name");
      env.vars[name] = Object.prototype.hasOwnProperty.call(params, name) ? params[name] : varValue(proc, c, node, env);
    });
  };
  var withParams = function (proc, el, node, env, pos, size) {
    var out = {};
    Array.prototype.forEach.call(el.children, function (c) { if (isXsl(c, "with-param")) out[c.getAttribute("name")] = varValue(proc, c, node, env, pos, size); });
    return out;
  };
  var appendText = function (proc, target, text) {
    if (!text) return;
    var last = target.lastChild;
    if (last && last.nodeType === 3) last.appendData(text);
    else target.appendChild(proc._outDoc.createTextNode(text));
  };
  var avt = function (proc, text, node, env, ctxEl, pos, size) {
    return String(text).replace(/\{\{|\}\}|\{([^}]*)\}/g, function (m, expr) {
      if (m === "{{") return "{"; if (m === "}}") return "}";
      return X.toStr(wrap(evalX(expr, node, env, ctxEl, pos, size)));
    });
  };
  var wrap = function (v) { return Array.isArray(v) ? new X.NodeSet(v) : v; };
  var sorted = function (proc, el, nodes, env) {
    var sorts = __jb.A.filter.call(el.children, function (c) { return isXsl(c, "sort"); });
    if (!sorts.length) return nodes;
    var keyed = nodes.map(function (n, i) {
      return { n: n, i: i, keys: sorts.map(function (s) {
        var v = X.toStr(wrap(evalX(s.getAttribute("select") || ".", n, Object.assign({}, env, { current: n }), s, i + 1, nodes.length)));
        return (s.getAttribute("data-type") || "text") === "number" ? Number(v) : v;
      }) };
    });
    keyed.sort(function (a, b) {
      for (var k = 0; k < sorts.length; k++) {
        var desc = (sorts[k].getAttribute("order") || "ascending") === "descending", x = a.keys[k], y = b.keys[k], c;
        if (typeof x === "number") c = (x !== x ? -Infinity : x) - (y !== y ? -Infinity : y);
        else c = x < y ? -1 : x > y ? 1 : 0;
        if (c) return desc ? -c : c;
      }
      return a.i - b.i;
    });
    return keyed.map(function (k) { return k.n; });
  };
  var instantiate = function (proc, el, node, env, target, pos, size) {
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 || c.nodeType === 4) { if (/\S/.test(c.data) || isXsl(el, "text")) appendText(proc, target, c.data); continue; }
      if (c.nodeType !== 1) continue;
      if (isXsl(c)) instruction(proc, c, node, env, target, pos, size);
      else instantiateElement(proc, c, node, env, target, pos, size);
    }
  };
  var createEl = function (proc, ns, qname) {
    var doc = proc._outDoc;
    if (proc._html && (!ns || ns === HTML_NS)) return doc.createElement(qname.replace(/^.*:/, ""));
    return ns ? doc.createElementNS(ns, qname) : doc.createElementNS(null, qname);
  };
  var instantiateElement = function (proc, lre, node, env, target, pos, size) {
    var el = createEl(proc, lre.namespaceURI, lre.nodeName);
    Array.prototype.forEach.call(lre.attributes, function (at) {
      if (at.namespaceURI === XSL || at.namespaceURI === "http://www.w3.org/2000/xmlns/") return;
      var v = avt(proc, at.value, node, env, lre, pos, size);
      if (at.namespaceURI) el.setAttributeNS(at.namespaceURI, at.name, v); else el.setAttribute(at.name, v);
    });
    target.appendChild(el);
    instantiate(proc, lre, node, env, el, pos, size);
  };
  var copyNode = function (proc, n, target, deep) {
    var doc = proc._outDoc;
    if (n.nodeType === 2) { if (target.nodeType === 1) { if (n.namespaceURI) target.setAttributeNS(n.namespaceURI, n.name, n.value); else target.setAttribute(n.name, n.value); } return null; }
    if (n.nodeType === 9 || n.nodeType === 11) { if (deep) Array.prototype.forEach.call(n.childNodes, function (c) { if (c.nodeType !== 10) copyNode(proc, c, target, true); }); return null; }
    if (n.nodeType === 3 || n.nodeType === 4) { appendText(proc, target, n.data); return null; }
    if (n.nodeType === 8) { target.appendChild(doc.createComment(n.data)); return null; }
    if (n.nodeType === 7) { target.appendChild(doc.createProcessingInstruction(n.target, n.data)); return null; }
    if (n.nodeType !== 1) return null;
    var el = createEl(proc, n.namespaceURI, n.nodeName);
    if (deep) {
      Array.prototype.forEach.call(n.attributes, function (at) { if (at.namespaceURI === "http://www.w3.org/2000/xmlns/") return; if (at.namespaceURI) el.setAttributeNS(at.namespaceURI, at.name, at.value); else el.setAttribute(at.name, at.value); });
      Array.prototype.forEach.call(n.childNodes, function (c) { copyNode(proc, c, el, true); });
    }
    target.appendChild(el);
    return el;
  };
  var instruction = function (proc, c, node, env, target, pos, size) {
    var a = function (n) { return c.getAttribute(n); };
    switch (c.localName) {
      case "apply-templates": {
        var sel = a("select") ? evalX(a("select"), node, env, c, pos, size) : childNodes(node);
        if (!Array.isArray(sel)) throw __jb.domError("SyntaxError", "XSLT: apply-templates select is not a node-set");
        applyTemplates(proc, sorted(proc, c, sel, env), a("mode") || "", env, target, withParams(proc, c, node, env, pos, size));
        return;
      }
      case "call-template": {
        var t = proc._named[a("name")];
        if (!t) return;
        var env2 = { vars: Object.assign(Object.create(null), proc._globalVars), proc: proc, current: env.current };
        bindParams(proc, t.node, withParams(proc, c, node, env, pos, size), node, env2);
        instantiate(proc, t.node, node, env2, target, pos, size);
        return;
      }
      case "value-of": appendText(proc, target, X.toStr(wrap(evalX(a("select") || ".", node, env, c, pos, size)))); return;
      case "copy-of": {
        var v = evalX(a("select"), node, env, c, pos, size);
        if (Array.isArray(v)) v.forEach(function (n) { copyNode(proc, n, target, true); });
        else appendText(proc, target, X.toStr(v));
        return;
      }
      case "copy": {
        var copied = copyNode(proc, node, target, false);
        if (copied || node.nodeType === 9) instantiate(proc, c, node, env, copied || target, pos, size);
        return;
      }
      case "element": {
        var name = avt(proc, a("name"), node, env, c, pos, size), ns = c.hasAttribute("namespace") ? avt(proc, a("namespace"), node, env, c, pos, size) : (name.indexOf(":") > 0 ? c.lookupNamespaceURI(name.split(":")[0]) : c.lookupNamespaceURI(null));
        var el = createEl(proc, ns || null, name);
        target.appendChild(el);
        instantiate(proc, c, node, env, el, pos, size);
        return;
      }
      case "attribute": {
        if (target.nodeType !== 1) return;
        var an = avt(proc, a("name"), node, env, c, pos, size), tmp = proc._outDoc.createDocumentFragment();
        instantiate(proc, c, node, env, tmp, pos, size);
        var ans = c.hasAttribute("namespace") ? avt(proc, a("namespace"), node, env, c, pos, size) : null;
        if (ans) target.setAttributeNS(ans, an, tmp.textContent); else target.setAttribute(an, tmp.textContent);
        return;
      }
      case "text": appendText(proc, target, c.textContent); return;
      case "comment": { var tc = proc._outDoc.createDocumentFragment(); instantiate(proc, c, node, env, tc, pos, size); target.appendChild(proc._outDoc.createComment(tc.textContent)); return; }
      case "processing-instruction": { var tp = proc._outDoc.createDocumentFragment(); instantiate(proc, c, node, env, tp, pos, size); target.appendChild(proc._outDoc.createProcessingInstruction(avt(proc, a("name"), node, env, c, pos, size), tp.textContent)); return; }
      case "if": if (X.toBool(wrap(evalX(a("test"), node, env, c, pos, size)))) instantiate(proc, c, node, env, target, pos, size); return;
      case "choose": {
        for (var w = c.firstElementChild; w; w = w.nextElementSibling) {
          if (isXsl(w, "when")) { if (X.toBool(wrap(evalX(w.getAttribute("test"), node, env, w, pos, size)))) { instantiate(proc, w, node, env, target, pos, size); return; } }
          else if (isXsl(w, "otherwise")) { instantiate(proc, w, node, env, target, pos, size); return; }
        }
        return;
      }
      case "for-each": {
        var items = evalX(a("select"), node, env, c, pos, size);
        if (!Array.isArray(items)) throw __jb.domError("SyntaxError", "XSLT: for-each select is not a node-set");
        items = sorted(proc, c, items, env);
        items.forEach(function (n, i) { instantiate(proc, c, n, Object.assign({}, env, { vars: env.vars, current: n }), target, i + 1, items.length); });
        return;
      }
      case "variable": case "param": env.vars[a("name")] = varValue(proc, c, node, env, pos, size); return;
      case "number": {
        var num;
        if (c.hasAttribute("value")) num = X.toNum(wrap(evalX(a("value"), node, env, c, pos, size)));
        else { num = 1; for (var s = node.previousSibling; s; s = s.previousSibling) if (s.nodeType === node.nodeType && s.nodeName === node.nodeName) num++; }
        appendText(proc, target, a("format") ? formatNumber(Math.round(num), a("format").replace(/1/g, "0")) : X.numToStr(Math.round(num)));
        return;
      }
      case "message": case "fallback": case "sort": case "with-param": return;
    }
  };
  globalThis.XSLTProcessor = XSLTProcessor;
})();
