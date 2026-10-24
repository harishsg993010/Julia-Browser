//! Native backends for Web APIs exposed to page JavaScript: real WebSocket and
//! EventSource connections, WebCrypto primitives, Compression Streams, the OS
//! clipboard and IndexedDB persistence.

use crate::http::HttpClient;
use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::TcpStream;
use std::sync::mpsc::{channel, Receiver, TryRecvError};
use std::time::Duration;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

/// Open a WebSocket connection and run the opening handshake by hand, so the upgrade request
/// looks like a browser's: Title-Case header names in Chrome's order and the page client's TLS
/// configuration (`http::websocket_tls_config`). tungstenite's own handshake wrote extra header
/// names in lower case (`user-agent`, `cookie`) and its TLS offered no ALPN; Cloudflare answered
/// such upgrades with 403 (cars.com LiveView) while curl and Chrome connected. Test hosts pinned
/// by `JB_RESOLVE_HOSTS` connect to 127.0.0.1; `JB_INSECURE_TLS` accepts the test CA.
fn connect_websocket(url: &str, protocols: &[String], user_agent: &str, origin: &str, cookie: &str) -> Result<(WebSocket<MaybeTlsStream<TcpStream>>, String), String> {
    let u = url::Url::parse(url).map_err(|e| e.to_string())?;
    let secure = match u.scheme() {
        "wss" => true,
        "ws" => false,
        s => return Err(format!("unsupported URL scheme {s}")),
    };
    let host_header_name = u.host_str().ok_or_else(|| "URL has no host".to_string())?.to_string();
    let host = host_header_name.trim_start_matches('[').trim_end_matches(']').to_string();
    let port = u.port().unwrap_or(if secure { 443 } else { 80 });
    for v in [user_agent, origin, cookie].iter().copied().chain(protocols.iter().map(String::as_str)) {
        if v.contains('\r') || v.contains('\n') {
            return Err("invalid header value".to_string());
        }
    }

    let pinned = std::env::var("JB_RESOLVE_HOSTS").map(|h| h.split(',').any(|p| p.trim().eq_ignore_ascii_case(&host))).unwrap_or(false);
    let tcp = if pinned { TcpStream::connect(("127.0.0.1", port)) } else { TcpStream::connect((host.as_str(), port)) }.map_err(|e| e.to_string())?;
    // The handshake must not block the page forever; the socket goes non-blocking afterwards.
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(20)));
    let _ = tcp.set_write_timeout(Some(Duration::from_secs(20)));
    let _ = tcp.set_nodelay(true);
    let mut stream = if secure {
        let config = crate::http::websocket_tls_config(std::env::var_os("JB_INSECURE_TLS").is_some())?;
        let name = rustls::pki_types::ServerName::try_from(host.clone()).map_err(|e| e.to_string())?;
        let conn = rustls::ClientConnection::new(config, name).map_err(|e| e.to_string())?;
        MaybeTlsStream::Rustls(rustls::StreamOwned::new(conn, tcp))
    } else {
        MaybeTlsStream::Plain(tcp)
    };

    let path = match u.query() {
        Some(q) => format!("{}?{}", u.path(), q),
        None => u.path().to_string(),
    };
    let host_header = match u.port() {
        Some(p) => format!("{host_header_name}:{p}"),
        None => host_header_name.clone(),
    };
    let key = tungstenite::handshake::client::generate_key();
    // Header order and casing as Chrome sends them (no Sec-WebSocket-Extensions: tungstenite
    // cannot inflate permessage-deflate frames).
    let mut req = format!("GET {path} HTTP/1.1\r\nHost: {host_header}\r\nConnection: Upgrade\r\nPragma: no-cache\r\nCache-Control: no-cache\r\n");
    if !user_agent.is_empty() {
        req.push_str(&format!("User-Agent: {user_agent}\r\n"));
    }
    req.push_str("Upgrade: websocket\r\n");
    if !origin.is_empty() {
        req.push_str(&format!("Origin: {origin}\r\n"));
    }
    req.push_str("Sec-WebSocket-Version: 13\r\nAccept-Encoding: gzip, deflate, br, zstd\r\nAccept-Language: en-US,en;q=0.9\r\n");
    if !cookie.is_empty() {
        req.push_str(&format!("Cookie: {cookie}\r\n"));
    }
    req.push_str(&format!("Sec-WebSocket-Key: {key}\r\n"));
    if !protocols.is_empty() {
        req.push_str(&format!("Sec-WebSocket-Protocol: {}\r\n", protocols.join(", ")));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;

    // Read the response head; bytes after it already belong to the WebSocket stream.
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break p + 4;
        }
        if buf.len() > 64 * 1024 {
            return Err("WebSocket handshake response too large".to_string());
        }
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("connection closed during the WebSocket handshake".to_string());
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..end]).to_string();
    let rest = buf[end..].to_vec();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let mut parts = status_line.splitn(3, ' ');
    let _version = parts.next();
    let code: u16 = parts.next().and_then(|c| c.trim().parse().ok()).unwrap_or(0);
    let reason = parts.next().unwrap_or("").trim().to_string();
    if code != 101 {
        return Err(format!("HTTP error: {code} {reason}").trim_end().to_string());
    }
    let mut response_headers: Vec<(String, String)> = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            response_headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    let header = |name: &str| response_headers.iter().filter(|(k, _)| k == name).map(|(_, v)| v.as_str()).collect::<Vec<_>>().join(", ");
    if !header("upgrade").eq_ignore_ascii_case("websocket") {
        return Err("WebSocket handshake: missing Upgrade: websocket".to_string());
    }
    if !header("connection").split(',').any(|t| t.trim().eq_ignore_ascii_case("upgrade")) {
        return Err("WebSocket handshake: missing Connection: Upgrade".to_string());
    }
    if header("sec-websocket-accept") != tungstenite::handshake::derive_accept_key(key.as_bytes()) {
        return Err("WebSocket handshake: wrong Sec-WebSocket-Accept".to_string());
    }
    if !header("sec-websocket-extensions").is_empty() {
        return Err("WebSocket handshake: the server chose an extension that was not offered".to_string());
    }
    let protocol = header("sec-websocket-protocol");
    if !protocol.is_empty() && !protocols.iter().any(|p| *p == protocol) {
        return Err("WebSocket handshake: the server chose a subprotocol that was not offered".to_string());
    }
    let ws = WebSocket::from_partially_read(stream, rest, tungstenite::protocol::Role::Client, None);
    Ok((ws, protocol))
}

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

