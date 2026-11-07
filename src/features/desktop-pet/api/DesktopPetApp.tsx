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
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import {
  AppWindow,
  EyeOff,
  Maximize2,
  MonitorUp,
  Settings,
} from "lucide-react";
import { CliCat } from "./CliCat";
import { PetArtwork } from "./PetArtwork";
import {
  DESKTOP_PET_CONFIG_EVENT,
  DESKTOP_PET_CLOSE_MENU_EVENT,
  DESKTOP_PET_OPEN_SETTINGS_EVENT,
  DESKTOP_PET_OPEN_TARGET_EVENT,
  DESKTOP_PET_POSITION_EVENT,
  DESKTOP_PET_READY_EVENT,
  DESKTOP_PET_SIZE_CHANGE_EVENT,
  DESKTOP_PET_SNAPSHOT_EVENT,
  DESKTOP_PET_SIZE_MAX_PERCENT,
  DESKTOP_PET_SIZE_MIN_PERCENT,
  DESKTOP_PET_SIZE_STEP_PERCENT,
  DESKTOP_PET_MENU_MAX_VISIBLE_TARGETS,
  calculateDesktopPetMenuWindowGeometry,
  createLatestAsyncTaskRunner,
  desktopPetScale,
  normalizeDesktopPetSizePercent,
  resizeDesktopPetCollapsedWindowBounds,
  stepDesktopPetSizePercent,
  type DesktopPetConfigPayload,
  type DesktopPetMenuWindowGeometry,
  type DesktopPetMood,
  type DesktopPetWindowRect,
  type LatestAsyncTaskRunner,
  type DesktopPetSnapshot,
  type DesktopPetTarget,
  type InstalledPet,
  localizedPetText,
} from "./desktopPet";
import { convertChineseForLanguage, getCurrentLanguage, translate } from "../../../shared/i18n/index";
import { logWarn } from "../../../shared/platform/logger";
import { calculateDesktopPetRenderedBounds } from "../lib/desktopPetRenderedBounds";
import { BUILTIN_DESKTOP_PET_ID } from "../../../shared/preferences/settingsStore";
import "../styles/desktopPet.css";

function buildDesktopPetLabels(language: DesktopPetConfigPayload["language"]): DesktopPetConfigPayload["labels"] {
  return {
    openMain: translate(language, "desktopPet.actions.openMain"),
    openSettings: translate(language, "desktopPet.actions.openSettings"),
    size: translate(language, "desktopPet.settings.size"),
    hide: translate(language, "desktopPet.actions.hide"),
    idle: translate(language, "desktopPet.mood.idle"),
    working: translate(language, "desktopPet.mood.working"),
    waiting: translate(language, "desktopPet.mood.waiting"),
    success: translate(language, "desktopPet.mood.success"),
    error: translate(language, "desktopPet.mood.error"),
    sleeping: translate(language, "desktopPet.mood.sleeping"),
    runningCount: translate(language, "desktopPet.mood.runningCount"),
    taskList: translate(language, "desktopPet.actions.taskList"),
    currentTask: translate(language, "desktopPet.actions.currentTask"),
    unnamedTask: translate(language, "desktopPet.actions.unnamedTask"),
    openCurrent: translate(language, "desktopPet.actions.openCurrent"),
  };
}

const DEFAULT_LANGUAGE = getCurrentLanguage();

const DEFAULT_CONFIG: DesktopPetConfigPayload = {
  language: DEFAULT_LANGUAGE,
  visible: false,
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
  updatedAt: Date.now(),
  targets: [],
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
  secondaryHeaderHeight: number;
  showActionMenu: boolean;
  maxVisibleItems: number;
}

const DESKTOP_PET_HOVER_OPEN_DELAY_MS = 200;
const DESKTOP_PET_HOVER_CLOSE_DELAY_MS = 350;
const DESKTOP_PET_SIZE_WHEEL_COMMIT_DELAY_MS = 250;
const DESKTOP_PET_RENDERED_CONTENT_MARGIN_PX = 8;
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

