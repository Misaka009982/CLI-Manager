import type {
  BackgroundPetTask,
  DesktopPetBubbleGeometryPayload,
  DesktopPetBubbleLayoutRequestPayload,
  DesktopPetBubbleMeasurementPayload,
  DesktopPetSnapshot,
  DesktopPetSurfaceDeliveryMeta,
} from "./desktopPet";

export const DESKTOP_PET_DELIVERY_SURFACES = [
  "desktop-pet",
  "desktop-pet-bubble",
] as const;

export type DesktopPetDeliverySurface = typeof DESKTOP_PET_DELIVERY_SURFACES[number];

export interface DesktopPetDeliveryFingerprintState {
  configKey: string | null;
  snapshotKey: string | null;
}

export interface DesktopPetDeliveryPlan {
  configKey: string;
  snapshotKey: string;
  configTargets: DesktopPetDeliverySurface[];
  snapshotTargets: DesktopPetDeliverySurface[];
}

export function desktopPetSnapshotFingerprint(snapshot: DesktopPetSnapshot): string {
  return JSON.stringify({
    mood: snapshot.mood,
    sessionId: snapshot.sessionId,
    daemonOnly: snapshot.daemonOnly,
    sessionTitle: snapshot.sessionTitle,
    projectName: snapshot.projectName,
    runningCount: snapshot.runningCount,
    attentionCount: snapshot.attentionCount,
    statusCounts: snapshot.statusCounts,
    // 宠物 mood 与 Bubble 完成摘要保留都依赖源完成时间。
    updatedAt: snapshot.mood === "success" ? snapshot.updatedAt : 0,
    targets: snapshot.targets.map((target) => ({
      sessionId: target.sessionId,
      daemonOnly: target.daemonOnly,
      sessionTitle: target.sessionTitle,
      projectName: target.projectName,
      status: target.status,
      attentionKind: target.attentionKind,
      message: target.message,
      active: target.active,
      // 运行中的 PTY 输出仍是短期提示；Bubble 只读取 done 时间戳。
      updatedAt: target.status === "done" ? target.updatedAt : 0,
      handoffCandidate: target.handoffCandidate,
      handoffEligible: target.handoffEligible,
      handoffRecoverable: target.handoffRecoverable,
      handoffReason: target.handoffReason,
      handedOff: target.handedOff,
      handoffPhase: target.handoffPhase,
    })),
    decisionRequests: snapshot.decisionRequests,
    incidents: snapshot.incidents,
    handoff: snapshot.handoff,
    handoffPlatforms: snapshot.handoffPlatforms,
    handoffBusy: snapshot.handoffBusy,
  });
}

export function createDesktopPetLifecycleToken(entropy?: Uint8Array): string {
  let bytes = entropy;
  if (!bytes) {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.getRandomValues) {
      throw new Error("desktop_pet_secure_random_unavailable");
    }
    bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
  }
  if (bytes.length < 16) {
    throw new Error("desktop_pet_lifecycle_entropy_too_short");
  }
  return Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createDesktopPetSurfaceEpoch(entropy?: Uint8Array): string {
  return createDesktopPetLifecycleToken(entropy);
}

export function isDesktopPetSurfaceEpoch(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 16
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value);
}

export function shouldAcceptDesktopPetSurfaceEpoch(
  current: string | null,
  candidate: unknown,
  seen?: ReadonlySet<string>
): candidate is string {
  return isDesktopPetSurfaceEpoch(candidate)
    && candidate !== current
    && !seen?.has(candidate);
}

export function nextDesktopPetDeliveryRevision(
  current: number,
  now = Date.now()
): number {
  const safeCurrent = Number.isSafeInteger(current) && current >= 0 ? current : 0;
  if (safeCurrent >= Number.MAX_SAFE_INTEGER) {
    throw new Error("desktop_pet_delivery_revision_exhausted");
  }
  const safeNow = Number.isFinite(now) && now >= 0 ? Math.floor(now) : 0;
  const maximumTime = Math.floor((Number.MAX_SAFE_INTEGER - 1_024) / 1_024);
  const timeBase = Math.min(safeNow, maximumTime) * 1_024;
  return Math.max(safeCurrent + 1, timeBase);
}

