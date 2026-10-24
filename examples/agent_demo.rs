//! AI Agent SDK walkthrough: open a form page, inspect its elements, fill it
//! in, submit it and inspect the proxy traffic log.
//!
//! Run with: `cargo run --example agent_demo`

use julia_browser::AgentSdk;
use serde_json::json;

fn main() {
    let mut agent = AgentSdk::default();

    // Intercepting proxy: log everything and tag every request.
    agent.proxy_start();
    agent.proxy_add_rule(&json!({
        "name": "tag_requests",
        "type": "request",
        "actions": {"set_headers": {"X-Agent": "julia-browser"}}
    }));

    let page = agent.open_website("https://httpbin.org/forms/post");
    println!("Opened: {} ({})", page["title"], page["url"]);

    let elements = agent.list_elements();
    println!("{}", elements["summary"]);

    println!("{}", agent.type_text(1, "Ada Lovelace")["message"]);
    println!("{}", agent.type_text(2, "555-0100")["message"]);
    println!("{}", agent.type_text(3, "ada@example.com")["message"]);

    let result = agent.submit_form();
    println!("Submitted: success={} status={} url={}", result["success"], result["status_code"], result["url"]);
    let content = result["content"].as_str().unwrap_or("");
    println!("{}", content.lines().take(12).collect::<Vec<_>>().join("\n"));

    let traffic = agent.proxy_get_traffic(5, None);
    println!("\nProxy captured {} requests:", traffic["traffic_count"]);
    for entry in traffic["traffic"].as_array().unwrap() {
        println!("  {} {} -> {}", entry["request"]["method"], entry["request"]["url"], entry["response"]["status_code"]);
    }
    let first = &traffic["traffic"][0]["request"]["headers"]["X-Agent"];
    println!("Rule applied header X-Agent = {first}");

    let search = agent.search_page("Ada");
    println!("Search matches for 'Ada': {}", search["total_matches"]);
    println!("Scroll info: {}", agent.get_scroll_info()["total_elements"]);
}
