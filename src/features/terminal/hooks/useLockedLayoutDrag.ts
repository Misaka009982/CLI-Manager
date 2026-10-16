import { useEffect, useRef, type PointerEvent } from "react";
import { DND_ACTIVATION_CONSTRAINT } from "../../workspace/api/dragInteraction";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { guardTerminalLayoutChange } from "../api/terminalLayoutLock";
import { observeLockedLayoutDrag } from "../lib/lockedLayoutDrag";

export function useLockedLayoutDrag() {
  const locked = useSettingsStore((s) => s.terminalLayoutLocked);
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), [locked]);

  // 关闭按钮/编辑框不属于拖动意图；右键和普通点击继续走原有行为。
  const onPointerDownCapture = (event: PointerEvent<HTMLElement>) => {
    cleanupRef.current?.();
    if (!locked || event.button !== 0 || !event.isPrimary) return;
    if (event.target instanceof Element && event.target.closest("button,input,textarea,[contenteditable=true]")) return;
    cleanupRef.current = observeLockedLayoutDrag(
      window, event, DND_ACTIVATION_CONSTRAINT.distance, guardTerminalLayoutChange,
    );
  };
  return { locked, onPointerDownCapture };
}

// 清除布局预览与悬停切换计时器，覆盖拖动尚未结束时从其他入口锁定。
export function useClearDragOnLayoutLock(clearDragState: () => void) {
  useEffect(() => useSettingsStore.subscribe((state, previous) => {
    if (state.terminalLayoutLocked && !previous.terminalLayoutLocked) clearDragState();
  }), [clearDragState]);
}
