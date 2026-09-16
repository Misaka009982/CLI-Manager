# Technical design draft — V1.4.0

## Current decision entry

最新用户决定：全局“一处维护、各 CLI 使用”为首要交付；项目为次要增强。某 CLI/环境的项目 MCP 或 Skills 无法达到效果时，在对应设置明确仅支持全局，正常使用全局且不冒充项目策略生效。此决定覆盖下文历史设计中“R6/R7 不减项/阻断项目能力才能整体交付”的措辞，详情以 decision.md 与 PRD 为准。

当前收敛方案与待审能力边界见 [decision.md](decision.md)。本文下方保留详细设计及阶段性证据；其中“实施前完成全部原型”的表述改为实施阶段对应集成/发布门禁。停止泛化测试轮次，按选定机制实施、按支持域验收。启动时保证与不可控来源拒绝边界待用户确认，不擅自删减 R6/R7。

## Isolation review — 2026-09-10

最新证据与决策以 [isolation-verification.md](isolation-verification.md) 为准。Grok 本机对照确认项目 skills.disabled 与 GROK_CONFIG/GROK_CONFIG_PATH 覆盖无效，用户级同字段有效。Codex MCP 原生覆盖对照通过；Claude 与 Codex Skills 仍需实际会话验收。
统一模型、源存储、导入及原生快照方向已收敛；三 CLI 项目隔离不能标为全部可行。用户现已批准受管 GROK_HOME 验证路线，要求原始配置全部继承、仅覆盖 MCP/Skills；不采用 Grok 项目功能降级方案。R6/R7 不减项，认证/历史/Hook 等价性仍是实施前门禁。

## Managed GROK_HOME — approved direction, pending validation

第二轮证据见 [managed-home-verification-round2.md](managed-home-verification-round2.md)：GROK_AUTH_PATH 假凭据原生读写/锁目录通过，Windows sessions Junction 的假历史列举与文件可见性通过；未验证真实刷新、原生持久化和 resume。新增 Skill 名称能突破固定 disabled 名单；普通目录 ignore 可恢复包身份，插件在该过滤之后合并，仍需独立策略。不得把上述局部通过解释为整个接管方案可交付。

本机原型结果见 [managed-home-verification.md](managed-home-verification.md)：Skills ABC/BCD/空集合及 MCP 专用列表通过，本地测试 MCP 握手通过。项目可覆盖 per-server enabled，需使用顶层 disabled_mcp_servers；inspect 发现列表不反映其禁用状态。同名定义、动态新增、真实认证/历史和跨平台仍未通过，不能开始宣称完整隔离。
认证候选优先复用 GROK_AUTH_PATH 指向原始认证路径并共用锁域，避免复制/单文件链接；此入口只有源码依据，尚需本机实际验证。Windows 普通目录软链接已报权限不足，不得对认证/历史静默回退复制。

原始 Home 在注入环境之前解析并固定，使用当前环境的既有 GROK_HOME 或 CLI 默认解析结果，不能从已注入的子进程环境再次推导，避免把受管 Home 当作来源递归复制。只设置目标 Grok 进程的 GROK_HOME，不改系统 HOME/USERPROFILE，不改外部终端环境。

生成管线：原始配置清单与指纹 → 同语义基线 → 应用项目 MCP/Skills 策略 → 非扩展差异审计 → 原子发布受管 Home → 以原项目 cwd 启动。快照身份包含原始 Home、环境、项目/Worktree、策略 revision 与基线指纹。

