//! Web Crypto primitives for asymmetric keys and the AES modes (`crypto.subtle`).
//!
//! The JavaScript side (`env/16_webcrypto.js`) implements the specification's algorithm
//! normalization, argument checks and error ordering; this module only does the math and the
//! key encodings. Keys travel as DER: private keys as PKCS #8, public keys as SPKI. Byte
//! strings are base64 (standard alphabet) in both directions; JWK members are base64url.
//!
//! Errors are `{"error": "<DOMException name>", "message": ...}` so the caller can reject with
//! the right exception type (`DataError` for bad key material, `OperationError` otherwise).

use base64::Engine;
use serde_json::{json, Map, Value};

type R<T> = Result<T, (&'static str, String)>;

fn data_err<T>(m: impl Into<String>) -> R<T> {
    Err(("DataError", m.into()))
}

fn op_err<T>(m: impl Into<String>) -> R<T> {
    Err(("OperationError", m.into()))
}

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn unb64(v: Option<&Value>) -> Vec<u8> {
    v.and_then(Value::as_str).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok()).unwrap_or_default()
}

fn b64url(b: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// Strict-ish base64url decoding of a JWK member (padding tolerated, other alphabets not).
fn unb64url(s: &str) -> R<Vec<u8>> {
    let t = s.trim_end_matches('=');
    if t.contains(['+', '/']) {
        return data_err("JWK member is not base64url");
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(t)
        .or_else(|_| {
            base64::engine::GeneralPurpose::new(&base64::alphabet::URL_SAFE, base64::engine::GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)).decode(t)
        })
        .or_else(|_| data_err("JWK member is not base64url"))
}

fn jwk_member(jwk: &Value, name: &str) -> R<Vec<u8>> {
    match jwk.get(name).and_then(Value::as_str) {
        Some(s) => unb64url(s),
        None => data_err(format!("JWK member \"{name}\" is missing")),
    }
}

fn s<'a>(p: &'a Value, k: &str) -> &'a str {
    p.get(k).and_then(Value::as_str).unwrap_or("")
}

/// Entry point for the `crypto2` host op.
pub fn op(payload: &Value) -> Value {
    let result = match s(payload, "op") {
        "generate" => generate(payload),
        "import" => import(payload),
        "export" => export(payload),
        "public_of" => public_of(payload),
        "sign" => sign(payload),
        "verify" => verify(payload),
        "rsa_oaep" => rsa_oaep(payload),
        "derive" => derive(payload),
        "aes" => aes(payload),
        "digest" => digest_op(payload),
        other => Err(("NotSupportedError", format!("unknown crypto operation {other}"))),
    };
    match result {
        Ok(v) => v,
        Err((name, message)) => json!({"error": name, "message": message}),
    }
}

// ---------------------------------------------------------------- digests

fn digest(hash: &str, data: &[u8]) -> R<Vec<u8>> {
    use sha2::Digest;
    Ok(match hash {
        "SHA-1" => sha1::Sha1::digest(data).to_vec(),
        "SHA-256" => sha2::Sha256::digest(data).to_vec(),
        "SHA-384" => sha2::Sha384::digest(data).to_vec(),
        "SHA-512" => sha2::Sha512::digest(data).to_vec(),
        other => return Err(("NotSupportedError", format!("unsupported hash {other}"))),
    })
}

fn digest_op(p: &Value) -> R<Value> {
    Ok(json!({"bytes": b64(&digest(s(p, "hash"), &unb64(p.get("data")))?)}))
}

// ------------------------------------------------------------- OKP encodings

const OID_ED25519: &str = "1.3.101.112";
const OID_X25519: &str = "1.3.101.110";

fn okp_oid(alg: &str) -> R<&'static str> {
    match alg {
        "Ed25519" => Ok(OID_ED25519),
        "X25519" => Ok(OID_X25519),
        _ => Err(("NotSupportedError", format!("unsupported OKP algorithm {alg}"))),
    }
}

fn okp_spki(alg: &str, public: &[u8]) -> R<Vec<u8>> {
    let prefix: &[u8] = if alg == "Ed25519" { &[0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00] } else { &[0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00] };
    Ok([prefix, public].concat())
}

fn okp_pkcs8(alg: &str, private: &[u8]) -> R<Vec<u8>> {
    let prefix: &[u8] = if alg == "Ed25519" {
        &[0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]
    } else {
        &[0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]
    };
    Ok([prefix, private].concat())
}

/// The 32-byte public key of an OKP SPKI, checking the algorithm OID.
fn okp_from_spki(alg: &str, der: &[u8]) -> R<[u8; 32]> {
    use spki::der::Decode;
    let info = spki::SubjectPublicKeyInfoRef::from_der(der).or_else(|e| data_err(format!("invalid SPKI: {e}")))?;
    if info.algorithm.oid.to_string() != okp_oid(alg)? || info.algorithm.parameters.is_some() {
        return data_err("SPKI algorithm does not match");
    }
    let bytes = info.subject_public_key.as_bytes().ok_or(("DataError", "bad bit string".to_string()))?;
    bytes.try_into().or_else(|_| data_err("public key must be 32 bytes"))
}

/// The 32-byte private key of an OKP PKCS #8 document, checking the algorithm OID.
fn okp_from_pkcs8(alg: &str, der: &[u8]) -> R<[u8; 32]> {
    use pkcs8::der::Decode;
    let info = pkcs8::PrivateKeyInfo::from_der(der).or_else(|e| data_err(format!("invalid PKCS #8: {e}")))?;
    if info.algorithm.oid.to_string() != okp_oid(alg)? || info.algorithm.parameters.is_some() {
        return data_err("PKCS #8 algorithm does not match");
    }
    // CurvePrivateKey ::= OCTET STRING
    let inner = info.private_key;
    if inner.len() != 34 || inner[0] != 0x04 || inner[1] != 0x20 {
        return data_err("private key must be a 32-byte OCTET STRING");
    }
    Ok(inner[2..].try_into().unwrap())
}

