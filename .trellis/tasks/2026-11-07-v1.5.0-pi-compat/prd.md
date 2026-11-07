# 同步 CLI-Manager V1.5.0 并适配 Pi 1.5.0

## 目标与基线

将上游 V1.5.0 合入保留宠物E的 fork，并按官方 Pi 1.5.0 的实际接口完成必要适配。
本任务遵守既有三份方案约定：本文件定义需求，`design.md` 定义边界与证据，`implement.md` 定义实施及静态验收。

- fork 基线：`2388905dfe4bb26d56484d89d1978a0d7e303c85`，分支 `integrate/v1.4.4-desktop-pet-e`；远端 `origin/master` 与基线相同。
- 上游：`V1.5.0` 标签解引用与 `upstream/master` 均为 `50e0f17fc70d2bc34b587de1b99d92f3deaa6a13`。
- 上次上游基线：`2991fd4b`。本次上游净差异涉及 2075 个文件，包含旧 Trellis 归档和 cc-connect 的移除；fork 与上游同时改过的路径有 30 个，实际冲突待合并确定。
- 本机 Pi 启动器的 `install/current-version` 为 `1.5.0`；已读取该发行包的声明、实现和变更记录，未执行启动器。
- 目标分支：从 fork 基线创建 `integrate/v1.5.0-desktop-pet-e`，继续使用现有集成 worktree。

## 需求

| 编号 | 要求 | 验收依据 |
|---|---|---|
| R1 | 合入上游 V1.5.0 完整历史与功能，包括 Tap Web、终端恢复及内存修复、设置样式、cc-connect 退役；版本保持 1.5.0 | 上游提交成为祖先，冲突清零，版本文件一致 |
| R2 | 保留宠物E、Claude 问答完成旁路、Pi 三通道、文件树排序、设置折叠偏好及 fork 发布入口 | 共有文件只保留薄接线，外挂文件及必要导出可解析 |
| R3 | 保留 v11 对 new/resume/fork/reload 的租约交接、过期回调守卫、明确空闲复位、历史时间仲裁及 WSL 身份 | 对应生命周期、状态与只读等待回归仍自洽 |
| R4 | 按 Pi 1.5.0 的 custom 选项为自有问答界面声明阻塞状态；继续使用正式 UI 生命周期做独立只读黄灯，标准 select/confirm/input 按原能力代答 | blocked 与 ui_prompt 通道语义明确，未扩大第三方自绘代答 |
| R5 | 核对 schema 与 SDK 使用，保留标准 JSON Schema 和宿主提供的 typebox；将可选官方 SDK 兼容夹具对齐 1.5.0 | 不依赖失效的 TypeBox 非 JSON 特性，不增加项目运行依赖，不自动安装 Pi |
| R6 | 接纳上游移除旧远程托管类型与新增 helper 构建流程，并补齐 fork 的必要消费/打包兼容 | 无悬空 remoteHandoff 引用，Windows helper 与宠物E打包都可达 |
| R7 | 更新 V1.5.0 段 CHANGELOG、功能清单及外挂契约；修改模板时同步升至 v12 | 模板标记、Rust 常量及断言一致，2 秒请求超时保留 |
| R8 | 仅静态核查，不编译、运行测试、安装依赖、启动服务或修改已安装副本 | 交付明确区分静态结果、已写夹具与用户尚需运行的验收 |

## 范围边界

上游已有功能及其删除按同步范围接纳；不主动删除 fork 独有历史、未跟踪的 `10-14-pi-question-adapters` 或主 worktree 的遗留修改。
不修改 Pi、rpiv、用户已安装 Hook 或任何认证配置，不开启新的端口或通知通道。
不增加第三方 custom 的答案回填，不修改答题 broker 协议；已知 `/open` 服务端处理乱序风险继续记录。
不运行发布构建、不创建发布标签。提交和推送方式在实施确认时确定；未获本轮明确授权不推送。

## 场景要求

- 本机 PowerShell/CMD/Pwsh 与 WSL；SSH 保持现有能力边界，不接入私有只读等待。
- 单会话、多会话、连续 new、resume/fork、同 ID reload、旧工厂和迟到 HTTP 回调。
- 前台、另一窗口、托盘、后台存活会话、不同分屏与 Workspan；状态不由焦点推断。
- 标准对话框、第三方自绘、管理器自有 question/questionnaire；用户作答、宠物先答、取消、重叠提示及异常收尾。
- 宠物总开关、普通通知开关、问题交互开关与 Hook 子模块分别关闭。
- Pi 空闲不复活旧红蓝历史，真实 pendingAction 始终优先。
- 主仓库和 `.git` 为文件的 worktree；Windows helper 打包同时保留 Electron 资源与 Tap 资源。

## 完成标准

上游同步、Pi 适配与 fork 薄接线完成；静态检查无未处理冲突、明显缺失导入/导出或版本矛盾；文档列明未运行的验收和剩余风险。
不能将静态完成等同于运行验收或发布可用。
