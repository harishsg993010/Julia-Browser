//! Shims for MSVC STL vector-algorithm helpers that newer toolsets export from
//! msvcprt.lib but the locally installed toolset (14.41) does not. The prebuilt
//! SpiderMonkey archive references them; the semantics are the simple byte
//! versions of std::search / std::find_first_of.
use std::slice;

#[no_mangle]
pub unsafe extern "C" fn __std_search_1(
    first1: *const u8,
    last1: *const u8,
    first2: *const u8,
    count2: usize,
) -> *const u8 {
    let hay = slice::from_raw_parts(first1, last1.offset_from(first1) as usize);
    if count2 == 0 {
        return first1;
    }
    let needle = slice::from_raw_parts(first2, count2);
    match hay.windows(count2).position(|w| w == needle) {
        Some(i) => first1.add(i),
        None => last1,
    }
}

#[no_mangle]
pub unsafe extern "C" fn __std_find_first_of_trivial_pos_1(
    haystack: *const u8,
    haystack_len: usize,
    needle: *const u8,
    needle_len: usize,
) -> usize {
    let hay = slice::from_raw_parts(haystack, haystack_len);
    let needle = slice::from_raw_parts(needle, needle_len);
    hay.iter().position(|b| needle.contains(b)).unwrap_or(haystack_len)
}
