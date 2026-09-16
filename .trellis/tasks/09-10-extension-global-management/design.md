# V1.4.0 全局管理界面设计草案

## Ownership

GitHub安装入口复用导入向导布局与状态，展示地址/ref/子目录及已解析commit，支持候选选择、进度和取消；细节遵循父任务GitHub安装设计。

settings只挂载extensions入口；环境/Home选择，MCP/Skills页签、共用资源行、独立CLI开关、统一JSON高级编辑、导入向导和逐项目标结果。

## Dependencies

依赖模型、导入与同步接口；可先制作无真实写入的交互原型。

## Shared contracts

遵循父任务已确认的平台范围：Windows、macOS本机及WSL；SSH延后。复用环境/Home解析，按目标平台处理路径、CLI参数、链接与复制及主题交互，详细矩阵见父任务design.md的Supported platforms。

遵循 ../09-10-mcp-skill-management/design.md 的统一模型、文件所有权、作用域和UI约束；证据见父任务research.md。不复制另一子任务实现。

## Acceptance and limits

实际应用状态可见；切换目标不显示陈旧数据；主题/中英文/键盘/窄窗一致；不要求维护多格式；导入失败不会显示全部成功。

父任务产品范围已确认，CLI兼容实验仍需完成；本文为待审阅设计，不代表最终实施批准。
