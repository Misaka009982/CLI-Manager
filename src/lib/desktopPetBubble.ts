import type {
  DesktopPetDecisionRequest,
  DesktopPetIncident,
  DesktopPetSnapshot,
  DesktopPetTarget,
} from "./desktopPet";
import type { DesktopPetWindowRect } from "./desktopPetMenu";

export const DESKTOP_PET_BUBBLE_DEFAULT_WIDTH = 410;
export const DESKTOP_PET_BUBBLE_MIN_WIDTH = 280;
export const DESKTOP_PET_BUBBLE_WORK_AREA_MARGIN = 12;
export const DESKTOP_PET_BUBBLE_ANCHOR_GAP = 12;
export const DESKTOP_PET_COMPLETION_DURATION_MS = 8_000;
export const DESKTOP_PET_MAX_HIT_REGIONS = 64;

export type DesktopPetBubblePlacement = "above" | "below" | "left" | "right";

export interface DesktopPetCompletionSummary {
  id: string;
  sessionId: string;
  daemonOnly: boolean;
  sessionTitle: string | null;
  projectName: string | null;
  message: string | null;
  updatedAt: number;
}

export interface DesktopPetBubbleContent {
  decisions: DesktopPetDecisionRequest[];
  incidents: DesktopPetIncident[];
  completion: DesktopPetCompletionSummary | null;
}

export interface DesktopPetCompletionTimer {
  summaryId: string;
  expiresAt: number;
  remainingMs: number;
  paused: boolean;
}

export interface DesktopPetBubbleGeometryInput {
  anchor: DesktopPetWindowRect;
  workArea?: DesktopPetWindowRect | null;
  naturalWidth: number;
  naturalHeight: number;
  scaleFactor: number;
  margin?: number;
  gap?: number;
}

export interface DesktopPetBubbleGeometry {
  bounds: DesktopPetWindowRect;
  logicalWidth: number;
  logicalHeight: number;
  placement: DesktopPetBubblePlacement;
  arrowOffset: number;
}

export interface DesktopPetLogicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopPetFrameScheduler {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (handle: number) => void;
}

export interface DesktopPetLatestFrameTaskRunner<T> {
  schedule: (value: T) => void;
  flush: () => void;
  dispose: () => void;
}

interface PlacementCandidate {
  placement: DesktopPetBubblePlacement;
  width: number;
  height: number;
  fullFit: boolean;
  capacityScore: number;
  visibleScore: number;
  tieOrder: number;
}

const DECISION_PRIORITY: Record<DesktopPetDecisionRequest["kind"], number> = {
  permission: 0,
  questionnaire: 1,
  question: 2,
};

function finiteNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function positiveNumber(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum <= minimum) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function completionSummaryFromTarget(target: DesktopPetTarget): DesktopPetCompletionSummary {
  const updatedAt = Math.max(0, finiteNumber(target.updatedAt));
  return {
    id: `${target.sessionId}:${updatedAt}`,
    sessionId: target.sessionId,
    daemonOnly: target.daemonOnly,
    sessionTitle: target.sessionTitle,
    projectName: target.projectName,
    message: target.message,
    updatedAt,
  };
}

/**
 * 从共享快照中选择 Bubble 的统一内容栈。函数不修改源数组，确保两个窗口可复用同一策略。
 */
export function deriveDesktopPetBubbleContent(
  snapshot: DesktopPetSnapshot
): DesktopPetBubbleContent {
  const decisions = snapshot.decisionRequests
    .map((request, index) => ({ request, index }))
    .sort((left, right) => (
      DECISION_PRIORITY[left.request.kind] - DECISION_PRIORITY[right.request.kind]
      || left.request.createdAt - right.request.createdAt
      || left.index - right.index
    ))
    .map(({ request }) => request);
  const incidents = snapshot.incidents
    .map((incident, index) => ({ incident, index }))
    .sort((left, right) => (
      right.incident.createdAt - left.incident.createdAt
      || left.index - right.index
    ))
    .map(({ incident }) => incident);
  const completionTarget = snapshot.targets
    .filter((target) => target.status === "done")
    .reduce<DesktopPetTarget | null>((latest, target) => {
      if (!latest || target.updatedAt > latest.updatedAt) return target;
      if (target.updatedAt < latest.updatedAt) return latest;
      return target.sessionId < latest.sessionId ? target : latest;
    }, null);

  return {
    decisions,
    incidents,
    completion: completionTarget
      ? completionSummaryFromTarget(completionTarget)
      : null,
  };
}

