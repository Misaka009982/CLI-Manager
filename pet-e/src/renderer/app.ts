import type {
  DesktopPetEChildAction,
  DesktopPetEColor,
  DesktopPetEConfigPayload,
  DesktopPetEMood,
  DesktopPetETask,
} from "../bridge/protocol.js";
import { createActionDraft, isDraftComplete, serializeAnswers, type ActionDraft } from "./agent-action.js";
import { canClearTask, canOpenTask, COLOR_ORDER, firstAvailableColor, tasksForColor } from "./task-state.js";

function requireAppRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("desktop_pet_e_root_missing");
  return root;
}

const app = requireAppRoot();
let config: DesktopPetEConfigPayload | null = null;
let snapshot: import("../bridge/protocol.js").DesktopPetESnapshot | null = null;
let expandedColor: DesktopPetEColor | null = null;
let activeTaskId: string | null = null;
let notificationTimer: number | null = null;
let mouseInteractive = false;
let lastMousePosition: { x: number; y: number } | null = null;
const drafts = new Map<string, ActionDraft>();
// 以稳定的 pendingAction.id 关联当前传输层 actionId。
const submitting = new Map<string, string>();
const submissionErrors = new Map<string, string>();
// 任务气泡展开后自动收起；指针停留在气泡上时暂停计时，避免正要点击任务时气泡消失。
const TASK_PANEL_AUTO_HIDE_MS = 5000;
let taskPanelTimer: number | null = null;
let autoHideColor: DesktopPetEColor | null = null;
let autoHidePaused = false;
// 重建 DOM 会重置滚动位置，问题组和任务列表的滚动偏移需要跨重建保留。
const SCROLL_CONTAINERS = [".questions", ".approval-options", ".task-list"] as const;
const INTERACTIVE_SURFACE_SELECTOR = ".task-panel, .action-panel, .lights, .pet-toolbar, .pet.missing";

function clearTaskPanelTimer(): void {
  if (taskPanelTimer === null) return;
  window.clearTimeout(taskPanelTimer);
  taskPanelTimer = null;
}

function restartTaskPanelTimer(): void {
  clearTaskPanelTimer();
  taskPanelTimer = window.setTimeout(() => {
    taskPanelTimer = null;
    if (!expandedColor || activeTaskId) return;
    expandedColor = null;
    render();
  }, TASK_PANEL_AUTO_HIDE_MS);
}

// 只在展开目标变化时重新计时，快照刷新不会无限延长气泡停留时间。
function syncTaskPanelAutoHide(): void {
  if (!expandedColor || activeTaskId) {
    autoHideColor = null;
    clearTaskPanelTimer();
    return;
  }
  if (autoHideColor === expandedColor) return;
  autoHideColor = expandedColor;
  if (!autoHidePaused) restartTaskPanelTimer();
}

function setAutoHidePaused(paused: boolean): void {
  if (autoHidePaused === paused) return;
  autoHidePaused = paused;
  if (paused) clearTaskPanelTimer();
  else if (expandedColor && !activeTaskId) restartTaskPanelTimer();
}

function captureScrollOffsets(): Map<string, number> {
  const offsets = new Map<string, number>();
  for (const selector of SCROLL_CONTAINERS) {
    const element = app.querySelector<HTMLElement>(selector);
    if (element && element.scrollTop > 0) offsets.set(selector, element.scrollTop);
  }
  return offsets;
}

function restoreScrollOffsets(offsets: Map<string, number>): void {
  for (const [selector, top] of offsets) {
    const element = app.querySelector<HTMLElement>(selector);
    if (element) element.scrollTop = top;
  }
}

function label(key: string): string {
  return config?.labels[key] ?? key;
}

function labelWithCount(key: string, count: number): string {
  return label(key).replace("{count}", String(count));
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}

function setMouseInteractive(interactive: boolean): void {
  if (mouseInteractive === interactive) return;
  mouseInteractive = interactive;
  window.desktopPetE.setMouseInteractive(interactive);
}

function isInteractiveSurface(target: Element | null): boolean {
  return Boolean(target?.closest(INTERACTIVE_SURFACE_SELECTOR));
}

function refreshMouseInteraction(): void {
  if (!lastMousePosition) return;
  const target = document.elementFromPoint(lastMousePosition.x, lastMousePosition.y);
  setMouseInteractive(isInteractiveSurface(target));
  setAutoHidePaused(Boolean(target?.closest(".task-panel")));
}

function actionId(): string {
  return crypto.randomUUID();
}

type PendingChildAction = DesktopPetEChildAction extends infer T
  ? T extends DesktopPetEChildAction
    ? Omit<T, "actionId" | "snapshotRevision">
    : never
  : never;

