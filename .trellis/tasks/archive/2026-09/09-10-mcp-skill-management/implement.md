# V1.4.0 MCP 与 Skills 父任务执行记录

## Follow-up: project policy launch diagnosis and dialog overflow — 2026-09-14

- 根因陈述：Codex 命令中的 `--profile cli-manager-project-<snapshot>` 是已经启动的项目扩展快照标识；daemon 重连会保留正在运行的 CLI 及其启动快照，不会把已运行进程改写成全局配置。当前源码对真正的新建/重建进程在项目策略继承全局时不会生成项目扩展快照；因此切换后需要关闭旧 Codex 会话并新建终端才能验证新策略。只读运行态同时发现 Finance 项目仍存在对应旧快照/自定义策略记录，不能把旧进程输出当作继承全局后的新启动证据。
- 项目策略弹框的外层滚动根因是自适应高度内容与列表固定最小高度叠加，滚动落在整个弹框正文。弹框现在固定视口高度，正文使用 flex 约束，资源列表和预览侧栏各自承担必要滚动，页脚保持可见。
- 场景：切换 custom→inherit 后新建 Codex/Claude 终端、应用重启后的 daemon attach、已有会话继续运行、MCP/Skills 长列表、窄窗口与低高度窗口。现有“运行中会话保留启动快照”的契约不变，未通过强制重启或删除快照改变活动 CLI 状态。
- 验证：新增项目弹框布局结构回归；`node --test scripts/extensions*.test.mjs` 33 项通过，`npx tsc --noEmit` 与 `npm run check:architecture -- --strict` 通过。GitNexus `detect_changes` 返回 HIGH（既有启动入口、设置弹窗与终端创建链路的预期跨层改动），已查看 `run`、`SettingsModal`、`createDetachedPtyProcess` 上下文，未将其误报为低风险。

## Current repair verification — 2026-09-13 (Codex project Skills whitelist)

### Latest user feedback

- Codex 项目只选择 `weekly-report` 后，终端仍显示 Codex 默认/全局 Skills；项目 Skill 管理列表中的同名包重复出现。

### Root cause and repair

- 根因类别 B/E：Codex 的内置 Skill 不属于文件发现路径，旧的路径级 `skills.config` 禁用规则无法关闭它们；因此仅关闭用户、项目和插件目录仍会留下默认 Skill。项目目录的同名包则必须在展示层合并，不能删除包 ID 或安装记录。
- 修复 Codex 项目 profile：自定义 Skill 集合同时写入 `skills.bundled.enabled=false`，再按 Codex 实际发现的 `SKILL.md` 路径先全部禁用、最后启用项目 `.agents/skills/<name>` 目标。选中包仍先物化到项目发现根，避免把应用数据目录路径误交给 Codex。
- 修复失败清理边界：运行时区分本次新建目标和已有受管/外部同名目录；准备失败只清理本次新建目录，不误删其他会话仍引用的目标。
- 项目列表继续按精确名称聚合，一行保留全部 variant ID，选择/取消按整组处理；不同来源的包记录、哈希和安装所有权不合并。

### Scenario coverage and validation

- 覆盖自定义空集合、单个 `weekly-report`、同名同哈希/不同哈希来源、继承全局、项目已有同名目录、多个 Codex 快照并行及 profile 生成失败回退。
- 新增 Codex bundled Skill 禁用的 TOML 回归断言、Project Skill 列表去重结构断言和目标清理序列化断言；未启动 dev、未修改用户原生 MCP/Skill 配置、未提交。

## Current repair verification — 2026-09-13 (Codex project profile)

### Latest user feedback: project command is too long

- 根因是前一轮为了同时承载项目供应商、MCP 与 Skill，终端把所有 Codex dotted overrides 展开为多个 `-c` 参数；虽然配置语义已正确，但 Windows 启动命令过长且难以诊断。
- 修复：供应商快照清单保存已校验的非秘密 Codex overrides；本机项目扩展快照在解析到的 Codex 默认配置根生成唯一的 `cli-manager-project-<snapshotId>.config.toml`，将供应商与项目 MCP/Skill 覆盖组合并按 TOML 校验，启动只追加一个 `--profile`。供应商密钥仍只通过进程环境注入。
- profile 采用快照标记和独占创建，不覆盖用户同名文件；项目快照释放与垃圾回收只删除带对应标记的 CLI-Manager profile。WSL、非直接 Codex 命令、旧供应商快照或 profile 写入失败继续走原有的完整 `-c` 回退，不能因优化失败阻断全局/项目启动。
- 新增 profile 内容、无效 key 和短命令回归测试；未启动 dev，未修改用户原生 MCP/Skill 文件，未提交。桌面实际启动仍需用户在本分支重新构建后确认生成命令为 `codex --profile cli-manager-project-...` 且 MCP/Skill/provider 同时生效。

