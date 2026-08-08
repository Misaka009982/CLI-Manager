import { useEffect, useState } from "react";
import { Accordion, Alert, Badge, Button, Group, NumberInput, Paper, Stack, Switch, Text } from "@mantine/core";
import { RotateCcw, Save } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { NativeProviderAppType, NativeProviderFailoverConfig } from "./nativeProviderTypes";
import type { UseNativeProviderRoutingResult } from "./useNativeProviderRouting";

interface NativeProviderFailoverSectionProps {
  appType: NativeProviderAppType;
  state: UseNativeProviderRoutingResult;
}

export function NativeProviderFailoverSection({ appType, state }: NativeProviderFailoverSectionProps) {
  const { t } = useI18n();
  const failover = state.failoverState[appType];
  const routing = state.state;
  const [configDraft, setConfigDraft] = useState<NativeProviderFailoverConfig | null>(null);
  const [configDirty, setConfigDirty] = useState(false);
  const busy = Boolean(state.action) || Boolean(state.failoverLoading[appType]);
  const hasTakeover = Boolean(routing?.persisted.takeovers.some((item) => item.appType === appType));
  const daemonUnsupported = routing?.daemon.capabilitySupported === false;
  const daemonDisconnected = Boolean(routing && !routing.daemon.connected);
  const runtimeAvailable = Boolean(routing?.daemon.capabilitySupported && routing.daemon.connected);

  useEffect(() => {
    void state.refreshFailover(appType);
  }, [appType, state.refreshFailover]);

  useEffect(() => {
    if (!failover || configDirty) return;
    setConfigDraft(failover.config);
  }, [configDirty, failover]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!state.action) void state.refreshFailover(appType);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [appType, state.action, state.refreshFailover]);

  const updateQueue = async (providerId: string, enabled: boolean) => {
    if (!failover) return;
    const providerIds = failover.providers
      .filter((provider) => provider.id === providerId ? enabled : provider.inFailoverQueue)
      .map((provider) => provider.id);
    await state.setFailoverQueue(appType, providerIds);
  };

  const saveConfig = async () => {
    if (!configDraft) return;
    await state.updateFailoverConfig(appType, configDraft);
    setConfigDirty(false);
  };

  const resetConfigDraft = () => {
    if (!failover) return;
    setConfigDraft(failover.config);
    setConfigDirty(false);
  };

  const updateConfigDraft = (field: keyof NativeProviderFailoverConfig, value: number) => {
    setConfigDraft((current) => current ? { ...current, [field]: value } : current);
    setConfigDirty(true);
  };

  const degraded = Boolean(
    routing?.daemon.status === "degraded"
      || failover?.circuits.some((circuit) => circuit.status !== "closed")
      || (failover?.circuits.length === 0 && failover.circuit.providerId !== "" && failover.circuit.status !== "closed"),
  );
  const circuits = failover
    ? failover.circuits.length > 0
      ? failover.circuits
      : failover.circuit.providerId
        ? [failover.circuit]
        : []
    : [];

  const circuitStatusLabel = (status: string) => {
    if (status === "open") return t("providerCatalog.failover.circuit.open");
    if (status === "half_open") return t("providerCatalog.failover.circuit.halfOpen");
    if (status === "closed") return t("providerCatalog.failover.circuit.closed");
    return t("providerCatalog.failover.circuit.unknown");
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
            {routing && !hasTakeover && (
              <Alert color="yellow" title={t("providerCatalog.failover.unavailableTitle")}>
                {t("providerCatalog.failover.requiresTakeover")}
              </Alert>
            )}
            {routing && daemonUnsupported && (
              <Alert color="gray" title={t("providerCatalog.failover.unavailableTitle")}>
                {t("providerCatalog.failover.unsupported")}
              </Alert>
            )}
            {routing && !daemonUnsupported && daemonDisconnected && (
              <Alert color="yellow" title={t("providerCatalog.failover.unavailableTitle")}>
                {t("providerCatalog.failover.daemonUnavailable")}
              </Alert>
            )}
            <Group justify="space-between" wrap="wrap">
              <Text size="sm" c="dimmed">{t("providerCatalog.failover.statusPolling")}</Text>
              <Badge color={degraded ? "yellow" : "green"} variant="light">
                {degraded ? t("providerCatalog.failover.degraded") : t("providerCatalog.failover.healthy")}
              </Badge>
            </Group>
            <Switch
              label={t("providerCatalog.failover.enabled")}
              checked={failover.config.autoFailoverEnabled}
              disabled={busy || (!failover.config.autoFailoverEnabled && (!hasTakeover || !runtimeAvailable))}
              onChange={(event) => void state.setFailoverEnabled(appType, event.currentTarget.checked)}
            />

            <Stack gap="xs">
              <Text fw={600} size="sm">{t("providerCatalog.failover.parameters")}</Text>
              <Group align="flex-end" wrap="wrap">
                <NumberInput
                  label={t("providerCatalog.failover.maxRetries")}
                  min={0}
                  max={32}
                  value={configDraft?.maxRetries ?? failover.config.maxRetries}
                  disabled={busy}
                  onChange={(value) => updateConfigDraft("maxRetries", Math.max(0, Math.min(32, Math.round(typeof value === "number" ? value : Number(value) || 0))))}
                />
                <NumberInput
                  label={t("providerCatalog.failover.firstByteTimeout")}
                  min={1}
                  value={configDraft?.streamingFirstByteTimeout ?? failover.config.streamingFirstByteTimeout}
                  disabled={busy}
                  onChange={(value) => updateConfigDraft("streamingFirstByteTimeout", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))}
                />
                <NumberInput
                  label={t("providerCatalog.failover.idleTimeout")}
                  min={1}
                  value={configDraft?.streamingIdleTimeout ?? failover.config.streamingIdleTimeout}
                  disabled={busy}
                  onChange={(value) => updateConfigDraft("streamingIdleTimeout", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))}
                />
                <NumberInput
                  label={t("providerCatalog.failover.nonStreamingTimeout")}
                  min={1}
                  value={configDraft?.nonStreamingTimeout ?? failover.config.nonStreamingTimeout}
                  disabled={busy}
                  onChange={(value) => updateConfigDraft("nonStreamingTimeout", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))}
                />
              </Group>
              <Group align="flex-end" wrap="wrap">
                <NumberInput
                  label={t("providerCatalog.failover.failureThreshold")}
                  min={1}
                  value={configDraft?.circuitFailureThreshold ?? failover.config.circuitFailureThreshold}
                  disabled={busy}
                  onChange={(value) => updateConfigDraft("circuitFailureThreshold", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))}
                />
                <NumberInput
                  label={t("providerCatalog.failover.successThreshold")}
                  min={1}
                  value={configDraft?.circuitSuccessThreshold ?? failover.config.circuitSuccessThreshold}
                  disabled={busy}
                  onChange={(value) => updateConfigDraft("circuitSuccessThreshold", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))}
                />
                <NumberInput
                  label={t("providerCatalog.failover.circuitTimeout")}
                  min={1}
                  value={configDraft?.circuitTimeoutSeconds ?? failover.config.circuitTimeoutSeconds}
                  disabled={busy}
                  onChange={(value) => updateConfigDraft("circuitTimeoutSeconds", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))}
                />
                <NumberInput
                  label={t("providerCatalog.failover.errorRateThreshold")}
                  min={0}
                  max={1}
                  step={0.05}
                  value={configDraft?.circuitErrorRateThreshold ?? failover.config.circuitErrorRateThreshold}
                  disabled={busy}
                  onChange={(value) => updateConfigDraft("circuitErrorRateThreshold", Math.max(0, Math.min(1, typeof value === "number" ? value : Number(value) || 0)))}
                />
                <NumberInput
                  label={t("providerCatalog.failover.minRequests")}
                  min={1}
                  value={configDraft?.circuitMinRequests ?? failover.config.circuitMinRequests}
                  disabled={busy}
                  onChange={(value) => updateConfigDraft("circuitMinRequests", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))}
                />
              </Group>
              <Group gap="xs">
                <Button variant="light" leftSection={<Save size={15} />} loading={state.action === "failover-config"} disabled={busy || !configDirty} onClick={() => void saveConfig()}>
                  {t("providerCatalog.failover.save")}
                </Button>
                <Button variant="subtle" leftSection={<RotateCcw size={15} />} disabled={busy || !configDirty} onClick={resetConfigDraft}>
                  {t("providerCatalog.failover.reset")}
                </Button>
              </Group>
            </Stack>

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
                          <Text size="xs" c="dimmed">
                            {t("providerCatalog.failover.keySummary", {
                              count: provider.keyCount,
                              active: provider.activeKeyPresent
                                ? t("providerCatalog.failover.activeKeyPresent")
                                : t("providerCatalog.failover.activeKeyMissing"),
                            })}
                          </Text>
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
              <Accordion.Item value="circuits">
                <Accordion.Control>{t("providerCatalog.failover.health")}</Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="xs">
                    <Text size="sm" c="dimmed">{t("providerCatalog.failover.healthDescription")}</Text>
                    {circuits.length > 0 ? circuits.map((circuit) => (
                      <Group key={circuit.providerId} justify="space-between" wrap="wrap">
                        <Text size="sm">
                          {failover.providers.find((provider) => provider.id === circuit.providerId)?.name ?? circuit.providerId}
                        </Text>
                        <Group gap="xs">
                          <Badge color={circuit.status === "closed" ? "green" : circuit.status === "open" ? "red" : "yellow"} variant="light">
                            {circuitStatusLabel(circuit.status)}
                          </Badge>
                          <Text size="xs" c="dimmed">
                            {t("providerCatalog.failover.failureCount", { count: circuit.consecutiveFailures })}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {t("providerCatalog.failover.probeCount", { count: circuit.successfulProbes })}
                          </Text>
                        </Group>
                      </Group>
                    )) : (
                      <Text size="sm" c="dimmed">{t("providerCatalog.failover.noCircuitState")}</Text>
                    )}
                    <Button
                      variant="light"
                      leftSection={<RotateCcw size={15} />}
                      loading={state.action === "circuit-reset"}
                      disabled={busy || !runtimeAvailable}
                      onClick={() => void state.resetCircuit(appType)}
                    >
                      {t("providerCatalog.failover.resetCircuit")}
                    </Button>
                    <Text size="xs" c="dimmed">{t("providerCatalog.failover.resetCircuitDescription")}</Text>
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
