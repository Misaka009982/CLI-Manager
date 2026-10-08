# Implementation

- [x] 目录 cache/session 与意图预取，扩展行为测试。
- [x] 只读 Git 主机 handler、server allowlist 与路径/协议测试。
- [x] Web 查询复用现有 operation 通道；侧栏入口、变更、历史、详情/Diff、中英样式。
- [x] 回归跨项目响应隔离、权限/只读边界、分页搜索和缓存（自动检查；运行时验收清单见 verification）。
- [x] 更新 CHANGELOG 1.4.1、功能清单、Web契约和 verification。
- [x] npm run web:typecheck；npx tsc --noEmit；39 项定向 node tests；60 项 server cargo tests；npm run check:architecture -- --strict。
- [x] 全量差异审查及索引刷新；提交本轮改动；缓存构建 NSIS，记录路径/Hash及人工测试项。未push或启动应用。
