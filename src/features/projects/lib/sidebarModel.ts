import { type MouseEvent as ReactMouseEvent } from "react";
import { useProjectStore } from "../api/projectStore";
import { type SplitTerminalOptions } from "../../terminal/state";
import { useExternalSessionSyncStore } from "../../history/api/externalSessionSyncStore";
import type { HistorySourceFilter, Project, TreeNode as TNode, TerminalScope, TerminalSession } from "../../../shared/types/index";
import type { WorkspaceDockSide } from "../../../shared/lib/workspaceLayout";
import { resolveProjectStartupCommand } from "../api/projectStartupCommand";
import { resolveCliToolHistorySourceId } from "../../../shared/lib/cliTools";
import { parseProjectEnvVars } from "../../providers/api/providerSwitching";
import { groupSyncedExternalSessions } from "../../history/api/externalSessionGrouping";
import type { SettingsTab } from "../../settings/api/SettingsModal";
import { resolveProjectPath } from "../api/groupPath";

export interface SidebarProps {
  onOpenSettings: (tab?: SettingsTab) => void;
  onOpenStats: () => void;
  compactMode?: boolean;
  dockSide?: WorkspaceDockSide;
  projectScopedTerminalViewEnabled?: boolean;
  terminalScope?: TerminalScope;
  onTerminalScopeChange?: (scope: TerminalScope) => void;
}

export const SIDEBAR_COLLAPSED_WIDTH = 64;

export const SIDEBAR_COLLAPSE_THRESHOLD = 140;

export const SIDEBAR_MIN_WIDTH = 168;

export const SIDEBAR_MAX_WIDTH = 500;

export const SIDEBAR_AUTO_COLLAPSE_BREAKPOINT = 900;

export const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function preserveSidebarScrollAfterContextMenu(event: ReactMouseEvent, markInternalScroll?: (until: number) => void) {
  const target = event.currentTarget as HTMLElement | null;
  // 分区滚动后真正的滚动元素是列表区容器（外层 .ui-sidebar-combined-list 的 scrollTop 恒为 0）。
  // 置顶区有独立滚动，从置顶项右键时 closest 返回 null，正好避免回写置顶区的滚动位置。
  const scrollContainer = target?.closest<HTMLElement>(".ui-sidebar-main-scroll") ?? null;
  const scrollTop = scrollContainer?.scrollTop ?? null;
  const treeItem = target?.closest<HTMLElement>("[data-tree-key]") ?? null;
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && treeItem?.contains(activeElement)) {
    activeElement.blur();
  }
  if (!scrollContainer || scrollTop === null) return;
  markInternalScroll?.(Date.now() + 300);
  const restore = () => {
    if (scrollContainer.scrollTop !== scrollTop) {
      scrollContainer.scrollTop = scrollTop;
    }
  };
  window.setTimeout(restore, 0);
  window.requestAnimationFrame(() => {
    restore();
    window.requestAnimationFrame(restore);
  });
  window.setTimeout(restore, 50);
  window.setTimeout(restore, 150);
}

export function isLikelyMacOs() {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

export function clampExpandedSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width));
}

export function normalizePersistedSidebarWidth(width: number): number {
  if (width <= SIDEBAR_COLLAPSED_WIDTH) return SIDEBAR_COLLAPSED_WIDTH;
  return clampExpandedSidebarWidth(width === 280 ? 248 : width);
}

export function resolveHistorySourceFilter(cliTool: string | null | undefined): HistorySourceFilter {
  return resolveCliToolHistorySourceId(cliTool) ?? "all";
}

export function buildProjectSplitOptions(project: Project): SplitTerminalOptions {
  const envVars = parseProjectEnvVars(project);
  const cwd = resolveProjectPath(project, useProjectStore.getState().groups);

  return {
    projectId: project.id,
    cwd,
    title: project.name,
    startupCmd: resolveProjectStartupCommand(project),
    envVars,
    shell: project.shell && project.shell !== "powershell" ? project.shell : undefined,
  };
}

export function getSyncedSessionKeysForProject(
  project: Project,
  syncedSessions: ReturnType<typeof useExternalSessionSyncStore.getState>["syncedSessions"]
): string[] {
  return groupSyncedExternalSessions(syncedSessions, [project])
    .byProjectId.get(project.id)
    ?.flatMap((group) => group.sessions.map((session) => session.key)) ?? [];
}

export function filterTreeForOpenTerminals(
  nodes: TNode[],
  openProjectIds: Set<string>,
  openWorktreeIds: Set<string>
): TNode[] {
  const filtered: TNode[] = [];
  for (const node of nodes) {
    if (node.type === "group") {
      const children = filterTreeForOpenTerminals(node.children, openProjectIds, openWorktreeIds);
      if (children.length > 0) filtered.push({ ...node, children });
      continue;
    }
    if (node.type === "worktree") {
      if (openWorktreeIds.has(node.worktree.id)) filtered.push(node);
      continue;
    }
    if (!openProjectIds.has(node.project.id)) continue;
    filtered.push({
      ...node,
      worktrees: (node.worktrees ?? []).filter((worktree) => openWorktreeIds.has(worktree.id)),
    });
  }
  return filtered;
}

/**
 * 求某个项目在树中的祖先分组 id 链（由外到内）。
 * 用于「定位位置」：折叠的分组不会渲染其子节点，必须先展开祖先才能滚动到位。
 * 返回 null 表示该项目不在树中（已删除、被筛选排除等），调用方据此给出提示。
 */
export function collectProjectAncestorGroupIds(nodes: TNode[], projectId: string): string[] | null {
  const walk = (list: TNode[], ancestors: string[]): string[] | null => {
    for (const node of list) {
      if (node.type === "project" && node.project.id === projectId) return ancestors;
      if (node.type === "group") {
        const found = walk(node.children, [...ancestors, node.group.id]);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(nodes, []);
}

export interface GroupTerminalTargets {
  terminalSessionIds: string[];
  closableSessionIds: string[];
}

export function collectGroupTerminalTargets(
  sessions: TerminalSession[],
  projectIds: Set<string>
): GroupTerminalTargets {
  const terminalSessionIds = sessions
    .filter((session) => session.projectId && projectIds.has(session.projectId) && (session.kind ?? "pty") === "pty")
    .map((session) => session.id);
  const terminalIdSet = new Set(terminalSessionIds);
  const transcriptSessionIds = sessions
    .filter((session) => session.kind === "subagent-transcript" && terminalIdSet.has(session.subagent?.parentSessionId ?? ""))
    .map((session) => session.id);
  return {
    terminalSessionIds,
    closableSessionIds: [...transcriptSessionIds, ...terminalSessionIds],
  };
}

export type SidebarConfirmAction = | null
    | { kind: "delete-project"; project: Project }
    | { kind: "delete-group"; groupId: string; groupName: string }
    | { kind: "delete-selection"; groups: { groupId: string; groupName: string }[]; projects: Project[] };
