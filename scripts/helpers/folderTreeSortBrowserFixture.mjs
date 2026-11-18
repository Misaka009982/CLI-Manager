import path from "node:path";
import ts from "typescript";
import {
  findNode, functionSource, settingsDefaultsSource, settingsMigrationSource,
  settingsUpdateExpression, sourceAst, variableExpression,
} from "./folderTreeSortFixture.mjs";

const sidebarPath = "src/features/files/api/FileExplorerSidebar.tsx";
const fileStorePath = "src/features/files/api/fileExplorerStore.ts";

/** 构造最小真实源码切片，避免浏览器夹具加载目录查询、daemon 或应用入口。 */
export function folderTreeSortBrowserPlugin(root) {
  const from = (source, names) => `import { ${names} } from ${JSON.stringify(path.resolve(root, source))};`;
  const callback = name => {
    const ast = sourceAst(sidebarPath);
    const node = findNode(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name, name);
    return node.initializer.arguments[0].getText(ast);
  };
  const nodes = () => [
    'import { useState, useRef, useEffect } from "react";',
    'import { getMaterialFileIcon, getMaterialFolderIcon } from "@baybreezy/file-extension-icon";',
    'import { invoke } from "@tauri-apps/api/core";',
    'import { toast } from "sonner";',
    'import { useFileExplorerStore, isDefaultCollapsedDirectoryName } from "folder-sort-files";',
    from("src/shared/i18n/index.ts", "useI18n"),
    from("src/shared/ui/icons.ts", "ChevronRight, Copy, File, FileCode, Folder, FolderOpen, FolderPlus, Pencil, Trash2, X"),
    from("src/shared/ui/context-menu.tsx", "ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator"),
    from("src/features/files/components/FolderTreeSortMenu.tsx", "FolderTreeSortMenu"),
    from("src/features/files/api/aiClipboard.ts", "copyAiText"),
    from("src/features/files/api/aiPathFormatter.ts", "formatAiTree"),
    from("src/features/files/lib/fileExplorerOperations.ts", "fileActionEntries, isFileActionInput, normalizeFileOperationEntries"),
    from("src/shared/lib/fileTreeSort.ts", "sortFileTreeEntries"),
    from("src/shared/lib/fileTreeSortOverrides.ts", "resolveFolderTreeSort"),
    functionSource("src/features/terminal/api/useTerminalFilePointerDrag.tsx", "isTerminalFilePointerDragClickHandled"),
    `const ALWAYS_HIDDEN_ENTRY_NAMES = ${variableExpression(sidebarPath, "ALWAYS_HIDDEN_ENTRY_NAMES")};`,
    ...["joinProjectPath", "openFileBrowserFolder", "statusBadgeStyle", "collectCompactDirectoryChain",
      "isAlwaysHiddenEntry", "isEntryIgnored", "visibleTreeEntries", "parentPath", "fileOperationErrorMessage",
      "copyFileEntries", "InlineRenameInput", "FileSelectionMenuItems", "FileNode", "FileTreeRows"]
      .map(name => functionSource(sidebarPath, name)),
    // 本轮未修改的远端服务和路径复制菜单是隔离边界，不替换被测排序或行事件。
    "function LiveServerFileMenuItem() { return null; } function PathCopyMenu() { return null; }",
    `export function createRowHandlers(context) {
      const { project, mutationBusy, gitIgnoreCaseInsensitive, beginFilePointerDrag, selectEntry,
        clearSelection, pasteIntoTarget, getPasteTargetPath, setConfirmAction, openInput, t } = context;
      const readOnly = project?.environment_type === "ssh";
      return { root: ${callback("handleRootKeyDown")}, row: ${callback("handleFileKeyDown")},
        pointer: ${callback("handleFilePointerDown")} };
    }`,
    `export function projectTree(tree, fileTreeSort, folderSortRules, sortScope) { return (${callback("sortedTree")})(); }`,
    `export function pointerTarget(x, y) { return (${callback("getPointerDropTargetPath")})(x, y); }`,
    "export { FileTreeRows };",
  ].join("\n");
  const files = () => [
    'import { create } from "zustand";',
    from("src/features/files/lib/fileExplorerOperations.ts", "selectFileEntries, fileActionEntries"),
    `const DEFAULT_COLLAPSED_DIRECTORY_NAMES = ${variableExpression(fileStorePath, "DEFAULT_COLLAPSED_DIRECTORY_NAMES")};`,
    `const DEFAULT_COLLAPSED_DIRECTORY_NAME_SET = ${variableExpression(fileStorePath, "DEFAULT_COLLAPSED_DIRECTORY_NAME_SET")};`,
    `export ${functionSource(fileStorePath, "isDefaultCollapsedDirectoryName")}`,
    `export const fileFixtureCalls = { selection: 0, expand: 0, collapse: 0, clipboard: 0, paste: 0,
      confirm: 0, pointer: 0, drag: 0, rootKey: 0, rootClick: 0, rootPointer: 0, rootContext: 0, rootDouble: 0, drop: 0 };
    export const initialProject = { id: "project", name: "fixture", environment_type: "local", path: "C:/repo",
      ssh_host_id: null, remote_path: null };
    export const useFileExplorerStore = create((set, get) => ({ project: initialProject,
      expandedPaths: new Set(["logs", "logs/archive", "src", "a", "a/b", "a/b/c"]),
      selectedEntries: [{ path: "src/a.txt", name: "a.txt", kind: "file" }], mutationBusy: false,
      clearSelection() { fileFixtureCalls.selection++; set({ selectedEntries: [] }); },
      selectEntry(entry, toggle = false) { fileFixtureCalls.selection++; set({ selectedEntries: selectFileEntries(get().selectedEntries, entry, toggle) }); },
      getActionEntries(entry) { return fileActionEntries(get().selectedEntries, entry); },
      toggleDir(path) { fileFixtureCalls.expand++; const next = new Set(get().expandedPaths);
        next.has(path) ? next.delete(path) : next.add(path); set({ expandedPaths: next }); },
      expandCompactDirChain(path) { fileFixtureCalls.expand++; set({ expandedPaths: new Set([...get().expandedPaths, path]) }); },
      collapseDir(path) { fileFixtureCalls.collapse++;
        set({ expandedPaths: new Set([...get().expandedPaths].filter(item => item !== path && !item.startsWith(path + "/"))) }); },
      async copyEntries() { fileFixtureCalls.clipboard++; return true; },
    }));`,
  ].join("\n");
  const settings = () => [
    'import { create } from "zustand";',
    from("src/shared/lib/fileTreeSort.ts", "DEFAULT_FILE_TREE_SORT, migrateFileTreeSortSettings"),
    from("src/shared/lib/fileTreeSortOverrides.ts", "migrateFileTreeSortOverrides"),
    `const disk = {}; const writes = []; let held = false, rejectNext = false; let pending = [];
    async function getStore() { return { async set(key, value) { writes.push({ key, value: structuredClone(value) });
      if (held) await new Promise(resolve => pending.push(resolve));
      if (rejectNext) { rejectNext = false; throw new Error("fixture_write_failed"); }
      disk[key] = structuredClone(value); } }; }
    function prepareDesktopPetSettingUpdate() { throw new Error("unexpected_fixture_setting"); }
    function applyDebugMode() { throw new Error("unexpected_fixture_debug_update"); }
    export const fixtureStorage = { pause() { held = true; }, failNext() { rejectNext = true; },
      release() { held = false; const current = pending; pending = []; current.forEach(resolve => resolve()); },
      snapshot() { return { disk: structuredClone(disk), writes: structuredClone(writes) }; } };
    export const useSettingsStore = create((set, get) => ({ ${settingsDefaultsSource()},
      language: "zh-CN", resolvedTheme: "dark", loaded: true,
      update: ${settingsUpdateExpression()},
      async load() { const entries = structuredClone(disk); ${settingsMigrationSource()} set({ ...entries, loaded: true }); },
    }));`,
  ].join("\n");

  return {
    name: "folder-tree-sort-real-source",
    setup(build) {
      build.onResolve({ filter: /^folder-sort-(?:nodes|files|settings)$/ }, args => ({ path: args.path, namespace: "folder-sort" }));
      build.onResolve({ filter: /(?:^|[/\\])settingsStore(?:\.ts)?$/ }, () => ({ path: "folder-sort-settings", namespace: "folder-sort" }));
      build.onResolve({ filter: /(?:^|[/\\])fileExplorerStore(?:\.ts)?$/ }, () => ({ path: "folder-sort-files", namespace: "folder-sort" }));
      build.onLoad({ filter: /.*/, namespace: "folder-sort" }, args => ({
        contents: args.path === "folder-sort-nodes" ? nodes() : args.path === "folder-sort-files" ? files() : settings(),
        loader: "tsx", resolveDir: root,
      }));
    },
  };
}
