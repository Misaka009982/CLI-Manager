import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { useOverlay } from "./overlay";

/**
 * Anchored dropdown rendered inside a `.tap-menu-anchor`. A transparent scrim takes the outside
 * tap, so a dismissing tap never also presses whatever sits under it.
 */
export function Menu({ open, onClose, label, placement = "down-end", className = "", role = "menu", children }: {
  open: boolean; onClose: () => void; label: string; placement?: "down-end" | "down-start" | "up-start" | "up-end";
  className?: string; role?: "menu" | "alertdialog"; children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useOverlay(box, open, onClose, { focus: !matchMedia("(pointer: coarse)").matches });
  if (!open) return null;
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...(box.current?.querySelectorAll<HTMLElement>("[role^='menuitem']:not(:disabled)") ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index <= 0 ? items.length : index) - 1;
    items[next]!.focus();
  };
  return <>
    <div className="tap-menu-scrim" onClick={onClose} aria-hidden />
    <div ref={box} role={role} aria-label={label} tabIndex={-1} onKeyDown={move}
      className={`tap-menu is-${placement}${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  </>;
}
