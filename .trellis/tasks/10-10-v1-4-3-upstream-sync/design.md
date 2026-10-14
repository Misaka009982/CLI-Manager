# 技术设计

## 基线、来源与执行方式

- 工作区：D:/Project/pi-pet/CLI-Manager/.worktrees/ship-desktop-pet-e-master。
- fork 基线：443822a1d4cde86d888c169a94ffadffb82384f7；联网核对 origin/master 与其一致。
- 合并基点：V1.4.2 提交 917437d1546c75997f6120339e948305b93907ad。
- V1.4.3 标签对象：b93fc60baa8a114c38145744d765f5ff80d276f1；目标提交：c07e69eed3842a69ab5e39d10b166bb3a84f6610。
- 上游增量：9 个提交、58 个文件，新增 2383 行、删除 381 行；无文件删除或重命名。
- 使用 integrate/v1.4.3-desktop-pet-e，新建分支但继续使用既有 worktree。
- 当前会话直接执行；没有启用的外部执行引擎配置，也无可调用的子代理/GitNexus 工具。影响分析使用 Git 双侧差异、领域契约及符号引用，不安装工具。

## 合并边界

fork 相对 V1.4.2 有 98 条差异路径，其中 63 条为独占新增；上游未触碰任何独占新增路径。共同修改仅为 CHANGELOG.md、docs/功能清单.md、package.json 和 features/hooks/settings/pi.rs。

以正常双父 merge 保留上游历史。版本记录及功能清单取双方内容，package.json 保留 fork 脚本并采纳上游版本。禁止简单整文件选一侧掩盖模板移植需求。

## Pi 外部模板兼容

上游对 pi.rs 的行为变化只有生命周期 payload 新增 wslDistroName，读取 nonEmpty(process.env.WSL_DISTRO_NAME)。fork 的 pi_extension_source 使用 include_str! 读取外部模板，因此必须在 src-tauri/src/pi_extension_template.ts 的 postHook 实际生产边界补入相同字段。

保持 REQUEST_TIMEOUT_MS=2000、sourceInstanceId、remoteEventId、单调事件时间戳、第三方对话框接管、问题组自绘和竞速逻辑。版本常量与模板头同步从 7 升到 8；不动已安装的用户文件，由既有受管版本检查在新版应用中完成升级。

上游新增 scripts/wslHookIdentity.test.mjs 假定 Pi 源码仍内联在 Rust raw string。调整为读取 pi.rs 的 include_str! 实际目标并展开 fork 占位符；只在测试沙箱中提供 schema/TUI/计时器等依赖边界，等待异步生命周期回调，不发送网络请求或创建真实 Pi 会话。保留原 WSL 身份断言，不能删掉 Pi 用例绕过兼容问题。

## 场景与风险

- 本机/WSL：发行版为当前 guest 身份或 null；多发行版和空白输入不能使用默认值替代。
- 多终端/分屏/Worktree/恢复：采用上游 Codex --no-daemon 隔离，保留 provider/profile 参数；旧 PTY 的端口、令牌和 WSLENV 不会热更新。
- SSH：维持上游远端 bootstrap 的独立启动策略；显式 --remote 和用户自定义脚本不被重新解释。
- 宠物气泡/终端双端交互：实际答案协议、broker epoch、取消与心跳协调均不变，仅生命周期元数据扩展。
- 窗口焦点/托盘/最大化：window_state.rs 及宠物E协调器未被上游修改，做内容保留核对，不声称已完成 GUI 验收。
- 文件排序：仅文件树、目录优先、递归、不修改原树、串行设置保存的模块保持不变。
- Codex 必须支持 --no-daemon；不自动安装或降级为无效的 daemon_auto_start 配置。

## 回退边界

443822a1 为合并前参考点。不执行 reset、clean、强制 checkout 或自动清理；若出现未预期的用户改动、fork 资产丢失或无法确认的契约冲突，保留现场并报告。
