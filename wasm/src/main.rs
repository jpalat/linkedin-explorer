//! Native counterpart of the in-browser build, for checking output or scripting.
//!
//! Usage: linkedin-build <export.zip | export dir>... [-o data.json]
//! Later exports override files from earlier ones.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use linkedin_export::Export;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let out = match args.iter().position(|a| a == "-o") {
        Some(i) => {
            let o = args.get(i + 1).cloned().unwrap_or_else(|| die("-o needs a path"));
            args.drain(i..=i + 1);
            o
        }
        None => "data.json".into(),
    };
    if args.is_empty() {
        die("usage: linkedin-build <export.zip | export dir>... [-o data.json]");
    }
    let mut export = Export::default();
    for a in &args {
        let p = Path::new(a);
        if p.is_dir() {
            add_dir(&mut export, p);
        } else {
            let bytes = std::fs::read(p).unwrap_or_else(|e| die(&format!("{a}: {e}")));
            let n = export.add_zip(&bytes).unwrap_or_else(|e| die(&format!("{a}: {e}")));
            eprintln!("{a}: {n} CSV files");
        }
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    let json = export.build(now);
    std::fs::write(&out, &json).unwrap_or_else(|e| die(&format!("{out}: {e}")));
    eprintln!("Wrote {out} ({:.1} MB)", json.len() as f64 / 1e6);
}

fn add_dir(export: &mut Export, dir: &Path) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = entry.path();
        if p.is_dir() {
            add_dir(export, &p);
        } else if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("csv")) {
            if let (Some(name), Ok(bytes)) = (p.file_name().and_then(|n| n.to_str()), std::fs::read(&p)) {
                export.add_file(name, bytes);
            }
        }
    }
}

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1)
}
