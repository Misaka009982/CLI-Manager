# 技术设计：编辑终端启动命令支持多行输入

## 1. 根因陈述（fix-triage §4.1）

「启动命令」字段被渲染为**单行** HTML `<Input type="text">`（`src/features/projects/components/ConfigModal.tsx:1655`，经由同文件 `1633-1666` 的 `Field` 组件）。
HTML `input` 元素的 `value` 语义上不允许换行字符，浏览器在 setter 与用户输入两条路径上都会丢弃 `\n`。
因此多行文本**在进入 `startupCmd` state 之前就已经被压成一行**；保存链路（`ConfigModal.tsx:479` → `:513`/`:533`）与写入链路（`formatStartupInputForPty`）拿到的本来就是一行。

这是「表现层控件选型错误」+「执行语义缺失」的复合缺陷：即使把控件换成 textarea，若不定义多行如何送入终端，多行文本会被 PTY 逐行解释（换行等价回车），第一行就会提前执行，用户的 ssh 续行命令依然会断。

判定：走**根因修复**（行为性 + 跨边界），不做症状处补丁。

## 2. 链路与发现清单（fix-triage §4.3）

### 2.1 写入链路（启动命令如何到达终端）

```
ConfigModal.startupCmd ──save──▶ projects.startup_cmd (SQLite TEXT)
                                      │
            resolveProjectStartupCommand()  src/features/projects/api/projectStartupCommand.ts:194-214
                                      │
                formatStartupInputForPty(command, shell)  src/features/terminal/lib/terminalLaunch.ts:201-204
                                      │
                        terminalProcessManager.write(sessionId, payload)
                                      │
                        PtyHostSocket.write()  src/features/terminal/transport/PtyHostSocket.ts:248
                                      │  （daemon 协议按 UTF-8 原样传输，见 src-tauri/src/infrastructure/daemon/protocol.rs:87）
                                   ConPTY ──▶ PowerShell / CMD / WSL / Git Bash
```

`formatStartupInputForPty` 调用点（全部经由该函数，是唯一收口）：

- `src/features/terminal/store/terminalStore.ts:420`（远端 SSH handoff 恢复）
- `src/features/terminal/store/terminalStore.ts:625`（主启动路径）
- `src/features/terminal/store/terminalStore.ts:1080`（分屏 split）
- `src/features/terminal/store/terminalStore.ts:1705`（detach/新会话）
- `src/features/terminal/hooks/useXTermController.ts:1131`（`deferStartupUntilInitialOutput` 延迟启动）
- 间接：`formatManualDirectCodexInputForPty`（`terminalLaunch.ts:206-208`）→ 转发到同一函数

结论：**在 `formatStartupInputForPty` 内收口**即可覆盖全部启动路径（含分屏、延迟启动、SSH handoff、会话恢复），无需逐点改动。

### 2.2 读取与展示链路

- `ConfigModal.tsx:175` `useState(cloneFrom?.startup_cmd ?? project?.startup_cmd ?? "")` —— 直接回填，保留多行。
- `src/features/terminal/lib/terminalStatus.ts:144-151` `summarizeStartupCmd()` 已做 `.replace(/\s+/g, " ").trim()` 并截断 120 字符 —— 多行天然被压平为单行摘要，**无需改动**。
- `src-tauri/src/features/terminal/*` 的 `trimmed_startup_cmd` / `external_program.rs` 属「外部终端」路径，本次**不改**（Non-Goal）。

### 2.3 不构成风险的点

- `startupCmd.trim()`（`ConfigModal.tsx:479`）只裁剪首尾空白，**内部换行原样落库**，保存链路无需改动。
- SQLite 侧 `startup_cmd TEXT NOT NULL DEFAULT ''`（`src-tauri/src/app/migrations.rs:858`）无长度/格式约束。
- `detectCliResumeKind` / `isDirectCodexStartupCommand` 等正则含 `\s` 分支，可跨行匹配；拼接后仍是合法单行。