export function createDesktopPetSurfaceEventPayload<T extends object>(
  payload: T,
  lifecycleToken: string,
  surfaceEpoch: unknown,
  deliveryRevision: number
): T & {
  lifecycleToken: string;
  surfaceEpoch: string;
  deliveryRevision: number;
} {
  if (!isDesktopPetSurfaceEpoch(lifecycleToken)) {
    throw new Error("desktop_pet_lifecycle_token_invalid");
  }
  if (!isDesktopPetSurfaceEpoch(surfaceEpoch)) {
    throw new Error("desktop_pet_surface_epoch_unavailable");
  }
  if (!Number.isSafeInteger(deliveryRevision) || deliveryRevision <= 0) {
    throw new Error("desktop_pet_delivery_revision_invalid");
  }
  return {
    ...payload,
    lifecycleToken,
    surfaceEpoch,
    deliveryRevision,
  };
}

export function shouldAcceptDesktopPetConfigDelivery(
  expectedSurfaceEpoch: string,
  previousRevision: number,
  candidate: DesktopPetSurfaceDeliveryMeta
): boolean {
  return isDesktopPetSurfaceEpoch(candidate.lifecycleToken)
    && candidate.surfaceEpoch === expectedSurfaceEpoch
    && isDesktopPetSurfaceEpoch(candidate.surfaceEpoch)
    && Number.isSafeInteger(candidate.deliveryRevision)
    && candidate.deliveryRevision > previousRevision;
}

export function shouldAcceptDesktopPetSnapshotDelivery(
  expectedLifecycleToken: string,
  expectedSurfaceEpoch: string,
  configRevision: number,
  previousSnapshotRevision: number,
  candidate: DesktopPetSurfaceDeliveryMeta
): boolean {
  return candidate.lifecycleToken === expectedLifecycleToken
    && candidate.surfaceEpoch === expectedSurfaceEpoch
    && Number.isSafeInteger(candidate.deliveryRevision)
    && candidate.deliveryRevision >= configRevision
    && candidate.deliveryRevision > previousSnapshotRevision;
}

export function shouldAcceptDesktopPetBubbleLayoutRequest(
  expectedLifecycleToken: string,
  current: DesktopPetBubbleLayoutRequestPayload | null,
  candidate: DesktopPetBubbleLayoutRequestPayload
): boolean {
  return candidate.lifecycleToken === expectedLifecycleToken
    && isDesktopPetSurfaceEpoch(candidate.petSurfaceEpoch)
    && Number.isSafeInteger(candidate.revision)
    && candidate.revision > 0
    && !(
      current?.petSurfaceEpoch === candidate.petSurfaceEpoch
      && current.revision >= candidate.revision
    );
}

export function shouldAcceptDesktopPetBubbleMeasurement(input: {
  expectedLifecycleToken: string;
  expectedPetSurfaceEpoch: string;
  expectedLayoutRevision: number;
  previous: DesktopPetBubbleMeasurementPayload | null;
  candidate: DesktopPetBubbleMeasurementPayload;
}): boolean {
  const { candidate, previous } = input;
  return candidate.lifecycleToken === input.expectedLifecycleToken
    && candidate.petSurfaceEpoch === input.expectedPetSurfaceEpoch
    && candidate.revision === input.expectedLayoutRevision
    && isDesktopPetSurfaceEpoch(candidate.bubbleSurfaceEpoch)
    && Number.isSafeInteger(candidate.measurementRevision)
    && candidate.measurementRevision > 0
    && Number.isFinite(candidate.naturalWidth)
    && Number.isFinite(candidate.naturalHeight)
    && candidate.naturalWidth > 0
    && candidate.naturalHeight > 0
    && !(
      previous?.bubbleSurfaceEpoch === candidate.bubbleSurfaceEpoch
      && previous.measurementRevision >= candidate.measurementRevision
    );
}

