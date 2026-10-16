# 验证记录

## 范围与根因

「编辑终端」弹窗的「启动命令」字段原本渲染为单行 HTML `<Input type="text">`（`src/features/projects/components/ConfigModal.tsx` 原 `:1655`，经原 `Field`（原 `:1633-1666`））。

`input` 元素的 `value` 不允许换行，浏览器在用户输入与程序赋值两条路径上都会丢弃 `\n`，因此多行文本**在进入 `startupCmd` state 之前就被压成一行**，保存链路与写入链路拿到的本来就是一行。控件选型是直接根因；执行语义缺失是第二层根因——若不定义多行如何送入终端，换行会被 PTY 当作回车逐行执行，`ssh` 多组 `-L` 这类续行命令会被拆断。

发现清单已在 design.md 记录：控件选型、写入唯一收口点 `formatStartupInputForPty`、保存链路的 `trim()` 语义、Codex 直启判定顺序、续行符按 Shell 映射、i18n 双语落点、外部终端路径排除。数据库结构、IPC 契约与 Rust 后端经核查无关。

## 已执行

- `node --test scripts/startupCommandMultiline.test.mjs`：11/11 通过。覆盖单行零回归（含首尾空白的逐字节保留）、无续行符多行的单空格拼接、PowerShell/pwsh 反引号、CMD `^`、Bash 家族（bash/zsh/sh/fish/wsl/gitbash）反斜杠、未知 Shell 三种符号全去、真实多行 `ssh -L` 命令拼接为单行且幂等、CRLF/CR/空行/纯空白输入、Bash 尾随路径反斜杠的已知限制，以及 `terminalLaunch.ts` 中「先拼接、后判直启」的接线回归。
- `npx tsc --noEmit`：退出 0。
- `npm run check:architecture -- --strict`：1341 个源码文件，0 超限、0 违规。
- `git diff --check`：退出 0（无空白错误）。

## 修正与工具边界

- 首次实现即通过上述全部检查，无编译失败或测试返工。
- 未运行 Rust 检查：本次无 Rust 改动（`startup_cmd` 仍为 TEXT 存储，写入侧在 daemon 协议层按 UTF-8 原样传输）。
- GitNexus MCP 工具未在本会话暴露，按 `.trellis/spec/*-contracts.md` 契约 + 定点 grep/read 降级定位。影响面以 design.md §2 的调用点清单人工复核（`terminalStore.ts:420`、`:625`、`:1080`、`:1705`，`useXTermController.ts:1131`，以及 `features/projects/api/projectStartupCommand.ts`），全部经由 `formatStartupInputForPty`，因此单点收口覆盖主启动、分屏、延迟启动、SSH handoff 与会话恢复全部路径。

## 未覆盖

- 未启动 Tauri 应用或前端 dev server（`.trellis/spec/frontend/quality-guidelines.md` 规定 AI 不得启动应用做运行时 UI 验证）。
- 需人工验收：
  1. 「编辑终端」弹窗「启动命令」可输入/粘贴多行；textarea 内按回车只换行、不提交表单。
  2. 保存后重新打开弹窗，换行原样保留。
  3. 多行 `ssh` 续行命令启动后，终端收到**一行**命令并正确执行，不再出现 `hostname contains invalid characters`。
  4. PowerShell 反引号 / CMD `^` / Bash 反斜杠三种续行符均被正确去除；不加续行符的多行也被拼成一行。
  5. 原单行命令（含 `cli_tool` 为空但启动命令单行）行为不变。
  6. 设置 → 通用 → 界面语言切换中英文，提示文案均正确、无中文残留，时间格式不因英文切换变成 12 小时制。
  7. 「外部终端」（独立 PowerShell/CMD 窗口）路径本次未改动；若该入口也需要多行拼接，需另开任务。

## 提交和交付

- 变更文件：`src/features/terminal/lib/startupCommandText.ts`（新增）、`src/features/terminal/lib/terminalLaunch.ts`、`src/features/projects/components/ConfigModal.tsx`、`src/shared/i18n/messages/projects.zh-CN.ts`、`src/shared/i18n/messages/projects.en-US.ts`、`scripts/startupCommandMultiline.test.mjs`（新增）、`CHANGELOG.md`、`docs/功能清单.md`，以及本任务目录。
- 工作区另有与本任务无关的未跟踪文件（`.workbuddy/`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`scripts/sidebarInformationArchitecture.test.mjs`、`.trellis/tasks/09-25-sidebar-information-architecture/`），不纳入本次提交。
- 版本归属：用户确认归入 `CHANGELOG.md` 的 `V1.4.4`。
- 已提交：`2168b1e8`（`feat(projects): support multi-line terminal startup command`），13 个文件、+620 / −5。
- 提交位置：分支 `feat/edit-terminal-startup-command`（基于 `f52b9bda`，即 `upstream/master`）。该分支为本地分支、无上游跟踪。
- 未推送：用户明确要求只提交到当前分支，不 push。