## Current repair verification — 2026-09-13

### Latest user feedback: Codex project launch and scoped provider merge

- 复现项目 `F:\github\Finance-Excel-Convert` 的 Codex 启动失败：项目策略只生成 `mcp_servers.exa_web_search.enabled=true`，没有生成 `url`，Codex 因无法判断 MCP transport 报 `invalid transport`。
- 根因类别 B/E（跨 CLI 配置语义未完整投影）：Codex 的 `mcp_servers` 表不是仅有开关的注册表，stdio 必须有 `command`/`args`，Streamable HTTP 必须有 `url`；`-c` 表字段会与现有配置合并，不能用一个 `{url=...}` 覆盖掉已有 stdio 字段。
- 修复：项目 Codex MCP 覆盖现在写入完整的有效传输字段、显式 `enabled`，并按项写入 env/header/可表示超时；不输出通用 `type`/`transport`。未选 SSE 不生成条目，选中 SSE 返回明确不支持并回退该 MCP 策略；含未解析秘密引用不把值写入命令行。
- 修复供应商叠加：项目默认启动命令会去掉旧的 provider profile 参数；有项目 Codex MCP/Skill 覆盖时，将供应商 `-c` 与项目 `-c` 合并到同一条启动命令，保留供应商环境注入，不再追加第二层 `--profile`。合并失败仍保留原有安全回退路径。
- Claude 的 provider 设置与 Skill 覆盖已合并为一个生成的 `--settings` 文件；MCP 仍使用独立 `--mcp-config`，因为这是 Claude CLI 两类不同的原生输入，不把 MCP 错写进 settings。
- 定向回归新增 Codex stdio/HTTP/秘密引用/SSE 测试；`cargo test --lib extensions::` 通过（56 passed / 2 ignored）、Codex CLI 临时 `-c` Streamable HTTP 解析通过、`npx tsc --noEmit`、`cargo check --lib`、严格架构检查（1029 文件、0 超限）、扩展/启动参数前端测试（49 passed）、目标 Rust 文件 rustfmt 与 diff 检查通过。未启动 dev，未修改用户原生 MCP/Skill 文件，未提交。

## Current repair verification — 2026-09-11 (supersedes completion claims below)

### Latest user feedback: 2026-09-12

- 移除 Skills 顶部随刷新反复出现的全局 partial-scan Alert；按 CLI 的完整性仍只影响图标操作/详情，不再阻断主列表展示。
- 复现 `CLI-Manager (cc)` 的只读数据库数据：Claude MCP 项目自定义选择可读取，但 `filesystem` 的 Claude 来源未知字段 `startup_timeout_sec` 被跨 CLI 保留字段检查误判，导致 MCP 投影失败、启动提示全局回退。修复为目标 CLI 归属检查：Claude 保留该未知字段且不转发 Codex/Grok，同时继续拒绝 canonical `command` 覆盖；Claude `timeout` 仍按 canonical 保留字段拒绝。
- 验证：只读实际项目数据投影测试通过；扩展 Rust 54 passed / 2 ignored；前端定向 31 passed；类型与架构检查通过。未写入用户 MCP/Skill 文件、未启动 dev。

### Latest user feedback: seven items at 15:13

- 延续 V1.4.0 父任务、mcp-skill-manager（无 upstream），保留其他脏改动；不启动 dev、不提交、不改用户原生 Skill/MCP 文件。
- 实施：状态待检查的 Skill 图标直接打开目标 CLI 已固定的安装面板；同名包按精确名称分组为一行，详情保留不同来源选择，安装记录按所有 variant ID 聚合；共享/兼容目录单独说明，不能冒充其他 CLI 的独立安装。MCP 图标与编辑/删除合并右侧操作行，两类卡片缩小内边距。
- 项目弹框删除环境与 CLI tab，复用启动时的 getProviderSwitchAppType，未知工具提示不支持且不回退 Claude。仅提交所配置 CLI；后端省略的 CLI/kind 不再隐式删除，显式 inherit 才移除覆盖。

