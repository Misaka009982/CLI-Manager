# Markdown 预览滚动导航设计

## Boundary and ownership

续接补充：加载故障位于历史查询的刷新边界。`history_list_sessions` 对所有非空 query 先等待全局 catalog 刷新，已知的 CLI session ID 也进入这个路径；开发日志中多个 preview lookup 只有 start，未到 summary。修复在查询层识别已命中的精确会话，保留普通文本搜索和已标脏数据的刷新语义，不用 UI 超时掩盖读取阻塞。

行为缺口位于终端 Markdown 预览的两个 DOM 滚动容器：回答历史 Select Viewport 与当前回答正文。终端 xterm 已有独立滚动快捷按钮，本任务不改其控制 Hook、缓冲区或快捷键。

三项导航共享同一回答选择状态和主题，作为一个组件范围内任务交付；拆成父子任务会重复改动同一组件、样式与回归文件，故不拆分或派发代理。

## Discovery list

| 触点 | 处理 |
| --- | --- |
| `src/features/terminal/components/TerminalMarkdownPreview.tsx` | 回答选择、标题栏入口、正文滚动引用、菜单末尾入口；必要时抽出局部回答选择组件，保持既有 Props 语义 |
| `src/features/terminal/components/MarkdownPreviewAnswerSelect.tsx` | 局部选择器、固定操作与终端风格覆盖层滑块；复用 Radix 选择与关闭行为 |
| `src/features/terminal/hooks/useMarkdownPreviewScroll.ts` | 当前正文滚动意图、异步高度锚定、用户操作取消及 observer 生命周期 |
| `src/styles/components/history-scroll-markdown.css` | 仅当前菜单的滚动条与固定操作区样式；复用终端颜色、细圆角滑块、悬停加宽视觉 |
| `src/shared/i18n/messages/terminal.zh-CN.ts` / `terminal.en-US.ts` | 新增按钮 tooltip、aria-label 与菜单操作文案 |
| `scripts/terminalMarkdownPreview.test.mjs` / `scripts/terminalMarkdownPreviewNavigation.test.mjs` | 更新已有断言；执行真实 Hook/组件回调，验证滚动目标、选择、资源清理和异步会话隔离 |
| `CHANGELOG.md` / `docs/功能清单.md` | V1.4.0 与终端 Markdown 功能板块记录 |
| `src-tauri/src/features/history/mod.rs` / 定向查询策略测试 | 调整精确会话读取的刷新时机，保持 IPC 参数与返回结构 |
| `src-tauri/src/features/history/session_query.rs` | 可独立验证的查询/刷新顺序，包含永不完成的全局刷新与精确会话命中回归 |
| `SubagentTranscriptView.tsx` / 相应 scrollbar 样式 | 作为视觉与拖动模式参考；不复制其历史加载或生命周期 |
| `XTermView.tsx` / `useXTermController.ts` | 已确认无需改动；复用外观原则，不调用终端输出滚动 API |
| history 获取、SSH consumer、Hook、PTY/IPC、Worktree 解析 | 精确本地查询修复由后端实现；SSH、PTY、Hook 与 Worktree 来源协议无需改动；前端请求生命周期和导航都必须保持会话隔离 |

## Data flow and controls

1. 正文使用当前预览实例的 DOM ref；依据 scrollHeight、clientHeight、scrollTop 判断是否离开底部。监听滚动、容器尺寸与内容尺寸变化；观察器随面板关闭、元素更换、实例卸载清理。所有 Hook 位于 open 提前返回之前。
2. 正文按钮仅改变该容器 scrollTop。字号控件与按钮在同一浮动容器内纵向排布，避免遮挡。
3. “最新回答”从 previewMessages 的末项读取真实 messageIndex，不使用数组长度作为消息索引。通过同一 selectedMessageIndex 切换；待对应正文提交到 DOM 后执行一次到底部操作。请求与目标须绑定当前 sessionId/回答；手动选其他回答或会话切换取消过期跳转。已选末项时直接滚动当前正文。
4. “最新回答”针对已加载结果，不额外建立第二条历史获取链路；刷新仍走 loadLatest，继续保留合法旧选择。不会自动持续追随底部。
5. 下拉菜单固定操作区位于选项滚动区域之外。点击“跳到列表末尾”只滚动 Select Viewport 并保持打开，不触发 onSelect；保留菜单焦点与键盘可达性，不将动作伪装成一条回答。正常选择后仍按 Radix 默认关闭并归还焦点。
6. 当前 Radix 样式会隐藏原生滑块，不能仅增加 overflow。最终采用终端同款覆盖层滑块，引用 Viewport 为唯一滚动源，拖动与滚轮/键盘共享其 scrollTop，不建立第二个滚动容器，不修改 node_modules。浮层为带名称的 dialog，内含 listbox 和独立原生按钮；Tab/Shift+Tab 在选项与固定操作之间移动。
7. 浮层最大高度同时受既有 228px 上限和 Radix 可用高度约束，列表上限为 188px，保留固定操作区空间；窄窗口保持末项与滑块可达。

## Compatibility and risks

- 新按钮沿用终端预览主题并提供中英无障碍名称；24 小时日期格式不变。
- 保留现有本地/WSL/SSH/Worktree 历史来源和远程 consumer 生命周期，不新增依赖或持久化字段。
- Radix 的焦点管理、列表末尾按钮的键盘可达性与 WebView scrollbar 呈现需要实际桌面验收；Node 检查不能证明其视觉效果。
- Markdown 异步渲染及图片加载可能改变内容高度；只处理显式跳转意图和按钮可见性，不引入默认自动跟随行为。
- GitNexus 存在同名仓库索引，必须使用当前绝对仓库路径定位；修改符号前做 impact 并报告调用范围，索引过期时先更新。工具不可用则记录并按领域契约+定向引用降级。

## Rollback

本次为预览前端局部组件、样式、翻译及历史精确查询刷新策略变更；可按本次 diff 撤销，不回滚用户其他改动。不执行发布、版本元数据升级、Git 同步或提交。
