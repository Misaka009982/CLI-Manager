import { useEffect, useRef } from "react";
import type { PointerEvent } from "react";
import { SIDEBAR_MIN } from "./fileSidebarLayout";

type Props = { side: "projects" | "files"; width: number; max: number; label: string;
  onResize: (side: "projects" | "files", width: number, persist: boolean) => void };

export function SidebarResizeHandle({ side, width, max, label, onResize }: Props) {
  const drag = useRef<{ x: number; width: number; next: number } | null>(null);
  const frame = useRef<number | null>(null);
  const clamp = (value: number) => Math.round(Math.max(SIDEBAR_MIN, Math.min(max, value)));
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const next = clamp(drag.current.next);
    drag.current = null;
    onResize(side, next, true);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div className={`sidebar-resize-handle ${side}-resize`} role="separator" tabIndex={0}
    aria-label={label} aria-orientation="vertical" aria-valuemin={SIDEBAR_MIN}
    aria-valuemax={Math.floor(max)} aria-valuenow={Math.round(width)}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, width, next: width };
    }}
    onPointerMove={(event) => {
      if (!drag.current) return;
      drag.current.next = clamp(drag.current.width + (event.clientX - drag.current.x) * (side === "projects" ? 1 : -1));
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (drag.current) onResize(side, drag.current.next, false);
      });
    }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const delta = (event.key === "ArrowRight" ? 16 : -16) * (side === "projects" ? 1 : -1);
      onResize(side, clamp(event.key === "Home" ? SIDEBAR_MIN : event.key === "End" ? max : width + delta), true);
    }} />;
}