function send(action: PendingChildAction): string | null {
  if (!snapshot) return null;
  const id = actionId();
  window.desktopPetE.sendAction({
    ...action,
    actionId: id,
    snapshotRevision: snapshot.revision,
  } as DesktopPetEChildAction);
  return id;
}

// CSP 只允许 pet-e-app: 样式表，不放宽内联样式；有限的精灵行、帧数和行数
// 通过 styles.css 中的静态 class 表达，避免动态 style 属性被 CSP 拦截。
const MAX_SPRITE_ROW = 10;
const MAX_SPRITE_FRAMES = 8;

function moodLabelKey(mood: DesktopPetEMood): string {
  switch (mood) {
    case "green":
      return "desktopPetE.renderer.running";
    case "yellow":
      return "desktopPetE.renderer.actionNeeded";
    case "red":
      return "desktopPetE.renderer.failed";
    case "blue":
      return "desktopPetE.renderer.stopped";
    default:
      return "desktopPetE.renderer.noTasks";
  }
}

function moodAsset(mood: DesktopPetEMood): { row: number; frames: number } {
  const pet = config?.pet;
  const state = pet?.states[mood] ?? pet?.states.idle ?? { row: 0, frames: 1 };
  const maxRow = pet?.spriteVersionNumber === 2 ? MAX_SPRITE_ROW : 8;
  return {
    row: Math.min(maxRow, Math.max(0, Math.round(state.row))),
    frames: Math.min(MAX_SPRITE_FRAMES, Math.max(1, Math.round(state.frames))),
  };
}

function petMarkup(): string {
  const pet = config?.pet;
  if (!pet) {
    return `<button class="pet missing" data-command="settings" type="button">${escapeText(label("desktopPetE.renderer.selectPet"))}</button>`;
  }
  const state = moodAsset(snapshot?.mood ?? "idle");
  const rows = pet.spriteVersionNumber === 2 ? 11 : 9;
  const sheetClass = [
    "sprite-sheet",
    `sprite-row-${state.row}`,
    `sprite-rows-${rows}`,
    state.frames > 1 ? `sprite-frames-${state.frames} animated` : "sprite-frames-1",
  ].join(" ");
  return `<div class="pet" title="${escapeText(pet.displayName)}">
    <div class="sprite-viewport">
      <img class="${sheetClass}" src="${escapeText(pet.spritePath)}" alt="${escapeText(pet.displayName)}" draggable="false" />
    </div>
  </div>`;
}

function lightsMarkup(): string {
  if (!snapshot || config?.settings.showTaskArea === false) return "";
  return `<div class="lights" role="toolbar" aria-label="${escapeText(label("desktopPetE.renderer.taskStatus"))}">${COLOR_ORDER
    .filter((color) => snapshot && snapshot.counts[color] > 0)
    .map((color) => `<button type="button" class="light ${color}${expandedColor === color ? " active" : ""}" data-color="${color}" title="${escapeText(label(`desktopPetE.renderer.${color === "green" ? "running" : color === "yellow" ? "actionNeeded" : color === "red" ? "failed" : "stopped"}`))}"><span class="dot"></span><span class="count">${snapshot?.counts[color] ?? 0}</span></button>`)
    .join("")}</div>`;
}

function statusMarkup(): string {
  if (!snapshot || config?.settings.showStatusLabel !== true) return "";
  return `<div class="status-label ${snapshot.mood}">${escapeText(label(moodLabelKey(snapshot.mood)))}</div>`;
}

function cliLabelMarkup(): string {
  if (!snapshot?.cliLabel || config?.settings.showCliLabel === false) return "";
  const suffix = snapshot.cliLabel.otherTaskCount > 0
    ? ` · ${labelWithCount("desktopPetE.renderer.otherTasks", snapshot.cliLabel.otherTaskCount)}`
    : "";
  return `<div class="cli-label ${snapshot.cliLabel.color}">${escapeText(snapshot.cliLabel.agentLabel)}${escapeText(suffix)}</div>`;
}

function taskListMarkup(): string {
  if (config?.settings.showTaskArea === false || activeTaskId) return "";
  const tasks = tasksForColor(snapshot, expandedColor);
  if (!expandedColor) return "";
  const title = label(`desktopPetE.renderer.${expandedColor === "green" ? "running" : expandedColor === "yellow" ? "actionNeeded" : expandedColor === "red" ? "failed" : "stopped"}`);
  return `<section class="task-panel"><header><strong>${escapeText(title)}</strong><button type="button" data-command="collapse" aria-label="${escapeText(label("desktopPetE.renderer.collapse"))}">×</button></header>
    <div class="task-list">${tasks.length === 0
      ? `<p class="empty">${escapeText(label("desktopPetE.renderer.noTasks"))}</p>`
      : tasks.map(taskMarkup).join("")}</div></section>`;
}

