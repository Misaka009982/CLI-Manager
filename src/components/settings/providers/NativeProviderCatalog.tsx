import { useEffect, useRef, useState } from "react";
import { Button, Card, Group, Loader, ScrollArea, Stack, Text } from "@mantine/core";
import { FileDown, Plus, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { NativeProviderCard } from "./NativeProviderCard";
import type { NativeProviderCard as NativeProviderCardData } from "./nativeProviderTypes";

interface NativeProviderCatalogProps {
  providers: NativeProviderCardData[];
  allProviders: NativeProviderCardData[];
  selectedProviderId: string | null;
  loading: boolean;
  hasSearchQuery: boolean;
  busy: boolean;
  onSelect: (providerId: string) => void;
  onCreate: () => void;
  onOpenImport: () => void;
  onRefresh: () => void;
  onDuplicate: (providerId: string) => void;
  onDelete: (providerId: string) => void;
  onEnabledChange: (providerId: string, enabled: boolean) => void;
  onReorder: (providerIds: string[]) => void;
}

export function NativeProviderCatalog({
  providers,
  allProviders,
  selectedProviderId,
  loading,
  hasSearchQuery,
  busy,
  onSelect,
  onCreate,
  onOpenImport,
  onRefresh,
  onDuplicate,
  onDelete,
  onEnabledChange,
  onReorder,
}: NativeProviderCatalogProps) {
  const { t } = useI18n();
  const [draggedProviderId, setDraggedProviderId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const moveProvider = (providerId: string, offset: number) => {
    const ids = allProviders.map((provider) => provider.id);
    const sourceIndex = ids.indexOf(providerId);
    const targetIndex = sourceIndex + offset;
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= ids.length) return;
    [ids[sourceIndex], ids[targetIndex]] = [ids[targetIndex], ids[sourceIndex]];
    onReorder(ids);
  };

  const moveProviderBefore = (providerId: string, targetProviderId: string) => {
    if (providerId === targetProviderId) return;
    const ids = allProviders.map((provider) => provider.id);
    const sourceIndex = ids.indexOf(providerId);
    const targetIndex = ids.indexOf(targetProviderId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    ids.splice(sourceIndex, 1);
    ids.splice(ids.indexOf(targetProviderId), 0, providerId);
    onReorder(ids);
  };

  const currentProvider = allProviders.find((provider) => provider.isCurrent);

  // 选中项（含切换 appType 后自动落到的全局启用供应商）滚入可见区域，避免它落在长列表的折叠位置。
  useEffect(() => {
    if (loading || !selectedProviderId) return;
    const viewport = listRef.current;
    const target = viewport?.querySelector<HTMLElement>(
      `[data-provider-id="${CSS.escape(selectedProviderId)}"]`,
    );
    target?.scrollIntoView({ block: "nearest" });
  }, [loading, providers, selectedProviderId]);

  return (
    <Card withBorder radius="lg" padding="md" className="flex h-full min-h-0 min-w-0 flex-col border-border/70 bg-surface-container-low">
      <Group justify="space-between" align="center" mb="sm" wrap="wrap">
        <Text fw={600}>{t("providerCatalog.title")}</Text>
        <Group gap={4}>
          <Button
            size="compact-sm"
            variant="light"
            color="gray"
            leftSection={<FileDown size={15} />}
            onClick={onOpenImport}
          >
            {t("providerCatalog.import.open")}
          </Button>
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

      {currentProvider && (
        <Card withBorder radius="md" padding="xs" mb="sm" className="border-primary/40 bg-primary/5">
          <Text size="xs" c="dimmed">{t("providerCatalog.currentStrip")}</Text>
          <Text size="sm" fw={600} truncate title={currentProvider.name}>{currentProvider.name}</Text>
        </Card>
      )}

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
        <ScrollArea type="auto" offsetScrollbars viewportRef={listRef} className="min-h-0 flex-1">
          <Stack gap="xs" pr="xs">
            {providers.map((provider) => (
              <div
                key={provider.id}
                data-provider-id={provider.id}
                draggable={!busy}
                aria-label={t("providerCatalog.reorder")}
                onDragStart={() => setDraggedProviderId(provider.id)}
                onDragEnd={() => setDraggedProviderId(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (draggedProviderId) moveProviderBefore(draggedProviderId, provider.id);
                  setDraggedProviderId(null);
                }}
              >
                <NativeProviderCard
                  provider={provider}
                  selected={provider.id === selectedProviderId}
                  busy={busy}
                  isFirst={allProviders[0]?.id === provider.id}
                  isLast={allProviders[allProviders.length - 1]?.id === provider.id}
                  onSelect={() => onSelect(provider.id)}
                  onDuplicate={() => onDuplicate(provider.id)}
                  onDelete={() => onDelete(provider.id)}
                  onEnabledChange={(enabled) => onEnabledChange(provider.id, enabled)}
                  onMoveUp={() => moveProvider(provider.id, -1)}
                  onMoveDown={() => moveProvider(provider.id, 1)}
                />
              </div>
            ))}
          </Stack>
        </ScrollArea>
      )}
    </Card>
  );
}
