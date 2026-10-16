use super::super::{migrate_data_root, path_is_symlink_or_reparse};
use super::*;
use std::fs;
use std::path::PathBuf;

// 每次只使用独立临时源/目标，确保测试不读取或迁移用户配置。
fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::Builder::new().prefix("ds").tempdir().unwrap();
    let source = temp.path().join("src");
    let target = temp.path().join("dst");
    fs::create_dir(&source).unwrap();
    (temp, source, target)
}

#[cfg(target_os = "windows")]
type TestListener = LocalSocket;
#[cfg(unix)]
type TestListener = std::os::unix::net::UnixListener;

// 创建真实 Windows AF_UNIX 端点，关闭句柄后磁盘节点仍保留。
#[cfg(target_os = "windows")]
fn listener(path: &Path) -> TestListener {
    use windows_sys::Win32::Networking::WinSock::{bind, listen};
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let socket = LocalSocket::new().unwrap();
    let address = socket_address(path).unwrap();
    assert_ne!(
        unsafe {
            bind(
                socket.handle,
                &address as *const SOCKADDR_UN as *const SOCKADDR,
                std::mem::size_of::<SOCKADDR_UN>() as i32,
            )
        },
        SOCKET_ERROR,
        "bind failed: {}",
        unsafe { WSAGetLastError() }
    );
    assert_ne!(unsafe { listen(socket.handle, 8) }, SOCKET_ERROR);
    socket
}

// Unix 使用真实监听器覆盖同一残留节点场景，不改 GUI 平台支持范围。
#[cfg(unix)]
fn listener(path: &Path) -> TestListener {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::os::unix::net::UnixListener::bind(path).unwrap()
}

// 校验迁移失败不会激活目标，临时树已清理，源节点仍然存在。
fn assert_failed_migration_is_safe(temp: &Path, source: &Path, target: &Path, socket: &Path) {
    assert!(source.exists());
    assert!(fs::symlink_metadata(socket).is_ok());
    assert!(!target.exists());
    assert!(fs::read_dir(temp).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".cli-manager-migrate-")
    }));
}

// 真实已关闭端点仅被跳过，持久化文件逐字节复制，源端点及数据均不删除。
#[test]
fn closed_owned_socket_preserves_persistent_data_and_source() {
    let (_temp, source, target) = fixture();
    let socket = source.join(OWNED_SOCKET_PATH);
    drop(listener(&socket));
    assert!(fs::symlink_metadata(&socket).is_ok());
    #[cfg(target_os = "windows")]
    assert!(path_is_symlink_or_reparse(&socket).unwrap());
    let files = [
        "cli-manager.db",
        "cli-manager.db-wal",
        "cli-manager.db-shm",
        "providers.db",
        "settings.json",
        "sessions.json",
        "remote-manager/profile.json",
        "remote-manager/data/sessions/session.json",
        "attachments/test.png",
        "unknown/nested/data.bin",
    ];
    for (index, relative) in files.iter().enumerate() {
        let path = source.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, format!("persisted-{index}")).unwrap();
    }
    assert!(should_skip_runtime_socket(&source, &socket).unwrap());
    migrate_data_root(&source, &target).unwrap();
    for relative in files {
        assert_eq!(
            fs::read(source.join(relative)).unwrap(),
            fs::read(target.join(relative)).unwrap()
        );
    }
    assert!(fs::symlink_metadata(socket).is_ok());
    assert!(!target.join(OWNED_SOCKET_PATH).exists());
    assert!(target.join("remote-manager/data/run").is_dir());
}

// 活动端点即使位于固定路径也拒绝，不向 API 发送请求、不关闭服务端。
#[test]
fn listening_owned_socket_is_rejected_without_activation() {
    let (temp, source, target) = fixture();
    let socket = source.join(OWNED_SOCKET_PATH);
    let _listener = listener(&socket);
    assert_eq!(
        should_skip_runtime_socket(&source, &socket).unwrap_err(),
        "data_storage_tasks_active"
    );
    assert_eq!(
        migrate_data_root(&source, &target).unwrap_err(),
        "data_storage_tasks_active"
    );
    assert_failed_migration_is_safe(temp.path(), &source, &target, &socket);
}

// 未知或嵌套项目中的同名端点不属于应用运行边界，仍按特殊节点拒绝。
#[test]
fn unknown_socket_paths_are_not_silently_skipped() {
    for relative in [
        "api.sock",
        "remote-manager/data/other/api.sock",
        "project/remote-manager/data/run/api.sock",
    ] {
        let (temp, source, target) = fixture();
        let socket = source.join(relative);
        drop(listener(&socket));
        assert!(!should_skip_runtime_socket(&source, &socket).unwrap());
        let error = migrate_data_root(&source, &target).unwrap_err();
        assert!(
            error.starts_with("data_storage_migration_symlink_rejected:")
                || error.starts_with("data_storage_migration_unsupported_entry:"),
            "{error}"
        );
        assert_failed_migration_is_safe(temp.path(), &source, &target, &socket);
    }
}

