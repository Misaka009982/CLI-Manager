"use strict";

const api = window.cliManagerPet;
const appRoot = document.getElementById("app");
const surface = new URLSearchParams(window.location.search).get("surface") === "hit"
  ? "hit"
  : "render";
const isHitSurface = surface === "hit";
document.documentElement.dataset.surface = surface;
document.body.dataset.surface = surface;

let state = null;
let completionTimer = null;
let hoverOpenTimer = null;
let hoverCloseTimer = null;
let dragActive = false;
let dragMoved = false;
let dragStartPoint = null;
let dragFrame = null;
let lastEmptyIdentity = null;
let lastFocusedStatusKey = null;
let failedPetUrl = null;
const customDrafts = Object.create(null);

const ICON_PATHS = {
  app: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M9 21V9"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  hide: '<path d="m2 2 20 20M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A9.8 9.8 0 0 1 12 4c5 0 9.3 3.1 11 8a11.6 11.6 0 0 1-2 3.6M6.6 6.6A11.8 11.8 0 0 0 1 12c1.7 4.9 6 8 11 8 1.8 0 3.5-.4 5-1.1"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  pause: '<circle cx="12" cy="12" r="10"/><path d="M10 9v6M14 9v6"/>',
  radio: '<path d="M4.9 19.1a10 10 0 0 1 0-14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M19.1 4.9a10 10 0 0 1 0 14.2"/><circle cx="12" cy="12" r="2"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  settings: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.2a2 2 0 0 1-2 0l-.1-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.1.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.7l-.1.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.1-.1a2 2 0 0 1 2 0l.4.2a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.2a2 2 0 0 1 2 0l.1.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.1-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.7l.1-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.1.1a2 2 0 0 1-2 0l-.4-.2a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
  size: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
};

