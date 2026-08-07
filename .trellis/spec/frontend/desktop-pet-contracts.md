# Desktop Pet Contracts

> 桌宠是 CLI-Manager 管理全部 Agent 与后台任务的通用悬浮入口；Pi 只追加原生生命周期、心跳、最终中断和显式用户决策桥，不改变其他 Agent 的 Hook、任务与远程托管能力。

## Scenario: Free-floating multi-agent status, menu, and independent Bubble

### 1. Scope / Trigger

- Trigger: 修改 `DesktopPetApp`、`DesktopPetBubbleApp`、`DesktopPetAlertCards`、`desktopPet.css`、`desktopPetBubble.css`、`useDesktopPetCoordinator`、`desktopPet.ts`、`desktopPetBubble.ts`、`desktopPetMenu.ts`、`desktopPetTransport.ts`、`terminalStore` 的桌宠状态元数据，或任一桌宠窗口的原生几何、生命周期与命中区域。
- Applies to: Claude、Codex、Grok、Pi、自定义 Agent 终端与 daemon 后台任务；Pi 决策卡和中断事故是通用卡片通道中的 Pi 专属生产源。

### 2. Signatures

```text
DesktopPetSurface = desktop-pet | desktop-pet-bubble
DesktopPetStatusColor = green | red | blue
green = running
red = failed + unacknowledged incidents
blue = attention + done + pending decisions

DesktopPetBubbleContent = {
  decisions,  // permission > questionnaire > question
  incidents,  // newest first
  completion  // newest stable done target, at most one
}

DesktopPetWindowGeneration = {
  lifecycleToken,
  petSurfaceEpoch,
  bubbleSurfaceEpoch,
  boundsRevision,
  regionRevision
}

DesktopPetSnapshot = {
  statusCounts,
  targets,
  decisionRequests,
  incidents,
  ...existing pet/handoff fields
}
```

### 3. Contracts

