# 原生供应商管理设计

## 1. 设计目标

让 CLI-Manager 成为 Claude Code、Codex、Grok Build 供应商与 Key 的唯一运行时权威来源，同时支持：

- 每类型一个全局供应商；
- Worktree > 项目 > 全局的本地启动解析；
- 每供应商多个 Key、用户手动启用一个；
- 类型通用配置 + 供应商覆盖 + 最终配置预览；
- CCS 一次或重复导入，但运行时彻底解耦；
- 环境诊断、原子写入、失败回滚和秘密最小暴露。

不实现 Key 轮询、自动切换、配额、有效性检查、自动安装或 SSH 远端下发。

## 2. 总体架构

```text
React UI
  ├─ Provider Management
  ├─ Project/Worktree Switch Modal
  ├─ Common / Provider / Effective Config Editor
  ├─ Environment Doctor
  └─ CCS Import Wizard
          │ typed Tauri IPC; no plaintext secret read DTO
          ▼
Rust Provider Commands
  ├─ ProviderService            CRUD/state machine
  ├─ ProviderResolver           Worktree > Project > Global
  ├─ ProviderConfigEngine       parse/merge/redact/render/diff
  ├─ ProviderMaterializer       Claude/Codex/Grok adapters
  ├─ ProviderKeyRepository      plaintext SQLite Key persistence
  ├─ ProviderApplyCoordinator   lock/stage/journal/replace/rollback
  ├─ ProviderEnvironmentDoctor  read-only diagnostics
  ├─ CliHomeResolver            auto/manual CLI Home SSOT
  └─ CcSwitchImportAdapter      import-only legacy reader
          │
          ├─ cli-manager.db: metadata, config, plaintext Key
          ├─ User Home CLI live files: global switch authority on disk
          └─ ~/.cli-manager generated files: project/Worktree isolation only
```

### 2.1 模块路径建议

后端新增：

```text
src-tauri/src/provider/
  mod.rs
  model.rs
  repository.rs
  service.rs
  resolver.rs
  keys.rs
  config_engine.rs
  apply.rs
  environment.rs
  home.rs
  import_ccswitch.rs
  adapters/
    mod.rs
    claude.rs
    codex.rs
    grok.rs
src-tauri/src/commands/provider.rs
```

前端新增/重构：

```text
src/components/provider-management/
  ProviderTypeTabs.tsx
  ProviderList.tsx
  ProviderEditor.tsx
  ProviderKeyList.tsx
  ConfigEditor.tsx
  EffectiveConfigPreview.tsx
  EnvironmentDoctor.tsx
  CcSwitchImportWizard.tsx
src/stores/providerStore.ts
src/lib/providerTypes.ts
src/lib/providerSwitching.ts        # 升级 v2 override
```

`src-tauri/src/commands/ccswitch.rs` 最终只保留导入适配所需的读取/WSL 快照能力；正常页面、终端、CC Connect、Hook 和 Statusline 不再调用 `ccswitch_*`。

## 3. 数据模型

实施时先重查最新 migration；当前最高版本为 v24，以下预计作为 v25。

### 3.1 `managed_providers`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 稳定 UUID/ULID |
| `cli_type` | TEXT | `claude` / `codex` / `grok`，CHECK 约束 |
| `name` | TEXT | 类型内显示名，大小写归一后唯一 |
| `status` | TEXT | `draft` / `ready` / `disabled` |
| `config_format` | TEXT | Claude=`json`，Codex/Grok=`toml` |
| `config_text` | TEXT | 非敏感供应商覆盖配置 |
| `inherit_common` | INTEGER | 是否继承该类型通用配置 |
| `sort_order` | INTEGER | 排序 |
| `created_at` / `updated_at` | INTEGER | 毫秒时间戳 |

`draft` 允许没有 Key；`ready` 至少一个 Key且恰有一个活动 Key；`disabled` 不可被全局/项目选中。

### 3.2 `managed_provider_keys`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 稳定 Key ID |
| `provider_id` | TEXT FK | 删除供应商时级联 |
| `label` | TEXT | 用户命名，如 Production / Backup |
| `secret_text` | TEXT | 按产品决定明文存储 Key |
| `secret_hint` | TEXT | 仅首尾脱敏，例如 `sk-…a91f` |
| `secret_fingerprint` | TEXT | HMAC/哈希摘要，用于重复提示，不可逆 |
| `is_active` | INTEGER | 手动启用状态 |
| `sort_order` | INTEGER | 排序 |
| `created_at` / `updated_at` | INTEGER | 毫秒时间戳 |

