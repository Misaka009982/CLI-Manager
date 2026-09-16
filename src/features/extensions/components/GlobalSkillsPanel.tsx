import { useEffect, useMemo, useRef, useState } from "react";
import { SkillInventoryPanel } from "./SkillInventoryPanel";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import { ArchiveRestore, ChevronDown, Download, FolderInput, Github, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "../../../shared/i18n/index";
import {
  deployManagedSkill,
  restoreManagedSkill,
  uninstallManagedSkill,
} from "../api";
import type {
  ExtensionCli,
  SkillPackageView,
  SkillSyncMode,
  SkillInstallationView,
} from "../../../shared/types/extensions";
import type { NativeProviderHomeState } from "../../settings/api/nativeProviderTypes";
import { ExtensionImportDialog } from "./ExtensionImportDialog";
import { GithubSkillDialog } from "./GithubSkillDialog";
import { ExtensionCliToggle } from "./ExtensionCliToggle";
import { ExtensionSortableList } from "./ExtensionSortableList";
import { ExtensionCompactRow } from "./ExtensionCompactRow";
import { groupSkillPackages, skillCliPresentation } from "../lib/listPresentation";
import type { SkillInventoryEntry } from "../api/native";
import { skillDeploymentErrorKey } from "../lib/skillErrors";

const CLI_ORDER: ExtensionCli[] = ["claude", "codex", "grok"];

const CLI_LABEL_KEYS: Record<ExtensionCli, TranslationKey> = {
  claude: "extensions.mcp.cliClaude",
  codex: "extensions.mcp.cliCodex",
  grok: "extensions.mcp.cliGrok",
};

const MODE_LABEL_KEYS: Record<SkillSyncMode, TranslationKey> = {
  auto: "extensions.skills.modeAuto",
  symlink: "extensions.skills.modeSymlink",
  copy: "extensions.skills.modeCopy",
};

const STATUS_LABEL_KEYS: Partial<Record<string, TranslationKey>> = {
  active: "extensions.skills.active",
  externalModified: "extensions.skills.externalModified",
  missing: "extensions.skills.missing",
  unreadable: "extensions.skills.unreadable",
};

function normalizePath(value: string): string {
  const path = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const wsl = path.match(/^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/i);
  if (wsl) return wsl[1] || "/";
  return /^[a-z]:\//i.test(path) || path.startsWith("//") ? path.toLocaleLowerCase() : path;
}

function isCurrentInstallation(installation: SkillInstallationView, home: NativeProviderHomeState | null): boolean {
  return Boolean(
    home
      && installation.environmentKind === home.identity.environmentKind
      && installation.environmentId === home.identity.environmentId
      && normalizePath(installation.homePath) === normalizePath(home.homePath),
  );
}

function modeLabel(mode: string, t: (key: TranslationKey) => string): string {
  const key = MODE_LABEL_KEYS[mode as SkillSyncMode];
  return key ? t(key) : mode;
}

function statusLabel(installation: SkillInstallationView, t: (key: TranslationKey) => string): string {
  const status = installation.externalModified ? "externalModified" : installation.status;
  const key = STATUS_LABEL_KEYS[status];
  return key ? t(key) : status;
}

function statusColor(installation: SkillInstallationView): string {
  if (installation.externalModified || installation.status === "externalModified") return "yellow";
  if (installation.status === "missing" || installation.status === "unreadable") return "red";
  return "green";
}

interface SkillDeployDialogProps {
  packageView: SkillPackageView | null;
  targetCli: ExtensionCli | null;
  open: boolean;
  home: NativeProviderHomeState | null;
  onClose: () => void;
  onDeployed: () => Promise<void>;
}

function SkillDeployDialog({ packageView, targetCli, open, home, onClose, onDeployed }: SkillDeployDialogProps) {
  const { t } = useI18n();
  const [cli, setCli] = useState<ExtensionCli>("claude");
  const [mode, setMode] = useState<SkillSyncMode>("auto");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCli(targetCli ?? "claude");
    setMode("auto");
    setSaving(false);
    setError(false);
  }, [open, packageView?.packageId, targetCli]);

  const deploy = async () => {
    if (!packageView || !home) return;
    setSaving(true);
    setError(false);
    try {
      await deployManagedSkill({
        packageId: packageView.packageId,
        environmentKind: home.identity.environmentKind,
        environmentId: home.identity.environmentId,
        cli,
        homePath: home.homePath,
        mode,
      });
      toast.success(t("extensions.skills.deploySuccess"));
      await onDeployed();
      onClose();
    } catch (cause) {
      setError(true);
      toast.error(t(skillDeploymentErrorKey(cause)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`fixed inset-0 z-[60] ${open ? "flex" : "hidden"} items-center justify-center bg-black/50 p-4`}
      role="dialog"
      aria-modal="true"
      aria-label={t("extensions.skills.deployTitle")}
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <div className="ui-surface-card w-full max-w-xl rounded-2xl p-5" onClick={(event) => event.stopPropagation()}>
        <Stack gap="sm">
          <Stack gap={2}>
            <Text fw={650}>{t("extensions.skills.deployTitle")}</Text>
            <Text size="xs" c="dimmed">{t("extensions.skills.deployDescription")}</Text>
          </Stack>
          {packageView && (
            <Card withBorder padding="sm" radius="md" className="border-border/60 bg-surface-container-low">
              <Text size="sm" fw={600}>{packageView.name}</Text>
              <Text size="xs" c="dimmed" className="break-all">{packageView.packagePath}</Text>
            </Card>
          )}
          {targetCli && <Text size="xs" c="dimmed">{t("extensions.skills.targetCheck", { cli: t(CLI_LABEL_KEYS[targetCli]) })}</Text>}
          {error && <Alert color="red">{t("extensions.skills.deployFailed")}</Alert>}
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <Select
              label={t("extensions.skills.cli")}
              value={cli}
              disabled={saving || Boolean(targetCli)}
              data={CLI_ORDER.map((item) => ({ value: item, label: t(CLI_LABEL_KEYS[item]) }))}
              onChange={(value) => setCli((value as ExtensionCli) || "claude")}
            />
            <Select
              label={t("extensions.skills.mode")}
              value={mode}
              disabled={saving}
              data={(["auto", "symlink", "copy"] as SkillSyncMode[]).map((item) => ({ value: item, label: modeLabel(item, t) }))}
              onChange={(value) => setMode((value as SkillSyncMode) || "auto")}
            />
          </SimpleGrid>
          <Text size="xs" c="dimmed" className="break-all">
            {home ? cli === "codex" ? `${home.homePath}/.agents/skills` : `${home.targets[`${cli}ConfigDir`]}/skills` : ""}
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="light" color="gray" disabled={saving} onClick={onClose}>{t("extensions.import.close")}</Button>
            <Button color="cliPrimary" leftSection={<Download size={15} />} loading={saving} disabled={!packageView || !home} onClick={() => void deploy()}>
              {t("extensions.skills.deployNow")}
            </Button>
          </Group>
        </Stack>
      </div>
    </div>
  );
}

interface GlobalSkillsPanelProps {
  packages: SkillPackageView[];
  inventory: SkillInventoryEntry[];
  inventoryComplete: Partial<Record<ExtensionCli, boolean>>;
  installations: SkillInstallationView[];
  loading: boolean;
  searchValue: string;
  home: NativeProviderHomeState | null;
  onRefresh: () => Promise<void>;
}

/** 全局 Skills 管理：源包、当前目标安装实例和实际同步状态分层展示。 */
export function GlobalSkillsPanel({
  packages,
  inventory,
  inventoryComplete,
  installations,
  loading,
  searchValue,
  home,
  onRefresh,
}: GlobalSkillsPanelProps) {
  // Shared row contract is implemented by the compact resource row.
  const { t } = useI18n();
  const [importOpen, setImportOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [deployPackage, setDeployPackage] = useState<SkillPackageView | null>(null);
  const [deployCli, setDeployCli] = useState<ExtensionCli | null>(null);
  const [selectedSources, setSelectedSources] = useState<Record<string, string>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [working, setWorking] = useState<string | null>(null);
  const workingRef = useRef(false);

  const currentInstallations = useMemo(
    () => installations.filter((installation) => isCurrentInstallation(installation, home)),
    [home, installations],
  );
  const packageGroups = useMemo(() => groupSkillPackages(packages), [packages]);
  const filteredPackages = useMemo(() => {
    const query = searchValue.trim().toLocaleLowerCase();
    const sorted = packageGroups.map(variants => ({
      ...variants[0],
      variants,
      selectedPackage: variants.find(item => item.packageId === selectedSources[variants[0].name])
        ?? variants.find(item => currentInstallations.some(installation => installation.packageId === item.packageId && installation.status === "active"))
        ?? variants[0],
    }));
    if (!query) return sorted;
    return sorted.filter((packageView) => [
      packageView.name,
      packageView.description,
      packageView.sourceIdentity,
      packageView.sourceKind,
      packageView.sourceRef,
    ].some((value) => value.toLocaleLowerCase().includes(query)));
  }, [packageGroups, selectedSources, currentInstallations, searchValue]);

  // 图标与详情直接卸载同一安装实例；保留并发锁、所有权检查及后端外部修改保护。
  const uninstall = async (installation: SkillInstallationView, packageView: SkillPackageView) => {
    if (workingRef.current || !installation.owned || installation.externalModified) return;
    workingRef.current = true;
    setWorking(`${packageView.packageId}:${installation.cli}`);
    try {
      const result = await uninstallManagedSkill(installation.installationId);
      if (!result.removed) throw new Error("extensions_skill_external_modified");
      toast.success(t("extensions.skills.uninstallSuccess"));
      await onRefresh();
    } catch {
      toast.error(t("extensions.skills.uninstallFailed"));
      await onRefresh();
    } finally {
      workingRef.current = false; setWorking(null);
    }
  };

  const restore = async (installation: SkillInstallationView) => {
    if (workingRef.current) return;
    workingRef.current = true; setWorking(`${installation.packageId}:${installation.cli}`);
    try {
      await restoreManagedSkill(installation.installationId);
      toast.success(t("extensions.skills.restoreSuccess"));
      await onRefresh();
    } catch {
      toast.error(t("extensions.skills.restoreFailed"));
    } finally {
      workingRef.current = false; setWorking(null);
    }
  };

  const installationsFor = (name: string) => {
    const ids = new Set(packages.filter(item => item.name === name).map(item => item.packageId));
    return currentInstallations.filter(item => ids.has(item.packageId));
  };

  // Icon installation uses the existing auto link/copy policy; removal retains ownership checks.
  const toggleSkill = async (packageView: SkillPackageView, cli: ExtensionCli) => {
    if (!home || workingRef.current) return;
    const state = skillCliPresentation(installationsFor(packageView.name), cli, inventory, packageView.name, inventoryComplete[cli] === true);
    if (state.blocked) { setDeployCli(cli); setDeployPackage(packageView); return; }
    if (state.enabled && state.installation) { await uninstall(state.installation, packageView); return; }
    workingRef.current = true; setWorking(`${packageView.packageId}:${cli}`);
    try {
      await deployManagedSkill({ packageId: packageView.packageId, cli, mode: "auto", homePath: home.homePath,
        environmentKind: home.identity.environmentKind, environmentId: home.identity.environmentId });
      toast.success(t("extensions.skills.deploySuccess"));
      await onRefresh();
    } catch (cause) { toast.error(t(skillDeploymentErrorKey(cause))); await onRefresh(); }
    finally { workingRef.current = false; setWorking(null); }
  };

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Stack gap={2}>
          <Text fw={650}>{t("extensions.skills.title")}</Text>
          <Text size="xs" c="dimmed">{t("extensions.skills.description")}</Text>
        </Stack>
        <Group gap="xs" wrap="wrap">
          <Button size="compact-sm" variant="subtle" color="gray" loading={loading} leftSection={<RefreshCw size={15} />} onClick={() => void onRefresh()}>
            {t("extensions.refresh")}
          </Button>
          <Button size="compact-sm" variant="light" leftSection={<FolderInput size={15} />} onClick={() => setImportOpen(true)}>
            {t("extensions.skills.import")}
          </Button>
          <Button size="compact-sm" color="cliPrimary" leftSection={<Github size={15} />} onClick={() => setGithubOpen(true)}>
            {t("extensions.skills.github")}
          </Button>
        </Group>
      </Group>

      <Text size="xs" c="dimmed">{t("extensions.skills.iconHelp")}</Text>
      <SkillInventoryPanel searchValue={searchValue} homeIdentity={`${home?.identity.identity}:${home?.homePath}`} onChanged={onRefresh} />

      <Group gap="xs" wrap="wrap">
        <Badge variant="light">{t("extensions.skills.packageCount", { count: packageGroups.length })}</Badge>
        <Badge variant="light">{t("extensions.skills.installationCount", { count: currentInstallations.length })}</Badge>
        {!home && <Badge color="yellow">{t("extensions.skills.noHome")}</Badge>}
      </Group>

      {loading && packages.length === 0 ? (
        <Text size="sm" c="dimmed">{t("extensions.loading")}</Text>
      ) : filteredPackages.length === 0 ? (
        <Card withBorder radius="lg" padding="xl" className="border-border/60 bg-surface-container-low text-center">
          <Text fw={600}>{t("extensions.skills.noPackages")}</Text>
          <Text size="sm" c="dimmed" className="mt-1">{t("extensions.skills.noPackagesDescription")}</Text>
        </Card>
      ) : (
        <ExtensionSortableList items={filteredPackages} itemId={item => item.packageId} kind="skills" disabled={loading || Boolean(working)}>
          {(group, dragHandle) => {
            const packageView = group.selectedPackage;
            const packageInstallations = installationsFor(packageView.name);
            const sharedPresence = inventory.some(item => item.name === packageView.name && ["agent-compatible", "claude-compatible"].includes(item.sourceKind) && item.status === "present");
            const inspectDetails = CLI_ORDER.some(cli => skillCliPresentation(packageInstallations, cli).blocked);
            return (
              <ExtensionCompactRow
                key={group.packageId}
                leading={dragHandle}
                name={<div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate" title={packageView.name}>{packageView.name}</span>
                  {sharedPresence && <Badge size="xs" color="gray" variant="light" className="shrink-0" title={t("extensions.skills.sharedPresence")}>{t("extensions.skills.sharedBadge")}</Badge>}
                  {inspectDetails && <Badge size="xs" color="orange" variant="light" className="shrink-0" title={t("extensions.skills.inspectDetails")}>{t("extensions.skills.inspectBadge")}</Badge>}
                </div>}
                description={packageView.description && <Text size="xs" c="dimmed" truncate title={packageView.description}>{packageView.description}</Text>}
                status={
                    <Group gap={4} wrap="nowrap">
                      {CLI_ORDER.map(cli => {
                        const state = skillCliPresentation(packageInstallations, cli, inventory, packageView.name, inventoryComplete[cli] === true);
                        return <ExtensionCliToggle key={cli} cli={cli} enabled={state.enabled}
                          disabled={!home || loading || Boolean(working)}
                          busy={working === `${packageView.packageId}:${cli}`}
                          label={t(state.external.length ? "extensions.skills.iconExternal" : state.blocked ? "extensions.skills.iconCheck" : state.enabled ? "extensions.skills.iconRemove" : "extensions.skills.iconInstall", { cli: t(CLI_LABEL_KEYS[cli]) })}
                          onClick={() => { void toggleSkill(packageView, cli); }} />;
                      })}
                    </Group>
                }
                actions={<Button
                  size="compact-sm" variant="subtle" color="gray"
                  aria-expanded={Boolean(expandedGroups[group.packageId])}
                  aria-label={`${t("extensions.skills.details")}: ${packageView.name}`}
                  title={t("extensions.skills.details")}
                  aria-controls={`skill-details-${group.packageId}`}
                  onClick={() => setExpandedGroups(current => ({ ...current, [group.packageId]: !current[group.packageId] }))}
                ><ChevronDown size={15} className={`transition-transform ${expandedGroups[group.packageId] ? "rotate-180" : ""}`} /></Button>}
              >
                {expandedGroups[group.packageId] && <Stack gap={4} id={`skill-details-${group.packageId}`}>
                  {sharedPresence && <Text size="xs" c="dimmed">{t("extensions.skills.sharedPresence")}</Text>}
                  {inspectDetails && <Text size="xs" c="orange">{t("extensions.skills.inspectDetails")}</Text>}
                    <Stack gap="sm" mt="sm" className="min-w-0">
                      {group.variants.length > 1 && <Select
                        label={t("extensions.skills.sourceVariant")}
                        value={packageView.packageId}
                        disabled={Boolean(working)}
                        data={group.variants.map(item => ({ value: item.packageId, label: item.sourceIdentity }))}
                        onChange={value => { if (value) setSelectedSources(current => ({ ...current, [packageView.name]: value })); }}
                      />}

                      {inventory.filter(item => item.name === packageView.name && !item.managed).map(item =>
                        <Text key={`${item.cli}:${item.path}`} size="xs" className="break-all">
                          {t("extensions.skills.externalPath", { cli: t(CLI_LABEL_KEYS[item.cli]), path: item.path })}
                        </Text>)}
                      {packageView.description && <Text size="sm" className="break-words">{packageView.description}</Text>}
                      <Group gap="xs">
                        {packageView.version && <Badge variant="light">{packageView.version}</Badge>}
                        <Badge color="gray">{packageView.sourceKind}</Badge>
                        <Button size="compact-sm" variant="light" disabled={!home || Boolean(working)} onClick={() => { setDeployCli(null); setDeployPackage(packageView); }}>{t("extensions.skills.advancedDeploy")}</Button>
                      </Group>
                  <Group gap="xs" wrap="wrap">
                    <Text size="xs" c="dimmed" className="break-all">{t("extensions.skills.source")}: {packageView.sourceIdentity}</Text>
                    {packageView.resolvedCommit && <Text size="xs" c="dimmed">{packageView.resolvedCommit.slice(0, 12)}</Text>}
                  </Group>
                  <Stack gap="xs">
                    <Text size="sm" fw={600}>{t("extensions.skills.installations")}</Text>
                    {packageInstallations.length === 0 ? (
                      <Text size="xs" c="dimmed">{t("extensions.skills.noInstallations")}</Text>
                    ) : packageInstallations.map((installation) => (
                      <div key={installation.installationId} className="min-w-0 border-t border-border/50 py-2">
                        <Group justify="space-between" align="flex-start" wrap="wrap">
                          <Stack gap={3} miw={0} className="min-w-0">
                            <Group gap="xs" wrap="wrap">
                              <Text size="sm" fw={600}>{t(CLI_LABEL_KEYS[installation.cli])}</Text>
                              <Badge color={statusColor(installation)}>{statusLabel(installation, t)}</Badge>
                              <Badge variant="light">{modeLabel(installation.actualMode, t)}</Badge>
                            </Group>
                            <Text size="xs" c="dimmed" className="break-all">{installation.targetPath}</Text>
                            <Text size="xs" c="dimmed">
                              {t("extensions.skills.requestedMode")}: {modeLabel(installation.requestedMode, t)} · {t("extensions.skills.actualMode")}: {modeLabel(installation.actualMode, t)}
                            </Text>
                          </Stack>
                          <Group gap={4}>
                            {installation.backupPath && (
                              <Button size="compact-sm" variant="subtle" color="gray" disabled={Boolean(working)} title={t("extensions.skills.restore")} aria-label={t("extensions.skills.restore")} onClick={() => void restore(installation)}>
                                <ArchiveRestore size={15} />
                              </Button>
                            )}
                            <Button
                              size="compact-sm"
                              variant="subtle"
                              color="red"
                              title={t("extensions.skills.uninstall")}
                              aria-label={t("extensions.skills.uninstall")}
                              disabled={Boolean(working) || !installation.owned || installation.externalModified}
                              onClick={() => void uninstall(installation, packageView)}
                            >
                              <Trash2 size={15} />
                            </Button>
                          </Group>
                        </Group>
                      </div>
                    ))}
                  </Stack>
                    </Stack>
                </Stack>}
              </ExtensionCompactRow>
            );
          }}
        </ExtensionSortableList>
      )}

      <SkillDeployDialog
        packageView={deployPackage}
        targetCli={deployCli}
        open={Boolean(deployPackage)}
        home={home}
        onClose={() => setDeployPackage(null)}
        onDeployed={onRefresh}
      />
      <ExtensionImportDialog
        open={importOpen}
        initialSource={{ sourceKind: "skillDirectory", sourcePath: "" }}
        onClose={() => setImportOpen(false)}
        onApplied={() => void onRefresh()}
      />
      <GithubSkillDialog
        open={githubOpen}
        home={home}
        onClose={() => setGithubOpen(false)}
        onInstalled={() => void onRefresh()}
      />
    </Stack>
  );
}
