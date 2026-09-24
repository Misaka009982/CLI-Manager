# 实施计划

- [x] 已获用户授权，建立 PRD/设计；分支领先上游 5 提交。
- [x] 阅读领域契约并 impact；useTerminalInput LOW（直接 1、间接 3），Rust 符号索引缺失改用契约和定向搜索。
- [x] 后端统一图片预算、格式回退、PNG 标准化和 macOS 文件 URL。
- [x] 前端所有图片入口复用后端校验，错误反馈和 i18n。
- [x] 合成样例回归、类型/Rust/严格架构检查。
- [x] V1.4.1 双记录、契约与限制说明，提交审阅。

## 结果
- 13 项前端测试、8 项图片 Rust 测试、5 项 SSH 附件 Rust 测试通过；tsc、Windows cargo check、严格架构（1170 文件）与 git diff --check 通过。
- 修复经测试发现的 image 0.25.10 packed DIB V4/V5 像素偏移错误，详情见 research/findings.md。
- GitNexus detect_changes HIGH（14 个受影响流程）；命令注册/输入入口检查完成，未改变 PTY 或 SSH 协议。新模块人工审查。
- macOS 已按 objc2 真实 API 检查，但 Apple target 标准库下载未完成，目标编译和实机粘贴未验证；未在反馈用户的 Snipaste 环境复现。
- 中英文文案已更新，尚未人工切换完整 Tauri 设置页验收。
- 代码与 V1.4.1 双记录完成，等待用户验收/提交确认，不推送。
