# 技术设计

## 解析边界

保留单行输入逐字节不变。多行仍 trim 后以空格连接；去除续行符之前检查行尾同字符串的奇偶性，偶数个表示完整转义对，奇数个仅去除末尾一个。跟踪跨行单/双引号，保护 Bash/PowerShell 单引号和 CMD 双引号中的字面符号。跨 Shell 标记只接受与正文空白分隔的单个符号；未知 Shell 使用该保守规则，避免误删 Windows 路径结尾。

这不是通用 Shell 解析器，不新增脚本语义。逻辑放在现有纯函数模块，所有入口复用，不在 PTY 传输层补丁。

## 启动编排

`prepareStartupCommandForPty` 在追加 Codex 参数前规范化命令，使 SSH 结构化计划和本地主路径一致。`formatStartupInputForPty` 继续作为 PTY 写入前的最后格式化步骤，支持手动调用和旧会话延迟重放；单行幂等性避免重复处理。SSH 初始化脚本保持原始脚本格式。

## 测试

纯函数覆盖各 Shell 转义/引号边界；Codex VM 加载器注入真实纯函数依赖，断言实际格式化输出和 SSH 计划。DeepSeek 等现有启动测试用于入口兼容检查。用 Git Bash 交互 stdin 验证字面反斜杠不会吞掉后续命令，不启动 Tauri 或连接远程主机。

## 场景与兼容

- 启动、分屏、恢复、handoff 和延迟重放：共享纯函数/格式化器，不逐调用点改写。
- 本地 PS/CMD、WSL/Git Bash、Unix Shell：按目标 Shell 判断转义字符。
- SSH 项目：按现有远端 Bash 约定规范化后交给结构化计划。
- 焦点、托盘、Workspan、Worktree、Hook 状态：不影响纯文本处理，不改变生命周期。
- 持久化、克隆和外部终端：格式不变，无迁移，回滚为普通代码回滚。

## 发现清单

- 必改：`startupCommandText.ts`、`prepareStartupCommandForPty`、格式化器说明、纯函数测试、Codex 测试加载器。
- 验证：`terminalStore` 主启动/分屏/恢复/handoff、`useXTermController.writeDeferredStartup`，均复用现有入口。
- 确认无关：Rust SSH bootstrap、PTY transport、ConfigModal 保存链路、数据库迁移、外部终端。
