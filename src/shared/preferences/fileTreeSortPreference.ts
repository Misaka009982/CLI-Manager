import { createFileTreeSortUpdater } from "../lib/fileTreeSort";
import { useSettingsStore } from "./settingsStore";

/** 所有文件面板共用同一写队列，持久化仍以 Settings 为唯一真值。 */
export const updateFileTreeSort = createFileTreeSortUpdater(
  () => useSettingsStore.getState().fileTreeSort,
  (next) => useSettingsStore.getState().update("fileTreeSort", next),
);
