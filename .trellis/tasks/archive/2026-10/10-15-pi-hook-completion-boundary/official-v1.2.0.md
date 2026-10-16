# 官方 Pi v1.2.0 核验（2026-10-15）

用户确认反馈版本为 1.2.0。所有本轮结论固定到官方仓库 v1.2.0 标签，不再用本机 0.84.1 或滚动 main 代表反馈者版本。[版本清单](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/package.json)

## 生命周期与完成含义

低层 agent_end 之后可能继续重试、恢复、压缩和排队工作；agent_before_settle 允许扩展要求继续，不能当完成事件。agent_settled 才是当前会话运行收尾通知。官方 notify 示例选用此事件，文案为 Ready for input；它不表示用户业务目标已经达成。[扩展文档](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md)、[JSON 事件文档](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/json.md)、[官方通知示例](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/examples/extensions/notify.ts)

AgentSettledEvent 带 aborted；取消也会收尾。事件本身没有成功 outcome、父进程、后台任务计数或 run ID。AgentEndEvent 带 messages；AgentBeforeSettleEvent 有 outcome，但仍是可继续的中间边界。普通 ExtensionContext 提供 isIdle 和 hasPendingMessages；waitForIdle 属于 ExtensionCommandContext，不能假定 settle 回调能调用它。[类型定义](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/extensions/types.ts)

## 源码补充：扩展发起的新运行

在 AgentSession 中，_startRun 等待低层执行、post-run 工作及 before-settle continuation 后才收尾；_emitAgentSettled 先派发事件，再处理回调期间登记的 deferred actions。prompt 和触发新 turn 的 custom message 存在该延后路径。因此“当前运行内部不再继续”和“扩展不会发起下一次运行”是两件事。isIdle 读活动/压缩态，hasPendingMessages 读 steering/follow-up 队列，不暴露 deferred actions。[AgentSession 源码](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/agent-session.ts)

推论：在 settle 回调立即检查 isIdle/hasPendingMessages，或者随意等待固定毫秒数，都不能证明任意第三方工作流已结束。计划必须分别测试标准 continuation、回调触发的新运行与后台子实例；不能把后两者直接归为 Pi 内部 settle 语义错误。

## 对现有方案的修订

1. 保留 agent_settled；before_agent_start 可用于本地运行代际跟踪，但不得再与 agent_start 重复上报 running。只观察事件，不请求 continue、不改写 Pi 队列。
2. 新增取消与最终错误分类：aborted 优先；最终错误依据本轮最新已完成 assistant 消息/结果，不能把一次中间 error 永久锁为失败；结果不足时只表示结束，不伪造成功。不得在 agent_end 就提前发失败。
3. Pi 专属展示建议为“本轮运行已结束 / Run ended”，避免全局“任务完成”暗示业务目标与后台任务全结束；需方案评审确认。
4. 根实例/子实例隔离仍需要，但官方 settle 未提供根身份；owner 标记属于 CLI-Manager 自己的兼容设计，不能描述为官方 Pi 协议。不能使用 hasUI、cwd、输入来源或 session 父链单独判定子代理。
5. 去重按 owner/session/run/event 区分语义重复与传输重复；接纳前已观测新运行时拒绝旧完成。延迟派发只可作为有界优化，不能成为正确性依据。
6. 优先加可控、限量、无提示词/令牌的事件诊断，并用固定 1.2.0 SDK/CLI 与模拟模型复现。现场未提供扩展，子实例污染、扩展新运行、旧载荷乱序依然是不同候选原因。

## 必须新增的验证

- 正常主会话；多个工具回合；重试失败后成功；最终失败；压缩续跑；排队 follow-up；before-settle continuation。
- Escape/abort（含重试/收尾阶段）；最终不报成功且运行态能清理。
- settle 回调触发新请求（含较晚注册及异步 handler）；记录真实序列，验证已知新 run 的旧完成拒绝，不用预设 idle=false 掩盖竞态。
- 子进程继承父环境、同进程多个 SDK session、resume/switch/reload、stop-only 模块与旧托管扩展。
- HTTP 接纳 → daemon/第三方通知 → 桌面状态/通知 → 回放使用一致的归属和结果；单层通过不能算完成。

实施阶段已在临时目录隔离安装官方 Pi 1.2.0 SDK，以模拟模型完成 9 个实际生命周期场景（含工具循环、重试、压缩、follow-up、before-settle 与 deferred 新运行、取消和最终错误），全部通过。未使用真实模型请求，未修改用户全局 Pi 或扩展配置。异步扩展未来启动的新任务仍无法由当前 settle 推断，现场扩展与样本仍待反馈。完整验证见 validation.md。
