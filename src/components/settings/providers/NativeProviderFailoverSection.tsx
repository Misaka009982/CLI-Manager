import { useEffect, useState } from "react";
import { Accordion, Badge, Button, Group, NumberInput, Paper, Stack, Switch, Text } from "@mantine/core";
import { Save } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { NativeProviderAppType } from "./nativeProviderTypes";
import type { UseNativeProviderRoutingResult } from "./useNativeProviderRouting";

interface NativeProviderFailoverSectionProps {
  appType: NativeProviderAppType;
  state: UseNativeProviderRoutingResult;
}

export function NativeProviderFailoverSection({ appType, state }: NativeProviderFailoverSectionProps) {
  const { t } = useI18n();
  const failover = state.failoverState[appType];
  const [maxRetries, setMaxRetries] = useState(0);
  const busy = Boolean(state.action) || Boolean(state.failoverLoading[appType]);

  useEffect(() => {
    void state.refreshFailover(appType);
  }, [appType, state.refreshFailover]);

  useEffect(() => {
    if (failover) setMaxRetries(failover.config.maxRetries);
  }, [failover]);

  const updateQueue = async (providerId: string, enabled: boolean) => {
    if (!failover) return;
    const providerIds = failover.providers
      .filter((provider) => provider.id === providerId ? enabled : provider.inFailoverQueue)
      .map((provider) => provider.id);
    await state.setFailoverQueue(appType, providerIds);
  };

  const saveConfig = async () => {
    if (!failover) return;
    await state.updateFailoverConfig(appType, {
      ...failover.config,
      maxRetries: Math.max(0, Math.min(32, Math.round(maxRetries))),
    });
  };

  return (
    <Paper withBorder p="md">
      <Stack gap="md">
        <div>
          <Text fw={700}>{t("providerCatalog.failover.title")}</Text>
          <Text size="sm" c="dimmed">{t("providerCatalog.failover.description")}</Text>
        </div>

        {state.failoverLoading[appType] && !failover ? (
          <Text size="sm" c="dimmed">{t("providerCatalog.failover.loading")}</Text>
        ) : failover ? (
          <>
            <Switch
              label={t("providerCatalog.failover.enabled")}
              checked={failover.config.autoFailoverEnabled}
              disabled={busy}
              onChange={(event) => void state.setFailoverEnabled(appType, event.currentTarget.checked)}
            />

            <Group align="flex-end" wrap="wrap">
              <NumberInput
                label={t("providerCatalog.failover.maxRetries")}
                min={0}
                max={32}
                value={maxRetries}
                disabled={busy}
                onChange={(value) => setMaxRetries(typeof value === "number" ? value : Number(value) || 0)}
              />
              <Button variant="light" leftSection={<Save size={15} />} loading={state.action === "failover-config"} onClick={() => void saveConfig()}>
                {t("providerCatalog.failover.save")}
              </Button>
            </Group>

            <Accordion variant="separated" defaultValue="queue">
              <Accordion.Item value="queue">
                <Accordion.Control>{t("providerCatalog.failover.queue")}</Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="xs">
                    <Text size="sm" c="dimmed">{t("providerCatalog.failover.queueDescription")}</Text>
                    {failover.providers.map((provider) => (
                      <Group key={provider.id} justify="space-between" wrap="nowrap">
                        <div>
                          <Text size="sm">{provider.name}</Text>
                          <Text size="xs" c="dimmed">{provider.id}</Text>
                        </div>
                        <Group gap="xs" wrap="nowrap">
                          {provider.isCurrent && <Badge variant="light">{t("providerCatalog.failover.current")}</Badge>}
                          <Badge color={provider.ready ? "green" : "gray"} variant="light">
                            {provider.ready ? t("providerCatalog.failover.ready") : t("providerCatalog.failover.notReady")}
                          </Badge>
                          <Switch
                            aria-label={provider.name}
                            checked={provider.inFailoverQueue}
                            disabled={busy || !provider.ready}
                            onChange={(event) => void updateQueue(provider.id, event.currentTarget.checked)}
                          />
                        </Group>
                      </Group>
                    ))}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
          </>
        ) : null}
      </Stack>
    </Paper>
  );
}
