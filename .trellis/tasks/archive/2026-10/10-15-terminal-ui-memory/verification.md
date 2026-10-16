# 验证与限制

## 已完成
- 6 个定向 Node 测试文件：50 项通过、0 失败。包含真实生产模块的快照单飞、强制刷新 24 个微任务到达边界、取消/同 ID 替换、迟到结果、失败重试、完整 checkpoint 与既有 2000 行尾部；预览关闭/隐藏/重开/绑定切换/SSH 迟到/星标/选回答/布局/重挂。
- 控制夹具里 20 次重叠周期请求只触发一次待完成序列化；关闭预览后状态中的 100 万字符回答降为 0，未打开预览的 done/failed 不产生历史请求。这是生命周期回归证据，不是生产 WebView2 RAM 测量。
- npx tsc --noEmit；独立 npm run check:architecture -- --strict：1323 个源码文件，0 超限/违规；git diff --check 通过。
- remoteHandoff 旧测试最初因临时目录缺少 agentCapabilities 新引用的 wslPaths 而 ERR_MODULE_NOT_FOUND。只补真实依赖的测试编译/导入映射，未改接管业务，随后 7 项通过；合并定向测试共 50 项通过。
- 代码审查修正单飞结束时外层 finally 的微任务空隙，强制请求不会丢失；补 24 个到达时点回归。

## 未覆盖与取舍
- 未启动新桌面实例、未安装或重启用户程序；当前安装版没有已连接的调试会话，未采集生产 WebView2 堆快照，也没有同终端负载的旧/新整机工作集对照，不能量化总内存降低比例。
- 预览关闭后不再预加载，重新打开需读取历史；保留仍有效的选择索引。打开但隐藏的面板保留当前正文以维持视图，暂停新读取，切回重新刷新。
- 原已发出的历史 IPC 无取消协议，关闭时只能拒绝结果/结束后释放，不宣称中止正在运行的后端解析。
- 单飞避免并发峰值但正常快照仍序列化完整回滚，慢 checkpoint 仍受既有传输超时约束。未降低 5 万行设置，未改输出、光标、WebGL 或缓存数据。
- 测试为真实源码 + 模拟 React/IPC/时序，未覆盖原生桌面关闭/远程接管全流程或 WSL/SSH 实机。未增加用户文案，未修改中英文翻译。
- 先提交再构建 1.4.3 NSIS；不推送、不自动安装。构建结果后补。

- 实施后 memory 索引刷新为 44252 节点 / 117894 边，抽查 serializeTerminalAfterWrite 已接入调用。detect_changes 全工作区列出 10 个已跟踪文件但符号为空，staged 模式错误返回空；因此以 git diff --cached 逐项复核 16 个实际文件（含新增测试/任务），不把工具空结果当作无影响。

## NSIS 交付
- 源码提交：57c54e7185542a6c6971c8439707979cb40f1ff1；提交后工作区干净再构建，构建结束无源码变化。
- npm run tauri:build:local -- --bundles nsis 退出 0。桌面/Web 生产构建通过，Rust 复用 local release 缓存，耗时 1m36s；仅 NSIS，不安装、不推送。
- 安装包：F:/gitRepository/CLI-Manager/src-tauri/target/local/release/bundle/nsis/CLI-Manager_1.4.3_x64-setup.exe
- 生成时间：2026-10-15 16:59:14 +08:00；30,182,626 字节；主程序 FileVersion / ProductVersion 均为 1.4.3。
- SHA256：1C22206B38E4FA3520A792ABE4B9DFC9144BB4A0468F9FC6778E3907E5E4A083。
- 上一轮包保留同目录 CLI-Manager_1.4.3_x64-setup.before-ui-memory-20261015-165306.exe。
- 仅既有 chunk/导入、bundle identifier、Windows 链接器提示。未启动热部署服务，不需关闭用户进程。
- 用户验收：退出旧版并安装后，以相同终端数量运行至少 5 分钟，覆盖回答预览开关、标签切换、持续输出与正常退出恢复；分别观察 CLI-Manager 和所属 WebView2。任务保持待用户验收，不归档。

## 用户验收与同步
用户确认内存下降并接受本轮优化结束，授权推送主干和修复分支。两张截图合计从 1055.4 MB 到 893.1 MB，减少约 162.3 MB；这是截图观察，不是严格同负载基准。2026-10-15 fetch origin 后 master 与远程均为 4fbd7c03，无新代码需要冲突处理；保留原安装包，不增加代码变更或重新打包。
