import {
  Button,
  Checkbox,
  Divider,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { NativeProviderCodeEditor } from "./NativeProviderCodeEditor";
import type {
  NativeProviderAdvancedConfig,
  NativeProviderModelMapping,
} from "./nativeProviderAdvancedConfig";
import type { NativeProviderAppType } from "./nativeProviderTypes";

interface NativeProviderAdvancedConfigSectionProps {
  appType: Extract<NativeProviderAppType, "codex" | "grokbuild">;
  value: NativeProviderAdvancedConfig;
  onChange: (value: NativeProviderAdvancedConfig) => void;
  disabled?: boolean;
}

function isJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

export function NativeProviderAdvancedConfigSection({
  appType,
  value,
  onChange,
  disabled = false,
}: NativeProviderAdvancedConfigSectionProps) {
  const { t } = useI18n();
  const appTypeLabel = appType === "codex"
    ? t("providerCatalog.appType.codex")
    : t("providerCatalog.appType.grokbuild");
  const update = (patch: Partial<NativeProviderAdvancedConfig>) => onChange({ ...value, ...patch });
  const updateMapping = (index: number, patch: Partial<NativeProviderModelMapping>) => {
    update({
      modelMappings: value.modelMappings.map((item, itemIndex) => (
        itemIndex === index ? { ...item, ...patch } : item
      )),
    });
  };

  return (
    <Stack gap="sm" mt="xs">
      <Divider />
      <Stack gap={2}>
        <Text fw={600} size="sm">{t("providerCatalog.compatibleAdvanced.title", { appType: appTypeLabel })}</Text>
        <Text size="xs" c="dimmed">{t("providerCatalog.compatibleAdvanced.description")}</Text>
      </Stack>
      <Select
        label={t("providerCatalog.compatibleAdvanced.upstreamFormat")}
        description={t("providerCatalog.compatibleAdvanced.upstreamFormatDescription")}
        value={value.wireApi}
        data={[
          { value: "responses", label: t("providerCatalog.compatibleAdvanced.responses") },
          { value: "chat_completions", label: t("providerCatalog.compatibleAdvanced.chatCompletions") },
          { value: "anthropic_messages", label: t("providerCatalog.compatibleAdvanced.anthropicMessages") },
        ]}
        disabled={disabled}
        onChange={(next) => {
          if (next) update({ wireApi: next as NativeProviderAdvancedConfig["wireApi"] });
        }}
      />

      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Stack gap={2} miw={0}>
          <Text fw={600} size="sm">{t("providerCatalog.compatibleAdvanced.modelMapping")}</Text>
          <Text size="xs" c="dimmed">{t("providerCatalog.compatibleAdvanced.modelMappingDescription")}</Text>
        </Stack>
        <Button
          size="compact-sm"
          variant="light"
          color="cliPrimary"
          leftSection={<Plus size={14} />}
          disabled={disabled}
          onClick={() => update({ modelMappings: [...value.modelMappings, { source: "", target: "" }] })}
        >
          {t("providerCatalog.compatibleAdvanced.addMapping")}
        </Button>
      </Group>
      {value.modelMappings.map((mapping, index) => (
        <Group key={`${index}-${mapping.source}`} align="flex-end" wrap="nowrap">
          <TextInput
            className="min-w-0 flex-1"
            label={index === 0 ? t("providerCatalog.compatibleAdvanced.modelSource") : undefined}
            value={mapping.source}
            disabled={disabled}
            onChange={(event) => updateMapping(index, { source: event.currentTarget.value })}
          />
          <TextInput
            className="min-w-0 flex-1"
            label={index === 0 ? t("providerCatalog.compatibleAdvanced.modelTarget") : undefined}
            value={mapping.target}
            disabled={disabled}
            onChange={(event) => updateMapping(index, { target: event.currentTarget.value })}
          />
          <Button
            size="compact-sm"
            variant="subtle"
            color="red"
            aria-label={t("providerCatalog.compatibleAdvanced.removeMapping")}
            disabled={disabled}
            onClick={() => update({ modelMappings: value.modelMappings.filter((_, itemIndex) => itemIndex !== index) })}
          >
            <Trash2 size={15} />
          </Button>
        </Group>
      ))}

      <TextInput
        label={t("providerCatalog.compatibleAdvanced.userAgent")}
        description={t("providerCatalog.compatibleAdvanced.userAgentDescription")}
        placeholder={t("providerCatalog.compatibleAdvanced.userAgentPlaceholder")}
        value={value.userAgent}
        disabled={disabled}
        onChange={(event) => update({ userAgent: event.currentTarget.value })}
      />

      <Group grow align="flex-start">
        <Stack gap="xs" className="min-w-0">
          <Text size="sm" fw={500}>{t("providerCatalog.compatibleAdvanced.headerOverride")}</Text>
          <NativeProviderCodeEditor
            format="json"
            value={value.headerOverride}
            path={`native-provider-${appType}-header-override`}
            ariaLabel={t("providerCatalog.compatibleAdvanced.headerOverride")}
            height="140px"
            invalid={!isJsonObject(value.headerOverride)}
            readOnly={disabled}
            onChange={(next) => update({ headerOverride: next })}
          />
        </Stack>
        <Stack gap="xs" className="min-w-0">
          <Text size="sm" fw={500}>{t("providerCatalog.compatibleAdvanced.bodyOverride")}</Text>
          <NativeProviderCodeEditor
            format="json"
            value={value.bodyOverride}
            path={`native-provider-${appType}-body-override`}
            ariaLabel={t("providerCatalog.compatibleAdvanced.bodyOverride")}
            height="140px"
            invalid={!isJsonObject(value.bodyOverride)}
            readOnly={disabled}
            onChange={(next) => update({ bodyOverride: next })}
          />
        </Stack>
      </Group>
      <Text size="xs" c="dimmed">{t("providerCatalog.compatibleAdvanced.overrideDescription")}</Text>

      <Divider />
      <Text fw={600} size="sm">{t("providerCatalog.compatibleAdvanced.featureTitle")}</Text>
      <Group gap="lg" wrap="wrap">
        <Checkbox
          label={t("providerCatalog.compatibleAdvanced.goalMode")}
          checked={value.goalMode}
          disabled={disabled}
          onChange={(event) => update({ goalMode: event.currentTarget.checked })}
        />
        <Checkbox
          label={t("providerCatalog.compatibleAdvanced.remoteCompression")}
          checked={value.remoteCompression}
          disabled={disabled}
          onChange={(event) => update({ remoteCompression: event.currentTarget.checked })}
        />
      </Group>
    </Stack>
  );
}
