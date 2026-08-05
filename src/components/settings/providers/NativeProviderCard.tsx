import { ActionIcon, Badge, Card, Group, Stack, Switch, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { ChevronDown, ChevronUp, Copy, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { NativeProviderCard as NativeProviderCardData } from "./nativeProviderTypes";

interface NativeProviderCardProps {
  provider: NativeProviderCardData;
  selected: boolean;
  busy: boolean;
  isFirst: boolean;
  isLast: boolean;
  onSelect: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onEnabledChange: (enabled: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}
export function NativeProviderCard({
  provider,
  selected,
  busy,
  isFirst,
  isLast,
  onSelect,
  onDuplicate,
  onDelete,
  onEnabledChange,
  onMoveUp,
  onMoveDown,
}: NativeProviderCardProps) {
  const { t } = useI18n();
  const endpoint = provider.baseUrl || t("providerCatalog.notConfigured");
  const endpointLabel = t(provider.appType === "codex"
    ? "providerCatalog.requestUrl"
    : "providerCatalog.baseUrl");
  const model = provider.model || t("providerCatalog.notConfigured");

  return (
    <Card
      withBorder
      radius="lg"
      padding="sm"
      role="group"
      aria-label={t("providerCatalog.selectProvider", { name: provider.name })}
      className={`cursor-pointer transition-colors ${selected ? "border-primary bg-primary/10" : "border-border/70 bg-surface-container-low"}`}
      onClick={onSelect}
    >
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <UnstyledButton
            type="button"
            className="min-w-0 flex-1 rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            aria-pressed={selected}
            aria-label={t("providerCatalog.selectProvider", { name: provider.name })}
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
          >
            <Stack gap={2}>
              <Text fw={600} truncate title={provider.name}>{provider.name}</Text>
              <Text size="xs" c="dimmed" truncate title={endpoint}>
                {endpointLabel}: {endpoint}
              </Text>
              <Text size="xs" c="dimmed" truncate title={model}>
                {t("providerCatalog.model")}: {model}
              </Text>
            </Stack>
          </UnstyledButton>
          <Group gap={2} wrap="nowrap" onClick={(event) => event.stopPropagation()}>
            <Tooltip label={t("providerCatalog.moveUp")}>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={t("providerCatalog.moveUp")}
                disabled={busy || isFirst}
                onClick={onMoveUp}
              >
                <ChevronUp size={15} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("providerCatalog.moveDown")}>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={t("providerCatalog.moveDown")}
                disabled={busy || isLast}
                onClick={onMoveDown}
              >
                <ChevronDown size={15} />
              </ActionIcon>
            </Tooltip>
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
