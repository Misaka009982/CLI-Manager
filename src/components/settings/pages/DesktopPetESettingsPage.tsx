import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Alert,
  Box,
  Button,
  Group,
  SimpleGrid,
  Skeleton,
  Slider,
  Stack,
  Switch,
  Text,
  UnstyledButton,
} from "@mantine/core";
import {
  Bell,
  Check,
  CircleGauge,
  Eye,
  ImageOff,
  Lock,
  MessageSquareText,
  MonitorUp,
  MousePointer2,
  Palette,
  RefreshCw,
  RotateCcw,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";
import { PetArtwork } from "../../desktop-pet/PetArtwork";
import {
  localizedPetText,
  type InstalledPet,
} from "../../../lib/desktopPet";
import {
  DESKTOP_PET_E_PETS_CHANGED_EVENT,
  DESKTOP_PET_E_SIZE_MAX_PERCENT,
  DESKTOP_PET_E_SIZE_MIN_PERCENT,
  type DesktopPetESettings,
} from "../../../lib/desktopPetE";
import { useI18n } from "../../../lib/i18n";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useDesktopPetERuntimeStore } from "../../../stores/desktopPetERuntimeStore";

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

interface PetSelectionButtonProps {
  pet: InstalledPet;
  name: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}

function PetSelectionButton({ pet, name, selected, disabled, onSelect }: PetSelectionButtonProps) {
  const { t } = useI18n();
  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    setPreviewFailed(false);
  }, [pet]);

  return (
    <UnstyledButton
      type="button"
      className={`ui-focus-ring min-h-[132px] min-w-0 rounded-lg border p-2 text-left transition-colors ${
        selected
          ? "border-primary bg-primary/10"
          : "border-border bg-surface-container-lowest hover:border-primary/40"
      } disabled:cursor-not-allowed disabled:opacity-60`}
      disabled={disabled}
      aria-label={name}
      aria-pressed={selected}
      title={name}
      onClick={onSelect}
    >
      <Box className="grid h-24 w-full place-items-center overflow-hidden rounded-md bg-surface-low">
        {previewFailed ? (
          <ImageOff
            size={26}
            color="var(--on-surface-variant)"
            role="img"
            aria-label={t("desktopPetE.settings.previewUnavailable")}
          />
        ) : (
          <PetArtwork
            pet={pet}
            alt={t("desktopPet.settings.previewAlt", { name })}
            width={88}
            height={88}
            mood="idle"
            animated={false}
            onError={() => setPreviewFailed(true)}
          />
        )}
      </Box>
      <Group mt={8} gap={6} wrap="nowrap">
        <Text
          className="min-w-0 flex-1 truncate"
          size="xs"
          fw={selected ? 600 : 500}
          c={selected ? "var(--primary)" : "var(--on-surface)"}
        >
          {name}
        </Text>
        {selected ? <Check size={14} className="shrink-0 text-primary" aria-hidden="true" /> : null}
      </Group>
    </UnstyledButton>
  );
}

