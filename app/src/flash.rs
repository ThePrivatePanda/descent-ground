// Flashing a receiver. These are the only receivers the team has, so the board's
// existing firmware is read off and saved before anything is erased.
use crate::json::{esc, int_field, str_field};
use crate::server::Ctx;
use espflash::connection::{Connection, ResetAfterOperation, ResetBeforeOperation};
use espflash::flasher::Flasher;
use espflash::target::ProgressCallbacks;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

include!(concat!(env!("OUT_DIR"), "/firmware.rs"));

const MIN_IMAGE: usize = 200_000;
const MAX_IMAGE: usize = 4 * 1024 * 1024;

// We write at 0x0, so the file has to be a merged image: the first 4 kB are padding
// and the bootloader's 0xE9 magic sits at 0x1000. A bare app image also starts with
// 0xE9, and writing one at 0x0 leaves a board that needs a cable and a rescue, so it
// is named and refused rather than accepted.
const BOOTLOADER_AT: usize = 0x1000;

pub fn check_image(data: &[u8]) -> Result<(), String> {
    if data.len() < MIN_IMAGE {
        return Err(format!("that file is too small for a receiver image ({} bytes)", data.len()));
    }
    if data.len() > MAX_IMAGE {
        return Err(format!("that file is larger than the flash ({} bytes)", data.len()));
    }
    if data.get(BOOTLOADER_AT) == Some(&0xE9) {
        return Ok(());
    }
    if data.first() == Some(&0xE9) {
        return Err(String::from(
            "that is an app image on its own. It needs merging with the bootloader and partitions first (esptool merge_bin).",
        ));
    }
    Err(String::from("that file has no esp32 bootloader at 0x1000, so it is not a merged image"))
}

// Every port is offered, including boards that are receiving right now: reflashing a
// working receiver is the normal case, not an exception.
pub fn candidates_from(hub: &crate::serial::Hub, found: &[String]) -> Vec<String> {
    let mut v: Vec<String> = found.iter().filter(|p| !hub.is_flashing(p)).cloned().collect();
    v.sort();
    v
}

// Only boards the app is already reading, or ones the operator has explicitly
// allowed. A port we have never been told to touch is never offered for flashing:
// writing firmware to somebody's ChipSat is not a recoverable mistake.
pub fn candidate_ports(hub: &crate::serial::Hub) -> Vec<String> {
    let mut found: Vec<String> = hub.ports().into_iter().map(|p| p.port).collect();
    let live: Vec<String> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.port_name)
        .collect();
    for p in hub.allowed_ports() {
        if live.contains(&p) && !found.contains(&p) {
            found.push(p);
        }
    }
    candidates_from(hub, &found)
}

// What the operator is about to overwrite, so nobody flashes the wrong board.
pub fn candidates_json(hub: &crate::serial::Hub) -> String {
    let open = hub.ports();
    let items: Vec<String> = candidate_ports(hub)
        .into_iter()
        .map(|port| {
            let key = open.iter().find(|p| p.port == port).map(|p| p.key.clone());
            format!(
                "{{\"port\":\"{}\",\"key\":{}}}",
                esc(&port),
                match key {
                    Some(k) => format!("\"{}\"", esc(&k)),
                    None => String::from("null"),
                }
            )
        })
        .collect();
    format!(
        "{{\"candidates\":[{}],\"firmware\":{}}}",
        items.join(","),
        if IMAGE.is_some() { format!("\"{}\"", esc(IMAGE_NAME)) } else { String::from("null") }
    )
}

struct Progress<'a> {
    broadcast: &'a crate::ws::Broadcast,
    total: usize,
}

impl ProgressCallbacks for Progress<'_> {
    fn init(&mut self, _addr: u32, total: usize) {
        self.total = total;
        self.note(0, "writing");
    }
    fn update(&mut self, current: usize) {
        let pct = if self.total == 0 { 0 } else { current * 100 / self.total };
        self.note(pct as u32, "writing");
    }
    fn verifying(&mut self) {
        self.note(100, "verifying");
    }
    fn finish(&mut self, _skipped: bool) {
        self.note(100, "done");
    }
}

impl Progress<'_> {
    fn note(&self, pct: u32, what: &str) {
        self.broadcast.send(&format!(
            "{{\"type\":\"flash\",\"pct\":{},\"note\":\"{}\"}}",
            pct, what
        ));
    }
}

fn open_flasher(port: &str) -> Result<Flasher, String> {
    let serial = serialport::new(port, 115_200)
        .timeout(Duration::from_secs(3))
        .open_native()
        .map_err(|e| format!("{}: {}", port, e))?;
    let info = serialport::UsbPortInfo {
        vid: 0,
        pid: 0,
        serial_number: None,
        manufacturer: None,
        product: None,
    };
    let connection = Connection::new(
        serial,
        info,
        ResetAfterOperation::HardReset,
        ResetBeforeOperation::DefaultReset,
        115_200,
    );
    Flasher::connect(connection, true, true, false, None, None)
        .map_err(|e| format!("could not talk to the board on {}: {}", port, e))
}

pub fn backup(port: &str, dir: &Path) -> Result<PathBuf, String> {
    let mut flasher = open_flasher(port)?;
    let size = flasher
        .flash_detect()
        .map_err(|e| format!("could not read the flash size: {}", e))?
        .unwrap_or(espflash::flasher::FlashSize::_4Mb);
    let bytes = size.size();
    let name = format!(
        "descent-ground-backup-{}-{}.bin",
        port.rsplit('/').next().unwrap_or("port"),
        humantime::format_rfc3339_seconds(std::time::SystemTime::now())
            .to_string()
            .replace(':', "-")
            .replace('Z', "")
    );
    let path = dir.join(name);
    flasher
        .read_flash(0, bytes, 0x1000, 64, path.clone())
        .map_err(|e| format!("could not read the board's firmware: {}", e))?;
    let written = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if written < bytes as u64 {
        return Err(format!(
            "the backup is short: {} of {} bytes. Nothing was erased.",
            written, bytes
        ));
    }
    Ok(path)
}

