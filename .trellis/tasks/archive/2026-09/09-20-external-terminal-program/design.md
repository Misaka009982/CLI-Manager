# 外部终端程序设计

## 边界与语义
- “外部终端”现有开关决定项目是否外部打开；新增“外部终端程序”是下拉框，放在 Shell/终端类型区，并用描述区分项目 Shell。
- launcher 选择 Windows Terminal / CMD / Windows PowerShell / PowerShell 7；默认 Windows Terminal，旧用户保持行为。
- 项目 Shell 仍决定项目命令的语法与环境。直接程序模式启动所选外层程序，必要时在其内启动项目 Shell，尤其保留 WSL 发行版与 Linux cwd。无项目上下文的纯终端使用所选程序本身；Windows Terminal 模式使用全局默认 Shell。
- Windows 11 可能将 cmd.exe/powershell.exe 的新控制台交给系统默认 Terminal 承载；本应用保证启动的进程种类，不强制经典 conhost 外观，不改注册表/系统偏好。

## 数据与调用链
1. shared 层声明 ExternalTerminalProgram 的 4 值类型及校验，settingsStore 添加 externalTerminalProgram 默认/加载规范化；syncSettings 作为本机偏好排除同步，与 useExternalTerminal 一致。
2. 设置仅 Windows 展示此程序选择，下次外部启动生效；控件不与现有开关混淆，手动“打开外部终端”也遵守该值。
3. terminal/api/externalTerminal.ts 统一读取 launcher 偏好，invoke 传可选 program；既有 open_windows_terminal 名称保留，旧调用未传值默认 Windows Terminal。错误信息采用领域中英文翻译。
4. 项目/Worktree/当前标签等调用点传入有效项目 Shell，修正部分“新建终端”丢 Shell 问题；无项目 Shell 时的继承在统一边界规范化，避免 Rust 一律 PowerShell。
5. Rust 将可测试的启动计划与 spawn 分离；Windows Terminal 保留多 tab 和已有 WSL 修复；其他选项直接启动目标程序的独立新控制台，批量项目逐个独立窗口。
6. WSL 复用独立参数构建，UNC 绑定 distro，Linux cwd 不传给 Windows CreateProcess current_dir。WT 的分号转义仅用于 WT，不污染直接启动参数。
7. CMD /K 与 PowerShell -NoExit 的引用规则分别实现。PowerShell 可用 UTF-16LE EncodedCommand 保护命令向量；CMD 不套用通用 Windows argv 转义。优先复用已有 helper；不把用户路径/title 当脚本直接插入，不为引用问题关闭安全策略。
8. 预检程序解析和启动计划后执行，选择不存在的 pwsh 明确报错，不静默降级。批量 spawn 中途失败报告失败，不声称已打开的窗口回滚。

## 发现清单
| 文件/入口 | 处理 |
|---|---|
| shared/preferences/settingsStore.ts | 本机程序偏好、默认和合法值规范化 |
| features/sync/lib/syncSettings.ts | 新字段排除同步，避免跨机安装差异 |
| settings/.../ThemeSettingsPage.tsx | Shell 区新增程序下拉，保持原开关 |
| shared/i18n/messages/settings.{zh-CN,en-US}.ts 等领域字典 | 新增标签、描述、错误翻译 |
| terminal/api/externalTerminal.ts | 集中 launcher 路由与错误展示 |
| projects/hooks/useSidebarController.tsx | 项目/批量/Worktree 外部启动 Shell 一致 |
| terminal/hooks/useTerminalTabsController.tsx | 新建外部标签保留项目环境 |
| workspace/api/CommandPalette.tsx | 紧凑模式入口确认共用路由，不新增单独偏好 |
| terminal/lib/webManagement.ts | Web 请求由桌面统一偏好启动，不扩展远程执行权限 |
| src-tauri/src/features/terminal/shell_commands.rs 及同域新模块 | IPC 可选字段、Windows 路由与纯参数计划 |
| existing WSL tests / wsl.rs | 复用，不退回 -Command |
| SSH/macOS/Linux/内嵌 PTY | 既有能力限制和平台实现保持不变 |

GitNexus openWindowsTerminal MEDIUM：5 个直接上游引用，9 个上游符号；实施前对实际修改符号逐一 impact。大型 settings/sidebar 文件接近 2000 行时按已有职责抽取局部组件/纯 helper，禁止扩宽依赖或豁免。

## 场景矩阵
- 4 种 launcher × native PowerShell/CMD/pwsh/WSL/Git Bash/custom shell，匹配与不匹配两类。
- WSL 非默认 distro、UNC 两种 host、verbatim UNC、Linux 路径、盘符路径；空格/中文/单双引号/分号/&/百分号等解析边界。
- CLI 启动/无命令、单项目/批量、项目根/worktree/缺失目录、当前标签无项目、文件编辑/子 Agent 标签上下文。
- 展开/紧凑/折叠侧栏，命令面板，Web 管理；焦点/托盘/分屏不应改变路由结果。
- 外部开关开/关+显式外部动作；偏好默认/非法/程序缺失；SSH 禁用；macOS/Linux 无 Windows 控件。
- Hook 与项目 env_vars 仍沿用已有外部启动能力，不新增透传。

## 验证与回滚
前端真实路由/偏好/文案测试，Rust 启动计划与实际只读子进程 argv 探针；WSL 未安装时不能声称完成真实 WSL 测试。Rust check、tsc、严格架构检查与 V1.4.1 双记录。
回滚程序偏好和新路由到默认 WT，保留此前 WSL 参数修复；无需 DB migration 或改变系统设置。

## 官方依据
- https://support.microsoft.com/en-us/windows/apps/command-prompt-and-windows-powershell ：Windows 默认终端可承载直接启动的控制台程序。
- https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd ：/K 与引号解析规则。
- https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1 ：EncodedCommand 使用 UTF-16LE。