部分唯一索引保证“每供应商至多一个活动 Key”：

```sql
CREATE UNIQUE INDEX ... ON managed_provider_keys(provider_id) WHERE is_active = 1;
```

“ready 供应商至少一个活动 Key”由后端状态机保证。没有健康度、失败次数、冷却、配额或最近验证字段。

### 3.3 通用、全局与导入表

- `managed_provider_common_configs(cli_type PK, config_format, config_text, revision, updated_at)`
- `managed_provider_global_state(cli_type PK, provider_id NULL FK, applied_revision, live_hash, updated_at)`
  - `provider_id = NULL` 表示“不由 CLI-Manager 管理全局供应商/保留现有配置”。
- `provider_import_refs(source, source_ref, cli_type, external_id, native_provider_id, source_fingerprint, imported_at)`
  - 唯一键 `(source, source_ref, cli_type, external_id)`，保证重复导入幂等。
- `provider_migration_issues(id, scope_type, scope_id, cli_type, legacy_payload, reason, resolved_at)`
  - 保存无法映射的旧 override；`legacy_payload` 写入前移除秘密。
- `provider_apply_journal(id, cli_type, operation, state, target_paths_json, backup_paths_json, desired_hash, started_at, finished_at, error_code)`
  - 不记录 Key、环境变量值或完整配置文本。

### 3.4 项目/Worktree override v2

持久化值只保留意图，不保存派生路径：

```json
{
  "schemaVersion": 2,
  "providerSource": "native",
  "claude": { "providerId": "native-id" },
  "codex": { "providerId": "native-id" },
  "grok": { "providerId": "native-id" }
}
```

旧 `settingsPath/profileName` 是派生缓存，不迁入 v2。生成路径由 `scopeType + scopeId + provider revision` 决定，避免过期路径成为权威数据。

## 4. 秘密边界

### 4.1 允许出现明文的位置

- Rust command 的写入参数与内存；
- CLI-Manager SQLite 的 `managed_provider_keys.secret_text`、SQLite WAL 与全量数据库副本；
- CLI 为实现“系统全局切换”而强制要求的 live 配置/认证文件。它们是可再生的运行时副本，使用最小文件权限，不进入 CLI-Manager 备份或同步；
- 本地子进程环境（项目/Worktree 隔离优先使用此方式）。

### 4.2 禁止出现明文的位置

- SQLite 中除 `managed_provider_keys.secret_text` 外的 config/import/journal 字段；
- WebView 返回值、Zustand、toast、剪贴板默认动作；
- 日志、错误详情、诊断报告、统计和 crash context；
- WebDAV、普通导出、配置差异预览、备份文件名或 journal；
- shell command 字符串、进程标题、PTY 回显。

API 只返回 `hasSecret`、`secretHint`、`fingerprint`。编辑 Key 使用 write-only `secret`；保持不变使用显式 `secretAction: "keep"`，清除/替换分别用独立动作，避免脱敏值被当成新 Key 保存。

### 4.3 明文存储风险控制

- SQLite 文件权限沿用 CLI-Manager 用户数据目录权限；不得额外生成 provider Key 明文 JSON/TOML 备份。
- 应用内普通导出、WebDAV payload、诊断包默认排除 `secret_text`；如果未来需要含 Key 导出，必须独立确认格式与风险。
- DB repair、整库复制、WAL 和系统级备份天然可能包含明文，本任务在设置页给出一次性风险说明，不宣称“加密存储”。
- API 仍只提供 write-only 新增/替换 Key；不提供“显示完整 Key”命令，降低 WebView 或插件读取面。

## 5. 选择与生效语义

### 5.1 解析优先级

```text
有效供应商 = Worktree override
          ?? Project override
          ?? cli_type global provider
          ?? Unmanaged/System Default
```

override 只选供应商；该供应商当前活动 Key 对所有引用它的 scope 生效。切换活动 Key 后：

- 若该供应商是全局当前供应商，成功重写全局 live 配置后提交活动状态；
- 项目/Worktree 在下一次启动时读取新活动 Key并生成隔离配置；
- 已运行进程保持启动时快照，不重启、不热替换。

### 5.2 全局与项目互不覆盖

