import type { TerminalSession } from "../../../shared/types/index";

// 旧托管进程可能仍由外部运行，快照只备份不自动重启，避免同时操作同一 CLI 会话。
export function partitionRetiredSessions(sessions: TerminalSession[]) {
  const retained: TerminalSession[] = [];
  const retired: TerminalSession[] = [];
  for (const session of sessions) {
    const legacy = session as TerminalSession & { remoteHandoff?: unknown };
    (legacy.remoteHandoff ? retired : retained).push(session);
  }
  return { sessions: retained, retired };
}

// 备份成功但主快照尚未保存时可能重启；相同完整记录只保留一次，不覆盖不同历史。
export function mergeRetiredSessionBackup(previous: unknown[], incoming: TerminalSession[]): unknown[] {
  const result = [...previous];
  const saved = new Set(previous.map((record) => JSON.stringify(record)));
  for (const record of incoming) {
    const key = JSON.stringify(record);
    if (saved.has(key)) continue;
    result.push(record);
    saved.add(key);
  }
  return result;
}
