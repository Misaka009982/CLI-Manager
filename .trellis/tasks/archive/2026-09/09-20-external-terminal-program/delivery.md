# 提交审阅

实现及定向检查完成，尚未提交或推送。三个任务共用设置页、字体设置和版本记录，计划作为一批终端修复提交。

## Proposed commit

`fix(terminal): 修复字体回退并支持外部终端程序选择`

覆盖用户已确认的 WSL 参数修复、用户字体优先与兼容历史配置、外部程序选择及相关验证和 V1.4.1 文档。

- `.trellis/spec/backend/wsl-path-contracts.md`
- `.trellis/spec/frontend/index.md`
- `.trellis/spec/frontend/terminal-font-external-program-contracts.md`
- `.trellis/tasks/09-20-external-terminal-program/check.jsonl`
- `.trellis/tasks/09-20-external-terminal-program/delivery.md`
- `.trellis/tasks/09-20-external-terminal-program/design.md`
- `.trellis/tasks/09-20-external-terminal-program/implement.jsonl`
- `.trellis/tasks/09-20-external-terminal-program/implement.md`
- `.trellis/tasks/09-20-external-terminal-program/prd.md`
- `.trellis/tasks/09-20-external-terminal-program/research/check-ui.mjs`
- `.trellis/tasks/09-20-external-terminal-program/research/ui-preview.html`
- `.trellis/tasks/09-20-external-terminal-program/research/ui-preview.tsx`
- `.trellis/tasks/09-20-external-terminal-program/task.json`
- `.trellis/tasks/09-20-fix-terminal-font-fallback/check.jsonl`
- `.trellis/tasks/09-20-fix-terminal-font-fallback/design.md`
- `.trellis/tasks/09-20-fix-terminal-font-fallback/implement.jsonl`
- `.trellis/tasks/09-20-fix-terminal-font-fallback/implement.md`
- `.trellis/tasks/09-20-fix-terminal-font-fallback/prd.md`
- `.trellis/tasks/09-20-fix-terminal-font-fallback/task.json`
- `.trellis/tasks/09-20-fix-wsl-external-terminal/check.jsonl`
- `.trellis/tasks/09-20-fix-wsl-external-terminal/design.md`
- `.trellis/tasks/09-20-fix-wsl-external-terminal/implement.jsonl`
- `.trellis/tasks/09-20-fix-wsl-external-terminal/implement.md`
- `.trellis/tasks/09-20-fix-wsl-external-terminal/prd.md`
- `.trellis/tasks/09-20-fix-wsl-external-terminal/task.json`
- `CHANGELOG.md`
- `docs/功能清单.md`
- `scripts/externalTerminalProgram.test.mjs`
- `scripts/systemFonts.test.mjs`
- `src-tauri/src/features/terminal/external_program.rs`
- `src-tauri/src/features/terminal/external_program_tests.rs`
- `src-tauri/src/features/terminal/shell_commands.rs`
- `src-tauri/src/infrastructure/pty/platform/windows.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/shared/windows_command_line.rs`
- `src/features/projects/hooks/useSidebarController.tsx`
- `src/features/settings/components/pages/ExternalTerminalProgramSetting.tsx`
- `src/features/settings/components/pages/ThemeSettingsPage.tsx`
- `src/features/sync/lib/syncSettings.ts`
- `src/features/terminal/api/externalTerminal.ts`
- `src/features/terminal/api/terminalFontFamily.ts`
- `src/features/terminal/hooks/useTerminalTabsController.tsx`
- `src/features/workspace/api/CommandPalette.tsx`
- `src/shared/i18n/messages/settings.en-US.ts`
- `src/shared/i18n/messages/settings.zh-CN.ts`
- `src/shared/lib/externalTerminalProgram.ts`
- `src/shared/platform/systemFonts.ts`
- `src/shared/preferences/settingsStore.ts`

未识别的工作区变更：无。

## 验证

25 项前端测试、14 项 Shell 测试及 1 项原 Windows 引用测试通过；tsc、cargo check、严格架构检查及 diff 空白检查通过。独立浏览器检查中英文设置组件与 CMD 选择，无运行时错误。

真实 WSL 发行版未安装；未执行完整 Tauri 设置页人工验收。用户 Maple Mono 字号和字重未知，清晰度差异尚未复现或定因。

## 空白窗口修复追加文件

- `src-tauri/src/features/terminal/external_console.rs`
- `src-tauri/src/features/terminal/external_console_tests.rs`
- `.trellis/tasks/09-20-external-terminal-program/research/blank-console.md`

新增真实控制台 6 组验证通过；原管道测试不能作为交互控制台可用的依据，已补齐。

## 用户验收

2026-09-20：用户确认验证完成，授权提交代码；不推送远程。空白窗口修复后 15 项 Rust 定向测试及独立 Windows 引用测试通过，严格架构 1163 文件零违规。