- 全局切换和 CCS 一样落盘到真实 Home 配置：Claude `~/.claude/settings.json`、Codex `~/.codex/config.toml` 及必要认证文件、Grok `~/.grok/config.toml`。不能用 `~/.cli-manager/providers/generated/*` 代替这些全局文件。
- 写入成功后，CLI-Manager 外部新开的 CLI 也使用该 provider；应用退出不撤销。DB global state 是协调/恢复状态，不替代 Home 文件。
- 改全局供应商不改项目/Worktree override；没有 override 的 scope 自然跟随。
- 改项目/Worktree override 不改全局状态或 live 全局选择。
- 项目/Worktree override 只能写 CLI-Manager 隔离配置或进程环境，绝不为了项目选择去改用户 Home 全局配置。

### 5.3 Home 解析与手动选择

环境检查、全局 materializer、Hook/Statusline 和会话历史必须调用同一个 `CliHomeResolver`，禁止各 adapter 或功能自行调用 `home_dir()`：

```text
EnvironmentTarget(local | wsl:<distro>)
  + HomeMode(auto | manual)
  + manualHomePath?
  -> ResolvedHome
  -> Claude config root: <home>/.claude
     live: settings.json; history: projects/
  -> Codex config root:  <home>/.codex
     live: config.toml (+ auth carrier); history: sessions/ (+ root indexes/state)
  -> Grok config root:   <home>/.grok
     live: config.toml; history: sessions/
```

- 本地 Windows 默认使用系统自动检测 Home；WSL 默认从目标发行版解析 Linux Home。
- 手动模式支持目录选择和手动粘贴绝对路径。WSL 支持 `\\wsl.localhost\<distro>\home\<user>` 等可访问 UNC；内部同时保存规范化 target identity，避免仅凭字符串猜发行版。
- 用户选择的是 Home 根。如果路径末段是 `.claude`、`.codex` 或 `.grok`，阻止保存并建议选择其父目录，避免生成双重子目录。
- 相对路径、文件路径、不可访问目录和无法确认归属的 WSL 路径不进入 active Home；只读目录可保存为检测目标但全局 apply 必须被阻止并说明原因。
- 手动 Home 存在 Tauri 本机设置中，按 `local` / `wsl:<distro>` 分项，不进入 WebDAV provider 同步。
- 修改 Home 立即重跑环境检查、重新解析 Hook/Statusline 状态，并让自动跟随的历史来源切换根目录、失效旧 root cache、刷新新目录索引；不自动 materialize provider，也不自动安装/卸载/迁移 Hook。已有 global provider 时将目标标为 `needs_reapply`，显示旧已应用路径、新目标路径和“重新应用全局供应商”。
- 恢复自动检测同样只改变目标并重检；是否写入自动 Home 仍需显式 re-apply。
- 删除被引用供应商前返回引用清单，要求先批量改为其他供应商或恢复跟随全局。
- 停用被引用供应商同样被阻止。

### 5.4 Hook、Statusline 与会话历史目录

共享 Home 只提供默认解析，不能抹掉用户已经显式配置的功能目录。按消费者分别执行以下优先级：

```text
Hook/Statusline config root:
  explicit tool hook override > CliHomeResolver derived config root

History config root:
  enabled history source activeInstance.configRoot > CliHomeResolver derived config root
```

- Hook/Statusline 派生目录为 Claude `<home>/.claude`、Codex `<home>/.codex`、Grok `<home>/.grok`。状态检查、安装、卸载、保护区合并与 Statusline 编辑必须使用同一 resolved config root。
- 历史派生目录为 Claude `<home>/.claude/projects`、Codex `<home>/.codex/sessions`、Grok `<home>/.grok/sessions`；Codex 的 `history.jsonl`、`session_index.jsonl`、`state_*.sqlite` 和子代理 transcript 查找都从同一 `<home>/.codex` 解析。
- 当前 `getHistoryPathArgsSync()` 会把 `claudeHookConfigDir/codexHookConfigDir` 当历史 fallback，`historySourceSettingsStore` 又会把历史 active instance 回写 Hook 设置，形成隐式双向耦合。实施时拆开：二者都可默认跟随 `CliHomeResolver`，但一个功能的显式 override 不再暗改另一个功能。
- Home 改变后，自动跟随的历史 source instance 以 `(source, environmentTarget, resolvedConfigRoot)` 重新登记并强制刷新；旧 Home 文件不移动、不删除，也不与新目录默认混读。用户要继续读取旧目录时，可将其保留/新增为显式历史来源。
- 已显式设置 Hook 或历史目录时，Home 改变只显示路径差异和“跟随当前 Home”；保留原 override，不隐式覆盖。
- 如果旧 Home 已安装 Hook，新 Home 只显示“目标未安装/旧目录仍安装”。安装到新 Home 或卸载旧 Home 均要求用户显式操作，并使用结构化合并保护第三方配置。
- WSL target 的 Home、Hook 命令路径转换、历史扫描和子代理 transcript 必须携带同一发行版 identity，禁止从 UNC 字符串静默回退到本机 Home。

