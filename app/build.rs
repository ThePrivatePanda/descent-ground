// The receiver firmware is embedded when a merged image has been built. Until one
// exists the app still compiles and everything but flashing works.
use std::path::PathBuf;

fn main() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../receiver/firmware");
    println!("cargo:rerun-if-changed={}", dir.display());

    let mut newest: Option<PathBuf> = None;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "bin").unwrap_or(false) {
                if newest.as_ref().map(|n| p > *n).unwrap_or(true) {
                    newest = Some(p);
                }
            }
        }
    }

    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("firmware.rs");
    let body = match &newest {
        Some(p) => format!(
            "pub static IMAGE: Option<&[u8]> = Some(include_bytes!({:?}));\npub static IMAGE_NAME: &str = {:?};\n",
            p,
            p.file_name().unwrap().to_string_lossy()
        ),
        None => String::from("pub static IMAGE: Option<&[u8]> = None;\npub static IMAGE_NAME: &str = \"\";\n"),
    };
    std::fs::write(out, body).unwrap();
}
