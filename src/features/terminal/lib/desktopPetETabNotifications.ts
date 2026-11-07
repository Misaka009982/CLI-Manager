import type { TabNotificationState } from "../state";

// 真实待答在终端标签中保持关注状态，不回写普通 Hook 状态。
export function withDesktopPetEPendingAttention<T>(
  notifications: Record<string, TabNotificationState>,
  pendingActions: ReadonlyMap<string, T>,
): Record<string, TabNotificationState> {
  if (pendingActions.size === 0) return notifications;
  const next = { ...notifications };
  for (const sessionId of pendingActions.keys()) next[sessionId] = "attention";
  return next;
}
