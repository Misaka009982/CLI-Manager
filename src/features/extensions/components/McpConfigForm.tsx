import { Select, Stack, Text, TextInput } from "@mantine/core";
import { useI18n } from "../../../shared/i18n";
import type { McpTransport } from "../../../shared/types/extensions";
import type { FormIssue, McpFormDraft, TransportDraft } from "../lib/mcpFormDraft";
import { mcpEditorLayers, type McpTemplateId } from "../lib/mcpTemplates";
import { McpArgumentRows } from "./McpArgumentRows";
import { McpKeyValueRows } from "./McpKeyValueRows";

export function McpConfigForm({ draft, onChange, issues, onBlur, template }: {
  draft: McpFormDraft; onChange: (draft: McpFormDraft) => void; issues: FormIssue[];
  onBlur: (field: string) => void; template: McpTemplateId;
}) {
  const { t } = useI18n();
  const fields = draft.fields[draft.transport];
  const update = (patch: Partial<TransportDraft>) => onChange({ ...draft, fields: {
    ...draft.fields, [draft.transport]: { ...fields, ...patch },
  } });
  const error = (field: string) => {
    const issue = issues.find(item => item.field === field);
    return issue && t(`extensions.mcp.form.error.${issue.code}`);
  };
  return <Stack gap="md">
    <div className="mcp-identity-fields">
    <TextInput label={t("extensions.mcp.form.name")} required value={draft.name} data-mcp-field="name"
      error={error("name")} onBlur={() => onBlur("name")}
      onChange={event => onChange({ ...draft, name: event.currentTarget.value })} />
    <Select label={t("extensions.mcp.transport")} value={draft.transport} allowDeselect={false}
      data={(["stdio", "streamableHttp", "sse"] as McpTransport[]).map(value => ({ value,
        label: t(value === "stdio" ? "extensions.mcp.transportStdio" : value === "sse" ? "extensions.mcp.transportSse" : "extensions.mcp.transportHttp") }))}
      comboboxProps={{ withinPortal: true, zIndex: mcpEditorLayers.menu, classNames: { dropdown: "mcp-editor-menu" }, middlewares: { flip: true, shift: true } }}
      onChange={value => { if (value) onChange({ ...draft, transport: value as McpTransport }); }} />
    </div>
    {draft.transport === "stdio" ? <>
      <TextInput label={t("extensions.mcp.form.command")} value={fields.command} required data-mcp-field="command"
        error={error("command")} onBlur={() => onBlur("command")} onChange={event => update({ command: event.currentTarget.value })} />
      <McpArgumentRows rows={fields.args} onChange={args => update({ args })} />
      <McpKeyValueRows group="env" rows={fields.env} onChange={env => update({ env })} issues={issues} onBlur={onBlur} />
      <TextInput label={t("extensions.mcp.form.cwd")} value={fields.cwd} onChange={event => update({ cwd: event.currentTarget.value })} />
    </> : <>
      <TextInput label={t("extensions.mcp.form.url")} value={fields.url} required data-mcp-field="url"
        placeholder={template === "smithery" ? "https://mcp.smithery.run/{namespace}" : "http://localhost:3000/mcp"}
        error={error("url")} onBlur={() => onBlur("url")} onChange={event => update({ url: event.currentTarget.value })} />
      <McpKeyValueRows group="headers" rows={fields.headers} onChange={headers => update({ headers })} issues={issues} onBlur={onBlur}
        bearer={template === "baizhi"} preferred={template === "baizhi" ? ["Authorization"] : []} />
      {fields.env.length > 0 && <McpKeyValueRows group="env" rows={fields.env} onChange={env => update({ env })} issues={issues} onBlur={onBlur} />}
    </>}
    <Text size="xs" c="dimmed">{t("extensions.mcp.form.advancedHelp")}</Text>
  </Stack>;
}
