# 实施方案：同步 V1.5.1 正式版

## 目标与授权

需求及技术依据见同目录 `prd.md`、`design.md`。
用户已确认创建任务、抓取上游并按正式标签规划；尚未授权本轮合并、提交或推送。
方案落盘并审阅后询问实施与交付方式。确认实施后，从 `6395a973` 分出 `integrate/v1.5.1-desktop-pet-e`，固定合入 `644cb809`，不修改主 worktree。
如确认推送，目标为 `origin/master` 普通快进；不创建 main、发布标签或 PR，不更改默认分支。

## U1：合入完整正式版与保留现场

- 对应需求：R1、R2、R7；依赖 KTD1、KTD2、KTD7、KTD8。
- 文件范围：固定上游完整差异，重点为设计中的 19 个交叉路径；新增/删除及移动文件依各自上游来源接纳。
- 方式：普通三方合并，逐块核对；不二次改写上游功能，不全库取 ours/theirs，不恢复已退役实现。
- 场景：
  - 上游共有旧记录迁移到 research，fork 独有任务及当前三份方案仍存在。
  - 旧未跟踪 `10-14-pi-question-adapters` 未暂存，主 worktree 保持原状。
  - 应用和独立 helper 元数据一致为 1.5.1；fork 的 Windows 宠物构建与发布配置仍在。
  - 合并后上游固定目标成为祖先，标签之后的 master 提交没有成为祖先。
- 验证：差异可追溯、无未合并项、没有错误带入标签后改动；保留官方 ccusage/任务引擎退役及其历史迁移。

## U2：接齐设置、状态与排序消费入口

- 对应需求：R3、R4、R6；依赖 U1 与 KTD2、KTD3、KTD6。
- 文件：`src/shared/preferences/appearanceSettings.ts`、`src/shared/preferences/settingsSections.ts`、`src/shared/preferences/settingsStore.ts`、`src/shared/preferences/desktopPetEPreferences.ts`，`src/features/settings/api/SettingsModal.tsx`、`src/features/settings/components/SettingsIcons.tsx`、`src/features/sync/lib/syncSettings.ts`，设计中的终端/App/文件入口，以及 `scripts/desktopPetESettings.test.mjs`、`scripts/desktopPetEMutualExclusion.test.mjs`、`scripts/settingsIcons.test.mjs`、`scripts/fileTreeSort.test.mjs`、`scripts/fileExplorerInitialLoad.test.mjs`、`scripts/piSessionLifecycle.test.mjs`、`scripts/desktopPetStatus.test.mjs`、`scripts/daemonTaskInventory.test.mjs`。
- 方式：
  1. 宠物E标签进入上游新导航类型和有效值表，保留旧 settingsStore 公开导出，避免重复类型或强制转换遮住遗漏。
  2. 宠物E偏好仍由独立 helper 迁移/校验；终端标签待答覆盖仍在终端域 helper，共享任务清单不重新变成私有轮询。
  3. 保留 Pi 复位守卫、私有事件提前返回、明确 none 消费；接纳新子代理缓冲及历史跳转但不把私有等待塞入 Replay。
  4. 文件树首屏和稳定头部布局按上游接纳，保留排序 UI 与串行偏好入口，中英文合并。
  5. 更新图标集合和持久化标签回归；仅为实际兼容改动补夹具，不为所有上游功能重写测试。
- 场景：
  - 重新加载设置仍恢复 `desktop-pet-e` 页面；新信息栏页面及原状态栏设计器也可进入。
  - 两宠物同时启用的旧偏好只停用宠物E，样式/折叠不丢；双向互斥在写盘前执行。
  - Pi 失败后 new/resume/fork/reload 复位为空闲，旧回调和旧 daemon 快照不覆盖新运行或待答。
  - 原宠物与新信息栏复用解析器时明确 none 不回退运行；新信息栏仍遵守上游普通状态口径，不宣称包含宠物私有等待。
  - 后台查询失败保留最近成功任务，禁用不投影缓存；真实待答标签关注覆盖继续生效。
  - 慢 Git 首屏先显示树，切换项目/Worktree 后旧 Git 不回填；树排序不改变搜索结果。
  - 存活 Electron/renderer、已登记 daemon 与普通用户终端不进入内存清理范围；仅作判定审阅，不执行清理。
- 验证：新导入/导出可定位，薄接线语义与既有契约一致；模板内容未改时保持 Pi 12/12，若必要修改则按 R4 同步升版，2 秒超时不变。超过 2000 行时优先利用现有职责模块，不压缩空白绕限。

## U3：合并便携资源修复与宠物验证

