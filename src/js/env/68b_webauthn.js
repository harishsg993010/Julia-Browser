// Part 6d: Web Authentication (PublicKeyCredential) backed by virtual authenticators.
// Authenticators are added through WebDriver (test_driver.add_virtual_authenticator in the WPT
// runner); without one, create()/get() wait for their timeout and reject with NotAllowedError, as
// a browser with no security key attached does. Keys come from WebCrypto (ES256, EdDSA, RS256),
// attestation is "none", authenticator data and attestation objects are CBOR per CTAP2.
(function () {
  if (globalThis.__jb_workerRealm || typeof Credential !== "function") return;
  var UA = __jb.credentialCtorToken;
  var define = function (name, value) { Object.defineProperty(globalThis, name, { value: value, writable: true, enumerable: false, configurable: true }); };
  var tag = function (C) { Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true }); };
  var illegal = function () { throw new TypeError("Illegal constructor"); };
  var top = function () { return typeof __jb.topJb === "function" ? __jb.topJb() : __jb; };
  var store = function () { var t = top(); return t.webauthnStore || (t.webauthnStore = { authenticators: [], seq: 0 }); };
  var subtle = function () { return crypto.subtle; };
  var domErr = function (n, m) { return __jb.domError(n, m || n); };

  // ---- byte helpers
  var bytesOf = function (bs, what) {
    if (bs instanceof ArrayBuffer) return new Uint8Array(bs.slice(0));
    if (ArrayBuffer.isView(bs)) return new Uint8Array(bs.buffer.slice(bs.byteOffset, bs.byteOffset + bs.byteLength));
    if (typeof SharedArrayBuffer === "function" && bs instanceof SharedArrayBuffer) throw new TypeError(what + " is a SharedArrayBuffer");
    throw new TypeError(what + " is not a BufferSource");
  };
  var concat = function () { var n = 0, i; for (i = 0; i < arguments.length; i++) n += arguments[i].length; var out = new Uint8Array(n), o = 0; for (i = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; } return out; };
  var utf8 = function (s) { return new TextEncoder().encode(s); };
  var b64url = function (u8) { var s = ""; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"); };
  var fromB64url = function (s, what) {
    s = String(s);
    if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s) || s.replace(/=+$/, "").length % 4 === 1) throw new TypeError((what || "value") + " is not valid base64url");
    var t = s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    var bin = atob(t), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  var eq = function (a, b) { if (a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  var u32 = function (n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); };
  var ab = function (u8) { return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); };
  // ---- CBOR (deterministic: map entries in the order given)
  var cbor = function (v) {
    var head = function (major, n) {
      if (n < 24) return [major << 5 | n];
      if (n < 256) return [major << 5 | 24, n];
      if (n < 65536) return [major << 5 | 25, n >> 8, n & 255];
      return [major << 5 | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    };
    var out = [];
    var enc = function (x) {
      if (x instanceof Uint8Array) { out.push.apply(out, head(2, x.length)); for (var i = 0; i < x.length; i++) out.push(x[i]); }
      else if (typeof x === "number") { if (x >= 0) out.push.apply(out, head(0, x)); else out.push.apply(out, head(1, -1 - x)); }
      else if (typeof x === "string") { var b = utf8(x); out.push.apply(out, head(3, b.length)); for (var j = 0; j < b.length; j++) out.push(b[j]); }
      else if (typeof x === "boolean") out.push(x ? 0xf5 : 0xf4);
      else if (Array.isArray(x) && x.isMap) { out.push.apply(out, head(5, x.length)); x.forEach(function (kv) { enc(kv[0]); enc(kv[1]); }); }
      else if (Array.isArray(x)) { out.push.apply(out, head(4, x.length)); x.forEach(enc); }
      else throw new Error("cbor: unsupported value");
    };
    enc(v);
    return new Uint8Array(out);
  };
  var cmap = function (entries) { entries.isMap = true; return entries; };
  // raw r||s ECDSA signature -> ASN.1 DER
  var derSig = function (raw) {
    var int = function (b) { var i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); if (b[0] & 0x80) b = concat(new Uint8Array([0]), b); return concat(new Uint8Array([2, b.length]), b); };
    var half = raw.length / 2, r = int(raw.slice(0, half)), s = int(raw.slice(half));
    var body = concat(r, s);
    return concat(new Uint8Array([0x30, body.length]), body);
  };
  var sha256 = function (u8) { return subtle().digest("SHA-256", u8).then(function (d) { return new Uint8Array(d); }); };

  // ---- RP ID / origin rules
  var effectiveDomain = function () { return location.hostname; };
  var validRpId = function (rpId) {
    var host = effectiveDomain().toLowerCase();
    if (typeof rpId !== "string" || !rpId) return false;
    var id = rpId.toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(id) || /^[-0-9]/.test(id) && !/^\d+\.\d+\.\d+\.\d+$/.test(id)) return id === host;
    if (id === host) return true;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
    return id.indexOf(".") > 0 && host.slice(-(id.length + 1)) === "." + id;
  };
  var sameOriginWithAncestors = function () { return __jb.credentialSameOriginWithAncestors ? __jb.credentialSameOriginWithAncestors() : true; };
  var topOrigin = function () { try { return globalThis.top.location.origin; } catch (e) { return null; } };
  var clientData = function (type, challenge) {
    var cross = !sameOriginWithAncestors();
    var s = '{"type":' + JSON.stringify(type) + ',"challenge":' + JSON.stringify(b64url(challenge)) + ',"origin":' + JSON.stringify(location.origin) + ',"crossOrigin":' + (cross ? "true" : "false");
    if (cross && topOrigin()) s += ',"topOrigin":' + JSON.stringify(topOrigin());
    return utf8(s + "}");
  };

  // ---- interfaces
  function AuthenticatorResponse() { if (arguments[0] !== UA) illegal(); }
  Object.defineProperty(AuthenticatorResponse.prototype, "clientDataJSON", { get: function () { if (!this || !this._r) throw new TypeError("Illegal invocation"); return this._r.clientDataJSON; }, enumerable: true, configurable: true });
  tag(AuthenticatorResponse);
  function AuthenticatorAttestationResponse() { if (arguments[0] !== UA) illegal(); }
  AuthenticatorAttestationResponse.prototype = Object.create(AuthenticatorResponse.prototype, { constructor: { value: AuthenticatorAttestationResponse, writable: true, configurable: true } });
  Object.setPrototypeOf(AuthenticatorAttestationResponse, AuthenticatorResponse);
  Object.defineProperty(AuthenticatorAttestationResponse.prototype, "attestationObject", { get: function () { if (!this || !this._r) throw new TypeError("Illegal invocation"); return this._r.attestationObject; }, enumerable: true, configurable: true });
  AuthenticatorAttestationResponse.prototype.getTransports = function getTransports() { return this._r.transports.slice(); };
  AuthenticatorAttestationResponse.prototype.getAuthenticatorData = function getAuthenticatorData() { return ab(this._r.authData); };
  AuthenticatorAttestationResponse.prototype.getPublicKey = function getPublicKey() { return this._r.spki ? ab(this._r.spki) : null; };
  AuthenticatorAttestationResponse.prototype.getPublicKeyAlgorithm = function getPublicKeyAlgorithm() { return this._r.alg; };
  tag(AuthenticatorAttestationResponse);
  function AuthenticatorAssertionResponse() { if (arguments[0] !== UA) illegal(); }
  AuthenticatorAssertionResponse.prototype = Object.create(AuthenticatorResponse.prototype, { constructor: { value: AuthenticatorAssertionResponse, writable: true, configurable: true } });
  Object.setPrototypeOf(AuthenticatorAssertionResponse, AuthenticatorResponse);
  ["authenticatorData", "signature", "userHandle"].forEach(function (a) { Object.defineProperty(AuthenticatorAssertionResponse.prototype, a, { get: function () { if (!this || !this._r) throw new TypeError("Illegal invocation"); return this._r[a]; }, enumerable: true, configurable: true }); });
  tag(AuthenticatorAssertionResponse);

  function PublicKeyCredential() { if (arguments[0] !== UA) illegal(); }
  PublicKeyCredential.prototype = Object.create(Credential.prototype, { constructor: { value: PublicKeyCredential, writable: true, configurable: true } });
  Object.setPrototypeOf(PublicKeyCredential, Credential);
  ["rawId", "response", "authenticatorAttachment"].forEach(function (a) { Object.defineProperty(PublicKeyCredential.prototype, a, { get: function () { if (!this || !this._pk) throw new TypeError("Illegal invocation"); return this._pk[a]; }, enumerable: true, configurable: true }); });
  PublicKeyCredential.prototype.getClientExtensionResults = function getClientExtensionResults() { if (!this || !this._pk) throw new TypeError("Illegal invocation"); return extOutputsCopy(this._pk.ext); };
  var extOutputsCopy = function (e) {
    var o = {};
    Object.keys(e).forEach(function (k) {
      var v = e[k];
      if (v && typeof v === "object" && !(v instanceof ArrayBuffer)) { var c = {}; Object.keys(v).forEach(function (kk) { var vv = v[kk]; c[kk] = vv instanceof ArrayBuffer ? vv.slice(0) : vv && typeof vv === "object" && !(vv instanceof ArrayBuffer) ? Object.assign({}, vv) : vv; }); o[k] = c; }
      else o[k] = v;
    });
    return o;
  };
  var extToJSON = function (e) {
    var o = {};
    Object.keys(e).forEach(function (k) {
      var conv = function (v) { if (v instanceof ArrayBuffer) return b64url(new Uint8Array(v)); if (v && typeof v === "object") { var c = {}; Object.keys(v).forEach(function (kk) { c[kk] = conv(v[kk]); }); return c; } return v; };
      o[k] = conv(e[k]);
    });
    return o;
  };
  PublicKeyCredential.prototype.toJSON = function toJSON() {
    if (!this || !this._pk) throw new TypeError("Illegal invocation");
    var p = this._pk, r = p.response._r, out = { id: this.id, rawId: b64url(new Uint8Array(p.rawId)) };
    if (p.response instanceof AuthenticatorAttestationResponse) {
      out.response = { clientDataJSON: b64url(new Uint8Array(r.clientDataJSON)), authenticatorData: b64url(r.authData), transports: r.transports.slice() };
      if (r.spki) out.response.publicKey = b64url(r.spki);
      out.response.publicKeyAlgorithm = r.alg;
      out.response.attestationObject = b64url(new Uint8Array(r.attestationObject));
    } else {
      out.response = { clientDataJSON: b64url(new Uint8Array(r.clientDataJSON)), authenticatorData: b64url(new Uint8Array(r.authenticatorData)), signature: b64url(new Uint8Array(r.signature)) };
      if (r.userHandle) out.response.userHandle = b64url(new Uint8Array(r.userHandle));
    }
    if (p.authenticatorAttachment) out.authenticatorAttachment = p.authenticatorAttachment;
    out.clientExtensionResults = extToJSON(p.ext);
    out.type = "public-key";
    return out;
  };
  PublicKeyCredential.isConditionalMediationAvailable = function isConditionalMediationAvailable() { return Promise.resolve(true); };
  PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = function isUserVerifyingPlatformAuthenticatorAvailable() {
    if (!__jb.wptMode) return Promise.resolve(true);
    return Promise.resolve(store().authenticators.some(function (a) { return a.transport === "internal" && a.hasUserVerification; }));
  };
  PublicKeyCredential.getClientCapabilities = function getClientCapabilities() {
    if (!__jb.wptMode && !store().authenticators.length) {
      // real sites: the vault's FIDO2 software authenticator (+ security keys where enabled)
      var real = { conditionalCreate: false, conditionalGet: true, "extension:appid": false, "extension:appidExclude": false, "extension:credBlob": false, "extension:credProps": true,
        "extension:getCredBlob": false, "extension:largeBlob": false, "extension:minPinLength": false, "extension:prf": true, hybridTransport: false, passkeyPlatformAuthenticator: true, relatedOrigins: false,
        signalAllAcceptedCredentials: true, signalCurrentUserDetails: true, signalUnknownCredential: true, userVerifyingPlatformAuthenticator: true };
      var out = {}; Object.keys(real).sort().forEach(function (k) { out[k] = real[k]; });
      return Promise.resolve(out);
    }
    var uvpa = store().authenticators.some(function (a) { return a.transport === "internal" && a.hasUserVerification; });
    var caps = { conditionalCreate: false, conditionalGet: true, "extension:appid": true, "extension:appidExclude": true, "extension:credBlob": true, "extension:credProps": true,
      "extension:getCredBlob": true, "extension:largeBlob": true, "extension:minPinLength": true, "extension:prf": true, hybridTransport: false, passkeyPlatformAuthenticator: uvpa, relatedOrigins: false,
      signalAllAcceptedCredentials: true, signalCurrentUserDetails: true, signalUnknownCredential: true, userVerifyingPlatformAuthenticator: uvpa };
    var sorted = {}; Object.keys(caps).sort().forEach(function (k) { sorted[k] = caps[k]; });
    return Promise.resolve(sorted);
  };
  // JSON (de)serialization of options
  var descFromJSON = function (d, what) { if (d === null || typeof d !== "object") throw new TypeError(what + " is not a dictionary"); if (d.type === undefined || d.id === undefined) throw new TypeError(what + ": type and id are required"); var r = { type: String(d.type), id: ab(fromB64url(d.id, what + ".id")) }; if (d.transports !== undefined) r.transports = __jb.arrayFrom(d.transports, String); return r; };
  var extFromJSON = function (e) {
    if (e === undefined) return undefined;
    var o = {};
    Object.keys(e).forEach(function (k) {
      var v = e[k];
      if (k === "prf" && v) { o.prf = {}; if (v.eval) o.prf.eval = prfVals(v.eval); if (v.evalByCredential) { o.prf.evalByCredential = {}; Object.keys(v.evalByCredential).forEach(function (c) { o.prf.evalByCredential[c] = prfVals(v.evalByCredential[c]); }); } }
      else if (k === "largeBlob" && v) { o.largeBlob = Object.assign({}, v); if (v.write !== undefined) o.largeBlob.write = ab(fromB64url(v.write, "largeBlob.write")); }
      else o[k] = v;
    });
    return o;
  };
  var prfVals = function (v) { var r = { first: ab(fromB64url(v.first, "prf.first")) }; if (v.second !== undefined) r.second = ab(fromB64url(v.second, "prf.second")); return r; };
  PublicKeyCredential.parseCreationOptionsFromJSON = function parseCreationOptionsFromJSON(o) {
    if (arguments.length < 1 || o === null || typeof o !== "object") throw new TypeError("parseCreationOptionsFromJSON: argument is not a dictionary");
    ["rp", "user", "challenge", "pubKeyCredParams"].forEach(function (k) { if (o[k] === undefined) throw new TypeError("parseCreationOptionsFromJSON: " + k + " is required"); });
    if (o.user === null || typeof o.user !== "object" || o.user.id === undefined || o.user.name === undefined || o.user.displayName === undefined) throw new TypeError("user is invalid");
    var r = { rp: Object.assign({}, o.rp), user: { id: ab(fromB64url(o.user.id, "user.id")), name: String(o.user.name), displayName: String(o.user.displayName) }, challenge: ab(fromB64url(o.challenge, "challenge")),
      pubKeyCredParams: __jb.arrayFrom(o.pubKeyCredParams, function (p) { return { type: String(p.type), alg: p.alg | 0 }; }) };
    if (o.timeout !== undefined) r.timeout = o.timeout >>> 0;
    r.excludeCredentials = o.excludeCredentials === undefined ? [] : __jb.arrayFrom(o.excludeCredentials, function (d) { return descFromJSON(d, "excludeCredentials"); });
    if (o.authenticatorSelection !== undefined) r.authenticatorSelection = Object.assign({ requireResidentKey: false, userVerification: "preferred" }, o.authenticatorSelection);
    r.hints = o.hints === undefined ? [] : __jb.arrayFrom(o.hints, String);
    r.attestation = o.attestation === undefined ? "none" : String(o.attestation);
    r.attestationFormats = o.attestationFormats === undefined ? [] : __jb.arrayFrom(o.attestationFormats, String);
    if (o.extensions !== undefined) r.extensions = extFromJSON(o.extensions);
    return r;
  };
  PublicKeyCredential.parseRequestOptionsFromJSON = function parseRequestOptionsFromJSON(o) {
    if (arguments.length < 1 || o === null || typeof o !== "object") throw new TypeError("parseRequestOptionsFromJSON: argument is not a dictionary");
    if (o.challenge === undefined) throw new TypeError("parseRequestOptionsFromJSON: challenge is required");
    var r = { challenge: ab(fromB64url(o.challenge, "challenge")) };
    if (o.timeout !== undefined) r.timeout = o.timeout >>> 0;
    if (o.rpId !== undefined) r.rpId = String(o.rpId);
    r.allowCredentials = o.allowCredentials === undefined ? [] : __jb.arrayFrom(o.allowCredentials, function (d) { return descFromJSON(d, "allowCredentials"); });
    r.userVerification = o.userVerification === undefined ? "preferred" : String(o.userVerification);
    r.hints = o.hints === undefined ? [] : __jb.arrayFrom(o.hints, String);
    if (o.extensions !== undefined) r.extensions = extFromJSON(o.extensions);
    return r;
  };
  // Signals: drop / update discoverable credentials on the authenticators.
  var signalPrep = function (o, fields) {
    if (o === null || typeof o !== "object") return Promise.reject(new TypeError("signal: options is not a dictionary"));
    for (var i = 0; i < fields.length; i++) if (o[fields[i]] === undefined) return Promise.reject(new TypeError("signal: " + fields[i] + " is required"));
    if (!validRpId(String(o.rpId))) return Promise.reject(domErr("SecurityError", "The RP ID is not valid for this origin"));
    return null;
  };
  var allCreds = function (rpId) { var list = []; store().authenticators.forEach(function (a) { a.credentials.forEach(function (c) { if (c.rpId === rpId) list.push({ a: a, c: c }); }); }); return list; };
  var dropCred = function (a, c) { var i = a.credentials.indexOf(c); if (i >= 0) a.credentials.splice(i, 1); };
  PublicKeyCredential.signalUnknownCredential = function signalUnknownCredential(o) {
    var bad = signalPrep(o, ["rpId", "credentialId"]); if (bad) return bad;
    var id; try { id = fromB64url(o.credentialId, "credentialId"); } catch (e) { return Promise.reject(e); }
    if (useNative()) nativeSignal({ kind: "unknown", rpId: String(o.rpId), credentialId: b64url(id) });
    allCreds(String(o.rpId)).forEach(function (x) { if (eq(x.c.id, id)) dropCred(x.a, x.c); });
    return Promise.resolve(undefined);
  };
  PublicKeyCredential.signalAllAcceptedCredentials = function signalAllAcceptedCredentials(o) {
    var bad = signalPrep(o, ["rpId", "userId", "allAcceptedCredentialIds"]); if (bad) return bad;
    var uid, ids;
    try { uid = fromB64url(o.userId, "userId"); ids = __jb.arrayFrom(o.allAcceptedCredentialIds, function (s) { return fromB64url(s, "credential id"); }); } catch (e) { return Promise.reject(e); }
    if (useNative()) nativeSignal({ kind: "accepted", rpId: String(o.rpId), userId: b64url(uid), allAcceptedCredentialIds: ids.map(b64url) });
    allCreds(String(o.rpId)).forEach(function (x) { if (x.c.resident && x.c.userHandle && eq(x.c.userHandle, uid) && !ids.some(function (i) { return eq(i, x.c.id); })) dropCred(x.a, x.c); });
    return Promise.resolve(undefined);
  };
  PublicKeyCredential.signalCurrentUserDetails = function signalCurrentUserDetails(o) {
    var bad = signalPrep(o, ["rpId", "userId", "name", "displayName"]); if (bad) return bad;
    var uid; try { uid = fromB64url(o.userId, "userId"); } catch (e) { return Promise.reject(e); }
    if (useNative()) nativeSignal({ kind: "user", rpId: String(o.rpId), userId: b64url(uid), name: String(o.name), displayName: String(o.displayName) });
    allCreds(String(o.rpId)).forEach(function (x) { if (x.c.userHandle && eq(x.c.userHandle, uid)) { x.c.userName = String(o.name); x.c.userDisplayName = String(o.displayName); } });
    return Promise.resolve(undefined);
  };
  tag(PublicKeyCredential);
  [["AuthenticatorResponse", AuthenticatorResponse], ["AuthenticatorAttestationResponse", AuthenticatorAttestationResponse], ["AuthenticatorAssertionResponse", AuthenticatorAssertionResponse], ["PublicKeyCredential", PublicKeyCredential]].forEach(function (p) { define(p[0], p[1]); });
  [AuthenticatorResponse, AuthenticatorAttestationResponse, AuthenticatorAssertionResponse, PublicKeyCredential].forEach(function (C) { try { Object.defineProperty(C, "prototype", { writable: false }); } catch (e) {} });

  // ---- option conversion (WebIDL dictionaries, lexicographic member order)
  var dict = function (v, what) { if (v === undefined || v === null) return {}; if (typeof v !== "object" && typeof v !== "function") throw new TypeError(what + " is not a dictionary"); return v; };
  var reqMember = function (o, k, what) { var v = o[k]; if (v === undefined) throw new TypeError(what + ": required member " + k + " is undefined"); return v; };
  var descriptors = function (list, what) {
    if (list === undefined) return [];
    if (list === null || typeof list !== "object" || typeof list[Symbol.iterator] !== "function") throw new TypeError(what + " is not a sequence");
    return __jb.arrayFrom(list, function (d) {
      d = dict(d, what);
      var id = bytesOf(reqMember(d, "id", what), what + ".id");
      var tr = d.transports === undefined ? undefined : __jb.arrayFrom(d.transports, String);
      return { id: id, transports: tr, type: String(reqMember(d, "type", what)) };
    });
  };
  var convertExtensions = function (e) {
    if (e === undefined) return {};
    e = dict(e, "extensions");
    var o = {};
    if (e.appid !== undefined) o.appid = String(e.appid);
    if (e.appidExclude !== undefined) o.appidExclude = String(e.appidExclude);
    if (e.credBlob !== undefined) o.credBlob = bytesOf(e.credBlob, "credBlob");
    if (e.credProps !== undefined) o.credProps = !!e.credProps;
    if (e.credentialProtectionPolicy !== undefined) o.credentialProtectionPolicy = String(e.credentialProtectionPolicy);
    if (e.enforceCredentialProtectionPolicy !== undefined) o.enforceCredentialProtectionPolicy = !!e.enforceCredentialProtectionPolicy;
    if (e.getCredBlob !== undefined) o.getCredBlob = !!e.getCredBlob;
    if (e.hmacCreateSecret !== undefined) o.hmacCreateSecret = !!e.hmacCreateSecret;
    if (e.largeBlob !== undefined) { var lb = dict(e.largeBlob, "largeBlob"); o.largeBlob = {}; if (lb.read !== undefined) o.largeBlob.read = !!lb.read; if (lb.support !== undefined) o.largeBlob.support = String(lb.support); if (lb.write !== undefined) o.largeBlob.write = bytesOf(lb.write, "largeBlob.write"); }
    if (e.minPinLength !== undefined) o.minPinLength = !!e.minPinLength;
    if (e.prf !== undefined) {
      var p = dict(e.prf, "prf"), vals = function (v) { v = dict(v, "prf values"); var r = { first: bytesOf(reqMember(v, "first", "prf values"), "prf.first") }; if (v.second !== undefined) r.second = bytesOf(v.second, "prf.second"); return r; };
      o.prf = {};
      if (p.eval !== undefined) o.prf.eval = vals(p.eval);
      if (p.evalByCredential !== undefined) { o.prf.evalByCredential = {}; Object.keys(p.evalByCredential).forEach(function (k) { o.prf.evalByCredential[k] = vals(p.evalByCredential[k]); }); }
    }
    if (e.remoteClientDataJSON !== undefined) o.remoteClientDataJSON = String(e.remoteClientDataJSON);
    return o;
  };
  var convertCreate = function (pk) {
    pk = dict(pk, "publicKey");
    var o = {};
    o.attestation = pk.attestation === undefined ? "none" : String(pk.attestation);
    o.attestationFormats = pk.attestationFormats === undefined ? [] : __jb.arrayFrom(pk.attestationFormats, String);
    if (pk.authenticatorSelection !== undefined) {
      if (pk.authenticatorSelection === null || typeof pk.authenticatorSelection !== "object") throw new TypeError("authenticatorSelection is not a dictionary");
      var s = pk.authenticatorSelection;
      o.authenticatorSelection = { authenticatorAttachment: s.authenticatorAttachment === undefined ? undefined : String(s.authenticatorAttachment), requireResidentKey: !!s.requireResidentKey, residentKey: s.residentKey === undefined ? undefined : String(s.residentKey), userVerification: s.userVerification === undefined ? "preferred" : String(s.userVerification) };
    }
    o.challenge = bytesOf(reqMember(pk, "challenge", "PublicKeyCredentialCreationOptions"), "challenge");
    o.excludeCredentials = descriptors(pk.excludeCredentials, "excludeCredentials");
    o.extensions = convertExtensions(pk.extensions);
    o.hints = pk.hints === undefined ? [] : __jb.arrayFrom(pk.hints, String);
    var params = reqMember(pk, "pubKeyCredParams", "PublicKeyCredentialCreationOptions");
    if (params === null || typeof params !== "object" || typeof params[Symbol.iterator] !== "function") throw new TypeError("pubKeyCredParams is not a sequence");
    o.pubKeyCredParams = __jb.arrayFrom(params, function (p) { p = dict(p, "pubKeyCredParams"); var alg = reqMember(p, "alg", "PublicKeyCredentialParameters"); return { alg: Number(alg) | 0, type: String(reqMember(p, "type", "PublicKeyCredentialParameters")) }; });
    var rp = reqMember(pk, "rp", "PublicKeyCredentialCreationOptions");
    if (rp === null || typeof rp !== "object") throw new TypeError("rp is not a dictionary");
    o.rp = { id: rp.id === undefined ? undefined : String(rp.id), name: String(reqMember(rp, "name", "PublicKeyCredentialRpEntity")) };
    if (pk.timeout !== undefined) o.timeout = Number(pk.timeout) >>> 0;
    var user = reqMember(pk, "user", "PublicKeyCredentialCreationOptions");
    if (user === null || typeof user !== "object") throw new TypeError("user is not a dictionary");
    o.user = { displayName: String(reqMember(user, "displayName", "PublicKeyCredentialUserEntity")), id: bytesOf(reqMember(user, "id", "PublicKeyCredentialUserEntity"), "user.id"), name: String(reqMember(user, "name", "PublicKeyCredentialUserEntity")) };
    if (o.user.id.length < 1 || o.user.id.length > 64) throw new TypeError("user.id must be between 1 and 64 bytes");
    return o;
  };
  var convertGet = function (pk) {
    pk = dict(pk, "publicKey");
    var o = {};
    o.allowCredentials = descriptors(pk.allowCredentials, "allowCredentials");
    o.challenge = bytesOf(reqMember(pk, "challenge", "PublicKeyCredentialRequestOptions"), "challenge");
    o.extensions = convertExtensions(pk.extensions);
    o.hints = pk.hints === undefined ? [] : __jb.arrayFrom(pk.hints, String);
    o.rpId = pk.rpId === undefined ? undefined : String(pk.rpId);
    if (pk.timeout !== undefined) o.timeout = Number(pk.timeout) >>> 0;
    o.userVerification = pk.userVerification === undefined ? "preferred" : String(pk.userVerification);
    return o;
  };

  // ---- key generation and signing
  var ALGS = { "-7": { gen: { name: "ECDSA", namedCurve: "P-256" }, sign: { name: "ECDSA", hash: "SHA-256" }, imp: { name: "ECDSA", namedCurve: "P-256" } },
    "-8": { gen: { name: "Ed25519" }, sign: { name: "Ed25519" }, imp: { name: "Ed25519" } },
    "-257": { gen: { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, sign: { name: "RSASSA-PKCS1-v1_5" }, imp: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } } };
  var coseKey = function (alg, pub) {
    if (alg === -7) return subtle().exportKey("raw", pub).then(function (raw) { raw = new Uint8Array(raw); return cbor(cmap([[1, 2], [3, -7], [-1, 1], [-2, raw.slice(1, 33)], [-3, raw.slice(33, 65)]])); });
    if (alg === -8) return subtle().exportKey("raw", pub).then(function (raw) { return cbor(cmap([[1, 1], [3, -8], [-1, 6], [-2, new Uint8Array(raw)]])); });
    return subtle().exportKey("jwk", pub).then(function (j) { return cbor(cmap([[1, 3], [3, -257], [-1, fromB64url(j.n)], [-2, fromB64url(j.e)]])); });
  };
  var importPrivate = function (cred) {
    if (cred.key) return Promise.resolve(cred.key);
    var tryAlg = function (list) {
      if (!list.length) return Promise.reject(domErr("NotAllowedError", "unsupported credential key"));
      var a = list[0];
      return subtle().importKey("pkcs8", cred.pkcs8, ALGS[a].imp, true, ["sign"]).then(function (k) { cred.key = k; cred.alg = Number(a); return k; }, function () { return tryAlg(list.slice(1)); });
    };
    return tryAlg(cred.alg ? [String(cred.alg)] : ["-7", "-8", "-257"]);
  };
  var signWith = function (cred, data) {
    return importPrivate(cred).then(function (k) { return subtle().sign(ALGS[String(cred.alg)].sign, k, data); }).then(function (sig) { sig = new Uint8Array(sig); return cred.alg === -7 ? derSig(sig) : sig; });
  };

  // ---- authenticator selection
  var supportsRk = function (a) { return a.hasResidentKey && a.protocol !== "ctap1/u2f"; };
  var supportsUv = function (a) { return a.hasUserVerification && a.protocol !== "ctap1/u2f"; };
  var attachmentOf = function (a) { return a.transport === "internal" ? "platform" : "cross-platform"; };
  var hasExt = function (a, n) { return (a.extensions || []).indexOf(n) >= 0 || (n === "largeBlob" && a.hasLargeBlob) || (n === "prf" && a.hasPrf) || (n === "credBlob" && a.hasCredBlob) || (n === "minPinLength" && a.hasMinPinLength); };
  var waitTimeout = function (ms, signal) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(domErr("NotAllowedError", "The operation either timed out or was not allowed.")); }, Math.max(0, Math.min(ms === undefined ? 300000 : ms, 600000)));
      if (signal) signal.addEventListener("abort", function () { clearTimeout(t); });
    });
  };
  var flagsByte = function (up, uv, at, ed, be, bs) { return (up ? 1 : 0) | (uv ? 4 : 0) | (be ? 8 : 0) | (bs ? 16 : 0) | (at ? 64 : 0) | (ed ? 128 : 0); };

  var W = __jb.webauthn = {};
  // Real sites (not WPT, no virtual authenticator attached): the Rust passkey client and its
  // profile-backed software authenticator (host op "webauthn", src/js/passkeys.rs).
  var useNative = function () { return !__jb.wptMode && !store().authenticators.length; };
  var TRANSPORTS = { usb: 1, nfc: 1, ble: 1, "smart-card": 1, hybrid: 1, internal: 1 };
  var descJSON = function (d) { var r = { type: "public-key", id: b64url(d.id) }; if (d.transports) r.transports = d.transports.filter(function (t) { return TRANSPORTS[t]; }); return r; };
  var nativeCall = function (op, options, signal) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (signal && signal.aborted) return;
        var r; try { r = __jb.native("webauthn", { op: op, origin: location.origin, options: options }); } catch (e) { r = { error: "NotAllowedError", message: String(e) }; }
        if (r && r.ok) resolve(r.ok);
        else reject(r && r.error === "TypeError" ? new TypeError(r.message || "invalid options") : domErr(r && r.error || "NotAllowedError", r && r.message));
      }, 0);
    });
  };
  // prf inputs with their salts as base64url (passkey-rs AuthenticationExtensionsPrfInputs)
  var prfJSON = function (p) {
    var vals = function (v) { var r = { first: b64url(v.first) }; if (v.second !== undefined) r.second = b64url(v.second); return r; };
    var r = {};
    if (p.eval) r.eval = vals(p.eval);
    if (p.evalByCredential) { r.evalByCredential = {}; Object.keys(p.evalByCredential).forEach(function (k) { r.evalByCredential[k] = vals(p.evalByCredential[k]); }); }
    return r;
  };
  var nativeSignal = function (msg) {
    msg.op = "signal"; msg.origin = location.origin;
    try { __jb.native("webauthn", msg); } catch (e) {}
  };
  var extFromNative = function (e) {
    var o = {};
    Object.keys(e || {}).forEach(function (k) {
      var v = e[k];
      if (k === "prf" && v && v.results) { o.prf = { results: { first: ab(fromB64url(v.results.first)) } }; if (v.results.second) o.prf.results.second = ab(fromB64url(v.results.second)); if (v.enabled !== undefined) o.prf.enabled = v.enabled; }
      else if (k === "largeBlob" && v && typeof v.blob === "string") { o.largeBlob = Object.assign({}, v, { blob: ab(fromB64url(v.blob)) }); }
      else o[k] = v;
    });
    return o;
  };
  W.nativeCreate = function (o, rpId, signal) {
    var sel = o.authenticatorSelection;
    var json = { rp: { id: rpId, name: o.rp.name }, user: { id: b64url(o.user.id), name: o.user.name, displayName: o.user.displayName }, challenge: b64url(o.challenge),
      pubKeyCredParams: o.pubKeyCredParams.filter(function (p) { return p.type === "public-key"; }).map(function (p) { return { type: "public-key", alg: p.alg }; }),
      excludeCredentials: o.excludeCredentials.filter(function (d) { return d.type === "public-key"; }).map(descJSON),
      attestation: /^(none|indirect|direct|enterprise)$/.test(o.attestation) ? o.attestation : "none" };
    if (o.timeout !== undefined) json.timeout = o.timeout;
    if (sel) {
      json.authenticatorSelection = { requireResidentKey: sel.requireResidentKey, userVerification: /^(required|preferred|discouraged)$/.test(sel.userVerification) ? sel.userVerification : "preferred" };
      if (/^(platform|cross-platform)$/.test(sel.authenticatorAttachment || "")) json.authenticatorSelection.authenticatorAttachment = sel.authenticatorAttachment;
      if (/^(discouraged|preferred|required)$/.test(sel.residentKey || "")) json.authenticatorSelection.residentKey = sel.residentKey;
    }
    if (o.extensions.credProps) json.extensions = { credProps: true };
    if (o.extensions.prf) { json.extensions = json.extensions || {}; json.extensions.prf = prfJSON(o.extensions.prf); }
    return nativeCall("create", json, signal).then(function (r) {
      var resp = new AuthenticatorAttestationResponse(UA);
      var rr = r.response || {};
      Object.defineProperty(resp, "_r", { value: { clientDataJSON: ab(fromB64url(rr.clientDataJSON)), attestationObject: ab(fromB64url(rr.attestationObject)), authData: fromB64url(rr.authenticatorData),
        spki: rr.publicKey ? fromB64url(rr.publicKey) : null, alg: rr.publicKeyAlgorithm, transports: (rr.transports || ["internal"]).slice().sort() } });
      return makeCredential(fromB64url(r.rawId || r.id), resp, r.authenticatorAttachment || "platform", extFromNative(r.clientExtensionResults));
    });
  };
  W.nativeGet = function (o, rpId, signal) {
    var json = { challenge: b64url(o.challenge), rpId: rpId, allowCredentials: o.allowCredentials.filter(function (d) { return d.type === "public-key"; }).map(descJSON),
      userVerification: /^(required|preferred|discouraged)$/.test(o.userVerification) ? o.userVerification : "preferred" };
    if (o.timeout !== undefined) json.timeout = o.timeout;
    if (o.extensions.prf) json.extensions = { prf: prfJSON(o.extensions.prf) };
    return nativeCall("get", json, signal).then(function (r) {
      var resp = new AuthenticatorAssertionResponse(UA);
      var rr = r.response || {};
      Object.defineProperty(resp, "_r", { value: { clientDataJSON: ab(fromB64url(rr.clientDataJSON)), authenticatorData: ab(fromB64url(rr.authenticatorData)), signature: ab(fromB64url(rr.signature)),
        userHandle: rr.userHandle ? ab(fromB64url(rr.userHandle)) : null } });
      return makeCredential(fromB64url(r.rawId || r.id), resp, r.authenticatorAttachment || "platform", extFromNative(r.clientExtensionResults));
    });
  };
  W.create = function (pkIn, ctx) {
    var o = convertCreate(pkIn);
    if (!sameOriginWithAncestors() && !hasPublicKeyCredentialsCreateFeature()) throw domErr("NotAllowedError", "publickey-credentials-create is not allowed in this frame");
    var rpId = o.rp.id === undefined ? effectiveDomain() : o.rp.id;
    if (!validRpId(rpId)) throw domErr("SecurityError", "The relying party ID is not a registrable domain suffix of, nor equal to the current domain.");
    var params = o.pubKeyCredParams.length ? o.pubKeyCredParams.filter(function (p) { return p.type === "public-key"; }) : [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }];
    if (!params.length) throw domErr("NotSupportedError", "No supported pubKeyCredParams");
    var sel = o.authenticatorSelection || { requireResidentKey: false, userVerification: "preferred" };
    var rkReq = sel.residentKey !== undefined && /^(discouraged|preferred|required)$/.test(sel.residentKey) ? sel.residentKey : sel.requireResidentKey ? "required" : "discouraged";
    var uvReq = /^(required|preferred|discouraged)$/.test(sel.userVerification) ? sel.userVerification : "preferred";
    if (o.extensions.largeBlob && o.extensions.largeBlob.read !== undefined) throw domErr("NotSupportedError", "largeBlob.read is not allowed in create()");
    if (o.extensions.largeBlob && o.extensions.largeBlob.write !== undefined) throw domErr("NotSupportedError", "largeBlob.write is not allowed in create()");
    if (useNative()) return W.nativeCreate(o, rpId, ctx.signal);
    var timeout = o.timeout;
    var auths = store().authenticators.filter(function (a) {
      if (sel.authenticatorAttachment === "platform" && attachmentOf(a) !== "platform") return false;
      if (sel.authenticatorAttachment === "cross-platform" && attachmentOf(a) !== "cross-platform") return false;
      if (rkReq === "required" && !supportsRk(a)) return false;
      if (uvReq === "required" && !supportsUv(a)) return false;
      if (o.extensions.largeBlob && o.extensions.largeBlob.support === "required" && !hasExt(a, "largeBlob")) return false;
      return true;
    });
    if (!auths.length) return waitTimeout(timeout, ctx.signal);
    var a = auths[0];
    if (a.isUserConsenting === false) return waitTimeout(timeout, ctx.signal);
    if (o.excludeCredentials.some(function (d) { return d.type === "public-key" && a.credentials.some(function (c) { return c.rpId === rpId && eq(c.id, d.id); }); }))
      return Promise.reject(domErr("InvalidStateError", "The authenticator already contains one of the excluded credentials"));
    var alg = null;
    for (var i = 0; i < params.length; i++) if (ALGS[String(params[i].alg)] && (a.protocol !== "ctap1/u2f" || params[i].alg === -7)) { alg = params[i].alg; break; }
    if (alg === null) return Promise.reject(domErr("NotAllowedError", "The authenticator does not support any requested algorithm"));
    var uv = uvReq !== "discouraged" && supportsUv(a) && a.isUserVerified;
    if (uvReq === "required" && !uv) return Promise.reject(domErr("NotAllowedError", "User verification failed"));
    var resident = rkReq === "required" || (rkReq === "preferred" && supportsRk(a));
    var credId = new Uint8Array(a.protocol === "ctap1/u2f" ? 64 : 16); crypto.getRandomValues(credId);
    var cd = clientData("webauthn.create", o.challenge);
    var keyPair, cose, spki, pkcs8, rpHash;
    return subtle().generateKey(ALGS[String(alg)].gen, true, ["sign", "verify"]).then(function (kp) {
      keyPair = kp;
      return coseKey(alg, kp.publicKey);
    }).then(function (c) { cose = c; return subtle().exportKey("spki", keyPair.publicKey); }).then(function (s) {
      spki = new Uint8Array(s); return subtle().exportKey("pkcs8", keyPair.privateKey);
    }).then(function (p) { pkcs8 = new Uint8Array(p); return sha256(utf8(rpId)); }).then(function (h) {
      rpHash = h;
      var ext = {}, authExt = [];
      var E = o.extensions;
      if (E.credProps) { ext.credProps = {}; if (!(rkReq === "discouraged" && supportsRk(a))) ext.credProps.rk = resident; }
      if (E.appidExclude !== undefined) ext.appidExclude = true;
      if (E.largeBlob) { ext.largeBlob = { supported: hasExt(a, "largeBlob") && resident }; }
      if (E.prf) { ext.prf = { enabled: hasExt(a, "prf") }; if (E.prf.evalByCredential !== undefined) throw domErr("NotSupportedError", "prf.evalByCredential is not allowed in create()"); }
      if (E.hmacCreateSecret !== undefined) ext.hmacCreateSecret = hasExt(a, "prf");
      if (E.credBlob !== undefined) { if (hasExt(a, "credBlob")) authExt.push(["credBlob", E.credBlob.length <= 32]); }
      if (E.minPinLength && hasExt(a, "minPinLength")) authExt.push(["minPinLength", a.minPinLength || 4]);
      if (E.credentialProtectionPolicy !== undefined && a.protocol !== "ctap1/u2f") authExt.push(["credProtect", E.credentialProtectionPolicy === "userVerificationRequired" ? 3 : E.credentialProtectionPolicy === "userVerificationOptionalWithCredentialIDList" ? 2 : 1]);
      var extBytes = authExt.length ? cbor(cmap(authExt)) : new Uint8Array(0);
      var attested = concat(new Uint8Array(16), new Uint8Array([credId.length >> 8, credId.length & 255]), credId, cose);
      var cred = { id: credId, rpId: rpId, pkcs8: pkcs8, key: keyPair.privateKey, alg: alg, userHandle: resident ? o.user.id : o.user.id, resident: resident, signCount: 0, userName: o.user.name, userDisplayName: o.user.displayName,
        credBlob: E.credBlob !== undefined && hasExt(a, "credBlob") && E.credBlob.length <= 32 ? E.credBlob : null, largeBlob: null };
      a.credentials.push(cred);
      var authData = concat(rpHash, new Uint8Array([flagsByte(true, uv, true, authExt.length > 0)]), u32(0), attested, extBytes);
      var attObj = cbor(cmap([["fmt", "none"], ["attStmt", cmap([])], ["authData", authData]]));
      var resp = new AuthenticatorAttestationResponse(UA);
      Object.defineProperty(resp, "_r", { value: { clientDataJSON: ab(cd), attestationObject: ab(attObj), authData: authData, spki: spki, alg: alg, transports: [a.transport === "internal" ? "internal" : a.transport].sort() } });
      return makeCredential(credId, resp, attachmentOf(a), ext);
    });
  };
  var hasPublicKeyCredentialsCreateFeature = function () {
    try { var fe = globalThis.frameElement; var allow = fe && fe.getAttribute("allow"); return !!(allow && /publickey-credentials-create/.test(allow)); } catch (e) { return false; }
  };
  var hasPublicKeyCredentialsGetFeature = function () {
    try { var fe = globalThis.frameElement; var allow = fe && fe.getAttribute("allow"); return !!(allow && /publickey-credentials-get/.test(allow)); } catch (e) { return false; }
  };
  var makeCredential = function (credId, resp, attachment, ext) {
    var c = new PublicKeyCredential(UA);
    c._id = b64url(credId); c._type = "public-key";
    Object.defineProperty(c, "_pk", { value: { rawId: ab(credId), response: resp, authenticatorAttachment: attachment, ext: ext } });
    return c;
  };

  W.get = function (pkIn, ctx) {
    var o = convertGet(pkIn);
    if (!sameOriginWithAncestors() && !hasPublicKeyCredentialsGetFeature()) throw domErr("NotAllowedError", "publickey-credentials-get is not allowed in this frame");
    var rpId = o.rpId === undefined ? effectiveDomain() : o.rpId;
    if (!validRpId(rpId)) throw domErr("SecurityError", "The relying party ID is not a registrable domain suffix of, nor equal to the current domain.");
    if (o.extensions.largeBlob && o.extensions.largeBlob.support !== undefined) throw domErr("NotSupportedError", "largeBlob.support is not allowed in get()");
    if (o.extensions.largeBlob && o.extensions.largeBlob.read && o.extensions.largeBlob.write !== undefined) throw domErr("NotSupportedError", "largeBlob read and write together");
    if (o.extensions.largeBlob && o.extensions.largeBlob.write !== undefined && o.allowCredentials.length !== 1) throw domErr("NotSupportedError", "largeBlob.write needs exactly one allowed credential");
    if (o.extensions.prf && o.extensions.prf.evalByCredential) {
      if (!o.allowCredentials.length) throw domErr("NotSupportedError", "prf.evalByCredential needs allowCredentials");
      var keys = Object.keys(o.extensions.prf.evalByCredential);
      for (var ki = 0; ki < keys.length; ki++) {
        var kid; try { kid = fromB64url(keys[ki]); } catch (e) { throw domErr("SyntaxError", "prf.evalByCredential key is not base64url"); }
        if (!kid.length || !o.allowCredentials.some(function (d) { return eq(d.id, kid); })) throw domErr("SyntaxError", "prf.evalByCredential key is not an allowed credential");
      }
    }
    if (useNative() && ctx.mediation !== "conditional") return W.nativeGet(o, rpId, ctx.signal);
    var allow = o.allowCredentials.filter(function (d) { return d.type === "public-key"; });
    var appid = o.extensions.appid;
    var appidHash = null, useAppid = false;
    var mediation = ctx.mediation;
    var auths = store().authenticators;
    if (o.userVerification === "required") auths = auths.filter(supportsUv);
    var conditional = mediation === "conditional";
    if (!auths.length) return conditional ? new Promise(function () {}) : waitTimeout(o.timeout, ctx.signal);
    var match = null;
    var appidRp = appid !== undefined ? (function () { try { return new URL(appid).hostname; } catch (e) { return null; } })() : null;
    for (var i = 0; i < auths.length && !match; i++) {
      var a = auths[i];
      for (var j = 0; j < a.credentials.length; j++) {
        var c = a.credentials[j];
        var rpOk = c.rpId === rpId, viaAppid = !rpOk && appid !== undefined && (c.rpId === appid || c.rpId === appidRp);
        if (!rpOk && !viaAppid) continue;
        if (allow.length ? allow.some(function (d) { return eq(d.id, c.id); }) : c.resident) { match = { a: a, c: c }; useAppid = viaAppid; break; }
      }
    }
    if (ctx.uiMode === "immediate" && (!match || !match.c.resident && !allow.length)) return Promise.reject(domErr("NotAllowedError", "No credentials available for immediate mediation"));
    if (!match) {
      if (conditional) return new Promise(function () {});
      if (auths.every(function (x) { return x.isUserConsenting === false; })) return waitTimeout(o.timeout, ctx.signal);
      return Promise.reject(domErr("NotAllowedError", "The operation either timed out or was not allowed."));
    }
    var a2 = match.a, cred = match.c;
    if (a2.isUserConsenting === false) return waitTimeout(o.timeout, ctx.signal);
    var uv = o.userVerification !== "discouraged" && supportsUv(a2) && a2.isUserVerified;
    if (o.userVerification === "required" && !uv) return Promise.reject(domErr("NotAllowedError", "User verification failed"));
    var cd = clientData("webauthn.get", o.challenge);
    var E = o.extensions, ext = {}, authExt = [];
    if (E.appid !== undefined) ext.appid = useAppid;
    if (E.largeBlob) {
      if (E.largeBlob.read) { ext.largeBlob = {}; if (hasExt(a2, "largeBlob") && cred.largeBlob) ext.largeBlob.blob = ab(cred.largeBlob); }
      else if (E.largeBlob.write !== undefined) { ext.largeBlob = { written: hasExt(a2, "largeBlob") && cred.resident }; if (ext.largeBlob.written) cred.largeBlob = E.largeBlob.write; }
    }
    if (E.getCredBlob && hasExt(a2, "credBlob")) authExt.push(["credBlob", cred.credBlob || new Uint8Array(0)]);
    var prfP = Promise.resolve();
    if (E.prf && hasExt(a2, "prf")) {
      var vals = E.prf.evalByCredential && E.prf.evalByCredential[b64url(cred.id)] || E.prf.eval;
      if (vals) prfP = prfEval(cred, vals).then(function (r) { ext.prf = { results: r }; });
      else ext.prf = {};
    }
    cred.signCount++;
    var counter = cred.signCount;
    return prfP.then(function () { return Promise.all([sha256(utf8(useAppid ? cred.rpId : rpId)), sha256(cd)]); }).then(function (h) {
      var extBytes = authExt.length ? cbor(cmap(authExt)) : new Uint8Array(0);
      var authData = concat(h[0], new Uint8Array([flagsByte(true, uv, false, authExt.length > 0)]), u32(counter), extBytes);
      return signWith(cred, concat(authData, h[1])).then(function (sig) {
        var resp = new AuthenticatorAssertionResponse(UA);
        var uh = cred.resident && cred.userHandle && a2.protocol !== "ctap1/u2f" ? ab(cred.userHandle) : null;
        Object.defineProperty(resp, "_r", { value: { clientDataJSON: ab(cd), authenticatorData: ab(authData), signature: ab(sig), userHandle: uh } });
        return makeCredential(cred.id, resp, attachmentOf(a2), ext);
      });
    });
  };
  // PRF: HMAC-SHA-256 over SHA-256("WebAuthn PRF" || 0x00 || salt) with a per-credential secret.
  var prfEval = function (cred, vals) {
    if (!cred.prfSecret) { cred.prfSecret = new Uint8Array(32); crypto.getRandomValues(cred.prfSecret); }
    return subtle().importKey("raw", cred.prfSecret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]).then(function (k) {
      var one = function (salt) { return sha256(concat(utf8("WebAuthn PRF"), new Uint8Array([0]), salt)).then(function (s) { return subtle().sign("HMAC", k, s); }); };
      return Promise.all([one(vals.first), vals.second ? one(vals.second) : null]).then(function (r) { var out = { first: r[0] }; if (r[1]) out.second = r[1]; return out; });
    });
  };

  // ---- WebDriver virtual authenticator extension (used by the WPT runner's testdriver)
  __jb.webauthnDriver = {
    add: function (cfg) {
      cfg = cfg || {};
      var s = store(), id = "authenticator-" + (++s.seq);
      var a = { id: id, protocol: String(cfg.protocol || "ctap2"), transport: String(cfg.transport || "usb"), hasResidentKey: !!cfg.hasResidentKey, hasUserVerification: !!cfg.hasUserVerification,
        isUserVerified: !!cfg.isUserVerified, isUserConsenting: cfg.isUserConsenting === undefined ? true : !!cfg.isUserConsenting, extensions: Array.isArray(cfg.extensions) ? cfg.extensions.map(String) : [],
        hasLargeBlob: !!cfg.hasLargeBlob, hasPrf: !!cfg.hasPrf, hasCredBlob: !!cfg.hasCredBlob, hasMinPinLength: !!cfg.hasMinPinLength, minPinLength: cfg.defaultMinPinLength, credentials: [] };
      if (!/^(ctap1\/u2f|ctap2|ctap2_1)$/.test(a.protocol)) throw new Error("invalid argument: unsupported protocol " + a.protocol);
      if (a.protocol === "ctap1/u2f" && (a.hasResidentKey || a.hasUserVerification)) throw new Error("invalid argument: U2F authenticators cannot have resident keys or user verification");
      s.authenticators.push(a);
      return id;
    },
    remove: function (id) { var s = store(), i = s.authenticators.findIndex(function (a) { return a.id === id; }); if (i < 0) throw new Error("invalid argument: unknown authenticator"); s.authenticators.splice(i, 1); },
    find: function (id) { var a = store().authenticators.filter(function (x) { return x.id === id; })[0]; if (!a) throw new Error("invalid argument: unknown authenticator"); return a; },
    addCredential: function (id, c) {
      var a = this.find(id);
      var cred = { id: fromB64url(c.credentialId), rpId: String(c.rpId), pkcs8: fromB64url(c.privateKey), key: null, alg: 0, resident: !!c.isResidentCredential,
        userHandle: c.userHandle ? fromB64url(c.userHandle) : null, signCount: c.signCount | 0, largeBlob: c.largeBlob ? fromB64url(c.largeBlob) : null, credBlob: null };
      if (cred.resident && !supportsRk(a)) throw new Error("invalid argument: the authenticator does not support resident credentials");
      a.credentials.push(cred);
      return importPrivate(cred).then(function () {});
    },
    getCredentials: function (id) {
      var a = this.find(id);
      return a.credentials.map(function (c) {
        var r = { credentialId: b64url(c.id), isResidentCredential: c.resident, rpId: c.rpId, privateKey: b64url(c.pkcs8), signCount: c.signCount };
        if (c.userHandle && c.resident) r.userHandle = b64url(c.userHandle);
        if (c.largeBlob) r.largeBlob = b64url(c.largeBlob);
        if (c.userName !== undefined) { r.userName = c.userName; r.userDisplayName = c.userDisplayName; }
        return r;
      });
    },
    removeCredential: function (id, credId) { var a = this.find(id), raw = fromB64url(credId), i = a.credentials.findIndex(function (c) { return eq(c.id, raw); }); if (i < 0) throw new Error("invalid argument: unknown credential"); a.credentials.splice(i, 1); },
    removeAllCredentials: function (id) { this.find(id).credentials.length = 0; },
    setUserVerified: function (id, v) { this.find(id).isUserVerified = !!(v && typeof v === "object" ? v.isUserVerified : v); },
    setCredentialProperties: function (id, credId, props) { var a = this.find(id), raw = fromB64url(credId); a.credentials.forEach(function (c) { if (eq(c.id, raw)) Object.assign(c, props || {}); }); },
  };
})();
