//! 外部交互控制台必须创建自己的标准句柄，不能继承桌面进程的日志管道。
use super::LaunchPlan;
use crate::windows_command_line::quote_windows_arg;
use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::ptr::null;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, CREATE_NEW_CONSOLE, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION,
    STARTF_USESHOWWINDOW, STARTUPINFOW,
};

// 拒绝内部 NUL，避免 Win32 在验证后的路径或命令中途截断。
fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut result: Vec<u16> = value.encode_wide().collect();
    if result.contains(&0) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "embedded NUL"));
    }
    result.push(0);
    Ok(result)
}

// 只有 CMD 桥接需要修改环境；其他模式传空指针直接继承原环境。
fn environment(bridge: &str) -> io::Result<Vec<u16>> {
    let mut entries: Vec<_> = std::env::vars_os()
        .filter(|(key, _)| {
            !key.to_string_lossy()
                .eq_ignore_ascii_case("CLI_MANAGER_EXTERNAL_BRIDGE")
        })
        .collect();
    entries.push(("CLI_MANAGER_EXTERNAL_BRIDGE".into(), bridge.into()));
    entries.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (key, value) in entries {
        let mut entry = key;
        entry.push("=");
        entry.push(value);
        block.extend(wide(&entry)?);
    }
    block.push(0);
    Ok(block)
}

// 不设置 STARTF_USESTDHANDLES、不继承句柄，让 Windows 绑定新控制台的输入/输出。
// hidden 只供回归探针隐藏短命窗口；生产调用始终为 false。
pub(super) fn spawn(plan: &LaunchPlan, hidden: bool) -> io::Result<OwnedHandle> {
    let executable = wide(OsStr::new(&plan.exe))?;
    let mut command = quote_windows_arg(&plan.exe);
    for arg in &plan.args {
        command.push(' ');
        command.push_str(&quote_windows_arg(arg));
    }
    if let Some(raw) = &plan.raw_args {
        command.push(' ');
        command.push_str(raw);
    }
    let mut command = wide(OsStr::new(&command))?;
    let cwd = plan
        .cwd
        .as_deref()
        .map(|cwd| wide(OsStr::new(cwd)))
        .transpose()?;
    let env = plan.bridge.as_deref().map(environment).transpose()?;
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    if hidden {
        startup.dwFlags = STARTF_USESHOWWINDOW;
        startup.wShowWindow = 0;
    }
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // 所有字符串与环境块在调用期间保持有效；失败时系统不返回有效进程句柄。
    let created = unsafe {
        CreateProcessW(
            executable.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
            env.as_ref().map_or(null(), |env| env.as_ptr().cast()),
            cwd.as_ref().map_or(null(), |cwd| cwd.as_ptr()),
            &startup,
            &mut info,
        )
    };
    if created == 0 {
        return Err(io::Error::last_os_error());
    }
    // 每个成功返回的句柄都有唯一所有者；调用方无需等待交互窗口退出。
    unsafe {
        let _thread = OwnedHandle::from_raw_handle(info.hThread);
        Ok(OwnedHandle::from_raw_handle(info.hProcess))
    }
}
