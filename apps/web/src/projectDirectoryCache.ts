import type { ProjectContext } from "./domain";
import type { FileEntry } from "./projectFiles";

export function directoryScope(deviceId: string, context: ProjectContext): string {
  return JSON.stringify([deviceId, context.projectId, context.worktreeId ?? null, context.cwd]);
}

type CachedDirectory = { scope: string; entries: FileEntry[]; savedAt: number; bytes: number; stale?: boolean };
type Invalidation = { scope?: string; deviceId?: string; reload: boolean; error?: Error };

export function createDirectoryCache({
  now = Date.now, freshMs = 30_000, maxAgeMs = 600_000, maxDirectories = 96, maxBytes = 4 * 1024 * 1024,
} = {}) {
  const records = new Map<string, CachedDirectory>();
  const listeners = new Set<(event: Invalidation) => void>();
  let bytes = 0;
  let version = 0;
  const keyFor = (scope: string, path: string) => JSON.stringify([scope, path]);
  const remove = (key: string) => {
    bytes -= records.get(key)?.bytes ?? 0;
    records.delete(key);
  };
  return {
    get version() { return version; },
    get(scope: string, path: string) {
      const key = keyFor(scope, path);
      const record = records.get(key);
      if (!record) return undefined;
      const age = now() - record.savedAt;
      if (age >= maxAgeMs || age < 0) { remove(key); return undefined; }
      records.delete(key);
      records.set(key, record);
      return { entries: record.entries, fresh: !record.stale && age < freshMs };
    },
    put(scope: string, path: string, entries: FileEntry[], expectedVersion: number) {
      if (expectedVersion !== version) return;
      const key = keyFor(scope, path);
      remove(key);
      // Approximate UTF-16 strings and object overhead, including the retained key.
      const size = key.length * 2 + 128 + entries.reduce((total, entry) =>
        total + 128 + (entry.name.length + entry.path.length + entry.kind.length) * 2, 0);
      if (size > maxBytes) return;
      records.set(key, { scope, entries, savedAt: now(), bytes: size });
      bytes += size;
      while (records.size > maxDirectories || bytes > maxBytes) remove(records.keys().next().value!);
    },
    clear(scope?: string, error?: Error) {
      version++;
      for (const [key, record] of records) if (scope === undefined || record.scope === scope) remove(key);
      for (const listener of listeners) listener({ scope, reload: false, error });
    },
    clearDevice(deviceId: string) {
      version++;
      for (const [key, record] of records) if (JSON.parse(record.scope)[0] === deviceId) remove(key);
      for (const listener of listeners) listener({ deviceId, reload: false });
    },
    invalidate() {
      version++;
      for (const record of records.values()) record.stale = true;
      for (const listener of listeners) listener({ reload: true });
    },
    subscribe(listener: (event: Invalidation) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

// Memory only: no directory names or file contents are persisted in browser storage.
export const projectDirectoryCache = createDirectoryCache();