#### 1. Root cause category / statement

- B/E（跨层契约与隐含假设）：inventory 的 agent-compatible/claude-compatible 表示扫描可见性，旧 UI 却当成每个 CLI 的安装证据；源包以来源与内容区分身份，旧 UI 直接一包一卡使同名来源看起来重复。修复落在展示聚合层，不能破坏数据库身份/所有权。
- E/D：Claude 快照生成遍历全部源包并拒绝任何重名，未选中的不同来源也导致失败。只在所选 ID 内检查同名冲突；快照需求根据 policy origin 而不是 selected length，覆盖 Worktree 继承空自定义集合；全局继承保留原生状态。
- 只读证据：ai-search-hub 有两个内容哈希不同的源包，只有 Codex 一条安装记录，目标 .agents/skills；.claude/.codex/.grok 对应同名目录均未发现。CLI-Manager (cc) 配置 claude，选中 filesystem/dbx 和 gitnexus-impact-analysis，ID 均有效。现有日志未取得本次 warning 的细分错误码，故不将单元测试通过宣称为桌面启动已验收。

#### 2. Why previous fixes missed this

- 上轮只补“已发现外部安装”回显，没有区分 native 与 compatible，也没有在多来源真实数据库下测试项目快照；类型/静态布局测试无法揭露这些语义错误。

#### 3. Prevention and discovery checklist

- [x] GlobalSkillsPanel/listPresentation：分组保留 ID，安装状态按 CLI/来源类型区分，未知/保护目标只进入检查，Rust 冲突与所有权检查保留。
- [x] GlobalMcpPanel/ExtensionSortableList：只收紧卡片布局，不改排序存储、待保存语义。
- [x] ProjectExtensionsDialog/providerSwitching/terminalLaunch：弹框与启动复用同一 CLI 解析；后两者已查且无需更改。
- [x] project_policy：未选择的重复来源、只提交当前 CLI、Worktree 继承空集合回归测试。
- [x] inventory/skill_deployment/skill_repository：扫描类型与 Codex .agents 目标已确认，本轮不移动既有安装、不修改所有权规则。
- [x] 双语字典、CHANGELOG V1.4.0、功能清单、extensions-management-contracts 同步。
- GitNexus impact 对以上新符号返回 UNKNOWN/not found，已用契约+符号引用补查，不解释为零影响。

#### 4. Scenario expansion

- 本地/WSL Home 范围保留；共享、native、插件、失效/外部修改、扫描不完整、同名不同哈希分别区分。SSH/无法识别 WSL 和 Grok 隔离仍按原契约降级，不扩写远端文件。
- 项目/Worktree、当前 CLI/未提交 CLI、全局继承/空与非空自定义、未选重名/选中单版本/选中冲突覆盖。焦点、分屏、最小化、Hook 装没装不参与本次列表与纯策略映射，终端注入生命周期未改变。

#### 5. Knowledge capture and validation

- 已更新领域契约；仓库不存在 src/templates/markdown/spec 模板副本，不创建虚构模板。不执行 skill 中的提交建议，遵守用户未授权提交的边界。
- 前端定向测试 31/31；Rust extensions 52 passed、1 ignored（真实 CLI opt-in 冒烟）；npx tsc --noEmit、严格架构（1029 文件、0 超限）通过。真实 Tauri 视觉、双语切换与项目启动需用户用本分支重新编译后复验，不能用测试替代。

### Latest user feedback: nine usability items

