import type { TranslationKey } from "../../../shared/i18n/index";
import { HISTORY_SOURCE_DESCRIPTOR_BY_ID, type HistorySourceId } from "../../../shared/lib/historySources";
import type { HistorySessionView } from "../../../shared/types/index";
import { inferSubagentParentSessionId } from "./historySubagents";

export type HistoryDeletionBlockReason =
  | "history_remote_read_only"
  | "unsupported_history_mutation_source"
  | "history_subagent_mutation_not_allowed";

export interface HistoryDeletionPlan {
  sessionKeys: string[];
  blockedReason: HistoryDeletionBlockReason | null;
}

export type HistoryDeletionCandidate = Pick<HistorySessionView,
  "sessionKey" | "source" | "project_key" | "file_path" | "favoriteSnapshot" | "read_only" | "session_ref">;

// 远程/只读优先；本地收藏快照仅删除应用副本，不依赖原始来源的写入能力。
export function getHistoryDeletionBlockReason(session: HistorySessionView): HistoryDeletionBlockReason | null {
  if (session.session_ref?.transportKind === "ssh" || session.read_only) return "history_remote_read_only";
  if (session.favoriteSnapshot) return null;
  const source = session.source.trim().toLowerCase() as HistorySourceId;
  if (HISTORY_SOURCE_DESCRIPTOR_BY_ID.get(source)?.capabilities.delete !== "supported") {
    return "unsupported_history_mutation_source";
  }
  if (/\/subagents\/agent-[^/]+\.jsonl$/i.test(deletionPath(session.file_path))
    || (source !== "codex" && inferSubagentParentSessionId(session) !== null)) {
    return "history_subagent_mutation_not_allowed";
  }
  return null;
}

// Store 和确认后的批量执行均复查资格；过期条目不能被计为删除成功。
export function assertHistorySessionDeletable(session: HistorySessionView | undefined): asserts session is HistorySessionView {
  const reason = session ? getHistoryDeletionBlockReason(session) : "history_session_not_found";
  if (reason) throw new Error(reason);
}

// 比较实际文件位置时统一 Windows 前缀及 WSL 主机别名，保留 Linux 路径的大小写。
function deletionPath(value: string): string {
  const path = value.trim().replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "");
  const wsl = /^\/\/(?:wsl\$|wsl\.localhost)\/([^/]+)(\/.*)$/i.exec(path);
  if (wsl) return `//wsl/${wsl[1].toLowerCase()}${wsl[2]}`;
  return /^[a-z]:\//i.test(path) || path.startsWith("//") ? path.toLowerCase() : path;
}

// Codex 只相信后台实际删除路径；Claude 保留既有目录语义，其余来源/快照仅清理目标。
export function historyDeletedSessionKeys(
  target: HistorySessionView,
  sessions: readonly HistoryDeletionCandidate[],
  deletedPaths?: readonly string[] | null,
): Set<string> {
  const keys = new Set([target.sessionKey]);
  const source = target.source.trim().toLowerCase();
  if (target.favoriteSnapshot || (source !== "claude" && source !== "codex")) return keys;
  if (source === "codex") {
    const deleted = new Set((deletedPaths ?? []).map(deletionPath));
    for (const item of sessions) {
      if (item.favoriteSnapshot || item.read_only || item.session_ref?.transportKind === "ssh") continue;
      if (item.source.trim().toLowerCase() === source && deleted.has(deletionPath(item.file_path))) {
        keys.add(item.sessionKey);
      }
    }
    return keys;
  }
  const path = deletionPath(target.file_path);
  const directoryEnd = path.lastIndexOf("/");
  if (directoryEnd < 0) return keys;
  const childDirectory = `${path.slice(0, directoryEnd)}/subagents/`;
  for (const item of sessions) {
    if (item.favoriteSnapshot || item.read_only || item.session_ref?.transportKind === "ssh") continue;
    if (item.source.trim().toLowerCase() !== source || item.project_key !== target.project_key) continue;
    const childPath = deletionPath(item.file_path);
    if (childPath.startsWith(childDirectory) && /^agent-[^/]+\.jsonl$/.test(childPath.slice(childDirectory.length))) {
      keys.add(item.sessionKey);
    }
  }
  return keys;
}

// 批量选择中的子代理只有确实随已选父项删除时才合并，其他不可删项阻止整批执行。
export function planHistoryDeletion(selected: readonly HistorySessionView[]): HistoryDeletionPlan {
  const unique = [...new Map(selected.map((item) => [item.sessionKey, item])).values()];
  const targets = unique.filter((item) => getHistoryDeletionBlockReason(item) === null);
  const covered = new Set(targets.flatMap((target) => [...historyDeletedSessionKeys(target, unique)]));
  for (const item of unique) {
    const reason = getHistoryDeletionBlockReason(item);
    if (reason && !(reason === "history_subagent_mutation_not_allowed" && covered.has(item.sessionKey))) {
      return { sessionKeys: [], blockedReason: reason };
    }
  }
  return { sessionKeys: targets.map((item) => item.sessionKey), blockedReason: null };
}

// 整批预检；只合并后台已确认覆盖的项，真实失败停止并报告已完成的选择数。
export async function executeHistoryDeletion(
  sessionKeys: readonly string[],
  getSessions: () => readonly HistorySessionView[],
  deleteSession: (sessionKey: string) => Promise<readonly string[] | void>,
): Promise<{ deletedCount: number; error: unknown | null }> {
  let deletedCount = 0;
  try {
    const current = new Map(getSessions().map((item) => [item.sessionKey, item]));
    for (const key of sessionKeys) assertHistorySessionDeletable(current.get(key));
    const covered = new Set<string>();
    for (const key of sessionKeys) {
      if (!covered.has(key)) {
        const deletedKeys = await deleteSession(key);
        for (const deletedKey of deletedKeys ?? []) covered.add(deletedKey);
      }
      deletedCount += 1;
    }
    return { deletedCount, error: null };
  } catch (error) {
    return { deletedCount, error };
  }
}

// 稳定错误码只用于选择双语文案，其余文件/数据库错误保留原始诊断。
export function historyDeletionErrorKey(error: unknown): TranslationKey | null {
  const message = error instanceof Error ? error.message : String(error);
  const keys: Record<string, TranslationKey> = {
    history_remote_read_only: "history.delete.readOnly",
    unsupported_history_mutation_source: "history.delete.unsupported",
    history_subagent_mutation_not_allowed: "history.delete.subagent",
    history_session_not_found: "history.delete.missing",
    history_source_manual_recovery_required: "history.delete.recoveryRequired",
    history_codex_deletion_ambiguous: "history.delete.codexAmbiguous",
    history_codex_deletion_metadata_invalid: "history.delete.codexInvalidMetadata",
    history_codex_deletion_inventory_incomplete: "history.delete.codexIncomplete",
  };
  return Object.entries(keys).find(([code]) => message.includes(code))?.[1] ?? null;
}
