// Generate src/js/env/96_idl.js: a compact table of the Window-exposed
// interfaces of the given WebIDL files (from the WPT checkout) that the
// runtime installer in that file uses to give prototypes their IDL shape.
//   node scripts/gen-idl.js ../wpt html
const fs = require("fs");
const path = require("path");
const wptRoot = path.resolve(process.argv[2] || "../wpt");
const files = process.argv.slice(3);
const webidl2 = require(path.join(wptRoot, "resources/webidl2/lib/webidl2.js"));

const defs = [];
for (const f of files) defs.push(...webidl2.parse(fs.readFileSync(path.join(wptRoot, "interfaces", f + ".idl"), "utf8")));

const exposedTo = (ext) => {
  const e = ext.find((x) => x.name === "Exposed");
  if (!e || !e.rhs) return [];
  if (e.rhs.type === "*") return ["*"];
  const v = e.rhs.value;
  return Array.isArray(v) ? v.map((x) => x.value) : [v];
};
const hasExt = (ext, n) => ext.some((x) => x.name === n);
const extVal = (ext, n) => { const e = ext.find((x) => x.name === n); return e && e.rhs ? e.rhs.value : null; };
const argLen = (args) => { let n = 0; for (const a of args) { if (a.optional || a.variadic) break; n++; } return n; };
// Default value kind for a stubbed attribute.
const typeKind = (t) => {
  if (!t) return "u";
  if (t.nullable) return "n";
  if (t.union) return "n";
  const n = t.idlType;
  if (typeof n !== "string") return "n";
  if (/^(DOMString|USVString|ByteString|CSSOMString|TrustedHTML|TrustedScriptURL|TrustedScript)$/.test(n)) return "s";
  if (n === "boolean") return "b";
  if (/(short|long|float|double|octet|byte|unrestricted)/.test(n)) return "0";
  if (n === "EventHandler" || n === "OnErrorEventHandler" || n === "OnBeforeUnloadEventHandler") return "h";
  return "n";
};

const ifaces = new Map(), mixins = new Map(), includes = [];
for (const d of defs) {
  if (d.type === "interface" || d.type === "callback interface" || d.type === "namespace") {
    let rec = ifaces.get(d.name);
    if (!rec) { rec = { name: d.name, kind: d.type, inherits: null, exposed: [], members: [], ext: [] }; ifaces.set(d.name, rec); }
    if (!d.partial) { rec.inherits = d.inheritance || null; rec.exposed = exposedTo(d.extAttrs); rec.ext = d.extAttrs.map((x) => x.name); rec.legacyWindowAlias = extVal(d.extAttrs, "LegacyWindowAlias"); }
    else if (!rec.exposed.length) rec.exposed = exposedTo(d.extAttrs);
    rec.members.push(...d.members);
  } else if (d.type === "interface mixin") {
    const rec = mixins.get(d.name) || { name: d.name, members: [] };
    rec.members.push(...d.members);
    mixins.set(d.name, rec);
  } else if (d.type === "includes") includes.push([d.target, d.includes]);
}
for (const [target, mixin] of includes) {
  const t = ifaces.get(target), m = mixins.get(mixin);
  if (t && m) t.members.push(...m.members);
}

const out = [];
for (const rec of ifaces.values()) {
  if (rec.kind === "namespace") continue;
  const windowExposed = rec.exposed.includes("Window") || rec.exposed.includes("*");
  if (!windowExposed) continue;
  const r = { n: rec.name };
  if (rec.inherits) r.p = rec.inherits;
  if (rec.ext.includes("LegacyNoInterfaceObject")) r.noObj = 1;
  if (rec.kind === "callback interface") r.cb = 1;
  if (rec.ext.includes("Global")) r.global = 1;
  if (rec.ext.includes("LegacyUnforgeable")) r.unf = 1;
  const ctor = rec.members.find((m) => m.type === "constructor");
  if (ctor) r.c = argLen(ctor.arguments);
  const attrs = [], ops = {}, consts = [], statics = [], promiseOps = {};
  for (const m of rec.members) {
    const memExposed = exposedTo(m.extAttrs || []);
    if (memExposed.length && !memExposed.includes("Window") && !memExposed.includes("*")) continue;
    if (m.type === "attribute") {
      const a = [m.name, (m.readonly ? 1 : 0) | (hasExt(m.extAttrs, "LegacyUnforgeable") ? 2 : 0) | (m.special === "static" ? 4 : 0) | (hasExt(m.extAttrs, "Replaceable") ? 8 : 0) | (extVal(m.extAttrs, "PutForwards") ? 16 : 0) | (hasExt(m.extAttrs, "LegacyLenientThis") ? 32 : 0) | (m.special === "stringifier" ? 64 : 0), typeKind(m.idlType)];
      if (extVal(m.extAttrs, "PutForwards")) a.push(extVal(m.extAttrs, "PutForwards"));
      (m.special === "static" ? statics : attrs).push(a);
    } else if (m.type === "operation" && m.name) {
      const key = (m.special === "static" ? "s:" : "") + m.name;
      const len = argLen(m.arguments);
      ops[key] = ops[key] === undefined ? len : Math.min(ops[key], len);
      if (m.idlType && m.idlType.generic === "Promise") promiseOps[key] = 1;
    } else if (m.type === "operation" && m.special === "stringifier") {
      ops["toString"] = 0;
    } else if (m.type === "const") {
      const v = m.value.type === "number" ? Number(m.value.value) : m.value.type === "boolean" ? m.value.value : null;
      consts.push([m.name, v]);
    } else if (m.type === "iterable" || m.type === "maplike" || m.type === "setlike") {
      r.it = m.type === "iterable" ? (m.idlType.length === 2 ? "pair" : "value") : m.type;
    }
  }
  if (attrs.length) r.a = attrs;
  if (statics.length) r.sa = statics;
  // a third element marks operations returning a promise (brand failures reject)
  const opList = Object.entries(ops).map(([k, v]) => promiseOps[k] ? [k, v, 1] : [k, v]);
  if (opList.length) r.o = opList;
  if (consts.length) r.k = consts;
  out.push(r);
}
// Parents before children.
const byName = new Map(out.map((r) => [r.n, r]));
const ordered = [], seen = new Set();
const visit = (r) => { if (seen.has(r.n)) return; seen.add(r.n); if (r.p && byName.has(r.p)) visit(byName.get(r.p)); ordered.push(r); };
out.forEach(visit);
const json = JSON.stringify(ordered);
// Writes src/js/env/96_idl_data.js (the env file registered in src/js/mod.rs).
const outFile = path.join(__dirname, "..", "src", "js", "env", "96_idl_data.js");
fs.writeFileSync(outFile, "// Generated by scripts/gen-idl.js from the WPT checkout's interfaces/" + files.join(", ") + ".idl; do not edit.\n__jb.IDL_DATA = " + json + ";\n");
console.log("wrote " + outFile + " (" + ordered.length + " interfaces)");
