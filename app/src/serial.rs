// One thread per open port.
//
// Nothing is opened until the operator says it is a receiver. That is not caution for
// its own sake: opening a port pulses DTR, which resets an ESP32, and serialport
// documents that Linux asserts DTR on open whatever you ask for, so there is no way
// to listen to an unknown board to find out what it is without possibly resetting it.
// A ChipSat and a T-Beam can carry the same USB bridge, so the chip cannot tell them
// apart either. The operator says so once and the board is remembered after that.
use crate::framing::Framer;
use crate::logfile::now_ms;
use std::collections::{HashMap, HashSet};
use std::io::{ErrorKind, Read, Write};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const BAUD: u32 = 115200;

// A board is remembered by its chip and serial number rather than by which port it
// landed on, so replugging it, or moving it to another socket, still counts as the
// same board. Plenty of CP2102s ship with the serial 0001, so approving one of those
// approves every board with that same chip and serial. The list says so.
pub fn board_key(vid: u16, pid: u16, serial: Option<&str>) -> String {
    format!("{:04x}:{:04x}:{}", vid, pid, serial.unwrap_or("-"))
}

// An ST-Link's USB serial is raw bytes rather than text and arrives as mojibake, which
// is useless for telling two identical probes apart on a bench. Anything that is not
// printable is shown as hex instead, which is the form OpenOCD and the flight tools
// use. Caveat: if the OS already replaced bad bytes on its way to us, this is the hex
// of what we were given, not of what the descriptor holds.
pub fn readable_serial(serial: &str) -> String {
    if serial.is_empty() || serial.chars().all(|c| c.is_ascii_graphic()) {
        return serial.to_string();
    }
    serial.bytes().map(|b| format!("{:02X}", b)).collect()
}

// Said out loud in the list so nobody has to recognise a hex id.
pub fn bridge_name(vid: u16, pid: u16) -> &'static str {
    match (vid, pid) {
        (0x10c4, 0xea60) => "CP2102",
        (0x1a86, 0x55d4) => "CH9102",
        (0x1a86, 0x7523) => "CH340",
        (0x303a, _) => "ESP32 native USB",
        (0x0483, _) => "ST-Link",
        _ => "USB serial",
    }
}

pub enum Event {
    Line { key: String, t_ms: u128, text: String },
    Ports,
}

// Every USB serial port on the machine, and what we are doing about it.
// state: "receiver" (open), "waiting" (never touched, needs a yes), "dismissed"
// (disconnected by hand this session), "ignored" (told to leave it alone for good).
#[derive(Clone)]
pub struct Board {
    pub port: String,
    pub usb: String,
    pub label: String,
    pub serial: String,
    pub key: String,
    pub state: String,
    pub name: String,   // what the operator calls it, empty until they say
}

#[derive(Clone)]
pub struct PortInfo {
    pub key: String,
    pub port: String,
    pub usb: String,
    pub status: String,
    pub error: Option<String>,
}

// The one thing that tells an unmarked board from its neighbour without opening it:
// the operator unplugs the one they mean and plugs it back in. A port that vanishes
// and then a port that appears carrying a key we just lost is that board. Ports are
// tracked rather than keys alone because two CP2102s can share a key, and a replug
// often lands on a different /dev/ttyUSBn.
const IDENTIFY_MS: u128 = 60_000;

pub struct Identify {
    started_ms: u128,
    last: Vec<(String, String)>,   // (board key, port) at the previous look
    gone: Vec<(String, String)>,   // pairs that have disappeared since the watch began
    found: Option<String>,
}

impl Identify {
    fn start(now_ms: u128, present: &[(String, String)]) -> Self {
        Identify { started_ms: now_ms, last: present.to_vec(), gone: Vec::new(), found: None }
    }

    fn step(&mut self, now_ms: u128, present: &[(String, String)]) {
        if self.found.is_some() || self.expired(now_ms) {
            return;
        }
        for (k, p) in &self.last {
            if !present.iter().any(|(_, q)| q == p) && !self.gone.iter().any(|(_, q)| q == p) {
                self.gone.push((k.clone(), p.clone()));
            }
        }
        for (k, p) in present {
            let back = !self.last.iter().any(|(_, q)| q == p)
                && self.gone.iter().any(|(j, _)| j == k);
            if back {
                self.found = Some(p.clone());
                break;
            }
        }
        self.last = present.to_vec();
    }

    fn expired(&self, now_ms: u128) -> bool {
        now_ms.saturating_sub(self.started_ms) >= IDENTIFY_MS
    }

