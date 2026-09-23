// Bytes from a serial port into whole lines. A port opened mid-line gives a
// partial first line, and a board that is still booting can emit non-UTF-8, so
// neither is allowed to matter.
const MAX_LINE: usize = 8192;

pub struct Framer {
    buf: Vec<u8>,
    dropping: bool,   // inside a line that outgrew the buffer
}

impl Framer {
    pub fn new() -> Self {
        Framer { buf: Vec::with_capacity(1024), dropping: false }
    }

    pub fn push(&mut self, data: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in data {
            if b == b'\n' {
                if !self.dropping {
                    out.push(String::from_utf8_lossy(&self.buf).trim_end_matches('\r').to_string());
                }
                self.buf.clear();
                self.dropping = false;
            } else if !self.dropping {
                self.buf.push(b);
                if self.buf.len() > MAX_LINE {
                    // A line this long is not ours. Throw the whole line away rather
                    // than emit its tail glued to the front of the next one.
                    self.buf.clear();
                    self.dropping = true;
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_newline_and_keeps_the_remainder() {
        let mut f = Framer::new();
        assert_eq!(f.push(b"HB,1,2,3\nPKT,55,00"), vec!["HB,1,2,3"]);
        assert_eq!(f.push(b"FF\n"), vec!["PKT,55,00FF"]);
    }

    #[test]
    fn a_port_opened_mid_line_loses_only_that_line() {
        let mut f = Framer::new();
        assert_eq!(f.push(b"55,00FF,-50.0\nHB,1,2,3\n"), vec!["55,00FF,-50.0", "HB,1,2,3"]);
    }

    #[test]
    fn strips_cr_and_survives_non_utf8_boot_noise() {
        let mut f = Framer::new();
        assert_eq!(f.push(b"HB,1,2,3\r\n"), vec!["HB,1,2,3"]);
        let out = f.push(&[0xff, 0xfe, b'o', b'k', b'\n']);
        assert_eq!(out.len(), 1);
        assert!(out[0].ends_with("ok"));
    }

    #[test]
    fn a_runaway_line_without_a_newline_is_dropped_not_grown_forever() {
        let mut f = Framer::new();
        let junk = vec![b'x'; 9000];
        assert!(f.push(&junk).is_empty());
        // Still inside that line: its tail goes too, up to and including its newline.
        assert!(f.push(b"and-still-the-same-line\n").is_empty());
        assert_eq!(f.push(b"HB,1,2,3\n"), vec!["HB,1,2,3"]);
    }
}
