# 修复 PR #284 多行启动命令 P2 问题

## 目标

修复 PR #284 审查确认的三项问题，并推送至 `ushaio/CLI-Manager:feat/edit-terminal-startup-command`。用户已批准创建任务、执行修复及推送，变更记录归入 V1.4.4。

## 已确认事实与根因

- P2-1：`startupCommandText.ts:52` 把行尾字符直接当续行符删除，未区分转义对和引号中的字面字符；Bash 字面 `\\` 被改成 `\` 后会进入交互续行状态。
- P2-2：`terminalLaunch.ts:512` 的 SSH 启动设置 `startupHandledByLaunch=true`，绕过 PTY 格式化器，远端收到未拼接的多行文本。
- P2-3：`scripts/codexHookIsolation.test.mjs:16` 的 VM 测试加载器只提取函数，未加载新增的真实拼接依赖，导致主分支通过的测试在 PR 中报 ReferenceError。
- 修复位于命令文本解析和启动编排边界，不改 PTY 传输、持久化格式或远端脚本执行机制。

## 要求与验收

1. 本地各 Shell 保留成对转义字符和受保护的引号内容；真正的行尾续行符仍能被移除。测试覆盖偶数/奇数符号串及单行回归。
2. SSH 项目发送结构化 `sshLaunch.startupCommand` 前使用相同拼接规则；本地和远端都能拼接无续行符的多行参数，保留 Codex 的 `--no-daemon` 隔离。
3. Codex VM 测试加载真实拼接依赖，断言实际格式化输出和 SSH 启动计划，避免只通过源码正则判断行为。
4. 定向回归、TypeScript、独立架构检查及严格零超限检查通过；提交前执行 GitNexus 变更范围检查。
5. 更新 `CHANGELOG.md`、`docs/功能清单.md` 与相关契约，提交并普通推送到原 PR 分支，确认远端提交一致。

## 范围外

- 不改变“多行是一条命令”的约定，不实现多语句脚本或 heredoc 解析。
- 不改变外部终端、SSH 主机初始化脚本、数据库结构、IPC 类型或用户界面文案。
- 不操作主工作区其他任务，不合并 PR，不强制推送。
