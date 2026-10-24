//! Password + passkey vault for agent browsing.
//!
//! Credentials live in one encrypted file, `<local data>/julia-browser/vault.jbv` (`JB_VAULT_DIR`
//! overrides the directory): the JSON payload (logins, passkeys, allowed sites) is sealed with
//! AES-256-GCM under a random 256-bit vault key. The vault key itself is protected by
//! - **DPAPI** on Windows (bound to the Windows user account; the default there),
//! - a **passphrase** (`JB_VAULT_PASSPHRASE`, PBKDF2-HMAC-SHA256, 600k rounds) when that variable is
//!   set at creation; it must be set again to open the vault,
//! - otherwise a key file next to the vault (`vault.key`, owner-only permissions).
//!
//! The agent never receives a secret: the session commands `login`, `otp` and `new_password`
//! (src/session.rs) look up the credential here and type it into the page inside the engine; their
//! results say only which fields were filled. Agent use is limited to allowed sites (`julia-browser
//! vault allow <site>`, optionally narrowed per session with `vault_scope`), every use needs a
//! reason, and each access (allowed or denied) is appended to `vault-audit.jsonl` (no secrets).
//!
//! Passkeys made or used through WebAuthn (src/js/passkeys.rs) are stored in the same vault; the
//! older plaintext `passkeys.json` is migrated on first open and then deleted.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use rand_core::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const FORMAT: &str = "julia-vault";
const AAD: &[u8] = b"julia-vault-v1";
const PBKDF2_ROUNDS: u32 = 600_000;

/// One process-wide lock around read-modify-write of the vault file.
static LOCK: Mutex<()> = Mutex::new(());
/// Sites the current task may use (`vault_scope`); `None` = every allowed site.
static SCOPE: RwLock<Option<Vec<String>>> = RwLock::new(None);

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Login {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// Base32 secret or an otpauth:// URI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub updated: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Payload1 {
    #[serde(default)]
    logins: Vec<Login>,
    /// WebAuthn passkeys in the src/js/passkeys.rs JSON form (COSE private key as base64url CBOR).
    #[serde(default)]
    passkeys: Vec<Value>,
    /// Sites the agent may use credentials on ("example.com" covers its subdomains; "*" = all).
    #[serde(default)]
    allowed_sites: Vec<String>,
    /// Sites whose WebAuthn requests go to a FIDO security key / platform authenticator.
    #[serde(default)]
    security_key_sites: Vec<String>,
}

pub struct Vault {
    dir: PathBuf,
    header: Value,
    key: [u8; 32],
    data: Payload1,
}

pub fn dir() -> PathBuf {
    if let Ok(d) = std::env::var("JB_VAULT_DIR") {
        return PathBuf::from(d);
    }
    dirs::data_local_dir().map(|d| d.join("julia-browser")).unwrap_or_else(|| PathBuf::from(".browser_cache"))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// base64 in either alphabet, padded or not.
fn unb64(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let t: String = s.trim().trim_end_matches('=').chars().map(|c| match c { '+' => '-', '/' => '_', c => c }).collect();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(t).ok()
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand_core::OsRng.fill_bytes(&mut b);
    b
}

// ---- key protection

#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    fn run(data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: the input blob points at `data` for the duration of the call; the output blob is
        // allocated by the system and released with LocalFree after copying.
        let ok = unsafe {
            if protect {
                CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            } else {
                CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            }
        };
        if ok == 0 || out.pbData.is_null() {
            return Err(format!("DPAPI {} failed: {}", if protect { "protect" } else { "unprotect" }, std::io::Error::last_os_error()));
        }
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
        unsafe { LocalFree(out.pbData as _) };
        Ok(v)
    }
    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        run(data, true)
    }
    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        run(data, false)
    }
}

fn passphrase_key(pass: &str, salt: &[u8], rounds: u32) -> [u8; 32] {
    let mut k = [0u8; 32];
    let _ = pbkdf2::pbkdf2::<hmac::Hmac<sha2::Sha256>>(pass.as_bytes(), salt, rounds, &mut k);
    k
}

fn new_header(dir: &Path, key: &[u8; 32]) -> Result<Value, String> {
    if let Ok(pass) = std::env::var("JB_VAULT_PASSPHRASE") {
        if !pass.is_empty() {
            // The vault key is wrapped with the passphrase-derived key.
            let salt: [u8; 16] = random();
            let kek = passphrase_key(&pass, &salt, PBKDF2_ROUNDS);
            let nonce: [u8; 12] = random();
            let wrapped = Aes256Gcm::new_from_slice(&kek)
                .map_err(|e| e.to_string())?
                .encrypt(Nonce::from_slice(&nonce), Payload { msg: key, aad: AAD })
                .map_err(|_| "could not wrap the vault key".to_string())?;
            return Ok(json!({"protection": "passphrase", "kdf": "pbkdf2-sha256", "rounds": PBKDF2_ROUNDS, "salt": b64(&salt), "key_nonce": b64(&nonce), "wrapped_key": b64(&wrapped)}));
        }
    }
    #[cfg(windows)]
    {
        let _ = dir;
        Ok(json!({"protection": "dpapi", "wrapped_key": b64(&dpapi::protect(key)?)}))
    }
    #[cfg(not(windows))]
    {
        let path = dir.join("vault.key");
        std::fs::write(&path, b64(key)).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(json!({"protection": "keyfile"}))
    }
}

