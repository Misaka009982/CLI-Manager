import type { DesktopPetETerminalPrompt } from "./desktopPetE";

export const DESKTOP_PET_E_TERMINAL_PROMPT_TTL_MS = 30_000;
export const DESKTOP_PET_E_TERMINAL_PROMPT_MAX_SCOPES = 256;
const MAX_RETIRED_INSTANCES = 16;
const MAX_FUTURE_SKEW_MS = 5_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const encoder = new TextEncoder();

export interface DesktopPetEUiPromptReport {
  instanceId: string;
  id: string;
  sequence: number;
  active: boolean;
  kind: DesktopPetETerminalPrompt["kind"];
  title?: string | null;
}

interface PromptScope {
  instanceId: string | null;
  sequence: number;
  intervalId: string | null;
  lastSentAt: number;
  retiredInstances: readonly string[];
  closed: boolean;
  expiresAt: number;
  prompt: DesktopPetETerminalPrompt | null;
}

export interface DesktopPetETerminalPromptState {
  scopes: ReadonlyMap<string, PromptScope>;
  // daemon 重启或容量淘汰后的时间下界，旧缓存不能因游标被移除而复活。
  discardThrough: number;
}

// Tab 与 CLI 会话必须同时精确命中；JSON 元组避免分隔符造成身份碰撞。
export function desktopPetETerminalPromptScopeKey(tabId: string, sessionId: string): string {
  return JSON.stringify([tabId, sessionId]);
}

export function createDesktopPetETerminalPromptState(discardThrough = 0): DesktopPetETerminalPromptState {
  return { scopes: new Map(), discardThrough };
}

// 只接收普通对象，不把数组或空值作为 Hook 载荷。
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// 上游只需识别事件标签；完整载荷与区间字段仅由本外挂的 reducer 校验和消费。
export interface DesktopPetEUiPromptEvent {
  event: "DesktopPetEUiPrompt";
}

export function isDesktopPetEUiPromptEvent(value: unknown): value is DesktopPetEUiPromptEvent {
  return record(value)?.event === "DesktopPetEUiPrompt";
}

function validIdentity(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && encoder.encode(value).length <= maxBytes && !CONTROL_CHARACTERS.test(value);
}

// Rust 为入口校验；此处仍防御旧 daemon 缓存和异常广播，不做宽松字段转换。
function promptReport(value: unknown): DesktopPetEUiPromptReport | null {
  const raw = record(value);
  if (!raw || !validIdentity(raw.instanceId, 128) || !validIdentity(raw.id, 128)
    || !Number.isSafeInteger(raw.sequence) || (raw.sequence as number) <= 0
    || typeof raw.active !== "boolean"
    || typeof raw.kind !== "string"
    || !["select", "confirm", "input", "editor", "custom"].includes(raw.kind)
    || Object.keys(raw).some((key) => !["instanceId", "id", "sequence", "active", "kind", "title"].includes(key))
    || (raw.title != null && (typeof raw.title !== "string"
      || Array.from(raw.title).length > 512 || CONTROL_CHARACTERS.test(raw.title)))) return null;
  return raw as unknown as DesktopPetEUiPromptReport;
}

// 同一作用域续期移到末尾；溢出时保留时间下界，宁可等待新续报也不接回旧事件。
function replaceScope(
  state: DesktopPetETerminalPromptState,
  key: string,
  scope: PromptScope,
): DesktopPetETerminalPromptState {
  const scopes = new Map(state.scopes);
  scopes.delete(key);
  scopes.set(key, scope);
  let discardThrough = state.discardThrough;
  if (scopes.size > DESKTOP_PET_E_TERMINAL_PROMPT_MAX_SCOPES) {
    const oldest = scopes.entries().next().value;
    if (oldest) {
      discardThrough = Math.max(discardThrough, oldest[1].lastSentAt);
      scopes.delete(oldest[0]);
    }
  }
  return { scopes, discardThrough };
}

