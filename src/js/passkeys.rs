//! WebAuthn for real sites: `navigator.credentials.create/get({publicKey})` run through
//! 1Password's passkey-rs — `passkey_client::Client` does the WebAuthn client steps (RP ID checks,
//! client data, extensions) and a CTAP2 software authenticator signs with passkeys kept in the
//! encrypted vault (src/vault.rs). The browser is headless and driven by an agent, so user
//! presence and verification are granted without a prompt; instead the vault's site policy
//! decides: signing in needs an allowed site, registering a passkey allows its site, and every
//! use is written to the vault audit log.
//!
//! FIDO2 beyond plain passkeys:
//! - the software authenticator supports ES256 and Ed25519 keys and the `hmac-secret` extension
//!   (WebAuthn `prf`), with each credential's HMAC secrets kept in the vault;
//! - sites marked with `julia-browser vault security-key <site>` (or every site with
//!   `JB_FIDO=hardware`) go to the platform's FIDO stack instead: on Windows, webauthn.dll, which
//!   talks to USB/NFC/BLE security keys (YubiKey, Titan, ... including CTAP1/U2F keys) and Windows
//!   Hello. A person completes the touch / PIN / biometric prompt; the credential stays on the key;
//! - the WebAuthn signal API (`op: "signal"`) hides passkeys a site reports as unknown or no
//!   longer accepted, and updates the stored user names.
//!
//! Host op `webauthn` (see `host.rs`): `{op: "create" | "get", origin, options}` where `options`
//! is the `publicKey` dictionary in its JSON form (binary members base64url, as produced by the
//! page-side converter in `68b_webauthn.js`); the answer is `{ok: <RegistrationResponseJSON |
//! AuthenticationResponseJSON>}` or `{error: <DOMException name>, message}`. `list` / `remove`
//! manage the stored passkeys.

use std::sync::Mutex;

use passkey::authenticator::{
    Authenticator, CredentialStore, DiscoverabilitySupport, StoreInfo, UiHint, UserCheck, UserValidationMethod,
};
use passkey::client::{Client, DefaultClientData, WebauthnError};
use passkey::crypto::coset::{CborSerializable, CoseKey};
use passkey::crypto::rust_crypto::RustCryptoBackend;
use passkey::types::ctap2::make_credential::{
    Options, PublicKeyCredentialRpEntity as CtapRp, PublicKeyCredentialUserEntity as CtapUser,
};
use passkey::types::ctap2::{Aaguid, Ctap2Error, StatusCode};
use passkey::types::webauthn::{
    CredentialCreationOptions, CredentialRequestOptions, PublicKeyCredentialCreationOptions,
    PublicKeyCredentialDescriptor, PublicKeyCredentialRequestOptions,
};
use passkey::types::{Bytes, CredentialExtensions, Passkey, StoredHmacSecret};
use serde_json::{json, Value};
use url::Url;

static LOCK: Mutex<()> = Mutex::new(());

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn unb64(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).ok()
}

/// Passkeys in the vault as JSON (the COSE private key as base64url CBOR). Passkeys hidden by a
/// WebAuthn signal stay in the vault but are not offered to sites.
struct ProfileStore {
    creds: Vec<Passkey>,
    hidden: Vec<Value>,
}

impl ProfileStore {
    fn load() -> Result<Self, String> {
        let v = crate::vault::Vault::open()?;
        let (hidden, shown): (Vec<&Value>, Vec<&Value>) = v.passkeys().iter().partition(|p| p.get("hidden").and_then(Value::as_bool) == Some(true));
        Ok(ProfileStore { creds: shown.into_iter().filter_map(Self::decode).collect(), hidden: hidden.into_iter().cloned().collect() })
    }

    fn decode(v: &Value) -> Option<Passkey> {
        let key = CoseKey::from_slice(&unb64(v.get("key")?.as_str()?)?).ok()?;
        Some(Passkey {
            key,
            credential_id: unb64(v.get("credentialId")?.as_str()?)?.into(),
            rp_id: v.get("rpId")?.as_str()?.to_string(),
            user_handle: v.get("userHandle").and_then(Value::as_str).and_then(unb64).map(Bytes::from),
            username: v.get("userName").and_then(Value::as_str).map(str::to_string),
            user_display_name: v.get("userDisplayName").and_then(Value::as_str).map(str::to_string),
            counter: v.get("counter").and_then(Value::as_u64).map(|c| c as u32),
            extensions: CredentialExtensions {
                hmac_secret: v.get("hmacSecret").and_then(|h| {
                    Some(StoredHmacSecret {
                        cred_with_uv: unb64(h.get("uv")?.as_str()?)?,
                        cred_without_uv: h.get("noUv").and_then(Value::as_str).and_then(unb64),
                    })
                }),
            },
        })
    }

