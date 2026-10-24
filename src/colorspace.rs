//! Minimal color management for canvas images: matrix/TRC ICC profiles (sRGB, Display P3,
//! Adobe RGB, ...) converted to the canvas color space (sRGB or Display P3) through XYZ (D50),
//! relative colorimetric with clipping.

/// A canvas color space.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Space {
    Srgb,
    DisplayP3,
}

impl Space {
    pub fn from_name(name: &str) -> Space {
        if name.eq_ignore_ascii_case("display-p3") { Space::DisplayP3 } else { Space::Srgb }
    }
}

#[derive(Clone, Debug)]
enum Curve {
    Gamma(f32),
    Table(Vec<f32>),
    /// ICC parametric curve: function type and its parameters (g, a, b, c, d, e, f).
    Para(u16, [f32; 7]),
    Srgb,
}

impl Curve {
    fn eval(&self, x: f32) -> f32 {
        let x = x.clamp(0.0, 1.0);
        match self {
            Curve::Gamma(g) => x.powf(*g),
            Curve::Srgb => srgb_to_linear(x),
            Curve::Table(t) => {
                if t.len() < 2 {
                    return x;
                }
                let pos = x * (t.len() - 1) as f32;
                let i = (pos.floor() as usize).min(t.len() - 2);
                let f = pos - i as f32;
                t[i] * (1.0 - f) + t[i + 1] * f
            }
            Curve::Para(kind, p) => {
                let [g, a, b, c, d, e, f] = *p;
                match kind {
                    0 => x.powf(g),
                    1 => if x >= -b / a { (a * x + b).max(0.0).powf(g) } else { 0.0 },
                    2 => if x >= -b / a { (a * x + b).max(0.0).powf(g) + c } else { c },
                    3 => if x >= d { (a * x + b).max(0.0).powf(g) } else { c * x },
                    _ => if x >= d { (a * x + b).max(0.0).powf(g) + e } else { c * x + f },
                }
            }
        }
    }
}

/// An RGB matrix/TRC profile: linear RGB -> XYZ (D50) plus per-channel tone curves.
#[derive(Clone, Debug)]
pub struct Profile {
    to_xyz: [[f32; 3]; 3],
    trc: [Curve; 3],
}

fn be_u32(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}
fn be_u16(b: &[u8], at: usize) -> Option<u16> {
    b.get(at..at + 2).map(|s| u16::from_be_bytes([s[0], s[1]]))
}
fn s15f16(b: &[u8], at: usize) -> Option<f32> {
    be_u32(b, at).map(|v| v as i32 as f32 / 65536.0)
}

/// Parse an ICC profile (RGB, matrix/TRC). `None` for other kinds (CMYK, LUT-based, gray).
pub fn parse_icc(icc: &[u8]) -> Option<Profile> {
    if icc.len() < 132 || &icc[16..20] != b"RGB " {
        return None;
    }
    let count = be_u32(icc, 128)? as usize;
    let mut tags = std::collections::HashMap::new();
    for i in 0..count.min(200) {
        let base = 132 + i * 12;
        let sig = icc.get(base..base + 4)?;
        let off = be_u32(icc, base + 4)? as usize;
        let len = be_u32(icc, base + 8)? as usize;
        tags.insert(sig.to_vec(), (off, len));
    }
    let xyz = |name: &[u8]| -> Option<[f32; 3]> {
        let (off, _) = *tags.get(name)?;
        if icc.get(off..off + 4)? != b"XYZ " {
            return None;
        }
        Some([s15f16(icc, off + 8)?, s15f16(icc, off + 12)?, s15f16(icc, off + 16)?])
    };
    let curve = |name: &[u8]| -> Option<Curve> {
        let (off, _) = *tags.get(name)?;
        match icc.get(off..off + 4)? {
            b"curv" => {
                let n = be_u32(icc, off + 8)? as usize;
                if n == 0 {
                    Some(Curve::Gamma(1.0))
                } else if n == 1 {
                    Some(Curve::Gamma(be_u16(icc, off + 12)? as f32 / 256.0))
                } else {
                    let mut t = Vec::with_capacity(n);
                    for i in 0..n {
                        t.push(be_u16(icc, off + 12 + i * 2)? as f32 / 65535.0);
                    }
                    Some(Curve::Table(t))
                }
            }
            b"para" => {
                let kind = be_u16(icc, off + 8)?;
                let n = [1, 3, 4, 5, 7].get(kind as usize).copied()?;
                let mut p = [1.0f32, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0];
                for (i, slot) in p.iter_mut().enumerate().take(n) {
                    *slot = s15f16(icc, off + 12 + i * 4)?;
                }
                Some(Curve::Para(kind, p))
            }
            _ => None,
        }
    };
    let (r, g, b) = (xyz(b"rXYZ")?, xyz(b"gXYZ")?, xyz(b"bXYZ")?);
    let to_xyz = [[r[0], g[0], b[0]], [r[1], g[1], b[1]], [r[2], g[2], b[2]]];
    Some(Profile { to_xyz, trc: [curve(b"rTRC")?, curve(b"gTRC")?, curve(b"bTRC")?] })
}

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}
fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.0031308 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}

