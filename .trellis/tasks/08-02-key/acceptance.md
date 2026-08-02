# 验收计划

## 1. 验收范围与分级

- P0：数据正确、切换正确、失败可恢复、无 CCS 运行时依赖。
- P1：配置继承、环境检查、导入迁移、跨 shell/Worktree/多会话完整。
- P2：可用性、无障碍、视觉和大数据量体验。

本计划接受 Key 在 SQLite/WAL/整库副本中明文存在；仍要求完整 Key 不进入列表/详情 DTO、日志、诊断和普通导出。

## Phase 1 已验证范围

- Rust provider 单元测试：schema、JSON/TOML 合并、敏感字段拒绝、draft/ready 状态、手动激活、替代 Key 删除、引用阻止和复制不复制明文 Key 均通过。
- 前端 `npx tsc --noEmit`、Rust `cargo check`、`cargo fmt --check` 和全量 `cargo test` 已通过；全量结果为 797 passed、1 ignored。
- 本阶段尚未宣称全局 Home 写入、项目/Worktree 原生切换、环境检测或 CCS 导入验收通过；这些仍属于 Phase 2–5。

## 2. P0 功能验收

### 2.1 原生供应商 CRUD

- [ ] CCS 未安装且路径为空时，Claude Code、Codex、Grok 均可新增、编辑、复制、排序、停用和删除供应商。
- [ ] draft provider 可以无 Key，但不能设为全局或项目/Worktree provider。
- [ ] ready provider 至少一个 Key且恰有一个活动 Key；DB 部分唯一索引阻止并发产生两个活动 Key。
- [ ] 被 global/project/worktree 引用的 provider 删除/停用被阻止并显示引用范围。
- [ ] 同类型名称冲突按规范提示，不用名称覆盖既有 provider。

### 2.2 手动多 Key

- [ ] 单个 provider 可保存 0/1/N 个 Key，SQLite `secret_text` 与输入一致且为明文。
- [ ] 前端列表和详情只显示脱敏值，不存在读取完整 Key 的 IPC。
- [ ] 用户手动启用 Key B 后，A 失去活动状态；无任何轮询、自动重试、健康检查或后台切换。
- [ ] 删除活动 Key 未指定 replacement 时失败；指定 replacement 时在一个业务操作内完成。
- [ ] 若全局 live 写入失败，活动 Key 状态回滚；项目下次启动仍使用上次成功状态。
- [ ] 已运行终端不会因 Key 改变而重启或热替换。

### 2.3 全局供应商

- [ ] 每类型分别维护 global provider，互不影响。
- [ ] Claude global activate 实际更新用户 Home 的 `~/.claude/settings.json`；Codex 实际更新 `~/.codex/config.toml` 和该版本必要认证载体；Grok 实际更新 `~/.grok/config.toml`。
- [ ] 全局切换不以 `~/.cli-manager/providers/generated/*`、数据库状态或当前 PTY 环境代替 Home 文件写入。
- [ ] Claude/Codex/Grok global activate 后，从 CLI-Manager 外部独立 shell 新启动的目标 CLI 使用对应 provider/Key；CLI-Manager 退出后仍生效。
- [ ] Home 文件写入/重新解析失败时，DB global state 不提交成功；界面不得显示已切换。
- [ ] “停止管理全局供应商”不会删除用户非 managed 配置。
- [ ] global switch 不修改任何 project/worktree override。
- [ ] project/worktree override 不修改用户 Home 的全局配置，只生成 scope 隔离配置/环境。
- [ ] 语法损坏、只读、外部修改冲突、磁盘失败时不提交错误 global state。
- [ ] 中途崩溃后启动 journal 能恢复或进入明确 `recovery_required`，禁止继续覆盖。

### 2.4 项目/Worktree 原生切换

- [ ] 解析优先级严格为 Worktree > Project > Global > Unmanaged。
- [ ] 项目“恢复跟随全局”只清除该类型 override，不修改 global provider。
- [ ] Worktree 清除 override 后回到 Project，而不是直接跳到 Global。
- [ ] Claude 新终端包含正确 `--settings`；Codex 包含正确 named profile；Grok 进程拥有隔离 `GROK_HOME`。
- [ ] override v2 只保存 native provider ID，不保存 CCS ID、`settingsPath`、`profileName` 派生权威字段。
- [ ] 终端新建、分屏、历史恢复、Workspan、CC Connect/handoff 使用相同 resolver 结果。
- [ ] SSH 不注入本地 provider/Key，并显示本任务不支持远端供应商。
- [ ] 移走或删除 CCS 数据库后，上述所有 native 项目启动仍成功。