pub fn write_image(port: &str, image: &[u8], broadcast: &crate::ws::Broadcast) -> Result<(), String> {
    let mut flasher = open_flasher(port)?;
    let mut progress = Progress { broadcast, total: image.len() };
    flasher
        .write_bin_to_flash(0, image, &mut progress)
        .map_err(|e| format!("writing failed: {}", e))
}

// POST /api/flash  {"port":"/dev/ttyUSB0","sf":12}         the embedded image
//                  {"port":"...","sf":12,"image":"/path"}  one the operator built
pub fn handle_request(body: &str, ctx: &Arc<Ctx>) -> String {
    let port = match str_field(body, "port") {
        Some(p) => p,
        None => return err("no port in the request"),
    };
    let sf = int_field(body, "sf").unwrap_or(9);
    if !(7..=12).contains(&sf) {
        return err("spreading factor must be between 7 and 12");
    }

    let owned: Vec<u8>;
    let image: &[u8] = match str_field(body, "image") {
        Some(path) => {
            owned = match std::fs::read(&path) {
                Ok(d) => d,
                Err(e) => return err(&format!("cannot read {}: {}", path, e)),
            };
            &owned
        }
        None => match IMAGE {
            Some(i) => i,
            None => return err("this build has no receiver firmware in it, so point it at a .bin"),
        },
    };
    if let Err(e) = check_image(image) {
        return err(&e);
    }

    if let Err(e) = ctx.hub.lock().unwrap().release_for_flash(&port) {
        return err(&e);
    }

    let result = backup(&port, &ctx.dir).and_then(|saved| {
        println!("saved the board's existing firmware to {}", saved.display());
        ctx.broadcast.send(&format!(
            "{{\"type\":\"flash\",\"pct\":0,\"note\":\"saved {}\"}}",
            esc(&saved.to_string_lossy())
        ));
        write_image(&port, image, &ctx.broadcast).map(|()| saved)
    });

    ctx.hub.lock().unwrap().take_back(&port);

    match result {
        Ok(saved) => {
            // The board is rebooting. poll() reopens the port; the spreading factor
            // goes out once its boot header has arrived, because a command sent to a
            // booting board is lost.
            let hub = ctx.hub.clone();
            let port2 = port.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(6));
                let key = hub.lock().unwrap().ports().into_iter()
                    .find(|p| p.port == port2)
                    .map(|p| p.key);
                if let Some(k) = key {
                    let _ = hub.lock().unwrap().send(&k, &format!("#SET,sf,{}\n", sf));
                }
            });
            format!(
                "{{\"ok\":true,\"backup\":\"{}\",\"sf\":{}}}",
                esc(&saved.to_string_lossy()),
                sf
            )
        }
        Err(e) => err(&e),
    }
}

fn err(msg: &str) -> String {
    format!("{{\"ok\":false,\"error\":\"{}\"}}", esc(msg))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_open_receiver_is_still_a_flash_candidate_because_that_is_the_normal_case() {
        // Discovery opens every board it recognises, so the one the operator wants to
        // reflash is always already a receiver. Listing only closed ports would list none.
        let (tx, _rx) = std::sync::mpsc::channel();
        let mut hub = crate::serial::Hub::new(tx);
        hub.pretend_open("rx1", "/dev/ttyUSB0");
        let c = candidates_from(&hub, &["/dev/ttyUSB0".to_string(), "/dev/ttyUSB1".to_string()]);
        assert_eq!(c, vec!["/dev/ttyUSB0".to_string(), "/dev/ttyUSB1".to_string()]);
    }

    #[test]
    fn releasing_a_port_for_a_flash_closes_it_and_keeps_discovery_off_it() {
        let (tx, _rx) = std::sync::mpsc::channel();
        let mut hub = crate::serial::Hub::new(tx);
        hub.pretend_open("rx1", "/dev/ttyUSB0");
        hub.release_for_flash("/dev/ttyUSB0").unwrap();
        assert!(hub.ports().is_empty());
        let e = hub.release_for_flash("/dev/ttyUSB0").unwrap_err();
        assert!(e.contains("already being flashed"));
        hub.take_back("/dev/ttyUSB0");
        hub.release_for_flash("/dev/ttyUSB0").unwrap();
    }

    #[test]
    fn an_operator_supplied_image_must_be_a_merged_one() {
        let mut merged = vec![0xFF; 300_000];
        merged[BOOTLOADER_AT] = 0xE9;
        assert!(check_image(&merged).is_ok());

        // An app image on its own: 0xE9 at the front, nothing at 0x1000.
        let mut app = vec![0x00; 300_000];
        app[0] = 0xE9;
        assert!(check_image(&app).unwrap_err().contains("merging"));

        assert!(check_image(&[0x00; 300_000]).unwrap_err().contains("0x1000"));
        assert!(check_image(&[0xE9; 10]).unwrap_err().contains("too small"));
    }

    #[test]
    fn the_image_we_ship_passes_our_own_check() {
        match IMAGE {
            Some(i) => check_image(i).expect("the embedded firmware must be flashable"),
            None => panic!("this build has no embedded firmware; build the merged image first"),
        }
    }
}
