import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("renderer keeps the task area collapsed until an explicit interaction", () => {
  const source = read("../src/renderer/app.ts");
  assert.match(source, /let expandedColor: DesktopPetEColor \| null = null/);
  assert.match(source, /firstAvailableColor\(snapshot\)/);
  assert.match(source, /data-command=\"close-pet\"/);
  assert.match(source, /kind: "open-settings"/);
  assert.match(source, /config\.settings\.openOnHover/);
  assert.match(source, /if \(config\?\.settings\.showTaskArea === false \|\| activeTaskId\) return ""/);
  assert.match(source, /config\?\.settings\.agentInteractionEnabled !== false/);
});

test("renderer preserves drafts and exposes retry after a rejected action", () => {
  const source = read("../src/renderer/app.ts");
  const entry = read("../src/renderer/agent-action.ts");
  const shared = read("../src/bridge/agent-action.ts");
  assert.match(source, /const drafts = new Map/);
  assert.match(source, /const submissionErrors = new Map/);
  assert.match(source, /result\.confirmed/);
  assert.match(source, /!result\.accepted \|\| result\.error/);
  assert.match(source, /desktopPetE\.renderer\.retry/);
  assert.match(source, /pendingAction\.id/);
  assert.match(entry, /export \* from "\.\.\/bridge\/agent-action\.js"/);
  assert.match(shared, /createActionDraft/);
  assert.match(shared, /serializeAnswers/);
  assert.match(shared, /isDraftComplete/);
  assert.match(shared, /questions\.length === 0/);
  assert.match(shared, /question\.required === false/);
  assert.match(source, /desktopPetE\.renderer\.optional/);
});

test("renderer uses the strict CSP-compatible sprite class contract", () => {
  const app = read("../src/renderer/app.ts");
  const html = read("../src/renderer/index.html");
  const css = read("../src/renderer/styles.css");
  assert.doesNotMatch(app, /style=\"/);
  assert.match(app, /sprite-row-\$\{state\.row\}/);
  assert.match(css, /sprite-row-10/);
  assert.match(css, /\.action-panel \{[\s\S]*display: flex;[\s\S]*flex-direction: column;/);
  assert.match(css, /\.action-panel footer \{ position: static;/);
  assert.match(css, /\.task-panel \{ top: 8px;[\s\S]*width: 364px;/);
  assert.match(html, /style-src pet-e-app:/);
  assert.doesNotMatch(html, /unsafe-inline/);
});

test("renderer keeps question scroll position and auto-hides the task bubble", () => {
  const source = read("../src/renderer/app.ts");
  const css = read("../src/renderer/styles.css");
  // 选项变更只做局部同步，重建 DOM 会让问题组滚动位置跳回顶部。
  assert.doesNotMatch(source, /\} else \{\s*render\(\);\s*\}/);
  assert.match(source, /const SCROLL_CONTAINERS = \[\"\.questions\", \"\.approval-options\", \"\.task-list\"\]/);
  assert.match(source, /const scrollOffsets = captureScrollOffsets\(\);/);
  assert.match(source, /restoreScrollOffsets\(scrollOffsets\);/);
  assert.match(source, /const TASK_PANEL_AUTO_HIDE_MS = 5000;/);
  assert.match(source, /function syncTaskPanelAutoHide/);
  assert.match(source, /setAutoHidePaused\(Boolean\(target\?\.closest\(\"\.task-panel\"\)\)\)/);
  assert.match(source, /config\?\.settings\.showStatusLabel !== true/);
  // 精灵主体必须显式声明为拖动区，否则窗口无法拖动。
  assert.match(css, /\.sprite-viewport \{[^}]*-webkit-app-region: drag;/);
  assert.match(css, /\.sprite-sheet \{[^}]*-webkit-app-region: drag;/);
});

test("click-through excludes every actionable pet surface", () => {
  const source = read("../src/renderer/app.ts");
  const css = read("../src/renderer/styles.css");
  assert.match(source, /INTERACTIVE_SURFACE_SELECTOR = "\.task-panel, \.action-panel, \.lights, \.pet-toolbar, \.pet\.missing"/);
  assert.match(source, /document\.elementFromPoint\(event\.clientX, event\.clientY\)/);
  assert.match(source, /app\.classList\.toggle\("click-through", next\.settings\.clickThroughEnabled\)/);
  assert.match(source, /mouseInteractive = false;\s*app\.classList\.toggle\("click-through"/);
  assert.match(css, /#app\.click-through \.pet-shell,[\s\S]*#app\.click-through \.sprite-sheet \{ -webkit-app-region: no-drag; \}/);
});

test("renderer opens task bubbles away from the nearest screen edge", () => {
  const source = read("../src/renderer/app.ts");
  const main = read("../src/main.ts");
  const css = read("../src/renderer/styles.css");
  assert.match(main, /function bubbleDirectionForBounds/);
  assert.match(main, /windowCenterY <= workAreaCenterY \? "down" : "up"/);
  assert.match(main, /win\.webContents\.send\("pet-e:config", rendererConfig\(latestConfig\)\)/);
  assert.match(source, /app\.classList\.toggle\("bubble-down", next\.bubbleDirection === "down"\)/);
  assert.match(css, /#app\.bubble-down \.pet-shell \{ top: 8px; bottom: auto; \}/);
  assert.match(css, /#app\.bubble-down \.task-panel,[\s\S]*#app\.bubble-down \.notification \{ top: 276px; \}/);
  assert.match(css, /#app\.bubble-down \.notification \{ max-height: 256px; overflow-y: auto; \}/);
});

test("question options are numbered like Pi's question tool", () => {
  const source = read("../src/renderer/app.ts");
  // 与 Pi 的 question 工具一致：选项按 1. 2. 3. 编号，自由输入仍为常驻输入框。
  assert.match(source, /options\.map\(\(option, optionIndex\)/);
  assert.match(source, /\$\{optionIndex \+ 1\}\. \$\{escapeText\(option\.label\)\}/);
  assert.match(source, /textarea data-custom=/);
});
