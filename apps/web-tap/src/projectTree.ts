import type { WorkspaceProject, WorkspaceSnapshot } from "./protocol";

type WorkspaceGroup = WorkspaceSnapshot["groups"][number];
type Session = NonNullable<WorkspaceSnapshot["terminals"]>[number];
export type ProjectTreeNode =
  | { kind: "group"; key: string; group: WorkspaceGroup; children: ProjectTreeNode[] }
  | { kind: "project"; key: string; project: WorkspaceProject; sessions: Session[]; duplicateName: boolean };

/** Restore desktop hierarchy and mixed sibling order; names/paths never determine identity. */
export function buildProjectTree(workspace: WorkspaceSnapshot): ProjectTreeNode[] {
  const groups = new Map(workspace.groups.map((group) => [group.id, group]));
  const parents = new Map([...groups.values()].map((group) => [
    group.id, group.parentId && groups.has(group.parentId) ? group.parentId : null,
  ]));
  // Old/incomplete snapshots may contain orphan parents or cycles. Break only the cycle edge,
  // keeping each registered group/project reachable once instead of hiding its entire subtree.
  const checked = new Set<string>();
  for (const id of groups.keys()) {
    const path = new Set<string>();
    let current: string | null = id;
    while (current !== null && !checked.has(current)) {
      if (path.has(current)) { parents.set(current, null); break; }
      path.add(current);
      current = parents.get(current) ?? null;
    }
    for (const item of path) checked.add(item);
  }
  const groupNodes = new Map([...groups.values()].map((group) => [group.id, {
    kind: "group" as const, key: `group:${group.id}`, group, children: [] as ProjectTreeNode[],
  }]));
  const root: ProjectTreeNode[] = [];
  for (const node of groupNodes.values()) {
    const parent = groupNodes.get(parents.get(node.group.id) ?? "");
    (parent?.children ?? root).push(node);
  }
  const sessions = new Map<string, Session[]>();
  for (const session of workspace.terminals ?? []) {
    const items = sessions.get(session.projectId) ?? [];
    items.push(session);
    sessions.set(session.projectId, items);
  }
  const nameCounts = new Map<string, number>();
  for (const project of workspace.projects) nameCounts.set(project.name, (nameCounts.get(project.name) ?? 0) + 1);
  for (const project of workspace.projects) {
    const parent = groupNodes.get(project.groupId ?? "");
    (parent?.children ?? root).push({
      kind: "project", key: `project:${project.id}`, project,
      sessions: sessions.get(project.id) ?? [], duplicateName: (nameCounts.get(project.name) ?? 0) > 1,
    });
  }
  const sort = (nodes: ProjectTreeNode[]) => {
    nodes.sort((left, right) => {
      const a = left.kind === "group" ? left.group : left.project;
      const b = right.kind === "group" ? right.group : right.project;
      return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || left.key.localeCompare(right.key);
    });
    for (const node of nodes) if (node.kind === "group") sort(node.children);
  };
  sort(root);
  return root;
}

/** Expand active project IDs and their ancestors only; use the already normalized tree for orphan/cycle handling. */
export function expandedProjectPathKeys(nodes: ProjectTreeNode[], activeProjectIds: ReadonlySet<string>): Set<string> {
  const expanded = new Set<string>();
  const visit = (node: ProjectTreeNode): boolean => {
    const active = node.kind === "project"
      ? activeProjectIds.has(node.project.id)
      : node.children.map(visit).some(Boolean);
    if (active) expanded.add(node.key);
    return active;
  };
  nodes.forEach(visit);
  return expanded;
}

/** Matching a group/project shows its contents; session matches keep their ancestor path. */
export function filterProjectTree(nodes: ProjectTreeNode[], query: string, workspace: WorkspaceSnapshot): ProjectTreeNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  const worktrees = new Map(workspace.worktrees.map((worktree) => [worktree.id, worktree]));
  const filter = (items: ProjectTreeNode[], ancestorMatches: boolean): ProjectTreeNode[] => items.flatMap((node): ProjectTreeNode[] => {
    if (node.kind === "group") {
      const matches = ancestorMatches || node.group.name.toLowerCase().includes(needle);
      const children = filter(node.children, matches);
      return matches || children.length ? [{ ...node, children }] : [];
    }
    const { project } = node;
    const matches = ancestorMatches || `${project.name} ${project.cwd ?? ""}`.toLowerCase().includes(needle);
    const sessions = matches ? node.sessions : node.sessions.filter((session) => {
      const worktree = worktrees.get(session.worktreeId ?? "");
      return `${session.title} ${worktree?.name ?? ""} ${worktree?.branch ?? ""}`.toLowerCase().includes(needle);
    });
    return matches || sessions.length ? [{ ...node, sessions }] : [];
  });
  return filter(nodes, false);
}
