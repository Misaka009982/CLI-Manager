import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  AlertTriangle,
  FileCog,
  Folder,
  FolderClock,
  FolderOpen,
  KeyRound,
  RefreshCw,
  RotateCcw,
  Save,
} from "lucide-react";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { useHistorySourceSettingsStore } from "@/stores/historySourceSettingsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { CliToolIcon } from "../../CliToolIcon";
import { NativeProviderEnvironmentSection } from "./NativeProviderEnvironmentSection";
import { NativeProviderGlobalSection } from "./NativeProviderGlobalSection";
import { PathItem } from "./NativeProviderPathItem";
import type { UseNativeProviderHomeResult } from "./useNativeProviderHome";
import type {
  NativeProviderAppType,
  NativeProviderEnvironmentKind,
  NativeProviderHomeInput,
} from "./nativeProviderTypes";

interface NativeProviderHomeSectionProps {
  appType: NativeProviderAppType;
  providerId: string | null;
  state: UseNativeProviderHomeResult;
  onGlobalApplied?: () => Promise<void>;
}

const ERROR_TRANSLATIONS: Partial<Record<string, TranslationKey>> = {
  provider_invalid_app_type: "providerCatalog.errors.invalidAppType",
  provider_not_found: "providerCatalog.errors.notFound",
  provider_id_required: "providerCatalog.errors.generic",
  provider_key_not_active: "providerCatalog.errors.requiresActiveKey",
  provider_not_ready: "providerCatalog.errors.requiresActiveKey",
  provider_database_error: "providerCatalog.global.errors.database",
  provider_preview_fingerprint_required: "providerCatalog.global.errors.previewRequired",
  provider_environment_invalid: "providerCatalog.home.errors.environmentInvalid",
  provider_environment_id_required: "providerCatalog.home.errors.environmentIdRequired",
  provider_home_mode_invalid: "providerCatalog.home.errors.modeInvalid",
  provider_home_path_required: "providerCatalog.home.errors.pathRequired",
  provider_home_invalid: "providerCatalog.home.errors.invalid",
  provider_home_not_readable: "providerCatalog.home.errors.notReadable",
  provider_home_not_writable: "providerCatalog.home.errors.notWritable",
  provider_home_must_be_parent_directory: "providerCatalog.home.errors.mustBeParent",
  provider_home_environment_mismatch: "providerCatalog.home.errors.environmentMismatch",
  provider_home_cache_unavailable: "providerCatalog.home.errors.preference",
  provider_home_preference_read_failed: "providerCatalog.home.errors.preference",
  provider_home_preference_write_failed: "providerCatalog.home.errors.preference",
  provider_wsl_unavailable: "providerCatalog.home.errors.wslUnavailable",
  provider_wsl_probe_failed: "providerCatalog.home.errors.wslProbeFailed",
  provider_apply_conflict: "providerCatalog.global.errors.conflict",
  provider_apply_failed: "providerCatalog.global.errors.failed",
  provider_apply_backup_failed: "providerCatalog.global.errors.failed",
  provider_apply_stage_failed: "providerCatalog.global.errors.failed",
  provider_apply_lock_unavailable: "providerCatalog.global.errors.busy",
  provider_target_read_failed: "providerCatalog.environment.targetReadFailed",
  provider_target_write_failed: "providerCatalog.environment.targetWriteFailed",
  provider_target_restore_failed: "providerCatalog.environment.recoveryFailed",
  provider_target_directory_failed: "providerCatalog.environment.targetWriteFailed",
  provider_target_parent_invalid: "providerCatalog.environment.targetWriteFailed",
  provider_wsl_operation_failed: "providerCatalog.environment.targetWriteFailed",
  provider_wsl_operation_timeout: "providerCatalog.environment.targetWriteFailed",
  provider_journal_read_failed: "providerCatalog.environment.recoveryFailed",
  provider_journal_write_failed: "providerCatalog.environment.recoveryFailed",
  provider_recovery_required: "providerCatalog.global.errors.recoveryRequired",
  provider_apply_busy: "providerCatalog.global.errors.busy",
};

