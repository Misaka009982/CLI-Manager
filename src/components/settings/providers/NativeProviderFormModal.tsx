import { useEffect, useState } from "react";
import { Button, Group, Modal, Stack, Switch, TextInput, Textarea } from "@mantine/core";
import { useI18n } from "@/lib/i18n";
import type {
  NativeProviderAppType,
  NativeProviderCard,
  NativeProviderCreateInput,
  NativeProviderUpdateInput,
} from "./nativeProviderTypes";

export interface NativeProviderFormValues {
  name: string;
  baseUrl: string;
  model: string;
  apiFormat: string;
  websiteUrl: string;
  category: string;
  notes: string;
  commonConfigEnabled: boolean;
}

interface NativeProviderFormModalProps {
  opened: boolean;
  mode: "create" | "edit";
  appType: NativeProviderAppType;
  provider: NativeProviderCard | null;
  loading: boolean;
  onClose: () => void;
  onSubmit: (input: NativeProviderCreateInput | NativeProviderUpdateInput) => Promise<void>;
}

const EMPTY_VALUES: NativeProviderFormValues = {
  name: "",
  baseUrl: "",
  model: "",
  apiFormat: "",
  websiteUrl: "",
  category: "",
  notes: "",
  commonConfigEnabled: true,
};

function valuesFromProvider(provider: NativeProviderCard | null): NativeProviderFormValues {
  if (!provider) return EMPTY_VALUES;
  return {
    name: provider.name,
    baseUrl: provider.baseUrl ?? "",
    model: provider.model ?? "",
    apiFormat: provider.apiFormat ?? "",
    websiteUrl: provider.websiteUrl ?? "",
    category: provider.category ?? "",
    notes: provider.notes ?? "",
    commonConfigEnabled: provider.commonConfigEnabled,
  };
}

export function NativeProviderFormModal({
  opened,
  mode,
  appType,
  provider,
  loading,
  onClose,
  onSubmit,
}: NativeProviderFormModalProps) {
  const { t } = useI18n();
  const [values, setValues] = useState<NativeProviderFormValues>(EMPTY_VALUES);
  const [nameError, setNameError] = useState(false);

  useEffect(() => {
    if (opened) {
      setValues(valuesFromProvider(provider));
      setNameError(false);
    }
  }, [opened, provider]);

  const updateValue = <K extends keyof NativeProviderFormValues>(key: K, value: NativeProviderFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    if (key === "name" && typeof value === "string" && value.trim()) setNameError(false);
  };

  const handleSubmit = async () => {
    const name = values.name.trim();
    if (!name) {
      setNameError(true);
      return;
    }

    const common = {
      appType,
      name,
      baseUrl: values.baseUrl.trim() || undefined,
      model: values.model.trim() || undefined,
      apiFormat: values.apiFormat.trim() || undefined,
      websiteUrl: values.websiteUrl.trim() || undefined,
      category: values.category.trim() || undefined,
      notes: values.notes.trim() || undefined,
      commonConfigEnabled: values.commonConfigEnabled,
    };

    if (mode === "edit" && provider) {
      await onSubmit({
        ...common,
        baseUrl: values.baseUrl.trim(),
        model: values.model.trim(),
        apiFormat: values.apiFormat.trim(),
        providerId: provider.id,
      });
      return;
    }

    await onSubmit({ ...common, settingsConfig: "{}" });
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t(mode === "create" ? "providerCatalog.createTitle" : "providerCatalog.editTitle")}
      centered
      size="lg"
    >
      <Stack gap="sm">
        <TextInput
          label={t("providerCatalog.nameLabel")}
          placeholder={t("providerCatalog.namePlaceholder")}
          value={values.name}
          error={nameError ? t("providerCatalog.nameRequired") : undefined}
          required
          autoFocus
          onChange={(event) => updateValue("name", event.currentTarget.value)}
        />
        <Group grow align="flex-start">
          <TextInput
            label={t("providerCatalog.baseUrlLabel")}
            placeholder={t("providerCatalog.baseUrlPlaceholder")}
            value={values.baseUrl}
            onChange={(event) => updateValue("baseUrl", event.currentTarget.value)}
          />
          <TextInput
            label={t("providerCatalog.modelLabel")}
            placeholder={t("providerCatalog.modelPlaceholder")}
            value={values.model}
            onChange={(event) => updateValue("model", event.currentTarget.value)}
          />
        </Group>
        <Group grow align="flex-start">
          <TextInput
            label={t("providerCatalog.websiteLabel")}
            placeholder={t("providerCatalog.websitePlaceholder")}
            value={values.websiteUrl}
            onChange={(event) => updateValue("websiteUrl", event.currentTarget.value)}
          />
          <TextInput
            label={t("providerCatalog.categoryLabel")}
            placeholder={t("providerCatalog.categoryPlaceholder")}
            value={values.category}
            onChange={(event) => updateValue("category", event.currentTarget.value)}
          />
          <TextInput
            label={t("providerCatalog.apiFormatLabel")}
            placeholder={t("providerCatalog.apiFormatPlaceholder")}
            value={values.apiFormat}
            onChange={(event) => updateValue("apiFormat", event.currentTarget.value)}
          />
        </Group>
        <Textarea
          label={t("providerCatalog.notesLabel")}
          placeholder={t("providerCatalog.notesPlaceholder")}
          minRows={3}
          autosize
          value={values.notes}
          onChange={(event) => updateValue("notes", event.currentTarget.value)}
        />
        <Switch
          color="cliPrimary"
          label={t("providerCatalog.commonConfigLabel")}
          description={t("providerCatalog.commonConfigDescription")}
          checked={values.commonConfigEnabled}
          onChange={(event) => updateValue("commonConfigEnabled", event.currentTarget.checked)}
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
