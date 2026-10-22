// Pi 会话复位的独立规则；普通 CLI 的 SessionStart 仍只绑定身份。
interface PiSessionHook {
  source?: string | null;
  event: string;
  tabId: string;
  sessionId?: string | null;
  environmentType?: string | null;
  timestamp?: string | null;
}

export function isPiSessionStart(payload: PiSessionHook): boolean {
  return payload.source === "pi" && payload.event === "SessionStart"
    && payload.environmentType !== "ssh"
    && typeof payload.tabId === "string" && payload.tabId.trim().length > 0
    && typeof payload.sessionId === "string" && payload.sessionId.trim().length > 0;
}

// 复位的乱序守卫必须早于会话身份绑定；不能先回绑旧 ID 再仅拒绝状态更新。
export function isStalePiSessionStart(payload: PiSessionHook, previousAt?: string | null): boolean {
  if (!isPiSessionStart(payload)) return false;
  const incoming = Date.parse(payload.timestamp ?? "");
  const previous = Date.parse(previousAt ?? "");
  return Number.isFinite(incoming) && Number.isFinite(previous) && incoming < previous;
}

interface PiSessionStatusInput {
  frontendStatus: string;
  frontendDetails?: { updatedAt?: string | null };
  daemonTask?: {
    taskStatus?: string | null;
    taskUpdatedAtMs?: number | null;
    createdAtMs: number;
  };
}

const TASK_STATUSES = new Set(["none", "running", "attention", "done", "failed"]);

// 仅补齐 Pi 的明确空闲投影；其他状态仍交给既有状态解析器，不按 TUI 输出猜运行。
export function resolvePiSessionIdle(
  source: string | null | undefined,
  input: PiSessionStatusInput,
): { status: "none"; updatedAt: number } | null {
  if (source !== "pi") return null;
  const parsed = Date.parse(input.frontendDetails?.updatedAt ?? "");
  const frontendAt = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const task = input.daemonTask;
  const daemonAt = task?.taskUpdatedAtMs ?? task?.createdAtMs ?? 0;
  if (task?.taskStatus && TASK_STATUSES.has(task.taskStatus)
    && Number.isFinite(daemonAt) && daemonAt > 0 && daemonAt >= frontendAt) {
    return task.taskStatus === "none" ? { status: "none", updatedAt: daemonAt } : null;
  }
  return input.frontendStatus === "none" && frontendAt > 0
    ? { status: "none", updatedAt: frontendAt }
    : null;
}
