# MCP/Skills 导入与 Skill 文件同步

## Goal

V1.4.0 导入与Skill同步，落实父任务 ../09-10-mcp-skill-management/prd.md 的 R3–R5、R9、R10。

## Requirements

- cc-switch只读schema适配，原生导入preview/apply；Skill完整包进入数据目录，auto/symlink/copy部署，所有权/哈希和备份恢复。
- 依赖extension-model-adapters的模型/目标身份/应用结果接口。
- 支持GitHub地址安装，选择ref/子目录与候选技能，安装完整包并记录commit与内容哈希；市场搜索和自动更新延后。

## Acceptance Criteria

- [ ] 重复导入幂等；同名异内容可处理；来源不修改；缺失源/失效链接有解释；外部修改不误删；链接权限失败按所选策略处理。
- [ ] 满足父任务对应要求与跨层验收。
- [ ] GitHub仓库/子目录、多Skill、ref含斜杠、重复安装、网络取消/失败及归档边界均验证；预览与安装锁定同一commit，不执行安装脚本。

## Planning status

V1.4.0平台范围已确认：Windows与macOS本机、Windows下WSL均必须支持；SSH远端管理延后。对应功能须逐平台验收，不得以Windows单平台通过代替macOS/WSL验证。

已按父任务范围进入实施并完成后端导入/同步闭环；产品范围与跨平台验证关卡保持不变。Windows 静态与定向测试已通过，当前环境无可用 WSL 发行版且无 macOS 环境，相关实际验证保留为交付缺项。
