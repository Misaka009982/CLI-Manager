import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { overlayHost } from "./viewport";
import { exitDelay, useOverlay } from "./overlay";
import type { Translate } from "./i18n";

const SheetClose = createContext<() => void>(() => {});
/** Lets sheet content close with the same exit animation as the close button. */
export const useSheetClose = () => useContext(SheetClose);

/**
 * Centered dialog on desktop, bottom sheet on phones. The rest of the page stays styled as is;
 * a backdrop sibling takes the clicks instead of `inert`.
 */
export function Sheet({ title, onClose, children, t, wide = false, className = "" }: {
  title: string; onClose: () => void; children: ReactNode; t: Translate; wide?: boolean; className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const label = useId();
  const [closing, setClosing] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const close = useCallback(() => {
    if (timer.current) return;
    setClosing(true);
    timer.current = setTimeout(() => closeRef.current(), exitDelay(150));
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useOverlay(box, true, close);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let start: { y: number; at: number; active: boolean } | undefined;
    let distance = 0;
    const begin = (event: TouchEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest("[data-drag-handle]") || event.touches.length !== 1) return;
      start = { y: event.touches[0]!.clientY, at: performance.now(), active: false };
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      const delta = event.touches[0]!.clientY - start.y;
      if (delta < 8 && !start.active) return;
      start.active = true;
      distance = Math.max(0, delta);
      event.preventDefault();
      element.style.transition = "none";
      element.style.transform = `translateY(${distance}px)`;
    };
    const finish = () => {
      if (!start) return;
      const fast = distance / Math.max(1, performance.now() - start.at) > 0.6;
      element.style.transition = "";
      if (start.active && (distance > 90 || (fast && distance > 30))) close();
      else element.style.transform = "";
      start = undefined;
      distance = 0;
    };
    element.addEventListener("touchstart", begin, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", finish);
    element.addEventListener("touchcancel", finish);
    return () => {
      element.removeEventListener("touchstart", begin);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", finish);
      element.removeEventListener("touchcancel", finish);
    };
  }, [close]);
  const state = closing ? " is-closing" : "";
  return createPortal(<>
    <div className={`tap-backdrop${state}`} onClick={close} />
    <div ref={box} className={`tap-sheet${wide ? " is-wide" : ""}${state}${className ? ` ${className}` : ""}`}
      role="dialog" aria-modal="true" aria-labelledby={label} tabIndex={-1}>
      <header className="tap-sheet-head" data-drag-handle>
        <span className="tap-grabber" aria-hidden />
        <h2 id={label}>{title}</h2>
        <button type="button" className="tap-icon" aria-label={t("close")} onClick={close}><X size={18} /></button>
      </header>
      <div className="tap-sheet-body"><SheetClose.Provider value={close}>{children}</SheetClose.Provider></div>
    </div>
  </>, overlayHost());
}
