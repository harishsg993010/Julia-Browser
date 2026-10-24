// Part 10: XPath 1.0 (DOM XPathEvaluator / XPathExpression / XPathResult) over the JS DOM,
// with the HTML spec's rules for text/html documents (case-insensitive names of HTML elements
// and attributes, unprefixed element names match the HTML namespace).
(function () {
  var HTML_NS = "http://www.w3.org/1999/xhtml", XMLNS_NS = "http://www.w3.org/2000/xmlns/", XML_NS = "http://www.w3.org/XML/1998/namespace";
  var syntaxError = function (msg) { return __jb.domError("SyntaxError", "XPath: " + msg); };
  var asciiLower = function (s) { return s.replace(/[A-Z]+/g, function (c) { return c.toLowerCase(); }); };

  // ---------------------------------------------------------------- lexer
  var NAME_START = "A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\uD800-\\uDBFF\\uDC00-\\uDFFF";
  var NAME_CHAR = NAME_START + "\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040";
  var NCNAME = new RegExp("^[" + NAME_START + "][" + NAME_CHAR + "]*");
  var NODE_TYPES = { comment: 1, text: 1, "processing-instruction": 1, node: 1 };
  var AXES = { ancestor: 1, "ancestor-or-self": 1, attribute: 1, child: 1, descendant: 1, "descendant-or-self": 1, following: 1, "following-sibling": 1, namespace: 1, parent: 1, preceding: 1, "preceding-sibling": 1, self: 1 };
  var isWs = function (c) { return c === " " || c === "\t" || c === "\r" || c === "\n"; };

  function tokenize(src) {
    var toks = [], i = 0, n = src.length;
    var prevAllowsOperand = function () {
      // Section 3.7: '*' is a multiply operator and an NCName an operator name unless the
      // previous token is absent or one of @ :: ( [ , or an operator.
      if (!toks.length) return true;
      var p = toks[toks.length - 1];
      return p.t === "@" || p.t === "::" || p.t === "(" || p.t === "[" || p.t === "," || p.op;
    };
    while (i < n) {
      var c = src[i];
      if (isWs(c)) { i++; continue; }
      var two = src.substr(i, 2);
      if (two === "//" || two === "::" || two === ".." || two === "!=" || two === "<=" || two === ">=") {
        toks.push({ t: two, op: two === "!=" || two === "<=" || two === ">=" || two === "//" }); i += 2; continue;
      }
      if (c === "." && !/[0-9]/.test(src[i + 1] || "")) { toks.push({ t: "." }); i++; continue; }
      if ("()[]@,".indexOf(c) >= 0) { toks.push({ t: c }); i++; continue; }
      if ("/|+-=<>".indexOf(c) >= 0) { toks.push({ t: c, op: true }); i++; continue; }
      if (c === "*") {
        if (prevAllowsOperand()) toks.push({ t: "name", prefix: null, local: "*" });
        else toks.push({ t: "*", op: true });
        i++; continue;
      }
      if (c === "\"" || c === "'") {
        var end = src.indexOf(c, i + 1);
        if (end < 0) throw syntaxError("unterminated literal");
        toks.push({ t: "literal", v: src.slice(i + 1, end) }); i = end + 1; continue;
      }
      if (/[0-9.]/.test(c)) {
        var m = /^([0-9]+(\.[0-9]*)?|\.[0-9]+)/.exec(src.slice(i));
        toks.push({ t: "number", v: parseFloat(m[0]) }); i += m[0].length; continue;
      }
      if (c === "$") {
        var vm = NCNAME.exec(src.slice(i + 1));
        if (!vm) throw syntaxError("bad variable reference");
        var vlen = vm[0].length, vname = vm[0];
        if (src[i + 1 + vlen] === ":" && src[i + 2 + vlen] !== ":") { var vm2 = NCNAME.exec(src.slice(i + 2 + vlen)); if (vm2) { vname += ":" + vm2[0]; vlen += 1 + vm2[0].length; } }
        toks.push({ t: "var", v: vname }); i += 1 + vlen; continue;
      }
      var nm = NCNAME.exec(src.slice(i));
      if (!nm) throw syntaxError("unexpected character '" + c + "'");
      var name = nm[0]; i += name.length;
      if (!prevAllowsOperand()) {
        if (name === "and" || name === "or" || name === "mod" || name === "div") { toks.push({ t: name, op: true }); continue; }
        throw syntaxError("unexpected name '" + name + "'");
      }
      // QName / NCName:*
      var prefix = null;
      if (src[i] === ":" && src[i + 1] !== ":") {
        if (src[i + 1] === "*") { toks.push({ t: "name", prefix: name, local: "*" }); i += 2; continue; }
        var lm = NCNAME.exec(src.slice(i + 1));
        if (!lm) throw syntaxError("bad qualified name");
        prefix = name; name = lm[0]; i += 1 + name.length;
      }
      var j = i; while (j < n && isWs(src[j])) j++;
      if (prefix === null && src.substr(j, 2) === "::") {
        if (!AXES[name]) throw syntaxError("unknown axis '" + name + "'");
        toks.push({ t: "axis", v: name }); continue;
      }
      if (src[j] === "(") {
        if (prefix === null && NODE_TYPES[name]) toks.push({ t: "nodetype", v: name });
        else toks.push({ t: "func", v: prefix === null ? name : prefix + ":" + name });
        continue;
      }
      toks.push({ t: "name", prefix: prefix, local: name });
    }
    return toks;
  }

  // ---------------------------------------------------------------- parser
  function Parser(toks, resolve, extra) { this.toks = toks; this.i = 0; this.resolve = resolve; this.extra = extra || null; }
  Parser.prototype.peek = function (k) { var t = this.toks[this.i + (k || 0)]; return t ? t.t : null; };
  Parser.prototype.next = function () { return this.toks[this.i++]; };
  Parser.prototype.expect = function (t) { if (this.peek() !== t) throw syntaxError("expected '" + t + "'"); return this.next(); };
  Parser.prototype.binary = function (sub, ops) {
    var left = sub.call(this);
    while (ops.indexOf(this.peek()) >= 0) { var op = this.next().t; left = { k: "bin", op: op, a: left, b: sub.call(this) }; }
    return left;
  };
  Parser.prototype.expr = function () { return this.or(); };
  Parser.prototype.or = function () { return this.binary(this.and, ["or"]); };
  Parser.prototype.and = function () { return this.binary(this.eq, ["and"]); };
  Parser.prototype.eq = function () { return this.binary(this.rel, ["=", "!="]); };
  Parser.prototype.rel = function () { return this.binary(this.add, ["<", ">", "<=", ">="]); };
  Parser.prototype.add = function () { return this.binary(this.mul, ["+", "-"]); };
  Parser.prototype.mul = function () { return this.binary(this.unary, ["*", "div", "mod"]); };
  Parser.prototype.unary = function () {
    if (this.peek() === "-") { this.next(); return { k: "neg", a: this.unary() }; }
    return this.union();
  };
  Parser.prototype.union = function () {
    var left = this.path();
    while (this.peek() === "|") { this.next(); left = { k: "union", a: left, b: this.path() }; }
    return left;
  };
  Parser.prototype.isStepStart = function () {
    var t = this.peek();
    return t === "name" || t === "nodetype" || t === "axis" || t === "@" || t === "." || t === "..";
  };
  Parser.prototype.path = function () {
    var t = this.peek();
    if (t === "var" || t === "(" || t === "literal" || t === "number" || t === "func") {
      var filter = this.primary(), preds = [];
      while (this.peek() === "[") preds.push(this.predicate());
      if (preds.length) filter = { k: "filter", a: filter, preds: preds };
      if (this.peek() === "/" || this.peek() === "//") {
        var steps = [];
        if (this.next().t === "//") steps.push({ axis: "descendant-or-self", test: { type: "node" }, preds: [] });
        this.relPath(steps);
        return { k: "path", filter: filter, steps: steps };
      }
      return filter;
    }
    var steps2 = [], abs = false;
    if (t === "/") {
      this.next(); abs = true;
      if (this.isStepStart()) this.relPath(steps2);
    } else if (t === "//") {
      this.next(); abs = true;
      steps2.push({ axis: "descendant-or-self", test: { type: "node" }, preds: [] });
      this.relPath(steps2);
    } else if (this.isStepStart()) {
      this.relPath(steps2);
    } else {
      throw syntaxError(t === null ? "unexpected end of expression" : "unexpected token '" + t + "'");
    }
    return { k: "path", abs: abs, steps: steps2 };
  };
  Parser.prototype.relPath = function (steps) {
    steps.push(this.step());
    for (;;) {
      var t = this.peek();
      if (t === "/") { this.next(); steps.push(this.step()); }
      else if (t === "//") { this.next(); steps.push({ axis: "descendant-or-self", test: { type: "node" }, preds: [] }); steps.push(this.step()); }
      else break;
    }
  };
  Parser.prototype.step = function () {
    var t = this.peek();
    if (t === ".") { this.next(); return { axis: "self", test: { type: "node" }, preds: [] }; }
    if (t === "..") { this.next(); return { axis: "parent", test: { type: "node" }, preds: [] }; }
    var axis = "child";
    if (t === "@") { this.next(); axis = "attribute"; }
    else if (t === "axis") { axis = this.next().v; this.expect("::"); }
    var test;
    var tok = this.next();
    if (!tok) throw syntaxError("expected a node test");
    if (tok.t === "name") {
      var ns = null;
      if (tok.prefix !== null) ns = this.resolve(tok.prefix);
      test = { type: "name", prefix: tok.prefix, ns: ns, local: tok.local };
    } else if (tok.t === "nodetype") {
      this.expect("(");
      test = { type: tok.v };
      if (tok.v === "processing-instruction" && this.peek() === "literal") test.target = this.next().v;
      this.expect(")");
    } else throw syntaxError("expected a node test");
    var preds = [];
    while (this.peek() === "[") preds.push(this.predicate());
    return { axis: axis, test: test, preds: preds };
  };
  Parser.prototype.predicate = function () { this.expect("["); var e = this.expr(); this.expect("]"); return e; };
  Parser.prototype.primary = function () {
    var tok = this.next();
    switch (tok.t) {
      case "var": return { k: "var", v: tok.v };
      case "(": { var e = this.expr(); this.expect(")"); return e; }
      case "literal": return { k: "lit", v: tok.v };
      case "number": return { k: "num", v: tok.v };
      case "func": {
        var f = Object.prototype.hasOwnProperty.call(FUNCS, tok.v) ? FUNCS[tok.v] : this.extra && Object.prototype.hasOwnProperty.call(this.extra, tok.v) ? this.extra[tok.v] : null;
        if (!f) throw syntaxError("unknown function " + tok.v + "()");
        this.expect("(");
        var args = [];
        if (this.peek() !== ")") { args.push(this.expr()); while (this.peek() === ",") { this.next(); args.push(this.expr()); } }
        this.expect(")");
        if (args.length < f.min || args.length > f.max) throw syntaxError("wrong number of arguments to " + tok.v + "()");
        return { k: "call", f: f, name: tok.v, args: args };
      }
    }
    throw syntaxError("unexpected token");
  };

  // ---------------------------------------------------------------- data model
  var isAttr = function (n) { return n.nodeType === 2; };
  var parentOf = function (n) {
    if (isAttr(n)) return n.ownerElement;
    var p = n.parentNode;
    return p;
  };
  // Children as XPath sees them: no doctype nodes (not part of the data model).
  var childrenOf = function (n) {
    var out = [];
    if (isAttr(n)) return out;
    for (var c = n.firstChild; c; c = c.nextSibling) if (c.nodeType !== 10) out.push(c);
    return out;
  };
  var attrsOf = function (el) {
    var out = [];
    if (!el || el.nodeType !== 1) return out;
    var list = el._attrs || el.attributes;
    for (var i = 0; i < list.length; i++) { var a = list[i]; if (a.namespaceURI !== XMLNS_NS) out.push(a); }
    return out;
  };
  var rootOf = function (n) {
    if (isAttr(n)) n = n.ownerElement || n;
    while (n.parentNode) n = n.parentNode;
    return n;
  };
  var isHTMLDoc = function (n) { var d = n.nodeType === 9 ? n : n.ownerDocument; return !!(d && d._isHTML); };
  var stringValue = function (n) {
    switch (n.nodeType) {
      case 1: case 9: case 11: {
        var s = "", stack = [n];
        // Concatenated text descendants in document order.
        var walk = function (x) { for (var c = x.firstChild; c; c = c.nextSibling) { if (c.nodeType === 3 || c.nodeType === 4) s += c.data; else if (c.nodeType === 1) walk(c); } };
        walk(n);
        return s;
      }
      case 2: return n.value;
      case 3: case 4: case 7: case 8: return n.data;
    }
    return "";
  };
  // Document order, with attributes right after their element (before its children).
  var order = function (a, b) {
    if (a === b) return 0;
    var ea = isAttr(a) ? a.ownerElement : a, eb = isAttr(b) ? b.ownerElement : b;
    if (ea && ea === eb) {
      if (!isAttr(a)) return -1;
      if (!isAttr(b)) return 1;
      var list = ea._attrs || ea.attributes;
      for (var i = 0; i < list.length; i++) { if (list[i] === a) return -1; if (list[i] === b) return 1; }
      return 0;
    }
    if (!ea || !eb) return ea ? 1 : -1;
    var pos = ea.compareDocumentPosition(eb);
    if (pos & 4) return -1;
    if (pos & 2) return 1;
    return 0;
  };
  var sortUnique = function (nodes) {
    if (nodes.length < 2) return nodes;
    var seen = new Set(), out = [];
    for (var i = 0; i < nodes.length; i++) if (!seen.has(nodes[i])) { seen.add(nodes[i]); out.push(nodes[i]); }
    out.sort(order);
    return out;
  };

  // ---------------------------------------------------------------- axes
  var descendants = function (n, out) {
    for (var c = n.firstChild; c; c = c.nextSibling) { if (c.nodeType === 10) continue; out.push(c); descendants(c, out); }
    return out;
  };
  // Nodes in axis order (reverse axes nearest first).
  var axisNodes = function (axis, n) {
    var out = [], p;
    switch (axis) {
      case "child": return childrenOf(n);
      case "descendant": return isAttr(n) ? out : descendants(n, out);
      case "descendant-or-self": out.push(n); return isAttr(n) ? out : descendants(n, out);
      case "self": return [n];
      case "parent": p = parentOf(n); return p ? [p] : out;
      case "ancestor": for (p = parentOf(n); p; p = parentOf(p)) out.push(p); return out;
      case "ancestor-or-self": for (p = n; p; p = parentOf(p)) out.push(p); return out;
      case "attribute": return attrsOf(n);
      case "namespace": return out;
      case "following-sibling": if (isAttr(n)) return out; for (p = n.nextSibling; p; p = p.nextSibling) if (p.nodeType !== 10) out.push(p); return out;
      case "preceding-sibling": if (isAttr(n)) return out; for (p = n.previousSibling; p; p = p.previousSibling) if (p.nodeType !== 10) out.push(p); return out;
      case "following": {
        var start = n;
        if (isAttr(n)) { start = n.ownerElement; if (!start) return out; descendants(start, out); }
        for (var x = start; x; x = parentOf(x)) {
          for (var s = x.nextSibling; s; s = s.nextSibling) { if (s.nodeType === 10) continue; out.push(s); descendants(s, out); }
        }
        return out;
      }
      case "preceding": {
        var st = isAttr(n) ? n.ownerElement : n;
        if (!st) return out;
        for (var y = st; y; y = parentOf(y)) {
          for (var ps = y.previousSibling; ps; ps = ps.previousSibling) {
            if (ps.nodeType === 10) continue;
            var sub = descendants(ps, []);
            for (var k = sub.length - 1; k >= 0; k--) out.push(sub[k]);
            out.push(ps);
          }
        }
        return out;
      }
    }
    return out;
  };
  var REVERSE = { ancestor: 1, "ancestor-or-self": 1, preceding: 1, "preceding-sibling": 1 };

  var matches = function (test, axis, n) {
    var t = n.nodeType;
    switch (test.type) {
      case "node": return true;
      case "text": return t === 3 || t === 4;
      case "comment": return t === 8;
      case "processing-instruction": return t === 7 && (test.target === undefined || n.target === test.target);
    }
    // name test: the principal node type is attribute on the attribute axis, element otherwise
    if (axis === "attribute" ? t !== 2 : t !== 1) return false;
    var ns = n.namespaceURI, local = n.localName;
    if (test.prefix === null && test.local === "*") return true;
    if (test.prefix !== null) {
      if (ns !== test.ns) return false;
      if (test.local === "*") return true;
      if (t === 1 && ns === HTML_NS && isHTMLDoc(n)) return asciiLower(test.local) === local;
      return local === test.local;
    }
    // unprefixed name
    if (t === 2) {
      if (ns !== null) return false;
      var owner = n.ownerElement;
      if (owner && owner.namespaceURI === HTML_NS && isHTMLDoc(n)) return asciiLower(test.local) === local;
      return local === test.local;
    }
    if (ns === HTML_NS && isHTMLDoc(n)) return asciiLower(test.local) === local;
    return ns === null && local === test.local;
  };

  // ---------------------------------------------------------------- values
  var NodeSet = function (nodes) { this.nodes = nodes; };
  var isNS = function (v) { return v instanceof NodeSet; };
  var toStr = function (v) {
    if (isNS(v)) return v.nodes.length ? stringValue(v.nodes[0]) : "";
    if (typeof v === "string") return v;
    if (typeof v === "boolean") return v ? "true" : "false";
    return numToStr(v);
  };
  var numToStr = function (x) {
    if (x !== x) return "NaN";
    if (x === 0) return "0";
    if (!isFinite(x)) return x > 0 ? "Infinity" : "-Infinity";
    var s = String(x);
    var m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
    if (!m) return s;
    var digits = m[2] + (m[3] || ""), exp = parseInt(m[4], 10), sign = m[1];
    if (exp < 0) return sign + "0." + new Array(-exp).join("0") + digits;
    var intLen = exp + 1;
    if (digits.length <= intLen) return sign + digits + new Array(intLen - digits.length + 1).join("0");
    return sign + digits.slice(0, intLen) + "." + digits.slice(intLen);
  };
  var strToNum = function (s) {
    var m = /^[ \t\r\n]*(-?([0-9]+(\.[0-9]*)?|\.[0-9]+))[ \t\r\n]*$/.exec(s);
    return m ? parseFloat(m[1]) : NaN;
  };
  var toNum = function (v) {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    return strToNum(toStr(v));
  };
  var toBool = function (v) {
    if (isNS(v)) return v.nodes.length > 0;
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "number") return v === v && v !== 0;
    return !!v;
  };
  var cmpAtoms = function (op, a, b) {
    if (op === "=" || op === "!=") {
      var eq;
      if (typeof a === "boolean" || typeof b === "boolean") eq = toBool(a) === toBool(b);
      else if (typeof a === "number" || typeof b === "number") eq = toNum(a) === toNum(b);
      else eq = toStr(a) === toStr(b);
      return op === "=" ? eq : !eq;
    }
    var x = toNum(a), y = toNum(b);
    switch (op) { case "<": return x < y; case ">": return x > y; case "<=": return x <= y; case ">=": return x >= y; }
    return false;
  };
  var compare = function (op, a, b) {
    var an = isNS(a), bn = isNS(b);
    if (an && bn) {
      var bs = b.nodes.map(stringValue);
      for (var i = 0; i < a.nodes.length; i++) { var sa = stringValue(a.nodes[i]); for (var j = 0; j < bs.length; j++) if (cmpAtoms(op, sa, bs[j])) return true; }
      return false;
    }
    if (an || bn) {
      var ns = an ? a : b, other = an ? b : a;
      if (typeof other === "boolean") return an ? cmpAtoms(op, toBool(ns), other) : cmpAtoms(op, other, toBool(ns));
      for (var k = 0; k < ns.nodes.length; k++) {
        var sv = stringValue(ns.nodes[k]);
        var atom = typeof other === "number" ? strToNum(sv) : sv;
        if (an ? cmpAtoms(op, atom, other) : cmpAtoms(op, other, atom)) return true;
      }
      return false;
    }
    return cmpAtoms(op, a, b);
  };

  // ---------------------------------------------------------------- functions
  var chars = function (s) { return __jb.arrayFrom(s); };
  var xround = function (x) {
    if (x !== x || !isFinite(x)) return x;
    if (x < 0 && x >= -0.5) return -0;
    return Math.floor(x + 0.5);
  };
  var firstNode = function (ctx, args, i) {
    if (!args.length) return ctx.node;
    var v = ev(args[0], ctx);
    if (!isNS(v)) throw new TypeError("XPath: argument is not a node-set");
    return v.nodes.length ? v.nodes[0] : null;
  };
  var argStr = function (args, i, ctx) { return toStr(ev(args[i], ctx)); };
  var FUNCS = {
    last: { min: 0, max: 0, fn: function (ctx) { return ctx.size; } },
    position: { min: 0, max: 0, fn: function (ctx) { return ctx.pos; } },
    count: { min: 1, max: 1, fn: function (ctx, a) { var v = ev(a[0], ctx); if (!isNS(v)) throw new TypeError("XPath: count() needs a node-set"); return v.nodes.length; } },
    id: { min: 1, max: 1, fn: function (ctx, a) {
      var v = ev(a[0], ctx), ids = [];
      if (isNS(v)) v.nodes.forEach(function (n) { ids = ids.concat(stringValue(n).split(/[ \t\r\n]+/)); });
      else ids = toStr(v).split(/[ \t\r\n]+/);
      ids = ids.filter(Boolean);
      if (!ids.length) return new NodeSet([]);
      var want = new Set(ids), found = new Map(), root = rootOf(ctx.node);
      var walk = function (x) {
        for (var c = x.firstChild; c; c = c.nextSibling) {
          if (c.nodeType !== 1) continue;
          var id = c.getAttribute("id");
          if (id !== null && want.has(id) && !found.has(id)) found.set(id, c);
          walk(c);
        }
      };
      walk(root);
      return new NodeSet(sortUnique(__jb.arrayFrom(found.values())));
    } },
    "local-name": { min: 0, max: 1, fn: function (ctx, a) { var n = firstNode(ctx, a); if (!n) return ""; return n.nodeType === 1 || n.nodeType === 2 ? n.localName : n.nodeType === 7 ? n.target : ""; } },
    "namespace-uri": { min: 0, max: 1, fn: function (ctx, a) { var n = firstNode(ctx, a); return n && (n.nodeType === 1 || n.nodeType === 2) ? n.namespaceURI || "" : ""; } },
    name: { min: 0, max: 1, fn: function (ctx, a) {
      var n = firstNode(ctx, a); if (!n) return "";
      if (n.nodeType === 1 || n.nodeType === 2) return n.prefix ? n.prefix + ":" + n.localName : n.localName;
      return n.nodeType === 7 ? n.target : "";
    } },
    string: { min: 0, max: 1, fn: function (ctx, a) { return a.length ? argStr(a, 0, ctx) : stringValue(ctx.node); } },
    concat: { min: 2, max: Infinity, fn: function (ctx, a) { var s = ""; for (var i = 0; i < a.length; i++) s += argStr(a, i, ctx); return s; } },
    "starts-with": { min: 2, max: 2, fn: function (ctx, a) { return argStr(a, 0, ctx).indexOf(argStr(a, 1, ctx)) === 0; } },
    contains: { min: 2, max: 2, fn: function (ctx, a) { return argStr(a, 0, ctx).indexOf(argStr(a, 1, ctx)) >= 0; } },
    "substring-before": { min: 2, max: 2, fn: function (ctx, a) { var s = argStr(a, 0, ctx), t = argStr(a, 1, ctx), i = s.indexOf(t); return i < 0 ? "" : s.slice(0, i); } },
    "substring-after": { min: 2, max: 2, fn: function (ctx, a) { var s = argStr(a, 0, ctx), t = argStr(a, 1, ctx), i = s.indexOf(t); return i < 0 ? "" : s.slice(i + t.length); } },
    substring: { min: 2, max: 3, fn: function (ctx, a) {
      var s = chars(argStr(a, 0, ctx)), start = xround(toNum(ev(a[1], ctx)));
      var end = a.length > 2 ? start + xround(toNum(ev(a[2], ctx))) : Infinity;
      var out = "";
      for (var p = 1; p <= s.length; p++) if (p >= start && p < end) out += s[p - 1];
      return out;
    } },
    "string-length": { min: 0, max: 1, fn: function (ctx, a) { return chars(a.length ? argStr(a, 0, ctx) : stringValue(ctx.node)).length; } },
    "normalize-space": { min: 0, max: 1, fn: function (ctx, a) { return (a.length ? argStr(a, 0, ctx) : stringValue(ctx.node)).replace(/[ \t\r\n]+/g, " ").replace(/^ | $/g, ""); } },
    translate: { min: 3, max: 3, fn: function (ctx, a) {
      var s = chars(argStr(a, 0, ctx)), from = chars(argStr(a, 1, ctx)), to = chars(argStr(a, 2, ctx)), map = new Map();
      for (var i = 0; i < from.length; i++) if (!map.has(from[i])) map.set(from[i], i < to.length ? to[i] : "");
      return s.map(function (c) { return map.has(c) ? map.get(c) : c; }).join("");
    } },
    boolean: { min: 1, max: 1, fn: function (ctx, a) { return toBool(ev(a[0], ctx)); } },
    not: { min: 1, max: 1, fn: function (ctx, a) { return !toBool(ev(a[0], ctx)); } },
    "true": { min: 0, max: 0, fn: function () { return true; } },
    "false": { min: 0, max: 0, fn: function () { return false; } },
    lang: { min: 1, max: 1, fn: function (ctx, a) {
      var want = argStr(a, 0, ctx).toLowerCase();
      for (var n = ctx.node; n; n = parentOf(n)) {
        if (n.nodeType !== 1) continue;
        var v = n.getAttributeNS(XML_NS, "lang");
        if (v === null && n.namespaceURI === HTML_NS && isHTMLDoc(n)) v = n.getAttribute("lang");
        if (v === null) continue;
        v = v.toLowerCase();
        return v === want || v.indexOf(want + "-") === 0;
      }
      return false;
    } },
    number: { min: 0, max: 1, fn: function (ctx, a) { return a.length ? toNum(ev(a[0], ctx)) : strToNum(stringValue(ctx.node)); } },
    sum: { min: 1, max: 1, fn: function (ctx, a) { var v = ev(a[0], ctx); if (!isNS(v)) throw new TypeError("XPath: sum() needs a node-set"); var s = 0; v.nodes.forEach(function (n) { s += strToNum(stringValue(n)); }); return s; } },
    floor: { min: 1, max: 1, fn: function (ctx, a) { return Math.floor(toNum(ev(a[0], ctx))); } },
    ceiling: { min: 1, max: 1, fn: function (ctx, a) { return Math.ceil(toNum(ev(a[0], ctx))); } },
    round: { min: 1, max: 1, fn: function (ctx, a) { return xround(toNum(ev(a[0], ctx))); } },
  };

  // ---------------------------------------------------------------- evaluator
  var applyPreds = function (nodes, preds, ctx) {
    for (var p = 0; p < preds.length; p++) {
      var out = [], size = nodes.length;
      for (var i = 0; i < size; i++) {
        var v = ev(preds[p], { node: nodes[i], pos: i + 1, size: size });
        if (typeof v === "number" ? v === i + 1 : toBool(v)) out.push(nodes[i]);
      }
      nodes = out;
    }
    return nodes;
  };
  var evalSteps = function (nodes, steps) {
    for (var s = 0; s < steps.length; s++) {
      var step = steps[s], out = [];
      // `//name` without predicates: one descendant walk instead of a step per node.
      for (var i = 0; i < nodes.length; i++) {
        var cand = axisNodes(step.axis, nodes[i]).filter(function (n) { return matches(step.test, step.axis, n); });
        if (step.preds.length) cand = applyPreds(cand, step.preds);
        for (var j = 0; j < cand.length; j++) out.push(cand[j]);
      }
      nodes = nodes.length > 1 || REVERSE[step.axis] || step.axis === "attribute" ? sortUnique(out) : out;
    }
    return nodes;
  };
  function ev(e, ctx) {
    switch (e.k) {
      case "num": return e.v;
      case "lit": return e.v;
      case "var": {
        // variables exist only for host evaluations (XSLT); a DOM evaluate() has none
        if (ENV && ENV.vars && Object.prototype.hasOwnProperty.call(ENV.vars, e.v)) { var vv = ENV.vars[e.v]; return Array.isArray(vv) ? new NodeSet(vv) : vv; }
        throw __jb.domError("SyntaxError", "XPath: variable $" + e.v + " is not defined");
      }
      case "neg": return -toNum(ev(e.a, ctx));
      case "call": return e.f.fn(ctx, e.args);
      case "union": {
        var a = ev(e.a, ctx), b = ev(e.b, ctx);
        if (!isNS(a) || !isNS(b)) throw new TypeError("XPath: union of non node-sets");
        return new NodeSet(sortUnique(a.nodes.concat(b.nodes)));
      }
      case "filter": {
        var v = ev(e.a, ctx);
        if (!isNS(v)) throw new TypeError("XPath: predicate on a non node-set");
        return new NodeSet(applyPreds(v.nodes, e.preds));
      }
      case "path": {
        var start;
        if (e.filter) {
          var fv = ev(e.filter, ctx);
          if (!isNS(fv)) throw new TypeError("XPath: path step after a non node-set");
          start = fv.nodes;
        } else start = e.abs ? [rootOf(ctx.node)] : [ctx.node];
        return new NodeSet(evalSteps(start, e.steps));
      }
      case "bin": {
        switch (e.op) {
          case "or": return toBool(ev(e.a, ctx)) || toBool(ev(e.b, ctx));
          case "and": return toBool(ev(e.a, ctx)) && toBool(ev(e.b, ctx));
          case "=": case "!=": case "<": case ">": case "<=": case ">=": return compare(e.op, ev(e.a, ctx), ev(e.b, ctx));
          case "+": return toNum(ev(e.a, ctx)) + toNum(ev(e.b, ctx));
          case "-": return toNum(ev(e.a, ctx)) - toNum(ev(e.b, ctx));
          case "*": return toNum(ev(e.a, ctx)) * toNum(ev(e.b, ctx));
          case "div": return toNum(ev(e.a, ctx)) / toNum(ev(e.b, ctx));
          case "mod": return toNum(ev(e.a, ctx)) % toNum(ev(e.b, ctx));
        }
      }
    }
    throw syntaxError("bad expression");
  }

  // ---------------------------------------------------------------- DOM interfaces
  var TOKEN = {};
  var expectNode = function (n, what) {
    if (!(n instanceof Node) && !(n && typeof n === "object" && typeof n.nodeType === "number" && "ownerDocument" in n)) throw new TypeError(what + ": Argument is not a Node");
  };
  // XPathNSResolver callback interface: a function, or an object whose lookupNamespaceURI is called.
  var makeResolve = function (resolver) {
    return function (prefix) {
      var uri = null;
      if (resolver !== null && resolver !== undefined) {
        if (typeof resolver === "function") uri = resolver.call(undefined, prefix);
        else if (typeof resolver === "object") {
          var f = resolver.lookupNamespaceURI;
          if (typeof f !== "function") throw new TypeError("XPathNSResolver: lookupNamespaceURI is not callable");
          uri = f.call(resolver, prefix);
        } else throw new TypeError("XPathNSResolver is not an object");
      }
      if (prefix === "xml") uri = uri === null || uri === undefined || uri === "" ? XML_NS : uri;
      if (uri === null || uri === undefined || uri === "") throw __jb.domError("NamespaceError", "XPath: prefix '" + prefix + "' is not bound");
      return String(uri);
    };
  };
  var ENV = null;
  var compile = function (expression, resolver, extraFuncs) {
    expression = String(expression);
    var p = new Parser(tokenize(expression), typeof resolver === "function" && resolver.__direct ? resolver : makeResolve(resolver), extraFuncs);
    if (!p.toks.length) throw syntaxError("empty expression");
    var ast = p.expr();
    if (p.i < p.toks.length) throw syntaxError("unexpected trailing token '" + p.peek() + "'");
    return ast;
  };

  function XPathResult() { throw new TypeError("Illegal constructor"); }
  var C = { ANY_TYPE: 0, NUMBER_TYPE: 1, STRING_TYPE: 2, BOOLEAN_TYPE: 3, UNORDERED_NODE_ITERATOR_TYPE: 4, ORDERED_NODE_ITERATOR_TYPE: 5, UNORDERED_NODE_SNAPSHOT_TYPE: 6, ORDERED_NODE_SNAPSHOT_TYPE: 7, ANY_UNORDERED_NODE_TYPE: 8, FIRST_ORDERED_NODE_TYPE: 9 };
  Object.keys(C).forEach(function (k) {
    Object.defineProperty(XPathResult, k, { value: C[k], enumerable: true });
    Object.defineProperty(XPathResult.prototype, k, { value: C[k], enumerable: true });
  });
  var R = function (r, what) { if (!r || !r.__xpr) throw new TypeError("XPathResult." + what + ": illegal invocation"); return r.__xpr; };
  var typeErr = function (what) { return new TypeError("XPathResult." + what + " is not available for this result type"); };
  var getters = {
    resultType: function () { return R(this, "resultType").type; },
    numberValue: function () { var s = R(this, "numberValue"); if (s.type !== 1) throw typeErr("numberValue"); return s.value; },
    stringValue: function () { var s = R(this, "stringValue"); if (s.type !== 2) throw typeErr("stringValue"); return s.value; },
    booleanValue: function () { var s = R(this, "booleanValue"); if (s.type !== 3) throw typeErr("booleanValue"); return s.value; },
    singleNodeValue: function () { var s = R(this, "singleNodeValue"); if (s.type !== 8 && s.type !== 9) throw typeErr("singleNodeValue"); return s.nodes[0] || null; },
    invalidIteratorState: function () { var s = R(this, "invalidIteratorState"); return (s.type === 4 || s.type === 5) && s.ver !== __jb.domVersion; },
    snapshotLength: function () { var s = R(this, "snapshotLength"); if (s.type !== 6 && s.type !== 7) throw typeErr("snapshotLength"); return s.nodes.length; },
  };
  Object.keys(getters).forEach(function (k) { Object.defineProperty(XPathResult.prototype, k, { get: getters[k], enumerable: true, configurable: true }); });
  XPathResult.prototype.iterateNext = function () {
    var s = R(this, "iterateNext");
    if (s.type !== 4 && s.type !== 5) throw typeErr("iterateNext");
    if (s.ver !== __jb.domVersion) throw __jb.domError("InvalidStateError", "The document has mutated since the result was returned");
    return s.idx < s.nodes.length ? s.nodes[s.idx++] : null;
  };
  XPathResult.prototype.snapshotItem = function (i) {
    var s = R(this, "snapshotItem");
    if (s.type !== 6 && s.type !== 7) throw typeErr("snapshotItem");
    i = Number(i); i = i !== i ? 0 : Math.trunc(i) >>> 0;
    return i < s.nodes.length ? s.nodes[i] : null;
  };
  Object.defineProperty(XPathResult.prototype, Symbol.toStringTag, { value: "XPathResult", configurable: true });

  var makeResult = function (value, type) {
    type = Number(type) & 0xffff;
    if (type > 9) throw __jb.domError("NotSupportedError", "XPath: unknown result type " + type);
    if (type === 0) type = isNS(value) ? 4 : typeof value === "number" ? 1 : typeof value === "string" ? 2 : 3;
    var st = { type: type, value: null, nodes: [], idx: 0, ver: __jb.domVersion };
    if (type === 1) st.value = toNum(value);
    else if (type === 2) st.value = toStr(value);
    else if (type === 3) st.value = toBool(value);
    else {
      if (!isNS(value)) throw new TypeError("XPath: the expression does not evaluate to a node-set");
      st.nodes = value.nodes.slice();
    }
    var r = Object.create(XPathResult.prototype);
    Object.defineProperty(r, "__xpr", { value: st });
    return r;
  };
  var run = function (ast, contextNode, type) {
    var v = ev(ast, { node: contextNode, pos: 1, size: 1 });
    return makeResult(v, type);
  };

  function XPathExpression() { throw new TypeError("Illegal constructor"); }
  XPathExpression.prototype.evaluate = function (contextNode, type, result) {
    if (!this || !this.__ast) throw new TypeError("XPathExpression.evaluate: illegal invocation");
    if (arguments.length < 1) throw new TypeError("XPathExpression.evaluate: At least 1 argument required");
    expectNode(contextNode, "XPathExpression.evaluate");
    return run(this.__ast, contextNode, type === undefined ? 0 : type);
  };
  Object.defineProperty(XPathExpression.prototype, Symbol.toStringTag, { value: "XPathExpression", configurable: true });
  var newExpression = function (expression, resolver) {
    var x = Object.create(XPathExpression.prototype);
    Object.defineProperty(x, "__ast", { value: compile(expression, resolver) });
    return x;
  };

  var base = {
    createExpression: function (expression, resolver) {
      if (arguments.length < 1) throw new TypeError("createExpression: At least 1 argument required");
      return newExpression(expression, resolver === undefined ? null : resolver);
    },
    createNSResolver: function (nodeResolver) {
      if (arguments.length < 1) throw new TypeError("createNSResolver: At least 1 argument required");
      return nodeResolver;
    },
    evaluate: function (expression, contextNode, resolver, type, result) {
      if (arguments.length < 2) throw new TypeError("evaluate: At least 2 arguments required");
      var ast = compile(expression, resolver === undefined ? null : resolver);
      expectNode(contextNode, "evaluate");
      return run(ast, contextNode, type === undefined ? 0 : type);
    },
  };
  class XPathEvaluator {}
  Object.keys(base).forEach(function (k) {
    Object.defineProperty(XPathEvaluator.prototype, k, { value: base[k], writable: true, enumerable: true, configurable: true });
    Object.defineProperty(Document.prototype, k, { value: base[k], writable: true, enumerable: true, configurable: true });
  });
  Object.defineProperty(XPathEvaluator.prototype, Symbol.toStringTag, { value: "XPathEvaluator", configurable: true });
  globalThis.XPathResult = XPathResult;
  globalThis.XPathExpression = XPathExpression;
  globalThis.XPathEvaluator = XPathEvaluator;
  // host evaluation (XSLT): raw values, node-sets as arrays in document order
  var evaluateRaw = function (ast, node, env, pos, size) {
    var prev = ENV;
    ENV = env || null;
    try {
      var v = ev(ast, { node: node, pos: pos || 1, size: size || 1 });
      return isNS(v) ? v.nodes : v;
    } finally { ENV = prev; }
  };
  __jb.xpath = { compile: compile, run: run, evaluateRaw: evaluateRaw, NodeSet: NodeSet, isNodeSet: isNS, toStr: toStr, toNum: toNum, toBool: toBool, stringValue: stringValue, sortUnique: sortUnique, numToStr: numToStr,
    evalArg: function (a, ctx) { return ev(a, ctx); }, env: function () { return ENV; }, coreFunctions: Object.keys(FUNCS) };
})();
