import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8");

class FakeCompanionTransport {
  constructor() {
    this.instanceId = "fake-pet-instance";
    this.generation = 0;
    this.revision = 0;
    this.ready = false;
    this.messages = [];
  }

  spawn(generation) {
    this.generation = generation;
    this.revision = 0;
    this.ready = true;
    return {
      type: "hello",
      protocolVersion: 1,
      instanceId: this.instanceId,
      generation,
    };
  }

  accept(message) {
    assert.equal(message.protocolVersion, 1);
    assert.equal(message.instanceId, this.instanceId);
    assert.equal(message.generation, this.generation);
    assert.ok(Number.isSafeInteger(message.revision) && message.revision > this.revision);
    this.revision = message.revision;
    this.messages.push(structuredClone(message));
  }
}

class FakeAgentTransport {
  constructor() {
    this.pending = new Map();
    this.completed = new Map();
  }

  open(pendingActionId) {
    this.pending.set(pendingActionId, { status: "waiting", response: null });
  }

  submit(pendingActionId, transportActionId, response) {
    const completed = this.completed.get(pendingActionId);
    if (completed) {
      if (completed.transportActionId !== transportActionId) {
        throw new Error("desktop_pet_e_agent_transport_mismatch");
      }
      return { accepted: true, confirmed: true, response: completed.response };
    }
    const entry = this.pending.get(pendingActionId);
    if (!entry) throw new Error("desktop_pet_e_agent_pending_unknown");
    if (entry.status !== "waiting") throw new Error("desktop_pet_e_agent_already_submitted");
    entry.status = "submitted";
    entry.transportActionId = transportActionId;
    entry.response = response;
    return { accepted: true, confirmed: false };
  }

  acknowledge(pendingActionId, transportActionId, success, error = null) {
    const entry = this.pending.get(pendingActionId);
    assert.ok(entry);
    assert.equal(entry.transportActionId, transportActionId);
    if (!success) {
      entry.status = "waiting";
      entry.error = error;
      return { phase: "failed", pendingActionId, error };
    }
    this.pending.delete(pendingActionId);
    this.completed.set(pendingActionId, {
      transportActionId,
      response: entry.response,
    });
    return { phase: "resolved", pendingActionId };
  }
}

test("fake companion accepts only current generation and increasing revisions", () => {
  const companion = new FakeCompanionTransport();
  assert.deepEqual(companion.spawn(4), {
    type: "hello",
    protocolVersion: 1,
    instanceId: "fake-pet-instance",
    generation: 4,
  });
  companion.accept({
    type: "snapshot",
    protocolVersion: 1,
    instanceId: "fake-pet-instance",
    generation: 4,
    revision: 1,
    snapshot: { mood: "yellow" },
  });
  assert.throws(() => companion.accept({
    type: "snapshot",
    protocolVersion: 1,
    instanceId: "fake-pet-instance",
    generation: 3,
    revision: 2,
    snapshot: { mood: "idle" },
  }));
  assert.throws(() => companion.accept({
    type: "snapshot",
    protocolVersion: 1,
    instanceId: "fake-pet-instance",
    generation: 4,
    revision: 1,
    snapshot: { mood: "idle" },
  }));
  assert.equal(companion.messages.at(-1).snapshot.mood, "yellow");
});

test("fake agent transport retains failed answers and resolves duplicate submits idempotently", () => {
  const agent = new FakeAgentTransport();
  agent.open("pending-1");
  const first = agent.submit("pending-1", "transport-1", { answers: ["yes"] });
  assert.deepEqual(first, { accepted: true, confirmed: false });
  const failed = agent.acknowledge("pending-1", "transport-1", false, "temporary failure");
  assert.deepEqual(failed, {
    phase: "failed",
    pendingActionId: "pending-1",
    error: "temporary failure",
  });
  assert.equal(agent.pending.get("pending-1").status, "waiting");
  const retry = agent.submit("pending-1", "transport-2", { answers: ["yes"] });
  assert.equal(retry.confirmed, false);
  assert.deepEqual(agent.acknowledge("pending-1", "transport-2", true), {
    phase: "resolved",
    pendingActionId: "pending-1",
  });
  assert.deepEqual(
    agent.submit("pending-1", "transport-2", { answers: ["yes"] }),
    { accepted: true, confirmed: true, response: { answers: ["yes"] } },
  );
  assert.throws(
    () => agent.submit("pending-1", "transport-3", { answers: ["no"] }),
    /desktop_pet_e_agent_transport_mismatch/,
  );
});

