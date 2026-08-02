# 分步实施计划

## 实施原则

- 本任务当前先完成调研与方案；业务代码进入实施时按以下阶段逐步交付，每阶段均可独立回滚。
- 修改任何函数/类/方法前，先对具体符号运行 GitNexus upstream impact；HIGH/CRITICAL 先告知用户。IPC 字符串调用另维护人工触点清单。
- Key 按已确认方案在 SQLite 明文存储；前端读 DTO、日志、诊断、普通导出仍不得返回完整 Key。
- 所有用户可见文案同步 `zh-CN` / `en-US`。
- 每阶段先写失败测试，再实现；不得在设置页和终端链各写一套配置合并。

## Phase 0：契约冻结与测试基座

目标：先固定数据、状态机和 adapter 契约，不改变现有 CCS 行为。

- [x] 在 `.trellis/spec/backend/` 新增原生 provider contract，记录明文 SQLite 决策、override v2、选择优先级、原子 apply 和导入边界。
- [x] 在 `.trellis/spec/frontend/` 新增 provider UI/data-flow contract。
- [x] 定义 `CliType`、Provider/Key DTO、错误码、状态机和 redaction helper。
- [x] 为 JSON/TOML merge、数组/null、受限字段、脱敏建立纯函数单测。
- [ ] 为 Claude/Codex/Grok adapter 建立 fixture 目录，包含不存在、合法、未知字段、语法损坏、只读、外部修改样例。
- [ ] 复核 Grok Build pinned version 的 `GROK_HOME` 和 config schema。

完成标准：契约与 fixture 评审通过；无业务入口变化。

## Phase 1：原生数据库与供应商/Key CRUD

目标：CLI-Manager 可独立保存三类型供应商和手动多 Key，不读取 CCS。

主要文件：

- `src-tauri/src/lib.rs`：新增 migration（实施时重查版本，当前预计 v25）。
- `src-tauri/src/provider/{migration,model,repository,service,config_engine}.rs`
- `src-tauri/src/commands/provider.rs`、`commands/mod.rs`、Tauri handler 注册。
- `src/lib/providerTypes.ts`、`src/stores/providerStore.ts`
- `src/components/settings/pages/NativeProviderSettingsPage.tsx`

步骤：

- [x] 建 `managed_providers`、`managed_provider_keys`、common/global/import/issues/journal 表与约束。
- [x] Key 明文写入 `secret_text`；列表/get DTO 只返回 `hasSecret/secretHint/fingerprint`。
- [x] 实现 provider CRUD、draft/ready/disabled 状态机、引用阻止删除。
- [x] 实现 key create/update/activate/delete；活动 Key 删除必须同命令指定 replacement。
- [x] 实现 common/provider 配置 validate/merge/effective preview。
- [x] 把当前 CCS 只读页面替换为原生 master-detail CRUD；Phase 5 再接入“从 CCS 导入”。
- [x] 添加一次性“Key 明文保存在本地数据库”风险说明。

完成标准：无 CCS 安装时可完成三类型 provider + 多 Key CRUD；数据库约束和并发激活测试通过。

## Phase 2：配置 adapter 与全局供应商切换

目标：每类型可选择一个全局 provider，并像 CCS 一样安全更新用户 Home 下的真实 CLI live 配置；应用外新启动的 CLI 同样生效。

主要文件：

- `src-tauri/src/provider/adapters/{claude,codex,grok}.rs`
- `src-tauri/src/provider/{apply,resolver}.rs`
- `src-tauri/src/provider/home.rs`
- `src-tauri/src/app_paths.rs`
- provider 设置页全局状态与 effective/live diff。

步骤：

