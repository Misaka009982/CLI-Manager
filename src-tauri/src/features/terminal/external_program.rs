//! Windows 外部程序启动计划；与 wt 的标签分号语法隔离。
use super::{shell_exe, ExternalTab};
use crate::windows_command_line::quote_windows_arg;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::PathBuf;

#[path = "external_console.rs"]
mod console;

#[derive(Debug)]
struct LaunchPlan {
    exe: String,
    args: Vec<String>,
    raw_args: Option<String>,
    cwd: Option<String>,
    bridge: Option<String>,
}

// 不做 PowerShell 插值；命令、目录和标题均作为字面量或编码脚本传递。
fn ps_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

// Windows PowerShell 与 pwsh 的 EncodedCommand 都使用 UTF-16LE。
fn encode_script(script: &str) -> String {
    STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    )
}

// WSL 目录作为参数传入，不作为 Windows 工作目录；调用方自行添加 wt 专用转义。
pub(super) fn wsl_args(tab: &ExternalTab) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(cwd) = tab
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
    {
        if let Some((distro, path)) = crate::wsl::parse_wsl_unc_path(cwd) {
            args.extend(["--distribution".into(), distro, "--cd".into(), path]);
        } else {
            args.extend([
                "--cd".into(),
                crate::wsl::windows_path_to_wsl(cwd).unwrap_or_else(|| cwd.into()),
            ]);
        }
    }
    if let Some(cmd) = tab
        .startup_cmd
        .as_deref()
        .map(str::trim)
        .filter(|cmd| !cmd.is_empty())
    {
        args.extend([
            "--exec".into(),
            "bash".into(),
            "--login".into(),
            "-i".into(),
            "-c".into(),
            format!("{cmd}\nexec bash --login -i"),
        ]);
    }
    args
}

// CMD 解析的是脚本文本，不使用 CRT argv 引号规则；/S 去掉外层一对引号。
fn cmd_arguments(cmd: Option<&str>) -> String {
    match cmd.filter(|value| !value.trim().is_empty()) {
        Some(cmd) => format!("/D /S /K \"{cmd}\""),
        None => "/D /K".into(),
    }
}

// 构造项目 Shell 的命令行；PowerShell 和 WSL 保持各自语法，不由外层 CMD 二次解释。
fn project_command(tab: &ExternalTab, shell: &str) -> Result<(String, String), String> {
    let cmd = tab
        .startup_cmd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if shell == "cmd" {
        return Ok(("cmd.exe".into(), cmd_arguments(cmd)));
    }
    let (exe, _) = shell_exe(shell)?;
    let args = match shell {
        "wsl" => wsl_args(tab),
        "powershell" | "pwsh" => {
            let mut args = vec!["-NoExit".into()];
            if let Some(cmd) = cmd {
                args.extend(["-EncodedCommand".into(), encode_script(cmd)]);
            }
            args
        }
        "gitbash" => {
            let mut args = vec!["--login".into(), "-i".into()];
            if let Some(cmd) = cmd {
                args.extend(["-c".into(), format!("{cmd}\nexec bash --login -i")]);
            }
            args
        }
        _ => cmd.map(|cmd| vec![cmd.to_string()]).unwrap_or_default(),
    };
    Ok((
        exe,
        args.iter()
            .map(|arg| quote_windows_arg(arg))
            .collect::<Vec<_>>()
            .join(" "),
    ))
}

// 直接启动选择的外层程序；项目 Shell 不同时在同一控制台内运行子 Shell，退出后回到外层。
fn build_plan(
    tab: &ExternalTab,
    program: &str,
    resolve: &impl Fn(&str) -> Result<String, String>,
) -> Result<LaunchPlan, String> {
    let exe = match program {
        "cmd" => "cmd.exe",
        "powershell" => "powershell.exe",
        "pwsh" => "pwsh.exe",
        _ => return Err("external_terminal_program_invalid".into()),
    };
    let shell = tab
        .shell
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(program);
    let cwd = tab
        .cwd
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned();
    let mut plan = LaunchPlan {
        exe: resolve(exe)?,
        args: Vec::new(),
        raw_args: None,
        cwd: if shell == "wsl" { None } else { cwd },
        bridge: None,
    };
    if shell == program && program == "cmd" {
        plan.raw_args = Some(cmd_arguments(tab.startup_cmd.as_deref()));
        return Ok(plan);
    }
    let mut script = format!("[Console]::Title = {}\n", ps_literal(&tab.title));
    if shell == program {
        script.push_str(tab.startup_cmd.as_deref().unwrap_or(""));
    } else {
        let (child, arguments) = project_command(tab, shell)?;
        let child = resolve(&child)?;
        // ProcessStartInfo 避开 PowerShell 5 原生命令参数重组；参数串只由子程序解析一次。
        script.push_str(&format!(
            "$p = New-Object System.Diagnostics.ProcessStartInfo\n$p.FileName = {}\n$p.Arguments = {}\n$p.UseShellExecute = $false\n$c = [System.Diagnostics.Process]::Start($p)\n$c.WaitForExit()\n",
            ps_literal(&child), ps_literal(&arguments),
        ));
    }
    let encoded = encode_script(&script);
    if program == "cmd" {
        // CMD 只接收固定桥接程序和 Base64，无路径、引号、% 或用户命令的二次展开。
        let bridge = resolve("powershell.exe")?;
        plan.bridge = Some(bridge);
        plan.raw_args = Some(format!("/D /V:OFF /S /K \"\"%CLI_MANAGER_EXTERNAL_BRIDGE%\" -NoLogo -NoProfile -EncodedCommand {encoded}\""));
    } else {
        plan.args = vec!["-NoExit".into(), "-EncodedCommand".into(), encoded];
    }
    Ok(plan)
}

// 只检查可执行文件位置，不运行探测进程；缺失时不更换用户选择的程序。
fn resolve_executable(exe: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(exe);
    let mut candidates = Vec::new();
    if exe.contains(['/', '\\']) {
        candidates.push(path.clone());
    }
    if !exe.contains(['/', '\\']) {
        let names = if path.extension().is_some() {
            vec![exe.to_string()]
        } else {
            vec![format!("{exe}.exe"), exe.to_string()]
        };
        let mut roots: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|value| std::env::split_paths(&value).collect())
            .unwrap_or_default();
        if let Some(root) = std::env::var_os("SystemRoot") {
            roots.push(PathBuf::from(&root).join("System32"));
            roots.push(PathBuf::from(root).join("System32/WindowsPowerShell/v1.0"));
        }
        if let Some(root) = std::env::var_os("ProgramFiles") {
            roots.push(PathBuf::from(root).join("PowerShell/7"));
        }
        for root in roots {
            for name in &names {
                candidates.push(root.join(name));
            }
        }
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| format!("external_terminal_program_not_found: {exe}"))
}

// 新控制台模式下打开交互窗口；先预检所有计划，批量启动中途失败不关闭已打开窗口。
pub(super) fn open(tabs: &[ExternalTab], program: &str) -> Result<(), String> {
    let resolve =
        |exe: &str| resolve_executable(exe).map(|path| path.to_string_lossy().into_owned());
    let plans = tabs
        .iter()
        .map(|tab| build_plan(tab, program, &resolve))
        .collect::<Result<Vec<_>, _>>()?;
    for plan in plans {
        console::spawn(&plan, false)
            .map_err(|err| format!("external_terminal_launch_failed: {}: {err}", plan.exe))?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "external_program_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "external_console_tests.rs"]
mod console_tests;
