# CCS 路由迁移实施进度

> 本文件是当前任务的跨机器执行指针，不替代 prd.md、design.md、implement.md 和 research/。P0、P1-01 至 P1-08 已完成，当前指针为 P1-09。

## 0. 当前指针

| 字段 | 值 |
| --- | --- |
| Task | 08-08-ccs-routing-migration |
| task.json 状态 | in_progress（P0、P1-01 至 P1-08 已完成，当前指针为 P1-09） |
| Changelog Target | [TEMP] |
| 当前阶段 | P1：本地路由 |
| 当前 Case | P1-09 |
| 审批状态 | 已批准；P1-08 完成，按 Case 顺序切换至 P1-09 指针 |
| 最后更新时间 | 2026-08-09 03:25 |
| 最后操作机器 | DESKTOP-Q49I074 |
| 分支 | feat/native-provider-management |
| 工作目录 | F:/github/CLI-Manager |

## 1. 执行规则

### 1.1 状态枚举

- pending：尚未开始。
- in_progress：当前正在处理；全文件最多一个 Case 可处于此状态。
- completed：实现、验证和必要文档均完成，并已写入完成证据。
- blocked：存在明确外部阻塞；备注必须写明阻塞原因、复现方式和解除条件。
- skipped：经审批明确不做；备注必须写明替代方案或后续版本。

### 1.2 Case 完成门槛

完成一个 Case 后，必须同时更新：

1. 实现和针对性验证完成后，Case 继续保持 in_progress，不得直接标记 completed。
2. 至少执行两轮独立 Review：第一轮检查正确性、数据流、信任边界、安全和数据损坏风险；第二轮检查 PRD/设计一致性、场景矩阵、回归、跨平台、i18n/a11y 与测试缺口。
3. 任一轮发现问题后必须先修复并重新验证，连续“零未解决发现”的轮次重新计数；只有连续两轮 Review 均为零发现时才允许提交。
4. Review 必须记录轮次、检查范围、发现、修复和复验命令；不得用“已看过”代替证据。
5. 一个 Case 对应一个代码提交；提交应同时包含该 Case 的代码、测试和进度状态，提交前不得有未解决 Review finding。
6. 对应行改为 completed，并记录完成时间、操作机器、修改文件、验证结果、Review 轮次、提交主题和下一步。
7. 执行日志追加一条记录，并把下一个 Case 改为唯一的 in_progress。
8. 若发现需求变化，先更新 prd.md、design.md 或 implement.md，再继续，不在代码中隐式改变边界。

规划文档、research 和截图基线不计作生产实现 Case 的完成证据；仍须满足验证、连续两轮零发现 Review 和独立提交门槛。

### 1.3 跨机器续做协议

切换机器后按以下顺序恢复：

1. 确认分支和工作树：rtk git status --short、rtk git branch --show-current。
2. 同步远端：rtk git fetch --prune，确认是否有未纳入进度日志的提交。
3. 阅读本文件的当前指针和最后一条执行日志。
4. 只把当前 Case 改为 in_progress；先完成其前置依赖，不跨 Case 并行修改。
5. 修改任意函数、方法、组件或命令前，先按仓库要求运行 GitNexus upstream impact，并记录风险。
6. 每次交接前更新机器、时间、验证证据和下一步；不提交、不建分支，除非用户另行要求。

## 2. 四个模块与 CCS 开关对应关系

| 模块 | CCS 控件/开关 | CCS 行为 | CLI-Manager 实现边界 | 主要 Case |
| --- | --- | --- | --- | --- |
| 本地路由 | 服务总开关、监听地址、首选端口、应用接管、记录请求用量 | 启停本地 HTTP route service，将各 CLI Home 的 provider-owned 配置投影到本地 endpoint，并显示真实运行状态 | daemon 托管 listener；只允许 loopback；WSL 仅允许 mirrored localhost 或经精确校验的 NAT host-gateway；端口回退固定为 15721-15799；Windows 本地、Windows WSL、macOS 本地均为首版范围 | P1-01 至 P1-15 |
| 自动故障转移 | 每应用启用、provider 入队、最大重试、超时、失败阈值、HalfOpen 恢复、重置熔断器 | 按 provider catalog 顺序切换，维护队列和 Closed/Open/HalfOpen 状态 | 先执行同 provider enabled key 池；401/403/429 且响应尚未提交时先换同 provider key，key 耗尽后才切 provider；direct/scope/CLI Live 继续使用手动 active key | P2-01 至 P2-07 |
| 全局出站代理 | 启用、HTTP/HTTPS/SOCKS5/SOCKS5H URL、用户名、密码、扫描、测试、清空、保存 | 为 CCS 外部 HTTP 请求建立可热更新的共享 client | 密码只进 credential store；复用现有 reqwest client 构造；明确排除 CC Connect、SSH host proxy、Tauri updater/WebView；本地 route upstream 也使用全局代理但自环地址除外 | P3-01 至 P3-05 |
| 整流器 | 总开关、Thinking signature、Thinking budget、媒体降级、纯文本模型预判 | 针对已接管请求修复特定上游能力或字段错误，每条规则最多一次重试 | 只在 route 已接管的 request 上生效；关闭总开关时保留子开关但不执行；Bedrock thinking/cache 只对 effective Bedrock provider 生效 | P4-01 至 P4-06 |

