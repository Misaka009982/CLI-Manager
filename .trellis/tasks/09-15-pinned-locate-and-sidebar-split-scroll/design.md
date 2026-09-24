# Design / discovery / impact

## Cause and architecture

两项需求其实是同一处结构问题的一体两面：**置顶区与项目列表目前共用一个滚动容器**，而置顶项是主列表节点的副本，副本一滚走就无从知道原项目在列表中的位置。

当前结构（非 embedded）：

```
SidebarView.tsx:192  <div class="flex-1 overflow-hidden">
                     └─ .ui-sidebar-combined-list h-full min-h-0 overflow-y-auto   ← 外层滚动容器
                        └─ ProjectTree.tsx:657  flex h-full flex-col overflow-y-auto  ← 内层滚动容器
                           ├─ PinnedProjectSection   (ProjectTree.tsx:659)
                           └─ 项目树节点
```

两层都是 `h-full` + `overflow-y-auto`，高度同为父级高度，所以**内层才是有效滚动元素**，外层 `scrollTop` 恒为 0。这解释了为什么「置顶项会跟着滚走」，也决定了改法。

改法：把两个区域提为**同级**的两个滚动容器，各自 `overflow-y-auto` 并各自带类名钩子，置顶区 `shrink-0` + 高度上限，列表区 `flex-1 min-h-0`。滚轮作用于鼠标所在区域是浏览器原生行为（就近可滚动祖先），**不需要 JS 拦截 wheel**——这一点很关键，任何 JS 拦截都会与现有滚动保护、拖拽自动滚动打架。

## Impact analysis fallback

GitNexus MCP/runner/index 在本环境不可用（`gitnexus_*` 工具未注册）。按 `AGENTS.md` 降级：读 `.trellis/spec/frontend/*-contracts.md` 契约 + grep 定位触点。

- `PinnedProjectSection.tsx:130` `onContextMenuProject`：置顶项右键唯一入口。需要新增来源标记，使菜单能区分「置顶副本」与「主列表行」。低风险。
- `useSidebarController.tsx:399-408, 1599-1607` 菜单状态与项目右键处理：新增 `fromPinned` 字段属**契约变更**（`SidebarView` 消费同一联合类型）。中风险。
- `SidebarView.tsx:266-524` 项目菜单渲染：插入首项 + 分隔线。注意 `showProjectBatchContextMenu`（多选批量态）会 `hidden` 大量项目项——新增项也必须在批量态下隐藏，否则批量菜单会多出一条无意义的定位项。
- `useSidebarController.tsx:156, 299-326` `projectFilter` / `displayedTree`：定位需强制切回 `all`。**行为链路改动，中风险**——筛选是持久状态，强制切换会对用户可见。
- `useSidebarController.tsx:160, 896` `collapsedGroupIds` 与 `updateSetting`：展开祖先需写回该持久化设置。**副作用外溢，中风险**：定位会永久改变用户的折叠状态，必须明确这是否可接受（见「开放决策」）。
- `ProjectTree.tsx:295-306, 395-404` `selectedTreeKey` + 滚动副作用：定位的落点。副作用依赖 `selectedTreeKey` 变化，同值不重跑 → 重复定位需要额外信号。
- `ProjectTree.tsx:342-348` `focusTreeItem`：已有的「按 key 聚焦节点」入口，可复用其 `data-tree-key` 查询方式。
- `SidebarView.tsx:200` + `ProjectTree.tsx:657` 布局：分区滚动的改动点。中风险（影响所有侧栏形态）。
- `sidebarModel.ts:36-59` `preserveSidebarScrollAfterContextMenu`：见下节冲突。
- i18n（`sidebar.menu.locate` 等，zh-CN/en-US）、`CHANGELOG.md`、`docs/功能清单.md`、任务文档：受影响。
- PTY/daemon/proxy、SSH、数据库/迁移、Live Server、终端会话、文件浏览器内部逻辑：已检索，无改动。

## 与既有右键滚动保护的冲突（★ 实测结论：冲突不成立，已按结论收敛）

`handleContextMenuProject`（`useSidebarController.tsx:1600-1609`）在**每次打开右键菜单时**调用 `preserveSidebarScrollAfterContextMenu`，它会：

