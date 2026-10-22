# Pi 只读终端等待：外挂契约与上游接入清单

## 维护边界

本功能以独立文件和既有宠物E文件为主，上游共有文件只保留必要的接线、字段透传与版本/文案登记。不要把校验、租期状态机、序列化或展示业务重新搬进上游大模块。

本清单覆盖 Pi 只读等待及 v11 会话重建复位。只读等待最初以上游 `c07e69ee`（V1.4.3）为基线，后续已同步 V1.4.4；不重构此前的宠物E集成。

### 外挂主体：随 fork 保留，不与上游同名文件合并

| 文件 | 职责 |
|---|---|
| `src-tauri/src/features/hooks/desktop_pet_e_ui_prompt.rs` | 专用事件契约、严格校验、审批旁路及序列化分发 |
| `src/shared/lib/desktopPetETerminalPrompt.ts` | 前端事件标记、完整区间类型、有界状态机与租期 |
| `src/features/terminal/hooks/useDesktopPetETerminalPrompts.ts` | 独立监听、到期刷新、daemon 重启清理 |
| `src-tauri/src/pi_extension_template.ts` | 既有 fork 外部模板；正式 UI 生命周期生产者、根实例租约交接与回调作用域 |
| `src/shared/lib/piSessionLifecycle.ts` | 合法 Pi 会话复位、绑定前乱序守卫与带时间戳的空闲投影 |
| `src-tauri/src/infrastructure/daemon/server/pi_session_lifecycle.rs` | 正式本机/WSL Pi `SessionStart` 的明确 `none` 状态 |
| `src/shared/lib/desktopPetEState.ts` 与 `useDesktopPetECoordinator.ts` | 既有 fork 任务投影、去重、空闲历史仲裁和快照接线 |
| `pet-e/src/bridge/protocol.ts` 与 `pet-e/src/renderer/app.ts` | 既有 Electron 宠物协议和只读展示 |
| `scripts/desktopPetETerminalPrompt.test.mjs`、`piSessionLifecycle.test.mjs`、`piHookLifecycle.test.mjs` 及既有宠物E用例 | 独立等待状态机、会话重建、真实终端状态接线和回归保护 |

### 上游接点：同步时只检查这些接口

| 共有文件 | 必须保留的最小接点 | 不放入此文件的内容 |
|---|---|---|
| `src-tauri/src/features/hooks/claude.rs` | 声明外挂模块；请求/广播载荷透传可选 `terminal_prompt`；调用外挂校验和 `route`；Pi 白名单接纳专用事件；SSH 拒绝专用字段 | 字段规则、状态机、序列化分发与审批旁路判断 |
| `src-tauri/src/infrastructure/daemon/server.rs` | 在普通出口副作用之前调用 `payload.dispatch_desktop_pet_e_ui_prompt(...)`，提供原有广播回调，已消费则返回 | 专用载荷序列化、日志、状态处理 |
| `src/app/App.tsx` | 从外挂导入事件标记和守卫，监听参数兼容该标记；普通处理前调用 `isDesktopPetEUiPromptEvent(payload)` 并返回 | 私有载荷定义、等待状态、通知/审批兼容逻辑 |
| `src-tauri/src/infrastructure/daemon/server/hook_status.rs` | 在原映射前调用 `pi_session_lifecycle::reset_status(payload)`；沿用原状态写入 | Pi 身份判定或生命周期规则 |
| `src/features/terminal/lib/terminalStatus.ts` | Pi `SessionStart` 用 helper 覆盖为 `none`；恢复 daemon 时保留明确 `none` | 普通 CLI 事件表修改或按输出猜测 |
| `src/features/terminal/store/terminalRuntime.ts` | 绑定前调用 Pi 复位乱序守卫；复位复用原终态清理分支撤下 shell/输出提示 | 新的事件、状态类型或 Pi 业务规则 |
| `src/features/desktop-pet/{api/desktopPet,lib/desktopPetStatus}.ts` | 通用解析器识别明确 `none`，带时间的生命周期空闲不按输出回退运行 | Pi 特有的租约、会话判定或历史逻辑 |
| `src/features/terminal/components/BackgroundTasksPanel.tsx` 与 `terminal.{zh-CN,en-US}.ts` | 明确 `none` 显示中英文空闲，未知状态仍沿用旧回退 | Pi 协议或新状态类型 |
| `features/hooks/settings/mod.rs` | `PI_EXTENSION_VERSION = 11` 与外部模板标记一致 | 模板内容或新的 UI 设置 |
| `desktop-pet.zh-CN.ts` / `desktop-pet.en-US.ts` | 既有宠物E词条区增加 `desktopPetE.renderer.answerInTerminal` | 新翻译加载器或全局字典重构 |
| `package.json` | 既有 `test:pet-e:contracts` 列表登记新用例 | 新依赖或构建流程 |