- 后续截图调整：手柄通过 render prop 放进卡片名称左侧，不再单独占据卡片外一列；排序存储与行为不变。
- 保存前基线调整：新增 extensions_mcp_set_selection，以单个 BEGIN IMMEDIATE 事务更新布尔开关并保留完整秘密；缺失记录/非法 CLI/Home 变化失败整批回滚。编辑/删除/导入和单 CLI 图标共享入口，避免复活未点击的导入默认开关；回读只在保存完成后触发，避免 pending 开始时旧查询覆盖刚保存结果。
- 验证：扩展 Rust 定向测试 49 passed / 1 ignored（含实际临时 auto-copy、原生禁用标记、SQL 批次失败回滚/秘密保留）；cargo check、最终前端类型检查、27 项前端定向测试、architecture strict（1029源文件、0超限）与 diff whitespace 检查通过。内置手柄已有源码结构回归断言，实际桌面视觉和 docx 安装仍待用户复验；未启动 dev、未操作实际 CLI 文件。
- 普通读取不再创建 pending；旧的原生差异/读取失败触发提醒逻辑已移除。新增只读 native_status IPC，用实际文件和禁用标记回显，不依赖受管投影成功。
- 删除基础配置表单、CLI 能力卡片和投影预览 UI；独立限高 JSON 编辑器接受单服务 mcpServers 格式并保留隐藏元数据/未改动秘密。菜单置于供应商之后；两类列表改手柄拖动和键盘排序，独立应用数据 KV 持久化。
- Skills 合并安装表与实际盘点，外部同名安装彩色但禁止冒充受管移除；扫描完整性分 CLI，避免 Codex 插件深度限制阻止 Claude 安装。错误文案细分，Windows 链接错误携带数值码供 auto 回退。
- 用户反馈“doc”：只读数据库匹配到 docx，受管包 SKILL.md 存在，无受管安装记录；默认 .claude/skills 无 docx，不能断言目标冲突。临时目录实际 auto 部署走 copy 并通过文件/源保留断言，说明本机需要权限回退；真实页面 docx 安装尚待用户复验，未写实际 CLI 文件。
- 发现清单：GlobalExtensionsPage（独立读取/状态基线）、GlobalMcpPanel（开关/删模块）、McpEditorDialog/mcpJsonEditor（格式与布局）、mcpSaving/mcpPendingStore（无编辑不拦截）、modelAdapters（显式选择基线）、GlobalSkillsPanel/listPresentation/skillErrors（外部与错误）、ExtensionSortableList/ExtensionCliToggle（显示与顺序）、SettingsModal（菜单）、native/commands/lib（只读状态注册与原生禁用标记）、skill_deployment（系统码回退）、中英文/测试/版本记录。Hook/PTY/项目策略本批确认无须修改，平行工作保持原样。
- 场景覆盖：未操作/编辑/保存失败/部分成功/离开重进、原生 disabled 标志、各 CLI 独立失败、外部同名/多来源/缺失/不可读、中文 Windows auto/copy/显式 symlink、本机/WSL Home 身份、长 JSON/窄窗、拖动/键盘/重开顺序。焦点/分屏/Worktree/Hook 安装与此设置页读写无耦合，SSH 不新增支持；跨平台/实际桌面仍人工验收。

### Bug analysis / prevention (trellis-break-loop)

1. 根因类别 B/E/D：把 canonical 与安装记录误作原生事实，把文件差异误作用户编辑，权限回退依赖英文文本。
2. 之前为什么未发现：仅测试受管安装主路径和图标形态，缺外部盘点融合与本机中文系统实际错误；静态类型/源码布局检查不等于桌面可用性。
3. 防止复发：P0 独立原生状态 API、只由显式变更记账、外部所有权保护与分 CLI 不完整状态；P0 JSON/状态测试及真实临时目录 auto 测试已增加；GUI 仍保留人工门禁。
4. 系统性扩展：MCP 保存清理受管启用项的导入禁用标记；未知状态不允许快捷写入；显示顺序不进入配置保存协议。没有通过扩大权限或删除外部文件绕过错误。
5. 知识记录：同步 extensions-management-contracts.md 的签名、行为、错误矩阵和测试要求；本项目无该 skill 所述 src/templates/markdown/spec 模板树，未创建伪模板。未经授权不提交、不归档父任务。

