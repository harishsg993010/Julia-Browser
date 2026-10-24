"""Smoke tests against a local page (no network). Run: python -m pytest python/tests  (or run this file)."""

import http.server
import threading

import julia_browser as jb

PAGE = b"""<!doctype html><html><head><title>Smoke</title></head><body>
<h1 id=h>Hello</h1>
<form id=f action=/done><input name=q placeholder="Search"><button>Go</button></form>
<button id=b onclick="this.textContent = 'clicked ' + (++window.n)">Press</button>
<script>window.n = 0; document.getElementById('h').textContent += ' from JS';</script>
</body></html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGE if not self.path.startswith("/done") else b"<title>Done</title><p>query " + self.path.encode() + b"</p>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def serve():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/"


def test_browser():
    srv, url = serve()
    try:
        with jb.Browser() as b:
            b.open(url)
            assert b.title == "Smoke"
            assert "Hello from JS" in b.read()
            b.click("#b")
            b.click("text=clicked 1")
            assert b.eval("document.getElementById('b').textContent") == "clicked 2"
            assert b.eval("Promise.resolve(40 + 2)") == 42
            png = b.screenshot()
            assert png[:8] == b"\x89PNG\r\n\x1a\n"
            b.fill("input[name=q]", "rust")
            b.press("Enter")
            assert b.title == "Done" and "q=rust" in b.url
            try:
                b.click("#missing")
                raise AssertionError("expected BrowserError")
            except jb.BrowserError:
                pass
        assert b.closed
    finally:
        srv.shutdown()


def test_agent_and_sdk():
    srv, url = serve()
    try:
        agent = jb.AgentSDK()
        page = agent.open_website(url)
        assert page["success"], page
        els = agent.list_elements()
        assert els["success"] and els.get("total_inputs", 1) >= 1
        agent.close()
        md = jb.render(url)
        assert "Hello from JS" in md
        assert jb.screenshot(url)[:4] == b"\x89PNG"
    finally:
        srv.shutdown()


def test_threads():
    srv, url = serve()
    try:
        out = []

        def run():
            with jb.Browser() as b:
                b.open(url)
                out.append(b.eval("document.querySelector('h1').textContent"))

        ts = [threading.Thread(target=run) for _ in range(3)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        assert out == ["Hello from JS"] * 3
    finally:
        srv.shutdown()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
