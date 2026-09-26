// Reading a ChipSat's flight software off the board and writing it back, over an ST-Link.
// This used to be a Python tool driving OpenOCD from another checkout; nothing on the far
// side of it is more than SWD, so the app does it itself and assumes nothing but a probe.
use crate::json::esc;
use crate::ws::Broadcast;
use probe_rs::config::MemoryRegion;
use probe_rs::flashing::{DownloadOptions, FlashProgress, ProgressEvent, ProgressOperation};
use probe_rs::probe::list::{Accessibility, Lister, ProbeListItem};
use probe_rs::{MemoryInterface, Permissions, Session};
use std::io::Write;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

// The ChipSat's MCU is a Wio-E5 module, so an STM32WLE5JC (hardware.md section 2).
// probe-rs has no autodetection for ST parts, so the name is fixed rather than guessed.
// Only the flash size differs across the 13 WLE5 variants, and that is read from the
// target's memory map below rather than from this name.
const CHIP: &str = "STM32WLE5JCIx";

// 256 kB over SWD is not quick. Small enough that the bar moves, large enough that the
// per-read overhead is not what we are waiting for.
const READ_CHUNK: u64 = 32 * 1024;

const HALT_TIMEOUT: Duration = Duration::from_millis(500);

// An attached debug probe: the serial number to ask for it by, and something to show.
pub struct Probe {
    pub serial: String,
    pub kind: String,
}

// Probes this user cannot open are listed too. Otherwise "nothing is plugged in" and
// "the udev rule is missing" look the same from the dashboard.
pub fn probes() -> Vec<Probe> {
    attached().iter().map(|item| describe(item)).collect()
}

fn attached() -> Vec<ProbeListItem> {
    Lister::new().list_all_with_access()
}

fn describe(item: &ProbeListItem) -> Probe {
    Probe {
        serial: item.info.serial_number.clone().unwrap_or_default(),
        kind: item.info.identifier.clone(),
    }
}

// None means "the one that is plugged in". Picking for the operator when there are two
// would write firmware to somebody else's board, so it is an error instead.
fn pick(list: &[Probe], want: Option<&str>) -> Result<usize, String> {
    if list.is_empty() {
        return Err(String::from("no debug probe is attached: plug the ST-Link in"));
    }
    match want {
        Some(serial) => list.iter().position(|p| p.serial == serial).ok_or_else(|| {
            format!("no debug probe with serial {} is attached. Attached: {}", serial, names(list))
        }),
        None if list.len() == 1 => Ok(0),
        None => Err(format!(
            "{} debug probes are attached, so say which one: {}",
            list.len(),
            names(list)
        )),
    }
}

fn names(list: &[Probe]) -> String {
    list.iter()
        .map(|p| {
            if p.serial.is_empty() {
                format!("{} (no serial number)", p.kind)
            } else {
                format!("{} ({})", p.kind, p.serial)
            }
        })
        .collect::<Vec<String>>()
        .join(", ")
}

fn open(probe: Option<&str>) -> Result<Session, String> {
    let attached = attached();
    let list: Vec<Probe> = attached.iter().map(describe).collect();
    let which = pick(&list, probe)?;
    if attached[which].accessibility == Accessibility::PermissionDenied {
        return Err(format!(
            "{} is plugged in but this user cannot open it, usually the missing udev rule for ST-Link probes",
            list[which].kind
        ));
    }
    let selected = || {
        attached[which]
            .info
            .open()
            .map_err(|e| format!("could not open {}: {}", list[which].kind, e))
    };
    // A ChipSat asleep in Stop2 has its debug block powered down and does not answer a
    // plain attach; holding NRST while connecting is the usual way through that. NRST is
    // on J1.8 of the pogo header, so it depends on the clip carrying that pin — not tried
    // yet, hence the first error is the one reported if both fail.
    let first = match selected()?.attach(CHIP, Permissions::default()) {
        Ok(session) => return Ok(session),
        Err(e) => e,
    };
    match selected()?.attach_under_reset(CHIP, Permissions::default()) {
        Ok(session) => Ok(session),
        Err(_) => Err(format!(
            "could not attach to the {} through {}: {}",
            CHIP, list[which].kind, first
        )),
    }
}

// Where the flight software lives, from the chip database rather than from 0x08000000 and
// a size written down here: a smaller WLE5 would otherwise be read short and written past.
// probe-rs marks the WLE5's BANK_1 write: false (its targets/STM32WL_Series.yaml), which is
// about plain memory writes and not about the flash algorithm, so access is not a filter.
fn main_flash(map: &[MemoryRegion]) -> Result<Range<u64>, String> {
    let mut best: Option<Range<u64>> = None;
    for region in map {
        let MemoryRegion::Nvm(nvm) = region else { continue };
        if nvm.is_alias || nvm.range.end <= nvm.range.start {
            continue;
        }
        let size = nvm.range.end - nvm.range.start;
        let better = match &best {
            None => true,
            Some(b) => {
                let had = b.end - b.start;
                size > had || (size == had && nvm.range.start < b.start)
            }
        };
        if better {
            best = Some(nvm.range.clone());
        }
    }
    best.ok_or_else(|| format!("{} has no flash region in probe-rs's chip database", CHIP))
}

