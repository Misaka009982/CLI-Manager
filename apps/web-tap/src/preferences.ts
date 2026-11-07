import { useEffect, useState } from "react";
import type { Language } from "./i18n";

export type ViewMode = "chat" | "terminal";
export type Preferences = {
  theme: "light" | "dark" | "system";
  language: Language;
  /** Terminal font size; undefined follows the device default. */
  fontSize?: number;
  /** Conversation text size; undefined follows the device default. */
  chatSize?: number;
  /** Last chosen session view; undefined follows the device default. */
  view?: ViewMode;
  /** Show the native key strip in terminal view; undefined follows the device default. */
  keys?: boolean;
};

const KEY = "cli-manager.tap.preferences";
export const PHONE_QUERY = "(max-width: 767px), (pointer: coarse) and (max-height: 500px)";
export const TERMINAL_SIZES = { min: 9, max: 22 } as const;
export const CHAT_SIZES = { min: 12, max: 22 } as const;

const touch = () => matchMedia("(pointer: coarse)").matches;
const clamp = (value: unknown, range: { min: number; max: number }) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, Math.round(value))) : undefined;

/** Device defaults stay implicit so a phone and a desktop can share one stored preference. */
export function resolved(prefs: Preferences) {
  const coarse = touch();
  return {
    fontSize: prefs.fontSize ?? (coarse ? 12 : 13),
    chatSize: prefs.chatSize ?? (coarse ? 14 : 15),
    view: prefs.view ?? (coarse ? "chat" : "terminal") as ViewMode,
    keys: prefs.keys ?? coarse,
  };
}

/** Invalid/blocked storage must never keep the workspace from opening. */
export function usePreferences() {
  const [prefs, setPrefs] = useState<Preferences>(() => {
    let saved: Partial<Preferences> = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {}; } catch { /* Optional persistence. */ }
    return {
      theme: saved.theme === "light" || saved.theme === "dark" ? saved.theme : "system",
      language: saved.language === "en-US" ? "en-US" : "zh-CN",
      fontSize: clamp(saved.fontSize, TERMINAL_SIZES),
      chatSize: clamp(saved.chatSize, CHAT_SIZES),
      view: saved.view === "chat" || saved.view === "terminal" ? saved.view : undefined,
      keys: typeof saved.keys === "boolean" ? saved.keys : undefined,
    };
  });
  const [phone, setPhone] = useState(() => matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const media = matchMedia(PHONE_QUERY);
    const change = () => setPhone(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* Optional persistence. */ }
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = prefs.theme === "dark" || (prefs.theme === "system" && media.matches);
      const root = document.documentElement;
      if (root.dataset.theme !== (dark ? "dark" : "light")) root.dataset.theme = dark ? "dark" : "light";
      root.lang = prefs.language;
      // Browsers color their bars from these hints; keep both aligned with the chosen theme.
      for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
        meta.content = dark ? "#0e0e13" : "#ffffff";
      }
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [prefs]);
  return { prefs, setPrefs, phone };
}
