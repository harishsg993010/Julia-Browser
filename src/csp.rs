//! Content Security Policy source-list matching (CSP Level 3 §6.7.2): whether a URL matches a
//! directive's source list. Policies themselves are parsed and tracked by the JS environment
//! (`66b_csp.js`); it calls these through the `csp` host op, and the HTTP client uses them to check
//! every redirect hop of a request before it is sent.

use url::Url;

/// `scheme-part` match: equal, or an upgrade to a secure scheme.
fn scheme_part_matches(a: &str, b: &str) -> bool {
    let (a, b) = (a.to_ascii_lowercase(), b.to_ascii_lowercase());
    a == b || (a == "http" && b == "https") || (a == "ws" && matches!(b.as_str(), "wss" | "http" | "https")) || (a == "wss" && b == "https")
}

fn is_scheme_part(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic()) && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// A parsed `host-source`: [scheme "://"] host [":" port] [path].
struct HostSource<'a> {
    scheme: Option<&'a str>,
    host: &'a str,
    port: Option<&'a str>,
    path: &'a str,
}

fn parse_host_source(expr: &str) -> Option<HostSource<'_>> {
    let (scheme, rest) = match expr.find("://") {
        Some(i) => {
            let s = &expr[..i];
            if !is_scheme_part(s) {
                return None;
            }
            (Some(s), &expr[i + 3..])
        }
        None => (None, expr),
    };
    // host-part ends at ':' (port) or '/' (path)
    let host_end = rest.find([':', '/']).unwrap_or(rest.len());
    let host = &rest[..host_end];
    if host.is_empty() {
        return None;
    }
    if host != "*" {
        let h = host.strip_prefix("*.").unwrap_or(host);
        let h = h.strip_suffix('.').unwrap_or(h);
        if h.is_empty() || !h.split('.').all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')) {
            return None;
        }
    }
    let mut after = &rest[host_end..];
    let mut port = None;
    if let Some(p) = after.strip_prefix(':') {
        let end = p.find('/').unwrap_or(p.len());
        let pp = &p[..end];
        if !(pp == "*" || (!pp.is_empty() && pp.chars().all(|c| c.is_ascii_digit()))) {
            return None;
        }
        port = Some(pp);
        after = &p[end..];
    }
    if after.contains([';', ',']) {
        return None;
    }
    Some(HostSource { scheme, host, port, path: after })
}

fn host_part_matches(pattern: &str, host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host).to_string();
    let pattern = pattern.to_ascii_lowercase();
    let pattern = pattern.strip_suffix('.').unwrap_or(&pattern).to_string();
    if pattern == "*" {
        return true;
    }
    if let Some(rest) = pattern.strip_prefix('*') {
        // "*.example.com" matches subdomains only
        return host.ends_with(rest);
    }
    pattern == host
}

fn port_part_matches(input: Option<&str>, url: &Url) -> bool {
    match input {
        Some("*") => true,
        Some(p) => {
            let n: Option<u16> = p.parse().ok();
            if n.is_some() && n == url.port() {
                return true;
            }
            url.port().is_none() && n.is_some() && n == default_port(url.scheme())
        }
        None => url.port().is_none() || url.port() == default_port(url.scheme()),
    }
}

fn default_port(scheme: &str) -> Option<u16> {
    match scheme {
        "http" | "ws" => Some(80),
        "https" | "wss" => Some(443),
        "ftp" => Some(21),
        _ => None,
    }
}

fn percent_decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()
}

fn path_part_matches(a: &str, b: &str) -> bool {
    if a.is_empty() || (a == "/" && b.is_empty()) {
        return true;
    }
    let exact = !a.ends_with('/');
    let mut la: Vec<&str> = a.split('/').collect();
    let lb: Vec<&str> = b.split('/').collect();
    if la.len() > lb.len() {
        return false;
    }
    if exact && la.len() != lb.len() {
        return false;
    }
    if !exact {
        la.pop();
    }
    la.iter().zip(lb.iter()).all(|(pa, pb)| percent_decode(pa) == percent_decode(pb))
}

/// The effective port of a URL (its port or its scheme's default).
fn effective_port(u: &Url) -> Option<u16> {
    u.port().or_else(|| default_port(u.scheme()))
}