- `desktop-pet` 只拥有宠物舞台、条件状态轨、普通 target/远程托管菜单和既有桌宠操作；`desktop-pet-bubble` 是唯一警报表面，独占决策、事故与完成摘要。三类警报不得再在宠物菜单中重复渲染，Bubble 也不得复制快捷操作菜单。
- 桌宠原生窗口保持透明、无装饰、跳过任务栏；折叠态只容纳宠物锚点，普通 target 菜单打开时以锚点为基准向工作区空间更充足的一侧扩展，不得把消息硬裁切在固定 `190×210` 框内。Bubble 是预创建的第二个透明、无装饰、默认隐藏窗口，不持久化自身位置，也不改变宠物位置真相。
- 三色状态轨是所有 Agent 的聚合能力：绿色表示运行中，红色表示失败/最终中断，蓝色表示待用户处理或已完成。只渲染数量大于零的颜色，三色均为零时不渲染 nav 或其命中区域；当前筛选颜色归零时恢复无筛选。状态轨绝对定位在宠物舞台内，按钮增删不得改变外层窗口 bounds 或宠物锚点。点击颜色只筛选普通 target；红/蓝按钮还会在 Bubble 中滚动/强调同色分组，但不隐藏 Bubble 中的其他可行动卡片，也不改变任务状态或抢走键盘焦点。
- 普通 target 菜单和 Bubble 卡片都必须展示各自完整标题与消息；决策还必须展示完整选项说明和自定义回答输入。Bubble 固定按“权限决策 → 问卷 → 普通问题 → 新到旧事故 → 完成摘要”堆叠，工作区充足时自然扩高，只有工作区不足时才在 Bubble 内部滚动。不得用 CSS clamp、固定卡片高度或截断正文代替几何测量。
- 完成摘要只选择最新的稳定 done target；`updatedAt` 相同时使用稳定 ID 决胜。其寿命从源 `updatedAt` 起算 8 秒，重复快照或 WebView 重载不得重置；指针悬停只暂停尚余时间，离开后继续。普通 running/tool 事件不生成 Bubble 卡片，决策和事故按既有关闭墓碑/用户确认生命周期保留。
- Bubble 布局使用 `layout request → measure → native bounds → geometry` 握手：宠物窗口读取自身物理锚点、目标显示器工作区与 scale factor，按上/下优先、左右回退和可用空间规则定位，再由 Rust 无激活显示。用户拖动、菜单/尺寸、DPI、监视器、状态轨或内容变化都触发最新值重算；移动突发每帧最多安排一次，并在停止后应用最终位置。旧 token、旧 surface epoch、旧 measurement 或旧 revision 不得覆盖新布局。
- 主窗口每次原生同步生成新的高熵 `lifecycleToken`，先提交 Rust 生命周期，再按 `config → snapshot` 顺序扇出两个表面；两类状态事件都携带目标 `surfaceEpoch` 与单调 `deliveryRevision`，所有 config 成功前不得启动 snapshot，任一目标失败都不得推进 transport fingerprint。主窗口与两个静态 WebView 通过 coordinator-ready/ready 双向启动握手覆盖任意加载顺序；两个 WebView 各自生成 `surfaceEpoch`，单侧重载会建立新生命周期并拒绝旧实例或旧状态投递。Bubble ready 与新警报同步保留当前宠物 bounds 和展开菜单，Pet ready、设置或位置变化才执行完整宠物几何同步。隐藏同步先在 Rust 撤销可见代际、清除 region 并隐藏两个原生窗口，随后向 WebView 发送清空 config 以移除正文、输入草稿、焦点状态与计时器；迟到 bounds、region 或 show 请求不能恢复已隐藏窗口。
- Windows 使用每个窗口自己的多个矩形 `SetWindowRgn`：宠物舞台、可见状态按钮、展开菜单、Bubble 可见卡片/滚动控件分别上报，透明间隙不扩大成总包围框。DOM rect 先裁到 viewport，再按本窗口 scale factor 向外取整为本地物理像素；resize 前清除旧 region，事务失败时恢复完整矩形以保证决策仍可操作。macOS/Linux 保留完整窗口命中作为安全回退，不宣称原生透明区点击穿透。
- Bubble 不因显示、定位、分组强调或内容替换主动聚焦；只有用户点击输入控件后才取得焦点。卡片身份稳定，移除当前焦点卡时将焦点接续到下一张卡；完成摘要使用礼貌播报。Agent 文本只通过 React 文本节点渲染，不使用 HTML 注入 API，正文、自定义答案和完整 payload 不进入新增日志。
- Bubble 使用独立最小权限 capability，只含必要事件与日志能力，不获得 SQL、文件、剪贴板、更新器、进程或通知权限。原生命令由 Rust 按 caller/target、`lifecycleToken`、`surfaceEpoch` 和单调 revision 联合授权；WebView payload 本身不构成授权。
- 同一待决策或事故不得同时再显示为重复 target 卡。待决策始终替代其匹配 target；事故替代 failed target 或时间不早于 target 最新状态的匹配项，但新回合的更晚 running 状态仍可与未确认的旧事故并存。先以 Hook `tabId` 与 target 的终端 Tab ID 精确匹配；仅当 target 对应终端已绑定 `cliSessionId` 时，才以该绑定值匹配 Pi `sessionId`。不得把 Pi `sessionId` 直接与任意 target Tab ID 交叉比较，以免误删其他 Agent/会话。
- `decisionRequests` 仅保存在应用内存；任何终态必须先通过 Hook 时间线单调守卫，且不得用早于决策 `createdAt` 的终态删除新决策。同一 Tab 且携带不早于决策 `createdAt` 的当前终态可清理其待决策，跨 Tab 清理则必须同时匹配 Pi `sourceInstanceId` 与 `sessionId`。broker 会在前端消费者重连后重新广播仍待处理的决策；`ack`/`cancel` 发送可在断线时缓存一次的关闭墓碑，消费者断开则让 Pi 回退原生 UI 且不遗留失效卡。决策及其关闭墓碑不得进入 Replay、任务状态、toast 或第三方通知。`incidents` 使用 `cli-manager.desktop-pet.incidents.v1` 持久化、最多 100 条、加载时做结构和有限数值校验。确认事故只删除对应 ID。
- 新决策或事故可在用户关闭常规桌宠时临时唤起窗口；新的可操作项还必须重新显示被临时隐藏的原生窗口。双窗口原生隐藏成功后由 Rust 以当前 token/epoch 回报主窗口并记录进程内临时隐藏状态；若两窗已隐藏但该回报本身失败，当前 Pet 只针对稳定的 `pet_window_hidden_event_failed` 清除本地内容并以同一 token/epoch 补发，不能把其他隐藏错误伪装成成功。普通完成到期或快照刷新不得意外重新显示，只有新事故/决策、用户重新启用设置或应用重启解除。待决策期间不得执行“隐藏桌宠”，且决策/事故优先于全屏自动隐藏，避免 Pi 在不可见卡片上永久等待。项目设置仍控制普通桌宠可见性，桌宠生命周期只由 CLI-Manager 应用状态管理。
- Pi 决策提交只有 Rust broker 返回成功后才移除卡片；失败保留卡片、显示本地化重试提示并记录诊断，绝不把关闭菜单、超时或断开当作回答。仅有决策/事故而没有普通 target 时，不得伪造可跳转的当前 target。事故卡若对应 daemon-only 后台任务，必须携带/推导 `daemonOnly=true`，点击后先 attach 再跳回。
- Pi 心跳仅更新已有运行态，不进入 Replay、toast、系统通知、第三方通知或无客户端 Hook 缓存；前端与 daemon 各自执行 60 秒看门，并以相同稳定事故 ID 合并最终错误/心跳超时。系统睡眠或看门线程异常漂移恢复后先留出一个新心跳窗口，不把整机暂停误报为中断；主窗口关闭时后台任务仍不会永久停留在绿色。
- 现有远程托管、任务跳回、大小/位置/置顶、`.clipet` 与 Codex Pets 能力必须保留。

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| 新决策到达且桌宠设置关闭、被临时隐藏或处于全屏自动隐藏 | 临时显示宠物与独立 Bubble，并打开蓝色决策卡；不修改设置值。 |
| 最终错误或 Pi 心跳超时 | 写入唯一事故、状态转为 failed、红色计数增加。 |
| 重复事故/决策 ID | 幂等更新或忽略，不重复计数。 |
| broker ack/cancel 在前端短暂断线时完成 | 重连后消费关闭墓碑并移除对应卡片，不把墓碑写入 Replay 或状态机。 |
| 决策提交暂时失败 | 保留卡片并显示重试提示，不伪造回答。 |
| broker 确认请求过期或取消 | 消费关闭墓碑并移除失效卡片；Pi 侧回退原生 UI。 |
| 菜单靠近屏幕四角或负坐标副屏 | 普通 target 菜单保持宠物锚点稳定；Bubble 独立选择上/下/左/右并限制在目标工作区。 |
| 宠物连续跨 DPI/显示器拖动 | Bubble 每帧至多调度一次、停止后跟到最终锚点；不持久化 Bubble 坐标。 |
| Bubble 或宠物 WebView 单侧重载 | coordinator-ready/ready 建立新 surface epoch 和 lifecycle；旧实例的 config/snapshot/geometry/region 请求被拒绝。 |
| 隐藏后收到迟到 measurement/bounds/show | Rust 拒绝旧 token 或不可见代际；两个窗口保持隐藏。 |
| Windows region 合并或上报失败 | 恢复对应窗口完整矩形命中，保留卡片操作，不留下部分 region。 |
| macOS/Linux 显示 Bubble | 使用完整窗口命中安全回退；不得宣称透明间隙原生穿透。 |
| 三色计数全部为零或已选颜色归零 | 不渲染状态轨；清除已失效筛选且宠物锚点不移动。 |
| 完成摘要收到重复快照或 Bubble 重载 | 仍按源 `updatedAt + 8s` 到期；悬停只暂停剩余时间。 |
| 消息/选项很长 | 自动换行并扩大内容高度；仅在工作区不足时滚动。 |
| Heartbeat 在 Stop 后迟到 | 不把 done/failed/attention 重开为 running。 |
| 旧 Stop/StopFailure 晚于新决策到达 | 拒绝旧时间线副作用，不删除新决策、不新增过时事故。 |
| daemon-only 事故点击“打开当前会话” | 先恢复后台 daemon 会话，再激活对应终端。 |

