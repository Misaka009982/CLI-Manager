export type Modifiers = { ctrl: boolean; alt: boolean };
export type Key = "esc" | "backtab" | "interrupt" | "slash" | "up" | "down" | "left" | "right" | "pageup" | "pagedown" | "tab" | "enter";
export type InputKey = {
  key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean;
  isComposing?: boolean; keyCode?: number;
};

/** Encode the user's actual key, including the CLI's application cursor mode. */
export function keyBytes(key: Key, modifiers: Modifiers, applicationCursor = false): string {
  const arrows: Partial<Record<Key, string>> = { up: "A", down: "B", right: "C", left: "D" };
  const parameter = 1 + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
  const arrow = arrows[key];
  if (arrow) return parameter > 1 ? `\x1b[1;${parameter}${arrow}` : `\x1b${applicationCursor ? "O" : "["}${arrow}`;
  const meta = modifiers.alt ? "\x1b" : "";
  switch (key) {
    case "esc": return "\x1b";
    case "backtab": return "\x1b[Z";
    case "interrupt": return "\x03";
    case "slash": return modifyCharacter("/", modifiers);
    case "tab": return meta + "\t";
    case "enter": return meta + "\r";
    case "pageup": case "pagedown": {
      const code = key === "pageup" ? 5 : 6;
      return parameter > 1 ? `\x1b[${code};${parameter}~` : `\x1b[${code}~`;
    }
    default: return "";
  }
}

/** A latched modifier applies to one character, never to an IME string. */
export function modifyCharacter(value: string, modifiers: Modifiers): string {
  if ([...value].length !== 1) return value;
  let text = value;
  if (modifiers.ctrl) {
    const code = value.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) text = String.fromCharCode(code - 64);
    else if (value === " ") text = "\x00";
    else if (value === "/") text = "\x1f";
  }
  return (modifiers.alt ? "\x1b" : "") + text;
}

/** Candidate confirmation must never become a CLI command submission. */
export function composerAction(event: InputKey, phone: boolean): "send" | "newline" | "none" {
  if (event.isComposing || event.keyCode === 229 || event.key === "Process" || event.key !== "Enter") return "none";
  if (event.metaKey || event.ctrlKey) return "send";
  return phone || event.shiftKey || event.altKey ? "newline" : "send";
}

/** Multiline content needs bracketed paste so it cannot execute line by line. */
export function preparePaste(text: string, bracketed: boolean): string {
  if (/[\r\n]/.test(text) && !bracketed) throw new Error("multiline_paste_unavailable");
  const safe = text.replace(/\x1b\[20[01]~/g, "");
  return bracketed ? `\x1b[200~${safe}\x1b[201~` : safe;
}
