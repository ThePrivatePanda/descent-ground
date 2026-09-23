// One thread per open port. Ports are found by their USB bridge, which is the only
// thing visible before the board says anything. Our T-Beams use a CP2102; the other
// ids are here because newer boards ship with them.
use crate::framing::Framer;
use crate::logfile::now_ms;
use std::collections::{HashMap, HashSet};
use std::io::{ErrorKind, Read, Write};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const BAUD: u32 = 115200;

// Only the bridge our own T-Beams use is opened without being asked. Opening a port
// toggles DTR, which resets an ESP32, so a guess here costs somebody their board:
// a ChipSat carries a CH9102 and had been reset by this list when it held every
// ESP32-ish id. Anything else is listed for the operator and left alone.
const AUTO_OPEN: &[(u16, u16)] = &[
    (0x10c4, 0xea60),   // Silicon Labs CP2102, the T-Beams we have
];

pub fn opens_by_itself(vid: u16, pid: u16) -> bool {
    AUTO_OPEN.contains(&(vid, pid))
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

// A port we can see but have not touched.
#[derive(Clone)]
pub struct OtherPort {
    pub port: String,
    pub usb: String,
    pub label: String,
}

#[derive(Clone)]
pub struct PortInfo {
    pub key: String,
    pub port: String,
    pub usb: String,
    pub status: String,
    pub error: Option<String>,
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
    allowed: HashSet<String>,      // ports the operator told us to use
    others: Vec<OtherPort>,        // seen, deliberately not opened
    allow_file: Option<std::path::PathBuf>,
}

impl Hub {
    pub fn new(tx: Sender<Event>) -> Self {
        Hub {
            tx,
            keys: Keys::new(),
            open: HashMap::new(),
            flashing: HashSet::new(),
            complained: HashSet::new(),
            allowed: HashSet::new(),
            others: Vec::new(),
            allow_file: None,
        }
    }

    // Ports the operator picked last time. Remembered so the field is still no-click
    // after the first time, for a board whose bridge we do not recognise.
    pub fn remember_allowed_in(&mut self, dir: &std::path::Path) {
        let f = dir.join("descent-ground-ports.txt");
        if let Ok(text) = std::fs::read_to_string(&f) {
            for line in text.lines() {
                let line = line.trim();
                if !line.is_empty() && !line.starts_with('#') {
                    self.allowed.insert(line.to_string());
                }
            }
        }
        self.allow_file = Some(f);
    }

    pub fn allow(&mut self, port: &str) {
        self.allowed.insert(port.to_string());
        self.complained.remove(port);
        if let Some(f) = &self.allow_file {
            let mut text = String::from("# ports you told DeSCENT Ground to use as receivers\n");
            let mut all: Vec<&String> = self.allowed.iter().collect();
            all.sort();
            for p in all {
                text.push_str(p);
                text.push('\n');
            }
            let _ = std::fs::write(f, text);
        }
        let _ = self.tx.send(Event::Ports);
    }

    pub fn others(&self) -> Vec<OtherPort> {
        self.others.clone()
    }

    pub fn allowed_ports(&self) -> Vec<String> {
        let mut v: Vec<String> = self.allowed.iter().cloned().collect();
        v.sort();
        v
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
        let mut others: Vec<OtherPort> = Vec::new();
        for p in found {
            let (usb, label, auto) = match &p.port_type {
                serialport::SerialPortType::UsbPort(u) => (
                    format!("{:04x}:{:04x}", u.vid, u.pid),
                    bridge_name(u.vid, u.pid).to_string(),
                    opens_by_itself(u.vid, u.pid),
                ),
                _ => continue,
            };
            if !auto && !self.allowed.contains(&p.port_name) {
                // Somebody else's board until we are told otherwise. Not opened, because
                // opening it would reset it.
                others.push(OtherPort { port: p.port_name.clone(), usb, label });
                continue;
            }
            if self.flashing.contains(&p.port_name) {
                continue;   // a flash owns this port; keep out of its way
            }
            let key = self.keys.key_for(&p.port_name);
            seen.push(key.clone());
            if let Some(o) = self.open.get(&key) {
                if o.status.lock().map(|s| s.as_str() == "open").unwrap_or(false) {
                    continue;
                }
                self.close(&key);   // its reader died; fall through and open it again
            }
            match serialport::new(&p.port_name, BAUD).timeout(Duration::from_millis(200)).open() {
                Ok(port) => {
                    self.complained.remove(&p.port_name);
                    self.spawn(key, p.port_name, usb, port);
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
        self.others = others;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_our_own_t_beam_bridge_is_opened_without_being_asked() {
        assert!(opens_by_itself(0x10c4, 0xea60));    // CP2102, the T-Beams we have
        // The ChipSat's bridge. Opening it resets the board, so it is never automatic.
        assert!(!opens_by_itself(0x1a86, 0x55d4));
        assert!(!opens_by_itself(0x0483, 0x3754));   // ST-Link on a ChipSat
        assert!(!opens_by_itself(0x303a, 0x1001));   // some other ESP32
        assert!(!opens_by_itself(0x046d, 0xc52b));   // a Logitech receiver
    }

    #[test]
    fn a_port_is_named_by_its_bridge_not_its_hex_id() {
        assert_eq!(bridge_name(0x1a86, 0x55d4), "CH9102");
        assert_eq!(bridge_name(0x0483, 0x3754), "ST-Link");
        assert_eq!(bridge_name(0x1234, 0x5678), "USB serial");
    }

    #[test]
    fn an_allowed_port_is_no_longer_somebody_elses() {
        let (tx, _rx) = std::sync::mpsc::channel();
        let mut hub = Hub::new(tx);
        assert!(!hub.allowed.contains("/dev/ttyACM0"));
        hub.allow("/dev/ttyACM0");
        assert!(hub.allowed.contains("/dev/ttyACM0"));
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
