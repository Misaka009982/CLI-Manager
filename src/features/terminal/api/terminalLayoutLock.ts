import { toast } from "sonner";
import { translateCurrent } from "../../../shared/i18n";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";

const LOCK_TOAST_ID = "terminal-layout-locked";

export function isTerminalLayoutLocked(): boolean {
  return useSettingsStore.getState().terminalLayoutLocked === true;
}

// 通过既有 store 更新偏好并落盘；解锁也清除过期的阻止提示。
export function setTerminalLayoutLocked(locked: boolean): void {
  void useSettingsStore.getState().update("terminalLayoutLocked", locked);
  if (!locked) toast.dismiss(LOCK_TOAST_ID);
}

// 所有用户布局入口读取最新状态；固定 toast id 避免连续操作堆叠提示。
export function guardTerminalLayoutChange(): boolean {
  if (!isTerminalLayoutLocked()) return false;
  toast.info(translateCurrent("terminal.layoutLock.blocked"), {
    id: LOCK_TOAST_ID,
    action: {
      label: translateCurrent("terminal.layoutLock.unlock"),
      onClick: () => setTerminalLayoutLocked(false),
    },
  });
  return true;
}
