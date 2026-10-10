use std::{env, fs, path::Path, process::Command};

fn main() {
    bundle_node();
    tauri_build::build()
}

// The app ships the Node.js that built it as binaries/node-<target>.exe (tauri externalBin).
// After a Node upgrade, delete src-tauri/binaries/ to refresh the bundled copy.
fn bundle_node() {
    let target = env::var("TARGET").expect("TARGET is set by cargo");
    let dest = Path::new("binaries").join(format!("node-{target}.exe"));
    if dest.exists() {
        return;
    }
    let missing = || panic!("Node.js 22+ must be on PATH: it is bundled into the app as binaries/node-<target>.exe");
    let output = Command::new("node").args(["-p", "process.execPath"]).output().unwrap_or_else(|_| missing());
    if !output.status.success() {
        missing();
    }
    let node = String::from_utf8_lossy(&output.stdout).trim().to_string();
    fs::create_dir_all("binaries").expect("create src-tauri/binaries");
    fs::copy(&node, &dest).unwrap_or_else(|e| panic!("copy {node} to {}: {e}", dest.display()));
}
