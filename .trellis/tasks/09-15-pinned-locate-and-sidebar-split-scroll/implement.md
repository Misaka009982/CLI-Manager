# Implementation

## Approved scope

已批准（用户 2026-09-15 三次选择）：置顶项右键菜单首项「定位位置」= 列表内滚动定位并高亮；分区滚动 = 置顶区与列表各自独立、滚轮随鼠标所在区域；分隔线 = 侧栏内两区域之间。

三项开放决策已由用户 2026-09-15 答复并落定（展开祖先写回持久化、不可定位给提示、置顶区上限三七分内部滚动），细节见 `design.md`「已决议」。

`task.py start` 前需本文件与 `design.md` 齐备——已齐备。

## Execution batches

### 批次 1 — 布局分区（可独立交付、可独立回滚）

1. `SidebarView.tsx:192-224`：把 `PinnedProjectSection` 从 `ProjectTree` 内部提升到 `ui-sidebar-combined-list` 同级，形成「置顶区滚动容器 + 分隔线 + 列表滚动容器」三段结构；保留 `pinnedFilterActive || !searchActive` 与 `visiblePinnedProjects.length > 0` 的显隐条件。
2. 给两个滚动容器加语义类名（例如 `ui-sidebar-pinned-scroll` / `ui-sidebar-list-scroll`），供滚动保护与测试定位。
3. `project-tree.css` 与 `workspace-chrome.css`：置顶区容器 `flex: 0 0 auto` + `max-height: 30%` + `overflow-y-auto`（内容不足时按内容收缩，达上限后内部滚动）；列表容器 `flex: 1 1 auto; min-height: 70%` + `min-h-0` + `overflow-y-auto`；新增两区域之间的分隔线样式（参考现有 `context-menu-separator` 或侧栏既有分隔元素，保持低调不抢视线）。
4. 修正 `preserveSidebarScrollAfterContextMenu`（`sidebarModel.ts:36-59`）的目标容器：改为新的列表滚动容器，并在 dev 实测确认「打开菜单不再跳动」仍成立。

验收：滚轮随鼠标区域生效、两区滚动互不影响、分隔线可见、三种侧栏形态无高度塌陷。

### 批次 2 — 定位能力（依赖批次 1 的容器类名）

1. `sidebarModel.ts` 新增纯函数：求某 projectId 的祖先分组 id 链（递归遍历 `TNode` 树）。纯函数便于单测。
2. `useSidebarController.tsx` 新增 `locateProject(project)`：
   - `projectFilter !== "all"` → `setProjectFilter("all")`；
   - 从 `collapsedGroupIds` 移除祖先分组 id 并 `updateSetting` **持久化**（与手动展开同语义）；
   - 设选中 + 递增 `locateNonce`；
   - 不可定位时按原因 `toast.error` / `toast.info` 提示（`toast` 已在 `:23` 导入，无新依赖）。
3. `ProjectTree.tsx` 新增副作用：依赖 `locateNonce`，在 `requestAnimationFrame` 后查 `[data-tree-key="p:<id>"]` 并 `scrollIntoView({ block: "nearest" })`。必须独立于现有 `selectedTreeKey` 副作用，保证重复定位仍生效。
4. 处理与右键滚动保护的时序冲突：定位时清理 `contextMenuInternalScrollUntilRef`，避免被 `50ms`/`150ms` 的恢复回写弹回。

验收：折叠分组内项目可定位、筛选态可自动切换、重复点击仍滚动。

### 批次 3 — 菜单项与文案

1. 菜单状态联合类型（`useSidebarController.tsx:400-405`）的 `project` 分支新增来源标记（如 `fromPinned?: boolean`）；`PinnedProjectSection.tsx:130` 传入。
2. `SidebarView.tsx:266` 项目菜单首部插入「定位位置」按钮 + 紧随的 `context-menu-separator`；**必须同时受 `showProjectBatchContextMenu` 控制**（批量态隐藏，与相邻项目项一致）；仅 `fromPinned` 时渲染。
3. i18n：`src/shared/i18n/messages/projects.zh-CN.ts` / `.en-US.ts` 新增 `sidebar.menu.locate`（及不可定位时的提示文案，若开放决策 2 选择提示方案）。
4. 图标从既有 lucide 图标集中选取与本项目风格一致的项（不得新增依赖）。

验收：置顶项菜单首项为「定位位置」且其后有分隔线；主列表项目行菜单无此项；批量态无此项。

