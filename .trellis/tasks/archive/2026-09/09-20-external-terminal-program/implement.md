# 实施计划

依赖：已有 fix-wsl-external-terminal 修复为基线，必须保留。与字体任务无业务依赖，共用设置页与变更记录，主会话顺序修改避免覆盖。

- [x] 排查全部外部调用入口、Shell 丢失、现有设置和 Windows 系统默认终端边界。
- [x] 完成 PRD/设计/执行计划与 MEDIUM 入口影响分析，等待用户审阅。
- [x] 方案批准后激活任务，trellis-before-dev 读取相关前后端/持久化/同步/i18n 契约。
- [x] 对实际修改符号补 impact；先定义偏好枚举、兼容默认与同步排除。
- [x] 新增下拉及领域翻译，保持外部开关与项目 Shell 含义明确。
- [x] 统一前端外部入口参数，修复纯终端创建时项目 Shell 丢失。
- [x] Rust 启动计划与 launcher 分发；直接 CMD/PS/pwsh 与 Windows Terminal 隔离引用规则。
- [x] 定向测试偏好持久化、路由、Shell 继承、缺程序、命令引用；旧 WSL 7 项测试回归。
- [x] cargo test --lib commands::shell::tests（按实际新增模块补过滤）；cargo check。
- [x] npx tsc --noEmit；新前端测试与受影响同步测试；npm run check:architecture -- --strict。
- [x] 可用环境验证程序实际启动，中英文设置、项目/Worktree/批量入口；未运行项明确记录。
- [x] 更新 V1.4.1 CHANGELOG.md、docs/功能清单.md、外部终端契约；trellis-check。
- [x] git diff --check + GitNexus detect_changes；提交前呈现本任务变更范围。

回滚点：先将 launcher 切回 Windows Terminal；必要时回退新 launcher 分发但保留已验收 WSL 修复。禁止自动改系统默认终端或静默安装程序。

## 实施与验证结果（2026-09-20）

- 实现完成，等待提交确认；V1.4.1 两份记录已更新。
- 25 项前端定向测试、TypeScript、14 项 Shell 测试、原 Windows 参数引用测试、cargo check 通过；严格架构 1161 文件零违规。
- 独立浏览器挂载实际设置组件，中英文切换与 CMD 选择通过；字体不可用时等宽回退测量通过。尚未在完整 Tauri 设置流程进行人工切换验收。
- 未安装 WSL 发行版，真实 WSL 启动未复验；用户已确认前一轮 WSL 修复有效。Maple Mono 字号/字重未知，未宣称截图清晰度已解决。
- GitNexus detect_changes 标记 CRITICAL，主要源于全局设置入口关联 147 条流程；人工复核仅新增独立偏好字段，原平台分支保持。新文件另行审查。
- CMD 异种 Shell 使用编码 PowerShell 桥接，ProcessStartInfo 避免参数二次解析；既有 Windows CRT 引用函数原样移到 shared 复用。

## 空白窗口回归修复

- 现场标准句柄确认 stdout/stderr 错误继承父进程管道；根因与触点见 research/blank-console.md。
- 直接启动改为独立 CreateProcessW，禁止继承标准句柄；参数计划、WT、WSL、内置 PTY 不变。
- 新真实控制台回归通过：CMD/PowerShell/本机 pwsh × CMD/PowerShell 共 6 组，三路 IsRedirected 均为 false；8 项 external_program 测试全部通过。
- 严格架构 1163 文件零违规，diff 空白检查通过。需用户重新运行更新后的应用验证实际 CLI；不复用此前空白窗口。
- 最终验证：cargo check 通过，7 项原 WSL/其他 Shell 参数回归通过，本轮共 15 项 Rust 测试通过（其中新控制台测试覆盖 6 组实际进程）。GitNexus 风险仍来自既有全局设置入口，本轮新增控制台文件人工核查。