### 5.5 各 CLI 项目隔离

- Claude：生成 `generated/claude/<scope>.settings.json`，启动参数加 `--settings`。
- Codex：生成受控 named profile，启动参数加 `--profile`；Key 注入子进程环境。
- Grok：生成 `generated/grok/<scope>/config.toml`，启动环境设置 `GROK_HOME=<generated/grok/<scope>>`；Key 注入子进程环境。
- WSL/Bash：后端返回 Windows 路径和 WSL 可见路径；参数和环境按 shell adapter 注入。
- 自定义 startup command：不静默改写用户字符串；界面显示可复制参数/环境提示，只有显式允许的结构化启动链自动应用。
- SSH：解析结果为 unsupported/ignored，不将本地 Key 注入远端。

## 6. 配置继承与编辑

### 6.1 合并顺序

```text
类型通用配置（defaults）
  -> 供应商配置（provider wins）
  -> 活动 Key / provider identity 投影（backend wins）
```

- JSON：对象递归合并；数组整体替换；标量/`null` 覆盖。
- TOML：table 递归、assignment 覆盖、array 整体替换；使用 `toml_edit` 尽量保留注释与顺序。
- `inherit_common=false` 时跳过通用配置。
- 密钥、authorization、token、password 和 adapter 定义的路由关键字段不允许出现在通用配置。
- provider identity、base URL、model、Key 投影等最终受 adapter 校验；不能通过 common config 绕过。

### 6.2 编辑器模式

每类型提供：

1. 通用配置编辑器；
2. 供应商覆盖编辑器；
3. 只读最终有效配置；
4. 与当前 live 配置的结构化 diff；
5. 受限字段提示与格式化。

保存前调用 Rust `provider_validate_config`；前端可做语法高亮，但不得成为唯一校验。切换供应商时有未保存内容必须确认；编辑器搜索和键盘操作可访问。

## 7. 原子应用与恢复

所有 provider、global、active-key 写入按 `cli_type` 串行：

1. 获取 per-type operation lock，读取 DB 和目标文件最新状态。
2. 在同一 DB 事务读取/校验 provider、明文 Key、scope、CLI 类型，解析并在内存生成有效配置。
3. 对 live 文件做内容 hash；若与上次记录不一致且修改触及 managed 段，返回可评审冲突，不静默覆盖。
4. 建立无秘密 journal；把所有输出写入目标同目录临时文件并重新解析验证。
5. 开启 SQLite `BEGIN IMMEDIATE`，写入 desired state但暂不提交。
6. 备份并替换每个目标；跨文件失败恢复已替换文件。
7. 提交 DB；提交失败则恢复 live 文件。
8. 更新 applied revision/hash，删除敏感临时内容，标记 journal complete。
9. 启动时扫描未完成 journal，在允许下一次切换前自动恢复或显示“需要恢复”。

若回滚本身失败，状态为 `recovery_required`，该类型禁止继续切换，UI 提供备份路径和“重试恢复”；错误中不包含配置内容。

成功判定必须以 Home live 文件替换和重新解析成功为前提。只更新 `managed_provider_global_state`、只生成隔离文件或只注入当前 PTY 环境都不算全局切换成功。应用启动时还要比较 DB `applied_revision/live_hash` 与 Home 文件实态，发现漂移时提示外部修改或执行确定性恢复。

## 8. CLI adapter 契约

每个 adapter 实现：

```text
detect_environment()
parse_common(text)
parse_provider(text)
validate(common, provider)
render_effective(common, provider, active_key, scope)
read_live_snapshot()
plan_global_apply()
plan_scoped_launch()
redact_for_preview()
```

### Claude

- 全局：结构化修改真实用户 Home 的 `~/.claude/settings.json` 中 provider-owned `env` 键；Key 是 live 运行所需的派生副本，从应用外启动 Claude 也必须生效。
- 项目：`--settings` 隔离文件；Key 可在文件或子进程环境中按 CLI 实际支持选择更少暴露的方式。
- 保留 hooks、permissions、statusline 和未知字段。

