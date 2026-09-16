# V1.4.0 全局管理界面执行计划

1. [x] 依赖模型、导入与同步接口；先完成无原生整文件写入的安全交互与投影预览，再接入真实 Skill 源存储和部署。
2. [x] 审阅父任务与本任务 PRD；读取领域规范并完成符号 impact，随后 start 本子任务。
3. [x] 接入 SettingsLayout、环境/Home、MCP/Skills 页签、搜索、编辑、导入、GitHub 和部署状态；运行 UI 定向检查与 tsc。
4. [x] 展示 canonical 开关、能力/目标路径、Skill 实际安装状态、请求/实际同步方式和逐项导入/GitHub 结果；切换环境/Home 使用请求序号丢弃过期状态，部分失败不显示为全成功。
   同时验证GitHub安装向导的候选选择、版本确认、取消/重试及部分失败反馈。
5. [x] 按父任务 implement.md 运行适用的类型/Rust/架构及跨层检查，更新 V1.4.0 代码交付记录。
6. [x] Windows 定向检查已完成；当前环境无可用 WSL 发行版且无 macOS 环境，跨平台实机验证保留为发布门禁；SSH 不在本任务范围。

## Review audit — 2026-09-11

- GitNexus 对新增 extension 符号返回 UNKNOWN（索引未覆盖新增文件），因此按现有 contracts、调用点和定向搜索完成影响追踪；SettingsModal 的已索引入口为 LOW 风险。共享 `LastSettingsTab` 迁移函数被报告为 CRITICAL（1 个直接依赖、269 个间接依赖、37 条流程），仅增加 extensions 白名单项并通过类型检查。
- 修复了高级编辑器在 `useMemo` 中写状态的问题，改为 `useEffect`；修复 CLI 开关别名可形成隐形键的问题；补充禁用目标投影、非 canonical CLI 键和本地化结果的测试/文案。
- MCP 原生文件不在全局页自动整文件回写范围内，页面明确标注为 canonical 投影预览；Skills 的源包发布、目标部署、卸载/恢复和 GitHub 固定 commit 安装使用既有安全管线。项目启动快照任务继续负责 CLI-Manager 会话的实际 MCP/Skills 注入。

失败仅恢复本任务有归属证据的输出；保留外部文件和活跃会话引用。
