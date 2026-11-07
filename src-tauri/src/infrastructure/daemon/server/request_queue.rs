//! 有界请求执行器：会话内 FIFO、跨会话并行，全局操作作为顺序屏障。
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
#[cfg(not(test))]
use std::io::Write;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const WORKERS: usize = 4;
const MAX_QUEUED: usize = 256;
const MAX_QUEUED_BYTES: usize = 16 * 1024 * 1024;
const MAX_CLIENT_QUEUED: usize = 64;
const SLOW_AFTER: Duration = Duration::from_secs(5);

#[derive(Clone, Copy)]
pub(super) enum Stage {
    Handler,
    SessionLock,
    ReplayRead,
    PtyWrite,
    PtyResize,
    Reply,
}

thread_local! {
    static CURRENT_STAGE: RefCell<Option<Arc<AtomicU8>>> = const { RefCell::new(None) };
}

// 只更新当前执行器任务的原子状态；直接调用 handler 的旧调用方无需额外上下文。
pub(super) fn stage(stage: Stage) {
    CURRENT_STAGE.with(|current| {
        if let Some(value) = current.borrow().as_ref() {
            value.store(stage as u8, Ordering::Relaxed);
        }
    });
}

struct Job {
    key: Option<String>,
    client: u64,
    request: u64,
    operation: &'static str,
    bytes: usize,
    work: Box<dyn FnOnce() + Send>,
}

struct Active {
    key: Option<String>,
    client: u64,
    request: u64,
    operation: &'static str,
    started: Instant,
    stage: Arc<AtomicU8>,
}

#[derive(Default)]
struct State {
    queue: VecDeque<Job>,
    queued_bytes: usize,
    active: HashMap<usize, Active>,
    stopped: bool,
}

type Shared = Arc<(Mutex<State>, Condvar)>;

pub(super) struct RequestQueue {
    shared: Shared,
}

impl RequestQueue {
    // 每个宿主固定四个 worker；重连不会增加被阻塞的工作线程数量。
    pub(super) fn new() -> Self {
        let shared = Arc::new((Mutex::new(State::default()), Condvar::new()));
        for worker in 0..WORKERS {
            let state = Arc::clone(&shared);
            std::thread::spawn(move || run_worker(state, worker));
        }
        #[cfg(not(test))]
        spawn_diagnostics(&shared);
        Self { shared }
    }

    // 只入队，绝不在网络 reader 中等待 PTY；超量拒绝，调用方必须关闭该客户端。
    pub(super) fn submit(
        &self,
        key: Option<String>,
        client: u64,
        request: u64,
        operation: &'static str,
        bytes: usize,
        work: impl FnOnce() + Send + 'static,
    ) -> bool {
        let (lock, changed) = &*self.shared;
        let Ok(mut state) = lock.lock() else {
            return false;
        };
        if state.stopped
            || state.queue.len() >= MAX_QUEUED
            || state.queued_bytes.saturating_add(bytes) > MAX_QUEUED_BYTES
            || state
                .queue
                .iter()
                .filter(|job| job.client == client)
                .count()
                >= MAX_CLIENT_QUEUED
        {
            return false;
        }
        state.queued_bytes += bytes;
        state.queue.push_back(Job {
            key,
            client,
            request,
            operation,
            bytes,
            work: Box::new(work),
        });
        changed.notify_all();
        true
    }

    // 丢弃断连客户端尚未开始的操作；已执行的系统调用不能安全中断，不强杀任务。
    pub(super) fn cancel_client(&self, client: u64) {
        let (lock, changed) = &*self.shared;
        if let Ok(mut state) = lock.lock() {
            state.queue.retain(|job| job.client != client);
            state.queued_bytes = state.queue.iter().map(|job| job.bytes).sum();
            changed.notify_all();
        }
    }
}

impl Drop for RequestQueue {
    fn drop(&mut self) {
        let (lock, changed) = &*self.shared;
        if let Ok(mut state) = lock.lock() {
            state.stopped = true;
            state.queue.clear();
            changed.notify_all();
        }
    }
}