export function updateDesktopPetActiveCompletionId(
  currentId: string | null,
  summary: DesktopPetCompletionSummary | null,
  dismissedId: string | null,
  now: number
): string | null {
  if (!summary || summary.id === dismissedId) return null;
  if (summary.id === currentId) return currentId;
  const safeNow = Math.max(0, finiteNumber(now));
  return summary.updatedAt + DESKTOP_PET_COMPLETION_DURATION_MS > safeNow
    ? summary.id
    : null;
}

/**
 * 维护完成摘要的稳定寿命。重复快照不会重置计时，悬停只暂停尚未耗尽的剩余时间。
 */
export function updateDesktopPetCompletionTimer(
  current: DesktopPetCompletionTimer | null,
  summary: DesktopPetCompletionSummary | null,
  now: number,
  paused: boolean
): DesktopPetCompletionTimer | null {
  if (!summary) return null;
  const safeNow = Math.max(0, finiteNumber(now));

  if (!current || current.summaryId !== summary.id) {
    const sourceExpiresAt = summary.updatedAt + DESKTOP_PET_COMPLETION_DURATION_MS;
    const remainingMs = Math.min(
      DESKTOP_PET_COMPLETION_DURATION_MS,
      Math.max(0, sourceExpiresAt - safeNow)
    );
    if (remainingMs <= 0) return null;
    return {
      summaryId: summary.id,
      expiresAt: paused ? safeNow + remainingMs : sourceExpiresAt,
      remainingMs,
      paused,
    };
  }

  if (current.paused) {
    if (current.remainingMs <= 0) return null;
    if (paused) return current;
    return {
      ...current,
      expiresAt: safeNow + current.remainingMs,
      paused: false,
    };
  }

  const remainingMs = Math.max(0, current.expiresAt - safeNow);
  if (remainingMs <= 0) return null;
  return {
    ...current,
    expiresAt: paused ? safeNow + remainingMs : current.expiresAt,
    remainingMs,
    paused,
  };
}

function isUsableRect(rect: DesktopPetWindowRect | null | undefined): rect is DesktopPetWindowRect {
  return Boolean(
    rect
      && Number.isFinite(rect.x)
      && Number.isFinite(rect.y)
      && Number.isFinite(rect.width)
      && Number.isFinite(rect.height)
      && rect.width > 0
      && rect.height > 0
  );
}

function insetWorkArea(
  workArea: DesktopPetWindowRect,
  margin: number
): DesktopPetWindowRect {
  const horizontalMargin = Math.min(margin, workArea.width / 2);
  const verticalMargin = Math.min(margin, workArea.height / 2);
  return {
    x: workArea.x + horizontalMargin,
    y: workArea.y + verticalMargin,
    width: Math.max(1, workArea.width - horizontalMargin * 2),
    height: Math.max(1, workArea.height - verticalMargin * 2),
  };
}

function placementTieOrder(
  placement: DesktopPetBubblePlacement,
  inwardPlacement: DesktopPetBubblePlacement
): number {
  if (placement === "above") return 0;
  if (placement === "below") return 1;
  if (placement === inwardPlacement) return 2;
  return 3;
}

function choosePlacement(candidates: PlacementCandidate[]): PlacementCandidate {
  const fullFits = candidates.filter((candidate) => candidate.fullFit);
  return [...(fullFits.length > 0 ? fullFits : candidates)].sort((left, right) => {
    const scoreDifference = fullFits.length > 0
      ? right.capacityScore - left.capacityScore
      : right.visibleScore - left.visibleScore;
    return scoreDifference || left.tieOrder - right.tieOrder;
  })[0];
}

function clampRounded(value: number, minimum: number, maximum: number): number {
  const roundedMinimum = Math.ceil(minimum);
  const roundedMaximum = Math.floor(maximum);
  if (roundedMaximum < roundedMinimum) return roundedMinimum;
  return clamp(Math.round(value), roundedMinimum, roundedMaximum);
}

/**
 * 以宠物物理像素 bounds 为单一锚点，在工作区内选择 Bubble 方向并裁剪可滚动视口。
 */
