import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import {
  DESKTOP_PET_BUBBLE_EMPTY_EVENT,
  DESKTOP_PET_BUBBLE_FOCUS_EVENT,
  DESKTOP_PET_BUBBLE_GEOMETRY_EVENT,
  DESKTOP_PET_BUBBLE_LAYOUT_REQUEST_EVENT,
  DESKTOP_PET_BUBBLE_MEASURE_EVENT,
  DESKTOP_PET_BUBBLE_READY_EVENT,
  DESKTOP_PET_CONFIG_EVENT,
  DESKTOP_PET_COORDINATOR_READY_EVENT,
  DESKTOP_PET_DECISION_RESOLVE_EVENT,
  DESKTOP_PET_INCIDENT_ACK_EVENT,
  DESKTOP_PET_OPEN_TARGET_EVENT,
  DESKTOP_PET_SNAPSHOT_EVENT,
  DESKTOP_PET_WINDOW_LABEL,
  buildDesktopPetLabels,
  type DesktopPetBubbleGeometryPayload,
  type DesktopPetBubbleFocusPayload,
  type DesktopPetBubbleLayoutRequestPayload,
  type DesktopPetBubbleMeasurementPayload,
  type DesktopPetConfigPayload,
  type DesktopPetConfigEventPayload,
  type DesktopPetDecisionAnswer,
  type DesktopPetDecisionRequest,
  type DesktopPetHitRegion,
  type DesktopPetIncident,
  type DesktopPetSnapshot,
  type DesktopPetSnapshotEventPayload,
} from "../lib/desktopPet";
import {
  DESKTOP_PET_BUBBLE_DEFAULT_WIDTH,
  DESKTOP_PET_COMPLETION_DURATION_MS,
  deriveDesktopPetBubbleContent,
  normalizeDesktopPetHitRegions,
  updateDesktopPetCompletionTimer,
  type DesktopPetCompletionSummary,
  type DesktopPetCompletionTimer,
} from "../lib/desktopPetBubble";
import {
  createDesktopPetSurfaceEpoch,
  shouldAcceptDesktopPetBubbleGeometry,
  shouldAcceptDesktopPetBubbleLayoutRequest,
  shouldAcceptDesktopPetConfigDelivery,
  shouldAcceptDesktopPetSnapshotDelivery,
} from "../lib/desktopPetTransport";
import { getCurrentLanguage } from "../lib/i18n";
import { logWarn } from "../lib/logger";
import {
  DesktopPetCompletionCard,
  DesktopPetDecisionCard,
  DesktopPetIncidentCard,
} from "./DesktopPetAlertCards";
import "./desktopPetBubble.css";