### 2.1 入口与供应商维护提示

- 路由菜单固定放在：设置 -> 供应商 -> 供应商目录 / CLI HOME / 路由。
- 路由页与现有供应商目录、CLI HOME 同级，不新增设置顶级页签。
- 供应商维护弹框中的所有模型映射区域必须明确标注：仅在开启路由后生效；关闭路由时不重写请求模型。
- 例如 Codex provider 的 a（显示名称） -> b（实际请求名称）：路由开启后，route daemon 收到 a 时向该 provider 发 b；每次 provider/key attempt 都从原始请求模型重新计算。
- mapping 的 source 精确、大小写敏感匹配；重复 source、空 source 或空 target 在保存前拒绝。
- Body Override 与 mapping 同时存在时，最终 upstream model 由 mapping target pin；failover 切换 provider 时重新使用新 provider 自己的 mapping。

## 3. Case 总览

| 阶段 | 范围 | Case 数 | 当前状态 |
| --- | --- | ---: | --- |
| P0 | 影响分析、Schema、协议、Fixture 基线 | 4 | completed |
| P1 | 本地路由、端口、三平台、writer、daemon、HTTP、mapping、多密钥、UI | 15 | P1-09 in_progress |
| P2 | 队列、熔断、provider/key failover、流提交、热切换 | 7 | pending |
| P3 | 全局出站代理 | 5 | pending |
| P4 | 整流器与 Bedrock 优化 | 6 | pending |
| P5 | 跨平台、质量、i18n/a11y、许可、最终验收 | 6 | pending |
| 合计 |  | 43 | 12 个 Case 完成；P1-09 等待续做 |

## 4. P0：影响分析、Schema、协议与 Fixture 基线

| ID | 目标 | 前置依赖 | 实现触点 | 验收命令/场景 | 回滚点 | 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0-01 | 锁定 provider、daemon、Home、writer、HTTP、UI 全链路触点并完成 upstream impact | 无 | src-tauri/src/provider、src-tauri/src/daemon、settings、sidebar、对应 spec | get_context phase 2.1；GitNexus query/context/impact；记录 HIGH/CRITICAL blast radius | 仅撤销分析记录，不碰生产文件 | completed | 2026-08-08 21:11；R1/R2 findings 已修复，R3/R4/R7/R8B 连续零发现；独立提交主题见执行日志 |
| P0-02 | 以 additive 方式完成 provider DB v2 routing settings、request logs 和索引迁移 | P0-01 | provider/database.rs、migration.rs、repository/support.rs | fresh v1 升级、future schema、迁移中断、失败降级；针对性 Rust tests | 忽略 routing v2，恢复 v1 读取；保留 provider/key 数据 | completed | 2026-08-08 22:14；9 database tests、4 migration tests、123 provider tests 与 cargo check 通过；R1/R2 findings 修复后 R3/R4 连续零发现 |
| P0-03 | 建立脱敏 JSON/SSE、Responses SSE、协议转换和整流器 fixture | P0-01 | route adapter tests、fixture 目录、request log 脱敏断言 | Claude 四类 apiFormat；Codex/Grok 三类 wireApi；tool/reasoning/media/usage；提交边界 | 未覆盖格式标记 unsupported，不静默 passthrough | completed | 2026-08-08 23:03；10 格式均含 JSON/SSE，5 stream、mapping、12 rectifier 与 schema-v2 日志样本；5 focused、123 provider tests、cargo check 通过；R1/R2 修复后 R3/R4 连续零发现 |
| P0-04 | 定义 local_routing_v1 capability、最小控制帧和稳定错误码 | P0-01 | daemon/protocol.rs、client.rs、server.rs、discovery.rs、Tauri error DTO | 旧 daemon、未知 frame、frame 上限、secret 不出 frame/log/error；中英文错误映射 | 旧 daemon 只保留原能力，GUI 不发 routing frame | completed | 2026-08-08 23:54；GitNexus `decode_daemon_frame` CRITICAL；914 Rust lib tests（1 ignored）、TypeScript、cargo check 通过；R1/R2 findings 修复后 R3/R4 连续零发现；提交主题 `feat(routing): add daemon protocol baseline` |

## 5. P1：本地路由

