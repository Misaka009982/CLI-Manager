# V1.4.0 统一模型与格式适配设计草案

## Ownership

版本化JSON为唯一MCP权威；规范headers/env/timeout/transport，保留perCliExtensions；定义SQLx实体、脱敏DTO、能力矩阵和字段级投影。

## Dependencies

无前置实现依赖；依据父任务 decision.md 定义版本/来源能力矩阵、冲突与不支持结果。完整认证/历史/项目并发验收归项目任务，不作为本任务开工前泛化探索门禁。

## Shared contracts

遵循父任务已确认的平台范围：Windows、macOS本机及WSL；SSH延后。复用环境/Home解析，按目标平台处理路径、CLI参数、链接与复制及主题交互，详细矩阵见父任务design.md的Supported platforms。

遵循 ../09-10-mcp-skill-management/design.md 的统一模型、文件所有权、作用域和UI约束；证据见父任务research.md。不复制另一子任务实现。

## Acceptance and limits

同一资源三CLI输出读回语义一致；不支持字段显式报错；无秘密泄漏；无关配置不变。

父任务产品范围已确认，CLI兼容实验仍需完成；本文为待审阅设计，不代表最终实施批准。
