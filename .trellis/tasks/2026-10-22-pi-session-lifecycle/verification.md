# Pi 会话生命周期修复：静态交付记录

## 交付结论与边界

本轮完成代码修正、回归夹具和文档的静态收尾；**未证明行为验收通过，也不作为可直接发布的结论**。应用版本保持 `1.4.4`，托管 Pi 模板与 Rust 安装常量均为 v11，保留 2 秒请求超时。

工作现场为 `D:/Project/pi-pet/CLI-Manager/.worktrees/ship-desktop-pet-e-master`，分支 `integrate/v1.4.4-desktop-pet-e`，基线 `ba9fc07c`。当前分支没有 tracking upstream；用户在静态收尾后明确授权提交并推送默认分支。提交前已通过 `git ls-remote --symref origin HEAD` 联网确认默认分支为 `master`，远端 HEAD 与基线相同，仅按普通快进方式推送，不强推或创建 PR。实际提交及推送结果以 Git 记录为准。未改主仓库遗留工作、旧任务、已安装 Hook、Pi 或 rpiv；任务元数据保持 `in_progress`，等待用户运行验收。

## 根因与修正

根因在 Pi 会话替换到托管扩展所有权的边界：Pi 1.4.0 在 `/new`、`/resume`、`/fork` 销毁旧 runtime 并重新调用工厂，v10 保留的根租约让新工厂提前退出；普通 SessionStart 又不清旧终态，宠物E历史因而持续保留旧错误。修正同时落在生产者租约交接和明确空闲的消费端，而不是仅隐藏错误颜色。

- 正式 shutdown 释放当前工厂租约，包括尚未完成 session_start 的工厂；新工厂接管，兼容旧 Pi 复用最后 handler。旧工厂、同 ID reload 的旧回调、旧心跳和对话框异步收尾按租约与作用域失效。
- 进程级身份、运行代际、传输序号与最后发出时间跨模块重新求值保留；只读等待复用单调传输序号。
- 合法本机/WSL Pi SessionStart 映射为明确 `none`。前端在绑定前拒绝较旧复位，复用原状态更新器清旧 Hook/shell 状态及输出活动，daemon 写入明确空闲。
- 宠物E保留不渲染的空闲候选，清同 Tab 红蓝历史；空闲与普通历史按时间双向仲裁，不让旧快照抹新任务或复活旧状态。当前真实 pendingAction 和只读等待保持优先，不从历史恢复已结束交互。
- daemon 的新 `none` 被原桌面宠物和后台任务面板共同消费，故最小补齐这三个直接消费者；未知状态仍沿用旧回退，明确空闲不按 TUI 输出猜运行。面板补齐中英文空闲文案，不新增协议状态或设置。
- 问答 `/open` 的**响应迟到**只触发自身 requestId 的收尾；不把客户端夹具描述为服务端处理乱序的完整证明，见下述残余风险。

## 发现清单与修改范围

| 触点 | 处理结论 |
|---|---|
| `src-tauri/src/pi_extension_template.ts` | 租约交接、有效回调、对话框作用域、共享时间与单调等待序号；外部模板仍是唯一实现 |
| `src-tauri/src/features/hooks/settings/mod.rs` | 仅提升托管常量至 11 |
| `src/shared/lib/piSessionLifecycle.ts` | 独立 Pi 判定、绑定前乱序守卫、空闲投影 |
| `src/features/terminal/lib/terminalStatus.ts` | Pi 状态覆盖和明确 none 恢复；普通 CLI 事件表不变 |
| `src/features/terminal/store/terminalRuntime.ts` | 仅接绑定前守卫和既有终态清理分支 |
| `src-tauri/src/infrastructure/daemon/server/pi_session_lifecycle.rs` / `hook_status.rs` | 独立 Pi 判定，原入口薄接线 |
| `src/shared/lib/desktopPetEState.ts` | 空闲候选、时间仲裁与旧历史清理 |
| `src/features/desktop-pet/api/desktopPet.ts` / `lib/desktopPetStatus.ts` | 通用明确 none 兼容，不复制 Pi 生命周期业务 |
| `src/features/terminal/components/BackgroundTasksPanel.tsx` | 明确 none 的空闲显示；恢复/丢弃入口保持原规则 |
| `src/shared/i18n/messages/terminal.{zh-CN,en-US}.ts` | 各增加一个空闲词条 |
| `src-tauri/src/features/hooks/pi_admission.rs` | 生产接纳门不变；仅增加新会话代际及旧终态拒绝断言 |
| `scripts/piHookLifecycle.test.mjs` | 模拟重建/模块重新求值、旧 handler、同 ID reload、旧计时器/对话框/响应、部分模块关闭；基线模式改读所属 worktree HEAD 的外部模板 |
| `scripts/piSessionLifecycle.test.mjs` | 真实终端状态更新、绑定前拒绝迟到、身份及时间规则；只桩路由、存储与计时器边界 |
| `scripts/desktopPetEState.test.mjs` | 改用真实普通状态解析器；补空闲、历史、旧快照与真实待答回归 |
| `scripts/desktopPetStatus.test.mjs` | 原宠物和后台面板的真实判定、明确空闲与未知回退、中英文文案 |
| `scripts/piDesktopPetHook.test.mjs` / `package.json` | v11/序号/接线契约及回归入口登记；无新依赖 |
| `CHANGELOG.md` / `docs/功能清单.md` | 本轮记录写入 V1.4.4 段，未重排无关历史 |
| `pet-e/docs/pi-terminal-prompt.md` / `.trellis/spec/backend/cli-hook-contracts.md` | 更新 v11 外挂接入点、升级步骤和残余风险 |
| App / Replay / 普通终端类型 / 答题 broker / 只读等待 reducer | 已检查本轮所需入口与隔离关系，不修改这些实现 |
| SSH / 父子实例 / 旧任务 / Pi、rpiv、已安装副本 | 不扩展 SSH 或猜测身份；原隔离和安装边界保留 |