- [ ] Claude adapter：owner-aware JSON merge，保留 hooks/permissions/statusline/未知字段。
- [ ] Codex adapter：`toml_edit` managed provider/profile，保留 MCP/features/notifications；按兼容版本选 live auth 载体。
- [ ] Grok adapter：managed model/provider table，验证 `GROK_HOME`/schema 版本。
- [ ] 全局 adapter 必须解析并写入真实 Home 目标：`~/.claude/settings.json`、`~/.codex/config.toml` 与必要认证文件、`~/.grok/config.toml`；不得把 `~/.cli-manager/providers/generated/*` 当全局目标。
- [ ] 实现 `CliHomeResolver`：本地/WSL 自动检测、手动 override、绝对路径规范化、CLI 子目录误选提示，以及 live/Hook/history 派生路径预览。
- [ ] Home override 按环境目标存 Tauri 本机设置，不进入 WebDAV；environment doctor、global materializer、Hook/Statusline 与 history 强制复用同一 resolver。
- [ ] Home 变化只标记 provider `needs_reapply`、重检 Hook 并刷新自动跟随的历史索引；不自动写 provider 配置、不安装/迁移 Hook、不移动历史文件。显式重新应用后更新 applied Home/hash。
- [ ] 增加应用外 CLI smoke fixture/手工验收：关闭 CLI-Manager 或从独立 shell 启动 CLI，仍解析到新全局 provider。
- [ ] 实现 per-type lock、stage、parse validate、backup、replace、DB commit、rollback、journal recovery。
- [ ] 实现外部修改 hash 冲突预览。
- [ ] 实现 `provider_global_get/activate` 和“停止管理全局供应商”。
- [ ] 活动 Key 切换：仅当其 provider 为 global current 时同步更新 live；失败回滚 DB 活动状态。
- [ ] 已运行进程不热切换；UI 明确“新启动进程生效”。

完成标准：三类型 Home 配置全局切换、回滚和启动恢复测试通过；未知用户配置保持不变；独立 shell 新进程生效。

## Phase 3：项目/Worktree 原生切换与终端链改造

目标：现有项目级供应商切换不再读取 CCS，并覆盖 Claude/Codex/Grok。

主要文件：

- `src/lib/providerSwitching.ts`、`projectStartupCommand.ts`、`terminalProject.ts`
- `src/components/ProviderSwitchModal.tsx`
- `src/stores/{projectStore,worktreeStore,terminalStore}.ts`
- `src-tauri/src/commands/{terminal,cc_connect}.rs`、`cc_connect/handoff.rs`
- `src-tauri/src/provider/resolver.rs` 与 adapters。

步骤：

- [ ] 将 override 升级为 `schemaVersion=2/providerSource=native`，只保存 provider ID。
- [ ] resolver 实现 Worktree > Project > Global，并返回选择来源。
- [ ] Claude 生成 isolated `--settings`；Codex 生成 named `--profile`；Grok 生成 isolated home + 单进程 `GROK_HOME`。
- [ ] Key 从 SQLite 读出后只注入目标配置/进程；不拼入可见命令字符串。
- [ ] `ProviderSwitchModal` 改读 native catalog，支持三类型与“恢复跟随全局”。
- [ ] `refreshProviderBadges` 改读 native resolver，显示 Global/Project/Worktree 来源。
- [ ] 终端新建、历史恢复、分屏、Workspan、CC Connect/handoff 统一调用 `provider_scope_prepare`。
- [ ] SSH 显式返回 unsupported 并清空本地 provider launch material，不下发 Key。
- [ ] 自定义启动命令只显示参数/环境提示，不静默编辑字符串。

完成标准：删除/改名 CCS 数据库不影响 native 项目启动；三类型新终端使用正确 scope provider；已运行终端不变化。

## Phase 4：通用配置编辑器与本地环境检查

目标：完成用户要求的配置编辑和可诊断性。

- [ ] 每类型提供通用配置编辑器、供应商配置编辑器、有效配置和 live diff。
- [ ] 保存前后端双层语法反馈；最终权威校验在 Rust。
- [ ] 未保存切换确认、格式化、复制脱敏配置、受限字段定位。
- [ ] 环境检查 executable/path/version/config permission/parse/live hash/Key presence/env conflict/hook/shell/WSL。
- [ ] 环境检查顶部实现“检测目标、本地/WSL、自动 Home、选择目录、手动绝对路径、恢复自动检测”，实时展示三类派生配置路径。
- [ ] 复用现有 `hook_settings_select_dir` 的目录选择和 WSL UNC 手动粘贴交互模式，但使用独立 CLI Home setting；Hook 与历史在没有显式 override 时默认跟随它。
- [ ] Hook/Statusline 接入 `CliHomeResolver`：状态、安装、卸载、配置保护和编辑器解析到同一 config root；Home 改变只重检，不自动迁移安装。
- [ ] History 接入 `CliHomeResolver`：Claude projects、Codex sessions/index/state/subagent transcript、Grok sessions 统一派生并刷新 source instance/index/cache。
- [ ] 拆除 `getHistoryPathArgsSync()` / `historySourceSettingsStore` 对 Hook config dir 的隐式双向同步；Hook override 与 history source override 各自独立，优先级均高于 shared Home。
- [ ] 显式 override 与当前 Home 不一致时显示差异和“跟随当前 Home”，不得静默覆盖；旧 Home 的 Hook/历史文件不删除。
- [ ] Home 误选为 `.claude/.codex/.grok`、相对路径、文件、不可访问、只读、WSL 发行版不匹配均有专门结果；选择/重置不自动写 live 文件。
- [ ] 结果分 OK/Warning/Error，支持刷新、复制脱敏报告、打开目录/官方安装文档、重试恢复。
- [ ] 不实现自动安装、自动删环境变量、自动改代理。
- [ ] 处理中英文、键盘焦点、ARIA、错误聚焦和 `prefers-reduced-motion`。

