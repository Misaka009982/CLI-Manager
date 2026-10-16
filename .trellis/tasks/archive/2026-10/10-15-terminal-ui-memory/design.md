# 根因与发现清单

## 根因
1. XTermView 始终挂载 TerminalMarkdownPreview；旧 effect 在 open=false 且 Hook done/failed 时仍读取完整历史、保留全部助手正文，关闭未清理。生命周期未与实际可见需求对齐。
2. 10 秒快照定时器可重复进入异步 flushSnapshots；慢序列化/checkpoint/落盘时叠加多轮大快照。注销未使已等待任务失效，同 ID 的旧注销还可能删除新来源。xterm dispose 后不保证调用待写回调，原 Promise 可能悬空。

这些是代码与受控时序测试证明的放大路径，不代表截图全部约 1 GB 都由此造成。真实命令行确认属于 cli-manager.exe 的 WebView2 当前已有 --disable-gpu，不把禁用 GPU 当成本轮成果。

## 发现清单
- [x] XTermView → TerminalMarkdownPreview：传真实 pane visibility；关闭释放正文，隐藏暂停读取，显示后按绑定刷新；保留选择/字体等轻量状态。
- [x] 请求序号、SSH consumer、useMarkdownPreviewScroll：失活废弃结果并关上下文，隐藏暂停滚动观察；身份切换清理保留。
- [x] useXTermController → registerTerminalSnapshotSource：完整序列化不变，接入可取消写屏障；已有 terminal/WebGL/监听清理不重写。
- [x] sessionSnapshotPersistence → sessionStore/checkpoint：单飞，强制请求补最后一轮，来源身份校验，失败重试；格式不变。
- [x] App 退出与 useRemoteHandoffCoordinator：同一 flushTerminalSnapshotsNow 入口，不改业务调用方。
- [x] runtimeDiagnostics：既有日志接入来源数/脏数/正在刷新/快照字符量，不记录正文。
- [x] historyStore：仅单一 activeSession，统计缓存已有条数上限，不随意清除用户当前数据。
- [x] 文件/Monaco/Git/Web/Rust：本轮无修改。Monaco 多模型保留需证明所有权和撤销历史后才能安全淘汰，不能直接 dispose 其他面板模型。

## 场景与风险
覆盖未打开/打开/关闭/重开、done/failed/running、前后台 Workspan/分屏、绑定 ID 变更、SSH 上下文迟到、选择/星标、各阶段慢或失败、退出/接管、关闭/同 ID 重挂/写回调丢弃。本地与 WSL 共用本机历史入口；不改 PTY 数据，不卸载后台终端。

GitNexus 未暴露，按分诊规则降级 codebase-memory 调用图 + workspace-session-restore/background-task-continuation 契约 + 源码/rg/diff。实施前已刷新索引。快照影响 useXTermController、App、remote handoff，CRITICAL/HIGH 编辑前已告知。按 inline 执行，无子代理。
