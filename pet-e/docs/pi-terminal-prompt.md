# Pi 只读终端等待：外挂契约与上游接入清单

## 维护边界

本功能以独立文件和既有宠物E文件为主，上游共有文件只保留必要的接线、字段透传与版本/文案登记。不要把校验、租期状态机、序列化或展示业务重新搬进上游大模块。

本清单仅覆盖本轮 Pi 只读等待功能，以已合入的上游 `c07e69ee`（V1.4.3）为基线，不重构此前的宠物E集成。

### 外挂主体：随 fork 保留，不与上游同名文件合并

| 文件 | 职责 |
|---|---|
| `src-tauri/src/features/hooks/desktop_pet_e_ui_prompt.rs` | 专用事件契约、严格校验、审批旁路及序列化分发 |
| `src/shared/lib/desktopPetETerminalPrompt.ts` | 前端事件标记、完整区间类型、有界状态机与租期 |
| `src/features/terminal/hooks/useDesktopPetETerminalPrompts.ts` | 独立监听、到期刷新、daemon 重启清理 |
| `src-tauri/src/pi_extension_template.ts` | 既有 fork 外部模板；正式 UI 生命周期生产者 |
| `src/shared/lib/desktopPetEState.ts` 与 `useDesktopPetECoordinator.ts` | 既有 fork 任务投影、去重和快照接线 |
| `pet-e/src/bridge/protocol.ts` 与 `pet-e/src/renderer/app.ts` | 既有 Electron 宠物协议和只读展示 |
| `scripts/desktopPetETerminalPrompt.test.mjs` 及既有宠物E用例 | 独立状态机、跨层接线和回归保护 |

### 上游接点：同步时只检查这些接口

| 共有文件 | 必须保留的最小接点 | 不放入此文件的内容 |
|---|---|---|
| `src-tauri/src/features/hooks/claude.rs` | 声明外挂模块；请求/广播载荷透传可选 `terminal_prompt`；调用外挂校验和 `route`；Pi 白名单接纳专用事件；SSH 拒绝专用字段 | 字段规则、状态机、序列化分发与审批旁路判断 |
| `src-tauri/src/infrastructure/daemon/server.rs` | 在普通出口副作用之前调用 `payload.dispatch_desktop_pet_e_ui_prompt(...)`，提供原有广播回调，已消费则返回 | 专用载荷序列化、日志、状态处理 |
| `src/app/App.tsx` | 从外挂导入事件标记和守卫，监听参数兼容该标记；普通处理前调用 `isDesktopPetEUiPromptEvent(payload)` 并返回 | 私有载荷定义、等待状态、通知/审批兼容逻辑 |
| `features/hooks/settings/mod.rs` | `PI_EXTENSION_VERSION = 9` 与外部模板标记一致 | 模板内容或新的 UI 设置 |
| `desktop-pet.zh-CN.ts` / `desktop-pet.en-US.ts` | 既有宠物E词条区增加 `desktopPetE.renderer.answerInTerminal` | 新翻译加载器或全局字典重构 |
| `package.json` | 既有 `test:pet-e:contracts` 列表登记新用例 | 新依赖或构建流程 |

`terminalStoreTypes.ts`、`terminal/state.ts`、Replay、普通终端状态机和答题 broker 本轮均不修改。普通 `CliHookEventName` 不新增私有事件；App 只识别外挂事件标签，完整载荷只由外挂验证与消费。

### 接入顺序与不可移动的边界

1. 在 `claude.rs` 保留模块声明及可选字段。字段缺省为 `None`，普通广播不序列化空字段；HTTP 转换透传，SSH/普通测试构造器显式置空。不能漏掉构造器或把该字段混入 SSH spool。
2. `is_valid_payload` 先调用外挂校验；既有 HTTP 鉴权、大小限制和去重不改。审批出口将事件交给 `desktop_pet_e_ui_prompt::route(payload, &delivery, ordinary)`，其中 `ordinary` 调用原有仲裁器。
3. daemon 接点必须在 `maybe_activate_app_for_hook`、第三方通知、答题 broker、handoff 和任务状态更新之前。只把现有 `broadcast_hook` 回调交给外挂，已消费即返回。
4. App 接点必须在 `resolveCliHookStatus`、Replay 和会话绑定之前。不能为了接私有事件去扩展上游普通 Hook 类型或事件映射表。
5. 保持原有外部模板 `include_str!` 入口；上游模板变更需要移植进 fork 模板，不能用上游内联字符串替换。模板修改同步升版，保留本 fork 的 2 秒请求超时。
6. 上游若移动上述入口，只调整调用位置及独立模块导入路径，不复制外挂实现到新入口。同步后核对下述契约用例；不要用整文件取舍覆盖混合了上游和 fork 的入口。