function createEmptySnapshot(): DesktopPetSnapshot {
  return {
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
}

function hashBubbleContent(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cardFocusableElement(card: HTMLElement): HTMLElement {
  return card.querySelector<HTMLElement>(
    "button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])"
  ) ?? card.querySelector<HTMLElement>("[data-pet-interactive]") ?? card;
}

export default function DesktopPetBubbleApp() {
  const [config, setConfig] = useState<DesktopPetConfigPayload | null>(null);
  const [snapshot, setSnapshot] = useState<DesktopPetSnapshot>(createEmptySnapshot);
  const [snapshotLifecycleToken, setSnapshotLifecycleToken] = useState<string | null>(null);
  const [layoutRequest, setLayoutRequest] = useState<DesktopPetBubbleLayoutRequestPayload | null>(null);
  const [geometry, setGeometry] = useState<DesktopPetBubbleGeometryPayload | null>(null);
  const [completionTimer, setCompletionTimer] = useState<DesktopPetCompletionTimer | null>(null);
  const [completionHovered, setCompletionHovered] = useState(false);
  const [highlightedCardId, setHighlightedCardId] = useState<string | null>(null);
  const [emptyReportRevision, setEmptyReportRevision] = useState(0);
  const surfaceEpochRef = useRef(createDesktopPetSurfaceEpoch());
  const configRef = useRef<DesktopPetConfigPayload | null>(null);
  const layoutRequestRef = useRef<DesktopPetBubbleLayoutRequestPayload | null>(null);
  const expectedVisibleRef = useRef(false);
  const viewportRef = useRef<HTMLElement | null>(null);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const hitRegionFrameRef = useRef<number | null>(null);
  const hitRegionRevisionRef = useRef(0);
  const measurementFrameRef = useRef<number | null>(null);
  const measurementRevisionRef = useRef(0);
  const geometryRevisionRef = useRef(0);
  const configDeliveryRevisionRef = useRef(0);
  const snapshotDeliveryRevisionRef = useRef(0);
  const latestMeasurementRevisionRef = useRef(0);
  const lastMeasurementKeyRef = useRef<string | null>(null);
  const emptyReportedIdentityRef = useRef<string | null>(null);
  const emptyRetryTimerRef = useRef<number | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const focusTargetsRef = useRef<Record<"red" | "blue", string | null>>({
    red: null,
    blue: null,
  });
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const focusedCardIdRef = useRef<string | null>(null);
  const previousCardIdsRef = useRef<string[]>([]);
  const content = useMemo(() => deriveDesktopPetBubbleContent(snapshot), [snapshot]);
  layoutRequestRef.current = layoutRequest;
  const expectedVisible = Boolean(config?.visible && config.bubbleVisible);
  const snapshotReady = Boolean(
    config && snapshotLifecycleToken === config.lifecycleToken
  );
  const labels = useMemo(
    () => buildDesktopPetLabels(config?.language ?? getCurrentLanguage()),
    [config?.language]
  );

  useEffect(() => {
    setCompletionTimer((current) => {
      if (!expectedVisible) return null;
      return updateDesktopPetCompletionTimer(
        current,
        content.completion,
        Date.now(),
        completionHovered
      );
    });
  }, [
    completionHovered,
    content.completion?.id,
    content.completion?.updatedAt,
    expectedVisible,
  ]);

  useEffect(() => {
    const completionId = content.completion?.id;
    const completionCard = completionId
      ? cardRefs.current.get(`completion:${completionId}`)
      : null;
    setCompletionHovered(Boolean(completionCard?.matches(":hover")));
  }, [content.completion?.id]);

  useEffect(() => {
    if (!completionTimer || completionTimer.paused) return;
    const delay = Math.max(0, completionTimer.expiresAt - Date.now());
    const timer = window.setTimeout(() => {
      setCompletionTimer((current) => updateDesktopPetCompletionTimer(
        current,
        content.completion,
        Date.now(),
        completionHovered
      ));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [
    completionHovered,
    completionTimer?.expiresAt,
    completionTimer?.paused,
    completionTimer?.summaryId,
    content.completion?.id,
  ]);

  const visibleCompletion = completionTimer?.summaryId === content.completion?.id
    ? content.completion
    : null;
  const cardIds = useMemo(() => [
    ...content.decisions.map((request) => `decision:${request.requestId}:${request.brokerEpoch}`),
    ...content.incidents.map((incident) => `incident:${incident.id}`),
    ...(visibleCompletion ? [`completion:${visibleCompletion.id}`] : []),
  ], [content.decisions, content.incidents, visibleCompletion]);
  const contentFingerprint = useMemo(() => hashBubbleContent({
    decisions: content.decisions,
    incidents: content.incidents,
    completion: visibleCompletion,
  }), [content.decisions, content.incidents, visibleCompletion]);
  const hasContent = cardIds.length > 0;
  const canInitializeCompletion = Boolean(
    content.completion
      && content.completion.updatedAt + DESKTOP_PET_COMPLETION_DURATION_MS > Date.now()
  );
  const cardIdentityKey = cardIds.join("|");
  focusTargetsRef.current = {
    red: content.incidents[0] ? `incident:${content.incidents[0].id}` : null,
    blue: content.decisions[0]
      ? `decision:${content.decisions[0].requestId}:${content.decisions[0].brokerEpoch}`
      : visibleCompletion
        ? `completion:${visibleCompletion.id}`
        : null,
  };

  useEffect(() => {
    if (
      !expectedVisible
      || hasContent
      || canInitializeCompletion
      || !config
      || snapshotLifecycleToken !== config.lifecycleToken
    ) {
      if (hasContent) emptyReportedIdentityRef.current = null;
      return;
    }
    const completionId = content.completion?.id ?? null;
    const reportIdentity = `${config.lifecycleToken}:${completionId ?? "none"}`;
    if (emptyReportedIdentityRef.current === reportIdentity) return;
    emptyReportedIdentityRef.current = reportIdentity;
    void emitTo("main", DESKTOP_PET_BUBBLE_EMPTY_EVENT, {
      lifecycleToken: config.lifecycleToken,
      bubbleSurfaceEpoch: surfaceEpochRef.current,
      completionId,
    }).catch((error) => {
      if (
        configRef.current?.lifecycleToken === config.lifecycleToken
        && emptyReportedIdentityRef.current === reportIdentity
      ) {
        emptyReportedIdentityRef.current = null;
        if (emptyRetryTimerRef.current !== null) {
          window.clearTimeout(emptyRetryTimerRef.current);
        }
        emptyRetryTimerRef.current = window.setTimeout(() => {
          emptyRetryTimerRef.current = null;
          setEmptyReportRevision((revision) => revision + 1);
        }, 1_000);
      }
      logWarn("Failed to report an empty desktop pet Bubble", error);
    });
  }, [
    canInitializeCompletion,
    config,
    content.completion?.id,
    emptyReportRevision,
    expectedVisible,
    hasContent,
    snapshotLifecycleToken,
  ]);

  useLayoutEffect(() => {
    const previousIds = previousCardIdsRef.current;
    const focusedId = focusedCardIdRef.current;
    previousCardIdsRef.current = cardIds;
    if (!focusedId || cardIds.includes(focusedId)) return;
    if (!document.hasFocus()) {
      focusedCardIdRef.current = null;
      return;
    }
    const previousIndex = Math.max(0, previousIds.indexOf(focusedId));
    const nextId = cardIds[Math.min(previousIndex, Math.max(0, cardIds.length - 1))];
    if (!nextId) {
      focusedCardIdRef.current = null;
      return;
    }
    const nextCard = cardRefs.current.get(nextId);
    if (nextCard) {
      focusedCardIdRef.current = nextId;
      cardFocusableElement(nextCard).focus({ preventScroll: true });
    }
  }, [cardIds]);

  useEffect(() => {
    const rootElements = [document.documentElement, document.body, document.getElementById("root")];
    rootElements.forEach((element) => {
      if (element) element.style.background = "transparent";
    });
    document.documentElement.dataset.window = "desktop-pet-bubble";
    const handleWindowBlur = () => {
      focusedCardIdRef.current = null;
    };
    window.addEventListener("blur", handleWindowBlur);
    let disposed = false;

    const announceReady = () => {
      if (disposed) return;
      void emit(DESKTOP_PET_BUBBLE_READY_EVENT, {
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
        const tokenChanged = configRef.current?.lifecycleToken !== nextConfig.lifecycleToken;
        configRef.current = nextConfig;
        const visible = nextConfig.visible && nextConfig.bubbleVisible;
        expectedVisibleRef.current = visible;
        setConfig(nextConfig);
        if (tokenChanged) {
          announceReady();
          geometryRevisionRef.current = 0;
        }
        if (tokenChanged || !visible) {
          setSnapshot(createEmptySnapshot());
          setSnapshotLifecycleToken(null);
          setHighlightedCardId(null);
          focusedCardIdRef.current = null;
          previousCardIdsRef.current = [];
          cardRefs.current.clear();
          if (highlightTimerRef.current !== null) {
            window.clearTimeout(highlightTimerRef.current);
            highlightTimerRef.current = null;
          }
          if (emptyRetryTimerRef.current !== null) {
            window.clearTimeout(emptyRetryTimerRef.current);
            emptyRetryTimerRef.current = null;
          }
          layoutRequestRef.current = null;
          setLayoutRequest(null);
          setGeometry(null);
          setCompletionTimer(null);
          setCompletionHovered(false);
          lastMeasurementKeyRef.current = null;
        }
      }
    );
    const unlistenSnapshot = listen<DesktopPetSnapshotEventPayload>(
      DESKTOP_PET_SNAPSHOT_EVENT,
      (event) => {
        const currentConfig = configRef.current;
        if (
          disposed
          || !expectedVisibleRef.current
          || !currentConfig
          || !shouldAcceptDesktopPetSnapshotDelivery(
            currentConfig.lifecycleToken,
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
        setSnapshotLifecycleToken(event.payload.lifecycleToken);
        setSnapshot({
          ...nextSnapshot,
          handoffPlatforms: nextSnapshot.handoffPlatforms ?? [],
        });
      }
    );
    const unlistenLayout = listen<DesktopPetBubbleLayoutRequestPayload>(
      DESKTOP_PET_BUBBLE_LAYOUT_REQUEST_EVENT,
      (event) => {
        const currentConfig = configRef.current;
        if (
          disposed
          || !currentConfig
          || !expectedVisibleRef.current
          || !shouldAcceptDesktopPetBubbleLayoutRequest(
            currentConfig.lifecycleToken,
            layoutRequestRef.current,
            event.payload
          )
        ) {
          return;
        }
        layoutRequestRef.current = event.payload;
        setLayoutRequest(event.payload);
      }
    );
    const unlistenGeometry = listen<DesktopPetBubbleGeometryPayload>(
      DESKTOP_PET_BUBBLE_GEOMETRY_EVENT,
      (event) => {
        const currentConfig = configRef.current;
        if (
          disposed
          || !currentConfig
          || !expectedVisibleRef.current
          || !shouldAcceptDesktopPetBubbleGeometry({
            expectedLifecycleToken: currentConfig.lifecycleToken,
            expectedBubbleSurfaceEpoch: surfaceEpochRef.current,
            expectedMeasurementRevision: latestMeasurementRevisionRef.current,
            previousGeometryRevision: geometryRevisionRef.current,
            request: layoutRequestRef.current,
            candidate: event.payload,
          })
        ) {
          return;
        }
        geometryRevisionRef.current = event.payload.geometryRevision;
        setGeometry(event.payload);
      }
    );

    const unlistenFocus = listen<DesktopPetBubbleFocusPayload>(
      DESKTOP_PET_BUBBLE_FOCUS_EVENT,
      (event) => {
        const currentConfig = configRef.current;
        if (
          disposed
          || !currentConfig
          || event.payload.lifecycleToken !== currentConfig.lifecycleToken
          || (event.payload.color !== "red" && event.payload.color !== "blue")
        ) {
          return;
        }
        const cardId = focusTargetsRef.current[event.payload.color];
        const card = cardId ? cardRefs.current.get(cardId) : null;
        if (!cardId || !card) return;
        card.scrollIntoView({ block: "nearest", inline: "nearest" });
        setHighlightedCardId(cardId);
        if (highlightTimerRef.current !== null) {
          window.clearTimeout(highlightTimerRef.current);
        }
        highlightTimerRef.current = window.setTimeout(() => {
          highlightTimerRef.current = null;
          setHighlightedCardId((current) => current === cardId ? null : current);
        }, 1_200);
      }
    );

    void unlistenCoordinatorReady.then(() => {
      announceReady();
    });
    return () => {
      disposed = true;
      expectedVisibleRef.current = false;
      configRef.current = null;
      if (measurementFrameRef.current !== null) {
        window.cancelAnimationFrame(measurementFrameRef.current);
      }
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
      if (emptyRetryTimerRef.current !== null) {
        window.clearTimeout(emptyRetryTimerRef.current);
      }
      cardRefs.current.clear();
      focusedCardIdRef.current = null;
      window.removeEventListener("blur", handleWindowBlur);
      void unlistenCoordinatorReady.then((unlisten) => unlisten());
      void unlistenConfig.then((unlisten) => unlisten());
      void unlistenSnapshot.then((unlisten) => unlisten());
      void unlistenLayout.then((unlisten) => unlisten());
      void unlistenGeometry.then((unlisten) => unlisten());
      void unlistenFocus.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const stack = stackRef.current;
    if (
      !snapshotReady
      || !stack
      || !expectedVisible
      || !hasContent
      || !layoutRequest
      || !config
    ) {
      return;
    }

    const measure = () => {
      measurementFrameRef.current = null;
      const currentStack = stackRef.current;
      const currentConfig = configRef.current;
      if (
        !currentStack
        || !currentConfig
        || !expectedVisibleRef.current
        || currentConfig.lifecycleToken !== layoutRequest.lifecycleToken
      ) {
        return;
      }
      const naturalWidth = Math.max(
        DESKTOP_PET_BUBBLE_DEFAULT_WIDTH,
        currentStack.scrollWidth + 20
      );
      const naturalHeight = Math.max(1, currentStack.scrollHeight + 20);
      const measurementKey = [
        layoutRequest.petSurfaceEpoch,
        layoutRequest.revision,
        layoutRequest.lifecycleToken,
        contentFingerprint,
        Math.round(naturalWidth * 4) / 4,
        Math.round(naturalHeight * 4) / 4,
      ].join(":");
      if (lastMeasurementKeyRef.current === measurementKey) return;
      lastMeasurementKeyRef.current = measurementKey;
      const measurementRevision = measurementRevisionRef.current + 1;
      measurementRevisionRef.current = measurementRevision;
      latestMeasurementRevisionRef.current = measurementRevision;
      const payload: DesktopPetBubbleMeasurementPayload = {
        ...layoutRequest,
        bubbleSurfaceEpoch: surfaceEpochRef.current,
        measurementRevision,
        contentFingerprint,
        naturalWidth,
        naturalHeight,
      };
      void emitTo(
        DESKTOP_PET_WINDOW_LABEL,
        DESKTOP_PET_BUBBLE_MEASURE_EVENT,
        payload
      ).catch((error) => {
        logWarn("Failed to report desktop pet Bubble measurement", error);
      });
    };
    const scheduleMeasure = () => {
      if (measurementFrameRef.current !== null) return;
      measurementFrameRef.current = window.requestAnimationFrame(measure);
    };
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleMeasure);
    observer?.observe(stack);
    window.addEventListener("resize", scheduleMeasure);
    scheduleMeasure();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (measurementFrameRef.current !== null) {
        window.cancelAnimationFrame(measurementFrameRef.current);
        measurementFrameRef.current = null;
      }
    };
  }, [
    config,
    contentFingerprint,
    expectedVisible,
    hasContent,
    layoutRequest,
    snapshotReady,
  ]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const currentGeometry = geometry;
    const currentConfig = config;
    if (
      !viewport
      || !currentGeometry
      || !currentConfig
      || !expectedVisible
      || !hasContent
      || currentGeometry.lifecycleToken !== currentConfig.lifecycleToken
      || currentGeometry.bubbleSurfaceEpoch !== surfaceEpochRef.current
    ) {
      return;
    }
    let disposed = false;
    const report = async () => {
      hitRegionFrameRef.current = null;
      if (disposed) return;
      const scaleFactor = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1;
      const regions: DesktopPetHitRegion[] = [];
      const appendRegion = (
        element: Element,
        kind: DesktopPetHitRegion["kind"],
        padding = 0
      ) => {
        const rect = element.getBoundingClientRect();
        const normalized = normalizeDesktopPetHitRegions(
          [{
            x: rect.x - padding,
            y: rect.y - padding,
            width: rect.width + padding * 2,
            height: rect.height + padding * 2,
          }],
          window.innerWidth,
          window.innerHeight,
          scaleFactor,
          1
        )[0];
        if (normalized) regions.push({ kind, ...normalized });
      };
      const cards = Array.from(
        viewport.querySelectorAll<HTMLElement>(".desktop-pet-bubble-card-shell")
      );
      let panelAssigned = false;
      for (const card of cards) {
        const before = regions.length;
        appendRegion(card, panelAssigned ? "control" : "panel", 4);
        if (regions.length > before) panelAssigned = true;
      }
      if (viewport.scrollHeight > viewport.clientHeight) {
        const rect = viewport.getBoundingClientRect();
        const scrollbarWidth = Math.min(10, Math.max(5, rect.width));
        const normalized = normalizeDesktopPetHitRegions(
          [{
            x: rect.right - scrollbarWidth,
            y: rect.top,
            width: scrollbarWidth,
            height: rect.height,
          }],
          window.innerWidth,
          window.innerHeight,
          scaleFactor,
          1
        )[0];
        if (normalized) regions.push({ kind: "control", ...normalized });
      }
      const regionRevision = hitRegionRevisionRef.current + 1;
      hitRegionRevisionRef.current = regionRevision;
      await invoke("desktop_pet_window_set_hit_regions", {
        lifecycleToken: currentConfig.lifecycleToken,
        surfaceEpoch: surfaceEpochRef.current,
        boundsRevision: currentGeometry.geometryRevision,
        regionRevision,
        regions: regions.slice(0, 64),
      }).catch((error) => {
        if (
          configRef.current?.lifecycleToken === currentConfig.lifecycleToken
          && geometryRevisionRef.current === currentGeometry.geometryRevision
        ) {
          logWarn("Failed to update desktop pet Bubble hit regions", error);
        }
      });
    };
    const schedule = () => {
      if (disposed || hitRegionFrameRef.current !== null) return;
      hitRegionFrameRef.current = window.requestAnimationFrame(() => void report());
    };
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedule);
    if (stackRef.current) observer?.observe(stackRef.current);
    viewport.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      disposed = true;
      observer?.disconnect();
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (hitRegionFrameRef.current !== null) {
        window.cancelAnimationFrame(hitRegionFrameRef.current);
        hitRegionFrameRef.current = null;
      }
    };
  }, [
    cardIdentityKey,
    config?.lifecycleToken,
    expectedVisible,
    geometry,
    hasContent,
  ]);

  const resolveDecision = async (
    request: DesktopPetDecisionRequest,
    answer: DesktopPetDecisionAnswer
  ): Promise<void> => {
    const currentConfig = configRef.current;
    if (!currentConfig || !expectedVisibleRef.current) {
      throw new Error("desktop_pet_bubble_lifecycle_stale");
    }
    await emitTo("main", DESKTOP_PET_DECISION_RESOLVE_EVENT, {
      requestId: request.requestId,
      brokerEpoch: request.brokerEpoch,
      lifecycleToken: currentConfig.lifecycleToken,
      bubbleSurfaceEpoch: surfaceEpochRef.current,
      answer,
    }).catch((error) => {
      logWarn("Failed to route desktop pet Bubble decision", error);
      throw error;
    });
  };

  const openIncident = (incident: DesktopPetIncident) => {
    const currentConfig = configRef.current;
    if (!currentConfig || !expectedVisibleRef.current) return;
    void emitTo("main", DESKTOP_PET_OPEN_TARGET_EVENT, {
      sessionId: incident.tabId || incident.sessionId,
      daemonOnly: incident.daemonOnly,
      lifecycleToken: currentConfig.lifecycleToken,
      surfaceEpoch: surfaceEpochRef.current,
    }).catch((error) => logWarn("Failed to open desktop pet Bubble incident target", error));
  };

  const acknowledgeIncident = (incident: DesktopPetIncident) => {
    const currentConfig = configRef.current;
    if (!currentConfig || !expectedVisibleRef.current) return;
    void emitTo("main", DESKTOP_PET_INCIDENT_ACK_EVENT, {
      incidentId: incident.id,
      lifecycleToken: currentConfig.lifecycleToken,
      bubbleSurfaceEpoch: surfaceEpochRef.current,
    }).catch((error) => logWarn("Failed to acknowledge desktop pet Bubble incident", error));
  };

  const openCompletion = (completion: DesktopPetCompletionSummary) => {
    const currentConfig = configRef.current;
    if (!currentConfig || !expectedVisibleRef.current) return;
    void emitTo("main", DESKTOP_PET_OPEN_TARGET_EVENT, {
      sessionId: completion.sessionId,
      daemonOnly: completion.daemonOnly,
      lifecycleToken: currentConfig.lifecycleToken,
      surfaceEpoch: surfaceEpochRef.current,
    }).catch((error) => logWarn("Failed to open desktop pet Bubble completion target", error));
  };

  const rootStyle = {
    "--bubble-arrow-offset": `${geometry?.arrowOffset ?? 0}px`,
  } as CSSProperties;

  if (!expectedVisible || !hasContent) {
    return <main className="desktop-pet-bubble-root" aria-hidden="true" />;
  }

  return (
    <main
      className="desktop-pet-bubble-root"
      data-placement={geometry?.placement ?? "above"}
      style={rootStyle}
      aria-label={labels.taskList}
    >
      <div className="desktop-pet-bubble-arrow" aria-hidden="true" />
      <section
        ref={viewportRef}
        className="desktop-pet-bubble-viewport"
        aria-label={labels.taskList}
      >
        <div ref={stackRef} className="desktop-pet-bubble-stack">
          {content.decisions.map((request) => {
            const cardId = `decision:${request.requestId}:${request.brokerEpoch}`;
            return (
              <div
                key={cardId}
                ref={(node) => {
                  if (node) cardRefs.current.set(cardId, node);
                  else cardRefs.current.delete(cardId);
                }}
                className="desktop-pet-bubble-card-shell"
                data-bubble-card-id={cardId}
                data-highlighted={highlightedCardId === cardId || undefined}
                onFocusCapture={() => {
                  focusedCardIdRef.current = cardId;
                }}
              >
                <DesktopPetDecisionCard
                  request={request}
                  labels={labels}
                  bubbleSurfaceEpoch={surfaceEpochRef.current}
                  onResolve={resolveDecision}
                />
              </div>
            );
          })}
          {content.incidents.map((incident) => {
            const cardId = `incident:${incident.id}`;
            return (
              <div
                key={cardId}
                ref={(node) => {
                  if (node) cardRefs.current.set(cardId, node);
                  else cardRefs.current.delete(cardId);
                }}
                className="desktop-pet-bubble-card-shell"
                data-bubble-card-id={cardId}
                data-highlighted={highlightedCardId === cardId || undefined}
                onFocusCapture={() => {
                  focusedCardIdRef.current = cardId;
                }}
              >
                <DesktopPetIncidentCard
                  incident={incident}
                  labels={labels}
                  onOpen={openIncident}
                  onAcknowledge={acknowledgeIncident}
                />
              </div>
            );
          })}
          {visibleCompletion ? (
            <div
              key={`completion:${visibleCompletion.id}`}
              ref={(node) => {
                const cardId = `completion:${visibleCompletion.id}`;
                if (node) cardRefs.current.set(cardId, node);
                else cardRefs.current.delete(cardId);
              }}
              className="desktop-pet-bubble-card-shell"
              data-bubble-card-id={`completion:${visibleCompletion.id}`}
              data-highlighted={
                highlightedCardId === `completion:${visibleCompletion.id}` || undefined
              }
              onFocusCapture={() => {
                focusedCardIdRef.current = `completion:${visibleCompletion.id}`;
              }}
              onPointerEnter={() => setCompletionHovered(true)}
              onPointerLeave={() => setCompletionHovered(false)}
            >
              <DesktopPetCompletionCard
                completion={visibleCompletion}
                labels={labels}
                onOpen={openCompletion}
              />
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
