// The dashboard, and the few calls it makes back. Bound to 127.0.0.1 only: this is
// the operator's own laptop, not a service.
use crate::json::{esc, int_field};
use crate::logfile::Log;
use crate::serial::{Board, Hub, PortInfo};
use crate::ws::{Broadcast, Socket};
use crate::{assets, flash, logfile, urlfile};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tiny_http::{Header, Request, Response, Server};
use tungstenite::protocol::Role;

// Fixed, not ephemeral: the dashboard keeps its settings in localStorage and its
// crash autosave in IndexedDB, and the browser keys both to the origin. A new port
// every launch would hand the operator a blank dashboard and no recovered session.
pub const FIRST_PORT: u16 = 8765;
pub const LAST_PORT: u16 = 8774;

pub fn ports_json(ports: &[PortInfo], boards: &[Board], log: Option<&str>) -> String {
    let items: Vec<String> = ports
        .iter()
        .map(|p| {
            format!(
                "{{\"key\":\"{}\",\"port\":\"{}\",\"usb\":\"{}\",\"status\":\"{}\",\"error\":{}}}",
                esc(&p.key),
                esc(&p.port),
                esc(&p.usb),
                esc(&p.status),
                match &p.error {
                    Some(e) => format!("\"{}\"", esc(e)),
                    None => String::from("null"),
                }
            )
        })
        .collect();
    let rest: Vec<String> = boards
        .iter()
        .map(|b| {
            format!(
                "{{\"port\":\"{}\",\"usb\":\"{}\",\"label\":\"{}\",\"serial\":\"{}\",\"state\":\"{}\",\"name\":\"{}\"}}",
                esc(&b.port),
                esc(&b.usb),
                esc(&b.label),
                esc(&b.serial),
                esc(&b.state),
                esc(&b.name)
            )
        })
        .collect();
    format!(
        "{{\"ports\":[{}],\"boards\":[{}],\"log\":{}}}",
        items.join(","),
        rest.join(","),
        match log {
            Some(l) => format!("\"{}\"", esc(l)),
            None => String::from("null"),
        }
    )
}

// What a launcher polls to know we are up. Built from numbers rather than read off a
// running server, so it can be checked without one.
pub fn health_json(version: &str, port: u16, log: Option<&str>, boards: usize, receivers: usize) -> String {
    // The dump firmware has no version of its own and does change, so the build says
    // which copy it is carrying rather than leaving a stale one to be guessed at.
    format!(
        "{{\"ok\":true,\"version\":\"{}\",\"port\":{},\"dumpFirmware\":\"{}\",\"log\":{},\"boards\":{},\"receivers\":{}}}",
        esc(version),
        port,
        esc(crate::flash::CHIPSAT_DUMP_ID),
        match log {
            Some(l) => format!("\"{}\"", esc(l)),
            None => String::from("null"),
        },
        boards,
        receivers
    )
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header")
}

// Try our ports in order. A bind that fails on a port where our own /api/ports
// answers means a second double-click, which the caller turns into "open the
// browser at the one already running".
pub enum Bound {
    Ours(Server, u16),
    AlreadyRunning(u16),
}

// A port that was asked for is the only one tried: a script that said 8900 and quietly
// got 8765 has no way to notice. Our own copy already on it is still worth reporting as
// that rather than as a failure.
pub fn bind(want: Option<u16>) -> Result<Bound, String> {
    if let Some(port) = want {
        return match Server::http(("127.0.0.1", port)) {
            Ok(s) => Ok(Bound::Ours(s, port)),
            Err(e) => {
                if ours_is_listening(port) {
                    Ok(Bound::AlreadyRunning(port))
                } else {
                    Err(format!("port {} is taken: {}", port, e))
                }
            }
        };
    }
    let mut last = String::new();
    for port in FIRST_PORT..=LAST_PORT {
        match Server::http(("127.0.0.1", port)) {
            Ok(s) => return Ok(Bound::Ours(s, port)),
            Err(e) => {
                last = e.to_string();
                if ours_is_listening(port) {
                    return Ok(Bound::AlreadyRunning(port));
                }
            }
        }
    }
    Err(last)
}

// One request, one answer, from outside the running app. HTTP/1.0 so the other end
// closes and the read ends.
fn ask(port: u16, request: &str) -> Option<String> {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_millis(500)));
    s.write_all(request.as_bytes()).ok()?;
    let mut buf = String::new();
    let _ = s.take(2048).read_to_string(&mut buf);
    Some(buf)
}

