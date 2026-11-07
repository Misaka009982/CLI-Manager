type WriteTask = { token: symbol; isVisible: () => boolean; start: () => void };

/** One scheduler per Web document, with bounded visible priority and a background fallback. */
export function createTerminalWrites() {
  const pending = new Map<symbol, WriteTask>();
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watching = false;
  let visibleStreak = 0;
  const clear = () => { if (frame !== undefined) cancelAnimationFrame(frame); clearTimeout(timer); frame = undefined; timer = undefined; };
  const schedule = () => {
    clear();
    if (!pending.size) {
      if (watching) document.removeEventListener("visibilitychange", schedule);
      watching = false; return;
    }
    if (!watching) { document.addEventListener("visibilitychange", schedule); watching = true; }
    if (document.visibilityState !== "hidden") frame = requestAnimationFrame(flush);
    timer = setTimeout(flush, document.visibilityState === "hidden" ? 100 : 50);
  };
  function flush() {
    clear();
    const tasks = [...pending.values()];
    const isVisible = (task: WriteTask) => document.visibilityState !== "hidden" && task.isVisible();
    const visible = tasks.find(isVisible);
    const hidden = tasks.find((task) => !isVisible(task));
    const next = visibleStreak >= 3 && hidden ? hidden : visible ?? hidden;
    if (!next) { schedule(); return; }
    pending.delete(next.token);
    visibleStreak = isVisible(next) ? visibleStreak + 1 : 0;
    // The caller owns write completion/errors; other sessions must still receive their next turn.
    try { next.start(); } finally { schedule(); }
  }
  return {
    request: (task: WriteTask) => { pending.set(task.token, task); schedule(); },
    cancel: (token: symbol) => { pending.delete(token); schedule(); },
  };
}

export const terminalWrites = createTerminalWrites();
