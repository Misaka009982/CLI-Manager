# Pi 完成通知排查证据

## 根因陈述与置信度

已确认的缺陷位于 Pi 扩展到 CLI-Manager 的事件归属边界：生产者仅凭继承的 Tab 环境将本会话 settle 转成顶层 Stop，消费者又优先信任相同 Tab 并允许新 sessionId 覆盖绑定，因而无法隔离嵌套 Pi 的收尾；通知出口也未接收统一的过期/拒绝结论。修复应落在生产与接纳边界，不能只给 toast 加节流。

这是一条可成立并经模拟验证的故障路径，尚不是对反馈现场触发源的定论。用户随后确认反馈者版本为 Pi 1.2.0；扩展列表仍未知。版本专属核验以 `official-v1.2.0.md` 为准，下面的 0.84.1 证据仅保留为初次排查记录。

## 截图逐项核验

1. **agent_settled → Stop 映射存在，但不能直接判定选错事件。** `settings/pi.rs:157`、契约 `cli-hook-contracts.md:1010` 与 `settings/tests.rs:940` 一致。Pi 本机 0.84.1 的 `dist/core/agent-session.js:744` 在 `while (_handlePostAgentRun()) agent.continue()` 完成后的 finally 才 `_emitAgentSettled`。其 docs/extensions.md:560 明确用于自动续跑结束后的状态集成。当前官方 JSON 文档区分低层 agent_end 与 session-level agent_settled。因此“每轮自动 continuation 都 settle”不成立为通用结论；独立新运行和外部后台任务需另行区分。
2. **无去重 ID 已确认；每次新 UUID 不准确。** Pi 模板 payload `pi.rs:105` 不含 eventId/remoteEventId。HTTP 请求 Rust 字段为 remote_event_id，camelCase JSON 键是 remoteEventId（`claude.rs:58,88`），无 ID 在 `RecentHookEvents::accept:35` 直接返回 true。`claude.rs:800` 的 eventId 是另一输入解析路径，不可误用。该文件的 new_v4 命中为测试，不是此 HTTP 生产链路。给每个独立 settle 分配 UUID 仍无法合并不同运行或子进程事件。
3. **无 Pi 通知合并已确认。** `terminalStatus.ts:230` 对 Pi 返回 suppressCompletionNotification=false；`App.tsx:236` 的去重只覆盖 Codex goal；`:225` 每次递增 toast 序号，`:536` 创建新 toast；`:985` 处理状态后仍走通知。
4. **子进程污染路径成立，现场发生情况待证实。** 模板读取当前 process.env，未带进程所有者/父子身份。若子 Pi 继承环境并加载全局扩展，会向同一 Tab 发不同 sessionId 的 Stop。`terminalHookBinding.ts:75` exact 不校验 sessionId；`terminalRuntime.ts:605` 调用 `terminalCliSession.ts:6` 无条件接受不同非空 sessionId。因此后果不仅是弹窗，还包含 Tab done 和统计会话绑定切换。
5. **新增发现：过期状态过滤不等于过期通知过滤。** `terminalRuntime.ts:651` 对旧 timestamp 返回 tabId，仅跳过状态更新；`App.tsx:985` 接到 tabId 后继续通知。异步 `void postHookEvent` 不保证跨请求到达顺序。
6. **现有日志不足以还原 Pi 完成序列。** `claude.rs:1014` diagnostic 白名单不含 SessionStart/UserPromptSubmit/Stop，不能假定已有日志记录完整的 Pi 根会话运行序列。
7. **v1.2.0 的取消/失败被无条件 Stop 吞掉。** `pi.rs:157` 忽略 `_event`，没有检查 `event.aborted` 或最终 assistant 结果；Pi 官方 settle 事件并不等于成功。后端 `claude.rs:1001` 目前只接纳 Pi 的 SessionStart/UserPromptSubmit/Stop，故修复取消/失败须同步该白名单，不能仅在扩展发送 Interrupt/StopFailure。
8. **v1.2.0 的 deferred 新运行是独立分支。** 官方 `_emitAgentSettled` 先派发 settle、再执行 deferred actions；不能以本机 0.84.1 行为或一次 isIdle 检查保证所有第三方续跑均被覆盖。此分支与内部重试/压缩/队列续跑分开验证。

## 隔离实验（2026-10-15）

从仓库 pi_extension_source 原始字符串提取模板，填充模块开关并使用仓库 TypeScript 编译器转译，在 Node vm 中运行。process.env 使用虚拟父 Tab、fetch 使用内存桩；未请求网络、未执行模型、未修改用户扩展。

