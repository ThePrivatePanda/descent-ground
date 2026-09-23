// What the operator asked for on the command line, and what they asked for once and
// meant permanently. A double-click cannot pass a flag, so the settings file beside
// the binary is the only way to make a choice stick for that.
use std::path::Path;

pub const HELP: &str = "\
DeSCENT Ground — reads T-Beam receivers and serves the fleet dashboard.

  descent-ground [options]

  --no-browser      do not open a browser; just print the address
  --browser         open one, overriding the settings file
  -h, --help        this

It always prints its address and its log file. Closing the browser tab does not stop
it; Ctrl-C does.

To stop it opening a browser every time, put this in descent-ground.conf beside the
program:

  browser = no
";

pub struct Opts {
    pub open_browser: bool,
    pub help: bool,
}

// The flag wins over the file, so a one-off run can always go the other way.
pub fn parse(args: &[String], conf: Option<&str>) -> Opts {
    let mut open_browser = match conf.and_then(browser_in_conf) {
        Some(v) => v,
        None => true,
    };
    let mut help = false;
    for a in args {
        match a.as_str() {
            "--no-browser" => open_browser = false,
            "--browser" => open_browser = true,
            "-h" | "--help" => help = true,
            _ => {}
        }
    }
    Opts { open_browser, help }
}

fn browser_in_conf(text: &str) -> Option<bool> {
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        let Some((k, v)) = line.split_once('=') else { continue };
        if k.trim() != "browser" {
            continue;
        }
        return match v.trim().to_ascii_lowercase().as_str() {
            "no" | "off" | "false" | "0" => Some(false),
            "yes" | "on" | "true" | "1" => Some(true),
            _ => None,
        };
    }
    None
}

pub fn read_conf(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join("descent-ground.conf")).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_browser_opens_unless_told_otherwise() {
        assert!(parse(&args(&[]), None).open_browser);
        assert!(!parse(&args(&["--no-browser"]), None).open_browser);
        assert!(parse(&args(&["-h"]), None).help);
    }

    #[test]
    fn the_settings_file_makes_the_choice_stick() {
        assert!(!parse(&args(&[]), Some("browser = no\n")).open_browser);
        assert!(!parse(&args(&[]), Some("# comment\nbrowser=off")).open_browser);
        assert!(parse(&args(&[]), Some("browser = yes")).open_browser);
        // Nothing to do with us, or nonsense: the default stands.
        assert!(parse(&args(&[]), Some("colour = blue")).open_browser);
        assert!(parse(&args(&[]), Some("browser = maybe")).open_browser);
    }

    #[test]
    fn a_flag_beats_the_file_either_way() {
        assert!(parse(&args(&["--browser"]), Some("browser = no")).open_browser);
        assert!(!parse(&args(&["--no-browser"]), Some("browser = yes")).open_browser);
    }
}
