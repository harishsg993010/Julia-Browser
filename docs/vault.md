# Password and passkey vault

The vault stores the agent's credentials in one encrypted file, `<local data>/julia-browser/vault.jbv`.
`JB_VAULT_DIR` changes the directory.

## Encryption

- The contents are sealed with AES-256-GCM under a random vault key.
- On Windows, DPAPI protects the vault key, which binds it to your Windows account.
- If `JB_VAULT_PASSPHRASE` is set when the vault is created, a passphrase protects the key instead
  (PBKDF2-SHA256, 600,000 rounds). The variable is then needed every time the vault is opened.
- On other systems without a passphrase, an owner-only key file protects the key.

## Managing the vault

```bash
julia-browser vault import passwords.csv     # CSV from Chrome/Edge/Firefox/Apple Passwords/1Password/Bitwarden/LastPass/Dashlane
julia-browser vault import bitwarden.json    # Bitwarden JSON or FIDO CXF JSON: passwords, TOTP and passkeys
julia-browser vault add github.com me@example.com [--password .. | --generate] [--totp SECRET] [--allow]
julia-browser vault allow github.com         # the agent may use credentials only on allowed sites ("*" = all)
julia-browser vault list | show <id> [--reveal] | remove <id> | sites | deny <site> | status
julia-browser vault log                      # audit log: what was used, where, when and why (denials too)
julia-browser vault totp <id>                # current one-time code
julia-browser vault generate                 # a strong password
julia-browser vault export out.json --yes    # CXF JSON with passkeys (or --format csv), unencrypted
```

## Using it from an agent

```bash
julia-browser login --reason "check order status"            # username + password for the page's site
julia-browser otp --reason "2FA prompt after login"          # current TOTP code
julia-browser new-password me@example.com --reason "sign up" # generate, save, fill (the site becomes allowed)
julia-browser vault scope shop.example.com                   # limit this session to one task's sites
```

From Python: `Browser.login / otp / new_password / vault_scope` and the `julia_browser.Vault` class.
The [web agent](web-agent.md) gets `login` and `otp` tools with `--allow-login`.

How it decides and what it reports:

- `login` finds the sign-in fields on the page or in its frames. It uses the login for that frame's
  own origin, so an embedded frame from another site never gets the top page's password. It works
  over https and on localhost.
- A command result names only the filled fields and the account, never the secret.
- In element descriptions and form listings, password fields and vault-filled fields show as `••••••••`.
- Every use is written to `vault-audit.jsonl`, allowed or denied. Audit records never contain a secret.

Pages can read what is filled into their own fields, as in any browser. Give agents that use the
vault the action tools, not a raw `eval` tool.

## Passkeys and FIDO2

- WebAuthn on pages (`navigator.credentials.create/get`) goes through a software CTAP2
  authenticator (1Password's passkey-rs). Its passkeys live in the vault. Signing in needs an
  allowed site; registering a passkey allows its site.
- Keys: ES256 and Ed25519. Extensions: `prf` (hmac-secret), with per-credential secrets kept in the vault.
- The WebAuthn signal API is handled:
  - `signalUnknownCredential` and `signalAllAcceptedCredentials` hide passkeys the site no longer accepts.
  - `signalCurrentUserDetails` renames the account.
- `getClientCapabilities()` reports what is supported.
- Physical security keys and Windows Hello, per site:
  - `julia-browser vault security-key github.com` (`--off` to undo), or `JB_FIDO=hardware` for every site.
  - That site's WebAuthn then goes through Windows' webauthn.dll to USB, NFC or BLE keys, including U2F keys.
  - The page must be served over https.
