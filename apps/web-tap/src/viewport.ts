import { useLayoutEffect, type RefObject } from "react";

type Viewport = { top: number; height: number; keyboard: number; open: boolean };
const roots = new Set<HTMLElement>();
let overlay: HTMLElement | undefined;
let listening = false;
let animation = 0;
let dismissUntil = 0;
let dismissTimer: ReturnType<typeof setTimeout> | undefined;
let inset = 0;

/** Keep layout height stable; compensate only for occlusion not already panned by the browser. */
export function calculateViewport(layoutHeight: number, visualHeight: number, visualTop: number, scale: number): Viewport {
  const top = Math.max(0, Math.round(visualTop));
  const height = Math.max(0, Math.round(visualHeight));
  const zoomed = scale > 1.01;
  return { top, height, keyboard: zoomed ? 0 : Math.max(0, layoutHeight - height - top),
    open: !zoomed && layoutHeight - height > 80 };
}

/** Query the current viewport without changing document-wide layout variables. */
function currentViewport(): Viewport {
  const visual = window.visualViewport;
  return calculateViewport(window.innerHeight, visual?.height ?? window.innerHeight,
    visual?.offsetTop ?? 0, visual?.scale ?? 1);
}

/** Write dynamic geometry only to the owning root and portal layer. */
function paintViewport() {
  animation = 0;
  const view = currentViewport();
  if (!view.open) dismissUntil = 0;
  const keyboardOpen = view.open && Date.now() >= dismissUntil;
  const lift = keyboardOpen ? view.keyboard + Math.max(0, inset - 6) : 0;
  for (const root of roots) {
    root.style.top = lift ? `${-lift}px` : "";
    root.style.setProperty("--vv-height", `${view.height}px`);
  }
  document.documentElement.dataset.keyboard = keyboardOpen ? "open" : "closed";
  if (overlay) {
    overlay.style.setProperty("--vv-top", `${view.top}px`);
    overlay.style.setProperty("--vv-height", `${view.height}px`);
    overlay.style.setProperty("--keyboard", `${view.keyboard}px`);
  }
}

/** Coalesce viewport scroll/resize bursts into one visual update. */
function scheduleViewport() {
  if (!animation) animation = requestAnimationFrame(paintViewport);
}

/** Exclude controls which cannot summon an on-screen keyboard. */
function acceptsText(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement)
    return !target.disabled && !target.readOnly && target.inputMode !== "none"
      && !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(target.type);
  if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly && target.inputMode !== "none";
  return target instanceof HTMLElement && target.isContentEditable;
}

/** Read the environment inset once per orientation, not during terminal output. */
function measureInset() {
  const probe = document.createElement("span");
  probe.style.cssText = "position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom)";
  document.body.appendChild(probe);
  inset = Number.parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  probe.remove();
}

/** The app has one document lifecycle. Individual session components add no viewport listeners. */
export function startViewport() {
  if (listening) return;
  listening = true;
  measureInset();
  window.visualViewport?.addEventListener("resize", scheduleViewport);
  window.visualViewport?.addEventListener("scroll", scheduleViewport);
  window.addEventListener("resize", () => { measureInset(); scheduleViewport(); });
  document.addEventListener("focusin", (event) => {
    if (!acceptsText(event.target)) return;
    dismissUntil = 0; clearTimeout(dismissTimer); scheduleViewport();
  });
  document.addEventListener("focusout", (event) => {
    if (!acceptsText(event.target) || acceptsText(event.relatedTarget) || !currentViewport().open) return;
    // Restore immediately on blur; delayed mobile viewport events must not leave a blank strip.
    dismissUntil = Date.now() + 1200;
    clearTimeout(dismissTimer);
    dismissTimer = setTimeout(scheduleViewport, 1200);
    paintViewport();
  });
  paintViewport();
}

/** Track only the application shell; chat and terminal containers retain their dimensions. */
export function useViewportBox(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    roots.add(root); paintViewport();
    return () => { roots.delete(root); root.style.top = ""; };
  }, [ref]);
}

/** Portals escape inert application content while following the visual viewport. */
export function overlayHost(): HTMLElement {
  if (!overlay?.isConnected) {
    overlay = document.createElement("div"); overlay.id = "overlays";
    document.body.appendChild(overlay); paintViewport();
  }
  return overlay;
}
