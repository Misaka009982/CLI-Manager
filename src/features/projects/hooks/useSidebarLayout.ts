import { useState, useEffect, useRef, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { getOsPlatform } from "../../../shared/platform/shell";
import {
  SIDEBAR_EXPAND_REQUEST_EVENT,
  SIDEBAR_TOGGLE_REQUEST_EVENT,
  notifySidebarStateChange,
} from "../api/sidebarCommands";
import {
  type SidebarProps,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_COLLAPSE_THRESHOLD,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_AUTO_COLLAPSE_BREAKPOINT,
  IN_TAURI,
  isLikelyMacOs,
  clampExpandedSidebarWidth,
  normalizePersistedSidebarWidth,
} from "../lib/sidebarModel";

export function useSidebarLayout({
  compactMode,
  dockSide,
}: Required<Pick<SidebarProps, "compactMode" | "dockSide">>) {
  const updateSetting = useSettingsStore((s) => s.update);
  const persistedSidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  const initialSidebarWidth = normalizePersistedSidebarWidth(persistedSidebarWidth);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    initialSidebarWidth <= SIDEBAR_COLLAPSED_WIDTH
  );
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [isMacOs, setIsMacOs] = useState(isLikelyMacOs);

  const sidebarElementRef = useRef<HTMLElement | null>(null);
  const isResizingRef = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const sidebarCollapsedRef = useRef(initialSidebarWidth <= SIDEBAR_COLLAPSED_WIDTH);
  const autoCollapsedByViewportRef = useRef(false);
  const lastExpandedWidthRef = useRef(
    initialSidebarWidth <= SIDEBAR_COLLAPSED_WIDTH
      ? 248
      : clampExpandedSidebarWidth(initialSidebarWidth)
  );

  useEffect(() => {
    if (!IN_TAURI) return;
    void getOsPlatform()
      .then((platform) => setIsMacOs(platform === "macos"))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (compactMode) {
      setSidebarCollapsed(false);
      return;
    }
    if (isResizingRef.current) return;
    const normalized = normalizePersistedSidebarWidth(persistedSidebarWidth);
    setSidebarWidth(normalized);
    setSidebarCollapsed(normalized <= SIDEBAR_COLLAPSED_WIDTH);
    sidebarCollapsedRef.current = normalized <= SIDEBAR_COLLAPSED_WIDTH;
    if (normalized > SIDEBAR_COLLAPSED_WIDTH) {
      lastExpandedWidthRef.current = normalized;
    }
  }, [compactMode, persistedSidebarWidth]);

  useEffect(() => {
    return () => {
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, []);

  const persistSidebarWidth = useCallback(
    (nextWidth: number) => {
      void updateSetting("sidebarWidth", nextWidth);
    },
    [updateSetting]
  );

  const previewSidebarWidth = useCallback((rawWidth: number) => {
    const clampedRaw = Math.max(SIDEBAR_COLLAPSED_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, rawWidth));
    const shouldCollapse = clampedRaw < SIDEBAR_COLLAPSE_THRESHOLD;
    const nextWidth = shouldCollapse
      ? SIDEBAR_COLLAPSED_WIDTH
      : clampExpandedSidebarWidth(clampedRaw);

    if (sidebarElementRef.current) {
      sidebarElementRef.current.style.width = `${nextWidth}px`;
    }
    sidebarCollapsedRef.current = shouldCollapse;
    if (!shouldCollapse) {
      lastExpandedWidthRef.current = nextWidth;
    }
    return { nextWidth, shouldCollapse };
  }, []);

  const collapseSidebar = useCallback((persist = true) => {
    setSidebarCollapsed(true);
    sidebarCollapsedRef.current = true;
    setSidebarWidth(SIDEBAR_COLLAPSED_WIDTH);
    if (persist) {
      autoCollapsedByViewportRef.current = false;
      persistSidebarWidth(SIDEBAR_COLLAPSED_WIDTH);
    }
  }, [persistSidebarWidth]);

  const expandSidebar = useCallback((persist = true) => {
    const fallbackWidth = lastExpandedWidthRef.current;
    const nextWidth = clampExpandedSidebarWidth(fallbackWidth);
    setSidebarCollapsed(false);
    sidebarCollapsedRef.current = false;
    setSidebarWidth(nextWidth);
    lastExpandedWidthRef.current = nextWidth;
    if (persist) {
      autoCollapsedByViewportRef.current = false;
      persistSidebarWidth(nextWidth);
    }
  }, [persistSidebarWidth]);

  const toggleSidebarCollapsed = useCallback(() => {
    if (sidebarCollapsed) {
      expandSidebar();
    } else {
      collapseSidebar();
    }
  }, [sidebarCollapsed, expandSidebar, collapseSidebar]);

  const ensureSidebarExpanded = useCallback(() => {
    if (sidebarCollapsed) {
      expandSidebar();
    }
  }, [sidebarCollapsed, expandSidebar]);

  useEffect(() => {
    notifySidebarStateChange({
      collapsed: compactMode ? false : sidebarCollapsed,
      compactMode,
    });
  }, [compactMode, sidebarCollapsed]);

  useEffect(() => {
    if (compactMode) return;
    const handleExpandRequest = () => {
      if (sidebarCollapsedRef.current) expandSidebar();
    };
    window.addEventListener(SIDEBAR_EXPAND_REQUEST_EVENT, handleExpandRequest);
    return () => window.removeEventListener(SIDEBAR_EXPAND_REQUEST_EVENT, handleExpandRequest);
  }, [compactMode, expandSidebar]);

  useEffect(() => {
    if (compactMode) return;
    const handleToggleRequest = () => toggleSidebarCollapsed();
    window.addEventListener(SIDEBAR_TOGGLE_REQUEST_EVENT, handleToggleRequest);
    return () => window.removeEventListener(SIDEBAR_TOGGLE_REQUEST_EVENT, handleToggleRequest);
  }, [compactMode, toggleSidebarCollapsed]);

  useEffect(() => {
    if (compactMode || isMacOs) return;
    const syncViewportCollapse = () => {
      if (window.innerWidth < SIDEBAR_AUTO_COLLAPSE_BREAKPOINT) {
        if (!sidebarCollapsedRef.current) {
          autoCollapsedByViewportRef.current = true;
          collapseSidebar(false);
        }
        return;
      }

      if (autoCollapsedByViewportRef.current) {
        autoCollapsedByViewportRef.current = false;
        if (sidebarCollapsedRef.current) {
          expandSidebar(false);
        }
      }
    };

    syncViewportCollapse();
    window.addEventListener("resize", syncViewportCollapse);
    return () => {
      window.removeEventListener("resize", syncViewportCollapse);
    };
  }, [compactMode, isMacOs, collapseSidebar, expandSidebar]);

  const startResize = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;
      setSidebarResizing(true);

      let latestX = e.clientX;
      const getWidthFromPointer = (clientX: number) => (
        dockSide === "right" ? window.innerWidth - clientX : clientX
      );
      const flush = () => {
        resizeFrameRef.current = null;
        previewSidebarWidth(getWidthFromPointer(latestX));
      };

      const onMove = (ev: MouseEvent) => {
        latestX = ev.clientX;
        if (resizeFrameRef.current === null) {
          resizeFrameRef.current = requestAnimationFrame(flush);
        }
      };

      const onUp = () => {
        if (resizeFrameRef.current !== null) {
          cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
        const { nextWidth, shouldCollapse } = previewSidebarWidth(getWidthFromPointer(latestX));
        setSidebarCollapsed(shouldCollapse);
        setSidebarWidth(nextWidth);
        isResizingRef.current = false;
        setSidebarResizing(false);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        persistSidebarWidth(nextWidth);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [dockSide, persistSidebarWidth, previewSidebarWidth]
  );

  return {
    sidebarElementRef,
    sidebarWidth,
    sidebarCollapsed,
    sidebarResizing,
    toggleSidebarCollapsed,
    ensureSidebarExpanded,
    expandSidebar,
    startResize,
  };
}
