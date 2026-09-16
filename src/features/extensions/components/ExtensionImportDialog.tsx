import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Check, FolderOpen, RefreshCw } from "lucide-react";
import { useI18n, type TranslationKey } from "../../../shared/i18n/index";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { getActiveNativeProviderHome } from "../../settings/api/nativeProviderHome";
import { suggestImportSources, type ImportSourceSuggestion } from "../lib/importSources";
import {
  applyExtensionImport,
  previewExtensionImport,
} from "../api";
import type {
  ExtensionCli,
  ExtensionImportConflictPolicy,
  ExtensionImportItemPreview,
  ExtensionImportItemResult,
  ExtensionImportPreview,
  ExtensionImportSourceKind,
} from "../../../shared/types/extensions";

interface ExtensionImportDialogProps {
  open: boolean;
  onClose: () => void;
  onApplied: () => void;
  onBeforeMcpApply?: () => Promise<void>;
  initialSource?: { sourceKind: ExtensionImportSourceKind; cli?: ExtensionCli; sourcePath: string };
}

const SOURCE_KIND_KEYS: Record<ExtensionImportSourceKind, TranslationKey> = {
  nativeMcp: "extensions.import.nativeMcp",
  ccswitch: "extensions.import.ccswitch",
  skillDirectory: "extensions.import.skillDirectory",
};

const CLI_LABEL_KEYS: Record<ExtensionCli, TranslationKey> = {
  claude: "extensions.mcp.cliClaude",
  codex: "extensions.mcp.cliCodex",
  grok: "extensions.mcp.cliGrok",
};

const ERROR_KEYS: Partial<Record<string, TranslationKey>> = {
  extensions_import_source_changed: "extensions.errors.sourceChanged",
  extensions_import_source_missing: "extensions.errors.importSourceMissing",
  extensions_import_source_unreadable: "extensions.errors.importSourceUnreadable",
  extensions_import_source_invalid: "extensions.errors.invalidJson",
  extensions_import_native_format_invalid: "extensions.errors.invalidJson",
  extensions_import_resource_selection_invalid: "extensions.errors.conflict",
  extensions_import_skill_selection_invalid: "extensions.errors.conflict",
  extensions_import_conflict_policy_invalid: "extensions.errors.conflict",
};

const STATUS_KEYS: Partial<Record<string, TranslationKey>> = {
  imported: "extensions.import.statusImported",
  updated: "extensions.import.statusUpdated",
  unchanged: "extensions.import.statusUnchanged",
  skipped: "extensions.import.statusSkipped",
  failed: "extensions.import.statusFailed",
};

const ACTION_KEYS: Partial<Record<string, TranslationKey>> = {
  create: "extensions.import.actionCreate",
  update: "extensions.import.actionUpdate",
  unchanged: "extensions.import.actionUnchanged",
};

function operationError(error: unknown, t: (key: TranslationKey) => string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.replace(/^Error:\s*/i, "").trim().split(":", 1)[0];
  return t(ERROR_KEYS[code] ?? "extensions.errors.generic");
}

function statusColor(status: string): string {
  if (status === "failed") return "red";
  if (status === "skipped") return "yellow";
  if (status === "unchanged") return "gray";
  return "green";
}

function statusLabel(status: string, t: (key: TranslationKey) => string): string {
  const key = STATUS_KEYS[status];
  return key ? t(key) : status;
}

function itemLabel(item: ExtensionImportItemPreview, t: (key: TranslationKey) => string): string {
  const action = ACTION_KEYS[item.action];
  return action ? t(action) : item.action;
}

function resultReason(result: ExtensionImportItemResult): string {
  return result.reason?.replace(/^extensions_[a-z0-9_]+$/, (value) => value.replace(/_/g, " ")) ?? "";
}

