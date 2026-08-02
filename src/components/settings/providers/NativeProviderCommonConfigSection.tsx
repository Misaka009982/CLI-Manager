import { useMemo } from "react";
import { Alert, Button, Card, Group, Stack, Text, Textarea } from "@mantine/core";
import { AlertTriangle, Check, RefreshCw, Save } from "lucide-react";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import type { NativeProviderAppType } from "./nativeProviderTypes";
import type { UseNativeProviderCommonConfigResult } from "./useNativeProviderCommonConfig";

interface NativeProviderCommonConfigSectionProps {
  appType: NativeProviderAppType;
  state: UseNativeProviderCommonConfigResult;
}

const ERROR_TRANSLATIONS: Partial<Record<string, TranslationKey>> = {
  provider_common_config_required: "providerCatalog.commonConfig.errors.required",
  provider_common_config_invalid_json: "providerCatalog.commonConfig.errors.invalidJson",
  provider_common_config_must_be_object: "providerCatalog.commonConfig.errors.mustBeObject",
  provider_common_config_contains_secret: "providerCatalog.commonConfig.errors.containsSecret",
  provider_common_config_invalid_toml: "providerCatalog.commonConfig.errors.invalidToml",
  provider_common_config_format_invalid: "providerCatalog.commonConfig.errors.formatInvalid",
};

function appTypeLabel(appType: NativeProviderAppType, t: (key: TranslationKey) => string): string {
  if (appType === "claude") return t("providerCatalog.appType.claude");
  if (appType === "codex") return t("providerCatalog.appType.codex");
  return t("providerCatalog.appType.grokbuild");
}

export function NativeProviderCommonConfigSection({ appType, state }: NativeProviderCommonConfigSectionProps) {
  const { t } = useI18n();
  const format = state.document?.format ?? (appType === "claude" ? "json" : "toml");
  const validation = useMemo(() => {
    if (!state.draft.trim()) return "required" as const;
    if (format === "toml") return "valid" as const;
    try {
      const parsed: unknown = JSON.parse(state.draft);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? "valid" as const
        : "object" as const;
    } catch {
      return "invalid" as const;
    }
  }, [format, state.draft]);

  const localError = validation === "required"
    ? t("providerCatalog.commonConfig.errors.required")
    : validation === "invalid"
      ? t("providerCatalog.commonConfig.errors.invalidJson")
      : validation === "object"
        ? t("providerCatalog.commonConfig.errors.mustBeObject")
        : null;
  const serverError = state.errorCode
    ? t(ERROR_TRANSLATIONS[state.errorCode] ?? "providerCatalog.errors.generic")
    : null;

  return (
    <Card withBorder radius="lg" padding="md" className="border-border/70 bg-surface-container-low">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2}>
            <Text fw={600}>{t("providerCatalog.commonConfig.title", { appType: appTypeLabel(appType, t) })}</Text>
            <Text size="xs" c="dimmed">{t("providerCatalog.commonConfig.description")}</Text>
          </Stack>
          <Group gap={4} wrap="nowrap">
            <Button
              size="compact-sm"
              variant="subtle"
              color="gray"
              loading={state.loading}
              aria-label={t("common.refresh")}
              onClick={() => void state.refresh()}
            >
              <RefreshCw size={15} />
            </Button>
            <Button
              size="compact-sm"
              color="cliPrimary"
              leftSection={state.dirty ? <Save size={15} /> : <Check size={15} />}
              loading={state.saving}
              disabled={state.loading || !state.dirty || validation !== "valid"}
              onClick={() => void state.save().catch(() => undefined)}
            >
              {t(state.dirty ? "common.save" : "providerCatalog.commonConfig.saved")}
            </Button>
          </Group>
        </Group>

        {serverError && (
          <Alert color="red" variant="light" icon={<AlertTriangle size={16} />} withCloseButton onClose={state.clearError}>
            {serverError}
          </Alert>
        )}
        {localError && <Text size="xs" c="red">{localError}</Text>}
        <Textarea
          aria-label={t(format === "json"
            ? "providerCatalog.commonConfig.editorLabelJson"
            : "providerCatalog.commonConfig.editorLabelToml")}
          placeholder={t(format === "json"
            ? "providerCatalog.commonConfig.placeholderJson"
            : "providerCatalog.commonConfig.placeholderToml")}
          value={state.draft}
          disabled={state.loading}
          minRows={5}
          autosize
          styles={{ input: { fontFamily: "var(--font-mono, ui-monospace, monospace)" } }}
          onChange={(event) => state.setDraft(event.currentTarget.value)}
        />
        <Text size="xs" c="dimmed">{t("providerCatalog.commonConfig.precedence", { appType: appTypeLabel(appType, t) })}</Text>
      </Stack>
    </Card>
  );
}
