import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Modal, SegmentedControl, Stack, Tabs } from "@mantine/core";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { useAppConfirm } from "@/components/ui/useAppConfirm";
import { useSettingsStore } from "@/stores/settingsStore";
import { NativeProviderCatalog } from "../providers/NativeProviderCatalog";
import { NativeProviderCommonConfigSection } from "../providers/NativeProviderCommonConfigSection";
import { NativeProviderDocumentEditor } from "../providers/NativeProviderDocumentEditor";
import { NativeProviderEditor } from "../providers/NativeProviderEditor";
import { NativeProviderFormModal } from "../providers/NativeProviderFormModal";
import { NativeProviderGlobalSection } from "../providers/NativeProviderGlobalSection";
import { NativeProviderKeySection } from "../providers/NativeProviderKeySection";
import { NativeProviderHomeSection } from "../providers/NativeProviderHomeSection";
import { NativeProviderImportSection } from "../providers/NativeProviderImportSection";
import { NativeProviderTypeTabs } from "../providers/NativeProviderTypeTabs";
import {
  DEFAULT_NATIVE_PROVIDER_DETAIL_VIEW,
  normalizeNativeProviderDetailView,
  type NativeProviderDetailView,
} from "../providers/nativeProviderDetailView";
import { useNativeProviderCatalog } from "../providers/useNativeProviderCatalog";
import { useNativeProviderCommonConfig } from "../providers/useNativeProviderCommonConfig";
import { useNativeProviderHome } from "../providers/useNativeProviderHome";
import {
  NATIVE_PROVIDER_APP_TYPES,
  type NativeProviderAppType,
  type NativeProviderCreateInput,
  type NativeProviderUpdateInput,
} from "../providers/nativeProviderTypes";

interface NativeProviderPageCache {
  appType: NativeProviderAppType;
  selectedProviderId: string | null;
  detailViewByProvider: Map<string, NativeProviderDetailView>;
}

const pageCache: NativeProviderPageCache = {
  appType: NATIVE_PROVIDER_APP_TYPES[0],
  selectedProviderId: null,
  detailViewByProvider: new Map(),
};

function readCachedDetailView(providerId: string | null): NativeProviderDetailView {
  if (!providerId) return DEFAULT_NATIVE_PROVIDER_DETAIL_VIEW;
  return pageCache.detailViewByProvider.get(providerId) ?? DEFAULT_NATIVE_PROVIDER_DETAIL_VIEW;
}

interface NativeProviderSettingsPageProps {
  searchValue: string;
}

type NativeProviderSettingsSurface = "catalog" | "home";

const ERROR_TRANSLATIONS: Partial<Record<string, TranslationKey>> = {
  provider_invalid_app_type: "providerCatalog.errors.invalidAppType",
  provider_not_found: "providerCatalog.errors.notFound",
  provider_current_requires_active_key: "providerCatalog.errors.requiresActiveKey",
  provider_disabled_cannot_current: "providerCatalog.errors.disabledCannotCurrent",
  provider_current_cannot_delete: "providerCatalog.errors.currentCannotDelete",
  provider_current_cannot_disable: "providerCatalog.errors.currentCannotDisable",
  provider_referenced_cannot_disable: "providerCatalog.errors.referencedCannotDisable",
  provider_key_required: "providerCatalog.errors.keyRequired",
  provider_key_disabled_cannot_activate: "providerCatalog.errors.keyDisabledCannotActivate",
  provider_key_active_cannot_delete: "providerCatalog.errors.activeKeyCannotDelete",
  provider_key_active_cannot_disable: "providerCatalog.errors.activeKeyCannotDisable",
  provider_key_active_requires_replacement: "providerCatalog.errors.activeKeyRequiresReplacement",
  provider_key_replacement_invalid: "providerCatalog.errors.invalidKeyReplacement",
  provider_settings_invalid: "providerCatalog.errors.invalidSettings",
  provider_settings_invalid_json: "providerCatalog.errors.invalidSettings",
  provider_settings_must_be_object: "providerCatalog.errors.invalidSettings",
  provider_claude_api_format_invalid: "providerCatalog.errors.invalidClaudeApiFormat",
  provider_claude_auth_field_invalid: "providerCatalog.errors.invalidClaudeAuthField",
  provider_config_invalid: "providerCatalog.errors.invalidDocument",
  provider_config_must_be_object: "providerCatalog.errors.invalidDocumentObject",
  provider_document_kind_invalid: "providerCatalog.errors.invalidDocumentKind",
  provider_document_secret_edit_requires_key_manager: "providerCatalog.errors.documentSecretEdit",
};

