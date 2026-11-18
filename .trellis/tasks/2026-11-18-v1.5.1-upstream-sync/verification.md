# V1.5.1 集成静态验收

日期：2026-11-18。执行范围与授权来自本任务 `prd.md`、`design.md`、`implement.md` 及方案后确认。
用户已选择“实施并推送 origin/master”，只做静态核查，不运行编译、行为测试、安装或打包。
方案中的“尚未授权”是规划时快照；执行授权记于 `task.json`，本报告记录实际验收。

## 范围与合并现场

- 工作区：`D:/Project/pi-pet/CLI-Manager/.worktrees/ship-desktop-pet-e-master`。
- 分支：`integrate/v1.5.1-desktop-pet-e`；未设置 tracking upstream，交付目标显式指定为 `origin/master`。
- fork 起点：`6395a97334fb32fb55ceefc28d91d18b5363f5f5`；共同祖先 `50e0f17fc70d2bc34b587de1b99d92f3deaa6a13`。
- 固定上游：`V1.5.1` 解引用与 `MERGE_HEAD` 均为 `644cb809fffb92931a9e1d9c14c3d8b378e1ad73`。
- 实际内容冲突共 5 处：`.gitignore`、`CHANGELOG.md`、`docs/功能清单.md`、`scripts/package-portable.ps1`、`src/shared/preferences/settingsStore.ts`；均逐块解决。调研时的 19 个共同修改路径不是冲突数量。
- 提交前 `git ls-files -u` 为空，`git diff --check HEAD` 通过。远端 `git ls-remote origin refs/heads/master` 仍为 fork 起点，只允许普通快进推送。
- 保留 102 个上次集成相对上游新增的 fork 独有文件，无缺失。旧未跟踪 `.trellis/tasks/10-14-pi-question-adapters/` 保持未暂存；主 worktree 不修改。
- 接纳上游共有历史迁移与 ccusage 退役；不运行迁移/任务脚本、不访问本地凭据或数据库、不修改 Pi/rpiv 或安装副本。

## 接点审阅与需求覆盖

| 单元 / 需求 | 结论与证据 |
|---|---|
| U1 / R1、R2、R7 | 保留固定标签的完整合并历史和官方功能；应用、npm lock 根包、Tauri、主 Cargo、独立 helper 及 helper lock 内主包版本均为 1.5.1。helper/build.rs 与固定标签一致，沿用动态版本资源。fork 发布入口及 Windows helper → 宠物构建 → runtime 准备顺序保留。 |
| U2 / R3 | `appearanceSettings.ts` 的导航类型/有效值表、设置页和图标均保留 `desktop-pet-e`，与上游信息栏页共存。`settingsStore.ts` 保留独立偏好 helper、旧公开导出及文件树排序迁移；备份分类保留折叠与排序偏好。 |
| U2 / R3、R4 | 两种标签的真实待答覆盖抽入 `useDesktopPetETabNotifications.ts`，复用原纯函数且不修改输入。原控制器保留待答会话可见性；后台清单仍共用 `daemonTaskInventory`。新信息栏仅复用普通状态归并，不扩展到私有等待。 |
| U2 / R4 | Pi 模板、Hook 模块、daemon 私有等待出口、生命周期 helper 均相对 fork 起点未变；模板标记和 Rust 常量均为 12，超时 2_000ms。App 私有事件守卫在普通状态/Replay 之前，终端绑定前的迟到复位守卫及空闲清理保留。 |
| U2 / R3 | 文件树新首屏/头部布局与排序接线并存：只对树使用 `sortFileTreeEntries`，搜索结果沿用原顺序，写入仍通过串行偏好入口。 |
| U2 / R6 | `app_memory.rs` 保持上游原样，按进程父链、可执行路径、子命令与 daemon 登记判定；存活应用/daemon 进程树受保护。未按 Electron 名称或宠物参数扩展清理范围，也未执行进程操作。 |
| U3 / R2、R5 | 二进制、资源、Web/Tap 分别来自 `SourceDir`、`ResourcesDir`、`WebDistDir`。宠物根由资源目录派生；真实 verifier 的全部校验先于 staging/ZIP 删除；成功诊断走 stderr，stdout 保持单一 ZIP 路径。入口用真实路径比较兼容 Windows 长短路径。 |
| U3 / R5 | 两份打包回归共用完整合成 Electron fixture，调用真实 verifier；ZIP 内容按 Base64 表示的原始字节比较。新增损坏 manifest、架构、摘要、许可及短路径校验保护，覆盖失败保留旧输出。未运行这些回归。 |
| U4 / R6–R8 | 两份版本记录与 `pet-e/docs/pi-terminal-prompt.md` 已更新。上游 Web 认证源码、数据库迁移和 app_memory 边界保持原样；只读审阅不代表数据库或进程清理实测。 |

## 实际完成的静态检查

- `git diff --check HEAD`：通过；`git ls-files -u`：无输出。
- 9 份 `.mjs` 逐一 `node --check`：通过，仅解析，不导入或运行测试。
  文件为 `desktopPetEAgentBridge.test.mjs`、`desktopPetERecovery.test.mjs`、`desktopPetESettings.test.mjs`、`desktopPetETabNotifications.test.mjs`、`package-portable.test.mjs`、`petEPackage.test.mjs`、`settingsIcons.test.mjs`、`verify-pet-e-package.mjs`、`helpers/petEPackageFixture.mjs`。
