//! Media container probing for the virtual media pipeline (`59_media.js`):
//! duration and video size from WebM/Matroska, MP4/QuickTime, Ogg, WAV and
//! MP3 headers. Nothing is decoded; playback is simulated by the page clock.
use serde_json::{json, Value};

pub struct MediaInfo {
    pub duration: Option<f64>,
    pub width: u32,
    pub height: u32,
    pub has_video: bool,
    pub has_audio: bool,
    pub container: &'static str,
}

pub fn probe(bytes: &[u8]) -> Option<MediaInfo> {
    if bytes.len() >= 4 && bytes[..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        return webm(bytes);
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return mp4(bytes);
    }
    if bytes.starts_with(b"OggS") {
        return ogg(bytes);
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE" {
        return wav(bytes);
    }
    if bytes.starts_with(b"ID3") || (bytes.len() > 2 && bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0) {
        return mp3(bytes);
    }
    if bytes.starts_with(b"fLaC") {
        return flac(bytes);
    }
    None
}

pub fn to_json(info: &MediaInfo) -> Value {
    json!({"ok": true, "duration": info.duration, "width": info.width, "height": info.height, "video": info.has_video, "audio": info.has_audio, "container": info.container})
}

// ---- WebM / Matroska (EBML) ----
fn vint(b: &[u8], pos: usize, keep_marker: bool) -> Option<(u64, usize)> {
    let first = *b.get(pos)?;
    let len = first.leading_zeros() as usize + 1;
    if len > 8 || pos + len > b.len() {
        return None;
    }
    let mut v: u64 = if keep_marker { first as u64 } else { (first as u64) & ((1u64 << (8 - len)) - 1) };
    for i in 1..len {
        v = (v << 8) | b[pos + i] as u64;
    }
    Some((v, len))
}

fn uint(b: &[u8]) -> u64 {
    b.iter().fold(0u64, |a, x| (a << 8) | *x as u64)
}

fn float(b: &[u8]) -> Option<f64> {
    match b.len() {
        4 => Some(f32::from_be_bytes(b.try_into().ok()?) as f64),
        8 => Some(f64::from_be_bytes(b.try_into().ok()?)),
        _ => None,
    }
}

fn webm(b: &[u8]) -> Option<MediaInfo> {
    let mut info = MediaInfo { duration: None, width: 0, height: 0, has_video: false, has_audio: false, container: "webm" };
    let mut scale = 1_000_000f64;
    let mut raw_duration = None;
    // Walk elements; descend into masters we care about.
    fn walk(b: &[u8], mut pos: usize, end: usize, info: &mut MediaInfo, scale: &mut f64, dur: &mut Option<f64>, track_type: &mut u64, depth: usize) {
        while pos < end && depth < 8 {
            let Some((id, il)) = vint(b, pos, true) else { return };
            let Some((size, sl)) = vint(b, pos + il, false) else { return };
            let data = pos + il + sl;
            let unknown = size == (1u64 << (7 * sl)) - 1;
            let stop = if unknown { end } else { (data as u64 + size).min(end as u64) as usize };
            match id {
                0x18538067 | 0x1549A966 | 0x1654AE6B | 0xE0 => walk(b, data, stop, info, scale, dur, track_type, depth + 1),
                0xAE => {
                    *track_type = 0;
                    walk(b, data, stop, info, scale, dur, track_type, depth + 1);
                }
                0x2AD7B1 => *scale = uint(&b[data..stop]) as f64,
                0x4489 => *dur = float(&b[data..stop]),
                0x83 => {
                    *track_type = uint(&b[data..stop]);
                    if *track_type == 1 {
                        info.has_video = true;
                    } else if *track_type == 2 {
                        info.has_audio = true;
                    }
                }
                0xB0 => info.width = uint(&b[data..stop]) as u32,
                0xBA => info.height = uint(&b[data..stop]) as u32,
                0x1F43B675 => return, // Cluster: headers are done
                _ => {}
            }
            if unknown {
                return;
            }
            pos = stop;
        }
    }
    let mut tt = 0;
    walk(b, 0, b.len(), &mut info, &mut scale, &mut raw_duration, &mut tt, 0);
    info.duration = raw_duration.map(|d| d * scale / 1e9);
    Some(info)
}

