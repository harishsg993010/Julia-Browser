# Install

## Python wheel

```bash
pip install julia-browser
```

The wheel bundles the whole engine (SpiderMonkey, layout, screenshots). It is an abi3 wheel, so one
file covers CPython 3.9 and later. See [Python](python.md).

## From source

Requirements:

- Rust 1.80 or later
- On Windows, the MSVC build tools
- Python 3, used by Stylo's build script. On Windows, put a real `python.exe` first on `PATH`
  rather than the Microsoft Store alias.

`mozjs` downloads a prebuilt SpiderMonkey for your platform. To build SpiderMonkey yourself, set
`MOZJS_FROM_SOURCE=1`.

```bash
cargo build --release --features screenshot,images
```

This builds three names for the same browser (`julia-browser`, `jbrowser` and `jb`), plus `wpt`, the
web-platform-tests runner. `make build` runs the same command.

### Cargo features

| Feature | Adds |
| --- | --- |
| `layout` | A CSS box model from blitz-dom: Stylo cascade, Taffy flex/grid/block layout and Parley text, in a 1280×720 viewport. It gives page scripts real geometry (`getBoundingClientRect`, `elementFromPoint`, `IntersectionObserver`, scrolling) and gives Markdown its visual order |
| `screenshot` | PNG screenshots and PDF, painted on the CPU with vello (includes `layout` and `canvas`) |
| `images` | Fetches and decodes images (png, jpeg, gif, webp, bmp, ico, avif): `naturalWidth`, `load` events, `decode()`, and images painted in screenshots |
| `canvas` | Canvas 2D drawing with vello_cpu |

Most uses want `--features screenshot,images`. The agent commands that scroll, take screenshots or
save PDFs need it.

## Python wheel from source

```bash
sh scripts/build-python-wheel.sh --test          # Windows: target/wheels/repaired/*.whl
wsl -e bash scripts/wsl-build-wheel.sh --test    # Linux via WSL: target/wheels/linux/*manylinux*.whl
```

The scripts build with maturin and then repair the wheel: delvewheel on Windows, auditwheel on Linux.