## 3. P1 配置验收

### 3.1 合并规则

- [ ] JSON 对象递归合并，provider 覆盖 common，数组整体替换，`null` 显式覆盖。
- [ ] TOML table 递归合并，assignment/array provider 覆盖，尽量保留注释与顺序。
- [ ] `inherit_common=false` 完全跳过 common。
- [ ] Key/token/password/authorization 字段不能通过 common config 注入。
- [ ] 最终 provider identity 与活动 Key 投影不可被 common 绕过。
- [ ] “供应商 / 通用 / 有效 / live diff”四视图结果一致且完整 Key 被脱敏。

### 3.2 Live 文件保留

- [ ] Claude provider 切换保留 hooks、permissions、statusline 和未知字段。
- [ ] Codex 保留 MCP、features、notifications、注释和未知 table。
- [ ] Grok 保留非 managed 段；项目 isolated home 不复制 auth/session/log/plugin credential。
- [ ] 所有输出先 stage 后 validate；任一目标失败时已替换文件恢复。
- [ ] 同一类型并发两次切换按锁串行，最终 DB/live 一致。

## 4. P1 环境检查

- [ ] 默认显示自动检测 Home、来源和 Claude/Codex/Grok 三个派生配置路径。
- [ ] 用户可通过目录选择器手动选择 Home，也可粘贴绝对路径；保存后立即重跑三类环境检查。
- [ ] 用户可恢复自动检测；恢复后展示的新 Home 与派生路径正确。
- [ ] 选择的是 Home 根；选择 `.claude`、`.codex`、`.grok` 时阻止并提示选择父目录。
- [ ] 相对路径、文件路径、不存在/不可访问路径、只读路径分别给出明确错误或阻断状态。
- [ ] 本地 Windows 与每个 WSL 发行版分别保存 Home；支持可访问 WSL UNC/手动路径，不把一个发行版 Home 复用到另一个。
- [ ] Home override 不进入 WebDAV/普通 provider 导出，在新设备不会出现旧机器路径。
- [ ] Home 变化本身不写 CLI 配置；已有 global provider 时显示旧路径、新路径和 `needs_reapply`，只有显式重新应用才写新 Home。
- [ ] 环境检查、global activate、Hook/Statusline 默认目录与历史默认目录使用同一个 resolved Home；不得检测路径 A、写入 B、Hook 安装到 C、历史读取 D。
- [ ] 无功能级 override 时，Claude/Codex/Grok Hook 目标分别跟随 `<home>/.claude`、`<home>/.codex`、`<home>/.grok`；历史分别跟随其中的 `projects` / `sessions` / `sessions`。
- [ ] Home 改变后自动重检 Hook 状态并刷新自动跟随的 history source instance/index/cache，但不会自动安装、卸载或迁移 Hook，也不会移动/删除旧 Home 历史文件。
- [ ] Hook 自定义目录和历史 active source 自定义 config root 均高于 shared Home；切换 Home 后原值保留、显示“未跟随当前 Home”，用户可显式改为跟随。
- [ ] 修改 Hook 自定义目录不再暗改历史来源，修改历史来源也不再暗改 Hook 目录。
- [ ] Codex `sessions`、`history.jsonl`、`session_index.jsonl`、state DB、子代理 transcript 与 ccusage/request-log 读取使用同一个 resolved Codex config root；Claude/Grok 同类消费者不得回退到另一 Home。
- [ ] 本地与 WSL 的 Home/Hook/history target identity 一致；WSL 发行版切换不会扫描本机或另一发行版目录。
- [ ] 已安装/未安装/版本不兼容/可执行文件不可运行分别给 OK/Warning/Error。
- [ ] 配置不存在、合法、语法损坏、只读、外部修改分别有可操作提示。
- [ ] Key presence 仅返回存在与脱敏 hint，报告没有完整 Key。
- [ ] 环境变量检查只返回名称、scope、presence、fingerprint，不返回 value。
- [ ] PowerShell、CMD、Pwsh、Git Bash、WSL 路径与启动建议正确。
- [ ] Hook 未装/部分安装/被第三方管理可区分。
- [ ] 只提供刷新、复制脱敏报告、打开目录/官方文档、恢复重试；没有自动安装或删除变量。

## 5. P1 CCS 导入与迁移

