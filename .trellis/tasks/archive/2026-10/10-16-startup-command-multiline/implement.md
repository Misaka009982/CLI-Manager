# 实施与验收

## 步骤

1. 读取前端架构契约（`ai-architecture-contracts.md`、`directory-structure.md`、`quality-guidelines.md`、`type-safety.md`）与终端启动链路入口；复核 `formatStartupInputForPty` 的全部调用点与 `ConfigModal` 的字段/保存路径。
2. 新增纯函数模块 `src/features/terminal/lib/startupCommandText.ts`：`startupCommandContinuationChars` / `joinStartupCommandLines`，无 React 依赖，可被 `node --test` 直接导入。
3. 在 `src/features/terminal/lib/terminalLaunch.ts` 的 `formatStartupInputForPty` 内收口（先拼接、后判定 `isDirectCodexStartupCommand`），`_shell` 参数转为实际使用、签名保持兼容。这是启动命令写入 PTY 的唯一收口点，覆盖主启动、分屏、延迟启动、SSH handoff 与会话恢复。
4. 在 `src/features/projects/components/ConfigModal.tsx` 新增 `FieldTextarea` 组件（不改动 `Field`，避免波及项目名等 3 处调用），并把「启动命令」字段（`:868-870`）切到该组件；补 `id` + `htmlFor` 关联。
5. 同步 `zh-CN` / `en-US` 文案：新增 `configModal.startupCommandMultilineHint`。
6. 新增回归测试 `scripts/startupCommandMultiline.test.mjs`（`node:test` + 直接导入 `.ts`，沿用 `scripts/configModalShellPrefill.test.mjs` 约定），覆盖续行符/换行/空行/幂等/单行零回归。
7. 运行验证：`node --test scripts/startupCommandMultiline.test.mjs`、`npx tsc --noEmit`、`npm run check:architecture -- --strict`、`git diff --check`，并把结果写入 `verification.md`。
8. 更新 `CHANGELOG.md` 与 `docs/功能清单.md`（版本号按用户指定，未指定时询问；仍无则用 `TEMP`）。
9. 手工验收由用户在「编辑终端」弹窗执行（AC1–AC6）：多行 ssh 续行命令保存 → 重开保留换行 → 启动后作为一条命令正确执行；并切换中英文确认提示文案。

## 执行方式

用户在诊断方案后已确认两项硬约束：**语义 = 整段作为一条命令（自动拼接续行）**、**范围 = 只改「编辑终端」弹窗的启动命令字段**，并批准创建本 Trellis 任务。

Trellis 配置为 inline；项目未提供对应 Trellis skills，按真实契约和本计划在主会话执行，不自动分派子代理。

## 范围外（不做）

- 不改其它写 `startup_cmd` 的入口（会话保存到侧栏、命令面板等）；它们经同一运行期收口自动受益。
- 不改「外部终端」路径（`src-tauri/src/features/terminal/external_program.rs`）。
- 不新增「多行 = 多条命令依次执行」模式。
- 不改数据库结构 / migrations / IPC 契约，不需要 Rust 改动。