- config.toml 为独立投影文件，不能直接链接原文件后修改。保留未知字段与无关内容；移位影响相对路径时必须保持原解析目标，并验证注释、环境引用与包含文件语义。不能重建一份“常用字段”配置冒充完整继承。
- 唯一允许的业务差异为 MCP 与 Skills 加载策略。供应商、模型、权限、企业限制、Hook、状态栏、规则与其他插件能力必须保持原有效行为。插件同时提供其他功能时，不允许通过关闭整个插件实现单项 Skill 禁用。
- 将配置、认证/历史等可变状态、缓存、进程运行文件分别建模。配置可投影；认证/历史要求连续性，不直接复制活动数据库，不做退出时全目录覆盖回写。采用原生路径入口或精确共享的可行性须源码及实验确认。
- 不链接整个原 Home；逐项共享须验证所有权、并发与目标权限。Windows 不能创建所需链接时，认证/历史不能静默退化为易过期副本；应明确报兼容性失败并保持原配置不动。macOS/WSL 分别验证。
- leader/socket/锁等运行文件按语义决定隔离或共享，不能复制运行中的句柄文件，也不能为了隔离导致 resume 或会话归属失效。此分类需要验证，不预设所有文件均可复制。
- 原项目目录、共享技能目录及插件扫描仍可能引入额外资源。必须覆盖所有发现来源，并证明有效集合满足策略；受管 Home 本身不是完整隔离证明。
- 快照生成或等价性验证失败时阻止“已应用”状态，不能静默启动未隔离会话。清理仅移除受管产物与链接本身，不删除链接目标或原始状态。

已确认生命周期：新启动/创建新进程的恢复重新读取原始配置；现有进程保留启动快照，不被后台替换配置，重连不重新注入。原始配置变化显示待新会话应用。认证刷新/历史新增另按状态连续性协议处理，不冻结为启动时副本。受管会话内部设置变更的持久化/回写边界也必须显式设计，禁止整文件回写覆盖原始 MCP/Skills。

## Boundaries and canonical model

前端新增 src/features/extensions，以 api 显式导出公共入口；settings 挂载页面，projects 提供项目入口，terminal 消费已解析启动计划。
Rust 新增 features/extensions，拆分 commands、repository、scope、adapters、import、skill_deployment。复用 SQLx、应用数据根和 CLI Home 解析，不把业务塞入 settingsStore 或 provider 大文件。

MCP 权威格式为版本化 JSON：稳定 resourceId、serverKey、name、transport、command/args/cwd 或 url、env、headers、secretRefs、语义化超时、perCliExtensions。
高级编辑也只维护这份 JSON。原生 JSON/TOML 仅为输出预览和投影，不产生三份可编辑权威副本。
perCliExtensions 保存厂商专用字段，导入未知字段保留来源并提示兼容性，不能向其他 CLI 盲传。
Claude headers → Codex http_headers → Grok headers 由适配器映射；传输能力、超时单位、null、数组、嵌套表和认证分别校验。OAuth 凭据不当成通用配置直接复制。
列表脱敏，秘密编辑走独立受控接口，日志不输出配置正文。

其他概念实体：
- SkillPackage：ID、源目录、仓库/ref、内容哈希、版本。
- Installation：环境/Home、CLI、目标路径、实际方式、链接目标/副本哈希、所有权。
- ScopePolicy：环境、CLI、项目/Worktree、MCP或Skill、inherit/custom、选中IDs、revision。
- ApplyResult：期望/实际revision、目标、错误码、冲突、待重启状态。
SQLite 与文件不能同事务提交，使用可恢复操作日志及逐目标应用状态。

## Scope and launch

候选优先级：企业强制限制 > Worktree覆盖 > 项目覆盖 > 全局默认。全局关闭是默认值，项目仍可显式选择资源；强制限制不能绕过。
inherit 动态跟随，custom 空集合全关。MCP/Skill 独立设置。
流程：环境解析 → 原生发现 → 合并策略 → 能力校验 → 有效集合 → 不可变快照 → 合并供应商启动配置 → PTY → 实际会话诊断。
快照按 scope/revision/environment 标识，活跃会话引用结束后回收；新建、resume 和恢复共享解析入口。仅重连已有进程不重新应用配置。
禁止通过全局切换后切回来模拟隔离，禁止随意重定向 CLI Home 导致认证/历史/Hook 丢失。

