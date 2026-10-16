# Pi 1.2.0 完成通知修复方案（已批准并实现）

## 官方依据与能力边界

以 official-v1.2.0.md 的固定标签文档、类型、源码为准。agent_settled 是当前运行收尾，内部重试、压缩和 before-settle continuation 已处理；不能推断业务目标或任意后台工作流完成。通知限定为“本轮运行已结束 / Run ended”。用户批准实施，记录版本 V1.4.4。

## 已落地的数据流

1. 生成模板独立为 pi_extension.ts，由 Rust include_str 读取并替换三个模块开关，保留安装 marker 与非托管文件保护。
2. 扩展工厂使用 CLI_MANAGER_PI_OWNER（tabId/pid）与进程内租约，阻止继承父环境的子 Pi 和抢先启动的同进程 SDK 子会话上报。租约在工厂阶段占用；new/resume/fork 保留，reload/quit 释放，进程实例与事件序号跨 reload 保留。标记只作归属辅助，不代替 token 鉴权。
3. before_agent_start 只更新运行代际，agent_start 每轮最多上报一次 running；message_end 记录最新 assistant 结果，最终 settle 分别生成 Stop、Interrupt、StopFailure。重试成功覆盖中间错误。缺失结果仅可描述 run ended，不声明业务成功。
4. settle 候选在下个事件循环校验 owner/session/run、isIdle、pending messages；已观察到的新运行使旧候选失效。该派发优化不保证任意异步扩展以后不启动新任务，不读取 Pi 私有 deferred 队列。
5. HTTP 请求带 remoteEventId、remoteSequence 与可选 pi 实例/代际字段。后端在统一 HTTP 接纳入口按实例、序号、运行与 session 拒绝旧/重复事件，锁持有到 sink 完成，保证仲裁和分发顺序一致。所有 daemon、第三方通知、桌面状态/通知和回放均位于此入口之后，拒绝事件不会进入 App rawTabId 回退。下游 payload 无需新增协议。
6. Pi 接纳缓存最多 1024 Tab，重启或容量淘汰后历史保护重置。旧载荷在尚未被新版占用的 Tab 上兼容；新版接管后旧载荷拒绝。其他 CLI 沿用原去重行为。
7. Pi 正常收尾文案共用 pi-hook.json，toast、系统通知、第三方通知一致；中断不发完成提醒，失败沿用失败通知。第三方通知读明确持久化语言，auto 保留既有默认语言策略。
8. 生命周期 HTTP 请求保持 detached、1 秒超时、失败吞掉且不自动重试。调试日志受 debug 等级控制，仅有事件、session、序号及接纳标志，无正文与令牌。

## 验证与部署

- 官方 Pi 1.2.0 SDK 使用隔离目录与模拟模型完成 9 个实际生命周期场景；模板 VM 用例覆盖归属、重复、乱序候选、reload、切换、stop-only、网络异常与超时。
- 真实 loopback HTTP 测试确认非法载荷 400，重复/迟到载荷 204 且不进入任何 sink；前端 formatter、第三方通知、安装所有权和 WSL 身份有回归。
- 本地与 WSL 生成扩展受支持；现有 SSH Agent 安装仅覆盖 Claude/Codex/Kimi，不将本次描述为新增 SSH Pi 支持。
- 更新应用后须在 Hook 设置重新安装 Pi Hook，再重启 Pi 或 /reload；仅更新二进制不替换现存扩展。回滚应配套回滚扩展与应用，不覆盖用户自有扩展。
- 未新增依赖或数据库变更。反馈现场的第三方扩展与事件样本仍未知；不能将定向集成测试等同于反馈者实测。2026-10-16 用户确认 Hook 修复验证完成；未提供手动场景逐项执行明细，见 validation.md。
