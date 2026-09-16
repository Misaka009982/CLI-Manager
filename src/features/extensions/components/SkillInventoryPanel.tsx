import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Group, Stack, Text } from "@mantine/core";
import { useI18n, type TranslationKey } from "../../../shared/i18n";
import { inspectSkillInventory, type SkillInventoryEntry } from "../api/native";
import { ExtensionImportDialog } from "./ExtensionImportDialog";
import { sortExtensions, type ExtensionSortOrder } from "../lib/listPresentation";

const kinds: Record<string, TranslationKey> = {
  native: "extensions.inventory.external", plugin: "extensions.inventory.plugin", builtin: "extensions.inventory.builtin",
  "agent-compatible": "extensions.inventory.shared", "claude-compatible": "extensions.inventory.shared",
};

/** Inventory is read-only; importing copies a reviewed package into application management. */
export function SkillInventoryPanel({ searchValue, homeIdentity, onChanged, sortOrder = "nameAsc" }: {
  searchValue: string; homeIdentity: string; onChanged: () => Promise<void>; sortOrder?: ExtensionSortOrder;
}) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<SkillInventoryEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<SkillInventoryEntry | null>(null);
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setBusy(true); setError(false);
    try {
      const result = await inspectSkillInventory();
      if (id === requestId.current) { setEntries(result.entries); setWarnings(result.warnings); }
    } catch { if (id === requestId.current) setError(true); }
    finally { if (id === requestId.current) setBusy(false); }
  }, []);
  useEffect(() => {
    if (!expanded) return;
    setEntries([]); void refresh();
    return () => { requestId.current++; };
  }, [refresh, homeIdentity, expanded]);
  const query = searchValue.trim().toLocaleLowerCase();
  const filtered = sortExtensions(entries, sortOrder).filter((entry) => `${entry.name} ${entry.path} ${entry.cli}`.toLocaleLowerCase().includes(query));
  return <Stack gap="sm">
    <Group justify="space-between"><Text fw={600}>{t("extensions.inventory.title")}</Text>
      <Group gap="xs">
        {expanded && <Button variant="subtle" loading={busy} onClick={() => void refresh()}>{t("extensions.refresh")}</Button>}
        <Button variant="light" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {t(expanded ? "extensions.inventory.collapse" : "extensions.inventory.expand")}
        </Button>
      </Group>
    </Group>
    {expanded && <>
    <Text size="sm" c="dimmed">{t("extensions.inventory.description")}</Text>
    {error && <Alert color="red">{t("extensions.errors.generic")}</Alert>}
    {warnings.length > 0 && <Alert color="yellow">{t("extensions.inventory.partial")}<Text size="xs" className="break-all">{warnings.join("\n")}</Text></Alert>}
    {!busy && !error && !filtered.length && <Text c="dimmed">{t("extensions.inventory.empty")}</Text>}
    <div style={{ maxHeight: 420, overflowY: "auto" }}>
    <Stack gap="xs">
      {filtered.map((entry) => <Card key={`${entry.cli}:${entry.path}`} withBorder radius="md" padding="sm">
        <Group justify="space-between" wrap="wrap">
          <Stack gap={3} style={{ minWidth: 0, flex: 1 }}>
            <Group gap="xs"><Text fw={600}>{entry.name}</Text><Badge>{entry.cli}</Badge>
              <Badge color="gray">{t(entry.managed ? "extensions.inventory.managed" : kinds[entry.sourceKind] ?? "extensions.inventory.external")}</Badge>
              {entry.linkTarget && <Badge color="gray">{t("extensions.inventory.link")}</Badge>}
              {entry.status !== "present" && <Badge color="yellow">{t(entry.status === "missing" ? "extensions.inventory.missing" : "extensions.inventory.unscanned")}</Badge>}
            </Group>
            <Text size="xs" c="dimmed" className="break-all">{entry.path}</Text>
            {entry.linkTarget && <Text size="xs" c="dimmed" className="break-all">→ {entry.linkTarget}</Text>}
          </Stack>
          {!entry.managed && entry.importPath && entry.sourceKind !== "builtin" && <Button variant="light" size="compact-sm" onClick={() => setSelected(entry)}>{t("extensions.inventory.import")}</Button>}
        </Group>
      </Card>)}
    </Stack>
    </div>
    </>}
    <ExtensionImportDialog open={Boolean(selected)} onClose={() => setSelected(null)}
      initialSource={{ sourceKind: "skillDirectory", sourcePath: selected?.importPath ?? "" }}
      onApplied={() => { void onChanged(); void refresh(); }} />
  </Stack>;
}
