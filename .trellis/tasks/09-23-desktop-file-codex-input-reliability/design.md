# 评估基线与实施闸门

## 已确认的代码触点

- 文件菜单：`src/features/files/api/FileExplorerSidebar.tsx` 的 `FileSelectionMenuItems`、`pasteIntoTarget`、`openFileBrowserFolder`，`src/features/files/api/fileExplorerStore.ts` 的 `setClipboard`、`readPasteClipboard`、`pasteInto`、`performFileBatch`，以及 Rust `file_*` 和 `open_folder_in_explorer` 命令。复制／剪切目前只更新应用内剪贴板；粘贴还会比较系统剪贴板版本。新增目标是 Windows 系统文件剪贴板互通（CF_HDROP 与剪切效果），不是只写文本路径。删除走单独的确认链路，不能由“删除有效”推断其他链路有效。
- Hook：`src-tauri/src/features/hooks/settings/`、`src-tauri/ssh-agent/src/hook_config.rs`、`src-tauri/hook-schema/src/lib.rs`、`src-tauri/src/features/hooks/claude.rs`、`src/app/App.tsx`。当前精确匹配 `request_user_input`，未见 `request_user_input_async`。必须先抓真实事件再决定匹配器和迁移范围。
- 终端：`src/features/terminal/hooks/useXTermController.ts` 截获 Ctrl+A；`src/features/terminal/hooks/useTerminalInput.ts` 镜像输入缓冲并通过方向键、Ctrl+U 重写内容；`TerminalMouseInteraction.ts` 只配置标准鼠标事件透传，点击时当前逻辑主要清除选区。光标隐藏策略仅处理可见性控制序列。历史提交 `83ba1706` 曾用屏幕坐标换算并模拟方向键实现点击定位；`47990baf` 明确写明“暂停不可靠的点击定位”，将它关闭，后续重构移除了实现。不能直接把旧开关打开。

## 根因假设与验证方式

- 文件菜单：可能同时存在“无反馈导致误认无效”、剪贴板身份／项目代际失配、冲突／同目录静默结果、系统打开命令只确认进程创建等不同问题。逐动作追踪菜单回调 → store → IPC → 文件系统／Explorer → UI 回显后再下根因结论。
- 终端：CLI-Manager 维护的输入镜像与 Codex TUI 自身编辑状态不是同一权威源。异步输出、换行和重绘会使镜像与实际光标脱节；强制重写输入可能扩大失配。以脱敏事件时间线、PTY 字节和 xterm 缓冲状态验证，不记录用户输入正文。
- Codex 官方 CLI 文档公开了 TUI 快捷键配置及 Ctrl+G 外部编辑器，但未保证鼠标点击定位或通用撤销／重做协议。先验证目标 Codex 版本能力；若 TUI 不提供权威草稿状态，研究独立受控输入层的可用性、焦点和交互成本，并在实现前单独确认取舍。

## 实施顺序

1. 保留复现样例与最小自动化检查；确定每个菜单动作的实际失败边界。
2. 修文件菜单调用链与反馈，跑批量操作、路径安全和平台定向测试。
3. 验证异步提问事件；只在存在可靠事件时补齐 Hook 全链路。
4. 先完成 Codex TUI 输入状态可行性原型和验收矩阵，再决定键盘编辑与鼠标定位实现；不得用光标隐藏开关作为关闭条件。

## 风险与回滚

- 文件复制／移动／删除涉及真实用户文件；默认无覆盖，保留原有根目录约束和脏文件保护。回滚仅撤销代码，不自动撤销用户文件操作。
- Hook 必须只管理 CLI-Manager 自有项，升级与卸载不碰第三方项。
- TUI 输入改动可能影响 shell 作业控制、其他 CLI、中文输入和终端焦点，必须按会话能力隔离，出现失配可关闭新输入路径并保留原生终端透传。

## 1.4.1 本轮分阶段交付决定（2026-09-23）

- 用户确认先交付可可靠验证部分，不新增受控输入区。Codex 内建 TUI 的 Ctrl+A／Z／Y 和点击定位未修改、未验收，不能宣称完成。
- 文件复制／剪切发布 Windows CF_HDROP 与 Preferred DropEffect，同时保留应用内快照和外部剪贴板修订号保护；本机路径先走现有根目录和链接约束。WSL／SSH 不写虚假的本机文件列表。对源路径非法等错误清理快照；系统剪贴板临时不可用则保留应用内副本并明确反馈。
- Hook 采用精确正则匹配同步/异步提问工具名，并在 Rust 与前端通知层识别两者；配置、状态、远端代理和 Hook schema 的定向测试覆盖。真实 Codex `request_user_input_async` 是否发出 PreToolUse 仍需安装版人工实测，不能把配置测试等同于端到端验证。
- “打开所在文件夹”现有代码已对存在路径调用 Explorer，当前缺少可复现的失败路径与 GUI 验证，本轮未修改该调用；若安装版仍无响应，需记录项目环境、具体路径、Explorer 窗口及错误提示再做根因修复。

## 跨盘剪切与 Codex 光标补充根因（2026-09-23）

- 跨盘剪切位于 Windows Shell 数据对象边界：原生 `CF_HDROP` 加 `Preferred DropEffect` 只表达移动意图，没有接收资源管理器完成通知。跨盘非优化移动可能先复制，随后由源数据对象在 `Performed DropEffect` 与 `Paste Succeeded` 反馈后删除源项。改用 Shell 提供的数据对象和 OLE 剪贴板；本机临时文件测试证明收到两种反馈后源项删除、仅收到执行效果时源项保留。
- 光标闪烁位于 xterm 渲染器边界：用户实测同一 Codex 会话关闭 WebGL 后闪烁消失；深色不透明且未改颜色，TUI 颜色扫描不是触发条件。Codex 会话使用默认渲染器，手动在 Shell 内启动的 Codex 在识别后卸载 WebGL 并刷新视口；不修改 PTY 字节和 Codex 输入镜像。
- Windows Shell 与终端组件影响面均为高风险。人工验收需覆盖资源管理器同盘/跨盘、成功/取消、Codex 原生启动/手动启动、输入/输出、会话切换与不同终端。
