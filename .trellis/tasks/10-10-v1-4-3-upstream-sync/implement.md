# 实施计划

## 执行顺序

1. 核实分支、远端、标签对象、目标提交与共同祖先，保存 fork 基线和共同修改路径。
2. 确认需求与设计覆盖用户授权，激活 Trellis 任务；在既有 worktree 新建 V1.4.3 集成分支。
3. 以 --no-commit --no-ff 合并目标提交，按双侧差异处理冲突，不覆盖上游或 fork 的独有功能。
4. 移植 Pi WSL 身份字段，同步版本到 8，调整现有 Pi 契约和上游新增的 WSL 测试适配层。
5. 更新 V1.4.3 变更记录、功能清单和核查证据。
6. 进行定向静态审查，核对源码、共享接入、模块路径、版本与文件编码；不执行编译和测试。
7. 明确暂存路径并创建双父本地提交，核实父提交、工作区及未推送状态。

## 静态验证

- Git 差异与冲突项检查；以共同祖先和两侧基线区分上游改动、fork 保留及本轮适配。
- 保护文件逐条对照 Git 内容，声明 Pi 模板、版本和测试的预期变化，不仅抽查资产。
- 检查 postHook → postJson → Hook payload 消费路径的 wslDistroName 一致性。
- 阅读 Pi 受管升级/不降级 Rust 用例以及 WSL 身份、Codex 启动隔离、宠物E 契约用例。
- 新改动的 JavaScript 测试文件仅做 node --check 语法检查；没有红绿运行结果，不用静态检查冒充测试执行。
- UTF-8、CRLF/仓库既有 eol 约定及本轮共享导入、占位符替换检查。
- 手动审查替代不可用的子代理/GitNexus；不扩展为上游全部代码的重新审计。

## 用户本地验证命令

```powershell
npm run build
npm run test:pet-e:contracts
node --test scripts/wslHookIdentity.test.mjs scripts/codexHookIsolation.test.mjs scripts/terminalHookBinding.test.mjs scripts/agentCapabilities.test.mjs scripts/fileTreeSort.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml
```

## 用户人工验证

- 使用新版应用重新创建本机/WSL/SSH Codex 终端，核对三终端 Hook 归属、提问通知、点击跳转和精确会话统计。
- 重启旧 PTY/daemon，重新加载已升级的 Pi 扩展；分别检查 Ubuntu、Debian 与本机环境，避免使用旧进程判断修复效果。
- 核对宠物E 问题组/第三方权限双端作答及清除、窗口记忆和排序偏好重启恢复。

## 完成条件

无未解决冲突、无未说明的 fork 丢失；上游目标和 fork 基线成为最终提交的父节点；核查记录如实披露运行验证未执行；不执行 push、PR 或发布。