### 5. Good/Base/Bad Cases

- Good: Claude、Codex、Grok 与 Pi 同时运行时，绿色计数聚合所有 Agent；一个 Pi 问题只在独立 Bubble 显示为蓝色完整卡片；一个 Grok 失败仍进入红色普通 target。
- Good: Windows 中点击卡片间透明区域会落到下层应用；任一区域事务失败则整窗保持可点击，不牺牲决策入口。
- Good: 仅完成摘要存在时显示最多 8 秒，用户悬停可暂停；重复快照和 Bubble 重载不延长源时间寿命。
- Good: Pi permission 卡只接受明确 `allow` 或 `deny`，提交失败后卡片仍在。
- Base: 无任务且无警报时桌宠休眠；已有 done 任务显示蓝色并可跳回。
- Bad: 把桌宠改成 Pi-only，或过滤掉其他 Agent 的 Hook/daemon/托管目标。
- Bad: 仅用 CSS 把长消息塞进基础窗口并设置 `overflow:hidden`。
- Bad: 在宠物菜单和 Bubble 同时渲染决策/事故/完成，或让 Bubble 复制快捷操作菜单。
- Bad: 信任 WebView 自报的 target/token、让迟到 geometry 重新显示窗口，或在 region 失败时留下只覆盖部分按钮的命中区域。
- Bad: 宣称 macOS/Linux 具有 Windows `SetWindowRgn` 等价的透明区点击穿透。
- Bad: 点击关闭、菜单收起或等待超时自动批准/拒绝权限。

