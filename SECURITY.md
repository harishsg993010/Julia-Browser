# Security

## Reporting a vulnerability

Please report security issues privately by email to harishsg99@gmail.com rather than in a public
issue. Include the affected version or build, steps to reproduce, and the impact. You will get an
answer within a week.

Areas that matter most:

- **The vault** (`src/vault.rs`, `src/js/passkeys.rs`): encryption, key protection, the allowlist,
  and any way for page content or an agent to obtain a stored secret.
- **Origin isolation**: cross-origin frames, `postMessage`, cookies, CSP and CORS enforcement.
- **The CDP server and session daemon**: they listen on localhost, and session commands carry a
  per-session token.
- **Memory safety** at the SpiderMonkey boundary (`src/js/runtime.rs`, `src/js/host.rs`).

## Design notes

- Vault secrets are typed into the page inside the browser. They are never returned by commands or
  shown in element descriptions, and every use is written to an audit log.
- Credentials are only used on sites the user allowed, and only for the frame's own origin.
- `login` works over https and on localhost.
- The CDP server binds to 127.0.0.1 unless `--host` says otherwise.