function setDesktopPetWindowBounds(bounds: DesktopPetWindowRect): Promise<void> {
  return invoke("desktop_pet_window_set_bounds", { bounds });
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
  const [menuGeometry, setMenuGeometry] = useState<DesktopPetMenuWindowGeometry | null>(null);
  const [previewSize, setPreviewSize] = useState<number | null>(null);
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const menuTargets = snapshot.targets;
  const secondaryItemCount = menuTargets.length;
  const secondaryHeaderHeight = 0;
  const maxVisibleSecondaryItems = DESKTOP_PET_MENU_MAX_VISIBLE_TARGETS;
  const secondaryListScrollable = secondaryItemCount > maxVisibleSecondaryItems;
  const canOpenMenu = config.settings.showActionMenu || snapshot.targets.length > 0;
  const effectiveSize = previewSize ?? config.settings.size;
  const petScale = desktopPetScale(config.settings.size);
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
  const rootRef = useRef<HTMLElement | null>(null);
  const renderedFitRafRef = useRef<number | null>(null);
  const renderedFitPendingRef = useRef(false);
  const renderedFitInFlightRef = useRef(false);
  const renderedFitBasePositionKeyRef = useRef<string | null>(null);
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

  const setManagedDesktopPetWindowBounds = (bounds: DesktopPetWindowRect) => {
    // SetWindowPos emits onMoved too; never persist menu geometry as a user drag.
    stopUserDragTracking();
    expectedProgrammaticPositionRef.current = { x: bounds.x, y: bounds.y };
    return setDesktopPetWindowBounds(bounds);
  };

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

  useEffect(() => {
    const rootElements = [document.documentElement, document.body, document.getElementById("root")];
    rootElements.forEach((element) => {
      if (element) element.style.background = "transparent";
    });
    document.documentElement.dataset.window = "desktop-pet";
    const handleVisibilityChange = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    let disposed = false;
    const unlistenConfig = listen<DesktopPetConfigPayload>(DESKTOP_PET_CONFIG_EVENT, (event) => {
      if (!disposed) {
        setConfig(event.payload);
        if (!sizeAdjustingRef.current) {
          previewSizeRef.current = null;
          setPreviewSize(null);
        }
      }
    });
    const unlistenSnapshot = listen<DesktopPetSnapshot>(DESKTOP_PET_SNAPSHOT_EVENT, (event) => {
      if (!disposed) {
        setSnapshot({
          ...event.payload,
        });
      }
    });
    const unlistenCloseMenu = listen(DESKTOP_PET_CLOSE_MENU_EVENT, () => {
      if (!disposed) {
        closeMenuRef.current(true);
      }
    });
    const appWindow = getCurrentWindow();
    const unlistenMoved = appWindow.onMoved(({ payload }) => {
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
      if (moveTimerRef.current !== null) window.clearTimeout(moveTimerRef.current);
      moveTimerRef.current = window.setTimeout(() => {
        userDraggingRef.current = false;
        moveTimerRef.current = null;
        if (dragResetTimerRef.current !== null) {
          window.clearTimeout(dragResetTimerRef.current);
          dragResetTimerRef.current = null;
        }
        void emitTo("main", DESKTOP_PET_POSITION_EVENT, { x: payload.x, y: payload.y });
      }, 400);
    });
    void emit(DESKTOP_PET_READY_EVENT);
    return () => {
      disposed = true;
      if (moveTimerRef.current !== null) window.clearTimeout(moveTimerRef.current);
      if (dragResetTimerRef.current !== null) window.clearTimeout(dragResetTimerRef.current);
      if (hoverOpenTimerRef.current !== null) window.clearTimeout(hoverOpenTimerRef.current);
      if (hoverCloseTimerRef.current !== null) window.clearTimeout(hoverCloseTimerRef.current);
      if (sizeWheelCommitTimerRef.current !== null) {
        window.clearTimeout(sizeWheelCommitTimerRef.current);
      }
      menuWindowTaskRef.current?.dispose();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void unlistenConfig.then((unlisten) => unlisten());
      void unlistenSnapshot.then((unlisten) => unlisten());
      void unlistenCloseMenu.then((unlisten) => unlisten());
      void unlistenMoved.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    menuWindowTaskRef.current?.schedule({
      open: menuOpen,
      petScale,
      secondaryItemCount,
      secondaryHeaderHeight,
      showActionMenu: config.settings.showActionMenu,
      maxVisibleItems: maxVisibleSecondaryItems,
    });
  }, [
    config.settings.showActionMenu,
    maxVisibleSecondaryItems,
    menuOpen,
    petScale,
    secondaryHeaderHeight,
    secondaryItemCount,
  ]);

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
    if (snapshot.targets.length === 0) {
      if (hoverOpenTimerRef.current !== null) {
        window.clearTimeout(hoverOpenTimerRef.current);
        hoverOpenTimerRef.current = null;
      }
      if (menuOpen) closeMenuRef.current(true);
    }
  }, [config.settings.showActionMenu, menuOpen, snapshot.targets.length]);

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
  const detail = config.settings.showSessionName
    ? distinctDisplayLabels(
        localizeDisplayText(snapshot.projectName),
        localizeDisplayText(snapshot.sessionTitle)
      ).join(" · ")
    : "";
  const runningDetail = snapshot.runningCount > 1
    ? `${snapshot.runningCount} ${labels.runningCount}`
    : "";
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

  useLayoutEffect(() => {
    if (!config.visible || !documentVisible || menuOpen || menuGeometry) return;
    const root = rootRef.current;
    if (!root) return;
    let disposed = false;
    let retryTimer: number | null = null;

    const fitRenderedWindow = async () => {
      if (renderedFitInFlightRef.current) {
        renderedFitPendingRef.current = true;
        if (retryTimer === null) {
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            if (!disposed) scheduleFit();
          }, 50);
        }
        return;
      }
      renderedFitInFlightRef.current = true;
      try {
        while (renderedFitPendingRef.current && !disposed) {
          renderedFitPendingRef.current = false;
          if (menuOpenRef.current) continue;

          const rootRect = root.getBoundingClientRect();
          if (rootRect.width <= 0 || rootRect.height <= 0) continue;
          const contentRects = Array.from(
            root.querySelectorAll<HTMLElement>(".desktop-pet-status, .desktop-pet-stage")
          ).map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              left: rect.left - rootRect.left,
              top: rect.top - rootRect.top,
              right: rect.right - rootRect.left,
              bottom: rect.bottom - rootRect.top,
            };
          });

          const appWindow = getCurrentWindow();
          const [position, size, scaleFactor, monitor] = await Promise.all([
            appWindow.outerPosition(),
            appWindow.outerSize(),
            appWindow.scaleFactor().catch(() => 1),
            currentMonitor().catch(() => null),
          ]);
          if (disposed || menuOpenRef.current) continue;

          const geometry = calculateDesktopPetRenderedBounds({
            current: {
              x: position.x,
              y: position.y,
              width: size.width,
              height: size.height,
            },
            viewportWidth: rootRect.width,
            viewportHeight: rootRect.height,
            contentRects,
            petScale,
            scaleFactor,
            workArea: monitor
              ? {
                  x: monitor.workArea.position.x,
                  y: monitor.workArea.position.y,
                  width: monitor.workArea.size.width,
                  height: monitor.workArea.size.height,
                }
              : null,
            margin: DESKTOP_PET_RENDERED_CONTENT_MARGIN_PX,
          });
          if (!geometry.changed) continue;

          await setManagedDesktopPetWindowBounds(geometry.bounds);
          if (disposed || menuOpenRef.current) continue;

          // Persist the collapsed anchor instead of the expanded top-left corner.
          // Otherwise a restart would expand the window upward a second time.
          if (config.settings.position) {
            const key = `${geometry.basePosition.x}:${geometry.basePosition.y}`;
            if (renderedFitBasePositionKeyRef.current !== key) {
              renderedFitBasePositionKeyRef.current = key;
              await emitTo("main", DESKTOP_PET_POSITION_EVENT, geometry.basePosition);
            }
          }
        }
      } finally {
        renderedFitInFlightRef.current = false;
        if (renderedFitPendingRef.current && !disposed) scheduleFit();
      }
    };

    const scheduleFit = () => {
      renderedFitPendingRef.current = true;
      if (renderedFitRafRef.current !== null) {
        cancelAnimationFrame(renderedFitRafRef.current);
      }
      renderedFitRafRef.current = requestAnimationFrame(() => {
        renderedFitRafRef.current = requestAnimationFrame(() => {
          renderedFitRafRef.current = null;
          void fitRenderedWindow();
        });
      });
    };

    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleFit);
    observer?.observe(root);
    root.querySelectorAll<HTMLElement>(".desktop-pet-status, .desktop-pet-stage")
      .forEach((element) => observer?.observe(element));
    scheduleFit();

    return () => {
      disposed = true;
      renderedFitPendingRef.current = false;
      if (renderedFitRafRef.current !== null) {
        cancelAnimationFrame(renderedFitRafRef.current);
        renderedFitRafRef.current = null;
      }
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      observer?.disconnect();
    };
  }, [
    config.settings.position,
    config.settings.showStatus,
    config.settings.size,
    config.visible,
    detail,
    displayMood,
    documentVisible,
    installedPet,
    menuGeometry,
    menuOpen,
    petScale,
    runningDetail,
  ]);

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
    }).catch((err) => logWarn("Failed to request desktop pet target activation", err));
  };


  const openMainWindow = () => {
    closeMenu();
    void invoke("app_show_main_window").catch((err) => {
      logWarn("Failed to open CLI-Manager from desktop pet", err);
    });
  };

  return (
    <main
      ref={rootRef}
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
          setMenuOpen(true);
        }
      }}
      aria-label={moodLabel(labels, displayMood)}
    >
      <div className="desktop-pet-anchor">
        {config.settings.showStatus ? (
          <section className="desktop-pet-status" aria-live="polite">
            <strong>{moodLabel(labels, displayMood)}</strong>
            {detail ? <span title={detail}>{detail}</span> : null}
            {runningDetail ? <small>{runningDetail}</small> : null}
          </section>
        ) : null}

        <div
          className="desktop-pet-stage"
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
          {snapshot.attentionCount > 0 ? (
            <span className="desktop-pet-badge" aria-label={moodLabel(labels, "waiting")}>!</span>
          ) : null}
        </div>
      </div>

      {menuOpen && menuGeometry ? (
        <div
          className="desktop-pet-menu"
          data-has-targets={secondaryItemCount > 0 || undefined}
          role="menu"
          aria-label={labels.taskList}
        >
          {menuTargets.length > 0 ? (
            <div
              className="desktop-pet-target-list"
              data-scrollable={secondaryListScrollable || undefined}
            >
            {menuTargets.map((target, index) => {
              const identityLabels = distinctDisplayLabels(
                localizeDisplayText(target.projectName),
                localizeDisplayText(target.sessionTitle)
              );
              const primary = identityLabels[0] || `${labels.unnamedTask} ${index + 1}`;
              const secondary = identityLabels[1] ?? null;
              const status = targetStatusLabel(labels, target);
              const detailLabels = [secondary, status]
                .filter((value): value is string => Boolean(value));
              return (
                <button
                  key={target.sessionId}
                  type="button"
                  role="menuitem"
                  className="desktop-pet-target"
                  data-status={target.status}
                  data-active={target.active || undefined}
                  aria-current={target.active ? "true" : undefined}
                  style={targetFanStyle(
                    index,
                    menuTargets.length,
                    DESKTOP_PET_MENU_MAX_VISIBLE_TARGETS
                  )}
                  onClick={() => openTarget(target)}
                  title={[...identityLabels, status].join(" · ")}
                >
                  <span className="desktop-pet-target-indicator" aria-hidden="true" />
                  <span className="desktop-pet-target-copy">
                    <strong>{primary}</strong>
                    <small>{detailLabels.join(" · ")}</small>
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
          <div className="desktop-pet-menu-actions">
            <button
              type="button"
              role="menuitem"
              disabled={!snapshot.sessionId}
              onClick={() => openTarget()}
            >
              <MonitorUp size={14} aria-hidden="true" />
              <span>{labels.openCurrent}</span>
            </button>
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
                void emitTo("main", DESKTOP_PET_OPEN_SETTINGS_EVENT).catch((err) => {
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
              onClick={() => {
                closeMenu();
                setConfig((current) => ({ ...current, visible: false }));
                void invoke("desktop_pet_window_hide").catch((err) => {
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
