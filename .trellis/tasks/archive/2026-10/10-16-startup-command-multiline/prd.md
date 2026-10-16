# 编辑终端启动命令支持多行输入

## Goal

「编辑终端」弹窗（`ConfigModal`）的「启动命令」字段支持输入多行文本；启动终端时，多行文本按 Shell 语法自动拼接为**同一条命令**再送入终端，使「带续行的长命令」（典型场景：多组 `-L` 端口转发的 `ssh`）能一次正确执行。

## Background

用户实测反馈：

> 当前无法多行输入，如我想在终端执行一个带有换行的命令一起执行，当前效果就全部显示在了一行，导致报错：
> `D:\Projects\xxx-xxx>ssh -p 22\   -L 123:127.0.0.1:1234\   -L 1111:127.0.0.1:1234 \   -L 1234:127.0.0.1:1234\   root@xxx.xxx.xxx.xxx`
> `hostname contains invalid characters`

直接根因：该字段渲染为单行 `<Input type="text">`（`src/features/projects/components/ConfigModal.tsx:1655`）。HTML `input` 的 value 不允许换行，浏览器在输入/赋值阶段就丢弃 `\n`，因此多行文本在进入 `startupCmd` state 之前已被压成一行，后续无论保存还是送入 PTY 都只剩一行。

## Requirements

- **R1** 「启动命令」字段改为多行可编辑控件，保留用户输入的换行。
- **R2** 保存与回填保持多行原样（不再被压成一行），重新打开弹窗可继续编辑。
- **R3** 启动终端时，多行文本按 Shell 语法拼接为**同一条命令**后写入 PTY；不引入「多行 = 多条命令依次执行」的语义。
- **R4** 续行符按目标 Shell 去除行尾续行符（PowerShell/pwsh 反引号、CMD `^`、Bash/WSL/Git Bash 反斜杠），其余行以单个空格拼接。Shell 未知时三种续行符都去除。
- **R5** 单行命令行为完全不变（零回归）。
- **R6** 新增/变更的用户可见文案必须 `zh-CN` 与 `en-US` 同步。

## Non-Goals

- 不改动其它写 `startup_cmd` 的入口（会话保存到侧栏、命令面板等）。
- 不改动「外部终端」（cmd / PowerShell 独立窗口）路径 `src-tauri/src/features/terminal/external_program.rs`。
- 不新增「多行 = 多条命令依次执行」模式。
- 不改数据库结构 / migrations / IPC 契约。

## Acceptance Criteria

- [ ] **AC1** 「编辑终端」弹窗「启动命令」可输入、粘贴多行；在 textarea 内按回车只换行，不提交表单。
- [ ] **AC2** 保存后重新打开弹窗，换行原样保留；落库值内部换行未被裁剪。
- [ ] **AC3** 多行 ssh 续行命令启动后，终端收到的是拼接成**一行**的一条命令并正确执行（不再出现参数被压坏）。
- [ ] **AC4** PowerShell 反引号 / CMD `^` / Bash 反斜杠三种续行符均被正确去除；**不加续行符**的多行也会被拼接成一行。
- [ ] **AC5** 原有单行命令（含 `cli_tool` 非空分支、`cli_tool` 为空但启动命令单行）行为不变。
- [ ] **AC6** 新增提示文案在 `zh-CN` / `en-US` 下均正确显示，且不出现中文残留。
- [ ] **AC7** `npx tsc --noEmit`、`node --test scripts/startupCommandMultiline.test.mjs`、`npm run check:architecture -- --strict` 全部通过。

## Notes

- 执行语义由用户确认：**整段作为一条命令（自动拼接续行）**。
- 改动范围由用户确认：**只改「编辑终端」弹窗的启动命令字段**。
- 技术设计见 `design.md`，执行计划见 `implement.md`。