## 回归场景与证据等级

以下为已写入的回归覆盖，不是已经执行通过的结果：

- 失败后 new/resume/fork/reload，重建工厂和重新求值模块；同 ID reload、连续切换、旧 handler 复用、空会话不造运行或终态。
- 尚未完成 session_start 即 shutdown，根与嵌套子实例隔离；旧回调、旧心跳/续报失效，新计时器可续报。
- 旧镜像对话框 finally 和旧 `/open` 响应迟到，不能使用新会话的客户端作用域；只读等待序号跨重载不归零。
- 真实终端状态更新清 Hook/shell/输出，绑定前拒绝迟到复位；daemon attach 保留 none；非 Pi 和 SSH 不套用 Pi 复位。
- 前台/后台 failed 或 done → none → running，旧后台快照与 TUI 重绘；真实待答和只读等待优先，已结束交互不从历史复活。
- 原宠物和后台面板明确 none、未知状态回退、中英文空闲；模块部分关闭仍保持原上报开关。
- 焦点、托盘、分屏、不同 Workspan、本机/WSL 和真实问答并存按代码路径审阅，仍需实机验收，不声称穷举组合已验证。

## 已执行的静态核查

1. `git diff --check`：未发现空白错误；仅有仓库既有 LF/CRLF 转换提示，未进行全文件格式化。
2. `node --check`：`piHookLifecycle.test.mjs`、`piSessionLifecycle.test.mjs`、`piDesktopPetHook.test.mjs`、`desktopPetEState.test.mjs`、`desktopPetStatus.test.mjs` 均未报语法错误。此命令只解析文件，未执行测试或导入依赖。
3. 严格 UTF-8 解码、冲突标记、物理行数和新增代码最长行检查：通过本轮范围核查；手写代码均不超过 2000 行，最长代码行不超过 500 字符。首次脚本未正确处理 Git 引号转义的中文路径，已改为明确路径、遇错即停后重查，不把首次错误算作通过。
4. 新增 TS helper 和 Rust helper 的相对导入目标存在；Rust 模块可见性、事件/字段和构造器按源码审阅，无新增 IPC 字段或事件名。
5. 模板标记与 Rust 常量 11/11、`REQUEST_TIMEOUT_MS = 2_000`、应用版本 1.4.4 和三份补充回归入口登记已核对；中英文空闲键各出现一次。
6. 独立 advisor 复审先因服务负载失败，后一次返回了有效建议，已核实并补齐 none 的直接消费者，另记录 broker 风险。未将其称为已完成正式多代理代码审查；当前工具面没有 GitNexus 或多代理派发能力，使用契约、直接源码与 `git grep` 追踪，未重建索引。

## 未完成的工具验证与验收

- TypeScript AST 语法检查尝试未能开始：当前 worktree `require('typescript')` 报 `MODULE_NOT_FOUND`。没有安装依赖、借用其他工作区依赖或执行转译，TS/TSX 的工具语法及类型检查仍未完成。
- 未执行 TypeScript 类型检查、Rust 编译、npm/cargo 行为测试、架构脚本、应用启动、实机操作或发布构建；也没有观测到回归用例的先红后绿。
- 新测试中的真实函数调用只表示夹具设计，不是本轮运行证据；HTTP 响应桩不替代真实 broker。

## 残余风险：服务端 `/open` 请求处理乱序

静态阅读 `src-tauri/src/desktop_pet_e_agent.rs` 的 `pi_open()` 与 `open()` 确认：共用 broker 按同 Tab 替换 Waiting 项，未对 Pi 会话/代际接纳。如果旧会话请求在服务端晚于新请求处理，新待答可能在客户端收到旧响应之前被替换。客户端只取消自身 requestId 无法撤销已经发生的替换。

既定任务范围明确不改答题 broker，本轮没有擅自扩展协议。此项是未解决的已知风险，后续需另行评估会话/代际接纳及真实 broker 乱序回归。当前工作不能被描述为所有快速切换问答竞态均已修复。

## 用户运行验收

在已有项目依赖可用的 worktree 根目录，由用户执行：

```powershell
npm run build
npm run test:pet-e:contracts
npm run check:architecture -- --strict
```

在 `src-tauri` 目录，由用户执行：

```powershell
cargo test pi_session_lifecycle
cargo test pi_admission
cargo test desktop_pet_e_ui_prompt
cargo test hook_settings
cargo test hook_client
```

更新应用后，在 Hook 设置中升级/重新安装托管 Pi Hook，确认 v11 并重启或 `/reload` Pi；回调环境变化时新建终端。仓库编辑不会修改或热更新已安装的 v10 副本。

先制造模型失败，执行 `/new`：旧错误应清除为空闲；新问题开始后出现运行，完成/失败正常上报。再检查 resume/fork/reload、连续 new、后台/托盘/分屏/Workspan、本机/WSL、部分模块关闭、真实待答与只读等待并存，以及中英文后台空闲。快速切换并立即提问时另关注上文 broker 处理乱序风险。