fn okp_public_from_private(alg: &str, private: &[u8; 32]) -> [u8; 32] {
    if alg == "Ed25519" {
        ed25519_dalek::SigningKey::from_bytes(private).verifying_key().to_bytes()
    } else {
        x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(*private)).to_bytes()
    }
}

fn okp_check_public(alg: &str, public: &[u8; 32]) -> R<()> {
    if alg == "Ed25519" && ed25519_dalek::VerifyingKey::from_bytes(public).is_err() {
        return data_err("invalid Ed25519 public key");
    }
    Ok(())
}

// ---------------------------------------------------------------- EC helpers

macro_rules! with_curve {
    ($curve:expr, $c:ident => $body:expr) => {
        match $curve {
            "P-256" => {
                use p256 as $c;
                $body
            }
            "P-384" => {
                use p384 as $c;
                $body
            }
            "P-521" => {
                use p521 as $c;
                $body
            }
            other => Err(("NotSupportedError", format!("unsupported curve {other}"))),
        }
    };
}

fn curve_size(curve: &str) -> usize {
    match curve {
        "P-384" => 48,
        "P-521" => 66,
        _ => 32,
    }
}

// ---------------------------------------------------------------- generate

fn generate(p: &Value) -> R<Value> {
    let kind = s(p, "kind");
    let mut rng = rand_core::OsRng;
    match kind {
        "rsa" => {
            use rsa::pkcs8::{EncodePrivateKey, EncodePublicKey};
            let bits = p.get("modulusLength").and_then(Value::as_u64).unwrap_or(2048) as usize;
            let e = unb64(p.get("publicExponent"));
            let e = rsa::BigUint::from_bytes_be(&e);
            if bits < 256 || bits > 16384 || bits % 8 != 0 {
                return op_err("unsupported modulus length");
            }
            let key = rsa::RsaPrivateKey::new_with_exp(&mut rng, bits, &e).or_else(|e| op_err(e.to_string()))?;
            let private = key.to_pkcs8_der().or_else(|e| op_err(e.to_string()))?;
            let public = key.to_public_key().to_public_key_der().or_else(|e| op_err(e.to_string()))?;
            Ok(json!({"private": b64(private.as_bytes()), "public": b64(public.as_bytes())}))
        }
        "ec" => with_curve!(s(p, "curve"), c => {
            use c::pkcs8::{EncodePrivateKey, EncodePublicKey};
            let secret = c::SecretKey::random(&mut rng);
            let private = secret.to_pkcs8_der().or_else(|e| op_err(e.to_string()))?;
            let public = secret.public_key().to_public_key_der().or_else(|e| op_err(e.to_string()))?;
            Ok(json!({"private": b64(private.as_bytes()), "public": b64(public.as_bytes())}))
        }),
        "okp" => {
            let alg = s(p, "alg");
            let mut private = [0u8; 32];
            rand_core::RngCore::fill_bytes(&mut rng, &mut private);
            let public = okp_public_from_private(alg, &private);
            Ok(json!({"private": b64(&okp_pkcs8(alg, &private)?), "public": b64(&okp_spki(alg, &public)?)}))
        }
        _ => Err(("NotSupportedError", format!("cannot generate {kind} keys"))),
    }
}

// ---------------------------------------------------------------- import

/// Import key material. Returns the normalized DER (`der`), the key `type` and, for RSA,
/// `modulusLength` and `publicExponent`.
fn import(p: &Value) -> R<Value> {
    let kind = s(p, "kind");
    let format = s(p, "format");
    let data = unb64(p.get("data"));
    let jwk = p.get("jwk").cloned().unwrap_or(Value::Null);
    match kind {
        "rsa" => import_rsa(format, &data, &jwk),
        "ec" => import_ec(s(p, "curve"), format, &data, &jwk),
        "okp" => import_okp(s(p, "alg"), format, &data, &jwk),
        _ => Err(("NotSupportedError", format!("cannot import {kind} keys"))),
    }
}

fn rsa_info_private(key: &rsa::RsaPrivateKey) -> R<Value> {
    use rsa::pkcs8::EncodePrivateKey;
    use rsa::traits::PublicKeyParts;
    let der = key.to_pkcs8_der().or_else(|e| data_err(e.to_string()))?;
    Ok(json!({"type": "private", "der": b64(der.as_bytes()), "modulusLength": key.n().bits(), "publicExponent": b64(&key.e().to_bytes_be())}))
}

fn rsa_info_public(key: &rsa::RsaPublicKey) -> R<Value> {
    use rsa::pkcs8::EncodePublicKey;
    use rsa::traits::PublicKeyParts;
    let der = key.to_public_key_der().or_else(|e| data_err(e.to_string()))?;
    Ok(json!({"type": "public", "der": b64(der.as_bytes()), "modulusLength": key.n().bits(), "publicExponent": b64(&key.e().to_bytes_be())}))
}