Claude MCP 优先验证 --mcp-config + --strict-mcp-config；普通 Skill 验证 skillOverrides，插件另行处理。
Codex 本机直接启动优先使用包含供应商非秘密配置、MCP 与 `[[skills.config]]` 路径覆盖的受管项目 profile；WSL、非直接命令或 profile 写入不可用时回退为等价的 `-c` 覆盖。明确处理所有未选来源，不能只添加选中项。
Grok 项目配置不能假设接纳 [skills]，先实验原生启动覆盖能力；无法生效时阻断对应开关并说明，不能假成功。
共享目录、插件新安装与动态发现可能扩展加载集；严格集合保证必须明确覆盖来源和CLI版本，不宣传为安全沙箱。
项目策略已限定为 CLI-Manager 启动/恢复的会话。策略保存在应用数据中，通过对应进程的启动参数与受管快照应用，不为此改写原生全局或项目配置。Codex 本机项目 profile 写入解析到的默认配置根，使用快照 ID 命名并在会话释放/垃圾回收时清理；profile 只包含非秘密配置，供应商密钥仍由进程环境注入。外部终端直接启动不注入项目策略；全局管理功能仍按用户选择更新全局默认。
项目保存只更新策略revision。恢复若创建新CLI进程则解析当前策略；重连已有进程保留原快照。无法识别或安全注入的自定义启动命令显式标记不支持，不静默声称应用成功。

## Supported platforms — confirmed

V1.4.0 完整范围为 Windows、macOS 本机与 Windows 下的 WSL；SSH 远端管理延后。环境选择与项目入口按能力禁用 SSH 写入，不回退本机目标。此决定适用于所有子任务。
路径均通过现有应用数据根、CLI Home 与环境解析服务获取，不硬编码盘符、用户目录或 macOS 安装路径。Windows 与各 WSL distro 的 CLI 目标分离。
Windows：验证权限受限的目录软链接、文件占用时原子替换、盘符/空格/中文路径、PowerShell/CMD/Git Bash 参数引用。auto 仅在链接不支持或权限受限时回退复制；不要求用户提权作为默认流程。
macOS：验证 POSIX 目录软链接、目录权限、默认 zsh 启动引用、GUI启动时CLI路径解析、空格/Unicode路径，以及大小写敏感/不敏感卷上的冲突；不能直接复用Windows路径比较。
WSL：文件读写与链接创建在指定distro内完成，不直接通过UNC写入；源与目标路径须对该Linux环境可见。Windows数据目录与WSL目标跨文件系统时验证实际可访问性，auto可按能力选择复制，显式链接不支持则报错。
包名与安装路径不能仅通过转小写去重；同名不同内容按真实目标文件系统检测冲突。各平台仅清理拥有的链接本身，不能递归删除链接目标。
UI使用既有平台快捷键、字体及主题规则，全局设置与项目编辑不引入Windows专属路径占位文案。

## Import flow

cc-switch SQLite 只读 SQLx，探测 schema 版本；WSL 走既有 in-distro snapshot。
读取 MCP、Skill 安装记录、开关、仓库来源和实际源文件；缺失文件返回原因。Profile 不自动映射项目路径。
import_preview 返回候选、脱敏差异、冲突与来源指纹；import_apply 接收选择，重验指纹后逐项执行。
以来源身份和内容哈希识别重复；同名异内容另存/跳过/显式替换受管记录。名称不是唯一身份。
Skill 完整包经 staging 校验后进入自有源目录，不能把外部目录认作可删除的所有物。
导入与应用到 CLI 分开呈现，未经明确目标选择不反向写配置。原来源保留。
软链接目标读取必须有界且验证根目录，拒绝循环、越界。

## GitHub Skill installation — confirmed

