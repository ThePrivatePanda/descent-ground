// Four fields of JSON are not worth a serialisation crate, but they are worth
// escaping properly: a port error carries whatever the OS said.
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

// The one integer we read back out of a request body.
pub fn int_field(body: &str, name: &str) -> Option<i64> {
    let pat = format!("\"{}\"", name);
    let at = body.find(&pat)? + pat.len();
    let rest = &body[at..];
    let rest = rest.trim_start().strip_prefix(':')?.trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '-').collect();
    digits.parse().ok()
}

pub fn str_field(body: &str, name: &str) -> Option<String> {
    let pat = format!("\"{}\"", name);
    let at = body.find(&pat)? + pat.len();
    let rest = &body[at..];
    let rest = rest.trim_start().strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_what_would_break_a_line() {
        assert_eq!(esc("a\"b\\c\nd\te"), "a\\\"b\\\\c\\nd\\te");
    }

    #[test]
    fn reads_the_fields_the_page_sends() {
        assert_eq!(int_field("{\"sf\":12}", "sf"), Some(12));
        assert_eq!(int_field("{ \"sf\" : 7 }", "sf"), Some(7));
        assert_eq!(int_field("{\"sf\":\"twelve\"}", "sf"), None);
        assert_eq!(int_field("{}", "sf"), None);
        assert_eq!(str_field("{\"image\":\"/tmp/a.bin\"}", "image"), Some("/tmp/a.bin".into()));
        assert_eq!(str_field("{\"sf\":12}", "image"), None);
    }
}