- 新增保存/离开守卫：根因是 canonical SQLite 保存与 native CLI 应用分离，但前端既未记录待应用版本，也未在 SettingsModal 的导航/关闭层拦截。新增 feature-owned mcpPendingStore（每 CLI revision、每 Home 已应用版本、edit/save互斥 epoch），modelAdapters 和 importSync 成功变更统一记账；Skills-only/失败操作不误标 MCP。不新增数据库迁移或存储协议。
- useMcpSaveWorkflow 统一工具栏保存与离开确认。逐目标重新读取 Home/预览指纹/应用，成功才确认对应版本，部分失败只重试剩余 CLI；Home 改变拒绝误写。页面切换与设置关闭可“应用并继续 / 暂不应用并离开 / 返回”，进行中的操作阻止导航。预览弹窗改为只读，移除第二个写入入口。
- 初次/重新进入扩展设置以原生预览核对 enabled/removed 的实际差异，恢复重启后的待应用提醒；异步核对携带 epoch，不能覆盖随后编辑或保存结果。UI版本仅保留在本进程内，SQLite 定义与原生文件是重启恢复依据，不把本地缓存当作实际应用证据。
- 发现清单：mcpPending.ts（纯状态/逐目标保存）、mcpPendingStore（互斥与版本）、api/mcpSaving（预览/保存与离开弹窗）、modelAdapters/importSync（变更入口）、SettingsModal（关闭/导航/页签守卫）、GlobalExtensionsPage/GlobalMcpPanel（按钮/提示/新资源即时显示）、NativeMcpPanel（只读）、双语字典与回归脚本。后端原生写入/指纹/备份沿用既有实现，Hook/项目策略/PTY无改动。GitNexus SettingsModal LOW，其余扩展新符号 UNKNOWN，源码核对补足。
- 场景：只改一个CLI、新增/删除最后一个资源、含MCP/仅Skill导入、保存全部/部分失败、返回/暂不应用/应用继续、重复点击、操作中导航、预览后Home变化、WSL/本机Home隔离、重新打开及重启差异核对、过期扫描完成；实际视觉/跨平台文件读写待人工复验。不启动dev，不在真实用户CLI配置上自动验收。
- 定向状态与保存测试新增7项通过，连同字典/来源/布局回归共17项；覆盖Home隔离、失败保持、保存互斥、旧扫描丢弃、部分成功、指纹传递和Home变化拒绝写入。
- 保存交付批次验证：`npx tsc --noEmit`（最终源码）、`npm run build`、17项定向测试、`npm run check:architecture -- --strict`（1022源文件、0超限）及 `git diff --check` 通过；桌面确认交互仍待用户复验，未启动dev或提交。
- 配置预览入口调整：移除 MCP 页常驻 NativeMcpPanel 卡片，GlobalMcpPanel 工具栏按钮按需挂载 Modal；关闭卸载清空预览，读写期间禁止退出，保留指纹确认写入及唯一导入入口。发现清单：上述两个组件、双语文案、结构回归和版本记录；IPC/数据库/Hook/供应商配置逻辑无改动。验证边界：开关仅保存期望状态，查看不写入；键盘关闭、窄窗和主题视觉待人工复验，不自动启动 dev。
- 顶部容器修复：此前 sticky 页签仍属于滚动内容，未真正隔离列表与导航。SettingsModal 持有扩展 tab 状态，SettingsLayout/SettingsTopBar 通过可选 searchReplacement 插槽替换搜索框；header 不收缩，列表 min-h-0 独立滚动。其他设置页仍使用原搜索框。GlobalExtensionsPage 不再持有 sticky 页签或消费残留搜索词。
- MCP 导入仅保留 GlobalMcpPanel 的“导入 MCP”入口；NativeMcpPanel 移除重复导入状态/对话框/按钮，预览及原生应用不变。影响检查公共 SettingsLayout/SettingsTopBar/SettingsModal 为 LOW，新扩展组件 UNKNOWN，已核对唯一调用及无后端接口变更。
- 场景覆盖：MCP/Skills 切换、长列表滚动、窄窗口、其他设置页搜索保留、无隐藏搜索过滤、单一导入入口仍支持自动来源；新增 extensionsSettingsLayout.test.mjs 做结构回归。视觉/中英文手工复验仍需用户完成，不启动 dev 服务。
- 暂停 dev 后续报错根因：图标开关和 Skills 收起改动已写入组件，但暂停时四个新翻译键尚未补齐，参数化翻译将 undefined 传给 formatTemplate.replace。修复落在 extensions 双语字典，不改公共 formatTemplate，不以空串兜底；新增 extensionsI18n.test.mjs 遍历全部扩展组件字符串键并校验两种字典、占位符及启停参数替换。当前不自动启动 dev，导入结果可读化仍待继续，不能将上一轮四项整体标为完成。
- 用户截图后续修复：盘点卡片在限高 flex Stack 中默认收缩，Card overflow 裁切其文字和按钮；改为外层 block 负责限高滚动，内层 Stack 保持内容自然高度。导入原先只接收用户手填路径，遗漏了 settingsStore 已保存的三 CLI Hook 根目录；新增纯路径建议层和选择入口，优先提供 Hook 来源、补充供应商 Home，不修改这些设置或原生应用目标。
- 发现清单：SkillInventoryPanel（布局）；ExtensionImportDialog（来源建议、CLI 切换、溢出滚动）；importSources（路径映射/去重）；双语字典；回归脚本。既有导入 IPC 负责只读扫描与指纹确认，Hook 安装、原生写入和供应商 Home 的持久化均确认无须修改。GitNexus query 因 FTS 缺失降级，两个组件 impact 为 UNKNOWN；使用源码与契约补足。
- 场景：0/1/多条 Skill、长名称/路径、窄窗；Hook 无配置/部分配置/三个配置、自定义目录、Claude 默认与自定义配置布局、供应商 Home 不同、POSIX/WSL UNC/空格中文、CLI/来源切换、手动路径与盘点直达不被异步覆盖。SSH 不新增扫描路径，项目/Worktree/终端焦点/Hook 安装状态不改变本次只读导入来源。
- `node --test scripts/extensionsImportSources.test.mjs` 5 passed：Hook 优先、无 Hook、Claude 两种路径、跨平台路径、列表滚动容器静态回归。路径建议需扫描验证存在，不宣称已自动验证所有候选；桌面视觉仍需用户检查。
- 父任务保持 `in_progress`，不能将历史“已完成”记录视作本轮可用性验收。
- 已补齐全局 MCP 原生配置读取/显式确认应用、受管键清理、私有备份和读回；基础表单与保留未修改脱敏字段的编辑；Skills 用户/共享/插件盘点及外部技能导入入口；各模块独立保留成功加载结果。
- 扩展定向单测 45 passed；另一个 opt-in Windows 用例通过已安装 Claude/Codex/Grok CLI 读取临时 Home 内生成的配置（1 passed），未修改用户原生配置。此项不验证服务器联网、认证或会话实际激活。
- 当前 checkout 的真实 Tauri WebView IPC 已确认可用：Claude/Codex/Grok 原生 MCP 分别读取 11/12/11 条，Skills 盘点 88 条；Codex 插件缓存达到遍历深度限制，返回明确 partial-scan warning。扩展页 DOM 未出现旧泛化错误，重复 Home 表单已移除。
- 启动日志另有旧库 migration 25 `no such column: app_type` 警告；本轮扩展查询/盘点仍成功。未扩大范围修改供应商旧迁移，不能宣称整个应用数据库问题已解决。
- 按 frontend/quality-guidelines.md，人工桌面验收是视觉结果依据。此前启动和只读 IPC 检查仅保留为有限接口证据；停止后续自动界面操作，不把普通浏览器 mock 或 DOM 检查算作 GUI 全量通过。
- 人工待验：中英文切换与24小时制、深浅主题、窄窗/长路径、键盘；添加/编辑/取消；从现有 CLI 导入后确认应用与重新读取；Skills 导入/部署/卸载/恢复；新 CLI 会话实际加载。macOS/WSL、认证和项目并行/恢复门禁继续保留。
- 本轮 `cargo check --lib`、前端 TypeScript/生产构建、架构 strict（1014 files、0超限）、新增 Rust 文件 rustfmt check 与 diff whitespace 检查通过。GitNexus detect_changes 为 HIGH：供应商锁仅扩大 crate 内可见性，入口仅新增三个 IPC 注册；新增扩展符号未被旧索引充分覆盖，已结合源代码/定向测试审查，不视作零风险。


