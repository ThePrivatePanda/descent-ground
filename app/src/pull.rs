// Pulling a flight log off a ChipSat, entirely inside this program.
//
// Nothing outside the binary is needed: the debug probe is driven directly, the dump
// sketch is carried inside, and the log the board prints is parsed here. No toolchain,
// no scripts, no sibling checkout.
//
// The order matters and is not obvious. The serial port is opened and read BEFORE the
// board is touched, because the board talks continuously and a port nobody is reading
// overflows; and the whole printing is collected before anything is decided, because a
// port opened mid-printing catches the tail of an older dump. Which printing was the real
// one is settled afterwards, from the text.
use crate::json::esc;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const BAUD: u32 = 115200;
const QUIET_MS: u128 = 8_000;      // silence after the last line before giving up on more
const DEADLINE_MS: u128 = 600_000; // a whole pull, including two flashes

#[derive(Clone)]
pub struct Pull {
    pub running: bool,
    pub keep_fsw: bool,
    pub board: String,
    pub started_ms: u128,
    pub finished_ms: u128,
    pub steps: Vec<String>,
    pub note: String,
    pub pct: u32,
    pub saved_fsw: Option<String>,
    pub log: Option<String>,
    pub error: Option<String>,
    pub restored: bool,
}

impl Pull {
    fn idle() -> Self {
        Pull {
            running: false,
            keep_fsw: true,
            board: String::new(),
            started_ms: 0,
            finished_ms: 0,
            steps: Vec::new(),
            note: String::new(),
            pct: 0,
            saved_fsw: None,
            log: None,
            error: None,
            restored: false,
        }
    }
}

pub type Shared = Arc<Mutex<Pull>>;

pub fn shared() -> Shared {
    Arc::new(Mutex::new(Pull::idle()))
}

pub fn state_json(p: &Pull, now_ms: u128) -> String {
    let secs = if p.started_ms == 0 {
        0
    } else {
        let end = if p.running { now_ms } else { p.finished_ms };
        end.saturating_sub(p.started_ms) / 1000
    };
    let steps: Vec<String> = p.steps.iter().map(|l| format!("\"{}\"", esc(l))).collect();
    format!(
        "{{\"ok\":true,\"running\":{},\"keepFsw\":{},\"board\":\"{}\",\"seconds\":{},\"pct\":{},\"note\":\"{}\",\"steps\":[{}],\"savedFsw\":{},\"log\":{},\"restored\":{},\"error\":{}}}",
        p.running,
        p.keep_fsw,
        esc(&p.board),
        secs,
        p.pct,
        esc(&p.note),
        steps.join(","),
        match &p.saved_fsw { Some(s) => format!("\"{}\"", esc(s)), None => String::from("null") },
        match &p.log { Some(s) => format!("\"{}\"", esc(s)), None => String::from("null") },
        p.restored,
        match &p.error { Some(e) => format!("\"{}\"", esc(e)), None => String::from("null") },
    )
}

fn say(shared: &Shared, broadcast: &crate::ws::Broadcast, pct: u32, note: &str) {
    {
        let mut p = shared.lock().unwrap();
        p.pct = pct;
        p.note = note.to_string();
        p.steps.push(note.to_string());
    }
    broadcast.send(&format!(
        "{{\"type\":\"pull\",\"pct\":{},\"note\":\"{}\"}}",
        pct,
        esc(note)
    ));
}

// Reads the console into one string while something else flashes the board. Stops when
// the board has been quiet for a while or the deadline passes; the caller decides from
// the text whether a whole dump arrived.
struct Listener {
    text: Arc<Mutex<String>>,
    stop: Arc<AtomicBool>,
    last_ms: Arc<Mutex<u128>>,
}

impl Listener {
    fn start(port_name: &str) -> Result<Listener, String> {
        let mut port = serialport::new(port_name, BAUD)
            .timeout(std::time::Duration::from_millis(200))
            .open()
            .map_err(|e| format!("{}: {}", port_name, e))?;
        let text = Arc::new(Mutex::new(String::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let last_ms = Arc::new(Mutex::new(crate::logfile::now_ms()));
        let (t2, s2, l2) = (text.clone(), stop.clone(), last_ms.clone());
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while !s2.load(Ordering::Relaxed) {
                match port.read(&mut buf) {
                    Ok(0) => {}
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        t2.lock().unwrap().push_str(&chunk);
                        *l2.lock().unwrap() = crate::logfile::now_ms();
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                    Err(_) => break,   // unplugged, or the probe reset it out from under us
                }
            }
        });
        Ok(Listener { text, stop, last_ms })
    }

    fn quiet_for(&self) -> u128 {
        crate::logfile::now_ms().saturating_sub(*self.last_ms.lock().unwrap())
    }

    fn take(&self) -> String {
        self.text.lock().unwrap().clone()
    }

