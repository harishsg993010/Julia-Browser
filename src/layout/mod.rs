//! CSS layout for the rendered page (Cargo feature `layout`).
//!
//! The JavaScript DOM stays authoritative; after page scripts have run, the
//! document is handed to a layout engine (Stylo for the cascade, Taffy for
//! flex/grid/block boxes and Parley for inline text, glued together by
//! `blitz-dom`) which gives every element a box in CSS pixels. Those boxes
//! drive the geometry Web APIs and visual-order rendering.

#[cfg(feature = "layout")]
pub mod blitz;
#[cfg(feature = "layout")]
pub(crate) mod incremental;
#[cfg(feature = "layout")]
pub mod cssom;
#[cfg(feature = "screenshot")]
pub mod screenshot;
#[cfg(feature = "layout")]
pub mod text;
pub mod visual;

/// Options for pixel screenshots (`--format png`, Cargo feature `screenshot`).
#[derive(Debug, Clone)]
pub struct ScreenshotOptions {
    /// Device pixels per CSS pixel.
    pub scale: f64,
    /// The whole document height rather than one viewport.
    pub full_page: bool,
    /// Tallest image, in CSS px, for full-page captures.
    pub max_height: u32,
    /// Document-relative region to capture instead of the page.
    pub clip: Option<Rect>,
}

impl Default for ScreenshotOptions {
    fn default() -> Self {
        ScreenshotOptions { scale: 1.0, full_page: true, max_height: 16384, clip: None }
    }
}

/// Options for the character-cell rendering (`--format layout`).
#[derive(Debug, Clone)]
pub struct TextOptions {
    /// Character cells across the viewport width.
    pub cols: usize,
    /// Write `#id` labels into boxes that have an id.
    pub annotate: bool,
    /// Rows after which the page is cut off.
    pub max_rows: usize,
}

impl Default for TextOptions {
    fn default() -> Self {
        TextOptions { cols: 160, annotate: false, max_rows: 4000 }
    }
}

/// A box in CSS pixels relative to the top-left of the document.
#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Scrollable overflow extent (CSSOM `scrollWidth`/`scrollHeight`).
    #[serde(default)]
    pub content_width: f64,
    #[serde(default)]
    pub content_height: f64,
    /// Border widths: top, right, bottom, left.
    #[serde(default)]
    pub border: [f64; 4],
    /// Padding widths: top, right, bottom, left.
    #[serde(default)]
    pub padding: [f64; 4],
    /// Bounding box [x, y, width, height] under the CSS transforms of the element and its
    /// ancestors, when any of them is transformed (CSSOM getBoundingClientRect).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transformed: Option<[f64; 4]>,
    /// The element is in a display:none subtree (it has no boxes).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    /// The element is in a viewport-fixed box (`position: fixed`, no transformed ancestor): laid
    /// out at the top of the document, it shows at the window scroll offset.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fixed: bool,
}

impl Rect {
    pub fn is_empty(&self) -> bool {
        self.width <= 0.0 || self.height <= 0.0
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }

    pub fn right(&self) -> f64 {
        self.x + self.width
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.height
    }

    pub fn area(&self) -> f64 {
        self.width.max(0.0) * self.height.max(0.0)
    }

    /// Smallest rect containing both (only the position and size matter).
    pub fn union(&self, other: &Rect) -> Rect {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        Rect { x, y, width: self.right().max(other.right()) - x, height: self.bottom().max(other.bottom()) - y, ..Rect::default() }
    }

    pub fn intersects(&self, other: &Rect) -> bool {
        self.x < other.right() && other.x < self.right() && self.y < other.bottom() && other.y < self.bottom()
    }
}

/// One laid-out element: its tag, the id the JS DOM knows it by (`data-jb`)
/// and its box. Anonymous boxes are skipped.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LaidOutElement {
    pub tag: String,
    pub jbid: Option<usize>,
    pub id: Option<String>,
    pub rect: Rect,
}

/// CSS `position` of a laid-out element.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Position {
    #[default]
    Static,
    Relative,
    Absolute,
    Fixed,
    Sticky,
}

/// What the renderer needs to know about an element's box: where it is and
/// whether a person would see it. Plain data so the visual-order pass and its
/// tests do not depend on the layout engine.
#[derive(Debug, Clone, Default)]
pub struct BoxInfo {
    pub tag: String,
    /// The element's own box; `None` for non-atomic inline elements without
    /// any line fragment (an empty `<span>`, `<br>`).
    pub rect: Option<Rect>,
    /// Stylo computed a style for the element (descendants of `display:none`
    /// subtrees have none).
    pub styled: bool,
    pub display_none: bool,
    /// Inline-level (`display-outside: inline`), so it shares lines with its
    /// siblings and must keep its DOM position.
    pub inline_level: bool,
    /// The element lays its children out with flexbox or grid.
    pub flex_or_grid: bool,
    pub visibility_hidden: bool,
    pub opacity: f32,
    pub position: Position,
    pub z_index: i32,
    /// `direction: rtl`: the element's children read right to left.
    pub rtl: bool,
}

impl BoxInfo {
    /// A box a person could see: non-empty and not styled away.
    pub fn visible_rect(&self) -> Option<Rect> {
        if self.display_none || self.visibility_hidden || self.opacity <= 0.01 {
            return None;
        }
        self.rect.filter(|r| !r.is_empty())
    }
}
