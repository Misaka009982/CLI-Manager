import type {
  DesktopPetEConfigPayload,
  DesktopPetESnapshot,
} from "./desktopPetE";

export interface DesktopPetESyncPayload {
  enabled: boolean;
  existingDesktopPetEnabled: boolean;
  config: DesktopPetEConfigPayload;
  snapshot: DesktopPetESnapshot;
}

export function desktopPetESyncFingerprint(payload: DesktopPetESyncPayload): string {
  return JSON.stringify({
    enabled: payload.enabled,
    existingDesktopPetEnabled: payload.existingDesktopPetEnabled,
    config: payload.config,
    snapshotGeneration: payload.snapshot.generation,
    snapshotRevision: payload.snapshot.revision,
  });
}