function ignoreProviderError(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

export function NativeProviderSettingsPage({ searchValue }: NativeProviderSettingsPageProps) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useAppConfirm();
  const [appType, setAppType] = useState<NativeProviderAppType>(pageCache.appType);
  const [surface, setSurface] = useState<NativeProviderSettingsSurface>("catalog");
  const [importOpened, setImportOpened] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [documentDirty, setDocumentDirty] = useState(false);
  const catalog = useNativeProviderCatalog(appType);
  const commonConfig = useNativeProviderCommonConfig(appType);
  const claudeHookConfigDir = useSettingsStore((settings) => settings.claudeHookConfigDir);
  const codexHookConfigDir = useSettingsStore((settings) => settings.codexHookConfigDir);
  const grokHookConfigDir = useSettingsStore((settings) => settings.grokHookConfigDir);
  const configuredRoots = useMemo(() => ({
    claude: claudeHookConfigDir,
    codex: codexHookConfigDir,
    grok: grokHookConfigDir,
  }), [claudeHookConfigDir, codexHookConfigDir, grokHookConfigDir]);

  const [detailView, setDetailViewState] = useState<NativeProviderDetailView>(
    () => readCachedDetailView(pageCache.selectedProviderId),
  );

  const setDetailView = useCallback((view: NativeProviderDetailView) => {
    setDetailViewState(view);
    if (catalog.selectedProviderId) {
      pageCache.detailViewByProvider.set(catalog.selectedProviderId, view);
    }
  }, [catalog.selectedProviderId]);

  const query = searchValue.trim().toLocaleLowerCase();
  const filteredProviders = useMemo(() => {
    if (!query) return catalog.providers;
    return catalog.providers.filter((provider) => [
      provider.name,
      provider.category,
      provider.baseUrl,
      provider.model,
      provider.activeKeyLabel,
      provider.notes,
    ].some((value) => value?.toLocaleLowerCase().includes(query)));
  }, [catalog.providers, query]);

  const selectedProvider = catalog.detail?.card ?? catalog.providers.find(
    (provider) => provider.id === catalog.selectedProviderId
  ) ?? null;
  const selectedDetail = catalog.detail;
  const homeState = useNativeProviderHome(
    appType,
    selectedDetail?.card.id ?? null,
    configuredRoots,
  );
  useEffect(() => {
    pageCache.selectedProviderId = catalog.selectedProviderId;
    setDetailViewState(readCachedDetailView(catalog.selectedProviderId));
  }, [catalog.selectedProviderId]);
  const errorKey = catalog.errorCode ? ERROR_TRANSLATIONS[catalog.errorCode] : undefined;
  const errorMessage = t(errorKey ?? "providerCatalog.errors.generic");
  const busy = Boolean(catalog.action);

  const handleAppTypeChange = async (next: NativeProviderAppType): Promise<boolean> => {
    if (next === appType) return true;
    if (commonConfig.dirty || documentDirty) {
      const confirmed = await confirm({
        title: t("providerCatalog.unsavedChanges.title"),
        message: t("providerCatalog.unsavedChanges.message"),
        confirmText: t("providerCatalog.unsavedChanges.discard"),
        danger: true,
      });
      if (!confirmed) return false;
    }
    setDocumentDirty(false);
    pageCache.appType = next;
    setAppType(next);
    setFormMode(null);
    catalog.clearError();
    return true;
  };

  const handleSaveProvider = async (input: NativeProviderCreateInput | NativeProviderUpdateInput) => {
    if ("providerId" in input) {
      await catalog.updateProvider(input);
    } else {
      await catalog.createProvider(input);
    }
    setFormMode(null);
  };

  const handleDeleteProvider = async (providerId: string) => {
    const provider = catalog.providers.find((item) => item.id === providerId);
    if (!provider) return;
    const confirmed = await confirm({
      title: t("providerCatalog.deleteTitle"),
      message: t("providerCatalog.deleteMessage", { name: provider.name }),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (confirmed) await catalog.deleteProvider(providerId);
  };

  const handleActivateKey = async (keyId: string) => {
    const providerId = selectedDetail?.card.id ?? "";
    const wasCurrent = selectedDetail?.card.isCurrent ?? false;
    await catalog.activateKey(providerId, keyId);
    if (!wasCurrent) return;
    try {
      const result = await homeState.applyGlobal();
      if (!result) {
        toast.warning(t("providerCatalog.activeKeyChanged"));
        return;
      }
      await catalog.refreshSelection(providerId);
      toast.success(t("providerCatalog.activeKeyApplied"));
    } catch {
      toast.error(t("providerCatalog.activeKeyApplyFailed"));
    }
  };

  const appTypeLabels: Record<NativeProviderAppType, string> = {
    claude: t("providerCatalog.appType.claude"),
    codex: t("providerCatalog.appType.codex"),
    grokbuild: t("providerCatalog.appType.grokbuild"),
  };

  const handleSurfaceChange = (next: string) => {
    const nextSurface = next as NativeProviderSettingsSurface;
    setSurface(nextSurface);
    if (nextSurface !== "catalog") setImportOpened(false);
  };

  const handleProviderSelect = (providerId: string) => {
    catalog.setSelectedProviderId(providerId);
  };

  return (
    <Stack gap="md">
      <SegmentedControl
        value={surface}
        onChange={handleSurfaceChange}
        aria-label={t("providerCatalog.surfaceNavigation")}
        data={[
          { value: "catalog", label: t("providerCatalog.title") },
          { value: "home", label: t("providerCatalog.home.title") },
        ]}
        className="w-full sm:w-fit"
      />

      <NativeProviderTypeTabs value={appType} labels={appTypeLabels} onChange={handleAppTypeChange} />

      {surface === "home" ? (
        <NativeProviderHomeSection
          appType={appType}
          providerId={selectedDetail?.card.id ?? null}
          state={homeState}
          onGlobalApplied={() => catalog.refreshSelection(selectedDetail?.card.id ?? null).catch(() => undefined)}
        />
      ) : (
        <>
          {catalog.errorCode && (
            <Alert color="red" variant="light" icon={<AlertTriangle size={16} />} withCloseButton onClose={catalog.clearError}>
              {errorMessage}
            </Alert>
          )}

          <NativeProviderCommonConfigSection appType={appType} state={commonConfig} />

          <div className="grid min-h-0 grid-cols-1 gap-4 lg:h-[calc(100vh-24rem)] lg:min-h-[520px] lg:max-h-[900px] lg:grid-cols-[minmax(280px,0.78fr)_minmax(0,1.42fr)]">
            <NativeProviderCatalog
              providers={filteredProviders}
              allProviders={catalog.providers}
              selectedProviderId={catalog.selectedProviderId}
              loading={catalog.loading}
              hasSearchQuery={Boolean(query)}
              busy={busy}
              onSelect={handleProviderSelect}
              onCreate={() => setFormMode("create")}
              onOpenImport={() => setImportOpened(true)}
              onRefresh={() => void catalog.refresh()}
              onDuplicate={(providerId) => ignoreProviderError(catalog.duplicateProvider(providerId))}
              onDelete={(providerId) => ignoreProviderError(handleDeleteProvider(providerId))}
              onEnabledChange={(providerId, enabled) => ignoreProviderError(catalog.setProviderEnabled(providerId, enabled))}
              onReorder={(providerIds) => ignoreProviderError(catalog.reorderProviders(providerIds))}
            />

            <Stack gap="md" className="h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto pb-2 pr-2">
              <Tabs
                value={detailView}
                onChange={(value) => setDetailView(normalizeNativeProviderDetailView(value))}
                keepMounted
                keepMountedMode="display-none"
                className="flex min-h-0 flex-1 flex-col"
              >
                <Tabs.List aria-label={t("providerCatalog.detailTabs.label")} className="shrink-0">
                  <Tabs.Tab value="basic">{t("providerCatalog.detailTabs.basic")}</Tabs.Tab>
                  <Tabs.Tab value="effective" disabled={!selectedDetail}>{t("providerCatalog.detailTabs.effective")}</Tabs.Tab>
                  <Tabs.Tab value="keys" disabled={!selectedDetail}>{t("providerCatalog.detailTabs.keys")}</Tabs.Tab>
                  <Tabs.Tab value="documents" disabled={!selectedDetail}>{t("providerCatalog.detailTabs.documents")}</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="basic" pt="sm" className="min-h-0">
                  <Stack gap="md">
                    <NativeProviderEditor
                      view="basic"
                      detail={catalog.detail}
                      loading={catalog.detailLoading}
                      action={catalog.action}
                      commonConfig={commonConfig.document}
                      globalPreview={homeState.preview}
                      onEdit={() => setFormMode("edit")}
                      onDelete={() => {
                        if (catalog.selectedProviderId) ignoreProviderError(handleDeleteProvider(catalog.selectedProviderId));
                      }}
                      onEnabledChange={(enabled) => {
                        if (catalog.selectedProviderId) ignoreProviderError(catalog.setProviderEnabled(catalog.selectedProviderId, enabled));
                      }}
                    />
                    <NativeProviderGlobalSection
                      state={homeState}
                      providerId={selectedDetail?.card.id ?? null}
                      onGlobalApplied={() => catalog.refreshSelection(selectedDetail?.card.id ?? null).catch(() => undefined)}
                    />
                  </Stack>
                </Tabs.Panel>

                <Tabs.Panel value="effective" pt="sm" className="min-h-0">
                  <NativeProviderEditor
                    view="effective"
                    detail={catalog.detail}
                    loading={catalog.detailLoading}
                    action={catalog.action}
                    commonConfig={commonConfig.document}
                    globalPreview={homeState.preview}
                    onEdit={() => setFormMode("edit")}
                    onDelete={() => {
                      if (catalog.selectedProviderId) ignoreProviderError(handleDeleteProvider(catalog.selectedProviderId));
                    }}
                    onEnabledChange={(enabled) => {
                      if (catalog.selectedProviderId) ignoreProviderError(catalog.setProviderEnabled(catalog.selectedProviderId, enabled));
                    }}
                  />
                </Tabs.Panel>

                <Tabs.Panel value="keys" pt="sm" className="min-h-0">
                  {selectedDetail && (
                    <NativeProviderKeySection
                      appType={appType}
                      providerId={selectedDetail.card.id}
                      keys={selectedDetail.keys}
                      action={catalog.action}
                      onCreate={catalog.createKey}
                      onUpdate={catalog.updateKey}
                      onReveal={(keyId) => catalog.revealKey(selectedDetail.card.id, keyId)}
                      onActivate={(keyId) => handleActivateKey(keyId)}
                      onSetEnabled={(keyId, enabled) => catalog.setKeyEnabled(selectedDetail.card.id, keyId, enabled)}
                      onDelete={(keyId, replacementKeyId) => catalog.deleteKey(selectedDetail.card.id, keyId, replacementKeyId)}
                      onReorder={(keyIds) => catalog.reorderKeys(selectedDetail.card.id, keyIds)}
                    />
                  )}
                </Tabs.Panel>

                <Tabs.Panel value="documents" pt="sm" className="min-h-0">
                  {selectedDetail && (
                    <NativeProviderDocumentEditor
                      appType={appType}
                      providerId={selectedDetail.card.id}
                      documents={selectedDetail.documents}
                      action={catalog.action}
                      onDirtyChange={setDocumentDirty}
                      onSave={(kind, value) => catalog.updateDocument({
                        appType,
                        providerId: selectedDetail.card.id,
                        kind,
                        value,
                      })}
                    />
                  )}
                </Tabs.Panel>
              </Tabs>
            </Stack>
          </div>
        </>
      )}

      {confirmDialog}
      {importOpened && (
        <Modal
          opened
          onClose={() => setImportOpened(false)}
          title={t("providerCatalog.import.dialogTitle")}
          centered
          size="xl"
        >
          <div className="max-h-[calc(100vh-11rem)] overflow-y-auto pr-1">
            <NativeProviderImportSection appType={appType} providers={catalog.providers} onCommitted={catalog.refresh} />
          </div>
        </Modal>
      )}
      <NativeProviderFormModal
        opened={formMode !== null}
        mode={formMode ?? "create"}
        appType={appType}
        provider={formMode === "edit" ? selectedProvider : null}
        providerDetail={formMode === "edit" ? selectedDetail : null}
        loading={catalog.action === "create-provider" || catalog.action === "update-provider"}
        onClose={() => setFormMode(null)}
        onSubmit={handleSaveProvider}
      />
    </Stack>
  );
}
