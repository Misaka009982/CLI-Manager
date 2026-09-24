# Web 终端剪贴板快捷键修复

## 2026-09-17 追加：统一共享终端查看（用户批准）

- 根因：显示控件随 controlMode 切换导致同一浏览器各标签体验不同。保留共享 PTY 所有权规则，统一显示控制入口，不通过抢占桌面尺寸获得重排。
- 触点：WebTerminal 设置面板、onData/手机 onKey 共用输入入口、cursor/writeParsed 的短时跟随；terminalDisplay 旧 contain 迁移 width、真实字号步进；terminalLayout 镜像 fit 上限 14px；terminalCursorView 仅计算视野；i18n/styles 同步。
- 桥接/后端/桌面尺寸管理确认无须修改；图片上传与 paste 经既有输入入口自然触发跟随。无新协议、依赖或数据库变更。
- 验收：桌面可见/不可见、标签往返均无下拉框；镜像调字号不发送 resize；Web 保留已认可的重排；1–36px/旧 zoom/短网格/长行；手机横向拖动、键盘/方向键/粘贴输入跟随、主动滚动取消跟随、断线拒绝输入不启动跟随。
- 跟随仅在成功发送输入后 1.5 秒内生效，避免远端持续输出长期抢占用户视野；延迟超过此窗口的回显不会强制滚动。实际 Safari/网络验收仍由用户测试安装包。
- GitNexus impact 仍无索引，使用真实源码引用及现有契约降级核对影响范围。

## 追加回归修复：Web 自适应排版（2026-09-16，用户已批准）

本节取代后文“Web 固定 14px 网格、显示设置不触发 resize”的旧设计；剪贴板修复保持不变。

### 根因与发现清单

Web 前端尺寸层先以外层 shell 与固定 14px 生成行列，再修改字号并将 xterm 元素设成固定网格的像素大小；字号与画面大小耦合，且手机工具栏高度被算入网格。修复落在显示/尺寸生产层，不通过背景拉伸掩盖留白。

- `WebTerminal.tsx`：接入真实可用区域、自适应/镜像控制分流；等待回放完成，隐藏标签不重排，目标行列去重发送。
- `terminalLayout.ts`：抽取实际使用的行列/镜像计算，使用所选字号的 xterm 测量；保持原有 500 列/300 行安全上限。
- `terminalDisplay.ts`：Web 所有权下滑块、按钮、滚轮改变字号；桌面镜像仍独立保存 mode/zoom。
- `i18n.ts`：中英文解释当前所有权及缩放限制，不将镜像选项展示为 Web 自适应选项。
- `styles.css` / `MobileTerminalInput.tsx`：确认现有 flex-shrink 扣除手机工具栏占用，保留布局及原生输入行为；测量改用实际 container 而非 shell，无需修改 CSS。
- `useAppModel.resizeTerminal` → `useWebDeviceBridge.executeTerminalCommand`：确认复用 resize 协议，桌面可见时拒绝 Web 调整共享 PTY；本轮不修改桥接、权限与协议。
- 剪贴板、上传、关闭、PTY 输出排序：不改行为，运行相关定向回归。
- GitNexus impact 无可用索引；memory 定位线索由上述源码与契约复核，不依赖旧图谱判定无影响。

### 场景与验收

- Web 控制下：三种旧 mode、旧 zoom=60%、8/14/24/36px、大屏/手机/分屏：字号真实生效，区域固定，行列随可用空间变化。
- 桌面控制下：manual/width/contain 不发送 PTY resize；镜像允许留白/滚动，不冒充独立重排。
- 所有权往返、标签切换、回放与持续输出：回放按记录行列解析，队列排空后布局；相同目标不重复发送，隐藏标签不发送。
- 手机键盘弹出/收起、工具栏展开/收起：使用真实容器空间，保留横向滚动和滚到底部。自动测试覆盖尺寸计算；Safari 实际键盘和布局需人工验证。
- Shell/WSL/Worktree/hook 状态不参与前端计算；无此类路径或协议变更。实际 CLI 对 resize 的重绘行为仍需真机验收。
- 构建/类型检查、定向测试、strict 架构检查；不启动应用或服务。当前版本记录沿用 TEMP，本轮未要求安装包。

## 根因

Web 终端未将 Ctrl+V 从终端按键流中区分出来；xterm 可能把控制字符直接送入运行中的 CLI，使其误触发图片粘贴。桌面端已有明确的剪贴板快捷键策略，Web 端尚未对齐。

## 验收

- 终端选中文字时 Ctrl+C 复制选区且不中断；无选区时 Ctrl+C 中断当前 CLI。
- Ctrl+V 粘贴纯文字一次；图片剪贴板走既有上传链路且只上传一次；空剪贴板不得向 PTY 发送 Ctrl+V。
- 失焦、切换标签、断线与移动端原生输入控件不发生重复发送或串会话。
- Web 前端类型检查与构建通过；保留现有后端协议与桌面行为。

## 触点

- `apps/web/src/WebTerminal.tsx`：键盘及 paste 事件路由。
- `apps/web/src/useAppModel.ts` → WebSocket 输入：验证原样透传，不修改协议。
- `apps/web/src/MobileTerminalInput.tsx`：独立输入，不应被桌面快捷键拦截。
- `src/features/terminal/hooks/useXTermController.ts`：桌面语义参照。

## 追加：自动适配与字号解耦（用户已批准，同一分支）

### 根因与发现清单

Web 显示控制层把字号滑块、加减按钮与 Ctrl+滚轮统一写成强制 manual，导致自动适配选择被覆盖；修复控制层参数语义，自动模式先适配再缩放。

- `terminalDisplay.ts`：新增独立 zoom，旧数据默认 100%，手动字号独立保存。
- `WebTerminal.tsx`：滑块/按钮/滚轮接入同一模式规则；布局缓存纳入 zoom，自动适配固定 14px 基准，修正 fit 后才缩放，展示最终字号。
- `i18n.ts`：中英文同步说明模式、缩放与溢出。
- localStorage 与标签激活/ResizeObserver：沿用既有广播和重算入口。
- PTY/WebSocket、桌面端、移动端输入及图片上传：确认无须改动；Web 控制权下仍按原有外层空间及 14px 计算行列。
- GitNexus impact 返回 No indexed repositories found；使用 codebase-memory、源码引用和架构契约复核，范围为 Web 显示链路。

### 场景与验收

- width/contain 调整滑块、按钮、Ctrl+滚轮不改变模式；manual 仍调绝对字号。
- 模式来回切换保留手动字号与自动缩放；恢复默认重置全部显示参数。
- 旧设置缺少 zoom、损坏 JSON、边界数值均归一化；刷新及多标签广播沿用原存储键。
- 桌面/手机、分屏、窗口尺寸/DPR 变化、切换标签：可见终端重新计算 fit 后应用缩放，隐藏终端不主动布局。
- 超过 100% 允许横纵溢出，继续使用已有滚动和输入行跟随，不把字号控制反馈成 PTY resize。
- Shell/WSL/Worktree/hook 状态不参与前端显示参数计算，无对应协议改动。
- 自动验证覆盖参数迁移、模式步进、缩放边界与持久化；真实浏览器滚动、移动端输入行、标签切换和中英文显示待人工验收。
