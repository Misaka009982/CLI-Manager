# Codex profile Hook 信任修复验证

## 基线与根因

- `master a9ea11c9` 与本地记录的 `origin/master` 同步；本轮从该提交开 `fix/codex-profile-hook-trust`，未 fetch/pull/merge/push。用户确认新任务关联 `10-08-codex-provider-config-propagation`，沿用 1.4.3，仅 NSIS。
- 只读证据：Codex 0.162.1 的 `--profile` 叠加 `<name>.config.toml`；全局有八项有效确认、提问 Hook 的旧 matcher 哈希过期，两个供应商 profile 各保存了新确认。生成入口重写同名文件丢失决定，检测入口仅查全局。
- 官方语义：https://learn.chatgpt.com/docs/hooks ：非托管 Hook 按当前定义的精确哈希审核，不绕过 `/hooks` 的用户确认。

## 交付与发现清单

- [x] 普通 scope 启动与远程 cc-connect runtime 的 profile 写入接入 `codex_profile::write_preserving_hook_state`；只保存同名已有 `hooks.state`。新配置中的信任剥离；不同 profile/全局隔离，损坏和替换前外部修改拒绝覆盖。
- [x] 11 个聚合查询/安装/卸载命令接受可选 profile，上下文一致；`codex_status` 合并全局与指定 profile 后检测特性和精确信任，缺失/非法 profile 不回退为全局成功。新增 `effectiveConfigPath`、`hooksTrusted`，不改变旧状态枚举与公共配置同步的实际配置来源。
- [x] 当前本机终端真实命令优先于供应商 fallback，覆盖 resume/短参数/引号/项目组合 profile。WSL/SSH/transcript 不借用宿主 profile。设置与侧边栏共用请求守卫，旧成功/错误不覆盖新上下文，失败清除旧绿色。
- [x] 待审核解释和有效路径、检查错误均有中英文；待审核点击进入设置。可见窗口每 10 秒只读检查待审核状态，隐藏/请求进行中不检查，完成后停轮询；焦点/可见变化也只读刷新。
- [x] ConfirmDialog、PTY/daemon、模型请求、历史删除、数据库结构与项目快照生命周期确认无关，未改动。设置大组件只搬出已有声音错误映射以满足 2000 行限制，不改变声音行为。

## 已执行

- Rust `provider::`：199 通过（包括 5 项写入/真实 runtime 入口测试）。
- Rust `hook_settings::`：44 通过（包括 5 项有效配置/临时真实九项哈希与再生成集成测试）。
- Rust `project_policy::tests`：17 通过；`codex_app_server_proxy::tests`：29 通过。
- Node 定向回归：77 通过，涵盖新 9 项 profile/请求/可见刷新/实际侧边栏回调/双语测试，以及启动隔离、恢复参数、供应商、Hook 归属和异步提问回归。IPC、React 调度/事件、设置等外部依赖为模拟；没有启动桌面应用或实际审核用户 Hook。
- 加入既有 `kimiHookFrontend.test.mjs` 的扩展回归为 80/81：一条旧源码正则断言要求 `event.payload.source`，实际基线已使用 `payload.source`（App.tsx:962），同文件仍有 Kimi 防护。测试及所读 App/terminalStatus/hookErrors 与 HEAD 均无差异，本轮不为通过检查改无关业务或测试。定向 77 项独立全绿。
- `npx tsc --noEmit` 与独立 `npm run check:architecture -- --strict`、`git diff --check` 通过；严格架构 1313 个源码文件、0 超限、0 新违规。
- GitNexus 工具未暴露，依契约降级至 codebase-memory 与真实源码。分支后和实现后 moderate 索引已刷新，44,033 节点/118,287 边；抽查有效状态入口源码与两处 UI 调用。图对 `super::codex_profile` 调用漏边，以源码、真实 runtime 测试和跨层临时 Home 集成复核；detect_changes 只作辅助，不声称完整覆盖新文件。

## 限制与验收

- 尚未运行安装后的真实窗口/中英文切换或 WSL/SSH 环境验收，未安装、重启用户程序、修改真实配置/Hook/信任，也未调用供应商模型。用户安装后需验证当前供应商终端 `/hooks`，再关闭并新建同一供应商终端，检查决定保留和灯色。
- 如果旧版本已抹掉确认，需要在 Codex 中再确认一次；新独立项目 profile、定义变更或显式禁用仍由 Codex 审核，不承诺全部自动绿色。
- 写入检测到外部变化会失败以保护用户决定；最后字节检查与 rename 之间仍有极短跨进程竞态，不宣称 CAS。新包不可修复用户手动删除/损坏的 profile，错误会显式报告。
- 已先提交再构建，安装包证据见下；没有安装、启动应用或推送。


## 安装包交付

