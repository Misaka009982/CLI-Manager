use super::*;
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::System::Threading::{TerminateProcess, WaitForSingleObject};

// 使用实际启动计划和新控制台，文件仅作为探针结果通道，不重定向子进程标准句柄。
#[test]
fn direct_console_handles_are_interactive_for_native_and_nested_shells() {
    let folder = tempfile::tempdir().unwrap();
    let resolve =
        |exe: &str| resolve_executable(exe).map(|path| path.to_string_lossy().into_owned());
    let mut programs = vec!["cmd", "powershell"];
    if resolve_executable("pwsh.exe").is_ok() {
        programs.push("pwsh");
    }
    for program in programs {
        for shell in ["cmd", "powershell"] {
            let output = folder.path().join(format!("{program}-{shell}.txt"));
            let path = ps_literal(&output.to_string_lossy());
            let script = format!(
                "[IO.File]::WriteAllText({path}, ('{{0}},{{1}},{{2}}' -f [Console]::IsInputRedirected,[Console]::IsOutputRedirected,[Console]::IsErrorRedirected)); exit"
            );
            let startup = if shell == "cmd" {
                format!(
                    "powershell.exe -NoLogo -NoProfile -EncodedCommand {} & exit",
                    encode_script(&script)
                )
            } else {
                script
            };
            let tab = ExternalTab {
                title: "CLI-Manager console regression probe".into(),
                cwd: Some(folder.path().to_string_lossy().into_owned()),
                shell: Some(shell.into()),
                startup_cmd: Some(startup),
            };
            let mut plan = build_plan(&tab, program, &resolve).unwrap();
            // 探针执行后自动退出外层，仍保留真实新控制台与桥接路径。
            if let Some(raw) = &mut plan.raw_args {
                *raw = raw.replacen("/K", "/C", 1);
            }
            plan.args.retain(|arg| arg != "-NoExit");
            let process = console::spawn(&plan, true).unwrap();
            let wait = unsafe { WaitForSingleObject(process.as_raw_handle(), 20_000) };
            if wait != 0 {
                unsafe {
                    TerminateProcess(process.as_raw_handle(), 1);
                }
                panic!("console probe timed out: {program}/{shell}");
            }
            assert_eq!(
                std::fs::read_to_string(output).unwrap(),
                "False,False,False",
                "{program}/{shell}"
            );
        }
    }
}
