// The dashboard, and the few calls it makes back. Bound to 127.0.0.1 only: this is
// the operator's own laptop, not a service.
use crate::json::{esc, int_field};
use crate::serial::{Board, Hub, PortInfo};
use crate::ws::{Broadcast, Socket};
use crate::{assets, flash};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
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
                "{{\"port\":\"{}\",\"usb\":\"{}\",\"label\":\"{}\",\"serial\":\"{}\",\"state\":\"{}\"}}",
                esc(&b.port),
                esc(&b.usb),
                esc(&b.label),
                esc(&b.serial),
                esc(&b.state)
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

pub fn bind() -> Result<Bound, String> {
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

fn ours_is_listening(port: u16) -> bool {
    use std::io::{Read, Write};
    let addr = format!("127.0.0.1:{}", port);
    let mut s = match std::net::TcpStream::connect(&addr) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = s.set_read_timeout(Some(std::time::Duration::from_millis(500)));
    if s.write_all(b"GET /api/ports HTTP/1.0\r\n\r\n").is_err() {
        return false;
    }
    let mut buf = String::new();
    let _ = s.take(2048).read_to_string(&mut buf);
    buf.contains("\"ports\"")
}

pub struct Ctx {
    pub hub: Arc<Mutex<Hub>>,
    pub broadcast: Broadcast,
    pub log: Option<PathBuf>,
    pub dir: PathBuf,
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

    if path == "/api/ports" {
        let (ports, boards) = match ctx.hub.lock() {
            Ok(h) => (h.ports(), h.boards()),
            Err(_) => (Vec::new(), Vec::new()),
        };
        let body = ports_json(&ports, &boards, ctx.log.as_ref().and_then(|p| p.to_str()));
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
                Some(sf) if (7..=12).contains(&sf) => {
                    ctx.hub.lock().unwrap().send(&key, &format!("#SET,sf,{}\n", sf))
                }
                Some(sf) => Err(format!("spreading factor {} is not between 7 and 12", sf)),
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
        }];
        let json = ports_json(&ports, &boards, Some("/tmp/a.log"));
        assert_eq!(json, "{\"ports\":[{\"key\":\"rx1\",\"port\":\"/dev/ttyUSB0\",\"usb\":\"10c4:ea60\",\"status\":\"open\",\"error\":null}],\"boards\":[{\"port\":\"/dev/ttyACM0\",\"usb\":\"1a86:55d4\",\"label\":\"CH9102\",\"serial\":\"58A1\",\"state\":\"waiting\"}],\"log\":\"/tmp/a.log\"}");
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
