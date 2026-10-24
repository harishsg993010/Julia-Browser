//! AVIF still-image decoding (container: avif-parse, AV1: rav1d, the Rust port of dav1d).
//!
//! The `image` crate has no pure-Rust AVIF decoder, but image CDNs pick AVIF from the
//! User-Agent even when `Accept` leaves it out (Cleartrip's login banner, Flipkart's rukmini
//! CDN). Image bytes are transcoded to PNG where they enter the browser, so every decoder
//! downstream (layout, paint, `naturalWidth`, canvas) sees a format it knows.

use std::ptr::NonNull;

use rav1d::include::dav1d::data::Dav1dData;
use rav1d::include::dav1d::dav1d::{Dav1dContext, Dav1dSettings};
use rav1d::include::dav1d::headers::{
    DAV1D_MC_BT2020_NCL, DAV1D_MC_BT601, DAV1D_MC_BT709, DAV1D_MC_IDENTITY, DAV1D_MC_SMPTE240, DAV1D_PIXEL_LAYOUT_I400,
    DAV1D_PIXEL_LAYOUT_I420, DAV1D_PIXEL_LAYOUT_I422,
};
use rav1d::include::dav1d::picture::Dav1dPicture;
use rav1d::src::lib::{
    dav1d_close, dav1d_data_create, dav1d_data_unref, dav1d_default_settings, dav1d_get_picture, dav1d_open,
    dav1d_picture_unref, dav1d_send_data,
};

/// Whether `bytes` is an ISO-BMFF file with an AVIF brand.
pub fn is_avif(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && matches!(&bytes[8..12], b"avif" | b"avis")
}

/// The image as PNG bytes when it is AVIF, `None` for anything else (or undecodable AVIF).
pub fn to_png_if_avif(bytes: &[u8]) -> Option<Vec<u8>> {
    if !is_avif(bytes) {
        return None;
    }
    let (w, h, rgba) = decode_rgba(bytes)?;
    let img = image::RgbaImage::from_raw(w, h, rgba)?;
    let mut out = Vec::new();
    let enc = image::codecs::png::PngEncoder::new_with_quality(&mut out, image::codecs::png::CompressionType::Fast, image::codecs::png::FilterType::NoFilter);
    img.write_with_encoder(enc).ok()?;
    Some(out)
}

