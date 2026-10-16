/// <reference types="vite/client" />
import type { Terminal } from "@xterm/xterm";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Unicode11Addon } from "@xterm/addon-unicode11";

export type TerminalUnicodeMode = "graphemes" | "unicode11";

// 两端必须以相同值构建；运行中切换会让已有 buffer 与新输出使用不同占格规则。
export const TERMINAL_UNICODE_MODE: TerminalUnicodeMode =
  import.meta.env?.VITE_TERMINAL_UNICODE_MODE === "unicode11" ? "unicode11" : "graphemes";

// 在 open/write/replay 前调用一次，并在构造时允许 proposed API。生命周期由 xterm 管理。
// 不静默回退：镜像与主终端必须采用同一算法，字体像素溢出也不能靠更改占格掩盖。
export function installTerminalUnicode(
  terminal: Terminal,
  mode: TerminalUnicodeMode = TERMINAL_UNICODE_MODE,
): void {
  if (mode === "unicode11") {
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    return;
  }
  terminal.loadAddon(new UnicodeGraphemesAddon());
}
