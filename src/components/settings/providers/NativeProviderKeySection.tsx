import { useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Switch,
  Text,
  Tooltip,
} from "@mantine/core";
import { ChevronDown, ChevronUp, Eye, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useAppConfirm } from "@/components/ui/useAppConfirm";
import { NativeProviderKeyFormModal } from "./NativeProviderKeyFormModal";
import { NativeProviderKeyReplacementModal } from "./NativeProviderKeyReplacementModal";
import { NativeProviderKeyRevealModal } from "./NativeProviderKeyRevealModal";
import type {
  NativeProviderAppType,
  NativeProviderKeyCreateInput,
  NativeProviderKeySummary,
  NativeProviderKeyUpdateInput,
} from "./nativeProviderTypes";

interface NativeProviderKeySectionProps {
  appType: NativeProviderAppType;
  providerId: string;
  keys: NativeProviderKeySummary[];
  action: string | null;
  onCreate: (input: NativeProviderKeyCreateInput) => Promise<void>;
  onUpdate: (input: NativeProviderKeyUpdateInput) => Promise<void>;
  onReveal: (keyId: string) => Promise<string>;
  onActivate: (keyId: string) => Promise<void>;
  onSetEnabled: (keyId: string, enabled: boolean) => Promise<void>;
  onDelete: (keyId: string, replacementKeyId?: string) => Promise<void>;
  onReorder: (keyIds: string[]) => Promise<void>;
}

export function NativeProviderKeySection({
  appType,
  providerId,
  keys,
  action,
  onCreate,
  onUpdate,
  onReveal,
  onActivate,
  onSetEnabled,
  onDelete,
  onReorder,
}: NativeProviderKeySectionProps) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useAppConfirm();
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [editingKey, setEditingKey] = useState<NativeProviderKeySummary | null>(null);
  const [revealedKey, setRevealedKey] = useState<{ label: string; value: string } | null>(null);
  const [replacementKey, setReplacementKey] = useState<NativeProviderKeySummary | null>(null);

  const handleCreate = async (input: NativeProviderKeyCreateInput) => {
    await onCreate(input);
    setFormMode(null);
  };

  const handleUpdate = async (input: NativeProviderKeyUpdateInput) => {
    await onUpdate(input);
    setFormMode(null);
    setEditingKey(null);
  };

  const handleFormSubmit = async (
    input: NativeProviderKeyCreateInput | NativeProviderKeyUpdateInput,
  ) => {
    if ("id" in input) {
      await handleUpdate(input);
    } else {
      await handleCreate(input);
    }
  };

  const handleDelete = async (key: NativeProviderKeySummary) => {
    if (key.isActive) {
      setReplacementKey(key);
      return;
    }
    const confirmed = await confirm({
      title: t("providerCatalog.deleteKeyTitle"),
      message: t("providerCatalog.deleteKeyMessage", { name: key.label }),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (confirmed) await onDelete(key.id);
  };

  const handleReplacement = async (replacementKeyId: string) => {
    if (!replacementKey) return;
    await onDelete(replacementKey.id, replacementKeyId);
    setReplacementKey(null);
  };

  const handleReveal = async (key: NativeProviderKeySummary) => {
    const value = await onReveal(key.id);
    setRevealedKey({ label: key.label, value });
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= keys.length) return;
    const next = [...keys];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    await onReorder(next.map((key) => key.id));
  };

  return (
    <>
      <Card withBorder radius="lg" padding="md" className="min-w-0 overflow-hidden border-border/70 bg-surface-container-low">
        <Group justify="space-between" align="center" mb="sm" wrap="wrap">
          <Group gap="xs">
            <KeyRound size={16} />
            <Text fw={600}>{t("providerCatalog.keysTitle")}</Text>
            <Badge size="sm" variant="light" color="gray">{keys.length}</Badge>
          </Group>
          <Button
            size="compact-sm"
            color="cliPrimary"
            leftSection={<Plus size={15} />}
            disabled={Boolean(action)}
            onClick={() => {
              setEditingKey(null);
              setFormMode("create");
            }}
          >
            {t("providerCatalog.addKey")}
          </Button>
        </Group>

        {keys.length === 0 ? (
          <Text size="sm" c="dimmed">{t("providerCatalog.noKeysDescription")}</Text>
        ) : (
          <Stack gap="xs">
            {keys.map((key, index) => (
              <Group
                key={key.id}
                justify="space-between"
                align="center"
                wrap="wrap"
                className="min-w-0 rounded-lg border border-border/60 bg-surface-container-lowest px-3 py-2"
              >
                <Stack gap={2} miw={0} className="min-w-0 flex-1">
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
                  <Tooltip label={t("providerCatalog.moveKeyUp")}>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={t("providerCatalog.moveKeyUp")}
                      disabled={Boolean(action) || index === 0}
                      onClick={() => void handleMove(index, -1).catch(() => undefined)}
                    >
                      <ChevronUp size={15} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label={t("providerCatalog.moveKeyDown")}>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={t("providerCatalog.moveKeyDown")}
                      disabled={Boolean(action) || index === keys.length - 1}
                      onClick={() => void handleMove(index, 1).catch(() => undefined)}
                    >
                      <ChevronDown size={15} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label={t("providerCatalog.editKey")}>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={t("providerCatalog.editKey")}
                      disabled={Boolean(action)}
                      onClick={() => {
                        setEditingKey(key);
                        setFormMode("edit");
                      }}
                    >
                      <Pencil size={15} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label={t("providerCatalog.revealKey")}>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={t("providerCatalog.revealKey")}
                      disabled={Boolean(action)}
                      onClick={() => void handleReveal(key).catch(() => undefined)}
                    >
                      <Eye size={15} />
                    </ActionIcon>
                  </Tooltip>
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
                  <Tooltip label={t(key.isActive ? "providerCatalog.replaceKey" : "providerCatalog.deleteKey")}>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={t(key.isActive ? "providerCatalog.replaceKey" : "providerCatalog.deleteKey")}
                      disabled={Boolean(action)}
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
        opened={formMode !== null}
        mode={formMode ?? "create"}
        appType={appType}
        providerId={providerId}
        providerKey={editingKey}
        loading={action === "create-key" || action === "update-key"}
        onClose={() => {
          setFormMode(null);
          setEditingKey(null);
        }}
        onSubmit={handleFormSubmit}
      />
      <NativeProviderKeyRevealModal
        opened={revealedKey !== null}
        label={revealedKey?.label ?? ""}
        value={revealedKey?.value ?? ""}
        onClose={() => setRevealedKey(null)}
      />
      <NativeProviderKeyReplacementModal
        opened={replacementKey !== null}
        activeKey={replacementKey}
        keys={keys}
        loading={action === "delete-key"}
        onClose={() => setReplacementKey(null)}
        onConfirm={handleReplacement}
      />
    </>
  );
}
