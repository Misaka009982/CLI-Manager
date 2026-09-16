# MCP 与 Skills 管理 UI 设计

## 设计目标

本次设计把 MCP 与 Skills 页面收敛为“紧凑资源行 + 按需详情”的桌面工具界面。视觉基线沿用当前设置页的 Mantine 组件、应用主题和现有 CLI 图标，不引入新的 UI 依赖或第二套设计系统。通用 UI/UX 检索结果中的高饱和块状方案不适合本页的信息密度，因此以仓库现有设置壳层、可读代码区域和低噪状态色为准。

核心原则：

- 一行只承载扫描所需的信息；来源、安装记录和高级设置不默认展开。
- 资源内容与操作分区稳定：左侧身份/摘要，中间状态，右侧操作；长文本使用省略和 title，不撑破行高。
- 代码正文使用独立滚动容器和等宽字体，元数据与代码分层，避免把路径、状态和 JSON/TOML 混成一段文字。
- 所有涉及写入的动作继续由既有保存/安装回调触发；预览和详情只读。
- 不把 MCP/Skills 聚合到新的跨域 store 或 barrel；视图状态留在现有 feature 组件，数据请求仍走 `features/extensions/api`。

## 组件与数据流

```text
SettingsModal
  └─ GlobalExtensionsPage
       ├─ GlobalMcpPanel
       │    ├─ ExtensionCompactRow（MCP 行）
       │    ├─ McpEditorDialog（Monaco JSON）
       │    └─ NativeMcpPanel（同一 Modal 内的 CLI 页签预览）
       └─ GlobalSkillsPanel
            ├─ ExtensionCompactRow（Skill 行布局复用壳层）
            └─ SkillInlineDetails（行内来源/安装/部署详情）

SettingsModal
  └─ ProjectExtensionsDialog
       ├─ policy tabs / capability summary
       ├─ compact selectable resource rows
       └─ effective-set preview
```

`GlobalExtensionsPage` 继续负责刷新、Home 身份与实际安装状态的组合，不增加新的全局请求。MCP 与 Skills 面板继续分别维护编辑、部署、展开和错误状态，避免一个面板的异步状态影响另一个面板。

## MCP 列表与编辑器

### 紧凑资源行

保留 `ExtensionSortableList` 的排序上下文和拖动手柄，在行内拆成三个区域：

1. 身份区：名称、server key、transport/source badge；名称和 key 均可截断。
2. 状态区：三个 CLI 的独立开关，使用既有 `ExtensionCliToggle` 和禁用/不支持态；待保存变化仍使用原有颜色和 pending 状态。
3. 操作区：编辑、删除和必要的辅助提示，图标按钮提供 tooltip 与 aria-label。

行使用小 padding、固定的最小高度和单层边框；不再用大面积 Card padding 叠加 Card。空状态、刷新中和错误保持当前数据请求行为，只调整排版。

### Monaco JSON 编辑器

`McpEditorDialog` 继续使用 `mcpEditorJson` 与 `parseMcpEditorJson`，只替换编辑表面：

- `@monaco-editor/react` 使用 `language="json"`、`defaultValue` 和稳定的 `options`/`onChange`，不使用每次渲染重写模型的受控 `value`。
- 在组件挂载路径调用已有 `configureMonaco()`，主题跟随 Mantine color scheme 映射到 `vs`/`vs-dark`。
- draft 由对话框本地维护；外部资源切换时重新初始化 draft，输入过程不被 React 异步刷新覆盖。
- 使用 Monaco 的 JSON marker 显示语法错误，同时保留保存前的 `parseMcpEditorJson` 与 Rust 语义校验；错误消息仍通过 `useI18n()` 映射，不能把完整 IPC 错误直接展示给用户。
- 底部操作栏固定在 Modal 内容底部，编辑区独立滚动；取消、Escape、关闭按钮不触发写入。

编辑器只接收当前单资源的脱敏可编辑 JSON。`parseMcpEditorJson` 继续负责隐藏 canonical 元数据、`perCliExtensions.claude` 合并和 redacted 字段保护，不在 UI 层自行拼接秘密。

## MCP 单弹框预览

### 交互

工具栏“配置预览”只打开一个 `NativeMcpPanel` Modal。Modal 打开后自动请求 Claude 预览（若当前 CLI 不可用则按既有错误展示），不再要求用户先选择 CLI 再点击生成。顶部使用三个 CLI 页签/分段按钮，切换后自动刷新当前页签；请求序号或 abort 保护旧响应，关闭期间不产生写入。

### 展示

预览 Modal 分为：

- 顶部：CLI 名称、`JSON`/`TOML` 格式徽章、资源数量、当前/将变更状态。
- 辅助信息：目标路径、指纹状态、脱敏提示、被移除 key 或不可用错误。
- 主区域：只读代码块，使用 `content` 的原生格式化正文；代码区域独立垂直/水平滚动，长路径不影响代码宽度。

