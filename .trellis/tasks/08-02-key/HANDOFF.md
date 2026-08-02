# 08-02-key 交接说明

更新时间：2026-08-03
任务状态：`in_progress`，不要归档或标记完成。

## 目标

把 CLI-Manager 从 CCS 供应商运行时依赖逐步迁移到自有供应商域，覆盖：

- `providers.db` 独立数据边界；
- Claude / Codex / Grok Build 供应商目录与多 Key；
- 完整配置文档、类型级通用配置；
- 全局 Home 应用与恢复；
- 项目 / Worktree 作用域解析；
- Home 环境诊断；
- CCS 只读导入、冲突与修复。

## 当前代码状态

当前分支：`feat/native-provider-management`。基线提交是：

```text
b37c8a4e feat(provider): complete native key management flow
```

本次交接提交会包含当前工作树中的文档编辑器和交接资料，并推送到：

```text
origin/feat/native-provider-management
```

`AGENTS.md` 与 `CLAUDE.md` 的本地修改是用户已有修改，不要覆盖、回退或加入本任务提交。

## 已完成

### Phase 0：数据库与兼容边界

- 独立 `providers.db` opener、WAL、foreign keys、busy timeout、迁移前备份。
- CCS 兼容的供应商核心表、通用配置、手动 Key、Home 偏好、导入引用、repair issue、apply journal 表。
- 复合 `(id, app_type)` 身份、启用/当前约束、active key 唯一约束和数据库测试。
- 旧 `cli-manager.db` 的历史迁移注册保留，生产供应商命令尚未把旧 CCS 数据库作为运行时数据源。

### Phase 1：目录、Key、通用配置与完整文档

- 原生目录 list/get/create/update/duplicate/delete/enable/current/reorder。
- Key create/update/delete/reorder/activate/reveal、启停、当前 Key 替换确认；替换、投影和删除在同一事务内完成。
- Claude 通用 JSON；Codex/Grok Build 通用 TOML；供应商配置覆盖通用配置并生成脱敏 effective preview。
- 完整配置文档：
  - Claude：`claude.settings` / `settings.json`；
  - Codex：`codex.auth` / `auth.json` 与 `codex.config` / `config.toml`；
  - Grok Build：`grokbuild.config` / `config.toml`。
- 后端负责 JSON/TOML 语法校验、嵌套 TOML 摘要、敏感字段脱敏、密钥字段保留和禁止通过原始文档新增/修改托管密钥。
- 前端按职责拆分 catalog、card、editor、key section、form、document editor、common config hook/section；新增文案同时有 `zh-CN` / `en-US`。
- 供应商切换会清理文档草稿，CLI 类型切换会确认并保护通用配置和文档未保存草稿。

## 已验证

最近一次完整验证结果：

```text
cargo test --no-fail-fast: 808 passed, 1 ignored
cargo check: passed
npx tsc --noEmit: passed
```

提交前 GitNexus `detect_changes(scope=staged)` 给出 `risk_level=high`，命中
`lib.rs::run`、`NativeProviderSettingsPage` 和 `ProviderDetail` 等跨层符号；
这是旧索引对 Tauri 启动入口、设置页和新增文档模块的宽泛映射，不是测试失败。
提交前仍需在下一台机器重新运行 `detect_changes`，并在继续改动任何高风险符号前
先做 upstream impact。

不要运行 `npm run dev`、`npm run build`、`npm run tauri dev` 或 `npm run tauri build`，除非用户明确要求。

## 剩余任务（按优先级）

### Phase 2：Home resolver、诊断、全局应用

1. 实现 `CliHomeResolver`：自动/手动本地 Home、绝对路径、WSL UNC Home、多发行版独立存储、reset-to-auto、派生 `.claude` / `.codex` / `.grok` 目标路径。
2. 把 Hook/statusline 默认目录和历史默认根目录接入 resolver，同时保留显式目录的更高优先级。
3. 实现不返回明文的环境诊断：CLI 可执行文件/版本、Home 来源、目标访问、配置语法、当前 provider/key 存在性、环境冲突指纹、Hook/history 对齐。
4. 实现 Claude、Codex、Grok Build 的 owner-aware global writer：stage、parse、backup、replace、verify、compensate、journal recovery。
5. 实现 global preview/apply/current/repair；处理文件缺失、只读、语法错误、外部修改指纹冲突、中途失败和重启恢复。

