# Grok 受管 Home 原型验证

## 环境与结论

Windows 本机，Grok 0.2.118 (1e1687c1cf)。本轮验证时间 2026-09-10。
结论：受管 Home 的 Skills 集合、MCP 禁用列表及本地 MCP 握手具有可行性证据；不等于完整项目隔离与非扩展配置等价性验收通过。任务继续 planning。
master 与本地 origin/master 跟踪引用 0/0，未 fetch。没有修改产品代码或真实 Grok 配置，没有使用真实账号发起模型请求。

夹具：`C:/Temp/cli-manager-managed-home-probe-20260910`。原始 Home、managed-a、managed-b、managed-empty、四个假 Skill、临时项目配置及本地 stdio MCP 均位于此目录。测试脚本通过 apply_patch 建立，运行仅产生临时 CLI 状态。
脚本直接调用已安装 grok.exe，避免 npm launcher 在受管 Home 安装二进制。子进程移除继承的厂商凭据/覆盖环境，临时关闭兼容扫描开关；这只是实验控制变量，不是产品默认行为。某些诊断仍发现真实 Claude 来源，未执行其 Hook 或连接其 MCP；原始诊断正文不纳入报告。

## 实验与结果

| 项目 | 操作与观察 | 判定 |
| --- | --- | --- |
| Skills 并发集合 | Promise.all 同时启动四个 inspect；原始 ABCD、A=ABC、B=BCD、空集合全部 disabled | 发现/禁用状态通过；不是持续交互会话并发验收 |
| 初始 MCP 集合 | 无项目覆盖时，各 Home 的 enabled 控制得到 ABCD/ABC/BCD/空 | 配置发现通过 |
| 原始配置保留 | 原始 config.toml 前后 SHA-256 相同 | 本次运行通过；不代表未来产品写入协议已实现 |
| 非扩展配置 | 夹具保留 models/ui/permission/未知表/注释；去掉扩展字段后配置前缀一致；inspect permissions/loginPolicy/hooks/agents 比较一致，仅规范化来源 Home 路径 | 有限范围通过；inspect 不暴露全部模型/供应商等有效值，不能宣称完整语义等价 |
| 项目 MCP 覆盖 | 项目重新启用 D 并添加 extra；仅用户表 enabled=false 时，A 出现 D/extra，空集合也出现 D/extra | 简单投影方案失败，必须修正适配器设计 |
| MCP 禁用列表 | 受管用户配置添加顶层 disabled_mcp_servers，覆盖所有未选名称；mcp list --json 的 enabled 集合恢复 A=ABC、B=BCD、空=[] | 专用列表通过，项目文件未被修改 |
| inspect 语义差异 | 添加 disabled_mcp_servers 后 inspect 仍列出 D/extra；mcp list 返回 enabled=false | inspect 的发现列表不能充当会话有效 MCP 集合 |
| 本地 MCP 连接 | A 的 B 指向本地 Node stdio 夹具，mcp doctor probe-b --json | 退出 0，server started、handshake OK（2025-06-18）、1 tools discovered，healthy=true |
| 禁用项诊断 | A 的项目 D 先被 folder untrusted 拦截；改测 B 的用户 A，doctor 返回 server not found、退出 1 | 不能把前者当禁用证明；后者说明诊断连接候选排除 A，不等于模型会话调用验收 |
| Windows 目录软链接 | New-Item -ItemType SymbolicLink 创建临时 Skill 链接 | 失败：需要管理员权限；没有提权。该场景必须提供 Skill 复制回退，认证/历史不能直接照搬 |
| WSL | wsl --list --quiet | 退出 1，提示 WSL 未安装；未安装或修改系统功能 |
| macOS | 当前无 macOS 环境 | 未验证 |

首次非扩展结构比较因来源 Home 路径不同失败，调整为仅规范化来源元数据后通过；没有忽略权限等业务字段。

## 复现命令

在夹具目录运行：

```powershell
node run.cjs
node mcp-list.cjs
node doctor.cjs
```

run.cjs 断言 Skills 集合、非扩展子集与原始指纹；mcp-list.cjs 断言 MCP enabled 集合；doctor.cjs 输出真实连接结果（其中禁用目标原生命令退出 1 是观察结果，脚本本身不是全部验收断言）。当前夹具包含项目覆盖与顶层禁用列表，不能再以 inspect 的 MCP 名单断言启用集合。

## 源码核对：状态连续性路线

源码 commit `37949780c144e37df692e3d669051a21fec24f20` 与本机 build 不同；以下为候选设计证据，不作为本机兼容性实测。

- `crates/codegen/xai-grok-login/src/storage.rs:47` 起：auth_json_path 优先 GROK_AUTH_PATH，否则 GROK_HOME/auth.json。优先尝试将进程认证路径指向原始解析后的认证文件，保留用户原有 GROK_AUTH_PATH，而不是复制认证文件或软链接单文件。
- `crates/codegen/xai-grok-login/src/manager/lock.rs:345` 等：锁取认证路径同目录 auth.json.lock。共享认证必须同时共享锁域，避免两个 Home 各自刷新同一一次性 refresh token。
- storage.rs 写认证先临时文件再 rename，单文件 symlink/hardlink 可能被替换，不能据此保证持续共享。
- `crates/codegen/xai-grok-config/src/paths.rs:129` 起：会话根依赖 GROK_HOME/sessions。接管会改变历史定位，需另验精确共享目录、索引、恢复与写入并发，不能直接复制活动数据库。
- 同文件 grok_application_in 指向 Home/bin/grok，运行器/leader 的二进制路径也须保留，直接设置 Home 不足以证明内部子进程正常。
- 本机目录软链接权限已失败；目录 junction 等替代方案仍需单独验证，不默认当作跨平台解法。

## 更新后的技术约束

1. Skills 使用用户级 skills.disabled，MCP 使用顶层 disabled_mcp_servers，per-server enabled 只作为定义状态，不能独自保证排除项目来源。
2. 启动前完整发现所有来源，计算未选名称补集；固定补集无法阻止运行期间新增名称自动出现。热发现/插件新增仍是严格集合门禁，不能只测试 ABCD 就声称任意来源隔离。
3. 同名 MCP 被项目重新定义时，名称匹配不等于原资源身份匹配；必须验证最终 command/url/source 与选中资源一致。当前 B 中 D 的定义来自项目覆盖，不能声称资源内容也按全局定义隔离。
4. 原始 Home 的非扩展配置、兼容开关、认证、历史等须按用户要求保持原有效行为。实验关闭兼容开关、使用有限字段，不构成完整继承实现。
5. 用户确认的启动快照时机不变；原型尚未完成长驻进程配置变化/重连/恢复实验。

## 未通过的交付门禁

真实登录与令牌刷新；历史新增/索引/resume；持久进程及 leader/socket；Skill 真实调用和插件单项过滤；动态新增来源；同名资源定义冲突；相对路径与完整非扩展配置等价；Windows 复制/历史共享替代；macOS/WSL。
本轮无专用测试账号，未复制或共享用户真实认证文件；没有为了完成验证擅自登录、刷新凭据或使用真实账号计费调用。
下一步可继续做无凭据的路径/状态结构原型；真实认证连续性最终需要专门测试登录环境，跨平台验收需要对应执行环境。

## 官方来源

- https://docs.x.ai/build/settings/reference ：GROK_HOME 同时影响 config/auth/sessions/skills/plugins/logs；项目层配置限制。
- https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-login/src/storage.rs
- https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-shell/src/util/config/mcp.rs
