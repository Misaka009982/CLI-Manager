# 验证与限制

## 根因与范围

见 design.md。基线 master 4fbd7c03，工作区干净且与已记录 origin/master 同步；分支 fix/history-index-memory，不获取/推送远程。用户确认新任务与 1.4.3 NSIS。

## 已完成验证

- cargo test --manifest-path src-tauri/Cargo.toml --lib history:: -- --test-threads=4：218 通过，1 项显式内存探针忽略，0 失败。涵盖统计、Grok 元数据、OpenCode、会话合并、目录删除、请求同步幂等/变化/不可访问源。
- 新增快照 Arc::ptr_eq / copy-on-write 隔离、旧 JSON 形状兼容及覆盖写入、失败保留旧缓存与损坏读拒绝三项回归。
- npx tsc --noEmit 通过；独立 npm run check:architecture -- --strict 通过，1322 源码文件，0 超限/违规；git diff --check 通过。

## 独立进程合成内存对比

同一 debug 测试二进制，显式运行 commands::history::index_cache::memory_tests::index_memory_probe；环境 CLI_MANAGER_HISTORY_MEMORY_PROBE_MODE=legacy/shared。24 个文件、120,000 个用量事件、4 份快照；legacy 显式深复制统计并保留完整序列化缓冲，shared 共享统计并流式写入 sink。PowerShell 每 100ms 采样测试子进程并读取 PeakWorkingSet64；两种模式各自新进程，退出码均为 0。

| 模式 | 峰值工作集 MiB | 最大采样私有字节 MiB | 完整 JSON 临时缓冲字节 |
|---|---:|---:|---:|
| legacy | 246.33 | 240.18 | 41,885,877 |
| shared | 45.54 | 37.12 | 0 |

这是隔离的复制/序列化负载比较，不是安装版 GUI 总占用、不是正式版前后同场景实测，不保证整体同比例下降。旧实现由探针显式模拟深复制路径，不是构建旧版本应用。

## 未覆盖与边界

- 未安装/重启用户应用或真实终端，未修改用户历史、536 MiB 缓存、数据库、50,000 行回滚或低内存设置。安装版需要用户验证多个 60 秒同步周期与历史/统计打开关闭。
- 大历史的单份统计数据仍常驻；活跃大文件变化仍需重新解析，OpenCode 原生数据库的解析路径没有重构，WebView/终端缓冲不在本轮。
- 扫描并发最多 4，冷启动吞吐可能低于此前按全部 CPU 并发；取舍是降低峰值。流式 JSON 避免完整字节缓冲，但不是消除解析对象。
- 共享刷新互斥按源码验证，未模拟所有 WSL/SSH 或安装版跨窗口竞态。原有缓存失效与派生索引生命周期保持。
- GitNexus 未提供；使用 codebase-memory、契约、源码和 git diff 复核，索引结果不替代源码证据。

## 构建交付

- 源码提交：`66b57532b9b10da3b96ab51b0b25935c47a67dce`，先提交、干净工作区构建；构建后没有源码额外变化。
- `npm run tauri:build:local -- --bundles nsis` 退出 0，桌面/Web 生产构建通过，复用 local release 缓存（Rust 4m36s）。仅 NSIS，不构建 MSI、不安装、不推送。
- 安装包：`F:\gitRepository\CLI-Manager\src-tauri\target\local\release\bundle\nsis\CLI-Manager_1.4.3_x64-setup.exe`。
- 时间：2026-10-15 15:57:24 +08:00；大小：30,184,002 字节；主程序 FileVersion/ProductVersion 均为 1.4.3。
- SHA256：`D6B2B8B687D6628EA20334D69A6592F37DD9F6453A04CE470B9116C4A0134A2D`。
- 原包保留为同目录 `CLI-Manager_1.4.3_x64-setup.before-history-memory-20261015-154827.exe`。
- 仅有既有前端 chunk/动态导入、bundle identifier、Windows 链接器提示，没有构建失败。
- 实现后索引重建至 44204 节点；detect_changes 返回已跟踪变更但遗漏未跟踪测试/任务且符号为空，实际暂存 diff 与新增文件逐项复核；共 18 个预期文件。验证真实入口调用 read/write 流式 helper、Arc stats 构造、刷新锁与请求预筛选。
- 用户验收建议：退出旧版安装后以相同终端数量运行至少 5 分钟，覆盖多个 60 秒同步周期，并打开/关闭历史和统计；观察主进程与 WebView 分别占用，确认历史/用量无缺失。Trellis 待用户验收，不提前归档。

## 用户验收与同步
用户确认内存下降并接受本轮优化结束，授权推送主干和修复分支。两张截图合计从 1055.4 MB 到 893.1 MB，减少约 162.3 MB；这是截图观察，不是严格同负载基准。2026-10-15 fetch origin 后 master 与远程均为 4fbd7c03，无新代码需要冲突处理；保留原安装包，不增加代码变更或重新打包。