    fn seconds_left(&self, now_ms: u128) -> u64 {
        let gone = now_ms.saturating_sub(self.started_ms);
        ((IDENTIFY_MS.saturating_sub(gone) + 999) / 1000) as u64
    }
}

// Keys are handed out in discovery order and stay with a device path, so rx1 is
// still rx1 after a replug and two receivers can never share a key.
pub struct Keys {
    map: HashMap<String, String>,
    next: usize,
}

impl Keys {
    pub fn new() -> Self {
        Keys { map: HashMap::new(), next: 1 }
    }

    pub fn key_for(&mut self, port: &str) -> String {
        if let Some(k) = self.map.get(port) {
            return k.clone();
        }
        let k = format!("rx{}", self.next);
        self.next += 1;
        self.map.insert(port.to_string(), k.clone());
        k
    }
}

struct Open {
    port: String,
    usb: String,
    writer: Option<Arc<Mutex<Box<dyn serialport::SerialPort>>>>,
    alive: Arc<Mutex<bool>>,
    status: Arc<Mutex<String>>,           // the reader thread owns this
    error: Arc<Mutex<Option<String>>>,
    handle: Option<std::thread::JoinHandle<()>>,
}

pub struct Hub {
    tx: Sender<Event>,
    keys: Keys,
    open: HashMap<String, Open>,   // by key
    flashing: HashSet<String>,     // device paths a flash owns
    complained: HashSet<String>,   // ports we have already moaned about
    approved: HashSet<String>,     // board keys the operator said are receivers
    ignored: HashSet<String>,      // board keys to leave alone for good
    dismissed: HashSet<String>,    // device paths disconnected by hand, until replug
    probing: HashSet<String>,      // device paths a five-second listen owns
    names: HashMap<String, String>,   // board key -> what the operator calls it
    identify: Option<Identify>,
    boards: Vec<Board>,            // every USB serial port and what we do about it
    store: Option<std::path::PathBuf>,
}

impl Hub {
    pub fn new(tx: Sender<Event>) -> Self {
        Hub {
            tx,
            keys: Keys::new(),
            open: HashMap::new(),
            flashing: HashSet::new(),
            complained: HashSet::new(),
            approved: HashSet::new(),
            ignored: HashSet::new(),
            dismissed: HashSet::new(),
            probing: HashSet::new(),
            names: HashMap::new(),
            identify: None,
            boards: Vec::new(),
            store: None,
        }
    }

