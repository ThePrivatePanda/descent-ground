// What flash_dump prints, turned into a log the dashboard already replays.
//
// The board prints one line naming a record and one line of hex for its payload:
//
//   record 0 boot 0 ms 2517
//   00 00 00 ... 55 bytes ...
//
// and, when it has ever had a GPS fix, anchors tying one boot's uptime to real time:
//
//   time 12 boot 0 ms 41230 epoch 1790258783 nano 216000000 bits 07 accns 25
//
// read off the board's own format string, which is
//   "time %lu boot %u ms %lu epoch %lu nano %ld bits %02X accns %lu"
// so nano is signed and bits is hex. Fields are found by their labels rather than by
// position, and only boot, ms, epoch and nano are used.
//
// and finally a line saying how many it found, which is how we know a dump finished
// rather than stopped halfway.
//
// Everything else on that port is console chatter and is ignored.
use crate::json::esc;

pub const PACKET_BYTES: usize = 55;
const BOOT_GAP_MS: u64 = 1000;

#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    pub n: u64,
    pub boot: u32,
    pub ms: u64,
    pub hex: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Anchor {
    pub boot: u32,
    pub ms: u64,
    pub unix_ms: u64,
}

#[derive(Debug, Default)]
pub struct Dump {
    pub records: Vec<Record>,
    pub anchors: Vec<Anchor>,
    pub found: Option<usize>,   // the board's own count, when it said
}

impl Dump {
    pub fn complete(&self) -> bool {
        self.found.is_some()
    }
    pub fn boots(&self) -> Vec<u32> {
        let mut b: Vec<u32> = self.records.iter().map(|r| r.boot).collect();
        b.sort_unstable();
        b.dedup();
        b
    }
}

fn after<'a>(parts: &[&'a str], key: &str) -> Option<&'a str> {
    parts.iter().position(|p| *p == key).and_then(|i| parts.get(i + 1)).copied()
}

// 55 bytes as the board prints them: space separated, uppercase, one line.
fn hex_line(line: &str) -> Option<String> {
    let mut out = String::with_capacity(PACKET_BYTES * 2);
    let mut seen = 0usize;
    for tok in line.split_whitespace() {
        if tok.len() != 2 || !tok.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        out.push_str(&tok.to_ascii_uppercase());
        seen += 1;
    }
    if seen == PACKET_BYTES { Some(out) } else { None }
}

