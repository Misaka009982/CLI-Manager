import type { ProjectFileEntry } from "../types/index";

/** 文件树排序维度：按名称或按修改日期。 */
export type FileTreeSortKey = "name" | "date";
/** 升序 = 名称 A→Z / 日期由旧到新；降序则相反。 */
export type FileTreeSortDirection = "ascending" | "descending";

export interface FileTreeSortSettings {
  key: FileTreeSortKey;
  direction: FileTreeSortDirection;
}

/** 只提交本次选择的字段，避免旧菜单快照覆盖前一次选择。 */
export type FileTreeSortChange = { key: FileTreeSortKey } | { direction: FileTreeSortDirection };

export const DEFAULT_FILE_TREE_SORT: FileTreeSortSettings = {
  key: "name",
  direction: "ascending",
};

const FILE_TREE_SORT_KEYS: readonly FileTreeSortKey[] = ["name", "date"];
const FILE_TREE_SORT_DIRECTIONS: readonly FileTreeSortDirection[] = ["ascending", "descending"];

/** 校验任意值是否为受支持的排序维度。 */
function isFileTreeSortKey(value: unknown): value is FileTreeSortKey {
  return typeof value === "string" && (FILE_TREE_SORT_KEYS as readonly string[]).includes(value);
}

/** 校验任意值是否为受支持的排序方向。 */
function isFileTreeSortDirection(value: unknown): value is FileTreeSortDirection {
  return typeof value === "string" && (FILE_TREE_SORT_DIRECTIONS as readonly string[]).includes(value);
}

/** 缺失或损坏字段分别回落；日期默认最新在前。 */
export function migrateFileTreeSortSettings(value: unknown): FileTreeSortSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...DEFAULT_FILE_TREE_SORT };
  }
  const record = value as Record<string, unknown>;
  const key = isFileTreeSortKey(record.key) ? record.key : DEFAULT_FILE_TREE_SORT.key;
  return {
    key,
    direction: isFileTreeSortDirection(record.direction)
      ? record.direction
      : key === "date" ? "descending" : "ascending",
  };
}

/** 切换维度时采用惯用方向，重复选择当前维度时保留已有方向。 */
export function applyFileTreeSortChange(
  current: FileTreeSortSettings,
  change: FileTreeSortChange,
): FileTreeSortSettings {
  if ("key" in change) {
    return change.key === current.key ? { ...current } : {
      key: change.key,
      direction: change.key === "date" ? "descending" : "ascending",
    };
  }
  return { ...current, direction: change.direction };
}

/** 串行执行偏好写入；读取真值发生在出队时，写入失败仍交给当前调用者处理。 */
export function createFileTreeSortUpdater(
  readSettings: () => FileTreeSortSettings,
  writeSettings: (next: FileTreeSortSettings) => Promise<void>,
): (change: FileTreeSortChange) => Promise<void> {
  let queue: Promise<void> = Promise.resolve();
  return (change) => {
    const snapshot = { ...change };
    const write = queue.then(async () => {
      const current = readSettings();
      const next = applyFileTreeSortChange(current, snapshot);
      if (next.key === current.key && next.direction === current.direction) return;
      await writeSettings(next);
    });
    // 仅恢复后续队列，不吞掉返回给菜单的 write 拒绝。
    queue = write.catch(() => {});
    return write;
  };
}

const FILE_TREE_NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// 非有限、负值及缺失时间统一视为未知，避免比较器返回 NaN。
function modifiedMsOf(entry: ProjectFileEntry): number | null {
  const value = entry.modifiedMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function compareFileTreeEntries(
  left: ProjectFileEntry,
  right: ProjectFileEntry,
  settings: FileTreeSortSettings,
): number {
  // 目录始终排在同层文件之前，与后端 sort_file_entries 的约定保持一致。
  const leftDir = left.kind === "directory" ? 0 : 1;
  const rightDir = right.kind === "directory" ? 0 : 1;
  if (leftDir !== rightDir) return leftDir - rightDir;

  if (settings.key === "date") {
    const leftMs = modifiedMsOf(left);
    const rightMs = modifiedMsOf(right);
    // 未知时间在同类型条目内恒定后置；同时间按名称排序，避免刷新后顺序漂移。
    if (leftMs === null && rightMs !== null) return 1;
    if (rightMs === null && leftMs !== null) return -1;
    if (leftMs !== null && rightMs !== null && leftMs !== rightMs) {
      return settings.direction === "descending" ? rightMs - leftMs : leftMs - rightMs;
    }
  }

  const byName = FILE_TREE_NAME_COLLATOR.compare(left.name, right.name) || left.path.localeCompare(right.path);
  return settings.key === "name" && settings.direction === "descending" ? -byName : byName;
}

/**
 * 递归排序文件树：每层目录优先，目录内部再按当前维度排序。
 * 排序数组副本并重建已加载的非空子树；未加载的节点保持原引用。
 */
export function sortFileTreeEntries(
  entries: readonly ProjectFileEntry[],
  settings: FileTreeSortSettings,
): ProjectFileEntry[] {
  return [...entries]
    .sort((left, right) => compareFileTreeEntries(left, right, settings))
    .map((entry) => (
      entry.children && entry.children.length > 0
        ? { ...entry, children: sortFileTreeEntries(entry.children, settings) }
        : entry
    ));
}
