# 技术设计：SSH AskPass 与 MFA 混合交互

## 1. 边界

修复落在 `ssh_askpass`，因为 OpenSSH 在 `SSH_ASKPASS_REQUIRE=force` 下把 password 与 keyboard-interactive 统一交给 helper。前端 xterm、WebSocket、daemon 和 PTY writer 已能正确发送输入，不应在症状层增加特殊判断。

## 2. 当前数据流

```text
系统凭据库 -> 一次性 broker -> AskPass helper -> password challenge
MFA challenge -> AskPass helper -> 非 password/passphrase -> exit(1)
用户键盘 -> xterm -> daemon -> PTY master -> 无读取者
```

结果：OpenSSH 收到空/失败响应并重试 keyboard-interactive challenge。

## 3. 目标数据流

```text
password/passphrase challenge
  -> 优先请求一次性 broker
  -> broker 失败且交互 launch 显式允许时读取当前控制终端

MFA/OTP/PIN/其他 challenge
  -> 跳过 broker
  -> 仅在交互 launch 显式允许时将提示写到当前控制终端
  -> 从当前控制终端读取一行
  -> 仅把响应写到 helper stdout pipe，交给 OpenSSH

后台 one-shot challenge
  -> 不设置 TTY fallback 标志
  -> 不尝试打开控制终端
  -> helper 快速失败，由现有上层错误分类处理
```

## 4. 实现方案

- 保持 `run_helper_and_exit() -> !` 与现有入口不变。
- `build_interactive_launch` 为 `credential_ref` 设置内部环境标志 `CLI_MANAGER_SSH_ASKPASS_TTY_FALLBACK=1`；`build_one_shot_launch` 不设置。
- 将 broker 请求拆成返回 `Option<Vec<u8>>` 的内部函数，不在内部直接退出。
- 增加纯函数提示分类：仅 `password/passphrase` 允许尝试保存凭据；其他提示必须人工输入。
- AskPass helper 仅在上述内部标志存在时允许控制终端降级，不能用“当前可能有 TTY”推断是否可阻塞。
- 增加控制终端读取函数：
  - Unix：打开 `/dev/tty`。
  - Windows：打开 `CONIN$` / `CONOUT$`。
  - 输入默认关闭回显，使用 RAII/Drop 保证所有路径恢复原终端模式。
  - 响应限制到 OpenSSH AskPass 可接受的安全长度，移除结尾 CR/LF。
- helper stdout 只输出响应；提示与换行写入控制终端，避免污染 OpenSSH 的响应 pipe。
- 未开启降级或无控制终端时返回失败，后台 one-shot 继续走既有错误分类。
- 不新增 crate；Unix 使用现有 `nix::libc`，Windows 使用现有 `windows-sys` Console API。

## 5. 兼容性

- 普通保存密码：行为不变，broker 仍优先。
- 保存密码 + MFA：新增人工后续挑战。
- 密码错误/凭据失效：交互 PTY 可人工纠正；后台 one-shot 仍失败。
- 后台 one-shot：即使进程意外继承控制终端，也不会读取人工输入或永久等待。
- `password_prompt` / `interactive`：未设置 AskPass 环境，继续由 OpenSSH 直接读取 PTY。
- Agent、私钥、SSH Config：不受影响。

## 6. 安全约束

- 不记录 prompt response、broker password、TTY 输入。
- 不把响应放入环境变量、命令行或持久化层。
- 终端回显必须在异常和提前返回时恢复。
- 每个 helper 只打开其所属 SSH 进程的控制终端，不使用全局输入通道。

## 7. 测试

- 纯函数测试提示分类。
- 注入式测试验证：
  - password 优先 broker；
  - broker 失败后调用 TTY；
  - MFA 不调用 broker；
  - 未设置 TTY fallback 时不调用 TTY；
  - 两者都失败时返回失败；
  - 提示写入控制终端、响应只写 helper stdout。
- 平台 TTY I/O 通过定向编译和人工 SSH 验收覆盖，不在单元测试中依赖真实终端。

## 8. 回滚

无数据迁移。回滚仅需恢复 `ssh_askpass.rs` 与对应契约/Changelog；保存的凭据格式不变。