// descent-ground-fsw-rx1-2026-09-25T19-30-00.bin, the same shape as the log file names so
// the two sort together in a field directory.
fn backup_name(name_hint: &str, at: SystemTime) -> String {
    let stamp = humantime::format_rfc3339_seconds(at)
        .to_string()
        .replace(':', "-")
        .replace('Z', "");
    format!("descent-ground-fsw-{}-{}.bin", tidy(name_hint), stamp)
}

// The hint is usually a port name or a board key, and both have to survive becoming part
// of a file name.
fn tidy(hint: &str) -> String {
    let last = hint.rsplit('/').find(|p| !p.is_empty()).unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    if cleaned.is_empty() {
        String::from("board")
    } else {
        cleaned
    }
}

fn pct_of(done: u64, total: u64) -> u32 {
    if total == 0 {
        return 0;
    }
    (done.min(total) * 100 / total) as u32
}

fn kb_note(what: &str, done: u64, total: u64) -> String {
    format!("{}, {} of {} kB", what, done / 1024, total / 1024)
}

fn frame(pct: u32, note: &str) -> String {
    format!("{{\"type\":\"flash\",\"pct\":{},\"note\":\"{}\"}}", pct, esc(note))
}

fn say(broadcast: &Broadcast, pct: u32, note: &str) {
    broadcast.send(&frame(pct, note));
}

// The bytes that are on the board, which is not the same thing as a fresh build of the
// flight repo. This is the image write_firmware puts back, so a short read is a failure
// rather than a smaller file.
pub fn save_firmware(
    probe: Option<&str>,
    dir: &Path,
    name_hint: &str,
    broadcast: &Broadcast,
) -> Result<PathBuf, String> {
    let mut session = open(probe)?;
    let flash = main_flash(&session.target().memory_map)?;
    let path = dir.join(backup_name(name_hint, SystemTime::now()));
    match read_flash_into(&mut session, &flash, &path, broadcast) {
        Ok(()) => Ok(path),
        Err(e) => {
            // Part of an image under a name that says it is one is worse than no file:
            // somebody would write it back.
            let _ = std::fs::remove_file(&path);
            Err(e)
        }
    }
}

fn read_flash_into(
    session: &mut Session,
    flash: &Range<u64>,
    path: &Path,
    broadcast: &Broadcast,
) -> Result<(), String> {
    let total = flash.end - flash.start;
    let mut out = std::fs::File::create(path)
        .map_err(|e| format!("cannot write {}: {}", path.display(), e))?;

    let mut core = session.core(0).map_err(|e| format!("could not reach the core: {}", e))?;
    // Halted while it is read: the flight software writes its own flash, and half of one
    // write with half of the next is not an image anyone can put back.
    core.halt(HALT_TIMEOUT).map_err(|e| format!("could not halt the board: {}", e))?;

    let mut buf = vec![0u8; READ_CHUNK as usize];
    let mut done = 0u64;
    while done < total {
        let n = READ_CHUNK.min(total - done) as usize;
        let at = flash.start + done;
        core.read(at, &mut buf[..n])
            .map_err(|e| format!("could not read the board's firmware at {:#x}: {}", at, e))?;
        out.write_all(&buf[..n])
            .map_err(|e| format!("cannot write {}: {}", path.display(), e))?;
        done += n as u64;
        say(broadcast, pct_of(done, total), &kb_note("saving the flight software", done, total));
    }
    let _ = core.run();   // left as it was found; the caller resets when it means to
    drop(out);

    let written = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if written < total {
        return Err(format!(
            "the saved firmware is short: {} of {} bytes. Nothing was erased.",
            written, total
        ));
    }
    Ok(())
}

// Writing past the end of flash is something the loader would refuse on its own, but the
// operator hears about it before anything is erased rather than after.
fn fits(len: usize, region: u64) -> Result<(), String> {
    if len == 0 {
        return Err(String::from("that image is empty, so there is nothing to write"));
    }
    if len as u64 > region {
        return Err(format!(
            "that image is {} bytes and the flash on the board is {}",
            len, region
        ));
    }
    Ok(())
}

