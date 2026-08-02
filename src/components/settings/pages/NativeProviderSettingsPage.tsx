import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Group,
  Modal,
  Paper,
  Select,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { Copy, Eye, Import as ImportIcon, KeyRound, Pencil, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import {
  CLI_TYPES,
  configFormatForCliType,
  type CliType,
  type ProviderStatus,
} from "@/lib/providerTypes";
import { useProviderStore } from "@/stores/providerStore";
import { useAppConfirm } from "@/components/ui/useAppConfirm";
import { useAppPrompt } from "@/components/ui/useAppPrompt";

interface Props {
  searchValue: string;
}

const ERROR_KEYS: Record<string, TranslationKey> = {
  provider_name_invalid: "settings.providers.error.nameRequired",
  provider_name_conflict: "settings.providers.error.nameDuplicate",
  provider_name_required: "settings.providers.error.nameRequired",
  provider_name_duplicate: "settings.providers.error.nameDuplicate",
  provider_not_found: "settings.providers.error.notFound",
  provider_referenced: "settings.providers.error.referenced",
  provider_key_label_invalid: "settings.providers.error.keyLabelRequired",
  provider_key_label_required: "settings.providers.error.keyLabelRequired",
  provider_key_secret_invalid: "settings.providers.error.keySecretRequired",
  provider_key_secret_required: "settings.providers.error.keySecretRequired",
  provider_key_not_found: "settings.providers.error.keyNotFound",
  provider_key_active_required: "settings.providers.error.activeRequired",
  provider_key_replacement_required: "settings.providers.error.replacementRequired",
  provider_config_invalid: "settings.providers.error.configInvalid",
  provider_config_contains_secret: "settings.providers.error.configContainsSecret",
  provider_status_invalid: "settings.providers.error.statusInvalid",
  provider_cli_type_invalid: "settings.providers.error.cliTypeInvalid",
};

const CLI_LABEL_KEYS: Record<CliType, TranslationKey> = {
  claude: "settings.providers.cli.claude",
  codex: "settings.providers.cli.codex",
  grok: "settings.providers.cli.grok",
};

function defaultConfig(cliType: CliType): string {
  return cliType === "claude" ? "{}" : "";
}

function providerStatusColor(status: ProviderStatus): string {
  if (status === "ready") return "green";
  if (status === "disabled") return "gray";
  return "yellow";
}

function errorText(error: unknown, t: (key: TranslationKey, params?: Record<string, string | number>) => string): string {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "provider_operation_failed";
  const key = ERROR_KEYS[raw];
  return key ? t(key) : t("settings.providers.error.operationFailed", { error: raw });
}

function statusText(status: ProviderStatus, t: (key: TranslationKey) => string): string {
  if (status === "ready") return t("settings.providers.status.ready");
  if (status === "disabled") return t("settings.providers.status.disabled");
  return t("settings.providers.status.draft");
}

export function NativeProviderSettingsPage({ searchValue }: Props) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useAppConfirm();
  const { prompt, promptDialog } = useAppPrompt();
  const cliType = useProviderStore((state) => state.cliType);
  const providers = useProviderStore((state) => state.providers);
  const selectedProvider = useProviderStore((state) => state.selectedProvider);
  const common = useProviderStore((state) => state.common);
  const loaded = useProviderStore((state) => state.loaded);
  const loading = useProviderStore((state) => state.loading);
  const storeError = useProviderStore((state) => state.error);
  const loadProviders = useProviderStore((state) => state.loadProviders);
  const selectProvider = useProviderStore((state) => state.selectProvider);
  const createProvider = useProviderStore((state) => state.createProvider);
  const updateProvider = useProviderStore((state) => state.updateProvider);
  const duplicateProvider = useProviderStore((state) => state.duplicateProvider);
  const deleteProvider = useProviderStore((state) => state.deleteProvider);
  const setProviderStatus = useProviderStore((state) => state.setProviderStatus);
  const createKey = useProviderStore((state) => state.createKey);
  const updateKey = useProviderStore((state) => state.updateKey);
  const activateKey = useProviderStore((state) => state.activateKey);
  const deleteKey = useProviderStore((state) => state.deleteKey);
  const previewEffective = useProviderStore((state) => state.previewEffective);
  const updateCommon = useProviderStore((state) => state.updateCommon);
  const validateConfig = useProviderStore((state) => state.validateConfig);

  const [nameDraft, setNameDraft] = useState("");
  const [configDraft, setConfigDraft] = useState("");
  const [inheritCommonDraft, setInheritCommonDraft] = useState(true);
  const [commonDraft, setCommonDraft] = useState("");
  const [keyLabel, setKeyLabel] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [replacementKeyId, setReplacementKeyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [commonSaving, setCommonSaving] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);

  useEffect(() => {
    void loadProviders().catch(() => undefined);
  }, [loadProviders]);

  useEffect(() => {
    if (!selectedProvider) {
      setNameDraft("");
      setConfigDraft("");
      setInheritCommonDraft(true);
      return;
    }
    setNameDraft(selectedProvider.name);
    setConfigDraft(selectedProvider.configText);
    setInheritCommonDraft(selectedProvider.inheritCommon);
    setReplacementKeyId(null);
    setKeyLabel("");
    setKeySecret("");
    setPreviewText(null);
    setFeedback(null);
  }, [selectedProvider?.id]);

  useEffect(() => {
    setKeyLabel("");
    setKeySecret("");
    setPreviewText(null);
  }, [cliType]);

  useEffect(() => {
    setCommonDraft(common?.configText ?? "");
  }, [common?.cliType, common?.revision]);

  const filteredProviders = useMemo(() => {
    const query = searchValue.trim().toLocaleLowerCase();
    if (!query) return providers;
    return providers.filter((provider) => [provider.name, provider.activeKeyHint ?? "", provider.status]
      .some((value) => value.toLocaleLowerCase().includes(query)));
  }, [providers, searchValue]);

  const changeCliType = (value: string) => {
    const next = value as CliType;
    if (!CLI_TYPES.includes(next)) return;
    setFeedback(null);
    void loadProviders(next).catch(() => undefined);
  };

  const handleCreate = async () => {
    const name = await prompt({ title: t("settings.providers.createTitle"), placeholder: t("settings.providers.namePlaceholder") });
    if (!name) return;
    try {
      await createProvider({
        cliType,
        name,
        configText: defaultConfig(cliType),
        inheritCommon: true,
        sortOrder: providers.length,
      });
      toast.success(t("settings.providers.created"));
    } catch (error) {
      setFeedback(errorText(error, t));
    }
  };

  const handleSaveProvider = async () => {
    if (!selectedProvider) return;
    setSaving(true);
    setFeedback(null);
    try {
      const validation = await validateConfig({
        cliType,
        commonText: common?.configText ?? "",
        providerText: configDraft,
        inheritCommon: inheritCommonDraft,
      });
      if (!validation.valid) {
        setFeedback(errorText(validation.errorCode ?? "provider_config_invalid", t));
        return;
      }
      await updateProvider(selectedProvider.id, {
        name: nameDraft,
        configText: configDraft,
        inheritCommon: inheritCommonDraft,
        sortOrder: selectedProvider.sortOrder,
      });
      toast.success(t("settings.providers.saved"));
    } catch (error) {
      setFeedback(errorText(error, t));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCommon = async () => {
    setCommonSaving(true);
    setFeedback(null);
    try {
      await updateCommon(cliType, commonDraft);
      toast.success(t("settings.providers.commonSaved"));
    } catch (error) {
      setFeedback(errorText(error, t));
    } finally {
      setCommonSaving(false);
    }
  };

  const handleAddKey = async () => {
    if (!selectedProvider) return;
    setKeySaving(true);
    setFeedback(null);
    try {
      await createKey(selectedProvider.id, { label: keyLabel, secret: keySecret, sortOrder: selectedProvider.keys.length });
      setKeyLabel("");
      setKeySecret("");
      toast.success(t("settings.providers.keyAdded"));
    } catch (error) {
      setFeedback(errorText(error, t));
    } finally {
      setKeySaving(false);
    }
  };

  const handleDeleteProvider = async () => {
    if (!selectedProvider) return;
    const confirmed = await confirm({
      title: t("settings.providers.deleteTitle"),
      message: t("settings.providers.deleteMessage", { name: selectedProvider.name }),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await deleteProvider(selectedProvider.id);
      toast.success(t("settings.providers.deleted"));
    } catch (error) {
      setFeedback(errorText(error, t));
    }
  };

  const handleDuplicate = async () => {
    if (!selectedProvider) return;
    try {
      await duplicateProvider(selectedProvider.id);
      toast.success(t("settings.providers.duplicated"));
    } catch (error) {
      setFeedback(errorText(error, t));
    }
  };

  const handleToggleStatus = async () => {
    if (!selectedProvider) return;
    const next: ProviderStatus = selectedProvider.status === "disabled" ? "ready" : "disabled";
    try {
      await setProviderStatus(selectedProvider.id, next);
      toast.success(t(next === "ready" ? "settings.providers.enabled" : "settings.providers.disabled"));
    } catch (error) {
      setFeedback(errorText(error, t));
    }
  };

  const handlePreview = async () => {
    if (!selectedProvider) return;
    try {
      const preview = await previewEffective(selectedProvider.id);
      setPreviewText(preview.effectiveText);
    } catch (error) {
      setFeedback(errorText(error, t));
    }
  };

  const handleEditKey = async (keyId: string, label: string, sortOrder: number) => {
    if (!selectedProvider) return;
    const nextLabel = await prompt({ title: t("settings.providers.editKeyTitle"), initialValue: label });
    if (!nextLabel) return;
    try {
      await updateKey(selectedProvider.id, keyId, { label: nextLabel, secretAction: "keep", sortOrder });
      toast.success(t("settings.providers.keySaved"));
    } catch (error) {
      setFeedback(errorText(error, t));
    }
  };

  const handleActivateKey = async (keyId: string) => {
    if (!selectedProvider) return;
    const confirmed = await confirm({
      title: t("settings.providers.activateTitle"),
      message: t("settings.providers.activateMessage"),
    });
    if (!confirmed) return;
    try {
      await activateKey(selectedProvider.id, keyId);
      toast.success(t("settings.providers.keyActivated"));
    } catch (error) {
      setFeedback(errorText(error, t));
    }
  };

  const handleDeleteKey = async (keyId: string, isActive: boolean) => {
    if (!selectedProvider) return;
    if (isActive && selectedProvider.keys.length > 1 && !replacementKeyId) {
      setFeedback(t("settings.providers.error.replacementRequired"));
      return;
    }
    try {
      await deleteKey(selectedProvider.id, keyId, isActive ? replacementKeyId ?? undefined : undefined);
      setReplacementKeyId(null);
      toast.success(t("settings.providers.keyDeleted"));
    } catch (error) {
      setFeedback(errorText(error, t));
    }
  };

  const statusActionDisabled = !selectedProvider || selectedProvider.status === "draft" || selectedProvider.keyCount === 0;

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end">
        <SegmentedControl
          value={cliType}
          onChange={changeCliType}
          data={CLI_TYPES.map((type) => ({ value: type, label: t(CLI_LABEL_KEYS[type]) }))}
          aria-label={t("settings.providers.cliType")}
        />
        <Group gap="xs">
          <Button variant="subtle" leftSection={<RefreshCw size={15} />} onClick={() => void loadProviders().catch(() => undefined)} loading={loading}>
            {t("settings.providers.refresh")}
          </Button>
          <Button variant="subtle" leftSection={<ImportIcon size={15} />} disabled title={t("settings.providers.importComingSoon")}>
            {t("settings.providers.import")}
          </Button>
          <Button leftSection={<Plus size={15} />} onClick={() => void handleCreate()}>
            {t("settings.providers.create")}
          </Button>
        </Group>
      </Group>

      <Text size="xs" c="dimmed">{t("settings.providers.nativeHint")}</Text>
      {storeError && <Text size="sm" c="red">{errorText(storeError, t)}</Text>}
      {feedback && <Text size="sm" c="red">{feedback}</Text>}

      <Group align="stretch" wrap="nowrap" gap="md">
        <Paper withBorder p="xs" w={250} style={{ flexShrink: 0 }}>
          <Stack gap={4}>
            {!loaded && loading && <Text size="sm" c="dimmed" p="sm">{t("settings.providers.loading")}</Text>}
            {loaded && filteredProviders.length === 0 && <Text size="sm" c="dimmed" p="sm">{t("settings.providers.empty")}</Text>}
            {filteredProviders.map((provider) => (
              <Button
                key={provider.id}
                variant={provider.id === selectedProvider?.id ? "light" : "subtle"}
                justify="space-between"
                onClick={() => void selectProvider(provider.id)}
                styles={{ inner: { justifyContent: "space-between" } }}
              >
                <Box style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{provider.name}</Box>
                <Badge size="xs" color={providerStatusColor(provider.status)}>{provider.keyCount}</Badge>
              </Button>
            ))}
          </Stack>
        </Paper>

        <Stack gap="md" style={{ flex: 1, minWidth: 0 }}>
          {!selectedProvider && <Paper withBorder p="xl"><Text c="dimmed">{t("settings.providers.selectHint")}</Text></Paper>}
          {selectedProvider && (
            <>
              <Paper withBorder p="md">
                <Stack gap="sm">
                  <Group justify="space-between" align="flex-start">
                    <div>
                      <Text fw={600}>{selectedProvider.name}</Text>
                      <Text size="xs" c="dimmed">{t("settings.providers.configFormat", { format: selectedProvider.configFormat.toUpperCase() })}</Text>
                    </div>
                    <Badge color={providerStatusColor(selectedProvider.status)}>{statusText(selectedProvider.status, t)}</Badge>
                  </Group>
                  <TextInput label={t("settings.providers.name")} value={nameDraft} onChange={(event) => setNameDraft(event.currentTarget.value)} />
                  <Checkbox label={t("settings.providers.inheritCommon")} checked={inheritCommonDraft} onChange={(event) => setInheritCommonDraft(event.currentTarget.checked)} />
                  <Textarea
                    label={t("settings.providers.config")}
                    description={t("settings.providers.configDescription", { format: selectedProvider.configFormat.toUpperCase() })}
                    value={configDraft}
                    onChange={(event) => setConfigDraft(event.currentTarget.value)}
                    minRows={8}
                    autosize
                    styles={{ input: { fontFamily: "var(--font-ui-mono)", fontSize: 12 } }}
                  />
                  <Group justify="flex-end">
                    <Button variant="subtle" color="red" leftSection={<Trash2 size={15} />} onClick={() => void handleDeleteProvider()}>
                      {t("settings.providers.delete")}
                    </Button>
                    <Button variant="subtle" leftSection={<Copy size={15} />} onClick={() => void handleDuplicate()}>
                      {t("settings.providers.duplicate")}
                    </Button>
                    <Button leftSection={<Save size={15} />} onClick={() => void handleSaveProvider()} loading={saving}>
                      {t("settings.providers.save")}
                    </Button>
                    <Button variant="light" leftSection={<Eye size={15} />} onClick={() => void handlePreview()}>
                      {t("settings.providers.preview")}
                    </Button>
                  </Group>
                  <Button variant="light" disabled={statusActionDisabled} onClick={() => void handleToggleStatus()}>
                    {selectedProvider.status === "disabled" ? t("settings.providers.enable") : t("settings.providers.disable")}
                  </Button>
                </Stack>
              </Paper>

              <Paper withBorder p="md">
                <Stack gap="sm">
                  <Group gap="xs"><KeyRound size={16} /><Text fw={600}>{t("settings.providers.keysTitle")}</Text></Group>
                  <Text size="xs" c="dimmed">{t("settings.providers.keysDescription")}</Text>
                  {selectedProvider.keys.map((key) => (
                    <Box key={key.id} p="xs" style={{ border: "1px solid var(--mantine-color-gray-3)", borderRadius: 8 }}>
                      <Group justify="space-between" wrap="nowrap">
                        <Box style={{ minWidth: 0 }}>
                          <Group gap="xs"><Text size="sm" fw={500}>{key.label}</Text>{key.isActive && <Badge size="xs" color="green">{t("settings.providers.active")}</Badge>}</Group>
                          <Text size="xs" c="dimmed">{key.secretHint}</Text>
                        </Box>
                        <Group gap={4} wrap="nowrap">
                          {!key.isActive && <Button size="xs" variant="light" onClick={() => void handleActivateKey(key.id)}>{t("settings.providers.activate")}</Button>}
                          <Button size="xs" variant="subtle" onClick={() => void handleEditKey(key.id, key.label, key.sortOrder)} aria-label={t("settings.providers.editKey")}><Pencil size={14} /></Button>
                          <Button size="xs" variant="subtle" color="red" onClick={() => void handleDeleteKey(key.id, key.isActive)} aria-label={t("settings.providers.deleteKey")}><Trash2 size={14} /></Button>
                        </Group>
                      </Group>
                      {key.isActive && selectedProvider.keys.length > 1 && (
                        <Select
                          mt="xs"
                          size="xs"
                          clearable
                          value={replacementKeyId}
                          onChange={setReplacementKeyId}
                          label={t("settings.providers.replacementKey")}
                          placeholder={t("settings.providers.replacementKeyPlaceholder")}
                          data={selectedProvider.keys.filter((candidate) => candidate.id !== key.id).map((candidate) => ({ value: candidate.id, label: candidate.label }))}
                        />
                      )}
                    </Box>
                  ))}
                  <Divider />
                  <TextInput label={t("settings.providers.keyLabel")} value={keyLabel} onChange={(event) => setKeyLabel(event.currentTarget.value)} placeholder={t("settings.providers.keyLabelPlaceholder")} />
                  <TextInput type="password" label={t("settings.providers.keySecret")} value={keySecret} onChange={(event) => setKeySecret(event.currentTarget.value)} placeholder={t("settings.providers.keySecretPlaceholder")} />
                  <Group justify="flex-end"><Button leftSection={<Plus size={15} />} onClick={() => void handleAddKey()} loading={keySaving} disabled={!keyLabel.trim() || !keySecret}>{t("settings.providers.addKey")}</Button></Group>
                  <Text size="xs" c="dimmed">{t("settings.providers.plaintextNotice")}</Text>
                </Stack>
              </Paper>

              <Paper withBorder p="md">
                <Stack gap="sm">
                  <Group justify="space-between"><Text fw={600}>{t("settings.providers.commonTitle")}</Text><Badge variant="light">{configFormatForCliType(cliType).toUpperCase()}</Badge></Group>
                  <Text size="xs" c="dimmed">{t("settings.providers.commonDescription")}</Text>
                  <Textarea value={commonDraft} onChange={(event) => setCommonDraft(event.currentTarget.value)} minRows={5} autosize styles={{ input: { fontFamily: "var(--font-ui-mono)", fontSize: 12 } }} />
                  <Group justify="flex-end"><Button leftSection={<Save size={15} />} onClick={() => void handleSaveCommon()} loading={commonSaving}>{t("settings.providers.saveCommon")}</Button></Group>
                </Stack>
              </Paper>
            </>
          )}
        </Stack>
      </Group>
      {confirmDialog}
      {promptDialog}
      <Modal opened={previewText !== null} onClose={() => setPreviewText(null)} title={t("settings.providers.previewTitle")} size="lg">
        <Textarea value={previewText ?? ""} readOnly minRows={14} autosize styles={{ input: { fontFamily: "var(--font-ui-mono)", fontSize: 12 } }} aria-label={t("settings.providers.previewTitle")} />
      </Modal>
    </Stack>
  );
}
