import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Alert,
  Box,
  Button,
  Group,
  SegmentedControl,
  Slider,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import {
  Bell,
  CircleGauge,
  Eye,
  Lock,
  MessageSquareText,
  MonitorUp,
  MousePointer2,
  Palette,
  RotateCcw,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";
import {
  DESKTOP_PET_E_SIZE_MAX_PERCENT,
  DESKTOP_PET_E_SIZE_MIN_PERCENT,
  type DesktopPetESettings,
} from "../../../lib/desktopPetE";
import { useI18n } from "../../../lib/i18n";
import { useSettingsStore } from "../../../stores/settingsStore";

interface ToggleRowProps {
  icon: ReactNode;
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

function ToggleRow({ icon, title, description, checked, disabled, onChange }: ToggleRowProps) {
  return (
    <Group justify="space-between" align="flex-start" gap="lg" wrap="nowrap">
      <Group align="flex-start" gap="sm" wrap="nowrap" className="min-w-0 flex-1">
        <Box mt={2} c="var(--primary)">{icon}</Box>
        <Box className="min-w-0">
          <Text size="sm" fw={500} c="var(--on-surface)">{title}</Text>
          <Text mt={3} size="xs" c="var(--on-surface-variant)">{description}</Text>
        </Box>
      </Group>
      <Switch
        color="cliPrimary"
        checked={checked}
        disabled={disabled}
        aria-label={title}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </Group>
  );
}

export function DesktopPetESettingsPage() {
  const { t } = useI18n();
  const desktopPet = useSettingsStore((state) => state.desktopPet);
  const desktopPetE = useSettingsStore((state) => state.desktopPetE);
  const updateSetting = useSettingsStore((state) => state.update);
  const [sizeDraft, setSizeDraft] = useState(desktopPetE.size);
  const enableBlocked = desktopPet.enabled && !desktopPetE.enabled;

  useEffect(() => setSizeDraft(desktopPetE.size), [desktopPetE.size]);

  const patch = useCallback(async (delta: Partial<DesktopPetESettings>): Promise<boolean> => {
    const current = useSettingsStore.getState().desktopPetE;
    try {
      await updateSetting("desktopPetE", { ...current, ...delta });
      return true;
    } catch (error) {
      toast.error(t("desktopPetE.settings.updateFailed"), { description: String(error) });
      return false;
    }
  }, [t, updateSetting]);

  const commitSize = useCallback((value: number) => {
    const next = Math.round(Math.min(
      DESKTOP_PET_E_SIZE_MAX_PERCENT,
      Math.max(DESKTOP_PET_E_SIZE_MIN_PERCENT, value)
    ));
    setSizeDraft(next);
    void patch({ size: next });
  }, [patch]);

  const resetPosition = useCallback(() => {
    void patch({ position: null }).then((saved) => {
      if (saved) toast.success(t("desktopPetE.settings.resetPositionSuccess"));
    });
  }, [patch, t]);

  return (
    <Stack gap="md">
      <section className="ui-surface-card rounded-lg border border-border p-4">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" gap="lg" wrap="nowrap">
            <Group align="flex-start" gap="sm" wrap="nowrap" className="min-w-0 flex-1">
              <Box mt={2} c="var(--primary)"><MonitorUp size={20} /></Box>
              <Box className="min-w-0">
                <Text size="sm" fw={600} c="var(--on-surface)">
                  {t("desktopPetE.settings.enable")}
                </Text>
                <Text mt={3} size="xs" c="var(--on-surface-variant)">
                  {t("desktopPetE.settings.enableDescription")}
                </Text>
              </Box>
            </Group>
            <Switch
              size="md"
              color="cliPrimary"
              checked={desktopPetE.enabled}
              disabled={enableBlocked}
              aria-label={t("desktopPetE.settings.enable")}
              onChange={(event) => void patch({ enabled: event.currentTarget.checked })}
            />
          </Group>
          {enableBlocked ? (
            <Alert color="blue" variant="light" title={t("desktopPetE.settings.mutualExclusionTitle")}>
              {t("desktopPetE.settings.mutualExclusionDescription")}
            </Alert>
          ) : null}
        </Stack>
      </section>

      <section className="ui-surface-card rounded-lg border border-border p-4">
        <Stack gap="md">
          <Group align="flex-start" gap="sm" wrap="nowrap">
            <Box mt={2} c="var(--primary)"><Palette size={18} /></Box>
            <Box>
              <Text size="sm" fw={600} c="var(--on-surface)">{t("desktopPetE.settings.appearance")}</Text>
              <Text mt={3} size="xs" c="var(--on-surface-variant)">
                {t("desktopPetE.settings.appearanceDescription")}
              </Text>
            </Box>
          </Group>
          <Box>
            <Text mb={6} size="xs" fw={500} c="var(--on-surface)">{t("desktopPetE.settings.theme")}</Text>
            <SegmentedControl
              fullWidth
              value={desktopPetE.theme}
              onChange={(value) => void patch({ theme: value as DesktopPetESettings["theme"] })}
              data={[
                { value: "clawd", label: "Clawd" },
                { value: "calico", label: "Calico" },
                { value: "cloudling", label: "Cloudling" },
              ]}
            />
          </Box>
          <Box>
            <Group justify="space-between" align="center" gap="md">
              <Text size="xs" fw={500} c="var(--on-surface)">{t("desktopPetE.settings.size")}</Text>
              <Text size="xs" ff="var(--font-ui-mono)" className="tabular-nums">{sizeDraft}%</Text>
            </Group>
            <Slider
              mt="xs"
              min={DESKTOP_PET_E_SIZE_MIN_PERCENT}
              max={DESKTOP_PET_E_SIZE_MAX_PERCENT}
              step={5}
              value={sizeDraft}
              onChange={setSizeDraft}
              onChangeEnd={commitSize}
              label={(value) => `${value}%`}
              color="cliPrimary"
              aria-label={t("desktopPetE.settings.size")}
            />
          </Box>
          <ToggleRow
            icon={<Lock size={18} />}
            title={t("desktopPetE.settings.lockPosition")}
            description={t("desktopPetE.settings.lockPositionDescription")}
            checked={desktopPetE.lockPosition}
            onChange={(checked) => void patch({ lockPosition: checked })}
          />
          <ToggleRow
            icon={<MonitorUp size={18} />}
            title={t("desktopPetE.settings.alwaysOnTop")}
            description={t("desktopPetE.settings.alwaysOnTopDescription")}
            checked={desktopPetE.alwaysOnTop}
            onChange={(checked) => void patch({ alwaysOnTop: checked })}
          />
          <Button
            variant="light"
            size="xs"
            leftSection={<RotateCcw size={14} />}
            onClick={resetPosition}
            className="self-start"
          >
            {t("desktopPetE.settings.resetPosition")}
          </Button>
        </Stack>
      </section>

      <section className="ui-surface-card rounded-lg border border-border p-4">
        <Stack gap="md">
          <ToggleRow
            icon={<Volume2 size={18} />}
            title={t("desktopPetE.settings.sound")}
            description={t("desktopPetE.settings.soundDescription")}
            checked={desktopPetE.soundEnabled}
            onChange={(checked) => void patch({ soundEnabled: checked })}
          />
          <ToggleRow
            icon={<CircleGauge size={18} />}
            title={t("desktopPetE.settings.showStatus")}
            description={t("desktopPetE.settings.showStatusDescription")}
            checked={desktopPetE.showStatus}
            onChange={(checked) => void patch({ showStatus: checked })}
          />
          <ToggleRow
            icon={<MessageSquareText size={18} />}
            title={t("desktopPetE.settings.showCliLabel")}
            description={t("desktopPetE.settings.showCliLabelDescription")}
            checked={desktopPetE.showCliLabel}
            onChange={(checked) => void patch({ showCliLabel: checked })}
          />
          <ToggleRow
            icon={<CircleGauge size={18} />}
            title={t("desktopPetE.settings.showTaskArea")}
            description={t("desktopPetE.settings.showTaskAreaDescription")}
            checked={desktopPetE.showTaskArea}
            onChange={(checked) => void patch({ showTaskArea: checked })}
          />
          <ToggleRow
            icon={<MousePointer2 size={18} />}
            title={t("desktopPetE.settings.openOnHover")}
            description={t("desktopPetE.settings.openOnHoverDescription")}
            checked={desktopPetE.openOnHover}
            onChange={(checked) => void patch({ openOnHover: checked })}
          />
          <ToggleRow
            icon={<Eye size={18} />}
            title={t("desktopPetE.settings.autoHideFullscreen")}
            description={t("desktopPetE.settings.autoHideFullscreenDescription")}
            checked={desktopPetE.autoHideFullscreen}
            onChange={(checked) => void patch({ autoHideFullscreen: checked })}
          />
          <ToggleRow
            icon={<Bell size={18} />}
            title={t("desktopPetE.settings.notifications")}
            description={t("desktopPetE.settings.notificationsDescription")}
            checked={desktopPetE.notificationsEnabled}
            onChange={(checked) => void patch({ notificationsEnabled: checked })}
          />
          <ToggleRow
            icon={<MessageSquareText size={18} />}
            title={t("desktopPetE.settings.agentInteraction")}
            description={t("desktopPetE.settings.agentInteractionDescription")}
            checked={desktopPetE.agentInteractionEnabled}
            onChange={(checked) => void patch({ agentInteractionEnabled: checked })}
          />
        </Stack>
      </section>
    </Stack>
  );
}