| ID | 目标 | 前置依赖 | 实现触点 | 验收命令/场景 | 回滚点 | 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1-01 | 建立 routing domain、持久化读取和 Tauri commands，区分持久化开关与真实 daemon 状态 | P0-02、P0-04 | provider/routing.rs、commands/routing.rs、commands/mod.rs、provider/mod.rs、lib.rs、HomeIdentity DTO | 版本化 service/takeovers 读取；启停、无 current、无 active key、unsupported app、旧 daemon；错误时不写半成品 | routing 读取失败降级 route inactive，不影响 direct | completed | 2026-08-09 01:17；实现最小持久化 domain、quick controls、daemon capability/status 查询及四个 commands；未实现 listener、端口分配、Live takeover、HTTP、UI。定向 routing 4、daemon protocol 12、database 9；全 Rust lib 918 passed/1 ignored；cargo check、fmt、TypeScript、diff check 通过。R1：复核 DB->command->daemon 数据流、schema/error/secret/旧 daemon 门禁、无半写入，0 findings。R2：复核 PRD/design 边界、三平台/WSL/退出/Workspan/Hook 场景（本 Case 无 UI/Live 触点均确认由后续 Case 负责）、跨层回归与安全 host 校验，0 findings；连续两轮零发现。GitNexus staged detect_changes 返回 high，原因是预期的 `run` command registry 触及 8 个启动流程；`run` upstream impact 为 LOW，未发现额外文件/流程。连续两轮零发现。独立提交主题：feat(routing): add routing domain commands；下一步仅切换 P1-02 指针 |
| P1-02 | 实现 preferredPort/actualPort、真实 bind 和端口回退 | P0-02、P0-04 | daemon listener、route settings、status DTO | 上次 actual -> preferred -> 15721-15799 升序去重；首选占用、范围耗尽、重启复用 | bind/projection 失败保留旧 listener、旧 actual 和旧 Live | completed | 2026-08-09 01:53；新增 daemon routing runtime/PortAllocator，直接 bind 并持有 loopback lease；start 控制帧携带非敏感端口配置，成功后回传 actualPort，Tauri command 在 bind 成功后再持久化，并在 DB 写失败时停止/恢复 listener。新增端口顺序、占用回退、范围耗尽、停止保留 actual、重启复用与 server start/stop tests；Rust 924 passed/1 ignored、cargo check、fmt、TypeScript、diff check 通过；未运行 tauri dev/build。R1：复核 candidate->lease->status->DB 数据流、TOCTOU、端口/地址错误脱敏、持久化失败回滚和 idle watchdog，0 findings。R2：复核 PRD/design P1-02 边界、preferred/actual 场景、重启/多会话/WSL/平台/Worktree/Hook 矩阵（WSL 完整 listener、安全地址原子换端口仍留给 P1-03），0 findings；连续两轮零发现。下一步仅执行 P1-03 |
| P1-03 | 实现 listener lease、安全地址校验和运行中原子换端口 | P1-02 | listener bind/lease、projection coordinator、status | 拒绝 0.0.0.0、::、LAN wildcard；完整 listener set 预绑定与失败回滚 | 释放新 lease，恢复旧 listener/endpoint/Live | completed | 2026-08-09 02:07；listener lease 扩展为同端口完整 loopback listener set，候选失败释放新集合并保留旧 lease；支持 listener_addresses、重复地址去重、wildcard/LAN 拒绝、运行中 rebind，新旧端口在 swap 前并存，复用未变化地址的现有 socket。修改 daemon routing/protocol/server、routing command status DTO、legacy frame matcher；未实现 WSL gateway、Home projection 或 HTTP。定向 routing 8、server 18；全 Rust lib 928 passed/1 ignored、cargo check、fmt、TypeScript、diff check 通过；未运行 tauri dev/build。R1：先发现并修复“daemon stopped 时 reload 绕过地址校验”，新增回归后复验；连续两轮零发现，复核完整 listener set、TOCTOU、旧 lease 保留、错误脱敏和原子 swap。R2：复核 PRD/design P1-03 边界、wildcard/端口占用/rebind/多地址/重启/多会话/WSL/平台矩阵；WSL mirrored/NAT 与 Home projection 留给后续 Case；0 findings。提交前连续两轮零发现。下一步仅执行 P1-04 |
| P1-04 | 完成 Windows local CLI Home takeover/off/restore | P1-01、P1-03 | provider/home.rs、global.rs、native writer、Windows resolver | Claude/Codex/Grok；最小化、托盘、重启、显式关闭；非 owned 字段保留 | journal compensation 恢复 direct；partial 时 daemon 继续运行 | completed | 2026-08-09 02:20；routing takeover 仅允许 local:host，校验 current provider/ready/active key 与 daemon running/actualPort；复用 global writer 的 stage/backup/replace/verify/journal，通过可选 LocalRoute projection 写入 loopback endpoint 与 `CLI_MANAGER_ROUTED` sentinel，成功后保存 `(appType, HomeIdentity)` takeover；关闭时先恢复 direct，再删除 takeover。补齐 Claude/Codex/Grok projection、takeover persistence 和 DB 写失败 direct/route 补偿；未实现 WSL、HTTP、UI。定向 global 21、routing 4；全 Rust lib 930 passed/1 ignored、cargo check、fmt、TypeScript、diff check 通过；未运行 tauri dev/build。R1/R2：复核 provider->projection->writer->takeover DB 数据流、secret sentinel、non-owned 字段、失败补偿、local/WSL/SSH/unsupported/no-key/daemon stopped/多会话场景；无发现，连续两轮零未解决发现。GitNexus `GlobalPreviewInput` upstream impact 为 HIGH（5 依赖、Provider/Commands/路由 3 模块），保持 Direct 默认分支不变并记录风险。下一步仅执行 P1-05 |
| P1-05 | 完成 WSL mirrored localhost 主动探测与 WSL projection | P1-03、P1-04 | WSL runner、UNC writer、distro identity、endpoint discovery | 目标 distro 探测 127.0.0.1；不可达/超时/多 distro 差异不写 Live | 删除 takeover intent，恢复 WSL direct；不改系统网络 | completed | 2026-08-09 02:30；允许 local/WSL Home，WSL enable 使用 bounded `wsl.exe -d <distro> --exec sh -lc` TCP probe（nc -> bash `/dev/tcp` -> curl/wget），成功后写 `wsl_mirrored` + `127.0.0.1` projection；probe 失败/工具缺失不写 Live；disable 不重复探测并保留旧 endpoint 用于补偿；未实现 NAT gateway、HTTP、UI。定向 routing 5、global 21；全 Rust lib 931 passed/1 ignored、cargo check、fmt、TypeScript、diff check 通过；staged GitNexus detect_changes 为 low、无受影响流程；未运行 tauri dev/build。R1：发现并修复 disable 路径错误重复 WSL probe；复验 targeted tests，0 findings。R2：复核 WSL mirrored 信任边界、distro 参数、超时、不可达/工具缺失/多 distro/SSH/local/daemon stopped/失败补偿及 P1-06/NAT/HTTP/UI 范围，0 findings；连续两轮零未解决发现。提交主题：feat(routing): add WSL mirrored takeover；下一步仅执行 P1-06 |
| P1-06 | 完成 WSL NAT exact host-gateway 校验 | P1-05 | route/CIDR/gateway/local-IP parser、gateway validator、WSL writer | gateway 属于目标网络且可达；拒绝猜测地址、wildcard、firewall 自动修改、portproxy | 拒绝 takeover，保留原 Live | completed | 2026-08-09 02:50；新增 bounded WSL `ip -4 route show default`/`ip -4 addr show dev` 解析、CIDR 包含校验、Windows `GetAdaptersAddresses` 精确 unicast 校验和 `routing_wsl_gateway` listener；mirrored 失败后才 fallback NAT，gateway probe 失败恢复旧 listener，不修改 firewall/portproxy/.wslconfig；扩展 LocalRoute projection 允许经后端校验的 WSL gateway endpoint，未实现 HTTP/UI。定向 routing 7、daemon routing 8、global 22；全 Rust lib 934 passed/1 ignored、cargo check、fmt、TypeScript、diff check 通过；未运行 tauri dev/build。R1：发现并修复 GetAdaptersAddresses 缓冲区对齐、WSL listener/rebind 与 projection 失败回滚缺口；定向测试复验后 R1b 0 findings。R2：复核 CIDR/device/gateway 信任边界、LAN/wildcard、工具缺失/超时、多 distro、local/WSL/SSH、旧 daemon、secret、firewall/portproxy 和 P1-07/macOS/HTTP/UI 范围，0 findings；R1b/R2 连续两轮零未解决发现。GitNexus upstream impact 未返回 HIGH/CRITICAL；下一步仅执行 P1-07 |
| P1-07 | 完成 macOS local loopback、原子 replace、Keychain 和 daemon detach | P1-03、P1-04 | macOS path/keychain adapter、daemon detach/shutdown、Home writer | 真实 macOS runner：bind、投影、恢复、GUI 退出、重启复用端口 | 恢复 direct local Live，停止 route daemon | completed | 2026-08-09 03:08；Unix daemon spawn 改为 `setsid` 独立 session；现有 macOS Keychain adapter、同目录 stage + rename + verify 已确认；新增 macOS cfg 原子 replace focused test。Windows 定向 3、全 Rust 934 passed/1 ignored、cargo check、fmt、TypeScript、diff check 通过；R1/R2 连续零发现；本环境无 macOS runner，真实 bind/projection/restore/GUI exit/重启验收明确留给 P5-02，不以 Windows 结果替代；独立提交主题见执行日志 |
| P1-08 | 将现有 writer 扩展为 Direct/LocalRoute 唯一投影器并提供补偿 | P1-04、P1-07 | provider/global.rs、apply/recover、owned/non-owned merge | Claude 单文件、Codex 双文件、Grok model entry；外部 drift 阻止覆盖 | journal 恢复旧 direct snapshot | completed | 2026-08-09 03:25；新增内部 `ProjectionMode::Direct | LocalRoute`，外部 Global preview/apply DTO 与 command 签名保持不变；Direct 与 LocalRoute 均经同一 build plan、stage、backup、replace、verify、journal/recovery 链路，新增显式模式 focused test。定向 global 4、全 Rust 935 passed/1 ignored、cargo check、Rustfmt、TypeScript、diff check 通过；未运行 tauri dev/build；R1/R2 连续两轮零未解决发现；独立提交主题见执行日志 |
| P1-09 | 完成 Claude/Codex/Grok provider-specific endpoint/auth/model sentinel | P1-08 | Claude writer、Codex auth.json/config.toml、provider/grok.rs | route on/off 对照；保留 Hook/MCP/permissions/projects/statusline；OAuth/SSH/Gemini blocked | 恢复当前 provider direct projection | in_progress | 不替换 GROK_HOME |
| P1-10 | 让 route runtime 驻留 daemon，处理 capability、busy、idle、GUI exit | P0-04、P1-08 | daemon/server.rs、client.rs、discovery.rs、lib.rs、exit cleanup | daemon crash/restart、GUI 真退出、route active/inactive、旧 daemon | active 时只断 GUI；inactive 执行现有安全 shutdown | pending | route 不依赖 WebView 生命周期 |
| P1-11 | 完成三应用 HTTP path、provider adapter、JSON/SSE 转发 | P0-03、P1-10 | route server、adapter、reqwest、request/response DTO | /v1/messages、/v1/responses、/v1/chat/completions、/grokbuild/v1；未知 path 404/405 | 未覆盖格式不接管，route off 走 direct | pending | 不支持任意 URL forwarding/CONNECT |
| P1-12 | 完成 route-only enabled key pool、cursor、cooldown 和 reload generation | P1-01、P1-11 | provider key loader、route snapshot、forward attempt | sort_index 轮询；active-first；401/403/429 未提交前换 key；耗尽后 provider failure | 关闭 pool，恢复 active-key-only；不改 is_active | pending | A-03；direct/scope/Live 不受影响 |
| P1-13 | 完成模型映射 route-only 语义、每 attempt 重算和最终 model pin | P0-03、P1-11 | advanced.modelMappings、normalize/save、forward loop、model resolver | off 不重写；a->b outbound；重复/大小写/Body Override/A-B provider mapping | 禁用 mapper，保留配置和 direct behavior | pending | requested_model/upstream_model 都进脱敏日志 |
| P1-14 | 完成路由页面、四个 accordion、真实状态和供应商导航 | P1-01、P1-10、P1-13 | NativeProviderSettingsPage.tsx、tabs、routing sections、i18n | 供应商目录/CLI HOME/路由同级；固定优先级；端口/endpoint/status/queue 脱敏 | 隐藏 routing surface，不影响 catalog/home | pending | mapping 提示必须中英文明确 route-only |
| P1-15 | 完成 Sidebar 快捷开关和本地路由端到端验收 | P1-04 至 P1-14 | SidebarFooter.tsx、PTY active target、session stores、toast/i18n | Windows local、WSL 多 distro、macOS；无 PTY/SSH/unsupported/no key 禁用并解释；on->request->off | 移除快捷入口，保留设置页和 direct flow | pending | P1 完成条件包含三平台，不可只交 Windows |

