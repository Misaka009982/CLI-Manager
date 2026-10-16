import Editor from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Alert, Anchor, Button, Group, Modal, SegmentedControl, Select, Stack, Text, useComputedColorScheme } from "@mantine/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { useI18n } from "../../../shared/i18n";
import { configureMonaco, configureMonacoLocale } from "../../../shared/platform/monacoSetup";
import type { McpResource, McpResourceRedacted } from "../../../shared/types/extensions";
import { upsertManagedMcpResource, validateExtensionMcpResource } from "../api";
import { mcpEditorJson, parseMcpEditorJson } from "../lib/mcpJsonEditor";
import { createMcpFormDraft, maskedValueMoved, mcpDraftFingerprint, mcpFormResource, mergeMcpJsonDraft, validateMcpForm, type FormIssue, type McpFormDraft } from "../lib/mcpFormDraft";
import { applyMcpTemplate, mcpEditorLayers, mcpTemplates, type McpTemplateId } from "../lib/mcpTemplates";
import { McpConfigForm } from "./McpConfigForm";

configureMonaco();

/** 每次打开创建独立编辑会话；刷新列表不覆盖草稿或原始 revision。 */
export function McpEditorDialog(props: {
  resource: McpResourceRedacted | null; open: boolean; onClose: () => void; onSaved: (resource: McpResourceRedacted) => void;
  onBeforeSave: () => Promise<void>;
}) {
  return props.open ? <McpEditorSession key={props.resource?.resourceId ?? "new"} {...props} /> : null;
}

