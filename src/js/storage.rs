//! Persistent Web Storage (`localStorage`) backing store, keyed by origin.
//! `sessionStorage` lives in the same structure but is never written to disk.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

type Area = BTreeMap<String, String>;

#[derive(Debug, Default, Serialize, Deserialize)]
struct Persisted {
    /// origin -> key -> value
    local: BTreeMap<String, Area>,
}

/// Storage shared by all pages loaded by one engine.
#[derive(Debug, Default)]
pub struct RealStorage {
    path: Option<PathBuf>,
    data: Persisted,
    session: BTreeMap<String, Area>,
    dirty: bool,
    /// When local storage was last written to disk.
    last_flush: Option<std::time::Instant>,
}

/// Writes are batched: the whole store is one JSON file (it grows to tens of MB), and pages call
/// setItem in loops, so a write happens at most this often while changes keep coming; the rest
/// is written by `flush` at the end of a page load or action and on drop.
const FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

impl RealStorage {
    /// Storage persisted under the user's local data directory
    /// (`<data_local_dir>/julia-browser/localStorage.json`), falling back to
    /// `./.browser_cache/localStorage.json`.
    pub fn persistent() -> Self {
        let dir = dirs::data_local_dir().map(|d| d.join("julia-browser")).unwrap_or_else(|| PathBuf::from(".browser_cache"));
        Self::at_path(dir.join("localStorage.json"))
    }

    /// In-memory storage that is never written to disk.
    pub fn ephemeral() -> Self {
        Self::default()
    }

    pub fn at_path(path: PathBuf) -> Self {
        let data = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { path: Some(path), data, session: BTreeMap::new(), dirty: false, last_flush: None }
    }

    fn area_mut(&mut self, origin: &str, area: &str) -> &mut Area {
        if area == "sessionStorage" {
            self.session.entry(origin.to_string()).or_default()
        } else {
            self.dirty = true;
            self.data.local.entry(origin.to_string()).or_default()
        }
    }

    fn area(&self, origin: &str, area: &str) -> Option<&Area> {
        if area == "sessionStorage" {
            self.session.get(origin)
        } else {
            self.data.local.get(origin)
        }
    }

    pub fn get_item(&self, origin: &str, area: &str, key: &str) -> Option<String> {
        self.area(origin, area).and_then(|a| a.get(key).cloned())
    }

    pub fn set_item(&mut self, origin: &str, area: &str, key: &str, value: &str) {
        self.area_mut(origin, area).insert(key.to_string(), value.to_string());
        self.flush_soon();
    }

    pub fn remove_item(&mut self, origin: &str, area: &str, key: &str) {
        self.area_mut(origin, area).remove(key);
        self.flush_soon();
    }

    pub fn clear(&mut self, origin: &str, area: &str) {
        self.area_mut(origin, area).clear();
        self.flush_soon();
    }

    pub fn keys(&self, origin: &str, area: &str) -> Vec<String> {
        self.area(origin, area).map(|a| a.keys().cloned().collect()).unwrap_or_default()
    }

    pub fn len(&self, origin: &str, area: &str) -> usize {
        self.area(origin, area).map(|a| a.len()).unwrap_or(0)
    }

    /// Write local storage to disk unless it was written less than `FLUSH_INTERVAL` ago.
    fn flush_soon(&mut self) {
        match self.last_flush {
            Some(t) if t.elapsed() < FLUSH_INTERVAL => {}
            _ => self.flush(),
        }
    }

    /// Write local storage to disk if anything changed.
    pub fn flush(&mut self) {
        if !self.dirty {
            return;
        }
        if let Some(path) = &self.path {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_string(&self.data) {
                let _ = std::fs::write(path, json);
            }
        }
        self.dirty = false;
        self.last_flush = Some(std::time::Instant::now());
    }
}

impl Drop for RealStorage {
    fn drop(&mut self) {
        self.flush();
    }
}