- [ ] 默认路径、自定义路径、WSL 路径均可 preview；数据库不存在/损坏不影响 native 功能。
- [ ] preview 不把 Key 明文返回前端，commit 才在 Rust 中写入 native `secret_text`。
- [ ] upstream 单 Key provider 转为一个活动 Key。
- [ ] 目标 multi-key schema 转为多行 Key，只保留其活动选择，忽略轮询/配额/健康字段。
- [ ] OAuth/空 Key/未知格式被标记 skipped/conflict，不写空 Key。
- [ ] 重复导入同 source identity + fingerprint 不重复创建。
- [ ] source 内容变化显示 diff；仅名称相同不自动合并。
- [ ] CCS current provider 分类型映射为 native global state。
- [ ] project/worktree 旧 override 映射成功时变 v2；缺失/歧义时保存 issue、UI 标红、不静默回退。
- [ ] cutover 后搜索运行时路径不存在 `ccswitch_list_providers` / `ccswitch_prepare_*` / CCS catalog 读取。

## 6. P1 明文存储与数据边界

- [ ] 数据库 schema 明确使用 Key 明文字段，没有加密/Keyring 行为或误导文案。
- [ ] SQLite/WAL/全量 DB 备份含明文风险在设置页和文档中说明。
- [ ] 前端 store、React DevTools 可见 DTO、toast、错误、日志、诊断 JSON、普通 provider 导出均不含完整 Key。
- [ ] provider config blob 不重复保存同一 Key；Key 的数据库权威位置只有 key 表。
- [ ] 应用同步/普通导出默认排除 `secret_text`；恢复时显示“需要重新录入”。
- [ ] 删除 provider 后 key rows 级联删除；清理 generated/live 派生文件按引用和 ownership 安全执行。

## 7. 场景矩阵

| 维度 | 必测组合 |
|---|---|
| 窗口 | 聚焦 / 失焦 / 最小化 / 托盘后恢复 |
| 终端 | 无会话 / 单会话 / 多会话 / 分屏 / Workspan |
| Shell | PowerShell / CMD / Pwsh / Git Bash / WSL |
| Scope | 项目 / Worktree override / Worktree follow project / 全局 |
| CLI | Claude Code / Codex / Grok；安装/未安装/不兼容 |
| 配置 | 不存在 / 合法未知字段 / 损坏 / 只读 / 外部并发修改 |
| Home | 自动 / 手动目录 / 手动绝对路径 / 恢复自动 / CLI 子目录误选 / WSL UNC / 发行版不匹配 |
| CCS | 未装 / 空 / 单 Key / multi-key / 损坏 / WSL |
| 故障 | stage 失败 / 第一个文件替换失败 / 跨文件第二步失败 / DB commit 失败 / rollback 失败 / 崩溃恢复 |

要求：窗口状态不改变事务结果；多会话旧进程保持快照；WSL/Worktree 不泄漏到其他 scope。

## 8. P2 UI、i18n 与无障碍

- [ ] 设置页在 1024/1440 宽度无横向溢出，provider 列表和编辑器独立滚动。
- [ ] 所有交互键盘可达，焦点顺序等于视觉顺序，focus ring 清晰，无键盘陷阱。
- [ ] 标签不只靠颜色表达；Active/Draft/Disabled/Warning 有文本或图标。
- [ ] 表单有 label，错误与字段关联，保存有 loading/success/error 反馈。
- [ ] `zh-CN` / `en-US` 所有新文案、toast、ARIA、空状态完整；英文切换仍为 24 小时制。
- [ ] Key 输入默认 password，粘贴后不自动复制或回显，切换 provider 时清空临时明文 state。
- [ ] 原型中的“自动轮换/有效性”控件不存在。

## 9. 自动化验证建议

实施完成后的质量命令：

```powershell
npx tsc --noEmit
cd src-tauri
cargo check
cargo test
```

按仓库 command guardrail，本规划阶段不运行 build/dev/tauri build/tauri dev；只有用户在当前回合明确要求才执行。

重点自动化层：

- Rust unit：schema/state machine/merge/redact/adapter/render/import mapping。
- Rust integration：SQLite + temp dirs + injected failure points + journal recovery。
- Frontend unit：store/request redaction/override v2/parser/unsaved guard。
- Component：Key manual activation、global/project source badge、import conflict、environment results、i18n。
- E2E/manual：真实 CLI 新进程、WSL 路径、Worktree、多会话和托盘。

## 10. 放行标准

- P0 全部通过；P1 无未解释失败；P2 无阻断性可访问性/i18n 问题。
- 没有 CCS 运行时依赖和 legacy ID heuristic fallback。
- DB 与 live 配置在成功、失败、崩溃恢复后可证明一致。
- GitNexus `detect_changes(compare master)` 仅包含预期符号/流程；新增 IPC 调用人工清单核对完成。
- 变更记录目标从 `[TEMP]` 替换为实际发布版本后方可发布。
