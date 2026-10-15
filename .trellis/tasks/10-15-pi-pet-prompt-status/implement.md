# 实施与验证计划

## 顺序

1. 契约与入口：增加专用事件、严格校验及广播隔离；不调用答题 broker，不触发通用通知/子任务处理。
2. Pi 生产者：上报外层等待区间，续期与结束、生命周期收尾，托管版本同步升级。
3. 前端状态：独立 reducer 与监听/到期回收，关联当前存活 Pi 会话；快照计算和渲染只读等待。
4. 回归：在现有测试中保护普通通知、真实请求、终态历史；新增等待状态机与跨层契约测试。
5. 静态验收：源码语法/类型结构、全部相关导入、字段匹配、守卫顺序、竞态、i18n、2000 行限制、UTF-8/CRLF、Git 空白和差异审查。
6. 更新 V1.4.3 CHANGELOG、功能清单和独立外挂接入契约；上游共享契约仅保留引用，保存核查记录。
7. 单独提交本次文件；复核远端并仅快进推送 `origin/master`。不创建 PR，不纳入旧 Pi 方案或 rpiv 源码现场。

## 发现清单

| 触点 | 影响/决定 |
|---|---|
| `src-tauri/src/pi_extension_template.ts` | 等待生产、心跳与生命周期；不改真实问答转换 |
| `features/hooks/settings/mod.rs` | 模板升级常量 |
| `features/hooks/claude.rs` 与新专用模块 | 载荷校验、字段传输；保持鉴权/去重 |
| `infrastructure/daemon/server.rs` | 仅调用外挂分发方法并传入广播回调，不内联专用处理 |
| `src/app/App.tsx` | 仅调用外挂事件标签守卫，先于通用 Hook 处理返回 |
| `terminalStoreTypes.ts` / `terminal/state.ts` | 保持原样；私有标记和区间类型放入独立模块 |
| 新前端 reducer / coordinator hook | 有界状态、身份/顺序隔离、租期回收 |
| `desktopPetEState.ts` 与主协调器 | 精确会话投影、黄色分类、历史清理，不更改普通 attention 约定 |
| `pet-e/src/bridge/protocol.ts` 与 renderer | 可选只读字段、返回会话，不增加答案按钮 |
| `desktop-pet` 中英文词条 | 只读状态文案 |
| `pet-e/docs/pi-terminal-prompt.md` | 独立契约、上游最小接点及后续同步清单 |
| `desktop_pet_e_agent.rs` / AgentStore / 提交通道 | 已确认不得复用/修改，避免替换 Waiting 请求 |
| rpiv 安装目录及 `rpiv-mono` | 仅作为调研证据，不修改、提交或安装 |
| SSH Agent / 数据库 / preferences / 依赖 | 已确认不扩展 |

## 回归场景

- 活跃/结束、重复/乱序、旧实例与新实例、不同会话、过期缓存和长时间等待续期。
- 合法 Pi 与非法来源/会话/种类/序号/标题；普通通知不能携带专用状态。
- 正常作答/取消、工作继续、Stop/StopFailure、会话替换/退出、daemon 重启。
- 通知关闭、代答关闭、宠物总开关、所有自绘/标准对话框的计数一致性。
- 真实可回答请求与只读等待共存，不撤销提交中答案、不重复计数。
- 打开会话按钮、无回答按钮、旧红蓝历史不携带过期等待、中英文文案。
- API 到只读投影的跨层契约、专用事件不触发通用状态/通知/分屏。

## 证据约束

本会话仅进行静态核查。新增/修改回归文件但不执行测试，不伪造红绿结果；不执行 build/cargo check/安装。运行验证命令由用户执行并在交付记录中列明。

既有 `desktopPetEState.test.mjs` 的导入替换仍指向拆分前的别名；为让本次状态测试可用，只纠正这两处 fixture 路径映射，不改变现有断言的语义。