## 6. P2：自动故障转移

| ID | 目标 | 前置依赖 | 实现触点 | 验收命令/场景 | 回滚点 | 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P2-01 | 复用 native provider queue，建立每 app 独立 failover settings | P1-15 | provider repository、routing.app、queue UI | enabled/ready/同 app/API-key provider 才可入队；sort_index 顺序；重复幂等；current 移除 | 关闭 failover，保留 queue/current | pending | 不建第二套 provider queue |
| P2-02 | 实现错误分类、maxRetries、timeouts 和 retry budget | P2-01、P1-11 | classifier、attempt loop、SSE commit tracker | maxAttempts=maxRetries+1；网络/TLS/timeout/5xx/401/403/429；能力错误给 rectifier 一次 | 单 provider 返回 sanitized error | pending | 已提交响应绝不切 provider |
| P2-03 | 实现 Closed/Open/HalfOpen circuit 和单 probe | P2-02 | daemon memory state、metrics、status DTO | 连续失败、错误率最小样本、等待时间、单 probe、恢复阈值、断开释放 permit | 清 daemon runtime state，保留 config | pending | reload 不重置；restart 从 Closed |
| P2-04 | 实现 stream commit boundary 与 projection hot switch 事务 | P1-08、P2-02、P2-03 | forwarder、projection coordinator、daemon reload | 普通 SSE 首个可解析事件、Responses output/error；keepalive 不提交；并发不乱序 | 恢复旧 current/Live/target | pending | 不拼接第二 provider 响应 |
| P2-05 | 串联多 key exhaustion 到 provider failover，并重新计算 mapping | P2-01 至 P2-04、P1-12、P1-13 | key pool、provider queue、model mapper、request log | A:k1/k2 401/429 后才到 B；A targetA/B targetB；key failure 不重复计 provider failure | active-key-only + 单 provider | pending | A-03 核心验收 |
| P2-06 | 完成 failover UI、queue view、circuit reset 和降级状态 | P2-01、P2-03 | routing failover section、status polling、i18n/aria | 保存/重置表单分离；reset circuit 不清 queue；无 takeover/unsupported 显示原因 | 隐藏 controls，保留已存配置 | pending | 不展示 secret |
| P2-07 | 完成 failover 专项回归和 rollback rehearsal | P2-05、P2-06 | fixtures、fake upstream、daemon recovery | 三应用、JSON/SSE、三平台、crash/reload、回切、client disconnect；Rust/Node focused tests | 关闭 per-app failover，单 provider 服务 | pending | 通过后进入 P3 |