`terminalStoreTypes.ts`、`terminal/state.ts`、Replay 和答题 broker 均不修改。只读等待不进入普通终端状态机；v11 的会话复位仅以独立 helper 薄接入原有 Hook 更新器。普通 `CliHookEventName` 不新增私有事件，普通 CLI 的 `SessionStart` 仍仅绑定身份；App 只识别外挂事件标签，完整只读载荷只由外挂验证与消费。

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
pi: { instanceId, instanceStartedAt, sequence, runId }
terminalPrompt: { instanceId, id, sequence, active, kind, title? }
实例内 sequence: 1..Number.MAX_SAFE_INTEGER，复用 pi.sequence 单调分配，不要求连续
等待续报: 5_000ms；显示租期: 30_000ms
托管模板版本: 11
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
- 升级应用后确认 Pi 托管扩展为 v11，再重新加载 Pi；应用/daemon 回调地址变化时须新建终端。没有正式 UI 事件的旧 Pi 不承诺自绘问卷支持，既有标准控件代答保留。
- V1.4.4 起模板同时上报上游运行身份 `pi = { instanceId, instanceStartedAt, sequence, runId }`：根 Pi 在工厂阶段持有进程租约并写入 `CLI_MANAGER_PI_OWNER`，嵌套子进程/同进程 SDK 子会话不得接管父 Tab；结束区分 `Stop` / `Interrupt` / `StopFailure`，并由后端接纳门在 sink 副作用前拒绝重复、迟到与已退役实例。上游若把运行身份改为其它字段名或增加新终端事件，需同步移植进 fork 模板与 `PiHookIdentity`。

## v11：正式会话重建与空闲复位

Pi 1.4.0 的 `/new`、`/resume`、`/fork` 会先发 `session_shutdown`，销毁旧 `AgentSession`，再重新创建资源加载器和扩展工厂。v10 在这些边界保留租约会使新工厂直接退出，不能用“仅修改原 handler 的 sessionId”代替真实重建场景。

- 所有正式 shutdown 先收尾等待、撤销工作心跳和旧请求，再交还当前工厂租约；工厂已初始化但 `session_start` 尚未完成时也必须释放。新的工厂认领相同进程身份并推进代际。旧 Pi 若复用 handler，仅最后认领者可在空租约时恢复；有新工厂接管后旧回调不得再次抢占，reload/quit 的旧回调永久退役。
- v11 的进程级状态保留最后发出时间、传输序号和运行代际。模块重新求值不重置只读等待序号；旧心跳、续报、镜像对话框 finally 和问答 `/open` 返回后都检查租约/会话作用域。迟到的 `/open` 响应只按自身 `requestId` 收尾，不发送针对新会话请求的取消。
- 仅合法本机/WSL Pi `SessionStart` 作为明确 `none`。前端在身份绑定前拒绝较旧复位，沿用原状态更新器清掉旧 Hook/shell 状态及输出活动；daemon 写入带接收时间的 `none`。空会话不会伪造 `UserPromptSubmit` 或 `Stop`，后续真实运行和终态照常更新。
- 宠物E按前端/daemon 时间投影空闲，并保留不渲染的 `none` 候选用于清掉同 Tab 红蓝历史。空闲与普通历史双向按时间仲裁，迟到后台快照不能抹新任务或复活旧任务；真实 `pendingAction` / `terminalPrompt` 始终优先，也不从交互历史复活已结束请求。
- 模块开关仍只控制向外报告。关闭或未安装会话开始模块时不猜测复位；不改变其他 CLI、SSH 安装、普通终态保留规则、事件类型或设置，也不修改 Pi/rpiv 或用户已安装副本。

## 残余风险：服务端问答请求处理乱序

本轮 `/open` 回归夹具延迟的是 HTTP 响应，并未执行真实 broker。`src-tauri/src/desktop_pet_e_agent.rs` 的 `pi_open()` 调用共用 `open()`，后者会替换同一 Tab 内处于等待态的请求，并没有 Pi 会话代际守卫。若旧会话的 `/open` 请求在服务端晚于新会话请求处理，新待答可能在生产者收到旧响应并取消前就已被替换；客户端响应作用域守卫不能撤销这一副作用。

这不是“已验证无风险”的路径。既定范围不修改答题 broker；彻底解决需要单独评估 broker 入口的会话/代际接纳契约，并补真实 broker 的处理乱序回归。实机验收时需额外关注网络延迟下快速切换会话并立即提问的情况，不能把当前模板夹具当作完整跨层证明。

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
cargo test pi_session_lifecycle
cargo test pi_admission
cargo test hook_settings
cargo test hook_client
```

手工验收：先制造一次 Pi 模型失败，再依次检查 `/new`、`/resume`、`/fork`、连续 `/new` 和 `/reload`；空会话清旧错误，下一轮恢复运行及正确终态。继续验证后台/托盘/不同分屏与 Workspan、本机/WSL、部分模块关闭、通知与代答分别关闭时的 rpiv 问卷、正常回答/取消、daemon 重启、真实待答并存及中英文返回会话入口。HTTP 中断超过租期时暂时撤下等待是预期行为。
