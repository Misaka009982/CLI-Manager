# V1.5.0 同步与 Pi 1.5.0 适配：静态交付记录

## 交付范围

- fork 起点：`2388905dfe4bb26d56484d89d1978a0d7e303c85`。
- 固定上游：`50e0f17fc70d2bc34b587de1b99d92f3deaa6a13`，即抓取时的 `V1.5.0` 与 `upstream/master`。
- 集成分支：`integrate/v1.5.0-desktop-pet-e`；沿用 `.worktrees/ship-desktop-pet-e-master`，主 worktree 不改。
- 用户已确认完整同步、提交及推送，最终目标为 `origin/master`。普通快进推送；不创建 main，不强推，不修改默认分支，不发布标签或构建。
- 提交前已刷新 origin，远端 master 仍为 fork 起点，`HEAD...origin/master` 为 `0/0`。最终提交及远端哈希以交付时 Git 输出为准。

## 实现与合并取舍

合并的 8 个文件内容冲突已逐块解决，无剩余未合并项。接纳上游 cc-connect、远程托管接点及旧归档退役，保留 fork 独有文件和仍有效的宠物E功能；未采用全库 ours/theirs。

| 领域 | 结果 |
|---|---|
| Pi 1.5.0 | 自有 question/questionnaire 的 inline custom 声明 `blocked: { kind: "question", message }`；模板与 Rust 升级常量均为 12；继续使用 typebox 的标准 JSON Schema |
| Pi 生命周期 | 保留 v11 的 new/resume/fork/reload 根租约交接、旧回调失效、单调序号、WSL 身份、明确空闲复位和历史时间仲裁；请求超时 2 秒 |
| UI 三通道 | `blocked` 只用于终端程序状态；正式 ui_prompt 只读等待、普通通知与真实 pendingAction 仍独立，不扩大第三方自绘代答能力 |
| Codex / daemon | 保留 Codex 问答所调用的 `try_notify_prepared_payload`、交互请求与回执；保留 daemon 的宠物 broker、只读事件旁路与重启清理 |
| 设置与任务 | 补齐宠物E图标映射；复用上游共享后台任务清单及失败时的最近成功缓存；旧 remoteHandoff 只做运行时形状隔离 |
| 结构 | `desktopPetEPreferences.ts` 承载默认偏好、迁移、加载互斥与写入校验；终端域 `desktopPetETabNotifications.ts` 承载待答关注覆盖。原入口保留显式接线和兼容导出，不通过压缩空白规避长度限制 |
| 打包 | Windows 先准备独立 helper，再构建宠物E及准备 Electron；便携包同时校验 Tap 与宠物资源。独立 helper 仍复用含 fork 模块的主库 |
| 文档 | CHANGELOG 与功能清单按 V1.5.0 段首追加，外挂契约和 Hook 契约对齐 v12；未改安装副本 |

## 已完成的静态核查

- 编写本记录前，584 个合并后文本文件通过严格 UTF-8 解码及冲突标记扫描；范围含新增问答夹具、两个 helper 和三份方案。
- 本轮 `src`、`src-tauri/src`、`scripts` 中 315 个变更代码模块均不超过 2000 物理行。最终 settingsStore 为 1993 行，标签控制器为 1998 行；两个 helper 分别为 76 行和 12 行。此检查不能代替完整架构检查。
- 1199 个变更前端相对模块引用可定位，含新增 helper；不等于 TypeScript 类型检查通过。
- 相对上次上游基线 `2991fd4b` 的 94 个 fork 独有文件均保留；旧未跟踪任务目录未暂存。
- npm/Tauri/Cargo 共 7 处应用版本为 1.5.0，Pi 模板/常量为 12/12，helper 主库接线及打包入口可定位。
- `git diff --check HEAD` 无空白错误，无未合并项。Git 的 LF/CRLF 提示仅为工作区换行转换提示。
- 9 个 `.mjs` 通过 `node --check`：`piCustomQuestion`、`piHookSdk`、`piDesktopPetHook`、`petEPackage`、`settingsIcons`、`daemonTaskInventory`、`desktopPetESettings`、`desktopPetEMutualExclusion` 的测试文件及 `prepare-bundle-binaries.mjs`。只解析语法，未执行这些文件。
- `package-portable.ps1` 经 PowerShell Parser 纯语法解析无错误，未运行打包脚本。
- 对照本机 Pi 1.5.0 的公开声明与实现，核对 custom/blocked、runner 的正式 UI 事件、TypeBox alias、pi-schema 校验及 SDK/ModelRuntime 入口。未执行 Pi。

最初的长度检查发现 settingsStore 2032 行、终端标签控制器 2001 行，已通过职责抽离修正后重查。版本脚本首次解析 lockfile 遇到 PowerShell 空键限制，改用哈希表读取后核对通过。

## 回归与审查限制

已编写但未运行：自有 custom 完成、自由输入、问卷提交、取消/宠物先答 abort、异常计数清理；真实 TypeBox/pi-schema coercion 与无效输入；共享任务清单接线；设置互斥和迁移；图标与 Windows helper/Electron/Tap 打包契约。

可选官方 SDK 夹具固定 1.5.0，未提供 SDK 时明确跳过，显式路径无效或版本错误必须失败；不能将跳过算作兼容通过。新增 `npm run test:pi:sdk` 入口。

遵守本轮约束，未编译、运行测试、安装依赖、启动服务或发布构建。worktree 缺少 TypeScript，未执行 AST/类型检查；未运行官方架构检查、Rust 编译或手工 UI 验收。当前无可调用的子代理或 GitNexus，本轮是单代理源码/契约静态审阅，不能描述成独立复审或完整 ce-code-review 多代理通过。

## 用户本地验收

在依赖已准备好的集成 worktree 中运行以下项目；此处仅记录命令，不代表已经执行：

```powershell
npm run build
npm run build:pet-e
npm run test:pet-e:contracts
npm run check:architecture -- --strict
node --test scripts/daemonTaskInventory.test.mjs scripts/settingsIcons.test.mjs scripts/ccConnectRemoval.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml pi_session_lifecycle
cargo test --manifest-path src-tauri/Cargo.toml pi_admission
cargo test --manifest-path src-tauri/Cargo.toml desktop_pet_e_ui_prompt
cargo test --manifest-path src-tauri/Cargo.toml hook_settings
cargo test --manifest-path src-tauri/Cargo.toml hook_client
```

可选官方 SDK 验收：将 `PI_SDK_DIR` 设为已有 Pi 1.5.0 安装根目录（其下包含 `node_modules/@earendil-works/pi-coding-agent`），再运行 `npm run test:pi:sdk`；脚本不安装或更新 Pi。

更新应用并将托管 Hook 升到 v12 后，重启或 `/reload` Pi；回调地址变化时新建终端。手工核对标准对话框、自有问答、第三方 custom 只读等待、取消、宠物先答、new/resume/fork/reload、模型失败后空闲复位，以及中英文设置/图标和宠物互斥。Windows 安装包与便携包需另外验收 helper、Tap 及 Electron 资源。

## 残余风险

既有 Pi broker `/open` 仍按 Tab 替换待答，服务端处理乱序可能让旧请求影响新待答；客户端作用域守卫不能撤销服务端的替换副作用。本轮没有修改 broker 协议或宣称该风险已解决，详见 `pet-e/docs/pi-terminal-prompt.md`。

静态交付完成不等于运行验收通过；依赖、类型、构建产物和真实 UI 行为须以上述本地验收为准。
