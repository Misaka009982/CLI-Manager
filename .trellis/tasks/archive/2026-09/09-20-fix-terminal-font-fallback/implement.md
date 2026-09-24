# 实施计划

依赖：与 external-terminal-program 独立；都触及 ThemeSettingsPage 和变更记录，主会话顺序实施，禁止覆盖另一任务改动。已有 WSL 修复保留。

- [x] 根因、调用点、HIGH 影响范围已确认并报告。
- [x] prd/design/implement 已完成并收敛，等待方案审阅。
- [x] 用户批准后 task.py start，读取对应前端契约与 trellis-before-dev。
- [x] 对实际修改符号 impact；实现偏好清理、正确 token 解析和运行时回退。
- [x] 设置保存/选项匹配接入，预览/xterm 保持统一运行时。
- [x] node --test scripts/systemFonts.test.mjs 及新增字体行为测试。
- [x] npx tsc --noEmit；npm run check:architecture -- --strict。
- [x] 应用可用时手动验证多字体及中英文设置；环境不足如实记录。
- [x] V1.4.1 CHANGELOG.md / docs/功能清单.md 与字体契约同步，trellis-check。
- [x] git diff --check，GitNexus detect_changes，按工作流提交审阅。

验收重点：用户字体不被 CJK 比例字体抢先；旧完整自动尾部可恢复；手工自定义中文字体不误删；纯 monospace 仍优先等宽。

## 实施与验证结果（2026-09-20）

- 实现完成，等待提交确认；V1.4.1 两份记录已更新。
- 25 项前端定向测试、TypeScript、14 项 Shell 测试、原 Windows 参数引用测试、cargo check 通过；严格架构 1161 文件零违规。
- 独立浏览器挂载实际设置组件，中英文切换与 CMD 选择通过；字体不可用时等宽回退测量通过。尚未在完整 Tauri 设置流程进行人工切换验收。
- 未安装 WSL 发行版，真实 WSL 启动未复验；用户已确认前一轮 WSL 修复有效。Maple Mono 字号/字重未知，未宣称截图清晰度已解决。
- GitNexus detect_changes 标记 CRITICAL，主要源于全局设置入口关联 147 条流程；人工复核仅新增独立偏好字段，原平台分支保持。新文件另行审查。
- CMD 异种 Shell 使用编码 PowerShell 桥接，ProcessStartInfo 避免参数二次解析；既有 Windows CRT 引用函数原样移到 shared 复用。
