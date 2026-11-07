import { useEffect, useRef, type RefObject } from "react";

/**
 * Overlays never use `inert` or `showModal()`: either restyles the whole document on open and
 * close, which is what makes phone sheets stutter. Only the topmost overlay handles keys.
 */
const stack: symbol[] = [];
const FOCUSABLE = "button:not(:disabled),a[href],input:not(:disabled),select,textarea,[tabindex='0']";
const editable = (element: Element | null) => element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement;

export function useOverlay(box: RefObject<HTMLElement | null>, active: boolean, close: () => void, options: { focus?: boolean } = {}) {
  const closeRef = useRef(close);
  closeRef.current = close;
  const focus = options.focus ?? true;
  useEffect(() => {
    if (!active) return;
    const token = Symbol("overlay");
    stack.push(token);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Moving focus into the overlay also drops a phone keyboard that would cover it.
    if (focus) (box.current?.querySelector<HTMLElement>("[data-autofocus]") ?? box.current)?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (stack.at(-1) !== token || event.defaultPrevented) return;
      // IME candidates and held keys never dismiss an overlay.
      if (event.isComposing || event.keyCode === 229 || event.repeat) return;
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab" || !box.current) return;
      const focusable = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null);
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === box.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (current === last || current === box.current)) { event.preventDefault(); first.focus(); }
      else if (!box.current.contains(current)) { event.preventDefault(); first.focus(); }
    };
    // Children see Escape first and may consume it with preventDefault.
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      stack.splice(stack.indexOf(token), 1);
      // Only take focus back if it is still ours to give; never reopen a phone keyboard by refocusing a field.
      const current = document.activeElement;
      const owned = !current || current === document.body || Boolean(box.current?.contains(current));
      if (!owned || !previous?.isConnected) return;
      if (editable(previous) && matchMedia("(pointer: coarse)").matches) return;
      previous.focus({ preventScroll: true });
    };
  }, [active, box, focus]);
}

/** Edge gestures stay out of the way while any overlay is open. */
export const overlayOpen = () => stack.length > 0;

/** Exit animations last this long; reduced motion closes at once. */
export function exitDelay(ms: number) {
  return matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ms;
}