/// "Does url match expression in origin with redirect count?"
pub fn url_matches_expression(expr: &str, url: &Url, origin: Option<&Url>, redirected: bool) -> bool {
    let scheme = url.scheme();
    if expr == "*" {
        return matches!(scheme, "http" | "https" | "ws" | "wss") || origin.is_some_and(|o| o.scheme() == scheme);
    }
    // scheme-source: "https:"
    if let Some(s) = expr.strip_suffix(':') {
        if is_scheme_part(s) {
            return scheme_part_matches(s, scheme);
        }
    }
    if expr.eq_ignore_ascii_case("'self'") {
        let Some(o) = origin else { return false };
        if o.origin() == url.origin() {
            return true;
        }
        let same_host = o.host_str().map(str::to_ascii_lowercase) == url.host_str().map(str::to_ascii_lowercase);
        let ports_ok = o.port_or_known_default() == url.port_or_known_default()
            || (url.port().is_none() || url.port() == default_port(scheme)) && (o.port().is_none() || o.port() == default_port(o.scheme()));
        return same_host && ports_ok && (matches!(scheme, "https" | "wss") || (o.scheme() == "http" && matches!(scheme, "http" | "ws")));
    }
    if expr.starts_with('\'') {
        return false; // keywords, nonces and hashes never match URLs
    }
    let Some(hs) = parse_host_source(expr) else { return false };
    let Some(host) = url.host_str() else { return false };
    match hs.scheme {
        Some(s) => {
            if !scheme_part_matches(s, scheme) {
                return false;
            }
        }
        None => {
            let base = origin.map(|o| o.scheme()).unwrap_or("https");
            if !scheme_part_matches(base, scheme) {
                return false;
            }
        }
    }
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if !host_part_matches(hs.host, host) {
        return false;
    }
    // a host source without a port matches the default port of an upgraded scheme as well
    let port_ok = match hs.port {
        None => {
            let declared = hs.scheme.and_then(default_port).or_else(|| origin.and_then(|o| default_port(o.scheme())));
            url.port().is_none() || (declared.is_some() && effective_port(url) == declared)
        }
        p => port_part_matches(p, url),
    };
    if !port_ok {
        return false;
    }
    if !hs.path.is_empty() && !redirected {
        return path_part_matches(hs.path, url.path());
    }
    true
}

/// "Does url match source list in origin with redirect count?"
pub fn url_matches_source_list(list: &[String], url: &str, origin: &str, redirected: bool) -> bool {
    let Ok(u) = Url::parse(url) else { return false };
    let o = Url::parse(origin).ok();
    let items: Vec<&str> = list.iter().map(|s| s.as_str()).filter(|s| !s.is_empty()).collect();
    if items.is_empty() || (items.len() == 1 && items[0].eq_ignore_ascii_case("'none'")) {
        return false;
    }
    items.iter().any(|e| url_matches_expression(e, &u, o.as_ref(), redirected))
}

/// Whether `expr` is a syntactically valid host-source (used by the JS side for policy checks).
pub fn is_host_source(expr: &str) -> bool {
    parse_host_source(expr).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(list: &[&str], url: &str, origin: &str) -> bool {
        url_matches_source_list(&list.iter().map(|s| s.to_string()).collect::<Vec<_>>(), url, origin, false)
    }

    #[test]
    fn source_lists() {
        let o = "http://web-platform.test:8000/a.html";
        assert!(m(&["'self'"], "http://web-platform.test:8000/x.js", o));
        assert!(!m(&["'self'"], "http://www1.web-platform.test:8000/x.js", o));
        assert!(m(&["*"], "http://other.test/x.js", o));
        assert!(!m(&["*"], "data:text/javascript,1", o));
        assert!(m(&["data:"], "data:text/javascript,1", o));
        assert!(m(&["http://*.web-platform.test:8000"], "http://www1.web-platform.test:8000/x.js", o));
        assert!(!m(&["http://*.web-platform.test:8000"], "http://web-platform.test:8000/x.js", o));
        assert!(m(&["web-platform.test:*"], "http://web-platform.test:8001/x.js", o));
        assert!(!m(&["web-platform.test"], "http://web-platform.test:8000/x.js", o));
        assert!(m(&["http://web-platform.test:8000/dir/"], "http://web-platform.test:8000/dir/x.js", o));
        assert!(!m(&["http://web-platform.test:8000/dir/x"], "http://web-platform.test:8000/dir/x.js", o));
        assert!(m(&["'none'", "'self'"], "http://web-platform.test:8000/x.js", o));
        assert!(!m(&["'none'"], "http://web-platform.test:8000/x.js", o));
        assert!(!m(&[], "http://web-platform.test:8000/x.js", o));
        assert!(m(&["http:"], "https://a.test/", o));
        assert!(m(&["example.com"], "https://example.com/", "http://x.test/"));
    }
}
