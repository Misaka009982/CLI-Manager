# MCP 与 Skills 管理 UI 执行计划

本任务在规划批准后由主会话串行实施，不派发子代理。各切片可以独立检查，但最终验收需要全部切片完成。

## 开始门禁

1. 用户审核 `prd.md`、`design.md`、本文件并明确同意后，执行 `python ./.trellis/scripts/task.py start`。
2. `task.py start` 前再次只读执行并报告：
   - `git status --short --branch`
   - `git branch -vv`
   - `git rev-list --left-right --count 'HEAD...@{upstream}'`
3. 当前分支 `mcp-skill-manager` 没有配置 upstream；不能报告 ahead/behind，也不执行 pull/push/merge/rebase。
4. 开始实现前加载 `trellis-before-dev`，重新读取前端 extensions 入口、组件、类型安全、状态管理、质量契约及后端 extensions contract。
5. 每次编辑已有函数/组件/类型前尝试 GitNexus impact。当前 GitNexus MCP 暴露了仓库资源但没有 `impact/query/context/detect_changes` 工具，因此以已刷新索引、直接 import/caller 搜索和 `.trellis/spec/*-contracts.md` 作为降级证据，并在交付记录中说明。

## 独立实施切片与依赖

### Slice A — MCP 紧凑列表与 JSON 编辑器

依赖：无；只依赖当前 canonical MCP DTO、保存 workflow 和既有 Monaco 配置。

- 修改 `GlobalMcpPanel` 的行布局，保留排序、CLI 开关、pending、编辑、删除、导入和保存回调；验证长名称、窄宽度和 disabled 状态。
- 修改 `McpEditorDialog`：接入 `@monaco-editor/react`、`configureMonaco`、JSON language、稳定 options、defaultValue/local draft 和语法 marker；不把 `value` 作为受控输入传给 Editor。
- 保留 `mcpEditorJson`/`parseMcpEditorJson`、脱敏字段、Rust validate 和原有错误映射；确保取消/关闭不调用 upsert。
- 在 Slice A 完成后运行 `npx tsc --noEmit`，并用 `rg` 检查新增可见文案全部使用 i18n。

### Slice B — 单弹框 MCP 原生预览

依赖：Slice A 的列表工具栏入口仍可用；与 Slice A 可分开检查。

- 后端 `NativePreview` 在不改变请求、fingerprint 或 apply 语义的前提下追加脱敏 `content` 字段；复用 `adapters::redact_projected_content`，拒绝把完整 `desired` 正文直接跨 IPC 返回。
- 同步 `src/features/extensions/api/native.ts` 的 `NativeMcpPreview` 类型，并补充后端/适配器脱敏测试或定向回归断言。
- 重做 `NativeMcpPanel`：Modal 打开即加载默认 CLI；CLI 页签切换自动加载；展示格式、路径、资源数、changed、removed keys 和只读代码区；移除“先选择再点击生成”的第二步。
- 加入请求序号/取消保护，旧 CLI 响应不能覆盖当前 tab；保持 busy 时不可关闭和预览不写文件。
- 对损坏配置、unsupported、空内容和长正文使用已有稳定错误码及新增中英文文案。

### Slice C — Skills 紧凑列表与 GitHub 向导

依赖：不依赖 Slice B；复用 Slice A 形成的紧凑行视觉约束，不共享业务状态。

- 重排 `GlobalSkillsPanel` 的默认行和行内详情；维持同名来源、external/managed/unknown、CLI 状态、排序、安装/卸载/恢复和高级部署回调。
- 将详情中的嵌套 Card 改为分组/分隔行，详情仍在当前列表上下文内展开，键盘和 `aria-expanded` 语义完整。
- 重排 `GithubSkillDialog` 为统一 Mantine Modal 的输入、扫描、候选、部署、结果阶段；不改变固定 commit、多选、取消、部分失败和结果状态机。
- 如果共享行壳层抽取为新文件，只放在 `src/features/extensions/components`，保持纯展示 props，不创建新的全局 store/barrel。
- 运行与 Skills/GitHub 相关的定向类型检查和静态文案检查。

### Slice D — 项目策略弹框

依赖：Slice A/C 的行视觉约束已确定；数据 API 和策略保存逻辑保持现状。

- 重排 `ProjectExtensionsDialog` 的头部身份、tab、能力摘要、策略选择、资源列表、有效集合预览和 footer。
- 保持左右区域 `min-height: 0` 与独立滚动，底部操作不被列表遮挡；保留搜索、禁用态、SSH/WSL/未知身份和当前 CLI 的继承/自定义语义。
- 不将项目选择写回全局 MCP/Skills canonical 记录，不改变 `save` 请求结构。

### Slice E — 国际化、交付记录与验证

依赖：A–D 完成后执行。

- 更新 `src/shared/i18n/messages/extensions.zh-CN.ts` 与 `extensions.en-US.ts`，覆盖格式、预览、详情、扫描阶段、错误、aria 和 tooltip；复用既有 key，禁止组件硬编码新文案。
- 更新 `CHANGELOG.md` 的 `V1.4.0` 对应 MCP/Skills 条目，更新 `docs/功能清单.md` 的全局管理与项目策略条目。
- 如新增 `NativePreview.content`，同步更新 `.trellis/spec/backend/extensions-management-contracts.md` 对返回 DTO 的说明和测试记录。

