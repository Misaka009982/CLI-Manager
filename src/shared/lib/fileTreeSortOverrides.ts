import { applyFileTreeSortChange, type FileTreeSortChange, type FileTreeSortSettings } from "./fileTreeSort.ts";

export type FolderTreeSortRules = Record<string, FileTreeSortSettings>;
export type FileTreeSortOverrides = Record<string, FolderTreeSortRules>;
export interface FileTreeSortScope { key: string; ignoreCase: boolean }
export interface FileTreeSortPreferences {
  fileTreeSort: FileTreeSortSettings;
  fileTreeSortOverrides: FileTreeSortOverrides;
}
export interface ResolvedFolderTreeSort {
  settings: FileTreeSortSettings;
  sourcePath: string | null;
  explicit: boolean;
}

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const validText = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= 32768 && !/[\u0000-\u001f\u007f]/u.test(value);

/** 作用域由文件功能域生成；共享偏好只验证身份形状，不加载功能域。 */
export function parseFileTreeSortScope(key: string): FileTreeSortScope | null {
  if (!validText(key)) return null;
  try {
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts) || parts.length !== 3 || !parts.every(validText)) return null;
    const [projectId, environment, root] = parts as string[];
    if (!["local", "wsl", "ssh"].includes(environment) || JSON.stringify([projectId, environment, root]) !== key) return null;
    if (environment === "ssh") {
      const remote: unknown = JSON.parse(root);
      if (!Array.isArray(remote) || remote.length !== 3 || remote[0] !== "ssh" || !remote.every(validText)) return null;
    }
    const wsl = /^\/\/wsl(?:\$|\.localhost)\//i.test(root);
    const ignoreCase = environment === "local" && !wsl && (/^[a-z]:(?:\/|$)/i.test(root) || root.startsWith("//"));
    return { key, ignoreCase };
  } catch {
    return null;
  }
}

/** 只接受目录相对路径；Linux 的反斜杠是文件名字符，不按 Windows 分隔符处理。 */
export function normalizeFileTreeSortPath(path: string, ignoreCase = false): string | null {
  if (!validText(path)) return null;
  const normalized = ignoreCase ? path.replace(/\\/g, "/").toLowerCase() : path;
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) return null;
  const segments = normalized.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".." || UNSAFE_KEYS.has(segment))) return null;
  return normalized;
}

function isSortSettings(value: unknown): value is FileTreeSortSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return hasOwn(record, "key") && hasOwn(record, "direction")
    && (record.key === "name" || record.key === "date")
    && (record.direction === "ascending" || record.direction === "descending");
}

/** 覆盖表不能用默认值修补非法条目，否则损坏记录会意外截断继承。 */
export function migrateFileTreeSortOverrides(value: unknown): FileTreeSortOverrides {
  const next: FileTreeSortOverrides = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return next;
  for (const [key, rawRules] of Object.entries(value)) {
    const scope = parseFileTreeSortScope(key);
    if (!scope || !rawRules || typeof rawRules !== "object" || Array.isArray(rawRules)) continue;
    const rules: FolderTreeSortRules = {};
    for (const [path, rule] of Object.entries(rawRules)) {
      const normalized = normalizeFileTreeSortPath(path, scope.ignoreCase);
      if (normalized && isSortSettings(rule)) rules[normalized] = { key: rule.key, direction: rule.direction };
    }
    if (Object.keys(rules).length) next[key] = rules;
  }
  return next;
}

/** 显示和更新共用最近祖先查找；逐段回退保证 src 不会覆盖 src2。 */
export function resolveFolderTreeSort(
  rules: FolderTreeSortRules | undefined,
  path: string,
  fallback: FileTreeSortSettings,
  ignoreCase = false,
): ResolvedFolderTreeSort {
  const normalized = normalizeFileTreeSortPath(path, ignoreCase);
  let candidate = normalized;
  while (candidate) {
    if (rules && hasOwn(rules, candidate)) {
      return { settings: rules[candidate], sourcePath: candidate, explicit: candidate === normalized };
    }
    const separator = candidate.lastIndexOf("/");
    candidate = separator < 0 ? null : candidate.slice(0, separator);
  }
  return { settings: fallback, sourcePath: null, explicit: false };
}

/** 所有排序菜单共用此队列，保存后才由原 Settings store 发布新真值。 */
export function createFileTreeSortPreferencesUpdater(
  read: () => FileTreeSortPreferences,
  writeGlobal: (next: FileTreeSortSettings) => Promise<void>,
  writeOverrides: (next: FileTreeSortOverrides) => Promise<void>,
) {
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (operation: () => Promise<void>) => {
    const write = queue.then(operation);
    queue = write.catch(() => {});
    return write;
  };
  return {
    updateGlobal(change: FileTreeSortChange): Promise<void> {
      const snapshot = { ...change };
      return enqueue(async () => {
        const current = read().fileTreeSort;
        const next = applyFileTreeSortChange(current, snapshot);
        if (next.key !== current.key || next.direction !== current.direction) await writeGlobal(next);
      });
    },
    updateFolder(scope: FileTreeSortScope, path: string, change: FileTreeSortChange | null): Promise<void> {
      const key = scope.key;
      const target = parseFileTreeSortScope(key);
      const normalized = target && normalizeFileTreeSortPath(path, target.ignoreCase);
      const snapshot = change === null ? null : { ...change };
      return enqueue(async () => {
        if (!target || !normalized) throw new Error("invalid_file_tree_sort_target");
        const current = read();
        const rules = current.fileTreeSortOverrides[key] ?? {};
        const existing = hasOwn(rules, normalized) ? rules[normalized] : undefined;
        if (snapshot === null && !existing) return;
        const nextRules = { ...rules };
        if (snapshot === null) {
          delete nextRules[normalized];
        } else {
          const effective = resolveFolderTreeSort(rules, normalized, current.fileTreeSort).settings;
          const next = applyFileTreeSortChange(effective, snapshot);
          if (existing && existing.key === next.key && existing.direction === next.direction) return;
          nextRules[normalized] = next;
        }
        const nextOverrides = { ...current.fileTreeSortOverrides };
        if (Object.keys(nextRules).length) nextOverrides[key] = nextRules;
        else delete nextOverrides[key];
        await writeOverrides(nextOverrides);
      });
    },
  };
}
