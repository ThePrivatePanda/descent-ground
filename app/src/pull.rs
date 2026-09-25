// Pulling a flight log off a ChipSat's flash, from the dashboard instead of a terminal.
//
// The app does not know how to talk to an ST-Link or drive a cross compiler, and it is
// not going to learn: that knowledge lives in the flight repo and belongs there. What it
// does here is run the command the operator named once, show what that command is saying
// while it runs, and open the log it leaves behind.
//
// A pull takes minutes, flashes the board twice and can fail at several points, so it is
// a job rather than a request: the state survives closing the panel, reloading the tab,
// and losing the websocket. Only the process itself dying ends it.
use crate::json::esc;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

pub const MAX_LINES: usize = 400;

#[derive(Clone)]
pub struct Pull {
    pub running: bool,
    pub restore: bool,
    pub port: String,
    pub command: String,
    pub started_ms: u128,
    pub finished_ms: u128,
    pub lines: Vec<String>,
    pub note: String,
    pub pct: u32,
    pub exit: Option<i32>,
    pub log: Option<String>,
    pub error: Option<String>,
}

impl Pull {
    fn idle() -> Self {
        Pull {
            running: false,
            restore: true,
            port: String::new(),
            command: String::new(),
            started_ms: 0,
            finished_ms: 0,
            lines: Vec::new(),
            note: String::new(),
            pct: 0,
            exit: None,
            log: None,
            error: None,
        }
    }
}

pub type Shared = Arc<Mutex<Pull>>;

pub fn shared() -> Shared {
    Arc::new(Mutex::new(Pull::idle()))
}

// {port} is the board the operator picked in the dashboard, so nothing has to go hunting
// for it by opening every serial device. {out} is where the app can read the result back.
//
// {restore} says whether the flight software that is on the board right now should be read
// off, kept, and written back afterwards. It must be the running image, never a fresh build
// of whatever the repo happens to hold: those are not the same thing, and putting the second
// one back is a silent substitution nobody asked for. Two spellings because CLIs differ —
// {restore} for a flag, {restore01} for a value.
pub fn fill(template: &str, port: &str, out: &Path, restore: bool) -> String {
    template
        .replace("{port}", port)
        .replace("{out}", &out.to_string_lossy())
        .replace("{restore}", if restore { "--restore" } else { "--no-restore" })
        .replace("{restore01}", if restore { "1" } else { "0" })
}

// The two tools already share the #DG, prefix for lines that mean something rather than
// just saying something, so a step or a percentage rides in on the same convention.
pub fn read_marker(line: &str) -> Option<(Option<u32>, String)> {
    let rest = line.trim().strip_prefix("#DG,")?;
    let mut parts = rest.split(',');
    match parts.next()? {
        "STEP" => {
            let where_ = parts.next().unwrap_or("").to_string();
            let what = parts.collect::<Vec<_>>().join(",");
            Some((None, if where_.is_empty() { what } else { format!("{} {}", where_, what) }))
        }
        "PCT" => {
            let n: u32 = parts.next()?.trim().parse().ok()?;
            Some((Some(n.min(100)), String::new()))
        }
        _ => None,
    }
}

// A log the pull left behind: the newest ground log in the output directory that was not
// there when it started. Deciding by name rather than by parsing the command's chatter,
// because the chatter is not ours to depend on.
pub fn newest_log(dir: &Path, after_ms: u128) -> Option<String> {
    let mut best: Option<(u128, String)> = None;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".log") {
            continue;
        }
        let t = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        if t + 2000 < after_ms {
            continue;   // older than this pull, so not its doing
        }
        let head = std::fs::read_to_string(e.path())
            .map(|s| s.lines().next().unwrap_or("").to_string())
            .unwrap_or_default();
        if !head.starts_with("# descent-ground log") {
            continue;
        }
        if best.as_ref().map(|(bt, _)| t > *bt).unwrap_or(true) {
            best = Some((t, name));
        }
    }
    best.map(|(_, n)| n)
}

pub fn state_json(p: &Pull, now_ms: u128) -> String {
    let secs = if p.started_ms == 0 {
        0
    } else {
        let end = if p.running { now_ms } else { p.finished_ms };
        end.saturating_sub(p.started_ms) / 1000
    };
    let lines: Vec<String> = p.lines.iter().map(|l| format!("\"{}\"", esc(l))).collect();
    format!(
        "{{\"ok\":true,\"running\":{},\"restore\":{},\"port\":\"{}\",\"command\":\"{}\",\"seconds\":{},\"pct\":{},\"note\":\"{}\",\"lines\":[{}],\"exit\":{},\"log\":{},\"error\":{}}}",
        p.running,
        p.restore,
        esc(&p.port),
        esc(&p.command),
        secs,
        p.pct,
        esc(&p.note),
        lines.join(","),
        match p.exit { Some(c) => c.to_string(), None => String::from("null") },
        match &p.log { Some(l) => format!("\"{}\"", esc(l)), None => String::from("null") },
        match &p.error { Some(e) => format!("\"{}\"", esc(e)), None => String::from("null") },
    )
}

