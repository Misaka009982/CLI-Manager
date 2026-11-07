export interface TerminalImeCompositionKeyEvent {
  type: string;
  key: string;
}

// 豆包输入法「润色」期间会补发一个非 229 的 keydown，DOM 标准键值为 "Unidentified"。
// xterm 的 CompositionHelper 在组词中只放行 keyCode 20/229/16/17/18，其余 keydown 会立刻
// 以 _finalizeComposition(false) 把 helper textarea 里的原始拼音同步写入 PTY；随后
// compositionend 又以 _finalizeComposition(true) 写入润色结果，导致两份文本都留在终端。
// 在 xterm 自定义键盘钩子里返回 false 可在进入 CompositionHelper 前中止这次 keydown；
// compositionend 仍是唯一提交路径，所以不会把输入法卡在组词状态。
// 只拦截组词期间的 "Unidentified"，Ctrl+C、Esc、Enter 等按键保持原样。
export const shouldSwallowImeCompositionKeydown = (
  event: TerminalImeCompositionKeyEvent,
  isComposing: boolean,
): boolean => isComposing && event.type === "keydown" && event.key === "Unidentified";
