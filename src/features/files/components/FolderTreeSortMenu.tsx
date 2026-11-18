import { useMemo, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { Project } from "../../../shared/types/index";
import { useI18n } from "../../../shared/i18n/index";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { updateFolderTreeSort } from "../../../shared/preferences/fileTreeSortPreference";
import { resolveFolderTreeSort, type FileTreeSortScope } from "../../../shared/lib/fileTreeSortOverrides";
import { fileTreeSortScope } from "../lib/fileTreeSortScope";
import { folderTreeSortEvents } from "../lib/folderTreeSortEvents";
import { FileTreeSortMenu } from "./FileTreeSortMenu";

interface Props {
  project: Project | null;
  paths: readonly string[];
  portalContainer?: HTMLElement | null;
}

// 作用域/目录链变化重建会话，旧 Promise 仍保存原目标但不能改变新菜单。
export function FolderTreeSortMenu({ project, paths, portalContainer }: Props) {
  const scope = useMemo(() => fileTreeSortScope(project), [project]);
  if (!scope || paths.length === 0) return null;
  return <FolderTreeSortSession key={JSON.stringify([scope.key, paths])}
    scope={scope} paths={paths} portalContainer={portalContainer} />;
}

function FolderTreeSortSession({ scope, paths, portalContainer }: {
  scope: FileTreeSortScope;
  paths: readonly string[];
  portalContainer?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const defaults = useSettingsStore(state => state.fileTreeSort);
  const rules = useSettingsStore(state => state.fileTreeSortOverrides[scope.key]);
  const loaded = useSettingsStore(state => state.loaded);
  const [targetPath, setTargetPath] = useState(paths[paths.length - 1]);
  const resolved = resolveFolderTreeSort(rules, targetPath, defaults, scope.ignoreCase);
  const sourceLabel = resolved.explicit ? t("files.sort.independent")
    : resolved.sourcePath ? t("files.sort.inheritedFrom", { path: resolved.sourcePath })
      : t("files.sort.globalDefault");

  return (
    <span className="inline-flex shrink-0" data-folder-sort-control="true" {...folderTreeSortEvents}>
      <FileTreeSortMenu
        settings={resolved.settings}
        disabled={!loaded || !isTauri()}
        portalContainer={portalContainer}
        onChange={change => updateFolderTreeSort(scope, targetPath, change)}
        folder={{ paths, path: targetPath, onPathChange: setTargetPath, sourceLabel, explicit: resolved.explicit,
          onReset: () => updateFolderTreeSort(scope, targetPath, null) }}
      />
    </span>
  );
}