### 批次 4 — 交付记录与验证

1. `CHANGELOG.md` 顶部新增 `## [TEMP] - 2026-09-15` 条目（用户未给版本号）。
2. `docs/功能清单.md` 归入「侧边栏项目树」板块。
3. 更新 `manual-checklist.md` 并执行人工验收。

## Delivery gates

- `npx tsc --noEmit` 通过。
- 定向测试：`sidebarModel.ts` 新增纯函数的单测；侧栏相关既有测试不回归。
- `npm run check:architecture`（独立运行，不绑定构建）；不新增超限文件、不新增豁免。
- 手写文件均 < 2000 行；`useSidebarController.tsx` 与 `SidebarView.tsx` 已是超大文件，新增逻辑优先外移到 `lib/`（符合 `AGENTS.md` 的 400–1200 行倾向与拆分要求）——批次 2 的纯函数入 `sidebarModel.ts` 即为此意，若该文件逼近上限需另开模块。
- 双语人工切换确认。
- 不启动应用/服务做 AI UI 验收；人工验收由用户执行。

## Verification plan

见 `manual-checklist.md`。重点回归：右键菜单滚动位置保持、树内键盘导航、拖拽排序与拖入分组、分组折叠展开、文件浏览器切换、折叠与紧凑侧栏形态、项目作用域终端视图开关。

## 执行记录（2026-09-15 完成）

四个批次全部落地，`npx tsc --noEmit` 通过、`node --test scripts/pinnedProjectLocate.test.mjs` 9/9 通过、侧栏与架构相关既有测试 18/18 通过。以下为实现相对计划的偏离，以及偏离的理由。

| 项 | 计划 | 实际 | 理由 |
|---|---|---|---|
| 分区层级 | 把 `PinnedProjectSection` 提升到 `SidebarView` 的 `ui-sidebar-combined-list` 同级 | 仍留在 `ProjectTree` 内，改为放在两段结构的**外层根**中：`ui-sidebar-pinned-scroll` + 分隔线 + `ui-sidebar-main-scroll` | `ProjectTree` 持有 `embedded`、`searchActive`、`pinnedFilterActive`、`density` 等判定分区所需的状态；提升出去需把这批状态与 `PinnedProjectSection` 一起上抛，改动面与回归风险都更大，而分区效果完全等价。 |
| 列表容器高度 | `min-height: 70%` | 只给置顶区 `max-height: 30%`，列表区用 `flex: 1 1 auto` 自动占满余量 | 30% 上限已保证列表区约为 70%，显式 `min-height: 70%` 是冗余约束；且两处硬编码比例并存时，日后调整上限容易只改一处而失配。实测最坏为 68.9%，差的 1.2% 是分隔线占位（见下），故**不能**把列表区写成「≥70%」的硬下限——已按实测修正三处文档措辞。 |
| 时序冲突 | 定位时清理 `contextMenuInternalScrollUntilRef` / 取消恢复定时器 | **不做**，见 `design.md` 实测结论 | 从置顶行右键时 `closest(".ui-sidebar-main-scroll")` 返回 `null`，恢复定时器与 `markInternalScroll` 均被提前 `return` 跳过，冲突不存在。 |
| 定位请求载体 | `locateNonce` 单独一个信号 | 请求对象 `{ projectId, projectName, nonce }` | 滚动阶段才可能发现目标行不可达（见下条），此时已取不到 `Project` 对象，故随请求带上名称以便复用同一条提示文案。 |
| 不可达提示的覆盖面 | 仅「项目已不在树中」 | 追加「残留搜索词把项目过滤掉」 | §5 场景维度复核发现：在「已置顶」筛选下若残留搜索词，切回「全部」后树仍被搜索过滤，目标行不渲染，定位会**静默失败**。故把「未命中」判定移到 DOM 查询处，首帧未命中补一帧再判定后 `toast.info` 提示。两条路径互斥（hook 在 `ancestors === null` 时提前 return，不会双重提示）。 |
| 交付记录位置 | `docs/功能清单.md` 归入「侧边栏项目树」板块 | 归入 `## [TEMP] - 2026-09-15` 新增 `### 侧边栏置顶项目定位与分区滚动` | 与前序同日条目「侧边栏项目树视觉减负」同属侧栏观感/交互改动，放在同一临时版本段落便于一起归档。 |
| 版本号 | `## [TEMP] - 2026-09-15` | 同左 | 用户未提供版本号；沿用当日既有 TEMP 段落。若需正式版本号可整体替换。 |
| 测试形式 | `sidebarModel.ts` 新增纯函数的单测 | `scripts/pinnedProjectLocate.test.mjs` 源码断言（`node:test`） | 仓库无前端测试运行器（无 vitest/jest/mocha），既有约定即 `scripts/*.test.mjs` 内的 `node:test` + 源码正则断言（参照 `projectSidebarDocking.test.mjs`）。为遵守「不新增依赖」而沿用该约定，未引入测试框架。 |

