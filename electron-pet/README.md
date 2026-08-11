# Electron Desktop Pet Companion

`electron-pet/` 是 CLI-Manager Windows 安装包内置的可选桌宠渲染进程。它只消费主程序发送的桌宠状态，不拥有终端、Hook、数据库、Pi broker、远程托管或设置写入权限。

## 运行边界

- CLI-Manager 主 Tauri 进程是 config、snapshot、generation 和所有动作结果的唯一权威。
- Windows 设置可在 `tauri` 与 `electron` 之间切换；两种 runtime 分别保存宠物、尺寸、位置与交互档案，主程序只向各窗口发送自身档案并按事件来源写回。选择 `electron` 后立即隐藏 Tauri Pet/Bubble，Electron 完成 `hello -> sync -> ready` 后成为 active。若 Electron 启动或运行失败，Tauri Pet/Bubble 仍保持隐藏，只有切回 `tauri` 才重新显示。
- 启动失败、协议不兼容、stdin 写入失败、子进程退出、窗口加载失败、renderer 崩溃或无响应都会停止 Electron companion 并保持桌宠隐藏，直到用户切回 Tauri。
- macOS/Linux 不准备、不打包也不启动 Electron runtime。

## 目录

```text
electron-pet/
  protocol.cjs       JSON Lines 编解码与协议常量
  app/
    package.json     Electron 应用入口
    main.cjs         窗口、几何、协议、父进程监控与动作白名单
    preload.cjs      contextBridge 最小 API
    renderer.cjs     Pet、菜单、Bubble、决策与事故交互
    geometry.cjs     工作区、锚点、尺寸和 shape 纯函数
    styles.css       render/hit 同构布局与视觉
```

`renderWin` 只绘制宠物并始终忽略鼠标；`hitWin` 的宠物区域透明，直接绘制需要焦点或光标的状态按钮、菜单和 Bubble，并用 `setShape()` 将输入限制到实际交互矩形。两窗共享 bounds 与布局，展开时保留宠物屏幕锚点。

## Companion v1

所有 stdin/stdout 协议行使用前缀 `CLI_MANAGER_DESKTOP_PET `，JSON 单行不超过 1 MiB。每条消息都包含 `protocolVersion: 1` 和 Rust 启动时生成的随机 process token。

Host 到 child：

- `sync`：完整 config、snapshot、只读 pet 描述、单调 `deliveryRevision` 和三元 generation。
- `actionResult`：Pi 决策 broker 的成功/失败回执。
- `shutdown`：正常退出请求；超时后由 Rust 强制回收。

Child 到 host：

- `hello` / `ready`：两阶段启动握手。
- `action`：经过 preload、Electron main 与 Rust 三层白名单校验的用户动作。
- `error`：不可恢复的 runtime 错误；主程序保持桌宠隐藏，只有用户切回 `tauri` 后才恢复 Tauri 窗口。

## Windows Bundle

`scripts/prepare-electron-pet-runtime.mjs` 固定使用 Electron `41.10.2`：

1. 从 Electron 官方 GitHub Release 读取同版本 `SHASUMS256.txt`。
2. 下载并校验当前 Windows 架构的 zip；缓存位于 `src-tauri/target/electron-runtime-cache`。
3. 将 runtime、本目录源码和确定性的 `runtime-manifest.json` 写入 gitignored 的 `src-tauri/resources/electron-pet`。
4. `src-tauri/tauri.windows.conf.json` 只在 Windows bundle 中加入该资源。

脚本由 stable workflow 提前执行，并由 Tauri `beforeBundleCommand` 幂等兜底。根 `package.json` 与 `package-lock.json` 不增加 Electron 依赖。

## 安全与许可

- `contextIsolation=true`、`nodeIntegration=false`、sandbox 和本地 CSP 默认开启。
- Renderer 不获得 Node、任意 IPC、shell、网络 broker 或文件系统 API。
- 自定义宠物路径由 Tauri 解析；Electron 只接受根目录内的状态素材，路径穿越会被拒绝。
- Agent 文本使用 HTML 转义后渲染，协议正文不写新增日志。
- 双窗口概念参考了 clawd-on-desk 的公开架构说明，但本实现未复制其 Agent、Hook、权限 broker、设置、更新器或窗口源码。CLI-Manager 代码继续按仓库的 `AGPL-3.0-or-later` 许可发布；官方 Electron runtime 随包保留其自带许可文件。
