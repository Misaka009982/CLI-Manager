import { useEffect, useRef } from "react";
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, CornerDownLeft } from "lucide-react";
import type { Key, Modifiers } from "./input";
import type { Translate, TextKey } from "./i18n";

const rows: (Key | "ctrl" | "alt")[][] = [
  ["esc", "backtab", "interrupt", "slash", "up", "pageup", "pagedown"],
  ["tab", "ctrl", "alt", "left", "down", "right", "enter"],
];
const labels: Record<Key | "ctrl" | "alt", TextKey> = {
  esc: "escape", backtab: "shiftTab", interrupt: "interrupt", slash: "slash", up: "up", down: "down", left: "left", right: "right",
  pageup: "pageup", pagedown: "pagedown", tab: "tab", enter: "enter", ctrl: "ctrl", alt: "alt",
};
const icons = { up: ArrowUp, down: ArrowDown, left: ArrowLeft, right: ArrowRight, enter: CornerDownLeft };

/** Focus stays in the composer. All repeat timers belong to this session's key strip. */
export function KeyBar({ disabled, modifiers, onModifiers, onKey, t }: {
  disabled: boolean; modifiers: Modifiers; onModifiers: (modifiers: Modifiers) => void;
  onKey: (key: Key) => void; t: Translate;
}) {
  const timers = useRef<{ delay?: ReturnType<typeof setTimeout>; repeat?: ReturnType<typeof setInterval> }>({});
  const callback = useRef(onKey); callback.current = onKey;
  const stop = () => { clearTimeout(timers.current.delay); clearInterval(timers.current.repeat); timers.current = {}; };
  useEffect(() => stop, []);
  useEffect(() => { if (disabled) stop(); }, [disabled]);
  const press = (key: Key | "ctrl" | "alt") => {
    if (disabled) return;
    if (key === "ctrl" || key === "alt") onModifiers({ ...modifiers, [key]: !modifiers[key] });
    else callback.current(key);
  };
  return <div className="tap-keybar" role="group" aria-label={t("keys")}>
    {rows.map((row, index) => <div className="tap-keyrow" key={index}>
      {row.map((key) => {
        const Icon = key in icons ? icons[key as keyof typeof icons] : undefined;
        const latched = (key === "ctrl" || key === "alt") && modifiers[key];
        return <button key={key} type="button" disabled={disabled}
          className={`tap-keycap${key === "enter" ? " is-enter" : ""}${latched ? " is-latched" : ""}`}
          aria-label={t(labels[key])} aria-pressed={key === "ctrl" || key === "alt" ? modifiers[key] : undefined}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault(); stop(); press(key);
            event.currentTarget.setPointerCapture(event.pointerId);
            if (["up", "down", "left", "right"].includes(key)) timers.current.delay = setTimeout(() => {
              timers.current.repeat = setInterval(() => callback.current(key as Key), 70);
            }, 380);
          }} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}
          onContextMenu={(event) => event.preventDefault()}
          onClick={(event) => { if (event.detail === 0) press(key); }}>
          {Icon ? <Icon size={15} strokeWidth={1.9} aria-hidden /> : key === "interrupt" ? "^C" : key === "slash" ? "/"
            : key === "backtab" ? "⇧ Tab" : key === "pageup" ? "PgUp" : key === "pagedown" ? "PgDn" : key === "esc" ? "Esc"
              : key.charAt(0).toUpperCase() + key.slice(1)}
        </button>;
      })}
    </div>)}
  </div>;
}
