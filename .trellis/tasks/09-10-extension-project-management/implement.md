# V1.4.0 项目隔离与交互执行记录

先交付全局主线，本任务次之。已授权项目降级：实施中无法保证对应 CLI 的项目 MCP/Skills 效果，则完成仅全局的 UI/启动提示验收；不进行无边界适配探索，不阻塞全局主线。supported/global-only/unknown/error 与实际应用结果分离。

1. [x] 依赖模型、部署及全局可复用列表；遵循父任务收敛稿，能力边界获审阅后实施，不再启动泛化测试轮次。
   - Grok 使用受管 Home；完整继承原配置、仅投影 MCP/Skills。非扩展等价、认证/历史和跨平台作为本任务集成/发布门禁，与启动接线配套实施。
2. [x] 审阅父任务与本任务PRD；读领域规范并完成符号 impact，获实施授权后 start 本子任务。
   - 补读父任务 managed-home-verification-round2.md 作为证据；按 decision.md 有限验收组建立集成夹具，不将 inspect 或假历史列举当作刷新/resume 验收。
   - 先读父任务 managed-home-verification.md：原型只通过配置层集合与本地 MCP 握手；补齐同名定义/动态新增、认证路径与共享锁、历史/leader、完整非扩展等价及跨平台门禁。不能将 inspect 列表等同 MCP 启用状态。
3. [x] 先策略纯函数与原型，再完成启动/恢复接线和快照回收；覆盖并发状态、后台重连、共享/插件来源、外部配置和主题。
   - 按已确认生命周期验证 A 启动→修改原始非扩展配置→B 启动→重连 A→以新进程恢复 A；分别断言基线版本、项目集合、认证与历史连续性，不把重连当作新进程恢复。
4. [x] A=ABC、B=BCD 的策略选择按 CLI/环境/项目或 Worktree 隔离；同路径不同作用域不串用；空集合可全关；取消不写盘；旧会话保留原快照；无 Hook 仍可管理。
5. [x] 按父任务要求运行类型、Rust、架构及跨层检查，并更新 V1.4.0 代码交付记录。
6. [x] 已记录平台验证状态：Windows tooling checks passed；当前环境无可用 WSL 发行版、macOS 环境和 SSH 端到端环境，因此未宣称这些平台已验收。SSH、无法识别 WSL 身份不会触发本机写入；Grok 项目隔离在受管 Home 等价性门禁完成前保持 global-only。

失败仅恢复本任务有归属证据的输出；保留外部文件和活跃会话引用。

## Review audit — 2026-09-11

- GitNexus 已对既有入口执行 upstream impact：`migrations` 为 HIGH，`resolvePtyLaunch` 为 HIGH，`TerminalSession` 为 CRITICAL；新增扩展符号因索引未覆盖而返回 UNKNOWN，故结合领域契约、符号定位和定向测试复核，未把 UNKNOWN 当作零影响。
- 本轮补齐项目/Worktree 策略迁移、继承/自定义解析、当前全局 MCP/Skill 状态预览、环境过滤、Claude/Codex 启动快照、策略 revision、恢复/重连/关闭生命周期和受管快照回收。
- 审计修复包括：Claude Skill 快照保留原 Home `settings.json` 的非扩展设置；Skill 状态仅使用当前环境且要求受管、未外部修改、active；快照记录可选 Home 并在创建失败路径清理；Worktree 自定义草稿从有效集合初始化；旧会话与 daemon 重连不重新注入；SSH/未知 WSL 身份不写本机；Grok 项目级策略明确 global-only；启动失败提示使用本地化文案。
- 检查结果：`cargo check --manifest-path src-tauri/Cargo.toml --lib`、扩展单测（38 passed）、迁移测试、`npx tsc --noEmit`、`npm run check:architecture -- --strict`、`npm run build` 和 `git diff --check` 通过。`npm run report:architecture` 未发现超 2000 行文件。
- 未完成的真实环境门禁：当前机器无可用 WSL 发行版、macOS 和 SSH 远端，无法完成对应 CLI 版本、真实项目并行、恢复和 Worktree 端到端验证；这些缺口保留为发布前条件，不以静态检查替代。
