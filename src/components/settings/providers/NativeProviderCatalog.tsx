import { Button, Card, Group, Loader, ScrollArea, Stack, Text } from "@mantine/core";
import { Plus, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { NativeProviderCard } from "./NativeProviderCard";
import type { NativeProviderCard as NativeProviderCardData } from "./nativeProviderTypes";

interface NativeProviderCatalogProps {
  providers: NativeProviderCardData[];
  selectedProviderId: string | null;
  loading: boolean;
  hasSearchQuery: boolean;
  busy: boolean;
  onSelect: (providerId: string) => void;
  onCreate: () => void;
  onRefresh: () => void;
  onDuplicate: (providerId: string) => void;
  onDelete: (providerId: string) => void;
  onEnabledChange: (providerId: string, enabled: boolean) => void;
}
export function NativeProviderCatalog({
  providers,
  selectedProviderId,
  loading,
  hasSearchQuery,
  busy,
  onSelect,
  onCreate,
  onRefresh,
  onDuplicate,
  onDelete,
  onEnabledChange,
}: NativeProviderCatalogProps) {
  const { t } = useI18n();

  return (
    <Card withBorder radius="lg" padding="md" className="flex min-h-[520px] min-w-0 flex-col border-border/70 bg-surface-container-low">
      <Group justify="space-between" align="center" mb="sm">
        <Text fw={600}>{t("providerCatalog.title")}</Text>
        <Group gap={4}>
          <Button
            size="compact-sm"
            variant="subtle"
            color="gray"
            loading={loading}
            aria-label={t("common.refresh")}
            onClick={onRefresh}
          >
            <RefreshCw size={15} />
          </Button>
          <Button size="compact-sm" color="cliPrimary" leftSection={<Plus size={15} />} onClick={onCreate}>
            {t("providerCatalog.add")}
          </Button>
        </Group>
      </Group>

      {loading ? (
        <Stack align="center" justify="center" className="flex-1">
          <Loader size="sm" color="cliPrimary" />
          <Text size="sm" c="dimmed">{t("providerCatalog.loading")}</Text>
        </Stack>
      ) : providers.length === 0 ? (
        <Stack align="center" justify="center" className="flex-1 px-6 text-center">
          <Text fw={600}>{t(hasSearchQuery ? "providerCatalog.noSearchResults" : "providerCatalog.emptyTitle")}</Text>
          <Text size="sm" c="dimmed">
            {t(hasSearchQuery ? "providerCatalog.noSearchResultsDescription" : "providerCatalog.emptyDescription")}
          </Text>
          {!hasSearchQuery && (
            <Button size="compact-sm" color="cliPrimary" leftSection={<Plus size={15} />} onClick={onCreate}>
              {t("providerCatalog.add")}
            </Button>
          )}
        </Stack>
      ) : (
        <ScrollArea type="auto" offsetScrollbars className="min-h-0 flex-1">
          <Stack gap="xs" pr="xs">
            {providers.map((provider) => (
              <NativeProviderCard
                key={provider.id}
                provider={provider}
                selected={provider.id === selectedProviderId}
                busy={busy}
                onSelect={() => onSelect(provider.id)}
                onDuplicate={() => onDuplicate(provider.id)}
                onDelete={() => onDelete(provider.id)}
                onEnabledChange={(enabled) => onEnabledChange(provider.id, enabled)}
              />
            ))}
          </Stack>
        </ScrollArea>
      )}
    </Card>
  );
}