function McpEditorSession({ resource: initialResource, open, onClose, onSaved, onBeforeSave }: Parameters<typeof McpEditorDialog>[0]) {
  const { t, language } = useI18n();
  const colorScheme = useComputedColorScheme("light");
  const [resource] = useState(initialResource);
  const [initialDraft] = useState(() => createMcpFormDraft(initialResource));
  const [draft, setDraft] = useState(initialDraft);
  const [view, setView] = useState("form");
  const [json, setJson] = useState("");
  const [jsonBaseline, setJsonBaseline] = useState("");
  const [template, setTemplate] = useState<McpTemplateId>("generic");
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const savingRef = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  const returnTarget = useRef<HTMLElement | null>(null);
  const [sessionId] = useState(() => crypto.randomUUID());
  const targetId = resource?.resourceId ?? "new";
  const dirty = mcpDraftFingerprint(draft) !== mcpDraftFingerprint(initialDraft) || (view === "json" && json !== jsonBaseline);

  useEffect(() => { configureMonacoLocale(language); }, [language]);
  // 嵌套确认期间停用父 Modal trapFocus；最终卸载仍返回本次打开的触发控件。
  useEffect(() => {
    returnTarget.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const target = returnTarget.current;
      requestAnimationFrame(() => { if (target?.isConnected) target.focus(); });
    };
  }, []);

  const handleChange = useCallback((value: string | undefined) => { setJson(value ?? ""); }, []);
  const editorOptions = useMemo(() => ({
    automaticLayout: true, ariaLabel: t("extensions.mcp.editorLabel"), formatOnPaste: true, formatOnType: true,
    folding: true, fontFamily: "var(--font-ui-mono, Consolas, monospace)", fontSize: 13,
    // Monaco 0.55 的词高亮 Delayer 在快速切换/卸载时产生未处理取消；配置编辑不需要词引用高亮。
    occurrencesHighlight: "off" as const,
    minimap: { enabled: false }, padding: { top: 10, bottom: 10 }, scrollBeyondLastLine: false,
    tabSize: 2, wordWrap: "off" as const, readOnly: saving || confirmClose,
  }), [t, saving, confirmClose]);

  const issuesFor = (candidate: McpFormDraft, required = true): FormIssue[] => {
    const issues = validateMcpForm(candidate, resource, required);
    if (required && template === "baizhi" && candidate.transport !== "stdio") {
      const row = candidate.fields[candidate.transport].headers.find(item => item.key.toLowerCase() === "authorization");
      if (!row || !/^Bearer\s+\S+/i.test(row.value) || /[<>]/.test(row.value)) {
        issues.push({ field: row ? `headers-${row.id}` : "url", code: "required" });
      }
    }
    return issues;
  };
  const issues = issuesFor(draft);
  const reportIssues = (found: FormIssue[]) => {
    setSubmitted(true);
    setError(t(`extensions.mcp.form.error.${found[0].code}`));
    requestAnimationFrame(() => {
      const field = body.current?.querySelector<HTMLElement>(`[data-mcp-field="${found[0].field}"]`);
      field?.focus(); field?.scrollIntoView({ block: "nearest" });
    });
  };

  // JSON 显式解析成功后才替换草稿；失败保留原文、视图及模板选中项。
  const readDraft = (): McpFormDraft | null => {
    if (view === "form") return draft;
    // 空白新表单也能直接进入 JSON 粘贴；未改原文时可无损返回未完成表单。
    if (json === jsonBaseline) return draft;
    try {
      const parsed = parseMcpEditorJson(json, { ...draft.snapshot,
        extra: resource?.extra ?? {}, redactedFields: resource?.redactedFields ?? [] });
      if (maskedValueMoved(parsed, resource)) throw new Error("secretMoved");
      // JSON 明确填写的互斥字段不能在转表单时被投影丢弃。
      if (parsed.transport === "stdio" ? parsed.url !== null || Object.keys(parsed.headers).length > 0
        : parsed.command !== null || parsed.args.length > 0 || parsed.cwd !== null) throw new Error("transportFields");
      return mergeMcpJsonDraft(draft, parsed);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      setError(t(code === "secretMoved" ? "extensions.mcp.form.error.secretMoved"
        : code === "extensions_json_duplicate" ? "extensions.mcp.form.error.jsonDuplicate"
        : code === "transportFields" ? "extensions.mcp.form.error.transportFields" : "extensions.mcp.jsonInvalid"));
      return null;
    }
  };
  const changeView = (next: string) => {
    if (savingRef.current || next === view) return;
    setError(null);
    if (next === "json") {
      const found = issuesFor(draft, false);
      if (found.length) { reportIssues(found); return; }
      const text = mcpEditorJson(mcpFormResource(draft));
      setJson(text); setJsonBaseline(text);
    } else {
      const parsed = readDraft();
      if (!parsed) return;
      setDraft(parsed);
    }
    setView(next);
  };
  const changeTemplate = (next: McpTemplateId) => {
    if (next === template || savingRef.current) return;
    setError(null);
    const current = readDraft();
    if (!current) return;
    const replacement = applyMcpTemplate(current, template, next);
    setDraft(replacement); setTemplate(next); setSubmitted(false); setTouched(new Set());
    // JSON 模式的模板应用显式回到表单，避免覆盖已挂载 Monaco 的 model。
    setView("form");
  };
  const requestClose = () => {
    if (savingRef.current || confirmClose) return;
    if (dirty) setConfirmClose(true);
    else onClose();
  };
  // 使用局部冒泡处理，让 Combobox/Monaco 先消费 Esc；不新增全局监听。
  const handleEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing || event.defaultPrevented) return;
    event.preventDefault(); event.stopPropagation();
    // Mantine 的菜单收起不 preventDefault；本次事件仍保留展开目标标记。
    if (event.target instanceof HTMLElement && event.target.getAttribute("data-mantine-stop-propagation") === "true") return;
    if (!event.repeat) requestClose();
  };
  const save = async () => {
    if (savingRef.current) return;
    setError(null);
    const current = readDraft();
    if (!current) return;
    const found = issuesFor(current);
    if (found.length) { reportIssues(found); return; }
    const parsed: McpResource = mcpFormResource(current);
    if (maskedValueMoved(parsed, resource)) { setError(t("extensions.mcp.form.error.secretMoved")); return; }
    savingRef.current = true; setSaving(true);
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
    finally { savingRef.current = false; setSaving(false); }
  };
  const selected = mcpTemplates.find(item => item.id === template)!;

  return <>
    <Modal opened={open} onClose={requestClose} centered size={760} zIndex={mcpEditorLayers.editor}
      classNames={{ content: "mcp-editor", header: "mcp-editor-header", title: "mcp-editor-title" }}
      title={t(resource ? "extensions.mcp.editorTitleEdit" : "extensions.mcp.editorTitleNew")}
      closeOnEscape={false} onKeyDown={handleEscape} closeOnClickOutside={!saving && !confirmClose}
      trapFocus={!confirmClose} returnFocus={false} closeButtonProps={{ disabled: saving || confirmClose, "aria-label": t("extensions.import.close") }}
      styles={{ content: { maxHeight: "90dvh", display: "flex", flexDirection: "column" }, header: { flexShrink: 0 },
        body: { minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" } }}>
      <div className="mcp-editor-scroll" ref={body} inert={confirmClose || undefined}>
        <fieldset disabled={saving || confirmClose}>
          <Stack gap="md">
            <div className="mcp-editor-toolbar">
              <SegmentedControl className="mcp-editor-view" value={view} onChange={changeView} disabled={saving || confirmClose}
                aria-label={t("extensions.mcp.form.view")} data={[{ value: "form", label: t("extensions.mcp.form.view") }, { value: "json", label: "JSON" }]} />
              {!resource && <Select className="mcp-editor-template" label={t("extensions.mcp.form.template")} value={template} allowDeselect={false} disabled={saving || confirmClose}
                data={mcpTemplates.map(item => ({ value: item.id, label: t(item.name) }))}
                comboboxProps={{ withinPortal: true, zIndex: mcpEditorLayers.menu, classNames: { dropdown: "mcp-editor-menu" }, middlewares: { flip: true, shift: true } }}
                onChange={value => { if (value) changeTemplate(value as McpTemplateId); }} />}
            </div>
              {!resource && template !== "generic" && <Text size="xs" c="dimmed">
                {t(`extensions.mcp.template.${template}Help`)}{" "}
                <Anchor component="button" type="button" size="xs" disabled={saving || confirmClose}
                  onClick={() => { void openUrl(selected.docs).catch(() => setError(t("extensions.mcp.form.linkFailed"))); }}>{t("extensions.mcp.form.docs")}</Anchor>
              </Text>}
            {Boolean(resource?.redactedFields.length) && <Alert color="yellow">{t("extensions.mcp.editorSecretRedacted")}</Alert>}
            {error && <Alert color="red" role="alert">{error}</Alert>}
            {view === "form" ? <McpConfigForm draft={draft} onChange={setDraft} template={template}
              issues={issues.filter(issue => submitted || touched.has(issue.field))} onBlur={field => setTouched(previous => new Set([...previous, field]))} />
              : <>
                <Text size="xs" c="dimmed">{t("extensions.mcp.jsonHelp")}</Text>
                <div className="min-h-[220px] min-w-0 overflow-hidden rounded-lg border border-border/60">
                  <Editor height="clamp(220px, 38dvh, 480px)" path={`mcp-resource://${targetId}/${sessionId}`}
                    defaultLanguage="json" defaultValue={json} theme={colorScheme === "dark" ? "vs-dark" : "vs"}
                    onChange={handleChange} options={editorOptions} />
                </div>
              </>}
          </Stack>
        </fieldset>
      </div>
      <Text size="xs" c="dimmed" mt="sm">{t("extensions.mcp.form.saveHelp")}</Text>
      <Group justify="flex-end" mt="md" pt="sm" style={{ flexShrink: 0, borderTop: "1px solid var(--mantine-color-default-border)" }}>
        <Button variant="light" disabled={saving || confirmClose} onClick={requestClose}>{t("extensions.import.close")}</Button>
        <Button loading={saving} disabled={confirmClose} onClick={() => void save()}>{t("extensions.mcp.save")}</Button>
      </Group>
    </Modal>
    <Modal opened={confirmClose} onClose={() => setConfirmClose(false)} centered zIndex={mcpEditorLayers.confirmation}
      title={t("extensions.mcp.form.discardTitle")} closeOnClickOutside={false} closeOnEscape={false}
      closeButtonProps={{ "aria-label": t("extensions.import.close") }}
      onKeyDown={event => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing || event.defaultPrevented) return;
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) setConfirmClose(false);
      }}>
      <Text size="sm">{t("extensions.mcp.form.discardHelp")}</Text>
      <Group justify="flex-end" mt="md">
        <Button variant="light" onClick={() => setConfirmClose(false)}>{t("extensions.save.stay")}</Button>
        <Button color="red" onClick={onClose}>{t("extensions.mcp.form.discard")}</Button>
      </Group>
    </Modal>
  </>;
}