export function shouldAcceptDesktopPetBubbleGeometry(input: {
  expectedLifecycleToken: string;
  expectedBubbleSurfaceEpoch: string;
  expectedMeasurementRevision: number;
  previousGeometryRevision: number;
  request: DesktopPetBubbleLayoutRequestPayload | null;
  candidate: DesktopPetBubbleGeometryPayload;
}): boolean {
  const { candidate, request } = input;
  return candidate.lifecycleToken === input.expectedLifecycleToken
    && candidate.bubbleSurfaceEpoch === input.expectedBubbleSurfaceEpoch
    && Number.isSafeInteger(candidate.measurementRevision)
    && candidate.measurementRevision > 0
    && candidate.measurementRevision === input.expectedMeasurementRevision
    && Number.isSafeInteger(candidate.geometryRevision)
    && candidate.geometryRevision > input.previousGeometryRevision
    && ["above", "below", "left", "right"].includes(candidate.placement)
    && Number.isFinite(candidate.logicalWidth)
    && Number.isFinite(candidate.logicalHeight)
    && candidate.logicalWidth > 0
    && candidate.logicalHeight > 0
    && Number.isFinite(candidate.arrowOffset)
    && candidate.arrowOffset >= 0
    && candidate.arrowOffset <= (
      candidate.placement === "above" || candidate.placement === "below"
        ? candidate.logicalWidth
        : candidate.logicalHeight
    )
    && Boolean(
      request
      && candidate.petSurfaceEpoch === request.petSurfaceEpoch
      && candidate.revision === request.revision
    );
}

export function desktopPetLifecycleTokenMatches(
  expected: string | null,
  candidate: unknown
): candidate is string {
  return typeof candidate === "string"
    && expected !== null
    && candidate === expected;
}

export function createDesktopPetDeliveryPlan(input: {
  force: boolean;
  petVisible: boolean;
  bubbleVisible: boolean;
  configKey: string;
  snapshotKey: string;
  previous: DesktopPetDeliveryFingerprintState;
}): DesktopPetDeliveryPlan {
  const sendConfig = input.force || input.previous.configKey !== input.configKey;
  const sendSnapshot = input.petVisible
    && (input.force || input.previous.snapshotKey !== input.snapshotKey);
  return {
    configKey: input.configKey,
    snapshotKey: input.snapshotKey,
    configTargets: sendConfig ? [...DESKTOP_PET_DELIVERY_SURFACES] : [],
    snapshotTargets: sendSnapshot
      ? [
          "desktop-pet",
          ...(input.bubbleVisible ? ["desktop-pet-bubble" as const] : []),
        ]
      : [],
  };
}

export function commitDesktopPetDeliveryPlan(
  previous: DesktopPetDeliveryFingerprintState,
  plan: DesktopPetDeliveryPlan,
  succeeded: boolean
): DesktopPetDeliveryFingerprintState {
  if (!succeeded) return previous;
  return {
    configKey: plan.configTargets.length > 0 ? plan.configKey : previous.configKey,
    snapshotKey: plan.snapshotTargets.length > 0 ? plan.snapshotKey : previous.snapshotKey,
  };
}

export async function executeDesktopPetDeliveryPlan(
  plan: DesktopPetDeliveryPlan,
  deliverConfig: (surface: DesktopPetDeliverySurface) => Promise<void>,
  deliverSnapshot: (surface: DesktopPetDeliverySurface) => Promise<void>
): Promise<void> {
  await Promise.all(plan.configTargets.map(async (surface) => deliverConfig(surface)));
  await Promise.all(plan.snapshotTargets.map(async (surface) => deliverSnapshot(surface)));
}

export function sameBackgroundPetTasks(
  current: BackgroundPetTask[],
  next: BackgroundPetTask[]
): boolean {
  if (current.length !== next.length) return false;
  return current.every((task, index) => {
    const candidate = next[index];
    return task.sessionId === candidate.sessionId
      && task.cwd === candidate.cwd
      && task.alive === candidate.alive
      && task.taskStatus === candidate.taskStatus
      && task.taskUpdatedAtMs === candidate.taskUpdatedAtMs
      && task.createdAtMs === candidate.createdAtMs;
  });
}