// 固定名称不是充分条件：同名普通文件必须复制，不因扩展名或零长度丢失。
#[test]
fn regular_owned_socket_named_file_is_copied() {
    for contents in [b"".as_slice(), b"ordinary data".as_slice()] {
        let (_temp, source, target) = fixture();
        let file = source.join(OWNED_SOCKET_PATH);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, contents).unwrap();
        assert!(!should_skip_runtime_socket(&source, &file).unwrap());
        migrate_data_root(&source, &target).unwrap();
        assert_eq!(fs::read(target.join(OWNED_SOCKET_PATH)).unwrap(), contents);
        assert_eq!(fs::read(file).unwrap(), contents);
    }
}

// 名为 api.sock 的普通目录与其内容属于数据，不会被运行端点规则略过。
#[test]
fn ordinary_socket_named_directory_is_copied() {
    let (_temp, source, target) = fixture();
    let file = source.join(OWNED_SOCKET_PATH).join("keep.txt");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, b"keep").unwrap();
    migrate_data_root(&source, &target).unwrap();
    assert_eq!(
        fs::read(target.join(OWNED_SOCKET_PATH).join("keep.txt")).unwrap(),
        b"keep"
    );
}

// 源根之外及嵌套同名路径不匹配，即使字符串末尾相同也不调用端点探测。
#[test]
fn whitelist_is_relative_to_the_exact_source_root() {
    let (_temp, source, target) = fixture();
    assert!(!should_skip_runtime_socket(&source, &target.join(OWNED_SOCKET_PATH)).unwrap());
    assert!(
        !should_skip_runtime_socket(&source, &source.join("nested").join(OWNED_SOCKET_PATH))
            .unwrap()
    );
}

// 非空目标先被拒绝，端点例外不会覆盖已有目标数据。
#[test]
fn socket_exception_does_not_allow_nonempty_targets() {
    let (_temp, source, target) = fixture();
    drop(listener(&source.join(OWNED_SOCKET_PATH)));
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep.txt"), b"keep").unwrap();
    assert_eq!(
        migrate_data_root(&source, &target).unwrap_err(),
        "data_storage_target_not_empty"
    );
    assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"keep");
}

// Windows 名称大小写变化仍识别真实已停止端点，不放宽到其他相对路径。
#[cfg(target_os = "windows")]
#[test]
fn windows_owned_socket_matching_is_case_insensitive() {
    let (_temp, source, target) = fixture();
    let socket = source.join("REMOTE-MANAGER/DATA/RUN/API.SOCK");
    drop(listener(&socket));
    assert!(should_skip_runtime_socket(&source, &socket).unwrap());
    migrate_data_root(&source, &target).unwrap();
    assert!(!target.join("REMOTE-MANAGER/DATA/RUN/API.SOCK").exists());
}

// 创建临时目录联接，不需要符号链接提权；命令仅操作本测试的随机临时路径。
#[cfg(target_os = "windows")]
fn junction(path: &Path, destination: &Path) {
    use std::os::windows::process::CommandExt;
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let output = std::process::Command::new("cmd")
        .args(["/D", "/C"])
        .raw_arg(format!(
            r#"mklink /J "{}" "{}""#,
            path.display(),
            destination.display()
        ))
        .creation_flags(0x0800_0000)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

// 固定端点名称下的真正 junction 及父目录 junction 均拒绝，不遍历外部目标。
#[cfg(target_os = "windows")]
#[test]
fn windows_junctions_at_or_above_owned_socket_are_rejected() {
    for relative in [OWNED_SOCKET_PATH, "remote-manager/data/run"] {
        let (temp, source, target) = fixture();
        let external = temp.path().join("external");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("keep.txt"), b"external").unwrap();
        let link = source.join(relative);
        junction(&link, &external);
        assert!(path_is_symlink_or_reparse(&link).unwrap());
        assert!(!should_skip_runtime_socket(&source, &link).unwrap());
        assert!(migrate_data_root(&source, &target)
            .unwrap_err()
            .starts_with("data_storage_migration_symlink_rejected:"));
        assert_failed_migration_is_safe(temp.path(), &source, &target, &link);
        assert_eq!(fs::read(external.join("keep.txt")).unwrap(), b"external");
        fs::remove_dir(link).unwrap();
    }
}

// 同名符号链接不能冒充 socket，外部目标保持原样。
#[cfg(unix)]
#[test]
fn symlink_at_owned_socket_is_rejected() {
    let (temp, source, target) = fixture();
    let external = temp.path().join("external.txt");
    fs::write(&external, b"external").unwrap();
    let link = source.join(OWNED_SOCKET_PATH);
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&external, &link).unwrap();
    assert!(!should_skip_runtime_socket(&source, &link).unwrap());
    assert!(migrate_data_root(&source, &target)
        .unwrap_err()
        .starts_with("data_storage_migration_symlink_rejected:"));
    assert_failed_migration_is_safe(temp.path(), &source, &target, &link);
    assert_eq!(fs::read(external).unwrap(), b"external");
}
