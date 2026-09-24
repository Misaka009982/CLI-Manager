# 外部终端启动程序选择

## 目标
用户可明确选择启动 CMD、Windows PowerShell、PowerShell 7 或 Windows Terminal，避免所有外部启动都固定走 wt.exe。

## 背景
- Windows 外部终端后端固定使用 Windows Terminal；未指定 profile 的外观可能来自默认 CMD 配置档。
- 项目与 Worktree 的“新建终端”入口目前未传项目 Shell，和项目直接启动的行为不一致。
- 用户确认所需是实际启动程序而非图标/profile；同意独立任务规划，版本 V1.4.1。
- 已完成但未提交的 WSL 修复作为现有基线保留，不在本任务回退。

## 要求
- R1：设置 → 终端 → Shell/终端类型增加“外部终端程序”下拉框，不增加第二个布尔开关。
- R2：支持 Windows Terminal（兼容默认）、CMD、Windows PowerShell、PowerShell 7，保存后对下次外部启动生效。
- R3：选择 CMD 启动 cmd.exe，选择 PowerShell 启动对应 powershell.exe/pwsh.exe；直接程序模式不经 wt.exe。
- R4：保留项目 Shell 的执行环境；WSL 项目进入对应发行版和目录；其他项目原有 Shell/CLI 参数不丢失。
- R5：项目启动、批量启动、项目/Worktree 新建纯 Shell、紧凑模式等外部入口一致遵守选择。
- R6：未安装的程序明确报错，不静默换另一种；SSH 既有能力限制和 macOS/Linux 外部终端保持不变。
- R7：实际进程选择可控；Windows 默认终端可能继续承载 CMD/PowerShell 窗口，不承诺绕过系统宿主或改变其外观。

## 验收
- 旧配置仍默认 Windows Terminal；未知持久化值回到兼容默认；中英文界面与提示齐全。
- 4 种程序分别验证正确进程与参数，普通路径、WSL UNC、空格/引号/分号、无 CLI、多项目有覆盖。
- 原有 WSL 回归测试通过，必要 Rust/TypeScript/架构检查通过。
- V1.4.1 CHANGELOG.md 与 docs/功能清单.md 记录准确。

## 范围外
不修改 Windows 默认终端系统设置，不管理 Windows Terminal profile，不新增自定义启动器命令模板，不增加外部 env_vars 透传。