## Order

交付主线已确认：先完成全局一处维护（模型→导入/同步→全局 UI），再做项目增强。项目无法接管/控制则验收清晰的仅全局提示，不阻塞全局发布；能力失败不取消全局本身的质量门禁。

1. 审阅 decision.md 的机制与能力边界后进入有范围的实施，不再开泛化探索测试轮次。既定平台/导入范围不变；未批准的新边界不作为已确认需求。
2. `58fe4b05` extension-model-adapters：统一模型/SQLx/IPC、语义适配与版本/来源能力返回。
3. `d9e04ace` extension-import-sync：导入、GitHub 地址安装、源存储、链接/复制和恢复。
4. `e606b4f3` extension-global-management：全局交互、环境/Home、主题和逐目标结果。
5. `1b421ec4` extension-project-management：项目/Worktree 草稿、策略解析、启动/恢复隔离。
6. 父任务 R1–R10 验收及 V1.4.0 交付记录已完成，四个产品批次保持独立 commit。

## Gates

- decision.md 是当前推进依据。受管 Home 已获路线授权；认证/历史/Hook/相对路径等价性移至项目实现的集成与发布验收，不再阻塞模型/导入等独立工作开工。
- 项目实现内列举配置/可变状态/运行文件契约并完成对应定向验证；失败阻断对应能力发布，不用局部实验冒充 R6/R7/R9 全部通过。涉及真实凭据的验证不得输出或复制秘密。