fn import_rsa(format: &str, data: &[u8], jwk: &Value) -> R<Value> {
    use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey};
    match format {
        "spki" => {
            let key = rsa::RsaPublicKey::from_public_key_der(data).or_else(|e| data_err(e.to_string()))?;
            rsa_info_public(&key)
        }
        "pkcs8" => {
            let key = rsa::RsaPrivateKey::from_pkcs8_der(data).or_else(|e| data_err(e.to_string()))?;
            key.validate().or_else(|e| data_err(e.to_string()))?;
            rsa_info_private(&key)
        }
        "jwk" => {
            let n = rsa::BigUint::from_bytes_be(&jwk_member(jwk, "n")?);
            let e = rsa::BigUint::from_bytes_be(&jwk_member(jwk, "e")?);
            if jwk.get("d").is_some() {
                let d = rsa::BigUint::from_bytes_be(&jwk_member(jwk, "d")?);
                if jwk.get("oth").is_some() {
                    return Err(("NotSupportedError", "multi-prime RSA keys are not supported".into()));
                }
                let has_crt = ["p", "q", "dp", "dq", "qi"].iter().any(|m| jwk.get(*m).is_some());
                let primes = if has_crt {
                    let p_ = rsa::BigUint::from_bytes_be(&jwk_member(jwk, "p")?);
                    let q = rsa::BigUint::from_bytes_be(&jwk_member(jwk, "q")?);
                    // the CRT members must be present and consistent
                    let dp = rsa::BigUint::from_bytes_be(&jwk_member(jwk, "dp")?);
                    let dq = rsa::BigUint::from_bytes_be(&jwk_member(jwk, "dq")?);
                    let _qi = jwk_member(jwk, "qi")?;
                    let one = rsa::BigUint::from(1u8);
                    if &d % (&p_ - &one) != dp || &d % (&q - &one) != dq {
                        return data_err("inconsistent RSA CRT parameters");
                    }
                    vec![p_, q]
                } else {
                    vec![]
                };
                let key = rsa::RsaPrivateKey::from_components(n, e, d, primes).or_else(|e| data_err(e.to_string()))?;
                key.validate().or_else(|e| data_err(e.to_string()))?;
                rsa_info_private(&key)
            } else {
                let key = rsa::RsaPublicKey::new(n, e).or_else(|e| data_err(e.to_string()))?;
                rsa_info_public(&key)
            }
        }
        _ => Err(("NotSupportedError", format!("RSA keys cannot be imported as {format}"))),
    }
}

fn import_ec(curve: &str, format: &str, data: &[u8], jwk: &Value) -> R<Value> {
    with_curve!(curve, c => {
        use c::pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey};
        use c::elliptic_curve::sec1::FromEncodedPoint;
        let size = curve_size(curve);
        match format {
            "spki" => {
                let key = c::PublicKey::from_public_key_der(data).or_else(|e| data_err(e.to_string()))?;
                let der = key.to_public_key_der().or_else(|e| data_err(e.to_string()))?;
                Ok(json!({"type": "public", "der": b64(der.as_bytes())}))
            }
            "pkcs8" => {
                let key = c::SecretKey::from_pkcs8_der(data).or_else(|e| data_err(e.to_string()))?;
                let der = key.to_pkcs8_der().or_else(|e| data_err(e.to_string()))?;
                Ok(json!({"type": "private", "der": b64(der.as_bytes())}))
            }
            "raw" => {
                let key = c::PublicKey::from_sec1_bytes(data).or_else(|_| data_err("invalid EC point"))?;
                let der = key.to_public_key_der().or_else(|e| data_err(e.to_string()))?;
                Ok(json!({"type": "public", "der": b64(der.as_bytes())}))
            }
            "jwk" => {
                let x = jwk_member(jwk, "x")?;
                let y = jwk_member(jwk, "y")?;
                if x.len() != size || y.len() != size {
                    return data_err("JWK coordinates have the wrong length");
                }
                let point = c::EncodedPoint::from_affine_coordinates(c::FieldBytes::from_slice(&x), c::FieldBytes::from_slice(&y), false);
                let public: Option<c::PublicKey> = c::PublicKey::from_encoded_point(&point).into();
                let public = public.ok_or(("DataError", "JWK point is not on the curve".to_string()))?;
                if jwk.get("d").is_some() {
                    let d = jwk_member(jwk, "d")?;
                    if d.len() != size {
                        return data_err("JWK \"d\" has the wrong length");
                    }
                    let secret = c::SecretKey::from_slice(&d).or_else(|_| data_err("invalid EC private key"))?;
                    if secret.public_key() != public {
                        return data_err("JWK private key does not match its public key");
                    }
                    let der = secret.to_pkcs8_der().or_else(|e| data_err(e.to_string()))?;
                    Ok(json!({"type": "private", "der": b64(der.as_bytes())}))
                } else {
                    let der = public.to_public_key_der().or_else(|e| data_err(e.to_string()))?;
                    Ok(json!({"type": "public", "der": b64(der.as_bytes())}))
                }
            }
            _ => Err(("NotSupportedError", format!("EC keys cannot be imported as {format}"))),
        }
    })
}