fn ours_is_listening(port: u16) -> bool {
    match ask(port, "GET /api/ports HTTP/1.0\r\n\r\n") {
        Some(buf) => buf.contains("\"ports\""),
        None => false,
    }
}

fn health_answers(port: u16) -> bool {
    match ask(port, "GET /api/health HTTP/1.0\r\n\r\n") {
        Some(buf) => buf.contains("\"receivers\":"),
        None => false,
    }
}

// Where the running copy is, for --stop. The url file names the port when one was
// written, and our ports are walked when it was not. Either way the port has to answer
// /api/health first: a kill leaves the file behind, and an older build answers
// /api/ports without knowing how to stop.
pub fn running_port(dir: &Path, want: Option<u16>) -> Option<u16> {
    if let Some(port) = want {
        return if health_answers(port) { Some(port) } else { None };
    }
    if let Some(port) = urlfile::port(dir) {
        if health_answers(port) {
            return Some(port);
        }
    }
    (FIRST_PORT..=LAST_PORT).find(|p| health_answers(*p))
}

// Ask, then wait for the port to go quiet. "It said yes" is not "it is gone", and a
// script that starts another copy straight after needs the port free.
pub fn quit(port: u16) -> Result<(), String> {
    let answer = ask(port, "POST /api/quit HTTP/1.0\r\nContent-Length: 0\r\n\r\n")
        .ok_or_else(|| format!("port {} stopped answering before it replied", port))?;
    if !answer.contains("\"ok\":true") {
        return Err(format!("port {} would not take the request", port));
    }
    for _ in 0..30 {
        std::thread::sleep(Duration::from_millis(100));
        if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_err() {
            return Ok(());
        }
    }
    Err(format!("port {} still answers three seconds after agreeing to stop", port))
}

pub struct Ctx {
    pub hub: Arc<Mutex<Hub>>,
    pub broadcast: Broadcast,
    pub log: Arc<Mutex<Option<Log>>>,
    pub dir: PathBuf,
    pub port: u16,
    pub pull: crate::pull::Shared,
}

// The one way out, whoever asked. The log is flushed before the url file goes, because
// a file somebody else is holding open cannot be removed on Windows and that must not
// cost us the tail of the log.
pub fn shutdown(ctx: &Ctx, why: &str) -> ! {
    if let Ok(mut l) = ctx.log.lock() {
        if let Some(l) = l.as_mut() {
            l.flush();
        }
    }
    if let Some(w) = urlfile::remove(&ctx.dir) {
        println!("{}", w);
    }
    println!("{}", why);
    std::process::exit(0);
}

pub fn serve(server: Server, ctx: Arc<Ctx>) {
    for request in server.incoming_requests() {
        let ctx = ctx.clone();
        std::thread::spawn(move || handle(request, ctx));
    }
}

fn is_websocket(request: &Request) -> Option<String> {
    let mut upgrade = false;
    let mut key = None;
    for h in request.headers() {
        let f = h.field.as_str().as_str().to_ascii_lowercase();
        if f == "upgrade" && h.value.as_str().to_ascii_lowercase().contains("websocket") {
            upgrade = true;
        }
        if f == "sec-websocket-key" {
            key = Some(h.value.as_str().to_string());
        }
    }
    if upgrade { key } else { None }
}