完成标准：场景矩阵中的配置损坏、只读、外部修改、CLI 未安装、自动/手动 Home、功能级 override、WSL 路径均有明确且不泄密的结果；检查、全局写入、Hook 和自动跟随历史解析到同一个 Home。

## Phase 5：CCS 导入、旧 override 迁移与 cutover

目标：让 CCS 成为可选导入源，完成存量数据迁移并切断运行时依赖。

主要文件：

- `src-tauri/src/provider/import_ccswitch.rs`
- 收缩 `src-tauri/src/commands/ccswitch.rs`、`ccswitch_db.rs`
- `CcSwitchImportWizard.tsx`
- migration issues UI。

步骤：

- [ ] 复用 CCS readonly/WSL snapshot reader，新增 preview plan（不向前端返回 Key）。
- [ ] 支持 upstream 单 Key 和识别到的 multi-key schema；忽略轮询/配额/健康字段。
- [ ] 使用 `(sourceRef, cliType, externalId)` import ref，实现重复导入幂等。
- [ ] 支持新增/更新/跳过/人工合并冲突决策；名称不作为自动身份。
- [ ] Key 在 commit 阶段直接写 native key 表 `secret_text`。
- [ ] 迁移 CCS current provider 为每类型 native global state。
- [ ] 迁移 projects/worktrees override v2；无法映射写 migration issue 并标红。
- [ ] cutover 后删除 `ProviderSwitchModal`、terminal、projectStore、CC Connect、Hook/Statusline 的 CCS runtime 调用。
- [ ] CCS DB 路径设置改名为“导入来源”，不再显示“连接状态”。

完成标准：CCS 不存在/损坏时 native 功能仍完整；重复导入不重复创建；旧 override 无静默回退。

## Phase 6：同步、清理与发布闸机

- [ ] 定义 provider 同步 payload，默认排除 `secret_text`；恢复后显示需要重录 Key。
- [ ] 明确全量 SQLite 备份/WAL 含明文风险，不把其描述为安全导出。
- [ ] 清理已废弃 `ccswitch_*` handler、类型、文案、generated profile 兼容代码；保留 import adapter 所需最小读取层。
- [ ] 更新 `.trellis/spec/backend/ccswitch-integration-contracts.md` 为 import-only 契约或拆分新 contract。
- [x] 更新 CHANGELOG（目标 `[TEMP]`，发布时替换真实版本）。
- [x] 运行 `npx tsc --noEmit`、Rust targeted tests、`cargo check`、`cargo test`；构建/启动仅在用户明确要求时执行。
- [ ] GitNexus `detect_changes(scope=compare, base_ref=master)`，核对只影响预期 symbols/flows。
- [ ] 手动切换中英文、三种 shell、WSL、主项目/Worktree、分屏/Workspan、托盘恢复。

完成标准：验收计划 P0/P1 全部通过，无 CCS runtime call，无完整 Key 出现在前端/日志/普通导出。

## 依赖顺序

```text
Phase 0
  -> Phase 1 CRUD/config engine
      -> Phase 2 global apply
      -> Phase 3 scope resolver + terminal
          -> Phase 4 editors/doctor
          -> Phase 5 import/cutover
              -> Phase 6 sync/cleanup/release
```

Phase 2 和 Phase 3 共用 adapter/config engine，禁止并行复制实现；Phase 5 必须在 native CRUD 和 override v2 稳定后执行。