    fn encode(p: &Passkey, with_key: bool) -> Value {
        let mut v = json!({
            "credentialId": b64(&p.credential_id),
            "rpId": p.rp_id,
            "userHandle": p.user_handle.as_ref().map(|h| b64(h)),
            "userName": p.username,
            "userDisplayName": p.user_display_name,
            "counter": p.counter,
        });
        if with_key {
            if let Ok(k) = p.key.clone().to_vec() {
                v["key"] = json!(b64(&k));
            }
            if let Some(h) = &p.extensions.hmac_secret {
                v["hmacSecret"] = json!({"uv": b64(&h.cred_with_uv), "noUv": h.cred_without_uv.as_ref().map(|c| b64(c))});
            }
        }
        v
    }

    /// Write the passkeys back into the (re-read) vault, keeping each one's import metadata.
    fn save(&self) {
        let _g = crate::vault::lock();
        let Ok(mut v) = crate::vault::Vault::open() else { return };
        let old = v.passkeys().to_vec();
        let mut list: Vec<Value> = self
            .creds
            .iter()
            .map(|p| {
                let mut e = Self::encode(p, true);
                let prev = old.iter().find(|o| o.get("credentialId") == e.get("credentialId"));
                for k in ["source", "created"] {
                    e[k] = prev.and_then(|o| o.get(k).cloned()).unwrap_or_else(|| if k == "source" { json!("webauthn") } else { json!(chrono::Utc::now().to_rfc3339()) });
                }
                e
            })
            .collect();
        list.extend(self.hidden.iter().cloned());
        v.set_passkeys(list);
        let _ = v.save();
    }
}

#[async_trait::async_trait]
impl CredentialStore for ProfileStore {
    type PasskeyItem = Passkey;

    async fn find_credentials(
        &self,
        ids: Option<&[PublicKeyCredentialDescriptor]>,
        rp_id: &str,
        user_handle: Option<&[u8]>,
    ) -> Result<Vec<Passkey>, StatusCode> {
        let found: Vec<Passkey> = self
            .creds
            .iter()
            .filter(|p| p.rp_id == rp_id)
            .filter(|p| match ids {
                Some(list) if !list.is_empty() => list.iter().any(|d| *d.id == *p.credential_id),
                _ => p.user_handle.is_some(),
            })
            .filter(|p| user_handle.map_or(true, |u| p.user_handle.as_ref().map(|h| &h[..]) == Some(u)))
            .cloned()
            .collect();
        if found.is_empty() {
            Err(Ctap2Error::NoCredentials.into())
        } else {
            Ok(found)
        }
    }

    async fn save_credential(
        &mut self,
        cred: Passkey,
        user: CtapUser,
        _rp: CtapRp,
        _options: Options,
    ) -> Result<(), StatusCode> {
        // A new passkey for the same account replaces the old one.
        self.creds.retain(|p| !(p.rp_id == cred.rp_id && p.user_handle.as_ref().map(|h| &h[..]) == Some(&user.id[..])));
        let mut cred = cred;
        if cred.username.is_none() {
            cred.username = user.name.clone();
        }
        if cred.user_display_name.is_none() {
            cred.user_display_name = user.display_name.clone();
        }
        self.creds.push(cred);
        self.save();
        Ok(())
    }

    async fn update_credential(&mut self, cred: &Passkey) -> Result<(), StatusCode> {
        if let Some(p) = self.creds.iter_mut().find(|p| p.credential_id == cred.credential_id) {
            *p = cred.clone();
        }
        self.save();
        Ok(())
    }

    async fn get_info(&self) -> StoreInfo {
        StoreInfo { discoverability: DiscoverabilitySupport::ForcedDiscoverable }
    }
}

/// The agent is the user: presence and verification always succeed.
struct AgentUser;

