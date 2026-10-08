import { invoke } from "@tauri-apps/api/core";
import { webDeviceApi } from "../../../shared/lib/webDevice";

export const WEB_GIT_READ_KINDS = new Set([
  "git.repositories", "git.branches", "git.status", "git.diff", "git.history", "git.commit_detail", "git.commit_diff",
]);
type Payload = Record<string, unknown>;
type Repository = { relativePath: string; absolutePath: string; branch: string | null };
const repositories = new Map<string, { at: number; entries: Repository[] }>();

function invalid(): never { throw { code: "invalid_operation_payload", message: "Invalid Git read parameters" }; }

// 拒绝 Windows ADS、绝对路径及父级跳转，路径只接受仓库内 POSIX 相对形式。
function relative(value: unknown, empty = false): string {
  if (typeof value !== "string" || value.length > 4096 || /[\\:\x00-\x1f]/.test(value)
    || ((!empty || value !== "") && value.split("/").some((part) => !part || part === "." || part === ".."))) invalid();
  return value;
}

export function validateWebGitRead(kind: string, payload: Payload): void {
  if (!WEB_GIT_READ_KINDS.has(kind)) invalid();
  relative(payload.repository ?? "", true);
  if (payload.reference != null && (typeof payload.reference !== "string"
    || payload.reference.length > 256 || !payload.reference.length
    || payload.reference.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(payload.reference))) invalid();
  for (const field of ["cursor", "commitId"]) {
    const value = payload[field];
    if (value != null && (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value))) invalid();
  }
  if ((kind === "git.commit_detail" || kind === "git.commit_diff") && !payload.commitId) invalid();
  if (payload.search != null && (typeof payload.search !== "string" || payload.search.length > 256 || /[\x00-\x1f]/.test(payload.search))) invalid();
  if (kind === "git.diff" || kind === "git.commit_diff") {
    relative(payload.path);
    if (payload.oldPath != null) relative(payload.oldPath);
    if (payload.whitespace != null && !["exact", "ignore-eol", "ignore-all"].includes(String(payload.whitespace))) invalid();
    if (payload.contextLines != null && ![3, 10, 20].includes(payload.contextLines as number)) invalid();
    if (kind === "git.diff" && !["M", "A", "D", "R", "U", "??", "C"].includes(String(payload.status))) invalid();
  }
}

// 限深仓库枚举缓存只留在主机，浏览器永远拿不到 absolutePath。
async function listRepositories(root: string, force: boolean): Promise<Repository[]> {
  const cached = repositories.get(root);
  if (!force && cached && Date.now() - cached.at < 30_000) return cached.entries;
  const entries = await invoke<Repository[]>("git_list_repositories", { projectPath: root });
  repositories.delete(root);
  repositories.set(root, { at: Date.now(), entries });
  while (repositories.size > 16) repositories.delete(repositories.keys().next().value!);
  return entries;
}

// 只发送安全错误码，不把本地路径或原始 Git stderr 暴露给远程浏览器。
function readError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error) throw error;
  const message = String(error);
  const code = /not_git_repository/.test(message) ? "not_git_repository"
    : /too_large/.test(message) ? "git_result_too_large"
      : /binary|二进制/.test(message) ? "git_binary_file" : "git_read_failed";
  throw { code, message: code };
}

export async function executeWebGitRead(kind: string, payload: Payload, root: string): Promise<unknown> {
  validateWebGitRead(kind, payload);
  try {
    if (kind === "git.repositories") {
      const entries = await listRepositories(root, true);
      return entries.map(({ relativePath, branch }) => ({ relativePath, branch }));
    }
    let projectPath = root;
    const repository = relative(payload.repository ?? "", true);
    if (repository) {
      const match = (await listRepositories(root, false)).find((entry) => entry.relativePath === repository);
      if (!match) throw { code: "git_repository_missing", message: "git_repository_missing" };
      projectPath = match.absolutePath;
    }
    // 命中枚举缓存也重新验证 canonical 路径，防止目录被换成越界链接。
    await webDeviceApi.validateContext(root, projectPath);
    if (kind === "git.status") {
      const [changes, branch] = await Promise.all([
        invoke("git_get_changes", { projectPath }), invoke("git_branch_status", { projectPath }),
      ]);
      return { changes, branch };
    }
    if (kind === "git.branches") return await invoke("git_list_branches", { projectPath });
    if (kind === "git.history") return await invoke("git_list_commits", {
      projectPath, cursor: payload.cursor ?? null, search: payload.search ?? null, reference: payload.reference ?? null, filters: null,
    });
    if (kind === "git.commit_detail") return await invoke("git_get_commit_detail", { projectPath, commitId: payload.commitId });
    return await invoke(kind === "git.diff" ? "git_get_file_diff" : "git_get_commit_file_diff", {
      projectPath, filePath: payload.path, status: payload.status, commitId: payload.commitId,
      oldFilePath: payload.oldPath ?? null,
      options: { whitespace: payload.whitespace ?? "exact", contextLines: payload.contextLines ?? 3 },
    });
  } catch (error) { return readError(error); }
}