### Codex

- 全局：修改真实用户 Home 的 `~/.codex/config.toml` 中 CLI-Manager-owned provider/profile 块，并同步该 Codex 版本要求的认证载体；从应用外启动 Codex 也必须生效。若必须 materialize token，限制在 live auth/config 文件并标记 derived-secret。
- 项目：named profile + 单进程环境，避免 Key 落盘。
- 保留 MCP、features、notifications 和未知字段。

### Grok Build

- 全局：修改真实用户 Home 的 `~/.grok/config.toml` 受控 model/provider 段；按 `env_key`/inline key 能力 materialize，从应用外启动 Grok 也必须生效。
- 项目：单进程 `GROK_HOME`，仅生成所需配置，Key 通过环境注入。
- 不复制 `auth.json`、sessions、logs、plugins credential。

## 9. 后端命令面

建议命令（DTO 均 camelCase 且不返回秘密）：

```text
provider_list(cliType?)
provider_get(id)
provider_create(input)
provider_update(id, patch)
provider_duplicate(id)
provider_delete(id, replacement?)
provider_set_status(id, status)

provider_key_list(providerId)
provider_key_create(providerId, label, secret)
provider_key_update(keyId, label?, secretAction)
provider_key_activate(providerId, keyId)
provider_key_delete(keyId, replacementKeyId?)

provider_common_get(cliType)
provider_common_update(cliType, configText)
provider_validate_config(cliType, commonText?, providerText?, inheritCommon)
provider_preview_effective(providerId, keyId?)

provider_global_get(cliType)
provider_global_activate(cliType, providerId?)
provider_scope_get(projectId, worktreeId?, cliType)
provider_scope_set(scopeType, scopeId, cliType, providerId?)
provider_scope_prepare(scopeType, scopeId, cliType)

provider_environment_check(cliType?)
cli_home_get(environmentTarget)
cli_home_set(environmentTarget, absoluteHomePath)
cli_home_reset(environmentTarget)
provider_import_ccswitch_preview(path?)
provider_import_ccswitch_commit(planId, decisions)
provider_migration_issues_list()
provider_recovery_status(cliType?)
provider_recovery_retry(cliType)
```

`provider_scope_prepare` 是终端、历史恢复、CC Connect 的唯一入口，不允许各调用方自行拼配置或读 CCS。

## 10. CCS 导入与旧 override 迁移

### 10.1 两阶段导入

1. Preview：只读打开 CCS（含 WSL 快照），识别 providers/common/current/multi-key，抽取但不把秘密返回前端；返回名称、类型、配置 diff、Key 脱敏、冲突和 override 映射摘要。
2. Commit：用户决定新增/更新/跳过后，在后端把 provider、明文 Key、import refs、global state 写入同一 SQLite 事务，并迁移项目/Worktree override。

### 10.2 幂等与冲突

- 身份为 `(source="ccswitch", sourceRef, cliType, externalId)`；名称相同不等于同一项。
- 同 import ref + source fingerprint 相同：跳过。
- 同 import ref 内容变化：显示 update diff，确认后更新原 native provider。
- 仅名称相似：必须选“合并到现有”或“作为新供应商导入”，不自动合并。
- 旧单 Key provider 生成一个“从 CC Switch 导入”的 Key；多 Key 源只导入静态 key 列表与活动 key，忽略健康度/轮询字段。
- OAuth、空 Key、无法解析格式作为 skipped/conflict，不创建空凭据。

### 10.3 override 切断

- 先完成 provider external→native 映射，再一次迁移 `projects` 与 `worktrees` override 到 v2。
- 缺失/歧义映射写 `provider_migration_issues` 并在对应项目显示阻断徽章；不静默回退、不运行时重读 CCS。
- 切换上线后，CCS 设置项迁为“上次导入路径”；正常运行链对没有 CCS 的机器完全可用。

## 11. 本地环境检查

每种 CLI 返回：

