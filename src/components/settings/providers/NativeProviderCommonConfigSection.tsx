import { useMemo, useState } from "react";
import { Alert, Badge, Button, Card, Collapse, Group, Stack, Text } from "@mantine/core";
import { AlertTriangle, Check, ChevronDown, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import type { NativeProviderAppType } from "./nativeProviderTypes";
import type { UseNativeProviderCommonConfigResult } from "./useNativeProviderCommonConfig";
import { NativeProviderCodeEditor } from "./NativeProviderCodeEditor";

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
  const [opened, setOpened] = useState(true);
  const [validated, setValidated] = useState(false);
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
  const serverErrorId = `provider-common-config-server-error-${appType}`;
  const localErrorId = `provider-common-config-local-error-${appType}`;
  const describedBy = [
    serverError ? serverErrorId : null,
    localError ? localErrorId : null,
  ].filter(Boolean).join(" ") || undefined;
  const validationError = serverError || localError;
  const editorLabel = t(format === "json"
    ? "providerCatalog.commonConfig.editorLabelJson"
    : "providerCatalog.commonConfig.editorLabelToml");

  return (
    <Card withBorder radius="lg" padding="md" className="min-w-0 overflow-hidden border-border/70 bg-surface-container-low">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Stack gap={2} miw={0}>
            <Text fw={600}>{t("providerCatalog.commonConfig.title", { appType: appTypeLabel(appType, t) })}</Text>
            <Text size="xs" c="dimmed">{t("providerCatalog.commonConfig.description")}</Text>
          </Stack>
          <Group gap={4} wrap="wrap">
            <Button
              size="compact-sm"
              variant="subtle"
              color="gray"
              loading={state.loading}
              aria-label={t("common.refresh")}
              onClick={() => {
                setValidated(false);
                void state.refresh();
              }}
            >
              <RefreshCw size={15} />
            </Button>
            <Button
              size="compact-sm"
              color="cliPrimary"
              leftSection={state.dirty ? <Save size={15} /> : <Check size={15} />}
              loading={state.saving}
              disabled={state.loading || !state.dirty || validation !== "valid"}
              onClick={() => void state.save().then(() => setValidated(true)).catch(() => setValidated(false))}
            >
              {t(state.dirty ? "common.save" : "providerCatalog.commonConfig.saved")}
            </Button>
          </Group>
        </Group>

        <Button
          variant="subtle"
          color="gray"
          fullWidth
          className="justify-start"
          leftSection={<ChevronDown size={16} className={opened ? "rotate-180 transition-transform" : "transition-transform"} />}
          aria-expanded={opened}
          aria-controls={`provider-common-config-editor-${appType}`}
          onClick={() => setOpened((current) => !current)}
        >
          {t(opened
            ? "providerCatalog.commonConfig.editorToggleOpen"
            : "providerCatalog.commonConfig.editorToggleClosed")}
          <Badge size="sm" variant="light" color="gray" ml="auto">{format.toUpperCase()}</Badge>
        </Button>

        {serverError && (
          <Alert id={serverErrorId} color="red" variant="light" icon={<AlertTriangle size={16} />} withCloseButton onClose={state.clearError}>
            {serverError}
          </Alert>
        )}
        {localError && <Text id={localErrorId} size="xs" c="red" role="alert">{localError}</Text>}
        <Collapse expanded={opened}>
          <Stack gap="xs" id={`provider-common-config-editor-${appType}`}>
            <div aria-describedby={describedBy}>
              <NativeProviderCodeEditor
                format={format === "json" ? "json" : "toml"}
                value={state.draft}
                path={`native-provider-common-${appType}.${format}`}
                ariaLabel={editorLabel}
                invalid={Boolean(validationError)}
                readOnly={state.loading || state.saving || state.validating}
                onChange={(value) => {
                  setValidated(false);
                  state.setDraft(value);
                }}
              />
            </div>
            <Group justify="space-between" align="center" wrap="wrap">
              <Text size="xs" c="dimmed">{t(format === "json"
                ? "providerCatalog.commonConfig.editorHintJson"
                : "providerCatalog.commonConfig.editorHintToml")}</Text>
              <Group gap="xs" wrap="wrap">
                {validated && !validationError && (
                  <Text size="xs" c="green" role="status">
                    <ShieldCheck size={14} className="mr-1 inline-block" />
                    {t("providerCatalog.commonConfig.validationPassed")}
                  </Text>
                )}
                <Button
                  size="compact-sm"
                  variant="light"
                  color="cliPrimary"
                  loading={state.validating}
                  disabled={state.loading || state.saving || validation !== "valid"}
                  onClick={() => void state.validate().then(() => setValidated(true)).catch(() => setValidated(false))}
                >
                  {t("providerCatalog.commonConfig.validate")}
                </Button>
              </Group>
            </Group>
          </Stack>
        </Collapse>
        <Text size="xs" c="dimmed">{t("providerCatalog.commonConfig.precedence", { appType: appTypeLabel(appType, t) })}</Text>
      </Stack>
    </Card>
  );
}