fn unwrap_key(dir: &Path, header: &Value) -> Result<[u8; 32], String> {
    let field = |k: &str| header.get(k).and_then(Value::as_str).and_then(unb64).ok_or_else(|| format!("vault header lacks {k}"));
    let raw = match header.get("protection").and_then(Value::as_str).unwrap_or("") {
        "passphrase" => {
            let pass = std::env::var("JB_VAULT_PASSPHRASE").map_err(|_| "the vault is protected by a passphrase: set JB_VAULT_PASSPHRASE".to_string())?;
            let rounds = header.get("rounds").and_then(Value::as_u64).unwrap_or(PBKDF2_ROUNDS as u64) as u32;
            let kek = passphrase_key(&pass, &field("salt")?, rounds);
            Aes256Gcm::new_from_slice(&kek)
                .map_err(|e| e.to_string())?
                .decrypt(Nonce::from_slice(&field("key_nonce")?), Payload { msg: &field("wrapped_key")?, aad: AAD })
                .map_err(|_| "wrong vault passphrase (JB_VAULT_PASSPHRASE)".to_string())?
        }
        #[cfg(windows)]
        "dpapi" => dpapi::unprotect(&field("wrapped_key")?)?,
        "keyfile" => {
            let path = dir.join("vault.key");
            let text = std::fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            unb64(&text).ok_or("corrupt vault.key")?
        }
        other => return Err(format!("this vault uses {other:?} key protection, which is not available here")),
    };
    raw.try_into().map_err(|_| "the vault key has the wrong length".to_string())
}

// ---- open / save

impl Vault {
    fn path(&self) -> PathBuf {
        self.dir.join("vault.jbv")
    }

    pub fn exists() -> bool {
        dir().join("vault.jbv").exists()
    }

    /// Open (creating on first use) the vault. Callers that modify it hold [`lock`].
    pub fn open() -> Result<Vault, String> {
        let dir = dir();
        let path = dir.join("vault.jbv");
        let mut v = if path.exists() {
            let text = std::fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            let file: Value = serde_json::from_str(&text).map_err(|e| format!("corrupt vault file: {e}"))?;
            if file.get("format").and_then(Value::as_str) != Some(FORMAT) {
                return Err(format!("{} is not a julia-browser vault", path.display()));
            }
            let header = file.get("header").cloned().unwrap_or(Value::Null);
            let key = unwrap_key(&dir, &header)?;
            let nonce = file.get("nonce").and_then(Value::as_str).and_then(unb64).ok_or("vault lacks nonce")?;
            let ct = file.get("ciphertext").and_then(Value::as_str).and_then(unb64).ok_or("vault lacks ciphertext")?;
            let plain = Aes256Gcm::new_from_slice(&key)
                .map_err(|e| e.to_string())?
                .decrypt(Nonce::from_slice(&nonce), Payload { msg: &ct, aad: AAD })
                .map_err(|_| "the vault could not be decrypted (wrong key or modified file)".to_string())?;
            let data: Payload1 = serde_json::from_slice(&plain).map_err(|e| format!("corrupt vault contents: {e}"))?;
            Vault { dir, header, key, data }
        } else {
            std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
            let key: [u8; 32] = random();
            let header = new_header(&dir, &key)?;
            let v = Vault { dir, header, key, data: Payload1::default() };
            v.save()?;
            audit("create", "", "", "", true, &format!("protection={}", v.protection()));
            v
        };
        v.migrate_plaintext_passkeys();
        Ok(v)
    }

    pub fn protection(&self) -> &str {
        self.header.get("protection").and_then(Value::as_str).unwrap_or("?")
    }

