# 排查并规划 Pi Hook 提前与重复完成通知修复

## Goal

用户反馈 Pi 仍在执行任务时，CLI-Manager 持续提示完成。核验反馈者截图中的定位，区分已确认缺陷与现场待确认触发条件，规划从事件生产与会话归属边界修复，避免只减少弹窗数量。

## Background / Confirmed Facts

- 基线：master `4fbd7c03`，工作区初始干净，与本地 origin/master 引用 ahead/behind 均为 0，未 fetch。
- 用户授权创建 task、排查并规划修复；随后已同意按官方 v1.2.0 修订方案实施，变更记录版本为 V1.4.4。截图是反馈用户自己定位的结果，不是已经验证的根因。
- 用户已确认反馈者使用 **Pi 1.2.0**；扩展列表和现场事件序列仍未知。该版本不代表 CLI-Manager 的变更记录版本。
- 已核对官方 `v1.2.0` 标签的文档、类型与源码：内部重试、压缩、队列以及 `agent_before_settle` 请求的续跑先完成，之后才发 `agent_settled`。其 `aborted` 字段区分取消；settle 本身不保证业务任务成功。
- 官方通知示例用 settle 提示 Ready for input。源码另有 settle 回调中提交请求的 deferred actions，回调派发结束后仍可启动独立新运行；单次 isIdle 检查不能证明第三方工作流整体完成。证据见 `official-v1.2.0.md`。
- 生成扩展无条件把 settle 上报为 Stop，只有 Tab/port/token 非空检查，没有主进程/子会话归属和 idle 检查：`src-tauri/src/features/hooks/settings/pi.rs:99,157`。
- 相同 Tab 优先绑定，随后任何新的 sessionId 都可覆盖原绑定：`src/features/terminal/store/terminalHookBinding.ts:75`、`terminalRuntime.ts:605`、`terminalCliSession.ts:6`。
- Pi Stop 会进入 done 并通知；完成抑制/通知去重目前为 Codex goal 专用：`src/features/terminal/lib/terminalStatus.ts:230`、`src/app/App.tsx:236,985`。
- 详尽证据、发现清单、模拟验证和未证实事项见 `research.md`。

## Requirements

- R1：只有当前终端所拥有的 Pi 主会话结束当前运行时，才允许将该 Tab 标为完成并通知；嵌套 Pi/子会话不得污染父会话状态、身份或完成提醒。
- R2：重复投递同一结束事件、迟到的旧运行结束事件不得再次提示完成或覆盖新运行；不得因永久去重而漏掉下一次正常完成。
- R3：保留 agent_settled 作为 Pi 自身运行收尾信号，不将 agent_end/turn_end/agent_before_settle 替换为完成依据；接纳前已观察到的新运行须使旧完成失效。不能承诺检测尚未公开的第三方 deferred actions 或未来后台任务。
- R4：保持正常 SessionStart、running、真实完成、会话切换/恢复、模块单独启用以及桥接不可用时非阻塞行为。
- R5：修复不得改变其他 CLI 的完成判定；如变更公共绑定或接纳契约，必须对现有来源与本地/WSL/SSH 兼容行为回归。
- R6：修改代码后更新领域契约、CHANGELOG.md 与 docs/功能清单.md；用户指定变更记录版本为 V1.4.4。用户可见文案兼容 zh-CN/en-US，时间保持 24 小时。
- R7：Pi 1.2.0 的取消和最终失败不得被翻译为成功完成。取消清理运行态且不发完成提醒；失败复用失败状态/通知。中间失败后重试成功必须按最终结果处理。
- R8（已批准）：Pi 正常收尾文案改为“本轮运行已结束 / Run ended”，限定当前主会话运行语义；不声称所有后台代理或业务目标已完成。其他 CLI 文案保持原有语义。

## Acceptance Criteria

- AC1 / R1：主会话工作期间，继承相同 CLI_MANAGER 环境的子 Pi 收尾不会改变父 Tab 状态、sessionId、统计绑定或触发任一完成通知通道。
- AC2 / R2：同一运行重复结束只通知一次；新的有效运行仍可通知；旧 Stop 晚于新 running 到达时不通知也不回退状态。
- AC3 / R3：Pi 内部工具循环、自动重试、压缩续跑、队列 follow-up 不提前完成；扩展重新启动运行的场景得到定向验证。
- AC4 / R4：普通主会话结束通知一次，合法切换/恢复可重新绑定；仅安装 stop 模块和扩展 reload 不产生永久静默；网络不可用不会阻塞 Pi。
- AC5 / R5：多 Tab/分屏、多窗口、前后台与托盘只影响展示，不改变事件归属；本地与 WSL 分别验证，SSH 先确认 Pi 支持范围再选择回归或明确不适用。
- AC6 / R6：行为回归、必要类型/编译检查、独立严格架构检查通过；更新两份代码变更记录。只有文档的排查阶段不需要追加代码变更记录。
- AC7 / R7：Escape/abort 后不出现成功通知且不残留 running；最终模型错误显示失败；先失败后重试成功只按成功收尾；缺失结果不得伪造成功。
- AC8 / R3,R8：官方 before-settle continuation 和 settle 回调中新请求分别建例，明确区分同一运行续跑与独立新运行；验收不得只用 ctx.isIdle=false 的手工回调代替真实 v1.2.0 行为。

## Out of Scope

- 不推断任意第三方工作流的“整个目标完成”，不为所有 Pi 扩展建立通用任务编排协议。
- 不用固定冷却窗口掩盖错误会话来源，不重构所有 CLI 通知系统，不安装/升级用户 Pi 或修改用户实际扩展配置。
- 已获批准实施；不能将模拟模型集成验证表述为已复现反馈现场。

## Deferred Evidence

版本已确认是 1.2.0；子代理/续跑扩展及带时间顺序的事件样本尚未取得。实施可验证已确认的归属、取消/失败和通知接纳缺口，但现场根因关闭仍需回归反馈；不得将不确定性隐去。


## 验收确认

2026-10-16 用户确认 Hook 修复验证完成并授权提交，任务进入归档。此前的现场触发源不确定性保留为研究边界，不妨碍已验证修复的交付。