function icon(name, size = 14) {
  const paths = ICON_PATHS[name] || ICON_PATHS.app;
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function label(name, fallback) {
  return text(state?.config?.labels?.[name], fallback);
}

function localized(value) {
  if (!value || typeof value !== "object") return "";
  return state?.config?.language === "en-US"
    ? text(value["en-US"], text(value["zh-CN"]))
    : text(value["zh-CN"], text(value["en-US"]));
}

function moodLabel(mood) {
  return label(mood, {
    idle: "Idle",
    working: "Working",
    waiting: "Waiting",
    success: "Done",
    error: "Error",
    sleeping: "Sleeping",
  }[mood] || mood);
}

function platformLabel(platform) {
  return label({
    telegram: "platformTelegram",
    feishu: "platformFeishu",
    weixin: "platformWeixin",
    wecom: "platformWecom",
  }[platform], platform);
}

function platformStatus(target) {
  if (target.ready) return label("platformReady", "Ready");
  return label({
    cc_connect_not_running: "platformNotRunning",
    handoff_credentials_missing: "platformCredentialsMissing",
    handoff_platform_user_missing: "platformUserMissing",
    handoff_platform_session_missing: "platformSessionMissing",
  }[target.unavailableReason] || "platformUnavailable", "Unavailable");
}

function statusColor(target) {
  if (target.status === "running") return "green";
  if (target.status === "failed") return "red";
  if (target.status === "attention" || target.status === "done") return "blue";
  return null;
}

function targetStatus(target, handoffMode) {
  if (handoffMode) {
    if (target.handoffEligible) return label("handoffReady", "Ready");
    if (target.handoffRecoverable) return label("handoffResolveRemoteSession", "Resolve remote session");
    if (target.handoffReason === "task_running") return label("handoffTaskRunning", "Task running");
    if (target.handoffReason === "task_state_unknown") return label("handoffStateUnknown", "Unknown state");
    return label("handoffUnavailable", "Unavailable");
  }
  if (target.handoffPhase === "pending") return label("handoffPending", "Pending");
  if (target.handoffPhase === "cancelling") return label("handoffCancelling", "Cancelling");
  if (target.handoffPhase === "recovery_failed") return label("handoffRecoveryFailed", "Recovery failed");
  if (target.handedOff) return label("handedOff", "Handed off");
  return label({
    running: "working",
    attention: "waiting",
    done: "success",
    failed: "error",
  }[target.status] || "idle", target.status || "idle");
}

function distinctLabels(target) {
  const result = [];
  for (const value of [target.projectName, target.sessionTitle]) {
    const normalized = text(value);
    if (normalized && !result.some((item) => item.toLowerCase() === normalized.toLowerCase())) {
      result.push(normalized);
    }
  }
  return result;
}

function sortedDecisions() {
  const priority = { permission: 0, questionnaire: 1, question: 2 };
  return [...(state?.snapshot?.decisionRequests || [])].sort((left, right) => (
    (priority[left.kind] ?? 3) - (priority[right.kind] ?? 3)
    || (left.createdAt || 0) - (right.createdAt || 0)
  ));
}

function sortedIncidents() {
  return [...(state?.snapshot?.incidents || [])].sort(
    (left, right) => (right.createdAt || 0) - (left.createdAt || 0)
  );
}

function decisionKey(request) {
  return `${request.requestId}:${request.brokerEpoch}`;
}

function decisionUi(request) {
  return state?.ui?.decisionUi?.[decisionKey(request)] || {
    answers: {},
    submitting: false,
    failed: false,
  };
}

function renderBuiltInPet() {
  return `<svg class="pet-cat" viewBox="0 0 48 34" role="img" aria-label="${escapeHtml(moodLabel(state.snapshot.mood))}">
    <g class="pet-cat-run">
      <path class="pet-cat-tail" d="M37 18c6-1 7-8 2-10" />
      <path class="pet-cat-body" d="M13 14h19c4 0 7 3 7 7v1c0 3-3 5-6 5H14c-4 0-7-3-7-7s3-6 6-6Z" />
      <path class="pet-cat-head" d="M10 9 14 3l4 6h7l4-6 4 6v11H10V9Z" />
      <circle class="pet-cat-eye" cx="17" cy="13" r="1.3" />
      <circle class="pet-cat-eye" cx="26" cy="13" r="1.3" />
      <path class="pet-cat-leg pet-cat-leg-a" d="M16 27v5" />
      <path class="pet-cat-leg pet-cat-leg-b" d="M29 27v5" />
    </g>
  </svg>`;
}

function renderInstalledPet() {
  const pet = state.pet?.manifest;
  const mood = state.snapshot.mood || "idle";
  const asset = pet?.states?.[mood] || pet?.states?.idle;
  if (!pet || !asset || asset.url === failedPetUrl) return renderBuiltInPet();
  const alt = localized(pet.name) || moodLabel(mood);
  if (pet.engine !== "codex-sprite") {
    return `<span class="pet-artwork"><img data-pet-image src="${escapeHtml(asset.url)}" alt="${escapeHtml(alt)}" draggable="false" /></span>`;
  }
  const rows = pet.spriteVersionNumber === 2 ? 11 : 9;
  const row = Math.max(0, Math.min(rows - 1, Number(asset.row) || 0));
  const frames = Math.max(1, Math.min(8, Number(asset.frames) || 1));
  return `<span class="pet-artwork pet-sprite" role="img" aria-label="${escapeHtml(alt)}" style="--sprite-top:${-row * 100}%;--sprite-height:${rows * 100}%;--sprite-shift:${-frames * 12.5}%;--sprite-frames:${frames};--sprite-duration:${Math.max(1400, frames * 260)}ms">
    <img data-pet-image src="${escapeHtml(asset.url)}" alt="" draggable="false" />
  </span>`;
}

function renderStatusRail() {
  if (!state.config.settings.showStatus) return "";
  const colors = ["green", "red", "blue"].filter(
    (color) => Number(state.snapshot.statusCounts?.[color]) > 0
  );
  if (colors.length === 0) return "";
  return `<nav class="status-rail" aria-label="${escapeHtml(label("taskList", "Tasks"))}">
    ${colors.map((color) => {
      const count = Number(state.snapshot.statusCounts[color]) || 0;
      const title = color === "green"
        ? label("working", "Working")
        : color === "red"
          ? label("error", "Error")
          : label("waiting", "Waiting");
      return `<button type="button" data-hit data-command="status" data-color="${color}" title="${escapeHtml(`${title}: ${count}`)}">${count}</button>`;
    }).join("")}
  </nav>`;
}

function renderPet() {
  const mood = state.snapshot.mood || "sleeping";
  const attention = Number(state.snapshot.attentionCount) || 0;
  return `<section class="pet-anchor" data-mood="${escapeHtml(mood)}">
    ${renderStatusRail()}
    <div class="pet-stage" data-hit data-command="pet-stage" title="${escapeHtml(moodLabel(mood))}">
      ${renderInstalledPet()}
      ${attention > 0 ? `<span class="attention-badge">${Math.min(99, attention)}</span>` : ""}
    </div>
  </section>`;
}

function renderDecisionCard(request, requestIndex) {
  const ui = decisionUi(request);
  const cardTitle = text(request.title);
  const defaultTitle = {
    permission: "Pi permission",
    question: "Pi question",
    questionnaire: "Pi questionnaire",
  }[request.kind];
  const visibleTitle = cardTitle && cardTitle !== defaultTitle ? cardTitle : "";
  const prompts = (request.questions || []).map((question) => text(question.prompt)).join("\n\n");
  const message = text(request.message);
  const visibleMessage = message && message !== prompts ? message : "";
  const kind = label({
    permission: "permissionRequest",
    questionnaire: "questionnaireRequest",
    question: "questionRequest",
  }[request.kind], request.kind);
  const questions = Array.isArray(request.questions) ? request.questions : [];
  return `<article class="bubble-card decision-card" data-hit data-card-id="decision:${escapeHtml(decisionKey(request))}" data-hovered="${state.ui.hoveredId === `decision:${decisionKey(request)}`}">
    <header><span>${escapeHtml(kind)}</span>${visibleTitle ? `<strong>${escapeHtml(visibleTitle)}</strong>` : ""}</header>
    ${visibleMessage ? `<p class="card-message">${escapeHtml(visibleMessage)}</p>` : ""}
    ${ui.failed ? `<p class="decision-error" role="alert">${escapeHtml(label("decisionSubmitFailed", "Submit failed"))}</p>` : ""}
    <div class="decision-questions">
      ${questions.map((question, questionIndex) => {
        const selected = ui.answers?.[question.id];
        return `<fieldset>
          <legend>${question.label ? `<small>${escapeHtml(question.label)}</small>` : ""}<span>${escapeHtml(question.prompt)}</span></legend>
          <div class="decision-options">
            ${(question.options || []).map((option, optionIndex) => `<button
              type="button"
              data-command="decision-option"
              data-request-index="${requestIndex}"
              data-question-index="${questionIndex}"
              data-option-index="${optionIndex}"
              data-selected="${Boolean(selected && !selected.wasCustom && selected.value === option.value)}"
              ${ui.submitting ? "disabled" : ""}
            ><strong>${escapeHtml(option.label)}</strong>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}</button>`).join("")}
          </div>
          ${question.allowOther ? `<div class="decision-custom">
            <input
              type="text"
              maxlength="4000"
              data-custom-input
              data-request-index="${requestIndex}"
              data-question-index="${questionIndex}"
              placeholder="${escapeHtml(label("customAnswer", "Other"))}"
              value="${escapeHtml(customDrafts[`${decisionKey(request)}:${question.id}`] || "")}"
              ${ui.submitting ? "disabled" : ""}
            />
            <button type="button" data-command="decision-custom" data-request-index="${requestIndex}" data-question-index="${questionIndex}" ${ui.submitting ? "disabled" : ""}>${icon("send", 12)}<span>${escapeHtml(label("sendAnswer", "Send"))}</span></button>
          </div>` : ""}
        </fieldset>`;
      }).join("")}
    </div>
    ${questions.length > 1 ? `<button type="button" class="decision-submit" data-command="decision-submit" data-request-index="${requestIndex}" ${ui.submitting || Object.keys(ui.answers || {}).length !== questions.length ? "disabled" : ""}>${icon("send", 12)}<span>${escapeHtml(label("submit", "Submit"))}</span></button>` : ""}
  </article>`;
}

function renderIncidentCard(incident, index) {
  const cardId = `incident:${incident.id}`;
  return `<article class="bubble-card incident-card" data-hit data-card-id="${escapeHtml(cardId)}" data-hovered="${state.ui.hoveredId === cardId}">
    <header><span>${escapeHtml(label("error", "Error"))}</span><strong>${escapeHtml(incident.title)}</strong></header>
    ${incident.message ? `<p class="card-message">${escapeHtml(incident.message)}</p>` : ""}
    <div class="card-actions">
      <button type="button" data-command="incident-open" data-index="${index}">${icon("external", 12)}<span>${escapeHtml(label("openCurrent", "Open"))}</span></button>
      <button type="button" data-command="incident-ack" data-index="${index}">${icon("check", 12)}<span>${escapeHtml(label("acknowledge", "Acknowledge"))}</span></button>
    </div>
  </article>`;
}

function renderCompletionCard(completion) {
  const title = text(completion.sessionTitle, text(completion.projectName, label("success", "Done")));
  const cardId = `completion:${completion.id}`;
  return `<article class="bubble-card completion-card" data-hit data-card-id="${escapeHtml(cardId)}" data-hovered="${state.ui.hoveredId === cardId}">
    <header><span>${escapeHtml(label("success", "Done"))}</span><strong>${escapeHtml(title)}</strong></header>
    ${completion.message ? `<p class="card-message">${escapeHtml(completion.message)}</p>` : ""}
    <div class="card-actions"><button type="button" data-command="completion-open">${icon("external", 12)}<span>${escapeHtml(label("openCurrent", "Open"))}</span></button></div>
  </article>`;
}

function renderBubble() {
  if (!state.config.bubbleVisible) return "";
  const decisions = sortedDecisions();
  const incidents = sortedIncidents();
  const completion = state.completion;
  if (decisions.length === 0 && incidents.length === 0 && !completion) return "";
  return `<section class="bubble-stack" aria-label="${escapeHtml(label("taskList", "Tasks"))}">
    ${decisions.map(renderDecisionCard).join("")}
    ${incidents.map(renderIncidentCard).join("")}
    ${completion ? renderCompletionCard(completion) : ""}
  </section>`;
}

function renderTarget(target, index, handoffMode) {
  const names = distinctLabels(target);
  const primary = names[0] || `${label("unnamedTask", "Task")} ${index + 1}`;
  const secondary = names[1] || "";
  const disabled = handoffMode && !target.handoffEligible && !target.handoffRecoverable;
  return `<button
    type="button"
    class="target-card"
    data-hit
    data-command="${handoffMode ? "handoff-target" : "open-target"}"
    data-index="${index}"
    data-status="${escapeHtml(target.status)}"
    data-active="${Boolean(target.active)}"
    data-handed-off="${Boolean(target.handedOff)}"
    ${disabled ? "disabled" : ""}
  >
    ${target.handoffPhase ? icon("lock", 13) : '<span class="target-dot"></span>'}
    <span class="target-copy"><strong>${escapeHtml(primary)}</strong><small>${secondary ? `${escapeHtml(secondary)} · ` : ""}${escapeHtml(targetStatus(target, handoffMode))}</small>${target.message ? `<span class="target-message">${escapeHtml(target.message)}</span>` : ""}</span>
    ${target.active ? `<span class="current-pill">${escapeHtml(label("currentTask", "Current"))}</span>` : ""}
  </button>`;
}

function renderMenuSecondary() {
  const mode = state.ui.targetMode;
  const platforms = (state.snapshot.handoffPlatforms || []).filter((item) => item.enabled);
  if (mode === "platforms") {
    return `<section class="secondary-list">
      <header class="secondary-header"><button type="button" data-hit data-command="menu-back-open" title="${escapeHtml(label("handoffBack", "Back"))}">${icon("back")}</button><strong>${escapeHtml(label("handoffPlatforms", "Platforms"))}</strong></header>
      ${platforms.map((target, index) => `<button type="button" class="platform-card" data-hit data-command="platform" data-index="${index}" data-ready="${Boolean(target.ready)}" ${target.ready ? "" : "disabled"}>${icon("radio", 14)}<span><strong>${escapeHtml(platformLabel(target.platform))}</strong><small>${escapeHtml(platformStatus(target))}</small></span><i></i></button>`).join("")}
    </section>`;
  }
  let targets = state.snapshot.targets || [];
  if (mode === "handoff") {
    targets = targets.filter((target) => target.handoffCandidate);
  } else if (state.ui.statusFilter) {
    targets = targets.filter((target) => statusColor(target) === state.ui.statusFilter);
  }
  if (targets.length === 0) return "";
  return `<section class="secondary-list">
    ${mode === "handoff" ? `<header class="secondary-header"><button type="button" data-hit data-command="menu-back-platforms" title="${escapeHtml(label("handoffBack", "Back"))}">${icon("back")}</button><strong>${escapeHtml(state.ui.selectedPlatform ? platformLabel(state.ui.selectedPlatform) : label("handoffSessions", "Sessions"))}</strong></header>` : ""}
    ${targets.map((target, index) => renderTarget(target, index, mode === "handoff")).join("")}
  </section>`;
}

function renderMenu() {
  if (!state.ui.menuOpen) return "";
  const platforms = (state.snapshot.handoffPlatforms || []).filter((item) => item.enabled);
  const handoffDisabled = Boolean(
    state.snapshot.handoffBusy
      || state.snapshot.handoff
      || !(state.snapshot.targets || []).some((target) => target.handoffCandidate)
      || platforms.length === 0
  );
  const size = state.ui.previewSize ?? state.config.settings.size;
  return `<section class="pet-menu" role="menu" aria-label="${escapeHtml(label("taskList", "Tasks"))}">
    ${renderMenuSecondary()}
    ${state.config.settings.showActionMenu ? `<nav class="menu-actions" data-hit>
      <button type="button" data-command="open-current" ${state.snapshot.sessionId ? "" : "disabled"}>${icon("external")}<span>${escapeHtml(label("openCurrent", "Open current"))}</span></button>
      <button type="button" data-command="handoff-menu" data-active="${state.ui.targetMode !== "open"}" ${handoffDisabled ? "disabled" : ""}>${icon("radio")}<span>${escapeHtml(label("remoteHandoff", "Remote handoff"))}</span></button>
      ${state.snapshot.handoff ? `<button type="button" class="danger" data-command="handoff-cancel" ${state.snapshot.handoffBusy ? "disabled" : ""}>${icon("pause")}<span>${escapeHtml(label("cancelHandoff", "Cancel handoff"))}</span></button>` : ""}
      <button type="button" data-command="open-main">${icon("app")}<span>${escapeHtml(label("openMain", "Open CLI-Manager"))}</span></button>
      <div class="size-control" data-hit>
        <label for="pet-size">${icon("size", 13)}<span>${escapeHtml(label("size", "Size"))}</span><output>${escapeHtml(size)}%</output></label>
        <input id="pet-size" type="range" min="40" max="150" step="5" value="${escapeHtml(size)}" />
      </div>
      <button type="button" data-command="open-settings">${icon("settings")}<span>${escapeHtml(label("openSettings", "Settings"))}</span></button>
      <button type="button" class="danger" data-command="hide" ${hasAlertContent() ? "disabled" : ""}>${icon("hide")}<span>${escapeHtml(label("hide", "Hide"))}</span></button>
    </nav>` : ""}
  </section>`;
}

function hasAlertContent() {
  return sortedDecisions().length > 0 || sortedIncidents().length > 0;
}

function render() {
  if (!state || !state.config || !state.snapshot || !state.layout) {
    appRoot.innerHTML = "";
    reportShape();
    return;
  }
  const layout = state.layout;
  const scale = layout.petSize.scale;
  const rootStyle = [
    `--pet-x:${layout.petRect.x}px`,
    `--pet-y:${layout.petRect.y}px`,
    `--pet-width:${layout.petRect.width}px`,
    `--pet-height:${layout.petRect.height}px`,
    `--pet-scale:${scale}`,
    `--pet-cat-width:${132 * scale}px`,
    `--pet-cat-height:${96 * scale}px`,
    `--pet-cat-bottom:${19 * scale}px`,
    `--pet-artwork-size:${144 * scale}px`,
    `--pet-artwork-bottom:${8 * scale}px`,
    `--attention-top:${21 * scale}px`,
    `--attention-right:${17 * scale}px`,
    `--status-right:${13 * scale}px`,
    `--status-bottom:${31 * scale}px`,
    `--success-jump:${-18 * scale}px`,
    `--work-bounce:${-Math.max(0, Number(state.config.settings.workingBounceDistancePx) || 0) * scale}px`,
    layout.panelRect ? `--panel-x:${layout.panelRect.x}px` : "--panel-x:0px",
    layout.panelRect ? `--panel-width:${layout.panelRect.width}px` : "--panel-width:0px",
  ].join(";");
  const panel = renderBubble() + renderMenu();
  appRoot.innerHTML = `<div
    class="desktop-pet"
    data-surface="${surface}"
    data-mood="${escapeHtml(state.snapshot.mood || "sleeping")}"
    data-side="${escapeHtml(layout.expansionSide)}"
    data-menu-open="${Boolean(state.ui.menuOpen)}"
    data-work-bounce="${Boolean(state.config.settings.workingBounceEnabled && Number(state.config.settings.workingBounceDistancePx) > 0)}"
    style="${rootStyle}"
  >
    ${renderPet()}
    ${panel ? `<aside class="surface-panel">${panel}</aside>` : ""}
  </div>`;
  bindRange();
  focusStatusCard();
  scheduleCompletion();
  reportEmptyBubble();
  reportShape();
}

function focusStatusCard() {
  if (!isHitSurface || !state.ui.menuOpen || !state.ui.statusFilter) {
    lastFocusedStatusKey = null;
    return;
  }
  const key = `${state.generation.lifecycleToken}:${state.ui.statusFilter}`;
  if (key === lastFocusedStatusKey) return;
  lastFocusedStatusKey = key;
  const selector = state.ui.statusFilter === "red"
    ? ".incident-card"
    : state.ui.statusFilter === "blue"
      ? ".decision-card, .completion-card"
      : null;
  if (!selector) return;
  window.requestAnimationFrame(() => {
    appRoot.querySelector(selector)?.scrollIntoView({ block: "nearest" });
  });
}

function reportShape() {
  if (!isHitSurface) return;
  window.requestAnimationFrame(() => {
    const hitElements = [...document.querySelectorAll("[data-hit]")]
      .filter((element) => {
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const scrollContainer = element.closest(".bubble-stack, .secondary-list");
        const clip = scrollContainer?.getBoundingClientRect();
        const left = clip ? Math.max(rect.left - 2, clip.left) : rect.left - 2;
        const top = clip ? Math.max(rect.top - 2, clip.top) : rect.top - 2;
        const right = clip ? Math.min(rect.right + 2, clip.right) : rect.right + 2;
        const bottom = clip ? Math.min(rect.bottom + 2, clip.bottom) : rect.bottom + 2;
        if (right <= left || bottom <= top) return null;
        return {
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
        };
      })
      .filter(Boolean);
    const scrollbars = [...document.querySelectorAll(".bubble-stack, .secondary-list")]
      .filter((element) => element.scrollHeight > element.clientHeight)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.right - 9,
          y: rect.top,
          width: 9,
          height: rect.height,
        };
      });
    api.reportShape([...hitElements, ...scrollbars]);
  });
}

