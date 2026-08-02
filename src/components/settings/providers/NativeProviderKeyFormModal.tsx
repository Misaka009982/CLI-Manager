import { useEffect, useState } from "react";
import { Button, Group, Modal, PasswordInput, Stack, Switch, TextInput, Textarea } from "@mantine/core";
import { useI18n } from "@/lib/i18n";
import type {
  NativeProviderAppType,
  NativeProviderKeyCreateInput,
  NativeProviderKeySummary,
  NativeProviderKeyUpdateInput,
} from "./nativeProviderTypes";

interface NativeProviderKeyFormModalProps {
  opened: boolean;
  mode: "create" | "edit";
  appType: NativeProviderAppType;
  providerId: string;
  providerKey?: NativeProviderKeySummary | null;
  loading: boolean;
  onClose: () => void;
  onSubmit: (input: NativeProviderKeyCreateInput | NativeProviderKeyUpdateInput) => Promise<void>;
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
  mode,
  appType,
  providerId,
  providerKey,
  loading,
  onClose,
  onSubmit,
}: NativeProviderKeyFormModalProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<KeyDraft>(EMPTY_DRAFT);
  const [error, setError] = useState<"label" | "apiKey" | null>(null);

  useEffect(() => {
    if (opened) {
      setDraft(mode === "edit" && providerKey ? {
        label: providerKey.label,
        apiKey: "",
        tags: providerKey.tags.join(", "),
        notes: providerKey.notes,
        activate: false,
      } : EMPTY_DRAFT);
      setError(null);
    }
  }, [mode, opened, providerKey]);

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
    if (mode === "create" && !apiKey) {
      setError("apiKey");
      return;
    }

    const tags = draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    if (mode === "edit" && providerKey) {
      await onSubmit({
        id: providerKey.id,
        providerId,
        appType,
        label,
        apiKey: apiKey || undefined,
        tags,
        notes: draft.notes.trim() || undefined,
      });
    } else {
      await onSubmit({
        providerId,
        appType,
        label,
        apiKey,
        tags,
        notes: draft.notes.trim() || undefined,
        activate: draft.activate,
      });
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t(mode === "create" ? "providerCatalog.addKeyTitle" : "providerCatalog.editKeyTitle")}
      centered
      size="lg"
    >
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
          placeholder={t(mode === "create" ? "providerCatalog.apiKeyPlaceholder" : "providerCatalog.apiKeyKeepExisting")}
          value={draft.apiKey}
          error={error === "apiKey" ? t("providerCatalog.apiKeyRequired") : undefined}
          required={mode === "create"}
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
        {mode === "create" && (
          <Switch
            color="cliPrimary"
            label={t("providerCatalog.activateKeyLabel")}
            description={t("providerCatalog.activateKeyDescription")}
            checked={draft.activate}
            onChange={(event) => updateDraft("activate", event.currentTarget.checked)}
          />
        )}
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
