import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Text,
} from "@mantine/core";
import { Check, Code2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "../../../shared/i18n/index";
import { useAppConfirm } from "../../../shared/ui/useAppConfirm";
import { ExtensionCliToggle } from "./ExtensionCliToggle";
import { ExtensionCompactRow } from "./ExtensionCompactRow";
import { ExtensionSortableList } from "./ExtensionSortableList";
import { McpEditorDialog } from "./McpEditorDialog";
import {
  deleteManagedMcpResource,
  setManagedMcpCliSelection,
  saveManagedMcpSelection,
} from "../api";
import type {
  ExtensionCli,
  McpResource,
  McpResourceRedacted,
} from "../../../shared/types/extensions";
import { ExtensionImportDialog } from "./ExtensionImportDialog";
import { NativeMcpPanel } from "./NativeMcpPanel";
import type { McpSaveControls } from "../api/mcpSaving";

const CLI_ORDER: ExtensionCli[] = ["claude", "codex", "grok"];

const CLI_LABEL_KEYS: Record<ExtensionCli, TranslationKey> = {
  claude: "extensions.mcp.cliClaude",
  codex: "extensions.mcp.cliCodex",
  grok: "extensions.mcp.cliGrok",
};

const TRANSPORT_KEYS: Record<McpResource["transport"], TranslationKey> = {
  stdio: "extensions.mcp.transportStdio",
  sse: "extensions.mcp.transportSse",
  streamableHttp: "extensions.mcp.transportHttp",
};

function sourceLabel(resource: McpResourceRedacted, fallback: string): string {
  return resource.source?.label?.trim() || resource.source?.kind?.trim() || fallback;
}

interface GlobalMcpPanelProps {
  mcpSave: McpSaveControls;
  resources: McpResourceRedacted[];
  nativeReady: Partial<Record<ExtensionCli, boolean>>;
  loading: boolean;
  searchValue: string;
  onRefresh: () => Promise<void>;
  onResourceChanged: (resource: McpResourceRedacted) => void;
  onResourceDeleted: (resourceId: string) => void;
}

/** MCP 全局资源列表：维护常见 MCP JSON、逐 CLI 开关与显式原生保存。 */
export function GlobalMcpPanel({
  mcpSave,
  resources,
  nativeReady,
  loading,
  searchValue,
  onRefresh,
  onResourceChanged,
  onResourceDeleted,
}: GlobalMcpPanelProps) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useAppConfirm();
  const [editorResource, setEditorResource] = useState<McpResourceRedacted | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [nativePreviewOpen, setNativePreviewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [workingToggle, setWorkingToggle] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const filteredResources = useMemo(() => {
    const query = searchValue.trim().toLocaleLowerCase();
    const sorted = resources;
    if (!query) return sorted;
    return sorted.filter((resource) => [
      resource.name,
      resource.serverKey,
      resource.source?.identity ?? "",
      resource.source?.label ?? "",
    ].some((value) => value.toLocaleLowerCase().includes(query)));
  }, [resources, searchValue]);

  const toggle = async (resource: McpResourceRedacted, cli: ExtensionCli, enabled: boolean) => {
    const key = `${resource.resourceId}:${cli}`;
    setWorkingToggle(key);
    try {
      const updated = await setManagedMcpCliSelection(resources, resource.resourceId, cli, enabled, mcpSave.homeIdentity);
      updated.forEach(onResourceChanged);
    } catch {
      toast.error(t("extensions.mcp.toggleFailed", { cli: t(CLI_LABEL_KEYS[cli]) }));
      await onRefresh();
    } finally {
      setWorkingToggle(null);
    }
  };

  const remove = async (resource: McpResourceRedacted) => {
    const accepted = await confirm({
      title: t("extensions.mcp.delete"),
      message: t("extensions.mcp.deleteConfirm", { name: resource.name }),
      confirmText: t("extensions.mcp.delete"),
      danger: true,
    });
    if (!accepted) return;
    setDeleting(resource.resourceId);
    try {
      await prepareEdit();
      await deleteManagedMcpResource(resource.resourceId);
      onResourceDeleted(resource.resourceId);
    } catch {
      toast.error(t("extensions.mcp.deleteFailed"));
    } finally {
      setDeleting(null);
    }
  };

  // Resource edits/deletion/import must not resurrect unrelated imported default switches.
  const prepareEdit = async () => {
    const readyClis = CLI_ORDER.filter(cli => nativeReady[cli]);
    if (readyClis.length !== CLI_ORDER.length) throw new Error("extensions_native_status_unavailable");
    const updated = await saveManagedMcpSelection(resources, readyClis, mcpSave.homeIdentity);
    updated.forEach(onResourceChanged);
  };

  return (
    <Stack gap="md">
      {confirmDialog}
      {nativePreviewOpen && <NativeMcpPanel onClose={() => setNativePreviewOpen(false)}
          availableClis={CLI_ORDER.filter((cli) => nativeReady[cli])}
        />}
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Stack gap={2}>
          <Text fw={650}>{t("extensions.mcp.title")}</Text>
          <Text size="xs" c="dimmed">{t("extensions.mcp.description")}</Text>
        </Stack>
        <Group gap="xs">
          <Button size="compact-sm" color="cliPrimary" leftSection={<Check size={15} />}
            loading={mcpSave.busy} disabled={mcpSave.busy || !mcpSave.pending || loading}
            onClick={() => { void mcpSave.save(); }}>
            {t("extensions.save.button")}
          </Button>
          <Button size="compact-sm" variant="light" disabled={mcpSave.busy} leftSection={<Code2 size={15} />} onClick={() => setNativePreviewOpen(true)}>
            {t("extensions.native.configPreview")}
          </Button>
          <Button size="compact-sm" variant="subtle" color="gray" loading={loading} onClick={() => void onRefresh()}>
            {t("extensions.refresh")}
          </Button>
          <Button size="compact-sm" variant="light" disabled={mcpSave.busy} leftSection={<Plus size={15} />} onClick={() => {
            setEditorResource(null);
            setEditorOpen(true);
          }}>
            {t("extensions.mcp.add")}
          </Button>
          <Button size="compact-sm" color="cliPrimary" disabled={mcpSave.busy} onClick={() => setImportOpen(true)}>
            {t("extensions.mcp.import")}
          </Button>
        </Group>
      </Group>

      {mcpSave.pending && <Alert color="yellow">{t("extensions.save.pending")}</Alert>}
      {mcpSave.error && <Alert color="red">{mcpSave.error}</Alert>}
      {mcpSave.pending && mcpSave.homePath && <Text size="xs" c="dimmed" className="break-all">{t("extensions.save.target", { path: mcpSave.homePath })}</Text>}

      {loading && resources.length === 0 ? (
        <Text size="sm" c="dimmed">{t("extensions.loading")}</Text>
      ) : filteredResources.length === 0 ? (
        <Card withBorder radius="lg" padding="xl" className="border-border/60 bg-surface-container-low text-center">
          <Text fw={600}>{t("extensions.empty")}</Text>
          <Text size="sm" c="dimmed" className="mt-1">{t("extensions.emptyDescription")}</Text>
        </Card>
      ) : (
        <ExtensionSortableList items={filteredResources} itemId={resource => resource.resourceId} kind="mcp" disabled={loading || mcpSave.busy}>
          {(resource, dragHandle) => (
            <ExtensionCompactRow
              key={resource.resourceId}
              leading={dragHandle}
              name={<span className="block truncate" title={resource.name}>{resource.name}</span>}
              meta={
                <Group gap={4} wrap="wrap">
                  <Badge size="xs" variant="light" className="max-w-full truncate" title={resource.serverKey}>
                    {resource.serverKey}
                  </Badge>
                  <Badge size="xs" color="gray">{t(TRANSPORT_KEYS[resource.transport])}</Badge>
                  <Text size="xs" c="dimmed" className="min-w-0 max-w-full truncate" title={sourceLabel(resource, t("extensions.mcp.noSource"))}>
                    {sourceLabel(resource, t("extensions.mcp.noSource"))}
                  </Text>
                </Group>
              }
              status={
                <Group gap={4} wrap="nowrap">
                  {CLI_ORDER.map((cli) => {
                    const enabled = resource.enabledByCli?.[cli] ?? false;
                    const toggleKey = `${resource.resourceId}:${cli}`;
                    return (
                      <ExtensionCliToggle key={cli} cli={cli} enabled={enabled}
                        label={t(enabled ? "extensions.mcp.disableCli" : "extensions.mcp.enableCli", { cli: t(CLI_LABEL_KEYS[cli]) })}
                        busy={workingToggle === toggleKey} disabled={!nativeReady[cli] || loading || mcpSave.busy || Boolean(workingToggle)}
                        onClick={() => void toggle(resource, cli, !enabled)} />
                    );
                  })}
                </Group>
              }
              actions={
                <>
                  <Button size="compact-sm" variant="subtle" color="gray" disabled={mcpSave.busy} aria-label={t("extensions.mcp.edit")} title={t("extensions.mcp.edit")} onClick={() => {
                    setEditorResource(resource);
                    setEditorOpen(true);
                  }}>
                    <Pencil size={15} />
                  </Button>
                  <Button size="compact-sm" variant="subtle" color="red" disabled={mcpSave.busy} loading={deleting === resource.resourceId} aria-label={t("extensions.mcp.delete")} title={t("extensions.mcp.delete")} onClick={() => void remove(resource)}>
                    <Trash2 size={15} />
                  </Button>
                </>
              }
            />
          )}
        </ExtensionSortableList>
      )}

      <McpEditorDialog
        onBeforeSave={prepareEdit}
        resource={editorResource}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        onSaved={(resource) => onResourceChanged(resource)}
      />
      <ExtensionImportDialog
        onBeforeMcpApply={prepareEdit}
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onApplied={() => {
          void onRefresh();
        }}
      />
    </Stack>
  );
}
