import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, FolderCog, X } from "lucide-react";
import { useI18n, type TranslationKey } from "../../../shared/i18n/index";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../../../shared/ui/dialog";
import { Button } from "../../../shared/ui/button";
import { Input } from "../../../shared/ui/input";
import { getProviderSwitchAppType } from "../../providers/api/providerSwitching";
import type { Project, WorktreeRecord } from "../../../shared/types/index";
import type {
  CapabilityStatus,
  ExtensionCli,
  ExtensionPolicyKind,
  ExtensionPolicyMode,
  ExtensionScopeKind,
  ProjectExtensionPolicyResponse,
  ProjectExtensionPolicySaveRequest,
  ProjectExtensionPolicyView,
} from "../../../shared/types/extensions";
import {
  getProjectExtensionPolicy,
  saveProjectExtensionPolicy,
} from "../api/projectPolicy";
import { groupSkillPackages } from "../lib/listPresentation";
import { ExtensionCompactRow } from "./ExtensionCompactRow";

type ExtensionKind = ExtensionPolicyKind;
type DraftPolicy = { mode: ExtensionPolicyMode; selectedIds: string[] };
type DraftPolicies = Record<`${ExtensionCli}:${ExtensionKind}`, DraftPolicy>;

const CLI_ORDER: ExtensionCli[] = ["claude", "codex", "grok"];
const KIND_ORDER: ExtensionKind[] = ["mcp", "skill"];

const CLI_LABEL_KEYS: Record<ExtensionCli, TranslationKey> = {
  claude: "extensions.mcp.cliClaude",
  codex: "extensions.mcp.cliCodex",
  grok: "extensions.mcp.cliGrok",
};

const STATUS_LABEL_KEYS: Record<CapabilityStatus, TranslationKey> = {
  supported: "extensions.status.supported",
  globalOnly: "extensions.status.globalOnly",
  unknown: "extensions.status.unknown",
  error: "extensions.status.error",
};

function policyKey(cli: ExtensionCli, kind: ExtensionKind): `${ExtensionCli}:${ExtensionKind}` {
  return `${cli}:${kind}`;
}

function emptyDraftPolicies(): DraftPolicies {
  const next = {} as DraftPolicies;
  for (const cli of CLI_ORDER) {
    for (const kind of KIND_ORDER) {
      next[policyKey(cli, kind)] = { mode: "inherit", selectedIds: [] };
    }
  }
  return next;
}

function draftFromResponse(response: ProjectExtensionPolicyResponse): DraftPolicies {
  const next = emptyDraftPolicies();
  for (const policy of response.policies) {
    next[policyKey(policy.cli, policy.kind)] = {
      mode: policy.mode,
      selectedIds: [...policy.selectedIds],
    };
  }
  return next;
}

function inferWslDistro(path: string): string | null {
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\/]+)(?:[\\/]|$)/i.exec(path.trim());
  return match?.[1]?.trim() || null;
}

function targetPath(project: Project, worktree?: WorktreeRecord): string {
  return worktree?.path?.trim() || project.path.trim();
}

function targetEnvironment(project: Project, path: string): { kind: string; id: string } {
  if (project.environment_type === "ssh") return { kind: "ssh", id: "" };
  if (project.environment_type === "wsl") return { kind: "wsl", id: inferWslDistro(path) ?? "" };
  return { kind: "local", id: "host" };
}

function statusColor(status: string): string {
  if (status === "supported" || status === "applied") return "text-success";
  if (status === "globalOnly") return "text-warning";
  if (status === "error") return "text-danger";
  return "text-text-muted";
}

