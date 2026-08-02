import { useMemo } from "react";
import { Badge, Button, Card, Group, Loader, Stack, Switch, Text } from "@mantine/core";
import { Copy, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { NativeProviderDetail } from "./nativeProviderTypes";

interface NativeProviderEditorProps {
  detail: NativeProviderDetail | null;
  loading: boolean;
  action: string | null;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onEnabledChange: (enabled: boolean) => void;
  onSetCurrent: () => void;
}
function formatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function NativeProviderEditor({
  detail,
  loading,
  action,
  onEdit,
  onDuplicate,
  onDelete,
  onEnabledChange,
  onSetCurrent,
}: NativeProviderEditorProps) {
  const { t } = useI18n();
  const configPreview = useMemo(
    () => (detail ? formatJson(detail.effectiveSettingsConfig) : ""),
    [detail]
  );

  if (loading) {
    return (
      <Card withBorder radius="lg" padding="md" className="flex min-h-[260px] items-center justify-center border-border/70 bg-surface-container-low">
        <Loader size="sm" color="cliPrimary" />
      </Card>
    );
  }

  if (!detail) {
    return (
      <Card withBorder radius="lg" padding="md" className="flex min-h-[260px] items-center justify-center border-border/70 bg-surface-container-low">
        <Text size="sm" c="dimmed">{t("providerCatalog.selectDescription")}</Text>
      </Card>
    );
  }

  const { card } = detail;
  const currentBlocked = !card.enabled || !card.activeKeyLabel;

  return (
    <Card withBorder radius="lg" padding="md" className="border-border/70 bg-surface-container-low">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={4} miw={0}>
            <Group gap="xs" wrap="wrap">
              <Text fw={700} size="lg" truncate>{card.name}</Text>
              {card.isCurrent && <Badge color="cliPrimary">{t("providerCatalog.current")}</Badge>}
            </Group>
            <Text size="sm" c="dimmed">{card.category || t("providerCatalog.uncategorized")}</Text>
          </Stack>
          <Switch
            color="cliPrimary"
            checked={card.enabled}
            disabled={Boolean(action) || card.isCurrent}
            aria-label={card.enabled ? t("providerCatalog.disable") : t("providerCatalog.enable")}
            onChange={(event) => onEnabledChange(event.currentTarget.checked)}
          />
        </Group>

        <Group gap={6} wrap="wrap">
          <Button size="compact-sm" variant="light" color="cliPrimary" leftSection={<Pencil size={14} />} onClick={onEdit}>
            {t("common.edit")}
          </Button>
          <Button size="compact-sm" variant="subtle" color="gray" leftSection={<Copy size={14} />} disabled={Boolean(action)} onClick={onDuplicate}>
            {t("providerCatalog.duplicate")}
          </Button>
          <Button size="compact-sm" variant="subtle" color="red" leftSection={<Trash2 size={14} />} disabled={Boolean(action) || card.isCurrent} onClick={onDelete}>
            {t("common.delete")}
          </Button>
          {card.websiteUrl && (
            <Button
              component="a"
              href={card.websiteUrl}
              target="_blank"
              rel="noreferrer"
              size="compact-sm"
              variant="subtle"
              color="gray"
              leftSection={<ExternalLink size={14} />}
            >
              {t("providerCatalog.website")}
            </Button>
          )}
        </Group>

        <div className="grid grid-cols-2 gap-2 text-sm">
          <InfoItem label={t("providerCatalog.baseUrl")} value={card.baseUrl || t("providerCatalog.notConfigured")} />
          <InfoItem label={t("providerCatalog.model")} value={card.model || t("providerCatalog.notConfigured")} />
          <InfoItem label={t("providerCatalog.apiFormat")} value={card.apiFormat || t("providerCatalog.notConfigured")} />
          <InfoItem label={t("providerCatalog.activeKeyLabel")} value={card.activeKeyLabel || t("providerCatalog.noActiveKey")} />
        </div>

        <Stack gap={6}>
          <Group justify="space-between" align="center">
            <Text size="sm" fw={600}>{t("providerCatalog.settingsPreview")}</Text>
            {detail.settingsHasSecret && <Badge size="sm" color="yellow">{t("providerCatalog.secretRedacted")}</Badge>}
          </Group>
          <pre className="max-h-48 overflow-auto rounded-lg border border-border/60 bg-surface-container-lowest p-3 text-xs leading-5 text-text-secondary">
            {configPreview || "{}"}
          </pre>
          <Text size="xs" c="dimmed">{t("providerCatalog.settingsPreviewDescription")}</Text>
        </Stack>

        {!card.isCurrent && (
          <Stack gap={4}>
            <Button
              size="sm"
              color="cliPrimary"
              disabled={currentBlocked || Boolean(action)}
              loading={action === "set-current-provider"}
              onClick={onSetCurrent}
            >
              {t("providerCatalog.setCurrent")}
            </Button>
            {currentBlocked && <Text size="xs" c="dimmed">{t("providerCatalog.setCurrentBlocked")}</Text>}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/50 bg-surface-container-lowest px-3 py-2">
      <Text size="xs" c="dimmed">{label}</Text>
      <Text size="sm" truncate title={value}>{value}</Text>
    </div>
  );
}
