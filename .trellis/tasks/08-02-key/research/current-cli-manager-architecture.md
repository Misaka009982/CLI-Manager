# CLI-Manager 当前供应商链路与改造触点

## 结论

当前“供应商设置页、项目选择、终端准备、CC Connect、Hook/Statusline 保护”同时把 CCS 当作数据源和运行时服务。原生化不能只替换设置页，必须一次性切断终端启动及恢复链中的 CCS 读取，否则会形成双写、ID 歧义和离线失败。

GitNexus 索引已在 2026-08-02 刷新。`ProviderSettingsPage`、`ProviderSwitchModal`、`pty_prepare_create`、`ccswitch_list_providers`、`refreshProviderBadges` 的静态影响均为 LOW；但 Tauri `invoke` IPC 由字符串连接，图谱会低估跨层影响，因此以下人工发现清单是实施边界的一部分。

## 当前数据流

```text
CCS SQLite (~/.cc-switch/cc-switch.db)
  ├─ ProviderSettingsPage: 只读列表/通用配置/原始配置
  ├─ ProviderSwitchModal: 项目与 Worktree 选择 providerId
  ├─ projectStore: CCS badge 探测与 Codex profile 清理
  ├─ terminalStore / pty_prepare_create: 启动前重读 CCS、生成配置
  ├─ cc_connect / handoff: 恢复与远端管理前重读 provider catalog
  └─ hook_settings / statusline: 把 Hook 相关通用配置回写 CCS

projects.provider_overrides / worktrees.provider_overrides
  └─ 保存 CCS providerId + Claude settingsPath / Codex profileName
```

目标数据流：

```text
CLI-Manager SQLite (供应商、非敏感配置、Key 明文)
  ├─ ProviderSettingsPage: 原生 CRUD / Key / 通用配置 / 导入 / 环境检查
  ├─ 全局状态: 每种 CLI 一个 native provider
  ├─ 项目/Worktree override: 只引用 native provider
  ├─ ProviderResolver: Worktree > Project > Global
  └─ ProviderMaterializer: Claude / Codex / Grok 的全局与隔离配置

CCS SQLite
  └─ 仅 CcSwitchImportAdapter 读取；正常运行链不访问
```

其中 global materializer 必须写用户 Home 的真实 CLI live 文件（Claude `~/.claude/settings.json`、Codex `~/.codex/config.toml` 与必要认证载体、Grok `~/.grok/config.toml`）；CLI-Manager generated 目录只承载项目/Worktree 隔离配置。

## 发现清单

| 层 | 文件/符号 | 当前责任 | 原生化动作 |
|---|---|---|---|
| 前端页面 | `src/components/settings/pages/ProviderSettingsPage.tsx` | CCS 只读浏览；前端执行 JSON merge；接收 `rawSettingsConfig` | 改为原生 CRUD 主页面；合并/校验移到 Rust；DTO 不含密钥或原始秘密 |
| 项目切换 | `src/components/ProviderSwitchModal.tsx` | 调用 `ccswitch_*` 列表、测试、prepare/reset | 调用 `provider_*` 原生命令；支持 Claude/Codex/Grok；恢复跟随全局 |
| 覆盖类型 | `src/lib/providerSwitching.ts` | Claude/Codex override 保存 CCS ID 与派生路径 | 升级 version/source；保存 native provider ID；加入 Grok 派生目录 |
| 启动命令 | `src/lib/projectStartupCommand.ts` | 注入 Claude `--settings`、Codex `--profile` | Grok 注入由后端 launch env 设置 `GROK_HOME`；自定义启动命令显示明确提示 |
| 项目/Worktree | `src/stores/projectStore.ts`、`worktreeStore.ts`、`terminalProject.ts` | badge 探测、override 持久化与优先级 | badge 从 native resolver 读取；保留 Worktree > Project 行为 |
| 终端启动 | `src/stores/terminalStore.ts`、`src-tauri/src/commands/terminal.rs` | prepare 后把配置传入 PTY；Codex 还含 handoff | 统一调用 native resolve/materialize；禁止启动时访问 CCS |
| CCS 后端 | `src-tauri/src/commands/ccswitch.rs`、`ccswitch_db.rs` | 浏览、切换、prepare、测试、WSL 读写 | 缩为只读导入适配器；删除/下线运行时命令，保留 WSL 快照读取能力供导入 |
| CC Connect | `src-tauri/src/commands/cc_connect.rs`、`cc_connect/handoff.rs` | 从 CCS catalog 还原 Codex provider | 改为 native resolver；SSH 仍清空 provider override，不下发本地密钥 |
| Hook/Statusline | `src-tauri/src/commands/hook_settings.rs`、`statusline.rs`、`codex_statusline.rs` | CCS common config 保护与回写 | 改为 native common config / CLI-Manager owned-section 合并；不再写 CCS |
| 会话历史根 | `src/lib/historyPathArgs.ts`、`src/stores/historySourceSettingsStore.ts`、`src-tauri/src/commands/history.rs`、`subagent_transcript.rs` | Claude/Codex 可传 config root，Grok 仍直接探测进程 Home；Codex 子代理另有本机/WSL resolver | 三类型统一消费 `CliHomeResolver`；显式 history source override 保留更高优先级 |
| DB migration | `src-tauri/src/lib.rs` | v12 项目 override、v17 Worktree override；当前最高 v24 | 实施时重查最高版本，预计新增 v25 原生表与显式 legacy migration marker |
| 同步 | `src-tauri/src/commands/sync.rs`、`src/stores/syncStore.ts` | 同步项目/Worktree override | 同步 native provider 元数据和非敏感配置；Key 仅同步占位，不同步明文 |
| Key 存储 | 新增 native provider key 表 | 当前无原生 Key 表 | 按产品决定在 SQLite 明文存储；前端/日志/普通导出继续脱敏，不接入 `credential_store.rs` |
| 路径 | `src-tauri/src/app_paths.rs` | `~/.cli-manager`、Claude/Codex 派生目录 | 新增统一 provider generated/backup/journal 路径和 Grok home 路径 |
| 手动目录 UI | `src/components/settings/pages/HookSettingsPage.tsx` 的 `handleSelectCodexDir` / `handleSelectGrokDir` 等 | 已支持目录选择、手动输入、WSL UNC 和本机设置持久化 | 复用交互/选择命令模式，但新建独立 CLI Home override；Hook/history 无显式 override 时默认跟随，不能复用 Hook config dir 字段作为 Home SSOT |
| i18n | `src/lib/i18n.ts` | 中英文文案 | 所有新增按钮、错误、ARIA、状态同步 `zh-CN`/`en-US` |