## 7. P3：全局出站代理

| ID | 目标 | 前置依赖 | 实现触点 | 验收命令/场景 | 回滚点 | 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P3-01 | 保存代理配置和 credential reference，禁止密码进入 DB/DTO/log | P0-02、P1-10 | provider DB、credential store、proxy commands | 编辑保留密码、显式清空删除、失败保留旧 generation、DTO 只返回 hasPassword | 恢复旧 DB/credential/client | pending | Basic auth 只发给代理 |
| P3-02 | 支持四类 scheme、校验、扫描、测试和自环防护 | P3-01 | URL parser、scan/test commands、sanitized errors | HTTP/HTTPS/SOCKS5/SOCKS5H；常见 localhost 端口；10s test；拒绝 route endpoint 自环 | 不保存无效配置，不替换 client | pending | 扫描只证明端口可连，不宣称协议已验证 |
| P3-03 | 切换共享 reqwest client 并覆盖列出的 HTTP 触点 | P3-02 | models、model_pricing、command_suggestion、desktop_pet、ssh supply chain、WebDAV、notification、route upstream | 新请求使用新 generation；旧请求完成后释放；重启恢复；local route 遵循代理 | 原子切回旧 client | pending | 不扩展到 updater/WebView |
| P3-04 | 固化 CC Connect/SSH/updater/WebView 排除及热更新并发语义 | P3-03 | cc_connect、SSH integration、updater boundary、bypass policy | 显式代理优先；route 自环绕过/拒绝；并发请求不读半配置 | 撤销 cutover，保留 bypass 规则 | pending | 排除范围要有 UI/文档说明 |
| P3-05 | 完成全局代理 UI、i18n 和专项验收 | P3-01 至 P3-04 | routing global proxy accordion、i18n、aria/toast | zh-CN/en-US、键盘、密码留空/清空、代理失败 sanitized 状态 | 隐藏 UI，恢复默认 client | pending | 通过后进入 P4 |

