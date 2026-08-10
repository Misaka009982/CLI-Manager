import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Activity, ArrowDown, ArrowLeftRight, ArrowUp, Boxes, Check, CircleAlert, CircleCheck, CircleStop, GripVertical, RefreshCw, Settings, Zap } from "../icons";
import { useI18n } from "../../lib/i18n";
import type { NativeProviderAppType, NativeProviderFailoverProvider } from "../settings/providers/nativeProviderTypes";
import { useAppConfirm } from "../ui/useAppConfirm";
import { useProviderQuickSwitch } from "./useProviderQuickSwitch";
import { TERM_PANEL, panelColorTint } from "../stats/termStatsUi";
import { VendorIcon, inferVendor } from "../VendorIcon";

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

// 终端皮肤下的紧凑开关行：不引入通用应用控件，配色全部走 TERM_PANEL 变量。
function RoutingToggleRow({
  icon,
  iconColor,
  label,
  hint,
  checked,
  disabled,
  busy,
  onToggle,
}: {
  icon: ReactNode;
  iconColor: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
}) {
  const trackColor = checked ? panelColorTint(iconColor, 55) : TERM_PANEL.track;
  return (
    <div className="flex items-center justify-between gap-2" style={{ opacity: disabled ? 0.55 : 1 }}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md" style={{ color: iconColor, backgroundColor: panelColorTint(iconColor, 14) }}>{icon}</span>
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold" style={{ color: TERM_PANEL.fg }}>{label}</div>
          <div className="truncate text-[10px]" style={{ color: TERM_PANEL.dim }} title={hint}>{hint}</div>
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        title={hint}
        disabled={disabled}
        className="ui-focus-ring relative shrink-0 rounded-full transition-colors disabled:cursor-not-allowed"
        style={{ width: 30, height: 16, backgroundColor: trackColor, border: `1px solid ${checked ? panelColorTint(iconColor, 70) : TERM_PANEL.border}` }}
        onClick={() => onToggle(!checked)}
      >
        <span
          className="absolute top-1/2 rounded-full transition-all"
          style={{
            width: 10,
            height: 10,
            left: checked ? 16 : 2,
            transform: "translateY(-50%)",
            backgroundColor: checked ? iconColor : TERM_PANEL.dim,
            opacity: busy ? 0.5 : 1,
          }}
        />
      </button>
    </div>
  );
}

