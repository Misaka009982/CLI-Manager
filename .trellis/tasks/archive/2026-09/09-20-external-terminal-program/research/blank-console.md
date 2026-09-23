# 外部终端空白回归

## 根因

进程创建边界错误：Rust Command 默认继承标准句柄；CREATE_NEW_CONSOLE 并不覆盖已显式传入的日志管道，外部窗口有控制台但输出仍流向桌面父进程。

2026-09-20 只读检查现场进程：CLI-Manager 24608、外部 pwsh 51912、子 PowerShell 50560 的 stdout/stderr 均为 FILE_TYPE_PIPE (3)，外部 Shell 未接到新窗口屏幕缓冲区。用户确认 CMD/PowerShell 均复现。未结束或修改用户现有进程。

## 发现清单及范围

- external_program::open：直接模式唯一 spawn 边界，改用独立控制台 helper。
- external_console：CreateProcessW 不继承句柄，不设置 STARTF_USESTDHANDLES；环境/参数/工作目录保持，成功句柄由 OwnedHandle 关闭。
- build_plan / ProcessStartInfo 桥接：参数逻辑保持；修正根进程控制台后子进程沿用正确句柄。
- Windows Terminal、WSL 参数、内置 PTY、前端设置：确认不需修改。
- 回归测试：以真实新控制台和原启动计划验证输入/输出/错误均非重定向；CMD、PowerShell、可用 pwsh × CMD/PowerShell 项目 Shell。隐藏短命探针，结果通过文件独立读取。
- 状态矩阵：从管道父进程/GUI 启动均不继承句柄；有无 CLI 共用边界；批量、Worktree、前端焦点/分屏状态不改变 spawn；WSL 仍保持发行版参数但本机没有真实发行版。

## 旧测试遗漏

先前 output_with_timeout 会主动把输出接入管道，仅证明命令解析和输出内容；没有验证窗口显示和交互控制台绑定，不能证明外部终端可用。

## 依据

- https://doc.rust-lang.org/std/process/struct.Command.html
- https://learn.microsoft.com/en-us/windows/console/getstdhandle