- 用户已授权实施；四个子任务均已 start、审计并提交，当前进入父任务集成验收记录。
- 读取 trellis-before-dev、fix-triage-guide 及领域契约；逐符号 GitNexus upstream impact。当前FTS缺失需恢复可用后评估，不把空结果当零影响。
- 固定实际CLI版本，验证Grok项目Skill、Claude插件、Codex共享根与禁用语义。
- 主会话inline执行，不派发实现/检查agent。
- 每批运行实际新增的定向模型、导入、部署、作用域测试。
- GitHub安装定向覆盖ref含斜杠、子目录、多Skill、移动分支、重复安装、限流/取消/失败、归档越界及现有安装保留；测试不得自动运行下载包脚本。
- 前端 npx tsc --noEmit；后端 cargo check --manifest-path src-tauri/Cargo.toml。
- 共享发现改动运行 cargo test --manifest-path src-tauri/agent-capabilities-core/Cargo.toml，Rust其他单测按实际模块过滤。
- 交付独立 npm run check:architecture -- --strict。
- 跨层验证A/B并行、同路径项目、Worktree、resume/daemon、供应商切换、无Hook、WSL、外部写入和链接/复制。
- 手动中英文、主题、键盘、窄窗验证。
- Windows、macOS、WSL分别记录实际OS/架构/Shell/CLI版本、转换与导入、链接/复制、项目并行和恢复验证结果；macOS须有真实环境验证，未获得环境时明确标注缺项，不以Windows检查代替。
- 提交前 gitnexus_detect_changes；代码交付更新 CHANGELOG.md 的 V1.4.0 和 docs/功能清单.md 对应板块。
- 本轮已运行适用的构建、类型、Rust、架构、迁移、扩展单测、全库单测和 GitNexus 检查；版本记录写入 V1.4.0。

## Recovery

### Follow-up: list sorting and Skill icon actions — 2026-09-11

- 延续 V1.4.0：两类列表按名称自然正/倒序；Skills 主行保留名称、两行简介、CLI 图标，技术明细默认折叠，盘点仍按需展开。
- 发现清单：GlobalMcpPanel、GlobalSkillsPanel、SkillInventoryPanel 共用排序；MCP/Skill 共用图标展示。Skills 复用既有 auto 部署与带确认的受管卸载，不新增原生写入协议，不改变 MCP 显式保存语义。
- 场景：空列表、同名稳定排序、数字名称、三个 CLI 独立状态、缺失安装重装、外部修改/不可读/非受管/多记录保护、重复点击、卸载取消及后端 removed=false；Windows 路径大小写、WSL UNC 与 Linux 路径及发行版身份匹配。
- GitNexus 新增组件符号索引未覆盖，结果 UNKNOWN，按领域契约和实际调用补充检查；保留其他任务未提交变更。
- 定向前端测试 22 项与 TypeScript 检查通过。未启动 dev、未改动真实 CLI 配置；中英文、窄窗和真实桌面交互仍待人工验收。

操作失败仅恢复本次自有文件；配置指纹冲突保留外部更改；活跃快照和Skill版本有引用不回收。
跨机器同步不默认携带秘密、机器路径和部署状态，协议范围另行确认。

## Acceptance audit — 2026-09-11

