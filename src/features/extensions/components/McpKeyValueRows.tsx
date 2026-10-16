import { useRef, useState } from "react";
import { ActionIcon, Autocomplete, Button, PasswordInput, Stack, Text, TextInput } from "@mantine/core";
import { Plus, Trash2 } from "lucide-react";
import { useI18n } from "../../../shared/i18n";
import { newKeyValueRow, type FormIssue, type KeyValueRow } from "../lib/mcpFormDraft";
import { mcpFieldSuggestions } from "../lib/mcpFieldSuggestions";
import { mcpEditorLayers } from "../lib/mcpTemplates";

export function McpKeyValueRows({ group, rows, onChange, issues, onBlur, preferred = [], bearer = false }: {
  group: "env" | "headers"; rows: KeyValueRow[]; onChange: (rows: KeyValueRow[]) => void;
  issues: FormIssue[]; onBlur: (field: string) => void; preferred?: string[]; bearer?: boolean;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState(false);
  const focus = (id?: string) => requestAnimationFrame(() => {
    const input = root.current?.querySelector<HTMLElement>(id ? `[data-row-id="${id}"]` : "button[data-add]");
    input?.focus();
    input?.scrollIntoView({ block: "nearest" });
  });
  return <Stack gap="xs" ref={root} className="mcp-field-group">
    <div className="mcp-field-group-heading">
      <Text size="sm" fw={600}>{t(`extensions.mcp.form.${group}`)}</Text>
      <Button data-add variant="subtle" size="compact-sm" leftSection={<Plus size={14} />}
        onClick={() => { const row = newKeyValueRow(); onChange([...rows, row]); focus(row.id); }}>{t("extensions.mcp.form.addRow")}</Button>
    </div>
    <Text size="xs" c="dimmed">{t(`extensions.mcp.form.${group}Help`)}</Text>
    {rows.map((row, index) => {
      const field = `${group}-${row.id}`;
      const issue = issues.find(item => item.field === field);
      const masked = row.value.includes("[redacted]") || row.value === "***";
      const sensitive = masked || /token|secret|password|authorization|api.?key/i.test(row.key);
      const ValueInput = sensitive ? PasswordInput : TextInput;
      return <div className="mcp-key-value-row" key={row.id}>
        <Autocomplete value={row.key} data-row-id={row.id} data-mcp-field={field}
          openOnFocus={false} maxDropdownHeight={208}
          aria-label={t("extensions.mcp.form.keyAt", { group: t(`extensions.mcp.form.${group}`), index: index + 1 })}
          placeholder={t("extensions.mcp.form.key")} error={issue && t(`extensions.mcp.form.error.${issue.code}`)}
          data={mcpFieldSuggestions(group, row.key, rows.filter(item => item.id !== row.id).map(item => item.key), preferred)}
          comboboxProps={{ withinPortal: true, zIndex: mcpEditorLayers.menu, classNames: { dropdown: "mcp-editor-menu" }, middlewares: { flip: true, shift: true } }}
          onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
          onKeyDownCapture={event => {
            // 组合输入 Enter 不交给 Combobox 接受候选；Tab 保持浏览器默认行为。
            if ((composing || event.nativeEvent.isComposing) && event.key === "Enter") event.stopPropagation();
          }}
          onBlur={() => onBlur(field)}
          onChange={key => onChange(rows.map(item => item.id === row.id ? { ...item, key } : item))} />
        <ValueInput value={row.value} aria-label={t("extensions.mcp.form.valueAt", { index: index + 1 })}
          placeholder={bearer && row.key.toLowerCase() === "authorization" ? "Bearer <API Key>" : t("extensions.mcp.form.value")}
          description={masked ? t("extensions.mcp.form.masked") : undefined}
          {...(sensitive ? { visibilityToggleButtonProps: { "aria-label": t("extensions.mcp.form.toggleValue"), disabled: masked } } : {})}
          onBlur={() => onBlur(field)}
          onChange={event => onChange(rows.map(item => item.id === row.id ? { ...item, value: event.currentTarget.value } : item))} />
        <ActionIcon className="mcp-row-remove" variant="subtle" color="red" size={36} aria-label={t("extensions.mcp.form.removeRow", { index: index + 1 })}
          onClick={() => { onChange(rows.filter(item => item.id !== row.id)); focus(rows[index + 1]?.id ?? rows[index - 1]?.id); }}><Trash2 size={16} /></ActionIcon>
      </div>;
    })}
  </Stack>;
}
