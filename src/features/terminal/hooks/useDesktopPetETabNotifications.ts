import { useMemo } from "react";
import type { TabNotificationState, TerminalStore } from "../types/terminalStoreTypes";
import { withDesktopPetEPendingAttention } from "../lib/desktopPetETabNotifications";

// 两种标签显示共用真实待答覆盖，不修改普通 Hook 或 shell 状态。
export function useDesktopPetETabNotifications(
  terminalTabNotifications: TerminalStore["tabNotifications"],
  tabStatuses: TerminalStore["tabStatuses"],
  pendingActions: ReadonlyMap<string, unknown>,
) {
  const tabNotifications = useMemo(() => withDesktopPetEPendingAttention(
    terminalTabNotifications, pendingActions,
  ), [pendingActions, terminalTabNotifications]);
  const hookNotifications = useMemo<Record<string, TabNotificationState>>(() => {
    const next: Record<string, TabNotificationState> = {};
    for (const [sessionId, status] of Object.entries(tabStatuses)) {
      next[sessionId] = status.hook ?? "none";
    }
    return withDesktopPetEPendingAttention(next, pendingActions);
  }, [pendingActions, tabStatuses]);
  return { tabNotifications, hookNotifications };
}