    pub fn save(&self) -> Result<(), String> {
        let plain = serde_json::to_vec(&self.data).map_err(|e| e.to_string())?;
        let nonce: [u8; 12] = random();
        let ct = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|e| e.to_string())?
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: &plain, aad: AAD })
            .map_err(|_| "encryption failed".to_string())?;
        let file = json!({"format": FORMAT, "version": 1, "cipher": "aes-256-gcm", "header": self.header, "nonce": b64(&nonce), "ciphertext": b64(&ct)});
        let path = self.path();
        let tmp = path.with_extension("jbv.tmp");
        std::fs::write(&tmp, serde_json::to_string(&file).unwrap_or_default()).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
    }

    /// The pre-vault plaintext passkey store (`passkeys.json`, or `JB_PASSKEY_STORE`) moves in once.
    fn migrate_plaintext_passkeys(&mut self) {
        let old = std::env::var("JB_PASSKEY_STORE").map(PathBuf::from).unwrap_or_else(|_| self.dir.join("passkeys.json"));
        let Ok(text) = std::fs::read_to_string(&old) else { return };
        let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&text) else { return };
        let mut n = 0;
        for mut it in items {
            if it.get("key").is_none() {
                continue;
            }
            it["source"] = json!("passkeys.json");
            if self.put_passkey(it) {
                n += 1;
            }
        }
        if self.save().is_ok() {
            let _ = std::fs::remove_file(&old);
            audit("migrate", "", "", "", true, &format!("{n} passkeys moved from {} into the encrypted vault", old.display()));
        }
    }

    // ---- logins

    pub fn logins(&self) -> &[Login] {
        &self.data.logins
    }

    pub fn find(&self, id_or_name: &str) -> Option<&Login> {
        let q = id_or_name.to_lowercase();
        self.data.logins.iter().find(|l| l.id == id_or_name).or_else(|| {
            let hits: Vec<&Login> = self.data.logins.iter().filter(|l| l.id.starts_with(id_or_name) || l.title.to_lowercase() == q || l.username.to_lowercase() == q).collect();
            if hits.len() == 1 { Some(hits[0]) } else { None }
        })
    }

    /// Add a login (or update the password of the same site + username). Returns its id.
    pub fn add_login(&mut self, mut l: Login) -> String {
        let site = l.urls.first().map(|u| host_of(u)).unwrap_or_default();
        if let Some(old) = self.data.logins.iter_mut().find(|o| o.username == l.username && o.urls.first().map(|u| host_of(u)) == Some(site.clone())) {
            old.password = l.password;
            if l.totp.is_some() {
                old.totp = l.totp;
            }
            if l.notes.is_some() {
                old.notes = l.notes;
            }
            old.updated = now();
            return old.id.clone();
        }
        if l.id.is_empty() {
            l.id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        }
        if l.title.is_empty() {
            l.title = site;
        }
        l.created = now();
        l.updated = l.created.clone();
        let id = l.id.clone();
        self.data.logins.push(l);
        id
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.data.logins.len() + self.data.passkeys.len();
        self.data.logins.retain(|l| l.id != id);
        self.data.passkeys.retain(|p| p.get("credentialId").and_then(Value::as_str) != Some(id));
        before != self.data.logins.len() + self.data.passkeys.len()
    }

    /// Logins for a page host: same site (registrable domain) as one of the login's URLs.
    pub fn logins_for(&self, host: &str) -> Vec<&Login> {
        let site = base_domain(host);
        let mut v: Vec<&Login> = self.data.logins.iter().filter(|l| l.urls.iter().any(|u| base_domain(&host_of(u)) == site)).collect();
        // exact host first
        v.sort_by_key(|l| !l.urls.iter().any(|u| host_of(u) == host));
        v
    }

    // ---- passkeys

    pub fn passkeys(&self) -> &[Value] {
        &self.data.passkeys
    }

    pub fn set_passkeys(&mut self, list: Vec<Value>) {
        self.data.passkeys = list;
    }

    /// Add a passkey unless one with the same credential id exists. Returns whether it was added.
    pub fn put_passkey(&mut self, p: Value) -> bool {
        let id = p.get("credentialId").cloned();
        if id.is_none() || self.data.passkeys.iter().any(|q| q.get("credentialId") == id.as_ref()) {
            return false;
        }
        self.data.passkeys.push(p);
        true
    }

    // ---- site policy

    pub fn allowed_sites(&self) -> &[String] {
        &self.data.allowed_sites
    }

    pub fn allow(&mut self, site: &str) -> bool {
        let s = normalize_site(site);
        if s.is_empty() || self.data.allowed_sites.contains(&s) {
            return false;
        }
        self.data.allowed_sites.push(s);
        true
    }

    pub fn deny(&mut self, site: &str) -> bool {
        let s = normalize_site(site);
        let before = self.data.allowed_sites.len();
        self.data.allowed_sites.retain(|a| *a != s);
        before != self.data.allowed_sites.len()
    }

    pub fn security_key_sites(&self) -> &[String] {
        &self.data.security_key_sites
    }

    /// Route a site's WebAuthn to the security key (`on`) or back to vault passkeys.
    pub fn set_security_key(&mut self, site: &str, on: bool) -> bool {
        let s = normalize_site(site);
        let had = self.data.security_key_sites.contains(&s);
        if on && !had && !s.is_empty() {
            self.data.security_key_sites.push(s);
            return true;
        }
        if !on && had {
            self.data.security_key_sites.retain(|x| *x != s);
            return true;
        }
        false
    }

    /// May the agent use credentials on this host right now? `Err` explains why not.
    pub fn check_site(&self, host: &str) -> Result<(), String> {
        if !self.data.allowed_sites.iter().any(|p| site_matches(p, host)) {
            return Err(format!("{host} is not an allowed site for the vault (allow it with `julia-browser vault allow {}`)", base_domain(host)));
        }
        if let Some(scope) = SCOPE.read().ok().and_then(|g| g.clone()) {
            if !scope.iter().any(|p| site_matches(p, host)) {
                return Err(format!("{host} is outside this task's vault scope ({})", scope.join(", ")));
            }
        }
        Ok(())
    }
}