- executable：是否找到、绝对路径、版本、是否满足 adapter 最低兼容范围；
- config：根目录/文件是否存在、语法、读写权限、外部修改冲突；
- credentials：活动 Key 明文字段是否存在且非空（只返回 presence/hint）；
- environment：冲突变量的名称、scope、presence、脱敏指纹，不返回 value；
- runtime：当前全局 provider、live 文件是否与 applied hash 一致、是否有未完成 journal；
- shell：PowerShell/CMD/Pwsh/Git Bash/WSL 路径转换与可见性；
- hook：CLI-Manager Hook/Statusline 在 resolved config root 是否安装、是否被 provider merge 保留，以及是否存在未跟随当前 Home 的显式目录。
- history：三类 session root、source instance、索引刷新状态，以及是否存在未跟随当前 Home 的显式目录；不返回会话正文。

环境检查页先展示公共 Home 解析区：检测目标（本地/WSL 发行版）、来源（自动/手动）、Home 路径、选择目录、手动输入、恢复自动检测，以及三类派生配置、Hook 和历史路径。每次 Home 变化后，以同一 resolved Home 刷新三类检查、Hook 状态和自动跟随历史索引。Home 选择操作本身不写任何 CLI 配置或 Hook 文件；显式 override 与 Home 不一致时显示“保留自定义目录 / 跟随当前 Home”。

状态级别为 OK / Warning / Error。MVP 修复动作仅限刷新、复制脱敏诊断、打开目录/官方安装文档、重试 CLI-Manager 自己的恢复；不自动安装或删除环境变量。

## 12. 前端交互

供应商设置使用现有设置页主题 token 和 master-detail 结构：

- 顶部类型切换：Claude Code / Codex / Grok，各显示全局当前供应商和环境状态；
- 全局状态旁显示实际 Home 目标路径和最近写入/漂移状态，避免用户误以为仅影响 CLI-Manager 项目；
- 左侧供应商列表：搜索、当前/停用/草稿徽章、新建/复制/删除；
- 右侧详情：概览、Keys、供应商配置、有效配置四个页签；
- Keys：脱敏列表、一个明确“已启用”，启用另一个需确认影响范围，不提供自动切换设置；
- 通用配置、环境检查和 CCS 导入是类型级动作；
- 全局启用与保存配置分离，避免编辑尚未完成时直接改 live 文件；
- 所有文案、toast、ARIA、空状态同步中英文，焦点顺序与视觉顺序一致。

项目/Worktree 切换弹窗继续存在，但 provider catalog 只来自 native store，并新增 Grok。顶部显示解析来源（Worktree / Project / Global）与“恢复跟随全局”。

### 12.1 原型资产

- 高保真 SVG：`assets/provider-management-prototype.svg`
- PNG 评审图：`assets/provider-management-prototype.png`
- 环境检查/Home 选择 SVG：`assets/environment-home-prototype.svg`
- 环境检查/Home 选择 PNG：`assets/environment-home-prototype.png`
- 可复用 gpt-image-2 提示词：`assets/prototype-prompt.md`

UI/UX 检索建议采用开发者工具暗色、高对比、等宽代码字体、明确 focus 与表单反馈。其“横向滚动旅程”更适合营销页，与现有设置页不匹配，因此原型保留 CLI-Manager 当前 master-detail 设置结构，仅采用色彩、字体和可访问性建议。当前会话没有 `OPENAI_API_KEY`，PNG 由确定性 SVG 渲染；提示词保留供后续有 Key 时直接生成视觉变体。

## 13. 同步与备份

- 普通同步包含 provider/common/global 元数据、非敏感 config、Key ID/label/hint 和 `hasSecret=false` 恢复占位。
- 手动 Home override 属于设备/环境本地设置，不进入 WebDAV 或 provider 导出；新设备重新自动检测或由用户选择。
- 导入到新设备后，若同步 payload 不含 Key，provider 保持 draft/unavailable，要求重新录入后才能激活。
- live CLI 文件不是 CLI-Manager 数据备份来源；恢复应从 DB 的明文 Key 重新 materialize。
- 加密密钥包不在本任务，避免把口令、KDF、跨设备恢复和泄露响应混入 MVP。

## 14. 兼容与发布策略

- 首次升级只建表，不自动切断 CCS；用户进入迁移向导并成功提交后设置 `native_provider_cutover=complete`。
- cutover 前旧功能可只读展示迁移提示；cutover 后所有新切换只走 native。
- 发布至少经过：shadow preview（不写 live）→ 原生 CRUD/项目启动 → 全局 apply → CCS cutover 清理。
- 原业务代码实施前必须逐符号运行 GitNexus impact；IPC 边界另做人工调用清单。完成后运行 `detect_changes`。
