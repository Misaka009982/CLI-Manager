# 提交审阅

建议提交：`fix(terminal): 兼容跨平台剪贴板图片并提高附件上限`

单一任务涵盖 20 MiB/40M 附件预算、Windows PNG/DIB 回退及 V4/V5 偏移修正、macOS PNG/TIFF/Finder 读取、空 MIME 识别、后端真实内容验证与双语错误。

## 验证

13 项前端 + 8 项图片 Rust + 5 项 SSH 附件 Rust 测试通过；tsc、Windows cargo check、严格架构和 diff 空白检查通过。Mac Apple target 安装未完成，目标编译及实机仍需验证；远端 Snipaste 原始现场未取得，不能声称用户问题已实测解决。

## 文件

- `.trellis/spec/backend/index.md`
- `.trellis/spec/backend/terminal-clipboard-image-contracts.md`
- `.trellis/tasks/09-20-terminal-clipboard-image-compat/check.jsonl`
- `.trellis/tasks/09-20-terminal-clipboard-image-compat/delivery.md`
- `.trellis/tasks/09-20-terminal-clipboard-image-compat/design.md`
- `.trellis/tasks/09-20-terminal-clipboard-image-compat/implement.jsonl`
- `.trellis/tasks/09-20-terminal-clipboard-image-compat/implement.md`
- `.trellis/tasks/09-20-terminal-clipboard-image-compat/prd.md`
- `.trellis/tasks/09-20-terminal-clipboard-image-compat/research/findings.md`
- `.trellis/tasks/09-20-terminal-clipboard-image-compat/research/macos-check/.gitignore`
- `.trellis/tasks/09-20-terminal-clipboard-image-compat/research/macos-check/Cargo.lock`
- `.trellis/tasks/09-20-terminal-clipboard-image-compat/research/macos-check/Cargo.toml`
- `.trellis/tasks/09-20-terminal-clipboard-image-compat/research/macos-check/lib.rs`
- `.trellis/tasks/09-20-terminal-clipboard-image-compat/task.json`
- `CHANGELOG.md`
- `docs/功能清单.md`
- `scripts/terminalClipboardImage.test.mjs`
- `src-tauri/Cargo.lock`
- `src-tauri/Cargo.toml`
- `src-tauri/src/features/files/commands.rs`
- `src-tauri/src/features/files/commands/clipboard_dib.rs`
- `src-tauri/src/features/files/commands/clipboard_files.rs`
- `src-tauri/src/features/files/commands/clipboard_image.rs`
- `src-tauri/src/features/files/commands/clipboard_image_macos.rs`
- `src-tauri/src/features/files/commands/clipboard_image_tests.rs`
- `src-tauri/src/features/files/commands/clipboard_image_windows.rs`
- `src-tauri/src/lib.rs`
- `src/features/terminal/hooks/useTerminalInput.ts`
- `src/features/terminal/lib/terminalClipboardImage.ts`
- `src/features/terminal/lib/terminalClipboardRead.ts`
- `src/shared/i18n/messages/terminal.en-US.ts`
- `src/shared/i18n/messages/terminal.zh-CN.ts`

未识别的脏文件：无。
