import { create } from "zustand";

export type LanguagePreference = "zh-CN" | "en-US";

// 隔离持久化和桌面 IPC，生产 i18n 仍读取同一份可切换的语言状态。
export const useSettingsStore = create(() => ({
  language: "zh-CN" as LanguagePreference,
  uiFontFamily: "sans-serif",
}));
