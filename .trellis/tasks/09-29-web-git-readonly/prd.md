# Web Git readonly panel and directory cache

## Goal

在 Web 现有可收起、可调宽侧栏中补齐只读 Git 变更与提交历史，同时减少重复展开目录的等待。版本沿用 1.4.1，仅交付 NSIS。

## Requirements

- 文件 / Git 切换；Git 下提供变更 / 历史，支持项目、Worktree、嵌套仓库隔离。
- 展示分支、变更文件、工作区 Diff、每页 50 条提交、搜索、提交详情和历史 Diff；不新增 Git 写操作。
- 样式修订：历史对齐桌面三栏结构及紧凑提交图表；文件 Diff 独立宽幅弹窗、左右对比/统一视图、行号与红绿高亮；手机全屏逐级导航，不挤三栏。
- 手机沿用抽屉，电脑沿用三栏与宽度调整；不能破坏终端和桌面 Git。
- 文件缓存新鲜期 30 秒、保留 10 分钟；有内容时后台刷新不显示阻塞加载，有限意图预取不递归扫描。
- SSH 暂不支持，提供明确提示；覆盖离线、空仓库、缺失 Worktree、二进制和过大结果。

## Acceptance Criteria

- [ ] 切换项目/设备/仓库/搜索时迟到响应不串数据；关闭面板停止请求。
- [ ] 新接口只接受注册项目/Worktree及受限仓库相对路径，不暴露任意本地路径。
- [ ] 已缓存目录展开即时显示；缓存失效和取消有测试。
- [ ] 中英文本完整，时间使用 24 小时制；分页、搜索、详情、Diff 有真实入口。
- [ ] 定向测试、桌面/Web 类型检查、服务端测试、严格架构检查、构建通过；提交后生成 NSIS。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