function taskMarkup(task: DesktopPetETask): string {
  const ended = !task.sessionAlive ? `<span class="ended">${escapeText(label("desktopPetE.renderer.sessionEnded"))}</span>` : "";
  const interactive = config?.settings.agentInteractionEnabled !== false
    && task.pendingAction?.adapterMode === "interactive";
  const command = interactive
    ? "action"
    : canOpenTask(task) ? "open" : canClearTask(task) ? "clear" : "";
  const commandLabel = interactive
    ? label("desktopPetE.renderer.respond")
    : canOpenTask(task) ? label("desktopPetE.renderer.open") : canClearTask(task) ? label("desktopPetE.renderer.clear") : "";
  const actionDetails = [
    task.pendingAction?.message,
    task.pendingAction?.adapterReason ? label(task.pendingAction.adapterReason) : null,
  ].filter((value): value is string => Boolean(value));
  const actionDetail = actionDetails.join(" · ");
  return `<article class="task-row ${task.color}"><div class="task-copy"><strong>${escapeText(task.agentLabel)}</strong><span>${escapeText(task.title)}</span>${actionDetail ? `<small>${escapeText(actionDetail)}</small>` : ""}${ended}</div>${command ? `<button type="button" data-task="${escapeText(task.id)}" data-command="${command}">${escapeText(commandLabel)}</button>` : ""}</article>`;
}

function toolbarMarkup(): string {
  return `<div class="pet-toolbar"><button type="button" data-command="settings" title="${escapeText(label("openSettings"))}" aria-label="${escapeText(label("openSettings"))}">⚙</button><button type="button" data-command="close-pet" title="${escapeText(label("desktopPetE.renderer.close"))}" aria-label="${escapeText(label("desktopPetE.renderer.close"))}">×</button></div>`;
}

function notificationMarkup(): string {
  const notice = snapshot?.notification;
  if (!notice || config?.settings.notificationsEnabled === false || notice.expiresAt <= Date.now()) return "";
  return `<aside class="notification" role="status" aria-live="polite"><strong>${escapeText(notice.title)}</strong><span>${escapeText(notice.message)}</span></aside>`;
}

function actionPanelMarkup(): string {
  const task = snapshot?.tasks.find((candidate) => candidate.id === activeTaskId);
  const action = task?.pendingAction;
  if (!task || !action || action.adapterMode !== "interactive") return "";
  const draft = drafts.get(action.id) ?? createActionDraft(action);
  drafts.set(action.id, draft);
  const isSubmitting = action.submitting || submitting.has(action.id);
  const actionError = submissionErrors.get(action.id) ?? action.error;
  return `<section class="action-panel" data-action="${escapeText(action.id)}"><header><strong>${escapeText(action.title || task.agentLabel)}</strong><button type="button" data-command="close-action" aria-label="${escapeText(label("desktopPetE.renderer.close"))}">×</button></header>
    ${action.message ? `<p>${escapeText(action.message)}</p>` : ""}
    ${actionError ? `<p class="action-error">${escapeText(label(actionError))}</p>` : ""}
    ${action.kind === "approval" ? approvalMarkup(action, draft) : questionsMarkup(action, draft)}
    <footer><button type="button" data-command="open" data-task="${escapeText(task.id)}">${escapeText(label("desktopPetE.renderer.terminal"))}</button><button type="button" class="primary" data-command="submit" data-task="${escapeText(task.id)}" ${!isDraftComplete(action, draft) || isSubmitting ? "disabled" : ""}>${escapeText(isSubmitting ? label("desktopPetE.renderer.submitting") : actionError ? label("desktopPetE.renderer.retry") : label("desktopPetE.renderer.submit"))}</button></footer>
  </section>`;
}

function approvalMarkup(action: NonNullable<DesktopPetETask["pendingAction"]>, draft: ActionDraft): string {
  return `<div class="approval-options">${(action.approvalChoices ?? []).map((choice) => `<label class="choice${choice.destructive ? " destructive" : ""}"><input type="radio" name="approval" value="${escapeText(choice.value)}" ${draft.approvalValue === choice.value ? "checked" : ""}/><span>${escapeText(label(choice.label))}</span></label>`).join("")}</div>`;
}

