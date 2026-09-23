// Every line from every receiver, written whether or not a browser is open.
// The format is the dashboard's own, so the file opens in Open log.
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Log {
    file: BufWriter<File>,
    path: PathBuf,
}

// A file name someone can read on a laptop in a field: descent-ground-2026-09-22T19-30-00.log
fn stamp() -> String {
    humantime::format_rfc3339_seconds(SystemTime::now())
        .to_string()
        .replace(':', "-")
        .replace('Z', "")
}

impl Log {
    // Returns the log, or a warning to print when one cannot be opened. A read-only
    // directory is not a reason to refuse to run.
    pub fn create(dir: &Path) -> (Option<Log>, Option<String>) {
        let path = dir.join(format!("descent-ground-{}.log", stamp()));
        match File::create(&path) {
            Ok(f) => {
                let mut file = BufWriter::new(f);
                let started = humantime::format_rfc3339_millis(SystemTime::now());
                let _ = writeln!(file, "# descent-ground log v1 started {}", started);
                let _ = file.flush();
                (Some(Log { file, path }), None)
            }
            Err(e) => (None, Some(format!("no log file ({}): {}", path.display(), e))),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn write_line(&mut self, t_ms: u128, rx: &str, text: &str) {
        let clean: String = text
            .chars()
            .map(|c| if c == '\t' || c == '\r' || c == '\n' { ' ' } else { c })
            .collect();
        let _ = writeln!(self.file, "{}\t{}\t{}", t_ms, rx, clean);
    }

    pub fn flush(&mut self) {
        let _ = self.file.flush();
    }
}

pub fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_dashboards_own_log_format() {
        let dir = std::env::temp_dir().join(format!("dg-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (log, warn) = Log::create(&dir);
        let mut log = log.unwrap();
        assert!(warn.is_none());
        log.write_line(1790000000000, "rx1", "PKT,55,00FF,-50.0,13.75,-12");
        log.write_line(1790000000400, "rx2", "a\tb\rc");
        log.flush();
        let text = std::fs::read_to_string(log.path()).unwrap();
        let mut lines = text.lines();
        assert!(lines.next().unwrap().starts_with("# descent-ground log v1 started "));
        assert_eq!(lines.next().unwrap(), "1790000000000\trx1\tPKT,55,00FF,-50.0,13.75,-12");
        assert_eq!(lines.next().unwrap(), "1790000000400\trx2\ta b c");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unwritable_directory_warns_and_does_not_panic() {
        let (log, warn) = Log::create(Path::new("/proc/nonexistent-dg"));
        assert!(log.is_none());
        assert!(warn.unwrap().contains("log"));
    }
}
