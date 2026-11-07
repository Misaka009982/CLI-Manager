use super::*;
use std::sync::mpsc;

// 用通道固定慢操作的开始和释放；同会话后续任务及全局屏障均不得提前执行。
#[test]
fn session_fifo_and_global_barriers_preserve_order() {
    let queue = RequestQueue::new();
    let (started, start) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let (sent, done) = mpsc::channel();
    queue.submit(Some("a".into()), 1, 1, "attach", 1, move || {
        started.send(()).unwrap();
        wait.recv().unwrap();
    });
    start.recv_timeout(Duration::from_secs(1)).unwrap();
    for (key, n) in [(Some("a".into()), 2), (None, 3), (Some("b".into()), 4)] {
        let sent = sent.clone();
        assert!(queue.submit(key, 1, n, "test", 1, move || {
            sent.send(n).unwrap();
        }));
    }
    let premature = done.recv_timeout(Duration::from_millis(30));
    release.send(()).unwrap();
    let actual: Vec<_> = (0..3)
        .map(|_| done.recv_timeout(Duration::from_secs(1)).unwrap())
        .collect();
    assert!(premature.is_err());
    assert_eq!(actual, [2, 3, 4]);
}

// 断连移除排队操作与字节预算，正在执行的任务仅在测试主动释放后结束。
#[test]
fn queue_bounds_and_client_cancellation_do_not_execute_waiting_input() {
    let queue = RequestQueue::new();
    let (started, start) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    queue.submit(Some("a".into()), 1, 1, "write", 1, move || {
        started.send(()).unwrap();
        wait.recv().unwrap();
    });
    start.recv_timeout(Duration::from_secs(1)).unwrap();
    for n in 0..MAX_CLIENT_QUEUED {
        assert!(
            queue.submit(Some("a".into()), 1, n as u64, "write", 1, || panic!(
                "cancelled input ran"
            ))
        );
    }
    assert!(!queue.submit(Some("a".into()), 1, 99, "write", 1, || {}));
    queue.cancel_client(1);
    assert_eq!(queue.shared.0.lock().unwrap().queued_bytes, 0);
    assert!(!queue.submit(
        Some("b".into()),
        2,
        100,
        "write",
        MAX_QUEUED_BYTES + 1,
        || {}
    ));
    release.send(()).unwrap();
}

// 快照仅输出静态操作和阶段，攻击者控制的会话 key 不得进入落盘内容。
#[test]
fn slow_diagnostics_observe_inflight_work_without_leaking_session_text() {
    let mut state = State::default();
    state.active.insert(
        0,
        Active {
            key: Some("secret-token-private-command".into()),
            client: 1,
            request: 2,
            operation: "attach",
            started: Instant::now() - Duration::from_secs(6),
            stage: Arc::new(AtomicU8::new(Stage::SessionLock as u8)),
        },
    );
    let snapshot = slow_snapshot(&state);
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0]["stage"], "session_lock");
    assert!(!serde_json::to_string(&snapshot)
        .unwrap()
        .contains("secret-token-private-command"));
}

// handler panic 不得遗留 active key，后续同会话请求仍可执行。
#[test]
fn panicked_handler_releases_its_session_lane() {
    let queue = RequestQueue::new();
    let (sent, done) = mpsc::channel();
    assert!(queue.submit(Some("a".into()), 1, 1, "test", 1, || panic!(
        "injected failure"
    )));
    assert!(queue.submit(Some("a".into()), 1, 2, "test", 1, move || {
        sent.send(()).unwrap();
    }));
    done.recv_timeout(Duration::from_secs(1)).unwrap();
}