## 3. 设计决策

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 多行语义 = **整段作为一条命令**，自动拼接续行（用户确认） | 用户场景是「一条带续行的长命令」；避免「多行=多语句」把 ssh 参数拆成多条命令 |
| D2 | 拼接在 `formatStartupInputForPty` 内收口，而非保存时拼接 | 保存必须保留多行以便再次编辑；运行期才需要单行；且该函数是唯一收口点（覆盖分屏/延迟/SSH/恢复） |
| D3 | 纯函数独立成 `src/features/terminal/lib/startupCommandText.ts` | 无 React 依赖，可被 `node --test` 直接导入测试；避免继续膨胀 `terminalLaunch.ts`（已 856 行） |
| D4 | 新增 `FieldTextarea` 组件，**不改** `Field` | `Field` 有 3 处调用（`:660` 项目名含 `inputRef`、`:808`、`:869`），其 `inputRef` 类型为 `Ref<HTMLInputElement>`；为 textarea 改签名会波及无关字段。新增独立组件风险最低 |
| D5 | 续行符按 `ShellKey` 映射；Shell 未知时三种都去 | `ShellKey` 联合类型已枚举全部支持的 Shell（`src/shared/platform/shell.ts:3-7`）；未知时不猜，尽可能容错 |
| D6 | 行内裁剪：每行 `trim()` 后以**单个空格**拼接 | Shell 词法里行首/行尾空白与多空格等价（引号外），裁剪不改变语义，且让拼接结果干净、便于摘要展示 |
| D7 | 只改「编辑终端」弹窗 + 其启动写入收口 | 用户确认范围；其它写 `startup_cmd` 的入口无需改动即可受益于 D2（写入收口是运行期的） |
| D8 | 新增一行提示文案（i18n 双语） | 自动拼接语义不可见，用户无法从 UI 推断；不写提示会变成隐式行为 |

## 4. 纯函数规格

新增 `src/features/terminal/lib/startupCommandText.ts`：

```ts
import type { ShellKey } from "../../../shared/platform/shell";

// 各 Shell 的行续接字符；未列出的（未知/空）走 ALL 分支。
const SHELL_STARTUP_CONTINUATION: Partial<Record<ShellKey, string>> = {
  powershell: "`",
  pwsh: "`",
  cmd: "^",
  wsl: "\\",
  gitbash: "\\",
  bash: "\\",
  zsh: "\\",
  sh: "\\",
  fish: "\\",
};

const ALL_STARTUP_CONTINUATION_CHARS = ["`", "^", "\\"];

export function startupCommandContinuationChars(shell?: ShellKey | null): string[] {
  const shellChar = shell ? SHELL_STARTUP_CONTINUATION[shell] : undefined;
  return shellChar ? [shellChar] : ALL_STARTUP_CONTINUATION_CHARS;
}

