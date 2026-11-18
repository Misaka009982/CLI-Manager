import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import type { Project, ProjectFileEntry } from "../../src/shared/types/index";
import { useI18n } from "../../src/shared/i18n/index";
import { FileTreeSortMenu } from "../../src/features/files/components/FileTreeSortMenu";
import { fileTreeSortScope } from "../../src/features/files/lib/fileTreeSortScope";
import { updateFileTreeSort } from "../../src/shared/preferences/fileTreeSortPreference";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "../../src/shared/ui/context-menu";
import { FileTreeRows, createRowHandlers, projectTree } from "folder-sort-nodes";
import { useFileExplorerStore, fileFixtureCalls, initialProject } from "folder-sort-files";
import { useSettingsStore, fixtureStorage } from "folder-sort-settings";

// 只模拟 Tauri 标识与 KV 传输，不启动 Tauri、应用服务或真实目录查询。
Object.assign(window, { __TAURI_INTERNALS__: {} });
const file = (path: string, modifiedMs: number): ProjectFileEntry => ({
  path, name: path.split("/").at(-1)!, kind: "file", modifiedMs, sizeBytes: 0,
});
const directory = (path: string, children: ProjectFileEntry[]): ProjectFileEntry => ({
  path, name: path.split("/").at(-1)!, kind: "directory", sizeBytes: 0, children,
});
const baseTree = [
  directory("logs", [file("logs/a-old.txt", 1), file("logs/z-new.txt", 3),
    directory("logs/archive", [file("logs/archive/a.txt", 1), file("logs/archive/z.txt", 3)])]),
  directory("src", [file("src/z.txt", 3), file("src/a.txt", 1)]),
  directory("a", [directory("a/b", [directory("a/b/c", [file("a/b/c/z.txt", 3), file("a/b/c/a.txt", 1)])])]),
  directory("very-long-folder-name-for-narrow-layout", [file("very-long-folder-name-for-narrow-layout/file.txt", 1)]),
  file("root.txt", 0),
];
const ignoreState = { ignoredPaths: new Set<string>(), ignoreMatcher: { ignores: () => false },
  ignorePath: () => {}, unignorePath: () => {} };

