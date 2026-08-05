import {
  Badge,
  Button,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import { Copy, FolderOpen, Wrench } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import type { NativeProviderEnvironmentReport } from "./nativeProviderTypes";
import type { UseNativeProviderHomeResult } from "./useNativeProviderHome";
import { PathItem } from "./NativeProviderPathItem";

type EnvironmentState = Pick<
  UseNativeProviderHomeResult,
  "report" | "loading" | "action" | "inspectEnvironment" | "repair"
>;

interface NativeProviderEnvironmentSectionProps {
  state: EnvironmentState;
}

export function NativeProviderEnvironmentSection({
  state,
}: NativeProviderEnvironmentSectionProps) {
  const { t } = useI18n();
  const report = state.report;
  const busy = Boolean(state.action) || state.loading;

  const openTarget = async (path: string) => {
    try {
      await invoke("provider_environment_open_target", { path, openFile: false });
    } catch {
      toast.error(t("providerCatalog.environment.openFailed"));
    }
  };

  const copyDiagnostics = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(safeDiagnostics(report), null, 2));
      toast.success(t("providerCatalog.environment.copySuccess"));
    } catch {
      toast.error(t("providerCatalog.environment.copyFailed"));
    }
  };

  return (
    <Card withBorder radius="lg" padding="md" className="border-border/70 bg-surface-container-low">
      <Stack gap="sm">
        <Group justify="space-between">
          <Stack gap={2}>
            <Text fw={600}>{t("providerCatalog.environment.title")}</Text>
            <Text size="xs" c="dimmed">{t("providerCatalog.environment.description")}</Text>
          </Stack>
          <Group gap="xs">
            {report?.pendingRecovery && <Badge color="red">{t("providerCatalog.environment.recoveryPending")}</Badge>}
            {report && (
              <Button
                size="compact-sm"
                variant="subtle"
                color="gray"
                leftSection={<Copy size={14} />}
                onClick={() => void copyDiagnostics()}
              >
                {t("providerCatalog.environment.copyDiagnostics")}
              </Button>
            )}
            <Button
              size="compact-sm"
              variant="light"
              leftSection={<Wrench size={14} />}
              loading={state.action === "inspect-environment"}
              disabled={busy}
              onClick={() => void state.inspectEnvironment()}
            >
              {t("providerCatalog.environment.inspect")}
            </Button>
            {report?.pendingRecovery && (
              <Button
                size="compact-sm"
                variant="subtle"
                loading={state.action === "repair"}
                disabled={busy}
                onClick={() => void state.repair()}
              >
                {t("providerCatalog.environment.repair")}
              </Button>
            )}
          </Group>
        </Group>
        {report && (
          <Stack gap="xs">
            <Text size="xs" c="dimmed">
              {t("providerCatalog.environment.homeSource", {
                source: report.home.source === "manual"
                  ? t("providerCatalog.home.sourceManual")
                  : t("providerCatalog.home.sourceAuto"),
              })}
            </Text>
            <Group justify="space-between" wrap="nowrap">
              <Text size="xs" c="dimmed">{t("providerCatalog.environment.currentProvider")}</Text>
              <Group gap="xs" wrap="nowrap">
                <Text size="xs" truncate>
                  {report.currentProvider.providerName ?? t("providerCatalog.environment.notSet")}
                </Text>
                <Badge color={report.currentProvider.activeKeyPresent ? "green" : "yellow"}>
                  {report.currentProvider.activeKeyPresent
                    ? t("providerCatalog.environment.keyReady")
                    : t("providerCatalog.environment.keyMissing")}
                </Badge>
              </Group>
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
              {report.cli.map((cli) => (
                <PathItem
                  key={cli.name}
                  label={cli.name}
                  path={cli.available
                    ? [cli.executable ?? "", cli.version ?? ""].filter(Boolean).join(" · ")
                    : t("providerCatalog.environment.unavailable")}
                />
              ))}
            </SimpleGrid>
            {report.targets.map((target) => (
              <Group key={target.name} justify="space-between" wrap="nowrap" className="rounded-md border border-border/50 px-2 py-1">
                <Stack gap={0} miw={0}>
                  <Text size="xs" truncate>{target.name}</Text>
                  <Text size="xs" c="dimmed" truncate title={target.path}>{target.path}</Text>
                </Stack>
                <Group gap={4} wrap="nowrap">
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    leftSection={<FolderOpen size={13} />}
                    disabled={!target.exists}
                    aria-label={t("providerCatalog.environment.openTarget")}
                    onClick={() => void openTarget(target.path)}
                  >
                    {t("providerCatalog.environment.openTarget")}
                  </Button>
                  <Badge color={target.syntax === "valid" ? "green" : "yellow"}>
                    {target.syntax === "valid"
                      ? t("providerCatalog.environment.valid")
                      : target.syntax === "missing"
                        ? t("providerCatalog.environment.missing")
                        : t("providerCatalog.environment.invalid")}
                  </Badge>
                  <Badge color={target.readable ? "green" : "red"}>
                    {target.readable
                      ? t("providerCatalog.environment.readable")
                      : t("providerCatalog.environment.notReadable")}
                  </Badge>
                  <Badge color={target.writable ? "green" : "red"}>
                    {target.writable
                      ? t("providerCatalog.environment.writable")
                      : t("providerCatalog.environment.notWritable")}
                  </Badge>
                </Group>
              </Group>
            ))}
            <Stack gap={4}>
              <Group justify="space-between" wrap="nowrap">
                <Text size="xs" fw={600}>{t("providerCatalog.environment.roots")}</Text>
                <Badge color={report.alignment.automaticRootsAligned ? "green" : "yellow"}>
                  {report.alignment.automaticRootsAligned
                    ? t("providerCatalog.environment.rootsAligned")
                    : t("providerCatalog.environment.rootsExplicit")}
                </Badge>
              </Group>
              {[
                ["claudeHook", t("providerCatalog.environment.claudeHook"), report.alignment.claudeHookRoot],
                ["codexHook", t("providerCatalog.environment.codexHook"), report.alignment.codexHookRoot],
                ["grokHook", t("providerCatalog.environment.grokHook"), report.alignment.grokHookRoot],
                ["claudeHistory", t("providerCatalog.environment.claudeHistory"), report.alignment.claudeHistoryRoot],
                ["codexHistory", t("providerCatalog.environment.codexHistory"), report.alignment.codexHistoryRoot],
                ["grokHistory", t("providerCatalog.environment.grokHistory"), report.alignment.grokHistoryRoot],
              ].map(([id, label, path]) => (
                <Group key={id} justify="space-between" wrap="nowrap">
                  <Text size="xs" c="dimmed">{label}</Text>
                  <Group gap={4} wrap="nowrap" miw={0}>
                    <Text size="xs" truncate title={path}>{path}</Text>
                    {report.alignment.explicitRoots.includes(id) && (
                      <Badge color="yellow">{t("providerCatalog.environment.explicit")}</Badge>
                    )}
                  </Group>
                </Group>
              ))}
            </Stack>
            {report.conflicts.length > 0 && (
              <Stack gap={4}>
                <Text size="xs" fw={600}>{t("providerCatalog.environment.conflicts")}</Text>
                {report.conflicts.map((conflict) => (
                  <Group key={conflict.variable} justify="space-between" wrap="nowrap">
                    <Text size="xs">{conflict.variable}</Text>
                    <Badge color={!conflict.present || conflict.matchesHome ? "green" : "yellow"}>
                      {!conflict.present
                        ? t("providerCatalog.environment.notSet")
                        : conflict.matchesHome
                          ? t("providerCatalog.environment.matchesHome")
                          : t("providerCatalog.environment.conflict")}
                    </Badge>
                  </Group>
                ))}
              </Stack>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

function safeDiagnostics(report: NativeProviderEnvironmentReport) {
  return {
    home: report.home,
    cli: report.cli,
    targets: report.targets,
    currentProvider: report.currentProvider,
    conflicts: report.conflicts,
    alignment: report.alignment,
    pendingRecovery: report.pendingRecovery,
  };
}
