# V1.4.0 导入与Skill同步设计草案

## Ownership

新增GitHub安装管线，具体流程与边界遵循父任务design.md的GitHub Skill installation；与cc-switch/本机导入共用staging、冲突、发布和部署机制，保留commit/ref/子目录和内容哈希。

cc-switch只读schema适配，原生导入preview/apply；Skill完整包进入数据目录，auto/symlink/copy部署，所有权/哈希和备份恢复。

## Dependencies

依赖extension-model-adapters的模型/目标身份/应用结果接口。

## Shared contracts

遵循父任务已确认的平台范围：Windows、macOS本机及WSL；SSH延后。复用环境/Home解析，按目标平台处理路径、CLI参数、链接与复制及主题交互，详细矩阵见父任务design.md的Supported platforms。

遵循 ../09-10-mcp-skill-management/design.md 的统一模型、文件所有权、作用域和UI约束；证据见父任务research.md。不复制另一子任务实现。

## Acceptance and limits

重复导入幂等；同名异内容可处理；来源不修改；缺失源/失效链接有解释；外部修改不误删；链接权限失败按所选策略处理。

父任务产品范围已确认，CLI兼容实验仍需完成；本文为待审阅设计，不代表最终实施批准。
