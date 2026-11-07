# 实施方案：V1.5.0 同步与 Pi 适配

## 实施授权与交付

需求及设计见同目录 `prd.md`、`design.md`。已获用户同步上游及适配新版 Pi 的任务授权；本轮包含大批上游文件删除，实际合并前确认方案与交付方式。
沿用现有集成 worktree，从 `2388905d` 创建 `integrate/v1.5.0-desktop-pet-e`；不切换或修改主 worktree。
按用户本轮最终确认，完成本地集成提交后普通快进推送 `HEAD:master` 至 `origin`。不创建 main，不更改默认分支，不强推、不发布构建、不安装、不运行服务或测试。

## U1：合入上游发布

- 对应需求：R1、R2、R6；依赖 KTD1、KTD2。
- 范围：V1.5.0 的完整变更，重点是设计发现清单列出的 30 个交叉路径及其调用者。
- 方式：执行普通 merge，逐块保留双方意图；接纳上游 cc-connect 和旧归档退役，保留 fork 独有任务与外挂文件。
- 重点检查：settings tab/icon 映射、daemon 私有旁路、Hook client 的仍有效调用者、Windows helper 与宠物E打包顺序、Tap 资源。
- 集成补充：宠物E复用上游共享后台任务清单；为满足 2000 物理行限制，将偏好迁移/互斥放入 `desktopPetEPreferences.ts`，待答状态覆盖放入终端域 `desktopPetETabNotifications.ts`，原入口保留显式接线及兼容导出，不跨层引入新依赖。
- 场景：合并冲突清零；无冲突文件不引用已删契约；普通宠物与宠物E均识别明确空闲；原排序和偏好仍有持久化入口。
- 验证：固定上游目标，差异来源可解释，所有必要注册/导入/调用路径存在。无关上游实现不二次重构。

## U2：适配 Pi 1.5.0

- 对应需求：R3、R4、R5、R7；依赖 U1 与 KTD3–KTD6。
- 文件：`src-tauri/src/pi_extension_template.ts`、`src-tauri/src/features/hooks/settings/mod.rs`、现有 Pi 回归脚本与必要独立兼容夹具。
- 方式：为自有 question/questionnaire 的 inline custom 提供 blocked 描述；保留正式 ui_prompt 旁路，校准注释和类型边界；模板版本同步升为 12。
- schema：现有标准 JSON Schema 原样保留；审阅执行入口仍能处理校验后的值，不依赖 TypeBox 私有 refine/codec。
- 场景：正常答案、自由输入、取消、宠物先答触发终端收起、重叠 UI、旧会话迟到回调、模块重载序号与空闲复位。
- 验证：对照 1.5.0 官方声明和实现，证明每项改动的必要性；不执行 Pi，不从已安装依赖运行测试。

## U3：补齐回归与集成交付

- 对应需求：R2、R3、R5–R8；依赖 U1、U2。
- 文件：`scripts/piHookSdk.test.mjs`、`piHookLifecycle.test.mjs`、`piDesktopPetHook.test.mjs`、`desktopPetEState.test.mjs`、必要打包/设置契约脚本、`package.json`。
- 官方 SDK：将固定目标与定位说明对齐 1.5.0；检查导出、ModelRuntime 和扩展工厂契约。保留隔离目录与内存模型，未提供 SDK 明确跳过，显式配置错误不静默跳过。
- 有意义的回归：覆盖 blocked 的实际参数、custom 完成/取消语义、正式 UI 事件独立、标准 schema 验证，以及 helper/Electron/Tap 打包接线；不为无行为文案改动增加测试。
- 文档：更新 V1.5.0 段首、外挂接点与升级步骤，交付记录单列冲突取舍、静态证据、未运行项目与残余风险。

## 静态验收契约

| 项目 | 要求 |
|---|---|
| Git | 无未合并项、无冲突标记、diff 空白检查通过；上游成为合并结果祖先 |
| 编码与结构 | 新增/修改文本为 UTF-8；仅自有修改适用 2000 物理行约束，不擅自重写上游历史 |
| 类型与接口 | 新增导入可定位、移除字段的消费端已处理、Rust 构造器与模块可见性按源码核对 |
| 版本 | npm/Tauri/Cargo 1.5.0 一致；Pi 模板与 Rust 升级常量均 12；超时仍 2 秒 |
| 回归 | 测试断言与模板/接口自洽，标记为已编写而非已通过 |
| 隔离 | 私有只读事件与问答完成在普通 sink 前消费；真实待答不被只读状态替换 |
| 交付 | CHANGELOG 与功能清单同步，提交推送按用户确认边界，未动旧现场 |

## 用户后续运行验收

由用户在依赖齐备的集成 worktree 执行前端构建、宠物E构建、宠物E契约、架构检查，以及 `pi_session_lifecycle`、`pi_admission`、`desktop_pet_e_ui_prompt`、`hook_settings`、`hook_client` Rust 回归。
可选官方 SDK 回归需指向完整 1.5.0 安装根目录，不能把缺失 SDK 的跳过算作兼容通过。
更新应用后升级托管 Hook 到 v12，再重启或 reload Pi；仓库改动不会热更新已安装副本。

## 完成标准

U1–U3 的实现和静态证据完整，所有明显集成断点已处理；未运行的检查如实列出。
运行验收、发布打包和服务端 broker 请求乱序留在明确交付边界之外。
