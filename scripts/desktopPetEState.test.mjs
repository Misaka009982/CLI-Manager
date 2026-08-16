import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-desktop-pet-e-state-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const protocolSource = readFileSync(new URL("../pet-e/src/bridge/protocol.ts", import.meta.url), "utf8");
const protocolOutput = ts.transpileModule(protocolSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  fileName: "protocol.ts",
}).outputText;
writeFileSync(join(tempDir, "desktopPetE.mjs"), protocolOutput, "utf8");

writeFileSync(join(tempDir, "agentTerminal.mjs"), [
  "export function shouldIncludeAgentTerminal() { return true; }",
].join("\n"), "utf8");
writeFileSync(join(tempDir, "desktopPetStatus.mjs"), [
  "export function resolveDesktopPetOpenSessionStatus(input) {",
  "  return { status: input.frontendStatus, updatedAt: Date.parse(input.frontendDetails?.updatedAt ?? '') || 0 };",
  "}",
].join("\n"), "utf8");

const stateSource = readFileSync(new URL("../src/lib/desktopPetEState.ts", import.meta.url), "utf8");
const stateOutput = ts.transpileModule(stateSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  fileName: "desktopPetEState.ts",
}).outputText
  .replace('from "./agentTerminal"', 'from "./agentTerminal.mjs"')
  .replace('from "./desktopPetStatus"', 'from "./desktopPetStatus.mjs"')
  .replace('from "./desktopPetE"', 'from "./desktopPetE.mjs"');
writeFileSync(join(tempDir, "desktopPetEState.mjs"), stateOutput, "utf8");
const state = await import(pathToFileURL(join(tempDir, "desktopPetEState.mjs")).href);

function candidate(sessionId, status, updatedAt, overrides = {}) {
  return {
    sessionId,
    source: "claude",
    agentLabel: "Claude",
    title: sessionId,
    status,
    updatedAt,
    sessionAlive: true,
    ...overrides,
  };
}

function snapshot(candidates, overrides = {}) {
  return state.deriveDesktopPetESnapshot({
    instanceId: "instance-1",
    generation: 1,
    revision: 2,
    generatedAt: 10_000,
    candidates,
    ...overrides,
  }, "green");
}

test("all four colors are counted and waiting has the highest mood priority", () => {
  const pendingAction = {
    id: "question-1",
    kind: "question",
    requestGeneration: 1,
    adapterMode: "interactive",
    submitting: false,
  };
  const result = snapshot([
    candidate("green", "running", 100),
    candidate("yellow", "attention", 200, { pendingAction }),
    candidate("red", "failed", 300),
    candidate("blue", "done", 400),
  ]);
  assert.deepEqual(result.counts, { green: 1, yellow: 1, red: 1, blue: 1 });
  assert.equal(result.mood, "yellow");
  assert.deepEqual(result.cliLabel, { agentLabel: "Claude", color: "green", otherTaskCount: 3 });
});

test("ordinary attention does not enter the four-color task counts", () => {
  const result = snapshot([candidate("attention", "attention", 200)]);
  assert.deepEqual(result.counts, { green: 0, yellow: 0, red: 0, blue: 0 });
  assert.deepEqual(result.tasks, []);
});

test("ordinary attention preserves the prior terminal task state", () => {
  const previous = [candidate("session", "running", 100)];
  const current = [candidate("session", "attention", 200)];
  const merged = state.mergeDesktopPetECandidatesWithHistory(
    previous,
    current,
    new Set(["session"]),
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "running");
  assert.equal(merged[0].updatedAt, 100);
  assert.deepEqual(snapshot(merged).counts, { green: 1, yellow: 0, red: 0, blue: 0 });
});

test("jump-only user actions remain yellow through an explicit pending action", () => {
  const pendingAction = {
    id: "jump-only-1",
    kind: "approval",
    requestGeneration: 1,
    adapterMode: "jump-only",
    submitting: false,
  };
  const result = snapshot([candidate("attention", "attention", 200, { pendingAction })]);
  assert.deepEqual(result.counts, { green: 0, yellow: 1, red: 0, blue: 0 });
  assert.equal(result.tasks[0].pendingAction?.adapterMode, "jump-only");
});

test("a newer task in the same session replaces an older terminal state", () => {
  const result = snapshot([
    candidate("same", "failed", 100),
    candidate("same", "running", 200),
  ]);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].color, "green");
});

test("viewed red and blue tasks clear by exact task id", () => {
  const initial = snapshot([
    candidate("red", "failed", 100),
    candidate("blue", "done", 200),
  ]);
  const viewed = new Set(initial.tasks.map((task) => task.id));
  const cleared = snapshot([
    candidate("red", "failed", 100),
    candidate("blue", "done", 200),
  ], { viewedTerminalTaskIds: viewed });
  assert.deepEqual(cleared.tasks, []);
});

test("terminal history retains only red and blue records and marks ended sessions", () => {
  const previous = [
    candidate("failed", "failed", 100),
    candidate("done", "done", 100),
    candidate("running", "running", 100),
  ];
  const merged = state.mergeDesktopPetECandidatesWithHistory(previous, [], new Set(["done"]));
  assert.deepEqual(merged.map((item) => [item.sessionId, item.sessionAlive]), [
    ["failed", false],
    ["done", true],
  ]);
});

test("fallback terminal errors keep one stable task identity until the status changes", () => {
  const input = (generatedAt) => ({
    instanceId: "instance-1",
    generation: 1,
    revision: 0,
    generatedAt,
    sessions: [{ id: "terminal-error", title: "Terminal", cliTool: "claude" }],
    persistedSessions: [],
    projects: [],
    activeSessionId: null,
    sessionStatuses: { "terminal-error": "error" },
    sessionStatusUpdatedAt: { "terminal-error": 5_000 },
    tabNotifications: {},
    tabStatusDetails: {},
    ptyOutputActivityAt: {},
    backgroundTasks: [],
  });
  const first = state.deriveDesktopPetECandidates(input(10_000));
  const second = state.deriveDesktopPetECandidates(input(20_000));
  assert.equal(first[0].updatedAt, 5_000);
  assert.equal(second[0].updatedAt, 5_000);
  assert.equal(
    snapshot(first).tasks[0].id,
    snapshot(second).tasks[0].id,
  );
});

test("snapshot acceptance rejects old instances and non-increasing revisions", () => {
  const current = { instanceId: "instance-1", generation: 2, revision: 5 };
  assert.equal(state.shouldAcceptDesktopPetESnapshot(current, { ...current, revision: 6 }), true);
  assert.equal(state.shouldAcceptDesktopPetESnapshot(current, { ...current, revision: 5 }), false);
  assert.equal(state.shouldAcceptDesktopPetESnapshot(current, { ...current, generation: 1, revision: 99 }), false);
  assert.equal(state.shouldAcceptDesktopPetESnapshot(current, { ...current, instanceId: "old" }), false);
});
