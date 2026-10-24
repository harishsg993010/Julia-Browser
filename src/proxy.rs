//! HTTP Intercepting Proxy
//!
//! Burp Suite-style request/response interception for AI agents to inspect and
//! manipulate the browser's HTTP traffic. Supports declarative JSON rules and
//! programmatic interceptors (closures).

use chrono::{DateTime, Local};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

/// An HTTP request that can be inspected and modified.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
    pub timestamp: DateTime<Local>,
    pub metadata: Map<String, Value>,
}

impl HttpRequest {
    pub fn new(method: &str, url: &str, headers: BTreeMap<String, String>, body: Option<String>) -> Self {
        Self {
            method: method.to_string(),
            url: url.to_string(),
            headers,
            body,
            timestamp: Local::now(),
            metadata: Map::new(),
        }
    }

    pub fn is_blocked(&self) -> bool {
        self.metadata.get("_blocked").and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn to_json(&self) -> Value {
        json!({
            "method": self.method,
            "url": self.url,
            "headers": self.headers,
            "body": self.body,
            "timestamp": self.timestamp.to_rfc3339(),
            "metadata": Value::Object(self.metadata.clone()),
        })
    }
}

/// An HTTP response that can be inspected and modified.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpResponseRecord {
    pub status_code: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
    pub timestamp: DateTime<Local>,
    pub metadata: Map<String, Value>,
}

impl HttpResponseRecord {
    pub fn new(status_code: u16, headers: BTreeMap<String, String>, body: Option<String>) -> Self {
        Self { status_code, headers, body, timestamp: Local::now(), metadata: Map::new() }
    }

    pub fn to_json(&self) -> Value {
        let preview = self.body.as_ref().map(|b| b.chars().take(1000).collect::<String>());
        json!({
            "status_code": self.status_code,
            "headers": self.headers,
            "body": preview,
            "body_length": self.body.as_ref().map(|b| b.len()).unwrap_or(0),
            "timestamp": self.timestamp.to_rfc3339(),
            "metadata": Value::Object(self.metadata.clone()),
        })
    }
}

/// Log entry for an HTTP request/response pair.
#[derive(Debug, Clone)]
pub struct TrafficLog {
    pub request: HttpRequest,
    pub response: Option<HttpResponseRecord>,
    pub intercepted: bool,
    pub modified: bool,
    pub timestamp: DateTime<Local>,
}

impl TrafficLog {
    pub fn to_json(&self) -> Value {
        json!({
            "request": self.request.to_json(),
            "response": self.response.as_ref().map(|r| r.to_json()),
            "intercepted": self.intercepted,
            "modified": self.modified,
            "timestamp": self.timestamp.to_rfc3339(),
        })
    }
}

/// Programmatic request interceptor.
pub type RequestFn = Arc<dyn Fn(&mut HttpRequest) + Send + Sync>;
/// Programmatic response interceptor.
pub type ResponseFn = Arc<dyn Fn(&HttpRequest, &mut HttpResponseRecord) + Send + Sync>;

enum RequestKind {
    Custom(RequestFn),
    Rule(DeclarativeRule),
}

enum ResponseKind {
    Custom(ResponseFn),
    Rule(DeclarativeRule),
}

struct RequestInterceptor {
    name: String,
    enabled: bool,
    kind: RequestKind,
}

struct ResponseInterceptor {
    name: String,
    enabled: bool,
    kind: ResponseKind,
}

