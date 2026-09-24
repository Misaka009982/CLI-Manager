import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import type { Project, TreeNode } from "../../../shared/types/index";
import { useI18n } from "../../../shared/i18n/index";
import { collectProjectAncestorGroupIds } from "../lib/sidebarModel";
import type { ProjectListFilter } from "../components/SidebarHeader";

export interface ProjectLocateRequest {
  projectId: string;
  /** 随请求带上名称：滚动阶段可能才发现目标行不可达，此时已取不到 Project 对象。 */
  projectName: string;
  /** 单调递增：同一项目重复定位靠它触发重新滚动（选中态没变时不会重跑副作用）。 */
  nonce: number;
}

interface UseProjectLocateParams {
  tree: TreeNode[];
  projectFilter: ProjectListFilter;
  setProjectFilter: (filter: ProjectListFilter) => void;
  setCollapsedIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectedId: (projectId: string | null) => void;
  /** 定位动作开始前执行，用于关闭右键菜单。 */
  onBeforeLocate?: () => void;
}

/**
 * 「定位位置」：把已置顶项目的副本定位回主列表中它的真实位置。
 *
 * 置顶项是主列表节点的副本（data-tree-key 为 `pin:p:<id>`，主列表为 `p:<id>`），
 * 置顶区有独立滚动区，因此副本滚走后无从知道原项目在哪。定位分三步：
 * ① 筛选切回「全部」，否则项目可能不在树里；② 展开折叠的祖先分组，否则子节点不渲染；
 * ③ 选中该项目并递增 nonce，由 ProjectTree 的副作用滚动到位。
 */
export function useProjectLocate({
  tree,
  projectFilter,
  setProjectFilter,
  setCollapsedIds,
  setSelectedId,
  onBeforeLocate,
}: UseProjectLocateParams) {
  const { t } = useI18n();
  const [locateRequest, setLocateRequest] = useState<ProjectLocateRequest | null>(null);
  const nonceRef = useRef(0);

  const locateProject = useCallback(
    (project: Project) => {
      onBeforeLocate?.();

      if (projectFilter !== "all") {
        setProjectFilter("all");
      }

      const ancestors = collectProjectAncestorGroupIds(tree, project.id);
      if (ancestors === null) {
        toast.info(t("sidebar.locate.notFound"), {
          description: t("sidebar.locate.notFoundDescription", { name: project.name }),
        });
        return;
      }

      // 折叠的分组不会渲染子节点，先展开祖先。与手动展开同语义，因此会被持久化。
      if (ancestors.length > 0) {
        setCollapsedIds((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const groupId of ancestors) {
            if (next.delete(groupId)) changed = true;
          }
          return changed ? next : prev;
        });
      }

      setSelectedId(project.id);
      nonceRef.current += 1;
      setLocateRequest({ projectId: project.id, projectName: project.name, nonce: nonceRef.current });
    },
    [onBeforeLocate, projectFilter, setCollapsedIds, setProjectFilter, setSelectedId, t, tree]
  );

  return { locateRequest, locateProject };
}
