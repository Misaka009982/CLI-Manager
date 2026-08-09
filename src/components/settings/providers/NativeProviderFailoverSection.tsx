import { useEffect, useState } from "react";
import { Accordion, ActionIcon, Alert, Button, Group, NumberInput, Stack, Switch, Text, Badge } from "@mantine/core";
import { ArrowDown, ArrowLeftRight, ArrowUp, RotateCcw, Save } from "lucide-react";
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
  const service = routing?.persisted.service;
  const [configDraft, setConfigDraft] = useState<NativeProviderFailoverConfig | null>(null);
  const [configDirty, setConfigDirty] = useState(false);
  const busy = Boolean(state.action) || Boolean(state.failoverLoading[appType]);
  const daemonUnsupported = routing?.daemon.capabilitySupported === false;
  const daemonDisconnected = Boolean(routing && !routing.daemon.connected);
  const serviceRunning = Boolean(service?.serviceEnabled && routing?.daemon.status === "running");
  const runtimeAvailable = Boolean(serviceRunning && routing?.daemon.capabilitySupported && routing.daemon.connected);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!state.action) void state.refreshFailover(appType);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [appType, state.action, state.refreshFailover]);

  useEffect(() => {
    if (!failover || configDirty) return;
    setConfigDraft(failover.config);
  }, [configDirty, failover]);

  const updateQueue = async (providerId: string, enabled: boolean) => {
    if (!failover) return;
    const providerIds = failover.providers
      .filter((provider) => provider.id === providerId ? enabled : provider.inFailoverQueue)
      .map((provider) => provider.id);
    await state.setFailoverQueue(appType, providerIds);
  };

  const moveQueuedProvider = async (providerId: string, direction: -1 | 1) => {
    if (!failover) return;
    const queueIndexes = failover.providers
      .map((provider, index) => provider.inFailoverQueue ? index : -1)
      .filter((index) => index >= 0);
    const currentIndex = failover.providers.findIndex((provider) => provider.id === providerId);
    const queuePosition = queueIndexes.indexOf(currentIndex);
    const targetPosition = queuePosition + direction;
    if (queuePosition < 0 || targetPosition < 0 || targetPosition >= queueIndexes.length) return;
    const next = [...failover.providers];
    const targetIndex = queueIndexes[targetPosition];
    [next[currentIndex], next[targetIndex]] = [next[targetIndex], next[currentIndex]];
    await state.reorderFailoverQueue(appType, next.map((provider) => provider.id));
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

  const circuits = failover
    ? failover.circuits.length > 0
      ? failover.circuits
      : failover.circuit.providerId
        ? [failover.circuit]
        : []
    : [];
  const circuitByProvider = new Map(circuits.map((circuit) => [circuit.providerId, circuit]));

  return (
    <Accordion.Item value="failover">
      <Accordion.Control icon={<ArrowLeftRight size={16} />}>{t("providerCatalog.failover.title")}</Accordion.Control>
      <Accordion.Panel>
        <Stack gap="md">
          <Text size="sm" c="dimmed">{t("providerCatalog.failover.description")}</Text>

          {!serviceRunning && (
            <Alert color="yellow" title={t("providerCatalog.failover.unavailableTitle")}>
              {t("providerCatalog.failover.requiresService")}
            </Alert>
          )}
          {daemonUnsupported && (
            <Alert color="gray" title={t("providerCatalog.failover.unavailableTitle")}>
              {t("providerCatalog.failover.unsupported")}
            </Alert>
          )}
          {!daemonUnsupported && daemonDisconnected && (
            <Alert color="yellow" title={t("providerCatalog.failover.unavailableTitle")}>
              {t("providerCatalog.failover.daemonUnavailable")}
            </Alert>
          )}

          {state.failoverLoading[appType] && !failover ? (
            <Text size="sm" c="dimmed">{t("providerCatalog.failover.loading")}</Text>
          ) : failover ? (
            <>
              <Text size="sm" c="dimmed">{t("providerCatalog.failover.statusPolling")}</Text>
              <Stack gap="xs">
                {failover.providers.map((provider) => {
                  const circuit = circuitByProvider.get(provider.id);
                  const degraded = circuit ? circuit.status !== "closed" : routing?.daemon.status === "degraded";
                  return (
                    <Group key={provider.id} justify="space-between" wrap="nowrap" className="min-h-9 rounded-md px-2 py-1 hover:bg-gray-50">
                      <Group gap="xs" wrap="wrap">
                        <Text size="xs" c="dimmed" w={18}>{provider.inFailoverQueue ? `${failover.providers.filter((item) => item.inFailoverQueue).indexOf(provider) + 1}` : "—"}</Text>
                        <Text size="sm">{provider.name}</Text>
                        {provider.isCurrent && <Badge color="cliPrimary" variant="light">{t("providerCatalog.failover.current")}</Badge>}
                        <Badge color={provider.inFailoverQueue ? "blue" : provider.ready ? "green" : "gray"} variant="light">
                          {provider.inFailoverQueue
                            ? t("providerCatalog.failover.inQueue")
                            : provider.ready
                              ? t("providerCatalog.failover.ready")
                              : t("providerCatalog.failover.notReady")}
                        </Badge>
                        <Badge color={degraded ? "yellow" : "green"} variant="light">
                          {degraded ? t("providerCatalog.failover.degraded") : t("providerCatalog.failover.healthy")}
                        </Badge>
                      </Group>
                      <Group gap={2} wrap="nowrap">
                        {provider.inFailoverQueue && (
                          <>
                            <ActionIcon aria-label={t("providerCatalog.failover.moveUp", { name: provider.name })} variant="subtle" size="sm" disabled={busy || failover.providers.filter((item) => item.inFailoverQueue)[0]?.id === provider.id} onClick={() => void moveQueuedProvider(provider.id, -1)}>
                              <ArrowUp size={14} />
                            </ActionIcon>
                            <ActionIcon aria-label={t("providerCatalog.failover.moveDown", { name: provider.name })} variant="subtle" size="sm" disabled={busy || failover.providers.filter((item) => item.inFailoverQueue).slice(-1)[0]?.id === provider.id} onClick={() => void moveQueuedProvider(provider.id, 1)}>
                              <ArrowDown size={14} />
                            </ActionIcon>
                          </>
                        )}
                        <Switch
                          aria-label={t("providerCatalog.failover.queueToggle", { name: provider.name })}
                          checked={provider.inFailoverQueue}
                          disabled={busy || !provider.ready}
                          onChange={(event) => void updateQueue(provider.id, event.currentTarget.checked)}
                        />
                      </Group>
                    </Group>
                  );
                })}
              </Stack>

              <Stack gap="xs">
                <Text fw={600} size="sm">{t("providerCatalog.failover.parameters")}</Text>
                <Group align="flex-end" wrap="wrap">
                  <NumberInput label={t("providerCatalog.failover.maxRetries")} min={0} max={32} value={configDraft?.maxRetries ?? failover.config.maxRetries} disabled={busy} onChange={(value) => updateConfigDraft("maxRetries", Math.max(0, Math.min(32, Math.round(typeof value === "number" ? value : Number(value) || 0))))} />
                  <NumberInput label={t("providerCatalog.failover.firstByteTimeout")} min={1} value={configDraft?.streamingFirstByteTimeout ?? failover.config.streamingFirstByteTimeout} disabled={busy} onChange={(value) => updateConfigDraft("streamingFirstByteTimeout", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))} />
                  <NumberInput label={t("providerCatalog.failover.idleTimeout")} min={1} value={configDraft?.streamingIdleTimeout ?? failover.config.streamingIdleTimeout} disabled={busy} onChange={(value) => updateConfigDraft("streamingIdleTimeout", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))} />
                  <NumberInput label={t("providerCatalog.failover.nonStreamingTimeout")} min={1} value={configDraft?.nonStreamingTimeout ?? failover.config.nonStreamingTimeout} disabled={busy} onChange={(value) => updateConfigDraft("nonStreamingTimeout", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))} />
                </Group>
                <Group align="flex-end" wrap="wrap">
                  <NumberInput label={t("providerCatalog.failover.failureThreshold")} min={1} value={configDraft?.circuitFailureThreshold ?? failover.config.circuitFailureThreshold} disabled={busy} onChange={(value) => updateConfigDraft("circuitFailureThreshold", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))} />
                  <NumberInput label={t("providerCatalog.failover.successThreshold")} min={1} value={configDraft?.circuitSuccessThreshold ?? failover.config.circuitSuccessThreshold} disabled={busy} onChange={(value) => updateConfigDraft("circuitSuccessThreshold", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))} />
                  <NumberInput label={t("providerCatalog.failover.circuitTimeout")} min={1} value={configDraft?.circuitTimeoutSeconds ?? failover.config.circuitTimeoutSeconds} disabled={busy} onChange={(value) => updateConfigDraft("circuitTimeoutSeconds", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))} />
                  <NumberInput label={t("providerCatalog.failover.errorRateThreshold")} min={0} max={1} step={0.05} value={configDraft?.circuitErrorRateThreshold ?? failover.config.circuitErrorRateThreshold} disabled={busy} onChange={(value) => updateConfigDraft("circuitErrorRateThreshold", Math.max(0, Math.min(1, typeof value === "number" ? value : Number(value) || 0)))} />
                  <NumberInput label={t("providerCatalog.failover.minRequests")} min={1} value={configDraft?.circuitMinRequests ?? failover.config.circuitMinRequests} disabled={busy} onChange={(value) => updateConfigDraft("circuitMinRequests", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))} />
                </Group>
                <Group gap="xs">
                  <Button variant="light" leftSection={<Save size={15} />} loading={state.action === "failover-config"} disabled={busy || !configDirty} onClick={() => void saveConfig()}>{t("providerCatalog.failover.save")}</Button>
                  <Button variant="subtle" leftSection={<RotateCcw size={15} />} disabled={busy || !configDirty} onClick={resetConfigDraft}>{t("providerCatalog.failover.reset")}</Button>
                </Group>
              </Stack>

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
            </>
          ) : null}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}