function environmentLabel(
  kind: NativeProviderEnvironmentKind,
  t: (key: TranslationKey) => string,
): string {
  return kind === "local"
    ? t("providerCatalog.home.local")
    : t("providerCatalog.home.wsl");
}

export function NativeProviderHomeSection({
  appType,
  providerId,
  state,
  onGlobalApplied,
}: NativeProviderHomeSectionProps) {
  const { t } = useI18n();
  const updateSetting = useSettingsStore((settings) => settings.update);
  const configuredRoots = {
    claude: useSettingsStore((settings) => settings.claudeHookConfigDir),
    codex: useSettingsStore((settings) => settings.codexHookConfigDir),
    grok: useSettingsStore((settings) => settings.grokHookConfigDir),
  };
  const syncHistoryRoot = useHistorySourceSettingsStore((state) => state.syncHookConfigRoot);
  const error = state.errorCode
    ? t(ERROR_TRANSLATIONS[state.errorCode] ?? "providerCatalog.errors.generic")
    : null;
  const previewConflict = state.errorCode === "provider_apply_conflict";
  const busy = Boolean(state.action) || state.loading;
  const currentHome = state.previewHome ?? state.home;
  const homePreviewPending = Boolean(state.previewHome);
  const [adoptingHome, setAdoptingHome] = useState(false);

  const refreshHomeAndDiagnostics = async (
    refresh: () => Promise<void>,
    homeInputOverride?: NativeProviderHomeInput,
  ) => {
    await refresh();
    await state.inspectEnvironment(undefined, undefined, homeInputOverride);
  };

  const adoptSelectedHome = async () => {
    if (!currentHome) return;
    setAdoptingHome(true);
    try {
      const root = appType === "claude"
        ? currentHome.targets.claudeConfigDir
        : appType === "codex"
          ? currentHome.targets.codexConfigDir
          : currentHome.targets.grokConfigDir;
      const setting = appType === "claude"
        ? "claudeHookConfigDir"
        : appType === "codex"
          ? "codexHookConfigDir"
          : "grokHookConfigDir";
      const rootKey: "claude" | "codex" | "grok" = appType === "grokbuild" ? "grok" : appType;
      await updateSetting(setting, root);
      await syncHistoryRoot(rootKey, root);
      await state.inspectEnvironment({
        ...configuredRoots,
        [rootKey]: root,
      });
    } catch {
      toast.error(t("providerCatalog.home.errors.adopt"));
    } finally {
      setAdoptingHome(false);
    }
  };

  const chooseLocalHome = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: t("providerCatalog.home.choosePath"),
        defaultPath: state.homePath.trim() || undefined,
      });
      if (typeof selected === "string" && selected.trim()) {
        state.setMode("manual");
        state.setHomePath(selected);
      }
    } catch {
      toast.error(t("providerCatalog.home.choosePathFailed"));
    }
  };

  return (
    <>
      <Stack gap="md">
        <Card withBorder radius="lg" padding="md" className="border-border/70 bg-surface-container-low">
          <Stack gap="sm">
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <Stack gap={2}>
                <Text fw={600}>{t("providerCatalog.home.title")}</Text>
                <Text size="xs" c="dimmed">{t("providerCatalog.home.description")}</Text>
              </Stack>
              <Button
                size="compact-sm"
                variant="subtle"
                color="gray"
                loading={state.loading}
                aria-label={t("common.refresh")}
                onClick={() => void refreshHomeAndDiagnostics(state.refreshHome).catch(() => undefined)}
              >
                <RefreshCw size={15} />
              </Button>
            </Group>

            {error && (
              <Alert color="red" variant="light" icon={<AlertTriangle size={16} />} withCloseButton onClose={state.clearError}>
                <Group justify="space-between" gap="xs" wrap="wrap">
                  <Text size="sm">{error}</Text>
                  {previewConflict && (
                    <Button
                      size="compact-sm"
                      variant="light"
                      color="red"
                      loading={state.action === "preview-global"}
                      onClick={() => void state.previewGlobal().catch(() => undefined)}
                    >
                      {t("providerCatalog.global.reloadPreview")}
                    </Button>
                  )}
                </Group>
              </Alert>
            )}

            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
              <Select
                label={t("providerCatalog.home.environment")}
                value={state.environmentKind}
                data={[
                  { value: "local", label: environmentLabel("local", t) },
                  { value: "wsl", label: environmentLabel("wsl", t) },
                ]}
                disabled={busy}
                onChange={(value) => state.setEnvironmentKind((value as NativeProviderEnvironmentKind) || "local")}
              />
              <TextInput
                label={t("providerCatalog.home.environmentId")}
                value={state.environmentId}
                disabled={busy || state.environmentKind === "local"}
                placeholder={t("providerCatalog.home.environmentIdPlaceholder")}
                onChange={(event) => state.setEnvironmentId(event.currentTarget.value)}
              />
              <Select
                label={t("providerCatalog.home.mode")}
                value={state.mode}
                data={[
                  { value: "auto", label: t("providerCatalog.home.auto") },
                  { value: "manual", label: t("providerCatalog.home.manual") },
                ]}
                disabled={busy}
                onChange={(value) => state.setMode((value as "auto" | "manual") || "auto")}
              />
            </SimpleGrid>

            <Group align="flex-end" gap="xs" wrap="nowrap">
              <TextInput
                className="min-w-0 flex-1"
                label={t("providerCatalog.home.path")}
                description={t("providerCatalog.home.pathDescription")}
                value={state.homePath}
                disabled={busy || (state.mode === "auto" && state.environmentKind !== "wsl")}
                placeholder={t("providerCatalog.home.pathPlaceholder")}
                onChange={(event) => {
                  if (state.mode === "auto") state.setMode("manual");
                  state.setHomePath(event.currentTarget.value);
                }}
              />
              <Button
                variant="light"
                color="gray"
                leftSection={<FolderOpen size={15} />}
                disabled={busy}
                onClick={() => void chooseLocalHome()}
              >
                {t("providerCatalog.home.choosePath")}
              </Button>
            </Group>

            <Group gap="xs">
              <Button
                size="sm"
                color="cliPrimary"
                leftSection={<Save size={15} />}
                loading={state.action === "select-home"}
                disabled={busy || (state.mode === "manual" && !state.homePath.trim())}
                onClick={() => void refreshHomeAndDiagnostics(state.selectHome).catch(() => undefined)}
              >
                {t("providerCatalog.home.save")}
              </Button>
              <Button
                size="sm"
                variant="light"
                leftSection={<RotateCcw size={15} />}
                loading={state.action === "reset-home"}
                disabled={busy}
                onClick={() => void refreshHomeAndDiagnostics(state.resetHome, {
                  environmentKind: state.environmentKind,
                  environmentId: state.environmentKind === "local"
                    ? null
                    : state.environmentId.trim() || null,
                  mode: "auto",
                  homePath: null,
                }).catch(() => undefined)}
              >
                {t("providerCatalog.home.reset")}
              </Button>
              {currentHome && (
                <Group gap="xs">
                  <Badge color={homePreviewPending ? "yellow" : currentHome.source === "manual" ? "yellow" : "gray"}>
                    {homePreviewPending
                      ? t("providerCatalog.home.preview")
                      : currentHome.source === "manual"
                        ? t("providerCatalog.home.sourceManual")
                        : t("providerCatalog.home.sourceAuto")}
                  </Badge>
                  {homePreviewPending && (
                    <Text size="xs" c="yellow">{t("providerCatalog.home.previewDescription")}</Text>
                  )}
                </Group>
              )}
            </Group>

            {currentHome && (
              <Stack gap="xs">
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                  <PathItem
                    agentIcon={<CliToolIcon icon="claude-code" size={15} />}
                    icon={<Folder className="text-blue-500" size={14} />}
                    label={t("providerCatalog.home.claude")}
                    path={currentHome.targets.claudeConfigDir}
                  />
                  <PathItem
                    agentIcon={<CliToolIcon icon="codex" size={15} />}
                    icon={<Folder className="text-blue-500" size={14} />}
                    label={t("providerCatalog.home.codex")}
                    path={currentHome.targets.codexConfigDir}
                  />
                  <PathItem
                    agentIcon={<CliToolIcon icon="grok" size={15} />}
                    icon={<Folder className="text-blue-500" size={14} />}
                    label={t("providerCatalog.home.grok")}
                    path={currentHome.targets.grokConfigDir}
                  />
                  <PathItem
                    agentIcon={<CliToolIcon icon="claude-code" size={15} />}
                    icon={<FileCog className="text-violet-500" size={14} />}
                    label={t("providerCatalog.home.claudeSettings")}
                    path={appendPath(currentHome.targets.claudeConfigDir, "settings.json")}
                  />
                  <PathItem
                    agentIcon={<CliToolIcon icon="codex" size={15} />}
                    icon={<KeyRound className="text-amber-500" size={14} />}
                    label={t("providerCatalog.home.codexAuth")}
                    path={appendPath(currentHome.targets.codexConfigDir, "auth.json")}
                  />
                  <PathItem
                    agentIcon={<CliToolIcon icon="codex" size={15} />}
                    icon={<FileCog className="text-violet-500" size={14} />}
                    label={t("providerCatalog.home.codexConfig")}
                    path={appendPath(currentHome.targets.codexConfigDir, "config.toml")}
                  />
                  <PathItem
                    agentIcon={<CliToolIcon icon="grok" size={15} />}
                    icon={<FileCog className="text-violet-500" size={14} />}
                    label={t("providerCatalog.home.grokConfig")}
                    path={appendPath(currentHome.targets.grokConfigDir, "config.toml")}
                  />
                  <PathItem
                    agentIcon={<CliToolIcon icon="claude-code" size={15} />}
                    icon={<FolderClock className="text-teal-500" size={14} />}
                    label={t("providerCatalog.home.claudeHistory")}
                    path={currentHome.targets.claudeHistoryRoot}
                  />
                  <PathItem
                    agentIcon={<CliToolIcon icon="codex" size={15} />}
                    icon={<FolderClock className="text-teal-500" size={14} />}
                    label={t("providerCatalog.home.codexHistory")}
                    path={currentHome.targets.codexHistoryRoot}
                  />
                  <PathItem
                    agentIcon={<CliToolIcon icon="grok" size={15} />}
                    icon={<FolderClock className="text-teal-500" size={14} />}
                    label={t("providerCatalog.home.grokHistory")}
                    path={currentHome.targets.grokHistoryRoot}
                  />
                </SimpleGrid>
                <Button
                  size="xs"
                  variant="light"
                  color="gray"
                  loading={adoptingHome}
                  disabled={busy || adoptingHome || state.homeDraftDirty}
                  onClick={() => void adoptSelectedHome()}
                >
                  {t("providerCatalog.home.adopt")}
                </Button>
                <Text size="xs" c="dimmed">{t("providerCatalog.home.adoptDescription")}</Text>
              </Stack>
            )}
          </Stack>
        </Card>

        <NativeProviderGlobalSection
          state={state}
          providerId={providerId}
          onGlobalApplied={onGlobalApplied}
        />
        <NativeProviderEnvironmentSection state={state} />
      </Stack>
    </>
  );
}

function appendPath(root: string, name: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${name}`;
}