/** 两个实际行/菜单宿主共用真实偏好队列，不加载完整 Sidebar 的目录查询。 */
function FileHost({ id, entries }: { id: string; entries: ProjectFileEntry[] }) {
  const { t } = useI18n();
  const project = useFileExplorerStore(state => state.project) as Project;
  const selected = useFileExplorerStore(state => state.selectedEntries);
  const preferences = useSettingsStore(state => state.fileTreeSort);
  const overrides = useSettingsStore(state => state.fileTreeSortOverrides);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const scope = fileTreeSortScope(project)!;
  const tree = projectTree(entries, preferences, overrides[scope.key], scope);
  const handlers = createRowHandlers({ project, mutationBusy: false, gitIgnoreCaseInsensitive: scope.ignoreCase,
    beginFilePointerDrag: () => fileFixtureCalls.pointer++,
    selectEntry: useFileExplorerStore.getState().selectEntry,
    clearSelection: useFileExplorerStore.getState().clearSelection,
    pasteIntoTarget: () => fileFixtureCalls.paste++,
    getPasteTargetPath: (entry: ProjectFileEntry) => entry.kind === "directory" ? entry.path : entry.path.split("/").slice(0, -1).join("/"),
    setConfirmAction: () => fileFixtureCalls.confirm++, openInput: () => fileFixtureCalls.confirm++, t });
  return (
    <section id={id} className={id === "sidebar" ? "ui-file-explorer-sidebar" : "ui-terminal-panel-theme"}
      style={{ width: 280, minWidth: 0, border: "1px solid var(--border)", padding: 8 }}>
      <header style={{ display: "flex", justifyContent: "space-between" }}>
        {id}<FileTreeSortMenu settings={preferences} onChange={updateFileTreeSort} portalContainer={portal} />
      </header>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div tabIndex={0} data-file-drop-target-path="" style={{ marginTop: 12 }}
            onPointerDown={() => fileFixtureCalls.rootPointer++}
            onClick={event => { fileFixtureCalls.rootClick++; if (event.target === event.currentTarget) useFileExplorerStore.getState().clearSelection(); }}
            onKeyDown={event => { fileFixtureCalls.rootKey++; handlers.root(event); }}
            onContextMenu={() => fileFixtureCalls.rootContext++}
            onDoubleClick={() => fileFixtureCalls.rootDouble++}
            onDragOver={event => { event.preventDefault(); fileFixtureCalls.drop++; }}
            onDrop={event => { event.preventDefault(); fileFixtureCalls.drop++; }}>
            <FileTreeRows entries={tree} depth={0} getGitChange={() => null}
              getDisplayStatus={entry => entry.kind === "directory" ? { kind: "git", label: "M", color: "#59a669", symbol: "M", status: "M" } : null}
              onOpenFile={() => {}} onOpenDiff={() => {}} onInput={() => fileFixtureCalls.confirm++}
              onConfirm={() => fileFixtureCalls.confirm++} onPaste={() => fileFixtureCalls.paste++}
              renamingPath={null} onRenameSubmit={() => fileFixtureCalls.confirm++} onRenameCancel={() => {}}
              onFileKeyDown={handlers.row} onFilePointerDown={handlers.pointer}
              onFilePointerMove={() => fileFixtureCalls.pointer++} onFilePointerUp={() => fileFixtureCalls.pointer++}
              onFilePointerCancel={() => fileFixtureCalls.pointer++}
              onFileDragStart={() => fileFixtureCalls.drag++} onFileDrag={() => fileFixtureCalls.drag++}
              onFileDragEnd={() => fileFixtureCalls.drag++} onFileDragOver={() => fileFixtureCalls.drop++}
              onFileDrop={() => fileFixtureCalls.drop++} ignoreState={ignoreState} menuPortalContainer={portal}
              readOnly={project.environment_type === "ssh"} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent portalContainer={portal}><ContextMenuItem>ROOT_CONTEXT</ContextMenuItem></ContextMenuContent>
      </ContextMenu>
      <output data-selected-paths>{selected.map(entry => entry.path).join(",")}</output>
      <div id={`${id}-menus`} ref={setPortal} />
    </section>
  );
}

function Harness() {
  const [entries, setEntries] = useState(baseTree);
  useEffect(() => {
    Object.assign(window, { folderSortFixture: {
      snapshot() {
        const files = useFileExplorerStore.getState(), settings = useSettingsStore.getState();
        return { project: files.project, selected: files.selectedEntries.map(entry => entry.path),
          expanded: [...files.expandedPaths], calls: { ...fileFixtureCalls },
          global: settings.fileTreeSort, overrides: settings.fileTreeSortOverrides,
          scope: fileTreeSortScope(files.project), storage: fixtureStorage.snapshot() };
      },
      pause: fixtureStorage.pause, release: fixtureStorage.release, failNext: fixtureStorage.failNext,
      reload: () => useSettingsStore.getState().load(),
      chain(reset = false) { setEntries(reset ? baseTree : baseTree.map(entry => entry.path === "a"
        ? directory("a", [directory("a/b", [directory("a/b/d", [file("a/b/d/a.txt", 1), file("a/b/d/z.txt", 3)])])]) : entry)); },
      root(path: string) { useFileExplorerStore.setState({ project: { ...initialProject, path } }); },
      ssh() { useFileExplorerStore.setState({ project: { ...initialProject, environment_type: "ssh", ssh_host_id: "host-a", remote_path: "/home/Repo" } }); },
      language() { useSettingsStore.setState({ language: "en-US" }); },
      theme() { document.documentElement.dataset.theme = "light"; useSettingsStore.setState({ resolvedTheme: "light" }); },
    } });
  }, []);
  return <><main style={{ display: "flex", flexWrap: "wrap", gap: 16, padding: 12 }}>
    <FileHost id="sidebar" entries={entries} /><FileHost id="panel" entries={entries} />
  </main><Toaster /></>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