pub fn write_firmware(probe: Option<&str>, image: &[u8], broadcast: &Broadcast) -> Result<(), String> {
    let mut session = open(probe)?;
    let flash = main_flash(&session.target().memory_map)?;
    fits(image.len(), flash.end - flash.start)?;

    let mut loader = session.target().flash_loader();
    loader
        .add_data(flash.start, image)
        .map_err(|e| format!("cannot stage the image for {:#x}: {}", flash.start, e))?;

    let mut options = DownloadOptions::default();
    options.keep_unwritten_bytes = false;
    options.verify = false;   // done below instead, because that one can name an address
    options.progress = writing_frames(broadcast);
    loader
        .commit(&mut session, options)
        .map_err(|e| format!("writing the flight software failed: {}", e))?;

    verify(&mut session, flash.start, image, broadcast)
}

fn writing_frames(broadcast: &Broadcast) -> FlashProgress<'_> {
    let mut total = 0u64;
    let mut written = 0u64;
    FlashProgress::new(move |event| match event {
        ProgressEvent::AddProgressBar { operation: ProgressOperation::Program, total: size } => {
            total = size.unwrap_or(0);
        }
        ProgressEvent::Started(ProgressOperation::Erase) => {
            say(broadcast, 0, "erasing the flash");
        }
        ProgressEvent::Progress { operation: ProgressOperation::Program, size, .. } => {
            written += size;
            say(
                broadcast,
                pct_of(written, total),
                &kb_note("writing the flight software", written, total),
            );
        }
        _ => {}
    })
}

// probe-rs can verify as part of the write, but it only answers yes or no. Reading it
// back here costs the same and names the first byte that differs, which is the difference
// between trying again and knowing the image never landed.
fn verify(session: &mut Session, start: u64, image: &[u8], broadcast: &Broadcast) -> Result<(), String> {
    let mut core = session.core(0).map_err(|e| format!("could not reach the core: {}", e))?;
    let total = image.len() as u64;
    let mut buf = vec![0u8; READ_CHUNK as usize];
    let mut done = 0u64;
    while done < total {
        let n = READ_CHUNK.min(total - done) as usize;
        let at = start + done;
        core.read(at, &mut buf[..n])
            .map_err(|e| format!("could not read the flash back at {:#x}: {}", at, e))?;
        let want = &image[done as usize..done as usize + n];
        if let Some(off) = first_difference(want, &buf[..n]) {
            return Err(format!(
                "the flash does not match the image at {:#x}: wrote {:#04x}, read back {:#04x}",
                at + off as u64,
                want[off],
                buf[off]
            ));
        }
        done += n as u64;
        say(broadcast, pct_of(done, total), &kb_note("checking what was written", done, total));
    }
    Ok(())   // still halted: reset_and_run is what starts it
}

fn first_difference(want: &[u8], got: &[u8]) -> Option<usize> {
    want.iter().zip(got).position(|(a, b)| a != b)
}