/// Does WebAuthn on this host go to a FIDO security key / platform authenticator?
pub fn uses_security_key(host: &str) -> bool {
    if std::env::var("JB_FIDO").map(|v| v.eq_ignore_ascii_case("hardware")).unwrap_or(false) {
        return true;
    }
    Vault::open().map(|v| v.data.security_key_sites.iter().any(|p| site_matches(p, host))).unwrap_or(false)
}

/// Serialize vault writers in this process.
pub fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Narrow the sites this process's agent may use (`None` lifts the narrowing).
pub fn set_scope(sites: Option<Vec<String>>) {
    if let Ok(mut g) = SCOPE.write() {
        *g = sites.map(|v| v.iter().map(|s| normalize_site(s)).filter(|s| !s.is_empty()).collect());
    }
}

pub fn scope() -> Option<Vec<String>> {
    SCOPE.read().ok().and_then(|g| g.clone())
}

// ---- sites

pub fn host_of(url_or_host: &str) -> String {
    let s = url_or_host.trim();
    let parsed = url::Url::parse(s).ok().or_else(|| url::Url::parse(&format!("https://{s}")).ok());
    parsed.and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_ascii_lowercase())).unwrap_or_default()
}

fn normalize_site(s: &str) -> String {
    if s.trim() == "*" {
        return "*".into();
    }
    host_of(s)
}

fn site_matches(pattern: &str, host: &str) -> bool {
    let host = host.trim_start_matches("www.");
    pattern == "*" || host == pattern || host.ends_with(&format!(".{pattern}"))
}

/// Registrable domain, approximately: the last two labels, or three under a two-letter
/// country code with a generic second level ("example.co.uk").
pub fn base_domain(host: &str) -> String {
    let host = host.trim_start_matches("www.");
    if host.parse::<std::net::IpAddr>().is_ok() {
        return host.to_string();
    }
    let labels: Vec<&str> = host.split('.').collect();
    let n = labels.len();
    if n <= 2 {
        return host.to_string();
    }
    let generic = matches!(labels[n - 2], "co" | "com" | "net" | "org" | "gov" | "ac" | "edu" | "or" | "ne" | "go");
    let k = if labels[n - 1].len() == 2 && generic { 3 } else { 2 };
    labels[n - k..].join(".")
}

// ---- audit log

fn audit_path() -> PathBuf {
    dir().join("vault-audit.jsonl")
}

/// Append one access record (never a secret).
pub fn audit(action: &str, site: &str, account: &str, reason: &str, allowed: bool, detail: &str) {
    use std::io::Write;
    let line = json!({"time": now(), "action": action, "site": site, "account": account, "reason": reason, "allowed": allowed, "detail": detail});
    let _ = std::fs::create_dir_all(dir());
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(audit_path()) {
        let _ = writeln!(f, "{line}");
    }
}

pub fn read_audit(last: usize) -> Vec<Value> {
    let text = std::fs::read_to_string(audit_path()).unwrap_or_default();
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(last)..].iter().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

// ---- secrets for the page (session commands)

/// What to type for a `login` / `otp` / `new_password` request on `host`, after the policy check
/// (which is audited either way). Returns the values for the page script and the account name.
pub fn secrets_for(kind: &str, host: &str, account: Option<&str>, username: Option<&str>, reason: &str) -> Result<(Value, String), String> {
    let action = match kind {
        "otp" => "otp",
        "new" => "new_password",
        _ => "login",
    };
    let _g = lock();
    let mut v = Vault::open()?;
    if kind == "new" {
        // A new account: generate and store a password; the site becomes allowed for this login.
        let user = username.map(str::trim).filter(|u| !u.is_empty()).ok_or("new_password needs the account's username or email")?;
        if let Some(scope) = scope() {
            if !scope.iter().any(|p| site_matches(p, host)) {
                audit(action, host, user, reason, false, "outside the task scope");
                return Err(format!("{host} is outside this task's vault scope ({})", scope.join(", ")));
            }
        }
        let password = generate_password(20);
        v.add_login(Login { urls: vec![format!("https://{host}")], username: user.to_string(), password: password.clone(), source: "generated".into(), ..Default::default() });
        v.allow(&base_domain(host));
        v.save()?;
        audit(action, host, user, reason, true, "generated and saved a new password");
        return Ok((json!({"password": password, "username": user}), user.to_string()));
    }
    if let Err(e) = v.check_site(host) {
        audit(action, host, account.unwrap_or(""), reason, false, &e);
        return Err(e);
    }
    let candidates = v.logins_for(host);
    let login = match account {
        Some(a) if !a.is_empty() => candidates.iter().find(|l| l.username.eq_ignore_ascii_case(a) || l.id == a || l.title.eq_ignore_ascii_case(a)).copied(),
        _ => candidates.first().copied(),
    };
    let Some(login) = login else {
        let e = if candidates.is_empty() {
            format!("the vault has no login for {host}")
        } else {
            format!("no vault login for {host} matches {:?} (accounts: {})", account.unwrap_or(""), candidates.iter().map(|l| l.username.as_str()).collect::<Vec<_>>().join(", "))
        };
        audit(action, host, account.unwrap_or(""), reason, false, &e);
        return Err(e);
    };
    if kind == "otp" {
        let Some(secret) = login.totp.as_deref() else {
            audit(action, host, &login.username, reason, false, "no TOTP secret");
            return Err(format!("the vault login {} on {host} has no one-time code secret", login.username));
        };
        let code = totp_now(secret)?;
        audit(action, host, &login.username, reason, true, &format!("item {}", login.id));
        return Ok((json!({"otp": code}), login.username.clone()));
    }
    audit(action, host, &login.username, reason, true, &format!("item {}", login.id));
    Ok((json!({"username": login.username, "password": login.password}), login.username.clone()))
}

