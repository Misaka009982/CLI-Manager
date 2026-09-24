export type TerminalDisplay = { mode: "manual" | "width" | "contain"; fontSize: number; zoom: number };
export const DISPLAY_KEY = "cli-manager.web-terminal-display.v1";
export const DEFAULT_DISPLAY: TerminalDisplay = { mode: "width", fontSize: 14, zoom: 100 };

export function normalizeDisplay(value: unknown): TerminalDisplay {
  const input = value && typeof value === "object" ? value as Partial<TerminalDisplay> : {};
  const clamp = (n: unknown, fallback: number, min: number, max: number) =>
    typeof n === "number" && Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
  return {
    mode: input.mode === "manual" ? "manual" : "width",
    fontSize: clamp(input.fontSize, 14, 1, 36),
    zoom: clamp(input.zoom, 100, 25, 300),
  };
}

export function readDisplay(): TerminalDisplay {
  try { return normalizeDisplay(JSON.parse(localStorage.getItem(DISPLAY_KEY) ?? "null")); }
  catch { return { ...DEFAULT_DISPLAY }; }
}

export function stepDisplaySize(display: TerminalDisplay, direction: number, actualFontSize = display.fontSize): Partial<TerminalDisplay> {
  return { mode: "manual", fontSize: Math.max(1, Math.min(36, actualFontSize + direction)) };
}
