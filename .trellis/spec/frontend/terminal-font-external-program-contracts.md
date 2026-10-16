# 终端字体与外部程序契约

## 1. Scope / Trigger

修改终端字体归一化、Unicode 占格、设置保存、外部终端入口或 Windows 启动参数时适用。字体属于显示偏好，外部程序属于本机进程选择；二者不改变项目 Shell 的运行环境。

## 2. Signatures

- `normalizeTerminalFontPreference(fontFamily: string)`：保存与编辑用的用户字体栈。
- `normalizeTerminalFontFamily(fontFamily: string)`：终端和预览运行时字体栈。
- `installTerminalUnicode(terminal: Terminal, mode?: "graphemes" | "unicode11"): void`：两端共用的 provider 安装入口。
- `openWindowsTerminal(tabs)`：统一读取最新设置并调用 `open_windows_terminal`。
- Rust IPC：`open_windows_terminal(tabs: Vec<ExternalTab>, program: Option<String>) -> Result<(), String>`。

## 3. Contracts

- `externalTerminalProgram` 为 `windows-terminal | cmd | powershell | pwsh`，缺省及未知持久化值归一化为 `windows-terminal`；仅本机保存，sync 排除。
- Windows Terminal 保留标签模式；其他程序通过新控制台启动，每个 tab 一个窗口。系统可使用默认终端承载这些控制台。
- 项目入口必须传项目 Shell 或全局默认 Shell；无项目上下文且未传 Shell 时，直接程序模式使用选择的程序本身。
- Windows Git Bash 的扫描、图标、PTY 与外部启动共用 `shell_resolver::resolve_git_bash_exe`；保留默认位置与传统 PATH 优先级，补充 Git for Windows 布局及 Scoop shims/`SCOOP`/`SCOOP_GLOBAL`/默认用户与全局根。新增候选要求 `cmd/git.exe` 与 `usr/bin/bash.exe` 为文件，优先稳定 `current` 路径；不选任意 PATH bash 或 `git-bash.exe` GUI 启动器，不修改用户 PATH。
- WSL 不作为 Win32 cwd；UNC 拆发行版及 Linux 路径，CLI 用 Bash 参数，只有 WT 分支处理标签分号转义。
- CMD 脚本文本不能使用 CRT argv 转义。不同 Shell 使用编码 PowerShell 桥接及 ProcessStartInfo 避免二次解释；不更改执行策略。
- 直接模式使用 `CreateProcessW(CREATE_NEW_CONSOLE)`，不传 `STARTF_USESTDHANDLES`，禁止继承父进程句柄。单独设置 Rust `Command::creation_flags(CREATE_NEW_CONSOLE)` 仍可能继承桌面日志管道，导致新窗口空白；不可使用管道输出测试代替控制台句柄测试。
- 字体按 CSS 字体名解析，保留带引号逗号。用户栈顺序优先，只有完整历史自动追加尾部可清理；不按单个字体名删除。
- 保存用 preference，显示用 runtime；不强制插入 CJK 字体，不依据主观“模糊”判断字体损坏。
- 两端构造 Terminal 时允许 proposed API，在 open/write/replay 前仅调用一次 `installTerminalUnicode`；默认 `15-graphemes`，每个 Terminal 独立 addon，由 xterm dispose。不能在已有 buffer 中切换算法，不能捕获错误后静默改用不同 provider。
- `VITE_TERMINAL_UNICODE_MODE=unicode11` 为两端统一的构建期回退，未设置/未知值使用 graphemes。回退需要两端同值重建并重开终端，不添加 IPC 或运行时持久化开关；Web 原有 query suppression 必须保留。
- 区分 buffer 宽度错位与字体像素溢出；`rescaleOverlappingGlyphs` 排除 emoji，且不支持 DOM。Pi 全屏滚动条属于应用输出，`always` 在 Pi 内预留一列，不为它修改 xterm 留白或自动改用户配置。

## 4. Validation / Error Matrix

| 情况 | 行为 |
| --- | --- |
| 旧 IPC 缺少 program | 保留 WT 行为 |
| 不支持的直接程序 | `external_terminal_program_invalid` |
| 选中程序、项目 Shell 或桥接程序缺失 | `external_terminal_program_not_found`，不替换程序 |
| spawn 失败 | `external_terminal_launch_failed`；已打开窗口不关闭 |
| 批量启动 | 先预检所有所需可执行文件，再逐个打开 |
| SSH / 非 Windows | 保持现有能力限制 / 平台实现 |
| 字体缺失或缺字 | 浏览器按用户顺序与系统字体回退 |
| 默认字素模式 | VS16、ZWJ、肤色组合按整字素占格，桌面/Web 一致 |
| unicode11 回退构建 | 两端使用 11；重建重开后生效，不回退 Web Unicode 6 |
| provider 安装失败 | 错误正常暴露，不静默选择另一个宽度算法 |

## 5. Good / Base / Bad

- Good：CMD 外部程序 + WSL 项目启动 cmd.exe，再在同一控制台进入对应 WSL。
- Base：旧设置继续 Windows Terminal；Maple Mono 可用且有字形时优先显示。
- Bad：根据外部程序覆盖项目 Shell；给 wsl.exe 传 `-Command`；把雅黑插到用户 monospace 前。
- Good：两端共享 provider 后解析同一输出；Base：统一 Unicode 11 兼容构建；Bad：只改桌面，或通过替换 emoji 字符掩盖错位。

## 6. Tests

- `node --test scripts/systemFonts.test.mjs scripts/externalTerminalProgram.test.mjs scripts/cliArgsHistory.test.mjs`
- `node --test scripts/terminalUnicode.test.mjs`：真实依赖验证表格列、UTF-8/字符分块、ANSI、行尾组合、光标查询、reset、备用屏、serialize/replay、resize 与回退隔离；不模拟宽度服务。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib shell_commands::tests`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib external_program::tests`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib external_program::console_tests`：实际新控制台中三路 `Console.Is*Redirected` 全为 false，覆盖 CMD/PowerShell/可用 pwsh 及跨 Shell。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib quotes_windows_command_line_arguments`
- 中英文设置项及选择状态检查；真实 WSL 发行版与目标字体视觉比较需对应安装环境，不能用参数测试冒充。

## 7. Wrong vs Correct

- Wrong：把运行时 fallback 列表写回用户字体配置。Correct：保存 preference，预览/终端计算 runtime。
- Wrong：用 `cmd /K` 拼接用户 WSL 命令并二次展开。Correct：编码桥接脚本，子进程接收各自解析规则下的参数。
- Wrong：从压缩 bundle 默认值推断运行实例配置，或把 Pi 自绘条当作 xterm CSS 滚动条。Correct：检查实际 provider/renderer/CLI 配置，并分别验证 buffer 与像素效果。
