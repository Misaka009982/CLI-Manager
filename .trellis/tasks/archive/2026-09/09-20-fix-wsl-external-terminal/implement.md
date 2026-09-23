# 实施与验证

- [x] 定位前端命令构建、IPC、后端进程参数与 WSL 路径工具。
- [x] 完成 push_tab_args 上游影响分析：LOW。
- [x] 用户批准实施且限定仅 WSL；激活任务并读取 trellis-before-dev 与相关规范。
- [x] 补充 WSL 专用参数分支与定向回归测试。
- [x] 检查多 tab、非默认发行版与命令引号/分号处理。
- [x] cargo test --lib commands::shell::tests：7/7 通过；cargo check 通过。
- [x] 独立运行 npm run check:architecture -- --strict：0 违规。
- [x] 检查运行环境：WSL 未安装，无法执行 Ubuntu/Windows Terminal 真实启动；已明确记录限制。
- [x] 按 V1.4.1 更新 CHANGELOG.md、docs/功能清单.md，并记录 WSL 外部终端契约。
- [x] trellis-check：rustfmt 与 diff 检查通过；非 WSL 分支源码逐字不变，未改 IPC/前端。

## 验证说明
- 首次 cargo test shell_commands --lib 因模块名称不同匹配 0 项，已改用真实模块 commands::shell::tests 完成 7 项测试，不以 0 项通过作为验收依据。
- GitNexus detect_changes 为 low；插入新函数导致旧索引按行号误标 Unix 函数 touched。Git diff 和基线文本对比确认这些函数未修改。
- 发现清单及根因见 design.md；无新增用户界面文案，不涉及界面语言切换。
- 未提交，等待按工作流确认提交计划；没有推送或更新应用版本字段。

风险集中在 shell_commands.rs 的 Windows 参数生成，保留其他 shell 分支；不进行 Git 同步、发布或升级 WSL。
