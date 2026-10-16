import type { McpResource, McpResourceRedacted, McpTransport } from "../../../shared/types/extensions";
import { parseMcpEditorJson } from "./mcpJsonEditor";

export interface ArgumentRow { id: string; value: string; touched: boolean }
export interface KeyValueRow { id: string; key: string; value: string }
export interface TransportDraft {
  command: string; args: ArgumentRow[]; cwd: string; url: string;
  env: KeyValueRow[]; headers: KeyValueRow[];
}
export interface McpFormDraft {
  name: string;
  transport: McpTransport;
  fields: Record<McpTransport, TransportDraft>;
  snapshot: McpResource;
}
export interface FormIssue { field: string; code: "required" | "duplicate" | "keyRequired" | "secretMoved" | "urlInvalid" }

export const newArgumentRow = (value = "", touched = false): ArgumentRow => ({ id: crypto.randomUUID(), value, touched });
export const newKeyValueRow = (key = "", value = ""): KeyValueRow => ({ id: crypto.randomUUID(), key, value });
const emptyFields = (): TransportDraft => ({ command: "", args: [], cwd: "", url: "", env: [], headers: [] });
const mapRows = (map: Record<string, string>) => Object.entries(map).map(([key, value]) => newKeyValueRow(key, value));

/** 每种 transport 独立缓存；snapshot 只保存表单不拥有的扩展及身份字段。 */
export function createMcpFormDraft(resource: McpResource | McpResourceRedacted | null): McpFormDraft {
  const { redactedFields: _redacted, ...snapshot } = resource ?? {
    ...parseMcpEditorJson('{"mcpServers":{"untitled":{"command":""}}}', null), extra: {}, redactedFields: [],
  };
  const fields = { stdio: emptyFields(), streamableHttp: emptyFields(), sse: emptyFields() };
  fields[snapshot.transport] = {
    command: snapshot.command ?? "", args: snapshot.args.map(value => newArgumentRow(value, true)),
    cwd: snapshot.cwd ?? "", url: snapshot.url ?? "", env: mapRows(snapshot.env), headers: mapRows(snapshot.headers),
  };
  return { name: resource?.serverKey ?? "", transport: snapshot.transport, fields, snapshot };
}

/** 用路径和值共同判断未改的遮罩；新路径不得把后端遮罩作为真实密钥保存。 */
export function maskedValueMoved(resource: McpResource, original: McpResourceRedacted | null): boolean {
  const moved = (value: unknown, previous: unknown): boolean => {
    if (typeof value === "string") return (value.includes("[redacted]") || value === "***") && previous !== value;
    if (!value || typeof value !== "object") return false;
    const before = previous && typeof previous === "object" ? previous as Record<string, unknown> : {};
    return Object.entries(value).some(([key, child]) => moved(child, before[key]));
  };
  return moved(resource, original);
}

/** 比较语义内容而非临时行 id；只切换视图不会制造未保存更改。 */
export function mcpDraftFingerprint(draft: McpFormDraft): string {
  const fields = Object.fromEntries(Object.entries(draft.fields).map(([transport, value]) => [transport, {
    ...value, args: value.args.filter(row => row.touched || row.value).map(row => row.value),
    env: value.env.filter(row => row.key || row.value).map(({ key, value }) => [key, value]),
    headers: value.headers.filter(row => row.key || row.value).map(({ key, value }) => [key, value]),
  }]));
  return JSON.stringify({ resource: mcpFormResource(draft), fields });
}

/** 完全空行省略，显式空值保留；header 去重忽略大小写，env 保持大小写。 */
export function validateRows(rows: KeyValueRow[], group: "env" | "headers"): FormIssue[] {
  const used = new Set<string>();
  return rows.flatMap<FormIssue>(row => {
    const field = `${group}-${row.id}`;
    if (!row.key && row.value) return [{ field, code: "keyRequired" as const }];
    if (!row.key) return [];
    const key = group === "headers" ? row.key.toLowerCase() : row.key;
    if (used.has(key)) return [{ field, code: "duplicate" as const }];
    used.add(key);
    return [];
  });
}

export function validateMcpForm(draft: McpFormDraft, original: McpResourceRedacted | null, required = true): FormIssue[] {
  const fields = draft.fields[draft.transport];
  const issues = [...validateRows(fields.env, "env"), ...validateRows(fields.headers, "headers")];
  if (required) {
    if (!draft.name.trim()) issues.push({ field: "name", code: "required" });
    if (draft.transport === "stdio" && !fields.command.trim()) issues.push({ field: "command", code: "required" });
    if (draft.transport !== "stdio") {
      try {
        const url = new URL(fields.url);
        if (!["http:", "https:"].includes(url.protocol) || /[<>{}]/.test(fields.url)) throw new Error();
      } catch { issues.push({ field: "url", code: fields.url ? "urlInvalid" : "required" }); }
    }
  }
  for (const group of ["env", "headers"] as const) for (const row of fields[group]) {
    if ((row.value.includes("[redacted]") || row.value === "***") && original?.[group][row.key] !== row.value) {
      issues.push({ field: `${group}-${row.id}`, code: "secretMoved" });
    }
  }
  return issues;
}

/** 只投影当前方式，其他方式的草稿保留在内存，不进入 IPC。 */
export function mcpFormResource(draft: McpFormDraft): McpResource {
  const fields = draft.fields[draft.transport];
  const name = draft.name.trim();
  return {
    ...draft.snapshot, serverKey: name,
    name: name === draft.snapshot.serverKey ? draft.snapshot.name : name,
    transport: draft.transport,
    command: draft.transport === "stdio" ? fields.command : null,
    args: draft.transport === "stdio" ? fields.args.filter(row => row.touched || row.value !== "").map(row => row.value) : [],
    cwd: draft.transport === "stdio" ? fields.cwd || null : null,
    url: draft.transport === "stdio" ? null : fields.url,
    env: Object.fromEntries(fields.env.filter(row => row.key).map(row => [row.key, row.value])),
    headers: draft.transport === "stdio" ? {} : Object.fromEntries(fields.headers.filter(row => row.key).map(row => [row.key, row.value])),
  };
}

/** JSON 是显式替换当前方式；隐藏方式缓存可恢复，但删除的扩展字段不复活。 */
export function mergeMcpJsonDraft(previous: McpFormDraft, resource: McpResource): McpFormDraft {
  const next = createMcpFormDraft(resource);
  return { ...next, fields: { ...previous.fields, [next.transport]: next.fields[next.transport] } };
}