fn import_okp(alg: &str, format: &str, data: &[u8], jwk: &Value) -> R<Value> {
    match format {
        "spki" => {
            let public = okp_from_spki(alg, data)?;
            okp_check_public(alg, &public)?;
            Ok(json!({"type": "public", "der": b64(&okp_spki(alg, &public)?)}))
        }
        "pkcs8" => {
            let private = okp_from_pkcs8(alg, data)?;
            Ok(json!({"type": "private", "der": b64(&okp_pkcs8(alg, &private)?)}))
        }
        "raw" => {
            let public: [u8; 32] = data.try_into().or_else(|_| data_err("raw key must be 32 bytes"))?;
            okp_check_public(alg, &public)?;
            Ok(json!({"type": "public", "der": b64(&okp_spki(alg, &public)?)}))
        }
        "jwk" => {
            let x: [u8; 32] = jwk_member(jwk, "x")?.try_into().or_else(|_| data_err("JWK \"x\" must be 32 bytes"))?;
            if jwk.get("d").is_some() {
                let d: [u8; 32] = jwk_member(jwk, "d")?.try_into().or_else(|_| data_err("JWK \"d\" must be 32 bytes"))?;
                if okp_public_from_private(alg, &d) != x {
                    return data_err("JWK private key does not match its public key");
                }
                Ok(json!({"type": "private", "der": b64(&okp_pkcs8(alg, &d)?)}))
            } else {
                okp_check_public(alg, &x)?;
                Ok(json!({"type": "public", "der": b64(&okp_spki(alg, &x)?)}))
            }
        }
        _ => Err(("NotSupportedError", format!("{alg} keys cannot be imported as {format}"))),
    }
}

// ---------------------------------------------------------------- export

fn export(p: &Value) -> R<Value> {
    let kind = s(p, "kind");
    let format = s(p, "format");
    let ty = s(p, "type");
    let der = unb64(p.get("der"));
    match (format, ty) {
        ("spki", "public") | ("pkcs8", "private") => return Ok(json!({"bytes": b64(&der)})),
        ("spki", _) | ("pkcs8", _) => return Err(("InvalidAccessError", format!("a {ty} key cannot be exported as {format}"))),
        _ => {}
    }
    match kind {
        "rsa" => export_rsa(format, ty, &der),
        "ec" => export_ec(s(p, "curve"), format, ty, &der),
        "okp" => export_okp(s(p, "alg"), format, ty, &der),
        _ => Err(("NotSupportedError", format!("cannot export {kind} keys"))),
    }
}

fn export_rsa(format: &str, ty: &str, der: &[u8]) -> R<Value> {
    use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey};
    use rsa::traits::{PrivateKeyParts, PublicKeyParts};
    if format != "jwk" {
        return Err(("NotSupportedError", format!("RSA keys cannot be exported as {format}")));
    }
    let mut m = Map::new();
    m.insert("kty".into(), json!("RSA"));
    if ty == "private" {
        let mut key = rsa::RsaPrivateKey::from_pkcs8_der(der).or_else(|e| op_err(e.to_string()))?;
        key.precompute().or_else(|e| op_err(e.to_string()))?;
        let primes = key.primes();
        m.insert("n".into(), json!(b64url(&key.n().to_bytes_be())));
        m.insert("e".into(), json!(b64url(&key.e().to_bytes_be())));
        m.insert("d".into(), json!(b64url(&key.d().to_bytes_be())));
        if primes.len() >= 2 {
            m.insert("p".into(), json!(b64url(&primes[0].to_bytes_be())));
            m.insert("q".into(), json!(b64url(&primes[1].to_bytes_be())));
        }
        if let (Some(dp), Some(dq)) = (key.dp(), key.dq()) {
            m.insert("dp".into(), json!(b64url(&dp.to_bytes_be())));
            m.insert("dq".into(), json!(b64url(&dq.to_bytes_be())));
        }
        if let Some(qi) = key.crt_coefficient() {
            m.insert("qi".into(), json!(b64url(&qi.to_bytes_be())));
        }
    } else {
        let key = rsa::RsaPublicKey::from_public_key_der(der).or_else(|e| op_err(e.to_string()))?;
        m.insert("n".into(), json!(b64url(&key.n().to_bytes_be())));
        m.insert("e".into(), json!(b64url(&key.e().to_bytes_be())));
    }
    Ok(json!({"jwk": Value::Object(m)}))
}

fn export_ec(curve: &str, format: &str, ty: &str, der: &[u8]) -> R<Value> {
    with_curve!(curve, c => {
        use c::pkcs8::{DecodePrivateKey, DecodePublicKey};
        use c::elliptic_curve::sec1::ToEncodedPoint;
        let (public, secret) = if ty == "private" {
            let sk = c::SecretKey::from_pkcs8_der(der).or_else(|e| op_err(e.to_string()))?;
            (sk.public_key(), Some(sk))
        } else {
            (c::PublicKey::from_public_key_der(der).or_else(|e| op_err(e.to_string()))?, None)
        };
        let point = public.to_encoded_point(false);
        match format {
            "raw" => {
                if secret.is_some() {
                    return Err(("InvalidAccessError", "a private key cannot be exported as raw".into()));
                }
                Ok(json!({"bytes": b64(point.as_bytes())}))
            }
            "jwk" => {
                let mut m = Map::new();
                m.insert("kty".into(), json!("EC"));
                m.insert("crv".into(), json!(curve));
                m.insert("x".into(), json!(b64url(point.x().map(|x| x.as_slice()).unwrap_or(&[]))));
                m.insert("y".into(), json!(b64url(point.y().map(|y| y.as_slice()).unwrap_or(&[]))));
                if let Some(sk) = secret {
                    m.insert("d".into(), json!(b64url(&sk.to_bytes())));
                }
                Ok(json!({"jwk": Value::Object(m)}))
            }
            _ => Err(("NotSupportedError", format!("EC keys cannot be exported as {format}"))),
        }
    })
}

