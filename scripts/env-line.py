"""Map a browser_env.js line number to the env source file and line.
    py scripts/env-line.py <line>
Rebuilds BROWSER_ENV from the include_str!/string pieces of src/js/mod.rs."""
import re, sys

src = open("src/js/mod.rs", encoding="utf-8").read()
start = src.index("pub const BROWSER_ENV: &str = concat!(")
end = src.index(");", start)
body = src[start:end]
pieces = []
for m in re.finditer(r'include_str!\("([^"]+)"\)|"((?:[^"\\]|\\.)*)"', body):
    if m.group(1):
        text = open("src/js/" + m.group(1), encoding="utf-8").read()
        pieces.append((m.group(1), text))
    else:
        s = m.group(2).encode().decode("unicode_escape")
        pieces.append(("<literal>", s))
want = int(sys.argv[1])
line = 1
for name, text in pieces:
    n = text.count("\n")
    if line + n >= want:
        print(name, want - line + 1)
        print(text.split("\n")[want - line][:300])
        break
    line += n