fn handle(mut request: Request, ctx: Arc<Ctx>) {
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();

    if path == "/api/stream" {
        if let Some(key) = is_websocket(&request) {
            let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
            let response = Response::empty(101)
                .with_header(header("Upgrade", "websocket"))
                .with_header(header("Connection", "Upgrade"))
                .with_header(header("Sec-WebSocket-Accept", &accept));
            let stream = request.upgrade("websocket", response);
            let socket: Socket = tungstenite::WebSocket::from_raw_socket(stream, Role::Server, None);
            ctx.broadcast.add(socket);
            return;
        }
        let _ = request.respond(Response::from_string("not a websocket request").with_status_code(400));
        return;
    }

    // What a launcher polls until the app is up, and the one place it can read the
    // version it is talking to.
    if path == "/api/health" {
        let (boards, receivers) = match ctx.hub.lock() {
            Ok(h) => (h.boards().len(), h.ports().len()),
            Err(_) => (0, 0),
        };
        let log = ctx
            .log
            .lock()
            .ok()
            .and_then(|l| l.as_ref().map(|l| l.path().display().to_string()));
        let body = health_json(env!("CARGO_PKG_VERSION"), ctx.port, log.as_deref(), boards, receivers);
        let _ = request.respond(
            Response::from_string(body).with_header(header("Content-Type", "application/json")),
        );
        return;
    }

    // How a launcher stops us without keeping a pid. Only reachable from this machine,
    // because the listener is bound to 127.0.0.1.
    if path == "/api/quit" {
        if request.method().as_str() != "POST" {
            let _ = request.respond(
                Response::from_string("{\"ok\":false,\"error\":\"POST only\"}")
                    .with_status_code(405)
                    .with_header(header("Content-Type", "application/json")),
            );
            return;
        }
        let _ = request.respond(
            Response::from_string("{\"ok\":true}").with_header(header("Content-Type", "application/json")),
        );
        // respond() has written the answer, but the other end still has to read it off
        // the socket before we close everything by leaving.
        std::thread::sleep(Duration::from_millis(100));
        shutdown(&ctx, "stopping: asked to over /api/quit");
    }

    if path == "/api/ports" {
        let (ports, boards) = match ctx.hub.lock() {
            Ok(h) => (h.ports(), h.boards()),
            Err(_) => (Vec::new(), Vec::new()),
        };
        // Asked of the log itself rather than remembered, so a rotation shows up here.
        let log = ctx
            .log
            .lock()
            .ok()
            .and_then(|l| l.as_ref().map(|l| l.path().display().to_string()));
        let body = ports_json(&ports, &boards, log.as_deref());
        let _ = request.respond(
            Response::from_string(body).with_header(header("Content-Type", "application/json")),
        );
        return;
    }

    if let Some(rest) = path.strip_prefix("/api/receiver/") {
        let mut it = rest.splitn(2, '/');
        let key = it.next().unwrap_or("").to_string();
        let action = it.next().unwrap_or("");
        let mut body = String::new();
        let _ = std::io::Read::read_to_string(&mut request.as_reader(), &mut body);
        let result = match action {
            "get" => ctx.hub.lock().unwrap().send(&key, "#GET\n"),
            "close" => {
                ctx.hub.lock().unwrap().dismiss(&key);
                Ok(())
            }
            "config" => match int_field(&body, "sf") {
                Some(sf) if (6..=12).contains(&sf) => {
                    ctx.hub.lock().unwrap().send(&key, &format!("#SET,sf,{}\n", sf))
                }
                Some(sf) => Err(format!("spreading factor {} is not between 6 and 12", sf)),
                None => Err(String::from("no spreading factor in the request")),
            },
            other => Err(format!("no such action: {}", other)),
        };
        let (code, text) = match result {
            Ok(()) => (200, String::from("{\"ok\":true}")),
            Err(e) => (400, format!("{{\"ok\":false,\"error\":\"{}\"}}", esc(&e))),
        };
        let _ = request.respond(
            Response::from_string(text)
                .with_status_code(code)
                .with_header(header("Content-Type", "application/json")),
        );
        return;
    }

    // The operator saying what a board is. Nothing is opened before this, because
    // opening a port pulses DTR and can reset the board on the other end.
    if path == "/api/board/receiver" || path == "/api/board/ignore" {
        let receiver = path.ends_with("receiver");
        let mut body = String::new();
        let _ = std::io::Read::read_to_string(&mut request.as_reader(), &mut body);
        let text = match crate::json::str_field(&body, "port") {
            Some(p) => {
                let mut hub = ctx.hub.lock().unwrap();
                let r = if receiver { hub.approve(&p) } else { hub.ignore(&p) };
                match r {
                    Ok(()) => {
                        println!("{} is {}", p, if receiver { "a receiver" } else { "left alone" });
                        String::from("{\"ok\":true}")
                    }
                    Err(e) => format!("{{\"ok\":false,\"error\":\"{}\"}}", esc(&e)),
                }
            }
            None => String::from("{\"ok\":false,\"error\":\"no port in the request\"}"),
        };
        let _ = request.respond(
            Response::from_string(text).with_header(header("Content-Type", "application/json")),
        );
        return;
    }

    // A name the operator can read, against the board and not the port. An empty name
    // clears it.
    if path == "/api/board/name" {
        let mut body = String::new();
        let _ = std::io::Read::read_to_string(&mut request.as_reader(), &mut body);
        let text = match (crate::json::str_field(&body, "port"), crate::json::str_field(&body, "name")) {
            (Some(p), Some(name)) => {
                match ctx.hub.lock().unwrap().set_name(&p, &name) {
                    Ok(()) => {
                        println!("{} is {}", p, if name.trim().is_empty() { "nameless again" } else { name.trim() });
                        String::from("{\"ok\":true}")
                    }
                    Err(e) => format!("{{\"ok\":false,\"error\":\"{}\"}}", esc(&e)),
                }
            }
            (None, _) => String::from("{\"ok\":false,\"error\":\"no port in the request\"}"),
            (_, None) => String::from("{\"ok\":false,\"error\":\"no name in the request\"}"),
        };
        let _ = request.respond(
            Response::from_string(text).with_header(header("Content-Type", "application/json")),
        );
        return;
    }

    // Which board is which, without touching any of them: the operator unplugs the one
    // they mean and plugs it back in, and discovery sees it go and come back. POST
    // starts a watch, GET asks how it is going, and both answer the same shape.
    if path == "/api/board/identify" {
        let start = request.method().as_str() == "POST";
        let (watching, found, left) = {
            let mut hub = ctx.hub.lock().unwrap();
            if start {
                hub.identify_start();
                println!("identify: unplug the board you mean, then plug it back in");
            }
            hub.identify_state()
        };
        let body = format!(
            "{{\"watching\":{},\"found\":{},\"seconds_left\":{}}}",
            watching,
            match &found {
                Some(p) => format!("\"{}\"", esc(p)),
                None => String::from("null"),
            },
            left
        );
        let _ = request.respond(
            Response::from_string(body).with_header(header("Content-Type", "application/json")),
        );
        return;
    }

    // Five seconds of listening to an unknown board. Nothing is sent to it, not even
    // #GET: this is the call for a board nobody has vouched for yet. It blocks for
    // those five seconds, which is fine because every request has its own thread.
    if path == "/api/board/test" {
        let mut body = String::new();
        let _ = std::io::Read::read_to_string(&mut request.as_reader(), &mut body);
        let text = match crate::json::str_field(&body, "port") {
            None => String::from("{\"ok\":false,\"error\":\"no port in the request\"}"),
            Some(p) => {
                // The hub lock is let go before the read, or poll() stops for five seconds.
                let held = ctx.hub.lock().unwrap().begin_probe(&p);
                match held {
                    Err(e) => format!("{{\"ok\":false,\"error\":\"{}\"}}", esc(&e)),
                    Ok(()) => {
                        let heard = crate::serial::probe(&p);
                        ctx.hub.lock().unwrap().end_probe(&p);
                        match heard {
                            Ok((lines, bytes)) => {
                                // Judged on everything it said, shown a readable slice of it.
                                let what = crate::serial::looks_like(&lines, bytes);
                                println!("{} sounds like {} ({} lines)", p, what, lines.len());
                                let items: Vec<String> = lines
                                    .iter()
                                    .take(crate::serial::PROBE_LINES)
                                    .map(|l| format!("\"{}\"", esc(&crate::serial::clip(l, crate::serial::PROBE_CHARS))))
                                    .collect();
                                format!(
                                    "{{\"ok\":true,\"lines\":[{}],\"looks_like\":\"{}\"}}",
                                    items.join(","),
                                    what
                                )
                            }
                            Err(e) => format!("{{\"ok\":false,\"error\":\"{}\"}}", esc(&e)),
                        }
                    }
                }
            }
        };
        let _ = request.respond(
            Response::from_string(text).with_header(header("Content-Type", "application/json")),
        );
        return;
    }

    // Start a new log without restarting the app, for a second drop on the same day.
    // Every log beside the app, so they can be opened or saved from the page. Someone who
    // pulled a chip should not have to go looking in a directory for what they just read.
    if path == "/api/logs" {
        let mut rows: Vec<(u64, String, u64)> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&ctx.dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if !name.ends_with(".log") {
                    continue;
                }
                let meta = e.metadata().ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let when = meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                rows.push((when, name, size));
            }
        }
        rows.sort_by(|a, b| b.0.cmp(&a.0));   // newest first: it is the one just written
        let items: Vec<String> = rows
            .iter()
            .map(|(when, name, size)| {
                format!(
                    "{{\"name\":\"{}\",\"bytes\":{},\"when\":{}}}",
                    esc(name),
                    size,
                    when
                )
            })
            .collect();
        let _ = request.respond(
            Response::from_string(format!("{{\"logs\":[{}]}}", items.join(",")))
                .with_header(header("Content-Type", "application/json")),
        );
        return;
    }

    // A log off the app's own directory, so the page can replay what was written beside it
    // without anyone standing up a second web server to hand it over. Read-only, this
    // directory only, no walking out of it.
    if let Some(name) = path.strip_prefix("/api/log/").filter(|n| *n != "rotate") {
        let name = name.trim_start_matches('/');
        let bad = name.is_empty()
            || name.contains("..")
            || name.contains('/')
            || name.contains('\\');
        if bad {
            let _ = request.respond(Response::from_string("no").with_status_code(400));
            return;
        }
        match std::fs::read(ctx.dir.join(name)) {
            Ok(body) => {
                let _ = request.respond(
                    Response::from_data(body)
                        .with_header(header("Content-Type", "text/plain; charset=utf-8"))
                        .with_header(header(
                            "Content-Disposition",
                            &format!("inline; filename=\"{}\"", name.replace('"', "")),
                        )),
                );
            }
            Err(e) => {
                let _ = request.respond(
                    Response::from_string(format!("{}: {}", name, e)).with_status_code(404),
                );
            }
        }
        return;
    }

    if path == "/api/log/rotate" {
        let text = match logfile::rotate(&ctx.log, &ctx.dir) {
            Ok(p) => {
                println!("logging every line to {}", p.display());
                format!("{{\"ok\":true,\"log\":\"{}\"}}", esc(&p.to_string_lossy()))
            }
            Err(e) => format!("{{\"ok\":false,\"error\":\"{}\"}}", esc(&e)),
        };
        let _ = request.respond(
            Response::from_string(text).with_header(header("Content-Type", "application/json")),
        );
        return;
    }

    // Pulling a flight log off a chip. The app runs what it was told to run and shows what
    // that says; it does not know an ST-Link from a cross compiler and is not going to.
    // Pull a flight log off a ChipSat. Everything happens in this program: the debug
    // probe is driven directly and the dump firmware is carried inside the binary, so
    // there is nothing to install and nothing to configure.
    if path == "/api/pull" {
        let mut body = String::new();
        let _ = std::io::Read::read_to_string(&mut request.as_reader(), &mut body);
        let board = crate::json::str_field(&body, "port").unwrap_or_default();
        let keep_fsw = crate::json::int_field(&body, "keepFsw").unwrap_or(1) != 0;
        let probe = crate::json::str_field(&body, "probe").filter(|p| !p.is_empty());

        let text = match crate::flash::CHIPSAT_DUMP {
            None => String::from("{\"ok\":false,\"error\":\"this build carries no dump firmware\"}"),
            Some(_) if board.is_empty() => String::from("{\"ok\":false,\"error\":\"no board in the request\"}"),
            Some(image) => {
                // The board is taken off discovery the same way a flash takes it, so
                // nothing else opens the port while the probe is resetting it.
                let released = ctx.hub.lock().unwrap().release_for_flash(&board);
                match released.and_then(|()| {
                    crate::pull::start(crate::pull::Job {
                        shared: ctx.pull.clone(),
                        broadcast: ctx.broadcast.clone(),
                        dir: ctx.dir.clone(),
                        port_name: board.clone(),
                        probe,
                        keep_fsw,
                        dump_image: image,
                    })
                }) {
                    Ok(()) => {
                        let hub = ctx.hub.clone();
                        let pull = ctx.pull.clone();
                        let board2 = board.clone();
                        std::thread::spawn(move || {
                            loop {
                                std::thread::sleep(std::time::Duration::from_millis(500));
                                if !pull.lock().map(|p| p.running).unwrap_or(false) {
                                    break;
                                }
                            }
                            hub.lock().unwrap().take_back(&board2);
                        });
                        println!("pulling from {}{}", board, if keep_fsw { ", keeping the flight software" } else { ", NOT keeping the flight software" });
                        String::from("{\"ok\":true}")
                    }
                    Err(e) => {
                        ctx.hub.lock().unwrap().take_back(&board);
                        format!("{{\"ok\":false,\"error\":\"{}\"}}", esc(&e))
                    }
                }
            }
        };
        let _ = request.respond(
            Response::from_string(text).with_header(header("Content-Type", "application/json")),
        );
        return;
    }

    // Asked for, not pushed: a reloaded page or a reopened panel picks the job back up.
    if path == "/api/pull/state" {
        let body = {
            let p = ctx.pull.lock().unwrap();
            crate::pull::state_json(&p, crate::logfile::now_ms())
        };
        let _ = request.respond(
            Response::from_string(body).with_header(header("Content-Type", "application/json")),
        );
        return;
    }

    if path == "/api/flash/candidates" {
        let body = {
            let hub = ctx.hub.lock().unwrap();
            flash::candidates_json(&hub)
        };
        let _ = request.respond(
            Response::from_string(body).with_header(header("Content-Type", "application/json")),
        );
        return;
    }

    if path == "/api/flash" {
        let mut body = String::new();
        let _ = std::io::Read::read_to_string(&mut request.as_reader(), &mut body);
        let text = flash::handle_request(&body, &ctx);
        let _ = request.respond(
            Response::from_string(text).with_header(header("Content-Type", "application/json")),
        );
        return;
    }

    match assets::get(&path) {
        Some((body, ct)) => {
            let _ = request.respond(
                Response::from_data(body).with_header(header("Content-Type", ct)),
            );
        }
        None => {
            let _ = request.respond(Response::from_string("not found").with_status_code(404));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets;

    #[test]
    fn the_dashboard_is_embedded_with_the_right_content_types() {
        let (body, ct) = assets::get("/").unwrap();
        assert!(String::from_utf8_lossy(body).contains("DeSCENT"));
        assert_eq!(ct, "text/html; charset=utf-8");
        assert_eq!(assets::get("/js/packet.js").unwrap().1, "text/javascript");
        assert_eq!(assets::get("/css/style.css").unwrap().1, "text/css");
        assert_eq!(
            assets::get("/vendor/fonts/ibm-plex-mono-latin-400-normal.woff2").unwrap().1,
            "font/woff2"
        );
        assert!(assets::get("/../Cargo.toml").is_none());
        assert!(assets::get("/nope.js").is_none());
    }

    #[test]
    fn ports_json_is_shaped_the_way_the_page_expects() {
        let ports = vec![PortInfo {
            key: "rx1".into(),
            port: "/dev/ttyUSB0".into(),
            usb: "10c4:ea60".into(),
            status: "open".into(),
            error: None,
        }];
        let boards = vec![Board {
            port: "/dev/ttyACM0".into(),
            usb: "1a86:55d4".into(),
            label: "CH9102".into(),
            serial: "58A1".into(),
            key: "1a86:55d4:58A1".into(),
            state: "waiting".into(),
            name: "Left T-Beam".into(),
        }];
        let json = ports_json(&ports, &boards, Some("/tmp/a.log"));
        assert_eq!(json, "{\"ports\":[{\"key\":\"rx1\",\"port\":\"/dev/ttyUSB0\",\"usb\":\"10c4:ea60\",\"status\":\"open\",\"error\":null}],\"boards\":[{\"port\":\"/dev/ttyACM0\",\"usb\":\"1a86:55d4\",\"label\":\"CH9102\",\"serial\":\"58A1\",\"state\":\"waiting\",\"name\":\"Left T-Beam\"}],\"log\":\"/tmp/a.log\"}");
    }

    #[test]
    fn health_is_shaped_the_way_a_launcher_reads_it() {
        let id = crate::flash::CHIPSAT_DUMP_ID;
        assert_eq!(
            health_json("0.4.0", 8790, Some("/tmp/a.log"), 2, 1),
            format!("{{\"ok\":true,\"version\":\"0.4.0\",\"port\":8790,\"dumpFirmware\":\"{}\",\"log\":\"/tmp/a.log\",\"boards\":2,\"receivers\":1}}", id)
        );
        assert_eq!(
            health_json("0.4.0", 8765, None, 0, 0),
            format!("{{\"ok\":true,\"version\":\"0.4.0\",\"port\":8765,\"dumpFirmware\":\"{}\",\"log\":null,\"boards\":0,\"receivers\":0}}", id)
        );
        // A build that carries a dump image says which one, so a stale copy is visible.
        assert!(!id.is_empty(), "the dump firmware should be compiled in");
        // The version is the crate's, not a string typed twice.
        assert!(health_json(env!("CARGO_PKG_VERSION"), 1, None, 0, 0)
            .contains(&format!("\"version\":\"{}\"", env!("CARGO_PKG_VERSION"))));
    }

    #[test]
    fn a_quote_in_a_port_error_cannot_break_the_json() {
        let ports = vec![PortInfo {
            key: "rx1".into(),
            port: "/dev/ttyUSB0".into(),
            usb: "".into(),
            status: "error".into(),
            error: Some("bad \"thing\"\n".into()),
        }];
        let json = ports_json(&ports, &[], None);
        assert!(json.contains("bad \\\"thing\\\"\\n"), "{}", json);
        assert!(json.ends_with("\"log\":null}"));
    }
}
