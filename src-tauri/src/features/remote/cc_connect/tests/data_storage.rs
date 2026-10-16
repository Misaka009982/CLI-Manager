use super::*;
#[cfg(target_os = "windows")]
use std::process::Child;

// 空闲预检只持有操作锁，不创建服务、授权文件或用户配置。
#[test]
fn idle_guard_is_held_until_switch_preparation_finishes() {
    let manager = CcConnectManager::new();
    let guard = manager.data_storage_idle_guard().unwrap();
    assert!(manager.operation.try_lock().is_err());
    assert!(manager.process.lock().unwrap().process.is_none());
    assert!(manager.weixin_authorization.lock().unwrap().is_none());
    drop(guard);
    assert!(manager.operation.try_lock().is_ok());
}

// 并发管理操作未完成时立即拒绝，不等待它并假定空闲。
#[test]
fn busy_operation_rejects_data_storage_switch() {
    let manager = CcConnectManager::new();
    let _operation = manager.operation.lock().unwrap();
    assert_eq!(
        manager.data_storage_idle_guard().unwrap_err(),
        "data_storage_tasks_active"
    );
}

// 已登记启动状态仍视为活动；预检不会替用户取消启动。
#[test]
fn starting_remote_service_rejects_data_storage_switch() {
    let manager = CcConnectManager::new();
    manager.process.lock().unwrap().starting = true;
    assert_eq!(
        manager.data_storage_idle_guard().unwrap_err(),
        "data_storage_tasks_active"
    );
    assert!(manager.process.lock().unwrap().starting);
    assert!(manager.operation.try_lock().is_ok());
}

// 状态锁损坏时失败关闭，不能用未知状态绕过活动服务检查。
#[test]
fn poisoned_process_state_rejects_data_storage_switch() {
    let manager = CcConnectManager::new();
    let state = manager.process.clone();
    let _ = std::thread::spawn(move || {
        let _state = state.lock().unwrap();
        panic!("test poison");
    })
    .join();
    assert_eq!(
        manager.data_storage_idle_guard().unwrap_err(),
        "data_storage_tasks_active"
    );
}

// Windows 只创建由测试 Job Object 管理的隐藏子进程，退出测试时由该 Job 清理。
#[cfg(target_os = "windows")]
fn owned_test_process() -> (Child, ChildJob) {
    use std::os::windows::process::CommandExt;
    let mut child = std::process::Command::new("cmd")
        .args(["/D", "/C", "ping -n 30 127.0.0.1 >nul"])
        .creation_flags(0x0800_0000)
        .spawn()
        .unwrap();
    let job = match ChildJob::assign(&child, "data-storage-test") {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            panic!("test child Job assignment failed: {error}");
        }
    };
    (child, job)
}

// 活动受管服务保持运行并被预检拒绝，不因切换请求被停止。
#[cfg(target_os = "windows")]
#[test]
fn running_remote_service_rejects_without_stopping_child() {
    let manager = CcConnectManager::new();
    let (child, job) = owned_test_process();
    manager.process.lock().unwrap().process = Some(ManagedProcess {
        child,
        job,
        started_at_ms: 0,
    });
    assert_eq!(
        manager.data_storage_idle_guard().unwrap_err(),
        "data_storage_tasks_active"
    );
    let mut state = manager.process.lock().unwrap();
    assert!(state
        .process
        .as_mut()
        .unwrap()
        .child
        .try_wait()
        .unwrap()
        .is_none());
    let mut process = state.process.take().unwrap();
    process.job.terminate();
    process.child.wait().unwrap();
}

// 微信授权会写同一数据根，亦拒绝迁移；不会读取真实授权资料或取消扫码。
#[cfg(target_os = "windows")]
#[test]
fn running_authorization_rejects_without_stopping_child() {
    let manager = CcConnectManager::new();
    let (child, job) = owned_test_process();
    *manager.weixin_authorization.lock().unwrap() = Some(WeixinAuthorizationState::Running(
        WeixinAuthorizationProcess {
            child,
            job,
            profile: sample_profile(Path::new("test-project")),
            config_path: PathBuf::new(),
            qr_path: PathBuf::new(),
            stdout_path: PathBuf::new(),
            stderr_path: PathBuf::new(),
            started_at_ms: 0,
        },
    ));
    assert_eq!(
        manager.data_storage_idle_guard().unwrap_err(),
        "data_storage_tasks_active"
    );
    let mut state = manager.weixin_authorization.lock().unwrap();
    let Some(WeixinAuthorizationState::Running(process)) = state.as_mut() else {
        panic!("missing test process")
    };
    assert!(process.child.try_wait().unwrap().is_none());
    process.job.terminate();
    process.child.wait().unwrap();
    state.take();
}
