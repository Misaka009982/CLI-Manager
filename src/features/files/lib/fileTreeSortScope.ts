import type { Project } from "../../../shared/types/index";
import { parseFileTreeSortScope, type FileTreeSortScope } from "../../../shared/lib/fileTreeSortOverrides.ts";
import { fileContentRoot } from "./fileContentResidency.ts";

/** Worktree 与主项目可共用 id，必须连同实际根位置隔离。 */
export function fileTreeSortScope(project: Project | null): FileTreeSortScope | null {
  if (!project?.id) return null;
  const root = fileContentRoot(project) || (project.path === "/" ? "/" : "");
  return parseFileTreeSortScope(JSON.stringify([project.id, project.environment_type, root]));
}
