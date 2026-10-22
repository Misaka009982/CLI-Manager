# 设计：Pi 正式会话边界的交接与空闲状态

## 基线与证据

- 分支：`integrate/v1.4.4-desktop-pet-e`；基线：`ba9fc07c`。已跟踪文件无预存改动，仅旧 `10-14-pi-question-adapters/` 文档未跟踪，本任务不碰它。
- 分支未配置 tracking upstream；与本地 `origin/master` 记录的差异为 0/0，未联网刷新。
- Pi 1.4.0：`dist/core/agent-session-runtime.js` 的 `newSession` / `switchSession` / `fork` 调用 `teardownCurrent` 后重新执行 `createRuntime`；`agent-session-services.js` 创建新 `DefaultResourceLoader`；扩展 loader 再次调用工厂。
- 已安装 `cli-manager-hook.ts` 为 v10、三个模块均开启；`session_shutdown` 只在 reload/quit 释放租约，工厂遇到非空租约即返回。
- 前端 `terminalStatus.ts` 的普通 SessionStart 映射为 null；daemon 普通映射同样不更新。宠物E按 PTY ID 留存失败历史。

## 关键决策

### 1. 在生产者修复所有权

正式 shutdown 交还当前根实例租约，新工厂认领；兼容仍复用旧 handler 的 Pi，由有效 session_start 在无人占用时认领自身租约。每个工厂的回调必须检查自己的 lease，不能只比较会话 ID，尤其防止 reload 后旧回调与新实例同 ID。

保留全局实例身份、传输序号及运行代际，不用新的实例 ID 绕开接纳门。等待报告复用单调传输序号，避免模块重新加载后私有计数归零。对话框异步收尾按会话作用域隔离，旧 finally 不得修改新会话的等待计数或恢复心跳。

### 2. 使用真实 SessionStart，不造运行事件

独立 TS/Rust helper 仅识别合法本机/WSL Pi SessionStart，并将其视为明确的 `none`（空闲）。继续使用原有鉴权、接纳门、广播与时间乱序保护；不新增 Hook 事件、提交能力、IPC 字段或设置。

前端清理该 Tab 的旧 Hook 状态、旧 shell 状态和输出活动提示；daemon 写入明确 `none`，而非删除后让消费者默认推断运行。普通 `mapCliHookEvent` / 普通 daemon 映射仍保持 SessionStart 不产生状态，Pi 特例通过外挂 helper 接入。

### 3. 宠物E不复活旧历史

外挂状态投影将带时间戳的 Pi 空闲视为权威状态，按时间与后台状态仲裁，不依赖 TUI 输出猜运行。保留内部 `none` 候选用于清除同 Tab 红蓝历史，渲染快照不产生空闲任务。真实 pendingAction / terminalPrompt 仍优先，其他 CLI 的保留规则不变。

## 发现清单 / 最小接点

| 触点 | 处理 |
|---|---|
| `src-tauri/src/pi_extension_template.ts` | fork 模板：租约、回调、对话框作用域、单调等待序号 |
| `features/hooks/settings/mod.rs` | 只提升模板版本常量至 11 |
| 新 TS Pi 会话 helper | Pi 会话复位判定与空闲投影 |
| `terminal/lib/terminalStatus.ts` | 一处状态覆盖调用，普通事件表不变 |
| `terminal/store/terminalRuntime.ts` | 一处 Pi 复位清理接线，沿用现有状态更新器 |
| 新 Rust Pi 会话 helper + `daemon/server/hook_status.rs` | 独立判定，已有 daemon 状态入口薄接线 |
| `desktopPetEState.ts` | fork 状态投影与空闲候选，清理旧历史 |
| `pi_admission.rs` | 原仲裁保持；补用例验证新代际通过、旧回调拒绝 |
| App / Replay / 普通终端类型 / 答题 broker | 不修改；确认既有入口正常消费状态且不伪造完成或问答 |
| SSH / rpiv / 已安装扩展 | 不修改；无可靠生命周期证据时不猜测 |

## 场景矩阵

- 状态：失败/完成/等待后切换；新空会话；开始下一轮；连续失败后再次 new。
- 生命周期：重建工厂、重新求值模块、旧 Pi 复用 handler；new/resume/fork/reload/quit；切换取消不释放。
- 所有权：早启动同进程 SDK 子会话、继承环境的子进程、旧回调迟到、同会话 ID reload。
- UI：前台/后台/托盘/不同分屏与 Workspan 均按真实 Tab 定位；重绘不替代生命周期。
- 环境：本机/WSL；SSH 不新增支持；模块部分关闭沿用开关语义。
- 交互：真实待答与只读等待并存、旧对话框迟到结束、等待跨模块重载。

## 验证限制

GitNexus 不可用，采用契约与逐层引用追踪。独立 advisor 调用因 unexpected EOF 未取得结果，不计作通过。所有验证仅静态，不把新增用例或手工推演记为运行通过。
