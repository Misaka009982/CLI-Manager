# 技术设计

## 根因陈述
两个缺陷均位于前端 DOM/键盘交互边界：负 tabIndex 的页面外壳在鼠标点击后接收 Esc，Chromium 将其切换为 focus-visible 并绘制原生轮廓；设置关闭守卫仅凭 dialog 节点存在判断上层弹窗，误把 keepMounted 的隐藏远程连接抽屉视为打开。

## 证据与发现清单
- [x] `src/app/App.tsx:1877,1903`：紧凑/标准工作区的 main-content 保留 tabIndex=-1，支持跳转主内容及焦点回归；不修改 App 逻辑。
- [x] `src/shared/hooks/useFocusTrap.ts:29`：设置外壳被赋予 tabIndex=-1；保留焦点陷阱职责。
- [x] `src/styles/components/focus-controls.css:6`：现有交互控件样式排除 tabIndex=-1，却没有覆盖页面外壳的 UA outline。
- [x] 无头 Edge 实验：点击两个外壳后 outline 为 none；按 Esc 后均变为 `rgb(16,16,16) auto 1px`。
- [x] `src/features/settings/api/SettingsModal.tsx:247,309`：关闭守卫与 document 冒泡 Esc 处理器是逻辑修复点。
- [x] `src/features/settings/components/pages/CcConnectSettingsPage.tsx:1059,1073`：两个抽屉均使用 keepMounted；必须保持挂载以保留状态，不删除 keepMounted。
- [x] Mantine ModalBaseContent/use-modal：隐藏抽屉保留 role=dialog；Esc 在 window capture 触发关闭，不阻断冒泡。
- [x] 现有供应商/SSH/MCP 对话框、Radix 消费事件、MCP 离开保护：保留子层优先与 requestClose 边界。
- [x] PTY、远程服务、WSL、SSH、Worktree、Hook、持久化：确认无关，不修改。

## 修复边界
1. 在既有 focus-controls.css 中仅对 `#main-content` 和 `.ui-workspace-settings-dialog` 的 focus 取消 outline。保留负 tabIndex 和可交互子控件的 focus-visible 样式。
2. 设置关闭守卫只将可见的其他 dialog/alertdialog 视为上层；隐藏祖先通过布局矩形与 computed visibility 识别。过渡动画中的弹层仍拥有 Esc。
3. 检查 defaultPrevented，尊重子控件已消费的 Esc。用事件传播路径保留来自上层 dialog 的事件归属，避免零时长关闭后同一次事件穿透。
4. 不改业务协议、依赖、文案或版本元数据；CHANGELOG 使用用户指定 V1.4.4。

## 场景矩阵
| 维度 | 验证/边界 |
| --- | --- |
| 标准/紧凑主工作区，空/活跃终端 | 容器不绘制轮廓；无全局 Esc 拦截，终端输入不变 |
| 设置首页，点击空白/按钮/输入框 | 隐藏 keepMounted 抽屉不阻止关闭 |
| 打开 cc-connect/Web 抽屉，嵌套弹窗 | 首次 Esc 只处理最上层；抽屉隐藏后下一次关闭设置 |
| 过渡动画/零时长退出 | 同一事件不得关闭两层 |
| 子控件 preventDefault、IME composing | 不关闭设置 |
| Tab/Shift+Tab，按钮焦点 | 原有焦点提示与焦点陷阱保持 |
| zh-CN/en-US，浅色/深色 | 无新增文案，Esc 逻辑一致，控件焦点样式保持 |
| 其他窗口、最小化/托盘 | DOM 键盘事件只作用于当前窗口，无跨窗口行为 |
| 分屏/Workspan/焦点模式/本地/WSL/SSH/Worktree/Hook | 不触及终端按键和后端；共享外壳规则不依赖这些状态 |

## 影响分析与兼容
已调用 GitNexus impact(SettingsModal/hasOverlayAboveSettings)，结果 UNKNOWN（符号未找到）；FTS 修复缺少原生扩展，analyze 原生 worker 启动失败。源码引用核查确认 SettingsModal 由 App 延迟加载，守卫只供设置 Esc 使用。功能风险低，重点回归嵌套弹框与无动画退出。回滚仅涉及本次 TSX/CSS 修改。
