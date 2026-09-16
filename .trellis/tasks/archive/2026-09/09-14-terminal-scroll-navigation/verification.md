# 验证记录（V1.4.0）

## 分支与范围

- 用户明确指定在 `master` 继续现有任务；开始实现时 `master...origin/master` 为 0/0。
- 实现三项 Markdown 导航，同时处理用户追加的预览持续加载故障。
- 二维码图片为用户已有改动，未修改。GitNexus 刷新产生的 AGENTS/CLAUDE 管理块变更已清理。
- 切分支时后台 Cargo 重算的锁文件已另存临时快照并恢复 master 版本；没有变更依赖版本，npm 只补齐该分支已声明的缺失包。

## 根因陈述

根因位于历史查询和全局目录刷新之间：`history_list_sessions` 将精确绑定的 CLI 会话 ID 也作为普通文本搜索，先等待全局刷新锁，导致已有会话预览依赖全部历史索引完成；修复在查询层优先返回干净目录中精确命中的单条会话，保留文本搜索、未命中和编辑后数据的刷新顺序。

证据：开发日志 16:54:37、16:55:06、16:55:17、16:55:52 的多个 `history.realtime.lookup.start` 后没有对应 summary，开发历史库约 1.5 GB；代码的 `targeted_query` 无条件等待 `ensure_refresh(..., wait=true)`。使用永不完成的刷新 Future 回归证明精确命中路径可独立返回。

## 发现清单

- [x] `history_list_sessions` / `session_query`：修复刷新调度，返回和 IPC 参数保持兼容。
- [x] `fetchLatestProjectSessionDetail`：确认精确 ID 二次匹配、fresh detail、项目及无项目查找与失败刷新保留；无需改动。
- [x] `history_get_session`：确认 fresh 路径读取源会话、没有新增索引等待；无需改动。
- [x] `TerminalMarkdownPreview`：新增三处导航接线，保留刷新时旧回答，清理过期请求及远程 context。
- [x] `MarkdownPreviewAnswerSelect`：覆盖层滑块、列表末尾、选项选择、键盘固定操作。
- [x] `useMarkdownPreviewScroll`：当前回答/实例隔离、显式跳转提交时机、异步高度及 cleanup。
- [x] 样式和中英翻译：仅预览域新增规则；24 小时时间格式沿用既有 `formatTime`。
- [x] 历史列表、回放、实时统计、Web bridge：确认共用查询返回不变，普通文本检索的刷新语义保留。
- [x] PTY、xterm、Hook 安装/发送、WSL/Worktree 路径解析：确认无关，未改动。
- [x] `CHANGELOG.md` 与 `docs/功能清单.md`：记录在 V1.4.0 的终端 Markdown 预览板块。

GitNexus：执行 `npx gitnexus analyze` 更新索引；FTS 扩展缺失且 context/impact 仍返回符号未找到，风险为 UNKNOWN。按领域契约和定向引用降级核对，未将空图当作无影响。

## 自动验证

- Rust 查询策略：5/5 通过，包括全局刷新不结束、精确命中、缺失/错会话、文本与分页检索、标脏先刷新、错误返回。
- 以 master 原锁文件及 `--locked` 复验查询策略 5/5、V2/旧目录合并 1/1、Codex thread name 1/1，合计 7/7 通过。
- 前端定向回归：37/37 通过；随后追加的 SSH 迟到 context 清理回归及预览定向组 14/14 通过（合计 38 个不同用例）。
- `npm run build`：通过，7006 modules；TypeScript 检查包含在构建中。最终焦点样式修正后再次运行 `npm run build -- --logLevel warn`，退出码为 0。
- 最终 `npx tsc --noEmit`：通过；时间格式保留 `historyViewUtils.tsx` 的 `hour12: false`。
- `cargo check --manifest-path src-tauri/Cargo.toml --locked`：通过。
- `git diff --check`：通过。
- `npm run check:architecture` 和 `--strict`：均报告 master 已有 38 项违规，2 个文件超过 2000 行；本次文件无新增违规。
- 已对全部违规文件运行 `git diff --quiet HEAD -- <files>`，返回 0，证明问题存在于 master 基线：Web 管理长行、`web_daemon.rs` 2018 行、`useSidebarController.tsx` 2163 行，以及 shared 到 feature 的既有依赖。未加豁免、未修改基线或扩展为无关架构重构。

## 桌面验收（用户确认）

2026-09-14 用户反馈“验证成功”，并明确要求拉取远程 master、合并后提交代码，记为用户验收通过。以下为前次交付的验收范围；本会话依据 `.trellis/spec/frontend/quality-guidelines.md` 的运行验证约束，未自行启动桌面应用，不将用户反馈表述为代理逐项实测。

- 当前会话预览可加载；新会话尚未索引时保持正常刷新/错误语义。
- 拖动历史列表滑块、点击固定末尾按钮，确认菜单保持打开且所选回答不变。
- 正文到底、标题栏最新回答（含重复点击）；异步 Markdown/图片展开后仍停在明确选择的末尾，滚动回看后不抢位置。
- 两个终端/分屏/Workspan 隔离，窄面板和明暗主题，Tab/Shift+Tab/方向键/Enter/Space/Escape。
- 设置切换 zh-CN/en-US，核对按钮、tooltip、aria 与回答时间仍为 24 小时制。

代码实现与用户验收已完成，用户已授权合并并提交。master 全仓架构门禁仍有 38 项既有违规；按已披露的任务范围继续交付，不新增豁免或进行无关架构重构。

## 远程 master 合并后复验（2026-09-14）

- `git fetch origin master` 获取 22 个新提交，随后将 master 从 `e4450f38` 快进到 `e6c2e61a`；本次合并未改写历史。
- 临时保存并恢复本任务改动；只有功能清单发生内容冲突，已同时保留远程 MCP/Skills 内容与本任务 Markdown 预览记录，CHANGELOG 自动合并成功。
- 对照临时保存的版本，12 个代码、测试与契约文件内容保持一致；原有二维码图片 SHA256 未变，未纳入本任务提交。
- 合并后 38/38 前端定向测试、7/7 Rust 定向测试通过；`npm run build -- --logLevel warn`（含 TypeScript）与 `cargo check --manifest-path src-tauri/Cargo.toml --locked --quiet` 均返回 0。
- 独立 normal/strict 架构检查仍为相同 38 项既有违规；再次核对全部违规文件与合并后的 HEAD 一致，本次无新增违规。
- 提交前运行 `gitnexus_detect_changes(scope=staged)`，返回 13 个代码文件、1 个已识别符号、风险 low、0 条已识别流程；图索引的符号覆盖仍不完整，结合前次契约/引用核对与本次文件差异验证，不将空流程当作零影响证明。
- `git diff --cached --check` 通过，无未解决冲突；AGENTS/CLAUDE、依赖清单和锁文件均无本地改动。
- 功能代码提交：`ca2151a8`（`feat(terminal): fix markdown preview loading and navigation`），仅包含本任务 14 个文件；未推送远程。
- 用户随后明确要求提交二维码图片，已单独提交 `0cc91a0a`（`docs: update WeChat group QR code`）；保持用户文件内容，系统图像解码验证成功（939 × 1449），不重新编码。
