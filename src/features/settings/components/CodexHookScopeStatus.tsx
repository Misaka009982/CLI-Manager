import { Badge, Stack, Text } from "@mantine/core";
import { useI18n } from "../../../shared/i18n/index";
import { codexHookNeedsReview } from "../api/codexHookStatus";
import type { ToolHookSettingsStatus } from "../lib/hookSettingsModel";

export function CodexHookScopeStatus({ status }: { status: ToolHookSettingsStatus | null | undefined }) {
  const { t } = useI18n();
  return (
    <Stack gap={6}>
      <Text size="xs" c="dimmed" className="break-all">
        {t("settings.hooks.codex.effectiveScope")}: {status?.effectiveConfigPath ?? t("settings.hooks.codex.checkUnavailable")}
      </Text>
      {codexHookNeedsReview(status) && <>
        <Badge color="yellow" variant="light">{t("settings.hooks.codex.pendingReview")}</Badge>
        <Text size="xs" c="dimmed">{t("settings.hooks.codex.reviewHint")}</Text>
      </>}
    </Stack>
  );
}