function effectiveForDraft(
  response: ProjectExtensionPolicyResponse,
  parentResponse: ProjectExtensionPolicyResponse | null,
  draft: DraftPolicy,
  cli: ExtensionCli,
  kind: ExtensionKind,
): string[] {
  if (draft.mode === "custom") return draft.selectedIds;
  const inherited = parentResponse?.policies.find((policy) => policy.cli === cli && policy.kind === kind);
  if (response.scopeKind === "worktree" && inherited) return inherited.effectiveIds;
  const globalIds = kind === "mcp" ? response.globalMcpIds[cli] : response.globalSkillIds[cli];
  return globalIds ?? [];
}

function policyFor(
  response: ProjectExtensionPolicyResponse | null,
  cli: ExtensionCli,
  kind: ExtensionKind,
): ProjectExtensionPolicyView | null {
  return response?.policies.find((policy) => policy.cli === cli && policy.kind === kind) ?? null;
}

function itemMatches(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query);
}

interface ProjectExtensionsDialogProps {
  project: Project | null;
  worktree?: WorktreeRecord;
  open: boolean;
  onClose: () => void;
}

/** 项目/Worktree扩展策略编辑器；只保存策略，不改写 CLI 原生项目配置。 */
export function ProjectExtensionsDialog({ project, worktree, open, onClose }: ProjectExtensionsDialogProps) {
  const { t } = useI18n();
  const dialogId = useId();
  const projectAppType = project ? getProviderSwitchAppType(project) : null;
  const activeCli: ExtensionCli | null = projectAppType === "grokbuild" ? "grok" : projectAppType;
  const [activeKind, setActiveKind] = useState<ExtensionKind>("mcp");
  const [searchValue, setSearchValue] = useState("");
  const [response, setResponse] = useState<ProjectExtensionPolicyResponse | null>(null);
  const [parentResponse, setParentResponse] = useState<ProjectExtensionPolicyResponse | null>(null);
  const [draftPolicies, setDraftPolicies] = useState<DraftPolicies>(emptyDraftPolicies);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const requestIdRef = useRef(0);

  const path = project ? targetPath(project, worktree) : "";
  const environment = project ? targetEnvironment(project, path) : { kind: "local", id: "host" };
  const scopeKind: ExtensionScopeKind = worktree ? "worktree" : "project";
  const scopeId = worktree?.id ?? project?.id ?? "";
  const targetKey = `${project?.id ?? ""}:${worktree?.id ?? ""}:${environment.kind}:${environment.id}`;
  const isSshTarget = project?.environment_type === "ssh";
  const hasWslIdentity = environment.kind !== "wsl" || Boolean(environment.id);

  useEffect(() => {
    if (!open || !project || !activeCli) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadError(false);
    setResponse(null);
    setParentResponse(null);
    setSearchValue("");
    const request = {
      projectId: project.id,
      worktreeId: worktree?.id ?? null,
      // SSH 目前不执行远端策略应用；读取本机受管全局状态用于 global-only 预览。
      environmentKind: environment.kind === "ssh" ? "local" : environment.kind,
      environmentId: environment.kind === "ssh" ? "host" : environment.id || null,
    };
    const parentRequest = {
      projectId: project.id,
      worktreeId: null,
      environmentKind: environment.kind === "ssh" ? "local" : environment.kind,
      environmentId: environment.kind === "ssh" ? "host" : environment.id || null,
    };
    void Promise.all([
      getProjectExtensionPolicy(request),
      worktree ? getProjectExtensionPolicy(parentRequest) : Promise.resolve(null),
    ])
      .then(([nextResponse, nextParentResponse]) => {
        if (requestId !== requestIdRef.current) return;
        setResponse(nextResponse);
        setParentResponse(nextParentResponse);
        setDraftPolicies(draftFromResponse(nextResponse));
      })
      .catch(() => {
        if (requestId === requestIdRef.current) setLoadError(true);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }, [activeCli, environment.id, environment.kind, open, project, targetKey, worktree]);

  const currentDraft = activeCli ? draftPolicies[policyKey(activeCli, activeKind)] : null;
  const currentPolicy = activeCli ? policyFor(response, activeCli, activeKind) : null;
  const parentPolicy = activeCli ? policyFor(parentResponse, activeCli, activeKind) : null;
  const forcedGlobalOnly = !activeCli || isSshTarget || !hasWslIdentity;
  const capabilityStatus: CapabilityStatus = forcedGlobalOnly
    ? "globalOnly"
    : currentPolicy?.capabilityStatus ?? "unknown";
  const applicationStatus = forcedGlobalOnly
    ? "globalOnly"
    : currentPolicy?.applicationStatus ?? "error";
  const globalIds = !activeCli ? [] : activeKind === "mcp"
    ? response?.globalMcpIds[activeCli] ?? []
    : response?.globalSkillIds[activeCli] ?? [];
  const availableIds = activeKind === "mcp"
    ? response?.resources.map((resource) => resource.resourceId) ?? []
    : response?.packages.map((packageView) => packageView.packageId) ?? [];
  const effectiveIds = response && currentDraft && activeCli
    ? effectiveForDraft(response, parentResponse, currentDraft, activeCli, activeKind)
    : [];
  const invalidIds = effectiveIds.filter((id) => !availableIds.includes(id));
  const canCustomize = capabilityStatus === "supported" && !forcedGlobalOnly;
  const editableSelection = canCustomize && currentDraft?.mode === "custom";
  const query = searchValue.trim().toLocaleLowerCase();
  const resourceNames = useMemo(() => new Map(
    activeKind === "mcp"
      ? response?.resources.map(resource => [resource.resourceId, resource.name] as const)
      : response?.packages.map(packageView => [packageView.packageId, packageView.name] as const),
  ), [activeKind, response]);

  const resources = useMemo(() => {
    if (!response) return [];
    if (activeKind === "mcp") {
      return response.resources
        .filter((resource) => !query || [resource.name, resource.serverKey, resource.resourceId, resource.source?.label ?? ""].some((value) => itemMatches(value, query)))
        .map((resource) => ({
          id: resource.resourceId,
          ids: [resource.resourceId],
          name: resource.name,
          detail: resource.serverKey,
          source: resource.source?.label || resource.source?.kind || t("extensions.mcp.noSource"),
        }));
    }
    return groupSkillPackages(response.packages)
      .filter((variants) => !query || variants.some((packageView) => [packageView.name, packageView.description, packageView.packageId, packageView.sourceIdentity].some((value) => itemMatches(value, query))))
      .map((variants) => {
        const selectedPackage = variants.find((packageView) => effectiveIds.includes(packageView.packageId)) ?? variants[0];
        return {
          id: variants[0].packageId,
          ids: variants.map((packageView) => packageView.packageId),
          name: selectedPackage.name,
          detail: selectedPackage.version || selectedPackage.description,
          source: selectedPackage.sourceIdentity,
        };
      });
  }, [activeKind, effectiveIds, query, response, t]);

  const updateDraft = (update: Partial<DraftPolicy>) => {
    if (!activeCli || forcedGlobalOnly || saving) return;
    setDraftPolicies((current) => ({
      ...current,
      [policyKey(activeCli, activeKind)]: {
        ...current[policyKey(activeCli, activeKind)],
        ...update,
      },
    }));
  };

  const toggleSelection = (ids: string[]) => {
    if (!editableSelection || !currentDraft) return;
    const selected = new Set(currentDraft.selectedIds);
    if (ids.some((id) => selected.has(id))) {
      ids.forEach((id) => selected.delete(id));
    } else if (ids[0]) {
      selected.add(ids[0]);
    }
    updateDraft({ selectedIds: Array.from(selected) });
  };

  // 以有效集合为起点保留隐藏项与已选来源；批量操作显式建立当前 CLI 的自定义策略。
  const toggleAllVisible = (select: boolean) => {
    if (!canCustomize || loading || saving || !currentDraft) return;
    const selected = new Set(effectiveIds);
    for (const resource of resources) {
      if (!select) resource.ids.forEach(id => selected.delete(id));
      else if (!resource.ids.some(id => selected.has(id)) && resource.ids[0]) selected.add(resource.ids[0]);
    }
    updateDraft({ mode: "custom", selectedIds: Array.from(selected) });
  };

  const allVisibleSelected = resources.length > 0 && resources.every(resource => resource.ids.some(id => effectiveIds.includes(id)));

  const save = async () => {
    if (!activeCli || !project || !response || !currentDraft || saving || forcedGlobalOnly) return;
    setSaving(true);
    const policies = [activeCli].flatMap((cli) => KIND_ORDER.map((kind) => {
      const draft = draftPolicies[policyKey(cli, kind)];
      return {
        cli,
        kind,
        mode: draft.mode,
        selectedIds: draft.selectedIds,
      };
    }));
    const request: ProjectExtensionPolicySaveRequest = {
      scopeKind,
      scopeId,
      projectId: project.id,
      policies,
    };
    try {
      await saveProjectExtensionPolicy(request);
      toast.success(t("extensions.project.saved"));
      onClose();
    } catch {
      toast.error(t("extensions.project.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (!saving) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) close(); }}>
      <DialogContent className="flex h-[92vh] max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-5xl flex-col overflow-hidden p-0" showCloseButton={false}>
        <div className="shrink-0 border-b border-border/70 px-5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <DialogTitle className="flex items-center gap-2 text-base">
                <FolderCog size={17} />
                {t("extensions.project.title")}
              </DialogTitle>
              <DialogDescription className="sr-only sm:not-sr-only sm:mt-1">
                {t("extensions.project.description")}
              </DialogDescription>
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="max-w-full truncate font-medium text-text-primary" title={project?.name}>{project?.name || "—"}{worktree ? ` · ${worktree.name}` : ""}</span>
                {activeCli && <span className="rounded-md bg-primary/10 px-2 py-0.5 text-text-secondary">{t("extensions.project.boundCli", { cli: t(CLI_LABEL_KEYS[activeCli]) })}</span>}
              </div>
              <div className="mt-1 truncate text-xs text-text-muted" title={path}>{path || "—"}</div>
            </div>
            <Button variant="ghost" size="icon" disabled={saving} onClick={close} aria-label={t("extensions.import.close")} title={t("extensions.import.close")}><X size={16} /></Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 py-4">
          {(isSshTarget || !hasWslIdentity) && (
            <div role="alert" className="mb-3 flex gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{isSshTarget ? t("extensions.project.sshGlobalOnly") : t("extensions.project.wslIdentityMissing")}</span>
            </div>
          )}

          {loadError && (
            <div role="alert" className="mb-3 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">
              {t("extensions.project.loadFailed")}
            </div>
          )}

          {!activeCli ? (
            <div role="alert" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              {t("extensions.project.unsupportedCli", { cli: project?.cli_tool || "—" })}
            </div>
          ) : <>
          <div className="mb-2 grid shrink-0 grid-cols-2 gap-1 rounded-lg bg-surface-container-low p-1" role="tablist" aria-label={t("extensions.project.kind")}>
            {KIND_ORDER.map((kind) => (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={activeKind === kind}
                id={`${dialogId}-${kind}-tab`}
                aria-controls={`${dialogId}-panel`}
                tabIndex={activeKind === kind ? 0 : -1}
                className={`border-b-2 px-3 py-2 text-left text-sm transition ${activeKind === kind ? "border-primary text-text-primary" : "border-transparent text-text-secondary hover:border-border/60"}`}
                onClick={() => setActiveKind(kind)}
                onKeyDown={(event) => {
                  // 页签采用单一 Tab 停靠点；方向键切换时同步移动焦点。
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const nextKind = event.key === "Home" ? "mcp" : event.key === "End" ? "skill" : kind === "mcp" ? "skill" : "mcp";
                  setActiveKind(nextKind);
                  document.getElementById(`${dialogId}-${nextKind}-tab`)?.focus();
                }}
              >
                {kind === "mcp" ? t("extensions.project.mcp") : t("extensions.project.skills")}
              </button>
            ))}
          </div>

          <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-text-secondary">{t("extensions.project.capability")}</span>
            <span className={statusColor(capabilityStatus)}>{t(STATUS_LABEL_KEYS[capabilityStatus])}</span>
            <span className="mx-1 text-text-muted">·</span>
            <span className="font-medium text-text-secondary">{t("extensions.project.application")}</span>
            <span className={statusColor(applicationStatus)}>{t(STATUS_LABEL_KEYS[applicationStatus as CapabilityStatus] ?? "extensions.status.error")}</span>
            {applicationStatus === "error" && <span className="text-text-muted">{t("extensions.project.applicationError")}</span>}
          </div>

          <div className="grid min-h-0 flex-1 auto-rows-fr gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(15rem,0.7fr)]" role="tabpanel" id={`${dialogId}-panel`} aria-labelledby={`${dialogId}-${activeKind}-tab`}>
            <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-surface-container-low/35 p-3">
              <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-text-primary">{t("extensions.project.policy")}</h3>
                  <p className="sr-only">{t("extensions.project.policyDescription")}</p>
                </div>
                <Input
                  value={searchValue}
                  onChange={(event) => setSearchValue(event.target.value)}
                  placeholder={t("extensions.project.search")}
                  aria-label={t("extensions.project.search")}
                  className="h-8 min-w-0 flex-1 text-xs sm:max-w-56"
                />
              </div>

              <div className="mb-2 grid shrink-0 grid-cols-2 gap-2" role="group" aria-label={t("extensions.project.policy")}>
                {(["inherit", "custom"] as ExtensionPolicyMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    disabled={mode === "custom" && !canCustomize}
                    aria-pressed={currentDraft?.mode === mode}
                    title={mode === "inherit" ? t("extensions.project.inheritDescription") : t("extensions.project.customDescription")}
                    className={`rounded-md border px-3 py-1.5 text-left text-xs transition disabled:cursor-not-allowed disabled:opacity-50 ${currentDraft?.mode === mode ? "border-border bg-surface-container-low text-text-primary shadow-sm" : "border-transparent text-text-secondary hover:border-border/60"}`}
                    onClick={() => updateDraft({
                      mode,
                      ...(mode === "custom" && currentDraft?.mode !== "custom"
                        ? { selectedIds: [...effectiveIds] }
                        : {}),
                    })}
                  >
                    <span className="block font-medium">{mode === "inherit" ? t("extensions.project.inherit") : t("extensions.project.custom")}</span>
                  </button>
                ))}
              </div>

              <div className="mb-1 flex shrink-0 items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-text-muted">{t("extensions.project.batchScope")}</span>
                <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs"
                  disabled={!canCustomize || loading || saving || resources.length === 0}
                  title={t("extensions.project.batchHelp")}
                  onClick={() => toggleAllVisible(!allVisibleSelected)}>
                  {t(allVisibleSelected ? "extensions.project.clearAll" : "extensions.import.selectAll")}
                </Button>
              </div>
              {loading ? (
                <div className="py-10 text-center text-xs text-text-muted">{t("extensions.loading")}</div>
              ) : resources.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/70 px-3 py-10 text-center text-xs text-text-muted">
                  {activeKind === "mcp" ? t("extensions.project.noMcp") : t("extensions.project.noSkills")}
                </div>
              ) : (
                <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
                  {resources.map((resource) => {
                    const selected = forcedGlobalOnly || currentDraft?.mode === "inherit"
                      ? resource.ids.some((id) => effectiveIds.includes(id))
                      : resource.ids.some((id) => currentDraft?.selectedIds.includes(id) ?? false);
                    // 名称与介绍都关联原生 checkbox；禁用和 Space 操作仍由 input 负责。
                    return (
                      <ExtensionCompactRow
                        key={resource.id}
                        compact
                        selected={selected}
                        leading={<input
                          id={`${dialogId}-${resource.id}`}
                          type="checkbox"
                          checked={selected}
                          disabled={!editableSelection}
                          onChange={() => toggleSelection(resource.ids)}
                          className="h-4 w-4 shrink-0 accent-primary"
                          aria-label={resource.name}
                        />}
                        name={<label htmlFor={`${dialogId}-${resource.id}`} className={`block select-none truncate ${editableSelection ? "cursor-pointer" : "cursor-default"}`} title={resource.name}>{resource.name}</label>}
                        description={<label htmlFor={`${dialogId}-${resource.id}`} className={`block select-none truncate text-[11px] leading-4 ${editableSelection ? "cursor-pointer" : "cursor-default"}`} title={`${resource.detail} · ${resource.source}`}>
                          {[resource.detail !== resource.name && resource.detail, resource.source].filter(Boolean).join(" · ")}
                        </label>}
                      />
                    );
                  })}
                </div>
              )}
            </section>

            <aside className="min-h-0 min-w-0 overflow-y-auto rounded-xl border border-border/70 bg-surface-container-low/35 p-3" aria-label={t("extensions.project.preview")}>
              <h3 className="text-sm font-semibold text-text-primary">{t("extensions.project.preview")}</h3>
              <div className="mt-3 space-y-2 text-xs">
                <div className="flex items-center justify-between gap-3"><span className="text-text-muted">{t("extensions.project.globalState")}</span><span className="font-medium text-text-primary">{globalIds.length}</span></div>
                <div className="flex items-center justify-between gap-3"><span className="text-text-muted">{t("extensions.project.effective")}</span><span className="font-medium text-text-primary">{effectiveIds.length}</span></div>
                <div className="flex items-center justify-between gap-3"><span className="text-text-muted">{t("extensions.project.applied")}</span><span className="font-medium text-text-primary">{currentPolicy?.appliedIds.length ?? 0}</span></div>
              </div>
              <ul className="mt-3 space-y-1 text-xs text-text-primary" aria-label={t("extensions.project.effective")}>
                {effectiveIds.map(id => {
                  const name = resourceNames.get(id);
                  return <li key={id} className="flex min-w-0 items-center gap-2 py-1"><Check size={12} className="shrink-0 text-success" /><span className="truncate" title={name || id}>{name || id}</span></li>;
                })}
              </ul>
              <div className="mt-4 rounded-lg border border-border/60 bg-surface-container-low px-3 py-2 text-xs leading-relaxed text-text-muted">
                {currentDraft?.mode === "custom" ? t("extensions.project.customPreview") : t("extensions.project.inheritPreview", { source: response?.scopeKind === "worktree" && parentPolicy?.mode === "custom" ? t("extensions.project.projectSource") : t("extensions.project.globalSource") })}
              </div>
              {invalidIds.length > 0 && (
                <div role="alert" className="mt-3 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger">
                  {t("extensions.project.invalidSelection", { count: invalidIds.length })}
                </div>
              )}
              {capabilityStatus === "globalOnly" && (
                <div className="mt-3 rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
                  {t("extensions.project.globalOnlyDescription")}
                </div>
              )}
              <div className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-text-muted">
                <Check size={14} className="mt-0.5 shrink-0 text-success" />
                <span>{t("extensions.project.startupOnly")}</span>
              </div>
            </aside>
          </div>
          </>}
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 bg-surface-container-low/35 px-5 py-3">
          <Button variant="outline" disabled={saving} onClick={close}>{t("extensions.project.cancel")}</Button>
          <Button disabled={saving || loading || !response || forcedGlobalOnly} onClick={() => void save()}>
            {saving ? t("common.saving") : t("extensions.project.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