function patchUi(patch) {
  if (!isHitSurface || !state) return;
  state.ui = { ...state.ui, ...patch };
  api.patchUi(patch);
}

function patchDecision(request, next) {
  const all = { ...(state.ui.decisionUi || {}) };
  all[decisionKey(request)] = next;
  state.ui.decisionUi = all;
  api.patchUi({ decisionUi: all });
  render();
}

function sendAction(action) {
  if (isHitSurface) api.sendAction(action);
}

function resolveDecision(request, answers) {
  const questions = Array.isArray(request.questions) ? request.questions : [];
  if (questions.some((question) => !answers[question.id])) return;
  const next = {
    answers,
    submitting: true,
    failed: false,
  };
  patchDecision(request, next);
  sendAction({
    type: "decisionResolve",
    surface: "bubble",
    requestId: request.requestId,
    brokerEpoch: request.brokerEpoch,
    answer: {
      answers: questions.map((question) => ({
        questionId: question.id,
        value: answers[question.id].value,
        wasCustom: Boolean(answers[question.id].wasCustom),
      })),
    },
  });
}

function selectDecisionAnswer(requestIndex, questionIndex, value, wasCustom) {
  const request = sortedDecisions()[requestIndex];
  const question = request?.questions?.[questionIndex];
  const normalized = wasCustom ? text(value) : value;
  if (!request || !question || typeof normalized !== "string" || !normalized.trim()) return;
  const current = decisionUi(request);
  const answers = {
    ...(current.answers || {}),
    [question.id]: { value: normalized, wasCustom },
  };
  if (request.questions.length === 1) {
    resolveDecision(request, answers);
  } else {
    patchDecision(request, { ...current, answers, failed: false });
  }
}

