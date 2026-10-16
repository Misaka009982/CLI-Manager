# 多行启动命令契约

## 1. Scope / Trigger

修改启动命令输入、续行拼接、启动准备或 PTY 格式化时适用。多行是同一条命令的参数排版，不是多语句脚本。

## 2. Signatures

- `joinStartupCommandLines(command: string, shell?: ShellKey | null): string`
- `prepareStartupCommandForPty(command: string | undefined, shell: ShellKey | null): string | undefined`
- `formatStartupInputForPty(command: string, shell?: ShellKey | null): string`
- SSH 计划继续使用 `sshLaunch.startupCommand: string | null`；数据库 `startup_cmd` 原文保持多行，不新增 IPC/存储字段。

## 3. Contracts

- 无 CR/LF 的输入逐字节返回。多行 trim 后丢弃空行，以一个空格连接；不支持脚本、heredoc 或保留引号内的字面换行。
- PowerShell/pwsh、CMD、Bash 家族分别识别反引号、`^`、反斜杠。原生行尾转义串偶数个完整保留，奇数个只移除最后一个；不能把字面双反斜杠改成单反斜杠。
- Bash/PowerShell 单引号和 CMD 双引号中的符号按字面保留。仅跟踪基本引号/转义边界，不宣称支持完整 Shell 语法树。
- 引号外独立的单个候选支持跨 Shell 续行。未知 Shell 仅用这个保守规则，不删除连写路径尾部。
- 共同准备阶段先拼接，再追加 Codex 参数，保证 `startupHandledByLaunch=true` 的 SSH 项目也覆盖。PTY 格式化仍兼容手动直接调用及旧快照延迟重放，并只附一个回车。
- SSH 主机 `initializationCommand` 是独立脚本，不能套用命令拼接。外部终端继续原有原生脚本处理。

## 4. Validation & Error Matrix

| 输入/入口 | 结果 |
| --- | --- |
| `npm`、`run`、`dev` 分三行 | 本地/SSH 都执行 `npm run dev` |
| Bash 字面双反斜杠位于最后一行 | 保留两个符号，不进入意外续行等待 |
| 原生符号重复三次 | 保留一对，移除未配对的续行符 |
| CMD/未知 Shell 的路径尾部反斜杠 | 保留路径末尾 |
| 再处理已规范化结果 | 不重复删符号或追加隔离参数 |

## 5. Good/Base/Bad Cases

- Good：编辑时保存多行；启动准备后 SSH 计划与本地 PTY 使用同一条命令。
- Base：既有单行、Codex resume/provider 参数和项目环境维持原行为。
- Bad：只在 PTY 最后写入时拼接，遗漏 SSH bootstrap；只看行尾字符而误删转义对。

## 6. Tests Required

`node --test scripts/startupCommandMultiline.test.mjs scripts/codexHookIsolation.test.mjs scripts/deepseekTuiRuntime.test.mjs scripts/resumeCliArgs.test.mjs`

断言各 Shell 的奇偶转义串、基本引号、未知 Shell 路径、单行幂等、实际 PTY 回车/Codex 前缀，以及结构化 SSH 计划。VM 测试执行真实拼接依赖，不用源码正则代替行为验证。补 `npx tsc --noEmit` 和独立严格架构检查。

## 7. Wrong vs Correct

- Wrong：对每行的最后一个反斜杠无条件 `slice(0, -1)`。
- Correct：先判断原生转义串奇偶与引号状态，确认是续行符后才移除；共享启动准备先规范化，PTY 最后格式化兼容旧入口。