export function calculateDesktopPetBubbleGeometry(
  input: DesktopPetBubbleGeometryInput
): DesktopPetBubbleGeometry {
  const scaleFactor = positiveNumber(input.scaleFactor, 1);
  const naturalWidth = positiveNumber(input.naturalWidth, DESKTOP_PET_BUBBLE_DEFAULT_WIDTH);
  const naturalHeight = positiveNumber(input.naturalHeight, 1);
  const anchor: DesktopPetWindowRect = {
    x: finiteNumber(input.anchor.x),
    y: finiteNumber(input.anchor.y),
    width: positiveNumber(input.anchor.width, 1),
    height: positiveNumber(input.anchor.height, 1),
  };
  const gap = Math.max(0, finiteNumber(input.gap ?? DESKTOP_PET_BUBBLE_ANCHOR_GAP)) * scaleFactor;
  const requestedWidth = Math.max(
    DESKTOP_PET_BUBBLE_MIN_WIDTH,
    naturalWidth
  ) * scaleFactor;
  const requestedHeight = naturalHeight * scaleFactor;

  if (!isUsableRect(input.workArea)) {
    const width = Math.max(1, Math.round(requestedWidth));
    const height = Math.max(1, Math.round(requestedHeight));
    const x = Math.round(anchor.x + anchor.width / 2 - width / 2);
    const y = Math.round(anchor.y - gap - height);
    return {
      bounds: { x, y, width, height },
      logicalWidth: width / scaleFactor,
      logicalHeight: height / scaleFactor,
      placement: "above",
      arrowOffset: clamp(anchor.x + anchor.width / 2 - x, 0, width) / scaleFactor,
    };
  }

  const margin = Math.max(
    0,
    finiteNumber(input.margin ?? DESKTOP_PET_BUBBLE_WORK_AREA_MARGIN)
  ) * scaleFactor;
  const workArea = insetWorkArea(input.workArea, margin);
  const width = Math.min(requestedWidth, workArea.width);
  const height = Math.min(requestedHeight, workArea.height);
  const anchorRight = anchor.x + anchor.width;
  const anchorBottom = anchor.y + anchor.height;
  const workRight = workArea.x + workArea.width;
  const workBottom = workArea.y + workArea.height;
  const availableAbove = Math.max(0, anchor.y - gap - workArea.y);
  const availableBelow = Math.max(0, workBottom - anchorBottom - gap);
  const availableLeft = Math.max(0, anchor.x - gap - workArea.x);
  const availableRight = Math.max(0, workRight - anchorRight - gap);
  const anchorCenterX = anchor.x + anchor.width / 2;
  const inwardPlacement: DesktopPetBubblePlacement = anchorCenterX < workArea.x + workArea.width / 2
    ? "right"
    : "left";

  const candidates: PlacementCandidate[] = [
    {
      placement: "above",
      width,
      height: Math.min(height, availableAbove),
      fullFit: availableAbove >= requestedHeight,
      capacityScore: availableAbove * workArea.width,
      visibleScore: width * Math.min(height, availableAbove),
      tieOrder: placementTieOrder("above", inwardPlacement),
    },
    {
      placement: "below",
      width,
      height: Math.min(height, availableBelow),
      fullFit: availableBelow >= requestedHeight,
      capacityScore: availableBelow * workArea.width,
      visibleScore: width * Math.min(height, availableBelow),
      tieOrder: placementTieOrder("below", inwardPlacement),
    },
    {
      placement: "left",
      width: Math.min(width, availableLeft),
      height,
      fullFit: availableLeft >= requestedWidth && workArea.height >= requestedHeight,
      capacityScore: availableLeft * workArea.height,
      visibleScore: Math.min(width, availableLeft) * height,
      tieOrder: placementTieOrder("left", inwardPlacement),
    },
    {
      placement: "right",
      width: Math.min(width, availableRight),
      height,
      fullFit: availableRight >= requestedWidth && workArea.height >= requestedHeight,
      capacityScore: availableRight * workArea.height,
      visibleScore: Math.min(width, availableRight) * height,
      tieOrder: placementTieOrder("right", inwardPlacement),
    },
  ];
  const visibleCandidates = candidates.filter(
    (candidate) => candidate.width >= 1 && candidate.height >= 1
  );
  const selected = choosePlacement(visibleCandidates.length > 0 ? visibleCandidates : [{
    placement: "above",
    width: Math.max(1, Math.min(width, workArea.width)),
    height: Math.max(1, Math.min(height, workArea.height)),
    fullFit: false,
    capacityScore: 0,
    visibleScore: 0,
    tieOrder: 0,
  }]);
  const selectedWidth = Math.max(1, Math.round(selected.width));
  const selectedHeight = Math.max(1, Math.round(selected.height));
  let x: number;
  let y: number;

  if (selected.placement === "above" || selected.placement === "below") {
    x = clampRounded(
      anchor.x + anchor.width / 2 - selectedWidth / 2,
      workArea.x,
      workRight - selectedWidth
    );
    y = selected.placement === "above"
      ? clampRounded(anchor.y - gap - selectedHeight, workArea.y, workBottom - selectedHeight)
      : clampRounded(anchorBottom + gap, workArea.y, workBottom - selectedHeight);
  } else {
    x = selected.placement === "left"
      ? clampRounded(anchor.x - gap - selectedWidth, workArea.x, workRight - selectedWidth)
      : clampRounded(anchorRight + gap, workArea.x, workRight - selectedWidth);
    y = clampRounded(
      anchor.y + anchor.height / 2 - selectedHeight / 2,
      workArea.y,
      workBottom - selectedHeight
    );
  }

  const arrowOffsetPhysical = selected.placement === "above" || selected.placement === "below"
    ? clamp(anchor.x + anchor.width / 2 - x, 0, selectedWidth)
    : clamp(anchor.y + anchor.height / 2 - y, 0, selectedHeight);
  return {
    bounds: { x, y, width: selectedWidth, height: selectedHeight },
    logicalWidth: selectedWidth / scaleFactor,
    logicalHeight: selectedHeight / scaleFactor,
    placement: selected.placement,
    arrowOffset: arrowOffsetPhysical / scaleFactor,
  };
}

