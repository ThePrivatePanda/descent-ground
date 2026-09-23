// The dashboard travels inside the binary. web/ is the same directory the hosted
// site and the file:// copy use; there is no build step over it.
use include_dir::{include_dir, Dir};

static WEB: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../web");

pub fn get(path: &str) -> Option<(&'static [u8], &'static str)> {
    let rel = match path.trim_start_matches('/') {
        "" => "index.html",
        p => p,
    };
    if rel.contains("..") {
        return None;
    }
    let f = WEB.get_file(rel)?;
    let ct = match rel.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript",
        "css" => "text/css",
        "woff2" => "font/woff2",
        "svg" => "image/svg+xml",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
    Some((f.contents(), ct))
}