function targetForCommand(command, index) {
  let targets = state.snapshot.targets || [];
  if (command === "handoff-target") {
    targets = targets.filter((target) => target.handoffCandidate);
  } else if (state.ui.statusFilter) {
    targets = targets.filter((target) => statusColor(target) === state.ui.statusFilter);
  }
  return targets[index] || null;
}

function closeMenu() {
  patchUi({
    menuOpen: false,
    targetMode: "open",
    selectedPlatform: null,
    statusFilter: null,
  });
}

function handleCommand(element) {
  const command = element.dataset.command;
  const index = Number(element.dataset.index);
  if (command === "status") {
    patchUi({
      menuOpen: true,
      statusFilter: element.dataset.color,
      targetMode: "open",
      selectedPlatform: null,
    });
    return;
  }
  if (command === "open-target" || command === "handoff-target") {
    const target = targetForCommand(command, index);
    if (!target) return;
    if (command === "handoff-target") {
      if (!state.ui.selectedPlatform) return;
      sendAction({
        type: "handoffStart",
        sessionId: target.sessionId,
        platform: state.ui.selectedPlatform,
      });
    } else {
      sendAction({
        type: "openTarget",
        sessionId: target.sessionId,
        daemonOnly: Boolean(target.daemonOnly),
      });
    }
    closeMenu();
    return;
  }
  if (command === "platform") {
    const platforms = (state.snapshot.handoffPlatforms || []).filter((item) => item.enabled);
    const platform = platforms[index];
    if (platform?.ready) {
      patchUi({ targetMode: "handoff", selectedPlatform: platform.platform });
    }
    return;
  }
  if (command === "menu-back-open") {
    patchUi({ targetMode: "open", selectedPlatform: null });
    return;
  }
  if (command === "menu-back-platforms") {
    patchUi({ targetMode: "platforms", selectedPlatform: null });
    return;
  }
  if (command === "open-current") {
    sendAction({
      type: "openTarget",
      sessionId: state.snapshot.sessionId,
      daemonOnly: Boolean(state.snapshot.daemonOnly),
    });
    closeMenu();
    return;
  }
  if (command === "handoff-menu") {
    patchUi({
      targetMode: state.ui.targetMode === "open" ? "platforms" : "open",
      selectedPlatform: null,
    });
    return;
  }
  if (command === "handoff-cancel") {
    sendAction({ type: "handoffCancel" });
    closeMenu();
    return;
  }
  if (command === "open-main") {
    sendAction({ type: "openTarget", sessionId: null, daemonOnly: false });
    closeMenu();
    return;
  }
  if (command === "open-settings") {
    sendAction({ type: "openSettings" });
    closeMenu();
    return;
  }
  if (command === "hide") {
    sendAction({ type: "hide" });
    closeMenu();
    return;
  }
  if (command === "incident-open") {
    const incident = sortedIncidents()[index];
    if (incident) {
      sendAction({
        type: "openTarget",
        surface: "bubble",
        sessionId: incident.tabId || incident.sessionId,
        daemonOnly: Boolean(incident.daemonOnly),
      });
    }
    return;
  }
  if (command === "incident-ack") {
    const incident = sortedIncidents()[index];
    if (incident) {
      sendAction({
        type: "incidentAcknowledge",
        surface: "bubble",
        incidentId: incident.id,
      });
    }
    return;
  }
  if (command === "completion-open" && state.completion) {
    sendAction({
      type: "openTarget",
      surface: "bubble",
      sessionId: state.completion.sessionId,
      daemonOnly: Boolean(state.completion.daemonOnly),
    });
    return;
  }
  if (command === "decision-option") {
    const requestIndex = Number(element.dataset.requestIndex);
    const questionIndex = Number(element.dataset.questionIndex);
    const optionIndex = Number(element.dataset.optionIndex);
    const option = sortedDecisions()[requestIndex]?.questions?.[questionIndex]?.options?.[optionIndex];
    if (option) selectDecisionAnswer(requestIndex, questionIndex, option.value, false);
    return;
  }
  if (command === "decision-custom") {
    const requestIndex = Number(element.dataset.requestIndex);
    const questionIndex = Number(element.dataset.questionIndex);
    const input = appRoot.querySelector(
      `[data-custom-input][data-request-index="${requestIndex}"][data-question-index="${questionIndex}"]`
    );
    selectDecisionAnswer(requestIndex, questionIndex, input?.value || "", true);
    return;
  }
  if (command === "decision-submit") {
    const request = sortedDecisions()[Number(element.dataset.requestIndex)];
    if (request) resolveDecision(request, decisionUi(request).answers || {});
  }
}

