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
    approved: HashSet<String>,     // board keys the operator said are receivers
    ignored: HashSet<String>,      // board keys to leave alone for good
    dismissed: HashSet<String>,    // device paths disconnected by hand, until replug
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
                    _ => {}
                }
            }
        }
        self.store = Some(f);
    }

    fn save(&self) {
        let Some(f) = &self.store else { return };
        let mut text = String::from("# what DeSCENT Ground may open. One board per line.\n");
        let mut rows: Vec<String> = self
            .approved
            .iter()
            .map(|k| format!("receiver {}", k))
            .chain(self.ignored.iter().map(|k| format!("ignore {}", k)))
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
        self.save();
        let _ = self.tx.send(Event::Ports);
        Ok(())
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
            let serial = u.serial_number.clone().unwrap_or_default();
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
            boards.push(Board {
                port: p.port_name.clone(),
                usb: usb.clone(),
                label,
                serial,
                key,
                state: state.to_string(),
            });

            if state != "receiver" || self.flashing.contains(&p.port_name) {
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
        self.boards = boards;

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
        }
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
