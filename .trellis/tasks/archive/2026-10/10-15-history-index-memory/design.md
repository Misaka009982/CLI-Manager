# 根因与发现清单

根因：派生历史索引的值语义在快照、刷新、持久化和后台请求同步边界反复复制大统计向量，导致峰值放大，不是 PTY 输出大小造成。

- CachedSessionComputation.stats 改为 Arc<SessionStatsScan>：保持 JSON 与外部接口结构，构造入口转换，Grok 补充字段使用 copy-on-write。
- index_cache：BufReader/from_reader，BufWriter/to_writer/flush 后发布；统计只读共享；刷新互斥并在锁内复查 TTL；并行扫描上限 4，降低大文件并发峰值。
- request_logs 同步：指纹筛选先于文档转换，每次只构造一个变化文件；保留来源可访问保护、失败计数、事务和路由归属修复。OpenCode 原生解析流程不重构。
- scan_state/opencode/session_detail/既有测试：仅 Arc 类型适配；列表/统计/catalog IPC 不改。
- 前端、终端渲染、回滚、主数据库 Schema、原始历史文件：不修改。统计详情常驻大数据仍存在，本轮降低复制/临时数据峰值，不承诺总内存固定值。

场景：空/旧/损坏缓存、命中/过期/强制刷新、重复同步、增改删、不可访问根目录、不同 roots、统计与同步并发、多来源/WSL路径。读取数据用临时夹具；原始用户日志不写、不删除。

GitNexus 未暴露，降级 codebase-memory 调用图、契约和 rg；上游涉及历史列表/统计/请求同步，CRITICAL/HIGH 风险已告知。按项目 inline 模式实施。