pub fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn unb64(s: &str) -> Vec<u8> {
    B64.decode(s.trim()).unwrap_or_default()
}

/// A network event delivered to the JS side on the next pump.
#[derive(Debug, Clone)]
pub struct NetEvent {
    pub target: &'static str, // "ws" | "es"
    pub id: u64,
    pub kind: String,
    pub data: Value,
}

impl NetEvent {
    pub fn to_json(&self) -> Value {
        json!({"target": self.target, "id": self.id, "type": self.kind, "data": self.data})
    }
}

// ---------------------------------------------------------------- WebSocket

struct Socket {
    ws: WebSocket<MaybeTlsStream<TcpStream>>,
    open: bool,
}

#[derive(Default)]
pub struct WebSocketManager {
    sockets: HashMap<u64, Socket>,
    pub connections_attempted: usize,
    pub messages_received: usize,
    pub messages_sent: usize,
}

impl WebSocketManager {
    pub fn open(&mut self, id: u64, url: &str, protocols: &[String], user_agent: &str, origin: &str, cookie: &str) -> Value {
        self.connections_attempted += 1;
        match connect_websocket(url, protocols, user_agent, origin, cookie) {
            Ok((ws, protocol)) => {
                // Non-blocking reads so the pump loop can poll without stalling.
                match ws.get_ref() {
                    MaybeTlsStream::Plain(s) => {
                        let _ = s.set_read_timeout(None);
                        let _ = s.set_nonblocking(true);
                    }
                    MaybeTlsStream::Rustls(s) => {
                        let _ = s.get_ref().set_read_timeout(None);
                        let _ = s.get_ref().set_nonblocking(true);
                    }
                    _ => {}
                }
                self.sockets.insert(id, Socket { ws, open: true });
                json!({"ok": true, "protocol": protocol})
            }
            Err(e) => json!({"ok": false, "error": e}),
        }
    }

