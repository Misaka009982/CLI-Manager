# 实施计划：SSH MFA 输入循环

## 1. 开发前

- [x] 用户确认混合认证方案，并要求自动化回归不依赖真实 MFA 主机。
- [x] 加载 `trellis-before-dev` 的后端规范上下文。
- [x] 对计划修改的 AskPass 文件再次运行 GitNexus impact；Rust 索引仍无法命名符号，记录 `UNKNOWN` 并使用契约 + 精确搜索的发现清单。
- [x] 运行 `task.py start .trellis/tasks/08-07-fix-ssh-mfa-input-loop`。

## 2. 实现

- [x] 修改 `src-tauri/src/ssh_askpass.rs`：broker 返回值、提示分类、控制终端降级、回显恢复、响应长度限制。
- [x] 修改 `src-tauri/src/ssh_transport.rs`：仅交互式 `credential_ref` launch 设置 `CLI_MANAGER_SSH_ASKPASS_TTY_FALLBACK=1`，one-shot 不设置。
- [x] 保持 helper 公共入口和 AskPass 环境变量协议不变。
- [x] 在同文件增加提示路由与降级顺序单元测试。
- [x] 增加伪 broker + 伪交互输入回归测试，覆盖密码自动填写、MFA 人工输入、broker 失效降级、one-shot 禁止 TTY 和无终端失败。
- [x] 更新 `.trellis/spec/backend/ssh-remote-terminal-contracts.md`，固化 password 自动填写与 MFA PTY 输入契约。
- [x] 更新 `CHANGELOG.md` 的 `[TEMP]` 目标记录 Issue #195。

## 3. 验证

- [x] `cd src-tauri; cargo test ssh_askpass`（10/10）
- [x] `cd src-tauri; cargo test ssh_transport`（11/11）
- [x] `cd src-tauri; cargo check`
- [x] `rustfmt --check`（`ssh_askpass.rs`、`ssh_transport.rs`）
- [x] 检查无新增用户可见文案，因此无需 i18n 变更。
- [x] 通过自动化测试覆盖保存密码 + MFA、错误密码后人工重输、普通密码主机和后台无终端失败。
- [x] 记录真实 Windows/macOS/Linux PTY 验收仍属于发布前平台验证，不作为本次用户侧前置条件。
- [x] 运行完整 `cargo test --lib`：832 通过、1 忽略；1 个既有 Pi Hook 卸载测试失败，与本任务无关。
- [x] 尝试 Linux 交叉 `cargo check`；因环境缺少 `x86_64-linux-gnu-gcc` 在 `ring` 依赖构建阶段阻断，未进入项目代码编译。
- [x] `npx tsc --noEmit` 最终通过；首次运行曾遇到并行任务 `TerminalTabs.tsx` 的未使用导入，后续工作区更新后已恢复。

## 4. 风险与回滚点

- 控制终端回显恢复是最高风险点；实现必须使用作用域守卫。
- 后台进程不得误认为存在控制终端并永久等待。
- 交互/后台隔离必须依赖显式环境标志，不能依赖是否碰巧继承控制终端。
- helper stdout 不得混入提示文本。
- 无数据库或配置迁移，代码回滚即可恢复原行为。
