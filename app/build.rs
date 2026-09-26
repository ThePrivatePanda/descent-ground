// The receiver firmware is embedded when a merged image has been built. Until one
// exists the app still compiles and everything but flashing works.
use std::path::PathBuf;

fn main() {
    // include_dir! reads web/ when the macro expands and does not tell cargo about it,
    // so without this a build after only changing the dashboard keeps the old copy
    // inside the binary. It bit once already: the app served a UI that no longer
    // existed in the tree.
    let web = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web");
    println!("cargo:rerun-if-changed={}", web.display());

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

    // Stamped so the program can notice it is older than the tree it was built from.
    let built = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=DG_BUILT={}", built);

    // The ChipSat dump sketch, carried so a pull needs nothing installed. It has no
    // version of its own, so its hash is compiled in and shown: a copy that has fallen
    // behind the sketch is then visible instead of being guessed at.
    let chip = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../chipsat/firmware/flash_dump.bin");
    println!("cargo:rerun-if-changed={}", chip.display());
    let (chip_decl, chip_hash) = match std::fs::read(&chip) {
        Ok(bytes) => {
            let mut h: u64 = 0xcbf2_9ce4_8422_2325;
            for b in &bytes {
                h ^= *b as u64;
                h = h.wrapping_mul(0x1000_0000_01b3);
            }
            (
                format!("pub static CHIPSAT_DUMP: Option<&[u8]> = Some(include_bytes!({:?}));\n", chip),
                format!("pub static CHIPSAT_DUMP_ID: &str = {:?};\n", format!("{:016x}", h)),
            )
        }
        Err(_) => (
            String::from("pub static CHIPSAT_DUMP: Option<&[u8]> = None;\n"),
            String::from("pub static CHIPSAT_DUMP_ID: &str = \"\";\n"),
        ),
    };

    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("firmware.rs");
    let body = match &newest {
        Some(p) => format!(
            "pub static IMAGE: Option<&[u8]> = Some(include_bytes!({:?}));\npub static IMAGE_NAME: &str = {:?};\n",
            p,
            p.file_name().unwrap().to_string_lossy()
        ),
        None => String::from("pub static IMAGE: Option<&[u8]> = None;\npub static IMAGE_NAME: &str = \"\";\n"),
    };
    std::fs::write(out, format!("{}{}{}", body, chip_decl, chip_hash)).unwrap();
}