pub fn generate_password(len: usize) -> String {
    const SETS: [&[u8]; 4] = [b"abcdefghijkmnopqrstuvwxyz", b"ABCDEFGHJKLMNPQRSTUVWXYZ", b"23456789", b"!#$%&*+-=?@_"];
    let all: Vec<u8> = SETS.concat();
    let pick = |set: &[u8]| -> u8 {
        // rejection sampling: no modulo bias
        loop {
            let b: [u8; 1] = random();
            let lim = 256 - (256 % set.len());
            if (b[0] as usize) < lim {
                return set[b[0] as usize % set.len()];
            }
        }
    };
    let mut out: Vec<u8> = SETS.iter().map(|s| pick(s)).collect();
    while out.len() < len.max(12) {
        out.push(pick(&all));
    }
    // shuffle (Fisher-Yates)
    for i in (1..out.len()).rev() {
        let r: [u8; 4] = random();
        let j = (u32::from_le_bytes(r) as usize) % (i + 1);
        out.swap(i, j);
    }
    String::from_utf8(out).unwrap_or_default()
}

// ---- TOTP (RFC 6238)

fn base32_decode(s: &str) -> Option<Vec<u8>> {
    let mut bits = 0u32;
    let mut n = 0;
    let mut out = Vec::new();
    for c in s.chars().filter(|c| !c.is_whitespace() && *c != '=' && *c != '-') {
        let v = match c.to_ascii_uppercase() {
            c @ 'A'..='Z' => c as u32 - 'A' as u32,
            c @ '2'..='7' => c as u32 - '2' as u32 + 26,
            _ => return None,
        };
        bits = (bits << 5) | v;
        n += 5;
        if n >= 8 {
            out.push((bits >> (n - 8)) as u8);
            n -= 8;
        }
    }
    Some(out)
}

pub fn totp_at(secret: &str, unix: u64) -> Result<String, String> {
    use hmac::{Hmac, Mac};
    let (mut key_s, mut digits, mut period, mut algo) = (secret.trim().to_string(), 6u32, 30u64, "SHA1".to_string());
    if let Ok(u) = url::Url::parse(secret.trim()) {
        if u.scheme() == "otpauth" {
            for (k, v) in u.query_pairs() {
                match k.as_ref() {
                    "secret" => key_s = v.to_string(),
                    "digits" => digits = v.parse().unwrap_or(6),
                    "period" => period = v.parse().unwrap_or(30),
                    "algorithm" => algo = v.to_uppercase(),
                    _ => {}
                }
            }
        }
    }
    let key = base32_decode(&key_s).filter(|k| !k.is_empty()).ok_or("the one-time code secret is not valid base32")?;
    let counter = (unix / period.max(1)).to_be_bytes();
    let mac = match algo.as_str() {
        "SHA256" => <Hmac<sha2::Sha256> as Mac>::new_from_slice(&key).map(|mut m| { m.update(&counter); m.finalize().into_bytes().to_vec() }),
        "SHA512" => <Hmac<sha2::Sha512> as Mac>::new_from_slice(&key).map(|mut m| { m.update(&counter); m.finalize().into_bytes().to_vec() }),
        _ => <Hmac<sha1::Sha1> as Mac>::new_from_slice(&key).map(|mut m| { m.update(&counter); m.finalize().into_bytes().to_vec() }),
    }
    .map_err(|e| e.to_string())?;
    let off = (mac[mac.len() - 1] & 0x0f) as usize;
    let bin = ((mac[off] as u32 & 0x7f) << 24) | ((mac[off + 1] as u32) << 16) | ((mac[off + 2] as u32) << 8) | mac[off + 3] as u32;
    let digits = digits.clamp(6, 10);
    Ok(format!("{:0width$}", bin as u64 % 10u64.pow(digits), width = digits as usize))
}

pub fn totp_now(secret: &str) -> Result<String, String> {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    totp_at(secret, t)
}

// ---- import

#[derive(Default, Debug)]
pub struct ImportReport {
    pub format: String,
    pub logins: usize,
    pub passkeys: usize,
    pub skipped: usize,
    pub notes: Vec<String>,
}

