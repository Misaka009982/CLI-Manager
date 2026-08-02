import { useMemo, useState } from "react";
import { Alert, Stack } from "@mantine/core";
import { AlertTriangle } from "lucide-react";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { useAppConfirm } from "@/components/ui/useAppConfirm";
import { NativeProviderCatalog } from "../providers/NativeProviderCatalog";
import { NativeProviderCommonConfigSection } from "../providers/NativeProviderCommonConfigSection";
import { NativeProviderDocumentEditor } from "../providers/NativeProviderDocumentEditor";
import { NativeProviderEditor } from "../providers/NativeProviderEditor";
import { NativeProviderFormModal } from "../providers/NativeProviderFormModal";
import { NativeProviderKeySection } from "../providers/NativeProviderKeySection";
import { NativeProviderTypeTabs } from "../providers/NativeProviderTypeTabs";
import { useNativeProviderCatalog } from "../providers/useNativeProviderCatalog";
import { useNativeProviderCommonConfig } from "../providers/useNativeProviderCommonConfig";
import {
  NATIVE_PROVIDER_APP_TYPES,
  type NativeProviderAppType,
  type NativeProviderCreateInput,
  type NativeProviderUpdateInput,
} from "../providers/nativeProviderTypes";

interface NativeProviderSettingsPageProps {
  searchValue: string;
}

const ERROR_TRANSLATIONS: Partial<Record<string, TranslationKey>> = {
  provider_invalid_app_type: "providerCatalog.errors.invalidAppType",
  provider_not_found: "providerCatalog.errors.notFound",
  provider_current_requires_active_key: "providerCatalog.errors.requiresActiveKey",
  provider_disabled_cannot_current: "providerCatalog.errors.disabledCannotCurrent",
  provider_current_cannot_delete: "providerCatalog.errors.currentCannotDelete",
  provider_current_cannot_disable: "providerCatalog.errors.currentCannotDisable",
  provider_key_required: "providerCatalog.errors.keyRequired",
  provider_key_disabled_cannot_activate: "providerCatalog.errors.keyDisabledCannotActivate",
  provider_key_active_cannot_delete: "providerCatalog.errors.activeKeyCannotDelete",
  provider_key_active_cannot_disable: "providerCatalog.errors.activeKeyCannotDisable",
  provider_key_active_requires_replacement: "providerCatalog.errors.activeKeyRequiresReplacement",
  provider_key_replacement_invalid: "providerCatalog.errors.invalidKeyReplacement",
  provider_settings_invalid: "providerCatalog.errors.invalidSettings",
  provider_settings_invalid_json: "providerCatalog.errors.invalidSettings",
  provider_settings_must_be_object: "providerCatalog.errors.invalidSettings",
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
  const [appType, setAppType] = useState<NativeProviderAppType>(NATIVE_PROVIDER_APP_TYPES[0]);
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [documentDirty, setDocumentDirty] = useState(false);
  const catalog = useNativeProviderCatalog(appType);
  const commonConfig = useNativeProviderCommonConfig(appType);

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
  const errorKey = catalog.errorCode ? ERROR_TRANSLATIONS[catalog.errorCode] : undefined;
  const errorMessage = t(errorKey ?? "providerCatalog.errors.generic");
  const busy = Boolean(catalog.action);

  const handleAppTypeChange = async (next: NativeProviderAppType) => {
    if (next === appType) return;
    if (commonConfig.dirty || documentDirty) {
      const confirmed = await confirm({
        title: t("providerCatalog.unsavedChanges.title"),
        message: t("providerCatalog.unsavedChanges.message"),
        confirmText: t("providerCatalog.unsavedChanges.discard"),
        danger: true,
      });
      if (!confirmed) return;
    }
    setDocumentDirty(false);
    setAppType(next);
    setFormMode(null);
    catalog.clearError();
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

  const appTypeLabels: Record<NativeProviderAppType, string> = {
    claude: t("providerCatalog.appType.claude"),
    codex: t("providerCatalog.appType.codex"),
    grokbuild: t("providerCatalog.appType.grokbuild"),
  };

  return (
    <Stack gap="md">
      <NativeProviderTypeTabs value={appType} labels={appTypeLabels} onChange={handleAppTypeChange} />

      {catalog.errorCode && (
        <Alert color="red" variant="light" icon={<AlertTriangle size={16} />} withCloseButton onClose={catalog.clearError}>
          {errorMessage}
        </Alert>
      )}

      <NativeProviderCommonConfigSection appType={appType} state={commonConfig} />

      <div className="grid min-h-[520px] grid-cols-1 gap-4 xl:grid-cols-[minmax(280px,0.78fr)_minmax(0,1.42fr)]">
        <NativeProviderCatalog
          providers={filteredProviders}
          selectedProviderId={catalog.selectedProviderId}
          loading={catalog.loading}
          hasSearchQuery={Boolean(query)}
          busy={busy}
          onSelect={catalog.setSelectedProviderId}
          onCreate={() => setFormMode("create")}
          onRefresh={() => void catalog.refresh()}
          onDuplicate={(providerId) => ignoreProviderError(catalog.duplicateProvider(providerId))}
          onDelete={(providerId) => ignoreProviderError(handleDeleteProvider(providerId))}
          onEnabledChange={(providerId, enabled) => ignoreProviderError(catalog.setProviderEnabled(providerId, enabled))}
        />

        <Stack gap="md" className="min-w-0">
          <NativeProviderEditor
            detail={catalog.detail}
            loading={catalog.detailLoading}
            action={catalog.action}
            onEdit={() => setFormMode("edit")}
            onDuplicate={() => {
              if (catalog.selectedProviderId) ignoreProviderError(catalog.duplicateProvider(catalog.selectedProviderId));
            }}
            onDelete={() => {
              if (catalog.selectedProviderId) ignoreProviderError(handleDeleteProvider(catalog.selectedProviderId));
            }}
            onEnabledChange={(enabled) => {
              if (catalog.selectedProviderId) ignoreProviderError(catalog.setProviderEnabled(catalog.selectedProviderId, enabled));
            }}
            onSetCurrent={() => {
              if (catalog.selectedProviderId) ignoreProviderError(catalog.setCurrentProvider(catalog.selectedProviderId));
            }}
          />

          {selectedDetail && (
            <NativeProviderKeySection
              appType={appType}
              providerId={selectedDetail.card.id}
              keys={selectedDetail.keys}
              action={catalog.action}
              onCreate={catalog.createKey}
              onUpdate={catalog.updateKey}
              onReveal={(keyId) => catalog.revealKey(selectedDetail.card.id, keyId)}
              onActivate={(keyId) => catalog.activateKey(selectedDetail.card.id, keyId)}
              onSetEnabled={(keyId, enabled) => catalog.setKeyEnabled(selectedDetail.card.id, keyId, enabled)}
              onDelete={(keyId, replacementKeyId) => catalog.deleteKey(selectedDetail.card.id, keyId, replacementKeyId)}
              onReorder={(keyIds) => catalog.reorderKeys(selectedDetail.card.id, keyIds)}
            />
          )}

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
        </Stack>
      </div>

      {confirmDialog}
      <NativeProviderFormModal
        opened={formMode !== null}
        mode={formMode ?? "create"}
        appType={appType}
        provider={formMode === "edit" ? selectedProvider : null}
        loading={catalog.action === "create-provider" || catalog.action === "update-provider"}
        onClose={() => setFormMode(null)}
        onSubmit={handleSaveProvider}
      />
    </Stack>
  );
}