fn export_okp(alg: &str, format: &str, ty: &str, der: &[u8]) -> R<Value> {
    let (public, private) = if ty == "private" {
        let d = okp_from_pkcs8(alg, der).or_else(|(_, m)| op_err(m))?;
        (okp_public_from_private(alg, &d), Some(d))
    } else {
        (okp_from_spki(alg, der).or_else(|(_, m)| op_err(m))?, None)
    };
    match format {
        "raw" => {
            if private.is_some() {
                return Err(("InvalidAccessError", "a private key cannot be exported as raw".into()));
            }
            Ok(json!({"bytes": b64(&public)}))
        }
        "jwk" => {
            let mut m = Map::new();
            m.insert("kty".into(), json!("OKP"));
            m.insert("crv".into(), json!(alg));
            m.insert("x".into(), json!(b64url(&public)));
            if let Some(d) = private {
                m.insert("d".into(), json!(b64url(&d)));
            }
            Ok(json!({"jwk": Value::Object(m)}))
        }
        _ => Err(("NotSupportedError", format!("{alg} keys cannot be exported as {format}"))),
    }
}

/// The public key (SPKI) of a private key (PKCS #8), for `getPublicKey` and key pairs.
fn public_of(p: &Value) -> R<Value> {
    let der = unb64(p.get("der"));
    match s(p, "kind") {
        "rsa" => {
            use rsa::pkcs8::{DecodePrivateKey, EncodePublicKey};
            let key = rsa::RsaPrivateKey::from_pkcs8_der(&der).or_else(|e| op_err(e.to_string()))?;
            Ok(json!({"der": b64(key.to_public_key().to_public_key_der().or_else(|e| op_err(e.to_string()))?.as_bytes())}))
        }
        "ec" => with_curve!(s(p, "curve"), c => {
            use c::pkcs8::{DecodePrivateKey, EncodePublicKey};
            let key = c::SecretKey::from_pkcs8_der(&der).or_else(|e| op_err(e.to_string()))?;
            Ok(json!({"der": b64(key.public_key().to_public_key_der().or_else(|e| op_err(e.to_string()))?.as_bytes())}))
        }),
        "okp" => {
            let alg = s(p, "alg");
            let d = okp_from_pkcs8(alg, &der).or_else(|(_, m)| op_err(m))?;
            Ok(json!({"der": b64(&okp_spki(alg, &okp_public_from_private(alg, &d))?)}))
        }
        k => Err(("NotSupportedError", format!("no public key for {k}"))),
    }
}

// ---------------------------------------------------------------- sign / verify

/// Run `$body` with `$scheme` bound to the RSA signature scheme for `alg`/`hash`.
macro_rules! with_rsa_scheme {
    ($alg:expr, $hash:expr, $salt:expr, $scheme:ident => $body:expr) => {{
        macro_rules! pick {
            ($d:ty) => {
                if $alg == "RSA-PSS" {
                    let $scheme = rsa::Pss::new_with_salt::<$d>($salt);
                    $body
                } else {
                    let $scheme = rsa::Pkcs1v15Sign::new::<$d>();
                    $body
                }
            };
        }
        match $hash {
            "SHA-1" => pick!(sha1::Sha1),
            "SHA-256" => pick!(sha2::Sha256),
            "SHA-384" => pick!(sha2::Sha384),
            "SHA-512" => pick!(sha2::Sha512),
            other => return Err(("NotSupportedError", format!("unsupported hash {other}"))),
        }
    }};
}

fn sign(p: &Value) -> R<Value> {
    let alg = s(p, "alg");
    let der = unb64(p.get("der"));
    let data = unb64(p.get("data"));
    let hash = s(p, "hash");
    let mut rng = rand_core::OsRng;
    let sig: Vec<u8> = match alg {
        "RSASSA-PKCS1-v1_5" | "RSA-PSS" => {
            use rsa::pkcs8::DecodePrivateKey;
            let key = rsa::RsaPrivateKey::from_pkcs8_der(&der).or_else(|e| op_err(e.to_string()))?;
            let salt = p.get("saltLength").and_then(Value::as_u64).unwrap_or(0) as usize;
            let hashed = digest(hash, &data)?;
            with_rsa_scheme!(alg, hash, salt, scheme => {
                use rsa::traits::SignatureScheme;
                scheme.sign(Some(&mut rng), &key, &hashed).or_else(|e| op_err(e.to_string()))?
            })
        }
        "ECDSA" => {
            let hashed = ecdsa_prehash(s(p, "curve"), digest(hash, &data)?);
            ecdsa_sign(s(p, "curve"), &der, &hashed)?
        }
        "Ed25519" => {
            use ed25519_dalek::Signer;
            let d = okp_from_pkcs8("Ed25519", &der).or_else(|(_, m)| op_err(m))?;
            ed25519_dalek::SigningKey::from_bytes(&d).sign(&data).to_bytes().to_vec()
        }
        other => return Err(("NotSupportedError", format!("cannot sign with {other}"))),
    };
    Ok(json!({"bytes": b64(&sig)}))
}

fn verify(p: &Value) -> R<Value> {
    let alg = s(p, "alg");
    let der = unb64(p.get("der"));
    let data = unb64(p.get("data"));
    let sig = unb64(p.get("signature"));
    let hash = s(p, "hash");
    let ok = match alg {
        "RSASSA-PKCS1-v1_5" | "RSA-PSS" => {
            use rsa::pkcs8::DecodePublicKey;
            let key = rsa::RsaPublicKey::from_public_key_der(&der).or_else(|e| op_err(e.to_string()))?;
            let salt = p.get("saltLength").and_then(Value::as_u64).unwrap_or(0) as usize;
            let hashed = digest(hash, &data)?;
            with_rsa_scheme!(alg, hash, salt, scheme => {
                use rsa::traits::SignatureScheme;
                scheme.verify(&key, &hashed, &sig).is_ok()
            })
        }
        "ECDSA" => {
            let hashed = ecdsa_prehash(s(p, "curve"), digest(hash, &data)?);
            ecdsa_verify(s(p, "curve"), &der, &hashed, &sig)?
        }
        "Ed25519" => {
            let public = okp_from_spki("Ed25519", &der).or_else(|(_, m)| op_err(m))?;
            match (ed25519_dalek::VerifyingKey::from_bytes(&public), <[u8; 64]>::try_from(sig.as_slice())) {
                (Ok(vk), Ok(bytes)) => {
                    let signature = ed25519_dalek::Signature::from_bytes(&bytes);
                    // RFC 8032: s must be canonical; small-order keys are rejected by verify_strict.
                    vk.verify_strict(&data, &signature).is_ok()
                }
                _ => false,
            }
        }
        other => return Err(("NotSupportedError", format!("cannot verify with {other}"))),
    };
    Ok(json!({"valid": ok}))
}