- 来源提交：`e6c1632e458e4c67da0b4d7b9d7f49f0e005755f`（`fix/codex-profile-hook-trust`）。打包前工作区干净。
- 命令：`npm run tauri:build:local -- --bundles nsis`，退出 0；桌面与 Web 生产构建通过，复用 `src-tauri/target/local` Rust 依赖缓存，release 编译 3m10s，只生成 1 个 NSIS 包。仅有既有 chunk/标识符提示和 Windows 链接器信息警告。
- 文件：`F:\gitRepository\CLI-Manager\src-tauri\target\local\release\bundle\nsis\CLI-Manager_1.4.3_x64-setup.exe`
- 版本：release 主程序 FileVersion/ProductVersion 均 `1.4.3`。
- 时间：`2026-10-15 12:14:25 +08:00`；大小：`30,202,263` 字节。
- SHA256：`9A656E2A09D47F451E58A18351B93D5F275B9003AAD67989DAEB91DD688AE9B7`。
- 原包备份：同目录 `CLI-Manager_1.4.3_x64-setup.before-codex-profile-trust-20261015.exe`，`30,210,162` 字节，SHA256 `777935BDC733251E80178517900B207AE032F025A62D3EB8408F7A5C4D67CE3A`；未覆盖旧备份。
- 构建后源代码没有额外变更。GitNexus 不可用时的 detect_changes 已执行；暂存模式返回空集，已明确以真实 staged diff 审核为准（不是“无影响”）。过程降级另存本地忽略文件 `.codex/operations-log.md`。
- Trellis 保持待用户验收，不提前归档。重点测试：选择有 profile 的本机 Codex 终端 → `/hooks` 检查/确认 → 可见窗口最多约 10 秒刷新 → 关闭并重建同一供应商终端，确认不会因覆盖再次要求审核；切换终端后路径和灯色不串用。

## 2026-10-15 第二轮：目录信任与按钮回归

- 用户确认追加本任务，沿用 1.4.3，先提交后 NSIS，不推送。
- 根因与发现清单见 design.md 追加章节；本章节替代上轮“只保留 hooks.state”和“待审核点击进入设置”的交付行为。
- Rust provider:: 202/202 通过（新增三项：真实 runtime 三次重建及不同 profile 隔离、内联表精确路径与拒绝决定、非法旧记录不覆盖）。另外 hook_settings:: 44/44、project_policy::tests 17/17、codex_app_server_proxy::tests 29/29 通过；Rust 合计 292 项通过。
- Node codexProfileHookTrust 9/9 通过：真实侧边栏待审核点击依次调用卸载、安装、刷新，不打开设置；完整安装仍只打开设置。IPC 与 React 环境采用测试替身，没有实际安装/卸载用户 Hook。
- npx tsc --noEmit、独立 check:architecture -- --strict、git diff --check 通过；1313 个源码文件，0 超限、0 违规。
- moderate 索引已更新至 44057 节点、118354 边；抽查 preserve_project_trust 确实被 profile_with_saved_state 调用。detect_changes 返回预期 9 个变更文件但 impacted_symbols 为空，因此以源码调用及真实 git diff 复核为准。
- 未运行安装版 GUI、新旧语言切换、WSL/SSH 或实际 Codex 信任交互；不读取/改写用户密钥、不修改真实配置和信任、不关闭用户终端。
- 同名 profile 中原先已被旧包抹掉的决定仍需用户确认一次；新独立项目扩展 profile、不曾信任的目录不自动授权。现有写前字节检查不保证跨进程 CAS。

### 第二轮安装包（目录信任补全）

- 来源提交 `ca649e5b2ebdb9624a16e68eb472df16257cdce4`；提交后干净工作区构建，构建后无源码变化。
- `npm run tauri:build:local -- --bundles nsis` 退出 0；桌面/Web 生产构建通过，复用 local release 缓存，Rust release 4m54s。仅生成 NSIS，未构建 MSI；既有 chunk/标识符/链接器提示，无构建错误。
- 文件：`F:\gitRepository\CLI-Manager\src-tauri\target\local\release\bundle\nsis\CLI-Manager_1.4.3_x64-setup.exe`
- 时间：2026-10-15 14:22:51 +08:00；大小 30,205,402 字节；主程序 FileVersion/ProductVersion 均为 1.4.3。
- SHA256：`8549BCF98A94FBA43B26C0488D90263DD3B4F7144827C89BDF1F5DA4171476BB`。
- 本轮旧包备份为同目录 `CLI-Manager_1.4.3_x64-setup.before-directory-trust-20261015-141158.exe`。未安装或推送。
- 人工验收：退出旧版应用后安装本包，重开同一供应商的项目；若旧版已清掉记录，确认一次，然后连续重开两次确认不再弹出。待审核 Hook 点击应安装/重装，完整安装绿色状态点击仍打开设置。

## 用户验收与远程同步（2026-10-15）

- 用户反馈“修复了”，授权按既有流程推送修复分支与 master，不提 PR。
- 开始时工作区干净、当前修复分支无上游；获取 origin 后本地 master 落后 4 项提交，修复分支与 origin/master 各领先 4 项。
- 将 origin/master `677338c5` 合入修复分支，提交 `098a7ddb`，无冲突；保留远程新增终端布局锁及本轮两次修复。
- 合并后执行 profile Hook 与布局锁前端定向测试，33/33 通过；npx tsc --noEmit 和独立严格架构检查通过（1321 个源码文件，0 超限、0 违规）。不改写已交付安装包，它仍基于 `ca649e5b`。
- 仅当前任务记录归档，不修改其他开发者的任务或工作区日志；后续以 master 与修复分支的远程一致性确认推送。
