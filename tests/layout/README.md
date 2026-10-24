# Layout fixtures

Pages used by the layout spike and the golden-file tests for visual-order rendering and the
character-cell screenshot.

| Fixture | What it checks |
| --- | --- |
| `flex-columns.html` | three flex columns (nav / main / aside), a grid of cards, a table, `display:none` / `visibility:hidden` / off-screen text, a fixed modal |
| `grid-dashboard.html` | header, a 4-up stats grid and a 3×2 card grid (rendered as lists), footer |
| `sticky-modal.html` | sticky header, hidden menu, translucent backdrop, z-indexed modal and cookie bar (overlays first) |
| `accordion.html` | closed and open `<details>`, a checkbox-toggled panel, `visibility:hidden` and `opacity:0` text |
| `rtl.html` | `dir="rtl"` columns read right to left (main column first in reader mode) |
| `table.html` | a bordered data table (pipe table, framed cells) and a presentational layout table |
| `lazy-images.html` | `IntersectionObserver` lazy images and an infinite-scroll sentinel driven by `window.scrollTo` |
| `observers.html` | IntersectionObserver / ResizeObserver / scroll event log used by the phase-2 work |

```
cargo run --features layout --bin layout_spike -- tests/layout/flex-columns.html [--all] [--point X Y]
cargo test --features layout --test visual_order          # boxes and the pass on flex-columns.html
cargo test --features layout --test fixtures              # every fixture through the real pipeline
UPDATE_GOLDENS=1 cargo test --features layout --test fixtures   # accept new output
cargo test --features screenshot --test screenshot        # PNG of flex-columns.html and a #modal clip
```

`tests/fixtures.rs` serves this directory over HTTP (the browser speaks HTTP only), loads each
page with JavaScript on, and compares the visual-order Markdown with `expected/<name>.md`. The
screenshots in `expected/<name>.txt` are written for people to look at and checked for
properties only (text metrics depend on the machine's fonts). The lazy-loading test also
prints the interaction round trip (scroll → observers → relayout → render).

Expected for `flex-columns.html` at 1280×720: header 1280×60 at y=0; nav 200px wide at x=20,
main starts at x=240, aside 240px wide at the right edge; `#hidden`/`#offscreen` have no box
in the viewport; `#modal` is fixed at (300,100) 400×200; footer is below the flex wrapper.
Note that blitz resolves `position: fixed` against the root element's box, so on a short page
`bottom: 0` sits at the bottom of the content, not of the 720 px viewport.
