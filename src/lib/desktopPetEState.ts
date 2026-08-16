import type { Project, TerminalSession } from "./types";
import { shouldIncludeAgentTerminal } from "./agentTerminal";
import type { BackgroundPetTask } from "./desktopPet";
import { resolveDesktopPetOpenSessionStatus } from "./desktopPetStatus";
import type {
  SessionStatus,
  TabNotificationState,
  TabStatusDetails,
} from "../stores/terminalStore";
import {
  DESKTOP_PET_E_PROTOCOL_VERSION,
  type DesktopPetEAgentSource,
  type DesktopPetECliLabel,
  type DesktopPetEColor,
  type DesktopPetEColorCounts,
  type DesktopPetEMood,
  type DesktopPetENotification,
  type DesktopPetEPendingAction,
  type DesktopPetESnapshot,
  type DesktopPetETask,
} from "./desktopPetE";

export type DesktopPetERawStatus = "none" | "running" | "attention" | "done" | "failed";

export interface DesktopPetETaskCandidate {
  sessionId: string;
  source?: DesktopPetEAgentSource | null;
  agentLabel?: string | null;
  title?: string | null;
  projectName?: string | null;
  workspanId?: string | null;
  paneId?: string | null;
  daemonOnly?: boolean;
  sessionAlive?: boolean;
  status: DesktopPetERawStatus;
  updatedAt: number;
  active?: boolean;
  pendingAction?: DesktopPetEPendingAction | null;
}

export interface DesktopPetEAuthoritativeInput {
  instanceId: string;
  generation: number;
  revision: number;
  generatedAt?: number;
  sessions: TerminalSession[];
  persistedSessions: TerminalSession[];
  projects: Project[];
  targetBySessionId?: ReadonlyMap<string, { workspanId: string; paneId: string }>;
  activeSessionId: string | null;
  sessionStatuses: Record<string, SessionStatus>;
  sessionStatusUpdatedAt?: Record<string, number>;
  tabNotifications: Record<string, TabNotificationState>;
  tabStatusDetails: Record<string, TabStatusDetails>;
  ptyOutputActivityAt: Record<string, number>;
  backgroundTasks: BackgroundPetTask[];
  pendingActions?: ReadonlyMap<string, DesktopPetEPendingAction>;
  viewedTerminalTaskIds?: ReadonlySet<string>;
  clearedTaskIds?: ReadonlySet<string>;
  notification?: DesktopPetENotification | null;
  diagnostics?: DesktopPetESnapshot["diagnostics"];
}

export interface DesktopPetEStateInput {
  instanceId: string;
  generation: number;
  revision: number;
  generatedAt?: number;
  candidates: DesktopPetETaskCandidate[];
  viewedTerminalTaskIds?: ReadonlySet<string>;
  clearedTaskIds?: ReadonlySet<string>;
  notification?: DesktopPetENotification | null;
  diagnostics?: DesktopPetESnapshot["diagnostics"];
}

const MOOD_PRIORITY: Record<DesktopPetEMood, number> = {
  idle: 0,
  blue: 1,
  green: 2,
  red: 3,
  yellow: 4,
};

const SOURCE_LABELS: Record<DesktopPetEAgentSource, string> = {
  claude: "Claude",
  codex: "Codex",
  pi: "Pi",
  grok: "Grok",
  other: "CLI",
};

function normalizeTimestamp(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
}