## 8. P4：整流器与 Bedrock 优化

| ID | 目标 | 前置依赖 | 实现触点 | 验收命令/场景 | 回滚点 | 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P4-01 | 建立总开关、子开关和每 logical request 的 RetryContext | P0-02、P1-11 | routing settings、daemon runtime、attempt context | 总开关关闭不执行但保留子配置；route off 不改请求；每条规则最多一次 | 关闭总开关 | pending | 只作用于已接管请求 |
| P4-02 | 迁移 Thinking signature 修复规则 | P4-01、P0-03 | Anthropic body transformer、classifier、fixtures | 有效不改；明确 invalid/missing/extra 最多一次重试；不记原 thinking | 关闭 signature rule | pending | 失败后按 provider classifier 处理 |
| P4-03 | 迁移 Thinking budget 修复规则 | P4-01、P0-03 | budget transformer、retry context | 只匹配明确 budget/thinking 错误；adaptive 不误改；max_tokens 合法 | 关闭 budget rule | pending | 不修改 provider 持久化配置 |
| P4-04 | 迁移媒体降级和 text-only 预判 | P4-01、P0-03 | media resolver、三类 adapter、nested media traversal | 仅 400/415/422/501 明确媒体能力错误；图片/文件/工具/MCP 覆盖；不记原图 | 关闭 media fallback | pending | 占位文本不能泄漏原始媒体 |
| P4-05 | 迁移 Bedrock thinking/cache optimizer | P4-01 至 P4-03 | effective provider env、Bedrock transformer、cache breakpoints | 仅环境判定为 Bedrock；Haiku/新旧模型规则；最多四个五分钟 ephemeral breakpoint；failover 不泄漏字段 | 关闭 Bedrock optimizer | pending | 不从显示名或 URL 猜 provider |
| P4-06 | 完成整流器 UI、i18n、fixture 回归 | P4-02 至 P4-05 | rectifier accordion、i18n/aria、metrics | 总开关、子开关、route off、Bedrock/non-Bedrock、一次重试；focused tests | 关闭总开关并保留配置 | pending | 通过后进入 P5 |

## 9. P5：集成验收与交付

| ID | 目标 | 前置依赖 | 实现触点 | 验收命令/场景 | 回滚点 | 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P5-01 | 完成 DB -> commands -> daemon -> HTTP -> writer -> UI 跨层质量门禁 | P1-15、P2-07、P3-05、P4-06 | 全任务新增/修改 symbol、GitNexus execution flows | rtk cargo check；rtk cargo test；rtk npx tsc --noEmit；rtk git diff --check；不主动运行 tauri dev/build | 按阶段回滚 | pending | 先具体后全面 |
| P5-02 | 完成 Windows local、Windows WSL、macOS local 平台矩阵 | P5-01 | 三平台 runner、Home writer、daemon lifecycle | takeover/off/restore、端口回退、重启、GUI exit、多 Home、多 distro、gateway failure | 平台级关闭 takeover，恢复 direct | pending | 三平台都是首版完成条件 |
| P5-03 | 完成功能与故障注入矩阵 | P5-02 | fixture、fake upstream、UI interaction tests | 四模块开关、三应用、JSON/SSE、mapping、multi-key、provider failover、proxy、rectifier | 标记 unsupported/blocked，不放宽安全边界 | pending | 覆盖主路径与边界 |
| P5-04 | 完成生命周期、并发、恢复、secret redaction 审计 | P5-03 | daemon、journal、DB、credential store、logs | 并发 takeover/rebind、crash、drift、migration failure、日志/DTO/frame 搜索 secret/body/header | 恢复最后 verified generation | pending | 重点检查数据损坏风险 |
| P5-05 | 完成 i18n/a11y/响应式/许可文档 | P5-03 | src/lib/i18n.ts、routing UI、NOTICE、third-party license | 中英文切换、24 小时制、键盘/aria、1024/1440 无横溢；仅复制 substantial CCS code 时补许可 | 撤回未验证文案/许可变更 | pending | 不新增无必要依赖 |
| P5-06 | GitNexus 变更检测、最终文档和用户验收 | P5-01 至 P5-05 | gitnexus detect_changes、任务文档、changelog 占位 | detect_changes 仅包含预期 flows；JSON/JSONL/diff check；用户确认后再定版本、commit、archive | 保留任务目录，回退最后已验证 Case | pending | [TEMP] 在版本确定前保持不变 |

