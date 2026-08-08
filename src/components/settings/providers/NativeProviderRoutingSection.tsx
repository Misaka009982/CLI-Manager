import { Accordion, Alert, Badge, Button, Group, Stack, Switch, Text } from "@mantine/core";
import { RefreshCw, Route, Server } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { NativeProviderAppType, NativeProviderHomeIdentity } from "./nativeProviderTypes";
import type { UseNativeProviderRoutingResult } from "./useNativeProviderRouting";

interface NativeProviderRoutingSectionProps {
  appType: NativeProviderAppType;
  homeIdentity: NativeProviderHomeIdentity | null;
  state: UseNativeProviderRoutingResult;
}

export function NativeProviderRoutingSection({
  appType,
  homeIdentity,
  state,
}: NativeProviderRoutingSectionProps) {
  const { t } = useI18n();
  const routing = state.state;
  const currentTakeover = routing?.persisted.takeovers.find(
    (item) => item.appType === appType
      && item.homeIdentity.environmentKind === homeIdentity?.environmentKind
      && item.homeIdentity.environmentId === homeIdentity?.environmentId
      && item.homeIdentity.identity === homeIdentity?.identity,
  );
  const appLabel = t(`providerCatalog.appType.${appType}` as "providerCatalog.appType.claude" | "providerCatalog.appType.codex" | "providerCatalog.appType.grokbuild");
  const service = routing?.persisted.service;
  const daemon = routing?.daemon;
  const busy = Boolean(state.action);

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={700}>{t("providerCatalog.routing.title")}</Text>
          <Text size="sm" c="dimmed">{t("providerCatalog.routing.description")}</Text>
        </div>
        <Button variant="subtle" leftSection={<RefreshCw size={15} />} loading={state.loading} onClick={() => void state.refresh()}>
          {t("providerCatalog.routing.refresh")}
        </Button>
      </Group>

      {state.errorCode && (
        <Alert color="red" withCloseButton onClose={state.clearError}>
          {t("providerCatalog.routing.error")}
        </Alert>
      )}

      <Accordion multiple variant="separated" defaultValue={["service", "runtime"]}>
        <Accordion.Item value="service">
          <Accordion.Control icon={<Server size={16} />}>{t("providerCatalog.routing.service.title")}</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Switch
                label={t("providerCatalog.routing.service.enabled")}
                description={t("providerCatalog.routing.service.enabledDescription")}
                checked={service?.serviceEnabled ?? false}
                disabled={!service || busy}
                onChange={(event) => void state.setServiceEnabled(event.currentTarget.checked)}
              />
              <Switch
                label={t("providerCatalog.routing.service.quickControl")}
                checked={service?.showLocalQuickControl ?? false}
                disabled={!service || busy}
                onChange={(event) => service && void state.setQuickControls({
                  showLocalQuickControl: event.currentTarget.checked,
                  showFailoverQuickControl: service.showFailoverQuickControl,
                  usageLoggingEnabled: service.usageLoggingEnabled,
                })}
              />
              <Switch
                label={t("providerCatalog.routing.service.usageLogging")}
                checked={service?.usageLoggingEnabled ?? false}
                disabled={!service || busy}
                onChange={(event) => service && void state.setQuickControls({
                  showLocalQuickControl: service.showLocalQuickControl,
                  showFailoverQuickControl: service.showFailoverQuickControl,
                  usageLoggingEnabled: event.currentTarget.checked,
                })}
              />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="listener">
          <Accordion.Control icon={<Route size={16} />}>{t("providerCatalog.routing.listener.title")}</Accordion.Control>
          <Accordion.Panel>
            <Stack gap={4}>
              <Text size="sm">{t("providerCatalog.routing.listener.preferred", { port: service?.preferredPort ?? "—" })}</Text>
              <Text size="sm">{t("providerCatalog.routing.listener.actual", { port: daemon?.actualPort ?? service?.actualPort ?? "—" })}</Text>
              <Text size="sm">{t("providerCatalog.routing.listener.addresses", { addresses: daemon?.listenerAddresses.join(", ") || "—" })}</Text>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="takeover">
          <Accordion.Control icon={<Route size={16} />}>{t("providerCatalog.routing.takeover.title")}</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Switch
                label={t("providerCatalog.routing.takeover.currentHome", { app: appLabel })}
                description={homeIdentity?.identity ?? t("providerCatalog.routing.takeover.homeUnavailable")}
                checked={Boolean(currentTakeover)}
                disabled={!homeIdentity || !service?.serviceEnabled || busy}
                onChange={(event) => homeIdentity && void state.setTakeover(appType, homeIdentity, event.currentTarget.checked)}
              />
              {routing?.persisted.takeovers.map((takeover) => (
                <Group key={`${takeover.appType}:${takeover.homeIdentity.identity}`} justify="space-between">
                  <Text size="sm">{takeover.appType} · {takeover.homeIdentity.identity}</Text>
                  <Badge variant="light">{takeover.endpointMode}:{takeover.appliedPort}</Badge>
                </Group>
              ))}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="runtime">
          <Accordion.Control icon={<Server size={16} />}>{t("providerCatalog.routing.runtime.title")}</Accordion.Control>
          <Accordion.Panel>
            <Stack gap={4}>
              <Text size="sm">{t("providerCatalog.routing.runtime.status", { status: daemon?.status ?? "unknown" })}</Text>
              <Text size="sm">{daemon?.connected ? t("providerCatalog.routing.runtime.connected") : t("providerCatalog.routing.runtime.disconnected")}</Text>
              <Text size="sm" c="dimmed">{t("providerCatalog.routing.runtime.boundary")}</Text>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}