function bindRange() {
  if (!isHitSurface) return;
  const range = document.getElementById("pet-size");
  if (!range) return;
  range.addEventListener("input", () => {
    const value = Number(range.value);
    const output = range.closest(".size-control")?.querySelector("output");
    if (output) output.textContent = `${value}%`;
    api.previewSize(value);
  });
  range.addEventListener("change", () => api.commitSize(Number(range.value)));
}

function scheduleCompletion() {
  if (completionTimer) {
    window.clearTimeout(completionTimer);
    completionTimer = null;
  }
  if (!isHitSurface || !state?.completion || state.completionTimer?.paused) return;
  const delay = Math.max(0, Number(state.completionTimer?.expiresAt) - Date.now());
  completionTimer = window.setTimeout(() => {
    completionTimer = null;
    const completionId = state?.completion?.id;
    if (!completionId) return;
    patchUi({ dismissedCompletionId: completionId });
    sendAction({ type: "bubbleDismiss", surface: "bubble", completionId });
  }, delay);
}

function reportEmptyBubble() {
  if (!isHitSurface || !state.config.bubbleVisible) return;
  if (hasAlertContent() || state.completion) {
    lastEmptyIdentity = null;
    return;
  }
  const identity = `${state.generation.lifecycleToken}:empty`;
  if (lastEmptyIdentity === identity) return;
  lastEmptyIdentity = identity;
  sendAction({ type: "bubbleDismiss", surface: "bubble", completionId: null });
}