- R1–R5、R10 的全局模型、导入、Skill 部署、备份恢复和 GitHub 安装主线已实现；R6–R7 对 Claude/Codex 的项目/Worktree 启动策略已接线，Grok、SSH、未知 WSL 身份按决策明确为 global-only，不伪装项目级生效。
- 新启动与新进程恢复按当前环境和策略 revision 生成受管快照；现有进程和 daemon 重连保留旧快照。取消不写盘，失败/关闭/恢复失败/启动垃圾回收只处理 CLI-Manager 自有快照。
- R8 代码路径已覆盖主题、中英文、键盘和窄窗；真实 GUI 手动验收、三平台 CLI 版本/认证刷新/历史连续性/Worktree 并行仍是发布门禁，不能由静态检查替代。
- 通过：`cargo test --manifest-path src-tauri/Cargo.toml --lib`（1323 passed、1 ignored）、`cargo check --manifest-path src-tauri/Cargo.toml --lib`、扩展单测（38 passed）、迁移测试、`npx tsc --noEmit`、`npm run check:architecture -- --strict`、`npm run report:architecture`、`npm run build`、定向 rustfmt 和 `git diff --check`。
- GitNexus 提交前检测报告 CRITICAL，影响集中在既有 `TerminalSession`、`resolvePtyLaunch`、迁移注册及终端 Store；已审阅高风险上下文。新增扩展符号因索引未覆盖为 UNKNOWN，按契约、调用点、定向测试和全库单测补足。
- 当前 Windows 工具链可用；WSL 无可用发行版、macOS 无环境、SSH 端到端 deferred。父任务不宣称未验证平台或 Grok 项目隔离已通过发布门禁。

## Repair audit — 2026-09-11

### Follow-up: missing extension tables

- 上次 WSL 探测解释未经运行数据库验证，不足以解释用户持续报错；Home 缓存不可用也只是代码上的可能条件，不能当作本次已证实根因。
- 只读检查默认数据根及其 bootstrap 后发现主库 `_sqlx_migrations` 最高为 37，`extension_%` 表为零。扩展仓储直接 SQLx 打开主库，却依赖前端 SQL plugin 的迁移先完成；原生 IPC 没有建表就绪保证，导致列表 SQL 查询失败。
- 发现清单：MCP repository、Skill repository、project_policy 三处主库连接均接入统一 schema gate；外部导入只读库明确排除；现有 38–40 迁移 SQL 不变；页面只提取安全错误码，避免显示路径/配置秘密。供应商 Home 初始化本轮不改，避免无证据改动。
- 场景：旧库缺表、已迁移库重复读取、并行 MCP/Skill 读取、checksum 漂移失败、既有项目数据保留；本机/WSL 均先初始化同一主库，外部来源库不迁移。GUI 重启及真实 WSL 验收另行标注，不以单元测试冒充。
- 验证：`cargo test --manifest-path src-tauri/Cargo.toml --lib extensions::` 40 passed（含 3 个新增数据库回归用例）；`cargo check --manifest-path src-tauri/Cargo.toml --lib`、`npx tsc --noEmit`、架构 strict、定向 rustfmt、`git diff --check` 通过。未手工写入实际用户数据库；GUI 中错误消失尚待新版后端页面复验，不宣称截图问题已完成运行验收。

- 根因陈述：全局扩展页自建了一套可写的环境/Home 状态，没有复用供应商的 active Home；刷新时又对全部 Skill 安装记录执行实时探测，任一不可用的其他 WSL 记录都会让 `Promise.all` 失败，最终只显示泛化的“扩展操作失败”。
- 发现清单：重复状态位于原全局 `useExtensionEnvironment`、`ExtensionEnvironmentCard` 和 `globalManagement` API；全局 Skills/GitHub 对话框依赖该状态；安装列表 IPC 原先未接收环境边界，而项目策略读取已经具备先筛选再探测的后端能力。
- 场景矩阵：供应商当前 Home 为本机/WSL；供应商设置切换 Home 后重新打开或刷新全局页；存在不可用或过期的其他 WSL 安装记录；仅有本机安装、混合本机与 WSL 安装、无安装记录；MCP 与 Skills 两个页签；Home 自动/手动来源；Windows PowerShell/CMD/pwsh/Git Bash、无 Hook、窄窗、主题和中英文。项目/Worktree、SSH 写入和 Hook 安装状态对本次全局 Home 读取不适用，仍由对应项目/Hook验收覆盖。
- 修复边界：删除全局页重复环境/Home编辑区，改由供应商 `provider_home_active_get` 提供唯一当前 Home；Skills 安装列表 IPC 按当前环境和身份先筛选，再执行实时探测；部署与 GitHub 安装继续使用同一份供应商 Home 数据。旧扩展 Home 类型、Hook 和卡片文件不再保留，避免产生第二套可写来源。
- 本轮验证：`npx tsc --noEmit`、`npm run check:architecture -- --strict`、`npm run report:architecture`、`npm run build`、扩展定向测试（37 passed）、定向 rustfmt 和 `git diff --check` 通过；全量 Rust 单测首次为 1322 passed / 1 failed / 1 ignored，唯一失败的既有 daemon 临时端口复用用例单独重跑通过。