#[async_trait::async_trait]
impl UserValidationMethod for AgentUser {
    type PasskeyItem = Passkey;

    async fn check_user<'a>(&self, _hint: UiHint<'a, Passkey>, presence: bool, verification: bool) -> Result<UserCheck, Ctap2Error> {
        Ok(UserCheck { presence, verification })
    }

    fn is_presence_enabled(&self) -> bool {
        true
    }

    fn is_verification_enabled(&self) -> Option<bool> {
        Some(true)
    }
}

fn error_name(e: &WebauthnError) -> &'static str {
    match e {
        WebauthnError::OriginRpMissmatch
        | WebauthnError::InvalidRpId
        | WebauthnError::OriginMissingDomain
        | WebauthnError::UnprotectedOrigin
        | WebauthnError::InsecureLocalhostNotAllowed => "SecurityError",
        WebauthnError::NotSupportedError => "NotSupportedError",
        WebauthnError::SyntaxError => "SyntaxError",
        WebauthnError::ValidationError { .. } | WebauthnError::SerializationError => "TypeError",
        WebauthnError::AuthenticatorError(code) if *code == u8::from(StatusCode::from(Ctap2Error::CredentialExcluded)) => "InvalidStateError",
        WebauthnError::AuthenticatorError(code) if *code == u8::from(StatusCode::from(Ctap2Error::UnsupportedAlgorithm)) => "NotSupportedError",
        _ => "NotAllowedError",
    }
}

fn err(name: &str, message: String) -> Value {
    json!({"error": name, "message": message})
}

pub fn handle(payload: &Value) -> Value {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let op = payload.get("op").and_then(Value::as_str).unwrap_or("");
    let store = match ProfileStore::load() {
        Ok(s) => s,
        Err(e) => return err("NotAllowedError", format!("the credential vault is unavailable: {e}")),
    };
    match op {
        "list" => {
            let rp = payload.get("rpId").and_then(Value::as_str);
            let list: Vec<Value> = store.creds.iter().filter(|p| rp.map_or(true, |r| p.rp_id == r)).map(|p| ProfileStore::encode(p, false)).collect();
            json!({"ok": list})
        }
        "remove" => {
            let mut store = store;
            let id = payload.get("credentialId").and_then(Value::as_str).and_then(unb64).unwrap_or_default();
            let before = store.creds.len();
            store.creds.retain(|p| *p.credential_id != *id);
            store.save();
            json!({"ok": before != store.creds.len()})
        }
        "signal" => signal(store, payload),
        "create" | "get" => {
            let origin = match payload.get("origin").and_then(Value::as_str).and_then(|o| Url::parse(o).ok()) {
                Some(u) => u,
                None => return err("SecurityError", "invalid origin".into()),
            };
            let options = payload.get("options").cloned().unwrap_or(Value::Null);
            let host = origin.host_str().unwrap_or("").to_string();
            if crate::vault::uses_security_key(&host) {
                return hardware(op, &origin, &host, options);
            }
            let action = if op == "create" { "passkey_create" } else { "passkey_get" };
            // Policy: signing in needs an allowed site; registering only needs the task scope.
            let policy = {
                let v = crate::vault::Vault::open();
                match (&v, op) {
                    (Ok(v), "get") => v.check_site(&host),
                    _ => match crate::vault::scope() {
                        Some(s) if !s.iter().any(|p| host == *p || host.ends_with(&format!(".{p}")) || p == "*") => Err(format!("{host} is outside this task's vault scope")),
                        _ => Ok(()),
                    },
                }
            };
            if let Err(e) = policy {
                crate::vault::audit(action, &host, "", "WebAuthn request by the page", false, &e);
                return err("NotAllowedError", e);
            }
            let authenticator = Authenticator::new(Aaguid::new_empty(), store, AgentUser, RustCryptoBackend)
                .hmac_secret(passkey::authenticator::extensions::HmacSecretConfig::new_without_uv().enable_on_make_credential());
            let mut client = Client::new(authenticator).allows_insecure_localhost(true);
            if op == "create" {
                let public_key: PublicKeyCredentialCreationOptions = match serde_json::from_value(options) {
                    Ok(o) => o,
                    Err(e) => return err("TypeError", format!("invalid PublicKeyCredentialCreationOptions: {e}")),
                };
                let request = CredentialCreationOptions { public_key };
                let user = request.public_key.user.name.clone();
                let rp_id = request.public_key.rp.id.clone().unwrap_or_else(|| host.clone());
                match pollster::block_on(client.register(&origin, request, DefaultClientData)) {
                    Ok(cred) => {
                        // The agent registered this passkey, so its site becomes allowed.
                        let _g = crate::vault::lock();
                        if let Ok(mut v) = crate::vault::Vault::open() {
                            if v.allow(&crate::vault::base_domain(&rp_id)) {
                                let _ = v.save();
                            }
                        }
                        crate::vault::audit(action, &host, &user, "WebAuthn registration by the page", true, &format!("rp {rp_id}"));
                        json!({"ok": serde_json::to_value(&cred).unwrap_or(Value::Null)})
                    }
                    Err(e) => {
                        crate::vault::audit(action, &host, &user, "WebAuthn registration by the page", false, &format!("{e:?}"));
                        err(error_name(&e), format!("{e:?}"))
                    }
                }
            } else {
                let public_key: PublicKeyCredentialRequestOptions = match serde_json::from_value(options) {
                    Ok(o) => o,
                    Err(e) => return err("TypeError", format!("invalid PublicKeyCredentialRequestOptions: {e}")),
                };
                let request = CredentialRequestOptions { public_key };
                match pollster::block_on(client.authenticate(&origin, request, DefaultClientData)) {
                    Ok(cred) => {
                        let v = serde_json::to_value(&cred).unwrap_or(Value::Null);
                        crate::vault::audit(action, &host, "", "WebAuthn sign-in by the page", true, &format!("credential {}", v.get("id").and_then(Value::as_str).unwrap_or("")));
                        json!({"ok": v})
                    }
                    Err(e) => {
                        crate::vault::audit(action, &host, "", "WebAuthn sign-in by the page", false, &format!("{e:?}"));
                        err(error_name(&e), format!("{e:?}"))
                    }
                }
            }
        }
        _ => err("NotSupportedError", format!("unknown webauthn op {op}")),
    }
}

