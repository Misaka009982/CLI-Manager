# 设计：OSC 52 宿主剪贴板

## 数据流

```
PTY live frame
  -> useTerminalDisplay.normalize(..., applyOsc52: true)
  -> unwrap tmux DCS
  -> parse OSC 52
  -> strip from visible output
  -> onOsc52Write -> copyTextToClipboard   (if setting on)
  -> onOsc52Query -> readClipboard + PTY write formatOsc52Reply
Replay/reset uses applyOsc52: false.
```

## 决策

- 解析放在已有纯函数层 `terminalOscParse.ts`，副作用留在 hook / XTermTerminal。
- 颜色查询契约改为：OSC 52 由前端剪贴板宿主消费；OSC 10/11 仍禁止 React 写 PTY。
- 鼠标默认 `mouseEventsRequireAlt: true`，恢复 V1.3.2 与 #211 的宿主选区优先。
- DevTools 检查元素在 `App` 捕获 `Ctrl+Shift+C` 并 `preventDefault`；终端处理器负责复制。
