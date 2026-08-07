import type { TabNotificationState, TabStatusDetails } from "../stores/terminalStore";
import type {
  BackgroundPetTask,
  DesktopPetStatusColor,
  DesktopPetStatusCounts,
} from "./desktopPet";

export const DESKTOP_PET_OUTPUT_ACTIVITY_TTL_MS = 6000;

function timestampFromDetails(details: TabStatusDetails | undefined): number {
  if (!details?.updatedAt) return 0;
  const parsed = Date.parse(details.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function explicitDaemonTaskStatus(task: BackgroundPetTask | undefined): TabNotificationState | null {
  if (
    task?.taskStatus === "running"
    || task?.taskStatus === "attention"
    || task?.taskStatus === "done"
    || task?.taskStatus === "failed"
  ) {
    return task.taskStatus;
  }
  return null;
}

export function resolveDesktopPetOpenSessionStatus(input: {
  frontendStatus: TabNotificationState;
  frontendDetails?: TabStatusDetails;
  daemonTask?: BackgroundPetTask;
  outputActivityAt: number;
  now: number;
}): { status: TabNotificationState; updatedAt: number } {
  const frontendUpdatedAt = timestampFromDetails(input.frontendDetails);
  const daemonStatus = explicitDaemonTaskStatus(input.daemonTask);
  const daemonUpdatedAt = input.daemonTask?.taskUpdatedAtMs
    ?? input.daemonTask?.createdAtMs
    ?? 0;
  const resolved = daemonStatus && (frontendUpdatedAt === 0 || daemonUpdatedAt >= frontendUpdatedAt)
    ? { status: daemonStatus, updatedAt: daemonUpdatedAt }
    : { status: input.frontendStatus, updatedAt: frontendUpdatedAt };

  // PTY 输出仅是活动提示。Hook/daemon 一旦提供任务生命周期状态，
  // 终端重绘输出就不得重新打开已经结束的回合。
  if (resolved.status !== "none") return resolved;
  const recentOutput = input.outputActivityAt > 0
    && input.now >= input.outputActivityAt
    && input.now - input.outputActivityAt <= DESKTOP_PET_OUTPUT_ACTIVITY_TTL_MS;
  return recentOutput
    ? { status: "running", updatedAt: input.outputActivityAt }
    : resolved;
}

export function visibleDesktopPetStatusColors(
  counts: DesktopPetStatusCounts
): DesktopPetStatusColor[] {
  return (["green", "red", "blue"] as const).filter((color) => (
    Number.isFinite(counts[color]) && counts[color] > 0
  ));
}

export function normalizeDesktopPetStatusFilter(
  filter: DesktopPetStatusColor | null,
  counts: DesktopPetStatusCounts
): DesktopPetStatusColor | null {
  return filter && visibleDesktopPetStatusColors(counts).includes(filter)
    ? filter
    : null;
}
