# Web APIs

Page scripts run in SpiderMonkey against a real in-memory DOM. Each page load starts a fresh
JavaScript realm. The realm stays live afterwards, so clicks, typing and form submissions dispatch
real events to the page's handlers.

## Scripts

- Classic and ES module scripts: static and dynamic `import()`, `import.meta`, JSON modules, import maps
- `async` / `defer` ordering, script-inserted scripts, `document.write`
- Subresource integrity
- Content Security Policy, Trusted Types, referrer policy, mixed content
- `window.onerror` with the real exception, `unhandledrejection`
- Iframes and popups get their own realms, with cross-origin `WindowProxy` and `Location` objects
- Workers, shared workers, service workers (fetch interception, Cache API) and worklets

## Natively backed APIs

| API | Backend |
| --- | --- |
| `fetch`, `Request`/`Response`, `XMLHttpRequest` | The browser's HTTP session: cookies, proxy rules, CORS, fetch metadata headers per redirect hop |
| `WebSocket`, `EventSource` | Real connections (tungstenite, TLS), streaming server-sent events |
| `document.cookie`, `cookieStore` | The session's cookie jar (HttpOnly hidden) |
| `localStorage` / `sessionStorage`, `indexedDB` | Persisted per origin under `<local data>/julia-browser/` (or `profile_dir`) |
| `crypto.subtle` | RustCrypto: digests, HMAC, AES-CBC/CTR/GCM/KW, RSA PKCS1/PSS/OAEP, ECDSA/ECDH P-256/384/521, Ed25519/X25519, HKDF, PBKDF2 |
| `CompressionStream` / `DecompressionStream` | gzip, deflate, deflate-raw (flate2) |
| `TextEncoder` / `TextDecoder`, `URL` | All Encoding Standard encodings (encoding_rs); WHATWG URL parsing |
| `element.style`, `getComputedStyle`, `CSS.supports` | Stylo, the same engine as layout |
| Canvas 2D, `OffscreenCanvas`, `ImageBitmap` | vello_cpu (feature `canvas`) |
| Images | Decoded with the `image` crate and an AVIF decoder (feature `images`) |
| `navigator.clipboard`, copy / cut / paste | In-page clipboard; the OS clipboard with `--allow-clipboard` |
| `navigator.credentials`, WebAuthn | The [vault](vault.md)'s passkeys (passkey-rs), or a hardware key / Windows Hello per site |
| `navigator.permissions`, `Notification`, `navigator.geolocation` | States from flags (`--notifications`, `--geolocation`) or WebDriver |
| Text fragments (`#:~:text=`) | Matched against the rendered text and scrolled into view |

## In-environment implementations

- DOM: events, ranges, `Selection`, `MutationObserver`, `NodeIterator` / `TreeWalker`
- Components: custom elements, shadow DOM, slots, declarative shadow DOM
- Forms and dialogs: constraint validation, form submission, popover and `<dialog>`, close watchers, focus model
- Editing: `execCommand` and `beforeinput` target ranges
- History: `history`, the Navigation API, `location`
- Animation: Web Animations, CSS animations and transitions, scroll-driven animations
- CSSOM: style sheets, CSS Typed OM, `@property`, Highlight API
- `IntersectionObserver`, `ResizeObserver`
- Performance APIs: user timing, resource timing, paint timing, `PerformanceObserver`
- Streams (web-streams-polyfill), `Blob` / `File` / `FileReader`, `structuredClone`, `MessageChannel`, `BroadcastChannel`
- SVG DOM, MathML DOM, XPath, XSLT, the Sanitizer API, Web Locks, the scheduler API, StorageManager

## Reports

Everything a page does through these APIs is reported back:

- `JsExecution` (and `open_website()` in the agent SDK) lists network calls, WebSocket messages,
  notifications, cookies set, canvas text, navigations and form submissions.
- The interactive `console` command shows the same.