export function createDesktopPetLatestFrameTaskRunner<T>(
  task: (value: T) => void,
  scheduler: DesktopPetFrameScheduler,
  trailingDelayMs = 80
): DesktopPetLatestFrameTaskRunner<T> {
  let disposed = false;
  let hasLatest = false;
  let latestValue: T | undefined;
  let scheduledRevision = 0;
  let appliedRevision = 0;
  let frameHandle: number | null = null;
  let timerHandle: number | null = null;

  const applyLatest = () => {
    if (disposed || !hasLatest || appliedRevision === scheduledRevision) return;
    appliedRevision = scheduledRevision;
    task(latestValue as T);
  };
  const clearScheduled = () => {
    if (frameHandle !== null) {
      scheduler.cancelFrame(frameHandle);
      frameHandle = null;
    }
    if (timerHandle !== null) {
      scheduler.clearTimer(timerHandle);
      timerHandle = null;
    }
  };

  return {
    schedule(value) {
      if (disposed) return;
      latestValue = value;
      hasLatest = true;
      scheduledRevision += 1;
      if (frameHandle === null) {
        frameHandle = scheduler.requestFrame(() => {
          frameHandle = null;
          applyLatest();
        });
      }
      if (timerHandle !== null) scheduler.clearTimer(timerHandle);
      timerHandle = scheduler.setTimer(() => {
        timerHandle = null;
        if (frameHandle !== null) {
          scheduler.cancelFrame(frameHandle);
          frameHandle = null;
        }
        applyLatest();
      }, Math.max(0, trailingDelayMs));
    },
    flush() {
      if (disposed) return;
      clearScheduled();
      applyLatest();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearScheduled();
      hasLatest = false;
    },
  };
}

/**
 * 将 DOM 逻辑像素矩形裁剪到 viewport 后向外取整为窗口本地物理像素区域。
 */
export function normalizeDesktopPetHitRegions(
  rects: readonly DesktopPetLogicalRect[],
  viewportWidth: number,
  viewportHeight: number,
  scaleFactor: number,
  limit = DESKTOP_PET_MAX_HIT_REGIONS
): DesktopPetWindowRect[] {
  const safeScale = positiveNumber(scaleFactor, 1);
  const safeWidth = Math.max(0, finiteNumber(viewportWidth));
  const safeHeight = Math.max(0, finiteNumber(viewportHeight));
  const safeLimit = Math.max(0, Math.min(
    DESKTOP_PET_MAX_HIT_REGIONS,
    Math.trunc(finiteNumber(limit, DESKTOP_PET_MAX_HIT_REGIONS))
  ));
  const normalized: DesktopPetWindowRect[] = [];

  for (const rect of rects) {
    if (normalized.length >= safeLimit) break;
    if (
      !Number.isFinite(rect.x)
      || !Number.isFinite(rect.y)
      || !Number.isFinite(rect.width)
      || !Number.isFinite(rect.height)
      || rect.width <= 0
      || rect.height <= 0
    ) {
      continue;
    }
    const left = clamp(rect.x, 0, safeWidth);
    const top = clamp(rect.y, 0, safeHeight);
    const right = clamp(rect.x + rect.width, 0, safeWidth);
    const bottom = clamp(rect.y + rect.height, 0, safeHeight);
    if (right <= left || bottom <= top) continue;
    const physicalLeft = Math.floor(left * safeScale);
    const physicalTop = Math.floor(top * safeScale);
    const physicalRight = Math.ceil(right * safeScale);
    const physicalBottom = Math.ceil(bottom * safeScale);
    if (physicalRight <= physicalLeft || physicalBottom <= physicalTop) continue;
    normalized.push({
      x: physicalLeft,
      y: physicalTop,
      width: physicalRight - physicalLeft,
      height: physicalBottom - physicalTop,
    });
  }

  return normalized;
}