/// A digest shorter than the curve's field is left-padded with zeros: bits2int of a short hash is
/// its plain value, and the `ecdsa` crate refuses digests shorter than half the field size
/// (SHA-1 with P-384, SHA-256 with P-521).
fn ecdsa_prehash(curve: &str, hashed: Vec<u8>) -> Vec<u8> {
    let size = curve_size(curve);
    if hashed.len() >= size {
        return hashed;
    }
    let mut out = vec![0u8; size - hashed.len()];
    out.extend_from_slice(&hashed);
    out
}

fn ecdsa_sign(curve: &str, der: &[u8], hashed: &[u8]) -> R<Vec<u8>> {
    use signature::hazmat::PrehashSigner;
    match curve {
        "P-256" => {
            use p256::pkcs8::DecodePrivateKey;
            let sk = p256::ecdsa::SigningKey::from_pkcs8_der(der).or_else(|e| op_err(e.to_string()))?;
            let sig: p256::ecdsa::Signature = sk.sign_prehash(hashed).or_else(|e| op_err(e.to_string()))?;
            Ok(sig.to_bytes().to_vec())
        }
        "P-384" => {
            use p384::pkcs8::DecodePrivateKey;
            let sk = p384::ecdsa::SigningKey::from_pkcs8_der(der).or_else(|e| op_err(e.to_string()))?;
            let sig: p384::ecdsa::Signature = sk.sign_prehash(hashed).or_else(|e| op_err(e.to_string()))?;
            Ok(sig.to_bytes().to_vec())
        }
        "P-521" => {
            use p521::pkcs8::DecodePrivateKey;
            let secret = p521::SecretKey::from_pkcs8_der(der).or_else(|e| op_err(e.to_string()))?;
            let sk = p521::ecdsa::SigningKey::from_bytes(&secret.to_bytes()).or_else(|e| op_err(e.to_string()))?;
            let sig: p521::ecdsa::Signature = sk.sign_prehash(hashed).or_else(|e| op_err(e.to_string()))?;
            Ok(sig.to_bytes().to_vec())
        }
        other => Err(("NotSupportedError", format!("unsupported curve {other}"))),
    }
}

fn ecdsa_verify(curve: &str, der: &[u8], hashed: &[u8], sig: &[u8]) -> R<bool> {
    use signature::hazmat::PrehashVerifier;
    match curve {
        "P-256" => {
            use p256::pkcs8::DecodePublicKey;
            let vk = p256::ecdsa::VerifyingKey::from_public_key_der(der).or_else(|e| op_err(e.to_string()))?;
            Ok(p256::ecdsa::Signature::from_slice(sig).map(|s| vk.verify_prehash(hashed, &s).is_ok()).unwrap_or(false))
        }
        "P-384" => {
            use p384::pkcs8::DecodePublicKey;
            let vk = p384::ecdsa::VerifyingKey::from_public_key_der(der).or_else(|e| op_err(e.to_string()))?;
            Ok(p384::ecdsa::Signature::from_slice(sig).map(|s| vk.verify_prehash(hashed, &s).is_ok()).unwrap_or(false))
        }
        "P-521" => {
            use p521::elliptic_curve::sec1::ToEncodedPoint;
            use p521::pkcs8::DecodePublicKey;
            let public = p521::PublicKey::from_public_key_der(der).or_else(|e| op_err(e.to_string()))?;
            let vk = p521::ecdsa::VerifyingKey::from_sec1_bytes(public.to_encoded_point(false).as_bytes()).or_else(|e| op_err(e.to_string()))?;
            Ok(p521::ecdsa::Signature::from_slice(sig).map(|s| vk.verify_prehash(hashed, &s).is_ok()).unwrap_or(false))
        }
        other => Err(("NotSupportedError", format!("unsupported curve {other}"))),
    }
}

// ---------------------------------------------------------------- RSA-OAEP

fn rsa_oaep(p: &Value) -> R<Value> {
    use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey};
    let der = unb64(p.get("der"));
    let data = unb64(p.get("data"));
    let label = p.get("label").map(|_| unb64(p.get("label")));
    let hash = s(p, "hash");
    let encrypt = s(p, "dir") == "encrypt";
    let mut rng = rand_core::OsRng;
    macro_rules! scheme {
        ($d:ty) => {{
            let mut o = rsa::Oaep::new::<$d>();
            if let Some(l) = &label {
                if !l.is_empty() {
                    o.label = Some(String::from_utf8(l.clone()).or_else(|_| Err(("OperationError", "RSA-OAEP labels must be UTF-8 in this build".to_string())))?);
                }
            }
            o
        }};
    }
    let padding = match hash {
        "SHA-1" => scheme!(sha1::Sha1),
        "SHA-256" => scheme!(sha2::Sha256),
        "SHA-384" => scheme!(sha2::Sha384),
        "SHA-512" => scheme!(sha2::Sha512),
        other => return Err(("NotSupportedError", format!("unsupported hash {other}"))),
    };
    let out = if encrypt {
        let key = rsa::RsaPublicKey::from_public_key_der(&der).or_else(|e| op_err(e.to_string()))?;
        key.encrypt(&mut rng, padding, &data).or_else(|e| op_err(e.to_string()))?
    } else {
        let key = rsa::RsaPrivateKey::from_pkcs8_der(&der).or_else(|e| op_err(e.to_string()))?;
        key.decrypt(padding, &data).or_else(|e| op_err(e.to_string()))?
    };
    Ok(json!({"bytes": b64(&out)}))
}

