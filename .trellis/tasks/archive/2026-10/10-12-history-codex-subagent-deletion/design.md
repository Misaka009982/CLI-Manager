# 根因与方案

## 根因陈述

历史变更链路把任何父 ID 当作禁止单独删除的依据，而 Codex 子代理是日期目录中的独立 rollout；后台旧树删除器只枚举相邻 subagents，前端又按该目录猜测清理范围，导致孤立子代理不可删且真实级联不完整。

## 发现清单与影响面

- historyDeletion：列表/Workspace/Store 共用资格；仅放开 Codex 普通 rollout，不放开 Claude 路径式子代理或其他来源。
- historySubagents/scanner：树展示与 parent_session_id 还包含 fork，不修改读取/展示协议，也不以该字段决定磁盘级联。
- history_delete_session：既有来源/项目/根校验和恢复锁保留；Codex 分支进入专用删除器，成功返回实际目标路径数组，其他来源返回 null 保持旧语义。
- codex_deletion：按配置根枚举普通 rollout，读取有界头部原始 metadata，只有 thread_spawn 是级联依据；校验 UUID/文件名/规范路径，拒绝选中身份歧义。
- deletion/backup：复用全量备份后删除与回滚，不改变 manifest/恢复协议。
- historyStore/historyStoreTypes：按真实路径清理实际加载的行及其元数据、收藏、搜索/详情；action 返回覆盖 key 给批量执行。
- 单删/批量确认入口：既有对话框与双语错误；批量执行完整预检后只跳过后台确认覆盖的 key，不默默省略其他失败项。
- Claude 与其他来源、恢复/编辑/转换、终端/Hook/Web：确认无行为扩展。

GitNexus 工具与其本地 skill 文件均不可用，降级使用 history 契约、codebase-memory inbound/outbound 与 rg/真实源码。memory 的直接调用风险被标记 CRITICAL，视为删除链路高风险；generic map/matches 的跨模块误连不作为事实。分支从 dc899267 创建，包含上一轮数据迁移修复，无上游，未做远程同步。

## 场景与安全边界

本地/WSL Codex、新旧 catalog/无 catalog、父存在/缺失/筛选隐藏、跨日期/跨项目 cwd、多层/兄弟/普通分叉、同名 UUID 歧义、链接/目录替代、备份失败/文件锁/回滚、SSH/只读/收藏、先选子后选父及混合批量均需覆盖。窗口焦点/分屏/最小化、Worktree 已删除与 Hook 状态不参与文件删除资格；继续依赖元数据身份而非项目目录存活。

独立子代理删除仅删其自身和明确后代，不追删父或兄弟。全根头部盘点避免依赖缓存新鲜度；本地不跟随目录链接/reparse，WSL 使用 guest find，不复用会吞错误的读取器扫描。选中关系有重复 UUID 或目标越界时失败关闭。没有证据证明为 thread_spawn 的 fork 永远不被级联。目录遍历/实际读失败明确返回错误，不把不完整盘点当成功。

IPC 名称/参数保持，返回值由 null 增加 Codex 路径数组；现有不读返回值的消费者兼容。前端不基于父 ID预测 Codex 后代清理，防止隐藏未删除 fork 或另一根同 ID。