1. 读取目标滚动容器的 `scrollTop`，并在 `setTimeout 0` / `rAF` / `rAF²` / `50ms` / `150ms` 五个时机**把滚动位置写回去**；
2. 通过 `markInternalScroll` 把 `contextMenuInternalScrollUntilRef` 设为 `now + 300`，供「滚动即关闭菜单」的监听器（`:742-765`）豁免程序化滚动。

设计阶段推演出两个后果，实现时**逐条实测后结论如下**：

- **容器选错（成立，已修正）**：原函数读取的是 `.ui-sidebar-combined-list`，而真正的滚动元素是内层列表容器，该外层 `scrollTop` 恒为 0 —— 等于这段恢复逻辑长期未生效。分区改造中已把目标改为 `.ui-sidebar-main-scroll`（`sidebarModel.ts:38-41`），保护才开始真正起作用。
- **时序冲突（不成立，无需额外处理）**：原判断担心定位滚动会被 `50ms`/`150ms` 的恢复回写弹回。实测前提不成立——**恢复定时器根本不会被调度**。`preserveSidebarScrollAfterContextMenu` 在 `scrollContainer === null` 时于 `sidebarModel.ts:47` 提前 `return`，而「定位位置」只出现在置顶区，置顶区是 `.ui-sidebar-main-scroll` 的**兄弟节点**：从置顶行右键时 `closest(".ui-sidebar-main-scroll")` 返回 `null`，五个 `restore` 定时器与 `markInternalScroll` 全部跳过。因此不需要给恢复逻辑加可取消句柄，也不需要清理 `contextMenuInternalScrollUntilRef`（该 ref 只抑制「滚动即关菜单」，本就不影响滚动位置本身）。
  另有独立保证：即使某天来源不再是置顶区，右键时刻为 T0、点击菜单项必然晚于 T0+150ms（人类反应时间下限），五个恢复时机也早已全部执行完毕。
  该结论由一个负向断言守住：`scripts/pinnedProjectLocate.test.mjs` 校验置顶行传入 `fromPinned`、恢复目标为 `.ui-sidebar-main-scroll`、且提前返回的分支存在。

**据此取消的待办**：原「在定位动作里取消/重置恢复定时器」一项作废，不再引入可取消句柄（该类句柄本身也会给 `rAF` 链引入清理复杂度）。

## 「定位位置」机制设计

定位 = 三段串行，缺一不可：

1. **筛选可用**：`projectFilter !== "all"` 时 `setProjectFilter("all")`。否则项目不在 `displayedTree` 中，后续全部无效。
2. **路径可见**：从 `tree` 求出该项目的祖先分组 id 链，从 `collapsedGroupIds` 中移除，并 `updateSetting` 持久化。项目可能嵌套多层，需递归求解；`sidebarModel.ts` 现无此辅助函数，需新增（纯函数，便于单测）。
3. **滚动 + 高亮**：设选中（`selectedId`）→ 令 `selectedTreeKey` 成为 `p:<projectId>`。

第 3 段的关键缺陷：`ProjectTree.tsx:395-404` 的副作用依赖 `[selectedTreeKey]`，**项目已选中时值不变 → 副作用不重跑 → 第二次点击无反应**。且 `selectedTreeKey` 内部经 `visibleNodeIndex.has()` 判定，节点必须在 DOM 里才算数，展开祖先与滚动之间存在跨 render 的时序（React 提交后才挂上 DOM）。

因此需要一个**单调递增的定位请求计数器**（如 `locateRequest: { projectId, nonce }`），由副作用依赖 `nonce` 触发，并在 `requestAnimationFrame`（必要时两级）后查询 `[data-tree-key="p:<id>"]` 执行 `scrollIntoView({ block: "nearest" })`。高亮沿用现有选中视觉（左侧色条 + 单层主色底），不引入新的瞬时闪烁动画，避免与 `--animate-duration-*` 的 reduced-motion 语义纠缠。

## 已决议（用户 2026-09-15 答复）

### 1. 展开祖先：写回持久设置

用户原话：「定位时，如果有父级那自然要先将父级展开，以此到对应项目啊」。

**实现判定**：沿用与手动展开**完全一致**的语义——从 `collapsedGroupIds` 中移除祖先分组 id 并 `updateSetting` 持久化。

