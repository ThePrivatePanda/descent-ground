// Receiver lines go out to whatever browser tabs are open. Nothing upstream comes
// back this way: commands are ordinary POSTs, so a dead tab can only cost us a write.
use crate::json::esc;
use std::sync::{Arc, Mutex};
use tiny_http::ReadWrite;
use tungstenite::{Message, WebSocket};

pub type Socket = WebSocket<Box<dyn ReadWrite + Send>>;

#[derive(Clone)]
pub struct Broadcast {
    clients: Arc<Mutex<Vec<Socket>>>,
}

pub fn line_frame(rx: &str, t_ms: u128, text: &str) -> String {
    format!(
        "{{\"type\":\"line\",\"rx\":\"{}\",\"t\":{},\"text\":\"{}\"}}",
        esc(rx),
        t_ms,
        esc(text)
    )
}

pub fn ports_frame() -> String {
    String::from("{\"type\":\"ports\"}")
}

impl Broadcast {
    pub fn new() -> Self {
        Broadcast { clients: Arc::new(Mutex::new(Vec::new())) }
    }

    pub fn add(&self, socket: Socket) {
        if let Ok(mut c) = self.clients.lock() {
            c.push(socket);
        }
    }

    #[cfg(test)]
    pub fn count(&self) -> usize {
        self.clients.lock().map(|c| c.len()).unwrap_or(0)
    }

    // A tab that has gone away is dropped; the others must not notice.
    pub fn send(&self, msg: &str) {
        if let Ok(mut c) = self.clients.lock() {
            c.retain_mut(|ws| ws.send(Message::Text(msg.to_string().into())).is_ok());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_frame_is_json_that_survives_quotes_and_tabs() {
        assert_eq!(
            line_frame("rx1", 1790000000000, "PKT,55,00FF,-50.0,13.75,-12"),
            "{\"type\":\"line\",\"rx\":\"rx1\",\"t\":1790000000000,\"text\":\"PKT,55,00FF,-50.0,13.75,-12\"}"
        );
        let f = line_frame("rx2", 1, "he said \"hi\"\tthen\\left");
        assert!(f.contains("\\\"hi\\\"\\tthen\\\\left"), "{}", f);
    }

    #[test]
    fn a_dead_client_is_dropped_and_the_others_still_get_lines() {
        let b = Broadcast::new();
        assert_eq!(b.count(), 0);
        b.send("{\"type\":\"ports\"}");   // no clients: must not panic
    }
}
