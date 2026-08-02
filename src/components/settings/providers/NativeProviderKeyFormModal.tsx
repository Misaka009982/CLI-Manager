import { useEffect, useState } from "react";
import { Button, Group, Modal, PasswordInput, Stack, Switch, TextInput, Textarea } from "@mantine/core";
import { useI18n } from "@/lib/i18n";
import type { NativeProviderAppType, NativeProviderKeyCreateInput } from "./nativeProviderTypes";

interface NativeProviderKeyFormModalProps {
  opened: boolean;
  appType: NativeProviderAppType;
  providerId: string;
  loading: boolean;
  onClose: () => void;
  onSubmit: (input: NativeProviderKeyCreateInput) => Promise<void>;
}

interface KeyDraft {
  label: string;
  apiKey: string;
  tags: string;
  notes: string;
  activate: boolean;
}

const EMPTY_DRAFT: KeyDraft = {
  label: "",
  apiKey: "",
  tags: "",
  notes: "",
  activate: true,
};

export function NativeProviderKeyFormModal({
  opened,
  appType,
  providerId,
  loading,
  onClose,
  onSubmit,
}: NativeProviderKeyFormModalProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<KeyDraft>(EMPTY_DRAFT);
  const [error, setError] = useState<"label" | "apiKey" | null>(null);

  useEffect(() => {
    if (opened) {
      setDraft(EMPTY_DRAFT);
      setError(null);
    }
  }, [opened]);

  const updateDraft = <K extends keyof KeyDraft>(key: K, value: KeyDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if ((key === "label" || key === "apiKey") && typeof value === "string" && value.trim()) {
      setError(null);
    }
  };

  const handleSubmit = async () => {
    const label = draft.label.trim();
    const apiKey = draft.apiKey.trim();
    if (!label) {
      setError("label");
      return;
    }
    if (!apiKey) {
      setError("apiKey");
      return;
    }

    await onSubmit({
      providerId,
      appType,
      label,
      apiKey,
      tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      notes: draft.notes.trim() || undefined,
      activate: draft.activate,
    });
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t("providerCatalog.addKeyTitle")} centered size="lg">
      <Stack gap="sm">
        <TextInput
          label={t("providerCatalog.keyLabel")}
          placeholder={t("providerCatalog.keyLabelPlaceholder")}
          value={draft.label}
          error={error === "label" ? t("providerCatalog.keyLabelRequired") : undefined}
          required
          autoFocus
          onChange={(event) => updateDraft("label", event.currentTarget.value)}
        />
        <PasswordInput
          label={t("providerCatalog.apiKeyLabel")}
          placeholder={t("providerCatalog.apiKeyPlaceholder")}
          value={draft.apiKey}
          error={error === "apiKey" ? t("providerCatalog.apiKeyRequired") : undefined}
          required
          onChange={(event) => updateDraft("apiKey", event.currentTarget.value)}
        />
        <TextInput
          label={t("providerCatalog.tagsLabel")}
          placeholder={t("providerCatalog.tagsPlaceholder")}
          value={draft.tags}
          onChange={(event) => updateDraft("tags", event.currentTarget.value)}
        />
        <Textarea
          label={t("providerCatalog.keyNotesLabel")}
          placeholder={t("providerCatalog.keyNotesPlaceholder")}
          minRows={2}
          autosize
          value={draft.notes}
          onChange={(event) => updateDraft("notes", event.currentTarget.value)}
        />
        <Switch
          color="cliPrimary"
          label={t("providerCatalog.activateKeyLabel")}
          description={t("providerCatalog.activateKeyDescription")}
          checked={draft.activate}
          onChange={(event) => updateDraft("activate", event.currentTarget.checked)}
        />
        <Group justify="flex-end" mt="xs">
          <Button variant="subtle" color="gray" onClick={onClose}>{t("common.cancel")}</Button>
          <Button color="cliPrimary" loading={loading} onClick={() => void handleSubmit().catch(() => undefined)}>
            {t("common.save")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
