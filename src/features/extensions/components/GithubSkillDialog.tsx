import { useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { AlertTriangle, Check, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "../../../shared/i18n/index";
import {
  cancelGithubSkill,
  deployManagedSkill,
  installGithubSkill,
  previewGithubSkill,
} from "../api";
import type {
  ExtensionCli,
  GithubSkillCandidateView,
  GithubSkillInstallResult,
  GithubSkillPreview,
  SkillSyncMode,
} from "../../../shared/types/extensions";
import type { NativeProviderHomeState } from "../../settings/api/nativeProviderTypes";
import { ExtensionCompactRow } from "./ExtensionCompactRow";

interface GithubSkillDialogProps {
  open: boolean;
  home: NativeProviderHomeState | null;
  onClose: () => void;
  onInstalled: () => void;
}

const ERROR_KEYS: Partial<Record<string, TranslationKey>> = {
  extensions_github_skill_not_found: "extensions.errors.githubNotFound",
  extensions_github_url_invalid: "extensions.errors.githubUrlInvalid",
  extensions_github_preview_required: "extensions.errors.githubPreviewRequired",
  extensions_github_skill_selection_empty: "extensions.skills.githubSelectionEmpty",
  extensions_github_cancelled: "extensions.errors.githubCancelled",
};

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

function errorMessage(error: unknown, t: (key: TranslationKey) => string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.replace(/^Error:\s*/i, "").trim().split(":", 1)[0];
  return t(ERROR_KEYS[code] ?? "extensions.errors.generic");
}

function operationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `github-${uuid ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

export function GithubSkillDialog({ open, home, onClose, onInstalled }: GithubSkillDialogProps) {
  const { t } = useI18n();
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [reference, setReference] = useState("");
  const [subdirectory, setSubdirectory] = useState("");
  const [targetCli, setTargetCli] = useState<ExtensionCli>("claude");
  const [targetMode, setTargetMode] = useState<SkillSyncMode>("auto");
  const [preview, setPreview] = useState<GithubSkillPreview | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<GithubSkillInstallResult | null>(null);
  const [targetResults, setTargetResults] = useState<Array<{ packageId: string; status: "success" | "failed" }>>([]);
  const [busy, setBusy] = useState<"preview" | "install" | "deploy" | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRepositoryUrl("");
    setReference("");
    setSubdirectory("");
    setTargetCli("claude");
    setTargetMode("auto");
    setPreview(null);
    setSelectedIds(new Set());
    setResult(null);
    setTargetResults([]);
    setBusy(null);
    setCancelling(false);
    setActiveOperationId(null);
    setError(null);
  }, [open]);

  const allSelected = Boolean(preview?.candidates.length) && selectedIds.size === preview?.candidates.length;
  const operationPending = Boolean(busy) || cancelling;
  const failedTargetCount = targetResults.filter(item => item.status === "failed").length;

  const scan = async () => {
    if (!repositoryUrl.trim()) {
      setError(t("extensions.errors.githubUrlInvalid"));
      return;
    }
    const nextOperationId = operationId();
    setActiveOperationId(nextOperationId);
    setBusy("preview");
    setError(null);
    setResult(null);
    try {
      const next = await previewGithubSkill({
        repositoryUrl: repositoryUrl.trim(),
        reference: reference.trim() || null,
        subdirectory: subdirectory.trim() || null,
        operationId: nextOperationId,
      });
      setPreview(next);
      setSelectedIds(new Set(next.candidates.map((candidate) => candidate.candidateId)));
    } catch (scanError) {
      setPreview(null);
      setSelectedIds(new Set());
      setError(errorMessage(scanError, t));
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    if (!preview) return;
    if (selectedIds.size === 0) {
      setError(t("extensions.skills.githubSelectionEmpty"));
      return;
    }
    const targetHome = home;
    if (!targetHome) {
      setError(t("extensions.skills.noHome"));
      return;
    }
    const targetEnvironmentKind = targetHome.identity.environmentKind;
    const targetEnvironmentId = targetHome.identity.environmentId;
    const nextOperationId = operationId();
    setActiveOperationId(nextOperationId);
    setBusy("install");
    setError(null);
    try {
      const next = await installGithubSkill({
        repositoryUrl: preview.repositoryUrl,
        reference: preview.reference,
        subdirectory: preview.subdirectory || null,
        resolvedCommit: preview.resolvedCommit,
        candidateIds: Array.from(selectedIds),
        operationId: nextOperationId,
      });
      setResult(next);
      setTargetResults([]);
      setBusy("deploy");
      const deployed: Array<{ packageId: string; status: "success" | "failed" }> = [];
      for (const packageView of next.packages) {
        try {
          await deployManagedSkill({
            packageId: packageView.packageId,
            environmentKind: targetEnvironmentKind,
            environmentId: targetEnvironmentId,
            cli: targetCli,
            homePath: targetHome.homePath,
            mode: targetMode,
          });
          deployed.push({ packageId: packageView.packageId, status: "success" });
        } catch {
          deployed.push({ packageId: packageView.packageId, status: "failed" });
        }
        setTargetResults([...deployed]);
      }
      const failedTargets = deployed.filter((item) => item.status === "failed").length;
      if (failedTargets > 0) {
        setError(t("extensions.skills.githubTargetPartial", { count: failedTargets }));
      } else {
        toast.success(t("extensions.skills.githubSuccess"));
      }
      onInstalled();
    } catch (installError) {
      setError(errorMessage(installError, t));
    } finally {
      setBusy(null);
    }
  };

  // 取消确认与扫描/安装完成是两个独立请求；只有原操作收尾后才能解除 busy。
  const cancel = async () => {
    if (!activeOperationId || cancelling) return;
    setCancelling(true);
    try {
      await cancelGithubSkill(activeOperationId);
      setError(t("extensions.skills.githubCancelled"));
    } catch {
      setError(t("extensions.errors.generic"));
    } finally {
      setCancelling(false);
    }
  };

  const toggleAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(preview?.candidates.map((candidate) => candidate.candidateId) ?? []) : new Set());
  };

  const toggleCandidate = (candidate: GithubSkillCandidateView, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(candidate.candidateId);
      else next.delete(candidate.candidateId);
      return next;
    });
  };

  const close = () => {
    if (!operationPending) onClose();
  };

  return (
    <Modal
      opened={open}
      onClose={close}
      title={t("extensions.skills.githubTitle")}
      centered
      size="xl"
      zIndex={80}
      closeOnEscape={!operationPending}
      closeOnClickOutside={!operationPending}
      closeButtonProps={{ disabled: operationPending, "aria-label": t("extensions.import.close") }}
      styles={{
        content: { maxHeight: "92dvh", display: "flex", flexDirection: "column" },
        header: { flexShrink: 0 },
        body: { minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" },
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Stack gap="md">
          <Text size="xs" c="dimmed">{t("extensions.skills.githubDescription")}</Text>
          <details open={!preview} className="min-w-0 rounded-lg border border-border/60 p-3">
            <summary className="cursor-pointer truncate text-sm font-medium text-text-primary" title={repositoryUrl}>
              {preview ? `${preview.owner}/${preview.repository}` : t("extensions.skills.githubRepository")}
            </summary>
            <Stack gap="xs" mt="sm">
          <TextInput
            label={t("extensions.skills.githubRepository")}
            placeholder={t("extensions.skills.githubRepositoryPlaceholder")}
            value={repositoryUrl}
            disabled={operationPending}
            onChange={(event) => {
              setRepositoryUrl(event.currentTarget.value);
              setPreview(null);
              setSelectedIds(new Set());
              setResult(null);
            }}
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
            <TextInput
              label={t("extensions.skills.githubReference")}
              placeholder={t("extensions.skills.githubReferencePlaceholder")}
              value={reference}
              disabled={operationPending}
              onChange={(event) => {
                setReference(event.currentTarget.value);
                setPreview(null);
                setSelectedIds(new Set());
                setResult(null);
              }}
            />
            <TextInput
              label={t("extensions.skills.githubSubdirectory")}
              placeholder={t("extensions.skills.githubSubdirectoryPlaceholder")}
              value={subdirectory}
              disabled={operationPending}
              onChange={(event) => {
                setSubdirectory(event.currentTarget.value);
                setPreview(null);
                setSelectedIds(new Set());
                setResult(null);
              }}
            />
          </SimpleGrid>
            </Stack>
          </details>

          {error && <Alert color="red" variant="light" icon={<AlertTriangle size={16} />}>{error}</Alert>}
          {preview && (
            <Stack gap="sm">
              <Group justify="space-between" wrap="wrap">
                <Stack gap={2}>
                  <Text size="sm" fw={600}>{preview.owner}/{preview.repository}</Text>
                  <Text size="xs" c="dimmed" className="break-all">{t("extensions.skills.githubCommit", { commit: preview.resolvedCommit })}</Text>
                </Stack>
                <Checkbox
                  label={t("extensions.skills.githubSelectAll")}
                  checked={allSelected}
                  indeterminate={selectedIds.size > 0 && !allSelected}
                  disabled={operationPending}
                  onChange={(event) => toggleAll(event.currentTarget.checked)}
                />
              </Group>
              <Group justify="space-between" gap="xs">
                <Text size="sm" fw={600}>{t("extensions.skills.githubCandidates")}</Text>
                <Badge variant="light">{t("extensions.skills.githubSelected", { count: selectedIds.size, total: preview.candidates.length })}</Badge>
              </Group>
              {preview.candidates.length === 0 && <Text size="sm" c="dimmed">{t("extensions.errors.githubNotFound")}</Text>}
              <ScrollArea.Autosize mah="32dvh" type="auto" offsetScrollbars>
                <Stack gap="xs">
                  {preview.candidates.map((candidate) => (
                    <ExtensionCompactRow
                      key={candidate.candidateId}
                      selected={selectedIds.has(candidate.candidateId)}
                      leading={<Checkbox
                        id={`github-skill-${candidate.candidateId}`}
                        checked={selectedIds.has(candidate.candidateId)}
                        disabled={operationPending}
                        onChange={(event) => toggleCandidate(candidate, event.currentTarget.checked)}
                        aria-label={candidate.name}
                      />}
                      name={<label htmlFor={`github-skill-${candidate.candidateId}`} className="block cursor-pointer truncate" title={candidate.name}>{candidate.name}</label>}
                      description={<Text size="xs" c="dimmed" lineClamp={2} className="break-words" title={candidate.description}>{candidate.description}</Text>}
                      meta={<Text size="xs" c="dimmed" className="truncate" title={candidate.skillPath}>{t("extensions.skills.githubCandidatePath", { path: candidate.skillPath })}</Text>}
                      status={<Badge size="sm" variant="light" title={candidate.manifestHash}>{candidate.manifestHash.slice(0, 12)}</Badge>}
                    />
                  ))}
                </Stack>
              </ScrollArea.Autosize>
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm" className="border-t border-border/60 pt-3">
                <Select
                  label={t("extensions.skills.githubTarget")}
                  value={targetCli}
                  disabled={operationPending}
                  data={(["claude", "codex", "grok"] as ExtensionCli[]).map((item) => ({ value: item, label: t(CLI_LABEL_KEYS[item]) }))}
                  onChange={(value) => setTargetCli((value as ExtensionCli) || "claude")}
                />
                <Select
                  label={t("extensions.skills.githubTargetMode")}
                  value={targetMode}
                  disabled={operationPending}
                  data={(["auto", "symlink", "copy"] as SkillSyncMode[]).map((item) => ({ value: item, label: t(MODE_LABEL_KEYS[item]) }))}
                  onChange={(value) => setTargetMode((value as SkillSyncMode) || "auto")}
                />
              </SimpleGrid>
              {home ? (
                <Text size="xs" c="dimmed" className="break-all">
                  {t("extensions.skills.githubTargetPath", { path: home.targets[`${targetCli}ConfigDir` as keyof typeof home.targets] as string })}
                </Text>
              ) : (
                <Alert color="yellow">{t("extensions.skills.noHome")}</Alert>
              )}
            </Stack>
          )}

          {result && (
            <Alert color={operationPending ? "blue" : result.skipped > 0 || failedTargetCount > 0 ? "yellow" : "green"} variant="light">
              {operationPending ? t("extensions.loading")
                : failedTargetCount > 0 ? t("extensions.skills.githubTargetPartial", { count: failedTargetCount })
                : result.skipped > 0
                ? t("extensions.skills.githubPartial", { count: result.skipped })
                : t("extensions.skills.githubSuccess")}
              {result.warnings.length > 0 && (
                <Text size="xs" className="mt-1 break-words">{t("extensions.skills.githubWarnings")}: {result.warnings.join(" · ")}</Text>
              )}
              {targetResults.length > 0 && (
                <Stack gap={2} className="mt-2">
                  {targetResults.map((item) => (
                    <Group key={item.packageId} justify="space-between" gap="xs">
                      <Text size="xs" className="break-all">{item.packageId}</Text>
                      <Badge color={item.status === "success" ? "green" : "red"}>
                        {item.status === "success" ? t("extensions.skills.githubTargetSuccess") : t("extensions.skills.githubTargetFailed")}
                      </Badge>
                    </Group>
                  ))}
                </Stack>
              )}
            </Alert>
          )}
        </Stack>
      </div>
      <Group justify="space-between" gap="xs" mt="md" pt="sm" className="shrink-0 border-t border-border/60">
        {(busy === "preview" || busy === "install" || cancelling)
          ? <Button variant="light" color="gray" leftSection={<X size={15} />} loading={cancelling} disabled={cancelling} onClick={() => void cancel()}>{t("extensions.skills.githubCancel")}</Button>
          : <Button variant="subtle" color="gray" disabled={operationPending} onClick={close}>{t("extensions.import.close")}</Button>}
        <Group gap="xs">
          <Button variant={preview ? "light" : "filled"} color="cliPrimary" leftSection={<RefreshCw size={15} />} loading={busy === "preview"} disabled={operationPending || !repositoryUrl.trim()} onClick={() => void scan()}>
            {t("extensions.skills.githubPreview")}
          </Button>
          {preview && <Button color="cliPrimary" leftSection={<Check size={15} />} loading={busy === "install" || busy === "deploy"} disabled={operationPending || selectedIds.size === 0 || !home} onClick={() => void install()}>
            {t("extensions.skills.githubInstall")}
          </Button>}
        </Group>
      </Group>
    </Modal>
  );
}
