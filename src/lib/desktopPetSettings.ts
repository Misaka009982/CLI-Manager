import type {
  DesktopPetRuntime,
  DesktopPetRuntimeProfile,
  DesktopPetSettings,
  ResolvedDesktopPetSettings,
} from "../stores/settingsStore";

export function resolveDesktopPetSettings(
  settings: DesktopPetSettings,
  runtime: DesktopPetRuntime
): ResolvedDesktopPetSettings {
  return {
    enabled: settings.enabled,
    runtime,
    ...settings.profiles[runtime],
  };
}

export function patchDesktopPetRuntimeProfile(
  settings: DesktopPetSettings,
  runtime: DesktopPetRuntime,
  delta: Partial<DesktopPetRuntimeProfile>
): DesktopPetSettings {
  return {
    ...settings,
    profiles: {
      ...settings.profiles,
      [runtime]: {
        ...settings.profiles[runtime],
        ...delta,
      },
    },
  };
}
