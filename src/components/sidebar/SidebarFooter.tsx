import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Route } from "lucide-react";
import { BarChart3, Settings } from "../icons";
import { SyncStatusIndicator } from "./SyncStatusIndicator";
import type { SettingsTab } from "../SettingsModal";
import { getErrorMessage, getPiHookErrorMessage } from "../../lib/hookErrors";
import type { TerminalSession } from "../../lib/types";
import { useSettingsStore, type SidebarToolbarVisibilitySettings } from "../../stores/settingsStore";
import { useI18n } from "../../lib/i18n";
import { useTerminalStore } from "../../stores/terminalStore";
import { parseProjectProviderOverrides } from "../../lib/providerSwitching";
import { useProjectStore } from "../../stores/projectStore";
import type { NativeProviderAppType, NativeProviderCard, NativeProviderHomeIdentity } from "../settings/providers/nativeProviderTypes";
import { useNativeProviderRouting } from "../settings/providers/useNativeProviderRouting";

type HookInstallStatus = "directoryMissing" | "notInstalled" | "partialInstalled" | "installed";
type HookLightStatus = "missing" | "partial" | "installed";
type HookTool = "claude" | "codex" | "pi" | "grok";

interface ToolHookSettingsStatus {
  configDir: string | null;
  status: HookInstallStatus;
}

interface HookSettingsStatus {
  claude: ToolHookSettingsStatus;
  codex: ToolHookSettingsStatus;
  pi: ToolHookSettingsStatus;
  grok: ToolHookSettingsStatus;
  claudeAutoRepaired?: boolean;
}

interface SidebarFooterProps {
  collapsed: boolean;
  onOpenSettings: (tab?: SettingsTab) => void;
  onOpenStats: () => void;
  toolbarVisibility: SidebarToolbarVisibilitySettings;
}

interface ActiveRoutingTarget {
  appType: NativeProviderAppType;
  homeIdentity: NativeProviderHomeIdentity;
}

function resolveActiveRoutingTarget(session: TerminalSession | null): ActiveRoutingTarget | null {
  if (!session || (session.kind ?? "pty") !== "pty" || session.environmentType === "ssh") return null;

  const cliTool = session.cliTool?.trim().toLowerCase();
  const appType = cliTool === "claude"
    ? "claude"
    : cliTool === "codex"
      ? "codex"
      : cliTool === "grok" || cliTool?.startsWith("grok")
        ? "grokbuild"
        : null;
  if (!appType) return null;

  const distro = session.envVars?.WSL_DISTRO_NAME?.trim() ?? "";
  if (session.environmentType === "wsl" && !distro) return null;
  if (distro) {
    return {
      appType,
      homeIdentity: {
        environmentKind: "wsl",
        environmentId: distro,
        identity: `wsl:${distro}`,
      },
    };
  }

  return {
    appType,
    homeIdentity: {
      environmentKind: "local",
      environmentId: "host",
      identity: "local:host",
    },
  };
}

function isSameHomeIdentity(left: NativeProviderHomeIdentity, right: NativeProviderHomeIdentity): boolean {
  return left.environmentKind === right.environmentKind
    && left.environmentId === right.environmentId
    && left.identity === right.identity;
}