export function DesktopPetESettingsPage() {
  const { language, t } = useI18n();
  const desktopPet = useSettingsStore((state) => state.desktopPet);
  const desktopPetE = useSettingsStore((state) => state.desktopPetE);
  const runtimeError = useDesktopPetERuntimeStore((state) => state.lastError);
  const updateSetting = useSettingsStore((state) => state.update);
  const [sizeDraft, setSizeDraft] = useState(desktopPetE.size);
  const [codexPets, setCodexPets] = useState<InstalledPet[]>([]);
  const [petsLoading, setPetsLoading] = useState(true);
  const [selectingPetId, setSelectingPetId] = useState<string | null>(null);
  const selectionInFlightRef = useRef<string | null>(null);
  const enableBlockedByExistingPet = desktopPet.enabled && !desktopPetE.enabled;
  const enableBlockedByMissingPet = codexPets.length === 0 && !desktopPetE.enabled;
  const enableBlocked = enableBlockedByExistingPet || enableBlockedByMissingPet;

  const loadCodexPets = useCallback(async () => {
    setPetsLoading(true);
    try {
      const installed = await invoke<InstalledPet[]>("desktop_pet_list_installed");
      const pets = installed.filter((pet) => pet.format === "codex" && pet.manifest.engine === "codex-sprite");
      setCodexPets(pets);
      window.dispatchEvent(new Event(DESKTOP_PET_E_PETS_CHANGED_EVENT));
    } catch (error) {
      setCodexPets([]);
      toast.error(t("desktopPetE.settings.petScanFailed"), { description: String(error) });
    } finally {
      setPetsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadCodexPets();
  }, [loadCodexPets]);

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

  const selectPet = useCallback((petId: string) => {
    const currentPetId = useSettingsStore.getState().desktopPetE.petId;
    if (selectionInFlightRef.current !== null || petId === currentPetId) return;
    selectionInFlightRef.current = petId;
    setSelectingPetId(petId);
    void patch({ petId }).finally(() => {
      if (selectionInFlightRef.current === petId) selectionInFlightRef.current = null;
      setSelectingPetId((current) => current === petId ? null : current);
    });
  }, [patch]);

  useEffect(() => {
    if (petsLoading || codexPets.length === 0 || desktopPetE.petId) return;
    const availableIds = new Set(codexPets.map((pet) => pet.manifest.id));
    const preferredId = availableIds.has(desktopPet.petId)
      ? desktopPet.petId
      : codexPets[0]?.manifest.id;
    if (preferredId) selectPet(preferredId);
  }, [codexPets, desktopPet.petId, desktopPetE.petId, petsLoading, selectPet]);

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
          {runtimeError ? (
            <Alert color="red" variant="light" title={t("desktopPetE.settings.runtimeErrorTitle")}>
              <Stack gap={4}>
                <Text size="xs">{t("desktopPetE.settings.runtimeErrorDescription")}</Text>
                <Text size="xs" ff="var(--font-ui-mono)" className="break-all">
                  {runtimeError.code}{runtimeError.detail ? `: ${runtimeError.detail}` : ""}
                </Text>
              </Stack>
            </Alert>
          ) : null}
          {enableBlockedByExistingPet ? (
            <Alert color="blue" variant="light" title={t("desktopPetE.settings.mutualExclusionTitle")}>
              {t("desktopPetE.settings.mutualExclusionDescription")}
            </Alert>
          ) : null}
          {enableBlockedByMissingPet ? (
            <Alert color="yellow" variant="light" title={t("desktopPetE.settings.noCodexPetsTitle")}>
              {t("desktopPetE.settings.noCodexPetsDescription")}
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
            <Group mb={6} justify="space-between" align="center" gap="sm">
              <Text size="xs" fw={500} c="var(--on-surface)">{t("desktopPetE.settings.pet")}</Text>
              <Button
                size="compact-xs"
                variant="subtle"
                leftSection={<RefreshCw size={13} />}
                loading={petsLoading}
                disabled={selectingPetId !== null}
                onClick={() => void loadCodexPets()}
              >
                {t("desktopPetE.settings.rescanPets")}
              </Button>
            </Group>
            {petsLoading ? (
              <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="sm" aria-hidden="true">
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} height={132} radius="md" />
                ))}
              </SimpleGrid>
            ) : codexPets.length > 0 ? (
              <SimpleGrid
                cols={{ base: 2, sm: 3 }}
                spacing="sm"
                role="group"
                aria-label={t("desktopPetE.settings.pet")}
                aria-busy={selectingPetId !== null}
              >
                {codexPets.map((pet) => (
                  <PetSelectionButton
                    key={pet.manifest.id}
                    pet={pet}
                    name={localizedPetText(pet.manifest.name, language)}
                    selected={desktopPetE.petId === pet.manifest.id}
                    disabled={selectingPetId !== null}
                    onSelect={() => selectPet(pet.manifest.id)}
                  />
                ))}
              </SimpleGrid>
            ) : (
              <Text size="xs" c="var(--on-surface-variant)">
                {t("desktopPetE.settings.noCodexPets")}
              </Text>
            )}
            <Text mt={6} size="xs" c="var(--on-surface-variant)">
              {t("desktopPetE.settings.petDescription")}
            </Text>
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
