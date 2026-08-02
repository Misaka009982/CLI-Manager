import { useState } from "react";
import { ActionIcon, Badge, Button, Card, Group, Stack, Switch, Text, Tooltip } from "@mantine/core";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useAppConfirm } from "@/components/ui/useAppConfirm";
import { NativeProviderKeyFormModal } from "./NativeProviderKeyFormModal";
import type {
  NativeProviderAppType,
  NativeProviderKeyCreateInput,
  NativeProviderKeySummary,
} from "./nativeProviderTypes";

interface NativeProviderKeySectionProps {
  appType: NativeProviderAppType;
  providerId: string;
  keys: NativeProviderKeySummary[];
  action: string | null;
  onCreate: (input: NativeProviderKeyCreateInput) => Promise<void>;
  onActivate: (keyId: string) => Promise<void>;
  onSetEnabled: (keyId: string, enabled: boolean) => Promise<void>;
  onDelete: (keyId: string) => Promise<void>;
}

export function NativeProviderKeySection({
  appType,
  providerId,
  keys,
  action,
  onCreate,
  onActivate,
  onSetEnabled,
  onDelete,
}: NativeProviderKeySectionProps) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useAppConfirm();
  const [formOpen, setFormOpen] = useState(false);

  const handleCreate = async (input: NativeProviderKeyCreateInput) => {
    await onCreate(input);
    setFormOpen(false);
  };

  const handleDelete = async (key: NativeProviderKeySummary) => {
    const confirmed = await confirm({
      title: t("providerCatalog.deleteKeyTitle"),
      message: t("providerCatalog.deleteKeyMessage", { name: key.label }),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (confirmed) await onDelete(key.id);
  };

  return (
    <>
      <Card withBorder radius="lg" padding="md" className="border-border/70 bg-surface-container-low">
        <Group justify="space-between" align="center" mb="sm">
          <Group gap="xs">
            <KeyRound size={16} />
            <Text fw={600}>{t("providerCatalog.keysTitle")}</Text>
            <Badge size="sm" variant="light" color="gray">{keys.length}</Badge>
          </Group>
          <Button size="compact-sm" color="cliPrimary" leftSection={<Plus size={15} />} onClick={() => setFormOpen(true)}>
            {t("providerCatalog.addKey")}
          </Button>
        </Group>

        {keys.length === 0 ? (
          <Text size="sm" c="dimmed">{t("providerCatalog.noKeysDescription")}</Text>
        ) : (
          <Stack gap="xs">
            {keys.map((key) => (
              <Group key={key.id} justify="space-between" align="center" wrap="nowrap" className="rounded-lg border border-border/60 bg-surface-container-lowest px-3 py-2">
                <Stack gap={2} miw={0}>
                  <Group gap="xs" wrap="wrap">
                    <Text size="sm" fw={600} truncate>{key.label}</Text>
                    {key.isActive && <Badge size="xs" color="cliPrimary">{t("providerCatalog.active")}</Badge>}
                    {!key.enabled && <Badge size="xs" color="gray">{t("providerCatalog.disabled")}</Badge>}
                  </Group>
                  <Text size="xs" c="dimmed" ff="monospace" truncate>{key.maskedApiKey}</Text>
                  {key.tags.length > 0 && (
                    <Text size="xs" c="dimmed" truncate>{key.tags.join(" · ")}</Text>
                  )}
                </Stack>
                <Group gap={4} wrap="nowrap">
                  {!key.isActive && (
                    <Button
                      size="compact-xs"
                      variant="light"
                      color="cliPrimary"
                      loading={action === "activate-key"}
                      disabled={Boolean(action) || !key.enabled}
                      onClick={() => void onActivate(key.id).catch(() => undefined)}
                    >
                      {t("providerCatalog.activate")}
                    </Button>
                  )}
                  <Tooltip label={key.enabled ? t("providerCatalog.disable") : t("providerCatalog.enable")}>
                    <Switch
                      size="sm"
                      color="cliPrimary"
                      checked={key.enabled}
                      disabled={Boolean(action) || key.isActive}
                      aria-label={key.enabled ? t("providerCatalog.disable") : t("providerCatalog.enable")}
                      onChange={(event) => void onSetEnabled(key.id, event.currentTarget.checked).catch(() => undefined)}
                    />
                  </Tooltip>
                  <Tooltip label={t("providerCatalog.deleteKey")}>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={t("providerCatalog.deleteKey")}
                      disabled={Boolean(action) || key.isActive}
                      onClick={() => void handleDelete(key).catch(() => undefined)}
                    >
                      <Trash2 size={15} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Group>
            ))}
          </Stack>
        )}
      </Card>

      {confirmDialog}
      <NativeProviderKeyFormModal
        opened={formOpen}
        appType={appType}
        providerId={providerId}
        loading={action === "create-key"}
        onClose={() => setFormOpen(false)}
        onSubmit={handleCreate}
      />
    </>
  );
}
