// Bundled Node.js running desktop/host.mjs: line-delimited JSON over stdin/stdout.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use parking_lot::Mutex;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const STDERR_TAIL: usize = 4000;

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>;

pub struct Host {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
}

pub struct Ready {
    pub port: u16,
    pub token: String,
}

fn tail(buf: &Mutex<String>) -> String {
    buf.lock().clone()
}

pub fn spawn(node: &Path, script: &Path, on_exit: impl FnOnce(String) + Send + 'static) -> Result<(Host, Ready), String> {
    let mut child = Command::new(node)
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Could not start the bundled Node.js: {e}"))?;
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();

    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let stderr_thread = {
        let stderr_tail = stderr_tail.clone();
        thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            while let Ok(n) = stderr.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let mut buf = stderr_tail.lock();
                buf.push_str(&String::from_utf8_lossy(&chunk[..n]));
                if buf.len() > STDERR_TAIL {
                    let mut cut = buf.len() - STDERR_TAIL;
                    while !buf.is_char_boundary(cut) {
                        cut += 1;
                    }
                    buf.drain(..cut);
                }
            }
        })
    };

    let pending: Pending = Arc::default();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<Ready, String>>();
    {
        let pending = pending.clone();
        let stderr_tail = stderr_tail.clone();
        thread::spawn(move || {
            let mut ready_tx = Some(ready_tx);
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(tx) = &ready_tx {
                    match msg["event"].as_str() {
                        Some("ready") => {
                            let port = msg["port"].as_u64().and_then(|p| u16::try_from(p).ok());
                            let token = msg["token"].as_str().map(str::to_owned);
                            let _ = tx.send(match (port, token) {
                                (Some(port), Some(token)) => Ok(Ready { port, token }),
                                _ => Err(format!("The companion sent an invalid ready message: {line}")),
                            });
                            ready_tx = None;
                        }
                        Some("fatal") => {
                            let _ = tx.send(Err(msg["message"].as_str().unwrap_or("The companion could not start.").to_owned()));
                            ready_tx = None;
                        }
                        _ => {}
                    }
                    continue;
                }
                if let Some(id) = msg["id"].as_u64() {
                    if let Some(tx) = pending.lock().remove(&id) {
                        let _ = tx.send(msg);
                    }
                }
            }
            // stdout closed: the process is gone. Give stderr a moment to drain so the tail explains why.
            let deadline = Instant::now() + Duration::from_millis(500);
            while !stderr_thread.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(20));
            }
            pending.lock().clear();
            match ready_tx {
                Some(tx) => {
                    let _ = tx.send(Err(format!("The companion stopped before it was ready.\n\n{}", tail(&stderr_tail))));
                }
                None => on_exit(tail(&stderr_tail)),
            }
        });
    }

    let host = Host { child: Mutex::new(child), stdin: Mutex::new(stdin), pending, next_id: AtomicU64::new(1) };
    match ready_rx.recv_timeout(Duration::from_secs(60)) {
        Ok(Ok(ready)) => Ok((host, ready)),
        Ok(Err(e)) => {
            host.wait_exit(Duration::from_secs(5));
            Err(e)
        }
        Err(_) => {
            host.wait_exit(Duration::ZERO);
            Err("The companion did not start within 60 seconds.".into())
        }
    }
}

impl Host {
    fn write(&self, msg: &Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock();
        writeln!(stdin, "{msg}").and_then(|_| stdin.flush()).map_err(|_| "The companion is not running.".to_owned())
    }

    pub fn request(&self, mut msg: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        msg["id"] = json!(id);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().insert(id, tx);
        if let Err(e) = self.write(&msg) {
            self.pending.lock().remove(&id);
            return Err(e);
        }
        let reply = match rx.recv_timeout(timeout) {
            Ok(reply) => reply,
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err("The companion is not running.".into()),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().remove(&id);
                return Err("The companion did not answer.".into());
            }
        };
        if reply["ok"].as_bool() == Some(true) {
            Ok(reply)
        } else {
            Err(reply["error"].as_str().unwrap_or("The companion reported an error.").to_owned())
        }
    }

    /// Fire-and-forget quit for shutdown paths that cannot wait for the answer.
    pub fn send_quit(&self) {
        let _ = self.write(&json!({ "id": 0, "cmd": "quit" }));
    }

    /// Waits for the process to exit; kills it once `timeout` passes.
    pub fn wait_exit(&self, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        let mut child = self.child.lock();
        loop {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => return,
                Ok(None) if Instant::now() >= deadline => break,
                Ok(None) => thread::sleep(Duration::from_millis(100)),
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}
