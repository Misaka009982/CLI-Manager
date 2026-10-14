# Claude 答后清除：静态核查记录

## 结果

已在 a131b93d 上完成源码修复。没有修改已安装的 Claude/Pi 配置，没有修改 rpiv，没有执行编译、测试、应用或服务，也未推送。

### 根因

实际 Claude 配置缺少 PostToolUse，原安装器只有 Subagent 模块提供工具结束回调；仅安装 Attention 后能产生待处理项，却收不到答后清理事件。旧 broker 测试直接注入 ToolStop，未覆盖安装前置。

### 最终实现

- Attention 独立安装 PostToolUse / PostToolUseFailure -> DesktopPetEComplete。
- 完成事件仅在 Claude 来源下接纳；先通过原 HTTP 鉴权、验证和去重，再由独立消费器调用 broker，返回 204，不进入普通通知或子任务界面。
- Subagent 的原有进度事件不变；两个模块只卸载自己的回调，问答的 PreToolUse 入口不再被子任务卸载连带删除。
- 旧配置缺少专用回调时，Attention 健康检查报告未完整安装；完整命令尾部匹配保留名称相近的第三方命令。
- broker 的匹配与已提交待确认规则没有改动；不新增对转圈文字、普通输出或进程存活的猜测。

## 静态检查

- `git diff --check`：通过。
- `node --check scripts/desktopPetEAgentBridge.test.mjs`：通过，仅解析语法，没有运行用例或导入生产代码。
- 5 个修改/新增 Rust 文件的字符串、原始字符串、注释与括号边界启发式扫描：通过；不是 Rust 编译或类型检查。
- UTF-8 / CRLF 核查：通过；Rust 行数为 settings/mod.rs 1972、settings/claude_completion.rs 260、client.rs 956、claude.rs 1930、desktop_pet_e_completion.rs 155，均低于 2000 行。
- 人工核对模块相对路径、crate 命名空间、可见性、常量复用、事件白名单和早返回位置；没有新增依赖、端口、Tauri IPC 或答案格式。
- broker、Pi 模板、pet-e/、App.tsx、窗口记忆、文件树排序及 alpha-release.yml 与本轮基线无差异。

## 回归用例（已写，未运行）

- 安装模块 11 个 Rust 用例：问答/子任务单独安装、两种顺序与幂等、两种卸载方向、全部清理、Windows/WSL 命令、相似命令保留、错误 matcher 和缺项升级、健康状态、全量卸载。
- 后端消费器 5 个 Rust 用例：来源接纳、其他事件不消费、问题/Agent/Task ID 保留、匹配清理及重复完成幂等、已提交待确认保护。
- 现有 Node 契约新增安装与内部消费连线检查：消费必须位于鉴权/验证/去重之后，且在普通处理前返回，防止误入 UI。

## 定向人工审查

范围仅本次修复文件及新增模块，不审查/重写上游合并内容或旧 Pi 方案现场。没有可用的实现/审查子代理，advisor 未返回有效结果，不宣称独立模型审查通过。

- 复用：使用现有安装命令生成、输入归一化、鉴权、去重和 broker；专用清理没有套用会匹配相似名称的通用子串删除。
- 正确性：发现共享普通 ToolStop 会进入 App.tsx 的子任务界面，已放弃该未提交中间方案，改为内部事件；没有修改前端去隐藏副作用。
- 测试：没有依赖整份配置条目顺序断言幂等，只锁住命令唯一性和归属；显式覆盖只安装 Attention 的回归。
- 可靠性：私有事件消费后不经过普通 sink；失败工具同样产生结束证据，未确认的宠物答案仍由原 broker 保护。
- 维护性：新增逻辑放在两个独立模块；共享文件只有接线、白名单、健康检查和卸载范围的针对性修改。

## 待用户运行验收

```powershell
cargo test --manifest-path src-tauri/Cargo.toml claude_completion
cargo test --manifest-path src-tauri/Cargo.toml desktop_pet_e_completion
node --test scripts/desktopPetEAgentBridge.test.mjs
npm run test:pet-e:contracts
```

需要更新应用与对应 daemon，再重新安装 Claude 问答/提醒模块并重开会话；旧 daemon 不认识新内部事件。重启前先保存仍在运行的任务。

重点检查：只开问答模块，CLI 完成 AskUserQuestion 后宠物待处理项消失；不新增子任务分屏或完成通知。启用/卸载子任务模块后重复检查。身份缺失、回调未送达或 SSH 独立安装链路不在本次根因修复的验证结论内，不能凭“正在运行”强制当作已回答。
