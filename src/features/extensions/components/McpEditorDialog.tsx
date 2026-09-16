import Editor from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Group, Modal, Text, useComputedColorScheme } from "@mantine/core";
import { toast } from "sonner";
import { useI18n } from "../../../shared/i18n";
import { configureMonaco, configureMonacoLocale } from "../../../shared/platform/monacoSetup";
import type { McpResource, McpResourceRedacted } from "../../../shared/types/extensions";
import { upsertManagedMcpResource, validateExtensionMcpResource } from "../api";
import { mcpEditorJson, parseMcpEditorJson } from "../lib/mcpJsonEditor";

configureMonaco();

/** Editor scroll is separate from its footer, so long JSON never hides Save/Close. */
export function McpEditorDialog(props: {
  resource: McpResourceRedacted | null; open: boolean; onClose: () => void; onSaved: (resource: McpResourceRedacted) => void;
  onBeforeSave: () => Promise<void>;
}) {
  return props.open ? <McpEditorSession key={props.resource?.resourceId ?? "new"} {...props} /> : null;
}

// 每次打开建立资源快照；列表刷新不能覆盖输入，也不能改变本次编辑的 revision。
function McpEditorSession({ resource: initialResource, open, onClose, onSaved, onBeforeSave }: Parameters<typeof McpEditorDialog>[0]) {
  const { t, language } = useI18n();
  const colorScheme = useComputedColorScheme("light");
  const [resource] = useState(initialResource);
  const [draft, setDraft] = useState(() => mcpEditorJson(resource));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const targetId = resource?.resourceId ?? "new";

  useEffect(() => { configureMonacoLocale(language); }, [language]);

  const handleChange = useCallback((value: string | undefined) => {
    setDraft(value ?? "");
  }, []);

  const editorOptions = useMemo(() => ({
    automaticLayout: true,
    ariaLabel: t("extensions.mcp.editorLabel"),
    formatOnPaste: true,
    formatOnType: true,
    folding: true,
    fontFamily: "var(--font-ui-mono, Consolas, monospace)",
    fontSize: 13,
    minimap: { enabled: false },
    padding: { top: 10, bottom: 10 },
    scrollBeyondLastLine: false,
    tabSize: 2,
    wordWrap: "off" as const,
    readOnly: saving,
  }), [t, saving]);

  const save = async () => {
    if (saving) return;
    setError(null);
    let parsed: McpResource;
    try { parsed = parseMcpEditorJson(draft, resource); }
    catch { setError(t("extensions.mcp.jsonInvalid")); return; }
    setSaving(true);
    try {
      const report = await validateExtensionMcpResource(parsed);
      if (!report.valid) {
        setError(t("extensions.mcp.editorValidationFailed", { issues: report.issues.map(issue => `${issue.field}: ${issue.code}`).join(", ") }));
        return;
      }
      await onBeforeSave();
      onSaved(await upsertManagedMcpResource(parsed));
      toast.success(t("extensions.mcp.saved"));
      onClose();
    } catch { setError(t("extensions.mcp.saveFailed")); }
    finally { setSaving(false); }
  };

  return <Modal opened={open} onClose={() => { if (!saving) onClose(); }} centered size="lg" zIndex={80}
    title={t(resource ? "extensions.mcp.editorTitleEdit" : "extensions.mcp.editorTitleNew")}
    closeOnEscape={!saving} closeOnClickOutside={!saving} closeButtonProps={{ disabled: saving, "aria-label": t("extensions.import.close") }}
    styles={{ content: { maxHeight: "90dvh", display: "flex", flexDirection: "column" }, header: { flexShrink: 0 },
      body: { minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" } }}>
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Text size="xs" c="dimmed">{t("extensions.mcp.jsonHelp")}</Text>
      {Boolean(resource?.redactedFields.length) && <Alert color="yellow" mb="sm">{t("extensions.mcp.editorSecretRedacted")}</Alert>}
      {error && <Alert color="red" mb="sm">{error}</Alert>}
      <div className="min-h-[220px] min-w-0 flex-1 overflow-hidden rounded-lg border border-border/60">
          <Editor
            height="clamp(220px, 38dvh, 480px)"
            key={`${targetId}:${open ? "open" : "closed"}`}
            path={`mcp-resource://${targetId}`}
            defaultLanguage="json"
            defaultValue={draft}
            theme={colorScheme === "dark" ? "vs-dark" : "vs"}
            onChange={handleChange}
            options={editorOptions}
          />
      </div>
    </div>
    <Group justify="flex-end" mt="md" pt="sm" style={{ flexShrink: 0, borderTop: "1px solid var(--mantine-color-default-border)" }}>
      <Button variant="light" disabled={saving} onClick={onClose}>{t("extensions.import.close")}</Button>
      <Button loading={saving} onClick={() => void save()}>{t("extensions.mcp.save")}</Button>
    </Group>
  </Modal>;
}
