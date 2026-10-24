// jb: an 8x4 replaced item in a row flexbox that is itself a centred flex item of a
// container with a definite 56px cross size must keep its natural width (Flipkart).
use taffy::prelude::*;
use taffy::{LayoutOutput};

#[test]
fn img_in_centred_flex_item_keeps_natural_width() {
    let mut taffy: TaffyTree<bool> = TaffyTree::new();
    let img = taffy.new_leaf_with_context(Style::default(), true).unwrap();
    let inner = taffy.new_with_children(Style { display: Display::Flex, ..Default::default() }, &[img]).unwrap();
    let outer = taffy
        .new_with_children(
            Style {
                display: Display::Flex,
                align_items: Some(AlignItems::CENTER),
                size: Size { width: length(300.0), height: length(56.0) },
                ..Default::default()
            },
            &[inner],
        )
        .unwrap();
    taffy
        .compute_layout_with_measure(outer, Size::MAX_CONTENT, |inputs, _node, ctx, _style| {
            if ctx.map(|c| *c) != Some(true) {
                return LayoutOutput::from_outer_size(Size::ZERO);
            }
            let known = inputs.known_dimensions;
            eprintln!("measure known={:?} avail={:?} mode={:?}", known, inputs.available_space, inputs.sizing_mode);
            let s = match (known.width, known.height) {
                (Some(w), Some(h)) => Size { width: w, height: h },
                (Some(w), None) => Size { width: w, height: w / 2.0 },
                (None, Some(h)) => Size { width: h * 2.0, height: h },
                (None, None) => Size { width: 8.0, height: 4.0 },
            };
            LayoutOutput::from_outer_size(s)
        })
        .unwrap();
    let i = taffy.layout(img).unwrap().size;
    let n = taffy.layout(inner).unwrap().size;
    eprintln!("img {:?} inner {:?}", i, n);
    assert_eq!(i.width, 8.0);
    assert!(n.height < 10.0);
}

// Stretched in a single-line container with a definite cross size: that cross size is
// definite and transfers through the aspect ratio (wpt flex-aspect-ratio-img-row-006).
#[test]
fn img_stretched_to_definite_container_uses_ratio() {
    let mut taffy: TaffyTree<bool> = TaffyTree::new();
    let img = taffy.new_leaf_with_context(Style { min_size: Size { width: length(0.0), height: auto() }, flex_shrink: 0.0, ..Default::default() }, true).unwrap();
    let outer = taffy
        .new_with_children(Style { display: Display::Flex, size: Size { width: length(150.0), height: length(100.0) }, ..Default::default() }, &[img])
        .unwrap();
    taffy
        .compute_layout_with_measure(outer, Size::MAX_CONTENT, |inputs, _node, ctx, _style| {
            if ctx.map(|c| *c) != Some(true) {
                return LayoutOutput::from_outer_size(Size::ZERO);
            }
            let known = inputs.known_dimensions;
            let s = match (known.width, known.height) {
                (Some(w), Some(h)) => Size { width: w, height: h },
                (Some(w), None) => Size { width: w, height: w },
                (None, Some(h)) => Size { width: h, height: h },
                (None, None) => Size { width: 200.0, height: 200.0 },
            };
            LayoutOutput::from_outer_size(s)
        })
        .unwrap();
    let i = taffy.layout(img).unwrap().size;
    assert_eq!((i.width, i.height), (100.0, 100.0));
}
