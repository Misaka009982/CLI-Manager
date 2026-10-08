# 技术设计

## 基线与执行边界

- 基线：09aa134272c6a4eb90ffbfa714e9ff113c512317（V1.4.1 合并）。当前位于 integrate/v1.4.1-desktop-pet-e，未配置跟踪分支；本地缓存 origin/master 与 HEAD 相同，尚未联网确认。
- 初始改动：7 个已跟踪文件修改、3 个排序新文件，均属上次尚未提交的排序功能。
- 当前工具不提供 GitNexus 或独立子代理审查；以领域契约、精确路径搜索、源码和 Git 差异核查替代，不声称完成独立模型审查。
- 执行采用当前会话直接修改；没有配置外部实现引擎，不向其他服务发送代码。

## 根因与修补

### 偏好更新边界

旧菜单从渲染时的 settings 构造完整对象，调用异步 settingsStore.update 后立即关闭；该方法要等 s.set 完成才更新 Zustand。保存较慢时，第二次选择可能覆盖第一次选择，拒绝的 Promise 也没有 UI 反馈。

引入排序专用串行更新入口：菜单提交单个维度的变更，而非完整旧快照；队列在真正执行写入时读取最新偏好，再调用既有 settingsStore.update。队列内部仅恢复后续调度，当前调用的失败仍返回给菜单。菜单等待保存、显示忙碌状态并捕获错误，成功后关闭。不改变其他设置的写入语义，不新增第二份偏好状态。

### 排序与展示

- 在 shared/lib/fileTreeSort.ts 保留纯函数；校验有限非负修改时间，未知时间在同类型条目内后置，同时间以名称排序。
- 名称和日期维度分别使用升序、降序作为切换默认；重复选择当前维度不覆盖用户已选方向。
- 菜单保持两组独立单选，按钮显示当前方向，日期方向文案明确“最新/最旧在前”。
- 继续在 FileExplorerSidebar 的 useMemo 中投影排序树；不改变 fileExplorerStore 原始树或搜索结果。

## 触点清单

| 触点 | 处理 |
| --- | --- |
| src/shared/lib/fileTreeSort.ts | 时间边界、稳定比较、维度变更与可测试的串行更新器 |
| src/shared/preferences/fileTreeSortPreference.ts | 新增轻量接线，复用现有 Settings 真值与持久化 |
| src/features/files/components/FileTreeSortMenu.tsx | 异步保存反馈、方向展示与独立单选分组 |
| src/features/files/api/FileExplorerSidebar.tsx | 连接更新入口，保留树/搜索分流 |
| src/shared/preferences/settingsStore.ts | 复用既有新增字段、默认值与迁移，不扩展通用 update 行为 |
| src/features/sync/lib/syncSettings.ts | 保留 preferences 分类 |
| src/shared/ui/popover.tsx | 保留可选主题 Portal 容器，默认调用者行为不变 |
| src/shared/ui/icons.ts | 不再需要的新导出可随方向图标接入撤销 |
| files.zh-CN.ts / files.en-US.ts | 日期方向、保存状态与失败提示成对维护 |
| scripts/fileTreeSort.test.mjs | 补齐异常输入、连续更新、失败重试与接线断言 |
| fileExplorerStore / Rust 文件命令 / SSH Agent | 已确认时间元数据与刷新路径可复用，不需要修改 |
| apps/web、宠物E、window_state.rs | 排序修补阶段不修改；合并阶段检查保留 |

## 场景矩阵

- 侧栏/嵌入面板、左/右停靠、深浅主题：共享按钮与已存在的主题 Portal。
- 名称/日期、升/降序、空列表、同时间、未知时间、目录与文件混合：由纯函数覆盖。
- 多层已加载树、懒加载、新增/刷新条目、紧凑目录链：从当前 tree 重新投影，原始数据不变。
- 文件/代码搜索：沿用原始结果顺序。
- 连续点击、保存较慢、保存失败、重试、多个菜单入口：共享串行入口；菜单等待与错误反馈。
- 本地、WSL、SSH、Worktree：共用 ProjectFileEntry.modifiedMs，权限和路径语义不变。
- 失焦、最小化、跨 Workspan：不新增窗口监听或焦点跳转；Hook 安装状态与排序无关。

## 合并与回退

排序提交完成后，从该提交新建 integrate/v1.4.2-desktop-pet-e。核实远端标签实际指向，读取更新规模及 fork 文件交集，再执行 --no-commit --no-ff 合并。冲突同时保留上游行为与 fork 定制；双父提交以标签解引用后的提交为第二父提交。若发现会删除或替换 fork 核心架构的冲突，先报告，不猜测取舍。

合并前记录 fork 独占文件 Git 对象标识，合并后核对独占文件及共享接入点。回退依据排序独立提交和合并前分支；不主动 reset/clean/强制切换，也不擅自删除分支或任务文件。

## 既有风险

settingsStore.ts 在 HEAD 已为 2031 行，旧 fork 另有超 2000 行文件。不得把未运行的架构检查说成通过；本轮不扩大为无关重构，也不提高基线或新增豁免。新增模块保持短小。
