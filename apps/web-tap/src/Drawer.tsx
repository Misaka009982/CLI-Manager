import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import { overlayHost } from "./viewport";
import { overlayOpen, useOverlay } from "./overlay";

type Side = "left" | "right";
type Control = { follow: (offset: number) => void; settle: (open: boolean) => void; width: () => number };
const controls = new Map<Side, Control>();
const EDGE = 24;

/** Translate needed to show `offset` pixels of a closed panel, or hide them from an open one. */
const shift = (side: Side, offset: number) => `translateX(${side === "left" ? offset : -offset}px)`;
/** A horizontal scroller under the finger keeps its own swipe (code blocks, wide tables, diffs). */
const ownsSwipe = (target: EventTarget | null, closing: Side) => {
  for (let node = target instanceof Element ? target : null; node; node = node.parentElement) {
    if (node instanceof HTMLElement && node.dataset.ownSwipe !== undefined) return true;
    if (node.scrollWidth > node.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowX)) {
      // Closing a left panel swipes left, which scrolls content right; only block if that is still possible.
      const room = closing === "left" ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1 : node.scrollLeft > 0;
      if (room) return true;
    }
  }
  return false;
};

/**
 * Phone side panel. It stays mounted (hidden with visibility, never `inert`) so a finger can
 * drag it from the screen edge and back without waiting for React to render it first.
 */
export function Drawer({ side, open, label, onOpen, onClose, children, className = "" }: {
  side: Side; open: boolean; label: string; onOpen: () => void; onClose: () => void; children: ReactNode; className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onOpen, onClose });
  handlers.current = { onOpen, onClose };
  useOverlay(panel, open, onClose);
  useEffect(() => {
    const element = panel.current;
    const shade = scrim.current;
    if (!element || !shade) return;
    const width = () => element.getBoundingClientRect().width || 300;
    let frame = 0;
    // `offset` is how far the panel is out: 0 closed, width() fully open. Writes happen once per frame.
    const follow = (offset: number) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const visible = Math.max(0, Math.min(width(), offset));
        element.style.transition = shade.style.transition = "none";
        element.style.visibility = shade.style.visibility = "visible";
        element.style.transform = shift(side, visible - width());
        shade.style.opacity = String(visible / width());
      });
    };
    const settle = (next: boolean) => {
      cancelAnimationFrame(frame);
      // Commit the class first so clearing the inline position animates from the finger to the target.
      flushSync(() => { if (next) handlers.current.onOpen(); else handlers.current.onClose(); });
      element.style.transition = shade.style.transition = "";
      element.style.transform = element.style.visibility = "";
      shade.style.opacity = shade.style.visibility = "";
    };
    controls.set(side, { follow, settle, width });
    let start: { x: number; y: number; at: number; engaged: boolean } | undefined;
    let offset = 0;
    const begin = (event: TouchEvent) => {
      if (event.touches.length !== 1 || ownsSwipe(event.target, side)) return;
      start = { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY, at: performance.now(), engaged: false };
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      const dx = (event.touches[0]!.clientX - start.x) * (side === "left" ? -1 : 1);
      const dy = event.touches[0]!.clientY - start.y;
      if (!start.engaged) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { start = undefined; return; }
        if (dx < 10 || dx < Math.abs(dy) * 1.2) return;
        start.engaged = true;
      }
      event.preventDefault();
      offset = width() - Math.max(0, dx);
      follow(offset);
    };
    const end = () => {
      if (!start?.engaged) { start = undefined; return; }
      const moved = width() - offset;
      const fast = moved / Math.max(1, performance.now() - start.at) > 0.4;
      settle(!(moved > width() / 3 || (fast && moved > 24)));
      start = undefined;
    };
    element.addEventListener("touchstart", begin, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", end);
    element.addEventListener("touchcancel", end);
    return () => {
      cancelAnimationFrame(frame);
      if (controls.get(side)?.follow === follow) controls.delete(side);
      element.removeEventListener("touchstart", begin);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end);
      element.removeEventListener("touchcancel", end);
    };
  }, [side]);
  return createPortal(<>
    <div ref={scrim} className={`tap-scrim${open ? " is-open" : ""}`} onClick={onClose} aria-hidden />
    <div ref={panel} className={`tap-drawer is-${side}${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
      role="dialog" aria-modal={open || undefined} aria-label={label} aria-hidden={!open || undefined} tabIndex={-1}>
      {children}
    </div>
  </>, overlayHost());
}

/** Drag a closed phone panel in from the screen edge; it follows the finger. */
export function useEdgeSwipe(area: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const element = area.current;
    if (!element || !enabled) return;
    let start: { side: Side; x: number; y: number; at: number; engaged: boolean } | undefined;
    let offset = 0;
    const begin = (event: TouchEvent) => {
      if (event.touches.length !== 1 || overlayOpen()) return;
      const x = event.touches[0]!.clientX;
      const side: Side | undefined = x <= EDGE ? "left" : x >= innerWidth - EDGE ? "right" : undefined;
      if (!side || !controls.has(side) || overlayOpen()) return;
      start = { side, x, y: event.touches[0]!.clientY, at: performance.now(), engaged: false };
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      const control = controls.get(start.side);
      const dx = (event.touches[0]!.clientX - start.x) * (start.side === "left" ? 1 : -1);
      const dy = event.touches[0]!.clientY - start.y;
      if (!control) { start = undefined; return; }
      if (!start.engaged) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { start = undefined; return; }
        if (dx < 10 || dx < Math.abs(dy) * 1.2) return;
        start.engaged = true;
      }
      event.preventDefault();
      offset = Math.max(0, dx);
      control.follow(offset);
    };
    const end = () => {
      const control = start && controls.get(start.side);
      if (start?.engaged && control) {
        const fast = offset / Math.max(1, performance.now() - start.at) > 0.4;
        control.settle(offset > control.width() / 3 || (fast && offset > 40));
      }
      start = undefined;
      offset = 0;
    };
    element.addEventListener("touchstart", begin, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", end);
    element.addEventListener("touchcancel", end);
    return () => {
      element.removeEventListener("touchstart", begin);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end);
      element.removeEventListener("touchcancel", end);
    };
  }, [area, enabled]);
}