// ---------------------------------------------------------------- key agreement

fn derive(p: &Value) -> R<Value> {
    let private = unb64(p.get("private"));
    let public = unb64(p.get("public"));
    let secret: Vec<u8> = match s(p, "alg") {
        "ECDH" => with_curve!(s(p, "curve"), c => {
            use c::pkcs8::{DecodePrivateKey, DecodePublicKey};
            let sk = c::SecretKey::from_pkcs8_der(&private).or_else(|e| op_err(e.to_string()))?;
            let pk = c::PublicKey::from_public_key_der(&public).or_else(|e| op_err(e.to_string()))?;
            let shared = c::elliptic_curve::ecdh::diffie_hellman(sk.to_nonzero_scalar(), pk.as_affine());
            Ok::<Vec<u8>, (&'static str, String)>(shared.raw_secret_bytes().to_vec())
        })?,
        "X25519" => {
            let d = okp_from_pkcs8("X25519", &private).or_else(|(_, m)| op_err(m))?;
            let q = okp_from_spki("X25519", &public).or_else(|(_, m)| op_err(m))?;
            let shared = x25519_dalek::StaticSecret::from(d).diffie_hellman(&x25519_dalek::PublicKey::from(q));
            if shared.as_bytes().iter().all(|b| *b == 0) {
                return op_err("X25519 produced the all-zero value");
            }
            shared.as_bytes().to_vec()
        }
        other => return Err(("NotSupportedError", format!("cannot derive with {other}"))),
    };
    Ok(json!({"bytes": b64(&secret)}))
}

// ---------------------------------------------------------------- AES modes

fn aes(p: &Value) -> R<Value> {
    let key = unb64(p.get("key"));
    let data = unb64(p.get("data"));
    let encrypt = s(p, "dir") == "encrypt";
    let out = match s(p, "mode") {
        "CBC" => aes_cbc(&key, &unb64(p.get("iv")), &data, encrypt)?,
        "CTR" => aes_ctr(&key, &unb64(p.get("counter")), p.get("length").and_then(Value::as_u64).unwrap_or(128) as u32, &data)?,
        "GCM" => aes_gcm(&key, &unb64(p.get("iv")), &unb64(p.get("additionalData")), p.get("tagLength").and_then(Value::as_u64).unwrap_or(128) as usize, &data, encrypt)?,
        "KW" => aes_kw(&key, &data, encrypt)?,
        other => return Err(("NotSupportedError", format!("unsupported AES mode {other}"))),
    };
    Ok(json!({"bytes": b64(&out)}))
}

macro_rules! with_aes {
    ($key:expr, $a:ident => $body:expr) => {
        match $key.len() {
            16 => {
                type $a = aes::Aes128;
                $body
            }
            24 => {
                type $a = aes::Aes192;
                $body
            }
            32 => {
                type $a = aes::Aes256;
                $body
            }
            _ => op_err("AES keys are 128, 192 or 256 bits"),
        }
    };
}

fn aes_cbc(key: &[u8], iv: &[u8], data: &[u8], encrypt: bool) -> R<Vec<u8>> {
    use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
    if iv.len() != 16 {
        return op_err("AES-CBC iv must be 16 bytes");
    }
    with_aes!(key, A => {
        if encrypt {
            Ok(cbc::Encryptor::<A>::new_from_slices(key, iv).or_else(|e| op_err(e.to_string()))?.encrypt_padded_vec_mut::<Pkcs7>(data))
        } else {
            cbc::Decryptor::<A>::new_from_slices(key, iv).or_else(|e| op_err(e.to_string()))?.decrypt_padded_vec_mut::<Pkcs7>(data).or_else(|_| op_err("bad padding"))
        }
    })
}

/// AES-CTR with a `length`-bit counter in the low bits of the 16-byte counter block (the high
/// bits are a fixed nonce; the counter wraps within its bits).
fn aes_ctr(key: &[u8], counter: &[u8], length: u32, data: &[u8]) -> R<Vec<u8>> {
    use aes::cipher::{BlockEncrypt, KeyInit};
    if counter.len() != 16 || length == 0 || length > 128 {
        return op_err("invalid AES-CTR parameters");
    }
    let block0 = u128::from_be_bytes(counter.try_into().unwrap());
    let mask: u128 = if length == 128 { u128::MAX } else { (1u128 << length) - 1 };
    let blocks = data.len().div_ceil(16) as u128;
    if length < 128 && blocks > (1u128 << length) {
        return op_err("AES-CTR counter would repeat");
    }
    with_aes!(key, A => {
        let cipher = A::new_from_slice(key).or_else(|e| op_err(e.to_string()))?;
        let mut out = Vec::with_capacity(data.len());
        for (i, chunk) in data.chunks(16).enumerate() {
            let ctr = (block0 & !mask) | ((block0.wrapping_add(i as u128)) & mask);
            let mut block = aes::Block::from(ctr.to_be_bytes());
            cipher.encrypt_block(&mut block);
            out.extend(chunk.iter().zip(block.iter()).map(|(a, b)| a ^ b));
        }
        Ok(out)
    })
}

/// AES-GCM with any IV length and tag lengths 32..128 (NIST SP 800-38D).
fn aes_gcm(key: &[u8], iv: &[u8], aad: &[u8], tag_bits: usize, data: &[u8], encrypt: bool) -> R<Vec<u8>> {
    use aes::cipher::{BlockEncrypt, KeyInit};
    use ghash::universal_hash::UniversalHash;
    if iv.is_empty() || ![32, 64, 96, 104, 112, 120, 128].contains(&tag_bits) {
        return op_err("invalid AES-GCM parameters");
    }
    let tag_len = tag_bits / 8;
    with_aes!(key, A => {
        let cipher = A::new_from_slice(key).or_else(|e| op_err(e.to_string()))?;
        let mut h = aes::Block::default();
        cipher.encrypt_block(&mut h);
        let ghash_of = |a: &[u8], c: &[u8]| -> [u8; 16] {
            let mut g = ghash::GHash::new(&h);
            g.update_padded(a);
            g.update_padded(c);
            let mut lens = [0u8; 16];
            lens[..8].copy_from_slice(&((a.len() as u64) * 8).to_be_bytes());
            lens[8..].copy_from_slice(&((c.len() as u64) * 8).to_be_bytes());
            g.update(&[ghash::Block::from(lens)]);
            g.finalize().into()
        };
        let j0: [u8; 16] = if iv.len() == 12 {
            let mut j = [0u8; 16];
            j[..12].copy_from_slice(iv);
            j[15] = 1;
            j
        } else {
            ghash_of(&[], iv)
        };
        let gctr = |icb: [u8; 16], input: &[u8]| -> Vec<u8> {
            let prefix = u128::from_be_bytes(icb) & !(u32::MAX as u128);
            let mut ctr = u32::from_be_bytes(icb[12..].try_into().unwrap());
            let mut out = Vec::with_capacity(input.len());
            for chunk in input.chunks(16) {
                let mut block = aes::Block::from((prefix | ctr as u128).to_be_bytes());
                cipher.encrypt_block(&mut block);
                out.extend(chunk.iter().zip(block.iter()).map(|(a, b)| a ^ b));
                ctr = ctr.wrapping_add(1);
            }
            out
        };
        let mut icb = j0;
        let c = u32::from_be_bytes(icb[12..].try_into().unwrap()).wrapping_add(1);
        icb[12..].copy_from_slice(&c.to_be_bytes());
        let tag_for = |ct: &[u8]| -> Vec<u8> {
            let s = ghash_of(aad, ct);
            gctr(j0, &s)[..tag_len].to_vec()
        };
        if encrypt {
            let ct = gctr(icb, data);
            let tag = tag_for(&ct);
            Ok([ct, tag].concat())
        } else {
            if data.len() < tag_len {
                return op_err("ciphertext shorter than the tag");
            }
            let (ct, tag) = data.split_at(data.len() - tag_len);
            let expected = tag_for(ct);
            let mut diff = 0u8;
            for (a, b) in expected.iter().zip(tag.iter()) {
                diff |= a ^ b;
            }
            if diff != 0 {
                return op_err("AES-GCM authentication failed");
            }
            Ok(gctr(icb, ct))
        }
    })
}

/// RFC 3394 key wrap.
fn aes_kw(key: &[u8], data: &[u8], wrap: bool) -> R<Vec<u8>> {
    use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
    const IV: [u8; 8] = [0xa6; 8];
    if data.len() % 8 != 0 || data.len() < if wrap { 16 } else { 24 } {
        return op_err("AES-KW data must be a multiple of 8 bytes (at least 16)");
    }
    with_aes!(key, A => {
        let cipher = A::new_from_slice(key).or_else(|e| op_err(e.to_string()))?;
        if wrap {
            let n = data.len() / 8;
            let mut a = IV;
            let mut r: Vec<[u8; 8]> = data.chunks(8).map(|c| c.try_into().unwrap()).collect();
            for j in 0..6 {
                for i in 0..n {
                    let mut b = aes::Block::default();
                    b[..8].copy_from_slice(&a);
                    b[8..].copy_from_slice(&r[i]);
                    cipher.encrypt_block(&mut b);
                    let t = (n * j + i + 1) as u64;
                    a.copy_from_slice(&b[..8]);
                    for (k, x) in t.to_be_bytes().iter().enumerate() {
                        a[k] ^= x;
                    }
                    r[i].copy_from_slice(&b[8..]);
                }
            }
            let mut out = a.to_vec();
            for block in r {
                out.extend_from_slice(&block);
            }
            Ok(out)
        } else {
            let n = data.len() / 8 - 1;
            let mut a: [u8; 8] = data[..8].try_into().unwrap();
            let mut r: Vec<[u8; 8]> = data[8..].chunks(8).map(|c| c.try_into().unwrap()).collect();
            for j in (0..6).rev() {
                for i in (0..n).rev() {
                    let t = (n * j + i + 1) as u64;
                    for (k, x) in t.to_be_bytes().iter().enumerate() {
                        a[k] ^= x;
                    }
                    let mut b = aes::Block::default();
                    b[..8].copy_from_slice(&a);
                    b[8..].copy_from_slice(&r[i]);
                    cipher.decrypt_block(&mut b);
                    a.copy_from_slice(&b[..8]);
                    r[i].copy_from_slice(&b[8..]);
                }
            }
            if a != IV {
                return op_err("AES-KW integrity check failed");
            }
            Ok(r.concat())
        }
    })
}