    pub fn send(&mut self, id: u64, data: &str, binary: bool) -> Value {
        let sock = match self.sockets.get_mut(&id) {
            Some(s) if s.open => s,
            _ => return json!({"ok": false, "error": "socket not open"}),
        };
        let msg = if binary { Message::Binary(unb64(data).into()) } else { Message::Text(data.into()) };
        match sock.ws.send(msg) {
            Ok(_) => {
                self.messages_sent += 1;
                json!({"ok": true})
            }
            Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => {
                let _ = sock.ws.flush();
                self.messages_sent += 1;
                json!({"ok": true})
            }
            Err(e) => json!({"ok": false, "error": e.to_string()}),
        }
    }

    pub fn close(&mut self, id: u64, code: u16, reason: &str) -> Value {
        if let Some(mut sock) = self.sockets.remove(&id) {
            let frame = tungstenite::protocol::CloseFrame { code: code.into(), reason: reason.to_string().into() };
            let _ = sock.ws.close(Some(frame));
            let _ = sock.ws.flush();
            sock.open = false;
        }
        json!({"ok": true})
    }

    pub fn has_open(&self) -> bool {
        self.sockets.values().any(|s| s.open)
    }

    /// Poll every socket once for pending frames.
    pub fn poll(&mut self) -> Vec<NetEvent> {
        let mut events = Vec::new();
        let mut closed = Vec::new();
        for (id, sock) in self.sockets.iter_mut() {
            if !sock.open {
                continue;
            }
            for _ in 0..64 {
                match sock.ws.read() {
                    Ok(Message::Text(t)) => {
                        self.messages_received += 1;
                        events.push(NetEvent { target: "ws", id: *id, kind: "message".into(), data: json!({"text": t.as_str()}) });
                    }
                    Ok(Message::Binary(b)) => {
                        self.messages_received += 1;
                        events.push(NetEvent { target: "ws", id: *id, kind: "message".into(), data: json!({"binary": b64(&b)}) });
                    }
                    Ok(Message::Close(frame)) => {
                        let (code, reason) = frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1005, String::new()));
                        events.push(NetEvent { target: "ws", id: *id, kind: "close".into(), data: json!({"code": code, "reason": reason, "wasClean": true}) });
                        sock.open = false;
                        closed.push(*id);
                        break;
                    }
                    Ok(Message::Ping(p)) => {
                        let _ = sock.ws.send(Message::Pong(p));
                    }
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => break,
                    Err(tungstenite::Error::ConnectionClosed) | Err(tungstenite::Error::AlreadyClosed) => {
                        events.push(NetEvent { target: "ws", id: *id, kind: "close".into(), data: json!({"code": 1006, "reason": "", "wasClean": false}) });
                        sock.open = false;
                        closed.push(*id);
                        break;
                    }
                    Err(e) => {
                        events.push(NetEvent { target: "ws", id: *id, kind: "error".into(), data: json!({"message": e.to_string()}) });
                        events.push(NetEvent { target: "ws", id: *id, kind: "close".into(), data: json!({"code": 1006, "reason": e.to_string(), "wasClean": false}) });
                        sock.open = false;
                        closed.push(*id);
                        break;
                    }
                }
            }
        }
        for id in closed {
            self.sockets.remove(&id);
        }
        events
    }
}

// -------------------------------------------------------------- EventSource

struct Stream {
    rx: Receiver<Result<String, String>>,
    open: bool,
}

#[derive(Default)]
pub struct EventSourceManager {
    streams: HashMap<u64, Stream>,
}

