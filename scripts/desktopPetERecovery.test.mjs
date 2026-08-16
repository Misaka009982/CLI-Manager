import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8");

class FakeCompanionSupervisor {
  constructor() {
    this.enabled = true;
    this.restartCount = 0;
    this.starts = 0;
    this.diagnostics = [];
  }

  childFailed(detail) {
    if (!this.enabled) return "ignored";
    if (this.restartCount === 0) {
      this.restartCount = 1;
      this.starts += 1;
      this.diagnostics.push({ code: "desktop_pet_e_process_exited", detail });
      return "restarted";
    }
    this.enabled = false;
    this.diagnostics.push({ code: "desktop_pet_e_restart_failed", detail });
    return "disabled";
  }

  close(reason) {
    this.enabled = false;
    return { reason, restarted: false };
  }
}

class FakeTerminalHistory {
  constructor() {
    this.terminalStates = new Map();
  }

  record(sessionId, color) {
    this.terminalStates.set(sessionId, color);
  }

  restart() {
    this.terminalStates.clear();
  }
}

test("companion recovers once and disables after the second failure", () => {
  const supervisor = new FakeCompanionSupervisor();
  assert.equal(supervisor.childFailed("first exit"), "restarted");
  assert.equal(supervisor.enabled, true);
  assert.equal(supervisor.starts, 1);
  assert.equal(supervisor.childFailed("second exit"), "disabled");
  assert.equal(supervisor.enabled, false);
  assert.equal(supervisor.starts, 1);
  assert.equal(supervisor.diagnostics.at(-1).code, "desktop_pet_e_restart_failed");
});

test("expected close and CLI-Manager exit do not enter the restart path", () => {
  const supervisor = new FakeCompanionSupervisor();
  assert.deepEqual(supervisor.close("pet-close"), {
    reason: "pet-close",
    restarted: false,
  });
  assert.equal(supervisor.childFailed("late EOF"), "ignored");
  assert.equal(supervisor.starts, 0);

  const second = new FakeCompanionSupervisor();
  assert.deepEqual(second.close("cli-manager-exit"), {
    reason: "cli-manager-exit",
    restarted: false,
  });
  assert.equal(second.childFailed("shutdown EOF"), "ignored");
});

test("terminal red and blue history is process-local and rebuilt empty after restart", () => {
  const history = new FakeTerminalHistory();
  history.record("session-red", "red");
  history.record("session-blue", "blue");
  assert.equal(history.terminalStates.size, 2);
  history.restart();
  assert.equal(history.terminalStates.size, 0);
});

test("source contracts preserve tray/fullscreen tracking and the unified exit guard", () => {
  const petCoordinator = read("src/hooks/useDesktopPetECoordinator.ts");
  const app = read("src/App.tsx");
  const terminalExit = read("src/lib/terminalExitCleanup.ts");
  const manager = read("src-tauri/src/commands/desktop_pet_e.rs");
  const terminalStore = read("src/stores/terminalStore.ts");

  assert.match(petCoordinator, /const tracking = appReady && settingsLoaded && settings\.enabled/);
  assert.match(petCoordinator, /const visible = tracking && !\(settings\.autoHideFullscreen && terminalFullscreen\)/);
  assert.match(petCoordinator, /setBackgroundTasks/);
  assert.match(app, /requestExitGuardedByRunningTasks/);
  assert.match(app, /tray-quit-requested/);
  assert.match(app, /requestExitGuardedByRunningTasks\("window close"\)/);
  assert.match(terminalExit, /closeAllPty|foregroundSessionIds/);
  assert.match(manager, /schedule_restart_after_failure/);
  assert.match(manager, /desktop_pet_e_restart_failed/);
  assert.match(manager, /expected_exit/);
  assert.match(petCoordinator, /terminalHistoryRef/);
  assert.match(petCoordinator, /viewedTerminalTaskIds/);
  assert.match(terminalStore, /tabNotifications/);
});

test("shared action availability survives pet visibility changes", () => {
  const sessionCoordinator = read("src/hooks/useDesktopPetEAgentCoordinator.ts");
  const petCoordinator = read("src/hooks/useDesktopPetECoordinator.ts");
  const terminalTabs = read("src/components/TerminalTabs.tsx");

  assert.match(sessionCoordinator, /const sessionAcceptsNewActions/);
  assert.match(sessionCoordinator, /sessionInteractionAvailable = sessionAcceptsNewActions/);
  assert.match(sessionCoordinator, /hasInteractivePendingActions/);
  assert.match(sessionCoordinator, /runtimeFailureGrace/);
  assert.match(sessionCoordinator, /useTerminalStore\.subscribe/);
  assert.match(sessionCoordinator, /scheduleOwningSessionRecovery/);
  assert.match(sessionCoordinator, /reason: "owning-session-unavailable"/);
  assert.match(petCoordinator, /autoHideFullscreen/);
  assert.match(terminalTabs, /pendingActions\.keys\(\)/);
  assert.match(terminalTabs, /next\[sessionId\] = "attention"/);
});
