import type { JsonValue } from "./domain";
import type { TranslationKey } from "./i18n";

export type GitRepository = { relativePath: string; branch: string | null };
export type GitChange = { path: string; status: string; staged: boolean; added: number; deleted: number };
export type GitCommit = { id: string; shortId: string; title: string; authorName: string; authoredAt: number;
  parents: string[]; refs: string[]; authorEmail: string | null };
export type GitBranch = { name: string; branchType: "local" | "remote"; current: boolean };
export type GitPage = { commits: GitCommit[]; nextCursor: string | null };
export type GitDetail = { commit: GitCommit; files: Array<GitChange & { oldPath: string | null; binary: boolean }> };
export type GitStatus = { changes: GitChange[]; branch: { branch: string | null; ahead: number; behind: number; detached: boolean } };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_git_result");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_git_result");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid_git_result");
  return value;
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("invalid_git_result");
  return value.map(parse);
}
function commit(value: unknown): GitCommit {
  const data = record(value);
  return { id: text(data.id), shortId: text(data.shortId), title: text(data.title),
    authorName: text(data.authorName), authoredAt: number(data.authoredAt),
    parents: list(data.parents ?? [], text), refs: list(data.refs ?? [], text),
    authorEmail: data.authorEmail == null ? null : text(data.authorEmail) };
}
function change(value: unknown): GitChange {
  const data = record(value);
  return { path: text(data.path), status: text(data.status), staged: data.staged === true,
    added: number(data.added), deleted: number(data.deleted) };
}

// 显式解析网络 DTO，错误响应不能伪装成空仓库或干净状态。
export function parseRepositories(value: JsonValue): GitRepository[] {
  return list(value, (item) => { const data = record(item);
    return { relativePath: text(data.relativePath), branch: data.branch == null ? null : text(data.branch) };
  });
}
export function parseGitStatus(value: JsonValue): GitStatus {
  const data = record(value), branch = record(data.branch);
  return { changes: list(data.changes, change), branch: {
    branch: branch.branch == null ? null : text(branch.branch), ahead: number(branch.ahead),
    behind: number(branch.behind), detached: branch.detached === true,
  } };
}
export function parseGitPage(value: JsonValue): GitPage {
  const data = record(value);
  return { commits: list(data.commits, commit), nextCursor: data.nextCursor == null ? null : text(data.nextCursor) };
}
export function parseGitDetail(value: JsonValue): GitDetail {
  const data = record(value);
  return { commit: commit(data.commit), files: list(data.files, (item) => {
    const file = record(item);
    return { ...change(file), oldPath: file.oldPath == null ? null : text(file.oldPath), binary: file.binary === true };
  }) };
}
export function parseGitDiff(value: JsonValue): string { return text(record(value).content); }

export function parseGitBranches(value: JsonValue): GitBranch[] {
  return list(value, (item) => {
    const data = record(item);
    if (data.branchType !== "local" && data.branchType !== "remote") throw new Error("invalid_git_result");
    return { name: text(data.name), branchType: data.branchType, current: data.current === true };
  });
}

export function gitReadError(error: unknown): TranslationKey {
  const code = error instanceof Error ? error.message : String(error);
  if (/session_expired/.test(code)) return "sessionExpired";
  if (/not_git_repository/.test(code)) return "gitNotRepository";
  if (/ssh_project_unsupported/.test(code)) return "gitSshUnsupported";
  if (/too_large|binary/.test(code)) return "gitDiffUnavailable";
  if (/unsupported_operation_kind|capability/.test(code)) return "gitUpgradeRequired";
  if (/device_offline/.test(code)) return "gitOffline";
  if (/project_not_found|worktree_missing|worktree_not_found|git_repository_missing/.test(code)) return "filesContextMissing";
  return "filesReadFailed";
}