GitHub地址安装纳入V1.4.0，市场搜索和自动更新延后。复用导入候选预览、冲突处理及部署管线，不另建一套安装状态。
流程：输入GitHub仓库或子目录地址 → 解析仓库/ref/子目录 → 解析到确定commit → 有界读取候选SKILL.md → 选择技能与目标CLI/同步方式 → 下载完整包到staging → 校验并发布到自有源 → 分目标部署结果。
仓库内多技能允许选择；无SKILL.md、ref不存在、无法访问和网络失败显示具体原因。URL中含斜杠的分支名不可直接按第一个路径段截断，应结合远端ref解析，歧义时允许明确指定ref与子目录。
记录规范仓库地址、所选ref、解析commit、包子目录与内容哈希，预览和安装使用同一commit，不能在中途跟随移动分支安装不同内容。
下载复用项目现有网络/代理设施，认证不可用的仓库明确报错；不从URL提取凭据写入列表或日志。下载超时、取消、限流和部分失败可重试，保留已有安装。
限制压缩下载、解压大小、条目数量和深度，验证归档路径与链接目标；拒绝路径穿越、Windows保留名称冲突和越界链接。仅安装文件，不自动运行仓库安装脚本。

## Skill deployment and config writes

源位于 appDataRoot/extensions/skills，版本内容、staging、备份分离。支持 auto/symlink/copy：
auto 优先软链接，仅明确不支持或权限受限时回退复制；显式symlink失败不自动改策略。
记录真实链接目标或副本哈希。外部同名文件先冲突，不覆盖。
版本化源和临时部署发布避免删除重建源造成读取空窗；旧版本有活跃引用时保留。
卸载只移除归属可证且未被外部修改的链接/副本；备份可恢复，其他CLI仍引用源则不删除。
共享 .agents/skills 可能被多个CLI扫描，必须结合禁用适配器；分发不是隔离。
现有诊断不跟随目录链接，需增加受控的链接识别，与管理结果保持一致。
原生配置写入：指纹检查、单目标协调、字段级合并、原子替换、备份。TOML保留无关字段和注释；无法处理拒绝写入。
provider/Hook/statusline 同文件写入需要协调字段所有权，不能整文件互相覆盖。

## UI / interaction

全局设置新增“MCP 与 Skills”，复用 SettingsLayout/SettingsNav/SettingsTopBar。
页顶环境/Home选择，MCP/Skills标签、搜索、添加与导入。
MCP行显示名称/传输/来源、三个CLI开关和应用结果；Skill行显示来源/安装实例/实际同步方式/外部修改状态。
导入向导：来源 → 扫描选择/冲突处理 → 目标CLI与方式 → 分项结果。原生输出仅在高级详情预览。
Skills页增加“从GitHub安装”入口，沿用上述向导，提供地址、ref/子目录、候选勾选、版本与目标确认、进度及取消。所有文案与状态复用全局主题和中英文约定。

项目右键与项目设置均进入同一编辑器：
- 标題显示项目或Worktree、环境、CLI；MCP/Skills独立标签。
- 跟随全局/自定义集合；Worktree对应跟随项目。切到自定义以当前有效集合初始化草稿。
- 复用资源列表，搜索、已选过滤、批量选择；批量操作明确筛选范围。
- 展示最终集合、继承来源、不可控/不支持原因。
- 保存/取消，未保存退出沿用现有确认弹层；恢复继承清除覆盖，不存全局列表副本。
- 保存后提示新会话生效，已有会话待应用；不自动重启运行任务。
- 项目编辑器明确提示“仅对 CLI-Manager 启动的会话生效”，中英文均提供对应文案。

全局外观使用已有 surface/text/border/primary/error tokens、圆角间距与焦点样式，不引入cc-switch主题。样式通过 src/styles/components.css 有序导入。
zh-CN/en-US、24小时、键盘、窄窗口、长名称路径都作为验收。细节由可点击原型审阅后收敛。
