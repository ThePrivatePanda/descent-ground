// Where we are, in a file a script can read. The flight-software build script installs
// this app and something else launches it, so the port it actually got cannot only go
// to stdout. The file exists while the app does.
use std::path::{Path, PathBuf};

pub const NAME: &str = "descent-ground.url";

pub fn path(dir: &Path) -> PathBuf {
    dir.join(NAME)
}

// Returns the warning to print when it cannot be written, the same way the log does:
// a read-only directory is not a reason to refuse to run.
pub fn write(dir: &Path, url: &str) -> Option<String> {
    let path = path(dir);
    match std::fs::write(&path, format!("{}\n", url)) {
        Ok(()) => None,
        Err(e) => Some(format!("no url file ({}): {}", path.display(), e)),
    }
}

// Best effort on the way out. A launcher that read the file to find us may still hold
// it open, which on Windows is enough to make this fail, and that is not worth
// stopping the exit for.
pub fn remove(dir: &Path) -> Option<String> {
    let path = path(dir);
    match std::fs::remove_file(&path) {
        Ok(()) => None,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => Some(format!("left {} behind: {}", path.display(), e)),
    }
}

// The port out of a file we wrote. A kill leaves the file where it is, so this is a
// hint about where to look and not proof anyone is there.
pub fn port(dir: &Path) -> Option<u16> {
    let text = std::fs::read_to_string(path(dir)).ok()?;
    let rest = text.lines().next()?.trim().strip_prefix("http://127.0.0.1:")?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_running_app_leaves_its_address_and_takes_it_away_again() {
        let dir = std::env::temp_dir().join(format!("dg-url-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        assert!(port(&dir).is_none());
        assert!(write(&dir, "http://127.0.0.1:8790/").is_none());
        assert_eq!(std::fs::read_to_string(path(&dir)).unwrap(), "http://127.0.0.1:8790/\n");
        assert_eq!(path(&dir).file_name().unwrap(), "descent-ground.url");
        assert_eq!(port(&dir), Some(8790));

        assert!(remove(&dir).is_none());
        assert!(!path(&dir).exists());
        assert!(port(&dir).is_none());
        // Gone twice is not a complaint.
        assert!(remove(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_with_something_else_in_it_names_no_port() {
        let dir = std::env::temp_dir().join(format!("dg-url-junk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(path(&dir), "gone fishing\n").unwrap();
        assert!(port(&dir).is_none());
        std::fs::write(path(&dir), "http://127.0.0.1:/\n").unwrap();
        assert!(port(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unwritable_directory_warns_and_does_not_panic() {
        let warn = write(Path::new("/proc/nonexistent-dg"), "http://127.0.0.1:8765/").unwrap();
        assert!(warn.contains("url file"), "{}", warn);
        assert!(port(Path::new("/proc/nonexistent-dg")).is_none());
    }
}