/// Decodes an AVIF still image to straight (non-premultiplied) RGBA8.
pub fn decode_rgba(bytes: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let avif = avif_parse::read_avif(&mut std::io::Cursor::new(bytes)).ok()?;
    let color = decode_av1(&avif.primary_item)?;
    let (w, h) = (color.w, color.h);
    let mut rgba = color.to_rgba();
    if let Some(alpha) = avif.alpha_item.as_ref().and_then(|a| decode_av1(a)) {
        if alpha.w == w && alpha.h == h {
            let full = alpha.color_range_full;
            for y in 0..h as usize {
                for x in 0..w as usize {
                    let mut a = alpha.sample8(0, x, y);
                    if !full {
                        a = (((a as f32 - 16.0) * 255.0 / 219.0).round().clamp(0.0, 255.0)) as u8;
                    }
                    let i = (y * w as usize + x) * 4;
                    rgba[i + 3] = a;
                    if avif.premultiplied_alpha && a > 0 && a < 255 {
                        for c in 0..3 {
                            rgba[i + c] = ((rgba[i + c] as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8;
                        }
                    }
                }
            }
        }
    }
    Some((w, h, rgba))
}

/// One decoded AV1 frame: planes copied out of the decoder.
struct Frame {
    w: u32,
    h: u32,
    bpc: u32,
    layout: u32,
    mtrx: u32,
    color_range_full: bool,
    /// Plane samples widened to u16 (8-bit frames keep their values).
    planes: [Vec<u16>; 3],
    plane_w: [usize; 3],
}

impl Frame {
    fn sample(&self, plane: usize, x: usize, y: usize) -> u16 {
        let (sx, sy) = if plane == 0 { (x, y) } else {
            match self.layout {
                l if l == DAV1D_PIXEL_LAYOUT_I420 => (x >> 1, y >> 1),
                l if l == DAV1D_PIXEL_LAYOUT_I422 => (x >> 1, y),
                _ => (x, y),
            }
        };
        let pw = self.plane_w[plane];
        let idx = sy * pw + sx.min(pw.saturating_sub(1));
        self.planes[plane].get(idx).copied().unwrap_or(0)
    }

    fn sample8(&self, plane: usize, x: usize, y: usize) -> u8 {
        let v = self.sample(plane, x, y);
        if self.bpc > 8 { (v >> (self.bpc - 8)) as u8 } else { v as u8 }
    }

    fn to_rgba(&self) -> Vec<u8> {
        let (w, h) = (self.w as usize, self.h as usize);
        let mut out = vec![255u8; w * h * 4];
        let max = ((1u32 << self.bpc) - 1) as f32;
        // Kr/Kb of the matrix coefficients (BT.601 when unspecified, as browsers do)
        let (kr, kb) = match self.mtrx {
            m if m == DAV1D_MC_BT709 => (0.2126, 0.0722),
            m if m == DAV1D_MC_BT2020_NCL => (0.2627, 0.0593),
            m if m == DAV1D_MC_SMPTE240 => (0.212, 0.087),
            m if m == DAV1D_MC_BT601 => (0.299, 0.114),
            _ => (0.299, 0.114),
        };
        let kg = 1.0 - kr - kb;
        let gray = self.layout == DAV1D_PIXEL_LAYOUT_I400;
        let identity = self.mtrx == DAV1D_MC_IDENTITY;
        for y in 0..h {
            for x in 0..w {
                let yv = self.sample(0, x, y) as f32 / max;
                let (r, g, b);
                if gray {
                    let l = if self.color_range_full { yv } else { (yv - 16.0 / 255.0) * 255.0 / 219.0 };
                    r = l;
                    g = l;
                    b = l;
                } else {
                    let u = self.sample(1, x, y) as f32 / max;
                    let v = self.sample(2, x, y) as f32 / max;
                    if identity {
                        // GBR stored in Y/U/V order
                        g = yv;
                        b = u;
                        r = v;
                    } else {
                        let (l, cb, cr) = if self.color_range_full {
                            (yv, u - 0.5, v - 0.5)
                        } else {
                            ((yv - 16.0 / 255.0) * 255.0 / 219.0, (u - 128.0 / 255.0) * 255.0 / 224.0, (v - 128.0 / 255.0) * 255.0 / 224.0)
                        };
                        r = l + 2.0 * (1.0 - kr) * cr;
                        b = l + 2.0 * (1.0 - kb) * cb;
                        g = (l - kr * r - kb * b) / kg;
                    }
                }
                let i = (y * w + x) * 4;
                out[i] = (r.clamp(0.0, 1.0) * 255.0).round() as u8;
                out[i + 1] = (g.clamp(0.0, 1.0) * 255.0).round() as u8;
                out[i + 2] = (b.clamp(0.0, 1.0) * 255.0).round() as u8;
            }
        }
        out
    }
}

/// Decodes one AV1 intra frame (the OBUs of an AVIF item).
fn decode_av1(obus: &[u8]) -> Option<Frame> {
    if obus.is_empty() {
        return None;
    }
    // SAFETY: the dav1d C API is used as documented: settings are initialised by
    // `dav1d_default_settings`, data buffers come from `dav1d_data_create`, and every
    // context/picture/data is released on all paths.
    unsafe {
        let mut settings = std::mem::MaybeUninit::<Dav1dSettings>::uninit();
        dav1d_default_settings(NonNull::new(settings.as_mut_ptr())?);
        let mut settings = settings.assume_init();
        settings.n_threads = 1;
        settings.max_frame_delay = 1;
        let mut ctx: Option<Dav1dContext> = None;
        if dav1d_open(Some(NonNull::from(&mut ctx)), Some(NonNull::from(&mut settings))).0 < 0 {
            return None;
        }
        let ctx_v = ctx?;
        let mut data = Dav1dData::default();
        let buf = dav1d_data_create(Some(NonNull::from(&mut data)), obus.len());
        let mut frame = None;
        if !buf.is_null() {
            std::ptr::copy_nonoverlapping(obus.as_ptr(), buf, obus.len());
            let mut sent = false;
            let mut pic = Dav1dPicture::default();
            for _ in 0..64 {
                if !sent {
                    let r = dav1d_send_data(Some(ctx_v.clone()), Some(NonNull::from(&mut data))).0;
                    if r >= 0 && data.sz == 0 {
                        sent = true;
                    } else if r < 0 && !is_eagain(r) {
                        break;
                    }
                }
                let r = dav1d_get_picture(Some(ctx_v.clone()), Some(NonNull::from(&mut pic))).0;
                if r >= 0 {
                    frame = copy_frame(&pic);
                    dav1d_picture_unref(Some(NonNull::from(&mut pic)));
                    break;
                }
                if !is_eagain(r) {
                    break;
                }
                if sent {
                    // all data consumed and no picture yet: drain once more, then give up
                    let r = dav1d_get_picture(Some(ctx_v.clone()), Some(NonNull::from(&mut pic))).0;
                    if r >= 0 {
                        frame = copy_frame(&pic);
                        dav1d_picture_unref(Some(NonNull::from(&mut pic)));
                    }
                    break;
                }
            }
        }
        if data.sz > 0 {
            dav1d_data_unref(Some(NonNull::from(&mut data)));
        }
        dav1d_close(Some(NonNull::from(&mut ctx)));
        frame
    }
}

fn is_eagain(r: i32) -> bool {
    // DAV1D_ERR(EAGAIN): EAGAIN is 11 on every platform rav1d supports
    r == -11
}

unsafe fn copy_frame(pic: &Dav1dPicture) -> Option<Frame> {
    let w = pic.p.w.max(0) as usize;
    let h = pic.p.h.max(0) as usize;
    if w == 0 || h == 0 || w * h > 64 * 1024 * 1024 {
        return None;
    }
    let bpc = pic.p.bpc as u32;
    let layout = pic.p.layout;
    let seq = pic.seq_hdr?;
    let seq = unsafe { seq.as_ref() };
    let (cw, ch) = match layout {
        l if l == DAV1D_PIXEL_LAYOUT_I420 => ((w + 1) / 2, (h + 1) / 2),
        l if l == DAV1D_PIXEL_LAYOUT_I422 => ((w + 1) / 2, h),
        l if l == DAV1D_PIXEL_LAYOUT_I400 => (0, 0),
        _ => (w, h),
    };
    let mut planes: [Vec<u16>; 3] = Default::default();
    let dims = [(w, h), (cw, ch), (cw, ch)];
    for p in 0..3 {
        let (pw, ph) = dims[p];
        if pw == 0 {
            continue;
        }
        let base = pic.data[p]?.as_ptr() as *const u8;
        let stride = pic.stride[if p == 0 { 0 } else { 1 }];
        let mut v = Vec::with_capacity(pw * ph);
        for y in 0..ph {
            let row = unsafe { base.offset(stride * y as isize) };
            if bpc > 8 {
                let row = row as *const u16;
                for x in 0..pw {
                    v.push(unsafe { row.add(x).read_unaligned() });
                }
            } else {
                for x in 0..pw {
                    v.push(unsafe { *row.add(x) } as u16);
                }
            }
        }
        planes[p] = v;
    }
    Some(Frame {
        w: w as u32,
        h: h as u32,
        bpc,
        layout,
        mtrx: seq.mtrx,
        color_range_full: seq.color_range != 0,
        planes,
        plane_w: [w, cw, cw],
    })
}