// The board reprints its whole log on demand, so a port opened mid-printing catches the
// tail of an older one. Everything is read, then the last run that reached its "found"
// line is the one taken. Deciding afterwards rather than while reading is what keeps this
// from depending on when the port happened to open.
pub fn parse(text: &str) -> Dump {
    let mut runs: Vec<Dump> = vec![Dump::default()];
    let mut pending: Option<Record> = None;

    for line in text.lines() {
        let line = line.trim();
        if let Some(rec) = pending.take() {
            if let Some(hex) = hex_line(line) {
                runs.last_mut().unwrap().records.push(Record { hex, ..rec });
                continue;
            }
            // No payload followed, so that record header was noise or a truncated line.
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        match parts.first().copied() {
            Some("record") => {
                let n = parts.get(1).and_then(|v| v.parse().ok());
                let boot = after(&parts, "boot").and_then(|v| v.parse().ok());
                let ms = after(&parts, "ms").and_then(|v| v.parse().ok());
                if let (Some(n), Some(boot), Some(ms)) = (n, boot, ms) {
                    pending = Some(Record { n, boot, ms, hex: String::new() });
                }
            }
            Some("time") => {
                let boot = after(&parts, "boot").and_then(|v| v.parse::<u32>().ok());
                let ms = after(&parts, "ms").and_then(|v| v.parse::<u64>().ok());
                let epoch = after(&parts, "epoch").and_then(|v| v.parse::<u64>().ok());
                // The board prints nano with %ld: it is signed and can be negative, so the
                // fraction is subtracted as often as added. Reading it unsigned turns a
                // negative into zero and quietly loses up to a second, the wrong way.
                let nano = after(&parts, "nano").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
                if let (Some(boot), Some(ms), Some(epoch)) = (boot, ms, epoch) {
                    let unix_ms = (epoch as i64) * 1000 + nano / 1_000_000;
                    runs.last_mut().unwrap().anchors.push(Anchor {
                        boot,
                        ms,
                        unix_ms: unix_ms.max(0) as u64,
                    });
                }
            }
            Some("found") => {
                let n = parts.get(1).and_then(|v| v.parse().ok());
                let run = runs.last_mut().unwrap();
                run.found = n;
                runs.push(Dump::default());   // anything after this belongs to the next printing
            }
            _ => {}
        }
    }

    runs.into_iter()
        .filter(|r| r.complete() && !r.records.is_empty())
        .last()
        .unwrap_or_default()
}

// When a boot has an anchor, its records are dated from the nearest one in that same boot
// and the uptime difference; the anchor can arrive at the end and still date everything
// before it, which is the whole reason for anchoring rather than stamping each record.
//
// A boot with no anchor anywhere has no real time at all. Those are laid end to end from
// epoch 0, so the axis is unmistakably not a real date: a plausible-looking wrong time
// invites someone to read it as measured, and 1970 does not.
pub fn date(dump: &Dump) -> (Vec<(u64, &Record)>, &'static str) {
    let mut out = Vec::with_capacity(dump.records.len());
    let anchored = !dump.anchors.is_empty();
    let mut base: u64 = 0;

    for boot in dump.boots() {
        let mine: Vec<&Record> = dump.records.iter().filter(|r| r.boot == boot).collect();
        if mine.is_empty() {
            continue;
        }
        let anchor = dump.anchors.iter().filter(|a| a.boot == boot).min_by_key(|a| a.ms);
        match anchor {
            Some(a) => {
                for r in &mine {
                    let t = a.unix_ms as i128 + (r.ms as i128 - a.ms as i128);
                    out.push((t.max(0) as u64, *r));
                }
            }
            None => {
                let first = mine.iter().map(|r| r.ms).min().unwrap_or(0);
                let last = mine.iter().map(|r| r.ms).max().unwrap_or(0);
                for r in &mine {
                    out.push((base + (r.ms - first), *r));
                }
                base += last - first + BOOT_GAP_MS;
            }
        }
    }
    out.sort_by_key(|(t, _)| *t);
    (out, if anchored { "anchor" } else { "none" })
}

// The dashboard's own log format, so the file opens with Open log like any other.
pub fn to_log(dump: &Dump, origin: &str) -> String {
    let (dated, basis) = date(dump);
    let mut s = String::from("# descent-ground log v1 from flash\n");
    let mut written_boot: Option<u32> = None;

    for (t, r) in &dated {
        let rx = format!("flash-boot{}", r.boot);
        if written_boot != Some(r.boot) {
            let count = dump.records.iter().filter(|x| x.boot == r.boot).count();
            let anchor = dump.anchors.iter().find(|a| a.boot == r.boot);
            let anchor_bits = match anchor {
                Some(a) => format!(",anchor_uptime_ms={},anchor_unix_ms={}", a.ms, a.unix_ms),
                None => String::new(),
            };
            s.push_str(&format!(
                "{}\t{}\t#DG,SRC,v1,kind=flash,from={},boot={},packets={},time_source={}{}\n",
                t,
                rx,
                esc(origin).replace(',', "_"),
                r.boot,
                count,
                if anchor.is_some() { "anchor" } else { basis },
                anchor_bits
            ));
            s.push_str(&format!("{}\t{}\t#DG,BOOT,v1,n={}\n", t, rx, r.boot));
            written_boot = Some(r.boot);
        }
        s.push_str(&format!("{}\t{}\tPKT,55,{},,,\n", t, rx, r.hex));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
I TX 212361 c381: done ok=1 code=0 ms=465
record 0 boot 0 ms 2517
00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13 14 15 16 17 18 19 1A 1B 1C 1D 1E 1F 20 21 22 23 24 25 26 27 28 29 2A 2B 2C 2D 2E 2F 30 31 32 33 34 35 36
record 1 boot 0 ms 2567
00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13 14 15 16 17 18 19 1A 1B 1C 1D 1E 1F 20 21 22 23 24 25 26 27 28 29 2A 2B 2C 2D 2E 2F 30 31 32 33 34 35 36
record 2 boot 1 ms 900
00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13 14 15 16 17 18 19 1A 1B 1C 1D 1E 1F 20 21 22 23 24 25 26 27 28 29 2A 2B 2C 2D 2E 2F 30 31 32 33 34 35 36
found 3 records, 3 good (0 time anchors), 0 bad, from 2 boots, log ends at address 0x100
";

    #[test]
    fn a_record_is_its_header_plus_the_line_under_it() {
        let d = parse(SAMPLE);
        assert_eq!(d.records.len(), 3);
        assert_eq!(d.found, Some(3));
        assert!(d.complete());
        assert_eq!(d.records[0].boot, 0);
        assert_eq!(d.records[0].ms, 2517);
        assert_eq!(d.records[0].hex.len(), PACKET_BYTES * 2);
        assert!(d.records[0].hex.starts_with("000102"));
        assert_eq!(d.boots(), vec![0, 1]);
    }

    #[test]
    fn a_dump_that_never_finished_is_not_taken() {
        let half = SAMPLE.lines().take(5).collect::<Vec<_>>().join("\n");
        let d = parse(&half);
        assert!(!d.complete());
        assert!(d.records.is_empty(), "an unfinished printing is not a dump");
    }

    #[test]
    fn opening_the_port_mid_printing_takes_the_last_whole_one() {
        // The tail of an older printing, then a complete one. This is the case that
        // matters: the board reprints on demand and the port opens whenever it opens.
        let tail = "record 99 boot 9 ms 1\n00 01 02\nfound 1 records, 1 good (0 time anchors), 0 bad, from 1 boots, log ends at 0x1\n";
        let d = parse(&format!("{}{}", tail, SAMPLE));
        assert_eq!(d.found, Some(3));
        assert_eq!(d.records.len(), 3);
        assert_eq!(d.boots(), vec![0, 1], "the older printing's boot 9 is not in it");
    }

    #[test]
    fn boots_with_no_gps_are_laid_end_to_end_from_1970() {
        let d = parse(SAMPLE);
        let (dated, basis) = date(&d);
        assert_eq!(basis, "none");
        assert_eq!(dated.len(), 3);
        // Boot 0 starts at zero and keeps its own spacing.
        assert_eq!(dated[0].0, 0);
        assert_eq!(dated[1].0, 50);
        // Boot 1 begins after boot 0 ends plus the gap, not on top of it.
        assert_eq!(dated[2].0, 50 + BOOT_GAP_MS);
    }

    #[test]
    fn an_anchor_dates_the_records_before_it_too() {
        // Exactly what the board prints, hex bits and all.
        let text = format!(
            "{}\n{}",
            "time 1 boot 0 ms 2567 epoch 1790000000 nano 0 bits 07 accns 25",
            SAMPLE
        );
        let d = parse(&text);
        assert_eq!(d.anchors.len(), 1);
        let (dated, basis) = date(&d);
        assert_eq!(basis, "anchor");
        // The record 50 ms before the anchor is dated 50 ms before it, not dropped.
        let first = dated.iter().find(|(_, r)| r.n == 0).unwrap().0;
        assert_eq!(first, 1790000000000 - 50);
    }

    #[test]
    fn the_log_says_which_boot_and_where_it_came_from() {
        let d = parse(SAMPLE);
        let log = to_log(&d, "ttyACM1");
        let lines: Vec<&str> = log.lines().collect();
        assert!(lines[0].starts_with("# descent-ground log v1"));
        assert!(log.contains("#DG,SRC,v1,kind=flash,from=ttyACM1,boot=0,packets=2,time_source=none"));
        assert!(log.contains("#DG,BOOT,v1,n=0"));
        assert!(log.contains("#DG,BOOT,v1,n=1"));
        assert_eq!(log.matches("PKT,55,").count(), 3);
        // Every line is the dashboard's three tab-separated fields.
        for l in lines.iter().skip(1) {
            assert_eq!(l.matches('\t').count(), 2, "not a log row: {}", l);
        }
    }

    #[test]
    fn a_negative_nanosecond_fraction_is_subtracted_not_dropped() {
        // nano is %ld on the board. Parsed unsigned it fails and silently becomes zero,
        // which is up to a second of error in the wrong direction.
        let text = format!(
            "{}\n{}",
            "time 1 boot 0 ms 2517 epoch 1790000000 nano -250000000 bits 07 accns 25",
            SAMPLE
        );
        let d = parse(&text);
        assert_eq!(d.anchors.len(), 1, "a negative fraction must not throw the line away");
        assert_eq!(d.anchors[0].unix_ms, 1790000000000 - 250, "quarter of a second earlier");
    }

    #[test]
    fn the_hex_bits_field_does_not_confuse_the_labels() {
        // bits is %02X, so it can hold A-F. Fields are found by label, so a letter in
        // there must not shift anything else.
        let text = format!(
            "{}\n{}",
            "time 9 boot 0 ms 2517 epoch 1790000000 nano 1000000 bits AF accns 25",
            SAMPLE
        );
        let d = parse(&text);
        assert_eq!(d.anchors.len(), 1);
        assert_eq!(d.anchors[0].boot, 0);
        assert_eq!(d.anchors[0].ms, 2517);
        assert_eq!(d.anchors[0].unix_ms, 1790000000001);
    }

    // The only real capture either side has. If this parses to something other than what
    // the flight software counted, one of us is wrong and it is worth knowing which.
    #[test]
    fn the_real_capture_parses_to_what_the_board_said_it_wrote() {
        let path = "../../SSDS_DeSCENT/Software/V2_6_X/data/2026-09-23_2159/dump.txt";
        let Ok(text) = std::fs::read_to_string(path) else { return };   // lives in the flight repo
        let d = parse(&text);
        assert_eq!(d.found, Some(6627), "the board's own count");
        assert_eq!(d.records.len(), 6627, "and we kept every one");
        assert_eq!(d.boots(), vec![0, 1, 2, 3, 4]);
        assert!(d.records.iter().all(|r| r.hex.len() == PACKET_BYTES * 2));
        let log = to_log(&d, "dump.txt");
        assert_eq!(log.matches("PKT,55,").count(), 6627);
        assert_eq!(log.matches("#DG,BOOT,").count(), 5);
    }
}