// ---- MP4 / QuickTime ----
fn mp4(b: &[u8]) -> Option<MediaInfo> {
    let mut info = MediaInfo { duration: None, width: 0, height: 0, has_video: false, has_audio: false, container: "mp4" };
    fn boxes(b: &[u8], mut pos: usize, end: usize, info: &mut MediaInfo, cur: &mut (u32, u32), depth: usize) {
        while pos + 8 <= end && depth < 8 {
            let mut size = u32::from_be_bytes(b[pos..pos + 4].try_into().unwrap()) as u64;
            let kind = &b[pos + 4..pos + 8];
            let mut header = 8;
            if size == 1 && pos + 16 <= end {
                size = u64::from_be_bytes(b[pos + 8..pos + 16].try_into().unwrap());
                header = 16;
            } else if size == 0 {
                size = (end - pos) as u64;
            }
            if size < header as u64 {
                return;
            }
            let stop = (pos as u64 + size).min(end as u64) as usize;
            let data = pos + header;
            match kind {
                b"moov" | b"trak" | b"mdia" => {
                    if kind == b"trak" {
                        *cur = (0, 0);
                    }
                    boxes(b, data, stop, info, cur, depth + 1);
                }
                b"mvhd" if data + 20 <= stop => {
                    let v = b[data];
                    let (ts, dur) = if v == 1 && data + 32 <= stop {
                        (u32::from_be_bytes(b[data + 20..data + 24].try_into().unwrap()) as f64, u64::from_be_bytes(b[data + 24..data + 32].try_into().unwrap()) as f64)
                    } else {
                        (u32::from_be_bytes(b[data + 12..data + 16].try_into().unwrap()) as f64, u32::from_be_bytes(b[data + 16..data + 20].try_into().unwrap()) as f64)
                    };
                    if ts > 0.0 {
                        info.duration = Some(dur / ts);
                    }
                }
                b"tkhd" if stop >= data + 8 => {
                    if stop >= 8 && stop - 8 >= data {
                        let w = u32::from_be_bytes(b[stop - 8..stop - 4].try_into().unwrap()) >> 16;
                        let h = u32::from_be_bytes(b[stop - 4..stop].try_into().unwrap()) >> 16;
                        *cur = (w, h);
                    }
                }
                b"hdlr" if data + 12 <= stop => {
                    match &b[data + 8..data + 12] {
                        b"vide" => {
                            info.has_video = true;
                            if cur.0 > 0 {
                                info.width = cur.0;
                                info.height = cur.1;
                            }
                        }
                        b"soun" => info.has_audio = true,
                        _ => {}
                    }
                }
                _ => {}
            }
            pos = stop;
        }
    }
    let mut cur = (0, 0);
    boxes(b, 0, b.len(), &mut info, &mut cur, 0);
    Some(info)
}

// ---- Ogg (Vorbis, Opus, Theora) ----
fn ogg(b: &[u8]) -> Option<MediaInfo> {
    let mut info = MediaInfo { duration: None, width: 0, height: 0, has_video: false, has_audio: false, container: "ogg" };
    let mut rate = 0f64;
    let mut pre_skip = 0f64;
    let mut theora_serial = None;
    let mut audio_serial = None;
    let mut last_granule = 0u64;
    let mut pos = 0;
    while pos + 27 <= b.len() && &b[pos..pos + 4] == b"OggS" {
        let granule = u64::from_le_bytes(b[pos + 6..pos + 14].try_into().unwrap());
        let serial = u32::from_le_bytes(b[pos + 14..pos + 18].try_into().unwrap());
        let segs = b[pos + 26] as usize;
        if pos + 27 + segs > b.len() {
            break;
        }
        let body_len: usize = b[pos + 27..pos + 27 + segs].iter().map(|x| *x as usize).sum();
        let body = pos + 27 + segs;
        let packet = &b[body..(body + body_len).min(b.len())];
        if packet.starts_with(b"\x01vorbis") && packet.len() >= 16 {
            rate = u32::from_le_bytes(packet[12..16].try_into().unwrap()) as f64;
            info.has_audio = true;
            audio_serial = Some(serial);
        } else if packet.starts_with(b"OpusHead") && packet.len() >= 12 {
            rate = 48000.0;
            pre_skip = u16::from_le_bytes(packet[10..12].try_into().unwrap()) as f64;
            info.has_audio = true;
            audio_serial = Some(serial);
        } else if packet.starts_with(b"\x80theora") && packet.len() >= 20 {
            info.has_video = true;
            info.width = (u32::from(packet[14]) << 16) | (u32::from(packet[15]) << 8) | u32::from(packet[16]);
            info.height = (u32::from(packet[17]) << 16) | (u32::from(packet[18]) << 8) | u32::from(packet[19]);
            if info.width == 0 {
                info.width = (u16::from_be_bytes(packet[10..12].try_into().unwrap()) as u32) * 16;
                info.height = (u16::from_be_bytes(packet[12..14].try_into().unwrap()) as u32) * 16;
            }
            theora_serial = Some(serial);
        }
        if Some(serial) == audio_serial && granule != u64::MAX {
            last_granule = last_granule.max(granule);
        }
        let _ = theora_serial;
        pos = body + body_len;
    }
    if rate > 0.0 && last_granule > 0 {
        info.duration = Some(((last_granule as f64) - pre_skip).max(0.0) / rate);
    }
    Some(info)
}

