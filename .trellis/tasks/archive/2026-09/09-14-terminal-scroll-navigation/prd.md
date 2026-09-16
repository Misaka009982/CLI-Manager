# 终端历史滚动条与一键回到底部

## Goal

让终端 Markdown 预览支持可见的历史列表滚动条，以及正文到底部、切到最新回答、历史列表到末尾三种快捷导航。用户已授权创建任务并明确三项目标，变更记录版本为 V1.4.0。

## Background / confirmed evidence

- 截图对应 `src/features/terminal/components/TerminalMarkdownPreview.tsx:103` 的 `MarkdownPreviewAnswerSelect`。列表使用 Radix Select Viewport，已设置高度上限与 overflow-y-auto（同文件 :144）。
- 滚动条不可见的直接原因是 Radix 自带样式主动隐藏 Viewport 的原生滚动条：`node_modules/@radix-ui/react-select/dist/index.mjs:721`；仅添加 overflow-y-auto 无法恢复可见滑块。修复应限定在此下拉框的滚动容器，不修改依赖包或全局 Select 行为。
- 终端样式已有细圆角滑块、悬停加宽规则：`src/styles/components/history-scroll-markdown.css:190`；辅助面板也有相同视觉规则（同文件 :220）。
- 终端本身已实现右下角跳转按钮：`src/features/terminal/components/XTermView.tsx:191`。仅普通 buffer 且 viewportY < baseY 时显示：`src/features/terminal/hooks/useXTermController.ts:1012`。点击调用 xterm.scrollToBottom（同文件 :1662），已有 Ctrl+End 快捷键和中英翻译。
- Markdown 当前回答正文有独立滚动容器：`src/features/terminal/components/TerminalMarkdownPreview.tsx:366`，当前没有对应回到底部按钮。

## Requirements

- R1：回答历史下拉框内容超出可见高度时显示可拖动滚动条，视觉与终端一致；保留选中态、鼠标滚轮、键盘选择与关闭交互。
- R2：正文右下角提供“回到底部”；仅正文溢出且未到底时显示，点击只滚动当前回答，与字号控件错开。
- R3：预览标题栏提供“最新回答”；点击选择当前已加载回答中的最后一条，待正文渲染后滚到该回答底部。无回答时不可用；自动刷新仍保留用户正在阅读的旧回答，不强制跳转。
- R4：回答历史下拉框提供固定的“跳到列表末尾”入口，不随选项滚走；点击滚动到最后一项并保持菜单打开，不自行更改所选回答。选择最后一项仍使用既有选择交互。此行为随最终方案提交用户确认。
- R5：涉及用户可见文案时同时兼容 zh-CN/en-US，时间保持 24 小时制；交付前更新 CHANGELOG.md 的 V1.4.0 与 docs/功能清单.md 对应板块。
- R6：修复用户续接会话时报告的 Markdown 预览持续加载问题；已经索引的精确绑定会话无需等待其他会话的全局索引刷新，仍保证来源和会话身份匹配。

## Acceptance Criteria

2026-09-14 用户整体反馈“验证成功”，并在已获知架构门禁基线问题后授权拉取远程 master 合并并提交。下列原始桌面待办保留为验收范围，不声称代理逐项实测。

- [ ] 历史列表溢出时可看见并拖动滑块，能到达最早与最新回答；少量回答无多余滚动。
- [ ] 滚动条随当前预览主题显示，窄面板和浮层边界下仍可操作，键盘选择不会失效。
- [x] 跳转只作用于用户确认的当前终端/预览实例，不串到其他分屏或会话（Hook/组件回归通过，桌面验证另列）。
- [x] 正文回到底部不切换回答；切换最新回答后能看见该回答末尾；已选最新回答时再次点击也可回到其底部（行为回归通过）。
- [ ] 历史列表一键到底后末项可见，选中回答保持不变；用户仍可拖动回看、键盘选择、Escape 关闭。
- [ ] 空内容、加载失败、单条回答、异步内容高度变化与面板缩放不会留下错误的跳转按钮或跳到旧实例。
- [ ] 定向回归、前端类型检查、独立架构检查（含 strict）通过；真实桌面与语言切换结果如实记录。
- [x] 干净目录中已命中的精确会话读取不等待全局刷新；普通文本、缺失会话及编辑后的刷新语义保留（Rust 回归通过）。

## Scenario coverage for implementation planning

- 单/多会话、分屏及 Workspan：滚动目标限定当前实例；切换后不能沿用另一实例的引用。
- 本地/WSL/SSH、主仓库/Worktree、Hook 有无：复用现有历史来源与终端实例，不变更解析、PTY 或 IPC。
- 窗口焦点/最小化/托盘、焦点模式、侧栏与辅助面板停靠：不主动切换窗口或抢焦点；恢复后按实际可见尺寸计算。
- 空列表/少量/大量回答、首项/末项选中、窗口缩放、明暗主题、中英文：覆盖溢出与边界交互。
- 终端 alternate buffer：现有按钮有明确 normal-buffer 限定；不擅自向 TUI 发送 End 或其他按键。

## Out of scope

不修改 PTY、IPC 签名、历史数据结构、持久化协议、依赖版本或发布版本元数据。加载故障修复允许调整既有历史查询的刷新时机；Git 同步与提交已由用户在验收成功后明确授权，不包含推送远程。

## Planning status

2026-09-14 用户指定继续本任务并明确在 master 分支实现；沿用已收敛的三项导航方案，优先处理本次追加的预览加载故障，版本仍为 V1.4.0。
