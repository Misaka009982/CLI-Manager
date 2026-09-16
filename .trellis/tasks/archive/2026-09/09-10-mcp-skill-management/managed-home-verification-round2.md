# 受管 Grok Home 第二轮验证

2026-09-10，Windows / Grok 0.2.118 (1e1687c1cf)。沿用 C:/Temp/cli-manager-managed-home-probe-20260910 临时夹具；无产品实现。master 对本地 origin/master 为 0/0，未 fetch。

## 实测结果

| 用例 | 证据 | 结论 |
| --- | --- | --- |
| GROK_AUTH_PATH 读取 | 原生 logout 的临时日志 resolved_path 指向 auth-fixture/auth.json；auth-home/auth.json 为刻意不可用的哨兵且字节不变 | 本机路径覆盖生效 |
| 认证写入与锁位置 | 在当前 OIDC scope 放入假凭据后，原生 logout 退出 0，清除指定临时认证文件；auth-fixture/auth.json.lock 存在，Home 哨兵未变 | 本机退出登录路径共享原认证目标/锁目录可行；未验证刷新锁竞争 |
| 无历史共享的阴性对照 | 原始 Home sessions list 可见假历史；history-home 为 No sessions found | 单独接管 Home 确实改变历史可见性 |
| Windows Junction | 非提权 New-Item -ItemType Junction 将 history-home/sessions 指向 original/sessions，创建成功 | 当前本地 NTFS 路径可用，不代表所有文件系统/WSL 可用 |
| 历史读取 | Junction 后，两种 Home 的原生 sessions list 都列出相同 UUID/标题 | 假历史的原生列举通过；不是实际会话 resume 验收 |
| 通过 Junction 写入 | 用夹具写入第二条 summary.json，两种 Home 的原生命令都列出两条历史 | 文件可见性通过；写入由测试夹具完成，不是 CLI 会话持久化证明 |
| 新 Skill 名称 | 在已有空集合快照之外新增项目 probe-new，重新 inspect 后它仍启用 | 固定 skills.disabled 名单不能覆盖新名称，失败用例得到确认 |
| 同名 Skill 覆盖 | 项目 probe-b 替代配置包 probe-b，inspect 来源变为 project | 仅按名称选择不能保证包身份 |
| 普通 Skill 目录过滤 | A 的 skills.ignore 指向项目 .grok/skills；inspect 不再出现 probe-new，B 来源恢复 configToml，启用集合 ABC | 普通目录过滤候选通过；不是长驻 watcher 实验 |

## 认证实验安全边界与修正

仅使用假 key、fixture@example.invalid 及临时路径；原生 logout 删除的只是本轮创建的假认证文件。夹具可按下面格式重新生成，不需要恢复真实数据。未读取/复制用户真实认证，未使用真实账号请求模型。
子进程移除继承的 GROK_/XAI_/OPENAI_/ANTHROPIC_ 环境；仅显式设置临时 GROK_HOME/GROK_AUTH_PATH。HTTP(S)/ALL_PROXY 指向本机拒绝连接端口，关闭临时配置遥测。没有将该实验安全设置作为产品配置继承规则。
最初 telemetry 使用错误的表结构导致配置解析失败，改为 `[features] telemetry=false` 后才进行有效测试。
最初假凭据位于 xai::api_key，当前 logout 查找 OIDC scope，返回 No cached session；该结果不算通过。读取临时日志确认当前 scope 后，使用该 scope 的假 OIDC 条目重测，明确观察到原生读写成功。
临时认证条目形状：scope 为本机诊断得到的 `https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828`，value 含假 key、auth_mode=oidc、create_time、user_id、email。该 scope 是实验数据，不允许硬编码到产品；产品须复用 CLI 原生认证配置解析。
auth-probe.cjs 会清除这条假凭据，属于一次性夹具；重跑须先重新建立假条目，不能把已空的认证文件作为阳性对照。

## 复现入口与前一轮脚本关系

- `node auth-probe.cjs`：假凭据阳性对照后断言原文件条目被移除、哨兵未变。
- `node history-probe.cjs`：原生历史列举；先无 Junction 阴性对照，再有 Junction 阳性对照。本轮写入 summary 使用源码的最小必需字段与真实 cwd 编码，不使用用户历史。
- `node new-source-probe.cjs`：明确断言空集合存在未拦截的新名称，属于“确认缺陷”的实验，不是功能通过。
- `node new-source-probe.cjs managed-a`：断言新名称隐藏、B 的来源恢复、ABC 集合正确。
- 前一轮 run.cjs 在本轮加入新来源后不再代表原先固定 ABCD 夹具，不应期待它全部通过；保留该失败可暴露名单方案的边界。前一轮记录是当时夹具状态下的结果。

## 方案修正

认证优先原生 GROK_AUTH_PATH：保留原有覆盖，未设置时解析原 Home/auth.json。不能为每个受管 Home 创建独立刷新锁，也不能通过复制凭据保证连续性。
Windows 历史共享可评估 sessions 目录 Junction；路径目标须精确验证、权限保留、只清理链接本身。尚未验证原生会话追加、索引并发、崩溃恢复、已有 leader 和恢复命令，不直接纳入“已支持”矩阵。
普通 Skill 采用“受管内容版本 + 原始发现根排除 + 选中包路径”，不能只枚举未选名称。注意 ignore 按 canonical 路径过滤：若选中包只是链接回被排除根，它也可能被排除；受管源须有独立、明确的根。
插件不能套用上述方案：已核对的上游 skills.rs:114 先 filter_skills，:117 再 collect_plugin_skills/merge，之后才按名称 disabled。插件单项隔离、后续新插件及更新需另外验证，不能用关闭整个插件牺牲其他功能。
新增 MCP 名称也不受固定 disabled_mcp_servers 列表约束；同名项目定义仍可覆盖被选定义。现有证据只支持“已发现集合”的配置控制，不支持承诺任意动态来源的严格集合。

## 仍未完成，禁止标记通过

真实 OIDC/API-key 登录与令牌刷新；刷新锁竞争；原生历史追加/索引/resume；持久会话配置变更与重连；leader/socket/bin；插件单项控制；动态 watcher 的端到端控制；完整供应商/Hook/规则/相对路径等价性。
macOS 当前无执行环境；WSL 上轮已确认本机未安装。本轮未安装系统组件或申请提权。
接下来不能只反复执行 inspect 来填补这些缺项：需要可控模型/认证测试端点及长驻会话夹具；真实认证最终还须专用测试登录环境，macOS/WSL 须对应测试机。以上是不同性质的验证缺项，不是用户已同意接管 Home 就能免除的验收。