## 10. 统一完成记录模板

完成任意 Case 时，在对应行更新状态，并在执行日志追加：

- Case：P?-??
- 状态：completed / blocked / skipped
- 完成时间：YYYY-MM-DD HH:mm
- 机器：hostname
- 修改文件：path 列表；若无则写“仅验证”
- 验证命令/场景：实际执行内容
- 结果：pass/fail 与简短证据
- Review 记录：R1/R2/... 的范围、findings、修复和连续零发现轮次
- 回滚点：已验证的回滚 generation 或 N/A
- 提交主题：该 Case 的独立 commit subject
- 下一步：下一个稳定 ID

## 11. 执行日志

| 时间 | 机器 | Case | 状态变更 | 修改文件 | 验证证据 | Review 证据 | 提交主题 | 下一步 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-08 21:11 | DESKTOP-Q49I074 | P0-01 | in_progress -> completed | task 规划、research、progress 与 docs/ccs 截图基线 | 远端 0/0；GitNexus impacts；Trellis/JSON/路径/表格/空白检查通过 | R1/R2 修复路径、风险和 A-01 遗漏；R3/R4/R7/R8B/R9/R10 连续零发现；R5/R6 元数据复核 | docs(routing): record P0-01 impact baseline | P0-02 |
| 2026-08-08 22:14 | DESKTOP-Q49I074 | P0-02 | in_progress -> completed | provider/database.rs、backend provider contract、design 与 P0-02 research | `cargo fmt`；9 database tests；4 migration tests；123 provider tests；`cargo check`；Trellis/JSON/范围/脱敏检查 | R1 修复默认值与 schema shape 校验；R2 补 spec、backup-failure、checksum/default tests；R3/R4 连续零发现 | feat(routing): add provider schema v2 | P0-03 |
| 2026-08-08 23:03 | DESKTOP-Q49I074 | P0-03 | in_progress -> completed | `src-tauri/tests/routing_fixtures.rs`、5 个 routing fixture、P0-03 research/progress | 5 focused tests、123 provider tests、`cargo check`、Rustfmt、diff 与 secret/scope 检查通过 | R1/R2 findings 修复；R3/R4 连续零发现 | test(routing): add protocol fixture baseline | P0-04 |
| 2026-08-08 23:03 | DESKTOP-Q49I074 | P0-04 | pending -> in_progress | 尚未修改 daemon/command 生产代码 | 待执行 daemon protocol capability 与错误 DTO 影响分析 | Review 待完成 | 待完成 | P0-04 |
| 2026-08-08 23:54 | DESKTOP-Q49I074 | P0-04 | in_progress -> completed | daemon protocol/server/client/discovery、terminal legacy relay、design、backend contract、P0-04 research/progress | 914 Rust lib tests（1 ignored）、TypeScript、cargo check、Rustfmt、diff check 通过；focused tests 见 research | R1/R2 findings 修复；R3/R4 连续零发现；GitNexus CRITICAL 风险已记录 | feat(routing): add daemon protocol baseline | P1-01（仅切换指针后暂停） |
| 2026-08-09 01:17 | DESKTOP-Q49I074 | P1-01 | in_progress -> completed | `src-tauri/src/provider/routing.rs`、`src-tauri/src/commands/routing.rs`、HomeIdentity DTO、module/command 注册、progress | routing 4、daemon protocol 12、provider database 9；全 Rust lib 918 passed、1 ignored；cargo check、Rustfmt、TypeScript、diff check 通过；未运行 tauri dev/build；staged detect_changes high 由预期 run 注册影响 8 个启动流程，run upstream impact LOW | R1/R2：数据流、错误/secret/旧 daemon 门禁、PRD/design 范围、三平台/WSL/生命周期场景复核；连续两轮零未解决发现 | feat(routing): add routing domain commands | P1-02（仅切换指针，未开始实现） |
| 2026-08-09 01:53 | DESKTOP-Q49I074 | P1-02 | in_progress -> completed | `src-tauri/src/daemon/routing.rs`、daemon protocol/server、routing command/terminal frame matcher、progress | 定向 routing 5、server 1、protocol 12、provider routing 4；全 Rust lib 924 passed、1 ignored；cargo check、Rustfmt、TypeScript、diff check 通过；未运行 tauri dev/build | R1/R2：bind/lease/DB 回滚、错误脱敏、preferred/actual 与回退顺序、重启复用、daemon 生命周期和场景矩阵复核；连续两轮零未解决发现 | feat(routing): add routing port allocator | P1-03 |
| 2026-08-09 02:07 | DESKTOP-Q49I074 | P1-03 | in_progress -> completed | `src-tauri/src/daemon/routing.rs`、`src-tauri/src/daemon/protocol.rs`、`src-tauri/src/daemon/server.rs`、`src-tauri/src/commands/routing.rs`、`src-tauri/src/commands/terminal.rs`、progress | 定向 routing 8、server 18；全 Rust lib 928 passed、1 ignored；cargo check、Rustfmt、TypeScript、diff check 通过；未运行 tauri dev/build | R1：地址校验绕过 finding 已修复并新增 stopped reload 回归；R2：范围/场景/跨层复核；修复后连续两轮零未解决发现 | feat(routing): add listener lease rebind | P1-04 |
| 2026-08-09 02:20 | DESKTOP-Q49I074 | P1-04 | in_progress -> completed | `src-tauri/src/provider/global.rs`、`src-tauri/src/provider/routing.rs`、`src-tauri/src/commands/routing.rs`、progress | 定向 global 21、routing 4；全 Rust lib 930 passed、1 ignored；cargo check、Rustfmt、TypeScript、diff check 通过；未运行 tauri dev/build | R1/R2：writer 复用、三应用 projection、local Home 边界、DB/Live 补偿和场景矩阵；连续两轮零未解决发现 | feat(routing): add local home takeover | P1-05 |
| 2026-08-09 02:30 | DESKTOP-Q49I074 | P1-05 | in_progress -> completed | `src-tauri/src/provider/routing.rs`、`src-tauri/src/commands/routing.rs`、progress | 定向 routing 5、global 21；全 Rust lib 931 passed、1 ignored；cargo check、Rustfmt、TypeScript、diff check 通过；未运行 tauri dev/build | R1：修复 disable 路径重复 WSL probe 后复验；R2：复核 mirrored probe、UNC projection、错误脱敏、跨 distro/平台/SSH/daemon 状态和 P1-06 边界；连续两轮零未解决发现 | feat(routing): add WSL mirrored takeover | P1-06 |
| 2026-08-09 02:50 | DESKTOP-Q49I074 | P1-06 | in_progress -> completed | `src-tauri/Cargo.toml`、`src-tauri/src/provider/routing.rs`、`src-tauri/src/daemon/routing.rs`、`src-tauri/src/provider/global.rs`、`src-tauri/src/commands/routing.rs`、progress | 定向 routing 7、daemon routing 8、global 22；全 Rust lib 934 passed、1 ignored；cargo check、Rustfmt、TypeScript、diff check 通过；未运行 tauri dev/build | R1/R1b：修复 API buffer 对齐、listener rollback、gateway projection contract 后复验；R2：复核 P1-06 安全边界和 Case 顺序；R1b/R2 连续两轮零未解决发现 | feat(routing): add WSL NAT gateway validation | P1-07 |