fn mat_mul(a: &[[f32; 3]; 3], b: &[[f32; 3]; 3]) -> [[f32; 3]; 3] {
    let mut m = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            m[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    m
}
fn mat_inv(m: &[[f32; 3]; 3]) -> [[f32; 3]; 3] {
    let [[a, b, c], [d, e, f], [g, h, i]] = *m;
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    let k = 1.0 / det;
    [
        [(e * i - f * h) * k, (c * h - b * i) * k, (b * f - c * e) * k],
        [(f * g - d * i) * k, (a * i - c * g) * k, (c * d - a * f) * k],
        [(d * h - e * g) * k, (b * g - a * h) * k, (a * e - b * d) * k],
    ]
}
const D65_TO_D50: [[f32; 3]; 3] = [[1.0479298, 0.0229468, -0.0501922], [0.0296278, 0.9904344, -0.0170738], [-0.0092430, 0.0150552, 0.7518743]];
const SRGB_TO_XYZ_D65: [[f32; 3]; 3] = [[0.4123908, 0.3575843, 0.1804808], [0.2126390, 0.7151687, 0.0721923], [0.0193308, 0.1191948, 0.9505322]];
const P3_TO_XYZ_D65: [[f32; 3]; 3] = [[0.48657095, 0.2656677, 0.19821729], [0.22897457, 0.69173852, 0.07928691], [0.0, 0.04511338, 1.04394437]];

/// Linear RGB of `space` -> XYZ (D50).
fn space_to_xyz50(space: Space) -> [[f32; 3]; 3] {
    mat_mul(&D65_TO_D50, if space == Space::Srgb { &SRGB_TO_XYZ_D65 } else { &P3_TO_XYZ_D65 })
}

fn apply(m: &[[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]]
}

/// Convert straight-alpha RGBA floats (0..1) from `src` (an image profile, `None` = sRGB) to
/// 8-bit straight RGBA in `target`.
pub fn convert_to_rgba8(px: &[f32], src: Option<&Profile>, target: Space) -> Vec<u8> {
    let srgb = Profile { to_xyz: space_to_xyz50(Space::Srgb), trc: [Curve::Srgb, Curve::Srgb, Curve::Srgb] };
    let src = src.unwrap_or(&srgb);
    let to_target = mat_mul(&mat_inv(&space_to_xyz50(target)), &src.to_xyz);
    let identity = src.to_xyz == srgb.to_xyz && target == Space::Srgb && matches!(src.trc[0], Curve::Srgb);
    let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5).floor() as u8;
    let mut out = Vec::with_capacity(px.len());
    for p in px.chunks_exact(4) {
        if identity {
            out.extend_from_slice(&[q(p[0]), q(p[1]), q(p[2]), q(p[3])]);
            continue;
        }
        let lin = [src.trc[0].eval(p[0]), src.trc[1].eval(p[1]), src.trc[2].eval(p[2])];
        let t = apply(&to_target, lin);
        out.extend_from_slice(&[q(linear_to_srgb(t[0].clamp(0.0, 1.0))), q(linear_to_srgb(t[1].clamp(0.0, 1.0))), q(linear_to_srgb(t[2].clamp(0.0, 1.0))), q(p[3])]);
    }
    out
}

/// Convert 8-bit straight RGBA between canvas color spaces (in place).
pub fn convert_rgba8_between(data: &mut [u8], from: Space, to: Space) {
    if from == to {
        return;
    }
    let m = mat_mul(&mat_inv(&space_to_xyz50(to)), &space_to_xyz50(from));
    for p in data.chunks_exact_mut(4) {
        let lin = [srgb_to_linear(p[0] as f32 / 255.0), srgb_to_linear(p[1] as f32 / 255.0), srgb_to_linear(p[2] as f32 / 255.0)];
        let t = apply(&m, lin);
        for k in 0..3 {
            p[k] = (linear_to_srgb(t[k].clamp(0.0, 1.0)) * 255.0 + 0.5).floor() as u8;
        }
    }
}