appRoot.addEventListener("error", (event) => {
  if (!event.target.matches?.("[data-pet-image]")) return;
  failedPetUrl = event.target.currentSrc || event.target.src || null;
  render();
}, true);

appRoot.addEventListener("click", (event) => {
  if (!isHitSurface) return;
  const command = event.target.closest("[data-command]");
  if (!command || command.dataset.command === "pet-stage") return;
  event.stopPropagation();
  handleCommand(command);
});

appRoot.addEventListener("dblclick", (event) => {
  if (!isHitSurface || !event.target.closest(".pet-stage")) return;
  sendAction({
    type: "openTarget",
    sessionId: state.snapshot.sessionId,
    daemonOnly: Boolean(state.snapshot.daemonOnly),
  });
});

appRoot.addEventListener("contextmenu", (event) => {
  if (!isHitSurface || !event.target.closest(".pet-stage")) return;
  event.preventDefault();
  patchUi({
    menuOpen: !state.ui.menuOpen,
    targetMode: "open",
    selectedPlatform: null,
    statusFilter: null,
  });
});

appRoot.addEventListener("pointerover", (event) => {
  if (!isHitSurface) return;
  const card = event.target.closest("[data-card-id]");
  if (card && !card.contains(event.relatedTarget) && card.classList.contains("completion-card")) {
    if (completionTimer) {
      window.clearTimeout(completionTimer);
      completionTimer = null;
    }
    if (state.completionTimer) state.completionTimer.paused = true;
    api.patchUi({ completionPaused: true });
  }
  if (!event.target.closest(".pet-stage") || !state.config.settings.openOnHover) return;
  if (hoverCloseTimer) window.clearTimeout(hoverCloseTimer);
  if (hoverOpenTimer || state.ui.menuOpen) return;
  hoverOpenTimer = window.setTimeout(() => {
    hoverOpenTimer = null;
    patchUi({ menuOpen: true, targetMode: "open", selectedPlatform: null });
  }, 200);
});