输入：主 session agent_start；子 session agent_settled 两次；主 session 在 ctx.isIdle()=false 时 agent_settled。

输出：同一父 Tab 上依次收到 UserPromptSubmit(parent)、Stop(child)、Stop(child)、Stop(parent)，均无去重 ID。断言全部通过。

边界：手动调用回调证明扩展处理逻辑缺乏保护；并未证明 Pi 会在普通内部续跑时产生这些回调，也未重现反馈者的真实进程树。

## 发现清单

| 触点 | 结论 / 后续处理 |
|---|---|
| settings/pi.rs | 确认问题源头；主进程所有权、主 session 与运行代际需设计并行为验证 |
| settings/tests.rs | 现有测试主要检查模板字符串与安装状态，缺少运行中子进程/乱序行为覆盖 |
| claude.rs HTTP 接纳及 RecentHookEvents | 无 ID 放行是兼容行为；不得盲目要求所有旧客户端带 ID；若接入 ID 应使用该路径真实字段 |
| terminalHookBinding.ts / terminalCliSession.ts | exact Tab 优先且重绑无生命周期限制；需评估 Pi 专属接纳，避免破坏合法切换 |
| terminalRuntime.ts | 更新身份、刷新统计、状态过期检查的顺序需纳入接纳契约；拒绝必须早于副作用 |
| App.tsx | 状态处理结果未统一控制通知，需覆盖 toast、系统通知、任务栏注意请求 |
| terminalStatus.ts | 已确认 Pi Stop → done；Codex goal 规则不能原样挪到 Pi |
| terminal/api/replayStore.ts | 消费 Hook 的回放状态，实施前追踪共同接纳边界，避免主 UI 与回放不一致 |
| daemon/第三方通知 fan-out | 实施前确认所有扇出点使用同一接纳结论，不能仅修 App |
| PTY 环境注入/WSL/SSH | 环境继承是触发前提；优先由 Pi 扩展建立 root owner，避免无依据修改所有 shell 注入 |
| 通用样式 / 翻译 / 历史解析算法 | 确认不是事件来源根因；如方案新增文案再按语言规则处理 |
| cli-hook-contracts.md | 修改归属与完成接纳契约及测试要求，保留正确的 settle 语义 |
| Pi event whitelist / outcome / 文案 | v1.2.0 补充：取消/失败出口需端到端对齐；Pi 专属运行结束文案按语言键实现 |

## 工具限制

无 .codegraph，按规则跳过。GitNexus query 返回 FTS missing；context 结果存在异常候选且若干实际存在符号查询不到；resolveCliHookTarget impact 返回 UNKNOWN/target not found，不能报告为 LOW 或“无影响”。本轮按契约与定向源码跟踪完成只读调查。实施前先修复/刷新可用索引再对拟改符号跑影响分析；公共绑定/通知路径暂按较广影响评估。

## 来源

- 官方当前扩展文档：https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- 官方当前 JSON 文档：https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md
- 本机验证版本：F:/soft/nodejs/node_global/node_modules/@earendil-works/pi-coding-agent/package.json，version=0.84.1；仅代表本机，不代表反馈者。
- 用户确认反馈版本为 1.2.0 后，已改用官方 v1.2.0 固定标签核验，来源与结论见 `official-v1.2.0.md`。
- 旧任务 `.trellis/tasks/07-21-pi-agent-hook/prd.md` 明确处理模块安装和重复 running，且将 Pi 子 Agent 支持列为范围外；不能据此声称已处理子会话完成归属。


## 实施补充（V1.4.4）

已用隔离的官方 Pi 1.2.0 SDK 与模拟模型验证 9 种实际生命周期序列；before-settle、follow-up、重试、压缩仅在最终产生 settle，settle handler 的 deferred 新运行确有两次 settle，生成模板能取消已观察到新运行前的旧候选。模板测试进一步覆盖子进程与同进程早启动 SDK、会话切换/reload 和网络超时。统一 HTTP 入口的实际 loopback 回归验证所有 sink 之前拒绝旧/重复载荷。仅凭这些证据仍不能判断反馈者具体用了哪个第三方扩展。

索引使用 F:/github/cli-m/CLI-Manager，避免短名称解析到另一个 checkout；已刷新，FTS 扩展不可用但符号 impact/detect_changes 可执行。实现边界、自动检查与待手动项见 design.md、validation.md。
