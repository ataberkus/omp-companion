use std::{env, fs, path::Path, process::Command};

fn main() {
    bundle_bun();
    tauri_build::build()
}

// The app ships the Bun that built it as binaries/bun-<target> (bun-<target>.exe on Windows; tauri externalBin): OMP's SDK
// runs on Bun. OMP_BUN names another Bun executable instead, which a build for another CPU needs (an Intel Mac app built
// on Apple silicon, say): the Bun on PATH runs on this machine, not on the target.
// After a Bun upgrade, delete src-tauri/binaries/ to refresh the bundled copy.
fn bundle_bun() {
    println!("cargo:rerun-if-env-changed=OMP_BUN");
    let target = env::var("TARGET").expect("TARGET is set by cargo");
    let suffix = if target.contains("windows") { ".exe" } else { "" };
    let dest = Path::new("binaries").join(format!("bun-{target}{suffix}"));
    if dest.exists() {
        return;
    }
    let bun = match env::var("OMP_BUN").ok().filter(|p| !p.is_empty()) {
        Some(bun) => bun,
        None => {
            let host = env::var("HOST").expect("HOST is set by cargo");
            let arch = |triple: &str| triple.split('-').next().unwrap_or_default().to_owned();
            if arch(&host) != arch(&target) {
                panic!("Building for {target} on {host}: set OMP_BUN to a Bun executable for {target}; the Bun on PATH cannot run there.");
            }
            let missing = || panic!("Bun must be on PATH: it is bundled into the app as binaries/bun-<target>{suffix}");
            let output = Command::new("bun").args(["-p", "process.execPath"]).output().unwrap_or_else(|_| missing());
            if !output.status.success() {
                missing();
            }
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
    };
    fs::create_dir_all("binaries").expect("create src-tauri/binaries");
    // fs::copy keeps the executable bit on macOS and Linux.
    fs::copy(&bun, &dest).unwrap_or_else(|e| panic!("copy {bun} to {}: {e}", dest.display()));
}
