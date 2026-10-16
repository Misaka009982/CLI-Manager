use std::path::Path;

const OWNED_SOCKET_PATH: &str = "remote-manager/data/run/api.sock";

// 只识别源根下固定端点；同名普通文件照常复制，活动或无法确认的套接字拒绝迁移。
pub(super) fn should_skip_runtime_socket(source_root: &Path, path: &Path) -> Result<bool, String> {
    let Ok(relative) = path.strip_prefix(source_root) else {
        return Ok(false);
    };
    let relative = relative.to_string_lossy();
    let relative = if cfg!(target_os = "windows") {
        relative.replace('\\', "/")
    } else {
        relative.into_owned()
    };
    let owned = if cfg!(target_os = "windows") {
        relative.eq_ignore_ascii_case(OWNED_SOCKET_PATH)
    } else {
        relative == OWNED_SOCKET_PATH
    };
    if !owned {
        return Ok(false);
    }
    platform_socket_is_stopped(path)
}

// 将无法可靠确认端点的错误保留为独立稳定码，不当成“服务已停止”。
fn probe_error(detail: impl std::fmt::Display) -> String {
    format!("data_storage_runtime_socket_probe_failed: {detail}")
}

#[cfg(target_os = "windows")]
use windows_sys::Win32::Networking::WinSock::{
    closesocket, connect, ioctlsocket, socket, WSACleanup, WSAGetLastError, WSAStartup, AF_UNIX,
    FIONBIO, INVALID_SOCKET, SOCKADDR, SOCKADDR_UN, SOCKET, SOCKET_ERROR, SOCK_STREAM, WSADATA,
    WSAEALREADY, WSAECONNREFUSED, WSAEINPROGRESS, WSAEWOULDBLOCK,
};

#[cfg(target_os = "windows")]
struct LocalSocket {
    handle: SOCKET,
}

#[cfg(target_os = "windows")]
impl LocalSocket {
    // 为本次探测取得 Winsock 引用并创建非阻塞 AF_UNIX 流套接字；失败自动释放所持引用。
    fn new() -> Result<Self, String> {
        let mut data: WSADATA = unsafe { std::mem::zeroed() };
        let status = unsafe { WSAStartup(0x0202, &mut data) };
        if status != 0 {
            return Err(probe_error(status));
        }
        let handle = unsafe { socket(AF_UNIX as i32, SOCK_STREAM, 0) };
        if handle == INVALID_SOCKET {
            let error = unsafe { WSAGetLastError() };
            unsafe { WSACleanup() };
            return Err(probe_error(error));
        }
        let socket = Self { handle };
        let mut nonblocking = 1;
        if unsafe { ioctlsocket(handle, FIONBIO, &mut nonblocking) } == SOCKET_ERROR {
            return Err(probe_error(unsafe { WSAGetLastError() }));
        }
        Ok(socket)
    }
}

#[cfg(target_os = "windows")]
impl Drop for LocalSocket {
    // 只释放本次探测自己的句柄/引用，不删除路径或影响其他进程持有的服务端。
    fn drop(&mut self) {
        unsafe {
            closesocket(self.handle);
            WSACleanup();
        }
    }
}

// Windows AF_UNIX 使用有长度上限的 UTF-8 地址；拒绝截断或嵌入 NUL。
#[cfg(target_os = "windows")]
fn socket_address(path: &Path) -> Result<SOCKADDR_UN, String> {
    let path = path
        .to_str()
        .ok_or_else(|| probe_error("invalid socket path"))?;
    let mut address: SOCKADDR_UN = unsafe { std::mem::zeroed() };
    address.sun_family = AF_UNIX;
    if path.len() >= address.sun_path.len() || path.as_bytes().contains(&0) {
        return Err(probe_error("invalid socket path length"));
    }
    for (target, byte) in address.sun_path.iter_mut().zip(path.bytes()) {
        *target = byte as _;
    }
    Ok(address)
}

// 使用不跟随链接的原生枚举 tag 区分 AF_UNIX 与 symlink/junction，再无请求内容地探测监听状态。
#[cfg(target_os = "windows")]
fn platform_socket_is_stopped(path: &Path) -> Result<bool, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        FindClose, FindFirstFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        WIN32_FIND_DATAW,
    };
    // Windows SDK winnt.h: IO_REPARSE_TAG_AF_UNIX；其他 tag 仍由既有安全检查拒绝。
    const AF_UNIX_REPARSE_TAG: u32 = 0x8000_0023;
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut data: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };
    let handle = unsafe { FindFirstFileW(wide.as_ptr(), &mut data) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(probe_error(std::io::Error::last_os_error()));
    }
    unsafe { FindClose(handle) };
    if data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
        || data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
        || data.dwReserved0 != AF_UNIX_REPARSE_TAG
    {
        return Ok(false);
    }
    let address = socket_address(path)?;
    let socket = LocalSocket::new()?;
    let result = unsafe {
        connect(
            socket.handle,
            &address as *const SOCKADDR_UN as *const SOCKADDR,
            std::mem::size_of::<SOCKADDR_UN>() as i32,
        )
    };
    if result == 0 {
        return Err("data_storage_tasks_active".to_string());
    }
    match unsafe { WSAGetLastError() } {
        WSAECONNREFUSED => Ok(true),
        WSAEWOULDBLOCK | WSAEINPROGRESS | WSAEALREADY => {
            Err("data_storage_tasks_active".to_string())
        }
        error => Err(probe_error(error)),
    }
}

// Unix 测试/迁移保留原生节点分类，不把符号链接当 socket；只接受已拒绝连接的残留端点。
#[cfg(unix)]
fn platform_socket_is_stopped(path: &Path) -> Result<bool, String> {
    use std::os::unix::{fs::FileTypeExt, net::UnixStream};
    let metadata = std::fs::symlink_metadata(path).map_err(probe_error)?;
    if !metadata.file_type().is_socket() {
        return Ok(false);
    }
    match UnixStream::connect(path) {
        Ok(_) => Err("data_storage_tasks_active".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => Ok(true),
        Err(error) => Err(probe_error(error)),
    }
}

// 其他平台不声明可安全跳过的特殊节点。
#[cfg(not(any(target_os = "windows", unix)))]
fn platform_socket_is_stopped(_path: &Path) -> Result<bool, String> {
    Ok(false)
}

#[cfg(all(test, any(target_os = "windows", unix)))]
#[path = "runtime_socket_tests.rs"]
mod tests;
