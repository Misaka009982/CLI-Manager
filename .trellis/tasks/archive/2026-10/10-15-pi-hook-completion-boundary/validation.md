# 验证记录 — 2026-10-15 / V1.4.4

## 自动检查

| 检查 | 结果 |
|---|---|
| node --test scripts/piHookLifecycle.test.mjs scripts/piHookNotification.test.mjs scripts/terminalHookBinding.test.mjs scripts/kimiHookFrontend.test.mjs scripts/opencodeHook.test.mjs scripts/wslHookIdentity.test.mjs scripts/piHookSdk.test.mjs | 47 passed，0 failed，0 skipped |
| 官方 Pi 1.2.0 SDK（上表一个测试内） | 9 个实际场景通过：普通、工具循环、before-settle、follow-up、deferred 新运行、中断、最终错误、重试成功、压缩续跑 |
| cargo test --manifest-path src-tauri/Cargo.toml claude_hook:: --lib | 38 passed，含实际 loopback HTTP 接纳与其他 CLI 回归 |
| cargo test --manifest-path src-tauri/Cargo.toml pi_ --lib | 19 passed，含安装/卸载、非托管保护、单模块、第三方通知、翻译；与上项有重叠，不合计为独立用例 |
| cargo check --manifest-path src-tauri/Cargo.toml | 通过 |
| npx tsc --noEmit | 通过 |
| 生成模板 against Pi 1.2.0 类型，tsc --noEmit --target ES2022 --module nodenext --moduleResolution nodenext --skipLibCheck | 通过 |
| npm run check:architecture -- --strict | 1327 source files，0 above 2000 lines，0 new violations |
| git diff --check | 通过；仅 Git 的 LF/CRLF 提示，无空白错误 |
| GitNexus detect_changes，本工作区完整路径 | LOW，已跟踪改动未报告额外 affected processes；新文件尚未跟踪，另以源码链路、真实 HTTP 与集成测试审核，不将图结果当完整覆盖 |

旧模板行为回归在修复前模式下 5 项失败、1 项通过，证明生命周期用例能检测原有缺口。PI_HOOK_BASELINE=1 仅适用于提交前旧 HEAD 模板。Kimi 既有测试有一处断言匹配旧 event.payload 表达式，本次修正为当前 payload 表达式，保留相同排除断言，不改 Kimi 功能。

SDK 安装于系统临时目录 cli-manager-pi-1.2.0-probe，可用 PI_SDK_DIR 覆盖；不新增仓库依赖，不修改用户全局 Pi。SDK 测试使用内存会话、模拟模型与临时目录，不调用真实模型。最后仅收回无关 Rust 格式化改动，未改变已验证业务逻辑。

## 跨层审核

- 生产模板身份 → HTTP 请求可选 pi 字段 → 验证与运行接纳锁 → 标准 Hook payload → 所有 sink；拒绝发生在身份更新/通知/回放之前。
- 会话切换与 reload 不丢失根归属或序号，stop-only 不依赖 running 开关；网络失败与一秒超时均不阻塞回调。
- 取消/失败/重试成功分别有 SDK、模板与接纳回归；Pi 文案共用 JSON，前端执行实际 formatter 验证中英文，后端执行共享标签和消息构造测试。
- 旧扩展兼容存在明确边界；更新应用后须重装 Pi Hook 并重启或 /reload。未新增 SSH Pi 安装支持。
- 其他 CLI 继续既有完成语义，公共绑定逻辑没有改动；新增字段不进入下游 IPC/回放协议。

## 人工与现场验证记录

2026-10-16 用户明确确认“hook的修复验证完成”，并授权提交。本任务据此验收关闭。以下保留此前交付的检查清单；用户未逐项提供执行明细，不额外声称代理执行了 UI 检查：

1. 设置中重装 Pi Hook，重启或 /reload；反馈者以原先第三方扩展与任务复测，保留脱敏事件时序以确定现场触发来源。
2. 切换 zh-CN/en-US，检查 toast、系统通知及第三方通知的 Pi 正常收尾文案，时间仍为 24 小时。
3. 多 Tab/分屏/多窗口、前后台/托盘及实际 WSL 环境中检查通知归属与展示。自动测试已覆盖绑定和 WSL 身份，但不是桌面交互实测。
4. 普通结束一次；取消不报完成；最终错误报失败；子 Pi 收尾不改变父 Tab；后续有效运行仍能提醒。

2026-10-16 提交前 master 与本地 origin/master 引用 0/0；未 fetch 或同步远程。用户确认验证完成后进入提交与归档。现场扩展组合未提供，当前 settle 不证明任意未来后台任务完成。
