import { create } from "zustand";

// 替换桌面持久化，保留生产组件使用的响应式偏好契约。
export const useSettingsStore = create(() => ({
  language: "zh-CN",
  terminalLayoutLocked: false,
  terminalTabHoverInfoEnabled: false,
  terminalThemeName: "auto",
  resolvedTheme: "dark" as "light" | "dark",
  update: async (_key: string, terminalLayoutLocked: boolean) => {
    useSettingsStore.setState({ terminalLayoutLocked });
  },
}));
