## 现象

在 CLI-Manager 内置终端里 SSH 运行 Grok 等全屏 TUI 时，拖选或 `/copy` 只提示 `copy sent` 并写入远端 `~/.grok/last-copy.txt`，Windows 本机剪贴板是空的。同一台电脑的 WSL + xclip 正常。Shift 拖选松手后选区消失；`Ctrl+Shift+C` 打开 Tauri DevTools。

## 根因

宿主 xterm 不消费 OSC 52。远端即使有 GUI，CLI-Manager 的 SSH 会话也没有接到本机剪贴板。鼠标事件默认交给 TUI，松手重绘清掉选区。`Ctrl+Shift+C` 是 Chromium 检查元素。

## 修复

- 拦截 OSC 52 与 tmux DCS，实时帧写入 Tauri 本机剪贴板；replay/reset 只剥离不写。
- 查询 `52;Pc;?` 回应当前剪贴板。
- 设置中可关闭 OSC 52 写剪贴板。
- `Ctrl+Shift+C` 复制选区并阻止检查元素。
- 普通拖动选择终端文本，Alt 才把鼠标交给 TUI。

## 测试

- `node --test scripts/terminalOsc52.test.mjs scripts/terminalOsc.test.mjs scripts/terminalMouseInteraction.test.mjs`
- `DISPLAY=:11 bash scripts/terminalOsc52.clipboard.e2e.sh`（本机 X11）
- `npx tsc --noEmit`
- `git diff --check`

## 人工验证范围

未在 Windows 上打开完整 Tauri 窗口点 Grok。请在安装包或 `npm run tauri dev` 下验证：SSH Grok 复制、`Win+V`、查询不再报不支持 OSC 52、开关关闭后不写剪贴板、普通拖选可松手再复制、`Ctrl+Shift+C` 不打开 DevTools。

Refs #211
