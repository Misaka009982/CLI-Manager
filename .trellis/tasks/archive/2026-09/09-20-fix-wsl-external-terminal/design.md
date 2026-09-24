# 技术设计

## 根因与边界
外部终端 Rust 参数生成器把 wsl 当作 PowerShell，发送 -Command；修复应落在生成参数的 push_tab_args，而非 UI 或用户配置。

## 方案
- 为内置 wsl 添加独立分支，使用 wsl.exe 的参数向量指定 --distribution 与 --cd。
- 复用 crate::wsl 的 UNC 解析与盘符转换；UNC 绑定其发行版，Linux/盘符路径使用默认发行版。空 cwd 保留默认目录。
- WSL cwd 不再交给 wt -d；不把路径插入 shell 脚本。
- 有启动命令时，通过 --exec bash --login -i -c 执行，结束后进入交互 shell；无启动命令时保留 WSL 默认 shell。验证 Windows Terminal 对命令中分号与引号的边界处理。
- PowerShell、CMD、Git Bash、自定义 shell、macOS/Linux 分支保持兼容。
- 不修改 IPC schema、数据库与前端文案。

## 发现清单
| 触点 | 判定 |
|---|---|
| useSidebarController.openProjectExternally | 已核对，正确传入 shell/cwd/startupCmd，无需修改 |
| projectStartupCommand.resolveProjectStartupCommand | 已核对，正确生成 codex --yolo，无需修改 |
| terminal/api/externalTerminal.ts | 已核对，IPC 字段映射正确，无需修改 |
| shell_commands.push_tab_args | 根因与修复点 |
| open_platform_terminal/open_windows_terminal | 上游调用与多 tab 分隔回归验证 |
| infrastructure/process/wsl.rs | 复用路径工具，不改变语义 |
| infrastructure/pty/wsl_launch.rs | 已核对内嵌终端已有同类目录处理，不依赖其 PTY 私有实现 |
| 工作树“仅打开目录”与 SSH | 前者未选择 WSL shell，后者能力明确禁用；本次不改 |
| 项目 env_vars | 外部终端现有接口未携带；独立问题，不扩展本次范围 |

## 场景矩阵
覆盖 UNC 两种主机名及 verbatim 形式、非默认发行版、盘符目录、Linux 目录、空目录、含空格/单引号目录；启动命令为空/CLI 参数带引号；混合 shell 多 tab。
窗口焦点、分屏、托盘、侧栏展示、Workspan、专注模式不参与本启动参数生成；同一参数快照行为一致。主仓库和存在的 worktree 使用同一路径规则；缺失目录由 WSL 报错。Hook 不参与外部终端启动。

## 影响与回滚
GitNexus push_tab_args 上游分析 LOW：1 个直接调用方 open_platform_terminal，间接 open_windows_terminal，1 个模块；图中无已登记流程。仅回退外部终端参数分支与测试即可撤销修复。