appRoot.addEventListener("pointerout", (event) => {
  if (!isHitSurface) return;
  const card = event.target.closest("[data-card-id]");
  if (card && !card.contains(event.relatedTarget) && card.classList.contains("completion-card")) {
    if (state.completionTimer) state.completionTimer.paused = false;
    api.patchUi({ completionPaused: false });
  }
  if (!state.ui.menuOpen || appRoot.contains(event.relatedTarget)) return;
  if (hoverCloseTimer) window.clearTimeout(hoverCloseTimer);
  hoverCloseTimer = window.setTimeout(() => {
    hoverCloseTimer = null;
    closeMenu();
  }, 350);
});

appRoot.addEventListener("input", (event) => {
  if (!isHitSurface || !event.target.matches("[data-custom-input]")) return;
  const request = sortedDecisions()[Number(event.target.dataset.requestIndex)];
  const question = request?.questions?.[Number(event.target.dataset.questionIndex)];
  if (!request || !question) return;
  customDrafts[`${decisionKey(request)}:${question.id}`] = event.target.value;
});

appRoot.addEventListener("keydown", (event) => {
  if (!isHitSurface) return;
  if (event.key === "Escape" && state?.ui?.menuOpen) {
    event.preventDefault();
    closeMenu();
    return;
  }
  if (event.key !== "Enter" || !event.target.matches("[data-custom-input]")) return;
  event.preventDefault();
  selectDecisionAnswer(
    Number(event.target.dataset.requestIndex),
    Number(event.target.dataset.questionIndex),
    event.target.value,
    true
  );
});