验收重点：Codex 的 `auth.json` 和 `config.toml` 必须一起写入；任一目标写失败时已写目标全部恢复；正在运行的终端不被重启或改变环境。

### Phase 3：项目 / Worktree / 终端接入

1. 建立 v2 native provider reference 和旧 CCS 引用 repair 数据，不得按同名或第一项猜测映射。
2. 实现 Worktree > project > global 的 ProviderResolver 与 reset 规则。
3. 为 Claude/Codex/Grok 实现隔离的 ProviderMaterializer；密钥只能通过环境/配置注入，不能拼进 shell 命令。
4. 接入 terminal create、项目启动、Worktree 启动、session restore、badge、CC Connect；远程 SSH 禁止把本地密钥发到远端。
5. 仅保留 CCS import reader/repair adapter，移除正常运行路径中的 `ccswitch_*` 读取、prepare、reset、switch。

### Phase 4：CCS import、repair、备份边界

1. 只读读取本地/WSL CCS 数据库，支持缺失、空库、损坏、schema 检测、app type 归一化、source fingerprint。
2. import preview：显式 Key consent、元数据/文档/通用配置/current candidate、多 Key 标签备注 tags 排序启用状态、冲突行、旧 scope 引用映射。
3. transactional import commit、source refs、repair issues、重复导入幂等、source 变化冲突预览。
4. 默认 backup/sync/export 不包含明文 Key；恢复时展示占位符并要求重新输入。

### Phase 5：完整维护 UI

- 高保真供应商页剩余 UI：global current strip、drag ordering、import/environment/add actions。
- editor 的 global preview/apply/current/repair、Home/Environment 屏幕、import preview/conflict/repair 对话框。
- source/common/provider/effective/live-diff 视图与字段来源标识。
- 1024/1440 宽度、独立滚动、键盘流、焦点回归、ARIA、双语切换和 24 小时格式人工检查。

### Phase 6：切换、回归与清理

- 代表性旧 CLI-Manager DB 与 CCS DB 的迁移验证。
- GitNexus 追踪所有旧 `ccswitch_*` 运行时触点并在原生替代完成后清理。
- 补充 crash recovery、busy contention、外部修改、WSL、Worktree、多 pane、session snapshot、显式目录覆盖回归。
- 最终更新文档、功能清单、备份警告、规则与 `[TEMP]` changelog；执行 `detect_changes({scope:"compare", base_ref:"master"})`。

## 另一台机器的接续提示词

可以直接发送以下内容：

> 继续处理 `D:\github\CLI-Manager\.trellis\tasks\08-02-key`，当前分支是 `feat/native-provider-management`。先阅读 `HANDOFF.md`、`acceptance.md`、`implement.md`、`prd.md`、`design.md` 和相关 `.trellis/spec`，不要回退已有提交，也不要修改或提交用户已有的 `AGENTS.md` / `CLAUDE.md` 改动。当前 Phase 0 和 Phase 1（目录、Key、通用 JSON/TOML、Claude/Codex/Grok 完整文档编辑器）已完成，先做一次 review 和质量校验；然后按顺序继续 Phase 2：CliHomeResolver、Home 诊断、global preview/apply、owner-aware writers、补偿与 journal recovery。每完成一个子项都必须 review，发现问题立即修复并重新验证；前端组件按职责拆分，新增可见文案同步 `zh-CN`/`en-US`。修改函数/类/方法前先运行 GitNexus upstream impact，HIGH/CRITICAL 先停下报告；提交前运行 `detect_changes`。不要运行 dev/build 命令，除非用户明确要求。每个阶段完成后报告剩余阶段，不要把任务标记完成，直到 acceptance gates 全部通过。

## 继续前的最小命令

```powershell
git switch feat/native-provider-management
git pull --ff-only origin feat/native-provider-management
git status --short
npx tsc --noEmit
cd src-tauri
cargo check
cargo test --no-fail-fast
```
