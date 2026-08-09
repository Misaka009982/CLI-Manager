import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowLeftRight, ArrowUp, Check, CircleAlert, RefreshCw, Settings } from "../icons";
import { useI18n } from "../../lib/i18n";
import type { NativeProviderAppType, NativeProviderFailoverProvider } from "../settings/providers/nativeProviderTypes";
import { useAppConfirm } from "../ui/useAppConfirm";
import { useProviderQuickSwitch } from "./useProviderQuickSwitch";

const APP_TYPES: readonly NativeProviderAppType[] = ["claude", "codex", "grokbuild"];

interface ProviderQuickSwitchPanelProps {
  open: boolean;
  defaultAppType: NativeProviderAppType;
  onOpenSettings?: () => void;
}

interface ProviderRow extends NativeProviderFailoverProvider {
  model: string | null;
  baseUrl: string | null;
  settingsValid: boolean;
}

function appTypeLabelKey(appType: NativeProviderAppType): "providerCatalog.appType.claude" | "providerCatalog.appType.codex" | "providerCatalog.appType.grokbuild" {
  return `providerCatalog.appType.${appType}` as "providerCatalog.appType.claude" | "providerCatalog.appType.codex" | "providerCatalog.appType.grokbuild";
}

export function ProviderQuickSwitchPanel({ open, defaultAppType, onOpenSettings }: ProviderQuickSwitchPanelProps) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useAppConfirm();
  const [appType, setAppType] = useState<NativeProviderAppType>(defaultAppType);
  useEffect(() => setAppType(defaultAppType), [defaultAppType]);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const quickSwitch = useProviderQuickSwitch(appType, open);
  const failover = quickSwitch.failover;
  const routeCurrentId = failover?.providers.find((provider) => provider.isCurrent)?.id ?? null;
  const currentId = quickSwitch.hasLocalTakeover ? routeCurrentId : quickSwitch.current?.providerId ?? null;
  const service = quickSwitch.routing?.persisted.service;
  const daemon = quickSwitch.routing?.daemon;
  const serviceRunning = Boolean(service?.serviceEnabled && daemon?.status === "running");
  const autoFailover = failover?.config.autoFailoverEnabled ?? false;

  const rows = useMemo<ProviderRow[]>(() => {
    const catalogById = new Map(quickSwitch.providers.map((provider) => [provider.id, provider]));
    if (failover) {
      return failover.providers.map((provider) => {
        const card = catalogById.get(provider.id);
        return {
          ...provider,
          model: card?.model ?? null,
          baseUrl: card?.baseUrl ?? null,
          settingsValid: card?.settingsValid ?? provider.ready,
        };
      });
    }
    return quickSwitch.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      sortIndex: provider.sortIndex,
      isCurrent: provider.isCurrent,
      enabled: provider.enabled,
      ready: provider.enabled && provider.settingsValid && Boolean(provider.activeKeyLabel),
      inFailoverQueue: false,
      keyCount: provider.keyCount,
      activeKeyPresent: Boolean(provider.activeKeyLabel),
      model: provider.model,
      baseUrl: provider.baseUrl,
      settingsValid: provider.settingsValid,
    }));
  }, [failover, quickSwitch.providers]);

  const queuedIds = useMemo(
    () => rows.filter((provider) => provider.inFailoverQueue).map((provider) => provider.id),
    [rows],
  );
  const queuePosition = useMemo(() => new Map(queuedIds.map((id, index) => [id, index])), [queuedIds]);

  const selectAppType = (next: NativeProviderAppType) => {
    if (next !== appType) setAppType(next);
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!(["ArrowLeft", "ArrowRight", "Home", "End"] as string[]).includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? APP_TYPES.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + APP_TYPES.length) % APP_TYPES.length;
    const next = APP_TYPES[nextIndex];
    selectAppType(next);
    tabRefs.current[next]?.focus();
  };

  const handleRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!(["ArrowUp", "ArrowDown", "Home", "End"] as string[]).includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
    rowRefs.current[rows[nextIndex]?.id]?.focus();
  };

  const handleGlobalSwitch = async (provider: ProviderRow) => {
    if (quickSwitch.action || !provider.ready || provider.id === currentId) return;
    if (quickSwitch.hasLocalTakeover && failover && !autoFailover) {
      try {
        await quickSwitch.setFailoverQueue([provider.id]);
        toast.success(t("providerQuickSwitch.hotSwitchSuccess", { name: provider.name }));
      } catch {
        toast.error(t("providerQuickSwitch.switchFailed"));
      }
      return;
    }

    try {
      const preview = await quickSwitch.previewGlobal(provider.id);
      const target = preview.targets.find((item) => item.changed)?.path ?? preview.home.homePath;
      const confirmed = await confirm({
        title: t("providerCatalog.global.confirmTitle"),
        message: t("providerCatalog.global.confirmMessage", { provider: provider.name, home: target }),
        confirmText: t("providerCatalog.global.apply"),
      });
      if (!confirmed) return;
      await quickSwitch.applyGlobal(preview);
      toast.success(t("providerQuickSwitch.switchSuccess", { name: provider.name }));
    } catch {
      toast.error(t("providerQuickSwitch.switchFailed"));
    }
  };

  const handleQueueToggle = async (provider: ProviderRow) => {
    if (quickSwitch.action || !provider.ready || !failover || !autoFailover) return;
    const next = provider.inFailoverQueue
      ? queuedIds.filter((id) => id !== provider.id)
      : [...queuedIds, provider.id];
    try {
      await quickSwitch.setFailoverQueue(next);
    } catch {
      toast.error(t("providerQuickSwitch.queueUpdateFailed"));
    }
  };

  const handleMove = async (provider: ProviderRow, direction: -1 | 1) => {
    if (quickSwitch.action || !failover || !autoFailover || !provider.inFailoverQueue) return;
    const position = queuePosition.get(provider.id);
    if (position === undefined) return;
    const nextPosition = position + direction;
    if (nextPosition < 0 || nextPosition >= queuedIds.length) return;
    const nextQueued = [...queuedIds];
    [nextQueued[position], nextQueued[nextPosition]] = [nextQueued[nextPosition], nextQueued[position]];
    const nextAll = [...rows].sort((a, b) => a.sortIndex - b.sortIndex).map((item) => item.id);
    const ordered = [...nextAll];
    const queuedPositions = ordered.reduce<number[]>((positions, id, index) => {
      if (queuedIds.includes(id)) positions.push(index);
      return positions;
    }, []);
    queuedPositions.forEach((position, index) => { ordered[position] = nextQueued[index]; });
    try {
      await quickSwitch.reorderFailoverQueue(ordered);
    } catch {
      toast.error(t("providerQuickSwitch.queueUpdateFailed"));
    }
  };

  const errorMessage = quickSwitch.errorCode === "routing_provider_not_ready"
    ? t("providerCatalog.routing.errors.providerNotReady")
    : quickSwitch.errorCode === "routing_provider_key_not_active"
      ? t("providerCatalog.routing.errors.providerKeyNotActive")
      : quickSwitch.errorCode === "routing_failover_manual_queue_single"
        ? t("providerCatalog.routing.errors.manualQueueSingle")
        : quickSwitch.errorCode
          ? t("providerQuickSwitch.loadFailed")
          : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent text-xs text-text-primary">
      <div className="shrink-0 border-b border-border/60 px-2 py-2">
        <div role="tablist" aria-label={t("providerQuickSwitch.cliTypes")} className="flex gap-1 rounded-md bg-black/10 p-0.5">
          {APP_TYPES.map((type, index) => (
            <button
              key={type}
              ref={(node) => { tabRefs.current[type] = node; }}
              type="button"
              role="tab"
              aria-selected={appType === type}
              tabIndex={appType === type ? 0 : -1}
              className="ui-focus-ring min-w-0 flex-1 truncate rounded px-1.5 py-1 text-[10px] font-semibold transition-colors"
              data-active={appType === type ? "true" : "false"}
              onClick={() => selectAppType(type)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {t(appTypeLabelKey(type))}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-border/50 bg-black/10 px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <ArrowLeftRight size={13} className="shrink-0 text-primary" />
            <span className="truncate">{t("providerQuickSwitch.routingStatus")}</span>
          </div>
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${serviceRunning ? "bg-primary/15 text-primary" : "bg-warning/15 text-warning"}`}>
            {serviceRunning ? t("providerQuickSwitch.routingRunning") : t("providerQuickSwitch.routingUnavailable")}
          </span>
        </div>

        {failover && (
          <div className="mb-2 flex items-center justify-between gap-2 text-[10px] text-text-muted" aria-live="polite">
            <span>{autoFailover ? t("providerQuickSwitch.autoFailover") : t("providerQuickSwitch.manualFailover")}</span>
            <span className="truncate text-right">
              {currentId ? rows.find((provider) => provider.id === currentId)?.name ?? t("providerQuickSwitch.unknownProvider") : t("providerQuickSwitch.noCurrentProvider")}
            </span>
          </div>
        )}

        {quickSwitch.loading && rows.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-text-muted"><RefreshCw size={14} className="animate-spin" />{t("providerQuickSwitch.loading")}</div>
        )}
        {!quickSwitch.loading && rows.length === 0 && (
          <div className="py-8 text-center text-text-muted">{t("providerQuickSwitch.empty")}</div>
        )}
        {errorMessage && <div className="mb-2 flex items-start gap-1.5 rounded border border-danger/30 bg-danger/10 px-2 py-1.5 text-[10px] text-danger"><CircleAlert size={13} className="mt-0.5 shrink-0" />{errorMessage}</div>}

        <div className="space-y-1.5" role="radiogroup" aria-label={t("providerQuickSwitch.providerList")}>
          {rows.map((provider, index) => {
            const selected = provider.id === currentId;
            const circuit = failover?.circuits.find((item) => item.providerId === provider.id)
              ?? (failover?.circuit.providerId === provider.id ? failover.circuit : null);
            const circuitLabel = circuit?.status === "open"
              ? t("providerCatalog.failover.circuit.open")
              : circuit?.status === "halfOpen"
                ? t("providerCatalog.failover.circuit.halfOpen")
                : circuit?.status === "closed"
                  ? t("providerCatalog.failover.healthy")
                  : provider.ready
                    ? t("providerCatalog.failover.healthy")
                    : t("providerCatalog.failover.notReady");
            return (
              <div key={provider.id} className={`rounded-md border px-1.5 py-1.5 transition-colors ${selected ? "border-primary/60 bg-primary/10" : "border-border/40 bg-transparent hover:bg-white/[0.03]"}`}>
                <div className="flex items-center gap-1.5">
                  <button
                    ref={(node) => { rowRefs.current[provider.id] = node; }}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={index === 0 ? 0 : -1}
                    disabled={Boolean(quickSwitch.action) || !provider.ready}
                    className="ui-focus-ring min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-55"
                    onClick={() => void handleGlobalSwitch(provider)}
                    onKeyDown={(event) => handleRowKeyDown(event, index)}
                    title={provider.baseUrl ?? undefined}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {selected ? <Check size={13} className="shrink-0 text-primary" /> : <span className="w-[13px] shrink-0" />}
                      <span className="min-w-0 truncate font-medium">{provider.name}</span>
                      {provider.inFailoverQueue && <span className="shrink-0 text-[10px] text-primary">#{(queuePosition.get(provider.id) ?? 0) + 1}</span>}
                    </span>
                    <span className="ml-[19px] flex min-w-0 items-center gap-1.5 text-[10px] text-text-muted">
                      <span className="truncate">{provider.model ?? provider.baseUrl ?? t("providerQuickSwitch.noModel")}</span>
                      <span className={provider.ready ? "text-primary" : "text-warning"}>{provider.ready ? t("providerCatalog.failover.ready") : t("providerCatalog.failover.notReady")}</span>
                      <span className={circuit?.status === "open" ? "text-danger" : "text-text-muted"}>{circuitLabel}</span>
                    </span>
                  </button>

                  {autoFailover && failover && (
                    <>
                      <button type="button" className="ui-focus-ring rounded px-1 text-[10px] text-text-muted hover:text-primary disabled:opacity-35" aria-pressed={provider.inFailoverQueue} aria-label={t("providerCatalog.failover.queueToggle", { name: provider.name })} disabled={Boolean(quickSwitch.action) || !provider.ready} onClick={() => void handleQueueToggle(provider)}>
                        {provider.inFailoverQueue ? "✓" : "+"}
                      </button>
                      {provider.inFailoverQueue && (
                        <>
                          <button type="button" className="ui-focus-ring rounded p-0.5 text-text-muted hover:text-primary disabled:opacity-35" aria-label={t("providerCatalog.failover.moveUp", { name: provider.name })} disabled={Boolean(quickSwitch.action) || queuePosition.get(provider.id) === 0} onClick={() => void handleMove(provider, -1)}><ArrowUp size={13} /></button>
                          <button type="button" className="ui-focus-ring rounded p-0.5 text-text-muted hover:text-primary disabled:opacity-35" aria-label={t("providerCatalog.failover.moveDown", { name: provider.name })} disabled={Boolean(quickSwitch.action) || queuePosition.get(provider.id) === queuedIds.length - 1} onClick={() => void handleMove(provider, 1)}><ArrowDown size={13} /></button>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="shrink-0 border-t border-border/60 px-2 py-2">
        <button type="button" className="ui-focus-ring flex w-full items-center justify-center gap-1.5 rounded px-2 py-1.5 text-[11px] text-text-muted transition-colors hover:bg-white/[0.04] hover:text-primary" onClick={onOpenSettings}>
          <Settings size={13} />{t("providerQuickSwitch.openSettings")}
        </button>
      </div>
      {confirmDialog}
    </div>
  );
}
