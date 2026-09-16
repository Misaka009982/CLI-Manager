# V1.4.0 CLI 隔离验证与方案决策（2026-09-10）

后续决策更新：用户已允许接管 GROK_HOME，条件为原始 Home 配置全部继承、仅注入 MCP/Skills。因此下文的“尚未批准”属于当时记录，现由父任务 design.md 的 Managed GROK_HOME 契约取代；可行性实验仍未完成，不能把授权当作实验通过。

## 证据等级与环境

本轮是技术调研，不是产品实现验收。Windows 本机：Claude 2.1.263、Codex 0.154.0、Grok 0.2.118 (1e1687c1cf)。macOS/WSL 未实测，不能标记通过。
分支 master 与本地 origin/master 跟踪引用 0/0；未 fetch，不代表远端实时状态。仅规划目录未跟踪。
临时夹具在 C:/Temp/cli-manager-isolation-probe-20260910；使用子进程环境和假 Skill/不可执行 MCP 名称，没有模型请求，没有修改真实 CLI 配置，也没有启动 MCP 服务。
Grok inspect 仍可只读发现真实用户的兼容来源（Windows 系统 Home 不一定遵循 HOME/USERPROFILE），故临时 Home 本身并不保证所有来源隔离；报告只保留夹具结果，不保存用户配置正文。

## 能力矩阵

| CLI | MCP 进程隔离 | Skill 进程隔离 | 本轮证据/缺项 |
| --- | --- | --- | --- |
| Claude | --mcp-config 与 --strict-mcp-config | --settings 的 skillOverrides 普通技能开关 | 已核对本机 help 与官方文档；尚未完成实际会话加载/调用验收；插件需独立策略 |
| Codex | -c mcp_servers.<key>.enabled=false，注入选中服务器 | -c skills.config 的路径级列表为候选适配 | 本机 mcp list --json 的覆盖对照通过；Skill 运行时、插件来源与嵌套发现待验 |
| Grok | 原生项目 MCP 配置存在，但不符合“不改项目文件”的注入约束 | 项目 [skills]、GROK_CONFIG、GROK_CONFIG_PATH 不能提供该控制 | 本机 Skill 对照实验失败；不能宣布三 CLI 项目隔离全部可交付 |

## Grok 可复现实验

在临时 GROK_HOME/config.toml 放入 `[skills] paths = ['<fixture>/packages']`，目录含 isolation-probe-a / isolation-probe-b 两个合法 SKILL.md。
在临时 cwd/.grok/config.toml 放入 `[skills] disabled = ['isolation-probe-b']`。
直接调用已安装的 grok.exe，避免 npm launcher 在实验 Home 解压/安装二进制：`grok --cwd <fixture>/project inspect --json`。

| 对照 | inspect 结果（退出码均 0） |
| --- | --- |
| 仅项目 disabled B | A、B 都存在，B 无 disabled 标志；configSources 确认项目文件已发现 |
| 再加 GROK_CONFIG JSON：skills.disabled=[A,B] | A、B 均未禁用 |
| 再加 GROK_CONFIG_PATH 指向同内容 TOML | A、B 均未禁用 |
| 阳性对照：临时用户 config.toml 设置 disabled=[B] | B 出现 disabled=true，A 仍启用 |
| 阳性对照同时叠加上述环境覆盖 | B 仍禁用，A 仍启用；环境覆盖没有额外效果 |

disabled 不代表从发现结果消失：源码约定仍列出，但不注入 system prompt、不允许 Skill 工具调用。ignore 是路径级隐藏；两者不能与单纯工具权限 deny 混为一谈。本轮实际验证的是 inspect 有效配置，未执行模型调用。

源码核对：xai-org/grok-build commit `37949780c144e37df692e3d669051a21fec24f20`（与本机 build commit 不同，不能当作完全同版本）。
- `crates/codegen/xai-grok-config/src/config_override.rs` 的 OVERLAY_ALLOW_PATHS 仅允许 models/features、部分 toolset 与 shell_environment_policy；没有 skills/mcp_servers/plugins。不是可任意覆盖 TOML 的入口。
- `crates/codegen/xai-grok-config/src/env_overlay.rs`：内联 JSON 优先，文件支持 JSON/TOML，随后进行白名单过滤。
- `crates/codegen/xai-grok-agent/src/prompt/skills.rs`：普通来源、共享目录、插件合并后按名称应用 disabled；只部署选中包不能排除其他来源。
- --agent/--agent-profile 是 Agent 定义入口，本轮没有证据证明能替代完整 Skills/MCP 加载过滤，不作为已验证方案。

源码临时副本已移至 C:/Temp/cli-manager-grok-isolation-source-20260910，不纳入任务交付。

## Codex 对照

临时 CODEX_HOME/config.toml 定义 isolation_probe，command 为不存在的夹具命令，enabled=true。
`codex mcp list --json` 返回 enabled=true；加 `-c mcp_servers.isolation_probe.enabled=false` 后返回 enabled=false，退出码均为 0，无 stderr。只读列举，没有连接服务器。
这证明参数覆盖有效，不等于所有来源、运行中热加载及跨平台隔离验收完成。

## 收敛的实现方向

1. 保留统一 JSON 权威模型、CLI 原生适配器、Skill 自有源与链接/复制、只读导入、全局/项目共用主题组件。
2. 全局默认与项目策略分开；项目只生成进程快照，不切换真实全局配置，不写项目 .grok/.claude/.codex 配置。供应商参数与扩展参数统一合成，不能各自覆盖对方。
3. 适配器必须返回支持/部分支持/不支持及具体来源限制，版本/平台变化重新探测。未选资源必须被明确排除，不能只注入选中资源。
4. Claude 优先原生参数，普通技能与插件分别处理；Codex 优先 -c，技能逐路径禁用，覆盖共享根/嵌套根/插件。保留原有 Home、认证、历史、Hook。
5. Grok 全局管理可实现。当前约束下 Grok 项目级精确加载集合尚无验证通过的通道：建议 UI 禁用对应自定义入口并说明原因，但这属于范围调整，须用户确认后才能修改验收范围。
6. 若必须在 V1.4.0 交付 Grok 项目隔离，另开受管 GROK_HOME 原型：不能只改环境变量，必须验证认证续期、会话索引/resume、Hook、供应商配置、leader/socket、兼容来源与插件扫描，并分别验证 Windows/macOS/WSL。禁止把整个原 Home 软链接过去导致重新共享配置；不默认复制认证秘密。该路线有显著兼容成本，尚未批准、尚未证明可行。
7. 不采用共享配置切换后回滚、只用 deny 假装未加载、修改仓库配置或把软链接部署当隔离。

## 交付前仍需通过

Claude 普通/插件 Skill 及 strict MCP 的实际加载与调用；Codex Skill 路径过滤实际会话；ABC/BCD 并发、空集合、嵌套动态发现、同名技能、外部配置变化、恢复/重连、企业限制、供应商和 Hook 保留。Windows/macOS/WSL 分别验收；任何缺项明确标记。
当前不能将 R6/R7 完整范围标记已确认可实施。此文收敛已证实机制与待决边界，不声称完成全部 CLI 隔离验证。

## 官方依据

- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/skills （skillOverrides 不覆盖插件技能）
- https://learn.chatgpt.com/docs/build-skills （skills.config 按 SKILL.md 路径禁用）
- https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- https://docs.x.ai/build/settings （项目层仅 MCP/plugins/permission）
- https://docs.x.ai/build/settings/reference （GROK_HOME 同时承载认证、会话等）
- https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-config/src/config_override.rs