function trimDir(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function getApplicableTools(
  status: HookSettingsStatus | null,
  enabledTools: Record<HookTool, boolean>
): HookTool[] {
  if (!status) return [];
  return (["claude", "codex", "pi", "grok"] as const).filter(
    (tool) => enabledTools[tool] && Boolean(status[tool]?.configDir)
  );
}

function getHookLightStatus(
  status: HookSettingsStatus | null,
  enabledTools: Record<HookTool, boolean>
): HookLightStatus {
  const tools = getApplicableTools(status, enabledTools);
  if (tools.length === 0) return "missing";

  const statuses = tools.map((tool) => status?.[tool].status ?? "directoryMissing");
  if (statuses.every((item) => item === "installed")) return "installed";
  if (statuses.some((item) => item === "installed" || item === "partialInstalled")) return "partial";
  return "missing";
}

function HookStatusLight({ onOpenSettings }: { onOpenSettings: (tab?: SettingsTab) => void }) {
  const { t } = useI18n();
  const claudeHookConfigDir = useSettingsStore((s) => s.claudeHookConfigDir);
  const codexHookConfigDir = useSettingsStore((s) => s.codexHookConfigDir);
  const piHookConfigDir = useSettingsStore((s) => s.piHookConfigDir);
  const grokHookConfigDir = useSettingsStore((s) => s.grokHookConfigDir);
  const claudeHookBridgeEnabled = useSettingsStore((s) => s.claudeHookBridgeEnabled);
  const codexHookBridgeEnabled = useSettingsStore((s) => s.codexHookBridgeEnabled);
  const piHookBridgeEnabled = useSettingsStore((s) => s.piHookBridgeEnabled);
  const grokHookBridgeEnabled = useSettingsStore((s) => s.grokHookBridgeEnabled);
  const claudeHookAutoRepairKnownInstalled = useSettingsStore((s) => s.claudeHookAutoRepairKnownInstalled);
  const claudeHookAutoRepairNoticeShown = useSettingsStore((s) => s.claudeHookAutoRepairNoticeShown);
  const updateSetting = useSettingsStore((s) => s.update);
  const [status, setStatus] = useState<HookSettingsStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);

  const selectedDir = useMemo(() => trimDir(claudeHookConfigDir), [claudeHookConfigDir]);
  const codexSelectedDir = useMemo(() => trimDir(codexHookConfigDir), [codexHookConfigDir]);
  const piSelectedDir = useMemo(() => trimDir(piHookConfigDir), [piHookConfigDir]);
  const grokSelectedDir = useMemo(() => trimDir(grokHookConfigDir), [grokHookConfigDir]);
  const enabledTools = useMemo<Record<HookTool, boolean>>(
    () => ({
      claude: claudeHookBridgeEnabled,
      codex: codexHookBridgeEnabled,
      pi: piHookBridgeEnabled,
      grok: grokHookBridgeEnabled,
    }),
    [claudeHookBridgeEnabled, codexHookBridgeEnabled, piHookBridgeEnabled, grokHookBridgeEnabled]
  );
  const allBridgesDisabled =
    !claudeHookBridgeEnabled && !codexHookBridgeEnabled && !piHookBridgeEnabled && !grokHookBridgeEnabled;
  const lightStatus = getHookLightStatus(status, enabledTools);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await invoke<HookSettingsStatus>("hook_settings_get_status", {
        selectedDir,
        codexSelectedDir,
        piSelectedDir,
        grokSelectedDir,
        autoRepair: claudeHookBridgeEnabled && claudeHookAutoRepairKnownInstalled,
      });
      setStatus(nextStatus);
      if (nextStatus.claudeAutoRepaired && !claudeHookAutoRepairNoticeShown) {
        toast.info("Claude Hook 已自动恢复", {
          description: "检测到 Hook 被外部工具覆盖，已重新写入全局 Hook 配置。",
        });
        void updateSetting("claudeHookAutoRepairNoticeShown", true);
      }
    } catch (error) {
      toast.error(t("sidebar.hook.refreshFailed"), { description: getErrorMessage(error) });
    } finally {
      setLoading(false);
    }
  }, [
    claudeHookBridgeEnabled,
    claudeHookAutoRepairKnownInstalled,
    claudeHookAutoRepairNoticeShown,
    codexSelectedDir,
    grokSelectedDir,
    piSelectedDir,
    selectedDir,
    t,
    updateSetting,
  ]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const reinstallHooks = async () => {
    const tools = getApplicableTools(status, enabledTools);
    if (tools.length === 0) {
      toast.info(t("sidebar.hook.chooseConfigDir"));
      onOpenSettings("hooks");
      return;
    }

    setWorking(true);
    try {
      const dirs = {
        selectedDir,
        codexSelectedDir,
        piSelectedDir,
        grokSelectedDir,
      };
      if (tools.includes("claude")) {
        await invoke<HookSettingsStatus>("hook_settings_uninstall", dirs);
        await invoke<HookSettingsStatus>("hook_settings_install", dirs);
        await updateSetting("claudeHookAutoRepairKnownInstalled", true);
        await updateSetting("claudeHookAutoRepairNoticeShown", false);
      }
      if (tools.includes("codex")) {
        await invoke<HookSettingsStatus>("hook_settings_uninstall_codex", dirs);
        await invoke<HookSettingsStatus>("hook_settings_install_codex", dirs);
      }
      if (tools.includes("pi")) {
        await invoke<HookSettingsStatus>("hook_settings_uninstall_pi", dirs);
        await invoke<HookSettingsStatus>("hook_settings_install_pi", dirs);
      }
      if (tools.includes("grok")) {
        await invoke<HookSettingsStatus>("hook_settings_uninstall_grok", dirs);
        await invoke<HookSettingsStatus>("hook_settings_install_grok", dirs);
      }
      await refreshStatus();
      toast.success(t("sidebar.hook.reinstalled"));
    } catch (error) {
      toast.error(t("sidebar.hook.reinstallFailed"), { description: getPiHookErrorMessage(error, t) });
      await refreshStatus();
    } finally {
      setWorking(false);
    }
  };

  const handleClick = () => {
    if (allBridgesDisabled) {
      onOpenSettings("hooks");
      return;
    }
    if (lightStatus === "installed") {
      onOpenSettings("hooks");
      return;
    }
    void reinstallHooks();
  };

  const title = allBridgesDisabled
    ? t("sidebar.hook.disabled")
    : lightStatus === "installed"
      ? t("sidebar.hook.ok")
      : lightStatus === "partial"
        ? t("sidebar.hook.partial")
        : t("sidebar.hook.missing");

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading || working}
      className="ui-focus-ring ui-icon-action ui-sidebar-action-hook"
      data-hook-status={lightStatus}
      title={working ? t("sidebar.hook.working") : title}
      aria-label={title}
    >
      <span className="ui-sidebar-hook-light" aria-hidden="true" />
    </button>
  );
}

