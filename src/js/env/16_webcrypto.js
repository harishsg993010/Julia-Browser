// ---- Web Cryptography API (W3C WebCrypto, incl. Ed25519/X25519) ----------------------
// The specification's algorithm normalization, argument checks and error order live here; the
// math and key encodings are native (`crypto2` op, src/js/crypto.rs; digests/HMAC/HKDF/PBKDF2
// through the older `crypto` op). Keys keep their material in a WeakMap: secret keys as raw
// bytes, private keys as PKCS #8, public keys as SPKI.
(function () {
  var b64 = function (u8) { return __jb.bytesToB64(u8); };
  var unb64 = function (s) { return __jb.b64ToBytes(s); };
  var dom = function (name, msg) { return new DOMException(msg || name, name); };

  function native2(payload) {
    var r = __jb.native("crypto2", payload);
    if (!r) throw dom("OperationError", "crypto operation failed");
    if (r.error) throw dom(r.error, r.message || r.error);
    return r;
  }
  function native1(payload) {
    var r = __jb.native("crypto", payload);
    if (!r || r.error) throw dom("OperationError", (r && r.error) || "crypto operation failed");
    return r;
  }

  // ------------------------------------------------------------ WebIDL conversions
  var KEY_USAGES = ["encrypt", "decrypt", "sign", "verify", "deriveKey", "deriveBits", "wrapKey", "unwrapKey",
    "encapsulateKey", "encapsulateBits", "decapsulateKey", "decapsulateBits"];
  var KEY_FORMATS = ["raw", "spki", "pkcs8", "jwk", "raw-public", "raw-private", "raw-seed", "raw-secret"];

  function isBufferSource(v) { return v instanceof ArrayBuffer || ArrayBuffer.isView(v) || Object.prototype.toString.call(v) === "[object ArrayBuffer]"; }
  // "Get a copy of the bytes held by the buffer source" (a detached buffer holds none).
  function copyBytes(v) {
    if (v instanceof ArrayBuffer || Object.prototype.toString.call(v) === "[object ArrayBuffer]") return v.detached || v.byteLength === 0 ? new Uint8Array(0) : new Uint8Array(v).slice();
    if (v.buffer.detached || v.byteLength === 0) return new Uint8Array(0);
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
  }
  // WebIDL BufferSource conversion: a type check; the bytes are copied when the algorithm says so.
  function checkBufferSource(v, what) {
    if (v === null || typeof v !== "object" || !isBufferSource(v)) throw new TypeError((what || "value") + " is not a BufferSource");
    if (typeof SharedArrayBuffer !== "undefined" && (v instanceof SharedArrayBuffer || (ArrayBuffer.isView(v) && v.buffer instanceof SharedArrayBuffer))) throw new TypeError((what || "value") + " must not be backed by a SharedArrayBuffer");
    return v;
  }
  function toBufferSource(v, what) { return copyBytes(checkBufferSource(v, what)); }
  function enforceRange(v, max, what) {
    var n = Number(v);
    if (!isFinite(n)) throw new TypeError(what + " is not a finite number");
    n = n < 0 ? Math.ceil(n) : Math.floor(n);
    if (n < 0 || n > max) throw new TypeError(what + " is out of range");
    return n;
  }
  function toUnsignedLong(v) { var n = Number(v); if (!isFinite(n)) return 0; n = n < 0 ? Math.ceil(n) : Math.floor(n); n = n % 4294967296; return n < 0 ? n + 4294967296 : n; }
  function toUsages(v) {
    if (v === null || typeof v !== "object" || typeof v[Symbol.iterator] !== "function") throw new TypeError("keyUsages is not a sequence");
    var out = [];
    for (var u of v) { u = String(u); if (KEY_USAGES.indexOf(u) < 0) throw new TypeError("'" + u + "' is not a valid KeyUsage"); out.push(u); }
    return out;
  }
  function toFormat(v) { v = String(v); if (KEY_FORMATS.indexOf(v) < 0) throw new TypeError("'" + v + "' is not a valid KeyFormat"); return v; }
  function toAlgorithmIdentifier(v) { return v !== null && (typeof v === "object" || typeof v === "function") ? v : String(v); }
  function toCryptoKey(v, what) { if (!slots.has(v)) throw new TypeError((what || "key") + " is not a CryptoKey"); return v; }

  // JsonWebKey dictionary (members in lexicographic order)
  var JWK_STRINGS = ["alg", "crv", "d", "dp", "dq", "e", "k", "kty", "n", "p", "pub", "priv", "q", "qi", "use", "x", "y"];
  function toJsonWebKey(v) {
    if (v !== undefined && v !== null && typeof v !== "object" && typeof v !== "function") throw new TypeError("keyData is not a JsonWebKey");
    var out = {};
    if (v === undefined || v === null) return out;
    var order = ["alg", "crv", "d", "dp", "dq", "e", "ext", "k", "key_ops", "kty", "n", "oth", "p", "pub", "priv", "q", "qi", "r", "t", "use", "x", "y"];
    order.forEach(function (m) {
      var x = v[m];
      if (x === undefined) return;
      if (m === "ext") out.ext = !!x;
      else if (m === "key_ops") { if (x === null || typeof x !== "object" || typeof x[Symbol.iterator] !== "function") throw new TypeError("key_ops is not a sequence"); out.key_ops = __jb.arrayFrom(x, String); }
      else if (m === "oth") { if (x === null || typeof x !== "object") throw new TypeError("oth is not a sequence"); out.oth = __jb.arrayFrom(x); }
      else if (JWK_STRINGS.indexOf(m) >= 0 || m === "r" || m === "t") out[m] = String(x);
    });
    return out;
  }

  // ------------------------------------------------------------ algorithm registry
  // Dictionary member types: S = DOMString, B = BufferSource, H = HashAlgorithmIdentifier,
  // UL = [EnforceRange] unsigned long, US = [EnforceRange] unsigned short, O = [EnforceRange] octet,
  // BI = BigInteger (Uint8Array), K = CryptoKey. "!" marks required members. Members are listed
  // inherited-first, lexicographic within each dictionary (WebIDL dictionary order).
  var D = {
    Algorithm: [],
    RsaHashedKeyGenParams: [["modulusLength", "UL!"], ["publicExponent", "BI!"], ["hash", "H!"]],
    RsaHashedImportParams: [["hash", "H!"]],
    RsaPssParams: [["saltLength", "UL!"]],
    RsaOaepParams: [["label", "B"]],
    EcKeyGenParams: [["namedCurve", "S!"]],
    EcKeyImportParams: [["namedCurve", "S!"]],
    EcdsaParams: [["hash", "H!"]],
    EcdhKeyDeriveParams: [["public", "K!"]],
    AesKeyGenParams: [["length", "US!"]],
    AesDerivedKeyParams: [["length", "US!"]],
    AesCtrParams: [["counter", "B!"], ["length", "O!"]],
    AesCbcParams: [["iv", "B!"]],
    AesGcmParams: [["additionalData", "B"], ["iv", "B!"], ["tagLength", "O"]],
    HmacKeyGenParams: [["hash", "H!"], ["length", "UL"]],
    HmacImportParams: [["hash", "H!"], ["length", "UL"]],
    HkdfParams: [["hash", "H!"], ["info", "B!"], ["salt", "B!"]],
    Pbkdf2Params: [["hash", "H!"], ["iterations", "UL!"], ["salt", "B!"]],
  };
  var RSA = ["RSASSA-PKCS1-v1_5", "RSA-PSS", "RSA-OAEP"], AES = ["AES-CTR", "AES-CBC", "AES-GCM", "AES-KW"], SHA = ["SHA-1", "SHA-256", "SHA-384", "SHA-512"];
  var REG = {
    encrypt: { "RSA-OAEP": "RsaOaepParams", "AES-CTR": "AesCtrParams", "AES-CBC": "AesCbcParams", "AES-GCM": "AesGcmParams" },
    decrypt: { "RSA-OAEP": "RsaOaepParams", "AES-CTR": "AesCtrParams", "AES-CBC": "AesCbcParams", "AES-GCM": "AesGcmParams" },
    sign: { "RSASSA-PKCS1-v1_5": "Algorithm", "RSA-PSS": "RsaPssParams", "ECDSA": "EcdsaParams", "HMAC": "Algorithm", "Ed25519": "Algorithm" },
    verify: { "RSASSA-PKCS1-v1_5": "Algorithm", "RSA-PSS": "RsaPssParams", "ECDSA": "EcdsaParams", "HMAC": "Algorithm", "Ed25519": "Algorithm" },
    digest: { "SHA-1": "Algorithm", "SHA-256": "Algorithm", "SHA-384": "Algorithm", "SHA-512": "Algorithm" },
    generateKey: { "RSASSA-PKCS1-v1_5": "RsaHashedKeyGenParams", "RSA-PSS": "RsaHashedKeyGenParams", "RSA-OAEP": "RsaHashedKeyGenParams", "ECDSA": "EcKeyGenParams", "ECDH": "EcKeyGenParams",
      "AES-CTR": "AesKeyGenParams", "AES-CBC": "AesKeyGenParams", "AES-GCM": "AesKeyGenParams", "AES-KW": "AesKeyGenParams", "HMAC": "HmacKeyGenParams", "Ed25519": "Algorithm", "X25519": "Algorithm" },
    deriveBits: { "ECDH": "EcdhKeyDeriveParams", "HKDF": "HkdfParams", "PBKDF2": "Pbkdf2Params", "X25519": "EcdhKeyDeriveParams" },
    importKey: { "RSASSA-PKCS1-v1_5": "RsaHashedImportParams", "RSA-PSS": "RsaHashedImportParams", "RSA-OAEP": "RsaHashedImportParams", "ECDSA": "EcKeyImportParams", "ECDH": "EcKeyImportParams",
      "AES-CTR": "Algorithm", "AES-CBC": "Algorithm", "AES-GCM": "Algorithm", "AES-KW": "Algorithm", "HMAC": "HmacImportParams", "HKDF": "Algorithm", "PBKDF2": "Algorithm", "Ed25519": "Algorithm", "X25519": "Algorithm" },
    exportKey: { "RSASSA-PKCS1-v1_5": 1, "RSA-PSS": 1, "RSA-OAEP": 1, "ECDSA": 1, "ECDH": 1, "AES-CTR": 1, "AES-CBC": 1, "AES-GCM": 1, "AES-KW": 1, "HMAC": 1, "Ed25519": 1, "X25519": 1 },
    wrapKey: { "AES-KW": "Algorithm" },
    unwrapKey: { "AES-KW": "Algorithm" },
    "get key length": { "AES-CTR": "AesDerivedKeyParams", "AES-CBC": "AesDerivedKeyParams", "AES-GCM": "AesDerivedKeyParams", "AES-KW": "AesDerivedKeyParams", "HMAC": "HmacImportParams", "HKDF": "Algorithm", "PBKDF2": "Algorithm" },
  };
  // ASCII case-insensitive match (no Unicode case folding: "HKDF" is not "HKDF").
  function asciiLower(s) { return s.replace(/[A-Z]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 32); }); }
  function lookup(op, name) {
    var reg = REG[op], lname = asciiLower(name);
    for (var k in reg) if (asciiLower(k) === lname) return k;
    return null;
  }

  function normalize(alg, op) {
    if (typeof alg === "string") return normalize({ name: alg }, op);
    if (alg === null || (typeof alg !== "object" && typeof alg !== "function")) throw new TypeError("algorithm must be an object or a string");
    var rawName = alg.name;
    if (rawName === undefined) throw new TypeError("algorithm.name is required");
    var name = String(rawName);
    var key = lookup(op, name);
    if (!key) throw dom("NotSupportedError", "Unrecognized algorithm name '" + name + "' for " + op);
    var desired = REG[op][key];
    var out = { name: key };
    var members = D[desired] || [];
    var hashes = [];
    members.forEach(function (m) {
      var mname = m[0], type = m[1].replace("!", ""), required = m[1].indexOf("!") >= 0;
      var v = alg[mname];
      if (v === undefined) { if (required) throw new TypeError("algorithm." + mname + " is required"); return; }
      switch (type) {
        case "S": out[mname] = String(v); break;
        case "B": out[mname] = toBufferSource(v, mname); break;
        case "UL": out[mname] = enforceRange(v, 4294967295, mname); break;
        case "US": out[mname] = enforceRange(v, 65535, mname); break;
        case "O": out[mname] = enforceRange(v, 255, mname); break;
        case "BI": if (!(v instanceof Uint8Array)) throw new TypeError(mname + " must be a Uint8Array"); out[mname] = new Uint8Array(v); break;
        case "K": out[mname] = toCryptoKey(v, mname); break;
        case "H": out[mname] = toAlgorithmIdentifier(v); hashes.push(mname); break;
      }
    });
    hashes.forEach(function (h) { out[h] = normalize(out[h], "digest"); });
    return out;
  }

  // ------------------------------------------------------------ CryptoKey
  var slots = new WeakMap();
  var constructing = false;
  class CryptoKey {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); }
    get type() { return slot(this).type; }
    get extractable() { return slot(this).extractable; }
    get algorithm() { return slot(this).algorithmCached; }
    get usages() { return slot(this).usagesCached; }
  }
  function slot(k) { var s = slots.get(k); if (!s) throw new TypeError("Illegal invocation"); return s; }
  function publicAlgorithm(a) {
    var o = {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v instanceof Uint8Array) o[k] = new Uint8Array(v);
      else if (v && typeof v === "object") o[k] = publicAlgorithm(v);
      else o[k] = v;
    });
    return o;
  }
  // material: { raw } for secret keys, { der, kind, curve, alg } for asymmetric keys
  function makeKey(type, extractable, algorithm, usages, material) {
    constructing = true;
    var k; try { k = new CryptoKey(); } finally { constructing = false; }
    var order = KEY_USAGES.filter(function (u) { return usages.indexOf(u) >= 0; });
    slots.set(k, { type: type, extractable: !!extractable, algorithm: algorithm, usages: order, material: material, algorithmCached: publicAlgorithm(algorithm), usagesCached: order.slice() });
    return k;
  }
  __jb.isCryptoKey = function (v) { return slots.has(v); };
  __jb.cloneCryptoKey = function (v) { var s = slots.get(v); return makeKey(s.type, s.extractable, s.algorithm, s.usages, s.material); };

  // ------------------------------------------------------------ shared helpers
  function checkUsages(usages, allowed) {
    usages.forEach(function (u) { if (allowed.indexOf(u) < 0) throw dom("SyntaxError", "Usage '" + u + "' is not allowed for this key"); });
  }
  function intersect(usages, allowed) { return usages.filter(function (u) { return allowed.indexOf(u) >= 0; }); }
  function randomBytes(n) { return n ? unb64(__jb.native("random", { n: n })) : new Uint8Array(0); }
  function b64url(u8) { return b64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  function unb64url(s) {
    if (typeof s !== "string" || /[^A-Za-z0-9_\-=]/.test(s)) throw dom("DataError", "invalid base64url");
    var t = s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
    if (t.length % 4 === 1) throw dom("DataError", "invalid base64url");
    while (t.length % 4) t += "=";
    try { return unb64(t); } catch (e) { throw dom("DataError", "invalid base64url"); }
  }
  function hashBits(h) { return h === "SHA-384" || h === "SHA-512" ? 1024 : 512; }
  function jwkChecks(jwk, kty, usages, extractable, use) {
    if (jwk.kty !== kty) throw dom("DataError", "JWK kty must be " + kty);
    if (usages.length && jwk.use !== undefined && jwk.use !== use) throw dom("DataError", "JWK use must be " + use);
    if (jwk.key_ops !== undefined) {
      var ops = jwk.key_ops;
      if (ops.some(function (o, i) { return ops.indexOf(o) !== i; })) throw dom("DataError", "JWK key_ops has duplicates");
      if (usages.some(function (u) { return ops.indexOf(u) < 0; })) throw dom("DataError", "JWK key_ops does not allow the requested usages");
    }
    if (jwk.ext === false && extractable) throw dom("DataError", "JWK is not extractable");
  }
  function finishJwk(jwk, key) { var s = slot(key); jwk.key_ops = s.usages.slice(); jwk.ext = s.extractable; return jwk; }
  function truncateBits(bytes, length) {
    if (length === null || length === undefined) return bytes;
    if (length > bytes.length * 8) throw dom("OperationError", "length is larger than the derived secret");
    var out = bytes.slice(0, Math.ceil(length / 8));
    if (length % 8) out[out.length - 1] &= (0xff << (8 - length % 8)) & 0xff;
    return out;
  }

  // ------------------------------------------------------------ algorithms
  var ALG = {};

  // ---- AES ----
  AES.forEach(function (name) {
    var mode = name.slice(4), allowed = mode === "KW" ? ["wrapKey", "unwrapKey"] : ["encrypt", "decrypt", "wrapKey", "unwrapKey"];
    ALG[name] = {
      generate: function (a, extractable, usages) {
        checkUsages(usages, allowed);
        if ([128, 192, 256].indexOf(a.length) < 0) throw dom("OperationError", "AES key length must be 128, 192 or 256 bits");
        return makeKey("secret", extractable, { name: name, length: a.length }, usages, { raw: randomBytes(a.length / 8) });
      },
      import: function (format, data, a, extractable, usages) {
        checkUsages(usages, allowed);
        var raw;
        if (format === "raw" || format === "raw-secret") {
          raw = data;
          if ([16, 24, 32].indexOf(raw.length) < 0) throw dom("DataError", "AES key data must be 128, 192 or 256 bits");
        } else if (format === "jwk") {
          if (data.kty !== "oct") throw dom("DataError", "JWK kty must be oct");
          if (data.k === undefined) throw dom("DataError", "JWK k is missing");
          raw = unb64url(data.k);
          var expected = { 16: "A128", 24: "A192", 32: "A256" }[raw.length];
          if (!expected) throw dom("DataError", "AES key data must be 128, 192 or 256 bits");
          if (data.alg !== undefined && data.alg !== expected + mode) throw dom("DataError", "JWK alg does not match");
          jwkChecks(data, "oct", usages, extractable, "enc");
        } else throw dom("NotSupportedError", "AES keys cannot be imported as " + format);
        return makeKey("secret", extractable, { name: name, length: raw.length * 8 }, usages, { raw: raw });
      },
      export: function (format, key) {
        var s = slot(key);
        if (format === "raw" || format === "raw-secret") return s.material.raw.slice().buffer;
        if (format === "jwk") return finishJwk({ kty: "oct", k: b64url(s.material.raw), alg: "A" + s.algorithm.length + mode }, key);
        throw dom("NotSupportedError", "AES keys cannot be exported as " + format);
      },
      keyLength: function (a) { if ([128, 192, 256].indexOf(a.length) < 0) throw dom("OperationError", "AES key length must be 128, 192 or 256 bits"); return a.length; },
      cipher: function (dir, a, key, data) {
        var p = { op: "aes", mode: mode, dir: dir, key: b64(slot(key).material.raw), data: b64(data) };
        if (mode === "CBC") { if (a.iv.length !== 16) throw dom("OperationError", "AES-CBC iv must be 16 bytes"); p.iv = b64(a.iv); }
        if (mode === "CTR") { if (a.counter.length !== 16) throw dom("OperationError", "AES-CTR counter must be 16 bytes"); if (a.length === 0 || a.length > 128) throw dom("OperationError", "AES-CTR length must be 1..128"); p.counter = b64(a.counter); p.length = a.length; }
        if (mode === "GCM") {
          var tag = a.tagLength === undefined ? 128 : a.tagLength;
          if ([32, 64, 96, 104, 112, 120, 128].indexOf(tag) < 0) throw dom("OperationError", "invalid AES-GCM tagLength");
          if (dir === "decrypt" && data.length < tag / 8) throw dom("OperationError", "ciphertext is shorter than the tag");
          p.iv = b64(a.iv); p.additionalData = b64(a.additionalData || new Uint8Array(0)); p.tagLength = tag;
        }
        return unb64(native2(p).bytes).buffer;
      },
      wrap: mode === "KW" ? function (dir, a, key, data) {
        if (dir === "encrypt" && data.length % 8) throw dom("OperationError", "AES-KW data must be a multiple of 64 bits");
        return unb64(native2({ op: "aes", mode: "KW", dir: dir, key: b64(slot(key).material.raw), data: b64(data) }).bytes).buffer;
      } : null,
    };
    if (mode === "KW") ALG[name].cipher = null;
  });

  // ---- HMAC ----
  ALG.HMAC = {
    generate: function (a, extractable, usages) {
      checkUsages(usages, ["sign", "verify"]);
      var length;
      if (a.length === undefined) length = hashBits(a.hash.name);
      else if (a.length !== 0) length = a.length;
      else throw dom("OperationError", "HMAC key length must not be zero");
      var raw = randomBytes(Math.ceil(length / 8));
      return makeKey("secret", extractable, { name: "HMAC", length: length, hash: { name: a.hash.name } }, usages, { raw: raw });
    },
    import: function (format, data, a, extractable, usages) {
      checkUsages(usages, ["sign", "verify"]);
      var raw;
      if (format === "raw" || format === "raw-secret") raw = data;
      else if (format === "jwk") {
        if (data.kty !== "oct") throw dom("DataError", "JWK kty must be oct");
        if (data.k === undefined) throw dom("DataError", "JWK k is missing");
        raw = unb64url(data.k);
        var alg = { "SHA-1": "HS1", "SHA-256": "HS256", "SHA-384": "HS384", "SHA-512": "HS512" }[a.hash.name];
        if (data.alg !== undefined && data.alg !== alg) throw dom("DataError", "JWK alg does not match the hash");
        jwkChecks(data, "oct", usages, extractable, "sig");
      } else throw dom("NotSupportedError", "HMAC keys cannot be imported as " + format);
      var length = raw.length * 8;
      if (length === 0) throw dom("DataError", "HMAC key data must not be empty");
      if (a.length !== undefined) {
        if (a.length > length) throw dom("DataError", "HMAC length is longer than the key data");
        if (a.length <= length - 8) throw dom("DataError", "HMAC length is too short for the key data");
        length = a.length;
      }
      return makeKey("secret", extractable, { name: "HMAC", length: length, hash: { name: a.hash.name } }, usages, { raw: raw });
    },
    export: function (format, key) {
      var s = slot(key);
      if (format === "raw" || format === "raw-secret") return s.material.raw.slice().buffer;
      if (format === "jwk") return finishJwk({ kty: "oct", k: b64url(s.material.raw), alg: { "SHA-1": "HS1", "SHA-256": "HS256", "SHA-384": "HS384", "SHA-512": "HS512" }[s.algorithm.hash.name] }, key);
      throw dom("NotSupportedError", "HMAC keys cannot be exported as " + format);
    },
    keyLength: function (a) {
      if (a.length === undefined) return hashBits(a.hash.name);
      if (a.length !== 0) return a.length;
      throw new TypeError("HMAC length must not be zero");
    },
    sign: function (a, key, data) { var s = slot(key); return unb64(native1({ op: "hmac_sign", hash: s.algorithm.hash.name, key: b64(s.material.raw), data: b64(data) }).bytes).buffer; },
    verify: function (a, key, sig, data) { var s = slot(key); return !!native1({ op: "hmac_verify", hash: s.algorithm.hash.name, key: b64(s.material.raw), data: b64(data), signature: b64(sig) }).valid; },
  };

  // ---- HKDF / PBKDF2 ----
  ["HKDF", "PBKDF2"].forEach(function (name) {
    ALG[name] = {
      import: function (format, data, a, extractable, usages) {
        if (format !== "raw" && format !== "raw-secret") throw dom("NotSupportedError", name + " keys can only be imported as raw");
        checkUsages(usages, ["deriveKey", "deriveBits"]);
        if (extractable) throw dom("SyntaxError", name + " keys are not extractable");
        return makeKey("secret", false, { name: name }, usages, { raw: data });
      },
      keyLength: function () { return null; },
      derive: function (a, key, length) {
        if (length === null || length % 8 !== 0) throw dom("OperationError", "length must be a multiple of 8");
        if (name === "PBKDF2" && a.iterations === 0) throw dom("OperationError", "iterations must not be zero");
        if (name === "PBKDF2" && length === 0) throw dom("OperationError", "length must not be zero");
        if (length === 0) return new ArrayBuffer(0);
        var p = { op: name === "HKDF" ? "hkdf" : "pbkdf2", hash: a.hash.name, key: b64(slot(key).material.raw), salt: b64(a.salt), length: length / 8 };
        if (name === "HKDF") { if (length / 8 > 255 * ({ "SHA-1": 20, "SHA-256": 32, "SHA-384": 48, "SHA-512": 64 }[a.hash.name])) throw dom("OperationError", "HKDF length is too long"); p.info = b64(a.info); }
        else p.iterations = a.iterations;
        return unb64(native1(p).bytes).buffer;
      },
    };
  });

  // ---- asymmetric helpers ----
  var CURVES = ["P-256", "P-384", "P-521"];
  function asymKind(name) { return RSA.indexOf(name) >= 0 ? "rsa" : (name === "ECDSA" || name === "ECDH") ? "ec" : "okp"; }
  function pairFrom(r, name, algorithm, extractable, usages, pubAllowed, privAllowed) {
    var kind = asymKind(name), curve = algorithm.namedCurve;
    var pub = makeKey("public", true, algorithm, intersect(usages, pubAllowed), { der: unb64(r.public), kind: kind, curve: curve, alg: name });
    var priv = makeKey("private", extractable, algorithm, intersect(usages, privAllowed), { der: unb64(r.private), kind: kind, curve: curve, alg: name });
    return { publicKey: pub, privateKey: priv };
  }
  function importAsym(name, kind, format, data, extra) {
    var p = { op: "import", kind: kind, format: format === "raw-public" ? "raw" : format, curve: extra.curve, alg: name };
    if (format === "jwk") p.jwk = data; else p.data = b64(data);
    return native2(p);
  }
  function exportAsym(format, key) {
    var s = slot(key), m = s.material;
    if (format === "raw-public") format = "raw";
    var r = native2({ op: "export", kind: m.kind, curve: m.curve, alg: m.alg, type: s.type, der: b64(m.der), format: format });
    if (r.jwk) return finishJwk(r.jwk, key);
    return unb64(r.bytes).buffer;
  }
  function usagesForFormat(format, data, pubAllowed, privAllowed) {
    if (format === "spki" || format === "raw" || format === "raw-public") return pubAllowed;
    if (format === "pkcs8" || format === "raw-private" || format === "raw-seed") return privAllowed;
    return data && data.d !== undefined ? privAllowed : pubAllowed;
  }
  function requireType(key, type) { if (slot(key).type !== type) throw dom("InvalidAccessError", "The key must be a " + type + " key"); }

  // ---- RSA ----
  RSA.forEach(function (name) {
    var sig = name !== "RSA-OAEP";
    var pubAllowed = sig ? ["verify"] : ["encrypt", "wrapKey"], privAllowed = sig ? ["sign"] : ["decrypt", "unwrapKey"];
    var jwkAlg = function (hash) {
      var n = hash.replace("SHA-", "");
      if (name === "RSASSA-PKCS1-v1_5") return "RS" + n;
      if (name === "RSA-PSS") return "PS" + n;
      return hash === "SHA-1" ? "RSA-OAEP" : "RSA-OAEP-" + n;
    };
    var algorithmOf = function (r, hash) { return { name: name, modulusLength: r.modulusLength, publicExponent: unb64(r.publicExponent), hash: { name: hash } }; };
    ALG[name] = {
      generate: function (a, extractable, usages) {
        checkUsages(usages, pubAllowed.concat(privAllowed));
        var e = a.publicExponent;
        var r = native2({ op: "generate", kind: "rsa", modulusLength: a.modulusLength, publicExponent: b64(e) });
        var algorithm = { name: name, modulusLength: a.modulusLength, publicExponent: new Uint8Array(e), hash: { name: a.hash.name } };
        return pairFrom(r, name, algorithm, extractable, usages, pubAllowed, privAllowed);
      },
      import: function (format, data, a, extractable, usages) {
        if (format !== "spki" && format !== "pkcs8" && format !== "jwk") throw dom("NotSupportedError", "RSA keys cannot be imported as " + format);
        checkUsages(usages, usagesForFormat(format, data, pubAllowed, privAllowed));
        if (format === "jwk") {
          jwkChecks(data, "RSA", usages, extractable, sig ? "sig" : "enc");
          if (data.alg !== undefined && data.alg !== jwkAlg(a.hash.name)) throw dom("DataError", "JWK alg does not match");
        }
        var r = importAsym(name, "rsa", format, data, {});
        return makeKey(r.type, extractable, algorithmOf(r, a.hash.name), usages, { der: unb64(r.der), kind: "rsa", alg: name });
      },
      export: function (format, key) {
        if (format !== "spki" && format !== "pkcs8" && format !== "jwk") throw dom("NotSupportedError", "RSA keys cannot be exported as " + format);
        var out = exportAsym(format, key);
        if (format === "jwk") out.alg = jwkAlg(slot(key).algorithm.hash.name);
        return out;
      },
    };
    if (sig) {
      ALG[name].sign = function (a, key, data) {
        requireType(key, "private");
        var s = slot(key);
        return unb64(native2({ op: "sign", alg: name, hash: s.algorithm.hash.name, der: b64(s.material.der), data: b64(data), saltLength: a.saltLength }).bytes).buffer;
      };
      ALG[name].verify = function (a, key, signature, data) {
        requireType(key, "public");
        var s = slot(key);
        return !!native2({ op: "verify", alg: name, hash: s.algorithm.hash.name, der: b64(s.material.der), data: b64(data), signature: b64(signature), saltLength: a.saltLength }).valid;
      };
    } else {
      ALG[name].cipher = function (dir, a, key, data) {
        requireType(key, dir === "encrypt" ? "public" : "private");
        var s = slot(key);
        var p = { op: "rsa_oaep", dir: dir, hash: s.algorithm.hash.name, der: b64(s.material.der), data: b64(data) };
        if (a.label !== undefined) p.label = b64(a.label);
        return unb64(native2(p).bytes).buffer;
      };
    }
  });

  // ---- ECDSA / ECDH ----
  ["ECDSA", "ECDH"].forEach(function (name) {
    var sig = name === "ECDSA";
    var pubAllowed = sig ? ["verify"] : [], privAllowed = sig ? ["sign"] : ["deriveKey", "deriveBits"];
    ALG[name] = {
      generate: function (a, extractable, usages) {
        checkUsages(usages, pubAllowed.concat(privAllowed));
        if (CURVES.indexOf(a.namedCurve) < 0) throw dom("NotSupportedError", "Unsupported curve " + a.namedCurve);
        var r = native2({ op: "generate", kind: "ec", curve: a.namedCurve });
        return pairFrom(r, name, { name: name, namedCurve: a.namedCurve }, extractable, usages, pubAllowed, privAllowed);
      },
      import: function (format, data, a, extractable, usages) {
        if (["spki", "pkcs8", "jwk", "raw", "raw-public"].indexOf(format) < 0) throw dom("NotSupportedError", "EC keys cannot be imported as " + format);
        checkUsages(usages, usagesForFormat(format, data, pubAllowed, privAllowed));
        if (format === "jwk") {
          jwkChecks(data, "EC", usages, extractable, sig ? "sig" : "enc");
          if (data.crv !== a.namedCurve) throw dom("DataError", "JWK crv does not match the namedCurve");
          if (sig && data.alg !== undefined) {
            var algCurve = { ES256: "P-256", ES384: "P-384", ES512: "P-521" }[data.alg];
            if (algCurve !== a.namedCurve) throw dom("DataError", "JWK alg does not match the namedCurve");
          }
        }
        if (CURVES.indexOf(a.namedCurve) < 0) throw dom("DataError", "Unsupported curve " + a.namedCurve);
        var r;
        try { r = importAsym(name, "ec", format, data, { curve: a.namedCurve }); }
        catch (e) { if (e && e.name === "NotSupportedError") throw dom("DataError", e.message); throw e; }
        return makeKey(r.type, extractable, { name: name, namedCurve: a.namedCurve }, usages, { der: unb64(r.der), kind: "ec", curve: a.namedCurve, alg: name });
      },
      export: function (format, key) {
        if (["spki", "pkcs8", "jwk", "raw", "raw-public"].indexOf(format) < 0) throw dom("NotSupportedError", "EC keys cannot be exported as " + format);
        return exportAsym(format, key);
      },
    };
    if (sig) {
      ALG.ECDSA.sign = function (a, key, data) {
        requireType(key, "private");
        var s = slot(key);
        return unb64(native2({ op: "sign", alg: "ECDSA", curve: s.algorithm.namedCurve, hash: a.hash.name, der: b64(s.material.der), data: b64(data) }).bytes).buffer;
      };
      ALG.ECDSA.verify = function (a, key, signature, data) {
        requireType(key, "public");
        var s = slot(key);
        return !!native2({ op: "verify", alg: "ECDSA", curve: s.algorithm.namedCurve, hash: a.hash.name, der: b64(s.material.der), data: b64(data), signature: b64(signature) }).valid;
      };
    } else {
      ALG.ECDH.derive = function (a, key, length) { return agree("ECDH", a, key, length); };
    }
  });

  function agree(name, a, key, length) {
    var pub = a.public, ps = slot(pub), ks = slot(key);
    if (ps.type !== "public") throw dom("InvalidAccessError", "algorithm.public must be a public key");
    if (ps.algorithm.name !== ks.algorithm.name) throw dom("InvalidAccessError", "algorithm.public is for another algorithm");
    if (name === "ECDH" && ps.algorithm.namedCurve !== ks.algorithm.namedCurve) throw dom("InvalidAccessError", "algorithm.public is on another curve");
    var r = native2({ op: "derive", alg: name, curve: ks.algorithm.namedCurve, private: b64(ks.material.der), public: b64(ps.material.der) });
    return truncateBits(unb64(r.bytes), length).buffer;
  }

  // ---- Ed25519 / X25519 ----
  ["Ed25519", "X25519"].forEach(function (name) {
    var sig = name === "Ed25519";
    var pubAllowed = sig ? ["verify"] : [], privAllowed = sig ? ["sign"] : ["deriveKey", "deriveBits"];
    ALG[name] = {
      generate: function (a, extractable, usages) {
        checkUsages(usages, pubAllowed.concat(privAllowed));
        var r = native2({ op: "generate", kind: "okp", alg: name });
        return pairFrom(r, name, { name: name }, extractable, usages, pubAllowed, privAllowed);
      },
      import: function (format, data, a, extractable, usages) {
        if (["spki", "pkcs8", "jwk", "raw", "raw-public"].indexOf(format) < 0) throw dom("NotSupportedError", name + " keys cannot be imported as " + format);
        checkUsages(usages, usagesForFormat(format, data, pubAllowed, privAllowed));
        if (format === "jwk") {
          if (data.kty !== "OKP") throw dom("DataError", "JWK kty must be OKP");
          if (data.crv !== name) throw dom("DataError", "JWK crv must be " + name);
          if (sig && data.alg !== undefined && data.alg !== "Ed25519" && data.alg !== "EdDSA") throw dom("DataError", "JWK alg must be Ed25519 or EdDSA");
          jwkChecks(data, "OKP", usages, extractable, sig ? "sig" : "enc");
        }
        var r = importAsym(name, "okp", format, data, {});
        return makeKey(r.type, extractable, { name: name }, usages, { der: unb64(r.der), kind: "okp", alg: name });
      },
      export: function (format, key) {
        if (["spki", "pkcs8", "jwk", "raw", "raw-public"].indexOf(format) < 0) throw dom("NotSupportedError", name + " keys cannot be exported as " + format);
        var out = exportAsym(format, key);
        if (format === "jwk" && sig) out.alg = "Ed25519";
        return out;
      },
    };
    if (sig) {
      ALG.Ed25519.sign = function (a, key, data) { requireType(key, "private"); var s = slot(key); return unb64(native2({ op: "sign", alg: "Ed25519", der: b64(s.material.der), data: b64(data) }).bytes).buffer; };
      ALG.Ed25519.verify = function (a, key, signature, data) { requireType(key, "public"); var s = slot(key); return !!native2({ op: "verify", alg: "Ed25519", der: b64(s.material.der), data: b64(data), signature: b64(signature) }).valid; };
    } else {
      ALG.X25519.derive = function (a, key, length) { return agree("X25519", a, key, length); };
    }
  });

  // ---- digests ----
  function digestBytes(name, data) { return unb64(native1({ op: "digest", algorithm: name, data: b64(data) }).bytes); }

  // ------------------------------------------------------------ SubtleCrypto
  function run(fn) { return new Promise(function (resolve) { resolve(fn()); }); }
  function rejectWith(e) { return Promise.reject(e); }
  function needArgs(n, count, method) { if (n < count) throw new TypeError("SubtleCrypto." + method + ": " + count + " arguments required, but only " + n + " present"); }
  function brand(o) { if (!(o instanceof SubtleCrypto)) throw new TypeError("Illegal invocation"); }
  function keyResultCheck(result, usages) {
    if (slots.has(result)) { var s = slot(result); if ((s.type === "secret" || s.type === "private") && s.usages.length === 0) throw dom("SyntaxError", "usages must not be empty"); }
    else if (result && result.privateKey && slot(result.privateKey).usages.length === 0) throw dom("SyntaxError", "usages must not be empty");
    return result;
  }
  function checkKeyFor(normalized, key, usage) {
    var s = slot(key);
    if (normalized.name !== s.algorithm.name) throw dom("InvalidAccessError", "The key is not for " + normalized.name);
    if (s.usages.indexOf(usage) < 0) throw dom("InvalidAccessError", "The key does not allow " + usage);
  }
  function importInner(format, keyData, normalized, extractable, usages) {
    var impl = ALG[normalized.name];
    var key = impl.import(format, keyData, normalized, extractable, usages);
    return keyResultCheck(key, usages);
  }
  function exportInner(format, key) {
    var s = slot(key);
    if (!REG.exportKey[s.algorithm.name] || !ALG[s.algorithm.name].export) throw dom("NotSupportedError", s.algorithm.name + " keys cannot be exported");
    if (!s.extractable) throw dom("InvalidAccessError", "The key is not extractable");
    return ALG[s.algorithm.name].export(format, key);
  }
  // keyData is a BufferSource or an already converted JsonWebKey dictionary.
  function convertKeyData(format, keyData) {
    var bytes = keyData !== null && typeof keyData === "object" && isBufferSource(keyData);
    if (format === "jwk") {
      if (bytes) throw new TypeError("jwk key data must be a JsonWebKey");
      return keyData;
    }
    if (!bytes) throw new TypeError("key data must be a BufferSource");
    return copyBytes(keyData);
  }

  class SubtleCrypto {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); }
    encrypt(algorithm, key, data) {
      try {
        needArgs(arguments.length, 3, "encrypt"); brand(this);
        algorithm = toAlgorithmIdentifier(algorithm); toCryptoKey(key); checkBufferSource(data, "data");
        var n = normalize(algorithm, "encrypt"); data = copyBytes(data);
      } catch (e) { return rejectWith(e); }
      return run(function () { checkKeyFor(n, key, "encrypt"); return ALG[n.name].cipher("encrypt", n, key, data); });
    }
    decrypt(algorithm, key, data) {
      try {
        needArgs(arguments.length, 3, "decrypt"); brand(this);
        algorithm = toAlgorithmIdentifier(algorithm); toCryptoKey(key); checkBufferSource(data, "data");
        var n = normalize(algorithm, "decrypt"); data = copyBytes(data);
      } catch (e) { return rejectWith(e); }
      return run(function () { checkKeyFor(n, key, "decrypt"); return ALG[n.name].cipher("decrypt", n, key, data); });
    }
    sign(algorithm, key, data) {
      try {
        needArgs(arguments.length, 3, "sign"); brand(this);
        algorithm = toAlgorithmIdentifier(algorithm); toCryptoKey(key); checkBufferSource(data, "data");
        var n = normalize(algorithm, "sign"); data = copyBytes(data);
      } catch (e) { return rejectWith(e); }
      return run(function () { checkKeyFor(n, key, "sign"); return ALG[n.name].sign(n, key, data); });
    }
    verify(algorithm, key, signature, data) {
      try {
        needArgs(arguments.length, 4, "verify"); brand(this);
        algorithm = toAlgorithmIdentifier(algorithm); toCryptoKey(key); checkBufferSource(signature, "signature"); checkBufferSource(data, "data");
        var n = normalize(algorithm, "verify"); signature = copyBytes(signature); data = copyBytes(data);
      } catch (e) { return rejectWith(e); }
      return run(function () { checkKeyFor(n, key, "verify"); return ALG[n.name].verify(n, key, signature, data); });
    }
    digest(algorithm, data) {
      try {
        needArgs(arguments.length, 2, "digest"); brand(this);
        algorithm = toAlgorithmIdentifier(algorithm); checkBufferSource(data, "data");
        var n = normalize(algorithm, "digest"); data = copyBytes(data);
      } catch (e) { return rejectWith(e); }
      return run(function () { return digestBytes(n.name, data).buffer; });
    }
    generateKey(algorithm, extractable, keyUsages) {
      try {
        needArgs(arguments.length, 3, "generateKey"); brand(this);
        algorithm = toAlgorithmIdentifier(algorithm); extractable = !!extractable; var usages = toUsages(keyUsages);
        var n = normalize(algorithm, "generateKey");
      } catch (e) { return rejectWith(e); }
      return run(function () { return keyResultCheck(ALG[n.name].generate(n, extractable, usages), usages); });
    }
    deriveKey(algorithm, baseKey, derivedKeyType, extractable, keyUsages) {
      try {
        needArgs(arguments.length, 5, "deriveKey"); brand(this);
        algorithm = toAlgorithmIdentifier(algorithm); toCryptoKey(baseKey, "baseKey"); derivedKeyType = toAlgorithmIdentifier(derivedKeyType); extractable = !!extractable; var usages = toUsages(keyUsages);
        var n = normalize(algorithm, "deriveBits");
        var imp = normalize(derivedKeyType, "importKey");
        var len = normalize(derivedKeyType, "get key length");
      } catch (e) { return rejectWith(e); }
      return run(function () {
        checkKeyFor(n, baseKey, "deriveKey");
        var length = ALG[len.name].keyLength(len);
        var secret = new Uint8Array(ALG[n.name].derive(n, baseKey, length));
        return importInner("raw", secret, imp, extractable, usages);
      });
    }
    deriveBits(algorithm, baseKey) {
      var length = arguments[2];
      try {
        needArgs(arguments.length, 2, "deriveBits"); brand(this);
        algorithm = toAlgorithmIdentifier(algorithm); toCryptoKey(baseKey, "baseKey");
        length = length === undefined || length === null ? null : toUnsignedLong(length);
        var n = normalize(algorithm, "deriveBits");
      } catch (e) { return rejectWith(e); }
      return run(function () { checkKeyFor(n, baseKey, "deriveBits"); return ALG[n.name].derive(n, baseKey, length); });
    }
    importKey(format, keyData, algorithm, extractable, keyUsages) {
      try {
        needArgs(arguments.length, 5, "importKey"); brand(this);
        format = toFormat(format);
        var data = isBufferSource(keyData) && keyData !== null && typeof keyData === "object" ? keyData : toJsonWebKey(keyData);
        algorithm = toAlgorithmIdentifier(algorithm); extractable = !!extractable; var usages = toUsages(keyUsages);
        var n = normalize(algorithm, "importKey");
        data = convertKeyData(format, data);
      } catch (e) { return rejectWith(e); }
      return run(function () { return importInner(format, data, n, extractable, usages); });
    }
    exportKey(format, key) {
      try {
        needArgs(arguments.length, 2, "exportKey"); brand(this);
        format = toFormat(format); toCryptoKey(key);
      } catch (e) { return rejectWith(e); }
      return run(function () { return exportInner(format, key); });
    }
    wrapKey(format, key, wrappingKey, wrapAlgorithm) {
      try {
        needArgs(arguments.length, 4, "wrapKey"); brand(this);
        format = toFormat(format); toCryptoKey(key); toCryptoKey(wrappingKey, "wrappingKey"); wrapAlgorithm = toAlgorithmIdentifier(wrapAlgorithm);
        var n, viaWrap = true;
        try { n = normalize(wrapAlgorithm, "wrapKey"); } catch (e) { if (e && e.name === "NotSupportedError") { n = normalize(wrapAlgorithm, "encrypt"); viaWrap = false; } else throw e; }
      } catch (e) { return rejectWith(e); }
      return run(function () {
        checkKeyFor(n, wrappingKey, "wrapKey");
        var exported = exportInner(format, key);
        var bytes = format === "jwk" ? __utf8Encode(JSON.stringify(exported)) : new Uint8Array(exported);
        var impl = ALG[n.name];
        return viaWrap ? impl.wrap("encrypt", n, wrappingKey, bytes) : impl.cipher("encrypt", n, wrappingKey, bytes);
      });
    }
    unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgorithm, unwrappedKeyAlgorithm, extractable, keyUsages) {
      try {
        needArgs(arguments.length, 7, "unwrapKey"); brand(this);
        format = toFormat(format); checkBufferSource(wrappedKey, "wrappedKey"); toCryptoKey(unwrappingKey, "unwrappingKey");
        unwrapAlgorithm = toAlgorithmIdentifier(unwrapAlgorithm); unwrappedKeyAlgorithm = toAlgorithmIdentifier(unwrappedKeyAlgorithm);
        extractable = !!extractable; var usages = toUsages(keyUsages);
        var n, viaWrap = true;
        try { n = normalize(unwrapAlgorithm, "unwrapKey"); } catch (e) { if (e && e.name === "NotSupportedError") { n = normalize(unwrapAlgorithm, "decrypt"); viaWrap = false; } else throw e; }
        var imp = normalize(unwrappedKeyAlgorithm, "importKey");
        wrappedKey = copyBytes(wrappedKey);
      } catch (e) { return rejectWith(e); }
      return run(function () {
        checkKeyFor(n, unwrappingKey, "unwrapKey");
        var impl = ALG[n.name];
        var bytes = new Uint8Array(viaWrap ? impl.wrap("decrypt", n, unwrappingKey, wrappedKey) : impl.cipher("decrypt", n, unwrappingKey, wrappedKey));
        var data;
        if (format === "jwk") {
          var parsed;
          try { parsed = JSON.parse(__utf8Decode(bytes)); } catch (e) { throw dom("DataError", "The unwrapped key is not a JWK"); }
          data = toJsonWebKey(parsed);
        } else data = bytes;
        return importInner(format, data, imp, extractable, usages);
      });
    }
  }

  // ------------------------------------------------------------ Crypto
  var INTEGER_ARRAYS = ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "BigInt64Array", "BigUint64Array"];
  class Crypto {
    constructor() { if (!constructing) throw new TypeError("Illegal constructor"); }
    get subtle() { if (!(this instanceof Crypto)) throw new TypeError("Illegal invocation"); return subtleInstance; }
    getRandomValues(array) {
      if (arguments.length < 1) throw new TypeError("Crypto.getRandomValues: 1 argument required");
      if (!(this instanceof Crypto)) throw new TypeError("Illegal invocation");
      if (!ArrayBuffer.isView(array)) throw new TypeError("Argument is not an ArrayBufferView");
      var tag = Object.prototype.toString.call(array).slice(8, -1);
      if (array instanceof DataView || INTEGER_ARRAYS.indexOf(tag) < 0) throw dom("TypeMismatchError", "The array is not an integer array");
      if (array.byteLength > 65536) throw new QuotaExceededError("getRandomValues is limited to 65536 bytes");
      var bytes = randomBytes(array.byteLength);
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
      return array;
    }
    randomUUID() {
      if (!(this instanceof Crypto)) throw new TypeError("Illegal invocation");
      var b = randomBytes(16);
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      var h = __jb.arrayFrom(b, function (x) { return (x < 16 ? "0" : "") + x.toString(16); }).join("");
      return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
    }
  }

  constructing = true;
  var subtleInstance, cryptoInstance;
  try { subtleInstance = new SubtleCrypto(); cryptoInstance = new Crypto(); } finally { constructing = false; }
  [CryptoKey, SubtleCrypto, Crypto].forEach(function (C) {
    Object.getOwnPropertyNames(C.prototype).forEach(function (p) {
      if (p === "constructor") return;
      var d = Object.getOwnPropertyDescriptor(C.prototype, p);
      d.enumerable = true; Object.defineProperty(C.prototype, p, d);
    });
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
    Object.defineProperty(globalThis, C.name, { value: C, writable: true, configurable: true, enumerable: false });
  });
  globalThis.crypto = cryptoInstance;
  // [SecureContext]: crypto.subtle, SubtleCrypto and CryptoKey only exist in secure contexts
  // (https, wss, file, localhost). Applied when the document's URL is known.
  __jb.applySecureContext = function (url) {
    var secure = true;
    try {
      var u = new URL(url), h = u.hostname;
      if (u.protocol === "http:" || u.protocol === "ws:") secure = h === "localhost" || /\.localhost$/.test(h) || /^127\./.test(h) || h === "[::1]";
    } catch (e) {}
    // Nested documents and popups: about:, blob: and javascript: documents take their creator's
    // state, and a frame is secure only when every ancestor is.
    try {
      var fc = __jb.frameContext, parent = fc && fc.parent && fc.parent !== globalThis ? fc.parent : null;
      var creator = parent || (__jb.auxiliary && __jb.auxiliary.creator) || (__jb.workerOwnerJb ? { __jb: __jb.workerOwnerJb } : null);
      var creatorSecure = creator && creator.__jb ? creator.__jb.secureContext !== false : true;
      if (/^(about:|blob:|javascript:)/i.test(String(url)) && creator) secure = creatorSecure;
      if (parent && !creatorSecure) secure = false;
      if (__jb.workerOwnerJb && !creatorSecure) secure = false;
    } catch (e2) {}
    __jb.secureContext = secure;
    if (!secure) {
      delete Crypto.prototype.subtle;
      delete globalThis.SubtleCrypto;
      delete globalThis.CryptoKey;
    }
  };
})();
