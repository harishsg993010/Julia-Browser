"""``python -m julia_browser URL``: print a page as markdown (or text, html, layout, png)."""

from __future__ import annotations

import argparse
import sys

from . import BrowserError, __version__, render, screenshot


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="julia-browser-py", description="Load a page with real JavaScript and print it.")
    p.add_argument("url")
    p.add_argument("-f", "--format", default="markdown", choices=["markdown", "text", "html", "layout", "png"])
    p.add_argument("-o", "--output", help="write to this file (required for png)")
    p.add_argument("--no-javascript", action="store_true")
    p.add_argument("--version", action="version", version=__version__)
    a = p.parse_args(argv)
    try:
        if a.format == "png":
            if not a.output:
                p.error("--format png needs --output FILE")
            screenshot(a.url, a.output, javascript=not a.no_javascript)
            print(a.output)
            return 0
        out = render(a.url, a.format, javascript=not a.no_javascript)
    except BrowserError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    if a.output:
        with open(a.output, "w", encoding="utf-8") as f:
            f.write(out)
    else:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
