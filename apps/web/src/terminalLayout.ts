import type { TerminalDisplay } from "./terminalDisplay";

// Public xterm dimensions only: measuring at the selected font also accounts for
// browser/device pixel rounding. The viewport is supplied after mobile chrome.
type DisplayTerminal = {
  cols: number;
  rows: number;
  options: { fontSize?: number };
  resize: (cols: number, rows: number) => void;
};

export function applyTerminalDisplay(
  terminal: DisplayTerminal,
  screen: { offsetWidth: number; offsetHeight: number },
  availableWidth: number,
  availableHeight: number,
  prefs: TerminalDisplay,
  webControlled: boolean,
) {
  const widthLimit = Math.max(1, availableWidth - 16);
  terminal.options.fontSize = webControlled || prefs.mode === "manual" ? prefs.fontSize : 14;
  if (!screen.offsetWidth || !screen.offsetHeight) return null;
  if (webControlled) {
    const cellWidth = screen.offsetWidth / terminal.cols;
    const cellHeight = screen.offsetHeight / terminal.rows;
    const cols = Math.max(2, Math.min(500, Math.floor(widthLimit / cellWidth)));
    const rows = Math.max(1, Math.min(300, Math.floor(availableHeight / cellHeight)));
    if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
  } else if (prefs.mode !== "manual") {
    // Fit the shared grid without enlarging short desktop grids into huge text.
    const ratio = Math.min(1, widthLimit / screen.offsetWidth);
    terminal.options.fontSize = Math.max(1, Math.min(96, Math.floor(14 * ratio * 10) / 10));
    for (let attempt = 0; attempt < 32 && terminal.options.fontSize! > 1 &&
      screen.offsetWidth > widthLimit; attempt++) {
      terminal.options.fontSize = Math.max(1, terminal.options.fontSize! - 0.1);
    }
  }
  return {
    cols: terminal.cols,
    rows: terminal.rows,
    fontSize: terminal.options.fontSize!,
    width: screen.offsetWidth + 16,
    height: screen.offsetHeight,
  };
}