function normalizeText(value: string | null | undefined, fallback: string, maxLength = 160): string {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function resolveDesktopPetEAgentSource(cliTool: string | null | undefined): DesktopPetEAgentSource {
  const normalized = cliTool?.trim().toLowerCase() ?? "";
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex")) return "codex";
  if (normalized === "pi" || normalized.endsWith("/pi") || normalized.endsWith("\\pi")) return "pi";
  if (normalized.includes("grok")) return "grok";
  return "other";
}

function resolveDesktopPetECliTool(
  session: TerminalSession | null | undefined,
  project: Project | null | undefined,
): string | null {
  return session?.cliTool?.trim() || project?.cli_tool?.trim() || null;
}

function resolveDesktopPetEAgentLabel(source: DesktopPetEAgentSource): string {
  return SOURCE_LABELS[source];
}

function resolveDaemonTaskStatus(task: BackgroundPetTask): DesktopPetERawStatus {
  if (task.taskStatus === "running" || task.taskStatus === "attention") return task.taskStatus;
  if (task.taskStatus === "failed") return "failed";
  if (task.taskStatus === "done" || !task.alive) return "done";
  return "running";
}

function resolveDaemonTaskUpdatedAt(task: BackgroundPetTask, fallback: number): number {
  return normalizeTimestamp(task.taskUpdatedAtMs ?? task.createdAtMs, fallback);
}

function resolveSessionProject(
  session: TerminalSession | null | undefined,
  projectById: ReadonlyMap<string, Project>,
): Project | null {
  return session?.projectId ? projectById.get(session.projectId) ?? null : null;
}

export function deriveDesktopPetECandidates(
  input: DesktopPetEAuthoritativeInput,
): DesktopPetETaskCandidate[] {
  const now = normalizeTimestamp(input.generatedAt ?? Date.now(), Date.now());
  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  const backgroundBySession = new Map(input.backgroundTasks.map((task) => [task.sessionId, task]));
  const openSessionIds = new Set<string>();
  const candidates: DesktopPetETaskCandidate[] = [];

  for (const session of input.sessions) {
    if (session.kind && session.kind !== "pty") continue;
    openSessionIds.add(session.id);
    const project = resolveSessionProject(session, projectById);
    if (!shouldIncludeAgentTerminal(session, project, false)) continue;
    const resolved = resolveDesktopPetOpenSessionStatus({
      frontendStatus: input.tabNotifications[session.id] ?? "none",
      frontendDetails: input.tabStatusDetails[session.id],
      daemonTask: backgroundBySession.get(session.id),
      outputActivityAt: input.ptyOutputActivityAt[session.id] ?? 0,
      now,
    });
    const pendingAction = input.pendingActions?.get(session.id) ?? null;
    const status = resolved.status === "none" && input.sessionStatuses[session.id] === "error"
      ? "failed"
      : resolved.status;
    if (status === "none" && !pendingAction) continue;
    const target = input.targetBySessionId?.get(session.id) ?? null;
    const source = resolveDesktopPetEAgentSource(resolveDesktopPetECliTool(session, project));
    const statusUpdatedAt = input.sessionStatusUpdatedAt?.[session.id] ?? now;
    candidates.push({
      sessionId: session.id,
      source,
      agentLabel: resolveDesktopPetEAgentLabel(source),
      title: session.title,
      projectName: project?.name ?? null,
      workspanId: target?.workspanId ?? null,
      paneId: target?.paneId ?? null,
      daemonOnly: false,
      sessionAlive: true,
      status,
      updatedAt: pendingAction
        ? Math.max(now, resolved.updatedAt)
        : status !== resolved.status
          ? Math.max(statusUpdatedAt, resolved.updatedAt)
          : resolved.updatedAt,
      active: session.id === input.activeSessionId,
      pendingAction,
    });
  }

  const persistedBySession = new Map(input.persistedSessions.map((session) => [session.id, session]));
  for (const task of input.backgroundTasks) {
    if (openSessionIds.has(task.sessionId)) continue;
    const session = persistedBySession.get(task.sessionId);
    const project = resolveSessionProject(session, projectById);
    if (!shouldIncludeAgentTerminal(session, project, false)) continue;
    const pendingAction = input.pendingActions?.get(task.sessionId) ?? null;
    const source = resolveDesktopPetEAgentSource(resolveDesktopPetECliTool(session, project));
    candidates.push({
      sessionId: task.sessionId,
      source,
      agentLabel: resolveDesktopPetEAgentLabel(source),
      title: session?.title ?? task.cwd ?? task.sessionId,
      projectName: project?.name ?? null,
      workspanId: null,
      paneId: null,
      daemonOnly: true,
      sessionAlive: true,
      status: pendingAction ? "attention" : resolveDaemonTaskStatus(task),
      updatedAt: pendingAction ? now : resolveDaemonTaskUpdatedAt(task, now),
      active: false,
      pendingAction,
    });
  }

  return candidates;
}

export function mergeDesktopPetECandidatesWithHistory(
  previousTerminalStates: readonly DesktopPetETaskCandidate[],
  current: readonly DesktopPetETaskCandidate[],
  liveSessionIds: ReadonlySet<string>,
): DesktopPetETaskCandidate[] {
  const previousBySession = new Map(
    previousTerminalStates.map((candidate) => [candidate.sessionId, candidate]),
  );
  const effectiveCurrent = current.flatMap((candidate) => {
    if (candidate.pendingAction || candidate.status !== "attention") return [candidate];
    const previous = previousBySession.get(candidate.sessionId);
    if (!previous || previous.pendingAction || previous.status === "attention") return [];
    return [{
      ...candidate,
      status: previous.status,
      updatedAt: previous.updatedAt,
    }];
  });

  const retained = new Map<string, DesktopPetETaskCandidate>();
  for (const candidate of previousTerminalStates) {
    if (candidate.pendingAction || (candidate.status !== "done" && candidate.status !== "failed")) continue;
    retained.set(candidate.sessionId, {
      ...candidate,
      sessionAlive: liveSessionIds.has(candidate.sessionId),
    });
  }

  for (const candidate of effectiveCurrent) {
    retained.delete(candidate.sessionId);
    if (!candidate.pendingAction && (candidate.status === "done" || candidate.status === "failed")) {
      retained.set(candidate.sessionId, candidate);
    }
  }

  const currentSessionIds = new Set(effectiveCurrent.map((candidate) => candidate.sessionId));
  return [
    ...effectiveCurrent,
    ...[...retained.values()].filter((candidate) => !currentSessionIds.has(candidate.sessionId)),
  ];
}

export function desktopPetETaskId(
  sessionId: string,
  pendingActionId?: string | null,
  stateToken?: string | null,
): string {
  if (pendingActionId) return `${sessionId}:action:${pendingActionId}`;
  return `${sessionId}:state:${stateToken || "current"}`;
}

export function classifyDesktopPetETask(candidate: DesktopPetETaskCandidate): DesktopPetEColor | null {
  if (candidate.pendingAction) return "yellow";
  if (candidate.status === "failed") return "red";
  if (candidate.status === "running") return "green";
  if (candidate.status === "done") return "blue";
  return null;
}

function normalizeCandidate(
  candidate: DesktopPetETaskCandidate,
  generatedAt: number,
): DesktopPetETask | null {
  const sessionId = candidate.sessionId.trim();
  if (!sessionId) return null;
  const color = classifyDesktopPetETask(candidate);
  if (!color) return null;
  const source = candidate.source ?? "other";
  const updatedAt = normalizeTimestamp(candidate.updatedAt, generatedAt);
  const pendingActionId = candidate.pendingAction?.id ?? null;
  return {
    id: desktopPetETaskId(sessionId, pendingActionId, `${color}:${updatedAt}`),
    sessionId,
    source,
    agentLabel: normalizeText(candidate.agentLabel, SOURCE_LABELS[source], 40),
    title: normalizeText(candidate.title, sessionId, 160),
    projectName: candidate.projectName?.trim().slice(0, 160) || null,
    workspanId: candidate.workspanId?.trim().slice(0, 160) || null,
    paneId: candidate.paneId?.trim().slice(0, 160) || null,
    daemonOnly: candidate.daemonOnly === true,
    sessionAlive: candidate.sessionAlive !== false,
    color,
    updatedAt,
    viewedAt: null,
    pendingAction: candidate.pendingAction ?? null,
  };
}

export function countDesktopPetEColors(tasks: readonly DesktopPetETask[]): DesktopPetEColorCounts {
  const counts: DesktopPetEColorCounts = { green: 0, yellow: 0, red: 0, blue: 0 };
  for (const task of tasks) counts[task.color] += 1;
  return counts;
}

export function resolveDesktopPetEMood(counts: DesktopPetEColorCounts): DesktopPetEMood {
  const moods: DesktopPetEMood[] = ["yellow", "red", "green", "blue"];
  return moods.find((mood) => mood !== "idle" && counts[mood] > 0) ?? "idle";
}

function taskPriority(task: DesktopPetETask): number {
  return MOOD_PRIORITY[task.color];
}

export function sortDesktopPetETasks(tasks: readonly DesktopPetETask[]): DesktopPetETask[] {
  return [...tasks].sort((left, right) =>
    taskPriority(right) - taskPriority(left)
    || Number(Boolean(right.pendingAction)) - Number(Boolean(left.pendingAction))
    || right.updatedAt - left.updatedAt
    || left.sessionId.localeCompare(right.sessionId)
  );
}

export function resolveDesktopPetECliLabel(
  tasks: readonly DesktopPetETask[],
  activeSessionId?: string | null,
): DesktopPetECliLabel | null {
  if (tasks.length === 0) return null;
  const selected = tasks.find((task) => task.sessionId === activeSessionId) ?? sortDesktopPetETasks(tasks)[0];
  return {
    agentLabel: selected.agentLabel,
    color: selected.color,
    otherTaskCount: Math.max(0, tasks.length - 1),
  };
}

export function deriveDesktopPetESnapshot(
  input: DesktopPetEStateInput,
  activeSessionId?: string | null,
): DesktopPetESnapshot {
  const generatedAt = normalizeTimestamp(input.generatedAt ?? Date.now(), Date.now());
  const latestBySession = new Map<string, DesktopPetETask>();

  for (const candidate of input.candidates) {
    const task = normalizeCandidate(candidate, generatedAt);
    if (!task) continue;
    if (input.clearedTaskIds?.has(task.id)) continue;
    if ((task.color === "red" || task.color === "blue") && input.viewedTerminalTaskIds?.has(task.id)) {
      continue;
    }

    const existing = latestBySession.get(task.sessionId);
    const shouldReplace = !existing
      || (Boolean(task.pendingAction) && !existing.pendingAction)
      || task.updatedAt > existing.updatedAt
      || (task.updatedAt === existing.updatedAt && taskPriority(task) > taskPriority(existing));
    if (shouldReplace) latestBySession.set(task.sessionId, task);
  }

  const tasks = sortDesktopPetETasks([...latestBySession.values()]);
  const counts = countDesktopPetEColors(tasks);
  return {
    protocolVersion: DESKTOP_PET_E_PROTOCOL_VERSION,
    instanceId: input.instanceId,
    generation: Math.max(0, Math.trunc(input.generation)),
    revision: Math.max(0, Math.trunc(input.revision)),
    generatedAt,
    tasks,
    counts,
    mood: resolveDesktopPetEMood(counts),
    cliLabel: resolveDesktopPetECliLabel(tasks, activeSessionId),
    notification: input.notification ?? null,
    diagnostics: input.diagnostics ?? [],
  };
}

export function shouldAcceptDesktopPetESnapshot(
  current: Pick<DesktopPetESnapshot, "instanceId" | "generation" | "revision"> | null,
  next: Pick<DesktopPetESnapshot, "instanceId" | "generation" | "revision">,
): boolean {
  if (!current) return true;
  if (next.instanceId !== current.instanceId) return false;
  if (next.generation !== current.generation) return next.generation > current.generation;
  return next.revision > current.revision;
}