// 仅正式等待及精确生命周期能更新状态；普通工作心跳、通知和子任务不是结束证据。
export function reduceDesktopPetETerminalPrompt(
  state: DesktopPetETerminalPromptState,
  value: unknown,
  now: number,
): DesktopPetETerminalPromptState {
  const raw = record(value);
  if (!raw || raw.source !== "pi"
    || !["DesktopPetEUiPrompt", "SessionStart", "Stop", "Interrupt", "StopFailure"].includes(String(raw.event))
    || !validIdentity(raw.tabId, 128) || !validIdentity(raw.sessionId, 256)
    || (raw.environmentType != null && raw.environmentType !== "local" && raw.environmentType !== "wsl")
    || ["remoteHostId", "remoteProjectId", "remoteTranscriptRef", "remoteAgentTranscriptRef"]
      .some((key) => raw[key] != null)
    || typeof raw.timestamp !== "string" || raw.timestamp.length > 64) return state;
  const sentAt = Date.parse(raw.timestamp);
  if (!Number.isFinite(sentAt) || !Number.isFinite(now)
    || sentAt <= state.discardThrough || sentAt > now + MAX_FUTURE_SKEW_MS
    || sentAt + DESKTOP_PET_E_TERMINAL_PROMPT_TTL_MS <= now) return state;
  const key = desktopPetETerminalPromptScopeKey(raw.tabId, raw.sessionId);
  const current = state.scopes.get(key);
  if (current && sentAt <= current.lastSentAt) return state;

  if (raw.event !== "DesktopPetEUiPrompt") {
    if (raw.terminalPrompt != null || raw.agentId != null) return state;
    return replaceScope(state, key, {
      instanceId: current?.instanceId ?? null,
      sequence: current?.sequence ?? 0,
      intervalId: current?.intervalId ?? null,
      retiredInstances: current?.retiredInstances ?? [],
      lastSentAt: sentAt,
      closed: true,
      expiresAt: 0,
      prompt: null,
    });
  }

  const report = promptReport(raw.terminalPrompt);
  if (!report || !validIdentity(raw.remoteEventId, 128)
    || ["hookInput", "agentId", "toolUseId", "toolName", "goalId", "goalStatus", "title", "message"]
      .some((field) => raw[field] != null)
    || current?.retiredInstances.includes(report.instanceId)) return state;
  const sameInstance = current?.instanceId === report.instanceId;
  const sameInterval = sameInstance && current.intervalId === report.id;
  if (sameInstance && report.sequence <= current.sequence) return state;
  // 已结束区间不接受任何后续 active；旧区间的结束也不能清除正在显示的新区间。
  if (sameInterval && current.closed && report.active) return state;
  if (sameInstance && !sameInterval && !report.active && current.prompt && !current.closed) {
    return replaceScope(state, key, { ...current, sequence: report.sequence, lastSentAt: sentAt });
  }
  // 极端频繁 reload 时拒绝未知实例，不能通过淘汰退役实例放行旧进程。
  if (!sameInstance && current?.instanceId && current.retiredInstances.length >= MAX_RETIRED_INSTANCES) return state;
  const retiredInstances = !sameInstance && current?.instanceId
    ? [...current.retiredInstances, current.instanceId]
    : current?.retiredInstances ?? [];
  const prompt = report.active ? (sameInterval && current.prompt ? current.prompt : {
    // 长度前缀保持身份无歧义，也避免 JSON 转义把任务 ID 撑破提交协议上限。
    id: `${report.instanceId.length}:${report.instanceId}${report.id}`,
    kind: report.kind,
    title: report.title ?? null,
    startedAt: Math.min(sentAt, now),
  }) : null;
  return replaceScope(state, key, {
    instanceId: report.instanceId,
    sequence: report.sequence,
    intervalId: report.id,
    lastSentAt: sentAt,
    retiredInstances,
    closed: !report.active,
    expiresAt: report.active ? Math.min(sentAt, now) + DESKTOP_PET_E_TERMINAL_PROMPT_TTL_MS : 0,
    prompt,
  });
}

// 过期仅撤下显示，不删除结束/序号游标；有效的新续报可以恢复同一个未结束区间。
export function selectDesktopPetETerminalPrompts(
  state: DesktopPetETerminalPromptState,
  now: number,
): ReadonlyMap<string, DesktopPetETerminalPrompt> {
  const prompts = new Map<string, DesktopPetETerminalPrompt>();
  for (const [key, scope] of state.scopes) {
    if (!scope.closed && scope.prompt && scope.expiresAt > now) prompts.set(key, scope.prompt);
  }
  return prompts;
}

export function nextDesktopPetETerminalPromptExpiry(state: DesktopPetETerminalPromptState, now: number): number {
  let next = Number.POSITIVE_INFINITY;
  for (const scope of state.scopes.values()) {
    if (!scope.closed && scope.prompt && scope.expiresAt > now) next = Math.min(next, scope.expiresAt);
  }
  return next;
}

// 续报只续租，不替换相同的展示对象，避免快照 revision 和宠物输入焦点随心跳抖动。
export function sameDesktopPetETerminalPrompts(
  left: ReadonlyMap<string, DesktopPetETerminalPrompt>,
  right: ReadonlyMap<string, DesktopPetETerminalPrompt>,
): boolean {
  return left.size === right.size && [...left].every(([key, prompt]) => right.get(key) === prompt);
}
