# MCP/Skills 全局管理界面

## Goal

V1.4.0 首要交付：全局 MCP/Skills 一处维护、各 CLI 使用，落实父任务 ../09-10-mcp-skill-management/prd.md 的 R2、R8，并组合模型/导入/同步形成完整工作流。不依赖项目接管/隔离成功。

## Requirements

- 纳入父任务R10：Skills页从GitHub安装向导，支持地址、ref/子目录、候选选择、目标与版本确认、进度/取消、逐项结果；不提供市场搜索和自动更新。

- settings只挂载extensions入口；环境/Home选择，MCP/Skills页签、共用资源行、独立CLI开关、统一JSON高级编辑、导入向导和逐项目标结果。
- 依赖模型、导入与同步接口；可先制作无真实写入的交互原型。

## Acceptance Criteria

- [ ] 实际应用状态可见；切换目标不显示陈旧数据；主题/中英文/键盘/窄窗一致；不要求维护多格式；导入失败不会显示全部成功。
- [ ] 一处编辑资源后向用户所选 CLI 投影/同步，记录逐目标成功/失败；某 CLI 项目能力不支持不影响全局管理入口或流程。原生不兼容字段显式提示，不宣称完全无差异兼容。
- [ ] 满足父任务对应要求与跨层验收。

## Planning status

V1.4.0平台范围已确认：Windows与macOS本机、Windows下WSL均必须支持；SSH远端管理延后。对应功能须逐平台验收，不得以Windows单平台通过代替macOS/WSL验证。

本子任务已按父任务顺序进入实现；全局页已接入 canonical MCP 开关、能力投影预览、Skill 源包/安装状态、导入与 GitHub 部署向导。MCP 原生文件整文件写入仍遵循父任务“不自动回写原 Home”的边界，由后续 CLI-Manager 启动快照接入实际会话应用。
