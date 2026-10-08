import type { ProjectContext } from "./domain";
import { parseFileEntries, readProjectFiles, type FileEntry } from "./projectFiles";
import { directoryScope, projectDirectoryCache } from "./projectDirectoryCache";

type Snapshot = {
  directories: ReadonlyMap<string, FileEntry[]>;
  pending: ReadonlySet<string>;
  loading: ReadonlySet<string>;
  errors: ReadonlyMap<string, unknown>;
};
type Job = { path: string; background: boolean; controller: AbortController; timer?: ReturnType<typeof setTimeout> };

// A panel owns its request lifetime; completed directories survive panel unmount in the cache.
export function createProjectDirectorySession(
  deviceId: string, context: ProjectContext, reader = readProjectFiles, cache = projectDirectoryCache,
) {
  const identity = { ...context };
  const scope = directoryScope(deviceId, identity);
  const cachedRoot = cache.get(scope, "");
  let snapshot: Snapshot = {
    directories: new Map(cachedRoot ? [["", cachedRoot.entries]] : []),
    pending: new Set(), loading: new Set(), errors: new Map(),
  };
  const listeners = new Set<() => void>();
  let unsubscribeCache: (() => void) | undefined;
  const jobs = new Map<string, Job>();
  let queue: Job[] = [];
  let active = 0;
  let intentTimer: ReturnType<typeof setTimeout> | undefined;
  const prefetched = new Set<string>();

  const publish = (change: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) listener();
  };
  const pump = () => {
    while (active < 2 && queue.length) {
      const job = queue.shift()!;
      if (job.controller.signal.aborted) continue;
      active++;
      void execute(job);
    }
  };
  const execute = async (job: Job) => {
    const version = cache.version;
    try {
      const result = await reader(deviceId, identity, "file.list", job.path, job.controller.signal);
      if (job.controller.signal.aborted || jobs.get(job.path) !== job) return;
      const entries = parseFileEntries(result);
      cache.put(scope, job.path, entries, version);
      const directories = new Map(snapshot.directories);
      directories.set(job.path, entries);
      publish({ directories });
    } catch (error) {
      if (!job.controller.signal.aborted && jobs.get(job.path) === job) {
        const errors = new Map(snapshot.errors);
        errors.set(job.path, error);
        publish({ errors });
      }
    } finally {
      clearTimeout(job.timer);
      active--;
      if (jobs.get(job.path) === job) {
        jobs.delete(job.path);
        const pending = new Set(snapshot.pending);
        const loading = new Set(snapshot.loading);
        pending.delete(job.path); loading.delete(job.path);
        publish({ pending, loading });
      }
      pump();
    }
  };
  const load = (path: string, background = false) => {
    const existing = jobs.get(path);
    if (existing) {
      // 点击已预取的目录时提升为前台请求，保留同一网络操作。
      if (!background && existing.background) {
        existing.background = false;
        // 预取的加载计时器可能已结束；用户主动打开后仍需在慢请求时得到反馈。
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => {
          if (jobs.get(path) === existing && !snapshot.directories.has(path)) {
            publish({ loading: new Set([...snapshot.loading, path]) });
          }
        }, 150);
      }
      return;
    }
    const cached = cache.get(scope, path);
    const errors = new Map(snapshot.errors);
    errors.delete(path);
    const directories = new Map(snapshot.directories);
    if (cached) directories.set(path, cached.entries);
    publish({ directories, errors });
    if (cached?.fresh) return;
    const job: Job = { path, background, controller: new AbortController() };
    jobs.set(path, job);
    publish({ pending: new Set([...snapshot.pending, path]) });
    job.timer = setTimeout(() => {
      if (!job.background && !job.controller.signal.aborted && jobs.get(path) === job && !snapshot.directories.has(path)) {
        publish({ loading: new Set([...snapshot.loading, path]) });
      }
    }, 150);
    queue.push(job);
    pump();
  };
  const stop = () => {
    clearTimeout(intentTimer);
    for (const job of jobs.values()) {
      clearTimeout(job.timer);
      job.controller.abort();
    }
    jobs.clear();
    queue = [];
    publish({ pending: new Set(), loading: new Set() });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      unsubscribeCache ??= cache.subscribe((event) => {
        if (event.scope !== undefined && event.scope !== scope) return;
        if (event.deviceId !== undefined && event.deviceId !== deviceId) return;
        const paths = new Set(["", ...snapshot.directories.keys(), ...snapshot.pending]);
        stop();
        publish({ errors: new Map(event.error ? [["", event.error]] : []), ...(!event.reload ? { directories: new Map() } : {}) });
        if (event.reload) for (const path of paths) load(path);
      });
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { unsubscribeCache?.(); unsubscribeCache = undefined; }
      };
    },
    load,
    // 悬停/聚焦才预取；仅空闲时执行，每个面板最多六个目录，不递归。
    prefetch(path: string) {
      clearTimeout(intentTimer);
      if (prefetched.size >= 6 || prefetched.has(path) || cache.get(scope, path)?.fresh) return;
      intentTimer = setTimeout(() => {
        if (active || queue.length || jobs.has(path)) return;
        prefetched.add(path);
        load(path, true);
      }, 180);
    },
    cancelPrefetch() { clearTimeout(intentTimer); },
    stop,
    refresh() {
      stop();
      cache.clear(scope);
      publish({ directories: new Map(), errors: new Map() });
      load("");
    },
  };
}