## 符号级安全检查

编辑前按以下触点做定向影响确认：

- `GlobalMcpPanel` / `GlobalSkillsPanel`：确认 `GlobalExtensionsPage` 传入 props、`SettingsModal` 的 save workflow 和 `ExtensionSortableList` 调用关系。
- `McpEditorDialog`：确认 `mcpEditorJson`、`parseMcpEditorJson`、`upsertManagedMcpResource` 与 `validateExtensionMcpResource` 的保存顺序。
- `NativeMcpPanel` / `previewNativeMcp`：确认只有全局 MCP 工具栏调用，`applyNativeMcp` 不被预览路径调用。
- `NativePreview` / `redact_projected_content`：确认 Rust command 注册、前端 DTO 和 apply fingerprint 链路；任何高风险或秘密字段路径变化先停止并重新检查契约。
- `GithubSkillDialog` / `ProjectExtensionsDialog`：确认取消、结果、策略保存的 callback 与父组件状态，不修改安装/策略 API。

## 定向验证顺序

每个切片完成后先跑小范围检查，全部完成后跑交付门禁：

1. `npx tsc --noEmit`
2. `npm run check:architecture -- --strict`
3. `npm run report:architecture`，确认修改文件不超过 2000 行且没有新增豁免
4. `cd src-tauri; cargo test extensions` 或仓库可用的 extensions 定向 Rust 测试命令；若命令过滤器不适用，记录并执行 `cargo check --manifest-path src-tauri/Cargo.toml`
5. 受影响的现有 Node 定向测试（通过 `rg --files scripts src` 找到 extensions/MCP/Skills 测试后再执行，不启动桌面应用）
6. 不运行 `npm run tauri dev` 或其他自动 GUI 测试。

## 人工验收清单

- 设置页 MCP：行高、拖动、CLI 开关、添加/编辑/删除/保存、Monaco JSON 语法错误和脱敏字段。
- MCP 预览：打开即有默认 CLI 内容，三 tab 切换，JSON/TOML 代码可读，长行滚动，路径/changed/removed 状态，预览不写文件。
- Skills：紧凑行、同名来源展开、外部安装保护、安装/卸载/恢复、部署详情和空状态。
- GitHub：未扫描、扫描中、无候选、多选、固定 commit、安装中、部分失败、取消和重试。
- 项目弹框：MCP/Skills 切换、继承/自定义、左右独立滚动、footer 可见、搜索、禁用/不支持/SSH/WSL/未知状态。
- 切换浅色/深色与中英文；使用 375/768/1024/1440 宽度和至少 768px 高度，确认没有横向溢出、遮挡、缺失翻译或英文 12 小时制回归。

## 交付状态记录

- 规划阶段：已批准并激活任务，按 inline 模式由主会话实施。
- 实现阶段：Slice A–D 已完成；Slice E 已完成中英文文案、V1.4.0 交付记录、后端契约同步和定向回归脚本。
- 定向验证：前端 extensions Node 测试 33 项通过；新增异步预览/取消闭包测试 5 项通过；`npx tsc --noEmit`、`npm run check:architecture -- --strict`、`npm run report:architecture` 和 `git diff --check` 通过；Rust `cargo test --lib extensions` 为 63 passed、2 ignored。
- Rust 首次检查遇到 Windows ConPTY 资源锁定，使用 `TAURI_CONFIG={"bundle":{"resources":[]}}` 仅跳过构建期资源复制后，`cargo check` 和定向测试通过；未启动 Tauri 或桌面应用。
- GitNexus `detect_changes` 已执行：15 个文件、20 个符号变更，风险级别 medium；影响流程为项目策略弹框的应用进入路径，未发现超出任务范围的执行流。
- 人工验收仍需在设置页检查 375/768/1024/1440 宽度、浅色/深色、中英文、Monaco 输入与标记、三 CLI 预览切换、GitHub 向导取消/部分失败、项目弹框 footer 和真实 Windows/WSL 文件路径。

## 最终审查与场景记录

