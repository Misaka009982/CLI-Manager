import { isTauri } from "@tauri-apps/api/core";
import { createFileTreeSortPreferencesUpdater } from "../lib/fileTreeSortOverrides";
import { useSettingsStore } from "./settingsStore";

/** 全局默认与目录覆盖共用队列；出队时才读取真值，旧菜单不能改写新项目目标。 */
const updater = createFileTreeSortPreferencesUpdater(
  () => {
    const state = useSettingsStore.getState();
    if (!isTauri() || !state.loaded) throw new Error("file_tree_sort_settings_unavailable");
    return state;
  },
  (next) => useSettingsStore.getState().update("fileTreeSort", next),
  (next) => useSettingsStore.getState().update("fileTreeSortOverrides", next),
);

export const updateFileTreeSort = updater.updateGlobal;
export const updateFolderTreeSort = updater.updateFolder;