    // What the operator decided last time. Kept beside the binary so a field laptop
    // stays no-click after the first run.
    pub fn remember_in(&mut self, dir: &std::path::Path) {
        let f = dir.join("descent-ground-boards.txt");
        if let Ok(text) = std::fs::read_to_string(&f) {
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                match line.split_once(' ') {
                    Some(("receiver", k)) => { self.approved.insert(k.trim().to_string()); }
                    Some(("ignore", k)) => { self.ignored.insert(k.trim().to_string()); }
                    // name <key> <whatever the operator typed>, spaces and all
                    Some(("name", rest)) => {
                        if let Some((k, n)) = rest.trim_start().split_once(' ') {
                            let n = n.trim();
                            if !n.is_empty() {
                                self.names.insert(k.to_string(), n.to_string());
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        self.store = Some(f);
    }

    fn save(&self) {
        let Some(f) = &self.store else { return };
        let mut text = String::from("# what DeSCENT Ground may open, and what each board is called.\n");
        text.push_str("# one per line: receiver <board>, ignore <board>, name <board> <what you call it>\n");
        let mut rows: Vec<String> = self
            .approved
            .iter()
            .map(|k| format!("receiver {}", k))
            .chain(self.ignored.iter().map(|k| format!("ignore {}", k)))
            .chain(self.names.iter().map(|(k, n)| format!("name {} {}", k, n)))
            .collect();
        rows.sort();
        for r in rows {
            text.push_str(&r);
            text.push('\n');
        }
        let _ = std::fs::write(f, text);
    }

    fn key_of_port(&self, port: &str) -> Option<String> {
        self.boards.iter().find(|b| b.port == port).map(|b| b.key.clone())
    }

    // Yes, this one is a receiver. Remembered as a board, so it still counts after a
    // replug or a move to another socket.
    pub fn approve(&mut self, port: &str) -> Result<(), String> {
        let key = self.key_of_port(port).ok_or_else(|| format!("{} is not plugged in", port))?;
        self.ignored.remove(&key);
        self.approved.insert(key);
        self.dismissed.remove(port);
        self.complained.remove(port);
        self.touch_board(port, Some("receiver"), None);
        self.save();
        let _ = self.tx.send(Event::Ports);
        Ok(())
    }

    // Not a receiver, and stop asking. Closes it if it happened to be open.
    pub fn ignore(&mut self, port: &str) -> Result<(), String> {
        let key = self.key_of_port(port).ok_or_else(|| format!("{} is not plugged in", port))?;
        self.approved.remove(&key);
        self.ignored.insert(key);
        if let Some(k) = self.open.iter().find(|(_, o)| o.port == port).map(|(k, _)| k.clone()) {
            self.close(&k);
        }
        self.touch_board(port, Some("ignored"), None);
        self.save();
        let _ = self.tx.send(Event::Ports);
        Ok(())
    }

    // What the operator calls this board. Against the board, like the approvals, so a
    // replug or another socket keeps the name. An empty name clears it. The settings
    // file is one board per line, so a name cannot carry a newline.
    pub fn set_name(&mut self, port: &str, name: &str) -> Result<(), String> {
        let key = self.key_of_port(port).ok_or_else(|| format!("{} is not plugged in", port))?;
        if name.contains('\n') || name.contains('\r') {
            return Err(String::from("a name has to fit on one line"));
        }
        let name = name.trim();
        if name.is_empty() {
            self.names.remove(&key);
        } else {
            self.names.insert(key, name.to_string());
        }
        self.touch_board(port, None, Some(name));
        self.save();
        let _ = self.tx.send(Event::Ports);
        Ok(())
    }

    // Start watching for a replug. A second call restarts it and forgets the last answer.
    pub fn identify_start(&mut self) {
        let present: Vec<(String, String)> =
            self.boards.iter().map(|b| (b.key.clone(), b.port.clone())).collect();
        self.identify = Some(Identify::start(now_ms(), &present));
    }

    // watching, the port that came back, seconds left. An expired watch reads the same
    // as no watch at all; a found one stops the clock and keeps its answer until the
    // next start.
    pub fn identify_state(&self) -> (bool, Option<String>, u64) {
        let Some(w) = &self.identify else { return (false, None, 0) };
        let now = now_ms();
        if let Some(p) = &w.found {
            return (false, Some(p.clone()), 0);
        }
        if w.expired(now) {
            return (false, None, 0);
        }
        (true, None, w.seconds_left(now))
    }

    // A five-second listen is not ownership, but poll() and the flasher have to keep
    // off the port while it lasts, and anything already using it says no.
    pub fn begin_probe(&mut self, port: &str) -> Result<(), String> {
        if self.key_of_port(port).is_none() {
            return Err(format!("{} is not plugged in", port));
        }
        if self.probing.contains(port) {
            return Err(format!("{} is already being listened to", port));
        }
        if self.flashing.contains(port) {
            return Err(format!("{} is being flashed", port));
        }
        if self.open.values().any(|o| o.port == port) {
            return Err(format!("{} is open as a receiver — disconnect it there first", port));
        }
        self.probing.insert(port.to_string());
        Ok(())
    }

    pub fn end_probe(&mut self, port: &str) {
        self.probing.remove(port);
        let _ = self.tx.send(Event::Ports);
    }

    fn fingerprint(boards: &[Board]) -> String {
        boards.iter().map(|b| format!("{}|{}|{}", b.port, b.state, b.name)).collect()
    }

    // Answering a decision straight away, rather than leaving the page to show what it
    // showed before until the next scan two seconds later. That delay read as the first
    // click doing nothing, so people clicked twice.
    fn touch_board(&mut self, port: &str, state: Option<&str>, name: Option<&str>) {
        for b in self.boards.iter_mut() {
            if b.port == port {
                if let Some(s) = state { b.state = s.to_string(); }
                if let Some(n) = name { b.name = n.to_string(); }
            }
        }
    }

    pub fn boards(&self) -> Vec<Board> {
        self.boards.clone()
    }

    pub fn ports(&self) -> Vec<PortInfo> {
        let mut v: Vec<PortInfo> = self
            .open
            .iter()
            .map(|(key, o)| PortInfo {
                key: key.clone(),
                port: o.port.clone(),
                usb: o.usb.clone(),
                status: o.status.lock().map(|s| s.clone()).unwrap_or_else(|_| "error".into()),
                error: o.error.lock().ok().and_then(|e| e.clone()),
            })
            .collect();
        v.sort_by(|a, b| a.key.cmp(&b.key));
        v
    }

    pub fn send(&mut self, key: &str, text: &str) -> Result<(), String> {
        let o = self.open.get(key).ok_or_else(|| format!("{} is not open", key))?;
        let writer = o.writer.as_ref().ok_or_else(|| format!("{} has no port", key))?;
        let mut w = writer.lock().map_err(|_| format!("{} is busy", key))?;
        w.write_all(text.as_bytes()).map_err(|e| format!("{}: {}", key, e))?;
        w.flush().map_err(|e| format!("{}: {}", key, e))
    }

    // Disconnect by hand. The port stays shut until it is replugged or approved
    // again: reopening it two seconds later is what made the ✕ useless.
    pub fn dismiss(&mut self, key: &str) {
        if let Some(port) = self.open.get(key).map(|o| o.port.clone()) {
            self.dismissed.insert(port);
        }
        self.close(key);
    }

    pub fn close(&mut self, key: &str) {
        if let Some(mut o) = self.open.remove(key) {
            if let Ok(mut a) = o.alive.lock() {
                *a = false;
            }
            if let Some(h) = o.handle.take() {
                let _ = h.join();
            }
        }
        let _ = self.tx.send(Event::Ports);
    }

    // Hand a port over to the flasher: stop reading it, wait for the reader thread to
    // let go of the file descriptor, and keep poll() off it until the flash is done.
    // serialport takes an exclusive lock on the device, so espflash cannot open it
    // while our reader is still alive.
    pub fn release_for_flash(&mut self, port: &str) -> Result<(), String> {
        if self.flashing.contains(port) {
            return Err(format!("{} is already being flashed", port));
        }
        if self.probing.contains(port) {
            return Err(format!("{} is being listened to, so wait for that to finish", port));
        }
        self.flashing.insert(port.to_string());
        let key = self.open.iter().find(|(_, o)| o.port == port).map(|(k, _)| k.clone());
        if let Some(k) = key {
            self.close(&k);
        }
        let _ = self.tx.send(Event::Ports);
        Ok(())
    }

    // Give it back. poll() reopens it on its next pass, which also re-reads the
    // #DG,RX header from the firmware that is now on the board.
    pub fn take_back(&mut self, port: &str) {
        self.flashing.remove(port);
        self.complained.remove(port);
        let _ = self.tx.send(Event::Ports);
    }

    pub fn is_flashing(&self, port: &str) -> bool {
        self.flashing.contains(port)
    }

    // Called every 2 s. Opens anything new, forgets anything unplugged.
    pub fn poll(&mut self) {
        let found = serialport::available_ports().unwrap_or_default();
        let mut seen: Vec<String> = Vec::new();
        let mut boards: Vec<Board> = Vec::new();
        let mut present: HashSet<String> = HashSet::new();

        for p in found {
            let u = match &p.port_type {
                serialport::SerialPortType::UsbPort(u) => u.clone(),
                _ => continue,   // a built-in ttyS is never one of ours
            };
            present.insert(p.port_name.clone());
            let serial = readable_serial(&u.serial_number.clone().unwrap_or_default());
            let key = board_key(u.vid, u.pid, u.serial_number.as_deref());
            let usb = format!("{:04x}:{:04x}", u.vid, u.pid);
            let label = bridge_name(u.vid, u.pid).to_string();

            let approved = self.approved.contains(&key);
            let state = if self.ignored.contains(&key) {
                "ignored"
            } else if self.dismissed.contains(&p.port_name) {
                "dismissed"
            } else if approved {
                "receiver"
            } else {
                "waiting"
            };
            let name = self.names.get(&key).cloned().unwrap_or_default();
            boards.push(Board {
                port: p.port_name.clone(),
                usb: usb.clone(),
                label,
                serial,
                key,
                state: state.to_string(),
                name,
            });

            if state != "receiver"
                || self.flashing.contains(&p.port_name)
                || self.probing.contains(&p.port_name)
            {
                continue;
            }

            let rx = self.keys.key_for(&p.port_name);
            seen.push(rx.clone());
            if let Some(o) = self.open.get(&rx) {
                if o.status.lock().map(|s| s.as_str() == "open").unwrap_or(false) {
                    continue;
                }
                self.close(&rx);   // its reader died; fall through and open it again
            }
            match serialport::new(&p.port_name, BAUD).timeout(Duration::from_millis(200)).open() {
                Ok(port) => {
                    self.complained.remove(&p.port_name);
                    self.spawn(rx, p.port_name, usb, port);
                }
                Err(e) => {
                    let hint = if e.to_string().contains("ermission") {
                        format!("{} — add yourself to the dialout group: sudo usermod -aG dialout $USER, then log out and back in", e)
                    } else {
                        e.to_string()
                    };
                    // Once per port, not every two seconds forever.
                    if self.complained.insert(p.port_name.clone()) {
                        println!("{}: {}", p.port_name, hint);
                    }
                }
            }
        }

        // Unplugging a board clears a by-hand disconnect, so plugging it back in
        // brings it back the way anyone would expect.
        self.dismissed.retain(|p| present.contains(p));

        // The replug watch runs off this same pass, so nothing has to be opened for it.
        // A board unplugged and back inside one 2 s pass is missed, which is why the
        // page asks for a deliberate unplug rather than a tap.
        if let Some(w) = self.identify.as_mut() {
            let now = now_ms();
            let pairs: Vec<(String, String)> =
                boards.iter().map(|b| (b.key.clone(), b.port.clone())).collect();
            w.step(now, &pairs);
            if w.found.is_none() && w.expired(now) {
                self.identify = None;
            }
        }
        // Plugging or unplugging a board that was never opened changes this list and
        // nothing else, so without comparing it the page is not told and the operator
        // watches a stale list. It is the whole point of the identify flow.
        let before = Self::fingerprint(&self.boards);
        self.boards = boards;
        if Self::fingerprint(&self.boards) != before {
            let _ = self.tx.send(Event::Ports);
        }

        let gone: Vec<String> = self.open.keys().filter(|k| !seen.contains(k)).cloned().collect();
        for k in gone {
            println!("{} unplugged", k);
            self.close(&k);
        }
    }

    fn spawn(
        &mut self,
        key: String,
        port_name: String,
        usb: String,
        port: Box<dyn serialport::SerialPort>,
    ) {
        let reader = match port.try_clone() {
            Ok(r) => r,
            Err(e) => {
                println!("{}: {}", port_name, e);
                return;
            }
        };
        let alive = Arc::new(Mutex::new(true));
        let status = Arc::new(Mutex::new(String::from("open")));
        let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let writer = Some(Arc::new(Mutex::new(port)));

        let tx = self.tx.clone();
        let thread_key = key.clone();
        let thread_alive = alive.clone();
        let thread_status = status.clone();
        let thread_error = error.clone();
        let mut reader = reader;
        let handle = std::thread::spawn(move || {
            let mut framer = Framer::new();
            let mut buf = [0u8; 4096];
            loop {
                if !*thread_alive.lock().unwrap() {
                    return;
                }
                match reader.read(&mut buf) {
                    Ok(0) => {}
                    Ok(n) => {
                        let t = now_ms();
                        for line in framer.push(&buf[..n]) {
                            let _ = tx.send(Event::Line {
                                key: thread_key.clone(),
                                t_ms: t,
                                text: line,
                            });
                        }
                    }
                    Err(ref e) if e.kind() == ErrorKind::TimedOut => {}
                    Err(e) => {
                        // Unplugged, or yanked mid-write. Say so where poll() can see it,
                        // otherwise the entry sits in the map and is never reopened.
                        *thread_status.lock().unwrap() = "error".to_string();
                        *thread_error.lock().unwrap() = Some(e.to_string());
                        let _ = tx.send(Event::Ports);
                        return;
                    }
                }
            }
        });

        println!("{} on {} (USB {})", key, port_name, usb);
        self.open.insert(
            key.clone(),
            Open { port: port_name, usb, writer, alive, status, error, handle: Some(handle) },
        );

        // Ask who this is straight away. Opening the port usually resets an ESP32
        // through the USB bridge's DTR line, so the boot header often arrives by
        // itself, but a board that does not reset would stay unidentified for 30 s.
        let _ = self.send(&key, "#GET\n");
        let _ = self.tx.send(Event::Ports);
    }

    #[cfg(test)]
    pub fn pretend_open(&mut self, key: &str, port: &str) {
        self.keys.map.insert(port.to_string(), key.to_string());
        self.open.insert(
            key.to_string(),
            Open {
                port: port.to_string(),
                usb: "10c4:ea60".into(),
                writer: None,
                alive: Arc::new(Mutex::new(false)),
                status: Arc::new(Mutex::new("open".into())),
                error: Arc::new(Mutex::new(None)),
                handle: None,
            },
        );
    }
}

const PROBE_SECS: u64 = 5;
pub const PROBE_LINES: usize = 20;
pub const PROBE_CHARS: usize = 200;

// Listen to a board for five seconds and say nothing to it. Opening the port still
// pulses DTR, so an ESP32 on the other end probably reboots; that is the price of
// finding out what an unmarked board is, and it is less than sending #GET to
// something that might be a ChipSat. Returns every whole line and how many bytes
// arrived: a board can talk without ever finishing a line, and the shortening for the
// page happens after the lines have been read, not before, or a 35-field CSV row
// loses the fields that identify it.
pub fn probe(port: &str) -> Result<(Vec<String>, usize), String> {
    let mut p = serialport::new(port, BAUD)
        .timeout(Duration::from_millis(200))
        .open()
        .map_err(|e| format!("{}: {}", port, e))?;
    let mut framer = Framer::new();
    let mut buf = [0u8; 4096];
    let mut lines: Vec<String> = Vec::new();
    let mut bytes = 0usize;
    let until = std::time::Instant::now() + Duration::from_secs(PROBE_SECS);
    while std::time::Instant::now() < until {
        match p.read(&mut buf) {
            Ok(0) => {}
            Ok(n) => {
                bytes += n;
                for line in framer.push(&buf[..n]) {
                    lines.push(line);
                }
            }
            Err(ref e) if e.kind() == ErrorKind::TimedOut => {}
            Err(e) => return Err(format!("{}: {}", port, e)),
        }
    }
    Ok((lines, bytes))
}

pub fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => s[..i].to_string(),
        None => s.to_string(),
    }
}

// What a board sounds like, from what it said and nothing else. A receiver of ours
// announces itself with #DG,RX and then sends PKT and HB lines. The older CSV
// receiver writes a header row and then 35 fields a line. Bytes that match neither
// are still bytes, so they are not silence.
pub fn looks_like(lines: &[String], bytes: usize) -> &'static str {
    if bytes == 0 {
        return "silent";
    }
    let ours = lines.iter().any(|l| {
        l.starts_with("#DG,RX") || l.starts_with("PKT,") || l.starts_with("HB,")
    });
    if ours {
        return "descent-receiver";
    }
    let csv = lines
        .iter()
        .any(|l| l.starts_with("Latitude_deg,") || l.split(',').count() == 35);
    if csv {
        return "csv-receiver";
    }
    "something-else"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_board_is_remembered_by_its_chip_and_serial_not_its_port() {
        let a = board_key(0x10c4, 0xea60, Some("0001"));
        assert_eq!(a, "10c4:ea60:0001");
        // Same board on another socket is the same board.
        assert_eq!(a, board_key(0x10c4, 0xea60, Some("0001")));
        // A different chip is a different board, whatever port it lands on.
        assert_ne!(a, board_key(0x1a86, 0x55d4, Some("0001")));
        assert_eq!(board_key(0x1a86, 0x55d4, None), "1a86:55d4:-");
    }

    #[test]
    fn a_serial_that_is_not_text_is_shown_as_hex() {
        assert_eq!(readable_serial("0001"), "0001");
        assert_eq!(readable_serial(""), "");
        // An ST-Link style descriptor: raw bytes, unreadable as text.
        assert_eq!(readable_serial("\u{1}\u{2}"), "0102");
        assert_ne!(readable_serial("2\u{fffd}o\u{6}"), "2\u{fffd}o\u{6}");
    }

    #[test]
    fn a_port_is_named_by_its_bridge_not_its_hex_id() {
        assert_eq!(bridge_name(0x1a86, 0x55d4), "CH9102");
        assert_eq!(bridge_name(0x0483, 0x3754), "ST-Link");
        assert_eq!(bridge_name(0x1234, 0x5678), "USB serial");
    }

    fn board_at(port: &str, key: &str, state: &str) -> Board {
        Board {
            port: port.into(),
            usb: "1a86:55d4".into(),
            label: "CH9102".into(),
            serial: "x".into(),
            key: key.into(),
            state: state.into(),
            name: String::new(),
        }
    }

    fn scratch(what: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("dg-{}-{}", what, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn reloaded(dir: &std::path::Path) -> Hub {
        let (tx, _rx) = std::sync::mpsc::channel();
        let mut hub = Hub::new(tx);
        hub.remember_in(dir);
        hub
    }

    #[test]
    fn a_name_with_spaces_survives_being_saved_and_read_back() {
        let dir = scratch("names");
        let (tx, _rx) = std::sync::mpsc::channel();
        let mut hub = Hub::new(tx);
        hub.remember_in(&dir);
        hub.boards = vec![board_at("/dev/ttyACM1", "1a86:55d4:x", "waiting")];
        hub.approve("/dev/ttyACM1").unwrap();
        hub.set_name("/dev/ttyACM1", " Left T-Beam ").unwrap();

        let again = reloaded(&dir);
        assert_eq!(again.names.get("1a86:55d4:x").map(String::as_str), Some("Left T-Beam"));
        assert!(again.approved.contains("1a86:55d4:x"));   // the old lines still load

        // An empty name clears it, and nothing brings it back.
        hub.set_name("/dev/ttyACM1", "").unwrap();
        assert!(reloaded(&dir).names.is_empty());

        assert!(hub.set_name("/dev/ttyACM1", "two\nlines").unwrap_err().contains("one line"));
        assert!(hub.set_name("/dev/ttyUSB9", "nope").unwrap_err().contains("not plugged in"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_settings_file_from_before_names_still_loads() {
        let dir = scratch("oldfile");
        std::fs::write(
            dir.join("descent-ground-boards.txt"),
            "# what DeSCENT Ground may open. One board per line.\nreceiver 10c4:ea60:0001\nignore 1a86:7523:-\n",
        )
        .unwrap();
        let hub = reloaded(&dir);
        assert!(hub.approved.contains("10c4:ea60:0001"));
        assert!(hub.ignored.contains("1a86:7523:-"));
        assert!(hub.names.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter().map(|(k, p)| (k.to_string(), p.to_string())).collect()
    }

    const T0: u128 = 1_790_000_000_000;

    #[test]
    fn the_board_that_goes_away_and_comes_back_is_the_one_the_operator_meant() {
        let mut w = Identify::start(T0, &pairs(&[("a", "/dev/ttyUSB0"), ("b", "/dev/ttyUSB1")]));
        w.step(T0 + 2_000, &pairs(&[("b", "/dev/ttyUSB1")]));
        assert_eq!(w.found, None);
        // Back on another socket, which is the usual way a replug comes back.
        w.step(T0 + 4_000, &pairs(&[("a", "/dev/ttyUSB2"), ("b", "/dev/ttyUSB1")]));
        assert_eq!(w.found.as_deref(), Some("/dev/ttyUSB2"));
        // A later board coming back does not overwrite the first answer.
        w.step(T0 + 6_000, &pairs(&[("a", "/dev/ttyUSB2")]));
        w.step(T0 + 8_000, &pairs(&[("a", "/dev/ttyUSB2"), ("b", "/dev/ttyUSB1")]));
        assert_eq!(w.found.as_deref(), Some("/dev/ttyUSB2"));
    }

    #[test]
    fn two_boards_with_the_same_serial_are_still_told_apart() {
        // Both sockets carry 10c4:ea60:0001, so only the port says which moved.
        let both = pairs(&[("k", "/dev/ttyUSB0"), ("k", "/dev/ttyUSB1")]);
        let mut w = Identify::start(T0, &both);
        w.step(T0 + 2_000, &pairs(&[("k", "/dev/ttyUSB0")]));
        assert_eq!(w.found, None);
        w.step(T0 + 4_000, &both);
        assert_eq!(w.found.as_deref(), Some("/dev/ttyUSB1"));
    }

    #[test]
    fn a_board_that_never_comes_back_is_no_answer_and_the_watch_runs_out() {
        let mut w = Identify::start(T0, &pairs(&[("a", "/dev/ttyUSB0")]));
        w.step(T0 + 2_000, &pairs(&[]));
        assert_eq!(w.found, None);
        assert_eq!(w.seconds_left(T0 + 2_000), 58);
        assert!(!w.expired(T0 + 59_000));
        w.step(T0 + 59_000, &pairs(&[]));
        assert_eq!(w.found, None);
        // After a minute the watch is over, and a replug then is nobody's answer.
        assert!(w.expired(T0 + 60_000));
        assert_eq!(w.seconds_left(T0 + 60_000), 0);
        w.step(T0 + 61_000, &pairs(&[("a", "/dev/ttyUSB0")]));
        assert_eq!(w.found, None);
    }

    #[test]
    fn a_watch_starts_from_what_is_plugged_in_and_a_second_one_forgets_the_first() {
        let (tx, _rx) = std::sync::mpsc::channel();
        let mut hub = Hub::new(tx);
        assert_eq!(hub.identify_state(), (false, None, 0));
        hub.boards = vec![board_at("/dev/ttyACM1", "1a86:55d4:x", "waiting")];
        hub.identify_start();
        let (watching, found, left) = hub.identify_state();
        assert!(watching);
        assert_eq!(found, None);
        assert_eq!(left, 60);

        hub.identify.as_mut().unwrap().found = Some("/dev/ttyACM1".into());
        assert_eq!(hub.identify_state(), (false, Some("/dev/ttyACM1".into()), 0));
        hub.identify_start();
        assert_eq!(hub.identify_state().1, None);
    }

    #[test]
    fn what_a_board_is_is_judged_on_what_it_said() {
        assert_eq!(looks_like(&[], 0), "silent");
        assert_eq!(looks_like(&["#DG,RX,1,sf9".into()], 12), "descent-receiver");
        assert_eq!(looks_like(&["PKT,55,00FF,-50.0,13.75,-12".into()], 28), "descent-receiver");
        assert_eq!(looks_like(&["HB,1,2,3".into()], 8), "descent-receiver");
        assert_eq!(looks_like(&["Latitude_deg,Longitude_deg,Alt_m".into()], 32), "csv-receiver");
        let row = (0..35).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        let n = row.len();
        assert_eq!(looks_like(&[row], n), "csv-receiver");
        // A real CSV row is longer than the 200 characters the page is shown, so the
        // counting has to happen before anything is shortened.
        let wide = (0..35).map(|i| format!("{}.000000", i)).collect::<Vec<_>>().join(",");
        assert!(wide.len() > PROBE_CHARS);
        let n = wide.len();
        assert_eq!(looks_like(&[wide.clone()], n), "csv-receiver");
        assert_eq!(looks_like(&[clip(&wide, PROBE_CHARS)], n), "something-else");
        assert_eq!(clip("abcdef", 3), "abc");
        assert_eq!(clip("ab", 8), "ab");
        assert_eq!(looks_like(&["ets Jun  8 2016 00:22:57".into()], 24), "something-else");
        // Bytes that never finished a line are not silence.
        assert_eq!(looks_like(&[], 17), "something-else");
    }

    #[test]
    fn a_five_second_listen_keeps_everything_else_off_the_port() {
        let (tx, _rx) = std::sync::mpsc::channel();
        let mut hub = Hub::new(tx);
        hub.boards = vec![board_at("/dev/ttyACM1", "1a86:55d4:x", "waiting")];
        hub.begin_probe("/dev/ttyACM1").unwrap();
        assert!(hub.begin_probe("/dev/ttyACM1").unwrap_err().contains("already being listened to"));
        assert!(hub.release_for_flash("/dev/ttyACM1").unwrap_err().contains("listened to"));
        hub.end_probe("/dev/ttyACM1");
        hub.begin_probe("/dev/ttyACM1").unwrap();
        hub.end_probe("/dev/ttyACM1");

        // An open receiver is not something to listen in on, and neither is a flash.
        hub.pretend_open("rx1", "/dev/ttyACM1");
        assert!(hub.begin_probe("/dev/ttyACM1").unwrap_err().contains("open as a receiver"));
        hub.close("rx1");
        hub.release_for_flash("/dev/ttyACM1").unwrap();
        assert!(hub.begin_probe("/dev/ttyACM1").unwrap_err().contains("being flashed"));
        assert!(hub.begin_probe("/dev/ttyUSB9").unwrap_err().contains("not plugged in"));
    }

    #[test]
    fn nothing_is_a_receiver_until_it_is_said_to_be() {
        let (tx, _rx) = std::sync::mpsc::channel();
        let mut hub = Hub::new(tx);
        hub.boards = vec![board_at("/dev/ttyACM1", "1a86:55d4:x", "waiting")];
        assert!(!hub.approved.contains("1a86:55d4:x"));

        hub.approve("/dev/ttyACM1").unwrap();
        assert!(hub.approved.contains("1a86:55d4:x"));

        hub.ignore("/dev/ttyACM1").unwrap();
        assert!(!hub.approved.contains("1a86:55d4:x"));
        assert!(hub.ignored.contains("1a86:55d4:x"));

        // A board that is not plugged in cannot be decided about.
        assert!(hub.approve("/dev/ttyUSB9").unwrap_err().contains("not plugged in"));
    }

    #[test]
    fn a_by_hand_disconnect_is_not_undone_two_seconds_later() {
        let (tx, _rx) = std::sync::mpsc::channel();
        let mut hub = Hub::new(tx);
        hub.pretend_open("rx1", "/dev/ttyUSB0");
        hub.dismiss("rx1");
        assert!(hub.dismissed.contains("/dev/ttyUSB0"));
        // poll() skips a dismissed port, and only a replug clears it.
        hub.dismissed.retain(|p| p == "/dev/ttyUSB0");
        assert!(hub.dismissed.contains("/dev/ttyUSB0"));
    }

    #[test]
    fn each_port_keeps_its_own_key_so_two_receivers_never_merge() {
        let mut keys = Keys::new();
        let a = keys.key_for("/dev/ttyUSB0");
        let b = keys.key_for("/dev/ttyUSB1");
        assert_eq!(a, "rx1");
        assert_eq!(b, "rx2");
        assert_eq!(keys.key_for("/dev/ttyUSB0"), "rx1");   // a replug keeps its key
        assert_ne!(a, b);
    }

    #[test]
    fn writing_to_a_port_that_is_gone_is_an_error_not_a_panic() {
        let (tx, _rx) = std::sync::mpsc::channel();
        let mut hub = Hub::new(tx);
        let err = hub.send("rx9", "#GET\n").unwrap_err();
        assert!(err.contains("rx9"));
    }
}