/// The WebAuthn signal API for vault passkeys: `kind` "unknown" (a credential the site no longer
/// knows), "accepted" (the full list of a user's credentials) or "user" (new account names).
/// Unknown / unaccepted passkeys are hidden, not deleted, and come back if the site accepts them.
fn signal(mut store: ProfileStore, payload: &Value) -> Value {
    let origin_host = payload.get("origin").and_then(Value::as_str).and_then(|o| Url::parse(o).ok()).and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let rp = payload.get("rpId").and_then(Value::as_str).unwrap_or("").to_string();
    if rp.is_empty() || !(origin_host == rp || origin_host.ends_with(&format!(".{rp}"))) {
        return err("SecurityError", format!("rpId {rp} is not this origin's domain"));
    }
    let bytes = |k: &str| payload.get(k).and_then(Value::as_str).and_then(unb64);
    let mut changed = 0;
    let mut hide: Vec<Passkey> = Vec::new();
    match payload.get("kind").and_then(Value::as_str).unwrap_or("") {
        "unknown" => {
            let Some(id) = bytes("credentialId") else { return err("TypeError", "credentialId".into()) };
            let (gone, keep): (Vec<Passkey>, Vec<Passkey>) = store.creds.into_iter().partition(|p| p.rp_id == rp && *p.credential_id == *id);
            store.creds = keep;
            hide = gone;
        }
        "accepted" => {
            let Some(uid) = bytes("userId") else { return err("TypeError", "userId".into()) };
            let ids: Vec<Vec<u8>> = payload.get("allAcceptedCredentialIds").and_then(Value::as_array).map(|a| a.iter().filter_map(|s| s.as_str().and_then(unb64)).collect()).unwrap_or_default();
            let (gone, keep): (Vec<Passkey>, Vec<Passkey>) = store
                .creds
                .into_iter()
                .partition(|p| p.rp_id == rp && p.user_handle.as_ref().map(|h| &h[..]) == Some(&uid[..]) && !ids.iter().any(|i| *i == *p.credential_id));
            store.creds = keep;
            hide = gone;
            // a hidden passkey the site lists again comes back
            let (back, still): (Vec<Value>, Vec<Value>) = store.hidden.into_iter().partition(|h| {
                h.get("rpId").and_then(Value::as_str) == Some(rp.as_str()) && h.get("credentialId").and_then(Value::as_str).and_then(unb64).map_or(false, |c| ids.contains(&c))
            });
            store.hidden = still;
            for b in back {
                if let Some(p) = ProfileStore::decode(&b) {
                    store.creds.push(p);
                    changed += 1;
                }
            }
        }
        "user" => {
            let Some(uid) = bytes("userId") else { return err("TypeError", "userId".into()) };
            for p in store.creds.iter_mut().filter(|p| p.rp_id == rp && p.user_handle.as_ref().map(|h| &h[..]) == Some(&uid[..])) {
                p.username = payload.get("name").and_then(Value::as_str).map(str::to_string);
                p.user_display_name = payload.get("displayName").and_then(Value::as_str).map(str::to_string);
                changed += 1;
            }
        }
        other => return err("TypeError", format!("unknown signal {other}")),
    }
    let meta = crate::vault::Vault::open().map(|v| v.passkeys().to_vec()).unwrap_or_default();
    for p in &hide {
        let mut e = ProfileStore::encode(p, true);
        if let Some(old) = meta.iter().find(|o| o.get("credentialId") == e.get("credentialId")) {
            for k in ["source", "created"] {
                if let Some(v) = old.get(k) {
                    e[k] = v.clone();
                }
            }
        }
        e["hidden"] = json!(true);
        store.hidden.push(e);
    }
    changed += hide.len();
    if changed > 0 {
        store.save();
        crate::vault::audit("passkey_signal", &rp, "", "WebAuthn signal from the page", true, &format!("{} ({changed} passkeys changed)", payload.get("kind").and_then(Value::as_str).unwrap_or("")));
    }
    json!({"ok": changed})
}