| 2026-08-09 03:08 | DESKTOP-Q49I074 | P1-07 | in_progress -> completed | `src-tauri/src/daemon/client.rs`、`src-tauri/src/provider/global.rs`、progress | daemon client 定向 1、writer 原子替换定向 1、stage path 定向 1；全 Rust lib 934 passed/1 ignored；cargo check、Rustfmt、TypeScript、diff check；未运行 tauri dev/build；未以 Windows 测试替代 macOS runner | R1：复核 session detach、atomic rename、Keychain adapter、secret/数据损坏边界，0 findings；R2：复核 P1-07/P1-08/P1-10 边界、平台/退出/重启/WSL/Hook 场景，0 findings；连续两轮零未解决发现 | feat(routing): detach daemon session for macOS | P1-08 |

| 2026-08-09 03:25 | DESKTOP-Q49I074 | P1-08 | in_progress -> completed | `src-tauri/src/provider/global.rs`、progress | 定向 global 4；全 Rust lib 935 passed/1 ignored；cargo check、Rustfmt、TypeScript、diff check；未运行 tauri dev/build | R1：模式转换、Direct 默认兼容、LocalRoute endpoint/sentinel、统一 stage/journal/recovery，0 findings；R2：PRD/design、三应用/多文件补偿、drift、跨平台/SSH/Workspan/Hook、无第二 writer，0 findings；连续两轮零未解决发现 | feat(routing): add explicit projection modes | P1-09 |

## 12. 执行授权

用户已批准按本文件开始执行：

- Changelog Target 已改为 [TEMP]。
- 已新增 43 个稳定 ID 的细粒度 Case，全部初始为 pending。
- 已记录入口、模型映射 route-only 语义、Windows local/WSL/macOS 范围、端口 15721-15799 回退、WSL 安全边界和 A-03 多密钥规则。
- P0-01 从影响分析开始，不先修改生产 symbol。
- 后续每完成一个 Case 都必须通过连续两轮零发现 Review、独立提交并更新本文件。
