import type { McpResource, McpResourceRedacted } from "../../../shared/types/extensions";

const nativeFields = ["type", "command", "args", "cwd", "url", "env", "headers", "timeout", "secretRefs"];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function stringValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("extensions_json_string");
  return value;
}

function stringMap(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (!object(value)) throw new Error("extensions_json_map");
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new Error("extensions_json_string");
    Object.defineProperty(result, key, { value: item, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

/** Show only server configuration; identity, source and CLI selection stay out of editable JSON. */
export function mcpEditorJson(resource: McpResourceRedacted | null): string {
  if (!resource) return JSON.stringify({ mcpServers: { example: { command: "npx", args: ["-y", "package-name"] } } }, null, 2);
  const entry: Record<string, unknown> = { ...resource.perCliExtensions.claude };
  if (resource.transport !== "stdio") entry.type = resource.transport === "sse" ? "sse" : "http";
  for (const key of nativeFields.filter(key => key !== "type")) {
    const value = resource[key as keyof McpResourceRedacted];
    if (value != null && value !== "" && (!object(value) || Object.keys(value).length) && (!Array.isArray(value) || value.length)) entry[key] = value;
  }
  return JSON.stringify({ mcpServers: { [resource.serverKey]: entry } }, null, 2);
}

/** One editor owns one server. Preserve hidden canonical metadata and vendor fields when editing. */
export function parseMcpEditorJson(text: string, original: McpResourceRedacted | null): McpResource {
  const root: unknown = JSON.parse(text);
  if (!object(root) || Object.keys(root).length !== 1 || !object(root.mcpServers)) throw new Error("extensions_json_shape");
  const entries = Object.entries(root.mcpServers);
  if (entries.length !== 1 || !entries[0][0].trim() || !object(entries[0][1])) throw new Error("extensions_json_single_server");
  const [key, value] = entries[0] as [string, Record<string, unknown>];
  if (value.type !== undefined && !["stdio", "sse", "http", "streamable-http"].includes(String(value.type))) throw new Error("extensions_json_transport");
  const extras = Object.fromEntries(Object.entries(value).filter(([field]) => !nativeFields.includes(field)));
  const args = value.args ?? [];
  if (!Array.isArray(args) || !args.every((item): item is string => typeof item === "string")) throw new Error("extensions_json_args");
  const timeout = value.timeout;
  if (timeout != null && (!object(timeout) || Object.entries(timeout).some(([field, item]) =>
    !["startupMs", "requestMs"].includes(field) || (item != null && (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0))))) throw new Error("extensions_json_timeout");
  const { redactedFields: _redacted, ...metadata } = original ?? { redactedFields: [] };
  return {
    ...metadata,
    schemaVersion: 1, resourceId: original?.resourceId ?? `mcp-${crypto.randomUUID()}`, serverKey: key,
    name: original && key === original.serverKey ? original.name : key,
    transport: value.type === "sse" ? "sse" : value.type === "stdio" ? "stdio" : value.type === "http" || value.type === "streamable-http" || value.url ? "streamableHttp" : "stdio",
    command: stringValue(value.command), args, cwd: stringValue(value.cwd), url: stringValue(value.url),
    env: stringMap(value.env), headers: stringMap(value.headers), timeout: timeout as McpResource["timeout"] ?? null, secretRefs: stringMap(value.secretRefs),
    perCliExtensions: { ...original?.perCliExtensions, claude: extras },
    enabledByCli: original?.enabledByCli ?? { claude: false, codex: false, grok: false },
    source: original?.source ?? null,
  }; // Rust validation remains authoritative for semantic and native compatibility checks.
}
