import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { availableMonitors, currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import {
  AppWindow,
  ArrowLeft,
  Building2,
  EyeOff,
  LockKeyhole,
  Maximize2,
  MessageCircle,
  MessagesSquare,
  MonitorUp,
  PauseCircle,
  RadioTower,
  Send,
  Settings,
} from "lucide-react";
import { CliCat } from "../components/desktop-pet/CliCat";
import { PetArtwork } from "../components/desktop-pet/PetArtwork";
import {
  DESKTOP_PET_CONFIG_EVENT,
  DESKTOP_PET_BUBBLE_GEOMETRY_EVENT,
  DESKTOP_PET_BUBBLE_FOCUS_EVENT,
  DESKTOP_PET_BUBBLE_LAYOUT_REQUEST_EVENT,
  DESKTOP_PET_BUBBLE_MEASURE_EVENT,
  DESKTOP_PET_BUBBLE_WINDOW_LABEL,
  DESKTOP_PET_CLOSE_MENU_EVENT,
  DESKTOP_PET_COORDINATOR_READY_EVENT,
  DESKTOP_PET_HANDOFF_CANCEL_EVENT,
  DESKTOP_PET_HANDOFF_START_EVENT,
  DESKTOP_PET_HIDDEN_EVENT,
  DESKTOP_PET_OPEN_SETTINGS_EVENT,
  DESKTOP_PET_OPEN_TARGET_EVENT,
  DESKTOP_PET_POSITION_EVENT,
  DESKTOP_PET_READY_EVENT,
  DESKTOP_PET_SIZE_CHANGE_EVENT,
  DESKTOP_PET_SNAPSHOT_EVENT,
  DESKTOP_PET_SIZE_MAX_PERCENT,
  DESKTOP_PET_SIZE_MIN_PERCENT,
  DESKTOP_PET_SIZE_STEP_PERCENT,
  DESKTOP_PET_MENU_MAX_VISIBLE_PLATFORMS,
  DESKTOP_PET_MENU_MAX_VISIBLE_TARGETS,
  calculateDesktopPetMenuWindowGeometry,
  buildDesktopPetLabels,
  createLatestAsyncTaskRunner,
  desktopPetScale,
  normalizeDesktopPetSizePercent,
  resizeDesktopPetCollapsedWindowBounds,
  stepDesktopPetSizePercent,
  type DesktopPetConfigPayload,
  type DesktopPetConfigEventPayload,
  type DesktopPetBubbleGeometryPayload,
  type DesktopPetBubbleLayoutRequestPayload,
  type DesktopPetBubbleMeasurementPayload,
  type DesktopPetHitRegion,
  type DesktopPetMenuWindowGeometry,
  type DesktopPetMood,
  type DesktopPetWindowRect,
  type LatestAsyncTaskRunner,
  type DesktopPetSnapshot,
  type DesktopPetSnapshotEventPayload,
  type DesktopPetStatusColor,
  type DesktopPetTarget,
  type InstalledPet,
  localizedPetText,
} from "../lib/desktopPet";
import {
  calculateDesktopPetBubbleGeometry,
  createDesktopPetLatestFrameTaskRunner,
  normalizeDesktopPetHitRegions,
  type DesktopPetLatestFrameTaskRunner,
} from "../lib/desktopPetBubble";
import {
  normalizeDesktopPetStatusFilter,
  visibleDesktopPetStatusColors,
} from "../lib/desktopPetStatus";
import {
  createDesktopPetSurfaceEpoch,
  shouldAcceptDesktopPetBubbleMeasurement,
  shouldAcceptDesktopPetConfigDelivery,
  shouldAcceptDesktopPetSnapshotDelivery,
} from "../lib/desktopPetTransport";
import { convertChineseForLanguage, getCurrentLanguage } from "../lib/i18n";
import { logWarn } from "../lib/logger";
import type {
  CcConnectHandoffPlatformTarget,
  CcConnectPlatform,
} from "../lib/remoteHandoff";
import { BUILTIN_DESKTOP_PET_ID } from "../stores/settingsStore";
import "./desktopPet.css";

const DEFAULT_LANGUAGE = getCurrentLanguage();

const DEFAULT_CONFIG: DesktopPetConfigPayload = {
  language: DEFAULT_LANGUAGE,
  visible: false,
  bubbleVisible: false,
  lifecycleToken: "",
  settings: {
    enabled: true,
    petId: BUILTIN_DESKTOP_PET_ID,
    alwaysOnTop: true,
    agentSessionsOnly: true,
    size: 100,
    showActionMenu: true,
    openOnHover: true,
    workingBounceEnabled: false,
    workingBounceDistancePx: 5,
    showStatus: true,
    showSessionName: false,
    autoHideFullscreen: true,
    lockPosition: false,
    position: null,
  },
  labels: buildDesktopPetLabels(DEFAULT_LANGUAGE),
};

const DEFAULT_SNAPSHOT: DesktopPetSnapshot = {
  mood: "sleeping",
  sessionId: null,
  daemonOnly: false,
  sessionTitle: null,
  projectName: null,
  runningCount: 0,
  attentionCount: 0,
  statusCounts: { green: 0, red: 0, blue: 0 },
  updatedAt: Date.now(),
  targets: [],
  decisionRequests: [],
  incidents: [],
  handoff: null,
  handoffPlatforms: [],
  handoffBusy: false,
};

function moodLabel(labels: DesktopPetConfigPayload["labels"], mood: DesktopPetMood): string {
  return labels[mood];
}

function distinctDisplayLabels(...values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const value of values) {
    const label = value?.trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels;
}

function targetStatusLabel(
  labels: DesktopPetConfigPayload["labels"],
  target: DesktopPetTarget
): string {
  if (target.handoffPhase === "pending") return labels.handoffPending;
  if (target.handoffPhase === "cancelling") return labels.handoffCancelling;
  if (target.handoffPhase === "recovery_failed") {
    return labels.handoffRecoveryFailed;
  }
  if (target.handedOff) return labels.handedOff;
  const mood: DesktopPetMood =
    target.status === "running"
      ? "working"
      : target.status === "attention"
        ? "waiting"
        : target.status === "done"
          ? "success"
        : target.status === "failed"
            ? "error"
            : "idle";
  return moodLabel(labels, mood);
}

function handoffTargetStatusLabel(
  labels: DesktopPetConfigPayload["labels"],
  target: DesktopPetTarget
): string {
  if (target.handoffEligible) return labels.handoffReady;
  if (target.handoffRecoverable) return labels.handoffResolveRemoteSession;
  if (target.handoffReason === "task_running") return labels.handoffTaskRunning;
  if (target.handoffReason === "task_state_unknown") return labels.handoffStateUnknown;
  return labels.handoffUnavailable;
}

function platformLabel(
  labels: DesktopPetConfigPayload["labels"],
  platform: CcConnectPlatform
): string {
  return {
    telegram: labels.platformTelegram,
    feishu: labels.platformFeishu,
    weixin: labels.platformWeixin,
    wecom: labels.platformWecom,
  }[platform];
}

function platformStatusLabel(
  labels: DesktopPetConfigPayload["labels"],
  target: CcConnectHandoffPlatformTarget
): string {
  if (target.ready) return labels.platformReady;
  if (target.unavailableReason === "cc_connect_not_running") {
    return labels.platformNotRunning;
  }
  if (target.unavailableReason === "handoff_credentials_missing") {
    return labels.platformCredentialsMissing;
  }
  if (target.unavailableReason === "handoff_platform_user_missing") {
    return labels.platformUserMissing;
  }
  if (target.unavailableReason === "handoff_platform_session_missing") {
    return labels.platformSessionMissing;
  }
  return labels.platformUnavailable;
}

function PlatformIcon({ platform }: { platform: CcConnectPlatform }) {
  const Icon = {
    telegram: Send,
    feishu: MessagesSquare,
    weixin: MessageCircle,
    wecom: Building2,
  }[platform];
  return <Icon size={15} aria-hidden="true" />;
}

function desktopPetStatusColor(status: DesktopPetTarget["status"]): DesktopPetStatusColor | null {
  if (status === "running") return "green";
  if (status === "failed") return "red";
  if (status === "attention" || status === "done") return "blue";
  return null;
}

interface CollapsedPetWindowGeometry {
  bounds: DesktopPetWindowRect;
  scaleFactor: number;
  petScale: number;
  workArea: DesktopPetWindowRect | null;
}

interface DesktopPetMenuWindowRequest {
  open: boolean;
  petScale: number;
  secondaryItemCount: number;
  secondaryContentHeight: number;
  secondaryHeaderHeight: number;
  showActionMenu: boolean;
  maxVisibleItems: number;
}

interface DesktopPetBubbleGeometryRequest {
  measurement: DesktopPetBubbleMeasurementPayload;
  followRevision: number;
}

interface DesktopPetAnchorContext {
  anchor: DesktopPetWindowRect;
  workArea: DesktopPetWindowRect | null;
  scaleFactor: number;
}

function desktopPetEnvironmentSignature(context: DesktopPetAnchorContext): string {
  const workArea = context.workArea;
  return [
    context.scaleFactor,
    context.anchor.x,
    context.anchor.y,
    context.anchor.width,
    context.anchor.height,
    workArea?.x ?? "none",
    workArea?.y ?? "none",
    workArea?.width ?? "none",
    workArea?.height ?? "none",
  ].join(":");
}

const DESKTOP_PET_HOVER_OPEN_DELAY_MS = 200;
const DESKTOP_PET_HOVER_CLOSE_DELAY_MS = 350;
const DESKTOP_PET_SIZE_WHEEL_COMMIT_DELAY_MS = 250;
const DESKTOP_PET_SIZE_ADJUSTMENT_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

interface DesktopPetMonitorLike {
  workArea: {
    position: { x: number; y: number };
    size: { width: number; height: number };
  };
}

function monitorWorkArea(monitor: DesktopPetMonitorLike): DesktopPetWindowRect {
  return {
    x: monitor.workArea.position.x,
    y: monitor.workArea.position.y,
    width: monitor.workArea.size.width,
    height: monitor.workArea.size.height,
  };
}

function workAreaForAnchor(
  monitors: readonly DesktopPetMonitorLike[],
  anchor: DesktopPetWindowRect
): DesktopPetWindowRect | null {
  if (monitors.length === 0) return null;
  const centerX = anchor.x + anchor.width / 2;
  const centerY = anchor.y + anchor.height / 2;
  const containing = monitors.find((monitor) => {
    const workArea = monitorWorkArea(monitor);
    return centerX >= workArea.x
      && centerX < workArea.x + workArea.width
      && centerY >= workArea.y
      && centerY < workArea.y + workArea.height;
  });
  if (containing) return monitorWorkArea(containing);
  return monitorWorkArea([...monitors].sort((left, right) => {
    const leftArea = monitorWorkArea(left);
    const rightArea = monitorWorkArea(right);
    const leftCenterX = leftArea.x + leftArea.width / 2;
    const leftCenterY = leftArea.y + leftArea.height / 2;
    const rightCenterX = rightArea.x + rightArea.width / 2;
    const rightCenterY = rightArea.y + rightArea.height / 2;
    return Math.hypot(centerX - leftCenterX, centerY - leftCenterY)
      - Math.hypot(centerX - rightCenterX, centerY - rightCenterY);
  })[0]);
}

function estimatedWrappedLines(text: string | null | undefined, charsPerLine: number): number {
  if (!text) return 0;
  return text.split(/\r?\n/).reduce((lines, line) => {
    const visualLength = Array.from(line).reduce(
      (length, character) => length + ((character.codePointAt(0) ?? 0) > 0xff ? 2 : 1),
      0
    );
    return lines + Math.max(1, Math.ceil(visualLength / charsPerLine));
  }, 0);
}

function targetFanStyle(index: number, count: number, maxVisibleItems: number): CSSProperties {
  const visibleCount = Math.min(Math.max(count, 1), Math.max(1, maxVisibleItems));
  const slot = Math.min(index, visibleCount - 1);
  const center = (visibleCount - 1) / 2;
  const normalized = center <= 0 ? 0 : (slot - center) / center;
  return {
    "--fan-angle": `${normalized * 2.4}deg`,
    "--fan-shift": `${(1 - Math.abs(normalized)) * 18}px`,
    "--fan-delay": `${Math.min(index, 8) * 28}ms`,
    zIndex: count - index,
  } as CSSProperties;
}

export default function DesktopPetApp() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [snapshot, setSnapshot] = useState(DEFAULT_SNAPSHOT);
  const [displayMood, setDisplayMood] = useState<DesktopPetMood>(DEFAULT_SNAPSHOT.mood);
  const [installedPet, setInstalledPet] = useState<InstalledPet | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<DesktopPetStatusColor | null>(null);
  const [targetMode, setTargetMode] = useState<"open" | "platforms" | "handoff">("open");
  const [selectedPlatform, setSelectedPlatform] = useState<CcConnectPlatform | null>(null);
  const [menuGeometry, setMenuGeometry] = useState<DesktopPetMenuWindowGeometry | null>(null);
  const [menuLayoutRevision, setMenuLayoutRevision] = useState(0);
  const [previewSize, setPreviewSize] = useState<number | null>(null);
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const visibleStatusColors = visibleDesktopPetStatusColors(snapshot.statusCounts);
  const visibleStatusKey = visibleStatusColors.join(":");
  const filteredTargets = statusFilter
    ? snapshot.targets.filter((target) => desktopPetStatusColor(target.status) === statusFilter)
    : snapshot.targets;
  const menuTargets = targetMode === "handoff"
    ? snapshot.targets.filter((target) => target.handoffCandidate)
    : filteredTargets;
  const handoffPlatforms = useMemo(
    () => snapshot.handoffPlatforms.filter((platform) => platform.enabled),
    [snapshot.handoffPlatforms]
  );
  const secondaryItemCount = targetMode === "platforms"
    ? handoffPlatforms.length
    : menuTargets.length;
  const secondaryContentHeight = targetMode === "platforms"
    ? 0
    : menuTargets.reduce((height, target) => (
        height
        + 72
        + Math.max(0, estimatedWrappedLines(target.sessionTitle, 38) - 1) * 15
        + estimatedWrappedLines(target.message, 44) * 15
      ), 0);
  const secondaryHeaderHeight = targetMode === "open" ? 0 : 34;
  const maxVisibleSecondaryItems = targetMode === "platforms"
    ? DESKTOP_PET_MENU_MAX_VISIBLE_PLATFORMS
    : DESKTOP_PET_MENU_MAX_VISIBLE_TARGETS;
  const secondaryListScrollable = targetMode === "platforms"
    ? secondaryItemCount > maxVisibleSecondaryItems
    : false;
  const canOpenMenu = config.settings.showActionMenu
    || snapshot.targets.length > 0;
  const effectiveSize = previewSize ?? config.settings.size;
  const petScale = desktopPetScale(config.settings.size);
  const surfaceEpochRef = useRef(createDesktopPetSurfaceEpoch());
  const configRef = useRef(config);
  const petAnchorRef = useRef<HTMLDivElement | null>(null);
  const petStageRef = useRef<HTMLDivElement | null>(null);
  const statusRailRef = useRef<HTMLElement | null>(null);
  const petBoundsRequestRevisionRef = useRef(0);
  const petBoundsRevisionRef = useRef(0);
  const petRegionRevisionRef = useRef(0);
  const configDeliveryRevisionRef = useRef(0);
  const snapshotDeliveryRevisionRef = useRef(0);
  const bubbleLayoutRequestRevisionRef = useRef(0);
  const bubbleBoundsRevisionRef = useRef(0);
  const bubbleFollowRevisionRef = useRef(0);
  const bubbleMeasurementRef = useRef<DesktopPetBubbleMeasurementPayload | null>(null);
  const bubbleEnvironmentSignatureRef = useRef<string | null>(null);
  const bubbleGeometryTaskRef = useRef<LatestAsyncTaskRunner<DesktopPetBubbleGeometryRequest> | null>(null);
  const bubbleFollowFrameTaskRef = useRef<DesktopPetLatestFrameTaskRunner<number> | null>(null);
  const scheduleBubbleFollowRef = useRef<() => void>(() => {});
  const requestBubbleLayoutRef = useRef<() => void>(() => {});
  const synchronizeCurrentPetBoundsRef = useRef<() => void>(() => {});
  const petHitRegionFrameRef = useRef<number | null>(null);
  const reportPetHitRegionsRef = useRef<() => Promise<void>>(async () => {});
  const schedulePetHitRegionReportRef = useRef<() => void>(() => {});
  const moveTimerRef = useRef<number | null>(null);
  const dragResetTimerRef = useRef<number | null>(null);
  const userDraggingRef = useRef(false);
  const lockPositionRef = useRef(config.settings.lockPosition);
  const menuOpenRef = useRef(menuOpen);
  const previewSizeRef = useRef<number | null>(previewSize);
  const sizeAdjustingRef = useRef(false);
  const sizeWheelCommitTimerRef = useRef<number | null>(null);
  const sizeControlRef = useRef<HTMLDivElement | null>(null);
  const sizeWheelHandlerRef = useRef<(event: WheelEvent) => void>(() => {});
  const closeAfterSizeAdjustmentRef = useRef(false);
  const hoverOpenTimerRef = useRef<number | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const hoverSuppressedUntilLeaveRef = useRef(false);
  const expectedProgrammaticPositionRef = useRef<{ x: number; y: number } | null>(null);
  const pendingDragAfterMenuCloseRef = useRef(false);
  const closeMenuRef = useRef<(suppressHover?: boolean) => void>(() => {});
  const collapsedWindowGeometryRef = useRef<CollapsedPetWindowGeometry | null>(null);
  const menuWindowTaskRef = useRef<LatestAsyncTaskRunner<DesktopPetMenuWindowRequest> | null>(null);
  menuOpenRef.current = menuOpen;
  previewSizeRef.current = previewSize;
  lockPositionRef.current = config.settings.lockPosition;
  configRef.current = config;

  const requestBubbleLayout = () => {
    const current = configRef.current;
    if (!current.visible || !current.bubbleVisible || !current.lifecycleToken) return;
    const revision = bubbleLayoutRequestRevisionRef.current + 1;
    bubbleLayoutRequestRevisionRef.current = revision;
    const payload: DesktopPetBubbleLayoutRequestPayload = {
      lifecycleToken: current.lifecycleToken,
      petSurfaceEpoch: surfaceEpochRef.current,
      revision,
    };
    void emitTo(
      DESKTOP_PET_BUBBLE_WINDOW_LABEL,
      DESKTOP_PET_BUBBLE_LAYOUT_REQUEST_EVENT,
      payload
    ).catch((error) => {
      if (configRef.current.lifecycleToken === payload.lifecycleToken) {
        logWarn("Failed to request desktop pet Bubble layout", error);
      }
    });
  };
  requestBubbleLayoutRef.current = requestBubbleLayout;

  const readDesktopPetAnchorContext = async (): Promise<DesktopPetAnchorContext> => {
    const appWindow = getCurrentWindow();
    const [position, size, scaleFactor, monitors, fallbackMonitor] = await Promise.all([
      appWindow.outerPosition(),
      appWindow.outerSize(),
      appWindow.scaleFactor(),
      availableMonitors().catch(() => []),
      currentMonitor().catch(() => null),
    ]);
    const safeScale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
    const anchorElement = petAnchorRef.current;
    const stageElement = petStageRef.current;
    let anchor: DesktopPetWindowRect;
    if (anchorElement && stageElement) {
      const anchorRect = anchorElement.getBoundingClientRect();
      const statusRail = statusRailRef.current;
      const left = Math.min(stageElement.offsetLeft, statusRail?.offsetLeft ?? Number.POSITIVE_INFINITY);
      const top = Math.min(stageElement.offsetTop, statusRail?.offsetTop ?? Number.POSITIVE_INFINITY);
      const right = Math.max(
        stageElement.offsetLeft + stageElement.offsetWidth,
        statusRail ? statusRail.offsetLeft + statusRail.offsetWidth : Number.NEGATIVE_INFINITY
      );
      const bottom = Math.max(
        stageElement.offsetTop + stageElement.offsetHeight,
        statusRail ? statusRail.offsetTop + statusRail.offsetHeight : Number.NEGATIVE_INFINITY
      );
      anchor = {
        x: Math.round(position.x + (anchorRect.left + left) * safeScale),
        y: Math.round(position.y + (anchorRect.top + top) * safeScale),
        width: Math.max(1, Math.round((right - left) * safeScale)),
        height: Math.max(1, Math.round((bottom - top) * safeScale)),
      };
    } else {
      const stageSize = Math.max(1, Math.round(144 * desktopPetScale(configRef.current.settings.size) * safeScale));
      anchor = {
        x: Math.round(position.x + (size.width - stageSize) / 2),
        y: Math.round(position.y + size.height - stageSize - 8 * safeScale),
        width: stageSize,
        height: stageSize,
      };
    }
    const monitorCandidates: DesktopPetMonitorLike[] = monitors.length > 0
      ? monitors
      : fallbackMonitor
        ? [fallbackMonitor]
        : [];
    return {
      anchor,
      workArea: workAreaForAnchor(monitorCandidates, anchor),
      scaleFactor: safeScale,
    };
  };

  const initializeBubbleRunners = () => {
    if (!bubbleGeometryTaskRef.current) {
      bubbleGeometryTaskRef.current = createLatestAsyncTaskRunner<DesktopPetBubbleGeometryRequest>(
        async (request, context) => {
          const measurement = request.measurement;
          const current = configRef.current;
          const latestMeasurement = bubbleMeasurementRef.current;
          if (
            !current.visible
            || !current.bubbleVisible
            || current.lifecycleToken !== measurement.lifecycleToken
            || measurement.petSurfaceEpoch !== surfaceEpochRef.current
            || !latestMeasurement
            || latestMeasurement.bubbleSurfaceEpoch !== measurement.bubbleSurfaceEpoch
            || latestMeasurement.measurementRevision !== measurement.measurementRevision
          ) {
            return;
          }
          const anchorContext = await readDesktopPetAnchorContext();
          if (!context.isLatest()) return;
          const geometry = calculateDesktopPetBubbleGeometry({
            anchor: anchorContext.anchor,
            workArea: anchorContext.workArea,
            naturalWidth: measurement.naturalWidth,
            naturalHeight: measurement.naturalHeight,
            scaleFactor: anchorContext.scaleFactor,
          });
          const nativeRevision = bubbleBoundsRevisionRef.current + 1;
          bubbleBoundsRevisionRef.current = nativeRevision;
          await invoke("desktop_pet_bubble_window_set_bounds", {
            lifecycleToken: measurement.lifecycleToken,
            surfaceEpoch: surfaceEpochRef.current,
            revision: nativeRevision,
            bounds: geometry.bounds,
          });
          if (!context.isLatest()) return;
          const payload: DesktopPetBubbleGeometryPayload = {
            lifecycleToken: measurement.lifecycleToken,
            petSurfaceEpoch: measurement.petSurfaceEpoch,
            revision: measurement.revision,
            bubbleSurfaceEpoch: measurement.bubbleSurfaceEpoch,
            measurementRevision: measurement.measurementRevision,
            geometryRevision: nativeRevision,
            placement: geometry.placement,
            logicalWidth: geometry.logicalWidth,
            logicalHeight: geometry.logicalHeight,
            arrowOffset: geometry.arrowOffset,
          };
          await emitTo(
            DESKTOP_PET_BUBBLE_WINDOW_LABEL,
            DESKTOP_PET_BUBBLE_GEOMETRY_EVENT,
            payload
          );
          if (context.isLatest()) {
            bubbleEnvironmentSignatureRef.current = desktopPetEnvironmentSignature(anchorContext);
          }
        },
        (error) => {
          if (configRef.current.visible && configRef.current.bubbleVisible) {
            logWarn("Failed to place desktop pet Bubble window", error);
          }
        }
      );
    }

    if (!bubbleFollowFrameTaskRef.current) {
      bubbleFollowFrameTaskRef.current = createDesktopPetLatestFrameTaskRunner(
        (followRevision) => {
          const measurement = bubbleMeasurementRef.current;
          if (measurement) {
            bubbleGeometryTaskRef.current?.schedule({ measurement, followRevision });
          }
        },
        {
          requestFrame: (callback) => window.requestAnimationFrame(callback),
          cancelFrame: (handle) => window.cancelAnimationFrame(handle),
          setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
          clearTimer: (handle) => window.clearTimeout(handle),
        },
        80
      );
    }
  };
  initializeBubbleRunners();

  const scheduleBubbleFollow = () => {
    bubbleFollowRevisionRef.current += 1;
    bubbleFollowFrameTaskRef.current?.schedule(bubbleFollowRevisionRef.current);
  };
  scheduleBubbleFollowRef.current = scheduleBubbleFollow;

  const reportPetHitRegions = async () => {
    const current = configRef.current;
    const boundsRevision = petBoundsRevisionRef.current;
    if (!current.visible || !current.lifecycleToken || boundsRevision <= 0) return;
    const lifecycleToken = current.lifecycleToken;
    const scaleFactor = await getCurrentWindow().scaleFactor().catch(() => (
      Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1
    ));
    if (configRef.current.lifecycleToken !== lifecycleToken) return;
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>("[data-pet-hit-region]")
    );
    const regions: DesktopPetHitRegion[] = [];
    for (const element of elements) {
      const kind = element.dataset.petHitRegion === "stage" ? "stage" : "control";
      const elementRect = element.getBoundingClientRect();
      const stableStageRect = kind === "stage" && petAnchorRef.current && element === petStageRef.current
        ? (() => {
            const anchorRect = petAnchorRef.current!.getBoundingClientRect();
            const horizontalPadding = 12;
            const topPadding = Math.max(
              24,
              configRef.current.settings.workingBounceDistancePx + 8
            );
            return {
              x: anchorRect.left + element.offsetLeft - horizontalPadding,
              y: anchorRect.top + element.offsetTop - topPadding,
              width: element.offsetWidth + horizontalPadding * 2,
              height: element.offsetHeight + topPadding + 8,
            };
          })()
        : {
            x: elementRect.x - 3,
            y: elementRect.y - 3,
            width: elementRect.width + 6,
            height: elementRect.height + 6,
          };
      const normalized = normalizeDesktopPetHitRegions(
        [stableStageRect],
        window.innerWidth,
        window.innerHeight,
        scaleFactor,
        1
      )[0];
      if (!normalized) continue;
      regions.push({ kind, ...normalized });
      if (regions.length >= 64) break;
    }
    const regionRevision = petRegionRevisionRef.current + 1;
    petRegionRevisionRef.current = regionRevision;
    await invoke("desktop_pet_window_set_hit_regions", {
      lifecycleToken,
      surfaceEpoch: surfaceEpochRef.current,
      boundsRevision,
      regionRevision,
      regions,
    }).catch((error) => {
      if (
        configRef.current.lifecycleToken === lifecycleToken
        && petBoundsRevisionRef.current === boundsRevision
      ) {
        logWarn("Failed to update desktop pet hit regions", error);
      }
    });
  };
  reportPetHitRegionsRef.current = reportPetHitRegions;

  const schedulePetHitRegionReport = () => {
    if (petHitRegionFrameRef.current !== null) return;
    petHitRegionFrameRef.current = window.requestAnimationFrame(() => {
      petHitRegionFrameRef.current = null;
      void reportPetHitRegionsRef.current();
    });
  };
  schedulePetHitRegionReportRef.current = schedulePetHitRegionReport;

  const stopUserDragTracking = () => {
    userDraggingRef.current = false;
    if (dragResetTimerRef.current !== null) {
      window.clearTimeout(dragResetTimerRef.current);
      dragResetTimerRef.current = null;
    }
  };

  const startNativeDragging = () => {
    if (lockPositionRef.current) return;
    expectedProgrammaticPositionRef.current = null;
    if (moveTimerRef.current !== null) {
      window.clearTimeout(moveTimerRef.current);
      moveTimerRef.current = null;
    }
    stopUserDragTracking();
    userDraggingRef.current = true;
    dragResetTimerRef.current = window.setTimeout(() => {
      userDraggingRef.current = false;
      dragResetTimerRef.current = null;
    }, 5000);
    void getCurrentWindow().startDragging().catch(() => {
      stopUserDragTracking();
    });
  };

  const applyDesktopPetWindowBounds = async (bounds: DesktopPetWindowRect) => {
    const current = configRef.current;
    if (!current.visible || !current.lifecycleToken) {
      throw new Error("desktop_pet_lifecycle_unavailable");
    }
    const lifecycleToken = current.lifecycleToken;
    const revision = petBoundsRequestRevisionRef.current + 1;
    petBoundsRequestRevisionRef.current = revision;
    await invoke("desktop_pet_window_set_bounds", {
      lifecycleToken,
      surfaceEpoch: surfaceEpochRef.current,
      revision,
      bounds,
    });
    if (configRef.current.lifecycleToken !== lifecycleToken) return;
    petBoundsRevisionRef.current = revision;
    petRegionRevisionRef.current = 0;
    schedulePetHitRegionReportRef.current();
    scheduleBubbleFollowRef.current();
  };

  const setManagedDesktopPetWindowBounds = (bounds: DesktopPetWindowRect) => {
    // `SetWindowPos` 也会触发 `onMoved`；菜单几何绝不能按用户拖动结果持久化。
    stopUserDragTracking();
    expectedProgrammaticPositionRef.current = { x: bounds.x, y: bounds.y };
    return applyDesktopPetWindowBounds(bounds);
  };

  synchronizeCurrentPetBoundsRef.current = () => {
    const lifecycleToken = configRef.current.lifecycleToken;
    if (!configRef.current.visible || !lifecycleToken) return;
    void Promise.all([
      getCurrentWindow().outerPosition(),
      getCurrentWindow().outerSize(),
    ]).then(([position, size]) => {
      if (configRef.current.lifecycleToken !== lifecycleToken) return;
      return setManagedDesktopPetWindowBounds({
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
      });
    }).catch((error) => {
      if (configRef.current.lifecycleToken === lifecycleToken) {
        logWarn("Failed to establish desktop pet window bounds", error);
      }
    });
  };

  const initializeMenuRunner = () => {
    if (!menuWindowTaskRef.current) {
      menuWindowTaskRef.current = createLatestAsyncTaskRunner<DesktopPetMenuWindowRequest>(
        async (request, context) => {
          if (request.open) {
            let collapsed = collapsedWindowGeometryRef.current;
            try {
              if (!collapsed) {
                const appWindow = getCurrentWindow();
                const [position, size, scaleFactor, monitor] = await Promise.all([
                  appWindow.outerPosition(),
                  appWindow.outerSize(),
                  appWindow.scaleFactor(),
                  currentMonitor().catch(() => null),
                ]);
                collapsed = {
                  bounds: {
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                  },
                  scaleFactor,
                  petScale: request.petScale,
                  workArea: monitor
                    ? {
                        x: monitor.workArea.position.x,
                        y: monitor.workArea.position.y,
                        width: monitor.workArea.size.width,
                        height: monitor.workArea.size.height,
                      }
                    : null,
                };
                collapsedWindowGeometryRef.current = collapsed;
              }

              const geometry = calculateDesktopPetMenuWindowGeometry(
                collapsed.bounds,
                collapsed.scaleFactor,
                request.secondaryItemCount,
                collapsed.workArea,
                request.secondaryHeaderHeight,
                {
                  showActionMenu: request.showActionMenu,
                  maxVisibleItems: request.maxVisibleItems,
                  contentHeight: request.secondaryContentHeight,
                }
              );
              if (!context.isLatest()) return;

              setMenuGeometry(geometry);
              await setManagedDesktopPetWindowBounds({
                x: geometry.x,
                y: geometry.y,
                width: geometry.physicalWidth,
                height: geometry.physicalHeight,
              });
            } catch (error) {
              if (context.isLatest()) {
                if (collapsed) {
                  await setManagedDesktopPetWindowBounds(collapsed.bounds).catch(() => {});
                }
                collapsedWindowGeometryRef.current = null;
                setMenuGeometry(null);
                setMenuOpen(false);
                setTargetMode("open");
                setSelectedPlatform(null);
              }
              throw error;
            }
            return;
          }

          if (!context.isLatest()) return;
          const collapsed = collapsedWindowGeometryRef.current;
          if (!collapsed) {
            setMenuGeometry(null);
            return;
          }

          await setManagedDesktopPetWindowBounds(collapsed.bounds);
          if (!context.isLatest()) return;
          collapsedWindowGeometryRef.current = null;
          setMenuGeometry(null);
          if (pendingDragAfterMenuCloseRef.current) {
            pendingDragAfterMenuCloseRef.current = false;
            startNativeDragging();
          }
        },
        (error) => {
          logWarn("Failed to resize desktop pet menu window", error);
        }
      );
    }
  };
  initializeMenuRunner();

  useEffect(() => {
    initializeBubbleRunners();
    initializeMenuRunner();
    const rootElements = [document.documentElement, document.body, document.getElementById("root")];
    rootElements.forEach((element) => {
      if (element) element.style.background = "transparent";
    });
    document.documentElement.dataset.window = "desktop-pet";
    const handleVisibilityChange = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    let disposed = false;
    const announceReady = () => {
      if (disposed) return;
      void emit(DESKTOP_PET_READY_EVENT, {
        surfaceEpoch: surfaceEpochRef.current,
      });
    };
    const unlistenCoordinatorReady = listen(
      DESKTOP_PET_COORDINATOR_READY_EVENT,
      announceReady
    );
    const unlistenConfig = listen<DesktopPetConfigEventPayload>(
      DESKTOP_PET_CONFIG_EVENT,
      (event) => {
        if (disposed) return;
        if (!shouldAcceptDesktopPetConfigDelivery(
          surfaceEpochRef.current,
          configDeliveryRevisionRef.current,
          event.payload
        )) {
          return;
        }
        configDeliveryRevisionRef.current = event.payload.deliveryRevision;
        const nextConfig: DesktopPetConfigPayload = event.payload;
        const tokenChanged = configRef.current.lifecycleToken !== nextConfig.lifecycleToken;
        configRef.current = nextConfig;
        setConfig(nextConfig);
        if (tokenChanged) {
          bubbleMeasurementRef.current = null;
          bubbleEnvironmentSignatureRef.current = null;
          announceReady();
          window.requestAnimationFrame(() => {
            synchronizeCurrentPetBoundsRef.current();
            requestBubbleLayoutRef.current();
          });
        }
        if (!sizeAdjustingRef.current) {
          previewSizeRef.current = null;
          setPreviewSize(null);
        }
      }
    );
    const unlistenSnapshot = listen<DesktopPetSnapshotEventPayload>(
      DESKTOP_PET_SNAPSHOT_EVENT,
      (event) => {
        if (
          disposed
          || !shouldAcceptDesktopPetSnapshotDelivery(
            configRef.current.lifecycleToken,
            surfaceEpochRef.current,
            configDeliveryRevisionRef.current,
            snapshotDeliveryRevisionRef.current,
            event.payload
          )
        ) {
          return;
        }
        snapshotDeliveryRevisionRef.current = event.payload.deliveryRevision;
        const nextSnapshot: DesktopPetSnapshot = event.payload;
        setSnapshot({
          ...nextSnapshot,
          handoffPlatforms: nextSnapshot.handoffPlatforms ?? [],
        });
        window.requestAnimationFrame(() => requestBubbleLayoutRef.current());
      }
    );
    const unlistenMeasurement = listen<DesktopPetBubbleMeasurementPayload>(
      DESKTOP_PET_BUBBLE_MEASURE_EVENT,
      (event) => {
        if (disposed) return;
        const current = configRef.current;
        const measurement = event.payload;
        const previous = bubbleMeasurementRef.current;
        if (
          !current.visible
          || !current.bubbleVisible
          || !shouldAcceptDesktopPetBubbleMeasurement({
            expectedLifecycleToken: current.lifecycleToken,
            expectedPetSurfaceEpoch: surfaceEpochRef.current,
            expectedLayoutRevision: bubbleLayoutRequestRevisionRef.current,
            previous,
            candidate: measurement,
          })
        ) {
          return;
        }
        bubbleMeasurementRef.current = measurement;
        bubbleFollowRevisionRef.current += 1;
        bubbleGeometryTaskRef.current?.schedule({
          measurement,
          followRevision: bubbleFollowRevisionRef.current,
        });
      }
    );
    const unlistenCloseMenu = listen(DESKTOP_PET_CLOSE_MENU_EVENT, () => {
      if (!disposed) {
        closeMenuRef.current(true);
      }
    });
    const appWindow = getCurrentWindow();
    const handleWindowResize = () => {
      scheduleBubbleFollowRef.current();
      schedulePetHitRegionReportRef.current();
    };
    window.addEventListener("resize", handleWindowResize);
    const layoutObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(handleWindowResize);
    if (petAnchorRef.current) layoutObserver?.observe(petAnchorRef.current);
    if (petStageRef.current) layoutObserver?.observe(petStageRef.current);
    const unlistenMoved = appWindow.onMoved(({ payload }) => {
      scheduleBubbleFollowRef.current();
      const expected = expectedProgrammaticPositionRef.current;
      if (
        expected
        && Math.abs(payload.x - expected.x) <= 1
        && Math.abs(payload.y - expected.y) <= 1
      ) {
        expectedProgrammaticPositionRef.current = null;
        return;
      }
      if (!userDraggingRef.current) return;
      if (dragResetTimerRef.current !== null) {
        window.clearTimeout(dragResetTimerRef.current);
      }
      dragResetTimerRef.current = window.setTimeout(() => {
        userDraggingRef.current = false;
        dragResetTimerRef.current = null;
      }, 5_000);
      if (moveTimerRef.current !== null) window.clearTimeout(moveTimerRef.current);
      moveTimerRef.current = window.setTimeout(() => {
        userDraggingRef.current = false;
        moveTimerRef.current = null;
        if (dragResetTimerRef.current !== null) {
          window.clearTimeout(dragResetTimerRef.current);
          dragResetTimerRef.current = null;
        }
        const current = configRef.current;
        void emitTo("main", DESKTOP_PET_POSITION_EVENT, {
          x: payload.x,
          y: payload.y,
          lifecycleToken: current.lifecycleToken,
          petSurfaceEpoch: surfaceEpochRef.current,
        });
      }, 400);
    });
    void unlistenCoordinatorReady.then(() => {
      announceReady();
    });
    return () => {
      disposed = true;
      if (moveTimerRef.current !== null) window.clearTimeout(moveTimerRef.current);
      if (dragResetTimerRef.current !== null) window.clearTimeout(dragResetTimerRef.current);
      if (hoverOpenTimerRef.current !== null) window.clearTimeout(hoverOpenTimerRef.current);
      if (hoverCloseTimerRef.current !== null) window.clearTimeout(hoverCloseTimerRef.current);
      if (sizeWheelCommitTimerRef.current !== null) {
        window.clearTimeout(sizeWheelCommitTimerRef.current);
      }
      if (petHitRegionFrameRef.current !== null) {
        window.cancelAnimationFrame(petHitRegionFrameRef.current);
        petHitRegionFrameRef.current = null;
      }
      bubbleGeometryTaskRef.current?.dispose();
      bubbleGeometryTaskRef.current = null;
      bubbleFollowFrameTaskRef.current?.dispose();
      bubbleFollowFrameTaskRef.current = null;
      layoutObserver?.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      menuWindowTaskRef.current?.dispose();
      menuWindowTaskRef.current = null;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void unlistenCoordinatorReady.then((unlisten) => unlisten());
      void unlistenConfig.then((unlisten) => unlisten());
      void unlistenSnapshot.then((unlisten) => unlisten());
      void unlistenMeasurement.then((unlisten) => unlisten());
      void unlistenCloseMenu.then((unlisten) => unlisten());
      void unlistenMoved.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    menuWindowTaskRef.current?.schedule({
      open: menuOpen,
      petScale,
      secondaryItemCount,
      secondaryContentHeight,
      secondaryHeaderHeight,
      showActionMenu: config.settings.showActionMenu,
      maxVisibleItems: maxVisibleSecondaryItems,
    });
  }, [
    config.settings.showActionMenu,
    maxVisibleSecondaryItems,
    menuLayoutRevision,
    menuOpen,
    petScale,
    secondaryContentHeight,
    secondaryHeaderHeight,
    secondaryItemCount,
  ]);

  useEffect(() => {
    setStatusFilter((current) => normalizeDesktopPetStatusFilter(
      current,
      snapshot.statusCounts
    ));
  }, [snapshot.statusCounts]);

  useLayoutEffect(() => {
    schedulePetHitRegionReportRef.current();
    scheduleBubbleFollowRef.current();
  }, [
    config.settings.showStatus,
    menuGeometry,
    petScale,
    visibleStatusKey,
  ]);

  useEffect(() => {
    if (!config.visible || !config.bubbleVisible || !config.lifecycleToken) return;
    const lifecycleToken = config.lifecycleToken;
    let disposed = false;
    let reading = false;
    const inspectEnvironment = () => {
      if (disposed || reading) return;
      const measurement = bubbleMeasurementRef.current;
      if (!measurement || measurement.lifecycleToken !== lifecycleToken) {
        requestBubbleLayoutRef.current();
        return;
      }
      reading = true;
      void readDesktopPetAnchorContext().then((context) => {
        if (
          disposed
          || configRef.current.lifecycleToken !== lifecycleToken
          || bubbleEnvironmentSignatureRef.current === desktopPetEnvironmentSignature(context)
        ) {
          return;
        }
        scheduleBubbleFollowRef.current();
      }).catch(() => {}).finally(() => {
        reading = false;
      });
    };
    requestBubbleLayoutRef.current();
    scheduleBubbleFollowRef.current();
    const timer = window.setInterval(inspectEnvironment, 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [config.bubbleVisible, config.lifecycleToken, config.visible]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenuRef.current(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!config.settings.enabled) {
      closeMenuRef.current(true);
    }
  }, [config.settings.enabled]);

  useEffect(() => {
    if (config.settings.openOnHover || hoverOpenTimerRef.current === null) return;
    window.clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = null;
  }, [config.settings.openOnHover]);

  useEffect(() => {
    if (config.settings.showActionMenu) return;
    if (targetMode !== "open") {
      setTargetMode("open");
      setSelectedPlatform(null);
    }
    if (snapshot.targets.length === 0) {
      if (hoverOpenTimerRef.current !== null) {
        window.clearTimeout(hoverOpenTimerRef.current);
        hoverOpenTimerRef.current = null;
      }
      if (menuOpen) closeMenuRef.current(true);
    }
  }, [config.settings.showActionMenu, menuOpen, snapshot.targets.length, targetMode]);

  useEffect(() => {
    if (targetMode === "platforms" && handoffPlatforms.length === 0) {
      setTargetMode("open");
      setSelectedPlatform(null);
      return;
    }
    if (
      targetMode === "handoff"
      && (
        !selectedPlatform
        || !snapshot.targets.some((target) => target.handoffCandidate)
        || !handoffPlatforms.some(
          (platform) => platform.platform === selectedPlatform && platform.ready
        )
      )
    ) {
      setTargetMode(handoffPlatforms.length > 0 ? "platforms" : "open");
      setSelectedPlatform(null);
    }
  }, [handoffPlatforms, selectedPlatform, snapshot.targets, targetMode]);

  useEffect(() => {
    if (snapshot.mood !== "success") {
      setDisplayMood(snapshot.mood);
      return;
    }
    const remaining = 3500 - Math.max(0, Date.now() - snapshot.updatedAt);
    if (remaining <= 0) {
      setDisplayMood("idle");
      return;
    }
    setDisplayMood("success");
    const timer = window.setTimeout(() => setDisplayMood("idle"), remaining);
    return () => window.clearTimeout(timer);
  }, [snapshot.mood, snapshot.updatedAt]);

  useEffect(() => {
    if (config.settings.petId === BUILTIN_DESKTOP_PET_ID) {
      setInstalledPet(null);
      return;
    }
    let cancelled = false;
    void invoke<InstalledPet | null>("desktop_pet_get_installed", { petId: config.settings.petId })
      .then((pet) => {
        if (!cancelled) setInstalledPet(pet);
      })
      .catch(() => {
        if (!cancelled) setInstalledPet(null);
      });
    return () => {
      cancelled = true;
    };
  }, [config.settings.petId]);

  const labels = useMemo(() => buildDesktopPetLabels(config.language), [config.language]);
  const localizeDisplayText = (text: string | null | undefined): string =>
    text ? convertChineseForLanguage(config.language, text) : "";
  const stageSize = Math.round(144 * petScale);
  const renderingActive = config.visible && documentVisible;
  const rootStyle = {
    "--pet-scale": petScale,
    "--pet-stage-size": `${stageSize}px`,
    "--pet-cat-width": `${Math.round(132 * petScale)}px`,
    "--pet-cat-height": `${Math.round(96 * petScale)}px`,
    "--pet-work-bounce-offset": `${-config.settings.workingBounceDistancePx}px`,
    ...(menuGeometry
      ? {
          "--pet-anchor-x": `${menuGeometry.anchorX}px`,
          "--pet-anchor-y": `${menuGeometry.anchorY}px`,
          "--pet-anchor-width": `${menuGeometry.anchorWidth}px`,
          "--pet-anchor-height": `${menuGeometry.anchorHeight}px`,
          "--pet-menu-panel-width": `${menuGeometry.panelWidth}px`,
          "--pet-target-list-height": `${menuGeometry.targetListHeight}px`,
        }
      : {}),
  } as CSSProperties;

  const clearHoverOpenTimer = () => {
    if (hoverOpenTimerRef.current === null) return;
    window.clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = null;
  };

  const clearHoverCloseTimer = () => {
    if (hoverCloseTimerRef.current === null) return;
    window.clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = null;
  };

  const clearSizeWheelCommitTimer = () => {
    if (sizeWheelCommitTimerRef.current === null) return;
    window.clearTimeout(sizeWheelCommitTimerRef.current);
    sizeWheelCommitTimerRef.current = null;
  };

  const beginSizeAdjustment = () => {
    sizeAdjustingRef.current = true;
    closeAfterSizeAdjustmentRef.current = false;
    clearHoverCloseTimer();
  };

  const commitSizePreview = () => {
    clearSizeWheelCommitTimer();
    const size = previewSizeRef.current;
    const shouldCloseAfterAdjustment = closeAfterSizeAdjustmentRef.current;
    sizeAdjustingRef.current = false;
    closeAfterSizeAdjustmentRef.current = false;
    if (size !== null) {
      let collapsed = collapsedWindowGeometryRef.current;
      const nextScale = desktopPetScale(size);
      if (collapsed && collapsed.petScale !== nextScale) {
        collapsed = {
          ...collapsed,
          bounds: resizeDesktopPetCollapsedWindowBounds(
            collapsed.bounds,
            collapsed.scaleFactor,
            nextScale,
            collapsed.workArea
          ),
          petScale: nextScale,
        };
        collapsedWindowGeometryRef.current = collapsed;
      }
      previewSizeRef.current = null;
      setPreviewSize(null);
      setConfig((current) => ({
        ...current,
        settings: { ...current.settings, size },
      }));
      if (collapsed) {
        void emitTo("main", DESKTOP_PET_SIZE_CHANGE_EVENT, {
          size,
          x: collapsed.bounds.x,
          y: collapsed.bounds.y,
          lifecycleToken: configRef.current.lifecycleToken,
          petSurfaceEpoch: surfaceEpochRef.current,
        }).catch((err) => logWarn("Failed to persist desktop pet size", err));
      }
    }
    if (shouldCloseAfterAdjustment && menuOpenRef.current) {
      clearHoverCloseTimer();
      hoverCloseTimerRef.current = window.setTimeout(() => {
        hoverCloseTimerRef.current = null;
        closeMenuRef.current(false);
      }, DESKTOP_PET_HOVER_CLOSE_DELAY_MS);
    }
  };

  const closeMenu = (suppressHover = true) => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    closeAfterSizeAdjustmentRef.current = false;
    commitSizePreview();
    if (suppressHover) hoverSuppressedUntilLeaveRef.current = true;
    setMenuOpen(false);
    setStatusFilter(null);
    setTargetMode("open");
    setSelectedPlatform(null);
  };
  closeMenuRef.current = closeMenu;

  const scheduleHoverOpen = () => {
    clearHoverCloseTimer();
    if (
      !config.settings.openOnHover
      || !canOpenMenu
      || hoverSuppressedUntilLeaveRef.current
      || menuOpenRef.current
      || userDraggingRef.current
      || sizeAdjustingRef.current
    ) {
      return;
    }
    clearHoverOpenTimer();
    hoverOpenTimerRef.current = window.setTimeout(() => {
      hoverOpenTimerRef.current = null;
      if (
        !config.settings.openOnHover
        || !canOpenMenu
        || hoverSuppressedUntilLeaveRef.current
        || menuOpenRef.current
        || userDraggingRef.current
        || sizeAdjustingRef.current
      ) {
        return;
      }
      setStatusFilter(null);
      setTargetMode("open");
      setSelectedPlatform(null);
      setMenuOpen(true);
    }, DESKTOP_PET_HOVER_OPEN_DELAY_MS);
  };

  const scheduleHoverClose = () => {
    hoverSuppressedUntilLeaveRef.current = false;
    clearHoverOpenTimer();
    if (sizeAdjustingRef.current) {
      closeAfterSizeAdjustmentRef.current = true;
      return;
    }
    if (!menuOpenRef.current) return;
    clearHoverCloseTimer();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null;
      closeMenuRef.current(false);
    }, DESKTOP_PET_HOVER_CLOSE_DELAY_MS);
  };

  const handleSizePreview = (value: number): boolean => {
    const currentSize = previewSizeRef.current ?? config.settings.size;
    const size = normalizeDesktopPetSizePercent(value, currentSize);
    if (size === currentSize) return false;
    previewSizeRef.current = size;
    setPreviewSize(size);
    return true;
  };

  const scheduleSizeWheelCommit = () => {
    clearSizeWheelCommitTimer();
    sizeWheelCommitTimerRef.current = window.setTimeout(() => {
      sizeWheelCommitTimerRef.current = null;
      commitSizePreview();
    }, DESKTOP_PET_SIZE_WHEEL_COMMIT_DELAY_MS);
  };

  const handleSizeWheel = (event: WheelEvent) => {
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const currentSize = previewSizeRef.current ?? config.settings.size;
    const size = stepDesktopPetSizePercent(currentSize, event.deltaY < 0 ? 1 : -1);
    if (size === currentSize && previewSizeRef.current === null) return;
    beginSizeAdjustment();
    handleSizePreview(size);
    scheduleSizeWheelCommit();
  };
  sizeWheelHandlerRef.current = handleSizeWheel;

  useEffect(() => {
    const sizeControl = sizeControlRef.current;
    if (!sizeControl || !menuGeometry) return;
    const handleWheel = (event: WheelEvent) => sizeWheelHandlerRef.current(event);
    sizeControl.addEventListener("wheel", handleWheel, { passive: false });
    return () => sizeControl.removeEventListener("wheel", handleWheel);
  }, [menuGeometry]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || config.settings.lockPosition) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, [data-pet-interactive]")) return;
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    if (menuOpen) {
      pendingDragAfterMenuCloseRef.current = true;
      closeMenu(true);
      return;
    }
    startNativeDragging();
  };

  const openTarget = (target?: DesktopPetTarget) => {
    closeMenu();
    void emitTo("main", DESKTOP_PET_OPEN_TARGET_EVENT, {
      sessionId: target?.sessionId ?? snapshot.sessionId,
      daemonOnly: target?.daemonOnly ?? snapshot.daemonOnly,
      lifecycleToken: configRef.current.lifecycleToken,
      surfaceEpoch: surfaceEpochRef.current,
    }).catch((err) => logWarn("Failed to request desktop pet target activation", err));
  };

  const openStatusGroup = (color: DesktopPetStatusColor) => {
    if (color !== "green" && config.lifecycleToken) {
      void emitTo(DESKTOP_PET_BUBBLE_WINDOW_LABEL, DESKTOP_PET_BUBBLE_FOCUS_EVENT, {
        lifecycleToken: config.lifecycleToken,
        color,
      }).catch((error) => {
        logWarn("Failed to focus desktop pet Bubble status group", error);
      });
    }
    if (!snapshot.targets.some((target) => desktopPetStatusColor(target.status) === color)) {
      return;
    }
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    hoverSuppressedUntilLeaveRef.current = false;
    setStatusFilter(color);
    setTargetMode("open");
    setSelectedPlatform(null);
    setMenuOpen(true);
  };

  const requestHandoff = (target: DesktopPetTarget) => {
    if (!selectedPlatform || (!target.handoffEligible && !target.handoffRecoverable)) return;
    closeMenu();
    void emitTo("main", DESKTOP_PET_HANDOFF_START_EVENT, {
      sessionId: target.sessionId,
      platform: selectedPlatform,
    }).catch((err) => logWarn("Failed to request remote handoff", err));
  };

  const selectHandoffPlatform = (target: CcConnectHandoffPlatformTarget) => {
    if (!target.ready) return;
    setSelectedPlatform(target.platform);
    setTargetMode("handoff");
  };

  const cancelHandoff = () => {
    closeMenu();
    void emitTo("main", DESKTOP_PET_HANDOFF_CANCEL_EVENT).catch((err) => {
      logWarn("Failed to request remote handoff cancellation", err);
    });
  };

  const openMainWindow = () => {
    closeMenu();
    void invoke("app_show_main_window").catch((err) => {
      logWarn("Failed to open CLI-Manager from desktop pet", err);
    });
  };

  return (
    <main
      className="desktop-pet-root"
      data-mood={displayMood}
      data-work-bounce={
        config.settings.workingBounceEnabled && config.settings.workingBounceDistancePx > 0
          ? "true"
          : undefined
      }
      data-menu-open={menuGeometry ? "true" : undefined}
      data-menu-horizontal={menuGeometry?.horizontalPlacement}
      data-menu-vertical={menuGeometry?.verticalPlacement}
      data-show-action-menu={config.settings.showActionMenu ? "true" : "false"}
      data-rendering-active={renderingActive ? "true" : "false"}
      style={rootStyle}
      onPointerEnter={clearHoverCloseTimer}
      onPointerLeave={scheduleHoverClose}
      onPointerDown={handlePointerDown}
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("button, input, [data-pet-interactive]")) return;
        clearHoverOpenTimer();
        openTarget();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        clearHoverOpenTimer();
        clearHoverCloseTimer();
        if (menuOpen) {
          closeMenu(true);
        } else if (canOpenMenu) {
          hoverSuppressedUntilLeaveRef.current = false;
          setStatusFilter(null);
          setTargetMode("open");
          setSelectedPlatform(null);
          setMenuOpen(true);
        }
      }}
      aria-label={moodLabel(labels, displayMood)}
    >
      <div ref={petAnchorRef} className="desktop-pet-anchor">
        {config.settings.showStatus && visibleStatusColors.length > 0 ? (
          <nav
            ref={statusRailRef}
            className="desktop-pet-status-rail"
            aria-label={labels.taskList}
          >
            {visibleStatusColors.map((color) => {
              const count = snapshot.statusCounts[color];
              const label = color === "green"
                ? labels.working
                : color === "red"
                  ? labels.error
                  : labels.waiting;
              return (
                <button
                  key={color}
                  type="button"
                  data-color={color}
                  data-pet-hit-region="control"
                  aria-label={`${label}: ${count}`}
                  title={`${label}: ${count}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openStatusGroup(color);
                  }}
                >
                  <span aria-hidden="true">{count}</span>
                </button>
              );
            })}
          </nav>
        ) : null}

        <div
          ref={petStageRef}
          className="desktop-pet-stage"
          data-pet-hit-region="stage"
          title={moodLabel(labels, displayMood)}
          onPointerEnter={scheduleHoverOpen}
          onPointerLeave={() => {
            if (!menuOpenRef.current) clearHoverOpenTimer();
          }}
        >
          {installedPet ? (
            <PetArtwork
              pet={installedPet}
              mood={displayMood}
              width={stageSize}
              height={stageSize}
              alt={localizedPetText(installedPet.manifest.name, config.language)}
              animated={renderingActive}
              onError={() => setInstalledPet(null)}
            />
          ) : (
            <CliCat className="desktop-pet-cat" ariaLabel={moodLabel(labels, displayMood)} />
          )}
        </div>
      </div>

      {menuOpen && menuGeometry ? (
        <div
          className="desktop-pet-menu"
          data-has-targets={secondaryItemCount > 0 || undefined}
          role="menu"
          aria-label={
            targetMode === "platforms"
              ? labels.handoffPlatforms
              : targetMode === "handoff"
                ? labels.handoffSessions
                : labels.taskList
          }
        >
          {targetMode === "platforms" && handoffPlatforms.length > 0 ? (
            <div
              className="desktop-pet-target-list desktop-pet-platform-list"
              data-pet-hit-region="control"
              data-scrollable={secondaryListScrollable || undefined}
            >
              <div className="desktop-pet-secondary-header">
                <button
                  type="button"
                  role="menuitem"
                  aria-label={labels.handoffBack}
                  title={labels.handoffBack}
                  onClick={() => {
                    setTargetMode("open");
                    setSelectedPlatform(null);
                  }}
                >
                  <ArrowLeft size={14} aria-hidden="true" />
                </button>
                <strong>{labels.handoffPlatforms}</strong>
              </div>
              {handoffPlatforms.map((platform, index) => {
                const name = platformLabel(labels, platform.platform);
                const status = platformStatusLabel(labels, platform);
                return (
                  <button
                    key={platform.platform}
                    type="button"
                    role="menuitem"
                    className="desktop-pet-platform"
                    data-ready={platform.ready || undefined}
                    disabled={!platform.ready}
                    style={targetFanStyle(
                      index,
                      handoffPlatforms.length,
                      DESKTOP_PET_MENU_MAX_VISIBLE_PLATFORMS
                    )}
                    onClick={() => selectHandoffPlatform(platform)}
                    title={[name, status].join(" · ")}
                  >
                    <PlatformIcon platform={platform.platform} />
                    <span className="desktop-pet-target-copy">
                      <strong>{name}</strong>
                      <small>{status}</small>
                    </span>
                    <span className="desktop-pet-platform-state" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          ) : secondaryItemCount > 0 ? (
            <div
              className="desktop-pet-target-list"
              data-pet-hit-region="control"
              data-scrollable={secondaryListScrollable || undefined}
            >
            {targetMode === "handoff" ? (
              <div className="desktop-pet-secondary-header">
                <button
                  type="button"
                  role="menuitem"
                  aria-label={labels.handoffBack}
                  title={labels.handoffBack}
                  onClick={() => {
                    setTargetMode("platforms");
                    setSelectedPlatform(null);
                  }}
                >
                  <ArrowLeft size={14} aria-hidden="true" />
                </button>
                <strong>
                  {selectedPlatform
                    ? platformLabel(labels, selectedPlatform)
                    : labels.handoffSessions}
                </strong>
              </div>
            ) : null}
            {menuTargets.map((target, index) => {
              const identityLabels = distinctDisplayLabels(
                localizeDisplayText(target.projectName),
                localizeDisplayText(target.sessionTitle)
              );
              const primary = identityLabels[0] || `${labels.unnamedTask} ${index + 1}`;
              const secondary = identityLabels[1] ?? null;
              const status = targetMode === "handoff"
                ? handoffTargetStatusLabel(labels, target)
                : targetStatusLabel(labels, target);
              const handoffDisabled = targetMode === "handoff"
                && !target.handoffEligible
                && !target.handoffRecoverable;
              return (
                <button
                  key={target.sessionId}
                  type="button"
                  role="menuitem"
                  className="desktop-pet-target"
                  data-status={target.status}
                  data-active={target.active || undefined}
                  data-handed-off={target.handedOff || undefined}
                  data-recovery-failed={
                    target.handoffPhase === "recovery_failed" || undefined
                  }
                  data-handoff-disabled={handoffDisabled || undefined}
                  disabled={handoffDisabled}
                  aria-current={target.active ? "true" : undefined}
                  style={targetFanStyle(
                    index,
                    menuTargets.length,
                    DESKTOP_PET_MENU_MAX_VISIBLE_TARGETS
                  )}
                  onClick={() => (
                    targetMode === "handoff" ? requestHandoff(target) : openTarget(target)
                  )}
                  title={[...identityLabels, status].join(" · ")}
                >
                  {target.handoffPhase ? (
                    <LockKeyhole className="desktop-pet-target-lock" size={14} aria-hidden="true" />
                  ) : (
                    <span className="desktop-pet-target-indicator" aria-hidden="true" />
                  )}
                  <span className="desktop-pet-target-copy">
                    <strong>{primary}</strong>
                    <small>
                      {secondary ? `${secondary} · ` : ""}
                      {status}
                    </small>
                    {target.message ? (
                      <p className="desktop-pet-card-message">{target.message}</p>
                    ) : null}
                  </span>
                  {target.active ? (
                    <span className="desktop-pet-target-current">{labels.currentTask}</span>
                  ) : null}
                </button>
              );
            })}
            </div>
          ) : null}
          {config.settings.showActionMenu ? (
          <div
            className="desktop-pet-menu-actions"
            data-pet-hit-region="control"
          >
            <button
              type="button"
              role="menuitem"
              disabled={!snapshot.sessionId}
              onClick={() => openTarget()}
            >
              <MonitorUp size={14} aria-hidden="true" />
              <span>{labels.openCurrent}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-active={targetMode !== "open" || undefined}
              disabled={
                snapshot.handoffBusy
                || Boolean(snapshot.handoff)
                || !snapshot.targets.some((target) => target.handoffCandidate)
                || handoffPlatforms.length === 0
              }
              onClick={() => {
                if (targetMode === "open") {
                  setSelectedPlatform(null);
                  setTargetMode("platforms");
                } else if (targetMode === "platforms") {
                  setSelectedPlatform(null);
                  setTargetMode("open");
                } else {
                  setSelectedPlatform(null);
                  setTargetMode("platforms");
                }
              }}
            >
              <RadioTower size={14} aria-hidden="true" />
              <span>{labels.remoteHandoff}</span>
            </button>
            {snapshot.handoff ? (
              <button
                type="button"
                role="menuitem"
                className="desktop-pet-menu-danger"
                disabled={snapshot.handoffBusy}
                onClick={cancelHandoff}
              >
                <PauseCircle size={14} aria-hidden="true" />
                <span>{labels.cancelHandoff}</span>
              </button>
            ) : null}
            <button type="button" role="menuitem" onClick={openMainWindow}>
              <AppWindow size={14} aria-hidden="true" />
              <span>{labels.openMain}</span>
            </button>
            <div
              ref={sizeControlRef}
              className="desktop-pet-size-control"
              role="group"
              aria-label={labels.size}
              data-pet-interactive
              onPointerEnter={clearHoverCloseTimer}
            >
              <div className="desktop-pet-size-control-header">
                <Maximize2 size={13} aria-hidden="true" />
                <span>{labels.size}</span>
                <output>{effectiveSize}%</output>
              </div>
              <input
                type="range"
                min={DESKTOP_PET_SIZE_MIN_PERCENT}
                max={DESKTOP_PET_SIZE_MAX_PERCENT}
                step={DESKTOP_PET_SIZE_STEP_PERCENT}
                value={effectiveSize}
                aria-label={labels.size}
                aria-valuetext={`${effectiveSize}%`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  clearSizeWheelCommitTimer();
                  beginSizeAdjustment();
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerUp={(event) => {
                  event.stopPropagation();
                  commitSizePreview();
                }}
                onPointerCancel={commitSizePreview}
                onLostPointerCapture={commitSizePreview}
                onChange={(event) => handleSizePreview(Number(event.currentTarget.value))}
                onKeyDown={(event) => {
                  if (DESKTOP_PET_SIZE_ADJUSTMENT_KEYS.has(event.key)) {
                    clearSizeWheelCommitTimer();
                    beginSizeAdjustment();
                  }
                }}
                onKeyUp={commitSizePreview}
                onBlur={commitSizePreview}
              />
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu();
                void emitTo("main", DESKTOP_PET_OPEN_SETTINGS_EVENT, {
                  lifecycleToken: configRef.current.lifecycleToken,
                  surfaceEpoch: surfaceEpochRef.current,
                }).catch((err) => {
                  logWarn("Failed to request desktop pet settings", err);
                });
              }}
            >
              <Settings size={14} aria-hidden="true" />
              <span>{labels.openSettings}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={snapshot.decisionRequests.length > 0 || snapshot.incidents.length > 0}
              onClick={() => {
                closeMenu();
                const lifecycleToken = configRef.current.lifecycleToken;
                const petSurfaceEpoch = surfaceEpochRef.current;
                const hideLocally = () => {
                  setConfig((current) => ({
                    ...current,
                    visible: false,
                    bubbleVisible: false,
                  }));
                };
                void invoke("desktop_pet_window_hide", {
                  lifecycleToken,
                  surfaceEpoch: petSurfaceEpoch,
                }).then(() => {
                  hideLocally();
                }).catch((err) => {
                  if (String(err).includes("pet_window_hidden_event_failed")) {
                    hideLocally();
                    void emitTo("main", DESKTOP_PET_HIDDEN_EVENT, {
                      lifecycleToken,
                      petSurfaceEpoch,
                    }).catch(() => {});
                    return;
                  }
                  logWarn("Failed to hide desktop pet window", err);
                });
              }}
            >
              <EyeOff size={14} aria-hidden="true" />
              <span>{labels.hide}</span>
            </button>
          </div>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