## 已发现风险

1. `ProviderSettingsPage` 当前接收并复制 `rawSettingsConfig`。即使 `maskedEnv` 脱敏，原始配置仍可能含明文 Key，这是必须在原生 API 边界消除的秘密泄露。
2. 现有 override 的 `providerId` 没有 `providerSource/schemaVersion`，CCS ID 与 native ID 可能歧义，不能靠名称或 UUID 形状猜测。
3. SQLite 和多个 CLI 文件无法形成真正的单一事务，需要操作锁、快照、stage、替换、补偿与启动恢复 journal。Key 与 provider 状态同库后不再有凭据库跨事务问题。
4. Claude/Codex 的 Hook、Statusline、MCP 等配置与供应商配置共用 live 文件。整文件覆盖会破坏 CLI-Manager 自己已管理的功能，必须做 owner-aware 结构化合并。
5. 前端当前直接读写项目数据库，但 provider Key 需要更强边界；原生 provider CRUD 必须统一走 Rust command，避免前端 SQL 绕开凭据补偿和校验。
6. GitNexus 对 IPC 字符串调用低估影响，实施阶段每修改一个符号仍需单独运行 `impact`，完成后运行 `detect_changes`。
7. `getHistoryPathArgsSync()` 当前优先 history active instance、再回退 `claudeHookConfigDir/codexHookConfigDir`；`historySourceSettingsStore` 又会将 active instance 回写 Hook setting。若直接增加 Home 字段而不拆开这条双向同步，会出现换 Home 后路径被旧 override 拉回、Hook 与历史互相误改的问题。
8. `history.rs` 当前 Claude 读取 `<config>/projects`、Codex 读取 `<config>/sessions`，Grok 则直接从进程 Home 读取 `~/.grok/sessions`；`subagent_transcript.rs` 还有独立的 Codex/WSL root resolver。只改历史列表入口会漏掉索引、转换、统计、request log、ccusage 和子代理 transcript。

## 场景边界

- 供应商切换只影响新启动进程；多会话、分屏、Workspan 中已运行的会话保持原快照。
- Worktree override 高于项目 override；两者都为空时才跟随全局。
- WSL/Bash 生成路径需要转换为 WSL 可见路径；Key 应通过目标进程环境传入，不落入 shell command 字符串。
- SSH 项目继续禁用本地 provider override，避免把本地凭据意外发往远端。
- 应用最小化、托盘或失焦不改变切换事务；成功/失败通过持久通知和下次聚焦可见状态呈现。
- 外部同时编辑 live 配置时使用读取指纹冲突检测，不能用旧快照静默覆盖。