test("cross-layer sources expose one authoritative snapshot and one shared action state", () => {
  const protocol = read("pet-e/src/bridge/protocol.ts");
  const manager = read("src-tauri/src/commands/desktop_pet_e.rs");
  const coordinator = read("src/hooks/useDesktopPetECoordinator.ts");
  const sessionCoordinator = read("src/hooks/useDesktopPetEAgentCoordinator.ts");
  const sharedStore = read("src/stores/desktopPetEAgentStore.ts");
  const sessionPanel = read("src/components/terminal/DesktopPetESessionActionPanel.tsx");
  const terminalTabs = read("src/components/TerminalTabs.tsx");
  const broker = read("src-tauri/src/desktop_pet_e_agent.rs");
  const codexE2e = read("scripts/codexAppServerProxy.e2e.test.mjs");

  assert.match(protocol, /generation: number/);
  assert.match(protocol, /revision: number/);
  assert.match(protocol, /isDesktopPetEChildAction/);
  assert.match(manager, /send_latest_state/);
  assert.match(manager, /host_revision = state\.host_revision\.saturating_add\(1\)/);
  assert.match(coordinator, /desktop_pet_e_sync/);
  assert.match(coordinator, /desktopPetESyncFingerprint/);
  assert.match(coordinator, /listen<CliHookPayload>\("claude-hook-notification"/);
  assert.match(coordinator, /isDesktopPetEOrdinaryNotification/);
  assert.match(coordinator, /!settingsRef\.current\.enabled \|\| !settingsRef\.current\.notificationsEnabled/);
  assert.match(coordinator, /!tracking \|\| !settings\.notificationsEnabled/);
  assert.match(coordinator, /notification,\s*\n\s*}, activeSessionId/);
  assert.match(coordinator, /expiresAt = createdAt \+ DESKTOP_PET_E_NOTIFICATION_DURATION_MS/);
  assert.match(coordinator, /if \(expiresAt <= now\) return/);
  assert.match(coordinator, /AskUserQuestion/);
  assert.match(coordinator, /request_user_input/);
  assert.match(sessionCoordinator, /useDesktopPetEAgentStore/);
  assert.match(sessionCoordinator, /cli-manager-session-ui-/);
  assert.match(sharedStore, /resetForDaemonRestart/);
  assert.match(sharedStore, /state\.brokerEpoch === event\.brokerEpoch/);
  assert.match(sharedStore, /desktop_pet_e_agent_already_submitting/);
  assert.match(sharedStore, /currentState\.submissions\.get\(event\.pendingAction\.id\) === transportActionId/);
  assert.match(sessionPanel, /await submit\(\{/);
  assert.match(terminalTabs, /DesktopPetESessionActionPanel sessionId=\{session\.id\}/);
  assert.match(broker, /remember_completed/);
  assert.match(broker, /desktop_pet_e_agent_transport_mismatch/);
  assert.match(codexE2e, /buildProxy\(\)/);
  assert.match(codexE2e, /runProxy\(/);
});

test("pet failure cannot remove the owning-session action surface", () => {
  const petCoordinator = read("src/hooks/useDesktopPetECoordinator.ts");
  const sessionCoordinator = read("src/hooks/useDesktopPetEAgentCoordinator.ts");
  const sessionPanel = read("src/components/terminal/DesktopPetESessionActionPanel.tsx");

  assert.doesNotMatch(petCoordinator, /desktop_pet_e_agent_cancel/);
  assert.doesNotMatch(petCoordinator, /pet-closed|pet-interaction-unavailable|terminal-fallback/);
  assert.match(sessionCoordinator, /sessionInteractionAvailable/);
  assert.match(sessionCoordinator, /hasInteractivePendingActions/);
  assert.match(sessionPanel, /desktopPetE\.renderer\.retry/);
});