impl EventSourceManager {
    pub fn open(&mut self, id: u64, url: &str, client: &HttpClient) -> Value {
        let (tx, rx) = channel();
        let client = client.clone();
        let url = url.to_string();
        std::thread::spawn(move || {
            let mut headers = BTreeMap::new();
            headers.insert("Accept".to_string(), "text/event-stream".to_string());
            headers.insert("Cache-Control".to_string(), "no-cache".to_string());
            match client.stream(&url, &headers) {
                Ok(resp) => {
                    if !resp.status().is_success() {
                        let _ = tx.send(Err(format!("HTTP {}", resp.status())));
                        return;
                    }
                    let _ = tx.send(Ok(String::from("\u{0}open")));
                    let mut reader = BufReader::new(resp);
                    let mut block = String::new();
                    let mut line = String::new();
                    loop {
                        line.clear();
                        match reader.read_line(&mut line) {
                            Ok(0) => break,
                            Ok(_) => {
                                if line.trim_end_matches(['\r', '\n']).is_empty() {
                                    if !block.is_empty() && tx.send(Ok(std::mem::take(&mut block))).is_err() {
                                        return;
                                    }
                                } else {
                                    block.push_str(&line);
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    let _ = tx.send(Err("closed".into()));
                }
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                }
            }
        });
        self.streams.insert(id, Stream { rx, open: true });
        json!({"ok": true})
    }

    pub fn close(&mut self, id: u64) {
        self.streams.remove(&id);
    }

    pub fn has_open(&self) -> bool {
        self.streams.values().any(|s| s.open)
    }

    pub fn poll(&mut self) -> Vec<NetEvent> {
        let mut events = Vec::new();
        let mut closed = Vec::new();
        for (id, stream) in self.streams.iter_mut() {
            loop {
                match stream.rx.try_recv() {
                    Ok(Ok(block)) if block == "\u{0}open" => events.push(NetEvent { target: "es", id: *id, kind: "open".into(), data: Value::Null }),
                    Ok(Ok(block)) => {
                        let (event, data, last_id) = parse_sse_block(&block);
                        events.push(NetEvent { target: "es", id: *id, kind: "message".into(), data: json!({"event": event, "data": data, "lastEventId": last_id}) });
                    }
                    Ok(Err(e)) => {
                        events.push(NetEvent { target: "es", id: *id, kind: "error".into(), data: json!({"message": e}) });
                        stream.open = false;
                        closed.push(*id);
                        break;
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        stream.open = false;
                        closed.push(*id);
                        break;
                    }
                }
            }
        }
        for id in closed {
            self.streams.remove(&id);
        }
        events
    }
}

fn parse_sse_block(block: &str) -> (String, String, String) {
    let mut event = "message".to_string();
    let mut data = Vec::new();
    let mut id = String::new();
    for line in block.lines() {
        if line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.find(':') {
            Some(i) => (&line[..i], line[i + 1..].strip_prefix(' ').unwrap_or(&line[i + 1..])),
            None => (line, ""),
        };
        match field {
            "event" => event = value.to_string(),
            "data" => data.push(value.to_string()),
            "id" => id = value.to_string(),
            _ => {}
        }
    }
    (event, data.join("\n"), id)
}

// ------------------------------------------------------------------ crypto

fn hmac_sign(hash: &str, key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    use hmac::Mac;
    macro_rules! run {
        ($d:ty) => {{
            let mut m = <hmac::Hmac<$d> as Mac>::new_from_slice(key).map_err(|e| e.to_string())?;
            m.update(data);
            Ok(m.finalize().into_bytes().to_vec())
        }};
    }
    match hash {
        "SHA-1" => run!(sha1::Sha1),
        "SHA-384" => run!(sha2::Sha384),
        "SHA-512" => run!(sha2::Sha512),
        _ => run!(sha2::Sha256),
    }
}

/// WebCrypto operations. Byte inputs/outputs are base64.
pub fn crypto_op(payload: &Value) -> Value {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use sha2::Digest;

    let op = payload.get("op").and_then(Value::as_str).unwrap_or("");
    let algo = payload.get("algorithm").and_then(Value::as_str).unwrap_or("SHA-256").to_ascii_uppercase();
    let data = unb64(payload.get("data").and_then(Value::as_str).unwrap_or(""));
    let key = unb64(payload.get("key").and_then(Value::as_str).unwrap_or(""));
    let err = |m: &str| json!({"error": m});

    match op {
        "digest" => {
            let out = match algo.as_str() {
                "SHA-1" => sha1::Sha1::digest(&data).to_vec(),
                "SHA-384" => sha2::Sha384::digest(&data).to_vec(),
                "SHA-512" => sha2::Sha512::digest(&data).to_vec(),
                _ => sha2::Sha256::digest(&data).to_vec(),
            };
            json!({"bytes": b64(&out)})
        }
        "hmac_sign" | "hmac_verify" => {
            let hash = payload.get("hash").and_then(Value::as_str).unwrap_or("SHA-256").to_ascii_uppercase();
            match hmac_sign(&hash, &key, &data) {
                Ok(sig) => {
                    if op == "hmac_sign" {
                        json!({"bytes": b64(&sig)})
                    } else {
                        let expected = unb64(payload.get("signature").and_then(Value::as_str).unwrap_or(""));
                        json!({"valid": sig == expected})
                    }
                }
                Err(e) => err(&e.to_string()),
            }
        }
        "aes_gcm_encrypt" | "aes_gcm_decrypt" => {
            let iv = unb64(payload.get("iv").and_then(Value::as_str).unwrap_or(""));
            let aad = unb64(payload.get("additionalData").and_then(Value::as_str).unwrap_or(""));
            if iv.len() != 12 {
                return err("AES-GCM iv must be 12 bytes");
            }
            let nonce = aes_gcm::Nonce::from_slice(&iv);
            let p = Payload { msg: &data, aad: &aad };
            let result = match key.len() {
                16 => aes_gcm::Aes128Gcm::new_from_slice(&key).ok().and_then(|c| if op == "aes_gcm_encrypt" { c.encrypt(nonce, p).ok() } else { c.decrypt(nonce, p).ok() }),
                24 => aes_gcm::AesGcm::<aes_gcm::aes::Aes192, aes_gcm::aead::generic_array::typenum::U12>::new_from_slice(&key).ok().and_then(|c| if op == "aes_gcm_encrypt" { c.encrypt(nonce, p).ok() } else { c.decrypt(nonce, p).ok() }),
                32 => aes_gcm::Aes256Gcm::new_from_slice(&key).ok().and_then(|c| if op == "aes_gcm_encrypt" { c.encrypt(nonce, p).ok() } else { c.decrypt(nonce, p).ok() }),
                _ => return err("AES key must be 128, 192 or 256 bits"),
            };
            match result {
                Some(out) => json!({"bytes": b64(&out)}),
                None => err("OperationError"),
            }
        }
        "pbkdf2" => {
            let salt = unb64(payload.get("salt").and_then(Value::as_str).unwrap_or(""));
            let iterations = payload.get("iterations").and_then(Value::as_u64).unwrap_or(1000).max(1) as u32;
            let length = payload.get("length").and_then(Value::as_u64).unwrap_or(32) as usize;
            let hash = payload.get("hash").and_then(Value::as_str).unwrap_or("SHA-256").to_ascii_uppercase();
            let mut out = vec![0u8; length];
            let res = match hash.as_str() {
                "SHA-1" => pbkdf2::pbkdf2::<hmac::Hmac<sha1::Sha1>>(&key, &salt, iterations, &mut out),
                "SHA-384" => pbkdf2::pbkdf2::<hmac::Hmac<sha2::Sha384>>(&key, &salt, iterations, &mut out),
                "SHA-512" => pbkdf2::pbkdf2::<hmac::Hmac<sha2::Sha512>>(&key, &salt, iterations, &mut out),
                _ => pbkdf2::pbkdf2::<hmac::Hmac<sha2::Sha256>>(&key, &salt, iterations, &mut out),
            };
            match res {
                Ok(_) => json!({"bytes": b64(&out)}),
                Err(e) => err(&e.to_string()),
            }
        }
        "hkdf" => {
            let salt = unb64(payload.get("salt").and_then(Value::as_str).unwrap_or(""));
            let info = unb64(payload.get("info").and_then(Value::as_str).unwrap_or(""));
            let length = payload.get("length").and_then(Value::as_u64).unwrap_or(32) as usize;
            let mut out = vec![0u8; length];
            let hash = payload.get("hash").and_then(Value::as_str).unwrap_or("SHA-256");
            let ok = match hash {
                "SHA-1" => hkdf::Hkdf::<sha1::Sha1>::new(Some(&salt), &key).expand(&info, &mut out).is_ok(),
                "SHA-384" => hkdf::Hkdf::<sha2::Sha384>::new(Some(&salt), &key).expand(&info, &mut out).is_ok(),
                "SHA-512" => hkdf::Hkdf::<sha2::Sha512>::new(Some(&salt), &key).expand(&info, &mut out).is_ok(),
                _ => hkdf::Hkdf::<sha2::Sha256>::new(Some(&salt), &key).expand(&info, &mut out).is_ok(),
            };
            if ok { json!({"bytes": b64(&out)}) } else { err("OperationError") }
        }
        _ => err("unsupported crypto operation"),
    }
}

// ------------------------------------------------------------- compression

pub fn compress(format: &str, data: &[u8], decompress: bool) -> Result<Vec<u8>, String> {
    use flate2::read::{DeflateDecoder, GzDecoder, ZlibDecoder};
    use flate2::write::{DeflateEncoder, GzEncoder, ZlibEncoder};
    use flate2::Compression;
    let mut out = Vec::new();
    let r: std::io::Result<()> = match (format, decompress) {
        ("gzip", false) => {
            let mut e = GzEncoder::new(&mut out, Compression::default());
            e.write_all(data).and_then(|_| e.finish().map(|_| ()))
        }
        ("gzip", true) => GzDecoder::new(data).read_to_end(&mut out).map(|_| ()),
        ("deflate", false) => {
            let mut e = ZlibEncoder::new(&mut out, Compression::default());
            e.write_all(data).and_then(|_| e.finish().map(|_| ()))
        }
        ("deflate", true) => ZlibDecoder::new(data).read_to_end(&mut out).map(|_| ()),
        ("deflate-raw", false) => {
            let mut e = DeflateEncoder::new(&mut out, Compression::default());
            e.write_all(data).and_then(|_| e.finish().map(|_| ()))
        }
        ("deflate-raw", true) => DeflateDecoder::new(data).read_to_end(&mut out).map(|_| ()),
        _ => return Err(format!("unsupported compression format: {format}")),
    };
    r.map_err(|e| e.to_string())?;
    Ok(out)
}

// ---------------------------------------------------------------- clipboard

pub fn clipboard_read() -> Result<String, String> {
    arboard::Clipboard::new().and_then(|mut c| c.get_text()).map_err(|e| e.to_string())
}

pub fn clipboard_write(text: &str) -> Result<(), String> {
    arboard::Clipboard::new().and_then(|mut c| c.set_text(text.to_string())).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- IndexedDB

/// IndexedDB persistence: one JSON document per origin.
pub struct IdbStore {
    path: Option<std::path::PathBuf>,
    data: BTreeMap<String, Value>,
}

impl IdbStore {
    pub fn persistent() -> Self {
        let dir = dirs::data_local_dir().map(|d| d.join("julia-browser")).unwrap_or_else(|| std::path::PathBuf::from(".browser_cache"));
        Self::at_path(dir.join("indexedDB.json"))
    }

    pub fn at_path(path: std::path::PathBuf) -> Self {
        let data = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { path: Some(path), data }
    }

    pub fn ephemeral() -> Self {
        Self { path: None, data: BTreeMap::new() }
    }

    pub fn load(&self, origin: &str) -> Value {
        self.data.get(origin).cloned().unwrap_or(Value::Null)
    }

    pub fn save(&mut self, origin: &str, snapshot: Value) {
        if snapshot.is_null() {
            return;
        }
        self.data.insert(origin.to_string(), snapshot);
        if let Some(path) = &self.path {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_string(&self.data) {
                let _ = std::fs::write(path, json);
            }
        }
    }
}

/// Sleep briefly between network polls.
pub fn poll_sleep() {
    std::thread::sleep(Duration::from_millis(20));
}
