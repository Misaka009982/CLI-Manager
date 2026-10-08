import type { JsonObject, JsonValue, Operation, ProjectContext } from "./domain";
import { createRequestId } from "./requestId";
import { webClient } from "./webClient";
import { isFileOperationComplete, subscribeFileOperation } from "./fileOperationEvents";

export type FileEntry = { name: string; path: string; kind: "file" | "directory" };
export type FileReadKind = "file.list" | "file.search" | "file.read_text" | "file.read_image";
const READ_KINDS = new Set<string>(["file.list", "file.search", "file.read_text", "file.read_image"]);

export function parseFileEntries(value: JsonValue): FileEntry[] {
  if (!Array.isArray(value)) throw new Error("invalid_file_result");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      typeof entry.name !== "string" || typeof entry.path !== "string" ||
      (entry.kind !== "file" && entry.kind !== "directory")) throw new Error("invalid_file_result");
    return { name: entry.name, path: entry.path, kind: entry.kind } as FileEntry;
  }).filter((entry) => entry.name !== ".git")
    .sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
}

export function parseFilePreview(value: JsonValue, image: boolean): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_file_result");
  if (!image && typeof value.content === "string") return value.content;
  if (image && typeof value.mimeType === "string" && /^image\/(png|jpeg|gif|webp|bmp|x-icon|vnd.microsoft.icon|svg\+xml)$/.test(value.mimeType) &&
    typeof value.dataBase64 === "string" && /^[A-Za-z0-9+/=\r\n]+$/.test(value.dataBase64)) {
    return `data:${value.mimeType};base64,${value.dataBase64}`;
  }
  throw new Error("invalid_file_result");
}

function delay(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

// Capture identity before dispatch; the existing host validates ownership and paths.
export async function readProjectFiles(
  deviceId: string, context: ProjectContext, kind: FileReadKind, value: string,
  signal: AbortSignal, client = webClient, timeoutMs = 30_000,
): Promise<JsonValue> {
  if (!READ_KINDS.has(kind)) throw new Error("unsupported_operation_kind");
  return readProjectOperation(deviceId, context, kind,
    kind === "file.search" ? { query: value } : { path: value }, signal, client, timeoutMs);
}

// 文件与只读 Git 共用事件优先/轮询恢复链路；身份覆盖调用方参数，禁止传入 cwd。
export async function readProjectOperation(
  deviceId: string, context: ProjectContext, kind: string, parameters: JsonObject,
  signal: AbortSignal, client = webClient, timeoutMs = 30_000,
): Promise<JsonValue> {
  if (!READ_KINDS.has(kind) && !["git.repositories", "git.branches", "git.status", "git.diff", "git.history", "git.commit_detail", "git.commit_diff"].includes(kind)) {
    throw new Error("unsupported_operation_kind");
  }
  if (!context.projectId) throw new Error("project_not_found");
  const finished = new AbortController();
  const bounded = AbortSignal.any([signal, finished.signal, AbortSignal.timeout(timeoutMs)]);
  bounded.throwIfAborted();
  const payload: JsonObject = { ...parameters, projectId: context.projectId };
  delete payload.cwd;
  delete payload.rootPath;
  delete payload.worktreeId;
  if (context.worktreeId) payload.worktreeId = context.worktreeId;
  const idempotencyKey = createRequestId();
  let unsubscribe = () => {};
  let removeAbort = () => {};
  const notification = new Promise<Operation>((resolve, reject) => {
    unsubscribe = subscribeFileOperation(idempotencyKey, deviceId, kind, resolve);
    const abort = () => reject(bounded.reason);
    bounded.addEventListener("abort", abort, { once: true });
    removeAbort = () => bounded.removeEventListener("abort", abort);
  });
  const poll = async () => {
    let { operation } = await client.createOperation({ deviceId, kind, payload, idempotencyKey }, bounded);
    const startedAt = performance.now();
    while (!isFileOperationComplete(operation)) {
      // WebSocket normally completes immediately; polling recovers lost events/reconnects.
      await delay(bounded, performance.now() - startedAt < 3_000 ? 500 : 1_000);
      ({ operation } = await client.operation(operation.id, bounded));
    }
    return operation;
  };
  try {
    const operation = await Promise.race([notification, poll()]);
    bounded.throwIfAborted();
    if (operation.status !== "succeeded") throw new Error(operation.error?.code ?? "file_read_failed");
    return operation.result;
  } finally {
    unsubscribe();
    removeAbort();
    finished.abort();
  }
}
