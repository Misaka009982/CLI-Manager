# V1.4.0 项目隔离与交互设计草案

优先级更新：本任务在全局管理后实施。项目 MCP/Skills 分别按能力提供自定义；不可实现时显示“仅支持全局”及原因/全局入口，正常使用全局，不假成功。此前待确认/必须全能力隔离的描述由父任务 decision.md 最新用户决定取代。

## Ownership

项目/Worktree每CLI的MCP/Skills独立inherit/custom，草稿与有效集合预览；按项目身份生成启动快照，与供应商配置合并并接入新建/resume。

## Dependencies

当前依据父任务 decision.md 收敛稿：依赖模型/适配器、导入部署、全局可复用列表。认证/历史/长驻进程/平台验证为本任务集成发布门禁，不再作为独立模型或 UI 工作开工前的整轮探索要求；新能力边界待审阅。

2026-09-10 更新：Grok 项目 skills.disabled 以及 GROK_CONFIG/GROK_CONFIG_PATH 未通过本机隔离实验，用户级同字段通过。用户已批准受管 GROK_HOME 路线，要求原始配置完整继承、仅注入 MCP/Skills；遵循父任务 design.md 的 Managed GROK_HOME 契约，先验证等价性，不删减原验收要求。同步时机已确认：新启动/新进程恢复继承最新原始配置，现有进程及重连保留启动快照；认证与历史另行保证连续性。

依赖模型与部署，并等待Grok过滤实验；项目范围已确认仅CLI-Manager启动/恢复，复用全局列表交互。

## Shared contracts

遵循父任务已确认的平台范围：Windows、macOS本机及WSL；SSH延后。复用环境/Home解析，按目标平台处理路径、CLI参数、链接与复制及主题交互，详细矩阵见父任务design.md的Supported platforms。

项目生效范围已确认：仅CLI-Manager启动/恢复。应用内保存策略，启动时按项目/Worktree/CLI/环境生成快照；不修改原生项目配置。重连已有进程不重新注入。UI提示应用范围及新会话生效，自定义启动命令无法适配时明确告知。

遵循 ../09-10-mcp-skill-management/design.md 的统一模型、文件所有权、作用域和UI约束；证据见父任务research.md。不复制另一子任务实现。

## Acceptance and limits

A=ABC、B=BCD并发正确；同路径不同项目和Worktree不串用；空集合全关；取消不写盘；旧会话待应用明确；无Hook仍能管理。

父任务产品范围已确认，CLI兼容实验仍需完成；本文为待审阅设计，不代表最终实施批准。
