# Rendering and screenshots

## Markdown

The default output is Markdown tuned for terminals and language models:

- Forms are rendered as widgets.
- Links and controls are numbered.
- JSON responses become a browsable view.

Pages are rendered after their scripts have run, from the live DOM.

With the `layout` feature, Markdown follows **visual order**: what a person sees, not the DOM
order.

- Hidden and collapsed content is left out (closed menus, `display:none`, off-screen boxes).
- Fixed overlays such as cookie banners and modals come first, under an `**Overlay**` label.
- Side-by-side columns are separated by `---` and labelled by their landmark (`**Navigation**`,
  `**Main content**`, `**Sidebar**`). The main column comes first.
- Rows of equal-width cards become lists.

`JB_DOM_ORDER=1` forces DOM order, and `JB_VISUAL_DEBUG=1` traces the decisions.

## Character-cell layout

```bash
julia-browser render https://example.com --format layout --cols 120 [--annotate]
```

This is the laid-out page as text:

- Text appears where it is laid out.
- Box borders are drawn as line art, and form controls as `[widgets]`.
- Images show as `[img: alt]`.
- Overlays are painted over what they cover.
- `--cols` sets the width (default 160 cells for the 1280 px viewport). `--annotate` labels boxes
  with their `#id`.

In interactive mode the same view is `screen [cols]`; in Rust it is `AgentSdk::view_layout`.

## PNG and PDF

```bash
julia-browser render https://example.com --format png -o page.png [--clip main] [--scale 2] [--viewport-only]
julia-browser screenshot shot.png --full --annotate      # agent session
julia-browser pdf page.pdf
```

Screenshots are painted on the CPU by blitz-paint and vello, so no GPU is needed. Build with
`--features screenshot,images` to paint images as well. `screenshot --annotate` numbers the
interactive elements, and later commands can target them as `@N`.

## Layout for page scripts

The `layout` feature also gives page scripts working geometry:

- `getBoundingClientRect` and `getClientRects`
- `offset*`, `client*` and `scroll*`
- `scrollIntoView`, `window.scrollTo` and `scroll` events
- `elementFromPoint` and `checkVisibility`
- Geometry-driven `IntersectionObserver` and `ResizeObserver`, so lazy loading and infinite
  scroll behave as in a desktop browser

Layout runs blitz-dom at a 1280×720 viewport: Stylo cascade, Taffy flex/grid/block, Parley text.
Stylesheets, web fonts and images are fetched through the browser's own session.
