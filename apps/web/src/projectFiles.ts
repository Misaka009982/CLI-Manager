import type { JsonObject, JsonValue, ProjectContext } from "./domain";
import { createRequestId } from "./requestId";
import { webClient } from "./webClient";

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
  if (!context.projectId) throw new Error("project_not_found");
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  bounded.throwIfAborted();
  const payload: JsonObject = { projectId: context.projectId };
  if (context.worktreeId) payload.worktreeId = context.worktreeId;
  if (kind === "file.search") payload.query = value;
  else payload.path = value;
  let { operation } = await client.createOperation({ deviceId, kind, payload, idempotencyKey: createRequestId() }, bounded);
  const startedAt = performance.now();
  while (true) {
    bounded.throwIfAborted();
    if (operation.status === "succeeded") return operation.result;
    if (["failed", "rejected", "timed_out", "canceled"].includes(operation.status)) {
      throw new Error(operation.error?.code ?? "file_read_failed");
    }
    // Fast initial completion avoids a guaranteed 400 ms pause per folder.
    // Back off for long-running host operations to bound polling traffic.
    const elapsed = performance.now() - startedAt;
    await delay(bounded, elapsed < 1_000 ? 100 : elapsed < 3_000 ? 250 : 500);
    ({ operation } = await client.operation(operation.id, bounded));
  }
}