/// Declarative rule for AI agents – plain JSON, no code needed.
///
/// ```json
/// {"name": "add_auth", "type": "request",
///  "match": {"url_contains": "api"},
///  "actions": {"set_headers": {"Authorization": "Bearer token"}}}
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeclarativeRule {
    pub name: String,
    #[serde(rename = "type", default = "default_rule_type")]
    pub rule_type: String,
    #[serde(rename = "match", default)]
    pub match_conditions: Map<String, Value>,
    #[serde(default)]
    pub actions: Map<String, Value>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_rule_type() -> String {
    "request".into()
}
fn default_true() -> bool {
    true
}

impl DeclarativeRule {
    pub fn from_value(rule: &Value) -> Result<Self, String> {
        let mut r: DeclarativeRule = serde_json::from_value(rule.clone()).map_err(|e| e.to_string())?;
        if r.name.is_empty() {
            r.name = "unnamed_rule".into();
        }
        Ok(r)
    }

    pub fn matches_request(&self, request: &HttpRequest) -> bool {
        if self.match_conditions.is_empty() {
            return true;
        }
        for (cond, value) in &self.match_conditions {
            match cond.as_str() {
                "url_contains" => {
                    if !request.url.contains(value.as_str().unwrap_or("")) {
                        return false;
                    }
                }
                "url_matches" => match Regex::new(value.as_str().unwrap_or("")) {
                    Ok(re) => {
                        if !re.is_match(&request.url) {
                            return false;
                        }
                    }
                    Err(_) => return false,
                },
                "method" => {
                    if !request.method.eq_ignore_ascii_case(value.as_str().unwrap_or("")) {
                        return false;
                    }
                }
                "header_equals" => {
                    if let Some(obj) = value.as_object() {
                        for (h, v) in obj {
                            if header_get(&request.headers, h).as_deref() != v.as_str() {
                                return false;
                            }
                        }
                    }
                }
                "header_contains" => {
                    if let Some(obj) = value.as_object() {
                        for (h, v) in obj {
                            let hv = header_get(&request.headers, h).unwrap_or_default();
                            if !hv.contains(v.as_str().unwrap_or("")) {
                                return false;
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        true
    }

    pub fn matches_response(&self, request: &HttpRequest, response: &HttpResponseRecord) -> bool {
        if self.match_conditions.is_empty() {
            return true;
        }
        if !self.matches_request(request) {
            return false;
        }
        for (cond, value) in &self.match_conditions {
            match cond.as_str() {
                "status_code" => {
                    if value.as_u64() != Some(response.status_code as u64) {
                        return false;
                    }
                }
                "content_type" => {
                    let ct = header_get(&response.headers, "content-type").unwrap_or_default();
                    if !ct.contains(value.as_str().unwrap_or("")) {
                        return false;
                    }
                }
                _ => {}
            }
        }
        true
    }

    pub fn apply_to_request(&self, request: &mut HttpRequest) {
        for (action, value) in &self.actions {
            match action.as_str() {
                "set_headers" => {
                    if let Some(obj) = value.as_object() {
                        for (h, v) in obj {
                            request.headers.insert(h.clone(), value_to_string(v));
                        }
                    }
                }
                "remove_headers" => {
                    if let Some(arr) = value.as_array() {
                        for h in arr.iter().filter_map(Value::as_str) {
                            header_remove(&mut request.headers, h);
                        }
                    }
                }
                "set_method" => request.method = value.as_str().unwrap_or(&request.method).to_ascii_uppercase(),
                "rewrite_url" => {
                    if let Some(obj) = value.as_object() {
                        for (pattern, replacement) in obj {
                            if let Ok(re) = Regex::new(pattern) {
                                request.url = re.replace_all(&request.url, replacement.as_str().unwrap_or("")).to_string();
                            }
                        }
                    }
                }
                "replace_body" => request.body = Some(value_to_string(value)),
                "append_body" => {
                    let extra = value_to_string(value);
                    request.body = Some(format!("{}{}", request.body.clone().unwrap_or_default(), extra));
                }
                "find_replace" => {
                    if let (Some(body), Some(obj)) = (request.body.as_mut(), value.as_object()) {
                        for (find, replace) in obj {
                            *body = body.replace(find, replace.as_str().unwrap_or(""));
                        }
                    }
                }
                "block_request" => {
                    if value.as_bool().unwrap_or(true) {
                        request.metadata.insert("_blocked".into(), Value::Bool(true));
                    }
                }
                _ => {}
            }
        }
    }

    pub fn apply_to_response(&self, response: &mut HttpResponseRecord) {
        for (action, value) in &self.actions {
            match action.as_str() {
                "set_headers" => {
                    if let Some(obj) = value.as_object() {
                        for (h, v) in obj {
                            response.headers.insert(h.clone(), value_to_string(v));
                        }
                    }
                }
                "remove_headers" => {
                    if let Some(arr) = value.as_array() {
                        for h in arr.iter().filter_map(Value::as_str) {
                            header_remove(&mut response.headers, h);
                        }
                    }
                }
                "set_status" => {
                    if let Some(s) = value.as_u64() {
                        response.status_code = s as u16;
                    }
                }
                "replace_body" => response.body = Some(value_to_string(value)),
                "append_body" => {
                    let extra = value_to_string(value);
                    response.body = Some(format!("{}{}", response.body.clone().unwrap_or_default(), extra));
                }
                "find_replace" => {
                    if let (Some(body), Some(obj)) = (response.body.as_mut(), value.as_object()) {
                        for (find, replace) in obj {
                            *body = body.replace(find, replace.as_str().unwrap_or(""));
                        }
                    }
                }
                _ => {}
            }
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "type": self.rule_type,
            "match": Value::Object(self.match_conditions.clone()),
            "actions": Value::Object(self.actions.clone()),
            "enabled": self.enabled,
        })
    }
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn header_get(headers: &BTreeMap<String, String>, name: &str) -> Option<String> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())
}

fn header_remove(headers: &mut BTreeMap<String, String>, name: &str) {
    let keys: Vec<String> = headers.keys().filter(|k| k.eq_ignore_ascii_case(name)).cloned().collect();
    for k in keys {
        headers.remove(&k);
    }
}

/// Proxy statistics.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ProxyStats {
    pub total_requests: u64,
    pub total_responses: u64,
    pub intercepted_requests: u64,
    pub intercepted_responses: u64,
    pub modified_requests: u64,
    pub modified_responses: u64,
}

#[derive(Default)]
struct Registry {
    request_interceptors: Vec<RequestInterceptor>,
    response_interceptors: Vec<ResponseInterceptor>,
}

struct ProxyState {
    enabled: bool,
    registry: Registry,
    traffic_log: Vec<TrafficLog>,
    max_log_size: usize,
    rules: BTreeMap<String, DeclarativeRule>,
    stats: ProxyStats,
}

/// HTTP Intercepting Proxy Server (in-process; cloneable handle).
#[derive(Clone)]
pub struct ProxyServer {
    state: Arc<Mutex<ProxyState>>,
}

impl Default for ProxyServer {
    fn default() -> Self {
        Self::new()
    }
}

impl ProxyServer {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(ProxyState {
                enabled: false,
                registry: Registry::default(),
                traffic_log: Vec::new(),
                max_log_size: 1000,
                rules: BTreeMap::new(),
                stats: ProxyStats::default(),
            })),
        }
    }

    pub fn start(&self) {
        self.state.lock().unwrap().enabled = true;
    }
    pub fn stop(&self) {
        self.state.lock().unwrap().enabled = false;
    }
    pub fn is_running(&self) -> bool {
        self.state.lock().unwrap().enabled
    }

    /// Intercept an outgoing request. Returns the (possibly modified) request.
    pub fn intercept_request(&self, method: &str, url: &str, headers: &BTreeMap<String, String>, body: Option<String>) -> HttpRequest {
        let mut st = self.state.lock().unwrap();
        if !st.enabled {
            return HttpRequest::new(method, url, headers.clone(), body);
        }
        st.stats.total_requests += 1;
        let mut request = HttpRequest::new(&method.to_ascii_uppercase(), url, headers.clone(), body);
        let original = request.clone();
        let mut intercepted = false;
        for interceptor in &st.registry.request_interceptors {
            if !interceptor.enabled {
                continue;
            }
            match &interceptor.kind {
                RequestKind::Custom(f) => {
                    intercepted = true;
                    f(&mut request);
                }
                RequestKind::Rule(rule) => {
                    if rule.enabled && rule.matches_request(&request) {
                        intercepted = true;
                        rule.apply_to_request(&mut request);
                    }
                }
            }
        }
        let modified = request.method != original.method
            || request.url != original.url
            || request.headers != original.headers
            || request.body != original.body
            || request.is_blocked();
        if intercepted {
            st.stats.intercepted_requests += 1;
            if modified {
                st.stats.modified_requests += 1;
            }
        }
        st.traffic_log.push(TrafficLog { request: request.clone(), response: None, intercepted, modified, timestamp: Local::now() });
        if st.traffic_log.len() > st.max_log_size {
            let excess = st.traffic_log.len() - st.max_log_size;
            st.traffic_log.drain(0..excess);
        }
        request
    }

    /// Intercept an incoming response. Returns the (possibly modified) response.
    pub fn intercept_response(&self, request: &HttpRequest, status_code: u16, headers: &BTreeMap<String, String>, body: Option<String>) -> HttpResponseRecord {
        let mut st = self.state.lock().unwrap();
        if !st.enabled {
            return HttpResponseRecord::new(status_code, headers.clone(), body);
        }
        st.stats.total_responses += 1;
        let mut response = HttpResponseRecord::new(status_code, headers.clone(), body);
        let original = response.clone();
        let mut intercepted = false;
        for interceptor in &st.registry.response_interceptors {
            if !interceptor.enabled {
                continue;
            }
            match &interceptor.kind {
                ResponseKind::Custom(f) => {
                    intercepted = true;
                    f(request, &mut response);
                }
                ResponseKind::Rule(rule) => {
                    if rule.enabled && rule.matches_response(request, &response) {
                        intercepted = true;
                        rule.apply_to_response(&mut response);
                    }
                }
            }
        }
        let modified = response.status_code != original.status_code || response.headers != original.headers || response.body != original.body;
        if intercepted {
            st.stats.intercepted_responses += 1;
            if modified {
                st.stats.modified_responses += 1;
            }
        }
        for log in st.traffic_log.iter_mut().rev() {
            if log.request.url == request.url && log.request.method == request.method && log.response.is_none() {
                log.response = Some(response.clone());
                log.intercepted |= intercepted;
                log.modified |= modified;
                break;
            }
        }
        response
    }

    /// Register a closure-based request interceptor.
    pub fn add_request_interceptor<F>(&self, name: &str, f: F)
    where
        F: Fn(&mut HttpRequest) + Send + Sync + 'static,
    {
        self.state.lock().unwrap().registry.request_interceptors.push(RequestInterceptor {
            name: name.to_string(),
            enabled: true,
            kind: RequestKind::Custom(Arc::new(f)),
        });
    }

    /// Register a closure-based response interceptor.
    pub fn add_response_interceptor<F>(&self, name: &str, f: F)
    where
        F: Fn(&HttpRequest, &mut HttpResponseRecord) + Send + Sync + 'static,
    {
        self.state.lock().unwrap().registry.response_interceptors.push(ResponseInterceptor {
            name: name.to_string(),
            enabled: true,
            kind: ResponseKind::Custom(Arc::new(f)),
        });
    }

    /// Remove interceptors (request and response) by name. Returns whether any was removed.
    pub fn remove_interceptor(&self, name: &str) -> bool {
        let mut st = self.state.lock().unwrap();
        let before = st.registry.request_interceptors.len() + st.registry.response_interceptors.len();
        st.registry.request_interceptors.retain(|i| i.name != name);
        st.registry.response_interceptors.retain(|i| i.name != name);
        before != st.registry.request_interceptors.len() + st.registry.response_interceptors.len()
    }

    pub fn get_interceptor_info(&self) -> Value {
        let st = self.state.lock().unwrap();
        json!({
            "request_interceptors": st.registry.request_interceptors.iter().map(|i| json!({"name": i.name, "enabled": i.enabled})).collect::<Vec<_>>(),
            "response_interceptors": st.registry.response_interceptors.iter().map(|i| json!({"name": i.name, "enabled": i.enabled})).collect::<Vec<_>>(),
        })
    }

    /// Add a declarative rule from JSON.
    pub fn add_declarative_rule(&self, rule: &Value) -> Value {
        match DeclarativeRule::from_value(rule) {
            Ok(rule) => {
                let mut st = self.state.lock().unwrap();
                st.rules.insert(rule.name.clone(), rule.clone());
                if rule.rule_type == "response" {
                    st.registry.response_interceptors.push(ResponseInterceptor { name: rule.name.clone(), enabled: true, kind: ResponseKind::Rule(rule.clone()) });
                } else {
                    st.registry.request_interceptors.push(RequestInterceptor { name: rule.name.clone(), enabled: true, kind: RequestKind::Rule(rule.clone()) });
                }
                json!({"success": true, "message": format!("Rule \"{}\" added successfully", rule.name), "rule": rule.to_json()})
            }
            Err(e) => json!({"success": false, "error": e}),
        }
    }

    pub fn remove_rule(&self, name: &str) -> Value {
        let mut st = self.state.lock().unwrap();
        match st.rules.remove(name) {
            Some(rule) => {
                if rule.rule_type == "response" {
                    st.registry.response_interceptors.retain(|i| i.name != name);
                } else {
                    st.registry.request_interceptors.retain(|i| i.name != name);
                }
                json!({"success": true, "message": format!("Rule \"{name}\" removed")})
            }
            None => json!({"success": false, "error": format!("Rule \"{name}\" not found")}),
        }
    }

    pub fn list_rules(&self) -> Vec<Value> {
        self.state.lock().unwrap().rules.values().map(|r| r.to_json()).collect()
    }

    /// Recent traffic with optional filter `{url_contains, method, status_code}`.
    pub fn get_traffic_log(&self, limit: usize, filter: Option<&Value>) -> Vec<Value> {
        let st = self.state.lock().unwrap();
        let mut logs: Vec<&TrafficLog> = st.traffic_log.iter().collect();
        if let Some(f) = filter.and_then(Value::as_object) {
            logs.retain(|log| {
                if let Some(s) = f.get("url_contains").and_then(Value::as_str) {
                    if !log.request.url.contains(s) {
                        return false;
                    }
                }
                if let Some(m) = f.get("method").and_then(Value::as_str) {
                    if !log.request.method.eq_ignore_ascii_case(m) {
                        return false;
                    }
                }
                if let (Some(code), Some(resp)) = (f.get("status_code").and_then(Value::as_u64), &log.response) {
                    if resp.status_code as u64 != code {
                        return false;
                    }
                }
                true
            });
        }
        let start = if limit > 0 && logs.len() > limit { logs.len() - limit } else { 0 };
        logs[start..].iter().map(|l| l.to_json()).collect()
    }

    pub fn get_stats(&self) -> ProxyStats {
        self.state.lock().unwrap().stats.clone()
    }

    pub fn clear_traffic_log(&self) {
        self.state.lock().unwrap().traffic_log.clear();
    }

    pub fn reset_stats(&self) {
        self.state.lock().unwrap().stats = ProxyStats::default();
    }

    pub fn traffic_log_size(&self) -> usize {
        self.state.lock().unwrap().traffic_log.len()
    }

    pub fn get_status(&self) -> Value {
        json!({
            "enabled": self.is_running(),
            "stats": serde_json::to_value(self.get_stats()).unwrap_or(Value::Null),
            "interceptors": self.get_interceptor_info(),
            "traffic_log_size": self.traffic_log_size(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declarative_rule_modifies_request() {
        let proxy = ProxyServer::new();
        proxy.start();
        proxy.add_declarative_rule(&json!({
            "name": "auth", "type": "request",
            "match": {"url_contains": "api"},
            "actions": {"set_headers": {"Authorization": "Bearer t"}, "set_method": "put"}
        }));
        let req = proxy.intercept_request("GET", "https://x.com/api/v1", &BTreeMap::new(), None);
        assert_eq!(req.headers["Authorization"], "Bearer t");
        assert_eq!(req.method, "PUT");
        let other = proxy.intercept_request("GET", "https://x.com/home", &BTreeMap::new(), None);
        assert!(other.headers.is_empty());
        assert_eq!(proxy.get_stats().modified_requests, 1);
        assert_eq!(proxy.get_traffic_log(10, None).len(), 2);
    }

    #[test]
    fn block_and_response_rules() {
        let proxy = ProxyServer::new();
        proxy.start();
        proxy.add_declarative_rule(&json!({"name": "b", "match": {"method": "POST"}, "actions": {"block_request": true}}));
        proxy.add_declarative_rule(&json!({"name": "r", "type": "response", "match": {"content_type": "json"}, "actions": {"find_replace": {"secret": "***"}}}));
        let req = proxy.intercept_request("POST", "https://x.com", &BTreeMap::new(), None);
        assert!(req.is_blocked());
        let mut h = BTreeMap::new();
        h.insert("content-type".to_string(), "application/json".to_string());
        let resp = proxy.intercept_response(&req, 200, &h, Some("{\"secret\":1}".into()));
        assert_eq!(resp.body.unwrap(), "{\"***\":1}");
    }
}
