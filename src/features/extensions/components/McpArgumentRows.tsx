import { useRef } from "react";
import { ActionIcon, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { Plus, Trash2 } from "lucide-react";
import { useI18n } from "../../../shared/i18n";
import { newArgumentRow, type ArgumentRow } from "../lib/mcpFormDraft";

export function McpArgumentRows({ rows, onChange }: { rows: ArgumentRow[]; onChange: (rows: ArgumentRow[]) => void }) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  // 等 React 提交行后再聚焦；稳定 id 避免删中间行时错误复用输入 DOM。
  const focus = (id?: string) => requestAnimationFrame(() => {
    const input = root.current?.querySelector<HTMLElement>(id ? `[data-row-id="${id}"]` : "button[data-add]");
    input?.focus();
    input?.scrollIntoView({ block: "nearest" });
  });
  return <Stack gap="xs" ref={root} className="mcp-field-group">
    <div className="mcp-field-group-heading">
      <Text size="sm" fw={600}>{t("extensions.mcp.form.args")}</Text>
      <Button data-add variant="subtle" size="compact-sm" leftSection={<Plus size={14} />}
        onClick={() => { const row = newArgumentRow(); onChange([...rows, row]); focus(row.id); }}>{t("extensions.mcp.form.addArgument")}</Button>
    </div>
    {rows.map((row, index) => <Group key={row.id} gap="xs" wrap="nowrap">
      <TextInput style={{ flex: 1, minWidth: 0 }} value={row.value} data-row-id={row.id}
        aria-label={t("extensions.mcp.form.argument", { index: index + 1 })}
        onChange={event => onChange(rows.map(item => item.id === row.id ? { ...item, value: event.currentTarget.value, touched: true } : item))} />
      <ActionIcon className="mcp-row-remove" variant="subtle" color="red" size={36} aria-label={t("extensions.mcp.form.removeArgument", { index: index + 1 })}
        onClick={() => { onChange(rows.filter(item => item.id !== row.id)); focus(rows[index + 1]?.id ?? rows[index - 1]?.id); }}><Trash2 size={16} /></ActionIcon>
    </Group>)}
  </Stack>;
}