### 顺带规避的一个陷阱

新增测试首次运行有 1 条失败：我原先断言「样式文件中不得出现 `overscroll-behavior: contain`」，实际 `project-tree.css:638` 早已在 `.ui-appearance-picker-scroll` 上使用该属性，与分区容器无关。该断言属过度约束，已改为对两个新容器的 `min-height: 0` 正向断言 —— 这才是 flex 子项能真正溢出滚动的关键条件（默认 `min-height: auto` 会让容器撑开而不产生滚动条），也是本任务最容易被漏掉的样式细节。

### 布局实测（无头渲染，替代原计划的视觉并排比对）

原计划的人工目视比对无法回答「百分比高度有没有解析」这类问题，故改为可量化的无头渲染：
harness 复刻真实的 DOM 高度链（侧栏外壳 → `.ui-sidebar-combined-list` → `ProjectTree` 根 →
两个分区容器 → `role="tree"`），三处规则**原样复制**自 `project-tree.css:841-868`，
外壳高 800px，项目行固定 30px。三种形态实测：

| 形态 | 置顶区 | 分隔线 | 列表区 | 置顶区滚动 | 列表区滚动 | 外层容器滚动 |
|---|---|---|---|---|---|---|
| 置顶 2 项 | 83.4px（10.6%，按内容收缩） | 9px | 693.6px（88.2%） | 否 | 是 | 否 |
| 置顶 12 项 | 235.8px（**30.0%，精确触顶**） | 9px | 541.2px（68.9%） | **是**（scrollH 383 / clientH 236） | 是 | 否 |
| 置顶 0 项 | 不渲染 | 不渲染 | 786px（100%） | — | 是 | 否 |

三项结论：

1. **`max-height: 30%` 对父级内容盒求解**，实测 30% × 786 = 235.8px 精确吻合；容器有确定高度（`h-full` 链完整）是前提。
2. **`min-h-full` 在一个 flex 子项上正常解析**（三例均撑满列表区内容盒）。这是实现前最不确定的一点——百分比高度是否对「由 flex-grow 决定尺寸的父级」解析，历史上浏览器行为不一致；WebView2/现代 Chromium 已按规范视为确定尺寸，实测通过。
3. **外层 `.ui-sidebar-combined-list` 始终不溢出**，即不存在三重滚动条；内层两个容器各自独立滚动，正是分区目标。

**实测同时纠正了一处文档错误**：先前在 CSS 注释、`CHANGELOG.md`、`docs/功能清单.md` 中均写作「列表区始终保有 ≥70% 高度」。实测最坏为 68.9%，差的约 1.1% 是分隔线自身占位（1px + 上下 margin 各 4px = 9px）。30% 是置顶区的硬上限，列表区拿的是**余量**而非独立的 70% 下限；四处措辞已按实测修正。

**未覆盖**：本 harness 验证的是布局与高度约束，不含真实应用的主题色、字体度量与 Tauri WebView2 的渲染差异，观感仍以真机为准。
harness 与截图位于 `%TEMP%\cm-region-harness\`（`index.html` / `region-split.png` / `dom.html`），未纳入仓库——它依赖本机 Edge 且与仓库既有 `scripts/*.test.mjs`（纯 Node 断言、无浏览器依赖）的约定不一致，故不留作常驻资产。若后续希望把布局回归纳入自动检查，需另行决定是否接受浏览器依赖。

### 未完成项

`npm run check:architecture -- --strict` 仍报 `src/features/projects/hooks/useSidebarController.tsx: 2179 lines (limit 2000)`。该文件在本任务开始前（HEAD）即为 2163 行，属**既有超限**；本次为接入 hook 增加的注释与签名使其 +16 行。定位逻辑本身已按计划外移到新建的 `useProjectLocate.ts`，未在超限文件中堆积实现。其余告警（`apps/web/*`、`src-tauri/src/web_daemon.rs`、`src/shared/lib/*`）均为既有基线，与本次改动无关。
