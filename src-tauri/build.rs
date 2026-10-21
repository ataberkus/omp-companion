use std::{env, fs, path::Path, process::Command};

fn main() {
    bundle_bun();
    tauri_build::build()
}

// The app ships the Bun that built it as binaries/bun-<target>.exe (tauri externalBin): OMP's SDK runs on Bun.
// After a Bun upgrade, delete src-tauri/binaries/ to refresh the bundled copy.
fn bundle_bun() {
    let target = env::var("TARGET").expect("TARGET is set by cargo");
    let dest = Path::new("binaries").join(format!("bun-{target}.exe"));
    if dest.exists() {
        return;
    }
    let missing = || panic!("Bun must be on PATH: it is bundled into the app as binaries/bun-<target>.exe");
    let output = Command::new("bun").args(["-p", "process.execPath"]).output().unwrap_or_else(|_| missing());
    if !output.status.success() {
        missing();
    }
    let bun = String::from_utf8_lossy(&output.stdout).trim().to_string();
    fs::create_dir_all("binaries").expect("create src-tauri/binaries");
    fs::copy(&bun, &dest).unwrap_or_else(|e| panic!("copy {bun} to {}: {e}", dest.display()));
}
