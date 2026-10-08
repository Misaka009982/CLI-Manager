# 1.4.1 分阶段验证

## 2026-09-30 Codex 排队提问快捷键修复

- 安装包：修复提交 `1fbfaf08` 后运行 `npm run tauri:build:local -- --bundles nsis --ci`，退出码 0；桌面及 Web 生产构建、缓存 Rust 编译、NSIS 封装通过。产物 `src-tauri/target/local/release/bundle/nsis/CLI-Manager_1.4.1_x64-setup.exe`，2026-09-30 14:03:37，29,987,198 字节；SHA256 `8A5EC9C773FCE2919DD5FF66DBF1CB1998493BD39BB0789243F494885EEE6FB1`。保留旧包备份，未启动应用或 Web 服务，未推送。
- 分支：`fix/codex-queued-question-shortcut`，从本地与 origin/master 同步的 `0294a3ba` 创建；沿用 1.4.1，NSIS，提交后打包，不推送。
- 根因：桌面 xterm 自定义键盘回调无条件将 Shift+Left/Right 改成模拟选区，空输入直接吞键，有输入只发送普通方向键，Codex 无法收到排队提问入口所需的修饰键。
- 修复落点：`useXTermController` 在现有 Codex 会话/视口识别命中后清理模拟选区并返回 true，由 xterm 原生编码按键；普通 Shell 保留选区逻辑。为避免依赖待回答 Hook 是否及时到达，对 Codex 会话始终保留该原生组合键。
- 触点核对：桌面自定义键盘回调、Input 选区状态和 onData 转发；会话元数据/手动启动视口检测复用现有实现。Web 自定义回调只拦截剪贴板键、Hook 事件映射、PTY 传输、终端渲染均无须修改。未扩大到 Codex 全选/撤销/鼠标定位。
- 场景：空输入/已有草稿、左/右方向键、keyup/其他修饰键、普通 Shell；本地/WSL/SSH及恢复会话复用同一键盘入口与会话识别。手动启动 Codex 复用已存在的视口检测；这仍属于现有会话级识别，不新增前台进程生命周期探测。
- 验证：实际注册键盘回调测试 7 项、异步提问 Hook 测试 1 项、现有会话检测/换行等测试 18 项，共 26 项通过；桌面 TypeScript 与严格架构通过（1190 文件、0 超限/违规），Git diff whitespace 检查通过。
- GitNexus 工具不可用，按契约、codebase-memory 调用检索和真实源码降级；memory 对 useXTermController 未返回调用者，未把空结果当作无影响证明，实际入口是 XTermView 使用的终端控制器。
- 人工验收：安装后在 Codex 出现 queued questions 时按 Shift+左方向键，分别检查空输入/已有草稿；普通 Shell 验证 Shift 选区，确认回答后状态正常。按项目规则未启动桌面应用或服务进行自动 UI 测试。

## 自动检查

- `node --test scripts/fileExplorerBatchStore.test.mjs scripts/fileExplorerMultiSelectUi.test.mjs scripts/fileExplorerPathActions.test.mjs`：53/53 通过，覆盖本机文件发布、应用内快照、系统不可用回退、非法源拒绝、粘贴冲突与项目代际。
- `node --test scripts/codexAsyncQuestionHook.test.mjs`：1/1 通过，异步提问与普通工具严格区分。
- Rust 单测：Windows CF_HDROP 编码 2/2、Codex 通知识别 1/1、本机 Hook matcher/状态 2/2、SSH Hook 配置 17/17、Hook schema 1/1 通过。
- `npx tsc --noEmit`、`cargo check`、`npm run build`、`npm run check:architecture -- --strict` 通过；架构报告 0 个超 2000 行文件。

## 需安装版人工验收

- 本机文件和目录的右键复制／剪切 → CLI-Manager 其他目录与 Windows 资源管理器，分别检查冲突、同目录、外部剪贴板覆盖；涉及真实剪贴板与文件，自动化未替用户执行破坏性测试。
- 安装／升级 Attention Hook 后，实际 Codex `request_user_input_async` 是否发出 PreToolUse，及前台、后台、WSL、SSH 通知。OpenAI 文档没有保证特殊异步工具事件，因此代码匹配测试不能替代此项。
- “打开所在文件夹”的具体失败场景未能在无 GUI 实例条件下复现；现有 Explorer 启动代码本轮未修改。
- Codex TUI 草稿 Ctrl+A／Z／Y 和鼠标定位按用户选择暂缓；未交付，也未在变更记录宣称已实现。

## 1.4.1 跨盘剪切与光标补充验证

- 用户实测：项目内剪切至同项目其他目录正常；剪切到资源管理器跨盘目标时目标有文件而源仍在。Codex 在独立终端不闪、CLI-Manager 开 WebGL 时输入和输出均闪，关闭 WebGL 后消失；终端深色、不透明、未自定义 TUI 颜色，ConPTY 兼容修复已开启。
- Rust `cargo test -q clipboard_shell --lib`：4/4 通过。Shell 数据对象收到 `Performed DropEffect=MOVE` 和 `Paste Succeeded=MOVE` 后删除临时源文件；缺少粘贴成功反馈时保留源文件；混合来源目录明确拒绝系统剪切。真实资源管理器跨盘 Ctrl+V 仍需安装版人工确认。
- 文件批处理及相关终端测试 62/62 通过；补充混合目录系统剪切失败时保留应用内移动快照的回归用例，单独重跑文件批处理 28/28 通过。`npx tsc --noEmit`、`cargo check -q`、`npm run build`、`npm run check:architecture -- --strict` 通过（0 超限）。Codex 降级默认渲染器的真实视觉结果仍需安装版人工确认，其他终端的 WebGL 路径保留。
- GitNexus MCP 未在会话中暴露，改用契约文档、真实源码和 codebase-memory 图谱复核；其静态影响分析标记系统剪贴板和终端控制器为高风险。未运行桌面 GUI 自动化，遵守项目关于 AI 不启动 CLI-Manager 的规则。