function questionsMarkup(action: NonNullable<DesktopPetETask["pendingAction"]>, draft: ActionDraft): string {
  return `<div class="questions">${(action.questions ?? []).map((question, index) => {
    const values = draft.answers[question.id] ?? [];
    const optionType = question.mode === "multiple" ? "checkbox" : "radio";
    const optional = question.required === false ? `<small class="question-optional">${escapeText(label("desktopPetE.renderer.optional"))}</small>` : "";
    return `<fieldset data-question="${escapeText(question.id)}"><legend><span>${index + 1}</span>${escapeText(question.label || question.prompt)}${optional}</legend>${question.label ? `<p>${escapeText(question.prompt)}</p>` : ""}
      ${question.mode === "text" ? "" : question.options.map((option, optionIndex) => `<label class="choice"><input type="${optionType}" name="question-${escapeText(question.id)}" value="${escapeText(option.value)}" ${values.includes(option.value) ? "checked" : ""}/><span><strong>${optionIndex + 1}. ${escapeText(option.label)}</strong>${option.description ? `<small>${escapeText(option.description)}</small>` : ""}</span></label>`).join("")}
      ${question.mode === "text" || question.allowOther ? `<textarea data-custom="${escapeText(question.id)}" maxlength="16384" placeholder="${escapeText(label("desktopPetE.renderer.typeAnswer"))}">${escapeText(draft.customValues[question.id] ?? "")}</textarea>` : ""}
    </fieldset>`;
  }).join("")}</div>`;
}

function render(): void {
  if (!config) {
    autoHideColor = null;
    clearTaskPanelTimer();
    app.replaceChildren();
    setMouseInteractive(false);
    return;
  }
  const notification = notificationMarkup();
  const notificationClass = notification ? " notification-active" : "";
  const scrollOffsets = captureScrollOffsets();
  app.innerHTML = `${notification}<div class="pet-shell${notificationClass}">${petMarkup()}${toolbarMarkup()}${lightsMarkup()}${statusMarkup()}${cliLabelMarkup()}</div>${taskListMarkup()}${actionPanelMarkup()}`;
  restoreScrollOffsets(scrollOffsets);
  syncTaskPanelAutoHide();
  queueMicrotask(refreshMouseInteraction);
}

function updateDraftFromInput(target: HTMLInputElement | HTMLTextAreaElement): void {
  const task = snapshot?.tasks.find((candidate) => candidate.id === activeTaskId);
  const action = task?.pendingAction;
  if (!action) return;
  const draft = drafts.get(action.id) ?? createActionDraft(action);
  if (target instanceof HTMLTextAreaElement) {
    const questionId = target.dataset.custom;
    if (questionId) {
      draft.customValues[questionId] = target.value;
      const question = action.questions?.find((candidate) => candidate.id === questionId);
      if (question?.mode === "single" && target.value.trim()) {
        draft.answers[questionId] = [];
        target.closest("fieldset")?.querySelectorAll<HTMLInputElement>("input:checked")
          .forEach((input) => { input.checked = false; });
      }
    }
  } else if (target.name === "approval") {
    draft.approvalValue = target.value;
  } else {
    const fieldset = target.closest<HTMLElement>("[data-question]");
    const questionId = fieldset?.dataset.question;
    if (questionId) {
      const selected = [...fieldset.querySelectorAll<HTMLInputElement>("input:checked")].map((input) => input.value);
      draft.answers[questionId] = selected;
      const question = action.questions?.find((candidate) => candidate.id === questionId);
      if (question?.mode === "single" && selected.length > 0) {
        draft.customValues[questionId] = "";
        const custom = fieldset.querySelector<HTMLTextAreaElement>("textarea[data-custom]");
        if (custom) custom.value = "";
      }
    }
  }
  drafts.set(action.id, draft);
  // 选项与文本变更只做局部同步：重建 DOM 会让问题组滚动位置跳回顶部，导致无法继续选择。
  const submit = app.querySelector<HTMLButtonElement>('button[data-command="submit"]');
  if (submit) {
    submit.disabled = !isDraftComplete(action, draft)
      || action.submitting
      || submitting.has(action.id);
  }
}

