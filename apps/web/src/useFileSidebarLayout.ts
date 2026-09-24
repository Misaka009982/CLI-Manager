import { useEffect, useState } from "react";
import { sidebarLayout } from "./fileSidebarLayout";

function storedWidth(key: string, fallback: number) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value >= 200 && value <= 640 ? value : fallback;
  } catch { return fallback; }
}

export function useFileSidebarLayout(leftOpen: boolean, rightOpen: boolean, detailsOpen: boolean) {
  const [viewport, setViewport] = useState(window.innerWidth);
  const [left, setLeft] = useState(() => storedWidth("web-project-sidebar-width", 250));
  const [right, setRight] = useState(() => storedWidth("web-file-sidebar-width", 280));
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const resize = (side: "projects" | "files", width: number, persist: boolean) => {
    if (side === "projects") setLeft(width); else setRight(width);
    if (persist) {
      try { localStorage.setItem(side === "projects" ? "web-project-sidebar-width" : "web-file-sidebar-width", String(width)); }
      catch { /* Keep the browser-session width when storage is unavailable. */ }
    }
  };
  return { ...sidebarLayout(viewport, left, right, leftOpen, rightOpen, detailsOpen), resize };
}
