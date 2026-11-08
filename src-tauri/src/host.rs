// Bundled Bun running desktop/host.mjs: line-delimited JSON over stdin/stdout.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use parking_lot::Mutex;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const STDERR_TAIL: usize = 4000;

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>;

pub struct Host {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
    tree: Tree,
}

// Bun and every process it starts, however deep. Killing Bun alone (or Bun exiting after quit) left the rest running:
// processes that OMP's tools and MCP servers start through cmd or .cmd shims, terminals opened with `start`. libuv ends
// Bun's direct children with it, but lets their own children leave its job. On Windows those inherit Bun's listening socket,
// so the next launch found port 4545 taken by a process whose owner had exited and refused to start ("already running").
// Windows: a job object that allows no breakaway, so those grandchildren stay in it. Its last handle closing (the app
// exiting, even by a crash) ends every process in it. Bun is assigned right after it starts, before it has loaded anything.
#[cfg(windows)]
struct Tree(windows_sys::Win32::Foundation::HANDLE);
// Unix: Bun leads its own process group, which its children join unless they start their own session.
#[cfg(unix)]
struct Tree(i32);

// The job handle is only passed to job APIs, which may be called from any thread.
#[cfg(windows)]
unsafe impl Send for Tree {}
#[cfg(windows)]
unsafe impl Sync for Tree {}

#[cfg(windows)]
impl Tree {
    fn new(child: &Child) -> Result<Tree, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(format!("Could not create a job object for the companion: {}", std::io::Error::last_os_error()));
        }
        let tree = Tree(job);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        let ok = unsafe {
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits as *const _ as *const _, size) != 0
                && AssignProcessToJobObject(job, child.as_raw_handle()) != 0
        };
        if !ok {
            return Err(format!("Could not put the companion in a job object: {}", std::io::Error::last_os_error()));
        }
        Ok(tree)
    }

    fn end(&self) {
        unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1) };
    }
}

#[cfg(windows)]
impl Drop for Tree {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(unix)]
impl Tree {
    fn new(child: &Child) -> Result<Tree, String> {
        Ok(Tree(child.id() as i32))
    }

    fn end(&self) {
        unsafe { libc::kill(-self.0, libc::SIGKILL) };
    }
}

pub struct Ready {
    pub port: u16,
    pub token: String,
}

fn tail(buf: &Mutex<String>) -> String {
    buf.lock().clone()
}

/// `restart_token` restarts a host after a crash: it keeps the window's token and skips the `omp update` check.
pub fn spawn(
    bun: &Path,
    script: &Path,
    restart_token: Option<&str>,
    on_event: impl Fn(Value) + Send + 'static,
    on_exit: impl FnOnce(String) + Send + 'static,
) -> Result<(Host, Ready), String> {
    let mut cmd = Command::new(bun);
    // `npm run desktop` (debug build) skips the token by default; release builds keep it unless the user opts out.
    if cfg!(debug_assertions) && std::env::var_os("OMP_WEB_NO_TOKEN").is_none() {
        cmd.env("OMP_WEB_NO_TOKEN", "1");
    }
    if let Some(token) = restart_token {
        cmd.env("OMP_WEB_DESKTOP_TOKEN", token).env("OMP_WEB_NO_UPDATE", "1");
    }
    cmd.arg(script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // A GUI app has no console; without this flag Windows opens one for Bun.
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().map_err(|e| format!("Could not start the bundled Bun: {e}"))?;
    let tree = match Tree::new(&child) {
        Ok(tree) => tree,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
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
                } else if msg["event"].is_string() {
                    // Unsolicited events after ready (e.g. "attention").
                    on_event(msg);
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

    let host = Host { child: Mutex::new(child), stdin: Mutex::new(stdin), pending, next_id: AtomicU64::new(1), tree };
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

    /// The process has not exited yet (it may still be stuck).
    pub fn running(&self) -> bool {
        matches!(self.child.lock().try_wait(), Ok(None))
    }

    /// Waits for the process to exit; kills it once `timeout` passes. Either way, then ends every process it started.
    pub fn wait_exit(&self, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        let mut child = self.child.lock();
        loop {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                Ok(None) => thread::sleep(Duration::from_millis(100)),
            }
        }
        self.tree.end();
    }
}
