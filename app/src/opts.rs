// What the operator asked for on the command line, and what they asked for once and
// meant permanently. A double-click cannot pass a flag, so the settings file beside
// the binary is the only way to make a choice stick for that.
use std::path::Path;

pub const HELP: &str = "\
DeSCENT Ground — reads T-Beam receivers and serves the fleet dashboard.

  descent-ground [options]

  --port <n>        listen on this port only, and stop if it is taken
  --no-browser      do not open a browser; just print the address
  --browser         open one, overriding the settings file
  --stop            ask a running copy to exit, and say what happened
  -h, --help        this

Without --port it tries 8765 and walks up to 8774. While it runs, its address is in
descent-ground.url beside the program, one line, so a script can find it without
guessing. A kill leaves that file behind, so ask /api/health before trusting it.

It always prints its address and its log file. Closing the browser tab does not stop
it; Ctrl-C does.

To stop it opening a browser every time, or to fix the port, put these in
descent-ground.conf beside the program:

  browser = no
  port = 8900
";

// Running a build that is older than the dashboard next to it is the trap that cost an
// evening: the app served a UI that no longer existed in the tree and nothing said so.
// Only applies to a binary sitting in the build directory of a checkout; a downloaded
// release has no source beside it and says nothing.
pub fn stale_against_source(exe_dir: &Path) -> Option<String> {
    let built: u64 = env!("DG_BUILT").parse().ok()?;
    let web = ["../../../web", "../../../../web"]
        .iter()
        .map(|rel| exe_dir.join(rel))
        .find(|p| p.join("index.html").is_file())?;
    let newest = newest_mtime(&web)?;
    if newest <= built {
        return None;
    }
    Some(format!(
        "this build is older than {} — run: cargo build --release",
        web.canonicalize().unwrap_or(web.clone()).display()
    ))
}

fn newest_mtime(dir: &Path) -> Option<u64> {
    let mut newest = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).ok()?.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(t) = e.metadata().and_then(|m| m.modified()) {
                if let Ok(secs) = t.duration_since(std::time::UNIX_EPOCH) {
                    newest = newest.max(secs.as_secs());
                }
            }
        }
    }
    Some(newest)
}

pub struct Opts {
    pub open_browser: bool,
    pub help: bool,
    pub port: Option<u16>,
    pub stop: bool,
}

// The flag wins over the file, so a one-off run can always go the other way. A port
// that is asked for and unusable is an error either way: a script that said 8900 and
// silently got 8765 has no way to notice.
pub fn parse(args: &[String], conf: Option<&str>) -> Result<Opts, String> {
    let mut open_browser = match conf.and_then(browser_in_conf) {
        Some(v) => v,
        None => true,
    };
    let mut port = match conf {
        Some(text) => port_in_conf(text)?,
        None => None,
    };
    let mut help = false;
    let mut stop = false;
    let mut rest = args.iter();
    while let Some(a) = rest.next() {
        match a.as_str() {
            "--no-browser" => open_browser = false,
            "--browser" => open_browser = true,
            "--stop" => stop = true,
            "--port" => {
                let v = rest.next().ok_or_else(|| String::from("--port wants a port number after it"))?;
                port = Some(a_port(v)?);
            }
            "-h" | "--help" => help = true,
            // --port=8900 is what a script tends to write, and dropping it silently
            // would put us on a port nobody asked for.
            _ => {
                if let Some(v) = a.strip_prefix("--port=") {
                    port = Some(a_port(v)?);
                }
            }
        }
    }
    Ok(Opts { open_browser, help, port, stop })
}

// Port 0 would get us any free port, which is the one thing a caller asking for a
// port does not want.
fn a_port(text: &str) -> Result<u16, String> {
    let text = text.trim();
    match text.parse::<u16>() {
        Ok(p) if p > 0 => Ok(p),
        _ => Err(format!("{:?} is not a port number between 1 and 65535", text)),
    }
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

// Ok(None) is a file that says nothing about the port. A line that does and gets it
// wrong stops the run instead.
fn port_in_conf(text: &str) -> Result<Option<u16>, String> {
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        let Some((k, v)) = line.split_once('=') else { continue };
        if k.trim() != "port" {
            continue;
        }
        return match a_port(v) {
            Ok(p) => Ok(Some(p)),
            Err(e) => Err(format!("descent-ground.conf: {}", e)),
        };
    }
    Ok(None)
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

    fn ok(v: &[&str], conf: Option<&str>) -> Opts {
        parse(&args(v), conf).unwrap()
    }

    fn refused(v: &[&str], conf: Option<&str>) -> String {
        parse(&args(v), conf).err().expect("should not have been accepted")
    }

    #[test]
    fn a_browser_opens_unless_told_otherwise() {
        assert!(ok(&[], None).open_browser);
        assert!(!ok(&["--no-browser"], None).open_browser);
        assert!(ok(&["-h"], None).help);
    }

    #[test]
    fn the_settings_file_makes_the_choice_stick() {
        assert!(!ok(&[], Some("browser = no\n")).open_browser);
        assert!(!ok(&[], Some("# comment\nbrowser=off")).open_browser);
        assert!(ok(&[], Some("browser = yes")).open_browser);
        // Nothing to do with us, or nonsense: the default stands.
        assert!(ok(&[], Some("colour = blue")).open_browser);
        assert!(ok(&[], Some("browser = maybe")).open_browser);
    }

    #[test]
    fn a_flag_beats_the_file_either_way() {
        assert!(ok(&["--browser"], Some("browser = no")).open_browser);
        assert!(!ok(&["--no-browser"], Some("browser = yes")).open_browser);
        assert_eq!(ok(&["--port", "8790"], Some("port = 8900")).port, Some(8790));
    }

    #[test]
    fn the_port_comes_from_the_file_or_the_flag() {
        assert_eq!(ok(&[], None).port, None);
        assert_eq!(ok(&[], Some("browser = no")).port, None);
        assert_eq!(ok(&[], Some("port = 8900")).port, Some(8900));
        assert_eq!(ok(&[], Some("port=8900 # the one we install with")).port, Some(8900));
        assert_eq!(ok(&["--port", "8790"], None).port, Some(8790));
        assert_eq!(ok(&["--port=8790"], None).port, Some(8790));
        assert!(ok(&["--stop"], None).stop);
        assert!(!ok(&[], None).stop);
    }

    #[test]
    fn a_port_that_cannot_work_is_said_out_loud() {
        for conf in ["port = eight", "port = 0", "port = 70000", "port =", "port = 8765x"] {
            let e = refused(&[], Some(conf));
            assert!(e.starts_with("descent-ground.conf: "), "{}", e);
            assert!(e.contains("port number"), "{}", e);
        }
        assert!(refused(&["--port", "eight"], None).contains("port number"));
        assert!(refused(&["--port", "0"], None).contains("port number"));
        assert!(refused(&["--port=70000"], None).contains("port number"));
        assert!(refused(&["--port"], None).contains("wants a port number"));
        // A bad file is still an error when the flag would have overridden it: the file
        // is wrong whichever way this run goes.
        assert!(!refused(&["--port", "8790"], Some("port = nope")).is_empty());
    }
}

