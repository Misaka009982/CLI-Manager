# Design

用户已批准本方案并要求实施（2026-09-29）。

## Root cause / discovery

- 文件 session 对所有过期请求设置 loading，包括已有缓存内容；cache 仅保留五分钟。本轮区分后台刷新与首次加载，延长保留并加入有限意图预取。
- Web 右侧只挂载 ProjectFilesPanel；Git status/diff 管理接口已存在，历史未进入服务端白名单及桌面 bridge。
- 触点：apps/web 的目录 cache/session、文件面板、views 双入口、只读查询传输、i18n/CSS；apps/server/api allowlist；terminal/lib/webManagement 与新只读 Git handler。
- 复用现有 Rust git_list_repositories / git_list_commits / git_get_commit_detail / git_get_commit_file_diff。不改桌面 Git、PTY、数据库、Hook、SSH transport。

## Presentation correction (2026-09-29)

- Root cause: the original Web consumer flattened desktop Git DTOs and rendered raw patch text inside the narrow sidebar; it did not reuse desktop graph/parser primitives or workspace hierarchy. This is a presentation/data-consumer design correction, not a Git storage/PTY fault.
- Discovery: ProjectGitPanel/ProjectInspector (both host layouts), projectGit DTOs/read hook, new GitHistoryWorkspace/GitDialogs, projectGit CSS/i18n; terminal Web read bridge for existing branches and history reference; shared Git parser warning callback, graph and read-only snapshot entry. Server/Rust protocols, directory cache, Git writes, desktop layout and terminal state confirmed unrelated.
- History opens a wide branch/log/detail workspace. Diff uses a separate native modal, shared parser/Worker and react-diff-view primitives with virtualized Hunks. Standalone Web cannot import desktop stores; the parser receives the desktop debug logger from its existing caller, preserving desktop behavior. No second patch parser.
- Local/remote branch selection uses existing git.branches + git_list_commits reference, with repository canonical validation and bounded reference input. No checkout/fetch.
- Scenarios: desktop/mobile, light/dark, both languages, nested repository/Worktree, pending query cancellation, empty/binary/oversize/invalid patch, search/pagination/merge graph, nested dialog focus/Tab/Escape and close restoration. The portal prevents sidebar/drawer width inheritance; dialog key events do not reach the mobile drawer trap.
- GitNexus unavailable; codebase-memory impact labels the shared parser/controller and management chain HIGH/CRITICAL by caller distance. User informed; real source/tests define the scope. No runtime application/service launched, per project verification rule.

## Boundaries

- Web 请求只带 projectId、worktreeId、repository 相对路径。主机从 store 解析根路径，仓库枚举和 canonical context 验证后执行；返回仓库 DTO 不包含绝对路径。
- 新增只读 Git operation kinds，保持既有 Git 写操作确认规则不变。详情/Diff 按需，不主动 fetch，结果沿用传输大小上限。
- 面板按设备/项目/Worktree身份 remount，子查询用 AbortController 丢弃旧响应；仅可见 Git 页加载。历史每页50条，列表限制累计量，Diff不截断。
- 文件 session 保留现有 2 并发上限，意图预取仅空闲时单个调度、限制总数量；不自动递归。过期缓存刷新失败保留内容并显示错误。

## Scenarios

电脑/手机、展开/收起、多个 terminal tab与分屏目标、本地/WSL（复用核心路径分流）、主仓库/Worktree/.git文件/嵌套仓库、目录删除、设备离线/重连、空仓库/未出生分支/Detached HEAD、搜索分页、二进制/大Diff均需验证或人工验收。SSH明确不支持。焦点/最小化不改变查询授权；Hook是否安装无关。不启动应用或服务进行自动UI验证。

## Rollout

从 master 99ea43c0 创建 feat/web-git-readonly。GitNexus MCP不可用，采用 codebase-memory 索引/调用图 + 契约/源码/Git diff降级；索引调用图将共享分发链标为高风险，已告知用户。版本1.4.1，重建受影响后端、复用编译缓存，NSIS单包；回滚可安装先前1.4.1包，无数据迁移。