/// WebAuthn through the platform's FIDO stack (security keys, Windows Hello): a person answers
/// the system prompt; nothing is stored in the vault.
fn hardware(op: &str, origin: &Url, host: &str, options: Value) -> Value {
    let action = if op == "create" { "security_key_create" } else { "security_key_get" };
    if let Some(s) = crate::vault::scope() {
        if !s.iter().any(|p| host == p || host.ends_with(&format!(".{p}")) || p == "*") {
            crate::vault::audit(action, host, "", "WebAuthn request by the page", false, "outside the task scope");
            return err("NotAllowedError", format!("{host} is outside this task's vault scope"));
        }
    }
    let out = hardware_call(op, origin, options);
    match &out {
        Ok(_) => crate::vault::audit(action, host, "", "WebAuthn request by the page (security key / platform authenticator)", true, ""),
        Err((_, m)) => crate::vault::audit(action, host, "", "WebAuthn request by the page (security key / platform authenticator)", false, m),
    }
    match out {
        Ok(v) => json!({"ok": v}),
        Err((name, m)) => err(name, m),
    }
}

#[cfg(windows)]
fn hardware_call(op: &str, origin: &Url, options: Value) -> Result<Value, (&'static str, String)> {
    use passkey::client::windows::WindowsClient;
    let mut client = WindowsClient::<RustCryptoBackend, _, ()>::new();
    if op == "create" {
        let public_key: PublicKeyCredentialCreationOptions = serde_json::from_value(options).map_err(|e| ("TypeError", format!("invalid PublicKeyCredentialCreationOptions: {e}")))?;
        let cred = pollster::block_on(client.register(origin, CredentialCreationOptions { public_key }, DefaultClientData)).map_err(|e| (error_name(&e), format!("{e:?}")))?;
        Ok(serde_json::to_value(&cred).unwrap_or(Value::Null))
    } else {
        let public_key: PublicKeyCredentialRequestOptions = serde_json::from_value(options).map_err(|e| ("TypeError", format!("invalid PublicKeyCredentialRequestOptions: {e}")))?;
        let cred = pollster::block_on(client.authenticate(origin, CredentialRequestOptions { public_key }, DefaultClientData)).map_err(|e| (error_name(&e), format!("{e:?}")))?;
        Ok(serde_json::to_value(&cred).unwrap_or(Value::Null))
    }
}

#[cfg(not(windows))]
fn hardware_call(_op: &str, _origin: &Url, _options: Value) -> Result<Value, (&'static str, String)> {
    Err(("NotSupportedError", "security keys are supported on Windows (webauthn.dll) only in this build".into()))
}