/** 多行启动命令按 Shell 语法拼接为同一条命令；单行输入原样返回（零回归）。 */
export function joinStartupCommandLines(command: string, shell?: ShellKey | null): string {
  if (!/[\r\n]/u.test(command)) return command;
  const continuationChars = startupCommandContinuationChars(shell);
  const segments: string[] = [];
  for (const rawLine of command.split(/\r\n|\r|\n/u)) {
    let line = rawLine.trim();
    if (!line) continue;
    const tail = line.slice(-1);
    if (continuationChars.includes(tail)) line = line.slice(0, -1).trimEnd();
    if (line) segments.push(line);
  }
  return segments.join(" ");
}
```

### 4.1 接入点（`src/features/terminal/lib/terminalLaunch.ts:201-204`）

改造前：

```ts
export function formatStartupInputForPty(command: string, _shell?: ShellKey | null): string {
  if (!isDirectCodexStartupCommand(command)) return `${command}\r`;
  return `${buildDirectCodexLaunchCommand(command)}\r`;
}
```

改造后（`_shell` 从「未使用」变为「参与拼接」，签名兼容）：

```ts
export function formatStartupInputForPty(command: string, shell?: ShellKey | null): string {
  const singleLine = joinStartupCommandLines(command, shell ?? null);
  if (!isDirectCodexStartupCommand(singleLine)) return `${singleLine}\r`;
  return `${buildDirectCodexLaunchCommand(singleLine)}\r`;
}
```

注意顺序：**先拼接、后判定** `isDirectCodexStartupCommand`，否则多行的 `codex ...` 命令无法被识别为直启并正确加 `\x0c` 前缀。

## 5. 边界与已知限制

| 场景 | 行为 | 判定 |
|---|---|---|
| 单行命令 | 原样返回，行为与改动前逐字节一致 | ✅ 零回归（R5） |
| 多行 + 行尾续行符（PowerShell `` ` `` / CMD `^` / Bash `\`） | 去续行符后单空格拼接 → 一条命令 | ✅ 目标场景 |
| 多行 + 无续行符 | 单空格拼接 → 一条命令 | ✅ 目标场景（用户明确要求自动拼接） |
| `CRLF` / 单独 `CR` 换行 | `split(/\r\n|\r|\n/)` 统一处理 | ✅ |
| 空行 / 纯空白行 | 丢弃 | ✅ |
| 行尾真正的路径反斜杠（`C:\`）在 Bash-family 下 | 会被当续行符去掉；该字符在 Bash 里本义即续行符，语义一致。PowerShell 下不触发（只认反引号） | ⚠️ 已知、可接受 |
| 跨行引号内的字面空白，如 `-m "a` / `b"` | 会被裁剪为 `-m "a b"`；引号外空白本无意义，引号内跨行空白通常正是想消除的 | ⚠️ 已知、可接受，写入 design 记录 |
| 连续续行符（Bash `\\`） | 只去掉**一个**行尾字符 | ⚠️ 已知；`\\` 在 Bash 中为字面反斜杠，保留一个更接近原义 |
| 全空白多行输入（`"\n\n"`） | 返回 `""`，调用方写入一个裸 `\r`（空回车，无害）；`launch.startupCmd` 的 truthy 判定不受影响 | ✅ |
| Shell 未知 / `null` | 三种续行符都去 | ✅ 容错 |

## 6. 场景维度枚举（fix-triage §5）

| 维度 | 是否受影响 | 结论 |
|---|---|---|
| 运行时环境：PowerShell / pwsh | 是 | 反引号续行符映射；默认 shell |
| 运行时环境：CMD | 是 | `^` 续行符映射 |
| 运行时环境：WSL / Git Bash / bash / zsh / sh / fish | 是 | `\` 续行符映射 |
| 运行时环境：未知 shell | 是 | 三种全去（容错分支） |
| 窗口焦点 / 分屏（split） | 是（共用写入收口） | `terminalStore.ts:1080` 走同一函数，自动覆盖 |
| 延迟启动 `deferStartupUntilInitialOutput` | 是（共用写入收口） | `useXTermController.ts:1131` 走同一函数，自动覆盖 |
| 多会话 / detach / 远端 SSH handoff | 是（共用写入收口） | `terminalStore.ts:420`/`:1705` 走同一函数，自动覆盖 |
| 最小化到托盘 / UI 展示模式（侧栏展开折叠）/ 焦点模式 | 否 | 与命令文本无关 |
| Worktree（含 `.git` 为文件） | 否 | 与启动命令文本无关 |
| CLI Hook 装没装 | 否 | Hook 只影响通知与统计，不影响启动命令写入 |
| 「外部终端」（独立 cmd/PowerShell 窗口） | **明确排除** | `external_program.rs:146`/`:151` 路径本次不改（Non-Goal） |
| 「编辑终端」弹窗内 `cli_tool` 非空 | 否 | 该字段仅在 `cliTool.trim() === ""` 时渲染（`ConfigModal.tsx:868`），保存时仍会清空 |
| 会话保存到侧栏 / 命令面板等其它入口 | 否（只读同一字段） | 本次不改这些入口；其写入值同样经过运行期收口 |

## 7. UI 设计

`ConfigModal.tsx:868-870` 当前：

```tsx
{cliTool.trim() === "" && (
  <Field label={t("configModal.startupCommand")} value={startupCmd} onChange={setStartupCmd} placeholder="npm run dev" />
)}
```

改为多行字段（沿用 `envVars` 已有的 `Textarea` 用法 `ConfigModal.tsx:912-919`）：

```tsx
{cliTool.trim() === "" && (
  <FieldTextarea
    id={startupCmdFieldId}
    label={t("configModal.startupCommand")}
    value={startupCmd}
    onChange={setStartupCmd}
    placeholder="npm run dev"
    hint={t("configModal.startupCommandMultilineHint")}
  />
)}
```

新增组件（与 `Field`（`1633-1666`）同构，仅控件与 `hint` 不同）：

```tsx
function FieldTextarea({ id, label, value, onChange, placeholder, hint }: {
  id?: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="ui-config-form-label">{label}</label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        spellCheck={false}
        className="min-h-20 resize-y font-mono text-sm leading-5"
      />
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-text-muted">{hint}</p>}
    </div>
  );
}
```

要点：

- 表单为 `<form onSubmit={handleSubmit}>`（`ConfigModal.tsx:624`），textarea 内回车默认只换行、不提交 —— 满足 AC1。
- `id` 与 `<label htmlFor>` 关联：原 `Field` 在该字段未传 `id`，label 与控件无关联；本次补上（与 `envVarsFieldId` 同模式），属同字段的必要修正。
- `rows={3}` + `min-h-20` + `resize-y`：默认 3 行、可纵向拖拽放大，避免弹窗被长命令撑爆。
- `spellCheck={false}` + `font-mono`：与 `envVars`、命令行字段一致。

### i18n 文案

`src/shared/i18n/messages/projects.zh-CN.ts`（在 `191` 行 `configModal.startupCommand` 之后插入）：

```
"configModal.startupCommandMultilineHint": "支持多行输入；换行与行尾续行符（PowerShell 反引号 / CMD ^ / Bash 反斜杠）会被拼接为同一条命令后执行。",
```

`src/shared/i18n/messages/projects.en-US.ts`（在 `193` 行之后插入）：

```
"configModal.startupCommandMultilineHint": "Multi-line supported. Line breaks and trailing continuation characters are joined into a single command before it runs.",
```

## 8. 验证策略

| 层级 | 命令 | 覆盖 |
|---|---|---|
| 类型 | `npx tsc --noEmit` | 新模块类型、`Textarea` 用法、i18n key 联合类型 |
| 单元 | `node --test scripts/startupCommandMultiline.test.mjs` | `joinStartupCommandLines` 的续行符/换行/幂等/回归分支 |
| 架构 | `npm run check:architecture -- --strict` | 新文件归属 `features/*/lib`、行数、无超限 |
| 手工 | 编辑终端 → 多行 ssh → 保存 → 重开 → 启动 | AC1–AC6 |

新增测试 `scripts/startupCommandMultiline.test.mjs`（沿用 `scripts/configModalShellPrefill.test.mjs` 的 `node:test` + 直接导入 `.ts` 约定）：

- 单行输入原样返回（含首尾空格保留）。
- 多行 + 无续行符 → 单空格拼接。
- PowerShell 反引号续行符被去除（`shell="powershell"`）。
- CMD `^` 续行符被去除（`shell="cmd"`）。
- Bash `\` 续行符被去除（`shell="bash"` / `"wsl"` / `"gitbash"`）。
- 空行被丢弃；`CRLF` 与 `CR` 均被处理。
- shell 未知（`null`/`undefined`）时三种续行符都去。
- 幂等：对单行结果再次调用结果不变。
- 回归：`formatStartupInputForPty("npm run dev", "powershell")` 仍为 `"npm run dev\r"`。

## 9. 回滚

无数据库结构、migration、IPC 契约、持久化协议变更，回滚为**纯代码回滚**：

- 删除 `src/features/terminal/lib/startupCommandText.ts`、`scripts/startupCommandMultiline.test.mjs`；
- 还原 `src/features/terminal/lib/terminalLaunch.ts`、`src/features/projects/components/ConfigModal.tsx`、两个 i18n 文件。

数据库中由本次功能写入的多行 `startup_cmd` 值在回滚后**不会损坏**：回滚后多行会按旧行为原样送入 PTY（等同改动前），用户可手工改回单行。
