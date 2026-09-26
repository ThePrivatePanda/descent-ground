// A map that works with no internet. The browser fetches tiles while there is a
// connection and posts them here; this keeps them on disk next to the log files and
// serves them back, so the same page draws a map in a field with no signal.
//
// The app does no fetching of its own on purpose: no HTTP client, no TLS stack, and
// nothing in the binary that talks to the outside world.

use std::path::{Path, PathBuf};

pub const MAX_ZOOM: u32 = 19;
const MAX_TILE_BYTES: usize = 512 * 1024;

pub fn dir(base: &Path) -> PathBuf {
    base.join("tiles")
}

// z/x/y from a path like /tiles/14/4823/6160.png, refusing anything that could escape
// the tile directory or name a tile that cannot exist at that zoom.
pub fn parse(path: &str) -> Option<(u32, u32, u32)> {
    let rest = path.strip_prefix("/tiles/")?;
    let rest = rest.strip_suffix(".png").unwrap_or(rest);
    let mut it = rest.split('/');
    let z: u32 = it.next()?.parse().ok()?;
    let x: u32 = it.next()?.parse().ok()?;
    let y: u32 = it.next()?.parse().ok()?;
    if it.next().is_some() || z > MAX_ZOOM {
        return None;
    }
    let side = 1u32 << z;
    if x >= side || y >= side {
        return None;
    }
    Some((z, x, y))
}

pub fn file(base: &Path, z: u32, x: u32, y: u32) -> PathBuf {
    dir(base).join(z.to_string()).join(x.to_string()).join(format!("{}.png", y))
}

pub fn read(base: &Path, z: u32, x: u32, y: u32) -> Option<Vec<u8>> {
    std::fs::read(file(base, z, x, y)).ok()
}

// PNG, JPEG or WebP. A tile server that answers an error page in HTML must not be
// written to disk, or the map shows that page forever after.
fn looks_like_an_image(b: &[u8]) -> bool {
    b.starts_with(&[0x89, b'P', b'N', b'G'])
        || b.starts_with(&[0xFF, 0xD8, 0xFF])
        || (b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP")
}

pub fn write(base: &Path, z: u32, x: u32, y: u32, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Err(String::from("empty tile"));
    }
    if bytes.len() > MAX_TILE_BYTES {
        return Err(format!("tile is {} bytes, larger than a map tile should be", bytes.len()));
    }
    if !looks_like_an_image(bytes) {
        return Err(String::from("not an image, so probably an error page"));
    }
    let p = file(base, z, x, y);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, bytes).map_err(|e| e.to_string())
}

// What is already stored, so the page can say whether the site is covered.
pub fn stored(base: &Path) -> (u64, u64) {
    fn walk(p: &Path, count: &mut u64, bytes: &mut u64) {
        if let Ok(entries) = std::fs::read_dir(p) {
            for e in entries.flatten() {
                let path = e.path();
                if path.is_dir() {
                    walk(&path, count, bytes);
                } else if path.extension().map(|x| x == "png").unwrap_or(false) {
                    *count += 1;
                    *bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
    }
    let mut count = 0;
    let mut bytes = 0;
    walk(&dir(base), &mut count, &mut bytes);
    (count, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_tile_path() {
        assert_eq!(parse("/tiles/14/4823/6160.png"), Some((14, 4823, 6160)));
        assert_eq!(parse("/tiles/0/0/0.png"), Some((0, 0, 0)));
        assert_eq!(parse("/tiles/14/4823/6160"), Some((14, 4823, 6160)));
    }

    #[test]
    fn refuses_anything_that_is_not_a_tile() {
        assert_eq!(parse("/tiles/14/4823.png"), None, "too few parts");
        assert_eq!(parse("/tiles/14/4823/6160/1.png"), None, "too many parts");
        assert_eq!(parse("/tiles/20/1/1.png"), None, "past the deepest zoom");
        assert_eq!(parse("/tiles/1/2/0.png"), None, "x does not exist at zoom 1");
        assert_eq!(parse("/tiles/../../etc/passwd"), None);
        assert_eq!(parse("/tiles/14/-1/0.png"), None);
        assert_eq!(parse("/api/tiles"), None);
    }

    #[test]
    fn only_images_are_stored() {
        let dir = std::env::temp_dir().join(format!("dg-tiles-{}", std::process::id()));
        let png = [0x89, b'P', b'N', b'G', 13, 10, 26, 10, 0, 0];
        assert!(write(&dir, 14, 1, 2, &png).is_ok());
        assert_eq!(read(&dir, 14, 1, 2).as_deref(), Some(&png[..]));
        assert!(write(&dir, 14, 1, 3, b"<html>rate limited</html>").is_err(), "an error page is not a tile");
        assert!(write(&dir, 14, 1, 4, b"").is_err());
        let (count, bytes) = stored(&dir);
        assert_eq!(count, 1, "only the real tile was kept");
        assert_eq!(bytes, png.len() as u64);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
