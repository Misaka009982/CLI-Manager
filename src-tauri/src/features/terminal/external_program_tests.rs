use super::*;
use std::os::windows::process::CommandExt;

// 计划测试不依赖机器安装的 Shell，启动探针另用真实系统程序验证解析边界。
fn identity(exe: &str) -> Result<String, String> {
    Ok(exe.to_string())
}

fn tab(shell: Option<&str>, cmd: Option<&str>) -> ExternalTab {
    ExternalTab {
        title: "项目 'quoted'; $title".into(),
        cwd: Some(r"C:\my project".into()),
        shell: shell.map(str::to_string),
        startup_cmd: cmd.map(str::to_string),
    }
}

// 解码实际生成的 PowerShell 脚本，检查数据未变成插值或 WT 专属转义。
fn decode_script(encoded: &str) -> String {
    let bytes = STANDARD.decode(encoded).unwrap();
    String::from_utf16(
        &bytes
            .chunks_exact(2)
            .map(|part| u16::from_le_bytes([part[0], part[1]]))
            .collect::<Vec<_>>(),
    )
    .unwrap()
}

#[test]
fn direct_program_selection_and_plain_shell() {
    for program in ["cmd", "powershell", "pwsh"] {
        let plan = build_plan(&tab(None, None), program, &identity).unwrap();
        assert_eq!(plan.exe, format!("{program}.exe"));
        assert_eq!(plan.cwd.as_deref(), Some(r"C:\my project"));
        if program == "cmd" {
            assert_eq!(plan.raw_args.as_deref(), Some("/D /K"));
        } else {
            assert_eq!(&plan.args[..2], ["-NoExit", "-EncodedCommand"]);
            assert!(decode_script(&plan.args[2]).contains("项目 ''quoted''; $title"));
        }
    }
    assert!(build_plan(&tab(None, None), "arbitrary.exe", &identity).is_err());
}

#[test]
fn preserves_native_command_text_and_resolved_project_executable() {
    let cmd = "Write-Output 'quoted; $text & %value%'";
    let plan = build_plan(&tab(Some("powershell"), Some(cmd)), "powershell", &identity).unwrap();
    assert!(decode_script(&plan.args[2]).ends_with(cmd));
    let plan = build_plan(
        &tab(Some("cmd"), Some("echo %VALUE% & echo hello")),
        "cmd",
        &identity,
    )
    .unwrap();
    assert_eq!(
        plan.raw_args.as_deref(),
        Some("/D /S /K \"echo %VALUE% & echo hello\"")
    );
    let resolver = |exe: &str| Ok(format!(r"C:\my programs\{exe}"));
    let plan = build_plan(&tab(Some("pwsh"), None), "powershell", &resolver).unwrap();
    assert!(decode_script(&plan.args[2]).contains(r"C:\my programs\pwsh"));
}

#[test]
fn wsl_project_stays_in_distribution_for_every_direct_program() {
    let mut tab = tab(Some("wsl"), Some("printf '%s' \"hello;world\" # comment"));
    tab.cwd = Some(r"\\wsl.localhost\Ubuntu Test\home\dev\a'b;$project".into());
    let args = wsl_args(&tab);
    assert_eq!(
        &args[..4],
        [
            "--distribution",
            "Ubuntu Test",
            "--cd",
            "/home/dev/a'b;$project"
        ]
    );
    assert_eq!(
        args.last().unwrap(),
        "printf '%s' \"hello;world\" # comment\nexec bash --login -i"
    );
    for program in ["cmd", "powershell", "pwsh"] {
        let plan = build_plan(&tab, program, &identity).unwrap();
        assert!(plan.cwd.is_none());
        let script = if program == "cmd" {
            assert_eq!(plan.bridge.as_deref(), Some("powershell.exe"));
            let raw = plan.raw_args.as_ref().unwrap();
            decode_script(
                raw.split("-EncodedCommand ")
                    .nth(1)
                    .unwrap()
                    .trim_end_matches('"'),
            )
        } else {
            decode_script(&plan.args[2])
        };
        assert!(script.contains("--distribution"));
        assert!(script.contains("Ubuntu Test"));
        assert!(script.contains("/home/dev/a''b;$project"));
        assert!(!script.contains("\\;"));
    }
}

#[test]
fn missing_program_never_falls_back_to_another_launcher() {
    let missing = |exe: &str| Err(format!("missing: {exe}"));
    assert_eq!(
        build_plan(&tab(None, None), "pwsh", &missing).unwrap_err(),
        "missing: pwsh.exe"
    );
    assert!(resolve_executable("cli-manager-test-nonexistent-shell-19d50.exe").is_err());
}

#[test]
// 真实 CMD 子进程探针：只输出固定字符串，关闭窗口并把 /K 改 /C 防止测试挂住。
fn cmd_probe_preserves_quotes_and_expands_environment_once() {
    let plan = build_plan(
        &tab(
            Some("cmd"),
            Some("echo \"hello & world\" & echo %CLI_MANAGER_ARG_TEST%"),
        ),
        "cmd",
        &identity,
    )
    .unwrap();
    let mut command = crate::shell_resolver::silent_command("cmd.exe");
    command.raw_arg(plan.raw_args.unwrap().replacen("/K", "/C", 1));
    command.env("CLI_MANAGER_ARG_TEST", "literal%UNDEFINED_TOKEN%!");
    let output =
        crate::shell_resolver::output_with_timeout(command, std::time::Duration::from_secs(15))
            .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}");
    assert!(stdout.contains("\"hello & world\""));
    assert!(stdout.contains("literal%UNDEFINED_TOKEN%!"));
}

#[test]
// 真实 PowerShell 编码探针验证引号、美元、分号、百分号未被外层提前展开。
fn powershell_probe_preserves_encoded_command_literals() {
    let plan = build_plan(
        &tab(None, Some("Write-Output 'a; b & $value %PATH%'")),
        "powershell",
        &identity,
    )
    .unwrap();
    let mut command = crate::shell_resolver::silent_command("powershell.exe");
    command.args(["-NoLogo", "-NoProfile", "-EncodedCommand", &plan.args[2]]);
    let output =
        crate::shell_resolver::output_with_timeout(command, std::time::Duration::from_secs(15))
            .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("a; b & $value %PATH%"));
}

#[test]
// CMD 外层启动 PowerShell 项目时，脚本内容不经 CMD 展开，子 Shell 主动退出结束探针。
fn cmd_bridge_probe_keeps_project_shell_syntax() {
    let resolve =
        |exe: &str| resolve_executable(exe).map(|path| path.to_string_lossy().into_owned());
    let plan = build_plan(
        &tab(
            Some("powershell"),
            Some("Write-Output 'literal %PATH% & $value'; exit"),
        ),
        "cmd",
        &resolve,
    )
    .unwrap();
    let mut command = crate::shell_resolver::silent_command(&plan.exe);
    command.raw_arg(plan.raw_args.unwrap().replacen("/K", "/C", 1));
    command.env("CLI_MANAGER_EXTERNAL_BRIDGE", plan.bridge.unwrap());
    let output =
        crate::shell_resolver::output_with_timeout(command, std::time::Duration::from_secs(20))
            .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("literal %PATH% & $value"));
}