- `scripts/package-portable.ps1`：PowerShell Parser 通过，未执行脚本。
- 按 UTF-8 严格解码、冲突标记和替换字符扫描：436 份已变更/新增文本在补交付文档前检查通过；补写后的 8 份任务/交付文档亦复核通过，`task.json` 解析有效。
- 169 个已跟踪变更代码文件不超过 2000 物理行，无超过 500 字符的长行；3 个新增代码文件同样符合限制。
- 关键尺寸：`useTerminalTabsController.tsx` 1999 行；`settingsStore.ts` 1982 行；新 Hook 22 行；共享打包 fixture 54 行；新标签回归 75 行。
- JSON 版本读取、导入/导出、Hook/IPC 注册、回调顺序、打包输入和错误路径完成单代理人工审阅。未发现本轮新引入的、需要继续修改的兼容问题；这不是完整类型或行为验证。

## 回归证据边界

- U1：合并与路径/版本对比为静态证据；上游测试随原历史接纳，未执行。
- U2：新增真实 React Hook 投影回归，补真实设置标签迁移入口与导航图标集合检查；修正共享清单、独立投影后的旧源码断言。已审阅关联互斥、文件树与 Pi 用例，未观察运行前失败或运行后成功。
- U3：新增完整资源和字节精确 ZIP 断言，保留校验器本体，不为测试绕过验证；未运行 PowerShell/ZIP 或 Electron。
- 简化审阅按复用、质量和效率三方面在本上下文完成，没有新增简化改动；保留已完成的独立 Hook 与 fixture 抽离。
- `ce-code-review` 独立审阅不可用：本会话没有子代理派发或内置独立 review 工具。已人工扫描交叉接点 diff，不声称多代理、多模型或独立复审通过。
- GitNexus 工具及 `.gitnexus/run.cjs` 缺失；使用项目契约与符号搜索核查调用接点，图谱影响/变更分析未执行。

## 未通过、未执行及保留风险

1. 严格架构检查不能记为通过：上一会话执行该静态检查因缺少 `typescript` 在启动阶段失败，本次确认依赖仍不存在，未安装或重跑。替代长度扫描只覆盖本轮变更，不等价于完整层级/导入检查。
2. 既有 `src-tauri/src/desktop_pet_e_agent.rs` 为 3351 行，相对 fork 起点完全未改，仍超过严格架构上限。本轮方案排除 broker 重构，保留为已知架构欠项；不得据本报告宣称全仓零超限。
3. 未执行 TypeScript 类型检查、Rust 编译/测试、前端/宠物/Web/helper 构建、完整契约测试、实机安装或便携包验收。
4. 正式标签后的 `ebcb4537` 历史页面信息栏隐藏修复未纳入，符合用户所选固定正式版范围。
5. Pi broker `/open` 服务端按 Tab 替换的乱序风险仍在；客户端响应守卫不构成服务端处理顺序证明，详见宠物外挂契约。

## 已交付结果

- 合并提交：`cc56b5ba28a48f2e29da72cc0cfae4cb57ec1643`（`merge: 同步上游 V1.5.1 并保留宠物E兼容`）。父提交分别为 fork 起点 `6395a973` 与正式版 `644cb809`。
- 提交后祖先检查确认：`644cb809` 与原 `origin/master` 均为祖先；标签后 `ebcb4537` 不是祖先，检查返回 1 符合预期。
- `git push origin HEAD:refs/heads/master` 已成功，远端从 `6395a973` 普通快进至 `cc56b5ba`。没有强推、创建 PR、发布标签或修改主 worktree。
- 合并后的工作区无已跟踪文件改动，仅保留原有未跟踪 `10-14-pi-question-adapters` 任务。本次补记仅更新任务状态及本报告，后续提交不改变实现。

## 用户后续验收

以下命令仅提供给用户在依赖齐备的集成 worktree 执行，本轮未执行。

在 worktree 根目录：

```powershell
npm run build
npm run build:pet-e
npm run check:architecture -- --strict
npm run test:pet-e:contracts
node --test scripts/package-portable.test.mjs scripts/settingsIcons.test.mjs scripts/fileTreeSort.test.mjs scripts/fileExplorerInitialLoad.test.mjs scripts/daemonTaskInventory.test.mjs
```

Windows 原生 helper 回归需要已有 MSVC/Cargo 工具链，命令会编译并执行探针：

```powershell
node --test scripts/helper-windows-runtime.test.mjs
```

在 `src-tauri` 目录：

```powershell
cargo test desktop_pet_e_ui_prompt
cargo test pi_session_lifecycle
cargo test pi_admission
cargo test hook_settings
cargo test hook_client
cargo test retired_analytics_migration_tests
```

在 `apps/server` 目录：

```powershell
cargo test --test auth_reliability
```

手工验收由用户在实际使用前执行：中英文设置页恢复、两宠物互斥、待答关注/完成撤下、本机与 WSL 的 Pi 失败后 new/resume/fork/reload、文件树排序与慢 Git 首屏、新信息栏与历史跳转、Web/Tap 登录及重连，以及 Windows 安装包/便携包资源。
预期是 Pi 空会话清旧错误、真实待答优先且只计一次，关闭普通通知不影响安全代答及正式只读等待。
打包失败应保留原 staging/ZIP，并在 stderr 可见 `desktop_pet_e_package_invalid`；成功 stdout 只包含实际 ZIP 路径。
若出现丢待答、状态无法复位或资源验证失败，暂停使用新产物，保留具体报错与会话切换步骤并用已验证旧产物恢复；不清理用户数据或强推 Git 历史。
