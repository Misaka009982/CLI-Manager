import type {
  DesktopPetEColor,
  DesktopPetESnapshot,
  DesktopPetETask,
} from "../bridge/protocol.js";

export const COLOR_ORDER: readonly DesktopPetEColor[] = ["green", "yellow", "red", "blue"];

export function tasksForColor(
  snapshot: DesktopPetESnapshot | null,
  color: DesktopPetEColor | null,
): DesktopPetETask[] {
  if (!snapshot || !color) return [];
  return snapshot.tasks.filter((task) => task.color === color);
}

export function firstAvailableColor(snapshot: DesktopPetESnapshot | null): DesktopPetEColor | null {
  if (!snapshot) return null;
  return COLOR_ORDER.find((color) => snapshot.counts[color] > 0) ?? null;
}

export function canClearTask(task: DesktopPetETask): boolean {
  return !task.sessionAlive && (task.color === "red" || task.color === "blue");
}

export function canOpenTask(task: DesktopPetETask): boolean {
  return task.sessionAlive;
}
