# WSL 外部终端启动修复

## 目标
WSL 项目使用“打开外部终端”时，在对应发行版与项目目录启动配置的 CLI。

## 已知事实
- 用户截图：WSL shell、Ubuntu UNC 项目路径、codex --yolo；外部终端提示无效参数 -command。
- 根因已确认于 src-tauri/src/features/terminal/shell_commands.rs:98：WSL 启动命令落入 PowerShell 的 -Command 分支；目录仅传给 Windows Terminal，未显式指定 WSL 发行版和 Linux cwd。
- src/features/projects/hooks/useSidebarController.tsx:753 正确传递项目 shell、cwd 和 CLI 命令；现有外部终端接口不传递项目 env_vars，截图配置为空。
- 用户批准创建任务，变更日志版本 V1.4.1。

## 要求与验收
- 修正 WSL 启动参数与路径转换，保留 CLI 参数及继承环境的既有行为。
- 验证默认/指定发行版、UNC/Windows 路径、空格与引号、无 CLI 的情形。
- 验证 PowerShell/CMD/Bash 既有分支，避免回归。
- 添加定向回归测试，运行必要检查，更新 CHANGELOG.md 与 docs/功能清单.md。

## 范围外
不升级 WSL、不调整数据库、不改动内嵌终端架构；项目 env_vars 外部终端透传为既有独立缺口，不在本次参数修复中扩展 IPC。