当前 `extensions_mcp_native_preview` 已经负责读取基线、合并受管资源、计算 fingerprint 和判断 changed。为避免前端重复读取原生配置，后端只在该既有响应中追加 `content`（以及必要的 `format`）字段：正文通过已有 `redact_projected_content` 路径脱敏后返回，绝不返回完整 secret、secretRef 或凭据值。请求参数、apply 逻辑和写入时机不变。前端 `NativeMcpPreview` 类型同步增加字段；CLI 到格式的映射保留后端返回值为准。

unsupported/损坏配置仍走既有稳定错误码；UI 以本地化 Alert 告知目标 CLI 与修复方向，不回显原始配置正文。原生预览不会调用 `applyNativeMcp`，显式保存仍是唯一写文件入口。

## Skills 列表

Skills 使用与 MCP 相同的行壳层和列边界：拖动手柄、名称/摘要、状态与 CLI 图标、编辑/部署操作。默认行只显示必要信息；不把安装记录继续包装成卡片套卡片。

详情采用行内展开：

- 展开按钮使用原生 `details/summary` 的键盘语义，或等价的 `button` + `aria-expanded`，并保持同一行上下文。
- 详情面板使用分组标题和分隔行展示来源变体、外部路径、包/安装状态、备份恢复和高级部署；每个来源/安装项不再单独套 `Card`。
- 同名来源通过既有 Select 选择，不改变 hash/owner/external/unknown 状态判断；外部路径仍显示保护提示，危险操作继续走现有确认流程。
- `SkillDeployDialog`、卸载、恢复和 GitHub 安装的状态回调不变，详情只是调用入口的重新排版。

## GitHub Skill 对话框

保留 `GithubSkillDialog` 的状态机：输入、扫描、候选选择、安装中、结果和取消。视觉上改用设置页统一的 Mantine `Modal`/`Stack`/`Group`/`ScrollArea`，并按阶段显示内容：

1. 来源栏：GitHub URL、ref、子目录和扫描按钮。
2. 扫描结果栏：候选数量、全选/反选和固定 commit 标识。
3. 部署栏：目标 CLI、同步方式、安装按钮。
4. 结果栏：逐项成功/失败、警告和重试/关闭。

扫描前候选区不抢占空间；扫描后候选区获得主要高度。所有字段仍使用同一状态源，取消只停止当前请求并关闭，不删除已保存源包。

## 项目 MCP 与 Skills 策略对话框

`ProjectExtensionsDialog` 保留现有 Radix Dialog 与策略保存 API，重做内部布局：

- 头部集中项目/Worktree 身份和当前 CLI，MCP/Skills 切换使用明确的 tab selected 状态。
- 能力、支持、应用结果和错误摘要放在紧凑状态栏；不支持 SSH/WSL/未知身份仍使用现有条件分支和文案。
- 左侧策略与资源列表、右侧有效集合预览各自 `min-height: 0` 并独立滚动；底部取消/保存固定在 Dialog footer。
- 资源项复用与全局列表一致的名称、来源、CLI 状态和选中态，但项目策略仍只改变当前 CLI 的继承/自定义选择。
- 搜索和过滤状态保持在对话框内部，不进入全局扩展 store；保存按钮的 disabled、dirty 和错误行为保持现状。

## 国际化、主题和可访问性

- 新增或调整的按钮、提示、空状态、错误、格式徽章和 aria 文案分别写入 `extensions.zh-CN.ts` 与 `extensions.en-US.ts`，已有 key 优先复用。
- 图标按钮继续使用 Lucide/CLI 图标；仅图标操作必须有 tooltip 或 aria-label，展开按钮暴露 expanded 状态。
- Mantine surface 使用主题 token，代码区域只使用 Monaco 主题，不写死亮色背景；状态色同时有文字或图标含义，不能只依赖颜色。
- 在 375/768/1024/1440 宽度和至少 768px 高度下，列表、Modal footer、代码区、长 URL/路径均不能产生页面级横向滚动或遮挡。

## 文件边界

预期修改范围集中在：

- `src/features/extensions/components/GlobalMcpPanel.tsx`
- `src/features/extensions/components/GlobalSkillsPanel.tsx`
- `src/features/extensions/components/McpEditorDialog.tsx`
- `src/features/extensions/components/NativeMcpPanel.tsx`
- `src/features/extensions/components/GithubSkillDialog.tsx`
- `src/features/extensions/components/ProjectExtensionsDialog.tsx`
- `src/features/extensions/api/native.ts`
- 必要的 `src/shared/i18n/messages/extensions.*`、`src-tauri/src/features/extensions/native.rs`、`src-tauri/src/features/extensions/adapters.rs` 及其契约/测试
- `CHANGELOG.md`、`docs/功能清单.md`

若共用行布局确实需要拆分，只新增 feature-local 的小型展示组件，不新建跨功能聚合入口，不超过单文件 2000 行。
