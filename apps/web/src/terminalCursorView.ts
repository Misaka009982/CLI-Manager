// Reveal just the cursor cell, preserving the user's viewport when it is visible.
export function revealTerminalCell(scroll: number, viewport: number, start: number, size: number): number {
  if (start < scroll) return Math.max(0, start);
  if (start + size > scroll + viewport) return Math.max(0, start + size - viewport);
  return scroll;
}

// Navigation/commands may open full-screen pickers and move a hidden paint cursor.
// Only text edits warrant keeping the input caret in view.
export function createTerminalInputFollow() {
  let until = -Infinity;
  return {
    input(data: string, now: number) {
      const text = data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")
        ? data.slice(6, -6) : data;
      const editing = text === "\x7f" || text === "\b" ||
        (text.length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(text));
      until = editing ? now + 1500 : -Infinity;
    },
    canReveal(now: number, cursorVisible: boolean) {
      return cursorVisible && now <= until;
    },
    cancel() { until = -Infinity; },
  };
}
