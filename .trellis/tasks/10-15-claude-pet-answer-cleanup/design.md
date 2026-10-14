# Claude 问答完成回调的独立注册与内部消费

## 根因与证据

实际配置根为 C:/Users/Admin/.claude，静态读取只提取 Hook 元数据：有 PermissionRequest、AskUserQuestion 的 PreToolUse -> Notification 及普通生命周期；没有 PostToolUse。运行 daemon 的版本字段为 1.4.2-42，源码基线 a131b93d 仍有同样的安装依赖。

原 apply_claude_hook_module 仅在 Subagent 安装 ToolStop/AgentToolStop。broker.observe_hook 能清理匹配项，但只安装 Attention 时没有完成输入；旧测试直接构造 ToolStop，没有验证安装前置。Subagent 卸载又整段删除 PreToolUse/PostToolUse，连带删除 Attention 提问入口。

## 复核后排除的方案

曾考虑让两个模块共享普通完成回调。读取 App.tsx 的真实消费路径后发现 ToolStop + agentId 会调用 openSubagentTranscript，AgentToolStop 也会触发发现。因此“复用普通工具结束广播没有 UI 副作用”的假设不成立，该中间方案未提交或部署，已改成专用内部消费。

## 最终方案

- settings/claude_completion.rs 只管理 Attention 所有的 PostToolUse / PostToolUseFailure -> DesktopPetEComplete，幂等安装并校验完整命令与 matcher。
- Subagent 的 ToolStop/AgentToolStop 保持原用途；两个模块定向卸载自己的命令，不再整段删除共享原生事件。
- 全量安装、卸载和公共配置同步复用 CLAUDE_HOOK_EVENTS，包含失败完成事件。
- client.rs 沿用事件名完成归一化和发送，专用事件因此不会被 Agent/Task 的普通 ToolStop 过滤；诊断白名单增加同一常量。
- claude.rs 仅向 Claude 来源开放该事件，在 HTTP 鉴权、载荷校验及去重后交给 desktop_pet_e_completion.rs 消费，返回 204，不进入普通 Hook sink 或通知界面。
- 消费器只把 tabId、sessionId、toolUseId 对应的结束证据交给既有 broker，不修改 broker 的身份匹配、提交确认或生命周期规则；取消事件仍由 broker 正常发布。

## 影响面与风险

GitNexus 不可用，按 cli-hook-contracts.md 与符号引用核查；advisor 未返回有效结果，仅作人工静态复核。

| 触点 | 处理 |
|---|---|
| settings/mod.rs + settings/claude_completion.rs | Attention 独立注册、健康检查、定向卸载、全量事件集合 |
| features/hooks/client.rs | 同一内部事件常量的诊断接纳；发送与归一化结构不变 |
| features/hooks/claude.rs + desktop_pet_e_completion.rs | Claude-only 接纳；鉴权后内部消费，不继续广播 |
| hook-schema | 复用事件名保留 Agent/Task 工具 ID，不修改 |
| daemon/server.rs、desktop_pet_e_agent.rs | 复用同一 broker 及取消事件，不修改 |
| App.tsx、宠物协议、前端、Pi/rpiv、窗口记忆、排序、发布流程 | 无生产改动 |

没有新增监听端口、Tauri IPC 或答案格式；增加的是原 Hook 通道中的内部事件。专用消费必须早于普通 sink，不能在前端隐藏副作用来替代后端隔离。每个修改后的 Rust 文件保持 2000 行以内，不重构超长 broker。

## 场景与限制

- 本地 Windows / WSL 命令引用沿用 build_command / hook_exe_for_dir；覆盖两种命令格式。
- 单独安装、任意顺序、重复安装、两种卸载方向、全量卸载、旧路径和错误 matcher 均覆盖。
- 多会话、分屏、Workspan、托盘和失焦沿用原 tab/tool 绑定，不依赖当前焦点。
- 工具完成事件不得启动分屏、触发 discovery 或系统通知；已有子任务功能仍按原事件运行。
- 未收到回调或交互项缺少可匹配工具 ID 的场景，不新增按“正在运行”强行清理的逻辑；本次只修已确认的安装和分发缺口。
- SSH 安装器不在本机/WSL 修复范围。需要更新应用、重启对应 daemon，并重新安装 Claude 问答模块、重新建立会话；本轮不执行这些操作。