// Runs the command with a shell, because what the operator wrote in the settings file is a
// command line with arguments and not an argv the app could guess how to split.
pub fn start(
    shared: &Shared,
    command: String,
    port: String,
    restore: bool,
    dir: PathBuf,
    broadcast: crate::ws::Broadcast,
) -> Result<(), String> {
    {
        let p = shared.lock().map_err(|_| "pull state is wedged".to_string())?;
        if p.running {
            return Err(format!("a pull is already running on {}", p.port));
        }
    }
    let started = crate::logfile::now_ms();
    {
        let mut p = shared.lock().unwrap();
        *p = Pull::idle();
        p.running = true;
        p.restore = restore;
        p.port = port.clone();
        p.command = command.clone();
        p.started_ms = started;
        p.note = String::from("starting");
    }

    let mut child = Command::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(&dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            let mut p = shared.lock().unwrap();
            p.running = false;
            p.error = Some(format!("could not run it: {}", e));
            format!("could not run it: {}", e)
        })?;

    let out = child.stdout.take();
    let err = child.stderr.take();
    for (stream, tag) in [(out.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), ""),
                          (err.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), "! ")] {
        let Some(stream) = stream else { continue };
        let shared = shared.clone();
        let broadcast = broadcast.clone();
        let tag = tag.to_string();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let mut p = shared.lock().unwrap();
                if let Some((pct, note)) = read_marker(&line) {
                    if let Some(n) = pct { p.pct = n; }
                    if !note.is_empty() { p.note = note; }
                } else {
                    p.note = line.clone();
                }
                p.lines.push(format!("{}{}", tag, line));
                if p.lines.len() > MAX_LINES {
                    p.lines.remove(0);
                }
                let frame = format!(
                    "{{\"type\":\"pull\",\"pct\":{},\"note\":\"{}\"}}",
                    p.pct,
                    esc(&p.note)
                );
                drop(p);
                broadcast.send(&frame);
            }
        });
    }

    let shared2 = shared.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        let mut p = shared2.lock().unwrap();
        p.running = false;
        p.finished_ms = crate::logfile::now_ms();
        match status {
            Ok(s) => {
                p.exit = s.code();
                if !s.success() {
                    p.error = Some(format!("the pull command exited {}", s.code().unwrap_or(-1)));
                    p.note = String::from("failed");
                } else {
                    p.note = String::from("done");
                    p.pct = 100;
                }
            }
            Err(e) => {
                p.error = Some(format!("lost the pull command: {}", e));
                p.note = String::from("failed");
            }
        }
        p.log = newest_log(&dir, started);
        let frame = format!(
            "{{\"type\":\"pull\",\"pct\":{},\"note\":\"{}\",\"done\":true}}",
            p.pct,
            esc(&p.note)
        );
        drop(p);
        broadcast.send(&frame);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_board_and_the_output_go_into_the_command() {
        let out = Path::new("/tmp/dg");
        assert_eq!(
            fill("pull.py --port {port} --dir {out}", "/dev/ttyACM1", out, true),
            "pull.py --port /dev/ttyACM1 --dir /tmp/dg"
        );
        // A template that names neither is still run; it just gets no help.
        assert_eq!(fill("pull.py", "/dev/x", out, true), "pull.py");
    }

    #[test]
    fn keeping_the_running_flight_software_is_asked_for_either_way() {
        let out = Path::new("/tmp/dg");
        assert_eq!(fill("p {restore}", "/dev/x", out, true), "p --restore");
        assert_eq!(fill("p {restore}", "/dev/x", out, false), "p --no-restore");
        assert_eq!(fill("p --keep={restore01}", "/dev/x", out, true), "p --keep=1");
        assert_eq!(fill("p --keep={restore01}", "/dev/x", out, false), "p --keep=0");
    }

    #[test]
    fn a_step_or_a_percent_is_read_off_the_shared_prefix() {
        assert_eq!(read_marker("#DG,STEP,3/5,reading the chip"), Some((None, String::from("3/5 reading the chip"))));
        assert_eq!(read_marker("#DG,PCT,42"), Some((Some(42), String::new())));
        assert_eq!(read_marker("#DG,PCT,900"), Some((Some(100), String::new())));
        // Anything else is just a line to show.
        assert_eq!(read_marker("flashing bootloader"), None);
        assert_eq!(read_marker("#DG,SRC,v1,kind=flash"), None);
    }

    #[test]
    fn the_state_a_reloaded_page_reads_back() {
        let mut p = Pull::idle();
        p.running = true;
        p.port = "/dev/ttyACM1".into();
        p.command = "pull.py --port \"x\"".into();
        p.started_ms = 1_000_000;
        p.pct = 37;
        p.note = "reading the chip".into();
        p.lines.push("record 1".into());
        let j = state_json(&p, 1_090_000);
        assert!(j.contains("\"running\":true"), "{}", j);
        assert!(j.contains("\"seconds\":90"), "{}", j);
        assert!(j.contains("\"pct\":37"));
        assert!(j.contains("\"exit\":null"));
        assert!(j.contains("\\\"x\\\""), "a quote in the command must not break the json: {}", j);
    }

    #[test]
    fn only_a_ground_log_written_by_this_pull_counts() {
        let dir = std::env::temp_dir().join(format!("dg-pull-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notes.txt"), "# descent-ground log v1\n").unwrap();
        std::fs::write(dir.join("other.log"), "nothing like ours\n").unwrap();
        assert_eq!(newest_log(&dir, 0), None, "wrong name and wrong contents are both out");
        std::fs::write(dir.join("pulled.log"), "# descent-ground log v1 from flash\n1\trx\tPKT\n").unwrap();
        assert_eq!(newest_log(&dir, 0).as_deref(), Some("pulled.log"));
        // A log from before the pull started is not its doing.
        assert_eq!(newest_log(&dir, crate::logfile::now_ms() + 600_000), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