appRoot.addEventListener("pointerdown", (event) => {
  if (!isHitSurface || event.button !== 0 || !event.target.closest(".pet-stage")) return;
  if (state.config.settings.lockPosition) return;
  event.target.closest(".pet-stage").setPointerCapture(event.pointerId);
  dragActive = true;
  dragMoved = false;
  dragStartPoint = { x: event.screenX, y: event.screenY };
  api.dragStart();
});

document.addEventListener("pointermove", (event) => {
  if (!dragActive || !dragStartPoint) return;
  if (Math.abs(event.screenX - dragStartPoint.x) > 3 || Math.abs(event.screenY - dragStartPoint.y) > 3) {
    dragMoved = true;
  }
  if (dragFrame !== null) return;
  dragFrame = window.requestAnimationFrame(() => {
    dragFrame = null;
    if (dragActive) api.dragMove();
  });
});

function endDrag() {
  if (!dragActive) return;
  dragActive = false;
  dragStartPoint = null;
  if (dragFrame !== null) {
    window.cancelAnimationFrame(dragFrame);
    dragFrame = null;
  }
  api.dragEnd(dragMoved);
}

document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", endDrag);
window.addEventListener("blur", endDrag);

api.onActionResult((payload) => {
  if (!state) return;
  const request = sortedDecisions().find(
    (item) => item.requestId === payload.requestId && item.brokerEpoch === payload.brokerEpoch
  );
  if (!request || payload.accepted) return;
  const current = decisionUi(request);
  patchDecision(request, { ...current, submitting: false, failed: true });
});

api.onState((payload) => {
  state = payload;
  render();
});
