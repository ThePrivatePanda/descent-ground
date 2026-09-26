// DeSCENT Ground as a standalone app: finds every T-Beam on USB, serves the
// dashboard to the operator's browser, and logs every line whether or not a
// browser is open.
mod assets;
mod dump;
mod flash;
mod framing;
mod json;
mod logfile;
mod opts;
mod pull;
mod serial;
mod stm32;
mod tiles;
mod server;
mod urlfile;
mod ws;

use server::{Bound, Ctx};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn main() {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let argv: Vec<String> = std::env::args().skip(1).collect();
    let opts = match opts::parse(&argv, opts::read_conf(&dir).as_deref()) {
        Ok(o) => o,
        Err(e) => {
            println!("{}", e);
            std::process::exit(1);
        }
    };
    if opts.help {
        print!("{}", opts::HELP);
        return;
    }
    if opts.stop {
        std::process::exit(stop(&dir, opts.port));
    }

    let (server, port) = match server::bind(opts.port) {
        Ok(Bound::Ours(s, p)) => (s, p),
        Ok(Bound::AlreadyRunning(p)) => {
            let url = format!("http://127.0.0.1:{}/", p);
            println!("DeSCENT Ground is already running at {}", url);
            if opts.open_browser {
                let _ = webbrowser::open(&url);
            }
            return;
        }
        Err(e) => {
            println!("could not listen on 127.0.0.1: {}", e);
            std::process::exit(1);
        }
    };

    if let Some(stale) = opts::stale_against_source(&dir) {
        println!("WARNING: {}", stale);
    }

    let (log, warn) = logfile::Log::create(&dir);
    if let Some(w) = warn {
        println!("{}", w);
    }
    let log_path = log.as_ref().map(|l| l.path().to_path_buf());
    let log = Arc::new(Mutex::new(log));

    let (tx, rx) = mpsc::channel();
    let hub = Arc::new(Mutex::new(serial::Hub::new(tx)));
    hub.lock().unwrap().remember_in(&dir);
    let broadcast = ws::Broadcast::new();

    let ctx = Arc::new(Ctx {
        hub: hub.clone(),
        broadcast: broadcast.clone(),
        log: log.clone(),
        dir: dir.clone(),
        port,
        pull: pull::shared(),
    });

    std::thread::spawn({
        let ctx = ctx.clone();
        move || server::serve(server, ctx)
    });

    std::thread::spawn({
        let hub = hub.clone();
        move || loop {
            hub.lock().unwrap().poll();
            std::thread::sleep(Duration::from_secs(2));
        }
    });

    let url = format!("http://127.0.0.1:{}/", port);
    // After the server thread, so anything that finds the file gets an answer from
    // /api/health. Without it the app still runs; only a launcher notices.
    if let Some(w) = urlfile::write(&dir, &url) {
        println!("{}", w);
    }
    println!("DeSCENT Ground {} is at {}", env!("CARGO_PKG_VERSION"), url);
    match &log_path {
        Some(p) => println!("logging every line to {}", p.display()),
        None => println!("not logging to a file"),
    }
    // Ctrl-C ends the process outright, so the log is flushed every five seconds
    // rather than on the way out. The most a kill can cost is that tail.
    println!("Ctrl-C to stop. Closing the browser tab does not stop it.");
    if opts.open_browser {
        let _ = webbrowser::open(&url);
    } else {
        println!("Not opening a browser. Open that address yourself when you want it.");
    }

    let mut since_flush = std::time::Instant::now();
    for ev in rx {
        match ev {
            serial::Event::Line { key, t_ms, text } => {
                if let Ok(mut l) = log.lock() {
                    if let Some(l) = l.as_mut() {
                        l.write_line(t_ms, &key, &text);
                    }
                }
                broadcast.send(&ws::line_frame(&key, t_ms, &text));
            }
            serial::Event::Ports => broadcast.send(&ws::ports_frame()),
        }
        if since_flush.elapsed() > Duration::from_secs(5) {
            if let Ok(mut l) = log.lock() {
                if let Some(l) = l.as_mut() {
                    l.flush();
                }
            }
            since_flush = std::time::Instant::now();
        }
    }
    // Only reached if every receiver's sender has gone. Out the same way /api/quit
    // goes, so the log is flushed and the url file removed either way.
    server::shutdown(&ctx, "stopping: nothing left to read");
}

// --stop from the outside. Nothing running is not a fault of ours, but a script that
// asked for a stop and got none should hear that in the exit code.
fn stop(dir: &std::path::Path, port: Option<u16>) -> i32 {
    match server::running_port(dir, port) {
        Some(p) => match server::quit(p) {
            Ok(()) => {
                println!("stopped DeSCENT Ground on port {}", p);
                0
            }
            Err(e) => {
                println!("{}", e);
                1
            }
        },
        None => {
            match port {
                Some(p) => println!("nothing of ours is answering on port {}", p),
                None => println!(
                    "nothing of ours is answering on ports {}-{}, or at the port {} names",
                    server::FIRST_PORT,
                    server::LAST_PORT,
                    urlfile::NAME
                ),
            }
            1
        }
    }
}