理由：`collapsedGroupIds` 是树渲染折叠态的唯一数据源。若改走"会话内临时展开集合"，会引入一份与持久设置并行的状态，需要处理两者优先级、项目删除后的清理、以及"用户刚手动展开又被临时状态收回"的矛盾。持久化只有一个来源，行为可预测。

> 该持久化判定是本次实现方的推论，用户未逐字确认。若你希望定位后**不留痕迹**（下次进入仍是折叠的），告诉我一句即可切换为临时展开，代价是要新增一份临时展开状态。

### 2. 不可定位：给出提示

用户原话：「不可定位时给予提示」。

**实现判定**：菜单项保持可点击（不置灰），点击后按原因给出 `sonner` toast——`useSidebarController.tsx:23` 已导入 `toast`，无需新依赖。三种原因分开提示：

- 项目路径无效（`pathInvalid`）→ `toast.error`，附带项目路径；
- 搜索态下该行不可见 → `toast.info`，提示先清空搜索；
- 其他 `visibleNodes` 中不存在该项目（如刚被删除）→ `toast.info`。

不采用"置灰"方案：置灰只能表达"不可用"，无法说明原因，且筛选/搜索态在菜单打开后才可能变化，置灰的判定时机反而更容易过期。

### 3. 置顶区高度：按项目数量弹性，上限三七分，内部滚动

用户原话：「现按照项目数量弹性，设置上限三七分，内部滚动」。

**实现判定**：

- 置顶区 `flex: 0 0 auto` + `max-height: 30%`，内容不足时按内容高度收缩（弹性），达到 30% 后**内部滚动**；
- 项目列表区 `flex: 1 1 auto; min-height: 70%`（配合 `min-h-0`），保证列表始终至少拿到七成高度；
- 30/70 用百分比而非固定像素，以便侧栏宽度/窗口尺寸变化时保持比例。

边界：置顶项为 0 时不渲染置顶区与分隔线（现有 `visiblePinnedProjects.length > 0` 条件已覆盖）；侧栏折叠为 64px 竖栏时该比例不适用，需按折叠形态单独确认表现。

## 场景矩阵

| 维度 | 取值与预期 |
|---|---|
| 侧栏形态 | 展开 / 折叠为 64px 竖栏 / compact 紧凑 / `embedded` 模式 —— 分区滚动与定位都要成立；折叠态下置顶区与列表的可见性需逐个确认 |
| 筛选态 | 全部 / 已开启 / 已置顶 —— 后两者下点击定位必须能切回全部并成功；「已置顶」态下 `displayedTree` 与置顶区是否重复渲染需确认 |
| 分组折叠 | 项目在根层 / 一级折叠分组内 / 多层嵌套折叠分组内 / 祖先分组已展开 |
| 搜索态 | 搜索关闭 / 搜索打开且命中该项目 / 搜索打开且不命中（不可见） |
| 选中态 | 项目未选中 / 已选中且可见 / 与多选批量态并存（`showProjectBatchContextMenu`） |
| 项目状态 | 路径正常 / `pathInvalid` / 位于 Worktree（`wt:` 键）/ 项目刚被删除或改名 |
| 右键菜单 | 从置顶副本打开（有定位项）/ 从主列表行打开（无定位项）/ 菜单已打开时再次右键其他项 |
| 滚动交互 | 指针在置顶区滚动 / 在列表区滚动 / 拖拽自动滚动 / 定位滚动与右键菜单滚动保护叠加（见冲突章节） |
| 窗口与分屏 | 焦点在本窗口 / 另一窗口 / 分屏中该项目在另一 pane / 窗口最小化或托盘 |
| 运行时环境 | 本地 PowerShell/CMD/Pwsh / WSL / Bash —— 本项目仅影响 UI，预期无关，但路径健康检查分支需确认 |
| 多会话 | 单会话 / 多会话 / 跨 Workspan 切换 / 项目作用域终端视图开关 |
| 输入焦点 | 焦点在树节点 / 在搜索框 / 在终端 / 菜单内键盘导航与 Escape |
| 双语 | zh-CN / en-US 切换后新增文案与 aria-label |

## Review

范围已对照契约与源码就地复核，未使用子代理。三项开放决策已由用户在 2026-09-15 答复并落入「已决议」章节；其中第 1 项（是否持久化展开）为按用户表述推论，已在文档内显式标注。人工 UI 验收待执行。
