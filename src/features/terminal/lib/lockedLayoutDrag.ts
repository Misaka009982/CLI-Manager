interface DragOrigin {
  clientX: number;
  clientY: number;
  pointerId: number;
}

// 仅观察当前手势，不捕获指针、不阻止点击；越过阈值后立即移除观察器。
export function observeLockedLayoutDrag(
  target: Window,
  origin: DragOrigin,
  distance: number,
  onAttempt: () => void,
): () => void {
  const cleanup = () => {
    target.removeEventListener("pointermove", onMove);
    target.removeEventListener("pointerup", onEnd);
    target.removeEventListener("pointercancel", onEnd);
    target.removeEventListener("blur", cleanup);
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== origin.pointerId) return;
    if (event.buttons === 0) { cleanup(); return; }
    if (Math.hypot(event.clientX - origin.clientX, event.clientY - origin.clientY) <= distance) return;
    cleanup();
    onAttempt();
  };
  const onEnd = (event: PointerEvent) => {
    if (event.pointerId === origin.pointerId) cleanup();
  };
  target.addEventListener("pointermove", onMove);
  target.addEventListener("pointerup", onEnd);
  target.addEventListener("pointercancel", onEnd);
  target.addEventListener("blur", cleanup);
  return cleanup;
}