- 对应需求：R2、R5；依赖 U1 与 KTD4、KTD5。
- 文件：`scripts/package-portable.ps1`、`scripts/package-portable.test.mjs`、`scripts/petEPackage.test.mjs`、`scripts/verify-pet-e-package.mjs`；必要时新增小型共用测试 fixture，复用现有完整 PE/manifest/许可输入而不复制生产校验实现。
- 关联只核对：`scripts/prepare-bundle-binaries.mjs`、`scripts/prepare-helper-binaries.mjs`、`src-tauri/helpers/{Cargo.toml,Cargo.lock,build.rs}`、`.github/workflows/release.yml` 与 fork Tauri 配置。
- 方式：
  1. 接纳 SourceDir/ResourcesDir/WebDistDir 分离和仓库根解析；宠物资源根由 ResourcesDir 派生。
  2. 输入及宠物包校验全部先于旧 staging/ZIP 删除；保留严格验证，确保诊断可见且 stdout 只有 ZIP 路径。
  3. 上游真实 PowerShell/ZIP 夹具补齐可验证宠物资源和 verifier；预期 ZIP 使用字节精确比较，覆盖 Electron 二进制，不以 UTF-8 文本转换掩盖复制损坏。
  4. 对齐旧宠物打包源检查的新路径接线，保留 Windows helper → 宠物构建 → runtime 准备顺序。
- 场景：
  - 干净 Cargo 二进制目录无资源副本，仍从正式生产者打出 Classic Web、Tap、ConPTY、SSH 与完整宠物资源。
  - Cargo 中存在过期副本时忽略它，读取显式默认/自定义资源与 Web 输入。
  - 相对/绝对路径、空格、大小写、8.3 别名均解析正确，stdout 可作为真实 ZIP 路径直接消费。
  - 缺少任一必需文件、缺 manifest、错误 PE 架构或摘要不一致，旧 staging 与 ZIP 保持不变并报告可见错误。
  - 重复打包只替换约定输出；自定义来源不存在时不回退到其他目录。
- 验证：生产者与输出契约源码自洽；由用户运行新增测试，执行实际 PowerShell 入口和实际 verifier，使用隔离的合成二进制/文件输入，不安装、下载或启动 Electron。
- 执行方向：发布可用性最终需用户做 Windows helper/安装包/便携包实机验收，单靠文本契约不能替代。

## U4：静态审阅、记录与授权交付

- 对应需求：R1–R8；依赖 U1–U3、KTD8。
- 文件：`CHANGELOG.md`、`docs/功能清单.md`、`pet-e/docs/pi-terminal-prompt.md` 的同步接点说明、本任务 `verification.md` 与 `task.json`；其余仅针对已发现集成问题修正。
- 文档：在 V1.5.1 段记录完整同步和 fork 补接，不删除旧版本历史；如实说明模板是否改变和未纳入的标签后修复。
- 审阅：按差异审查设置迁移、IPC/Hook 注册、回调顺序、模板版本、打包输入与错误路径。当前没有子代理/GitNexus 能力，不将单代理阅读描述为独立复审。
- 场景：远端 master 不变则可快进；若执行前或推送时远端已变，不强推或擅自 rebase，报告差异等待授权。
- 验证：静态结果与未运行检查分开记录，提交只包含本轮集成和明确方案，不携带旧未跟踪目录；仅执行用户确认的交付方式。

## 静态验收契约

| 项目 | 本轮要求 |
|---|---|
| Git | 固定祖先正确、无未合并项/冲突标记/空白错误，fork 独有文件保留 |
| 编码和结构 | 新增/修改文本 UTF-8，变更手写模块不超过 2000 物理行，无无关格式化 |
| 公开契约 | 设置有效值、图标映射、类型导出、IPC 注册、Pi 旁路与后台清单接线完整 |
| 模板 | 未改内容时保持 v12；若必要内容变化则同步提升模板/Rust 常量和断言，仍保留 2 秒超时 |
| 版本和依赖 | 应用/helper/Windows 资源 1.5.1 一致，接纳官方压缩依赖和 echarts 退役，不运行安装 |
| 脚本 | 仅 Node 纯语法检查与 PowerShell Parser；不执行打包或测试入口 |
| 数据与安全 | ccusage 迁移限定专属缓存，上游 Web 认证源码边界保留，不访问本地凭据/数据库，不执行内存优化 |
| 交付 | CHANGELOG/功能清单及 verification 一致，授权和远端目标明确，未执行项不计为通过 |

## 用户后续运行验收

用户在依赖齐备的集成 worktree 执行前端及宠物构建、严格架构检查、宠物E契约、新便携打包/图标/文件树首屏回归，以及 Pi 接纳/会话生命周期/只读等待、Hook 设置和客户端 Rust 回归。
上游 Web `auth_reliability`、数据库 `retired_analytics_migration_tests` 与 Windows `helper-windows-runtime` 回归应另外执行；相关命令及适用条件在最终 verification 中列出，本阶段不运行。

手工核对中英文设置恢复、两个宠物互斥、Pi 切换及旧错误复位、文件树排序与慢 Git 首屏、终端新信息栏和历史跳转、Web/Tap 连接，以及 Windows 安装/便携资源。
Pi 模板保持 v12 时不要求仅因版本号变化重装 Hook；应用/daemon 回调环境变化仍须重新创建 PTY。没有安装产物验收前，不宣称发布可用。

## 完成标准

U1–U4 实现和静态证据完整，已知交叉断点处理，交付方式按本轮确认执行。
运行验收、正式发布、第三方自绘代答和 broker 服务端乱序不属于本轮静态完成范围。
