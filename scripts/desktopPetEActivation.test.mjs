import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Desktop Pet E uses the existing exact session activation path", () => {
  const app = read("../src/App.tsx");
  const coordinator = read("../src/hooks/useDesktopPetECoordinator.ts");
  const terminalStore = read("../src/stores/terminalStore.ts");

  assert.match(app, /useDesktopPetECoordinator\(\{[\s\S]*onActivateSession: handleActivateHookNotificationTarget/);
  assert.match(app, /const handleActivateHookNotificationTarget = useCallback[\s\S]*terminalStore\.setActive\(tabId\)/);
  assert.match(coordinator, /attachDaemonSession\(task\.sessionId\)/);
  assert.match(coordinator, /await onActivateSessionRef\.current\(task\.sessionId\)/);
  assert.match(terminalStore, /setActive: \(id\) => \{[\s\S]*findWorkspanBySession\(state\.workspans, id\)/);
  assert.match(terminalStore, /setPaneActiveSession\(owner\.paneTree, id\)/);
  assert.match(terminalStore, /buildWorkspanMirror\(workspans, owner\.id\)/);
});

test("ended sessions can only be manually cleared and are never redirected", () => {
  const coordinator = read("../src/hooks/useDesktopPetECoordinator.ts");
  assert.match(coordinator, /if \(task\.sessionAlive \|\| \(task\.color !== "red" && task\.color !== "blue"\)\) return/);
  assert.match(coordinator, /if \(action\.kind !== "open-task" \|\| !task\.sessionAlive\) return/);
  assert.doesNotMatch(coordinator, /find\([^\n]*projectName/);
  assert.doesNotMatch(coordinator, /find\([^\n]*title/);
});

test("tray and fullscreen visibility do not stop authoritative tracking", () => {
  const coordinator = read("../src/hooks/useDesktopPetECoordinator.ts");
  assert.match(coordinator, /const tracking = appReady && settingsLoaded && settings\.enabled/);
  assert.match(coordinator, /const visible = tracking && !\(settings\.autoHideFullscreen && terminalFullscreen\)/);
  assert.match(coordinator, /\}, \[tracking\]\);/);
});