app.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) updateDraftFromInput(target);
});
app.addEventListener("input", (event) => {
  if (event.target instanceof HTMLTextAreaElement) updateDraftFromInput(event.target);
});
document.addEventListener("mousemove", (event) => {
  lastMousePosition = { x: event.clientX, y: event.clientY };
  const target = document.elementFromPoint(event.clientX, event.clientY);
  setMouseInteractive(isInteractiveSurface(target));
  setAutoHidePaused(Boolean(target?.closest(".task-panel")));
});
document.documentElement.addEventListener("mouseleave", () => {
  lastMousePosition = null;
  setMouseInteractive(false);
  setAutoHidePaused(false);
});
app.addEventListener("pointerover", (event) => {
  if (
    !snapshot
    || !config
    || config.settings.openOnHover === false
    || config.settings.showTaskArea === false
  ) {
    return;
  }
  const target = event.target instanceof Element ? event.target : null;
  const hoveredColor = target?.closest<HTMLElement>("[data-color]")?.dataset.color as DesktopPetEColor | undefined;
  const nextColor = hoveredColor ?? (target?.closest(".pet-shell") ? firstAvailableColor(snapshot) : null);
  if (nextColor && nextColor !== expandedColor && snapshot.counts[nextColor] > 0) {
    expandedColor = nextColor;
    activeTaskId = null;
    render();
  }
});
app.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest<HTMLButtonElement>("button");
  if (!button) return;
  const color = button.dataset.color as DesktopPetEColor | undefined;
  if (color) {
    expandedColor = expandedColor === color ? null : color;
    activeTaskId = null;
    render();
    return;
  }
  const command = button.dataset.command;
  const taskId = button.dataset.task;
  if (command === "collapse") expandedColor = null;
  else if (command === "close-action") activeTaskId = null;
  else if (command === "settings") send({ kind: "open-settings" });
  else if (command === "close-pet") send({ kind: "close-pet" });
  else if (command === "action" && taskId) activeTaskId = taskId;
  else if (command === "open" && taskId) send({ kind: "open-task", taskId });
  else if (command === "clear" && taskId) send({ kind: "clear-task", taskId });
  else if (command === "submit" && taskId) {
    const task = snapshot?.tasks.find((candidate) => candidate.id === taskId);
    const action = task?.pendingAction;
    if (action) {
      const draft = drafts.get(action.id) ?? createActionDraft(action);
      const inFlightId = send({
        kind: "submit-action",
        taskId,
        pendingActionId: action.id,
        answers: serializeAnswers(action, draft),
        approvalValue: draft.approvalValue ?? undefined,
      });
      // submitting 使用稳定的 pendingAction.id，确认则按传输层 actionId 匹配；
      // 重试会生成新的传输 actionId，但业务动作 ID 保持不变。
      if (inFlightId) {
        submissionErrors.delete(action.id);
        submitting.set(action.id, inFlightId);
      }
    }
  }
  render();
});

window.desktopPetE.onConfig((next) => {
  config = next;
  document.documentElement.lang = next.language;
  mouseInteractive = false;
  app.classList.toggle("click-through", next.settings.clickThroughEnabled);
  app.classList.toggle("bubble-down", next.bubbleDirection === "down");
  if (!next.visible) setMouseInteractive(false);
  if (!next.settings.agentInteractionEnabled) activeTaskId = null;
  if (!next.settings.showTaskArea) {
    expandedColor = null;
    activeTaskId = null;
  }
  render();
});
window.desktopPetE.onSnapshot((next) => {
  const previousNotification = snapshot?.notification?.id;
  snapshot = next;
  if (activeTaskId && !next.tasks.some((task) => task.id === activeTaskId)) activeTaskId = null;
  if (expandedColor && next.counts[expandedColor] === 0) expandedColor = null;
  const liveActionIds = new Set(next.tasks.flatMap((task) => task.pendingAction ? [task.pendingAction.id] : []));
  for (const actionId of drafts.keys()) if (!liveActionIds.has(actionId)) drafts.delete(actionId);
  for (const actionId of submitting.keys()) if (!liveActionIds.has(actionId)) submitting.delete(actionId);
  for (const actionId of submissionErrors.keys()) if (!liveActionIds.has(actionId)) submissionErrors.delete(actionId);
  if (notificationTimer !== null) window.clearTimeout(notificationTimer);
  if (next.notification && next.notification.id !== previousNotification) {
    notificationTimer = window.setTimeout(render, Math.max(0, next.notification.expiresAt - Date.now()));
  }
  render();
});
window.desktopPetE.onActionResult((result) => {
  for (const [pendingActionId, inFlightId] of submitting) {
    if (inFlightId !== result.actionId) continue;
    if (result.confirmed) {
      submitting.delete(pendingActionId);
      submissionErrors.delete(pendingActionId);
    } else if (!result.accepted || result.error) {
      submitting.delete(pendingActionId);
      submissionErrors.set(
        pendingActionId,
        result.error || label("desktopPetE.renderer.actionFailed"),
      );
    }
    break;
  }
  render();
});

render();
window.desktopPetE.ready();
