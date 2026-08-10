"use strict";

const PET_BASE_WIDTH = 190;
const PET_BASE_HEIGHT = 210;
const PANEL_WIDTH = 430;
const PANEL_GAP = 12;
const WORK_AREA_MARGIN = 12;
const SIZE_MIN = 40;
const SIZE_MAX = 150;
const SIZE_STEP = 5;

function clamp(value, minimum, maximum) {
  if (!Number.isFinite(value)) return minimum;
  if (maximum <= minimum) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeSize(value) {
  const numeric = Number.isFinite(value) ? value : 100;
  return clamp(Math.round(numeric / SIZE_STEP) * SIZE_STEP, SIZE_MIN, SIZE_MAX);
}

function petSize(sizePercent) {
  const scale = normalizeSize(sizePercent) / 100;
  return {
    width: Math.max(96, Math.round(PET_BASE_WIDTH * scale)),
    height: Math.max(106, Math.round(PET_BASE_HEIGHT * scale)),
    scale,
  };
}

function defaultPetPosition(workArea, size) {
  return {
    x: Math.round(workArea.x + workArea.width - size.width - 24),
    y: Math.round(workArea.y + workArea.height - size.height - 52),
  };
}

function clampPetPosition(position, workArea, size) {
  const margin = Math.min(WORK_AREA_MARGIN, Math.floor(Math.min(size.width, size.height) / 4));
  return {
    x: Math.round(clamp(
      position.x,
      workArea.x - size.width + margin,
      workArea.x + workArea.width - margin
    )),
    y: Math.round(clamp(
      position.y,
      workArea.y,
      workArea.y + workArea.height - margin
    )),
  };
}

function estimateBubbleHeight(snapshot, includeCompletion) {
  const decisions = Array.isArray(snapshot?.decisionRequests)
    ? snapshot.decisionRequests
    : [];
  const incidents = Array.isArray(snapshot?.incidents) ? snapshot.incidents : [];
  let height = 0;
  for (const request of decisions) {
    const questions = Array.isArray(request.questions) ? request.questions : [];
    const optionCount = questions.reduce(
      (count, question) => count + Math.max(1, question.options?.length || 0),
      0
    );
    height += 90 + questions.length * 48 + optionCount * 38;
  }
  height += incidents.length * 116;
  if (includeCompletion) height += 104;
  return Math.max(0, height + Math.max(0, decisions.length + incidents.length) * 10);
}

function computeWindowLayout(options) {
  const size = petSize(options.sizePercent);
  const workArea = options.workArea;
  const petPosition = clampPetPosition(options.petPosition, workArea, size);
  const expanded = Boolean(options.menuOpen || options.bubbleOpen);
  if (!expanded) {
    return {
      bounds: { x: petPosition.x, y: petPosition.y, width: size.width, height: size.height },
      petRect: { x: 0, y: 0, width: size.width, height: size.height },
      panelRect: null,
      expansionSide: "left",
      petPosition,
      petSize: size,
    };
  }

  const maxPanelWidth = Math.max(280, workArea.width - size.width - PANEL_GAP - 24);
  const panelWidth = Math.min(PANEL_WIDTH, maxPanelWidth);
  const naturalPanelHeight = Math.max(
    options.menuOpen ? 420 : 0,
    options.bubbleOpen ? estimateBubbleHeight(options.snapshot, options.includeCompletion) : 0,
    220
  );
  const height = Math.min(
    Math.max(size.height, naturalPanelHeight + 20),
    Math.max(size.height, workArea.height - WORK_AREA_MARGIN * 2)
  );
  const width = size.width + PANEL_GAP + panelWidth;
  const spaceLeft = petPosition.x - workArea.x;
  const spaceRight = workArea.x + workArea.width - (petPosition.x + size.width);
  const expansionSide = spaceLeft >= panelWidth + PANEL_GAP || spaceLeft >= spaceRight
    ? "left"
    : "right";
  const desiredX = expansionSide === "left"
    ? petPosition.x - panelWidth - PANEL_GAP
    : petPosition.x;
  const desiredY = petPosition.y + size.height - height;
  const x = Math.round(clamp(
    desiredX,
    workArea.x + WORK_AREA_MARGIN,
    workArea.x + workArea.width - width - WORK_AREA_MARGIN
  ));
  const y = Math.round(clamp(
    desiredY,
    workArea.y + WORK_AREA_MARGIN,
    workArea.y + workArea.height - height - WORK_AREA_MARGIN
  ));
  const petX = petPosition.x - x;
  const petY = petPosition.y - y;
  const panelX = expansionSide === "left" ? 0 : size.width + PANEL_GAP;

  return {
    bounds: { x, y, width, height },
    petRect: { x: petX, y: petY, width: size.width, height: size.height },
    panelRect: { x: panelX, y: 0, width: panelWidth, height },
    expansionSide,
    petPosition,
    petSize: size,
  };
}

function normalizeShapeRects(rects, bounds) {
  if (!Array.isArray(rects)) return [];
  const normalized = [];
  for (const rect of rects.slice(0, 64)) {
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) continue;
    const x = Math.floor(clamp(rect.x, 0, bounds.width));
    const y = Math.floor(clamp(rect.y, 0, bounds.height));
    const right = Math.ceil(clamp(rect.x + rect.width, 0, bounds.width));
    const bottom = Math.ceil(clamp(rect.y + rect.height, 0, bounds.height));
    if (right <= x || bottom <= y) continue;
    normalized.push({ x, y, width: right - x, height: bottom - y });
  }
  return normalized;
}

module.exports = {
  SIZE_MAX,
  SIZE_MIN,
  SIZE_STEP,
  clampPetPosition,
  computeWindowLayout,
  defaultPetPosition,
  normalizeShapeRects,
  normalizeSize,
  petSize,
};
