# MCP/Skills 统一模型与 CLI 格式适配

## Goal

V1.4.0 统一模型与格式适配，落实父任务 ../09-10-mcp-skill-management/prd.md 的 R1、R9。

## Requirements

- 版本化JSON为唯一MCP权威；规范headers/env/timeout/transport，保留perCliExtensions；定义SQLx实体、脱敏DTO、能力矩阵和字段级投影。
- 无前置实现依赖；先验证三个CLI版本和项目隔离能力。

## Acceptance Criteria

- [ ] 同一资源三CLI输出读回语义一致；不支持字段显式报错；无秘密泄漏；无关配置不变。
- [ ] 满足父任务对应要求与跨层验收。

## Planning status

V1.4.0平台范围已确认：Windows与macOS本机、Windows下WSL均必须支持；SSH远端管理延后。对应功能须逐平台验收，不得以Windows单平台通过代替macOS/WSL验证。

当前planning，产品范围已确认；保留父任务技术验证关卡，未经审阅不开始实现。
