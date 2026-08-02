import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Group, Stack, Text, Textarea } from "@mantine/core";
import { AlertTriangle, Check, Save } from "lucide-react";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { useAppConfirm } from "@/components/ui/useAppConfirm";
import type { NativeProviderAppType, NativeProviderDocument } from "./nativeProviderTypes";

interface NativeProviderDocumentEditorProps {
  appType: NativeProviderAppType;
  providerId: string;
  documents: NativeProviderDocument[];
  action: string | null;
  onSave: (kind: string, value: string) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}

function documentLabel(kind: string, t: (key: TranslationKey) => string) {
  if (kind === "claude.settings") return t("providerCatalog.documents.settingsJson");
  if (kind === "codex.auth") return t("providerCatalog.documents.authJson");
  return t("providerCatalog.documents.configToml");
}

function isValidJson(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function appTypeLabel(appType: NativeProviderAppType, t: (key: TranslationKey) => string): string {
  if (appType === "claude") return t("providerCatalog.appType.claude");
  if (appType === "codex") return t("providerCatalog.appType.codex");
  return t("providerCatalog.appType.grokbuild");
}

export function NativeProviderDocumentEditor({
  appType,
  providerId,
  documents,
  action,
  onSave,
  onDirtyChange,
}: NativeProviderDocumentEditorProps) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useAppConfirm();
  const providerRef = useRef(providerId);
  const dirtyRef = useRef(new Set<string>());
  const [activeKind, setActiveKind] = useState(documents[0]?.kind ?? "");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dirtyKinds, setDirtyKinds] = useState<Set<string>>(new Set());

  useEffect(() => {
    dirtyRef.current = dirtyKinds;
  }, [dirtyKinds]);

  useEffect(() => {
    const providerChanged = providerRef.current !== providerId;
    providerRef.current = providerId;
    if (providerChanged) {
      const nextDrafts = Object.fromEntries(documents.map((document) => [document.kind, document.value]));
      dirtyRef.current = new Set();
      setDirtyKinds(new Set());
      setDrafts(nextDrafts);
      setActiveKind(documents[0]?.kind ?? "");
      return;
    }
    setDrafts((current) => {
      const next = { ...current };
      for (const document of documents) {
        if (!dirtyRef.current.has(document.kind)) next[document.kind] = document.value;
      }
      return next;
    });
    setActiveKind((current) => documents.some((document) => document.kind === current)
      ? current
      : documents[0]?.kind ?? "");
  }, [documents, providerId]);

  useEffect(() => {
    onDirtyChange(dirtyKinds.size > 0);
  }, [dirtyKinds, onDirtyChange]);

  const activeDocument = documents.find((document) => document.kind === activeKind) ?? documents[0] ?? null;
  const activeValue = activeDocument ? (drafts[activeDocument.kind] ?? activeDocument.value) : "";
  const isDirty = activeDocument ? dirtyKinds.has(activeDocument.kind) : false;
  const localValid = activeDocument?.format === "json" ? isValidJson(activeValue) : true;
  const saveBusy = action === "update-document";

  const availableKinds = useMemo(() => documents.map((document) => document.kind), [documents]);

  const handleSelect = async (kind: string) => {
    if (kind === activeKind) return;
    if (activeKind && dirtyKinds.has(activeKind)) {
      const confirmed = await confirm({
        title: t("providerCatalog.documents.unsavedTitle"),
        message: t("providerCatalog.documents.unsavedMessage"),
        confirmText: t("providerCatalog.documents.discard"),
        danger: true,
      });
      if (!confirmed) return;
      setDirtyKinds((current) => {
        const next = new Set(current);
        next.delete(activeKind);
        dirtyRef.current = next;
        return next;
      });
    }
    setActiveKind(kind);
  };

  const handleSave = async () => {
    if (!activeDocument || !localValid) return;
    await onSave(activeDocument.kind, activeValue);
    setDrafts((current) => ({ ...current, [activeDocument.kind]: activeValue }));
    setDirtyKinds((current) => {
      const next = new Set(current);
      next.delete(activeDocument.kind);
      dirtyRef.current = next;
      return next;
    });
  };

  if (!activeDocument) return null;

  return (
    <>
      <Card withBorder radius="lg" padding="md" className="border-border/70 bg-surface-container-low">
        <Stack gap="sm">
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Stack gap={2}>
              <Text fw={600}>{t("providerCatalog.documents.title")}</Text>
              <Text size="xs" c="dimmed">{t("providerCatalog.documents.description")}</Text>
            </Stack>
            <Button
              size="compact-sm"
              color="cliPrimary"
              leftSection={isDirty ? <Save size={15} /> : <Check size={15} />}
              loading={saveBusy}
              disabled={!isDirty || !localValid || Boolean(action)}
              onClick={() => void handleSave().catch(() => undefined)}
            >
              {t(isDirty ? "common.save" : "providerCatalog.documents.saved")}
            </Button>
          </Group>

          <Group gap={4} wrap="wrap" role="tablist" aria-label={t("providerCatalog.documents.selectorLabel")}>
            {availableKinds.map((kind) => {
              const selected = kind === activeDocument.kind;
              const document = documents.find((item) => item.kind === kind);
              return (
                <Button
                  key={kind}
                  role="tab"
                  aria-selected={selected}
                  size="compact-sm"
                  variant={selected ? "light" : "subtle"}
                  color={selected ? "cliPrimary" : "gray"}
                  onClick={() => void handleSelect(kind)}
                >
                  {documentLabel(kind, t)}
                  {dirtyKinds.has(kind) && <Badge size="xs" ml={6} color="yellow">{t("providerCatalog.documents.dirty")}</Badge>}
                  {document && !document.valid && <Badge size="xs" ml={6} color="red">{t("providerCatalog.documents.invalid")}</Badge>}
                </Button>
              );
            })}
          </Group>

          {activeDocument.hasSecret && (
            <Alert color="yellow" variant="light" icon={<AlertTriangle size={16} />}>
              {t("providerCatalog.documents.secretRedacted")}
            </Alert>
          )}
          {activeDocument.format === "json" && !localValid && (
            <Alert color="red" variant="light" icon={<AlertTriangle size={16} />}>
              {t("providerCatalog.documents.invalidJson")}
            </Alert>
          )}
          <Textarea
            aria-label={t("providerCatalog.documents.editorLabel", { name: documentLabel(activeDocument.kind, t) })}
            value={activeValue}
            minRows={12}
            autosize
            disabled={Boolean(action)}
            styles={{ input: { fontFamily: "var(--font-mono, ui-monospace, monospace)" } }}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDrafts((current) => ({ ...current, [activeDocument.kind]: value }));
              setDirtyKinds((current) => {
                const next = new Set(current);
                next.add(activeDocument.kind);
                dirtyRef.current = next;
                return next;
              });
            }}
          />
          <Text size="xs" c="dimmed">
            {t("providerCatalog.documents.backendAuthority", { appType: appTypeLabel(appType, t) })}
          </Text>
        </Stack>
      </Card>
      {confirmDialog}
    </>
  );
}
