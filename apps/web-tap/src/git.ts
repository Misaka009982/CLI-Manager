import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { JsonObject, JsonValue } from "./protocol";

export type GitChange = { path: string; status: string; added: number; deleted: number; staged: boolean };
export type GitSummary = {
  branch: string | null; ahead: number; behind: number;
  changes: GitChange[]; files: number; added: number; deleted: number;
};
/** `summary` is null until the first read; `repo` is false when the folder is not a Git repository. */
export type GitState = { summary: GitSummary | null; repo: boolean; loading: boolean; failed: boolean };
type Run = (kind: string, payload: JsonObject) => Promise<JsonValue>;
type Entry = { state: GitState; listeners: Set<() => void>; flight?: Promise<void>; readAt: number };

const IDLE: GitState = { summary: null, repo: true, loading: false, failed: false };
const entries = new Map<string, Entry>();
const object = (value: JsonValue | undefined): JsonObject | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;

/** Narrow the host's `git.status` result; unexpected rows are skipped, never shown. */
export function parseGitStatus(value: JsonValue): GitSummary | null {
  const result = object(value);
  if (!result || !Array.isArray(result.changes)) return null;
  const branch = object(result.branch);
  const changes: GitChange[] = [];
  for (const item of result.changes) {
    const change = object(item);
    if (!change || typeof change.path !== "string" || typeof change.status !== "string") continue;
    changes.push({
      path: change.path, status: change.status, staged: change.staged === true,
      added: typeof change.added === "number" ? change.added : 0,
      deleted: typeof change.deleted === "number" ? change.deleted : 0,
    });
  }
  return {
    branch: typeof branch?.branch === "string" && branch.branch ? branch.branch : null,
    ahead: typeof branch?.ahead === "number" ? branch.ahead : 0,
    behind: typeof branch?.behind === "number" ? branch.behind : 0,
    changes,
    files: new Set(changes.map((change) => change.path)).size,
    added: changes.reduce((total, change) => total + change.added, 0),
    deleted: changes.reduce((total, change) => total + change.deleted, 0),
  };
}

const entry = (key: string) => {
  let found = entries.get(key);
  if (!found) { found = { state: IDLE, listeners: new Set(), readAt: 0 }; entries.set(key, found); }
  return found;
};
const publish = (item: Entry, state: GitState) => { item.state = state; for (const listener of item.listeners) listener(); };

/** One read per context at a time; header, dock and side panel share the result. */
function read(key: string, run: Run, context: JsonObject) {
  const item = entry(key);
  if (item.flight) return item.flight;
  publish(item, { ...item.state, loading: true });
  item.flight = run("git.status", context).then(
    (value) => {
      const summary = parseGitStatus(value);
      publish(item, { summary, repo: true, loading: false, failed: summary === null });
    },
    (error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") { publish(item, { ...item.state, loading: false }); return; }
      const missing = error instanceof Error && error.message === "not_git_repository";
      publish(item, { summary: missing ? null : item.state.summary, repo: !missing, loading: false, failed: !missing });
    },
  ).finally(() => { item.flight = undefined; item.readAt = Date.now(); });
  return item.flight;
}

/** Forget every cached status, e.g. after signing out. */
export function clearGit() { entries.clear(); }

/**
 * Branch and +N −M for a session's project. Reads when a consumer becomes active, when the page is shown
 * again and on explicit refresh. There is no polling timer: every read is a host operation.
 */
export function useGit(key: string | undefined, context: JsonObject, run: Run, active: boolean) {
  const subscribe = useCallback((listener: () => void) => {
    if (!key) return () => {};
    const item = entry(key);
    item.listeners.add(listener);
    return () => { item.listeners.delete(listener); };
  }, [key]);
  const state = useSyncExternalStore(subscribe, () => (key ? entry(key).state : IDLE));
  const latest = useRef({ context, run });
  latest.current = { context, run };
  const refresh = useCallback(() => {
    if (key && latest.current.context.projectId) void read(key, latest.current.run, latest.current.context);
  }, [key]);
  useEffect(() => {
    if (!active || !key) return;
    if (Date.now() - entry(key).readAt > 5_000) refresh();
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [active, key, refresh]);
  return { ...state, refresh };
}

/** Cache key shared by every view of one account/device/project context. */
export const gitKey = (user: string | undefined, device: string | undefined, projectId: string, worktreeId: string | null) =>
  JSON.stringify([user, device, projectId, worktreeId]);