- 最新离开提示反馈：根因在设置导航与 MCP 会话状态边界，旧 leave 仅执行 continuation 并保留 pending，导致下一次导航再次提示；确认框允许空白关闭，遮罩也未限制事件来源。按 Home 记录独立 discarded 快照，渲染/导航/保存统一使用 applied 与 discarded 的最大版本；取消既不递减全局版本也不冒充 native apply。禁止确认框空白关闭，设置遮罩只接受 target/currentTarget 相同的点击。
- 发现清单：已修改 `mcpSaving.tsx`（单次导航意图/取消与应用分离）、`mcpPendingStore.ts`（取消快照）、`mcpPending.ts`（版本比较）、`SettingsModal.tsx`（遮罩来源）及双语提示；核对 `GlobalExtensionsPage` pending 转 false 后刷新且开关读回 native；核对编辑器/modelAdapters 已落盘 canonical 定义不回滚，Rust native apply/项目策略/Skill 安装无改动。GitNexus 相关影响均 LOW，主要调用链是 SettingsModal → useMcpSaveWorkflow → pending store。
- 场景：连续点击只保留第一次导航；取消后切换 Skills/设置页/关闭并重进不重复；Stay/Escape 保留编辑；新一轮修改重新提醒；本机/WSL Home 独立；保存中不能取消，部分成功不回退成功目标。窗口焦点、分屏、托盘、Workspan、Worktree 和 Hook 不参与这条设置页状态链，不新增平台写入。待人工验收：真实点击空白/切页/关闭、中英文及重新编辑。
- 本轮追加验证：`extensionsMcpSaving.test.mjs` 12 项通过，覆盖真实工作流闭包和 store；交付前继续运行扩展定向集、TypeScript、架构 strict 与差异检查。本轮用户反馈处理中，提交计划仍未获确认。
- 截图反馈第四轮：项目介绍节点未关联 checkbox 是点击无法勾选的根因；名称/介绍统一关联原生 checkbox，MCP/Skills 共用路径，禁用及键盘操作保持原生行为。用户明确要求取消卸载二次确认，两个卸载入口共用直接调用，保留并发、所有权、后端外部修改检查。新增标签关联断言与卸载闭包回归（直接调用、重复点击、非受管、已修改、后端拒绝）。
- 截图反馈第三轮：全局 Skills 与 MCP 保持同一行壳层，摘要改单行截断、共享/异常状态改为名称旁短标记、详情改展开图标；保留完整 tooltip、展开说明和既有安装操作。仅展示与中英文文案调整。
- 截图反馈追加：项目列表使用 compact 展示变体，名称与合并说明共两行、淡色选中提示；批量全选/取消全选仅处理当前过滤结果，从有效集合开始保留隐藏项和已选同名来源，继承模式转自定义，保存边界不变。增加闭包测试覆盖过滤、来源与禁用保护。用户反馈处理中，原提交计划尚未确认。
- 截图反馈第二轮：MCP/Skills 页签从填充蓝色块改为下划线；继承/自定义从蓝色填充改为中性色边框和轻阴影；资源行继续使用紧凑间距。
- 根因修复：GitHub 取消确认与原扫描/安装共用 `busy`，取消接口先返回时会提前允许关闭或发起新操作。现在取消确认独立使用 `cancelling`，两项请求都完成后才解除界面锁；测试覆盖取消成功和失败。
- 预览竞态：切换 CLI 的事件立即失效旧请求，effect 清理也失效当前代际，防止旧响应在切换提交前后或关闭后发布。
- 代码触点已核对：全局设置入口与列表 props；MCP 编辑 parser/校验/upsert；原生预览 Rust plan → 脱敏 → DTO → Modal；Skills 来源/所有权/快捷操作；GitHub 固定 commit/取消/部署结果；项目与 Worktree 当前 CLI 策略及继承保存。
- 场景维度：本机与 WSL 保留现有 Home 路由；项目/Worktree 身份与继承保持既有 API；SSH、未知 WSL、非受支持 CLI 沿用不可编辑提示。窗口焦点、最小化、分屏、Workspan 与 Hook 安装状态不参与这些局部展示状态或新增写入路径，未改动对应实现。窄窗、长名称/路径、主题、语言与键盘交互列入人工验收。
- 未跟踪的新行组件和闭包回归脚本已由主会话审查；GitNexus 的符号统计不代替这两项审查。未发现未知来源的工作树改动。
- 自动验证已完成；当前停留在 Phase 3.4 的提交计划确认步骤，未提交、未归档。

## 提交计划（一次确认）

`feat(extensions): 优化 MCP 与 Skills 管理界面`

包含以下文件；没有待纳入或排除的未知改动：

```text
src/features/extensions/components/ExtensionCompactRow.tsx
src/features/extensions/components/GlobalMcpPanel.tsx
src/features/extensions/components/GlobalSkillsPanel.tsx
src/features/extensions/components/McpEditorDialog.tsx
src/features/extensions/components/NativeMcpPanel.tsx
src/features/extensions/components/GithubSkillDialog.tsx
src/features/extensions/components/ProjectExtensionsDialog.tsx
src/features/extensions/api/native.ts
src-tauri/src/features/extensions/native.rs
src-tauri/src/features/extensions/adapters.rs
src/shared/i18n/messages/extensions.zh-CN.ts
src/shared/i18n/messages/extensions.en-US.ts
scripts/extensionsLists.test.mjs
scripts/extensionsSettingsLayout.test.mjs
scripts/extensionsManagementUi.test.mjs
.trellis/spec/backend/extensions-management-contracts.md
CHANGELOG.md
docs/功能清单.md
.trellis/tasks/09-14-mcp-skill-management-ui/prd.md
.trellis/tasks/09-14-mcp-skill-management-ui/design.md
.trellis/tasks/09-14-mcp-skill-management-ui/implement.md
.trellis/tasks/09-14-mcp-skill-management-ui/implement.jsonl
.trellis/tasks/09-14-mcp-skill-management-ui/check.jsonl
.trellis/tasks/09-14-mcp-skill-management-ui/task.json
```