### 6. Tests Required

- `desktopPetBubblePolicy.test.mjs`：内容优先级、最新完成摘要、源时间 8 秒寿命、重复快照、WebView 重载和悬停暂停。
- `desktopPetBubbleGeometry.test.mjs`：四向 placement、工作区 clamp、负坐标、多 DPI、帧级合并、trailing apply 和 viewport 命中矩形裁切/向外取整。
- `desktopPetMenuGeometry.test.mjs`：普通菜单多 DPI 四角/负坐标、内容高度扩窗、工作区压缩和宠物锚点稳定。
- `desktopPetTransport.test.mjs`：双窗口扇出、严格 config-before-snapshot、目标 epoch/delivery revision、layout request/measurement/geometry 迟到拒绝、完整策略 fingerprint、lifecycle token、surface epoch 接受/去重、隐藏清空和失败重试。
- `desktopPetStatus.test.mjs`：完成/失败/attention 不被 PTY 输出重开；仅显示非零颜色且筛选颜色归零时清理。
- Rust 静态/单测：Pi broker 请求与答案验证、heartbeat 事件范围与 daemon 60 秒看门、稳定事故 ID、Tauri 决策命令注册；桌宠窗口还需覆盖 bounds/token/surface epoch/caller-target 矩阵、region 输入与 revision。
- TypeScript 静态检查：快照、标签、卡片与协调器类型一致。
- 手动发布前：Windows 10/11 多显示器/DPI、inactive show 前台保持、透明间隙点击穿透、长中英文问题、多个 Agent 并发、断开回退、Codex Pets 与远程托管回归；macOS/Linux 验证完整窗口命中安全回退。

### 7. Wrong vs Correct

#### Wrong

```ts
if (payload.source !== "pi") return;
```

#### Correct

```ts
const snapshot = deriveDesktopPetSnapshot(allAgentSessions);
const piAlerts = derivePiSpecificAlerts(piBridgeEvents);
return mergeWithoutDuplicateCards(snapshot, piAlerts);
```