// ---- WAV ----
fn wav(b: &[u8]) -> Option<MediaInfo> {
    let mut info = MediaInfo { duration: None, width: 0, height: 0, has_video: false, has_audio: true, container: "wav" };
    let mut pos = 12;
    let mut byte_rate = 0u32;
    while pos + 8 <= b.len() {
        let id = &b[pos..pos + 4];
        let size = u32::from_le_bytes(b[pos + 4..pos + 8].try_into().unwrap()) as usize;
        if id == b"fmt " && pos + 20 <= b.len() {
            byte_rate = u32::from_le_bytes(b[pos + 16..pos + 20].try_into().unwrap());
        }
        if id == b"data" {
            let len = size.min(b.len() - pos - 8);
            if byte_rate > 0 {
                info.duration = Some(len as f64 / byte_rate as f64);
            }
            break;
        }
        pos += 8 + size + (size & 1);
    }
    Some(info)
}

// ---- MP3 (CBR estimate from the first frame) ----
fn mp3(b: &[u8]) -> Option<MediaInfo> {
    let mut info = MediaInfo { duration: None, width: 0, height: 0, has_video: false, has_audio: true, container: "mp3" };
    let mut pos = 0;
    if b.starts_with(b"ID3") && b.len() > 10 {
        let sz = ((b[6] as usize & 0x7f) << 21) | ((b[7] as usize & 0x7f) << 14) | ((b[8] as usize & 0x7f) << 7) | (b[9] as usize & 0x7f);
        pos = 10 + sz;
    }
    while pos + 4 <= b.len() && !(b[pos] == 0xFF && b[pos + 1] & 0xE0 == 0xE0) {
        pos += 1;
    }
    if pos + 4 > b.len() {
        return Some(info);
    }
    let version = (b[pos + 1] >> 3) & 3;
    let layer = (b[pos + 1] >> 1) & 3;
    let br_idx = (b[pos + 2] >> 4) as usize;
    let v1l3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
    let v2l3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
    let kbps = if layer == 1 { if version == 3 { v1l3[br_idx] } else { v2l3[br_idx] } } else { 128 };
    if kbps > 0 {
        info.duration = Some(((b.len() - pos) as f64 * 8.0) / (kbps as f64 * 1000.0));
    }
    Some(info)
}

// ---- FLAC ----
fn flac(b: &[u8]) -> Option<MediaInfo> {
    let mut info = MediaInfo { duration: None, width: 0, height: 0, has_video: false, has_audio: true, container: "flac" };
    if b.len() >= 26 {
        let si = &b[8..];
        let rate = ((si[10] as u32) << 12) | ((si[11] as u32) << 4) | ((si[12] as u32) >> 4);
        let total = (((si[13] as u64) & 0x0F) << 32) | ((si[14] as u64) << 24) | ((si[15] as u64) << 16) | ((si[16] as u64) << 8) | si[17] as u64;
        if rate > 0 && total > 0 {
            info.duration = Some(total as f64 / rate as f64);
        }
    }
    Some(info)
}