/// RFC 4180 CSV (quoted fields, doubled quotes, newlines inside quotes).
fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    field.push('"');
                    chars.next();
                }
                '"' => quoted = false,
                c => field.push(c),
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => quoted = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                if row.iter().any(|f| !f.is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            c => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// Password-manager CSV exports: Chrome / Edge / Brave, Firefox, Safari / Apple Passwords,
/// Bitwarden, 1Password, LastPass, Dashlane, Proton Pass, KeePassXC, NordPass, Keeper (headered).
fn import_csv(v: &mut Vault, text: &str, source: &str, rep: &mut ImportReport) {
    let rows = parse_csv(text);
    let Some(header) = rows.first() else { return };
    let h: Vec<String> = header.iter().map(|s| s.trim().to_lowercase().replace([' ', '-'], "_")).collect();
    let col = |names: &[&str]| names.iter().find_map(|n| h.iter().position(|c| c == n));
    let c_url = col(&["url", "login_uri", "website", "web_site", "urls", "origin_url", "uri"]);
    let c_user = col(&["username", "login_username", "login", "user_name", "email", "username1", "login_name"]);
    let c_pass = col(&["password", "login_password"]);
    let c_title = col(&["title", "name", "item_name"]);
    let c_totp = col(&["otpauth", "totp", "login_totp", "otp", "otpsecret", "otp_secret", "otpurl", "otp_url", "one_time_password"]);
    let c_notes = col(&["notes", "note", "extra", "comments"]);
    let c_type = col(&["type"]);
    if c_pass.is_none() || (c_url.is_none() && c_title.is_none()) {
        rep.notes.push(format!("unrecognized CSV header: {}", header.join(",")));
        return;
    }
    let get = |r: &Vec<String>, c: Option<usize>| c.and_then(|i| r.get(i)).map(|s| s.trim().to_string()).unwrap_or_default();
    for r in rows.iter().skip(1) {
        if let Some(t) = c_type.map(|_| get(r, c_type)) {
            if !t.is_empty() && t != "login" && source.starts_with("bitwarden") {
                rep.skipped += 1;
                continue;
            }
        }
        let password = get(r, c_pass);
        let mut url = get(r, c_url);
        // LastPass secure notes have url "http://sn"; 1Password may list several URLs
        if url == "http://sn" {
            rep.skipped += 1;
            continue;
        }
        if let Some(first) = url.split([',', '\n', ' ']).find(|s| !s.is_empty()) {
            url = first.to_string();
        }
        if password.is_empty() || host_of(&url).is_empty() {
            rep.skipped += 1;
            continue;
        }
        let totp = Some(get(r, c_totp)).filter(|s| !s.is_empty());
        let notes = Some(get(r, c_notes)).filter(|s| !s.is_empty());
        v.add_login(Login { title: get(r, c_title), urls: vec![url], username: get(r, c_user), password, totp, notes, source: source.into(), ..Default::default() });
        rep.logins += 1;
    }
}

fn pkcs8_to_cose_b64(der: &[u8]) -> Option<String> {
    use passkey::crypto::coset::CborSerializable;
    use passkey::crypto::rust_crypto::RustCryptoSecretKey;
    use passkey::crypto::{Pkcs8, SecretKeyT};
    let sk = RustCryptoSecretKey::from_pkcs8(der).ok()?;
    Some(b64(&sk.to_cose_key().to_vec().ok()?))
}

fn cose_b64_to_pkcs8(key: &str) -> Option<Vec<u8>> {
    use passkey::crypto::coset::{CborSerializable, CoseKey};
    use passkey::crypto::rust_crypto::RustCryptoSecretKey;
    use passkey::crypto::{Pkcs8, SecretKeyT};
    let cose = CoseKey::from_slice(&unb64(key)?).ok()?;
    RustCryptoSecretKey::from_cose_key(&cose).ok()?.to_pkcs8().ok()
}

fn passkey_value(cred_id: &[u8], rp_id: &str, user_handle: Option<Vec<u8>>, user: &str, display: &str, pkcs8: &[u8], counter: u64, source: &str) -> Option<Value> {
    Some(json!({
        "credentialId": b64(cred_id),
        "rpId": rp_id,
        "userHandle": user_handle.map(|h| b64(&h)),
        "userName": user,
        "userDisplayName": display,
        "counter": counter,
        "key": pkcs8_to_cose_b64(pkcs8)?,
        "source": source,
        "created": now(),
    }))
}

/// Bitwarden's unencrypted JSON export: logins, TOTP and passkeys (`login.fido2Credentials`).
fn import_bitwarden_json(v: &mut Vault, doc: &Value, rep: &mut ImportReport) {
    if doc.get("encrypted").and_then(Value::as_bool) == Some(true) {
        rep.notes.push("this Bitwarden export is encrypted; export it as unencrypted JSON".into());
        return;
    }
    for item in doc.get("items").and_then(Value::as_array).into_iter().flatten() {
        let Some(login) = item.get("login") else {
            rep.skipped += 1;
            continue;
        };
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let urls: Vec<String> = login.get("uris").and_then(Value::as_array).into_iter().flatten().filter_map(|u| u.get("uri").and_then(Value::as_str)).filter(|u| !host_of(u).is_empty()).map(str::to_string).collect();
        let password = s(login, "password");
        if !password.is_empty() && !urls.is_empty() {
            v.add_login(Login {
                title: s(item, "name"),
                urls: urls.clone(),
                username: s(login, "username"),
                password,
                totp: Some(s(login, "totp")).filter(|t| !t.is_empty()),
                notes: Some(s(item, "notes")).filter(|t| !t.is_empty()),
                source: "bitwarden-json".into(),
                ..Default::default()
            });
            rep.logins += 1;
        }
        for f in login.get("fido2Credentials").and_then(Value::as_array).into_iter().flatten() {
            if s(f, "keyAlgorithm") != "ECDSA" || s(f, "keyCurve") != "P-256" {
                rep.notes.push(format!("skipped a {} {} passkey for {}", s(f, "keyAlgorithm"), s(f, "keyCurve"), s(f, "rpId")));
                rep.skipped += 1;
                continue;
            }
            let id = s(f, "credentialId");
            let cred_id = match id.strip_prefix("b64.") {
                Some(rest) => unb64(rest),
                None => uuid::Uuid::parse_str(&id).ok().map(|u| u.as_bytes().to_vec()),
            };
            let (Some(cred_id), Some(der)) = (cred_id, unb64(&s(f, "keyValue"))) else {
                rep.skipped += 1;
                continue;
            };
            let counter = f.get("counter").and_then(|c| c.as_u64().or_else(|| c.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0);
            match passkey_value(&cred_id, &s(f, "rpId"), unb64(&s(f, "userHandle")), &s(f, "userName"), &s(f, "userDisplayName"), &der, counter, "bitwarden-json") {
                Some(p) if v.put_passkey(p.clone()) => rep.passkeys += 1,
                _ => rep.skipped += 1,
            }
        }
    }
}

/// FIDO Credential Exchange Format (CXF) JSON: `basic-auth`, `totp` and `passkey` credentials.
fn import_cxf(v: &mut Vault, doc: &Value, rep: &mut ImportReport) {
    let field = |c: &Value, k: &str| -> String {
        match c.get(k) {
            Some(Value::String(s)) => s.clone(),
            Some(o) => o.get("value").and_then(Value::as_str).unwrap_or("").to_string(),
            None => String::new(),
        }
    };
    for acct in doc.get("accounts").and_then(Value::as_array).into_iter().flatten() {
        for item in acct.get("items").and_then(Value::as_array).into_iter().flatten() {
            let title = item.get("title").and_then(Value::as_str).unwrap_or("").to_string();
            let urls: Vec<String> = item.pointer("/scope/urls").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
            let creds = item.get("credentials").and_then(Value::as_array).cloned().unwrap_or_default();
            let totp = creds.iter().find(|c| c.get("type").and_then(Value::as_str) == Some("totp")).map(|c| {
                let secret = field(c, "secret");
                let digits = c.get("digits").and_then(Value::as_u64).unwrap_or(6);
                let period = c.get("period").and_then(Value::as_u64).unwrap_or(30);
                let algo = field(c, "algorithm").to_uppercase();
                format!("otpauth://totp/x?secret={secret}&digits={digits}&period={period}&algorithm={}", if algo.is_empty() { "SHA1".into() } else { algo })
            });
            for c in &creds {
                match c.get("type").and_then(Value::as_str) {
                    Some("basic-auth") => {
                        let password = field(c, "password");
                        let url = urls.first().cloned().unwrap_or_default();
                        if password.is_empty() || host_of(&url).is_empty() {
                            rep.skipped += 1;
                            continue;
                        }
                        v.add_login(Login { title: title.clone(), urls: urls.clone(), username: field(c, "username"), password, totp: totp.clone(), source: "cxf".into(), ..Default::default() });
                        rep.logins += 1;
                    }
                    Some("passkey") => {
                        let (Some(id), Some(der)) = (unb64(&field(c, "credentialId")), unb64(&field(c, "key"))) else {
                            rep.skipped += 1;
                            continue;
                        };
                        match passkey_value(&id, &field(c, "rpId"), unb64(&field(c, "userHandle")), &field(c, "username"), &field(c, "userDisplayName"), &der, 0, "cxf") {
                            Some(p) if v.put_passkey(p.clone()) => rep.passkeys += 1,
                            _ => {
                                rep.notes.push(format!("skipped a passkey for {} (unsupported key type or duplicate)", field(c, "rpId")));
                                rep.skipped += 1;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Import a password-manager export file. `format` "auto" picks by content.
pub fn import_file(path: &Path, format: &str) -> Result<ImportReport, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let _g = lock();
    let mut v = Vault::open()?;
    let mut rep = ImportReport::default();
    let json_doc = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).ok();
    let fmt = match (format, &json_doc) {
        ("auto", Some(d)) if d.get("accounts").is_some() => "cxf",
        ("auto", Some(d)) if d.get("items").is_some() => "bitwarden-json",
        ("auto", Some(_)) => return Err("unrecognized JSON export (supported: Bitwarden JSON, FIDO CXF)".into()),
        ("auto", None) => "csv",
        (f, _) => f,
    };
    rep.format = fmt.to_string();
    match (fmt, &json_doc) {
        ("cxf", Some(d)) => import_cxf(&mut v, d, &mut rep),
        ("bitwarden-json", Some(d)) => import_bitwarden_json(&mut v, d, &mut rep),
        ("cxf" | "bitwarden-json", None) => return Err(format!("{} is not JSON", path.display())),
        (f, _) => import_csv(&mut v, &text, if f == "csv" { "csv" } else { f }, &mut rep),
    }
    v.save()?;
    audit("import", "", "", "", true, &format!("{} from {}: {} logins, {} passkeys, {} skipped", rep.format, path.display(), rep.logins, rep.passkeys, rep.skipped));
    Ok(rep)
}

// ---- export

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() }
}

/// Plaintext export: Chrome-compatible CSV (passwords only) or CXF JSON (passwords, one-time code
/// secrets and passkeys). The file is not encrypted.
pub fn export_file(path: &Path, format: &str) -> Result<(usize, usize), String> {
    let v = Vault::open()?;
    let out = if format == "csv" {
        let mut s = String::from("name,url,username,password,note\n");
        for l in v.logins() {
            s.push_str(&[csv_field(&l.title), csv_field(l.urls.first().map(String::as_str).unwrap_or("")), csv_field(&l.username), csv_field(&l.password), csv_field(l.notes.as_deref().unwrap_or(""))].join(","));
            s.push('\n');
        }
        s
    } else {
        let mut items: Vec<Value> = v
            .logins()
            .iter()
            .map(|l| {
                let mut creds = vec![json!({"type": "basic-auth", "username": {"fieldType": "string", "value": l.username}, "password": {"fieldType": "concealed-string", "value": l.password}})];
                if let Some(t) = &l.totp {
                    let secret = url::Url::parse(t).ok().and_then(|u| u.query_pairs().find(|(k, _)| k == "secret").map(|(_, v)| v.to_string())).unwrap_or_else(|| t.clone());
                    creds.push(json!({"type": "totp", "secret": secret, "period": 30, "digits": 6, "algorithm": "sha1"}));
                }
                json!({"id": b64(l.id.as_bytes()), "title": l.title, "scope": {"urls": l.urls}, "credentials": creds})
            })
            .collect();
        for p in v.passkeys() {
            let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let Some(der) = cose_b64_to_pkcs8(&s("key")) else { continue };
            items.push(json!({"id": s("credentialId"), "title": s("rpId"), "scope": {"urls": [format!("https://{}", s("rpId"))]}, "credentials": [{
                "type": "passkey", "credentialId": s("credentialId"), "rpId": s("rpId"), "username": s("userName"),
                "userDisplayName": s("userDisplayName"), "userHandle": s("userHandle"), "key": b64(&der)
            }]}));
        }
        serde_json::to_string_pretty(&json!({"version": {"major": 1, "minor": 0}, "exporterRpId": "julia-browser.local", "exporterDisplayName": "julia-browser", "timestamp": chrono::Utc::now().timestamp(), "accounts": [{"id": b64(b"julia"), "username": "", "email": "", "items": items}]})).unwrap_or_default()
    };
    std::fs::write(path, out).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    audit("export", "", "", "", true, &format!("{format} to {}: {} logins, {} passkeys", path.display(), v.logins().len(), v.passkeys().len()));
    Ok((v.logins().len(), v.passkeys().len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totp_rfc6238_vectors() {
        // RFC 6238 appendix B, SHA-1 secret "12345678901234567890" (base32 below), 8 digits
        let s = "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8";
        assert_eq!(totp_at(s, 59).unwrap(), "94287082");
        assert_eq!(totp_at(s, 1111111109).unwrap(), "07081804");
        assert_eq!(totp_at(s, 20000000000).unwrap(), "65353130");
    }

    #[test]
    fn csv_and_sites() {
        let rows = parse_csv("name,url\n\"a, \"\"b\"\"\",https://x.com\n");
        assert_eq!(rows[1][0], "a, \"b\"");
        assert_eq!(base_domain("accounts.google.co.uk"), "google.co.uk");
        assert_eq!(base_domain("login.github.com"), "github.com");
        assert!(site_matches("github.com", "gist.github.com"));
        assert!(!site_matches("github.com", "evilgithub.com"));
        let p = generate_password(20);
        assert_eq!(p.len(), 20);
    }

    #[test]
    fn passkey_pkcs8_roundtrip() {
        use passkey::crypto::coset::CborSerializable;
        use passkey::crypto::rust_crypto::RustCryptoSecretKey;
        use passkey::crypto::{Pkcs8, SecretKeyT};
        let sk = p256::SecretKey::random(&mut rand_core::OsRng);
        let der = p256::pkcs8::EncodePrivateKey::to_pkcs8_der(&sk).unwrap();
        let cose = pkcs8_to_cose_b64(der.as_bytes()).unwrap();
        let back = cose_b64_to_pkcs8(&cose).unwrap();
        let a = RustCryptoSecretKey::from_pkcs8(&back).unwrap().to_cose_key().to_vec().unwrap();
        assert_eq!(b64(&a), cose);
    }
}