// 全局屏障不能越过先前任务，后续会话任务也不能越过屏障；同 key 的任务只占一个 worker。
fn runnable(state: &State) -> Option<usize> {
    if state.active.values().any(|active| active.key.is_none()) {
        return None;
    }
    for (index, job) in state.queue.iter().enumerate() {
        if job.key.is_none() {
            return (index == 0 && state.active.is_empty()).then_some(index);
        }
        if !state.active.values().any(|active| active.key == job.key) {
            return Some(index);
        }
    }
    None
}

// 业务执行期间不持队列锁，诊断线程与其他会话仍可检查进度。
fn run_worker(shared: Shared, worker: usize) {
    loop {
        let job = {
            let (lock, changed) = &*shared;
            let mut state = lock.lock().unwrap();
            loop {
                if state.stopped {
                    return;
                }
                if let Some(index) = runnable(&state) {
                    let job = state.queue.remove(index).unwrap();
                    state.queued_bytes -= job.bytes;
                    let stage = Arc::new(AtomicU8::new(Stage::Handler as u8));
                    CURRENT_STAGE.with(|current| *current.borrow_mut() = Some(Arc::clone(&stage)));
                    state.active.insert(
                        worker,
                        Active {
                            key: job.key.clone(),
                            client: job.client,
                            request: job.request,
                            operation: job.operation,
                            started: Instant::now(),
                            stage,
                        },
                    );
                    break job;
                }
                state = changed.wait(state).unwrap();
            }
        };
        // 一个 handler panic 不能永久占住 key 或消耗固定 worker；不记录请求/异常正文。
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job.work));
        CURRENT_STAGE.with(|current| *current.borrow_mut() = None);
        let (lock, changed) = &*shared;
        lock.lock().unwrap().active.remove(&worker);
        changed.notify_all();
        if result.is_err() {
            log::warn!("daemon request worker recovered from handler panic");
        }
    }
}

// 明确白名单的快照不含输入、输出、环境、token 或路径；session 仅保留散列关联值。
fn slow_snapshot(state: &State) -> Vec<serde_json::Value> {
    state
        .active
        .values()
        .filter(|active| active.started.elapsed() >= SLOW_AFTER)
        .map(|active| {
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            active.key.hash(&mut hash);
            let stage = match active.stage.load(Ordering::Relaxed) {
                1 => "session_lock",
                2 => "replay_read",
                3 => "pty_write",
                4 => "pty_resize",
                5 => "reply",
                _ => "handler",
            };
            serde_json::json!({
                "event": "slow_request", "client": active.client, "request": active.request,
                "sessionHash": format!("{:016x}", hash.finish()), "operation": active.operation,
                "stage": stage, "elapsedMs": active.started.elapsed().as_millis() as u64,
                "queued": state.queue.len(), "queuedBytes": state.queued_bytes,
            })
        })
        .collect()
}

// 一个独立 reporter 记录尚未完成的请求；文件写失败不影响执行器，持续阻塞每 30 秒最多一批。
#[cfg(not(test))]
fn spawn_diagnostics(shared: &Shared) {
    let weak = Arc::downgrade(shared);
    std::thread::spawn(move || {
        let name = if cfg!(debug_assertions) {
            "pty-host.dev.log"
        } else {
            "pty-host.log"
        };
        let mut writer = crate::app_paths::logs_dir()
            .ok()
            .and_then(|dir| crate::log_rotation::create_log_writer(dir, name).ok());
        let mut last_report: Option<Instant> = None;
        loop {
            std::thread::sleep(SLOW_AFTER);
            let Some(shared) = weak.upgrade() else {
                return;
            };
            let snapshot = {
                let state = shared.0.lock().unwrap();
                if state.stopped {
                    return;
                }
                slow_snapshot(&state)
            };
            if snapshot.is_empty() {
                last_report = None;
                continue;
            }
            if last_report.is_some_and(|last| last.elapsed() < Duration::from_secs(30)) {
                continue;
            }
            last_report = Some(Instant::now());
            if let Some(writer) = writer.as_mut() {
                for entry in snapshot {
                    let _ = writeln!(writer, "{} {}", chrono::Utc::now().to_rfc3339(), entry);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests;
