# Evidence — 2026-09-10

## Isolation validation update

第二轮认证路径、历史 Junction、同名/新增 Skill 测试见 [managed-home-verification-round2.md](managed-home-verification-round2.md)。新增事实：本机 GROK_AUTH_PATH 可读写假凭据；固定禁用名单不是动态白名单；目录 ignore 不覆盖之后合并的插件技能。

受管 Home 第二轮结果见 [managed-home-verification.md](managed-home-verification.md)，包含可复现临时脚本、配置层集合通过、项目覆盖失败及 disabled_mcp_servers 修正、本地 MCP 握手、Windows 链接权限失败和未验项目。

2026-09-10 本机版本、Grok 阳性/阴性对照、Codex MCP 参数对照、上游源码白名单及方案边界见 [isolation-verification.md](isolation-verification.md)。Grok 项目控制存在已证实限制，不再作为未经验证的普通配置转换问题处理。

## External

- https://github.com/dark-hxx/CLI-Manager/issues/204
- https://github.com/dark-hxx/CLI-Manager/issues/243
- cc-switch commit 2d54e261c8a2f9e5b791e566c83048796bb2364b，MIT。
- https://github.com/farion1231/cc-switch/blob/2d54e261c8a2f9e5b791e566c83048796bb2364b/src-tauri/src/services/profile.rs ：Profile调用全局MCP/Skill toggle，不能据此保证同CLI项目并行。
- 同commit services/mcp.rs、services/skill.rs、mcp/{claude,codex,grokbuild}.rs、database/dao/{mcp,skills}.rs：统一定义、字段转换、源目录/部署、导入备份参考。
- https://code.claude.com/docs/en/mcp ：strict MCP。
- https://code.claude.com/docs/en/skills ：skillOverrides；插件不受普通skillOverrides控制。
- https://learn.chatgpt.com/docs/extend/mcp?surface=cli ：Codex enabled、http_headers及插件来源。
- https://learn.chatgpt.com/docs/build-skills ：[[skills.config]]、.agents/skills、链接发现。
- https://learn.chatgpt.com/docs/config-file/config-basic ：CLI覆盖高于项目/profile/user，项目需要信任。
- https://docs.x.ai/build/settings ：Grok项目仅MCP/plugins/permission。
- https://docs.x.ai/build/features/skills-plugins-marketplaces
以上为调研时文档，需用安装版本实测。参考副本 C:/Temp/cc-switch-research 不作为交付依赖。

## Repository touchpoints

- src-tauri/agent-capabilities-core/src/lib.rs:322 discovery_layout；:591 collect_local_bundle；:843/:900 skills.disabled，与Codex原生skills.config需校准。
- .trellis/spec/backend/agent-capability-diagnostics-contracts.md：诊断与管理分离；精确会话绑定，不持久化诊断快照。
- src/features/terminal/lib/terminalLaunch.ts:241 起供应商快照准备与合成：新策略接入启动/恢复。
- src-tauri/src/features/providers/service/scope.rs：参考作用域与快照，不混存扩展。
- src/features/projects/api/projectStore.ts、worktreeStore.ts、projectStartupCommand.ts：策略生命周期与参数。
- src/features/settings/components/SettingsLayout.tsx、SettingsNav.tsx 与 src/styles/components.css：全局样式和布局入口已检查。
- src-tauri/src/app/migrations.rs：SQLx迁移组合。
- .trellis/spec/backend/ccswitch-integration-contracts.md：只读外部SQLite与WSL快照。
- .trellis/spec/backend/app-data-persistence-contracts.md：数据根目录。
- src/features/sync/api/syncStore.ts：跨机器策略范围待确认。
- Hook/PTY字节通道：管理不依赖Hook，导入不要求修改PTY传输。

GitNexus query返回FTS indexes missing，无有效调用链；本次依据契约和源码定位。未进行符号编辑或实现验证。
