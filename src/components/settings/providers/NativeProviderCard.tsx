import { ActionIcon, Badge, Card, Group, Stack, Switch, Text, Tooltip } from "@mantine/core";
import { Copy, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { NativeProviderCard as NativeProviderCardData } from "./nativeProviderTypes";

interface NativeProviderCardProps {
  provider: NativeProviderCardData;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onEnabledChange: (enabled: boolean) => void;
}
export function NativeProviderCard({
  provider,
  selected,
  busy,
  onSelect,
  onDuplicate,
  onDelete,
  onEnabledChange,
}: NativeProviderCardProps) {
  const { t } = useI18n();
  const endpoint = provider.baseUrl || provider.model || t("providerCatalog.notConfigured");

  return (
    <Card
      withBorder
      radius="lg"
      padding="sm"
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      className={`cursor-pointer transition-colors ${selected ? "border-primary bg-primary/10" : "border-border/70 bg-surface-container-low"}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} miw={0}>
            <Text fw={600} truncate title={provider.name}>{provider.name}</Text>
            <Text size="xs" c="dimmed" truncate title={endpoint}>{endpoint}</Text>
          </Stack>
          <Group gap={2} wrap="nowrap" onClick={(event) => event.stopPropagation()}>
            <Tooltip label={t("providerCatalog.duplicate")}>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={t("providerCatalog.duplicate")}
                disabled={busy}
                onClick={onDuplicate}
              >
                <Copy size={15} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("providerCatalog.delete")}>
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label={t("providerCatalog.delete")}
                disabled={busy || provider.isCurrent}
                onClick={onDelete}
              >
                <Trash2 size={15} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>

        <Group gap={6} wrap="wrap">
          {provider.isCurrent && <Badge size="sm" color="cliPrimary">{t("providerCatalog.current")}</Badge>}
          {!provider.enabled && <Badge size="sm" color="gray">{t("providerCatalog.disabled")}</Badge>}
          {!provider.settingsValid && <Badge size="sm" color="yellow">{t("providerCatalog.invalidConfig")}</Badge>}
          <Badge size="sm" variant="light" color="gray">
            {t("providerCatalog.keyCount", { count: provider.keyCount })}
          </Badge>
        </Group>

        <Group justify="space-between" align="center" gap="xs" onClick={(event) => event.stopPropagation()}>
          <Text size="xs" c="dimmed" truncate>
            {provider.activeKeyLabel
              ? t("providerCatalog.activeKey", { name: provider.activeKeyLabel })
              : t("providerCatalog.noActiveKey")}
          </Text>
          <Switch
            size="sm"
            color="cliPrimary"
            checked={provider.enabled}
            disabled={busy || provider.isCurrent}
            aria-label={provider.enabled ? t("providerCatalog.disable") : t("providerCatalog.enable")}
            onChange={(event) => onEnabledChange(event.currentTarget.checked)}
          />
        </Group>
      </Stack>
    </Card>
  );
}
