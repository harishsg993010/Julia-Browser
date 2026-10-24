//! Containing blocks for absolutely positioned boxes (julia-browser patch).
//!
//! Taffy lays every absolutely positioned box out against its layout parent. CSS uses the
//! nearest ancestor that establishes an absolute-positioning containing block (positioned,
//! transformed, ...), the initial containing block when there is none, the viewport for
//! `position: fixed`, and the grid area named by the box's grid-placement properties when that
//! ancestor is a grid container. After the root layout, this pass re-runs the abspos layout of
//! every box whose containing block is not its layout parent against the right rectangle.

use blitz_traits::node_id::NodeId;
use style::values::specified::box_::DisplayOutside;
use taffy::{Direction, Point, Size};

use super::inline::layout_abspos_child;
use crate::BaseDocument;

impl BaseDocument {
    pub(crate) fn fixup_abspos_containing_blocks(&mut self, root: NodeId) {
        if std::env::var_os("JB_NO_ABSPOS_CB").is_some() {
            return;
        }
        let viewport = self.stylist.device().au_viewport_size();
        let viewport = Size {
            width: viewport.width.to_f32_px(),
            height: viewport.height.to_f32_px(),
        };
        // Pre-order: a box is fixed up before its descendants, whose own pass then sees the
        // final geometry of every ancestor.
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            self.fixup_abspos_box(id, viewport);
            let node = &self.nodes[id];
            if let Some(children) = node.layout_children.borrow().as_ref() {
                stack.extend(children.iter().rev().copied());
            }
        }
    }

    /// Border-box origin of `id` relative to the root, from unrounded layouts.
    fn abspos_absolute_origin(&self, mut id: NodeId) -> Point<f32> {
        let mut p = Point { x: 0.0, y: 0.0 };
        loop {
            let node = &self.nodes[id];
            let loc = node.unrounded_layout().location;
            p.x += loc.x;
            p.y += loc.y;
            match node.layout_parent.get() {
                Some(parent) => id = parent,
                None => return p,
            }
        }
    }

    /// Whether `id` establishes the containing block for an absolutely (or fixed) positioned
    /// descendant.
    fn establishes_abspos_containing_block(&self, id: NodeId, fixed: bool) -> bool {
        let node = &self.nodes[id];
        if !node.is_element() || node.is_anonymous() {
            return false;
        }
        let Some(styles) = node.primary_styles() else {
            return false;
        };
        use style::computed_values::position::T as Pos;
        if !fixed && styles.clone_position() != Pos::Static {
            return true;
        }
        let b = styles.get_box();
        if !b.transform.0.is_empty() || !matches!(b.perspective, style::values::generics::box_::GenericPerspective::None) {
            return true;
        }
        if !styles.get_effects().filter.0.is_empty() {
            return true;
        }
        let contain = b.contain;
        use style::values::computed::Contain;
        if contain.intersects(Contain::LAYOUT | Contain::PAINT) {
            return true;
        }
        false
    }

    fn fixup_abspos_box(&mut self, id: NodeId, viewport: Size<f32>) {
        let node = &self.nodes[id];
        if node.style().position != taffy::Position::Absolute
            || node.style().display == taffy::Display::None
        {
            return;
        }
        let Some(parent) = node.layout_parent.get() else {
            return;
        };
        let Some(styles) = node.primary_styles() else {
            return;
        };
        let fixed = styles.clone_position() == style::computed_values::position::T::Fixed;
        let is_inline_level = styles.get_box().original_display.outside() == DisplayOutside::Inline;
        drop(styles);

        // Find the containing block.
        let mut cb = None;
        let mut a = Some(parent);
        while let Some(cur) = a {
            if self.establishes_abspos_containing_block(cur, fixed) {
                cb = Some(cur);
                break;
            }
            a = self.nodes[cur].layout_parent.get();
        }
        if cb == Some(parent) {
            // Taffy (and the inline layout) already used the right box.
            return;
        }

        // Containing block rectangle in root coordinates.
        let (area_origin, area_size, direction) = match cb {
            Some(cb) => {
                let cb_node = &self.nodes[cb];
                // An inline containing block is formed from its fragments: not modelled.
                if let Some(s) = cb_node.primary_styles() {
                    let d = s.get_box().display;
                    if d.outside() == DisplayOutside::Inline
                        && d.inside() == style::values::specified::box_::DisplayInside::Flow
                    {
                        return;
                    }
                }
                let l = *cb_node.unrounded_layout();
                let padding_box = taffy::Rect {
                    left: l.border.left,
                    top: l.border.top,
                    right: l.size.width - l.border.right,
                    bottom: l.size.height - l.border.bottom,
                };
                let direction = cb_node.style().direction;
                let area = match (
                    cb_node.style().display == taffy::Display::Grid,
                    cb_node.element_data().and_then(|e| e.detailed_grid_info.as_ref()),
                ) {
                    (true, Some(info)) => {
                        let style = self.nodes[id].style();
                        info.resolve_absolute_grid_area(
                            style.grid_row.clone(),
                            style.grid_column.clone(),
                            direction,
                            padding_box,
                        )
                    }
                    _ => padding_box,
                };
                let o = self.abspos_absolute_origin(cb);
                (
                    Point { x: o.x + area.left, y: o.y + area.top },
                    Size {
                        width: (area.right - area.left).max(0.0),
                        height: (area.bottom - area.top).max(0.0),
                    },
                    direction,
                )
            }
            // The initial containing block (absolute) or the viewport (fixed).
            None => (Point { x: 0.0, y: 0.0 }, viewport, Direction::Ltr),
        };

        let parent_origin = self.abspos_absolute_origin(parent);
        let area_offset = Point {
            x: area_origin.x - parent_origin.x,
            y: area_origin.y - parent_origin.y,
        };
        // The position taffy computed is the static position on axes whose insets are auto.
        let old = *self.nodes[id].unrounded_layout();
        let mut static_position = Point {
            x: old.location.x - old.margin.left,
            y: old.location.y - old.margin.top,
        };
        let mut direction = direction;
        let mut is_inline_level = is_inline_level;
        // A child of a grid container that is not its containing block has its static position
        // at the grid's content-box start, as if it were the sole item of a grid area matching
        // the content box (taffy placed it in the grid area / padding box instead).
        let parent_node = &self.nodes[parent];
        if parent_node.style().display == taffy::Display::Grid {
            let pl = *parent_node.unrounded_layout();
            let grid_dir = parent_node.style().direction;
            let inset = &self.nodes[id].style().inset;
            let x_static = inset.left.is_auto() && inset.right.is_auto();
            static_position.y = pl.border.top + pl.padding.top;
            if grid_dir == Direction::Rtl {
                if x_static {
                    static_position.x = pl.size.width - pl.border.right - pl.padding.right;
                    direction = Direction::Rtl;
                    is_inline_level = true;
                }
            } else {
                static_position.x = pl.border.left + pl.padding.left;
            }
        }
        layout_abspos_child(
            self,
            id.as_u64(),
            static_position,
            is_inline_level,
            area_size,
            area_offset,
            direction,
        );
    }
}