export function SidebarFooter({ collapsed, onOpenSettings, onOpenStats, toolbarVisibility }: SidebarFooterProps) {
  const { t } = useI18n();
  const activeSession = useTerminalStore((state) => (
    state.sessions.find((session) => session.id === state.activeSessionId) ?? null
  ));
  const activeRoutingTarget = useMemo(
    () => resolveActiveRoutingTarget(activeSession),
    [activeSession],
  );
  const activeProject = useProjectStore((state) => (
    activeSession?.projectId
      ? state.projects.find((project) => project.id === activeSession.projectId) ?? null
      : null
  ));
  const activeWorktree = useProjectStore((state) => (
    activeSession?.worktreeId
      ? state.worktrees.find((worktree) => worktree.id === activeSession.worktreeId) ?? null
      : null
  ));
  const routing = useNativeProviderRouting();
  const [hasActiveKey, setHasActiveKey] = useState<boolean | null>(null);

  useEffect(() => {
    const appType = activeRoutingTarget?.appType;
    if (!appType) {
      setHasActiveKey(null);
      return;
    }

    let cancelled = false;
    setHasActiveKey(null);
    void invoke<NativeProviderCard[]>("provider_catalog_list", { appType })
      .then((providers) => {
        if (!cancelled) {
          setHasActiveKey(providers.some((provider) => provider.isCurrent && provider.enabled && provider.keyCount > 0));
        }
      })
      .catch(() => {
        if (!cancelled) setHasActiveKey(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activeRoutingTarget?.appType]);

  const currentTakeover = activeRoutingTarget && routing.state?.persisted.takeovers.find(
    (item) => item.appType === activeRoutingTarget.appType
      && isSameHomeIdentity(item.homeIdentity, activeRoutingTarget.homeIdentity),
  );
  const hasProviderOverride = Boolean(
    activeRoutingTarget
      && (parseProjectProviderOverrides(activeProject?.provider_overrides)[activeRoutingTarget.appType]
        || parseProjectProviderOverrides(activeWorktree?.provider_overrides)[activeRoutingTarget.appType]),
  );
  const quickControlVisible = routing.state?.persisted.service.showLocalQuickControl ?? false;
  const canToggleRouting = Boolean(
    activeRoutingTarget
      && currentTakeover
      && hasActiveKey
      && !hasProviderOverride
      && routing.state
      && !routing.loading
      && !routing.action,
  );
  const routingTitle = routing.loading
    ? t("sidebar.routing.loading")
    : !activeSession
      ? t("sidebar.routing.disabledNoSession")
      : !activeRoutingTarget
        ? t("sidebar.routing.disabledUnsupported")
        : hasActiveKey === null
          ? t("sidebar.routing.loading")
          : !hasActiveKey
            ? t("sidebar.routing.disabledNoKey")
            : hasProviderOverride
              ? t("sidebar.routing.disabledOverride")
              : !currentTakeover
                ? t("sidebar.routing.disabledNoTakeover")
                : routing.action
                  ? t("sidebar.routing.working")
                  : routing.state?.persisted.service.serviceEnabled
                    ? t("sidebar.routing.enabled")
                    : t("sidebar.routing.disabled");

  const toggleRouting = useCallback(async () => {
    if (!routing.state || !canToggleRouting) return;
    const enabled = !routing.state.persisted.service.serviceEnabled;
    try {
      await routing.setServiceEnabled(enabled);
      toast.success(t(enabled ? "sidebar.routing.enabled" : "sidebar.routing.disabled"));
    } catch (error) {
      toast.error(t("sidebar.routing.failed"), { description: getErrorMessage(error) });
    }
  }, [canToggleRouting, routing, t]);

  const routingButton = quickControlVisible ? (
    <button
      type="button"
      onClick={() => void toggleRouting()}
      disabled={!canToggleRouting}
      className="ui-focus-ring ui-icon-action ui-sidebar-action-routing"
      title={routingTitle}
      aria-label={routingTitle}
      aria-pressed={routing.state?.persisted.service.serviceEnabled ?? false}
      data-routing-enabled={routing.state?.persisted.service.serviceEnabled ?? false}
    >
      <Route size={14} strokeWidth={1.5} />
    </button>
  ) : null;

  const statsButton = toolbarVisibility.stats ? (
    <button
      onClick={onOpenStats}
      className="ui-focus-ring ui-icon-action ui-sidebar-action-stats"
      title={t("sidebar.stats")}
      aria-label={t("sidebar.openStats")}
    >
      <BarChart3 size={14} strokeWidth={1.5} />
    </button>
  ) : null;

  const settingsButton = (
    <button
      onClick={() => onOpenSettings()}
      className="ui-focus-ring ui-icon-action ui-sidebar-action-settings"
      title={t("sidebar.settings")}
      aria-label={t("sidebar.openSettings")}
    >
      <Settings size={14} strokeWidth={1.5} />
    </button>
  );

  if (collapsed) {
    return (
      <div className="px-2 py-2">
        <div className="flex flex-col items-center gap-1.5">
          <SyncStatusIndicator collapsed onOpenSettings={onOpenSettings} />
          {statsButton}
          <HookStatusLight onOpenSettings={onOpenSettings} />
          {routingButton}
          {settingsButton}
        </div>
      </div>
    );
  }

  return (
    <div className="px-2.5 py-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <SyncStatusIndicator onOpenSettings={onOpenSettings} />
        </div>
        {statsButton}
        <HookStatusLight onOpenSettings={onOpenSettings} />
        {routingButton}
        {settingsButton}
      </div>
    </div>
  );
}