export function ProviderQuickSwitchPanel({ open, defaultAppType, onOpenSettings }: ProviderQuickSwitchPanelProps) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useAppConfirm();
  const [appType, setAppType] = useState<NativeProviderAppType>(defaultAppType);
  const [draggedProviderId, setDraggedProviderId] = useState<string | null>(null);
  const [dragOverProviderId, setDragOverProviderId] = useState<string | null>(null);
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
  const localRouting = quickSwitch.hasLocalTakeover;
  // 自动故障转移要求 daemon 已连接且支持本地路由能力；仅「服务已启用」不足以放行。
  const runtimeAvailable = Boolean(serviceRunning && daemon?.capabilitySupported && daemon.connected);
  const busy = Boolean(quickSwitch.action);
  const appLabel = t(appTypeLabelKey(appType));

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
  const canReorder = rows.length > 1 && !quickSwitch.action;

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

  const handleLocalRoutingToggle = async (next: boolean) => {
    if (busy) return;
    try {
      await quickSwitch.setLocalRouting(next);
    } catch {
      toast.error(next
        ? t("providerQuickSwitch.localRoutingEnableFailed")
        : t("providerQuickSwitch.localRoutingDisableFailed"));
    }
  };

  const handleFailoverToggle = async (next: boolean) => {
    if (busy) return;
    try {
      await quickSwitch.setFailoverEnabled(next);
    } catch {
      toast.error(t("providerQuickSwitch.failoverToggleFailed"));
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

  const handleProviderDragStart = (event: DragEvent<HTMLElement>, provider: ProviderRow) => {
    if (quickSwitch.action || rows.length < 2) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", provider.id);
    setDraggedProviderId(provider.id);
    setDragOverProviderId(provider.id);
  };

  const handleProviderDragOver = (event: DragEvent<HTMLDivElement>, provider: ProviderRow) => {
    if (!draggedProviderId || draggedProviderId === provider.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverProviderId(provider.id);
  };

  const handleProviderDrop = async (event: DragEvent<HTMLDivElement>, provider: ProviderRow) => {
    event.preventDefault();
    const sourceId = draggedProviderId ?? event.dataTransfer.getData("text/plain");
    setDraggedProviderId(null);
    setDragOverProviderId(null);
    if (!sourceId || sourceId === provider.id || quickSwitch.action) return;
    const ordered = rows.map((item) => item.id);
    const sourceIndex = ordered.indexOf(sourceId);
    const targetIndex = ordered.indexOf(provider.id);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [moved] = ordered.splice(sourceIndex, 1);
    ordered.splice(targetIndex, 0, moved);
    try {
      await quickSwitch.reorderFailoverQueue(ordered);
    } catch {
      toast.error(t("providerQuickSwitch.queueUpdateFailed"));
    }
  };

  const handleProviderDragEnd = () => {
    setDraggedProviderId(null);
    setDragOverProviderId(null);
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
    <div className="flex h-full min-h-0 flex-col" style={{ color: TERM_PANEL.fg, backgroundColor: TERM_PANEL.bg }}>
      <div className="shrink-0 border-b px-3 py-3" style={{ borderColor: TERM_PANEL.border }}>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: TERM_PANEL.dim }}>{t("providerQuickSwitch.cliTypes")}</span>
          <span className="text-[10px]" style={{ color: TERM_PANEL.dim }}>{t(appTypeLabelKey(appType))}</span>
        </div>
        <div role="tablist" aria-label={t("providerQuickSwitch.cliTypes")} className="flex gap-1 rounded-lg p-1" style={{ backgroundColor: TERM_PANEL.card }}>
          {APP_TYPES.map((type, index) => (
            <button
              key={type}
              ref={(node) => { tabRefs.current[type] = node; }}
              type="button"
              role="tab"
              aria-selected={appType === type}
              tabIndex={appType === type ? 0 : -1}
              className="ui-focus-ring min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-[10px] font-semibold transition-colors"
              data-active={appType === type ? "true" : "false"}
              style={{
                color: appType === type ? TERM_PANEL.fg : TERM_PANEL.dim,
                backgroundColor: appType === type ? panelColorTint(TERM_PANEL.green, 16) : "transparent",
                border: `1px solid ${appType === type ? panelColorTint(TERM_PANEL.green, 45) : "transparent"}`,
              }}
              onClick={() => selectAppType(type)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              <span className="inline-flex items-center justify-center gap-1.5"><VendorIcon vendor={inferVendor(type)} size={13} /><span>{t(appTypeLabelKey(type))}</span></span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="mb-3 rounded-lg border px-3 py-2.5" style={{ borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.card }}>
          <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-md" style={{ color: TERM_PANEL.green, backgroundColor: panelColorTint(TERM_PANEL.green, 14) }}><ArrowLeftRight size={12} /></span>
            <div className="min-w-0">
              <div className="truncate text-[11px] font-semibold">{t("providerQuickSwitch.routingStatus")}</div>
              <div className="truncate text-[10px]" style={{ color: TERM_PANEL.dim }}>{autoFailover ? t("providerQuickSwitch.autoFailover") : t("providerQuickSwitch.manualFailover")}</div>
            </div>
          </div>
          <span className="shrink-0 rounded-full px-2 py-1 text-[10px] font-medium" style={{ color: serviceRunning ? TERM_PANEL.green : TERM_PANEL.yellow, backgroundColor: panelColorTint(serviceRunning ? TERM_PANEL.green : TERM_PANEL.yellow, 14) }}>
            {serviceRunning ? t("providerQuickSwitch.routingRunning") : t("providerQuickSwitch.routingUnavailable")}
          </span>
          </div>

          <div className="mt-2.5 space-y-2 border-t pt-2.5" style={{ borderColor: TERM_PANEL.border }}>
            <RoutingToggleRow
              icon={<ArrowLeftRight size={12} />}
              iconColor={TERM_PANEL.green}
              label={t("providerQuickSwitch.localRouting")}
              hint={localRouting
                ? t("providerQuickSwitch.localRoutingOnHint", { app: appLabel })
                : t("providerQuickSwitch.localRoutingOffHint", { app: appLabel })}
              checked={localRouting}
              disabled={busy || !quickSwitch.routing}
              busy={quickSwitch.action === "local-routing"}
              onToggle={(next) => void handleLocalRoutingToggle(next)}
            />
            <RoutingToggleRow
              icon={<Zap size={12} />}
              iconColor={TERM_PANEL.yellow}
              label={t("providerQuickSwitch.autoFailover")}
              hint={!localRouting
                ? t("providerQuickSwitch.failoverNeedsRouting")
                : !autoFailover && !runtimeAvailable
                  ? t("providerQuickSwitch.failoverNeedsRuntime")
                  : autoFailover
                    ? t("providerQuickSwitch.failoverOnHint")
                    : t("providerQuickSwitch.failoverOffHint")}
              checked={autoFailover}
              disabled={busy || !localRouting || !failover || (!autoFailover && !runtimeAvailable)}
              busy={quickSwitch.action === "failover-enabled"}
              onToggle={(next) => void handleFailoverToggle(next)}
            />
          </div>

          {failover && <div className="mt-2 flex items-center justify-between border-t pt-2 text-[10px]" style={{ borderColor: TERM_PANEL.border, color: TERM_PANEL.dim }}>
            <span>{t("providerQuickSwitch.currentProvider")}</span>
            <span className="max-w-[60%] truncate text-right" style={{ color: TERM_PANEL.fg }}>
              {currentId ? rows.find((provider) => provider.id === currentId)?.name ?? t("providerQuickSwitch.unknownProvider") : t("providerQuickSwitch.noCurrentProvider")}
            </span>
          </div>}
        </div>

        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: TERM_PANEL.dim }}>{t("providerQuickSwitch.providerList")}</span>
          <span className="text-[10px]" style={{ color: TERM_PANEL.dim }}>{rows.length}</span>
        </div>

        {quickSwitch.loading && rows.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-[11px]" style={{ color: TERM_PANEL.dim }}><RefreshCw size={14} className="animate-spin" />{t("providerQuickSwitch.loading")}</div>
        )}
        {!quickSwitch.loading && rows.length === 0 && (
          <div className="py-8 text-center text-[11px]" style={{ color: TERM_PANEL.dim }}>{t("providerQuickSwitch.empty")}</div>
        )}
        {errorMessage && <div className="mb-2 flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-[10px]" style={{ color: TERM_PANEL.red, borderColor: panelColorTint(TERM_PANEL.red, 45), backgroundColor: panelColorTint(TERM_PANEL.red, 10) }}><CircleAlert size={13} className="mt-0.5 shrink-0" />{errorMessage}</div>}

        <div className="space-y-2" role="radiogroup" aria-label={t("providerQuickSwitch.providerList")}>
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
            const vendor = inferVendor(`${provider.name} ${provider.model ?? ""} ${provider.baseUrl ?? ""}`);
            const ReadyIcon = provider.ready ? CircleCheck : CircleAlert;
            const CircuitIcon = circuit?.status === "open"
              ? CircleStop
              : circuit?.status === "halfOpen"
                ? Activity
                : null;
            const statusColor = circuit?.status === "open"
              ? TERM_PANEL.red
              : provider.ready
                ? TERM_PANEL.green
                : TERM_PANEL.yellow;
            return (
              <div
                key={provider.id}
                onDragOver={(event) => handleProviderDragOver(event, provider)}
                onDrop={(event) => void handleProviderDrop(event, provider)}
                className={`rounded-lg border transition-colors ${dragOverProviderId === provider.id && draggedProviderId !== provider.id ? "ring-1" : ""}`}
                style={{ borderColor: selected ? TERM_PANEL.green : TERM_PANEL.border, borderLeftWidth: selected ? 3 : 1, backgroundColor: selected ? panelColorTint(TERM_PANEL.green, 11) : TERM_PANEL.card, ...(dragOverProviderId === provider.id && draggedProviderId !== provider.id ? { boxShadow: `inset 0 2px 0 ${TERM_PANEL.green}` } : {}) }}
              >
                <div className="flex items-center gap-1.5">
                  <button
                    ref={(node) => { rowRefs.current[provider.id] = node; }}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={index === 0 ? 0 : -1}
                    disabled={Boolean(quickSwitch.action) || !provider.ready}
                    className="ui-focus-ring min-w-0 flex-1 px-2.5 py-2 text-left disabled:cursor-not-allowed disabled:opacity-55"
                    onClick={() => void handleGlobalSwitch(provider)}
                    onKeyDown={(event) => handleRowKeyDown(event, index)}
                    title={provider.baseUrl ?? undefined}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: TERM_PANEL.cardInner }}>
                        <VendorIcon vendor={vendor} size={14} fallback={Boxes} />
                      </span>
                      <span className="min-w-0 truncate text-[11px] font-semibold" style={{ color: TERM_PANEL.fg }}>{provider.name}</span>
                      {provider.inFailoverQueue && <span className="shrink-0 rounded px-1 text-[9px]" style={{ color: TERM_PANEL.green, backgroundColor: panelColorTint(TERM_PANEL.green, 14) }}>#{(queuePosition.get(provider.id) ?? 0) + 1}</span>}
                      {selected && <span className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full" style={{ color: TERM_PANEL.green, backgroundColor: panelColorTint(TERM_PANEL.green, 18) }} aria-label={t("providerQuickSwitch.currentProvider")}><Check size={12} /></span>}
                    </span>
                    <span className="ml-7 flex min-w-0 items-center gap-2.5 text-[10px]" style={{ color: TERM_PANEL.dim }}>
                      <span className="min-w-0 flex-1 truncate">{provider.model ?? provider.baseUrl ?? t("providerQuickSwitch.noModel")}</span>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5" style={{ color: statusColor, backgroundColor: panelColorTint(statusColor, 10) }}><ReadyIcon size={11} />{provider.ready ? t("providerCatalog.failover.ready") : t("providerCatalog.failover.notReady")}</span>
                      <span className="inline-flex shrink-0 items-center gap-1" style={{ color: circuit?.status === "open" ? TERM_PANEL.red : TERM_PANEL.dim }}>{CircuitIcon && <CircuitIcon size={10} />}{circuitLabel}</span>
                    </span>
                  </button>

                  {canReorder && (
                    <>
                      <span
                        draggable
                        onDragStart={(event) => handleProviderDragStart(event, provider)}
                        onDragEnd={handleProviderDragEnd}
                        className="flex shrink-0 cursor-grab touch-none items-center px-1 active:cursor-grabbing"
                        style={{ color: TERM_PANEL.dim }}
                        title={t("providerQuickSwitch.dragHandle")}
                        aria-hidden="true"
                      ><GripVertical size={14} /></span>
                      {failover && (
                        <>
                          {autoFailover && (
                            <>
                              <button type="button" className="ui-focus-ring rounded px-1.5 py-1 text-[10px] disabled:opacity-35" style={{ color: provider.inFailoverQueue ? TERM_PANEL.green : TERM_PANEL.dim }} aria-pressed={provider.inFailoverQueue} aria-label={t("providerCatalog.failover.queueToggle", { name: provider.name })} disabled={Boolean(quickSwitch.action) || !provider.ready} onClick={() => void handleQueueToggle(provider)}>
                                {provider.inFailoverQueue ? "✓" : "+"}
                              </button>
                              {provider.inFailoverQueue && (
                                <>
                                  <button type="button" className="ui-focus-ring rounded p-1 disabled:opacity-35" style={{ color: TERM_PANEL.dim }} aria-label={t("providerCatalog.failover.moveUp", { name: provider.name })} disabled={Boolean(quickSwitch.action) || queuePosition.get(provider.id) === 0} onClick={() => void handleMove(provider, -1)}><ArrowUp size={12} /></button>
                                  <button type="button" className="ui-focus-ring rounded p-1 disabled:opacity-35" style={{ color: TERM_PANEL.dim }} aria-label={t("providerCatalog.failover.moveDown", { name: provider.name })} disabled={Boolean(quickSwitch.action) || queuePosition.get(provider.id) === queuedIds.length - 1} onClick={() => void handleMove(provider, 1)}><ArrowDown size={12} /></button>
                                </>
                              )}
                            </>
                          )}
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

      <div className="shrink-0 border-t px-3 py-3" style={{ borderColor: TERM_PANEL.border }}>
        <button type="button" className="ui-focus-ring flex w-full items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-[11px] font-medium transition-colors" style={{ color: TERM_PANEL.fg, borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.card }} onClick={onOpenSettings}>
          <Settings size={13} style={{ color: TERM_PANEL.green }} />{t("providerQuickSwitch.openSettings")}
        </button>
      </div>
      {confirmDialog}
    </div>
  );
}
