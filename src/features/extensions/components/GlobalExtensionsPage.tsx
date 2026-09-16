import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Stack } from "@mantine/core";
import { AlertTriangle } from "lucide-react";
import { useI18n } from "../../../shared/i18n/index";
import {
  listManagedMcpResources,
  listManagedSkillInstallations,
  listManagedSkillPackages,
} from "../api";
import { getActiveNativeProviderHome } from "../../settings/api/nativeProviderHome";
import type {
  ExtensionCli,
  McpResourceRedacted,
  SkillInstallationView,
  SkillPackageView,
} from "../../../shared/types/extensions";
import type { NativeProviderHomeState } from "../../settings/api/nativeProviderTypes";
import { GlobalMcpPanel } from "./GlobalMcpPanel";
import { GlobalSkillsPanel } from "./GlobalSkillsPanel";
import type { McpSaveControls } from "../api/mcpSaving";
import { inspectSkillInventory, readNativeMcpStatus, type SkillInventoryEntry } from "../api/native";
import { MCP_CLIS } from "../lib/mcpPending";

interface GlobalExtensionsPageProps {
  activeTab: "mcp" | "skills";
  mcpSave: McpSaveControls;
}

/** 设置页中的扩展总入口，复用供应商当前 Home 并丢弃过期读取。 */
export function GlobalExtensionsPage({ activeTab, mcpSave }: GlobalExtensionsPageProps) {
  const { t } = useI18n();
  const [resources, setResources] = useState<McpResourceRedacted[]>([]);
  const [nativeKeys, setNativeKeys] = useState<Partial<Record<ExtensionCli, string[]>>>({});
  const [inventory, setInventory] = useState<SkillInventoryEntry[]>([]);
  const [inventoryComplete, setInventoryComplete] = useState<Partial<Record<ExtensionCli, boolean>>>({});
  const [packages, setPackages] = useState<SkillPackageView[]>([]);
  const [installations, setInstallations] = useState<SkillInstallationView[]>([]);
  const [home, setHome] = useState<NativeProviderHomeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const refreshId = ++refreshIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const homeRequest = getActiveNativeProviderHome();
      const [nextResources, nextNative, nextPackages, nextHome, nextInstallations, nextInventory] = await Promise.allSettled([
        listManagedMcpResources(),
        Promise.allSettled(MCP_CLIS.map(async cli => ({ cli, ...await readNativeMcpStatus(cli) }))),
        listManagedSkillPackages(),
        homeRequest,
        homeRequest.then((home) => listManagedSkillInstallations(home.identity.environmentKind, home.identity.environmentId)),
        inspectSkillInventory(),
      ]);
      if (refreshId !== refreshIdRef.current) return;
      const currentHome = await getActiveNativeProviderHome();
      if (refreshId !== refreshIdRef.current) return;
      if (nextHome.status !== "fulfilled" || nextHome.value.identity.identity !== currentHome.identity.identity) {
        setNativeKeys({}); setInventory([]); setInventoryComplete({}); setHome(null);
        throw new Error("extensions_native_preview_changed");
      }
      setHome(nextHome.status === "fulfilled" ? nextHome.value : null);
      setResources(nextResources.status === "fulfilled" ? nextResources.value : []);
      setNativeKeys(nextNative.status === "fulfilled" ? Object.fromEntries(nextNative.value
        .flatMap(result => result.status === "fulfilled" && result.value.homeIdentity === currentHome.identity.identity
          ? [[result.value.cli, result.value.enabledKeys]] : [])) : {});
      setInventory(nextInventory.status === "fulfilled" ? nextInventory.value.entries : []);
      setInventoryComplete(nextInventory.status === "fulfilled" ? Object.fromEntries(MCP_CLIS.map(cli =>
        [cli, !nextInventory.value.warnings.some(warning => warning.startsWith(`${cli}:`))])) : {});
      setPackages(nextPackages.status === "fulfilled" ? nextPackages.value : []);
      setInstallations(nextInstallations.status === "fulfilled" ? nextInstallations.value : []);
      const failures = [nextResources, nextNative, nextPackages, nextHome, nextInstallations, nextInventory]
        .filter((result) => result.status === "rejected");
      if (failures.length) throw failures[0].reason;
      if (nextNative.status === "fulfilled") {
        const failed = nextNative.value.find(result => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }
    } catch (cause) {
      if (refreshId === refreshIdRef.current) {
        // Only expose a machine error code, never config contents or paths from IPC errors.
        const message = cause instanceof Error ? cause.message : String(cause);
        const code = message.match(/^((?:extensions|provider)_[a-z0-9_]+)(?=:|$)/)?.[1];
        setError(code ?? "unknown");
      }
    } finally {
      if (refreshId === refreshIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setInstallations([]);
    void refresh();
  }, [refresh]);

  const wasPending = useRef(mcpSave.pending);
  useEffect(() => {
    // Read back after saving, not while an edit is still publishing its canonical result.
    if (wasPending.current && !mcpSave.pending) void refresh();
    wasPending.current = mcpSave.pending;
  }, [mcpSave.pending, refresh]);

  // Actual file status is the baseline; only user-edited CLI targets use desired state.
  const displayedResources = resources.map(resource => ({ ...resource, enabledByCli: Object.fromEntries(MCP_CLIS.map(cli =>
    [cli, mcpSave.pendingClis.includes(cli) ? resource.enabledByCli[cli] : (nativeKeys[cli]?.includes(resource.serverKey) ?? false)],
  )) as Record<ExtensionCli, boolean> }));

  return (
    <Stack gap="md">
      {error && (
        <Alert color="red" variant="light" icon={<AlertTriangle size={16} />}>
          {t("extensions.errors.generic")}
          {error !== "unknown" && <div>{t("extensions.errors.code")}: {error}</div>}
          <button type="button" className="ml-2 underline" onClick={() => void refresh()}>{t("extensions.retry")}</button>
        </Alert>
      )}
      {activeTab === "mcp" ? (
        <GlobalMcpPanel
          mcpSave={mcpSave}
          resources={displayedResources}
          nativeReady={Object.fromEntries(MCP_CLIS.map(cli => [cli, nativeKeys[cli] !== undefined]))}
          loading={loading}
          searchValue=""
          onRefresh={refresh}
          onResourceChanged={(resource) => setResources(current => current.some(item => item.resourceId === resource.resourceId)
            ? current.map(item => item.resourceId === resource.resourceId ? resource : item) : [...current, resource])}
          onResourceDeleted={(resourceId) => setResources((current) => current.filter((item) => item.resourceId !== resourceId))}
        />
      ) : (
        <GlobalSkillsPanel
          packages={packages}
          inventory={inventory}
          inventoryComplete={inventoryComplete}
          installations={installations}
          loading={loading}
          searchValue=""
          home={home}
          onRefresh={refresh}
        />
      )}
    </Stack>
  );
}