## 运行契约

### 范围与载荷

仅使用 Pi 正式 `ui_prompt_start` / `ui_prompt_end` 的外层等待区间。当前依据 Pi 1.2.0 公开类型核对，覆盖 `select` / `confirm` / `input` / `editor` / `custom`，不读取自绘控件的选项或回填答案。本机/WSL 复用鉴权 Hook HTTP，不扩展 SSH、不新增端口、依赖、设置或数据库，不修改 rpiv。

```text
source: pi
event: DesktopPetEUiPrompt
tabId / sessionId / timestamp / remoteEventId: 必需
terminalPrompt: { instanceId, id, sequence, active, kind, title? }
实例内 sequence: 1..Number.MAX_SAFE_INTEGER
等待续报: 5_000ms；显示租期: 30_000ms
托管模板版本: 9
请求超时: REQUEST_TIMEOUT_MS = 2_000
```

- 区间与实例标识不为空、不含控制字符，最多 128 UTF-8 字节；Tab 最多 128 字节，Pi 会话最多 256 字节。标题最多 512 个 Unicode 字符，禁止控制字符；严格校验种类、布尔量、安全整数及未知区间字段。
- 普通 Hook 不允许夹带 `terminalPrompt`；非 Pi 来源、缺失身份、SSH 环境或远端字段、混入工具/审批输入的专用载荷被拒绝。
- `DesktopPetEUiPromptEvent` 只是前端入口的最小事件标记，不宣称完整载荷可信。完整数据始终由独立 reducer 校验，普通 Hook 类型和消费者保持不变。

### 隔离与生命周期

- 专用事件不经过答题 broker，不触发审批仲裁轮询、应用激活、普通任务状态、Replay、第三方通知、handoff 或子任务分屏。
- Pi 报告先抓取会话/区间身份并分配序号，再异步发送。续报不改变区间 ID 和标题；结束先清计时器。`session_start`、`agent_settled`、`session_shutdown` 经同一入口收尾并配平心跳计数。
- 正式等待挂起工作心跳；结束且 agent 仍运行时立即报告继续工作。普通心跳不是回答完成证据。本扩展自己的界面也产生只读状态，但真实 `pendingAction` 永远优先。
- 前端按发出时间计算租期，拒绝过期缓存、超过 5 秒的未来时间、重复/倒退序号和退役实例。结束保留游标，旧开始不能复活；不同区间的迟到结束不能撤销当前等待。租期过期只撤下显示，未结束区间的新有效续报可以恢复。
- 状态最多保留 256 个会话作用域、每作用域 16 个退役实例；容量淘汰提升时间下界，实例上限时拒绝未知实例，不通过丢弃游标放行旧消息。daemon 重启清空显示并提升时间下界。
- `SessionStart` / `Stop` / `StopFailure` 仅在 Pi 来源、Tab、会话及时间匹配时清理。只投影到 CLI 身份匹配的存活本机/WSL PTY，排除 SSH、远程托管、已退出进程及非 PTY 面板，不根据焦点、最近提问或输出文本猜测答案。

### 展示与升级

- 可选快照字段 `terminalPrompt` 只含只读展示信息。序号和租期不进入快照，续报复用展示对象，不提升快照 revision。任务 ID 使用长度前缀组合身份，避免转义膨胀；提交契约与宠物协议版本不变。
- 只读项显示本地化“请在终端作答”，动态文本转义，沿用打开会话按钮；只有交互式 `pendingAction` 可进入回答面板。真实请求、只读等待、普通状态按此优先级去重，同会话只计一次。
- 只服从宠物总开关，不依赖 `notificationsEnabled` / `agentInteractionEnabled`。普通通知不计黄灯，等待状态不进入红蓝终态历史。
- 升级应用后确认 Pi 托管扩展为 v9，再重新加载 Pi；应用/daemon 回调地址变化时须新建终端。没有正式 UI 事件的旧 Pi 不承诺自绘问卷支持，既有标准控件代答保留。

## 验证与交付限制

本轮仅静态核查，未执行编译、测试、安装或启动。下列命令由用户在本地执行，不把未执行的用例记为通过。

在 worktree 根目录：

```powershell
npm run build
npm run build:pet-e
npm run test:pet-e:contracts
npm run check:architecture -- --strict
```

在 `src-tauri` 目录：

```powershell
cargo test desktop_pet_e_ui_prompt
cargo test hook_settings
cargo test hook_client
```

手工验收：通知与代答分别关闭时打开 rpiv 问卷、等待超过 30 秒、正常回答/取消、多会话与 WSL、会话切换/退出、daemon 重启、真实代答并存，以及中英文文案和返回会话按钮。HTTP 中断超过租期时暂时撤下等待是预期行为。
