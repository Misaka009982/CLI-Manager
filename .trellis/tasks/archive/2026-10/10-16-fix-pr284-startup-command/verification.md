# 验证记录

## 修复与根因

- P2-1：文本解析边界未识别转义对；补奇偶判定与基本引号追踪，保留字面符号。各 Shell 的真正续行和跨 Shell 独立标记继续可用。
- P2-2：SSH bootstrap 是独立执行边界；在共同的启动准备阶段先拼接，再追加 Codex 隔离参数，不改 SSH 初始化脚本。
- P2-3：函数提取式 VM 未加载新增依赖；注入真实纯函数并新增格式化器/SSH 计划断言，移除源码正则测试。

## 自动验证（2026-10-16）

- `node --test scripts/startupCommandMultiline.test.mjs scripts/codexHookIsolation.test.mjs scripts/deepseekTuiRuntime.test.mjs scripts/resumeCliArgs.test.mjs`：78/78 通过。
- `npx tsc --noEmit`：退出 0。
- `npm run check:architecture`：1340 source files，0 above 2000 lines，0 new violations。
- `npm run check:architecture -- --strict`：同上，严格模式退出 0。
- `git diff --check`：通过。
- Git Bash 交互 stdin 实测：多行 `printf` 的最后一个参数为字面双反斜杠路径，拼接后保留原参数；后续 sentinel 命令独立执行，没有进入意外续行状态。
- GitNexus impact：共同准备函数直接调用者为启动编排；最终格式化器有 6 个直接调用点，涉及启动、分屏、恢复、handoff、延迟重放，风险评分 CRITICAL，修改前已告知用户。
- GitNexus detect_changes：映射到的 7 个既有符号均在文本解析、启动准备和测试加载器范围；2 个新增内部解析辅助函数已人工核对。工具没有为本次 diff 返回 process 记录，不将其视为不存在调用影响的证据。

## 兼容与边界

- 持久化原文、外部终端、SSH 初始化脚本、IPC/数据库结构保持原约定。
- 无新增或修改用户界面文案，不新增翻译键或时间格式行为。
- 按仓库质量规范未启动 Tauri，也未连接真实 SSH 主机。可补充桌面验收：多行命令保存重开后保持换行；本地/SSH 启动均成为一条命令；Bash 字面反斜杠参数不触发续行等待。

## 交付

两份产品交付文档归入 V1.4.4。修复在独立 `pr-284-review-fixes` 工作区提交，推送目标为现有 PR #284 的来源分支，不合并 PR。

修复提交：`900deab0`（`fix(terminal): preserve startup escapes and normalize SSH commands`）。