    fn done(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub struct Job {
    pub shared: Shared,
    pub broadcast: crate::ws::Broadcast,
    pub dir: PathBuf,
    pub port_name: String,
    pub probe: Option<String>,
    pub keep_fsw: bool,
    pub dump_image: &'static [u8],
}

pub fn start(job: Job) -> Result<(), String> {
    {
        let p = job.shared.lock().map_err(|_| "pull state is wedged".to_string())?;
        if p.running {
            return Err(format!("already pulling from {}", p.board));
        }
    }
    {
        let mut p = job.shared.lock().unwrap();
        *p = Pull::idle();
        p.running = true;
        p.keep_fsw = job.keep_fsw;
        p.board = job.port_name.clone();
        p.started_ms = crate::logfile::now_ms();
    }
    std::thread::spawn(move || run(job));
    Ok(())
}

fn run(job: Job) {
    let Job { shared, broadcast, dir, port_name, probe, keep_fsw, dump_image } = job;
    let probe = probe.as_deref();
    let started = crate::logfile::now_ms();

    let outcome = (|| -> Result<(), String> {
        // Listening first. The board is talking already, and a port nobody reads fills up.
        say(&shared, &broadcast, 2, "listening to the board");
        let listener = Listener::start(&port_name)?;

        let mut saved: Option<PathBuf> = None;
        if keep_fsw {
            say(&shared, &broadcast, 5, "saving the flight software that is on the board");
            let hint = port_name.rsplit('/').next().unwrap_or("board").to_string();
            let path = crate::stm32::save_firmware(probe, &dir, &hint, &broadcast)?;
            shared.lock().unwrap().saved_fsw =
                path.file_name().map(|n| n.to_string_lossy().to_string());
            saved = Some(path);
        }

        say(&shared, &broadcast, 30, "writing the dump firmware");
        crate::stm32::write_firmware(probe, dump_image, &broadcast)?;
        crate::stm32::reset_and_run(probe)?;

        say(&shared, &broadcast, 45, "reading the log off the chip");
        let text = loop {
            let text = listener.take();
            let parsed = crate::dump::parse(&text);
            if parsed.complete() {
                break text;
            }
            if listener.quiet_for() > QUIET_MS {
                break text;
            }
            if crate::logfile::now_ms() - started > DEADLINE_MS {
                break text;
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        };
        listener.done();

        let parsed = crate::dump::parse(&text);
        if !parsed.complete() {
            // Keep what arrived. A short dump is still evidence, and throwing it away
            // means doing the whole thing again to look at it.
            let raw = dir.join(format!("descent-ground-dump-{}.txt", started));
            let _ = std::fs::write(&raw, &text);
            return Err(format!(
                "the board never finished printing its log; {} bytes of it are in {}",
                text.len(),
                raw.file_name().unwrap_or_default().to_string_lossy()
            ));
        }

        say(&shared, &broadcast, 80, &format!("read {} records from {} boots", parsed.records.len(), parsed.boots().len()));
        let name = format!("descent-ground-chip-{}.log", started);
        std::fs::write(dir.join(&name), crate::dump::to_log(&parsed, &port_name))
            .map_err(|e| format!("could not write {}: {}", name, e))?;
        shared.lock().unwrap().log = Some(name);

        if let Some(path) = saved {
            say(&shared, &broadcast, 90, "putting the flight software back");
            let bytes = std::fs::read(&path)
                .map_err(|e| format!("cannot read back {}: {}", path.display(), e))?;
            crate::stm32::write_firmware(probe, &bytes, &broadcast)?;
            crate::stm32::reset_and_run(probe)?;
            shared.lock().unwrap().restored = true;
        }
        Ok(())
    })();

    let mut p = shared.lock().unwrap();
    p.running = false;
    p.finished_ms = crate::logfile::now_ms();
    match outcome {
        Ok(()) => {
            p.pct = 100;
            p.note = if p.keep_fsw && p.restored {
                String::from("done, flight software back on the board")
            } else if p.keep_fsw {
                String::from("done, but the flight software was NOT put back")
            } else {
                String::from("done, the board is still running the dump firmware")
            };
        }
        Err(e) => {
            p.note = String::from("failed");
            p.error = Some(e);
        }
    }
    let frame = format!(
        "{{\"type\":\"pull\",\"pct\":{},\"note\":\"{}\",\"done\":true}}",
        p.pct,
        esc(&p.note)
    );
    drop(p);
    broadcast.send(&frame);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_state_a_reloaded_page_reads_back() {
        let mut p = Pull::idle();
        p.running = true;
        p.board = "/dev/ttyACM1".into();
        p.started_ms = 1_000_000;
        p.pct = 45;
        p.note = "reading the log off the chip".into();
        p.steps.push("saving the flight software \"first\"".into());
        let j = state_json(&p, 1_075_000);
        assert!(j.contains("\"running\":true"));
        assert!(j.contains("\"seconds\":75"), "{}", j);
        assert!(j.contains("\"keepFsw\":true"));
        assert!(j.contains("\"restored\":false"));
        assert!(j.contains("\\\"first\\\""), "a quote must not break the json: {}", j);
    }

    #[test]
    fn a_finished_pull_stops_counting() {
        let mut p = Pull::idle();
        p.started_ms = 1_000_000;
        p.finished_ms = 1_030_000;
        assert!(state_json(&p, 9_999_999).contains("\"seconds\":30"));
    }
}