pub fn reset_and_run(probe: Option<&str>) -> Result<(), String> {
    let mut session = open(probe)?;
    let mut core = session.core(0).map_err(|e| format!("could not reach the core: {}", e))?;
    core.reset().map_err(|e| format!("could not reset the board: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use probe_rs::config::{NvmRegion, RamRegion};

    fn probe(kind: &str, serial: &str) -> Probe {
        Probe { serial: String::from(serial), kind: String::from(kind) }
    }

    fn nvm(start: u64, end: u64, alias: bool) -> MemoryRegion {
        MemoryRegion::Nvm(NvmRegion {
            name: Some(String::from("BANK_1")),
            range: start..end,
            cores: vec![String::from("main")],
            is_alias: alias,
            // The real STM32WLE5JC entry says write: false here, so the map we test
            // against says it too.
            access: Some(probe_rs::config::MemoryAccess {
                read: true,
                write: false,
                execute: true,
                boot: true,
            }),
        })
    }

    fn ram(start: u64, end: u64) -> MemoryRegion {
        MemoryRegion::Ram(RamRegion {
            name: Some(String::from("SRAM1")),
            range: start..end,
            cores: vec![String::from("main")],
            is_alias: false,
            access: None,
        })
    }

    #[test]
    fn one_attached_probe_needs_no_choosing_and_two_do() {
        let none: Vec<Probe> = Vec::new();
        assert!(pick(&none, None).unwrap_err().contains("no debug probe is attached"));
        assert!(pick(&none, Some("002A00")).unwrap_err().contains("no debug probe is attached"));

        let one = vec![probe("STLink V3", "002A00")];
        assert_eq!(pick(&one, None).unwrap(), 0);
        assert_eq!(pick(&one, Some("002A00")).unwrap(), 0);
        let wrong = pick(&one, Some("002B00")).unwrap_err();
        assert!(wrong.contains("002B00") && wrong.contains("002A00"), "{}", wrong);

        // A probe that reports no serial number is still the only one attached.
        let bare = vec![probe("STLink V2", "")];
        assert_eq!(pick(&bare, None).unwrap(), 0);
        assert!(pick(&bare, Some("002A00")).unwrap_err().contains("no serial number"));

        let two = vec![probe("STLink V3", "002A00"), probe("STLink V2", "066EFF")];
        let both = pick(&two, None).unwrap_err();
        assert!(both.contains("2 debug probes"), "{}", both);
        assert!(both.contains("002A00") && both.contains("066EFF"), "{}", both);
        assert_eq!(pick(&two, Some("066EFF")).unwrap(), 1);

        // Two probes with no serials: nothing to pick by, and the count has to say so.
        let blind = vec![probe("STLink V2", ""), probe("STLink V2", "")];
        assert!(pick(&blind, None).unwrap_err().contains("2 debug probes"));
    }

    #[test]
    fn the_flash_bounds_come_from_the_memory_map() {
        // What the STM32WLE5JC entry actually holds: one 256 kB bank and two RAMs.
        let wle5 = vec![
            nvm(0x0800_0000, 0x0804_0000, false),
            ram(0x2000_0000, 0x2000_8000),
            ram(0x2000_8000, 0x2001_0000),
        ];
        assert_eq!(main_flash(&wle5).unwrap(), 0x0800_0000..0x0804_0000);

        // The alias at 0 is the same bytes seen twice, and an OTP-sized region is not the
        // main flash, so the bank wins on size.
        let aliased = vec![
            nvm(0x0000_0000, 0x0804_0000, true),
            nvm(0x1FFF_7000, 0x1FFF_7400, false),
            nvm(0x0800_0000, 0x0804_0000, false),
        ];
        assert_eq!(main_flash(&aliased).unwrap(), 0x0800_0000..0x0804_0000);

        let no_flash = vec![ram(0x2000_0000, 0x2000_8000)];
        assert!(main_flash(&no_flash).unwrap_err().contains("no flash region"));
    }

    #[test]
    fn a_saved_image_is_named_after_the_board_and_the_minute_it_was_read() {
        let at = SystemTime::UNIX_EPOCH + Duration::from_secs(1_790_000_000);
        assert_eq!(
            backup_name("rx1", at),
            "descent-ground-fsw-rx1-2026-09-21T14-13-20.bin"
        );
        assert_eq!(
            backup_name("/dev/ttyACM0", at),
            "descent-ground-fsw-ttyACM0-2026-09-21T14-13-20.bin"
        );
        // A hint with nothing usable in it still has to produce one file name.
        assert!(backup_name("/", at).starts_with("descent-ground-fsw-board-"));
        assert!(backup_name("", at).starts_with("descent-ground-fsw-board-"));
        assert_eq!(tidy("chip sat #2"), "chip-sat--2");
    }

    #[test]
    fn an_image_that_does_not_fit_is_refused_before_anything_is_erased() {
        let flash = 256 * 1024;
        assert!(fits(flash as usize, flash).is_ok());
        assert!(fits(1, flash).is_ok());
        let over = fits(flash as usize + 1, flash).unwrap_err();
        assert!(over.contains("262145") && over.contains("262144"), "{}", over);
        assert!(fits(0, flash).unwrap_err().contains("empty"));
    }

    #[test]
    fn progress_frames_carry_a_percentage_and_a_line_to_read() {
        assert_eq!(pct_of(0, 262_144), 0);
        assert_eq!(pct_of(65_536, 262_144), 25);
        assert_eq!(pct_of(262_144, 262_144), 100);
        assert_eq!(pct_of(300_000, 262_144), 100);
        assert_eq!(pct_of(1, 0), 0);   // a total probe-rs did not tell us

        assert_eq!(
            kb_note("saving the flight software", 65_536, 262_144),
            "saving the flight software, 64 of 256 kB"
        );
        assert_eq!(
            frame(25, "saving the flight software, 64 of 256 kB"),
            "{\"type\":\"flash\",\"pct\":25,\"note\":\"saving the flight software, 64 of 256 kB\"}"
        );
        // Probe names and OS errors end up in these notes, so quotes cannot break the frame.
        assert!(frame(0, "no \"probe\"\tfound").contains("no \\\"probe\\\"\\tfound"));
    }

    #[test]
    fn a_readback_points_at_the_first_byte_that_differs() {
        assert_eq!(first_difference(&[1, 2, 3], &[1, 2, 3]), None);
        assert_eq!(first_difference(&[1, 2, 3], &[1, 0xFF, 3]), Some(1));
        assert_eq!(first_difference(&[1, 2, 3], &[0xFF, 0xFF, 0xFF]), Some(0));
    }
}
