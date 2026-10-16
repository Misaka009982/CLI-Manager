import { createMcpFormDraft, newKeyValueRow, type McpFormDraft } from "./mcpFormDraft";

// 官方来源复核于 2026-10-15。模板仅预填配置，不表示账号授权或 CLI 联通已经验证。
export const mcpTemplates = [
  { id: "generic", name: "extensions.mcp.template.generic", url: "", docs: "" },
  { id: "baizhi", name: "extensions.mcp.template.baizhi", url: "https://agent-toolkit.app.baizhi.cloud/mcp",
    docs: "https://github.com/chaitin/baizhi-agent-toolkit" },
  { id: "modelscope", name: "extensions.mcp.template.modelscope", url: "",
    docs: "https://github.com/modelscope/ms-cookbook/blob/main/content/chapters/chapter-27.md" },
  { id: "smithery", name: "extensions.mcp.template.smithery", url: "",
    docs: "https://smithery.ai/docs/use/connect" },
  { id: "composio", name: "extensions.mcp.template.composio", url: "https://connect.composio.dev/mcp",
    docs: "https://docs.composio.dev/docs/composio-connect" },
] as const;
export type McpTemplateId = typeof mcpTemplates[number]["id"];
export const mcpEditorLayers = { editor: 80, menu: 85, confirmation: 90 } as const;

/** 平台替换清空所有连接缓存及扩展凭据；通用只解除约束。 */
export function applyMcpTemplate(draft: McpFormDraft, previous: McpTemplateId, next: McpTemplateId): McpFormDraft {
  if (next === "generic") return draft;
  const template = mcpTemplates.find(item => item.id === next)!;
  const fresh = createMcpFormDraft(null);
  fresh.snapshot.resourceId = draft.snapshot.resourceId;
  fresh.name = !draft.name || draft.name === previous ? next : draft.name;
  fresh.transport = "streamableHttp";
  fresh.fields.streamableHttp.url = template.url;
  if (next === "baizhi") fresh.fields.streamableHttp.headers = [newKeyValueRow("Authorization")];
  return fresh;
}
