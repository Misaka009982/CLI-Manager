# Implementation

1. [x] 分支只读检查、用户执行授权、V1.4.4 确认。
2. [x] 契约、初始化链路、复用入口和 upstream impact。
3. [x] 审阅规划并激活任务，固定依赖和共享初始化。
4. [x] 两端接线，统一 Unicode 11 构建回退。
5. [x] 真实 xterm 回归：表格、分块、ANSI、reset、屏切换、resize、回放。
6. [x] 备份并仅修改本机 Pi fullscreenScrollbar，验证官方 ScrollView。
7. [x] 契约、CHANGELOG、功能清单；按用户要求删除独立兼容说明文档并清理引用。
8. [x] 定向终端测试、npx tsc --noEmit、npm run web:typecheck、两端构建。
9. [x] 独立 npm run check:architecture -- --strict，diff 与范围复核。
10. [x] 记录结果和人工清单，不启动 CLI-Manager 服务/Tauri 应用。

## Manual validation
- 用户于 2026-10-16 确认验证完成并授权提交；以下为此前提供的验证清单。
- Pi/Claude/Codex emoji 表格、编辑光标、选择复制、中文输入。
- 桌面/Web 镜像与接管、resize、重连回放。
- 普通/全屏/深层分屏无新增空白；背景透明、blur/darken/fit/position。
- Pi always 不遮右列；背景开关下滑块字符连续性分别确认。
- 两端 Unicode 11 回退构建重开终端后生效。

## Constraints
不在已解析 buffer 切换 provider；保留 Web query suppression。
不将 buffer 验证冒充像素验收；Pi 配置和备份不入库，不改无关依赖。