export function ExtensionImportDialog({ open, onClose, onApplied, initialSource, onBeforeMcpApply }: ExtensionImportDialogProps) {
  const { t } = useI18n();
  const [sourceKind, setSourceKind] = useState<ExtensionImportSourceKind>("nativeMcp");
  const [cli, setCli] = useState<ExtensionCli>("claude");
  const [sourcePath, setSourcePath] = useState("");
  const [preview, setPreview] = useState<ExtensionImportPreview | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [conflictPolicy, setConflictPolicy] = useState<ExtensionImportConflictPolicy>("skip");
  const [result, setResult] = useState<Awaited<ReturnType<typeof applyExtensionImport>> | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | "choose" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ImportSourceSuggestion[]>([]);
  const hookRoot = useSettingsStore((state) => cli === "claude" ? state.claudeHookConfigDir
    : cli === "codex" ? state.codexHookConfigDir : state.grokHookConfigDir);

  useEffect(() => {
    if (!open) return;
    setSourceKind(initialSource?.sourceKind ?? "nativeMcp");
    setCli(initialSource?.cli ?? "claude");
    setSourcePath(initialSource?.sourcePath ?? "");
    setPreview(null);
    setSelectedIds(new Set());
    setConflictPolicy("skip");
    setResult(null);
    setBusy(null);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setSuggestions([]);
    // Explicit inventory/source selections and manual input are never overwritten.
    void getActiveNativeProviderHome().then(home => home, () => null).then(home => {
      if (stale) return;
      const next = suggestImportSources(cli, sourceKind, hookRoot, home);
      setSuggestions(next);
      setSourcePath(current => current || next[0]?.path || "");
    });
    return () => { stale = true; };
  }, [open, cli, sourceKind, hookRoot]);

  const selectedItems = useMemo(
    () => preview?.items.filter((item) => selectedIds.has(item.candidateId)) ?? [],
    [preview, selectedIds],
  );
  const allSelected = Boolean(preview?.items.length) && selectedIds.size === preview?.items.length;

  const chooseSource = async () => {
    setBusy("choose");
    setError(null);
    try {
      const selected = await openDialog({
        directory: sourceKind === "skillDirectory",
        multiple: false,
        title: t("extensions.import.chooseSource"),
        defaultPath: sourcePath.trim() || undefined,
      });
      if (typeof selected === "string" && selected.trim()) {
        setSourcePath(selected);
        setPreview(null);
        setSelectedIds(new Set());
        setResult(null);
      }
    } catch {
      setError(t("extensions.import.chooseSourceFailed"));
    } finally {
      setBusy(null);
    }
  };

  const scan = async () => {
    if (!sourcePath.trim()) {
      setError(t("extensions.errors.importSourceMissing"));
      return;
    }
    setBusy("preview");
    setError(null);
    setResult(null);
    try {
      const next = await previewExtensionImport({
        sourceKind: sourceKind,
        cli: sourceKind === "skillDirectory" ? null : cli,
        sourcePath: sourcePath.trim(),
      });
      setPreview(next);
      setSourcePath(next.sourcePath);
      setSelectedIds(new Set(next.items.map((item) => item.candidateId)));
    } catch (scanError) {
      setPreview(null);
      setSelectedIds(new Set());
      setError(operationError(scanError, t));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!preview) return;
    if (selectedItems.length === 0) {
      setError(t("extensions.import.noSelected"));
      return;
    }
    setBusy("apply");
    setError(null);
    try {
      if (selectedItems.some(item => item.kind === "mcp")) await onBeforeMcpApply?.();
      const next = await applyExtensionImport({
        sourceKind: preview.sourceKind as ExtensionImportSourceKind,
        cli: sourceKind === "skillDirectory" ? null : cli,
        sourcePath: preview.sourcePath,
        expectedFingerprint: preview.sourceFingerprint,
        selectedResourceIds: selectedItems.filter((item) => item.kind === "mcp").map((item) => item.candidateId),
        selectedSkillIds: selectedItems.filter((item) => item.kind === "skill").map((item) => item.candidateId),
        conflictPolicy,
      });
      setResult(next);
      onApplied();
    } catch (applyError) {
      setError(operationError(applyError, t));
    } finally {
      setBusy(null);
    }
  };

  const toggleAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(preview?.items.map((item) => item.candidateId) ?? []) : new Set());
  };

  const toggleItem = (item: ExtensionImportItemPreview, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(item.candidateId);
      else next.delete(item.candidateId);
      return next;
    });
  };

  const close = () => {
    if (busy) return;
    onClose();
  };

  return (
    <div
      className={`fixed inset-0 z-[60] ${open ? "flex" : "hidden"} items-center justify-center bg-black/50 p-4`}
      role="dialog"
      aria-modal="true"
      aria-label={t("extensions.import.title")}
      onClick={close}
    >
      <div
        className="ui-surface-card flex max-h-[92vh] w-full max-w-4xl flex-col overflow-y-auto rounded-2xl p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <Stack gap="sm">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <Stack gap={2}>
              <Text fw={650}>{t("extensions.import.title")}</Text>
              <Text size="xs" c="dimmed">{t("extensions.import.description")}</Text>
            </Stack>
            <Button variant="subtle" color="gray" onClick={close}>{t("extensions.import.close")}</Button>
          </Group>

          <SegmentedControl
            fullWidth
            value={sourceKind}
            disabled={Boolean(busy)}
            data={Object.entries(SOURCE_KIND_KEYS).map(([value, key]) => ({ value, label: t(key) }))}
            onChange={(value) => {
              setSourceKind(value as ExtensionImportSourceKind);
              setSourcePath("");
              setPreview(null);
              setSelectedIds(new Set());
              setResult(null);
              setError(null);
            }}
          />

          {sourceKind !== "ccswitch" && <Text size="sm" c="dimmed">{t("extensions.import.autoHelp")}</Text>}
          {suggestions.length > 0 && <Select
            label={t("extensions.import.detectedSources")}
            value={suggestions.some(item => item.path === sourcePath) ? sourcePath : null}
            disabled={Boolean(busy)}
            data={suggestions.map(item => ({ value: item.path, label: `${t(item.origin === "hook" ? "extensions.import.hookSource" : "extensions.import.homeSource")} · ${item.path}` }))}
            onChange={value => {
              if (!value) return;
              setSourcePath(value); setPreview(null); setSelectedIds(new Set()); setResult(null); setError(null);
            }} />}
          <Group align="flex-end" gap="xs" wrap="wrap">
              <Select
                className="min-w-[180px] flex-1"
                label={t("extensions.import.cli")}
                value={cli}
                disabled={Boolean(busy)}
                data={(["claude", "codex", "grok"] as ExtensionCli[]).map((item) => ({ value: item, label: t(CLI_LABEL_KEYS[item]) }))}
                onChange={(value) => {
                  setCli((value as ExtensionCli) || "claude");
                  if (sourceKind !== "ccswitch") setSourcePath("");
                  setPreview(null);
                  setSelectedIds(new Set());
                  setResult(null);
                }}
              />
            <TextInput
              className="min-w-[260px] flex-[2]"
              label={t("extensions.import.sourcePath")}
              placeholder={t("extensions.import.sourcePathPlaceholder")}
              value={sourcePath}
              disabled={Boolean(busy)}
              onChange={(event) => {
                setSourcePath(event.currentTarget.value);
                setPreview(null);
                setSelectedIds(new Set());
                setResult(null);
              }}
            />
            <Button variant="light" color="gray" leftSection={<FolderOpen size={15} />} loading={busy === "choose"} disabled={Boolean(busy)} onClick={() => void chooseSource()}>
              {t("extensions.import.chooseSource")}
            </Button>
            <Button color="cliPrimary" leftSection={<RefreshCw size={15} />} loading={busy === "preview"} disabled={Boolean(busy) || !sourcePath.trim()} onClick={() => void scan()}>
              {t("extensions.import.preview")}
            </Button>
          </Group>

          {error && <Alert color="red" variant="light" icon={<AlertTriangle size={16} />}>{error}</Alert>}

          {preview && (
            <Stack gap="xs">
              <Group justify="space-between" wrap="wrap">
                <Stack gap={2}>
                  <Text size="sm" fw={600}>{t("extensions.import.items")}</Text>
                  <Text size="xs" c="dimmed">{preview.sourceIdentity}</Text>
                </Stack>
                <Checkbox
                  label={t("extensions.import.selectAll")}
                  checked={allSelected}
                  indeterminate={selectedIds.size > 0 && !allSelected}
                  onChange={(event) => toggleAll(event.currentTarget.checked)}
                />
              </Group>
              {preview.warnings.length > 0 && (
                <Alert color="yellow" variant="light" icon={<AlertTriangle size={16} />} title={t("extensions.import.warnings")}>
                  {preview.warnings.join(" · ")}
                </Alert>
              )}
              {preview.items.length === 0 ? (
                <Text size="sm" c="dimmed">{t("extensions.import.noItems")}</Text>
              ) : (
                <ScrollArea h={260} type="auto">
                  <Stack gap="xs" pr="xs">
                    {preview.items.map((item) => (
                      <Card key={item.candidateId} withBorder padding="sm" radius="md" className="border-border/60 bg-surface-container-low">
                        <Group align="flex-start" wrap="nowrap">
                          <Checkbox checked={selectedIds.has(item.candidateId)} onChange={(event) => toggleItem(item, event.currentTarget.checked)} aria-label={item.name} />
                          <Stack gap={2} miw={0} className="min-w-0 flex-1">
                            <Group gap="xs" wrap="wrap">
                              <Text size="sm" fw={600} className="break-words">{item.name}</Text>
                              <Badge size="sm" variant="light">{item.kind.toUpperCase()}</Badge>
                              <Badge size="sm" color={item.action === "unchanged" ? "gray" : "blue"}>{itemLabel(item, t)}</Badge>
                            </Group>
                            <Text size="xs" c="dimmed" className="break-words">{item.description}</Text>
                            {item.reason && <Text size="xs" c="yellow">{item.reason}</Text>}
                          </Stack>
                        </Group>
                      </Card>
                    ))}
                  </Stack>
                </ScrollArea>
              )}
              <Group align="flex-end" wrap="wrap">
                <Select
                  className="min-w-[220px] flex-1"
                  label={t("extensions.import.conflictPolicy")}
                  value={conflictPolicy}
                  disabled={Boolean(busy)}
                  data={[
                    { value: "skip", label: t("extensions.import.skip") },
                    { value: "replace", label: t("extensions.import.replace") },
                    { value: "saveAs", label: t("extensions.import.saveAs") },
                  ]}
                  onChange={(value) => setConflictPolicy((value as ExtensionImportConflictPolicy) || "skip")}
                />
                <Button color="cliPrimary" leftSection={<Check size={15} />} loading={busy === "apply"} disabled={Boolean(busy) || selectedItems.length === 0} onClick={() => void apply()}>
                  {t("extensions.import.apply")}
                </Button>
              </Group>
            </Stack>
          )}

          {result && (
            <Stack gap="xs">
              <Text size="sm" fw={600}>{t("extensions.import.result")}</Text>
              <Alert color={result.failed > 0 ? "yellow" : "green"} variant="light">
                {t("extensions.import.resultSummary", {
                  imported: result.imported,
                  updated: result.updated,
                  unchanged: result.unchanged,
                  skipped: result.skipped,
                  failed: result.failed,
                })}
              </Alert>
              <ScrollArea h={180} type="auto">
                <Stack gap={4} pr="xs">
                  {result.items.map((item) => (
                    <Group key={`${item.kind}:${item.candidateId}`} justify="space-between" gap="xs" wrap="nowrap">
                      <Text size="xs" className="min-w-0 break-words">{item.candidateId}</Text>
                      <Group gap="xs" wrap="nowrap">
                        <Badge size="sm" color={statusColor(item.status)}>{statusLabel(item.status, t)}</Badge>
                        {item.reason && <Text size="xs" c="dimmed">{resultReason(item)}</Text>}
                      </Group>
                    </Group>
                  ))}
                </Stack>
              </ScrollArea>
              <Group justify="flex-end">
                <Button variant="light" onClick={close}>{t("extensions.import.done")}</Button>
              </Group>
            </Stack>
          )}
        </Stack>
      </div>
    </div>
  );
}
