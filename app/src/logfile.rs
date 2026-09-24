// Every line from every receiver, written whether or not a browser is open.
// The format is the dashboard's own, so the file opens in Open log.
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
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

// The stamp only goes down to the second, so two logs started inside one second want
// the same name and the second would truncate the first.
fn unused_path(dir: &Path) -> PathBuf {
    let base = format!("descent-ground-{}", stamp());
    let mut path = dir.join(format!("{}.log", base));
    let mut n = 2;
    while path.exists() && n < 100 {
        path = dir.join(format!("{}-{}.log", base, n));
        n += 1;
    }
    path
}

impl Log {
    // Returns the log, or a warning to print when one cannot be opened. A read-only
    // directory is not a reason to refuse to run.
    pub fn create(dir: &Path) -> (Option<Log>, Option<String>) {
        let path = unused_path(dir);
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

// Close the current file and start another beside it, in one go, so nothing is
// written to the old file after the swap. The new one is opened first: a directory
// that has gone read-only leaves the old log in place rather than no log at all.
pub fn rotate(slot: &Mutex<Option<Log>>, fallback: &Path) -> Result<PathBuf, String> {
    let mut slot = slot.lock().map_err(|_| String::from("the log is busy"))?;
    let dir = slot
        .as_ref()
        .and_then(|l| l.path().parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| fallback.to_path_buf());
    let (new, warn) = Log::create(&dir);
    let Some(new) = new else {
        return Err(warn.unwrap_or_else(|| String::from("could not start a new log")));
    };
    let path = new.path().to_path_buf();
    if let Some(old) = slot.as_mut() {
        old.flush();
    }
    *slot = Some(new);   // the old one is dropped here, after its flush
    Ok(path)
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
    fn rotating_leaves_the_old_file_where_it_is_and_writes_to_a_new_one() {
        let dir = std::env::temp_dir().join(format!("dg-rotate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (log, _) = Log::create(&dir);
        let slot = Mutex::new(log);
        let first = slot.lock().unwrap().as_ref().unwrap().path().to_path_buf();
        slot.lock().unwrap().as_mut().unwrap().write_line(1790000000000, "rx1", "HB,1,2,3");

        // Within the same second, so this is also the name-collision case.
        let second = rotate(&slot, &dir).unwrap();
        assert_ne!(first, second);
        {
            let mut s = slot.lock().unwrap();
            let l = s.as_mut().unwrap();
            l.write_line(1790000001000, "rx1", "HB,4,5,6");
            l.flush();
        }
        let old = std::fs::read_to_string(&first).unwrap();
        assert!(old.contains("HB,1,2,3"), "{}", old);
        assert!(!old.contains("HB,4,5,6"), "{}", old);
        let new = std::fs::read_to_string(&second).unwrap();
        assert!(new.starts_with("# descent-ground log v1 started "));
        assert!(new.contains("HB,4,5,6"), "{}", new);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unwritable_directory_warns_and_does_not_panic() {
        let (log, warn) = Log::create(Path::new("/proc/nonexistent-dg"));
        assert!(log.is_none());
        assert!(warn.unwrap().contains("log"));
    }
}
